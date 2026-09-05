use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::imap::{self, ImapConfig, ImapPool};

// ── Event payload ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct ArchiveProgress {
    pub total: usize,
    pub completed: usize,
    pub errors: usize,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "lastUid")]
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

// ── Cancellation token (shared app state) ─────────────────────────────────────

pub struct ArchiveCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);

impl Default for ArchiveCancelToken {
    fn default() -> Self {
        ArchiveCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

// ── Core archive runner ───────────────────────────────────────────────────────

pub async fn run(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
) -> Result<ArchiveProgress, String> {
    run_with_backup(app_handle, account_id, account_json, mailbox, uids, cancel, None, None, true).await
}

pub async fn run_with_backup(
    app_handle: tauri::AppHandle,
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
) -> Result<ArchiveProgress, String> {
    let total = uids.len();
    info!("archive_emails: starting {} UIDs for account {}", total, account_id);

    // Parse account config
    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    let _ = app_handle.emit("archive-progress", ArchiveProgress {
        total, completed: 0, errors: 0, active: true, last_error: None, last_uid: None, external_copy_failures: 0, bandwidth_limited: false,
        slow_drive_ms: None,
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

    // Get the IMAP pool from managed state
    let pool = app_handle.state::<ImapPool>();

    for uid in uids {
        if cancel.load(Ordering::Relaxed) {
            warn!("archive_emails: cancelled before spawning UID {}", uid);
            break;
        }

        let sem = Arc::clone(&sem);
        let app = app_handle.clone();
        let account = account.clone();
        let account_id = account_id.clone();
        let mailbox = mailbox.clone();
        let completed = Arc::clone(&completed);
        let errors = Arc::clone(&errors);
        let cancel = Arc::clone(&cancel);
        let bw_limited = Arc::clone(&bw_limited);
        let pool = pool.inner().clone();
        let bp = backup_path.clone();
        let ae = account_email.clone();
        let ext_failures = Arc::clone(&ext_failures);
        let last_err_msg = Arc::clone(&last_err_msg);
        let pace = Arc::clone(&pace);

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
                let _ = app.emit("archive-progress", ArchiveProgress {
                    total,
                    completed: c,
                    errors: e,
                    active: true,
                    last_error: None,
                    last_uid: None,
                    external_copy_failures: ext_failures.load(Ordering::Relaxed),
                    bandwidth_limited: false,
                    slow_drive_ms: Some(ms),
                });
                tokio::time::sleep(std::time::Duration::from_secs(SLOW_DRIVE_PAUSE_SECS)).await;
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
            }

            match fetch_and_store(
                &pool, &app, &account_id, &account, &mailbox, uid, bp.as_deref(), ae.as_deref(),
                remove_existing, &pace,
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
                    let _ = app.emit("archive-progress", ArchiveProgress {
                        total,
                        completed: c,
                        errors: e,
                        active: !is_cancelled && (c + e) < total,
                        last_error: None,
                        last_uid: Some(uid),
                        external_copy_failures: ext_failures.load(Ordering::Relaxed),
                        bandwidth_limited: false,
                        slow_drive_ms: None,
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
                    let _ = app.emit("archive-progress", ArchiveProgress {
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

    // Write to local-index.json if any entries were archived
    if !index_entries.is_empty() {
        if let Ok(data_dir) = crate::vault::root(&app_handle) {
            let dir_path = data_dir.join("maildir").join(&account_id).join(&mailbox);
            let index_path = dir_path.join("local-index.json");

            let mut existing: Vec<serde_json::Value> = if index_path.exists() {
                tokio::fs::read_to_string(&index_path).await.ok()
                    .and_then(|c| serde_json::from_str(&c).ok())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };

            let new_uids: std::collections::HashSet<u64> = index_entries.iter()
                .filter_map(|e| e.get("uid").and_then(|u| u.as_u64()))
                .collect();
            existing.retain(|e| {
                e.get("uid").and_then(|u| u.as_u64()).map_or(true, |uid| !new_uids.contains(&uid))
            });
            existing.extend(index_entries);

            if let Ok(data) = serde_json::to_string(&existing) {
                let tmp_path = index_path.with_extension("json.tmp");
                if tokio::fs::write(&tmp_path, &data).await.is_ok() {
                    let _ = tokio::fs::rename(&tmp_path, &index_path).await;
                }
            }
            info!("archive_emails: wrote {} entries to local-index.json", new_uids.len());
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
    };

    let _ = app_handle.emit("archive-progress", result.clone());
    Ok(result)
}

// ── Per-email fetch + write ──────────────────────────────────────────────────

async fn fetch_and_store(
    pool: &ImapPool,
    app_handle: &tauri::AppHandle,
    account_id: &str,
    account: &ImapConfig,
    mailbox: &str,
    uid: u32,
    backup_path: Option<&str>,
    account_email: Option<&str>,
    remove_existing: bool,
    pace: &DrivePace,
) -> Result<serde_json::Value, String> {
    use base64::Engine;

    // Get a priority session for the fetch (semaphore-guarded)
    let mut guard = pool.get_priority(account).await?;

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
    pool.return_priority(account, guard).await;

    let email = email.ok_or_else(|| format!("Email UID {} not found", uid))?;

    // The server's own read state, not a hardcoded "seen": this name is what
    // restore uploads, what the mirror copies, and what a vault row reads back.
    let flags = crate::vault_flags::store_flags(&email.flags);
    // Path computation only — no disk touched, so it stays off the blocking pool.
    let cur_dir = super::maildir_cur_path(app_handle, account_id, mailbox)?;

    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(&email.raw_source)
        .map_err(|e| format!("base64 decode: {}", e))?;
    let raw_len = raw_bytes.len();

    // Parse In-Reply-To and References from raw email for threading
    let (in_reply_to, references) = parse_threading_headers(&raw_bytes);

    // Generate snippet from text body
    let snippet = email.text.as_deref()
        .unwrap_or("")
        .chars().take(150).collect::<String>()
        .replace('\n', " ").replace('\r', "");

    // Every fs call below is synchronous std::fs. On a runtime worker, an
    // external drive that Time Machine is reading blocks that worker — and with
    // five of them in flight the runtime stops polling the IMAP sockets, which
    // is how the provider comes to drop them mid-run. Do the disk work on the
    // blocking pool instead.
    let mailbox_owned = mailbox.to_string();
    let mirror = backup_path.zip(account_email).map(|(bp, addr)| {
        std::path::PathBuf::from(bp).join(addr).join(&mailbox_owned).join("cur")
    });
    let (_filename, external_copy_failed, write_ms) = tokio::task::spawn_blocking(
        move || -> Result<(String, bool, u64), String> {
            use std::fs;

            fs::create_dir_all(&cur_dir).map_err(|e| format!("mkdir: {}", e))?;

            if remove_existing {
                if let Some(existing) = super::find_file_by_uid(&cur_dir, uid) {
                    let _ = fs::remove_file(&existing);
                }
            }

            let filename = super::build_maildir_filename(uid, &flags);
            // Both writes together: the mirror is the external drive, and how
            // long the pair takes is the only honest reading of how the drive
            // the user is backing up to is actually behaving.
            let started = std::time::Instant::now();
            // Atomic: a kill (or a drive that vanishes) mid-write must not leave
            // a half file behind for the next run's resume scan to trust.
            mailvault_core::fsx::write_atomic(&cur_dir.join(&filename), &raw_bytes)
                .map_err(|e| format!("write .eml: {}", e))?;

            // Also write to backup location if configured
            let mut external_copy_failed = false;
            if let Some(backup_dir) = mirror {
                match fs::create_dir_all(&backup_dir) {
                    Ok(()) => {
                        // Same Maildir name as the app copy (+ .eml) so flags survive a
                        // restore from the external location back into the app store.
                        let dst = backup_dir.join(format!("{}.eml", filename));
                        if super::find_msg_file_by_uid(&backup_dir, uid).is_none() {
                            if let Err(e) = mailvault_core::fsx::write_atomic(&dst, &raw_bytes) {
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

            Ok((filename, external_copy_failed, started.elapsed().as_millis() as u64))
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

    // Build local-index entry
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
    app_handle: tauri::AppHandle,
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

    let _ = app_handle.emit("bulk-operation-progress", serde_json::json!({
        "phase": "delete",
        "total": total,
        "completed": 0,
        "errors": 0,
        "active": true,
    }));

    let pool = app_handle.state::<ImapPool>();
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
        let app = app_handle.clone();
        let account = account.clone();
        let mailbox = mailbox.clone();
        let completed = Arc::clone(&completed);
        let errors = Arc::clone(&errors);
        let cancel = Arc::clone(&cancel);
        let pool = pool.inner().clone();

        set.spawn(async move {
            let _permit = sem.acquire().await.unwrap();

            if cancel.load(Ordering::Relaxed) {
                return;
            }

            let result = delete_single_email(&pool, &account, &mailbox, uid).await;

            if result.is_ok() {
                completed.fetch_add(1, Ordering::Relaxed);
            } else {
                errors.fetch_add(1, Ordering::Relaxed);
                warn!("bulk_delete: UID {} failed: {:?}", uid, result.err());
            }

            let c = completed.load(Ordering::Relaxed);
            let e = errors.load(Ordering::Relaxed);
            let is_cancelled = cancel.load(Ordering::Relaxed);
            let _ = app.emit("bulk-operation-progress", serde_json::json!({
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
