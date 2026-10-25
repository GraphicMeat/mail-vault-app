//! The persisted settings document, `<app_data_dir>/frontend-settings.json`.
//!
//! The daemon owns it: the app reads and changes it through `settings.get`,
//! `settings.patch` and `settings.replace` (`src-daemon/src/handlers/settings.rs`),
//! and every daemon reader goes through [`SettingsDoc::read`]. The format and
//! the location are what the app wrote for years (one JSON object, one key per
//! persisted store: `mailvault-settings`, `mailvault-theme`, ...), so an old
//! app, an old daemon and the e2e specs that read the file keep working.
//!
//! Writes:
//! - atomic: a temp file in the same directory, fsync, one rename (and the
//!   directory fsync'd on unix). A failure at any step leaves the previous
//!   file in place; nothing ever truncates it.
//! - serialised: one writer at a time per process (`inner`), and across
//!   processes by `frontend-settings.json.lock`, which the shell's fallback
//!   writer (`write_document`) takes too.
//! - versioned: a counter in the sidecar `frontend-settings.version.json`
//!   (with the hash of the bytes it belongs to), never in the document. The
//!   old app caches every top-level key and writes it back, so a version
//!   inside the document could only go backwards. A change made on disk by
//!   another writer bumps it when the daemon next looks.
//! - backed up: the previous good file is copied to `.bak1` (newest) through
//!   `.bak5` before the first write of a daemon run and then at most daily.
//!   Never more than five.
//! - refused when the result is not a JSON object.
//!
//! Nothing here logs a value: settings hold account names, folder names and
//! rules. Key names only.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tracing::{info, warn};

pub const FILE_NAME: &str = "frontend-settings.json";
pub const LOCK_NAME: &str = "frontend-settings.json.lock";
pub const VERSION_NAME: &str = "frontend-settings.version.json";
pub const CORRUPT_NAME: &str = "frontend-settings.json.corrupt";
/// How many backups are kept: `frontend-settings.json.bak1` (newest) ..
/// `frontend-settings.json.bak5`.
pub const BACKUP_KEEP: usize = 5;
/// A backup is taken before the first write of a run, then at most this often.
pub const BACKUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Never two rotations closer than this, first write of a run included: five
/// daemon restarts in a row must not push the copy from before them out.
pub const BACKUP_MIN_SPACING: Duration = Duration::from_secs(60 * 60);

pub fn backup_name(n: usize) -> String {
    format!("{FILE_NAME}.bak{n}")
}

/// What `settings.get` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub values: Map<String, Value>,
    pub version: u64,
    /// Set when the file on disk could not be parsed and the values came from
    /// elsewhere: `"memory"` (what this process last read or wrote), or the
    /// backup's file name. The next write replaces the broken file.
    pub recovered: Option<String>,
}

/// What a write answers: the version after it and the top-level keys whose
/// value changed. No change, no write, no new version.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub version: u64,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SettingsError {
    /// The caller passed a `baseVersion` that is no longer current.
    Conflict { current: u64 },
    /// The patch, the values or the resulting document is not a JSON object.
    NotAnObject,
    /// The file could not be written (the old one is intact).
    Io(String),
}

impl SettingsError {
    /// The i18n catalog key the app shows for this error.
    pub fn catalog_key(&self) -> &'static str {
        match self {
            SettingsError::Conflict { .. } => "errors.settingsConflict",
            SettingsError::NotAnObject => "errors.settingsInvalid",
            SettingsError::Io(_) => "errors.settingsWriteFailed",
        }
    }
}

