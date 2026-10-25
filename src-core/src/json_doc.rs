//! A JSON document one process owns on disk: atomic, versioned, backed up.
//!
//! Shared storage engine for the settings facade and typed JSON documents.
//! Callers own validation and mutation policy; this module owns persistence.
//! Array and scrub primitives are available for separately reviewed consumers.
//!
//! For a document `<name>` in `dir`:
//! - writes are atomic: a temp file `.<name>.tmp-<pid>-<n>` in the same
//!   directory, fsync, one rename (and the directory fsync'd on unix). A
//!   failure at any step leaves the previous file in place; nothing ever
//!   truncates it.
//! - writes are serialised: one writer at a time per process (`writer`), and
//!   across processes by `<name>.lock`.
//! - the version is a counter in the sidecar `<stem>.version.json` (with the
//!   hash of the bytes it belongs to), never in the document. A change made
//!   on disk by another writer bumps it when this process next looks.
//! - the previous good file is copied to `<name>.bak1` (newest) through
//!   `<name>.bak5` before the first write of a run (once the newest backup is
//!   an hour old) and then at most daily. Never more than five.
//! - a result of the wrong shape (`Kind`) is refused.
//! - a file that does not parse, or has the wrong shape, is broken: the value
//!   comes from what this process last saw, else the newest good backup, else
//!   the empty document; the next write keeps the broken bytes in
//!   `<name>.corrupt` and replaces the file.
//!
//! Nothing here logs a value. File names, sizes and counts only.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tracing::{info, warn};

/// How many backups are kept: `<name>.bak1` (newest) .. `<name>.bak5`.
pub const BACKUP_KEEP: usize = 5;
/// A backup is taken before the first write of a run, then at most this often.
pub const BACKUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Never two rotations closer than this, first write of a run included: five
/// restarts in a row must not push the copy from before them out.
pub const BACKUP_MIN_SPACING: Duration = Duration::from_secs(60 * 60);
/// A temp file older than this is left over from a writer that died.
const STALE_TEMP: Duration = Duration::from_secs(60);
/// How long a writer waits for the cross-process lock (another process's
/// write holds it for one small write).
pub const LOCK_WAIT: Duration = Duration::from_secs(10);

/// The shape a document must have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Object,
    Array,
}

impl Kind {
    pub fn accepts(self, v: &Value) -> bool {
        match self {
            Kind::Object => v.is_object(),
            Kind::Array => v.is_array(),
        }
    }

    pub fn empty(self) -> Value {
        match self {
            Kind::Object => Value::Object(Default::default()),
            Kind::Array => Value::Array(Vec::new()),
        }
    }
}

/// The two existing persistence contracts, selected by the document owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Persistence {
    /// Ordinary creation mode; atomic version sidecars without fsync.
    SettingsCompatible,
    /// Private file creation and durable version sidecars.
    PrivateDurable,
}

/// What a document is called on disk and how it is written.
#[derive(Debug, Clone, Copy)]
pub struct Spec {
    pub file: &'static str,
    pub kind: Kind,
    /// Two-space indented, as `JSON.stringify(v, null, 2)` wrote it.
    pub pretty: bool,
    pub persistence: Persistence,
}

impl Spec {
    pub fn lock_name(&self) -> String {
        format!("{}.lock", self.file)
    }

    pub fn version_name(&self) -> String {
        let stem = self.file.strip_suffix(".json").unwrap_or(self.file);
        format!("{stem}.version.json")
    }

    pub fn corrupt_name(&self) -> String {
        format!("{}.corrupt", self.file)
    }

    pub fn backup_name(&self, n: usize) -> String {
        format!("{}.bak{n}", self.file)
    }

    fn temp_prefix(&self) -> String {
        format!(".{}.tmp-", self.file)
    }

    fn encode(&self, v: &Value) -> Result<Vec<u8>, serde_json::Error> {
        if self.pretty {
            serde_json::to_vec_pretty(v)
        } else {
            serde_json::to_vec(v)
        }
    }
}

/// A cleaning pass for `JsonDoc::write_op_scrubbed`.
pub struct Scrub<'a> {
    pub clean: &'a dyn Fn(&mut Value) -> Vec<String>,
    /// Clean the document written too, not only its backup.
    pub live: bool,
}

