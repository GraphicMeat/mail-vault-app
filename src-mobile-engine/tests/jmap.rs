//! JMAP accounts (`kind = jmap`) end to end against `mock-jmap`: the add form (a typed URL,
//! discovery, a host that needs confirming, Basic or Bearer), folders and the 90-day window with
//! folder-qualified local uids, flags that follow `Email/changes`, read/flag/move/delete through
//! the journal (delete to Trash, then for good), bodies from `bodyValues` with attachments
//! streamed only on a tap, sends through `EmailSubmission` as the matching identity, and an
//! http session URL refused before any request.
//!
//! Each test starts its own mock (nothing process-wide but the loopback permission, which every
//! test sets the same way).

use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, SecretStore};
use mock_jmap::{Fault, Limits, MockJmap, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(90);
const ME: &str = "me@example.test";
const PASSWORD: &str = "app-pass-7c1f";
const TOKEN: &str = "fmu1-token-9a2e";
const ACC: &str = "acc1";
const DAY: i64 = 86_400;

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

/// `secs` as the mock's UTCDate.
fn iso(secs: i64) -> String {
    mock_jmap::state::iso8601(secs)
}

fn raw(subject: &str, body: &str) -> String {
    format!("From: Alice <alice@example.test>\r\nTo: {ME}\r\nSubject: {subject}\r\nMessage-ID: <{}@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n", subject.replace(' ', "-"))
}

fn email(id: &str, subject: &str, received: i64) -> ScenarioEmail {
    ScenarioEmail { id: id.into(), raw: raw(subject, &format!("Body of {subject}.")), keywords: vec![], received_at: iso(received), also_in: vec![] }
}

fn mailbox(id: &str, name: &str, role: Option<&str>, emails: Vec<ScenarioEmail>) -> ScenarioMailbox {
    ScenarioMailbox { id: id.into(), name: name.into(), parent_id: None, role: role.map(String::from), emails }
}

/// Deterministic bytes.
fn source(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 56) as u8
        })
        .collect()
}

fn b64_lines(bytes: &[u8]) -> String {
    let s = mock_jmap::base64_encode(bytes);
    s.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("\r\n")
}

/// A scenario with Inbox, Sent, Drafts, Trash and Projects holding `inbox`, and two identities
/// (the account's own address second).
fn scenario(inbox: Vec<ScenarioEmail>) -> Scenario {
    Scenario {
        accounts: vec![ScenarioAccount {
            username: ME.into(),
            password: PASSWORD.into(),
            token: Some(TOKEN.into()),
            mailboxes: vec![
                mailbox("mb-inbox", "Inbox", Some("inbox"), inbox),
                mailbox("mb-sent", "Sent", Some("sent"), vec![]),
                mailbox("mb-drafts", "Drafts", Some("drafts"), vec![]),
                mailbox("mb-trash", "Trash", Some("trash"), vec![]),
                mailbox("mb-proj", "Projects", None, vec![]),
            ],
            identities: vec![("alias@example.test".into(), "Alias".into()), (ME.into(), "Me".into())],
        }],
        ..Scenario::default()
    }
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
    m: MockJmap,
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    engine: Engine,
    events: Arc<Events>,
    logs: Arc<Mutex<Vec<String>>>,
    account: String,
}

/// A mock serving `s` and an engine with no account yet.
fn engine_only(s: Scenario) -> Fx {
    let m = MockJmap::start(s);
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::clone(&secrets) as _).unwrap();
    engine.allow_jmap_loopback();
    engine.set_action_backoff(Duration::from_millis(50), Duration::from_millis(200));
    engine.set_outbox_backoff(Duration::from_millis(50), Duration::from_millis(200));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    let logs: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = Arc::clone(&logs);
    assert!(engine.set_log_sink(move |line| l.lock().unwrap().push(line.to_string())));
    Fx { m, tmp, secrets, engine, events, logs, account: String::new() }
}

/// [`engine_only`] plus the account added through the form with the typed session URL.
fn setup(s: Scenario) -> Fx {
    let mut f = engine_only(s);
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD, "jmapUrl": f.m.session_url() }));
    assert_eq!(r["ok"], true, "{r}; logs {:?}", f.logs.lock().unwrap());
    f.account = r["account"]["id"].as_str().unwrap().to_string();
    f
}

impl Fx {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    fn rpc(&self, method: &str, params: Value) -> Value {
        self.engine.rpc(method, params).unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    fn add(&self, params: Value) -> Value {
        self.rpc("mobile.accounts.add", params)
    }

    fn try_sync(&self, folder: Option<&str>) -> Value {
        let from = self.events.len();
        let mut p = json!({ "accountId": self.account });
        if let Some(f) = folder {
            p["folder"] = json!(f);
        }
        self.rpc("mobile.sync.refresh", p);
        self.events
            .wait(from, "sync end", |n, v| n == "mobile.sync.state" && v["accountId"] == self.account.as_str() && (v["state"] == "idle" || v["state"] == "error"))
            .1
    }

