//! `mobile.tags.*`: desktop's tags on the phone, in its core `app.db`, keyed by core's
//! `msg_key_or_remote` (Message-ID; else `r:<remote id>` for Graph/JMAP; else desktop's IMAP uid
//! key), so a resync, a second folder and a desktop import all land on the same message. Search's
//! `tag:` terms narrow by them.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use rusqlite::Connection;
use serde_json::{json, Value};
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

fn add_account(c: &Connection, id: &str, kind: &str) {
    c.execute(
        "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms, kind)
         VALUES (?1, ?1 || '@example.test', ?1, 'imap.example.test', 993, 'ssl', 1, ?2)",
        (id, kind),
    )
    .unwrap();
}

fn add_row(c: &Connection, account: &str, folder: &str, uid: i64, date_ms: i64, message_id: &str) {
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id)
         VALUES (?1, ?2, ?3, ?4, 'S', 's@example.test', ?5, '', 0, 0, 0, ?6)",
        (account, folder, uid, format!("{account}/{folder}/{uid}"), date_ms, message_id),
    )
    .unwrap();
}

fn item(account: &str, folder: &str, uid: u32) -> Value {
    json!({ "accountId": account, "folder": folder, "uid": uid })
}

fn tag_ids(e: &Engine, items: Vec<Value>) -> Vec<Vec<String>> {
    let r = e.rpc("mobile.tags.forMessages", json!({ "items": items })).unwrap();
    serde_json::from_value(r["tags"].clone()).unwrap()
}

fn create(e: &Engine, name: &str, color: &str) -> String {
    let r = e.rpc("mobile.tags.create", json!({ "name": name, "color": color })).unwrap();
    r["tag"]["id"].as_str().unwrap().to_string()
}

#[test]
fn create_assign_list_and_delete_like_desktop() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    add_row(&c, "acc_a", "INBOX", 1, 10, "<one@x>");
    add_row(&c, "acc_a", "INBOX", 2, 20, "<two@x>");
    // The same message in a second folder shares its key, so its tag.
    add_row(&c, "acc_a", "Archive", 9, 10, "one@x");

    assert_eq!(e.rpc("mobile.tags.list", json!({})).unwrap()["tags"], json!([]));
    let work = create(&e, "Work", "#AABBCC");
    assert_eq!(create(&e, " work ", ""), work, "a name in another case is the same tag");
    let r = e.rpc("mobile.tags.assign", json!({ "tagId": work, "items": [item("acc_a", "INBOX", 1), item("acc_a", "INBOX", 404)] })).unwrap();
    assert_eq!(r["count"], 1, "a row the phone does not hold is skipped");

    assert_eq!(tag_ids(&e, vec![item("acc_a", "INBOX", 1), item("acc_a", "INBOX", 2), item("acc_a", "Archive", 9), item("acc_a", "INBOX", 404)]), vec![
        vec![work.clone()],
        vec![],
        vec![work.clone()],
        vec![],
    ]);
    let tags = e.rpc("mobile.tags.list", json!({})).unwrap()["tags"].clone();
    assert_eq!(tags[0]["name"], "Work");
    assert_eq!(tags[0]["color"], "#aabbcc");
    assert_eq!(tags[0]["count"], 1);

    let r = e.rpc("mobile.tags.unassign", json!({ "tagId": work, "items": [item("acc_a", "Archive", 9)] })).unwrap();
    assert_eq!(r["count"], 1);
    assert_eq!(tag_ids(&e, vec![item("acc_a", "INBOX", 1)]), vec![Vec::<String>::new()]);

    e.rpc("mobile.tags.assign", json!({ "tagId": work, "items": [item("acc_a", "INBOX", 2)] })).unwrap();
    let after = e.rpc("mobile.tags.delete", json!({ "id": work })).unwrap();
    assert_eq!(after["tags"], json!([]));
    assert_eq!(tag_ids(&e, vec![item("acc_a", "INBOX", 2)]), vec![Vec::<String>::new()]);
}

#[test]
fn rename_and_recolor_and_their_refusals() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let a = create(&e, "Clietns", "");
    create(&e, "Home", "");
    let r = e.rpc("mobile.tags.update", json!({ "id": a, "name": "Clients", "color": "#123456" })).unwrap();
    assert_eq!(r["tags"][0]["name"], "Clients");
    assert_eq!(r["tags"][0]["color"], "#123456");
    assert_eq!(e.rpc("mobile.tags.update", json!({ "id": a, "name": "home" })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.tags.update", json!({ "id": a, "color": "red; x" })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.tags.create", json!({ "name": "  " })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.tags.create", json!({ "name": "x".repeat(81) })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.tags.assign", json!({ "tagId": "nope", "items": [] })).unwrap_err().code(), "INVALID");
}

