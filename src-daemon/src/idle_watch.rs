//! IDLE watchers — the daemon's ear on each account's INBOX (RFC 2177).
//!
//! Thunderbird idles whatever mailbox a connection has selected; MailVault
//! idles INBOX only, on ONE dedicated session per account outside both pools
//! (a pooled session cannot sit in IDLE and answer a checkout). The app
//! registers accounts (`sync.watch`) because the daemon holds no account list
//! of its own; a watcher lives until `sync.unwatch`, a changed server config,
//! or daemon shutdown. Fresh credentials alone (an OAuth token refresh, hourly
//! on Gmail) are handed to the running watcher instead: tearing it down each
//! hour dropped the IDLE connection with nothing to catch up afterwards. Everything else — the 5-minute timer, Sent, servers
//! without IDLE — keeps working exactly as before; this only shortens the
//! wait for new INBOX mail from minutes to a second.

use crate::imap::async_imap::extensions::idle::IdleResponse;
use crate::imap::{self, ImapPool};
use crate::netgate::NetGate;
use crate::server::DaemonState;
use crate::sync_engine::{SyncAccount, SyncEngine};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tracing::{info, warn};

/// Longest a failed watcher waits before dialling again.
const BACKOFF_CAP: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
pub struct WatchStatus {
    #[serde(rename = "accountId")]
    pub account_id: String,
    /// True only while the connection is parked in IDLE.
    pub idling: bool,
    /// IDLE rounds that woke on real server data and ran a sync.
    pub wakeups: u64,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    /// Why this watcher stopped for good. `None` = it is still running.
    pub reason: Option<String>,
}

struct Watcher {
    handle: tokio::task::JoinHandle<()>,
    /// Debug of the account's ImapConfig without its credentials — host,
    /// port, security. Only a change here replaces the watcher.
    fingerprint: String,
    /// The account the task reads at every connect and every sync, so a
    /// refreshed token reaches it without dropping the live IDLE session.
    account: Arc<Mutex<SyncAccount>>,
    state: Arc<Mutex<WatchStatus>>,
}

/// The config minus what a token refresh or a password change rotates.
fn fingerprint_of(account: &SyncAccount) -> String {
    let mut config = account.imap_config.clone();
    config.password = None;
    config.access_token = None;
    format!("{:?}", config)
}

fn same_credentials(a: &SyncAccount, b: &SyncAccount) -> bool {
    a.imap_config.password == b.imap_config.password && a.imap_config.access_token == b.imap_config.access_token
}

pub struct IdleWatchers {
    engine: Arc<SyncEngine>,
    pool: Arc<ImapPool>,
    net: Arc<NetGate>,
    tasks: tokio::sync::Mutex<HashMap<String, Watcher>>,
    /// First wait after a failure; doubles to `BACKOFF_CAP`. 30 s in
    /// production, 50 ms in tests.
    backoff_base: Duration,
    /// Auto Tags' wake signal (`auto_tag_worker::AutoTagWorkerState::notify`),
    /// set once after both this and `DaemonState` exist (`OnceLock` rather
    /// than a constructor param, since `IdleWatchers` is built before
    /// `DaemonState` is). Absent only in a test that never wires it — every
    /// wake is then simply a no-op, never a panic.
    auto_tag_notify: std::sync::OnceLock<Arc<tokio::sync::Notify>>,
    /// The daemon, for storing an arrival's body in the vault the way an
    /// opened message is (`handlers::imap::cache_arrivals`). Weak: the state
    /// owns these watchers. Absent in a test that never wires it — arrivals
    /// then keep their headers only.
    daemon: std::sync::OnceLock<Weak<DaemonState>>,
}

