//! The Archive (& back up) & delete worker: `AbdState`, the `abd-worker`
//! thread, the resume-on-start scan, and the daemon's implementations of the
//! engine's `Env` and `ServerOps` plumbing (`abd_local.rs` is the `LocalStore`).
//!
//! Thread model (architecture.md "Process and Thread Model"): ONE dedicated OS
//! thread, `abd-worker`, at background QoS on macOS, with its own
//! current-thread tokio runtime and a `LocalSet`. Every job is a `spawn_local`
//! task on it, so a job never runs on the IPC runtime and no amount of job work
//! can delay an RPC reply. Disk work in the async `LocalStore` goes to the
//! runtime's blocking pool; `Env::save`, `save_plan` and `allowance_left` are
//! synchronous in the engine's trait, so they write directly on this thread
//! (small files in the app data dir, never on a removable drive).
//!
//! Units and yields: the engine works one message at a time and calls
//! `Env::yield_to_foreground` before every server command and store; that waits
//! until the UI has been quiet (`search_index::wait_foreground_quiet`, the same
//! rule the index thread follows). A foreground RPC stamps `last_foreground` in
//! `server::route_request`; no `abd.*` method is a foreground method.
//!
//! Secrets: an access token lives in `AbdState.tokens`, in memory only. It is
//! never in `job.json`, a frame, an RPC result, a plan file or a log line.

use crate::abd_local::DaemonLocal;
use crate::credentials;
use crate::handlers::common;
use crate::imap::ImapConfig;
use crate::server::DaemonState;
use futures::FutureExt;
use mailvault_core::abd::graph_ops::{GraphOps, LeaseStore, TokenLease, LEASE_MARGIN_MS};
use mailvault_core::abd::imap_ops::{build_preview, ImapOps};
use mailvault_core::abd::state as jobfile;
use mailvault_core::abd::{
    plan_job, progress_frame, run, AllMailMap, Control, Env, FolderPlan, FrameInfo, JobFile, JobStatus, Mode,
    PauseReason, PlanStore, PreviewListing, RunExit, ServerOps, WaitReason,
};
use mailvault_core::{graph_ledger, header_cache, transfer_limits};
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tracing::{error, info, warn};

pub(crate) const PROGRESS_EVENT: &str = "abd-progress";
pub(crate) const PREVIEW_EVENT: &str = "abd-preview";
pub(crate) const TOKEN_EVENT: &str = "abd-token-needed";

/// A dry-run listing is good for this long.
pub(crate) const PREVIEW_TTL: Duration = Duration::from_secs(30 * 60);
/// At most one progress frame per second, except a status change or the end.
const EMIT_EVERY: Duration = Duration::from_secs(1);
/// A wait is cut into real-time slices this long so it re-reads the clock
/// (a test moves it; a laptop wake jumps it) and the cancel/pause flags.
const SLEEP_POLL: Duration = Duration::from_millis(250);
const PARK_POLL: Duration = Duration::from_millis(500);
/// A job parked for the vault tries again after this long even if nothing woke it.
const VAULT_RETRY: Duration = Duration::from_secs(15);
/// A job parked for the drive probes the attached path this often.
const DRIVE_PROBE: Duration = Duration::from_secs(30);
/// A password IMAP account refused at sign-in is tried again this rarely.
const SIGN_IN_RETRY: Duration = Duration::from_secs(10 * 60);
/// The keychain (locked) and a removed account are looked at this often.
const CREDENTIAL_POLL: Duration = Duration::from_secs(60);

pub(crate) const INTERRUPTED_WHILE_PLANNING: &str = "Interrupted while preparing. Start a new job.";

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ── State ───────────────────────────────────────────────────────────────────

/// What a job that stopped inside its task is waiting for from outside.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Parked {
    Token,
    Drive,
    Vault,
}

/// One account's job: its control block, its last frame and whether its task
/// is over. Entries are never removed while the job is unfinished; `abd.dismiss`
/// removes a finished one.
pub(crate) struct JobHandle {
    pub job_id: String,
    pub account_id: String,
    pub mode: Option<Mode>,
    pub ctl: Arc<Control>,
    pub last_frame: Mutex<Value>,
    pub finished: AtomicBool,
    pub parked: Mutex<Option<Parked>>,
}

impl JobHandle {
    pub(crate) fn new(job: &JobFile) -> Arc<JobHandle> {
        Arc::new(JobHandle {
            job_id: job.job_id.clone(),
            account_id: job.account_id.clone(),
            mode: Some(job.mode),
            ctl: Arc::new(Control::new()),
            last_frame: Mutex::new(progress_frame(job, &FrameInfo::default())),
            finished: AtomicBool::new(job.status.is_finished()),
            parked: Mutex::new(None),
        })
    }

    /// A job whose file could not be read: finished, failed, dismissable.
    pub(crate) fn unreadable(account_id: &str, error: &str, now_ms: i64) -> Arc<JobHandle> {
        Arc::new(JobHandle {
            job_id: String::new(),
            account_id: account_id.to_string(),
            mode: None,
            ctl: Arc::new(Control::new()),
            last_frame: Mutex::new(unreadable_frame(account_id, error, now_ms)),
            finished: AtomicBool::new(true),
            parked: Mutex::new(None),
        })
    }

