use mailvault_core::custody::{cache, db};
use serde_json::{json, Value};

fn parsed(text: Option<String>) -> Value {
    serde_json::from_str(&text.expect("cache row")).unwrap()
}

#[test]
fn sql_header_cache_round_trips_partial_rows_and_removes_deleted_uids() {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    cache::save_headers(&conn, "acct", "INBOX", &json!({
        "emails": [
            {"uid": 7, "date": "2026-09-18T10:00:00Z", "subject": "old"},
            {"uid": 9, "date": "2026-09-20T10:00:00Z", "subject": "new"}
        ],
        "totalEmails": 2, "uidValidity": 44, "lastSynced": 1000
    }).to_string()).unwrap();

    let partial = parsed(cache::load_headers(&conn, "acct", "INBOX", Some(1)).unwrap());
    assert_eq!(partial["emails"][0]["uid"], 9);
    assert_eq!(partial["totalCached"], 2);
    assert_eq!(partial["uidValidity"], 44);

    cache::save_headers(&conn, "acct", "INBOX", &json!({
        "emails": [], "totalEmails": 1, "removedUids": [9]
    }).to_string()).unwrap();
    let all = parsed(cache::load_headers(&conn, "acct", "INBOX", None).unwrap());
    assert_eq!(all["emails"].as_array().unwrap().iter().map(|v| v["uid"].as_u64().unwrap()).collect::<Vec<_>>(), vec![7]);
    assert_eq!(cache::load_by_uids(&conn, "acct", "INBOX", &[9]).unwrap(), Vec::<Value>::new());
}

#[test]
fn sql_mailbox_cache_round_trips_and_deletes_one_account_only() {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    cache::save_mailboxes(&conn, "a", "{\"mailboxes\":[{\"path\":\"INBOX\"}]}").unwrap();
    cache::save_mailboxes(&conn, "b", "[]").unwrap();
    assert!(cache::load_mailboxes(&conn, "a").unwrap().unwrap().contains("INBOX"));
    cache::delete_mailboxes(&conn, "a").unwrap();
    assert_eq!(cache::load_mailboxes(&conn, "a").unwrap(), None);
    assert_eq!(cache::load_mailboxes(&conn, "b").unwrap().as_deref(), Some("[]"));
}

#[test]
fn cached_uid_change_listing_uses_sql_write_times() {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    cache::save_headers_at(&conn, "a", "INBOX", &json!({"emails":[{"uid":1},{"uid":2}]}).to_string(), 500).unwrap();
    cache::save_headers_at(&conn, "a", "INBOX", &json!({"emails":[{"uid":2,"flags":["\\Seen"]}]}).to_string(), 900).unwrap();
    assert_eq!(cache::list_uids(&conn, "a", "INBOX", Some(700.0)).unwrap(), json!({"uids":[1,2],"changed":[2]}));
}
