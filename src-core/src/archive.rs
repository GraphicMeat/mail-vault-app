//! The archive and bulk-delete runners (plan Task 3.2), moved verbatim from
//! `src-tauri/src/archive.rs` apart from the substitutions named in the plan:
//! emitting through an injected sink instead of `AppHandle::emit`, a
//! root-based `vault_files::cur_path` instead of the app's
//! `maildir_cur_path`, an injected `ImapPool` instead of Tauri managed
//! state, an injected custody-append sink instead of the
//! `daemon_call_blocking("local_index_append", ...)` bridge call, an
//! injected nudge sink instead of `crate::nudge_index` (since replaced by the
//! vault registry's change hook, `ArchiveCtx::registry`), and the per-file
//! disk write wrapped in the injected vault gate. See the Task 3.2 report
//! for the full diff summary, including the handful of substitutions this
//! required beyond the plan's named list (`ArchiveGate` instead of the
//! existing `vault_files::VaultGate` type, `Arc`-wrapped sinks instead of
//! borrowed `&dyn Fn`, and the gate call's return-by-mutation shape).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::imap::{self, ImapConfig, ImapPool};
use crate::vault_files;
use crate::vault_registry::VaultRegistry;

// ── Event payload ─────────────────────────────────────────────────────────────

// Task 3.3 (R3.2): full camelCase, no per-field exceptions - `lastUid` used
// to be the only explicitly renamed field, which meant every other field
// stayed snake_case and every consumer had to know which was which. The
// explicit `#[serde(rename = "lastUid")]` this replaced is redundant under
// `rename_all` (it already produces "lastUid" for `last_uid`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgress {
    pub total: usize,
    pub completed: usize,
    pub errors: usize,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_uid: Option<u32>,
    /// Number of emails where local write succeeded but external copy failed
    #[serde(default)]
    pub external_copy_failures: usize,
    /// True when the run stopped because the provider reported a daily
    /// bandwidth suspension (e.g. Gmail's 2500 MB/day IMAP download cap)
    #[serde(default)]
    pub bandwidth_limited: bool,
    /// How long the last slow write took, on the events emitted while the run
    /// is deliberately waiting for a struggling backup drive. Absent otherwise,
    /// which is what tells the UI the drive recovered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slow_drive_ms: Option<u64>,
    /// Which kind of run produced this event/reply - "archive" (a manual or
    /// daemon-route archive), "backup" (backup.rs's own call through
    /// run_with_backup) or "bulk_delete" (bulk_delete's own reply). Lets a
    /// listener take only its own stream instead of any archive-progress
    /// frame that happens to arrive: a scheduled backup running alongside a
    /// manual bulk-archive used to stomp its progress counts (R3.2 / N3).
    pub operation: &'static str,
    pub account_id: String,
    pub mailbox: String,
}

// ── Slow-drive pacing ─────────────────────────────────────────────────────────

/// A .eml write that takes this long is not a normal write.
const SLOW_WRITE_MS: u64 = 2_000;
/// This many slow writes in a row means the drive, not one file.
const SLOW_STREAK: u32 = 3;
/// How long every in-flight task waits before its next fetch while the drive is struggling.
const SLOW_DRIVE_PAUSE_SECS: u64 = 30;

/// Shared across the run's tasks. The first fast write clears it.
// ponytail: one streak counter and a fixed pause; make the pause grow with the
// streak if 30s turns out too short on a drive that stays slow for minutes.
#[derive(Default)]
struct DrivePace {
    slow_streak: AtomicU32,
    last_slow_ms: AtomicU64,
}

impl DrivePace {
    fn record(&self, write_ms: u64) {
        if write_ms >= SLOW_WRITE_MS {
            self.last_slow_ms.store(write_ms, Ordering::Relaxed);
            self.slow_streak.fetch_add(1, Ordering::Relaxed);
        } else {
            self.slow_streak.store(0, Ordering::Relaxed);
        }
    }

