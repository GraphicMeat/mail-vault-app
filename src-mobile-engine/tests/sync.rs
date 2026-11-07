//! The sync worker, `mobile.folders.list` and the cursor-paged `mobile.messages.page`, against the
//! mock IMAP server. Every fixture is dated relative to now: the header window is 90 days.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{MockImap, Scenario};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// A message whose INTERNALDATE is `at_ms`.
fn msg_at(uid: u32, subject: &str, at_ms: i64) -> Message {
    Message::new(
        uid,
        format!(
            "From: Sender {uid} <sender{uid}@example.com>\n\
             To: user@example.com\n\
             Subject: {subject}\n\
             Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
             Message-ID: <sync-{uid}-{at_ms}@example.com>\n\
             Content-Type: text/plain; charset=UTF-8\n\
             \n\
             Body {uid}.\n"
        ),
    )
    .with_internal_ms(at_ms)
}

fn msg(uid: u32, subject: &str, days_ago: i64) -> Message {
    msg_at(uid, subject, now_ms() - days_ago * DAY)
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

    fn all(&self) -> Vec<(String, Value)> {
        self.list.lock().unwrap().clone()
    }

    /// The first event at index `from` or later that matches; panics after `WAIT`.
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

    /// Waits for the sync pass that started after `from` to end, and asserts it ended idle.
    fn wait_idle(&self, from: usize, account: &str) {
        let end = self.wait(from, "sync end", |n, v| {
            n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error")
        });
        assert_eq!(end["state"], "idle", "sync ended in error: {end}");
    }

    fn folder_changed(&self, from: usize, account: &str, folder: &str) -> Value {
        self.wait(from, "mobile.folder.changed", |n, v| {
            n == "mobile.folder.changed" && v["accountId"] == account && v["folder"] == folder
        })
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap());
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    assert!(!engine.set_event_sink(|_, _| {}), "the first sink wins");
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": "pw-sync-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fixture { _tmp: tmp, engine, events, account }
}

impl Fixture {
    fn refresh(&self, folder: Option<&str>) -> Value {
        let mut p = json!({ "accountId": self.account });
        if let Some(f) = folder {
            p["folder"] = json!(f);
        }
        self.engine.rpc("mobile.sync.refresh", p).unwrap()
    }

    /// Refreshes and waits for that pass to end idle. Returns the event index it started from.
    fn sync(&self, folder: Option<&str>) -> usize {
        let from = self.events.len();
        assert_eq!(self.refresh(folder), json!({ "queued": true }));
        self.events.wait_idle(from, &self.account);
        from
    }

    fn page(&self, cursor: Value, limit: u64) -> Value {
        page(&self.engine, &self.account, cursor, limit)
    }

    /// Every row of INBOX as `(dateMs, uid)`, newest first, read by walking the cursor.
    fn all_rows(&self) -> Vec<(i64, i64)> {
        let mut out = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let p = self.page(cursor, 200);
            out.extend(keys(&p));
            if p["nextCursor"].is_null() {
                return out;
            }
            cursor = p["nextCursor"].clone();
        }
    }

    fn subjects(&self) -> Vec<String> {
        let p = self.page(Value::Null, 200);
        p["rows"].as_array().unwrap().iter().map(|r| r["subject"].as_str().unwrap().to_string()).collect()
    }
}

fn page(e: &Engine, account: &str, cursor: Value, limit: u64) -> Value {
    e.rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": cursor, "limit": limit }))
        .unwrap()
}

fn keys(p: &Value) -> Vec<(i64, i64)> {
    p["rows"].as_array().unwrap().iter().map(|r| (r["dateMs"].as_i64().unwrap(), r["uid"].as_i64().unwrap())).collect()
}

fn uids(p: &Value) -> Vec<i64> {
    keys(p).into_iter().map(|(_, u)| u).collect()
}

fn add_to_inbox(server: &MockImap, make: impl FnOnce(u32) -> Vec<Message>) {
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        for m in make(mb.uid_next) {
            mb.add(m);
        }
    });
}

