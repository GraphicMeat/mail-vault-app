//! Follow-up reminders (plan 4 Task 9): "remind me if no reply in N days" on send, Premium only and
//! never on a Graph account; at the remind time a local check over the rows the phone holds, then
//! the server (core's `follow_up::imap_check`, the daemon's own); no reply makes the row `due`,
//! listed in "Follow up" and, with notifications on, posted once by a background run.

use mailvault_core::app_db::follow_up as store;
use mailvault_mobile_engine::{Engine, MemorySecrets, RpcError};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{MockImap, Scenario};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);
const PASSWORD: &str = "pw-followup-test-s3cret";
const ME: &str = "u@example.test";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn scenario() -> Scenario {
    Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]))
}

/// A message arriving in INBOX on the server now.
fn deliver(server: &MockImap, raw: String) {
    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        mb.add(Message::new(uid, raw).with_internal_ms(now_ms()));
    });
}

fn reply(n: u32, from: &str, subject: &str, headers: &str) -> String {
    format!(
        "From: {from}\r\nTo: {ME}\r\nSubject: {subject}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMessage-ID: <reply-{n}@example.com>\r\n{headers}Content-Type: text/plain; charset=UTF-8\r\n\r\nreply {n}\r\n"
    )
}

/// The uid of the server's Sent copy of `message_id`.
fn sent_uid(server: &MockImap, message_id: &str) -> Option<u32> {
    server.state().find("Sent")?.messages.iter().find(|m| String::from_utf8_lossy(&m.raw).contains(message_id)).map(|m| m.uid)
}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

impl Events {
    fn len(&self) -> usize {
        self.list.lock().unwrap().len()
    }