    /// The last slow write's duration, once enough of them ran back to back.
    fn slow(&self) -> Option<u64> {
        if self.slow_streak.load(Ordering::Relaxed) >= SLOW_STREAK {
            Some(self.last_slow_ms.load(Ordering::Relaxed))
        } else {
            None
        }
    }
}

// ── Injected sinks and the run context ──────────────────────────────────────

/// The write gate a per-file disk write takes, same inner shape as
/// `vault_files::VaultGate` (so the daemon's `with_vault_write` adapter is
/// unchanged) but `Arc`-wrapped and `Send + Sync` instead of borrowed: the
/// fan-out below spawns each uid's work as its own tokio task (`JoinSet`) and
/// wraps the disk write itself in `spawn_blocking`, both of which require
/// `'static`, which a borrowed `&dyn Fn` cannot satisfy. `vault_files::VaultGate`
/// itself is written for the daemon's synchronous whole-vault walkers, called
/// once inside `handlers::common::blocking`, not for a function fanning out
/// many concurrent tokio tasks; reusing it as specified by the plan's Step 1
/// does not compile, so this is the minimal change that keeps its call shape.
pub type ArchiveGate = Arc<dyn Fn(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String> + Send + Sync>;

/// The two points where the app and the daemon differ: how a progress event
/// reaches the UI and how a custody row gets recorded. `Arc`-wrapped for the
/// same `'static` reason as `ArchiveGate`, cloned once per spawned task rather
/// than re-taken by reference. The search index hears about each write from
/// the vault registry's change hook, so there is no nudge sink.
pub struct ArchiveSinks {
    pub emit: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>,
    pub custody_append: Arc<dyn Fn(&str, &str, String) -> Result<usize, String> + Send + Sync>,
}

/// Everything the runner needs beyond the call's own arguments. `root` is
/// resolved once by the caller (the app's `vault::root(&app)` or the
/// daemon's `handlers::common::vault_root`); the runner itself never
/// resolves or falls back on a root.
pub struct ArchiveCtx {
    pub root: PathBuf,
    pub pool: Arc<ImapPool>,
    pub gate: ArchiveGate,
    pub sinks: ArchiveSinks,
    /// Every vault write here updates it (architecture.md "Writers update the
    /// database before replying"); its hook also nudges the search index.
    pub registry: Arc<VaultRegistry>,
}

// ── Core archive runner ───────────────────────────────────────────────────────

pub async fn run(
    ctx: Arc<ArchiveCtx>,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
) -> Result<ArchiveProgress, String> {
    run_with_backup(ctx, account_id, account_json, mailbox, uids, cancel, None, None, true, "archive").await
}

pub async fn run_with_backup(
    ctx: Arc<ArchiveCtx>,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
    backup_path: Option<String>,
    account_email: Option<String>,
    // A backup run only ever fetches uids the local scan just proved absent, so
    // the per-message read_dir looking for a stale copy is pure disk cost on the
    // one path that can least afford it. The plain archive path passes true:
    // there a uid the user re-archives can well be on disk already.
    remove_existing: bool,
    // "archive" from a manual/daemon archive run, "backup" from backup.rs's
    // call (R3.2 / N3 - lets a listener take only its own event stream).
    operation: &'static str,
) -> Result<ArchiveProgress, String> {
    let total = uids.len();
    info!("archive_emails: starting {} UIDs for account {}", total, account_id);

    // Parse account config
    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    emit(&ctx, ArchiveProgress {
        total, completed: 0, errors: 0, active: true, last_error: None, last_uid: None, external_copy_failures: 0, bandwidth_limited: false,
        slow_drive_ms: None, operation, account_id: account_id.clone(), mailbox: mailbox.clone(),
    });

    let sem = Arc::new(Semaphore::new(5));
    let completed = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));
    let bw_limited = Arc::new(AtomicBool::new(false));
    let ext_failures = Arc::new(AtomicUsize::new(0));
    // The server's own words for the last message that failed. Without it a
    // run that lost one message reports a count and nothing to act on.
    let last_err_msg: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
    // How the backup drive is actually behaving, shared by every task in this run.
    let pace = Arc::new(DrivePace::default());
    let mut set: JoinSet<Option<serde_json::Value>> = JoinSet::new();

    // The IMAP pool lives on ctx (injected: the app's managed state or the
    // daemon's own pool, per caller).

    // One listing of the vault folder and one of its mirror for the whole run.
    // Looking every uid up again was a read_dir per message, the mirror's on the
    // external drive the run is already struggling to keep up with.
    // ponytail: a copy another writer lands mid-run is not in the listing, and
    // this run writes its own beside it under a second flag name.
    let (vault_listing, mirror_uids) = {
        let root = ctx.root.clone();
        let (acct, mbox) = (account_id.clone(), mailbox.clone());
        let mirror = backup_path.as_deref().zip(account_email.as_deref()).map(|(bp, addr)| {
            std::path::PathBuf::from(bp).join(addr).join(&mailbox).join("cur")
        });
        tokio::task::spawn_blocking(move || {
            let vault_listing: HashMap<u32, std::path::PathBuf> = if remove_existing {
                let cur = vault_files::cur_path(&root, &acct, &mbox);
                crate::maildir::uid_file_map(&cur)
            } else {
                HashMap::new()
            };
            let mirror_uids: HashSet<u32> = mirror
                .map(|dir| crate::maildir::mirror_file_map(&dir).into_keys().collect())
                .unwrap_or_default();
            (vault_listing, mirror_uids)
        })
        .await
        .map_err(|e| format!("archive listing panicked: {}", e))?
    };

    for uid in uids {
        if cancel.load(Ordering::Relaxed) {
            warn!("archive_emails: cancelled before spawning UID {}", uid);
            break;
        }

        let sem = Arc::clone(&sem);
        let ctx = Arc::clone(&ctx);
        let account = account.clone();
        let account_id = account_id.clone();
        let mailbox = mailbox.clone();
        let completed = Arc::clone(&completed);
        let errors = Arc::clone(&errors);
        let cancel = Arc::clone(&cancel);
        let bw_limited = Arc::clone(&bw_limited);
        let bp = backup_path.clone();
        let ae = account_email.clone();
        let ext_failures = Arc::clone(&ext_failures);
        let last_err_msg = Arc::clone(&last_err_msg);
        let pace = Arc::clone(&pace);
        let listed = vault_listing.get(&uid).cloned();
        let in_mirror = mirror_uids.contains(&uid);

        set.spawn(async move {
            let _permit = sem.acquire().await.unwrap();

            if cancel.load(Ordering::Relaxed) {
                return None;
            }

            // The drive is struggling. Hammering it harder is how a backup ends
            // up dropping its sockets; back off, and say so instead of looking
            // frozen.
            if let Some(ms) = pace.slow() {
                let c = completed.load(Ordering::Relaxed);
                let e = errors.load(Ordering::Relaxed);
                emit(&ctx, ArchiveProgress {
                    total,
                    completed: c,
                    errors: e,
                    active: true,
                    last_error: None,
                    last_uid: None,
                    external_copy_failures: ext_failures.load(Ordering::Relaxed),
                    bandwidth_limited: false,
                    slow_drive_ms: Some(ms),
                    operation, account_id: account_id.clone(), mailbox: mailbox.clone(),
                });
                tokio::time::sleep(std::time::Duration::from_secs(SLOW_DRIVE_PAUSE_SECS)).await;
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
            }

            match fetch_and_store(
                &ctx, &account_id, &account, &mailbox, uid, bp.as_deref(), ae.as_deref(),
                listed, in_mirror, &pace,
            ).await {
                Ok(index_entry) => {
                    // Track external copy failures
                    if index_entry.get("_external_copy_failed").and_then(|v| v.as_bool()).unwrap_or(false) {
                        ext_failures.fetch_add(1, Ordering::Relaxed);
                    }
                    completed.fetch_add(1, Ordering::Relaxed);
                    let c = completed.load(Ordering::Relaxed);
                    let e = errors.load(Ordering::Relaxed);
                    let is_cancelled = cancel.load(Ordering::Relaxed);
                    emit(&ctx, ArchiveProgress {
                        total,
                        completed: c,
                        errors: e,
                        active: !is_cancelled && (c + e) < total,
                        last_error: None,
                        last_uid: Some(uid),
                        external_copy_failures: ext_failures.load(Ordering::Relaxed),
                        bandwidth_limited: false,
                        slow_drive_ms: None,
                        operation, account_id: account_id.clone(), mailbox: mailbox.clone(),
                    });
                    Some(index_entry)
                }
                Err(last_error) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    warn!("archive_emails: UID {} failed: {:?}", uid, last_error);
                    let is_bw = imap::is_bandwidth_limited(&last_error);
                    let last_error = if is_bw {
                        // Account is suspended server-side — stop the run instead of
                        // failing every remaining UID against a locked account.
                        cancel.store(true, Ordering::Relaxed);
                        bw_limited.store(true, Ordering::Relaxed);
                        warn!("archive_emails: bandwidth limit hit — stopping run");
                        "Daily download limit reached for this provider. Archiving stopped — run it again after the limit resets (usually within 1 hour, up to 24 hours). Already-archived emails are kept.".to_string()
                    } else {
                        last_error
                    };
                    if let Ok(mut slot) = last_err_msg.lock() {
                        *slot = Some(last_error.clone());
                    }
                    let c = completed.load(Ordering::Relaxed);
                    let e = errors.load(Ordering::Relaxed);
                    let is_cancelled = cancel.load(Ordering::Relaxed);
                    emit(&ctx, ArchiveProgress {
                        total,
                        completed: c,
                        errors: e,
                        active: !is_cancelled && (c + e) < total,
                        last_error: Some(last_error),
                        last_uid: None,
                        external_copy_failures: ext_failures.load(Ordering::Relaxed),
                        // Per-event flag: true only for the error that hit the limit,
                        // so late in-flight failures can't overwrite the friendly message
                        bandwidth_limited: is_bw,
                        slow_drive_ms: None,
                        operation, account_id: account_id.clone(), mailbox: mailbox.clone(),
                    });
                    None
                }
            }
        });
    }

    // Collect index entries from completed tasks
    let mut index_entries: Vec<serde_json::Value> = Vec::new();
    while let Some(result) = set.join_next().await {
        if let Ok(Some(entry)) = result {
            index_entries.push(entry);
        }
    }

    // Record custody for every message this run stored. Sink-injected (Task
    // 3.2): the app's sink still bridges to the daemon over RPC
    // (`local_index_append`, the same method the frontend uses); the daemon's
    // own route (Task 3.4) does the upsert in-process. Either way the daemon
    // does the upsert and logs the uid-less entries it skips, so only the
    // count is reported here.
    if !index_entries.is_empty() {
        let (ctx2, acct, mbx) = (Arc::clone(&ctx), account_id.clone(), mailbox.clone());
        // `written` counts entries handed to the sink, not entries actually
        // upserted: the daemon can skip uid-less ones (and logs the skips),
        // so this over-reports by that count. The plan authorised keeping it
        // this way (task-2.11 carry-in M7a) — only the request/reply shapes
        // are contract, not the log line's exact number.
        let written = index_entries.len();
        // An `else` on the match (task-2.11 carry-in M7b), not a
        // `String::new()` sentinel: a serialize failure and an empty entries
        // list must stay distinguishable even if the outer `is_empty` guard
        // above ever moves.
        match serde_json::to_string(&index_entries) {
            Ok(entries_json) => {
                // The sink itself does the blocking work (an RPC round trip in
                // the app, an in-process SQLite write in the daemon), never on
                // a tokio worker.
                match tokio::task::spawn_blocking(move || (ctx2.sinks.custody_append)(&acct, &mbx, entries_json))
                    .await
                {
                    Ok(Ok(_)) => info!("archive_emails: recorded {} custody entries", written),
                    Ok(Err(e)) => warn!("archive_emails: custody write failed: {}", e),
                    Err(e) => warn!("archive_emails: custody write panicked: {}", e),
                }
            }
            Err(e) => warn!("archive_emails: custody write failed: could not serialize {} entries: {}", written, e),
        }
    }

    let final_completed = completed.load(Ordering::Relaxed);
    let final_errors = errors.load(Ordering::Relaxed);
    let final_ext_failures = ext_failures.load(Ordering::Relaxed);

    info!(
        "archive_emails: done — {}/{} completed, {} errors, {} external copy failures",
        final_completed, total, final_errors, final_ext_failures
    );

    let bandwidth_limited = bw_limited.load(Ordering::Relaxed);
    let result = ArchiveProgress {
        total,
        completed: final_completed,
        errors: final_errors,
        active: false,
        last_error: if bandwidth_limited {
            Some("Daily download limit reached for this provider. Backup stopped — it will pick up where it left off after the limit resets (usually within 1 hour, up to 24 hours).".to_string())
        } else if final_errors > 0 {
            last_err_msg.lock().ok().and_then(|slot| slot.clone())
        } else {
            None
        },
        last_uid: None,
        external_copy_failures: final_ext_failures,
        bandwidth_limited,
        slow_drive_ms: None,
        operation, account_id: account_id.clone(), mailbox: mailbox.clone(),
    };

    emit(&ctx, result.clone());
    Ok(result)
}

