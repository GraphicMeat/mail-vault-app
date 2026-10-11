//! The storage format conversion as a job (Plan B, Tasks 8 and 9): the one
//! conversion a vault can have at a time, its journal, its controls and its
//! progress. Task 8 builds all of it but the conversion itself: `convert` is
//! a stub that converts nothing and holds the job at 0 of 0 until it is
//! paused or cancelled, and `precheck` lets every start through. Task 9
//! fills those two functions; nothing else here changes shape for it.
//!
//! - **Markers.** A start (and a resume) writes the vault marker's
//!   `storageFormat` row, the target: from then on every writer writes the
//!   target format, and readers read both. It also writes `storageMigration`,
//!   the job id. That row is set while a job runs or is paused, and emptied
//!   when the job ends (done, cancelled or failed): a vault move is refused
//!   while it is set (Task 10).
//! - **Journal.** `<app data>/format_migrations/<jobId>.json`, written
//!   atomically. It names the vault it belongs to, so a journal another vault
//!   left is never shown. A done job's journal is removed. A cancelled or
//!   failed one stays, so Settings can offer Resume and Convert back, until
//!   the next conversion of the vault replaces it.
//! - **Control.** Pause holds the worker where it stands, and resume wakes
//!   it. With no live worker (after a restart, a cancel or a failure), resume
//!   starts a new one from the journal. Cancel ends the worker. Nothing is
//!   rolled back: the vault stays in the target format, mixed and readable.
//! - **Worker.** One OS thread at background QoS (`spawn`).
//! - **Progress** is the `format-migration-progress` event: every change of
//!   state, and at most four a second in between (`Runner::progress`). Its
//!   payload is the `migration` object `storage_format_get` answers.

use crate::server::DaemonState;
use mailvault_core::message_store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tracing::{info, warn};

/// A conversion is running or paused in this daemon, or the old files are
/// being deleted; the text after the code names the job.
pub const E_FORMAT_BUSY: &str = "E_FORMAT_BUSY";
/// The vault is in the asked format already and no conversion is pending.
pub const E_FORMAT_SAME: &str = "E_FORMAT_SAME";
/// No conversion to pause, resume or cancel.
pub const E_FORMAT_NOT_FOUND: &str = "E_FORMAT_NOT_FOUND";
/// The conversion's journal, marker or thread could not be written or
/// started. The cause is logged here; the app shows a catalog sentence.
pub const E_FORMAT_IO: &str = "E_FORMAT_IO";
/// The blob sweep could not run to its end.
pub const E_FORMAT_RECLAIM_FAILED: &str = "E_FORMAT_RECLAIM_FAILED";
/// Some of the old files set aside could not be deleted.
pub const E_FORMAT_PURGE_FAILED: &str = "E_FORMAT_PURGE_FAILED";

/// The vault marker row naming the job of a conversion in progress: set
/// while one runs or is paused, the empty string when none is.
pub(crate) const MIGRATION_KEY: &str = "storageMigration";
/// `<vault>/retired/format-<stamp>/`: where a retire-mode conversion sets the
/// old files aside (Task 9), and what Settings sums and deletes.
pub(crate) const RETIRED_DIR: &str = "retired";
pub(crate) const RETIRED_PREFIX: &str = "format-";

const EVENT: &str = "format-migration-progress";
const JOURNAL_VERSION: u32 = 1;
const JOURNAL_DIR: &str = "format_migrations";
/// Unreferenced blobs younger than this survive a sweep (`sweep_blobs`).
const SWEEP_GRACE: Duration = Duration::from_secs(24 * 3600);
/// Between two changes of state, at most four progress events a second.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

const RUNNING: &str = "running";
const PAUSED: &str = "paused";
const DONE: &str = "done";
const FAILED: &str = "failed";
const CANCELLED: &str = "cancelled";

/// What happens to a message's old file once its new one is verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OldFiles {
    /// Set aside under `retired/format-<stamp>/` (the default the app offers).
    Retire,
    /// Deleted, only after the new file verified.
    Delete,
}

/// One mailbox of the conversion and how far it got (`pending`, `done`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailboxPlan {
    pub account: String,
    pub dir: String,
    pub state: String,
}