    pub(crate) fn frame(&self) -> Value {
        lock(&self.last_frame).clone()
    }

    pub(crate) fn status(&self) -> Value {
        self.frame().get("status").cloned().unwrap_or(Value::Null)
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.finished.load(SeqCst)
    }

    /// Over: the task ended, or the last frame the job sent says it finished
    /// (the app can react to that frame before the task has wound down).
    pub(crate) fn is_over(&self) -> bool {
        self.is_finished() || self.frame().get("finished").and_then(Value::as_bool) == Some(true)
    }

    pub(crate) fn wake(&self) {
        self.ctl.wake.notify_one();
    }

    /// Wake the task only if it is waiting for exactly this: a wake left with
    /// nobody waiting would cut a later, unrelated wait short.
    pub(crate) fn wake_if_parked(&self, what: Parked) {
        if *lock(&self.parked) == Some(what) {
            self.ctl.wake.notify_one();
        }
    }
}

/// The frame of a job whose `job.json` cannot be read. Same keys as a real
/// frame, so the app renders it as a failed, finished job.
pub(crate) fn unreadable_frame(account_id: &str, error: &str, now_ms: i64) -> Value {
    json!({
        "jobId": Value::Null,
        "accountId": account_id,
        "accountEmail": Value::Null,
        "mode": Value::Null,
        "timing": Value::Null,
        "deleteMode": Value::Null,
        "provider": Value::Null,
        "status": {"state": "failed", "error": error},
        "counts": {
            "scoped": 0, "scopedBytes": 0, "stored": 0, "vaultVerified": 0, "onDrive": 0,
            "deleted": 0, "emptied": 0, "kept": 0, "keptByReason": {},
        },
        "downloadedBytes": 0,
        "remainingBytes": 0,
        "daysLeft": Value::Null,
        "dailyLimitBytes": Value::Null,
        "currentFolder": Value::Null,
        "staleFolders": [],
        "providerLimitSinceMs": Value::Null,
        "finished": true,
        "outcome": "failed",
        "error": error,
        "updatedMs": now_ms,
    })
}

#[derive(Default)]
struct TokenMaps {
    leases: HashMap<String, TokenLease>,
    /// Bumped by every `set`, kept across `drop_lease`, so "a newer token
    /// arrived" is a comparison of two numbers.
    seqs: HashMap<String, u64>,
}

/// Access tokens the app pushed (`abd.set_token`), per account. Memory only.
#[derive(Default)]
pub(crate) struct Tokens {
    inner: Mutex<TokenMaps>,
}

impl Tokens {
    pub(crate) fn set(&self, account: &str, lease: TokenLease) -> u64 {
        let mut g = lock(&self.inner);
        let seq = g.seqs.get(account).copied().unwrap_or(0) + 1;
        g.seqs.insert(account.to_string(), seq);
        g.leases.insert(account.to_string(), lease);
        seq
    }
    pub(crate) fn get(&self, account: &str) -> Option<TokenLease> {
        lock(&self.inner).leases.get(account).cloned()
    }
    /// The lease, only while it is still good for a request.
    pub(crate) fn fresh(&self, account: &str, now_ms: i64) -> Option<TokenLease> {
        self.get(account).filter(|l| l.expires_at_ms - LEASE_MARGIN_MS >= now_ms)
    }
    pub(crate) fn seq(&self, account: &str) -> u64 {
        lock(&self.inner).seqs.get(account).copied().unwrap_or(0)
    }
    pub(crate) fn drop_lease(&self, account: &str) {
        lock(&self.inner).leases.remove(account);
    }
}

/// `GraphOps`'s window onto `AbdState.tokens` for one account.
struct AccountLease {
    state: Arc<DaemonState>,
    account_id: String,
}

impl LeaseStore for AccountLease {
    fn current(&self) -> Option<TokenLease> {
        self.state.abd.tokens.get(&self.account_id)
    }
    fn drop_lease(&self) {
        self.state.abd.tokens.drop_lease(&self.account_id);
    }
}

/// The dry-run listing of one account, and the local counts worked out for it.
pub(crate) struct PreviewEntry {
    pub preview_id: String,
    pub listing: Arc<PreviewListing>,
    pub email: String,
    pub host: String,
    pub made: Instant,
    pub counts: Mutex<Option<CachedCounts>>,
}

pub(crate) struct CachedCounts {
    pub at: Instant,
    /// The mirror root (or none) the drive counts were taken for.
    pub mirror: Option<String>,
    pub backup: bool,
    pub counts: mailvault_core::abd::LocalCounts,
}

