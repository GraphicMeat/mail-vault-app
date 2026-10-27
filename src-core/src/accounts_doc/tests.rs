use super::*;
use std::fs;
use std::time::Duration;

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn disk(d: &Path) -> Value {
    serde_json::from_slice(&fs::read(d.join(FILE_NAME)).unwrap()).unwrap()
}

fn seed(d: &Path, v: Value) {
    // What the app's plugin-fs writer left: two-space JSON, no lock, no sidecar.
    fs::write(d.join(FILE_NAME), serde_json::to_string_pretty(&v).unwrap()).unwrap();
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap_or("").to_string())
        .collect()
}

fn doc(d: &Path) -> JsonDoc {
    JsonDoc::open(d, SPEC)
}

fn call(doc: &JsonDoc, method: &str, params: Value) -> Result<Outcome, AccountsError> {
    run(doc, method, &params, LiveScrub::Preserve)
}

#[test]
fn p1_membership_delta_is_exact_and_ignores_scrub_and_ambiguity() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id":"a","password":"legacy"},{"id":"dup"},{"id":"dup"},{"email":"missing-id"}]),
    );
    let doc = doc(d.path());
    let out = call(
        &doc,
        "accounts.replace_all",
        json!({"entries":[{"id":"b"},{"id":"dup"}]}),
    )
    .unwrap();
    assert_eq!(
        out.membership.added,
        ["b".to_owned(), "dup".to_owned()].into()
    );
    assert_eq!(out.membership.removed, ["a".to_owned()].into());
    let skip = call(
        &doc,
        "accounts.put",
        json!({"entry":{"id":"b"},"ifAbsent":true}),
    )
    .unwrap();
    assert_eq!(skip.membership, MembershipDelta::default());
}

#[test]
fn p1_failed_write_never_exposes_speculative_membership() {
    let failed = dir();
    let doc = doc(failed.path());
    doc.fail_before_rename
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        call(&doc, "accounts.put", json!({"entry":{"id":"never"}})),
        Err(AccountsError::Io(_))
    ));
    assert!(
        !failed.path().join(FILE_NAME).exists(),
        "failed write must not expose speculative membership"
    );
}

#[test]
fn logical_key_matches_the_shared_fixture() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/account-logical-key-cases.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(
            logical_key(&case["account"]),
            case["key"].as_str().unwrap(),
            "{}",
            case["account"]
        );
    }
}

// ── the file stays the file the app wrote ───────────────────────────────────

#[test]
fn list_reads_the_apps_file_as_it_is_and_never_writes_it() {
    let d = dir();
    let legacy = json!([
        {"id": "a", "email": "a@x.test", "imapHost": "imap.x.test", "createdAt": "2026-01-01T00:00:00.000Z"},
        {"email": "no-id@x.test"},
        {"id": "a", "email": "dup@x.test"},
    ]);
    seed(d.path(), legacy.clone());
    let before = fs::read(d.path().join(FILE_NAME)).unwrap();
    let out = call(&doc(d.path()), "accounts.list", json!({})).unwrap();
    assert_eq!(
        out.reply["accounts"], legacy,
        "entries without an id and duplicates are kept as they are"
    );
    assert!(out.changed.is_none());
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), before);
}

#[test]
fn a_missing_file_lists_empty_and_is_not_created_by_a_read() {
    let d = dir();
    let out = call(&doc(d.path()), "accounts.list", json!({})).unwrap();
    assert_eq!(out.reply["accounts"], json!([]));
    assert!(!d.path().join(FILE_NAME).exists());
}

#[test]
fn writes_keep_the_array_shape_and_the_two_space_indent() {
    let d = dir();
    call(
        &doc(d.path()),
        "accounts.put",
        json!({"entry": {"id": "a", "email": "a@x.test"}}),
    )
    .unwrap();
    let text = fs::read_to_string(d.path().join(FILE_NAME)).unwrap();
    assert!(text.starts_with("[\n  {\n    \""), "{text}");
    assert_eq!(disk(d.path()), json!([{"id": "a", "email": "a@x.test"}]));
}

// ── put ─────────────────────────────────────────────────────────────────────

