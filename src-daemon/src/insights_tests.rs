use super::*;
use serde_json::json;
use std::{fs, io::Cursor, path::PathBuf};
fn write(root: &Path, name: &str, value: Value) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, value.to_string()).unwrap();
    path
}
fn account() -> Vec<String> {
    vec!["account-a".into(), "account-b".into()]
}
fn header(uid: u32) -> Value {
    json!({"uid":uid,"messageId":format!("<m{uid}@test>"),"from":{"address":"ana@example.test"},"subject":"fixture","date":"Tue, 08 Sep 2026 23:00:00 +0000","internalDate":"2026-09-09T00:30:00Z"})
}
fn folder(root: &Path) -> PathBuf {
    write(
        root,
        "mailboxes/account-a/mailboxes.json",
        json!({"mailboxes":[{"path":"INBOX","specialUse":"\\Inbox","children":[]}],"fetchedAt":1720000000000_i64}),
    );
    write(
        root,
        "email_cache/account_a_INBOX/_meta.json",
        json!({"totalEmails":1500,"uidValidity":4,"lastSynced":1720000000000_i64}),
    );
    root.join("email_cache/account_a_INBOX")
}
fn store(root: &Path) -> mailvault_core::custody::SharedConn {
    std::sync::Mutex::new(Some(mailvault_core::custody::db::open(root).unwrap()))
}
fn seed(
    custody: &mailvault_core::custody::SharedConn,
    account: &str,
    mailbox: &str,
    rows: Vec<Value>,
) {
    let guard = mailvault_core::custody::lock(custody);
    mailvault_core::custody::entries::upsert(guard.as_ref().unwrap(), account, mailbox, &rows)
        .unwrap();
}
/// The in-memory stand-in for the daemon's in-process custody read (Task
/// 3.6): production reads the store through `crate::custody::with_conn` +
/// `entries_for_account`, these tests read a `SharedConn` they own directly.
/// A closed store is an `Err`, never empty rows — that distinction is what
/// `unreadableLocation` is for.
fn rows(custody: &mailvault_core::custody::SharedConn) -> impl Fn(&str) -> Result<Vec<(String, Value)>, String> + '_ {
    move |account: &str| {
        let guard = mailvault_core::custody::lock(custody);
        match guard.as_ref() {
            Some(conn) => mailvault_core::custody::entries::entries_for_account(conn, account)
                .map_err(|e| e.to_string()),
            None => Err("custody store unavailable: closed".to_string()),
        }
    }
}
/// `gen` stands in for the daemon's live custody write counter (Task 3.6
/// Step 4, `crate::custody::generation`): production reads it fresh at
/// every `begin`/`read` call, so these tests pass it explicitly instead of
/// going through a `DaemonState` these pure-function tests don't have. Most
/// tests never see a custody write between `begin` and `read`, so they pass
/// the same value throughout; the two that seed custody mid-test advance it
/// exactly where a real write would have bumped it.
fn begin(
    state: &InsightsSnapshots,
    root: &Path,
    custody: &mailvault_core::custody::SharedConn,
    gen: u64,
) -> Value {
    state.begin_at(root, &rows(custody), &account(), &account(), gen).unwrap()
}
fn page(state: &InsightsSnapshots, start: &Value, gen: u64) -> Value {
    state
        .read(start["snapshotId"].as_str().unwrap(), None, gen)
        .unwrap()
}
#[test]
fn insights_pages_cover_headers_beyond_the_mailbox_window() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    for uid in 1..=1201 {
        write(&cache, &format!("{uid}.json"), header(uid));
    }
    assert_eq!(
        read_header_files(&cache, &(1..=1000).collect::<Vec<_>>())
            .unwrap()
            .len(),
        1000
    );
    let tail = read_header_files(&cache, &(1001..=1201).collect::<Vec<_>>()).unwrap();
    assert_eq!(tail.len(), 201);
    assert_eq!(tail.last().unwrap()["uid"], 1201);
    let state = InsightsSnapshots::default();
    let start = begin(&state, dir.path(), &custody, 0);
    assert_eq!(start["inventoryCount"], 1201);
    let first = page(&state, &start, 0);
    assert_eq!(first["rows"].as_array().unwrap().len(), 1000);
    let last = state
        .read(
            start["snapshotId"].as_str().unwrap(),
            first["nextCursor"].as_str(),
            0,
        )
        .unwrap();
    assert_eq!(last["rows"].as_array().unwrap().len(), 201);
    assert!(last["nextCursor"].is_null());
    let f = last["coverage"]["folders"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["mailbox"] == "INBOX")
        .unwrap();
    assert_eq!(f["knownServerMessages"], 1500);
    assert_eq!(f["missingHeaders"], 299);
    assert_eq!(last["coverage"]["status"], "partial");
}
#[test]
fn insights_includes_nested_and_unselected_accounts_preserving_copy_identity() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    write(&cache, "7.json", header(7));
    seed(
        &custody,
        "account-b",
        "Projects/2026",
        vec![
            json!({"uid":9,"messageId":"<old@test>","source":"local_sent","serverAbsent":true,"date":"Tue, 08 Sep 2026 23:00:00 +0000"}),
        ],
    );
    let eml = dir
        .path()
        .join("Maildir/account-b/Projects_2026/cur/9:2,AS");
    fs::create_dir_all(eml.parent().unwrap()).unwrap();
    fs::write(
        eml,
        "From: me@example.test\r\nMessage-ID: <old@test>\r\n\r\nbody",
    )
    .unwrap();
    let saved = dir.path().join("Maildir/account-a/INBOX/cur/7:2,AS");
    fs::create_dir_all(saved.parent().unwrap()).unwrap();
    fs::write(saved,"From: ana@example.test\r\nMessage-ID: <older-than-reused-uid@test>\r\nSubject: old\r\n\r\nbody").unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    let rows = p["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let sent = rows.iter().find(|r| r["uid"] == 9).unwrap();
    assert_eq!(sent["mailbox"], "Projects/2026");
    assert_eq!(sent["origin"], "local_sent");
    assert_eq!(sent["serverAbsent"], true);
    let cache = rows.iter().find(|r| r["source"] == "server-cache").unwrap();
    assert_eq!(cache["messageId"], "<m7@test>");
    assert_eq!(cache["uidValidity"], 4);
    let saved = rows
        .iter()
        .find(|r| r["uid"] == 7 && r["source"] == "vault")
        .unwrap();
    assert_eq!(saved["messageId"], "<older-than-reused-uid@test>");
    assert!(saved["uidValidity"].is_null());
}
#[test]
fn insights_corrupt_or_missing_metadata_stays_partial_and_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    write(&cache, "1.json", header(1));
    fs::write(cache.join("_meta.json"), "broken").unwrap();
    fs::write(cache.join("2.json"), "broken").unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert_eq!(p["rows"].as_array().unwrap().len(), 1);
    assert_eq!(p["coverage"]["status"], "partial");
    assert!(p["coverage"]["folders"][0]["knownServerMessages"].is_null());
    assert!(
        p["coverage"]["warnings"]["unreadableFiles"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(!p["coverage"]["errors"].as_array().unwrap().is_empty());
    fs::remove_file(cache.join("_meta.json")).unwrap();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert!(p["coverage"]["folders"][0]["knownServerMessages"].is_null());
}
#[test]
fn insights_a_mailbox_cache_holding_only_its_uid_ledger_is_not_a_problem() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    fs::remove_file(cache.join("_meta.json")).unwrap();
    fs::write(cache.join("graph_id_map.json"), r#"{"1":"g-a"}"#).unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert!(
        p["coverage"]["errors"].as_array().unwrap().iter().all(|e| e["code"] != "unreadableLocation"),
        "{}",
        p["coverage"]
    );
    assert_eq!(p["coverage"]["warnings"]["unreadableFiles"], 0, "{}", p["coverage"]);
}
#[test]
fn insights_missing_vault_and_unconfigured_scope_fail_explicitly() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let state = InsightsSnapshots::default();
    assert_eq!(
        state
            .begin_at(&dir.path().join("missing"), &rows(&custody), &account(), &account(), 0)
            .unwrap_err()["code"],
        "vaultUnavailable"
    );
    assert_eq!(
        state
            .begin_at(dir.path(), &rows(&custody), &account(), &["../../outside".into()], 0)
            .unwrap_err()["code"],
        "invalidAccountScope"
    );
}
#[test]
fn insights_release_invalidates_snapshot_and_cursor_cannot_cross_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    for uid in 1..=1001 {
        write(&cache, &format!("{uid}.json"), header(uid));
    }
    let state = InsightsSnapshots::default();
    let a = begin(&state, dir.path(), &custody, 0);
    let p = page(&state, &a, 0);
    let b = begin(&state, dir.path(), &custody, 0);
    assert_eq!(
        state
            .read(b["snapshotId"].as_str().unwrap(), p["nextCursor"].as_str(), 0)
            .unwrap_err()["code"],
        "invalidCursor"
    );
    state.release(a["snapshotId"].as_str().unwrap());
    assert_eq!(
        state
            .read(a["snapshotId"].as_str().unwrap(), None, 0)
            .unwrap_err()["code"],
        "snapshotExpired"
    );
}
#[test]
fn insights_included_file_mutation_deletion_and_replacement_make_snapshot_stale() {
    for change in ["mutate", "delete", "replace"] {
        let dir = tempfile::tempdir().unwrap();
        let custody = store(dir.path());
        let cache = folder(dir.path());
        let path = write(&cache, "1.json", header(1));
        let state = InsightsSnapshots::default();
        let a = begin(&state, dir.path(), &custody, 0);
        match change {
            "mutate" => {
                write(&cache, "1.json", header(9));
            }
            "delete" => fs::remove_file(path).unwrap(),
            _ => {
                let replacement = write(&cache, "replacement.tmp", header(1));
                fs::rename(replacement, path).unwrap();
            }
        }
        let result = state.read(a["snapshotId"].as_str().unwrap(), None, 0);
        assert_eq!(result.unwrap_err()["code"], "snapshotStale", "{change}");
    }
}

