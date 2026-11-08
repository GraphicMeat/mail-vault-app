//! New mail while the app is open (`mobile.app.state`, `live.rs`): one `mv-engine-live` thread
//! for the foreground account's INBOX. IMAP idles (or polls a STATUS without IDLE), JMAP reads its
//! EventSource, Graph polls the newest message; a change runs the normal INBOX sync. Background
//! or an account switch stops it within 2 s; a refused sign-in backs off, a parked account stops
//! it for good.
//!
//! The waits here are short on purpose (`QUICK`): a feature that does not work fails in seconds.

#[path = "support/graph.rs"]
mod graph_mock;

use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, SecretStore};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a live change may take to land as a `mobile.folder.changed`.
const QUICK: Duration = Duration::from_secs(5);
/// A first sync pass (connect, list, headers).
const SYNC_WAIT: Duration = Duration::from_secs(60);
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
             Message-ID: <live-{uid}@example.com>\n\
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

/// Every event the engine emitted, in order, with a way to wait for one.
#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

impl Events {
    fn len(&self) -> usize {
        self.list.lock().unwrap().len()
    }

    /// The first event at index `from` or later that matches, within `within`.
    fn wait(&self, from: usize, within: Duration, what: &str, pred: impl Fn(&str, &Value) -> bool) -> Value {
        let deadline = Instant::now() + within;
        let mut list = self.list.lock().unwrap();
        loop {
            if let Some((_, v)) = list.iter().skip(from).find(|(n, v)| pred(n, v)) {
                return v.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no {what} event within {within:?}; got {:?}", &list[from.min(list.len())..]);
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
    }

    /// Waits for a sync pass of `account` that started at `from` or later to end idle.
    fn wait_idle(&self, from: usize, account: &str) {
        let end = self.wait(from, SYNC_WAIT, "sync end", |n, v| {
            n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error")
        });
        assert_eq!(end["state"], "idle", "sync ended in error: {end}");
    }

    /// A `mobile.folder.changed` for `account`'s INBOX that added at least one row.
    fn inbox_added(&self, from: usize, account: &str, within: Duration) -> Value {
        self.wait(from, within, "INBOX folder.changed with a new row", |n, v| {
            n == "mobile.folder.changed" && v["accountId"] == account && v["folder"] == "INBOX" && v["added"].as_i64().unwrap_or(0) >= 1
        })
    }
}

fn engine(tmp: &tempfile::TempDir, secrets: Arc<MemorySecrets>) -> (Engine, Arc<Events>, Arc<Mutex<Vec<String>>>) {
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), secrets).unwrap();
    // Short enough for a test, long enough that a busy loop would show.
    engine.set_live_timing(Duration::from_millis(300), Duration::from_secs(25 * 60), Duration::from_millis(100), Duration::from_millis(400));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    let logs: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = Arc::clone(&logs);
    assert!(engine.set_log_sink(move |line| l.lock().unwrap().push(line.to_string())));
    (engine, events, logs)
}

fn wait_until(within: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out after {within:?} waiting for: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ── IMAP ────────────────────────────────────────────────────────────────────

struct Fx {
    tmp: tempfile::TempDir,
    engine: Engine,
    events: Arc<Events>,
    logs: Arc<Mutex<Vec<String>>>,
}

fn imap_engine() -> Fx {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let (engine, events, logs) = engine(&tmp, Arc::new(MemorySecrets::default()));
    Fx { tmp, engine, events, logs }
}

impl Fx {
    fn add_imap(&self, server: &MockImap) -> String {
        self.add_imap_as(server, "u@example.test")
    }

    fn add_imap_as(&self, server: &MockImap, email: &str) -> String {
        let added = self
            .engine
            .rpc(
                "mobile.accounts.add",
                json!({ "email": email, "password": "pw-live-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        assert_eq!(added["ok"], true, "{added}");
        added["account"]["id"].as_str().unwrap().to_string()
    }

    fn sync(&self, account: &str) {
        let from = self.events.len();
        assert_eq!(self.engine.rpc("mobile.sync.refresh", json!({ "accountId": account })).unwrap(), json!({ "queued": true }));
        self.events.wait_idle(from, account);
    }

    fn app_state(&self, foreground: bool, account: Option<&str>) -> Value {
        let mut p = json!({ "foreground": foreground });
        if let Some(a) = account {
            p["accountId"] = json!(a);
        }
        self.engine.rpc("mobile.app.state", p).unwrap()
    }

    fn app_state_resumed(&self, account: Option<&str>) -> Value {
        let mut p = json!({ "foreground": true, "resumed": true });
        if let Some(a) = account {
            p["accountId"] = json!(a);
        }
        self.engine.rpc("mobile.app.state", p).unwrap()
    }

    fn subjects(&self, account: &str) -> Vec<String> {
        let page = self
            .engine
            .rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": null, "limit": 50 }))
            .unwrap();
        page["rows"].as_array().unwrap().iter().map(|r| r["subject"].as_str().unwrap().to_string()).collect()
    }

    fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().clone()
    }
}

fn deliver(server: &MockImap, subject: &str) {
    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        mb.add(msg(uid, subject));
    });
}

#[test]
fn idle_new_mail_lands_without_a_refresh() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.sync(&account);

    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles on INBOX", || server.count_commands("IDLE") >= 1);
    assert!(f.engine.live_running());

    let from = f.events.len();
    deliver(&server, "arrived live");
    // No mobile.sync.refresh from here on: the IDLE wakes the sync.
    let changed = f.events.inbox_added(from, &account, QUICK);
    assert_eq!(changed["added"], 1, "{changed}");
    assert!(f.subjects(&account).contains(&"arrived live".to_string()));
    // Back in IDLE after the change: one wake-up does not end the watch.
    wait_until(QUICK, "IDLE issued again", || server.count_commands("IDLE") >= 2);
    assert!(f.engine.live_running(), "logs {:?}", f.logs());
}

