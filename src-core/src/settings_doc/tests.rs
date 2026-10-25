use super::*;
use serde_json::json;
use std::fs;
use std::sync::atomic::Ordering;

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn disk(d: &Path) -> Value {
    serde_json::from_slice(&fs::read(d.join(FILE_NAME)).unwrap()).unwrap()
}

fn seed(d: &Path, v: Value) {
    fs::write(d.join(FILE_NAME), v.to_string()).unwrap();
}

fn backups(d: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(d)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&format!("{FILE_NAME}.bak")))
        .collect();
    names.sort();
    names
}

// ── merge patch (RFC 7396) ──────────────────────────────────────────────────

#[test]
fn merge_patch_follows_rfc_7396() {
    // The RFC's own test vectors (appendix A), the ones that matter here.
    let cases = [
        (json!({"a": "b"}), json!({"a": "c"}), json!({"a": "c"})),
        (json!({"a": "b"}), json!({"b": "c"}), json!({"a": "b", "b": "c"})),
        (json!({"a": "b"}), json!({"a": null}), json!({})),
        (json!({"a": "b", "b": "c"}), json!({"a": null}), json!({"b": "c"})),
        (json!({"a": ["b"]}), json!({"a": "c"}), json!({"a": "c"})),
        (json!({"a": "c"}), json!({"a": ["b"]}), json!({"a": ["b"]})),
        (json!({"a": {"b": "c"}}), json!({"a": {"b": "d", "c": null}}), json!({"a": {"b": "d"}})),
        (json!({"a": [{"b": "c"}]}), json!({"a": [1]}), json!({"a": [1]})),
        (json!({"e": null}), json!({"a": 1}), json!({"e": null, "a": 1})),
        (json!([1, 2]), json!({"a": "b", "c": null}), json!({"a": "b"})),
        (json!({}), json!({"a": {"bb": {"ccc": null}}}), json!({"a": {"bb": {}}})),
    ];
    for (target, patch, want) in cases {
        let mut t = target.clone();
        merge_patch(&mut t, &patch);
        assert_eq!(t, want, "{target} + {patch}");
    }
}

#[test]
fn a_patch_deletes_with_null_merges_nested_objects_and_replaces_arrays() {
    let d = dir();
    seed(d.path(), json!({"s": {"state": {"a": 1, "b": {"x": 1, "y": 2}, "list": [1, 2, 3]}, "version": 3}, "gone": true}));
    let doc = SettingsDoc::open(d.path());
    let change = doc
        .patch(&json!({"s": {"state": {"a": null, "b": {"y": 9}, "list": [7]}}, "gone": null}), None)
        .unwrap();
    let mut changed = change.changed.clone();
    changed.sort();
    assert_eq!(changed, vec!["gone", "s"]);
    assert_eq!(disk(d.path()), json!({"s": {"state": {"b": {"x": 1, "y": 9}, "list": [7]}, "version": 3}}));
}

#[test]
fn replace_swaps_a_top_level_key_whole_and_null_removes_it() {
    let d = dir();
    seed(d.path(), json!({"mailvault-settings": {"state": {"hiddenAccounts": {"a": true, "b": true}}}, "mailvault-theme": {"state": {"theme": "dark"}}}));
    let doc = SettingsDoc::open(d.path());
    // The store dropped account `a` from a nested map: a merge patch would keep it.
    let change = doc
        .replace(&json!({"mailvault-settings": {"state": {"hiddenAccounts": {"b": true}}}, "mailvault-focus": null}), None)
        .unwrap();
    assert_eq!(change.changed, vec!["mailvault-settings"]);
    assert_eq!(
        disk(d.path()),
        json!({"mailvault-settings": {"state": {"hiddenAccounts": {"b": true}}}, "mailvault-theme": {"state": {"theme": "dark"}}})
    );
    doc.replace(&json!({"mailvault-theme": null}), None).unwrap();
    assert!(disk(d.path()).get("mailvault-theme").is_none());
}

// ── versions ────────────────────────────────────────────────────────────────

