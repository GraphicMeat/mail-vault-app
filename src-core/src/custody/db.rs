//! The custody store's file. Same open discipline as the search index
//! (`crate::search_index::db`): busy_timeout 0, EXCLUSIVE before WAL (no -shm,
//! so a vault on a network volume works), synchronous NORMAL. Differences, on
//! purpose: no `quick_check` (nothing here would act on its answer, and a
//! corrupt page surfaces as `Corrupt` on the first read), and no delete on
//! any error, ever.

use rusqlite::{Connection, ErrorCode, OptionalExtension};
use std::path::{Path, PathBuf};

pub const DB_DIR: &str = "custody";
pub const DB_FILE: &str = "custody.db";
pub const SCHEMA_VERSION: i64 = 2;

const SCHEMA_V1: &str = "
CREATE TABLE vault_entries (
  account_id   TEXT NOT NULL,
  mailbox_path TEXT NOT NULL,
  uid          INTEGER NOT NULL,
  entry_json   TEXT NOT NULL,
  PRIMARY KEY (account_id, mailbox_path, uid)
);
";

const SCHEMA_V2: &str = "
CREATE TABLE header_cache (
  account_id TEXT NOT NULL, mailbox_path TEXT NOT NULL, uid INTEGER NOT NULL,
  sort_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, header_json TEXT NOT NULL,
  PRIMARY KEY (account_id, mailbox_path, uid)
);
CREATE INDEX header_cache_order ON header_cache(account_id, mailbox_path, sort_ms DESC, uid DESC);
CREATE TABLE header_cache_meta (
  account_id TEXT NOT NULL, mailbox_path TEXT NOT NULL, meta_json TEXT NOT NULL,
  PRIMARY KEY (account_id, mailbox_path)
);
CREATE TABLE mailbox_cache (
  account_id TEXT PRIMARY KEY, cache_json TEXT NOT NULL
);
";

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// Not a database this build can read. The file is left as it is: its
    /// rows are custody the user cannot get back.
    Corrupt(String),
    /// Written by a newer app. Left as it is for that app.
    Newer(i64),
    /// Locked by another process, permission, read-only volume, ...
    Io(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Corrupt(e) => write!(f, "custody store unreadable: {e}"),
            OpenError::Newer(v) => write!(f, "custody store schema {v} is newer than this app ({SCHEMA_VERSION})"),
            OpenError::Io(e) => write!(f, "{e}"),
        }
    }
}

pub fn db_path(vault_root: &Path) -> PathBuf {
    vault_root.join(DB_DIR).join(DB_FILE)
}

fn sql(e: rusqlite::Error) -> OpenError {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => OpenError::Corrupt(e.to_string()),
        _ => OpenError::Io(e.to_string()),
    }
}

/// Open, creating the file and its schema when there is none. Never deletes,
/// truncates or rewrites a file it cannot read.
pub fn open(vault_root: &Path) -> Result<Connection, OpenError> {
    let dir = vault_root.join(DB_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| OpenError::Io(format!("create {}: {e}", dir.display())))?;
    let conn = Connection::open(dir.join(DB_FILE)).map_err(sql)?;
    // One Mutex-guarded connection per process: SQLITE_BUSY can only be another
    // process, and waiting rusqlite's default 5 s buys nothing.
    conn.busy_timeout(std::time::Duration::ZERO).map_err(sql)?;
    conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE;").map_err(sql)?;
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
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(sql)?;
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
    if version < 2 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V2} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2'); COMMIT;"
        )).map_err(sql)?;
    }
    Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", [key, value])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_schema_with_exclusive_wal_and_no_shm() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let locking: String = conn.query_row("PRAGMA locking_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(locking.to_lowercase(), "exclusive");
        for table in ["meta", "vault_entries", "header_cache", "header_cache_meta", "mailbox_cache"] {
            let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name = ?1", [table], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "{table}");
        }
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("2"));
        assert_eq!(db_path(tmp.path()), tmp.path().join("custody/custody.db"));
        assert!(db_path(tmp.path()).exists());
        assert!(!tmp.path().join("custody/custody.db-shm").exists(), "exclusive mode must not create a shared-memory file");
    }

    #[test]
    fn reopen_keeps_rows() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            conn.execute("INSERT INTO vault_entries VALUES ('a', 'INBOX', 7, '{\"uid\":7}')", []).unwrap();
        }
        let conn = open(tmp.path()).unwrap();
        let json: String = conn.query_row("SELECT entry_json FROM vault_entries WHERE uid = 7", [], |r| r.get(0)).unwrap();
        assert_eq!(json, "{\"uid\":7}");
    }

    #[test]
    fn dropping_the_connection_leaves_no_wal_file_behind() {
        // A vault move copies the file after `close()`: the rows must be in the
        // main file by then, not in a -wal the copy could pair wrongly.
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            conn.execute("INSERT INTO vault_entries VALUES ('a', 'INBOX', 7, '{\"uid\":7}')", []).unwrap();
        }
        assert!(!tmp.path().join("custody/custody.db-wal").exists());
        let raw = rusqlite::Connection::open(db_path(tmp.path())).unwrap();
        let n: i64 = raw.query_row("SELECT count(*) FROM vault_entries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn garbage_file_is_reported_corrupt_and_left_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(DB_DIR)).unwrap();
        let garbage = b"this is not a database, and nothing here may delete it";
        std::fs::write(db_path(tmp.path()), garbage).unwrap();
        match open(tmp.path()) {
            Err(OpenError::Corrupt(_)) => {}
            other => panic!("expected Corrupt, got {:?}", other.map(|_| ())),
        }
        assert_eq!(std::fs::read(db_path(tmp.path())).unwrap(), garbage, "the file was rewritten or replaced");
        // And again: a second open reports the same and still touches nothing.
        assert!(matches!(open(tmp.path()), Err(OpenError::Corrupt(_))));
        assert_eq!(std::fs::read(db_path(tmp.path())).unwrap(), garbage);
    }

    #[test]
    fn newer_schema_is_refused_and_never_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            meta_set(&conn, "schema_version", "99").unwrap();
            conn.execute("INSERT INTO vault_entries VALUES ('a', 'INBOX', 7, '{\"uid\":7,\"future\":true}')", []).unwrap();
        }
        assert_eq!(open(tmp.path()).map(|_| ()), Err(OpenError::Newer(99)));
        let raw = rusqlite::Connection::open(db_path(tmp.path())).unwrap();
        let json: String = raw.query_row("SELECT entry_json FROM vault_entries WHERE uid = 7", [], |r| r.get(0)).unwrap();
        assert_eq!(json, "{\"uid\":7,\"future\":true}");
    }

    #[test]
    fn busy_file_fails_fast_and_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let holder = open(tmp.path()).unwrap();
        meta_set(&holder, "probe", "held").unwrap();
        let t = std::time::Instant::now();
        match open(tmp.path()) {
            Err(OpenError::Io(_)) => {}
            other => panic!("expected Io while another connection holds the lock, got {:?}", other.map(|_| ())),
        }
        assert!(t.elapsed() < std::time::Duration::from_secs(1), "a held lock must fail fast, took {:?}", t.elapsed());
        assert_eq!(meta_get(&holder, "probe").as_deref(), Some("held"));
    }
}
