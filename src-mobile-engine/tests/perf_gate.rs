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

/// One cursor page of the seed list; `cursor` is `null` for the first.
fn page(e: &Engine, cursor: Value, limit: u64) -> Value {
    e.rpc(
        "mobile.messages.page",
        json!({ "accountId": seed::ACCOUNT_ID, "folder": seed::FOLDER, "cursor": cursor, "limit": limit }),
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
    let p = page(&e, Value::Null, 200);
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
        assert_eq!(page(&e, Value::Null, 1)["total"], 300);
        assert!(!seed::ensure_seeded(&e, 300).unwrap(), "second call must not reseed");
        assert_eq!(page(&e, Value::Null, 1)["total"], 300);
    }
    // Next launch: same file, still no reseed.
    let e = open(tmp.path()).unwrap();
    assert!(!seed::ensure_seeded(&e, 300).unwrap());
    assert_eq!(page(&e, Value::Null, 1)["total"], 300);
}

/// Every row of the seed account, keyed by uid.
fn all_rows(e: &Engine) -> std::collections::BTreeMap<i64, Value> {
    let mut out = std::collections::BTreeMap::new();
    let mut cursor = Value::Null;
    loop {
        let p = page(e, cursor, 200);
        for r in p["rows"].as_array().unwrap() {
            out.insert(r["uid"].as_i64().unwrap(), r.clone());
        }
        if p["nextCursor"].is_null() {
            break;
        }
        cursor = p["nextCursor"].clone();
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
    assert_eq!(page(&e, Value::Null, 1)["total"], 1000);
}

#[test]
fn perf_seed_is_ten_thousand_rows() {
    assert_eq!(seed::PERF_ROWS, 10_000);
}

#[test]
fn seed_pages_by_cursor() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 1_000);
    let mut cursor = Value::Null;
    let mut keys: Vec<(i64, i64)> = Vec::new();
    loop {
        let p = e
            .rpc(
                "mobile.messages.page",
                json!({ "accountId": seed::ACCOUNT_ID, "folder": seed::FOLDER, "cursor": cursor, "limit": 200 }),
            )
            .unwrap();
        assert_eq!(p["total"], 1_000);
        keys.extend(p["rows"].as_array().unwrap().iter().map(|r| (r["dateMs"].as_i64().unwrap(), r["uid"].as_i64().unwrap())));
        if p["nextCursor"].is_null() {
            break;
        }
        cursor = p["nextCursor"].clone();
    }
    assert_eq!(keys.len(), 1_000);
    assert!(keys.windows(2).all(|w| w[0] > w[1]), "not strictly (dateMs, uid) descending");
}

#[test]
fn ensure_seeded_adds_the_showcase_account_and_folders_once() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path()).unwrap();
    for _ in 0..2 {
        seed::ensure_seeded(&e, 50).unwrap();
        let accounts = e.rpc("mobile.accounts.list", json!({})).unwrap();
        let ids: Vec<&str> = accounts["accounts"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
        // The perf list's account stays first: the app opens the first account.
        assert_eq!(ids, vec![seed::ACCOUNT_ID, seed::SECOND_ACCOUNT_ID]);
        let folders = e.rpc("mobile.folders.list", json!({ "accountId": seed::ACCOUNT_ID })).unwrap();
        let paths: Vec<&str> = folders["folders"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(paths.len(), 9, "{paths:?}");
        assert_eq!(paths[0], "INBOX");
    }
    assert_eq!(page(&e, Value::Null, 1)["total"], 50);
}

/// Screenshot fixtures: the two newest seeded rows answer `mobile.message.body` from the cache,
/// a newsletter (remote images, a tracker, an attachment) and a plain text mail with links.
#[test]
fn ensure_seeded_gives_the_newest_rows_a_showcase_body() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path()).unwrap();
    for _ in 0..2 {
        seed::ensure_seeded(&e, 50).unwrap();
        let rows = page(&e, Value::Null, 4)["rows"].clone();
        let body = |uid: &Value| {
            e.rpc("mobile.message.body", json!({ "accountId": seed::ACCOUNT_ID, "folder": seed::FOLDER, "uid": uid })).unwrap()
        };
        let news = body(&rows[0]["uid"]);
        assert_eq!(news["gone"], false);
        let html = news["html"].as_str().unwrap();
        assert!(html.contains("https://"), "{html}");
        assert!(html.contains("data-mv-tracker-blocked"), "{html}");
        assert!(news["remoteImages"].as_u64().unwrap() >= 1, "{news}");
        assert_eq!(news["trackers"], 1);
        assert_eq!(news["attachments"].as_array().unwrap().len(), 2);
        let plain = body(&rows[1]["uid"]);
        assert!(plain["html"].is_null());
        assert!(plain["text"].as_str().unwrap().contains("https://"));
        let probe = body(&rows[2]["uid"]);
        let html = probe["html"].as_str().unwrap();
        for host in ["127.0.0.1", "10.0.2.2"] {
            assert!(html.contains(&format!("https://{host}:9020/img.png")), "{html}");
        }
        assert!(probe["remoteImages"].as_u64().unwrap() >= 2, "{probe}");
        // Every vector on its own https port, so a logger can tell them apart.
        for port in 9001..=9021 {
            assert!(html.contains(&format!(":{port}/")), "port {port} missing: {html}");
        }
        assert!(!html.contains("http://"), "a plain-http vector would be blocked by the platform, not the frame");
        // A real-world-sized newsletter for the timing of a large open.
        let large = body(&rows[3]["uid"]);
        let large_html = large["html"].as_str().unwrap();
        assert!((200_000..=320_000).contains(&large_html.len()), "{}", large_html.len());
    }
    assert_eq!(page(&e, Value::Null, 1)["total"], 50);
}

#[test]
fn ensure_seeded_caches_the_showcase_pdf_only() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path()).unwrap();
    for _ in 0..2 {
        seed::ensure_seeded(&e, 50).unwrap();
        let uid = page(&e, Value::Null, 1)["rows"][0]["uid"].clone();
        let local = |section: &str| {
            e.rpc("mobile.attachment.local", json!({ "accountId": seed::ACCOUNT_ID, "folder": seed::FOLDER, "uid": uid, "section": section }))
                .unwrap()["path"]
                .clone()
        };
        let path = local("2");
        let bytes = std::fs::read(path.as_str().expect("the pdf is cached")).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.4") && bytes.ends_with(b"%%EOF\n"));
        // The text attachment is left for a real fetch (which fails: no server).
        assert_eq!(local("3"), Value::Null);
        // A finished cache file: the shell may lease it for a share.
        assert!(e.rpc("mobile.attachment.lease", json!({ "path": path })).is_ok());
    }
}

#[test]
fn ping_says_perf_gate() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path()).unwrap();
    assert_eq!(e.rpc("mobile.ping", json!({})).unwrap()["perfGate"], true);
}
