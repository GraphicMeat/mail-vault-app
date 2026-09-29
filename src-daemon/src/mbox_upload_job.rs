//! Mode 1 of the mbox import as a job: Task 9's per-message pipeline
//! (`mbox_upload::MboxUpload`) run over a whole file, a 55 GB Takeout
//! included, by the daemon on a worker thread of its own.
//!
//! - **Worker.** One OS thread per job at background QoS, with a
//!   current-thread runtime of its own for the pipeline's IMAP work. It reads
//!   the file one message at a time (`mbox::for_each_mbox_span`) and yields to
//!   the user before each one (`search_index::yield_to_foreground`); the
//!   pipeline takes its locks one unit at a time. One job per account.
//! - **Control.** Pause, cancel and discard take effect between messages (an
//!   APPEND in flight finishes or times out first) or during a retry's wait.
//!   A pause holds the worker where it stands, its connection closed, until a
//!   resume. A cancel ends the worker and keeps the journal; a discard ends it
//!   and deletes the journal. A refused sign-in holds the job as
//!   `needsSignIn` instead of failing message after message.
//! - **Journal (R2).** `<app data>/mbox_uploads/<jobId>.json`, written
//!   atomically: the account, the file (path, size, mtime), the byte offset of
//!   the first message not yet finished, the counters and the folders mail
//!   went into. It is checkpointed every `checkpoint_every` messages or
//!   `checkpoint_after`, whichever comes first, and on pause, cancel and the
//!   end. Between checkpoints `<jobId>.tail` gets one line per finished
//!   message (its outcome and a content fingerprint), so a crash between an
//!   APPEND and the next checkpoint costs no duplicate on resume, with or
//!   without a Message-ID: the resumed reader meets that message again and
//!   the tail answers for it. A checkpoint rewrites the tail with only the
//!   entries still ahead of the new offset (a resumed run's unreached ones),
//!   so a second crash keeps them too. A changed file (path, size or mtime) starts
//!   over from byte 0; the pipeline's server-side dedupe skips what landed.
//!   Journals are listed by `mbox_upload_status` and never resumed unasked.
//! - **Failures.** A transient one (throttling, a lost connection) is tried
//!   again after an exponential wait with jitter, `attempts` times; then the
//!   message counts as failed and the job goes on. A permanent one counts and
//!   the job goes on. The job itself never fails because of one message.
//! - **Progress** is the `mbox-import-progress` event, at most one per
//!   `progress_every` plus every change of state, with a throughput ETA the
//!   daemon measures (D5). The worker is registered per account rather than
//!   through `handlers::common::RunGuard`: `cancel_kind` and `pause_kind` act
//!   on every run of a kind, and this job pauses, resumes and cancels one
//!   account's upload by its id.
//! - **At the end** every folder mail went into is synced the way the snooze
//!   worker's wake syncs one (`sync_account`, then a change record the app's
//!   change feed repaints from, with 0 new so restored mail raises no banner),
//!   the cached folder list is marked out of date when the upload made
//!   folders, and the search index gets a full pass.
//!
//! Logs carry counts, byte offsets and account ids: never message text,
//! folder names or credentials.

use crate::handlers::common::blocking;
use crate::mbox::{for_each_mbox_span, Span};
use crate::mbox_upload::{FailKind, MboxUpload, Outcome};
use crate::server::DaemonState;
use crate::sync_engine::SyncAccount;
use mailvault_core::custody::cache;
use mailvault_core::imap::ImapConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tracing::{info, warn};

/// A job for this account is already running or paused in this daemon; the
/// text after the prefix is that job's id.
pub const E_MBOX_UPLOAD_RUNNING: &str = "E_MBOX_UPLOAD_RUNNING";
/// This file already has a journal for this account (a cancelled, paused or
/// interrupted upload of it): resume or discard it. The text after the prefix
/// is its job id.
pub const E_MBOX_UPLOAD_RESUMABLE: &str = "E_MBOX_UPLOAD_RESUMABLE";
/// No job and no journal with this id.
pub const E_MBOX_UPLOAD_NOT_FOUND: &str = "E_MBOX_UPLOAD_NOT_FOUND";
/// The account's credentials could not be read to start or resume.
pub const E_MBOX_UPLOAD_SIGN_IN: &str = "E_MBOX_UPLOAD_SIGN_IN";
/// The file stopped being readable mid-run; the job is kept, paused.
pub const E_MBOX_UPLOAD_READ: &str = "E_MBOX_UPLOAD_READ";

const EVENT: &str = "mbox-import-progress";
const JOURNAL_VERSION: u32 = 1;
const JOURNAL_DIR: &str = "mbox_uploads";

const RUNNING: &str = "running";
const PAUSED: &str = "paused";
const NEEDS_SIGN_IN: &str = "needsSignIn";
const CANCELLED: &str = "cancelled";
const DISCARDED: &str = "discarded";
const DONE: &str = "done";

#[derive(Debug, Clone)]
pub(crate) struct Tuning {
    /// The wait after a first transient failure, doubled for each one in a
    /// row, never past `backoff_max`.
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Tries per message before it counts as failed.
    pub attempts: u32,
    /// The offset checkpoint: after this many messages or this long,
    /// whichever comes first.
    pub checkpoint_every: u32,
    pub checkpoint_after: Duration,
    /// At most one progress event per this long, changes of state aside.
    pub progress_every: Duration,
    /// The ETA's throughput window, and what it needs before it says
    /// anything: this many messages spanning at least this long.
    pub eta_window: Duration,
    pub eta_min_samples: usize,
    pub eta_min_span: Duration,
    /// Stop dead after this many messages, the way a killed daemon would:
    /// no checkpoint, no event.
    #[cfg(test)]
    pub crash_after: Option<u64>,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning {
            backoff_base: Duration::from_secs(5),
            backoff_max: Duration::from_secs(300),
            attempts: 8,
            checkpoint_every: 50,
            checkpoint_after: Duration::from_secs(10),
            progress_every: Duration::from_millis(500),
            eta_window: Duration::from_secs(120),
            eta_min_samples: 5,
            eta_min_span: Duration::from_secs(20),
            #[cfg(test)]
            crash_after: None,
        }
    }
}

/// What the routes ask of a live worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ctl {
    Run,
    Pause,
    Cancel,
    Discard,
}

/// Why the worker stopped reading before the end of the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Cancel,
    Discard,
    #[cfg(test)]
    Crash,
}

impl Stop {
    fn of(ctl: Ctl) -> Self {
        if ctl == Ctl::Discard {
            Stop::Discard
        } else {
            Stop::Cancel
        }
    }
}

