//! Conversations in the list (`threadMode` grouped or expandable): `mobile.messages.page` with
//! `threads: true` lists one row per conversation, its newest message's, grouped over the whole
//! folder the way desktop groups them (References and In-Reply-To joined, reply-like subjects
//! within 30 days), and `mobile.messages.thread` lists one conversation's messages. Without
//! `threads` the list is the flat one, unchanged.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

const DAY: i64 = 86_400_000;

fn open(dir: &Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

fn db(dir: &Path) -> Connection {
    let c = Connection::open(dir.join("mobile.db")).unwrap();
    c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    c
}

fn add_account(c: &Connection, id: &str) {
    c.execute(
        "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
         VALUES (?1, ?1 || '@example.test', ?1, 'imap.example.test', 993, 'ssl', 1)",
        [id],
    )
    .unwrap();
    c.execute("INSERT INTO folders (account_id, path, name, special_use) VALUES (?1, 'INBOX', 'INBOX', NULL)", [id]).unwrap();
}

struct Msg<'a> {
    uid: i64,
    date_ms: i64,
    message_id: &'a str,
    subject: &'a str,
    references: &'a [&'a str],
    in_reply_to: Option<&'a str>,
    seen: bool,
    flagged: bool,
}

const MSG: Msg<'static> =
    Msg { uid: 0, date_ms: 0, message_id: "", subject: "", references: &[], in_reply_to: None, seen: true, flagged: false };

fn add(c: &Connection, account: &str, m: Msg<'_>) {
    let thread = json!({ "cc": [], "replyTo": [], "references": m.references, "inReplyTo": m.in_reply_to, "date": null });
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id, thread_json)
         VALUES (?1, 'INBOX', ?2, ?3, 'S', 's@example.test', ?4, '', ?5, ?6, 0, ?7, ?8)",
        (account, m.uid, m.subject, m.date_ms, m.seen as i64, m.flagged as i64, m.message_id, thread.to_string()),
    )
    .unwrap();
}

fn page(e: &Engine, account: &str, threads: bool, cursor: Value, limit: u64) -> Value {
    let mut params = json!({ "accountId": account, "folder": "INBOX", "cursor": cursor, "limit": limit });
    if threads {
        params["threads"] = json!(true);
    }
    e.rpc("mobile.messages.page", params).unwrap()
}

fn uids(p: &Value) -> Vec<i64> {
    p["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_i64().unwrap()).collect()
}

fn row<'a>(p: &'a Value, uid: i64) -> &'a Value {
    p["rows"].as_array().unwrap().iter().find(|r| r["uid"] == uid).unwrap()
}

/// Plans: 1 <- 2 (References) <- 4 (In-Reply-To only its parent). Lunch: 3, and 5, a "Re: Lunch"
/// with no headers a day later. Two bare "Newsletter" mails never merge by subject.
fn seed(c: &Connection, account: &str) {
    add(c, account, Msg { uid: 1, date_ms: 100 * DAY, message_id: "<a@x>", subject: "Plans", ..MSG });
    add(c, account, Msg { uid: 2, date_ms: 101 * DAY, message_id: "<b@x>", subject: "Re: Plans", references: &["<a@x>"], ..MSG });
    add(c, account, Msg { uid: 3, date_ms: 102 * DAY, message_id: "<c@x>", subject: "Lunch", flagged: true, ..MSG });
    add(c, account, Msg { uid: 4, date_ms: 104 * DAY, message_id: "<d@x>", subject: "RE: Plans", in_reply_to: Some("<b@x>"), seen: false, ..MSG });
    add(c, account, Msg { uid: 5, date_ms: 103 * DAY, message_id: "", subject: "Re: Lunch", seen: false, ..MSG });
    add(c, account, Msg { uid: 6, date_ms: 50 * DAY, message_id: "", subject: "Newsletter", ..MSG });
    add(c, account, Msg { uid: 7, date_ms: 51 * DAY, message_id: "", subject: "Newsletter", ..MSG });
}