    fn sync(&self, folder: Option<&str>) {
        let end = self.try_sync(folder);
        assert_eq!(end["state"], "idle", "sync ended in error: {end}; logs {:?}", self.logs.lock().unwrap());
    }

    fn folders(&self) -> Vec<Value> {
        self.rpc("mobile.folders.list", json!({ "accountId": self.account }))["folders"].as_array().unwrap().clone()
    }

    fn rows(&self, folder: &str) -> Vec<Value> {
        self.rpc("mobile.messages.page", json!({ "accountId": self.account, "folder": folder, "cursor": null, "limit": 200 }))["rows"]
            .as_array()
            .unwrap()
            .clone()
    }

    /// subject -> uid of the folder's rows.
    fn uids(&self, folder: &str) -> HashMap<String, i64> {
        self.rows(folder).iter().map(|r| (r["subject"].as_str().unwrap().to_string(), r["uid"].as_i64().unwrap())).collect()
    }

    fn apply(&self, kind: &str, folder: &str, uids: &[i64], target: Option<&str>) {
        let mut p = json!({ "accountId": self.account, "folder": folder, "uids": uids, "kind": kind });
        if let Some(t) = target {
            p["target"] = json!(t);
        }
        let r = self.rpc("mobile.actions.apply", p);
        assert!(r["queued"].as_i64().is_some(), "{r}");
    }

    fn wait_pending_empty(&self) {
        let deadline = Instant::now() + WAIT;
        loop {
            let p = self.rpc("mobile.actions.pending", json!({ "accountId": self.account }))["pending"].as_array().unwrap().clone();
            if p.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "journal never drained: {p:?}; logs {:?}", self.logs.lock().unwrap());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn body(&self, folder: &str, uid: i64) -> Value {
        self.rpc("mobile.message.body", json!({ "accountId": self.account, "folder": folder, "uid": uid }))
    }

    fn fetch(&self, uid: i64, section: &str) -> Result<u64, mailvault_mobile_engine::RpcError> {
        self.engine
            .rpc("mobile.attachment.fetch", json!({ "accountId": self.account, "folder": "INBOX", "uid": uid, "section": section }))
            .map(|v| v["jobId"].as_u64().unwrap())
    }

    fn email(&self, id: &str) -> Option<mock_jmap::Email> {
        self.m.read(|s| s.email(ACC, id).cloned())
    }

    fn mailboxes_of(&self, id: &str) -> Vec<String> {
        self.email(id).map(|e| e.mailbox_ids.into_iter().collect()).unwrap_or_default()
    }

    fn api_calls(&self, method: &str) -> Vec<mock_jmap::RecordedRequest> {
        self.m.requests().into_iter().filter(|r| r.calls.iter().any(|c| c == method)).collect()
    }

    fn downloads(&self) -> Vec<mock_jmap::RecordedRequest> {
        self.m.requests().into_iter().filter(|r| r.path.starts_with("/jmap/download/")).collect()
    }

    fn send(&self, extra: Value) -> Result<Value, mailvault_mobile_engine::RpcError> {
        let mut p = json!({ "accountId": self.account, "to": "rcpt@example.test", "cc": "", "bcc": "", "subject": "Hello JMAP", "text": "Body over JMAP", "attachments": [] });
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        self.engine.rpc("mobile.compose.send", p)
    }

    fn send_outcome(&self, from: usize, id: &str) -> Value {
        self.events.wait(from, "send result", |n, v| n == "mobile.send.result" && v["id"] == id && v["outcome"] != "queued").1
    }

    /// A picked file of `len` bytes that takes no disk space; its handle.
    fn pick_sparse(&self, name: &str, len: u64) -> String {
        let d = self.tmp.path().join("cache").join("out").join("0123456789abcdef");
        std::fs::create_dir_all(&d).unwrap();
        let f = std::fs::File::create(d.join(name)).unwrap();
        f.set_len(len).unwrap();
        format!("out/0123456789abcdef/{name}")
    }

    /// No secret in mobile.db (and its WAL) or the log.
    fn assert_no_secret(&self, secrets: &[&str]) {
        for file in ["mobile.db", "mobile.db-wal"] {
            if let Ok(bytes) = std::fs::read(self.tmp.path().join(file)) {
                let text = String::from_utf8_lossy(&bytes);
                for s in secrets {
                    assert!(!text.contains(s), "{s} in {file}");
                }
            }
        }
        for line in self.logs.lock().unwrap().iter() {
            for s in secrets {
                assert!(!line.contains(s), "{s} in log line {line}");
            }
        }
    }
}

// ── The tests ───────────────────────────────────────────────────────────────

#[test]
fn jmap_add_discovers_and_verifies() {
    let now = now_secs();
    let f = engine_only(scenario(vec![email("e1", "Welcome", now - 3600)]));

    // Discovery found a host the address's domain does not vouch for: the password never goes
    // there; the page is told the host and the URL to confirm.
    f.engine.set_jmap_discovery(Some((&f.m.session_url(), true)));
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD }));
    assert_eq!((r["ok"].as_bool(), r["code"].as_str()), (Some(false), Some("CONFIRM_HOST")), "{r}");
    assert_eq!(r["jmapUrl"], f.m.session_url().as_str(), "{r}");
    assert!(r["host"].as_str().is_some_and(|h| h.starts_with("127.0.0.1")), "{r}");
    assert!(f.m.requests().is_empty(), "nothing sent to an unconfirmed host: {:?}", f.m.requests());

    // Nothing found: the page asks for the server address.
    f.engine.set_jmap_discovery(None);
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD }));
    assert_eq!(r["code"], "JMAP_NOT_FOUND", "{r}");

    // A trusted discovery and a wrong password: refused, nothing stored.
    f.engine.set_jmap_discovery(Some((&f.m.session_url(), false)));
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": "wrong" }));
    assert_eq!(r["code"], "AUTH_FAILED", "{r}");
    assert!(f.rpc("mobile.accounts.list", json!({}))["accounts"].as_array().unwrap().is_empty());

    // The app password signs in (Basic), the mailbox list reads, the account is stored.
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD }));
    assert_eq!(r["ok"], true, "{r}; logs {:?}", f.logs.lock().unwrap());
    assert_eq!(r["messageCount"], 1, "{r}");
    assert_eq!(r["account"]["kind"], "jmap");
    let id = r["account"]["id"].as_str().unwrap().to_string();
    let (kind, auth, url): (String, String, String) =
        f.db().query_row("SELECT kind, auth, jmap_url FROM accounts WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((kind.as_str(), auth.as_str(), url.as_str()), ("jmap", "password", f.m.session_url().as_str()));
    assert_eq!(Credential::parse(&f.secrets.get(&id).unwrap().unwrap()).password.as_deref(), Some(PASSWORD));
    assert!(f.m.requests().iter().any(|r| r.is_api() && r.calls.iter().any(|c| c == "Mailbox/get")), "verified by reading the mailboxes");
    let listed = f.rpc("mobile.accounts.list", json!({}));
    assert_eq!(listed["accounts"][0]["kind"], "jmap", "{listed}");

    // A second add of the same address.
    let again = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD, "jmapUrl": f.m.session_url() }));
    assert_eq!(again["code"], "DUPLICATE", "{again}");

    // It syncs.
    let f = Fx { account: id, ..f };
    f.sync(None);
    assert!(f.uids("INBOX").contains_key("Welcome"), "{:?}", f.rows("INBOX"));
    f.assert_no_secret(&[PASSWORD]);

    // A token pasted into the same field signs in as Bearer.
    let g = engine_only(scenario(vec![]));
    let r = g.add(json!({ "kind": "jmap", "email": ME, "password": TOKEN, "jmapUrl": g.m.session_url() }));
    assert_eq!(r["ok"], true, "{r}");
    let auth: String = g.db().query_row("SELECT auth FROM accounts", [], |r| r.get(0)).unwrap();
    assert_eq!(auth, "bearer");
    assert!(g.m.requests().iter().any(|r| r.authorization.as_deref() == Some(&format!("Bearer {TOKEN}"))));
    g.assert_no_secret(&[TOKEN]);
}