/// A live job: running, or held (paused or waiting for a sign-in).
pub(crate) struct Job {
    id: String,
    account_id: String,
    ctl: Mutex<Ctl>,
    wake: Condvar,
    /// Its latest progress: what `mbox_upload_status` answers for it.
    view: Mutex<Value>,
    /// Messages the reader handed over in this run.
    #[cfg(test)]
    parsed: std::sync::atomic::AtomicU64,
    /// The byte this run started reading at.
    #[cfg(test)]
    read_from: std::sync::atomic::AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Job {
    fn new(id: &str, account_id: &str) -> Self {
        Job {
            id: id.to_string(),
            account_id: account_id.to_string(),
            ctl: Mutex::new(Ctl::Run),
            wake: Condvar::new(),
            view: Mutex::new(Value::Null),
            #[cfg(test)]
            parsed: Default::default(),
            #[cfg(test)]
            read_from: Default::default(),
        }
    }

    fn ctl(&self) -> Ctl {
        *lock(&self.ctl)
    }

    /// Pause only a running job and resume only a held one; a cancel stops
    /// either, and a discard wins over everything.
    fn request(&self, want: Ctl) -> Ctl {
        let mut ctl = lock(&self.ctl);
        *ctl = match (*ctl, want) {
            (Ctl::Run, Ctl::Pause) => Ctl::Pause,
            (Ctl::Pause, Ctl::Run) => Ctl::Run,
            (Ctl::Run | Ctl::Pause, Ctl::Cancel) => Ctl::Cancel,
            (_, Ctl::Discard) => Ctl::Discard,
            (now, _) => now,
        };
        self.wake.notify_all();
        *ctl
    }

    /// Wait while running until `until`: `Run` when the time is up, else
    /// what the job was asked to do instead.
    fn wait_run(&self, until: Instant) -> Ctl {
        let mut ctl = lock(&self.ctl);
        while *ctl == Ctl::Run {
            let now = Instant::now();
            if now >= until {
                break;
            }
            ctl = self.wake.wait_timeout(ctl, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
        *ctl
    }

    /// Wait while held.
    fn wait_held(&self) -> Ctl {
        let mut ctl = lock(&self.ctl);
        while *ctl == Ctl::Pause {
            ctl = self.wake.wait(ctl).unwrap_or_else(|p| p.into_inner());
        }
        *ctl
    }

    fn view(&self) -> Value {
        lock(&self.view).clone()
    }
}

/// The live job of each account.
#[derive(Default)]
pub(crate) struct Uploads {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    #[cfg(test)]
    pub(crate) tuning: Mutex<Option<Tuning>>,
    /// Every job started, so a test can read a finished run's counters.
    #[cfg(test)]
    ran: Mutex<Vec<Arc<Job>>>,
}

impl Uploads {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<Job>>> {
        lock(&self.jobs)
    }

    fn live(&self, job_id: &str) -> Option<Arc<Job>> {
        self.lock().values().find(|j| j.id == job_id).cloned()
    }

    fn tuning(&self) -> Tuning {
        #[cfg(test)]
        if let Some(t) = lock(&self.tuning).clone() {
            return t;
        }
        Tuning::default()
    }
}

/// Unregisters its job when the worker thread ends, however it ends.
struct Registered(Arc<DaemonState>, Arc<Job>);

impl Drop for Registered {
    fn drop(&mut self) {
        unregister(&self.0, &self.1);
    }
}

/// Only this job's entry: a newer job of the account is never touched.
fn unregister(state: &DaemonState, job: &Arc<Job>) {
    let mut jobs = state.mbox_uploads.lock();
    if jobs.get(&job.account_id).is_some_and(|j| Arc::ptr_eq(j, job)) {
        jobs.remove(&job.account_id);
    }
}

// ── the journal ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journal {
    pub version: u32,
    pub job_id: String,
    pub account_id: String,
    /// The file, kept here only: status answers with its name.
    pub source_path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub use_labels: bool,
    pub fallback: String,
    /// The start of the first message not yet finished.
    pub offset: u64,
    pub uploaded: u64,
    pub skipped: u64,
    pub failed: u64,
    /// `running` (a live worker, or one a quit or crash cut off), `paused`,
    /// `needsSignIn` or `cancelled`.
    pub state: String,
    /// Folders an APPEND went out to, and folders the upload made: what the
    /// refresh at the end covers, across restarts.
    #[serde(default)]
    pub touched: BTreeSet<String>,
    #[serde(default)]
    pub created: BTreeSet<String>,
    pub updated_at: u64,
}

impl Journal {
    fn restart(&mut self, source_path: String, size: u64, mtime_ms: u64) {
        (self.source_path, self.size, self.mtime_ms) = (source_path, size, mtime_ms);
        (self.offset, self.uploaded, self.skipped, self.failed) = (0, 0, 0, 0);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A job id names files: only what `uuid` writes gets through.
pub(crate) fn is_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn journal_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(JOURNAL_DIR)
}

fn journal_path(app_dir: &Path, id: &str) -> PathBuf {
    journal_dir(app_dir).join(format!("{id}.json"))
}

fn tail_path(app_dir: &Path, id: &str) -> PathBuf {
    journal_dir(app_dir).join(format!("{id}.tail"))
}

fn write_journal(app_dir: &Path, journal: &Journal) -> Result<(), String> {
    std::fs::create_dir_all(journal_dir(app_dir)).map_err(|e| format!("Failed to create the upload journal dir: {e}"))?;
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    mailvault_core::fsx::write_atomic(&journal_path(app_dir, &journal.job_id), &bytes).map_err(|e| format!("Failed to write the upload journal: {e}"))
}

/// `None` for a journal this build cannot read (another version) or none.
fn read_journal(app_dir: &Path, id: &str) -> Option<Journal> {
    let raw = std::fs::read(journal_path(app_dir, id)).ok()?;
    serde_json::from_slice::<Journal>(&raw).ok().filter(|j| j.version == JOURNAL_VERSION && j.job_id == id)
}

/// Every readable journal. An atomic write's temp file starts with a dot and
/// never ends in `.json`, so it is never read as one.
fn list_journals(app_dir: &Path) -> Vec<Journal> {
    std::fs::read_dir(journal_dir(app_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json").filter(|id| is_job_id(id))?;
            read_journal(app_dir, id)
        })
        .collect()
}

fn remove_journal(app_dir: &Path, id: &str) {
    for path in [journal_path(app_dir, id), tail_path(app_dir, id)] {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("[mbox_upload] job {id}: its journal was not removed: {e}");
            }
        }
    }
}

/// How a message ended, as the tail keeps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Done {
    Uploaded,
    Skipped,
    Failed,
}

impl Done {
    fn letter(self) -> char {
        match self {
            Done::Uploaded => 'u',
            Done::Skipped => 's',
            Done::Failed => 'f',
        }
    }

    fn from_letter(s: &str) -> Option<Self> {
        match s {
            "u" => Some(Done::Uploaded),
            "s" => Some(Done::Skipped),
            "f" => Some(Done::Failed),
            _ => None,
        }
    }
}

/// The messages finished since the last checkpoint, by fingerprint. A line a
/// crash cut short does not parse and is left out.
fn read_tail(app_dir: &Path, id: &str) -> HashMap<u64, Done> {
    let Ok(text) = std::fs::read_to_string(tail_path(app_dir, id)) else { return HashMap::new() };
    text.lines()
        .filter_map(|line| {
            let (done, fp) = line.split_once(' ')?;
            Some((u64::from_str_radix(fp, 16).ok()?, Done::from_letter(done)?))
        })
        .collect()
}

/// A message's content, as 8 bytes of its SHA-256: stable across builds, so a
/// tail written by one release is read right by the next.
fn fingerprint(raw: &[u8]) -> u64 {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(raw);
    u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"))
}

/// A file's identity besides its path: its size and modification time.
fn identity(path: &Path) -> Result<(u64, u64), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to read mbox file: {e}"))?;
    let meta = file.metadata().map_err(|e| format!("Failed to read mbox file: {e}"))?;
    if !meta.is_file() {
        return Err("Failed to read mbox file: not a file".to_string());
    }
    let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    Ok((meta.len(), mtime_ms))
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// ── progress ────────────────────────────────────────────────────────────────

/// What the app renders, for a live job's events and status alike.
fn progress(j: &Journal, active: bool, state: &str, throttled: bool, eta: Option<u64>) -> Value {
    json!({
        "mode": "server",
        "jobId": j.job_id,
        "accountId": j.account_id,
        "fileName": file_name(&j.source_path),
        "active": active,
        "state": state,
        // As the other import modes report them: the messages that landed,
        // and a total only once the run is over.
        "total": if active { 0 } else { j.uploaded },
        "completed": j.uploaded,
        "bytesDone": j.offset,
        "bytesTotal": j.size,
        "uploadedCount": j.uploaded,
        "skippedCount": j.skipped,
        "failedCount": j.failed,
        "paused": state == PAUSED || state == NEEDS_SIGN_IN,
        "throttled": throttled,
        "needsSignIn": state == NEEDS_SIGN_IN,
        "etaSeconds": eta,
    })
}

/// Throughput over a moving window of (time, bytes done) samples.
#[derive(Default)]
struct Eta {
    samples: VecDeque<(Instant, u64)>,
}

impl Eta {
    /// Samples older than `window` go, but never below `keep` of them: a
    /// slow upload still gets an estimate.
    fn sample(&mut self, at: Instant, bytes: u64, window: Duration, keep: usize) {
        self.samples.push_back((at, bytes));
        while self.samples.len() > keep.max(2) && self.samples.front().is_some_and(|(t, _)| at.duration_since(*t) > window) {
            self.samples.pop_front();
        }
    }

    /// Seconds left for `remaining` bytes, once there are `min_samples`
    /// spanning at least `min_span` and something moved.
    fn seconds(&self, remaining: u64, min_samples: usize, min_span: Duration) -> Option<u64> {
        let (&(t0, b0), &(t1, b1)) = (self.samples.front()?, self.samples.back()?);
        let span = t1.duration_since(t0);
        if self.samples.len() < min_samples.max(2) || span < min_span || span.is_zero() || b1 <= b0 {
            return None;
        }
        let rate = (b1 - b0) as f64 / span.as_secs_f64();
        Some((remaining as f64 / rate).ceil() as u64)
    }
}

/// The wait before the next try after `level` transient failures in a row:
/// `backoff_base` doubled per failure, plus up to half again at random so
/// two installs never retry in step, always within `backoff_base` and
/// `backoff_max`.
fn backoff(level: u32, t: &Tuning) -> Duration {
    let full = t.backoff_base.saturating_mul(1 << level.saturating_sub(1).min(20)).min(t.backoff_max);
    full.mul_f64(1.0 + rand::random::<f64>() / 2.0).min(t.backoff_max)
}

fn background_qos() {
    #[cfg(target_os = "macos")]
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
    }
}

/// The account's credentials, read again by the worker itself (a token the
/// app refreshed since): quietly, a background job never raises the
/// keychain's prompt.
#[cfg(not(test))]
async fn quiet_config(_state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    crate::credentials::resolve_account_credentials_quiet(account_id).await
}

#[cfg(test)]
async fn quiet_config(state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    crate::raw_message::account_config(state, account_id).await
}

// ── the routes' side ────────────────────────────────────────────────────────

/// `import_mbox` with `mode: "server"`.
pub(crate) struct Request {
    pub source_path: PathBuf,
    pub account_id: String,
    /// The server path of the folder mail no label homes goes to.
    pub fallback: String,
    pub use_labels: bool,
}

fn not_found(id: &str) -> String {
    format!("{E_MBOX_UPLOAD_NOT_FOUND}: {id}")
}

/// Starts an upload and answers at once: `{jobId, started: true}`. The
/// account must have readable credentials and IMAP (an Outlook account is
/// `E_MBOX_SERVER_GRAPH`), the file must open, the account must have no job
/// in this daemon, and the file no journal for this account.
pub(crate) async fn start(state: &Arc<DaemonState>, req: Request) -> Result<Value, String> {
    let config = crate::raw_message::account_config(state, &req.account_id).await.map_err(|e| format!("{E_MBOX_UPLOAD_SIGN_IN}: {e}"))?;
    let pipeline = MboxUpload::new(Arc::clone(state), config.clone(), req.account_id.clone(), req.fallback.clone(), req.use_labels)?;
    let st = Arc::clone(state);
    blocking(move || {
        let (size, mtime_ms) = identity(&req.source_path)?;
        let source_path = req.source_path.to_string_lossy().into_owned();
        let mut jobs = st.mbox_uploads.lock();
        if let Some(running) = jobs.get(&req.account_id) {
            return Err(format!("{E_MBOX_UPLOAD_RUNNING}: {}", running.id));
        }
        for old in list_journals(&st.app_dir).into_iter().filter(|j| j.account_id == req.account_id && j.source_path == source_path) {
            if (old.size, old.mtime_ms) == (size, mtime_ms) {
                return Err(format!("{E_MBOX_UPLOAD_RESUMABLE}: {}", old.job_id));
            }
            // The file changed since: its offsets name other messages now.
            remove_journal(&st.app_dir, &old.job_id);
        }
        let journal = Journal {
            version: JOURNAL_VERSION,
            job_id: uuid::Uuid::new_v4().to_string(),
            account_id: req.account_id,
            source_path,
            size,
            mtime_ms,
            use_labels: req.use_labels,
            fallback: req.fallback,
            offset: 0,
            uploaded: 0,
            skipped: 0,
            failed: 0,
            state: RUNNING.to_string(),
            touched: BTreeSet::new(),
            created: BTreeSet::new(),
            updated_at: now_ms(),
        };
        write_journal(&st.app_dir, &journal)?;
        let id = journal.job_id.clone();
        if let Err(e) = spawn(&st, &mut jobs, journal, pipeline, config, HashMap::new()) {
            remove_journal(&st.app_dir, &id);
            return Err(e);
        }
        Ok(json!({"jobId": id, "started": true}))
    })
    .await
    .and_then(|r| r)
}