#[test]
fn put_merges_onto_the_entry_with_the_same_id_like_save_account() {
    let d = dir();
    seed(
        d.path(),
        json!([
            {"id": "a", "email": "a@x.test", "imapHost": "old.x.test", "previousImapHost": "older.x.test"},
            {"id": "b", "email": "b@x.test"},
        ]),
    );
    let doc = doc(d.path());
    let out = call(
        &doc,
        "accounts.put",
        json!({"entry": {"id": "a", "imapHost": "new.x.test"}}),
    )
    .unwrap();
    assert_eq!(out.changed.as_ref().unwrap().changed, vec!["a"]);
    assert_eq!(
        disk(d.path()),
        json!([
            {"id": "a", "email": "a@x.test", "imapHost": "new.x.test", "previousImapHost": "older.x.test"},
            {"id": "b", "email": "b@x.test"},
        ])
    );
    // A new id is appended; the same values again change nothing.
    call(
        &doc,
        "accounts.put",
        json!({"entries": [{"id": "c", "email": "c@x.test"}]}),
    )
    .unwrap();
    assert_eq!(ids(&disk(d.path())), vec!["a", "b", "c"]);
    let same = call(
        &doc,
        "accounts.put",
        json!({"entry": {"id": "c", "email": "c@x.test"}}),
    )
    .unwrap();
    assert!(same.changed.is_none());
}

#[test]
fn put_never_writes_a_password_or_a_token() {
    let d = dir();
    let secret = "hunter2-SECRET";
    call(
        &doc(d.path()),
        "accounts.put",
        json!({"entries": [{"id": "a", "email": "a@x.test", "password": secret, "oauth2AccessToken": secret, "oauth2RefreshToken": secret, "oauth2ExpiresAt": 5}]}),
    )
    .unwrap();
    let text = fs::read_to_string(d.path().join(FILE_NAME)).unwrap();
    assert!(!text.contains(secret), "{text}");
    assert_eq!(
        disk(d.path()),
        json!([{"id": "a", "email": "a@x.test", "oauth2ExpiresAt": 5}])
    );
}

#[test]
fn a_secret_already_in_the_file_is_left_exactly_as_it_was() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id": "a", "email": "a@x.test", "password": "legacy"}]),
    );
    call(
        &doc(d.path()),
        "accounts.put",
        json!({"entry": {"id": "a", "name": "A"}}),
    )
    .unwrap();
    assert_eq!(
        disk(d.path()),
        json!([{"id": "a", "email": "a@x.test", "password": "legacy", "name": "A"}])
    );
}

// ── legacy secrets ──────────────────────────────────────────────────────────

/// Every file this document keeps beside itself, and their text.
fn all_copies(d: &Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = fs::read_dir(d)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("accounts"))
        .map(|n| {
            (
                n.clone(),
                fs::read_to_string(d.join(&n)).unwrap_or_default(),
            )
        })
        .collect();
    out.sort();
    out
}

const LEGACY: &str = "legacy-SECRET-value";

fn legacy_file(d: &Path) {
    seed(
        d,
        json!([
            {"id": "a", "email": "a@x.test", "password": LEGACY},
            {"id": "b", "email": "b@x.test", "authType": "oauth2", "oauth2AccessToken": LEGACY, "oauth2RefreshToken": LEGACY},
            {"id": "c", "email": "c@x.test"},
        ]),
    );
}

