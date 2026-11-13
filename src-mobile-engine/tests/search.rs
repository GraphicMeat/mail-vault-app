//! `mobile.search.local` and the index behind it (core's search index in `search.db`): matching as
//! desktop matches, the index following sync, actions, bodies and account removal, the backfill,
//! a rebuild, and the v5 -> v6 step; then `mobile.search.server` on IMAP, Graph and JMAP accounts
//! and the retention of the rows it stores. Mail comes from the mock IMAP server, or is written straight
//! into `mobile.db` for the backfill cases.

#[path = "support/graph.rs"]
mod graph_mock;

use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, RpcError, SecretStore};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{MockImap, Scenario};
use mock_jmap::{MockJmap, Scenario as JmapScenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// A plain-text message `days_ago` old with `subject` (an RFC 2047 word is fine) and `body`.
fn mail(uid: u32, subject: &str, body: &str, days_ago: i64) -> Message {
    let at = now_ms() - days_ago * DAY;
    Message::new(
        uid,
        format!(
            "From: Sender {uid} <sender{uid}@example.com>\n\
             To: user@example.com\n\
             Subject: {subject}\n\
             Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
             Message-ID: <search-{uid}-{at}@example.com>\n\
             Content-Type: text/plain; charset=UTF-8\n\
             \n\
             {body}\n"
        ),
    )
    .with_internal_ms(at)
}

fn mailbox(name: &str, msgs: Vec<Message>) -> Mailbox {
    let mut mb = Mailbox::new(name);
    for m in msgs {
        mb.add(m);
    }
    mb
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
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": "pw-search-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fixture { _tmp: tmp, engine, events, account }
}

impl Fixture {
    /// Refreshes `folder` (or the folder list and INBOX) and waits for the pass to end idle and
    /// the index to catch up.
    fn sync(&self, folder: Option<&str>) {
        let from = self.events.len();
        let mut p = json!({ "accountId": self.account });
        if let Some(f) = folder {
            p["folder"] = json!(f);
        }
        assert_eq!(self.engine.rpc("mobile.sync.refresh", p).unwrap(), json!({ "queued": true }));
        let end = self.events.wait(from, "sync end", |n, v| {
            n == "mobile.sync.state" && v["accountId"] == self.account && (v["state"] == "idle" || v["state"] == "error")
        });
        assert_eq!(end["state"], "idle", "sync ended in error: {end}");
        idle(&self.engine);
    }

    /// Applies an action and waits for its final result.
    fn act(&self, kind: &str, uids: &[u32], target: Option<&str>) -> Value {
        let mut p = json!({ "accountId": self.account, "folder": "INBOX", "uids": uids, "kind": kind });
        if let Some(t) = target {
            p["target"] = json!(t);
        }
        let seq = self.engine.rpc("mobile.actions.apply", p).unwrap()["queued"].as_i64().expect("queued");
        let r = self.events.wait(0, "final action result", |n, v| n == "mobile.action.result" && v["seq"] == seq && v["outcome"] != "retrying");
        idle(&self.engine);
        r
    }

    fn body(&self, uid: u32) -> Value {
        let b = self.engine.rpc("mobile.message.body", json!({ "accountId": self.account, "folder": "INBOX", "uid": uid })).unwrap();
        idle(&self.engine);
        b
    }

    fn search(&self, query: &str) -> Vec<u32> {
        uids(&search(&self.engine, json!({ "accountId": self.account, "query": query })))
    }
}

/// Waits for the backfill to finish and every queued index job to run.
fn idle(e: &Engine) {
    let deadline = Instant::now() + WAIT;
    while !e.search_idle() {
        assert!(Instant::now() < deadline, "the index never went idle: {:?}", e.search_backfill());
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn search(e: &Engine, params: Value) -> Value {
    e.rpc("mobile.search.local", params).unwrap()
}

fn uids(page: &Value) -> Vec<u32> {
    page["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap() as u32).collect()
}

fn indexed(e: &Engine, account: &str, folder: &str) -> Vec<u32> {
    e.search_index_rows(account, folder).into_iter().map(|(u, _)| u).collect()
}

fn open(dir: &Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

/// A data dir whose mobile.db holds `accounts` (id, rows per folder) written straight into the
/// file with no engine running and no search.db, as a build before search left it. Row `n` of
/// folder `f` is subject `"<word> <f> <n>"`, dated so that rows of all accounts interleave.
fn seeded_dir(word: &str, accounts: &[(&str, &[(&str, u32)])]) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    drop(open(tmp.path()));
    remove_search_db(tmp.path());
    let mut c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    let tx = c.transaction().unwrap();
    let base = now_ms() - 10 * DAY;
    for (ai, (account, folders)) in accounts.iter().enumerate() {
        tx.execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
             VALUES (?1, ?1 || '@example.test', 'U', 'imap.example.test', 993, 'ssl', 1)",
            [account],
        )
        .unwrap();
        for (folder, n) in folders.iter() {
            tx.execute("INSERT INTO folders (account_id, path, name) VALUES (?1, ?2, ?2)", (account, folder)).unwrap();
            for uid in 1..=*n as i64 {
                tx.execute(
                    "INSERT INTO messages
                     (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id)
                     VALUES (?1, ?2, ?3, ?4, 'Ada', 'ada@example.test', ?5, '', 0, 0, 0, ?6)",
                    (
                        account,
                        folder,
                        uid,
                        format!("{word} {folder} {uid}"),
                        base + uid * 60_000 + ai as i64 * 30_000,
                        format!("<{account}-{folder}-{uid}@example.test>"),
                    ),
                )
                .unwrap();
            }
        }
    }
    tx.commit().unwrap();
    tmp
}

fn remove_search_db(dir: &Path) {
    for s in ["search.db", "search.db-wal", "search.db-shm", "search.db-journal"] {
        let _ = std::fs::remove_file(dir.join(s));
    }
}

#[test]
fn local_search_matches_like_desktop() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox(
        "INBOX",
        vec![
            mail(1, "=?UTF-8?B?Q2Fmw6kgY3LDqG1lIGJyw7tsw6ll?=", "Dessert.", 5),
            mail(2, "=?UTF-8?B?5p2x5Lqs44K/44Ov44O844Gu5aSc5pmv?=", "Night.", 4),
            mail(3, "Quarterly report draft", "The numbers look fine.", 3),
            mail(4, "Our newsletter for November", "News.", 2),
            mail(5, "Unrelated", "A zebra crossing near the office.", 1),
        ],
    )));
    let f = setup(&server);
    f.sync(None);
    // Accents fold both ways, as on desktop.
    assert_eq!(f.search("cafe"), vec![1]);
    assert_eq!(f.search("CRÈME"), vec![1]);
    assert_eq!(f.search("brulee"), vec![1]);
    // A short CJK word.
    assert_eq!(f.search("東京"), vec![2]);
    // A quoted phrase keeps its order.
    assert_eq!(f.search("\"quarterly report\""), vec![3]);
    assert!(f.search("\"report quarterly\"").is_empty());
    // Inside a word.
    assert_eq!(f.search("slett"), vec![4]);
    // A body's words are searchable once the body has been read.
    assert!(f.search("zebra").is_empty());
    f.body(5);
    assert_eq!(f.search("zebra"), vec![5]);
    // The row is the list's row, with where it lives.
    let page = search(&f.engine, json!({ "accountId": f.account, "folder": "INBOX", "query": "zebra" }));
    let row = &page["rows"][0];
    assert_eq!((row["accountId"].as_str(), row["folder"].as_str(), row["subject"].as_str()), (Some(f.account.as_str()), Some("INBOX"), Some("Unrelated")));
    for k in ["uid", "fromName", "fromAddress", "dateMs", "snippet", "seen", "flagged", "hasAttachments", "to"] {
        assert!(row.get(k).is_some(), "missing {k}: {row}");
    }
    assert!(page["cursor"].is_null());
    // Newest first.
    assert_eq!(f.search("example.com"), vec![5, 4, 3, 2, 1]);
    // A blank query lists nothing.
    assert_eq!(search(&f.engine, json!({ "query": "  " })), json!({ "rows": [], "cursor": null }));
}