impl IdleWatchers {
    pub fn new(
        engine: Arc<SyncEngine>,
        pool: Arc<ImapPool>,
        net: Arc<NetGate>,
        backoff_base: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            engine,
            pool,
            net,
            tasks: tokio::sync::Mutex::new(HashMap::new()),
            backoff_base,
            auto_tag_notify: std::sync::OnceLock::new(),
            daemon: std::sync::OnceLock::new(),
        })
    }

    pub fn set_daemon(&self, state: &Arc<DaemonState>) {
        let _ = self.daemon.set(Arc::downgrade(state));
    }

    /// Share Auto Tags' wake signal so an IDLE arrival sweeps auto-tag rules
    /// too, exactly like a manual `sync.now` does (`handlers::handle_sync_now`).
    pub fn set_auto_tag_notify(&self, notify: Arc<tokio::sync::Notify>) {
        let _ = self.auto_tag_notify.set(notify);
    }

    /// Register an account. Re-registering the same config is a no-op — the app
    /// re-sends its account list on every reconnect, and respawning a watcher
    /// per tick would reconnect to the server forever.
    pub async fn watch(self: &Arc<Self>, account: SyncAccount, idle_timeout: Duration) {
        let fingerprint = fingerprint_of(&account);
        let mut tasks = self.tasks.lock().await;
        if let Some(existing) = tasks.get(&account.id) {
            // A task that ended without recording a `reason` did not choose to:
            // it panicked, or something aborted it. Respawn. One that DID set a
            // reason ("no IDLE capability") stays dead, or the app's
            // re-registration would redial that server every tick.
            let died = existing.handle.is_finished()
                && existing.state.lock().unwrap().reason.is_none();
            if existing.fingerprint == fingerprint && !died {
                if same_credentials(&existing.account.lock().unwrap(), &account) {
                    return;
                }
                // New credentials for the same server. A healthy session stays
                // authenticated, so hand them over for the next connect and
                // sync rather than drop the IDLE. A failing one (the old
                // password refused) starts over now instead of sitting out
                // its backoff.
                if existing.state.lock().unwrap().last_error.is_none() {
                    *existing.account.lock().unwrap() = account;
                    return;
                }
            }
            info!(
                "[idle] {} — replacing its watcher ({})",
                account.id,
                if died {
                    "the task ended"
                } else if existing.fingerprint != fingerprint {
                    "config changed"
                } else {
                    "new credentials for a failing watcher"
                }
            );
            existing.handle.abort();
        }

        let state = Arc::new(Mutex::new(WatchStatus {
            account_id: account.id.clone(),
            idling: false,
            wakeups: 0,
            last_error: None,
            reason: None,
        }));
        let account_id = account.id.clone();
        let account = Arc::new(Mutex::new(account));
        let me = Arc::clone(self);
        let task_state = Arc::clone(&state);
        let task_account = Arc::clone(&account);
        let handle = tokio::spawn(async move { me.run(task_account, idle_timeout, task_state).await });
        tasks.insert(account_id, Watcher { handle, fingerprint, account, state });
    }

    pub async fn unwatch(&self, account_id: &str) {
        if let Some(w) = self.tasks.lock().await.remove(account_id) {
            w.handle.abort();
            info!("[idle] stopped watching {}", account_id);
        }
    }

    pub async fn status(&self) -> Vec<WatchStatus> {
        self.tasks
            .lock()
            .await
            .values()
            .map(|w| w.state.lock().unwrap().clone())
            .collect()
    }

    /// One account's watcher. Connects outside both pools, parks INBOX in
    /// IDLE, syncs when the server says something happened, and reconnects
    /// with a doubling backoff when it does not. Ends only on a server that
    /// cannot IDLE — everything else is worth retrying for ever, because the
    /// alternative is an account that silently stops noticing new mail.
    async fn run(
        self: Arc<Self>,
        slot: Arc<Mutex<SyncAccount>>,
        idle_timeout: Duration,
        state: Arc<Mutex<WatchStatus>>,
    ) {
        let mut backoff = self.backoff_base;

        loop {
            if !self.net.is_online() {
                tokio::time::sleep(self.backoff_base).await;
                continue;
            }

            // Read at every connect: the credentials may have been refreshed
            // since the last one (`watch`).
            let account = slot.lock().unwrap().clone();
            let config = &account.imap_config;

            // NOT from a pool: a session parked in IDLE answers no checkout,
            // and handing one out would hang whatever borrowed it.
            let mut session = match imap::create_imap_session(config, &self.pool).await {
                Ok(s) => s,
                Err(e) => {
                    warn!("[idle] {}: connect failed: {}", account.email, e);
                    note_error(&state, e);
                    wait_backoff(&mut backoff).await;
                    continue;
                }
            };

            if !self.pool.has_capability(config, "IDLE").await {
                info!(
                    "[idle] {} does not advertise IDLE — leaving it to the 5-minute timer",
                    account.email
                );
                {
                    let mut s = state.lock().unwrap();
                    s.idling = false;
                    s.reason = Some("no IDLE capability".to_string());
                }
                let _ = session.logout().await;
                return;
            }

            if let Err(e) = imap::select_mailbox(&mut session, "INBOX").await {
                warn!("[idle] {}: SELECT INBOX failed: {}", account.email, e);
                note_error(&state, e);
                wait_backoff(&mut backoff).await;
                continue;
            }

            // Mail that arrived while nobody was listening (the first connect,
            // a dropped socket, a network blip) raises no EXISTS on the new
            // session: only a sync finds it. Before the IDLE, so it lands now
            // and not at the next scheduled refresh.
            self.sync_inbox(&slot, false).await;

            loop {
                let mut handle = session.idle();
                if let Err(e) = handle.init().await {
                    note_error(&state, format!("IDLE failed: {}", e));
                    break;
                }
                {
                    let mut s = state.lock().unwrap();
                    s.idling = true;
                    // Healthy again: `watch` hands fresh credentials to a
                    // watcher without an error, and replaces one with.
                    s.last_error = None;
                }
                // The StopSource must outlive the future: dropping it early
                // interrupts the IDLE we just asked for.
                let response = {
                    let (wait, _stop) = handle.wait_with_timeout(idle_timeout);
                    wait.await
                };
                state.lock().unwrap().idling = false;

                session = match handle.done().await {
                    Ok(s) => s,
                    Err(e) => {
                        note_error(&state, format!("DONE failed: {}", e));
                        break;
                    }
                };

                match response {
                    Ok(IdleResponse::NewData(_)) => {
                        self.sync_inbox(&slot, true).await;
                        state.lock().unwrap().wakeups += 1;
                    }
                    // A 29-minute timeout, or our own interrupt: a cheap delta
                    // sync, then re-issue — a push the server never sent is
                    // caught here rather than at the next scheduled refresh.
                    Ok(_) => self.sync_inbox(&slot, false).await,
                    Err(e) => {
                        note_error(&state, format!("IDLE ended: {}", e));
                        break;
                    }
                }
                // Only here: a round that ended in data or a timeout is proof
                // the connection is healthy. Every failing arm above breaks out
                // to reconnect and must keep the backoff it had, or a server
                // that fails one round in every two is dialled at full speed
                // for ever.
                backoff = self.backoff_base;
            }

            state.lock().unwrap().idling = false;
            wait_backoff(&mut backoff).await;
        }
    }

    /// Sync INBOX and publish what it found. `woken`: the server pushed
    /// something, so the app hears about it even when the sync counts nothing
    /// (an expunge is pruned by the reconcile, not counted). A catch-up after
    /// a connect or a timeout stays silent unless it found mail or flags.
    async fn sync_inbox(&self, slot: &Mutex<SyncAccount>, woken: bool) {
        let account = slot.lock().unwrap().clone();
        // `announcing`: new headers are published the moment they are cached,
        // before the flag step and the reconcile, which on a large mailbox
        // took most of a minute.
        let result = self.engine.sync_account_announcing(&account, "INBOX").await;
        if !result.success {
            // Re-idle anyway: the 5-minute timer covers a sync that failed,
            // and dropping the watch would cost this account every later
            // notification.
            warn!("[idle] {}: sync failed: {:?}", account.email, result.error);
            return;
        }
        // `arrivals`, not `new_emails`: a sync that lands on a cold or
        // far-behind cache writes a whole page of old headers, and the app
        // turns this number straight into a "N new emails" banner.
        let unannounced = if result.announced { 0 } else { result.arrivals };
        if woken || unannounced > 0 || result.updated_flags > 0 {
            self.engine.note_change(&account.id, "INBOX", unannounced, result.updated_flags);
        }
        if result.arrivals == 0 {
            return;
        }
        // Same signal Auto Tags' worker wakes on for a manual sync
        // (`handlers::handle_sync_now`) — an IDLE arrival must not need a
        // second, separate trigger to be swept.
        if let Some(notify) = self.auto_tag_notify.get() {
            notify.notify_one();
        }
        // Its own task: the IDLE is re-issued now, not after the downloads,
        // so a message that lands meanwhile still raises its EXISTS.
        if let Some(state) = self.daemon.get().and_then(Weak::upgrade) {
            let uids = result.arrival_uids;
            tokio::spawn(async move {
                crate::handlers::imap::cache_arrivals(&state, &account, "INBOX", &uids).await;
            });
        }
    }

    /// Abort every watcher. Called before the pools log out at shutdown — an
    /// IDLE'd socket answers nothing, so it has to go first.
    pub async fn shutdown(&self) {
        let mut tasks = self.tasks.lock().await;
        for (id, w) in tasks.drain() {
            w.handle.abort();
            info!("[idle] shutdown: aborted watcher for {}", id);
        }
    }
}