#[test]
fn first_sync_lists_folders_and_90_days() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(inbox(vec![msg(1, "recent", 10), msg(2, "old", 120)]))
            .mailbox(Mailbox::new("Zeta"))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(Mailbox::new("Alpha"))
            .mailbox(Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]))
            .mailbox(Mailbox::new("Junk").with_attrs(&["\\HasNoChildren", "\\Junk"]))
            .mailbox(Mailbox::new("Archive").with_attrs(&["\\HasNoChildren", "\\Archive"]))
            .mailbox(Mailbox::new("Drafts").with_attrs(&["\\HasNoChildren", "\\Drafts"]))
            .mailbox(Mailbox::new("Alpha/Child")),
    );
    let f = setup(&server);
    let from = f.sync(None);

    let p = f.page(Value::Null, 50);
    assert_eq!(uids(&p), vec![1], "only the 10-day message is in the window: {p}");
    assert_eq!(p["total"], 1);
    assert_eq!(p["rows"][0]["subject"], "recent");
    assert!(p["nextCursor"].is_null());
    assert!(p["listGen"].as_i64().unwrap() > 0, "{p}");

    let folders = f.engine.rpc("mobile.folders.list", json!({ "accountId": f.account })).unwrap();
    let list = folders["folders"].as_array().unwrap();
    let paths: Vec<&str> = list.iter().map(|x| x["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["INBOX", "Drafts", "Sent", "Archive", "Junk", "Trash", "Alpha", "Alpha/Child", "Zeta"], "{folders}");
    assert_eq!(list[0]["specialUse"], "\\Inbox");
    assert_eq!(list[0]["name"], "INBOX");
    assert_eq!(list[0]["total"], 2, "total is the server's count");
    assert_eq!(list[0]["unseen"], 2);
    assert_eq!(list[0]["depth"], 0);
    let child = list.iter().find(|x| x["path"] == "Alpha/Child").unwrap();
    assert_eq!(child["depth"], 1);
    assert_eq!(child["name"], "Child");

    let all = f.events.all();
    let names: Vec<&str> = all[from..].iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"mobile.folders.changed"), "{names:?}");
    assert_eq!(names.first(), Some(&"mobile.sync.state"));
    assert_eq!(all[from].1, json!({ "accountId": f.account, "state": "syncing" }));
    let changed = f.events.folder_changed(from, &f.account, "INBOX");
    assert_eq!(changed["added"], 1);
    assert_eq!(changed["removed"], 0);
    // No event carries the password.
    assert!(!format!("{all:?}").contains("pw-sync-test"));
}

#[test]
fn refresh_returns_before_network() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a", 1)])));
    let f = setup(&server);
    // Warm up the dispatch path and the reader pool.
    f.engine.rpc("mobile.ping", json!({})).unwrap();
    f.engine.rpc("mobile.accounts.list", json!({})).unwrap();
    // Armed after accounts.add, which did its own LOGIN.
    let mut pause = server.pause_command("LOGIN");
    let from = f.events.len();
    let t0 = Instant::now();
    let reply = f.refresh(None);
    let took = t0.elapsed();
    eprintln!("refresh_returns_before_network: refresh took {took:?}");
    assert_eq!(reply, json!({ "queued": true }));
    assert!(took < Duration::from_millis(50), "refresh took {took:?}");
    // The worker really is on the network, held at LOGIN.
    assert!(pause.entered(Duration::from_secs(10)), "the worker never reached LOGIN");
    pause.release();
    f.events.wait_idle(from, &f.account);
    assert_eq!(uids(&f.page(Value::Null, 50)), vec![1]);
}