/// A job held in this daemon goes on where it stands. Otherwise its journal
/// starts a new worker at the checkpoint, reading `source_path` when the app
/// gives one (a sandboxed app may have to pick the file again after a
/// restart) and the journal's path when not. A file whose path, size or
/// mtime differ from the journal's starts over from byte 0 (`restarted`).
pub(crate) async fn resume(state: &Arc<DaemonState>, job_id: String, source_path: Option<PathBuf>) -> Result<Value, String> {
    let (st, id) = (Arc::clone(state), job_id.clone());
    // `Err(resumed)` for a live job: false when it is ending (a cancel came first).
    let from_journal = blocking(move || -> Result<Result<Journal, bool>, String> {
        if let Some(job) = st.mbox_uploads.live(&id) {
            return Ok(Err(job.request(Ctl::Run) == Ctl::Run));
        }
        read_journal(&st.app_dir, &id).map(Ok).ok_or_else(|| not_found(&id))
    })
    .await
    .and_then(|r| r)?;
    let journal = match from_journal {
        Ok(journal) => journal,
        Err(resumed) => return Ok(json!({"jobId": job_id, "resumed": resumed, "restarted": false})),
    };
    let config = crate::raw_message::account_config(state, &journal.account_id).await.map_err(|e| format!("{E_MBOX_UPLOAD_SIGN_IN}: {e}"))?;
    let pipeline = MboxUpload::new(Arc::clone(state), config.clone(), journal.account_id.clone(), journal.fallback.clone(), journal.use_labels)?;
    let st = Arc::clone(state);
    blocking(move || {
        let mut jobs = st.mbox_uploads.lock();
        if let Some(running) = jobs.get(&journal.account_id) {
            return Err(format!("{E_MBOX_UPLOAD_RUNNING}: {}", running.id));
        }
        // Read again under the lock: a discard may have come in between.
        let mut journal = read_journal(&st.app_dir, &job_id).ok_or_else(|| not_found(&job_id))?;
        let path = source_path.unwrap_or_else(|| PathBuf::from(&journal.source_path));
        let (size, mtime_ms) = identity(&path)?;
        let path = path.to_string_lossy().into_owned();
        let restarted = (path.as_str(), size, mtime_ms) != (journal.source_path.as_str(), journal.size, journal.mtime_ms);
        let done_before = if restarted {
            journal.restart(path, size, mtime_ms);
            let _ = std::fs::remove_file(tail_path(&st.app_dir, &job_id));
            HashMap::new()
        } else {
            read_tail(&st.app_dir, &job_id)
        };
        journal.state = RUNNING.to_string();
        journal.updated_at = now_ms();
        write_journal(&st.app_dir, &journal)?;
        spawn(&st, &mut jobs, journal, pipeline, config, done_before)?;
        Ok(json!({"jobId": job_id, "resumed": true, "restarted": restarted}))
    })
    .await
    .and_then(|r| r)
}

/// Holds a running job between messages. A job with no worker here is not
/// running anywhere: nothing to do.
pub(crate) fn pause(state: &DaemonState, id: &str) -> Result<Value, String> {
    if let Some(job) = state.mbox_uploads.live(id) {
        return Ok(json!({"jobId": id, "paused": job.request(Ctl::Pause) == Ctl::Pause}));
    }
    read_journal(&state.app_dir, id).map(|_| json!({"jobId": id, "paused": true})).ok_or_else(|| not_found(id))
}

/// Ends a job, keeping its journal for a resume or a discard.
pub(crate) fn cancel(state: &DaemonState, id: &str) -> Result<Value, String> {
    let jobs = state.mbox_uploads.lock();
    if let Some(job) = jobs.values().find(|j| j.id == id) {
        job.request(Ctl::Cancel);
        return Ok(json!({"jobId": id, "cancelled": true}));
    }
    let mut journal = read_journal(&state.app_dir, id).ok_or_else(|| not_found(id))?;
    journal.state = CANCELLED.to_string();
    journal.updated_at = now_ms();
    write_journal(&state.app_dir, &journal)?;
    Ok(json!({"jobId": id, "cancelled": true}))
}

/// Ends a job and deletes its journal (a live worker deletes it as it ends).
pub(crate) fn discard(state: &DaemonState, id: &str) -> Result<Value, String> {
    let jobs = state.mbox_uploads.lock();
    if let Some(job) = jobs.values().find(|j| j.id == id) {
        job.request(Ctl::Discard);
        return Ok(json!({"jobId": id, "discarded": true}));
    }
    read_journal(&state.app_dir, id).ok_or_else(|| not_found(id))?;
    remove_journal(&state.app_dir, id);
    Ok(json!({"jobId": id, "discarded": true}))
}

/// `{jobs: [...]}`: every live job (`live: true`), then every journal with
/// no worker here, newest first. Each entry is a progress payload; a journal
/// still marked running is one a quit or a crash cut off, and reads as
/// paused.
pub(crate) fn status(state: &DaemonState) -> Value {
    let live: Vec<Arc<Job>> = state.mbox_uploads.lock().values().cloned().collect();
    let mut jobs: Vec<Value> = live
        .iter()
        .map(|job| {
            let mut v = job.view();
            v["live"] = json!(true);
            v
        })
        .collect();
    let mut rest: Vec<Journal> = list_journals(&state.app_dir).into_iter().filter(|j| !live.iter().any(|l| l.id == j.job_id)).collect();
    rest.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    jobs.extend(rest.iter().map(|j| {
        let held = if j.state == RUNNING { PAUSED } else { j.state.as_str() };
        let mut v = progress(j, false, held, false, None);
        v["live"] = json!(false);
        v["updatedAt"] = json!(j.updated_at);
        v
    }));
    json!({ "jobs": jobs })
}

/// Registers the job and starts its worker. `jobs` is the registry, locked
/// by the caller: the worker's own unregister waits for this insert.
fn spawn(
    state: &Arc<DaemonState>,
    jobs: &mut HashMap<String, Arc<Job>>,
    journal: Journal,
    pipeline: MboxUpload,
    config: ImapConfig,
    done_before: HashMap<u64, Done>,
) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .on_thread_start(background_qos)
        .build()
        .map_err(|e| format!("the upload could not start: {e}"))?;
    let job = Arc::new(Job::new(&journal.job_id, &journal.account_id));
    let tuning = state.mbox_uploads.tuning();
    *lock(&job.view) = progress(&journal, true, RUNNING, false, None);
    let runner = Runner {
        state: Arc::clone(state),
        job: Arc::clone(&job),
        rt,
        tuning,
        pipeline,
        config,
        run_from: journal.offset,
        journal,
        tail: None,
        done_before,
        handled: 0,
        since_checkpoint: 0,
        checkpointed: Instant::now(),
        emitted: None,
        eta: Eta::default(),
        throttled: false,
        changed: false,
        backoff_level: 0,
        stop: None,
    };
    std::thread::Builder::new()
        .name("mbox-upload".into())
        .spawn(move || {
            background_qos();
            let _registered = Registered(Arc::clone(&runner.state), Arc::clone(&runner.job));
            runner.run();
        })
        .map_err(|e| format!("the upload could not start: {e}"))?;
    #[cfg(test)]
    lock(&state.mbox_uploads.ran).push(Arc::clone(&job));
    jobs.insert(job.account_id.clone(), job);
    Ok(())
}

// ── the worker ──────────────────────────────────────────────────────────────

struct Runner {
    state: Arc<DaemonState>,
    job: Arc<Job>,
    rt: tokio::runtime::Runtime,
    tuning: Tuning,
    pipeline: MboxUpload,
    config: ImapConfig,
    journal: Journal,
    /// The byte this run started at.
    run_from: u64,
    tail: Option<std::fs::File>,
    /// What an earlier run's tail says it finished after the checkpoint.
    done_before: HashMap<u64, Done>,
    handled: u64,
    since_checkpoint: u32,
    checkpointed: Instant,
    emitted: Option<Instant>,
    eta: Eta,
    throttled: bool,
    /// The next event goes out whatever the rate: something changed.
    changed: bool,
    /// Transient failures in a row, across messages.
    backoff_level: u32,
    stop: Option<Stop>,
}

impl Runner {
    fn run(mut self) {
        info!("[mbox_upload] {}: job {} reading from byte {} of {}", self.journal.account_id, self.job.id, self.run_from, self.journal.size);
        #[cfg(test)]
        self.job.read_from.store(self.run_from, std::sync::atomic::Ordering::SeqCst);
        let tail = std::fs::OpenOptions::new().create(true).append(true).open(tail_path(&self.state.app_dir, &self.job.id));
        match tail {
            Ok(file) => self.tail = Some(file),
            Err(e) => warn!("[mbox_upload] {}: job {} keeps no tail, a crash may upload a message twice: {e}", self.journal.account_id, self.job.id),
        }
        self.emit(true, RUNNING);
        let read = self.read_file();
        self.finish(read);
    }

