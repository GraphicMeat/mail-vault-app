//! The app-data store's file: `<app_data_dir>/app.db`.
//!
//! Everything the app keeps *about itself* rather than about the mail — where
//! the vault is, the security-scoped bookmarks that reach it, wire-byte
//! counters, classification state, and the journals of work confirmed but not
//! yet done. Before this it was eleven JSON files in the same directory.
//!
//! Open discipline deliberately differs from `custody::db` and
//! `search_index::db`: **no `locking_mode=EXCLUSIVE` and a non-zero
//! `busy_timeout`**, because two processes hold this one at once. The app
//! creates the macOS security-scoped bookmark and has to read it back at
//! launch to hand the daemon access to the vault — so the app cannot wait for
//! the daemon to exist, and the daemon cannot own the file exclusively. WAL's
//! `-shm` is fine here: unlike the vault, the app data dir is always local.
//!
//! Never deleted or rewritten on a read error. `pending_ops` and
//! `pending_backup_purge` are work the user already confirmed; losing them
//! silently is worse than reporting an unreadable store.

use rusqlite::{Connection, ErrorCode, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

pub const DB_FILE: &str = "app.db";
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = "
CREATE TABLE external_locations (
  slot         TEXT PRIMARY KEY,
  display_path TEXT NOT NULL,
  platform     TEXT NOT NULL,
  saved_at     INTEGER NOT NULL,
  legacy       INTEGER NOT NULL DEFAULT 0,
  -- NULL when only the metadata could be saved (bookmark creation failed, or
  -- a legacy raw path awaiting re-authorization): the old code told those
  -- apart by `<slot>-bookmark` being absent while `<slot>-meta.json` was not.
  bookmark     BLOB
);
CREATE TABLE transfer_stats (
  account_id TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL,
  down INTEGER NOT NULL, up INTEGER NOT NULL,
  PRIMARY KEY (account_id, day, source)
);
CREATE TABLE classifications (
  account_id TEXT NOT NULL, email_key TEXT NOT NULL, entry_json TEXT NOT NULL,
  PRIMARY KEY (account_id, email_key)
);
CREATE TABLE classification_models (
  account_id TEXT PRIMARY KEY, model_json TEXT NOT NULL
);
CREATE TABLE classification_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  item_json  TEXT NOT NULL
);
CREATE INDEX classification_queue_key ON classification_queue(dedupe_key);
CREATE TABLE pending_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL, account_id TEXT NOT NULL, mailbox TEXT NOT NULL,
  uids_json  TEXT NOT NULL, arg_json TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE pending_backup_purge (
  scope TEXT NOT NULL, uid INTEGER NOT NULL,
  PRIMARY KEY (scope, uid)
);
";

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// Not a database this build can read. Left exactly as it is.
    Corrupt(String),
    /// Written by a newer app. Left as it is for that app.
    Newer(i64),
    /// Locked by another process, permission, read-only volume, ...
    Io(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Corrupt(e) => write!(f, "app store unreadable: {e}"),
            OpenError::Newer(v) => write!(f, "app store schema {v} is newer than this app ({SCHEMA_VERSION})"),
            OpenError::Io(e) => write!(f, "{e}"),
        }
    }
}

pub fn db_path(app_dir: &Path) -> PathBuf {
    app_dir.join(DB_FILE)
}

fn sql(e: rusqlite::Error) -> OpenError {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => OpenError::Corrupt(e.to_string()),
        _ => OpenError::Io(e.to_string()),
    }
}

/// One connection per app data dir, per process. Keyed by path so a test with
/// its own temp dir never shares the production handle.
static HANDLES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<Connection>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The process-wide handle for `app_dir`, opening (and migrating, and
/// importing the legacy JSON) on first use.
pub fn handle(app_dir: &Path) -> Result<Arc<Mutex<Connection>>, OpenError> {
    let key = app_dir.to_path_buf();
    if let Some(existing) = HANDLES.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return Ok(Arc::clone(existing));
    }
    let conn = open(app_dir)?;
    super::import::run(&conn, app_dir);
    let shared = Arc::new(Mutex::new(conn));
    HANDLES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(key)
        .or_insert_with(|| Arc::clone(&shared));
    Ok(shared)
}

/// Run `f` against the app store. `Err` carries the open failure's message;
/// no caller of this store has anything better to do with a failed open than
/// report it, so the error type collapses to `String` here.
pub fn with<T>(app_dir: &Path, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let shared = handle(app_dir).map_err(|e| e.to_string())?;
    let guard = shared.lock().unwrap_or_else(|p| p.into_inner());
    f(&guard)
}

/// Open, creating the file and its schema when there is none. Never deletes,
/// truncates or rewrites a file it cannot read.
pub fn open(app_dir: &Path) -> Result<Connection, OpenError> {
    std::fs::create_dir_all(app_dir)
        .map_err(|e| OpenError::Io(format!("create {}: {e}", app_dir.display())))?;
    let conn = Connection::open(db_path(app_dir)).map_err(sql)?;
    // Two processes share this file, so a BUSY has to be waited out rather
    // than reported (the opposite of `custody::db`, which one process owns).
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(sql)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(OpenError::Io(format!("journal_mode stayed {mode}")));
    }
    conn.execute_batch("PRAGMA synchronous=NORMAL;").map_err(sql)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Schema changes go through `meta.schema_version` with ordered steps here;
/// each new step gets a test from the previous version's DDL.
fn migrate(conn: &Connection) -> Result<(), OpenError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(sql)?;
    let version = meta_get(conn, "schema_version").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(OpenError::Newer(version));
    }
    if version < 1 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V1} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1'); COMMIT;"
        ))
        .map_err(sql)?;
    }
    Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", [key, value])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn meta_clear(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key]).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-appdb-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn open_creates_the_schema_and_is_idempotent() {
        let dir = scratch("create");
        let conn = open(&dir).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("1"));
        drop(conn);
        let again = open(&dir).unwrap();
        assert_eq!(meta_get(&again, "schema_version").as_deref(), Some("1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_schema_is_left_alone() {
        let dir = scratch("newer");
        {
            let conn = open(&dir).unwrap();
            meta_set(&conn, "schema_version", "99").unwrap();
        }
        assert!(matches!(open(&dir), Err(OpenError::Newer(99))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_not_a_database_is_reported_never_replaced() {
        let dir = scratch("corrupt");
        std::fs::write(db_path(&dir), b"this is not a database at all, not even close").unwrap();
        assert!(matches!(open(&dir), Err(OpenError::Corrupt(_))));
        assert_eq!(
            std::fs::read(db_path(&dir)).unwrap(),
            b"this is not a database at all, not even close"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_opens_of_one_dir_share_one_handle() {
        let dir = scratch("handle");
        let a = handle(&dir).unwrap();
        let b = handle(&dir).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_store_is_not_opened_exclusively_so_a_second_connection_can_write() {
        // The app writes the bookmark the daemon needs before the daemon is
        // up; `custody::db`'s EXCLUSIVE discipline would deadlock that.
        let dir = scratch("shared");
        let first = open(&dir).unwrap();
        let second = open(&dir).unwrap();
        meta_set(&first, "a", "1").unwrap();
        meta_set(&second, "b", "2").unwrap();
        assert_eq!(meta_get(&first, "b").as_deref(), Some("2"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
