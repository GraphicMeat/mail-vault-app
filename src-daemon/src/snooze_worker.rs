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
//! A local snooze (`snoozed_mailbox` empty: the server would not host the
//! folder) moved nothing, so its wake only clears `\Seen` where the message
//! is. That sync sees no arrival, so the app raises the notification itself
//! off the `snooze` event's `woke`.
//!
//! Graph accounts are not handled here: the wake moves over IMAP only. The
//! app does not offer Snooze on a Graph account.
//!
//! A JMAP account's wake (`wake_row_jmap`) never reaches the IMAP pool: the
//! message is found by its exact Message-ID in the holder, `$seen` comes off,
//! and the move back is one `mailboxIds` patch (the Snoozed label off, the
//! origin's on).

use crate::credentials;
use crate::imap::{self, pool::PooledSessionGuard, ImapConfig};
use crate::server::DaemonState;
use crate::sync_engine::SyncAccount;
use mailvault_core::app_db::{self, snooze};
use mailvault_core::jmap::SetOutcome;
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
        let results = if online { pass(&state).await } else { Vec::new() };
        // A `Wait` leaves its row due; without a floor the loop would spin on
        // it until the network or the keychain comes back.
        let waited = results.iter().any(|(_, outcome, _)| matches!(outcome, snooze::WakeOutcome::Wait(_)));
        // Floored always, not only after a pass that recorded something: a row
        // whose outcome could not be written (disk full) stays due, is not in
        // `results`, and would otherwise be searched for as fast as the loop runs.
        let wait = if !online || waited { OFFLINE_POLL } else { next_wait(&state) };
        let mut wait = wait.max(MIN_RETRY_WAIT);
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

/// One pass: wake every due row, record it, and tell the app.
async fn pass(state: &Arc<DaemonState>) -> Vec<(String, snooze::WakeOutcome, String)> {
    let _held = state.snooze.lock.lock().await;
    let st = Arc::clone(state);
    let results = process_due_with(&state.app_dir, now_ms(), move |row| {
        let st = Arc::clone(&st);
        async move { wake_row(&st, &row, true).await }
    })
    .await;
    for (id, outcome, row_state) in &results {
        emit(state, id, row_state, *outcome == snooze::WakeOutcome::Woken);
    }
    results
}

/// `woke`: this pass brought the message back at its time; not an unsnooze
/// the user asked for, not a message that was gone. The app announces a local
/// snooze's wake off it: that wake only clears `\Seen`, so no sync reports
/// it as an arrival.
pub(crate) fn emit(state: &Arc<DaemonState>, id: &str, row_state: &str, woke: bool) {
    state.events.emit("snooze", json!({"id": id, "state": row_state, "woke": woke}));
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
        match app_db::with(app_dir, |c| snooze::record_outcome(c, &id, &outcome, now)) {
            Ok(row_state) => results.push((id, outcome, row_state)),
            Err(e) => warn!("[snooze] could not record {outcome:?} for {id}: {e}"),
        }
    }
    results
}