#[test]
fn versions_rise_on_every_change_and_not_on_a_no_op() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    let v0 = doc.get(None).unwrap().version;
    let a = doc.patch(&json!({"k": 1}), None).unwrap();
    assert!(a.version > v0);
    let same = doc.patch(&json!({"k": 1}), None).unwrap();
    assert_eq!(same.version, a.version);
    assert!(same.changed.is_empty());
    let b = doc.replace(&json!({"k": 2}), None).unwrap();
    assert!(b.version > a.version);
    assert_eq!(doc.get(None).unwrap().version, b.version);
}

#[test]
fn a_stale_base_version_is_refused_and_writes_nothing() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    let first = doc.patch(&json!({"k": 1}), None).unwrap();
    doc.patch(&json!({"k": 2}), None).unwrap();
    let err = doc.patch(&json!({"k": 3}), Some(first.version)).unwrap_err();
    assert!(matches!(err, SettingsError::Conflict { .. }), "{err:?}");
    assert_eq!(disk(d.path()), json!({"k": 2}));
    // The current one is accepted, and no base version means no check.
    let now = doc.get(None).unwrap().version;
    doc.patch(&json!({"k": 4}), Some(now)).unwrap();
    doc.patch(&json!({"k": 5}), None).unwrap();
    assert_eq!(disk(d.path()), json!({"k": 5}));
}

#[test]
fn the_version_lives_in_a_sidecar_never_in_the_document() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    let change = doc.patch(&json!({"k": 1}), None).unwrap();
    assert_eq!(disk(d.path()), json!({"k": 1}));
    // A new process picks the counter up from the sidecar.
    let again = SettingsDoc::open(d.path());
    assert_eq!(again.get(None).unwrap().version, change.version);
}

#[test]
fn a_change_made_by_another_writer_bumps_the_version_and_is_kept() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    let mine = doc.patch(&json!({"a": 1}), None).unwrap();
    // The shell's fallback (or an old app) writes the file itself.
    write_document(d.path(), &json!({"a": 1, "b": 2}).to_string()).unwrap();
    let seen = doc.get(None).unwrap();
    assert!(seen.version > mine.version);
    assert_eq!(seen.values.get("b"), Some(&json!(2)));
    // A daemon write on top keeps the other writer's key.
    doc.patch(&json!({"c": 3}), None).unwrap();
    assert_eq!(disk(d.path()), json!({"a": 1, "b": 2, "c": 3}));
    // And a base version taken before that change is stale.
    assert!(matches!(doc.patch(&json!({"d": 4}), Some(mine.version)), Err(SettingsError::Conflict { .. })));
}

