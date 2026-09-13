use rusqlite::{Connection, ErrorCode, OptionalExtension};
use std::path::Path;

pub const DB_DIR: &str = "search_index";
pub const DB_FILE: &str = "index.db";
pub const SCHEMA_VERSION: i64 = 2;

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
  file_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, vault_dir)
);
CREATE VIRTUAL TABLE msg_fts USING fts5(subject, addrs, body, attach,
  tokenize = 'trigram remove_diacritics 1', content = '', contentless_delete = 1);
CREATE VIRTUAL TABLE msg_cjk USING fts5(subject, addrs, body, attach,
  tokenize = 'unicode61', content = '', contentless_delete = 1);
";

const SCHEMA_V2: &str = "
CREATE TABLE attachments (
  message_row INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_index  INTEGER NOT NULL,
  filename    TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL,
  state       TEXT NOT NULL,
  text        TEXT,
  PRIMARY KEY (message_row, part_index)
);
CREATE INDEX attachments_pending ON attachments (state) WHERE state = 'pending';
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
/// derived from the .eml files, so a corrupt file is deleted and rebuilt.
/// Any other failure (locked by another process, permission, read-only
/// volume, a failed migration) leaves the files untouched.
pub fn open(vault_root: &Path) -> Result<Connection, OpenError> {
    let dir = vault_root.join(DB_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| OpenError::Io(format!("create {}: {e}", dir.display())))?;
    let path = dir.join(DB_FILE);
    match open_at(&path) {
        Ok(conn) => Ok(conn),
        Err(Fail::Other(e)) => Err(e),
        Err(Fail::Corrupt(first)) => {
            tracing::warn!("search index corrupt ({first}); rebuilding {}", path.display());
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let _ = std::fs::remove_file(dir.join(format!("{DB_FILE}{suffix}")));
            }
            open_at(&path).map_err(|f| match f {
                Fail::Corrupt(e) => OpenError::Io(e),
                Fail::Other(e) => e,
            })
        }
    }
}

/// Why `open_at` failed. Only `Corrupt` lets `open` delete the file.
enum Fail {
    Corrupt(String),
    Other(OpenError),
}

impl From<OpenError> for Fail {
    fn from(e: OpenError) -> Self {
        Fail::Other(e)
    }
}

fn io<E: std::fmt::Display>(e: E) -> OpenError {
    OpenError::Io(e.to_string())
}

fn sql(e: rusqlite::Error) -> Fail {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => Fail::Corrupt(e.to_string()),
        _ => Fail::Other(io(e)),
    }
}

fn open_at(path: &Path) -> Result<Connection, Fail> {
    let conn = Connection::open(path).map_err(sql)?;
    // The app holds one Mutex-guarded connection, so SQLITE_BUSY can only be
    // another process: waiting rusqlite's default 5 s buys nothing.
    conn.busy_timeout(std::time::Duration::ZERO).map_err(io)?;
    // Exclusive BEFORE the first WAL access: no -shm file, so WAL also works
    // when the vault is on a network volume (sqlite.org/wal.html).
    conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE;").map_err(sql)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(OpenError::Io(format!("journal_mode stayed {mode}")).into());
    }
    conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;").map_err(sql)?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(sql)?;
    if check != "ok" {
        return Err(Fail::Corrupt(format!("quick_check: {check}")));
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
    if version < 2 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V2} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2'); COMMIT;"
        ))
        .map_err(io)?;
    }
    Ok(())
}

/// A read error reads as "not set". Only for values where that is harmless;
/// a decision that would write over the stored value uses `meta_get_checked`.
pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    meta_get_checked(conn, key).ok().flatten()
}

/// `Ok(None)` only when the key is not stored.
pub fn meta_get_checked(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())
}

/// Written once a full pass has reconciled every folder without interruption.
/// A fresh or rebuilt index misses mail the scan finds until then, so searches
/// and status report it unavailable.
pub const FIRST_PASS_DONE: &str = "first_pass_done";

pub fn first_pass_done(conn: &Connection) -> bool {
    meta_get(conn, FIRST_PASS_DONE).is_some()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", [key, value])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexCounts {
    pub indexed: u64,
    pub total: u64,
}

