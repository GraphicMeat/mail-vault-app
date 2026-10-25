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
//! comment (above `run_graph_account`) covers what that port changed. A JMAP
//! account runs `run_jmap_account`, the same shape over the JMAP ledger and
//! blob downloads (its header comment says what differs).
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
use crate::net_activity;
use crate::transfer_limits::BackgroundLimit;
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
    /// Why a run ended early when it was not the user or a failure: today only
    /// [`STOP_LIMIT_REACHED`], the user's daily download limit. Carried on the
    /// terminal frame (with `cancelled: true`, so the app's resume checkpoint
    /// keeps working); absent otherwise. snake_case like every other field of
    /// this frame, whatever the sibling `archive-progress` frame does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<&'static str>,
    /// With `stop_reason`: the daily limit that was spent, in bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_bytes: Option<u64>,
    /// With `stop_reason`: the next UTC midnight, epoch ms. The app runs the
    /// account again after it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_after_ms: Option<u64>,
}

/// `BackupProgress::stop_reason` of a run that stopped at the user's daily
/// download limit.
pub const STOP_LIMIT_REACHED: &str = "limit_reached";

/// Marks a terminal frame as a stop at the daily limit. `cancelled` stays true
/// (the app's checkpoint branch keys off it); `last_error` is left for real
/// errors only, the app words the stop itself from the limit.
fn stopped_at_limit(mut progress: BackupProgress, limit: &BackgroundLimit) -> BackupProgress {
    if let Some(hit) = limit.hit() {
        progress.stop_reason = Some(STOP_LIMIT_REACHED);
        progress.limit_bytes = Some(hit.limit_bytes);
        progress.resume_after_ms = Some(limit.resume_after_ms().max(0) as u64);
        progress.cancelled = true;
        progress.success = false;
    }
    progress
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
        stop_reason: None,
        limit_bytes: None,
        resume_after_ms: None,
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
/// - `account_id`/`account`: the existing archive implementation receives
///   the resolved typed config. `account_json` is a retained compatibility
///   field for older context builders and is not read by these runners.
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
    /// The user's daily download limit for this account, or `None` to run
    /// without one. A backup is background work: it looks at the allowance
    /// before it lists anything and every `check_every` messages after, and
    /// ends the run with a `limit_reached` terminal frame when it is spent.
    /// Build one per run (it remembers what stopped it). IMAP only: Graph
    /// traffic is not wire-counted, so there is nothing to compare.
    pub limit: Option<BackgroundLimit>,
}

// ── Core backup runner ───────────────────────────────────────────────────────

// Shared batch join boundary. The callback keeps successful folder accounting
// in the provider runner while this function owns joining spawned work.
async fn join_backup_batch<T: Send + 'static>(
    tasks: &mut tokio::task::JoinSet<Result<T, String>>,
    cancel: &AtomicBool,
    mut completed: impl FnMut(T),
) -> Result<(), String> {
    let mut first_error = None;
    while let Some(result) = tasks.join_next().await {
        match result
            .map_err(|e| format!("backup folder worker panicked: {e}"))
            .and_then(|r| r)
        {
            Ok(outcome) => completed(outcome),
            Err(error) => {
                cancel.store(true, Ordering::SeqCst);
                first_error.get_or_insert(error);
                // Do not drop or abort the set. Its other folder tasks may be
                // awaiting blocking mirror writes, which abort cannot stop.
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub async fn run_imap_account(ctx: BackupRunContext) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();

    if let Some(ref root) = ctx.mirror_root {
        info!("backup: using external path: {:?}", root);
        // Drain BEFORE any mirroring work — a run that copies first would put
        // back the very files the queue is about to delete.
        drain_purge_queue_blocking(&ctx).await?;
    }
    mirror_local_folders_blocking(&ctx).await;
    mirror_contacts_blocking(&ctx).await;

    // Every IMAP connection this run opens shows as "backup" on Network
    // Activity (the folder workers below are spawned: scoped again there).
    net_activity::with_purpose("backup", run_imap_backup_inner(ctx, start)).await
}

async fn run_imap_backup_inner(
    ctx: BackupRunContext,
    start: std::time::Instant,
) -> Result<BackupResult, String> {
    let pool: &ImapPool = &ctx.archive_ctx.pool;
    let account = &ctx.account;
    let account_id = &ctx.account_id;

    // A day whose allowance is already spent costs no bytes at all: not even
    // the folder LIST. The resume position is the one the caller handed in.
    if let Some(limit) = ctx.limit.as_ref() {
        let spent = {
            let limit = limit.clone();
            tokio::task::spawn_blocking(move || limit.check())
                .await
                .map_err(|e| format!("daily limit check panicked: {e}"))?
        };
        if spent.is_some() {
            info!(
                "backup: {} — daily download limit already spent, not starting",
                account.email
            );
            (ctx.on_progress)(stopped_at_limit(
                terminal_backup_progress(
                    account_id,
                    true,
                    ctx.skip_folders,
                    ctx.skip_folders,
                    0,
                    0,
                    0,
                    None,
                ),
                limit,
            ));
            return Ok(BackupResult {
                emails_backed_up: 0,
                errors: 0,
                duration_secs: start.elapsed().as_secs_f64(),
                success: false,
                error_message: None,
                cancelled: true,
                completed_folders: ctx.skip_folders,
                external_copy_ok: true,
                external_copy_error: None,
                external_copy_failed_count: 0,
            });
        }
    }

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
        all_flat
            .iter()
            .map(|m| format!("{}(noselect={})", m.path, m.noselect))
            .collect::<Vec<_>>()
            .join(", ")
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

    info!(
        "backup: starting for {} ({} selectable folders)",
        account.email, total_folders
    );

    let mut cancelled = false;
    let mut bandwidth_limited = false;

    let work = selectable
        .into_iter()
        .enumerate()
        .skip(completed_folders)
        .map(|(index, mailbox)| (index, mailbox.path.clone()))
        .collect::<Vec<_>>();
    let mut done = vec![false; work.len()];
    for batch in work.chunks(ctx.mailbox_concurrency.clamp(1, 5)) {
        if ctx.cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, mailbox) in batch.iter().cloned() {
            let ctx = ctx.clone();
            tasks.spawn(net_activity::with_purpose("backup", async move {
                backup_imap_folder(ctx, index, mailbox).await
            }));
        }
        join_backup_batch(&mut tasks, &ctx.cancel, |outcome| {
            let slot = outcome.index.saturating_sub(ctx.skip_folders);
            if slot < done.len() {
                done[slot] = outcome.completed;
            }
            total_backed_up += outcome.backed_up;
            total_errors += outcome.errors;
            total_ext_failures += outcome.external_failures;
            bandwidth_limited |= outcome.bandwidth_limited;
            if outcome.last_error.is_some() {
                last_message_error = outcome.last_error;
            }
            completed_folders =
                contiguous_completed_checkpoint(ctx.skip_folders, &done).min(total_folders);
            (ctx.on_progress)(BackupProgress {
                account_id: account_id.clone(),
                folder: outcome.mailbox,
                total_folders,
                completed_folders,
                total_emails: total_backed_up + total_errors,
                completed_emails: total_backed_up,
                errors: total_errors,
                active: true,
                last_error: None,
                missing_in_folder: 0,
                cancelled: false,
                success: true,
                external_copy_ok: total_ext_failures == 0,
                external_copy_error: None,
                external_copy_failed_count: total_ext_failures,
                stop_reason: None,
                limit_bytes: None,
                resume_after_ms: None,
            });
        })
        .await?;
        if ctx.cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
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
    let mut terminal = terminal_backup_progress(
        account_id,
        cancelled,
        total_folders,
        completed_folders,
        total_backed_up,
        total_errors,
        total_ext_failures,
        error_message.clone(),
    );
    // The daily download limit ended this run (its allowance was spent at a
    // check inside a folder): same `cancelled` checkpoint semantics, plus the
    // reason and when to come back.
    let stopped_by_limit = ctx.limit.as_ref().is_some_and(|l| l.hit().is_some());
    if let Some(limit) = ctx.limit.as_ref() {
        terminal = stopped_at_limit(terminal, limit);
    }
    let cancelled = cancelled || stopped_by_limit;
    (ctx.on_progress)(terminal);

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup: {} for {} — {} new emails backed up, {} errors, {:.1}s{} (folders: {}/{})",
        if stopped_by_limit {
            "stopped at the daily limit"
        } else if cancelled {
            "cancelled"
        } else {
            "completed"
        },
        account.email,
        total_backed_up,
        total_errors,
        duration,
        if let Some(ref p) = ctx.mirror_root {
            format!(" (copied to {})", p)
        } else {
            String::new()
        },
        completed_folders,
        total_folders
    );
    if total_ext_failures > 0 {
        warn!(
            "backup: {} external copy failures for {}",
            total_ext_failures, account.email
        );
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
            Some(format!(
                "{} emails failed to copy to external backup",
                total_ext_failures
            ))
        } else {
            None
        },
        external_copy_failed_count: total_ext_failures,
    })
}

/// A backup of exactly `plan`'s uids, folder by folder: Phase 5's "Save them
/// now", for the messages the vault is missing. No LIST, no server listing,
/// no flag catch-up, no mirror or local-folder work, no resume checkpoint: the
/// plan is recomputed on every run. The same per-message step as
/// `run_imap_account` (`archive::run_with_backup`, "backup" operation, on the
/// pool's background lane) and the same `backup-progress` frames: one as each
/// folder starts (`missing_in_folder`: what it will fetch there), then the one
/// terminal frame. `ctx.mirror_root`, `skip_folders`, `mailbox_concurrency`
/// and `apply_flags` are not read.
pub async fn run_imap_uids(
    ctx: BackupRunContext,
    plan: Vec<(String, Vec<u32>)>,
) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();
    net_activity::with_purpose("backup", async move {
        let total_folders = plan.len();
        let (mut completed_folders, mut backed_up, mut errors, mut ext_failures) = (0, 0, 0, 0);
        let (mut bandwidth_stop, mut last_error, mut cancelled) = (None, None, false);
        for (mailbox, uids) in plan {
            if ctx.cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            (ctx.on_progress)(BackupProgress {
                account_id: ctx.account_id.clone(),
                folder: mailbox.clone(),
                total_folders,
                completed_folders,
                total_emails: backed_up + errors,
                completed_emails: backed_up,
                errors,
                active: true,
                last_error: None,
                missing_in_folder: uids.len(),
                cancelled: false,
                success: true,
                external_copy_ok: ext_failures == 0,
                external_copy_error: None,
                external_copy_failed_count: ext_failures,
                stop_reason: None,
                limit_bytes: None,
                resume_after_ms: None,
            });
            let archived = archive::run_with_backup_config(
                Arc::clone(&ctx.archive_ctx),
                ctx.account_id.clone(),
                ctx.account.clone(),
                mailbox,
                uids,
                Arc::clone(&ctx.cancel),
                None,
                None,
                false,
                "backup",
                true,
                // Graph traffic is not wire-counted, so the daily limit does not govern it.
                None,
                None,
            )
            .await?
            .0;
            backed_up += archived.completed;
            errors += archived.errors;
            ext_failures += archived.external_copy_failures;
            // A provider's bandwidth stop sets the cancel flag too, as in
            // `run_imap_account`, and the archive run's `last_error` is then
            // the backup's own words for it: the terminal frame carries them.
            if archived.bandwidth_limited {
                bandwidth_stop = archived.last_error;
            } else if archived.errors > 0 {
                last_error = archived.last_error;
            }
            if ctx.cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            completed_folders += 1;
        }
        let error_message = bandwidth_stop
            .or_else(|| partial_error_message(errors, backed_up, last_error.as_deref()));
        (ctx.on_progress)(terminal_backup_progress(
            &ctx.account_id,
            cancelled,
            total_folders,
            completed_folders,
            backed_up,
            errors,
            ext_failures,
            error_message.clone(),
        ));
        info!(
            "backup(uids): {} for {}: {} saved, {} errors (folders: {}/{})",
            if cancelled { "cancelled" } else { "completed" },
            ctx.account.email,
            backed_up,
            errors,
            completed_folders,
            total_folders
        );
        Ok(BackupResult {
            emails_backed_up: backed_up,
            errors,
            duration_secs: start.elapsed().as_secs_f64(),
            success: !cancelled,
            error_message,
            cancelled,
            completed_folders,
            external_copy_ok: ext_failures == 0,
            external_copy_error: (ext_failures > 0)
                .then(|| format!("{} emails failed to copy to external backup", ext_failures)),
            external_copy_failed_count: ext_failures,
        })
    })
    .await
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

