//! Compose, the outbox and drafts against the mock IMAP server and its SMTP side: a send is
//! validated before it is journaled, goes out once through SMTP, lands in Sent, survives being
//! offline, and is never sent twice after a crash.

use mailvault_mobile_engine::{Engine, MemorySecrets, RpcError};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);
const PASSWORD: &str = "pw-compose-test-s3cret";
const MB: u64 = 1024 * 1024;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn original(uid: u32, subject: &str) -> Message {
    Message::new(
        uid,
        format!(
            "From: Alice Example <alice@example.com>\n\
             To: u@example.test, bob@example.com\n\
             Cc: carol@example.com, U@Example.test\n\
             Subject: {subject}\n\
             Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
             Message-ID: <orig-{uid}@example.com>\n\
             References: <root@example.com>\n\
             Content-Type: text/plain; charset=UTF-8\n\
             \n\
             Original body line {uid}.\n"
        ),
    )
    .with_internal_ms((now_ms() / DAY - 1) * DAY + uid as i64 * 1000)
}

fn mailbox(name: &str, attrs: &[&str], msgs: Vec<Message>) -> Mailbox {
    let mut mb = if attrs.is_empty() { Mailbox::new(name) } else { Mailbox::new(name).with_attrs(attrs) };
    for m in msgs {
        mb.add(m);
    }
    mb
}