#[test]
fn a_threaded_page_lists_one_row_per_conversation_newest_first() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    seed(&c, "a");

    let p = page(&e, "a", true, Value::Null, 50);
    assert_eq!(uids(&p), vec![4, 5, 7, 6], "{p}");
    assert_eq!(p["total"], 4);
    assert!(p["nextCursor"].is_null());

    let plans = row(&p, 4);
    assert_eq!(plans["threadCount"], 3, "{plans}");
    assert_eq!(plans["threadUids"], json!([4, 2, 1]));
    assert_eq!(plans["threadUnread"], 1);
    assert_eq!(plans["threadId"], "<a@x>");
    assert_eq!(plans["threadFlagged"], false);
    assert_eq!(plans["seen"], false, "the row's own fields are its newest message's");
    assert_eq!(plans["subject"], "RE: Plans", "the newest message's row");

    let lunch = row(&p, 5);
    assert_eq!(lunch["threadCount"], 2, "a reply-like subject joins its conversation: {lunch}");
    assert_eq!(lunch["threadUids"], json!([5, 3]));
    assert_eq!(lunch["threadFlagged"], true, "flagged while any message is");
    assert_eq!(lunch["flagged"], false, "the newest message's own flag");
    assert_eq!(lunch["threadUnread"], 1);

    for uid in [6, 7] {
        let r = row(&p, uid);
        assert!(r.get("threadCount").is_none(), "a one-message conversation is the plain row: {r}");
        assert!(r.get("threadUids").is_none());
    }
}

#[test]
fn the_flat_list_is_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    seed(&c, "a");
    let p = page(&e, "a", false, Value::Null, 50);
    assert_eq!(uids(&p), vec![4, 5, 3, 2, 1, 7, 6]);
    assert_eq!(p["total"], 7);
    for r in p["rows"].as_array().unwrap() {
        assert!(r.get("threadCount").is_none() && r.get("threadId").is_none(), "{r}");
    }
}

#[test]
fn a_subject_alone_merges_only_within_thirty_days() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    add(&c, "a", Msg { uid: 1, date_ms: 10 * DAY, message_id: "<q@x>", subject: "Contract", ..MSG });
    add(&c, "a", Msg { uid: 2, date_ms: 90 * DAY, message_id: "", subject: "Fw: Contract", ..MSG });
    let p = page(&e, "a", true, Value::Null, 50);
    assert_eq!(uids(&p), vec![2, 1], "{p}");
}

#[test]
fn threaded_pages_walk_every_conversation_once() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    let ids: Vec<String> = (0..500).map(|i| format!("<m{i}@x>")).collect();
    for i in 0..250_i64 {
        let root = &ids[(2 * i) as usize];
        let reply = &ids[(2 * i + 1) as usize];
        // Ties on the date across conversations: the uid orders them.
        add(&c, "a", Msg { uid: 2 * i + 1, date_ms: (i / 3) * 1000, message_id: root, subject: "Topic", ..MSG });
        add(&c, "a", Msg { uid: 2 * i + 2, date_ms: (i / 3) * 1000 + 500, message_id: reply, subject: "Re: Topic", references: &[root.as_str()], ..MSG });
    }
    let mut seen = HashSet::new();
    let mut heads = Vec::new();
    let mut cursor = Value::Null;
    for _ in 0..100 {
        let p = page(&e, "a", true, cursor, 40);
        assert_eq!(p["total"], 250);
        for r in p["rows"].as_array().unwrap() {
            assert_eq!(r["threadCount"], 2, "{r}");
            assert!(seen.insert(r["uid"].as_i64().unwrap()), "a conversation came twice: {r}");
            heads.push((r["dateMs"].as_i64().unwrap(), r["uid"].as_i64().unwrap()));
        }
        cursor = p["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen.len(), 250);
    let mut sorted = heads.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(heads, sorted, "newest first");
}

#[test]
fn a_thread_lists_its_messages_in_either_order() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    seed(&c, "a");
    let t = |uid: i64, order: Option<&str>| {
        let mut params = json!({ "accountId": "a", "folder": "INBOX", "uid": uid });
        if let Some(o) = order {
            params["order"] = json!(o);
        }
        e.rpc("mobile.messages.thread", params).unwrap()
    };
    let oldest = t(4, None);
    assert_eq!(uids(&oldest), vec![1, 2, 4], "{oldest}");
    assert_eq!(oldest["threadId"], "<a@x>");
    for r in oldest["rows"].as_array().unwrap() {
        assert_eq!(r["accountId"], "a");
        assert_eq!(r["folder"], "INBOX");
        assert!(r.get("threadCount").is_none(), "members are plain rows: {r}");
    }
    assert_eq!(uids(&t(1, Some("oldest-first"))), vec![1, 2, 4]);
    assert_eq!(uids(&t(2, Some("newest-first"))), vec![4, 2, 1]);
    assert_eq!(uids(&t(6, None)), vec![6]);
    let gone = t(99, None);
    assert_eq!(gone["rows"], json!([]));
    assert_eq!(gone["threadId"], Value::Null);
    assert!(e.rpc("mobile.messages.thread", json!({ "accountId": "a", "folder": "INBOX", "uid": 1, "order": "sideways" })).is_err());
}

