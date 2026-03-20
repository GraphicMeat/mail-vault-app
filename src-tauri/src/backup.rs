use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::imap::{self, ImapConfig, ImapPool};

// ── Event payload ────────────────────────────────────────────────────────────

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

#[derive(Serialize)]
pub struct BackupResult {
    pub emails_backed_up: usize,
    pub errors: usize,
    pub duration_secs: f64,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

// ── Cancellation token (shared app state) ────────────────────────────────────

pub struct BackupCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);

impl Default for BackupCancelToken {
    fn default() -> Self {
        BackupCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

// ── Scan local UIDs from Maildir ─────────────────────────────────────────────

fn scan_local_uids(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
) -> Result<HashSet<u32>, String> {
    let cur_dir = crate::maildir_cur_path(app_handle, account_id, mailbox)?;
    if !cur_dir.exists() {
        return Ok(HashSet::new());
    }

    let mut uids = HashSet::new();
    let entries = std::fs::read_dir(&cur_dir)
        .map_err(|e| format!("Failed to read Maildir cur dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Filename format: "<uid>:<flags>.eml" or "<uid>.eml" or "<uid>_<flags>.eml"
        let uid_str = name
            .split(|c: char| c == ':' || c == '.' || c == '_')
            .next()
            .unwrap_or("");
        if let Ok(uid) = uid_str.parse::<u32>() {
            uids.insert(uid);
        }
    }

    Ok(uids)
}

// ── Core backup runner ───────────────────────────────────────────────────────

pub async fn run_account_backup(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    cancel: Arc<AtomicBool>,
    backup_path: Option<String>,
) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();

    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    // Check if this is a Graph account
    let is_graph = account.oauth2_transport.as_deref() == Some("graph");

    if is_graph {
        return run_graph_backup(app_handle, account_id, account_json, cancel, start, backup_path).await;
    }

    // ── IMAP path ────────────────────────────────────────────────────────────

    let pool = app_handle.state::<ImapPool>();

    // List all mailboxes
    let mailboxes = {
        let mut guard = pool.get_background(&account).await?;
        let result = imap::list_mailboxes(&mut guard.session).await?;
        pool.return_background(&account, guard).await;
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
    let selectable: Vec<_> = all_flat
        .into_iter()
        .filter(|m| !m.noselect)
        .collect();

    let total_folders = selectable.len();
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;

    info!(
        "backup: starting for {} ({} selectable folders)",
        account.email, total_folders
    );

    for mbox in &selectable {
        if cancel.load(Ordering::Relaxed) {
            warn!("backup: cancelled for {}", account.email);
            break;
        }

        let mailbox_path = &mbox.path;

        // Get server UIDs — always use plain UID SEARCH ALL for backup reliability.
        // ESEARCH can corrupt the session buffer on large mailboxes (imap_proto parser limit),
        // and the corrupted session makes all subsequent commands return 0 results.
        let server_uids = {
            let mut guard = pool.get_background(&account).await?;
            let result = imap::search_all_uids(&mut guard.session, mailbox_path, false).await;
            pool.return_background(&account, guard).await;
            result?
        };

        // Get local UIDs
        let local_uids = scan_local_uids(&app_handle, &account_id, mailbox_path)?;

        // Compute delta
        let missing: Vec<u32> = server_uids
            .iter()
            .filter(|uid| !local_uids.contains(uid))
            .copied()
            .collect();

        info!(
            "backup: {} — server={} uids, local={} uids, missing={} to back up",
            mailbox_path,
            server_uids.len(),
            local_uids.len(),
            missing.len()
        );

        // Emit progress BEFORE starting folder (so UI shows current folder immediately)
        let _ = app_handle.emit(
            "backup-progress",
            BackupProgress {
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
            },
        );

        // Pre-sync: copy files that exist in one location but not the other
        if let Some(ref custom_path) = backup_path {
            let app_dir = crate::maildir_cur_path(&app_handle, &account_id, mailbox_path)?;
            let backup_dir = std::path::PathBuf::from(custom_path)
                .join(&account.email)
                .join(mailbox_path)
                .join("cur");
            let synced = sync_locations(&app_dir, &backup_dir);
            if synced > 0 {
                info!("backup: pre-synced {} files between app and backup for {}", synced, mailbox_path);
            }
        }

        if !missing.is_empty() {
            // Fetch and store to BOTH app dir and backup dir simultaneously
            let archive_result = crate::archive::run_with_backup(
                app_handle.clone(),
                account_id.clone(),
                account_json.clone(),
                mailbox_path.clone(),
                missing,
                Arc::clone(&cancel),
                backup_path.clone(),
                Some(account.email.clone()),
            )
            .await?;

            total_backed_up += archive_result.completed;
            total_errors += archive_result.errors;
        }

        completed_folders += 1;

        // Emit progress AFTER folder completes
        let _ = app_handle.emit(
            "backup-progress",
            BackupProgress {
                account_id: account_id.clone(),
                folder: mailbox_path.clone(),
                total_folders,
                completed_folders,
                total_emails: total_backed_up + total_errors,
                completed_emails: total_backed_up,
                errors: total_errors,
                active: completed_folders < total_folders,
                last_error: None,
                missing_in_folder: 0,
            },
        );
    }

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup: completed for {} — {} new emails backed up, {} errors, {:.1}s{}",
        account.email, total_backed_up, total_errors, duration,
        if let Some(ref p) = backup_path { format!(" (copied to {})", p) } else { String::new() }
    );

    Ok(BackupResult {
        emails_backed_up: total_backed_up,
        errors: total_errors,
        duration_secs: duration,
        success: total_errors == 0,
        error_message: None,
    })
}

/// Sync files between app Maildir and backup location (bidirectional).
/// - App dir files missing from backup → copy to backup as <uid>.eml
/// - Backup .eml files missing from app dir → copy to app dir
/// Returns total files synced.
fn sync_locations(app_dir: &std::path::Path, backup_dir: &std::path::Path) -> usize {
    use std::fs;
    let mut synced = 0;

    // Ensure both dirs exist; if backup dir can't be created (disconnected drive), skip
    let _ = fs::create_dir_all(app_dir);
    if fs::create_dir_all(backup_dir).is_err() {
        return 0; // Backup location not available — skip sync, backup to app dir only
    }

    // App → Backup: copy app files that don't exist in backup
    if let Ok(entries) = fs::read_dir(app_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            let uid_str = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or(&name);
            if uid_str.parse::<u32>().is_err() { continue; }
            let dst = backup_dir.join(format!("{}.eml", uid_str));
            if !dst.exists() {
                if fs::copy(entry.path(), &dst).is_ok() { synced += 1; }
            }
        }
    }

    // Backup → App: copy backup .eml files that don't exist in app dir
    if let Ok(entries) = fs::read_dir(backup_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".eml") { continue; }
            let uid_str = name.trim_end_matches(".eml");
            if uid_str.parse::<u32>().is_err() { continue; }
            // Check if app dir already has this UID (any filename starting with uid)
            let uid: u32 = uid_str.parse().unwrap();
            let exists_in_app = super::find_file_by_uid(app_dir, uid).is_some();
            if !exists_in_app {
                let dst = app_dir.join(format!("{}:2,", uid));
                if fs::copy(entry.path(), &dst).is_ok() { synced += 1; }
            }
        }
    }

    synced
}