fn scenario() -> Scenario {
    Scenario::new()
        .mailbox(mailbox("INBOX", &[], vec![original(1, "Plans"), original(2, "Re: Plans")]))
        .mailbox(mailbox("Sent", &["\\HasNoChildren", "\\Sent"], vec![]))
        .mailbox(mailbox("Trash", &["\\HasNoChildren", "\\Trash"], vec![]))
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

    fn all(&self) -> Vec<(String, Value)> {
        self.list.lock().unwrap().clone()
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

    /// The first `mobile.send.result` for outbox row `id` with `outcome`, at `from` or later.
    fn send_result(&self, from: usize, id: &str, outcome: &str) -> Value {
        self.wait(from, &format!("send.result {outcome} for {id}"), |n, v| {
            n == "mobile.send.result" && v["id"] == id && v["outcome"] == outcome
        })
    }

    fn wait_idle(&self, from: usize, account: &str) {
        let end = self.wait(from, "sync end", |n, v| {
            n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error")
        });
        assert_eq!(end["state"], "idle", "sync ended in error: {end}");
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

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events) = open(tmp.path(), &secrets);
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": PASSWORD, "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fixture { tmp, secrets, engine, events, account }
}

impl Fixture {
    fn cache(&self) -> PathBuf {
        self.tmp.path().join("cache")
    }

    fn sync(&self) {
        let from = self.events.len();
        assert_eq!(self.engine.rpc("mobile.sync.refresh", json!({ "accountId": self.account })).unwrap(), json!({ "queued": true }));
        self.events.wait_idle(from, &self.account);
    }

    /// A file as the shell's picker leaves it: `<cache>/out/<16 hex>/<name>`; its handle.
    fn pick(&self, dir: &str, name: &str, bytes: &[u8]) -> String {
        assert_eq!(dir.len(), 16);
        let d = self.cache().join("out").join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(name), bytes).unwrap();
        format!("out/{dir}/{name}")
    }

    /// A picked file of `len` bytes that takes no disk space.
    fn pick_sparse(&self, dir: &str, name: &str, len: u64) -> String {
        let handle = self.pick(dir, name, b"");
        let f = std::fs::OpenOptions::new().write(true).open(self.cache().join(&handle)).unwrap();
        f.set_len(len).unwrap();
        handle
    }

    fn send(&self, mut params: Value) -> Result<Value, RpcError> {
        params["accountId"] = json!(self.account);
        for k in ["cc", "bcc", "subject", "text"] {
            if params.get(k).is_none() {
                params[k] = json!("");
            }
        }
        if params.get("attachments").is_none() {
            params["attachments"] = json!([]);
        }
        self.engine.rpc("mobile.compose.send", params)
    }

    fn outbox(&self) -> Vec<Value> {
        self.engine.rpc("mobile.outbox.list", json!({})).unwrap().as_array().unwrap().clone()
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    /// `(state, message_id)` of outbox row `id`.
    fn row(&self, id: &str) -> Option<(String, Option<String>)> {
        self.db().query_row("SELECT state, message_id FROM outbox WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).ok()
    }

    fn outbox_rows(&self) -> i64 {
        self.db().query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap()
    }

    fn restart(self) -> Fixture {
        let Fixture { tmp, secrets, engine, events: _, account } = self;
        drop(engine);
        let (engine, events) = open(tmp.path(), &secrets);
        Fixture { tmp, secrets, engine, events, account }
    }

    fn prepare(&self, mode: &str, uid: u32) -> Value {
        self.engine
            .rpc("mobile.compose.prepare", json!({ "accountId": self.account, "mode": mode, "folder": "INBOX", "uid": uid }))
            .unwrap()
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn code(r: Result<Value, RpcError>) -> String {
    match r {
        Ok(v) => panic!("expected an error, got {v}"),
        Err(e) => e.code().to_string(),
    }
}

#[test]
fn send_delivers_through_smtp_and_appends_to_sent() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let handle = f.pick("0123456789abcdef", "notes.txt", b"attached notes body");
    let from = f.events.len();
    let r = f
        .send(json!({ "to": "rcpt@example.test", "bcc": "hidden@example.test", "subject": "Hello there", "text": "Body text here", "attachments": [{ "handle": handle }] }))
        .unwrap();
    assert_eq!(r["state"], "queued", "{r}");
    let id = r["id"].as_str().unwrap().to_string();
    let done = f.events.send_result(from, &id, "sent");
    assert_eq!(done["accountId"], f.account.as_str());

    let sent = server.sent_messages();
    assert_eq!(sent.len(), 1, "exactly one message went out");
    let raw = text(&sent[0]);
    assert!(raw.contains("Subject: Hello there"), "{raw}");
    assert!(raw.contains("Body text here"), "{raw}");
    assert!(raw.contains("notes.txt"), "the attachment is in the message: {raw}");
    assert!(!raw.to_ascii_lowercase().contains("\nbcc:"), "Bcc stays out of the bytes: {raw}");
    let (state, message_id) = f.row(&id).unwrap();
    assert_eq!(state, "sent");
    let message_id = message_id.expect("the outbox row holds its Message-ID");
    assert!(raw.contains(&message_id), "the stored Message-ID {message_id} is the one sent: {raw}");
    let rcpts: Vec<String> = server.smtp_commands().into_iter().filter(|c| c.to_ascii_uppercase().starts_with("RCPT")).collect();
    assert!(rcpts.iter().any(|c| c.contains("hidden@example.test")), "{rcpts:?}");
    assert!(rcpts.iter().any(|c| c.contains("rcpt@example.test")), "{rcpts:?}");

    // Filed in Sent, read.
    let state = server.state();
    let sent_box = state.find("Sent").unwrap();
    assert_eq!(sent_box.messages.len(), 1, "appended to Sent");
    assert!(sent_box.messages[0].flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));
    assert!(text(&sent_box.messages[0].raw).contains(&message_id));

    // The picked file is gone with the sent row, and the outbox list no longer shows it.
    assert!(!f.cache().join("out").join("0123456789abcdef").exists(), "the picked dir is deleted once sent");
    assert!(f.outbox().is_empty(), "{:?}", f.outbox());
}

#[test]
fn send_offline_queues_then_replays_once_online() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    server.reset_scenario(scenario().fault(Trigger::OnConnect, Action::DropConnection));
    let from = f.events.len();
    let r = f.send(json!({ "to": "rcpt@example.test", "subject": "Offline", "text": "Queued while offline" })).unwrap();
    let id = r["id"].as_str().unwrap().to_string();
    assert_eq!(r["state"], "queued");
    let q = f.events.send_result(from, &id, "queued");
    assert_eq!(q["reason"], "HOST_UNREACHABLE", "{q}");
    let listed = f.outbox();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0]["id"], id.as_str());
    assert_eq!(listed[0]["state"], "queued");
    assert_eq!(listed[0]["subject"], "Offline");
    assert_eq!(listed[0]["accountId"], f.account.as_str());
    assert_eq!(listed[0]["lastError"], "HOST_UNREACHABLE");
    assert!(server.sent_messages().is_empty());

    server.reset_scenario(scenario());
    f.events.send_result(from, &id, "sent");
    assert_eq!(server.sent_messages().len(), 1);
    assert!(text(&server.sent_messages()[0]).contains("Queued while offline"));
    assert!(f.outbox().is_empty());
}

