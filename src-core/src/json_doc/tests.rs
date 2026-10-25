use super::*;
use serde_json::json;
use std::fs;
use std::sync::atomic::Ordering;

const OBJ: Spec = Spec { file: "doc.json", kind: Kind::Object, pretty: false };
const ARR: Spec = Spec { file: "list.json", kind: Kind::Array, pretty: true };

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn disk(d: &Path) -> Value {
    serde_json::from_slice(&fs::read(d.join(OBJ.file)).unwrap()).unwrap()
}

fn seed(d: &Path, v: Value) {
    fs::write(d.join(OBJ.file), v.to_string()).unwrap();
}

fn backups(d: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(d)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&format!("{}.bak", OBJ.file)))
        .collect();
    names.sort();
    names
}

/// Sets one top-level key; changed when the value differs.
fn set(doc: &JsonDoc, key: &str, value: Value, base: Option<u64>) -> Result<Change, DocError> {
    let key = key.to_string();
    doc.write_op(base, move |v| {
        let map = v.as_object_mut().ok_or(DocError::Invalid)?;
        if map.get(&key) == Some(&value) {
            return Ok(vec![]);
        }
        map.insert(key.clone(), value);
        Ok(vec![key])
    })
}

// ── names ───────────────────────────────────────────────────────────────────

#[test]
fn companion_names_follow_the_document_name() {
    let accounts = Spec { file: "accounts.json", kind: Kind::Array, pretty: true };
    assert_eq!(accounts.lock_name(), "accounts.json.lock");
    assert_eq!(accounts.version_name(), "accounts.version.json");
    assert_eq!(accounts.corrupt_name(), "accounts.json.corrupt");
    assert_eq!(accounts.backup_name(3), "accounts.json.bak3");
    // The same names the settings document (step 0a) uses for its file.
    let settings = Spec { file: "frontend-settings.json", kind: Kind::Object, pretty: false };
    assert_eq!(settings.version_name(), "frontend-settings.version.json");
    assert_eq!(settings.lock_name(), "frontend-settings.json.lock");
}

#[test]
fn a_pretty_document_is_written_two_space_indented() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), ARR);
    doc.write_op(None, |v| {
        v.as_array_mut().unwrap().push(json!({"id": "a"}));
        Ok(vec!["a".into()])
    })
    .unwrap();
    let text = fs::read_to_string(d.path().join(ARR.file)).unwrap();
    assert_eq!(text, "[\n  {\n    \"id\": \"a\"\n  }\n]");
}

// ── versions ────────────────────────────────────────────────────────────────

#[test]
fn versions_rise_on_every_change_and_not_on_a_no_op() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), OBJ);
    let v0 = doc.get().unwrap().version;
    let a = set(&doc, "k", json!(1), None).unwrap();
    assert!(a.version > v0);
    let same = set(&doc, "k", json!(1), None).unwrap();
    assert_eq!(same.version, a.version);
    assert!(same.changed.is_empty());
    let b = set(&doc, "k", json!(2), None).unwrap();
    assert!(b.version > a.version);
    assert_eq!(doc.get().unwrap().version, b.version);
}

#[test]
fn a_stale_base_version_is_refused_and_writes_nothing() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), OBJ);
    let first = set(&doc, "k", json!(1), None).unwrap();
    set(&doc, "k", json!(2), None).unwrap();
    let err = set(&doc, "k", json!(3), Some(first.version)).unwrap_err();
    assert!(matches!(err, DocError::Conflict { .. }), "{err:?}");
    assert_eq!(disk(d.path()), json!({"k": 2}));
    let now = doc.get().unwrap().version;
    set(&doc, "k", json!(4), Some(now)).unwrap();
    assert_eq!(disk(d.path()), json!({"k": 4}));
}

#[test]
fn the_version_lives_in_a_sidecar_never_in_the_document() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), OBJ);
    let change = set(&doc, "k", json!(1), None).unwrap();
    assert_eq!(disk(d.path()), json!({"k": 1}));
    let again = JsonDoc::open(d.path(), OBJ);
    assert_eq!(again.get().unwrap().version, change.version);
}

