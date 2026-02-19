use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    let total = uids.len();
    info!("archive_emails: starting {} UIDs for account {}", total, account_id);

    // Parse account config
    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    let _ = app_handle.emit("archive-progress", ArchiveProgress {
        total, completed: 0, errors: 0, active: true, last_error: None,
    });

    let sem = Arc::new(Semaphore::new(3));
    let completed = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));
    let mut set: JoinSet<()> = JoinSet::new();

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
        let pool = pool.inner().clone();

        set.spawn(async move {
            let _permit = sem.acquire().await.unwrap();

            if cancel.load(Ordering::Relaxed) {
                return;
            }

            let last_error = fetch_and_store(
                &pool, &app, &account_id, &account, &mailbox, uid,
            ).await.err();

            if last_error.is_none() {
                completed.fetch_add(1, Ordering::Relaxed);
            } else {
                errors.fetch_add(1, Ordering::Relaxed);
                warn!("archive_emails: UID {} failed: {:?}", uid, last_error);
            }

            let c = completed.load(Ordering::Relaxed);
            let e = errors.load(Ordering::Relaxed);
            let is_cancelled = cancel.load(Ordering::Relaxed);
            let _ = app.emit("archive-progress", ArchiveProgress {
                total,
                completed: c,
                errors: e,
                active: !is_cancelled && (c + e) < total,
                last_error,
            });
        });
    }

    while set.join_next().await.is_some() {}

    let final_completed = completed.load(Ordering::Relaxed);
    let final_errors = errors.load(Ordering::Relaxed);

    info!(
        "archive_emails: done — {}/{} completed, {} errors",
        final_completed, total, final_errors
    );

    let result = ArchiveProgress {
        total,
        completed: final_completed,
        errors: final_errors,
        active: false,
        last_error: None,
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
) -> Result<(), String> {
    use base64::Engine;
    use std::fs;

    // Get a priority session for the fetch
    let mut session = pool.get_priority(account).await?;

    let email = imap::fetch_email_by_uid(&mut session, mailbox, uid)
        .await
        .map_err(|e| {
            // Don't return session on error — it may be broken
            format!("IMAP fetch failed: {}", e)
        })?;

    pool.return_priority(account, session).await;

    let email = email.ok_or_else(|| format!("Email UID {} not found", uid))?;

    let flags = ["archived".to_string(), "seen".to_string()];
    let cur_dir = super::maildir_cur_path(app_handle, account_id, mailbox)?;
    fs::create_dir_all(&cur_dir).map_err(|e| format!("mkdir: {}", e))?;

    if let Some(existing) = super::find_file_by_uid(&cur_dir, uid) {
        let _ = fs::remove_file(&existing);
    }

    let filename = super::build_maildir_filename(uid, &flags);
    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(&email.raw_source)
        .map_err(|e| format!("base64 decode: {}", e))?;

    fs::write(cur_dir.join(&filename), &raw_bytes)
        .map_err(|e| format!("write .eml: {}", e))?;

    info!("archive_emails: stored UID {} ({} bytes)", uid, raw_bytes.len());
    Ok(())
}