/// What a read answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub value: Value,
    pub version: u64,
    /// Set when the file on disk is broken and the value came from elsewhere:
    /// `"memory"` (what this process last read or wrote), a backup's file
    /// name, or `"empty"`. The next write replaces the broken file.
    pub recovered: Option<String>,
}

/// What a write answers: the version after it and what the caller said
/// changed. No change, no write, no new version.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub version: u64,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DocError {
    /// The caller passed a base version that is no longer current.
    Conflict { current: u64 },
    /// The request or the resulting document has the wrong shape.
    Invalid,
    /// The file could not be read or written (the old one is intact).
    Io(String),
}

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What is on disk at the moment it was read.
enum Disk {
    Missing,
    Good(Vec<u8>, Value),
    /// Bytes that do not parse or have the wrong shape: a crash under an old
    /// non-atomic writer, a full disk, a hand edit.
    Broken(Vec<u8>),
    Unreadable(String),
}

fn read_disk(path: &Path, kind: Kind) -> Disk {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Disk::Missing,
        Err(e) => Disk::Unreadable(e.to_string()),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if kind.accepts(&v) => Disk::Good(bytes, v),
            _ => Disk::Broken(bytes),
        },
    }
}

/// `read_disk`, giving a writer that does not take the lock (an old app's
/// non-atomic write) a moment to finish before calling the file broken.
fn read_disk_settled(path: &Path, kind: Kind) -> Disk {
    let mut disk = read_disk(path, kind);
    for _ in 0..3 {
        if !matches!(disk, Disk::Broken(_)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
        disk = read_disk(path, kind);
    }
    disk
}

/// Write `bytes` to `path` so that a reader sees the old file or the new one
/// and never part of either: a temp file in the same directory, fsync'd,
/// renamed over the target, then the directory fsync'd (unix). Any failure
/// removes the temp and leaves `path` as it was.
pub(crate) fn write_durable(
    path: &Path,
    bytes: &[u8],
    persistence: Persistence,
) -> std::io::Result<()> {
    write_durable_inner(path, bytes, false, persistence)
}

fn write_durable_inner(
    path: &Path,
    bytes: &[u8],
    fail_before_rename: bool,
    persistence: Persistence,
) -> std::io::Result<()> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.tmp-{}-{seq}", std::process::id()));
    let result = (|| {
        let mut file = match persistence {
            Persistence::SettingsCompatible => std::fs::File::create(&tmp)?,
            Persistence::PrivateDurable => create_private(&tmp)?,
        };
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

/// A new file with mode 0600 on unix, subject to the process umask. On
/// Windows a file under the user's profile (the app data dir)
/// inherits its folder's per-user ACL; the repo has no stricter helper.
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// `rename`, retried briefly on Windows, where a scanner or indexer holding
/// the target open makes the replace fail with access denied for a moment.
fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Err(e)
                if cfg!(windows)
                    && e.kind() == std::io::ErrorKind::PermissionDenied
                    && attempt < 10 =>
            {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

/// Holds `<name>.lock` exclusively until dropped: two processes' writes never
/// interleave. `Err` only when another writer holds it past `wait`. A lock
/// the filesystem cannot take (FAT/exFAT on a portable drive, some network
/// homes) is not a reason to stop saving: `Ok(None)`, and the write goes
/// ahead. JsonDoc retains its process writer lock; a raw fallback has no
/// shared process lock when the filesystem lock is unavailable.
pub(crate) fn lock_file(
    dir: &Path,
    name: &str,
    wait: Duration,
    persistence: Persistence,
) -> std::io::Result<Option<std::fs::File>> {
    std::fs::create_dir_all(dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        if persistence == Persistence::PrivateDurable {
            options.mode(0o600);
        }
    }
    #[cfg(not(unix))]
    let _ = persistence;
    let file = match options.open(dir.join(name)) {
        Ok(f) => f,
        Err(e) => {
            lock_unsupported(name, &e);
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
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("another writer holds {name}"),
                ));
            }
            Err(std::fs::TryLockError::Error(e)) => {
                lock_unsupported(name, &e);
                return Ok(None);
            }
        }
    }
}

fn lock_unsupported(name: &str, e: &std::io::Error) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        warn!("json doc: no file lock for {name} here ({e}); continuing without an OS file lock")
    });
}