#[test]
fn an_http_session_url_is_refused() {
    let f = engine_only(scenario(vec![]));
    // Not loopback: credentials only ever go over https.
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD, "jmapUrl": "http://jmap.example.test/jmap/session" }));
    assert_eq!((r["ok"].as_bool(), r["code"].as_str()), (Some(false), Some("HTTPS_REQUIRED")), "{r}");
    assert!(f.m.requests().is_empty());
    assert!(f.rpc("mobile.accounts.list", json!({}))["accounts"].as_array().unwrap().is_empty());

    // A session whose API endpoint is plain http elsewhere: refused before any method call.
    f.m.mutate(|s| s.api_url_override = Some("http://api.example.test/jmap/api".into()));
    let r = f.add(json!({ "kind": "jmap", "email": ME, "password": PASSWORD, "jmapUrl": f.m.session_url() }));
    assert_eq!(r["code"], "HTTPS_REQUIRED", "{r}");
    assert!(!f.m.requests().iter().any(|r| r.is_api()), "no API call: {:?}", f.m.requests());
    assert!(f.rpc("mobile.accounts.list", json!({}))["accounts"].as_array().unwrap().is_empty());
}

#[test]
fn jmap_sync_pages_and_follows_changes_by_state() {
    let now = now_secs();
    let mut inbox: Vec<ScenarioEmail> = (0..120).map(|i| email(&format!("m{i:03}"), &format!("Mail {i:03}"), now - (200 - i) * 600)).collect();
    inbox.push(email("old", "Too old", now - 100 * DAY));
    let mut labelled = email("lab", "Labelled", now - 60);
    labelled.also_in = vec!["mb-proj".into()];
    inbox.push(labelled);
    let mut s = scenario(inbox);
    // The server caps a query page at 50, so the window takes several.
    s.limits = Limits { max_query_limit: 50, ..Limits::default() };
    let f = setup(s);
    f.sync(None);

    let folders = f.folders();
    let inbox = folders.iter().find(|x| x["path"] == "INBOX").unwrap_or_else(|| panic!("no INBOX row: {folders:?}"));
    assert_eq!(inbox["total"], 122, "{inbox}");
    let trash = folders.iter().find(|x| x["specialUse"] == "\\Trash").expect("the trash role is Trash");
    assert_eq!(trash["path"], "mb-trash", "a JMAP folder's path is its mailbox id");
    assert!(folders.iter().any(|x| x["path"] == "mb-proj" && x["name"] == "Projects"), "{folders:?}");

    let rows = f.rows("INBOX");
    assert_eq!(rows.len(), 121, "the window: every recent message, not the old one");
    let uids: Vec<i64> = rows.iter().map(|r| r["uid"].as_i64().unwrap()).collect();
    assert!(uids.windows(2).all(|w| w[0] > w[1]), "uids follow the received order: {uids:?}");
    let queries: Vec<_> = f.api_calls("Email/query");
    assert!(queries.len() >= 3, "paged by what the server gave: {}", queries.len());
    assert!(queries.iter().all(|q| q.body_contains("\"after\"")), "the window is a date bound");
    let first = f.uids("INBOX");

    // The labelled email is in both mailboxes, each with its own uid, and opens in each.
    f.sync(Some("mb-proj"));
    let in_proj = f.uids("mb-proj");
    assert!(in_proj.contains_key("Labelled"), "{in_proj:?}");
    assert_ne!(in_proj["Labelled"], first["Labelled"]);
    f.sync(Some("INBOX"));
    assert_eq!(f.uids("INBOX").get("Labelled"), first.get("Labelled"), "a pass of another mailbox leaves INBOX's mapping alone");
    assert!(f.body("INBOX", first["Labelled"])["text"].as_str().unwrap_or("").contains("Body of Labelled"));
    assert!(f.body("mb-proj", in_proj["Labelled"])["text"].as_str().unwrap_or("").contains("Body of Labelled"));
    let state: Option<String> = f.db().query_row("SELECT token FROM sync_state WHERE account_id = ?1 AND folder = 'INBOX'", [&f.account], |r| r.get(0)).unwrap();
    assert!(state.is_some(), "the folder's Email state is stored");

    // A change on the server: the next pass reads that email's keywords only.
    f.m.mutate(|s| s.set_keywords(ACC, "m010", &["$seen", "$flagged"]));
    let before = f.m.requests().len();
    f.sync(Some("INBOX"));
    let row = f.rows("INBOX").into_iter().find(|r| r["subject"] == "Mail 010").unwrap();
    assert_eq!((row["seen"].as_bool(), row["flagged"].as_bool()), (Some(true), Some(true)), "{row}");
    let pass: Vec<_> = f.m.requests().into_iter().skip(before).collect();
    assert!(pass.iter().any(|r| r.calls.iter().any(|c| c == "Email/changes")), "followed the stored state");
    let reads: Vec<&mock_jmap::RecordedRequest> = pass.iter().filter(|r| r.calls.iter().any(|c| c == "Email/get") && r.body_contains("\"keywords\"]")).collect();
    assert_eq!(reads.len(), 1, "{pass:?}");
    assert!(reads[0].body_contains("\"m010\"") && !reads[0].body_contains("\"m011\""), "only the changed email: {}", reads[0].body);

    // A state the server can no longer bridge: a full flag pass instead, still right.
    f.m.mutate(|s| {
        s.set_keywords(ACC, "m020", &["$seen"]);
        s.prune_log(ACC);
    });
    f.sync(Some("INBOX"));
    let row = f.rows("INBOX").into_iter().find(|r| r["subject"] == "Mail 020").unwrap();
    assert_eq!(row["seen"], true, "{row}");

    // A new arrival gets a higher uid; a destroyed email goes; known ones keep theirs.
    f.m.mutate(|s| {
        s.add_email(ACC, "mb-inbox", email("new", "Newest", now_secs()));
        s.destroy_email(ACC, "m005");
    });
    f.sync(Some("INBOX"));
    let second = f.uids("INBOX");
    assert!(second["Newest"] > *first.values().max().unwrap());
    assert!(!second.contains_key("Mail 005"));
    for (subject, uid) in &first {
        if subject != "Mail 005" {
            assert_eq!(second.get(subject), Some(uid), "{subject} kept its uid");
        }
    }
}