/// A message the conversion left in its old format, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    pub account: String,
    pub dir: String,
    pub uid: u32,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journal {
    pub version: u32,
    pub job_id: String,
    /// The vault root the conversion belongs to.
    pub vault: String,
    pub to: message_store::Format,
    pub old_files: OldFiles,
    /// Local time of the start, `YYYYMMDD-HHMMSS`: names `retired/format-<stamp>/`.
    pub stamp: String,
    /// Filled by the conversion (Task 9); empty until it plans.
    #[serde(default)]
    pub mailboxes: Vec<MailboxPlan>,
    pub done: u64,
    pub total: u64,
    #[serde(default)]
    pub failed: Vec<Failure>,
    /// `running` (a live worker, or one a quit or a crash cut off), `paused`,
    /// `cancelled` or `failed`. A done job has no journal.
    pub state: String,
    /// Why a failed job stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: u64,
}

/// What the routes ask of a live worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ctl {
    Run,
    Pause,
    Cancel,
    /// The worker is ending: every control answers false from here on.
    Ending,
}

/// How a run of the conversion ended.
// Task 8's stub only ever ends cancelled; Task 9's conversion returns the
// other two.
#[allow(dead_code)]
enum Ended {
    Done,
    Cancelled,
    Failed(String),
}

/// A live job: running, or held by a pause.
pub(crate) struct Job {
    id: String,
    ctl: Mutex<Ctl>,
    wake: Condvar,
    /// Its latest progress: what `storage_format_get` answers for it.
    view: Mutex<Value>,
    /// `Runner::finish` ran. A worker that ends without it panicked.
    finished: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Job {
    fn new(id: &str, view: Value) -> Self {
        Job {
            id: id.to_string(),
            ctl: Mutex::new(Ctl::Run),
            wake: Condvar::new(),
            view: Mutex::new(view),
            finished: AtomicBool::new(false),
        }
    }

    fn ctl(&self) -> Ctl {
        *lock(&self.ctl)
    }

    /// Pause only a running job and resume only a held one; a cancel stops
    /// either. False when it changed nothing.
    fn request(&self, want: Ctl) -> bool {
        let mut ctl = lock(&self.ctl);
        let next = match (*ctl, want) {
            (Ctl::Run, Ctl::Pause) => Ctl::Pause,
            (Ctl::Pause, Ctl::Run) => Ctl::Run,
            (Ctl::Run | Ctl::Pause, Ctl::Cancel) => Ctl::Cancel,
            (now, _) => now,
        };
        let changed = next != *ctl;
        *ctl = next;
        self.wake.notify_all();
        changed
    }

    /// The worker starts ending.
    fn end(&self) {
        *lock(&self.ctl) = Ctl::Ending;
        self.wake.notify_all();
    }

    /// Waits for as long as the job is asked to keep running.
    fn wait_while_running(&self) {
        let mut ctl = lock(&self.ctl);
        while *ctl == Ctl::Run {
            ctl = self.wake.wait(ctl).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Waits for as long as the job is held; then what it was asked.
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

/// The vault's live conversion, at most one.
#[derive(Default)]
pub(crate) struct Migrations {
    live: Mutex<Option<Arc<Job>>>,
    /// The old files are being deleted (`purge_retired`): no job may start,
    /// since a new one would set its own aside in the same place.
    purging: AtomicBool,
}

impl Migrations {
    fn lock(&self) -> MutexGuard<'_, Option<Arc<Job>>> {
        lock(&self.live)
    }

    fn live(&self) -> Option<Arc<Job>> {
        self.lock().clone()
    }
}

/// Logs the cause and answers a stable code: what the app shows is a catalog
/// sentence for the code, never this process's English or a path.
fn failed(code: &str, what: &str, cause: impl std::fmt::Display) -> String {
    warn!("[format_migration] {what}: {cause}");
    format!("{code}: see the daemon log")
}

fn busy(job_id: &str) -> String {
    format!("{E_FORMAT_BUSY}: {job_id}")
}

fn not_found() -> String {
    format!("{E_FORMAT_NOT_FOUND}: no conversion to steer")
}

/// Only this job's entry: a newer job is never touched.
fn unregister(state: &DaemonState, job: &Arc<Job>) {
    let mut live = state.format_migration.lock();
    if live.as_ref().is_some_and(|j| Arc::ptr_eq(j, job)) {
        *live = None;
    }
}

/// Unregisters its job when the worker thread ends, however it ends. A
/// worker that never reached `finish` (a panic) leaves its journal at the
/// last checkpoint, which reads as paused and resumes, and a last event that
/// says so.
struct Registered(Arc<DaemonState>, Arc<Job>);

impl Drop for Registered {
    fn drop(&mut self) {
        let (state, job) = (&self.0, &self.1);
        unregister(state, job);
        if !job.finished.load(Ordering::SeqCst) {
            warn!("[format_migration] job {} stopped unexpectedly; its journal stays resumable", job.id);
            let mut last = job.view();
            if last.is_object() {
                last["active"] = json!(false);
                last["state"] = json!(PAUSED);
                *lock(&job.view) = last.clone();
                state.events.emit(EVENT, last);
            }
        }
    }
}

// ── the journal ─────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A job id names files: only what `uuid` writes gets through.
fn is_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn journal_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(JOURNAL_DIR)
}

fn journal_path(app_dir: &Path, id: &str) -> PathBuf {
    journal_dir(app_dir).join(format!("{id}.json"))
}

fn write_journal(app_dir: &Path, journal: &Journal) -> Result<(), String> {
    std::fs::create_dir_all(journal_dir(app_dir)).map_err(|e| format!("Failed to create the conversion journal dir: {e}"))?;
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    mailvault_core::fsx::write_atomic(&journal_path(app_dir, &journal.job_id), &bytes)
        .map_err(|e| format!("Failed to write the conversion journal: {e}"))
}

/// `None` for a journal this build cannot read (another version) or none.
fn read_journal(app_dir: &Path, id: &str) -> Option<Journal> {
    let raw = std::fs::read(journal_path(app_dir, id)).ok()?;
    serde_json::from_slice::<Journal>(&raw).ok().filter(|j| j.version == JOURNAL_VERSION && j.job_id == id)
}

fn remove_journal(app_dir: &Path, id: &str) {
    if let Err(e) = std::fs::remove_file(journal_path(app_dir, id)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!("[format_migration] job {id}: its journal was not removed: {e}");
        }
    }
}

/// This vault's journal of a conversion that is not done: the newest one,
/// should a crash between two writes have left two. An atomic write's temp
/// file starts with a dot and never ends in `.json`, so it is never one.
fn pending_journal(app_dir: &Path, root: &Path) -> Option<Journal> {
    let vault = root.to_string_lossy();
    std::fs::read_dir(journal_dir(app_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").filter(|id| is_job_id(id)).map(str::to_string))
        .filter_map(|id| read_journal(app_dir, &id))
        .filter(|j| j.vault == vault && j.state != DONE)
        .max_by_key(|j| j.updated_at)
}

/// The `migration` object: `storage_format_get`'s and every progress event's.
fn view(j: &Journal, active: bool, state: &str) -> Value {
    json!({
        "jobId": j.job_id,
        "to": j.to,
        "oldFiles": j.old_files,
        "state": state,
        "active": active,
        "done": j.done,
        "total": j.total,
        "failed": j.failed.len(),
        "error": j.error,
    })
}

/// A journal with no live worker. One a quit or a crash cut off reads as
/// paused: it resumes, or cancels.
fn stopped_view(j: &Journal) -> Value {
    let state = if j.state == RUNNING { PAUSED } else { j.state.as_str() };
    view(j, false, state)
}

/// The vault names the job as in progress, then takes the target format.
/// That order matters: if the second write fails, the first is taken back
/// and the vault is as it was. The other way round, a failed second write
/// left the vault flipped with no job and no journal, and a retry answered
/// `E_FORMAT_SAME`.
fn mark_started(root: &Path, j: &Journal) -> Result<(), String> {
    mailvault_core::vault_layout::write_marker_value(root, MIGRATION_KEY, &j.job_id)?;
    if let Err(e) = message_store::set_vault_format(root, j.to) {
        if let Err(undo) = mark_stopped(root) {
            warn!("[format_migration] job {}: the job row was not taken back: {undo}", j.job_id);
        }
        return Err(e);
    }
    Ok(())
}

fn mark_stopped(root: &Path) -> Result<(), String> {
    mailvault_core::vault_layout::write_marker_value(root, MIGRATION_KEY, "")
}

// ── what the routes call ────────────────────────────────────────────────────

/// `storage_format_get`: the vault's format, and its conversion when one is
/// live or stopped short (`null` when none).
pub(crate) fn get(state: &DaemonState, root: &Path) -> Value {
    let format = message_store::vault_format(root);
    let migration = match state.format_migration.live() {
        Some(job) => job.view(),
        None => pending_journal(&state.app_dir, root).map_or(Value::Null, |j| stopped_view(&j)),
    };
    json!({"format": format, "migration": migration})
}

/// Refuses a start the vault cannot take. Task 9's retire-mode space check
/// answers `E_FORMAT_NO_SPACE: <bytes to free>`, digits only after the code
/// (the app formats them). Task 8: every start passes.
fn precheck(_root: &Path, _to: message_store::Format, _old_files: OldFiles) -> Result<(), String> {
    Ok(())
}

/// `storage_format_convert`: a new job toward `to`. It replaces the vault's
/// stopped one, if any ("Convert back" is a new job the other way).
pub(crate) fn start(state: &Arc<DaemonState>, root: &Path, to: message_store::Format, old_files: OldFiles) -> Result<Value, String> {
    let mut live = state.format_migration.lock();
    if let Some(job) = live.as_ref() {
        return Err(busy(&job.id));
    }
    if state.format_migration.purging.load(Ordering::SeqCst) {
        return Err(busy("purge"));
    }
    let stopped = pending_journal(&state.app_dir, root);
    if message_store::vault_format(root) == to && stopped.is_none() {
        return Err(format!("{E_FORMAT_SAME}: the vault is in this format already"));
    }
    precheck(root, to, old_files)?;
    let journal = Journal {
        version: JOURNAL_VERSION,
        job_id: uuid::Uuid::new_v4().to_string(),
        vault: root.to_string_lossy().into_owned(),
        to,
        old_files,
        stamp: chrono::Local::now().format("%Y%m%d-%H%M%S").to_string(),
        mailboxes: Vec::new(),
        done: 0,
        total: 0,
        failed: Vec::new(),
        state: RUNNING.to_string(),
        error: None,
        updated_at: now_ms(),
    };
    write_journal(&state.app_dir, &journal).map_err(|e| failed(E_FORMAT_IO, "the journal was not written", e))?;
    if let Err(e) = mark_started(root, &journal) {
        remove_journal(&state.app_dir, &journal.job_id);
        return Err(failed(E_FORMAT_IO, "the marker was not written", e));
    }
    if let Some(old) = stopped {
        remove_journal(&state.app_dir, &old.job_id);
    }
    let id = journal.job_id.clone();
    info!("[format_migration] job {id}: converting to {to:?}, old files {old_files:?}");
    spawn(state, &mut live, root, journal)?;
    Ok(json!({"jobId": id}))
}

/// `storage_format_pause`: holds a running job where it stands.
pub(crate) fn pause(state: &DaemonState, root: &Path) -> Result<Value, String> {
    let live = state.format_migration.lock();
    if let Some(job) = live.as_ref() {
        return Ok(json!({"jobId": job.id, "paused": job.request(Ctl::Pause)}));
    }
    match pending_journal(&state.app_dir, root) {
        Some(j) => Ok(json!({"jobId": j.job_id, "paused": false})),
        None => Err(not_found()),
    }
}

/// `storage_format_resume`: wakes a held job, or starts the stopped one again
/// from its journal, toward the same format.
pub(crate) fn resume(state: &Arc<DaemonState>, root: &Path) -> Result<Value, String> {
    let mut live = state.format_migration.lock();
    if let Some(job) = live.as_ref() {
        return Ok(json!({"jobId": job.id, "resumed": job.request(Ctl::Run)}));
    }
    if state.format_migration.purging.load(Ordering::SeqCst) {
        return Err(busy("purge"));
    }
    let Some(mut journal) = pending_journal(&state.app_dir, root) else {
        return Err(not_found());
    };
    journal.state = RUNNING.to_string();
    journal.error = None;
    journal.updated_at = now_ms();
    write_journal(&state.app_dir, &journal).map_err(|e| failed(E_FORMAT_IO, "the journal was not written", e))?;
    mark_started(root, &journal).map_err(|e| failed(E_FORMAT_IO, "the marker was not written", e))?;
    let id = journal.job_id.clone();
    info!("[format_migration] job {id}: resumed at {} of {}", journal.done, journal.total);
    spawn(state, &mut live, root, journal)?;
    Ok(json!({"jobId": id, "resumed": true}))
}

/// `storage_format_cancel`: ends the job. The vault keeps the target format.
pub(crate) fn cancel(state: &DaemonState, root: &Path) -> Result<Value, String> {
    let live = state.format_migration.lock();
    if let Some(job) = live.as_ref() {
        return Ok(json!({"jobId": job.id, "cancelled": job.request(Ctl::Cancel)}));
    }
    let Some(mut journal) = pending_journal(&state.app_dir, root) else {
        return Err(not_found());
    };
    if journal.state == RUNNING || journal.state == PAUSED {
        journal.state = CANCELLED.to_string();
        journal.updated_at = now_ms();
        write_journal(&state.app_dir, &journal).map_err(|e| failed(E_FORMAT_IO, "the journal was not written", e))?;
    }
    mark_stopped(root).map_err(|e| failed(E_FORMAT_IO, "the marker was not written", e))?;
    Ok(json!({"jobId": journal.job_id, "cancelled": true}))
}

/// Every `retired/format-*` directory: real directories only, never a link.
fn retired_dirs(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join(RETIRED_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(RETIRED_PREFIX))
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect()
}

/// Adds the bytes and the files under `dir`, never following a link.
fn tally(dir: &Path, bytes: &mut u64, count: &mut u64) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            tally(&entry.path(), bytes, count);
        } else if kind.is_file() {
            if let Ok(meta) = entry.metadata() {
                *bytes += meta.len();
                *count += 1;
            }
        }
    }
}