#[test]
fn a_change_made_by_another_writer_bumps_the_version_and_is_kept() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), OBJ);
    let mine = set(&doc, "a", json!(1), None).unwrap();
    // An old app writes the file itself, non-atomically, without the lock.
    seed(d.path(), json!({"a": 1, "b": 2}));
    let seen = doc.get().unwrap();
    assert!(seen.version > mine.version);
    assert_eq!(seen.value["b"], json!(2));
    set(&doc, "c", json!(3), None).unwrap();
    assert_eq!(disk(d.path()), json!({"a": 1, "b": 2, "c": 3}));
    assert!(matches!(set(&doc, "d", json!(4), Some(mine.version)), Err(DocError::Conflict { .. })));
}

#[test]
fn a_version_never_repeats_across_a_restart_after_another_writer() {
    for through_reader in [false, true] {
        let d = dir();
        let a = JsonDoc::open(d.path(), OBJ);
        set(&a, "k", json!(1), None).unwrap();
        seed(d.path(), json!({"k": 2}));
        if through_reader {
            a.read().unwrap();
        }
        let seen = a.get().unwrap().version;
        drop(a);
        seed(d.path(), json!({"k": 3}));
        let b = JsonDoc::open(d.path(), OBJ);
        let next = b.get().unwrap().version;
        assert!(next > seen, "version {next} repeats {seen} (through_reader={through_reader})");
    }
}

/// The daemon and the shell's fallback each hold their own instance of one
/// document. A base version one of them read must be the one the other
/// checks against, however many of the other's writes it saw at once.
#[test]
fn two_processes_answer_the_same_version_for_the_same_document() {
    let d = dir();
    let daemon = JsonDoc::open(d.path(), OBJ);
    let shell = JsonDoc::open(d.path(), OBJ);
    set(&daemon, "a", json!(1), None).unwrap();
    assert_eq!(shell.get().unwrap().version, daemon.get().unwrap().version);
    // Two daemon writes seen by the shell in one read.
    set(&daemon, "b", json!(2), None).unwrap();
    let last = set(&daemon, "c", json!(3), None).unwrap();
    assert_eq!(shell.get().unwrap().version, last.version, "the shell took the daemon's version over");
    assert!(shell.read().is_ok());
    // The version the shell read is a fence the daemon honours, and back.
    let v = shell.get().unwrap().version;
    set(&daemon, "d", json!(4), Some(v)).unwrap();
    let v = daemon.get().unwrap().version;
    set(&shell, "e", json!(5), Some(v)).unwrap();
    assert_eq!(daemon.get().unwrap().version, shell.get().unwrap().version);
    // A writer that keeps no sidecar still moves both forward.
    seed(d.path(), json!({"other": "writer"}));
    let (a, b) = (daemon.get().unwrap().version, shell.get().unwrap().version);
    assert!(a > v + 1 && b > v + 1, "{a} {b}");
}

#[test]
fn a_missing_file_reads_as_empty_for_get_and_as_an_error_for_readers() {
    let d = dir();
    for spec in [OBJ, ARR] {
        let doc = JsonDoc::open(d.path(), spec);
        let snap = doc.get().unwrap();
        assert_eq!(snap.value, spec.kind.empty());
        assert_eq!(snap.recovered, None);
        assert!(doc.read().is_err());
        assert!(!d.path().join(spec.file).exists(), "a read never creates the file");
    }
}

// ── concurrency ─────────────────────────────────────────────────────────────