    fn read_file(&mut self) -> Result<(), String> {
        let from = self.journal.offset;
        let mut file = std::fs::File::open(&self.journal.source_path).map_err(|e| format!("{E_MBOX_UPLOAD_READ}: {e}"))?;
        file.seek(SeekFrom::Start(from)).map_err(|e| format!("{E_MBOX_UPLOAD_READ}: {e}"))?;
        let reader = std::io::BufReader::with_capacity(1 << 20, file);
        for_each_mbox_span(reader, from, |raw, span| self.message(raw, span)).map_err(|e| format!("{E_MBOX_UPLOAD_READ}: {e}"))
    }

    fn message(&mut self, raw: &[u8], span: Span) -> bool {
        #[cfg(test)]
        self.job.parsed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if !self.go_on() {
            return false;
        }
        crate::search_index::yield_to_foreground(&self.state.search_index);
        let fp = fingerprint(raw);
        let done = match self.done_before.remove(&fp) {
            Some(done) => done,
            None => match self.upload(raw, span.start) {
                Some(done) => done,
                None => return false,
            },
        };
        self.record(fp, done, span.end);
        #[cfg(test)]
        if self.tuning.crash_after.is_some_and(|n| self.handled >= n) {
            self.stop = Some(Stop::Crash);
            return false;
        }
        true
    }

    /// Between messages: go on, hold for a pause, or stop.
    fn go_on(&mut self) -> bool {
        match self.job.ctl() {
            Ctl::Run => true,
            Ctl::Pause => self.hold(PAUSED),
            stop => {
                self.stop = Some(Stop::of(stop));
                false
            }
        }
    }

    /// One message, tried until it settles: a transient failure waits
    /// (`backoff`) and tries again, `attempts` times in all; a refused
    /// sign-in reads the credentials again once, then holds the job for the
    /// user. `None` when a cancel or a discard came first.
    fn upload(&mut self, raw: &[u8], at: u64) -> Option<Done> {
        let mut tries = 0;
        let mut reread = false;
        loop {
            let outcome = {
                let (rt, pipeline) = (&self.rt, &mut self.pipeline);
                rt.block_on(pipeline.upload_message(raw))
            };
            let kind = match outcome {
                Outcome::Uploaded { .. } => return Some(self.cleared(Done::Uploaded)),
                Outcome::Skipped { .. } => return Some(self.cleared(Done::Skipped)),
                Outcome::Failed(kind, _) => kind,
            };
            match kind {
                FailKind::Permanent => {
                    self.log_failed(at, kind, tries + 1);
                    return Some(Done::Failed);
                }
                FailKind::Transient => {
                    tries += 1;
                    if tries >= self.tuning.attempts {
                        self.log_failed(at, kind, tries);
                        return Some(Done::Failed);
                    }
                    self.backoff_level += 1;
                    if !self.throttled {
                        self.throttled = true;
                        self.emit(true, RUNNING);
                    }
                    if !self.sleep(backoff(self.backoff_level, &self.tuning)) {
                        return None;
                    }
                }
                FailKind::SignIn if !reread => {
                    reread = true;
                    self.rebuild();
                }
                FailKind::SignIn => {
                    if !self.hold(NEEDS_SIGN_IN) {
                        return None;
                    }
                    self.rebuild();
                }
            }
        }
    }

    fn cleared(&mut self, done: Done) -> Done {
        self.backoff_level = 0;
        if self.throttled {
            self.throttled = false;
            self.changed = true;
        }
        done
    }

    fn log_failed(&self, at: u64, kind: FailKind, tries: u32) {
        warn!("[mbox_upload] {}: the message at byte {at} counts as failed ({kind:?}, {tries} attempt(s))", self.journal.account_id);
    }

    /// A retry's wait. A pause during it holds the job (the message still
    /// unfinished) and the retry follows the resume at once; a cancel or a
    /// discard ends it.
    fn sleep(&mut self, wait: Duration) -> bool {
        match self.job.wait_run(Instant::now() + wait) {
            Ctl::Run => true,
            Ctl::Pause => self.hold(PAUSED),
            stop => {
                self.stop = Some(Stop::of(stop));
                false
            }
        }
    }

    /// Holds the job until a resume: the connection goes (no slot of the
    /// account's budget is kept), the journal is checkpointed as `why` (the
    /// offset stays at the start of the message in hand) and the app is
    /// told. True once resumed; false for a cancel or a discard.
    fn hold(&mut self, why: &'static str) -> bool {
        self.job.request(Ctl::Pause);
        self.pipeline.disconnect();
        self.checkpoint(why);
        self.emit(true, why);
        info!("[mbox_upload] {}: job {} held ({why}) at byte {}", self.journal.account_id, self.job.id, self.journal.offset);
        match self.job.wait_held() {
            Ctl::Run => {
                // A held stretch is no throughput.
                self.eta = Eta::default();
                self.checkpoint(RUNNING);
                self.emit(true, RUNNING);
                true
            }
            stop => {
                self.stop = Some(Stop::of(stop));
                false
            }
        }
    }

    /// A new pipeline on the account's credentials as they are now (the app
    /// may have signed in again since). What the old one touched is kept for
    /// the refresh at the end.
    fn rebuild(&mut self) {
        self.keep_folders();
        let account = self.journal.account_id.clone();
        let rebuilt = self.rt.block_on(quiet_config(&self.state, &account)).and_then(|config| {
            let pipeline = MboxUpload::new(Arc::clone(&self.state), config.clone(), account.clone(), self.journal.fallback.clone(), self.journal.use_labels)?;
            Ok((pipeline, config))
        });
        match rebuilt {
            Ok((pipeline, config)) => (self.pipeline, self.config) = (pipeline, config),
            Err(_) => warn!("[mbox_upload] {account}: the account's credentials could not be read again"),
        }
    }

    fn keep_folders(&mut self) {
        self.journal.touched.extend(self.pipeline.touched().iter().cloned());
        self.journal.created.extend(self.pipeline.created().iter().cloned());
    }

    fn record(&mut self, fp: u64, done: Done, end: u64) {
        match done {
            Done::Uploaded => self.journal.uploaded += 1,
            Done::Skipped => self.journal.skipped += 1,
            Done::Failed => self.journal.failed += 1,
        }
        self.note_tail(fp, done);
        self.journal.offset = end;
        self.handled += 1;
        self.since_checkpoint += 1;
        if self.since_checkpoint >= self.tuning.checkpoint_every || self.checkpointed.elapsed() >= self.tuning.checkpoint_after {
            self.checkpoint(RUNNING);
        }
        self.eta.sample(Instant::now(), end.saturating_sub(self.run_from), self.tuning.eta_window, self.tuning.eta_min_samples);
        let force = std::mem::take(&mut self.changed);
        self.emit(force, RUNNING);
    }

    /// One line per finished message, in one write, before the next message
    /// starts: what a resume after a crash skips.
    fn note_tail(&mut self, fp: u64, done: Done) {
        let Some(tail) = self.tail.as_mut() else { return };
        if let Err(e) = tail.write_all(format!("{} {fp:016x}\n", done.letter()).as_bytes()) {
            warn!("[mbox_upload] {}: job {} stops keeping its tail, a crash may upload a message twice: {e}", self.journal.account_id, self.job.id);
            self.tail = None;
        }
    }

    /// The offset, counters and folders, durably; then the tail starts over.
    /// A journal that will not write keeps its tail.
    fn checkpoint(&mut self, state: &str) {
        self.keep_folders();
        self.journal.state = state.to_string();
        self.journal.updated_at = now_ms();
        match write_journal(&self.state.app_dir, &self.journal) {
            Ok(()) => self.restart_tail(),
            Err(e) => warn!("[mbox_upload] {}: job {} not checkpointed: {e}", self.journal.account_id, self.job.id),
        }
        self.since_checkpoint = 0;
        self.checkpointed = Instant::now();
    }