#[test]
fn new_mail_emits_folder_changed() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a", 3), msg(2, "b", 2), msg(3, "c", 1)])));
    let f = setup(&server);
    f.sync(None);
    let before = f.page(Value::Null, 50);
    let gen0 = before["listGen"].as_i64().unwrap();
    assert_eq!(uids(&before), vec![3, 2, 1]);

    add_to_inbox(&server, |uid| vec![msg_at(uid, "new", now_ms())]);
    let from = f.sync(Some("INBOX"));
    let ev = f.events.folder_changed(from, &f.account, "INBOX");
    assert_eq!(ev["added"], 1, "{ev}");
    assert_eq!(ev["removed"], 0, "{ev}");
    let gen1 = ev["listGen"].as_i64().unwrap();
    assert!(gen1 > gen0, "listGen {gen0} -> {gen1}");
    let after = f.page(Value::Null, 50);
    assert_eq!(uids(&after), vec![4, 3, 2, 1]);
    assert_eq!(after["listGen"].as_i64().unwrap(), gen1);
    assert_eq!(after["total"], 4);

    // A pass that changes nothing emits no folder change and keeps the generation.
    let from = f.sync(Some("INBOX"));
    assert!(
        !f.events.all()[from..].iter().any(|(n, _)| n == "mobile.folder.changed"),
        "{:?}",
        &f.events.all()[from..]
    );
    assert_eq!(f.page(Value::Null, 50)["listGen"].as_i64().unwrap(), gen1);
}

#[test]
fn flag_change_is_updated() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a", 2), msg(2, "b", 1)])));
    let f = setup(&server);
    f.sync(None);
    assert_eq!(f.page(Value::Null, 50)["rows"][0]["seen"], false);
    server.mutate(|s| {
        let m = s.find_mut("INBOX").unwrap().by_uid_mut(2).unwrap();
        m.flags = vec!["\\Seen".into(), "\\Flagged".into()];
    });
    let from = f.sync(Some("INBOX"));
    let ev = f.events.folder_changed(from, &f.account, "INBOX");
    assert_eq!((ev["added"].as_i64(), ev["removed"].as_i64(), ev["updated"].as_i64()), (Some(0), Some(0), Some(1)), "{ev}");
    let row = &f.page(Value::Null, 50)["rows"][0];
    assert_eq!(row["uid"], 2);
    assert_eq!(row["seen"], true);
    assert_eq!(row["flagged"], true);
}

#[test]
fn vanished_uid_is_removed() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a", 3), msg(2, "b", 2), msg(3, "c", 1)])));
    let f = setup(&server);
    f.sync(None);
    let gen0 = f.page(Value::Null, 50)["listGen"].as_i64().unwrap();
    server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[2], false));
    let from = f.sync(Some("INBOX"));
    let ev = f.events.folder_changed(from, &f.account, "INBOX");
    assert_eq!(ev["removed"], 1, "{ev}");
    assert_eq!(ev["added"], 0, "{ev}");
    assert!(ev["listGen"].as_i64().unwrap() > gen0, "a removal alone bumps listGen: {ev}");
    let p = f.page(Value::Null, 50);
    assert_eq!(uids(&p), vec![3, 1]);
    assert_eq!(p["total"], 2);
}

#[test]
fn uidvalidity_change_wipes_and_resyncs() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "old one", 3), msg(2, "old two", 2)])));
    let f = setup(&server);
    f.sync(None);
    assert_eq!(f.subjects(), vec!["old two", "old one"]);
    // Same uids, new generation, different messages: only a wipe tells them apart.
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        mb.uid_validity = 77;
        mb.messages.clear();
        mb.uid_next = 1;
        mb.add(msg(1, "new one", 6));
        mb.add(msg(2, "new two", 5));
        mb.add(msg(3, "new three", 4));
    });
    let from = f.sync(Some("INBOX"));
    let ev = f.events.folder_changed(from, &f.account, "INBOX");
    assert_eq!(ev["removed"], 2, "{ev}");
    assert_eq!(ev["added"], 3, "{ev}");
    assert_eq!(f.subjects(), vec!["new three", "new two", "new one"]);
    // The next pass sees the new generation as current: nothing changes.
    let from = f.sync(Some("INBOX"));
    assert!(!f.events.all()[from..].iter().any(|(n, _)| n == "mobile.folder.changed"));
    assert_eq!(f.subjects(), vec!["new three", "new two", "new one"]);
}

