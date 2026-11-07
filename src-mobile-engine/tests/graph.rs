//! Microsoft Graph accounts (`kind = graph`) end to end against the routed Graph mock in
//! `support/graph.rs`: folders and the 90-day header window with local uids from `remote_ids`,
//! read/flag/move/delete through the journal, bodies and attachment ranges served from one MIME
//! file in `<cache>/mime`, sends through `sendMail` with no Sent append, throttling, an expired
//! token, and the Microsoft sign-in that creates the account.
//!
//! `MAILVAULT_GRAPH_BASE` is read once per process, so every test shares one mock and holds
//! [`serial`] for its whole run.

#[path = "support/graph.rs"]
mod graph_mock;

use base64::Engine as _;
use graph_mock::{mock, serial, GraphMock};
use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, SecretStore};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(90);
const ME: &str = "owner@outlook.com";
const ACCOUNT: &str = "acc_00000000000000gr";
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn plain(subject: &str) -> Vec<u8> {
    format!("From: Alice <alice@example.com>\r\nTo: {ME}\r\nSubject: {subject}\r\nMessage-ID: <{}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of {subject}.\r\n", subject.replace(' ', "-"))
        .into_bytes()
}

/// Deterministic bytes that do not repeat on a line boundary.
fn source(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 56) as u8
        })
        .collect()
}

fn base64_lines(data: &[u8]) -> String {
    let flat = base64::engine::general_purpose::STANDARD.encode(data);
    let mut out = String::new();
    for line in flat.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(line).unwrap());
        out.push_str("\r\n");
    }
    out
}

/// multipart/mixed: (multipart/alternative: text 1.1, html 1.2) and a base64 PDF as part 2.
fn with_attachment(subject: &str, pdf: &[u8]) -> Vec<u8> {
    format!(
        "From: Alice <alice@example.com>\r\nTo: {ME}\r\nSubject: {subject}\r\nMessage-ID: <att@example.com>\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"outer-b\"\r\n\r\nThis is a multi-part message.\r\n\
--outer-b\r\nContent-Type: multipart/alternative; boundary=\"inner-b\"\r\n\r\n\
--inner-b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlain body Gr=C3=BC=C3=9Fe\r\n\
--inner-b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Html body</p>\r\n\
--inner-b--\r\n\r\n\
--outer-b\r\nContent-Type: application/pdf; name=\"doc.pdf\"\r\nContent-Disposition: attachment; filename=\"doc.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\
--outer-b--\r\n",
        base64_lines(pdf)
    )
    .into_bytes()
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

    fn wait(&self, from: usize, what: &str, pred: impl Fn(&str, &Value) -> bool) -> (String, Value) {
        let deadline = Instant::now() + WAIT;
        let mut list = self.list.lock().unwrap();
        loop {
            if let Some((n, v)) = list.iter().skip(from).find(|(n, v)| pred(n, v)) {
                return (n.clone(), v.clone());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no {what} event; got {:?}", &list[from.min(list.len())..]);
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
    }
}

struct Fx {
    _serial: MutexGuard<'static, ()>,
    g: &'static GraphMock,
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    engine: Engine,
    events: Arc<Events>,
    logs: Arc<Mutex<Vec<String>>>,
}

/// A fresh mailbox and an engine with no account yet.
fn engine_only() -> Fx {
    let g = mock();
    let s = serial();
    g.reset(ME);
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::clone(&secrets) as _).unwrap();
    engine.set_action_backoff(Duration::from_millis(50), Duration::from_millis(200));
    engine.set_outbox_backoff(Duration::from_millis(50), Duration::from_millis(200));
    engine.set_oauth_token_endpoint(&g.token_endpoint());
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    let logs: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = Arc::clone(&logs);
    assert!(engine.set_log_sink(move |line| l.lock().unwrap().push(line.to_string())));
    Fx { _serial: s, g, tmp, secrets, engine, events, logs }
}

/// [`engine_only`] plus a signed-in Graph account [`ACCOUNT`] whose access token is good.
fn setup() -> Fx {
    let f = engine_only();
    f.db()
        .execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms)
             VALUES (?1, ?2, ?2, 'outlook.office365.com', 993, 'ssl', 'graph', 'oauth2', 'microsoft', 0, 1)",
            [ACCOUNT, ME],
        )
        .unwrap();
    let (refresh, access, expires) = f.g.grant();
    f.secrets.set(ACCOUNT, &Credential::from_tokens(&refresh, &access, expires).to_secret()).unwrap();
    f
}