#[test]
fn fifty_parallel_writes_to_different_keys_all_survive() {
    let d = dir();
    let doc = Arc::new(JsonDoc::open(d.path(), OBJ));
    let start = doc.get().unwrap().version;
    let handles: Vec<_> = (0..50)
        .map(|i| {
            let doc = Arc::clone(&doc);
            std::thread::spawn(move || set(&doc, &format!("k{i}"), json!(i), None).unwrap().version)
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
    assert_eq!(doc.get().unwrap().version, start + 50);
}

// ── readers never wait on a write ───────────────────────────────────────────

#[test]
fn a_slow_write_never_holds_up_readers() {
    let d = dir();
    seed(d.path(), json!({"a": 1}));
    let doc = Arc::new(JsonDoc::open(d.path(), OBJ));
    let v0 = doc.get().unwrap().version;
    *doc.slow_write.lock().unwrap() = Some(Duration::from_millis(1500));
    let writer = {
        let doc = Arc::clone(&doc);
        std::thread::spawn(move || set(&doc, "b", json!(2), None).unwrap())
    };
    while !doc.in_write.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    let started = std::time::Instant::now();
    assert_eq!(*doc.read().unwrap(), json!({"a": 1}), "a reader sees the old document");
    let snap = doc.get().unwrap();
    assert_eq!(snap.value, json!({"a": 1}));
    assert_eq!(snap.version, v0);
    let waited = started.elapsed();
    assert!(waited < Duration::from_millis(200), "read and get waited {waited:?} on a write");
    let change = writer.join().unwrap();
    assert_eq!(change.version, v0 + 1);
    assert_eq!(doc.get().unwrap().version, v0 + 1, "the reader's look at the new file is not a second bump");
}

// ── atomicity ───────────────────────────────────────────────────────────────

#[test]
fn a_crash_between_the_temp_write_and_the_rename_leaves_the_old_file() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let doc = JsonDoc::open(d.path(), OBJ);
    let before = doc.get().unwrap().version;
    doc.fail_before_rename.store(true, Ordering::SeqCst);
    let err = set(&doc, "keep", json!("lost"), None).unwrap_err();
    assert!(matches!(err, DocError::Io(_)), "{err:?}");
    assert_eq!(disk(d.path()), json!({"keep": "me"}), "the old file is intact");
    doc.fail_before_rename.store(false, Ordering::SeqCst);
    let snap = doc.get().unwrap();
    assert_eq!(snap.value, json!({"keep": "me"}));
    assert_eq!(snap.version, before);
    let temps: Vec<_> = fs::read_dir(d.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp-")).collect();
    assert!(temps.is_empty(), "the failed write left its temp behind");
}

#[test]
fn a_temp_file_left_by_a_dead_writer_is_ignored_and_swept() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let stray = d.path().join(format!(".{}.tmp-999999-1", OBJ.file));
    fs::write(&stray, b"{\"keep\": \"half").unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    fs::File::options().write(true).open(&stray).unwrap().set_modified(old).unwrap();
    let doc = JsonDoc::open(d.path(), OBJ);
    assert_eq!(*doc.read().unwrap(), json!({"keep": "me"}));
    set(&doc, "n", json!(1), None).unwrap();
    assert!(!stray.exists(), "a stale temp is swept by the next write");
}

#[test]
fn a_result_of_the_wrong_shape_is_refused_and_the_file_is_untouched() {
    let d = dir();
    seed(d.path(), json!({"keep": "me"}));
    let doc = JsonDoc::open(d.path(), OBJ);
    let err = doc
        .write_op(None, |v| {
            *v = json!([1]);
            Ok(vec!["x".into()])
        })
        .unwrap_err();
    assert_eq!(err, DocError::Invalid);
    assert_eq!(disk(d.path()), json!({"keep": "me"}));
}

// ── readers ─────────────────────────────────────────────────────────────────

#[test]
fn readers_see_every_rewrite_and_an_error_for_the_wrong_shape() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), OBJ);
    assert!(doc.read().is_err(), "missing");
    seed(d.path(), json!({"a": 1}));
    assert_eq!(*doc.read().unwrap(), json!({"a": 1}));
    seed(d.path(), json!({"a": 2}));
    assert_eq!(*doc.read().unwrap(), json!({"a": 2}));
    fs::write(d.path().join(OBJ.file), "{\"a\": ").unwrap();
    assert!(doc.read().is_err(), "mid-write garbage");
    fs::write(d.path().join(OBJ.file), "[1]").unwrap();
    assert!(doc.read().is_err(), "wrong shape");
    seed(d.path(), json!({"a": 3}));
    assert_eq!(*doc.read().unwrap(), json!({"a": 3}));
}