/// `(sinks.emit)("archive-progress", ...)`, serializing the payload once
/// here instead of at every call site. A serialize failure (never observed
/// for this struct's field types) drops the event exactly as the original
/// `let _ = app_handle.emit(...)` silently dropped a Tauri emit failure:
/// a dropped progress frame does not fail the run.
fn emit(ctx: &ArchiveCtx, payload: ArchiveProgress) {
    if let Ok(value) = serde_json::to_value(&payload) {
        (ctx.sinks.emit)("archive-progress", value);
    }
}

// ── Per-email fetch + write ──────────────────────────────────────────────────

async fn fetch_and_store(
    ctx: &ArchiveCtx,
    account_id: &str,
    account: &ImapConfig,
    mailbox: &str,
    uid: u32,
    backup_path: Option<&str>,
    account_email: Option<&str>,
    // Where the run's listing saw a vault copy of this uid, when it was asked
    // to replace one.
    listed: Option<std::path::PathBuf>,
    // The run's mirror listing already holds this uid, under any name.
    in_mirror: bool,
    pace: &DrivePace,
) -> Result<serde_json::Value, String> {
    use base64::Engine;

    // Get a priority session for the fetch (semaphore-guarded)
    let mut guard = ctx.pool.get_priority(account).await?;

    // Bounded: a socket the server (or a NAT) dropped while a slow disk held
    // this worker never answers, and an unbounded await here is what locks a
    // whole backup up with nothing logged.
    let email = imap::bounded(
        &format!("UID FETCH {}", uid),
        60,
        imap::fetch_email_by_uid(&mut guard.session, mailbox, uid),
    )
        .await
        .map_err(|e| {
            // Don't return session on error — guard drops, semaphore permit released
            format!("IMAP fetch failed: {}", e)
        })?;

    guard.last_selected = Some(mailbox.to_string());
    ctx.pool.return_priority(account, guard).await;

    let email = email.ok_or_else(|| format!("Email UID {} not found", uid))?;

    // The server's own read state, not a hardcoded "seen": this name is what
    // restore uploads, what the mirror copies, and what a vault row reads back.
    let flags = crate::vault_flags::store_flags(&email.flags);
    // Path computation only — no disk touched, so it stays off the blocking pool.
    let cur_dir = vault_files::cur_path(&ctx.root, account_id, mailbox);

    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(&email.raw_source)
        .map_err(|e| format!("base64 decode: {}", e))?;
    let raw_len = raw_bytes.len();

    // Parse In-Reply-To and References from raw email for threading
    let (in_reply_to, references) = parse_threading_headers(&raw_bytes);

    // Generate snippet from text body
    let snippet = crate::vault_eml::preview_snippet(email.text.as_deref());

    // Every fs call below is synchronous std::fs. On a runtime worker, an
    // external drive that Time Machine is reading blocks that worker — and with
    // five of them in flight the runtime stops polling the IMAP sockets, which
    // is how the provider comes to drop them mid-run. Do the disk work on the
    // blocking pool instead.
    let mailbox_owned = mailbox.to_string();
    let mirror = backup_path.zip(account_email).map(|(bp, addr)| {
        std::path::PathBuf::from(bp).join(addr).join(&mailbox_owned).join("cur")
    });
    let gate = Arc::clone(&ctx.gate);
    let registry = Arc::clone(&ctx.registry);
    let account_key = account_id.to_string();
    let (_filename, external_copy_failed, write_ms) = tokio::task::spawn_blocking(
        move || -> Result<(String, bool, u64), String> {
            use std::fs;

            // The per-file write, held across `create_dir_all` through both
            // writes (app and mirror), not merely checked before them (Phase
            // 2 Task 2.6 review I1). `gate`'s inner `FnMut` returns
            // `Result<(), String>`, so this closure reports its findings by
            // writing into the three pre-declared variables below instead of
            // returning them, the same shape `vault_files::clear_cache` and
            // `migrate_json_to_eml` already use around their own per-file work.
            let mut filename = String::new();
            let mut external_copy_failed = false;
            let mut write_ms: u64 = 0;

            // The mailbox's registry lock first, then the gate (the lock
            // order), so a delete of this uid never lands between the write
            // and its row.
            // ponytail: the lock also spans the mirror write, so one run's
            // five tasks write one at a time; split it out if a slow mirror
            // ever makes that the bottleneck.
            registry.serialized(&account_key, &mailbox_owned, || gate(&mut || {
                fs::create_dir_all(&cur_dir).map_err(|e| format!("mkdir: {}", e))?;

                if let Some(listed) = &listed {
                    if let Some(existing) = crate::maildir::find_listed_by_uid(&cur_dir, uid, listed) {
                        let _ = fs::remove_file(&existing);
                    }
                }

                filename = vault_files::build_maildir_filename(uid, &flags);
                // Both writes together: the mirror is the external drive, and how
                // long the pair takes is the only honest reading of how the drive
                // the user is backing up to is actually behaving.
                let started = std::time::Instant::now();
                // Atomic: a kill (or a drive that vanishes) mid-write must not leave
                // a half file behind for the next run's resume scan to trust.
                let written = cur_dir.join(&filename);
                if let Err(e) = crate::fsx::write_atomic(&written, &raw_bytes) {
                    // The listed copy may already be gone: its row must not outlive it.
                    registry.invalidate(&account_key, &mailbox_owned);
                    return Err(format!("write .eml: {}", e));
                }
                registry.upsert(&account_key, &mailbox_owned, uid, &written);

                // Also write to backup location if configured
                if let Some(backup_dir) = &mirror {
                    match fs::create_dir_all(backup_dir) {
                        Ok(()) => {
                            // Same Maildir name as the app copy so flags survive a
                            // restore from the external location back into the app store.
                            let dst = backup_dir.join(&filename);
                            if !in_mirror {
                                if let Err(e) = crate::fsx::write_atomic(&dst, &raw_bytes) {
                                    warn!("archive_emails: external copy failed for UID {}: {}", uid, e);
                                    external_copy_failed = true;
                                }
                            }
                        }
                        Err(e) => {
                            warn!("archive_emails: external mkdir failed for UID {}: {}", uid, e);
                            external_copy_failed = true;
                        }
                    }
                }

                write_ms = started.elapsed().as_millis() as u64;
                Ok(())
            }))?;

            Ok((filename, external_copy_failed, write_ms))
        },
    )
    .await
    .map_err(|e| format!("store UID {} panicked: {}", uid, e))??;

    pace.record(write_ms);
    if write_ms >= SLOW_WRITE_MS {
        info!("archive_emails: slow write for UID {} — {} ms", uid, write_ms);
    }

    info!("archive_emails: stored UID {} ({} bytes{})", uid, raw_len,
        if external_copy_failed { ", external copy FAILED" } else { "" });

    // Build the custody entry
    let index_entry = serde_json::json!({
        "uid": email.uid,
        "from": { "address": email.from.address, "name": email.from.name },
        "to": email.to.iter().map(|a| serde_json::json!({ "address": a.address, "name": a.name })).collect::<Vec<_>>(),
        "subject": email.subject,
        "date": email.date,
        "flags": email.flags,
        "has_attachments": email.has_attachments,
        "message_id": email.message_id,
        "in_reply_to": in_reply_to,
        "references": references,
        "snippet": snippet,
        "source": "local",
        "_external_copy_failed": external_copy_failed,
    });

    Ok(index_entry)
}

