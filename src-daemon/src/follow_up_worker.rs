//! Background worker for follow-up reminders ("remind me if no reply"). Same
//! shape as `snooze_worker.rs`: a catch-up pass over everything already due
//! when the daemon starts, then a sleep until the next remind time or a poke
//! from `handlers::follow_up`.
//!
//! A check looks for a reply in two places, and either one is enough:
//!
//! 1. The header cache, first: no network, and it holds mail the server's
//!    search may not reach (a folder the server will not search, a reply the
//!    user moved anywhere). Every cached folder of the account but Sent and
//!    Drafts, one bounded page per custody lock (`custody::cache::
//!    reply_scan_page`), yielding to foreground reads between pages. A cached
//!    row is no answer when it is from one of the row's own addresses, or
//!    marked automatic (`autoReply`, fetched with the headers since this
//!    check exists) or titled like one (`AUTO_REPLY_SUBJECT_PREFIXES`, for
//!    rows cached before that).
//! 2. The server: `UID SEARCH` with `imap::reply_search_criteria` (names the
//!    message, from none of the own addresses, no automatic reply) in INBOX
//!    and the special-use `\All`, `\Archive` and `\Trash` folders that exist.
//!    A folder or a search the server turns away is passed over: with every
//!    one refused the cache's answer stands, rather than the row spending its
//!    tries on a server that will not search. Offline still waits.
//!
//! No reply anywhere, it finds the Sent copy by Message-ID: that is the
//! message the app pins above the inbox (`state: due`). Nothing is moved or
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
    own_addresses: &[String],
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
        follow_up::insert(c, &id, account_id, &message_id, &subject, recipients, sent_mailbox.unwrap_or(""), own_addresses, sent_at, sent_at + remind_days * DAY_MS)
    });
    match inserted {
        Ok(_) => state.follow_up.wake(),
        Err(e) => warn!("[follow-up] could not record the reminder for a scheduled send: {e}"),
    }
}

/// Cached rows read per custody lock by the reply scan: a page, then the lock
/// goes and foreground reads go first.
const REPLY_SCAN_PAGE: u32 = 500;

/// The account's Sent and Drafts paths as its cached folder list names them;
/// `imap::is_own_mail_path` covers a folder the list does not.
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