#[test]
fn backgrounding_stops_idle_within_two_seconds() {
    let a_server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a")])));
    let b_server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "b")])));
    let f = imap_engine();
    let a = f.add_imap(&a_server);
    let b = f.add_imap_as(&b_server, "b@example.test");

    // Backgrounding: the RPC returns at once, the IDLE ends with DONE and the thread is gone
    // within 2 s.
    f.app_state(true, Some(&a));
    wait_until(QUICK, "A idles", || a_server.count_commands("IDLE") >= 1);
    let t0 = Instant::now();
    f.app_state(false, None);
    assert!(t0.elapsed() < Duration::from_millis(200), "mobile.app.state waited on the live thread: {:?}", t0.elapsed());
    wait_until(Duration::from_secs(2), "A's IDLE ended with DONE", || a_server.count_commands("DONE") >= 1);
    wait_until(Duration::from_secs(2).saturating_sub(t0.elapsed()), "the live thread exited", || !f.engine.live_running());
    let idles = a_server.count_commands("IDLE");
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(a_server.count_commands("IDLE"), idles, "a backgrounded app idles no more");

    // A switch: A stops, B starts, never both listening for long.
    f.app_state(true, Some(&a));
    wait_until(QUICK, "A idles again", || a_server.count_commands("IDLE") > idles);
    let dones = a_server.count_commands("DONE");
    let t1 = Instant::now();
    f.app_state(true, Some(&b));
    assert!(t1.elapsed() < Duration::from_millis(200), "the switch waited on the live thread: {:?}", t1.elapsed());
    wait_until(Duration::from_secs(2), "A's IDLE ended on the switch", || a_server.count_commands("DONE") > dones);
    wait_until(QUICK, "B idles", || b_server.count_commands("IDLE") >= 1);
    assert!(f.engine.live_running());

    // Foreground again on the same account: no new connection.
    let conns = b_server.connection_count();
    f.app_state(true, Some(&b));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(b_server.connection_count(), conns, "a repeated foreground churned the connection");
    f.app_state(false, None);
    wait_until(Duration::from_secs(2), "B stopped", || !f.engine.live_running());
}

#[test]
fn an_idle_the_server_drops_reconnects_without_spinning() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles", || server.count_commands("IDLE") >= 1);
    let conns = server.connection_count();
    // The server hangs up on its idlers (a restart, a NAT timeout).
    server.mutate(|st| st.idle_drops += 1);
    wait_until(QUICK, "a new connection that idles again", || server.connection_count() > conns && server.count_commands("IDLE") >= 2);
    let from = f.events.len();
    deliver(&server, "after the drop");
    f.events.inbox_added(from, &account, QUICK);
    assert!(f.engine.live_running(), "logs {:?}", f.logs());
}

#[test]
fn a_listening_account_that_gets_parked_stops_at_its_next_wake() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.sync(&account);
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles", || server.count_commands("IDLE") >= 1);
    // Another worker parks the account (a grant revoked) while the IDLE itself is healthy.
    let db = rusqlite::Connection::open(f.tmp.path().join("mobile.db")).unwrap();
    db.execute("UPDATE accounts SET needs_auth = 1 WHERE id = ?1", [&account]).unwrap();
    let logins = server.count_commands("LOGIN");
    deliver(&server, "wakes the listener");
    wait_until(Duration::from_secs(2), "the parked account's listener stopped", || !f.engine.live_running());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(server.count_commands("LOGIN"), logins, "a parked account is never dialled");
}

