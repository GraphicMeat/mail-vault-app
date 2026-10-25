//! Native account-backup lifecycle, admission and retained completion.
use crate::{
    handlers::{backup as adapter, common},
    ipc::{self, RpcResponse},
    server::DaemonState,
};
use mailvault_core::{
    app_db::{self, db},
    backup_access::Resolution as AccessResolution,
    backup_schedule as policy,
    settings_doc::{SettingsDoc, SettingsError},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::SeqCst},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::{
    mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
    oneshot,
};

#[path = "backup_access.rs"]
mod access;
#[path = "backup_context.rs"]
mod context;
#[path = "backup_snapshot.rs"]
mod snapshots;

const META: &str = "backup.scheduler.v1";
const STORE: &str = "mailvault-settings";
const EVENT: &str = "backup-schedule-changed";
const STALL_MS: i64 = 900_000;

#[derive(Default)]
pub(crate) struct BackupState {
    access: access::State,
    tx: OnceLock<UnboundedSender<Cmd>>,
    view: Mutex<Value>,
    controls: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // Kept outside the provider task. A provider panic cannot prove its nested
    // blocking work drained; retain real admission until process termination.
    uncertain: Mutex<Vec<adapter::BackupRunGuard>>,
    epoch: AtomicU64,
    progress: AtomicI64,
    execution: Mutex<Option<String>>,
    facts: Mutex<Facts>,
    context: Mutex<context::Context>,
    #[cfg(test)]
    snapshot_barrier: Mutex<Option<(oneshot::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    #[cfg(test)]
    pending_access_exit: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    #[cfg(test)]
    pending_limit_exit: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    #[cfg(test)]
    scans_in_flight: std::sync::atomic::AtomicUsize,
}
impl BackupState {
    pub(crate) fn retain_uncertain(&self, guard: adapter::BackupRunGuard) {
        self.uncertain
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(guard);
    }
    fn note_progress(&self, now: i64) {
        self.progress.store(now, SeqCst);
    }
    pub(crate) fn observe_execution(&self, execution: &str, now: i64) -> bool {
        if self
            .execution
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_deref()
            != Some(execution)
        {
            return false;
        }
        self.note_progress(now);
        true
    }
    pub(crate) fn owns_token(&self, token: &Arc<AtomicBool>) -> bool {
        self.controls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .any(|t| Arc::ptr_eq(t, token))
    }
    pub(crate) fn status(&self) -> Value {
        let mut view = self.view.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(run) = view["active"]["runId"].as_str() {
            let stopping = self
                .controls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(run)
                .is_some_and(|t| t.load(SeqCst));
            if stopping
                && !matches!(
                    view["active"]["stage"].as_str(),
                    Some("uncertain" | "stopping_stall")
                )
            {
                view["active"]["stage"] = json!("stopping");
            }
        }
        if view.is_null() {
            json!({"revision":0,"queue":[],"active":null,"pendingAccess":[],"lastOutcomes":[],"automaticOwner":"daemon","ready":false})
        } else {
            view["accessIncarnation"] = json!(self.access.incarnation);
            view["accessReceipts"] = self.access.receipts();
            let facts = self.facts.lock().unwrap_or_else(|p| p.into_inner());
            view["context"] = json!({"automaticEnabled":facts.automatic,"paused":facts.paused,"loading":facts.loading,"lastActivityAt":facts.last_activity});
            view
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    account_id: String,
    run_id: String,
    execution_id: String,
    manual: bool,
    requests: Vec<String>,
    stage: String,
    retries: usize,
    not_before: i64,
    checkpoint: usize,
    #[serde(default)]
    pause_requested: bool,
    #[serde(default)]
    cap: Value,
    #[serde(default)]
    hold: bool,
    last_progress: i64,
    #[serde(default)]
    cancel_requested: bool,
    epoch: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    intent: Intent,
    status: String,
    at: i64,
    result: Option<Value>,
    terminal: Option<Value>,
    error: Option<String>,
    applied: bool,
    #[serde(default)]
    snapshot: Value,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    #[serde(default)]
    epoch: u64,
    revision: u64,
    queue: Vec<Intent>,
    active: Option<Intent>,
    outcomes: Vec<Outcome>,
    requests: BTreeMap<String, Value>,
}
impl Ledger {
    fn view(&self) -> Value {
        json!({"revision":self.revision,"queue":self.queue,"active":self.active,
            "pendingAccess":self.queue.iter().filter(|i| i.stage == "pending_access").collect::<Vec<_>>(),
            "lastOutcomes":self.outcomes.iter().map(outcome_view).collect::<Vec<_>>(),"requests":self.requests,"automaticOwner":"daemon","ready":true})
    }
}
fn outcome_view(out: &Outcome) -> Value {
    let mut value = serde_json::to_value(out).expect("serializable backup outcome");
    let result = out.result.as_ref();
    let degraded = result.is_some_and(|r| {
        r["errors"].as_u64().unwrap_or(0) > 0
            || r["external_copy_ok"] == false
            || r["external_copy_failed_count"].as_u64().unwrap_or(0) > 0
    });
    let title = if out.status == "success" {
        if degraded {
            "svc.backupScheduler.partialTitle"
        } else {
            "svc.backupScheduler.completedTitle"
        }
    } else {
        "svc.backupScheduler.failedTitle"
    };
    value["presentation"] = json!({"titleKey":title,"countKey":"svc.backupScheduler.completedCount","count":result.and_then(|r|r["emails_backed_up"].as_u64()).unwrap_or(0),"accountId":out.intent.account_id});
    value
}
#[derive(Clone)]
struct Facts {
    automatic: bool,
    paused: bool,
    loading: bool,
    last_activity: i64,
}
impl Default for Facts {
    fn default() -> Self {
        Self {
            automatic: true,
            paused: false,
            loading: false,
            last_activity: 0,
        }
    }
}
enum Cmd {
    SnapshotFinished {
        run: String,
        execution: String,
        result: Result<Value, String>,
        at: i64,
    },
    Context {
        observation: context::Observation,
        reply: oneshot::Sender<Value>,
    },
    RetireSurface(String),
    SurfaceGenerationLost(String),
    ConfigChanged {
        rearm: bool,
    },
    #[cfg(test)]
    Probe {
        done: oneshot::Sender<()>,
    },
    #[cfg(test)]
    AccessIdle {
        done: oneshot::Sender<bool>,
    },
    #[cfg(test)]
    PauseManual {
        armed: oneshot::Sender<()>,
        entered: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
    },
    #[cfg(test)]
    PauseFinished {
        armed: oneshot::Sender<()>,
        entered: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
    },

    #[cfg(test)]
    Facts(Facts),
    Manual {
        account: String,
        request: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Wake,
    Access {
        request: access::Request,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    OwnerLost(String),
    Cancel {
        run: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Stop {
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Running {
        run: String,
        execution: String,
        cap: Value,
    },
    Finished {
        run: String,
        execution: String,
        exit: RunExit,
    },
    Due {
        epoch: u64,
        ids: Vec<String>,
    },
    #[cfg(test)]
    Shutdown,
}
type Resolve = Arc<
    dyn Fn(
            Arc<DaemonState>,
            String,
            bool,
        )
            -> Pin<Box<dyn Future<Output = Result<mailvault_core::imap::ImapConfig, String>> + Send>>
        + Send
        + Sync,
>;
#[derive(Clone)]
struct Services {
    resolve: Resolve,
    provider: adapter::Provider,
}
enum RunExit {
    Pending(String),
    PendingAccess {
        observed: Option<mailvault_core::backup_access::Attempt>,
    },
    Completed(adapter::JoinedBackup),
    Credentials(String),
    Missing,
}
impl RunExit {
    fn pending_stage(&self) -> Option<&str> {
        match self {
            Self::Pending(stage) => Some(stage),
            Self::PendingAccess { .. } => Some("pending_access"),
            _ => None,
        }
    }
}
impl Default for Services {
    fn default() -> Self {
        Self {
            resolve: Arc::new(|state, id, manual| {
                Box::pin(async move {
                    crate::oauth_tokens::resolve(
                        &state,
                        &id,
                        if manual {
                            crate::oauth_tokens::Read::Guarded
                        } else {
                            crate::oauth_tokens::Read::Quiet
                        },
                    )
                    .await
                })
            }),
            provider: adapter::provider(),
        }
    }
}
fn read_ledger(path: &Path) -> Result<Ledger, String> {
    app_db::with(path, |conn| {
        let raw: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key=?1", [META], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|s| serde_json::from_str(&s).map_err(|_| "errors.settingsInvalid".into()))
            .unwrap_or_else(|| Ok(Ledger::default()))
    })
}
fn save_ledger(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let bytes = serde_json::to_string(ledger).map_err(|e| e.to_string())?;
    app_db::with(path, |conn| {
        db::in_txn(conn, || db::meta_set(conn, META, &bytes))
    })
}
fn compact_outcomes(ledger: &mut Ledger) {
    // Unacknowledged outcomes remain replayable. Applied history is bounded
    // before publication, including the same write that settles a request.
    let mut seen = HashMap::<String, usize>::new();
    ledger.outcomes.reverse();
    ledger.outcomes.retain(|out| {
        if !out.applied || !snapshots::settled(&out.snapshot) {
            return true;
        }
        let count = seen.entry(out.intent.account_id.clone()).or_default();
        *count += 1;
        *count <= 5
    });
    ledger.outcomes.reverse();
}
async fn publish(state: &Arc<DaemonState>, ledger: &mut Ledger) -> Result<(), String> {
    compact_outcomes(ledger);
    if let Some(i) = &ledger.active {
        access::set_phase(state, &i.execution_id, &i.stage);
    }
    ledger.epoch = state.backup_worker.epoch.load(SeqCst);
    ledger.revision = ledger.revision.saturating_add(1);
    let path = state.app_dir.clone();
    let copy = ledger.clone();
    common::blocking(move || save_ledger(&path, &copy)).await??;
    let mut view = ledger.view();
    view["accessIncarnation"] = json!(state.backup_worker.access.incarnation);
    *state
        .backup_worker
        .view
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = view.clone();
    state.events.emit(EVENT, view);
    if ledger.queue.iter().any(|i| i.stage == "pending_access") {
        state.events.emit(
            "backup-access-needed",
            json!({"incarnation":state.backup_worker.access.incarnation}),
        );
    }
    Ok(())
}
fn response(intent: &Intent) -> Value {
    json!({"runId":intent.run_id,"executionId":intent.execution_id,"accountId":intent.account_id,"status":intent.stage})
}
pub(crate) fn start(state: Arc<DaemonState>) {
    let (tx, rx) = unbounded_channel();
    if state.backup_worker.tx.set(tx).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("backup-worker".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(move || {
            #[cfg(target_os = "macos")]
            unsafe {
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
            }
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(tokio::task::LocalSet::new().run_until(worker_loop(
                    state,
                    rx,
                    Services::default(),
                )));
            }
        });
    if spawned.is_err() {
        tracing::warn!("backup worker did not start");
    }
}
fn refresh_context(state: &Arc<DaemonState>) {
    let c = state.backup_worker.context.lock().unwrap();
    // Tests may inject the accepted legacy Facts seam directly.
    if !c.observed() {
        return;
    }
    let mut facts = state.backup_worker.facts.lock().unwrap();
    facts.loading = c.loading();
    facts.paused = c.paused(state.clock.now_ms());
    facts.last_activity = facts.last_activity.max(c.last_activity);
}
fn automatic_ready(state: &Arc<DaemonState>) -> bool {
    let f = state.backup_worker.facts.lock().unwrap();
    f.automatic
        && !f.paused
        && !f.loading
        && state.clock.now_ms().saturating_sub(f.last_activity) >= 180_000
}
async fn interrupt_paused(state: &Arc<DaemonState>, ledger: &mut Ledger) {
    if !state
        .backup_worker
        .context
        .lock()
        .unwrap()
        .interrupted(state.clock.now_ms())
    {
        return;
    }
    if let Some(i) = ledger
        .active
        .as_mut()
        .filter(|i| !i.manual && !i.cancel_requested && i.stage != "uncertain")
    {
        i.pause_requested = true;
        i.stage = "pausing".into();
        if let Some(token) = state.backup_worker.controls.lock().unwrap().get(&i.run_id) {
            token.store(true, SeqCst);
        }
        let _ = publish(state, ledger).await;
    }
}
fn next_queued_deadline(state: &Arc<DaemonState>, ledger: &Ledger) -> Option<tokio::time::Instant> {
    let now = state.clock.now_ms();
    let f = state.backup_worker.facts.lock().unwrap().clone();
    if !f.automatic {
        return None;
    }
    let mut deadlines = vec![];
    if let Some(at) = state.backup_worker.context.lock().unwrap().deadline(now) {
        deadlines.push(at);
    }
    if !f.loading && !f.paused && f.last_activity.saturating_add(180_000) > now {
        deadlines.push(f.last_activity.saturating_add(180_000));
    }
    if ledger.active.is_none() && automatic_ready(state) {
        deadlines.extend(
            ledger
                .queue
                .iter()
                .filter(|i| !i.cancel_requested && i.not_before > now)
                .map(|i| i.not_before),
        );
    }
    deadlines.into_iter().min().and_then(|at| {
        tokio::time::Instant::now()
            .checked_add(Duration::from_millis(at.saturating_sub(now) as u64))
    })
}

async fn worker_loop(state: Arc<DaemonState>, mut rx: UnboundedReceiver<Cmd>, services: Services) {
    let path = state.app_dir.clone();
    let mut ledger = match common::blocking(move || read_ledger(&path)).await {
        Ok(Ok(l)) => l,
        _ => {
            *state.backup_worker.view.lock().unwrap() =
                json!({"ready":false,"error":"errors.settingsNotLoaded"});
            return;
        }
    };
    state.backup_worker.epoch.store(ledger.epoch, SeqCst);
    if snapshots::recover(&mut ledger) {
        if publish(&state, &mut ledger).await.is_err() {
            return;
        }
    }
    // A fresh daemon has no surviving in-process execution. An ordinal alone
    // does not prove folder ordering; restart always resumes incrementally at 0.
    if let Some(mut interrupted) = ledger.active.take() {
        interrupted.execution_id = uuid::Uuid::new_v4().to_string();
        interrupted.checkpoint = 0;
        if interrupted.cancel_requested {
            let out = Outcome {
                intent: interrupted,
                status: "cancelled".into(),
                at: state.clock.now_ms(),
                result: None,
                terminal: None,
                error: None,
                applied: true,
                snapshot: json!({"status":"not_due"}),
            };
            settle_requests(&mut ledger.requests, &out);
            ledger.outcomes.push(out);
        } else {
            interrupted.stage = "queued".into();
            for request in &interrupted.requests {
                ledger
                    .requests
                    .insert(request.clone(), response(&interrupted));
            }
            ledger.queue.insert(0, interrupted);
        }
        if publish(&state, &mut ledger).await.is_err() {
            return;
        }
    }
    for intent in &ledger.queue {
        state
            .backup_worker
            .controls
            .lock()
            .unwrap()
            .insert(intent.run_id.clone(), Arc::new(AtomicBool::new(false)));
    }
    *state.backup_worker.view.lock().unwrap() = ledger.view();
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    tick.tick().await;
    let mut pending_finish = None;
    let mut pending_snapshot = None;
    // A real wake consumed during an admission probe cannot be serviced until
    // that probe returns. Coalesce one recheck for that exact execution.
    let mut deferred_probe_scan: Option<String> = None;
    #[cfg(test)]
    let mut manual_barrier = None;
    #[cfg(test)]
    let mut finished_barrier = None;
    let _ = state.backup_worker.tx.get().unwrap().send(Cmd::Wake);
    loop {
        refresh_context(&state);
        let deadline = next_queued_deadline(&state, &ledger);
        let deadline_wake = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        // Recreated after every command/publication: cancel/stop and changed
        // gates cannot leave a detached retry callback or stale deadline.
        let (cmd, scan) = tokio::select! {
            cmd=rx.recv()=>match cmd {Some(cmd)=>(cmd,false),None=>return},
            _=tick.tick()=>(Cmd::Wake,true),
            _=deadline_wake=>(Cmd::Wake,true),
        };
        let mut scan = scan;
        match cmd {
            Cmd::SnapshotFinished {
                run,
                execution,
                result,
                at,
            } => {
                pending_snapshot = Some((run, execution, result, at));
            }
            Cmd::Context { observation, reply } => {
                let result = state
                    .backup_worker
                    .context
                    .lock()
                    .unwrap()
                    .observe(observation, state.clock.now_ms());
                refresh_context(&state);
                let _ = reply.send(result);
                interrupt_paused(&state, &mut ledger).await;
                scan = true;
            }
            Cmd::RetireSurface(surface) => {
                state
                    .backup_worker
                    .context
                    .lock()
                    .unwrap()
                    .retire_surface(Some(&surface));
                refresh_context(&state);
                scan = true;
            }
            Cmd::ConfigChanged { rearm } => {
                if rearm {
                    state.backup_worker.facts.lock().unwrap().automatic = true;
                }
                scan = true;
            }
            #[cfg(test)]
            Cmd::Probe { done } => {
                let _ = done.send(());
            }
            #[cfg(test)]
            Cmd::AccessIdle { done } => {
                let _ = done.send(
                    ledger.active.is_none()
                        && pending_finish.is_none()
                        && deferred_probe_scan.is_none()
                        && state.backup_worker.scans_in_flight.load(SeqCst) == 0
                        && rx.is_empty(),
                );
            }
            #[cfg(test)]
            Cmd::PauseManual {
                armed,
                entered,
                release,
            } => {
                manual_barrier = Some((entered, release));
                let _ = armed.send(());
            }
            #[cfg(test)]
            Cmd::PauseFinished {
                armed,
                entered,
                release,
            } => {
                finished_barrier = Some((entered, release));
                let _ = armed.send(());
            }
            Cmd::Manual {
                account,
                request,
                reply,
            } => {
                #[cfg(test)]
                if let Some((entered, release)) = manual_barrier.take() {
                    let _ = entered.send(());
                    let _ = release.await;
                }
                let result = admit(&state, &mut ledger, account, request).await;
                let _ = reply.send(result);
                scan = true;
            }
            Cmd::Wake => {
                scan = true;
                if let Some(active) = ledger.active.as_ref().filter(|i| i.stage == "preparing") {
                    deferred_probe_scan = Some(active.execution_id.clone());
                }
            }
            Cmd::Access { request, reply } => {
                // Reconciliation of an old hold must not repeatedly move an
                // unrelated pending execution into preparing before its next
                // status sample. Unavailable/unknown resolution is an observation,
                // not a new retry trigger. Authorized/absent attach and current
                // fence keep their admission wake.
                let wake = match &request {
                    access::Request::Attach(a) => {
                        a.attempt.incarnation == state.backup_worker.access.incarnation
                            && matches!(
                                &a.resolution,
                                AccessResolution::Authorized { .. }
                                    | AccessResolution::NotConfigured
                            )
                    }
                    access::Request::Status(q) => {
                        q.fence_unstarted
                            && q.attempt.incarnation == state.backup_worker.access.incarnation
                    }
                };
                let result = access::process(&state, &mut ledger, request).await;
                let _ = reply.send(result);
                scan |= wake;
            }
            Cmd::SurfaceGenerationLost(generation) => {
                state.backup_worker.context.lock().unwrap().retire_generation(&generation);
                refresh_context(&state); scan = true;
            }
            Cmd::OwnerLost(owner) => {
                access::interrupt_owner(&state, &mut ledger, &owner);
                scan = true;
            }
            Cmd::Cancel { run, reply } => {
                let mut next = ledger.clone();
                // Sideband cancellation may have seen an older execution's
                // token. The serialized command owns the current logical run.
                if let Some(token) = state.backup_worker.controls.lock().unwrap().get(&run) {
                    token.store(true, SeqCst);
                }
                for i in next
                    .active
                    .iter_mut()
                    .chain(next.queue.iter_mut())
                    .filter(|i| i.run_id == run)
                {
                    i.cancel_requested = true;
                    if i.stage != "uncertain" {
                        i.stage = "stopping".into();
                    }
                }
                let result = async {
                    settle_cancelled(&state, &mut next).await?;
                    publish(&state, &mut next).await?;
                    Ok(json!({"accepted":true}))
                }
                .await;
                if result.is_ok() {
                    ledger = next;
                }
                let _ = reply.send(result);
                scan = true;
            }
            Cmd::Stop { reply } => {
                // Fence every admission preceding this command, including a
                // Manual consumed after the RPC's immediate sideband epoch.
                state.backup_worker.epoch.fetch_add(1, SeqCst);
                state.backup_worker.facts.lock().unwrap().automatic = false;
                for token in state.backup_worker.controls.lock().unwrap().values() {
                    token.store(true, SeqCst);
                }
                let mut next = ledger.clone();
                for i in next.active.iter_mut().chain(next.queue.iter_mut()) {
                    i.cancel_requested = true;
                    if i.stage != "uncertain" {
                        i.stage = "stopping".into();
                    }
                }
                let result = async {
                    settle_cancelled(&state, &mut next).await?;
                    publish(&state, &mut next).await?;
                    Ok(json!({"accepted":true}))
                }
                .await;
                if result.is_ok() {
                    ledger = next;
                }
                let _ = reply.send(result);
                scan = true;
            }
            #[cfg(test)]
            Cmd::Facts(facts) => {
                *state.backup_worker.facts.lock().unwrap() = facts;
                scan = true;
                if let Some(active) = ledger.active.as_ref().filter(|i| i.stage == "preparing") {
                    deferred_probe_scan = Some(active.execution_id.clone());
                }
            }
            Cmd::Running {
                run,
                execution,
                cap,
            } => {
                if let Some(i) = ledger
                    .active
                    .as_mut()
                    .filter(|i| i.run_id == run && i.execution_id == execution)
                {
                    if !i.cancel_requested {
                        i.stage = "running".into();
                    }
                    i.cap = cap;
                    let _ = publish(&state, &mut ledger).await;
                }
            }
            Cmd::Finished {
                run,
                execution,
                exit,
            } => {
                #[cfg(test)]
                if let Some((entered, release)) = finished_barrier.take() {
                    let _ = entered.send(());
                    let _ = release.await;
                }
                // A real joined run may free work that was waiting behind it.
                // A pending probe must not immediately probe itself forever.
                if exit.pending_stage().is_none() {
                    scan = true;
                }
                pending_finish = Some((run, execution, exit));
            }
            Cmd::Due { epoch, ids } => {
                if epoch != state.backup_worker.epoch.load(SeqCst) || !automatic_ready(&state) {
                    continue;
                }
                for id in ids {
                    if ledger
                        .active
                        .iter()
                        .chain(ledger.queue.iter())
                        .any(|i| i.account_id == id)
                    {
                        continue;
                    }
                    let mut intent = new_intent(&state, id, false);
                    intent.stage = "queued".into();
                    state
                        .backup_worker
                        .controls
                        .lock()
                        .unwrap()
                        .insert(intent.run_id.clone(), Arc::new(AtomicBool::new(false)));
                    ledger.queue.push(intent);
                }
                let _ = publish(&state, &mut ledger).await;
            }
            #[cfg(test)]
            Cmd::Shutdown => return,
        }
        if let Some((run, execution, exit)) = pending_finish.take() {
            match finish_run(&state, &ledger, &run, &execution, &exit).await {
                Ok(next) => {
                    // Only a joined no-start Pending needs its deferred wake.
                    // Publication failure keeps the flag with pending_finish;
                    // ordinary status and provider IO never create a re-probe.
                    if deferred_probe_scan.as_deref() == Some(execution.as_str()) {
                        scan |= exit.pending_stage().is_some();
                        deferred_probe_scan = None;
                    }
                    ledger = next;
                }
                Err(_) => pending_finish = Some((run, execution, exit)),
            }
        }
        if pending_finish.is_some() {
            continue;
        }
        if let Some((run, execution, result, at)) = pending_snapshot.take() {
            if snapshots::completed(&state, &mut ledger, &run, &execution, &result, at)
                .await
                .is_err()
            {
                pending_snapshot = Some((run, execution, result, at));
            }
        }
        if settle_cancelled(&state, &mut ledger).await.is_err() {
            continue;
        }
        if apply_retained(&state, &mut ledger).await.is_err() {
            continue;
        }
        if pending_snapshot.is_none() {
            let _ = snapshots::drive(&state, &mut ledger).await;
        }
        if scan {
            check_stall(&state, &mut ledger).await;
            scan_automatic(&state);
        }
        pump(&state, &mut ledger, &services, scan).await;
    }
}
fn new_intent(state: &Arc<DaemonState>, account: String, manual: bool) -> Intent {
    Intent {
        account_id: account,
        run_id: uuid::Uuid::new_v4().to_string(),
        execution_id: uuid::Uuid::new_v4().to_string(),
        manual,
        requests: Vec::new(),
        stage: "queued".into(),
        retries: 0,
        not_before: 0,
        checkpoint: 0,
        pause_requested: false,
        cap: Value::Null,
        hold: false,
        last_progress: state.clock.now_ms(),
        cancel_requested: false,
        epoch: state.backup_worker.epoch.load(SeqCst),
    }
}
fn cancelled(state: &Arc<DaemonState>, intent: &Intent) -> bool {
    intent.cancel_requested
        || intent.epoch != state.backup_worker.epoch.load(SeqCst)
        || state
            .backup_worker
            .controls
            .lock()
            .unwrap()
            .get(&intent.run_id)
            .is_some_and(|t| t.load(SeqCst))
}
async fn settle_cancelled(state: &Arc<DaemonState>, ledger: &mut Ledger) -> Result<(), String> {
    let mut next = ledger.clone();
    let mut changed = false;
    next.queue.retain(|intent| {
        if !cancelled(state, intent) {
            return true;
        }
        changed = true;
        access::no_start(state, intent);
        let out = Outcome {
            intent: intent.clone(),
            status: "cancelled".into(),
            at: state.clock.now_ms(),
            result: None,
            terminal: None,
            error: None,
            applied: true,
            snapshot: json!({"status":"not_due"}),
        };
        settle_requests(&mut next.requests, &out);
        next.outcomes.push(out);
        false
    });
    if changed {
        publish(state, &mut next).await?;
        *ledger = next;
    }
    Ok(())
}
fn settle_requests(requests: &mut BTreeMap<String, Value>, outcome: &Outcome) {
    for request in &outcome.intent.requests {
        let mut receipt = response(&outcome.intent);
        receipt["status"] = json!(outcome.status);
        receipt["result"] = json!(outcome.result);
        receipt["terminal"] = json!(outcome.terminal);
        receipt["message"] = json!(outcome.error);
        requests.insert(request.clone(), receipt);
    }
}
async fn check_stall(state: &Arc<DaemonState>, ledger: &mut Ledger) {
    if let Some(active) = ledger.active.as_mut() {
        if active.stage == "running"
            && state
                .clock
                .now_ms()
                .saturating_sub(state.backup_worker.progress.load(SeqCst))
                >= STALL_MS
        {
            if let Some(token) = state
                .backup_worker
                .controls
                .lock()
                .unwrap()
                .get(&active.run_id)
            {
                token.store(true, SeqCst);
            }
            active.stage = "stopping_stall".into();
            let _ = publish(state, ledger).await;
        }
    }
}
fn loaded_settings(path: &Path) -> Result<Value, String> {
    let s = SettingsDoc::shared(path)
        .get(None)
        .map_err(|e| e.catalog_key().to_string())?;
    if s.recovered.is_some() {
        return Err("errors.settingsNotLoaded".into());
    }
    s.values
        .get(STORE)
        .and_then(|v| v.get("state"))
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| "errors.settingsNotLoaded".into())
}
fn scan_automatic(state: &Arc<DaemonState>) {
    let facts = state.backup_worker.facts.lock().unwrap().clone();
    if !facts.automatic
        || facts.paused
        || facts.loading
        || state.clock.now_ms().saturating_sub(facts.last_activity) < 180_000
    {
        return;
    }
    let epoch = state.backup_worker.epoch.load(SeqCst);
    #[cfg(test)]
    state.backup_worker.scans_in_flight.fetch_add(1, SeqCst);
    let state = state.clone();
    tokio::spawn(async move {
        let path = state.app_dir.clone();
        let now = state.clock.now_ms();
        let due = common::blocking(move || -> Result<Vec<String>, String> {
            let settings = loaded_settings(&path)?;
            let ids = crate::handlers::insights::configured_account_ids(&path)?;
            let zone = policy::local_zone().map_err(str::to_string)?;
            Ok(ids
                .into_iter()
                .filter(|id| {
                    policy::scheduled(&settings, id, now)
                        && policy::next_in_zone(
                            &settings["backupState"][id],
                            &policy::schedule_for(&settings, id),
                            now,
                            &zone,
                        )
                        .is_ok_and(|at| now >= at)
                })
                .collect())
        })
        .await;
        if let Ok(Ok(ids)) = due {
            let _ = state
                .backup_worker
                .tx
                .get()
                .unwrap()
                .send(Cmd::Due { epoch, ids });
        }
        #[cfg(test)]
        state.backup_worker.scans_in_flight.fetch_sub(1, SeqCst);
    });
}
async fn pump(state: &Arc<DaemonState>, ledger: &mut Ledger, services: &Services, scan: bool) {
    if ledger.active.is_some() || ledger.outcomes.iter().any(|o| !o.applied) {
        return;
    }
    let facts = state.backup_worker.facts.lock().unwrap().clone();
    let now = state.clock.now_ms();
    let eligible = ledger.queue.iter().position(|i| {
        if !i.manual
            && (!facts.automatic
                || facts.paused
                || facts.loading
                || now.saturating_sub(facts.last_activity) < 180_000)
        {
            return false;
        }
        if i.stage.starts_with("pending_") && !scan {
            return false;
        }
        i.not_before <= now || (i.hold && scan)
    });
    let Some(index) = eligible else {
        return;
    };
    let mut next = ledger.clone();
    let mut intent = next.queue.remove(index);
    let driver_intent = intent.clone();
    intent.stage = "preparing".into();
    intent.last_progress = now;
    next.active = Some(intent);
    if publish(state, &mut next).await.is_err() {
        return;
    }
    *ledger = next;
    state.backup_worker.note_progress(now);
    *state.backup_worker.execution.lock().unwrap() = Some(driver_intent.execution_id.clone());
    let st = state.clone();
    let services = services.clone();
    tokio::spawn(async move {
        let run = driver_intent.run_id.clone();
        let execution = driver_intent.execution_id.clone();
        let exit = run_intent(&st, &driver_intent, services).await;
        #[cfg(test)]
        if exit.pending_stage() == Some("pending_access") {
            let barrier = st.backup_worker.pending_access_exit.lock().unwrap().take();
            if let Some((entered, release)) = barrier {
                let _ = entered.send(());
                let _ = release.await;
            }
        }
        #[cfg(test)]
        if exit.pending_stage() == Some("limit") {
            let barrier = st.backup_worker.pending_limit_exit.lock().unwrap().take();
            if let Some((entered, release)) = barrier {
                let _ = entered.send(());
                let _ = release.await;
            }
        }
        let _ = st.backup_worker.tx.get().unwrap().send(Cmd::Finished {
            run,
            execution,
            exit,
        });
    });
}
// Reads are fallible and off the control runtime. A failed slot query is not
// proof of absence, and accounts parse failure is not account removal.
async fn admission_facts(state: &Arc<DaemonState>) -> Result<(Value, Vec<String>, bool), String> {
    let path = state.app_dir.clone();
    common::blocking(move || {
        let settings = loaded_settings(&path).map_err(|_| "pending_settings".to_string())?;
        let ids = crate::handlers::insights::configured_account_ids(&path)
            .map_err(|_| "pending_accounts".to_string())?;
        let absent = app_db::with(&path, |conn| {
            conn.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM external_locations WHERE slot='external-backup')",
                [],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())
        })
        .unwrap_or(false);
        Ok((settings, ids, absent))
    })
    .await
    .map_err(|_| "pending_settings".to_string())?
}
async fn run_intent(state: &Arc<DaemonState>, intent: &Intent, services: Services) -> RunExit {
    let (settings, ids, _absent) = match admission_facts(state).await {
        Ok(f) => f,
        Err(stage) => return RunExit::Pending(stage),
    };
    if !ids.contains(&intent.account_id) {
        return RunExit::Missing;
    }
    if !intent.manual && !automatic_ready(state) {
        return RunExit::Pending("pending_policy".into());
    }
    if let Err(observed) = access::root(state, intent).await {
        return RunExit::PendingAccess { observed };
    }
    let now = state.clock.now_ms();
    if !intent.manual && !automatic_ready(state) {
        return RunExit::Pending("pending_policy".into());
    }
    if !intent.manual && !policy::scheduled(&settings, &intent.account_id, now) {
        return RunExit::Pending("pending_policy".into());
    }
    if intent.hold
        && intent.not_before > now
        && !policy::download_cap_changed(
            &intent.cap,
            &settings["transferLimits"][&intent.account_id],
        )
    {
        return RunExit::Pending("limit".into());
    }
    let token = state
        .backup_worker
        .controls
        .lock()
        .unwrap()
        .get(&intent.run_id)
        .cloned()
        .unwrap();
    if cancelled(state, intent) {
        return RunExit::Completed(adapter::JoinedBackup {
            result: Some(json!({"cancelled":true})),
            ..Default::default()
        });
    }
    let Some(guard) = adapter::claim_controlled(state, &intent.account_id, token.clone()) else {
        return RunExit::Pending("pending_claim".into());
    };
    let account =
        match (services.resolve)(state.clone(), intent.account_id.clone(), intent.manual).await {
            Ok(c) => c,
            Err(error) => {
                return match admission_facts(state).await {
                    Err(stage) => RunExit::Pending(stage),
                    Ok((_, ids, _)) if !ids.contains(&intent.account_id) => RunExit::Missing,
                    Ok(_) => match access::root(state, intent).await {
                        Err(observed) => RunExit::PendingAccess { observed },
                        Ok(_) => RunExit::Credentials(error),
                    },
                }
            }
        };
    let (fresh, ids, _absent) = match admission_facts(state).await {
        Ok(f) => f,
        Err(stage) => return RunExit::Pending(stage),
    };
    if !ids.contains(&intent.account_id) {
        return RunExit::Missing;
    }
    if !intent.manual && !automatic_ready(state) {
        return RunExit::Pending("pending_policy".into());
    }
    let mirror_root = match access::root(state, intent).await {
        Ok(root) => root,
        Err(observed) => return RunExit::PendingAccess { observed },
    };
    let facts = state.backup_worker.facts.lock().unwrap().clone();
    if !intent.manual
        && (!facts.automatic
            || facts.paused
            || facts.loading
            || state.clock.now_ms().saturating_sub(facts.last_activity) < 180_000
            || !policy::scheduled(&fresh, &intent.account_id, state.clock.now_ms()))
    {
        return RunExit::Pending("pending_policy".into());
    }
    if !intent.manual && intent.retries == 0 && intent.stage == "queued" {
        let due = policy::local_zone()
            .ok()
            .and_then(|zone| {
                policy::next_in_zone(
                    &fresh["backupState"][&intent.account_id],
                    &policy::schedule_for(&fresh, &intent.account_id),
                    state.clock.now_ms(),
                    &zone,
                )
                .ok()
            })
            .is_some_and(|at| state.clock.now_ms() >= at);
        if !due {
            return RunExit::Pending("pending_policy".into());
        }
    }
    if cancelled(state, intent) {
        return RunExit::Completed(adapter::JoinedBackup {
            result: Some(json!({"cancelled":true})),
            ..Default::default()
        });
    }
    crate::search_index::wait_foreground_quiet(&state.search_index).await;
    if cancelled(state, intent) {
        return RunExit::Completed(adapter::JoinedBackup {
            result: Some(json!({"cancelled":true})),
            ..Default::default()
        });
    }
    let _ = state.backup_worker.tx.get().unwrap().send(Cmd::Running {
        run: intent.run_id.clone(),
        execution: intent.execution_id.clone(),
        cap: fresh["transferLimits"][&intent.account_id].clone(),
    });
    // No known server folder order is retained by these runners. An ordinal
    // checkpoint remains display/recovery evidence, never skip authority.
    RunExit::Completed(
        adapter::run_claimed(
            state.clone(),
            guard,
            intent.account_id.clone(),
            account,
            None,
            mirror_root,
            0,
            policy::mailbox_concurrency(&fresh, state.clock.now_ms()),
            Some((intent.run_id.clone(), intent.execution_id.clone())),
            services.provider,
        )
        .await,
    )
}
async fn finish_run(
    state: &Arc<DaemonState>,
    ledger: &Ledger,
    run: &str,
    execution: &str,
    exit: &RunExit,
) -> Result<Ledger, String> {
    let mut next = ledger.clone();
    let Some(mut intent) = next
        .active
        .take()
        .filter(|i| i.run_id == run && i.execution_id == execution)
    else {
        return Ok(ledger.clone());
    };
    let user_cancel =
        intent.cancel_requested || intent.epoch != state.backup_worker.epoch.load(SeqCst);
    // run_intent has returned and released its preparation claim. A result
    // decided before attach cannot retire the newer acquisition. No actual
    // provider completion enters this no-start-only path.
    if let RunExit::PendingAccess { observed } = exit {
        if !cancelled(state, &intent) && access::newer_authority(state, &intent, observed) {
            intent.stage = "queued".into();
            for request in &intent.requests {
                next.requests.insert(request.clone(), response(&intent));
            }
            next.queue.insert(0, intent);
            publish(state, &mut next).await?;
            return Ok(next);
        }
    }
    let (attached, owner_lost) = access::joined(state, &intent, exit);
    let uncertain = matches!(exit,RunExit::Completed(joined) if joined.uncertain);
    if !uncertain && !user_cancel && (owner_lost || (attached && exit.pending_stage().is_some())) {
        access::renew(state, &mut intent);
        for request in &intent.requests {
            next.requests.insert(request.clone(), response(&intent));
        }
        next.queue.insert(0, intent);
        publish(state, &mut next).await?;
        return Ok(next);
    }
    let actually_succeeded = matches!(exit, RunExit::Completed(joined) if joined.error.is_none() && joined.result.as_ref().is_some_and(|r|r["success"] == true && r["cancelled"] != true));
    if intent.pause_requested && !user_cancel && !uncertain && !actually_succeeded {
        intent.pause_requested = false;
        intent.checkpoint = 0;
        access::renew(state, &mut intent);
        state
            .backup_worker
            .controls
            .lock()
            .unwrap()
            .insert(intent.run_id.clone(), Arc::new(AtomicBool::new(false)));
        for request in &intent.requests {
            next.requests.insert(request.clone(), response(&intent));
        }
        next.queue.insert(0, intent);
        publish(state, &mut next).await?;
        return Ok(next);
    }
    if let Some(stage) = exit.pending_stage() {
        intent.stage = stage.to_string();
        for request in &intent.requests {
            next.requests.insert(request.clone(), response(&intent));
        }
        next.queue.push(intent);
    } else {
        let at = state.clock.now_ms();
        let (status, result, terminal, error) = match exit {
            RunExit::Missing => ("missing_account", None, None, None),
            RunExit::Credentials(e) => ("failed_credentials", None, None, Some(e.clone())),
            RunExit::Completed(joined) => {
                if joined.uncertain {
                    intent.stage = "uncertain".into();
                    for request in &intent.requests {
                        next.requests.insert(request.clone(), response(&intent));
                    }
                    next.active = Some(intent);
                    publish(state, &mut next).await?;
                    return Ok(next);
                }
                let value = joined.result.as_ref();
                let terminal = joined.terminal.as_ref();
                let limit = joined.error.is_none()
                    && value.is_some()
                    && terminal.is_some_and(|t| t["stop_reason"] == "limit_reached");
                let stalled = intent.stage == "stopping_stall";
                let status = if limit {
                    "limit_reached"
                } else if stalled {
                    "failed"
                } else if value.is_some_and(|v| v["cancelled"] == true)
                    || (user_cancel && joined.error.is_some())
                {
                    "cancelled"
                } else if joined.error.is_none() && value.is_some_and(|v| v["success"] == true) {
                    "success"
                } else {
                    "failed"
                };
                (
                    status,
                    joined.result.clone(),
                    joined.terminal.clone(),
                    if stalled {
                        Some("errors.backupStalled".into())
                    } else {
                        joined.error.clone().or_else(|| {
                            value
                                .and_then(|v| v["error_message"].as_str())
                                .map(str::to_string)
                        })
                    },
                )
            }
            RunExit::Pending(_) | RunExit::PendingAccess { .. } => unreachable!(),
        };
        if status == "failed" && !user_cancel {
            if let Some(delay) = policy::retry_delay(intent.retries, intent.manual) {
                intent.retries += 1;
                intent.not_before = at.saturating_add(delay);
                intent.stage = "retry".into();
                intent.execution_id = uuid::Uuid::new_v4().to_string();
                state
                    .backup_worker
                    .controls
                    .lock()
                    .unwrap()
                    .insert(intent.run_id.clone(), Arc::new(AtomicBool::new(false)));
                next.queue.insert(0, intent);
                publish(state, &mut next).await?;
                return Ok(next);
            }
        }
        if status == "limit_reached" {
            let mut held = new_intent(state, intent.account_id.clone(), false);
            held.stage = "limit".into();
            held.hold = true;
            held.cap = intent.cap.clone();
            held.checkpoint = result
                .as_ref()
                .and_then(|v| v["completed_folders"].as_u64())
                .unwrap_or(0) as usize;
            held.not_before = policy::limit_hold_until(
                at,
                terminal
                    .as_ref()
                    .and_then(|v| v["resume_after_ms"].as_i64()),
            );
            // Stop invalidates delayed intent even if the core was already
            // reporting the cap when the user stopped this execution.
            if intent.epoch == state.backup_worker.epoch.load(SeqCst) {
                state
                    .backup_worker
                    .controls
                    .lock()
                    .unwrap()
                    .insert(held.run_id.clone(), Arc::new(AtomicBool::new(false)));
                next.queue.push(held);
            }
        }
        let outcome = Outcome {
            intent,
            status: status.into(),
            at,
            result,
            terminal,
            error,
            applied: false,
            snapshot: json!({"status":"undecided"}),
        };
        next.outcomes.push(outcome);
    }
    publish(state, &mut next).await?;
    Ok(next)
}
async fn apply_retained(state: &Arc<DaemonState>, ledger: &mut Ledger) -> Result<(), String> {
    while let Some(index) = ledger.outcomes.iter().position(|out| !out.applied) {
        if ledger.outcomes[index].snapshot.is_null() {
            let mut next = ledger.clone();
            next.outcomes[index].snapshot = json!({"status":"undecided"});
            publish(state, &mut next).await?;
            *ledger = next;
        }
        let path = state.app_dir.clone();
        let outcome = ledger.outcomes[index].clone();
        let run = outcome.intent.run_id.clone();
        let change = common::blocking(move || apply_outcome(&path, &outcome)).await??;
        if let Some(change) = change.filter(|c| !c.changed.is_empty()) {
            state.events.emit(
                crate::handlers::settings::CHANGED_EVENT,
                json!({"keys":change.changed,"version":change.version}),
            );
        }
        let mut next = ledger.clone();
        next.outcomes[index].applied = true;
        settle_requests(&mut next.requests, &next.outcomes[index]);
        publish(state, &mut next).await?;
        *state.backup_worker.execution.lock().unwrap() = None;
        state.backup_worker.controls.lock().unwrap().remove(&run);
        *ledger = next;
    }
    let live = ledger
        .active
        .iter()
        .chain(ledger.queue.iter())
        .map(|i| i.run_id.clone())
        .chain(
            ledger
                .outcomes
                .iter()
                .filter(|o| !o.applied)
                .map(|o| o.intent.run_id.clone()),
        )
        .collect::<HashSet<_>>();
    state
        .backup_worker
        .controls
        .lock()
        .unwrap()
        .retain(|run, _| live.contains(run));
    Ok(())
}
fn apply_outcome(
    path: &Path,
    out: &Outcome,
) -> Result<Option<mailvault_core::settings_doc::Change>, String> {
    let provider_cancel_error = out
        .result
        .as_ref()
        .and_then(|result| result["error_message"].as_str());
    if out.status == "missing_account"
        || (out.status == "cancelled" && provider_cancel_error.is_none())
    {
        return Ok(None);
    }
    let doc = SettingsDoc::shared(path);
    for _ in 0..3 {
        let snapshot = doc.get(None).map_err(|e| e.catalog_key().to_string())?;
        if snapshot.recovered.is_some()
            || !snapshot
                .values
                .get(STORE)
                .and_then(|v| v.get("state"))
                .is_some_and(Value::is_object)
        {
            return Err("errors.settingsNotLoaded".into());
        }
        let settings = &snapshot.values[STORE]["state"];
        let id = &out.intent.account_id;
        let old = &settings["backupState"][id];
        if old["lastSchedulerRunId"] == out.intent.run_id {
            return Ok(None);
        }
        let mut state = json!({"lastSchedulerRunId":out.intent.run_id});
        let mut patch = json!({});
        if out.status == "cancelled" {
            // The existing coordinator projects a provider's cancelled+error
            // result without recording failed history or changing last time.
            state["lastStatus"] = json!("failed");
            state["lastError"] = json!(provider_cancel_error);
        } else if out.status == "limit_reached" {
            state["lastStatus"] = json!("limit");
            state["lastError"] = Value::Null;
        } else {
            let fallback = json!({});
            let result = out.result.as_ref().unwrap_or(&fallback);
            let success = out.status == "success";
            let failed_credentials = out.status == "failed_credentials";
            let emails = if success {
                result["emails_backed_up"].as_u64().unwrap_or(0)
            } else {
                0
            };
            let external = result["external_copy_ok"] != false;
            let errors = result["errors"].as_u64().unwrap_or(0);
            let error = out
                .error
                .clone()
                .or_else(|| result["error_message"].as_str().map(str::to_string));
            let mut history = settings["backupHistory"][id]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut entry = json!({"timestamp":out.at,"emailsBackedUp":emails,"durationSecs":if success {result["duration_secs"].as_f64().unwrap_or(0.0)} else {0.0},"success":success,"error":error});
            if success {
                entry["errors"] = json!(errors);
                entry["externalCopyOk"] = json!(external);
                entry["externalCopyError"] = result["external_copy_error"].clone();
                entry["externalCopyFailedCount"] =
                    json!(result["external_copy_failed_count"].as_u64().unwrap_or(0));
            }
            history.insert(0, entry);
            history.truncate(5);
            patch["backupHistory"] = json!({id:history});
            state["lastStatus"] = json!(if success {
                if !external || errors > 0 {
                    "degraded"
                } else {
                    "success"
                }
            } else {
                "failed"
            });
            state["lastError"] = json!(error.or_else(|| if !external {
                result["external_copy_error"].as_str().map(str::to_string)
            } else {
                None
            }));
            if !failed_credentials {
                state["lastBackupTime"] = json!(out.at);
            }
            if success {
                state["emailsBackedUp"] = json!(old["emailsBackedUp"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(emails));
            }
        }
        patch["backupState"] = json!({id:state});
        match doc.patch(&json!({STORE:{"state":patch}}), Some(snapshot.version)) {
            Ok(change) => return Ok(Some(change)),
            Err(SettingsError::Conflict { .. }) => continue,
            Err(e) => return Err(e.catalog_key().into()),
        }
    }
    Err("errors.settingsConflict".into())
}
async fn admit(
    state: &Arc<DaemonState>,
    ledger: &mut Ledger,
    account: String,
    request: String,
) -> Result<Value, String> {
    if let Some(receipt) = ledger.requests.get(&request) {
        return if receipt["accountId"] == account {
            Ok(receipt.clone())
        } else {
            Err("errors.settingsInvalid".into())
        };
    }
    let mut next = ledger.clone();
    if let Some(out) = next
        .outcomes
        .iter_mut()
        .rev()
        .find(|o| !o.applied && o.intent.account_id == account)
    {
        out.intent.requests.push(request.clone());
        let mut ack = response(&out.intent);
        ack["status"] = json!("applying");
        next.requests.insert(request, ack.clone());
        publish(state, &mut next).await?;
        *ledger = next;
        return Ok(ack);
    }
    let joining_active = next
        .active
        .as_ref()
        .is_some_and(|i| i.account_id == account);
    let found = next
        .active
        .iter_mut()
        .chain(next.queue.iter_mut())
        .find(|i| i.account_id == account);
    let intent = if let Some(i) = found {
        i.manual = true;
        i.requests.push(request.clone());
        i.not_before = 0;
        i.hold = false;
        if !joining_active {
            i.stage = "queued".into();
        }
        i.clone()
    } else {
        let mut i = new_intent(state, account.clone(), true);
        i.requests.push(request.clone());
        next.queue.insert(0, i.clone());
        i
    };
    if let Some(index) = next.queue.iter().position(|i| i.run_id == intent.run_id) {
        let item = next.queue.remove(index);
        next.queue.insert(0, item);
    }
    let ack = response(&intent);
    next.requests.insert(request, ack.clone());
    publish(state, &mut next).await?;
    *ledger = next;
    state
        .backup_worker
        .controls
        .lock()
        .unwrap()
        .entry(intent.run_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)));
    Ok(ack)
}
pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    if let Some(response) = access::route(state, method, params, id.clone()).await {
        return Some(response);
    }
    if method == "backup.context" {
        let observation = match context::Observation::parse(params) {
            Ok(o) => o,
            Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, e)),
        };
        start(state.clone());
        let (reply, rx) = oneshot::channel();
        let _ = state
            .backup_worker
            .tx
            .get()
            .unwrap()
            .send(Cmd::Context { observation, reply });
        return Some(match rx.await {
            Ok(v) => RpcResponse::success(id, v),
            Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.settingsNotLoaded"),
        });
    }
    if method == "backup.surface_retire" {
        if let Some(surface) = params["surfaceId"].as_str() {
            start(state.clone());
            let _ = state
                .backup_worker
                .tx
                .get()
                .unwrap()
                .send(Cmd::RetireSurface(surface.into()));
            return Some(RpcResponse::success(id, json!({"accepted":true})));
        }
        return Some(RpcResponse::error(
            id,
            ipc::INVALID_PARAMS,
            "errors.settingsInvalid",
        ));
    }
    if !matches!(
        method,
        "backup.run_now" | "backup.cancel" | "backup.stop" | "backup.schedule.status"
    ) {
        return None;
    }
    let keys: &[&str] = match method {
        "backup.run_now" => &["accountId", "requestId"],
        "backup.cancel" => &["runId"],
        _ => &[],
    };
    let valid = params.as_object().is_some_and(|p| {
        p.len() == keys.len()
            && keys.iter().all(|k| {
                p.get(*k)
                    .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256))
            })
    });
    if !valid {
        return Some(RpcResponse::error(
            id,
            ipc::INVALID_PARAMS,
            "errors.settingsInvalid",
        ));
    }
    start(state.clone());
    let result = match method {
        "backup.run_now" => {
            let (tx, rx) = oneshot::channel();
            let sent = state.backup_worker.tx.get().unwrap().send(Cmd::Manual {
                account: params["accountId"].as_str().unwrap().into(),
                request: params["requestId"].as_str().unwrap().into(),
                reply: tx,
            });
            if sent.is_err() {
                Err("errors.settingsNotLoaded".into())
            } else {
                rx.await
                    .unwrap_or_else(|_| Err("errors.settingsNotLoaded".into()))
            }
        }
        "backup.cancel" => {
            let run = params["runId"].as_str().unwrap().to_string();
            if let Some(token) = state.backup_worker.controls.lock().unwrap().get(&run) {
                token.store(true, SeqCst);
            }
            let (tx, rx) = oneshot::channel();
            if state
                .backup_worker
                .tx
                .get()
                .unwrap()
                .send(Cmd::Cancel { run, reply: tx })
                .is_err()
            {
                Err("errors.settingsNotLoaded".into())
            } else {
                rx.await
                    .unwrap_or_else(|_| Err("errors.settingsNotLoaded".into()))
            }
        }
        "backup.stop" => {
            state.backup_worker.epoch.fetch_add(1, SeqCst);
            state.backup_worker.facts.lock().unwrap().automatic = false;
            for token in state.backup_worker.controls.lock().unwrap().values() {
                token.store(true, SeqCst);
            }
            let (tx, rx) = oneshot::channel();
            if state
                .backup_worker
                .tx
                .get()
                .unwrap()
                .send(Cmd::Stop { reply: tx })
                .is_err()
            {
                Err("errors.settingsNotLoaded".into())
            } else {
                rx.await
                    .unwrap_or_else(|_| Err("errors.settingsNotLoaded".into()))
            }
        }
        _ => Ok(state.backup_worker.status()),
    };
    Some(match result {
        Ok(v) => RpcResponse::success(id, v),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    })
}

