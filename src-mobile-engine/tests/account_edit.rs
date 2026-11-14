//! An account's own sending setup on the phone, against the mock IMAP server and its SMTP side:
//! a password account's password and servers changed in place (`mobile.accounts.update`, tested
//! before anything is stored, the refused-password hold lifted), the From a message goes out
//! under (the login, `sendAs` or an alias), and the folder its Sent copy is filed in
//! (`sentFolder`).

use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, RpcError, SecretStore};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(60);
const PASSWORD: &str = "pw-account-edit-0ld-s3cret";
const NEW_PASSWORD: &str = "pw-account-edit-n3w-s3cret";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn scenario() -> Scenario {
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(Message::new(1, "From: a@example.com\nSubject: hi\nMessage-ID: <e1@example.com>\n\nhi\n".to_string()));
    Scenario::new()
        .mailbox(inbox)
        .mailbox(Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]))
        .mailbox(Mailbox::new("Custom Sent").with_attrs(&["\\HasNoChildren"]))
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

    fn send_result(&self, from: usize, id: &str, outcome: &str) -> Value {
        let deadline = Instant::now() + WAIT;
        let mut list = self.list.lock().unwrap();
        loop {
            if let Some((_, v)) = list.iter().skip(from).find(|(n, v)| n == "mobile.send.result" && v["id"] == id && v["outcome"] == outcome) {
                return v.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no send.result {outcome} for {id}; got {:?}", &list[from.min(list.len())..]);
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
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
    engine.set_outbox_backoff(Duration::from_millis(50), Duration::from_millis(200));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    (engine, events)
}

fn servers(server: &MockImap) -> Value {
    json!({ "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" })
}

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events) = open(tmp.path(), &secrets);
    let mut form = servers(server);
    form["email"] = json!("u@example.test");
    form["password"] = json!(PASSWORD);
    form["displayName"] = json!("Una User");
    let added = engine.rpc("mobile.accounts.add", form).unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fixture { tmp, secrets, engine, events, account }
}

impl Fixture {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    fn update(&self, password: &str, server: &MockImap) -> Result<Value, RpcError> {
        let mut p = servers(server);
        p["accountId"] = json!(self.account);
        p["password"] = json!(password);
        self.engine.rpc("mobile.accounts.update", p)
    }

    fn stored_password(&self) -> Option<String> {
        let secret = self.secrets.get(&self.account).unwrap()?;
        Credential::parse(&secret).password
    }

    fn account_row(&self) -> Value {
        let list = self.engine.rpc("mobile.accounts.list", json!({})).unwrap();
        list["accounts"].as_array().unwrap().iter().find(|a| a["id"] == self.account.as_str()).unwrap().clone()
    }

    fn set(&self, values: Value) -> Value {
        self.engine.rpc("mobile.accountSettings.set", json!({ "accountId": self.account, "values": values })).unwrap()
    }

    fn send(&self, mut params: Value) -> Result<Value, RpcError> {
        params["accountId"] = json!(self.account);
        for k in ["cc", "bcc", "text"] {
            if params.get(k).is_none() {
                params[k] = json!("");
            }
        }
        params["attachments"] = json!([]);
        self.engine.rpc("mobile.compose.send", params)
    }

    /// Sends `params` and waits until it went out; the raw bytes SMTP took.
    fn send_and_wait(&self, server: &MockImap, params: Value) -> String {
        let before = server.sent_messages().len();
        let from = self.events.len();
        let id = self.send(params).unwrap()["id"].as_str().unwrap().to_string();
        self.events.send_result(from, &id, "sent");
        let sent = server.sent_messages();
        assert_eq!(sent.len(), before + 1, "exactly one message went out");
        String::from_utf8_lossy(sent.last().unwrap()).into_owned()
    }

    fn hold(&self) {
        self.db().execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')", [format!("bg.authRefused.{}", self.account)]).unwrap();
        self.db().execute("UPDATE accounts SET needs_auth = 1 WHERE id = ?1", [&self.account]).unwrap();
    }

    fn held(&self) -> bool {
        self.db()
            .query_row("SELECT count(*) FROM settings WHERE key = ?1", [format!("bg.authRefused.{}", self.account)], |r| r.get::<_, i64>(0))
            .unwrap()
            > 0
    }
}

