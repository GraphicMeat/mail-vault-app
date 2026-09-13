use mailvault_core::custody::{db, entries, lock};

#[test]
fn status_reports_closed_then_open_then_the_open_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let st = crate::custody::CustodyState::default();
    let s = crate::custody::status_json(&st);
    assert_eq!((s["available"].as_bool(), s["error"].is_null(), s["path"].is_null()), (Some(false), true, true));

    *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
    *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
    let s = crate::custody::status_json(&st);
    assert_eq!(s["available"], true);
    assert_eq!(s["path"], db::db_path(tmp.path()).display().to_string());

    *lock(&st.db) = None;
    *st.error.lock().unwrap() = Some("custody store unreadable: file is not a database".into());
    let s = crate::custody::status_json(&st);
    assert_eq!(s["available"], false);
    assert_eq!(s["error"], "custody store unreadable: file is not a database");
    assert_eq!(s["path"], db::db_path(tmp.path()).display().to_string(), "the banner names the file");

    // A vault switch closes the store: the failure that belonged to the old
    // root must not be reported against the one being switched to.
    crate::custody::close_state(&st);
    let s = crate::custody::status_json(&st);
    assert_eq!((s["available"].as_bool(), s["error"].is_null(), s["path"].is_null()), (Some(false), true, true));
}

#[test]
fn the_read_command_shape_matches_the_file_it_replaces() {
    // `local_index_read` returned the file's text or None; the store returns the
    // same array text (uid order) or None, so the 17 JS readers see no change.
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    assert_eq!(entries::read(&conn, "acct", "INBOX").unwrap(), None);
    let entry = serde_json::json!({"uid": 7, "source": "local_draft", "flags": ["draft", "seen"], "inReplyTo": "<x@y>"});
    entries::upsert(&conn, "acct", "INBOX", &[entry.clone()]).unwrap();
    let text = entries::read(&conn, "acct", "INBOX").unwrap().unwrap();
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed, vec![entry]);
}