fn eml(root: &Path, account: &str, uid: u32) -> PathBuf {
    let path = root.join(format!("Maildir/{account}/INBOX/cur/{uid}:2,S"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        format!(
            "From: ana@example.test\r\nMessage-ID: <m{uid}@test>\r\nSubject: fixture\r\n\r\nbody"
        ),
    )
    .unwrap();
    path
}

#[test]
fn insights_append_only_downloads_stay_outside_the_paged_inventory_cutoff() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    for uid in 1..=1001 {
        write(&cache, &format!("{uid}.json"), header(uid));
    }
    eml(dir.path(), "account-a", 1);
    let state = InsightsSnapshots::default();
    let mut gen = 0u64;
    let start = begin(&state, dir.path(), &custody, gen);
    assert_eq!(start["inventoryCount"], 1002);
    let first = page(&state, &start, gen);
    assert_eq!(first["rows"].as_array().unwrap().len(), 1000);

    // A normal light body fetch adds only a new cur/ file. New sidecars and
    // inventory directories likewise belong to the next explicit refresh.
    eml(dir.path(), "account-a", 2);
    write(&cache, "1002.json", header(1002));
    eml(dir.path(), "account-b", 3);
    // Custody is the exception: a write for any mailbox of any account bumps
    // the daemon's write counter (Task 3.6 Step 4) instead of touching
    // custody.db's mtime — simulated here by advancing `gen` the same way
    // `custody::with_conn` would have for a real write.
    seed(&custody, "account-b", "Archive", vec![header(4)]);
    gen += 1;
    assert_eq!(
        state
            .read(
                start["snapshotId"].as_str().unwrap(),
                first["nextCursor"].as_str(),
                gen,
            )
            .unwrap_err()["code"],
        "snapshotStale"
    );
    assert_eq!(begin(&state, dir.path(), &custody, gen)["inventoryCount"], 1006);
}

