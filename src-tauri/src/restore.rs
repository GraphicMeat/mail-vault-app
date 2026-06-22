//! Restore engine — re-upload locally-stored Maildir emails to a (new, empty)
//! IMAP server. Source = local disk, dest = live IMAP. Reuses migration.rs
//! helpers for folder-create, dedup, and Message-ID extraction.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::imap::{self, ImapConfig, ImapPool};
use crate::migration;

#[derive(Clone, Debug, Serialize)]
pub struct RestoreProgress {
    pub account_id: String,
    pub email: String,
    pub total_emails: u32,
    pub uploaded_emails: u32,
    pub skipped_emails: u32,
    pub failed_emails: u32,
    pub current_folder: Option<String>,
    pub folder_progress: Option<String>,
    pub status: String, // "running" | "completed" | "cancelled" | "failed"
}

pub struct RestoreCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);
impl Default for RestoreCancelToken {
    fn default() -> Self {
        RestoreCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

/// One local message ready to upload.
#[derive(Debug, Clone)]
pub struct LocalMsg {
    pub uid: u32,
    pub imap_flags: String, // e.g. "\\Seen \\Flagged", possibly empty
    pub path: PathBuf,
}

/// Parse Maildir flags from a filename in EITHER format and return a
/// space-joined IMAP flag string. archived/trashed are local-only and dropped.
///
/// Tauri format:  `{uid}:2,{LETTERS}.eml`  (letters: S F R D A T)
/// Core format:   `{uid}:{word,word}:{ts}.eml`  (words: seen,flagged,replied,draft,...)
pub fn parse_local_flags(filename: &str) -> String {
    let name = filename.strip_suffix(".eml").unwrap_or(filename);

    let mut out: Vec<&str> = Vec::new();
    let push = |out: &mut Vec<&str>, flag: &'static str| {
        if !out.contains(&flag) {
            out.push(flag);
        }
    };

    if let Some(letters) = name.split(":2,").nth(1) {
        let letters = letters.split(':').next().unwrap_or("");
        for c in letters.chars() {
            match c {
                'S' => push(&mut out, "\\Seen"),
                'F' => push(&mut out, "\\Flagged"),
                'R' => push(&mut out, "\\Answered"),
                'D' => push(&mut out, "\\Draft"),
                _ => {}
            }
        }
    } else {
        let parts: Vec<&str> = name.splitn(3, ':').collect();
        if let Some(words) = parts.get(1) {
            for w in words.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                match w.to_lowercase().as_str() {
                    "seen" => push(&mut out, "\\Seen"),
                    "flagged" => push(&mut out, "\\Flagged"),
                    "replied" | "answered" => push(&mut out, "\\Answered"),
                    "draft" => push(&mut out, "\\Draft"),
                    _ => {}
                }
            }
        }
    }
    out.join(" ")
}

/// List uploadable messages in a Maildir `cur` directory. Skips trashed
/// messages and non-message files. Returns messages sorted by UID.
pub fn list_messages_in_dir(cur_dir: &std::path::Path) -> Vec<LocalMsg> {
    let mut msgs: Vec<LocalMsg> = Vec::new();
    let entries = match std::fs::read_dir(cur_dir) {
        Ok(e) => e,
        Err(_) => return msgs,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let uid = match name.split(|c| c == ':' || c == '.').next().and_then(|s| s.parse::<u32>().ok()) {
            Some(u) => u,
            None => continue,
        };
        let is_trashed = name.split(":2,").nth(1)
            .map(|l| l.split(':').next().unwrap_or("").contains('T'))
            .unwrap_or(false)
            || name.split(':').nth(1).map(|w| w.split(',').any(|x| x.trim() == "trashed")).unwrap_or(false);
        if is_trashed {
            continue;
        }
        msgs.push(LocalMsg {
            uid,
            imap_flags: parse_local_flags(&name),
            path: entry.path(),
        });
    }
    msgs.sort_by_key(|m| m.uid);
    msgs
}

/// List uploadable messages for an account mailbox (real mailbox name).
/// Forward-maps the real name to its sanitized on-disk `cur` path.
pub fn list_local_messages(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
) -> Result<Vec<LocalMsg>, String> {
    let cur = crate::maildir_cur_path(app_handle, account_id, mailbox)?;
    Ok(list_messages_in_dir(&cur))
}