#[test]
fn a_reader_error_never_quotes_the_content() {
    let d = dir();
    fs::write(d.path().join(OBJ.file), "{\"secret\": hunter2}").unwrap();
    let err = JsonDoc::open(d.path(), OBJ).read().unwrap_err();
    assert!(!err.contains("hunter2") && !err.contains("secret"), "{err}");
}

// ── a broken file ───────────────────────────────────────────────────────────

#[test]
fn a_broken_file_is_recovered_from_memory_then_kept_aside_on_the_next_write() {
    let d = dir();
    let doc = JsonDoc::open(d.path(), OBJ);
    set(&doc, "a", json!(1), None).unwrap();
    fs::write(d.path().join(OBJ.file), "{\"a\": tru").unwrap();
    let snap = doc.get().unwrap();
    assert_eq!(snap.recovered.as_deref(), Some("memory"));
    assert_eq!(snap.value, json!({"a": 1}));
    set(&doc, "b", json!(2), None).unwrap();
    assert_eq!(disk(d.path()), json!({"a": 1, "b": 2}));
    assert_eq!(fs::read(d.path().join(OBJ.corrupt_name())).unwrap(), b"{\"a\": tru");
}

#[test]
fn a_broken_file_in_a_new_process_is_recovered_from_the_newest_good_backup() {
    let d = dir();
    {
        let doc = JsonDoc::open_with(d.path(), OBJ, Duration::ZERO);
        set(&doc, "a", json!(1), None).unwrap();
        set(&doc, "a", json!(2), None).unwrap();
    }
    fs::write(d.path().join(OBJ.file), "garbage").unwrap();
    let doc = JsonDoc::open(d.path(), OBJ);
    let snap = doc.get().unwrap();
    assert_eq!(snap.recovered.as_deref(), Some(OBJ.backup_name(1).as_str()));
    assert_eq!(snap.value, json!({"a": 1}));
}

#[test]
fn a_document_of_the_wrong_shape_on_disk_is_broken() {
    let d = dir();
    fs::write(d.path().join(ARR.file), "{\"not\": \"a list\"}").unwrap();
    let doc = JsonDoc::open(d.path(), ARR);
    let snap = doc.get().unwrap();
    assert_eq!(snap.value, json!([]));
    assert_eq!(snap.recovered.as_deref(), Some("empty"));
    assert_eq!(fs::read(d.path().join(ARR.file)).unwrap(), b"{\"not\": \"a list\"}", "a read never writes");
}

// ── backups ─────────────────────────────────────────────────────────────────

#[test]
fn backups_rotate_and_never_exceed_five() {
    let d = dir();
    seed(d.path(), json!({"n": 0}));
    fs::write(d.path().join(OBJ.backup_name(7)), "{}").unwrap();
    let doc = JsonDoc::open_with(d.path(), OBJ, Duration::ZERO);
    for n in 1..=8 {
        set(&doc, "n", json!(n), None).unwrap();
    }
    assert_eq!(backups(d.path()), (1..=BACKUP_KEEP).map(|n| OBJ.backup_name(n)).collect::<Vec<_>>());
    let bak = |n: usize| -> Value { serde_json::from_slice(&fs::read(d.path().join(OBJ.backup_name(n))).unwrap()).unwrap() };
    assert_eq!(bak(1), json!({"n": 7}));
    assert_eq!(bak(5), json!({"n": 3}));
}

#[test]
fn one_backup_per_run_when_the_interval_has_not_passed() {
    let d = dir();
    seed(d.path(), json!({"n": 0}));
    let doc = JsonDoc::open(d.path(), OBJ);
    for n in 1..=4 {
        set(&doc, "n", json!(n), None).unwrap();
    }
    assert_eq!(backups(d.path()), vec![OBJ.backup_name(1)]);
    let bak: Value = serde_json::from_slice(&fs::read(d.path().join(OBJ.backup_name(1))).unwrap()).unwrap();
    assert_eq!(bak, json!({"n": 0}), "the file as the run found it");
}

