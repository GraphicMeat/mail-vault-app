//! Background fetch (`background.rs`, plan Ruling 9): one headers-only INBOX pass per account on
//! the engine's sync worker, inside a budget, then the unseen mail above each INBOX's notify
//! watermark. The first run only sets the watermark; the watermark moves only past what a run
//! returned; notifications off means no network at all; a parked account, or a password account
//! whose last sign-in was refused, is never dialled.

use mailvault_mobile_engine::{BackgroundRun, Engine, MemorySecrets, NewMail};
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

/// New mail arriving now.
fn deliver(server: &MockImap, subject: &str, seen: bool) {
    deliver_at(server, subject, seen, now_ms());
}

fn deliver_at(server: &MockImap, subject: &str, seen: bool, at_ms: i64) {
    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        let m = msg(uid, subject).with_internal_ms(at_ms);
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

    /// A run whose notifications were posted: fetched, then committed.
    fn run(&self, budget: Duration) -> Vec<NewMail> {
        let BackgroundRun { mail, commit, .. } = self.engine.background_fetch(budget).unwrap();
        if let Some(token) = commit {
            self.engine.background_commit(&token).unwrap();
        }
        mail
    }

    /// A run the platform cut short before its notifications were posted (no commit).
    fn run_uncommitted(&self, budget: Duration) -> BackgroundRun {
        self.engine.background_fetch(budget).unwrap()
    }

    fn sync(&self, account: &str) {
        assert_eq!(self.engine.rpc("mobile.sync.refresh", json!({ "accountId": account, "folder": "INBOX" })).unwrap(), json!({ "queued": true }));
    }

    /// Waits until the INBOX list holds `n` rows.
    fn wait_rows(&self, account: &str, n: usize) {
        let deadline = Instant::now() + BUDGET;
        loop {
            let page = self.engine.rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": null, "limit": 500 })).unwrap();
            if page["rows"].as_array().unwrap().len() >= n {
                return;
            }
            assert!(Instant::now() < deadline, "the list never reached {n} rows: {page}");
            std::thread::sleep(Duration::from_millis(30));
        }
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
    assert_eq!(
        f.engine.rpc("mobile.settings.get", json!({})).unwrap(),
        json!({ "notifications": "off", "notificationPreview": true, "language": null, "onboardingComplete": false })
    );
    let set = f.engine.rpc("mobile.settings.set", json!({ "notifications": "on", "notificationPreview": false })).unwrap();
    assert_eq!(set, json!({ "notifications": "on", "notificationPreview": false, "language": null, "onboardingComplete": false }));
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

    // Turned off and on again: a new baseline at what the list holds, so mail that came while
    // it was off (it arrived before the switch) is no flood.
    f.notifications(false);
    deliver_at(&server, "while off", false, now_ms() - 3 * 3_600_000);
    f.notifications(true);
    assert_eq!(f.watermark(&account), Some(2), "turning notifications on starts a new baseline at the list's newest");
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
    // A's server stalls in the middle of its pass (a dead network halfway). A goes first this run
    // (the first account rotates from run to run).
    let mut stall = slow.pause_command("SEARCH");
    let b_logins = other.count_commands("LOGIN");
    f.engine.set_setting("bg.rotation", "0").unwrap();
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

    // The user's Retry signs in again (the password works again) and lifts the hold.
    server.reset_scenario(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    assert_eq!(f.engine.rpc("mobile.accounts.retrySignIn", json!({ "accountId": account })).unwrap(), json!({ "queued": true }));
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

#[test]
fn an_uncommitted_run_returns_its_mail_again_and_a_committed_one_does_not() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());

    deliver(&server, "posted late", false);
    // The platform ended the task before the notifications were posted: nothing is counted.
    let cut = f.run_uncommitted(BUDGET);
    assert_eq!(subjects(&cut.mail), vec!["posted late"]);
    assert!(cut.commit.is_some());
    assert_eq!(f.watermark(&account), Some(1), "the watermark waits for the commit");
    // The next run returns it again; posted and committed, it is never returned again.
    assert_eq!(subjects(&f.run(BUDGET)), vec!["posted late"]);
    assert_eq!(f.watermark(&account), Some(2));
    assert!(f.run(BUDGET).is_empty());
    // A commit token that is spent or unknown changes nothing.
    assert!(f.engine.background_commit("bg-unknown").is_ok());
    // A run with nothing new has nothing to commit.
    assert!(f.run_uncommitted(BUDGET).commit.is_none());
}

#[test]
fn a_message_that_comes_back_under_a_new_uid_is_not_notified_again() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());
    deliver(&server, "only once", false);
    assert_eq!(subjects(&f.run(BUDGET)), vec!["only once"]);

    // The server hands the same message (same Message-ID) back under a new uid, as a missed
    // Graph page or a renumbering does: it is above the watermark, and still not news.
    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let raw = mb.by_uid(2).unwrap().raw.clone();
        mb.expunge(&[2], true);
        let uid = mb.uid_next;
        mb.add(mock_imap::state::Message::new(uid, raw).with_internal_ms(now_ms()));
    });
    assert!(f.run(BUDGET).is_empty(), "notified twice");
    assert_eq!(f.watermark(&account), Some(3));
}

