//! `mobile.views.*`: desktop's saved views on the phone, in its core `app.db`, run over the
//! phone's own search index with desktop's request building (core `view_eval`), so a view finds
//! on the phone what it finds on desktop among the mail the phone holds.

use mailvault_mobile_engine::{Engine, MemorySecrets, RpcError};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;

fn open(dir: &Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn idle(e: &Engine) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !e.search_idle() {
        assert!(Instant::now() < deadline, "the index never went idle");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// One message: `(account, folder, uid, subject, from, days ago, seen, flagged, attachments, message_id)`.
type Mail<'a> = (&'a str, &'a str, i64, &'a str, &'a str, i64, bool, bool, bool, &'a str);

/// A data dir holding `accounts` (`(id, kind)`, folders `(account, path, special_use)`) and
/// `mail`, indexed by the backfill.
fn seeded(accounts: &[(&str, &str)], folders: &[(&str, &str, Option<&str>)], mail: &[Mail]) -> (tempfile::TempDir, Engine) {
    let tmp = tempfile::tempdir().unwrap();
    drop(open(tmp.path()));
    {
        let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
        for (id, kind) in accounts {
            c.execute(
                "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms, kind)
                 VALUES (?1, ?1 || '@example.test', 'U', 'imap.example.test', 993, 'ssl', 1, ?2)",
                (id, kind),
            )
            .unwrap();
        }
        for (account, path, special) in folders {
            c.execute("INSERT INTO folders (account_id, path, name, special_use) VALUES (?1, ?2, ?2, ?3)", (account, path, special)).unwrap();
        }
        for (account, folder, uid, subject, from, days, seen, flagged, att, mid) in mail {
            c.execute(
                "INSERT INTO messages
                 (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id)
                 VALUES (?1, ?2, ?3, ?4, 'S', ?5, ?6, '', ?7, ?8, ?9, ?10)",
                rusqlite::params![account, folder, uid, subject, from, now_ms() - days * DAY, seen, flagged, att, mid],
            )
            .unwrap();
        }
    }
    let e = open(tmp.path());
    idle(&e);
    (tmp, e)
}

fn uids(v: &Value) -> Vec<(String, u64)> {
    v["rows"].as_array().unwrap().iter().map(|r| (r["accountId"].as_str().unwrap().to_string(), r["uid"].as_u64().unwrap())).collect()
}

fn eval(e: &Engine, params: Value) -> Value {
    e.rpc("mobile.views.evaluate", params).unwrap()
}

fn sample() -> (tempfile::TempDir, Engine) {
    seeded(
        &[("acc_a", "imap"), ("acc_b", "imap")],
        &[("acc_a", "INBOX", None), ("acc_a", "Trash", Some("\\Trash")), ("acc_b", "INBOX", None)],
        &[
            ("acc_a", "INBOX", 1, "invoice march", "billing@acme.test", 1, true, true, true, "<one@x>"),
            ("acc_a", "INBOX", 2, "hello there", "ann@friends.test", 2, false, false, false, "<two@x>"),
            ("acc_a", "Trash", 3, "invoice old", "billing@acme.test", 3, false, false, true, "<three@x>"),
            ("acc_b", "INBOX", 4, "invoice april", "billing@acme.test", 4, true, false, false, "<four@x>"),
            ("acc_b", "INBOX", 5, "from me", "acc_b@example.test", 5, true, false, false, "<five@x>"),
        ],
    )
}

#[test]
fn the_starters_are_there_once_and_the_list_round_trips() {
    let (_tmp, e) = sample();
    let views = e.rpc("mobile.views.list", json!({})).unwrap()["views"].clone();
    let ids: Vec<&str> = views.as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["builtin-needs-reply", "builtin-starred", "builtin-attachments"]);
    e.rpc("mobile.views.delete", json!({ "id": "builtin-starred" })).unwrap();
    let again = e.rpc("mobile.views.list", json!({})).unwrap()["views"].as_array().unwrap().len();
    assert_eq!(again, 2, "a deleted starter stays deleted");

    let saved = e.rpc("mobile.views.save", json!({ "view": { "id": "v1", "name": " Bills ", "icon": "tag", "position": 0, "builtin": null,
        "def": { "senders": ["acme.test"] } } })).unwrap();
    assert_eq!(saved["view"]["name"], "Bills");
    assert_eq!(saved["view"]["position"], 3, "a new view goes after the last one (position 2)");
    let r = e.rpc("mobile.views.reorder", json!({ "ids": ["v1", "builtin-needs-reply", "builtin-attachments"] })).unwrap();
    assert_eq!(r["views"][0]["id"], "v1");
    assert!(e.rpc("mobile.views.reorder", json!({ "ids": ["v1"] })).is_err(), "every view once");
    assert!(e.rpc("mobile.views.save", json!({ "view": { "id": "v2", "name": "  ", "icon": "tag", "position": 0, "builtin": null, "def": {} } })).is_err());
}