/// Move one row's message back where it came from, unread. Also what
/// `snooze.cancel` calls to unsnooze now, so "now" is never a second path.
/// The caller holds `SnoozeState::lock`.
///
/// `background`: the timed wake runs on the pool's background lane, so a
/// batch of rows falling due never queues the message the user clicks; an
/// unsnooze the user asked for stays on the priority lane.
pub(crate) async fn wake_row(state: &Arc<DaemonState>, row: &snooze::Snooze, background: bool) -> snooze::WakeOutcome {
    use snooze::WakeOutcome::*;
    let account = match crate::oauth_tokens::resolve(state, &row.account_id, crate::oauth_tokens::Read::Guarded).await {
        Ok(a) => a,
        Err(e) => {
            let msg = format!("Could not load this account's credentials: {e}");
            return if credentials::GATE.is_blocked() { Wait(msg) } else { Transient(msg) };
        }
    };
    if account.uses_jmap() {
        return wake_row_jmap(state, account, row).await;
    }
    let checkout = if background {
        state.imap_pool.get_background(&account).await
    } else {
        state.imap_pool.get_priority(&account).await
    };
    let PooledSessionGuard { mut session, last_selected: _, _permit } = match checkout {
        Ok(g) => g,
        Err(e) => return if state.net.note_failure(&e).await { Transient(e) } else { Wait(e) },
    };
    // Capabilities are cached when a session is created: read after checkout.
    let has_move = state.imap_pool.has_capability(&account, "MOVE").await;
    let has_uidplus = state.imap_pool.has_capability(&account, "UIDPLUS").await;
    // A local snooze (no Snoozed folder on the server) never moved the
    // message: it is marked unread where it is. No MOVE into its own folder,
    // which real servers do not treat as a no-op.
    let local = row.snoozed_mailbox.is_empty();
    let holder = if local { &row.from_mailbox } else { &row.snoozed_mailbox };
    let moved = async {
        let found = imap::message_id_uids_in(&mut session, holder, &row.message_id).await?;
        let Some(uid) = snooze::pick_uid(row.uid_in_snoozed, &found) else { return Ok(false) };
        imap::set_flags(&mut session, holder, uid, &["\\Seen".to_string()], "remove").await?;
        if !local {
            imap::move_uids(&mut session, holder, &row.from_mailbox, &[uid], has_move, has_uidplus).await?;
        }
        Ok::<bool, String>(true)
    }
    .await;
    let moved = match moved {
        Ok(m) => {
            let guard = PooledSessionGuard { session, last_selected: Some(holder.clone()), _permit };
            if background {
                state.imap_pool.return_background(&account, guard).await;
            } else {
                state.imap_pool.return_priority(&account, guard).await;
            }
            m
        }
        // The session is dropped, not returned: a failed command can leave
        // unread bytes on it.
        Err(e) => return if state.net.note_failure(&e).await { Transient(e) } else { Wait(e) },
    };
    if !moved {
        info!("[snooze] {} is no longer in {}; nothing to wake", row.id, holder);
        return NotFound;
    }
    announce(state, account, row).await;
    Woken
}

/// `wake_row` for a JMAP account (`uses_jmap`), on the account's session: the
/// email in the holder whose Message-ID is the row's (the stored uid is
/// preferred when that search confirms it), `$seen` removed, and unless the snooze was local one `mailboxIds`
/// patch moving it back. No such email, or one the server no longer has:
/// `NotFound`. Then the same sync and record as the IMAP wake.
async fn wake_row_jmap(state: &Arc<DaemonState>, account: ImapConfig, row: &snooze::Snooze) -> snooze::WakeOutcome {
    use snooze::WakeOutcome::*;
    let local = row.snoozed_mailbox.is_empty();
    let holder = if local { &row.from_mailbox } else { &row.snoozed_mailbox };
    let woke = async {
        let acct = state.jmap.get(&account).await.map_err(|e| e.to_string())?;
        let boxes = acct.current().await.map_err(|e| e.to_string())?;
        let Some(holder_id) = boxes.ids.get(holder.as_str()).cloned() else { return Ok(false) };
        let found = crate::handlers::jmap_bridge::emails_with_message_id(&acct.client, Some(&holder_id), &row.message_id)
            .await
            .map_err(|e| e.to_string())?;
        // The stored uid wins when the Message-ID search confirms it (a
        // duplicate copy of the same message may sit next to it), as
        // `snooze::pick_uid` does for IMAP: its email id through the holder's
        // ledger, re-checked to still be in the holder. Otherwise the newest.
        let stored = match row.uid_in_snoozed {
            Some(uid) => acct.uid_to_id(state, &row.account_id, holder, &[uid], true).await?.into_iter().find_map(|(_, id)| id),
            None => None,
        };
        let Some(email_id) = stored.filter(|id| found.contains(id)).or_else(|| found.first().cloned()) else { return Ok(false) };
        // The origin is resolved before the first write: a message must not
        // be left unread in the holder because the move back cannot be made.
        let from_id = if local {
            None
        } else {
            Some(boxes.ids.get(&row.from_mailbox).cloned().ok_or_else(|| format!("E_JMAP_PROTOCOL: no mailbox {}", row.from_mailbox))?)
        };
        let unread = acct.client.set_keywords(&[(email_id.clone(), vec![("$seen".to_string(), false)])]).await.map_err(|e| e.to_string())?;
        if !landed(&unread, &email_id)? {
            return Ok(false);
        }
        if let Some(from_id) = from_id {
            let back = acct
                .client
                .set_mailboxes(&[(email_id.clone(), vec![(holder_id, false), (from_id, true)])])
                .await
                .map_err(|e| e.to_string())?;
            if !landed(&back, &email_id)? {
                return Ok(false);
            }
        }
        Ok::<bool, String>(true)
    }
    .await;
    match woke {
        Ok(true) => {
            announce(state, account, row).await;
            Woken
        }
        Ok(false) => {
            info!("[snooze] {} is no longer in {}; nothing to wake", row.id, holder);
            NotFound
        }
        Err(e) => {
            if state.net.note_failure(&e).await {
                Transient(e)
            } else {
                Wait(e)
            }
        }
    }
}