#[test]
fn a_version_never_repeats_across_a_restart_after_another_writer() {
    for through_reader in [false, true] {
        let d = dir();
        let a = SettingsDoc::open(d.path());
        a.patch(&json!({"k": 1}), None).unwrap();
        write_document(d.path(), r#"{"k":2}"#).unwrap();
        // The daemon notices the other writer, through a reader or a get.
        if through_reader {
            a.read().unwrap();
        }
        let seen = a.get(None).unwrap().version;
        drop(a);
        // The daemon restarts; the other writer wrote again meanwhile.
        write_document(d.path(), r#"{"k":3}"#).unwrap();
        let b = SettingsDoc::open(d.path());
        let next = b.get(None).unwrap().version;
        assert!(next > seen, "version {next} repeats {seen} for different content (through_reader={through_reader})");
    }
}

#[test]
fn a_missing_file_reads_as_empty_for_get_and_as_an_error_for_readers() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    let snap = doc.get(None).unwrap();
    assert!(snap.values.is_empty());
    assert_eq!(snap.recovered, None);
    assert!(doc.read().is_err());
}

#[test]
fn get_returns_only_the_keys_asked_for() {
    let d = dir();
    seed(d.path(), json!({"a": 1, "b": 2, "c": 3}));
    let doc = SettingsDoc::open(d.path());
    let snap = doc.get(Some(&["a".to_string(), "c".to_string(), "zz".to_string()])).unwrap();
    assert_eq!(Value::Object(snap.values), json!({"a": 1, "c": 3}));
}

// ── concurrency ─────────────────────────────────────────────────────────────

#[test]
fn fifty_parallel_patches_to_different_keys_all_survive() {
    let d = dir();
    let doc = Arc::new(SettingsDoc::open(d.path()));
    let start = doc.get(None).unwrap().version;
    let handles: Vec<_> = (0..50)
        .map(|i| {
            let doc = Arc::clone(&doc);
            std::thread::spawn(move || doc.patch(&json!({ format!("k{i}"): i }), None).unwrap().version)
        })
        .collect();
    let mut versions: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    versions.sort();
    versions.dedup();
    assert_eq!(versions.len(), 50, "every write got its own version");
    let on_disk = disk(d.path());
    for i in 0..50 {
        assert_eq!(on_disk[format!("k{i}")], json!(i), "k{i} lost");
    }
    assert_eq!(doc.get(None).unwrap().version, start + 50);
}

#[test]
fn parallel_patches_to_one_key_end_on_the_highest_version_writer() {
    let d = dir();
    let doc = Arc::new(SettingsDoc::open(d.path()));
    let handles: Vec<_> = (0..50)
        .map(|i| {
            let doc = Arc::clone(&doc);
            std::thread::spawn(move || (i, doc.patch(&json!({"same": i}), None).unwrap().version))
        })
        .collect();
    let results: Vec<(i32, u64)> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let mut versions: Vec<u64> = results.iter().map(|r| r.1).collect();
    versions.sort();
    versions.dedup();
    assert_eq!(versions.len(), 50, "versions are unique, so monotonic per write");
    let last = results.iter().max_by_key(|r| r.1).unwrap().0;
    assert_eq!(disk(d.path())["same"], json!(last));
}

// ── readers never wait on a write ───────────────────────────────────────────

#[test]
fn a_slow_write_never_holds_up_readers() {
    let d = dir();
    seed(d.path(), json!({"a": 1}));
    let doc = Arc::new(SettingsDoc::open(d.path()));
    let v0 = doc.get(None).unwrap().version;
    *doc.slow_write.lock().unwrap() = Some(Duration::from_millis(1500));
    let writer = {
        let doc = Arc::clone(&doc);
        std::thread::spawn(move || doc.patch(&json!({"b": 2}), None).unwrap())
    };
    while !doc.in_write.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    // The write is parked inside its IO, holding its locks.
    let started = std::time::Instant::now();
    assert_eq!(*doc.read().unwrap(), json!({"a": 1}), "a reader sees the old document");
    let snap = doc.get(None).unwrap();
    assert_eq!(Value::Object(snap.values), json!({"a": 1}));
    assert_eq!(snap.version, v0);
    let waited = started.elapsed();
    assert!(waited < Duration::from_millis(200), "read and get waited {waited:?} on a write");
    let change = writer.join().unwrap();
    assert_eq!(change.version, v0 + 1);
    assert_eq!(*doc.read().unwrap(), json!({"a": 1, "b": 2}));
    assert_eq!(doc.get(None).unwrap().version, v0 + 1, "the reader's look at the new file is not a second bump");
}

// ── atomicity ───────────────────────────────────────────────────────────────

#[test]
fn a_crash_between_the_temp_write_and_the_rename_leaves_the_old_file() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let doc = SettingsDoc::open(d.path());
    let before = doc.get(None).unwrap().version;
    doc.fail_before_rename.store(true, Ordering::SeqCst);
    let err = doc.patch(&json!({"keep": "lost", "new": 1}), None).unwrap_err();
    assert!(matches!(err, SettingsError::Io(_)), "{err:?}");
    assert_eq!(disk(d.path()), json!({"keep": "me"}), "the old file is intact");
    // The failed write left nothing behind in memory either.
    doc.fail_before_rename.store(false, Ordering::SeqCst);
    let snap = doc.get(None).unwrap();
    assert_eq!(Value::Object(snap.values), json!({"keep": "me"}));
    assert_eq!(snap.version, before);
}

