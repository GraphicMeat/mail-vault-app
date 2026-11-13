//! `mobile.messages.page` with `scope: "allInboxes"`: every account's inbox as one list, merged
//! newest first, the way desktop's All Inboxes lists it. Rows carry their own account and folder,
//! and the cursor pages through ties across accounts without a duplicate or a gap.

use mailvault_mobile_engine::{Engine, MemorySecrets, RpcError};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

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
}

fn add_folder(c: &Connection, account: &str, path: &str) {
    c.execute(
        "INSERT INTO folders (account_id, path, name, special_use) VALUES (?1, ?2, ?2, NULL)",
        (account, path),
    )
    .unwrap();
}

fn add_row(c: &Connection, account: &str, folder: &str, uid: i64, date_ms: i64) {
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
         VALUES (?1, ?2, ?3, ?4, 'S', 's@example.test', ?5, '', 0, 0, 0)",
        (account, folder, uid, format!("{account}/{folder}/{uid}"), date_ms),
    )
    .unwrap();
}

fn unified(e: &Engine, cursor: Value, limit: u64) -> Value {
    e.rpc("mobile.messages.page", json!({ "scope": "allInboxes", "cursor": cursor, "limit": limit })).unwrap()
}

/// Every row of the unified list, page by page, as `(accountId, folder, uid, dateMs)`.
fn walk(e: &Engine, limit: u64) -> Vec<(String, String, i64, i64)> {
    let mut out = Vec::new();
    let mut cursor = Value::Null;
    for _ in 0..1000 {
        let p = unified(e, cursor, limit);
        for r in p["rows"].as_array().unwrap() {
            out.push((
                r["accountId"].as_str().expect("row names its account").to_string(),
                r["folder"].as_str().expect("row names its folder").to_string(),
                r["uid"].as_i64().unwrap(),
                r["dateMs"].as_i64().unwrap(),
            ));
        }
        cursor = p["nextCursor"].clone();
        if cursor.is_null() {
            return out;
        }
    }
    panic!("the cursor never reached the end");
}

#[test]
fn merges_every_inbox_newest_first_with_its_account() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    for a in ["acc_a", "acc_b", "acc_c"] {
        add_account(&c, a);
    }
    add_folder(&c, "acc_a", "INBOX");
    // A server that names it `Inbox`: still that account's inbox.
    add_folder(&c, "acc_b", "Inbox");
    add_folder(&c, "acc_c", "INBOX");
    add_row(&c, "acc_a", "INBOX", 1, 1_000);
    add_row(&c, "acc_a", "INBOX", 2, 4_000);
    add_row(&c, "acc_b", "Inbox", 1, 3_000);
    add_row(&c, "acc_b", "Inbox", 2, 6_000);
    add_row(&c, "acc_c", "INBOX", 7, 5_000);
    // Not inboxes: never in the unified list.
    add_row(&c, "acc_a", "Sent", 9, 9_000);
    add_row(&c, "acc_b", "Archive", 9, 8_000);

    let p = unified(&e, Value::Null, 50);
    let rows = p["rows"].as_array().unwrap();
    let got: Vec<(&str, &str, i64)> = rows
        .iter()
        .map(|r| (r["accountId"].as_str().unwrap(), r["folder"].as_str().unwrap(), r["uid"].as_i64().unwrap()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("acc_b", "Inbox", 2),
            ("acc_c", "INBOX", 7),
            ("acc_a", "INBOX", 2),
            ("acc_b", "Inbox", 1),
            ("acc_a", "INBOX", 1),
        ]
    );
    assert_eq!(p["total"], 5);
    assert!(p["nextCursor"].is_null());
    assert!(p["listGen"].is_i64(), "{p}");
    for k in ["subject", "fromName", "fromAddress", "snippet", "seen", "flagged", "hasAttachments", "to"] {
        assert!(rows[0].get(k).is_some(), "missing {k}");
    }
}