/// `storage_format_retired`: what the conversions set aside.
pub(crate) fn retired(root: &Path) -> Value {
    let (mut bytes, mut count) = (0u64, 0u64);
    for dir in retired_dirs(root) {
        tally(&dir, &mut bytes, &mut count);
    }
    json!({"bytes": bytes, "count": count})
}

/// Clears `purging` however the purge ends.
struct Purging<'a>(&'a AtomicBool);

impl Drop for Purging<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `storage_format_purge_retired`: deletes every `retired/format-*`
/// directory, a permanent action the app confirms with the size first.
/// Refused while a job runs: a retire-mode job is writing there. The registry
/// lock is not held while files go, so Settings can still read the state.
pub(crate) fn purge_retired(state: &DaemonState, root: &Path) -> Result<Value, String> {
    let _purging = {
        let live = state.format_migration.lock();
        if let Some(job) = live.as_ref() {
            return Err(busy(&job.id));
        }
        if state.format_migration.purging.swap(true, Ordering::SeqCst) {
            return Err(busy("purge"));
        }
        Purging(&state.format_migration.purging)
    };
    let (mut bytes, mut count) = (0u64, 0u64);
    for dir in retired_dirs(root) {
        let (mut b, mut c) = (0u64, 0u64);
        tally(&dir, &mut b, &mut c);
        std::fs::remove_dir_all(&dir)
            .map_err(|e| failed(E_FORMAT_PURGE_FAILED, "an old files directory was not deleted", format!("{}: {e}", dir.display())))?;
        bytes += b;
        count += c;
    }
    // Only when nothing else is left in it.
    let _ = std::fs::remove_dir(root.join(RETIRED_DIR));
    info!("[format_migration] deleted {count} old file(s) set aside, {bytes} bytes");
    Ok(json!({"bytes": bytes, "count": count}))
}