#[test]
fn jmap_actions_and_delete_to_trash() {
    let now = now_secs();
    let mut labelled = email("lab", "Labelled", now - 100);
    labelled.also_in = vec!["mb-proj".into()];
    let f = setup(scenario(vec![email("a", "Alpha", now - 400), email("b", "Bravo", now - 300), email("c", "Charlie", now - 200), labelled]));
    f.sync(None);
    let uids = f.uids("INBOX");
    let keywords = |id: &str| f.email(id).unwrap().keywords.into_iter().collect::<Vec<_>>();

    f.apply("seen", "INBOX", &[uids["Alpha"]], None);
    f.apply("flag", "INBOX", &[uids["Alpha"]], None);
    f.wait_pending_empty();
    assert_eq!(keywords("a"), vec!["$flagged".to_string(), "$seen".to_string()]);
    f.apply("unseen", "INBOX", &[uids["Alpha"]], None);
    f.apply("unflag", "INBOX", &[uids["Alpha"]], None);
    f.wait_pending_empty();
    assert!(keywords("a").is_empty(), "{:?}", keywords("a"));

    // A move: the email keeps its id; it is mapped anew in the target.
    f.apply("move", "INBOX", &[uids["Bravo"]], Some("mb-proj"));
    f.wait_pending_empty();
    assert_eq!(f.mailboxes_of("b"), vec!["mb-proj".to_string()]);
    let new_uid: i64 = f
        .db()
        .query_row("SELECT uid FROM remote_ids WHERE account_id = ?1 AND folder = 'mb-proj' AND remote_id = 'mb-proj|b'", [&f.account], |r| r.get(0))
        .expect("the move mapped the email in the target");
    let old: i64 = f.db().query_row("SELECT count(*) FROM remote_ids WHERE folder = 'INBOX' AND remote_id = 'INBOX|b'", [], |r| r.get(0)).unwrap();
    assert_eq!(old, 0, "the source mapping went");
    assert!(!f.uids("INBOX").contains_key("Bravo"));
    f.sync(Some("mb-proj"));
    assert_eq!(f.uids("mb-proj").get("Bravo"), Some(&new_uid), "sync keeps the uid the move gave");

    // A delete moves to Trash; a delete in Trash is for good.
    f.apply("delete", "INBOX", &[uids["Charlie"]], None);
    f.wait_pending_empty();
    assert_eq!(f.mailboxes_of("c"), vec!["mb-trash".to_string()]);
    f.sync(Some("mb-trash"));
    let in_trash = f.uids("mb-trash");
    f.apply("delete", "mb-trash", &[in_trash["Charlie"]], None);
    f.wait_pending_empty();
    assert!(f.email("c").is_none(), "destroyed from Trash");

    // An email that is also elsewhere only loses this mailbox's label.
    f.apply("delete", "INBOX", &[uids["Labelled"]], None);
    f.wait_pending_empty();
    assert_eq!(f.mailboxes_of("lab"), vec!["mb-proj".to_string()]);
    assert!(f.api_calls("Email/set").iter().all(|r| !r.body_contains("\"destroy\":[\"lab\"]")));
}