    /// The tail after a checkpoint: what this run finished is behind the
    /// offset now and goes, but what an earlier run's tail still answers for
    /// lies ahead of it and stays, or a second crash would lose it. Written
    /// as a new file rather than cut: an append-only handle cannot be
    /// truncated on Windows. Later lines follow on this handle.
    fn restart_tail(&mut self) {
        self.tail = None;
        let ahead: String = self.done_before.iter().map(|(fp, done)| format!("{} {fp:016x}\n", done.letter())).collect();
        let path = tail_path(&self.state.app_dir, &self.job.id);
        let opened = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path);
        match opened.and_then(|mut file| file.write_all(ahead.as_bytes()).map(|()| file)) {
            Ok(file) => self.tail = Some(file),
            Err(e) => warn!("[mbox_upload] {}: job {} stops keeping its tail, a crash may upload a message twice: {e}", self.journal.account_id, self.job.id),
        }
    }

    /// The job's progress as the app sees it; an event at most every
    /// `progress_every`, unless `force`.
    fn emit(&mut self, force: bool, state: &str) {
        let eta = if state == RUNNING {
            self.eta.seconds(self.journal.size.saturating_sub(self.journal.offset), self.tuning.eta_min_samples, self.tuning.eta_min_span)
        } else {
            None
        };
        let payload = progress(&self.journal, true, state, self.throttled, eta);
        *lock(&self.job.view) = payload.clone();
        if force || self.emitted.is_none_or(|at| at.elapsed() >= self.tuning.progress_every) {
            self.state.events.emit(EVENT, payload);
            self.emitted = Some(Instant::now());
        }
    }

    /// The end, however it came: the journal made durable (or deleted), the
    /// job unregistered, and only then the last event, so an app reacting to
    /// `active: false` can resume or start again at once.
    fn finish(mut self, read: Result<(), String>) {
        let account = self.journal.account_id.clone();
        let (state, error) = match (self.stop, read) {
            #[cfg(test)]
            (Some(Stop::Crash), _) => return,
            (Some(Stop::Discard), _) => {
                // Closed first: Windows removes no open file.
                self.tail = None;
                remove_journal(&self.state.app_dir, &self.job.id);
                (DISCARDED, None)
            }
            (Some(Stop::Cancel), _) => {
                self.checkpoint(CANCELLED);
                (CANCELLED, None)
            }
            (None, Err(e)) => {
                warn!("[mbox_upload] {account}: job {} stopped reading its file at byte {}: {e}", self.job.id, self.journal.offset);
                self.checkpoint(PAUSED);
                (PAUSED, Some(e))
            }
            (None, Ok(())) => {
                self.journal.offset = self.journal.offset.max(self.journal.size);
                // Durable before the refresh: a daemon that dies during it
                // leaves a journal whose resume reads nothing and refreshes.
                self.checkpoint(RUNNING);
                self.refresh();
                self.tail = None;
                remove_journal(&self.state.app_dir, &self.job.id);
                (DONE, None)
            }
        };
        let j = &self.journal;
        info!("[mbox_upload] {account}: job {} {state}: uploaded={} skipped={} failed={}", self.job.id, j.uploaded, j.skipped, j.failed);
        unregister(&self.state, &self.job);
        let mut last = progress(&self.journal, false, state, false, None);
        last["foldersChanged"] = json!(!self.journal.created.is_empty());
        if let Some(e) = error {
            last["error"] = json!(e);
        }
        *lock(&self.job.view) = last.clone();
        self.state.events.emit(EVENT, last);
    }

    /// What the app shows for the folders mail went into, brought up to date
    /// through the existing sync path; the folder list marked out of date when
    /// the upload made folders; one full index pass when mail landed.
    fn refresh(&mut self) {
        self.keep_folders();
        let account = SyncAccount { id: self.journal.account_id.clone(), email: self.config.email.clone(), imap_config: self.config.clone() };
        let folders: Vec<String> = self.journal.touched.iter().cloned().collect();
        let mut unsynced = 0;
        for folder in &folders {
            let result = self.rt.block_on(self.state.sync_engine.sync_account(&account, folder));
            if result.success {
                self.state.sync_engine.note_change(&account.id, folder, 0, result.updated_flags);
            } else {
                unsynced += 1;
            }
        }
        if unsynced > 0 {
            warn!("[mbox_upload] {}: {unsynced} of {} folder(s) not synced after the upload", account.id, folders.len());
        }
        if !self.journal.created.is_empty() {
            if let Err(e) = folder_list_stale(&self.state, &account.id) {
                warn!("[mbox_upload] {}: the cached folder list was not marked out of date: {e}", account.id);
            }
        }
        if self.journal.uploaded > 0 {
            crate::search_index::sweep_soon(&self.state.search_index);
        }
    }
}

