//! Background fetch (`background.rs`, plan Ruling 9): one headers-only INBOX pass per account on
//! the engine's sync worker, inside a budget, then the unseen mail above each INBOX's notify
//! watermark. The first run only sets the watermark; the watermark moves only past what a run
//! returned; notifications off means no network at all; a parked account, or a password account
//! whose last sign-in was refused, is never dialled.

use mailvault_mobile_engine::{Engine, MemorySecrets, NewMail};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// What a test run may take: far more than a pass against the local mock needs.
const BUDGET: Duration = Duration::from_secs(30);
const DAY: i64 = 86_400_000;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn msg(uid: u32, subject: &str) -> Message {
    Message::new(
        uid,
        format!(
            "From: Sender {uid} <sender{uid}@example.com>\n\
             To: user@example.com\n\
             Subject: {subject}\n\
             Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
             Message-ID: <bg-{uid}@example.com>\n\
             Content-Type: text/plain; charset=UTF-8\n\
             \n\
             Body {uid}.\n"
        ),
    )
    .with_internal_ms(now_ms() - DAY)
}

fn inbox(msgs: Vec<Message>) -> Mailbox {
    let mut mb = Mailbox::new("INBOX");
    for m in msgs {
        mb.add(m);
    }
    mb
}

fn deliver(server: &MockImap, subject: &str, seen: bool) {
    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        let m = msg(uid, subject);
        mb.add(if seen { m.with_flags(&["\\Seen"]) } else { m });
    });
}

struct Fx {
    tmp: tempfile::TempDir,
    engine: Engine,
}

fn fx() -> Fx {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
    Fx { tmp, engine }
}

impl Fx {
    fn add(&self, server: &MockImap, email: &str) -> String {
        let added = self
            .engine
            .rpc(
                "mobile.accounts.add",
                json!({ "email": email, "password": "pw-bg-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        assert_eq!(added["ok"], true, "{added}");
        added["account"]["id"].as_str().unwrap().to_string()
    }

    fn notifications(&self, on: bool) -> Value {
        self.engine.rpc("mobile.settings.set", json!({ "notifications": if on { "on" } else { "off" } })).unwrap()
    }

    fn run(&self, budget: Duration) -> Vec<NewMail> {
        self.engine.background_fetch(budget).unwrap()
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    fn watermark(&self, account: &str) -> Option<i64> {
        use rusqlite::OptionalExtension;
        self.db()
            .query_row("SELECT last_uid FROM notify_state WHERE account_id = ?1 AND folder = 'INBOX'", [account], |r| r.get(0))
            .optional()
            .unwrap()
    }
}

fn subjects(mails: &[NewMail]) -> Vec<&str> {
    mails.iter().map(|m| m.subject.as_str()).collect()
}

#[test]
fn settings_default_off_with_preview_and_round_trip() {
    let f = fx();
    assert_eq!(f.engine.rpc("mobile.settings.get", json!({})).unwrap(), json!({ "notifications": "off", "notificationPreview": true }));
    let set = f.engine.rpc("mobile.settings.set", json!({ "notifications": "on", "notificationPreview": false })).unwrap();
    assert_eq!(set, json!({ "notifications": "on", "notificationPreview": false }));
    assert_eq!(f.engine.rpc("mobile.settings.get", json!({})).unwrap(), set);
    assert!(f.engine.notifications_on());
    assert!(!f.engine.notification_preview());
    // Only the two values each.
    for bad in [json!({ "notifications": "maybe" }), json!({ "notificationPreview": "yes" }), json!({ "notifications": true })] {
        let err = f.engine.rpc("mobile.settings.set", bad.clone()).unwrap_err();
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    assert_eq!(f.engine.rpc("mobile.settings.get", json!({})).unwrap(), set, "a refused set changes nothing");
}

#[test]
fn first_run_sets_the_watermark_and_notifies_nothing() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old one"), msg(2, "old two")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);

    // Two unseen messages are already there: the first run is no flood.
    assert_eq!(subjects(&f.run(BUDGET)), Vec::<&str>::new());
    assert_eq!(f.watermark(&account), Some(2));
    // The pass did run: its headers are in the list.
    let page = f.engine.rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": null, "limit": 10 })).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2, "{page}");

    // Turned off and on again: a new baseline, so mail that came while it was off is no flood.
    f.notifications(false);
    deliver(&server, "while off", false);
    f.notifications(true);
    assert_eq!(f.watermark(&account), None, "turning notifications on starts a new baseline");
    assert_eq!(subjects(&f.run(BUDGET)), Vec::<&str>::new());
    assert_eq!(f.watermark(&account), Some(3));
}

#[test]
fn new_unseen_mail_is_returned_once() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());

    deliver(&server, "first new", false);
    deliver(&server, "read elsewhere", true);
    deliver(&server, "second new", false);
    let got = f.run(BUDGET);
    assert_eq!(subjects(&got), vec!["first new", "second new"], "unseen only, oldest first");
    let first = &got[0];
    assert_eq!((first.account_id.as_str(), first.account_email.as_str(), first.folder.as_str(), first.uid), (account.as_str(), "u@example.test", "INBOX", 2));
    assert_eq!(first.from, "Sender 2");
    assert_eq!(f.watermark(&account), Some(4));

    // Notified once: the next run returns nothing new.
    assert!(f.run(BUDGET).is_empty());

    // Read on the phone before the run (a local override the server does not know yet): not news.
    deliver(&server, "opened on the phone", false);
    let page = f.engine.rpc("mobile.sync.refresh", json!({ "accountId": account, "folder": "INBOX" })).unwrap();
    assert_eq!(page, json!({ "queued": true }));
    let deadline = Instant::now() + BUDGET;
    loop {
        let rows = f.engine.rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": null, "limit": 10 })).unwrap();
        if rows["rows"].as_array().unwrap().iter().any(|r| r["uid"] == 5) {
            break;
        }
        assert!(Instant::now() < deadline, "the refresh never listed uid 5");
        std::thread::sleep(Duration::from_millis(50));
    }
    f.engine.rpc("mobile.actions.apply", json!({ "accountId": account, "folder": "INBOX", "uids": [5], "kind": "seen" })).unwrap();
    assert!(f.run(BUDGET).is_empty(), "a message read on the phone is no notification");
}

#[test]
fn a_run_out_of_budget_returns_in_time_and_keeps_unreturned_mail_for_next_time() {
    let slow = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a old")])));
    let other = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "b old")])));
    let f = fx();
    let a = f.add(&slow, "a@example.test");
    let b = f.add(&other, "b@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());
    assert_eq!((f.watermark(&a), f.watermark(&b)), (Some(1), Some(1)));

    deliver(&slow, "a new", false);
    deliver(&other, "b new", false);
    // A's server stalls in the middle of its pass (a dead network halfway).
    let mut stall = slow.pause_command("SEARCH");
    let b_logins = other.count_commands("LOGIN");
    let budget = Duration::from_millis(1500);
    let t0 = Instant::now();
    let got = f.run(budget);
    let took = t0.elapsed();
    assert!(took < budget + Duration::from_millis(500), "the run overran its budget: {took:?}");
    assert!(stall.entered(Duration::ZERO), "A's pass reached the stalled SEARCH");
    assert!(got.is_empty(), "nothing finished in time: {:?}", subjects(&got));
    assert_eq!(other.count_commands("LOGIN"), b_logins, "no account starts once the budget is mostly gone");
    assert_eq!((f.watermark(&a), f.watermark(&b)), (Some(1), Some(1)), "the watermark moves only past returned mail");

    // The network is back: the next run returns what the cut-short one did not.
    stall.release();
    let got = f.run(BUDGET);
    assert_eq!(subjects(&got).len(), 2, "{:?}", subjects(&got));
    assert!(subjects(&got).contains(&"a new") && subjects(&got).contains(&"b new"), "{:?}", subjects(&got));
    assert_eq!((f.watermark(&a), f.watermark(&b)), (Some(2), Some(2)));
    assert!(f.run(BUDGET).is_empty());
}

