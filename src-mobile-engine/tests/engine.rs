use mailvault_mobile_engine::{seed, Engine, EngineError, RpcError};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn page(e: &Engine, offset: u64, limit: u64) -> Value {
    e.rpc(
        "mobile.messages.page",
        json!({ "accountId": seed::ACCOUNT_ID, "folder": seed::FOLDER, "offset": offset, "limit": limit }),
    )
    .unwrap()
}

fn open_seeded(dir: &std::path::Path, n: usize) -> Engine {
    let e = Engine::open(dir).unwrap();
    seed::seed(&e, n).unwrap();
    e
}

#[test]
fn open_creates_schema_v1_in_wal() {
    let tmp = tempfile::tempdir().unwrap();
    let _e = Engine::open(tmp.path()).unwrap();
    let path = tmp.path().join("mobile.db");
    assert!(path.is_file());
    let c = Connection::open(&path).unwrap();
    let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    let ver: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(ver, 1);
    let pong = _e.rpc("mobile.ping", json!({})).unwrap();
    assert_eq!(pong["schema"], 1);
    assert_eq!(pong["engine"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn page_returns_newest_first_and_total() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 250);
    let p = page(&e, 0, 50);
    let rows = p["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 50);
    assert_eq!(p["total"], 250);
    let dates: Vec<i64> = rows.iter().map(|r| r["dateMs"].as_i64().unwrap()).collect();
    assert!(dates.windows(2).all(|w| w[0] >= w[1]), "not newest first: {dates:?}");
    let last = page(&e, 240, 50);
    assert_eq!(last["rows"].as_array().unwrap().len(), 10);
    assert_eq!(last["total"], 250);
    let r = &rows[0];
    for k in ["uid", "subject", "fromName", "fromAddress", "dateMs", "snippet", "seen", "flagged", "hasAttachments"] {
        assert!(r.get(k).is_some(), "missing {k}");
    }
}

#[test]
fn page_caps_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 250);
    assert_eq!(page(&e, 0, 1000)["rows"].as_array().unwrap().len(), 200);
}

#[test]
fn read_not_blocked_by_writer() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Arc::new(open_seeded(tmp.path(), 250));
    let (tx, rx) = std::sync::mpsc::channel();
    let w = Arc::clone(&e);
    let t = std::thread::spawn(move || {
        w.hold_write_txn_for_test(|| {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(2));
        })
        .unwrap();
    });
    rx.recv().unwrap();
    let t0 = Instant::now();
    let p = page(&e, 0, 50);
    let took = t0.elapsed();
    assert_eq!(p["rows"].as_array().unwrap().len(), 50);
    assert!(took < Duration::from_millis(100), "read took {took:?} behind a writer");
    t.join().unwrap();
}

#[test]
fn corrupt_db_is_rebuilt() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("mobile.db"), b"this is not a sqlite database, just garbage bytes").unwrap();
    let e = Engine::open(tmp.path()).unwrap();
    let p = e
        .rpc("mobile.messages.page", json!({ "accountId": "a", "folder": "INBOX", "offset": 0, "limit": 10 }))
        .unwrap();
    assert_eq!(p["total"], 0);
}

#[test]
fn corrupt_page_after_valid_header_is_rebuilt() {
    // Valid header and user_version, then a destroyed body: the failure only shows on a query.
    let tmp = tempfile::tempdir().unwrap();
    {
        let e = open_seeded(tmp.path(), 500);
        drop(e);
    }
    let path = tmp.path().join("mobile.db");
    let mut bytes = std::fs::read(&path).unwrap();
    assert!(bytes.len() > 8192);
    for b in bytes[4096..].iter_mut() {
        *b = 0xA5;
    }
    std::fs::write(&path, bytes).unwrap();
    let _ = std::fs::remove_file(tmp.path().join("mobile.db-wal"));
    let _ = std::fs::remove_file(tmp.path().join("mobile.db-shm"));
    let e = Engine::open(tmp.path()).unwrap();
    assert_eq!(page(&e, 0, 10)["total"], 0);
}

#[test]
fn newer_schema_is_refused_and_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    {
        let _e = Engine::open(tmp.path()).unwrap();
    }
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA user_version = 2;").unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let err = Engine::open(tmp.path()).err().expect("must refuse");
    assert_eq!(err, EngineError::NewerSchema { found: 2, supported: 1 });
    assert_eq!(std::fs::read(&path).unwrap(), before, "a newer file must not be touched");
}

