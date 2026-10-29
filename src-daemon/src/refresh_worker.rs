//! Volatile native refresh receipts and the dedicated header worker.

use crate::account_lifecycle::AccountStamp;
use crate::server::DaemonState;
use crate::sync_engine::SyncAccount;
use crate::sync_observation::{self, Origin};
use mailvault_core::{accounts_doc, refresh_policy, settings_doc};
use mailvault_core::graph::GraphClient;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{mpsc, watch};

const MAX_LIVE: usize = 64;
const MAX_TERMINAL: usize = 64;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Intent {
    pub request_id: String,
    pub account_id: Option<String>,
    pub mailbox: Option<String>,
    pub reason: Reason,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason { Manual, Scheduled, Launch }

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextPhase { Start, Resume }

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ContextView {
    Ordinary { account_id: String, mailbox: String },
    Unified { folder: Option<String> },
    Subtree { account_id: String, mailbox: String, paths: Vec<String> },
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ContextInput {
    pub launch_id: String,
    pub revision: u64,
    pub phase: ContextPhase,
    pub view: Option<ContextView>,
}

struct LaunchMark { id: String, eligible: bool, consumed: bool }
struct SyncOwner { launch_id: String, revision: u64, generation: u64 }

pub(crate) struct SyncOwnerGuard {
    state: Arc<DaemonState>,
    launch_id: String,
    revision: u64,
    generation: u64,
}

impl SyncOwnerGuard {
    pub(crate) fn matches(&self, launch_id: &str, revision: u64) -> bool {
        self.launch_id == launch_id && self.revision == revision
            && self.state.refresh.owner_generation(&self.launch_id) == Some(self.generation)
    }
    pub(crate) fn generation(&self) -> u64 { self.generation }
    pub(crate) fn may_advance(&self, launch_id: &str, revision: u64) -> bool {
        self.launch_id == launch_id && revision > self.revision
            && self.state.refresh.owner_generation(&self.launch_id) == Some(self.generation)
    }
}

impl Drop for SyncOwnerGuard {
    fn drop(&mut self) {
        self.state.refresh.detach_owner(&self.launch_id, self.generation);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Extent { RefreshPage, Complete }

#[derive(Clone, PartialEq, Eq, Hash)]
struct TargetKey {
    account_id: String,
    mailbox: String,
    epoch: u64,
    origin_hash: String,
    extent: Extent,
}

struct Unit {
    key: TargetKey,
    origin: Origin,
    manual: bool,
    dependents: Vec<(String, usize)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountResult {
    account_id: String,
    mailbox: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    needs_shell_adoption: Option<bool>,
}

impl AccountResult {
    fn pending(account_id: String, mailbox: String) -> Self {
        Self { account_id, mailbox, success: false, error_key: None, needs_shell_adoption: None }
    }
    fn failed(account_id: String, mailbox: String, key: &str) -> Self {
        Self { account_id, mailbox, success: false, error_key: Some(key.into()), needs_shell_adoption: None }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    request_id: String,
    status: &'static str,
    account_results: Vec<AccountResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
}

struct Record {
    intent: Intent,
    receipt: Receipt,
    admitted: watch::Sender<Option<Receipt>>,
    pending: usize,
    done: Vec<bool>,
    classification: Vec<Origin>,
    view: Option<ContextView>,
}

#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    order: VecDeque<String>,
    queue: VecDeque<Unit>,
    active: Option<TargetKey>,
    last_refresh_time: Option<i64>,
    automatic_enabled: bool,
    context_revision: u64,
    context: Option<ContextInput>,
    launches: VecDeque<LaunchMark>,
    owner: Option<SyncOwner>,
    next_owner_generation: u64,
    view_active: bool,
    automatic_due: bool,
}

pub(crate) struct RefreshState {
    instance_id: String,
    inner: Mutex<Inner>,
    sender: OnceLock<mpsc::UnboundedSender<()>>,
    automatic_wake: Arc<tokio::sync::Notify>,
    #[cfg(test)]
    duplicate_joins: std::sync::atomic::AtomicUsize,
}

impl Default for RefreshState {
    fn default() -> Self {
        Self { instance_id: uuid::Uuid::new_v4().to_string(), inner: Mutex::new(Inner::default()),
            sender: OnceLock::new(), automatic_wake: Arc::new(tokio::sync::Notify::new()),
            #[cfg(test)]
            duplicate_joins: std::sync::atomic::AtomicUsize::new(0) }
    }
}

enum Reservation {
    New(watch::Receiver<Option<Receipt>>),
    Existing(watch::Receiver<Option<Receipt>>),
}

impl RefreshState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn reserve(&self, intent: &Intent) -> Result<Reservation, &'static str> {
        let mut inner = self.lock();
        if let Some(record) = inner.records.get(&intent.request_id) {
            if record.intent != *intent { return Err("errors.accountsInvalid"); }
            #[cfg(test)]
            self.duplicate_joins.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Ok(Reservation::Existing(record.admitted.subscribe()));
        }
        if intent.mailbox.as_deref() == Some("UNIFIED")
            && !inner.context.as_ref().is_some_and(|context|
                matches!(&context.view, Some(ContextView::Unified { .. }))) {
            return Err("errors.accountsInvalid");
        }
        let live = inner.records.values().filter(|record| record.receipt.completed_at.is_none()).count();
        if live >= MAX_LIVE { return Err("errors.operationRunning"); }
        let (admitted, rx) = watch::channel(None);
        let view = if intent.reason == Reason::Manual || inner.view_active {
            inner.context.as_ref().and_then(|context| context.view.clone())
        } else { None };
        inner.order.push_back(intent.request_id.clone());
        inner.records.insert(intent.request_id.clone(), Record {
            intent: intent.clone(),
            receipt: Receipt { request_id: intent.request_id.clone(), status: "queued",
                account_results: Vec::new(), error_key: None, completed_at: None },
            admitted, pending: 0, done: Vec::new(), classification: Vec::new(),
            view,
        });
        Ok(Reservation::New(rx))
    }

    fn trim_terminal(inner: &mut Inner) {
        let mut terminal = inner.records.values().filter(|record| record.receipt.completed_at.is_some()).count();
        while terminal > MAX_TERMINAL {
            let Some(position) = inner.order.iter().position(|id|
                inner.records.get(id).is_some_and(|record| record.receipt.completed_at.is_some())) else { break };
            let id = inner.order.remove(position).expect("terminal position exists");
            inner.records.remove(&id);
            terminal -= 1;
        }
    }

    fn finish_admission_error(&self, request_id: &str, error_key: &str) {
        let mut inner = self.lock();
        if let Some(record) = inner.records.get_mut(request_id) {
            record.receipt.status = "failed";
            record.receipt.error_key = Some(error_key.into());
            record.receipt.completed_at = Some(now_ms());
            record.admitted.send_replace(Some(record.receipt.clone()));
        }
        inner.last_refresh_time = Some(now_ms());
        Self::trim_terminal(&mut inner);
        drop(inner);
        self.automatic_wake.notify_one();
    }

    fn finish_admission(&self, intent: &Intent,
        prepared: Vec<Result<(Origin, String), AccountResult>>,
        classification: Vec<Origin>, extent: Extent) {
        let mut inner = self.lock();
        let mut pending = Vec::new();
        let admitted;
        let admitted_receipt;
        let completed_at;
        {
            let record = inner.records.get_mut(&intent.request_id).expect("reserved refresh receipt");
            record.classification = classification;
            for target in prepared {
                let index = record.receipt.account_results.len();
                match target {
                    Ok((origin, mailbox)) => {
                        let target_extent = if origin.graph { Extent::RefreshPage } else { extent };
                        let key = TargetKey { account_id: origin.original.id().into(),
                            mailbox: mailbox.clone(), epoch: origin.original.epoch(),
                            origin_hash: origin.hash.clone(), extent: target_extent };
                        record.receipt.account_results.push(AccountResult::pending(key.account_id.clone(), mailbox));
                        record.done.push(false);
                        record.pending += 1;
                        pending.push((key, origin, index));
                    }
                    Err(failure) => {
                        record.receipt.account_results.push(failure);
                        record.done.push(true);
                    }
                }
            }
            if record.pending == 0 {
                record.receipt.status = if record.receipt.account_results.iter().any(|row| !row.success) {
                    "failed"
                } else { "complete" };
                record.receipt.completed_at = Some(now_ms());
            }
            completed_at = record.receipt.completed_at;
            admitted = record.admitted.clone();
            admitted_receipt = record.receipt.clone();
        }
        for (key, origin, index) in pending {
            let dependent = (intent.request_id.clone(), index);
            // A queued equivalent owns the next provider observation. A
            // running equivalent is intentionally not joined: the first
            // queued trailing unit becomes the sole next observation.
            if let Some(unit) = inner.queue.iter_mut().find(|unit|
                unit.key.account_id == key.account_id && unit.key.mailbox == key.mailbox
                    && unit.key.epoch == key.epoch && unit.key.origin_hash == key.origin_hash
                    && (unit.key.extent == key.extent
                        || (unit.key.extent == Extent::Complete && key.extent == Extent::RefreshPage))) {
                unit.manual |= intent.reason == Reason::Manual;
                unit.dependents.push(dependent);
            } else {
                inner.queue.push_back(Unit { key, origin, manual: intent.reason == Reason::Manual,
                    dependents: vec![dependent] });
            }
        }
        if completed_at.is_some() { inner.last_refresh_time = completed_at; }
        admitted.send_replace(Some(admitted_receipt));
        Self::trim_terminal(&mut inner);
        drop(inner);
        if let Some(sender) = self.sender.get() { let _ = sender.send(()); }
        self.automatic_wake.notify_one();
    }

    fn take_next(&self) -> Option<Unit> {
        let mut inner = self.lock();
        let unit = inner.queue.pop_front()?;
        inner.active = Some(unit.key.clone());
        for (id, _) in &unit.dependents {
            if let Some(record) = inner.records.get_mut(id) {
                record.receipt.status = "running";
                record.admitted.send_replace(Some(record.receipt.clone()));
            }
        }
        Some(unit)
    }

    fn finish_unit(&self, unit: &Unit, result: AccountResult) -> Vec<Vec<Origin>> {
        let mut inner = self.lock();
        if inner.active.as_ref() == Some(&unit.key) { inner.active = None; }
        let mut latest = None;
        let mut classification = Vec::new();
        for (id, index) in &unit.dependents {
            if let Some(record) = inner.records.get_mut(id) {
                if record.done.get(*index) == Some(&false) {
                    record.done[*index] = true;
                    record.receipt.account_results[*index] = result.clone();
                    record.pending -= 1;
                    if record.pending == 0 {
                        record.receipt.status = if record.receipt.account_results.iter().any(|row| !row.success) {
                            "failed"
                        } else { "complete" };
                        record.receipt.completed_at = Some(now_ms());
                        latest = record.receipt.completed_at;
                        classification.push(record.classification.clone());
                    }
                    record.admitted.send_replace(Some(record.receipt.clone()));
                }
            }
        }
        if latest.is_some() { inner.last_refresh_time = latest; }
        Self::trim_terminal(&mut inner);
        drop(inner);
        self.automatic_wake.notify_one();
        classification
    }

    pub(crate) async fn admit(state: &Arc<DaemonState>, intent: Intent) -> Result<Value, &'static str> {
        if state.refresh.sender.get().is_none_or(mpsc::UnboundedSender::is_closed) {
            return Err("errors.syncUnavailable");
        }
        let reservation = state.refresh.reserve(&intent)?;
        let mut rx = match reservation {
            Reservation::New(rx) => {
                let state = Arc::clone(state);
                let task_intent = intent.clone();
                tokio::spawn(async move { complete_admission(&state, task_intent).await; });
                rx
            }
            Reservation::Existing(rx) => rx,
        };
        while rx.borrow().is_none() {
            if rx.changed().await.is_err() { return Err("errors.syncUnavailable"); }
        }
        #[cfg(test)]
        test_pause_before_ack_snapshot(state).await;
        let receipt = rx.borrow().clone().ok_or("errors.syncUnavailable")?;
        Ok(json!({"instanceId":&state.refresh.instance_id,"receipt":receipt}))
    }

    pub(crate) fn status(&self, request_id: Option<&str>) -> Value {
        let inner = self.lock();
        let receipts: Vec<_> = inner.order.iter()
            .filter(|id| request_id.is_none_or(|wanted| id.as_str() == wanted))
            .filter_map(|id| inner.records.get(id).map(|record| record.receipt.clone()))
            .collect();
        let found = !receipts.is_empty();
        let mut answer = json!({"instanceId":&self.instance_id,"lastRefreshTime":inner.last_refresh_time,
            "automaticEnabled":inner.automatic_enabled,"contextRevision":inner.context_revision,
            "receipts":receipts});
        if request_id.is_some() { answer["found"] = json!(found); }
        answer
    }

    fn admitted_view(&self, request_id: &str) -> Option<ContextView> {
        self.lock().records.get(request_id).and_then(|record| record.view.clone())
    }

    fn mark_automatic_due(&self) {
        self.lock().automatic_due = true;
        self.automatic_wake.notify_one();
    }

    fn take_automatic_due_if_idle(&self) -> bool {
        let mut inner = self.lock();
        if !inner.automatic_due || inner.active.is_some() || !inner.queue.is_empty()
            || inner.records.values().any(|record| record.intent.reason != Reason::Manual
                && record.receipt.completed_at.is_none()) {
            return false;
        }
        inner.automatic_due = false;
        true
    }

    fn consume_eligible_launch(&self, settings: &Value, has_accounts: bool) -> bool {
        let mut inner = self.lock();
        if !has_accounts || !refresh_policy::refresh_on_launch(settings) { return false; }
        let Some(current) = inner.context.as_ref() else { return false };
        let current_id = current.launch_id.clone();
        let Some(mark) = inner.launches.iter_mut().find(|mark| mark.id == current_id) else { return false };
        if !mark.eligible || mark.consumed { return false; }
        mark.consumed = true;
        true
    }

    pub(crate) fn instance_id(&self) -> &str { &self.instance_id }

    fn owner_generation(&self, launch_id: &str) -> Option<u64> {
        let inner = self.lock();
        let owner = inner.owner.as_ref().filter(|owner| owner.launch_id == launch_id)?;
        if inner.context.as_ref().is_some_and(|context|
            context.launch_id != launch_id && context.revision >= owner.revision) {
            return None;
        }
        Some(owner.generation)
    }

    fn detach_owner(&self, launch_id: &str, generation: u64) {
        let mut inner = self.lock();
        if inner.owner.as_ref().is_some_and(|owner|
            owner.launch_id == launch_id && owner.generation == generation) {
            inner.owner = None;
            inner.view_active = false;
        }
    }

    pub(crate) fn attach_owner(state: &Arc<DaemonState>, launch_id: String, revision: u64)
        -> Option<SyncOwnerGuard> {
        let mut inner = state.refresh.lock();
        if inner.context.as_ref().is_some_and(|context|
            revision < context.revision || (revision == context.revision && launch_id != context.launch_id))
            || inner.owner.as_ref().is_some_and(|owner|
                revision < owner.revision || (revision == owner.revision && launch_id != owner.launch_id)) {
            return None;
        }
        inner.next_owner_generation = inner.next_owner_generation.checked_add(1)?;
        let generation = inner.next_owner_generation;
        inner.owner = Some(SyncOwner { launch_id: launch_id.clone(), revision, generation });
        inner.view_active = inner.context.as_ref().is_some_and(|context|
            context.launch_id == launch_id && context.revision >= revision);
        Some(SyncOwnerGuard { state: Arc::clone(state), launch_id, revision, generation })
    }

    pub(crate) async fn accept_context(state: &Arc<DaemonState>, input: ContextInput)
        -> Result<Value, &'static str> {
        let (listing, settings) = authoritative_snapshot(state).await
            .map_err(|_| "errors.syncUnavailable")?;
        let ids = accounts_doc::authoritative_ids(&listing.accounts);
        if let Some(ContextView::Subtree { mailbox, paths, .. }) = &input.view {
            if paths.is_empty() || paths.iter().any(|path| path != mailbox
                && !path.starts_with(&format!("{mailbox}/"))) {
                return Err("errors.accountsInvalid");
            }
        }
        let mut launch = false;
        let mut inner = state.refresh.lock();
        if input.revision < inner.context_revision {
            return Ok(json!({"instanceId":&state.refresh.instance_id,
                "accepted":false,"revision":inner.context_revision}));
        }
        if input.revision == inner.context_revision && inner.context.is_some() {
            if inner.context.as_ref() != Some(&input) { return Err("errors.accountsInvalid"); }
            return Ok(json!({"instanceId":&state.refresh.instance_id,
                "accepted":true,"revision":inner.context_revision}));
        }
        if inner.launches.iter().any(|mark| mark.id == input.launch_id)
            && inner.context.as_ref().is_some_and(|current| current.launch_id != input.launch_id) {
            return Ok(json!({"instanceId":&state.refresh.instance_id,
                "accepted":false,"revision":inner.context_revision}));
        }
        if !inner.launches.iter().any(|mark| mark.id == input.launch_id) {
            inner.launches.push_back(LaunchMark { id: input.launch_id.clone(),
                eligible: input.phase == ContextPhase::Start, consumed: false });
            while inner.launches.len() > 64 { inner.launches.pop_front(); }
        }
        if let Some(mark) = inner.launches.iter_mut().find(|mark| mark.id == input.launch_id) {
            if mark.eligible && !mark.consumed && refresh_policy::refresh_on_launch(&settings)
                && !ids.is_empty() {
                mark.consumed = true;
                launch = true;
            }
        }
        inner.context_revision = input.revision;
        inner.view_active = inner.owner.as_ref().is_some_and(|owner|
            owner.launch_id == input.launch_id && owner.revision <= input.revision);
        inner.context = Some(input);
        inner.automatic_enabled = true;
        let revision = inner.context_revision;
        drop(inner);
        state.refresh.automatic_wake.notify_one();
        if launch {
            let state = Arc::clone(state);
            tokio::spawn(async move {
                let _ = RefreshState::admit(&state, Intent { request_id: format!("native-launch-{}",
                    uuid::Uuid::new_v4()), account_id: None, mailbox: None,
                    reason: Reason::Launch }).await;
            });
        }
        Ok(json!({"instanceId":&state.refresh.instance_id,"accepted":true,"revision":revision}))
    }

    #[cfg(test)]
    pub(crate) fn test_duplicate_join_count(&self) -> usize {
        self.duplicate_joins.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn now_ms() -> i64 { mailvault_core::people::model::now_ms() }

#[cfg(test)]
mod race_test_pause {
    use super::DaemonState;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use tokio::sync::oneshot;

    type Gate = (oneshot::Sender<()>, oneshot::Receiver<()>);
    static GATES: OnceLock<Mutex<HashMap<(PathBuf, &'static str), Gate>>> = OnceLock::new();
    fn gates() -> &'static Mutex<HashMap<(PathBuf, &'static str), Gate>> {
        GATES.get_or_init(Default::default)
    }
    pub(super) fn install(state: &DaemonState, stage: &'static str)
        -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let old = gates().lock().unwrap_or_else(|e| e.into_inner())
            .insert((state.app_dir.clone(), stage), (entered_tx, release_rx));
        assert!(old.is_none(), "one held refresh race per stage and vault");
        (entered_rx, release_tx)
    }
    pub(super) async fn pause(state: &DaemonState, stage: &'static str) {
        let gate = gates().lock().unwrap_or_else(|e| e.into_inner())
            .remove(&(state.app_dir.clone(), stage));
        if let Some((entered, release)) = gate {
            let _ = entered.send(());
            let _ = release.await;
        }
    }
}

#[cfg(test)]
pub(crate) fn test_hold_after_effect_read(state: &DaemonState)
    -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
    race_test_pause::install(state, "after-effect-read")
}
#[cfg(test)]
async fn test_pause_after_effect_read(state: &DaemonState) {
    race_test_pause::pause(state, "after-effect-read").await;
}
#[cfg(test)]
pub(crate) fn test_hold_before_ack_snapshot(state: &DaemonState)
    -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
    race_test_pause::install(state, "before-ack-snapshot")
}
#[cfg(test)]
async fn test_pause_before_ack_snapshot(state: &DaemonState) {
    race_test_pause::pause(state, "before-ack-snapshot").await;
}

#[cfg(test)]
type PublishGate = (tokio::sync::oneshot::Sender<()>, std::sync::mpsc::Receiver<()>);
#[cfg(test)]
fn publish_gates() -> &'static Mutex<HashMap<std::path::PathBuf, PublishGate>> {
    static GATES: OnceLock<Mutex<HashMap<std::path::PathBuf, PublishGate>>> = OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
pub(crate) fn test_hold_before_publication(state: &DaemonState)
    -> (tokio::sync::oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    publish_gates().lock().unwrap().insert(state.app_dir.clone(), (entered, held));
    (observed, release)
}
#[cfg(test)]
fn test_pause_before_publication(state: &DaemonState) {
    let gate = publish_gates().lock().unwrap().remove(&state.app_dir);
    if let Some((entered, release)) = gate {
        let _ = entered.send(());
        let _ = release.recv_timeout(std::time::Duration::from_secs(5));
    }
}

#[cfg(test)]
type AdmissionGate = (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>);
#[cfg(test)]
fn admission_gates() -> &'static Mutex<HashMap<std::path::PathBuf, AdmissionGate>> {
    static GATES: OnceLock<Mutex<HashMap<std::path::PathBuf, AdmissionGate>>> = OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
fn admission_counts() -> &'static Mutex<HashMap<std::path::PathBuf, usize>> {
    static COUNTS: OnceLock<Mutex<HashMap<std::path::PathBuf, usize>>> = OnceLock::new();
    COUNTS.get_or_init(Default::default)
}
#[cfg(test)]
pub(crate) fn test_admission_snapshot_count(state: &DaemonState) -> usize {
    *admission_counts().lock().unwrap().get(&state.app_dir).unwrap_or(&0)
}
#[cfg(test)]
pub(crate) fn test_hold_after_admission_snapshot(state: &DaemonState)
    -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    admission_gates().lock().unwrap().insert(state.app_dir.clone(), (entered, held));
    admission_counts().lock().unwrap().insert(state.app_dir.clone(), 0);
    (observed, release)
}
#[cfg(test)]
async fn test_pause_after_admission_snapshot(state: &DaemonState) {
    let gate = admission_gates().lock().unwrap().remove(&state.app_dir);
    if let Some((entered, release)) = gate {
        let _ = entered.send(());
        let _ = release.await;
    }
}