fn from_line(raw: &str) -> String {
    raw.lines().find(|l| l.to_ascii_lowercase().starts_with("from:")).unwrap_or_else(|| panic!("no From in {raw}")).to_string()
}

fn code(r: Result<Value, RpcError>) -> String {
    match r {
        Ok(v) => panic!("expected an error, got {v}"),
        Err(e) => e.code().to_string(),
    }
}

/// A closed port on this machine: nothing answers there.
fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

// ── mobile.accounts.update ──────────────────────────────────────────────────

/// A password the server refuses is never stored: the old one stays, and so does the hold.
#[test]
fn a_refused_new_password_changes_nothing() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.hold();
    server.reset_scenario(scenario().fault(Trigger::on("LOGIN"), Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())));
    let r = f.update(NEW_PASSWORD, &server).unwrap();
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["code"], "AUTH_FAILED", "{r}");
    assert!(!r.to_string().contains(NEW_PASSWORD), "the password is in the reply: {r}");
    assert_eq!(f.stored_password().as_deref(), Some(PASSWORD));
    assert!(f.held(), "a refused password lifted the hold");
}

/// A password the server takes is stored, the refused-password hold and `needsAuth` go, and the
/// account syncs and sends with it. The secret is in no reply and no row of mobile.db.
#[test]
fn a_good_new_password_is_stored_and_lifts_the_hold() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.hold();
    let r = f.update(NEW_PASSWORD, &server).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    assert!(!r.to_string().contains(NEW_PASSWORD), "the password is in the reply: {r}");
    assert_eq!(f.stored_password().as_deref(), Some(NEW_PASSWORD));
    assert!(!f.held(), "the hold stayed");
    let row = f.account_row();
    assert_eq!(row["needsAuth"], false, "{row}");
    assert_eq!(row["authRefused"], false, "{row}");
    let raw = f.send_and_wait(&server, json!({ "to": "rcpt@example.test", "subject": "After the change" }));
    assert!(raw.contains("After the change"));
    let db = std::fs::read(f.tmp.path().join("mobile.db")).unwrap();
    assert!(!String::from_utf8_lossy(&db).contains(NEW_PASSWORD), "the password reached mobile.db");
}

/// A blank password keeps the stored one (only the servers change).
#[test]
fn a_blank_password_keeps_the_stored_one() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let r = f.update("", &server).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(f.stored_password().as_deref(), Some(PASSWORD));
}

/// New servers are tested before they are stored: one nobody answers on changes nothing; ones
/// that work are stored and used for the next send.
#[test]
fn new_servers_are_tested_then_used() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let mut p = servers(&server);
    p["accountId"] = json!(f.account);
    p["password"] = json!("");
    p["imapPort"] = json!(dead_port());
    let r = f.engine.rpc("mobile.accounts.update", p).unwrap();
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["code"], "HOST_UNREACHABLE", "{r}");
    assert_eq!(f.account_row()["imapPort"], server.port());

    let mut p = servers(&server);
    p["accountId"] = json!(f.account);
    p["password"] = json!("");
    p["smtpPort"] = json!(dead_port());
    let r = f.engine.rpc("mobile.accounts.update", p).unwrap();
    assert_eq!(r["code"], "SMTP_FAILED", "{r}");
    assert_eq!(f.account_row()["smtpPort"], server.smtp_port());

    let moved = MockImap::start(scenario());
    let r = f.update("", &moved).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let row = f.account_row();
    assert_eq!(row["imapPort"], moved.port(), "{row}");
    assert_eq!(row["smtpPort"], moved.smtp_port(), "{row}");
    f.send_and_wait(&moved, json!({ "to": "rcpt@example.test", "subject": "Through the new server" }));
    assert!(server.sent_messages().is_empty(), "the old server still sent");
}

/// Only a password IMAP account has a password and servers to change here.
#[test]
fn an_oauth_or_unknown_account_is_refused() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let mut p = servers(&server);
    p["accountId"] = json!("acc_nope");
    p["password"] = json!(NEW_PASSWORD);
    assert_eq!(code(f.engine.rpc("mobile.accounts.update", p)), "INVALID");
    f.db().execute("UPDATE accounts SET auth = 'oauth2' WHERE id = ?1", [&f.account]).unwrap();
    assert_eq!(code(f.update(NEW_PASSWORD, &server)), "INVALID");
}

// ── From ────────────────────────────────────────────────────────────────────