/// RFC 7396 JSON merge patch: `null` deletes a key, an object merges into an
/// object, anything else (arrays included) replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(entries) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let Value::Object(map) = target else { unreachable!() };
    for (key, value) in entries {
        if value.is_null() {
            map.remove(key);
        } else {
            merge_patch(map.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// The top-level keys whose value differs between two documents.
fn changed_keys(before: &Map<String, Value>, after: &Map<String, Value>) -> Vec<String> {
    let mut keys: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|k| before.get(*k) != after.get(*k))
        .cloned()
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// What is on disk at the moment it was read.
enum Disk {
    Missing,
    Good(Vec<u8>, Value),
    /// Bytes that are not a JSON object: a crash under an old non-atomic
    /// writer, a full disk, a hand edit.
    Broken(Vec<u8>),
    Unreadable(String),
}

fn read_disk(path: &Path) -> Disk {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Disk::Missing,
        Err(e) => Disk::Unreadable(e.to_string()),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => Disk::Good(bytes, v),
            _ => Disk::Broken(bytes),
        },
    }
}

/// `read_disk`, giving a writer that does not take the lock (an old app's
/// non-atomic `fs::write`) a moment to finish before calling the file broken.
fn read_disk_settled(path: &Path) -> Disk {
    let mut disk = read_disk(path);
    for _ in 0..3 {
        if !matches!(disk, Disk::Broken(_)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
        disk = read_disk(path);
    }
    disk
}

/// Write `bytes` to `path` so that a reader sees the old file or the new one
/// and never part of either: a temp file in the same directory, fsync'd,
/// renamed over the target, then the directory fsync'd (unix). Any failure
/// removes the temp and leaves `path` as it was.
fn write_durable(path: &Path, bytes: &[u8], fail_before_rename: bool) -> std::io::Result<()> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.tmp-{}-{seq}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if fail_before_rename {
            return Err(std::io::Error::other("simulated crash before the rename"));
        }
        rename_over(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// `rename`, retried briefly on Windows, where a scanner or indexer holding
/// the target open makes the replace fail with access denied for a moment.
fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Err(e) if cfg!(windows) && e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 10 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

/// How long the daemon waits for the cross-process lock (the shell's
/// fallback write holds it for one small write).
const DAEMON_LOCK_WAIT: Duration = Duration::from_secs(10);
/// How long the shell's fallback write waits: it runs for a window, and the
/// app keeps the change queued and retries.
const SHELL_LOCK_WAIT: Duration = Duration::from_secs(2);

/// Holds `frontend-settings.json.lock` exclusively until dropped: the
/// daemon's writes and the shell's fallback writes never interleave. `Err`
/// only when another writer holds it past `wait`. A lock the filesystem
/// cannot take (FAT/exFAT on a portable drive, some network homes) is not a
/// reason to stop saving settings: `Ok(None)`, and the write goes ahead under
/// the process's own lock, as every write did before there was this one.
fn lock_file(dir: &Path, wait: Duration) -> std::io::Result<Option<std::fs::File>> {
    std::fs::create_dir_all(dir)?;
    let file = match std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(LOCK_NAME)) {
        Ok(f) => f,
        Err(e) => {
            lock_unsupported(&e);
            return Ok(None);
        }
    };
    let deadline = std::time::Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Some(file)),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "another writer holds the settings lock"));
            }
            Err(std::fs::TryLockError::Error(e)) => {
                lock_unsupported(&e);
                return Ok(None);
            }
        }
    }
}

fn lock_unsupported(e: &std::io::Error) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| warn!("settings: no file lock here ({e}); writing under the process lock only"));
}

/// Two locks, so a reader never waits on a write's IO (CLAUDE.md, Process
/// and Thread Model): `writer` serialises the writers and is held across the
/// file lock, the reads, the backup, the fsyncs and the sidecar; `inner` only
/// guards the in-memory copy and is held for a comparison or a swap, never
/// across IO. A reader sees the old document or the new one.
pub struct SettingsDoc {
    dir: PathBuf,
    backup_interval: Duration,
    writer: Mutex<()>,
    inner: Mutex<Inner>,
    /// A backup was taken (or found current) in this run. Writer-only.
    backed_up: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    fail_before_rename: std::sync::atomic::AtomicBool,
    /// A write parks this long (holding what it holds) before its rename.
    #[cfg(test)]
    slow_write: Mutex<Option<Duration>>,
    #[cfg(test)]
    in_write: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
struct Inner {
    /// The sidecar has been read into `version`/`sidecar_hash`.
    version_loaded: bool,
    version: u64,
    /// The hash the sidecar says `version` belongs to.
    sidecar_hash: Option<String>,
    /// The file has been looked at by this process.
    observed: bool,
    /// The bytes of the file as this process last read (when they parsed) or
    /// wrote them, and their document. Kept while the file is broken: it is
    /// the best copy to recover from.
    bytes: Option<Vec<u8>>,
    doc: Option<Arc<Value>>,
    /// `version` changed since the sidecar was last written.
    unrecorded: bool,
}

/// What `current` found: the values to work from, the version, the good
/// file's bytes, or the broken file's bytes and where the values came from.
struct Current {
    values: Map<String, Value>,
    version: u64,
    good: Option<Vec<u8>>,
    broken: Option<(Vec<u8>, String)>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Sidecar {
    version: u64,
    sha256: String,
}

impl SettingsDoc {
    /// The one instance for `app_dir` in this process: every reader and the
    /// RPCs share its in-memory copy and its writer lock.
    pub fn shared(app_dir: &Path) -> Arc<SettingsDoc> {
        static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<SettingsDoc>>>> = OnceLock::new();
        let mut map = REGISTRY.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
        Arc::clone(map.entry(app_dir.to_path_buf()).or_insert_with(|| Arc::new(SettingsDoc::open(app_dir))))
    }

