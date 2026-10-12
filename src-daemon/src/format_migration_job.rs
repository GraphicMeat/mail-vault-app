//! The storage format conversion as a job (Plan B, Tasks 8 and 9): the one
//! conversion a vault can have at a time, its journal, its controls and its
//! progress (Task 8), and the conversion itself (Task 9, `convert`): every
//! message of the vault moved into the target format one at a time, its old
//! file kept aside or deleted only once the new copy verified.
//!
//! - **Markers.** A start (and a resume) writes the vault marker's
//!   `storageFormat` row, the target: from then on every writer writes the
//!   target format, and readers read both. It also writes `storageMigration`,
//!   the job id. That row is set while a job runs or is paused, and emptied
//!   when the job ends (done, cancelled or failed). A vault move is refused
//!   while a job runs or is paused (`move_blocker`), never by the row alone.
//! - **Journal.** `<app data>/format_migrations/<jobId>.json`, written
//!   atomically. It names the vault it belongs to, so a journal another vault
//!   left is never shown. A done job's journal is removed. A cancelled or
//!   failed one stays, so Settings can offer Resume and Convert back, until
//!   the next conversion of the vault replaces it; a vault move takes it
//!   along (`follow_move`).
//! - **Control.** Pause holds the worker where it stands, and resume wakes
//!   it. With no live worker (after a restart, a cancel or a failure), resume
//!   starts a new one from the journal. Cancel ends the worker. Nothing is
//!   rolled back: the vault stays in the target format, mixed and readable.
//! - **Worker.** One OS thread at background QoS (`spawn`).
//! - **A vault out of reach.** While the vault is closed (`vault_close`,
//!   before a move, a portable copy or an adopt) or gone (an unmounted
//!   volume), the worker holds where it stands, journaled as running, and
//!   tries the same step again once the vault is back (`Runner::wait_for_vault`):
//!   nothing it saw meanwhile counts as a failure, a gone message or an empty
//!   folder. A held job is a live one, so a move stays refused.
//! - **Progress** is the `format-migration-progress` event: every change of
//!   state, and at most four a second in between (`Runner::progress`). Its
//!   payload is the `migration` object `storage_format_get` answers.

use crate::handlers::common::{vault_root, with_mailbox_write, with_vault_write};
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use mailvault_core::message_store;
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::{import_rehome, local_folder, vault_gap};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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
/// Keeping the old files aside needs more free space than the volume has;
/// the bytes to free follow, digits only.
pub const E_FORMAT_NO_SPACE: &str = "E_FORMAT_NO_SPACE";
/// A run ended with messages left in their old format (their new copy did
/// not verify, or two different copies of one uid in delete mode); how many
/// follows. Resume tries them again.
pub const E_FORMAT_UNVERIFIED: &str = "E_FORMAT_UNVERIFIED";
/// A run ended with folders whose first import rehome has not run yet
/// (Plan B 7b D7); how many follows. Resume tries them again.
pub const E_FORMAT_REHOME_PENDING: &str = "E_FORMAT_REHOME_PENDING";
/// The vault (or one folder or message of it) could not be read.
pub const E_FORMAT_UNREADABLE: &str = "E_FORMAT_UNREADABLE";
/// The disk refused a write (no space, a quota, an I/O error): the run stops.
pub const E_FORMAT_DISK: &str = "E_FORMAT_DISK";
/// One message's new copy did not read back as its old one.
const E_BLOB_VERIFY: &str = "E_BLOB_VERIFY";
/// One uid holds two different messages, one per format, in delete mode:
/// neither is deleted.
const E_FORMAT_CONFLICT: &str = "E_FORMAT_CONFLICT";
/// One message changed under every try to convert it.
const E_FORMAT_CHANGED: &str = "E_FORMAT_CHANGED";

/// The vault marker row naming the job of a conversion in progress: set
/// while one runs or is paused, the empty string when none is.
pub(crate) const MIGRATION_KEY: &str = message_store::MIGRATION_KEY;
/// A vault move refused while a conversion of the vault is in progress; the
/// job id follows.
pub const E_FORMAT_MOVE_BLOCKED: &str = "E_FORMAT_MOVE_BLOCKED";
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
/// The journal is written at least every this many messages.
const CHECKPOINT_EVERY: u64 = 200;
/// Tries per message whose source changes between the read and the commit.
const ATTEMPTS: usize = 3;
/// Header cache rows read per hold of its lock.
const DATES_PAGE: usize = 2000;
/// How often a job held for the vault looks whether it is back.
const VAULT_LOOK_EVERY: Duration = Duration::from_millis(250);

const RUNNING: &str = "running";
const PAUSED: &str = "paused";
const DONE: &str = "done";
const FAILED: &str = "failed";
const CANCELLED: &str = "cancelled";