#[test]
fn the_first_write_with_a_live_scrub_leaves_no_secret_in_the_list_or_any_backup() {
    let d = dir();
    legacy_file(d.path());
    let doc = JsonDoc::open_with(d.path(), SPEC, Duration::ZERO);
    assert_eq!(
        legacy_secrets(&list(&doc).unwrap().accounts)
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    let out = run(
        &doc,
        "accounts.put",
        &json!({"entry": {"id": "d"}}),
        LiveScrub::Preserved(&list(&doc).unwrap()),
    )
    .unwrap();
    let mut changed = out.changed.unwrap().changed;
    changed.sort();
    assert_eq!(changed, vec!["a", "b", "d"]);
    // A second write takes another backup: of the clean list, too.
    run(
        &doc,
        "accounts.put",
        &json!({"entry": {"id": "e"}}),
        LiveScrub::Preserved(&list(&doc).unwrap()),
    )
    .unwrap();
    let copies = all_copies(d.path());
    assert!(
        copies.iter().any(|(n, _)| n == &SPEC.backup_name(1)),
        "{copies:?}"
    );
    for (name, text) in &copies {
        assert!(!text.contains(LEGACY), "{name} still holds a legacy secret");
    }
    assert_eq!(ids(&disk(d.path())), vec!["a", "b", "c", "d", "e"]);
    // Even a write that changes nothing else removes them.
    legacy_file(d.path());
    let out = run(
        &doc,
        "accounts.reorder",
        &json!({"ids": ["a", "b", "c"]}),
        LiveScrub::Preserved(&list(&doc).unwrap()),
    )
    .unwrap();
    assert!(out.changed.is_some());
    assert!(!fs::read_to_string(d.path().join(FILE_NAME))
        .unwrap()
        .contains(LEGACY));
}

#[test]
fn without_a_live_scrub_the_list_keeps_its_secrets_but_no_backup_takes_them() {
    let d = dir();
    legacy_file(d.path());
    let doc = JsonDoc::open_with(d.path(), SPEC, Duration::ZERO);
    run(
        &doc,
        "accounts.put",
        &json!({"entry": {"id": "d"}}),
        LiveScrub::Preserve,
    )
    .unwrap();
    assert!(
        fs::read_to_string(d.path().join(FILE_NAME))
            .unwrap()
            .contains(LEGACY),
        "nothing is lost while the keychain may lack it"
    );
    let bak = fs::read_to_string(d.path().join(SPEC.backup_name(1))).unwrap();
    assert!(!bak.contains(LEGACY), "the backup holds no secret");
    assert_eq!(
        ids(&serde_json::from_str::<Value>(&bak).unwrap()),
        vec!["a", "b", "c"]
    );
}

#[cfg(unix)]
#[test]
fn every_file_of_the_list_is_private_to_this_user() {
    use std::os::unix::fs::PermissionsExt;
    let d = dir();
    legacy_file(d.path());
    fs::set_permissions(d.path().join(FILE_NAME), fs::Permissions::from_mode(0o644)).unwrap();
    let doc = JsonDoc::open_with(d.path(), SPEC, Duration::ZERO);
    run(
        &doc,
        "accounts.put",
        &json!({"entry": {"id": "d"}}),
        LiveScrub::Preserved(&list(&doc).unwrap()),
    )
    .unwrap();
    fs::write(d.path().join(FILE_NAME), "garbage").unwrap();
    run(
        &doc,
        "accounts.put",
        &json!({"entry": {"id": "e"}}),
        LiveScrub::Preserved(&list(&doc).unwrap()),
    )
    .unwrap();
    for name in [
        FILE_NAME.to_string(),
        SPEC.backup_name(1),
        SPEC.corrupt_name(),
        SPEC.lock_name(),
        SPEC.version_name(),
    ] {
        let mode = fs::metadata(d.path().join(&name))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "{name} is {mode:o}");
    }
}

#[test]
fn put_refuses_an_entry_without_an_id_and_writes_nothing() {
    let d = dir();
    seed(d.path(), json!([{"id": "a"}]));
    let before = fs::read(d.path().join(FILE_NAME)).unwrap();
    let doc = doc(d.path());
    for params in [
        json!({"entries": [{"id": "b"}, {"email": "x@x.test"}]}),
        json!({"entries": [{"id": ""}]}),
        json!({"entries": [{"id": 7}]}),
        json!({"entries": ["a"]}),
        json!({"entry": [1]}),
        json!({}),
    ] {
        assert_eq!(
            call(&doc, "accounts.put", params.clone()).unwrap_err(),
            AccountsError::Invalid,
            "{params}"
        );
    }
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), before);
}

#[test]
fn put_if_absent_skips_known_ids_and_known_logical_identities() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id": "a", "email": "A@x.test", "imapHost": "imap.x.test"}]),
    );
    let out = call(
        &doc(d.path()),
        "accounts.put",
        json!({"ifAbsent": true, "entries": [
            {"id": "a", "email": "changed@x.test"},
            {"id": "a2", "email": "a@x.test", "imapHost": "IMAP.x.test"},
            {"id": "b", "email": "b@x.test", "imapHost": "imap.x.test", "password": "pw"},
        ]}),
    )
    .unwrap();
    assert_eq!(out.changed.unwrap().changed, vec!["b"]);
    assert_eq!(
        disk(d.path()),
        json!([
            {"id": "a", "email": "A@x.test", "imapHost": "imap.x.test"},
            {"id": "b", "email": "b@x.test", "imapHost": "imap.x.test"},
        ])
    );
}

