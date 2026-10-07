//! Background worker for follow-up reminders ("remind me if no reply"). Same
//! shape as `snooze_worker.rs`: a catch-up pass over everything already due
//! when the daemon starts, then a sleep until the next remind time or a poke
//! from `handlers::follow_up`.
//!
//! A check looks for a reply three ways, cheapest first: the header cache
//! (any folder but Sent and Drafts, `custody::cache::has_cached_reply`), then
//! a `UID SEARCH` on the server in INBOX and, on Gmail, the `\All` folder.
//! No reply anywhere, it finds the Sent copy by Message-ID: that is the row
//! the app shows at the top of the inbox (`state: due`). Nothing is moved or
//! flagged on the server, so other clients never see the reminder.
//!
//! Graph accounts are not checked: the daemon holds no Graph token (the app
//! refreshes it), and the app does not offer the reminder on one.

use crate::credentials;
use crate::handlers::common::blocking;
use crate::imap::{self, pool::PooledSessionGuard};
use crate::server::DaemonState;
use mailvault_core::app_db::{self, follow_up};
use mailvault_core::custody::cache as sql_cache;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

#[derive(Default)]
pub struct FollowUpState {
    pub notify: tokio::sync::Notify,
    /// Held for a whole worker pass, so two passes never check one row twice.
    pub(crate) lock: tokio::sync::Mutex<()>,
}