/// A mailbox's state in the journal: to do, converted, or waiting for its
/// first import rehome (D7; tried again on the next run).
const MAILBOX_PENDING: &str = "pending";
const MAILBOX_DONE: &str = "done";
const MAILBOX_WAITING: &str = "waiting";

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
    /// The worker is at a checkpoint and writes nothing more until woken:
    /// held by a pause, held for a quit, or gone.
    settled: Mutex<bool>,
    settled_wake: Condvar,
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
            settled: Mutex::new(false),
            settled_wake: Condvar::new(),
        }
    }

    fn set_settled(&self, settled: bool) {
        *lock(&self.settled) = settled;
        self.settled_wake.notify_all();
    }

    /// Waits until the worker settles, or `until`. Whether it settled.
    fn wait_settled(&self, until: Instant) -> bool {
        let mut settled = lock(&self.settled);
        while !*settled {
            let now = Instant::now();
            if now >= until {
                return false;
            }
            settled = self.settled_wake.wait_timeout(settled, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
        true
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

    /// Waits for as long as the job is asked to keep running (a test's held job).
    #[cfg_attr(not(test), allow(dead_code))]
    fn wait_while_running(&self) {
        let mut ctl = lock(&self.ctl);
        while *ctl == Ctl::Run {
            ctl = self.wake.wait(ctl).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Waits up to `limit` for the job to be asked something: what it is
    /// asked then, `Run` when nothing.
    fn wait_asked(&self, limit: Duration) -> Ctl {
        let ctl = lock(&self.ctl);
        if *ctl != Ctl::Run {
            return *ctl;
        }
        *self.wake.wait_timeout(ctl, limit).unwrap_or_else(|p| p.into_inner()).0
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
    /// The daemon is quitting (`pause_all_and_wait`): the worker stops at its
    /// next message boundary with its journal still `running`.
    quitting: AtomicBool,
    #[cfg(test)]
    pub(crate) faults: Mutex<Faults>,
}

/// Test hooks, per daemon (the worker runs on a thread of its own, so a
/// thread-local would not reach it). A message number counts the messages
/// this run has tried, from 1.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Faults {
    /// The job holds before it plans, as Task 8's stub did: for the tests that
    /// steer a job rather than convert.
    pub hold: bool,
    /// The blob write of this message fails as a full disk.
    pub put_fails_at: Option<u64>,
    /// This message's new copy fails its verify.
    pub verify_fails_at: Option<u64>,
    /// The worker panics between this message's new copy and the removal of
    /// its old one.
    pub panic_after_write_at: Option<u64>,
    /// Runs between each message's read and its commit (first try only),
    /// with the message number, the vault root, the account and mailbox
    /// directories and the uid.
    #[allow(clippy::type_complexity)]
    pub before_commit: Option<Arc<dyn Fn(u64, &Path, &str, &str, u32) + Send + Sync>>,
    /// The volume takes no hard link.
    pub no_hard_links: bool,
    /// The volume's free bytes.
    pub free_bytes: Option<u64>,
}

#[cfg(test)]
pub(crate) fn faults(state: &DaemonState) -> MutexGuard<'_, Faults> {
    lock(&state.format_migration.faults)
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
        job.set_settled(true);
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

/// The conversion that stops a move of the vault at `root`
/// (`vault_move_to`): a job live in this daemon, or this vault's journal
/// still `running` (a quit or a crash cut it off) or `paused`. A cancelled or
/// failed one does not: its vault is mixed and readable, and the journal
/// follows the move (`follow_move`). Nor does the marker's `storageMigration`
/// row alone: a row no journal here explains (another host's job on a shared
/// vault, a reset app data dir, a marker write that failed twice) would hold
/// the vault in place for good.
pub(crate) fn move_blocker(state: &DaemonState, root: &Path) -> Option<String> {
    if let Some(job) = state.format_migration.live() {
        return Some(job.id.clone());
    }
    pending_journal(&state.app_dir, root).filter(|j| j.state == RUNNING || j.state == PAUSED).map(|j| j.job_id)
}

/// A committed move of the vault from `from` to `to`: its stopped
/// conversion (`move_blocker` let no other through) now names `to`, so
/// Settings there still offers Resume and Convert back. `to` is spelled as
/// the daemon that opens the vault there spells its root (the path the app
/// saved). Best effort: a journal that will not write is logged, and the
/// vault there reads as mixed with no conversion pending.
pub(crate) fn follow_move(app_dir: &Path, from: &Path, to: &Path) {
    let Some(mut journal) = pending_journal(app_dir, from) else { return };
    journal.vault = to.to_string_lossy().into_owned();
    journal.updated_at = now_ms();
    match write_journal(app_dir, &journal) {
        Ok(()) => info!("[format_migration] job {}: its journal follows the vault to its new folder", journal.job_id),
        Err(e) => warn!("[format_migration] job {}: its journal did not follow the vault: {e}", journal.job_id),
    }
}

/// The free space a start needs: keeping the old files aside (retire mode)
/// needs room for the new copies, since no old file is freed, whether it is
/// kept by a hard link or a copy: the source bytes plus 10%. Delete mode
/// frees each old file as its new one lands: `None`. Measured before the
/// registry lock is taken: the walk stats every file (or reads every
/// record), and `storage_format_get` waits on that lock.
fn space_needed(root: &Path, to: message_store::Format, old_files: OldFiles) -> Result<Option<u64>, String> {
    if old_files != OldFiles::Retire {
        return Ok(None);
    }
    let source = message_store::stored_bytes(root, other(to)).map_err(|e| failed(E_FORMAT_IO, "the vault could not be sized", e))?;
    Ok(Some(source.saturating_add(source / 10)))
}

/// Refuses a start the volume cannot take (`space_needed`):
/// `E_FORMAT_NO_SPACE: <bytes to free>`, digits only (the app formats them).
/// A volume whose free space is unknown (Windows) is let through: a full disk
/// then stops the job as failed, with nothing lost.
fn precheck(state: &DaemonState, root: &Path, need: Option<u64>) -> Result<(), String> {
    let Some(need) = need else { return Ok(()) };
    let Some(free) = free_bytes(state, root) else { return Ok(()) };
    if free < need {
        return Err(format!("{E_FORMAT_NO_SPACE}: {}", need - free));
    }
    Ok(())
}

/// Free bytes on the vault's volume; `None` where unknown.
fn free_bytes(state: &DaemonState, root: &Path) -> Option<u64> {
    #[cfg(test)]
    if let Some(bytes) = faults(state).free_bytes {
        return Some(bytes);
    }
    let _ = state;
    crate::handlers::portable::free_bytes(root)
}

/// The other format: what a conversion toward `to` converts from.
fn other(to: message_store::Format) -> message_store::Format {
    match to {
        message_store::Format::Jmap => message_store::Format::Maildir,
        message_store::Format::Maildir => message_store::Format::Jmap,
    }
}

/// `storage_format_convert`: a new job toward `to`. It replaces the vault's
/// stopped one, if any ("Convert back" is a new job the other way).
pub(crate) fn start(state: &Arc<DaemonState>, root: &Path, to: message_store::Format, old_files: OldFiles) -> Result<Value, String> {
    // A live job refuses at once; else the vault is sized outside the lock.
    if let Some(job) = state.format_migration.live() {
        return Err(busy(&job.id));
    }
    let need = space_needed(root, to, old_files)?;
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
    precheck(state, root, need)?;
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

/// The daemon is quitting: the live conversion stops at its next message
/// boundary, its journal checkpointed and still `running`, so the next start
/// carries on (`resume_journaled`); a job held by a pause is settled already
/// and stays paused. Waits until `limit`. Whether it settled.
pub(crate) fn pause_all_and_wait(state: &DaemonState, limit: Duration) -> bool {
    state.format_migration.quitting.store(true, Ordering::SeqCst);
    let Some(job) = state.format_migration.live() else { return true };
    let settled = job.wait_settled(Instant::now() + limit);
    info!("[format_migration] quitting: job {} {}", job.id, if settled { "held at a checkpoint" } else { "still inside a message" });
    settled
}

/// At daemon start: the vault's conversion carries on when a quit or a crash
/// cut it off while it ran (its journal says `running`). One the user paused
/// or cancelled, or one that failed, waits for Settings. Blocking.
pub(crate) fn resume_journaled(state: &Arc<DaemonState>) {
    if vault_root(state).is_err() {
        return;
    }
    let resumed = with_vault_write(state, |root| match pending_journal(&state.app_dir, root) {
        Some(j) if j.state == RUNNING => resume(state, root).map(Some),
        _ => Ok(None),
    });
    match resumed {
        Ok(Some(v)) => info!("[format_migration] carried on after a restart: {v}"),
        Ok(None) => {}
        Err(e) => warn!("[format_migration] could not carry on after a restart: {e}"),
    }
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
    let runner = Runner { state: Arc::clone(state), root: root.to_path_buf(), job: Arc::clone(&job), journal, emitted: None, seen: 0, link: false };
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
    /// Messages this run has tried.
    seen: u64,
    /// Retire mode on a volume that takes hard links: old files are linked
    /// aside, not copied.
    link: bool,
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
    /// long as the job is paused (journaled and reported as paused) or the
    /// vault is closed (`hold_for_vault`). The end when the job was
    /// cancelled.
    fn between_messages(&mut self) -> Option<Ended> {
        self.steer(false)
    }

    /// Asked after a step whose result says nothing while the vault is out
    /// of reach (a failure, a message gone, an empty listing): holds until
    /// the vault is open and there again, so the caller tries the same step
    /// again. `None` at once when the vault is there; else as
    /// `between_messages`.
    fn wait_for_vault(&mut self) -> Option<Ended> {
        self.steer(true)
    }

    /// `between_messages`, and with `look` the vault is also looked at on
    /// disk (`vault_ready`).
    fn steer(&mut self, look: bool) -> Option<Ended> {
        loop {
            if self.state.format_migration.quitting.load(Ordering::SeqCst) {
                // The journal stays `running`: the next start carries on here.
                self.checkpoint();
                self.job.set_settled(true);
                info!("[format_migration] job {}: held for the quit at {} of {}", self.journal.job_id, self.journal.done, self.journal.total);
                loop {
                    std::thread::park();
                }
            }
            match self.job.ctl() {
                Ctl::Run if self.vault_ready(look) => return None,
                Ctl::Run => self.hold_for_vault(),
                Ctl::Cancel | Ctl::Ending => return Some(Ended::Cancelled),
                Ctl::Pause => {
                    self.journal.state = PAUSED.to_string();
                    self.checkpoint();
                    self.progress(PAUSED, true, true);
                    self.job.set_settled(true);
                    let ctl = self.job.wait_held();
                    self.job.set_settled(false);
                    if ctl != Ctl::Run {
                        return Some(Ended::Cancelled);
                    }
                    self.journal.state = RUNNING.to_string();
                    self.checkpoint();
                    self.progress(RUNNING, true, true);
                }
            }
        }
    }

    /// Whether the vault can be worked on: open (no `vault_close` in force)
    /// and, with `look`, still there, its marker on disk (`mark_started`
    /// wrote it). A volume that went away lists every folder as empty and
    /// reads every message as gone, and says nothing else.
    fn vault_ready(&self, look: bool) -> bool {
        vault_root(&self.state).is_ok() && (!look || self.root.join(mailvault_core::vault_layout::MARKER_FILE).is_file())
    }

    /// Holds while the vault is out of reach: journaled and reported as
    /// running at the count it reached, nothing written to the vault, and
    /// settled, so a quit does not wait for the vault. Looks every
    /// `VAULT_LOOK_EVERY`; ends when the vault is back or the job is asked
    /// something (a pause, a cancel). A quit holds it here for good, as at a
    /// message boundary.
    fn hold_for_vault(&mut self) {
        self.checkpoint();
        self.progress(RUNNING, true, true);
        self.job.set_settled(true);
        info!("[format_migration] job {}: the vault is out of reach; holding at {} of {}", self.journal.job_id, self.journal.done, self.journal.total);
        loop {
            if self.state.format_migration.quitting.load(Ordering::SeqCst) {
                loop {
                    std::thread::park();
                }
            }
            if self.job.wait_asked(VAULT_LOOK_EVERY) != Ctl::Run || self.vault_ready(true) {
                break;
            }
        }
        // Unsettled before `steer` looks at the quit flag again: a quit that
        // saw the job settled is seen there, and it settles again.
        self.job.set_settled(false);
        info!("[format_migration] job {}: carries on", self.journal.job_id);
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
        // Through the gate: a job cancelled while held for the vault never
        // writes into a closed one. The row left names a job that is no
        // longer in progress; the next start or resume writes it again.
        if let Err(e) = with_vault_write(&self.state, mark_stopped) {
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

// ── the conversion ──────────────────────────────────────────────────────────

/// The conversion: every mailbox of the vault, every uid its old format
/// holds, one message at a time (`Runner::convert_message`). The journal
/// keeps each mailbox's state, so a resumed run skips the mailboxes done and
/// finds the uids left by listing the old format again. At the end, a blob
/// sweep with the usual grace (`SWEEP_GRACE`) under the vault gate's shared
/// side. A run that left messages or folders behind ends failed, with the
/// journal kept for Resume; nothing of theirs was deleted.
fn convert(runner: &mut Runner) -> Ended {
    #[cfg(test)]
    if faults(&runner.state).hold {
        loop {
            runner.job.wait_while_running();
            if let Some(ended) = runner.between_messages() {
                return ended;
            }
        }
    }
    loop {
        match runner.plan() {
            Ok(()) => break,
            // A listing the vault was out of reach for: once it is back, again.
            Err(_) if !runner.vault_ready(true) => {
                if let Some(ended) = runner.wait_for_vault() {
                    return ended;
                }
            }
            // Already a code (`failed`): the cause is in the log.
            Err(e) => return Ended::Failed(e),
        }
    }
    runner.link = runner.journal.old_files == OldFiles::Retire && hard_links_work(&runner.state, &runner.root);
    for i in 0..runner.journal.mailboxes.len() {
        if runner.journal.mailboxes[i].state == MAILBOX_DONE {
            continue;
        }
        let (account, dir) = (runner.journal.mailboxes[i].account.clone(), runner.journal.mailboxes[i].dir.clone());
        let state = match runner.convert_mailbox(&account, &dir) {
            Ok(state) => state,
            Err(ended) => return ended,
        };
        // A mailbox with messages left behind is tried again on Resume.
        let left = runner.journal.failed.iter().any(|f| f.account == account && f.dir == dir);
        let state = if state == MAILBOX_DONE && left { MAILBOX_PENDING } else { state };
        runner.journal.mailboxes[i].state = state.to_string();
        if state != MAILBOX_WAITING {
            // Every row was upserted as it went; a relist settles the rest.
            if vault_dir_name(&dir) == dir {
                runner.state.vault_registry.invalidate(&account, &dir);
            } else {
                runner.state.vault_registry.invalidate_all();
            }
        }
        runner.checkpoint();
    }
    // The sweep and the end's marker write want the vault there.
    if let Some(ended) = runner.wait_for_vault() {
        return ended;
    }
    match with_vault_write(&runner.state, |root| message_store::sweep_blobs(root, SWEEP_GRACE)) {
        Ok(swept) => info!("[format_migration] job {}: swept {} blob(s), {} bytes", runner.journal.job_id, swept.removed, swept.freed_bytes),
        Err(e) => warn!("[format_migration] job {}: the blob sweep did not run: {e}", runner.journal.job_id),
    }
    let waiting = runner.journal.mailboxes.iter().filter(|m| m.state == MAILBOX_WAITING).count();
    if waiting > 0 {
        return Ended::Failed(format!("{E_FORMAT_REHOME_PENDING}: {waiting}"));
    }
    if !runner.journal.failed.is_empty() {
        return Ended::Failed(format!("{E_FORMAT_UNVERIFIED}: {}", runner.journal.failed.len()));
    }
    Ended::Done
}

/// How one message's conversion came out.
enum Outcome {
    /// Its old copy is gone (or set aside), its new one verified.
    Converted,
    /// It was no longer there in the old format.
    Gone,
    /// Left as it was; the reason goes in the journal.
    Failed(String),
    /// The disk refused a write (`message_store::E_DISK`): the job stops.
    Stop(String),
}

/// What one try of a commit came to.
enum Step {
    Done(Outcome),
    /// The source changed since it was read: read it again.
    Changed,
}

/// A store error, as a message's outcome: the disk's own stops the job.
fn outcome_of(e: String) -> Outcome {
    if e.starts_with(message_store::E_DISK) { Outcome::Stop(e) } else { Outcome::Failed(e) }
}

/// Where retire mode keeps a mailbox's old files:
/// `<vault>/retired/format-<stamp>/<account>/<dir>`.
/// The folder `dir` of `account` (both on-disk names) in the vault `root`,
/// addressed by its directory as it is on disk: a name that does not survive
/// `vault_dir_name` (an NFD name read back from an HFS+ or SMB volume) is
/// still the folder it is.
fn folder_of(root: &Path, account: &str, dir: &str) -> PathBuf {
    message_store::mailbox_dir_at(&root.join("Maildir"), account, dir)
}

fn retired_dir(root: &Path, stamp: &str, account: &str, dir: &str) -> PathBuf {
    root.join(RETIRED_DIR).join(format!("{RETIRED_PREFIX}{stamp}")).join(account).join(dir)
}

/// Whether the vault's volume takes hard links: one probe under `retired/`.
fn hard_links_work(state: &DaemonState, root: &Path) -> bool {
    #[cfg(test)]
    if faults(state).no_hard_links {
        return false;
    }
    let _ = state;
    let dir = root.join(RETIRED_DIR);
    let probe = dir.join(format!(".link-probe-{}", uuid::Uuid::new_v4()));
    let linked = probe.with_extension("linked");
    let works = std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&probe, b"").is_ok() && std::fs::hard_link(&probe, &linked).is_ok();
    let _ = std::fs::remove_file(&probe);
    let _ = std::fs::remove_file(&linked);
    works
}

/// The header cache's mailboxes this vault folder holds (each one's
/// `vault_dir_name` is `dir`): the server's names for it. `None` when the
/// header cache does not answer.
fn server_mailboxes(state: &DaemonState, account: &str, dir: &str) -> Option<Vec<String>> {
    let all = crate::custody::with_conn(state, |c| cache::mailboxes_with_headers(c, Some(account))).ok()?;
    let vault_dir = mailvault_core::search_index::text::vault_dir_name;
    Some(all.into_iter().map(|(_, mailbox)| mailbox).filter(|mailbox| vault_dir(mailbox) == dir).collect())
}

/// Each cached uid's INTERNALDATE in these server mailboxes, as a record's
/// `receivedAt` (UTC, seconds, `Z`). Read a page per hold of the header
/// cache's lock, before the folder's messages and never inside a mailbox
/// lock (M9). A row whose date will not read gives none.
fn received_dates(state: &DaemonState, account: &str, mailboxes: &[String]) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for mailbox in mailboxes {
        let mut after = None;
        while let Ok(page) = crate::custody::with_conn(state, |c| vault_gap::dated_page(c, account, mailbox, after, DATES_PAGE)) {
            let full = page.len() == DATES_PAGE;
            after = page.last().map(|row| row.0);
            for (uid, _, internal) in page {
                if let Some(at) = internal.as_deref().and_then(utc_stamp) {
                    out.entry(uid).or_insert(at);
                }
            }
            if !full {
                break;
            }
        }
    }
    out
}

/// An RFC 3339 or RFC 2822 date as UTC seconds with a `Z`.
fn utc_stamp(text: &str) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(text).or_else(|_| chrono::DateTime::parse_from_rfc2822(text)).ok()?;
    Some(at.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Whether a folder may go into records (Plan B 7b D7): the import rehome
/// renames Maildir files only, so a folder converts once its first pass is
/// done (its stamp). A vault-only folder has no pass, nor does one the header
/// cache holds nothing of (no server view to sort it by, now or later from
/// this cache). Otherwise the pass runs now; a folder it cannot finish yet
/// (its header cache is not whole) waits.
fn rehome_done(state: &Arc<DaemonState>, root: &Path, account: &str, dir: &str, servers: Option<&[String]>) -> bool {
    let folder = message_store::mailbox_dir_at(&root.join("Maildir"), account, dir);
    let stamped = || folder.join(import_rehome::DONE_FILE).exists();
    if stamped() {
        return true;
    }
    if folder.parent().is_some_and(|account_dir| matches!(local_folder::read_marker(account_dir, dir), Ok(Some(_)))) {
        return true;
    }
    let Some(servers) = servers else { return false };
    if servers.is_empty() {
        return true;
    }
    for mailbox in servers {
        if let Err(e) = crate::handlers::custody::rehome_imports_for(state, account, mailbox) {
            warn!("[format_migration] {account}/{dir}: the import rehome did not run: {e}");
        }
    }
    stamped()
}

impl Runner {
    /// Lists the vault's mailboxes into the journal (a resumed run keeps the
    /// ones done) and counts what is left in the old format:
    /// `total = done + left`. A resumed run counts as done what a crash cut
    /// off after its last checkpoint (`total - left`).
    fn plan(&mut self) -> Result<(), String> {
        let from = other(self.journal.to);
        let unreadable = |e: String| failed(E_FORMAT_UNREADABLE, "the vault could not be listed", e);
        let listed = with_vault_write(&self.state, |root| message_store::mailbox_dirs(root).map_err(|e| e.to_string())).map_err(unreadable)?;
        let mut plans = Vec::new();
        let mut left = 0u64;
        for (account, dir) in listed {
            let done = self.journal.mailboxes.iter().any(|m| m.account == account && m.dir == dir && m.state == MAILBOX_DONE);
            if !done {
                let uids = with_vault_write(&self.state, |root| {
                    message_store::uids_in_format_at(&folder_of(root, &account, &dir), from).map_err(|e| format!("{account}/{dir}: {e}"))
                })
                .map_err(unreadable)?;
                left += uids.len() as u64;
            }
            plans.push(MailboxPlan { account, dir, state: if done { MAILBOX_DONE } else { MAILBOX_PENDING }.to_string() });
        }
        // A vault that went away lists as empty: that plan is never kept.
        if !self.vault_ready(true) {
            return Err(failed(E_FORMAT_UNREADABLE, "the vault was out of reach while it was listed", "held until it is back"));
        }
        if !self.journal.mailboxes.is_empty() {
            self.journal.done = self.journal.done.max(self.journal.total.saturating_sub(left));
        }
        self.journal.mailboxes = plans;
        self.journal.failed.clear();
        self.journal.total = self.journal.done + left;
        self.checkpoint();
        self.progress(RUNNING, true, true);
        Ok(())
    }

    /// Converts one mailbox (`account`, `dir`: its on-disk names): every uid
    /// its old format holds, then a listing again for what arrived meanwhile
    /// (a writer that still had the old format, a rename), until only this
    /// run's failures are left. Its state for the journal, or the end of the
    /// run.
    fn convert_mailbox(&mut self, account: &str, dir: &str) -> Result<&'static str, Ended> {
        let to = self.journal.to;
        let from = other(to);
        // The header cache is the custody store's, which a closed vault
        // closes: what it answered then (no server view, no dates) is asked
        // again once the vault is back.
        let dates = loop {
            let servers = server_mailboxes(&self.state, account, dir);
            let ready = to != message_store::Format::Jmap || rehome_done(&self.state, &self.root, account, dir, servers.as_deref());
            let dates = if ready { servers.as_deref().map(|names| received_dates(&self.state, account, names)).unwrap_or_default() } else { HashMap::new() };
            if self.vault_ready(true) {
                if !ready {
                    info!("[format_migration] {account}/{dir}: waits for its first import rehome");
                    return Ok(MAILBOX_WAITING);
                }
                break dates;
            }
            if let Some(ended) = self.wait_for_vault() {
                return Err(ended);
            }
        };
        let mut skip: HashSet<u32> = HashSet::new();
        let mut first = true;
        loop {
            let listed = with_vault_write(&self.state, |root| {
                message_store::uids_in_format_at(&folder_of(root, account, dir), from).map_err(|e| format!("{account}/{dir}: {e}"))
            });
            // A listing the vault was out of reach for: once it is back, again.
            if !self.vault_ready(true) {
                if let Some(ended) = self.wait_for_vault() {
                    return Err(ended);
                }
                continue;
            }
            let listed = listed.map_err(|e| Ended::Failed(failed(E_FORMAT_UNREADABLE, "a folder could not be listed", e)))?;
            let pending: Vec<u32> = listed.into_iter().filter(|uid| !skip.contains(uid)).collect();
            if pending.is_empty() {
                return Ok(MAILBOX_DONE);
            }
            if !first {
                self.journal.total += pending.len() as u64;
            }
            first = false;
            for uid in pending {
                self.seen += 1;
                skip.insert(uid);
                let outcome = loop {
                    if let Some(ended) = self.between_messages() {
                        return Err(ended);
                    }
                    crate::search_index::yield_to_foreground(&self.state.search_index);
                    let outcome = self.convert_message(account, dir, uid, dates.get(&uid).map(String::as_str));
                    // Short of converted while the vault was out of reach, the
                    // outcome says nothing: the same message once it is back.
                    if matches!(outcome, Outcome::Converted) || self.vault_ready(true) {
                        break outcome;
                    }
                    if let Some(ended) = self.wait_for_vault() {
                        return Err(ended);
                    }
                };
                match outcome {
                    Outcome::Converted => {
                        self.journal.done += 1;
                        self.journal.total = self.journal.total.max(self.journal.done);
                        self.journal.failed.retain(|f| !(f.account == account && f.dir == dir && f.uid == uid));
                    }
                    Outcome::Gone => self.journal.total = self.journal.total.saturating_sub(1).max(self.journal.done),
                    Outcome::Failed(reason) => self.fail(account, dir, uid, reason),
                    Outcome::Stop(reason) => return Err(Ended::Failed(failed(E_FORMAT_DISK, "the disk refused a write", reason))),
                }
                if self.seen.is_multiple_of(CHECKPOINT_EVERY) {
                    self.checkpoint();
                }
                self.progress(RUNNING, true, false);
            }
        }
    }

    /// Records `uid` as left in its old format, once.
    fn fail(&mut self, account: &str, dir: &str, uid: u32, reason: String) {
        warn!("[format_migration] {account}/{dir} uid {uid} left as it was: {reason}");
        self.journal.failed.retain(|f| !(f.account == account && f.dir == dir && f.uid == uid));
        self.journal.failed.push(Failure { account: account.to_string(), dir: dir.to_string(), uid, reason });
    }

    /// One message. Outside the mailbox lock: the read, the hash, the record
    /// build and the blob write (`message_store::read_held`, `prepare`), under
    /// the vault gate's shared side. Then the commit under
    /// `with_mailbox_write`, held for this message only (`commit_message`). A
    /// source that changed in between is read again.
    fn convert_message(&self, account: &str, mailbox: &str, uid: u32, received_at: Option<&str>) -> Outcome {
        let to = self.journal.to;
        let from = other(to);
        for attempt in 0..ATTEMPTS {
            let read = with_vault_write(&self.state, |root| {
                let folder = folder_of(root, account, mailbox);
                let Some((seen, raw)) = message_store::read_held_at(root, &folder, uid, from).map_err(|e| match e.kind() {
                    std::io::ErrorKind::InvalidData => format!("{E_BLOB_VERIFY}: {e}"),
                    _ => format!("{E_FORMAT_UNREADABLE}: could not read uid {uid}: {e}"),
                })?
                else {
                    return Ok(None);
                };
                // A record already there (a crash between a write and a
                // removal, a writer of the new format) stays as it is.
                if to == message_store::Format::Jmap && message_store::held_at(&folder, uid, to).is_some() {
                    return Ok(Some((seen, None)));
                }
                #[cfg(test)]
                if faults(&self.state).put_fails_at == Some(self.seen) {
                    return Err(format!("{}: blob write: No space left on device", message_store::E_DISK));
                }
                let flags = seen.flags.clone();
                message_store::prepare_at(root, &folder, uid, raw, &flags, received_at, to).map(|prepared| Some((seen, Some(prepared))))
            });
            let (seen, prepared) = match read {
                Ok(Some(read)) => read,
                Ok(None) => return Outcome::Gone,
                Err(e) => return outcome_of(e),
            };
            #[cfg(test)]
            if attempt == 0 {
                let hook = faults(&self.state).before_commit.clone();
                if let Some(hook) = hook {
                    hook(self.seen, &self.root, account, mailbox, uid);
                }
            }
            let _ = attempt;
            match with_mailbox_write(&self.state, account, mailbox, |root| self.commit_message(root, account, mailbox, uid, &seen, prepared.as_ref())) {
                Ok(Step::Done(outcome)) => return outcome,
                Ok(Step::Changed) => continue,
                Err(e) => return outcome_of(e),
            }
        }
        Outcome::Failed(format!("{E_FORMAT_CHANGED}: uid {uid}"))
    }

    /// One message's commit, under its mailbox lock. Its source is found again
    /// (disk only): gone, it is skipped; its bytes changed since the read (a
    /// stamp other than `seen`'s), it is read again. Its flags now are the
    /// ones written. The new copy is written and verified, then the old one
    /// set aside (retire mode) and removed (`remove_other_format`, which
    /// checks the copy it keeps once more). A copy that does not verify is
    /// removed again and the old one stays.
    ///
    /// A uid that holds a copy in both formats already: the same message, the
    /// copy in the new format is kept. Two different messages: in delete mode
    /// both stay and the uid fails; in retire mode the record (the copy every
    /// reader reads) wins and the Maildir file is set aside first.
    fn commit_message(
        &self,
        root: &Path,
        account: &str,
        mailbox: &str,
        uid: u32,
        seen: &message_store::Held,
        prepared: Option<&message_store::Prepared>,
    ) -> Result<Step, String> {
        let to = self.journal.to;
        let from = other(to);
        let folder = folder_of(root, account, mailbox);
        let Some(now) = message_store::held_at(&folder, uid, from) else { return Ok(Step::Done(Outcome::Gone)) };
        if now.stamp != seen.stamp {
            return Ok(Step::Changed);
        }
        let retire = self.journal.old_files == OldFiles::Retire;
        let dest = retired_dir(root, &self.journal.stamp, account, mailbox);
        let write = |prepared: &message_store::Prepared| -> Result<Option<Outcome>, String> {
            message_store::commit_at(root, &folder, prepared, &now.flags)?;
            let verified = message_store::verify_prepared_at(root, &folder, prepared);
            #[cfg(test)]
            let verified = if faults(&self.state).verify_fails_at == Some(self.seen) { Err("refused by the test hook".to_string()) } else { verified };
            if let Err(e) = verified {
                // The old copy stays the one every reader reads.
                message_store::remove_other_format_at(root, &folder, uid, from)?;
                return Ok(Some(Outcome::Failed(format!("{E_BLOB_VERIFY}: {e}"))));
            }
            Ok(None)
        };
        let both = message_store::held_at(&folder, uid, to).is_some();
        let same = both && message_store::same_content_at(&folder, uid) == Some(true);
        if both && !same && !retire {
            return Ok(Step::Done(Outcome::Failed(format!("{E_FORMAT_CONFLICT}: uid {uid}"))));
        }
        // Converting to Maildir with the uid in both formats: the record is what
        // every reader read, so the file is written again under the record's
        // flags (the same message, the flags only the record may hold: local A
        // and T especially); a file of another message is set aside first.
        if !both || to == message_store::Format::Maildir {
            let Some(prepared) = prepared else { return Ok(Step::Changed) };
            if both && !same {
                // The Maildir file beside the record loses to it: set aside first.
                message_store::retire_format_at(&folder, uid, message_store::Format::Maildir, &dest, self.link)?;
            }
            if let Some(failed) = write(prepared)? {
                return Ok(Step::Done(failed));
            }
        }
        #[cfg(test)]
        if faults(&self.state).panic_after_write_at == Some(self.seen) {
            panic!("test hook: the worker dies between the new copy and the removal of the old one");
        }
        if retire {
            message_store::retire_format_at(&folder, uid, from, &dest, self.link)?;
        }
        message_store::remove_other_format_at(root, &folder, uid, to)?;
        // The registry keys a folder by `vault_dir_name` of its name: a folder
        // named otherwise on disk has no row to upsert, and is invalidated whole
        // when it is finished.
        if vault_dir_name(mailbox) == mailbox {
            if let Some(kept) = message_store::held_at(&folder, uid, to) {
                self.state.vault_registry.upsert(account, mailbox, uid, &kept.path);
            }
        }
        Ok(Step::Done(Outcome::Converted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::message_store::Format;
    use std::collections::BTreeMap;
    use tokio::sync::broadcast::error::TryRecvError;

    const WORDS: [&str; 6] = ["archived", "draft", "flagged", "replied", "seen", "trashed"];

    /// A vault, its app data and a daemon on them, the custody store open
    /// (the conversion reads the header cache).
    fn st() -> (tempfile::TempDir, tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        crate::custody::open_into(&s).unwrap();
        (vault, app_dir, s)
    }

    /// A small deterministic generator (xorshift64*), so a failing case can be
    /// run again.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        fn bytes(&mut self, n: usize) -> Vec<u8> {
            (0..n).map(|_| self.next() as u8).collect()
        }
    }

    /// One fixture message of many shapes: CRLF or LF, with and without a
    /// Message-ID or Date, multipart, bytes the parser refuses, raw noise.
    fn message(rng: &mut Rng, n: u64) -> Vec<u8> {
        let len = rng.below(300) as usize;
        let body = rng.bytes(len);
        let mut out = match rng.below(5) {
            0 => format!("Message-ID: <m{n}@x.test>\r\nDate: Thu, 01 Oct 2026 10:00:{:02} +0200\r\nSubject: m{n}\r\n\r\n", n % 60).into_bytes(),
            1 => format!("Subject: lf {n}\nFrom: a@x.test\n\n").into_bytes(),
            2 => format!(" a first line with a space {n}\r\nSubject: odd\r\n\r\n").into_bytes(),
            3 => format!(
                "Message-ID: <p{n}@x.test>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=f{n}.bin\r\n\r\n"
            )
            .into_bytes(),
            _ => Vec::new(),
        };
        out.extend_from_slice(&body);
        out.extend_from_slice(format!("\r\n-- {n}\r\n").as_bytes());
        out
    }

    fn random_flags(rng: &mut Rng) -> Vec<String> {
        WORDS.iter().filter(|_| rng.below(2) == 1).map(|w| w.to_string()).collect()
    }

    /// `accounts` x `mailboxes` x `per` messages written as Maildir files
    /// under random flags; every fifth message of a second mailbox repeats a
    /// first mailbox's bytes (a Gmail label copy). `(account, mailbox, uid)`
    /// to bytes.
    fn fixture(root: &Path, accounts: usize, mailboxes: usize, per: u32) -> BTreeMap<(String, String, u32), Vec<u8>> {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut out = BTreeMap::new();
        for a in 0..accounts {
            let account = format!("acct{a}");
            let mut first: Vec<Vec<u8>> = Vec::new();
            for m in 0..mailboxes {
                let mailbox = if m == 0 { "INBOX".to_string() } else { format!("Box{m}") };
                for uid in 1..=per {
                    let raw = if m > 0 && uid % 5 == 0 { first[uid as usize - 1].clone() } else { message(&mut rng, u64::from(uid) + 1000 * a as u64) };
                    if m == 0 {
                        first.push(raw.clone());
                    }
                    message_store::write(root, &account, &mailbox, uid, &raw, &random_flags(&mut rng)).unwrap();
                    out.insert((account.clone(), mailbox.clone(), uid), raw);
                }
            }
        }
        out
    }

    /// Every file under a `cur/` (or `jmap/`) directory of the vault's
    /// Maildir tree: relative path to bytes.
    fn files_under(root: &Path, kind: &str) -> BTreeMap<String, Vec<u8>> {
        let mut out = BTreeMap::new();
        for entry in walkdir(root.join("Maildir")) {
            if entry.parent().and_then(Path::file_name).is_some_and(|n| n == kind) {
                out.insert(entry.strip_prefix(root).unwrap().to_string_lossy().into_owned(), std::fs::read(&entry).unwrap());
            }
        }
        out
    }

    fn walkdir(dir: PathBuf) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walkdir(path));
            } else {
                out.push(path);
            }
        }
        out
    }

    /// Starts a conversion and waits for its last event (`active: false`).
    fn run(s: &Arc<DaemonState>, root: &Path, to: Format, old_files: OldFiles) -> Value {
        let mut rx = s.events.subscribe();
        start(s, root, to, old_files).expect("started");
        end_of(&mut rx)
    }

    /// The next `format-migration-progress` event that ends a run.
    fn end_of(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match rx.try_recv() {
                Ok(line) => {
                    let v: Value = serde_json::from_str(&line).unwrap();
                    if v["params"]["name"] == EVENT && v["params"]["payload"]["active"] == json!(false) {
                        return v["params"]["payload"].clone();
                    }
                }
                Err(TryRecvError::Empty) => {
                    assert!(Instant::now() < deadline, "the job never ended");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TryRecvError::Lagged(_)) => {}
                Err(TryRecvError::Closed) => panic!("the event bus closed"),
            }
        }
    }

    /// Polls the live job until its view reads `state`.
    fn view_until(s: &Arc<DaemonState>, state: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(job) = s.format_migration.live() {
                let v = job.view();
                if v["state"] == state {
                    return v;
                }
            }
            assert!(Instant::now() < deadline, "the job never read {state}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn journal_of(s: &DaemonState, root: &Path) -> Journal {
        pending_journal(&s.app_dir, root).expect("a journal")
    }

    fn marker(root: &Path, key: &str) -> Option<String> {
        mailvault_core::vault_layout::read_marker_value(root, key)
    }

    fn hook(s: &DaemonState, f: impl Fn(u64, &Path, &str, &str, u32) + Send + Sync + 'static) {
        faults(s).before_commit = Some(Arc::new(f));
    }

    fn record_of(root: &Path, account: &str, mailbox: &str, uid: u32) -> Option<message_store::Held> {
        message_store::held_in(root, account, mailbox, uid, Format::Jmap)
    }

    fn file_of(root: &Path, account: &str, mailbox: &str, uid: u32) -> Option<message_store::Held> {
        message_store::held_in(root, account, mailbox, uid, Format::Maildir)
    }

    /// The global constraint: `.eml -> jmap -> .eml` gives back every message
    /// byte for byte under the same uid and the same flag letters, so the
    /// Maildir tree is the one it was. On the way, every record reads as its
    /// message and no Maildir file is left.
    #[test]
    fn eml_to_jmap_to_eml_is_byte_identical_with_same_uids_and_flags() {
        let (v, _a, s) = st();
        let root = v.path();
        let messages = fixture(root, 3, 2, 34);
        assert_eq!(messages.len(), 204);
        let before = files_under(root, "cur");
        assert_eq!(before.len(), 204);

        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone(), end["failed"].clone()), (json!("done"), json!(204), json!(204), json!(0)), "{end}");
        assert!(files_under(root, "cur").is_empty(), "every Maildir file went");
        assert_eq!(files_under(root, "jmap").len(), 204);
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw), "{account}/{mailbox}/{uid}");
        }
        assert_eq!(marker(root, MIGRATION_KEY).as_deref(), Some(""));
        assert!(!s.app_dir.join(JOURNAL_DIR).read_dir().unwrap().any(|_| true), "a done job leaves no journal");

        let end = run(&s, root, Format::Maildir, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone()), (json!("done"), json!(204), json!(204)), "{end}");
        assert!(files_under(root, "jmap").is_empty(), "every record went");
        assert_eq!(files_under(root, "cur"), before, "the same names (uid, flag letters) and the same bytes");
        assert_eq!(message_store::vault_format(root), Format::Maildir);
    }

    /// Retire mode keeps every old file, byte for byte, under
    /// `retired/format-<stamp>/<account>/<dir>/cur/<name>`.
    #[test]
    fn retire_mode_keeps_every_old_file_under_retired() {
        let (v, _a, s) = st();
        let root = v.path();
        fixture(root, 2, 2, 6);
        let before = files_under(root, "cur");
        let end = run(&s, root, Format::Jmap, OldFiles::Retire);
        assert_eq!(end["state"], json!("done"), "{end}");
        let stamps: Vec<PathBuf> = std::fs::read_dir(root.join(RETIRED_DIR)).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        assert_eq!(stamps.len(), 1, "one retired/format-<stamp>: {stamps:?}");
        for (rel, raw) in &before {
            let kept = stamps[0].join(Path::new(rel).strip_prefix("Maildir").unwrap());
            assert_eq!(std::fs::read(&kept).ok().as_ref(), Some(raw), "{rel} kept aside");
        }
        assert!(files_under(root, "cur").is_empty());
        assert_eq!(retired(root)["count"], json!(before.len()));
    }

    /// Delete mode: a message whose new copy does not verify keeps its old
    /// file, is in `failed`, and the rest carry on. The run ends failed with
    /// the journal kept; Resume converts it.
    #[test]
    fn delete_mode_keeps_the_eml_when_verify_fails() {
        let (v, _a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 1, 6);
        faults(&s).verify_fails_at = Some(3);
        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone(), end["failed"].clone()), (json!("failed"), json!(5), json!(6), json!(1)), "{end}");
        assert_eq!(end["error"], json!(format!("{E_FORMAT_UNVERIFIED}: 1")));
        assert!(file_of(root, "acct0", "INBOX", 3).is_some(), "the old file of uid 3 stays");
        assert!(record_of(root, "acct0", "INBOX", 3).is_none(), "its unverified record went again");
        for uid in [1, 2, 4, 5, 6] {
            assert!(record_of(root, "acct0", "INBOX", uid).is_some() && file_of(root, "acct0", "INBOX", uid).is_none(), "uid {uid} converted");
        }
        let journal = journal_of(&s, root);
        assert_eq!(journal.failed.len(), 1);
        assert_eq!((journal.failed[0].uid, journal.failed[0].reason.starts_with(E_BLOB_VERIFY)), (3, true), "{:?}", journal.failed);
        assert_eq!(marker(root, MIGRATION_KEY).as_deref(), Some(""), "a failed job is no longer in progress");

        faults(&s).verify_fails_at = None;
        let mut rx = s.events.subscribe();
        resume(&s, root).unwrap();
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone()), (json!("done"), json!(6), json!(6)), "{end}");
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw));
            assert!(file_of(root, account, mailbox, *uid).is_none());
        }
    }

    /// The worker dies between a message's new copy and the removal of its
    /// old one. The journal reads as cut off, the next start carries on, and
    /// the vault ends with every uid once, no old file left in delete mode,
    /// and no blob nothing names.
    #[test]
    fn killed_mid_message_resumes_without_loss_or_duplicates() {
        let (v, _a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 2, 8);
        faults(&s).panic_after_write_at = Some(4);
        let cut = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!(cut["state"], json!("paused"), "{cut}");
        assert!(s.format_migration.live().is_none());
        assert_eq!(journal_of(&s, root).state, RUNNING, "left as a run a crash cut off");
        // Mailboxes go in name order: the fourth message is Box1's uid 4.
        assert!(record_of(root, "acct0", "Box1", 4).is_some() && file_of(root, "acct0", "Box1", 4).is_some(), "uid 4 in both formats");

        faults(&s).panic_after_write_at = None;
        let mut rx = s.events.subscribe();
        resume_journaled(&s);
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone()), (json!("done"), json!(16), json!(16)), "{end}");
        assert!(files_under(root, "cur").is_empty(), "no old file left");
        assert_eq!(files_under(root, "jmap").len(), 16, "every uid once");
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw));
        }
        assert_eq!(message_store::sweep_blobs(root, Duration::ZERO).unwrap().removed, 0, "no blob without a record");
    }

    /// A full disk stops the job as failed at once: that message keeps its
    /// old file, the ones after it are not touched.
    #[test]
    fn enospc_stops_job_and_keeps_old_file() {
        let (v, _a, s) = st();
        let root = v.path();
        fixture(root, 1, 1, 12);
        faults(&s).put_fails_at = Some(10);
        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["done"].clone()), (json!("failed"), json!(9)), "{end}");
        assert_eq!(end["error"], json!(format!("{E_FORMAT_DISK}: see the daemon log")), "the cause stays in the log");
        assert!(file_of(root, "acct0", "INBOX", 10).is_some() && record_of(root, "acct0", "INBOX", 10).is_none());
        for uid in [11, 12] {
            assert!(file_of(root, "acct0", "INBOX", uid).is_some() && record_of(root, "acct0", "INBOX", uid).is_none(), "uid {uid} untouched");
        }
        assert_eq!(journal_of(&s, root).state, FAILED);
    }

    /// A flag change between the read and the commit is kept: the record
    /// takes the flags the uid has at commit time.
    #[test]
    fn flag_change_between_read_and_commit_is_kept() {
        let (v, _a, s) = st();
        let root = v.path();
        message_store::write(root, "acct", "INBOX", 1, b"Subject: one\r\n\r\none", &[]).unwrap();
        message_store::write(root, "acct", "INBOX", 2, b"Subject: two\r\n\r\ntwo", &["seen".to_string()]).unwrap();
        hook(&s, |n, root, account, mailbox, uid| {
            if n == 2 {
                message_store::set_flags(root, account, mailbox, uid, &["flagged".to_string()]).unwrap();
            }
        });
        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!(end["state"], json!("done"), "{end}");
        assert_eq!(record_of(root, "acct", "INBOX", 2).unwrap().flags, vec!["flagged".to_string(), "\\Flagged".to_string()]);
        assert_eq!(message_store::read_raw(root, "acct", "INBOX", 2).unwrap(), Some(b"Subject: two\r\n\r\ntwo".to_vec()));
    }

    /// A draft overwritten between the read and the commit: the record holds
    /// the new bytes; the old ones are nowhere but in a blob no record names,
    /// which a sweep takes.
    #[test]
    fn draft_overwritten_between_read_and_commit_converts_the_new_bytes() {
        let (v, _a, s) = st();
        let root = v.path();
        let old = b"Subject: draft\r\n\r\nfirst words".to_vec();
        let new = b"Subject: draft\r\n\r\nfirst words, and then some more".to_vec();
        message_store::write(root, "acct", "Drafts", 1, &old, &["draft".to_string()]).unwrap();
        let replacement = new.clone();
        hook(&s, move |n, root, account, mailbox, uid| {
            if n == 1 {
                let file = message_store::held_in(root, account, mailbox, uid, Format::Maildir).unwrap();
                std::fs::write(file.path, &replacement).unwrap();
            }
        });
        let end = run(&s, root, Format::Jmap, OldFiles::Retire);
        assert_eq!(end["state"], json!("done"), "{end}");
        let record = record_of(root, "acct", "Drafts", 1).unwrap();
        assert_eq!(record.stamp, mailvault_core::jmap_store::blobs::blob_id(&new));
        assert_eq!(message_store::read_raw(root, "acct", "Drafts", 1).unwrap(), Some(new.clone()));
        let swept = message_store::sweep_blobs(root, Duration::ZERO).unwrap();
        assert_eq!(swept.removed, 1, "the blob of the old bytes, named by no record");
        let holders: Vec<PathBuf> = walkdir(root.to_path_buf()).into_iter().filter(|p| std::fs::read(p).ok().as_deref() == Some(old.as_slice())).collect();
        assert!(holders.iter().all(|p| p.starts_with(root.join(RETIRED_DIR))), "old bytes only aside: {holders:?}");
    }

    /// Retire mode needs room for the new copies whether the old files are
    /// linked or copied aside; delete mode needs none. A refused start leaves
    /// no journal and the format as it was.
    #[test]
    fn retire_precheck_refuses_without_space_when_no_hardlinks() {
        let (v, a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 1, 4);
        let source: u64 = messages.values().map(|raw| raw.len() as u64).sum();
        let need = source + source / 10;
        faults(&s).no_hard_links = true;
        faults(&s).free_bytes = Some(10);
        assert_eq!(start(&s, root, Format::Jmap, OldFiles::Retire).unwrap_err(), format!("{E_FORMAT_NO_SPACE}: {}", need - 10));
        faults(&s).no_hard_links = false;
        assert!(start(&s, root, Format::Jmap, OldFiles::Retire).unwrap_err().starts_with(E_FORMAT_NO_SPACE), "hard links keep the old files too");
        assert!(!a.path().join(JOURNAL_DIR).exists(), "no journal");
        assert_eq!(message_store::vault_format(root), Format::Maildir);
        assert_eq!(marker(root, MIGRATION_KEY), None);

        faults(&s).free_bytes = Some(need);
        faults(&s).no_hard_links = true;
        let end = run(&s, root, Format::Jmap, OldFiles::Retire);
        assert_eq!(end["state"], json!("done"), "{end}");
        assert_eq!(retired(root)["count"], json!(4), "copied aside");
    }

    /// Pause holds after the message in hand, resume carries on, cancel ends
    /// the run: the format stays the target, the job is no longer in
    /// progress, and the mixed vault reads every message.
    #[test]
    fn pause_resume_cancel() {
        let (v, _a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 1, 10);
        let steer = Arc::clone(&s);
        let steer_root = root.to_path_buf();
        hook(&s, move |n, _, _, _, _| match n {
            3 => {
                pause(&steer, &steer_root).unwrap();
            }
            6 => {
                cancel(&steer, &steer_root).unwrap();
            }
            _ => {}
        });
        let mut rx = s.events.subscribe();
        start(&s, root, Format::Jmap, OldFiles::Delete).unwrap();
        let held = view_until(&s, PAUSED);
        assert_eq!((held["done"].clone(), held["active"].clone()), (json!(3), json!(true)), "held after the message in hand");
        assert_eq!(journal_of(&s, root).state, PAUSED);
        assert_eq!(resume(&s, root).unwrap()["resumed"], json!(true));
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone()), (json!("cancelled"), json!(6)), "{end}");
        assert_eq!(message_store::vault_format(root), Format::Jmap);
        assert_eq!(marker(root, MIGRATION_KEY).as_deref(), Some(""));
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw), "uid {uid}");
            assert_eq!(record_of(root, account, mailbox, *uid).is_some(), *uid <= 6, "uid {uid}");
        }
    }

    /// M9: a record's `receivedAt` is the header cache's INTERNALDATE, in UTC.
    #[test]
    fn the_header_caches_internaldate_is_the_records_received_at() {
        let (v, _a, s) = st();
        let root = v.path();
        message_store::write(root, "acct", "INBOX", 1, b"Date: Thu, 01 Oct 2026 10:00:00 +0200\r\nSubject: one\r\n\r\none", &[]).unwrap();
        message_store::write(root, "acct", "INBOX", 2, b"Date: Thu, 01 Oct 2026 10:00:00 +0200\r\nSubject: two\r\n\r\ntwo", &[]).unwrap();
        crate::custody::with_conn(&s, |c| {
            c.execute(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('acct','INBOX',1,0,0,?1)",
                rusqlite::params![r#"{"uid":1,"internalDate":"2026-12-20T13:00:00+01:00"}"#],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap();
        // Its first import rehome is done (D7).
        std::fs::write(message_store::mailbox_dir(root, "acct", "INBOX").join(import_rehome::DONE_FILE), b"").unwrap();
        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!(end["state"], json!("done"), "{end}");
        let received = |uid: u32| {
            let rec: Value = serde_json::from_slice(&std::fs::read(record_of(root, "acct", "INBOX", uid).unwrap().path).unwrap()).unwrap();
            rec["email"]["receivedAt"].clone()
        };
        assert_eq!(received(1), json!("2026-12-20T12:00:00Z"), "INTERNALDATE, in UTC");
        assert_eq!(received(2), json!("2026-10-01T08:00:00Z"), "no cached row: the Date header");
    }

    /// D7: a folder the header cache knows, whose first import rehome has not
    /// run, waits as Maildir files; the rest converts. The run ends failed
    /// with the journal kept, and Resume converts it once the pass is done.
    #[test]
    fn a_folder_waits_for_its_first_import_rehome() {
        let (v, _a, s) = st();
        let root = v.path();
        message_store::write(root, "acct", "INBOX", 1, b"Subject: one\r\n\r\none", &[]).unwrap();
        message_store::write(root, "acct", "Local", 1, b"Subject: local\r\n\r\nlocal", &[]).unwrap();
        crate::custody::with_conn(&s, |c| {
            c.execute(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('acct','INBOX',1,0,0,'{\"uid\":1}')",
                [],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap();
        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["error"].clone()), (json!("failed"), json!(format!("{E_FORMAT_REHOME_PENDING}: 1"))), "{end}");
        assert!(file_of(root, "acct", "INBOX", 1).is_some() && record_of(root, "acct", "INBOX", 1).is_none(), "INBOX waits");
        assert!(record_of(root, "acct", "Local", 1).is_some(), "a folder with no server view converts");
        let waiting: Vec<_> = journal_of(&s, root).mailboxes.into_iter().map(|m| (m.dir, m.state)).collect();
        assert_eq!(waiting, vec![("INBOX".to_string(), MAILBOX_WAITING.to_string()), ("Local".to_string(), MAILBOX_DONE.to_string())]);

        std::fs::write(message_store::mailbox_dir(root, "acct", "INBOX").join(import_rehome::DONE_FILE), b"").unwrap();
        let mut rx = s.events.subscribe();
        resume(&s, root).unwrap();
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone()), (json!("done"), json!(2), json!(2)), "{end}");
        assert!(record_of(root, "acct", "INBOX", 1).is_some() && file_of(root, "acct", "INBOX", 1).is_none());
    }

    /// The convert-back window: a Maildir file written beside a record. The
    /// same message: the record goes once the file is checked against it.
    /// Another message: in delete mode both stay and the uid fails; in retire
    /// mode the record (what every reader read) wins and the file is set
    /// aside first.
    #[test]
    fn a_uid_held_in_both_formats_keeps_what_readers_read() {
        let (v, _a, s) = st();
        let root = v.path();
        message_store::set_vault_format(root, Format::Jmap).unwrap();
        for uid in 1..=3 {
            message_store::write(root, "acct", "INBOX", uid, format!("Subject: r{uid}\r\n\r\nrecord {uid}").as_bytes(), &[]).unwrap();
        }
        message_store::set_vault_format(root, Format::Maildir).unwrap();
        // A window writer: uid 1 the same message, uid 2 another.
        message_store::write(root, "acct", "INBOX", 1, b"Subject: r1\r\n\r\nrecord 1", &[]).unwrap();
        message_store::write(root, "acct", "INBOX", 2, b"Subject: w2\r\n\r\nwindow 2", &[]).unwrap();
        message_store::set_vault_format(root, Format::Jmap).unwrap();

        let end = run(&s, root, Format::Maildir, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["failed"].clone()), (json!("failed"), json!(2), json!(1)), "{end}");
        assert_eq!(journal_of(&s, root).failed[0].reason, format!("{E_FORMAT_CONFLICT}: uid 2"));
        assert!(record_of(root, "acct", "INBOX", 2).is_some() && file_of(root, "acct", "INBOX", 2).is_some(), "both kept");
        assert_eq!(message_store::read_raw(root, "acct", "INBOX", 1).unwrap(), Some(b"Subject: r1\r\n\r\nrecord 1".to_vec()));
        assert!(record_of(root, "acct", "INBOX", 1).is_none());

        let end = run(&s, root, Format::Maildir, OldFiles::Retire);
        assert_eq!(end["state"], json!("done"), "{end}");
        assert_eq!(message_store::read_raw(root, "acct", "INBOX", 2).unwrap(), Some(b"Subject: r2\r\n\r\nrecord 2".to_vec()), "the record won");
        assert!(record_of(root, "acct", "INBOX", 2).is_none());
        let aside: Vec<Vec<u8>> = walkdir(root.join(RETIRED_DIR)).iter().map(|p| std::fs::read(p).unwrap()).collect();
        assert!(aside.contains(&b"Subject: w2\r\n\r\nwindow 2".to_vec()), "the window file is kept aside");
    }

    /// A quit holds the job at its next message with the journal still
    /// `running`; the next daemon on the vault carries on from there.
    #[test]
    fn a_quit_holds_the_job_and_the_next_start_carries_on() {
        let (v, a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 1, 8);
        let quitting = Arc::clone(&s);
        hook(&s, move |n, _, _, _, _| {
            if n == 3 {
                quitting.format_migration.quitting.store(true, Ordering::SeqCst);
            }
        });
        start(&s, root, Format::Jmap, OldFiles::Delete).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while !s.format_migration.quitting.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "the third message never came");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(pause_all_and_wait(&s, Duration::from_secs(60)), "held at the next message");
        let journal = journal_of(&s, root);
        assert_eq!((journal.state.as_str(), journal.done), (RUNNING, 3), "checkpointed, still running");

        // The first daemon still holds the custody store; the folder's import
        // rehome is done, so the next one need not read the header cache.
        std::fs::write(message_store::mailbox_dir(root, "acct0", "INBOX").join(import_rehome::DONE_FILE), b"").unwrap();
        let next = DaemonState::for_test(root.to_path_buf(), a.path().to_path_buf(), true);
        let mut rx = next.events.subscribe();
        resume_journaled(&next);
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone()), (json!("done"), json!(8), json!(8)), "{end}");
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw));
        }
    }

    /// A uid held in both formats with the same bytes, the record flagged
    /// archived and the file not: the conversion to Maildir keeps the record's
    /// flags (the record is what every reader read), so the file ends up named
    /// with the A.
    #[test]
    fn a_both_format_uid_converted_to_maildir_keeps_the_records_flags() {
        let (v, _a, s) = st();
        let root = v.path();
        let raw = b"Subject: both\r\n\r\nboth";
        message_store::set_vault_format(root, Format::Jmap).unwrap();
        message_store::write(root, "acct", "INBOX", 1, raw, &["archived".to_string(), "seen".to_string()]).unwrap();
        message_store::set_vault_format(root, Format::Maildir).unwrap();
        message_store::write(root, "acct", "INBOX", 1, raw, &[]).unwrap();
        message_store::set_vault_format(root, Format::Jmap).unwrap();
        assert!(record_of(root, "acct", "INBOX", 1).is_some() && file_of(root, "acct", "INBOX", 1).is_some());

        let end = run(&s, root, Format::Maildir, OldFiles::Delete);
        assert_eq!(end["state"], json!("done"), "{end}");
        assert!(record_of(root, "acct", "INBOX", 1).is_none(), "the record went");
        let file = file_of(root, "acct", "INBOX", 1).expect("the file stays");
        assert!(file.flags.contains(&"archived".to_string()), "the file carries the record's A: {:?}", file.flags);
        assert!(file.flags.contains(&"seen".to_string()), "and its S: {:?}", file.flags);
        assert_eq!(message_store::read_raw(root, "acct", "INBOX", 1).unwrap(), Some(raw.to_vec()));
    }

    /// A folder whose directory cannot be read ends the run `failed` with
    /// `E_FORMAT_UNREADABLE`, journal kept, nothing removed or converted:
    /// it must not read as a folder without messages.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_fails_the_run_instead_of_dropping_out_of_it() {
        use std::os::unix::fs::PermissionsExt;
        let (v, _a, s) = st();
        let root = v.path();
        message_store::write(root, "acct", "INBOX", 1, b"Subject: one\r\n\r\none", &[]).unwrap();
        message_store::write(root, "acct", "Work", 2, b"Subject: two\r\n\r\ntwo", &[]).unwrap();
        let locked = message_store::mailbox_dir(root, "acct", "Work");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unlock = || std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        if std::fs::metadata(locked.join("cur")).is_ok() {
            unlock();
            return; // root: permissions do not apply
        }
        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        let journal = pending_journal(&s.app_dir, root);
        unlock();
        assert_eq!(end["state"], json!("failed"), "{end}");
        assert_eq!(end["error"], json!(format!("{E_FORMAT_UNREADABLE}: see the daemon log")), "{end}");
        assert_eq!(journal.expect("the journal is kept").state, FAILED);
        assert!(file_of(root, "acct", "INBOX", 1).is_some() && record_of(root, "acct", "INBOX", 1).is_none(), "nothing converted");
        assert!(file_of(root, "acct", "Work", 2).is_some(), "nothing removed");
    }

    /// A folder whose on-disk name does not survive `vault_dir_name` (an NFD
    /// name from an HFS+ or SMB volume) converts both ways, addressed by its
    /// directory, and the run ends done.
    #[test]
    fn a_folder_named_in_nfd_converts_both_ways() {
        let (v, _a, s) = st();
        let root = v.path();
        let nfd = "Cafe\u{301}";
        assert_ne!(mailvault_core::search_index::text::vault_dir_name(nfd), nfd, "the name must not round-trip");
        for (uid, flags) in [(1u32, vec![]), (2, vec!["seen".to_string(), "flagged".to_string()]), (3, vec!["archived".to_string()])] {
            message_store::write(root, "acct", "Tmp", uid, format!("Subject: nfd {uid}\r\n\r\nnfd {uid}").as_bytes(), &flags).unwrap();
        }
        let maildir = root.join("Maildir");
        let folder = message_store::mailbox_dir_at(&maildir, "acct", nfd);
        std::fs::rename(message_store::mailbox_dir(root, "acct", "Tmp"), &folder).unwrap();
        let before = files_under(root, "cur");
        assert_eq!(before.len(), 3);

        let end = run(&s, root, Format::Jmap, OldFiles::Delete);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone()), (json!("done"), json!(3), json!(3)), "{end}");
        assert!(files_under(root, "cur").is_empty(), "no old file left");
        let records = files_under(root, "jmap");
        assert_eq!(records.len(), 3, "{:?}", records.keys().collect::<Vec<_>>());
        assert!(records.keys().all(|k| k.contains(nfd)), "the records are in the folder, under its own name");

        let end = run(&s, root, Format::Maildir, OldFiles::Delete);
        assert_eq!(end["state"], json!("done"), "{end}");
        assert!(files_under(root, "jmap").is_empty());
        assert_eq!(files_under(root, "cur"), before, "the Maildir tree is the one it was");
    }

    /// Waits until the live job holds for the vault: settled while it is
    /// asked to run. False when it never did (it ended, or `limit` passed).
    fn held_for_vault(s: &Arc<DaemonState>, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some(job) = s.format_migration.live() {
                if job.ctl() == Ctl::Run && *lock(&job.settled) {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    /// R26: the app closes the vault before a move (and before a portable
    /// copy or an adopt). A conversion in the middle of a message then holds
    /// with nothing recorded as failed, the refused move leaves it alone, and
    /// once the vault reopens the same message is tried again: the run ends
    /// done with every message converted.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_closed_vault_holds_the_job_and_reopening_carries_on() {
        let (v, _a, s) = st();
        let root = v.path().to_path_buf();
        let messages = fixture(&root, 1, 1, 6);
        std::fs::write(message_store::mailbox_dir(&root, "acct0", "INBOX").join(import_rehome::DONE_FILE), b"").unwrap();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let go_rx = Mutex::new(Some(go_rx));
        let entered = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&entered);
        // Message 2 waits between its read and its commit, once.
        hook(&s, move |n, _, _, _, _| {
            if n == 2 {
                let rx = go_rx.lock().unwrap().take();
                if let Some(rx) = rx {
                    flag.store(true, Ordering::SeqCst);
                    let _ = rx.recv();
                }
            }
        });
        let mut events = s.events.subscribe();
        start(&s, &root, Format::Jmap, OldFiles::Delete).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while !entered.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "the second message never came");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        crate::handlers::search_index::route(&s, "vault_close", &json!({}), Value::Null).await;
        let id = journal_of(&s, &root).job_id;
        let dst = tempfile::tempdir().unwrap();
        let refused = crate::handlers::vault::route(&s, "vault_move_to", &json!({"path": dst.path().to_string_lossy()}), json!(1)).await.unwrap();
        assert_eq!(refused.error.map(|e| e.message), Some(format!("{E_FORMAT_MOVE_BLOCKED}: {id}")), "a held job is a live job");
        assert!(!dst.path().join("Maildir").exists(), "nothing copied");

        go_tx.send(()).unwrap();
        let held = tokio::task::block_in_place(|| held_for_vault(&s, Duration::from_secs(10)));
        assert!(held, "the job holds for the vault: {:?}", pending_journal(&s.app_dir, &root));
        let journal = journal_of(&s, &root);
        assert_eq!((journal.state.as_str(), journal.done, journal.failed.len()), (RUNNING, 1, 0), "{journal:?}");
        tokio::time::sleep(Duration::from_millis(400)).await;
        let view = s.format_migration.live().expect("still live").view();
        assert_eq!((view["state"].clone(), view["done"].clone(), view["failed"].clone()), (json!("running"), json!(1), json!(0)), "{view}");

        crate::handlers::search_index::route(&s, "vault_reopen", &json!({}), Value::Null).await;
        let end = tokio::task::block_in_place(|| end_of(&mut events));
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone(), end["failed"].clone()), (json!("done"), json!(6), json!(6), json!(0)), "{end}");
        assert!(pending_journal(&s.app_dir, &root).is_none(), "a done job leaves no journal");
        assert!(files_under(&root, "cur").is_empty(), "no old file left");
        for ((account, mailbox, uid), raw) in &messages {
            assert!(record_of(&root, account, mailbox, *uid).is_some(), "uid {uid} converted");
            assert_eq!(message_store::read_raw(&root, account, mailbox, *uid).unwrap().as_ref(), Some(raw), "uid {uid}");
        }
    }

    /// Any other loss of the vault holds the job the same way. A volume that
    /// went away (an unmounted NAS) lists every folder as empty and reads
    /// every message as gone: none of that may count as converted, gone or
    /// done. Once the vault is back, the run carries on and ends done.
    #[cfg(unix)]
    #[test]
    fn a_vault_that_went_away_holds_the_job_until_it_is_back() {
        let (v, _a, s) = st();
        let root = v.path().to_path_buf();
        let messages = fixture(&root, 1, 2, 3);
        let away = root.with_extension("away");
        let (from, to) = (root.clone(), away.clone());
        let once = AtomicBool::new(false);
        hook(&s, move |n, _, _, _, _| {
            if n == 2 && !once.swap(true, Ordering::SeqCst) {
                std::fs::rename(&from, &to).unwrap();
            }
        });
        let mut rx = s.events.subscribe();
        start(&s, &root, Format::Jmap, OldFiles::Delete).unwrap();
        let held = held_for_vault(&s, Duration::from_secs(10));
        let journal = pending_journal(&s.app_dir, &root);
        // Back before any assertion can fail, so the temp dir is cleaned up.
        std::fs::rename(&away, &root).unwrap();
        assert!(held, "the job holds while the vault is gone: {journal:?}");
        let journal = journal.expect("a journal");
        assert_eq!((journal.state.as_str(), journal.done, journal.failed.len()), (RUNNING, 1, 0), "{journal:?}");

        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone(), end["failed"].clone()), (json!("done"), json!(6), json!(6), json!(0)), "{end}");
        assert!(files_under(&root, "cur").is_empty(), "no old file left");
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(&root, account, mailbox, *uid).unwrap().as_ref(), Some(raw), "{mailbox} uid {uid}");
        }
    }

    /// A quit while the job holds for the vault does not wait for the vault:
    /// the job is settled already, its journal still `running` with nothing
    /// failed and nothing written after, and the next daemon on the vault
    /// carries on to the end.
    #[test]
    fn a_quit_while_held_for_the_vault_returns_at_once_and_stays_resumable() {
        let (v, a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 1, 6);
        let closer = Arc::clone(&s);
        hook(&s, move |n, _, _, _, _| {
            if n == 2 {
                closer.vault_closed.store(true, Ordering::SeqCst);
            }
        });
        start(&s, root, Format::Jmap, OldFiles::Delete).unwrap();
        assert!(held_for_vault(&s, Duration::from_secs(10)), "held for the vault: {:?}", pending_journal(&s.app_dir, root));
        let asked = Instant::now();
        assert!(pause_all_and_wait(&s, Duration::from_millis(600)), "settled");
        assert!(asked.elapsed() < Duration::from_millis(300), "the quit did not wait for the vault: {:?}", asked.elapsed());
        let journal = journal_of(&s, root);
        assert_eq!((journal.state.as_str(), journal.done, journal.failed.len()), (RUNNING, 1, 0), "{journal:?}");
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(journal_of(&s, root), journal, "nothing written after the quit");

        // The first daemon still holds the custody store; the folder's import
        // rehome is done, so the next one need not read the header cache.
        std::fs::write(message_store::mailbox_dir(root, "acct0", "INBOX").join(import_rehome::DONE_FILE), b"").unwrap();
        let next = DaemonState::for_test(root.to_path_buf(), a.path().to_path_buf(), true);
        let mut rx = next.events.subscribe();
        resume_journaled(&next);
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone(), end["failed"].clone()), (json!("done"), json!(6), json!(6), json!(0)), "{end}");
        for ((account, mailbox, uid), raw) in &messages {
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw));
        }
    }

    /// A cancel while the job holds for the vault ends it at once: nothing
    /// failed, the message in hand still in its old format, nothing written
    /// into the closed vault (the job row stays until the next run). Resume
    /// once the vault is back converts the rest.
    #[test]
    fn a_cancel_while_held_for_the_vault_ends_the_run_with_nothing_failed() {
        let (v, _a, s) = st();
        let root = v.path();
        let messages = fixture(root, 1, 1, 6);
        let closer = Arc::clone(&s);
        let once = AtomicBool::new(false);
        hook(&s, move |n, _, _, _, _| {
            if n == 2 && !once.swap(true, Ordering::SeqCst) {
                closer.vault_closed.store(true, Ordering::SeqCst);
            }
        });
        let mut rx = s.events.subscribe();
        start(&s, root, Format::Jmap, OldFiles::Delete).unwrap();
        assert!(held_for_vault(&s, Duration::from_secs(10)), "held for the vault: {:?}", pending_journal(&s.app_dir, root));
        let id = journal_of(&s, root).job_id;
        // The job's own control: `storage_format_cancel` goes through the
        // vault gate, so the app cannot send it while the vault is closed.
        assert_eq!(cancel(&s, root).unwrap()["cancelled"], json!(true));
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["failed"].clone()), (json!("cancelled"), json!(1), json!(0)), "{end}");
        assert!(file_of(root, "acct0", "INBOX", 2).is_some() && record_of(root, "acct0", "INBOX", 2).is_none(), "uid 2 keeps its old file");
        assert_eq!(marker(root, MIGRATION_KEY), Some(id), "nothing written into the closed vault");

        s.vault_closed.store(false, Ordering::SeqCst);
        let mut rx = s.events.subscribe();
        resume(&s, root).unwrap();
        let end = end_of(&mut rx);
        assert_eq!((end["state"].clone(), end["done"].clone(), end["total"].clone(), end["failed"].clone()), (json!("done"), json!(6), json!(6), json!(0)), "{end}");
        assert_eq!(marker(root, MIGRATION_KEY).as_deref(), Some(""));
        for ((account, mailbox, uid), raw) in &messages {
            assert!(record_of(root, account, mailbox, *uid).is_some(), "uid {uid} converted");
            assert_eq!(message_store::read_raw(root, account, mailbox, *uid).unwrap().as_ref(), Some(raw));
        }
    }
}