#[test]
fn a_send_interrupted_after_accept_is_uncertain_not_resent() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let from = f.events.len();
    let id = f.send(json!({ "to": "rcpt@example.test", "subject": "Once", "text": "Only once" })).unwrap()["id"].as_str().unwrap().to_string();
    f.events.send_result(from, &id, "sent");
    assert_eq!(server.sent_messages().len(), 1);
    let first_id = f.row(&id).unwrap().1.unwrap();

    // The engine dies after the server accepted DATA but before `sent` was committed.
    let Fixture { tmp, secrets, engine, events: _, account } = f;
    drop(engine);
    {
        let db = rusqlite::Connection::open(tmp.path().join("mobile.db")).unwrap();
        assert_eq!(db.execute("UPDATE outbox SET state = 'sending' WHERE id = ?1", [&id]).unwrap(), 1);
    }
    let (engine, events) = open(tmp.path(), &secrets);
    let f = Fixture { tmp, secrets, engine, events, account };
    let listed = f.outbox();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0]["state"], "uncertain", "{listed:?}");

    std::thread::sleep(Duration::from_secs(10));
    assert_eq!(server.sent_messages().len(), 1, "an uncertain row is never sent again on its own");
    assert_eq!(f.row(&id).unwrap().0, "uncertain");

    // The user's Retry sends it again, as the same message.
    let from = f.events.len();
    f.engine.rpc("mobile.outbox.retry", json!({ "id": id })).unwrap();
    f.events.send_result(from, &id, "sent");
    let sent = server.sent_messages();
    assert_eq!(sent.len(), 2);
    assert!(text(&sent[1]).contains(&first_id), "a retry reuses the Message-ID {first_id}");
}

/// The phone loses the network after the server took the message but before its reply came:
/// the row is `uncertain` and is never sent again on its own.
#[test]
fn a_send_cut_off_after_data_is_uncertain_not_resent() {
    let server = MockImap::start(scenario().smtp_drop_after_data("CUT-OFF-AFTER-DATA"));
    let f = setup(&server);
    let from = f.events.len();
    let id = f.send(json!({ "to": "rcpt@example.test", "subject": "Cut", "text": "CUT-OFF-AFTER-DATA" })).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = f.events.send_result(from, &id, "uncertain");
    assert!(r["reason"].is_string(), "{r}");
    assert_eq!(server.sent_messages().len(), 1, "the server took it once");
    // Well past the test backoff (50 ms doubling to 200 ms): nothing is sent again.
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(server.sent_messages().len(), 1, "an uncertain send is never repeated on its own");
    assert_eq!(f.row(&id).unwrap().0, "uncertain");
    let listed = f.outbox();
    assert_eq!(listed[0]["state"], "uncertain", "{listed:?}");
    assert!(
        !f.events.all().iter().any(|(n, v)| n == "mobile.send.result" && v["id"] == id.as_str() && v["outcome"] != "uncertain"),
        "{:?}",
        f.events.all()
    );
}