struct GraphWarm {
    added: usize,
    arrival_uids: Vec<u32>,
    repaint: bool,
}

pub(crate) async fn graph_headers(state: &Arc<DaemonState>, origin: &Origin, config: &crate::imap::ImapConfig,
    mailbox: &str, extent: Extent) -> Result<usize, String> {
    graph_warm(state, origin, config, mailbox, extent).await.map(|result| result.added)
}

async fn graph_warm(state: &Arc<DaemonState>, origin: &Origin, config: &crate::imap::ImapConfig,
    mailbox: &str, extent: Extent) -> Result<GraphWarm, String> {
    let settings = settings_now(state).await?;
    let id = origin.original.id();
    if settings["graphFolderKeysAdopted"][id] != true {
        return Err("errors.syncGraphAdoptionRequired".into());
    }
    let baseline = crate::handlers::cache::graph_baseline(state, id, mailbox).await?;
    let identity = mailvault_core::imap::NativeHeaderIdentity::new(config, id, mailbox, None);
    let comparable = baseline.complete && baseline.owner.as_ref() == Some(&identity);
    let highest_before = baseline.uids.iter().copied().max().unwrap_or(0);
    let mut expected = serde_json::to_value(&baseline.owner)
        .map_err(|_| "errors.bulkIdentityUncertain".to_owned())?;
    let token = config.access_token.as_deref().filter(|token| !token.is_empty())
        .ok_or("errors.syncCredentialsMissing")?;
    let client = GraphClient::new(token).for_account(&config.email);
    let folders = client.list_folders().await.map_err(|_| "errors.syncFailed".to_owned())?;
    if settings["graphFolderKeysAdoptedFromListing"][id] != true
        && folders.iter().any(|folder| folder.well_known_name.is_some()
            && !folder.storage_key.is_empty()
            && !folder.display_name.to_lowercase().eq(&folder.storage_key.to_lowercase())) {
        return Err("errors.syncGraphAdoptionRequired".into());
    }
    let folder = folders.iter().find(|folder| folder.storage_key == mailbox)
        .ok_or("errors.syncFailed")?;
    let provider_total = folder.total_item_count;
    let (mut messages, mut next) = client.list_messages(&folder.id, 200, 0).await
        .map_err(|_| "errors.syncFailed".to_owned())?;
    let mut seen_links = HashSet::new();
    let mut listed_uids = HashSet::new();
    let mut ordered_uids = Vec::new();
    let mut added_total = 0;
    let mut repaint = false;
    loop {
        let current = sync_observation::origin(state, origin.original.clone()).await?;
        if current.hash != origin.hash { return Err("errors.bulkIdentityChanged".into()); }
        let entries: Vec<(String, Option<String>)> = messages.iter().map(|message|
            (message.id.clone(), message.internet_message_id.clone())).collect();
        let uids = crate::handlers::cache::graph_allocate_with_original(state, origin, mailbox,
            expected.clone(), entries).await?;
        if uids.len() != messages.len() { return Err("errors.syncHeadersIncomplete".into()); }
        for uid in &uids {
            if listed_uids.insert(*uid) { ordered_uids.push(*uid); }
        }
        let headers = messages.iter().zip(uids).map(|(message, uid)| message.to_email_header(uid)).collect();
        let had_page = !messages.is_empty();
        let added = crate::handlers::cache::graph_save_with_original(state, origin, config, mailbox,
            expected.clone(), headers).await?;
        added_total += added.len();
        repaint |= had_page;
        // The first page wrote this exact identity under the original account.
        // Only that successful self-transition may advance the next page's CAS.
        expected = serde_json::to_value(&identity)
            .map_err(|_| "errors.bulkIdentityUncertain".to_owned())?;
        if extent == Extent::RefreshPage { break; }
        let Some(link) = next.take() else { break };
        if !seen_links.insert(link.clone()) { return Err("errors.syncHeadersIncomplete".into()); }
        (messages, next) = client.list_messages_next(&link).await
            .map_err(|_| "errors.syncFailed".to_owned())?;
    }
    let complete = crate::handlers::cache::graph_finish_with_original(state, origin, config,
        mailbox, listed_uids, provider_total, next.is_none()).await?;
    if extent == Extent::Complete && !complete { return Err("errors.syncHeadersIncomplete".into()); }
    let arrival_uids = if comparable && complete {
        ordered_uids.into_iter().filter(|uid| *uid > highest_before && !baseline.uids.contains(uid)).collect()
    } else { Vec::new() };
    Ok(GraphWarm { added: added_total, arrival_uids, repaint })
}

