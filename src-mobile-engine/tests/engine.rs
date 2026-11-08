//! Engine tests that build without features. The perf-gate seed and `mobile.perf.report` are in
//! `perf_gate.rs`, which needs `--features perf-gate`.

use mailvault_mobile_engine::{Engine, EngineError, MemorySecrets, RpcError};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// Opens the engine with an in-memory secret store and the cache dir under `dir`.
fn open(dir: &Path) -> Result<Engine, EngineError> {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default()))
}

const ACCOUNT_ID: &str = "test-account";
const FOLDER: &str = "INBOX";

/// One cursor page of [`ACCOUNT_ID`] / [`FOLDER`]; `cursor` is `null` for the first.
fn page(e: &Engine, cursor: Value, limit: u64) -> Value {
    e.rpc(
        "mobile.messages.page",
        json!({ "accountId": ACCOUNT_ID, "folder": FOLDER, "cursor": cursor, "limit": limit }),
    )
    .unwrap()
}

/// Opens the engine and writes `n` rows straight into its mobile.db through a second connection,
/// so these tests need no perf-gate seed. Dates are shuffled against uid.
fn open_seeded(dir: &std::path::Path, n: usize) -> Engine {
    let e = open(dir).unwrap();
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
fn open_creates_schema_v4_in_wal() {
    let tmp = tempfile::tempdir().unwrap();
    let _e = open(tmp.path()).unwrap();
    let path = tmp.path().join("mobile.db");
    assert!(path.is_file());
    let c = Connection::open(&path).unwrap();
    let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    let ver: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(ver, 4);
    let pong = _e.rpc("mobile.ping", json!({})).unwrap();
    assert_eq!(pong["schema"], 4);
    assert_eq!(pong["engine"], env!("CARGO_PKG_VERSION"));
    // The page enables its test hooks (`?ui=viewer`, the network probe) only on a perf-gate build.
    assert_eq!(pong["perfGate"], cfg!(feature = "perf-gate"));
}

#[test]
fn page_returns_newest_first_and_total() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 250);
    let p = page(&e, Value::Null, 60);
    let rows = p["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 60);
    assert_eq!(p["total"], 250);
    let dates: Vec<i64> = rows.iter().map(|r| r["dateMs"].as_i64().unwrap()).collect();
    assert!(dates.windows(2).all(|w| w[0] >= w[1]), "not newest first: {dates:?}");
    // 60 + 60 + 60 + 60 + 10: the last page is short and has no next cursor.
    let mut last = p.clone();
    for _ in 0..4 {
        last = page(&e, last["nextCursor"].clone(), 60);
    }
    assert_eq!(last["rows"].as_array().unwrap().len(), 10);
    assert_eq!(last["total"], 250);
    assert!(last["nextCursor"].is_null());
    let r = &rows[0];
    for k in ["uid", "subject", "fromName", "fromAddress", "dateMs", "snippet", "seen", "flagged", "hasAttachments"] {
        assert!(r.get(k).is_some(), "missing {k}");
    }
}

#[test]
fn page_caps_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 250);
    assert_eq!(page(&e, Value::Null, 1000)["rows"].as_array().unwrap().len(), 200);
}

#[test]
fn corrupt_db_is_rebuilt() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("mobile.db"), b"this is not a sqlite database, just garbage bytes").unwrap();
    let e = open(tmp.path()).unwrap();
    let p = e
        .rpc("mobile.messages.page", json!({ "accountId": "a", "folder": "INBOX", "cursor": null, "limit": 10 }))
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
    let e = open(tmp.path()).unwrap();
    assert_eq!(page(&e, Value::Null, 10)["total"], 0);
}

/// Every table of schema 3.
const V3_TABLES: [&str; 13] = [
    "accounts",
    "folders",
    "messages",
    "bodies",
    "attachments",
    "pending_actions",
    "remote_ids",
    "uid_seq",
    "outbox",
    "drafts",
    "settings",
    "notify_state",
    "sync_state",
];

/// Schema 2 exactly as Plan 2 shipped it: the fixture for the forward step.
const SHIPPED_V2: &str = "
CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  imap_host    TEXT NOT NULL,
  imap_port    INTEGER NOT NULL,
  security     TEXT NOT NULL,
  created_ms   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX accounts_by_email ON accounts (email COLLATE NOCASE);