#[test]
fn removing_the_listening_account_stops_its_thread() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles", || server.count_commands("IDLE") >= 1);
    f.engine.rpc("mobile.accounts.remove", json!({ "accountId": account })).unwrap();
    wait_until(Duration::from_secs(2), "the removed account's listener stopped", || !f.engine.live_running());
}

#[test]
fn a_server_without_idle_polls_instead() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])).without_cap("IDLE"));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.sync(&account);

    f.app_state(true, Some(&account));
    // The poll is a STATUS of INBOX every 300 ms here (60 s in the app).
    wait_until(QUICK, "two polls", || server.count_commands("STATUS INBOX") + server.count_commands("STATUS \"INBOX\"") >= 2);
    assert_eq!(server.count_commands("IDLE"), 0, "it must not try IDLE");

    let from = f.events.len();
    deliver(&server, "polled in");
    f.events.inbox_added(from, &account, QUICK);
    assert!(f.subjects(&account).contains(&"polled in".to_string()));
    f.app_state(false, None);
    wait_until(Duration::from_secs(2), "the poller stopped", || !f.engine.live_running());
}

#[test]
fn a_refused_password_is_tried_once_per_foreground() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.sync(&account);
    server.reset_scenario(
        Scenario::new()
            .mailbox(inbox(vec![msg(1, "first")]))
            .fault(Trigger::on("LOGIN"), Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())),
    );
    let logins = server.count_commands("LOGIN");

    // Servers ban an address after a few failed logins: one try, then nothing while in front.
    f.app_state(true, Some(&account));
    wait_until(Duration::from_secs(2), "the thread gave up on the refused password", || !f.engine.live_running());
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(server.count_commands("LOGIN") - logins, 1, "logs {:?}", f.logs());
    // The refusal holds the account for every worker: a return to the front does not dial it
    // again (only the user's Retry does).
    f.app_state_resumed(Some(&account));
    wait_until(Duration::from_secs(2), "the resumed thread ended", || !f.engine.live_running());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(server.count_commands("LOGIN") - logins, 1);
}

#[test]
fn a_failing_listener_backs_off() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.sync(&account);
    // Sign-in works, the listen fails every time.
    server.reset_scenario(
        Scenario::new().mailbox(inbox(vec![msg(1, "first")])).fault(Trigger::on("SELECT"), Action::Respond("NO".into(), "[UNAVAILABLE] try later".into())),
    );
    let logins = server.count_commands("LOGIN");
    f.app_state(true, Some(&account));
    std::thread::sleep(Duration::from_millis(2000));
    let tried = server.count_commands("LOGIN") - logins;
    // 100 ms doubling to 400 ms: about 6 connects in 2 s, each with its catch-up pass's own
    // sign-in. A fast reconnect loop would be hundreds.
    assert!(tried >= 2, "it retried {tried} times; logs {:?}", f.logs());
    assert!(tried <= 20, "it retried {tried} times in 2 s: no backoff");
    assert!(f.engine.live_running());
    f.app_state(false, None);
    wait_until(Duration::from_secs(2), "stopped", || !f.engine.live_running());
}

#[test]
fn a_parked_account_is_never_dialled() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    let db = rusqlite::Connection::open(f.tmp.path().join("mobile.db")).unwrap();
    db.execute("UPDATE accounts SET needs_auth = 1 WHERE id = ?1", [&account]).unwrap();
    let logins = server.count_commands("LOGIN");
    f.app_state(true, Some(&account));
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(server.count_commands("LOGIN"), logins);
    assert!(!f.engine.live_running());
}

#[test]
fn a_park_by_another_worker_ends_a_healthy_idle_within_a_second() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles", || server.count_commands("IDLE") >= 1);
    let t0 = Instant::now();
    // As a refused grant parks it: no mail arrives to wake the IDLE.
    f.engine.park_account_for_tests(&account);
    wait_until(Duration::from_secs(2), "the IDLE ended", || server.count_commands("DONE") >= 1);
    wait_until(Duration::from_secs(2), "the listener stopped", || !f.engine.live_running());
    assert!(t0.elapsed() < Duration::from_millis(1500), "took {:?}", t0.elapsed());
}

