//! `mobile.fields.*`: desktop's custom fields on the phone, in its core `app.db`, values keyed as
//! the tags are (core `msg_key_or_remote`), so a second folder, a resync and a desktop import land
//! on the same message.

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

fn add_row(c: &Connection, account: &str, folder: &str, uid: i64, message_id: &str) {
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, message_id)
         VALUES (?1, ?2, ?3, 's', 'S', 's@example.test', 1, '', 0, 0, 0, ?4)",
        (account, folder, uid, message_id),
    )
    .unwrap();
}

fn item(account: &str, folder: &str, uid: u32) -> Value {
    json!({ "accountId": account, "folder": folder, "uid": uid })
}

fn save(e: &Engine, field: Value) -> Value {
    e.rpc("mobile.fields.save", json!({ "field": field })).unwrap()["field"].clone()
}

fn priority(scope: &str) -> Value {
    json!({ "id": format!("f-{scope}"), "scope": scope, "name": "Priority", "kind": "select",
            "options": [{ "id": "hi", "label": "High", "color": "#FF0000" }, { "id": "lo", "label": "Low" }] })
}

fn names(e: &Engine, account: &str) -> Vec<String> {
    let r = e.rpc("mobile.fields.list", json!({ "accountId": account })).unwrap();
    r["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap().to_string()).collect()
}

fn values(e: &Engine, items: Vec<Value>) -> Value {
    e.rpc("mobile.fields.values", json!({ "items": items })).unwrap()["values"].clone()
}

#[test]
fn define_list_reorder_and_delete_like_desktop() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    add_account(&c, "acc_b", "imap");

    let saved = save(&e, priority("acc_a"));
    assert_eq!(saved["options"][0]["color"], "#ff0000", "a color is stored lowercased");
    save(&e, json!({ "id": "g1", "scope": "*", "name": "Owner", "kind": "text" }));
    save(&e, json!({ "id": "c1", "scope": "acc_a", "name": "Client", "kind": "text" }));
    assert_eq!(names(&e, "acc_a"), vec!["Owner", "Priority", "Client"], "shared first, then the account's own");
    assert_eq!(names(&e, "acc_b"), vec!["Owner"]);

    assert_eq!(e.rpc("mobile.fields.reorder", json!({ "id": "c1", "delta": -1 })).unwrap()["moved"], true);
    assert_eq!(names(&e, "acc_a"), vec!["Owner", "Client", "Priority"]);
    assert_eq!(e.rpc("mobile.fields.reorder", json!({ "id": "g1", "delta": 1 })).unwrap()["moved"], false, "never across the shared line");

    let copied = e.rpc("mobile.fields.copy", json!({ "fieldIds": ["f-acc_a"], "accountId": "acc_b" })).unwrap();
    assert_eq!(copied["fields"][0]["name"], "Priority");
    assert_eq!(names(&e, "acc_b"), vec!["Owner", "Priority"]);

    assert_eq!(e.rpc("mobile.fields.delete", json!({ "id": "c1" })).unwrap()["droppedValues"], 0);
    assert_eq!(names(&e, "acc_a"), vec!["Owner", "Priority"]);
}

#[test]
fn a_field_the_phone_would_not_show_safely_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    add_account(&db(tmp.path()), "acc_a", "imap");
    let refused = |field: Value| e.rpc("mobile.fields.save", json!({ "field": field })).is_err();
    assert!(refused(json!({ "id": "x", "scope": "acc_a", "name": "Stars", "kind": "rating" })), "unknown kind");
    assert!(refused(json!({ "id": "x", "scope": "acc_a", "name": "  ", "kind": "text" })), "no name");
    assert!(refused(json!({ "id": "x", "scope": "nobody", "name": "N", "kind": "text" })), "unknown account");
    assert!(refused(json!({ "id": "x", "scope": "acc_a", "name": "N", "kind": "select",
                             "options": [{ "id": "o", "label": "O", "color": "red; background:url(x)" }] })), "color lands in a style");
    assert!(refused(json!({ "id": "x", "scope": "acc_a", "name": "x".repeat(81), "kind": "text" })), "name too long");
    save(&e, priority("acc_a"));
    assert!(refused(json!({ "id": "other", "scope": "acc_a", "name": "priority", "kind": "text" })), "a name the scope has");
}