pub(crate) async fn authoritative_snapshot(state: &Arc<DaemonState>) -> Result<(accounts_doc::Listing, Value), String> {
    let app_dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || {
        let listing = accounts_doc::list(&accounts_doc::shared(&app_dir))
            .map_err(|_| "errors.bulkIdentityUncertain".to_owned())?;
        let settings_doc = settings_doc::SettingsDoc::shared(&app_dir);
        let values = match settings_doc.read() {
            Ok(settings) => settings.get("mailvault-settings").and_then(|store| store.get("state"))
                .cloned().unwrap_or_else(|| json!({})),
            Err(_) if matches!(std::fs::metadata(settings_doc.path()), Err(ref error)
                if error.kind() == std::io::ErrorKind::NotFound) => json!({}),
            Err(_) => return Err("errors.settingsNotLoaded".to_owned()),
        };
        Ok((listing, values))
    }).await.map_err(|_| "errors.syncUnavailable".to_owned())?
}

fn target_paths(intent: &Intent, view: Option<&ContextView>, account_id: &str,
    requested: &str) -> Vec<String> {
    if intent.account_id.is_some() && intent.mailbox.is_some() {
        return vec![requested.to_owned()];
    }
    match view {
        Some(ContextView::Ordinary { account_id: active, mailbox }) if active == account_id =>
            vec![mailbox.clone()],
        Some(ContextView::Subtree { account_id: active, paths, .. }) if active == account_id => {
            let mut seen = HashSet::new();
            paths.iter().filter(|path| seen.insert((*path).clone())).cloned().collect()
        }
        _ => vec![requested.to_owned()],
    }
}