impl Fx {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    fn rpc(&self, method: &str, params: Value) -> Value {
        self.engine.rpc(method, params).unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    /// One sync pass (`folder: None` = the folder list and INBOX); its end event.
    fn try_sync(&self, folder: Option<&str>) -> Value {
        let from = self.events.len();
        let mut p = json!({ "accountId": ACCOUNT });
        if let Some(f) = folder {
            p["folder"] = json!(f);
        }
        self.rpc("mobile.sync.refresh", p);
        self.events
            .wait(from, "sync end", |n, v| n == "mobile.sync.state" && v["accountId"] == ACCOUNT && (v["state"] == "idle" || v["state"] == "error"))
            .1
    }

    fn sync(&self, folder: Option<&str>) {
        let end = self.try_sync(folder);
        assert_eq!(end["state"], "idle", "sync ended in error: {end}; logs {:?}", self.logs.lock().unwrap());
    }

    fn folders(&self) -> Vec<Value> {
        self.rpc("mobile.folders.list", json!({ "accountId": ACCOUNT }))["folders"].as_array().unwrap().clone()
    }

    /// The stored path of the folder named `name` (or with special use `name`).
    fn path_of(&self, name: &str) -> String {
        let all = self.folders();
        let f = all.iter().find(|f| f["name"] == name || f["specialUse"] == name).unwrap_or_else(|| panic!("no folder {name} in {all:?}"));
        f["path"].as_str().unwrap().to_string()
    }

    fn rows(&self, folder: &str) -> Vec<Value> {
        self.rpc("mobile.messages.page", json!({ "accountId": ACCOUNT, "folder": folder, "cursor": null, "limit": 200 }))["rows"]
            .as_array()
            .unwrap()
            .clone()
    }

    /// subject -> uid of the folder's rows.
    fn uids(&self, folder: &str) -> HashMap<String, i64> {
        self.rows(folder).iter().map(|r| (r["subject"].as_str().unwrap().to_string(), r["uid"].as_i64().unwrap())).collect()
    }

    fn apply(&self, kind: &str, folder: &str, uids: &[i64], target: Option<&str>) {
        let mut p = json!({ "accountId": ACCOUNT, "folder": folder, "uids": uids, "kind": kind });
        if let Some(t) = target {
            p["target"] = json!(t);
        }
        let r = self.rpc("mobile.actions.apply", p);
        assert!(r["queued"].as_i64().is_some(), "{r}");
    }

    fn wait_pending_empty(&self) {
        let deadline = Instant::now() + WAIT;
        loop {
            let p = self.rpc("mobile.actions.pending", json!({ "accountId": ACCOUNT }))["pending"].as_array().unwrap().clone();
            if p.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "journal never drained: {p:?}; logs {:?}", self.logs.lock().unwrap());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn cache(&self) -> PathBuf {
        self.tmp.path().join("cache")
    }

    fn mime_files(&self) -> Vec<String> {
        match std::fs::read_dir(self.cache().join("mime")) {
            Ok(rd) => rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".eml")).collect(),
            Err(_) => Vec::new(),
        }
    }
}

// ── The tests ───────────────────────────────────────────────────────────────

