//! IDLE watchers — the daemon's ear on each account's INBOX (RFC 2177).
//!
//! Thunderbird idles whatever mailbox a connection has selected; MailVault
//! idles INBOX only, on ONE dedicated session per account outside both pools
//! (a pooled session cannot sit in IDLE and answer a checkout). The app
//! registers accounts (`sync.watch`) because the daemon holds no account list
//! of its own; a watcher lives until `sync.unwatch`, a changed config, or
//! daemon shutdown. Everything else — the 5-minute timer, Sent, servers
//! without IDLE — keeps working exactly as before; this only shortens the
//! wait for new INBOX mail from minutes to a second.

use crate::imap::async_imap::extensions::idle::IdleResponse;
use crate::imap::{self, ImapPool};
use crate::netgate::NetGate;
use crate::sync_engine::{SyncAccount, SyncEngine};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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
    /// Debug of the account's ImapConfig — host, port, credentials. A token
    /// refresh changes it, so the watcher is replaced rather than left idling
    /// on a session the server is about to reject.
    fingerprint: String,
    state: Arc<Mutex<WatchStatus>>,
}

pub struct IdleWatchers {
    engine: Arc<SyncEngine>,
    pool: Arc<ImapPool>,
    net: Arc<NetGate>,
    tasks: tokio::sync::Mutex<HashMap<String, Watcher>>,
    /// First wait after a failure; doubles to `BACKOFF_CAP`. 30 s in
    /// production, 50 ms in tests.
    backoff_base: Duration,
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
        })
    }

    /// Register an account. Re-registering the same config is a no-op — the app
    /// re-sends its account list on every reconnect, and respawning a watcher
    /// per tick would reconnect to the server forever.
    pub async fn watch(self: &Arc<Self>, account: SyncAccount, idle_timeout: Duration) {
        let fingerprint = format!("{:?}", account.imap_config);
        let mut tasks = self.tasks.lock().await;
        if let Some(existing) = tasks.get(&account.id) {
            // A task that ended without recording a `reason` did not choose to:
            // it panicked, or something aborted it. Respawn. One that DID set a
            // reason ("no IDLE capability") stays dead, or the app's
            // re-registration would redial that server every tick.
            let died = existing.handle.is_finished()
                && existing.state.lock().unwrap().reason.is_none();
            if existing.fingerprint == fingerprint && !died {
                return;
            }
            info!(
                "[idle] {} — replacing its watcher ({})",
                account.id,
                if died { "the task ended" } else { "config changed" }
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
        let me = Arc::clone(self);
        let task_state = Arc::clone(&state);
        let handle = tokio::spawn(async move { me.run(account, idle_timeout, task_state).await });
        tasks.insert(account_id, Watcher { handle, fingerprint, state });
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
        account: SyncAccount,
        idle_timeout: Duration,
        state: Arc<Mutex<WatchStatus>>,
    ) {
        let config = &account.imap_config;
        let mut backoff = self.backoff_base;

        loop {
            if !self.net.is_online() {
                tokio::time::sleep(self.backoff_base).await;
                continue;
            }

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

            loop {
                let mut handle = session.idle();
                if let Err(e) = handle.init().await {
                    note_error(&state, format!("IDLE failed: {}", e));
                    break;
                }
                state.lock().unwrap().idling = true;
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
                        let result = self.engine.sync_account(&account, "INBOX").await;
                        if result.success {
                            self.engine.note_change(
                                &account.id,
                                "INBOX",
                                result.new_emails,
                                result.updated_flags,
                            );
                        } else {
                            // Re-idle anyway: the 5-minute timer covers a sync
                            // that failed, and dropping the watch would cost
                            // this account every later notification.
                            warn!(
                                "[idle] {}: wake-up sync failed: {:?}",
                                account.email, result.error
                            );
                        }
                        state.lock().unwrap().wakeups += 1;
                    }
                    // A 29-minute timeout, or our own interrupt: just re-issue.
                    Ok(_) => {}
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
        SyncEngine::new(
            Arc::new(imap::ImapPool::new()),
            dir.to_path_buf(),
            dir.to_path_buf(),
            ContactsState::new(dir.to_path_buf()),
            gate(true),
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

    /// Sidecars written under `<dir>/email_cache/<account-mailbox>/`.
    fn sidecars(dir: &Path) -> usize {
        let mut n = 0;
        for cache in std::fs::read_dir(dir.join("email_cache")).into_iter().flatten().flatten() {
            for f in std::fs::read_dir(cache.path()).into_iter().flatten().flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if name.ends_with(".json") && name != "_meta.json" {
                    n += 1;
                }
            }
        }
        n
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
        assert_eq!(sidecars(&dir), 2);

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
        assert_eq!(sidecars(&dir), 3, "the wake-up sync wrote the new sidecar");

        // Re-entered IDLE after the sync — one wake-up must not end the watch.
        wait_until(|| server.count_commands("IDLE") >= 2, 5_000, "IDLE re-issued").await;
        assert_eq!(watchers.status().await[0].wakeups, 1);

        watchers.shutdown().await;
        assert!(watchers.status().await.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
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
        std::fs::remove_dir_all(&dir).unwrap();
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
        std::fs::remove_dir_all(&dir).unwrap();
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

        assert_eq!(server.count_commands("UID FETCH"), 0, "a timeout is not new mail");
        assert_eq!(server.connection_count(), 1, "and it is not a reconnect either");
        assert_eq!(watchers.status().await[0].wakeups, 0);

        watchers.shutdown().await;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn watch_replaces_a_watcher_whose_credentials_changed_and_ignores_an_unchanged_one() {
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
        watchers.watch(account.clone(), Duration::from_secs(60)).await;
        assert_eq!(watchers.status().await.len(), 1);
        assert_eq!(server.connection_count(), 1, "an unchanged account must not reconnect");

        let mut rotated = account.clone();
        rotated.imap_config.password = Some("other".to_string());
        watchers.watch(rotated, Duration::from_secs(60)).await;
        wait_until(
            || server.connection_count() >= 2 && server.count_commands("IDLE") >= 2,
            5_000,
            "the replacement watcher to connect",
        )
        .await;
        assert_eq!(watchers.status().await.len(), 1, "replaced, not doubled");

        watchers.unwatch("acc1").await;
        assert!(watchers.status().await.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
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
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
