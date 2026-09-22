//! The IMAP backup runner (Phase 3 remainder, Task 1), ported from
//! `src-tauri/src/backup.rs`'s `run_account_backup` + `run_imap_backup_inner`
//! (lines 604-940 at port time) — same injected-sink shape Phase 3 already
//! used for `mailvault_core::archive`. The caller builds an `Arc<ArchiveCtx>`
//! (root, pool, gate, sinks) exactly as it would for a manual archive run and
//! hands it in here too: the per-message fetch/store step this run delegates
//! to (`archive::run_with_backup`) needs one, and reusing the caller's own
//! avoids two sources of truth for the vault root and pool that could drift
//! apart (backup would then compute `missing` against one `cur/` while the
//! fetch step writes into another).
//!
//! What did NOT move here: `resolve_backup_path`/`release_backup_path`
//! (security-scoped bookmark resolution — a Rust/platform-integration concern
//! that stays with `external_location.rs`, shell-permanent per `main.rs`'s
//! module-list comment). Every function below that used to take a
//! `tauri::AppHandle` and resolve its own bookmark instead takes an
//! already-resolved `mirror_root: Option<&Path>` — the caller (daemon RPC
//! handler today, eventually the Tauri command that still owns the bookmark)
//! resolves it first, same convention `BackupRunContext::mirror_root` and
//! `vault_flags`'s `mirrorRoot` param already use.
//!
//! The Graph/Outlook backup path (`run_graph_account`, ported from
//! `run_graph_backup`, `src-tauri/src/backup.rs:1131-1404`) followed in Task 2,
//! reusing this file's shared uid-scanning helpers below. Its own header
//! comment (above `run_graph_account`) covers what that port changed.
//!
//! The read-state catch-up this run does once per folder
//! (`backup.rs:850-886`'s `vault_apply_flags` daemon-RPC bridge) is now an
//! injected in-process closure (`BackupRunContext::apply_flags`) instead: the
//! daemon wires it straight to `handlers::vault_flags::apply_flags`, no RPC
//! round trip against itself.
//!
//! Task 3 ports the three remaining app-side entry points: `get_backup_status`
//! (the compare-with-server status view, `AccountBackupStatus`/
//! `FolderBackupStatus`), `purge_backup_files` (already private-ported above
//! for `drain_purge_queue`'s own use — now also exposed as the read/write
//! `backup_purge_uids` RPC needs, including `queue_purge`, the one write-side
//! helper of the pending-purge queue this file hadn't needed until now), and
//! `scan_uids` (the mirror-membership check `backup_scan_uids` exposes to the
//! UI). None of the three is long-running like the account backup run above,
//! so their daemon RPC handlers are ordinary blocking-style async handlers —
//! no `tokio::spawn`/fire-and-forget.
//!
//! `get_backup_status`'s external-location enrichment (`external_status`/
//! `external_error` on `AccountBackupStatus`) is the one field pair this port
//! cannot compute itself, for the same bookmark reason as above: the daemon
//! has no bookmark API (`main.rs`'s `VaultLocationInfo` doc comment makes the
//! identical trade-off for `vault_get_status`). The caller passes them
//! through as already-known strings; `get_backup_status` only sets them when
//! given.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tracing::{info, warn};

use crate::archive::{self, ArchiveCtx};
use crate::imap::{self, ImapConfig, ImapPool};
use crate::vault_flags::{Applied, FlagChange};
use crate::vault_registry::VaultRegistry;

// ── Event payload ────────────────────────────────────────────────────────────
//
// Field-for-field with the app's `backup.rs:44-57` `BackupProgress` — no
// `rename_all` here (unlike `archive::ArchiveProgress`), matching today's
// wire shape exactly: JS reads these as snake_case and this port must not
// change that.

#[derive(Clone, Serialize)]
pub struct BackupProgress {
    pub account_id: String,
    pub folder: String,
    pub total_folders: usize,
    pub completed_folders: usize,
    pub total_emails: usize,
    pub completed_emails: usize,
    pub errors: usize,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub missing_in_folder: usize,
    /// True if this run was cancelled mid-run — carried on the terminal
    /// (`active: false`) frame so the frontend's completion handling (Task
    /// 7b) can read it straight off the event instead of the RPC's return
    /// value. Field-for-field with `BackupResult::cancelled`.
    #[serde(default)]
    pub cancelled: bool,
    /// Field-for-field with `BackupResult::success`. Explicit rather than
    /// derived, because the one frame that is neither a completion nor a
    /// cancel — the daemon's `Err` synthesis, for a run that died before it
    /// reached its own terminal emit — is a failure that `!cancelled` would
    /// report as a success. JS reads `success !== false`, so a frame that
    /// simply omitted it would file a dead run as a clean backup of zero
    /// messages (Task 7b).
    #[serde(default = "default_true")]
    pub success: bool,
    /// Field-for-field with `BackupResult::external_copy_ok`.
    #[serde(default = "default_true")]
    pub external_copy_ok: bool,
    /// Field-for-field with `BackupResult::external_copy_error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_copy_error: Option<String>,
    /// Field-for-field with `BackupResult::external_copy_failed_count`.
    #[serde(default)]
    pub external_copy_failed_count: usize,
}

// ── Result ───────────────────────────────────────────────────────────────────
//
// Field-for-field with `backup.rs:552-575` — JS depends on every field here,
// do not rename any of them.

#[derive(Serialize)]
pub struct BackupResult {
    pub emails_backed_up: usize,
    pub errors: usize,
    pub duration_secs: f64,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// True if backup was cancelled mid-run (for resume support)
    #[serde(default)]
    pub cancelled: bool,
    /// Number of folders completed before cancel/finish (resume checkpoint)
    #[serde(default)]
    pub completed_folders: usize,
    /// External copy outcome — true if all external writes succeeded (or no external location configured)
    #[serde(default = "default_true")]
    pub external_copy_ok: bool,
    /// Error message when external copy partially or fully failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_copy_error: Option<String>,
    /// Number of emails that failed to copy to the external location
    #[serde(default)]
    pub external_copy_failed_count: usize,
}

fn default_true() -> bool {
    true
}

/// Builds the one terminal (`active: false`) `BackupProgress` frame both
/// runners emit exactly once, after their folder loop ends for any reason
/// (normal completion, cancel, or zero folders/mailboxes). Shared so the two
/// twins can't drift on this shape again the way Graph's terminal frame was
/// simply missing before this fix — see the module doc's Task 7a note.
///
/// `error_message` is `BackupResult::error_message` — the provider's own
/// words for why a run stopped early (a Gmail daily-bandwidth stop) or what
/// it lost on the way (`partial_error_message`'s "N of M messages could not
/// be fetched"). It rides on `last_error`, the frame's pre-existing field for
/// exactly this, because the daemon drops the run's `BackupResult` on the
/// floor (Task 7a) and this frame is now the only path those words have to
/// the user. Task 7a added `cancelled`/`external_copy_*` here but left
/// `last_error` hardcoded `None`, which silently dropped both messages —
/// completed in Task 7b, alongside the frontend that reads them.
fn terminal_backup_progress(
    account_id: &str,
    cancelled: bool,
    total_folders: usize,
    completed_folders: usize,
    total_backed_up: usize,
    total_errors: usize,
    total_ext_failures: usize,
    error_message: Option<String>,
) -> BackupProgress {
    BackupProgress {
        account_id: account_id.to_string(),
        folder: if cancelled { "Cancelled".to_string() } else { "Complete".to_string() },
        total_folders,
        completed_folders,
        total_emails: total_backed_up + total_errors,
        completed_emails: total_backed_up,
        errors: total_errors,
        active: false,
        last_error: error_message,
        missing_in_folder: 0,
        cancelled,
        // Same rule both runners' `BackupResult` uses: a message the server
        // refused is a partial result, not a failed run.
        success: !cancelled,
        external_copy_ok: total_ext_failures == 0,
        external_copy_error: if total_ext_failures > 0 {
            Some(format!("{} emails failed to copy to external backup", total_ext_failures))
        } else {
            None
        },
        external_copy_failed_count: total_ext_failures,
    }
}

// ── Injected context ─────────────────────────────────────────────────────────

/// Everything one account's IMAP backup run needs beyond what the caller
/// resolves ahead of time. Not a literal copy of the plan sketch — a few
/// fields that sketch omitted turned out load-bearing once the actual
/// ported algorithm was read in full:
/// - `app_dir`: `backup.rs:656`'s pending-purge queue lives under the app's
///   own data dir (`state.app_dir`, "never on a removable drive"), which is
///   NOT the vault root (`archive_ctx.root`) and not the mirror either.
/// - `skip_folders`: `BackupResult.completed_folders` is the resume
///   checkpoint a caller feeds back in as this on the next run
///   (`backup.rs:642,738-741`) — the struct that produces it needs an input
///   side or it's write-only.
/// - `account_id`/`account_json`: `archive::run_with_backup` takes the raw
///   JSON string and reparses it itself; re-serializing `account` here would
///   risk not round-tripping identically (e.g. post credential-resolution).
#[derive(Clone)]
pub struct BackupRunContext {
    pub account_id: String,
    pub account_json: String,
    pub account: ImapConfig,
    /// Daemon app-data dir — where the pending backup-purge queue file lives.
    pub app_dir: PathBuf,
    /// Already-resolved external backup root, or `None`. Resolving a
    /// security-scoped bookmark is a platform-integration concern the daemon
    /// cannot do itself (same deviation `vault_flags.rs`'s own `mirrorRoot`
    /// param already documents) — the caller resolves it first.
    pub mirror_root: Option<String>,
    pub cancel: Arc<AtomicBool>,
    /// Folders already completed in a previous (cancelled or bandwidth
    /// limited) run — skipped again without re-listing them.
    pub skip_folders: usize,
    pub mailbox_concurrency: usize,
    /// The per-message fetch-and-store step (`archive::run_with_backup`)
    /// reuses this wholesale: same pool, vault root, write gate and sinks a
    /// manual archive run would use.
    pub archive_ctx: Arc<ArchiveCtx>,
    pub on_progress: Arc<dyn Fn(BackupProgress) + Send + Sync>,
    /// Flag catch-up (`backup.rs:850-886`'s `vault_apply_flags` bridge, now
    /// in-process): mailbox + changes only. Account id/email, mirror root and
    /// `sidecars: false` are all already fixed for the whole run, so the
    /// caller closes over them instead of threading five args through every
    /// call site.
    pub apply_flags: Arc<dyn Fn(&str, &[FlagChange]) -> Result<Applied, String> + Send + Sync>,
}

// ── Core backup runner ───────────────────────────────────────────────────────

pub async fn run_imap_account(ctx: BackupRunContext) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();

    if let Some(ref root) = ctx.mirror_root {
        info!("backup: using external path: {:?}", root);
        // Drain BEFORE any mirroring work — a run that copies first would put
        // back the very files the queue is about to delete.
        drain_purge_queue(&ctx.app_dir, Path::new(root));
    }

    run_imap_backup_inner(ctx, start).await
}

async fn run_imap_backup_inner(ctx: BackupRunContext, start: std::time::Instant) -> Result<BackupResult, String> {
    let pool: &ImapPool = &ctx.archive_ctx.pool;
    let account = &ctx.account;
    let account_id = &ctx.account_id;

    // List all mailboxes
    let mailboxes = {
        let mut guard = pool.get_background(account).await?;
        let result = imap::bounded("LIST", 60, imap::list_mailboxes(&mut guard.session)).await?;
        pool.return_background(account, guard).await;
        result
    };

    // Flatten and filter to selectable mailboxes
    let all_flat = flatten_mailboxes(&mailboxes);
    info!(
        "backup: {} — {} total mailboxes from LIST, names: [{}]",
        account.email,
        all_flat.len(),
        all_flat.iter().map(|m| format!("{}(noselect={})", m.path, m.noselect)).collect::<Vec<_>>().join(", ")
    );
    let selectable: Vec<_> = all_flat.into_iter().filter(|m| !m.noselect).collect();

    let total_folders = selectable.len();
    let mut completed_folders = ctx.skip_folders.min(total_folders);
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;
    let mut total_ext_failures = 0usize;
    // The server's words for the last message that could not be fetched. A
    // count alone leaves the user with "something failed" and nowhere to look.
    let mut last_message_error: Option<String> = None;

    info!("backup: starting for {} ({} selectable folders)", account.email, total_folders);

    let mut cancelled = false;
    let mut bandwidth_limited = false;

    let work = selectable.into_iter().enumerate().skip(completed_folders)
        .map(|(index, mailbox)| (index, mailbox.path.clone())).collect::<Vec<_>>();
    let mut done = vec![false; work.len()];
    for batch in work.chunks(ctx.mailbox_concurrency.clamp(1, 5)) {
        if ctx.cancel.load(Ordering::Relaxed) { cancelled = true; break; }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, mailbox) in batch.iter().cloned() {
            let ctx = ctx.clone();
            tasks.spawn(async move { backup_imap_folder(ctx, index, mailbox).await });
        }
        while let Some(result) = tasks.join_next().await {
            let outcome = result.map_err(|e| format!("backup folder worker panicked: {e}"))??;
            let slot = outcome.index.saturating_sub(ctx.skip_folders);
            if slot < done.len() { done[slot] = outcome.completed; }
            total_backed_up += outcome.backed_up;
            total_errors += outcome.errors;
            total_ext_failures += outcome.external_failures;
            bandwidth_limited |= outcome.bandwidth_limited;
            if outcome.last_error.is_some() { last_message_error = outcome.last_error; }
            completed_folders = contiguous_completed_checkpoint(ctx.skip_folders, &done).min(total_folders);
            (ctx.on_progress)(BackupProgress {
                account_id: account_id.clone(), folder: outcome.mailbox, total_folders, completed_folders,
                total_emails: total_backed_up + total_errors, completed_emails: total_backed_up, errors: total_errors,
                active: true, last_error: None, missing_in_folder: 0, cancelled: false, success: true,
                external_copy_ok: total_ext_failures == 0, external_copy_error: None,
                external_copy_failed_count: total_ext_failures,
            });
        }
        if ctx.cancel.load(Ordering::Relaxed) { cancelled = true; break; }
    }

    // Built here rather than inline in the `BackupResult` below, so the
    // terminal frame and the return value carry the same words — the frame
    // is the only one of the two JS ever sees (Task 7a/7b).
    let error_message = if bandwidth_limited {
        Some("Daily download limit reached for this provider. Backup stopped — it will pick up where it left off after the limit resets (usually within 1 hour, up to 24 hours).".to_string())
    } else {
        partial_error_message(total_errors, total_backed_up, last_message_error.as_deref())
    };

    // Emit final completion/cancelled event (single event per account). Now
    // carries the same completion data (`cancelled`, `external_copy_*`,
    // `error_message`) the function's own `BackupResult` return value
    // carries a few lines below — Task 7a: the RPC return value is
    // fire-and-forget dropped by the daemon, so this frame is the only place
    // JS can read it from.
    (ctx.on_progress)(terminal_backup_progress(
        account_id,
        cancelled,
        total_folders,
        completed_folders,
        total_backed_up,
        total_errors,
        total_ext_failures,
        error_message.clone(),
    ));

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup: {} for {} — {} new emails backed up, {} errors, {:.1}s{} (folders: {}/{})",
        if cancelled { "cancelled" } else { "completed" },
        account.email,
        total_backed_up,
        total_errors,
        duration,
        if let Some(ref p) = ctx.mirror_root { format!(" (copied to {})", p) } else { String::new() },
        completed_folders,
        total_folders
    );
    if total_ext_failures > 0 {
        warn!("backup: {} external copy failures for {}", total_ext_failures, account.email);
    }

    Ok(BackupResult {
        emails_backed_up: total_backed_up,
        errors: total_errors,
        duration_secs: duration,
        // A message the server refused is a partial result, not a failed run:
        // the other N-1 are on disk and re-running is what fixes the one.
        success: !cancelled,
        error_message,
        cancelled,
        completed_folders,
        external_copy_ok: total_ext_failures == 0,
        external_copy_error: if total_ext_failures > 0 {
            Some(format!("{} emails failed to copy to external backup", total_ext_failures))
        } else {
            None
        },
        external_copy_failed_count: total_ext_failures,
    })
}