#[test]
fn fifty_parallel_puts_to_different_ids_all_survive() {
    let d = dir();
    seed(d.path(), json!([{"id": "existing", "email": "e@x.test"}]));
    let doc = Arc::new(JsonDoc::open(d.path(), SPEC));
    let handles: Vec<_> = (0..50)
        .map(|i| {
            let doc = Arc::clone(&doc);
            std::thread::spawn(move || {
                run(
                    &doc,
                    "accounts.put",
                    &json!({"entry": {"id": format!("acct-{i}"), "email": format!("u{i}@x.test")}}),
                    LiveScrub::Preserve,
                )
                .unwrap()
                .changed
                .unwrap()
                .version
            })
        })
        .collect();
    let mut versions: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    versions.sort();
    versions.dedup();
    assert_eq!(versions.len(), 50);
    let on_disk = ids(&disk(d.path()));
    assert_eq!(on_disk.len(), 51);
    assert!(on_disk.contains(&"existing".to_string()));
    for i in 0..50 {
        assert!(on_disk.contains(&format!("acct-{i}")), "acct-{i} lost");
    }
}

#[test]
fn parallel_puts_to_one_id_end_on_the_writer_with_the_highest_version() {
    let d = dir();
    let doc = Arc::new(JsonDoc::open(d.path(), SPEC));
    let handles: Vec<_> = (0..30)
        .map(|i| {
            let doc = Arc::clone(&doc);
            std::thread::spawn(move || {
                let v = run(
                    &doc,
                    "accounts.put",
                    &json!({"entry": {"id": "same", "n": i}}),
                    LiveScrub::Preserve,
                )
                .unwrap()
                .changed
                .map(|c| c.version);
                (i, v)
            })
        })
        .collect();
    let results: Vec<(i32, Option<u64>)> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let mut versions: Vec<u64> = results.iter().filter_map(|r| r.1).collect();
    let n = versions.len();
    versions.sort();
    versions.dedup();
    assert_eq!(
        versions.len(),
        n,
        "versions are unique, so monotonic per write"
    );
    let last = results
        .iter()
        .filter(|r| r.1.is_some())
        .max_by_key(|r| r.1)
        .unwrap()
        .0;
    assert_eq!(disk(d.path())[0]["n"], json!(last));
    assert_eq!(disk(d.path()).as_array().unwrap().len(), 1);
}

// ── remove, reorder, replace_all ────────────────────────────────────────────

#[test]
fn remove_takes_every_entry_with_the_id_and_reports_only_what_it_removed() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id": "a"}, {"id": "b"}, {"id": "a"}, {"email": "no-id"}]),
    );
    let doc = doc(d.path());
    let out = call(&doc, "accounts.remove", json!({"ids": ["a", "zz"]})).unwrap();
    assert_eq!(out.changed.unwrap().changed, vec!["a"]);
    assert_eq!(disk(d.path()), json!([{"id": "b"}, {"email": "no-id"}]));
    assert!(call(&doc, "accounts.remove", json!({"id": "zz"}))
        .unwrap()
        .changed
        .is_none());
    assert_eq!(
        call(&doc, "accounts.remove", json!({})).unwrap_err(),
        AccountsError::Invalid
    );
}

#[test]
fn reorder_puts_the_listed_ids_first_and_keeps_the_rest_in_order() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}]),
    );
    let doc = doc(d.path());
    let out = call(
        &doc,
        "accounts.reorder",
        json!({"ids": ["c", "a", "unknown"]}),
    )
    .unwrap();
    assert_eq!(out.changed.unwrap().changed, vec!["c", "a"]);
    assert_eq!(ids(&disk(d.path())), vec!["c", "a", "b", "d"]);
    assert!(call(&doc, "accounts.reorder", json!({"ids": ["c", "a"]}))
        .unwrap()
        .changed
        .is_none());
}