async fn complete_admission(state: &Arc<DaemonState>, intent: Intent) {
    #[cfg(test)]
    { *admission_counts().lock().unwrap().entry(state.app_dir.clone()).or_default() += 1; }
    let (listing, settings) = match authoritative_snapshot(state).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            state.refresh.finish_admission_error(&intent.request_id, &error);
            return;
        }
    };
    #[cfg(test)]
    test_pause_after_admission_snapshot(state).await;
    let ids = accounts_doc::authoritative_ids(&listing.accounts);
    let visible = refresh_policy::visible_account_ids(&listing.accounts, &ids, &settings);
    let view = state.refresh.admitted_view(&intent.request_id);
    let requested = match intent.mailbox.as_deref() {
        Some("UNIFIED") => match &view {
            Some(ContextView::Unified { folder }) => folder.as_deref().unwrap_or("INBOX"),
            _ => {
                state.refresh.finish_admission_error(&intent.request_id, "errors.accountsInvalid");
                return;
            }
        },
        Some(mailbox) => mailbox,
        None => match &view {
            Some(ContextView::Unified { folder }) => folder.as_deref().unwrap_or("INBOX"),
            _ => "INBOX",
        },
    };
    let selected = match intent.account_id.as_deref() {
        Some(id) if visible.iter().any(|current| current == id) => vec![id.to_owned()],
        Some(id) if ids.contains(id) => Vec::new(), // hidden accounts are excluded
        Some(id) => {
            state.refresh.finish_admission(&intent,
                vec![Err(AccountResult::failed(id.into(), requested.into(),
                    "errors.bulkIdentityUncertain"))],
                Vec::new(), Extent::RefreshPage);
            return;
        }
        None => visible.clone(),
    };
    let extent = if intent.account_id.is_none() {
        Extent::Complete
    } else { Extent::RefreshPage };
    let mut prepared = Vec::with_capacity(selected.len());
    for id in selected {
        let original = match state.account_lifecycle.capture(&id) {
            Ok(original) => original,
            Err(_) => {
                prepared.push(Err(AccountResult::failed(id, requested.into(), "errors.keychainBusy")));
                continue;
            }
        };
        let row = listing.accounts.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(&id));
        let config = row.and_then(|row| crate::credentials::config_from_record(row).ok());
        match config {
            Some(config) => {
                let origin = Origin { original, hash: mailvault_core::bulk_worker::origin_hash(&config),
                    graph: config.uses_graph() };
                let paths = target_paths(&intent, view.as_ref(), &id, requested);
                for mailbox in paths { prepared.push(Ok((origin.clone(), mailbox))); }
            }
            None => prepared.push(Err(AccountResult::failed(id, requested.into(), "errors.bulkIdentityUncertain"))),
        }
    }
    let mut classification = Vec::new();
    for id in visible {
        let Some(row) = listing.accounts.iter().find(|row|
            row.get("id").and_then(Value::as_str) == Some(id.as_str())) else { continue };
        let Ok(original) = state.account_lifecycle.capture(&id) else { continue };
        let Ok(config) = crate::credentials::config_from_record(row) else { continue };
        classification.push(Origin { original,
            hash: mailvault_core::bulk_worker::origin_hash(&config), graph: config.uses_graph() });
    }
    state.refresh.finish_admission(&intent, prepared, classification, extent);
}