#[test]
fn graph_sync_lists_folders_and_pages_inbox_with_stable_uids() {
    let f = setup();
    let projects = f.g.add_folder("Projects", None);
    f.g.add_folder("2026", Some(&projects));
    let now = now_ms();
    // More than one listing page (the backend asks for 100 at a time), and one message outside
    // the 90 days.
    for i in 0..105 {
        f.g.add_message("inbox", &format!("Mail {i:03}"), now - (200 - i) * HOUR / 10, plain(&format!("Mail {i:03}")));
    }
    f.g.add_message("inbox", "Too old", now - 100 * DAY, plain("Too old"));

    f.sync(None);

    let folders = f.folders();
    let inbox = folders.iter().find(|x| x["path"] == "INBOX").unwrap_or_else(|| panic!("no INBOX row: {folders:?}"));
    assert_eq!(inbox["total"], 106, "{inbox}");
    assert!(folders.iter().any(|x| x["name"] == "Projects"), "{folders:?}");
    assert!(folders.iter().any(|x| x["name"] == "2026"), "a child folder is listed: {folders:?}");
    let trash = folders.iter().find(|x| x["specialUse"] == "\\Trash").expect("Deleted Items is Trash");
    assert_eq!(trash["path"], f.g.folder_id("deleteditems").as_str(), "a Graph folder's path is its id");
    assert!(folders.iter().any(|x| x["specialUse"] == "\\Sent"), "{folders:?}");

    let rows = f.rows("INBOX");
    assert_eq!(rows.len(), 105, "the window: every recent message, not the old one");
    assert!(rows.iter().all(|r| r["subject"] != "Too old"));
    // Newest first, and local uids ascend with the received date.
    let uids: Vec<i64> = rows.iter().map(|r| r["uid"].as_i64().unwrap()).collect();
    assert!(uids.windows(2).all(|w| w[0] > w[1]), "uids follow the received order: {uids:?}");
    let first = f.uids("INBOX");

    // Stable across passes; a new message gets a higher uid; the server's read state arrives.
    let read_id = f.g.messages_in("inbox").iter().find(|m| m.subject == "Mail 010").unwrap().id.clone();
    f.g.set_read(&read_id, true);
    f.g.add_message("inbox", "Newest", now - 1000, plain("Newest"));
    f.sync(Some("INBOX"));
    let second = f.uids("INBOX");
    for (subject, uid) in &first {
        assert_eq!(second.get(subject), Some(uid), "{subject} kept its uid");
    }
    assert!(second["Newest"] > *first.values().max().unwrap());
    let row = f.rows("INBOX").into_iter().find(|r| r["subject"] == "Mail 010").unwrap();
    assert_eq!(row["seen"], true, "{row}");
    let mapped: i64 = f.db().query_row("SELECT count(*) FROM remote_ids WHERE account_id = ?1 AND folder = 'INBOX'", [ACCOUNT], |r| r.get(0)).unwrap();
    assert_eq!(mapped, 106);
    // The inbox is always asked for by its well-known name, never as INBOX.
    assert_eq!(f.g.count("/mailFolders/INBOX"), 0);
}

#[test]
fn graph_read_flag_move_delete_round_trip() {
    let f = setup();
    let projects = f.g.add_folder("Projects", None);
    let now = now_ms();
    for (i, s) in ["Alpha", "Bravo", "Charlie"].iter().enumerate() {
        f.g.add_message("inbox", s, now - (10 - i as i64) * HOUR, plain(s));
    }
    f.sync(None);
    let uids = f.uids("INBOX");
    let id_of = |subject: &str| f.g.messages_in("inbox").into_iter().chain(f.g.messages_in(&projects)).chain(f.g.messages_in("deleteditems")).find(|m| m.subject == subject);

    f.apply("seen", "INBOX", &[uids["Alpha"]], None);
    f.apply("flag", "INBOX", &[uids["Alpha"]], None);
    f.wait_pending_empty();
    let a = id_of("Alpha").unwrap();
    assert!(a.is_read && a.flagged, "{a:?}");
    f.apply("unseen", "INBOX", &[uids["Alpha"]], None);
    f.apply("unflag", "INBOX", &[uids["Alpha"]], None);
    f.wait_pending_empty();
    let a = id_of("Alpha").unwrap();
    assert!(!a.is_read && !a.flagged, "{a:?}");

    // A move: the message gets a new Graph id in the target, mapped to a local uid there.
    let target = f.path_of("Projects");
    assert_eq!(target, projects);
    let old_id = id_of("Bravo").unwrap().id;
    f.apply("move", "INBOX", &[uids["Bravo"]], Some(&target));
    f.wait_pending_empty();
    let moved = f.g.messages_in(&projects);
    assert_eq!(moved.len(), 1, "{moved:?}");
    assert_ne!(moved[0].id, old_id);
    let new_uid: Option<i64> = f
        .db()
        .query_row("SELECT uid FROM remote_ids WHERE account_id = ?1 AND folder = ?2 AND remote_id = ?3", [ACCOUNT, target.as_str(), moved[0].id.as_str()], |r| r.get(0))
        .ok();
    let new_uid = new_uid.expect("the move mapped the new id");
    let old_left: i64 = f.db().query_row("SELECT count(*) FROM remote_ids WHERE remote_id = ?1", [old_id.as_str()], |r| r.get(0)).unwrap();
    assert_eq!(old_left, 0, "the old id's mapping went");
    assert!(!f.uids("INBOX").contains_key("Bravo"));
    f.sync(Some(&target));
    assert_eq!(f.uids(&target).get("Bravo"), Some(&new_uid), "sync keeps the uid the move gave");

    // A delete moves to Deleted Items; a delete there is permanent.
    let charlie = id_of("Charlie").unwrap().id;
    f.apply("delete", "INBOX", &[uids["Charlie"]], None);
    f.wait_pending_empty();
    let in_trash = f.g.messages_in("deleteditems");
    assert_eq!(in_trash.iter().filter(|m| m.subject == "Charlie").count(), 1, "{in_trash:?}");
    assert!(f.g.message(&charlie).is_none());
    assert_eq!(f.g.count("permanentDelete"), 0);
    let trash = f.path_of("\\Trash");
    f.sync(Some(&trash));
    let in_trash_uids = f.uids(&trash);
    f.apply("delete", &trash, &[in_trash_uids["Charlie"]], None);
    f.wait_pending_empty();
    assert!(id_of("Charlie").is_none(), "gone for good");
    assert_eq!(f.g.count("permanentDelete"), 1);
    f.sync(Some(&trash));
    assert!(f.uids(&trash).is_empty());
}

