//! Sync Engine — background email synchronization.
//!
//! Owns all IMAP connections and writes to local Maildir + cache.
//! The app never calls IMAP directly — it reads from local storage
//! and listens for sync events.

use crate::contacts_index::ContactsState;
use crate::netgate::NetGate;
use crate::imap::{self, ImapConfig, EmailHeader as ImapEmailHeader};
use crate::imap::pool::{retry_once_on_dead_socket, ImapPool, PooledSessionGuard};
use mailvault_core::transfer_stats;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

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
    /// The daemon never dialled: its connectivity gate is shut. Distinct from
    /// `success:false`, which the app renders as a *server* error — the wrong
    /// story, and the wrong remedy, when the Wi-Fi is simply off.
    pub offline: bool,
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
    /// One watch channel per issued sync ticket, resolved when that sync — and
    /// only that sync — finishes. Keyed by ticket rather than by account
    /// because INBOX and Sent sync concurrently and would otherwise answer
    /// each other's waits. `std::sync::Mutex` so `begin` is callable from the
    /// RPC handler before it spawns, which is what closes the
    /// wait-arrives-before-the-task-starts race.
    tickets: std::sync::Mutex<HashMap<u64, tokio::sync::watch::Sender<Option<SyncResult>>>>,
    next_ticket: std::sync::atomic::AtomicU64,
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
    /// Shut while the host has no connectivity — every sync short-circuits
    /// rather than dialling nine accounts into a dead socket.
    net: Arc<NetGate>,
    /// `account_id\x01requested` → the path this server actually serves.
    /// Filled the first time a SELECT comes back "no such mailbox", so the
    /// LIST that resolves it costs one round trip per process, not per tick.
    mailbox_aliases: Mutex<HashMap<String, String>>,
}

