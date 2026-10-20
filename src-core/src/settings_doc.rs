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

pub struct SettingsDoc {
    dir: PathBuf,
    backup_interval: Duration,
    inner: Mutex<Inner>,
    #[cfg(test)]
    fail_before_rename: std::sync::atomic::AtomicBool,
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
    /// A backup was taken (or found current) in this run.
    backed_up: bool,
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
            inner: Mutex::new(Inner::default()),
            #[cfg(test)]
            fail_before_rename: Default::default(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn load_version(&self, inner: &mut Inner) {
        if inner.version_loaded {
            return;
        }
        inner.version_loaded = true;
        let sidecar = std::fs::read(self.dir.join(VERSION_NAME)).ok().and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok());
        if let Some(s) = sidecar {
            inner.version = s.version;
            inner.sidecar_hash = Some(s.sha256);
        }
    }

    /// Takes in a good file read from disk; a change since this process last
    /// saw it (another writer, or one before this run) bumps the version.
    fn observe_good(&self, inner: &mut Inner, bytes: Vec<u8>, value: Value) {
        self.load_version(inner);
        if inner.bytes.as_deref() == Some(&bytes[..]) && inner.doc.is_some() {
            inner.observed = true;
            return;
        }
        let changed = match &inner.doc {
            Some(doc) if inner.observed => **doc != value,
            _ => inner.sidecar_hash.as_deref() != Some(sha_hex(&bytes).as_str()),
        };
        if changed {
            inner.version += 1;
        }
        inner.observed = true;
        inner.bytes = Some(bytes);
        inner.doc = Some(Arc::new(value));
    }

    fn observe_missing(&self, inner: &mut Inner) {
        self.load_version(inner);
        let had = if inner.observed { inner.doc.is_some() } else { inner.sidecar_hash.is_some() };
        if had {
            inner.version += 1;
        }
        inner.observed = true;
        inner.bytes = None;
        inner.doc = None;
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
        let mut inner = self.lock();
        if inner.bytes.as_deref() == Some(&bytes[..]) {
            if let Some(doc) = &inner.doc {
                return Ok(Arc::clone(doc));
            }
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("settings unparseable: {e}"))?;
        if !value.is_object() {
            return Err("settings hold no JSON object".to_string());
        }
        self.observe_good(&mut inner, bytes, value);
        Ok(Arc::clone(inner.doc.as_ref().expect("observed")))
    }

    /// What to work from when the file is broken: what this process last
    /// read or wrote, else the newest backup that parses, else nothing.
    fn recover(&self, inner: &Inner) -> (Map<String, Value>, String) {
        if let Some(Value::Object(map)) = inner.doc.as_deref() {
            return (map.clone(), "memory".to_string());
        }
        for n in 1..=BACKUP_KEEP {
            let name = backup_name(n);
            if let Disk::Good(_, Value::Object(map)) = read_disk(&self.dir.join(&name)) {
                return (map, name);
            }
        }
        (Map::new(), "empty".to_string())
    }

    /// The current document (and, when the file is broken, where it came
    /// from instead). Takes in whatever changed on disk.
    fn current(&self, inner: &mut Inner) -> Result<(Map<String, Value>, Option<(Vec<u8>, String)>), SettingsError> {
        match read_disk_settled(&self.path()) {
            Disk::Missing => {
                self.observe_missing(inner);
                Ok((Map::new(), None))
            }
            Disk::Good(bytes, value) => {
                self.observe_good(inner, bytes, value);
                match inner.doc.as_deref() {
                    Some(Value::Object(map)) => Ok((map.clone(), None)),
                    _ => Ok((Map::new(), None)),
                }
            }
            Disk::Broken(bytes) => {
                self.load_version(inner);
                inner.observed = true;
                let (map, from) = self.recover(inner);
                warn!("settings: {FILE_NAME} does not parse ({} bytes); working from {from}", bytes.len());
                Ok((map, Some((bytes, from))))
            }
            Disk::Unreadable(e) => Err(SettingsError::Io(e)),
        }
    }

    /// The whole document, or only `keys` (those present), plus its version.
    /// A missing file is an empty document. Never writes.
    pub fn get(&self, keys: Option<&[String]>) -> Result<Snapshot, SettingsError> {
        let mut inner = self.lock();
        let (mut values, broken) = self.current(&mut inner)?;
        if let Some(keys) = keys {
            values.retain(|k, _| keys.contains(k));
        }
        Ok(Snapshot { values, version: inner.version, recovered: broken.map(|(_, from)| from) })
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

    fn write_op(&self, base_version: Option<u64>, apply: impl FnOnce(&mut Value)) -> Result<Change, SettingsError> {
        let mut inner = self.lock();
        let _file_lock = lock_file(&self.dir, DAEMON_LOCK_WAIT).map_err(|e| SettingsError::Io(e.to_string()))?;
        let (before, broken) = self.current(&mut inner)?;
        if let Some(base) = base_version {
            if base != inner.version {
                return Err(SettingsError::Conflict { current: inner.version });
            }
        }
        let mut next = Value::Object(before.clone());
        apply(&mut next);
        let Value::Object(after) = &next else {
            return Err(SettingsError::NotAnObject);
        };
        let changed = changed_keys(&before, after);
        if changed.is_empty() {
            return Ok(Change { version: inner.version, changed });
        }

        self.sweep_temps();
        if broken.is_none() {
            if let Some(bytes) = inner.bytes.clone() {
                self.maybe_backup(&mut inner, &bytes);
            }
        }
        if let Some((bytes, _)) = &broken {
            if let Err(e) = write_durable(&self.dir.join(CORRUPT_NAME), bytes, false) {
                warn!("settings: could not keep the broken file aside: {e}");
            }
        }
        let bytes = serde_json::to_vec(&next).map_err(|e| SettingsError::Io(e.to_string()))?;
        #[cfg(test)]
        let fail = self.fail_before_rename.load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let fail = false;
        write_durable(&self.path(), &bytes, fail).map_err(|e| {
            warn!("settings: write of {changed:?} failed, the file is unchanged: {e}");
            SettingsError::Io(e.to_string())
        })?;

        inner.version += 1;
        let hash = sha_hex(&bytes);
        let sidecar = serde_json::to_vec(&Sidecar { version: inner.version, sha256: hash.clone() }).unwrap_or_default();
        if let Err(e) = crate::fsx::write_atomic(&self.dir.join(VERSION_NAME), &sidecar) {
            warn!("settings: could not record version {}: {e}", inner.version);
        }
        inner.sidecar_hash = Some(hash);
        inner.bytes = Some(bytes);
        inner.doc = Some(Arc::new(next));
        info!("settings: wrote {changed:?}, version {}", inner.version);
        Ok(Change { version: inner.version, changed })
    }

    /// Copies the current good file to `.bak1` (shifting the older ones up,
    /// dropping the sixth) before the first write of a run, and then once the
    /// newest backup is older than the interval. A backup failure never
    /// stops the write itself.
    fn maybe_backup(&self, inner: &mut Inner, current: &[u8]) {
        let bak1 = self.dir.join(backup_name(1));
        let age = std::fs::metadata(&bak1).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        let due = !inner.backed_up || age.is_none_or(|a| a >= self.backup_interval);
        if !due {
            return;
        }
        inner.backed_up = true;
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