#[test]
fn insights_ignored_temporary_files_do_not_invalidate_included_headers() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    write(&cache, "1.json", header(1));
    eml(dir.path(), "account-a", 1);
    let cache_temp = write(&cache, "in-flight.tmp", json!("old"));
    let vault_temp = write(
        dir.path(),
        "Maildir/account-a/INBOX/tmp/in-flight.tmp",
        json!("old"),
    );
    let state = InsightsSnapshots::default();
    let start = begin(&state, dir.path(), &custody, 0);
    fs::write(cache_temp, "a changed temporary file").unwrap();
    fs::remove_file(vault_temp).unwrap();
    let result = page(&state, &start, 0);
    assert_eq!(result["rows"].as_array().unwrap().len(), 2);
}

#[test]
fn insights_metadata_index_and_uid_generation_changes_still_make_snapshot_stale() {
    for change in [
        "metadata",
        "index",
        "generation",
        "missing-metadata",
        "missing-generation",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let custody = store(dir.path());
        let cache = folder(dir.path());
        write(&cache, "1.json", header(1));
        let saved = eml(dir.path(), "account-a", 1);
        let generation = saved
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(".uidvalidity");
        seed(&custody, "account-a", "INBOX", vec![header(1)]);
        if change == "missing-metadata" {
            fs::remove_file(cache.join("_meta.json")).unwrap();
        }
        if change != "missing-generation" {
            fs::write(&generation, "4").unwrap();
        }
        let state = InsightsSnapshots::default();
        let mut gen = 0u64;
        let start = begin(&state, dir.path(), &custody, gen);
        match change {
            "metadata" | "missing-metadata" => {
                write(
                    &cache,
                    "_meta.json",
                    json!({"totalEmails":1500,"uidValidity":5}),
                );
            }
            "index" => {
                // A real custody write after `begin` (Task 3.6 Step 4: this
                // is what bumps the daemon's write counter in production).
                seed(&custody, "account-a", "INBOX", vec![header(1), header(2)]);
                gen += 1;
            }
            _ => fs::write(generation, "5").unwrap(),
        }
        assert_eq!(
            state
                .read(start["snapshotId"].as_str().unwrap(), None, gen)
                .unwrap_err()["code"],
            "snapshotStale",
            "{change}",
        );
    }
}