fn contiguous_completed_checkpoint(start: usize, completed: &[bool]) -> usize {
    start + completed.iter().take_while(|done| **done).count()
}

struct ImapFolderOutcome {
    index: usize,
    mailbox: String,
    completed: bool,
    backed_up: usize,
    errors: usize,
    external_failures: usize,
    bandwidth_limited: bool,
    last_error: Option<String>,
}

async fn backup_imap_folder(ctx: BackupRunContext, index: usize, mailbox: String) -> Result<ImapFolderOutcome, String> {
    let pool = &ctx.archive_ctx.pool;
    let account = &ctx.account;
    if ctx.cancel.load(Ordering::Relaxed) {
        return Ok(ImapFolderOutcome { index, mailbox, completed: false, backed_up: 0, errors: 0, external_failures: 0, bandwidth_limited: false, last_error: None });
    }
    let server_flags = {
        let mut guard = pool.get_background(account).await?;
        let result = imap::bounded(
            &format!("UID FETCH 1:* {mailbox}"), 600,
            imap::search_all_uid_flags(&mut guard.session, &mailbox),
        ).await;
        match &result {
            Ok(_) => pool.return_background(account, guard).await,
            Err(_) => pool.discard(account, guard).await,
        }
        result?
    };
    let server_uids = server_flags.iter().map(|(uid, _)| *uid).collect::<Vec<_>>();
    let local_uids = {
        let cur = crate::vault_files::cur_path(&ctx.archive_ctx.root, &ctx.account_id, &mailbox);
        let mirror = ctx.mirror_root.as_ref().map(|root| PathBuf::from(root).join(&account.email).join(&mailbox).join("cur"));
        let (registry, account_id, mbox) = (Arc::clone(&ctx.archive_ctx.registry), ctx.account_id.clone(), mailbox.clone());
        tokio::task::spawn_blocking(move || vault_uids_after_presync(&registry, &account_id, &mbox, &cur, mirror.as_deref()))
            .await.map_err(|e| format!("pre-sync panicked: {e}"))??
    };
    let missing = server_uids.iter().filter(|uid| !local_uids.contains(uid)).copied().collect::<Vec<_>>();
    info!("backup: {} — server={} local={} missing={}", mailbox, server_uids.len(), local_uids.len(), missing.len());
    let mut out = ImapFolderOutcome {
        index, mailbox: mailbox.clone(), completed: false, backed_up: 0, errors: 0,
        external_failures: 0, bandwidth_limited: false, last_error: None,
    };
    if !missing.is_empty() {
        let archived = archive::run_with_backup(
            Arc::clone(&ctx.archive_ctx), ctx.account_id.clone(), ctx.account_json.clone(), mailbox.clone(), missing,
            Arc::clone(&ctx.cancel), ctx.mirror_root.clone(), Some(account.email.clone()), false, "backup",
        ).await?;
        out.backed_up = archived.completed;
        out.errors = archived.errors;
        out.external_failures = archived.external_copy_failures;
        out.bandwidth_limited = archived.bandwidth_limited;
        if archived.errors > 0 && !archived.bandwidth_limited { out.last_error = archived.last_error; }
    }
    if ctx.cancel.load(Ordering::Relaxed) { return Ok(out); }
    let changes = catch_up_changes(&server_flags, &local_uids);
    if !changes.is_empty() {
        let apply = Arc::clone(&ctx.apply_flags);
        let name = mailbox.clone();
        let result = tokio::task::spawn_blocking(move || (apply)(&name, &changes))
            .await.map_err(|e| format!("flag catch-up panicked: {e}"))?;
        let applied = map_flag_catchup_outcome(result, &ctx.account_id, &mailbox);
        if applied.total() > 0 {
            info!("backup: {} — flags caught up on {} vault, {} mirror, {} custody", mailbox, applied.renamed, applied.mirrored, applied.index_patched);
        }
    }
    out.completed = true;
    Ok(out)
}

// ── Graph (Outlook) backup runner ────────────────────────────────────────────
//
// Ported from `src-tauri/src/backup.rs:1131-1404`'s `run_graph_backup`,
// reusing the same shared uid-scanning helpers below (`vault_uids_after_presync`
// and friends) the IMAP runner above already needs. Two differences from
// Task 1's port, beyond the same closure/pool substitutions: `graph_ledger::
// plan_fetch` mints each message's uid (Graph gives none of its own) instead
// of reading one off the wire, and the per-message vault+mirror write
// happens here directly — there is no `archive::run_with_backup` step to
// delegate to, since fetching a Graph message's MIME bytes is not IMAP fetch.
//
// Both the ledger write and the per-message write now run under
// `ctx.archive_ctx.gate`. The app-side original held neither behind any
// vault-move gate — the app has no such concept. Running as the daemon's own
// caller is what makes routing them through the gate possible, and Phase 2's
// "every vault-rooted write goes through `with_vault_write`" rule is what
// makes doing so mandatory here, not optional, matching how
// `handlers::cache::graph_allocate_uids` already gates its own call into the
// same ledger. This is also the fix for the ledger's app-side bypass (Phase 3
// inventory, "non-obvious fact 9" / the Graph-ledger table row): the ledger
// was already daemon-owned in spirit — its cross-process lock exists
// precisely because the app and daemon could both reach for it — but was
// only ever written by the app process directly. Moving the caller into the
// daemon closes that by construction: there is no more app-side writer left.
pub async fn run_graph_account(ctx: BackupRunContext) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();

    if let Some(ref root) = ctx.mirror_root {
        info!("backup(graph): using external path: {:?}", root);
        // Same ordering rule as the IMAP runner: drain BEFORE any mirroring
        // work touches the files the queue is about to delete.
        drain_purge_queue(&ctx.app_dir, Path::new(root));
    }

    run_graph_backup_inner(ctx, start).await
}

