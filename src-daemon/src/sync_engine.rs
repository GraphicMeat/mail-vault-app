//! Sync Engine — background email synchronization.
//!
//! Owns all IMAP connections and writes to local Maildir + cache.
//! The app never calls IMAP directly — it reads from local storage
//! and listens for sync events.

use crate::contacts_index::ContactsState;
use crate::imap::{self, ImapConfig, EmailHeader as ImapEmailHeader};
use crate::imap::pool::{ImapPool, PooledSessionGuard};
use mailvault_core::transfer_stats;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    /// App data dir (settings + transfer stats). Distinct from `data_dir`,
    /// which follows the — possibly relocated — mail vault.
    app_dir: PathBuf,
    states: Mutex<HashMap<String, SyncState>>,
    /// Watch channels per account — notified when sync completes.
    /// `sync.wait` RPC handler subscribes to these for efficient blocking.
    watchers: Mutex<HashMap<String, tokio::sync::watch::Sender<Option<SyncResult>>>>,
    contacts: Arc<ContactsState>,
    /// `account_id\x01mailbox` keys with a backfill IN FLIGHT right now.
    /// The app pauses its own pagination while this is set, so it must clear
    /// the moment the backfill stops — success or failure.
    backfilling: Mutex<HashSet<String>>,
    /// Keys whose backfill ran and got nowhere. Kept for the life of the
    /// process so an unfetchable mailbox can't retry in a loop — but NOT
    /// reported as `backfilling`, or the app would wait on it forever.
    backfill_gave_up: Mutex<HashSet<String>>,
    /// `account_id` → UTC day whose cap we already logged, so a capped account
    /// costs one log line a day instead of one per sync tick.
    cap_logged: Mutex<HashMap<String, String>>,
}

impl SyncEngine {
    pub fn new(
        pool: Arc<ImapPool>,
        data_dir: PathBuf,
        app_dir: PathBuf,
        contacts: Arc<ContactsState>,
    ) -> Self {
        Self {
            pool,
            data_dir,
            app_dir,
            states: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            contacts,
            backfilling: Mutex::new(HashSet::new()),
            backfill_gave_up: Mutex::new(HashSet::new()),
            cap_logged: Mutex::new(HashMap::new()),
        }
    }

    /// `Some(reason)` when this account has spent its daily transfer allowance
    /// and must not sync again until the next UTC day. `None` = go ahead.
    async fn transfer_cap_reached(&self, account: &SyncAccount) -> Option<String> {
        let limits = read_transfer_limits(&self.app_dir, &account.id)?;
        if !limits.cap_enabled {
            return None;
        }
        let (default_down, default_up) = default_limits(&account.imap_config.host);
        let down_limit = limits.daily_down_limit_bytes.or(default_down);
        let up_limit = limits.daily_up_limit_bytes.or(default_up);

        let used = transfer_stats::usage_today(&self.app_dir, &account.id);
        let over_down = down_limit.is_some_and(|l| used.down >= l);
        let over_up = up_limit.is_some_and(|l| used.up >= l);
        if !over_down && !over_up {
            return None;
        }

        let reason = format!(
            "Daily transfer cap reached ({} MB down / {} MB up today) — sync paused until the next UTC day",
            used.down / MB,
            used.up / MB,
        );
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if self.cap_logged.lock().await.insert(account.id.clone(), today.clone()) != Some(today) {
            warn!("[sync] {} for {}", reason, account.email);
        }
        Some(reason)
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

        // Soft daily cap: skip the account entirely rather than spend the
        // remaining allowance. Resets on its own at the next UTC day.
        if let Some(reason) = self.transfer_cap_reached(account).await {
            return SyncResult {
                account_id: account_id.clone(),
                mailbox: mailbox.to_string(),
                new_emails: 0, updated_flags: 0, total_emails: 0,
                success: false, error: Some(reason),
            };
        }

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
        let has_condstore = self.pool.has_capability(config, "CONDSTORE").await;

        let outcome = self.sync_mailbox(&mut session, account, mailbox, has_condstore).await;

        let guard = PooledSessionGuard {
            session,
            last_selected: Some(mailbox.to_string()),
            _permit,
        };
        // Hand the session back on success; on error discard it — a failed
        // command can leave unread bytes that desync every later command on it.
        // Either way the permit is released (a failed sync used to leak a slot).
        match &outcome {
            Ok(d) if !d.session_dirty => self.pool.return_background(config, guard).await,
            _ => self.pool.discard(config, guard).await,
        }

        match outcome {
            Ok(delta) => SyncResult {
                account_id: account_id.clone(),
                mailbox: mailbox.to_string(),
                new_emails: delta.new_emails,
                updated_flags: delta.updated_flags,
                total_emails: delta.total_emails,
                success: true,
                error: None,
            },
            Err(e) => SyncResult {
                account_id: account_id.clone(),
                mailbox: mailbox.to_string(),
                new_emails: 0, updated_flags: 0, total_emails: 0,
                success: false, error: Some(e),
            },
        }
    }