#[test]
fn a_new_uidvalidity_takes_a_new_baseline_and_notifies_no_old_mail() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old one"), msg(2, "old two")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());
    // The server renumbers the folder: new UIDVALIDITY, the same unread mail above the old mark.
    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        mb.uid_validity += 1;
        let old: Vec<Vec<u8>> = mb.messages.iter().map(|m| m.raw.clone()).collect();
        mb.expunge(&[1, 2], false);
        mb.uid_next = 50;
        for raw in old {
            let uid = mb.uid_next;
            mb.add(mock_imap::state::Message::new(uid, raw).with_internal_ms(now_ms() - DAY));
        }
    });
    assert!(f.run(BUDGET).is_empty(), "old mail renumbered is no news");
    assert_eq!(f.watermark(&account), Some(51));
    deliver(&server, "really new", false);
    assert_eq!(subjects(&f.run(BUDGET)), vec!["really new"]);
}

#[test]
fn mail_listed_while_the_app_was_in_front_is_not_notified_after_it_leaves() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());

    // The app comes to the front on the account, lists the new mail, and goes away unread.
    f.engine.rpc("mobile.app.state", json!({ "foreground": true, "accountId": account })).unwrap();
    deliver(&server, "seen in the list", false);
    f.sync(&account);
    f.wait_rows(&account, 2);
    f.engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    assert_eq!(f.watermark(&account), Some(2), "leaving the app moves the watermark past what it showed");
    assert!(f.run(BUDGET).is_empty(), "no notification for mail the user saw in the list");

    // Mail that came after the app left is news.
    deliver(&server, "after leaving", false);
    assert_eq!(subjects(&f.run(BUDGET)), vec!["after leaving"]);
}

#[test]
fn mail_between_turning_notifications_on_and_the_first_run_is_notified() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    // The app has listed the INBOX before the switch.
    f.sync(&account);
    f.wait_rows(&account, 1);
    f.notifications(true);
    assert_eq!(f.watermark(&account), Some(1), "the baseline is taken when notifications are turned on");
    deliver(&server, "right after the switch", false);
    assert_eq!(subjects(&f.run(BUDGET)), vec!["right after the switch"], "not folded into a later baseline");
}

#[test]
fn turning_notifications_on_through_set_setting_takes_the_same_baseline() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.sync(&account);
    f.wait_rows(&account, 1);
    f.engine.set_setting("notifications", "on").unwrap();
    assert!(f.engine.notifications_on());
    assert_eq!(f.watermark(&account), Some(1), "set_setting goes through the settings path");
    // A value the setting does not take is refused there too.
    assert!(f.engine.set_setting("notifications", "maybe").is_err());
    assert!(f.engine.set_setting("notificationPreview", "sometimes").is_err());
}

#[test]
fn one_slow_account_does_not_starve_the_next_one() {
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
    // A's server answers, but slowly: its pass outlives A's share of the budget. A goes first.
    slow.reset_scenario(
        Scenario::new()
            .mailbox(inbox(vec![msg(1, "a old"), msg(2, "a new").with_internal_ms(now_ms())]))
            .fault(Trigger::on("SEARCH"), Action::Delay(Duration::from_millis(4000))),
    );
    f.engine.set_setting("bg.rotation", "0").unwrap();
    let budget = Duration::from_millis(6000);
    let t0 = Instant::now();
    let got = f.run(budget);
    assert!(t0.elapsed() < budget + Duration::from_millis(700), "the run overran: {:?}", t0.elapsed());
    assert_eq!(subjects(&got), vec!["b new"], "B is not starved by A");
    assert_eq!(f.watermark(&a), Some(1), "A's cut-short pass keeps its mail for the next run");
    // The next run starts with the other account, and A's mail comes then.
    slow.reset_scenario(Scenario::new().mailbox(inbox(vec![msg(1, "a old"), msg(2, "a new").with_internal_ms(now_ms())])));
    assert_eq!(subjects(&f.run(BUDGET)), vec!["a new"]);
}

/// A burst bigger than one write chunk whose pass is cut after the first chunk (the run's budget
/// ran out in the middle): the next runs fetch the rest from where the cut pass stopped, oldest
/// first, and every message is notified exactly once.
#[test]
fn a_burst_cut_after_one_chunk_is_fetched_and_notified_in_full_over_the_next_runs() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    f.notifications(true);
    assert!(f.run(BUDGET).is_empty());
    for i in 0..450 {
        deliver(&server, &format!("burst {i}"), false);
    }
    let rows = || -> i64 { f.db().query_row("SELECT count(*) FROM messages WHERE account_id = ?1 AND folder = 'INBOX'", [&account], |r| r.get(0)).unwrap() };
    // The second header chunk stalls past the run's budget.
    let mut stall = server.pause_command_nth("FETCH", 2);
    let got = f.run(Duration::from_millis(2500));
    assert!(stall.entered(Duration::ZERO), "the pass reached its second chunk");
    assert!(got.is_empty(), "a cut pass posts nothing: {:?}", subjects(&got));
    assert_eq!(rows(), 201, "one chunk landed before the cut");
    stall.release();

    let mut seen: Vec<String> = Vec::new();
    for _ in 0..4 {
        let got = f.run(BUDGET);
        if got.is_empty() && rows() == 451 {
            break;
        }
        seen.extend(got.into_iter().map(|m| m.subject));
    }
    assert_eq!(rows(), 451, "every message of the burst was fetched");
    let distinct: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(distinct.len(), seen.len(), "a message was notified twice");
    assert_eq!(seen.len(), 450, "every message of the burst was notified");
    assert!(f.run(BUDGET).is_empty());
}