#[test]
fn restarts_within_the_hour_never_push_the_pre_session_copy_out() {
    let d = dir();
    seed(d.path(), json!({"pre": "session"}));
    for n in 0..10 {
        set(&JsonDoc::open(d.path(), OBJ), "n", json!(n), None).unwrap();
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
        let path = d.path().join(OBJ.backup_name(n));
        fs::write(&path, json!({ "bak": n }).to_string()).unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_modified(future).unwrap();
    }
    for doc in [JsonDoc::open(d.path(), OBJ), JsonDoc::open_with(d.path(), OBJ, Duration::ZERO)] {
        for n in 1..=10 {
            set(&doc, "n", json!(n), None).unwrap();
        }
    }
    for n in 1..=BACKUP_KEEP {
        let bak: Value = serde_json::from_slice(&fs::read(d.path().join(OBJ.backup_name(n))).unwrap()).unwrap();
        assert_eq!(bak, json!({ "bak": n }), "slot {n} was rotated by writes that were not due");
    }
}

#[test]
fn a_broken_file_is_never_backed_up() {
    let d = dir();
    fs::write(d.path().join(OBJ.file), "garbage").unwrap();
    let doc = JsonDoc::open_with(d.path(), OBJ, Duration::ZERO);
    set(&doc, "a", json!(1), None).unwrap();
    assert!(backups(d.path()).is_empty());
}

#[test]
fn companion_files_list_everything_but_the_document() {
    let d = dir();
    let doc = JsonDoc::open_with(d.path(), OBJ, Duration::ZERO);
    set(&doc, "a", json!(1), None).unwrap();
    set(&doc, "a", json!(2), None).unwrap();
    fs::write(d.path().join(OBJ.corrupt_name()), "x").unwrap();
    let names: Vec<String> = companion_files(d.path(), OBJ)
        .iter()
        .filter(|p| p.exists())
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for want in [OBJ.lock_name(), OBJ.version_name(), OBJ.corrupt_name(), OBJ.backup_name(1)] {
        assert!(names.contains(&want), "{want} missing from {names:?}");
    }
    assert!(!names.contains(&OBJ.file.to_string()));
}

// ── the cross-process lock ──────────────────────────────────────────────────

#[test]
fn a_filesystem_without_the_lock_still_saves() {
    let d = dir();
    fs::create_dir(d.path().join(OBJ.lock_name())).unwrap();
    let doc = JsonDoc::open(d.path(), OBJ);
    set(&doc, "a", json!(1), None).unwrap();
    assert_eq!(disk(d.path()), json!({"a": 1}));
}

#[test]
fn a_held_lock_makes_a_writer_give_up_in_time() {
    let d = dir();
    let held = fs::OpenOptions::new().create(true).truncate(false).write(true).open(d.path().join(OBJ.lock_name())).unwrap();
    held.lock().unwrap();
    let started = std::time::Instant::now();
    let err = lock_file(d.path(), &OBJ.lock_name(), Duration::from_millis(200)).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(held);
    assert!(lock_file(d.path(), &OBJ.lock_name(), Duration::from_millis(200)).unwrap().is_some());
}

fn array_replace(doc: &JsonDoc, next: Value, base: Option<u64>) -> Result<Change, DocError> {
    doc.write_op(base, |value| {
        if *value == next { return Ok(vec![]); }
        *value = next;
        Ok(vec!["synthetic".into()])
    })
}

#[test]
fn array_documents_preserve_missed_write_and_aba_versions() {
    for through_read in [false, true] {
        let d = dir();
        let writer = JsonDoc::open(d.path(), ARR);
        let reader = JsonDoc::open(d.path(), ARR);
        let stale_writer = JsonDoc::open(d.path(), ARR);
        array_replace(&writer,json!(["A"]),None).unwrap();
        reader.get().unwrap();
        array_replace(&writer,json!(["B"]),None).unwrap();
        let distinct = array_replace(&writer,json!(["C"]),None).unwrap();
        if through_read { reader.read().unwrap(); }
        assert_eq!(reader.get().unwrap().version,distinct.version,"missed writes");
        let old = stale_writer.get().unwrap();
        let before = fs::read(writer.path()).unwrap();
        array_replace(&writer,json!(["B"]),None).unwrap();
        let aba = array_replace(&writer,json!(["C"]),None).unwrap();
        assert_eq!(fs::read(writer.path()).unwrap(),before);
        if through_read { reader.read().unwrap(); }
        assert_eq!(reader.get().unwrap().version,aba.version,"ABA adopts newer matching sidecar");
        let called = std::cell::Cell::new(false);
        assert_eq!(stale_writer.write_op(Some(old.version), |_| { called.set(true); Ok(vec![]) }),Err(DocError::Conflict {current:aba.version}));
        assert!(!called.get(),"stale base refused before mutation");
        assert_eq!(fs::read(writer.path()).unwrap(),before);
        let fresh = array_replace(&stale_writer,json!(["fresh"]),Some(aba.version)).unwrap();
        assert!(fresh.version > aba.version);
        assert_eq!(writer.get().unwrap().version,fresh.version);
    }
}