#[test]
fn opening_a_jmap_message_fetches_no_attachment_and_a_tap_streams_one() {
    let now = now_secs();
    let pdf = source(600 * 1024, 7);
    let zip = source(300 * 1024, 9);
    let mime = format!(
        "From: Alice <alice@example.test>\r\nTo: {ME}\r\nSubject: With files\r\nMessage-ID: <files@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"OUT\"\r\n\r\n\
--OUT\r\nContent-Type: multipart/alternative; boundary=\"ALT\"\r\n\r\n\
--ALT\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain body\r\n\
--ALT\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Html body</p>\r\n\
--ALT--\r\n\
--OUT\r\nContent-Type: application/pdf; name=\"doc.pdf\"\r\nContent-Disposition: attachment; filename=\"doc.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n\
--OUT\r\nContent-Type: application/zip; name=\"big.zip\"\r\nContent-Disposition: attachment; filename=\"big.zip\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n\
--OUT--\r\n",
        b64_lines(&pdf),
        b64_lines(&zip)
    );
    let e = ScenarioEmail { id: "files".into(), raw: mime, keywords: vec![], received_at: iso(now - 600), also_in: vec![] };
    let f = setup(scenario(vec![e]));
    f.sync(None);
    let uid = f.uids("INBOX")["With files"];
    let before = f.m.requests().len();

    // Opening: the body from its values and the attachments' metadata, no blob.
    let body = f.body("INBOX", uid);
    assert!(body["html"].as_str().unwrap_or("").contains("Html body"), "{body}");
    assert!(body["text"].as_str().unwrap_or("").contains("Plain body"), "{body}");
    assert_eq!(body["attachmentsUnknown"], false, "{body}");
    let atts = body["attachments"].as_array().unwrap().clone();
    assert_eq!(atts.len(), 2, "{body}");
    let pdf_part = atts.iter().find(|a| a["filename"] == "doc.pdf").unwrap()["section"].as_str().unwrap().to_string();
    let zip_part = atts.iter().find(|a| a["filename"] == "big.zip").unwrap()["section"].as_str().unwrap().to_string();
    assert_eq!(atts.iter().find(|a| a["filename"] == "doc.pdf").unwrap()["size"], pdf.len(), "the decoded size");
    let open: Vec<_> = f.m.requests().into_iter().skip(before).collect();
    assert!(!open.iter().any(|r| r.path.starts_with("/jmap/download/")), "no bytes on open: {open:?}");
    let get = open.iter().find(|r| r.calls.iter().any(|c| c == "Email/get")).expect("one Email/get");
    for wanted in ["\"fetchHTMLBodyValues\":true", "\"fetchTextBodyValues\":true", "\"bodyProperties\"", "\"maxBodyValueBytes\"", "\"attachments\""] {
        assert!(get.body_contains(wanted), "{wanted} in {}", get.body);
    }

    // A tap streams that part only, through the attachment worker's range reads.
    let from = f.events.len();
    let job = f.fetch(uid, &pdf_part).unwrap();
    let (name, v) = f.events.wait(from, "attachment end", |n, v| (n == "mobile.attachment.done" || n == "mobile.attachment.failed") && v["jobId"] == job);
    assert_eq!(name, "mobile.attachment.done", "{v}; logs {:?}", f.logs.lock().unwrap());
    let path = PathBuf::from(v["path"].as_str().unwrap());
    assert!(std::fs::read(&path).unwrap() == pdf, "the attachment is the PDF");
    let downloads = f.downloads();
    assert_eq!(downloads.len(), 1, "one download for the whole file: {downloads:?}");
    let blob = f.m.read(|s| s.email(ACC, "files").unwrap().blob_id.clone());
    assert!(downloads[0].path.contains(&mock_jmap::methods::part_blob_id(&blob, &pdf_part)), "the listed blob: {}", downloads[0].path);
    let progress = f.events.list.lock().unwrap().iter().skip(from).filter(|(n, v)| n == "mobile.attachment.progress" && v["jobId"] == job).count();
    assert!(progress >= 2, "progress as the chunks arrive: {progress}");
    assert!(!downloads.iter().any(|d| d.path.contains(&format!("_{zip_part}/"))), "only the tapped part");

    // Never fetched: a part the message does not list, a section of dots.
    for bad in ["99", "..", "."] {
        let err = f.fetch(uid, bad).expect_err(bad);
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    assert_eq!(f.downloads().len(), 1);
}

#[test]
fn jmap_send_submits_with_the_matching_identity() {
    let f = setup(scenario(vec![]));
    f.sync(None);
    let before = f.m.requests().len();
    let from = f.events.len();
    let id = f.send(json!({ "bcc": "hidden@example.test" })).unwrap()["id"].as_str().unwrap().to_string();
    let done = f.send_outcome(from, &id);
    assert_eq!(done["outcome"], "sent", "{done}; logs {:?}", f.logs.lock().unwrap());

    let submitted = f.m.submitted();
    assert_eq!(submitted.len(), 1);
    let raw = String::from_utf8_lossy(&submitted[0]).into_owned();
    assert!(raw.contains("Subject: Hello JMAP"), "{raw}");
    let sub = f.api_calls("EmailSubmission/set");
    assert_eq!(sub.len(), 1);
    assert!(sub[0].body_contains("\"identityId\":\"id2\""), "the identity whose address is the account's: {}", sub[0].body);
    assert!(sub[0].body_contains("onSuccessUpdateEmail"), "the server files it in Sent: {}", sub[0].body);
    let pass: Vec<_> = f.m.requests().into_iter().skip(before).collect();
    assert_eq!(pass.iter().filter(|r| r.path.starts_with("/jmap/upload/")).count(), 1, "one upload, no separate Sent append");
    let in_sent = f.m.read(|s| s.emails_in(ACC, "mb-sent"));
    assert_eq!(in_sent.len(), 1, "the sent copy is in Sent");
    let state: String = f.db().query_row("SELECT state FROM outbox WHERE id = ?1", [id.as_str()], |r| r.get(0)).unwrap();
    assert_eq!(state, "sent");

    // An answer lost after the submission went out: uncertain, never sent again.
    f.m.mutate(|s| s.faults.push(Fault::SubmissionReplyLostOnce));
    let from = f.events.len();
    let id = f.send(json!({ "subject": "Lost answer" })).unwrap()["id"].as_str().unwrap().to_string();
    let done = f.send_outcome(from, &id);
    assert_eq!(done["outcome"], "uncertain", "{done}; logs {:?}", f.logs.lock().unwrap());
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(f.m.submitted().len(), 2, "submitted once, never again");
}

#[test]
fn a_jmap_send_over_the_session_upload_limit_is_refused_before_the_journal() {
    let mut s = scenario(vec![]);
    s.limits = Limits { max_size_upload: 1_000_000, ..Limits::default() };
    let f = setup(s);
    let before = f.m.requests().len();
    let handle = f.pick_sparse("photo.jpg", 900 * 1024);
    let err = f.send(json!({ "attachments": [{ "handle": handle }] })).unwrap_err();
    assert_eq!(err.code(), "TOO_LARGE");
    let v = serde_json::to_value(&err).unwrap();
    let limit = v["data"]["limitBytes"].as_u64().unwrap_or_else(|| panic!("no limit: {v}"));
    assert!(limit > 500_000 && limit < 760_000, "what fits a 1 MB upload in base64: {limit}");
    let rows: i64 = f.db().query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "nothing journalled");
    assert_eq!(f.m.requests().len(), before, "no HTTP");
    let small = f.pick_sparse("note.txt", 100 * 1024);
    assert!(f.send(json!({ "attachments": [{ "handle": small }] })).is_ok());
}

