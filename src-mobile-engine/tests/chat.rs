//! The chat view (`viewStyle` chat, desktop's Settings > Appearance > Mail view): the folder's
//! mail by person (`mobile.chat.people`), the other party of each message as desktop's
//! `getCorrespondent` reads it (the sender, or the first recipient when the sender is one of the
//! account's own addresses), then one person's conversations (`mobile.chat.topics`), the folder's
//! conversations that hold a message of theirs.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use rusqlite::Connection;
use serde_json::{json, Value};
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

fn add_account(c: &Connection, id: &str, email: &str) {
    c.execute(
        "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
         VALUES (?1, ?2, ?1, 'imap.example.test', 993, 'ssl', 1)",
        [id, email],
    )
    .unwrap();
    c.execute("INSERT INTO folders (account_id, path, name, special_use) VALUES (?1, 'INBOX', 'INBOX', NULL)", [id]).unwrap();
}

struct Msg<'a> {
    uid: i64,
    date_ms: i64,
    from: (&'a str, &'a str),
    to: &'a [(&'a str, &'a str)],
    subject: &'a str,
    message_id: &'a str,
    references: &'a [&'a str],
    seen: bool,
}

const MSG: Msg<'static> =
    Msg { uid: 0, date_ms: 0, from: ("", ""), to: &[], subject: "", message_id: "", references: &[], seen: true };

fn add(c: &Connection, account: &str, m: Msg<'_>) {
    let thread = json!({ "cc": [], "replyTo": [], "references": m.references, "inReplyTo": null, "date": null });
    let to: Vec<Value> = m.to.iter().map(|(n, a)| json!({ "name": n, "address": a })).collect();
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments,
          message_id, to_json, thread_json)
         VALUES (?1, 'INBOX', ?2, ?3, ?4, ?5, ?6, '', ?7, 0, 0, ?8, ?9, ?10)",
        (
            account,
            m.uid,
            m.subject,
            m.from.0,
            m.from.1,
            m.date_ms,
            m.seen as i64,
            m.message_id,
            Value::Array(to).to_string(),
            thread.to_string(),
        ),
    )
    .unwrap();
}

fn people(e: &Engine, account: &str) -> Vec<Value> {
    let r = e.rpc("mobile.chat.people", json!({ "accountId": account, "folder": "INBOX" })).unwrap();
    r["people"].as_array().unwrap().clone()
}

fn topics(e: &Engine, account: &str, email: &str) -> Vec<Value> {
    let r = e.rpc("mobile.chat.topics", json!({ "accountId": account, "folder": "INBOX", "email": email })).unwrap();
    r["rows"].as_array().unwrap().clone()
}

/// Me is me@example.test, with an alias alias@example.test (account setting `aliases`).
/// Ann writes "Plans" (1), I answer from my alias (2), she answers again (3, unread). Bob writes
/// "Hello" (4, unread). I write to Ann a new "Lunch" from my login (5).
fn seed(e: &Engine, c: &Connection) {
    add_account(c, "a", "me@example.test");
    e.rpc("mobile.accountSettings.set", json!({ "accountId": "a", "values": { "aliases": [{ "address": "Alias@Example.test", "name": "Me" }] } }))
        .unwrap();
    let me = ("Me", "me@example.test");
    let alias = ("Me", "alias@example.test");
    let ann = ("Ann Lee", "ann@example.test");
    add(c, "a", Msg { uid: 1, date_ms: 10 * DAY, from: ann, to: &[me], subject: "Plans", message_id: "<1@x>", ..MSG });
    add(c, "a", Msg { uid: 2, date_ms: 11 * DAY, from: alias, to: &[ann], subject: "Re: Plans", message_id: "<2@x>", references: &["<1@x>"], ..MSG });
    add(c, "a", Msg { uid: 3, date_ms: 12 * DAY, from: ("ann", "ANN@example.test"), to: &[me], subject: "Re: Plans", message_id: "<3@x>", references: &["<1@x>", "<2@x>"], seen: false, ..MSG });
    add(c, "a", Msg { uid: 4, date_ms: 13 * DAY, from: ("", "bob@example.test"), to: &[me], subject: "Hello", message_id: "<4@x>", seen: false, ..MSG });
    add(c, "a", Msg { uid: 5, date_ms: 9 * DAY, from: me, to: &[ann, ("", "cc@example.test")], subject: "Lunch", message_id: "<5@x>", ..MSG });
}

#[test]
fn people_are_grouped_by_the_other_party_newest_first() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    seed(&e, &c);

    let p = people(&e, "a");
    let emails: Vec<&str> = p.iter().map(|x| x["email"].as_str().unwrap()).collect();
    assert_eq!(emails, vec!["bob@example.test", "ann@example.test"], "{p:?}");

    let bob = &p[0];
    assert_eq!(bob["name"], "bob", "an address alone is named by its local part: {bob}");
    assert_eq!(bob["count"], 1);
    assert_eq!(bob["unread"], 1);

    let ann = &p[1];
    assert_eq!(ann["count"], 4, "her mail, the alias's reply and the login's message: {ann}");
    assert_eq!(ann["unread"], 1);
    assert_eq!(ann["name"], "Ann Lee", "a full name wins over a bare one");
    assert_eq!(ann["lastDateMs"], 12 * DAY);
    assert_eq!(ann["lastSubject"], "Re: Plans");
}

#[test]
fn topics_are_the_conversations_holding_that_persons_mail() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    seed(&e, &c);

    let rows = topics(&e, "a", "Ann@Example.test");
    let uids: Vec<i64> = rows.iter().map(|r| r["uid"].as_i64().unwrap()).collect();
    assert_eq!(uids, vec![3, 5], "newest conversation first, each as its newest row: {rows:?}");
    assert_eq!(rows[0]["threadCount"], 3);
    assert_eq!(rows[0]["threadUids"], json!([3, 2, 1]));
    assert!(rows[1].get("threadCount").is_none(), "one message is the plain row");

    assert_eq!(topics(&e, "a", "bob@example.test").len(), 1);
    assert!(topics(&e, "a", "nobody@example.test").is_empty());
}

#[test]
fn a_deleted_message_leaves_the_people_list() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let c = db(tmp.path());
    seed(&e, &c);
    c.execute("UPDATE messages SET local_deleted = 1 WHERE uid = 4", []).unwrap();
    let p = people(&e, "a");
    assert_eq!(p.len(), 1, "{p:?}");
    assert_eq!(p[0]["email"], "ann@example.test");
}

#[test]
fn chat_needs_an_account_and_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    assert!(e.rpc("mobile.chat.people", json!({ "accountId": "a" })).is_err());
    assert!(e.rpc("mobile.chat.topics", json!({ "accountId": "a", "folder": "INBOX" })).is_err());
}