/// Did an `Email/set` apply to `email_id`? `false` when the server no longer
/// has it (`notFound`); any other refusal is an error to retry.
fn landed(out: &SetOutcome, email_id: &str) -> Result<bool, String> {
    if out.ok.iter().any(|id| id == email_id) {
        return Ok(true);
    }
    match out.failed.iter().find(|(id, _)| id == email_id) {
        Some((_, kind)) if kind == "notFound" => Ok(false),
        Some((_, kind)) => Err(format!("E_JMAP_METHOD: {kind}: the server refused the wake of {email_id}")),
        None => Err("E_JMAP_PROTOCOL: Email/set did not answer for the email".to_string()),
    }
}

/// Sync the destination and record the change as an IDLE arrival does, so the
/// app's new-mail notification and list refresh fire through their usual path.
async fn announce(state: &Arc<DaemonState>, account: ImapConfig, row: &snooze::Snooze) {
    // A local snooze moved nothing: the app announces that wake itself off
    // the `snooze` event's `woke`, so the sync must not count it too.
    let jmap_moved = account.uses_jmap() && !row.snoozed_mailbox.is_empty();
    let sync_account = SyncAccount { id: row.account_id.clone(), email: account.email.clone(), imap_config: account };
    let result = state.sync_engine.sync_account(&sync_account, &row.from_mailbox).await;
    if result.success {
        publish_woken(&state.sync_engine, &row.account_id, &row.from_mailbox, &result, jmap_moved);
    } else {
        warn!("[snooze] woke {} but the sync of {} failed: {:?}", row.id, row.from_mailbox, result.error);
    }
}