/// Two locks, so a reader never waits on a write's IO (CLAUDE.md, Process
/// and Thread Model): `writer` serialises the writers and is held across the
/// file lock, the reads, the backup, the fsyncs and the sidecar; `inner` only
/// guards the in-memory copy and is held for a comparison or a swap, never
/// across IO. A reader sees the old document or the new one.
pub struct JsonDoc {
    spec: Spec,
    dir: PathBuf,
    backup_interval: Duration,
    writer: Mutex<()>,
    inner: Mutex<Inner>,
    /// A backup was taken (or found current) in this run. Writer-only.
    backed_up: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(crate) fail_before_rename: std::sync::atomic::AtomicBool,
    /// A write parks this long (holding what it holds) before its rename.
    #[cfg(test)]
    pub(crate) slow_write: Mutex<Option<Duration>>,
    #[cfg(test)]
    pub(crate) in_write: std::sync::atomic::AtomicBool,
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
    /// The bytes of the file as this process last read (when good) or wrote
    /// them, and their document. Kept while the file is broken: it is the
    /// best copy to recover from.
    bytes: Option<Vec<u8>>,
    doc: Option<Arc<Value>>,
    /// `version` changed since the sidecar was last written.
    unrecorded: bool,
}

/// What `current` found.
struct Current {
    value: Value,
    version: u64,
    good: Option<Vec<u8>>,
    broken: Option<(Vec<u8>, String)>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Sidecar {
    version: u64,
    sha256: String,
}

impl JsonDoc {
    /// The one instance for this document in `dir` in this process: every
    /// reader and writer shares its in-memory copy and its writer lock.
    pub fn shared(dir: &Path, spec: Spec) -> Arc<JsonDoc> {
        type Registry = Mutex<HashMap<(PathBuf, &'static str), Arc<JsonDoc>>>;
        static REGISTRY: OnceLock<Registry> = OnceLock::new();
        let mut map = REGISTRY
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        Arc::clone(
            map.entry((dir.to_path_buf(), spec.file))
                .or_insert_with(|| Arc::new(JsonDoc::open(dir, spec))),
        )
    }

    /// A private instance (tests; `shared` is what production uses).
    pub fn open(dir: &Path, spec: Spec) -> JsonDoc {
        Self::open_with(dir, spec, BACKUP_INTERVAL)
    }

    pub fn open_with(dir: &Path, spec: Spec, backup_interval: Duration) -> JsonDoc {
        JsonDoc {
            spec,
            dir: dir.to_path_buf(),
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

    pub fn spec(&self) -> Spec {
        self.spec
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(self.spec.file)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Reads the sidecar once per process (outside `inner`).
    fn load_version(&self) {
        if self.lock().version_loaded {
            return;
        }
        let sidecar = std::fs::read(self.dir.join(self.spec.version_name()))
            .ok()
            .and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok());
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

    /// The sidecar as it is on disk now (IO: never under `inner`).
    fn read_sidecar(&self) -> Option<Sidecar> {
        std::fs::read(self.dir.join(self.spec.version_name()))
            .ok()
            .and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok())
    }

    /// Takes in a good file read from disk; a change since this process last
    /// saw it (another writer, or one before this run) moves the version.
    /// When the sidecar on disk names these very bytes (another process that
    /// writes through this module recorded them), its version is taken over,
    /// so every such process answers the same version for the same document
    /// and a base version is a fence across them; otherwise (a writer that
    /// keeps no sidecar) the version goes up by one. Never backwards. Memory
    /// only: the caller records the version after letting go. Matching newer
    /// records are adopted even when unseen writes returned to cached bytes.
    fn observe_good(inner: &mut Inner, bytes: Vec<u8>, value: Value, sidecar: Option<&Sidecar>) {
        let hash = sha_hex(&bytes);
        let changed = match &inner.doc {
            Some(doc) if inner.observed => **doc != value,
            _ => inner.sidecar_hash.as_deref() != Some(hash.as_str()),
        };
        let recorded = sidecar.filter(|s| s.sha256 == hash).map(|s| s.version);
        match recorded {
            Some(v) if v >= inner.version => {
                // Already on disk for these bytes: nothing to record.
                inner.version = v;
            }
            _ if changed => {
                inner.version += 1;
                inner.unrecorded = true;
            }
            _ => {}
        }
        inner.sidecar_hash = Some(hash);
        inner.observed = true;
        inner.bytes = Some(bytes);
        inner.doc = Some(Arc::new(value));
    }

    fn observe_missing(inner: &mut Inner) {
        let had = if inner.observed {
            inner.doc.is_some()
        } else {
            inner.sidecar_hash.is_some()
        };
        if had {
            inner.version += 1;
            inner.unrecorded = true;
        }
        inner.observed = true;
        inner.bytes = None;
        inner.doc = None;
    }

    /// Writes the sidecar when the version moved. Recorded at once, not at
    /// the next write: a process that restarts before writing would otherwise
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
            (
                inner.version,
                inner.sidecar_hash.clone().unwrap_or_default(),
            )
        };
        let sidecar = serde_json::to_vec(&Sidecar {
            version,
            sha256: hash,
        })
        .unwrap_or_default();
        let path = self.dir.join(self.spec.version_name());
        let result = match self.spec.persistence {
            // Preserve settings metadata cost: atomic, without fsync.
            Persistence::SettingsCompatible => crate::fsx::write_atomic(&path, &sidecar),
            Persistence::PrivateDurable => write_durable(&path, &sidecar, self.spec.persistence),
        };
        if let Err(e) = result {
            warn!(
                "{}: could not record version {version}: {e}",
                self.spec.file
            );
            self.lock().unrecorded = true;
        }
    }

    /// The document as it is on disk now, for readers that act on it. `Err`
    /// when the file is missing, unreadable, does not parse or has the wrong
    /// shape: such a reader must see exactly what it would have seen reading
    /// the file itself, never a backup.
    ///
    /// Reads the bytes every time (other writers exist); only the parse is
    /// reused while they are unchanged.
    pub fn read(&self) -> Result<Arc<Value>, String> {
        let file = self.spec.file;
        let bytes = std::fs::read(self.path()).map_err(|e| format!("{file} unreadable: {e}"))?;
        {
            let inner = self.lock();
            if inner.bytes.as_deref() == Some(&bytes[..]) {
                if let Some(doc) = &inner.doc {
                    return Ok(Arc::clone(doc));
                }
            }
        }
        // serde's message can quote the content: line and column only.
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
            format!(
                "{file} unparseable at line {}, column {}",
                e.line(),
                e.column()
            )
        })?;
        if !self.spec.kind.accepts(&value) {
            return Err(format!("{file} has the wrong shape"));
        }
        self.load_version();
        let sidecar = self.read_sidecar();
        let doc = {
            let mut inner = self.lock();
            Self::observe_good(&mut inner, bytes, value, sidecar.as_ref());
            Arc::clone(inner.doc.as_ref().expect("observed"))
        };
        self.record_version(false);
        Ok(doc)
    }