async fn settings_now(state: &Arc<DaemonState>) -> Result<Value, String> {
    let (_, settings) = authoritative_snapshot(state).await?;
    Ok(settings)
}

async fn classify_candidates(state: Arc<DaemonState>, candidates: Vec<Origin>) {
    let Ok(settings) = settings_now(&state).await else { return };
    if !mailvault_core::cleanup_rules::has_premium_access(&settings, now_ms()) { return; }
    for candidate in candidates {
        let id = candidate.original.id();
        if settings["hiddenAccounts"][id] == true { continue; }
        if !sync_observation::origin(&state, candidate.original.clone()).await
            .is_ok_and(|current| current.hash == candidate.hash) { continue; }
        let Ok(_operation) = state.account_lifecycle.try_operation(
            std::slice::from_ref(&candidate.original)) else { continue };
        crate::classification_worker::enqueue_for_classification_with_origin(Arc::clone(&state),
            candidate, crate::classification::QueueTier::New).await;
    }
}

async fn run_unit(state: Arc<DaemonState>, unit: &Unit) -> AccountResult {
    let failed = |key: &str| AccountResult::failed(unit.key.account_id.clone(), unit.key.mailbox.clone(), key);
    let id = unit.origin.original.id();
    if settings_now(&state).await.map_or(true, |settings| settings["hiddenAccounts"][id] == true) {
        return failed("errors.bulkIdentityChanged");
    }
    let current = match sync_observation::origin(&state, unit.origin.original.clone()).await {
        Ok(current) if current.hash == unit.origin.hash => current,
        _ => return failed("errors.bulkIdentityChanged"),
    };
    let read = if unit.manual { crate::oauth_tokens::Read::Guarded } else { crate::oauth_tokens::Read::Quiet };
    let config = match crate::oauth_tokens::resolve(&state, id, read).await {
        Ok(config) if mailvault_core::bulk_worker::origin_hash(&config) == current.hash => config,
        Ok(_) => return failed("errors.bulkIdentityChanged"),
        Err(_) => return failed("errors.syncCredentialsMissing"),
    };
    let _operation = match state.account_lifecycle.try_operation(std::slice::from_ref(&current.original)) {
        Ok(permit) => permit,
        Err(_) => return failed("errors.keychainBusy"),
    };
    state.sync_observation.invalidate_probe(id, Some(&unit.key.mailbox));
    state.sync_observation.invalidate_folder(id);
    let evidence = state.sync_observation.issue_ticket(&current, &unit.key.mailbox);
    let before_uids = sync_observation::cached_uids(&state, id, &unit.key.mailbox).await.ok();
    if current.graph {
        let warmed = match graph_warm(&state, &current, &config, &unit.key.mailbox, unit.key.extent).await {
            Ok(warmed) => warmed,
            Err(error) => {
                let mut result = failed(&error);
                if error == "errors.syncGraphAdoptionRequired" { result.needs_shell_adoption = Some(true); }
                return result;
            }
        };
        #[cfg(test)]
        test_pause_before_publication(&state);
        let source = match sync_observation::complete_ticket_in_mailbox(&state, &evidence, &unit.key.mailbox).await {
            Some(source) => source,
            None => return failed("errors.bulkIdentityChanged"),
        };
        let after_uids = sync_observation::cached_uids(&state, id, &unit.key.mailbox).await.ok();
        let changed = warmed.repaint || before_uids.as_ref().zip(after_uids.as_ref())
            .is_some_and(|(before, after)| before != after);
        #[cfg(test)]
        test_pause_after_effect_read(&state).await;
        let changes = if changed { vec![(source, warmed.arrival_uids, 0)] } else { Vec::new() };
        if sync_observation::publish_sources(&state, &evidence, changes).await.is_err() {
            return failed("errors.bulkIdentityChanged");
        }
        if warmed.added > 0 { state.auto_tag_worker.wake(); }
        return AccountResult { account_id: id.into(), mailbox: unit.key.mailbox.clone(), success: true,
            error_key: None, needs_shell_adoption: None };
    }
    let account = SyncAccount { id: id.into(), email: config.email.clone(), imap_config: config };
    let result = state.sync_engine.sync_account_with_original(&account, &unit.key.mailbox,
        current.original.clone(), &evidence).await;
    if !result.success {
        return failed(if result.offline { "errors.syncOffline" } else { "errors.syncFailed" });
    }
    let fill_failed = if unit.key.extent == Extent::Complete {
        let fill = if account.imap_config.uses_jmap() {
            crate::sync_jmap::complete_headers_with_stamp(&state, &account, &result.mailbox,
                &current.original, result.total_emails).await
        } else {
            state.sync_engine.backfill_mailbox_with_stamp(&account, &result.mailbox,
                &current.original, result.total_emails).await
        };
        fill.is_err()
    } else { false };
    #[cfg(test)]
    test_pause_before_publication(&state);
    let source = match sync_observation::complete_ticket_in_mailbox(&state, &evidence, &result.mailbox).await {
        Some(source) => source,
        None => return failed("errors.bulkIdentityChanged"),
    };
    if source.cache_owner.as_ref().is_none_or(|owner| owner.origin_hash != current.hash) {
        return failed("errors.bulkIdentityChanged");
    }
    let after_uids = sync_observation::cached_uids(&state, id, &result.mailbox).await.ok();
    let cache_changed = before_uids.as_ref().zip(after_uids.as_ref())
        .is_some_and(|(before, after)| before != after);
    let changed = result.arrivals > 0 || result.updated_flags > 0 || cache_changed || result.new_emails > 0;
    #[cfg(test)]
    test_pause_after_effect_read(&state).await;
    let changes = if changed { vec![(source, result.arrival_uids.clone(), result.updated_flags)] }
        else { Vec::new() };
    if sync_observation::publish_sources(&state, &evidence, changes).await.is_err() {
        return failed("errors.bulkIdentityChanged");
    }
    if result.arrivals > 0 { state.hoarder_worker.wake(); }
    if result.new_emails > 0 || cache_changed { state.auto_tag_worker.wake(); }
    if fill_failed { return failed("errors.syncHeadersIncomplete"); }
    AccountResult { account_id: account.id, mailbox: result.mailbox, success: true,
        error_key: None, needs_shell_adoption: None }
}

