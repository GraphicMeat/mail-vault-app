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
//! What did NOT move here: `AccountBackupStatus`/`FolderBackupStatus` (the
//! compare-with-server status view), `resolve_backup_path`/`release_backup_path`
//! (bookmark resolution — a Rust/platform-integration concern that stays with
//! `external_location.rs`), and `backup_purge_uids`. All out of scope for this
//! task; `run_imap_account`'s name says which provider it covers.
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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tracing::{info, warn};

use crate::archive::{self, ArchiveCtx};
use crate::imap::{self, ImapConfig, ImapPool};
use crate::vault_flags::{Applied, FlagChange};

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
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;
    let mut total_ext_failures = 0usize;
    // The server's words for the last message that could not be fetched. A
    // count alone leaves the user with "something failed" and nowhere to look.
    let mut last_message_error: Option<String> = None;

    info!("backup: starting for {} ({} selectable folders)", account.email, total_folders);

    let mut cancelled = false;
    let mut bandwidth_limited = false;

    for (folder_idx, mbox) in selectable.iter().enumerate() {
        if ctx.cancel.load(Ordering::Relaxed) {
            warn!("backup: cancelled for {} at folder {}/{}", account.email, completed_folders, total_folders);
            cancelled = true;
            break;
        }

        // Skip folders already completed in a previous run (resume support)
        if folder_idx < ctx.skip_folders {
            completed_folders += 1;
            continue;
        }

        let mailbox_path = &mbox.path;

        // Every 5 folders, drop pooled sessions to force re-auth on next use.
        // This prevents OAuth2 token expiry during long backups (tokens last ~1 hour).
        if folder_idx > 0 && folder_idx % 5 == 0 {
            pool.clear_background(account).await;
            info!("backup: cleared pool sessions at folder {} to refresh auth", folder_idx);
        }

        // Get server UIDs. Neither SEARCH variant is safe here: ESEARCH and the
        // one-long-line `* SEARCH` reply both hit parser limits on large
        // mailboxes, and a corrupted session makes every later command return 0
        // results — search_all_uids uses UID FETCH instead. Still discard the
        // session if it fails, so nothing inherits a dirty read buffer.
        let server_flags = {
            let mut guard = pool.get_background(account).await?;
            // Generous: a 1:* listing of a 40k folder is a big response. Bounded
            // all the same — a session the server dropped answers no faster than
            // never, and the discard path below is exactly what should happen.
            let result = imap::bounded(
                &format!("UID FETCH 1:* {}", mailbox_path),
                600,
                imap::search_all_uid_flags(&mut guard.session, mailbox_path),
            )
            .await;
            match &result {
                Ok(_) => pool.return_background(account, guard).await,
                Err(_) => pool.discard(account, guard).await,
            }
            result?
        };
        let server_uids: Vec<u32> = server_flags.iter().map(|(uid, _)| *uid).collect();

        // Get local UIDs, after the pre-sync with the mirror (see
        // vault_uids_after_presync). Directory scans and file copies, some on
        // an external drive: a read_dir of a folder on a drive another process
        // is hammering can stall for seconds, and on a runtime worker that
        // stall is paid by every IMAP socket the runtime is meant to be polling.
        let local_uids = {
            let vault_cur_dir = crate::vault_files::cur_path(&ctx.archive_ctx.root, account_id, mailbox_path);
            let mirror_dir = ctx.mirror_root.as_ref().map(|root| {
                std::path::PathBuf::from(root).join(&account.email).join(mailbox_path).join("cur")
            });
            tokio::task::spawn_blocking(move || vault_uids_after_presync(&vault_cur_dir, mirror_dir.as_deref()))
                .await
                .map_err(|e| format!("pre-sync panicked: {}", e))??
        };

        // Compute delta
        let missing: Vec<u32> = server_uids.iter().filter(|uid| !local_uids.contains(uid)).copied().collect();

        info!(
            "backup: {} — server={} uids, local={} uids, missing={} to back up",
            mailbox_path,
            server_uids.len(),
            local_uids.len(),
            missing.len()
        );

        // Only emit progress at 25%, 50%, 75% and completion — not every folder
        // This prevents flooding the JS event loop with re-renders
        let progress_pct = if total_folders > 0 { (folder_idx * 100) / total_folders } else { 0 };
        let should_emit = folder_idx == 0 || progress_pct % 25 == 0 || !missing.is_empty();
        if should_emit {
            (ctx.on_progress)(BackupProgress {
                account_id: account_id.clone(),
                folder: mailbox_path.clone(),
                total_folders,
                completed_folders,
                total_emails: total_backed_up + total_errors,
                completed_emails: total_backed_up,
                errors: total_errors,
                active: true,
                last_error: None,
                missing_in_folder: missing.len(),
            });
        }

        if !missing.is_empty() {
            // Fetch and store to BOTH the vault and the mirror simultaneously
            let archive_result = archive::run_with_backup(
                Arc::clone(&ctx.archive_ctx),
                account_id.clone(),
                ctx.account_json.clone(),
                mailbox_path.clone(),
                missing,
                Arc::clone(&ctx.cancel),
                ctx.mirror_root.clone(),
                Some(account.email.clone()),
                false,
                "backup",
            )
            .await?;

            total_backed_up += archive_result.completed;
            total_errors += archive_result.errors;
            total_ext_failures += archive_result.external_copy_failures;
            if archive_result.errors > 0 && !archive_result.bandwidth_limited {
                if let Some(ref e) = archive_result.last_error {
                    last_message_error = Some(e.clone());
                }
            }
            if archive_result.bandwidth_limited {
                // archive already set the shared cancel flag — the folder loop
                // breaks on the next iteration and the checkpoint allows resume
                bandwidth_limited = true;
            }
        }

        // The top-of-loop check only catches a cancel that landed between
        // folders. One that landed mid-folder used to fall through to
        // `completed_folders += 1`, and the checkpoint then told the next run to
        // skip a folder it had half finished. The bandwidth-limit stop sets
        // this same flag, so it re-scans its partial folder too.
        if ctx.cancel.load(Ordering::Relaxed) {
            warn!(
                "backup: cancelled for {} inside {} ({}/{} folders done)",
                account.email, mailbox_path, completed_folders, total_folders
            );
            cancelled = true;
            break;
        }

        // A copy that predates a change made on the server — read on the
        // phone, starred elsewhere — carries the state it was stored with, and
        // that state is what restore uploads and the mirror keeps. The listing
        // above already has every flag, so catching up is one directory pass
        // with nothing more to fetch. Only the copies that were already here,
        // restored ones included (a legacy `<uid>.eml` comes back flagless):
        // the ones just stored carry the server's flags already. Every copy the
        // run counts as backed up is marked archived here, which is what heals
        // an auto-cached `<uid>:2,.eml` once a backup vouches for it.
        let changes = catch_up_changes(&server_flags, &local_uids);
        if !changes.is_empty() {
            // In-process now (backup.rs:850-886's daemon RPC bridge is gone):
            // the injected closure is `handlers::vault_flags::apply_flags`
            // itself on the daemon side. Still off the runtime worker — that
            // function takes `with_vault_write`'s gate, which must never be
            // held across a tokio `.await`. A closure failure here (unlike a
            // panic in the blocking task itself) must not abort this
            // account's folder loop — see `map_flag_catchup_outcome`.
            let apply_flags = Arc::clone(&ctx.apply_flags);
            let (mbx, chgs) = (mailbox_path.clone(), changes);
            let outcome: Result<Applied, String> =
                tokio::task::spawn_blocking(move || (apply_flags)(&mbx, &chgs)).await.map_err(|e| format!("flag catch-up panicked: {}", e))?;
            let applied = map_flag_catchup_outcome(outcome, account_id, mailbox_path);
            if applied.total() > 0 {
                info!(
                    "backup: {} — read state caught up on {} vault files, {} mirror files, {} custody entries",
                    mailbox_path, applied.renamed, applied.mirrored, applied.index_patched
                );
            }
        }

        completed_folders += 1;
    }

    // Emit final completion/cancelled event (single event per account)
    (ctx.on_progress)(BackupProgress {
        account_id: account_id.clone(),
        folder: if cancelled { "Cancelled".to_string() } else { "Complete".to_string() },
        total_folders,
        completed_folders,
        total_emails: total_backed_up + total_errors,
        completed_emails: total_backed_up,
        errors: total_errors,
        active: false,
        last_error: None,
        missing_in_folder: 0,
    });

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
        error_message: if bandwidth_limited {
            Some("Daily download limit reached for this provider. Backup stopped — it will pick up where it left off after the limit resets (usually within 1 hour, up to 24 hours).".to_string())
        } else {
            partial_error_message(total_errors, total_backed_up, last_message_error.as_deref())
        },
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
            tokio::task::spawn_blocking(move || vault_uids_after_presync(&vault_cur_dir, mirror_dir.as_deref()))
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
                                let mirror_write: Option<Result<(), String>> = tokio::task::spawn_blocking(
                                    move || -> Result<Option<Result<(), String>>, String> {
                                        let mut mirror_result: Option<Result<(), String>> = None;
                                        gate(&mut || {
                                            std::fs::create_dir_all(&cur_dir).map_err(|e| format!("mkdir: {}", e))?;
                                            std::fs::write(cur_dir.join(&filename), &raw_bytes)
                                                .map_err(|e| format!("write .eml: {}", e))?;
                                            mirror_result = mirror_to.clone().map(|dir| {
                                                std::fs::create_dir_all(&dir)
                                                    .map_err(|e| format!("external mkdir failed: {}", e))
                                                    .and_then(|()| {
                                                        std::fs::write(dir.join(&filename), &raw_bytes)
                                                            .map_err(|e| format!("external write failed: {}", e))
                                                    })
                                            });
                                            Ok(())
                                        })?;
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

        (ctx.on_progress)(BackupProgress {
            account_id: account_id.clone(),
            folder: mailbox_path,
            total_folders,
            completed_folders,
            total_emails: total_backed_up + total_errors,
            completed_emails: total_backed_up,
            errors: total_errors,
            active: completed_folders < total_folders,
            last_error: None,
            missing_in_folder: 0,
        });
    }

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
        error_message: refused
            .as_ref()
            .map(|(_, why)| why.clone())
            .or_else(|| partial_error_message(total_errors, total_backed_up, last_message_error.as_deref())),
        cancelled,
        // What the scheduler resumes from after a cancel. A folder the
        // ledger refused stored nothing, and a resumed run would skip it.
        completed_folders: graph_completed_folders_checkpoint(completed_folders, refused.as_ref(), cancelled),
        external_copy_ok: total_ext_failures == 0,
        external_copy_error: if total_ext_failures > 0 {
            Some(format!("{} emails failed to copy to external backup", total_ext_failures))
        } else {
            None
        },
        external_copy_failed_count: total_ext_failures,
    })
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