pub(crate) enum WorkerCmd {
    Preview { account_id: String, preview_id: String },
    Start { job: Box<JobFile>, preview: Arc<PreviewListing>, handle: Arc<JobHandle> },
    /// Test only: stop the worker where it stands, jobs and all, as a killed
    /// daemon would (nothing settles, nothing is saved).
    #[cfg(test)]
    Shutdown,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestHooks {
    /// `Some(b)`: `ImapOps` decides Gmail by `b`, not by the host (the mock is 127.0.0.1).
    pub gmail_host: Mutex<Option<bool>>,
    /// Names of the threads `Env::emit` ran on.
    pub emit_threads: Mutex<Vec<String>>,
    /// Times a mirror folder had to be listed to find a file by uid.
    pub fallback_scans: std::sync::atomic::AtomicUsize,
}

#[derive(Default)]
pub struct AbdState {
    pub(crate) jobs: Mutex<HashMap<String, Arc<JobHandle>>>,
    pub(crate) previews: Mutex<HashMap<String, Arc<PreviewEntry>>>,
    pub(crate) tokens: Tokens,
    /// account -> mirror root the shell attached (a hint from `job.json` after a restart).
    pub(crate) mirrors: Mutex<HashMap<String, String>>,
    /// account -> how many times a mirror was attached.
    pub(crate) attaches: Mutex<HashMap<String, u64>>,
    pub(crate) tx: OnceLock<UnboundedSender<WorkerCmd>>,
    #[cfg(test)]
    pub(crate) test: TestHooks,
}

impl AbdState {
    pub(crate) fn handle(&self, account: &str) -> Option<Arc<JobHandle>> {
        lock(&self.jobs).get(account).cloned()
    }

    pub(crate) fn mirror(&self, account: &str) -> Option<String> {
        lock(&self.mirrors).get(account).cloned()
    }

    pub(crate) fn attach_seq(&self, account: &str) -> u64 {
        lock(&self.attaches).get(account).copied().unwrap_or(0)
    }

    pub(crate) fn attach(&self, account: &str, root: &str) {
        lock(&self.mirrors).insert(account.to_string(), root.to_string());
        *lock(&self.attaches).entry(account.to_string()).or_insert(0) += 1;
    }

    /// The account's listing, if it is the one asked for and still fresh.
    pub(crate) fn preview(&self, account: &str, preview_id: &str) -> Option<Arc<PreviewEntry>> {
        let g = lock(&self.previews);
        g.get(account).filter(|p| p.preview_id == preview_id && p.made.elapsed() <= PREVIEW_TTL).cloned()
    }

    pub(crate) fn send(&self, cmd: WorkerCmd) -> Result<(), String> {
        let tx = self.tx.get().ok_or_else(|| "The archive worker is not running.".to_string())?;
        tx.send(cmd).map_err(|_| "The archive worker is not running.".to_string())
    }

    #[cfg(test)]
    pub(crate) fn stop_worker_for_test(&self) {
        let _ = self.send(WorkerCmd::Shutdown);
    }
}

// ── Worker thread ───────────────────────────────────────────────────────────

/// Start the `abd-worker` thread and, unless a debug build says otherwise,
/// resume the jobs the last daemon left unfinished.
pub(crate) fn start(state: Arc<DaemonState>) {
    let (tx, rx) = unbounded_channel::<WorkerCmd>();
    if state.abd.tx.set(tx).is_err() {
        return;
    }
    let resume = !(cfg!(debug_assertions) && std::env::var("MAILVAULT_DISABLE_ABD_RESUME").as_deref() == Ok("1"));
    let spawned = std::thread::Builder::new().name("abd-worker".into()).spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
        }
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                error!("abd worker: runtime failed to start: {e}");
                return;
            }
        };
        info!("abd worker started");
        rt.block_on(async move {
            let local = tokio::task::LocalSet::new();
            local.run_until(worker_loop(state, rx, resume)).await;
            // Dropped inside the runtime, so tasks holding sockets and timers unwind cleanly.
            drop(local);
        });
    });
    if let Err(e) = spawned {
        warn!("abd worker did not start: {e}");
    }
}

async fn worker_loop(state: Arc<DaemonState>, mut rx: UnboundedReceiver<WorkerCmd>, resume: bool) {
    if resume {
        adopt_existing(&state);
    }
    while let Some(cmd) = rx.recv().await {
        match cmd {
            WorkerCmd::Preview { account_id, preview_id } => {
                tokio::task::spawn_local(do_preview(Arc::clone(&state), account_id, preview_id));
            }
            WorkerCmd::Start { job, preview, handle } => {
                tokio::task::spawn_local(run_job(Arc::clone(&state), handle, *job, Some(preview)));
            }
            #[cfg(test)]
            WorkerCmd::Shutdown => break,
        }
    }
}