    /// Delta sync for one mailbox.
    ///
    /// Cold cache (or UIDVALIDITY change) → one 500-header page fetch.
    /// Warm cache → STATUS + only the UIDs above the cached UIDNEXT, plus a
    /// CONDSTORE flag patch and an expunge prune when the counts disagree.
    /// A typical restart is therefore a handful of headers, not 500.
    async fn sync_mailbox(
        &self,
        session: &mut imap::ImapSession,
        account: &SyncAccount,
        mailbox: &str,
        has_condstore: bool,
    ) -> Result<SyncDelta, String> {
        let account_id = &account.id;

        let (total, uid_validity, server_uid_next, highest_modseq) =
            imap::check_mailbox_status(session, mailbox, has_condstore).await?;

        let cache_dir = tauri_cache_dir(&self.data_dir, account_id, mailbox);
        let cached = read_tauri_cache_meta(&cache_dir);
        let sidecar_count = count_sidecars(&cache_dir);

        let uid_validity_ok = match (cached.as_ref().and_then(|c| c.uid_validity), uid_validity) {
            (Some(a), Some(b)) => a == b,
            _ => true, // unknown on either side — don't force a full reload over it
        };

        let cached_uid_next = cached.as_ref().and_then(|c| c.uid_next);
        let can_delta = sidecar_count > 0 && uid_validity_ok && cached_uid_next.is_some();

        // ── Cold path: no usable cache — fetch the first page ──
        if !can_delta {
            // A UIDVALIDITY change means the server re-issued its UID space:
            // every cached UID now refers to a different message (or none).
            // Drop the whole generation, or those ghosts outlive the reload.
            if !uid_validity_ok {
                warn!(
                    "[sync] UIDVALIDITY changed for {} ({}) — clearing {} cached sidecars",
                    account.email, mailbox, sidecar_count
                );
                let _ = fs::remove_dir_all(&cache_dir);
            }
            let (headers, _total, _has_more, _skipped) =
                imap::fetch_emails_page(session, mailbox, 1, 500).await?;
            let new_emails = headers.len();
            write_cache_meta(&cache_dir, total, uid_validity, server_uid_next, highest_modseq)?;
            write_headers(&cache_dir, &headers)?;
            self.contacts.observe_headers(account_id, mailbox, &headers);
            info!("[sync] Full page sync for {} ({}): {} headers", account.email, mailbox, new_emails);
            return Ok(SyncDelta { new_emails, updated_flags: 0, total_emails: total, session_dirty: false });
        }

        // ── Delta path ──
        let cached_uid_next = cached_uid_next.unwrap();
        let cached_total = cached.as_ref().and_then(|c| c.total_emails).unwrap_or(0);
        let cached_modseq = cached.as_ref().and_then(|c| c.highest_modseq);
        let server_next = server_uid_next.unwrap_or(cached_uid_next);

        // 1. New arrivals — UIDs at or above the last known UIDNEXT.
        let mut new_headers = Vec::new();
        if server_next > cached_uid_next {
            let gap = server_next - cached_uid_next;
            if gap > MAX_DELTA_UID_GAP {
                // Too far behind for a range fetch to be cheaper than a page.
                let (headers, _t, _h, _s) = imap::fetch_emails_page(session, mailbox, 1, 500).await?;
                new_headers = headers;
            } else {
                let uids: Vec<u32> = (cached_uid_next..server_next).collect();
                let (headers, _t) = imap::fetch_headers_by_uids(session, mailbox, &uids).await?;
                new_headers = headers;
            }
        }

        // 2. Flag changes — CONDSTORE tells us exactly which UIDs moved.
        let mut updated_flags = 0;
        match (cached_modseq, highest_modseq) {
            (Some(cached_modseq), Some(server_modseq)) if server_modseq != cached_modseq => {
                match imap::fetch_changed_flags(session, mailbox, cached_modseq).await {
                    Ok(changes) => updated_flags = patch_sidecar_flags(&cache_dir, &changes),
                    Err(e) => warn!("[sync] CHANGEDSINCE failed for {}: {}", account.email, e),
                }
            }
            (Some(_), Some(_)) => {} // modseq unchanged — no flags moved
            _ => {
                // No CONDSTORE: nothing would ever refresh read/star state on
                // already-cached messages. Re-read flags (no headers) for the
                // recent window instead — one command, ~40 bytes per message.
                let from_uid = cached_uid_next.saturating_sub(FLAG_REFRESH_WINDOW).max(1);
                match imap::fetch_flags_from(session, mailbox, from_uid).await {
                    Ok(flags) => updated_flags = patch_sidecar_flags(&cache_dir, &flags),
                    Err(e) => warn!("[sync] Flag refresh failed for {}: {}", account.email, e),
                }
            }
        }

        // 3. Expunges — CONDSTORE cannot report them (CHANGEDSINCE reports flag
        //    changes, never removals) and UIDNEXT does not move on delete, so the
        //    only cheap signal is the message count: a delete anywhere in the
        //    mailbox, oldest included, shifts EXISTS by -1 while new_headers
        //    accounts for the arrivals.
        //
        //    That gate has one blind spot: if a fetch silently skips an arrival
        //    AND the same number of messages were expunged, the counts cancel and
        //    a deleted message would linger. So also reconcile on a timer — one
        //    UID SEARCH ALL per RECONCILE_INTERVAL_MS bounds how long any missed
        //    expunge can survive, at negligible cost.
        let expected_total = cached_total + new_headers.len() as u32;
        let counts_disagree = total != expected_total;
        let reconcile_due = cached
            .as_ref()
            .and_then(|c| c.last_reconcile)
            .map_or(true, |t| now_ms().saturating_sub(t) > RECONCILE_INTERVAL_MS);

        let mut reconciled_at = cached.as_ref().and_then(|c| c.last_reconcile);
        let mut session_dirty = false;
        if counts_disagree || reconcile_due {
            match imap::search_all_uids(session, mailbox, false).await {
                Ok(uids) if uids.is_empty() && total > 0 => {
                    warn!("[sync] UID SEARCH returned 0 but EXISTS={} — skipping prune", total);
                }
                Ok(uids) => {
                    let pruned = prune_sidecars(&cache_dir, &uids);
                    reconciled_at = Some(now_ms());
                    info!(
                        "[sync] Reconciled {} ({}): {} server UIDs, {} pruned (counts_disagree={}, due={})",
                        account.email, mailbox, uids.len(), pruned, counts_disagree, reconcile_due
                    );
                }
                Err(e) => {
                    warn!("[sync] UID listing failed for {}: {}", account.email, e);
                    session_dirty = true;
                }
            }
        }

        write_cache_meta_full(&cache_dir, total, uid_validity, server_uid_next, highest_modseq, reconciled_at)?;
        if !new_headers.is_empty() {
            write_headers(&cache_dir, &new_headers)?;
            self.contacts.observe_headers(account_id, mailbox, &new_headers);
        }

        info!(
            "[sync] Delta sync for {} ({}): {} new, {} flag updates, {} total",
            account.email, mailbox, new_headers.len(), updated_flags, total
        );

        Ok(SyncDelta {
            new_emails: new_headers.len(),
            updated_flags,
            total_emails: total,
            session_dirty,
        })
    }

