//! `<dir>/mobile.db`: a cache of what the mobile list shows. It can always be rebuilt from the
//! server, so unlike `app.db` a corrupt file is deleted and recreated. A file from a NEWER build is
//! the opposite case: it is left byte-for-byte alone and `open` refuses.
//!
//! One writer connection (writes go through `BEGIN IMMEDIATE`, as `app_db::in_txn` does) and a
//! small pool of read-only connections, so a list read never queues behind a write. The sync
//! worker thread shares the same state ([`Shared`]) through an `Arc`.

use crate::events::EventSink;
use crate::secrets::SecretStore;
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

pub const DB_FILE: &str = "mobile.db";
pub const SCHEMA_VERSION: u32 = 2;
const READERS: usize = 2;

/// Schema 2. Version 1 was the list-only prototype and held nothing the server cannot give back,
/// so a v1 file is dropped and rebuilt rather than migrated.
const SCHEMA_V2: &str = "
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

/// Every table any schema version created; a rebuild drops them all (their indexes go with them).
const ALL_TABLES: &[&str] = &["pending_actions", "attachments", "bodies", "messages", "folders", "accounts"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// The file was written by a newer build. Nothing was modified.
    NewerSchema { found: u32, supported: u32 },
    Io(String),
    Db(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::NewerSchema { found, supported } => {
                write!(f, "mobile.db schema {found} is newer than supported {supported}")
            }
            EngineError::Io(m) => write!(f, "io: {m}"),
            EngineError::Db(m) => write!(f, "db: {m}"),
        }
    }
}

impl std::error::Error for EngineError {}

type LogSink = Box<dyn Fn(&str) + Send + Sync>;

pub struct Engine {
    shared: Arc<Shared>,
    /// Rebuildable files (message bodies, attachments) live here, never in `mobile.db`.
    cache_dir: PathBuf,
    sync: crate::sync::Worker,
}

/// What the RPC threads and the sync worker thread both use.
pub(crate) struct Shared {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    /// Account secrets. Never copied into `mobile.db`, a log line or an event.
    secrets: Arc<dyn SecretStore>,
    /// Where the engine's own log lines go. The shell installs its platform logger (unified log on
    /// iOS, logcat on Android); app stdout reaches neither, so stderr is only the fallback.
    log_sink: OnceLock<LogSink>,
    event_sink: OnceLock<EventSink>,
    /// Each folder's list generation, `(account_id, folder)` -> gen. Seeded from the highest
    /// `messages.list_gen` of the folder on first use and bumped by every sync pass that changed
    /// the folder (a pass that only removes rows too, which no row can record).
    list_gens: Mutex<HashMap<(String, String), i64>>,
    /// Set when the `Engine` is dropped; the sync worker stops at its next batch.
    closing: AtomicBool,
    /// Unit tests: the most rows any one write transaction changed.
    #[cfg(test)]
    max_txn_rows: std::sync::atomic::AtomicU64,
    /// Unit tests: the body cache cap, in place of [`crate::body::CACHE_CAP`].
    #[cfg(test)]
    pub(crate) body_cap: std::sync::atomic::AtomicU64,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn is_corrupt(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(ErrorCode::NotADatabase) | Some(ErrorCode::DatabaseCorrupt)
    )
}

enum OpenFail {
    Corrupt,
    Fatal(EngineError),
}

impl From<rusqlite::Error> for OpenFail {
    fn from(e: rusqlite::Error) -> Self {
        if is_corrupt(&e) {
            OpenFail::Corrupt
        } else {
            OpenFail::Fatal(EngineError::Db(e.to_string()))
        }
    }
}

fn read_conn(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(c)
}

/// The database half of an open engine; `Engine::open` adds the directories and the secret store.
struct Db {
    path: PathBuf,
    writer: Connection,
    readers: Vec<Connection>,
}