#[test]
fn a_temp_file_left_by_a_dead_writer_is_ignored_and_swept() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let stray = d.path().join(format!(".{FILE_NAME}.tmp-999999-1"));
    fs::write(&stray, b"{\"keep\": \"half").unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    fs::File::options().write(true).open(&stray).unwrap().set_modified(old).unwrap();
    let doc = SettingsDoc::open(d.path());
    assert_eq!(*doc.read().unwrap(), json!({"keep": "me"}));
    doc.patch(&json!({"n": 1}), None).unwrap();
    assert!(!stray.exists(), "a stale temp is swept by the next write");
}

#[test]
fn a_non_object_is_refused_and_the_file_is_untouched() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let doc = SettingsDoc::open(d.path());
    assert_eq!(doc.patch(&json!([1, 2]), None).unwrap_err(), SettingsError::NotAnObject);
    assert_eq!(doc.patch(&json!("x"), None).unwrap_err(), SettingsError::NotAnObject);
    assert_eq!(doc.replace(&json!(null), None).unwrap_err(), SettingsError::NotAnObject);
    assert!(write_document(d.path(), "[1,2]").is_err());
    assert!(write_document(d.path(), "{\"keep\": ").is_err());
    assert!(write_document(d.path(), "").is_err());
    assert_eq!(disk(d.path()), json!({"keep": "me"}));
    write_document(d.path(), "{\"keep\":\"you\"}").unwrap();
    assert_eq!(disk(d.path()), json!({"keep": "you"}));
}

// ── readers ─────────────────────────────────────────────────────────────────

#[test]
fn readers_see_every_rewrite_and_an_error_for_anything_but_an_object() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    assert!(doc.read().is_err(), "missing");
    seed(d.path(), json!({"a": 1}));
    assert_eq!(*doc.read().unwrap(), json!({"a": 1}));
    // Same length, same instant: the bytes decide, never a timestamp.
    seed(d.path(), json!({"a": 2}));
    assert_eq!(*doc.read().unwrap(), json!({"a": 2}));
    fs::write(d.path().join(FILE_NAME), "{\"a\": ").unwrap();
    assert!(doc.read().is_err(), "mid-write garbage");
    fs::write(d.path().join(FILE_NAME), "[1]").unwrap();
    assert!(doc.read().is_err(), "not an object");
    seed(d.path(), json!({"a": 3}));
    assert_eq!(*doc.read().unwrap(), json!({"a": 3}));
    fs::remove_file(d.path().join(FILE_NAME)).unwrap();
    assert!(doc.read().is_err(), "removed");
}

#[test]
fn readers_never_get_a_backup_when_the_file_is_broken() {
    let d = dir();
    let doc = SettingsDoc::open_with(d.path(), Duration::ZERO);
    doc.patch(&json!({"fetchMode": "keepRecent"}), None).unwrap();
    doc.patch(&json!({"fetchMode": "hoarder"}), None).unwrap();
    fs::write(d.path().join(FILE_NAME), "{\"fetchMode\": \"ho").unwrap();
    assert!(doc.read().is_err());
}

// ── a broken file ───────────────────────────────────────────────────────────

#[test]
fn a_broken_file_is_recovered_from_memory_then_kept_aside_on_the_next_write() {
    let d = dir();
    let doc = SettingsDoc::open(d.path());
    doc.patch(&json!({"a": 1}), None).unwrap();
    fs::write(d.path().join(FILE_NAME), "{\"a\": tru").unwrap();
    let snap = doc.get(None).unwrap();
    assert_eq!(snap.recovered.as_deref(), Some("memory"));
    assert_eq!(Value::Object(snap.values), json!({"a": 1}));
    doc.patch(&json!({"b": 2}), None).unwrap();
    assert_eq!(disk(d.path()), json!({"a": 1, "b": 2}));
    assert_eq!(fs::read(d.path().join(CORRUPT_NAME)).unwrap(), b"{\"a\": tru");
}