/// Index coverage. `total` is the larger of the rows and the files each
/// folder's last listing found (`mailbox_scan.file_count`), so a half-built
/// index never reads as complete. A failed query counts as zero: this only
/// feeds a progress line.
pub fn counts(conn: &Connection) -> IndexCounts {
    let (rows, indexed, listed): (i64, i64, i64) = conn
        .query_row(
            "SELECT count(*), count(*) FILTER (WHERE body_state != 0), (SELECT coalesce(sum(file_count), 0) FROM mailbox_scan) FROM messages",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or((0, 0, 0));
    IndexCounts { indexed: u64::try_from(indexed).unwrap_or(0), total: u64::try_from(rows.max(listed)).unwrap_or(0) }
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
        for table in ["meta", "messages", "mailbox_scan", "msg_fts", "msg_cjk", "attachments"] {
            let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name = ?1", [table], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "{table}");
        }
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("2"));
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
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("2"));
    }

    #[test]
    fn v2_migration_adds_attachments_table_and_bumps_version() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("2"));
        let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name = 'attachments'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn v1_database_migrates_forward_to_v2() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DB_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DB_FILE);
        {
            // Build a v1-only database by hand, so this test survives future schema changes.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); {SCHEMA_V1} \
                 INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1'); COMMIT;"
            ))
            .unwrap();
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc) VALUES ('a', 'INBOX', 1, 'f', 0, 0, 0)",
                [],
            )
            .unwrap();
        }
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("2"));
        let rows: i64 = conn.query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "v1 rows survive the migration to v2");
        conn.execute(
            "INSERT INTO attachments (message_row, part_index, size, state) VALUES (1, 0, 10, 'pending')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn attachment_row_is_deleted_when_its_message_is_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute(
            "INSERT INTO messages (id, account_id, vault_dir, uid, filename, size, mtime_ns, date_utc) VALUES (1, 'a', 'INBOX', 1, 'f', 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO attachments (message_row, part_index, size, state) VALUES (1, 0, 10, 'pending')", []).unwrap();
        conn.execute("DELETE FROM messages WHERE id = 1", []).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "ON DELETE CASCADE must remove attachment rows with their message");
    }

    #[test]
    fn meta_get_checked_tells_a_missing_key_from_a_failed_read() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get_checked(&conn, "missing"), Ok(None));
        meta_set(&conn, "probe", "1").unwrap();
        assert_eq!(meta_get_checked(&conn, "probe"), Ok(Some("1".into())));
        conn.execute_batch("DROP TABLE meta").unwrap();
        assert!(meta_get_checked(&conn, "probe").is_err(), "a failed read is not \"unset\"");
        assert_eq!(meta_get(&conn, "probe"), None);
    }

    #[test]
    fn busy_file_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let holder = open(tmp.path()).unwrap();
        meta_set(&holder, "probe", "held").unwrap();
        let t = std::time::Instant::now();
        match open(tmp.path()) {
            Err(OpenError::Io(_)) => {}
            other => panic!("expected Io while another connection holds the lock, got {:?}", other.map(|_| ())),
        }
        assert!(t.elapsed() < std::time::Duration::from_secs(1), "a held lock must fail fast, took {:?}", t.elapsed());
        assert!(tmp.path().join(DB_DIR).join(DB_FILE).exists());
        assert_eq!(meta_get(&holder, "probe").as_deref(), Some("held"));
    }

    #[test]
    fn counts_use_the_larger_of_rows_and_listed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        assert_eq!(counts(&conn), IndexCounts { indexed: 0, total: 0 });
        conn.execute("INSERT INTO mailbox_scan VALUES ('a','INBOX',1,6), ('a','Archive',1,4)", []).unwrap();
        conn.execute("INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state) VALUES ('a','INBOX',1,'1:2,.eml',1,1,1,1)", []).unwrap();
        conn.execute("INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state) VALUES ('a','INBOX',2,'2:2,.eml',1,1,1,0)", []).unwrap();
        assert_eq!(counts(&conn), IndexCounts { indexed: 1, total: 10 });
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