/// The From picked in compose goes out, with the alias's own name.
#[test]
fn a_message_goes_out_from_the_chosen_alias() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.set(json!({ "aliases": [{ "address": "alias@example.test", "name": "Alias Name" }] }));
    let raw = f.send_and_wait(&server, json!({ "to": "rcpt@example.test", "subject": "As alias", "from": "Alias@Example.test" }));
    let from = from_line(&raw);
    assert!(from.to_ascii_lowercase().contains("<alias@example.test>"), "{from}");
    assert!(from.contains("Alias Name"), "{from}");

    // No From: the login, under the account's name.
    let raw = f.send_and_wait(&server, json!({ "to": "rcpt@example.test", "subject": "As login" }));
    let from = from_line(&raw);
    assert!(from.contains("<u@example.test>"), "{from}");
    assert!(from.contains("Una User"), "{from}");
}

/// No From picked: `sendAs` when the account has one.
#[test]
fn send_as_is_the_default_from() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.set(json!({ "sendAs": "me@example.test" }));
    let raw = f.send_and_wait(&server, json!({ "to": "rcpt@example.test", "subject": "Default" }));
    assert!(from_line(&raw).contains("<me@example.test>"), "{raw}");
    assert!(!raw.contains("u@example.test"), "the login leaked into the message: {raw}");
}

/// A From that is not the account's is refused before anything is queued.
#[test]
fn a_from_the_account_does_not_have_is_refused() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    assert_eq!(code(f.send(json!({ "to": "rcpt@example.test", "subject": "x", "from": "stranger@example.test" }))), "INVALID");
    let rows: i64 = f.db().query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}

/// A draft keeps its From.
#[test]
fn a_draft_keeps_its_from() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.set(json!({ "aliases": [{ "address": "alias@example.test", "name": "" }] }));
    let saved = f
        .engine
        .rpc("mobile.drafts.save", json!({ "accountId": f.account, "to": "", "cc": "", "bcc": "", "subject": "d", "text": "", "attachments": [], "from": "alias@example.test" }))
        .unwrap();
    let got = f.engine.rpc("mobile.drafts.get", json!({ "id": saved["id"] })).unwrap();
    assert_eq!(got["from"], "alias@example.test", "{got}");
}

/// An alias removed while its message waits: the message still goes out from the address it was
/// written from (checked when it was queued), under the account's name.
#[test]
fn a_queued_message_keeps_its_alias_after_the_alias_is_removed() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.set(json!({ "aliases": [{ "address": "alias@example.test", "name": "Alias Name" }] }));
    let from = f.events.len();
    let r = f.send(json!({ "to": "rcpt@example.test", "subject": "Later", "from": "alias@example.test", "sendAtMs": now_ms() + 1500 })).unwrap();
    let id = r["id"].as_str().unwrap().to_string();
    f.set(json!({ "aliases": [] }));
    f.events.send_result(from, &id, "sent");
    let raw = String::from_utf8_lossy(server.sent_messages().last().unwrap()).into_owned();
    let line = from_line(&raw);
    assert!(line.contains("<alias@example.test>"), "{line}");
    assert!(line.contains("Una User"), "{line}");
}

// ── Sent folder ─────────────────────────────────────────────────────────────

fn wait_in(server: &MockImap, folder: &str, n: usize) {
    let deadline = Instant::now() + WAIT;
    while server.state().find(folder).unwrap().messages.len() < n {
        assert!(Instant::now() < deadline, "{folder} never held {n} message(s)");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The Sent copy goes to the folder picked for the account, not the server's `\Sent`.
#[test]
fn the_sent_copy_goes_to_the_chosen_folder() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.set(json!({ "sentFolder": "Custom Sent" }));
    f.send_and_wait(&server, json!({ "to": "rcpt@example.test", "subject": "Filed" }));
    wait_in(&server, "Custom Sent", 1);
    assert!(server.state().find("Sent").unwrap().messages.is_empty(), "the copy also went to \\Sent");
}

/// A chosen folder that is gone: the copy lands in the server's Sent instead of nowhere.
#[test]
fn a_gone_sent_folder_falls_back_to_sent() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.set(json!({ "sentFolder": "Renamed Away" }));
    f.send_and_wait(&server, json!({ "to": "rcpt@example.test", "subject": "Fallback" }));
    wait_in(&server, "Sent", 1);
}