#[test]
fn a_broken_file_in_a_new_process_is_recovered_from_the_newest_good_backup() {
    let d = dir();
    {
        let doc = SettingsDoc::open_with(d.path(), Duration::ZERO);
        doc.patch(&json!({"a": 1}), None).unwrap();
        doc.patch(&json!({"a": 2}), None).unwrap();
    }
    fs::write(d.path().join(FILE_NAME), "garbage").unwrap();
    let doc = SettingsDoc::open(d.path());
    let snap = doc.get(None).unwrap();
    assert_eq!(snap.recovered.as_deref(), Some(backup_name(1).as_str()));
    assert_eq!(Value::Object(snap.values), json!({"a": 1}));
}

#[test]
fn a_broken_file_with_nothing_to_recover_from_reads_as_empty_and_is_never_written_unasked() {
    let d = dir();
    fs::write(d.path().join(FILE_NAME), "garbage").unwrap();
    let doc = SettingsDoc::open(d.path());
    let snap = doc.get(None).unwrap();
    assert!(snap.values.is_empty());
    assert!(snap.recovered.is_some());
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), b"garbage", "a read never writes");
}

// ── backups ─────────────────────────────────────────────────────────────────

#[test]
fn backups_rotate_and_never_exceed_five() {
    let d = dir();
    seed(d.path(), json!({"n": 0}));
    // A stray from some older scheme must not survive the rotation either.
    fs::write(d.path().join(backup_name(7)), "{}").unwrap();
    let doc = SettingsDoc::open_with(d.path(), Duration::ZERO);
    for n in 1..=8 {
        doc.patch(&json!({ "n": n }), None).unwrap();
    }
    assert_eq!(backups(d.path()), (1..=BACKUP_KEEP).map(backup_name).collect::<Vec<_>>());
    // bak1 is the file as it was before the last write, bak5 four writes earlier.
    let bak = |n: usize| -> Value { serde_json::from_slice(&fs::read(d.path().join(backup_name(n))).unwrap()).unwrap() };
    assert_eq!(bak(1), json!({"n": 7}));
    assert_eq!(bak(5), json!({"n": 3}));
}

#[test]
fn one_backup_per_run_when_the_interval_has_not_passed() {
    let d = dir();
    seed(d.path(), json!({"n": 0}));
    let doc = SettingsDoc::open(d.path());
    for n in 1..=4 {
        doc.patch(&json!({ "n": n }), None).unwrap();
    }
    assert_eq!(backups(d.path()), vec![backup_name(1)]);
    let bak: Value = serde_json::from_slice(&fs::read(d.path().join(backup_name(1))).unwrap()).unwrap();
    assert_eq!(bak, json!({"n": 0}), "the file as the run found it");
}

#[test]
fn daemon_restarts_within_the_hour_never_push_the_pre_session_copy_out() {
    let d = dir();
    seed(d.path(), json!({"pre": "session"}));
    for n in 0..10 {
        // A daemon restart each time (a vault switch, a crash loop), one write each.
        SettingsDoc::open(d.path()).patch(&json!({ "n": n }), None).unwrap();
    }
    let slots: Vec<Value> = backups(d.path())
        .iter()
        .map(|name| serde_json::from_slice(&fs::read(d.path().join(name)).unwrap()).unwrap())
        .collect();
    assert!(slots.contains(&json!({"pre": "session"})), "the pre-session copy is gone: {slots:?}");
}

#[test]
fn a_backup_dated_in_the_future_is_not_due() {
    let d = dir();
    seed(d.path(), json!({"n": 0}));
    let future = std::time::SystemTime::now() + Duration::from_secs(24 * 60 * 60);
    for n in 1..=BACKUP_KEEP {
        let path = d.path().join(backup_name(n));
        fs::write(&path, json!({ "bak": n }).to_string()).unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_modified(future).unwrap();
    }
    for doc in [SettingsDoc::open(d.path()), SettingsDoc::open_with(d.path(), Duration::ZERO)] {
        for n in 1..=10 {
            doc.patch(&json!({ "n": n }), None).unwrap();
        }
    }
    for n in 1..=BACKUP_KEEP {
        let bak: Value = serde_json::from_slice(&fs::read(d.path().join(backup_name(n))).unwrap()).unwrap();
        assert_eq!(bak, json!({ "bak": n }), "slot {n} was rotated by writes that were not due");
    }
}