#[test]
fn deleted_and_moved_rows_leave_the_index() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(mailbox("INBOX", vec![mail(1, "alpha one", "x", 3), mail(2, "alpha two", "x", 2), mail(3, "alpha three", "x", 1)]))
            .mailbox(Mailbox::new("Archive").with_attrs(&["\\HasNoChildren", "\\Archive"])),
    );
    let f = setup(&server);
    f.sync(None);
    f.sync(Some("Archive"));
    assert_eq!(indexed(&f.engine, &f.account, "INBOX"), vec![1, 2, 3]);
    // Expunged on the server: gone from the rows and from the index.
    server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[2], false));
    f.sync(Some("INBOX"));
    assert_eq!(indexed(&f.engine, &f.account, "INBOX"), vec![1, 3]);
    assert_eq!(f.search("alpha"), vec![3, 1]);
    // Moved: it leaves INBOX's index once the move settles, and Archive's sync indexes it there.
    assert_eq!(f.act("move", &[1], Some("Archive"))["outcome"], "done");
    assert_eq!(indexed(&f.engine, &f.account, "INBOX"), vec![3]);
    f.sync(Some("Archive"));
    assert_eq!(indexed(&f.engine, &f.account, "Archive").len(), 1);
    let page = search(&f.engine, json!({ "accountId": f.account, "query": "alpha one" }));
    let rows = page["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["folder"], "Archive");
    let inbox_only = search(&f.engine, json!({ "accountId": f.account, "folder": "INBOX", "query": "alpha" }));
    assert_eq!(uids(&inbox_only), vec![3]);
}