CREATE TABLE folders (
  account_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  special_use TEXT,
  delimiter   TEXT,
  noselect    INTEGER NOT NULL DEFAULT 0,
  uid_validity INTEGER,
  uid_next    INTEGER,
  unseen      INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  synced_ms   INTEGER,
  PRIMARY KEY (account_id, path)
) WITHOUT ROWID;
CREATE TABLE messages (
  account_id      TEXT NOT NULL,
  folder          TEXT NOT NULL,
  uid             INTEGER NOT NULL,
  subject         TEXT NOT NULL,
  from_name       TEXT NOT NULL,
  from_address    TEXT NOT NULL,
  date_ms         INTEGER NOT NULL,
  snippet         TEXT NOT NULL,
  seen            INTEGER NOT NULL,
  flagged         INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  message_id      TEXT NOT NULL DEFAULT '',
  to_json         TEXT NOT NULL DEFAULT '[]',
  size            INTEGER NOT NULL DEFAULT 0,
  local_seen      INTEGER,
  local_flagged   INTEGER,
  local_deleted   INTEGER,
  list_gen        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder, uid)
) WITHOUT ROWID;
CREATE INDEX messages_by_date ON messages (account_id, folder, date_ms DESC, uid DESC);
CREATE TABLE bodies (
  account_id     TEXT NOT NULL,
  folder         TEXT NOT NULL,
  uid            INTEGER NOT NULL,
  html           TEXT,
  text           TEXT,
  parts_json     TEXT,
  bytes          INTEGER NOT NULL DEFAULT 0,
  last_access_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder, uid)
) WITHOUT ROWID;
CREATE TABLE attachments (
  account_id TEXT NOT NULL,
  folder     TEXT NOT NULL,
  uid        INTEGER NOT NULL,
  section    TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  encoding   TEXT,
  PRIMARY KEY (account_id, folder, uid, section)
) WITHOUT ROWID;
CREATE TABLE pending_actions (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  folder     TEXT NOT NULL,
  uids_json  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  arg        TEXT,
  state      TEXT NOT NULL DEFAULT 'queued',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_ms INTEGER NOT NULL
);
";

/// `(table, column, type, notnull, default)` for every table, sorted: what two files must share to
/// have the same schema.
fn columns(c: &Connection) -> Vec<(String, String, String, bool, Option<String>)> {
    let mut out = Vec::new();
    for t in V3_TABLES {
        let mut st = c.prepare(&format!("PRAGMA table_info({t})")).unwrap();
        let rows = st
            .query_map([], |r| Ok((t.to_string(), r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?, r.get::<_, Option<String>>(4)?)))
            .unwrap();
        out.extend(rows.map(Result::unwrap));
    }
    out.sort();
    out
}

/// A v3 file from before `messages.thread_json` joined the v3 step gains the column on open and
/// keeps its rows.
#[test]
fn an_early_v3_file_gains_thread_json() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    drop(open_seeded(tmp.path(), 3));
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("ALTER TABLE messages DROP COLUMN thread_json;").unwrap();
    }
    let e = open(tmp.path()).unwrap();
    assert_eq!(page(&e, Value::Null, 10)["total"], 3);
    let c = Connection::open(&path).unwrap();
    let thread: String = c.query_row("SELECT thread_json FROM messages LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(thread, "{}");
}

#[test]
fn a_v2_file_migrates_to_v3_and_keeps_its_accounts() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        c.execute_batch(SHIPPED_V2).unwrap();
        c.execute_batch(
            "INSERT INTO accounts VALUES ('acc_0123456789abcdef','u@example.test','U','imap.example.test',993,'ssl',1);
             INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
               VALUES ('acc_0123456789abcdef','INBOX',7,'kept','n','n@example.test',1,'',0,0,0);
             INSERT INTO pending_actions (account_id, folder, uids_json, kind, created_ms)
               VALUES ('acc_0123456789abcdef','INBOX','[7]','seen',1);
             PRAGMA user_version = 2;",
        )
        .unwrap();
    }
    let e = open(tmp.path()).unwrap();
    let c = Connection::open(&path).unwrap();
    let ver: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(ver, 4);
    let row: (String, String, String, String, i64, Option<String>, Option<String>) = c
        .query_row(
            "SELECT id, email, kind, auth, needs_auth, provider, smtp_host FROM accounts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .unwrap();
    assert_eq!(row, ("acc_0123456789abcdef".into(), "u@example.test".into(), "imap".into(), "password".into(), 0, None, None));
    assert_eq!(e.account_ids().unwrap(), vec!["acc_0123456789abcdef".to_string()]);
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    assert_eq!(list["accounts"].as_array().unwrap().len(), 1, "{list}");
    // The step is forward only: the mail cache and the journal survive it too.
    let p = e
        .rpc("mobile.messages.page", json!({ "accountId": "acc_0123456789abcdef", "folder": "INBOX", "cursor": null, "limit": 10 }))
        .unwrap();
    assert_eq!(p["total"], 1);
    let journal: i64 = c.query_row("SELECT count(*) FROM pending_actions", [], |r| r.get(0)).unwrap();
    assert_eq!(journal, 1);
    for t in ["remote_ids", "uid_seq", "outbox", "drafts", "settings", "notify_state", "sync_state"] {
        let n: i64 = c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{t}");
    }
    // A migrated file and a new one have the same tables and columns.
    let fresh = tempfile::tempdir().unwrap();
    drop(open(fresh.path()).unwrap());
    let f = Connection::open(fresh.path().join("mobile.db")).unwrap();
    assert_eq!(columns(&c), columns(&f));
}