async fn run_graph_backup_inner(ctx: BackupRunContext, start: std::time::Instant) -> Result<BackupResult, String> {
    use crate::maildir::{copies_to_write, mirror_file_map, uid_file_map, CopiesToWrite};

    let account = &ctx.account;
    let account_id = &ctx.account_id;

    let access_token = account
        .access_token
        .as_deref()
        .ok_or_else(|| "Missing OAuth2 access token for Graph account".to_string())?;
    let client = crate::graph::GraphClient::new(access_token);

    // List folders
    let folders = client.list_folders().await?;
    if ctx.mailbox_concurrency > 1 {
        drop(client);
        return run_graph_backup_parallel(ctx, start, folders).await;
    }
    let total_folders = folders.len();
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;
    let mut total_ext_failures = 0usize;
    // The server's words for the last message that could not be fetched. A
    // count alone leaves the user with "something failed" and nowhere to look.
    let mut last_message_error: Option<String> = None;
    // The first folder the uid ledger refused, and why. It stored nothing: a
    // resumed run skips folders by position, so its checkpoint must not pass
    // this one, and these are the words the user needs to read.
    let mut refused: Option<(usize, String)> = None;

    info!(
        "backup(graph): starting for {} ({} folders, skipping first {})",
        account.email, total_folders, ctx.skip_folders
    );

    let mut cancelled = false;

    for (folder_idx, folder) in folders.iter().enumerate() {
        if ctx.cancel.load(Ordering::Relaxed) {
            warn!("backup(graph): cancelled for {} at folder {}/{}", account.email, completed_folders, total_folders);
            cancelled = true;
            break;
        }

        // Skip folders already completed in a previous run (resume support)
        if folder_idx < ctx.skip_folders {
            completed_folders += 1;
            continue;
        }

        let folder_name = &folder.display_name;
        // The locale-independent key `list_folders` computed; everything that
        // files a Graph message (vault, sidecars, ledger, mirror) is keyed by
        // this string, never `display_name`.
        let mailbox_path = folder.storage_key.clone();

        let mirror_dir = ctx
            .mirror_root
            .as_ref()
            .map(|root| PathBuf::from(root).join(&account.email).join(&mailbox_path).join("cur"));

        // List the whole folder before numbering any of it — see
        // `graph_ledger`'s own doc comment for why filing by listing position
        // is the bug this ledger replaces.
        let mut listed: Vec<crate::graph::GraphMessage> = Vec::new();
        let mut skip = 0u32;
        let page_size = 100u32;
        loop {
            if ctx.cancel.load(Ordering::Relaxed) {
                break;
            }
            let (messages, next_link) = client.list_messages(&folder.id, page_size, skip).await?;
            let page_len = messages.len();
            listed.extend(messages);
            if page_len == 0 || next_link.is_none() || page_len < page_size as usize {
                break;
            }
            skip += page_size;
        }

        // Get local UIDs, after the pre-sync with the mirror, as the IMAP
        // runner does: a message restored here is not downloaded only to be
        // skipped. Off the runtime workers for the same reason too.
        let local_uids = {
            let vault_cur_dir = crate::vault_files::cur_path(&ctx.archive_ctx.root, account_id, &mailbox_path);
            let mirror_dir = mirror_dir.clone();
            let (registry, account, mailbox) = (Arc::clone(&ctx.archive_ctx.registry), account_id.clone(), mailbox_path.clone());
            tokio::task::spawn_blocking(move || vault_uids_after_presync(&registry, &account, &mailbox, &vault_cur_dir, mirror_dir.as_deref()))
                .await
                .map_err(|e| format!("pre-sync panicked: {}", e))??
        };

        // One listing per side for the whole folder, after the pre-sync so
        // what it restored or mirrored counts.
        // ponytail: a copy another writer lands mid-folder is not in this
        // listing, and this run writes its own beside it — the rescan this
        // replaced had that race too, only narrower.
        let (mut in_vault, mut in_mirror) = {
            let cur_dir = crate::vault_files::cur_path(&ctx.archive_ctx.root, account_id, &mailbox_path);
            let mirror_dir = mirror_dir.clone();
            tokio::task::spawn_blocking(move || {
                let in_vault: HashSet<u32> = uid_file_map(&cur_dir).into_keys().collect();
                let in_mirror: Option<HashSet<u32>> = mirror_dir.map(|dir| mirror_file_map(&dir).into_keys().collect());
                (in_vault, in_mirror)
            })
            .await
            .map_err(|e| format!("folder listing panicked: {}", e))?
        };

        if !listed.is_empty() && !ctx.cancel.load(Ordering::Relaxed) {
            let entries: Vec<(String, Option<String>)> =
                listed.iter().map(|m| (m.id.clone(), m.internet_message_id.clone())).collect();
            let ledger_path = ctx
                .archive_ctx
                .root
                .join("email_cache")
                .join(crate::header_cache::cache_base_name(account_id, &mailbox_path))
                .join(crate::graph_ledger::LEDGER_FILE);
            let cur_dir = crate::vault_files::cur_path(&ctx.archive_ctx.root, account_id, &mailbox_path);
            let local = local_uids.clone();
            // Directory scan, header reads and a file write, on whatever
            // drive the vault is on — and, in-process now, under the same
            // write gate every other vault-rooted route goes through (the
            // app-side original held this behind no gate at all).
            let gate = Arc::clone(&ctx.archive_ctx.gate);
            let plan: Result<Vec<(usize, u32)>, String> = tokio::task::spawn_blocking(move || {
                let mut planned: Result<Vec<(usize, u32)>, String> = Ok(Vec::new());
                let gated = gate(&mut || {
                    planned = crate::graph_ledger::plan_fetch(&ledger_path, &cur_dir, &entries, &local);
                    Ok(())
                });
                match gated {
                    Ok(()) => planned,
                    Err(e) => Err(e),
                }
            })
            .await
            .map_err(|e| format!("graph ledger panicked: {}", e))?;

            match plan {
                // No ledger, no numbers: filing by position instead is the
                // bug this replaces. The folder is reported and the run
                // moves on.
                Err(e) => {
                    warn!("backup(graph): {} not backed up: {}", mailbox_path, e);
                    total_errors += 1;
                    refused.get_or_insert((folder_idx, format!("{} was not backed up: {}", mailbox_path, e)));
                }
                Ok(plan) => {
                    for (idx, uid) in plan {
                        if ctx.cancel.load(Ordering::Relaxed) {
                            break;
                        }
                        let msg = &listed[idx];

                        // Fetch MIME content and store to vault + external backup dir
                        match client.get_mime_content(&msg.id).await {
                            Ok(raw_bytes) => {
                                let mirror_to = match copies_to_write(uid, &in_vault, in_mirror.as_ref()) {
                                    CopiesToWrite::Nothing => continue,
                                    CopiesToWrite::Vault => None,
                                    CopiesToWrite::VaultAndMirror => mirror_dir.clone(),
                                };
                                let cur_dir = crate::vault_files::cur_path(&ctx.archive_ctx.root, account_id, &mailbox_path);
                                let filename = crate::vault_files::build_maildir_filename(uid, &["archived".to_string()]);
                                // Both writes held across the same gate the
                                // per-file archive write uses: a stalled
                                // external drive would hold every task it
                                // polls if this ran on a runtime worker, and a
                                // vault move started mid-run must see this
                                // write finish or refuse it outright, not
                                // race it. A failed vault write ends the run;
                                // a failed mirror write is counted.
                                let gate = Arc::clone(&ctx.archive_ctx.gate);
                                let registry = Arc::clone(&ctx.archive_ctx.registry);
                                let (account, mailbox) = (account_id.clone(), mailbox_path.clone());
                                let mirror_write: Option<Result<(), String>> = tokio::task::spawn_blocking(
                                    move || -> Result<Option<Result<(), String>>, String> {
                                        let mut mirror_result: Option<Result<(), String>> = None;
                                        // Mailbox lock, then the gate (lock order);
                                        // the row lands right after the vault write.
                                        registry.serialized(&account, &mailbox, || gate(&mut || {
                                            std::fs::create_dir_all(&cur_dir).map_err(|e| format!("mkdir: {}", e))?;
                                            let written = cur_dir.join(&filename);
                                            if let Err(e) = std::fs::write(&written, &raw_bytes) {
                                                // A failed plain write can leave a partial file.
                                                registry.invalidate(&account, &mailbox);
                                                return Err(format!("write .eml: {}", e));
                                            }
                                            registry.upsert(&account, &mailbox, uid, &written);
                                            mirror_result = mirror_to.clone().map(|dir| {
                                                std::fs::create_dir_all(&dir)
                                                    .map_err(|e| format!("external mkdir failed: {}", e))
                                                    .and_then(|()| {
                                                        std::fs::write(dir.join(&filename), &raw_bytes)
                                                            .map_err(|e| format!("external write failed: {}", e))
                                                    })
                                            });
                                            Ok(())
                                        }))?;
                                        Ok(mirror_result)
                                    },
                                )
                                .await
                                .map_err(|e| format!("message write panicked: {}", e))??;
                                in_vault.insert(uid);
                                match mirror_write {
                                    Some(Ok(())) => {
                                        if let Some(mirrored) = in_mirror.as_mut() {
                                            mirrored.insert(uid);
                                        }
                                    }
                                    Some(Err(e)) => {
                                        warn!("backup(graph): {}", e);
                                        total_ext_failures += 1;
                                    }
                                    None => {}
                                }

                                total_backed_up += 1;
                            }
                            Err(e) => {
                                warn!("backup(graph): failed to fetch message {} in {}: {}", msg.id, folder_name, e);
                                total_errors += 1;
                                last_message_error = Some(e.to_string());
                            }
                        }
                    }
                }
            }
        }

        // Same shape as the IMAP loop: the page loop breaks on cancel, and
        // counting the folder anyway would have the next run skip past the
        // pages it never fetched.
        if ctx.cancel.load(Ordering::Relaxed) {
            warn!(
                "backup(graph): cancelled for {} inside {} ({}/{} folders done)",
                account.email, mailbox_path, completed_folders, total_folders
            );
            cancelled = true;
            break;
        }

        completed_folders += 1;

        // Per-folder progress only — always `active: true`. The dedicated
        // unconditional emit right after this loop (Task 7a) is now the only
        // place `active: false` is reported, matching `run_imap_account`'s
        // twin shape: this used to compute `completed_folders < total_folders`
        // and so never fired `active: false` on a cancel-`break` or a
        // zero-folder account (Problem 2 this task fixes).
        (ctx.on_progress)(BackupProgress {
            account_id: account_id.clone(),
            folder: mailbox_path,
            total_folders,
            completed_folders,
            total_emails: total_backed_up + total_errors,
            completed_emails: total_backed_up,
            errors: total_errors,
            active: true,
            last_error: None,
            missing_in_folder: 0,
            cancelled: false,
            // Mid-run: nothing has failed the run yet. Only the terminal
            // frame's value is ever read for completion.
            success: true,
            external_copy_ok: total_ext_failures == 0,
            external_copy_error: None,
            external_copy_failed_count: total_ext_failures,
        });
    }

    // Emit final completion/cancelled event (single event per account),
    // unconditionally — on every path that ends this loop (normal
    // completion, a cancel-`break` above, or a zero-folder account that
    // never runs an iteration at all). This is the fix for Problem 2: before
    // this, only the per-folder emit above ever reported `active: false`,
    // and only by coincidence on the last folder of an uncancelled run.
    //
    // Both values are built once, here, and shared with the `BackupResult`
    // below so the frame and the return value can never disagree. The
    // checkpoint in particular MUST be the clamped one: JS feeds the frame's
    // `completed_folders` straight back as the next run's `skip_folders`
    // (`backupScheduler.js`'s `_checkpoints`), so handing it the raw count
    // would have a resumed run skip clean past the folder the uid ledger
    // refused — which stored nothing. Task 7a emitted the raw count here;
    // inert then because nothing read the frame, load-bearing the moment
    // Task 7b made it the source of truth.
    let checkpoint = graph_completed_folders_checkpoint(completed_folders, refused.as_ref(), cancelled);
    let error_message = refused
        .as_ref()
        .map(|(_, why)| why.clone())
        .or_else(|| partial_error_message(total_errors, total_backed_up, last_message_error.as_deref()));
    (ctx.on_progress)(terminal_backup_progress(
        account_id,
        cancelled,
        total_folders,
        checkpoint,
        total_backed_up,
        total_errors,
        total_ext_failures,
        error_message.clone(),
    ));

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup(graph): {} for {} — {} emails backed up, {} errors, {:.1}s (folders: {}/{})",
        if cancelled { "cancelled" } else { "completed" },
        account.email,
        total_backed_up,
        total_errors,
        duration,
        completed_folders,
        total_folders
    );

    Ok(BackupResult {
        emails_backed_up: total_backed_up,
        errors: total_errors,
        duration_secs: duration,
        success: !cancelled,
        error_message,
        cancelled,
        // What the scheduler resumes from after a cancel. A folder the
        // ledger refused stored nothing, and a resumed run would skip it.
        // Same value the terminal frame above carries, by construction.
        completed_folders: checkpoint,
        external_copy_ok: total_ext_failures == 0,
        external_copy_error: if total_ext_failures > 0 {
            Some(format!("{} emails failed to copy to external backup", total_ext_failures))
        } else {
            None
        },
        external_copy_failed_count: total_ext_failures,
    })
}

struct GraphFolderOutcome {
    index: usize,
    mailbox: String,
    completed: bool,
    backed_up: usize,
    errors: usize,
    external_failures: usize,
    last_error: Option<String>,
    refused: Option<String>,
}

async fn run_graph_backup_parallel(
    ctx: BackupRunContext,
    start: std::time::Instant,
    folders: Vec<crate::graph::GraphMailFolder>,
) -> Result<BackupResult, String> {
    let total_folders = folders.len();
    let skip = ctx.skip_folders.min(total_folders);
    let work = folders.into_iter().enumerate().skip(skip).collect::<Vec<_>>();
    let mut done = vec![false; work.len()];
    let (mut backed, mut errors, mut external_failures) = (0, 0, 0);
    let mut last_error = None;
    let mut refused: Option<(usize, String)> = None;
    for batch in work.chunks(ctx.mailbox_concurrency.clamp(1, 5)) {
        if ctx.cancel.load(Ordering::Relaxed) { break; }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, folder) in batch {
            let folder = crate::graph::GraphMailFolder {
                id: folder.id.clone(), display_name: folder.display_name.clone(), total_item_count: folder.total_item_count,
                unread_item_count: folder.unread_item_count, child_folder_count: folder.child_folder_count,
                well_known_name: folder.well_known_name.clone(), storage_key: folder.storage_key.clone(),
            };
            let ctx = ctx.clone();
            let index = *index;
            tasks.spawn(async move { backup_graph_folder(ctx, index, folder).await });
        }
        while let Some(result) = tasks.join_next().await {
            let out = result.map_err(|e| format!("graph backup worker panicked: {e}"))??;
            if let Some(why) = out.refused.clone() { refused.get_or_insert((out.index, why)); }
            let slot = out.index.saturating_sub(skip);
            if slot < done.len() { done[slot] = out.completed; }
            backed += out.backed_up;
            errors += out.errors;
            external_failures += out.external_failures;
            if out.last_error.is_some() { last_error = out.last_error; }
            let completed = contiguous_completed_checkpoint(skip, &done).min(total_folders);
            (ctx.on_progress)(BackupProgress {
                account_id: ctx.account_id.clone(), folder: out.mailbox, total_folders, completed_folders: completed,
                total_emails: backed + errors, completed_emails: backed, errors, active: true, last_error: None,
                missing_in_folder: 0, cancelled: false, success: true, external_copy_ok: external_failures == 0,
                external_copy_error: None, external_copy_failed_count: external_failures,
            });
        }
    }
    let cancelled = ctx.cancel.load(Ordering::Relaxed);
    let completed = contiguous_completed_checkpoint(skip, &done).min(total_folders);
    let checkpoint = graph_completed_folders_checkpoint(completed, refused.as_ref(), cancelled);
    let error_message = refused.as_ref().map(|(_, why)| why.clone())
        .or_else(|| partial_error_message(errors, backed, last_error.as_deref()));
    (ctx.on_progress)(terminal_backup_progress(
        &ctx.account_id, cancelled, total_folders, checkpoint, backed, errors, external_failures, error_message.clone(),
    ));
    let duration = start.elapsed().as_secs_f64();
    Ok(BackupResult {
        emails_backed_up: backed, errors, duration_secs: duration, success: !cancelled, error_message, cancelled,
        completed_folders: checkpoint, external_copy_ok: external_failures == 0,
        external_copy_error: (external_failures > 0).then(|| format!("{} emails failed to copy to external backup", external_failures)),
        external_copy_failed_count: external_failures,
    })
}