#[test]
fn notifications_off_means_no_network() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    let conns = server.connection_count();
    deliver(&server, "new", false);

    // Off by default.
    let t0 = Instant::now();
    assert!(f.run(BUDGET).is_empty());
    f.notifications(false);
    assert!(f.run(BUDGET).is_empty());
    assert!(t0.elapsed() < Duration::from_secs(1), "an off run waits on nothing: {:?}", t0.elapsed());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(server.connection_count(), conns, "notifications off: no connection at all");
    assert_eq!(f.watermark(&account), None);
}

#[test]
fn needs_auth_accounts_are_skipped() {
    let parked = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "p old")])));
    let fine = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "f old")])));
    let f = fx();
    let p = f.add(&parked, "p@example.test");
    let ok = f.add(&fine, "f@example.test");
    f.db().execute("UPDATE accounts SET needs_auth = 1 WHERE id = ?1", [&p]).unwrap();
    f.notifications(true);
    let conns = parked.connection_count();

    assert!(f.run(BUDGET).is_empty());
    deliver(&parked, "p new", false);
    deliver(&fine, "f new", false);
    assert_eq!(subjects(&f.run(BUDGET)), vec!["f new"]);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(parked.connection_count(), conns, "a parked account is never dialled");
    assert_eq!((f.watermark(&p), f.watermark(&ok)), (None, Some(2)));
}

#[test]
fn a_refused_password_is_not_tried_again_in_the_background() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    // The password was changed on the server: every LOGIN is refused.
    server.reset_scenario(
        Scenario::new()
            .mailbox(inbox(vec![msg(1, "old")]))
            .fault(Trigger::on("LOGIN"), Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())),
    );
    assert!(f.run(BUDGET).is_empty());
    let refused = server.count_commands("LOGIN");
    assert!(refused >= 1, "the first run tried");

    // Later runs leave it alone: servers ban an address after a few failed logins.
    assert!(f.run(BUDGET).is_empty());
    assert!(f.run(BUDGET).is_empty());
    assert_eq!(server.count_commands("LOGIN"), refused, "a refused password is not tried again in the background");

    // A pass that signs in again (the user fixed it, the app in front) lifts the hold.
    server.reset_scenario(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    assert_eq!(f.engine.rpc("mobile.sync.refresh", json!({ "accountId": account, "folder": "INBOX" })).unwrap(), json!({ "queued": true }));
    let deadline = Instant::now() + BUDGET;
    while f.engine.setting(&format!("bg.authRefused.{account}")).unwrap().is_some() {
        assert!(Instant::now() < deadline, "a good pass never lifted the hold");
        std::thread::sleep(Duration::from_millis(50));
    }
    let before = server.count_commands("LOGIN");
    assert!(f.run(BUDGET).is_empty());
    assert!(server.count_commands("LOGIN") > before, "tried again once a pass signed in");
}

#[test]
fn removing_an_account_drops_its_background_state() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());
    assert_eq!(f.watermark(&account), Some(1));
    f.engine.set_setting(&format!("bg.authRefused.{account}"), "1").unwrap();
    f.engine.rpc("mobile.accounts.remove", json!({ "accountId": account })).unwrap();
    assert_eq!(f.watermark(&account), None);
    assert_eq!(f.engine.setting(&format!("bg.authRefused.{account}")).unwrap(), None);
}