/// `storage_reclaim_space`: a blob sweep with the usual grace. Refused while
/// a job runs; the job sweeps at its own end.
pub(crate) fn reclaim(state: &DaemonState, root: &Path) -> Result<Value, String> {
    if let Some(job) = state.format_migration.live() {
        return Err(busy(&job.id));
    }
    let swept = message_store::sweep_blobs(root, SWEEP_GRACE).map_err(|e| failed(E_FORMAT_RECLAIM_FAILED, "the blob sweep stopped", e))?;
    info!("[format_migration] reclaim: {} blob(s) removed, {} bytes", swept.removed, swept.freed_bytes);
    Ok(json!({"removed": swept.removed, "bytes": swept.freed_bytes}))
}

// ── the worker ──────────────────────────────────────────────────────────────

/// Starts the worker of `journal` and registers it as the vault's live job.
/// The caller holds the registry lock, so the worker cannot unregister before
/// it is registered.
fn spawn(state: &Arc<DaemonState>, live: &mut Option<Arc<Job>>, root: &Path, journal: Journal) -> Result<(), String> {
    let job = Arc::new(Job::new(&journal.job_id, view(&journal, true, RUNNING)));
    let runner = Runner { state: Arc::clone(state), root: root.to_path_buf(), job: Arc::clone(&job), journal, emitted: None };
    std::thread::Builder::new()
        .name("format-migration".into())
        .spawn(move || {
            crate::mbox_upload_job::background_qos();
            let _registered = Registered(Arc::clone(&runner.state), Arc::clone(&runner.job));
            runner.run();
        })
        .map_err(|e| failed(E_FORMAT_IO, "the worker thread did not start", e))?;
    *live = Some(job);
    Ok(())
}