/// The account's cached folder list, marked out of date (`fetchedAt` 0) and
/// otherwise kept as it is, in one custody unit: the app lists the folders
/// again the next time it opens the account, and the ones the upload made
/// appear.
fn folder_list_stale(state: &DaemonState, account: &str) -> Result<(), String> {
    crate::custody::with_conn(state, |c| {
        let Some(data) = cache::load_mailboxes(c, account)? else { return Ok(()) };
        let mut listing: Value = serde_json::from_str(&data).map_err(|e| format!("the cached folder list does not parse: {e}"))?;
        let Some(fields) = listing.as_object_mut() else { return Ok(()) };
        fields.insert("fetchedAt".into(), json!(0));
        cache::save_mailboxes(c, account, &listing.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::RpcResponse;
    use crate::server::handle_request_for_test;
    use mock_imap::{Action, Mailbox, Message, MockImap, Scenario, Trigger};
    use tokio::sync::broadcast;

    const DATE: &str = "Tue, 05 Mar 2019 09:15:00 +0100";
    const ALL_MAIL: &str = "[Gmail]/All Mail";

    // ---- units ----

    fn fast() -> Tuning {
        Tuning {
            backoff_base: Duration::from_millis(40),
            backoff_max: Duration::from_millis(200),
            attempts: 3,
            checkpoint_every: 2,
            checkpoint_after: Duration::from_secs(60),
            progress_every: Duration::ZERO,
            eta_window: Duration::from_secs(60),
            eta_min_samples: 3,
            eta_min_span: Duration::ZERO,
            crash_after: None,
        }
    }

    /// Doubling from the base, jitter only upward, never past the cap, never
    /// under the base: 5 s to 5 min with the defaults.
    #[test]
    fn a_retry_waits_longer_each_time_within_its_bounds() {
        let t = Tuning::default();
        for level in 0..40u32 {
            let full = (t.backoff_base * 2u32.saturating_pow(level.saturating_sub(1).min(20))).min(t.backoff_max);
            for _ in 0..20 {
                let d = backoff(level, &t);
                assert!(d >= t.backoff_base && d <= t.backoff_max, "level {level}: {d:?}");
                assert!(d >= full && d <= full.mul_f64(1.5), "level {level}: {d:?} against {full:?}");
            }
        }
        assert!(backoff(1, &t) <= Duration::from_millis(7500));
        assert_eq!(backoff(12, &t), t.backoff_max, "far enough in, always the cap");
    }

    /// No estimate before enough samples, nor when nothing moved; then the
    /// bytes left over the measured rate.
    #[test]
    fn the_eta_waits_for_enough_throughput_and_then_measures_it() {
        let mut eta = Eta::default();
        let t0 = Instant::now();
        let (window, keep) = (Duration::from_secs(60), 3);
        eta.sample(t0, 100, window, keep);
        assert_eq!(eta.seconds(1000, 3, Duration::ZERO), None, "one sample says nothing");
        eta.sample(t0 + Duration::from_secs(1), 200, window, keep);
        assert_eq!(eta.seconds(1000, 3, Duration::ZERO), None, "two are fewer than asked for");
        eta.sample(t0 + Duration::from_secs(2), 300, window, keep);
        assert_eq!(eta.seconds(1000, 3, Duration::ZERO), Some(10), "100 bytes a second, 1000 left");
        assert_eq!(eta.seconds(1000, 3, Duration::from_secs(5)), None, "a span shorter than asked for");

        let mut stuck = Eta::default();
        for s in 0..4 {
            stuck.sample(t0 + Duration::from_secs(s), 50, window, keep);
        }
        assert_eq!(stuck.seconds(1000, 3, Duration::ZERO), None, "nothing moved");

        // Old samples leave the window, but `keep` of them always stay.
        let mut slow = Eta::default();
        for s in 0..10 {
            slow.sample(t0 + Duration::from_secs(s * 100), s * 10, window, keep);
        }
        assert_eq!(slow.samples.len(), 3);
        assert_eq!(slow.seconds(10, 3, Duration::ZERO), Some(100), "10 bytes per 100 s");
    }

    #[test]
    fn a_journal_and_its_tail_read_back_as_written() {
        let app = tempfile::tempdir().unwrap();
        let journal = Journal {
            version: JOURNAL_VERSION,
            job_id: "0d4e5c2a-1111-4222-8333-944455556666".into(),
            account_id: "acct1".into(),
            source_path: "/somewhere/Takeout.mbox".into(),
            size: 99,
            mtime_ms: 7,
            use_labels: true,
            fallback: ALL_MAIL.into(),
            offset: 40,
            uploaded: 2,
            skipped: 1,
            failed: 0,
            state: PAUSED.into(),
            touched: ["INBOX".to_string()].into(),
            created: BTreeSet::new(),
            updated_at: 5,
        };
        write_journal(app.path(), &journal).unwrap();
        assert_eq!(read_journal(app.path(), &journal.job_id), Some(journal.clone()));
        assert_eq!(list_journals(app.path()), vec![journal.clone()]);

        std::fs::write(tail_path(app.path(), &journal.job_id), "u 00000000000000ff\ns 0000000000000001\nf 00000000000000\nu 12").unwrap();
        let tail = read_tail(app.path(), &journal.job_id);
        assert_eq!(tail.get(&0xff), Some(&Done::Uploaded));
        assert_eq!(tail.get(&1), Some(&Done::Skipped));
        assert_eq!(tail.get(&0x12), Some(&Done::Uploaded), "a short hex still names a fingerprint");
        assert_eq!(tail.len(), 4, "every line that parses");
        std::fs::write(tail_path(app.path(), &journal.job_id), "u 00000000000000ff\nf not-hex\nx 01\n").unwrap();
        assert_eq!(read_tail(app.path(), &journal.job_id).len(), 1, "a torn or foreign line is left out");

        let mut other = journal.clone();
        other.version = 2;
        write_journal(app.path(), &other).unwrap();
        assert_eq!(read_journal(app.path(), &journal.job_id), None, "another version is not read");
        remove_journal(app.path(), &journal.job_id);
        assert!(std::fs::read_dir(journal_dir(app.path())).unwrap().next().is_none(), "json and tail both gone");
    }

    #[test]
    fn a_job_id_is_one_plain_name() {
        assert!(is_job_id(&uuid::Uuid::new_v4().to_string()));
        for bad in ["", "../x", "a/b", "a.json", "a b", &"x".repeat(65)] {
            assert!(!is_job_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_fingerprint_is_the_content_and_nothing_else() {
        assert_eq!(fingerprint(b"one"), fingerprint(b"one"));
        assert_ne!(fingerprint(b"one"), fingerprint(b"one "));
        // SHA-256("abc") starts ba7816bf8f01cfea: stable across builds.
        assert_eq!(fingerprint(b"abc"), 0xba78_16bf_8f01_cfea);
    }

    // ---- jobs over the mock server ----

    struct Rig {
        server: MockImap,
        s: Arc<DaemonState>,
        rx: broadcast::Receiver<Arc<str>>,
        files: tempfile::TempDir,
        _vault: tempfile::TempDir,
        _app: tempfile::TempDir,
    }

    fn config(server: &MockImap) -> ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(json!({
            "email": "user@example.com",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
        }))
        .unwrap()
    }

    fn setup(scenario: Scenario, tuning: Tuning) -> Rig {
        let server = MockImap::start(scenario);
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let s = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), true);
        s.raw_messages.accounts.lock().unwrap().insert("acct1".into(), config(&server));
        *lock(&s.mbox_uploads.tuning) = Some(tuning);
        let rx = s.events.subscribe();
        Rig { server, s, rx, files: tempfile::tempdir().unwrap(), _vault: vault, _app: app }
    }

    /// A Gmail-shaped server: INBOX holding uids 1 to 4, Sent Mail, All Mail
    /// (`\All`) and Work.
    fn gmail() -> Scenario {
        let mut inbox = Mailbox::new("INBOX");
        for uid in 1..=4 {
            inbox.add(Message::new(uid, format!("Message-ID: <old{uid}@x>\r\nSubject: old {uid}\r\nDate: {DATE}\r\n\r\nold")));
        }
        Scenario::new()
            .mailbox(inbox)
            .mailbox(Mailbox::new("[Gmail]/Sent Mail").with_attrs(&["\\HasNoChildren", "\\Sent"]))
            .mailbox(Mailbox::new(ALL_MAIL).with_attrs(&["\\HasNoChildren", "\\All"]))
            .mailbox(Mailbox::new("Work"))
    }

    fn msg(id: &str, subject: &str) -> Vec<u8> {
        format!("Message-ID: <{id}>\r\nSubject: {subject}\r\nDate: {DATE}\r\n\r\nbody of {subject}").into_bytes()
    }

    /// A chat or a draft: no Message-ID.
    fn idless(subject: &str) -> Vec<u8> {
        format!("Subject: {subject}\r\nDate: {DATE}\r\n\r\nbody of {subject}").into_bytes()
    }

    fn labelled(id: &str, subject: &str, labels: &str) -> Vec<u8> {
        format!("X-Gmail-Labels: {labels}\r\nMessage-ID: <{id}>\r\nSubject: {subject}\r\nDate: {DATE}\r\n\r\nbody of {subject}").into_bytes()
    }

    fn mbox_bytes(messages: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for m in messages {
            out.extend_from_slice(b"From x@y Mon Jan  1 00:00:00 2026\n");
            out.extend_from_slice(m);
            out.extend_from_slice(b"\n\n");
        }
        out
    }

    fn mbox(rig: &Rig, messages: &[Vec<u8>]) -> PathBuf {
        let path = rig.files.path().join(format!("{}.mbox", uuid::Uuid::new_v4()));
        std::fs::write(&path, mbox_bytes(messages)).unwrap();
        path
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        handle_request_for_test(s, method, params).await
    }

    fn ok(resp: RpcResponse) -> Value {
        match (resp.result, resp.error) {
            (Some(v), None) => v,
            (_, e) => panic!("refused: {e:?}"),
        }
    }

    fn refused(resp: RpcResponse) -> String {
        resp.error.expect("must be refused").message
    }

    fn start_params(path: &Path, labels: bool) -> Value {
        json!({"sourcePath": path.to_string_lossy(), "accountId": "acct1", "mode": "server", "mailbox": "INBOX", "useLabels": labels, "fallbackMailbox": ALL_MAIL})
    }

    async fn start(rig: &Rig, path: &Path, labels: bool) -> String {
        let started = ok(call(&rig.s, "import_mbox", start_params(path, labels)).await);
        assert_eq!(started["started"], json!(true));
        started["jobId"].as_str().expect("a job id").to_string()
    }

    async fn control(rig: &Rig, method: &str, job: &str) -> Value {
        ok(call(&rig.s, method, json!({"jobId": job})).await)
    }

    /// The next progress event `want` accepts.
    async fn next(rx: &mut broadcast::Receiver<Arc<str>>, want: impl Fn(&Value) -> bool) -> Value {
        let wait = async {
            loop {
                match rx.recv().await {
                    Ok(line) => {
                        let v: Value = serde_json::from_str(&line).unwrap();
                        if v["params"]["name"] == EVENT && want(&v["params"]["payload"]) {
                            return v["params"]["payload"].clone();
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(e) => panic!("event bus: {e}"),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait).await.expect("the progress event never came")
    }

    /// Every progress event up to and including the job's last one.
    async fn until_done(rx: &mut broadcast::Receiver<Arc<str>>) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let e = next(rx, |_| true).await;
            let last = e["active"] == json!(false);
            seen.push(e);
            if last {
                return seen;
            }
        }
    }

    async fn status_of(rig: &Rig, job: &str) -> Value {
        let all = ok(call(&rig.s, "mbox_upload_status", json!({})).await);
        all["jobs"].as_array().expect("a list").iter().find(|j| j["jobId"] == job).cloned().unwrap_or(Value::Null)
    }

    async fn wait_until_uploaded(rig: &Rig, job: &str, n: u64) {
        for _ in 0..2000 {
            if status_of(rig, job).await["uploadedCount"].as_u64().unwrap_or(0) >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {job} never uploaded {n}");
    }

    async fn wait_until_not_live(rig: &Rig, job: &str) {
        for _ in 0..2000 {
            if status_of(rig, job).await["live"] != json!(true) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {job} never ended");
    }

    fn subjects(server: &MockImap, mailbox: &str) -> Vec<String> {
        let state = server.state();
        let Some(mb) = state.find(mailbox) else { return Vec::new() };
        mb.messages
            .iter()
            .map(|m| String::from_utf8_lossy(&m.raw).lines().find_map(|l| l.strip_prefix("Subject: ")).unwrap_or_default().to_string())
            .collect()
    }

    fn journal_of(rig: &Rig, job: &str) -> Journal {
        read_journal(&rig.s.app_dir, job).expect("a journal")
    }

    fn the_run(rig: &Rig, job: &str) -> Arc<Job> {
        lock(&rig.s.mbox_uploads.ran).iter().rev().find(|j| j.id == job).cloned().expect("a run")
    }

    fn slow_appends(ms: u64) -> Scenario {
        gmail().fault(Trigger::on("APPEND"), Action::Delay(Duration::from_millis(ms)))
    }

    /// A Takeout with labels: each message in its folder (a label with no
    /// folder made on the server), the rest in the fallback; the final event
    /// has the totals; the folders are synced so the app lists the uploads
    /// as server rows and a change record tells it to repaint (0 new: no
    /// banner); the folder list is marked out of date; the index gets a full
    /// pass; the journal is gone.
    #[tokio::test]
    async fn a_takeout_goes_up_folder_by_folder_and_the_app_is_told_what_changed() {
        let mut rig = setup(gmail(), fast());
        let listing = json!({"mailboxes": [{"path": "INBOX", "name": "INBOX"}], "fetchedAt": 123}).to_string();
        crate::custody::with_conn(&rig.s, |c| cache::save_mailboxes(c, "acct1", &listing)).unwrap();
        let (tx, index) = std::sync::mpsc::channel();
        *rig.s.search_index.signals.lock().unwrap() = Some(tx);
        let file = mbox(
            &rig,
            &[
                labelled("a@x", "inbox one", "Inbox,Opened"),
                labelled("b@x", "work one", "Work,Opened"),
                labelled("c@x", "new one", "Projects,Opened"),
                labelled("d@x", "no home", "Category Promotions,Opened"),
            ],
        );
        let job = start(&rig, &file, true).await;
        let events = until_done(&mut rig.rx).await;
        let last = events.last().unwrap();

        let size = std::fs::metadata(&file).unwrap().len();
        assert_eq!(last["jobId"], json!(job));
        assert_eq!((last["state"].clone(), last["active"].clone()), (json!(DONE), json!(false)));
        assert_eq!((last["uploadedCount"].clone(), last["skippedCount"].clone(), last["failedCount"].clone()), (json!(4), json!(0), json!(0)));
        assert_eq!((last["total"].clone(), last["completed"].clone()), (json!(4), json!(4)));
        assert_eq!((last["bytesDone"].clone(), last["bytesTotal"].clone()), (json!(size), json!(size)));
        assert_eq!(last["foldersChanged"], json!(true));
        assert!(events.iter().all(|e| e["mode"] == json!("server") && e["jobId"] == json!(job)), "every event names the job");

        assert_eq!(subjects(&rig.server, "INBOX")[4..], ["inbox one"]);
        assert_eq!(subjects(&rig.server, "Work"), ["work one"]);
        assert_eq!(subjects(&rig.server, "Projects"), ["new one"]);
        assert_eq!(subjects(&rig.server, ALL_MAIL), ["no home"]);

        assert!(list_journals(&rig.s.app_dir).is_empty(), "a finished upload leaves no journal");
        assert!(!tail_path(&rig.s.app_dir, &job).exists());
        assert_eq!(ok(call(&rig.s, "mbox_upload_status", json!({})).await), json!({"jobs": []}));

        let (_, changes) = rig.s.sync_engine.wait_changes(0, 0).await;
        let changed: BTreeSet<&str> = changes.iter().map(|c| c.mailbox.as_str()).collect();
        assert_eq!(changed, ["INBOX", "Projects", "Work", ALL_MAIL].into_iter().collect());
        assert!(changes.iter().all(|c| c.account_id == "acct1" && c.new_emails == 0), "{changes:?}");
        let work_rows = crate::custody::with_conn(&rig.s, |c| cache::uid_set(c, "acct1", "Work")).unwrap();
        assert!(work_rows.contains(&1), "the uploaded message is a cached server row: {work_rows:?}");

        let listed: Value = serde_json::from_str(&crate::custody::with_conn(&rig.s, |c| cache::load_mailboxes(c, "acct1")).unwrap().unwrap()).unwrap();
        assert_eq!(listed["fetchedAt"], json!(0), "the folder list is out of date now");
        assert_eq!(listed["mailboxes"], json!([{"path": "INBOX", "name": "INBOX"}]), "and otherwise kept");
        assert!(index.try_iter().any(|s| s == mailvault_core::search_index::plan::Signal::Sweep), "a full index pass was asked for");
    }

    /// Over the same file again (no journal: the first run finished), the
    /// server's own dedupe skips everything.
    #[tokio::test]
    async fn a_second_run_over_the_same_file_uploads_nothing() {
        let mut rig = setup(gmail(), fast());
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two"), msg("c@x", "three")]);
        start(&rig, &file, false).await;
        let first = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!(first["uploadedCount"], json!(3));

        start(&rig, &file, false).await;
        let second = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((second["uploadedCount"].clone(), second["skippedCount"].clone(), second["failedCount"].clone()), (json!(0), json!(3), json!(0)));
        assert_eq!(rig.server.count_commands("APPEND"), 3);
        assert_eq!(subjects(&rig.server, "INBOX")[4..], ["one", "two", "three"]);
    }

    /// Cancelled mid-run: the journal keeps the checkpoint, the same file
    /// cannot start afresh over it, and a resume reads on from that byte (the
    /// reader never goes back to 0) to exactly one copy of each message.
    #[tokio::test]
    async fn a_cancelled_upload_resumes_from_its_checkpoint_without_duplicates() {
        let mut rig = setup(slow_appends(150), fast());
        let messages: Vec<Vec<u8>> = (1..=6).map(|i| msg(&format!("m{i}@x"), &format!("m{i}"))).collect();
        let file = mbox(&rig, &messages);
        let size = std::fs::metadata(&file).unwrap().len();
        let job = start(&rig, &file, false).await;
        wait_until_uploaded(&rig, &job, 2).await;
        assert_eq!(control(&rig, "mbox_upload_cancel", &job).await, json!({"jobId": job, "cancelled": true}));
        let cancelled = next(&mut rig.rx, |e| e["active"] == json!(false)).await;
        assert_eq!(cancelled["state"], json!(CANCELLED));
        let before = cancelled["uploadedCount"].as_u64().unwrap();
        assert!((2..6).contains(&before), "stopped mid-run: {before}");

        let journal = journal_of(&rig, &job);
        assert_eq!((journal.state.as_str(), journal.uploaded), (CANCELLED, before));
        assert_eq!(json!(journal.offset), cancelled["bytesDone"]);
        assert!(journal.offset > 0 && journal.offset < size, "{}", journal.offset);
        let listed = status_of(&rig, &job).await;
        assert_eq!((listed["live"].clone(), listed["state"].clone()), (json!(false), json!(CANCELLED)));
        assert_eq!(rig.server.count_commands("APPEND") as u64, before);

        let again = refused(call(&rig.s, "import_mbox", start_params(&file, false)).await);
        assert_eq!(again, format!("{E_MBOX_UPLOAD_RESUMABLE}: {job}"));

        assert_eq!(control(&rig, "mbox_upload_resume", &job).await, json!({"jobId": job, "resumed": true, "restarted": false}));
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["state"].clone(), last["uploadedCount"].clone(), last["skippedCount"].clone()), (json!(DONE), json!(6), json!(0)));

        let run = the_run(&rig, &job);
        assert_eq!(run.read_from.load(std::sync::atomic::Ordering::SeqCst), journal.offset, "the resume read from the checkpoint");
        assert_eq!(run.parsed.load(std::sync::atomic::Ordering::SeqCst), 6 - before, "and parsed only what was left");
        assert_eq!(rig.server.count_commands("APPEND"), 6);
        assert_eq!(subjects(&rig.server, "INBOX")[4..], ["m1", "m2", "m3", "m4", "m5", "m6"]);
    }

    /// Killed between APPENDs and before any checkpoint (the journal still at
    /// byte 0): the tail answers for what landed, with and without a
    /// Message-ID. Killed again during the resume, right after its first
    /// checkpoint: the tail still holds the entries that run had not reached.
    /// Without the tail (or with one a checkpoint emptied) the idless "chat
    /// two" would go up twice, and the ones with an id would count as skipped.
    #[tokio::test]
    async fn a_crash_before_the_checkpoint_duplicates_nothing_with_or_without_a_message_id() {
        let crashing = Tuning { checkpoint_every: 1000, checkpoint_after: Duration::from_secs(3600), crash_after: Some(3), ..fast() };
        let mut rig = setup(gmail(), crashing);
        let file = mbox(&rig, &[msg("a@x", "one"), idless("chat two"), msg("c@x", "three"), idless("chat four"), msg("e@x", "five")]);
        let job = start(&rig, &file, false).await;
        wait_until_not_live(&rig, &job).await;

        let journal = journal_of(&rig, &job);
        assert_eq!((journal.offset, journal.uploaded, journal.state.as_str()), (0, 0, RUNNING), "no checkpoint after the first");
        assert_eq!(read_tail(&rig.s.app_dir, &job).len(), 3, "the tail knows the three that finished");
        assert_eq!(rig.server.count_commands("APPEND"), 3);
        let listed = status_of(&rig, &job).await;
        assert_eq!((listed["live"].clone(), listed["state"].clone()), (json!(false), json!(PAUSED)), "cut off while running reads as paused");

        // The resume checkpoints after its first message (answered by the
        // tail), then dies too.
        *lock(&rig.s.mbox_uploads.tuning) = Some(Tuning { checkpoint_every: 1, crash_after: Some(1), ..fast() });
        control(&rig, "mbox_upload_resume", &job).await;
        wait_until_not_live(&rig, &job).await;
        let journal = journal_of(&rig, &job);
        assert_eq!(journal.uploaded, 1, "checkpointed past the first message");
        assert!(journal.offset > 0);
        assert_eq!(read_tail(&rig.s.app_dir, &job).len(), 2, "the two entries still ahead of the offset stay");
        assert_eq!(rig.server.count_commands("APPEND"), 3, "the tail answered, nothing went up");

        *lock(&rig.s.mbox_uploads.tuning) = Some(Tuning { crash_after: None, ..fast() });
        control(&rig, "mbox_upload_resume", &job).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["uploadedCount"].clone(), last["skippedCount"].clone(), last["failedCount"].clone()), (json!(5), json!(0), json!(0)));
        assert_eq!(rig.server.count_commands("APPEND"), 5, "nothing sent twice");
        assert_eq!(subjects(&rig.server, "INBOX")[4..], ["one", "chat two", "three", "chat four", "five"]);
    }

    /// The file changed after the cancel: its offsets name other bytes now,
    /// so the resume starts over from 0, and the server's dedupe skips what
    /// the first run put there.
    #[tokio::test]
    async fn a_changed_file_starts_over_and_the_server_dedupe_keeps_one_copy() {
        let mut rig = setup(slow_appends(120), fast());
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two"), msg("c@x", "three"), msg("d@x", "four")]);
        let job = start(&rig, &file, false).await;
        wait_until_uploaded(&rig, &job, 1).await;
        control(&rig, "mbox_upload_cancel", &job).await;
        let cancelled = next(&mut rig.rx, |e| e["active"] == json!(false)).await;
        let before = cancelled["uploadedCount"].as_u64().unwrap();
        assert!(before < 4);

        let mut more = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        more.write_all(&mbox_bytes(&[msg("e@x", "five")])).unwrap();
        drop(more);

        assert_eq!(control(&rig, "mbox_upload_resume", &job).await, json!({"jobId": job, "resumed": true, "restarted": true}));
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!(the_run(&rig, &job).read_from.load(std::sync::atomic::Ordering::SeqCst), 0, "read from the start");
        assert_eq!((last["skippedCount"].clone(), last["uploadedCount"].clone()), (json!(before), json!(5 - before)), "the counters start over too");
        assert_eq!(last["bytesTotal"], json!(std::fs::metadata(&file).unwrap().len()));
        assert_eq!(rig.server.count_commands("APPEND"), 5);
        assert_eq!(subjects(&rig.server, "INBOX")[4..], ["one", "two", "three", "four", "five"]);
    }

    /// Throttled once (the mock still runs a refused APPEND, so the message
    /// is there): the job says so, waits at least the base backoff, tries
    /// again, finds it on the server and goes on. One copy, nothing failed.
    #[tokio::test]
    async fn a_throttled_message_backs_off_and_is_tried_again() {
        let throttled = Action::Respond("NO".into(), "[THROTTLED] Too many commands, slow down".into());
        let mut rig = setup(gmail().fault(Trigger::nth_with("APPEND", "throttle-me", 1), throttled), Tuning { backoff_base: Duration::from_millis(80), ..fast() });
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "throttle-me"), msg("c@x", "three")]);
        let started = Instant::now();
        start(&rig, &file, false).await;
        let events = until_done(&mut rig.rx).await;
        assert!(started.elapsed() >= Duration::from_millis(80), "waited out the backoff: {:?}", started.elapsed());

        let at = events.iter().position(|e| e["throttled"] == json!(true)).expect("a throttled event");
        assert_eq!(events[at]["paused"], json!(false));
        assert!(events[at + 1..].iter().any(|e| e["throttled"] == json!(false)), "and one when it cleared");
        let last = events.last().unwrap();
        assert_eq!((last["failedCount"].clone(), last["uploadedCount"].clone(), last["skippedCount"].clone()), (json!(0), json!(2), json!(1)));
        assert_eq!(subjects(&rig.server, "INBOX").iter().filter(|s| *s == "throttle-me").count(), 1, "one copy");
    }

    /// A message the server refuses counts as failed; the job goes on and
    /// finishes.
    #[tokio::test]
    async fn a_refused_message_counts_as_failed_and_the_run_finishes() {
        let too_big = Action::Respond("NO".into(), "[CANNOT] Message too large".into());
        let mut rig = setup(gmail().fault(Trigger::with("APPEND", "too-big"), too_big), fast());
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "too-big"), msg("c@x", "three")]);
        start(&rig, &file, false).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["state"].clone(), last["failedCount"].clone(), last["uploadedCount"].clone()), (json!(DONE), json!(1), json!(2)));
        assert_eq!(rig.server.count_commands("APPEND"), 3, "a refusal is not retried");
    }

    /// The sign-in is refused mid-run (the connection dropped, and the next
    /// two LOGINs, before and after reading the credentials again, turned
    /// away): the job holds as `needsSignIn` with nothing counted failed and
    /// no further message tried, then finishes after a resume.
    #[tokio::test]
    async fn a_refused_sign_in_holds_the_job_instead_of_failing_every_message() {
        let turned_away = Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into());
        let scenario = gmail()
            .fault(Trigger::nth_with("APPEND", "drop-me", 1), Action::DropConnection)
            .fault(Trigger::nth("LOGIN", 2), turned_away.clone())
            .fault(Trigger::nth("LOGIN", 3), turned_away);
        let mut rig = setup(scenario, fast());
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two"), msg("c@x", "drop-me"), msg("d@x", "four")]);
        let job = start(&rig, &file, false).await;
        let held = next(&mut rig.rx, |e| e["needsSignIn"] == json!(true)).await;
        assert_eq!((held["paused"].clone(), held["active"].clone(), held["state"].clone()), (json!(true), json!(true), json!(NEEDS_SIGN_IN)));
        assert_eq!((held["failedCount"].clone(), held["uploadedCount"].clone()), (json!(0), json!(2)));

        let listed = status_of(&rig, &job).await;
        assert_eq!((listed["live"].clone(), listed["state"].clone()), (json!(true), json!(NEEDS_SIGN_IN)));
        let journal = journal_of(&rig, &job);
        assert_eq!((journal.state.as_str(), json!(journal.offset)), (NEEDS_SIGN_IN, held["bytesDone"].clone()));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rig.server.count_commands("APPEND"), 3, "nothing more tried while held");
        assert_eq!(rig.server.count_commands("LOGIN"), 3);

        control(&rig, "mbox_upload_resume", &job).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["state"].clone(), last["uploadedCount"].clone(), last["failedCount"].clone()), (json!(DONE), json!(4), json!(0)));
        assert_eq!(subjects(&rig.server, "INBOX")[4..], ["one", "two", "drop-me", "four"]);
    }

    /// Paused: the event says so, nothing more goes up, the journal holds the
    /// checkpoint; resumed, it finishes in place.
    #[tokio::test]
    async fn a_paused_upload_stops_its_counters_and_resumes_in_place() {
        let mut rig = setup(slow_appends(120), fast());
        let messages: Vec<Vec<u8>> = (1..=5).map(|i| msg(&format!("p{i}@x"), &format!("p{i}"))).collect();
        let file = mbox(&rig, &messages);
        let job = start(&rig, &file, false).await;
        wait_until_uploaded(&rig, &job, 1).await;
        assert_eq!(control(&rig, "mbox_upload_pause", &job).await, json!({"jobId": job, "paused": true}));
        let paused = next(&mut rig.rx, |e| e["paused"] == json!(true)).await;
        assert_eq!((paused["state"].clone(), paused["active"].clone(), paused["needsSignIn"].clone()), (json!(PAUSED), json!(true), json!(false)));

        let (uploaded, appends) = (status_of(&rig, &job).await["uploadedCount"].clone(), rig.server.count_commands("APPEND"));
        tokio::time::sleep(Duration::from_millis(400)).await;
        let listed = status_of(&rig, &job).await;
        assert_eq!((listed["uploadedCount"].clone(), listed["state"].clone(), listed["live"].clone()), (uploaded.clone(), json!(PAUSED), json!(true)));
        assert_eq!(rig.server.count_commands("APPEND"), appends, "nothing went up while paused");
        let journal = journal_of(&rig, &job);
        assert_eq!((journal.state.as_str(), json!(journal.uploaded)), (PAUSED, uploaded));

        assert_eq!(control(&rig, "mbox_upload_resume", &job).await, json!({"jobId": job, "resumed": true, "restarted": false}));
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["state"].clone(), last["uploadedCount"].clone()), (json!(DONE), json!(5)));
        assert_eq!(the_run(&rig, &job).parsed.load(std::sync::atomic::Ordering::SeqCst), 5, "one run, in place");
    }

    /// One job per account: a second start is refused with the running job's id.
    #[tokio::test]
    async fn a_second_upload_for_the_account_is_refused_while_one_runs() {
        let mut rig = setup(slow_appends(150), fast());
        let first = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two"), msg("c@x", "three")]);
        let other = mbox(&rig, &[msg("z@x", "other")]);
        let job = start(&rig, &first, false).await;
        let second = refused(call(&rig.s, "import_mbox", start_params(&other, false)).await);
        assert_eq!(second, format!("{E_MBOX_UPLOAD_RUNNING}: {job}"));
        control(&rig, "mbox_upload_cancel", &job).await;
        until_done(&mut rig.rx).await;
        let after = start(&rig, &other, false).await;
        assert_ne!(after, job, "once it ended, the account takes another");
        until_done(&mut rig.rx).await;
    }

    /// No estimate until three messages are measured; then a number.
    #[tokio::test]
    async fn the_eta_is_null_early_and_a_number_once_measured() {
        let mut rig = setup(gmail(), fast());
        let messages: Vec<Vec<u8>> = (1..=6).map(|i| msg(&format!("e{i}@x"), &format!("e{i}"))).collect();
        let file = mbox(&rig, &messages);
        start(&rig, &file, false).await;
        let events = until_done(&mut rig.rx).await;
        let at = |n: u64| events.iter().find(|e| e["active"] == json!(true) && e["uploadedCount"] == json!(n)).cloned().unwrap_or_else(|| panic!("no event at {n}"));
        assert!(at(0)["etaSeconds"].is_null());
        assert!(at(1)["etaSeconds"].is_null(), "{}", at(1));
        assert!(at(3)["etaSeconds"].is_u64(), "{}", at(3));
        assert!(at(5)["etaSeconds"].is_u64(), "{}", at(5));
        assert!(events.last().unwrap()["etaSeconds"].is_null(), "none once it is over");
    }

    /// The job never stands in the way of the RPCs: status and a vault read
    /// answer at once while an APPEND is held up on the server.
    #[tokio::test]
    async fn the_routes_answer_at_once_while_the_job_works() {
        let mut rig = setup(slow_appends(400), fast());
        let messages: Vec<Vec<u8>> = (1..=5).map(|i| msg(&format!("q{i}@x"), &format!("q{i}"))).collect();
        let file = mbox(&rig, &messages);
        let job = start(&rig, &file, false).await;
        wait_until_uploaded(&rig, &job, 1).await;
        for (method, params) in [("mbox_upload_status", json!({})), ("list_local_folders", json!({"accountId": "acct1"}))] {
            let asked = Instant::now();
            ok(call(&rig.s, method, params).await);
            assert!(asked.elapsed() < Duration::from_secs(1), "{method} took {:?}", asked.elapsed());
        }
        assert_eq!(status_of(&rig, &job).await["live"], json!(true), "still working");
        control(&rig, "mbox_upload_cancel", &job).await;
        until_done(&mut rig.rx).await;
    }

    /// A discard deletes the journal; the file starts afresh afterwards. An
    /// id with neither a job nor a journal is not found.
    #[tokio::test]
    async fn a_discarded_upload_leaves_nothing_to_resume() {
        let mut rig = setup(slow_appends(120), fast());
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two"), msg("c@x", "three")]);
        let job = start(&rig, &file, false).await;
        wait_until_uploaded(&rig, &job, 1).await;
        control(&rig, "mbox_upload_cancel", &job).await;
        until_done(&mut rig.rx).await;
        assert!(journal_of(&rig, &job).offset > 0);

        assert_eq!(control(&rig, "mbox_upload_discard", &job).await, json!({"jobId": job, "discarded": true}));
        assert!(read_journal(&rig.s.app_dir, &job).is_none() && !tail_path(&rig.s.app_dir, &job).exists());
        assert_eq!(status_of(&rig, &job).await, Value::Null);
        for method in ["mbox_upload_resume", "mbox_upload_pause", "mbox_upload_cancel", "mbox_upload_discard"] {
            let msg = refused(call(&rig.s, method, json!({"jobId": job})).await);
            assert_eq!(msg, format!("{E_MBOX_UPLOAD_NOT_FOUND}: {job}"), "{method}");
        }
        let fresh = start(&rig, &file, false).await;
        assert_ne!(fresh, job);
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!(last["uploadedCount"].as_u64().unwrap() + last["skippedCount"].as_u64().unwrap(), 3);
        assert_eq!(rig.server.count_commands("APPEND"), 3);
    }

    /// Discarding a live job ends it and its worker deletes the journal.
    #[tokio::test]
    async fn discarding_a_live_upload_ends_it_and_deletes_its_journal() {
        let mut rig = setup(slow_appends(120), fast());
        let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two"), msg("c@x", "three")]);
        let job = start(&rig, &file, false).await;
        wait_until_uploaded(&rig, &job, 1).await;
        control(&rig, "mbox_upload_discard", &job).await;
        let last = next(&mut rig.rx, |e| e["active"] == json!(false)).await;
        assert_eq!(last["state"], json!(DISCARDED));
        assert!(read_journal(&rig.s.app_dir, &job).is_none());
        assert_eq!(status_of(&rig, &job).await, Value::Null);
    }
}