#[test]
fn over_25_mb_of_attachments_is_too_large_before_any_network() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let a = f.pick_sparse("aaaaaaaaaaaaaaaa", "a.bin", 13 * MB);
    let b = f.pick_sparse("bbbbbbbbbbbbbbbb", "b.bin", 13 * MB);
    let connections = server.connection_count();
    let smtp = server.smtp_commands().len();
    let r = f.send(json!({ "to": "rcpt@example.test", "subject": "Big", "attachments": [{ "handle": a }, { "handle": b }] }));
    assert_eq!(code(r), "TOO_LARGE");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(f.outbox_rows(), 0, "nothing was journaled");
    assert_eq!(server.connection_count(), connections, "no IMAP connection for a refused send");
    assert_eq!(server.smtp_commands().len(), smtp, "no SMTP for a refused send");

    // Exactly 25 MB is allowed (offline, so nothing big goes over the wire).
    server.reset_scenario(scenario().fault(Trigger::OnConnect, Action::DropConnection));
    let c = f.pick_sparse("cccccccccccccccc", "c.bin", 25 * MB - 13 * MB);
    let from = f.events.len();
    let ok = f.send(json!({ "to": "rcpt@example.test", "subject": "Fits", "attachments": [{ "handle": a }, { "handle": c }] }));
    assert!(ok.is_ok(), "{ok:?}");
    let id = ok.unwrap()["id"].as_str().unwrap().to_string();
    f.events.send_result(from, &id, "queued");
    f.engine.rpc("mobile.outbox.discard", json!({ "id": id })).unwrap();
    assert_eq!(f.outbox_rows(), 0);
    assert!(!f.cache().join("out").join("cccccccccccccccc").exists(), "a discarded send deletes its picked files");
    assert!(server.sent_messages().is_empty());
}

#[test]
fn a_missing_attachment_handle_is_refused_before_journalling() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let connections = server.connection_count();
    // Adding the account signed in to SMTP once; a refused send adds nothing.
    let smtp = server.smtp_commands().len();
    for handle in ["out/0123456789abcdef/gone.pdf", "../mobile.db", "out/../../x"] {
        let r = f.send(json!({ "to": "rcpt@example.test", "subject": "Missing", "attachments": [{ "handle": handle }] }));
        assert_eq!(code(r), "ATTACHMENT_MISSING", "{handle}");
    }
    let r = f.send(json!({ "to": "", "cc": " ", "bcc": "", "subject": "Nobody" }));
    assert_eq!(code(r), "INVALID");
    let r = f.send(json!({ "to": "not an address", "subject": "Bad" }));
    assert_eq!(code(r), "INVALID");
    assert_eq!(f.outbox_rows(), 0, "nothing was journaled");
    assert!(f.outbox().is_empty());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(server.connection_count(), connections, "no network for a refused send");
    assert_eq!(server.smtp_commands().len(), smtp);
}

