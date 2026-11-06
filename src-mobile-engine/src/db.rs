//! `<dir>/mobile.db`: a cache of what the mobile list shows. It can always be rebuilt from the
//! server, so unlike `app.db` a corrupt file is deleted and recreated. A file from a NEWER build is
//! the opposite case: it is left byte-for-byte alone and `open` refuses.
//!
//! One writer connection (writes go through `BEGIN IMMEDIATE`, as `app_db::in_txn` does) and a
//! small pool of read-only connections, so a list read never queues behind a write.

use crate::secrets::SecretStore;
use rusqlite::{Connection, ErrorCode, OpenFlags, Transaction, TransactionBehavior};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

pub const DB_FILE: &str = "mobile.db";
pub const SCHEMA_VERSION: u32 = 1;
const READERS: usize = 2;

const SCHEMA_V1: &str = "
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
  PRIMARY KEY (account_id, folder, uid)
) WITHOUT ROWID;
CREATE INDEX messages_by_date ON messages (account_id, folder, date_ms DESC, uid DESC);
";

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
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    /// Rebuildable files (message bodies, attachments) live here, never in `mobile.db`.
    cache_dir: PathBuf,
    /// Account secrets. Never copied into `mobile.db`, a log line or an event.
    secrets: Arc<dyn SecretStore>,
    /// Where the engine's own log lines go. The shell installs its platform logger (unified log on
    /// iOS, logcat on Android); app stdout reaches neither, so stderr is only the fallback.
    log_sink: OnceLock<LogSink>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
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
    if found == 0 {
        let tx = Transaction::new_unchecked(&w, TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA_V1)?;
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
            path: db.path,
            writer: Mutex::new(db.writer),
            readers: Mutex::new(db.readers),
            cache_dir: cache_dir.to_path_buf(),
            secrets,
            log_sink: OnceLock::new(),
        })
    }

    /// The directory for rebuildable files the shell passed to `open`.
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    /// The platform secret store the shell passed to `open`.
    pub fn secrets(&self) -> &dyn SecretStore {
        self.secrets.as_ref()
    }

    /// Installs the sink for the engine's log lines. The first sink wins; returns false if one was
    /// already set.
    pub fn set_log_sink(&self, sink: impl Fn(&str) + Send + Sync + 'static) -> bool {
        self.log_sink.set(Box::new(sink)).is_ok()
    }

    /// Writes one line to the installed sink, or to stderr when none is set.
    #[cfg(feature = "perf-gate")]
    pub(crate) fn log(&self, line: &str) {
        match self.log_sink.get() {
            Some(sink) => sink(line),
            None => eprintln!("{line}"),
        }
    }

    /// Runs `f` inside `BEGIN IMMEDIATE` on the single writer connection.
    pub(crate) fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, EngineError> {
        let w = lock(&self.writer);
        let tx = Transaction::new_unchecked(&w, TransactionBehavior::Immediate).map_err(|e| EngineError::Db(e.to_string()))?;
        let out = f(&w).map_err(|e| EngineError::Db(e.to_string()))?;
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

    /// Test seam for `read_not_blocked_by_writer`: runs `f` inside a write transaction that stays
    /// open until `f` returns. Unit tests only, so no build of the crate (shipping or perf-gate)
    /// carries it.
    #[cfg(test)]
    fn hold_write_txn_for_test<T>(&self, f: impl FnOnce() -> T) -> Result<T, EngineError> {
        self.write(|c| {
            // Make it a real write so the WAL has a pending writer.
            c.execute(
                "INSERT OR REPLACE INTO messages VALUES ('hold','hold',1,'','','',0,'',0,0,0)",
                [],
            )?;
            Ok(f())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn page(e: &Engine) -> Value {
        e.rpc("mobile.messages.page", json!({ "accountId": "a", "folder": "INBOX", "offset": 0, "limit": 50 }))
            .unwrap()
    }

    #[test]
    fn read_not_blocked_by_writer() {
        let tmp = tempfile::tempdir().unwrap();
        let e = Arc::new(Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap());
        e.write(|c| {
            for uid in 1..=250i64 {
                c.execute(
                    "INSERT INTO messages VALUES ('a','INBOX',?1,'s','n','n@example.test',?1,'',0,0,0)",
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
}