#[test]
fn replace_all_checks_a_supplied_version_and_strips_secrets() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id": "a", "email": "a@x.test"}, {"id": "a2", "email": "a@x.test"}]),
    );
    let doc = doc(d.path());
    let listed = call(&doc, "accounts.list", json!({})).unwrap().reply;
    let v = listed["version"].as_u64().unwrap();
    // Someone else wrote since the list was read: the cleanup is refused.
    call(&doc, "accounts.put", json!({"entry": {"id": "b"}})).unwrap();
    let stale = call(
        &doc,
        "accounts.replace_all",
        json!({"entries": [{"id": "a"}], "baseVersion": v}),
    )
    .unwrap_err();
    assert!(matches!(stale, AccountsError::Conflict { .. }));
    assert_eq!(ids(&disk(d.path())), vec!["a", "a2", "b"]);
    let now = call(&doc, "accounts.list", json!({})).unwrap().reply["version"]
        .as_u64()
        .unwrap();
    let out = call(
        &doc,
        "accounts.replace_all",
        json!({"entries": [{"id": "a", "email": "a@x.test", "password": "pw"}, {"id": "b"}], "baseVersion": now}),
    )
    .unwrap();
    assert_eq!(out.changed.unwrap().changed, vec!["a2"]);
    assert_eq!(
        disk(d.path()),
        json!([{"id": "a", "email": "a@x.test"}, {"id": "b"}])
    );
}

#[test]
fn get_answers_the_first_entry_with_the_id_or_null() {
    let d = dir();
    seed(d.path(), json!([{"id": "a", "n": 1}, {"id": "a", "n": 2}]));
    let doc = doc(d.path());
    assert_eq!(
        call(&doc, "accounts.get", json!({"id": "a"}))
            .unwrap()
            .reply["account"],
        json!({"id": "a", "n": 1})
    );
    assert_eq!(
        call(&doc, "accounts.get", json!({"id": "zz"}))
            .unwrap()
            .reply["account"],
        Value::Null
    );
    assert_eq!(
        call(&doc, "accounts.get", json!({})).unwrap_err(),
        AccountsError::Invalid
    );
}

// ── crash safety, broken files, backups ─────────────────────────────────────

#[test]
fn a_crash_before_the_rename_leaves_every_account_in_place() {
    let d = dir();
    seed(d.path(), json!([{"id": "a"}, {"id": "b"}]));
    let doc = doc(d.path());
    doc.fail_before_rename
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let err = call(&doc, "accounts.remove", json!({"ids": ["a", "b"]})).unwrap_err();
    assert_eq!(err.catalog_key(), "errors.accountsWriteFailed");
    assert_eq!(ids(&disk(d.path())), vec!["a", "b"]);
}

#[test]
fn a_broken_file_is_listed_from_the_newest_backup_and_kept_aside_on_write() {
    let d = dir();
    {
        let doc = JsonDoc::open_with(d.path(), SPEC, Duration::ZERO);
        call(&doc, "accounts.put", json!({"entry": {"id": "a"}})).unwrap();
        call(&doc, "accounts.put", json!({"entry": {"id": "b"}})).unwrap();
    }
    // A crash under the old non-atomic writer: half a file.
    fs::write(d.path().join(FILE_NAME), "[\n  {\n    \"id\": \"a\"").unwrap();
    let doc = doc(d.path());
    let listed = call(&doc, "accounts.list", json!({})).unwrap().reply;
    assert_eq!(listed["recovered"], json!(SPEC.backup_name(1)));
    assert_eq!(ids(&listed["accounts"]), vec!["a"]);
    call(&doc, "accounts.put", json!({"entry": {"id": "c"}})).unwrap();
    assert_eq!(ids(&disk(d.path())), vec!["a", "c"]);
    assert_eq!(
        fs::read(d.path().join(SPEC.corrupt_name())).unwrap(),
        b"[\n  {\n    \"id\": \"a\""
    );
}

#[test]
fn an_object_on_disk_is_broken_not_an_account_list() {
    let d = dir();
    fs::write(d.path().join(FILE_NAME), "{\"accounts\": []}").unwrap();
    let listed = call(&doc(d.path()), "accounts.list", json!({}))
        .unwrap()
        .reply;
    assert_eq!(listed["accounts"], json!([]));
    assert_eq!(listed["recovered"], json!("empty"));
}