fn scrub_passwords(value: &mut Value) -> Vec<String> {
    let mut removed = Vec::new();
    for record in value.as_array_mut().unwrap() {
        if record.as_object_mut().unwrap().remove("password").is_some() {
            removed.push(record["id"].as_str().unwrap().to_string());
        }
    }
    removed
}

#[test]
fn scrubbed_backups_preserve_live_data_until_authorized() {
    for live in [false,true] {
        let d = dir();
        let original = json!([{"id":"one","password":"synthetic-marker","keep":[2,1]},{"id":"two","keep":"safe"}]);
        fs::write(d.path().join(ARR.file),serde_json::to_vec_pretty(&original).unwrap()).unwrap();
        let doc = JsonDoc::open_with(d.path(),ARR,Duration::ZERO);
        doc.write_op_scrubbed(None,Some(Scrub {clean:&scrub_passwords,live}),|v| {
            v.as_array_mut().unwrap().push(json!({"id":"three","keep":3}));
            Ok(vec!["three".into()])
        }).unwrap();
        let stored: Value = serde_json::from_slice(&fs::read(doc.path()).unwrap()).unwrap();
        let mut expected = original.clone();
        scrub_passwords(&mut expected);
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(d.path().join(ARR.backup_name(1))).unwrap()).unwrap(),expected);
        if live { assert!(stored[0].get("password").is_none()); }
        else { assert_eq!(stored[0]["password"],"synthetic-marker"); }
        expected.as_array_mut().unwrap().push(json!({"id":"three","keep":3}));
        let mut clean_stored = stored.clone();
        scrub_passwords(&mut clean_stored);
        assert_eq!(clean_stored,expected);
        assert_eq!(fs::read(doc.path()).unwrap(),serde_json::to_vec_pretty(&stored).unwrap());
    }
}

#[test]
fn scrub_only_change_is_persisted_and_invalid_writes_leave_bytes_unchanged() {
    let d = dir();
    let doc = JsonDoc::open_with(d.path(),ARR,Duration::ZERO);
    let original = json!([{"id":"one","password":"synthetic-marker","keep":7}]);
    array_replace(&doc,original.clone(),None).unwrap();
    let initial = doc.get().unwrap().version;
    let bytes = fs::read(doc.path()).unwrap();
    for refuse in 0..3 {
        let result = doc.write_op_scrubbed(if refuse==0 {Some(initial-1)} else {None},Some(Scrub {clean:&scrub_passwords,live:true}),|v| {
            if refuse==1 { return Err(DocError::Invalid); }
            *v = json!({"wrong":"shape"});
            Ok(vec!["one".into()])
        });
        if refuse==0 { assert_eq!(result,Err(DocError::Conflict {current:initial})); }
        else { assert_eq!(result,Err(DocError::Invalid)); }
        assert_eq!(fs::read(doc.path()).unwrap(),bytes);
        assert!(!d.path().join(ARR.backup_name(1)).exists());
        assert_eq!(doc.get().unwrap().version,initial);
    }
    let change = doc.write_op_scrubbed(Some(initial),Some(Scrub {clean:&scrub_passwords,live:true}),|_| Ok(vec![])).unwrap();
    assert_eq!(change.changed,vec!["one"]);
    assert!(change.version > initial);
    let expected = json!([{"id":"one","keep":7}]);
    assert_eq!(doc.get().unwrap().value,expected);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(d.path().join(ARR.backup_name(1))).unwrap()).unwrap(),expected);
    let clean = fs::read(doc.path()).unwrap();
    let repeat = doc.write_op_scrubbed(None,Some(Scrub {clean:&scrub_passwords,live:true}),|_| Ok(vec![])).unwrap();
    assert_eq!(repeat,Change {version:change.version,changed:vec![]});
    assert_eq!(fs::read(doc.path()).unwrap(),clean);
}