#[test]
fn an_expired_jmap_session_connects_again_once() {
    let now = now_secs();
    let f = setup(scenario(vec![email("a", "Alpha", now - 100)]));
    f.sync(None);
    // The cached session's next API call is refused once; connecting again works.
    f.m.mutate(|s| {
        s.faults.push(Fault::UnauthorizedOnce);
        s.add_email(ACC, "mb-inbox", email("b", "Bravo", now - 50));
    });
    f.sync(Some("INBOX"));
    assert!(f.uids("INBOX").contains_key("Bravo"));
    // Refused for good: AUTH_FAILED, the secret stays.
    f.m.mutate(|s| s.faults.push(Fault::Unauthorized));
    let end = f.try_sync(Some("INBOX"));
    assert_eq!((end["state"].as_str(), end["code"].as_str()), (Some("error"), Some("AUTH_FAILED")), "{end}");
    assert!(f.secrets.get(&f.account).unwrap().is_some());
}

#[test]
fn a_pass_that_stops_after_its_flags_keeps_the_state_and_reads_them_again() {
    let now = now_secs();
    let f = setup(scenario(vec![email("a", "Alpha", now - 400), email("b", "Bravo", now - 300)]));
    f.sync(None);
    let token = || -> Option<String> {
        f.db().query_row("SELECT token FROM sync_state WHERE account_id = ?1 AND folder = 'INBOX'", [&f.account], |r| r.get(0)).unwrap()
    };
    let before = token().expect("a first pass stores the state");

    // Alpha is read on the server and a new email arrives; the pass reads the flags, then its
    // header read fails, so the pass stops before it completes.
    f.m.mutate(|s| {
        s.set_keywords(ACC, "a", &["$seen"]);
        s.add_email(ACC, "mb-inbox", email("c", "Charlie", now - 10));
        s.faults.push(Fault::ServerFailIf { method: "Email/get".into(), needle: "header:List-Id".into() });
    });
    let end = f.try_sync(Some("INBOX"));
    assert_eq!(end["state"], "error", "{end}");
    assert_eq!(token().as_deref(), Some(before.as_str()), "the state waits for a pass that wrote everything");

    // Those flag writes lost (an engine killed mid-pass): the next pass reads Alpha again.
    f.db().execute("UPDATE messages SET seen = 0 WHERE account_id = ?1 AND subject = 'Alpha'", [&f.account]).unwrap();
    f.m.mutate(|s| s.faults.clear());
    f.sync(Some("INBOX"));
    let row = f.rows("INBOX").into_iter().find(|r| r["subject"] == "Alpha").unwrap();
    assert_eq!(row["seen"], true, "{row}");
    assert!(f.uids("INBOX").contains_key("Charlie"));
    assert_ne!(token().as_deref(), Some(before.as_str()), "stored once the pass completed");
}

