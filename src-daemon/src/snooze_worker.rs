//! Background worker for Snooze. Same shape as `scheduled_send_worker.rs`:
//! a catch-up pass over everything already due when the daemon starts (the
//! daemon dying with the app is the normal case, so "already past" is only
//! ever woken, never refused), then a sleep until the next wake time or a
//! poke from `handlers::snooze`.
//!
//! A wake finds the message in the Snoozed folder by Message-ID (the stored
//! COPYUID is only a hint, `snooze::pick_uid`), clears `\Seen` there — flags
//! travel with a MOVE, so the new uid is never needed — moves it back, then
//! syncs the destination and records the change exactly as an IDLE arrival
//! does (`idle_watch.rs`), which is what turns it into the app's new-mail
//! notification and list refresh.
//!
//! Graph accounts are not handled here: the daemon never refreshes an OAuth
//! token (the app does), so a background Graph move cannot be relied on.
//! The app does not offer Snooze on a Graph account.

use crate::credentials;
use crate::imap::{self, pool::PooledSessionGuard, ImapConfig};
use crate::server::DaemonState;
use crate::sync_engine::SyncAccount;
use mailvault_core::app_db::{self, snooze};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

#[derive(Default)]
pub struct SnoozeState {
    pub notify: tokio::sync::Notify,
    /// Held for a whole worker pass and for `snooze.cancel`'s immediate
    /// wake, so the two can never move the same message twice.
    pub(crate) lock: tokio::sync::Mutex<()>,
}