/// Every `<app_dir>/abd/<account>/job.json` the last daemon left: unfinished
/// jobs resume, finished and unreadable ones are only listed.
fn adopt_existing(state: &Arc<DaemonState>) {
    let Ok(rd) = std::fs::read_dir(state.app_dir.join("abd")) else { return };
    let now = state.clock.now_ms();
    for entry in rd.flatten() {
        let account_id = entry.file_name().to_string_lossy().to_string();
        let Ok(dir) = jobfile::job_dir(&state.app_dir, &account_id) else { continue };
        if !dir.is_dir() {
            continue;
        }
        match jobfile::load_job(&dir) {
            Ok(None) => {}
            Err(e) => {
                warn!("abd: {account_id}: {e}");
                lock(&state.abd.jobs).insert(account_id.clone(), JobHandle::unreadable(&account_id, &e, now));
            }
            Ok(Some(mut job)) => {
                if !job.status.is_finished() && job.folders.is_empty() {
                    // Killed while it was being prepared: the dry run is gone, so it cannot go on.
                    job.status = JobStatus::Failed { error: INTERRUPTED_WHILE_PLANNING.to_string() };
                    job.finished_ms = Some(now);
                    job.updated_ms = now;
                    if let Err(e) = jobfile::save_job(&dir, &job) {
                        warn!("abd: {account_id}: could not mark the interrupted job: {e}");
                    }
                }
                let handle = JobHandle::new(&job);
                lock(&state.abd.jobs).insert(account_id.clone(), Arc::clone(&handle));
                if job.status.is_finished() {
                    continue;
                }
                if let Some(hint) = job.mirror_hint.as_deref().filter(|p| std::path::Path::new(p).is_dir()) {
                    lock(&state.abd.mirrors).entry(account_id.clone()).or_insert_with(|| hint.to_string());
                }
                if matches!(job.status, JobStatus::Paused { reason: PauseReason::User }) {
                    // The engine's gate parks a job whose pause flag is set.
                    handle.ctl.pause.store(true, SeqCst);
                }
                info!("abd: resuming the job of {account_id}");
                tokio::task::spawn_local(run_job(Arc::clone(state), handle, job, None));
            }
        }
    }
}

/// The frames `abd.status` answers for: every handle, and any job directory
/// not (yet) adopted, read from disk.
pub(crate) fn all_frames(state: &Arc<DaemonState>, only: Option<&str>) -> Vec<Value> {
    let mut frames: Vec<(String, Value)> = lock(&state.abd.jobs)
        .iter()
        .filter(|(a, _)| only.map_or(true, |o| o == a.as_str()))
        .map(|(a, h)| (a.clone(), h.frame()))
        .collect();
    if let Ok(rd) = std::fs::read_dir(state.app_dir.join("abd")) {
        let now = state.clock.now_ms();
        for entry in rd.flatten() {
            let account_id = entry.file_name().to_string_lossy().to_string();
            if only.map_or(false, |o| o != account_id) || frames.iter().any(|(a, _)| *a == account_id) {
                continue;
            }
            let Ok(dir) = jobfile::job_dir(&state.app_dir, &account_id) else { continue };
            match jobfile::load_job(&dir) {
                Ok(None) => {}
                Ok(Some(job)) => frames.push((account_id, progress_frame(&job, &FrameInfo::default()))),
                Err(e) => frames.push((account_id.clone(), unreadable_frame(&account_id, &e, now))),
            }
        }
    }
    frames.sort_by(|a, b| a.0.cmp(&b.0));
    frames.into_iter().map(|(_, f)| f).collect()
}

// ── The Env the engine runs in ─────────────────────────────────────────────

/// The user's limits are read from `frontend-settings.json`; the engine asks
/// before every message, so the parsed file is kept for a moment. The day's
/// usage is always read afresh.
const LIMITS_TTL: Duration = Duration::from_secs(2);

#[derive(Default)]
struct LimitsCache {
    at: Option<Instant>,
    limits: Option<transfer_limits::TransferLimits>,
}

#[derive(Default)]
struct EmitGate {
    last_at: Option<Instant>,
    last_status: Option<Value>,
    finished_sent: bool,
}

pub(crate) struct DaemonEnv {
    state: Arc<DaemonState>,
    handle: Arc<JobHandle>,
    account_id: String,
    host: String,
    graph: bool,
    dir: PathBuf,
    gate: Mutex<EmitGate>,
    limits: Mutex<LimitsCache>,
}

impl DaemonEnv {
    fn new(state: &Arc<DaemonState>, handle: &Arc<JobHandle>, job: &JobFile, graph: bool) -> Result<DaemonEnv, String> {
        Ok(DaemonEnv {
            state: Arc::clone(state),
            handle: Arc::clone(handle),
            account_id: job.account_id.clone(),
            host: job.host.clone(),
            graph,
            dir: jobfile::job_dir(&state.app_dir, &job.account_id)?,
            gate: Mutex::new(EmitGate::default()),
            limits: Mutex::new(LimitsCache::default()),
        })
    }

    fn cached_limits(&self) -> Option<transfer_limits::TransferLimits> {
        let mut g = lock(&self.limits);
        if g.at.map_or(true, |t| t.elapsed() > LIMITS_TTL) {
            g.limits = transfer_limits::read_limits(&self.state.app_dir, &self.account_id);
            g.at = Some(Instant::now());
        }
        g.limits.clone()
    }

    fn info(&self) -> FrameInfo {
        FrameInfo {
            daily_limit: self.daily_limit(),
            allowance_left: self.allowance_left(),
            ..FrameInfo::default()
        }
    }