/// Re-upload local Maildir messages for `folders` (real mailbox names) to the
/// dest IMAP server. Idempotent: per folder, server Message-IDs are fetched
/// first and matching local messages are skipped (safe re-runs / partial-run
/// resume). Each APPEND is wrapped in a timeout to avoid the known Hostinger
/// APPEND hang stalling the whole run.
pub async fn run_restore(
    app_handle: tauri::AppHandle,
    account: ImapConfig,
    account_id: String,
    folders: Vec<String>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let pool = app_handle.state::<ImapPool>();
    let email = account.email.clone();

    let mut per_folder: Vec<(String, Vec<LocalMsg>)> = Vec::new();
    for folder in &folders {
        let msgs = list_local_messages(&app_handle, &account_id, folder)?;
        if !msgs.is_empty() {
            per_folder.push((folder.clone(), msgs));
        }
    }
    let total_emails: u32 = per_folder.iter().map(|(_, m)| m.len() as u32).sum();

    let mut uploaded: u32 = 0;
    let mut skipped: u32 = 0;
    let mut failed: u32 = 0;

    let emit = |app: &tauri::AppHandle,
                status: &str,
                current_folder: Option<String>,
                folder_progress: Option<String>,
                uploaded: u32,
                skipped: u32,
                failed: u32| {
        let _ = app.emit(
            "restore-progress",
            RestoreProgress {
                account_id: account_id.clone(),
                email: email.clone(),
                total_emails,
                uploaded_emails: uploaded,
                skipped_emails: skipped,
                failed_emails: failed,
                current_folder,
                folder_progress,
                status: status.to_string(),
            },
        );
    };

    emit(&app_handle, "running", None, None, 0, 0, 0);

    for (folder, msgs) in &per_folder {
        if cancel.load(Ordering::Relaxed) {
            emit(&app_handle, "cancelled", Some(folder.clone()), None, uploaded, skipped, failed);
            return Ok(());
        }

        let mut guard = match pool.get_priority(&account).await {
            Ok(g) => g,
            Err(e) => {
                warn!("[restore] pool checkout failed for {}: {}", folder, e);
                failed += msgs.len() as u32;
                emit(&app_handle, "running", Some(folder.clone()), None, uploaded, skipped, failed);
                continue;
            }
        };

        if let Err(e) = migration::ensure_dest_folder_imap(&mut guard.session, folder).await {
            warn!("[restore] CREATE {} failed, skipping folder: {}", folder, e);
            failed += msgs.len() as u32;
            pool.return_priority(&account, guard).await;
            emit(&app_handle, "running", Some(folder.clone()), None, uploaded, skipped, failed);
            continue;
        }

        let dest_ids = migration::fetch_dest_message_ids_imap(&mut guard.session, folder)
            .await
            .unwrap_or_default();

        let folder_total = msgs.len();
        for (idx, msg) in msgs.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                pool.return_priority(&account, guard).await;
                emit(&app_handle, "cancelled", Some(folder.clone()), None, uploaded, skipped, failed);
                return Ok(());
            }

            let raw = match std::fs::read(&msg.path) {
                Ok(b) => b,
                Err(e) => {
                    warn!("[restore] read {:?} failed: {}", msg.path, e);
                    failed += 1;
                    continue;
                }
            };

            if let Some(mid) = migration::extract_message_id(&raw) {
                if dest_ids.contains(&mid) {
                    skipped += 1;
                    continue;
                }
            }

            let append = imap::append_email(&mut guard.session, folder, &raw, &msg.imap_flags);
            match tokio::time::timeout(std::time::Duration::from_secs(30), append).await {
                Ok(Ok(())) => uploaded += 1,
                Ok(Err(e)) => {
                    warn!("[restore] APPEND uid {} to {} failed: {}", msg.uid, folder, e);
                    failed += 1;
                }
                Err(_) => {
                    warn!("[restore] APPEND uid {} to {} timed out", msg.uid, folder);
                    failed += 1;
                }
            }

            if idx % 10 == 0 || idx + 1 == folder_total {
                emit(
                    &app_handle,
                    "running",
                    Some(folder.clone()),
                    Some(format!("{}/{}", idx + 1, folder_total)),
                    uploaded,
                    skipped,
                    failed,
                );
            }
        }

        pool.return_priority(&account, guard).await;
    }

    info!(
        "[restore] done account={} uploaded={} skipped={} failed={}",
        account_id, uploaded, skipped, failed
    );
    emit(&app_handle, "completed", None, None, uploaded, skipped, failed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_local_flags_tauri_format() {
        assert_eq!(parse_local_flags("123:2,FS.eml"), "\\Flagged \\Seen");
        assert_eq!(parse_local_flags("9:2,R.eml"), "\\Answered");
        assert_eq!(parse_local_flags("9:2,AS.eml"), "\\Seen");
        assert_eq!(parse_local_flags("9:2,.eml"), "");
    }

    #[test]
    fn test_parse_local_flags_core_format() {
        assert_eq!(parse_local_flags("123:seen,flagged:1700000000.eml"), "\\Seen \\Flagged");
        assert_eq!(parse_local_flags("123:replied:1700000000.eml"), "\\Answered");
        assert_eq!(parse_local_flags("123::1700000000.eml"), "");
    }

    #[test]
    fn test_parse_local_flags_none() {
        assert_eq!(parse_local_flags("123.eml"), "");
        assert_eq!(parse_local_flags("123:.eml"), "");
    }

    #[test]
    fn test_list_messages_in_dir() {
        let dir = std::env::temp_dir().join("mailvault-test-restore-list");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("10:2,S.eml"), b"a").unwrap();
        std::fs::write(dir.join("2:2,.eml"), b"b").unwrap();
        std::fs::write(dir.join("30:seen,flagged:1700000000.eml"), b"c").unwrap();
        std::fs::write(dir.join("40:2,T.eml"), b"d").unwrap();
        std::fs::write(dir.join("local-index.json"), b"{}").unwrap();

        let msgs = list_messages_in_dir(&dir);
        let uids: Vec<u32> = msgs.iter().map(|m| m.uid).collect();
        assert_eq!(uids, vec![2, 10, 30]);
        let m30 = msgs.iter().find(|m| m.uid == 30).unwrap();
        assert_eq!(m30.imap_flags, "\\Seen \\Flagged");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
