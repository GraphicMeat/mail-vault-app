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
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

pub const DB_FILE: &str = "app.db";
pub const SCHEMA_VERSION: i64 = 5;

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

/// The metadata layer: tags, custom fields and saved views. It lives here and
/// not in `search_index`, because that index is rebuildable by design and a
/// rebuild would take user-authored data with it. Nothing here touches an
/// `.eml`, a server or a flag.
///
/// `msg_key` is `app_db::identity::msg_key` — the Message-ID where there is
/// one, so an assignment survives a move, a flag rename and a Graph resync.
const SCHEMA_V2: &str = "
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX tags_name ON tags (name COLLATE NOCASE);
CREATE TABLE tag_assignments (
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  msg_key    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (tag_id, account_id, msg_key)
);
CREATE INDEX tag_assignments_msg ON tag_assignments (account_id, msg_key);
CREATE TABLE fields (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX fields_scope_name ON fields (scope, name COLLATE NOCASE);
CREATE TABLE field_values (
  field_id   TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  msg_key    TEXT NOT NULL,
  value_json TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (field_id, account_id, msg_key)
);
CREATE INDEX field_values_msg ON field_values (account_id, msg_key);
CREATE TABLE views (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  icon     TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  builtin  TEXT,
  def_json TEXT NOT NULL
);
";

/// Scheduled Send's durable queue. A frozen `.eml` sits in the account's
/// vault `Scheduled` mailbox at `(mailbox, uid)`; this row is what the
/// daemon's `scheduled_send_worker` fires it off of. `msg_key` does not apply
/// here (`app_db::scheduled`'s module doc explains why) — a frozen draft has
/// no Message-ID until sent and lives in a mailbox only this app ever writes.
const SCHEMA_V3: &str = "
CREATE TABLE scheduled_sends (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  mailbox     TEXT NOT NULL,
  uid         INTEGER NOT NULL,
  envelope    TEXT NOT NULL,
  local_time  TEXT NOT NULL,
  tz          TEXT NOT NULL,
  fire_at     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX scheduled_sends_due ON scheduled_sends(status, fire_at);
";

/// Auto Tags (Phase 4). `constraints` is a deterministic prefilter (JSON —
/// see `app_db::auto_tags::Constraints`) evaluated in Rust before any model
/// ever sees the message. `allow_remote` is the privacy opt-in: a rule
/// without it can never be evaluated through `llm::Provider::Endpoint`.
/// `provider` is the JSON-encoded `llm::Provider` (daemon-only type — this
/// store treats it as an opaque blob) the STANDING worker evaluates the rule
/// through; absent/null defaults to on-device (`LocalGguf`), matching the
/// privacy default. `enabled_at` is when the rule most recently turned on:
/// the worker only ever considers mail that arrived at or after it, so
/// flipping a rule on never retroactively floods the model with years of
/// history — that is what the explicit, bounded `.backfill` is for.
///
/// `auto_tag_backfills` records what a backfill batch assigned — including
/// the tag it assigned, frozen at batch time — so it can be undone even if
/// the rule's own `tag_id` is edited later: `msg_key` is
/// `app_db::identity::msg_key`, same as `tag_assignments`.
///
/// `auto_tag_decisions` is the worker's dedupe: the idea behind
/// `classification_queue`'s own "never re-ask about a message with a result
/// already on record" (`classification.rs`'s `enqueue_inner` skips anything
/// `load_classifications` already has), scoped per rule here because several
/// rules can independently be mid-decision on the same message at once. A
/// row is written for EVERY outcome, match or not — that is what makes it a
/// decision rather than a cache.
const SCHEMA_V4: &str = "
CREATE TABLE auto_tag_rules (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  instruction    TEXT NOT NULL,
  constraints    TEXT NOT NULL,
  tag_id         TEXT NOT NULL,
  inbox_action   TEXT NOT NULL,
  min_confidence REAL NOT NULL,
  allow_remote   INTEGER NOT NULL DEFAULT 0,
  provider       TEXT NOT NULL DEFAULT 'null',
  enabled        INTEGER NOT NULL DEFAULT 0,
  enabled_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE auto_tag_backfills (
  batch_id   TEXT NOT NULL,
  rule_id    TEXT NOT NULL,
  tag_id     TEXT NOT NULL,
  account_id TEXT NOT NULL,
  msg_key    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (batch_id, account_id, msg_key)
);
CREATE INDEX auto_tag_backfills_batch ON auto_tag_backfills(batch_id);
CREATE TABLE auto_tag_decisions (
  rule_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  msg_key    TEXT NOT NULL,
  matched    INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (rule_id, account_id, msg_key)
);
";

/// Snooze's queue: messages the app moved to the server's Snoozed folder and
/// `snooze_worker` moves back at `wake_at`. Keyed on `message_id` rather than
/// `msg_key` because it is only ever used to find the message on the server
/// again (`app_db::snooze`'s module doc); `uid_in_snoozed` is a hint.
const SCHEMA_V5: &str = "
CREATE TABLE snoozes (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  from_mailbox    TEXT NOT NULL,
  snoozed_mailbox TEXT NOT NULL,
  uid_in_snoozed  INTEGER,
  message_id      TEXT NOT NULL,
  wake_at         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  retry_at        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX snoozes_due ON snoozes(state, wake_at);
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

/// **One** connection, for one app data dir. A process has exactly one app
/// data dir, so this is a cache of size one rather than a map: a map would
/// hold a connection open for every directory ever asked for, which in a test
/// binary is one per temp dir and runs the process out of file descriptors.
/// A different directory replaces the entry; the old connection closes as
/// soon as its last holder drops it.
static HANDLE: LazyLock<Mutex<Option<(PathBuf, Arc<Mutex<Connection>>)>>> =
    LazyLock::new(|| Mutex::new(None));

/// The process-wide handle for `app_dir`, opening (and migrating, and
/// importing the legacy JSON) on first use.
pub fn handle(app_dir: &Path) -> Result<Arc<Mutex<Connection>>, OpenError> {
    let key = app_dir.to_path_buf();
    if let Some((path, conn)) = HANDLE.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        if *path == key {
            return Ok(Arc::clone(conn));
        }
    }
    let conn = open(app_dir)?;
    super::import::run(&conn, app_dir);
    Ok(install(key, Arc::new(Mutex::new(conn))))
}

/// Put `opened` in the slot and hand it back — unless another caller already
/// installed one for the same directory while this one was opening, in which
/// case `opened` is dropped and theirs is returned. Two threads can both miss
/// the slot, and the loser has to give back the winner's connection or this
/// process ends up with two and the per-process `Mutex` serializes nothing.
/// Reachable at daemon startup, where the op journal, the stats flush and the
/// classification worker all land here from different blocking threads.
fn install(key: PathBuf, opened: Arc<Mutex<Connection>>) -> Arc<Mutex<Connection>> {
    let mut slot = HANDLE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((path, conn)) = slot.as_ref() {
        if *path == key {
            return Arc::clone(conn);
        }
    }
    *slot = Some((key, Arc::clone(&opened)));
    opened
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
///
/// Two processes open this store, so the first open of a fresh file can be a
/// race: the steps run under `BEGIN IMMEDIATE` and the version is re-read
/// inside that lock, so the loser waits out its `busy_timeout`, sees the
/// schema already there and does nothing (rather than failing with "table
/// external_locations already exists").
fn migrate(conn: &Connection) -> Result<(), OpenError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(sql)?;
    if schema_version(conn)? >= SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE;").map_err(sql)?;
    let stepped = (|| {
        let version = schema_version(conn)?;
        if version < 1 {
            conn.execute_batch(&format!(
                "{SCHEMA_V1} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');"
            ))
            .map_err(sql)?;
        }
        if version < 2 {
            conn.execute_batch(&format!(
                "{SCHEMA_V2} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');"
            ))
            .map_err(sql)?;
        }
        if version < 3 {
            conn.execute_batch(&format!(
                "{SCHEMA_V3} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3');"
            ))
            .map_err(sql)?;
        }
        if version < 4 {
            conn.execute_batch(&format!(
                "{SCHEMA_V4} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '4');"
            ))
            .map_err(sql)?;
        }
        if version < 5 {
            conn.execute_batch(&format!(
                "{SCHEMA_V5} INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '5');"
            ))
            .map_err(sql)?;
        }
        Ok(())
    })();
    match stepped {
        Ok(()) => conn.execute_batch("COMMIT;").map_err(sql),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

/// The stored schema version, refusing one this build cannot read.
fn schema_version(conn: &Connection) -> Result<i64, OpenError> {
    let version = meta_get(conn, "schema_version").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(OpenError::Newer(version));
    }
    Ok(version)
}

/// Run `f` inside a transaction, or inline when the caller already opened
/// one. SQLite has no nested `BEGIN`, and the legacy import wraps every store
/// in one transaction while each store's own writer wants one too.
pub fn in_txn<T>(conn: &Connection, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if !conn.is_autocommit() {
        return f();
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let out = f()?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
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

    /// `HANDLE` is one process-wide slot (by design — see its own doc
    /// comment), and `cargo test` runs a binary's tests on many threads at
    /// once. A test that asserts on the slot's exact identity/eviction
    /// behavior (which of two connections is "the cached one" right now)
    /// races every other such test unless they take turns; every plain
    /// `open()` call elsewhere in this module bypasses the slot entirely and
    /// needs no lock. Real threads are not needed to exercise the race
    /// itself (see `the_loser_of_a_race_hands_back_the_winners_connection`'s
    /// own doc comment) — only to keep two *different* tests from
    /// interleaving their `handle()`/`install()` calls.
    static HANDLE_SLOT_TESTS: Mutex<()> = Mutex::new(());

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-appdb-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn open_creates_the_schema_and_is_idempotent() {
        let dir = scratch("create");
        let conn = open(&dir).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("5"));
        drop(conn);
        let again = open(&dir).unwrap();
        assert_eq!(meta_get(&again, "schema_version").as_deref(), Some("5"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Everything the metadata layer (tags, custom fields, saved views) owns
    /// lives here rather than in the rebuildable search index, so a v1 store
    /// has to gain the tables without losing a row it already held.
    #[test]
    fn a_v1_store_gains_the_metadata_tables_and_keeps_its_rows() {
        let dir = scratch("v1");
        {
            let conn = Connection::open(db_path(&dir)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 {SCHEMA_V1}
                 INSERT INTO meta(key, value) VALUES ('schema_version', '1');
                 INSERT INTO classifications(account_id, email_key, entry_json) VALUES ('a', 'k', '{{}}');"
            ))
            .unwrap();
        }
        let conn = open(&dir).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("5"));
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM classifications", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1);
        for table in [
            "tags",
            "tag_assignments",
            "fields",
            "field_values",
            "views",
            "scheduled_sends",
            "auto_tag_rules",
            "auto_tag_backfills",
            "auto_tag_decisions",
            "snoozes",
        ] {
            let found: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |r| r.get(0))
                .unwrap();
            assert_eq!(found, 1, "{table} is missing after the migration");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v3 adds `scheduled_sends` on top of a v2 store (tags/views/fields, in
    /// main as of `9b91202f`) without losing what v2 already held — same
    /// shape as the v1-gains-v2 test above.
    #[test]
    fn a_v2_store_gains_scheduled_sends_and_keeps_its_rows() {
        let dir = scratch("v2");
        {
            let conn = Connection::open(db_path(&dir)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 {SCHEMA_V1}
                 {SCHEMA_V2}
                 INSERT INTO meta(key, value) VALUES ('schema_version', '2');
                 INSERT INTO tags(id, name, color, position, created_at) VALUES ('t1', 'Receipts', '', 0, 0);"
            ))
            .unwrap();
        }
        let conn = open(&dir).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("5"));
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "the v2 row must survive the v3+v4 migration");
        let found: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='scheduled_sends'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(found, 1, "scheduled_sends is missing after the migration");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v4 adds Auto Tags on top of a v3 store (`scheduled_sends`, in main as
    /// of `1cd8f0dc`) without losing what v3 already held — same shape as the
    /// v1-gains-v2 and v2-gains-v3 tests above.
    #[test]
    fn a_v3_store_gains_auto_tags_and_keeps_its_rows() {
        let dir = scratch("v3");
        {
            let conn = Connection::open(db_path(&dir)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 {SCHEMA_V1}
                 {SCHEMA_V2}
                 {SCHEMA_V3}
                 INSERT INTO meta(key, value) VALUES ('schema_version', '3');
                 INSERT INTO scheduled_sends(id, account_id, mailbox, uid, envelope, local_time, tz, fire_at, status, created_at, updated_at)
                 VALUES ('s1', 'acct', 'Scheduled', 1, '{{}}', '2026-09-22T09:00', 'UTC', 0, 'queued', 0, 0);"
            ))
            .unwrap();
        }
        let conn = open(&dir).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("5"));
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM scheduled_sends", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "the v3 row must survive the v4 migration");
        for table in ["auto_tag_rules", "auto_tag_backfills", "auto_tag_decisions"] {
            let found: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |r| r.get(0))
                .unwrap();
            assert_eq!(found, 1, "{table} is missing after the migration");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v5 adds Snooze's queue on top of a v4 store (Auto Tags) without losing
    /// what v4 already held — same shape as the tests above.
    #[test]
    fn a_v4_store_gains_snoozes_and_keeps_its_rows() {
        let dir = scratch("v4");
        {
            let conn = Connection::open(db_path(&dir)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 {SCHEMA_V1}
                 {SCHEMA_V2}
                 {SCHEMA_V3}
                 {SCHEMA_V4}
                 INSERT INTO meta(key, value) VALUES ('schema_version', '4');
                 INSERT INTO auto_tag_rules(id, name, instruction, constraints, tag_id, inbox_action, min_confidence, created_at, updated_at)
                 VALUES ('r1', 'Receipts', 'receipts', '{{}}', 't1', 'none', 0.5, 0, 0);"
            ))
            .unwrap();
        }
        let conn = open(&dir).unwrap();
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some("5"));
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM auto_tag_rules", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "the v4 row must survive the v5 migration");
        let found: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='snoozes'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(found, 1, "snoozes is missing after the migration");
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
    fn a_second_directory_replaces_the_first_rather_than_holding_both_open() {
        let _guard = HANDLE_SLOT_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        // A process has one app data dir; a test binary has hundreds, and
        // keeping a connection per directory exhausts its file descriptors.
        let a = scratch("slot-a");
        let b = scratch("slot-b");
        let first = handle(&a).unwrap();
        let second = handle(&b).unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(Arc::ptr_eq(&handle(&b).unwrap(), &second), "the newest dir is the cached one");
        assert!(!Arc::ptr_eq(&handle(&a).unwrap(), &first), "the old one was let go");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn two_opens_of_one_dir_share_one_handle() {
        let _guard = HANDLE_SLOT_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("handle");
        let a = handle(&dir).unwrap();
        let b = handle(&dir).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The loser of a race between two openers has to give back the winner's
    /// connection, not keep its own. Driven through `install` rather than
    /// through real threads: `HANDLE` is one global slot, so a second test
    /// running in parallel on a different directory would evict this one
    /// mid-race and the assertion would be about the scheduler, not the code.
    #[test]
    fn the_loser_of_a_race_hands_back_the_winners_connection() {
        let _guard = HANDLE_SLOT_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("handle-race");
        let winner = Arc::new(Mutex::new(open(&dir).unwrap()));
        let loser = Arc::new(Mutex::new(open(&dir).unwrap()));
        let installed = install(dir.clone(), Arc::clone(&winner));
        assert!(Arc::ptr_eq(&installed, &winner));
        let second = install(dir.clone(), loser);
        assert!(Arc::ptr_eq(&second, &winner), "the loser kept its own connection");
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