async fn backup_graph_folder(
    ctx: BackupRunContext,
    index: usize,
    folder: crate::graph::GraphMailFolder,
) -> Result<GraphFolderOutcome, String> {
    use crate::maildir::{copies_to_write, mirror_file_map, uid_file_map, CopiesToWrite};
    let token = ctx.account.access_token.as_deref().ok_or("Missing OAuth2 access token for Graph account")?;
    let client = crate::graph::GraphClient::new(token);
    let mailbox = folder.storage_key;
    let mirror_dir = ctx.mirror_root.as_ref().map(|root| PathBuf::from(root).join(&ctx.account.email).join(&mailbox).join("cur"));
    let mut listed = Vec::new();
    let mut offset = 0;
    loop {
        if ctx.cancel.load(Ordering::Relaxed) { break; }
        let (messages, next) = client.list_messages(&folder.id, 100, offset).await?;
        let len = messages.len();
        listed.extend(messages);
        if len == 0 || next.is_none() || len < 100 { break; }
        offset += 100;
    }
    let local_uids = {
        let cur = crate::vault_files::cur_path(&ctx.archive_ctx.root, &ctx.account_id, &mailbox);
        let mirror = mirror_dir.clone();
        let (registry, account_id, mbox) = (Arc::clone(&ctx.archive_ctx.registry), ctx.account_id.clone(), mailbox.clone());
        tokio::task::spawn_blocking(move || vault_uids_after_presync(&registry, &account_id, &mbox, &cur, mirror.as_deref()))
            .await.map_err(|e| format!("pre-sync panicked: {e}"))??
    };
    let (mut in_vault, mut in_mirror) = {
        let cur = crate::vault_files::cur_path(&ctx.archive_ctx.root, &ctx.account_id, &mailbox);
        let mirror = mirror_dir.clone();
        tokio::task::spawn_blocking(move || {
            (uid_file_map(&cur).into_keys().collect::<HashSet<_>>(), mirror.map(|d| mirror_file_map(&d).into_keys().collect::<HashSet<_>>()))
        }).await.map_err(|e| format!("folder listing panicked: {e}"))?
    };
    let mut out = GraphFolderOutcome { index, mailbox: mailbox.clone(), completed: false, backed_up: 0, errors: 0, external_failures: 0, last_error: None, refused: None };
    if !listed.is_empty() && !ctx.cancel.load(Ordering::Relaxed) {
        let entries = listed.iter().map(|m| (m.id.clone(), m.internet_message_id.clone())).collect::<Vec<_>>();
        let ledger = ctx.archive_ctx.root.join("email_cache")
            .join(crate::header_cache::cache_base_name(&ctx.account_id, &mailbox)).join(crate::graph_ledger::LEDGER_FILE);
        let cur = crate::vault_files::cur_path(&ctx.archive_ctx.root, &ctx.account_id, &mailbox);
        let local = local_uids.clone();
        let gate = Arc::clone(&ctx.archive_ctx.gate);
        let plan = tokio::task::spawn_blocking(move || {
            let mut planned = Ok(Vec::new());
            gate(&mut || { planned = crate::graph_ledger::plan_fetch(&ledger, &cur, &entries, &local); Ok(()) })?;
            planned
        }).await.map_err(|e| format!("graph ledger panicked: {e}"))?;
        match plan {
            Err(e) => { out.errors += 1; out.refused = Some(format!("{} was not backed up: {}", mailbox, e)); }
            Ok(plan) => for (message_index, uid) in plan {
                if ctx.cancel.load(Ordering::Relaxed) { break; }
                let message = &listed[message_index];
                match client.get_mime_content(&message.id).await {
                    Err(e) => { out.errors += 1; out.last_error = Some(e); }
                    Ok(raw) => {
                        let mirror_to = match copies_to_write(uid, &in_vault, in_mirror.as_ref()) {
                            CopiesToWrite::Nothing => continue,
                            CopiesToWrite::Vault => None,
                            CopiesToWrite::VaultAndMirror => mirror_dir.clone(),
                        };
                        let cur = crate::vault_files::cur_path(&ctx.archive_ctx.root, &ctx.account_id, &mailbox);
                        let filename = crate::vault_files::build_maildir_filename(uid, &["archived".to_string()]);
                        let gate = Arc::clone(&ctx.archive_ctx.gate);
                        let registry = Arc::clone(&ctx.archive_ctx.registry);
                        let (account, mbox) = (ctx.account_id.clone(), mailbox.clone());
                        let mirror_write = tokio::task::spawn_blocking(move || -> Result<Option<Result<(), String>>, String> {
                            let mut mirror_result = None;
                            // Mailbox lock, then the gate (lock order); the row
                            // lands right after the vault write.
                            registry.serialized(&account, &mbox, || gate(&mut || {
                                std::fs::create_dir_all(&cur).map_err(|e| format!("mkdir: {e}"))?;
                                let written = cur.join(&filename);
                                if let Err(e) = std::fs::write(&written, &raw) {
                                    // A failed plain write can leave a partial file.
                                    registry.invalidate(&account, &mbox);
                                    return Err(format!("write .eml: {e}"));
                                }
                                registry.upsert(&account, &mbox, uid, &written);
                                mirror_result = mirror_to.clone().map(|dir| std::fs::create_dir_all(&dir)
                                    .map_err(|e| format!("external mkdir failed: {e}"))
                                    .and_then(|()| std::fs::write(dir.join(&filename), &raw).map_err(|e| format!("external write failed: {e}"))));
                                Ok(())
                            }))?;
                            Ok(mirror_result)
                        }).await.map_err(|e| format!("message write panicked: {e}"))??;
                        in_vault.insert(uid);
                        match mirror_write {
                            Some(Ok(())) => if let Some(ref mut mirrored) = in_mirror { mirrored.insert(uid); },
                            Some(Err(_)) => out.external_failures += 1,
                            None => {}
                        }
                        out.backed_up += 1;
                    }
                }
            },
        }
    }
    out.completed = !ctx.cancel.load(Ordering::Relaxed);
    Ok(out)
}

/// The resume checkpoint a Graph run reports: `completed_folders`, clamped to
/// the first folder the uid ledger refused when the run was cancelled at or
/// after that point. Extracted out of `run_graph_backup_inner`'s final
/// `BackupResult` so it's testable without a live `GraphClient` — a refused
/// folder stored nothing, and a resumed run reading a checkpoint that passed
/// it would skip a folder it never actually backed up. An uncancelled run
/// that reached the end of its folder loop already moved past the refused
/// folder on its own (`completed_folders` counts it like any other), so only
/// a cancelled run needs clamping.
fn graph_completed_folders_checkpoint(completed_folders: usize, refused: Option<&(usize, String)>, cancelled: bool) -> usize {
    match refused {
        Some((idx, _)) if cancelled => completed_folders.min(*idx),
        _ => completed_folders,
    }
}

// ── Backup status comparison ─────────────────────────────────────────────────
//
// Ported from `backup.rs:59-461` (`FolderBackupStatus`/`AccountBackupStatus`,
// `get_backup_status`, `get_imap_backup_status`, `get_graph_backup_status`,
// `build_folder_status`), minus the bookmark resolution and app-handle
// plumbing — see the module doc's "What did NOT move here" note.
// `scan_local_uids` did not port as its own function: it was a one-line
// `scan_cur_uids(&maildir_cur_path(...)?)` wrapper, and `crate::vault_files::
// cur_path` + `scan_cur_uids` (both already in this file) inline the same
// thing at each call site below without an extra indirection.

#[derive(Serialize, Clone)]
pub struct FolderBackupStatus {
    pub path: String,
    pub name: String,
    pub server_count: usize,
    pub app_count: usize,
    pub external_count: usize,
    pub children: Vec<FolderBackupStatus>,
    // Legacy aliases for frontend compat — field-for-field with
    // `backup.rs:69-73`, do not rename or drop either alias.
    #[serde(rename = "folder")]
    pub folder_alias: String,
    #[serde(rename = "local_count")]
    pub local_count_alias: usize,
}

#[derive(Serialize)]
pub struct AccountBackupStatus {
    pub folders: Vec<FolderBackupStatus>,
    pub total_server: usize,
    pub total_local: usize,
    pub total_app: usize,
    pub total_external: usize,
    pub external_available: bool,
    /// Status of the external location: "ready", "needs_reauth",
    /// "unavailable", "invalid", "not_configured". Not computed here — the
    /// daemon has no bookmark API, see the module doc — the caller passes
    /// through whatever `external_location::get_external_location` (or
    /// equivalent) already told it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_error: Option<String>,
}

/// Build a FolderBackupStatus for one folder.
///
/// Both counts are `read_dir`s — one on the vault, one on the backup drive.
/// On a drive another process is hammering they stall for seconds, and on a
/// runtime worker that stall is paid by every IMAP socket the runtime is meant
/// to be polling, so they run on the blocking pool.
async fn build_folder_status(
    path: &str,
    name: &str,
    server_count: usize,
    vault_root: &Path,
    account_id: &str,
    mirror_root: Option<&Path>,
    email: &str,
    children: Vec<FolderBackupStatus>,
) -> FolderBackupStatus {
    let (app_count, external_count) = {
        let vault_cur_dir = crate::vault_files::cur_path(vault_root, account_id, path);
        let mirror_root = mirror_root.map(|p| p.to_path_buf());
        let email = email.to_string();
        let path_owned = path.to_string();
        tokio::task::spawn_blocking(move || {
            let app_count = scan_cur_uids(&vault_cur_dir).unwrap_or_default().len();
            let external_count = match mirror_root {
                Some(root) => scan_external_uids(&root, &email, &path_owned).len(),
                None => 0,
            };
            (app_count, external_count)
        })
        .await
        .unwrap_or_else(|e| {
            warn!("build_folder_status: folder scan panicked: {}", e);
            (0, 0)
        })
    };
    FolderBackupStatus {
        path: path.to_string(),
        name: name.to_string(),
        server_count,
        app_count,
        external_count,
        children,
        folder_alias: path.to_string(),
        local_count_alias: app_count,
    }
}

/// IMAP backup status with folder hierarchy. Ported from `backup.rs:366-470`.
///
/// Deviation from the app source: the app's inner `get_background` failure
/// (`.unwrap_or_else(|_| panic!("pool"))`) is not ported — a pool hiccup on
/// one folder must not crash the daemon process (it would take down every
/// other account's sync and the search index with it). Propagated with `?`
/// instead, same as every other daemon-facing route: a status call that
/// can't reach the server fails outright rather than reporting a
/// half-correct tree with zeroed-out counts for a folder it silently gave up
/// on.
///
/// Also bounded (`imap::bounded`) where the app source left the `LIST` and
/// per-folder `UID SEARCH` calls unbounded — an RPC handler awaiting an IMAP
/// socket forever is the same hazard Task 1's `run_imap_account` already
/// guards its own `LIST`/`UID FETCH` calls against; this status path gets no
/// weaker a guarantee just because it isn't a long-running job.
async fn get_imap_backup_status(
    pool: &ImapPool,
    account_id: &str,
    account: &ImapConfig,
    vault_root: &Path,
    mirror_root: Option<&Path>,
) -> Result<AccountBackupStatus, String> {
    let mailboxes = {
        let mut guard = pool.get_background(account).await?;
        let result = imap::bounded("LIST", 60, imap::list_mailboxes(&mut guard.session)).await;
        match &result {
            Ok(_) => pool.return_background(account, guard).await,
            Err(_) => pool.discard(account, guard).await,
        }
        result?
    };

    // Build tree recursively, getting server counts via IMAP. A `Result`
    // return (the app source's `build_tree` returned a bare `Vec`) is what
    // lets a mid-tree pool failure `?` out of the whole status call instead
    // of panicking — see this function's own doc comment.
    #[allow(clippy::too_many_arguments)]
    async fn build_tree(
        pool: &ImapPool,
        account: &ImapConfig,
        vault_root: &Path,
        account_id: &str,
        mailboxes: &[imap::MailboxInfo],
        mirror_root: Option<&Path>,
        total_server: &mut usize,
        total_app: &mut usize,
        total_external: &mut usize,
    ) -> Result<Vec<FolderBackupStatus>, String> {
        let mut result = Vec::new();
        for mbox in mailboxes {
            // Recurse into children first
            let children = Box::pin(build_tree(
                pool, account, vault_root, account_id,
                &mbox.children, mirror_root,
                total_server, total_app, total_external,
            )).await?;

            if mbox.noselect {
                // Non-selectable folder: include only if it has children with data
                if !children.is_empty() {
                    result.push(FolderBackupStatus {
                        path: mbox.path.clone(),
                        name: mbox.name.clone(),
                        server_count: 0,
                        app_count: 0,
                        external_count: 0,
                        children,
                        folder_alias: mbox.path.clone(),
                        local_count_alias: 0,
                    });
                }
                continue;
            }

            let server_uids = {
                let mut guard = pool.get_background(account).await?;
                let r = imap::bounded(
                    &format!("UID SEARCH {}", mbox.path),
                    60,
                    imap::search_all_uids(&mut guard.session, &mbox.path, false),
                )
                .await;
                // A failed command can leave unread bytes on the session — never re-pool it.
                match &r {
                    Ok(_) => pool.return_background(account, guard).await,
                    Err(_) => pool.discard(account, guard).await,
                }
                r.unwrap_or_default()
            };
            let sc = server_uids.len();

            let status = build_folder_status(
                &mbox.path, &mbox.name, sc,
                vault_root, account_id, mirror_root, &account.email,
                children,
            ).await;

            *total_server += sc;
            *total_app += status.app_count;
            *total_external += status.external_count;

            if sc > 0 || status.app_count > 0 || status.external_count > 0 || !status.children.is_empty() {
                result.push(status);
            }
        }
        Ok(result)
    }

    let mut total_server = 0usize;
    let mut total_app = 0usize;
    let mut total_external = 0usize;

    let folders = build_tree(
        pool, account, vault_root, account_id,
        &mailboxes, mirror_root,
        &mut total_server, &mut total_app, &mut total_external,
    ).await?;

    let external_available = mirror_root.is_some();

    Ok(AccountBackupStatus {
        folders,
        total_server,
        total_local: total_app,
        total_app,
        total_external,
        external_available,
        external_status: None,
        external_error: None,
    })
}

/// Graph/Outlook backup status — uses total_item_count from folder metadata.
/// Ported from `backup.rs:473-543`.
async fn get_graph_backup_status(
    account_id: &str,
    account: &ImapConfig,
    vault_root: &Path,
    mirror_root: Option<&Path>,
) -> Result<AccountBackupStatus, String> {
    let access_token = account
        .access_token
        .as_deref()
        .ok_or_else(|| "Missing OAuth2 access token for Graph account".to_string())?;
    let email = account.email.clone();

    let client = crate::graph::GraphClient::new(access_token);
    let graph_folders = client.list_folders().await?;

    // One `read_dir` per folder on the vault and on the backup drive, and no
    // await anywhere in the loop — so the whole loop goes to the blocking pool
    // rather than stalling the runtime workers on a struggling drive.
    let (folders, total_server, total_app, total_external) = {
        let vault_root = vault_root.to_path_buf();
        let account_id = account_id.to_string();
        let mirror_root = mirror_root.map(|p| p.to_path_buf());
        tokio::task::spawn_blocking(move || {
            let mut folders = Vec::new();
            let mut total_server = 0usize;
            let mut total_app = 0usize;
            let mut total_external = 0usize;

            for gf in &graph_folders {
                let mailbox_path = gf.storage_key.clone();
                let sc = gf.total_item_count.max(0) as usize;
                let cur_dir = crate::vault_files::cur_path(&vault_root, &account_id, &mailbox_path);
                let app_count = scan_cur_uids(&cur_dir).unwrap_or_default().len();
                let ext_count = match mirror_root.as_deref() {
                    Some(root) => scan_external_uids(root, &email, &mailbox_path).len(),
                    None => 0,
                };

                total_server += sc;
                total_app += app_count;
                total_external += ext_count;

                if sc > 0 || app_count > 0 || ext_count > 0 {
                    folders.push(FolderBackupStatus {
                        path: mailbox_path.clone(),
                        name: gf.display_name.clone(),
                        server_count: sc,
                        app_count,
                        external_count: ext_count,
                        children: vec![],
                        folder_alias: mailbox_path,
                        local_count_alias: app_count,
                    });
                }
            }
            (folders, total_server, total_app, total_external)
        })
        .await
        .map_err(|e| format!("graph folder scan panicked: {}", e))?
    };

    let external_available = mirror_root.is_some();

    Ok(AccountBackupStatus {
        folders,
        total_server,
        total_local: total_app,
        total_app,
        total_external,
        external_available,
        external_status: None,
        external_error: None,
    })
}