    /// A frame for `job` as it stands, sent under the usual throttle.
    fn emit_job(&self, job: &JobFile) {
        self.emit(&progress_frame(job, &self.info()));
    }
}

impl Env for DaemonEnv {
    fn now_ms(&self) -> i64 {
        self.state.clock.now_ms()
    }

    async fn sleep_until(&self, until_ms: i64, ctl: &Control) {
        loop {
            let now = self.state.clock.now_ms();
            if now >= until_ms || ctl.cancel.load(SeqCst) || ctl.pause.load(SeqCst) {
                return;
            }
            let slice = Duration::from_millis((until_ms - now) as u64).min(SLEEP_POLL);
            // A wake (the user's Resume, a Cancel) ends the wait early, as the
            // trait says: the engine looks at its flags and tries again.
            tokio::select! {
                _ = tokio::time::sleep(slice) => {}
                _ = ctl.wake.notified() => return,
            }
        }
    }

    fn allowance_left(&self) -> Option<u64> {
        let limit = transfer_limits::background_down_limit(self.cached_limits().as_ref(), &self.host)?;
        let day = transfer_limits::day_key(self.state.clock.now_ms());
        let used = mailvault_core::transfer_stats::usage_on(&self.state.app_dir, &self.account_id, &day).down;
        Some(limit.saturating_sub(used))
    }

    fn daily_limit(&self) -> Option<u64> {
        transfer_limits::background_down_limit(self.cached_limits().as_ref(), &self.host)
    }

    async fn yield_to_foreground(&self) {
        crate::search_index::wait_foreground_quiet(&self.state.search_index).await;
    }

    fn save(&self, job: &JobFile) -> Result<(), String> {
        jobfile::save_job(&self.dir, job)
    }

    fn save_plan(&self, name: &str, plan: &FolderPlan) -> Result<(), String> {
        jobfile::save_plan(&self.dir, name, plan)
    }

    fn save_allmail(&self, map: &AllMailMap) -> Result<(), String> {
        jobfile::save_allmail(&self.dir, map)
    }

    fn emit(&self, frame: &Value) {
        #[cfg(test)]
        lock(&self.state.abd.test.emit_threads).push(std::thread::current().name().unwrap_or("").to_string());
        let finished = frame.get("finished").and_then(Value::as_bool) == Some(true);
        let status = frame.get("status").cloned();
        let send = {
            let mut g = lock(&self.gate);
            if g.finished_sent {
                false
            } else {
                let changed = g.last_status != status;
                let due = g.last_at.map_or(true, |t| t.elapsed() >= EMIT_EVERY);
                let go = finished || changed || due;
                if go {
                    g.last_at = Some(Instant::now());
                    g.last_status = status;
                    g.finished_sent = finished;
                }
                go
            }
        };
        if send {
            self.state.events.emit(PROGRESS_EVENT, frame.clone());
        }
        // After the event: whoever sees a finished job in `last_frame` has
        // already had its finished frame on the bus.
        *lock(&self.handle.last_frame) = frame.clone();
    }

    fn has_credentials(&self) -> bool {
        !self.graph || self.state.abd.tokens.fresh(&self.account_id, self.state.clock.now_ms()).is_some()
    }
}

// ── Ops the daemon drives ──────────────────────────────────────────────────

/// What the driver needs from an ops object beyond `ServerOps`.
trait JobOps: ServerOps {
    /// Before every run: fresh credentials (IMAP) or the plan's uid -> Graph id map.
    fn prepare(&mut self, plans: &PlanStore, cfg: &ImapConfig);
}

impl JobOps for ImapOps {
    fn prepare(&mut self, _plans: &PlanStore, cfg: &ImapConfig) {
        self.set_config(cfg.clone());
    }
}

impl JobOps for GraphOps {
    fn prepare(&mut self, plans: &PlanStore, _cfg: &ImapConfig) {
        for name in plans.names() {
            if let Some(p) = plans.get(&name) {
                self.remember_plan(p);
            }
        }
    }
}

fn new_imap_ops(state: &Arc<DaemonState>, cfg: ImapConfig) -> ImapOps {
    let ops = ImapOps::new(Arc::clone(&state.imap_pool), cfg);
    #[cfg(test)]
    if let Some(g) = *lock(&state.abd.test.gmail_host) {
        return ops.with_gmail_host(g);
    }
    ops
}

fn new_graph_ops(state: &Arc<DaemonState>, email: &str, account_id: &str) -> GraphOps {
    let leases: Arc<dyn LeaseStore> = Arc::new(AccountLease { state: Arc::clone(state), account_id: account_id.to_string() });
    let st = Arc::clone(state);
    GraphOps::new(email, leases).with_clock(Arc::new(move || st.clock.now_ms()))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Password,
    ImapOauth,
    Graph,
}

fn kind_of(cfg: &ImapConfig) -> Kind {
    if cfg.oauth2_transport.as_deref() == Some("graph") {
        Kind::Graph
    } else if cfg.is_oauth2() {
        Kind::ImapOauth
    } else {
        Kind::Password
    }
}