impl SnoozeState {
    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

/// Same pacing constants and reasons as `scheduled_send_worker.rs`.
const OFFLINE_POLL: Duration = Duration::from_secs(30);
const MAX_SLEEP: Duration = Duration::from_secs(3600);
const MIN_RETRY_WAIT: Duration = Duration::from_secs(1);
const KEYCHAIN_POLL: Duration = Duration::from_secs(5 * 60);

pub(crate) fn start(state: Arc<DaemonState>) {
    tokio::spawn(async move { run(state).await });
}

async fn run(state: Arc<DaemonState>) {
    info!("[snooze] worker started");
    loop {
        let online = state.net.is_online();
        let results = if online {
            let _held = state.snooze.lock.lock().await;
            let st = Arc::clone(&state);
            let results = process_due_with(&state.app_dir, now_ms(), move |row| {
                let st = Arc::clone(&st);
                async move { wake_row(&st, &row).await }
            })
            .await;
            for (id, _, row_state) in &results {
                emit(&state, id, row_state);
            }
            results
        } else {
            Vec::new()
        };
        // A `Wait` leaves its row due; without a floor the loop would spin on
        // it until the network or the keychain comes back.
        let waited = results.iter().any(|(_, outcome, _)| matches!(outcome, snooze::WakeOutcome::Wait(_)));
        let mut wait = if !online || waited { OFFLINE_POLL } else { next_wait(&state) };
        if !results.is_empty() {
            wait = wait.max(MIN_RETRY_WAIT);
        }
        if credentials::GATE.is_blocked() {
            wait = wait.max(KEYCHAIN_POLL);
        }
        tokio::select! {
            _ = state.snooze.notify.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn next_wait(state: &Arc<DaemonState>) -> Duration {
    match app_db::with(&state.app_dir, snooze::next_wake_at).ok().flatten() {
        Some(at) if at <= now_ms() => Duration::ZERO,
        Some(at) => Duration::from_millis((at - now_ms()) as u64).min(MAX_SLEEP),
        None => MAX_SLEEP,
    }
}

pub(crate) fn emit(state: &Arc<DaemonState>, id: &str, row_state: &str) {
    state.events.emit("snooze", json!({"id": id, "state": row_state}));
}

/// Run every due row through `wake` and record what it came to. Returns
/// `(id, outcome, state afterwards)` per row, so the caller can emit and pace
/// itself. `wake` is the real IMAP move in the daemon and a stub in tests.
pub(crate) async fn process_due_with<F, Fut>(app_dir: &Path, now: i64, mut wake: F) -> Vec<(String, snooze::WakeOutcome, String)>
where
    F: FnMut(snooze::Snooze) -> Fut,
    Fut: std::future::Future<Output = snooze::WakeOutcome>,
{
    let due = match app_db::with(app_dir, |c| snooze::due(c, now)) {
        Ok(v) => v,
        Err(e) => {
            warn!("[snooze] could not read due rows: {e}");
            return Vec::new();
        }
    };
    let mut results = Vec::with_capacity(due.len());
    for row in due {
        let id = row.id.clone();
        let outcome = wake(row).await;
        match app_db::with(app_dir, |c| snooze::record_outcome(c, &id, &outcome, now_ms())) {
            Ok(row_state) => results.push((id, outcome, row_state)),
            Err(e) => warn!("[snooze] could not record {outcome:?} for {id}: {e}"),
        }
    }
    results
}

/// Move one row's message back where it came from, unread. Also what
/// `snooze.cancel` calls to unsnooze now, so "now" is never a second path.
/// The caller holds `SnoozeState::lock`.
pub(crate) async fn wake_row(state: &Arc<DaemonState>, row: &snooze::Snooze) -> snooze::WakeOutcome {
    use snooze::WakeOutcome::*;
    let account = match credentials::resolve_account_credentials_guarded(&row.account_id).await {
        Ok(a) => a,
        Err(e) => {
            let msg = format!("Could not load this account's credentials: {e}");
            return if credentials::GATE.is_blocked() { Wait(msg) } else { Transient(msg) };
        }
    };
    let PooledSessionGuard { mut session, last_selected: _, _permit } = match state.imap_pool.get_priority(&account).await {
        Ok(g) => g,
        Err(e) => return if state.net.note_failure(&e).await { Transient(e) } else { Wait(e) },
    };
    // Capabilities are cached when a session is created: read after checkout.
    let has_move = state.imap_pool.has_capability(&account, "MOVE").await;
    let has_uidplus = state.imap_pool.has_capability(&account, "UIDPLUS").await;
    let moved = async {
        let found = imap::message_id_uids_in(&mut session, &row.snoozed_mailbox, &row.message_id).await?;
        let Some(uid) = snooze::pick_uid(row.uid_in_snoozed, &found) else { return Ok(false) };
        imap::set_flags(&mut session, &row.snoozed_mailbox, uid, &["\\Seen".to_string()], "remove").await?;
        imap::move_uids(&mut session, &row.snoozed_mailbox, &row.from_mailbox, &[uid], has_move, has_uidplus).await?;
        Ok::<bool, String>(true)
    }
    .await;
    let moved = match moved {
        Ok(m) => {
            let guard = PooledSessionGuard { session, last_selected: Some(row.snoozed_mailbox.clone()), _permit };
            state.imap_pool.return_priority(&account, guard).await;
            m
        }
        // The session is dropped, not returned: a failed command can leave
        // unread bytes on it.
        Err(e) => return if state.net.note_failure(&e).await { Transient(e) } else { Wait(e) },
    };
    if !moved {
        info!("[snooze] {} is no longer in {}; nothing to wake", row.id, row.snoozed_mailbox);
        return NotFound;
    }
    announce(state, account, row).await;
    Woken
}

/// Sync the destination and record the change as an IDLE arrival does, so the
/// app's new-mail notification and list refresh fire through their usual path.
async fn announce(state: &Arc<DaemonState>, account: ImapConfig, row: &snooze::Snooze) {
    let sync_account = SyncAccount { id: row.account_id.clone(), email: account.email.clone(), imap_config: account };
    let result = state.sync_engine.sync_account(&sync_account, &row.from_mailbox).await;
    if result.success {
        state.sync_engine.note_change(&row.account_id, &row.from_mailbox, result.arrivals, result.updated_flags);
    } else {
        warn!("[snooze] woke {} but the sync of {} failed: {:?}", row.id, row.from_mailbox, result.error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snooze::WakeOutcome;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn app_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-snooze-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(dir: &Path, id: &str, wake_at: i64) {
        app_db::with(dir, |c| snooze::insert(c, id, "acct", "INBOX", snooze::SNOOZED_MAILBOX, Some(3), "<m@x>", wake_at)).unwrap();
    }

    fn row(dir: &Path, id: &str) -> snooze::Snooze {
        app_db::with(dir, |c| snooze::get(c, id)).unwrap().unwrap()
    }

    /// The daemon was not running at wake time: the first pass after it
    /// starts must wake what is overdue, and only that.
    #[tokio::test]
    async fn an_overdue_row_is_woken_on_the_first_pass_and_a_future_one_is_left() {
        let dir = app_dir();
        seed(&dir, "overdue", 1_000);
        seed(&dir, "future", 9_000_000);
        let calls = AtomicUsize::new(0);
        let out = process_due_with(&dir, 5_000, |r| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(r.id, "overdue");
            async { WakeOutcome::Woken }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out, vec![("overdue".to_string(), WakeOutcome::Woken, "woken".to_string())]);
        assert_eq!(row(&dir, "overdue").state, "woken");
        assert_eq!(row(&dir, "future").state, "snoozed");
    }

    #[tokio::test]
    async fn a_message_no_longer_in_snoozed_ends_the_row_without_an_error() {
        let dir = app_dir();
        seed(&dir, "a", 1_000);
        process_due_with(&dir, 5_000, |_| async { WakeOutcome::NotFound }).await;
        let r = row(&dir, "a");
        assert_eq!(r.state, "woken");
        assert_eq!(r.last_error, "");
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_later_not_on_the_same_pass() {
        let dir = app_dir();
        seed(&dir, "a", 1_000);
        process_due_with(&dir, 5_000, |_| async { WakeOutcome::Transient("server hiccup".into()) }).await;
        let r = row(&dir, "a");
        assert_eq!(r.state, "snoozed");
        assert_eq!(r.attempts, 1);
        let again = process_due_with(&dir, 5_000, |_| async { WakeOutcome::Woken }).await;
        assert!(again.is_empty(), "backing off, not due on the same tick");
        let later = process_due_with(&dir, 5_000 + snooze::backoff_ms(1), |_| async { WakeOutcome::Woken }).await;
        assert_eq!(later.len(), 1);
        assert_eq!(row(&dir, "a").state, "woken");
    }

    /// The real wake against the mock server: found by Message-ID even though
    /// the stored uid is stale, `\Seen` cleared, moved back to INBOX.
    #[tokio::test]
    async fn wake_row_moves_the_message_back_unread() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let raw = "Message-ID: <snz-1@example.com>\r\nFrom: a@example.com\r\nTo: user@example.com\r\nSubject: Later\r\nDate: Fri, 25 Sep 2026 10:00:00 +0000\r\n\r\nbody\r\n";
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(Mailbox::new("Snoozed").push_msg(Message::new(0, raw).with_flags(&["\\Seen"]))),
        );
        let dir = app_dir();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        let creds = dir.join("credentials.json");
        let account = serde_json::json!({
            "id": "acct", "email": "user@example.com", "password": "hunter2",
            "imapHost": server.host(), "imapPort": server.port(),
        })
        .to_string();
        std::fs::write(&creds, serde_json::json!({ "acct": account }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);

        app_db::with(&dir, |c| snooze::insert(c, "a", "acct", "INBOX", "Snoozed", Some(99), "<snz-1@example.com>", 1_000)).unwrap();
        let outcome = wake_row(&state, &row(&dir, "a")).await;

        app_db::with(&dir, |c| snooze::insert(c, "b", "acct", "INBOX", "Snoozed", Some(1), "<gone@example.com>", 1_000)).unwrap();
        let gone = wake_row(&state, &row(&dir, "b")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(outcome, WakeOutcome::Woken);
        let after = server.state();
        assert!(after.find("Snoozed").unwrap().messages.is_empty(), "it must leave Snoozed");
        let inbox = after.find("INBOX").unwrap();
        assert_eq!(inbox.messages.len(), 1, "and land back in INBOX");
        assert!(!inbox.messages[0].has_flag("\\Seen"), "unread");
        assert_eq!(gone, WakeOutcome::NotFound, "a message no longer in Snoozed is not an error");
    }

    /// Locked keychain: the worker waits, the row is never marked failed.
    #[tokio::test]
    async fn locked_credentials_leave_the_row_due_and_unburned() {
        let dir = app_dir();
        seed(&dir, "a", 1_000);
        for _ in 0..(snooze::MAX_ATTEMPTS * 2) {
            process_due_with(&dir, 5_000, |_| async { WakeOutcome::Wait("keychain locked".into()) }).await;
        }
        let r = row(&dir, "a");
        assert_eq!(r.state, "snoozed");
        assert_eq!(r.attempts, 0);
    }
}
