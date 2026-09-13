use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

pub const DB_DIR: &str = "search_index";
pub const DB_FILE: &str = "index.db";
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = "
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  account_id      TEXT NOT NULL,
  vault_dir       TEXT NOT NULL,
  uid             INTEGER NOT NULL,
  filename        TEXT NOT NULL,
  size            INTEGER NOT NULL,
  mtime_ns        INTEGER NOT NULL,
  message_id      TEXT,
  date_utc        INTEGER NOT NULL,
  from_addr_lc    TEXT NOT NULL DEFAULT '',
  from_name_lc    TEXT NOT NULL DEFAULT '',
  subject_lc      TEXT NOT NULL DEFAULT '',
  addrs_lc        TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  body_state      INTEGER NOT NULL DEFAULT 0,
  row_json        TEXT NOT NULL DEFAULT '{}',
  UNIQUE (account_id, vault_dir, uid)
);
CREATE INDEX messages_scope ON messages (account_id, vault_dir, date_utc DESC);
CREATE INDEX messages_account_date ON messages (account_id, date_utc DESC);
CREATE TABLE mailbox_scan (
  account_id TEXT NOT NULL,
  vault_dir  TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, vault_dir)
);
CREATE VIRTUAL TABLE msg_fts USING fts5(subject, addrs, body, attach,
  tokenize = 'trigram remove_diacritics 1', content = '', contentless_delete = 1);
CREATE VIRTUAL TABLE msg_cjk USING fts5(subject, addrs, body, attach,
  tokenize = 'unicode61', content = '', contentless_delete = 1);
";

#[derive(Debug)]
pub enum OpenError {
    /// The file was written by a newer app. Never deleted: from phase 2 on it
    /// holds custody data this build does not understand.
    Newer(i64),
    Io(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Newer(v) => write!(f, "search index schema {v} is newer than this app ({SCHEMA_VERSION})"),
            OpenError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// Open (creating if needed) the vault's index. Phase 1: every table is
/// derived from the .eml files, so an unusable file is deleted and rebuilt.
pub fn open(vault_root: &Path) -> Result<Connection, OpenError> {
    let dir = vault_root.join(DB_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| OpenError::Io(format!("create {}: {e}", dir.display())))?;
    let path = dir.join(DB_FILE);
    match open_at(&path) {
        Err(OpenError::Io(first)) => {
            tracing::warn!("search index unusable ({first}); rebuilding {}", path.display());
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let _ = std::fs::remove_file(dir.join(format!("{DB_FILE}{suffix}")));
            }
            open_at(&path)
        }
        other => other,
    }
}

fn io<E: std::fmt::Display>(e: E) -> OpenError {
    OpenError::Io(e.to_string())
}

fn open_at(path: &Path) -> Result<Connection, OpenError> {
    let conn = Connection::open(path).map_err(io)?;
    // Exclusive BEFORE the first WAL access: no -shm file, so WAL also works
    // when the vault is on a network volume (sqlite.org/wal.html).
    conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE;").map_err(io)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(io)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(OpenError::Io(format!("journal_mode stayed {mode}")));
    }
    conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;").map_err(io)?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(io)?;
    if check != "ok" {
        return Err(OpenError::Io(format!("quick_check: {check}")));
    }
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), OpenError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(io)?;
    let version = meta_get(conn, "schema_version").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(OpenError::Newer(version));
    }
    if version < 1 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V1} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1'); COMMIT;"
        ))
        .map_err(io)?;
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

pub fn db_size_bytes(vault_root: &Path) -> u64 {
    let dir = vault_root.join(DB_DIR);
    ["", "-wal"]
        .iter()
        .filter_map(|s| std::fs::metadata(dir.join(format!("{DB_FILE}{s}"))).ok())
        .map(|m| m.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_schema_with_exclusive_wal() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let locking: String = conn.query_row("PRAGMA locking_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(locking.to_lowercase(), "exclusive");
        for table in ["meta", "messages", "mailbox_scan", "msg_fts", "msg_cjk"] {
            let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name = ?1", [table], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "{table}");
        }
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("1"));
        assert!(tmp.path().join("search_index/index.db").exists());
        assert!(!tmp.path().join("search_index/index.db-shm").exists(), "exclusive mode must not create a shared-memory file");
    }

    #[test]
    fn trigram_and_contentless_delete_are_compiled_in() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        conn.execute("INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (7, 'Invoice', '', '', '')", []).unwrap();
        let hit: i64 = conn.query_row("SELECT rowid FROM msg_fts WHERE msg_fts MATCH '\"voic\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(hit, 7);
        conn.execute("DELETE FROM msg_fts WHERE rowid = 7", []).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM msg_fts WHERE msg_fts MATCH '\"voic\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn reopen_keeps_rows() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            meta_set(&conn, "probe", "kept").unwrap();
        }
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get(&conn, "probe").as_deref(), Some("kept"));
    }

    #[test]
    fn garbage_file_is_rebuilt() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(DB_DIR)).unwrap();
        std::fs::write(tmp.path().join(DB_DIR).join(DB_FILE), b"this is not a database at all, not even close").unwrap();
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("1"));
    }

    #[test]
    fn newer_schema_is_refused_and_never_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = open(tmp.path()).unwrap();
            meta_set(&conn, "schema_version", "99").unwrap();
            meta_set(&conn, "probe", "from the future").unwrap();
        }
        match open(tmp.path()) {
            Err(OpenError::Newer(99)) => {}
            other => panic!("expected Newer(99), got {:?}", other.map(|_| ())),
        }
        // Reopen raw: the file and its rows are still there.
        let raw = rusqlite::Connection::open(tmp.path().join(DB_DIR).join(DB_FILE)).unwrap();
        let v: String = raw.query_row("SELECT value FROM meta WHERE key='probe'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "from the future");
    }
}