#[test]
fn reply_prepare_quotes_and_threads() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    f.sync();

    let r = f.prepare("reply", 1);
    assert_eq!(r["to"], "alice@example.com", "{r}");
    assert_eq!(r["cc"], "", "{r}");
    assert_eq!(r["subject"], "Re: Plans", "{r}");
    assert_eq!(r["inReplyTo"], "<orig-1@example.com>", "{r}");
    assert_eq!(r["references"], "<root@example.com> <orig-1@example.com>", "{r}");
    assert!(r["quote"].as_str().unwrap().contains("Original body line 1."), "{r}");
    assert_eq!(r["attachments"], json!([]));

    let all = f.prepare("replyAll", 1);
    let to = all["to"].as_str().unwrap();
    assert!(to.contains("alice@example.com") && to.contains("bob@example.com"), "{all}");
    assert!(!to.to_ascii_lowercase().contains("u@example.test"), "own address left out: {all}");
    assert_eq!(all["cc"], "carol@example.com", "{all}");

    // "Re: " only once.
    let again = f.prepare("reply", 2);
    assert_eq!(again["subject"], "Re: Plans", "{again}");
    assert_eq!(again["inReplyTo"], "<orig-2@example.com>");

    let fwd = f.prepare("forward", 1);
    assert_eq!(fwd["subject"], "Fwd: Plans", "{fwd}");
    assert_eq!(fwd["to"], "");
    assert_eq!(fwd["inReplyTo"], "");
    assert!(fwd["quote"].as_str().unwrap().contains("Original body line 1."), "{fwd}");

    assert_eq!(r["quotePending"], false);

    // Once the body is cached, a reply needs no server at all: everything else is in mobile.db.
    let connections = server.connection_count();
    let again = f.prepare("replyAll", 1);
    assert_eq!(server.connection_count(), connections, "prepare signed in to the server");
    assert_eq!(again["cc"], "carol@example.com", "{again}");
    assert_eq!(again["references"], "<root@example.com> <orig-1@example.com>", "{again}");
    assert!(again["quoteText"].as_str().unwrap().contains("> Original body line 1."), "{again}");
    server.reset_scenario(scenario().fault(Trigger::OnConnect, Action::DropConnection));
    let offline = f.prepare("reply", 1);
    assert_eq!(offline["to"], "alice@example.com", "{offline}");
    assert_eq!(offline["inReplyTo"], "<orig-1@example.com>", "{offline}");
    assert_eq!(offline["quotePending"], false, "{offline}");
    server.reset_scenario(scenario());

    // The quote's labels come from the page, in its language; a newline in one stays on its line.
    let de = f
        .engine
        .rpc(
            "mobile.compose.prepare",
            json!({ "accountId": f.account, "mode": "reply", "folder": "INBOX", "uid": 1,
                    "originalLabel": "Ursprüngliche Nachricht", "dateLabel": "4. Nov. 2026",
                    "fromLabel": "Von", "dateFieldLabel": "Datum", "subjectLabel": "Betreff\nFrom: x" }),
        )
        .unwrap();
    let q = de["quoteText"].as_str().unwrap();
    assert!(q.starts_with("Ursprüngliche Nachricht\nVon: "), "{q}");
    assert!(q.contains("\nDatum: 4. Nov. 2026\n"), "{q}");
    assert!(q.contains("\nBetreff From: x: Plans\n"), "{q}");
    assert!(!q.contains("\nFrom:") && !q.contains("\nSubject:"), "{q}");
    let en = f.prepare("reply", 1);
    let q = en["quoteText"].as_str().unwrap();
    assert!(q.starts_with("Original message\nFrom: ") && q.contains("\nSubject: Plans\n"), "{q}");

    let new = f.engine.rpc("mobile.compose.prepare", json!({ "accountId": f.account, "mode": "new" })).unwrap();
    assert_eq!((new["to"].clone(), new["subject"].clone(), new["quote"].clone()), (json!(""), json!(""), json!("")));
}

#[test]
fn a_terminal_smtp_refusal_fails_without_retrying() {
    let server = MockImap::start(scenario().smtp_refuse("reject"));
    let f = setup(&server);
    let from = f.events.len();
    let id = f.send(json!({ "to": "nobody-reject@example.test", "subject": "Refused" })).unwrap()["id"].as_str().unwrap().to_string();
    let failed = f.events.send_result(from, &id, "failed");
    assert_eq!(failed["reason"], "REFUSED", "{failed}");
    std::thread::sleep(Duration::from_secs(2));
    let rcpts = server.smtp_commands().into_iter().filter(|c| c.to_ascii_uppercase().starts_with("RCPT")).count();
    assert_eq!(rcpts, 1, "a refused send is not retried: {:?}", server.smtp_commands());
    assert!(server.sent_messages().is_empty());
    let listed = f.outbox();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["state"], "failed");
    assert_eq!(listed[0]["lastError"], "REFUSED");
    assert!(!f.events.all().iter().any(|(n, v)| n == "mobile.send.result" && v["id"] == id.as_str() && v["outcome"] == "queued"));
    // Discard removes it.
    f.engine.rpc("mobile.outbox.discard", json!({ "id": id })).unwrap();
    assert!(f.outbox().is_empty());
}