    /// Get current sync state for all accounts.
    pub async fn get_states(&self) -> Vec<SyncState> {
        self.states.lock().await.values().cloned().collect()
    }

    /// Get sync state for a single account.
    pub async fn get_state(&self, account_id: &str) -> Option<SyncState> {
        self.states.lock().await.get(account_id).cloned()
    }

    /// Is a cold-cache backfill in flight for this account (any mailbox)?
    ///
    /// The app asks before falling back to its own server pagination — without
    /// this the two would race, each re-downloading what the other just wrote.
    pub async fn is_backfilling(&self, account_id: &str) -> bool {
        let prefix = format!("{}\u{1}", account_id);
        self.backfilling.lock().await.iter().any(|k| k.starts_with(&prefix))
    }

    /// How many messages the server has that the sidecar cache does not.
    ///
    /// The delta gate can't see this: it compares the server's EXISTS against
    /// `_meta.json.totalEmails`, which is the count the server reported LAST
    /// time — so a mailbox holding 503 sidecars out of 15,060 looks perfectly
    /// in sync, and nothing ever fills it in.
    pub fn sidecar_shortfall(&self, account_id: &str, mailbox: &str, total: u32) -> usize {
        let cache_dir = tauri_cache_dir(&self.data_dir, account_id, mailbox);
        (total as usize).saturating_sub(count_sidecars(&cache_dir))
    }

    /// Fill the sidecar cache up to the server's full message list.
    ///
    /// Runs after the delta sync has already answered the client, so it never
    /// delays `sync.wait`. Writes headers chunk by chunk rather than at the end,
    /// so the app's cache-drain sees progress while this is still running.
    pub async fn backfill_mailbox(&self, account: &SyncAccount, mailbox: &str) {
        let key = format!("{}\u{1}{}", account.id, mailbox);
        if self.backfill_gave_up.lock().await.contains(&key) {
            return; // a previous attempt got nowhere — don't re-scan every sync
        }
        if !self.backfilling.lock().await.insert(key.clone()) {
            return; // already in flight
        }

        let fetched = self.run_backfill(account, mailbox).await;

        // Always clear in-flight first: the app pauses its own pagination while
        // this is set, so leaving it on a failure strands the mailbox loading
        // forever with nothing actually fetching.
        self.backfilling.lock().await.remove(&key);

        match fetched {
            Ok(n) if n > 0 => {}
            Ok(_) => {
                info!("[backfill] Nothing fetched for {} ({}) — not retrying this session", account.email, mailbox);
                self.backfill_gave_up.lock().await.insert(key);
            }
            Err(e) => {
                warn!("[backfill] Failed for {} ({}): {}", account.email, mailbox, e);
                self.backfill_gave_up.lock().await.insert(key);
            }
        }
    }