#[test]
fn a_resume_replaces_the_listening_connection() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles", || server.count_commands("IDLE") >= 1);
    std::thread::sleep(Duration::from_millis(1100));
    // Back to the front: the socket may have died silently while away; it is replaced.
    let conns = server.connection_count();
    f.app_state_resumed(Some(&account));
    wait_until(QUICK, "a new connection idles", || server.connection_count() > conns && server.count_commands("IDLE") >= 2);
    // The shell's OS events name no account: suspend stops, resume picks the last one again.
    std::thread::sleep(Duration::from_millis(1100));
    f.app_state(false, None);
    wait_until(Duration::from_secs(2), "suspended", || !f.engine.live_running());
    let idles = server.count_commands("IDLE");
    f.app_state_resumed(None);
    wait_until(QUICK, "resumed on the last account", || server.count_commands("IDLE") > idles);
    let from = f.events.len();
    deliver(&server, "after resume");
    f.events.inbox_added(from, &account, QUICK);
}

#[test]
fn a_stale_shell_lifecycle_call_is_ignored() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the live thread idles", || server.count_commands("IDLE") >= 1);
    std::thread::sleep(Duration::from_millis(1100));
    // A notification-shade pull: suspend (1) then resume (2), delivered resume first.
    let rpc = |p: Value| f.engine.rpc("mobile.app.state", p).unwrap();
    assert_eq!(rpc(json!({ "foreground": true, "resumed": true, "seq": 2 }))["live"], true);
    assert_eq!(rpc(json!({ "foreground": false, "seq": 1 })), json!({ "live": false, "stale": true }));
    let idles = server.count_commands("IDLE");
    std::thread::sleep(Duration::from_millis(800));
    assert!(f.engine.live_running(), "the stale suspend turned live mail off while in front");
    wait_until(QUICK, "still listening", || server.count_commands("IDLE") >= idles);
    // In order, both apply; the page's calls (no seq) are never stale.
    assert_eq!(rpc(json!({ "foreground": false, "seq": 3 }))["live"], false);
    wait_until(Duration::from_secs(2), "suspended", || !f.engine.live_running());
    assert_eq!(f.app_state(true, Some(&account))["live"], true);
    wait_until(QUICK, "listening again", || f.engine.live_running() && server.count_commands("IDLE") > idles);
}

#[test]
fn a_thread_stopped_during_its_sign_in_does_nothing_after_it() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "first")])));
    let f = imap_engine();
    let account = f.add_imap(&server);
    server.reset_scenario(Scenario::new().mailbox(inbox(vec![msg(1, "first")])).fault(Trigger::on("LOGIN"), Action::Delay(Duration::from_millis(800))));
    let from = f.events.len();
    f.app_state(true, Some(&account));
    wait_until(QUICK, "the sign-in is on the wire", || server.count_commands("LOGIN") >= 1);
    f.app_state(false, None);
    wait_until(Duration::from_secs(3), "the thread ended", || !f.engine.live_running());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(server.count_commands("SELECT"), 0, "{:?}", server.commands());
    assert_eq!(server.count_commands("IDLE"), 0);
    let queued = f.events.list.lock().unwrap().iter().skip(from).filter(|(n, v)| n == "mobile.sync.state" && v["accountId"] == account).count();
    assert_eq!(queued, 0, "a stopped thread queued its catch-up pass");
}

// ── JMAP ────────────────────────────────────────────────────────────────────