#[test]
fn a_hit_whose_row_is_gone_or_locally_deleted_is_not_shown() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox(
        "INBOX",
        vec![mail(1, "beta one", "x", 3), mail(2, "beta two", "x", 2), mail(3, "beta three", "x", 1)],
    )));
    let f = setup(&server);
    f.sync(None);
    assert_eq!(f.search("beta"), vec![3, 2, 1]);
    // A delete still pending (the row is hidden) and a row removed before the index caught up:
    // the index still holds both, and neither is shown.
    {
        let c = Connection::open(f._tmp.path().join("mobile.db")).unwrap();
        c.busy_timeout(Duration::from_secs(5)).unwrap();
        c.execute("UPDATE messages SET local_deleted = 1 WHERE uid = 1", []).unwrap();
        c.execute("DELETE FROM messages WHERE uid = 2", []).unwrap();
    }
    assert_eq!(indexed(&f.engine, &f.account, "INBOX"), vec![1, 2, 3]);
    assert_eq!(f.search("beta"), vec![3]);
    let all = search(&f.engine, json!({ "query": "beta" }));
    assert_eq!(uids(&all), vec![3]);
}

#[test]
fn flag_change_keeps_body_terms() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox("INBOX", vec![mail(1, "gamma", "A pelican on the pier.", 1)])));
    let f = setup(&server);
    f.sync(None);
    f.body(1);
    assert_eq!(f.search("pelican"), vec![1]);
    let flags = |f: &Fixture| f.engine.search_index_rows(&f.account, "INBOX")[0].1.clone();
    assert!(!flags(&f).contains('F'));
    // Starred here: the index takes the flag and keeps the body's words.
    assert_eq!(f.act("flag", &[1], None)["outcome"], "done");
    assert!(flags(&f).contains('F'), "{}", flags(&f));
    assert_eq!(f.search("pelican"), vec![1]);
    // Read on the server: the next sync's flags reach the index the same way.
    server.mutate(|s| s.find_mut("INBOX").unwrap().by_uid_mut(1).unwrap().flags.push("\\Seen".into()));
    f.sync(Some("INBOX"));
    assert!(flags(&f).contains('S'), "{}", flags(&f));
    assert!(flags(&f).contains('F'), "{}", flags(&f));
    assert_eq!(f.search("pelican"), vec![1]);
}

#[test]
fn uidvalidity_reset_forgets_the_folder() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox("INBOX", vec![mail(1, "delta old one", "x", 3), mail(2, "delta old two", "x", 2)])));
    let f = setup(&server);
    f.sync(None);
    assert_eq!(f.search("delta"), vec![2, 1]);
    // Same uids, new generation, different messages.
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        mb.uid_validity = 77;
        mb.messages.clear();
        mb.uid_next = 1;
        mb.add(mail(1, "epsilon new one", "x", 6));
        mb.add(mail(2, "epsilon new two", "x", 5));
        mb.add(mail(3, "epsilon new three", "x", 4));
    });
    f.sync(Some("INBOX"));
    assert!(f.search("delta").is_empty());
    assert_eq!(f.search("epsilon"), vec![3, 2, 1]);
    assert_eq!(indexed(&f.engine, &f.account, "INBOX"), vec![1, 2, 3]);
}

