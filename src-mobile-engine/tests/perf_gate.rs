//! Perf-gate only: the synthetic seed and `mobile.perf.report`. Built only with
//! `--features perf-gate` (`required-features` in Cargo.toml).

use mailvault_mobile_engine::{seed, Engine, EngineError, MemorySecrets, RpcError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// Opens the engine with an in-memory secret store and the cache dir under `dir`.
fn open(dir: &Path) -> Result<Engine, EngineError> {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default()))
}

fn page(e: &Engine, offset: u64, limit: u64) -> Value {
    e.rpc(
        "mobile.messages.page",
        json!({ "accountId": seed::ACCOUNT_ID, "folder": seed::FOLDER, "offset": offset, "limit": limit }),
    )
    .unwrap()
}

fn open_seeded(dir: &std::path::Path, n: usize) -> Engine {
    let e = open(dir).unwrap();
    seed::seed(&e, n).unwrap();
    e
}

#[test]
fn seeded_page_is_newest_first() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 250);
    let p = page(&e, 0, 200);
    let rows = p["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 200);
    assert_eq!(p["total"], 250);
    let dates: Vec<i64> = rows.iter().map(|r| r["dateMs"].as_i64().unwrap()).collect();
    assert!(dates.windows(2).all(|w| w[0] >= w[1]), "not newest first: {dates:?}");
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
    let e = open(tmp.path()).unwrap();
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
    let e = open(tmp.path()).unwrap();
    let lines = capture_sink(&e);
    for bad in [json!([1, 2]), Value::Null, json!("x"), json!(3)] {
        assert!(matches!(e.rpc("mobile.perf.report", bad.clone()), Err(RpcError::Invalid(_))), "{bad}");
    }
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn perf_report_refuses_oversized_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path()).unwrap();
    let lines = capture_sink(&e);
    let big = "x".repeat(70 * 1024);
    assert!(matches!(e.rpc("mobile.perf.report", json!({ "webview": big })), Err(RpcError::Invalid(_))));
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn ensure_seeded_seeds_an_empty_table_once() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let e = open(tmp.path()).unwrap();
        assert!(seed::ensure_seeded(&e, 300).unwrap());
        assert_eq!(page(&e, 0, 1)["total"], 300);
        assert!(!seed::ensure_seeded(&e, 300).unwrap(), "second call must not reseed");
        assert_eq!(page(&e, 0, 1)["total"], 300);
    }
    // Next launch: same file, still no reseed.
    let e = open(tmp.path()).unwrap();
    assert!(!seed::ensure_seeded(&e, 300).unwrap());
    assert_eq!(page(&e, 0, 1)["total"], 300);
}

/// Every row of the seed account, keyed by uid.
fn all_rows(e: &Engine) -> std::collections::BTreeMap<i64, Value> {
    let total = page(e, 0, 1)["total"].as_u64().unwrap();
    let mut out = std::collections::BTreeMap::new();
    let mut offset = 0;
    while offset < total {
        for r in page(e, offset, 200)["rows"].as_array().unwrap() {
            out.insert(r["uid"].as_i64().unwrap(), r.clone());
        }
        offset += 200;
    }
    out
}

#[test]
fn ensure_seeded_tops_up_a_smaller_table() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 250);
    let before = all_rows(&e);
    assert_eq!(before.len(), 250);
    assert!(seed::ensure_seeded(&e, 1000).unwrap(), "250 < 1000 must top up");
    let after = all_rows(&e);
    assert_eq!(after.len(), 1000);
    // The deterministic seed rewrites uids 1..=250 with the same values.
    for (uid, row) in &before {
        assert_eq!(after.get(uid), Some(row), "uid {uid} changed");
    }
    assert!(!seed::ensure_seeded(&e, 1000).unwrap(), "already at target");
    // A table above the target is left alone.
    assert!(!seed::ensure_seeded(&e, 500).unwrap());
    assert_eq!(page(&e, 0, 1)["total"], 1000);
}

#[test]
fn perf_seed_is_ten_thousand_rows() {
    assert_eq!(seed::PERF_ROWS, 10_000);
}