/// Record a woken message's sync as a change. `sync_account` does not
/// announce, but a JMAP sync publishes the arrivals itself (`announced`), so
/// only the unannounced ones are noted here, as `idle_watch.rs` does.
/// `jmap_moved`: the wake was a JMAP account's own move back (not a local
/// snooze), which its sync does not see as an arrival.
fn publish_woken(engine: &crate::sync_engine::SyncEngine, account_id: &str, mailbox: &str, result: &crate::sync_engine::SyncResult, jmap_moved: bool) {
    // A JMAP wake is the daemon's own move, which its sync does not count as
    // an arrival: when the sync announced nothing, the woken message is the
    // one new-mail notification (an IMAP wake's sync sees the move itself).
    let unannounced = if result.announced { 0 } else { result.arrivals.max(usize::from(jmap_moved)) };
    engine.note_change(account_id, mailbox, unannounced, result.updated_flags);
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
        let outcome = wake_row(&state, &row(&dir, "a"), true).await;

        app_db::with(&dir, |c| snooze::insert(c, "b", "acct", "INBOX", "Snoozed", Some(1), "<gone@example.com>", 1_000)).unwrap();
        let gone = wake_row(&state, &row(&dir, "b"), true).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(outcome, WakeOutcome::Woken);
        let after = server.state();
        assert!(after.find("Snoozed").unwrap().messages.is_empty(), "it must leave Snoozed");
        let inbox = after.find("INBOX").unwrap();
        assert_eq!(inbox.messages.len(), 1, "and land back in INBOX");
        assert!(!inbox.messages[0].has_flag("\\Seen"), "unread");
        assert_eq!(gone, WakeOutcome::NotFound, "a message no longer in Snoozed is not an error");
    }

    /// A local snooze (no Snoozed folder, `snoozed_mailbox` empty) never
    /// moved the message: its wake marks it unread where it is and moves
    /// nothing, since a MOVE into its own folder is not a no-op on a real
    /// server. The event says which rows the pass woke: the app announces a
    /// local wake off it, and a message that was gone is no news. The header
    /// cache says unread too before the event goes out: the app marks its row
    /// unread off the event, and every repaint from the cache must agree.
    #[tokio::test]
    async fn a_pass_wakes_a_local_snooze_unread_where_it_is() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let raw = "Message-ID: <snz-local@example.com>\r\nFrom: a@example.com\r\nTo: user@example.com\r\nSubject: Later\r\nDate: Fri, 25 Sep 2026 10:00:00 +0000\r\n\r\nbody\r\n";
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(Message::new(0, raw).with_flags(&["\\Seen"]))),
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

        let uid = server.state().find("INBOX").unwrap().messages[0].uid;
        // The list was read before the snooze: the cache holds the message read.
        let sync_account: SyncAccount = serde_json::from_value(json!({
            "id": "acct", "email": "user@example.com",
            "imapConfig": { "email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port() },
        }))
        .unwrap();
        assert!(state.sync_engine.sync_account(&sync_account, "INBOX").await.success);
        let cached_seen = || {
            let db = state.sync_engine.custody_db().expect("the header cache is open");
            let guard = db.lock().unwrap_or_else(|p| p.into_inner());
            let rows = mailvault_core::custody::cache::load_by_uids(guard.as_ref().expect("store is open"), "acct", "INBOX", &[uid]).unwrap();
            rows[0]["flags"].as_array().unwrap().iter().any(|f| f == "\\Seen")
        };
        assert!(cached_seen(), "cached read before the wake");
        app_db::with(&dir, |c| {
            snooze::insert(c, "l", "acct", "INBOX", "", Some(uid), "<snz-local@example.com>", 1_000)?;
            snooze::insert(c, "gone", "acct", "INBOX", "", None, "<gone@example.com>", 2_000)
        })
        .unwrap();
        let mut events = state.events.subscribe();
        let results = pass(&state).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(!cached_seen(), "the wake's sync patched the cached row unread");

        let outcomes: Vec<_> = results.iter().map(|(id, outcome, _)| (id.as_str(), outcome.clone())).collect();
        assert_eq!(outcomes, vec![("l", WakeOutcome::Woken), ("gone", WakeOutcome::NotFound)]);
        let inbox = server.state().find("INBOX").unwrap().clone();
        assert_eq!(inbox.messages.len(), 1, "still in INBOX");
        assert_eq!(inbox.messages[0].uid, uid, "the same message, never moved");
        assert!(!inbox.messages[0].has_flag("\\Seen"), "unread");
        assert_eq!(server.count_commands("MOVE") + server.count_commands("COPY"), 0, "nothing is moved");

        let mut sent = Vec::new();
        while let Ok(line) = events.try_recv() {
            if let Some((name, payload)) = mailvault_core::daemon_ipc::parse_event(&line) {
                if name == "snooze" {
                    sent.push(payload);
                }
            }
        }
        assert_eq!(
            sent,
            vec![
                json!({"id": "l", "state": "woken", "woke": true}),
                json!({"id": "gone", "state": "woken", "woke": false}),
            ]
        );
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

    fn sync_result(arrivals: usize, announced: bool) -> crate::sync_engine::SyncResult {
        crate::sync_engine::SyncResult {
            account_id: "acct".into(),
            mailbox: "INBOX".into(),
            new_emails: arrivals,
            arrivals,
            updated_flags: 0,
            total_emails: 10,
            success: true,
            error: None,
            offline: false,
            error_code: None,
            arrival_uids: Vec::new(),
            announced,
        }
    }

    /// A JMAP sync has already published its arrivals (`announced`): the wake
    /// must not publish them a second time. An IMAP sync (`announced` false)
    /// still publishes them here.
    #[tokio::test]
    async fn a_woken_sync_publishes_each_arrival_once() {
        let dir = app_dir();
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let gen0 = state.sync_engine.change_gen();
        // JMAP: already published by the sync, so the wake adds no arrivals.
        publish_woken(&state.sync_engine, "acct", "INBOX", &sync_result(2, true), true);
        // IMAP: the wake is the only publisher.
        publish_woken(&state.sync_engine, "acct", "INBOX", &sync_result(3, false), false);
        let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
        let announced: usize = records.iter().map(|r| r.new_emails).sum();
        assert_eq!(announced, 3, "{records:?}");
    }

    /// The wake of a JMAP account's own move is no arrival to its sync (the
    /// daemon's ids do not count), so the sync announces nothing: the woken
    /// message itself is the one new-mail notification. An IMAP wake whose sync
    /// saw nothing adds none, and a JMAP sync that did announce adds none twice.
    #[tokio::test]
    async fn a_jmap_wake_with_nothing_announced_counts_the_woken_message_once() {
        let dir = app_dir();
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let gen0 = state.sync_engine.change_gen();
        publish_woken(&state.sync_engine, "acct", "INBOX", &sync_result(0, false), true);
        publish_woken(&state.sync_engine, "acct", "INBOX", &sync_result(0, false), false);
        publish_woken(&state.sync_engine, "acct", "INBOX", &sync_result(1, true), true);
        let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
        let announced: usize = records.iter().map(|r| r.new_emails).sum();
        assert_eq!(announced, 1, "{records:?}");
    }

    /// A JMAP account's wake (Task 9c): found in Snoozed by its Message-ID
    /// (the stored uid is stale), `$seen` removed, moved back with one
    /// `mailboxIds` patch, and no IMAP dialled. A message no longer there is
    /// `NotFound`, not an error.
    #[tokio::test]
    async fn jmap_wake_row_moves_the_message_back_unread_by_mailbox_ids() {
        use crate::jmap_test_support as support;
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut scenario = support::scenario();
        let mut later = support::email("s1", "later", "2026-10-03T10:00:00Z");
        later.keywords = vec!["$seen".into()];
        scenario.accounts[0].mailboxes.push(mock_jmap::ScenarioMailbox {
            id: "mb-snoozed".into(),
            name: "Snoozed".into(),
            parent_id: None,
            role: None,
            emails: vec![later],
        });
        let m = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = support::imap_trap();
        let dir = app_dir();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        let creds = dir.join("credentials.json");
        std::fs::write(&creds, json!({ "acct1": support::account_json(&m, port).to_string() }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);

        app_db::with(&dir, |c| snooze::insert(c, "a", "acct1", "INBOX", "Snoozed", Some(99), "<s1@x>", 1_000)).unwrap();
        let outcome = wake_row(&state, &row(&dir, "a"), true).await;
        app_db::with(&dir, |c| snooze::insert(c, "b", "acct1", "INBOX", "Snoozed", Some(1), "<gone@x>", 1_000)).unwrap();
        let gone = wake_row(&state, &row(&dir, "b"), true).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(outcome, WakeOutcome::Woken);
        let s1 = m.read(|s| s.email("acc1", "s1").cloned()).expect("s1 still exists");
        assert_eq!(s1.mailbox_ids, support::set(&["mb-inbox"]), "out of Snoozed, back in the inbox");
        assert!(!s1.keywords.contains("$seen"), "unread");
        assert_eq!(gone, WakeOutcome::NotFound);
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// The JMAP wake with `snoozed` holding the given emails; a server, a
    /// daemon state and credentials for `acct1`. The caller removes the env.
    fn jmap_wake_setup(snoozed: Vec<mock_jmap::ScenarioEmail>) -> (mock_jmap::MockJmap, std::net::TcpListener, std::path::PathBuf, Arc<DaemonState>) {
        use crate::jmap_test_support as support;
        let mut scenario = support::scenario();
        scenario.accounts[0].mailboxes.push(mock_jmap::ScenarioMailbox {
            id: "mb-snoozed".into(),
            name: "Snoozed".into(),
            parent_id: None,
            role: None,
            emails: snoozed,
        });
        let m = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = support::imap_trap();
        let dir = app_dir();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        let creds = dir.join("credentials.json");
        std::fs::write(&creds, json!({ "acct1": support::account_json(&m, port).to_string() }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        (m, trap, dir, state)
    }

    /// Two copies of one Message-ID sit in Snoozed: the wake takes the one
    /// the row's stored uid names through the Snoozed ledger (as
    /// `snooze::pick_uid` prefers the stored uid on IMAP), not the newest.
    #[tokio::test]
    async fn jmap_wake_row_prefers_the_stored_uid_over_the_newest_copy() {
        use crate::jmap_test_support as support;
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let copy = |id: &str, received: &str| {
            let mut e = support::email(id, "dup", received);
            e.raw = e.raw.replace(&format!("<{id}@x>"), "<dup@x>");
            e.keywords = vec!["$seen".into()];
            e
        };
        let (m, trap, dir, state) = jmap_wake_setup(vec![copy("old", "2026-10-03T10:00:00Z"), copy("new", "2026-10-04T10:00:00Z")]);
        let ledger = crate::jmap_sessions::jmap_ledger_path(&dir, "acct1", "Snoozed");
        std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        std::fs::write(&ledger, br#"{"5":"old","6":"new"}"#).unwrap();

        app_db::with(&dir, |c| snooze::insert(c, "a", "acct1", "INBOX", "Snoozed", Some(5), "<dup@x>", 1_000)).unwrap();
        let outcome = wake_row(&state, &row(&dir, "a"), true).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(outcome, WakeOutcome::Woken);
        let old = m.read(|s| s.email("acc1", "old").cloned()).expect("old");
        let new = m.read(|s| s.email("acc1", "new").cloned()).expect("new");
        assert_eq!(old.mailbox_ids, support::set(&["mb-inbox"]), "the stored uid's copy went back");
        assert!(!old.keywords.contains("$seen"));
        assert_eq!(new.mailbox_ids, support::set(&["mb-snoozed"]), "the newer copy stayed");
        assert!(new.keywords.contains("$seen"), "and stayed read");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// An origin mailbox the account no longer has: nothing is written. The
    /// message is not left unread in Snoozed with no way back.
    #[tokio::test]
    async fn jmap_wake_row_with_a_missing_origin_writes_nothing() {
        use crate::jmap_test_support as support;
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut s1 = support::email("s1", "later", "2026-10-03T10:00:00Z");
        s1.keywords = vec!["$seen".into()];
        let (m, trap, dir, state) = jmap_wake_setup(vec![s1]);

        app_db::with(&dir, |c| snooze::insert(c, "a", "acct1", "Deleted Folder", "Snoozed", None, "<s1@x>", 1_000)).unwrap();
        let outcome = wake_row(&state, &row(&dir, "a"), true).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert!(matches!(outcome, WakeOutcome::Transient(_) | WakeOutcome::Wait(_)), "{outcome:?}");
        let s1 = m.read(|s| s.email("acc1", "s1").cloned()).expect("s1");
        assert!(s1.keywords.contains("$seen"), "keywords untouched");
        assert_eq!(s1.mailbox_ids, support::set(&["mb-snoozed"]), "still in Snoozed");
        assert_eq!(m.count_calls("Email/set"), 0, "no write at all");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }
}