impl SyncEngine {
    pub fn new(
        pool: Arc<ImapPool>,
        data_dir: PathBuf,
        app_dir: PathBuf,
        contacts: Arc<ContactsState>,
        net: Arc<NetGate>,
    ) -> Self {
        Self {
            pool,
            data_dir,
            app_dir,
            states: Mutex::new(HashMap::new()),
            tickets: std::sync::Mutex::new(HashMap::new()),
            next_ticket: std::sync::atomic::AtomicU64::new(1),
            contacts,
            backfilling: Mutex::new(HashSet::new()),
            backfill_gave_up: Mutex::new(HashSet::new()),
            net,
            cap_logged: Mutex::new(HashMap::new()),
            mailbox_aliases: Mutex::new(HashMap::new()),
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

    /// Issue a ticket for a sync that is about to start.
    ///
    /// Sync callable on purpose: the RPC handler takes the ticket *before* it
    /// spawns the task, so a `sync.wait` that arrives first still has
    /// something to subscribe to.
    pub fn begin(&self, account_id: &str, mailbox: &str) -> u64 {
        let ticket = self.next_ticket.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, _rx) = tokio::sync::watch::channel(None);
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        tickets.insert(ticket, tx);
        // ponytail: 64 finished tickets kept for late waiters; a ring buffer if
        // the linear scan ever shows up in a profile.
        while tickets.len() > MAX_LIVE_TICKETS {
            let oldest = *tickets.keys().min().expect("non-empty");
            tickets.remove(&oldest);
        }
        info!("[sync] ticket {} issued for {} ({})", ticket, account_id, mailbox);
        ticket
    }

    /// Run a sync and resolve its ticket with the result.
    pub async fn run_ticket(&self, ticket: u64, account: &SyncAccount, mailbox: &str) -> SyncResult {
        let result = self.sync_account(account, mailbox).await;
        if let Some(tx) = self.tickets.lock().unwrap_or_else(|e| e.into_inner()).get(&ticket) {
            // `send` drops the value when nobody is subscribed yet — which is
            // the normal case, since the waiter usually arrives afterwards.
            tx.send_replace(Some(result.clone()));
        }
        result
    }

    /// Wait for the sync a ticket was issued for, with timeout.
    pub async fn wait_for_ticket(&self, ticket: u64, timeout_ms: u64) -> Result<SyncResult, String> {
        let mut rx = match self.tickets.lock().unwrap_or_else(|e| e.into_inner()).get(&ticket) {
            Some(tx) => tx.subscribe(),
            None => return Err(format!("Unknown sync ticket {}", ticket)),
        };
        // Already finished — a sync can complete between sync.now and sync.wait.
        if let Some(result) = rx.borrow().clone() {
            return Ok(result);
        }
        let timeout = tokio::time::Duration::from_millis(timeout_ms);
        match tokio::time::timeout(timeout, rx.changed()).await {
            Ok(Ok(())) => rx.borrow().clone().ok_or_else(|| "Sync watcher closed".to_string()),
            Ok(Err(_)) => Err("Sync watcher closed".to_string()),
            Err(_) => Err("Sync timed out".to_string()),
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

        // No connectivity: return without touching the network. This is the
        // whole point of the gate — nine accounts times one sync tick is nine
        // 15s TCP timeouts and nine log lines, repeated every tick, for a
        // machine whose Wi-Fi is simply off.
        if !self.net.is_online() {
            return SyncResult {
                account_id: account_id.clone(),
                mailbox: mailbox.to_string(),
                new_emails: 0, updated_flags: 0, total_emails: 0,
                success: false,
                error: Some("No internet connection".to_string()),
                offline: true,
            };
        }

        // Soft daily cap: skip the account entirely rather than spend the
        // remaining allowance. Resets on its own at the next UTC day.
        if let Some(reason) = self.transfer_cap_reached(account).await {
            // Record it too, or `sync.status` reports whatever the last real
            // sync left behind and the cap is invisible to the app.
            self.states.lock().await.insert(account_id.clone(), SyncState {
                account_id: account_id.clone(),
                status: SyncStatus::Error,
                last_sync: Some(unix_now()),
                last_error: Some(reason.clone()),
                new_emails: 0,
                total_emails: 0,
            });
            return SyncResult {
                account_id: account_id.clone(),
                mailbox: mailbox.to_string(),
                new_emails: 0, updated_flags: 0, total_emails: 0,
                success: false, error: Some(reason), offline: false,
            };
        }

        // Update state to syncing. Carry the last result forward — `sync.status`
        // is what the app shows *while* the sync runs, and blanking it flashed
        // "never synced, 0 messages" for the whole duration.
        {
            let mut states = self.states.lock().await;
            let previous = states.get(account_id);
            let (last_sync, new_emails, total_emails) = previous
                .map(|s| (s.last_sync, s.new_emails, s.total_emails))
                .unwrap_or((None, 0, 0));
            states.insert(account_id.clone(), SyncState {
                account_id: account_id.clone(),
                status: SyncStatus::Syncing,
                last_sync,
                last_error: None,
                new_emails,
                total_emails,
            });
        }

        info!("[sync] Starting sync for {} ({})", account.email, mailbox);

        let mut result = self.do_sync(account, mailbox).await;

        // Teach the gate what just happened. A success is proof of reach; a
        // connect-shaped failure only *asks* — `note_failure` probes and the
        // probe decides, so one provider's outage never gates the other eight.
        if result.success {
            self.net.note_success();
        } else if let Some(err) = result.error.clone() {
            result.offline = !self.net.note_failure(&err).await;
        }

        // Update state
        {
            let mut states = self.states.lock().await;
            states.insert(account_id.clone(), SyncState {
                account_id: account_id.clone(),
                status: if result.success { SyncStatus::Idle } else { SyncStatus::Error },
                last_sync: Some(unix_now()),
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

        result
    }

    /// The path this account actually serves for `requested`, as far as we know.
    async fn alias_for(&self, account_id: &str, requested: &str) -> String {
        self.mailbox_aliases
            .lock()
            .await
            .get(&format!("{}\x01{}", account_id, requested))
            .cloned()
            .unwrap_or_else(|| requested.to_string())
    }

    /// Ask the server for its folder list and map `requested` onto a real path.
    /// `None` when nothing matches — the caller keeps the server's own error.
    async fn resolve_mailbox(
        &self,
        session: &mut imap::ImapSession,
        account_id: &str,
        requested: &str,
    ) -> Option<String> {
        let mailboxes = match imap::list_mailboxes(session).await {
            Ok(m) => m,
            Err(e) => {
                warn!("[sync] LIST failed while resolving '{}': {}", requested, e);
                return None;
            }
        };
        let actual = imap::resolve_mailbox_path(requested, &mailboxes)?;
        if actual == requested {
            return None; // same SELECT, same answer — don't loop
        }
        self.mailbox_aliases
            .lock()
            .await
            .insert(format!("{}\x01{}", account_id, requested), actual.clone());
        Some(actual)
    }

    /// Internal sync implementation: one attempt on a pooled session, once
    /// more on a brand-new connection if that attempt died with the socket.
    ///
    /// The hole `ImapPool::run_read` closes for the app's reads, on the path
    /// that carries the traffic: a pooled socket the peer closed while it sat
    /// idle answers its first command with `Broken pipe`, and the tick handed
    /// that to the user as the server refusing — fifteen times in one
    /// morning's log. Everything here is a read (SELECT / FETCH / SEARCH; the
    /// writes go to the local cache), so repeating it is free.
    async fn do_sync(
        &self,
        account: &SyncAccount,
        mailbox: &str,
    ) -> SyncResult {
        let account_id = account.id.clone();
        match retry_once_on_dead_socket(|fresh| self.sync_on(account, mailbox, fresh)).await {
            Ok((delta, mailbox)) => SyncResult {
                account_id,
                mailbox,
                new_emails: delta.new_emails,
                updated_flags: delta.updated_flags,
                total_emails: delta.total_emails,
                success: true,
                error: None,
                offline: false,
            },
            Err(e) => SyncResult {
                account_id,
                mailbox: mailbox.to_string(),
                new_emails: 0, updated_flags: 0, total_emails: 0,
                success: false, error: Some(e), offline: false,
            },
        }
    }

    /// One attempt: check out (`fresh`: never from the pool), sync, hand the
    /// session back. Returns the delta and the folder actually synced.
    async fn sync_on(
        &self,
        account: &SyncAccount,
        mailbox: &str,
        fresh: bool,
    ) -> Result<(SyncDelta, String), String> {
        let account_id = &account.id;
        let config = &account.imap_config;

        let guard = if fresh {
            self.pool.get_background_fresh(config).await?
        } else {
            self.pool.get_background(config).await?
        };
        let PooledSessionGuard { mut session, last_selected: _, _permit } = guard;
        let has_condstore = self.pool.has_capability(config, "CONDSTORE").await;

        // Callers name folders generically ("Sent"); providers serve their own
        // paths ("[Google Mail]/Sent Mail"). Use a name already resolved for
        // this account, and resolve a fresh one the first time the server says
        // the folder is not there.
        let requested = mailbox;
        let mut mailbox = self.alias_for(account_id, requested).await;
        let mut outcome = self.sync_mailbox(&mut session, account, &mailbox, has_condstore).await;

        if matches!(&outcome, Err(e) if imap::is_missing_mailbox(e)) {
            if mailbox != requested {
                // The alias points at a folder this server no longer serves.
                // Forget it, or every later sync SELECTs the dead path and the
                // name the caller asked for is never tried again — not even
                // after the user creates a real folder by that name.
                self.mailbox_aliases
                    .lock()
                    .await
                    .remove(&format!("{}\x01{}", account_id, requested));
                mailbox = requested.to_string();
                // The name the caller asked for may exist by now. Try it before
                // asking the server to resolve it: `resolve_mailbox` answers
                // None for an exact match, so this is the only path that finds
                // a plain folder by the requested name in the same tick.
                outcome = self.sync_mailbox(&mut session, account, requested, has_condstore).await;
            }
        }
        if matches!(&outcome, Err(e) if imap::is_missing_mailbox(e)) {
            if let Some(actual) = self.resolve_mailbox(&mut session, account_id, requested).await {
                info!(
                    "[sync] {} has no '{}' — syncing '{}' instead",
                    account.email, requested, actual
                );
                outcome = self.sync_mailbox(&mut session, account, &actual, has_condstore).await;
                mailbox = actual;
            }
        }
        let guard = PooledSessionGuard {
            session,
            last_selected: Some(mailbox.clone()),
            _permit,
        };
        // Hand the session back on success; on error discard it — a failed
        // command can leave unread bytes that desync every later command on it.
        // Either way the permit is released (a failed sync used to leak a slot).
        match &outcome {
            Ok(d) if !d.session_dirty => self.pool.return_background(config, guard).await,
            _ => self.pool.discard(config, guard).await,
        }

        outcome.map(|delta| (delta, mailbox))
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
        // Offline: return *without* marking the key as gave-up. A backfill that
        // never dialled has not been proven unfetchable, and gave-up keys last
        // the life of the process — one dropped Wi-Fi would strand the mailbox
        // until the next restart.
        if !self.net.is_online() {
            return;
        }
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
        retry_once_on_dead_socket(|fresh| self.backfill_on(account, mailbox, fresh)).await
    }

    async fn backfill_on(&self, account: &SyncAccount, mailbox: &str, fresh: bool) -> Result<usize, String> {
        let config = &account.imap_config;
        let guard = if fresh {
            self.pool.get_background_fresh(config).await?
        } else {
            self.pool.get_background(config).await?
        };
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

fn unix_now() -> u64 {
    now_ms() / 1000
}

/// Finished tickets kept around so a late `sync.wait` still finds its result.
const MAX_LIVE_TICKETS: usize = 64;

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
    mailvault_core::fsx::write_atomic(&cache_dir.join("_meta.json"), meta_json.as_bytes())
        .map_err(|e| format!("Write meta: {}", e))
}

/// Write per-UID header sidecars, overwriting existing ones — a freshly fetched
/// header is authoritative, and on servers without CONDSTORE this is the only
/// thing that refreshes flags on already-cached messages.
fn write_headers(cache_dir: &Path, headers: &[ImapEmailHeader]) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    for header in headers {
        let email_json = serde_json::to_string(header).map_err(|e| format!("Serialize email {}: {}", header.uid, e))?;
        mailvault_core::fsx::write_atomic(&cache_dir.join(format!("{}.json", header.uid)), email_json.as_bytes())
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
            offline: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"new_emails\":5"));
        assert!(json.contains("\"success\":true"));
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv_sync_test_{}_{}", name, uuid::Uuid::new_v4()));
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
        let engine = engine_for(&dir);
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
    use std::time::Duration;

    /// Mock connectivity object: a gate whose probe answers what the test says.
    fn gate(online: bool) -> Arc<NetGate> {
        NetGate::with_probe(Arc::new(move || Box::pin(async move { online })))
    }

    fn engine_for(dir: &Path) -> SyncEngine {
        engine_with_net(dir, gate(true))
    }

    fn engine_with_net(dir: &Path, net: Arc<NetGate>) -> SyncEngine {
        SyncEngine::new(
            Arc::new(imap::ImapPool::new()),
            dir.to_path_buf(),
            dir.to_path_buf(),
            ContactsState::new(dir.to_path_buf()),
            net,
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

    // ── Connectivity gate ───────────────────────────────────────────────
    // A shut gate must stop the traffic, label the result so the app can say
    // "no internet" instead of "the server refused", and reopen on its own.

    #[tokio::test]
    async fn a_shut_gate_stops_the_sync_before_it_dials() {
        let dir = scratch_dir("net_gate_shut");
        // The server is up and reachable: if the gate leaked, this sync would
        // SUCCEED. Success is the failure mode here.
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        let engine = engine_with_net(&dir, gate(false));
        engine.net.note_failure("Network is unreachable").await;

        let result = engine.sync_account(&account_for(&server), "INBOX").await;

        assert!(!result.success);
        assert!(result.offline, "must be labelled offline, not a server error");
        assert_eq!(result.error.as_deref(), Some("No internet connection"));
        assert_eq!(count_sidecars(&cache_dir_for(&dir)), 0, "nothing was fetched");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// The control for the test above: same server, same code, open gate.
    #[tokio::test]
    async fn an_open_gate_syncs_the_same_mailbox_normally() {
        let dir = scratch_dir("net_gate_open");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        let engine = engine_with_net(&dir, gate(true));

        let result = engine.sync_account(&account_for(&server), "INBOX").await;

        assert!(result.success, "sync failed: {:?}", result.error);
        assert!(!result.offline);
        assert_eq!(count_sidecars(&cache_dir_for(&dir)), 3);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A sync that reaches the server is proof of connectivity — the gate must
    /// take it, so a user who reconnects does not wait out the backoff.
    #[tokio::test]
    async fn a_successful_sync_reopens_a_gate_that_had_shut() {
        let dir = scratch_dir("net_gate_reopen");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        // Probe still says down, so only `note_success` can reopen this.
        let net = gate(false);
        let engine = engine_with_net(&dir, Arc::clone(&net));
        net.note_failure("No route to host").await;
        assert!(!net.is_online());

        // Simulate the app's own reconnect nudge, then sync.
        net.note_success();
        let result = engine.sync_account(&account_for(&server), "INBOX").await;

        assert!(result.success, "sync failed: {:?}", result.error);
        assert!(net.is_online());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A server that answers "no such mailbox" is not a connectivity failure.
    /// Gating on it would strand an online user on one bad folder name.
    #[tokio::test]
    async fn a_server_error_leaves_the_gate_open() {
        let dir = scratch_dir("net_gate_server_error");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let net = gate(false); // probe would say down if anyone asked it
        let engine = engine_with_net(&dir, Arc::clone(&net));

        let result = engine.sync_account(&account_for(&server), "NoSuchFolder").await;

        assert!(!result.success);
        assert!(!result.offline, "a tagged NO is the server answering, not the network");
        assert!(net.is_online(), "the gate must not shut on a server refusal");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A dropped Wi-Fi must not cost the mailbox its backfill for the life of
    /// the process — `backfill_gave_up` is never cleared.
    #[tokio::test]
    async fn an_offline_backfill_is_not_recorded_as_given_up() {
        let dir = scratch_dir("net_gate_backfill");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        let net = gate(false);
        let engine = engine_with_net(&dir, Arc::clone(&net));
        net.note_failure("Network is down").await;

        engine.backfill_mailbox(&account_for(&server), "INBOX").await;

        assert!(
            engine.backfill_gave_up.lock().await.is_empty(),
            "a backfill that never dialled has not been proven unfetchable"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    // ── Folder-name resolution ──────────────────────────────────────────
    // Callers name folders generically ("Sent"). Gmail serves
    // "[Google Mail]/Sent Mail" and answers [NONEXISTENT] for anything else,
    // which used to fail every Sent sync forever.

    #[tokio::test]
    async fn a_generic_folder_name_syncs_the_folder_the_server_serves() {
        let dir = scratch_dir("sent_alias");
        let mut sent = synthetic_mailbox("[Google Mail]/Sent Mail", 4);
        sent.attrs.push("\\Sent".to_string());
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                .mailbox(sent),
        );
        let engine = engine_for(&dir);

        let result = engine.sync_account(&account_for(&server), "Sent").await;

        assert!(result.success, "sync failed: {:?}", result.error);
        assert_eq!(result.mailbox, "[Google Mail]/Sent Mail");
        assert_eq!(result.new_emails, 4);
        assert_eq!(
            count_sidecars(&tauri_cache_dir(&dir, "acc1", "[Google Mail]/Sent Mail")),
            4
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_folder_the_server_really_has_is_never_rerouted() {
        let dir = scratch_dir("no_reroute");
        let mut sent = synthetic_mailbox("[Google Mail]/Sent Mail", 4);
        sent.attrs.push("\\Sent".to_string());
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                .mailbox(synthetic_mailbox("Sent", 1))
                .mailbox(sent),
        );
        let engine = engine_for(&dir);

        let result = engine.sync_account(&account_for(&server), "Sent").await;

        assert!(result.success, "sync failed: {:?}", result.error);
        assert_eq!(result.mailbox, "Sent");
        assert_eq!(result.new_emails, 1);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_folder_with_no_counterpart_keeps_the_servers_own_error() {
        let dir = scratch_dir("no_counterpart");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let engine = engine_for(&dir);

        let result = engine.sync_account(&account_for(&server), "Projects").await;

        assert!(!result.success);
        let err = result.error.unwrap_or_default();
        assert!(err.contains("NONEXISTENT"), "unexpected error: {}", err);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// An alias survives for the life of the process. If the folder it points
    /// at goes away, every later sync of the requested name SELECTs the dead
    /// path — so a folder the user later creates by that very name is never
    /// tried again. A failed alias has to forget itself.
    #[tokio::test]
    async fn an_alias_that_stops_working_is_forgotten() {
        let dir = scratch_dir("alias_selfclear");
        let engine = engine_for(&dir);
        let alias_key = "acc1\u{1}Sent".to_string();

        let mut gmail_sent = synthetic_mailbox("[Google Mail]/Sent Mail", 4);
        gmail_sent.attrs.push("\\Sent".to_string());
        let first = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                .mailbox(gmail_sent),
        );
        let result = engine.sync_account(&account_for(&first), "Sent").await;
        assert!(result.success, "sync failed: {:?}", result.error);
        assert_eq!(result.mailbox, "[Google Mail]/Sent Mail");
        assert!(
            engine.mailbox_aliases.lock().await.contains_key(&alias_key),
            "precondition: the alias is remembered"
        );
        drop(first);

        // Same account, and now the folder the alias points at is gone.
        let second = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let result = engine.sync_account(&account_for(&second), "Sent").await;
        assert!(!result.success, "there is no Sent folder to sync");
        assert!(
            !engine.mailbox_aliases.lock().await.contains_key(&alias_key),
            "an alias that no longer resolves must be dropped, not kept forever"
        );
        drop(second);

        // The user makes a plain "Sent" — no \Sent attribute, so only the
        // requested name itself can find it.
        let third = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                .mailbox(synthetic_mailbox("Sent", 2)),
        );
        let result = engine.sync_account(&account_for(&third), "Sent").await;
        assert!(result.success, "sync failed: {:?}", result.error);
        assert_eq!(result.mailbox, "Sent");
        assert_eq!(result.new_emails, 2);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// The alias target vanished AND a real folder by the requested name now
    /// exists, both in the same server generation. Forgetting the alias is not
    /// enough: `resolve_mailbox` answers None for an exact match of the
    /// requested name (its "same SELECT, same answer" guard), so without a
    /// retry of the requested name this tick fails and only the next one heals.
    #[tokio::test]
    async fn a_dead_alias_with_a_real_folder_by_the_requested_name_syncs_in_one_tick() {
        let dir = scratch_dir("alias_one_tick");
        let engine = engine_for(&dir);

        let mut gmail_sent = synthetic_mailbox("[Google Mail]/Sent Mail", 4);
        gmail_sent.attrs.push("\\Sent".to_string());
        let first = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                .mailbox(gmail_sent),
        );
        let result = engine.sync_account(&account_for(&first), "Sent").await;
        assert_eq!(result.mailbox, "[Google Mail]/Sent Mail", "precondition: aliased");
        drop(first);

        // Provider folder gone, plain "Sent" (no \Sent attribute) in its place.
        let second = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                .mailbox(synthetic_mailbox("Sent", 3)),
        );
        let result = engine.sync_account(&account_for(&second), "Sent").await;
        assert!(result.success, "the requested name must be tried in the same tick: {:?}", result.error);
        assert_eq!(result.mailbox, "Sent");
        assert_eq!(result.new_emails, 3);

        fs::remove_dir_all(&dir).unwrap();
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

    // ── Dead pooled socket ──────────────────────────────────────────────
    //
    // A pooled session the peer closed while it sat idle answers its first
    // command with `Broken pipe`, and the tick used to hand that to the user
    // as the server refusing — fifteen times in one morning's daemon log. The
    // app's reads already ask again on a new connection (`ImapPool::run_read`);
    // the sync, which carries the traffic, must too.

    /// How many SELECTs one cold sync issues — measured, not hardcoded, so the
    /// fault below lands on the *pooled* session's first command whatever the
    /// sync does on the way there.
    async fn selects_per_cold_sync() -> usize {
        let dir = scratch_dir("select_count_probe");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 5)));
        let result = engine_for(&dir).sync_account(&account_for(&server), "INBOX").await;
        assert!(result.success, "probe sync failed: {:?}", result.error);
        fs::remove_dir_all(&dir).unwrap();
        server.count_commands("SELECT")
    }

    #[tokio::test]
    async fn a_sync_whose_pooled_socket_died_retries_once_on_a_new_connection() {
        let dir = scratch_dir("dead_socket_retry");
        let cold = selects_per_cold_sync().await;
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 5))
                // The first command the second sync sends on the pooled session.
                .fault(Trigger::nth("SELECT", cold + 1), Action::DropConnection),
        );
        let account = account_for(&server);
        let engine = engine_for(&dir);

        let first = engine.sync_account(&account, "INBOX").await;
        assert!(first.success, "precondition: a healthy session in the pool: {:?}", first.error);
        assert_eq!(server.connection_count(), 1);

        let second = engine.sync_account(&account, "INBOX").await;

        assert!(
            second.success,
            "the retry must finish the sync the dead socket failed: {:?}",
            second.error
        );
        assert_eq!(
            server.connection_count(),
            2,
            "the retry must open a NEW connection, not reuse the dead one"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Negative control: with every SELECT dying the retry cannot succeed, so
    /// the green above is the retry working, not the fault failing to fire.
    /// And it happens once — two connections, not a loop.
    #[tokio::test]
    async fn a_sync_that_keeps_losing_the_socket_fails_after_exactly_one_retry() {
        let dir = scratch_dir("dead_socket_control");
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 5))
                .fault(Trigger::on("SELECT"), Action::DropConnection),
        );
        let engine = engine_for(&dir);

        let result = engine.sync_account(&account_for(&server), "INBOX").await;

        assert!(!result.success);
        let err = result.error.unwrap_or_default();
        assert!(
            imap::pool::is_connection_lost(&err),
            "the error that drives the retry must be recognisable as one: {err}"
        );
        assert_eq!(server.connection_count(), 2, "one attempt, one retry, no loop");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// THE regression behind the report. A socket the peer closed cleanly
    /// (FIN, not RST) answers SELECT with EOF, and async-imap parses EOF as an
    /// EMPTY mailbox — EXISTS 0, no error. The reconcile then agreed with it
    /// (0 UIDs against EXISTS 0) and pruned the cache: 1399 INBOX headers in
    /// one tick on 2026-09-03. The sync may fail; it must not delete mail.
    #[tokio::test]
    async fn a_dead_socket_never_prunes_the_cache() {
        let dir = scratch_dir("dead_socket_prune");
        let healthy = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 5)));
        let engine = engine_for(&dir);
        let warm = engine.sync_account(&account_for(&healthy), "INBOX").await;
        assert!(warm.success, "precondition: a warm cache to lose: {:?}", warm.error);
        assert_eq!(count_sidecars(&cache_dir_for(&dir)), 5);
        drop(healthy);

        let dead = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 5))
                .fault(Trigger::on("SELECT"), Action::DropConnection),
        );
        let result = engine.sync_account(&account_for(&dead), "INBOX").await;

        assert!(!result.success, "EOF on SELECT is not an empty mailbox");
        assert_eq!(count_sidecars(&cache_dir_for(&dir)), 5, "a dead socket must not prune the cache");

        fs::remove_dir_all(&dir).unwrap();
    }