#[test]
fn new_mail_regroups_on_the_next_page() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    seed(&c, "a");
    assert_eq!(uids(&page(&e, "a", true, Value::Null, 50)), vec![4, 5, 7, 6]);
    // A reply to Lunch arrives: Lunch moves to the top with three messages.
    add(&c, "a", Msg { uid: 8, date_ms: 105 * DAY, message_id: "<e@x>", subject: "Re: Lunch", references: &["<c@x>"], ..MSG });
    let p = page(&e, "a", true, Value::Null, 50);
    assert_eq!(uids(&p), vec![8, 4, 7, 6], "{p}");
    assert_eq!(row(&p, 8)["threadUids"], json!([8, 5, 3]));
    // An action on a message changes the conversation's state.
    e.rpc("mobile.actions.apply", json!({ "accountId": "a", "folder": "INBOX", "uids": [4], "kind": "seen" })).unwrap();
    let p = page(&e, "a", true, Value::Null, 50);
    assert_eq!(row(&p, 4)["threadUnread"], 0, "{p}");
    assert_eq!(row(&p, 4)["seen"], true);
}

#[test]
fn all_inboxes_threads_each_inbox_on_its_own() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    add_account(&c, "b");
    seed(&c, "a");
    // The same Message-IDs in another account: its own conversations, never merged with a's.
    add(&c, "b", Msg { uid: 1, date_ms: 103 * DAY + 1, message_id: "<a@x>", subject: "Plans", ..MSG });
    add(&c, "b", Msg { uid: 2, date_ms: 106 * DAY, message_id: "<b@x>", subject: "Re: Plans", references: &["<a@x>"], ..MSG });

    let mut got = Vec::new();
    let mut cursor = Value::Null;
    let mut total = 0;
    for _ in 0..10 {
        let p = e.rpc("mobile.messages.page", json!({ "scope": "allInboxes", "cursor": cursor, "limit": 2, "threads": true })).unwrap();
        total = p["total"].as_i64().unwrap();
        for r in p["rows"].as_array().unwrap() {
            got.push((r["accountId"].as_str().unwrap().to_string(), r["uid"].as_i64().unwrap(), r["threadCount"].as_i64().unwrap_or(1)));
        }
        cursor = p["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(total, 5);
    let want: Vec<(String, i64, i64)> =
        vec![("b".into(), 2, 2), ("a".into(), 4, 3), ("a".into(), 5, 2), ("a".into(), 7, 1), ("a".into(), 6, 1)];
    assert_eq!(got, want);
}

/// A header is the sender's to write: a message naming tens of thousands of ids is read in linear
/// time, and still joins its conversation by its root (the first id) and its parent (the last).
#[test]
fn a_huge_references_header_groups_quickly() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "a");
    add(&c, "a", Msg { uid: 1, date_ms: 10 * DAY, message_id: "<root@x>", subject: "Big", ..MSG });
    add(&c, "a", Msg { uid: 2, date_ms: 11 * DAY, message_id: "<parent@x>", subject: "Other", ..MSG });
    let mut refs: Vec<String> = vec!["<root@x>".into()];
    refs.extend((0..60_000).map(|i| format!("<junk{i}@spam.example>")));
    refs.push("<parent@x>".into());
    let refs: Vec<&str> = refs.iter().map(String::as_str).collect();
    add(&c, "a", Msg { uid: 3, date_ms: 12 * DAY, message_id: "<big@x>", subject: "Re: Big", references: &refs, ..MSG });

    let started = std::time::Instant::now();
    let p = page(&e, "a", true, Value::Null, 50);
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "grouping took {:?}", started.elapsed());
    assert_eq!(uids(&p), vec![3], "{p}");
    assert_eq!(row(&p, 3)["threadUids"], json!([3, 2, 1]));
}
