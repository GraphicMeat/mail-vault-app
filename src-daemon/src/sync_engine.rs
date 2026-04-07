//! Sync Engine — background email synchronization.
//!
//! Owns all IMAP connections and writes to local Maildir + cache.
//! The app never calls IMAP directly — it reads from local storage
//! and listens for sync events.

use crate::imap::{self, ImapConfig, EmailHeader as ImapEmailHeader};
use crate::imap::pool::{ImapPool, PooledSessionGuard};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn, error};

/// Result of a single account sync.
#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    pub account_id: String,
    pub mailbox: String,
    pub new_emails: usize,
    pub updated_flags: usize,
    pub total_emails: u32,
    pub success: bool,
    pub error: Option<String>,
}

/// Account configuration for sync (loaded from keychain/settings).
#[derive(Debug, Clone, Deserialize)]
pub struct SyncAccount {
    pub id: String,
    pub email: String,
    #[serde(rename = "imapConfig")]
    pub imap_config: ImapConfig,
}

/// Current sync state for an account.
#[derive(Debug, Clone, Serialize)]
pub struct SyncState {
    pub account_id: String,
    pub status: SyncStatus,
    pub last_sync: Option<u64>, // unix timestamp
    pub last_error: Option<String>,
    pub new_emails: usize,
    pub total_emails: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum SyncStatus {
    Idle,
    Syncing,
    Error,
}

/// The sync engine manages background email sync for all accounts.
pub struct SyncEngine {
    pool: Arc<ImapPool>,
    data_dir: PathBuf,
    states: Mutex<HashMap<String, SyncState>>,
    /// Watch channels per account — notified when sync completes.
    /// `sync.wait` RPC handler subscribes to these for efficient blocking.
    watchers: Mutex<HashMap<String, tokio::sync::watch::Sender<Option<SyncResult>>>>,
}

impl SyncEngine {
    pub fn new(pool: Arc<ImapPool>, data_dir: PathBuf) -> Self {
        Self {
            pool,
            data_dir,
            states: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Get or create a watch channel for an account.
    async fn get_watcher(&self, account_id: &str) -> tokio::sync::watch::Receiver<Option<SyncResult>> {
        let mut watchers = self.watchers.lock().await;
        if let Some(sender) = watchers.get(account_id) {
            return sender.subscribe();
        }
        let (tx, rx) = tokio::sync::watch::channel(None);
        watchers.insert(account_id.to_string(), tx);
        rx
    }

    /// Wait for a sync to complete for a specific account, with timeout.
    pub async fn wait_for_sync(&self, account_id: &str, timeout_ms: u64) -> Result<SyncResult, String> {
        let mut rx = self.get_watcher(account_id).await;

        // Check if a result is already available (sync completed before we subscribed)
        if let Some(result) = rx.borrow().clone() {
            return Ok(result);
        }

        // Also check the sync state — if it's already Idle with a last_sync, return immediately
        if let Some(state) = self.get_state(account_id).await {
            if state.status == SyncStatus::Idle && state.last_sync.is_some() {
                return Ok(SyncResult {
                    account_id: account_id.to_string(),
                    mailbox: String::new(),
                    new_emails: state.new_emails,
                    updated_flags: 0,
                    total_emails: state.total_emails,
                    success: true,
                    error: None,
                });
            }
            if state.status == SyncStatus::Error {
                return Err(state.last_error.unwrap_or_else(|| "Sync failed".to_string()));
            }
        }

        // Wait for the next sync completion
        let timeout = tokio::time::Duration::from_millis(timeout_ms);
        match tokio::time::timeout(timeout, async {
            loop {
                rx.changed().await.map_err(|_| "Sync watcher closed".to_string())?;
                if let Some(result) = rx.borrow().clone() {
                    return Ok(result);
                }
            }
        }).await {
            Ok(result) => result,
            Err(_) => {
                // Timeout — check state one more time
                if let Some(state) = self.get_state(account_id).await {
                    if state.status == SyncStatus::Idle && state.last_sync.is_some() {
                        return Ok(SyncResult {
                            account_id: account_id.to_string(),
                            mailbox: String::new(),
                            new_emails: state.new_emails,
                            updated_flags: 0,
                            total_emails: state.total_emails,
                            success: true,
                            error: None,
                        });
                    }
                }
                Err("Sync timed out".to_string())
            }
        }
    }

    /// Sync a single account's INBOX (or specified mailbox).
    /// Fetches headers, writes to cache, returns what changed.
    pub async fn sync_account(
        &self,
        account: &SyncAccount,
        mailbox: &str,
    ) -> SyncResult {
        let account_id = &account.id;

        // Update state to syncing
        {
            let mut states = self.states.lock().await;
            states.insert(account_id.clone(), SyncState {
                account_id: account_id.clone(),
                status: SyncStatus::Syncing,
                last_sync: None,
                last_error: None,
                new_emails: 0,
                total_emails: 0,
            });
        }

        info!("[sync] Starting sync for {} ({})", account.email, mailbox);

        let result = self.do_sync(account, mailbox).await;

        // Update state
        {
            let mut states = self.states.lock().await;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            states.insert(account_id.clone(), SyncState {
                account_id: account_id.clone(),
                status: if result.success { SyncStatus::Idle } else { SyncStatus::Error },
                last_sync: Some(now),
                last_error: result.error.clone(),
                new_emails: result.new_emails,
                total_emails: result.total_emails,
            });
        }

        if result.success {
            info!(
                "[sync] Sync complete for {}: {} new, {} flag updates, {} total",
                account.email, result.new_emails, result.updated_flags, result.total_emails
            );
        } else {
            warn!("[sync] Sync failed for {}: {:?}", account.email, result.error);
        }

        // Notify any waiting clients
        {
            let watchers = self.watchers.lock().await;
            if let Some(tx) = watchers.get(account_id) {
                let _ = tx.send(Some(result.clone()));
            }
        }

        result
    }

    /// Internal sync implementation.
    async fn do_sync(
        &self,
        account: &SyncAccount,
        mailbox: &str,
    ) -> SyncResult {
        let account_id = &account.id;
        let config = &account.imap_config;

        // Get a session from the pool
        let guard = match self.pool.get_background(config).await {
            Ok(g) => g,
            Err(e) => return SyncResult {
                account_id: account_id.clone(),
                mailbox: mailbox.to_string(),
                new_emails: 0, updated_flags: 0, total_emails: 0,
                success: false, error: Some(e),
            },
        };

        let PooledSessionGuard { mut session, last_selected: _, _permit } = guard;

        // Check mailbox status — returns (exists, uid_validity, uid_next, highest_modseq)
        let (total, uid_validity, server_uid_next, highest_modseq) =
            match imap::check_mailbox_status(&mut session, mailbox, false).await {
                Ok(s) => s,
                Err(e) => {
                    return SyncResult {
                        account_id: account_id.clone(),
                        mailbox: mailbox.to_string(),
                        new_emails: 0, updated_flags: 0, total_emails: 0,
                        success: false, error: Some(e),
                    };
                }
            };

        // Load cached metadata from Tauri's sidecar format to check if anything changed
        let cached_uid_next = read_tauri_cache_uid_next(&self.data_dir, account_id, mailbox);

        // Quick check: if uidNext hasn't changed AND cached email files exist, nothing new
        let cache_dir = tauri_cache_dir(&self.data_dir, account_id, mailbox);
        let sidecar_count = fs::read_dir(&cache_dir).ok()
            .map(|entries| entries.flatten().filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.ends_with(".json") && name != "_meta.json"
            }).count())
            .unwrap_or(0);

        if let (Some(cached), Some(server)) = (cached_uid_next, server_uid_next) {
            if cached == server && sidecar_count > 0 {
                info!("[sync] No new emails for {} (uidNext unchanged: {}, {} cached files)", account.email, cached, sidecar_count);

                // Return session to pool
                let return_guard = PooledSessionGuard {
                    session,
                    last_selected: Some(mailbox.to_string()),
                    _permit,
                };
                self.pool.return_background(config, return_guard).await;

                return SyncResult {
                    account_id: account_id.clone(),
                    mailbox: mailbox.to_string(),
                    new_emails: 0, updated_flags: 0, total_emails: total,
                    success: true, error: None,
                };
            }
        }

        // Fetch first page of emails
        let fetch_result = match imap::fetch_emails_page(&mut session, mailbox, 1, 500).await {
            Ok(r) => r,
            Err(e) => {
                return SyncResult {
                    account_id: account_id.clone(),
                    mailbox: mailbox.to_string(),
                    new_emails: 0, updated_flags: 0, total_emails: total,
                    success: false, error: Some(e),
                };
            }
        };

        let (headers, _total_from_fetch, _has_more, _skipped) = fetch_result;

        let new_count = headers.len();

        // Write to Tauri's sidecar cache format so the app can read it directly:
        // email_cache/{accountId}_{mailbox}/_meta.json + {uid}.json per email
        if let Err(e) = write_tauri_cache(
            &self.data_dir, account_id, mailbox, &headers,
            total, uid_validity, server_uid_next, highest_modseq,
        ) {
            warn!("[sync] Failed to write cache for {}: {}", account.email, e);
        }

        // Return session to pool
        let return_guard = PooledSessionGuard {
            session,
            last_selected: Some(mailbox.to_string()),
            _permit,
        };
        self.pool.return_background(config, return_guard).await;

        SyncResult {
            account_id: account_id.clone(),
            mailbox: mailbox.to_string(),
            new_emails: new_count,
            updated_flags: 0,
            total_emails: total,
            success: true,
            error: None,
        }
    }