    async fn run_backfill(&self, account: &SyncAccount, mailbox: &str) -> Result<usize, String> {
        let config = &account.imap_config;
        let guard = self.pool.get_background(config).await?;
        let PooledSessionGuard { mut session, last_selected: _, _permit } = guard;

        let outcome = self.backfill_with_session(&mut session, account, mailbox).await;

        let guard = PooledSessionGuard {
            session,
            last_selected: Some(mailbox.to_string()),
            _permit,
        };
        // A failed command may have left unread bytes in the session buffer —
        // re-pooling it hands the next caller the wrong reply.
        match &outcome {
            Ok(_) => self.pool.return_background(config, guard).await,
            Err(_) => self.pool.discard(config, guard).await,
        }

        outcome
    }

    async fn backfill_with_session(
        &self,
        session: &mut imap::ImapSession,
        account: &SyncAccount,
        mailbox: &str,
    ) -> Result<usize, String> {
        let cache_dir = tauri_cache_dir(&self.data_dir, account.id.as_str(), mailbox);
        let server_uids = imap::search_all_uids(session, mailbox, false).await?;
        if server_uids.is_empty() {
            return Ok(0);
        }

        let have = cached_uids(&cache_dir);
        // Newest first — the user is looking at the top of the list.
        let mut missing: Vec<u32> = server_uids.into_iter().filter(|u| !have.contains(u)).collect();
        missing.sort_unstable_by(|a, b| b.cmp(a));
        if missing.is_empty() {
            return Ok(0);
        }

        info!(
            "[backfill] {} ({}): {} headers missing from cache",
            account.email, mailbox, missing.len()
        );

        let mut written = 0usize;
        for chunk in missing.chunks(BACKFILL_CHUNK) {
            let (headers, _total) = imap::fetch_headers_by_uids(session, mailbox, chunk).await?;
            if headers.is_empty() {
                warn!("[backfill] Empty response for a {}-UID chunk — stopping", chunk.len());
                break;
            }
            write_headers(&cache_dir, &headers)?;
            self.contacts.observe_headers(account.id.as_str(), mailbox, &headers);
            written += headers.len();
            info!(
                "[backfill] {} ({}): {}/{} headers cached",
                account.email, mailbox, written, missing.len()
            );
        }

        Ok(written)
    }
}

// ── Soft daily transfer cap ─────────────────────────────────────────────────

const MB: u64 = 1024 * 1024;

/// Per-account transfer settings, read straight out of the app's persisted
/// settings blob (`<app_data_dir>/frontend-settings.json`) at
/// `["mailvault-settings"].state.transferLimits[accountId]`. The app already
/// writes that file on every settings change — no new sync mechanism needed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferLimits {
    #[serde(default)]
    cap_enabled: bool,
    #[serde(default)]
    daily_down_limit_bytes: Option<u64>,
    #[serde(default)]
    daily_up_limit_bytes: Option<u64>,
}

/// Gmail suspends accounts that pass 2500 MB down / 500 MB up in a day. No
/// other provider publishes a number, so everyone else defaults to unlimited.
fn default_limits(host: &str) -> (Option<u64>, Option<u64>) {
    let host = host.to_ascii_lowercase();
    if host.contains("gmail") || host.contains("googlemail") {
        (Some(2500 * MB), Some(500 * MB))
    } else {
        (None, None)
    }
}

/// `None` when the settings file, the map, or this account's entry is missing —
/// i.e. the cap is off, which is the default.
fn read_transfer_limits(app_dir: &Path, account_id: &str) -> Option<TransferLimits> {
    let raw = fs::read_to_string(app_dir.join("frontend-settings.json")).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let entry = settings
        .get("mailvault-settings")?
        .get("state")?
        .get("transferLimits")?
        .get(account_id)?;
    serde_json::from_value(entry.clone()).ok()
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

/// Sync metadata read back from the sidecar cache's _meta.json.
struct CachedMeta {
    uid_validity: Option<u32>,
    uid_next: Option<u32>,
    highest_modseq: Option<u64>,
    total_emails: Option<u32>,
    /// Epoch ms of the last UID SEARCH ALL reconcile. None = never (or the
    /// Tauri-side cache writer overwrote _meta.json, which drops the field).
    last_reconcile: Option<u64>,
}

/// What one delta sync changed.
struct SyncDelta {
    new_emails: usize,
    updated_flags: usize,
    total_emails: u32,
    /// A command failed mid-sync without aborting it (the reconcile SEARCH is
    /// best-effort). The session may hold unread bytes, so it must be dropped
    /// rather than pooled.
    session_dirty: bool,
}

/// A UIDNEXT jump larger than this is cheaper to resolve with a page fetch
/// than with a sparse UID range fetch.
const MAX_DELTA_UID_GAP: u32 = 500;

/// Upper bound on how long an expunge missed by the count gate can survive.
const RECONCILE_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000; // 6h

/// How far back from UIDNEXT to re-read flags on servers without CONDSTORE.
/// Covers the window a user actually looks at without scanning the whole mailbox.
const FLAG_REFRESH_WINDOW: u32 = 1000;

/// UIDs per backfill fetch. Sidecars are written after each chunk so the app's
/// cache-drain can consume them while the rest is still downloading.
const BACKFILL_CHUNK: usize = 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_tauri_cache_meta(cache_dir: &Path) -> Option<CachedMeta> {
    let json = fs::read_to_string(cache_dir.join("_meta.json")).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&json).ok()?;
    Some(CachedMeta {
        uid_validity: meta.get("uidValidity").and_then(|v| v.as_u64()).map(|v| v as u32),
        uid_next: meta.get("uidNext").and_then(|v| v.as_u64()).map(|v| v as u32),
        highest_modseq: meta.get("highestModseq").and_then(|v| v.as_u64()),
        total_emails: meta.get("totalEmails").and_then(|v| v.as_u64()).map(|v| v as u32),
        last_reconcile: meta.get("lastReconcile").and_then(|v| v.as_u64()),
    })
}