#[cfg(unix)]
#[test]
fn insights_inventory_directory_removal_replacement_and_symlinks_still_make_snapshot_stale() {
    for change in ["remove", "replace", "symlink"] {
        let dir = tempfile::tempdir().unwrap();
        let custody = store(dir.path());
        let cache = folder(dir.path());
        write(&cache, "1.json", header(1));
        // Watch an empty traversed directory as well: no included file stamp
        // can detect this directory's replacement on our behalf.
        let empty = dir.path().join("Maildir/account-a/INBOX/cur");
        fs::create_dir_all(&empty).unwrap();
        let state = InsightsSnapshots::default();
        let start = begin(&state, dir.path(), &custody, 0);
        fs::rename(&empty, empty.with_file_name("old-cur")).unwrap();
        match change {
            "replace" => fs::create_dir(&empty).unwrap(),
            "symlink" => {
                std::os::unix::fs::symlink(empty.with_file_name("old-cur"), &empty).unwrap()
            }
            _ => {}
        }
        assert_eq!(
            state
                .read(start["snapshotId"].as_str().unwrap(), None, 0)
                .unwrap_err()["code"],
            "snapshotStale",
            "{change}",
        );
    }
}
#[test]
fn insights_legacy_cache_and_unresolved_vault_folder_are_readable_without_guessing() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    write(
        dir.path(),
        "mailboxes/account-a/mailboxes.json",
        json!([{"path":"A/B"}]),
    );
    write(
        dir.path(),
        "email_cache/account_a_A_B.json",
        json!({"emails":[header(3)],"totalEmails":1}),
    );
    let eml = dir
        .path()
        .join("Maildir/account-b/Ambiguous_Name/cur/12:2,AS");
    fs::create_dir_all(eml.parent().unwrap()).unwrap();
    fs::write(eml,"From: Ana <ana@example.test>\r\nTo: me@example.test\r\nDate: Tue, 08 Sep 2026 23:00:00 +0000\r\nList-Id: <list.example.test>\r\n\r\nprivate body").unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    let rows = p["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|r| r["mailbox"] == "A/B"));
    let local = rows.iter().find(|r| r["source"] == "vault").unwrap();
    assert_eq!(local["locationLimitation"], "server-mailbox-unresolved");
    assert_eq!(local["localMailbox"], "Ambiguous_Name");
    assert_eq!(local["listId"], "<list.example.test>");
    assert_eq!(local["dateEvidence"]["received"], "rfc-date-fallback");
    assert!(!p.to_string().contains("private body"));
    assert!(!p
        .to_string()
        .contains(&dir.path().to_string_lossy().to_string()));
}
#[test]
fn insights_header_reader_stops_at_terminator_and_bounds_unterminated_headers() {
    let header = b"From: ana@example.test\r\nSubject: header\r\n\r\n";
    let mut raw = header.to_vec();
    raw.extend(vec![b'x'; 4 * 1024 * 1024]);
    let mut reader = Cursor::new(raw);
    assert_eq!(read_header_block(&mut reader).unwrap(), header);
    assert_eq!(reader.position(), header.len() as u64);
    assert!(read_header_block(&mut Cursor::new(vec![b'x'; 1024 * 1024 + 1])).is_err());
}
#[cfg(unix)]
#[test]
fn insights_skips_symlink_escapes() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let outside = tempfile::tempdir().unwrap();
    let cache = folder(dir.path());
    write(outside.path(), "1.json", header(1));
    std::os::unix::fs::symlink(outside.path().join("1.json"), cache.join("1.json")).unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert!(p["rows"].as_array().unwrap().is_empty());
    assert_eq!(p["coverage"]["status"], "partial");
}
#[test]
fn insights_abandoned_snapshots_expire_after_five_minutes() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let state = InsightsSnapshots::default();
    let start = begin(&state, dir.path(), &custody, 0);
    state.expire(std::time::Instant::now() + std::time::Duration::from_secs(301));
    assert_eq!(
        state
            .read(start["snapshotId"].as_str().unwrap(), None, 0)
            .unwrap_err()["code"],
        "snapshotExpired"
    );
}
#[test]
fn insights_only_returns_header_fields_and_never_uses_file_dates() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    write(
        &cache,
        "4.json",
        json!({"uid":4,"messageId":"<private@test>","date":"not-a-date","from":{"address":"ana@example.test","password":"secret"},"html":"secret html","text":"secret body","attachments":[{"content":"secret attachment"}],"password":"secret password","credentials":{"accessToken":"secret token"}}),
    );
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    let row = &p["rows"][0];
    assert_eq!(row["uid"], 4);
    assert!(row["receivedAt"].is_null());
    assert!(row["sentAt"].is_null());
    assert!(row["messageDate"].is_null());
    assert_eq!(
        row["dateEvidence"],
        json!({"received":"unknown","sent":"unknown"})
    );
    assert!(!p.to_string().contains("secret"));
    assert_eq!(p["coverage"]["warnings"]["unknownDates"], 1);
}
#[test]
fn insights_unmapped_cache_headers_remain_visible_with_location_limit() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    write(
        dir.path(),
        "email_cache/account_a_Ambiguous_Name/8.json",
        header(8),
    );
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert_eq!(p["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        p["rows"][0]["locationLimitation"],
        "server-mailbox-unresolved"
    );
    assert_eq!(p["coverage"]["status"], "partial");
}