#[test]
fn an_unreadable_file_fails_the_write_and_never_replaces_it() {
    let d = dir();
    // A directory at the file's path: readable as nothing, so nothing is written.
    fs::create_dir(d.path().join(FILE_NAME)).unwrap();
    let doc = doc(d.path());
    assert!(matches!(
        call(&doc, "accounts.list", json!({})).unwrap_err(),
        AccountsError::Io(_)
    ));
    assert!(matches!(
        call(&doc, "accounts.put", json!({"entry": {"id": "a"}})).unwrap_err(),
        AccountsError::Io(_)
    ));
    assert!(d.path().join(FILE_NAME).is_dir());
}

#[test]
fn errors_name_catalog_keys() {
    assert_eq!(
        AccountsError::Conflict { current: 1 }.catalog_key(),
        "errors.accountsConflict"
    );
    assert_eq!(
        AccountsError::Invalid.catalog_key(),
        "errors.accountsInvalid"
    );
    assert_eq!(
        AccountsError::Io("x".into()).catalog_key(),
        "errors.accountsWriteFailed"
    );
}

#[test]
fn the_module_logs_no_account_field() {
    let src = include_str!("../accounts_doc.rs");
    let code = &src[..src.find("#[cfg(test)]").unwrap()];
    for line in code.lines().filter(|l| {
        l.contains("info!") || l.contains("warn!") || l.contains("error!") || l.contains("debug!")
    }) {
        panic!("accounts_doc logs: {line}");
    }
}

#[test]
fn changed_recovery_at_the_same_version_is_refused() {
    let d = dir();
    fs::write(d.path().join(FILE_NAME), "broken").unwrap();
    seed_backup(d.path(), json!([{"id":"a", "password":"only-A"}]));
    let doc = doc(d.path());
    let proof = list(&doc).unwrap();
    seed_backup(d.path(), json!([{"id":"b", "password":"only-B"}]));
    assert_eq!(
        list(&doc).unwrap().version,
        proof.version,
        "actual recovery keeps version"
    );
    let result = run(
        &doc,
        "accounts.put",
        &json!({"entry":{"id":"x"}}),
        LiveScrub::Preserved(&proof),
    );
    assert!(matches!(result, Err(AccountsError::Conflict { .. })));
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), b"broken");
}
fn seed_backup(d: &Path, value: Value) {
    fs::write(d.join(SPEC.backup_name(1)), value.to_string()).unwrap();
}

#[test]
fn proof_checks_full_values_even_when_the_version_matches() {
    let d = dir();
    seed(d.path(), json!([{"id":"a", "password":"only-A"}]));
    let doc = doc(d.path());
    let mut proof = list(&doc).unwrap();
    proof.accounts[0]["extra"] = json!("not-preserved");
    assert!(matches!(
        run(
            &doc,
            "accounts.put",
            &json!({"entry":{"id":"x"}}),
            LiveScrub::Preserved(&proof)
        ),
        Err(AccountsError::Conflict { .. })
    ));
    assert!(disk(d.path())[0].get("password").is_some());
    assert!(!d.path().join(SPEC.backup_name(1)).exists());
}