#[test]
fn pages_through_same_date_same_uid_ties_across_accounts_without_dupes_or_gaps() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    for a in ["acc_a", "acc_b"] {
        add_account(&c, a);
        add_folder(&c, a, "INBOX");
    }
    // Both accounts hold the same uids at the same dates: (dateMs, uid) alone cannot order them.
    let mut expected = HashSet::new();
    for uid in 1..=23_i64 {
        let date = 10_000 + (uid / 3) * 1_000; // three uids share each date
        for a in ["acc_a", "acc_b"] {
            add_row(&c, a, "INBOX", uid, date);
            expected.insert((a.to_string(), uid));
        }
    }
    for limit in [1_u64, 2, 3, 5, 7, 46, 200] {
        let all = walk(&e, limit);
        let seen: HashSet<(String, i64)> = all.iter().map(|(a, _, u, _)| (a.clone(), *u)).collect();
        assert_eq!(all.len(), 46, "limit {limit}: duplicates or gaps");
        assert_eq!(seen, expected, "limit {limit}");
        assert!(all.windows(2).all(|w| w[0].3 >= w[1].3), "limit {limit}: not newest first");
    }
    // A boundary that falls between the two accounts' copies of one (dateMs, uid).
    let first = unified(&e, Value::Null, 1);
    let second = unified(&e, first["nextCursor"].clone(), 1);
    let (r1, r2) = (&first["rows"][0], &second["rows"][0]);
    assert_eq!((r1["dateMs"].clone(), r1["uid"].clone()), (r2["dateMs"].clone(), r2["uid"].clone()));
    assert_ne!(r1["accountId"], r2["accountId"]);
    assert_eq!(first["total"], 46);
}

#[test]
fn a_removed_account_is_not_listed_and_a_held_one_still_is() {
    // Desktop lists every account it has in All Inboxes, a signed-out one's stored mail too, and
    // nothing of an account that is gone.
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    for a in ["acc_held", "acc_ok"] {
        add_account(&c, a);
        add_folder(&c, a, "INBOX");
    }
    add_row(&c, "acc_held", "INBOX", 1, 2_000);
    add_row(&c, "acc_ok", "INBOX", 1, 1_000);
    // Rows left behind by an account that is no longer there.
    add_row(&c, "acc_gone", "INBOX", 1, 3_000);
    c.execute("INSERT INTO settings (key, value) VALUES ('bg.authRefused.acc_held', '1')", []).unwrap();
    c.execute("UPDATE accounts SET needs_auth = 1 WHERE id = 'acc_held'", []).unwrap();

    let p = unified(&e, Value::Null, 50);
    let accounts: Vec<&str> = p["rows"].as_array().unwrap().iter().map(|r| r["accountId"].as_str().unwrap()).collect();
    assert_eq!(accounts, vec!["acc_held", "acc_ok"]);
    assert_eq!(p["total"], 2);

    // Removing an account takes its mail out of the unified list at once.
    e.rpc("mobile.accounts.remove", json!({ "accountId": "acc_held" })).unwrap();
    let p = unified(&e, Value::Null, 50);
    let accounts: Vec<&str> = p["rows"].as_array().unwrap().iter().map(|r| r["accountId"].as_str().unwrap()).collect();
    assert_eq!(accounts, vec!["acc_ok"]);
    assert_eq!(p["total"], 1);
}

#[test]
fn a_locally_deleted_row_leaves_the_unified_list_too() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    for a in ["acc_a", "acc_b"] {
        add_account(&c, a);
        add_folder(&c, a, "INBOX");
        add_row(&c, a, "INBOX", 1, 1_000);
        add_row(&c, a, "INBOX", 2, 2_000);
    }
    c.execute("UPDATE messages SET local_deleted = 1 WHERE account_id = 'acc_a' AND uid = 2", []).unwrap();
    let all = walk(&e, 50);
    let keys: Vec<(String, i64)> = all.into_iter().map(|(a, _, u, _)| (a, u)).collect();
    assert_eq!(keys, vec![("acc_b".into(), 2), ("acc_b".into(), 1), ("acc_a".into(), 1)]);
}

#[test]
fn the_single_folder_form_still_needs_its_account_and_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    for params in [
        json!({ "folder": "INBOX", "cursor": null, "limit": 10 }),
        json!({ "accountId": "a", "cursor": null, "limit": 10 }),
        json!({ "scope": "everything", "cursor": null, "limit": 10 }),
        json!({ "scope": "allInboxes", "offset": 0, "limit": 10 }),
    ] {
        let err = e.rpc("mobile.messages.page", params.clone()).unwrap_err();
        assert!(matches!(err, RpcError::Invalid(_)), "{params}: {err:?}");
    }
}