#[test]
fn graph_body_and_attachment_come_from_one_mime_file() {
    let f = setup();
    let pdf = source(600 * 1024, 7);
    f.g.add_message("inbox", "With file", now_ms() - HOUR, with_attachment("With file", &pdf));
    f.sync(None);
    let uid = f.uids("INBOX")["With file"];
    f.g.clear_requests();

    let body = f.rpc("mobile.message.body", json!({ "accountId": ACCOUNT, "folder": "INBOX", "uid": uid }));
    assert!(body["html"].as_str().unwrap_or("").contains("Html body"), "{body}");
    assert!(body["text"].as_str().unwrap_or("").contains("Plain body Grüße"), "{body}");
    let atts = body["attachments"].as_array().unwrap();
    assert_eq!(atts.len(), 1, "{body}");
    assert_eq!(atts[0]["section"], "2");
    assert_eq!(atts[0]["filename"], "doc.pdf");
    assert_eq!(f.g.count("$value"), 1, "the MIME came down once: {:?}", f.g.requests());
    assert_eq!(f.mime_files().len(), 1, "one MIME file in <cache>/mime");

    // The attachment streams from the same file: no further HTTP for the MIME. Then the cap
    // (one byte here) evicts the MIME file as it evicts any cached attachment, never the file
    // that just finished.
    f.engine.set_attachment_cache_cap(1);
    let from = f.events.len();
    let job = f.rpc("mobile.attachment.fetch", json!({ "accountId": ACCOUNT, "folder": "INBOX", "uid": uid, "section": "2" }))["jobId"].as_u64().unwrap();
    let (name, v) = f.events.wait(from, "attachment end", |n, v| (n == "mobile.attachment.done" || n == "mobile.attachment.failed") && v["jobId"] == job);
    assert_eq!(name, "mobile.attachment.done", "{v}; logs {:?}", f.logs.lock().unwrap());
    let path = PathBuf::from(v["path"].as_str().unwrap());
    assert!(std::fs::read(&path).unwrap() == pdf, "the decoded attachment is the PDF");
    assert_eq!(f.g.count("$value"), 1, "the part came from the MIME file: {:?}", f.g.requests());
    assert!(f.mime_files().is_empty(), "the MIME file left by the LRU: {:?}", f.mime_files());
    assert!(path.is_file(), "the file that just finished stays");
}

#[test]
fn graph_send_does_not_append_to_sent() {
    let f = setup();
    f.sync(None);
    f.g.clear_requests();
    let from = f.events.len();
    let r = f.rpc(
        "mobile.compose.send",
        json!({ "accountId": ACCOUNT, "to": "rcpt@example.test", "cc": "", "bcc": "hidden@example.test", "subject": "Hello Graph", "text": "Body over Graph", "attachments": [] }),
    );
    let id = r["id"].as_str().unwrap().to_string();
    let (_, done) = f.events.wait(from, "send result", |n, v| n == "mobile.send.result" && v["id"] == id.as_str() && v["outcome"] != "queued");
    assert_eq!(done["outcome"], "sent", "{done}; logs {:?}", f.logs.lock().unwrap());

    let sent = f.g.sent();
    assert_eq!(sent.len(), 1, "exactly one sendMail");
    let raw = String::from_utf8_lossy(&sent[0]).into_owned();
    assert!(raw.contains("Subject: Hello Graph"), "{raw}");
    assert!(raw.contains("hidden@example.test"), "Graph reads Bcc from the MIME, so it is there: {raw}");
    let posts: Vec<String> = f.g.requests().into_iter().filter(|r| r.starts_with("POST ") && !r.starts_with("POST /oauth")).collect();
    assert_eq!(posts, vec!["POST /me/sendMail".to_string()], "no Sent append, no draft");
    let state: String = f.db().query_row("SELECT state FROM outbox WHERE id = ?1", [id.as_str()], |r| r.get(0)).unwrap();
    assert_eq!(state, "sent");
}