#[test]
fn page_cursor_is_stable_under_inserts() {
    let base = now_ms() - 30 * DAY;
    // 120 messages, dates in groups of three equal instants so the uid tiebreak is exercised,
    // and dates shuffled against uid.
    let msgs: Vec<Message> = (1..=120u32)
        .map(|uid| {
            let slot = ((uid as i64 * 37) % 120) / 3;
            msg_at(uid, &format!("m{uid}"), base + slot * 3_600_000)
        })
        .collect();
    let server = MockImap::start(Scenario::new().mailbox(inbox(msgs)));
    let f = setup(&server);
    f.sync(None);

    let p1 = f.page(Value::Null, 50);
    assert_eq!(p1["rows"].as_array().unwrap().len(), 50);
    assert_eq!(p1["total"], 120);
    let cursor = p1["nextCursor"].clone();
    let last = keys(&p1)[49];
    assert_eq!(cursor, json!({ "dateMs": last.0, "uid": last.1 }));

    add_to_inbox(&server, |uid| (0..5).map(|i| msg_at(uid + i, "newer", now_ms() - i as i64 * 1000)).collect());
    let from = f.sync(Some("INBOX"));
    assert_eq!(f.events.folder_changed(from, &f.account, "INBOX")["added"], 5);

    let p2 = f.page(cursor, 50);
    assert_eq!(p2["total"], 125);
    let mut seen = HashSet::new();
    let joined: Vec<(i64, i64)> = keys(&p1).into_iter().chain(keys(&p2)).collect();
    for k in &joined {
        assert!(seen.insert(*k), "duplicate row {k:?}");
    }
    // The 5 newer rows sit on top of a fresh read; below them, pages 1 and 2 with no gap.
    let fresh = f.all_rows();
    assert_eq!(fresh.len(), 125);
    assert_eq!(&fresh[5..105], &joined[..], "pages drifted against a fresh read");
    let mut sorted = fresh.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(fresh, sorted, "fresh read is not (dateMs, uid) descending");
}

#[test]
fn sync_writes_never_block_a_read() {
    let base = now_ms() - 60 * DAY;
    let mut mb = Mailbox::new("INBOX");
    for uid in 1..=5_000u32 {
        mb.add(msg_at(uid, &format!("bulk {uid}"), base + uid as i64 * 60_000));
    }
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let f = setup(&server);

    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let (engine, account, stop) = (Arc::clone(&f.engine), f.account.clone(), Arc::clone(&stop));
        std::thread::spawn(move || {
            // Warmup reads, not measured.
            for _ in 0..20 {
                page(&engine, &account, Value::Null, 50);
            }
            let mut samples: Vec<(Duration, i64)> = Vec::new();
            while !stop.load(Ordering::SeqCst) {
                let t0 = Instant::now();
                let p = page(&engine, &account, Value::Null, 50);
                samples.push((t0.elapsed(), p["total"].as_i64().unwrap()));
                std::thread::sleep(Duration::from_millis(10));
            }
            samples
        })
    };
    std::thread::sleep(Duration::from_millis(300));
    f.sync(None);
    stop.store(true, Ordering::SeqCst);
    let samples = reader.join().unwrap();

    let mut lat: Vec<Duration> = samples.iter().map(|s| s.0).collect();
    lat.sort();
    let max = *lat.last().unwrap();
    let p99 = lat[(lat.len() * 99 / 100).min(lat.len() - 1)];
    let totals: HashSet<i64> = samples.iter().map(|s| s.1).collect();
    eprintln!(
        "sync_writes_never_block_a_read: {} reads, {} distinct totals, p50 {:?}, p99 {p99:?}, max {max:?}",
        lat.len(),
        totals.len(),
        lat[lat.len() / 2]
    );
    // The reads overlapped the batch commits, or this proves nothing.
    assert!(totals.len() >= 4, "reads saw only totals {totals:?}");
    assert!(max < Duration::from_millis(100), "max read latency {max:?} (p99 {p99:?})");
    assert_eq!(f.page(Value::Null, 50)["total"], 5_000);
}

#[test]
fn refresh_of_unknown_account_is_invalid() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
    let err = e.rpc("mobile.sync.refresh", json!({ "accountId": "acc_missing" })).unwrap_err();
    assert_eq!(serde_json::to_value(&err).unwrap()["code"], "INVALID");
}