/// Extract In-Reply-To and References headers from raw email bytes for threading
fn parse_threading_headers(raw: &[u8]) -> (Option<String>, Option<Vec<String>>) {
    let raw_str = String::from_utf8_lossy(raw);
    // Only look at headers (before first blank line)
    let header_section = raw_str.split("\r\n\r\n").next()
        .or_else(|| raw_str.split("\n\n").next())
        .unwrap_or(&raw_str);
    let lower = header_section.to_lowercase();

    let in_reply_to = lower.find("in-reply-to:")
        .and_then(|idx| {
            let after = &header_section[idx + "in-reply-to:".len()..];
            let start = after.find('<')?;
            let end = after[start..].find('>')? + start;
            Some(after[start..=end].trim().to_string())
        });

    let references = lower.find("references:")
        .map(|idx| {
            let after = &header_section[idx + "references:".len()..];
            let mut refs = Vec::new();
            let mut start = None;
            for (i, ch) in after.char_indices() {
                match ch {
                    '<' => start = Some(i),
                    '>' => {
                        if let Some(s) = start {
                            refs.push(after[s..=i].trim().to_string());
                            start = None;
                        }
                    }
                    '\n' if !matches!(after.as_bytes().get(i + 1), Some(b' ' | b'\t')) => break,
                    _ => {}
                }
            }
            refs
        })
        .filter(|r| !r.is_empty());

    (in_reply_to, references)
}