/// The config a connection is made with: an OAuth IMAP account uses the
/// lease the app pushed while it is good, else what the keychain holds.
fn with_lease(state: &Arc<DaemonState>, mut cfg: ImapConfig, account_id: &str) -> (ImapConfig, u64) {
    let mut seq = 0;
    if kind_of(&cfg) == Kind::ImapOauth {
        if let Some(l) = state.abd.tokens.fresh(account_id, state.clock.now_ms()) {
            cfg.access_token = Some(l.token);
            seq = state.abd.tokens.seq(account_id);
        }
    }
    (cfg, seq)
}

// ── One job ─────────────────────────────────────────────────────────────────

async fn run_job(state: Arc<DaemonState>, handle: Arc<JobHandle>, job: JobFile, preview: Option<Arc<PreviewListing>>) {
    let email = job.account_email.clone();
    let task = job_main(Arc::clone(&state), Arc::clone(&handle), job, preview);
    let outcome = std::panic::AssertUnwindSafe(mailvault_core::net_activity::with_account(email, task))
        .catch_unwind()
        .await;
    if outcome.is_err() {
        error!("abd: the job task of {} panicked; it stays resumable", handle.account_id);
    }
    handle.finished.store(true, SeqCst);
}

struct Rt {
    state: Arc<DaemonState>,
    handle: Arc<JobHandle>,
    env: DaemonEnv,
    local: DaemonLocal,
    kind: Kind,
    /// The token generation the current connection config was built with.
    used_seq: Cell<u64>,
}

async fn job_main(state: Arc<DaemonState>, handle: Arc<JobHandle>, mut job: JobFile, preview: Option<Arc<PreviewListing>>) {
    let account_id = job.account_id.clone();
    // The kind is known only once the credentials are read; the Env needs it for
    // the token check, so it starts as a password account and is set below.
    let env = match DaemonEnv::new(&state, &handle, &job, false) {
        Ok(e) => e,
        Err(e) => {
            warn!("abd: {account_id}: {e}");
            handle.finished.store(true, SeqCst);
            return;
        }
    };
    let mut plans = match &preview {
        Some(_) => PlanStore::new(),
        None => match jobfile::load_plans(&env.dir).and_then(|p| jobfile::load_allmail(&env.dir).map(|a| PlanStore::from_parts(p, a))) {
            Ok(p) => p,
            Err(e) => {
                fail(&state, &handle, &env, &mut job, format!("The saved plan could not be read: {e}"));
                return;
            }
        },
    };
    let Some(cfg) = resolve_config(&state, &handle, &env, &mut job).await else {
        settle_cancelled(&state, &handle, &env, &mut job);
        return;
    };
    let kind = kind_of(&cfg);
    let env = DaemonEnv { graph: kind == Kind::Graph, ..env };
    let local = DaemonLocal::new(Arc::clone(&state), &account_id, &job.account_email);
    let rt = Rt { state: Arc::clone(&state), handle: Arc::clone(&handle), env, local, kind, used_seq: Cell::new(0) };
    if kind == Kind::Graph {
        let mut ops = new_graph_ops(&state, &cfg.email, &account_id);
        rt.drive(&mut job, &mut plans, &mut ops, preview, &cfg).await;
    } else {
        let (effective, seq) = with_lease(&state, cfg.clone(), &account_id);
        rt.used_seq.set(seq);
        let mut ops = new_imap_ops(&state, effective);
        rt.drive(&mut job, &mut plans, &mut ops, preview, &cfg).await;
    }
}

/// Read the account's credentials, waiting (and saying why) while the keychain
/// is locked or the account is gone. `None` when the user cancelled meanwhile.
async fn resolve_config(
    state: &Arc<DaemonState>,
    handle: &Arc<JobHandle>,
    env: &DaemonEnv,
    job: &mut JobFile,
) -> Option<ImapConfig> {
    loop {
        if handle.ctl.cancel.load(SeqCst) {
            return None;
        }
        match credentials::resolve_account_credentials_quiet(&job.account_id).await {
            Ok(c) => return Some(c),
            Err(_) => {
                job.status = if credentials::GATE.is_blocked() {
                    JobStatus::Waiting { reason: WaitReason::Keychain, until_ms: None }
                } else {
                    JobStatus::Paused { reason: PauseReason::AccountMissing }
                };
                job.updated_ms = state.clock.now_ms();
                let _ = env.save(job);
                env.emit_job(job);
                tokio::select! {
                    _ = handle.ctl.wake.notified() => {}
                    _ = tokio::time::sleep(CREDENTIAL_POLL) => {}
                }
            }
        }
    }
}

fn end_job(state: &Arc<DaemonState>, handle: &Arc<JobHandle>, env: &DaemonEnv, job: &mut JobFile, status: JobStatus) {
    let now = state.clock.now_ms();
    job.status = status;
    job.finished_ms = Some(now);
    job.updated_ms = now;
    if let Err(e) = env.save(job) {
        warn!("abd: {}: could not save the end of the job: {e}", job.account_id);
    }
    env.emit_job(job);
    handle.finished.store(true, SeqCst);
}

