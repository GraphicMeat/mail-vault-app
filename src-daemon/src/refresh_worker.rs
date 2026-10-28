//! Volatile native refresh receipts and the dedicated header worker.

use crate::account_lifecycle::AccountStamp;
use crate::server::DaemonState;
use crate::sync_engine::SyncAccount;
use crate::sync_observation::{self, Origin};
use mailvault_core::{accounts_doc, refresh_policy, settings_doc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
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

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Extent { RefreshPage, Complete }

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
    admitted: watch::Sender<bool>,
    pending: usize,
    done: Vec<bool>,
    classification: Vec<Origin>,
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
}

pub(crate) struct RefreshState {
    instance_id: String,
    inner: Mutex<Inner>,
    sender: OnceLock<mpsc::UnboundedSender<()>>,
}

impl Default for RefreshState {
    fn default() -> Self {
        Self { instance_id: uuid::Uuid::new_v4().to_string(), inner: Mutex::new(Inner::default()),
            sender: OnceLock::new() }
    }
}

enum Reservation {
    New(watch::Receiver<bool>),
    Existing(watch::Receiver<bool>),
}

impl RefreshState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn reserve(&self, intent: &Intent) -> Result<Reservation, &'static str> {
        let mut inner = self.lock();
        if let Some(record) = inner.records.get(&intent.request_id) {
            if record.intent != *intent { return Err("errors.accountsInvalid"); }
            return Ok(Reservation::Existing(record.admitted.subscribe()));
        }
        let live = inner.records.values().filter(|record| record.receipt.completed_at.is_none()).count();
        if live >= MAX_LIVE { return Err("errors.operationRunning"); }
        let (admitted, rx) = watch::channel(false);
        inner.order.push_back(intent.request_id.clone());
        inner.records.insert(intent.request_id.clone(), Record {
            intent: intent.clone(),
            receipt: Receipt { request_id: intent.request_id.clone(), status: "queued",
                account_results: Vec::new(), error_key: None, completed_at: None },
            admitted, pending: 0, done: Vec::new(), classification: Vec::new(),
        });
        Ok(Reservation::New(rx))
    }

    fn snapshot(&self, request_id: &str) -> Receipt {
        self.lock().records.get(request_id).expect("reserved refresh receipt").receipt.clone()
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
            record.admitted.send_replace(true);
        }
        inner.last_refresh_time = Some(now_ms());
        Self::trim_terminal(&mut inner);
    }

    fn finish_admission(&self, intent: &Intent, prepared: Vec<Result<Origin, AccountResult>>,
        classification: Vec<Origin>, mailbox: &str, extent: Extent) {
        let mut inner = self.lock();
        let mut pending = Vec::new();
        let admitted;
        let completed_at;
        {
            let record = inner.records.get_mut(&intent.request_id).expect("reserved refresh receipt");
            record.classification = classification;
            for target in prepared {
                let index = record.receipt.account_results.len();
                match target {
                    Ok(origin) => {
                        let key = TargetKey { account_id: origin.original.id().into(),
                            mailbox: mailbox.into(), epoch: origin.original.epoch(),
                            origin_hash: origin.hash.clone(), extent };
                        record.receipt.account_results.push(AccountResult::pending(key.account_id.clone(), mailbox.into()));
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
        admitted.send_replace(true);
        Self::trim_terminal(&mut inner);
        drop(inner);
        if let Some(sender) = self.sender.get() { let _ = sender.send(()); }
    }

    fn take_next(&self) -> Option<Unit> {
        let mut inner = self.lock();
        let unit = inner.queue.pop_front()?;
        inner.active = Some(unit.key.clone());
        for (id, _) in &unit.dependents {
            if let Some(record) = inner.records.get_mut(id) { record.receipt.status = "running"; }
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
                }
            }
        }
        if latest.is_some() { inner.last_refresh_time = latest; }
        Self::trim_terminal(&mut inner);
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
        while !*rx.borrow() {
            if rx.changed().await.is_err() { return Err("errors.syncUnavailable"); }
        }
        Ok(json!({"instanceId":&state.refresh.instance_id,"receipt":state.refresh.snapshot(&intent.request_id)}))
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
}

fn now_ms() -> i64 { mailvault_core::people::model::now_ms() }

async fn authoritative_snapshot(state: &Arc<DaemonState>) -> Result<(accounts_doc::Listing, Value), String> {
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

async fn complete_admission(state: &Arc<DaemonState>, intent: Intent) {
    let (listing, settings) = match authoritative_snapshot(state).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            state.refresh.finish_admission_error(&intent.request_id, &error);
            return;
        }
    };
    let ids = accounts_doc::authoritative_ids(&listing.accounts);
    let visible = refresh_policy::visible_account_ids(&listing.accounts, &ids, &settings);
    let selected = match intent.account_id.as_deref() {
        Some(id) if visible.iter().any(|current| current == id) => vec![id.to_owned()],
        Some(id) if ids.contains(id) => Vec::new(), // hidden accounts are excluded
        Some(id) => {
            state.refresh.finish_admission(&intent,
                vec![Err(AccountResult::failed(id.into(), intent.mailbox.clone().unwrap_or_else(|| "INBOX".into()),
                    "errors.bulkIdentityUncertain"))],
                Vec::new(), intent.mailbox.as_deref().unwrap_or("INBOX"), Extent::RefreshPage);
            return;
        }
        None => visible.clone(),
    };
    let mailbox = intent.mailbox.as_deref().unwrap_or("INBOX");
    let extent = if intent.account_id.is_none() {
        Extent::Complete
    } else { Extent::RefreshPage };
    let mut prepared = Vec::with_capacity(selected.len());
    for id in selected {
        let original = match state.account_lifecycle.capture(&id) {
            Ok(original) => original,
            Err(_) => {
                prepared.push(Err(AccountResult::failed(id, mailbox.into(), "errors.keychainBusy")));
                continue;
            }
        };
        let row = listing.accounts.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(&id));
        let config = row.and_then(|row| crate::credentials::config_from_record(row).ok());
        match config {
            Some(config) => prepared.push(Ok(Origin { original,
                hash: mailvault_core::bulk_worker::origin_hash(&config), graph: config.uses_graph() })),
            None => prepared.push(Err(AccountResult::failed(id, mailbox.into(), "errors.bulkIdentityUncertain"))),
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
    state.refresh.finish_admission(&intent, prepared, classification, mailbox, extent);
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
        crate::classification_worker::enqueue_for_classification(Arc::clone(&state), id,
            crate::classification::QueueTier::New).await;
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
    if current.graph { return failed("errors.syncFailed"); } // Graph is checkpoint 4.
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
    let account = SyncAccount { id: id.into(), email: config.email.clone(), imap_config: config };
    let result = state.sync_engine.sync_account_with_original(&account, &unit.key.mailbox,
        current.original.clone()).await;
    if !result.success {
        return failed(if result.offline { "errors.syncOffline" } else { "errors.syncFailed" });
    }
    if unit.key.extent == Extent::Complete {
        if state.sync_engine.backfill_mailbox_with_stamp(&account, &result.mailbox,
            &current.original, result.total_emails).await.is_err() {
            return failed("errors.syncHeadersIncomplete");
        }
    }
    let source = match sync_observation::complete_ticket_in_mailbox(&state, &evidence, &result.mailbox).await {
        Some(source) => source,
        None => return failed("errors.bulkIdentityChanged"),
    };
    if source.cache_owner.as_ref().is_none_or(|owner| owner.origin_hash != current.hash) {
        return failed("errors.bulkIdentityChanged");
    }
    if result.arrivals > 0 { state.hoarder_worker.wake(); }
    if result.new_emails > 0 { state.auto_tag_worker.wake(); }
    let after_uids = sync_observation::cached_uids(&state, id, &result.mailbox).await.ok();
    if result.arrivals > 0 || result.updated_flags > 0
        || before_uids != after_uids || result.new_emails > 0 {
        state.sync_engine.note_source_change(source, result.arrival_uids, result.updated_flags);
    }
    AccountResult { account_id: account.id, mailbox: result.mailbox, success: true,
        error_key: None, needs_shell_adoption: None }
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