fn count_sidecars(cache_dir: &Path) -> usize {
    fs::read_dir(cache_dir).ok()
        .map(|entries| entries.flatten().filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.ends_with(".json") && name != "_meta.json"
        }).count())
        .unwrap_or(0)
}

/// UIDs that already have a sidecar on disk.
fn cached_uids(cache_dir: &Path) -> HashSet<u32> {
    let Ok(entries) = fs::read_dir(cache_dir) else { return HashSet::new() };
    entries.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".json").and_then(|u| u.parse::<u32>().ok())
        })
        .collect()
}

fn write_cache_meta(
    cache_dir: &Path,
    total_emails: u32,
    uid_validity: Option<u32>,
    uid_next: Option<u32>,
    highest_modseq: Option<u64>,
) -> Result<(), String> {
    write_cache_meta_full(cache_dir, total_emails, uid_validity, uid_next, highest_modseq, None)
}

fn write_cache_meta_full(
    cache_dir: &Path,
    total_emails: u32,
    uid_validity: Option<u32>,
    uid_next: Option<u32>,
    highest_modseq: Option<u64>,
    last_reconcile: Option<u64>,
) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    let meta = serde_json::json!({
        "totalEmails": total_emails,
        "uidValidity": uid_validity,
        "uidNext": uid_next,
        "highestModseq": highest_modseq,
        "lastReconcile": last_reconcile,
        // Epoch ms — matches what the Tauri-side save_email_cache writes.
        "lastSynced": now_ms(),
    });
    let meta_json = serde_json::to_string(&meta).map_err(|e| format!("Serialize meta: {}", e))?;
    fs::write(cache_dir.join("_meta.json"), &meta_json).map_err(|e| format!("Write meta: {}", e))
}

/// Write per-UID header sidecars, overwriting existing ones — a freshly fetched
/// header is authoritative, and on servers without CONDSTORE this is the only
/// thing that refreshes flags on already-cached messages.
fn write_headers(cache_dir: &Path, headers: &[ImapEmailHeader]) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    for header in headers {
        let email_json = serde_json::to_string(header).map_err(|e| format!("Serialize email {}: {}", header.uid, e))?;
        fs::write(cache_dir.join(format!("{}.json", header.uid)), &email_json)
            .map_err(|e| format!("Write email {}: {}", header.uid, e))?;
    }
    info!("[sync] Cache written: {} headers", headers.len());
    Ok(())
}

/// Patch the `flags` field of existing sidecars in place. Returns how many changed.
/// UIDs without a sidecar are ignored — they arrive via the new-header fetch.
fn patch_sidecar_flags(cache_dir: &Path, changes: &[(u32, Vec<String>)]) -> usize {
    let mut patched = 0;
    for (uid, flags) in changes {
        let path = cache_dir.join(format!("{}.json", uid));
        let Ok(data) = fs::read_to_string(&path) else { continue };
        let Ok(mut email) = serde_json::from_str::<serde_json::Value>(&data) else { continue };
        let new_flags = serde_json::json!(flags);
        if email.get("flags") == Some(&new_flags) { continue }
        let Some(obj) = email.as_object_mut() else { continue };
        obj.insert("flags".to_string(), new_flags);
        if let Ok(json) = serde_json::to_string(&email) {
            if fs::write(&path, json).is_ok() { patched += 1; }
        }
    }
    patched
}

