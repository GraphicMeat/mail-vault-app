use rusqlite::{params_from_iter, types::Value, Connection, ErrorCode, OptionalExtension};
use std::collections::BTreeSet;
use std::path::Path;

pub const DB_DIR: &str = "search_index";
pub const DB_FILE: &str = "index.db";
pub const SCHEMA_VERSION: i64 = 4;

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

/// Saved views filter on what a message's flags say (Starred, unread,
/// answered), and the index never held them: the flags live in the Maildir
/// file name, and `index_doc_from_light` strips them out of `row_json`.
///
/// The backfill reads them straight back out of the file names already
/// recorded, so an existing index gains the column without re-reading a single
/// message off disk. `messages_msgid` is for looking a row up by identity,
/// which is how a view filtered by tag finds its messages.
const SCHEMA_V3: &str = "
ALTER TABLE messages ADD COLUMN flags TEXT NOT NULL DEFAULT '';
UPDATE messages SET flags = CASE
  WHEN instr(filename, ':2,') > 0 THEN replace(substr(filename, instr(filename, ':2,') + 3), '.eml', '')
  ELSE '' END;
CREATE INDEX messages_msgid ON messages (account_id, message_id);
";

/// The recipients of a message, on their own. `addrs_lc` merges the sender in,
/// so "addressed to me" read from it also matches the mail this account sent.
///
/// Nothing backfills this one: the recipients are in the message, not in its
/// file name. A row indexed before this column existed keeps an empty value,
/// and the query falls back to `addrs_lc` for it — looser, never emptier —
/// until the next reindex reaches it.
const SCHEMA_V4: &str = "
ALTER TABLE messages ADD COLUMN to_lc TEXT NOT NULL DEFAULT '';
";

#[derive(Debug)]
pub enum OpenError {
    /// Derived search data is unusable and may be replaced by the daemon worker.
    Rebuildable(String),
    Io(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Rebuildable(e) => write!(f, "search index needs a rebuild: {e}"),
            OpenError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// Open (creating if needed) the vault's derived index. This function never
/// removes files: only the owning daemon worker decides when a rebuild is safe.
pub fn open(vault_root: &Path) -> Result<Connection, OpenError> {
    let dir = vault_root.join(DB_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| OpenError::Io(format!("create {}: {e}", dir.display())))?;
    let path = dir.join(DB_FILE);
    open_at(&path).map_err(|failure| match failure {
        Fail::Rebuildable(e) => OpenError::Rebuildable(e),
        Fail::Other(e) => e,
    })
}

/// Why `open_at` failed. Only rebuildable failures let the daemon replace the files.
enum Fail {
    Rebuildable(String),
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

fn retryable_sql(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(
            ErrorCode::DatabaseBusy
                | ErrorCode::DatabaseLocked
                | ErrorCode::ReadOnly
                | ErrorCode::SystemIoFailure
                | ErrorCode::DiskFull
                | ErrorCode::CannotOpen
                | ErrorCode::PermissionDenied
                | ErrorCode::FileLockingProtocolFailed
        )
    )
}

fn sql(e: rusqlite::Error) -> Fail {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => Fail::Rebuildable(e.to_string()),
        _ => Fail::Other(io(e)),
    }
}

fn schema_sql(e: rusqlite::Error) -> Fail {
    if retryable_sql(&e) { Fail::Other(io(e)) } else { Fail::Rebuildable(e.to_string()) }
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
        return Err(Fail::Rebuildable(format!("quick_check: {check}")));
    }
    migrate(&conn)?;
    validate_schema(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), Fail> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(schema_sql)?;
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))
        .optional()
        .map_err(schema_sql)?;
    let version = raw.as_deref().map(|v| v.parse::<i64>().map_err(|_| Fail::Rebuildable(format!("invalid schema_version: {v}")))).transpose()?.unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(Fail::Rebuildable(format!("schema {version} is newer than this app ({SCHEMA_VERSION})")));
    }
    if version < 1 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V1} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1'); COMMIT;"
        ))
        .map_err(schema_sql)?;
    }
    if version < 2 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V2} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2'); COMMIT;"
        ))
        .map_err(schema_sql)?;
    }
    if version < 3 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V3} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3'); COMMIT;"
        ))
        .map_err(schema_sql)?;
    }
    if version < 4 {
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V4} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '4'); COMMIT;"
        ))
        .map_err(schema_sql)?;
    }
    Ok(())
}