/// Compare server email counts vs local backup counts for each folder.
/// Ported from `backup.rs:311-363`'s `get_backup_status`, minus the bookmark
/// resolution: `mirror_root` is already resolved by the caller, and
/// `external_status`/`external_error` are whatever the caller already knows
/// about that resolution (see `AccountBackupStatus::external_status`'s doc
/// comment) — passed straight through onto the result, exactly as the app's
/// own wrapper enriched `get_imap_backup_status`/`get_graph_backup_status`'s
/// otherwise-`None` fields after the fact.
pub async fn get_backup_status(
    pool: &ImapPool,
    account_id: &str,
    account: &ImapConfig,
    vault_root: &Path,
    mirror_root: Option<&Path>,
    external_status: Option<String>,
    external_error: Option<String>,
) -> Result<AccountBackupStatus, String> {
    let mut status = if account.oauth2_transport.as_deref() == Some("graph") {
        get_graph_backup_status(account_id, account, vault_root, mirror_root).await?
    } else {
        get_imap_backup_status(pool, account_id, account, vault_root, mirror_root).await?
    };

    status.external_status = external_status;
    status.external_error = external_error;

    Ok(status)
}

// ── Local/mirror uid scanning ────────────────────────────────────────────────

/// A backup folder's vault uids, counted after the pre-sync with its mirror
/// when there is one. The run fetches every server uid missing from this set.
/// Counted before the pre-sync, a uid only the mirror held was still missing
/// once restored: the fetch downloaded it again and stored the server's copy
/// beside the restored one, under a second name.
///
/// The pre-sync runs outside the vault gate and the registry's mailbox lock (a
/// copy off a slow external drive must not block the folder's reads), so a
/// restore into the vault is not recorded row by row: the folder is
/// invalidated once, which needs no lock, and its next read lists it again.
fn vault_uids_after_presync(
    reg: &VaultRegistry,
    account_id: &str,
    mailbox: &str,
    vault_cur_dir: &Path,
    mirror_dir: Option<&Path>,
) -> Result<HashSet<u32>, String> {
    if let Some(mirror_dir) = mirror_dir {
        let (synced, vault_touched) = sync_locations(vault_cur_dir, mirror_dir);
        if vault_touched {
            reg.invalidate(account_id, mailbox);
        }
        if synced > 0 {
            info!("backup: pre-synced {} files between {:?} and {:?}", synced, vault_cur_dir, mirror_dir);
        }
    }
    scan_cur_uids(vault_cur_dir)
}

fn scan_cur_uids(cur_dir: &Path) -> Result<HashSet<u32>, String> {
    if !cur_dir.exists() {
        return Ok(HashSet::new());
    }

    let mut uids = HashSet::new();
    let entries = std::fs::read_dir(cur_dir).map_err(|e| format!("Failed to read Maildir cur dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Filename format: "<uid>:<flags>.eml" or "<uid>.eml" or "<uid>_<flags>.eml"
        if let Some(uid) = crate::maildir::mirror_filename_uid(&name) {
            uids.insert(uid);
        }
    }

    Ok(uids)
}

/// Which uids of `<email>/<mailbox>` are present in an external backup
/// directory. Ported from `backup.rs:143-153`.
fn scan_external_uids(backup_path: &Path, email: &str, mailbox: &str) -> HashSet<u32> {
    let cur_dir = backup_path.join(email).join(mailbox).join("cur");
    crate::maildir::mirror_file_map(&cur_dir).into_keys().collect()
}

/// Which uids of `<email>/<mailbox>` are present in the external mirror.
/// Ported from `backup.rs:1488-1518`'s `backup_scan_uids` command, minus the
/// bookmark resolution — `mirror_root` is already resolved by the caller.
///
/// `None` means "could not determine": the app's two `None`-returning
/// branches (no location configured at all, or one configured but
/// unreachable) both collapse into the caller's single already-resolved
/// `mirror_root: Option<&Path>` being `None` — this read path (unlike
/// `purge_uids`) treats them identically, so no separate "not configured"
/// signal is needed here. `Some(vec![])` is the positive claim "reachable,
/// confirmed nothing mirrored" — the caller must never conflate the two, see
/// the module doc's Global Constraint note.
pub fn scan_uids(mirror_root: Option<&Path>, email: &str, mailbox: &str) -> Option<Vec<u32>> {
    let root = mirror_root?;
    Some(scan_external_uids(root, email, mailbox).into_iter().collect())
}

/// Sync files between the vault Maildir and the backup location (bidirectional).
/// - Vault files missing from backup → copy to backup keeping the Maildir
///   name (`<uid>:2,<flags>.eml`) so flags survive the round trip
/// - Backup files missing from the vault → copy to the vault, named with
///   `archived` on top of whatever flags the backup filename carried (legacy
///   `<uid>.eml` copies carry none): the vault copy the restore makes is what
///   puts the row in the list and what Clear cached emails keeps. Never
///   re-imports a message the generation repair already set aside.
/// Returns total files synced, and whether any copy INTO the vault was
/// attempted (the caller's vault registry then lists the folder again).
fn sync_locations(vault_cur_dir: &Path, backup_dir: &Path) -> (usize, bool) {
    use crate::maildir::{mirror_file_map, mirror_filename_uid, uid_file_map};
    use std::fs;
    let mut synced = 0;
    let mut vault_touched = false;

    // Ensure both dirs exist; if backup dir can't be created (disconnected drive), skip
    let _ = fs::create_dir_all(vault_cur_dir);
    if fs::create_dir_all(backup_dir).is_err() {
        return (0, false); // Backup location not available — skip sync, backup to the vault only
    }

    // One listing per side instead of rescanning the other side per file,
    // which on the external drive was n²/2 directory entries every backup. A
    // copy counts in the set, as the rescan used to find the file it had just
    // written. Each side keeps its own uid rule.
    // ponytail: a writer landing the same uid mid-sync can leave it twice under
    // two flag names; the rescan had that race too, only narrower.
    let mut in_backup: HashSet<u32> = mirror_file_map(backup_dir).into_keys().collect();

    // Vault → Backup: copy vault files that don't exist in backup, keeping the
    // Maildir name so the flag suffix travels with the message.
    if let Ok(entries) = fs::read_dir(vault_cur_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(uid) = mirror_filename_uid(&name) else { continue };
            if in_backup.contains(&uid) {
                continue;
            }
            let dst_name = if name.ends_with(".eml") { name.clone() } else { format!("{}.eml", name) };
            if fs::copy(entry.path(), backup_dir.join(&dst_name)).is_ok() {
                synced += 1;
                in_backup.insert(uid);
            }
        }
    }

    // Backup → Vault: copy backup .eml files that don't exist in the vault,
    // restoring flags from the backup filename (legacy `<uid>.eml` has none).
    let mut in_vault: HashSet<u32> = uid_file_map(vault_cur_dir).into_keys().collect();
    let mut orphaned_ids: Option<HashSet<String>> = None;
    if let Ok(entries) = fs::read_dir(backup_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".eml") {
                continue;
            }
            let Some(uid) = mirror_filename_uid(&name) else { continue };
            if in_vault.contains(&uid) {
                continue;
            }
            // The mirror is keyed by uid and carries no generation of its own, so
            // a uid it holds is only as good as the generation that wrote it.
            // `orphaned/` is the one local record of which messages this
            // generation does NOT have — see orphaned_message_ids.
            let ids = orphaned_ids.get_or_insert_with(|| orphaned_message_ids(vault_cur_dir));
            if !ids.is_empty() {
                if let Some(id) = crate::maildir::read_message_id(&entry.path()) {
                    if ids.contains(&id) {
                        warn!("backup: not restoring {} — the generation repair set this message aside", name);
                        continue;
                    }
                }
            }
            let mut flags = crate::vault_eml::parse_flags_from_filename(&name);
            flags.push("archived".to_string());
            let dst = vault_cur_dir.join(crate::vault_files::build_maildir_filename(uid, &flags));
            // Even a failed copy can leave a partial file behind.
            vault_touched = true;
            if fs::copy(entry.path(), &dst).is_ok() {
                synced += 1;
                in_vault.insert(uid);
            }
        }
    }

    (synced, vault_touched)
}

/// Message-IDs the generation repair moved out of the uid namespace.
///
/// `orphaned/` is the repair's own record that a file is not this generation's:
/// it read the Message-ID, found no uid the current server gives it, and set the
/// file aside rather than delete it. The backup mirror still holds that same
/// message under its OLD uid, and the restore direction above would copy it
/// straight back into `cur/` — undoing the repair on every backup run, forever,
/// because `.uidvalidity` now matches the server and `repair_generation` no-ops.
///
/// Built lazily by the caller — a sync with nothing to restore never reads it.
fn orphaned_message_ids(vault_cur_dir: &Path) -> HashSet<String> {
    let orphan_dir = match vault_cur_dir.parent() {
        Some(p) => p.join(crate::maildir::ORPHAN_DIR),
        None => return HashSet::new(),
    };
    let mut ids = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&orphan_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                continue;
            }
            if let Some(id) = crate::maildir::read_message_id(&entry.path()) {
                ids.insert(id);
            }
        }
    }
    ids
}

// ── Flag catch-up ─────────────────────────────────────────────────────────────

/// One flag change per server uid the vault holds, carrying the server's flags
/// plus `archived`: every copy this run counted as backed up is a vault copy,
/// and `A` is what says so.
fn catch_up_changes(server_flags: &[(u32, Vec<String>)], local_uids: &HashSet<u32>) -> Vec<FlagChange> {
    server_flags
        .iter()
        .filter(|(uid, _)| local_uids.contains(uid))
        .map(|(uid, flags)| {
            let mut flags = flags.clone();
            flags.push("archived".to_string());
            FlagChange { uid: *uid, flags }
        })
        .collect()
}

/// A daemon hiccup on the flag catch-up call (a restart, a build-id mismatch)
/// must not fail an account whose folders otherwise saved everything:
/// `apply_everywhere` was infallible and swallowed a custody-patch failure on
/// its own before it. Warn and fall back to `Applied::default()` — the next
/// run's `catch_up_changes` recomputes the same set from `local_uids`, so the
/// heal retries on its own instead of failing the whole account run.
fn map_flag_catchup_outcome(outcome: Result<Applied, String>, account_id: &str, mailbox_path: &str) -> Applied {
    match outcome {
        Ok(applied) => applied,
        Err(e) => {
            warn!("backup: {}/{} flag catch-up failed: {}", account_id, mailbox_path, e);
            Applied::default()
        }
    }
}

// ── What to tell the user ────────────────────────────────────────────────────

/// `None` when nothing failed — the caller renders a plain success. Otherwise
/// the count AND the server's own words, because "Unknown error" on an
/// otherwise complete backup is what trains people to ignore the alarm.
fn partial_error_message(errors: usize, backed_up: usize, last_error: Option<&str>) -> Option<String> {
    if errors == 0 {
        return None;
    }
    let attempted = backed_up + errors;
    let head = format!("{} of {} message{} could not be fetched", errors, attempted, if attempted == 1 { "" } else { "s" });
    Some(match last_error {
        Some(e) if !e.trim().is_empty() => format!("{}. Last error: {}", head, e.trim()),
        _ => format!("{}.", head),
    })
}

// ── Mailboxes ─────────────────────────────────────────────────────────────────

/// Flatten nested mailbox tree into a flat list
fn flatten_mailboxes(mailboxes: &[imap::MailboxInfo]) -> Vec<&imap::MailboxInfo> {
    let mut result = Vec::new();
    for m in mailboxes {
        result.push(m);
        if !m.children.is_empty() {
            result.extend(flatten_mailboxes(&m.children));
        }
    }
    result
}

// ── Pending backup purge queue ──────────────────────────────────────────────
//
// The external backup volume is routinely absent (unplugged drive, unmounted
// network share). "Delete everywhere" must still complete, so uids whose mirror
// copy could not be reached are parked here and applied on the next backup run.
// Ported from `backup.rs:190-260`. Task 3 adds `queue_purge` (the writer side)
// and `purge_uids` (the full `backup_purge_uids` decision: purge now vs queue
// for later vs no-op when nothing is configured) below `purge_backup_files`.

fn read_purge_queue(data_dir: &Path) -> std::collections::BTreeMap<String, Vec<u32>> {
    // A store that will not open must not brick delete-everywhere; start over
    // rather than error, the same thing the JSON reader did with a corrupt file.
    crate::app_db::with(data_dir, |conn| Ok(crate::app_db::ops::purge_read(conn))).unwrap_or_default()
}

fn write_purge_queue(data_dir: &Path, q: &std::collections::BTreeMap<String, Vec<u32>>) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| crate::app_db::ops::purge_write(conn, q))
}

