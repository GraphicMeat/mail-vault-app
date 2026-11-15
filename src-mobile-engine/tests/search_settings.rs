//! Settings > Search index on the phone: the bodies switch (body words leave the index and come
//! back, on the index worker), `mobile.search.status` (counts, size, state) and
//! `mobile.search.rebuild` (answers at once; the worker builds the index again). Mail is written
//! straight into `mobile.db`, as the backfill cases in `search.rs` do.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn open(dir: &Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

fn idle(e: &Engine) {
    let deadline = Instant::now() + WAIT;
    while !e.search_idle() {
        assert!(Instant::now() < deadline, "the index never went idle: {:?}", e.search_backfill());
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn search(e: &Engine, query: &str) -> Vec<u32> {
    let page = e.rpc("mobile.search.local", json!({ "query": query })).unwrap();
    page["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap() as u32).collect()
}

/// `n` rows in acc_a/INBOX with subject `"<word> <n>"`, and a cached body for uid 2.
fn seeded(word: &str, n: u32) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    drop(open(tmp.path()));
    for s in ["search.db", "search.db-wal", "search.db-shm"] {
        let _ = std::fs::remove_file(tmp.path().join(s));
    }
    let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    c.execute(
        "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
         VALUES ('acc_a', 'acc_a@example.test', 'U', 'imap.example.test', 993, 'ssl', 1)",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO folders (account_id, path, name) VALUES ('acc_a', 'INBOX', 'INBOX')", []).unwrap();
    for uid in 1..=n as i64 {
        c.execute(
            "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id)
             VALUES ('acc_a', 'INBOX', ?1, ?2, 'Ada', 'ada@example.test', ?3, '', 0, 0, 0, ?4)",
            (uid, format!("{word} {uid}"), now_ms() - 86_400_000 + uid * 1000, format!("<s-{uid}@example.test>")),
        )
        .unwrap();
    }
    c.execute("INSERT INTO bodies (account_id, folder, uid, text, bytes) VALUES ('acc_a', 'INBOX', 2, 'a narwhal in the fjord', 22)", []).unwrap();
    tmp
}

fn set_pref(e: &Engine, key: &str, v: Value) -> Value {
    e.rpc("mobile.prefs.set", json!({ key: v })).unwrap()
}

#[test]
fn the_search_index_prefs_default_on_and_take_only_flags() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!(p["searchIndexBodies"], true, "{p}");
    assert_eq!(p["searchIndexAttachments"], true, "{p}");
    assert!(e.rpc("mobile.prefs.set", json!({ "searchIndexBodies": "no" })).is_err());
    assert_eq!(set_pref(&e, "searchIndexAttachments", json!(false))["searchIndexAttachments"], false);
}

#[test]
fn bodies_off_drops_body_words_and_on_brings_them_back() {
    let tmp = seeded("osprey", 300);
    let e = open(tmp.path());
    idle(&e);
    assert_eq!(search(&e, "narwhal"), vec![2]);

    set_pref(&e, "searchIndexBodies", json!(false));
    idle(&e);
    assert!(search(&e, "narwhal").is_empty(), "body words stayed with bodies off");
    assert_eq!(search(&e, "\"osprey 300\""), vec![300], "subjects stay searchable");
    assert_eq!(search(&e, "osprey").len(), 50, "every row is still indexed (one page)");
    // Off holds across a restart, and a body indexed meanwhile brings no words.
    drop(e);
    let e = open(tmp.path());
    idle(&e);
    assert!(search(&e, "narwhal").is_empty());

    set_pref(&e, "searchIndexBodies", json!(true));
    idle(&e);
    assert_eq!(search(&e, "narwhal"), vec![2]);
}

#[test]
fn status_counts_the_index_and_rebuild_builds_it_again_off_the_caller() {
    let tmp = seeded("heron", 250);
    let e = open(tmp.path());
    idle(&e);
    let s = e.rpc("mobile.search.status", json!({})).unwrap();
    assert_eq!(s["available"], true, "{s}");
    assert_eq!(s["state"], "idle", "{s}");
    assert_eq!(s["indexed"], 250, "{s}");
    assert_eq!(s["total"], 250, "{s}");
    assert_eq!(s["attachments"], 0, "{s}");
    assert!(s["sizeBytes"].as_u64().unwrap() > 0, "{s}");

    let before = e.search_backfill().rows;
    let t = Instant::now();
    assert_eq!(e.rpc("mobile.search.rebuild", json!({})).unwrap(), json!({ "ok": true }));
    assert!(t.elapsed() < Duration::from_millis(500), "rebuild blocked the caller for {:?}", t.elapsed());
    idle(&e);
    let stats = e.search_backfill();
    assert_eq!(stats.rows - before, 250, "the rebuild indexed every row again: {stats:?}");
    assert!(stats.max_rows <= 200, "{stats:?}");
    assert_eq!(search(&e, "\"heron 250\""), vec![250]);
    assert_eq!(search(&e, "narwhal"), vec![2]);
    let s = e.rpc("mobile.search.status", json!({})).unwrap();
    assert_eq!((s["indexed"].as_u64(), s["state"].as_str()), (Some(250), Some("idle")), "{s}");
}