    /// A private instance (tests; `shared` is what production uses).
    pub fn open(app_dir: &Path) -> SettingsDoc {
        Self::open_with(app_dir, BACKUP_INTERVAL)
    }

    pub fn open_with(app_dir: &Path, backup_interval: Duration) -> SettingsDoc {
        SettingsDoc {
            dir: app_dir.to_path_buf(),
            backup_interval,
            writer: Mutex::new(()),
            inner: Mutex::new(Inner::default()),
            backed_up: Default::default(),
            #[cfg(test)]
            fail_before_rename: Default::default(),
            #[cfg(test)]
            slow_write: Mutex::new(None),
            #[cfg(test)]
            in_write: Default::default(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Reads the sidecar once per process (outside `inner`).
    fn load_version(&self) {
        if self.lock().version_loaded {
            return;
        }
        let sidecar = std::fs::read(self.dir.join(VERSION_NAME)).ok().and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok());
        let mut inner = self.lock();
        if inner.version_loaded {
            return;
        }
        inner.version_loaded = true;
        if let Some(s) = sidecar {
            inner.version = s.version;
            inner.sidecar_hash = Some(s.sha256);
        }
    }

    /// Takes in a good file read from disk; a change since this process last
    /// saw it (another writer, or one before this run) bumps the version.
    /// Memory only: the caller records the version after letting go.
    fn observe_good(inner: &mut Inner, bytes: Vec<u8>, value: Value) {
        if inner.bytes.as_deref() == Some(&bytes[..]) && inner.doc.is_some() {
            inner.observed = true;
            return;
        }
        let hash = sha_hex(&bytes);
        let changed = match &inner.doc {
            Some(doc) if inner.observed => **doc != value,
            _ => inner.sidecar_hash.as_deref() != Some(hash.as_str()),
        };
        if changed {
            inner.version += 1;
            inner.unrecorded = true;
        }
        inner.sidecar_hash = Some(hash);
        inner.observed = true;
        inner.bytes = Some(bytes);
        inner.doc = Some(Arc::new(value));
    }

    fn observe_missing(inner: &mut Inner) {
        let had = if inner.observed { inner.doc.is_some() } else { inner.sidecar_hash.is_some() };
        if had {
            inner.version += 1;
            inner.unrecorded = true;
        }
        inner.observed = true;
        inner.bytes = None;
        inner.doc = None;
    }

    /// Writes the sidecar when the version moved. Recorded at once, not at
    /// the next write: a daemon that restarts before writing would otherwise
    /// read the old version back and hand the number out again for other
    /// content. Under `writer` (taken here unless the caller holds it), so
    /// two records never land out of order; a reader that finds a write in
    /// progress leaves it to that write.
    fn record_version(&self, writer_held: bool) {
        let _guard = if writer_held {
            None
        } else {
            match self.writer.try_lock() {
                Ok(g) => Some(g),
                Err(_) => return,
            }
        };
        let (version, hash) = {
            let mut inner = self.lock();
            if !inner.unrecorded {
                return;
            }
            inner.unrecorded = false;
            (inner.version, inner.sidecar_hash.clone().unwrap_or_default())
        };
        let sidecar = serde_json::to_vec(&Sidecar { version, sha256: hash }).unwrap_or_default();
        // Small, atomic, no fsync: a lost one costs a spurious bump at most.
        if let Err(e) = crate::fsx::write_atomic(&self.dir.join(VERSION_NAME), &sidecar) {
            warn!("settings: could not record version {version}: {e}");
            self.lock().unrecorded = true;
        }
    }

    /// The document as it is on disk now, for the daemon's readers. `Err` when
    /// the file is missing, unreadable, not JSON, or not an object: a reader
    /// that acts on the answer (the eviction worker deletes on it) must see
    /// exactly what it saw when it read the file itself, never a backup.
    ///
    /// Reads the bytes every time (other writers exist: the shell's fallback,
    /// an older app); only the parse is reused while they are unchanged.
    pub fn read(&self) -> Result<Arc<Value>, String> {
        let bytes = std::fs::read(self.path()).map_err(|e| format!("settings unreadable: {e}"))?;
        {
            let inner = self.lock();
            if inner.bytes.as_deref() == Some(&bytes[..]) {
                if let Some(doc) = &inner.doc {
                    return Ok(Arc::clone(doc));
                }
            }
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("settings unparseable: {e}"))?;
        if !value.is_object() {
            return Err("settings hold no JSON object".to_string());
        }
        self.load_version();
        let doc = {
            let mut inner = self.lock();
            Self::observe_good(&mut inner, bytes, value);
            Arc::clone(inner.doc.as_ref().expect("observed"))
        };
        self.record_version(false);
        Ok(doc)
    }

    /// The newest backup that parses (IO: never under `inner`).
    fn newest_backup(&self) -> Option<(Map<String, Value>, String)> {
        (1..=BACKUP_KEEP).find_map(|n| {
            let name = backup_name(n);
            match read_disk(&self.dir.join(&name)) {
                Disk::Good(_, Value::Object(map)) => Some((map, name)),
                _ => None,
            }
        })
    }

    /// The current document and its version (and, when the file is broken,
    /// its bytes and where the values came from instead). Takes in whatever
    /// changed on disk. The disk reads happen outside `inner`.
    fn current(&self) -> Result<Current, SettingsError> {
        self.load_version();
        let disk = read_disk_settled(&self.path());
        let current = {
            let mut inner = self.lock();
            match disk {
                Disk::Missing => {
                    Self::observe_missing(&mut inner);
                    Current { values: Map::new(), version: inner.version, good: None, broken: None }
                }
                Disk::Good(bytes, value) => {
                    let good = bytes.clone();
                    Self::observe_good(&mut inner, bytes, value);
                    let values = match inner.doc.as_deref() {
                        Some(Value::Object(map)) => map.clone(),
                        _ => Map::new(),
                    };
                    Current { values, version: inner.version, good: Some(good), broken: None }
                }
                Disk::Broken(bytes) => {
                    inner.observed = true;
                    // What this process last read or wrote is the best copy.
                    let memory = match inner.doc.as_deref() {
                        Some(Value::Object(map)) => Some(map.clone()),
                        _ => None,
                    };
                    let (values, from) = match memory {
                        Some(map) => (map, Some("memory".to_string())),
                        None => (Map::new(), None),
                    };
                    Current { values, version: inner.version, good: None, broken: Some((bytes, from.unwrap_or_default())) }
                }
                Disk::Unreadable(e) => return Err(SettingsError::Io(e)),
            }
        };
        self.record_version(false);
        let mut current = current;
        if let Some((bytes, from)) = &mut current.broken {
            if from.is_empty() {
                let (values, name) = self.newest_backup().unwrap_or_else(|| (Map::new(), "empty".to_string()));
                current.values = values;
                *from = name;
            }
            warn!("settings: {FILE_NAME} does not parse ({} bytes); working from {from}", bytes.len());
        }
        Ok(current)
    }

    /// The whole document, or only `keys` (those present), plus its version.
    /// A missing file is an empty document. Never writes the document.
    pub fn get(&self, keys: Option<&[String]>) -> Result<Snapshot, SettingsError> {
        let Current { mut values, version, broken, .. } = self.current()?;
        if let Some(keys) = keys {
            values.retain(|k, _| keys.contains(k));
        }
        Ok(Snapshot { values, version, recovered: broken.map(|(_, from)| from) })
    }

    /// Applies a merge patch (see [`merge_patch`]) to the document.
    pub fn patch(&self, patch: &Value, base_version: Option<u64>) -> Result<Change, SettingsError> {
        if !patch.is_object() {
            return Err(SettingsError::NotAnObject);
        }
        self.write_op(base_version, |doc| merge_patch(doc, patch))
    }

    /// Replaces the listed top-level keys wholesale; `null` deletes one. What
    /// the app's persisted stores need: each key holds a whole serialized
    /// store, and a merge patch cannot drop a nested key the store removed.
    pub fn replace(&self, values: &Value, base_version: Option<u64>) -> Result<Change, SettingsError> {
        let Value::Object(entries) = values else {
            return Err(SettingsError::NotAnObject);
        };
        self.write_op(base_version, |doc| {
            if let Value::Object(map) = doc {
                for (key, value) in entries {
                    if value.is_null() {
                        map.remove(key);
                    } else {
                        map.insert(key.clone(), value.clone());
                    }
                }
            }
        })
    }

    /// Apply a whole-store UI write using its last accepted baseline. Only
    /// mailvault-settings is shared at nested field granularity with native
    /// writers. Other stores retain replace semantics. Null removes a store;
    /// nested null is a value, unlike JSON merge patch's deletion operator.
    pub fn replace_rebased(&self, values: &Value, bases: &Value, base_version: Option<u64>) -> Result<Change, SettingsError> {
        let entries = values.as_object().ok_or(SettingsError::NotAnObject)?;
        let bases = bases.as_object().ok_or(SettingsError::NotAnObject)?;
        self.write_op(base_version, |doc| {
            let map = doc.as_object_mut().expect("settings document object");
            for (key, value) in entries {
                if value.is_null() { map.remove(key); }
                else if key == "mailvault-settings" && bases.contains_key(key) {
                    apply_store_delta(map.entry(key.clone()).or_insert(Value::Null), &bases[key], value);
                } else { map.insert(key.clone(), value.clone()); }
            }
        })
    }

    fn write_op(&self, base_version: Option<u64>, apply: impl FnOnce(&mut Value)) -> Result<Change, SettingsError> {
        let _writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let _file_lock = lock_file(&self.dir, DAEMON_LOCK_WAIT).map_err(|e| SettingsError::Io(e.to_string()))?;
        let Current { values: before, version, good, broken } = self.current()?;
        // `current` may have taken another writer's change in.
        self.record_version(true);
        if let Some(base) = base_version {
            if base != version {
                return Err(SettingsError::Conflict { current: version });
            }
        }
        let mut next = Value::Object(before.clone());
        apply(&mut next);
        let Value::Object(after) = &next else {
            return Err(SettingsError::NotAnObject);
        };
        let changed = changed_keys(&before, after);
        if changed.is_empty() {
            return Ok(Change { version, changed });
        }

        self.sweep_temps();
        if let Some(bytes) = &good {
            self.maybe_backup(bytes);
        }
        if let Some((bytes, _)) = &broken {
            if let Err(e) = write_durable(&self.dir.join(CORRUPT_NAME), bytes, false) {
                warn!("settings: could not keep the broken file aside: {e}");
            }
        }
        let bytes = serde_json::to_vec(&next).map_err(|e| SettingsError::Io(e.to_string()))?;
        #[cfg(test)]
        let fail = self.fail_before_rename.load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(test)]
        if let Some(pause) = *self.slow_write.lock().unwrap_or_else(|p| p.into_inner()) {
            self.in_write.store(true, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(pause);
        }
        #[cfg(not(test))]
        let fail = false;
        write_durable(&self.path(), &bytes, fail).map_err(|e| {
            warn!("settings: write of {changed:?} failed, the file is unchanged: {e}");
            SettingsError::Io(e.to_string())
        })?;

        let version = {
            let mut inner = self.lock();
            // A reader can take the new file in between the rename and here;
            // it already counted it, so it is not counted twice.
            if inner.bytes.as_deref() != Some(&bytes[..]) {
                inner.version += 1;
                inner.sidecar_hash = Some(sha_hex(&bytes));
                inner.bytes = Some(bytes);
                inner.doc = Some(Arc::new(next));
            }
            inner.observed = true;
            inner.unrecorded = true;
            inner.version
        };
        self.record_version(true);
        info!("settings: wrote {changed:?}, version {version}");
        Ok(Change { version, changed })
    }

    /// Copies the current good file to `.bak1` (shifting the older ones up,
    /// dropping the sixth) when there is no backup yet, before the first
    /// write of a run once the newest backup is an hour old, and then once it
    /// is older than the interval; only when the file differs from `.bak1`.
    /// A backup failure never stops the write itself.
    fn maybe_backup(&self, current: &[u8]) {
        use std::sync::atomic::Ordering::SeqCst;
        let bak1 = self.dir.join(backup_name(1));
        let age = std::fs::metadata(&bak1).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        let exists = bak1.exists();
        // A newest backup dated in the future (the clock went back, a network
        // filesystem's clock) has no age: not due, or every write would
        // rotate and push every older copy out.
        let spacing = BACKUP_MIN_SPACING.min(self.backup_interval);
        let wait = if self.backed_up.load(SeqCst) { self.backup_interval } else { spacing };
        let due = !exists || age.is_some_and(|a| a >= wait);
        if !due {
            return;
        }
        self.backed_up.store(true, SeqCst);
        if std::fs::read(&bak1).ok().as_deref() == Some(current) {
            return;
        }
        let _ = std::fs::remove_file(self.dir.join(backup_name(BACKUP_KEEP)));
        for n in (1..BACKUP_KEEP).rev() {
            let from = self.dir.join(backup_name(n));
            if from.exists() {
                if let Err(e) = std::fs::rename(&from, self.dir.join(backup_name(n + 1))) {
                    warn!("settings: could not rotate backup {n}: {e}");
                }
            }
        }
        if let Err(e) = write_durable(&bak1, current, false) {
            warn!("settings: could not write the backup: {e}");
        }
        self.drop_extra_backups();
    }

    /// Any `.bakN` past the fifth (an interrupted rotation, an older scheme).
    fn drop_extra_backups(&self) {
        let prefix = format!("{FILE_NAME}.bak");
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let extra = name.strip_prefix(&prefix).and_then(|n| n.parse::<usize>().ok()).is_some_and(|n| n == 0 || n > BACKUP_KEEP);
            if extra {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Temp files a writer that died left behind (never one younger than a
    /// minute: that may be the shell's fallback writer mid-write).
    fn sweep_temps(&self) {
        let prefix = format!(".{FILE_NAME}.tmp-");
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(&prefix) {
                continue;
            }
            let stale = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a >= STALE_TEMP);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// A temp file older than this is left over from a writer that died.
const STALE_TEMP: Duration = Duration::from_secs(60);

fn apply_store_delta(current: &mut Value, before: &Value, after: &Value) {
    if before == after { return; }
    if let Some(next) = after.as_object().filter(|_| before.is_object() || before.is_null()) {
        if !current.is_object() { *current = Value::Object(Map::new()); }
        let current = current.as_object_mut().unwrap();
        if let Some(previous) = before.as_object() {
            for key in previous.keys().filter(|key| !next.contains_key(*key)) { current.remove(key); }
        }
        for (key, value) in next {
            let prior = before.get(key).unwrap_or(&Value::Null);
            // A present null added to an absent field is an explicit value.
            if before.get(key).is_none() && value.is_null() { current.insert(key.clone(), Value::Null); }
            else if before.get(key) != Some(value) {
                apply_store_delta(current.entry(key.clone()).or_insert(Value::Null), prior, value);
            }
        }
    } else { *current = after.clone(); }
}

/// The shell's fallback write (`write_settings_json`, for a daemon without
/// `settings.*`): the whole document, refused unless it is a JSON object,
/// written atomically under the same lock the daemon takes. The error is a
/// catalog key; the reason goes to the log.
pub fn write_document(app_dir: &Path, data: &str) -> Result<(), String> {
    write_document_waiting(app_dir, data, SHELL_LOCK_WAIT)
}

fn write_document_waiting(app_dir: &Path, data: &str, wait: Duration) -> Result<(), String> {
    match serde_json::from_str::<Value>(data) {
        Ok(v) if v.is_object() => {}
        _ => {
            warn!("settings: refused a fallback write that is not a JSON object ({} bytes)", data.len());
            return Err(SettingsError::NotAnObject.catalog_key().to_string());
        }
    }
    let result = lock_file(app_dir, wait).and_then(|_lock| write_durable(&app_dir.join(FILE_NAME), data.as_bytes(), false));
    result.map_err(|e| {
        warn!("settings: fallback write failed, the file is unchanged: {e}");
        SettingsError::Io(e.to_string()).catalog_key().to_string()
    })
}

#[cfg(test)]
mod tests;