fn spawn_automatic(state: Arc<DaemonState>, reason: Reason) {
    tokio::spawn(async move {
        let label = match reason { Reason::Launch => "launch", _ => "scheduled" };
        let _ = RefreshState::admit(&state, Intent { request_id: format!("native-{label}-{}",
            uuid::Uuid::new_v4()), account_id: None, mailbox: None, reason }).await;
    });
}

async fn reconcile_watchers(state: &Arc<DaemonState>, listing: &accounts_doc::Listing) {
    let authoritative = accounts_doc::authoritative_ids(&listing.accounts);
    let mut wanted = HashSet::new();
    for row in &listing.accounts {
        let Some(id) = row.get("id").and_then(Value::as_str).filter(|id| authoritative.contains(*id))
            else { continue };
        if !wanted.insert(id.to_owned()) { continue; }
        let Ok(record_config) = crate::credentials::config_from_record(row) else {
            wanted.remove(id);
            continue;
        };
        if record_config.uses_graph() { wanted.remove(id); continue; }
        let Ok(config) = crate::oauth_tokens::resolve(state, id, crate::oauth_tokens::Read::Quiet).await
            else { wanted.remove(id); continue; };
        if mailvault_core::bulk_worker::origin_hash(&record_config)
            != mailvault_core::bulk_worker::origin_hash(&config) {
            wanted.remove(id);
            continue;
        }
        state.idle.watch(SyncAccount { id: id.to_owned(), email: config.email.clone(),
            imap_config: config }, std::time::Duration::from_secs(29 * 60)).await;
    }
    for watcher in state.idle.status().await {
        if !wanted.contains(&watcher.account_id) {
            state.idle.unwatch(&watcher.account_id).await;
        }
    }
}

#[derive(Default)]
struct ScheduleDeadline {
    interval: Option<u64>,
    account_count: usize,
    at: Option<tokio::time::Instant>,
}

impl ScheduleDeadline {
    fn update(&mut self, interval: Option<u64>, account_count: usize, reset: bool) {
        if reset || self.interval != interval || self.account_count != account_count {
            self.interval = interval;
            self.account_count = account_count;
            self.at = interval.and_then(|ms| tokio::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(ms)));
        }
    }

    fn elapsed(&mut self) {
        self.at = self.interval.and_then(|ms| tokio::time::Instant::now()
            .checked_add(std::time::Duration::from_millis(ms)));
    }
}