// ── Bulk delete runner ──────────────────────────────────────────────────────

pub async fn bulk_delete(
    ctx: Arc<ArchiveCtx>,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
) -> Result<ArchiveProgress, String> {
    let total = uids.len();
    info!("bulk_delete: starting {} UIDs for account {}", total, account_id);

    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    (ctx.sinks.emit)("bulk-operation-progress", serde_json::json!({
        "phase": "delete",
        "total": total,
        "completed": 0,
        "errors": 0,
        "active": true,
    }));

    let sem = Arc::new(Semaphore::new(5));
    let completed = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));
    let mut set: JoinSet<()> = JoinSet::new();

    for uid in uids {
        if cancel.load(Ordering::Relaxed) {
            warn!("bulk_delete: cancelled before spawning UID {}", uid);
            break;
        }

        let sem = Arc::clone(&sem);
        let ctx = Arc::clone(&ctx);
        let account = account.clone();
        let mailbox = mailbox.clone();
        let completed = Arc::clone(&completed);
        let errors = Arc::clone(&errors);
        let cancel = Arc::clone(&cancel);

        set.spawn(async move {
            let _permit = sem.acquire().await.unwrap();

            if cancel.load(Ordering::Relaxed) {
                return;
            }

            let result = delete_single_email(&ctx.pool, &account, &mailbox, uid).await;

            if result.is_ok() {
                completed.fetch_add(1, Ordering::Relaxed);
            } else {
                errors.fetch_add(1, Ordering::Relaxed);
                warn!("bulk_delete: UID {} failed: {:?}", uid, result.err());
            }

            let c = completed.load(Ordering::Relaxed);
            let e = errors.load(Ordering::Relaxed);
            let is_cancelled = cancel.load(Ordering::Relaxed);
            (ctx.sinks.emit)("bulk-operation-progress", serde_json::json!({
                "phase": "delete",
                "total": total,
                "completed": c,
                "errors": e,
                "active": !is_cancelled && (c + e) < total,
            }));
        });
    }

    while set.join_next().await.is_some() {}

    let final_completed = completed.load(Ordering::Relaxed);
    let final_errors = errors.load(Ordering::Relaxed);

    info!("bulk_delete: done — {}/{} deleted, {} errors", final_completed, total, final_errors);

    Ok(ArchiveProgress {
        total,
        completed: final_completed,
        errors: final_errors,
        active: false,
        last_error: None,
        last_uid: None,
        external_copy_failures: 0,
        bandwidth_limited: false,
        slow_drive_ms: None,
        // Its own reply, not the "archive-progress" event stream (it emits
        // "bulk-operation-progress", decision 6, untouched) - a distinct
        // label so a future reader can't mistake this reply for an archive
        // run's. Matches the cancel registry's "bulk_delete" key (Task 3.4).
        operation: "bulk_delete", account_id: account_id.clone(), mailbox: mailbox.clone(),
    })
}