#[test]
fn removed_account_is_not_searchable() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox("INBOX", vec![mail(1, "zeta", "x", 1)])).mailbox(Mailbox::new("Work")));
    let f = setup(&server);
    f.sync(None);
    assert_eq!(f.search("zeta"), vec![1]);
    assert_eq!(f.engine.rpc("mobile.accounts.remove", json!({ "accountId": f.account })).unwrap()["removed"], true);
    assert!(indexed(&f.engine, &f.account, "INBOX").is_empty());
    assert!(uids(&search(&f.engine, json!({ "query": "zeta" }))).is_empty());
    assert!(uids(&search(&f.engine, json!({ "accountId": f.account, "query": "zeta" }))).is_empty());
}

#[test]
fn search_pages_newest_first_across_accounts() {
    let tmp = seeded_dir("omega", &[("acc_a", &[("INBOX", 60)]), ("acc_b", &[("INBOX", 40), ("Work", 20)])]);
    let e = open(tmp.path());
    idle(&e);
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    let mut sizes = Vec::new();
    loop {
        let page = search(&e, json!({ "query": "omega", "cursor": cursor }));
        let got = page["rows"].as_array().unwrap().clone();
        sizes.push(got.len());
        rows.extend(got);
        cursor = page["cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(sizes, vec![50, 50, 20]);
    let dates: Vec<i64> = rows.iter().map(|r| r["dateMs"].as_i64().unwrap()).collect();
    assert!(dates.windows(2).all(|w| w[0] >= w[1]), "not newest first: {dates:?}");
    let keys: std::collections::HashSet<(String, String, u64)> = rows
        .iter()
        .map(|r| (r["accountId"].as_str().unwrap().to_string(), r["folder"].as_str().unwrap().to_string(), r["uid"].as_u64().unwrap()))
        .collect();
    assert_eq!(keys.len(), 120, "every row once");
    // One account, one folder.
    let b = search(&e, json!({ "accountId": "acc_b", "query": "omega", "cursor": null }));
    assert_eq!(b["rows"].as_array().unwrap().len(), 50);
    assert!(b["rows"].as_array().unwrap().iter().all(|r| r["accountId"] == "acc_b"));
    let work = search(&e, json!({ "accountId": "acc_b", "folder": "Work", "query": "omega" }));
    assert_eq!(work["rows"].as_array().unwrap().len(), 20);
    assert!(work["cursor"].is_null());
}

#[test]
fn existing_rows_are_backfilled_in_chunks_off_the_open_path() {
    let tmp = seeded_dir("kappa", &[("acc_a", &[("INBOX", 450), ("Work", 30)])]);
    {
        // A cached body is backfilled with its words.
        let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
        c.execute("INSERT INTO bodies (account_id, folder, uid, text, bytes) VALUES ('acc_a', 'INBOX', 7, 'a walrus on ice', 15)", []).unwrap();
    }
    let e = open(tmp.path());
    idle(&e);
    let stats = e.search_backfill();
    assert!(stats.thread.is_some() && stats.thread != Some(std::thread::current().id()), "{stats:?}");
    assert_eq!(stats.rows, 480, "{stats:?}");
    assert!(stats.chunks >= 4, "{stats:?}");
    assert!(stats.max_rows <= 200, "{stats:?}");
    assert_eq!(indexed(&e, "acc_a", "INBOX").len(), 450);
    assert_eq!(uids(&search(&e, json!({ "accountId": "acc_a", "query": "\"kappa INBOX 450\"" }))), vec![450]);
    assert_eq!(uids(&search(&e, json!({ "accountId": "acc_a", "query": "walrus" }))), vec![7]);
    drop(e);
    // The marks are kept: a reopen indexes nothing again.
    let e = open(tmp.path());
    idle(&e);
    assert_eq!(e.search_backfill().rows, 0, "{:?}", e.search_backfill());
    assert_eq!(indexed(&e, "acc_a", "Work").len(), 30);
}

#[test]
fn a_rebuildable_search_db_is_rebuilt() {
    let tmp = seeded_dir("lambda", &[("acc_a", &[("INBOX", 5)])]);
    std::fs::write(tmp.path().join("search.db"), b"this is not a sqlite database, just garbage bytes").unwrap();
    let e = open(tmp.path());
    assert!(e.search_available());
    idle(&e);
    assert_eq!(uids(&search(&e, json!({ "query": "lambda" }))), vec![5, 4, 3, 2, 1]);
}

#[test]
fn a_search_db_that_cannot_open_answers_search_unavailable() {
    let tmp = seeded_dir("mulberry", &[("acc_a", &[("INBOX", 2)])]);
    // A directory where the file should be: not corrupt, just unopenable.
    std::fs::create_dir(tmp.path().join("search.db")).unwrap();
    let e = open(tmp.path());
    assert!(!e.search_available());
    let err = e.rpc("mobile.search.local", json!({ "query": "mulberry" })).unwrap_err();
    assert_eq!(err, RpcError::SearchUnavailable);
    assert_eq!(serde_json::to_value(&err).unwrap()["code"], "SEARCH_UNAVAILABLE");
    // The rest of the engine works.
    let p = e.rpc("mobile.messages.page", json!({ "accountId": "acc_a", "folder": "INBOX", "cursor": null, "limit": 10 })).unwrap();
    assert_eq!(p["total"], 2);
}

#[test]
fn a_v5_file_migrates_to_v6_and_keeps_its_rows() {
    let tmp = seeded_dir("nuthatch", &[("acc_a", &[("INBOX", 3)])]);
    let path = tmp.path().join("mobile.db");
    {
        let c = Connection::open(&path).unwrap();
        // Back to what a v5 build wrote.
        c.execute_batch(
            "ALTER TABLE accounts DROP COLUMN color;
             ALTER TABLE accounts DROP COLUMN sort_order;
             ALTER TABLE messages DROP COLUMN out_of_window_ms;
             ALTER TABLE outbox DROP COLUMN scheduled_ms;
             DROP TABLE follow_ups;
             INSERT INTO outbox (id, account_id, message_id, draft_json, state, attempts, created_ms, updated_ms, not_before_ms)
               VALUES ('o1', 'acc_a', '<m@x>', '{}', 'failed', 0, 1, 1, 99);
             PRAGMA user_version = 5;",
        )
        .unwrap();
    }
    let e = open(tmp.path());
    let c = Connection::open(&path).unwrap();
    let ver: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(ver, 7);
    let kept: (i64, Option<i64>) = c
        .query_row("SELECT count(*), max(out_of_window_ms) FROM messages WHERE account_id = 'acc_a'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(kept, (3, None));
    let outbox: (String, i64, Option<i64>) =
        c.query_row("SELECT state, not_before_ms, scheduled_ms FROM outbox WHERE id = 'o1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(outbox, ("failed".to_string(), 99, None));
    let follow_ups: i64 = c.query_row("SELECT count(*) FROM follow_ups", [], |r| r.get(0)).unwrap();
    assert_eq!(follow_ups, 0);
    // A migrated file and a new one have the same columns.
    let fresh = tempfile::tempdir().unwrap();
    drop(open(fresh.path()));
    let f = Connection::open(fresh.path().join("mobile.db")).unwrap();
    for t in ["messages", "outbox", "follow_ups"] {
        let cols = |c: &Connection| -> Vec<(String, String)> {
            let mut st = c.prepare(&format!("PRAGMA table_info({t})")).unwrap();
            let mut v: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(1)?, r.get(2)?))).unwrap().map(Result::unwrap).collect();
            v.sort();
            v
        };
        assert_eq!(cols(&c), cols(&f), "{t}");
    }
    // The rows a v5 build synced are searchable once backfilled.
    idle(&e);
    assert_eq!(uids(&search(&e, json!({ "query": "nuthatch" }))), vec![3, 2, 1]);
}

// ── Server search ───────────────────────────────────────────────────────────

const MONTH: i64 = 30 * DAY;

/// `mobile.search.server` rows of `folder`.
fn server_rows(e: &Engine, account: &str, folder: &str, query: &str) -> Vec<Value> {
    let r = e.rpc("mobile.search.server", json!({ "accountId": account, "folder": folder, "query": query })).unwrap();
    r["rows"].as_array().unwrap().clone()
}

/// An engine over a fresh data dir with an event log, and no account.
fn bare() -> (tempfile::TempDir, Arc<Engine>, Arc<Events>, Arc<MemorySecrets>) {
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let engine = Arc::new(Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::clone(&secrets) as _).unwrap());
    engine.set_action_backoff(Duration::from_millis(50), Duration::from_millis(200));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    (tmp, engine, events, secrets)
}