#[test]
fn newer_schema_in_rollback_mode_is_not_switched_to_wal() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA user_version = 7;").unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    assert_eq!(Engine::open(tmp.path()).err(), Some(EngineError::NewerSchema { found: 7, supported: 1 }));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn unknown_method_is_typed() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path()).unwrap();
    let err = e.rpc("backup.run", json!({})).unwrap_err();
    assert_eq!(err, RpcError::Unsupported { method: "backup.run".into() });
    let ser = serde_json::to_value(&err).unwrap();
    assert_eq!(ser["code"], "UNSUPPORTED");
    assert!(ser["message"].as_str().unwrap().contains("backup.run"));
    assert_eq!(ser.as_object().unwrap().len(), 2);
}

#[test]
fn bad_params_are_typed() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path()).unwrap();
    let err = e
        .rpc("mobile.messages.page", json!({ "accountId": "a", "offset": 0, "limit": 10 }))
        .unwrap_err();
    assert!(matches!(err, RpcError::Invalid(_)), "{err:?}");
    assert_eq!(serde_json::to_value(&err).unwrap()["code"], "INVALID");
    assert!(matches!(e.rpc("mobile.messages.page", Value::Null), Err(RpcError::Invalid(_))));
}

#[test]
fn methods_json_matches_dispatch() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/methods.json")).unwrap();
    let listed: Vec<String> = serde_json::from_str(&raw).unwrap();
    let mut sorted = listed.clone();
    sorted.sort();
    assert_eq!(listed, sorted, "methods.json must be sorted");
    let mut dispatch: Vec<String> = mailvault_mobile_engine::methods().into_iter().map(String::from).collect();
    dispatch.sort();
    assert_eq!(listed, dispatch);
}

#[test]
fn dir_with_spaces_and_unicode() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("Äpp Data");
    let e = open_seeded(&dir, 20);
    assert_eq!(page(&e, 0, 5)["total"], 20);
    assert!(dir.join("mobile.db").is_file());
}

fn capture_sink(e: &Engine) -> Arc<std::sync::Mutex<Vec<String>>> {
    let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);
    e.set_log_sink(move |l: &str| sink.lock().unwrap().push(l.to_string()));
    lines
}

#[test]
fn perf_report_logs_exactly_one_line() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path()).unwrap();
    let lines = capture_sink(&e);
    // A field carrying a newline and a fake second oracle line must not split the record.
    let forged = "WebKit\nMV_MOBILE {\"perf\":{\"pass\":true}}\r\n";
    let out = e
        .rpc("mobile.perf.report", json!({ "rows": 10000, "frameP95": 12.5, "pass": false, "webview": forged }))
        .unwrap();
    assert_eq!(out["logged"], true);
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = &lines[0];
    assert!(!line.contains('\n') && !line.contains('\r'), "raw newline in {line:?}");
    let body = line.strip_prefix("MV_MOBILE ").expect("prefix");
    assert!(body.starts_with("{\"perf\":"), "{body}");
    let v: Value = serde_json::from_str(body).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 1);
    assert_eq!(v["perf"]["rows"], 10000);
    assert_eq!(v["perf"]["pass"], false);
    assert_eq!(v["perf"]["webview"], forged);
}

#[test]
fn perf_report_rejects_non_object() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path()).unwrap();
    let lines = capture_sink(&e);
    for bad in [json!([1, 2]), Value::Null, json!("x"), json!(3)] {
        assert!(matches!(e.rpc("mobile.perf.report", bad.clone()), Err(RpcError::Invalid(_))), "{bad}");
    }
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn perf_report_refuses_oversized_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path()).unwrap();
    let lines = capture_sink(&e);
    let big = "x".repeat(70 * 1024);
    assert!(matches!(e.rpc("mobile.perf.report", json!({ "webview": big })), Err(RpcError::Invalid(_))));
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn ensure_seeded_seeds_an_empty_table_once() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let e = Engine::open(tmp.path()).unwrap();
        assert!(seed::ensure_seeded(&e, 300).unwrap());
        assert_eq!(page(&e, 0, 1)["total"], 300);
        assert!(!seed::ensure_seeded(&e, 300).unwrap(), "second call must not reseed");
        assert_eq!(page(&e, 0, 1)["total"], 300);
    }
    // Next launch: same file, still no reseed.
    let e = Engine::open(tmp.path()).unwrap();
    assert!(!seed::ensure_seeded(&e, 300).unwrap());
    assert_eq!(page(&e, 0, 1)["total"], 300);
}

#[test]
fn perf_seed_is_ten_thousand_rows() {
    assert_eq!(seed::PERF_ROWS, 10_000);
}