#[test]
fn wrong_password_ends_in_error_state() {
    let server = MockImap::start(Scenario::new().mailbox(inbox(vec![msg(1, "a", 1)])));
    let f = setup(&server);
    server.reset_scenario(
        Scenario::new()
            .mailbox(inbox(vec![msg(1, "a", 1)]))
            .fault(mock_imap::Trigger::on("LOGIN"), mock_imap::Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())),
    );
    let from = f.events.len();
    f.refresh(None);
    let end = f.events.wait(from, "sync end", |n, v| n == "mobile.sync.state" && (v["state"] == "idle" || v["state"] == "error"));
    assert_eq!(end, json!({ "accountId": f.account, "state": "error", "code": "AUTH_FAILED" }));
}

#[test]
fn dropped_engine_stops_the_pass_at_the_next_batch() {
    let base = now_ms() - 20 * DAY;
    let mut mb = Mailbox::new("INBOX");
    for uid in 1..=1_000u32 {
        mb.add(msg_at(uid, &format!("m{uid}"), base + uid as i64 * 60_000));
    }
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let Fixture { _tmp: tmp, engine, events, account } = setup(&server);
    // A first pass holds no rows, so it reads no flags: FETCH 1 is the first header batch, 2 the
    // second.
    let mut pause = server.pause_command_nth("FETCH", 2);
    let from = events.len();
    engine.rpc("mobile.sync.refresh", json!({ "accountId": account })).unwrap();
    assert!(pause.entered(WAIT), "the second header batch was never fetched");
    drop(engine);
    pause.release();
    events.wait(from, "sync end", |n, v| n == "mobile.sync.state" && v["state"] != "syncing");

    let db = rusqlite::Connection::open(tmp.path().join("mobile.db")).unwrap();
    let rows = || -> i64 { db.query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap() };
    assert_eq!(rows(), 200, "only the batch committed before the drop is written");
    assert_eq!(server.count_commands("FETCH"), 2, "no batch is fetched after the drop: {:?}", server.commands());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(rows(), 200);
    // A reopened engine writes at once: nothing holds a write transaction.
    let t0 = Instant::now();
    let again = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
    assert_eq!(again.rpc("mobile.accounts.remove", json!({ "accountId": account })).unwrap()["removed"], true);
    assert!(t0.elapsed() < Duration::from_secs(1), "reopen and write took {:?}", t0.elapsed());
}

fn inbox_and_work() -> Scenario {
    let mut work = Mailbox::new("Work");
    work.add(msg(1, "work mail", 2));
    Scenario::new().mailbox(inbox(vec![msg(1, "a", 2), msg(2, "b", 1)])).mailbox(work)
}

#[test]
fn list_without_inbox_removes_no_folder() {
    let server = MockImap::start(inbox_and_work());
    let f = setup(&server);
    f.sync(None);
    f.sync(Some("Work"));
    let work_total = |f: &Fixture| {
        f.engine
            .rpc("mobile.messages.page", json!({ "accountId": f.account, "folder": "Work", "cursor": null, "limit": 50 }))
            .unwrap()["total"]
            .clone()
    };
    assert_eq!(work_total(&f), 1);

    // A short LIST reply that lost INBOX (core already refuses a wholly empty one): INBOX is
    // still on the server and must keep its folder row and its messages.
    server.reset_scenario(inbox_and_work().fault(
        mock_imap::Trigger::on("LIST"),
        mock_imap::Action::RespondRaw("* LIST (\\HasNoChildren) \"/\" \"Work\"\r\n{tag} OK LIST completed\r\n".into()),
    ));
    f.sync(None);
    assert!(server.count_commands("LIST") >= 1);

    let folders = f.engine.rpc("mobile.folders.list", json!({ "accountId": f.account })).unwrap();
    let paths: Vec<&str> = folders["folders"].as_array().unwrap().iter().map(|x| x["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["INBOX", "Work"], "{folders}");
    assert_eq!(f.page(Value::Null, 50)["total"], 2);
    assert_eq!(work_total(&f), 1);
}