#[test]
fn private_document_companions_are_private_on_unix() {
    let d = dir();
    fs::write(d.path().join(ARR.file),"[]").unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d.path().join(ARR.file),fs::Permissions::from_mode(0o644)).unwrap();
    }
    let doc = JsonDoc::open_with(d.path(),ARR,Duration::ZERO);
    array_replace(&doc,json!([{"id":"one"}]),None).unwrap();
    fs::write(doc.path(),"synthetic corrupt bytes").unwrap();
    assert_eq!(doc.get().unwrap().recovered.as_deref(),Some("memory"));
    array_replace(&doc,json!([{"id":"two"}]),None).unwrap();
    assert_eq!(doc.get().unwrap().value,json!([{"id":"two"}]));
    assert_eq!(fs::read(d.path().join(ARR.corrupt_name())).unwrap(),b"synthetic corrupt bytes");
    assert_eq!(fs::read(d.path().join(ARR.backup_name(1))).unwrap(),b"[]");
    for name in [ARR.file.to_string(),ARR.lock_name(),ARR.version_name(),ARR.backup_name(1),ARR.corrupt_name()] {
        assert!(d.path().join(&name).is_file());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(d.path().join(name)).unwrap().permissions().mode() & 0o777,0o600);
        }
    }
}

#[test]
fn separate_document_specs_do_not_share_state_or_backups() {
    let d = dir();
    let settings_spec = Spec {file:"frontend-settings.json",..OBJ};
    let accounts_spec = Spec {file:"accounts.json",..ARR};
    let settings = JsonDoc::shared(d.path(),settings_spec);
    let array = JsonDoc::shared(d.path(),accounts_spec);
    assert!(Arc::ptr_eq(&settings,&JsonDoc::shared(d.path(),settings_spec)));
    assert!(Arc::ptr_eq(&array,&JsonDoc::shared(d.path(),accounts_spec)));
    assert!(!Arc::ptr_eq(&settings,&array));
    set(&settings,"one",json!(1),None).unwrap();
    let settings_change = set(&settings,"one",json!(2),None).unwrap();
    array_replace(&array,json!(["A"]),None).unwrap();
    let array_change = array_replace(&array,json!(["B"]),None).unwrap();
    assert_eq!(settings.spec().version_name(),"frontend-settings.version.json");
    assert_eq!(array.spec().version_name(),"accounts.version.json");
    assert_eq!(settings.get().unwrap().version,settings_change.version);
    assert_eq!(array.get().unwrap().version,array_change.version);
    assert_eq!(fs::read(d.path().join(settings_spec.backup_name(1))).unwrap(),br#"{"one":1}"#);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(d.path().join(accounts_spec.backup_name(1))).unwrap()).unwrap(),json!(["A"]));
    let array_bytes = fs::read(array.path()).unwrap();
    fs::write(settings.path(),"broken").unwrap();
    assert_eq!(settings.get().unwrap().value,json!({"one":2}));
    set(&settings,"two",json!(3),None).unwrap();
    assert_eq!(fs::read(array.path()).unwrap(),array_bytes);
    assert_eq!(array.get().unwrap().version,array_change.version);
    let settings_files = companion_files(d.path(),settings_spec);
    let array_files = companion_files(d.path(),accounts_spec);
    assert!(settings_files.iter().all(|p| !array_files.contains(p)));
    // The same shared engine exposes one fault hook to every facade owner.
    settings.fail_before_rename.store(true,Ordering::SeqCst);
    let shared_again = JsonDoc::shared(d.path(),settings_spec);
    assert!(matches!(set(&shared_again,"three",json!(4),None),Err(DocError::Io(_))));
    assert!(array_replace(&array,json!(["C"]),None).is_ok());
}