#[test]
fn s24_fenced_proof_checks_commit_without_scrubbing_legacy_secrets() {
    let d = dir();
    seed(d.path(), json!([{"id":"a","password":"legacy"}]));
    let doc = doc(d.path());
    let proof = list(&doc).unwrap();
    run(&doc, "accounts.put", &json!({"entry":{"id":"b"}}),
        LiveScrub::Fenced(&proof)).unwrap();
    let after = disk(d.path());
    assert_eq!(after[0]["password"], "legacy");
    assert_eq!(authoritative_ids(after.as_array().unwrap()),
        ["a".to_owned(), "b".to_owned()].into());
    let stale = run(&doc, "accounts.replace_all",
        &json!({"entries":[{"id":"a"}]}), LiveScrub::Fenced(&proof));
    assert!(matches!(stale, Err(AccountsError::Conflict { .. })));
    assert_eq!(disk(d.path()), after);
}
#[test]
fn proof_rejects_stale_caller_base_without_substitution() {
    let d = dir();
    let doc = doc(d.path());
    call(&doc, "accounts.put", json!({"entry":{"id":"a"}})).unwrap();
    let old = list(&doc).unwrap();
    call(&doc, "accounts.put", json!({"entry":{"id":"b"}})).unwrap();
    let fresh = list(&doc).unwrap();
    assert!(matches!(
        run(
            &doc,
            "accounts.put",
            &json!({"entry":{"id":"x"}, "baseVersion":old.version}),
            LiveScrub::Preserved(&fresh)
        ),
        Err(AccountsError::Conflict { .. })
    ));
    let out = run(
        &doc,
        "accounts.put",
        &json!({"entry":{"id":"x"}, "baseVersion":fresh.version}),
        LiveScrub::Preserved(&fresh),
    )
    .unwrap();
    assert_eq!(out.reply["changed"], json!(["x"]));
}
#[test]
fn proof_detects_missed_good_writes_and_same_byte_aba_sidecars() {
    let d = dir();
    let first = doc(d.path());
    call(&first, "accounts.put", json!({"entry":{"id":"a"}})).unwrap();
    let proof = list(&first).unwrap();
    let bytes = fs::read(d.path().join(FILE_NAME)).unwrap();
    let other = doc(d.path());
    call(&other, "accounts.put", json!({"entry":{"id":"b"}})).unwrap();
    assert!(matches!(
        run(
            &first,
            "accounts.put",
            &json!({"entry":{"id":"x"}}),
            LiveScrub::Preserved(&proof)
        ),
        Err(AccountsError::Conflict { .. })
    ));
    let proof_b = list(&first).unwrap();
    call(&other, "accounts.remove", json!({"id":"b"})).unwrap();
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), bytes);
    assert!(matches!(
        run(
            &first,
            "accounts.put",
            &json!({"entry":{"id":"x"}}),
            LiveScrub::Preserved(&proof)
        ),
        Err(AccountsError::Conflict { .. })
    ));
    assert!(matches!(
        run(
            &first,
            "accounts.put",
            &json!({"entry":{"id":"x"}}),
            LiveScrub::Preserved(&proof_b)
        ),
        Err(AccountsError::Conflict { .. })
    ));
    assert_eq!(ids(&disk(d.path())), vec!["a"]);
}
#[test]
fn replace_all_accepts_omitted_base_and_preserve_allows_explicit_removal() {
    let d = dir();
    seed(d.path(), json!([{"id":"a", "password":"old"}]));
    let doc = doc(d.path());
    call(
        &doc,
        "accounts.replace_all",
        json!({"entries":[{"id":"b", "password":"incoming"}]}),
    )
    .unwrap();
    assert_eq!(disk(d.path()), json!([{"id":"b"}]));
    call(&doc, "accounts.remove", json!({"id":"b"})).unwrap();
    assert_eq!(disk(d.path()), json!([]));
}

#[test]
fn legacy_map_representability_requires_unique_nonempty_ids_only_for_secrets() {
    for bad in [
        json!([{"password":"secret"}]),
        json!([{"id":"", "password":"secret"}]),
        json!([{"id":7, "password":"secret"}]),
        json!([{"id":"a","password":"secret"},{"id":"a"}]),
    ] {
        assert!(!legacy_secrets_representable(bad.as_array().unwrap()));
    }
    assert!(legacy_secrets_representable(
        json!([{"id":"a","password":"secret"},{"id":"b"}])
            .as_array()
            .unwrap()
    ));
    assert!(legacy_secrets_representable(
        json!([{"id":"a"},{"id":"a"},{"password":null}])
            .as_array()
            .unwrap()
    ));
}