    /// The newest backup that parses (IO: never under `inner`).
    fn newest_backup(&self) -> Option<(Value, String)> {
        (1..=BACKUP_KEEP).find_map(|n| {
            let name = self.spec.backup_name(n);
            match read_disk(&self.dir.join(&name), self.spec.kind) {
                Disk::Good(_, v) => Some((v, name)),
                _ => None,
            }
        })
    }

    /// The current document and its version (and, when the file is broken,
    /// its bytes and where the value came from instead). Takes in whatever
    /// changed on disk. The disk reads happen outside `inner`.
    fn current(&self) -> Result<Current, DocError> {
        self.load_version();
        let kind = self.spec.kind;
        let disk = read_disk_settled(&self.path(), kind);
        let sidecar = matches!(disk, Disk::Good(..))
            .then(|| self.read_sidecar())
            .flatten();
        let mut current = {
            let mut inner = self.lock();
            match disk {
                Disk::Missing => {
                    Self::observe_missing(&mut inner);
                    Current {
                        value: kind.empty(),
                        version: inner.version,
                        good: None,
                        broken: None,
                    }
                }
                Disk::Good(bytes, value) => {
                    let good = bytes.clone();
                    Self::observe_good(&mut inner, bytes, value, sidecar.as_ref());
                    let value = inner
                        .doc
                        .as_deref()
                        .cloned()
                        .unwrap_or_else(|| kind.empty());
                    Current {
                        value,
                        version: inner.version,
                        good: Some(good),
                        broken: None,
                    }
                }
                Disk::Broken(bytes) => {
                    inner.observed = true;
                    // What this process last read or wrote is the best copy.
                    match inner.doc.as_deref() {
                        Some(doc) => Current {
                            value: doc.clone(),
                            version: inner.version,
                            good: None,
                            broken: Some((bytes, "memory".to_string())),
                        },
                        None => Current {
                            value: kind.empty(),
                            version: inner.version,
                            good: None,
                            broken: Some((bytes, String::new())),
                        },
                    }
                }
                Disk::Unreadable(e) => return Err(DocError::Io(e)),
            }
        };
        self.record_version(false);
        if let Some((bytes, from)) = &mut current.broken {
            if from.is_empty() {
                let (value, name) = self
                    .newest_backup()
                    .unwrap_or_else(|| (kind.empty(), "empty".to_string()));
                current.value = value;
                *from = name;
            }
            warn!(
                "{}: does not parse or has the wrong shape ({} bytes); working from {from}",
                self.spec.file,
                bytes.len()
            );
        }
        Ok(current)
    }