    fn wait(&self, from: usize, what: &str, pred: impl Fn(&str, &Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        let mut list = self.list.lock().unwrap();
        loop {
            if let Some((_, v)) = list.iter().skip(from).find(|(n, v)| pred(n, v)) {
                return v.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no {what} event; got {:?}", &list[from.min(list.len())..]);
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
    }

    fn count(&self, name: &str) -> usize {
        self.list.lock().unwrap().iter().filter(|(n, _)| n == name).count()
    }
}

struct Fixture {
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn open(dir: &Path, secrets: &Arc<MemorySecrets>) -> (Arc<Engine>, Arc<Events>) {
    let engine = Arc::new(Engine::open(dir, &dir.join("cache"), Arc::clone(secrets) as _).unwrap());
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    (engine, events)
}

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events) = open(tmp.path(), &secrets);
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": ME, "password": PASSWORD, "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    // The reminders alone decide whether background runs are wanted and dial: no background
    // download of the INBOX beside them (`backgroundDownload` is on by default).
    engine.set_setting("backgroundDownload", "false").unwrap();
    Fixture { tmp, secrets, engine, events, account }
}

impl Fixture {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    fn restart(self) -> Fixture {
        let Fixture { tmp, secrets, engine, events: _, account } = self;
        drop(engine);
        let (engine, events) = open(tmp.path(), &secrets);
        Fixture { tmp, secrets, engine, events, account }
    }

    /// Premium on for a month, as a store answer the engine cached (read at the restart).
    fn premium(self) -> Fixture {
        let state = json!({ "entitled": true, "source": "apple", "expiresMs": now_ms() + 30 * DAY, "checkedMs": now_ms() }).to_string();
        self.db()
            .execute("INSERT INTO settings (key, value) VALUES ('premium.state', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [&state])
            .unwrap();
        let f = self.restart();
        assert_eq!(f.engine.rpc("mobile.premium.status", json!({})).unwrap()["premium"], true);
        f
    }

    fn send(&self, subject: &str, days: Option<i64>) -> Result<Value, RpcError> {
        let mut p = json!({ "accountId": self.account, "to": "bob@example.com", "cc": "", "bcc": "", "subject": subject, "text": "Quote attached.", "attachments": [] });
        if let Some(d) = days {
            p["remindAfterDays"] = json!(d);
        }
        self.engine.rpc("mobile.compose.send", p)
    }

    /// Sends `subject` with a reminder in `days`, waits for it to go out and for its copy to be
    /// filed in the server's Sent (after the `sent` event), and answers the reminder's row.
    fn sent_with_reminder(&self, server: &MockImap, subject: &str, days: i64) -> store::FollowUp {
        let from = self.events.len();
        let id = self.send(subject, Some(days)).unwrap()["id"].as_str().unwrap().to_string();
        self.events.wait(from, "sent", |n, v| n == "mobile.send.result" && v["id"] == id.as_str() && v["outcome"] == "sent");
        let rows = store::list(&self.db(), Some(&self.account)).unwrap();
        let row = rows.into_iter().find(|r| r.subject == subject).unwrap_or_else(|| panic!("no reminder for {subject}"));
        let deadline = Instant::now() + WAIT;
        while sent_uid(server, &row.message_id).is_none() {
            assert!(Instant::now() < deadline, "{subject} was never filed in Sent");
            std::thread::sleep(Duration::from_millis(20));
        }
        row
    }

    /// The reminder's time came.
    fn come_due(&self, id: &str) {
        assert_eq!(self.db().execute("UPDATE follow_ups SET remind_at = ?2 WHERE id = ?1", rusqlite::params![id, now_ms() - 1_000]).unwrap(), 1);
    }

    fn check(&self) {
        assert!(self.engine.followup_check_now(WAIT), "no follow-up pass finished");
    }

    fn state(&self, id: &str) -> Option<String> {
        store::get(&self.db(), id).unwrap().map(|r| r.state)
    }

    fn listed(&self) -> Vec<Value> {
        self.engine.rpc("mobile.followup.list", json!({})).unwrap()["items"].as_array().unwrap().clone()
    }

    fn notifications(&self, on: bool) {
        self.engine.rpc("mobile.settings.set", json!({ "notifications": if on { "on" } else { "off" } })).unwrap();
    }
}

/// A reply from someone else ends the reminder, whether it names the message in In-Reply-To or
/// only in References. The reminder is set as asked: due `days` after the send, keyed on the
/// Message-ID it went out under, the account's address its own.
#[test]
fn reply_by_in_reply_to_or_references_clears() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    let before = now_ms();
    let a = f.sent_with_reminder(&server, "Quote A", 3);
    let b = f.sent_with_reminder(&server, "Quote B", 1);
    assert!(a.remind_at - a.sent_at == 3 * DAY && a.sent_at >= before, "{a:?}");
    assert_eq!(b.remind_at - b.sent_at, DAY);
    assert_eq!((a.state.as_str(), a.recipients.as_str()), ("waiting", "bob@example.com"));
    assert!(a.message_id.starts_with('<') && a.message_id.ends_with("@example.test>"), "{}", a.message_id);
    assert_eq!(a.own_addresses, vec![ME.to_string()]);
    assert!(f.engine.wants_background(), "a waiting reminder asks for background runs");

    deliver(&server, reply(1, "Bob <bob@example.com>", "Re: Quote A", &format!("In-Reply-To: {}\r\n", a.message_id)));
    deliver(&server, reply(2, "Bob <bob@example.com>", "Re: Quote B", &format!("References: <root@x> {}\r\n", b.message_id)));
    f.come_due(&a.id);
    f.come_due(&b.id);
    f.check();
    assert_eq!(f.state(&a.id).as_deref(), Some("replied"));
    assert_eq!(f.state(&b.id).as_deref(), Some("replied"));
    assert!(f.listed().is_empty(), "an answered reminder is not listed");
    assert_eq!(f.events.count("mobile.followup.due"), 0);
    assert!(!f.engine.wants_background());
    assert_eq!(server.count_commands("STORE") + server.count_commands("MOVE"), 0, "nothing changes on the server");
}

/// The user's own nudge and an automatic reply are no answer: the reminder goes due, pointing at
/// the Sent copy, and is announced to the page.
#[test]
fn own_or_automatic_reply_does_not_count() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    let row = f.sent_with_reminder(&server, "Quote", 3);
    deliver(&server, reply(1, &format!("Me <{ME}>"), "Re: Quote", &format!("In-Reply-To: {}\r\n", row.message_id)));
    deliver(&server, reply(2, "Bob <bob@example.com>", "Re: Quote", &format!("In-Reply-To: {}\r\nAuto-Submitted: auto-replied\r\n", row.message_id)));
    let from = f.events.len();
    f.come_due(&row.id);
    f.check();
    assert_eq!(f.state(&row.id).as_deref(), Some("due"));
    let due = f.events.wait(from, "followup.due", |n, _| n == "mobile.followup.due");
    assert_eq!(due, json!({ "id": row.id, "accountId": f.account }));
    let listed = f.listed();
    assert_eq!(listed.len(), 1);
    let sent_uid = sent_uid(&server, &row.message_id).unwrap();
    assert_eq!((listed[0]["state"].as_str(), listed[0]["folder"].as_str(), listed[0]["uid"].as_u64()), (Some("due"), Some("Sent"), Some(u64::from(sent_uid))), "{listed:?}");

    // Opened: still listed, seen.
    f.engine.rpc("mobile.followup.seen", json!({ "id": row.id })).unwrap();
    assert_eq!(f.listed()[0]["seen"], true);
    // Dismissed: gone from the list.
    f.engine.rpc("mobile.followup.dismiss", json!({ "id": row.id })).unwrap();
    assert!(f.listed().is_empty());
    assert!(matches!(f.engine.rpc("mobile.followup.dismiss", json!({ "id": 3 })), Err(RpcError::Invalid(_))));
}

/// A reply the phone already holds (a row whose thread names the message, outside Sent and
/// Drafts) answers with no connection at all; one in Sent or Drafts, from the user, or titled like
/// an automatic reply does not.
#[test]
fn local_thread_reference_clears_without_network() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    let answered = f.sent_with_reminder(&server, "Answered", 3);
    let unanswered = f.sent_with_reminder(&server, "Unanswered", 3);
    let db = f.db();
    for (folder, special) in [("INBOX", None), ("Sent", Some("\\Sent")), ("Drafts", Some("\\Drafts"))] {
        db.execute(
            "INSERT OR REPLACE INTO folders (account_id, path, name, special_use) VALUES (?1, ?2, ?2, ?3)",
            rusqlite::params![f.account, folder, special],
        )
        .unwrap();
    }
    let local = |folder: &str, uid: u32, from: &str, subject: &str, names: &str| {
        let thread = json!({ "cc": [], "replyTo": [], "references": ["<root@x>", names], "date": null }).to_string();
        db.execute(
            "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, thread_json)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, '', 0, 0, 0, ?7)",
            rusqlite::params![f.account, folder, uid, subject, from, now_ms(), thread],
        )
        .unwrap();
    };
    local("INBOX", 9001, "bob@example.com", "Re: Answered", &answered.message_id.to_uppercase());
    local("INBOX", 9002, ME, "Re: Unanswered", &unanswered.message_id);
    local("INBOX", 9003, "bob@example.com", "Automatic reply: Unanswered", &unanswered.message_id);
    local("Sent", 9004, "bob@example.com", "Re: Unanswered", &unanswered.message_id);
    local("Drafts", 9005, "bob@example.com", "Re: Unanswered", &unanswered.message_id);
    f.come_due(&answered.id);
    let commands = server.commands().len();
    f.check();
    assert_eq!(f.state(&answered.id).as_deref(), Some("replied"));
    assert_eq!(server.commands().len(), commands, "answered on the phone with no connection");