#[test]
fn a_value_is_per_message_follows_it_into_another_folder_and_must_fit_the_field() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    add_account(&c, "acc_b", "imap");
    add_row(&c, "acc_a", "INBOX", 1, "<one@x>");
    add_row(&c, "acc_a", "Archive", 9, "one@x");
    add_row(&c, "acc_a", "INBOX", 2, "<two@x>");
    add_row(&c, "acc_b", "INBOX", 1, "<one@x>");
    save(&e, priority("acc_a"));
    save(&e, json!({ "id": "due", "scope": "*", "name": "Due", "kind": "date" }));
    save(&e, json!({ "id": "done", "scope": "*", "name": "Done", "kind": "checkbox" }));
    save(&e, json!({ "id": "many", "scope": "*", "name": "Many", "kind": "multi_select", "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }] }));
    save(&e, json!({ "id": "note", "scope": "*", "name": "Note", "kind": "text" }));

    let set = |item: Value, field: &str, value: Value| e.rpc("mobile.fields.set", json!({ "item": item, "fieldId": field, "value": value }));
    set(item("acc_a", "INBOX", 1), "f-acc_a", json!("hi")).unwrap();
    set(item("acc_a", "INBOX", 1), "due", json!("2026-11-30")).unwrap();
    set(item("acc_a", "INBOX", 1), "done", json!(true)).unwrap();
    set(item("acc_a", "INBOX", 1), "many", json!(["b", "a", "b"])).unwrap();
    set(item("acc_a", "INBOX", 1), "note", json!("  call back  ")).unwrap();

    let got = values(&e, vec![item("acc_a", "INBOX", 1), item("acc_a", "Archive", 9), item("acc_a", "INBOX", 2), item("acc_b", "INBOX", 1), item("acc_a", "INBOX", 404)]);
    assert_eq!(got[0], json!({ "f-acc_a": "hi", "due": "2026-11-30", "done": true, "many": ["b", "a"], "note": "call back" }));
    assert_eq!(got[1], got[0], "the same message in another folder");
    assert_eq!(got[2], json!({}));
    assert_eq!(got[3], json!({}), "the same message in another account is another message");
    assert_eq!(got[4], json!({}), "a row the phone does not hold");

    // Answers that do not fit.
    assert!(set(item("acc_a", "INBOX", 2), "f-acc_a", json!("medium")).is_err(), "not a choice");
    assert!(set(item("acc_a", "INBOX", 2), "due", json!("30/11/2026")).is_err(), "not YYYY-MM-DD");
    assert!(set(item("acc_a", "INBOX", 2), "done", json!("yes")).is_err());
    assert!(set(item("acc_a", "INBOX", 2), "note", json!("x".repeat(501))).is_err());
    assert!(set(item("acc_b", "INBOX", 1), "f-acc_a", json!("hi")).is_err(), "another account's field");
    assert!(set(item("acc_a", "INBOX", 404), "note", json!("x")).is_err(), "a row the phone does not hold");
    assert!(e.rpc("mobile.fields.set", json!({ "item": item("acc_a", "INBOX", 1), "fieldId": "note" })).is_err(), "no value at all is refused");
    assert_eq!(values(&e, vec![item("acc_a", "INBOX", 1)])[0]["note"], "call back", "and clears nothing");

    // Clearing: null, an empty answer.
    set(item("acc_a", "INBOX", 1), "note", Value::Null).unwrap();
    set(item("acc_a", "INBOX", 1), "f-acc_a", json!("")).unwrap();
    set(item("acc_a", "INBOX", 1), "many", json!([])).unwrap();
    assert_eq!(values(&e, vec![item("acc_a", "INBOX", 1)])[0], json!({ "due": "2026-11-30", "done": true }));

    let usage = e.rpc("mobile.fields.optionUsage", json!({ "fieldId": "many" })).unwrap();
    assert_eq!(usage["usage"], json!({}));
    set(item("acc_a", "INBOX", 2), "many", json!(["a"])).unwrap();
    assert_eq!(e.rpc("mobile.fields.optionUsage", json!({ "fieldId": "many" })).unwrap()["usage"], json!({ "a": 1 }));
    assert_eq!(e.rpc("mobile.fields.delete", json!({ "id": "many" })).unwrap()["droppedValues"], 1);
}

/// A Graph message without a Message-ID is keyed by its remote id: a resync that renumbers the
/// phone's uid keeps its value.
#[test]
fn a_graph_value_without_a_message_id_survives_a_new_uid() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_g", "graph");
    add_row(&c, "acc_g", "Inbox", 5, "");
    c.execute("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES ('acc_g', 'Inbox', 5, 'AAMk1')", []).unwrap();
    save(&e, json!({ "id": "note", "scope": "*", "name": "Note", "kind": "text" }));
    e.rpc("mobile.fields.set", json!({ "item": item("acc_g", "Inbox", 5), "fieldId": "note", "value": "kept" })).unwrap();
    c.execute("DELETE FROM messages WHERE uid = 5", []).unwrap();
    c.execute("DELETE FROM remote_ids WHERE uid = 5", []).unwrap();
    add_row(&c, "acc_g", "Inbox", 6, "");
    c.execute("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES ('acc_g', 'Inbox', 6, 'AAMk1')", []).unwrap();
    assert_eq!(values(&e, vec![item("acc_g", "Inbox", 6)])[0], json!({ "note": "kept" }));
}

#[test]
fn a_removed_account_takes_its_values_and_its_own_fields() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    add_account(&c, "acc_a", "imap");
    add_account(&c, "acc_b", "imap");
    add_row(&c, "acc_b", "INBOX", 1, "<one@x>");
    save(&e, priority("acc_a"));
    save(&e, json!({ "id": "g1", "scope": "*", "name": "Owner", "kind": "text" }));
    e.rpc("mobile.fields.set", json!({ "item": item("acc_b", "INBOX", 1), "fieldId": "g1", "value": "Bo" })).unwrap();
    e.rpc("mobile.accounts.remove", json!({ "accountId": "acc_a" })).unwrap();
    assert_eq!(names(&e, "acc_a"), vec!["Owner"], "its own field went, the shared one stays");
    assert_eq!(values(&e, vec![item("acc_b", "INBOX", 1)])[0], json!({ "g1": "Bo" }), "another account keeps its values");
}
