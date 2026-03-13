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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "lastUid")]
    pub last_uid: Option<u32>,
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
        total, completed: 0, errors: 0, active: true, last_error: None, last_uid: None,
    });

    let sem = Arc::new(Semaphore::new(5));
    let completed = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));
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
        let pool = pool.inner().clone();

        set.spawn(async move {
            let _permit = sem.acquire().await.unwrap();

            if cancel.load(Ordering::Relaxed) {
                return None;
            }

            match fetch_and_store(
                &pool, &app, &account_id, &account, &mailbox, uid,
            ).await {
                Ok(index_entry) => {
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
                    });
                    Some(index_entry)
                }
                Err(last_error) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    warn!("archive_emails: UID {} failed: {:?}", uid, last_error);
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
        if let Ok(data_dir) = app_handle.path().app_data_dir() {
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
        last_uid: None,
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
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    use std::fs;

    // Get a priority session for the fetch
    let (mut session, _last_sel) = pool.get_priority(account).await?;

    let email = imap::fetch_email_by_uid(&mut session, mailbox, uid)
        .await
        .map_err(|e| {
            // Don't return session on error — it may be broken
            format!("IMAP fetch failed: {}", e)
        })?;

    pool.return_priority(account, session, Some(mailbox.to_string())).await;

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

    // Parse In-Reply-To and References from raw email for threading
    let (in_reply_to, references) = parse_threading_headers(&raw_bytes);

    // Generate snippet from text body
    let snippet = email.text.as_deref()
        .unwrap_or("")
        .chars().take(150).collect::<String>()
        .replace('\n', " ").replace('\r', "");

    fs::write(cur_dir.join(&filename), &raw_bytes)
        .map_err(|e| format!("write .eml: {}", e))?;

    info!("archive_emails: stored UID {} ({} bytes)", uid, raw_bytes.len());

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
    })
}

async fn delete_single_email(
    pool: &ImapPool,
    account: &ImapConfig,
    mailbox: &str,
    uid: u32,
) -> Result<(), String> {
    let (mut session, _last_sel) = pool.get_priority(account).await?;

    let result = imap::delete_email(&mut session, mailbox, uid, true).await;

    if result.is_ok() {
        pool.return_priority(account, session, Some(mailbox.to_string())).await;
    }
    // On error, don't return session — it may be broken

    result
}