#[test]
fn outbox_state_is_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let _e = open(tmp.path()).unwrap();
    let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    let insert = |id: &str, state: &str| {
        c.execute(
            "INSERT INTO outbox (id, account_id, draft_json, state, created_ms, updated_ms) VALUES (?1, 'a', '{}', ?2, 1, 1)",
            (id, state),
        )
    };
    for (i, s) in ["queued", "sending", "sent", "failed", "uncertain"].iter().enumerate() {
        insert(&format!("o{i}"), s).unwrap();
    }
    assert!(insert("bad", "lost").is_err());
}

#[test]
fn settings_round_trip_and_survive_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let e = open(tmp.path()).unwrap();
        assert_eq!(e.setting("secrets.policy").unwrap(), None);
        e.set_setting("secrets.policy", "afu1").unwrap();
        e.set_setting("secrets.policy", "afu1").unwrap();
        assert_eq!(e.setting("secrets.policy").unwrap().as_deref(), Some("afu1"));
    }
    let e = open(tmp.path()).unwrap();
    assert_eq!(e.setting("secrets.policy").unwrap().as_deref(), Some("afu1"));
}

#[test]
fn a_v1_file_is_still_dropped_and_rebuilt() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE messages (
               account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, subject TEXT NOT NULL,
               from_name TEXT NOT NULL, from_address TEXT NOT NULL, date_ms INTEGER NOT NULL, snippet TEXT NOT NULL,
               seen INTEGER NOT NULL, flagged INTEGER NOT NULL, has_attachments INTEGER NOT NULL,
               PRIMARY KEY (account_id, folder, uid)) WITHOUT ROWID;
             CREATE INDEX messages_by_date ON messages (account_id, folder, date_ms DESC, uid DESC);
             INSERT INTO messages VALUES ('a','INBOX',1,'s','n','n@example.test',1,'',0,0,0);
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let e = open(tmp.path()).unwrap();
    let c = Connection::open(&path).unwrap();
    let ver: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(ver, 4);
    assert_eq!(e.rpc("mobile.messages.page", json!({ "accountId": "a", "folder": "INBOX", "cursor": null, "limit": 10 })).unwrap()["total"], 0);
    for t in V3_TABLES {
        let n: i64 = c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{t}");
    }
}

#[test]
fn a_v4_file_is_refused_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    {
        let _e = open(tmp.path()).unwrap();
    }
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA user_version = 5;").unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let err = open(tmp.path()).err().expect("must refuse");
    assert_eq!(err, EngineError::NewerSchema { found: 5, supported: 4 });
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
    assert_eq!(open(tmp.path()).err(), Some(EngineError::NewerSchema { found: 7, supported: 4 }));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn unknown_method_is_typed() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path()).unwrap();
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
    let e = open(tmp.path()).unwrap();
    let err = e
        .rpc("mobile.messages.page", json!({ "accountId": "a", "cursor": null, "limit": 10 }))
        .unwrap_err();
    assert!(matches!(err, RpcError::Invalid(_)), "{err:?}");
    assert_eq!(serde_json::to_value(&err).unwrap()["code"], "INVALID");
    assert!(matches!(e.rpc("mobile.messages.page", Value::Null), Err(RpcError::Invalid(_))));
}