/// One sync pass of the account (folder list and INBOX), waited out with the index caught up.
fn sync_account(e: &Engine, events: &Events, account: &str) {
    let from = events.len();
    assert_eq!(e.rpc("mobile.sync.refresh", json!({ "accountId": account })).unwrap(), json!({ "queued": true }));
    let end = events.wait(from, "sync end", |n, v| n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error"));
    assert_eq!(end["state"], "idle", "sync ended in error: {end}");
    idle(e);
}

fn mobile_db(dir: &Path) -> Connection {
    let c = Connection::open(dir.join("mobile.db")).unwrap();
    c.busy_timeout(Duration::from_secs(5)).unwrap();
    c
}

/// `out_of_window_ms` of the row, `None` when the row is missing or has no mark.
fn mark_of(dir: &Path, account: &str, uid: i64) -> Option<i64> {
    mobile_db(dir)
        .query_row("SELECT out_of_window_ms FROM messages WHERE account_id = ?1 AND folder = 'INBOX' AND uid = ?2", (account, uid), |r| r.get(0))
        .unwrap_or(None)
}

fn has_row(dir: &Path, account: &str, uid: i64) -> bool {
    mobile_db(dir)
        .query_row("SELECT count(*) FROM messages WHERE account_id = ?1 AND folder = 'INBOX' AND uid = ?2", (account, uid), |r| r.get::<_, i64>(0))
        .unwrap()
        == 1
}

fn listed_subjects(e: &Engine, account: &str) -> Vec<String> {
    let page = e.rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": null, "limit": 200 })).unwrap();
    page["rows"].as_array().unwrap().iter().map(|r| r["subject"].as_str().unwrap().to_string()).collect()
}

/// An action on `uid` of INBOX, waited out; its result.
fn act_seen(e: &Engine, events: &Events, account: &str, uid: i64) -> Value {
    let p = json!({ "accountId": account, "folder": "INBOX", "uids": [uid], "kind": "seen" });
    let seq = e.rpc("mobile.actions.apply", p).unwrap()["queued"].as_i64().expect("queued");
    let r = events.wait(0, "final action result", |n, v| n == "mobile.action.result" && v["seq"] == seq && v["outcome"] != "retrying");
    idle(e);
    r
}

/// What every backend must do with an account whose INBOX holds a recent message "Weekly status"
/// and one 200 days old, subject holding "invoice" and body holding `word`: sync lists only the
/// recent one, the server search brings the old one back as a list row and stores it, and then
/// the viewer, an action and the local search all work on it.
fn old_message_comes_back_through_the_server(dir: &Path, e: &Engine, events: &Events, account: &str, word: &str) -> i64 {
    sync_account(e, events, account);
    assert_eq!(listed_subjects(e, account), vec!["Weekly status".to_string()]);

    let rows = server_rows(e, account, "INBOX", "invoice");
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert!(row["subject"].as_str().unwrap().contains("invoice"), "{row}");
    assert_eq!((row["accountId"].as_str(), row["folder"].as_str()), (Some(account), Some("INBOX")));
    for k in ["uid", "fromName", "fromAddress", "dateMs", "snippet", "seen", "flagged", "hasAttachments", "to"] {
        assert!(row.get(k).is_some(), "missing {k}: {row}");
    }
    assert!(row["dateMs"].as_i64().unwrap() < now_ms() - 150 * DAY, "{row}");
    let uid = row["uid"].as_i64().unwrap();

    // Stored with its mark, and still not part of the folder's list.
    let mark = mark_of(dir, account, uid).expect("the row is stored with out_of_window_ms");
    assert!((now_ms() - mark).abs() < 60_000, "{mark}");
    assert_eq!(listed_subjects(e, account), vec!["Weekly status".to_string()]);

    // The viewer.
    let body = e.rpc("mobile.message.body", json!({ "accountId": account, "folder": "INBOX", "uid": uid })).unwrap();
    assert!(body.to_string().contains(word), "{body}");
    // An action.
    assert_eq!(act_seen(e, events, account, uid)["outcome"], "done");
    // The local search finds it by its subject and, the body being read, by the body.
    idle(e);
    let local = |q: &str| uids(&e.rpc("mobile.search.local", json!({ "accountId": account, "query": q })).unwrap());
    assert_eq!(local("invoice"), vec![uid as u32]);
    assert_eq!(local(word), vec![uid as u32]);
    // A later pass does not take it away.
    sync_account(e, events, account);
    assert!(has_row(dir, account, uid));
    assert_eq!(local("invoice"), vec![uid as u32]);
    uid
}

#[test]
fn server_search_imap_graph_jmap_returns_rows_the_viewer_can_open() {
    // IMAP: `UID SEARCH CHARSET UTF-8 TEXT`.
    {
        let server = MockImap::start(Scenario::new().mailbox(mailbox(
            "INBOX",
            vec![
                mail(1, "Overdue invoice 4411", "The ledgerword is attached below.", 200),
                mail(2, "Weekly status", "All quiet.", 1),
            ],
        )));
        let f = setup(&server);
        let uid = old_message_comes_back_through_the_server(f._tmp.path(), &f.engine, &f.events, &f.account, "ledgerword");
        assert_eq!(uid, 1);
        // A query the server cannot match brings nothing, and stores nothing.
        assert!(server_rows(&f.engine, &f.account, "INBOX", "zzzznotthere").is_empty());
        // The folder is checked first.
        let err = f.engine.rpc("mobile.search.server", json!({ "accountId": f.account, "folder": "Nope", "query": "invoice" })).unwrap_err();
        assert_eq!(err.code(), "INVALID");
        // A non-ASCII query goes out as UTF-8.
        assert!(server_rows(&f.engine, &f.account, "INBOX", "東京").is_empty());
    }

    // Graph: `$search`.
    {
        let g = graph_mock::mock();
        let _serial = graph_mock::serial();
        g.reset("owner@outlook.com");
        g.add_message("inbox", "Overdue invoice 4411", now_ms() - 200 * DAY, "<p>The ledgerword is attached below.</p>");
        g.add_message("inbox", "Weekly status", now_ms() - DAY, "<p>All quiet.</p>");
        let (tmp, engine, events, secrets) = bare();
        engine.set_oauth_token_endpoint(&g.token_endpoint());
        let account = "acc_00000000000000gr";
        mobile_db(tmp.path())
            .execute(
                "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms)
                 VALUES (?1, 'owner@outlook.com', 'owner@outlook.com', 'outlook.office365.com', 993, 'ssl', 'graph', 'oauth2', 'microsoft', 0, 1)",
                [account],
            )
            .unwrap();
        let (refresh, access, expires) = g.grant();
        secrets.set(account, &Credential::from_tokens(&refresh, &access, expires).to_secret()).unwrap();
        old_message_comes_back_through_the_server(tmp.path(), &engine, &events, account, "ledgerword");
        assert!(g.count("$search") >= 1, "{:?}", g.requests());
    }

    // JMAP: `Email/query` with the `text` filter.
    {
        let jmap_email = |id: &str, subject: &str, body: &str, received_secs: i64| ScenarioEmail {
            id: id.into(),
            raw: format!("From: Alice <alice@example.test>\r\nTo: me@example.test\r\nSubject: {subject}\r\nMessage-ID: <{id}@example.test>\r\nDate: Mon, 05 Jan 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"),
            keywords: vec![],
            received_at: mock_jmap::state::iso8601(received_secs),
            also_in: vec![],
        };
        let mailbox = |id: &str, name: &str, role: &str, emails: Vec<ScenarioEmail>| ScenarioMailbox {
            id: id.into(),
            name: name.into(),
            parent_id: None,
            role: Some(role.into()),
            emails,
        };
        let now = now_ms() / 1000;
        let m = MockJmap::start(JmapScenario {
            accounts: vec![ScenarioAccount {
                username: "me@example.test".into(),
                password: "app-pass-7c1f".into(),
                token: None,
                mailboxes: vec![
                    mailbox(
                        "mb-inbox",
                        "Inbox",
                        "inbox",
                        vec![
                            jmap_email("e-old", "Overdue invoice 4411", "The ledgerword is attached below.", now - 200 * 86_400),
                            jmap_email("e-new", "Weekly status", "All quiet.", now - 86_400),
                        ],
                    ),
                    mailbox("mb-sent", "Sent", "sent", vec![]),
                    mailbox("mb-trash", "Trash", "trash", vec![]),
                ],
                identities: vec![("me@example.test".into(), "Me".into())],
            }],
            ..JmapScenario::default()
        });
        let (tmp, engine, events, _secrets) = bare();
        engine.allow_jmap_loopback();
        let added = engine
            .rpc("mobile.accounts.add", json!({ "kind": "jmap", "email": "me@example.test", "password": "app-pass-7c1f", "jmapUrl": m.session_url() }))
            .unwrap();
        assert_eq!(added["ok"], true, "{added}");
        let account = added["account"]["id"].as_str().unwrap().to_string();
        old_message_comes_back_through_the_server(tmp.path(), &engine, &events, &account, "ledgerword");
    }
}

#[test]
fn a_server_hit_newer_than_the_list_waits_for_the_next_full_pass() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox("INBOX", vec![mail(1, "Weekly status", "All quiet.", 2)])));
    let f = setup(&server);
    let dir = f._tmp.path();
    f.sync(None);
    // Two new messages arrive; the user searches the server before the next sync.
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        mb.add(mail(2, "Lunch plans", "x", 0));
        mb.add(mail(3, "Fresh invoice 77", "x", 0));
    });
    let from = f.events.len();
    let rows = server_rows(&f.engine, &f.account, "INBOX", "invoice");
    assert_eq!(uids(&json!({ "rows": rows })), vec![3]);
    // Stored with a mark, so the list (and the quick pass's and the notifications' marks, which read
    // the listed rows) still stop at uid 1: the next quick pass asks from there and gets uid 2.
    assert!(mark_of(dir, &f.account, 3).is_some());
    assert_eq!(listed_subjects(&f.engine, &f.account), vec!["Weekly status".to_string()]);
    let top: i64 = mobile_db(dir)
        .query_row("SELECT MAX(uid) FROM messages WHERE account_id = ?1 AND folder = 'INBOX' AND out_of_window_ms IS NULL", [&f.account], |r| r.get(0))
        .unwrap();
    assert_eq!(top, 1);
    assert!(
        !f.events.list.lock().unwrap()[from..].iter().any(|(n, _)| n == "mobile.folder.changed"),
        "the list did not change"
    );
    // The next full pass takes both into the list; the found one loses its mark.
    f.sync(Some("INBOX"));
    assert_eq!(mark_of(dir, &f.account, 3), None);
    let mut listed = listed_subjects(&f.engine, &f.account);
    listed.sort();
    assert_eq!(listed, vec!["Fresh invoice 77".to_string(), "Lunch plans".to_string(), "Weekly status".to_string()]);
    assert_eq!(f.search("invoice"), vec![3]);
}