/// One run of a job, on its own thread. Task 9's conversion works through it:
/// `journal` holds the counters, `checkpoint` writes them, `progress` reports
/// them, and `between_messages` takes a pause or a cancel.
struct Runner {
    state: Arc<DaemonState>,
    root: PathBuf,
    job: Arc<Job>,
    journal: Journal,
    emitted: Option<Instant>,
}

impl Runner {
    fn run(mut self) {
        self.progress(RUNNING, true, true);
        let ended = convert(&mut self);
        self.finish(ended);
    }

    /// Writes the journal now.
    fn checkpoint(&mut self) {
        self.journal.updated_at = now_ms();
        if let Err(e) = write_journal(&self.state.app_dir, &self.journal) {
            warn!("[format_migration] job {}: {e}", self.journal.job_id);
        }
    }

    /// Reports the job: at once when `force` (a change of state), else at
    /// most every `PROGRESS_EVERY`.
    fn progress(&mut self, state: &str, active: bool, force: bool) {
        let now = Instant::now();
        if !force && self.emitted.is_some_and(|at| now.duration_since(at) < PROGRESS_EVERY) {
            return;
        }
        self.emitted = Some(now);
        let v = view(&self.journal, active, state);
        *lock(&self.job.view) = v.clone();
        self.state.events.emit(EVENT, v);
    }