async fn automatic_loop(weak: std::sync::Weak<DaemonState>, wake: Arc<tokio::sync::Notify>) {
    loop {
        let Some(state) = weak.upgrade() else { return };
        let enabled = state.refresh.lock().automatic_enabled;
        drop(state);
        if enabled { break; }
        wake.notified().await;
    }
    let Some(state) = weak.upgrade() else { return };
    let mut events = state.events.subscribe();
    let mut online = state.net.subscribe_transitions();
    drop(state);
    let mut schedule = ScheduleDeadline::default();
    let mut reset_deadline = true;
    loop {
        let Some(state) = weak.upgrade() else { return };
        let policy_ready = if let Ok((listing, settings)) = authoritative_snapshot(&state).await {
            let count = accounts_doc::authoritative_ids(&listing.accounts).len();
            reconcile_watchers(&state, &listing).await;
            if state.refresh.consume_eligible_launch(&settings, count > 0) {
                spawn_automatic(Arc::clone(&state), Reason::Launch);
            }
            let next_interval = if count > 0 { refresh_policy::interval_ms(&settings) } else { None };
            schedule.update(next_interval, count, reset_deadline);
            reset_deadline = false;
            true
        } else {
            // An unreadable native document cannot authorize a timer. Keep a
            // pending due bit for a later event/recovery, but park this clock.
            schedule.update(None, 0, true);
            reset_deadline = true;
            false
        };
        if policy_ready && state.net.is_online() && state.refresh.take_automatic_due_if_idle() {
            spawn_automatic(Arc::clone(&state), Reason::Scheduled);
        }
        drop(state);
        let next_deadline = schedule.at;
        let timer = async move {
            if let Some(at) = next_deadline { tokio::time::sleep_until(at).await }
            else { std::future::pending::<()>().await }
        };
        tokio::select! {
            _ = timer => {
                if let Some(state) = weak.upgrade() { state.refresh.mark_automatic_due(); }
                schedule.elapsed();
            }
            event = events.recv() => {
                match event {
                    Ok(line) => {
                        let name = mailvault_core::daemon_ipc::parse_event(&line)
                            .map(|(name, _)| name).unwrap_or_default();
                        if !matches!(name.as_str(), "settings-changed" | "accounts-changed"
                            | "credentials-changed" | "oauth2-tokens-refreshed") { continue; }
                        reset_deadline = matches!(name.as_str(), "settings-changed" | "accounts-changed");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => reset_deadline = true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
            changed = online.changed() => {
                if changed.is_err() { return; }
                if !*online.borrow() { continue; }
                reset_deadline = false;
            }
            _ = wake.notified() => {}
        }
    }
}

/// Start once at daemon construction, before a route can reserve work.
pub(crate) fn start(state: &Arc<DaemonState>) {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    if state.refresh.sender.set(sender).is_err() { return; }
    let weak = Arc::downgrade(state);
    let spawn = std::thread::Builder::new().name("refresh-worker".into())
        .stack_size(8 * 1024 * 1024).spawn(move || {
            #[cfg(target_os = "macos")]
            unsafe {
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
            }
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all()
                .thread_name("refresh-blocking").thread_stack_size(8 * 1024 * 1024)
                .on_thread_start(|| {
                    #[cfg(target_os = "macos")]
                    unsafe {
                        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
                    }
                }).build();
            let Ok(runtime) = runtime else { return };
            runtime.block_on(async move {
                let automatic_wake = weak.upgrade().map(|state| Arc::clone(&state.refresh.automatic_wake));
                if let Some(wake) = automatic_wake {
                    tokio::spawn(automatic_loop(weak.clone(), wake));
                }
                while receiver.recv().await.is_some() {
                    let Some(state) = weak.upgrade() else { break };
                    while let Some(unit) = state.refresh.take_next() {
                        let outcome = Box::pin(run_unit(Arc::clone(&state), &unit)).await;
                        for candidates in state.refresh.finish_unit(&unit, outcome) {
                            let state = Arc::clone(&state);
                            tokio::spawn(async move { classify_candidates(state, candidates).await; });
                        }
                    }
                }
            });
        });
    if let Err(error) = spawn { tracing::warn!("refresh worker unavailable: {error}"); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_refresh_worker_future_stays_within_stack_budget() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["acc1"]);
        let original = state.account_lifecycle.capture("acc1").unwrap();
        let epoch = original.epoch();
        let origin_hash = "future-size-only".to_string();
        let unit = Unit {
            key: TargetKey { account_id: "acc1".into(), mailbox: "INBOX".into(),
                epoch, origin_hash: origin_hash.clone(), extent: Extent::Complete },
            origin: Origin { original, hash: origin_hash, graph: false },
            manual: true, dependents: Vec::new(),
        };
        // Construct the exact long future on the same 8 MiB stack budget as
        // refresh-worker; the production loop boxes it before awaiting.
        let bytes = std::thread::Builder::new().name("refresh-future-measure".into())
            .stack_size(8 * 1024 * 1024).spawn(move || {
                let future = run_unit(state, &unit);
                std::mem::size_of_val(&future)
            }).unwrap().join().unwrap();
        assert!(bytes < 2 * 1024 * 1024,
            "actual Complete refresh run_unit future is {bytes} bytes; budget 2 MiB, worker stack 8 MiB");
    }

    #[tokio::test]
    async fn c5_new_channel_generation_survives_old_drop_and_detach_keeps_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&[]);
        let old = RefreshState::attach_owner(&state, "launch-a".into(), 1).unwrap();
        RefreshState::accept_context(&state, ContextInput {
            launch_id: "launch-a".into(), revision: 1, phase: ContextPhase::Resume,
            view: Some(ContextView::Ordinary { account_id: "acc1".into(), mailbox: "Sent".into() }),
        }).await.unwrap();
        assert!(state.refresh.lock().view_active);
        let newer = RefreshState::attach_owner(&state, "launch-a".into(), 2).unwrap();
        RefreshState::accept_context(&state, ContextInput {
            launch_id: "launch-a".into(), revision: 2, phase: ContextPhase::Resume,
            view: Some(ContextView::Ordinary { account_id: "acc1".into(), mailbox: "Sent".into() }),
        }).await.unwrap();
        drop(old);
        assert!(state.refresh.lock().view_active,
            "old channel drop cannot clear the newer native generation");
        assert!(RefreshState::attach_owner(&state, "launch-a".into(), 1).is_none(),
            "stale revision cannot reclaim the view");
        drop(newer);
        let inner = state.refresh.lock();
        assert!(!inner.view_active, "last matching owner clears view priority");
        assert!(inner.automatic_enabled, "channel loss keeps native schedule activation");
        assert_eq!(inner.context_revision, 2);
    }

    #[tokio::test]
    async fn c5_net_recovery_runs_one_pending_due_attempt_without_replay() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["acc1"]);
        mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
            "mailvault-settings":{"state":{"refreshOnLaunch":false,"refreshInterval":0}},
        }), None).unwrap();
        RefreshState::accept_context(&state, ContextInput {
            launch_id: "c5-recovery".into(), revision: 1, phase: ContextPhase::Resume,
            view: None,
        }).await.unwrap();
        state.net.test_set_online(false);
        state.refresh.mark_automatic_due();
        assert!(state.refresh.lock().automatic_due,
            "offline due work remains pending for a real transition");
        assert!(state.refresh.status(None)["receipts"].as_array().unwrap().is_empty());
        state.net.test_set_online(true);
        let mut receipts = Vec::new();
        for _ in 0..200 {
            receipts = state.refresh.status(None)["receipts"].as_array().unwrap().clone();
            if receipts.len() == 1 && receipts[0]["completedAt"].is_number() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(receipts.len(), 1, "recovery must consume one pending due attempt");
        assert!(receipts[0]["requestId"].as_str().unwrap().starts_with("native-scheduled-"));
        assert!(!state.refresh.lock().automatic_due);
        state.net.test_set_online(true);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(state.refresh.status(None)["receipts"].as_array().unwrap().len(), 1,
            "repeated online state cannot replay an automatic receipt");
    }

    #[tokio::test]
    async fn c5_controlled_deadline_resets_on_settings_and_account_changes() {
        tokio::time::pause();
        let mut schedule = ScheduleDeadline::default();
        schedule.update(Some(60_000), 1, false);
        let first = schedule.at.expect("one-minute initial deadline");
        tokio::time::advance(std::time::Duration::from_secs(30)).await;
        schedule.update(Some(60_000), 1, false);
        assert_eq!(schedule.at, Some(first), "ordinary wake cannot restart a deadline");
        schedule.update(Some(60_000), 1, true);
        let settings_reset = schedule.at.unwrap();
        assert_eq!(settings_reset - first, std::time::Duration::from_secs(30));
        tokio::time::advance(std::time::Duration::from_secs(30)).await;
        assert!(tokio::time::Instant::now() < settings_reset,
            "old deadline must not tick after settings change");
        schedule.update(Some(60_000), 2, false);
        let account_reset = schedule.at.unwrap();
        assert!(account_reset > settings_reset,
            "account-count change restarts only the future deadline");
        tokio::time::advance(std::time::Duration::from_secs(60)).await;
        assert_eq!(tokio::time::Instant::now(), account_reset);
        schedule.elapsed();
        assert_eq!(schedule.at.unwrap() - account_reset, std::time::Duration::from_secs(60));
        schedule.update(None, 2, true);
        assert!(schedule.at.is_none(), "disabled interval cannot retain an old tick");
    }

    #[test]
    fn c5_pending_automatic_ticks_collapse_once_after_queue_drains() {
        let state = RefreshState::default();
        state.mark_automatic_due();
        state.mark_automatic_due();
        assert!(state.take_automatic_due_if_idle());
        assert!(!state.take_automatic_due_if_idle(), "two elapsed ticks make one due attempt");
        state.mark_automatic_due();
        state.lock().active = Some(TargetKey { account_id: "acc1".into(),
            mailbox: "INBOX".into(), epoch: 1, origin_hash: "old".into(),
            extent: Extent::RefreshPage });
        assert!(!state.take_automatic_due_if_idle(), "active provider work retains due state");
        state.lock().active = None;
        assert!(state.take_automatic_due_if_idle(), "due attempt resumes after active work");
    }

    fn intent(index: usize) -> Intent {
        Intent { request_id: format!("bounded-{index}"), account_id: Some("acc1".into()),
            mailbox: Some("INBOX".into()), reason: Reason::Manual }
    }

    #[test]
    fn live_receipt_capacity_refuses_before_admission_and_terminal_eviction_is_oldest_only() {
        let state = RefreshState::default();
        for index in 0..MAX_LIVE {
            assert!(matches!(state.reserve(&intent(index)), Ok(Reservation::New(_))));
        }
        assert!(matches!(state.reserve(&intent(MAX_LIVE)), Err("errors.operationRunning")));
        assert_eq!(state.lock().queue.len(), 0, "refused admission cannot enqueue provider work");
        state.finish_admission_error("bounded-0", "errors.syncFailed");
        assert!(matches!(state.reserve(&intent(MAX_LIVE)), Ok(Reservation::New(_))));
        assert!(state.lock().records.contains_key("bounded-1"), "live receipt must survive an older terminal");

        let terminal = RefreshState::default();
        for index in 0..=MAX_TERMINAL {
            assert!(matches!(terminal.reserve(&intent(index)), Ok(Reservation::New(_))));
            terminal.finish_admission_error(&intent(index).request_id, "errors.syncFailed");
        }
        let inner = terminal.lock();
        assert_eq!(inner.records.len(), MAX_TERMINAL);
        assert!(!inner.records.contains_key("bounded-0"), "only the oldest terminal is evicted");
        assert!(inner.records.contains_key(&format!("bounded-{MAX_TERMINAL}")));

        let interleaved = RefreshState::default();
        let live_id = intent(MAX_TERMINAL + 1);
        assert!(matches!(interleaved.reserve(&live_id), Ok(Reservation::New(_))));
        for index in 0..=MAX_TERMINAL {
            assert!(matches!(interleaved.reserve(&intent(index)), Ok(Reservation::New(_))));
            interleaved.finish_admission_error(&intent(index).request_id, "errors.syncFailed");
        }
        let inner = interleaved.lock();
        assert_eq!(inner.records.len(), MAX_TERMINAL + 1);
        assert!(inner.records.contains_key(&live_id.request_id),
            "terminal eviction interleaved with admission must retain the live receipt");
    }

    #[test]
    fn same_id_joins_held_admission_without_another_record_or_queue_unit() {
        let state = RefreshState::default();
        let wanted = intent(7);
        let first = state.reserve(&wanted).unwrap();
        let repeat = state.reserve(&wanted).unwrap();
        assert!(matches!(first, Reservation::New(_)));
        assert!(matches!(repeat, Reservation::Existing(_)));
        let inner = state.lock();
        assert_eq!(inner.records.len(), 1);
        assert_eq!(inner.order.len(), 1);
        assert!(inner.queue.is_empty(), "the shared admission has not read a source or queued provider work");
    }

    #[tokio::test]
    async fn r6_held_original_ack_survives_65_newer_terminal_evictions() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&[]);
        let first = Intent { request_id: "held-ack-first".into(), account_id: None,
            mailbox: None, reason: Reason::Manual };
        let (entered, release) = test_hold_before_ack_snapshot(&state);
        let first_state = Arc::clone(&state);
        let waiting = tokio::spawn(async move { RefreshState::admit(&first_state, first).await });
        tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
            .expect("first empty admission must reach the actual ACK snapshot gap")
            .expect("ACK gate must signal");
        for index in 0..=MAX_TERMINAL {
            let intent = Intent { request_id: format!("newer-terminal-{index}"), account_id: None,
                mailbox: None, reason: Reason::Manual };
            let ack = RefreshState::admit(&state, intent).await
                .expect("newer empty admission must return");
            assert_eq!(ack["receipt"]["status"], serde_json::json!("complete"));
        }
        assert_eq!(state.refresh.status(Some("held-ack-first"))["found"], serde_json::json!(false),
            "65 newer terminal receipts must actually evict the held first ID");
        release.send(()).unwrap();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), waiting).await
            .expect("original ACK waiter must finish after eviction");
        assert!(outcome.is_ok_and(|reply| reply.is_ok()),
            "R6 held original ACK must not panic after 65 terminal evictions or issue extra work");
        assert!(state.refresh.lock().queue.is_empty(), "empty admissions cannot queue provider work");
    }
}