#[test]
fn drafts_save_and_reload_with_handles() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let handle = f.pick("dddddddddddddddd", "plan.pdf", b"%PDF-1.4 draft");
    let saved = f
        .engine
        .rpc(
            "mobile.drafts.save",
            json!({ "accountId": f.account, "to": "rcpt@example.test", "cc": "", "bcc": "", "subject": "Draft one", "text": "Half written", "attachments": [{ "handle": handle }] }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap().to_string();
    let again = f
        .engine
        .rpc(
            "mobile.drafts.save",
            json!({ "id": id, "accountId": f.account, "to": "rcpt@example.test", "subject": "Draft two", "text": "More written", "mode": "forward", "attachments": [{ "handle": handle }] }),
        )
        .unwrap();
    assert_eq!(again["id"], id.as_str(), "saving with an id updates that draft");

    let f = f.restart();
    let list = f.engine.rpc("mobile.drafts.list", json!({})).unwrap();
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0]["id"], id.as_str());
    assert_eq!(list[0]["subject"], "Draft two");
    let d = f.engine.rpc("mobile.drafts.get", json!({ "id": id })).unwrap();
    assert_eq!(d["accountId"], f.account.as_str());
    assert_eq!(d["to"], "rcpt@example.test");
    assert_eq!(d["text"], "More written");
    assert_eq!(d["mode"], "forward", "a reopened draft keeps what it was started as: {d}");
    assert_eq!(d["attachments"][0]["handle"], handle.as_str(), "{d}");
    assert_eq!(d["attachments"][0]["name"], "plan.pdf");
    assert_eq!(d["attachments"][0]["size"], 14);
    assert_eq!(d["attachments"][0]["mime"], "application/pdf");

    // A sweep keeps what a draft holds and removes what nothing holds.
    let orphan = f.pick("eeeeeeeeeeeeeeee", "lost.txt", b"nobody");
    f.engine.sweep_outgoing(Duration::ZERO);
    assert!(f.cache().join(&handle).is_file(), "a draft's file survives the sweep");
    assert!(!f.cache().join(&orphan).exists(), "an orphan is swept");

    // Deleting the draft deletes its picked files.
    assert_eq!(f.engine.rpc("mobile.drafts.delete", json!({ "id": id })).unwrap()["deleted"], true);
    assert!(!f.cache().join("out").join("dddddddddddddddd").exists());
    assert_eq!(code(f.engine.rpc("mobile.drafts.get", json!({ "id": id }))), "INVALID");

    // Sending a draft removes the draft and keeps its file until the send is done.
    let h2 = f.pick("ffffffffffffffff", "x.txt", b"x");
    let d2 = f
        .engine
        .rpc("mobile.drafts.save", json!({ "accountId": f.account, "to": "rcpt@example.test", "subject": "S", "text": "T", "attachments": [{ "handle": h2 }] }))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let from = f.events.len();
    let sid = f.send(json!({ "draftId": d2, "to": "rcpt@example.test", "subject": "S", "text": "T", "attachments": [{ "handle": h2 }] })).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(f.engine.rpc("mobile.drafts.list", json!({})).unwrap().as_array().unwrap().is_empty());
    f.events.send_result(from, &sid, "sent");
    assert!(!f.cache().join("out").join("ffffffffffffffff").exists());
}