async fn delete_single_email(
    pool: &ImapPool,
    account: &ImapConfig,
    mailbox: &str,
    uid: u32,
) -> Result<(), String> {
    // Retries once on a fresh connection when the pooled socket turns out to
    // have died while idle — the same one-line failure that made a single
    // delete look like a message resurrecting itself, except here it costs one
    // uid out of a bulk run and is reported as an error count nobody can act
    // on. See ImapPool::run_uid_delete for why re-sending this is safe.
    pool.run_uid_delete(account, true, |mut session| async move {
        // Cached at session creation — read after checkout, like the move path.
        let has_uidplus = pool.has_capability(account, "UIDPLUS").await;
        imap::delete_email(&mut session, mailbox, uid, true, has_uidplus).await?;
        Ok(((), session, Some(mailbox.to_string())))
    }).await
}

#[cfg(test)]
mod tests {
    use super::{DrivePace, SLOW_WRITE_MS};

    #[test]
    fn three_slow_writes_report_the_drive_as_slow() {
        let pace = DrivePace::default();
        pace.record(5_000);
        pace.record(4_000);
        assert_eq!(pace.slow(), None, "two slow writes is a file, not a drive");
        pace.record(3_000);
        assert_eq!(pace.slow(), Some(3_000), "the last slow write's duration is reported");
    }

    #[test]
    fn a_fast_write_clears_the_streak() {
        let pace = DrivePace::default();
        pace.record(5_000);
        pace.record(5_000);
        pace.record(10);
        assert_eq!(pace.slow(), None);
        pace.record(5_000);
        pace.record(5_000);
        assert_eq!(pace.slow(), None, "the streak restarted from the fast write");
    }

    #[test]
    fn a_fast_write_after_a_slow_run_clears_it_again() {
        let pace = DrivePace::default();
        for _ in 0..5 {
            pace.record(9_000);
        }
        assert_eq!(pace.slow(), Some(9_000));
        pace.record(0);
        assert_eq!(pace.slow(), None);
    }

    #[test]
    fn a_write_exactly_at_the_threshold_counts_as_slow() {
        let pace = DrivePace::default();
        for _ in 0..3 {
            pace.record(SLOW_WRITE_MS);
        }
        assert_eq!(pace.slow(), Some(SLOW_WRITE_MS));
    }
}