#[test]
fn server_search_rows_outlive_sync_for_thirty_days_after_their_mark() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox(
        "INBOX",
        vec![mail(1, "Overdue invoice 4411", "The ledgerword is attached below.", 200), mail(2, "Weekly status", "All quiet.", 1)],
    )));
    let f = setup(&server);
    let dir = f._tmp.path();
    f.sync(None);
    let rows = server_rows(&f.engine, &f.account, "INBOX", "invoice");
    assert_eq!(uids(&json!({ "rows": rows })), vec![1]);
    let set_mark = |ms: i64| {
        mobile_db(dir).execute("UPDATE messages SET out_of_window_ms = ?2 WHERE account_id = ?1 AND uid = 1", (&f.account, ms)).unwrap();
    };
    // Within 30 days of its mark a pass that does not list it leaves it alone, and so does the
    // index.
    set_mark(now_ms() - MONTH + DAY);
    f.sync(Some("INBOX"));
    assert!(has_row(dir, &f.account, 1));
    assert_eq!(f.search("invoice"), vec![1]);
    // Opening it moves the mark to now.
    set_mark(now_ms() - MONTH + DAY);
    f.body(1);
    let mark = mark_of(dir, &f.account, 1).unwrap();
    assert!((now_ms() - mark).abs() < 60_000, "{mark}");
    // Searching again moves it too.
    set_mark(now_ms() - MONTH + DAY);
    assert_eq!(server_rows(&f.engine, &f.account, "INBOX", "invoice").len(), 1);
    assert!((now_ms() - mark_of(dir, &f.account, 1).unwrap()).abs() < 60_000);
    // Past 30 days the next pass removes it, with its index entry.
    set_mark(now_ms() - MONTH - DAY);
    f.sync(Some("INBOX"));
    assert!(!has_row(dir, &f.account, 1));
    assert!(f.search("invoice").is_empty());
    assert_eq!(indexed(&f.engine, &f.account, "INBOX"), vec![2]);
    // A row in the window never carries a mark, and a pass still removes it when it is gone.
    assert_eq!(mark_of(dir, &f.account, 2), None);
    server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[2], false));
    f.sync(Some("INBOX"));
    assert!(!has_row(dir, &f.account, 2));
}