fn try_open(path: &Path) -> Result<Db, OpenFail> {
    let w = Connection::open(path)?;
    w.busy_timeout(std::time::Duration::from_secs(5))?;
    // Version first, before any pragma that rewrites the header (journal_mode=WAL does): a newer
    // file must come out of this untouched. A garbage file fails right here with NOTADB.
    let found: u32 = w.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(OpenFail::Fatal(EngineError::NewerSchema { found, supported: SCHEMA_VERSION }));
    }
    let mode: String = w.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(OpenFail::Fatal(EngineError::Db(format!("journal_mode is {mode}, not wal"))));
    }
    w.execute_batch("PRAGMA synchronous = NORMAL;")?;
    if found < SCHEMA_VERSION {
        // New file or an older prototype schema: one transaction, so a crash leaves the old file.
        let tx = Transaction::new_unchecked(&w, TransactionBehavior::Immediate)?;
        for t in ALL_TABLES {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS {t};"))?;
        }
        tx.execute_batch(SCHEMA_V2)?;
        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
        tx.commit()?;
    }
    // A header can be fine while a page is not: touch the table and the index.
    let _: i64 = w.query_row("SELECT count(*) FROM messages", [], |r| r.get(0))?;
    let _: i64 = w.query_row(
        "SELECT count(*) FROM (SELECT 1 FROM messages INDEXED BY messages_by_date LIMIT 1)",
        [],
        |r| r.get(0),
    )?;
    let mut readers = Vec::with_capacity(READERS);
    for _ in 0..READERS {
        readers.push(read_conn(path)?);
    }
    Ok(Db { path: path.to_path_buf(), writer: w, readers })
}

fn remove_db_files(path: &Path) -> Result<(), EngineError> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut s = path.as_os_str().to_owned();
        s.push(suffix);
        match std::fs::remove_file(PathBuf::from(s)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(EngineError::Io(e.to_string())),
        }
    }
    Ok(())
}