async fn backup_imap_folder(
    ctx: BackupRunContext,
    index: usize,
    mailbox: String,
) -> Result<ImapFolderOutcome, String> {
    let pool = &ctx.archive_ctx.pool;
    let account = &ctx.account;
    if ctx.cancel.load(Ordering::Relaxed) {
        return Ok(ImapFolderOutcome {
            index,
            mailbox,
            completed: false,
            backed_up: 0,
            errors: 0,
            external_failures: 0,
            bandwidth_limited: false,
            last_error: None,
        });
    }
    // The daily limit, before this folder's listing (a 100k-message All Mail
    // is ~4 MB of flags before a single body): a day already spent by the
    // folders before it ends the run here.
    if let Some(limit) = ctx.limit.clone() {
        let spent = tokio::task::spawn_blocking(move || limit.check())
            .await
            .map_err(|e| format!("daily limit check panicked: {e}"))?;
        if spent.is_some() {
            ctx.cancel.store(true, Ordering::Relaxed);
            return Ok(ImapFolderOutcome {
                index,
                mailbox,
                completed: false,
                backed_up: 0,
                errors: 0,
                external_failures: 0,
                bandwidth_limited: false,
                last_error: None,
            });
        }
    }
    let server_flags = {
        let mut guard = pool.get_background(account).await?;
        let result = imap::bounded(
            &format!("UID FETCH 1:* {mailbox}"),
            600,
            imap::search_all_uid_flags(&mut guard.session, &mailbox),
        )
        .await;
        match &result {
            Ok(_) => pool.return_background(account, guard).await,
            Err(_) => pool.discard(account, guard).await,
        }
        result?
    };
    let server_uids = server_flags.iter().map(|(uid, _)| *uid).collect::<Vec<_>>();
    let local_uids = {
        let cur = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(
            &ctx.archive_ctx.root,
            &ctx.account_id,
            &mailbox,
        ));
        let mirror = ctx
            .mirror_root
            .as_ref()
            .map(|root| crate::maildir::mirror_cur(Path::new(root), &account.email, &mailbox))
            .transpose()?;
        let (registry, account_id, mbox) = (
            Arc::clone(&ctx.archive_ctx.registry),
            ctx.account_id.clone(),
            mailbox.clone(),
        );
        let mirror_root = ctx.mirror_root.clone();
        tokio::task::spawn_blocking(move || {
            vault_uids_after_presync_at(
                &registry,
                &account_id,
                &mbox,
                &cur,
                mirror_root.as_deref().map(Path::new),
                mirror.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("pre-sync panicked: {e}"))??
    };
    let missing = server_uids
        .iter()
        .filter(|uid| !local_uids.contains(uid))
        .copied()
        .collect::<Vec<_>>();
    info!(
        "backup: {} — server={} local={} missing={}",
        mailbox,
        server_uids.len(),
        local_uids.len(),
        missing.len()
    );
    let mut out = ImapFolderOutcome {
        index,
        mailbox: mailbox.clone(),
        completed: false,
        backed_up: 0,
        errors: 0,
        external_failures: 0,
        bandwidth_limited: false,
        last_error: None,
    };
    if !missing.is_empty() {
        let archived = archive::run_with_backup_config(
            Arc::clone(&ctx.archive_ctx),
            ctx.account_id.clone(),
            ctx.account.clone(),
            mailbox.clone(),
            missing,
            Arc::clone(&ctx.cancel),
            ctx.mirror_root.clone(),
            Some(account.email.clone()),
            false,
            "backup",
            true,
            ctx.limit.clone(),
            None,
        )
        .await?
        .0;
        out.backed_up = archived.completed;
        out.errors = archived.errors;
        out.external_failures = archived.external_copy_failures;
        out.bandwidth_limited = archived.bandwidth_limited;
        if archived.errors > 0 && !archived.bandwidth_limited {
            out.last_error = archived.last_error;
        }
    }
    if ctx.cancel.load(Ordering::Relaxed) {
        return Ok(out);
    }
    let changes = catch_up_changes(&server_flags, &local_uids);
    if !changes.is_empty() {
        let apply = Arc::clone(&ctx.apply_flags);
        let name = mailbox.clone();
        let result = tokio::task::spawn_blocking(move || (apply)(&name, &changes))
            .await
            .map_err(|e| format!("flag catch-up panicked: {e}"))?;
        let applied = map_flag_catchup_outcome(result, &ctx.account_id, &mailbox);
        if applied.total() > 0 {
            info!(
                "backup: {} — flags caught up on {} vault, {} mirror, {} custody",
                mailbox, applied.renamed, applied.mirrored, applied.index_patched
            );
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
        drain_purge_queue_blocking(&ctx).await?;
    }
    mirror_local_folders_blocking(&ctx).await;
    mirror_contacts_blocking(&ctx).await;

    run_graph_backup_inner(ctx, start).await
}

async fn run_graph_backup_inner(ctx: BackupRunContext, start: std::time::Instant) -> Result<BackupResult, String> {
    use crate::maildir::{copies_to_write, mirror_file_map, CopiesToWrite};

    let account = &ctx.account;
    let account_id = &ctx.account_id;

    let access_token = account
        .access_token
        .as_deref()
        .ok_or_else(|| "Missing OAuth2 access token for Graph account".to_string())?;
    let client = crate::graph::GraphClient::for_purpose(access_token, "backup").for_account(&account.email);

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
            .map(|root| crate::maildir::mirror_cur(Path::new(root), &account.email, &mailbox_path)).transpose()?;

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
            let vault_cur_dir = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(&ctx.archive_ctx.root, account_id, &mailbox_path));
            let mirror_dir = mirror_dir.clone();
            let (registry, account, mailbox) = (Arc::clone(&ctx.archive_ctx.registry), account_id.clone(), mailbox_path.clone());
            let mirror_root = ctx.mirror_root.clone();
            tokio::task::spawn_blocking(move || vault_uids_after_presync_at(&registry, &account, &mailbox, &vault_cur_dir, mirror_root.as_deref().map(Path::new), mirror_dir.as_deref()))
                .await
                .map_err(|e| format!("pre-sync panicked: {}", e))??
        };

        // One listing per side for the whole folder, after the pre-sync so
        // what it restored or mirrored counts.
        // ponytail: a copy another writer lands mid-folder is not in this
        // listing, and this run writes its own beside it — the rescan this
        // replaced had that race too, only narrower.
        let (mut in_vault, mut in_mirror) = {
            let mailbox_dir = crate::message_store::mailbox_dir(&ctx.archive_ctx.root, account_id, &mailbox_path);
            let mirror_dir = mirror_dir.clone();
            tokio::task::spawn_blocking(move || {
                let in_vault: HashSet<u32> = crate::message_store::raw_paths_at(&mailbox_dir).into_keys().collect();
                let in_mirror: Option<HashSet<u32>> = mirror_dir.map(|dir| mirror_file_map(&dir).into_keys().collect());
                (in_vault, in_mirror)
            })
            .await
            .map_err(|e| format!("folder listing panicked: {}", e))?
        };

        if !listed.is_empty() && !ctx.cancel.load(Ordering::Relaxed) {
            let entries: Vec<(String, Option<String>)> =
                listed.iter().map(|m| (m.id.clone(), m.internet_message_id.clone())).collect();
            // Graph-only: the Outlook backup listing; a JMAP mailbox's ledger is `JMAP_LEDGER_FILE`.
            let ledger_path = ctx
                .archive_ctx
                .root
                .join("email_cache")
                .join(crate::header_cache::cache_base_name(account_id, &mailbox_path))
                .join(crate::graph_ledger::LEDGER_FILE);
            let (ledger_root, ledger_account, ledger_mailbox) = (ctx.archive_ctx.root.clone(), account_id.clone(), mailbox_path.clone());
            let local = local_uids.clone();
            // Directory scan, header reads and a file write, on whatever
            // drive the vault is on — and, in-process now, under the same
            // write gate every other vault-rooted route goes through (the
            // app-side original held this behind no gate at all).
            let gate = Arc::clone(&ctx.archive_ctx.gate);
            let plan: Result<Vec<(usize, u32)>, String> = tokio::task::spawn_blocking(move || {
                let mut planned: Result<Vec<(usize, u32)>, String> = Ok(Vec::new());
                let gated = gate(&mut || {
                    planned = crate::graph_ledger::plan_fetch_in(&ledger_path, &ledger_root, &ledger_account, &ledger_mailbox, &entries, &local);
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
                                let root = ctx.archive_ctx.root.clone();
                                let flags = vec!["archived".to_string()];
                                let filename = crate::maildir::mirror_filename(uid, &flags);
                                // Each write held under the same gate the
                                // per-file archive write uses (once each, off
                                // the runtime workers): a stalled
                                // external drive would hold every task it
                                // polls if this ran on a runtime worker, and a
                                // vault move started mid-run must see this
                                // write finish or refuse it outright, not
                                // race it. A failed vault write ends the run;
                                // a failed mirror write is counted.
                                let gate = Arc::clone(&ctx.archive_ctx.gate);
                                let registry = Arc::clone(&ctx.archive_ctx.registry);
                                let (account, mailbox) = (account_id.clone(), mailbox_path.clone());
                                let mirror_root = ctx.mirror_root.clone();
                                let mirror_write: Option<Result<(), String>> = tokio::task::spawn_blocking(
                                    move || -> Result<Option<Result<(), String>>, String> {
                                        // Mailbox lock, then the gate (lock order);
                                        // the row lands right after the vault write.
                                        registry.serialized(&account, &mailbox, || gate(&mut || {
                                            crate::message_store::create_messages_dir(&root, &account, &mailbox).map_err(|e| format!("mkdir: {}", e))?;
                                            let written = match crate::message_store::write_new(&root, &account, &mailbox, uid, &raw_bytes, &flags, false) {
                                                Ok(written) => written,
                                                Err(e) => {
                                                    // A failed plain write can leave a partial file.
                                                    registry.invalidate(&account, &mailbox);
                                                    return Err(format!("write .eml: {}", e));
                                                }
                                            };
                                            registry.upsert(&account, &mailbox, uid, &written);
                                            Ok(())
                                        }))?;
                                        // Local scopes have returned. Only the mirror
                                        // root guard spans this external mutation.
                                        Ok(mirror_to.as_ref().map(|dir| {
                                            write_direct_mirror(mirror_root.as_deref(), dir, &filename, &raw_bytes)
                                        }))
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
            stop_reason: None, limit_bytes: None, resume_after_ms: None,
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
    let work = folders
        .into_iter()
        .enumerate()
        .skip(skip)
        .collect::<Vec<_>>();
    let mut done = vec![false; work.len()];
    let (mut backed, mut errors, mut external_failures) = (0, 0, 0);
    let mut last_error = None;
    let mut refused: Option<(usize, String)> = None;
    for batch in work.chunks(ctx.mailbox_concurrency.clamp(1, 5)) {
        if ctx.cancel.load(Ordering::Relaxed) {
            break;
        }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, folder) in batch {
            let folder = crate::graph::GraphMailFolder {
                id: folder.id.clone(),
                display_name: folder.display_name.clone(),
                total_item_count: folder.total_item_count,
                unread_item_count: folder.unread_item_count,
                child_folder_count: folder.child_folder_count,
                well_known_name: folder.well_known_name.clone(),
                storage_key: folder.storage_key.clone(),
            };
            let ctx = ctx.clone();
            let index = *index;
            tasks.spawn(async move { backup_graph_folder(ctx, index, folder).await });
        }
        join_backup_batch(&mut tasks, &ctx.cancel, |out| {
            if let Some(why) = out.refused.clone() {
                refused.get_or_insert((out.index, why));
            }
            let slot = out.index.saturating_sub(skip);
            if slot < done.len() {
                done[slot] = out.completed;
            }
            backed += out.backed_up;
            errors += out.errors;
            external_failures += out.external_failures;
            if out.last_error.is_some() {
                last_error = out.last_error;
            }
            let completed = contiguous_completed_checkpoint(skip, &done).min(total_folders);
            (ctx.on_progress)(BackupProgress {
                account_id: ctx.account_id.clone(),
                folder: out.mailbox,
                total_folders,
                completed_folders: completed,
                total_emails: backed + errors,
                completed_emails: backed,
                errors,
                active: true,
                last_error: None,
                missing_in_folder: 0,
                cancelled: false,
                success: true,
                external_copy_ok: external_failures == 0,
                external_copy_error: None,
                external_copy_failed_count: external_failures,
                stop_reason: None,
                limit_bytes: None,
                resume_after_ms: None,
            });
        })
        .await?;
    }
    let cancelled = ctx.cancel.load(Ordering::Relaxed);
    let completed = contiguous_completed_checkpoint(skip, &done).min(total_folders);
    let checkpoint = graph_completed_folders_checkpoint(completed, refused.as_ref(), cancelled);
    let error_message = refused
        .as_ref()
        .map(|(_, why)| why.clone())
        .or_else(|| partial_error_message(errors, backed, last_error.as_deref()));
    (ctx.on_progress)(terminal_backup_progress(
        &ctx.account_id,
        cancelled,
        total_folders,
        checkpoint,
        backed,
        errors,
        external_failures,
        error_message.clone(),
    ));
    let duration = start.elapsed().as_secs_f64();
    Ok(BackupResult {
        emails_backed_up: backed,
        errors,
        duration_secs: duration,
        success: !cancelled,
        error_message,
        cancelled,
        completed_folders: checkpoint,
        external_copy_ok: external_failures == 0,
        external_copy_error: (external_failures > 0).then(|| {
            format!(
                "{} emails failed to copy to external backup",
                external_failures
            )
        }),
        external_copy_failed_count: external_failures,
    })
}

async fn backup_graph_folder(
    ctx: BackupRunContext,
    index: usize,
    folder: crate::graph::GraphMailFolder,
) -> Result<GraphFolderOutcome, String> {
    use crate::maildir::{copies_to_write, mirror_file_map, CopiesToWrite};
    let token = ctx.account.access_token.as_deref().ok_or("Missing OAuth2 access token for Graph account")?;
    let client = crate::graph::GraphClient::for_purpose(token, "backup").for_account(&ctx.account.email);
    let mailbox = folder.storage_key;
    let mirror_dir = ctx.mirror_root.as_ref().map(|root| crate::maildir::mirror_cur(Path::new(root), &ctx.account.email, &mailbox)).transpose()?;
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
        let cur = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(&ctx.archive_ctx.root, &ctx.account_id, &mailbox));
        let mirror = mirror_dir.clone();
        let (registry, account_id, mbox) = (Arc::clone(&ctx.archive_ctx.registry), ctx.account_id.clone(), mailbox.clone());
        let mirror_root = ctx.mirror_root.clone();
        tokio::task::spawn_blocking(move || vault_uids_after_presync_at(&registry, &account_id, &mbox, &cur, mirror_root.as_deref().map(Path::new), mirror.as_deref()))
            .await.map_err(|e| format!("pre-sync panicked: {e}"))??
    };
    let (mut in_vault, mut in_mirror) = {
        let mailbox_dir = crate::message_store::mailbox_dir(&ctx.archive_ctx.root, &ctx.account_id, &mailbox);
        let mirror = mirror_dir.clone();
        tokio::task::spawn_blocking(move || {
            (crate::message_store::raw_paths_at(&mailbox_dir).into_keys().collect::<HashSet<_>>(), mirror.map(|d| mirror_file_map(&d).into_keys().collect::<HashSet<_>>()))
        }).await.map_err(|e| format!("folder listing panicked: {e}"))?
    };
    let mut out = GraphFolderOutcome { index, mailbox: mailbox.clone(), completed: false, backed_up: 0, errors: 0, external_failures: 0, last_error: None, refused: None };
    if !listed.is_empty() && !ctx.cancel.load(Ordering::Relaxed) {
        let entries = listed.iter().map(|m| (m.id.clone(), m.internet_message_id.clone())).collect::<Vec<_>>();
        // Graph-only: the Outlook backup listing; a JMAP mailbox's ledger is `JMAP_LEDGER_FILE`.
        let ledger = ctx.archive_ctx.root.join("email_cache")
            .join(crate::header_cache::cache_base_name(&ctx.account_id, &mailbox)).join(crate::graph_ledger::LEDGER_FILE);
        let (ledger_root, ledger_account, ledger_mailbox) = (ctx.archive_ctx.root.clone(), ctx.account_id.clone(), mailbox.clone());
        let local = local_uids.clone();
        let gate = Arc::clone(&ctx.archive_ctx.gate);
        let plan = tokio::task::spawn_blocking(move || {
            let mut planned = Ok(Vec::new());
            gate(&mut || { planned = crate::graph_ledger::plan_fetch_in(&ledger, &ledger_root, &ledger_account, &ledger_mailbox, &entries, &local); Ok(()) })?;
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
                        let root = ctx.archive_ctx.root.clone();
                        let flags = vec!["archived".to_string()];
                        let filename = crate::maildir::mirror_filename(uid, &flags);
                        let gate = Arc::clone(&ctx.archive_ctx.gate);
                        let registry = Arc::clone(&ctx.archive_ctx.registry);
                        let (account, mbox) = (ctx.account_id.clone(), mailbox.clone());
                        let mirror_root = ctx.mirror_root.clone();
                                let mirror_write = tokio::task::spawn_blocking(move || -> Result<Option<Result<(), String>>, String> {
                            // Mailbox lock, then the gate (lock order); the row
                            // lands right after the vault write.
                            registry.serialized(&account, &mbox, || gate(&mut || {
                                crate::message_store::create_messages_dir(&root, &account, &mbox).map_err(|e| format!("mkdir: {e}"))?;
                                let written = match crate::message_store::write_new(&root, &account, &mbox, uid, &raw, &flags, false) {
                                    Ok(written) => written,
                                    Err(e) => {
                                        // A failed plain write can leave a partial file.
                                        registry.invalidate(&account, &mbox);
                                        return Err(format!("write .eml: {e}"));
                                    }
                                };
                                registry.upsert(&account, &mbox, uid, &written);
                                Ok(())
                            }))?;
                            // No local lock spans the mirror unit.
                            Ok(mirror_to.as_ref().map(|dir| {
                                            write_direct_mirror(mirror_root.as_deref(), dir, &filename, &raw)
                            }))
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

// ── JMAP backup runner ───────────────────────────────────────────────────────
//
// The Graph runner's shape (`run_graph_backup_inner`): one listing per
// folder, the uid ledger plans what is missing, each message written to the
// vault and the mirror under the same gates (`write_backup_copy`). What
// differs:
// - One `JmapClient` for the whole run, connected under the "backup"
//   purpose. The folders are `mailbox_tree`'s flat list, filed by path
//   ("INBOX", "Work/Sub"): the paths the bridge and the sync file under.
// - The ledger is the mailbox's JMAP ledger (`jmap_id_map.json`,
//   `graph_ledger::ledger_path(.., true)`), handed the ids oldest first with
//   no Message-ID adoption, as `AccountJmap::ids_to_uids` hands them: a uid
//   names the same email here, in the bridge and in the sync.
// - The bytes are the email's blob (`download`), with one `Email/get` per
//   folder for the blob ids and keywords; the file name carries `archived`
//   plus the read, flagged, answered and draft state the keywords say.
// - Folders run one after another on the one session, whatever
//   `mailbox_concurrency` asks: there is no parallel runner.
// - No daily limit, as for Graph: JMAP traffic is not wire-counted.
pub async fn run_jmap_account(ctx: BackupRunContext) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();

    if let Some(ref root) = ctx.mirror_root {
        info!("backup(jmap): using external path: {:?}", root);
        // Same ordering rule as the other runners: drain BEFORE any mirroring
        // work touches the files the queue is about to delete.
        drain_purge_queue_blocking(&ctx).await?;
    }
    mirror_local_folders_blocking(&ctx).await;

    run_jmap_backup_inner(ctx, start).await
}

/// The account's JMAP session for a backup run or a status check, every
/// request shown as "backup" on Network Activity. No credentials is
/// `E_JMAP_AUTH` before anything leaves the machine.
async fn jmap_backup_client(account: &ImapConfig) -> Result<crate::jmap::JmapClient, String> {
    let auth = account
        .jmap_auth()
        .ok_or_else(|| format!("E_JMAP_AUTH: there is no password or API token for {} to back up with", account.email))?;
    let url = account.jmap_session_url.as_deref().unwrap_or_default().trim().to_string();
    net_activity::with_purpose("backup", crate::jmap::JmapClient::connect(&url, auth, &account.email))
        .await
        .map_err(|e| e.to_string())
}

/// A JMAP email's backup file flags: `archived`, plus `seen`, `flagged`,
/// `replied` and `draft` as its keywords say (any case).
fn jmap_file_flags(email: &serde_json::Value) -> Vec<String> {
    let on = |keyword: &str| {
        email["keywords"]
            .as_object()
            .is_some_and(|m| m.iter().any(|(k, v)| k.eq_ignore_ascii_case(keyword) && v.as_bool() == Some(true)))
    };
    let mut flags = vec!["archived".to_string()];
    for (keyword, word) in [("$seen", "seen"), ("$flagged", "flagged"), ("$answered", "replied"), ("$draft", "draft")] {
        if on(keyword) {
            flags.push(word.to_string());
        }
    }
    flags
}

/// One backup copy of `uid` in `mailbox` under `flags`, as the Graph runner
/// writes it: the vault file under the mailbox lock and then the gate (lock
/// order), its registry row right after; with `mirror_to`, the mirror file
/// (its Maildir name, `maildir::mirror_filename`) under a gate of its own
/// outside the mailbox lock, so a slow external drive never holds up the
/// folder's other writers. A failed vault write is `Err` and ends the run; the
/// mirror's outcome comes back for the caller to count. Runs off the runtime
/// workers. In a JMAP-format vault the record keeps `ids`, the server's ids
/// of the message (Plan A Task 14), set before its registry row is filed.
fn write_direct_mirror(root: Option<&str>, dir: &Path, filename: &str, raw: &[u8]) -> Result<(), String> {
    let root = root.ok_or("Backup folder unavailable")?;
    crate::mirror_mutation::mutate_at(Path::new(root), dir, |dir| {
        std::fs::create_dir_all(dir).map_err(|e| format!("external mkdir failed: {e}"))?;
        std::fs::write(dir.join(filename), raw).map_err(|e| format!("external write failed: {e}"))
    })
}

async fn write_backup_copy(
    ctx: &BackupRunContext,
    mailbox: &str,
    uid: u32,
    flags: Vec<String>,
    raw: Vec<u8>,
    ids: crate::jmap_store::record::ServerIds,
    mirror_to: Option<PathBuf>,
) -> Result<Option<Result<(), String>>, String> {
    let root = ctx.archive_ctx.root.clone();
    let filename = crate::maildir::mirror_filename(uid, &flags);
    let gate = Arc::clone(&ctx.archive_ctx.gate);
    let registry = Arc::clone(&ctx.archive_ctx.registry);
    let (account, mailbox) = (ctx.account_id.clone(), mailbox.to_string());
    let mirror_root = ctx.mirror_root.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<Result<(), String>>, String> {
        registry.serialized(&account, &mailbox, || {
            gate(&mut || {
                crate::message_store::create_messages_dir(&root, &account, &mailbox).map_err(|e| format!("mkdir: {e}"))?;
                let written = match crate::message_store::write_new(&root, &account, &mailbox, uid, &raw, &flags, false) {
                    Ok(written) => written,
                    Err(e) => {
                        // A failed plain write can leave a partial file.
                        registry.invalidate(&account, &mailbox);
                        return Err(format!("write .eml: {e}"));
                    }
                };
                if crate::message_store::vault_format(&root) == crate::message_store::Format::Jmap {
                    if let Err(e) = crate::message_store::set_server_ids(&root, &account, &mailbox, uid, ids.clone()) {
                        warn!("backup(jmap): server ids of uid {} in {} not recorded: {}", uid, mailbox, e);
                    }
                }
                registry.upsert(&account, &mailbox, uid, &written);
                Ok(())
            })
        })?;
        Ok(mirror_to.as_ref().map(|dir| {
            write_direct_mirror(mirror_root.as_deref(), dir, &filename, &raw)
        }))
    })
    .await
    .map_err(|e| format!("message write panicked: {e}"))?
}

async fn run_jmap_backup_inner(ctx: BackupRunContext, start: std::time::Instant) -> Result<BackupResult, String> {
    use crate::maildir::{copies_to_write, mirror_file_map, CopiesToWrite};

    let account = &ctx.account;
    let account_id = &ctx.account_id;
    let client = jmap_backup_client(account).await?;
    let (list, _) = client.mailboxes().await.map_err(|e| e.to_string())?;
    let (folders, mailbox_ids) = crate::jmap::mailbox_map::mailbox_tree(&list);

    let total_folders = folders.len();
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;
    let mut total_ext_failures = 0usize;
    let mut last_message_error: Option<String> = None;
    // The first folder the uid ledger refused, and why: it stored nothing,
    // so a resumed run's checkpoint must not pass it (Graph's rule).
    let mut refused: Option<(usize, String)> = None;
    let mut cancelled = false;

    info!(
        "backup(jmap): starting for {} ({} folders, skipping first {})",
        account.email, total_folders, ctx.skip_folders
    );

    for (folder_idx, folder) in folders.iter().enumerate() {
        if ctx.cancel.load(Ordering::Relaxed) {
            warn!("backup(jmap): cancelled for {} at folder {}/{}", account.email, completed_folders, total_folders);
            cancelled = true;
            break;
        }
        if folder_idx < ctx.skip_folders {
            completed_folders += 1;
            continue;
        }

        let mailbox_path = folder.path.clone();
        let Some(mailbox_id) = mailbox_ids.get(&mailbox_path).cloned() else {
            completed_folders += 1;
            continue;
        };
        let mirror_dir = ctx
            .mirror_root
            .as_ref()
            .map(|root| crate::maildir::mirror_cur(Path::new(root), &account.email, &mailbox_path)).transpose()?;

        // Oldest first: the order the ledger takes a listing in.
        let mut listed = client.all_email_ids(&mailbox_id).await.map_err(|e| e.to_string())?;
        listed.reverse();

        // Local uids after the pre-sync with the mirror, off the runtime
        // workers, as the other runners take them.
        let local_uids = {
            let vault_cur_dir = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(&ctx.archive_ctx.root, account_id, &mailbox_path));
            let mirror_dir = mirror_dir.clone();
            let (registry, account, mailbox) = (Arc::clone(&ctx.archive_ctx.registry), account_id.clone(), mailbox_path.clone());
            let mirror_root = ctx.mirror_root.clone();
            tokio::task::spawn_blocking(move || vault_uids_after_presync_at(&registry, &account, &mailbox, &vault_cur_dir, mirror_root.as_deref().map(Path::new), mirror_dir.as_deref()))
                .await
                .map_err(|e| format!("pre-sync panicked: {}", e))??
        };
        let (mut in_vault, mut in_mirror) = {
            let mailbox_dir = crate::message_store::mailbox_dir(&ctx.archive_ctx.root, account_id, &mailbox_path);
            let mirror_dir = mirror_dir.clone();
            tokio::task::spawn_blocking(move || {
                let in_vault: HashSet<u32> = crate::message_store::raw_paths_at(&mailbox_dir).into_keys().collect();
                let in_mirror: Option<HashSet<u32>> = mirror_dir.map(|dir| mirror_file_map(&dir).into_keys().collect());
                (in_vault, in_mirror)
            })
            .await
            .map_err(|e| format!("folder listing panicked: {}", e))?
        };

        if !listed.is_empty() && !ctx.cancel.load(Ordering::Relaxed) {
            let entries: Vec<(String, Option<String>)> = listed.iter().map(|id| (id.clone(), None)).collect();
            let ledger_path = crate::graph_ledger::ledger_path(
                &crate::header_cache::sidecar_dir(&ctx.archive_ctx.root, account_id, &mailbox_path),
                true,
            );
            let (ledger_root, ledger_account, ledger_mailbox) = (ctx.archive_ctx.root.clone(), account_id.clone(), mailbox_path.clone());
            let local = local_uids.clone();
            // Allocation under the vault gate, on a blocking thread, never
            // under `with_ledger_lock` (the Graph runner's rule).
            let gate = Arc::clone(&ctx.archive_ctx.gate);
            let plan: Result<Vec<(usize, u32)>, String> = tokio::task::spawn_blocking(move || {
                let mut planned: Result<Vec<(usize, u32)>, String> = Ok(Vec::new());
                gate(&mut || {
                    planned = crate::graph_ledger::plan_fetch_in(&ledger_path, &ledger_root, &ledger_account, &ledger_mailbox, &entries, &local);
                    Ok(())
                })?;
                planned
            })
            .await
            .map_err(|e| format!("jmap ledger panicked: {}", e))?;

            match plan {
                Err(e) => {
                    warn!("backup(jmap): {} not backed up: {}", mailbox_path, e);
                    total_errors += 1;
                    refused.get_or_insert((folder_idx, format!("{} was not backed up: {}", mailbox_path, e)));
                }
                Ok(plan) => {
                    let wanted: Vec<String> = plan.iter().map(|(idx, _)| listed[*idx].clone()).collect();
                    let got = client.get_emails(&wanted, &["id", "blobId", "keywords", "threadId"]).await.map_err(|e| e.to_string())?;
                    let by_id: std::collections::HashMap<String, serde_json::Value> =
                        got.list.into_iter().filter_map(|e| e["id"].as_str().map(str::to_string).map(|id| (id, e))).collect();
                    for (idx, uid) in plan {
                        if ctx.cancel.load(Ordering::Relaxed) {
                            break;
                        }
                        // Gone since the listing: nothing left to keep.
                        let Some(email) = by_id.get(&listed[idx]) else { continue };
                        let Some(blob_id) = email["blobId"].as_str() else { continue };
                        match client.download(blob_id).await {
                            Ok(raw_bytes) => {
                                let mirror_to = match copies_to_write(uid, &in_vault, in_mirror.as_ref()) {
                                    CopiesToWrite::Nothing => continue,
                                    CopiesToWrite::Vault => None,
                                    CopiesToWrite::VaultAndMirror => mirror_dir.clone(),
                                };
                                let ids = crate::jmap_store::record::ServerIds {
                                    email_id: listed[idx].clone(),
                                    blob_id: blob_id.to_string(),
                                    thread_id: email["threadId"].as_str().map(str::to_string),
                                };
                                let mirror_write = write_backup_copy(&ctx, &mailbox_path, uid, jmap_file_flags(email), raw_bytes, ids, mirror_to).await?;
                                in_vault.insert(uid);
                                match mirror_write {
                                    Some(Ok(())) => {
                                        if let Some(mirrored) = in_mirror.as_mut() {
                                            mirrored.insert(uid);
                                        }
                                    }
                                    Some(Err(e)) => {
                                        warn!("backup(jmap): {}", e);
                                        total_ext_failures += 1;
                                    }
                                    None => {}
                                }
                                total_backed_up += 1;
                            }
                            Err(e) => {
                                warn!("backup(jmap): failed to fetch email {} in {}: {}", listed[idx], mailbox_path, e);
                                total_errors += 1;
                                last_message_error = Some(e.to_string());
                            }
                        }
                    }
                }
            }
        }

        // A cancel mid-folder: counting the folder would have the next run
        // skip what it never fetched.
        if ctx.cancel.load(Ordering::Relaxed) {
            warn!(
                "backup(jmap): cancelled for {} inside {} ({}/{} folders done)",
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
            active: true,
            last_error: None,
            missing_in_folder: 0,
            cancelled: false,
            success: true,
            external_copy_ok: total_ext_failures == 0,
            external_copy_error: None,
            external_copy_failed_count: total_ext_failures,
            stop_reason: None,
            limit_bytes: None,
            resume_after_ms: None,
        });
    }

    // One terminal frame on every path out of the loop, sharing its values
    // with the result (the Graph runner's rule, checkpoint clamped alike).
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
        "backup(jmap): {} for {}: {} emails backed up, {} errors, {:.1}s (folders: {}/{})",
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

// ── Backup status comparison ─────────────────────────────────────────────────
//
// Ported from `backup.rs:59-461` (`FolderBackupStatus`/`AccountBackupStatus`,
// `get_backup_status`, `get_imap_backup_status`, `get_graph_backup_status`,
// `build_folder_status`), minus the bookmark resolution and app-handle
// plumbing — see the module doc's "What did NOT move here" note.
// `scan_local_uids` did not port as its own function: it was a one-line
// wrapper of `scan_cur_uids` over the app's Maildir folder path, and each call
// site below inlines the same thing (the store's mailbox directory, then
// `scan_cur_uids`) without an extra indirection.

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
) -> Result<FolderBackupStatus, String> {
    let (app_count, external_count) = {
        let vault_cur_dir = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(vault_root, account_id, path));
        let mirror_root = mirror_root.map(|p| p.to_path_buf());
        let email = email.to_string();
        let path_owned = path.to_string();
        tokio::task::spawn_blocking(move || {
            let app_count = scan_cur_uids(&vault_cur_dir).unwrap_or_default().len();
            let external_count = match mirror_root {
                Some(root) => scan_external_uids(&root, &email, &path_owned)?.len(),
                None => 0,
            };
            Ok::<_, String>((app_count, external_count))
        })
        .await
        .map_err(|e| format!("folder scan panicked: {e}"))??
    };
    Ok(FolderBackupStatus {
        path: path.to_string(),
        name: name.to_string(),
        server_count,
        app_count,
        external_count,
        children,
        folder_alias: path.to_string(),
        local_count_alias: app_count,
    })
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
            ).await?;

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

    let client = crate::graph::GraphClient::for_purpose(access_token, "backup").for_account(&email);
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
                let cur_dir = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(&vault_root, &account_id, &mailbox_path));
                let app_count = scan_cur_uids(&cur_dir).unwrap_or_default().len();
                let ext_count = match mirror_root.as_deref() {
                    Some(root) => scan_external_uids(root, &email, &mailbox_path)?.len(),
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
            Ok::<_, String>((folders, total_server, total_app, total_external))
        })
        .await
        .map_err(|e| format!("graph folder scan panicked: {}", e))??
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

/// JMAP backup status: each mailbox's `totalEmails`, flat and by path
/// (`mailbox_tree`), against the vault and mirror counts.
async fn get_jmap_backup_status(
    account_id: &str,
    account: &ImapConfig,
    vault_root: &Path,
    mirror_root: Option<&Path>,
) -> Result<AccountBackupStatus, String> {
    let client = jmap_backup_client(account).await?;
    let (list, _) = client.mailboxes().await.map_err(|e| e.to_string())?;
    let (infos, mailbox_ids) = crate::jmap::mailbox_map::mailbox_tree(&list);
    let counts: std::collections::HashMap<String, usize> = list.iter().map(|m| (m.id.clone(), m.total_emails as usize)).collect();
    let email = account.email.clone();

    // Every read_dir on the blocking pool, as the Graph status does.
    let (folders, total_server, total_app, total_external) = {
        let vault_root = vault_root.to_path_buf();
        let account_id = account_id.to_string();
        let mirror_root = mirror_root.map(|p| p.to_path_buf());
        tokio::task::spawn_blocking(move || {
            let mut folders = Vec::new();
            let (mut total_server, mut total_app, mut total_external) = (0usize, 0usize, 0usize);
            for info in &infos {
                let sc = mailbox_ids.get(&info.path).and_then(|id| counts.get(id)).copied().unwrap_or(0);
                let cur_dir = crate::message_store::maildir_messages_dir(&crate::message_store::mailbox_dir(&vault_root, &account_id, &info.path));
                let app_count = scan_cur_uids(&cur_dir).unwrap_or_default().len();
                let ext_count = match mirror_root.as_deref() {
                    Some(root) => scan_external_uids(root, &email, &info.path)?.len(),
                    None => 0,
                };
                total_server += sc;
                total_app += app_count;
                total_external += ext_count;
                if sc > 0 || app_count > 0 || ext_count > 0 {
                    folders.push(FolderBackupStatus {
                        path: info.path.clone(),
                        name: info.name.clone(),
                        server_count: sc,
                        app_count,
                        external_count: ext_count,
                        children: vec![],
                        folder_alias: info.path.clone(),
                        local_count_alias: app_count,
                    });
                }
            }
            Ok::<_, String>((folders, total_server, total_app, total_external))
        })
        .await
        .map_err(|e| format!("jmap folder scan panicked: {}", e))??
    };

    Ok(AccountBackupStatus {
        folders,
        total_server,
        total_local: total_app,
        total_app,
        total_external,
        external_available: mirror_root.is_some(),
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
    let mut status = if account.uses_jmap() {
        get_jmap_backup_status(account_id, account, vault_root, mirror_root).await?
    } else if account.oauth2_transport.as_deref() == Some("graph") {
        get_graph_backup_status(account_id, account, vault_root, mirror_root).await?
    } else {
        net_activity::with_purpose("backup", get_imap_backup_status(pool, account_id, account, vault_root, mirror_root)).await?
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
fn vault_uids_after_presync_at(
    reg: &VaultRegistry,
    account_id: &str,
    mailbox: &str,
    vault_cur_dir: &Path,
    mirror_root: Option<&Path>,
    mirror_dir: Option<&Path>,
) -> Result<HashSet<u32>, String> {
    if let (Some(root), Some(mirror_dir)) = (mirror_root, mirror_dir) {
        // An old import the vault moved out of the server's uid range is
        // still at U in the backup folder, and the copy by uid below would
        // bring it straight back: the vault's ledger goes to both sides first.
        let replayed = match (vault_cur_dir.parent(), mirror_dir.parent()) {
            (Some(vault), Some(mirror)) => crate::import_rehome::replay_at(vault, root, mirror),
            _ => false,
        };
        let (synced, vault_touched) = sync_locations_at(root, vault_cur_dir, mirror_dir);
        if replayed || vault_touched {
            reg.invalidate(account_id, mailbox);
        }
        if synced > 0 {
            info!("backup: pre-synced {} files between {:?} and {:?}", synced, vault_cur_dir, mirror_dir);
        }
    }
    scan_cur_uids(vault_cur_dir)
}

/// Every uid a file in the vault's Maildir message directory `cur_dir`
/// carries, by the mirror's loose rule (`message_store::loose_uids_in`).
fn scan_cur_uids(cur_dir: &Path) -> Result<HashSet<u32>, String> {
    crate::message_store::loose_uids_in(cur_dir)
}

/// Which uids of `<email>/<mailbox>` are present in an external backup
/// directory. Ported from `backup.rs:143-153`.
fn scan_external_uids(backup_path: &Path, email: &str, mailbox: &str) -> Result<HashSet<u32>, String> {
    let cur_dir = crate::maildir::mirror_cur(backup_path, email, mailbox)?;
    if !backup_path.is_dir() {
        return Err("errors.E_ABD_NO_BACKUP_DRIVE".to_string());
    }
    match crate::message_store::mirror_uids_in(&cur_dir) {
        Ok(uids) => Ok(uids),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && backup_path.is_dir() => Ok(HashSet::new()),
        Err(_) => Err("errors.E_ABD_NO_BACKUP_DRIVE".to_string()),
    }
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
    Some(scan_external_uids(root, email, mailbox).ok()?.into_iter().collect())
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
fn sync_locations_at(root: &Path, vault_cur_dir: &Path, backup_dir: &Path) -> (usize, bool) {
    use std::fs;
    let mut vault_touched = false;

    // Ensure both dirs exist; if backup dir can't be created (disconnected drive), skip
    let _ = fs::create_dir_all(vault_cur_dir);
    if crate::mirror_mutation::mutate_at(root, backup_dir, |dir| fs::create_dir_all(dir).map_err(|e| e.to_string())).is_err() {
        return (0, false); // Backup location not available — skip sync, backup to the vault only
    }

    let mut synced = copy_to_backup_at(root, vault_cur_dir, backup_dir, &mut |_| true);

    // Backup → Vault: copy backup .eml files that don't exist in the vault,
    // restoring flags from the backup filename (legacy `<uid>.eml` has none).
    let mut in_vault: HashSet<u32> = crate::message_store::raw_paths_in(vault_cur_dir).into_keys().collect();
    let mut orphaned_ids: Option<HashSet<String>> = None;
    for (uid, name, path) in crate::maildir::mirror_files(backup_dir) {
        if path.is_dir() {
            continue;
        }
        if !name.ends_with(".eml") {
            continue;
        }
        if in_vault.contains(&uid) {
            continue;
        }
        // The mirror is keyed by uid and carries no generation of its own, so
        // a uid it holds is only as good as the generation that wrote it.
        // `orphaned/` is the one local record of which messages this
        // generation does NOT have — see orphaned_message_ids.
        let ids = orphaned_ids.get_or_insert_with(|| orphaned_message_ids(vault_cur_dir));
        if !ids.is_empty() {
            if let Some(id) = crate::maildir::read_message_id(&path) {
                if ids.contains(&id) {
                    warn!("backup: not restoring {} — the generation repair set this message aside", name);
                    continue;
                }
            }
        }
        let mut flags = crate::maildir::mirror_flags(&name);
        flags.push("archived".to_string());
        // Even a failed copy can leave a partial file behind.
        vault_touched = true;
        if crate::message_store::copy_in(vault_cur_dir, uid, &flags, &path).is_ok() {
            synced += 1;
            in_vault.insert(uid);
        }
    }

    (synced, vault_touched)
}

#[cfg(test)]
fn sync_locations(vault_cur_dir: &Path, backup_dir: &Path) -> (usize, bool) {
    // Test fixtures explicitly create their own mirror root.
    std::fs::create_dir_all(backup_dir).unwrap();
    sync_locations_at(backup_dir, vault_cur_dir, backup_dir)
}

/// Vault → backup, the first half of `sync_locations`: copies every vault file
/// whose uid the backup does not hold, keeping the Maildir name so the flag
/// suffix travels with the message. `keep_going` is asked before each copy,
/// with the count so far. Returns how many files were copied.
fn copy_to_backup_at(root: &Path, vault_cur_dir: &Path, backup_dir: &Path, keep_going: &mut dyn FnMut(usize) -> bool) -> usize {
    let Ok(handle) = crate::mirror_mutation::MirrorRoot::resolve(root) else { return 0 };
    let Ok(backup_dir) = handle.rebase(root, backup_dir) else { return 0 };
    let mut copied = 0;
    let mut listing = MirrorListing::new();
    for (uid, name, path) in crate::message_store::mirror_sources_in(vault_cur_dir) {
        if !keep_going(copied) { break; }
        // Recheck current UID presence inside exclusion, including flag renames.
        let wrote = handle.mutate_versioned(|_, revision| {
            listing.ensure_current(&handle, &backup_dir, revision);
            if listing.contains(uid) { return false; }
            if std::fs::create_dir_all(&backup_dir).is_err() { return false; }
            let name = if name.ends_with(".eml") { name } else { format!("{name}.eml") };
            let dst = backup_dir.join(name);
            if std::fs::copy(&path, &dst).is_ok() {
                listing.files.insert(uid, dst); true
            } else { false }
        });
        copied += usize::from(wrote.unwrap_or(false));
    }
    copied
}


/// The mirror folder of a vault-only folder (`local_folder`): its directory
/// plus the marker's creation stamp. A folder deleted and then imported again
/// the same day gets the same name and restarts at the same uids, so a mirror
/// keyed by the name alone would hold the deleted folder's message under each
/// reused uid, and the new one would never be copied.
fn local_mirror_name(dir: &str, marker: &crate::local_folder::Marker) -> String {
    format!("{dir} ({})", marker.created)
}

/// The account's vault-only folders, mirrored into the backup location. One
/// way only, vault to backup: every delete in such a folder is a local one
/// with no server copy and no mirror purge, and the restore half of
/// `sync_locations` would bring each deleted message back on the next run.
/// The vault is only read, so this takes no gate and no registry lock. A
/// folder with no `cur/` holds no mail and is skipped; a backup folder that
/// cannot be made (the drive is gone) is skipped, as the pre-sync does.
///
/// Runs before the server folders, so a server that cannot be listed (or a
/// Graph token that is missing) does not keep the only copy of this mail off
/// the backup drive. It reports one progress frame per folder, named by its
/// display name, and again every `PROGRESS_EVERY` copies so the app's stall
/// watchdog sees a long first copy working. Local folders are not in
/// `total_folders`/`completed_folders`: those are the server-folder resume
/// checkpoint the app feeds back as `skip_folders`.
fn mirror_local_folders(ctx: &BackupRunContext) {
    const PROGRESS_EVERY: usize = 500;
    let Some(mirror_root) = ctx.mirror_root.as_deref() else { return };
    // The account dir an import writes: keyed by the sanitized id.
    let account_dir = crate::vault_files::account_dir(
        &ctx.archive_ctx.root.join("Maildir"),
        &crate::search_index::text::vault_dir_name(&ctx.account_id),
    );
    let folders = match crate::local_folder::list(&account_dir) {
        Ok(folders) => folders,
        Err(e) => {
            warn!("backup: local folders of {} not listed: {}", ctx.account_id, e);
            return;
        }
    };
    let cancelled = || ctx.cancel.load(Ordering::Relaxed);
    for (dir, marker) in folders {
        if cancelled() {
            return;
        }
        let cur = crate::message_store::maildir_messages_dir(&account_dir.join(&dir));
        // A folder holding JMAP records only has mail too.
        if !matches!(crate::message_store::has_message_dir(&account_dir.join(&dir)), Ok(true)) {
            continue;
        }
        let frame = || BackupProgress {
            account_id: ctx.account_id.clone(),
            folder: marker.name.clone(),
            total_folders: 0,
            completed_folders: ctx.skip_folders,
            total_emails: 0,
            completed_emails: 0,
            errors: 0,
            active: true,
            last_error: None,
            missing_in_folder: 0,
            cancelled: false,
            success: true,
            external_copy_ok: true,
            external_copy_error: None,
            external_copy_failed_count: 0,
            stop_reason: None,
            limit_bytes: None,
            resume_after_ms: None,
        };
        (ctx.on_progress)(frame());
        let backup_dir = match crate::maildir::mirror_cur(Path::new(mirror_root), &ctx.account.email, &local_mirror_name(&dir, &marker)) {
            Ok(dir) => dir,
            Err(e) => {
                warn!("backup: local mirror refused: {}", e);
                continue;
            }
        };
        let copied = copy_to_backup_at(Path::new(mirror_root), &cur, &backup_dir, &mut |done| {
            if done > 0 && done % PROGRESS_EVERY == 0 {
                (ctx.on_progress)(frame());
            }
            !cancelled()
        });
        if copied > 0 {
            info!("backup: mirrored {} files of local folder {} to {:?}", copied, dir, backup_dir);
        }
    }
}

/// `mirror_local_folders` off the runtime workers: directory listings and file
/// copies on whatever drive the vault and the backup are on.
async fn mirror_local_folders_blocking(ctx: &BackupRunContext) {
    let ctx = ctx.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || mirror_local_folders(&ctx)).await {
        warn!("backup: the local folder pass panicked: {}", e);
    }
}

/// `mirror_contacts` off the runtime workers, for the vault and the backup drive.
async fn mirror_contacts_blocking(ctx: &BackupRunContext) {
    let Some(mirror_root) = ctx.mirror_root.clone() else { return };
    let (root, gate) = (ctx.archive_ctx.root.clone(), Arc::clone(&ctx.archive_ctx.gate));
    let done = tokio::task::spawn_blocking(move || mirror_contacts(&root, Path::new(&mirror_root), &gate)).await;
    match done {
        Ok(Err(e)) => warn!("backup: the contacts copy failed: {}", e),
        Err(e) => warn!("backup: the contacts pass panicked: {}", e),
        Ok(Ok(())) => {}
    }
}

/// The contacts safety copy (`Contacts/contacts.vcf`, written by the daemon's
/// people snapshot) rides along with the mail. Vault to backup whenever the
/// bytes differ: custody is the truth, so the vault copy always wins. Backup to
/// vault only when the vault has no copy at all (a restored or fresh vault);
/// that write runs under the vault gate like every other vault write.
fn mirror_contacts(vault_root: &Path, mirror_root: &Path, gate: &crate::archive::ArchiveGate) -> Result<(), String> {
    if !mirror_root.is_dir() { return Err("Backup folder unavailable".into()); }
    let rel = Path::new("Contacts").join("contacts.vcf");
    let (vault, mirror) = (vault_root.join(&rel), mirror_root.join(&rel));
    let put = |dst: &Path, bytes: &[u8]| -> Result<(), String> {
        if let Some(dir) = dst.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        write_durable(dst, bytes).map_err(|e| e.to_string())
    };
    match std::fs::read(&vault) {
        Ok(bytes) => {
            if std::fs::read(&mirror).map_or(true, |held| held != bytes) {
                put(&mirror, &bytes)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match std::fs::read(&mirror) {
            Ok(bytes) => gate(&mut || put(&vault, &bytes)),
            Err(_) => Ok(()),
        },
        Err(e) => Err(e.to_string()),
    }
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
            FlagChange { uid: *uid, flags, on: None }
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

#[cfg(test)]
fn read_purge_queue(data_dir: &Path) -> std::collections::BTreeMap<String, Vec<u32>> {
    // A store that will not open must not brick delete-everywhere; start over
    // rather than error, the same thing the JSON reader did with a corrupt file.
    crate::app_db::with(data_dir, |conn| Ok(crate::app_db::ops::purge_read(conn))).unwrap_or_default()
}

#[cfg(test)]
fn write_purge_queue(data_dir: &Path, q: &std::collections::BTreeMap<String, Vec<u32>>) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| crate::app_db::ops::purge_write(conn, q))
}

/// Delete every mirror file under `<root>/<email>/<mailbox>/cur/` whose uid is
/// in `uids`. Returns how many files were removed.
fn purge_backup_files(root: &Path, email: &str, mailbox: &str, uids: &HashSet<u32>) -> Result<usize, String> {
    let handle = crate::mirror_mutation::MirrorRoot::resolve(root)?;
    let cur = crate::maildir::mirror_cur(handle.path(), email, mailbox)?;
    let wanted = uids.iter().copied().collect::<Vec<_>>();
    let mut removed = 0;
    for chunk in wanted.chunks(100) {
        handle.mutate(|_| {
            for (uid, _, path) in crate::maildir::mirror_files(&cur) {
                if !chunk.contains(&uid) { continue; }
                match std::fs::remove_file(&path) {
                    Ok(()) => removed += 1,
                    Err(e) => warn!("backup purge: failed to remove {:?}: {}", path, e),
                }
            }
            Ok(())
        })?;
    }
    Ok(removed)
}

/// Queue `uids` of `<email>/<mailbox>` for purge next time the mirror is
/// reachable. Ported from `backup.rs:214-226`.
fn queue_purge(data_dir: &Path, email: &str, mailbox: &str, uids: &[u32]) -> Result<(), String> {
    crate::maildir::mirror_cur(Path::new("."), email, mailbox)?;
    crate::app_db::with(data_dir, |conn| crate::app_db::ops::purge_append_legacy(conn,
        &std::collections::BTreeMap::from([(format!("{}|{}",email,mailbox),uids.to_vec())])))
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
    if mirror_root.is_some() || external_status.unwrap_or("not_configured") != "not_configured" {
        crate::maildir::mirror_cur(mirror_root.unwrap_or_else(|| Path::new(".")), email, mailbox)?;
    }
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
    let removed = purge_backup_files(root, email, mailbox, &uid_set)?;
    info!("backup purge: removed {} mirror files for {}/{}", removed, email, mailbox);
    Ok(PurgeOutcome { removed, queued: 0 })
}

/// Native protected purge outcomes are per target. Queued means a durable
/// protected offline obligation; an online partial failure stays unresolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorPurgeIssue {
    MissingProof, InvalidProof, Conflict, Unavailable, Listing, Read,
    Mismatch, Remove, Storage, Acknowledgement,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvedPurgeOutcome {
    Removed { files: usize },
    Queued,
    Unconfigured,
    Unresolved { removed: usize, reason: MirrorPurgeIssue },
}

/// One target, fresh complete fallible listing, every same-UID candidate.
/// Called off runtime workers with no DB/vault/coordinator lock. Native
/// replacement stays excluded from byte read through actual unlink.
fn purge_proved_files(root: &Path, proof: &crate::app_db::ops::MirrorPurgeProof) -> (usize, Option<MirrorPurgeIssue>) {
    let Ok(handle) = crate::mirror_mutation::MirrorRoot::resolve(root) else { return (0,Some(MirrorPurgeIssue::Unavailable)); };
    let target = proof.target();
    let result = handle.mutate(|root| {
        let cur = crate::maildir::mirror_cur(root,&target.email,&target.mailbox)?;
        // Collect before deleting anything so an incomplete listing cannot
        // masquerade as confirmed absence or first-entry-only success.
        let candidates = match crate::maildir::try_mirror_files(&cur) {
            Ok(entries) => entries,
            Err(_) => return Ok((0,Some(MirrorPurgeIssue::Listing))),
        };
        let mut removed = 0;
        let mut issue = None;
        for (uid, _, path) in candidates {
            if uid != target.uid { continue; }
            let raw = match std::fs::read(&path) {
                Ok(raw) => raw,
                Err(_) => { issue.get_or_insert(MirrorPurgeIssue::Read); continue; }
            };
            if crate::bulk_worker::bytes_hash(&raw) != proof.sha256() {
                issue.get_or_insert(MirrorPurgeIssue::Mismatch);
                continue;
            }
            #[cfg(test)]
            tests::protected_before_unlink();
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(_) => { issue.get_or_insert(MirrorPurgeIssue::Remove); }
            }
        }
        Ok((removed,issue))
    });
    result.unwrap_or((0,Some(MirrorPurgeIssue::Unavailable)))
}

/// Synchronous native capability: callers run the entire call on blocking
/// execution and hold external access until it returns. Proof comes from an
/// already native-validated original artifact, never a frontend digest.
/// Persist before immediate effects so legacy/conflicting obligations refuse
/// before unlink. No DB lock crosses root resolution, guard waiting or IO.
pub fn purge_proved(
    data_dir: &Path, mirror_root: Option<&Path>, external_status: Option<&str>,
    target: &crate::app_db::ops::MirrorPurgeTarget,
    proof: Option<&crate::app_db::ops::MirrorPurgeProof>,
) -> ProvedPurgeOutcome {
    use crate::app_db::ops::{self,PurgeEnqueue};
    use ProvedPurgeOutcome::{Unconfigured,Unresolved,Queued,Removed};
    if mirror_root.is_none() && external_status.unwrap_or("not_configured") == "not_configured" { return Unconfigured; }
    let Some(proof) = proof else { return Unresolved{removed:0,reason:MirrorPurgeIssue::MissingProof}; };
    if proof.target() != target { return Unresolved{removed:0,reason:MirrorPurgeIssue::InvalidProof}; }
    let queued = crate::app_db::with(data_dir, |conn| {
        if ops::purge_enqueue_proved(conn,proof)? == PurgeEnqueue::Conflict { return Ok(None); }
        let item = ops::purge_get(conn,target)?;
        Ok(item.filter(|item| item.proved().as_ref() == Ok(proof)))
    });
    let item = match queued {
        Ok(Some(item)) => item,
        Ok(None) => return Unresolved{removed:0,reason:MirrorPurgeIssue::Conflict},
        Err(_) => return Unresolved{removed:0,reason:MirrorPurgeIssue::Storage},
    };
    let Some(root) = mirror_root else { return Queued; };
    let (removed,issue) = purge_proved_files(root,proof);
    if let Some(reason) = issue { return Unresolved{removed,reason}; }
    match crate::app_db::with(data_dir, |conn| ops::purge_ack(conn,&item)) {
        Ok(true) => Removed{files:removed},
        _ => Unresolved{removed,reason:MirrorPurgeIssue::Acknowledgement},
    }
}

/// Keep queue IO, canonicalization and root-guard waits off runtime workers.
/// The caller awaits completion before any account mirroring begins.
async fn drain_purge_queue_blocking(ctx: &BackupRunContext) -> Result<(), String> {
    let Some(root) = ctx.mirror_root.as_ref().map(PathBuf::from) else { return Ok(()) };
    let data_dir = ctx.app_dir.clone();
    let cancel = ctx.cancel.clone();
    tokio::task::spawn_blocking(move || drain_purge_queue_cancelled(&data_dir, &root, &cancel))
        .await
        .map_err(|e| format!("backup purge panicked: {e}"))?;
    Ok(())
}

/// Snapshot evidence, release app.db, perform one bounded mirror target,
/// release root exclusion, then conditionally acknowledge that exact payload.
fn drain_purge_queue_cancelled(data_dir: &Path, root: &Path, cancel: &AtomicBool) -> usize {
    use crate::app_db::ops;
    let items = match crate::app_db::with(data_dir,ops::purge_items) {
        Ok(items) => items,
        Err(e) => { warn!("backup purge: queue snapshot failed: {e}"); return 0; }
    };
    let mut removed_total = 0;
    for item in items {
        if cancel.load(Ordering::Relaxed) { break; }
        let (removed,complete) = if item.proof_json.is_some() {
            let Ok(proof) = item.proved() else { continue; };
            let (removed,issue) = purge_proved_files(root,&proof);
            (removed,issue.is_none())
        } else {
            // Explicit compatibility policy only. Legacy rows never acquire
            // native proof from today's mirror and never authorize new work.
            let Some((email,mailbox)) = item.scope.split_once('|') else { continue; };
            let Ok(cur) = crate::maildir::mirror_cur(root,email,mailbox) else { continue; };
            if !cur.exists() { continue; }
            match purge_backup_files(root,email,mailbox,&HashSet::from([item.uid])) {
                Ok(removed) => (removed,true),
                Err(_) => continue,
            }
        };
        removed_total += removed;
        if complete {
            if let Err(e) = crate::app_db::with(data_dir,|conn| ops::purge_ack(conn,&item)) {
                warn!("backup purge: item acknowledgement failed: {e}");
            }
        }
    }
    removed_total
}

#[cfg(test)]
fn drain_purge_queue(data_dir: &Path, root: &Path) -> usize {
    drain_purge_queue_cancelled(data_dir,root,&AtomicBool::new(false))
}

// ── On-demand mirror copy ─────────────────────────────────────────────────────
//
// `archive_emails` with no mirror writes only the vault, and a whole-account
// backup run is the only thing that fills the drive otherwise. "Archive, Back
// up & Delete" (and the account-wide archive job after it) needs the chosen
// messages on the drive, and needs proof they are there, before anything is
// removed from the server. `copy_uids_to_mirror` is that step: the vault file
// is copied under its own Maildir name (as `sync_locations` and the archive's
// own mirror write do, so flags survive a restore), and every copy the drive
// holds is then checked against the vault file, not merely found by uid.
//
// It reads the vault and writes only the mirror, so it takes no vault lock; the
// daemon handler checks the vault is reachable (`common::vault_root`, the same
// read-side gate `backup_status` uses) and runs it on the blocking pool. Each
// file is one small unit (read, atomic temp-dotfile write, rename, read-back),
// so a caller batching a large selection never holds anything for long.

/// The caller-owned listing of one mirror folder (`<mirror>/<email>/<mailbox>/cur`).
///
/// A `read_dir` of a backup-drive folder is the slowest disk access the app
/// makes (memory `project_backup_hangs_on_slow_external_drive`), so a caller
/// copying in batches builds ONE listing, passes it to every
/// `copy_uids_to_mirror_listed` call and lets each copy it lands join it. The
/// listing is bound to the folder it was read for: a call for another folder
/// reads that folder again.
#[derive(Debug, Default)]
pub struct MirrorListing {
    dir: Option<PathBuf>,
    files: std::collections::HashMap<u32, PathBuf>,
    loads: usize,
    root: Option<crate::mirror_mutation::MirrorRoot>,
    revision: Option<u64>,
}

impl MirrorListing {
    pub fn new() -> Self {
        Self::default()
    }

    /// How many times a folder has been read from disk into this listing.
    pub fn loads(&self) -> usize {
        self.loads
    }

    /// Whether the listing holds `uid` (under any mirror filename shape).
    pub fn contains(&self, uid: u32) -> bool {
        self.files.contains_key(&uid)
    }

    /// Forget everything; the next call reads the folder again.
    pub fn invalidate(&mut self) {
        self.dir = None;
        self.files.clear();
        self.root = None;
        self.revision = None;
    }

    pub(crate) fn ensure_current(&mut self, root: &crate::mirror_mutation::MirrorRoot, cur_dir: &Path, revision: u64) {
        if self.dir.as_deref() != Some(cur_dir)
            || !self.root.as_ref().is_some_and(|old| old.same_guard(root))
            || self.revision != Some(revision) {
            self.files = crate::maildir::mirror_file_map(cur_dir);
            self.dir = Some(cur_dir.to_path_buf());
            self.loads += 1;
            self.root = Some(root.clone());
        }
        self.revision = Some(revision.wrapping_add(1));
    }
}

/// What `copy_uids_to_mirror` did with each requested uid. Every requested uid
/// lands in exactly one of `verified`, `missing`, `mismatched` or `failed`;
/// `copied` is the subset of `verified` this call had to write.
///
/// Only `verified` may be treated as "the drive holds this message". The other
/// three all mean "keep it on the server", for different reasons:
/// - `missing`: the vault has no file for the uid, so there is nothing to copy;
/// - `mismatched`: the drive already holds something else for the uid (another
///   message, or a truncated copy). It is left exactly as it was;
/// - `failed`: the write or the read-back failed (drive full, unplugged, I/O error).
#[derive(Serialize, Debug, PartialEq, Eq, Default, Clone)]
pub struct MirrorCopyOutcome {
    pub copied: Vec<u32>,
    pub verified: Vec<u32>,
    pub missing: Vec<u32>,
    pub mismatched: Vec<u32>,
    pub failed: Vec<u32>,
}

/// `copy_uids_to_mirror_listed` with a listing built for this one call.
pub fn copy_uids_to_mirror(
    vault_root: &Path,
    mirror_root: &Path,
    account_id: &str,
    email: &str,
    mailbox: &str,
    uids: &[u32],
) -> Result<MirrorCopyOutcome, String> {
    copy_uids_to_mirror_listed(vault_root, mirror_root, account_id, email, mailbox, uids, &mut MirrorListing::new())
}

/// Copy the vault files of `uids` (`<vault>/Maildir/<account_id>/<mailbox>/cur`)
/// to the mirror (`<mirror_root>/<email>/<mailbox>/cur`) and verify each one.
///
/// - An archived vault copy (`A`) is preferred over a working-cache copy of the
///   same uid.
/// - The mirror name is the vault name, so flags travel with the message.
/// - A drive copy is never overwritten. When the mirror already holds the uid
///   (under any name shape) it is compared with the vault file: the same
///   message counts as present and nothing is written, anything else is
///   `mismatched` and left alone.
/// - "The same message" is the same length and the same Message-ID (a message
///   without one must match byte for byte). A file merely found under the uid
///   is not proof: uids are per mailbox and a drive is shared over years.
/// - A fresh copy is written to a temp dotfile and renamed into place, read
///   back and compared the same way; a copy that fails the check is removed and
///   reported `failed`.
///
/// `Err` when the names are unsafe, the mirror root is not there, or its folder cannot be made:
/// the caller treats that as "backup unreachable" for the whole batch. The root
/// itself is never created, so an unplugged drive cannot be replaced by a folder
/// on the internal disk.
pub fn copy_uids_to_mirror_listed(
    vault_root: &Path,
    mirror_root: &Path,
    account_id: &str,
    email: &str,
    mailbox: &str,
    uids: &[u32],
    listing: &mut MirrorListing,
) -> Result<MirrorCopyOutcome, String> {
    crate::maildir::mirror_cur(mirror_root, email, mailbox)?;
    if uids.is_empty() {
        return Ok(MirrorCopyOutcome::default());
    }
    if !mirror_root.is_dir() {
        return Err("Backup folder unavailable".to_string());
    }
    let wanted: HashSet<u32> = uids.iter().copied().collect();
    let sources = crate::message_store::archived_first_paths(vault_root, account_id, mailbox, &wanted);
    copy_uids_to_mirror_from(vault_root, mirror_root, account_id, email, mailbox, uids, listing, &sources)
}

/// `copy_uids_to_mirror_listed` with the vault side given by the caller: the
/// file per uid from a listing it already holds (the Archive & delete job's
/// archived listing of the folder, kept across batches), so no call lists the
/// vault folder. A uid the map lacks is `missing`; a listed path renamed
/// since (a flag change) is resolved by uid once more, as with a fresh listing.
#[allow(clippy::too_many_arguments)]
pub fn copy_uids_to_mirror_from(
    vault_root: &Path,
    mirror_root: &Path,
    account_id: &str,
    email: &str,
    mailbox: &str,
    uids: &[u32],
    listing: &mut MirrorListing,
    sources: &std::collections::HashMap<u32, PathBuf>,
) -> Result<MirrorCopyOutcome, String> {
    copy_uids_to_mirror_checked(vault_root,mirror_root,account_id,email,mailbox,uids,listing,sources,None)
}

/// User bulk copying uses the exact bytes proved by its archive/store result.
/// Legacy backup callers retain their existing Message-ID/length comparison.
pub fn copy_uids_to_mirror_proved(
    vault_root: &Path,
    mirror_root: &Path,
    account_id: &str,
    email: &str,
    mailbox: &str,
    uids: &[u32],
    sources: &std::collections::HashMap<u32, PathBuf>,
    expected: &std::collections::HashMap<u32, String>,
) -> Result<MirrorCopyOutcome, String> {
    copy_uids_to_mirror_checked(
        vault_root,
        mirror_root,
        account_id,
        email,
        mailbox,
        uids,
        &mut MirrorListing::new(),
        sources,
        Some(expected),
    )
}

fn copy_uids_to_mirror_checked(
    vault_root: &Path,
    mirror_root: &Path,
    account_id: &str,
    email: &str,
    mailbox: &str,
    uids: &[u32],
    listing: &mut MirrorListing,
    sources: &std::collections::HashMap<u32, PathBuf>,
    expected: Option<&std::collections::HashMap<u32, String>>,
) -> Result<MirrorCopyOutcome, String> {
    crate::maildir::mirror_cur(mirror_root, email, mailbox)?;
    if uids.is_empty() { return Ok(MirrorCopyOutcome::default()); }
    let handle = crate::mirror_mutation::MirrorRoot::resolve(mirror_root)?;
    let mirror_cur = crate::maildir::mirror_cur(handle.path(), email, mailbox)?;
    let mut out = MirrorCopyOutcome::default();

    let mut seen: HashSet<u32> = HashSet::new();
    let wanted: Vec<u32> = uids.iter().copied().filter(|u| seen.insert(*u)).collect();

    for uid in wanted {
        let Some(src) = sources.get(&uid) else {
            out.missing.push(uid);
            continue;
        };
        let result = handle.mutate_versioned(|_, revision| {
            if std::fs::create_dir_all(&mirror_cur).is_err() { return CopyOne::Failed; }
            listing.ensure_current(&handle, &mirror_cur, revision);
            copy_one_to_mirror(
            vault_root,
            account_id,
            mailbox,
            uid,
            src,
            &mirror_cur,
            listing,
            expected.and_then(|expected| expected.get(&uid).map(String::as_str)),
        )
        }).unwrap_or(CopyOne::Failed);
        match result {
            CopyOne::Copied => {
                out.copied.push(uid);
                out.verified.push(uid);
            }
            CopyOne::Present => out.verified.push(uid),
            CopyOne::VaultGone => out.missing.push(uid),
            CopyOne::Mismatch => out.mismatched.push(uid),
            CopyOne::Failed => out.failed.push(uid),
        }
        // One small unit per file: let a foreground read run between two.
        std::thread::yield_now();
    }
    info!(
        "backup copy: {}/{} {} requested: {} copied, {} verified, {} missing, {} mismatched, {} failed",
        email,
        mailbox,
        seen.len(),
        out.copied.len(),
        out.verified.len(),
        out.missing.len(),
        out.mismatched.len(),
        out.failed.len()
    );
    Ok(out)
}

enum CopyOne {
    Copied,
    Present,
    VaultGone,
    Mismatch,
    Failed,
}

/// Copies `uid`'s vault file to the mirror and checks the copy. The source is
/// the store's raw file for the uid (`message_store::raw_path_listed`): the
/// listed path while it is there, else the uid found once more.
fn copy_one_to_mirror(
    vault_root: &Path,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    listed_src: &Path,
    mirror_cur: &Path,
    listing: &mut MirrorListing,
    expected: Option<&str>,
) -> CopyOne {
    // A flag change renames the vault file after the listing: resolve by uid
    // once more before calling it gone.
    let src = if expected.is_some() {
        // Receipt paths come from a current targeted registry read. A rename
        // after that read is unproved; do not relist a mailbox per source.
        crate::message_store::listed_message(listed_src)
            .map(|(_, blob, _)| blob)
            .unwrap_or_else(|| listed_src.to_path_buf())
    } else {
        match crate::message_store::raw_path_listed(
            vault_root, account_id, mailbox, uid, listed_src,
        ) {
            Some(path) => path,
            None => return CopyOne::VaultGone,
        }
    };
    // The vault file's name, or for a JMAP record's blob the Maildir name of
    // its uid under its flags: the mirror always holds `.eml` files.
    let Some(name) = crate::message_store::copy_name(vault_root, account_id, mailbox, uid, &src)
    else {
        return CopyOne::Failed;
    };
    let dst_name = if name.ends_with(".eml") {
        name
    } else {
        format!("{name}.eml")
    };
    let dst = mirror_cur.join(&dst_name);

    // What the drive already holds for this uid: the listing's entry if it is
    // still there, else a file under the exact destination name (a writer the
    // listing has not seen).
    let existing = listing
        .files
        .get(&uid)
        .filter(|p| p.exists())
        .cloned()
        .or_else(|| dst.exists().then(|| dst.clone()));
    if let Some(expected) = expected {
        let bytes = match std::fs::read(&src) {
            Ok(bytes) => bytes,
            Err(_) => return CopyOne::VaultGone,
        };
        if crate::bulk_worker::bytes_hash(&bytes) != expected {
            return CopyOne::Mismatch;
        }
        if let Some(existing) = existing {
            if std::fs::read(&existing)
                .is_ok_and(|bytes| crate::bulk_worker::bytes_hash(&bytes) == expected)
            {
                listing.files.insert(uid, existing);
                return CopyOne::Present;
            }
            return CopyOne::Mismatch;
        }
        if write_durable(&dst, &bytes).is_err() {
            return CopyOne::Failed;
        }
        if !std::fs::read(&dst)
            .is_ok_and(|bytes| crate::bulk_worker::bytes_hash(&bytes) == expected)
        {
            let _ = std::fs::remove_file(&dst);
            return CopyOne::Failed;
        }
        listing.files.insert(uid, dst);
        return CopyOne::Copied;
    }
    if let Some(existing) = existing {
        return if same_message(&src, &existing) {
            listing.files.insert(uid, existing);
            CopyOne::Present
        } else {
            CopyOne::Mismatch
        };
    }
    listing.files.remove(&uid);

    let bytes = match std::fs::read(&src) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return CopyOne::VaultGone,
        Err(e) => {
            warn!("backup copy: cannot read {:?}: {}", src, e);
            return CopyOne::Failed;
        }
    };
    // The caller's root guard spans the current-name check, durable write,
    // readback and any failed-copy unlink.
    // Durable, not just atomic: the server copy is deleted on the strength of
    // this file, so it must be on the drive, not in the page cache.
    if let Err(e) = write_durable(&dst, &bytes) {
        warn!(
            "backup copy: write to the backup folder failed for uid {}: {}",
            uid, e
        );
        return CopyOne::Failed;
    }
    if !same_message(&src, &dst) {
        warn!(
            "backup copy: the copy of uid {} did not read back the same, removing it",
            uid
        );
        let _ = std::fs::remove_file(&dst);
        return CopyOne::Failed;
    }
    listing.files.insert(uid, dst);
    CopyOne::Copied
}

/// Write `bytes` to `dst` so that it survives a power cut or an unplugged
/// drive once this returns: a temp dotfile beside it, `sync_all` (a full
/// flush to the device on macOS), rename into place, then a sync of the
/// folder so the rename itself is on disk. Only the mirror copy a server
/// delete rests on uses it; `fsx::write_atomic` stays as it is for everyone
/// else. A sync a filesystem does not support (a full flush on some network
/// shares and FUSE mounts, a folder sync on FAT/exFAT drives and on Windows,
/// where a folder cannot be opened this way) is skipped: that drive gets what
/// it got before, never a refusal of every copy. A real I/O error still fails.
fn sync_unsupported(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported)
        || e.raw_os_error() == Some(25) // ENOTTY
}

fn write_durable(dst: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = dst
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "write_durable: path has no file name"))?;
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".tmp-{}-{}", std::process::id(), seq));
    let tmp = dst.with_file_name(tmp_name);
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        match f.sync_all() {
            Err(e) if sync_unsupported(&e) => {
                warn!("backup copy: this drive does not support a full sync ({e}); written without it");
                Ok(())
            }
            other => other,
        }
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, dst) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    #[cfg(unix)]
    if let Some(dir) = dst.parent() {
        if let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
            if !sync_unsupported(&e) {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Whether `copy` holds the message `src` holds: same length and same
/// Message-ID; without an id on either side, the same bytes. An unreadable file
/// on either side is not the same message.
fn same_message(src: &Path, copy: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::metadata(src), std::fs::metadata(copy)) else { return false };
    if a.len() != b.len() {
        return false;
    }
    match (crate::maildir::read_message_id(src), crate::maildir::read_message_id(copy)) {
        (Some(x), Some(y)) => x == y,
        (None, None) => match (std::fs::read(src), std::fs::read(copy)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        },
        _ => false,
    }
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
            special_use_guessed: false,
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

    #[test]
    fn mirror_exclusion_legacy_drain_does_not_block_runtime() {
        use crate::mirror_mutation::MirrorRoot;
        use std::sync::mpsc;
        let vault = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let cur = crate::maildir::mirror_cur(mirror.path(), "me@test", "INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join("7.eml"), b"legacy queued copy").unwrap();
        queue_purge(app.path(), "me@test", "INBOX", &[7]).unwrap();
        let account = serde_json::json!({"email":"me@test", "imapHost":"127.0.0.1", "imapPort":1, "password":"pw"});
        let ctx = BackupRunContext {
            account_id: "acct".into(), account_json: account.to_string(),
            account: serde_json::from_value(account).unwrap(), app_dir: app.path().into(),
            mirror_root: Some(mirror.path().to_str().unwrap().into()), cancel: Arc::default(),
            skip_folders: 0, mailbox_concurrency: 1, limit: None,
            on_progress: Arc::new(|_| {}), apply_flags: Arc::new(|_, _| Ok(Applied::default())),
            archive_ctx: Arc::new(ArchiveCtx {
                root: vault.path().into(), pool: Arc::new(crate::imap::ImapPool::new()),
                gate: Arc::new(|work| work()), registry: Arc::new(VaultRegistry::open(app.path(), vault.path())),
                sinks: crate::archive::ArchiveSinks { emit: Arc::new(|_, _| {}), custody_append: Arc::new(|_, _, _| Ok(0)) },
            }),
        };
        let root = MirrorRoot::resolve(mirror.path()).unwrap();
        let (responsive_tx, responsive_rx) = mpsc::channel();
        std::thread::scope(|threads| {
            root.mutate(|_| {
                threads.spawn(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                    runtime.block_on(async {
                        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
                        let backup = tokio::spawn(async move {
                            entered_tx.send(()).unwrap();
                            // This task must yield its only runtime thread while
                            // the actual queued purge waits for root exclusion.
                            run_imap_account(ctx).await
                        });
                        entered_rx.await.unwrap();
                        let _ = responsive_tx.send(());
                        backup.abort();
                        let _ = backup.await;
                    });
                    // Runtime drop joins the already-started blocking drain.
                });
                responsive_rx.recv_timeout(std::time::Duration::from_secs(2))
                    .expect("actual backup drain blocked the current-thread runtime on the mirror guard");
                Ok(())
            }).unwrap();
        });
        assert!(!cur.join("7.eml").exists());
        assert!(read_purge_queue(app.path()).is_empty());
    }

    #[test]
    fn mirror_exclusion_direct_writer_cannot_replace_checked_bytes() {
        use crate::mirror_mutation::MirrorRoot;
        use std::sync::mpsc;
        let vault = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let root = MirrorRoot::resolve(mirror.path()).unwrap();
        let cur = crate::maildir::mirror_cur(mirror.path(), "me@test", "Projects/Sub").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let checked = cur.join(crate::maildir::mirror_filename(7, &["archived".into()]));
        std::fs::write(&checked, b"checked A").unwrap();
        let account = serde_json::json!({"email":"me@test", "imapHost":"mock", "password":"pw"});
        let ctx = BackupRunContext {
            account_id: "acct".into(), account_json: account.to_string(),
            account: serde_json::from_value(account).unwrap(), app_dir: app.path().into(),
            mirror_root: Some(mirror.path().to_str().unwrap().into()), cancel: Arc::default(),
            skip_folders: 0, mailbox_concurrency: 1, limit: None,
            on_progress: Arc::new(|_| {}), apply_flags: Arc::new(|_, _| Ok(Applied::default())),
            archive_ctx: Arc::new(ArchiveCtx {
                root: vault.path().into(), pool: Arc::new(crate::imap::ImapPool::new()),
                gate: Arc::new(|work| work()), registry: Arc::new(VaultRegistry::open(app.path(), vault.path())),
                sinks: crate::archive::ArchiveSinks { emit: Arc::new(|_, _| {}), custody_append: Arc::new(|_, _, _| Ok(0)) },
            }),
        };
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            root.mutate(|_| {
                assert_eq!(std::fs::read(&checked).unwrap(), b"checked A");
                scope.spawn(move || {
                    attempt_tx.send(()).unwrap();
                    let result = tokio::runtime::Runtime::new().unwrap().block_on(write_backup_copy(
                        &ctx, "Projects/Sub", 7, vec!["archived".into()], b"replacement B".to_vec(),
                        crate::jmap_store::record::ServerIds { email_id: "e7".into(), blob_id: "b7".into(), thread_id: None }, Some(cur),
                    ));
                    done_tx.send(result).unwrap();
                });
                attempt_rx.recv().unwrap();
                assert!(done_rx.recv_timeout(std::time::Duration::from_millis(200)).is_err(),
                    "actual direct writer replaced bytes between check and unlink");
                std::fs::remove_file(&checked).unwrap();
                Ok(())
            }).unwrap();
            assert!(done_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap().unwrap().unwrap().is_ok());
        });
        assert_eq!(std::fs::read(checked).unwrap(), b"replacement B");
    }

    #[test]
    fn mirror_exclusion_presync_refuses_root_removed_between_units() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let cur = mirror.path().join("me@test/Projects/Sub/cur");
        for uid in [1, 2] { std::fs::write(vault.path().join(format!("{uid}.eml")), b"message").unwrap(); }
        let copied = copy_to_backup_at(mirror.path(), vault.path(), &cur, &mut |done| {
            if done == 1 { std::fs::remove_dir_all(mirror.path()).unwrap(); }
            true
        });
        assert_eq!(copied, 1, "a removed root must refuse the next bounded unit");
        assert!(!mirror.path().exists(), "a later unit must not recreate the drive root");
    }

    #[test]
    fn mirror_exclusion_presync_writer_waits_for_checked_unlink() {
        use crate::mirror_mutation::MirrorRoot;
        use std::sync::mpsc;
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let root = MirrorRoot::resolve(mirror.path()).unwrap();
        let cur = mirror.path().join("me@test/Projects/Sub/cur");
        std::fs::create_dir_all(&cur).unwrap();
        let source = vault.path().join("cur");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("7.eml"), b"replacement B").unwrap();
        let checked = cur.join("7.eml");
        std::fs::write(&checked, b"checked A").unwrap();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            root.mutate(|_| {
                assert_eq!(std::fs::read(&checked).unwrap(), b"checked A");
                // Model the checked path becoming the absent destination of a
                // real native writer; its fresh check must wait for this unit.
                std::fs::remove_file(&checked).unwrap();
                let cur = &cur;
                let source = &source;
                let mirror_root = mirror.path();
                scope.spawn(move || {
                    attempt_tx.send(()).unwrap();
                    let copied = copy_to_backup_at(mirror_root, source, cur, &mut |_| true);
                    done_tx.send(copied).unwrap();
                });
                attempt_rx.recv().unwrap();
                assert!(done_rx.recv_timeout(std::time::Duration::from_millis(200)).is_err(),
                    "actual presync writer entered a checked-unlink unit");
                Ok(())
            }).unwrap();
            assert_eq!(done_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap(), 1);
        });
        assert_eq!(std::fs::read(checked).unwrap(), b"replacement B");
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
        let uids = vault_uids_after_presync_at(&reg, "acct", "INBOX", vault.path(), Some(mirror.path()), Some(mirror.path())).unwrap();

        assert!(uids.contains(&42), "the pre-sync must restore the mirror-only uid into the vault before scanning");
    }

    /// An old import the vault moved out of the server's uid range is still
    /// at U in the backup folder: the pre-sync must not copy it back.
    #[test]
    fn vault_uids_after_presync_keeps_a_rehomed_import_out_of_the_server_uid() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let (vault_cur, mirror_cur) = (vault.path().join("INBOX").join("cur"), mirror.path().join("INBOX").join("cur"));
        for cur in [&vault_cur, &mirror_cur] {
            std::fs::create_dir_all(cur).unwrap();
            std::fs::write(cur.join(crate::vault_files::build_maildir_filename(5, &["archived".to_string()])), eml("import@x")).unwrap();
        }
        let server = crate::import_rehome::ServerView::from_headers(&[serde_json::json!({"uid": 5, "messageId": "<real@x>"})]);
        let plan = crate::import_rehome::plan(vault_cur.parent().unwrap(), &server, false, &HashSet::new());
        crate::import_rehome::apply(vault_cur.parent().unwrap(), &plan).unwrap();

        let (_app, reg) = test_registry(vault.path());
        let uids = vault_uids_after_presync_at(&reg, "acct", "INBOX", &vault_cur, Some(mirror.path()), Some(&mirror_cur)).unwrap();

        let b = crate::maildir::IMPORT_UID_BASE;
        assert_eq!(uids, HashSet::from([b]), "U stays free for the server's own message");
        assert_eq!(crate::maildir::mirror_file_map(&mirror_cur).into_keys().collect::<HashSet<_>>(), HashSet::from([b]));
    }

    /// An import copy (at the import uid B) of a message the server now holds
    /// at 5 is set aside by the pass. The mirror still has B: the pre-sync
    /// sets the mirror's copy aside too instead of restoring it into the vault.
    #[test]
    fn vault_uids_after_presync_keeps_a_set_aside_import_copy_out_of_the_vault() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let (vault_cur, mirror_cur) = (vault.path().join("INBOX").join("cur"), mirror.path().join("INBOX").join("cur"));
        let b = crate::maildir::IMPORT_UID_BASE;
        let raw = "Message-ID: <m@x>\r\nSubject: Hi\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\nbody\r\n";
        for cur in [&vault_cur, &mirror_cur] {
            std::fs::create_dir_all(cur).unwrap();
            for uid in [5, b] {
                std::fs::write(cur.join(crate::vault_files::build_maildir_filename(uid, &["archived".to_string()])), raw).unwrap();
            }
        }
        let row = serde_json::json!({"uid": 5, "messageId": "<m@x>", "subject": "Hi", "messageDate": "Mon, 1 Jan 2024 10:00:00 +0000"});
        let server = crate::import_rehome::ServerView::from_headers(&[row]);
        let plan = crate::import_rehome::plan(vault_cur.parent().unwrap(), &server, false, &HashSet::new());
        assert_eq!(crate::import_rehome::apply(vault_cur.parent().unwrap(), &plan).unwrap().set_aside, vec![b]);

        let (_app, reg) = test_registry(vault.path());
        let uids = vault_uids_after_presync_at(&reg, "acct", "INBOX", &vault_cur, Some(mirror.path()), Some(&mirror_cur)).unwrap();

        assert_eq!(uids, HashSet::from([5]), "the import copy stays out of the vault");
        assert_eq!(crate::maildir::mirror_file_map(&mirror_cur).into_keys().collect::<HashSet<_>>(), HashSet::from([5]));
        assert!(mirror.path().join("INBOX").join(crate::maildir::ORPHAN_DIR).read_dir().unwrap().next().is_some(), "set aside in the mirror, not deleted");
    }

    // ── contacts safety copy ─────────────────────────────────────────────────

    fn open_gate() -> crate::archive::ArchiveGate {
        Arc::new(|f: &mut dyn FnMut() -> Result<(), String>| f())
    }

    fn contacts_file(root: &Path) -> PathBuf {
        root.join("Contacts").join("contacts.vcf")
    }

    #[test]
    fn contacts_vcf_round_trips_through_the_backup_mirror() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("Contacts")).unwrap();
        std::fs::write(contacts_file(vault.path()), b"BEGIN:VCARD\nFN:Al\nEND:VCARD\n").unwrap();

        mirror_contacts(vault.path(), mirror.path(), &open_gate()).unwrap();
        assert_eq!(std::fs::read(contacts_file(mirror.path())).unwrap(), b"BEGIN:VCARD\nFN:Al\nEND:VCARD\n");

        // A changed vault copy replaces the drive copy: custody is the truth.
        std::fs::write(contacts_file(vault.path()), b"BEGIN:VCARD\nFN:Bo\nEND:VCARD\n").unwrap();
        mirror_contacts(vault.path(), mirror.path(), &open_gate()).unwrap();
        assert_eq!(std::fs::read(contacts_file(mirror.path())).unwrap(), b"BEGIN:VCARD\nFN:Bo\nEND:VCARD\n");

        // A fresh vault with no copy gets the drive copy back, and keeps it afterwards.
        let fresh = tempfile::tempdir().unwrap();
        mirror_contacts(fresh.path(), mirror.path(), &open_gate()).unwrap();
        assert_eq!(std::fs::read(contacts_file(fresh.path())).unwrap(), b"BEGIN:VCARD\nFN:Bo\nEND:VCARD\n");
        std::fs::write(contacts_file(fresh.path()), b"BEGIN:VCARD\nFN:Cy\nEND:VCARD\n").unwrap();
        mirror_contacts(fresh.path(), mirror.path(), &open_gate()).unwrap();
        assert_eq!(std::fs::read(contacts_file(mirror.path())).unwrap(), b"BEGIN:VCARD\nFN:Cy\nEND:VCARD\n");
    }

    #[test]
    fn mirror_exclusion_contacts_cannot_recreate_an_absent_drive() {
        let vault = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("absent-drive");
        std::fs::create_dir_all(vault.path().join("Contacts")).unwrap();
        std::fs::write(vault.path().join("Contacts/contacts.vcf"), b"contacts").unwrap();
        let gate: crate::archive::ArchiveGate = std::sync::Arc::new(|work| work());
        assert!(mirror_contacts(vault.path(), &missing, &gate).is_err());
        assert!(!missing.exists(), "contacts must not make an internal replacement for an absent drive");
    }

    #[test]
    fn contacts_mirror_does_nothing_when_neither_side_has_a_copy() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        mirror_contacts(vault.path(), mirror.path(), &open_gate()).unwrap();
        assert!(!vault.path().join("Contacts").exists());
        assert!(!mirror.path().join("Contacts").exists());
    }

    fn unsafe_mirror_fixture(email: &str, mailbox: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("mirror");
        std::fs::create_dir_all(root.join(MAIL)).unwrap();
        let cur = root.join(email).join(mailbox).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        let sentinel = cur.join(crate::maildir::mirror_filename(42, &[]));
        std::fs::write(&sentinel, b"outside mail must survive").unwrap();
        (temp, root, sentinel)
    }

    #[test]
    fn purge_uids_rejects_unsafe_mirror_names() {
        for (email, mailbox) in [(MAIL, "../../outside"), ("../outside", BOX)] {
            let (temp, root, sentinel) = unsafe_mirror_fixture(email, mailbox);
            let data = temp.path().join("data");
            assert!(purge_uids(&data, Some(&root), Some("available"), email, mailbox, &[42]).is_err());
            assert_eq!(std::fs::read(&sentinel).unwrap(), b"outside mail must survive");
            assert!(purge_uids(&data, None, Some("unavailable"), email, mailbox, &[42]).is_err());
            assert!(read_purge_queue(&data).is_empty());
        }
    }

    #[test]
    fn mirror_copy_rejects_unsafe_mirror_names_before_creating_dirs() {
        for (email, mailbox) in [(MAIL, "../../outside"), ("../outside", BOX)] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("mirror");
            std::fs::create_dir_all(&root).unwrap();
            let outcome = copy_uids_to_mirror(temp.path(), &root, ACCT, email, mailbox, &[42]);
            assert!(outcome.is_err(), "unsafe destination must fail before copy");
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
            assert!(!temp.path().join("outside").exists());
        }
    }

    #[test]
    fn scan_uids_does_not_read_unsafe_mirror_names_outside_mirror() {
        for (email, mailbox) in [(MAIL, "../../outside"), ("../outside", BOX)] {
            let (_temp, root, sentinel) = unsafe_mirror_fixture(email, mailbox);
            assert_eq!(scan_uids(Some(&root), email, mailbox), None);
            assert_eq!(std::fs::read(sentinel).unwrap(), b"outside mail must survive");
        }
    }

    #[test]
    fn drain_purge_queue_does_not_touch_unsafe_mirror_names_escaped_mail() {
        for (email, mailbox) in [(MAIL, "../../outside"), ("../outside", BOX)] {
            let (temp, root, sentinel) = unsafe_mirror_fixture(email, mailbox);
            let data = temp.path().join("data");
            let valid_cur = root.join(MAIL).join(BOX).join("cur");
            std::fs::create_dir_all(&valid_cur).unwrap();
            let valid = valid_cur.join(crate::maildir::mirror_filename(7, &[]));
            std::fs::write(&valid, b"valid queued mail").unwrap();
            let bad_key = format!("{email}|{mailbox}");
            let queue = std::collections::BTreeMap::from([(bad_key.clone(), vec![42]), (format!("{MAIL}|{BOX}"), vec![7])]);
            write_purge_queue(&data, &queue).unwrap();
            assert_eq!(drain_purge_queue(&data, &root), 1);
            assert_eq!(std::fs::read(sentinel).unwrap(), b"outside mail must survive");
            assert!(!valid.exists());
            assert_eq!(read_purge_queue(&data), std::collections::BTreeMap::from([(bad_key, vec![42])]));
        }
    }

    #[test]
    fn scan_uids_does_not_confirm_a_missing_mirror_is_empty() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(scan_uids(Some(&temp.path().join("unplugged")), MAIL, BOX), None);
    }

    #[tokio::test]
    async fn mirror_status_rejects_unsafe_names_instead_of_reporting_zero() {
        let temp = tempfile::tempdir().unwrap();
        for (email, mailbox) in [(MAIL, "../outside"), ("../outside", BOX)] {
            assert_eq!(build_folder_status(mailbox, "outside", 1, temp.path(), ACCT, Some(temp.path()), email, vec![]).await.err().as_deref(), Some("errors.backupUnsafePath"));
        }
        let safe = build_folder_status(BOX, BOX, 1, temp.path(), ACCT, Some(temp.path()), MAIL, vec![]).await.unwrap();
        assert_eq!(safe.external_count, 0);
    }

    // ── purge queue ──────────────────────────────────────────────────────────

    fn protected_offline_replacement_case(original: &[u8], replacement: &[u8]) {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let native = tempfile::tempdir().unwrap();
        let source = native.path().join("7.eml");
        std::fs::write(&source, original).unwrap();
        // A native artifact selected before deletion supplies the exact proof.
        let proof = crate::bulk_worker::StoredProof {
            uid: 7, name: "7.eml".into(),
            sha256: crate::bulk_worker::bytes_hash(&std::fs::read(&source).unwrap()),
        };
        assert_ne!(proof.sha256, crate::bulk_worker::bytes_hash(replacement));
        let bound = crate::app_db::ops::MirrorPurgeProof::server("me@test", &crate::bulk::Group {
            account_id:"account".into(),mailbox:"INBOX".into(),uids:vec![7],
        }, &"a".repeat(64), &crate::bulk_worker::Identity::Imap {validity:19,message_ids:Default::default()}, &proof).unwrap();
        let queued = purge_proved(app.path(),None,Some("unavailable"),bound.target(),Some(&bound));
        assert_eq!(queued,ProvedPurgeOutcome::Queued);
        std::fs::remove_file(source).unwrap();
        let cur = crate::maildir::mirror_cur(mirror.path(), "me@test", "INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let candidate = cur.join(crate::maildir::mirror_filename(7, &[]));
        std::fs::write(&candidate, replacement).unwrap();
        let removed = drain_purge_queue(app.path(), mirror.path());
        assert!(candidate.exists(), "queued original A must never erase replacement B");
        assert_eq!(std::fs::read(candidate).unwrap(), replacement);
        assert_eq!(removed, 0);
        let items = protected_items(app.path());
        assert_eq!(items.len(),1);
        assert_eq!(items[0].proved().unwrap(),bound);
    }

    #[test]
    fn protected_purge_offline_replacement_preserves_new_bytes() {
        protected_offline_replacement_case(b"Message-ID: <A@test>\r\n\r\noriginal", b"Message-ID: <B@test>\r\n\r\nreplacement");
    }

    #[test]
    fn protected_purge_same_mid_same_length_replacement_preserves_new_bytes() {
        let a = b"Message-ID: <same@test>\r\n\r\nbody A";
        let b = b"Message-ID: <same@test>\r\n\r\nbody B";
        assert_eq!(a.len(), b.len());
        protected_offline_replacement_case(a, b);
    }


    fn protected_native_proof(uid: u32, raw: &[u8]) -> crate::app_db::ops::MirrorPurgeProof {
        crate::app_db::ops::MirrorPurgeProof::server("me@test", &crate::bulk::Group {
            account_id: "account".into(), mailbox: "INBOX".into(), uids: vec![uid],
        }, &"a".repeat(64), &crate::bulk_worker::Identity::Imap {
            validity: 19, message_ids: Default::default(),
        }, &crate::bulk_worker::StoredProof {uid, name:format!("{uid}.eml"), sha256:crate::bulk_worker::bytes_hash(raw)}).unwrap()
    }

    fn protected_items(app: &Path) -> Vec<crate::app_db::ops::PurgeItem> {
        crate::app_db::with(app, crate::app_db::ops::purge_items).unwrap()
    }

    fn protected_seed(app: &Path, proof: &crate::app_db::ops::MirrorPurgeProof) {
        assert_eq!(purge_proved(app, None, Some("unavailable"), proof.target(), Some(proof)), ProvedPurgeOutcome::Queued);
    }

    #[test]
    fn protected_purge_exact_and_flag_renamed_duplicates_drain_after_reopen() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7, b"A");
        // Use independent SQLite connections across the persisted handoff.
        { let c = crate::app_db::db::open(app.path()).unwrap(); crate::app_db::ops::purge_enqueue_proved(&c, &proof).unwrap(); }
        let c = crate::app_db::db::open(app.path()).unwrap();
        assert_eq!(crate::app_db::ops::purge_items(&c).unwrap()[0].proved().unwrap(), proof);
        drop(c);
        let cur = crate::maildir::mirror_cur(mirror.path(), "me@test", "INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        for name in ["7.eml", "7_S.eml", "7;2,F.eml"] { std::fs::write(cur.join(name), b"A").unwrap(); }
        std::fs::rename(cur.join("7_S.eml"), cur.join("7_F.eml")).unwrap();
        assert_eq!(drain_purge_queue(app.path(), mirror.path()), 3);
        assert!(protected_items(app.path()).is_empty());
        assert_eq!(drain_purge_queue(app.path(), mirror.path()), 0);
        assert_eq!(std::fs::read_dir(cur).unwrap().count(), 0);
    }

    #[test]
    fn protected_purge_immediate_and_delayed_check_every_same_uid_candidate() {
        for online in [true,false] {
            let app = tempfile::tempdir().unwrap();
            let mirror = tempfile::tempdir().unwrap();
            let proof = protected_native_proof(7,b"A");
            let cur = crate::maildir::mirror_cur(mirror.path(), "me@test", "INBOX").unwrap();
            std::fs::create_dir_all(&cur).unwrap();
            for name in ["7.eml", "7_S.eml"] { std::fs::write(cur.join(name), b"A").unwrap(); }
            std::fs::write(cur.join("7_F.eml"), b"B").unwrap();
            std::fs::write(cur.join("8.eml"), b"A").unwrap();
            if online {
                assert_eq!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
                    ProvedPurgeOutcome::Unresolved{removed:2,reason:MirrorPurgeIssue::Mismatch});
            } else {
                protected_seed(app.path(),&proof);
                assert_eq!(drain_purge_queue(app.path(), mirror.path()),2);
            }
            assert!(!cur.join("7.eml").exists());
            assert!(!cur.join("7_S.eml").exists());
            assert_eq!(std::fs::read(cur.join("7_F.eml")).unwrap(),b"B");
            assert!(cur.join("8.eml").exists());
            assert_eq!(protected_items(app.path()).len(),1);
        }
    }

    #[test]
    fn protected_purge_empty_listing_completes_but_missing_or_failed_listing_does_not() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let cur = crate::maildir::mirror_cur(mirror.path(), "me@test", "INBOX").unwrap();
        protected_seed(app.path(),&proof);
        assert_eq!(drain_purge_queue(app.path(),mirror.path()),0);
        assert_eq!(protected_items(app.path()).len(),1);
        std::fs::create_dir_all(cur.parent().unwrap()).unwrap();
        std::fs::write(&cur,b"not a directory").unwrap();
        assert!(matches!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
            ProvedPurgeOutcome::Unresolved{reason:MirrorPurgeIssue::Listing,..}));
        assert_eq!(protected_items(app.path()).len(),1);
        std::fs::remove_file(&cur).unwrap();
        std::fs::create_dir(&cur).unwrap();
        assert_eq!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
            ProvedPurgeOutcome::Removed{files:0});
        assert!(protected_items(app.path()).is_empty());
    }

    #[test]
    fn protected_purge_unreadable_candidate_preserves_unresolved_obligation() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(cur.join("7.eml")).unwrap();
        assert_eq!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
            ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::Read});
        assert!(cur.join("7.eml").is_dir());
        assert_eq!(protected_items(app.path()).len(),1);
    }

    #[test]
    fn protected_purge_missing_proof_and_unconfigured_never_claim_queue() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        assert_eq!(purge_proved(app.path(),None,Some("not_configured"),proof.target(),Some(&proof)),ProvedPurgeOutcome::Unconfigured);
        assert_eq!(purge_proved(app.path(),None,None,proof.target(),None),ProvedPurgeOutcome::Unconfigured);
        for root in [None,Some(mirror.path())] {
            assert_eq!(purge_proved(app.path(),root,Some("unavailable"),proof.target(),None),
                ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::MissingProof});
        }
        assert!(protected_items(app.path()).is_empty());
        assert_eq!(purge_proved(app.path(),Some(&mirror.path().join("missing")),Some("unavailable"),proof.target(),Some(&proof)),
            ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::Unavailable});
        assert_eq!(protected_items(app.path()).len(),1);
    }

    #[test]
    fn protected_purge_failed_persistence_never_claims_queued() {
        let app = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let original = b"unreadable database evidence";
        std::fs::write(app.path().join("app.db"),original).unwrap();
        assert_eq!(purge_proved(app.path(),None,Some("unavailable"),proof.target(),Some(&proof)),
            ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::Storage});
        assert_eq!(std::fs::read(app.path().join("app.db")).unwrap(),original);
    }

    #[test]
    fn protected_purge_legacy_overlap_and_conflicting_proof_refuse_before_unlink() {
        for legacy in [true,false] {
            let app = tempfile::tempdir().unwrap();
            let mirror = tempfile::tempdir().unwrap();
            let proof = protected_native_proof(7,b"A");
            let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
            std::fs::create_dir_all(&cur).unwrap();
            std::fs::write(cur.join("7.eml"),b"A").unwrap();
            if legacy { queue_purge(app.path(),"me@test","INBOX",&[7]).unwrap(); }
            else { protected_seed(app.path(),&protected_native_proof(7,b"B")); }
            let before = protected_items(app.path());
            assert_eq!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
                ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::Conflict});
            assert_eq!(std::fs::read(cur.join("7.eml")).unwrap(),b"A");
            assert_eq!(protected_items(app.path()),before);
        }
    }

    fn protected_nested_unknown_case(nested: &str) {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let mut value = serde_json::to_value(&proof).unwrap();
        let boundary = if nested == "artifact" { &mut value["artifact"] } else { &mut value["provenance"]["identity"] };
        boundary["futureConstraint"] = serde_json::json!("opaque original evidence");
        let raw = value.to_string();
        crate::app_db::with(app.path(),|c| c.execute(
            "INSERT INTO pending_backup_purge(scope,uid,proof_json) VALUES ('me@test|INBOX',7,?1)",[&raw]
        ).map(|_|()).map_err(|e|e.to_string())).unwrap();
        let before = protected_items(app.path());
        let interpreted = before[0].proved();
        let enqueued = crate::app_db::with(app.path(),|c| crate::app_db::ops::purge_enqueue_proved(c,&proof)).unwrap();
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let candidate = cur.join("7.eml");
        std::fs::write(&candidate,b"A").unwrap();
        // Exercise every real path before asserting, so RED captures the
        // unsafe interpretation, enqueue match, unlink and lost raw evidence.
        let removed = drain_purge_queue(app.path(),mirror.path());
        let remaining = protected_items(app.path());
        let surviving = std::fs::read(candidate).ok();
        assert!(interpreted.is_err(), "unknown {nested} accepted: enqueue={enqueued:?}, removed={removed}, remaining={remaining:?}, surviving={surviving:?}");
        assert_eq!(enqueued,crate::app_db::ops::PurgeEnqueue::Conflict);
        assert_eq!(removed,0);
        assert_eq!(surviving.as_deref(),Some(b"A".as_slice()));
        assert_eq!(remaining,before);
        assert_eq!(remaining[0].proof_json.as_deref(),Some(raw.as_str()));
    }

    #[test]
    fn protected_nested_artifact_unknown_field_preserves_raw_obligation() {
        protected_nested_unknown_case("artifact");
    }

    #[test]
    fn protected_nested_identity_unknown_field_preserves_raw_obligation() {
        protected_nested_unknown_case("identity");
    }

    #[test]
    fn protected_purge_malformed_future_and_wrong_binding_stay_inspectable() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let mut future = serde_json::to_value(&proof).unwrap();
        future["version"] = serde_json::json!(999);
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join("7.eml"),b"A").unwrap();
        for raw in ["{broken".into(),future.to_string(),serde_json::to_string(&protected_native_proof(8,b"A")).unwrap()] {
            crate::app_db::with(app.path(),|c| c.execute("INSERT OR REPLACE INTO pending_backup_purge(scope,uid,proof_json) VALUES ('me@test|INBOX',7,?1)",[&raw]).map(|_|()).map_err(|e|e.to_string())).unwrap();
            assert_eq!(drain_purge_queue(app.path(),mirror.path()),0);
            assert_eq!(protected_items(app.path())[0].proof_json.as_deref(),Some(raw.as_str()));
            assert_eq!(std::fs::read(cur.join("7.eml")).unwrap(),b"A");
        }
    }

    thread_local! {
        static BEFORE_PROVED_UNLINK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    }
    pub(super) fn protected_before_unlink() {
        BEFORE_PROVED_UNLINK.with(|hook| { if let Some(work) = hook.borrow_mut().take() { work(); } });
    }

    #[test]
    fn protected_purge_real_drain_excludes_native_writer_through_unlink() {
        use std::sync::mpsc;
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        protected_seed(app.path(),&proof);
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let name = crate::maildir::mirror_filename(7,&[]);
        let candidate = cur.join(&name);
        std::fs::write(&candidate,b"A").unwrap();
        let root = mirror.path().to_str().unwrap().to_string();
        let db_dir = app.path().to_path_buf();
        let (attempt_tx,attempt_rx) = mpsc::channel();
        let (done_tx,done_rx) = mpsc::channel();
        let writer = std::rc::Rc::new(std::cell::RefCell::new(None));
        let keep_writer = writer.clone();
        BEFORE_PROVED_UNLINK.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
            // Reaching app.db here proves the mirror phase released its DB snapshot.
            let (db_tx,db_rx) = mpsc::channel();
            std::thread::spawn(move || db_tx.send(crate::app_db::with(&db_dir,crate::app_db::ops::purge_items)).unwrap());
            assert_eq!(db_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap().unwrap().len(),1);
            *keep_writer.borrow_mut() = Some(std::thread::spawn(move || {
                attempt_tx.send(()).unwrap();
                let result = write_direct_mirror(Some(&root),&cur,&name,b"B");
                let _ = done_tx.send(());
                result
            }));
            attempt_rx.recv().unwrap();
            assert!(done_rx.recv_timeout(std::time::Duration::from_millis(200)).is_err(),
                "real native writer replaced checked bytes before actual purge unlink");
        })));
        assert_eq!(drain_purge_queue(app.path(),mirror.path()),1);
        writer.borrow_mut().take().unwrap().join().unwrap().unwrap();
        assert_eq!(std::fs::read(candidate).unwrap(),b"B");
        assert!(protected_items(app.path()).is_empty());
    }

    #[test]
    fn protected_purge_stale_ack_retains_changed_and_concurrent_queue_evidence() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join("7.eml"),b"A").unwrap();
        let app_dir = app.path().to_path_buf();
        BEFORE_PROVED_UNLINK.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
            crate::app_db::with(&app_dir,|c| {
                c.execute("UPDATE pending_backup_purge SET proof_json='changed future proof' WHERE uid=7",[]).map_err(|e|e.to_string())?;
                crate::app_db::ops::purge_append_legacy(c,&std::collections::BTreeMap::from([("other|Sent".into(),vec![9])]))
            }).unwrap();
        })));
        assert_eq!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
            ProvedPurgeOutcome::Unresolved{removed:1,reason:MirrorPurgeIssue::Acknowledgement});
        let rows = protected_items(app.path());
        assert_eq!(rows.len(),2);
        assert_eq!(rows.iter().find(|r|r.uid==7).unwrap().proof_json.as_deref(),Some("changed future proof"));
        assert!(rows.iter().any(|r|r.uid==9 && r.proof_json.is_none()));
    }

    #[test]
    fn protected_purge_cancel_stops_between_targets_and_retains_next_item() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        for uid in [7,8] {
            protected_seed(app.path(),&protected_native_proof(uid,b"A"));
            std::fs::write(cur.join(format!("{uid}.eml")),b"A").unwrap();
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        BEFORE_PROVED_UNLINK.with(|hook| *hook.borrow_mut() = Some(Box::new(move || signal.store(true,Ordering::Relaxed))));
        assert_eq!(drain_purge_queue_cancelled(app.path(),mirror.path(),&cancel),1);
        assert!(!cur.join("7.eml").exists());
        assert!(cur.join("8.eml").exists());
        assert_eq!(protected_items(app.path()).iter().map(|r|r.uid).collect::<Vec<_>>(),vec![8]);
    }

    #[test]
    fn protected_purge_failed_unlink_preserves_file_and_obligation() {
        let app = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let proof = protected_native_proof(7,b"A");
        let cur = crate::maildir::mirror_cur(mirror.path(),"me@test","INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let candidate = cur.join("7.eml");
        std::fs::write(&candidate,b"A").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let old = std::fs::metadata(&cur).unwrap().permissions();
            std::fs::set_permissions(&cur,std::fs::Permissions::from_mode(0o500)).unwrap();
            let out = purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof));
            std::fs::set_permissions(&cur,old).unwrap();
            assert_eq!(out,ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::Remove});
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&candidate).unwrap();
            assert_eq!(purge_proved(app.path(),Some(mirror.path()),Some("ready"),proof.target(),Some(&proof)),
                ProvedPurgeOutcome::Unresolved{removed:0,reason:MirrorPurgeIssue::Remove});
            drop(held);
        }
        assert_eq!(std::fs::read(candidate).unwrap(),b"A");
        assert_eq!(protected_items(app.path()).len(),1);
        assert_eq!(drain_purge_queue(app.path(),mirror.path()),1);
        assert!(protected_items(app.path()).is_empty());
    }

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
    // builds its own `GraphClient::for_purpose(.., "backup")` and makes real HTTP
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

        let p = crate::maildir::INFO_PREFIX;
        std::fs::write(app.join(format!("101{p}SF.eml")), b"seen+flagged").unwrap();
        std::fs::write(ext.join(format!("202{p}S.eml")), b"seen").unwrap();
        std::fs::write(ext.join("303.eml"), b"legacy").unwrap();

        assert_eq!(sync_locations(&app, &ext).0, 3);

        assert!(ext.join(format!("101{p}SF.eml")).exists(), "flags lost vault → mirror");
        assert!(app.join(format!("202{p}AS.eml")).exists(), "flags lost mirror → vault");
        assert!(app.join(format!("303{p}A.eml")).exists(), "legacy backup did not restore");

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
        let p = crate::maildir::INFO_PREFIX;
        std::fs::write(orphaned.join(format!("4{p}.eml")), eml("strictseal@old-host.test")).unwrap();
        // The mirror still holds the same message under the same old uid.
        std::fs::write(ext.join(format!("4{p}.eml")), eml("strictseal@old-host.test")).unwrap();
        // ...and a genuinely missing message the restore SHOULD bring back.
        std::fs::write(ext.join(format!("7{p}S.eml")), eml("still-on-this-server@mock.test")).unwrap();

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

        let p = crate::maildir::INFO_PREFIX;
        std::fs::write(orphaned.join(format!("4{p}.eml")), eml("set-aside@old-host.test")).unwrap();
        std::fs::write(ext.join(format!("9{p}.eml")), b"From: a@b.test\r\nSubject: no id\r\n\r\nbody".to_vec()).unwrap();

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

        std::fs::write(ext.join(format!("11{}S.eml", crate::maildir::INFO_PREFIX)), eml("fresh@mock.test")).unwrap();

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
        std::fs::write(cur.join(format!("11{}S.eml", crate::maildir::INFO_PREFIX)), b"a").unwrap();
        std::fs::write(cur.join("12.eml"), b"b").unwrap();
        std::fs::write(cur.join("13_S.eml"), b"c").unwrap();
        std::fs::write(cur.join("not-a-uid.eml"), b"d").unwrap();

        let uids = scan_external_uids(tmp.path(), "luke@mock.test", "INBOX").unwrap();
        assert_eq!(uids.len(), 3);
        for uid in [11u32, 12, 13] {
            assert!(uids.contains(&uid), "missing uid {}", uid);
        }

        // A mailbox with no mirror directory is empty, not an error.
        assert!(scan_external_uids(tmp.path(), "luke@mock.test", "Sent").unwrap().is_empty());
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
                let uid_str = name.split(|c: char| c == crate::maildir::INFO_SEP || c == '.' || c == '_').next().unwrap_or(&name);
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
                let uid_str = name.split(|c: char| c == crate::maildir::INFO_SEP || c == '.' || c == '_').next().unwrap_or(&name);
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
        let p = crate::maildir::INFO_PREFIX;
        for name in [
            format!("101{p}SF.eml"), // vault only: mirrored under its own name
            format!("102{p}S"),      // vault only, no extension: mirrored as .eml
            "103_S.eml".to_string(), // legacy name in the vault: mirrored, then restored as 103:2,A.eml
            format!("104{p}S.eml"),  // mirror holds 104.eml: nothing moves
            format!("105{p}F.eml"),  // mirror holds 105_S.eml: nothing moves
            format!("07{p}S.eml"),   // mirror side reads 7, vault side does not
            format!("300{p}S.eml"),  // the mirror's directory named 300.eml counts as a copy
            "notes.txt".to_string(),
            "_meta.json".to_string(),
        ] {
            fs::write(app.join(&name), format!("app {}", name)).unwrap();
        }
        fs::create_dir_all(app.join("400")).unwrap();
        for name in [
            format!("202{p}S.eml"), // mirror only: restored with its flags, plus archived
            "203.eml".to_string(),  // legacy flagless: restored as 203:2,A.eml
            "204_S.eml".to_string(), // legacy underscore: restored, flags not parsed
            format!("205{p}F"),     // no .eml: never restored
            "08.eml".to_string(),   // restored as 8:2,A.eml
            "104.eml".to_string(),
            "105_S.eml".to_string(),
            format!("7{p}S.eml"), // the vault's 07:2,S.eml is not uid 7: restored
            format!(".4711{p}S.eml.tmp-1"),
        ] {
            fs::write(ext.join(&name), format!("ext {}", name)).unwrap();
        }
        fs::create_dir_all(ext.join("300.eml")).unwrap();
        fs::write(ext.join("206.eml"), eml("set-aside@old-host.test")).unwrap();
        fs::write(orphaned.join(format!("206{p}.eml")), eml("set-aside@old-host.test")).unwrap();
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
        let p = crate::maildir::INFO_PREFIX;
        for name in [
            format!("202{p}AS.eml"), format!("203{p}A.eml"), format!("204{p}A.eml"), format!("8{p}A.eml"),
            format!("7{p}AS.eml"), format!("103{p}A.eml"), format!("207{p}A.eml"),
        ] {
            assert!(app_names.contains(&name), "not restored: {name} in {app_names:?}");
        }
        for name in [
            format!("206{p}.eml"), format!("205{p}F.eml"), format!("205{p}.eml"), format!("104{p}.eml"), format!("105{p}.eml"),
            format!("206{p}A.eml"), format!("205{p}AF.eml"), format!("104{p}A.eml"), format!("105{p}A.eml"),
        ] {
            assert!(!app_names.contains(&name), "restored but should not be: {name}");
        }
        for name in [format!("101{p}SF.eml"), format!("102{p}S.eml"), "103_S.eml".to_string()] {
            assert!(ext_names.contains(&name), "not mirrored: {name} in {ext_names:?}");
        }
        for name in [format!("104{p}S.eml"), format!("105{p}F.eml"), format!("07{p}S.eml"), format!("300{p}S.eml")] {
            assert!(!ext_names.contains(&name), "mirrored but should not be: {name}");
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
        let p = crate::maildir::INFO_PREFIX;
        std::fs::write(app.join(format!("209{p}S.eml")), b"a").unwrap();
        std::fs::write(app.join("209_S.eml"), b"b").unwrap();
        std::fs::write(ext.join("208.eml"), b"c").unwrap();
        std::fs::write(ext.join(format!("208{p}S.eml")), b"d").unwrap();

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
        assert!(vault_uids_after_presync_at(&reg, "acct", "INBOX", &app, None, None).unwrap().is_empty());

        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join(format!("5{}S.eml", crate::maildir::INFO_PREFIX)), eml("in-the-vault@mock.test")).unwrap();
        assert_eq!(vault_uids_after_presync_at(&reg, "acct", "INBOX", &app, None, None).unwrap(), HashSet::from([5]));
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

        vault_uids_after_presync_at(&reg, "acct", "INBOX", &cur, Some(&root.join("mirror")), Some(&mirror)).unwrap();
        assert_eq!(reg.uid_sets(root, "acct", "INBOX"), Some((vec![42], vec![42])), "restored copies carry `A`");
        assert_eq!(reg.listing_count(), 2);

        crate::vault_files::store(&reg, root, "acct", "INBOX", 7, b"seven", &[], true).unwrap();
        vault_uids_after_presync_at(&reg, "acct", "INBOX", &cur, Some(&root.join("mirror")), Some(&mirror)).unwrap();
        assert!(mirror.join(format!("7{}.eml", crate::maildir::INFO_PREFIX)).exists(), "the vault-only uid went to the mirror");
        assert_eq!(reg.uid_sets(root, "acct", "INBOX"), Some((vec![7, 42], vec![42])));
        assert_eq!(reg.listing_count(), 2, "a mirror-only copy leaves the folder verified");
    }

    fn seed_mirror(root: &Path, email: &str, mailbox: &str, names: &[String]) {
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
        let p = crate::maildir::INFO_PREFIX;
        // The three shapes the mirror has carried over its lifetime.
        seed_mirror(root, "me@x.test", "INBOX.Spam", &[
            format!("101{p}S.eml"), "102.eml".to_string(), "103_S.eml".to_string(), format!("104{p}S.eml"), format!("1010{p}S.eml"),
        ]);

        let uids: HashSet<u32> = [101u32, 102, 103].into_iter().collect();
        let removed = purge_backup_files(root, "me@x.test", "INBOX.Spam", &uids).unwrap();

        let cur = root.join("me@x.test").join("INBOX.Spam").join("cur");
        assert_eq!(removed, 3);
        assert!(!cur.join(format!("101{p}S.eml")).exists());
        assert!(!cur.join("102.eml").exists());
        assert!(!cur.join("103_S.eml").exists());
        assert!(cur.join(format!("104{p}S.eml")).exists());
        assert!(cur.join(format!("1010{p}S.eml")).exists(), "1010 must survive a purge of 101");
    }

    #[test]
    fn purge_backup_files_on_a_missing_mirror_dir_removes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let uids: HashSet<u32> = [1u32].into_iter().collect();
        assert_eq!(purge_backup_files(tmp.path(), "me@x.test", "INBOX", &uids).unwrap(), 0);
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
    fn drain_retains_malformed_key_but_still_drains_valid_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dd = tmp.path().join("data");
        let root = tmp.path().join("mirror");
        std::fs::create_dir_all(&dd).unwrap();
        seed_mirror(&root, "me@x.test", "INBOX", &[format!("4{}S.eml", crate::maildir::INFO_PREFIX)]);

        let mut q: std::collections::BTreeMap<String, Vec<u32>> = Default::default();
        q.insert("malformed-no-pipe".to_string(), vec![1, 2]);
        q.insert("me@x.test|INBOX".to_string(), vec![4]);
        write_purge_queue(&dd, &q).unwrap();

        let removed = drain_purge_queue(&dd, &root);

        assert_eq!(removed, 1, "the well-formed entry must still drain");
        assert!(!root.join("me@x.test").join("INBOX").join("cur").join(format!("4{}S.eml", crate::maildir::INFO_PREFIX)).exists());
        assert_eq!(
            read_purge_queue(&dd),
            std::collections::BTreeMap::from([("malformed-no-pipe".to_string(), vec![1, 2])]),
            "unresolved evidence stays exact while the valid queue entry is removed"
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

    // ── copy_uids_to_mirror ──────────────────────────────────────────────────

    const ACCT: &str = "acct-1";
    const MAIL: &str = "me@x.test";
    const BOX: &str = "INBOX";

    struct CopyFx {
        vault: tempfile::TempDir,
        mirror: tempfile::TempDir,
    }

    impl CopyFx {
        fn new() -> Self {
            Self { vault: tempfile::tempdir().unwrap(), mirror: tempfile::tempdir().unwrap() }
        }
        fn vault_cur(&self) -> PathBuf {
            crate::vault_files::cur_path(self.vault.path(), ACCT, BOX)
        }
        fn mirror_cur(&self) -> PathBuf {
            self.mirror.path().join(MAIL).join(BOX).join("cur")
        }
        /// An archived vault copy (`A` in its name), named the way the archive names it.
        fn vault_msg(&self, uid: u32, id: &str, body: &str) -> PathBuf {
            self.vault_file(uid, &["archived", "seen"], id, body)
        }
        fn vault_file(&self, uid: u32, flags: &[&str], id: &str, body: &str) -> PathBuf {
            let cur = self.vault_cur();
            std::fs::create_dir_all(&cur).unwrap();
            let flags: Vec<String> = flags.iter().map(|f| f.to_string()).collect();
            let path = cur.join(crate::vault_files::build_maildir_filename(uid, &flags));
            std::fs::write(&path, mail_bytes(id, body)).unwrap();
            path
        }
        fn mirror_file(&self, name: &str, id: &str, body: &str) -> PathBuf {
            let cur = self.mirror_cur();
            std::fs::create_dir_all(&cur).unwrap();
            let path = cur.join(name);
            std::fs::write(&path, mail_bytes(id, body)).unwrap();
            path
        }
        fn copy(&self, uids: &[u32]) -> Result<MirrorCopyOutcome, String> {
            copy_uids_to_mirror(self.vault.path(), self.mirror.path(), ACCT, MAIL, BOX, uids)
        }
        fn mirror_names(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(self.mirror_cur())
                .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            names.sort();
            names
        }
    }

    fn mail_bytes(id: &str, body: &str) -> Vec<u8> {
        format!("Message-ID: <{id}>\r\nSubject: t\r\n\r\n{body}").into_bytes()
    }

    #[test]
    fn copy_uids_to_mirror_copies_each_vault_file_under_its_own_name_and_verifies_it() {
        let fx = CopyFx::new();
        let a = fx.vault_msg(1, "a@x", "first body");
        let b = fx.vault_msg(2, "b@x", "second body");

        let out = fx.copy(&[1, 2]).unwrap();

        assert_eq!(out.copied, vec![1, 2]);
        assert_eq!(out.verified, vec![1, 2]);
        assert!(out.missing.is_empty() && out.mismatched.is_empty() && out.failed.is_empty(), "{out:?}");
        for src in [&a, &b] {
            let dst = fx.mirror_cur().join(src.file_name().unwrap());
            assert_eq!(std::fs::read(&dst).unwrap(), std::fs::read(src).unwrap(), "same bytes, same Maildir name");
        }
        assert_eq!(fx.mirror_names().len(), 2, "no temp file is left beside the copies: {:?}", fx.mirror_names());
        assert!(
            fx.mirror_names().iter().all(|n| crate::maildir::mirror_filename_uid(n).is_some()),
            "every name in the mirror parses as a record: {:?}",
            fx.mirror_names()
        );
    }

    #[test]
    fn copy_uids_to_mirror_reports_a_uid_with_no_vault_file_as_missing_and_writes_nothing() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "a@x", "body");

        let out = fx.copy(&[1, 9]).unwrap();

        assert_eq!(out.verified, vec![1]);
        assert_eq!(out.missing, vec![9]);
        assert_eq!(fx.mirror_names().len(), 1);
    }

    #[test]
    fn copy_uids_to_mirror_never_overwrites_a_different_message_at_the_same_name() {
        let fx = CopyFx::new();
        let src = fx.vault_msg(1, "mine@x", "the vault message");
        let name = src.file_name().unwrap().to_string_lossy().to_string();
        let other = fx.mirror_file(&name, "someone-else@x", "a different message under the same name");
        let before = std::fs::read(&other).unwrap();

        let out = fx.copy(&[1]).unwrap();

        assert_eq!(out.mismatched, vec![1], "{out:?}");
        assert!(out.verified.is_empty() && out.copied.is_empty(), "a mismatch is never verified: {out:?}");
        assert_eq!(std::fs::read(&other).unwrap(), before, "the other message is untouched");
        assert_eq!(fx.mirror_names(), vec![name], "no second file for the uid either");
    }

    #[test]
    fn copy_uids_to_mirror_never_overwrites_a_different_message_held_under_another_name_for_the_uid() {
        let fx = CopyFx::new();
        fx.vault_msg(3, "mine@x", "the vault message");
        let legacy = fx.mirror_file("3.eml", "not-mine@x", "another message that owns uid 3 on the drive");
        let before = std::fs::read(&legacy).unwrap();

        let out = fx.copy(&[3]).unwrap();

        assert_eq!(out.mismatched, vec![3], "{out:?}");
        assert_eq!(std::fs::read(&legacy).unwrap(), before);
        assert_eq!(fx.mirror_names(), vec!["3.eml".to_string()], "the drive gets no second copy of uid 3");
    }

    #[test]
    fn copy_uids_to_mirror_counts_a_copy_already_on_the_drive_as_verified_without_writing() {
        let fx = CopyFx::new();
        fx.vault_msg(4, "same@x", "one message");
        // The same bytes under a legacy mirror name: presence by uid, proof by content.
        fx.mirror_file("4.eml", "same@x", "one message");

        let out = fx.copy(&[4]).unwrap();

        assert_eq!(out.verified, vec![4]);
        assert!(out.copied.is_empty(), "nothing is written for a message the drive already holds: {out:?}");
        assert_eq!(fx.mirror_names(), vec!["4.eml".to_string()]);
    }

    #[test]
    fn copy_uids_to_mirror_does_not_trust_a_copy_with_the_right_id_and_the_wrong_length() {
        let fx = CopyFx::new();
        fx.vault_msg(5, "same@x", "the whole message");
        fx.mirror_file("5.eml", "same@x", "the whole mess");

        let out = fx.copy(&[5]).unwrap();

        assert_eq!(out.mismatched, vec![5], "a truncated drive copy is not a backup: {out:?}");
        assert!(out.verified.is_empty());
    }

    #[test]
    fn copy_uids_to_mirror_is_idempotent() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "a@x", "first");
        fx.vault_msg(2, "b@x", "second");

        let first = fx.copy(&[1, 2]).unwrap();
        let second = fx.copy(&[1, 2]).unwrap();

        assert_eq!(first.copied, vec![1, 2]);
        assert!(second.copied.is_empty(), "the second call writes nothing: {second:?}");
        assert_eq!(second.verified, vec![1, 2]);
        assert_eq!(fx.mirror_names().len(), 2);
    }

    #[test]
    fn copy_uids_to_mirror_prefers_the_archived_vault_copy_over_a_cache_copy() {
        let fx = CopyFx::new();
        fx.vault_file(6, &["seen"], "cache@x", "the working cache copy");
        let archived = fx.vault_file(6, &["seen", "archived"], "arch@x", "the archived copy");

        let out = fx.copy(&[6]).unwrap();

        assert_eq!(out.verified, vec![6]);
        let dst = fx.mirror_cur().join(archived.file_name().unwrap());
        assert_eq!(std::fs::read(dst).unwrap(), std::fs::read(archived).unwrap());
        assert_eq!(fx.mirror_names().len(), 1);
    }

    #[test]
    fn copy_uids_to_mirror_ignores_a_repeated_uid_in_the_request() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "a@x", "first");

        let out = fx.copy(&[1, 1, 1]).unwrap();

        assert_eq!(out.copied, vec![1]);
        assert_eq!(out.verified, vec![1]);
    }

    #[test]
    fn copy_uids_to_mirror_refuses_a_backup_folder_that_is_not_there_and_does_not_create_it() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "a@x", "first");
        let gone = fx.mirror.path().join("unplugged-drive");

        let err = copy_uids_to_mirror(fx.vault.path(), &gone, ACCT, MAIL, BOX, &[1]).unwrap_err();

        assert!(err.to_lowercase().contains("backup"), "{err}");
        assert!(!gone.exists(), "a missing drive must not be replaced by a folder on the wrong disk");
    }

    #[test]
    fn copy_uids_to_mirror_with_no_uids_touches_nothing() {
        let fx = CopyFx::new();
        let out = fx.copy(&[]).unwrap();
        assert_eq!(out, MirrorCopyOutcome::default());
        assert!(!fx.mirror_cur().exists());
    }

    #[test]
    fn copy_uids_to_mirror_listed_reads_the_drive_folder_once_across_calls() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "a@x", "first");
        fx.vault_msg(2, "b@x", "second");
        fx.vault_msg(3, "c@x", "third");
        let mut listing = MirrorListing::new();

        let one = copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1], &mut listing).unwrap();
        let two = copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[2, 3], &mut listing).unwrap();

        assert_eq!(one.copied, vec![1]);
        assert_eq!(two.copied, vec![2, 3]);
        assert_eq!(listing.loads(), 1, "the caller's listing is reused, not re-read per batch");
        assert!(listing.contains(1) && listing.contains(2) && listing.contains(3), "copies land in the listing");
        assert_eq!(fx.mirror_names().len(), 3);
    }

    #[test]
    fn mirror_exclusion_native_writer_invalidates_a_cached_listing() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "first@test", "first");
        fx.vault_msg(2, "mine@test", "mine");
        let mut listing = MirrorListing::new();
        copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1], &mut listing).unwrap();
        write_direct_mirror(Some(fx.mirror.path().to_str().unwrap()), &fx.mirror_cur(), "2.eml", &mail_bytes("other@test", "replacement")).unwrap();
        let out = copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[2], &mut listing).unwrap();
        assert_eq!(out.mismatched, vec![2]);
        assert!(out.copied.is_empty());
        assert_eq!(listing.loads(), 2);
        assert_eq!(std::fs::read(fx.mirror_cur().join("2.eml")).unwrap(), mail_bytes("other@test", "replacement"));
    }

    #[test]
    fn a_listing_for_another_folder_is_read_again() {
        let fx = CopyFx::new();
        fx.vault_msg(1, "a@x", "first");
        let mut listing = MirrorListing::new();
        copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1], &mut listing).unwrap();

        // Another folder of the same account on the same drive.
        let other_cur = crate::vault_files::cur_path(fx.vault.path(), ACCT, "Sent");
        std::fs::create_dir_all(&other_cur).unwrap();
        std::fs::write(other_cur.join(crate::vault_files::build_maildir_filename(1, &["archived".to_string()])), mail_bytes("s@x", "sent")).unwrap();
        let out = copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, "Sent", &[1], &mut listing).unwrap();

        assert_eq!(out.copied, vec![1]);
        assert_eq!(listing.loads(), 2);
        assert!(!listing.contains(99));
    }

    /// A caller that already holds the vault folder's listing (the Archive &
    /// delete job) passes it: no batch lists the vault folder again, and only
    /// what that listing names is a source.
    #[test]
    fn copy_uids_to_mirror_from_takes_the_callers_vault_listing() {
        let fx = CopyFx::new();
        let one = fx.vault_msg(1, "a@x", "first");
        fx.vault_msg(2, "b@x", "second");
        let sources: std::collections::HashMap<u32, PathBuf> = std::collections::HashMap::from([(1, one)]);
        let mut listing = MirrorListing::new();

        let out = copy_uids_to_mirror_from(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1, 2], &mut listing, &sources)
            .unwrap();

        assert_eq!(out.copied, vec![1]);
        assert_eq!(out.missing, vec![2], "uid 2 is not in the caller's listing, so the vault folder was not read for it");
        assert_eq!(fx.mirror_names().len(), 1);
    }

    #[test]
    fn a_listed_vault_path_renamed_since_is_resolved_by_uid() {
        let fx = CopyFx::new();
        let stale = fx.vault_msg(1, "a@x", "first");
        let renamed = fx.vault_file(1, &["archived", "flagged", "seen"], "a@x", "first");
        std::fs::remove_file(&stale).unwrap();
        let sources: std::collections::HashMap<u32, PathBuf> = std::collections::HashMap::from([(1, stale)]);
        let mut listing = MirrorListing::new();

        let out = copy_uids_to_mirror_from(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1], &mut listing, &sources)
            .unwrap();

        assert_eq!(out.copied, vec![1]);
        assert_eq!(fx.mirror_names(), vec![renamed.file_name().unwrap().to_string_lossy().to_string()]);
    }

    #[test]
    fn a_sync_the_filesystem_does_not_support_is_not_a_failed_copy() {
        assert!(sync_unsupported(&std::io::Error::from(std::io::ErrorKind::Unsupported)));
        assert!(sync_unsupported(&std::io::Error::from(std::io::ErrorKind::InvalidInput)));
        assert!(sync_unsupported(&std::io::Error::from_raw_os_error(25)));
        assert!(!sync_unsupported(&std::io::Error::from_raw_os_error(5)), "EIO is a real failure");
    }

    /// The drive copy is what the server delete rests on: it is written to a
    /// temp dotfile, synced, renamed, and leaves nothing else behind.
    #[test]
    fn write_durable_lands_the_bytes_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("7{}AS.eml", crate::maildir::INFO_PREFIX);
        let dst = dir.path().join(&name);
        write_durable(&dst, b"Message-ID: <d@x>\r\n\r\nbody").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"Message-ID: <d@x>\r\n\r\nbody");
        let names: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec![name]);
        // A folder that is not there fails, and leaves nothing either.
        assert!(write_durable(&dir.path().join("gone").join("x.eml"), b"x").is_err());
    }

    #[test]
    fn a_listed_mirror_file_that_has_since_gone_is_copied_again() {
        let fx = CopyFx::new();
        let src = fx.vault_msg(1, "a@x", "first");
        let mut listing = MirrorListing::new();
        copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1], &mut listing).unwrap();
        // A purge (or the person) removed the drive copy behind the listing's back.
        std::fs::remove_file(fx.mirror_cur().join(src.file_name().unwrap())).unwrap();

        let out = copy_uids_to_mirror_listed(fx.vault.path(), fx.mirror.path(), ACCT, MAIL, BOX, &[1], &mut listing).unwrap();

        assert_eq!(out.copied, vec![1], "a stale listing entry is not proof the drive holds the message");
        assert_eq!(out.verified, vec![1]);
        assert_eq!(listing.loads(), 1);
    }

    // ── Task 7b: a JMAP vault's mirror stays `.eml` ──

    #[test]
    fn mirror_stays_eml_in_jmap_vault() {
        let fx = CopyFx::new();
        crate::message_store::set_vault_format(fx.vault.path(), crate::message_store::Format::Jmap).unwrap();
        let archived = ["archived".to_string(), "seen".to_string()];
        crate::message_store::write(fx.vault.path(), ACCT, BOX, 1, &mail_bytes("a@x", "first body"), &archived).unwrap();
        crate::message_store::write(fx.vault.path(), ACCT, BOX, 2, &mail_bytes("b@x", "second body"), &["flagged".to_string()]).unwrap();
        assert!(!fx.vault_cur().exists(), "the vault holds records only");

        let out = fx.copy(&[1, 2]).unwrap();
        assert_eq!((out.copied.clone(), out.verified.clone()), (vec![1, 2], vec![1, 2]), "{out:?}");
        let names = fx.mirror_names();
        assert_eq!(names, vec![format!("1{}AS.eml", crate::maildir::INFO_PREFIX), format!("2{}F.eml", crate::maildir::INFO_PREFIX)]);
        assert_eq!(std::fs::read(fx.mirror_cur().join(&names[0])).unwrap(), mail_bytes("a@x", "first body"), "identical bytes");
        assert_eq!(std::fs::read(fx.mirror_cur().join(&names[1])).unwrap(), mail_bytes("b@x", "second body"));
        assert!(!names.iter().any(|n| n.ends_with(".json")));
        assert_eq!(fx.copy(&[1, 2]).unwrap().verified, vec![1, 2], "already there: verified, not copied");
    }

    /// The pre-sync in a JMAP vault: a record goes to the mirror as an `.eml`
    /// under its flags, a mirror-only file comes into the vault as a record.
    #[test]
    fn a_presync_in_a_jmap_vault_copies_records_out_as_eml_and_files_in_as_records() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        crate::message_store::set_vault_format(root, crate::message_store::Format::Jmap).unwrap();
        let (_app, reg) = test_registry(root);
        let cur = crate::vault_files::cur_path(root, "acct", "INBOX");
        let mirror = root.join("mirror").join("me@mock.test").join("INBOX").join("cur");
        std::fs::create_dir_all(&mirror).unwrap();
        write_vault_file(&mirror, 42, &[]);
        crate::vault_files::store(&reg, root, "acct", "INBOX", 7, b"Subject: seven\r\n\r\nbody", &["seen".to_string()], true).unwrap();

        let uids = vault_uids_after_presync_at(&reg, "acct", "INBOX", &cur, Some(&root.join("mirror")), Some(&mirror)).unwrap();
        assert_eq!(uids, HashSet::from([7, 42]));
        assert_eq!(std::fs::read(mirror.join(format!("7{}S.eml", crate::maildir::INFO_PREFIX))).unwrap(), b"Subject: seven\r\n\r\nbody");
        let restored = crate::message_store::find(root, "acct", "INBOX", 42).unwrap();
        assert_eq!(restored.name, "42.json", "restored as a record");
        assert!(restored.flags.contains(&"archived".to_string()));
        assert_eq!(reg.uid_sets(root, "acct", "INBOX"), Some((vec![7, 42], vec![42])));
        assert_eq!(scan_cur_uids(&cur).unwrap(), HashSet::from([7, 42]), "the status count holds records");
    }
}