#[test]
fn without_premium_a_fourth_view_is_refused_but_an_edit_is_not() {
    let (_tmp, e) = sample();
    let new = |id: &str| json!({ "view": { "id": id, "name": id, "icon": "tag", "position": 0, "builtin": null, "def": {} } });
    match e.rpc("mobile.views.save", new("v1")) {
        Err(RpcError::Premium(code)) => assert_eq!(code, "PREMIUM_REQUIRED"),
        other => panic!("{other:?}"),
    }
    e.rpc("mobile.views.save", json!({ "view": { "id": "builtin-starred", "name": "Pinned", "icon": "star", "position": 1, "builtin": "starred",
        "def": { "starred": true } } }))
        .unwrap();
    e.rpc("mobile.views.delete", json!({ "id": "builtin-attachments" })).unwrap();
    e.rpc("mobile.views.save", new("v1")).unwrap();
}

#[test]
fn a_view_finds_what_desktop_would_among_the_phones_mail() {
    let (_tmp, e) = sample();
    // A starter by id: starred.
    assert_eq!(uids(&eval(&e, json!({ "viewId": "builtin-starred" }))), vec![("acc_a".into(), 1)]);
    // Words, every account, newest first.
    let r = eval(&e, json!({ "def": { "query": "invoice" } }));
    assert_eq!(uids(&r), vec![("acc_a".into(), 1), ("acc_a".into(), 3), ("acc_b".into(), 4)]);
    assert_eq!(r["total"], 3);
    assert_eq!(r["available"], true);
    assert_eq!(r["rows"][0]["folder"], "INBOX");
    assert_eq!(r["rows"][0]["subject"], "invoice march");
    // Not the bin, by its special use; one account only.
    let r = eval(&e, json!({ "def": { "query": "invoice", "excludeSpecial": ["\\Trash"], "accounts": ["acc_a"] } }));
    assert_eq!(uids(&r), vec![("acc_a".into(), 1)]);
    // Unread, attachments, a sender and a sender kept out.
    assert_eq!(uids(&eval(&e, json!({ "def": { "unread": true, "hasAttachments": true } }))), vec![("acc_a".into(), 3)]);
    assert_eq!(uids(&eval(&e, json!({ "def": { "senders": ["friends.test"] } }))), vec![("acc_a".into(), 2)]);
    let r = eval(&e, json!({ "def": { "query": "invoice", "excludeSenders": ["billing@acme.test"] } }));
    assert!(uids(&r).is_empty());
    // Not from me: the account's own address.
    let mine = eval(&e, json!({ "def": { "accounts": ["acc_b"], "notFromMe": true } }));
    assert_eq!(uids(&mine), vec![("acc_b".into(), 4)]);
    // A message kept out by its key.
    assert_eq!(uids(&eval(&e, json!({ "def": { "query": "invoice", "excludeMessages": ["one@x", "three@x"] } }))), vec![("acc_b".into(), 4)]);
    assert!(e.rpc("mobile.views.evaluate", json!({ "viewId": "nope" })).is_err());
}

