//! Engine tests that build without features. The perf-gate seed and `mobile.perf.report` are in
//! `perf_gate.rs`, which needs `--features perf-gate`.

use mailvault_mobile_engine::{Engine, EngineError, RpcError};
use rusqlite::Connection;
use serde_json::{json, Value};

const ACCOUNT_ID: &str = "test-account";
const FOLDER: &str = "INBOX";

fn page(e: &Engine, offset: u64, limit: u64) -> Value {
    e.rpc(
        "mobile.messages.page",
        json!({ "accountId": ACCOUNT_ID, "folder": FOLDER, "offset": offset, "limit": limit }),
    )
    .unwrap()
}

/// Opens the engine and writes `n` rows straight into its mobile.db through a second connection,
/// so these tests need no perf-gate seed. Dates are shuffled against uid.
fn open_seeded(dir: &std::path::Path, n: usize) -> Engine {
    let e = Engine::open(dir).unwrap();
    let mut c = Connection::open(dir.join("mobile.db")).unwrap();
    c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let tx = c.transaction().unwrap();
    for uid in 1..=n as i64 {
        tx.execute(
            "INSERT INTO messages
             (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
             VALUES (?1, ?2, ?3, ?4, 'Ūla Žemaitė', 'ula@example.test', ?5, ?6, ?7, 0, 0)",
            (
                ACCOUNT_ID,
                FOLDER,
                uid,
                format!("subject {uid}"),
                1_700_000_000_000 + (uid * 7919) % 100_003,
                format!("snippet for row {uid}, long enough to fill pages"),
                uid % 2,
            ),
        )
        .unwrap();
    }
    tx.commit().unwrap();
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
    // methods.json is the perf-gate build's table; a build without it lacks only the perf report.
    let expected: Vec<String> = if cfg!(feature = "perf-gate") {
        listed.clone()
    } else {
        listed.iter().filter(|m| *m != "mobile.perf.report").cloned().collect()
    };
    assert!(listed.iter().any(|m| m == "mobile.perf.report"), "methods.json must list mobile.perf.report");
    assert_eq!(expected, dispatch);
}

#[test]
fn dir_with_spaces_and_unicode() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("Äpp Data");
    let e = open_seeded(&dir, 20);
    assert_eq!(page(&e, 0, 5)["total"], 20);
    assert!(dir.join("mobile.db").is_file());
}