    f.come_due(&unanswered.id);
    f.check();
    assert_eq!(f.state(&unanswered.id).as_deref(), Some("due"), "own, automatic, Sent and Drafts rows are no answer");
}

/// With notifications on, a background run checks a reminder whose time came and posts it once:
/// the commit marks it announced, so the next run does not post it again.
#[test]
fn due_without_reply_notifies_once() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    f.notifications(true);
    let row = f.sent_with_reminder(&server, "Quote", 7);
    f.come_due(&row.id);
    let run = f.engine.background_fetch(WAIT).unwrap();
    assert_eq!(run.followups.len(), 1, "{run:?}");
    let posted = &run.followups[0];
    assert_eq!((posted.id.as_str(), posted.subject.as_str(), posted.folder.as_str(), posted.account_email.as_str()), (row.id.as_str(), "Quote", "Sent", ME));
    let token = run.commit.expect("a run with a reminder to post has a commit");
    // Not committed (the OS ended the task): the next run posts it again.
    let again = f.engine.background_fetch(WAIT).unwrap();
    assert_eq!(again.followups.len(), 1);
    f.engine.background_commit(&token).unwrap();
    f.engine.background_commit(again.commit.as_deref().unwrap()).unwrap();
    let after = f.engine.background_fetch(WAIT).unwrap();
    assert!(after.followups.is_empty(), "posted once: {after:?}");
    assert_eq!(f.listed().len(), 1, "still listed until dismissed");
}

/// A reminder that goes due while the app is in front is listed there; once the app leaves the
/// front a background run does not post it again.
#[test]
fn due_while_in_front_is_not_posted_later() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    f.notifications(true);
    let row = f.sent_with_reminder(&server, "Quote", 3);
    f.engine.rpc("mobile.app.state", json!({ "foreground": true, "accountId": f.account })).unwrap();
    f.come_due(&row.id);
    f.check();
    assert_eq!(f.state(&row.id).as_deref(), Some("due"));
    f.engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    let run = f.engine.background_fetch(WAIT).unwrap();
    assert!(run.followups.is_empty(), "already listed in front: {run:?}");
    assert_eq!(f.listed().len(), 1, "still listed until dismissed");
}