impl Engine {
    /// Opens `<data_dir>/mobile.db` (creating both directories as needed). `cache_dir` holds
    /// rebuildable files; `secrets` is the platform store account secrets go to.
    pub fn open(data_dir: &Path, cache_dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Engine, EngineError> {
        std::fs::create_dir_all(data_dir).map_err(|e| EngineError::Io(e.to_string()))?;
        std::fs::create_dir_all(cache_dir).map_err(|e| EngineError::Io(e.to_string()))?;
        let path = data_dir.join(DB_FILE);
        let db = match try_open(&path) {
            Ok(db) => db,
            Err(OpenFail::Fatal(e)) => return Err(e),
            Err(OpenFail::Corrupt) => {
                remove_db_files(&path)?;
                match try_open(&path) {
                    Ok(db) => db,
                    Err(OpenFail::Fatal(e)) => return Err(e),
                    Err(OpenFail::Corrupt) => return Err(EngineError::Db("mobile.db is corrupt after a rebuild".into())),
                }
            }
        };
        Ok(Engine {
            shared: Arc::new(Shared {
                path: db.path,
                writer: Mutex::new(db.writer),
                readers: Mutex::new(db.readers),
                secrets,
                log_sink: OnceLock::new(),
                event_sink: OnceLock::new(),
                list_gens: Mutex::new(HashMap::new()),
                closing: AtomicBool::new(false),
                #[cfg(test)]
                max_txn_rows: std::sync::atomic::AtomicU64::new(0),
                #[cfg(test)]
                body_cap: std::sync::atomic::AtomicU64::new(crate::body::CACHE_CAP),
            }),
            cache_dir: cache_dir.to_path_buf(),
            sync: crate::sync::Worker::default(),
        })
    }

    pub(crate) fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub(crate) fn sync_worker(&self) -> &crate::sync::Worker {
        &self.sync
    }

    /// The directory for rebuildable files the shell passed to `open`.
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    /// The platform secret store the shell passed to `open`.
    pub fn secrets(&self) -> &dyn SecretStore {
        self.shared.secrets.as_ref()
    }

    /// Installs the sink for the engine's log lines. The first sink wins; returns false if one was
    /// already set.
    pub fn set_log_sink(&self, sink: impl Fn(&str) + Send + Sync + 'static) -> bool {
        self.shared.log_sink.set(Box::new(sink)).is_ok()
    }

    /// Installs the sink for engine events (`crate::events`): name and JSON payload. Called on the
    /// thread that produced the event (often the sync worker), with no engine lock held. The first
    /// sink wins; returns false if one was already set.
    pub fn set_event_sink(&self, sink: impl Fn(&str, Value) + Send + Sync + 'static) -> bool {
        self.shared.event_sink.set(Box::new(sink)).is_ok()
    }

    /// Writes one line to the installed sink, or to stderr when none is set.
    #[cfg(feature = "perf-gate")]
    pub(crate) fn log(&self, line: &str) {
        self.shared.log(line)
    }

    /// Runs `f` inside `BEGIN IMMEDIATE` on the single writer connection.
    pub(crate) fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, EngineError> {
        self.shared.write(f)
    }

    /// Runs `f` in one deferred read transaction on a pooled read-only connection.
    pub(crate) fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, EngineError> {
        self.shared.read(f)
    }

    /// Test seam for `read_not_blocked_by_writer`: runs `f` inside a write transaction that stays
    /// open until `f` returns. Unit tests only, so no build of the crate (shipping or perf-gate)
    /// carries it.
    #[cfg(test)]
    fn hold_write_txn_for_test<T>(&self, f: impl FnOnce() -> T) -> Result<T, EngineError> {
        self.write(|c| {
            // Make it a real write so the WAL has a pending writer.
            c.execute(
                "INSERT OR REPLACE INTO messages
                 (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
                 VALUES ('hold','hold',1,'','','',0,'',0,0,0)",
                [],
            )?;
            Ok(f())
        })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // The worker stops at its next batch (a network call in flight is bounded by core's
        // timeouts) and exits; nothing waits for it.
        self.shared.closing.store(true, Ordering::SeqCst);
        self.sync.stop();
    }
}

impl Shared {
    /// Runs `f` inside `BEGIN IMMEDIATE` on the single writer connection.
    pub(crate) fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, EngineError> {
        let w = lock(&self.writer);
        self.write_on(&w, f)
    }

    /// [`Shared::write`] when the writer is free right now; `None` (and `f` not run) when another
    /// write holds it. For writes that may be skipped rather than wait, such as an LRU touch on
    /// the path that opens a message.
    pub(crate) fn try_write<T>(&self, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Option<Result<T, EngineError>> {
        let w = match self.writer.try_lock() {
            Ok(w) => w,
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return None,
        };
        Some(self.write_on(&w, f))
    }

    fn write_on<T>(&self, w: &Connection, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, EngineError> {
        let tx = Transaction::new_unchecked(w, TransactionBehavior::Immediate).map_err(|e| EngineError::Db(e.to_string()))?;
        #[cfg(test)]
        let before = w.total_changes();
        let out = f(w).map_err(|e| EngineError::Db(e.to_string()))?;
        #[cfg(test)]
        self.max_txn_rows.fetch_max(w.total_changes() - before, Ordering::SeqCst);
        tx.commit().map_err(|e| EngineError::Db(e.to_string()))?;
        Ok(out)
    }

    /// Runs `f` in one deferred read transaction on a pooled read-only connection. Never touches
    /// the writer mutex, so an open write transaction does not delay it.
    pub(crate) fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, EngineError> {
        let pooled = lock(&self.readers).pop();
        let conn = match pooled {
            Some(c) => c,
            None => read_conn(&self.path).map_err(|e| EngineError::Db(e.to_string()))?,
        };
        let out = (|| {
            let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Deferred)?;
            let out = f(&conn)?;
            tx.commit()?;
            Ok(out)
        })()
        .map_err(|e: rusqlite::Error| EngineError::Db(e.to_string()));
        lock(&self.readers).push(conn);
        out
    }

    pub(crate) fn secrets(&self) -> &dyn SecretStore {
        self.secrets.as_ref()
    }

    /// The engine was dropped; background work should stop.
    pub(crate) fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    /// Unit tests: the most rows one write transaction has changed; `reset` starts a new count.
    #[cfg(test)]
    pub(crate) fn max_txn_rows(&self, reset: bool) -> u64 {
        if reset {
            self.max_txn_rows.swap(0, Ordering::SeqCst)
        } else {
            self.max_txn_rows.load(Ordering::SeqCst)
        }
    }

    /// Writes one line to the installed sink, or to stderr when none is set.
    pub(crate) fn log(&self, line: &str) {
        match self.log_sink.get() {
            Some(sink) => sink(line),
            None => eprintln!("{line}"),
        }
    }

    /// Hands one event to the installed sink; dropped when none is set. Call with no engine lock
    /// held: the sink may call back into the engine.
    pub(crate) fn emit(&self, name: &str, payload: Value) {
        if let Some(sink) = self.event_sink.get() {
            sink(name, payload);
        }
    }

    /// The folder's current list generation. A page reads it BEFORE its read transaction, so a
    /// page is never labelled newer than the rows it holds.
    pub(crate) fn list_gen(&self, account_id: &str, folder: &str) -> Result<i64, EngineError> {
        let key = (account_id.to_string(), folder.to_string());
        // Held across the seeding read (a reader connection, never the writer), so a seed and a
        // bump cannot interleave.
        let mut gens = lock(&self.list_gens);
        if let Some(g) = gens.get(&key) {
            return Ok(*g);
        }
        let seeded: i64 = self.read(|c| {
            c.query_row(
                "SELECT max(list_gen) FROM messages WHERE account_id = ?1 AND folder = ?2",
                (account_id, folder),
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(|o| o.flatten().unwrap_or(0))
        })?;
        gens.insert(key, seeded);
        Ok(seeded)
    }

    /// Publishes `gen` as the folder's generation, after the pass that wrote it has committed.
    pub(crate) fn set_list_gen(&self, account_id: &str, folder: &str, gen: i64) {
        let mut gens = lock(&self.list_gens);
        let slot = gens.entry((account_id.to_string(), folder.to_string())).or_insert(0);
        *slot = (*slot).max(gen);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn page(e: &Engine) -> Value {
        e.rpc("mobile.messages.page", json!({ "accountId": "a", "folder": "INBOX", "cursor": null, "limit": 50 }))
            .unwrap()
    }

    #[test]
    fn read_not_blocked_by_writer() {
        let tmp = tempfile::tempdir().unwrap();
        let e = Arc::new(Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap());
        e.write(|c| {
            for uid in 1..=250i64 {
                c.execute(
                    "INSERT INTO messages
                     (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
                     VALUES ('a','INBOX',?1,'s','n','n@example.test',?1,'',0,0,0)",
                    [uid],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let w = Arc::clone(&e);
        let t = std::thread::spawn(move || {
            w.hold_write_txn_for_test(|| {
                tx.send(()).unwrap();
                std::thread::sleep(Duration::from_secs(2));
            })
            .unwrap();
        });
        rx.recv().unwrap();
        let t0 = Instant::now();
        let p = page(&e);
        let took = t0.elapsed();
        assert_eq!(p["rows"].as_array().unwrap().len(), 50);
        assert!(took < Duration::from_millis(100), "read took {took:?} behind a writer");
        t.join().unwrap();
    }

    /// The viewer's header reads the recipients from the list row: `to` is the stored address
    /// list, and a row with none (or a value that does not read) has an empty one.
    #[test]
    fn page_rows_carry_their_recipients() {
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        e.write(|c| {
            for (uid, to) in [(1i64, Some(r#"[{"name":"Grace","address":"grace@example.test"},{"name":"","address":"linus@example.test"}]"#)), (2, None), (3, Some("not json"))] {
                c.execute(
                    "INSERT INTO messages
                     (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, to_json)
                     VALUES ('a','INBOX',?1,'s','n','n@example.test',?1,'',0,0,0,COALESCE(?2,'[]'))",
                    (uid, to),
                )?;
            }
            Ok(())
        })
        .unwrap();
        let p = page(&e);
        let by_uid = |uid: i64| p["rows"].as_array().unwrap().iter().find(|r| r["uid"] == uid).unwrap()["to"].clone();
        assert_eq!(
            by_uid(1),
            json!([{ "name": "Grace", "address": "grace@example.test" }, { "name": "", "address": "linus@example.test" }])
        );
        assert_eq!(by_uid(2), json!([]));
        assert_eq!(by_uid(3), json!([]));
    }
}