#[test]
fn jmap_event_source_triggers_a_sync() {
    use mock_jmap::{MockJmap, Scenario as JScenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
    const ME: &str = "me@example.test";
    const PASSWORD: &str = "app-pass-live";
    let raw = |subject: &str| {
        format!("From: Alice <alice@example.test>\r\nTo: {ME}\r\nSubject: {subject}\r\nMessage-ID: <{}@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody.\r\n", subject.replace(' ', "-"))
    };
    let email = |id: &str, subject: &str| ScenarioEmail {
        id: id.into(),
        raw: raw(subject),
        keywords: vec![],
        received_at: mock_jmap::state::iso8601(now_ms() / 1000 - 3600),
        also_in: vec![],
    };
    let mailbox = |id: &str, name: &str, role: Option<&str>, emails: Vec<ScenarioEmail>| ScenarioMailbox {
        id: id.into(),
        name: name.into(),
        parent_id: None,
        role: role.map(String::from),
        emails,
    };
    let m = MockJmap::start(JScenario {
        accounts: vec![ScenarioAccount {
            username: ME.into(),
            password: PASSWORD.into(),
            token: None,
            mailboxes: vec![mailbox("mb-inbox", "Inbox", Some("inbox"), vec![email("m001", "first")]), mailbox("mb-trash", "Trash", Some("trash"), vec![])],
            identities: vec![(ME.into(), "Me".into())],
        }],
        ..JScenario::default()
    });
    let tmp = tempfile::tempdir().unwrap();
    let (engine, events, logs) = engine(&tmp, Arc::new(MemorySecrets::default()));
    engine.allow_jmap_loopback();
    let r = engine.rpc("mobile.accounts.add", json!({ "kind": "jmap", "email": ME, "password": PASSWORD, "jmapUrl": m.session_url() })).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let account = r["account"]["id"].as_str().unwrap().to_string();
    let from = events.len();
    engine.rpc("mobile.sync.refresh", json!({ "accountId": account })).unwrap();
    events.wait_idle(from, &account);

    engine.rpc("mobile.app.state", json!({ "foreground": true, "accountId": account })).unwrap();
    let streams = || m.requests().iter().filter(|r| r.path.contains("/jmap/eventsource")).count();
    wait_until(QUICK, "an EventSource stream", || streams() >= 1);
    let es = m.requests().into_iter().find(|r| r.path.contains("/jmap/eventsource")).unwrap();
    assert!(es.path.contains("types=Email%2CMailbox") || es.path.contains("types=Email,Mailbox"), "{}", es.path);
    assert!(es.path.contains("ping=60"), "{}", es.path);
    // Let the catch-up pass that follows a connect settle first.
    std::thread::sleep(Duration::from_millis(500));

    let from = events.len();
    m.mutate(|st| st.add_email("acc1", "mb-inbox", email("m002", "pushed")));
    events.inbox_added(from, &account, QUICK);
    assert_eq!(streams(), 1, "the stream stays open across a change; logs {:?}", logs.lock().unwrap());

    engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    wait_until(Duration::from_secs(2), "the stream reader stopped", || !engine.live_running());
}

// ── Graph ───────────────────────────────────────────────────────────────────

#[test]
fn graph_polls_with_one_cheap_request_per_interval() {
    const ME: &str = "owner@outlook.com";
    const ACCOUNT: &str = "acc_00000000000000lv";
    let g = graph_mock::mock();
    let _serial = graph_mock::serial();
    g.reset(ME);
    g.add_message("inbox", "older", now_ms() - 2 * DAY, "<p>older</p>");
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events, logs) = engine(&tmp, Arc::clone(&secrets));
    engine.set_oauth_token_endpoint(&g.token_endpoint());
    rusqlite::Connection::open(tmp.path().join("mobile.db"))
        .unwrap()
        .execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms)
             VALUES (?1, ?2, ?2, 'outlook.office365.com', 993, 'ssl', 'graph', 'oauth2', 'microsoft', 0, 1)",
            [ACCOUNT, ME],
        )
        .unwrap();
    let (refresh, access, expires) = g.grant();
    secrets.set(ACCOUNT, &Credential::from_tokens(&refresh, &access, expires).to_secret()).unwrap();
    let from = events.len();
    engine.rpc("mobile.sync.refresh", json!({ "accountId": ACCOUNT })).unwrap();
    events.wait_idle(from, ACCOUNT);

    let from = events.len();
    engine.rpc("mobile.app.state", json!({ "foreground": true, "accountId": ACCOUNT })).unwrap();
    // The catch-up pass a connect runs, then nothing but the poll.
    events.wait_idle(from, ACCOUNT);
    std::thread::sleep(Duration::from_millis(200));
    g.clear_requests();
    std::thread::sleep(Duration::from_millis(1600));
    let reqs: Vec<String> = g.requests().into_iter().filter(|r| !r.contains("/oauth/")).collect();
    // 300 ms apart here (60 s in the app): about 5 in 1.6 s, each the newest message only.
    assert!((3..=8).contains(&reqs.len()), "{} requests in 1.6 s: {reqs:?}; logs {:?}", reqs.len(), logs.lock().unwrap());
    for r in &reqs {
        assert!(r.contains("$top=1") && r.contains("lastModifiedDateTime") && !r.contains("receivedDateTime ge"), "not a cheap check: {r}");
    }

    let from = events.len();
    g.add_message("inbox", "polled in", now_ms(), "<p>new</p>");
    events.inbox_added(from, ACCOUNT, QUICK);

    engine.rpc("mobile.app.state", json!({ "foreground": false })).unwrap();
    wait_until(Duration::from_secs(2), "the poller stopped", || !engine.live_running());
}