// ── Local/mirror uid scanning ────────────────────────────────────────────────

/// A backup folder's vault uids, counted after the pre-sync with its mirror
/// when there is one. The run fetches every server uid missing from this set.
/// Counted before the pre-sync, a uid only the mirror held was still missing
/// once restored: the fetch downloaded it again and stored the server's copy
/// beside the restored one, under a second name.
fn vault_uids_after_presync(vault_cur_dir: &Path, mirror_dir: Option<&Path>) -> Result<HashSet<u32>, String> {
    if let Some(mirror_dir) = mirror_dir {
        let synced = sync_locations(vault_cur_dir, mirror_dir);
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

/// Sync files between the vault Maildir and the backup location (bidirectional).
/// - Vault files missing from backup → copy to backup keeping the Maildir
///   name (`<uid>:2,<flags>.eml`) so flags survive the round trip
/// - Backup files missing from the vault → copy to the vault, named with
///   `archived` on top of whatever flags the backup filename carried (legacy
///   `<uid>.eml` copies carry none): the vault copy the restore makes is what
///   puts the row in the list and what Clear cached emails keeps. Never
///   re-imports a message the generation repair already set aside.
/// Returns total files synced.
fn sync_locations(vault_cur_dir: &Path, backup_dir: &Path) -> usize {
    use crate::maildir::{mirror_file_map, mirror_filename_uid, uid_file_map};
    use std::fs;
    let mut synced = 0;

    // Ensure both dirs exist; if backup dir can't be created (disconnected drive), skip
    let _ = fs::create_dir_all(vault_cur_dir);
    if fs::create_dir_all(backup_dir).is_err() {
        return 0; // Backup location not available — skip sync, backup to the vault only
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
            if fs::copy(entry.path(), &dst).is_ok() {
                synced += 1;
                in_vault.insert(uid);
            }
        }
    }

    synced
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
// Ported from `backup.rs:190-260`; `queue_purge` itself (the writer side, used
// by the app's `backup_purge_uids` command) is not — that command has not
// moved to the daemon in this task.

fn purge_queue_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pending_backup_purge.json")
}

fn read_purge_queue(data_dir: &Path) -> std::collections::BTreeMap<String, Vec<u32>> {
    let path = purge_queue_path(data_dir);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Default::default();
    };
    // A corrupt queue must not brick delete-everywhere; start over rather than error.
    serde_json::from_str(&content).unwrap_or_default()
}

fn write_purge_queue(data_dir: &Path, q: &std::collections::BTreeMap<String, Vec<u32>>) -> Result<(), String> {
    let data = serde_json::to_string(q).map_err(|e| format!("serialize purge queue: {}", e))?;
    std::fs::write(purge_queue_path(data_dir), data).map_err(|e| format!("write purge queue: {}", e))
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

        let uids = vault_uids_after_presync(vault.path(), Some(mirror.path())).unwrap();

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
}