    /// Asked before each message. `None` to go on: after holding here for as
    /// long as the job is paused, journaled and reported as paused. The end
    /// when the job was cancelled.
    fn between_messages(&mut self) -> Option<Ended> {
        match self.job.ctl() {
            Ctl::Run => None,
            Ctl::Cancel | Ctl::Ending => Some(Ended::Cancelled),
            Ctl::Pause => {
                self.journal.state = PAUSED.to_string();
                self.checkpoint();
                self.progress(PAUSED, true, true);
                match self.job.wait_held() {
                    Ctl::Run => {
                        self.journal.state = RUNNING.to_string();
                        self.checkpoint();
                        self.progress(RUNNING, true, true);
                        None
                    }
                    _ => Some(Ended::Cancelled),
                }
            }
        }
    }

    /// Records how the run ended. The journal and the marker come first, then
    /// the job leaves the registry, then its last event: by the time anyone
    /// sees the end, `storage_format_get` reads it from the journal and a new
    /// start is not refused as busy.
    fn finish(&mut self, ended: Ended) {
        self.job.end();
        let state = match &ended {
            Ended::Done => DONE,
            Ended::Cancelled => CANCELLED,
            Ended::Failed(_) => FAILED,
        };
        self.journal.state = state.to_string();
        if let Ended::Failed(reason) = &ended {
            self.journal.error = Some(reason.clone());
        }
        if let Err(e) = mark_stopped(&self.root) {
            warn!("[format_migration] job {}: the marker was not cleared: {e}", self.journal.job_id);
        }
        if matches!(ended, Ended::Done) {
            remove_journal(&self.state.app_dir, &self.journal.job_id);
        } else {
            self.checkpoint();
        }
        self.job.finished.store(true, Ordering::SeqCst);
        unregister(&self.state, &self.job);
        self.progress(state, false, true);
        info!("[format_migration] job {}: {state} at {} of {}", self.journal.job_id, self.journal.done, self.journal.total);
    }
}

/// The conversion. Task 9 replaces this body with the conversion loop: plan
/// the mailboxes into `journal`, then per message call `between_messages`,
/// prepare outside the lock, commit under `with_mailbox_write`, count into
/// `journal`, `checkpoint` every 200 and `progress` as it goes; sweep at the
/// end and return `Done`, or `Failed` on ENOSPC or EIO.
///
/// Task 8 stub: converts nothing. The job holds at 0 of 0 until it is paused
/// (it holds in `between_messages`, and a resume comes back here) or
/// cancelled.
fn convert(runner: &mut Runner) -> Ended {
    loop {
        runner.job.wait_while_running();
        if let Some(ended) = runner.between_messages() {
            return ended;
        }
    }
}