fn settle_cancelled(state: &Arc<DaemonState>, handle: &Arc<JobHandle>, env: &DaemonEnv, job: &mut JobFile) {
    end_job(state, handle, env, job, JobStatus::Cancelled);
}

fn fail(state: &Arc<DaemonState>, handle: &Arc<JobHandle>, env: &DaemonEnv, job: &mut JobFile, error: String) {
    end_job(state, handle, env, job, JobStatus::Failed { error });
}

impl Rt {
    fn ctl(&self) -> &Control {
        &self.handle.ctl
    }

    fn cancelled(&self) -> bool {
        self.ctl().cancel.load(SeqCst)
    }

    /// The config for the next run: the keychain's latest, with the lease over it.
    async fn next_config(&self, fallback: &ImapConfig) -> ImapConfig {
        let base = match credentials::resolve_account_credentials_quiet(&self.env.account_id).await {
            Ok(c) => c,
            Err(_) => fallback.clone(),
        };
        let (cfg, seq) = with_lease(&self.state, base, &self.env.account_id);
        self.used_seq.set(seq);
        cfg
    }

    /// Plan (a fresh job), then run; when a run pauses for something outside
    /// the daemon, wait for it in place and run again. One task per job.
    async fn drive<S: JobOps>(
        &self,
        job: &mut JobFile,
        plans: &mut PlanStore,
        ops: &mut S,
        preview: Option<Arc<PreviewListing>>,
        cfg: &ImapConfig,
    ) {
        let mut planned = preview.is_none();
        let mut first = true;
        loop {
            let effective = if first { with_lease(&self.state, cfg.clone(), &self.env.account_id).0 } else { self.next_config(cfg).await };
            first = false;
            if let Some(m) = self.state.abd.mirror(&job.account_id) {
                job.mirror_hint = Some(m);
            }
            ops.prepare(plans, &effective);
            let exit = match (&preview, planned) {
                (Some(p), false) => match plan_job(job, p, plans, ops, &self.local, &self.env, self.ctl()).await {
                    RunExit::Completed => {
                        planned = true;
                        continue;
                    }
                    other => other,
                },
                _ => run(job, &*plans, ops, &self.local, &self.env, self.ctl()).await,
            };
            match exit {
                RunExit::Paused(reason) => {
                    ops.release().await;
                    self.park(job, reason).await;
                }
                done => {
                    ops.release().await;
                    self.finish(job, done);
                    return;
                }
            }
        }
    }

    /// The engine settled the job (status saved, terminal frame sent). If a
    /// failed save left it unsettled, settle it in memory and say so.
    fn finish(&self, job: &mut JobFile, exit: RunExit) {
        if !job.status.is_finished() {
            let status = match exit {
                RunExit::Cancelled => JobStatus::Cancelled,
                RunExit::Failed(e) => JobStatus::Failed { error: e },
                _ => JobStatus::Completed,
            };
            end_job(&self.state, &self.handle, &self.env, job, status);
        } else {
            // A no-op when the engine's own terminal frame already went out.
            self.env.emit_job(job);
            self.handle.finished.store(true, SeqCst);
        }
    }

    /// Wait until `cond` holds, the job is woken or cancelled, or `retry`
    /// passes; never less than `min`. Returns to run the job again.
    async fn wait_until(&self, min: Duration, retry: Option<Duration>, mut cond: impl FnMut() -> bool) {
        let started = Instant::now();
        loop {
            if self.cancelled() {
                return;
            }
            let waited = started.elapsed();
            if waited >= min && (cond() || retry.map_or(false, |r| waited >= r)) {
                return;
            }
            tokio::select! {
                _ = self.ctl().wake.notified() => return,
                _ = tokio::time::sleep(PARK_POLL) => {}
            }
        }
    }

    async fn park(&self, job: &JobFile, reason: PauseReason) {
        let account = job.account_id.clone();
        let (what, min) = match reason {
            PauseReason::SignInNeeded => (Some(Parked::Token), Duration::ZERO),
            PauseReason::DriveUnavailable => (Some(Parked::Drive), Duration::from_secs(1)),
            PauseReason::VaultUnavailable => (Some(Parked::Vault), Duration::from_secs(5)),
            PauseReason::User | PauseReason::AccountMissing => (None, Duration::from_secs(1)),
        };
        *lock(&self.handle.parked) = what;
        let st = &self.state;
        match reason {
            PauseReason::SignInNeeded => {
                if self.kind != Kind::Password {
                    let provider = if self.kind == Kind::Graph { "graph" } else { "imap_oauth" };
                    st.events.emit(TOKEN_EVENT, json!({"accountId": account, "jobId": job.job_id, "provider": provider}));
                }
                let used = self.used_seq.get();
                match self.kind {
                    Kind::Graph => {
                        self.wait_until(min, None, || st.abd.tokens.fresh(&account, st.clock.now_ms()).is_some()).await
                    }
                    Kind::ImapOauth => {
                        self.wait_until(min, Some(SIGN_IN_RETRY), || {
                            st.abd.tokens.fresh(&account, st.clock.now_ms()).is_some() && st.abd.tokens.seq(&account) != used
                        })
                        .await
                    }
                    Kind::Password => self.wait_until(min, Some(SIGN_IN_RETRY), || false).await,
                }
            }
            PauseReason::DriveUnavailable => {
                let seen = st.abd.attach_seq(&account);
                let mut last_probe = Instant::now();
                self.wait_until(min, None, || {
                    if st.abd.attach_seq(&account) != seen {
                        return true;
                    }
                    if last_probe.elapsed() >= DRIVE_PROBE {
                        last_probe = Instant::now();
                        return st.abd.mirror(&account).map_or(false, |m| std::path::Path::new(&m).is_dir());
                    }
                    false
                })
                .await
            }
            PauseReason::VaultUnavailable => {
                self.wait_until(min, Some(VAULT_RETRY), || common::vault_root(st).is_ok()).await
            }
            PauseReason::User | PauseReason::AccountMissing => self.wait_until(min, Some(Duration::from_secs(5)), || false).await,
        }
        *lock(&self.handle.parked) = None;
    }
}