#[test]
fn review_fix_anonymous_empty_replacement_commits_without_public_ids() {
    for legacy in [
        json!([{"password":"only-secret"}]),
        json!([{"id":7,"password":"only-secret"}]),
        json!([{"name":"legacy"}]),
        json!([17]),
        json!([{"id":"","password":"only-secret"}]),
    ] {
        let d = dir();
        seed(d.path(), legacy);
        let doc = doc(d.path());
        let version = list(&doc).unwrap().version;
        let out = call(&doc, "accounts.replace_all", json!({"entries":[]})).unwrap();
        assert_eq!(disk(d.path()), json!([]));
        assert!(out.reply["version"].as_u64().unwrap() > version);
        assert_eq!(out.reply["changed"], json!([]));
        assert!(out.changed.as_ref().unwrap().changed.is_empty());
        let bytes = fs::read(d.path().join(FILE_NAME)).unwrap();
        let again = call(&doc, "accounts.replace_all", json!({"entries":[]})).unwrap();
        assert_eq!(again.reply, out.reply);
        assert!(again.changed.is_none());
        assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), bytes);
    }
}
#[test]
fn review_fix_if_absent_excludes_same_id_inside_one_batch() {
    let d = dir();
    let doc = doc(d.path());
    let out = call(&doc, "accounts.put", json!({"ifAbsent":true,"entries":[{"id":"a","email":"first@x.test","name":"first"},{"id":"a","email":"other@x.test","name":"second"}]})).unwrap();
    assert_eq!(
        disk(d.path()),
        json!([{"id":"a","email":"first@x.test","name":"first"}])
    );
    assert_eq!(out.reply["changed"], json!(["a"]));
}
#[test]
fn review_fix_if_absent_excludes_same_logical_key_inside_one_batch() {
    let d = dir();
    let doc = doc(d.path());
    let out = call(&doc, "accounts.put", json!({"ifAbsent":true,"entries":[{"id":"a","email":"Me@x.test","imapHost":"IMAP.X.TEST"},{"id":"b","email":"me@x.test","imapHost":"imap.x.test"}]})).unwrap();
    assert_eq!(
        disk(d.path()),
        json!([{"id":"a","email":"Me@x.test","imapHost":"IMAP.X.TEST"}])
    );
    assert_eq!(out.reply["changed"], json!(["a"]));
}
#[test]
fn review_fix_if_absent_distinct_batch_preserves_legacy_and_existing_precedence() {
    let d = dir();
    let legacy = json!([{"id":"legacy","email":"old@x.test","n":1},{"id":"legacy","email":"old@x.test","n":2}]);
    seed(d.path(), legacy.clone());
    let doc = doc(d.path());
    let out = call(&doc, "accounts.put", json!({"ifAbsent":true,"entries":[{"id":"legacy","email":"overwrite@x.test","n":3},{"id":"b","email":"b@x.test"},{"id":"c","email":"c@x.test"}]})).unwrap();
    assert_eq!(out.reply["changed"], json!(["b", "c"]));
    let rows = list(&doc).unwrap().accounts;
    assert_eq!(&rows[..2], legacy.as_array().unwrap().as_slice());
    assert_eq!(
        rows[2..],
        [
            json!({"id":"b","email":"b@x.test"}),
            json!({"id":"c","email":"c@x.test"})
        ]
    );
}

#[test]
fn prepared_rows_replace_only_targets_clear_fields_and_keep_full_proof() {
    let d = dir();
    seed(
        d.path(),
        json!([{"id":"a","email":"a@example.test","imapHost":"h","oauth2ClientId":"old"},{"id":"b","email":"b@example.test","imapHost":"h","enabled":false}]),
    );
    let doc = doc(d.path());
    let proof = list(&doc).unwrap();
    commit_prepared(
        &doc,
        &proof,
        &[json!({"id":"a","email":"a@example.test","imapHost":"h","sentFolderOverride":null})],
    )
    .unwrap();
    let saved = disk(d.path());
    assert!(saved[0].get("oauth2ClientId").is_none());
    assert_eq!(saved[1], proof.accounts[1]);
    assert!(matches!(
        commit_prepared(&doc, &proof, &[]),
        Err(AccountsError::Conflict { .. })
    ));
    let proof = list(&doc).unwrap();
    assert!(matches!(
        commit_prepared(
            &doc,
            &proof,
            &[json!({"id":"x","email":"b@example.test","imapHost":"h"})]
        ),
        Err(AccountsError::Conflict { .. })
    ));
    for field in SECRET_FIELDS {
        let mut row = json!({"id":"a","email":"a@example.test","imapHost":"h"});
        row[field] = json!("synthetic-private");
        assert!(matches!(
            commit_prepared(&doc, &proof, &[row]),
            Err(AccountsError::Invalid)
        ));
    }
    assert_eq!(disk(d.path()), saved);
}