    // ── Ticketed sync.wait ──────────────────────────────────────────────
    //
    // A wait used to be keyed by account and answered with the last result the
    // account produced, forever. Two mailboxes syncing at once answered each
    // other's waits, and every activation after the first read a stale result.

    /// INBOX and Sent sync concurrently in production (activateAccount and
    /// AccountPipeline fire together). INBOX is held back here so it finishes
    /// last — the old per-account watcher would hand its waiter Sent's result.
    #[tokio::test]
    async fn a_wait_returns_the_result_of_the_sync_it_was_issued_for() {
        let dir = scratch_dir("ticket_pairing");
        let mut sent = synthetic_mailbox("Sent", 2);
        sent.attrs.push("\\Sent".to_string());
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 3))
                .mailbox(sent)
                .fault(
                    Trigger::with("SELECT", "INBOX"),
                    Action::Delay(Duration::from_millis(400)),
                ),
        );
        let engine = Arc::new(engine_for(&dir));
        let account = account_for(&server);

        let t_inbox = engine.begin("acc1", "INBOX");
        let t_sent = engine.begin("acc1", "Sent");
        for (ticket, mailbox) in [(t_inbox, "INBOX"), (t_sent, "Sent")] {
            let engine = Arc::clone(&engine);
            let account = account.clone();
            tokio::spawn(async move { engine.run_ticket(ticket, &account, mailbox).await });
        }

        let inbox = engine.wait_for_ticket(t_inbox, 5000).await.expect("INBOX wait");
        assert_eq!(inbox.mailbox, "INBOX");
        assert_eq!(inbox.new_emails, 3, "the INBOX waiter must not be served Sent's result");

        let sent = engine.wait_for_ticket(t_sent, 5000).await.expect("Sent wait");
        assert_eq!(sent.mailbox, "Sent");
        assert_eq!(sent.new_emails, 2);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// `sync.now` and `sync.wait` are two round trips; the sync can finish in
    /// between. The result has to still be there when the waiter arrives.
    #[tokio::test]
    async fn a_late_waiter_still_gets_its_result() {
        let dir = scratch_dir("late_waiter");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 4)));
        let engine = engine_for(&dir);

        let ticket = engine.begin("acc1", "INBOX");
        engine.run_ticket(ticket, &account_for(&server), "INBOX").await;

        let result = engine.wait_for_ticket(ticket, 1000).await.expect("late wait");
        assert_eq!(result.new_emails, 4);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// THE regression. The old wait read the account's last completed result
    /// before waiting for anything, so a second sync answered instantly with
    /// the first one's result — the app re-read its cache before the new sync
    /// had written a byte, and a recovered server still looked broken.
    #[tokio::test]
    async fn a_second_sync_is_not_answered_by_the_first_ones_result() {
        let dir = scratch_dir("stale_wait");
        let engine = Arc::new(engine_for(&dir));

        let first = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 6)));
        let t1 = engine.begin("acc1", "INBOX");
        engine.run_ticket(t1, &account_for(&first), "INBOX").await;
        assert!(engine.wait_for_ticket(t1, 1000).await.is_ok(), "precondition: one completed sync");
        drop(first);

        let second = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 6))
                .fault(
                    Trigger::with("SELECT", "INBOX"),
                    Action::Delay(Duration::from_millis(600)),
                ),
        );
        let account = account_for(&second);
        let t2 = engine.begin("acc1", "INBOX");
        {
            let engine = Arc::clone(&engine);
            let account = account.clone();
            tokio::spawn(async move { engine.run_ticket(t2, &account, "INBOX").await });
        }

        assert_eq!(
            engine.wait_for_ticket(t2, 150).await.unwrap_err(),
            "Sync timed out",
            "a wait on a sync still in flight must block, not hand back the previous result"
        );
        assert!(engine.wait_for_ticket(t2, 5000).await.is_ok(), "and then answer when it lands");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// `sync.status` is what the app shows while a sync runs. Entering Syncing
    /// used to blank the last timestamp and the mailbox totals, so every
    /// refresh flashed "never synced, 0 messages" for the whole duration.
    #[tokio::test]
    async fn a_running_sync_keeps_the_previous_result_visible() {
        let dir = scratch_dir("state_carryover");
        let engine = Arc::new(engine_for(&dir));

        let first = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 30)));
        engine.sync_account(&account_for(&first), "INBOX").await;
        let settled = engine.get_state("acc1").await.expect("a completed sync records a state");
        let t1 = settled.last_sync.expect("a completed sync stamps last_sync");
        assert_eq!(settled.total_emails, 30);
        drop(first);

        let second = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 30))
                .fault(
                    Trigger::with("SELECT", "INBOX"),
                    Action::Delay(Duration::from_millis(600)),
                ),
        );
        let account = account_for(&second);
        let ticket = engine.begin("acc1", "INBOX");
        {
            let engine = Arc::clone(&engine);
            let account = account.clone();
            tokio::spawn(async move { engine.run_ticket(ticket, &account, "INBOX").await });
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
        let running = engine.get_state("acc1").await.expect("a running sync has a state");
        assert_eq!(running.status, SyncStatus::Syncing, "precondition: the second sync is in flight");
        assert_eq!(
            running.last_sync,
            Some(t1),
            "the last successful sync time must survive the next sync"
        );
        assert_eq!(
            running.total_emails, 30,
            "so must the mailbox total — the app shows it while the sync runs"
        );

        engine.wait_for_ticket(ticket, 5000).await.expect("the second sync must finish");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_unknown_ticket_is_an_error() {
        let dir = scratch_dir("unknown_ticket");
        let engine = engine_for(&dir);

        let err = engine.wait_for_ticket(4242, 10).await.unwrap_err();
        assert!(err.contains("Unknown sync ticket"), "unexpected error: {err}");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A capped sync returns before it connects. It still has to finish its
    /// ticket — the app is blocked on it — and the cap has to reach
    /// `sync.status`, which the early return never touched.
    #[tokio::test]
    async fn a_cap_blocked_sync_finishes_its_ticket_and_records_the_error() {
        let dir = scratch_dir("cap_ticket");
        let engine = engine_for(&dir);
        let account: SyncAccount = serde_json::from_value(serde_json::json!({
            "id": "acc1",
            "email": "user@example.com",
            "imapConfig": { "email": "user@example.com", "imapHost": "imap.example.com" }
        }))
        .unwrap();

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        fs::create_dir_all(dir.join("transfer_stats")).unwrap();
        fs::write(
            dir.join("transfer_stats").join("acc1.daemon.json"),
            format!(r#"{{"days":{{"{}":{{"down":209715200,"up":0}}}}}}"#, today),
        )
        .unwrap();
        fs::write(
            dir.join("frontend-settings.json"),
            serde_json::json!({
                "mailvault-settings": { "state": { "transferLimits": { "acc1": {
                    "capEnabled": true,
                    "dailyDownLimitBytes": 100 * MB,
                }}}}
            })
            .to_string(),
        )
        .unwrap();

        let ticket = engine.begin("acc1", "INBOX");
        engine.run_ticket(ticket, &account, "INBOX").await;

        let result = engine
            .wait_for_ticket(ticket, 1000)
            .await
            .expect("a capped sync must finish its ticket, not time out");
        assert!(!result.success);
        assert!(result.error.unwrap_or_default().contains("Daily transfer cap"));

        let state = engine.get_state("acc1").await.expect("the cap must record a state");
        assert_eq!(state.status, SyncStatus::Error);
        assert!(state.last_error.unwrap_or_default().contains("Daily transfer cap"));

        fs::remove_dir_all(&dir).unwrap();
    }

    // ── Characterization: the live delta paths nothing pinned ────────────
    //
    // These describe what the engine does today. They exist so a refactor of
    // the flag/prune/gap paths cannot quietly change behaviour.

    /// With CONDSTORE the engine asks CHANGEDSINCE for exactly the UIDs whose
    /// flags moved and patches the sidecars in place — no re-download.
    #[tokio::test]
    async fn condstore_flag_changes_are_patched_into_cached_sidecars() {
        let dir = scratch_dir("condstore_flags");
        let engine = engine_for(&dir);

        let first = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 10)));
        engine.sync_account(&account_for(&first), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 10);
        drop(first);

        // Same ten messages; uid 5 was read and starred since.
        let mut changed = synthetic_mailbox("INBOX", 10);
        {
            let msg = changed.by_uid_mut(5).expect("uid 5");
            msg.flags = vec!["\\Seen".to_string(), "\\Flagged".to_string()];
            msg.modseq = 50;
        }
        changed.highest_modseq = 50;
        let second = MockImap::start(Scenario::new().mailbox(changed));

        let result = engine.sync_account(&account_for(&second), "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);

        assert!(
            second.count_commands("CHANGEDSINCE") >= 1,
            "the flag patch must ride CHANGEDSINCE, not a re-fetch: {:?}",
            second.commands()
        );
        let uid5: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(cache.join("5.json")).unwrap()).unwrap();
        assert_eq!(uid5["flags"], serde_json::json!(["\\Seen", "\\Flagged"]));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Without CONDSTORE nothing would ever refresh read/star state on cached
    /// mail, so the engine re-reads flags (no headers) for the recent window.
    #[tokio::test]
    async fn flags_are_refreshed_without_condstore() {
        let dir = scratch_dir("no_condstore_flags");
        let engine = engine_for(&dir);

        let first = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 10))
                .without_cap("CONDSTORE"),
        );
        engine.sync_account(&account_for(&first), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 10);
        drop(first);

        let mut changed = synthetic_mailbox("INBOX", 10);
        changed.by_uid_mut(5).expect("uid 5").flags = vec!["\\Seen".to_string()];
        let second = MockImap::start(Scenario::new().mailbox(changed).without_cap("CONDSTORE"));

        let result = engine.sync_account(&account_for(&second), "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);

        assert_eq!(
            second.count_commands("CHANGEDSINCE"),
            0,
            "a server without CONDSTORE must never be asked for CHANGEDSINCE"
        );
        assert!(
            second
                .commands()
                .iter()
                .any(|c| c.to_uppercase().contains("UID FETCH") && c.to_uppercase().contains("FLAGS")),
            "the fallback is a flags-only UID FETCH: {:?}",
            second.commands()
        );
        let uid5: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(cache.join("5.json")).unwrap()).unwrap();
        assert_eq!(uid5["flags"], serde_json::json!(["\\Seen"]));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A mailbox emptied server-side must leave nothing behind — the prune
    /// guard only protects against a *short* UID listing, not an honest zero.
    #[tokio::test]
    async fn an_emptied_mailbox_prunes_every_sidecar() {
        let dir = scratch_dir("emptied_mailbox");
        let engine = engine_for(&dir);

        let first = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 12)));
        engine.sync_account(&account_for(&first), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 12);
        drop(first);

        let emptied = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
        let result = engine.sync_account(&account_for(&emptied), "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);

        assert_eq!(count_sidecars(&cache), 0, "every sidecar must go");
        assert_eq!(read_tauri_cache_meta(&cache).unwrap().total_emails, Some(0));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A UIDNEXT gap wider than the range limit is cheaper as a page fetch than
    /// as a 695-UID range. The page only covers 500, so the backfill is what
    /// actually finishes the mailbox.
    #[tokio::test]
    async fn a_uidnext_gap_beyond_the_range_limit_falls_back_to_a_page_and_backfill_completes_it() {
        let dir = scratch_dir("uidnext_gap");
        let engine = engine_for(&dir);

        let first = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 5)));
        engine.sync_account(&account_for(&first), "INBOX").await;
        let cache = cache_dir_for(&dir);
        assert_eq!(count_sidecars(&cache), 5);
        drop(first);

        let second = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 700)));
        let account = account_for(&second);
        let result = engine.sync_account(&account, "INBOX").await;
        assert!(result.success, "sync failed: {:?}", result.error);
        assert_eq!(result.new_emails, 500, "a gap over the limit falls back to one 500-header page");

        engine.backfill_mailbox(&account, "INBOX").await;
        assert_eq!(count_sidecars(&cache), 700, "backfill must finish what the page started");

        fs::remove_dir_all(&dir).unwrap();
    }
}