/// Delete sidecars whose UID is no longer on the server. Returns how many.
fn prune_sidecars(cache_dir: &Path, server_uids: &[u32]) -> usize {
    let live: std::collections::HashSet<u32> = server_uids.iter().copied().collect();
    let Ok(entries) = fs::read_dir(cache_dir) else { return 0 };
    let mut pruned = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "_meta.json" { continue }
        let Some(uid) = name.strip_suffix(".json").and_then(|u| u.parse::<u32>().ok()) else { continue };
        if !live.contains(&uid) && fs::remove_file(entry.path()).is_ok() {
            pruned += 1;
        }
    }
    pruned
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

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv_sync_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_delta_cache_helpers() {
        let dir = scratch_dir("delta");

        // Meta round-trips, including highestModseq (the daemon used to drop it,
        // which silently disabled the app's CONDSTORE fast path).
        write_cache_meta(&dir, 42, Some(7), Some(101), Some(999)).unwrap();
        let meta = read_tauri_cache_meta(&dir).unwrap();
        assert_eq!(meta.total_emails, Some(42));
        assert_eq!(meta.uid_validity, Some(7));
        assert_eq!(meta.uid_next, Some(101));
        assert_eq!(meta.highest_modseq, Some(999));
        // Never reconciled → the timed reconcile must fire on the next delta.
        assert_eq!(meta.last_reconcile, None);

        write_cache_meta_full(&dir, 42, Some(7), Some(101), Some(999), Some(1_700_000_000_000)).unwrap();
        assert_eq!(read_tauri_cache_meta(&dir).unwrap().last_reconcile, Some(1_700_000_000_000));

        // Two sidecars, one seen and one unseen.
        fs::write(dir.join("10.json"), r#"{"uid":10,"flags":["\\Seen"],"subject":"a"}"#).unwrap();
        fs::write(dir.join("11.json"), r#"{"uid":11,"flags":[],"subject":"b"}"#).unwrap();
        assert_eq!(count_sidecars(&dir), 2);

        // Flag patch: uid 11 changes, uid 10 is already correct, uid 99 has no sidecar.
        let patched = patch_sidecar_flags(&dir, &[
            (10, vec!["\\Seen".to_string()]),
            (11, vec!["\\Seen".to_string(), "\\Flagged".to_string()]),
            (99, vec!["\\Seen".to_string()]),
        ]);
        assert_eq!(patched, 1);
        let uid11: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("11.json")).unwrap()).unwrap();
        assert_eq!(uid11["flags"], serde_json::json!(["\\Seen", "\\Flagged"]));
        assert_eq!(uid11["subject"], "b"); // patch must not clobber other fields

        // Backfill diff: the cache knows which UIDs it holds, and _meta.json is
        // never mistaken for one. A mailbox whose sidecar count trails the
        // server's EXISTS is exactly the case the delta gate cannot see.
        let have = cached_uids(&dir);
        assert_eq!(have.len(), 2);
        assert!(have.contains(&10) && have.contains(&11));
        let missing: Vec<u32> = [9u32, 10, 11, 12].into_iter().filter(|u| !have.contains(u)).collect();
        assert_eq!(missing, vec![9, 12]);

        // Prune: uid 11 was expunged server-side, _meta.json must survive.
        assert_eq!(prune_sidecars(&dir, &[10]), 1);
        assert!(dir.join("10.json").exists());
        assert!(!dir.join("11.json").exists());
        assert!(dir.join("_meta.json").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A backfill that gave up must NOT keep reporting as in-flight: the app
    /// pauses its own pagination while `backfilling` is true, so a stuck key
    /// leaves the mailbox spinning forever with nothing fetching it.
    #[tokio::test]
    async fn test_gave_up_backfill_does_not_report_as_in_flight() {
        let dir = scratch_dir("backfill_flag");
        let engine = SyncEngine::new(
            Arc::new(imap::ImapPool::new()),
            dir.clone(),
            dir.clone(),
            ContactsState::new(dir.clone()),
        );
        let key = format!("acc1\u{1}INBOX");

        assert!(!engine.is_backfilling("acc1").await);

        engine.backfill_gave_up.lock().await.insert(key.clone());
        assert!(!engine.is_backfilling("acc1").await, "gave-up key must not read as in-flight");

        engine.backfilling.lock().await.insert(key);
        assert!(engine.is_backfilling("acc1").await, "in-flight key must read as in-flight");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// The cap must read both the settings blob the app writes and the stat
    /// files, and must stay out of the way until it is switched on and spent.
    #[tokio::test]
    async fn transfer_cap_skips_the_account_only_once_the_limit_is_spent() {
        let dir = scratch_dir("transfer_cap");
        let engine = engine_for(&dir);
        let account: SyncAccount = serde_json::from_value(serde_json::json!({
            "id": "acc1",
            "email": "user@example.com",
            "imapConfig": { "email": "user@example.com", "imapHost": "imap.example.com" }
        }))
        .unwrap();

        // No settings file at all → cap off.
        assert!(engine.transfer_cap_reached(&account).await.is_none());

        // 200 MB down already spent today, per the daemon's own stat file.
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        fs::create_dir_all(dir.join("transfer_stats")).unwrap();
        fs::write(
            dir.join("transfer_stats").join("acc1.daemon.json"),
            format!(r#"{{"days":{{"{}":{{"down":209715200,"up":0}}}}}}"#, today),
        )
        .unwrap();

        let settings = |cap_enabled: bool, limit_mb: u64| {
            serde_json::json!({
                "mailvault-settings": { "state": { "transferLimits": { "acc1": {
                    "capEnabled": cap_enabled,
                    "dailyDownLimitBytes": limit_mb * MB,
                }}}}
            })
            .to_string()
        };

        fs::write(dir.join("frontend-settings.json"), settings(false, 100)).unwrap();
        assert!(
            engine.transfer_cap_reached(&account).await.is_none(),
            "usage over the limit must not matter while the cap is disabled"
        );

        fs::write(dir.join("frontend-settings.json"), settings(true, 500)).unwrap();
        assert!(
            engine.transfer_cap_reached(&account).await.is_none(),
            "200 MB used is under a 500 MB cap"
        );

        fs::write(dir.join("frontend-settings.json"), settings(true, 100)).unwrap();
        assert!(engine.transfer_cap_reached(&account).await.is_some());

        // The gate must actually stop the sync — no IMAP server is running here,
        // so the error proves it returned before connecting.
        let result = engine.sync_account(&account, "INBOX").await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("Daily transfer cap reached"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gmail_gets_a_default_daily_limit_and_nobody_else_does() {
        assert_eq!(default_limits("imap.gmail.com"), (Some(2500 * MB), Some(500 * MB)));
        assert_eq!(default_limits("imap.hostinger.com"), (None, None));
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

    // ── End-to-end sync against a mock IMAP server ──────────────────────────
    //
    // These drive the real sync engine against a scriptable server and assert on
    // what lands on disk. The failures they cover are the ones users actually
    // saw: a poisoned session pruning 505 cached headers, and a cold mailbox
    // re-paging from zero on every launch.

    use mock_imap::state::{synthetic_mailbox, Mailbox};
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    fn engine_for(dir: &Path) -> SyncEngine {
        SyncEngine::new(
            Arc::new(imap::ImapPool::new()),
            dir.to_path_buf(),
            dir.to_path_buf(),
            ContactsState::new(dir.to_path_buf()),
        )
    }

    fn account_for(server: &MockImap) -> SyncAccount {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(serde_json::json!({
            "id": "acc1",
            "email": "user@example.com",
            "imapConfig": {
                "email": "user@example.com",
                "password": "hunter2",
                "imapHost": server.host(),
                "imapPort": server.port(),
            }
        }))
        .expect("build SyncAccount")
    }

    fn cache_dir_for(dir: &Path) -> PathBuf {
        tauri_cache_dir(dir, "acc1", "INBOX")
    }

    #[tokio::test]
    async fn cold_cache_writes_sidecars_and_meta() {
        let dir = scratch_dir("cold_cache");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 30)));
        let engine = engine_for(&dir);

        let result = engine.sync_account(&account_for(&server), "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);
        assert_eq!(result.new_emails, 30);

        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 30);
        let meta = read_tauri_cache_meta(&cache).expect("meta written");
        assert_eq!(meta.total_emails, Some(30));
        assert_eq!(meta.uid_next, Some(31));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A warm cache must fetch only the arrivals — not re-page the mailbox.
    /// Re-paging on every launch is what made restarts slow.
    #[tokio::test]
    async fn warm_cache_fetches_only_new_uids() {
        let dir = scratch_dir("warm_cache");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 20)));
        let account = account_for(&server);
        let engine = engine_for(&dir);

        engine.sync_account(&account, "INBOX").await;

        let before = server.commands().len();
        let result = engine.sync_account(&account, "INBOX").await;
        assert!(result.success, "second sync failed: {:?}", result.error);

        let second_pass: Vec<String> = server.commands().into_iter().skip(before).collect();
        let joined = second_pass.join("\n").to_uppercase();
        // A cheap `UID FETCH 1:* (UID)` reconcile is fine — it is UID-only. What
        // must not happen is re-downloading headers for the whole mailbox.
        assert!(
            !joined.contains("ENVELOPE"),
            "a warm cache must not re-fetch headers it already has:\n{joined}"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// THE regression. Purelymail splices `* OK Still here` into a long untagged
    /// line; the reconcile's UID listing fails; the session holds unread bytes.
    /// Before the fix, that pruned 505 cached headers off disk. The sync may
    /// report the failure — it must never delete cached mail because of it.
    #[tokio::test]
    async fn a_poisoned_reconcile_never_prunes_the_cache() {
        let dir = scratch_dir("poisoned_reconcile");
        let account_server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 40)));
        let engine = engine_for(&dir);
        engine.sync_account(&account_for(&account_server), "INBOX").await;

        let cache = cache_dir_for(&dir);
        let before = count_sidecars(&cache);
        assert_eq!(before, 40, "precondition: a warm cache to lose");
        drop(account_server);

        // Same mailbox, SAME SIZE, with the keepalive splice armed on FETCH.
        //
        // Size matters: a larger mailbox would make the delta path fetch the new
        // arrival's headers first, and that FETCH is poisoned too — whether it
        // survives depends on where the splice lands in a one-message response,
        // which made this test pass locally and fail on CI. Equal size means the
        // only FETCH issued is the reconcile's `UID FETCH 1:*`, which is the
        // command under test. The reconcile still fires because a cold sync
        // leaves `lastReconcile` unset, so the timed reconcile is due.
        let poisoned = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 40))
                .fault(
                    Trigger::on("FETCH"),
                    Action::InjectMidLine("* OK Still here\r\n".into()),
                ),
        );
        let _ = engine.sync_account(&account_for(&poisoned), "INBOX").await;

        assert_eq!(
            poisoned.count_commands("UID FETCH"),
            1,
            "the reconcile's `UID FETCH 1:*` must be the ONLY fetch this sync issues — \
             if a header fetch creeps in, it eats the injected fault and this test \
             silently stops testing anything: {:?}",
            poisoned.commands()
        );
        assert_eq!(
            count_sidecars(&cache),
            before,
            "a failed UID listing must not delete cached headers"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// The quieter version of the same bug: the listing parses fine but is
    /// short. Pruning against it deletes real mail. EXISTS is the guard.
    #[tokio::test]
    async fn a_truncated_uid_listing_never_prunes_the_cache() {
        let dir = scratch_dir("truncated_listing");
        let warm = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 40)));
        let engine = engine_for(&dir);
        engine.sync_account(&account_for(&warm), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 40);
        drop(warm);

        // Server returns a quarter of the UIDs but still reports EXISTS=40.
        // Equal size for the same reason as the poisoned-reconcile test above:
        // the reconcile must be the only FETCH, or the assertion is timing-dependent.
        let truncating = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 40))
                .fault(Trigger::on("FETCH"), Action::PartialSearchResult(0.25)),
        );
        let _ = engine.sync_account(&account_for(&truncating), "INBOX").await;

        assert_eq!(
            truncating.count_commands("UID FETCH"),
            1,
            "the reconcile's `UID FETCH 1:*` must be the ONLY fetch this sync issues: {:?}",
            truncating.commands()
        );
        assert_eq!(
            count_sidecars(&cache),
            40,
            "a partial UID list must not be mistaken for server-side deletions"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Positive control: real server-side deletions DO get pruned. Without this,
    /// the two tests above could pass by never pruning at all.
    #[tokio::test]
    async fn genuine_server_side_deletions_are_pruned() {
        let dir = scratch_dir("real_prune");
        let warm = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 20)));
        let engine = engine_for(&dir);
        engine.sync_account(&account_for(&warm), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 20);
        drop(warm);

        // Three messages really are gone — EXISTS agrees with the UID list.
        let mut smaller = synthetic_mailbox("INBOX", 20);
        smaller.messages.retain(|m| ![5u32, 6, 7].contains(&m.uid));
        let shrunk = MockImap::start(Scenario::new().mailbox(smaller));
        let result = engine.sync_account(&account_for(&shrunk), "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);

        assert_eq!(count_sidecars(&cache), 17, "expunged messages should be pruned");
        assert!(!cache.join("6.json").exists());
        assert!(cache.join("8.json").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A UIDVALIDITY change re-issues the whole UID space: every cached UID now
    /// points at a different message. The old generation has to go.
    #[tokio::test]
    async fn uidvalidity_change_clears_the_stale_generation() {
        let dir = scratch_dir("uidvalidity");
        let first = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 15)));
        let engine = engine_for(&dir);
        engine.sync_account(&account_for(&first), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 15);
        drop(first);

        let reissued = MockImap::start(
            Scenario::new().mailbox(synthetic_mailbox("INBOX", 4).with_uid_validity(99)),
        );
        let result = engine.sync_account(&account_for(&reissued), "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);

        assert_eq!(
            count_sidecars(&cache),
            4,
            "stale UID generation must be dropped, not merged"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A mailbox whose cache holds only part of the mailbox is invisible to the
    /// delta gate (UIDNEXT matches, so "nothing new"). Backfill is what fills
    /// the hole — and it must fetch only the missing UIDs.
    #[tokio::test]
    async fn backfill_fetches_only_the_uids_the_cache_is_missing() {
        let dir = scratch_dir("backfill_partial");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 50)));
        let account = account_for(&server);
        let engine = engine_for(&dir);
        let cache = cache_dir_for(&dir);

        // A cache holding 10 of 50 — the partly-cached state after an aborted load.
        fs::create_dir_all(&cache).unwrap();
        for uid in 41..=50u32 {
            fs::write(
                cache.join(format!("{uid}.json")),
                format!(r#"{{"uid":{uid},"flags":[],"subject":"Message {uid}"}}"#),
            )
            .unwrap();
        }
        write_cache_meta(&cache, 50, Some(1), Some(51), None).unwrap();

        engine.backfill_mailbox(&account, "INBOX").await;

        assert_eq!(count_sidecars(&cache), 50, "backfill should complete the mailbox");
        assert!(!engine.is_backfilling("acc1").await, "in-flight flag must clear");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A failed backfill must clear its in-flight flag. The app pauses its own
    /// pagination while `backfilling` is set — a stuck flag left the mailbox
    /// polling once a second forever with nothing downloading.
    #[tokio::test]
    async fn a_failed_backfill_clears_the_in_flight_flag() {
        let dir = scratch_dir("backfill_failed");
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 30))
                .fault(Trigger::on("FETCH"), Action::DropConnection),
        );
        let engine = engine_for(&dir);

        engine.backfill_mailbox(&account_for(&server), "INBOX").await;

        assert!(
            !engine.is_backfilling("acc1").await,
            "a failed backfill that keeps reporting in-flight strands the mailbox"
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}
