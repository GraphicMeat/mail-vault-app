//! Microsoft Graph accounts (`kind = graph`) end to end against the routed Graph mock in
//! `support/graph.rs`: folders and the 90-day header window with local uids from `remote_ids`,
//! read/flag/move/delete through the journal, bodies from the message resource and attachments
//! fetched one by one on a tap, sends through `sendMail` with no Sent append (and the 4 MB
//! limit checked before anything is journalled), throttling, an expired token, a token Graph keeps
//! refusing, and the Microsoft sign-in that creates the account.
//!
//! `MAILVAULT_GRAPH_BASE` is read once per process, so every test shares one mock and holds
//! [`serial`] for its whole run.

#[path = "support/graph.rs"]
mod graph_mock;

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

fn plain(subject: &str) -> String {
    format!("<p>Body of {subject}.</p>")
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

    fn fetch(&self, uid: i64, section: &str) -> Result<u64, mailvault_mobile_engine::RpcError> {
        self.engine
            .rpc("mobile.attachment.fetch", json!({ "accountId": ACCOUNT, "folder": "INBOX", "uid": uid, "section": section }))
            .map(|v| v["jobId"].as_u64().unwrap())
    }

    /// A job's `done` or `failed` event, after `from`.
    fn job_end(&self, from: usize, job: u64) -> (String, Value) {
        self.events.wait(from, "attachment end", |n, v| (n == "mobile.attachment.done" || n == "mobile.attachment.failed") && v["jobId"] == job)
    }

    fn body(&self, uid: i64) -> Value {
        self.rpc("mobile.message.body", json!({ "accountId": ACCOUNT, "folder": "INBOX", "uid": uid }))
    }

    /// A picked file of `len` bytes that takes no disk space; its handle.
    fn pick_sparse(&self, name: &str, len: u64) -> String {
        let d = self.cache().join("out").join("0123456789abcdef");
        std::fs::create_dir_all(&d).unwrap();
        let f = std::fs::File::create(d.join(name)).unwrap();
        f.set_len(len).unwrap();
        format!("out/0123456789abcdef/{name}")
    }

    fn send(&self, extra: Value) -> Result<Value, mailvault_mobile_engine::RpcError> {
        let mut p = json!({ "accountId": ACCOUNT, "to": "rcpt@example.test", "cc": "", "bcc": "", "subject": "Hello Graph", "text": "Body over Graph", "attachments": [] });
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        self.engine.rpc("mobile.compose.send", p)
    }

    fn needs_auth(&self) -> i64 {
        self.db().query_row("SELECT needs_auth FROM accounts WHERE id = ?1", [ACCOUNT], |r| r.get(0)).unwrap()
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
        f.g.add_message("inbox", &format!("Mail {i:03}"), now - (200 - i) * HOUR / 10, &plain(&format!("Mail {i:03}")));
    }
    f.g.add_message("inbox", "Too old", now - 100 * DAY, &plain("Too old"));

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
    f.g.add_message("inbox", "Newest", now - 1000, &plain("Newest"));
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
        f.g.add_message("inbox", s, now - (10 - i as i64) * HOUR, &plain(s));
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
fn opening_a_graph_message_fetches_no_attachment_and_a_tap_fetches_one() {
    let f = setup();
    let pdf = source(600 * 1024, 7);
    let id = f.g.add_message("inbox", "With files", now_ms() - HOUR, "<p>Html body</p>");
    let pdf_id = f.g.add_attachment(&id, "doc.pdf", "application/pdf", pdf.clone(), false, None);
    let zip_id = f.g.add_attachment(&id, "big.zip", "application/zip", source(300 * 1024, 9), false, None);
    f.g.add_attachment(&id, "logo.png", "image/png", source(100, 3), true, Some("<logo@x>"));
    let item_id = f.g.add_typed(&id, "itemAttachment", "Forwarded note", "", source(2000, 4), false, None);
    let link_id = f.g.add_typed(&id, "referenceAttachment", "Plan.docx", "", Vec::new(), false, None);
    f.sync(None);
    let uid = f.uids("INBOX")["With files"];
    f.g.clear_requests();

    // Opening: the body and the attachments' metadata (a $select the strict mock accepts), no
    // bytes of any attachment.
    let body = f.body(uid);
    assert!(body["html"].as_str().unwrap_or("").contains("Html body"), "{body}");
    let atts = body["attachments"].as_array().unwrap();
    assert_eq!(atts.len(), 5, "{body}");
    let by = |section: &str| atts.iter().find(|a| a["section"] == section).cloned().unwrap_or_else(|| panic!("no {section} in {body}"));
    assert_eq!(by(&pdf_id)["mime"], "application/pdf");
    assert_eq!(by(&pdf_id)["kind"], "file");
    let item = by(&item_id);
    assert_eq!((item["mime"].as_str(), item["filename"].as_str()), (Some("message/rfc822"), Some("Forwarded note.eml")), "{item}");
    let link = by(&link_id);
    assert_eq!(link["kind"], "link", "{link}");
    assert!(link["size"].is_null(), "{link}");
    let requests = f.g.requests();
    assert!(!requests.iter().any(|r| r.contains("$value")), "no bytes on open: {requests:?}");
    assert!(requests.iter().any(|r| r.contains("$select=body,bodyPreview")), "{requests:?}");

    // A tap fetches that attachment only, through the attachment worker's range reads.
    let from = f.events.len();
    let job = f.fetch(uid, &pdf_id).unwrap();
    let (name, v) = f.job_end(from, job);
    assert_eq!(name, "mobile.attachment.done", "{v}; logs {:?}", f.logs.lock().unwrap());
    let path = PathBuf::from(v["path"].as_str().unwrap());
    assert!(std::fs::read(&path).unwrap() == pdf, "the attachment is the PDF");
    assert_eq!(f.g.count(&format!("/attachments/{pdf_id}/$value")), 1, "one response for the whole file: {:?}", f.g.requests());
    assert_eq!(f.g.count(&format!("/attachments/{zip_id}/$value")), 0, "only the tapped attachment");
    let progress = f.events.list.lock().unwrap().iter().skip(from).filter(|(n, v)| n == "mobile.attachment.progress" && v["jobId"] == job).count();
    assert!(progress >= 2, "progress as the chunks arrive: {progress}");

    // Never fetched: a link, an id the message does not list, an id of dots.
    for bad in [link_id.as_str(), "AAMkNotListed=", "..", "."] {
        let err = f.fetch(uid, bad).expect_err(bad);
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    assert_eq!(f.g.count("$value"), 1, "{:?}", f.g.requests());
}

#[test]
fn the_attachment_listing_selects_only_base_properties_and_its_failure_spares_the_body() {
    let f = setup();
    // The mock refuses what real Graph refuses: a derived type's property in the collection's
    // $select.
    let (_, access, _) = f.g.grant();
    let id = f.g.add_message("inbox", "Plain", now_ms() - HOUR, "<p>Still readable</p>");
    f.g.add_attachment(&id, "a.txt", "text/plain", b"x".to_vec(), false, None);
    assert_eq!(f.g.raw_get(&format!("/me/messages/{id}/attachments?$select=id,contentId"), &access), 400);
    assert_eq!(f.g.raw_get(&format!("/me/messages/{id}/attachments?$select=id,contentBytes"), &access), 400);
    assert_eq!(f.g.raw_get(&format!("/me/messages/{id}/attachments?$select=id,name,contentType,size,isInline"), &access), 200);

    // A listing that fails: the body still opens, says its attachments are unknown, is not
    // cached, and the log says why.
    f.sync(None);
    let uid = f.uids("INBOX")["Plain"];
    let cached = || -> i64 { f.db().query_row("SELECT count(*) FROM bodies WHERE uid = ?1", [uid], |r| r.get(0)).unwrap() };
    f.g.fail_attachments(true);
    let body = f.body(uid);
    assert!(body["html"].as_str().unwrap_or("").contains("Still readable"), "{body}");
    assert_eq!(body["attachments"].as_array().unwrap().len(), 0, "{body}");
    assert_eq!(body["attachmentsUnknown"], true, "{body}");
    assert_eq!(cached(), 0, "not cached as a message with no attachments");
    assert!(f.logs.lock().unwrap().iter().any(|l| l.contains("attachments were not listed")), "{:?}", f.logs.lock().unwrap());

    // Graph recovers: the next open lists them and caches the body; the one after needs no server.
    f.g.fail_attachments(false);
    let body = f.body(uid);
    assert_eq!(body["attachmentsUnknown"], false, "{body}");
    assert_eq!(body["attachments"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(cached(), 1);
    f.g.clear_requests();
    assert_eq!(f.body(uid)["attachments"].as_array().unwrap().len(), 1);
    assert!(f.g.requests().is_empty(), "served from the cache: {:?}", f.g.requests());
}

#[test]
fn a_graph_attachment_download_shows_progress_and_stops_on_cancel() {
    let f = setup();
    let big = source(2 * 1024 * 1024, 5);
    let id = f.g.add_message("inbox", "Big", now_ms() - HOUR, "<p>big</p>");
    let att = f.g.add_attachment(&id, "big.bin", "application/octet-stream", big, false, None);
    f.sync(None);
    let uid = f.uids("INBOX")["Big"];
    f.body(uid);
    // 32 pieces of 64 KiB, 150 ms apart: about 5 s for the whole file.
    f.g.slow_value(150);
    let from = f.events.len();
    let job = f.fetch(uid, &att).unwrap();
    f.events.wait(from, "first progress", |n, v| n == "mobile.attachment.progress" && v["jobId"] == job);
    let t0 = Instant::now();
    assert_eq!(f.rpc("mobile.attachment.cancel", json!({ "jobId": job }))["cancelled"], true);
    let (name, v) = f.job_end(from, job);
    assert_eq!((name.as_str(), v["code"].as_str()), ("mobile.attachment.failed", Some("CANCELLED")), "{v}");
    assert!(t0.elapsed() < Duration::from_secs(2), "stopped between chunks, not at the end: {:?}", t0.elapsed());
    f.g.slow_value(0);
}

#[test]
fn a_graph_send_over_the_sendmail_limit_is_refused_before_the_journal() {
    let f = setup();
    f.sync(None);
    f.g.clear_requests();
    let handle = f.pick_sparse("photo.jpg", 5 * 1024 * 1024);
    let err = f.send(json!({ "attachments": [{ "handle": handle }] })).unwrap_err();
    assert_eq!(err.code(), "TOO_LARGE");
    let v = serde_json::to_value(&err).unwrap();
    let limit = v["data"]["limitBytes"].as_u64().unwrap_or_else(|| panic!("no limit: {v}"));
    assert!(limit > 1_000_000 && limit < 3 * 1024 * 1024, "the attachments that fit a 4 MB sendMail: {limit}");
    let rows: i64 = f.db().query_row("SELECT count(*) FROM outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "nothing journalled");
    assert!(f.g.requests().is_empty(), "no HTTP: {:?}", f.g.requests());
    // Under the limit it goes.
    let small = f.pick_sparse("note.txt", 100 * 1024);
    assert!(f.send(json!({ "attachments": [{ "handle": small }] })).is_ok());
}

#[test]
fn a_graph_send_whose_answer_is_lost_is_uncertain_and_never_resent() {
    let f = setup();
    f.sync(None);
    f.g.drop_send(true);
    let from = f.events.len();
    let id = f.send(json!({})).unwrap()["id"].as_str().unwrap().to_string();
    let (_, done) = f.events.wait(from, "send result", |n, v| n == "mobile.send.result" && v["id"] == id.as_str() && v["outcome"] != "queued");
    assert_eq!(done["outcome"], "uncertain", "{done}; logs {:?}", f.logs.lock().unwrap());
    let state: String = f.db().query_row("SELECT state FROM outbox WHERE id = ?1", [id.as_str()], |r| r.get(0)).unwrap();
    assert_eq!(state, "uncertain");
    // The outbox does not try again on its own.
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(f.g.sent().len(), 1, "sent once, never again");
}

#[test]
fn a_token_graph_keeps_refusing_parks_the_account_after_three_passes() {
    let f = setup();
    // Refusals count at once here; the span rule is in tests/oauth.rs.
    f.engine.set_oauth_refusal_span(Duration::ZERO);
    f.g.refuse_tokens(true);
    for pass in 1..=3 {
        f.g.clear_requests();
        let end = f.try_sync(None);
        assert_eq!(end["state"], "error", "{end}");
        // Each pass: refused, one refresh, refused again with the fresh token.
        assert_eq!(f.g.count("POST /oauth/token refresh"), 1, "pass {pass}: {:?}", f.g.requests());
        if pass < 3 {
            assert_eq!(end["code"], "AUTH_FAILED", "pass {pass}: {end}");
            assert_eq!(f.needs_auth(), 0);
        } else {
            assert_eq!(end["code"], "NEEDS_AUTH", "{end}");
            assert_eq!(f.needs_auth(), 1, "parked");
        }
    }
    // Parked: no request at all until a new sign-in.
    f.g.clear_requests();
    let end = f.try_sync(None);
    assert_eq!(end["code"], "NEEDS_AUTH");
    assert!(f.g.requests().is_empty(), "{:?}", f.g.requests());
}

#[test]
fn a_move_whose_target_goes_part_way_keeps_the_rest_where_they_were() {
    let f = setup();
    let projects = f.g.add_folder("Projects", None);
    let now = now_ms();
    for (i, s) in ["Alpha", "Bravo", "Charlie"].iter().enumerate() {
        f.g.add_message("inbox", s, now - (10 - i as i64) * HOUR, &plain(s));
    }
    f.sync(None);
    let uids = f.uids("INBOX");
    let all: Vec<i64> = ["Alpha", "Bravo", "Charlie"].iter().map(|s| uids[*s]).collect();
    // The first move lands, then the target is deleted.
    f.g.delete_folder_after_moves(1, &projects);
    f.apply("move", "INBOX", &all, Some(&projects));
    f.wait_pending_empty();
    let left: Vec<String> = f.g.messages_in("inbox").into_iter().map(|m| m.subject).collect();
    assert_eq!(left.len(), 2, "one moved before the target went: {left:?}");
    let shown: Vec<String> = f.rows("INBOX").into_iter().map(|r| r["subject"].as_str().unwrap().to_string()).collect();
    let mut shown_sorted = shown.clone();
    shown_sorted.sort();
    let mut left_sorted = left.clone();
    left_sorted.sort();
    assert_eq!(shown_sorted, left_sorted, "the unmoved ones show again, the moved one does not");
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
    f.g.add_message("inbox", "One", now - 2 * HOUR, &plain("One"));
    f.g.add_message("inbox", "Two", now - HOUR, &plain("Two"));
    f.sync(None);
    // The next two Graph requests (the INBOX pass's first) are throttled for a second each.
    f.g.clear_requests();
    f.g.add_message("inbox", "Three", now - 1000, &plain("Three"));
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
    f.g.add_message("inbox", "One", now_ms() - HOUR, &plain("One"));
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
    f.g.add_message("inbox", "Welcome", now_ms() - HOUR, &plain("Welcome"));
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

#[test]
fn opening_an_engine_drops_graph_bodies_cached_by_an_earlier_build_once() {
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let open = || Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::clone(&secrets) as _).unwrap();
    let db = || rusqlite::Connection::open(tmp.path().join("mobile.db")).unwrap();
    let body = |uid: i64, parts: &str| {
        db().execute(
            "INSERT INTO bodies (account_id, folder, uid, html, text, parts_json, bytes, last_access_ms) VALUES (?1, 'INBOX', ?2, '<p>x</p>', NULL, ?3, 10, 1)",
            (ACCOUNT, uid, parts),
        )
        .unwrap();
    };
    let att = |uid: i64, section: &str, encoding: &str| {
        db().execute(
            "INSERT INTO attachments (account_id, folder, uid, section, filename, mime, size, content_id, encoding) VALUES (?1, 'INBOX', ?2, ?3, 'f', 'application/pdf', 1, NULL, ?4)",
            (ACCOUNT, uid, section, encoding),
        )
        .unwrap();
    };
    let part = |section: &str, encoding: &str| {
        format!(r#"{{"section":"{section}","mime":"application/pdf","filename":"f","size":1,"encoding":"{encoding}","charset":null,"contentId":null,"disposition":"attachment"}}"#)
    };
    let stored = |parts: Vec<String>| format!(r#"{{"parts":[{}],"remoteImages":0,"remoteWithoutTrackers":0,"trackers":0,"trackerList":[]}}"#, parts.join(","));
    let bodies = || -> Vec<i64> {
        let c = db();
        let mut st = c.prepare("SELECT uid FROM bodies ORDER BY uid").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    {
        let e = open();
        drop(e);
    }
    let marks = || -> i64 { db().query_row("SELECT count(*) FROM settings", [], |r| r.get(0)).unwrap() };
    assert_eq!(marks(), 0, "nothing to check, nothing written");
    db().execute(
        "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms)
         VALUES (?1, ?2, ?2, 'outlook.office365.com', 993, 'ssl', 'graph', 'oauth2', 'microsoft', 0, 1)",
        [ACCOUNT, ME],
    )
    .unwrap();
    // 1: read from a MIME file (IMAP part numbers, base64); 2: a body as this build lists it;
    // 4: parts that do not read.
    body(1, &stored(vec![part("1.2", "7bit"), part("2", "base64")]));
    att(1, "2", "base64");
    body(2, &stored(vec![part("AAMkAtt1=", "binary"), part("AAMkLink=", "link")]));
    att(2, "AAMkAtt1=", "binary");
    body(4, "not json");
    assert_eq!(bodies(), vec![1, 2, 4]);
    drop(open());
    assert_eq!(bodies(), vec![2], "only the body that fits the current rules stays");
    assert_eq!(marks(), 1, "checked once");
    let left: i64 = db().query_row("SELECT count(*) FROM attachments WHERE uid = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "its attachment rows went with it");
    // Once: a later open leaves the cache alone.
    body(5, &stored(vec![part("3", "base64")]));
    drop(open());
    assert_eq!(bodies(), vec![2, 5]);
}

/// Turns notifications on and takes the first run's baseline.
fn baseline(f: &Fx) {
    // The notification pass alone, timed by its listing: no background download beside it.
    f.engine.set_setting("backgroundDownload", "false").unwrap();
    f.rpc("mobile.settings.set", json!({ "notifications": "on" }));
    let run = f.engine.background_fetch(WAIT).unwrap();
    assert!(run.mail.is_empty());
    if let Some(t) = run.commit {
        f.engine.background_commit(&t).unwrap();
    }
}

fn background(f: &Fx) -> Vec<String> {
    let run = f.engine.background_fetch(WAIT).unwrap();
    if let Some(t) = &run.commit {
        f.engine.background_commit(t).unwrap();
    }
    run.mail.into_iter().map(|m| m.subject).collect()
}

#[test]
fn a_background_run_on_a_big_graph_inbox_lists_only_what_is_new() {
    let f = setup();
    let now = now_ms();
    // 450 messages in the 90-day window: a whole relist would take five pages.
    for i in 0..450 {
        f.g.add_message("inbox", &format!("Old {i}"), now - DAY - i * HOUR / 4, &plain("old"));
    }
    f.sync(None);
    baseline(&f);
    f.g.add_message("inbox", "Fresh", now - 1000, &plain("Fresh"));
    f.g.clear_requests();
    assert_eq!(background(&f), vec!["Fresh".to_string()]);
    let listings: Vec<String> = f.g.requests().into_iter().filter(|r| r.contains("/messages?")).collect();
    assert!(listings.len() <= 2, "a quick pass asks for the newest and what came since, no more: {listings:?}");
    assert!(!f.g.requests().iter().any(|r| r.contains("$skip")), "no page of the old window: {:?}", f.g.requests());
}

#[test]
fn a_mapping_left_without_its_row_is_still_news_for_a_background_run() {
    let f = setup();
    let now = now_ms();
    f.g.add_message("inbox", "Old", now - DAY, &plain("Old"));
    f.sync(None);
    baseline(&f);
    // A pass cut off after it mapped the newest message but before its row landed.
    let id = f.g.add_message("inbox", "Mapped only", now - 1000, &plain("x"));
    f.db()
        .execute("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES (?1, 'INBOX', 777, ?2)", [ACCOUNT, id.as_str()])
        .unwrap();
    f.db().execute("UPDATE uid_seq SET next = 778 WHERE account_id = ?1", [ACCOUNT]).unwrap();
    assert_eq!(background(&f), vec!["Mapped only".to_string()]);
}

#[test]
fn a_graph_reply_goes_to_reply_to() {
    let f = setup();
    let id = f.g.add_message("inbox", "From the list", now_ms() - HOUR, &plain("list"));
    f.g.set_reply_to(&id, "list@example.org");
    f.sync(None);
    let uid = f.uids("INBOX")["From the list"];
    let reply = f.rpc("mobile.compose.prepare", json!({ "accountId": ACCOUNT, "mode": "reply", "folder": "INBOX", "uid": uid }));
    assert!(reply["to"].as_str().unwrap().contains("list@example.org"), "{reply}");
    assert!(!reply["to"].as_str().unwrap().contains("alice@example.com"), "{reply}");
}

#[test]
fn a_move_that_fails_part_way_keeps_what_moved_and_its_follow_up() {
    let f = setup();
    let projects = f.g.add_folder("Projects", None);
    let now = now_ms();
    for (i, s) in ["Alpha", "Bravo", "Charlie"].iter().enumerate() {
        f.g.add_message("inbox", s, now - (10 - i as i64) * HOUR, &plain(s));
    }
    f.sync(None);
    let uids = f.uids("INBOX");
    let all: Vec<i64> = ["Alpha", "Bravo", "Charlie"].iter().map(|s| uids[*s]).collect();
    // The first move lands, then Graph fails the next one (503): a transient failure. Its first
    // request is throttled for a second, so the read below is queued before the move runs.
    f.g.fail_moves_after(1, 4);
    f.g.throttle(1, 1);
    f.apply("move", "INBOX", &all, Some(&projects));
    // A read of the message that moved first, queued behind the move.
    f.apply("seen", "INBOX", &[uids["Alpha"]], None);
    f.wait_pending_empty();
    let moved: Vec<String> = f.g.messages_in(&projects).into_iter().map(|m| m.subject).collect();
    assert_eq!(moved.len(), 3, "the rest moved on retry: {moved:?}; logs {:?}", f.logs.lock().unwrap());
    let alpha = f.g.messages_in(&projects).into_iter().find(|m| m.subject == "Alpha").unwrap();
    assert!(alpha.is_read, "the read followed the moved message; logs {:?}", f.logs.lock().unwrap());
}

/// A Graph burst over one page (100): the quick pass pages back to the newest message it held,
/// so every new message is fetched and notified once.
#[test]
fn a_graph_burst_over_one_page_is_fetched_and_notified_in_full() {
    let f = setup();
    let now = now_ms();
    f.g.add_message("inbox", "Old", now - DAY, &plain("Old"));
    f.sync(None);
    baseline(&f);
    for i in 0..250 {
        f.g.add_message("inbox", &format!("Burst {i}"), now - 600_000 + i * 1000, &plain("b"));
    }
    let got = background(&f);
    let distinct: std::collections::HashSet<&String> = got.iter().collect();
    assert_eq!((got.len(), distinct.len()), (250, 250), "every message of the burst, once");
    let rows: i64 = f.db().query_row("SELECT count(*) FROM messages WHERE account_id = ?1 AND folder = 'INBOX'", [ACCOUNT], |r| r.get(0)).unwrap();
    assert_eq!(rows, 251);
    assert!(background(&f).is_empty());
}

/// A Graph burst that needs more pages than one run's budget can list (here two at most): each
/// run inserts and notifies the oldest pages it listed and the next run resumes after them, so
/// every message is fetched and notified exactly once over the runs.
#[test]
fn a_graph_burst_longer_than_a_run_is_notified_in_full_over_the_runs() {
    let f = setup();
    let now = now_ms();
    f.g.add_message("inbox", "Old", now - DAY, &plain("Old"));
    f.sync(None);
    baseline(&f);
    for i in 0..600 {
        f.g.add_message("inbox", &format!("Burst {i}"), now - 900_000 + i * 1000, &plain("b"));
    }
    // Each listing request takes 400 ms; a run of 1.1 s lists two pages at most.
    f.g.slow_listing(400);
    let rows = || -> i64 { f.db().query_row("SELECT count(*) FROM messages WHERE account_id = ?1 AND folder = 'INBOX'", [ACCOUNT], |r| r.get(0)).unwrap() };
    let mut seen: Vec<String> = Vec::new();
    let mut runs = 0;
    while rows() < 601 {
        runs += 1;
        assert!(runs <= 12, "the burst never landed in full: {} rows after {runs} runs", rows());
        let before = rows();
        let run = f.engine.background_fetch(Duration::from_millis(1100)).unwrap();
        if let Some(t) = &run.commit {
            f.engine.background_commit(t).unwrap();
        }
        assert!(rows() - before <= 200, "a run listed more than two pages");
        seen.extend(run.mail.into_iter().map(|m| m.subject));
    }
    f.g.slow_listing(0);
    seen.extend(background(&f));
    assert!(runs >= 3, "the budget did not cut the listing ({runs} runs)");
    let distinct: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(distinct.len(), seen.len(), "a message was notified twice");
    assert_eq!(seen.len(), 600, "every message of the burst was notified");
    assert!(background(&f).is_empty());
}