#[test]
fn a_view_pages_across_accounts_without_losing_or_repeating_a_row() {
    let mut mail: Vec<(String, i64, i64)> = Vec::new();
    for uid in 1..=70 {
        mail.push(("acc_a".into(), uid, uid * 2));
        mail.push(("acc_b".into(), uid + 1000, uid * 2 + 1));
    }
    let rows: Vec<Mail> = mail
        .iter()
        .map(|(a, uid, days)| (a.as_str(), "INBOX", *uid, "paging word", if a == "acc_a" { "a@x.test" } else { "b@x.test" }, *days, false, false, false, ""))
        .collect();
    let (_tmp, e) = seeded(&[("acc_a", "imap"), ("acc_b", "imap")], &[("acc_a", "INBOX", None), ("acc_b", "INBOX", None)], &rows);
    // `toMe` makes each account's request its own: two requests, merged by date.
    let def = json!({ "query": "paging", "toMe": false, "notFromMe": true });
    let mut seen: Vec<(String, u64)> = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let r = eval(&e, json!({ "def": def, "cursor": cursor }));
        assert_eq!(r["total"], 140);
        seen.extend(uids(&r));
        cursor = r["cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen.len(), 140);
    let mut sorted = seen.clone();
    sorted.dedup();
    assert_eq!(sorted.len(), 140, "no row twice");
    // Newest first throughout: acc_a's uid 1 (2 days), then acc_b's 1001 (3 days), ...
    assert_eq!(seen[0], ("acc_a".into(), 1));
    assert_eq!(seen[1], ("acc_b".into(), 1001));
    assert_eq!(seen[139], ("acc_b".into(), 1070));
}

#[test]
fn tag_and_field_conditions_narrow_to_the_messages_carrying_them() {
    let (_tmp, e) = seeded(
        &[("acc_a", "imap"), ("acc_g", "graph")],
        &[("acc_a", "INBOX", None), ("acc_g", "Inbox", None)],
        &[
            ("acc_a", "INBOX", 1, "one", "s@x.test", 1, false, false, false, "<one@x>"),
            ("acc_a", "INBOX", 2, "two", "s@x.test", 2, false, false, false, "<two@x>"),
            ("acc_g", "Inbox", 9, "no id", "s@x.test", 3, false, false, false, ""),
        ],
    );
    {
        let c = Connection::open(_tmp.path().join("mobile.db")).unwrap();
        c.execute("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES ('acc_g', 'Inbox', 9, 'AAMk9')", []).unwrap();
    }
    let item = |a: &str, f: &str, uid: u32| json!({ "accountId": a, "folder": f, "uid": uid });
    let tag = e.rpc("mobile.tags.create", json!({ "name": "Work" })).unwrap()["tag"]["id"].as_str().unwrap().to_string();
    e.rpc("mobile.tags.assign", json!({ "tagId": tag, "items": [item("acc_a", "INBOX", 1), item("acc_g", "Inbox", 9)] })).unwrap();
    // The Graph message has no Message-ID: the phone keys it `r:AAMk9`, the index `u:Inbox:9`.
    let r = eval(&e, json!({ "def": { "tags": [tag] } }));
    assert_eq!(uids(&r), vec![("acc_a".into(), 1), ("acc_g".into(), 9)]);
    assert!(uids(&eval(&e, json!({ "def": { "tags": ["nobody"] } }))).is_empty(), "a tag nobody used finds nothing");

    e.rpc("mobile.fields.save", json!({ "field": { "id": "p", "scope": "*", "name": "Priority", "kind": "select",
        "options": [{ "id": "hi", "label": "High" }] } }))
        .unwrap();
    e.rpc("mobile.fields.set", json!({ "item": item("acc_g", "Inbox", 9), "fieldId": "p", "value": "hi" })).unwrap();
    e.rpc("mobile.fields.set", json!({ "item": item("acc_a", "INBOX", 2), "fieldId": "p", "value": "hi" })).unwrap();
    let both = eval(&e, json!({ "def": { "tags": [tag], "fields": [{ "fieldId": "p", "op": "is", "value": "hi" }] } }));
    assert_eq!(uids(&both), vec![("acc_g".into(), 9)], "a tag and a field narrow together");
    // Kept out by its phone key.
    let r = eval(&e, json!({ "def": { "tags": [tag], "excludeMessages": ["r:AAMk9"] } }));
    assert_eq!(uids(&r), vec![("acc_a".into(), 1)]);

    let counts = e.rpc("mobile.views.counts", json!({})).unwrap()["counts"].clone();
    assert_eq!(counts["builtin-attachments"], 0);
    assert_eq!(counts["builtin-starred"], 0);
}