#[test]
fn a_broken_file_is_never_backed_up() {
    let d = dir();
    fs::write(d.path().join(FILE_NAME), "garbage").unwrap();
    let doc = SettingsDoc::open_with(d.path(), Duration::ZERO);
    doc.patch(&json!({"a": 1}), None).unwrap();
    assert!(backups(d.path()).is_empty());
}

// ── the cross-process lock ──────────────────────────────────────────────────

#[test]
fn a_filesystem_without_the_lock_still_saves_settings() {
    let d = dir();
    // The lock file cannot be opened at all (a directory sits at its path):
    // the same outcome as a filesystem that refuses advisory locks.
    fs::create_dir(d.path().join(LOCK_NAME)).unwrap();
    let doc = SettingsDoc::open(d.path());
    doc.patch(&json!({"a": 1}), None).unwrap();
    write_document(d.path(), &json!({"a": 1, "b": 2}).to_string()).unwrap();
    assert_eq!(disk(d.path()), json!({"a": 1, "b": 2}));
}

#[test]
fn a_held_lock_makes_the_shell_write_give_up_in_time_and_leave_the_file() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let held = fs::OpenOptions::new().create(true).truncate(false).write(true).open(d.path().join(LOCK_NAME)).unwrap();
    held.lock().unwrap();
    let started = std::time::Instant::now();
    let err = write_document_waiting(d.path(), "{\"keep\":\"you\"}", Duration::from_millis(200)).unwrap_err();
    assert_eq!(err, "errors.settingsWriteFailed");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(disk(d.path()), json!({"keep": "me"}));
    drop(held);
    write_document(d.path(), "{\"keep\":\"you\"}").unwrap();
    assert_eq!(disk(d.path()), json!({"keep": "you"}));
}

#[test]
fn errors_name_catalog_keys() {
    assert_eq!(SettingsError::Conflict { current: 1 }.catalog_key(), "errors.settingsConflict");
    assert_eq!(SettingsError::NotAnObject.catalog_key(), "errors.settingsInvalid");
    assert_eq!(SettingsError::Io("x".into()).catalog_key(), "errors.settingsWriteFailed");
}

#[test]
fn rebased_ui_defaults_preserve_new_native_keys_but_remove_explicit_old_fields() {
    let dir = tempfile::tempdir().unwrap();
    let doc = super::SettingsDoc::shared(dir.path());
    doc.replace(
        &serde_json::json!({"mailvault-settings":{"version":3,"state":{"language":"en"}}}),
        None,
    )
    .unwrap();
    let base = doc.get(None).unwrap().values["mailvault-settings"].clone();
    doc.patch(&serde_json::json!({"mailvault-settings":{"state":{"backupHistory":{"one":[{"success":true}]},"snapshotLastTimes":{"one":42}}}}),None).unwrap();
    doc.replace_rebased(&serde_json::json!({"mailvault-settings":{"version":3,"state":{"language":"de","backupHistory":{},"snapshotLastTimes":{},"literalNull":null}}}),&serde_json::json!({"mailvault-settings":base}),None).unwrap();
    let stored = &doc.get(None).unwrap().values["mailvault-settings"];
    assert_eq!(
        stored["state"]["backupHistory"]["one"],
        serde_json::json!([{"success":true}])
    );
    assert_eq!(stored["state"]["snapshotLastTimes"]["one"], 42);
    assert_eq!(
        stored["state"].get("literalNull"),
        Some(&serde_json::Value::Null)
    );
    let fresh = stored.clone();
    let mut edited = stored.clone();
    edited["state"]
        .as_object_mut()
        .unwrap()
        .remove("snapshotLastTimes");
    doc.replace_rebased(
        &serde_json::json!({"mailvault-settings":edited}),
        &serde_json::json!({"mailvault-settings":fresh}),
        None,
    )
    .unwrap();
    assert!(doc.get(None).unwrap().values["mailvault-settings"]["state"]
        .get("snapshotLastTimes")
        .is_none());
}