#[cfg(test)]
#[path = "backup_worker_tests.rs"]
mod tests;

pub(crate) struct AccessOwner {
    state: Arc<DaemonState>,
    owner: String,
}
impl Drop for AccessOwner {
    fn drop(&mut self) {
        access::owner_lost(&self.state, &self.owner);
    }
}
pub(crate) fn channel_owner(state: &Arc<DaemonState>, owner: Option<&str>) -> Option<AccessOwner> {
    let owner = owner.filter(|s| !s.is_empty() && s.len() <= 256)?;
    start(state.clone());
    access::owner_connected(state, owner);
    Some(AccessOwner {
        state: state.clone(),
        owner: owner.into(),
    })
}

pub(crate) fn configuration_changed(state: &Arc<DaemonState>, rearm: bool) {
    start(state.clone());
    let _ = state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::ConfigChanged { rearm });
}

// Surface lifecycle is independent from native mirror authorization owners.
pub(crate) struct SurfaceChannelOwner { state: Arc<DaemonState>, generation: String }
impl Drop for SurfaceChannelOwner {
    fn drop(&mut self) { let _ = self.state.backup_worker.tx.get().unwrap().send(Cmd::SurfaceGenerationLost(self.generation.clone())); }
}
pub(crate) fn surface_channel_owner(state: &Arc<DaemonState>, generation: Option<&str>) -> Option<SurfaceChannelOwner> {
    let generation = generation.filter(|s|!s.is_empty() && s.len() <= 256)?;
    start(state.clone());
    Some(SurfaceChannelOwner { state:state.clone(), generation:generation.into() })
}