/// Leaving the front without having been in front (an OS suspend of a background launch) marks
/// nothing: the reminder is still posted.
#[test]
fn leaving_without_having_been_in_front_still_posts() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    f.notifications(true);
    let row = f.sent_with_reminder(&server, "Quote", 3);
    let f = f.restart();
    f.come_due(&row.id);
    f.check();
    assert_eq!(f.state(&row.id).as_deref(), Some("due"));
    f.engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    let run = f.engine.background_fetch(WAIT).unwrap();
    assert_eq!(run.followups.len(), 1, "{run:?}");
}

/// A front visit earlier in the process does not cover a reminder that went due later, while the
/// app was away: a later leave (the OS suspend after a background launch) marks nothing.
#[test]
fn due_after_an_earlier_front_visit_is_still_posted() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    f.notifications(true);
    let row = f.sent_with_reminder(&server, "Quote", 3);
    f.engine.rpc("mobile.app.state", json!({ "foreground": true, "accountId": f.account })).unwrap();
    f.engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    f.come_due(&row.id);
    f.check();
    assert_eq!(f.state(&row.id).as_deref(), Some("due"));
    f.engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    let run = f.engine.background_fetch(WAIT).unwrap();
    assert_eq!(run.followups.len(), 1, "never in front since it went due: {run:?}");
}

/// Notifications off: a background run still checks a due reminder (and only that: no INBOX
/// pass), lists it, and posts nothing.
#[test]
fn notifications_off_lists_without_notifying() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    let row = f.sent_with_reminder(&server, "Quote", 1);
    let f = f.restart();
    assert!(f.engine.wants_background(), "a waiting reminder asks for runs with notifications off");
    f.come_due(&row.id);
    let run = f.engine.background_fetch(WAIT).unwrap();
    assert!(run.mail.is_empty() && run.followups.is_empty() && run.commit.is_none(), "{run:?}");
    assert_eq!(f.state(&row.id).as_deref(), Some("due"), "checked in the background");
    assert_eq!(f.listed().len(), 1);
    assert!(!f.engine.wants_background(), "nothing waits now");
    // Nothing due: no network at all.
    let commands = server.commands().len();
    assert!(f.engine.background_fetch(WAIT).unwrap().followups.is_empty());
    assert_eq!(server.commands().len(), commands);
}

/// A Graph account is never offered a reminder (desktop parity), and a row on one ends with no
/// network.
#[test]
fn graph_refused() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    f.db()
        .execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms, kind, auth, provider)
             VALUES ('acc_graph', 'g@example.test', '', 'outlook.office365.com', 993, 'tls', 0, 'graph', 'oauth2', 'microsoft')",
            [],
        )
        .unwrap();
    let p = json!({ "accountId": "acc_graph", "to": "bob@example.com", "cc": "", "bcc": "", "subject": "Hi", "text": "x", "attachments": [], "remindAfterDays": 3 });
    match f.engine.rpc("mobile.compose.send", p) {
        Err(e @ RpcError::Invalid(_)) => assert_eq!(e.code(), "INVALID"),
        other => panic!("a Graph account took a reminder: {other:?}"),
    }
    let outbox: i64 = f.db().query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(outbox, 0, "refused before any write");
    store::insert(&f.db(), "fu_graph", "acc_graph", "<g@x>", "Hi", "bob@example.com", "", &[], 1_000, 1_000).unwrap();
    f.check();
    assert_eq!(f.state("fu_graph").as_deref(), Some("gone"));
}

/// Without Premium the reminder is refused when it is set, before anything is written; only 1, 3
/// or 7 days are offered.
#[test]
fn premium_required_at_set_time() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let refused = f.send("Quote", Some(3)).unwrap_err();
    assert_eq!(refused.code(), "PREMIUM_REQUIRED");
    let outbox: i64 = f.db().query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(outbox, 0, "refused before any write");
    let f = f.premium();
    assert_eq!(f.send("Quote", Some(2)).unwrap_err().code(), "INVALID");
    // A plain send needs no Premium and records no reminder.
    let from = f.events.len();
    let id = f.send("Plain", None).unwrap()["id"].as_str().unwrap().to_string();
    f.events.wait(from, "sent", |n, v| n == "mobile.send.result" && v["id"] == id.as_str() && v["outcome"] == "sent");
    assert!(store::list(&f.db(), None).unwrap().is_empty());
}

/// Removing the account drops its reminders: nothing listed, nothing waiting.
#[test]
fn removed_account_drops_its_reminders() {
    let server = MockImap::start(scenario());
    let f = setup(&server).premium();
    f.sent_with_reminder(&server, "Quote", 3);
    assert_eq!(f.listed().len(), 1);
    f.engine.rpc("mobile.accounts.remove", json!({ "accountId": f.account })).unwrap();
    assert!(f.listed().is_empty());
    let left: i64 = f.db().query_row("SELECT count(*) FROM follow_ups", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
    assert!(!f.engine.wants_background());
}