/// A Graph or JMAP message without a Message-ID is keyed by its server id: a resync that gives it
/// another local uid keeps its tags.
#[test]
fn a_message_without_a_message_id_keeps_its_tag_across_a_renumbering() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_g", "graph");
    add_row(&c, "acc_g", "inbox-id", 1, 10, "");
    c.execute("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES ('acc_g', 'inbox-id', 1, 'AAMkSERVER')", []).unwrap();
    let t = create(&e, "Later", "");
    e.rpc("mobile.tags.assign", json!({ "tagId": t, "items": [item("acc_g", "inbox-id", 1)] })).unwrap();

    // The row comes back under another uid.
    c.execute_batch(
        "DELETE FROM messages WHERE uid = 1; DELETE FROM remote_ids WHERE uid = 1;
         INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES ('acc_g', 'inbox-id', 7, 'AAMkSERVER');",
    )
    .unwrap();
    add_row(&c, "acc_g", "inbox-id", 7, 10, "");
    assert_eq!(tag_ids(&e, vec![item("acc_g", "inbox-id", 7)]), vec![vec![t]]);
}

/// The key an IMAP message without a Message-ID gets is desktop's own (`u:<vault dir>:<uid>`), so a
/// tag the computer gave it reaches it.
#[test]
fn an_imap_message_without_a_message_id_keys_as_desktop_does() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    add_row(&c, "acc_a", "[Gmail]/All Mail", 5, 10, "");
    let t = create(&e, "Old", "");
    {
        let store = mailvault_core::app_db::db::open(&tmp.path().join("core")).unwrap();
        let key = mailvault_core::app_db::identity::msg_key(None, &mailvault_core::search_index::text::vault_dir_name("[Gmail]/All Mail"), 5);
        mailvault_core::app_db::tags::assign(&store, &t, &[mailvault_core::app_db::tags::Target { account_id: "acc_a".into(), msg_key: key }]).unwrap();
    }
    assert_eq!(tag_ids(&e, vec![item("acc_a", "[Gmail]/All Mail", 5)]), vec![vec![t]]);
}

fn search(e: &Engine, query: &str, cursor: Value) -> Value {
    e.rpc("mobile.search.local", json!({ "query": query, "cursor": cursor })).unwrap()
}

fn uids(page: &Value) -> Vec<i64> {
    page["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_i64().unwrap()).collect()
}

/// Desktop's search terms: `tag:Name` alone lists the tagged mail, newest first, page by page; a
/// second tag narrows to the messages with both; a name no tag has finds nothing.
#[test]
fn tag_terms_in_search_list_the_tagged_mail() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    for uid in 1..=60 {
        add_row(&c, "acc_a", "INBOX", uid, uid * 10, &format!("<m{uid}@x>"));
    }
    let work = create(&e, "Needs reply", "");
    let home = create(&e, "Home", "");
    let all: Vec<Value> = (1..=55).map(|u| item("acc_a", "INBOX", u)).collect();
    e.rpc("mobile.tags.assign", json!({ "tagId": work, "items": all })).unwrap();
    e.rpc("mobile.tags.assign", json!({ "tagId": home, "items": [item("acc_a", "INBOX", 3), item("acc_a", "INBOX", 58)] })).unwrap();

    let first = search(&e, "tag:\"needs reply\"", Value::Null);
    assert_eq!(uids(&first).len(), 50);
    assert_eq!(uids(&first)[0], 55, "newest first");
    assert_eq!(first["rows"][0]["accountId"], "acc_a");
    assert_eq!(first["rows"][0]["folder"], "INBOX");
    let second = search(&e, "tag:\"needs reply\"", first["cursor"].clone());
    assert_eq!(uids(&second), vec![5, 4, 3, 2, 1]);
    assert_eq!(second["cursor"], Value::Null);

    assert_eq!(uids(&search(&e, "tag:Home TAG:\"Needs reply\"", Value::Null)), vec![3]);
    assert_eq!(uids(&search(&e, "tag:Nobody", Value::Null)), Vec::<i64>::new());
}

/// An account that leaves takes its assignments; the tag stays.
#[test]
fn removing_an_account_takes_its_assignments() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    add_row(&c, "acc_a", "INBOX", 1, 10, "<one@x>");
    let t = create(&e, "Work", "");
    e.rpc("mobile.tags.assign", json!({ "tagId": t, "items": [item("acc_a", "INBOX", 1)] })).unwrap();
    e.rpc("mobile.accounts.remove", json!({ "accountId": "acc_a" })).unwrap();
    let tags = e.rpc("mobile.tags.list", json!({})).unwrap()["tags"].clone();
    assert_eq!(tags[0]["count"], 0, "{tags}");
}