// ── Graph API backup path ────────────────────────────────────────────────────

async fn run_graph_backup(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    cancel: Arc<AtomicBool>,
    start: std::time::Instant,
    _backup_path: Option<String>,
) -> Result<BackupResult, String> {
    // Parse just the access token from the JSON
    let json_val: serde_json::Value = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;
    let access_token = json_val
        .get("oauth2AccessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing oauth2AccessToken for Graph account".to_string())?;

    let client = crate::graph::GraphClient::new(access_token);

    // List folders
    let folders = client.list_folders().await?;
    let total_folders = folders.len();
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;

    info!(
        "backup(graph): starting for account {} ({} folders)",
        account_id, total_folders
    );

    for folder in &folders {
        if cancel.load(Ordering::Relaxed) {
            warn!("backup(graph): cancelled for account {}", account_id);
            break;
        }

        let folder_name = &folder.display_name;
        // Normalize folder name for Maildir path (same as frontend mapping)
        let mailbox_path = normalize_graph_folder_name(folder_name);

        // Get local UIDs
        let local_uids = scan_local_uids(&app_handle, &account_id, &mailbox_path)?;

        // Paginate through all messages to find missing ones
        let mut skip = 0u32;
        let page_size = 100u32;
        let mut uid_counter = 0u32;

        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let (messages, next_link) = client.list_messages(&folder.id, page_size, skip).await?;
            if messages.is_empty() {
                break;
            }

            for msg in &messages {
                uid_counter += 1;
                if local_uids.contains(&uid_counter) {
                    continue;
                }

                // Fetch MIME content and store
                match client.get_mime_content(&msg.id).await {
                    Ok(raw_bytes) => {
                        let cur_dir =
                            crate::maildir_cur_path(&app_handle, &account_id, &mailbox_path)?;
                        std::fs::create_dir_all(&cur_dir)
                            .map_err(|e| format!("mkdir: {}", e))?;

                        if crate::find_file_by_uid(&cur_dir, uid_counter).is_none() {
                            let filename = crate::build_maildir_filename(
                                uid_counter,
                                &[] as &[String],
                            );
                            std::fs::write(cur_dir.join(&filename), &raw_bytes)
                                .map_err(|e| format!("write .eml: {}", e))?;
                            total_backed_up += 1;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "backup(graph): failed to fetch message {} in {}: {}",
                            msg.id, folder_name, e
                        );
                        total_errors += 1;
                    }
                }
            }

            if next_link.is_none() || messages.len() < page_size as usize {
                break;
            }
            skip += page_size;
        }

        completed_folders += 1;

        let _ = app_handle.emit(
            "backup-progress",
            BackupProgress {
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
            },
        );
    }

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup(graph): completed for {} — {} emails backed up, {} errors, {:.1}s",
        account_id, total_backed_up, total_errors, duration
    );

    Ok(BackupResult {
        emails_backed_up: total_backed_up,
        errors: total_errors,
        duration_secs: duration,
        success: total_errors == 0,
        error_message: None,
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/// Normalize Graph folder display name to IMAP-style path
fn normalize_graph_folder_name(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "inbox" => "INBOX".to_string(),
        "sent items" => "Sent".to_string(),
        "deleted items" => "Trash".to_string(),
        "drafts" => "Drafts".to_string(),
        "junk email" => "Junk".to_string(),
        "archive" => "Archive".to_string(),
        _ => name.to_string(),
    }
}