#[test]
fn a_429_waits_retry_after_and_is_not_an_error() {
    let f = setup();
    let now = now_ms();
    f.g.add_message("inbox", "One", now - 2 * HOUR, plain("One"));
    f.g.add_message("inbox", "Two", now - HOUR, plain("Two"));
    f.sync(None);
    // The next two Graph requests (the INBOX pass's first) are throttled for a second each.
    f.g.clear_requests();
    f.g.add_message("inbox", "Three", now - 1000, plain("Three"));
    f.g.throttle(2, 1);
    let t0 = Instant::now();
    f.sync(Some("INBOX"));
    assert!(t0.elapsed() >= Duration::from_millis(1900), "waited Retry-After twice: {:?}", t0.elapsed());
    assert!(f.uids("INBOX").contains_key("Three"), "the pass went on after the throttle");
    assert!(f.g.requests().len() >= 3, "{:?}", f.g.requests());

    // An action throttled once is applied, not refused.
    let uid = f.uids("INBOX")["One"];
    f.g.throttle(1, 1);
    f.apply("seen", "INBOX", &[uid], None);
    f.wait_pending_empty();
    assert!(f.g.messages_in("inbox").iter().find(|m| m.subject == "One").unwrap().is_read);
}

#[test]
fn an_expired_token_is_refreshed_once_and_the_call_retried() {
    let f = setup();
    f.g.add_message("inbox", "One", now_ms() - HOUR, plain("One"));
    // The stored access token claims an hour left, but Graph no longer takes it.
    let mut cred = Credential::parse(&f.secrets.get(ACCOUNT).unwrap().unwrap());
    cred.access = Some("revoked-access-token".into());
    f.secrets.set(ACCOUNT, &cred.to_secret()).unwrap();
    f.g.clear_requests();
    f.sync(None);
    assert_eq!(f.g.count("POST /oauth/token refresh"), 1, "{:?}", f.g.requests());
    assert!(f.uids("INBOX").contains_key("One"));
    let stored = Credential::parse(&f.secrets.get(ACCOUNT).unwrap().unwrap());
    assert_ne!(stored.access.as_deref(), Some("revoked-access-token"), "the fresh token is stored");
}

#[test]
fn microsoft_sign_in_adds_a_graph_account_that_syncs() {
    let f = engine_only();
    f.g.add_message("inbox", "Welcome", now_ms() - HOUR, plain("Welcome"));
    let begun = f.rpc("mobile.oauth.begin", json!({ "provider": "microsoft", "loginHint": "typed@outlook.com" }));
    let flow = begun["flowId"].as_str().unwrap().to_string();
    f.g.expect_code("authcode-ms-ok-0001");
    assert!(f.engine.oauth_deliver_code(&flow, "authcode-ms-ok-0001"));
    let r = f.rpc("mobile.oauth.finish", json!({ "flowId": flow }));
    assert_eq!(r["ok"], true, "{r}; logs {:?}", f.logs.lock().unwrap());
    assert_eq!(r["account"]["email"], ME, "the address Graph /me named, not the typed one");
    assert_eq!(r["account"]["kind"], "graph");
    let id = r["account"]["id"].as_str().unwrap().to_string();
    let (kind, auth, provider): (String, String, String) = f
        .db()
        .query_row("SELECT kind, auth, provider FROM accounts WHERE id = ?1", [id.as_str()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!((kind.as_str(), auth.as_str(), provider.as_str()), ("graph", "oauth2", "microsoft"));
    let cred = Credential::parse(&f.secrets.get(&id).unwrap().expect("a secret is stored"));
    assert!(cred.refresh.is_some() && cred.access.is_some());

    let from = f.events.len();
    f.rpc("mobile.sync.refresh", json!({ "accountId": id }));
    let (_, end) = f.events.wait(from, "sync end", |n, v| n == "mobile.sync.state" && v["accountId"] == id.as_str() && v["state"] != "syncing");
    assert_eq!(end["state"], "idle", "{end}; logs {:?}", f.logs.lock().unwrap());
    let rows = f.rpc("mobile.messages.page", json!({ "accountId": id, "folder": "INBOX", "cursor": null, "limit": 50 }))["rows"].clone();
    assert_eq!(rows.as_array().unwrap().len(), 1, "{rows}");

    // No token anywhere but the secret store.
    let mut hay = std::fs::read(f.tmp.path().join("mobile.db")).unwrap();
    hay.extend(std::fs::read(f.tmp.path().join("mobile.db-wal")).unwrap_or_default());
    hay.extend(f.logs.lock().unwrap().join("\n").into_bytes());
    for s in f.g.authority.issued() {
        assert!(!hay.windows(s.len()).any(|w| w == s.as_bytes()), "a token leaked");
    }
}