    /// Get current sync state for all accounts.
    pub async fn get_states(&self) -> Vec<SyncState> {
        self.states.lock().await.values().cloned().collect()
    }

    /// Get sync state for a single account.
    pub async fn get_state(&self, account_id: &str) -> Option<SyncState> {
        self.states.lock().await.get(account_id).cloned()
    }
}

// ── Tauri-compatible cache format ────────────────────────────────────────────
// Matches the sidecar format used by save_email_cache / load_email_cache_partial
// in src-tauri/src/main.rs so the app reads daemon-written cache natively.

fn cache_base_name(account_id: &str, mailbox: &str) -> String {
    format!("{}_{}",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_"),
    )
}

fn tauri_cache_dir(data_dir: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    data_dir.join("email_cache").join(cache_base_name(account_id, mailbox))
}

/// Read uidNext from Tauri's _meta.json sidecar cache.
fn read_tauri_cache_uid_next(data_dir: &Path, account_id: &str, mailbox: &str) -> Option<u32> {
    let meta_path = tauri_cache_dir(data_dir, account_id, mailbox).join("_meta.json");
    let json = fs::read_to_string(&meta_path).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&json).ok()?;
    meta.get("uidNext").and_then(|v| v.as_u64()).map(|v| v as u32)
}

/// Write email headers in Tauri's sidecar cache format.
fn write_tauri_cache(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
    headers: &[ImapEmailHeader],
    total_emails: u32,
    uid_validity: Option<u32>,
    uid_next: Option<u32>,
    highest_modseq: Option<u64>,
) -> Result<(), String> {
    let dir = tauri_cache_dir(data_dir, account_id, mailbox);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;

    // Write _meta.json
    let meta = serde_json::json!({
        "totalEmails": total_emails,
        "uidValidity": uid_validity,
        "uidNext": uid_next,
        "highestModseq": highest_modseq,
        "lastSynced": chrono::Utc::now().to_rfc3339(),
    });
    let meta_json = serde_json::to_string(&meta).map_err(|e| format!("Serialize meta: {}", e))?;
    fs::write(dir.join("_meta.json"), &meta_json).map_err(|e| format!("Write meta: {}", e))?;

    // Write individual {uid}.json files (skip existing for performance)
    let mut written = 0;
    for header in headers {
        let file_path = dir.join(format!("{}.json", header.uid));
        if !file_path.exists() {
            // Serialize the IMAP header as-is — it already has the right JSON shape
            // (uid, messageId, subject, from, to, cc, date, flags, hasAttachments, etc.)
            let email_json = serde_json::to_string(header).map_err(|e| format!("Serialize email {}: {}", header.uid, e))?;
            fs::write(&file_path, &email_json).map_err(|e| format!("Write email {}: {}", header.uid, e))?;
            written += 1;
        }
    }

    info!(
        "[sync] Cache written: {} new files, {} total in {}",
        written,
        headers.len(),
        cache_base_name(account_id, mailbox),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_result_serialization() {
        let result = SyncResult {
            account_id: "acc1".into(),
            mailbox: "INBOX".into(),
            new_emails: 5,
            updated_flags: 2,
            total_emails: 100,
            success: true,
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"new_emails\":5"));
        assert!(json.contains("\"success\":true"));
    }

    #[test]
    fn test_sync_state_serialization() {
        let state = SyncState {
            account_id: "acc1".into(),
            status: SyncStatus::Syncing,
            last_sync: Some(1234567890),
            last_error: None,
            new_emails: 0,
            total_emails: 0,
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"Syncing\""));
    }
}