/// Does the header cache already hold an answer to `message_id`? Every cached
/// folder of the account but Sent and Drafts, page by page, one custody lock
/// per page. A cache that cannot be read answers no: the server is asked too.
async fn cached_reply(state: &Arc<DaemonState>, account_id: &str, message_id: &str, own: &[String]) -> bool {
    let st = Arc::clone(state);
    let account = account_id.to_string();
    let folders = blocking(move || {
        let skip = own_mail_folders(&st, &account);
        crate::custody::with_conn(&st, |c| sql_cache::mailboxes_with_headers(c, Some(&account))).map(|all| {
            all.into_iter()
                .map(|(_, mailbox)| mailbox)
                .filter(|m| !skip.contains(m) && !imap::is_own_mail_path(m))
                .collect::<Vec<_>>()
        })
    })
    .await
    .and_then(|r| r);
    let folders = match folders {
        Ok(f) => f,
        Err(e) => {
            warn!("[follow-up] header cache unreadable, asking the server alone: {e}");
            return false;
        }
    };
    for mailbox in folders {
        let mut after = 0u32;
        loop {
            let (st, account, mb, id, own) = (Arc::clone(state), account_id.to_string(), mailbox.clone(), message_id.to_string(), own.to_vec());
            let page = blocking(move || {
                crate::custody::with_conn(&st, |c| sql_cache::reply_scan_page(c, &account, &mb, &id, &own, after, REPLY_SCAN_PAGE))
            })
            .await
            .and_then(|r| r);
            match page {
                Ok(p) if p.replied => {
                    info!("[follow-up] {message_id} has a reply cached in {mailbox}");
                    return true;
                }
                Ok(p) => match p.next_after {
                    Some(next) => after = next,
                    None => break,
                },
                Err(e) => {
                    warn!("[follow-up] header cache unreadable in {mailbox}, asking the server: {e}");
                    return false;
                }
            }
            crate::search_index::wait_foreground_quiet(&state.search_index).await;
        }
    }
    false
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
    // The row's own addresses (From, aliases) and the login, which a row
    // written before the app knew them still names.
    let mut own = row.own_addresses.clone();
    own.push(account.email.clone());
    let (Some(criteria), Some(plain)) = (
        imap::reply_search_criteria(&row.message_id, &own, true),
        imap::reply_search_criteria(&row.message_id, &own, false),
    ) else {
        return SentCopyGone;
    };
    // The cache first: a hit needs no connection at all.
    if cached_reply(state, &row.account_id, &row.message_id, &own).await {
        return Replied;
    }

    let PooledSessionGuard { mut session, last_selected: _, _permit } = match state.imap_pool.get_background(&account).await {
        Ok(g) => g,
        Err(e) => return if state.net.note_failure(&e).await { Transient(e) } else { Wait(e) },
    };
    let mut selected: Option<String> = None;
    let checked = async {
        let boxes = imap::list_mailboxes(&mut session).await?;
        let usable = |m: &&imap::MailboxInfo| !m.noselect;
        let with_role = |role: &str| boxes.iter().filter(usable).find(|m| m.special_use.as_deref() == Some(role)).map(|m| m.path.clone());
        let mut searched = vec!["INBOX".to_string()];
        let all = boxes.iter().filter(usable).find(|m| imap::has_attr(&m.flags, "All")).map(|m| m.path.clone());
        for path in [all, with_role("\\Archive"), with_role("\\Trash")].into_iter().flatten() {
            if !searched.iter().any(|s| s.eq_ignore_ascii_case(&path)) {
                searched.push(path);
            }
        }
        for mailbox in &searched {
            use imap::FolderSearch::*;
            selected = Some(mailbox.clone());
            let mut answer = imap::uid_search_tolerant(&mut session, mailbox, &criteria).await?;
            if let SearchRefused(why) = &answer {
                // The auto-reply terms are the unusual part (an empty HEADER
                // string, fields a server does not index). Without them an
                // out-of-office could count as an answer: better than no check.
                warn!("[follow-up] {mailbox} refused the reply search ({why}); asking again without the auto-reply terms");
                answer = imap::uid_search_tolerant(&mut session, mailbox, &plain).await?;
            }
            match answer {
                Hits(found) if !found.is_empty() => return Ok::<_, String>(Replied),
                Hits(_) => {}
                // A label hidden from IMAP, an INBOX or a search the server
                // turns away: no answer from that folder, not a failed check.
                // The cache already answered for what it holds; with every
                // folder refused, its "no" stands.
                FolderRefused(why) | SearchRefused(why) => {
                    info!("[follow-up] {mailbox} refused the reply search for {} ({why}); the cache's answer stands", row.id);
                }
            }
        }
        // The folder the app filed the message in first; one that refuses
        // (renamed or removed since) or no longer holds the copy (the Sent
        // folder moved, the old one stayed) gives way to the server's own.
        let special_sent = with_role("\\Sent");
        let mut candidates: Vec<String> = Vec::new();
        for path in [Some(row.sent_mailbox.clone()).filter(|m| !m.is_empty()), special_sent].into_iter().flatten() {
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
        let (mut refused, mut answered) = (None, false);
        for sent in candidates {
            selected = Some(sent.clone());
            match imap::message_id_uids_if_selectable(&mut session, &sent, &row.message_id).await? {
                Some(found) => match found.iter().copied().max() {
                    Some(uid) => return Ok(NoReply { sent_mailbox: sent, sent_uid: uid }),
                    None => {
                        info!("[follow-up] {} holds no copy of {}; trying the server's Sent folder", sent, row.id);
                        answered = true;
                    }
                },
                None => {
                    info!("[follow-up] {} refused the search for {}; trying the server's Sent folder", sent, row.id);
                    refused = Some(sent);
                }
            }
        }
        // A Sent folder answered and none holds it: gone. Every one refused:
        // a failure to retry, not a message gone.
        match refused {
            Some(sent) if !answered => Err(format!("{sent} refused the Message-ID search")),
            _ => Ok(SentCopyGone),
        }
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

    /// The addresses the send was the user's under: the login the test
    /// account signs in with, and an alias.
    fn own() -> Vec<String> {
        vec!["me@example.com".to_string(), "alias@example.com".to_string()]
    }

    fn seed(dir: &Path, id: &str, message_id: &str, remind_at: i64) {
        app_db::with(dir, |c| follow_up::insert(c, id, "acct", message_id, "Quote", "ana@example.com", "", &own(), 1_000, remind_at)).unwrap();
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

    /// A nudge the user sent from an alias, which Gmail files under All
    /// Mail, names the message too: it is the sender's own, no reply.
    #[tokio::test]
    async fn a_nudge_from_an_alias_is_no_reply() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(
                    Mailbox::new("[Gmail]/All Mail")
                        .with_attrs(&["\\HasNoChildren", "\\All"])
                        .push_msg(Message::new(0, eml("<nudge@me>", "Me <alias@example.com>", "In-Reply-To: <n@me>\r\n"))),
                )
                .mailbox(sent_with("<n@me>")),
        );
        let (dir, state) = rig(&server);
        seed(&dir, "a", "<n@me>", 1_000);
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(matches!(outcome, Outcome::NoReply { .. }), "the alias's nudge counted as a reply: {outcome:?}");
    }

    fn sent_with(message_id: &str) -> mock_imap::state::Mailbox {
        use mock_imap::state::{Mailbox, Message};
        Mailbox::new("Sent")
            .with_attrs(&["\\HasNoChildren", "\\Sent"])
            .push_msg(Message::new(0, eml(message_id, "me@example.com", "")).with_flags(&["\\Seen"]))
    }

    /// A vacation responder or an Exchange out-of-office answers at once and
    /// says nothing: it is no reply. RFC 3834's Auto-Submitted, and the
    /// X-Auto-Response-Suppress Exchange and Outlook put on their own.
    #[tokio::test]
    async fn an_automatic_reply_is_no_reply() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(
                    Mailbox::new("INBOX")
                        .push_msg(Message::new(0, eml("<v@ana>", "ana@example.com", "In-Reply-To: <q@me>\r\nAuto-Submitted: auto-replied\r\n")))
                        .push_msg(Message::new(0, eml("<o@boss>", "boss@example.com", "In-Reply-To: <q@me>\r\nX-Auto-Response-Suppress: All\r\n"))),
                )
                .mailbox(sent_with("<q@me>")),
        );
        let (dir, state) = rig(&server);
        seed(&dir, "a", "<q@me>", 1_000);
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(matches!(outcome, Outcome::NoReply { .. }), "an auto-reply counted as a reply: {outcome:?}");
    }

    /// A reply the user archived or deleted before the remind time was still
    /// a reply.
    #[tokio::test]
    async fn a_reply_in_archive_or_trash_counts() {
        use mock_imap::state::{Mailbox, Message};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(
                    Mailbox::new("Archive")
                        .with_attrs(&["\\HasNoChildren", "\\Archive"])
                        .push_msg(Message::new(0, eml("<r1@ana>", "ana@example.com", "In-Reply-To: <archived@me>\r\n"))),
                )
                .mailbox(
                    Mailbox::new("Bin")
                        .with_attrs(&["\\HasNoChildren", "\\Trash"])
                        .push_msg(Message::new(0, eml("<r2@ana>", "ana@example.com", "References: <deleted@me>\r\n"))),
                )
                .mailbox(sent_with("<archived@me>")),
        );
        let (dir, state) = rig(&server);
        seed(&dir, "archived", "<archived@me>", 1_000);
        seed(&dir, "deleted", "<deleted@me>", 1_000);
        let archived = check_row(&state, &row(&dir, "archived")).await;
        let deleted = check_row(&state, &row(&dir, "deleted")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert_eq!(archived, Outcome::Replied);
        assert_eq!(deleted, Outcome::Replied);
    }

    /// The Sent folder the app named was renamed or removed since: the
    /// server's own \Sent folder is asked before the row counts a failure.
    #[tokio::test]
    async fn a_renamed_sent_folder_falls_back_to_the_special_use_one() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new().mailbox(mock_imap::state::Mailbox::new("INBOX")).mailbox(sent_with("<s@me>")),
        );
        let (dir, state) = rig(&server);
        app_db::with(&dir, |c| follow_up::insert(c, "a", "acct", "<s@me>", "Quote", "ana@example.com", "Sent Items", &own(), 1_000, 1_000)).unwrap();
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let uid = server.state().find("Sent").unwrap().messages[0].uid;
        assert_eq!(outcome, Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: uid });
    }

    /// A folder other than INBOX that turns the SELECT away (a Gmail label a
    /// user hid from IMAP) is passed over; INBOX turning it away is a failure.
    #[tokio::test]
    async fn a_refused_folder_is_passed_over_inbox_too() {
        use mock_imap::state::{Mailbox, Message};
        use mock_imap::{Action, Trigger};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let scenario = |refuse: &str| {
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(
                    Mailbox::new("Archive")
                        .with_attrs(&["\\HasNoChildren", "\\Archive"])
                        .push_msg(Message::new(0, eml("<x@ana>", "ana@example.com", ""))),
                )
                .mailbox(sent_with("<f@me>"))
                .fault(Trigger::with("SELECT", refuse), Action::RefuseWith("NO".into(), "[NONEXISTENT] Not here".into()))
        };
        let archive_refuses = mock_imap::MockImap::start(scenario("Archive"));
        let (dir, state) = rig(&archive_refuses);
        seed(&dir, "a", "<f@me>", 1_000);
        let skipped = check_row(&state, &row(&dir, "a")).await;
        let inbox_refuses = mock_imap::MockImap::start(scenario("INBOX"));
        let (dir2, state2) = rig(&inbox_refuses);
        seed(&dir2, "a", "<f@me>", 1_000);
        let inbox = check_row(&state2, &row(&dir2, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(matches!(skipped, Outcome::NoReply { .. }), "a refused Archive failed the check: {skipped:?}");
        // The server's answer is missing, not wrong: the header cache decides
        // (here it has nothing), rather than spending the row's tries.
        assert!(matches!(inbox, Outcome::NoReply { .. }), "a refused INBOX burned a try: {inbox:?}");
    }

    /// A server that will not take the auto-reply terms (an empty HEADER
    /// string, an unknown field) is asked again without them.
    #[tokio::test]
    async fn a_search_refused_for_the_auto_reply_terms_is_asked_again_without_them() {
        use mock_imap::state::{Mailbox, Message};
        use mock_imap::{Action, Trigger};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX").push_msg(Message::new(0, eml("<r@ana>", "ana@example.com", "In-Reply-To: <h@me>\r\n"))))
                .mailbox(sent_with("<h@me>"))
                .fault(Trigger::with("SEARCH", "Auto-Submitted"), Action::RefuseWith("BAD".into(), "Unsupported search key".into())),
        );
        let (dir, state) = rig(&server);
        seed(&dir, "a", "<h@me>", 1_000);
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert_eq!(outcome, Outcome::Replied);
    }

    /// The folder the app named answers but no longer holds the message (the
    /// account's Sent moved, the old folder stayed): the server's own \Sent
    /// is asked before the row ends `gone`.
    #[tokio::test]
    async fn a_stored_sent_without_the_copy_gives_way_to_the_special_use_one() {
        use mock_imap::state::Mailbox;
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(Mailbox::new("Old Sent"))
                .mailbox(sent_with("<o@me>")),
        );
        let (dir, state) = rig(&server);
        app_db::with(&dir, |c| follow_up::insert(c, "a", "acct", "<o@me>", "Quote", "ana@example.com", "Old Sent", &own(), 1_000, 1_000)).unwrap();
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let uid = server.state().find("Sent").unwrap().messages[0].uid;
        assert_eq!(outcome, Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: uid });
    }

    // ── the header cache, asked first ──

    /// Open the header cache and give it `rows` per mailbox, with a folder
    /// list that names Sent by its role (Drafts is known by its name).
    fn cache(state: &Arc<DaemonState>, folders: &[(&str, Vec<serde_json::Value>)]) {
        crate::custody::open_into(state).expect("custody opens");
        crate::custody::with_conn(state, |c| {
            mailvault_core::custody::cache::save_mailboxes(
                c,
                "acct",
                &json!({"mailboxes": [
                    {"path": "INBOX", "specialUse": "\\Inbox", "children": []},
                    {"path": "Outbox", "specialUse": "\\Sent", "children": []},
                ]})
                .to_string(),
            )?;
            for (mailbox, rows) in folders {
                mailvault_core::custody::cache::save_headers(c, "acct", mailbox, &json!({"emails": rows}).to_string())?;
            }
            Ok(())
        })
        .unwrap();
    }

    fn cached(uid: u32, from: &str, subject: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut row = json!({"uid": uid, "subject": subject, "from": {"address": from}});
        for (k, v) in extra.as_object().unwrap() {
            row[k] = v.clone();
        }
        row
    }

    /// A server with no reply on it, and the Sent copy the row names.
    fn quiet_server(message_id: &str) -> mock_imap::MockImap {
        mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(mock_imap::state::Mailbox::new("INBOX")).mailbox(sent_with(message_id)))
    }

    /// A reply the app already holds (here one the user deleted) answers,
    /// whatever the server's own search says.
    #[tokio::test]
    async fn a_reply_in_the_header_cache_counts_when_the_server_finds_none() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = quiet_server("<l@me>");
        let (dir, state) = rig(&server);
        cache(&state, &[("Trash", vec![cached(4, "client@example.com", "Re: Quote", json!({"inReplyTo": "<l@me>"}))])]);
        seed(&dir, "a", "<l@me>", 1_000);
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert_eq!(outcome, Outcome::Replied);
    }

    /// Cached mail that names the message but is no answer: a nudge from an
    /// alias, a vacation notice by its header or its subject, and copies in
    /// the Sent folder (by its role) and in Drafts (by its name).
    #[tokio::test]
    async fn cached_mail_that_is_no_answer_does_not_count() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = quiet_server("<n@me>");
        let (dir, state) = rig(&server);
        let names = json!({"inReplyTo": "<n@me>"});
        cache(&state, &[
            ("INBOX", vec![
                cached(1, "ALIAS@example.com", "Re: Quote", names.clone()),
                cached(2, "client@example.com", "Re: Quote", json!({"inReplyTo": "<n@me>", "autoReply": "auto-replied"})),
                cached(3, "boss@example.com", "Automatic reply: Quote", names.clone()),
            ]),
            ("Outbox", vec![cached(1, "client@example.com", "Re: Quote", names.clone())]),
            ("Drafts", vec![cached(1, "client@example.com", "Re: Quote", names.clone())]),
        ]);
        seed(&dir, "a", "<n@me>", 1_000);
        let outcome = check_row(&state, &row(&dir, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(matches!(outcome, Outcome::NoReply { .. }), "cached mail that is no answer counted: {outcome:?}");
    }

    /// The server turns every reply search away: the cache decides, and a
    /// refusal never spends the row's tries.
    #[tokio::test]
    async fn with_every_server_search_refused_the_cache_decides() {
        use mock_imap::state::Mailbox;
        use mock_imap::{Action, Trigger};
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let refusing = |id: &str| {
            mock_imap::MockImap::start(
                mock_imap::Scenario::new()
                    .mailbox(Mailbox::new("INBOX"))
                    .mailbox(sent_with(id))
                    .fault(Trigger::with("SEARCH", "In-Reply-To"), Action::RefuseWith("NO".into(), "Search unavailable".into())),
            )
        };
        let quiet = refusing("<s1@me>");
        let (dir, state) = rig(&quiet);
        seed(&dir, "a", "<s1@me>", 1_000);
        let no_reply = check_row(&state, &row(&dir, "a")).await;

        let answered = refusing("<s2@me>");
        let (dir2, state2) = rig(&answered);
        cache(&state2, &[("INBOX", vec![cached(5, "client@example.com", "Re: Quote", json!({"references": ["<s2@me>"]}))])]);
        seed(&dir2, "a", "<s2@me>", 1_000);
        let replied = check_row(&state2, &row(&dir2, "a")).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(matches!(no_reply, Outcome::NoReply { .. }), "refused searches with nothing cached: {no_reply:?}");
        assert_eq!(replied, Outcome::Replied);
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
        record_after_send(&state, "acct", raw, "ana@example.com", Some("Sent"), &own(), 3);
        record_after_send(&state, "acct", b"Subject: no id\r\n\r\nbody\r\n", "ana@example.com", Some("Sent"), &own(), 3);
        record_after_send(&state, "acct", b"Message-ID: <off@me>\r\n\r\nbody\r\n", "ana@example.com", Some("Sent"), &own(), 0);
        let rows = app_db::with(&dir, |c| follow_up::list(c, None)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id, "<sched-1@me>");
        assert_eq!(rows[0].subject, "Café");
        assert_eq!(rows[0].recipients, "ana@example.com");
        assert_eq!(rows[0].sent_mailbox, "Sent");
        assert_eq!(rows[0].own_addresses, own());
        assert_eq!(rows[0].remind_at - rows[0].sent_at, 3 * DAY_MS);
    }
}