#[test]
fn a_mapping_with_no_row_is_cleaned_up_by_the_next_pass() {
    let f = setup(scenario(vec![email("a", "Alpha", now_secs() - 400)]));
    f.sync(None);
    f.db()
        .execute("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES (?1, 'INBOX', 9999, 'INBOX|ghost')", [&f.account])
        .unwrap();
    f.sync(Some("INBOX"));
    let left: i64 = f.db().query_row("SELECT count(*) FROM remote_ids WHERE remote_id = 'INBOX|ghost'", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
    let kept: i64 = f.db().query_row("SELECT count(*) FROM remote_ids WHERE remote_id = 'INBOX|a'", [], |r| r.get(0)).unwrap();
    assert_eq!(kept, 1, "a mapping with its row stays");
}

#[test]
fn a_body_the_server_cuts_short_is_marked_and_not_cached() {
    let long = "x".repeat(2 * 1024 * 1024 + 4096);
    let raw = format!("From: Alice <alice@example.test>\r\nTo: {ME}\r\nSubject: Long\r\nMessage-ID: <long@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{long}\r\n");
    let e = ScenarioEmail { id: "long".into(), raw, keywords: vec![], received_at: iso(now_secs() - 60), also_in: vec![] };
    let f = setup(scenario(vec![e, email("s", "Short", now_secs() - 30)]));
    f.sync(None);
    let uids = f.uids("INBOX");
    let cached = |uid: i64| -> i64 { f.db().query_row("SELECT count(*) FROM bodies WHERE uid = ?1", [uid], |r| r.get(0)).unwrap() };
    let body = f.body("INBOX", uids["Long"]);
    assert_eq!(body["truncated"], true);
    assert!(body["text"].as_str().unwrap_or("").len() <= 2 * 1024 * 1024);
    assert_eq!(cached(uids["Long"]), 0, "never cached as the whole message");
    assert_eq!(f.body("INBOX", uids["Short"])["truncated"], false);
    assert_eq!(cached(uids["Short"]), 1);
}

#[test]
fn a_target_pass_that_lists_before_a_move_keeps_the_mapping_a_queued_action_names() {
    let now = now_secs();
    let f = setup(scenario(vec![email("b", "Bravo", now - 300)]));
    f.sync(None);
    f.sync(Some("mb-proj"));
    let uid = f.uids("INBOX")["Bravo"];
    // A move and a read on the same row, both queued while the server holds the move back.
    f.m.mutate(|s| s.faults.push(Fault::ServerFailIf { method: "Email/set".into(), needle: "mailboxIds".into() }));
    f.apply("move", "INBOX", &[uid], Some("mb-proj"));
    f.apply("seen", "INBOX", &[uid], None);
    // The move goes through; the read, now following the moved copy, is held back.
    f.m.mutate(|s| s.faults = vec![Fault::ServerFailIf { method: "Email/set".into(), needle: "$seen".into() }]);
    let deadline = Instant::now() + WAIT;
    let pending = loop {
        let p = f.rpc("mobile.actions.pending", json!({ "accountId": f.account }))["pending"].as_array().unwrap().clone();
        if p.len() == 1 && p[0]["folder"] == "mb-proj" {
            break p;
        }
        assert!(Instant::now() < deadline, "the move never settled: {p:?}; logs {:?}", f.logs.lock().unwrap());
        std::thread::sleep(Duration::from_millis(20));
    };
    let new_uid: i64 = f
        .db()
        .query_row("SELECT uid FROM remote_ids WHERE account_id = ?1 AND remote_id = 'mb-proj|b'", [&f.account], |r| r.get(0))
        .expect("the move mapped it in the target");
    assert_eq!(pending[0]["uids"], json!([new_uid]), "the read follows the moved copy: {pending:?}");
    // The target's pass lists the server as it was before the move (a lagging index).
    f.m.mutate(|s| s.set_mailboxes(ACC, "b", &["mb-inbox"]));
    f.sync(Some("mb-proj"));
    let mapped: i64 = f.db().query_row("SELECT count(*) FROM remote_ids WHERE remote_id = 'mb-proj|b'", [], |r| r.get(0)).unwrap();
    assert_eq!(mapped, 1, "a mapping a queued action names is the journal's");

    // The server catches up: the read is applied, not dropped as gone.
    f.m.mutate(|s| {
        s.set_mailboxes(ACC, "b", &["mb-proj"]);
        s.faults.clear();
    });
    f.wait_pending_empty();
    assert!(f.email("b").unwrap().keywords.contains("$seen"), "{:?}; logs {:?}", f.email("b"), f.logs.lock().unwrap());
}

#[test]
fn a_cut_text_beside_a_whole_html_is_a_cut_body() {
    let long = "y".repeat(2 * 1024 * 1024 + 4096);
    let raw = format!(
        "From: Alice <alice@example.test>\r\nTo: {ME}\r\nSubject: Mixed\r\nMessage-ID: <mixed@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"ALT\"\r\n\r\n--ALT\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{long}\r\n--ALT\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>short html</p>\r\n--ALT--\r\n"
    );
    let e = ScenarioEmail { id: "mixed".into(), raw, keywords: vec![], received_at: iso(now_secs() - 60), also_in: vec![] };
    let f = setup(scenario(vec![e]));
    f.sync(None);
    let uid = f.uids("INBOX")["Mixed"];
    let body = f.body("INBOX", uid);
    assert!(body["html"].as_str().unwrap_or("").contains("short html"), "{}", &body.to_string()[..200.min(body.to_string().len())]);
    assert_eq!(body["truncated"], true);
    let cached: i64 = f.db().query_row("SELECT count(*) FROM bodies WHERE uid = ?1", [uid], |r| r.get(0)).unwrap();
    assert_eq!(cached, 0);
}

#[test]
fn the_attachments_of_a_body_the_server_cuts_short_can_still_be_opened() {
    let long = "z".repeat(2 * 1024 * 1024 + 4096);
    let pdf = b64_lines(b"%PDF-1.4 attached to a long mail");
    let raw = format!(
        "From: Alice <alice@example.test>\r\nTo: {ME}\r\nSubject: LongAtt\r\nMessage-ID: <longatt@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"MIX\"\r\n\r\n--MIX\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{long}\r\n--MIX\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{pdf}\r\n--MIX--\r\n"
    );
    let e = ScenarioEmail { id: "longatt".into(), raw, keywords: vec![], received_at: iso(now_secs() - 60), also_in: vec![] };
    let f = setup(scenario(vec![e]));
    f.sync(None);
    let uid = f.uids("INBOX")["LongAtt"];
    let body = f.body("INBOX", uid);
    assert_eq!(body["truncated"], true);
    let parts = body["attachments"].as_array().cloned().unwrap_or_default();
    let section = parts.iter().find(|p| p["filename"] == "a.pdf").unwrap_or_else(|| panic!("no attachment listed: {body}"))["section"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(f.fetch(uid, &section).is_ok(), "the listed attachment can be fetched");
}