#[test]
fn insights_legacy_index_only_header_keeps_snake_case_identity_and_custody() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    seed(
        &custody,
        "account-a",
        "Archive",
        vec![
            json!({"uid":17,"message_id":"<vault-only@test>","source":"local_sent","serverDeleted":true,
             "date":"Tue, 08 Sep 2026 23:00:00 +0000","from":{"address":"me@example.test"}}),
        ],
    );
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert_eq!(p["rows"][0]["messageId"], "<vault-only@test>");
    assert_eq!(p["rows"][0]["origin"], "local_sent");
    assert_eq!(p["rows"][0]["locationLimitation"], "vault-file-missing");
    assert_eq!(p["rows"][0]["serverDeleted"], true);
}

#[test]
fn insights_vault_uses_index_original_date_when_raw_header_has_none() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    seed(
        &custody,
        "account-a",
        "Sent",
        vec![
            json!({"uid":17,"messageId":"<sent@test>","source":"local_sent","date":"Tue, 08 Sep 2026 23:00:00 +0000"}),
        ],
    );
    let eml = dir.path().join("Maildir/account-a/Sent/cur/17:2,AS");
    fs::create_dir_all(eml.parent().unwrap()).unwrap();
    fs::write(
        eml,
        "From: me@example.test\r\nMessage-ID: <sent@test>\r\n\r\nbody",
    )
    .unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert_eq!(p["rows"][0]["messageDate"], "2026-09-08T23:00:00Z");
    assert_eq!(p["rows"][0]["dateEvidence"]["sent"], "rfc-date");
}