// ── Scheduled send (plan 4 Task 8, Ruling 13) ───────────────────────────────

const MIN: i64 = 60_000;

impl Fx {
    /// A send held back until `at_ms`; its outbox row id.
    fn schedule(&self, account: &str, subject: &str, at_ms: i64) -> String {
        let r = self
            .engine
            .rpc(
                "mobile.compose.send",
                json!({ "accountId": account, "to": "rcpt@example.test", "cc": "", "bcc": "", "subject": subject, "text": "Later", "attachments": [], "sendAtMs": at_ms }),
            )
            .unwrap();
        assert_eq!(r["state"], "queued", "{r}");
        r["id"].as_str().unwrap().to_string()
    }

    /// Moves row `id`'s time to `at_ms` behind the engine's back (the worker is not woken).
    fn move_time(&self, id: &str, at_ms: i64) {
        assert_eq!(self.db().execute("UPDATE outbox SET not_before_ms = ?2, scheduled_ms = ?2 WHERE id = ?1", rusqlite::params![id, at_ms]).unwrap(), 1);
    }

    fn outbox_state(&self, id: &str) -> Option<String> {
        use rusqlite::OptionalExtension;
        self.db().query_row("SELECT state FROM outbox WHERE id = ?1", [id], |r| r.get(0)).optional().unwrap()
    }
}

#[test]
fn background_run_sends_due_rows_even_with_notifications_off() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old")])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    assert!(!f.engine.notifications_on());
    // Scheduled for later: the engine's worker sleeps until then. The time came while the app was
    // away (the phone was asleep): moved into the past without waking anything.
    let id = f.schedule(&account, "Scheduled", now_ms() + 4 * MIN);
    f.move_time(&id, now_ms() - 1_000);
    std::thread::sleep(Duration::from_millis(300));
    assert!(server.sent_messages().is_empty());

    let run = f.engine.background_fetch(BUDGET).unwrap();
    assert!(run.mail.is_empty() && run.commit.is_none(), "{run:?}");
    assert_eq!(server.sent_messages().len(), 1, "the due row went out inside the run");
    assert_eq!(f.outbox_state(&id).as_deref(), Some("sent"));
    assert_eq!(f.watermark(&account), None, "notifications off: no INBOX pass");

    // Nothing due: the run makes no connection and returns at once.
    let conns = server.connection_count();
    let t0 = Instant::now();
    assert_eq!(f.engine.background_fetch(BUDGET).unwrap(), BackgroundRun::default());
    assert!(t0.elapsed() < Duration::from_secs(1), "{:?}", t0.elapsed());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(server.connection_count(), conns);
    // A row not due yet is left for its time.
    let later = f.schedule(&account, "Later", now_ms() + 4 * MIN);
    f.engine.background_fetch(BUDGET).unwrap();
    assert_eq!(f.outbox_state(&later).as_deref(), Some("queued"));
    assert_eq!(server.sent_messages().len(), 1);
}

#[test]
fn wants_background_follows_scheduled_rows() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![])));
    let f = fx();
    let account = f.add(&server, "u@example.test");
    assert!(!f.engine.wants_background(), "a fresh install asks for no background runs");
    f.notifications(true);
    assert!(f.engine.wants_background());
    f.notifications(false);
    assert!(!f.engine.wants_background());

    // A scheduled row asks for runs until it is gone (Cancel).
    let a = f.schedule(&account, "Cancelled", now_ms() + 4 * MIN);
    assert!(f.engine.wants_background());
    f.engine.rpc("mobile.outbox.discard", json!({ "id": a })).unwrap();
    assert!(!f.engine.wants_background());

    // Send now: no longer scheduled.
    let b = f.schedule(&account, "Now", now_ms() + 4 * MIN);
    assert!(f.engine.wants_background());
    f.engine.rpc("mobile.outbox.retry", json!({ "id": b })).unwrap();
    assert!(!f.engine.wants_background());

    // A scheduled row whose time passed unsent (the phone was offline) still asks.
    let c = f.schedule(&account, "Overdue", now_ms() + 4 * MIN);
    f.move_time(&c, now_ms() - MIN);
    assert!(f.engine.wants_background());
    f.notifications(true);
    f.engine.rpc("mobile.outbox.discard", json!({ "id": c })).unwrap();
    assert!(f.engine.wants_background(), "notifications on still asks");
}