#[test]
fn offset_form_is_refused() {
    // The Plan 1 `{offset, limit}` form is gone. A caller still sending it must fail loudly, not
    // get the first page back on every call.
    let tmp = tempfile::tempdir().unwrap();
    let e = open_seeded(tmp.path(), 20);
    for params in [
        json!({ "accountId": ACCOUNT_ID, "folder": FOLDER, "offset": 0, "limit": 10 }),
        json!({ "accountId": ACCOUNT_ID, "folder": FOLDER, "offset": null, "limit": 10 }),
        json!({ "accountId": ACCOUNT_ID, "folder": FOLDER, "cursor": null, "offset": 10, "limit": 10 }),
    ] {
        let err = e.rpc("mobile.messages.page", params.clone()).unwrap_err();
        assert!(matches!(err, RpcError::Invalid(_)), "{params}: {err:?}");
    }
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
    // methods.json is the perf-gate build's table; a build without it lacks the perf report and
    // the debug methods.
    let perf_gate_only = |m: &str| m == "mobile.perf.report" || m.starts_with("mobile.debug.");
    let expected: Vec<String> = if cfg!(feature = "perf-gate") {
        listed.clone()
    } else {
        listed.iter().filter(|m| !perf_gate_only(m)).cloned().collect()
    };
    assert!(listed.iter().any(|m| m == "mobile.perf.report"), "methods.json must list mobile.perf.report");
    for m in [
        "mobile.compose.prepare",
        "mobile.compose.send",
        "mobile.drafts.delete",
        "mobile.drafts.get",
        "mobile.drafts.list",
        "mobile.drafts.save",
        "mobile.outbox.discard",
        "mobile.outbox.list",
        "mobile.outbox.retry",
    ] {
        assert!(listed.iter().any(|l| l == m), "methods.json must list {m}");
    }
    assert_eq!(expected, dispatch);
}

#[test]
fn dir_with_spaces_and_unicode() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("Äpp Data");
    let e = open_seeded(&dir, 20);
    assert_eq!(page(&e, Value::Null, 5)["total"], 20);
    assert!(dir.join("mobile.db").is_file());
}

#[test]
fn events_json_matches_emitted_names() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/events.json")).unwrap();
    let listed: Vec<String> = serde_json::from_str(&raw).unwrap();
    let mut sorted = listed.clone();
    sorted.sort();
    assert_eq!(listed, sorted, "events.json must be sorted");
    let mut emitted: Vec<String> = mailvault_mobile_engine::events::EVENTS.iter().map(|s| s.to_string()).collect();
    emitted.sort();
    assert_eq!(listed, emitted);
    assert!(listed.iter().any(|e| e == "mobile.send.result"), "events.json must list mobile.send.result");
    // Every name a worker emits is one of them: emit sites take the named constants.
    for file in ["sync.rs", "actions.rs", "attachments.rs", "outbox.rs", "compose.rs"] {
        let src = std::fs::read_to_string(format!("{}/src/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert!(!src.contains("emit(\""), "{file}: emit with a string literal bypasses events::EVENTS");
    }
}

/// Schema 3 to 4 adds the background run's dedupe table and the watermark's generation and
/// baseline time; accounts, drafts, the outbox, settings and the watermarks stay.
#[test]
fn a_v3_file_migrates_to_v4_and_keeps_its_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("mobile.db");
    {
        let e = open(tmp.path()).unwrap();
        drop(e);
        let c = Connection::open(&path).unwrap();
        // Back to what a v3 build wrote.
        c.execute_batch(
            "DROP TABLE notified;
             DROP TABLE notify_state;
             CREATE TABLE notify_state (account_id TEXT NOT NULL, folder TEXT NOT NULL, last_uid INTEGER NOT NULL,
               PRIMARY KEY (account_id, folder)) WITHOUT ROWID;
             INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
               VALUES ('acc_0123456789abcdef','u@example.test','U','imap.example.test',993,'ssl',1);
             INSERT INTO notify_state VALUES ('acc_0123456789abcdef', 'INBOX', 41);
             INSERT INTO settings VALUES ('notifications', 'on');
             PRAGMA user_version = 3;",
        )
        .unwrap();
    }
    let e = open(tmp.path()).unwrap();
    assert!(e.notifications_on());
    let c = Connection::open(&path).unwrap();
    let ver: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(ver, 4);
    let mark: (i64, Option<i64>) =
        c.query_row("SELECT last_uid, uid_validity FROM notify_state WHERE account_id = 'acc_0123456789abcdef'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(mark, (41, None));
    let n: i64 = c.query_row("SELECT count(*) FROM notified", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    assert_eq!(c.query_row("SELECT count(*) FROM accounts", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}