#[cfg(test)]
mod backup_batch_drain_tests {
    use super::*;
    // Err and JoinError must both wait for an already-running blocking mirror
    // unit and preserve its successful folder accounting. Dropping JoinSet
    // aborts its async owner but cannot stop that blocking unit.
    async fn held_sibling(panic: bool) {
        let cancel = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut tasks = tokio::task::JoinSet::new();
        tasks.spawn(async move {
            tokio::task::spawn_blocking(move || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
            .await
            .unwrap();
            Ok(7usize)
        });
        entered_rx.await.unwrap();
        tasks.spawn(async move {
            if panic {
                panic!("deliberate folder failure");
            }
            Err("folder failed".to_string())
        });
        let held = cancel.clone();
        let join = tokio::spawn(async move {
            let mut accounted = 0;
            let result = join_backup_batch(&mut tasks, &held, |n| accounted += n).await;
            (result, accounted)
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let premature = join.is_finished();
        release_tx.send(()).unwrap();
        let (result, accounted) = join.await.unwrap();
        assert!(
            !premature,
            "batch released admission before blocking sibling drained"
        );
        assert!(
            cancel.load(Ordering::SeqCst),
            "error did not cancel owned sibling work"
        );
        assert!(result.is_err());
        assert_eq!(accounted, 7, "successful sibling accounting was discarded");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backup_batch_error_waits_for_blocking_sibling() {
        held_sibling(false).await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backup_batch_panic_waits_for_blocking_sibling() {
        held_sibling(true).await;
    }
}
