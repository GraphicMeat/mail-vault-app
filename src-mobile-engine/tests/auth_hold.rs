//! A refused password (or app password, or JMAP token) holds the account engine-wide: after one
//! refused sign-in no worker (sync, live, outbox, replay, background) dials the server again until
//! the user's Retry, which tries exactly once. Servers ban an address after a few failed logins
//! (fail2ban), and the app has many workers. A temporary refusal (`NO [UNAVAILABLE]`) is not a
//! refused password.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(30);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn msg(uid: u32, subject: &str) -> Message {
    Message::new(
        uid,
        format!(
            "From: Sender <sender@example.com>\nTo: user@example.com\nSubject: {subject}\nDate: Thu, 01 Jan 2026 12:00:00 +0000\nMessage-ID: <hold-{uid}@example.com>\n\nBody {uid}.\n"
        ),
    )
    .with_internal_ms(now_ms() - 3_600_000)
}

fn scenario() -> Scenario {
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(msg(1, "first"));
    inbox.add(msg(2, "second"));
    Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]))
}

fn refusing(text: &str) -> Scenario {
    scenario().fault(Trigger::on("LOGIN"), Action::Respond("NO".into(), text.into()))
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
}

struct Fx {
    _tmp: tempfile::TempDir,
    engine: Engine,
    events: Arc<Events>,
    logs: Arc<Mutex<Vec<String>>>,
    account: String,
}

fn setup(server: &MockImap) -> Fx {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
    // Every retry path as fast as a test can make it: a held account must stay quiet anyway.
    engine.set_action_backoff(Duration::from_millis(20), Duration::from_millis(60));
    engine.set_outbox_backoff(Duration::from_millis(20), Duration::from_millis(60));
    engine.set_live_timing(Duration::from_millis(100), Duration::from_secs(25 * 60), Duration::from_millis(20), Duration::from_millis(60));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    let logs: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = Arc::clone(&logs);
    assert!(engine.set_log_sink(move |line| l.lock().unwrap().push(line.to_string())));
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": "pw-hold-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fx { _tmp: tmp, engine, events, logs, account }
}

impl Fx {
    /// A refresh of INBOX and its end event.
    fn sync(&self) -> Value {
        let from = self.events.len();
        assert_eq!(self.engine.rpc("mobile.sync.refresh", json!({ "accountId": self.account, "folder": "INBOX" })).unwrap(), json!({ "queued": true }));
        let account = self.account.clone();
        self.events.wait(from, "sync end", move |n, v| {
            n == "mobile.sync.state" && v["accountId"] == account.as_str() && (v["state"] == "idle" || v["state"] == "error")
        })
    }

    fn account_row(&self) -> Value {
        let list = self.engine.rpc("mobile.accounts.list", json!({})).unwrap();
        list["accounts"].as_array().unwrap().iter().find(|a| a["id"] == self.account.as_str()).cloned().unwrap()
    }

    fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().clone()
    }
}

#[test]
fn a_refused_password_is_not_dialled_again_by_any_worker_until_retry() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    assert_eq!(f.sync()["state"], "idle");
    // A read queued while the server still took the password.
    let page = f.engine.rpc("mobile.messages.page", json!({ "accountId": f.account, "folder": "INBOX", "cursor": null, "limit": 10 })).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2, "{page}");

    // The password was changed on the server.
    server.reset_scenario(refusing("[AUTHENTICATIONFAILED] Invalid credentials"));
    let end = f.sync();
    assert_eq!((end["state"].as_str(), end["code"].as_str()), (Some("error"), Some("AUTH_FAILED")), "{end}");
    assert_eq!(server.count_commands("LOGIN"), 1);
    assert_eq!(f.account_row()["authRefused"], true, "the account says its password was refused");

    // Everything that would dial: a send, an action, the app coming to the front three times,
    // refreshes, a background run. With every backoff at milliseconds this is many minutes of
    // retries compressed.
    f.engine.rpc("mobile.settings.set", json!({ "notifications": "on" })).unwrap();
    let sent = f.engine.rpc(
        "mobile.compose.send",
        json!({ "accountId": f.account, "to": "rcpt@example.test", "cc": "", "bcc": "", "subject": "Held", "text": "waits", "attachments": [] }),
    );
    assert!(sent.is_ok(), "{sent:?}");
    f.engine.rpc("mobile.actions.apply", json!({ "accountId": f.account, "folder": "INBOX", "uids": [1], "kind": "seen" })).unwrap();
    for _ in 0..3 {
        f.engine.rpc("mobile.app.state", json!({ "foreground": true, "accountId": f.account, "resumed": true })).unwrap();
        let end = f.sync();
        assert_eq!(end["code"], "AUTH_FAILED", "{end}");
        std::thread::sleep(Duration::from_millis(300));
        f.engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    }
    let run = f.engine.background_fetch(Duration::from_secs(5)).unwrap();
    assert!(run.mail.is_empty());
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(server.count_commands("LOGIN"), 1, "no worker tried the refused password again; logs {:?}", f.logs());

    // Retry, the password still wrong: exactly one more try.
    assert_eq!(f.engine.rpc("mobile.accounts.retrySignIn", json!({ "accountId": f.account })).unwrap(), json!({ "queued": true }));
    let deadline = Instant::now() + WAIT;
    while server.count_commands("LOGIN") < 2 {
        assert!(Instant::now() < deadline, "Retry never tried");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(server.count_commands("LOGIN"), 2, "Retry tries exactly once; logs {:?}", f.logs());
    assert_eq!(f.account_row()["authRefused"], true);

    // The password works again: Retry signs in, and the queued send and read go out on their own.
    server.reset_scenario(scenario());
    let from = f.events.len();
    f.engine.rpc("mobile.accounts.retrySignIn", json!({ "accountId": f.account })).unwrap();
    f.events.wait(from, "the queued send", |n, v| n == "mobile.send.result" && v["outcome"] == "sent");
    let deadline = Instant::now() + WAIT;
    loop {
        let pending = f.engine.rpc("mobile.actions.pending", json!({ "accountId": f.account })).unwrap();
        if pending["pending"].as_array().unwrap().is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "the queued read never went out: {pending}; logs {:?}", f.logs());
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(f.account_row()["authRefused"], false);
    assert_eq!(server.sent_messages().len(), 1);
}

#[test]
fn a_temporary_no_is_not_a_refused_password() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    assert_eq!(f.sync()["state"], "idle");
    server.reset_scenario(refusing("[UNAVAILABLE] Temporary System Problem"));
    let end = f.sync();
    assert_eq!(end["state"], "error");
    assert_ne!(end["code"], "AUTH_FAILED", "a temporary refusal is no wrong password: {end}");
    assert_eq!(f.account_row()["authRefused"], false);
    // The next pass tries again (and the server is back).
    server.reset_scenario(scenario());
    assert_eq!(f.sync()["state"], "idle");
}

#[test]
fn retry_on_an_account_that_is_not_held_is_one_pass() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let r = f.engine.rpc("mobile.accounts.retrySignIn", json!({ "accountId": f.account })).unwrap();
    assert_eq!(r, json!({ "queued": true }));
    let err = f.engine.rpc("mobile.accounts.retrySignIn", json!({ "accountId": "acc_nope" })).unwrap_err();
    assert_eq!(err.code(), "INVALID");
}