#[test]
fn no_secret_reaches_outbox_or_drafts_rows() {
    let server = MockImap::start(scenario().smtp_refuse("reject"));
    let f = setup(&server);
    f.engine
        .rpc("mobile.drafts.save", json!({ "accountId": f.account, "to": "a@example.test", "subject": "d", "text": "t", "attachments": [] }))
        .unwrap();
    let from = f.events.len();
    let ok = f.send(json!({ "to": "a@example.test", "subject": "ok", "text": "t" })).unwrap()["id"].as_str().unwrap().to_string();
    f.events.send_result(from, &ok, "sent");
    let bad = f.send(json!({ "to": "x-reject@example.test", "subject": "no", "text": "t" })).unwrap()["id"].as_str().unwrap().to_string();
    f.events.send_result(from, &bad, "failed");
    server.reset_scenario(scenario().fault(Trigger::OnConnect, Action::DropConnection));
    let off = f.send(json!({ "to": "a@example.test", "subject": "off", "text": "t" })).unwrap()["id"].as_str().unwrap().to_string();
    f.events.send_result(from, &off, "queued");

    let db = f.db();
    let mut dump = String::new();
    for (table, cols) in [
        ("outbox", "id, account_id, COALESCE(message_id, ''), draft_json, state, COALESCE(last_error, '')"),
        ("drafts", "id, account_id, json, ''"),
    ] {
        let mut st = db.prepare(&format!("SELECT {cols} FROM {table}")).unwrap();
        let n = st.column_count();
        let rows = st
            .query_map([], |r| (0..n).map(|i| r.get::<_, String>(i)).collect::<Result<Vec<_>, _>>())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!rows.is_empty(), "{table} has rows");
        for row in rows {
            dump.push_str(&row.join("|"));
            dump.push('\n');
        }
    }
    assert!(!dump.contains(PASSWORD), "a secret reached mobile.db: {dump}");
    for (name, payload) in f.events.all() {
        assert!(!payload.to_string().contains(PASSWORD), "{name} carries the secret");
    }
    let listed = serde_json::to_string(&f.outbox()).unwrap();
    assert!(!listed.contains(PASSWORD));
}

#[test]
fn a_forwarded_part_keeps_the_type_the_server_gave_it() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    // A part with no telling extension (a forward of a server part named without one).
    let handle = f.pick("abababababababab", "invoice", b"%PDF-1.4 fwd");
    let saved = f
        .engine
        .rpc(
            "mobile.drafts.save",
            json!({ "accountId": f.account, "to": "rcpt@example.test", "subject": "Fwd", "text": "", "attachments": [{ "handle": handle, "mime": "application/pdf" }] }),
        )
        .unwrap();
    let d = f.engine.rpc("mobile.drafts.get", json!({ "id": saved["id"] })).unwrap();
    assert_eq!(d["attachments"][0]["mime"], "application/pdf", "{d}");
    // Something that is not a media type is not kept.
    let bad = f
        .engine
        .rpc(
            "mobile.drafts.save",
            json!({ "accountId": f.account, "to": "rcpt@example.test", "subject": "Fwd", "text": "", "attachments": [{ "handle": handle, "mime": "pdf; drop table" }] }),
        )
        .unwrap();
    let d = f.engine.rpc("mobile.drafts.get", json!({ "id": bad["id"] })).unwrap();
    assert_eq!(d["attachments"][0]["mime"], "application/octet-stream", "{d}");
}

#[test]
fn removing_an_account_removes_its_picked_files() {
    let server = MockImap::start(scenario());
    let f = setup(&server);
    let handle = f.pick("cdcdcdcdcdcdcdcd", "plan.pdf", b"%PDF-1.4 draft");
    f.engine
        .rpc(
            "mobile.drafts.save",
            json!({ "accountId": f.account, "to": "rcpt@example.test", "subject": "Draft", "text": "", "attachments": [{ "handle": handle }] }),
        )
        .unwrap();
    assert!(f.cache().join(&handle).is_file());
    f.engine.rpc("mobile.accounts.remove", json!({ "accountId": f.account })).unwrap();
    assert!(!f.cache().join("out").join("cdcdcdcdcdcdcdcd").exists(), "the removed account's picked files went with it");
}