fn validate_schema(conn: &Connection) -> Result<(), Fail> {
    for query in [
        "SELECT key, value FROM meta LIMIT 0",
        "SELECT id, account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc, from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags, to_lc FROM messages LIMIT 0",
        "SELECT account_id, vault_dir, scanned_at, file_count FROM mailbox_scan LIMIT 0",
        "SELECT message_row, part_index, filename, mime, size, state, text FROM attachments LIMIT 0",
        "SELECT rowid, subject, addrs, body, attach FROM msg_fts LIMIT 0",
        "SELECT rowid, subject, addrs, body, attach FROM msg_cjk LIMIT 0",
    ] {
        conn.prepare(query).map_err(schema_sql)?;
    }
    // The daemon reads these optional control keys as text after opening the
    // index. Validate their storage classes here so malformed derived metadata
    // is classified as rebuildable instead of trapping every retry in the
    // same health-read failure. Missing keys and arbitrary text values remain valid.
    for key in [FIRST_PASS_DONE, "bodies_enabled"] {
        let _: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(schema_sql)?;
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
    first_pass_done_checked(conn).unwrap_or(false)
}

pub fn first_pass_done_checked(conn: &Connection) -> Result<bool, String> {
    meta_get_checked(conn, FIRST_PASS_DONE).map(|value| value.is_some())
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

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeCoverage {
    pub indexed: u64,
    pub total: u64,
    pub complete: bool,
    pub uncovered_vault_dirs: Vec<String>,
}

/// Coverage for the requested server mailbox paths, or every indexed/vault
/// directory for one account when `mailboxes` is absent or empty.
pub fn scope_coverage(conn: &Connection, account_id: &str, mailboxes: Option<&[String]>) -> Result<ScopeCoverage, String> {
    let requested: Option<BTreeSet<String>> = mailboxes
        .filter(|boxes| !boxes.is_empty())
        .map(|boxes| boxes.iter().map(|name| crate::search_index::text::vault_dir_name(name)).collect());
    let mut args = vec![Value::Text(account_id.to_string())];
    let scope = if let Some(dirs) = requested {
        args.extend(dirs.iter().cloned().map(Value::Text));
        let values = (2..args.len() + 1).map(|n| format!("(?{n})")).collect::<Vec<_>>().join(", ");
        format!("scope(vault_dir) AS (VALUES {values})")
    } else {
        "scope(vault_dir) AS (SELECT vault_dir FROM mailbox_scan WHERE account_id = ?1 UNION SELECT vault_dir FROM messages WHERE account_id = ?1)".into()
    };
    let sql = format!(
        "WITH {scope} \
         SELECT s.vault_dir, sc.file_count IS NOT NULL, COALESCE(sc.file_count, 0), \
                COUNT(m.id), COUNT(m.id) FILTER (WHERE m.body_state != {}), \
                COUNT(m.id) FILTER (WHERE m.body_state = {}) \
         FROM scope s \
         LEFT JOIN mailbox_scan sc ON sc.account_id = ?1 AND sc.vault_dir = s.vault_dir \
         LEFT JOIN messages m ON m.account_id = ?1 AND m.vault_dir = s.vault_dir \
         GROUP BY s.vault_dir, sc.file_count ORDER BY s.vault_dir",
        crate::search_index::reconcile::BODY_PENDING,
        crate::search_index::reconcile::BODY_PENDING,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? != 0,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut coverage = ScopeCoverage { complete: true, ..Default::default() };
    for row in rows {
        let (vault_dir, has_scan, file_count, row_count, indexed_count, pending_count) = row.map_err(|e| e.to_string())?;
        let file_count = file_count.max(0);
        let row_count = row_count.max(0);
        coverage.indexed += u64::try_from(indexed_count.max(0)).unwrap_or(0);
        coverage.total += u64::try_from(file_count.max(row_count)).unwrap_or(0);
        if !has_scan || row_count < file_count || pending_count > 0 {
            coverage.complete = false;
            coverage.uncovered_vault_dirs.push(vault_dir);
        }
    }
    Ok(coverage)
}

/// Index coverage. `total` is the larger of the rows and the files each
/// folder's last listing found (`mailbox_scan.file_count`), so a half-built
/// index never reads as complete. A failed query counts as zero: this only
/// feeds a progress line.
pub fn counts_checked(conn: &Connection) -> Result<IndexCounts, String> {
    let (rows, indexed, listed): (i64, i64, i64) = conn
        .query_row(
            "SELECT count(*), count(*) FILTER (WHERE body_state != 0), (SELECT coalesce(sum(file_count), 0) FROM mailbox_scan) FROM messages",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(IndexCounts { indexed: u64::try_from(indexed).unwrap_or(0), total: u64::try_from(rows.max(listed)).unwrap_or(0) })
}

pub fn counts(conn: &Connection) -> IndexCounts {
    counts_checked(conn).unwrap_or_default()
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
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("4"));
        assert!(tmp.path().join("search_index/index.db").exists());
        assert!(!tmp.path().join("search_index/index.db-shm").exists(), "exclusive mode must not create a shared-memory file");
    }

    /// Saved views filter on flags (Starred, unread, answered), which the
    /// index never held: `index_doc_from_light` strips them from `row_json`
    /// because they live in the file name. A v2 index already holds those file
    /// names, so the column is backfilled rather than waiting for a rebuild
    /// that would re-read every message on disk.
    #[test]
    fn a_v2_index_gains_flags_read_back_out_of_the_file_names_it_holds() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(DB_DIR)).unwrap();
        {
            let conn = Connection::open(tmp.path().join(DB_DIR).join(DB_FILE)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 {SCHEMA_V1}{SCHEMA_V2}
                 INSERT INTO meta(key, value) VALUES ('schema_version', '2');
                 INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc)
                   VALUES ('a', 'INBOX', 7, '7:2,FS.eml', 0, 0, 0),
                          ('a', 'INBOX', 8, '8.eml', 0, 0, 0);"
            ))
            .unwrap();
        }
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("4"));
        let flags = |uid: u32| -> String {
            conn.query_row("SELECT flags FROM messages WHERE uid = ?1", [uid], |r| r.get(0)).unwrap()
        };
        assert_eq!(flags(7), "FS");
        assert_eq!(flags(8), "", "a file name with no flag part carries no flags");
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
    fn garbage_file_is_reported_as_rebuildable_without_deleting_it() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(DB_DIR)).unwrap();
        std::fs::write(tmp.path().join(DB_DIR).join(DB_FILE), b"this is not a database at all, not even close").unwrap();
        let err = open(tmp.path()).unwrap_err();
        assert!(matches!(err, OpenError::Rebuildable(_)), "got {err:?}");
        assert_eq!(std::fs::read(tmp.path().join(DB_DIR).join(DB_FILE)).unwrap(), b"this is not a database at all, not even close");
    }

    #[test]
    fn v2_migration_adds_attachments_table_and_bumps_version() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("4"));
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
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("4"));
        let rows: i64 = conn.query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "v1 rows survive the migration to v2");
        conn.execute(
            "INSERT INTO attachments (message_row, part_index, size, state) VALUES (1, 0, 10, 'pending')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn conflicting_v1_attachments_table_is_a_rebuildable_migration_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DB_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DB_FILE);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 {SCHEMA_V1}
                 INSERT INTO meta(key, value) VALUES ('schema_version', '1');
                 CREATE TABLE attachments (unexpected TEXT);",
            ))
            .unwrap();
        }

        let error = open(tmp.path()).unwrap_err();
        match &error {
            OpenError::Rebuildable(detail) => assert!(detail.contains("attachments already exists"), "must fail specifically at the v2 attachments migration, got {detail}"),
            OpenError::Io(detail) => panic!("migration schema conflict must be rebuildable, got I/O error: {detail}"),
        }

        let raw = Connection::open(path).unwrap();
        let table: String = raw.query_row("SELECT name FROM sqlite_master WHERE name = 'attachments'", [], |r| r.get(0)).unwrap();
        let version: String = raw.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(table, "attachments", "failed migration must preserve the conflicting derived table until the worker decides to rebuild");
        assert_eq!(version, "1");
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
    fn index_path_io_failure_is_not_classified_as_rebuildable_or_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let blocked_path = tmp.path().join(DB_DIR).join(DB_FILE);
        std::fs::create_dir_all(&blocked_path).unwrap();
        let sentinel = blocked_path.join("keep.bin");
        std::fs::write(&sentinel, b"preserve the blocking filesystem entry").unwrap();

        match open(tmp.path()) {
            Err(OpenError::Io(_)) => {}
            other => panic!("expected an I/O failure for a directory at the database path, got {:?}", other.map(|_| ())),
        }
        assert!(blocked_path.is_dir(), "I/O failure must never replace the blocked path");
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"preserve the blocking filesystem entry");
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
            Err(OpenError::Rebuildable(_)) => {}
            other => panic!("expected Newer(99), got {:?}", other.map(|_| ())),
        }
        // Reopen raw: the file and its rows are still there.
        let raw = rusqlite::Connection::open(tmp.path().join(DB_DIR).join(DB_FILE)).unwrap();
        let v: String = raw.query_row("SELECT value FROM meta WHERE key='probe'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "from the future");
    }

    #[test]
    fn malformed_schema_version_is_rebuildable() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        meta_set(&conn, "schema_version", "not-a-number").unwrap();
        drop(conn);
        assert!(matches!(open(tmp.path()), Err(OpenError::Rebuildable(_))));
    }

    #[test]
    fn current_version_with_missing_required_table_or_column_is_rebuildable() {
        for damage in [
            "DROP TABLE messages",
            "ALTER TABLE messages DROP COLUMN body_state",
            "DROP TABLE msg_fts",
            "DROP TABLE msg_cjk",
            "DROP TABLE attachments",
            "ALTER TABLE mailbox_scan DROP COLUMN file_count",
            "ALTER TABLE meta DROP COLUMN value",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let conn = open(tmp.path()).unwrap();
            conn.execute_batch(damage).unwrap();
            drop(conn);
            assert!(matches!(open(tmp.path()), Err(OpenError::Rebuildable(_))), "damage: {damage}");
        }
    }

    #[test]
    fn non_text_health_metadata_is_rebuildable_for_both_checked_keys() {
        for key in [FIRST_PASS_DONE, "bodies_enabled"] {
            let tmp = tempfile::tempdir().unwrap();
            let conn = open(tmp.path()).unwrap();
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, X'00')", [key]).unwrap();
            drop(conn);

            assert!(matches!(open(tmp.path()), Err(OpenError::Rebuildable(_))), "non-text {key} metadata must trigger derived-index recovery");
        }
    }

    #[test]
    fn checked_health_reads_preserve_sql_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        conn.execute_batch("DROP TABLE messages").unwrap();
        assert!(counts_checked(&conn).is_err());
        conn.execute_batch("DROP TABLE meta").unwrap();
        assert!(first_pass_done_checked(&conn).is_err());
    }
}