// ── The dry run ─────────────────────────────────────────────────────────────

fn emit_preview(state: &Arc<DaemonState>, account_id: &str, preview_id: &str, st: &str, folder: Option<&str>, listed: usize, error: Option<&str>) {
    let mut p = json!({"accountId": account_id, "previewId": preview_id, "state": st, "folder": folder, "listed": listed});
    if let Some(e) = error {
        p["error"] = Value::String(e.to_string());
    }
    state.events.emit(PREVIEW_EVENT, p);
}

async fn do_preview(state: Arc<DaemonState>, account_id: String, preview_id: String) {
    emit_preview(&state, &account_id, &preview_id, "listing", None, 0, None);
    match preview_inner(&state, &account_id, &preview_id).await {
        Ok(entry) => {
            let total: usize = entry.listing.folders.iter().map(|f| f.2.len()).sum::<usize>()
                + entry.listing.all_mail.as_ref().map_or(0, |a| a.2.len());
            {
                let mut g = lock(&state.abd.previews);
                g.retain(|_, p| p.made.elapsed() <= PREVIEW_TTL);
                g.insert(account_id.clone(), entry);
            }
            emit_preview(&state, &account_id, &preview_id, "ready", None, total, None);
        }
        Err(e) => {
            warn!("abd: preview of {account_id} failed: {e}");
            emit_preview(&state, &account_id, &preview_id, "failed", None, 0, Some(&e));
        }
    }
}

async fn preview_inner(state: &Arc<DaemonState>, account_id: &str, preview_id: &str) -> Result<Arc<PreviewEntry>, String> {
    jobfile::job_dir(&state.app_dir, account_id)?;
    let cfg = credentials::resolve_account_credentials_quiet(account_id).await?;
    let (email, host) = (cfg.email.clone(), cfg.host.clone());
    let now = state.clock.now_ms();
    let listing = {
        let mut progress = |folder: &str, n: usize| emit_preview(state, account_id, preview_id, "listing", Some(folder), n, None);
        mailvault_core::net_activity::with_account(email.clone(), async {
            if kind_of(&cfg) == Kind::Graph {
                let mut ops = new_graph_ops(state, &cfg.email, account_id);
                let p = build_preview(&mut ops, preview_id, now, &mut progress).await.map_err(|e| e.text())?;
                fill_graph_uids(state, account_id, p).await
            } else {
                let (effective, _) = with_lease(state, cfg.clone(), account_id);
                let mut ops = new_imap_ops(state, effective);
                let r = build_preview(&mut ops, preview_id, now, &mut progress).await.map_err(|e| e.text());
                ops.release().await;
                r
            }
        })
        .await?
    };
    Ok(Arc::new(PreviewEntry {
        preview_id: preview_id.to_string(),
        listing: Arc::new(listing),
        email,
        host,
        made: Instant::now(),
        counts: Mutex::new(None),
    }))
}

/// A Graph listing has no uids. For the "already archived" count only, give
/// the messages the ledger already knows their uid. Read-only: a dry run never
/// writes the ledger (the plan freeze allocates).
async fn fill_graph_uids(state: &Arc<DaemonState>, account_id: &str, mut p: PreviewListing) -> Result<PreviewListing, String> {
    let Ok(root) = common::vault_root(state) else { return Ok(p) };
    let account = account_id.to_string();
    common::blocking(move || {
        for (info, _, msgs) in p.folders.iter_mut() {
            let path = root
                .join("email_cache")
                .join(header_cache::cache_base_name(&account, &info.path))
                .join(graph_ledger::LEDGER_FILE);
            let Ok(ledger) = graph_ledger::load(&path) else { continue };
            let by_id: HashMap<&str, u32> = ledger.iter().map(|(uid, id)| (id.as_str(), *uid)).collect();
            for m in msgs.iter_mut() {
                if let Some(u) = m.graph_id.as_deref().and_then(|g| by_id.get(g)) {
                    m.uid = *u;
                }
            }
        }
        p
    })
    .await
}