fn note_error(state: &Arc<Mutex<WatchStatus>>, error: String) {
    let mut s = state.lock().unwrap();
    s.idling = false;
    s.last_error = Some(error);
}

/// Wait out this failure, then double the wait for the next one.
async fn wait_backoff(backoff: &mut Duration) {
    tokio::time::sleep(*backoff).await;
    *backoff = (*backoff * 2).min(BACKOFF_CAP);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contacts_index::ContactsState;
    use mock_imap::state::synthetic_mailbox;
    use mock_imap::{Action, Message, MockImap, Scenario, Trigger};
    use std::path::{Path, PathBuf};

    // Duplicated from sync_engine's test module — fifteen lines beats making
    // three helpers `pub(crate)` for one caller.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv_idle_test_{}_{}", name, uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn gate(online: bool) -> Arc<NetGate> {
        NetGate::with_probe(Arc::new(move || Box::pin(async move { online })))
    }

    fn engine_for(dir: &Path) -> SyncEngine {
        let engine = SyncEngine::new(
            Arc::new(imap::ImapPool::new()),
            dir.to_path_buf(),
            dir.to_path_buf(),
            ContactsState::new(dir.to_path_buf()),
            gate(true),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(std::sync::RwLock::new(())),
        );
        // The header cache is `custody.db`: without one attached every cache
        // write fails, which is what production does too.
        engine.attach_custody_db(Arc::new(std::sync::Mutex::new(Some(
            mailvault_core::custody::db::open(dir).unwrap(),
        ))));
        engine
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

    /// Sidecars written under `<dir>/email_cache/<account-mailbox>/`.
    /// How many headers the vault has cached, read through the engine's own
    /// connection (`custody.db` is EXCLUSIVE — a second opener fails BUSY).
    fn cached(engine: &SyncEngine) -> usize {
        let db = engine.custody_db().expect("engine has a store attached");
        let guard = db.lock().unwrap_or_else(|p| p.into_inner());
        mailvault_core::custody::cache::count(guard.as_ref().expect("store is open"), "acc1", "INBOX").unwrap()
    }

    async fn wait_until(mut cond: impl FnMut() -> bool, timeout_ms: u64, what: &str) {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out after {timeout_ms}ms waiting for: {what}");
    }

    #[tokio::test]
    async fn new_mail_during_idle_runs_a_sync_and_notes_a_change() {
        let dir = scratch_dir("idle_new_mail");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let engine = Arc::new(engine_for(&dir));
        let account = account_for(&server);
        // Prime the cache, so the wake-up sync reports the ONE new message
        // rather than the whole mailbox.
        engine.sync_account(&account, "INBOX").await;
        assert_eq!(cached(&engine), 2);

        let watchers = IdleWatchers::new(
            Arc::clone(&engine),
            Arc::new(imap::ImapPool::new()),
            gate(true),
            Duration::from_millis(50),
        );
        let g0 = engine.change_gen();
        watchers.watch(account.clone(), Duration::from_secs(29 * 60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the first IDLE").await;

        server.mutate(|st| {
            let mb = st.find_mut("INBOX").unwrap();
            let uid = mb.uid_next;
            mb.add(Message::new(uid, "Subject: three\r\n\r\nx"));
        });

        let (g, recs) = engine.wait_changes(g0, 10_000).await;
        assert!(g > g0);
        assert_eq!(recs[0].new_emails, 1);
        assert_eq!(recs[0].mailbox, "INBOX");
        assert_eq!(cached(&engine), 3, "the wake-up sync cached the new header");

        // Re-entered IDLE after the sync — one wake-up must not end the watch.
        wait_until(|| server.count_commands("IDLE") >= 2, 5_000, "IDLE re-issued").await;
        assert_eq!(watchers.status().await[0].wakeups, 1);

        watchers.shutdown().await;
        assert!(watchers.status().await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_server_without_idle_ends_the_watcher_with_a_reason() {
        let dir = scratch_dir("idle_no_cap");
        let server = MockImap::start(
            Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)).without_cap("IDLE"),
        );
        let engine = Arc::new(engine_for(&dir));
        let watchers = IdleWatchers::new(
            Arc::clone(&engine),
            Arc::new(imap::ImapPool::new()),
            gate(true),
            Duration::from_millis(50),
        );

        watchers.watch(account_for(&server), Duration::from_secs(60)).await;
        let mut stopped = None;
        for _ in 0..250 {
            let status = watchers.status().await;
            match status.first() {
                Some(w) if !w.idling && w.reason.is_some() => {
                    stopped = w.reason.clone();
                    break;
                }
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        assert_eq!(stopped.as_deref(), Some("no IDLE capability"));

        assert_eq!(server.count_commands("IDLE"), 0, "it must not try IDLE at all");
        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_dropped_socket_reconnects() {
        let dir = scratch_dir("idle_drop");
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .fault(Trigger::nth("IDLE", 1), Action::DropConnection),
        );
        let engine = Arc::new(engine_for(&dir));
        let watchers = IdleWatchers::new(
            Arc::clone(&engine),
            Arc::new(imap::ImapPool::new()),
            gate(true),
            Duration::from_millis(50),
        );

        watchers.watch(account_for(&server), Duration::from_secs(60)).await;
        // The dropped IDLE never reaches `idle_loop`, which is what logs it —
        // so the one logged line IS the second connection's, and the connection
        // count is what proves the first one died.
        wait_until(
            || server.connection_count() >= 2 && server.count_commands("IDLE") >= 1,
            5_000,
            "a second connection that idles again",
        )
        .await;

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn idle_is_reissued_after_the_timeout() {
        let dir = scratch_dir("idle_timeout");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let engine = Arc::new(engine_for(&dir));
        let watchers = IdleWatchers::new(
            Arc::clone(&engine),
            Arc::new(imap::ImapPool::new()),
            gate(true),
            Duration::from_millis(50),
        );

        watchers.watch(account_for(&server), Duration::from_millis(200)).await;
        wait_until(|| server.count_commands("IDLE") >= 3, 5_000, "IDLE re-issued twice").await;

        // Each timeout runs a quiet catch-up sync, which finds nothing: no
        // change is announced for it.
        assert_eq!(engine.change_gen(), 0, "a timeout is not new mail");
        // The IDLE connection plus the engine's one pooled sync session: the
        // IDLE one was never redialled.
        assert_eq!(server.connection_count(), 2, "and it is not a reconnect either");
        assert_eq!(watchers.status().await[0].wakeups, 0);

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn watch_replaces_a_watcher_whose_server_config_changed_and_ignores_an_unchanged_one() {
        let dir = scratch_dir("idle_replace");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let engine = Arc::new(engine_for(&dir));
        let watchers = IdleWatchers::new(
            Arc::clone(&engine),
            Arc::new(imap::ImapPool::new()),
            gate(true),
            Duration::from_millis(50),
        );
        let account = account_for(&server);

        watchers.watch(account.clone(), Duration::from_secs(60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the first IDLE").await;
        let before = server.connection_count();
        watchers.watch(account.clone(), Duration::from_secs(60)).await;
        assert_eq!(watchers.status().await.len(), 1);
        assert_eq!(server.connection_count(), before, "an unchanged account must not reconnect");

        let mut changed = account.clone();
        changed.imap_config.name = Some("Renamed".to_string());
        watchers.watch(changed, Duration::from_secs(60)).await;
        wait_until(
            || server.connection_count() > before && server.count_commands("IDLE") >= 2,
            5_000,
            "the replacement watcher to connect",
        )
        .await;
        assert_eq!(watchers.status().await.len(), 1, "replaced, not doubled");

        watchers.unwatch("acc1").await;
        assert!(watchers.status().await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A task that died without recording a `reason` (a panic, a stray abort)
    /// left the map entry behind, and every later `watch()` matched its
    /// fingerprint and returned — the account stopped noticing new mail until
    /// the daemon restarted.
    #[tokio::test]
    async fn watch_respawns_a_watcher_whose_task_died_without_a_reason() {
        let dir = scratch_dir("idle_respawn");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let engine = Arc::new(engine_for(&dir));
        let watchers = IdleWatchers::new(
            Arc::clone(&engine),
            Arc::new(imap::ImapPool::new()),
            gate(true),
            Duration::from_millis(50),
        );
        let account = account_for(&server);

        watchers.watch(account.clone(), Duration::from_secs(60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the first IDLE").await;
        let before = server.connection_count();

        // Kill it the way a panic would: the task ends, no reason recorded.
        watchers.tasks.lock().await.get("acc1").unwrap().handle.abort();
        for _ in 0..250 {
            if watchers.tasks.lock().await["acc1"].handle.is_finished() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(watchers.status().await[0].reason.is_none(), "it did not choose to stop");

        watchers.watch(account, Duration::from_secs(60)).await;
        wait_until(
            || server.connection_count() > before && server.count_commands("IDLE") >= 2,
            5_000,
            "a fresh task on a fresh connection",
        )
        .await;
        assert_eq!(server.connection_count(), before + 1, "one replacement, not a storm");
        assert_eq!(watchers.status().await.len(), 1);

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn add_message(server: &MockImap, raw: &str) -> u32 {
        let mut added = 0;
        server.mutate(|st| {
            let mb = st.find_mut("INBOX").unwrap();
            added = mb.uid_next;
            mb.add(Message::new(added, raw));
        });
        added
    }

    fn watchers_for(engine: &Arc<SyncEngine>, backoff: Duration) -> Arc<IdleWatchers> {
        IdleWatchers::new(Arc::clone(engine), Arc::new(imap::ImapPool::new()), gate(true), backoff)
    }

    /// Mail that arrived while no watcher was listening raises no EXISTS on
    /// the new session. Before the catch-up sync it waited for the app's
    /// 5-minute refresh, or for the user to reopen the app.
    #[tokio::test]
    async fn mail_that_arrived_before_the_watcher_connected_is_synced_at_once() {
        let dir = scratch_dir("idle_catch_up");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let engine = Arc::new(engine_for(&dir));
        let account = account_for(&server);
        engine.sync_account(&account, "INBOX").await;
        add_message(&server, "Subject: three\r\n\r\nx");

        let watchers = watchers_for(&engine, Duration::from_millis(50));
        let g0 = engine.change_gen();
        watchers.watch(account, Duration::from_secs(29 * 60)).await;

        let (g, recs) = engine.wait_changes(g0, 10_000).await;
        assert!(g > g0, "the connect must sync, not wait for a push that will never come");
        assert_eq!(recs[0].new_emails, 1);
        assert_eq!(cached(&engine), 3);
        assert_eq!(watchers.status().await[0].wakeups, 0, "caught up, not woken");

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The network blip in the field: the IDLE socket dies without a word,
    /// a message lands meanwhile, and the new session's baseline already
    /// counts it. Only a sync on reconnect finds it.
    #[tokio::test]
    async fn a_dropped_idle_catches_up_on_reconnect_with_the_mail_it_missed() {
        let dir = scratch_dir("idle_drop_catch_up");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let engine = Arc::new(engine_for(&dir));
        let account = account_for(&server);
        engine.sync_account(&account, "INBOX").await;

        let watchers = watchers_for(&engine, Duration::from_millis(50));
        watchers.watch(account, Duration::from_secs(29 * 60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the first IDLE").await;

        let g0 = engine.change_gen();
        server.mutate(|st| {
            st.idle_drops += 1;
            let mb = st.find_mut("INBOX").unwrap();
            let uid = mb.uid_next;
            mb.add(Message::new(uid, "Subject: missed\r\n\r\nx"));
        });

        let (g, recs) = engine.wait_changes(g0, 10_000).await;
        assert!(g > g0, "the reconnect must sync the mail that arrived while it was gone");
        assert_eq!(recs[0].new_emails, 1);
        assert_eq!(cached(&engine), 3);
        assert_eq!(watchers.status().await[0].wakeups, 0, "no EXISTS reached it: the reconnect found it");

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Gmail's token rotates hourly and the app re-registers with the new one.
    /// Replacing the watcher for it dropped every Gmail IDLE once an hour.
    #[tokio::test]
    async fn fresh_credentials_reach_a_healthy_watcher_without_a_reconnect() {
        let dir = scratch_dir("idle_rotate");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let engine = Arc::new(engine_for(&dir));
        let account = account_for(&server);
        engine.sync_account(&account, "INBOX").await;

        let watchers = watchers_for(&engine, Duration::from_millis(50));
        watchers.watch(account.clone(), Duration::from_secs(29 * 60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the first IDLE").await;
        let before = server.connection_count();

        let mut rotated = account.clone();
        rotated.imap_config.password = Some("rotated".to_string());
        watchers.watch(rotated, Duration::from_secs(29 * 60)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(server.connection_count(), before, "new credentials alone must not drop the IDLE");
        assert_eq!(watchers.status().await.len(), 1);

        // From now on only the new password logs in. A dropped IDLE has to
        // reconnect with it, or nothing is ever synced again.
        let g0 = engine.change_gen();
        server.mutate(|st| {
            st.expect_login = Some(("user@example.com".to_string(), "rotated".to_string()));
            st.idle_drops += 1;
            let mb = st.find_mut("INBOX").unwrap();
            let uid = mb.uid_next;
            mb.add(Message::new(uid, "Subject: after rotation\r\n\r\nx"));
        });
        let (g, recs) = engine.wait_changes(g0, 10_000).await;
        assert!(g > g0, "the reconnect logged in with the handed-over password and caught up");
        assert_eq!(recs[0].new_emails, 1);

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A watcher whose login keeps failing must not sit out its backoff once
    /// the user fixes the password: new credentials restart it at once.
    #[tokio::test]
    async fn new_credentials_restart_a_watcher_whose_login_is_failing() {
        let dir = scratch_dir("idle_fixed_password");
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        server.mutate(|st| st.expect_login = Some(("user@example.com".to_string(), "right".to_string())));
        let engine = Arc::new(engine_for(&dir));
        // Far longer than the test: only a replacement can bring it up in time.
        let watchers = watchers_for(&engine, Duration::from_secs(600));
        let account = account_for(&server);

        watchers.watch(account.clone(), Duration::from_secs(29 * 60)).await;
        let mut failing = false;
        for _ in 0..250 {
            if watchers.status().await.first().is_some_and(|w| w.last_error.is_some()) {
                failing = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(failing, "the wrong password is refused");

        let mut fixed = account;
        fixed.imap_config.password = Some("right".to_string());
        watchers.watch(fixed, Duration::from_secs(29 * 60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the restarted watcher to idle").await;
        assert_eq!(watchers.status().await.len(), 1);

        watchers.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 4035-message Gmail INBOX in the field: counts disagreed, the reconcile
    /// listed every UID for 51 s, and the new message was only published
    /// after it.
    #[tokio::test]
    async fn an_arrival_is_announced_before_a_slow_reconcile_finishes() {
        let dir = scratch_dir("idle_early");
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 2))
                // The reconcile's UID listing (`search_all_uid_flags`).
                .fault(Trigger::with("FETCH", "1:* (UID FLAGS)"), Action::Delay(Duration::from_secs(3))),
        );
        let engine = Arc::new(engine_for(&dir));
        let account = account_for(&server);
        // A cold sync records no reconcile, so the next delta runs one.
        engine.sync_account(&account, "INBOX").await;
        add_message(&server, "Subject: early\r\n\r\nx");

        let g0 = engine.change_gen();
        let (e2, a2) = (Arc::clone(&engine), account.clone());
        let sync = tokio::spawn(async move { e2.sync_account_announcing(&a2, "INBOX").await });

        let (g, recs) = engine.wait_changes(g0, 2_000).await;
        assert!(g > g0, "announced while the reconcile's UID listing is still stalled");
        assert_eq!(recs[0].new_emails, 1);
        assert!(!sync.is_finished(), "the sync itself is still reconciling");
        assert_eq!(cached(&engine), 3, "the row the announcement names is already cached");

        let result = sync.await.unwrap();
        assert!(result.success && result.announced);
        assert_eq!(result.arrival_uids.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// "Downloaded the moment they are received": the body lands in the vault
    /// as the cache copy an opened message gets (`<uid>:2,.eml`, no `A`), and
    /// the search index finds it by its text.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_arrival_body_is_stored_as_a_cache_copy_and_indexed() {
        use mailvault_core::search_index::query::SearchRequest;
        let dir = scratch_dir("idle_body");
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let account = account_for(&server);
        state.sync_engine.sync_account(&account, "INBOX").await;
        crate::search_index::start(Arc::clone(&state.search_index));
        crate::search_index::configure(
            &state.search_index,
            serde_json::from_value(serde_json::json!({"enabled": true, "bodies": true})).unwrap(),
        );

        state.idle.watch(account, Duration::from_secs(29 * 60)).await;
        wait_until(|| server.count_commands("IDLE") >= 1, 5_000, "the first IDLE").await;
        let uid = add_message(
            &server,
            &format!(
                "From: Courier <courier@example.com>\r\nTo: user@example.com\r\nSubject: Parcel\r\nDate: {}\r\n\r\nzanzibar marmalade\r\n",
                chrono::Utc::now().to_rfc2822()
            ),
        );

        let file = mailvault_core::vault_files::cur_path(&dir, "acc1", "INBOX")
            .join(format!("{}{}.eml", uid, mailvault_core::maildir::INFO_PREFIX));
        wait_until(|| file.exists(), 10_000, "the arrival's body as a flagless cache copy").await;

        let request = SearchRequest { account_id: "acc1".into(), query: "zanzibar".into(), ..Default::default() };
        let found = || {
            crate::search_index::search_reply(&state.search_index, &request)
                .ok()
                .and_then(|r| r["rows"].as_array().map(|rows| rows.iter().any(|row| row["uid"] == uid)))
                .unwrap_or(false)
        };
        wait_until(found, 20_000, "the arrival searchable by its body").await;

        state.idle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