    /// The whole document and its version. A missing file is the empty
    /// document. Never writes the document.
    pub fn get(&self) -> Result<Snapshot, DocError> {
        let Current {
            value,
            version,
            broken,
            ..
        } = self.current()?;
        Ok(Snapshot {
            value,
            version,
            recovered: broken.map(|(_, from)| from),
        })
    }

    /// Reads the current document, lets `apply` change it, and writes the
    /// result. `apply` answers what changed (ids, keys: the caller's names);
    /// nothing changed means no write and no new version. A `base_version`
    /// that is no longer current is refused before `apply` runs.
    pub fn write_op(
        &self,
        base_version: Option<u64>,
        apply: impl FnOnce(&mut Value) -> Result<Vec<String>, DocError>,
    ) -> Result<Change, DocError> {
        self.write_op_scrubbed(base_version, None, apply)
    }

    /// `write_op` with a scrub of the document as it is on disk (`scrub.clean`
    /// answers what it changed, in the caller's names). The backup taken
    /// before the write is of the scrubbed document. This cleans newly made
    /// good-file backups; historical backups and corrupt copies are unchanged.
    /// With `scrub.live` the document written
    /// is scrubbed too (and written even when `apply` changes nothing);
    /// without it the live document keeps what it holds.
    pub fn write_op_scrubbed(
        &self,
        base_version: Option<u64>,
        scrub: Option<Scrub<'_>>,
        apply: impl FnOnce(&mut Value) -> Result<Vec<String>, DocError>,
    ) -> Result<Change, DocError> {
        let _writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let _file_lock = lock_file(
            &self.dir,
            &self.spec.lock_name(),
            LOCK_WAIT,
            self.spec.persistence,
        )
        .map_err(|e| DocError::Io(e.to_string()))?;
        let Current {
            value: mut before,
            version,
            mut good,
            broken,
        } = self.current()?;
        let mut scrubbed = Vec::new();
        if let Some(scrub) = &scrub {
            let mut clean = before.clone();
            let removed = (scrub.clean)(&mut clean);
            if !removed.is_empty() {
                if let Some(bytes) = &mut good {
                    *bytes = self
                        .spec
                        .encode(&clean)
                        .map_err(|e| DocError::Io(e.to_string()))?;
                }
                if scrub.live {
                    before = clean;
                    scrubbed = removed;
                }
            }
        }
        // `current` may have taken another writer's change in.
        self.record_version(true);
        if let Some(base) = base_version {
            if base != version {
                return Err(DocError::Conflict { current: version });
            }
        }
        let mut next = before;
        let mut changed = apply(&mut next)?;
        if !self.spec.kind.accepts(&next) {
            return Err(DocError::Invalid);
        }
        for name in scrubbed {
            if !changed.contains(&name) {
                changed.push(name);
            }
        }
        if changed.is_empty() {
            return Ok(Change { version, changed });
        }

        self.sweep_temps();
        if let Some(bytes) = &good {
            self.maybe_backup(bytes);
        }
        if let Some((bytes, _)) = &broken {
            if let Err(e) = write_durable(
                &self.dir.join(self.spec.corrupt_name()),
                bytes,
                self.spec.persistence,
            ) {
                warn!(
                    "{}: could not keep the broken file aside: {e}",
                    self.spec.file
                );
            }
        }
        let bytes = self
            .spec
            .encode(&next)
            .map_err(|e| DocError::Io(e.to_string()))?;
        #[cfg(test)]
        let fail = self
            .fail_before_rename
            .load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(test)]
        if let Some(pause) = *self.slow_write.lock().unwrap_or_else(|p| p.into_inner()) {
            self.in_write
                .store(true, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(pause);
        }
        #[cfg(not(test))]
        let fail = false;
        write_durable_inner(&self.path(), &bytes, fail, self.spec.persistence).map_err(|e| {
            warn!(
                "{}: write of {} change(s) failed, the file is unchanged: {e}",
                self.spec.file,
                changed.len()
            );
            DocError::Io(e.to_string())
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
        info!(
            "{}: wrote {} change(s), version {version}",
            self.spec.file,
            changed.len()
        );
        Ok(Change { version, changed })
    }

    /// Copies the current good file to `.bak1` (shifting the older ones up,
    /// dropping the sixth) when there is no backup yet, before the first
    /// write of a run once the newest backup is an hour old, and then once it
    /// is older than the interval; only when the file differs from `.bak1`.
    /// A backup failure never stops the write itself.
    fn maybe_backup(&self, current: &[u8]) {
        use std::sync::atomic::Ordering::SeqCst;
        let bak1 = self.dir.join(self.spec.backup_name(1));
        let age = std::fs::metadata(&bak1)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok());
        let exists = bak1.exists();
        // A newest backup dated in the future (the clock went back, a network
        // filesystem's clock) has no age: not due, or every write would
        // rotate and push every older copy out.
        let spacing = BACKUP_MIN_SPACING.min(self.backup_interval);
        let wait = if self.backed_up.load(SeqCst) {
            self.backup_interval
        } else {
            spacing
        };
        let due = !exists || age.is_some_and(|a| a >= wait);
        if !due {
            return;
        }
        self.backed_up.store(true, SeqCst);
        if std::fs::read(&bak1).ok().as_deref() == Some(current) {
            return;
        }
        let _ = std::fs::remove_file(self.dir.join(self.spec.backup_name(BACKUP_KEEP)));
        for n in (1..BACKUP_KEEP).rev() {
            let from = self.dir.join(self.spec.backup_name(n));
            if from.exists() {
                if let Err(e) = std::fs::rename(&from, self.dir.join(self.spec.backup_name(n + 1)))
                {
                    warn!("{}: could not rotate backup {n}: {e}", self.spec.file);
                }
            }
        }
        if let Err(e) = write_durable(&bak1, current, self.spec.persistence) {
            warn!("{}: could not write the backup: {e}", self.spec.file);
        }
        self.drop_extra_backups();
    }

    /// Any `.bakN` past the fifth (an interrupted rotation, an older scheme).
    fn drop_extra_backups(&self) {
        let prefix = format!("{}.bak", self.spec.file);
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let extra = name
                .strip_prefix(&prefix)
                .and_then(|n| n.parse::<usize>().ok())
                .is_some_and(|n| n == 0 || n > BACKUP_KEEP);
            if extra {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Temp files a writer that died left behind (never one younger than a
    /// minute: that may be another process mid-write).
    fn sweep_temps(&self) {
        let prefix = self.spec.temp_prefix();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(&prefix) {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|a| a >= STALE_TEMP);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Every file a document keeps beside itself (lock, version, corrupt copy,
/// backups, a dead writer's temps), for a caller that removes the document
/// from a host. The document itself is not in the list.
pub fn companion_files(dir: &Path, spec: Spec) -> Vec<PathBuf> {
    let mut out = vec![
        dir.join(spec.lock_name()),
        dir.join(spec.version_name()),
        dir.join(spec.corrupt_name()),
    ];
    let backups = format!("{}.bak", spec.file);
    let temps = spec.temp_prefix();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&backups) || name.starts_with(&temps) {
                out.push(entry.path());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