#[cfg(unix)]
#[test]
fn insights_does_not_read_symlinked_metadata_or_generation() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let outside = tempfile::tempdir().unwrap();
    let cache = folder(dir.path());
    write(&cache, "1.json", header(1));
    fs::remove_file(cache.join("_meta.json")).unwrap();
    write(
        outside.path(),
        "meta.json",
        json!({"totalEmails":987,"uidValidity":404}),
    );
    std::os::unix::fs::symlink(outside.path().join("meta.json"), cache.join("_meta.json")).unwrap();
    let folder = dir.path().join("Maildir/account-a/INBOX");
    fs::create_dir_all(folder.join("cur")).unwrap();
    fs::write(folder.join("cur/1:2,AS"), "From: a@test\r\n\r\nbody").unwrap();
    fs::write(outside.path().join("generation"), "404").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("generation"),
        folder.join(".uidvalidity"),
    )
    .unwrap();
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert!(p["coverage"]["folders"][0]["knownServerMessages"].is_null());
    assert!(p["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["uidValidity"].is_null()));
}

#[test]
fn insights_recognizes_graph_date_provenance_after_javascript_mapping() {
    let dir = tempfile::tempdir().unwrap();
    let custody = store(dir.path());
    let cache = folder(dir.path());
    write(
        &cache,
        "17.json",
        json!({"uid":17,"source":"server","provider":"graph","date":"2026-09-09T00:30:00Z","messageDate":null,
        "receivedAt":"2026-09-09T00:30:00Z","sentAt":"2026-09-08T23:30:00Z"}),
    );
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
    assert_eq!(
        p["rows"][0]["dateEvidence"],
        json!({"received":"graph-received","sent":"graph-sent"})
    );
    assert!(p["rows"][0]["messageDate"].is_null());
}

#[test]
fn insights_rejects_conflicting_index_identity_even_when_message_id_matches() {
    for (subject, from, date, message_id) in [
        (
            "Old subject",
            "current@example.test",
            "2026-09-09T12:00:00Z",
            Some("<shared@test>"),
        ),
        (
            "Current subject",
            "other@example.test",
            "2026-09-09T12:00:00Z",
            Some("<shared@test>"),
        ),
        (
            "Current subject",
            "current@example.test",
            "2026-09-08T12:00:00Z",
            Some("<shared@test>"),
        ),
        (
            "Old subject",
            "current@example.test",
            "2026-09-09T12:00:00Z",
            None,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let custody = store(dir.path());
        seed(
            &custody,
            "account-a",
            "Archive",
            vec![json!({
                "uid": 17, "messageId": message_id, "subject": subject, "from": {"address": from},
                "messageDate": date, "receivedAt": "2026-09-08T14:00:00Z", "source": "local_sent", "serverAbsent": true
            })],
        );
        let eml = dir.path().join("Maildir/account-a/Archive/cur/17:2,AS");
        fs::create_dir_all(eml.parent().unwrap()).unwrap();
        fs::write(eml, "From: current@example.test\r\nMessage-ID: <shared@test>\r\nSubject: Current subject\r\nDate: Wed, 09 Sep 2026 12:00:00 +0000\r\n\r\nbody").unwrap();
        let state = InsightsSnapshots::default();
        let p = page(&state, &begin(&state, dir.path(), &custody, 0), 0);
        let row = &p["rows"][0];
        assert!(
            row["origin"].is_null(),
            "conflicting index origin leaked: {row}"
        );
        assert_eq!(row["serverAbsent"], false);
        assert_eq!(row["receivedAt"], "2026-09-09T12:00:00Z");
        assert_eq!(p["coverage"]["status"], "partial");
    }
}

#[test]
fn a_closed_custody_store_is_an_unreadable_location_not_an_empty_one() {
    let dir = tempfile::tempdir().unwrap();
    let cache = folder(dir.path());
    write(&cache, "1.json", header(1));
    let closed: mailvault_core::custody::SharedConn = std::sync::Mutex::new(None);
    let state = InsightsSnapshots::default();
    let p = page(&state, &begin(&state, dir.path(), &closed, 0), 0);
    assert_eq!(
        p["rows"].as_array().unwrap().len(),
        1,
        "the cache still reads"
    );
    assert!(
        p["coverage"]["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["code"] == "unreadableLocation"),
        "{}",
        p["coverage"]
    );
}