/// Delete every mirror file under `<root>/<email>/<mailbox>/cur/` whose uid is
/// in `uids`. Returns how many files were removed.
fn purge_backup_files(root: &Path, email: &str, mailbox: &str, uids: &HashSet<u32>) -> usize {
    let cur = root.join(email).join(mailbox).join("cur");
    if !cur.exists() {
        return 0;
    }
    let mut removed = 0usize;
    if let Ok(entries) = std::fs::read_dir(&cur) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            match crate::maildir::mirror_filename_uid(&name) {
                Some(uid) if uids.contains(&uid) => {}
                _ => continue,
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(e) => warn!("backup purge: failed to remove {:?}: {}", entry.path(), e),
            }
        }
    }
    removed
}

/// Queue `uids` of `<email>/<mailbox>` for purge next time the mirror is
/// reachable. Ported from `backup.rs:214-226`.
fn queue_purge(data_dir: &Path, email: &str, mailbox: &str, uids: &[u32]) -> Result<(), String> {
    let mut q = read_purge_queue(data_dir);
    let entry = q.entry(format!("{}|{}", email, mailbox)).or_default();
    entry.extend_from_slice(uids);
    entry.sort_unstable();
    entry.dedup();
    write_purge_queue(data_dir, &q)
}

/// What `purge_uids` did: files removed now, or uids queued for the next
/// reachable run.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct PurgeOutcome {
    pub removed: usize,
    pub queued: usize,
}

/// Delete `uids` of `<email>/<mailbox>` from the external mirror now if it's
/// reachable, or queue them for the next backup run that can reach it.
/// Ported from `backup.rs:1443-1480`'s `backup_purge_uids` command, minus the
/// bookmark resolution (`resolve_backup_path`) that stays with the Tauri
/// shell — `mirror_root` is already resolved by the caller, `None` meaning
/// either "not configured" or "configured but unreachable". `external_status`
/// disambiguates those two exactly as `external_location::get_external_location`
/// did for the app-side command (the daemon has no bookmark API to call that
/// itself — `main.rs`'s module-list comment). A missing `external_status`
/// (`None`) is treated as `"not_configured"`: the guard this queue exists to
/// keep ("no backup configured at all is not a queue-worthy event") must fail
/// closed, not open, when a caller omits the field.
pub fn purge_uids(
    data_dir: &Path,
    mirror_root: Option<&Path>,
    external_status: Option<&str>,
    email: &str,
    mailbox: &str,
    uids: &[u32],
) -> Result<PurgeOutcome, String> {
    if uids.is_empty() {
        return Ok(PurgeOutcome { removed: 0, queued: 0 });
    }

    let Some(root) = mirror_root else {
        if external_status.unwrap_or("not_configured") == "not_configured" {
            return Ok(PurgeOutcome { removed: 0, queued: 0 });
        }
        queue_purge(data_dir, email, mailbox, uids)?;
        info!("backup purge: mirror unreachable, queued {} uids for {}/{}", uids.len(), email, mailbox);
        return Ok(PurgeOutcome { removed: 0, queued: uids.len() });
    };

    let uid_set: HashSet<u32> = uids.iter().copied().collect();
    let removed = purge_backup_files(root, email, mailbox, &uid_set);
    info!("backup purge: removed {} mirror files for {}/{}", removed, email, mailbox);
    Ok(PurgeOutcome { removed, queued: 0 })
}