impl FollowUpState {
    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

/// Same pacing constants and reasons as `snooze_worker.rs`.
const OFFLINE_POLL: Duration = Duration::from_secs(30);
const MAX_SLEEP: Duration = Duration::from_secs(3600);
const MIN_RETRY_WAIT: Duration = Duration::from_secs(1);
const KEYCHAIN_POLL: Duration = Duration::from_secs(5 * 60);
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub(crate) fn start(state: Arc<DaemonState>) {
    tokio::spawn(async move { run(state).await });
}

async fn run(state: Arc<DaemonState>) {
    info!("[follow-up] worker started");
    loop {
        let online = state.net.is_online();
        let results = if online { pass(&state).await } else { Vec::new() };
        let waited = results.iter().any(|(_, outcome, _)| matches!(outcome, follow_up::Outcome::Wait(_)));
        let wait = if !online || waited { OFFLINE_POLL } else { next_wait(&state) };
        let mut wait = wait.max(MIN_RETRY_WAIT);
        if credentials::GATE.is_blocked() {
            wait = wait.max(KEYCHAIN_POLL);
        }
        tokio::select! {
            _ = state.follow_up.notify.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn next_wait(state: &Arc<DaemonState>) -> Duration {
    match app_db::with(&state.app_dir, follow_up::next_wake_at).ok().flatten() {
        Some(at) if at <= now_ms() => Duration::ZERO,
        Some(at) => Duration::from_millis((at - now_ms()) as u64).min(MAX_SLEEP),
        None => MAX_SLEEP,
    }
}

/// One pass: check every due row, record it, and tell the app about each row
/// that changed state.
async fn pass(state: &Arc<DaemonState>) -> Vec<(String, follow_up::Outcome, String)> {
    let _held = state.follow_up.lock.lock().await;
    let st = Arc::clone(state);
    let results = process_due_with(&state.app_dir, now_ms(), move |row| {
        let st = Arc::clone(&st);
        async move { check_row(&st, &row).await }
    })
    .await;
    for (id, _, row_state) in &results {
        if row_state != "waiting" {
            emit(state, id, row_state);
        }
    }
    results
}

pub(crate) fn emit(state: &Arc<DaemonState>, id: &str, row_state: &str) {
    state.events.emit("follow-up", json!({"id": id, "state": row_state}));
}

/// Run every due row through `check` and record what it came to. Returns
/// `(id, outcome, state afterwards)` per row. `check` is the real IMAP check
/// in the daemon and a stub in tests.
pub(crate) async fn process_due_with<F, Fut>(app_dir: &Path, now: i64, mut check: F) -> Vec<(String, follow_up::Outcome, String)>
where
    F: FnMut(follow_up::FollowUp) -> Fut,
    Fut: std::future::Future<Output = follow_up::Outcome>,
{
    let due = match app_db::with(app_dir, |c| follow_up::due(c, now)) {
        Ok(v) => v,
        Err(e) => {
            warn!("[follow-up] could not read due rows: {e}");
            return Vec::new();
        }
    };
    let mut results = Vec::with_capacity(due.len());
    for row in due {
        let id = row.id.clone();
        let outcome = check(row).await;
        match app_db::with(app_dir, |c| follow_up::record_outcome(c, &id, &outcome, now)) {
            Ok(row_state) => results.push((id, outcome, row_state)),
            Err(e) => warn!("[follow-up] could not record {outcome:?} for {id}: {e}"),
        }
    }
    results
}

/// Record the reminder a scheduled send asked for, once it went out. The
/// Message-ID comes from the bytes that were sent: the SMTP reply's id is
/// the server's queue id, which no reply ever names.
pub(crate) fn record_after_send(
    state: &Arc<DaemonState>,
    account_id: &str,
    raw: &[u8],
    recipients: &str,
    sent_mailbox: Option<&str>,
    remind_days: i64,
) {
    if remind_days <= 0 {
        return;
    }
    // `message_id_in` answers the bare id; rows keep the header as sent.
    let Some(message_id) = mailvault_core::maildir::message_id_in(raw).map(|id| format!("<{id}>")) else {
        warn!("[follow-up] a scheduled send asked for a reminder but its bytes carry no Message-ID");
        return;
    };
    let subject = mailparse::parse_headers(raw)
        .ok()
        .and_then(|(headers, _)| {
            use mailparse::MailHeaderMap;
            headers.get_first_value("Subject")
        })
        .unwrap_or_default();
    let sent_at = now_ms();
    let id = uuid::Uuid::new_v4().to_string();
    let inserted = app_db::with(&state.app_dir, |c| {
        follow_up::insert(c, &id, account_id, &message_id, &subject, recipients, sent_mailbox.unwrap_or(""), sent_at, sent_at + remind_days * DAY_MS)
    });
    match inserted {
        Ok(_) => state.follow_up.wake(),
        Err(e) => warn!("[follow-up] could not record the reminder for a scheduled send: {e}"),
    }
}

/// The account's Sent and Drafts paths from its cached folder list: the
/// folders where the user's own mail sits, which the cache scan skips.
fn own_mail_folders(state: &Arc<DaemonState>, account_id: &str) -> Vec<String> {
    let list = crate::custody::with_conn(state, |c| sql_cache::load_mailboxes(c, account_id))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    ["\\Sent", "\\Drafts"]
        .iter()
        .filter_map(|role| mailvault_core::aliases::mailbox_by_role(&list, role))
        .collect()
}

/// Did a reply already land in the header cache? `None` when the cache could
/// not be read: the server is asked then, never "no reply". One folder per
/// custody lock, so a sync or a click waits for one folder's scan at most.
async fn cached_reply(state: &Arc<DaemonState>, row: &follow_up::FollowUp, own: &str) -> Option<bool> {
    let (st, account_id, message_id, own) = (Arc::clone(state), row.account_id.clone(), row.message_id.clone(), own.to_string());
    blocking(move || {
        let skip = own_mail_folders(&st, &account_id);
        let folders = crate::custody::with_conn(&st, |c| sql_cache::mailboxes_with_headers(c, Some(&account_id)))?;
        for (_, mailbox) in folders.into_iter().filter(|(_, m)| !skip.contains(m)) {
            if crate::custody::with_conn(&st, |c| sql_cache::has_cached_reply(c, &account_id, &mailbox, &message_id, &own))? {
                return Ok(true);
            }
        }
        Ok::<bool, String>(false)
    })
    .await
    .and_then(|r| r)
    .map_err(|e| warn!("[follow-up] header cache unreadable, asking the server: {e}"))
    .ok()
}

/// Look for a reply to one row's message, and failing that for its Sent copy.
pub(crate) async fn check_row(state: &Arc<DaemonState>, row: &follow_up::FollowUp) -> follow_up::Outcome {
    use follow_up::Outcome::*;
    let account = match credentials::resolve_account_credentials_guarded(&row.account_id).await {
        Ok(a) => a,
        Err(e) => {
            let msg = format!("Could not load this account's credentials: {e}");
            return if credentials::GATE.is_blocked() { Wait(msg) } else { Transient(msg) };
        }
    };
    if account.uses_graph() {
        warn!("[follow-up] {} is on a Graph account, which has no reminder check; ending it", row.id);
        return SentCopyGone;
    }
    let own = account.email.clone();
    if cached_reply(state, row, &own).await == Some(true) {
        info!("[follow-up] {} has a reply in the header cache", row.id);
        return Replied;
    }
    let Some(criteria) = imap::reply_search_criteria(&row.message_id, &own) else {
        return SentCopyGone;
    };

    let PooledSessionGuard { mut session, last_selected: _, _permit } = match state.imap_pool.get_background(&account).await {
        Ok(g) => g,
        Err(e) => return if state.net.note_failure(&e).await { Transient(e) } else { Wait(e) },
    };
    let mut selected: Option<String> = None;
    let checked = async {
        let boxes = imap::list_mailboxes(&mut session).await?;
        let mut searched = vec!["INBOX".to_string()];
        if let Some(all) = boxes.iter().find(|m| !m.noselect && imap::has_attr(&m.flags, "All")) {
            if !all.path.eq_ignore_ascii_case("INBOX") {
                searched.push(all.path.clone());
            }
        }
        for mailbox in &searched {
            selected = Some(mailbox.clone());
            if !imap::abd_cmds::uid_search(&mut session, mailbox, &criteria).await?.is_empty() {
                return Ok::<_, String>(Replied);
            }
        }
        let sent = Some(row.sent_mailbox.clone())
            .filter(|m| !m.is_empty())
            .or_else(|| boxes.iter().find(|m| !m.noselect && m.special_use.as_deref() == Some("\\Sent")).map(|m| m.path.clone()));
        let Some(sent) = sent else { return Ok(SentCopyGone) };
        selected = Some(sent.clone());
        let found = imap::message_id_uids_in(&mut session, &sent, &row.message_id).await?;
        Ok(match found.iter().copied().max() {
            Some(uid) => NoReply { sent_mailbox: sent, sent_uid: uid },
            None => SentCopyGone,
        })
    }
    .await;
    match checked {
        Ok(outcome) => {
            let guard = PooledSessionGuard { session, last_selected: selected, _permit };
            state.imap_pool.return_background(&account, guard).await;
            info!("[follow-up] {} checked: {outcome:?}", row.id);
            outcome
        }
        // The session is dropped, not returned: a failed command can leave
        // unread bytes on it.
        Err(e) => {
            if state.net.note_failure(&e).await {
                Transient(e)
            } else {
                Wait(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use follow_up::Outcome;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn app_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-follow-up-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(dir: &Path, id: &str, message_id: &str, remind_at: i64) {
        app_db::with(dir, |c| follow_up::insert(c, id, "acct", message_id, "Quote", "ana@example.com", "", 1_000, remind_at)).unwrap();
    }

    fn row(dir: &Path, id: &str) -> follow_up::FollowUp {
        app_db::with(dir, |c| follow_up::get(c, id)).unwrap().unwrap()
    }

    /// The daemon was not running at remind time: the first pass after it
    /// starts checks what is overdue, and only that.
    #[tokio::test]
    async fn an_overdue_row_is_checked_on_the_first_pass_and_a_future_one_is_left() {
        let dir = app_dir();
        seed(&dir, "overdue", "<o@x>", 1_000);
        seed(&dir, "future", "<f@x>", 9_000_000);
        let calls = AtomicUsize::new(0);
        let out = process_due_with(&dir, 5_000, |r| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(r.id, "overdue");
            async { Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: 4 } }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].2, "due");
        assert_eq!(row(&dir, "overdue").sent_uid, Some(4));
        assert_eq!(row(&dir, "future").state, "waiting");
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_later_and_a_wait_never_burns_a_try() {
        let dir = app_dir();
        seed(&dir, "a", "<a@x>", 1_000);
        process_due_with(&dir, 5_000, |_| async { Outcome::Transient("server hiccup".into()) }).await;
        assert_eq!(row(&dir, "a").attempts, 1);
        assert!(process_due_with(&dir, 5_000, |_| async { Outcome::Replied }).await.is_empty(), "backing off");
        for _ in 0..(follow_up::MAX_ATTEMPTS * 2) {
            process_due_with(&dir, 5_000 + follow_up::backoff_ms(1), |_| async { Outcome::Wait("offline".into()) }).await;
        }
        let r = row(&dir, "a");
        assert_eq!((r.state.as_str(), r.attempts), ("waiting", 1));
        process_due_with(&dir, 5_000 + follow_up::backoff_ms(1), |_| async { Outcome::Replied }).await;
        assert_eq!(row(&dir, "a").state, "replied");
    }

    fn rig(server: &mock_imap::MockImap) -> (std::path::PathBuf, Arc<DaemonState>) {
        let dir = app_dir();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        let creds = dir.join("credentials.json");
        let account = serde_json::json!({
            "id": "acct", "email": "me@example.com", "password": "hunter2",
            "imapHost": server.host(), "imapPort": server.port(),
        })
        .to_string();
        std::fs::write(&creds, serde_json::json!({ "acct": account }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        (dir, state)
    }

    fn eml(message_id: &str, from: &str, extra: &str) -> String {
        format!(
            "Message-ID: {message_id}\r\nFrom: {from}\r\nTo: x@example.com\r\nSubject: Re: Quote\r\n{extra}Date: Fri, 02 Oct 2026 10:00:00 +0000\r\n\r\nbody\r\n"
        )
    }

    /// Against the mock server: a reply from someone else in INBOX ends the
    /// row; my own follow-up in the same thread does not; with no reply, the
    /// Sent copy is found by Message-ID (the newest uid); a Sent copy deleted
    /// elsewhere ends the row quietly. Nothing on the server is changed.
    #[tokio::test]
    async fn check_row_finds_a_reply_or_the_sent_copy_on_the_server() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(
                    Mailbox::new("INBOX")
                        .push_msg(Message::new(0, eml("<r1@ana>", "ana@example.com", "In-Reply-To: <answered@me>\r\n")))
                        .push_msg(Message::new(0, eml("<mine@me>", "Me <me@example.com>", "In-Reply-To: <silent@me>\r\n"))),
                )
                .mailbox(
                    Mailbox::new("Sent")
                        .with_attrs(&["\\HasNoChildren", "\\Sent"])
                        .push_msg(Message::new(0, eml("<silent@me>", "me@example.com", "")).with_flags(&["\\Seen"]))
                        .push_msg(Message::new(0, eml("<answered@me>", "me@example.com", "")).with_flags(&["\\Seen"])),
                ),
        );
        let (dir, state) = rig(&server);
        seed(&dir, "answered", "<answered@me>", 1_000);
        seed(&dir, "silent", "<silent@me>", 1_000);
        seed(&dir, "gone", "<gone@me>", 1_000);
        let answered = check_row(&state, &row(&dir, "answered")).await;
        let silent = check_row(&state, &row(&dir, "silent")).await;
        let gone = check_row(&state, &row(&dir, "gone")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(answered, Outcome::Replied);
        let sent_uid = server.state().find("Sent").unwrap().messages[0].uid;
        assert_eq!(silent, Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid }, "my own follow-up is no reply");
        assert_eq!(gone, Outcome::SentCopyGone);
        assert_eq!(server.count_commands("STORE") + server.count_commands("MOVE") + server.count_commands("APPEND"), 0);
    }

    /// Gmail files a reply under All Mail when a filter skips the inbox: the
    /// `\All` folder is searched too.
    #[tokio::test]
    async fn a_reply_in_the_all_mail_folder_counts() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(
                    Mailbox::new("[Gmail]/All Mail")
                        .with_attrs(&["\\HasNoChildren", "\\All"])
                        .push_msg(Message::new(0, eml("<r@ana>", "ana@example.com", "References: <root@x> <q@me>\r\n"))),
                )
                .mailbox(Mailbox::new("[Gmail]/Sent Mail").with_attrs(&["\\HasNoChildren", "\\Sent"])),
        );
        let (dir, state) = rig(&server);
        seed(&dir, "a", "<q@me>", 1_000);
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert_eq!(outcome, Outcome::Replied);
    }

    /// A reply already in the header cache (here in Trash: deleted, still a
    /// reply) answers without a server search; one cached in Sent does not.
    #[tokio::test]
    async fn a_reply_in_the_header_cache_answers_before_the_server() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(
                Mailbox::new("Sent")
                    .with_attrs(&["\\HasNoChildren", "\\Sent"])
                    .push_msg(Message::new(0, eml("<c@me>", "me@example.com", ""))),
            ),
        );
        let (dir, state) = rig(&server);
        crate::custody::open_into(&state).expect("custody opens");
        crate::custody::with_conn(&state, |c| {
            sql_cache::save_mailboxes(c, "acct", &json!({"mailboxes": [{"path": "Sent", "specialUse": "\\Sent", "children": []}]}).to_string())?;
            sql_cache::save_headers(c, "acct", "Sent", &json!({"emails": [{"uid": 9, "inReplyTo": "<c@me>", "from": {"address": "ana@example.com"}}]}).to_string())
        })
        .unwrap();
        seed(&dir, "a", "<c@me>", 1_000);
        let before = server.count_commands("SEARCH");
        let skipped_sent = check_row(&state, &row(&dir, "a")).await;
        crate::custody::with_conn(&state, |c| {
            sql_cache::save_headers(c, "acct", "Trash", &json!({"emails": [{"uid": 3, "inReplyTo": "<c@me>", "from": {"address": "ana@example.com"}}]}).to_string())
        })
        .unwrap();
        let searches = server.count_commands("SEARCH");
        let cached = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert!(matches!(skipped_sent, Outcome::NoReply { .. }), "a reply cached in Sent is not one: {skipped_sent:?}");
        assert!(searches > before, "that check asked the server");
        assert_eq!(cached, Outcome::Replied);
        assert_eq!(server.count_commands("SEARCH"), searches, "the cache answered: no server search");
    }

    /// Locked keychain: the worker waits, the row is never marked failed.
    #[tokio::test]
    async fn locked_credentials_leave_the_row_due_and_unburned() {
        let dir = app_dir();
        seed(&dir, "a", "<a@x>", 1_000);
        for _ in 0..(follow_up::MAX_ATTEMPTS * 2) {
            process_due_with(&dir, 5_000, |_| async { Outcome::Wait("keychain locked".into()) }).await;
        }
        let r = row(&dir, "a");
        assert_eq!(r.state, "waiting");
        assert_eq!(r.attempts, 0);
    }

    #[tokio::test]
    async fn a_pass_tells_the_app_about_each_row_that_changed_state() {
        let dir = app_dir();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        seed(&dir, "a", "<a@x>", 1_000);
        let mut events = state.events.subscribe();
        let results = process_due_with(&dir, 5_000, |_| async { Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: 2 } }).await;
        for (id, _, row_state) in &results {
            emit(&state, id, row_state);
        }
        let line = events.try_recv().expect("the change is announced");
        assert_eq!(
            mailvault_core::daemon_ipc::parse_event(&line),
            Some(("follow-up".to_string(), json!({"id": "a", "state": "due"})))
        );
    }

    /// A scheduled send's reminder is keyed on the Message-ID in the bytes it
    /// sent, with the subject decoded from them.
    #[tokio::test]
    async fn a_scheduled_send_records_its_reminder_from_the_sent_bytes() {
        let dir = app_dir();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        let raw = b"Message-ID: <sched-1@me>\r\nSubject: =?UTF-8?Q?Caf=C3=A9?=\r\nFrom: me@example.com\r\n\r\nbody\r\n";
        record_after_send(&state, "acct", raw, "ana@example.com", Some("Sent"), 3);
        record_after_send(&state, "acct", b"Subject: no id\r\n\r\nbody\r\n", "ana@example.com", Some("Sent"), 3);
        record_after_send(&state, "acct", b"Message-ID: <off@me>\r\n\r\nbody\r\n", "ana@example.com", Some("Sent"), 0);
        let rows = app_db::with(&dir, |c| follow_up::list(c, None)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id, "<sched-1@me>");
        assert_eq!(rows[0].subject, "Café");
        assert_eq!(rows[0].recipients, "ana@example.com");
        assert_eq!(rows[0].sent_mailbox, "Sent");
        assert_eq!(rows[0].remind_at - rows[0].sent_at, 3 * DAY_MS);
    }
}