/// Apply every queued purge against a now-reachable backup root.
/// Entries are dropped as they are applied; anything left in the map stays
/// queued for the next run.
fn drain_purge_queue(data_dir: &Path, root: &Path) -> usize {
    let q = read_purge_queue(data_dir);
    if q.is_empty() {
        return 0;
    }
    let mut removed_total = 0usize;
    let mut leftover: std::collections::BTreeMap<String, Vec<u32>> = Default::default();

    for (key, uids) in q {
        let Some((email, mailbox)) = key.split_once('|') else {
            continue; // malformed key — drop it, nothing can act on it
        };
        let uid_set: HashSet<u32> = uids.iter().copied().collect();
        let mirror = root.join(email).join(mailbox).join("cur");
        if !mirror.exists() {
            // Folder not mirrored (yet). Keep the entry rather than declare success.
            leftover.insert(key.clone(), uids);
            continue;
        }
        removed_total += purge_backup_files(root, email, mailbox, &uid_set);
    }

    if let Err(e) = write_purge_queue(data_dir, &leftover) {
        warn!("drain_purge_queue: failed to rewrite queue: {}", e);
    }
    if removed_total > 0 {
        info!("drain_purge_queue: removed {} queued mirror files", removed_total);
    }
    removed_total
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn change(uid: u32, flags: &[&str]) -> (u32, Vec<String>) {
        (uid, flags.iter().map(|s| s.to_string()).collect())
    }

    /// The real `catch_up_changes(server_flags: &[(u32, Vec<String>)], local_uids:
    /// &HashSet<u32>)` filters by LOCAL uid (only vault copies get a catch-up
    /// change), not by every server uid — the plan brief's illustrative test
    /// assumed a different signature; this exercises the actual one from
    /// `backup.rs:1009-1022`.
    #[test]
    fn catch_up_changes_builds_one_flag_change_per_local_uid_present_on_the_server() {
        let server_flags = vec![change(101, &["\\Seen"]), change(102, &[]), change(103, &["\\Flagged"])];
        let local_uids: HashSet<u32> = [101u32, 102u32].into_iter().collect();

        let changes = catch_up_changes(&server_flags, &local_uids);

        assert_eq!(changes.len(), 2, "only the two local uids get a catch-up change");
        assert!(changes.iter().any(|c| c.uid == 101 && c.flags == vec!["\\Seen".to_string(), "archived".to_string()]));
        assert!(changes.iter().any(|c| c.uid == 102 && c.flags == vec!["archived".to_string()]));
        assert!(!changes.iter().any(|c| c.uid == 103), "uid 103 has no local copy, so it gets no change");
    }

    #[test]
    fn catch_up_changes_is_empty_when_no_server_uid_has_a_local_copy() {
        let server_flags = vec![change(1, &[]), change(2, &[])];
        let local_uids: HashSet<u32> = HashSet::new();
        assert!(catch_up_changes(&server_flags, &local_uids).is_empty());
    }

    #[test]
    fn map_flag_catchup_outcome_falls_back_to_default_on_error_instead_of_failing_the_run() {
        let applied = map_flag_catchup_outcome(Err("daemon hiccup".to_string()), "acct", "INBOX");
        assert_eq!(applied, Applied::default());
    }

    #[test]
    fn map_flag_catchup_outcome_passes_through_ok() {
        let expected = Applied { renamed: 3, mirrored: 2, index_patched: 3, sidecars_patched: 0 };
        let applied = map_flag_catchup_outcome(Ok(Applied { renamed: 3, mirrored: 2, index_patched: 3, sidecars_patched: 0 }), "acct", "INBOX");
        assert_eq!(applied, expected);
    }

    // ── flatten_mailboxes ──────────────────────────────────────────────────

    fn mbox(path: &str, noselect: bool, children: Vec<imap::MailboxInfo>) -> imap::MailboxInfo {
        imap::MailboxInfo {
            name: path.to_string(),
            path: path.to_string(),
            special_use: None,
            flags: vec![],
            delimiter: Some("/".to_string()),
            noselect,
            children,
        }
    }

    #[test]
    fn flatten_mailboxes_includes_every_nested_child_in_document_order() {
        let tree = vec![mbox("INBOX", false, vec![]), mbox("Archive", true, vec![mbox("Archive/2024", false, vec![])])];
        let flat = flatten_mailboxes(&tree);
        let paths: Vec<&str> = flat.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(paths, vec!["INBOX", "Archive", "Archive/2024"]);
    }

    // ── vault_uids_after_presync / scan_cur_uids ────────────────────────────

    fn write_vault_file(dir: &Path, uid: u32, flags: &[&str]) {
        std::fs::create_dir_all(dir).unwrap();
        let flag_str: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
        std::fs::write(dir.join(crate::vault_files::build_maildir_filename(uid, &flag_str)), b"body").unwrap();
    }

    #[test]
    fn scan_cur_uids_reads_uids_out_of_maildir_filenames() {
        let tmp = tempfile::tempdir().unwrap();
        write_vault_file(tmp.path(), 7, &[]);
        write_vault_file(tmp.path(), 9, &["\\Seen"]);
        let uids = scan_cur_uids(tmp.path()).unwrap();
        assert_eq!(uids, [7u32, 9u32].into_iter().collect());
    }

    #[test]
    fn scan_cur_uids_on_a_missing_dir_is_empty_not_an_error() {
        let uids = scan_cur_uids(Path::new("/nonexistent/does/not/exist")).unwrap();
        assert!(uids.is_empty());
    }

    #[test]
    fn vault_uids_after_presync_pulls_in_a_mirror_only_uid_via_sync_locations() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        // Only in the mirror — a restored file the vault has never seen.
        write_vault_file(mirror.path(), 42, &[]);

        let (_app, reg) = test_registry(vault.path());
        let uids = vault_uids_after_presync(&reg, "acct", "INBOX", vault.path(), Some(mirror.path())).unwrap();

        assert!(uids.contains(&42), "the pre-sync must restore the mirror-only uid into the vault before scanning");
    }

    // ── purge queue ──────────────────────────────────────────────────────────

    #[test]
    fn drain_purge_queue_removes_files_and_leaves_unreachable_entries_queued() {
        let app_dir = tempfile::tempdir().unwrap();
        let mirror_root = tempfile::tempdir().unwrap();

        // Seed a queue with two mailboxes: one whose mirror folder exists
        // (purge-able now), one that doesn't (drive not mounted yet).
        let cur = mirror_root.path().join("me@example.com").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(crate::vault_files::build_maildir_filename(1, &[])), b"body").unwrap();

        let mut q = std::collections::BTreeMap::new();
        q.insert("me@example.com|INBOX".to_string(), vec![1u32]);
        q.insert("me@example.com|Archive".to_string(), vec![2u32]);
        write_purge_queue(app_dir.path(), &q).unwrap();

        let removed = drain_purge_queue(app_dir.path(), mirror_root.path());

        assert_eq!(removed, 1);
        let leftover = read_purge_queue(app_dir.path());
        assert!(leftover.contains_key("me@example.com|Archive"), "the unreachable folder stays queued");
        assert!(!leftover.contains_key("me@example.com|INBOX"), "the applied entry is dropped from the queue");
    }

    #[test]
    fn purge_uids_removes_now_when_the_mirror_is_reachable() {
        let app_dir = tempfile::tempdir().unwrap();
        let mirror_root = tempfile::tempdir().unwrap();
        let cur = mirror_root.path().join("me@example.com").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(crate::vault_files::build_maildir_filename(5, &[])), b"body").unwrap();

        let outcome =
            purge_uids(app_dir.path(), Some(mirror_root.path()), Some("ready"), "me@example.com", "INBOX", &[5]).unwrap();

        assert_eq!(outcome, PurgeOutcome { removed: 1, queued: 0 });
        assert!(read_purge_queue(app_dir.path()).is_empty(), "a reachable purge must not also queue");
    }

    #[test]
    fn purge_uids_queues_when_configured_but_unreachable() {
        let app_dir = tempfile::tempdir().unwrap();

        let outcome = purge_uids(app_dir.path(), None, Some("unavailable"), "me@example.com", "INBOX", &[7, 8]).unwrap();

        assert_eq!(outcome, PurgeOutcome { removed: 0, queued: 2 });
        let queued = read_purge_queue(app_dir.path());
        assert_eq!(queued.get("me@example.com|INBOX"), Some(&vec![7u32, 8u32]));
    }

    #[test]
    fn purge_uids_is_a_no_op_when_nothing_is_configured() {
        let app_dir = tempfile::tempdir().unwrap();

        let outcome = purge_uids(app_dir.path(), None, Some("not_configured"), "me@example.com", "INBOX", &[9]).unwrap();

        assert_eq!(outcome, PurgeOutcome { removed: 0, queued: 0 });
        assert!(read_purge_queue(app_dir.path()).is_empty(), "no backup configured at all is not a queue-worthy event");
    }

    #[test]
    fn purge_uids_fails_closed_to_not_configured_when_the_caller_omits_the_status() {
        // A caller that forgets to pass `external_status` must not have its
        // omission read as "configured but unreachable" — that would queue a
        // purge for a user with no backup drive at all.
        let app_dir = tempfile::tempdir().unwrap();

        let outcome = purge_uids(app_dir.path(), None, None, "me@example.com", "INBOX", &[9]).unwrap();

        assert_eq!(outcome, PurgeOutcome { removed: 0, queued: 0 });
        assert!(read_purge_queue(app_dir.path()).is_empty());
    }

    // ── scan_uids ──────────────────────────────────────────────────────────
    //
    // The task brief's illustrative test called a single-signature
    // `scan_uids(mirror_root: &Path, ...)` and a hypothetical
    // `scan_uids_for_status("not_configured", &[])` helper that doesn't exist
    // in the real code. The actual `scan_uids` takes `mirror_root: Option<&Path>`
    // (see its doc comment for why one `Option` collapses the app's two
    // `None`-returning cases) — these tests exercise that real signature.

    #[test]
    fn scan_uids_is_none_when_no_mirror_root_is_resolved() {
        assert_eq!(scan_uids(None, "a@b.com", "INBOX"), None, "not configured and unreachable both resolve to no root");
    }

    #[test]
    fn scan_uids_is_some_empty_when_the_mirror_is_reachable_but_has_nothing() {
        let mirror_root = tempfile::tempdir().unwrap();
        // Reachable root, but this account/mailbox has no `cur/` at all yet —
        // still a confirmed "nothing mirrored", not an unknown.
        assert_eq!(scan_uids(Some(mirror_root.path()), "a@b.com", "INBOX"), Some(vec![]));
    }

    #[test]
    fn scan_uids_returns_every_mirrored_uid_when_reachable_and_populated() {
        let mirror_root = tempfile::tempdir().unwrap();
        let cur = mirror_root.path().join("a@b.com").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(crate::vault_files::build_maildir_filename(3, &[])), b"x").unwrap();
        std::fs::write(cur.join(crate::vault_files::build_maildir_filename(1, &[])), b"x").unwrap();

        let mut uids = scan_uids(Some(mirror_root.path()), "a@b.com", "INBOX").unwrap();
        uids.sort_unstable();
        assert_eq!(uids, vec![1u32, 3u32], "mirror_file_map is a HashMap — sort before comparing");
    }

    // ── Terminal progress frame (Task 7a) ────────────────────────────────────
    //
    // `run_graph_account` cannot be driven end-to-end in a unit test: it
    // calls `GraphClient::new(access_token)` directly and makes real HTTP
    // calls — no injected trait seam, the same real-code constraint the
    // "Graph resume checkpoint" tests below already ran into for Task 2 (see
    // that section's own comment). What both twins actually share, and what
    // this task's fix is really about, is `terminal_backup_progress`: the one
    // function that builds their identical terminal (`active: false`) frame.
    // These tests exercise it directly. The surrounding code changes
    // (asserted by inspection, not by a test that can't exist without a live
    // GraphClient) make calling it from `run_graph_account` unconditional —
    // once after the folder loop ends, for any reason: normal completion,
    // the cancel-`break` at the top of the loop, the cancel-`break` after a
    // folder finishes, or a zero-folder account that never runs an
    // iteration. Before this fix, Graph had no call to it at all.
    #[test]
    fn terminal_backup_progress_reports_cancelled_with_no_external_failures() {
        let progress = terminal_backup_progress("acct-1", true, 5, 2, 10, 1, 0, None);
        assert!(!progress.active, "the terminal frame is always the one that flips active off");
        assert!(progress.cancelled);
        assert!(!progress.success, "a cancelled run is not a successful one");
        assert_eq!(progress.folder, "Cancelled");
        assert!(progress.external_copy_ok, "no external failures means ok stays true");
        assert!(progress.external_copy_error.is_none());
        assert_eq!(progress.external_copy_failed_count, 0);
        assert_eq!(progress.total_emails, 11);
        assert_eq!(progress.completed_emails, 10);
        assert_eq!(progress.errors, 1);
    }

    /// Task 7b: the frame is the only path `BackupResult::error_message` has
    /// to the user now that the daemon drops the run's result — a Gmail
    /// bandwidth stop and `partial_error_message`'s "N of M could not be
    /// fetched" both ride here, on `last_error`. Task 7a hardcoded it `None`.
    #[test]
    fn terminal_backup_progress_carries_the_runs_error_message() {
        let why = "Daily download limit reached for this provider.".to_string();
        let progress = terminal_backup_progress("acct-1", true, 5, 2, 10, 0, 0, Some(why.clone()));
        assert_eq!(progress.last_error.as_deref(), Some(why.as_str()));

        let clean = terminal_backup_progress("acct-1", false, 5, 5, 10, 0, 0, None);
        assert!(clean.last_error.is_none(), "a run with nothing to report carries no message");
        assert!(clean.success);
    }

    #[test]
    fn terminal_backup_progress_reports_completion_and_external_failures() {
        let progress = terminal_backup_progress("acct-1", false, 5, 5, 20, 0, 3, None);
        assert!(!progress.active);
        assert!(!progress.cancelled);
        assert!(progress.success, "an external-copy failure is a degraded run, not a failed one");
        assert_eq!(progress.folder, "Complete");
        assert!(!progress.external_copy_ok);
        assert_eq!(progress.external_copy_failed_count, 3);
        assert_eq!(progress.external_copy_error.as_deref(), Some("3 emails failed to copy to external backup"));
    }

    // ── Graph resume checkpoint ──────────────────────────────────────────────
    //
    // The task brief's illustrative test called `run_graph_account(ctx)`
    // directly and read a `result.folder_checkpoints` map off `BackupResult`.
    // Neither exists in the real code: `run_graph_account` needs a live
    // `GraphClient` (network calls, no injected trait seam — matching how
    // `handlers/graph.rs`'s own routes construct one per call rather than
    // through a mockable interface), and `BackupResult.completed_folders` is
    // a single resume-position `usize` from Task 1, not a per-folder map.
    // These tests exercise the actual clamp logic
    // (`graph_completed_folders_checkpoint`, extracted from
    // `run_graph_backup_inner`'s final `BackupResult` build) that implements
    // the brief's real intent: a folder the ledger refused must not be
    // skipped by a resumed run, matching `backup.rs:1394-1397`'s behavior
    // today.

    #[test]
    fn graph_completed_folders_checkpoint_stops_at_the_refused_folder_when_cancelled() {
        let refused = (2usize, "Refused Folder was not backed up: ledger busy".to_string());
        let checkpoint = graph_completed_folders_checkpoint(5, Some(&refused), true);
        assert_eq!(checkpoint, 2, "a resumed run must re-scan the refused folder, not skip past it");
    }

    #[test]
    fn graph_completed_folders_checkpoint_is_unclamped_when_the_run_was_not_cancelled() {
        // A run that reached the end of its folder loop already moved past
        // the refused folder on its own — `completed_folders` counts it like
        // any other and nothing here should claw it back.
        let refused = (2usize, "Refused Folder was not backed up: ledger busy".to_string());
        let checkpoint = graph_completed_folders_checkpoint(5, Some(&refused), false);
        assert_eq!(checkpoint, 5);
    }

    #[test]
    fn graph_completed_folders_checkpoint_passes_through_with_no_refused_folder() {
        assert_eq!(graph_completed_folders_checkpoint(5, None, true), 5);
        assert_eq!(graph_completed_folders_checkpoint(5, None, false), 5);
    }

    #[test]
    fn parallel_checkpoint_stops_before_the_first_incomplete_folder() {
        assert_eq!(contiguous_completed_checkpoint(4, &[true, true, false, true, true]), 6);
        assert_eq!(contiguous_completed_checkpoint(4, &[true, true, true]), 7);
    }

    // ── sync_locations / scan_external_uids / purge_backup_files /
    //    partial_error_message (Task 5 carry-over) ───────────────────────────
    //
    // These cases came over verbatim (paths and helper spellings aside) from
    // `src-tauri/src/backup.rs`'s own test modules when Task 5 deleted the
    // app-side runners: Tasks 1-3 ported the *functions* but not all of their
    // coverage, and these are the hard-won invariants — flags surviving both
    // directions of the mirror sync, a uid prefix (`1010` vs `101`) not being
    // purged by accident, and a partial run explaining itself instead of
    // saying "Unknown error".

    fn eml(message_id: &str) -> Vec<u8> {
        format!("From: a@b.test\r\nSubject: s\r\nMessage-ID: <{}>\r\n\r\nbody\r\n", message_id).into_bytes()
    }

    /// Flags must survive both directions of the vault ↔ mirror sync, and
    /// legacy flagless `<uid>.eml` backups must still restore — carrying `A`,
    /// because the restored copy is a vault copy: without it the row never
    /// appears in the list and Clear cached emails deletes the file.
    #[test]
    fn sync_locations_preserves_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("app");
        let ext = tmp.path().join("ext");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&ext).unwrap();

        std::fs::write(app.join("101:2,SF.eml"), b"seen+flagged").unwrap();
        std::fs::write(ext.join("202:2,S.eml"), b"seen").unwrap();
        std::fs::write(ext.join("303.eml"), b"legacy").unwrap();

        assert_eq!(sync_locations(&app, &ext).0, 3);

        assert!(ext.join("101:2,SF.eml").exists(), "flags lost vault → mirror");
        assert!(app.join("202:2,AS.eml").exists(), "flags lost mirror → vault");
        assert!(app.join("303:2,A.eml").exists(), "legacy backup did not restore");

        // Second pass must be a no-op — no duplicates under either naming scheme.
        assert_eq!(sync_locations(&app, &ext).0, 0);
    }

    /// The mirror keeps a message under the uid the PREVIOUS generation gave it.
    /// Once `repair_generation` has set that message aside, the restore
    /// direction must not hand it back — otherwise every backup run undoes the
    /// repair, and `.uidvalidity` already matches so nothing re-checks.
    #[test]
    fn sync_locations_does_not_resurrect_orphans() {
        let tmp = tempfile::tempdir().unwrap();
        let mailbox = tmp.path().join("INBOX");
        let app = mailbox.join("cur");
        let orphaned = mailbox.join(crate::maildir::ORPHAN_DIR);
        let ext = tmp.path().join("ext");
        for dir in [&app, &orphaned, &ext] {
            std::fs::create_dir_all(dir).unwrap();
        }

        // The repair read this message, found no uid for it on the current
        // server, and moved it aside.
        std::fs::write(orphaned.join("4:2,.eml"), eml("strictseal@old-host.test")).unwrap();
        // The mirror still holds the same message under the same old uid.
        std::fs::write(ext.join("4:2,.eml"), eml("strictseal@old-host.test")).unwrap();
        // ...and a genuinely missing message the restore SHOULD bring back.
        std::fs::write(ext.join("7:2,S.eml"), eml("still-on-this-server@mock.test")).unwrap();

        assert_eq!(sync_locations(&app, &ext).0, 1, "exactly one file should restore");

        assert!(
            crate::vault_eml::find_file_by_uid(&app, 4).is_none(),
            "an orphaned message came back into cur/ under its old uid"
        );
        assert!(crate::vault_eml::find_file_by_uid(&app, 7).is_some(), "a legitimate restore was blocked");
    }

    /// A mirror file with no Message-ID cannot be shown to be an orphan, and
    /// absence of proof is not proof — it still restores.
    #[test]
    fn sync_locations_restores_a_file_with_no_message_id() {
        let tmp = tempfile::tempdir().unwrap();
        let mailbox = tmp.path().join("INBOX");
        let app = mailbox.join("cur");
        let orphaned = mailbox.join(crate::maildir::ORPHAN_DIR);
        let ext = tmp.path().join("ext");
        for dir in [&app, &orphaned, &ext] {
            std::fs::create_dir_all(dir).unwrap();
        }

        std::fs::write(orphaned.join("4:2,.eml"), eml("set-aside@old-host.test")).unwrap();
        std::fs::write(ext.join("9:2,.eml"), b"From: a@b.test\r\nSubject: no id\r\n\r\nbody".to_vec()).unwrap();

        assert_eq!(sync_locations(&app, &ext).0, 1);
        assert!(crate::vault_eml::find_file_by_uid(&app, 9).is_some());
    }

    /// With no `orphaned/` dir at all — a vault that has never been repaired —
    /// the guard costs nothing and blocks nothing.
    #[test]
    fn sync_locations_restores_when_nothing_was_ever_orphaned() {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("INBOX").join("cur");
        let ext = tmp.path().join("ext");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&ext).unwrap();

        std::fs::write(ext.join("11:2,S.eml"), eml("fresh@mock.test")).unwrap();

        assert_eq!(sync_locations(&app, &ext).0, 1);
        assert!(crate::vault_eml::find_file_by_uid(&app, 11).is_some());
    }

    /// The mirror scanner must recognise every filename shape the mirror has
    /// carried — `<uid>:2,<flags>.eml`, `<uid>.eml`, `<uid>_<flags>.eml` —
    /// or a backed-up message renders as "not backed up".
    #[test]
    fn scan_external_uids_reads_every_filename_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path().join("luke@mock.test").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join("11:2,S.eml"), b"a").unwrap();
        std::fs::write(cur.join("12.eml"), b"b").unwrap();
        std::fs::write(cur.join("13_S.eml"), b"c").unwrap();
        std::fs::write(cur.join("not-a-uid.eml"), b"d").unwrap();

        let uids = scan_external_uids(tmp.path(), "luke@mock.test", "INBOX");
        assert_eq!(uids.len(), 3);
        for uid in [11u32, 12, 13] {
            assert!(uids.contains(&uid), "missing uid {}", uid);
        }

        // A mailbox with no mirror directory is empty, not an error.
        assert!(scan_external_uids(tmp.path(), "luke@mock.test", "Sent").is_empty());
    }

    /// `sync_locations` before its one-pass listings, verbatim but for paths:
    /// a directory rescan per file in both directions. Kept as a reference for
    /// the UID RULES, not for the flags — it carries the same `archived` push
    /// the restore does, so the equivalence below still says something about
    /// which files move rather than what they are called.
    fn sync_locations_per_uid(vault_cur_dir: &Path, backup_dir: &Path) -> usize {
        use std::fs;
        // The per-uid mirror lookup the one-pass listings replaced (was
        // `src-tauri/src/main.rs`'s test-only `find_msg_file_by_uid`): one
        // directory rescan per call, either naming scheme.
        fn find_msg_file_by_uid(dir: &Path, uid: u32) -> Option<PathBuf> {
            for entry in fs::read_dir(dir).ok()?.flatten() {
                if crate::maildir::mirror_filename_uid(&entry.file_name().to_string_lossy()) == Some(uid) {
                    return Some(entry.path());
                }
            }
            None
        }
        let mut synced = 0;
        let _ = fs::create_dir_all(vault_cur_dir);
        if fs::create_dir_all(backup_dir).is_err() {
            return 0;
        }
        if let Ok(entries) = fs::read_dir(vault_cur_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() { continue; }
                let name = entry.file_name().to_string_lossy().to_string();
                let uid_str = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or(&name);
                let uid: u32 = match uid_str.parse() { Ok(u) => u, Err(_) => continue };
                if find_msg_file_by_uid(backup_dir, uid).is_some() { continue; }
                let dst_name = if name.ends_with(".eml") { name.clone() } else { format!("{}.eml", name) };
                if fs::copy(entry.path(), backup_dir.join(&dst_name)).is_ok() { synced += 1; }
            }
        }
        let mut orphaned_ids: Option<HashSet<String>> = None;
        if let Ok(entries) = fs::read_dir(backup_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() { continue; }
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".eml") { continue; }
                let uid_str = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or(&name);
                let uid: u32 = match uid_str.parse() { Ok(u) => u, Err(_) => continue };
                if crate::vault_eml::find_file_by_uid(vault_cur_dir, uid).is_some() { continue; }
                let ids = orphaned_ids.get_or_insert_with(|| orphaned_message_ids(vault_cur_dir));
                if !ids.is_empty() {
                    if let Some(id) = crate::maildir::read_message_id(&entry.path()) {
                        if ids.contains(&id) { continue; }
                    }
                }
                let mut flags = crate::vault_eml::parse_flags_from_filename(&name);
                flags.push("archived".to_string());
                let dst = vault_cur_dir.join(crate::vault_files::build_maildir_filename(uid, &flags));
                if fs::copy(entry.path(), &dst).is_ok() { synced += 1; }
            }
        }
        synced
    }

    /// Every name shape either side has held, and the edges each direction's
    /// uid rule draws: the vault side matches `<uid>:` exactly, the mirror
    /// side takes whatever precedes the first ':', '.' or '_'.
    fn seed_presync(base: &Path) -> (PathBuf, PathBuf) {
        use std::fs;
        let mailbox = base.join("INBOX");
        let app = mailbox.join("cur");
        let orphaned = mailbox.join(crate::maildir::ORPHAN_DIR);
        let ext = base.join("ext");
        for dir in [&app, &orphaned, &ext] {
            fs::create_dir_all(dir).unwrap();
        }
        for name in [
            "101:2,SF.eml", // vault only: mirrored under its own name
            "102:2,S",      // vault only, no extension: mirrored as .eml
            "103_S.eml",    // legacy name in the vault: mirrored, then restored as 103:2,A.eml
            "104:2,S.eml",  // mirror holds 104.eml: nothing moves
            "105:2,F.eml",  // mirror holds 105_S.eml: nothing moves
            "07:2,S.eml",   // mirror side reads 7, vault side does not
            "300:2,S.eml",  // the mirror's directory named 300.eml counts as a copy
            "notes.txt",
            "_meta.json",
        ] {
            fs::write(app.join(name), format!("app {}", name)).unwrap();
        }
        fs::create_dir_all(app.join("400")).unwrap();
        for name in [
            "202:2,S.eml", // mirror only: restored with its flags, plus archived
            "203.eml",     // legacy flagless: restored as 203:2,A.eml
            "204_S.eml",   // legacy underscore: restored, flags not parsed
            "205:2,F",     // no .eml: never restored
            "08.eml",      // restored as 8:2,A.eml
            "104.eml",
            "105_S.eml",
            "7:2,S.eml", // the vault's 07:2,S.eml is not uid 7: restored
            ".4711:2,S.eml.tmp-1",
        ] {
            fs::write(ext.join(name), format!("ext {}", name)).unwrap();
        }
        fs::create_dir_all(ext.join("300.eml")).unwrap();
        fs::write(ext.join("206.eml"), eml("set-aside@old-host.test")).unwrap();
        fs::write(orphaned.join("206:2,.eml"), eml("set-aside@old-host.test")).unwrap();
        fs::write(ext.join("207.eml"), b"From: a@b.test\r\nSubject: no id\r\n\r\nbody".to_vec()).unwrap();
        (app, ext)
    }

    fn listing(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| {
                let bytes = if e.path().is_dir() { b"<dir>".to_vec() } else { std::fs::read(e.path()).unwrap() };
                (e.file_name().to_string_lossy().to_string(), bytes)
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn sync_locations_matches_the_per_uid_version_on_every_name_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let (old_app, old_ext) = seed_presync(&tmp.path().join("old"));
        let (new_app, new_ext) = seed_presync(&tmp.path().join("new"));

        for pass in ["first", "second"] {
            let old = sync_locations_per_uid(&old_app, &old_ext);
            let new = sync_locations(&new_app, &new_ext).0;
            assert_eq!(new, old, "{pass} pass synced a different count");
            assert_eq!(listing(&new_app), listing(&old_app), "{pass} pass: vault side differs");
            assert_eq!(listing(&new_ext), listing(&old_ext), "{pass} pass: mirror side differs");
        }

        // The fixture has to reach the paths it claims to, or agreement is vacuous.
        let app_names: Vec<String> = listing(&new_app).into_iter().map(|(n, _)| n).collect();
        let ext_names: Vec<String> = listing(&new_ext).into_iter().map(|(n, _)| n).collect();
        for name in ["202:2,AS.eml", "203:2,A.eml", "204:2,A.eml", "8:2,A.eml", "7:2,AS.eml", "103:2,A.eml", "207:2,A.eml"] {
            assert!(app_names.contains(&name.to_string()), "not restored: {name} in {app_names:?}");
        }
        for name in [
            "206:2,.eml", "205:2,F.eml", "205:2,.eml", "104:2,.eml", "105:2,.eml",
            "206:2,A.eml", "205:2,AF.eml", "104:2,A.eml", "105:2,A.eml",
        ] {
            assert!(!app_names.contains(&name.to_string()), "restored but should not be: {name}");
        }
        for name in ["101:2,SF.eml", "102:2,S.eml", "103_S.eml"] {
            assert!(ext_names.contains(&name.to_string()), "not mirrored: {name} in {ext_names:?}");
        }
        for name in ["104:2,S.eml", "105:2,F.eml", "07:2,S.eml", "300:2,S.eml"] {
            assert!(!ext_names.contains(&name.to_string()), "mirrored but should not be: {name}");
        }
    }

    /// Two files for one uid on one side: the first copy has to count for the
    /// second, as the per-uid rescan found the file it had just copied.
    #[test]
    fn sync_locations_copies_one_file_per_uid_when_a_side_holds_two() {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("INBOX").join("cur");
        let ext = tmp.path().join("ext");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(app.join("209:2,S.eml"), b"a").unwrap();
        std::fs::write(app.join("209_S.eml"), b"b").unwrap();
        std::fs::write(ext.join("208.eml"), b"c").unwrap();
        std::fs::write(ext.join("208:2,S.eml"), b"d").unwrap();

        assert_eq!(sync_locations(&app, &ext).0, 2);

        let count = |dir: &Path, uid: u32| {
            std::fs::read_dir(dir)
                .unwrap()
                .flatten()
                .filter(|e| crate::maildir::mirror_filename_uid(&e.file_name().to_string_lossy()) == Some(uid))
                .count()
        };
        assert_eq!(count(&ext, 209), 1, "both vault files for uid 209 were mirrored");
        assert_eq!(count(&app, 208), 1, "both mirror files for uid 208 were restored");
        assert_eq!(sync_locations(&app, &ext).0, 0);
    }

    /// No mirror, nothing to pre-sync: the vault as it stands, and a folder
    /// nothing was ever stored into is empty rather than an error.
    #[test]
    fn vault_uids_after_presync_without_a_mirror_reads_the_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("INBOX").join("cur");
        let (_app, reg) = test_registry(tmp.path());
        assert!(vault_uids_after_presync(&reg, "acct", "INBOX", &app, None).unwrap().is_empty());

        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("5:2,S.eml"), eml("in-the-vault@mock.test")).unwrap();
        assert_eq!(vault_uids_after_presync(&reg, "acct", "INBOX", &app, None).unwrap(), HashSet::from([5]));
    }

    /// A registry for the vault at `root`, its file in a tempdir of its own.
    fn test_registry(root: &Path) -> (tempfile::TempDir, VaultRegistry) {
        let app = tempfile::tempdir().unwrap();
        let reg = VaultRegistry::open(app.path(), root);
        (app, reg)
    }

    /// The pre-sync's restore into the vault is a raw copy outside the
    /// registry's lock: it invalidates the folder, so the next read lists the
    /// restored uid. Copies the other way touch only the mirror and leave the
    /// folder verified.
    #[test]
    fn a_presync_restore_makes_the_registry_list_the_folder_again_and_a_mirror_copy_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = test_registry(root);
        let cur = crate::vault_files::cur_path(root, "acct", "INBOX");
        let mirror = root.join("mirror").join("me@mock.test").join("INBOX").join("cur");
        std::fs::create_dir_all(&mirror).unwrap();
        write_vault_file(&mirror, 42, &[]);
        assert_eq!(reg.uid_sets(root, "acct", "INBOX"), Some((vec![], vec![])));

        vault_uids_after_presync(&reg, "acct", "INBOX", &cur, Some(&mirror)).unwrap();
        assert_eq!(reg.uid_sets(root, "acct", "INBOX"), Some((vec![42], vec![42])), "restored copies carry `A`");
        assert_eq!(reg.listing_count(), 2);

        crate::vault_files::store(&reg, root, "acct", "INBOX", 7, b"seven", &[], true).unwrap();
        vault_uids_after_presync(&reg, "acct", "INBOX", &cur, Some(&mirror)).unwrap();
        assert!(mirror.join("7:2,.eml").exists(), "the vault-only uid went to the mirror");
        assert_eq!(reg.uid_sets(root, "acct", "INBOX"), Some((vec![7, 42], vec![42])));
        assert_eq!(reg.listing_count(), 2, "a mirror-only copy leaves the folder verified");
    }

    fn seed_mirror(root: &Path, email: &str, mailbox: &str, names: &[&str]) {
        let cur = root.join(email).join(mailbox).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        for n in names {
            std::fs::write(cur.join(n), b"x").unwrap();
        }
    }

    #[test]
    fn purge_backup_files_removes_every_legacy_filename_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // The three shapes the mirror has carried over its lifetime.
        seed_mirror(root, "me@x.test", "INBOX.Spam", &["101:2,S.eml", "102.eml", "103_S.eml", "104:2,S.eml", "1010:2,S.eml"]);

        let uids: HashSet<u32> = [101u32, 102, 103].into_iter().collect();
        let removed = purge_backup_files(root, "me@x.test", "INBOX.Spam", &uids);

        let cur = root.join("me@x.test").join("INBOX.Spam").join("cur");
        assert_eq!(removed, 3);
        assert!(!cur.join("101:2,S.eml").exists());
        assert!(!cur.join("102.eml").exists());
        assert!(!cur.join("103_S.eml").exists());
        assert!(cur.join("104:2,S.eml").exists());
        assert!(cur.join("1010:2,S.eml").exists(), "1010 must survive a purge of 101");
    }

    #[test]
    fn purge_backup_files_on_a_missing_mirror_dir_removes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let uids: HashSet<u32> = [1u32].into_iter().collect();
        assert_eq!(purge_backup_files(tmp.path(), "me@x.test", "INBOX", &uids), 0);
    }

    #[test]
    fn queue_purge_appends_and_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let dd = tmp.path();

        queue_purge(dd, "me@x.test", "INBOX.Spam", &[1, 2]).unwrap();
        queue_purge(dd, "me@x.test", "INBOX.Spam", &[2, 3]).unwrap();
        queue_purge(dd, "me@x.test", "INBOX", &[9]).unwrap();

        let q = read_purge_queue(dd);
        assert_eq!(q.get("me@x.test|INBOX.Spam").unwrap(), &vec![1, 2, 3]);
        assert_eq!(q.get("me@x.test|INBOX").unwrap(), &vec![9]);
    }

    #[test]
    fn a_corrupt_legacy_queue_file_reads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("pending_backup_purge.json"), b"{ not json").unwrap();
        assert!(read_purge_queue(tmp.path()).is_empty());
    }

    #[test]
    fn drain_of_empty_queue_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(drain_purge_queue(tmp.path(), tmp.path()), 0);
    }

    #[test]
    fn drain_drops_malformed_key_but_still_drains_valid_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dd = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        std::fs::create_dir_all(&dd).unwrap();
        seed_mirror(&root, "me@x.test", "INBOX", &["4:2,S.eml"]);

        let mut q: std::collections::BTreeMap<String, Vec<u32>> = Default::default();
        q.insert("malformed-no-pipe".to_string(), vec![1, 2]);
        q.insert("me@x.test|INBOX".to_string(), vec![4]);
        write_purge_queue(&dd, &q).unwrap();

        let removed = drain_purge_queue(&dd, &root);

        assert_eq!(removed, 1, "the well-formed entry must still drain");
        assert!(!root.join("me@x.test").join("INBOX").join("cur").join("4:2,S.eml").exists());
        assert!(
            !read_purge_queue(&dd).contains_key("malformed-no-pipe"),
            "a key with no '|' separator must be dropped, not left queued forever"
        );
    }

    // ── partial_error_message ────────────────────────────────────────────────

    #[test]
    fn partial_error_message_with_no_errors_says_nothing() {
        assert_eq!(partial_error_message(0, 788, None), None);
    }

    /// The 2026-08-27 report: 788 of 789 saved, and the notification said
    /// "Backup failed - Unknown error" because this string was `None`.
    #[test]
    fn partial_error_message_names_the_count_and_the_server() {
        let msg = partial_error_message(1, 788, Some("IMAP fetch failed: UID FETCH 799 failed"))
            .expect("a run with errors must explain itself");
        assert!(msg.contains("1 of 789 messages"), "got {msg}");
        assert!(msg.contains("UID FETCH 799 failed"), "got {msg}");
    }

    #[test]
    fn partial_error_message_falls_back_to_the_count_when_the_error_is_blank() {
        assert_eq!(partial_error_message(2, 0, Some("   ")).unwrap(), "2 of 2 messages could not be fetched.");
    }

    #[test]
    fn partial_error_message_is_singular_when_one_message_was_attempted() {
        assert_eq!(partial_error_message(1, 0, None).unwrap(), "1 of 1 message could not be fetched.");
    }
}
