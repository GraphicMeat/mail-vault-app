use crate::handlers::common::vault_root;
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use futures::{stream, Stream, StreamExt};
use mailvault_core::search_index::{
    self as core_search,
    query::{SearchHit, SearchPage, SearchRequest},
};
use mailvault_core::vault_eml::LightEmail;
use mailvault_core::vault_files;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

fn default_concurrency() -> usize {
    1
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailSearchStart {
    pub search_id: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub date_from: Option<i64>,
    #[serde(default)]
    pub date_to: Option<i64>,
    #[serde(default)]
    pub has_attachments: bool,
    pub location: SearchLocation,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub targets: Vec<MailSearchTarget>,
}

impl MailSearchStart {
    fn effective_concurrency(&self) -> usize {
        self.concurrency.clamp(1, 5)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailSearchTarget {
    pub account_id: String,
    pub account: Option<mailvault_core::imap::ImapConfig>,
    pub local_mailboxes: Option<Vec<String>>,
    #[serde(default)]
    pub known_mailboxes: Vec<String>,
    #[serde(default)]
    pub server_mailboxes: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailSearchProgress {
    pub search_id: String,
    pub sequence: u64,
    pub lane: Option<SearchLane>,
    pub rows: Vec<Value>,
    pub completed: usize,
    pub total: usize,
    pub local_mode: Option<LocalMode>,
    pub fallback_reason: Option<FallbackReason>,
    pub coverage: Option<SearchCoverage>,
    pub replace_index_account_id: Option<String>,
    pub failures: Vec<SearchFailure>,
    pub terminal: Option<SearchTerminal>,
    pub error_key: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SearchLocation {
    All,
    Local,
    Server,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SearchLane {
    Local,
    Server,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LocalMode {
    Index,
    Scan,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FallbackReason {
    Off,
    Building,
    Unavailable,
    Recovering,
    Error,
}

impl FallbackReason {
    fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("off") => Self::Off,
            Some("building") => Self::Building,
            Some("recovering") => Self::Recovering,
            Some("error") => Self::Error,
            _ => Self::Unavailable,
        }
    }
}

fn index_fallback_reason(state: &DaemonState, reason: Option<&str>) -> FallbackReason {
    match *crate::search_index::g(&state.search_index.phase) {
        "recovering" => FallbackReason::Recovering,
        "error" => FallbackReason::Error,
        _ => FallbackReason::from_wire(reason),
    }
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SearchTerminal {
    Complete,
    Cancelled,
    Error,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchCoverage {
    pub indexed: u64,
    pub total: u64,
    pub complete: bool,
    pub matched: u64,
    pub shown: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchFailure {
    pub account_id: String,
    pub mailbox: String,
    pub lane: SearchLane,
    pub code: String,
}

#[derive(Default)]
pub(crate) struct SearchRun {
    cancelled: AtomicBool,
    sequence: AtomicU64,
    publish: Mutex<()>,
}

impl SearchRun {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct SearchRunGuard {
    state: Arc<DaemonState>,
    search_id: String,
    run: Arc<SearchRun>,
}

impl SearchRunGuard {
    fn register(state: Arc<DaemonState>, search_id: String) -> Result<Self, ()> {
        let run = Arc::new(SearchRun::default());
        let mut runs = state.search_runs.lock().unwrap_or_else(|p| p.into_inner());
        if runs.contains_key(&search_id) {
            return Err(());
        }
        runs.insert(search_id.clone(), Arc::clone(&run));
        drop(runs);
        Ok(Self {
            state,
            search_id,
            run,
        })
    }
}

impl Drop for SearchRunGuard {
    fn drop(&mut self) {
        let mut runs = self
            .state
            .search_runs
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if runs
            .get(&self.search_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.run))
        {
            runs.remove(&self.search_id);
        }
    }
}

pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    match method {
        "mail_search_start" => {
            let request = match serde_json::from_value::<MailSearchStart>(params.clone()) {
                Ok(request) => request,
                Err(error) => {
                    return Some(RpcResponse::error(
                        id,
                        ipc::INVALID_PARAMS,
                        format!("Invalid search request: {error}"),
                    ))
                }
            };
            if request.search_id.trim().is_empty()
                || request
                    .targets
                    .iter()
                    .any(|target| !valid_account_id(&target.account_id))
            {
                return Some(RpcResponse::error(
                    id,
                    ipc::INVALID_PARAMS,
                    "Invalid searchId or accountId",
                ));
            }
            let guard = match SearchRunGuard::register(Arc::clone(state), request.search_id.clone())
            {
                Ok(guard) => guard,
                Err(()) => {
                    return Some(RpcResponse::error(
                        id,
                        ipc::INVALID_PARAMS,
                        "Search is already active",
                    ))
                }
            };
            let response =
                RpcResponse::success(id, json!({"started":true,"searchId":request.search_id}));
            tokio::spawn(run_search(Arc::clone(state), request, guard));
            Some(response)
        }
        "mail_search_cancel" => {
            let Some(search_id) = params.get("searchId").and_then(Value::as_str) else {
                return Some(RpcResponse::error(
                    id,
                    ipc::INVALID_PARAMS,
                    "Missing searchId",
                ));
            };
            let run = state
                .search_runs
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(search_id)
                .cloned();
            if let Some(run) = &run {
                // Share the publication lock with emit_progress: once this
                // cancellation is acknowledged, no in-flight frame can send
                // result rows after it.
                let _publish = run.publish.lock().unwrap_or_else(|p| p.into_inner());
                run.cancelled.store(true, Ordering::SeqCst);
            }
            Some(RpcResponse::success(
                id,
                json!({"success":true,"found":run.is_some()}),
            ))
        }
        _ => None,
    }
}

fn valid_account_id(account_id: &str) -> bool {
    !account_id.is_empty()
        && account_id != "."
        && account_id != ".."
        && !account_id.contains('/')
        && !account_id.contains('\\')
        && !account_id.chars().any(char::is_control)
}

fn progress(search_id: &str) -> MailSearchProgress {
    MailSearchProgress {
        search_id: search_id.to_owned(),
        sequence: 0,
        lane: None,
        rows: Vec::new(),
        completed: 0,
        total: 0,
        local_mode: None,
        fallback_reason: None,
        coverage: None,
        replace_index_account_id: None,
        failures: Vec::new(),
        terminal: None,
        error_key: None,
    }
}

fn emit_progress(state: &DaemonState, run: &SearchRun, mut frame: MailSearchProgress) -> bool {
    let _publish = run.publish.lock().unwrap_or_else(|p| p.into_inner());
    if run.is_cancelled() && frame.terminal != Some(SearchTerminal::Cancelled) {
        return false;
    }
    frame.sequence = run.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(payload) = serde_json::to_value(frame) {
        state.events.emit("mail-search-progress", payload);
        true
    } else {
        false
    }
}

async fn run_search(state: Arc<DaemonState>, request: MailSearchStart, guard: SearchRunGuard) {
    let run = Arc::clone(&guard.run);
    let local_enabled = !request.targets.is_empty() && request.location != SearchLocation::Server;
    let (ready_tx, ready_rx) = watch::channel(!local_enabled);
    let local_task = local_enabled.then(|| {
        let local_state = Arc::clone(&state);
        let local_run = Arc::clone(&run);
        let local_request = request.clone();
        tokio::spawn(async move {
            run_local_lane(local_state, local_request, local_run, ready_tx).await
        })
    });

    let local_future = async move {
        match local_task {
            Some(task) => task.await.unwrap_or_default(),
            None => SearchReport::default(),
        }
    };
    let server_state = Arc::clone(&state);
    let server_run = Arc::clone(&run);
    let server_request = request.clone();
    let server_future = async move {
        if server_request.location != SearchLocation::Local {
            run_server_lane(server_state, server_request, server_run, ready_rx).await
        } else {
            SearchReport::default()
        }
    };
    let (mut report, server_report) = tokio::join!(local_future, server_future);
    report.total_sources += server_report.total_sources;
    report.successful_sources += server_report.successful_sources;
    report.completed += server_report.completed;
    report.total += server_report.total;
    report.failures.extend(server_report.failures);

    let mut terminal = progress(&request.search_id);
    terminal.total = report.total;
    terminal.completed = report.completed;
    terminal.failures = report.failures;
    if run.is_cancelled() {
        terminal.terminal = Some(SearchTerminal::Cancelled);
    } else if report.total_sources > 0 && report.successful_sources == 0 {
        terminal.terminal = Some(SearchTerminal::Error);
        terminal.error_key = Some("search.allSourcesFailed".into());
    } else {
        terminal.terminal = Some(SearchTerminal::Complete);
    }
    emit_progress(&state, &run, terminal);
    drop(guard);
}

#[derive(Default)]
struct SearchReport {
    total_sources: usize,
    successful_sources: usize,
    completed: usize,
    total: usize,
    failures: Vec<SearchFailure>,
}

struct InitialSnapshot {
    selected_dirs: Vec<String>,
    on_disk_error: Option<String>,
    indexed_dirs_error: Option<String>,
    custody: Arc<HashMap<(String, u32), Value>>,
}

#[derive(Clone)]
struct LocalFolder {
    account_id: String,
    vault_dir: String,
    mailbox: String,
    local_only: bool,
    fallback_reason: Option<FallbackReason>,
    custody: Arc<HashMap<(String, u32), Value>>,
}

struct FolderOutcome {
    folder: LocalFolder,
    result: Result<Vec<Value>, String>,
}

struct LocalReadyOnDrop(Option<watch::Sender<bool>>);

impl Drop for LocalReadyOnDrop {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            sender.send_replace(true);
        }
    }
}

async fn run_local_lane(
    state: Arc<DaemonState>,
    request: MailSearchStart,
    run: Arc<SearchRun>,
    initial_local_published: watch::Sender<bool>,
) -> SearchReport {
    let mut ready = LocalReadyOnDrop(Some(initial_local_published));
    let mut report = SearchReport::default();
    let mut aggregate = SearchCoverage {
        complete: true,
        ..Default::default()
    };
    let mut has_coverage = false;
    let mut jobs = Vec::new();
    let mut indexed_shown = 0usize;
    let mut fallback_shown = 0usize;

    for target in &request.targets {
        if run.is_cancelled() {
            break;
        }
        let prior_failure_count = report.failures.len();
        if target.local_mailboxes.as_ref().is_some_and(Vec::is_empty) {
            continue;
        }
        let target = target.clone();
        let snapshot_state = Arc::clone(&state);
        let snapshot_run = Arc::clone(&run);
        let snapshot_account_id = target.account_id.clone();
        let explicit_mailboxes = target.local_mailboxes.clone();
        let needs_disk_dirs = target.local_mailboxes.is_none();
        let snapshot = tokio::task::spawn_blocking(move || -> Result<InitialSnapshot, String> {
            if snapshot_run.is_cancelled() {
                return Err("cancelled".into());
            }
            let _gate = snapshot_state
                .vault_gate
                .read()
                .unwrap_or_else(|p| p.into_inner());
            if snapshot_run.is_cancelled() {
                return Err("cancelled".into());
            }
            let root = vault_root(&snapshot_state)?;
            let custody = crate::custody::with_conn(&snapshot_state, |conn| {
                mailvault_core::custody::entries::entries_for_account(conn, &snapshot_account_id)
            })
            .map(custody_by_vault_uid)
            .unwrap_or_default();
            let (mut selected_dirs, on_disk_error) = if needs_disk_dirs {
                mailvault_core::search_index::reconcile::list_vault_dirs(&root.join("Maildir"))
                    .map(|dirs| {
                        let dirs = dirs
                            .into_iter()
                            .filter_map(|(account, dir)| {
                                (account == snapshot_account_id).then_some(dir)
                            })
                            .collect::<Vec<_>>();
                        (dirs, None)
                    })
                    .unwrap_or_else(|error| (Vec::new(), Some(error)))
            } else {
                (
                    unique_vault_dirs(explicit_mailboxes.as_deref().unwrap_or_default())
                        .into_iter()
                        .collect(),
                    None,
                )
            };
            let (indexed_dirs, indexed_dirs_error) = if needs_disk_dirs
                && *crate::search_index::g(&snapshot_state.search_index.enabled) != Some(false)
            {
                match list_indexed_dirs(&snapshot_state.search_index, &snapshot_account_id) {
                    Ok(dirs) => (dirs, None),
                    Err(error) => (HashSet::new(), Some(error)),
                }
            } else {
                (HashSet::new(), None)
            };
            selected_dirs.extend(indexed_dirs);
            selected_dirs.sort_unstable();
            selected_dirs.dedup();
            Ok(InitialSnapshot {
                selected_dirs,
                on_disk_error,
                indexed_dirs_error,
                custody: Arc::new(custody),
            })
        })
        .await
        .unwrap_or_else(|error| Err(format!("search setup failed: {error}")));

        if run.is_cancelled() {
            break;
        }
        let snapshot = match snapshot {
            Ok(snapshot) => snapshot,
            Err(error) if error == "cancelled" => break,
            Err(error) => {
                let count = target
                    .local_mailboxes
                    .as_ref()
                    .map(|mailboxes| unique_vault_dirs(mailboxes).len())
                    .unwrap_or(1);
                report.total_sources += count;
                report.total += count;
                report.completed += count;
                report
                    .failures
                    .push(failure(&target.account_id, "", "vault"));
                let mut frame = progress(&request.search_id);
                frame.lane = Some(SearchLane::Local);
                frame.local_mode = Some(LocalMode::Scan);
                frame.fallback_reason = Some(index_fallback_reason(&state, None));
                frame.total = report.total;
                frame.completed = report.completed;
                frame.failures = vec![report.failures.last().unwrap().clone()];
                frame.coverage = has_coverage.then(|| aggregate.clone());
                emit_progress(&state, &run, frame);
                tracing::debug!(
                    "local search setup failed for {}: {error}",
                    target.account_id
                );
                continue;
            }
        };

        if let Some(error) = snapshot.on_disk_error.as_ref() {
            report.total_sources += 1;
            report.total += 1;
            report.completed += 1;
            report
                .failures
                .push(failure(&target.account_id, "", "vault"));
            aggregate.complete = false;
            tracing::debug!(
                "could not enumerate local folders for {}: {error}",
                target.account_id
            );
        }
        if let Some(error) = snapshot.indexed_dirs_error.as_ref() {
            crate::search_index::request_search_recovery(&state.search_index);
            report.total_sources += 1;
            report.total += 1;
            report.completed += 1;
            report
                .failures
                .push(failure(&target.account_id, "", "index"));
            aggregate.complete = false;
            tracing::debug!(
                "could not enumerate indexed folders for {}: {error}",
                target.account_id
            );
        }

        let batches = snapshot
            .selected_dirs
            .chunks(request.effective_concurrency())
            .map(|chunk| chunk.to_vec())
            .collect::<Vec<_>>();
        report.total_sources += batches.len();
        report.total += batches.len();
        let indexed_shown_before_account = indexed_shown;
        let mut merged_hits: Vec<SearchHit> = Vec::new();
        let mut matched = 0u64;
        let mut fallback_dirs = snapshot
            .indexed_dirs_error
            .as_ref()
            .map_or_else(HashSet::new, |_| {
                snapshot.selected_dirs.iter().cloned().collect()
            });
        report.total += fallback_dirs.len();
        report.total_sources += fallback_dirs.len();
        let mut fallback_reason = snapshot
            .indexed_dirs_error
            .as_ref()
            .map(|_| index_fallback_reason(&state, None))
            .or_else(|| {
                snapshot
                    .on_disk_error
                    .as_ref()
                    .map(|_| FallbackReason::Unavailable)
            });
        let mut account_has_index = false;
        let mut index_failed =
            snapshot.on_disk_error.is_some() || snapshot.indexed_dirs_error.is_some();

        for batch in &batches {
            if run.is_cancelled() {
                break;
            }
            let mut query = request_to_index(&request, &target);
            query.mailboxes = Some(batch.clone());
            let batch_state = Arc::clone(&state);
            let batch_run = Arc::clone(&run);
            let query_result = tokio::task::spawn_blocking(move || {
                if batch_run.is_cancelled() {
                    return None;
                }
                let _gate = batch_state
                    .vault_gate
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
                if batch_run.is_cancelled() {
                    return None;
                }
                let result =
                    crate::search_index::search_page_reply(&batch_state.search_index, &query);
                if batch_run.is_cancelled() {
                    None
                } else {
                    Some(result)
                }
            })
            .await
            .unwrap_or_else(|error| Some(Err(format!("index search task failed: {error}"))));

            if run.is_cancelled() || query_result.is_none() {
                break;
            }
            report.completed += 1;
            let batch_failure_count = report.failures.len();
            let mut frame = progress(&request.search_id);
            frame.lane = Some(SearchLane::Local);
            frame.total = report.total;
            frame.completed = report.completed;

            match query_result.unwrap() {
                Ok(Ok(result)) => {
                    let coverage_complete = result.coverage.complete;
                    account_has_index = true;
                    has_coverage = true;
                    aggregate.indexed += result.coverage.indexed;
                    aggregate.total += result.coverage.total;
                    aggregate.matched += result.page.total;
                    aggregate.complete &= result.coverage.complete;
                    matched += result.page.total;
                    let fallback_count_before = fallback_dirs.len();
                    fallback_dirs.extend(result.coverage.uncovered_vault_dirs.iter().cloned());
                    let new_fallback_dirs = fallback_dirs.len() - fallback_count_before;
                    report.total += new_fallback_dirs;
                    report.total_sources += new_fallback_dirs;
                    if !result.coverage.uncovered_vault_dirs.is_empty() {
                        fallback_reason = Some(FallbackReason::Building);
                    }
                    merged_hits.extend(result.page.hits);
                    merged_hits.sort_by(|a, b| (b.date_utc, b.row_id).cmp(&(a.date_utc, a.row_id)));
                    merged_hits.truncate(core_search::query::DEFAULT_LIMIT);
                    indexed_shown = indexed_shown_before_account + merged_hits.len();
                    aggregate.shown = indexed_shown + fallback_shown;

                    let mut rows = crate::search_index::assemble_rows(&SearchPage {
                        hits: merged_hits.clone(),
                        total: matched,
                        needles: result.page.needles,
                    });
                    for row in &mut rows {
                        let vault_dir = row
                            .get("vaultDir")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        stamp_local_row(
                            row,
                            &target.account_id,
                            &vault_dir,
                            &target.known_mailboxes,
                            false,
                            &snapshot.custody,
                        );
                    }
                    frame.rows = rows;
                    frame.local_mode = Some(LocalMode::Index);
                    frame.replace_index_account_id = Some(target.account_id.clone());
                    if coverage_complete || !frame.rows.is_empty() {
                        report.successful_sources += 1;
                    }
                }
                Ok(Err(reason)) => {
                    index_failed = true;
                    aggregate.complete = false;
                    let fallback_count_before = fallback_dirs.len();
                    fallback_dirs.extend(batch.iter().cloned());
                    let new_fallback_dirs = fallback_dirs.len() - fallback_count_before;
                    report.total += new_fallback_dirs;
                    report.total_sources += new_fallback_dirs;
                    fallback_reason = Some(index_fallback_reason(&state, Some(reason)));
                    frame.local_mode = Some(LocalMode::Scan);
                }
                Err(error) => {
                    index_failed = true;
                    aggregate.complete = false;
                    let fallback_count_before = fallback_dirs.len();
                    fallback_dirs.extend(batch.iter().cloned());
                    let new_fallback_dirs = fallback_dirs.len() - fallback_count_before;
                    report.total += new_fallback_dirs;
                    report.total_sources += new_fallback_dirs;
                    fallback_reason = Some(index_fallback_reason(&state, None));
                    report
                        .failures
                        .push(failure(&target.account_id, "", "index"));
                    frame.local_mode = Some(LocalMode::Scan);
                    tracing::debug!(
                        "indexed local search failed for {}: {error}",
                        target.account_id
                    );
                }
            }

            if index_failed {
                aggregate.complete = false;
            }
            frame.total = report.total;
            frame.fallback_reason = fallback_reason;
            frame.coverage = has_coverage.then(|| aggregate.clone());
            frame.failures = report.failures[batch_failure_count..].to_vec();
            emit_progress(&state, &run, frame);
        }

        if run.is_cancelled() {
            break;
        }

        if index_failed || !fallback_dirs.is_empty() || snapshot.on_disk_error.is_some() {
            aggregate.complete = false;
        }
        if fallback_reason.is_none() && !fallback_dirs.is_empty() {
            fallback_reason = Some(FallbackReason::Building);
        }
        if !account_has_index && !batches.is_empty() && fallback_reason.is_none() {
            fallback_reason = Some(index_fallback_reason(&state, None));
        }

        let mut ordered_fallback_dirs = fallback_dirs.into_iter().collect::<Vec<_>>();
        ordered_fallback_dirs.sort_unstable();
        for dir in ordered_fallback_dirs {
            let (mailbox, local_only, _) = mailbox_for_vault_dir(&dir, &target.known_mailboxes);
            jobs.push(LocalFolder {
                account_id: target.account_id.clone(),
                vault_dir: dir,
                mailbox,
                local_only,
                fallback_reason,
                custody: Arc::clone(&snapshot.custody),
            });
        }

        if (!batches.is_empty() && !account_has_index)
            || snapshot.on_disk_error.is_some()
            || snapshot.indexed_dirs_error.is_some()
        {
            let mut frame = progress(&request.search_id);
            frame.lane = Some(SearchLane::Local);
            frame.local_mode = Some(LocalMode::Scan);
            frame.fallback_reason = fallback_reason;
            frame.coverage = has_coverage.then(|| aggregate.clone());
            frame.total = report.total;
            frame.completed = report.completed;
            frame.failures = report.failures[prior_failure_count..].to_vec();
            emit_progress(&state, &run, frame);
        }

        if !snapshot.selected_dirs.is_empty() && !account_has_index {
            aggregate.complete = false;
        }
        aggregate.shown = indexed_shown + fallback_shown;
    }

    // Server search can start while index requests are running, but it waits
    // for every account's initial indexed/unavailable frame before publishing.
    if let Some(sender) = ready.0.take() {
        sender.send_replace(true);
    }
    if run.is_cancelled() {
        return report;
    }

    let mut jobs_stream = run_bounded_jobs(jobs, request.effective_concurrency(), {
        let state = Arc::clone(&state);
        let run = Arc::clone(&run);
        let request = request.clone();
        move |folder| {
            let state = Arc::clone(&state);
            let run = Arc::clone(&run);
            let request = request.clone();
            async move {
                if run.is_cancelled() {
                    return None;
                }
                let folder_for_blocking = folder.clone();
                let state_for_blocking = Arc::clone(&state);
                let run_for_blocking = Arc::clone(&run);
                let result = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
                    if run_for_blocking.is_cancelled() {
                        return Err("cancelled".into());
                    }
                    let _gate = state_for_blocking
                        .vault_gate
                        .read()
                        .unwrap_or_else(|p| p.into_inner());
                    if run_for_blocking.is_cancelled() {
                        return Err("cancelled".into());
                    }
                    let root = vault_root(&state_for_blocking)?;
                    let summaries = vault_files::list_on_disk(
                        &root,
                        &folder_for_blocking.account_id,
                        &folder_for_blocking.mailbox,
                        None,
                    )?;
                    let uids = summaries
                        .iter()
                        .map(|summary| summary.uid)
                        .collect::<Vec<_>>();
                    let emails = vault_files::read_light_batch_on_disk(
                        &root,
                        &folder_for_blocking.account_id,
                        &folder_for_blocking.mailbox,
                        &uids,
                    );
                    let mut rows = Vec::new();
                    for email in emails.into_iter().flatten() {
                        if matches_local_row(&email, &request) {
                            let mut row = serde_json::to_value(email).map_err(|e| e.to_string())?;
                            stamp_local_row(
                                &mut row,
                                &folder_for_blocking.account_id,
                                &folder_for_blocking.vault_dir,
                                &request
                                    .targets
                                    .iter()
                                    .find(|t| t.account_id == folder_for_blocking.account_id)
                                    .map(|t| t.known_mailboxes.as_slice())
                                    .unwrap_or(&[]),
                                folder_for_blocking.local_only,
                                &folder_for_blocking.custody,
                            );
                            rows.push(row);
                        }
                    }
                    Ok(rows)
                })
                .await
                .map_err(|error| format!("local folder task failed: {error}"))
                .and_then(|result| result);
                Some(FolderOutcome { folder, result })
            }
        }
    });

    while let Some(outcome) = next_active_job(&mut jobs_stream, &run).await {
        let Some(outcome) = outcome else { continue };
        report.completed += 1;
        let mut frame = progress(&request.search_id);
        frame.lane = Some(SearchLane::Local);
        frame.local_mode = Some(LocalMode::Scan);
        frame.fallback_reason = outcome.folder.fallback_reason;
        frame.completed = report.completed;
        frame.total = report.total;
        frame.coverage = has_coverage.then(|| aggregate.clone());
        match outcome.result {
            Ok(rows) => {
                report.successful_sources += 1;
                frame.rows = rows;
                fallback_shown += frame.rows.len();
            }
            Err(error) if error == "cancelled" => return report,
            Err(error) => {
                let code = if error.starts_with("E_VAULT_UNAVAILABLE:") {
                    "vault"
                } else {
                    "mailbox"
                };
                let failure = failure(&outcome.folder.account_id, &outcome.folder.mailbox, code);
                report.failures.push(failure.clone());
                frame.failures.push(failure);
            }
        }
        if let Some(coverage) = frame.coverage.as_mut() {
            coverage.shown = indexed_shown + fallback_shown;
        }
        if !run.is_cancelled() {
            emit_progress(&state, &run, frame);
        }
    }
    report
}

#[derive(Clone)]
struct ServerMailboxJob {
    account_id: String,
    account: mailvault_core::imap::ImapConfig,
    mailbox: String,
}

struct ServerMailboxOutcome {
    job: ServerMailboxJob,
    result: Result<Vec<Value>, String>,
}

async fn run_server_lane(
    state: Arc<DaemonState>,
    request: MailSearchStart,
    run: Arc<SearchRun>,
    mut initial_local_published: watch::Receiver<bool>,
) -> SearchReport {
    let jobs = request
        .targets
        .iter()
        .filter_map(|target| {
            let account = target.account.as_ref()?;
            (!target.server_mailboxes.is_empty()).then_some((target, account))
        })
        .flat_map(|(target, account)| {
            target
                .server_mailboxes
                .iter()
                .map(|mailbox| ServerMailboxJob {
                    account_id: target.account_id.clone(),
                    account: account.clone(),
                    mailbox: mailbox.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut report = SearchReport {
        total_sources: jobs.len(),
        total: jobs.len(),
        ..Default::default()
    };
    if jobs.is_empty() {
        return report;
    }

    let filters = crate::handlers::imap::SearchFilters::for_mail_search(
        request.sender.clone(),
        request.date_from,
        request.date_to,
    );
    let has_attachments = request.has_attachments;
    let search_id = request.search_id.clone();
    let query = request.query.clone();
    let mut jobs = run_bounded_jobs(jobs, request.effective_concurrency(), {
        let state = Arc::clone(&state);
        let run = Arc::clone(&run);
        let request_query = query;
        move |job| {
            let state = Arc::clone(&state);
            let run = Arc::clone(&run);
            let query = request_query.clone();
            let filters = filters.clone();
            async move {
                if run.is_cancelled() {
                    return None;
                }
                let account_id = job.account_id.clone();
                let result = state
                    .imap_pool
                    .run_read(&job.account, false, |mut session| {
                        let account_id = account_id.clone();
                        let mailbox = job.mailbox.clone();
                        let query = query.clone();
                        let filters = filters.clone();
                        async move {
                            let (emails, _) = mailvault_core::imap::search_emails(
                                &mut session,
                                &mailbox,
                                nonempty(&query),
                                filters.from.as_deref(),
                                None,
                                filters.since.as_deref(),
                                filters.before.as_deref(),
                            )
                            .await
                            .map_err(|error| format!("Failed to search emails: {error}"))?;
                            let mut rows = Vec::new();
                            for email in emails {
                                if has_attachments && !email.has_attachments {
                                    continue;
                                }
                                let mut row = serde_json::to_value(email)
                                    .map_err(|error| error.to_string())?;
                                if let Some(object) = row.as_object_mut() {
                                    object.insert("_accountId".into(), account_id.clone().into());
                                    object.insert("_mailbox".into(), mailbox.clone().into());
                                    object.insert("isLocal".into(), false.into());
                                    object.insert("source".into(), "server-search".into());
                                }
                                rows.push(row);
                            }
                            Ok((rows, session, Some(mailbox)))
                        }
                    })
                    .await;
                Some(ServerMailboxOutcome { job, result })
            }
        }
    });

    let mut first_publication = true;
    while let Some(outcome) = next_active_job(&mut jobs, &run).await {
        let Some(outcome) = outcome else { continue };
        report.completed += 1;
        let mut frame = progress(&search_id);
        frame.lane = Some(SearchLane::Server);
        frame.completed = report.completed;
        frame.total = report.total;
        match outcome.result {
            Ok(rows) => {
                report.successful_sources += 1;
                frame.rows = rows;
            }
            Err(error) => {
                let failure = server_failure(&outcome.job.account_id, &outcome.job.mailbox, &error);
                report.failures.push(failure.clone());
                frame.failures.push(failure);
            }
        }

        if run.is_cancelled() {
            break;
        }
        if first_publication {
            while !*initial_local_published.borrow() {
                if initial_local_published.changed().await.is_err() {
                    break;
                }
            }
            first_publication = false;
        }
        if !run.is_cancelled() {
            emit_progress(&state, &run, frame);
        }
    }
    report
}

fn nonempty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn server_failure(account_id: &str, mailbox: &str, error: &str) -> SearchFailure {
    let lowered = error.to_ascii_lowercase();
    let code = if [
        "authentication",
        "login failed",
        "invalid credentials",
        "password missing",
        "oauth2",
        "xoauth2",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
    {
        "credentials"
    } else if mailvault_core::imap::pool::is_retryable_connect_error(error)
        || ["failed to connect", "connection refused", "timed out"]
            .iter()
            .any(|needle| lowered.contains(needle))
    {
        "connection"
    } else {
        "mailbox"
    };
    SearchFailure {
        account_id: account_id.to_owned(),
        mailbox: mailbox.to_owned(),
        lane: SearchLane::Server,
        code: code.to_owned(),
    }
}

fn request_to_index(request: &MailSearchStart, target: &MailSearchTarget) -> SearchRequest {
    SearchRequest {
        account_id: target.account_id.clone(),
        query: request.query.clone(),
        mailboxes: target.local_mailboxes.clone(),
        sender: request.sender.clone(),
        date_from: request.date_from,
        date_to: request.date_to,
        has_attachments: request.has_attachments,
        limit: None,
        // Saved-view filters: a plain search sets none of them.
        ..SearchRequest::default()
    }
}

fn list_indexed_dirs(
    state: &crate::search_index::SearchIndexState,
    account_id: &str,
) -> Result<HashSet<String>, String> {
    let guard = core_search::lock(&state.db);
    let connection = guard
        .as_ref()
        .ok_or_else(|| "search index unavailable".to_string())?;
    let mut statement = connection
        .prepare("SELECT vault_dir FROM mailbox_scan WHERE account_id = ?1 UNION SELECT vault_dir FROM messages WHERE account_id = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn custody_by_vault_uid(rows: Vec<(String, Value)>) -> HashMap<(String, u32), Value> {
    let mut custody = HashMap::new();
    let mut ambiguous = HashSet::new();
    for (mailbox, entry) in rows {
        let Some(uid) = entry
            .get("uid")
            .and_then(Value::as_u64)
            .and_then(|uid| u32::try_from(uid).ok())
        else {
            continue;
        };
        let key = (core_search::text::vault_dir_name(&mailbox), uid);
        if ambiguous.contains(&key) {
            continue;
        }
        if custody.remove(&key).is_some() {
            ambiguous.insert(key);
        } else {
            custody.insert(key, entry);
        }
    }
    custody
}

fn unique_vault_dirs(mailboxes: &[String]) -> HashSet<String> {
    mailboxes
        .iter()
        .map(|mailbox| core_search::text::vault_dir_name(mailbox))
        .collect()
}

pub(crate) fn mailbox_for_vault_dir(vault_dir: &str, known_mailboxes: &[String]) -> (String, bool, bool) {
    let mut matches = known_mailboxes
        .iter()
        .filter(|mailbox| core_search::text::vault_dir_name(mailbox) == vault_dir);
    match (matches.next(), matches.next()) {
        (Some(mailbox), None) => (mailbox.clone(), false, false),
        (Some(_), Some(_)) => (vault_dir.to_owned(), true, true),
        _ => (vault_dir.to_owned(), true, false),
    }
}

pub(crate) fn stamp_local_row(
    row: &mut Value,
    account_id: &str,
    vault_dir: &str,
    known_mailboxes: &[String],
    already_local_only: bool,
    custody: &HashMap<(String, u32), Value>,
) {
    let (mailbox, local_only_folder, ambiguous) = mailbox_for_vault_dir(vault_dir, known_mailboxes);
    let local_only = already_local_only || local_only_folder;
    if let Some(object) = row.as_object_mut() {
        object.insert("_accountId".into(), account_id.into());
        object.insert(
            "_mailbox".into(),
            if local_only {
                vault_dir.into()
            } else {
                mailbox.into()
            },
        );
        object.insert("vaultDir".into(), vault_dir.into());
        object.insert("isLocal".into(), true.into());
        object.insert("source".into(), "local".into());
        if local_only {
            object.insert("_localOnlyFolder".into(), true.into());
        }
        if !ambiguous {
            let uid = object
                .get("uid")
                .and_then(Value::as_u64)
                .and_then(|uid| u32::try_from(uid).ok());
            if let Some(entry) = uid.and_then(|uid| custody.get(&(vault_dir.to_owned(), uid))) {
                if let Some(origin) = entry.get("source") {
                    object.insert("_origin".into(), origin.clone());
                }
                for field in ["serverDeleted", "serverAbsent"] {
                    if let Some(value) = entry.get(field) {
                        object.insert(field.into(), value.clone());
                    }
                }
                let origin = object.get("_origin").and_then(Value::as_str);
                let has_proof = object.get("_localStaged").and_then(Value::as_bool) == Some(true)
                    || matches!(origin, Some("local_sent" | "local_draft"))
                    || object.get("serverDeleted").and_then(Value::as_bool) == Some(true)
                    || object.get("serverAbsent").and_then(Value::as_bool) == Some(true);
                if object.get("isArchived").and_then(Value::as_bool) == Some(true) && has_proof {
                    object.insert("source".into(), "local-only".into());
                }
            }
        }
    }
}

fn failure(account_id: &str, mailbox: &str, code: &str) -> SearchFailure {
    SearchFailure {
        account_id: account_id.to_owned(),
        mailbox: mailbox.to_owned(),
        lane: SearchLane::Local,
        code: code.to_owned(),
    }
}

pub(crate) fn matches_local_row(row: &LightEmail, request: &MailSearchStart) -> bool {
    let query = request.query.trim().to_lowercase();
    let haystack = [
        row.subject.as_str(),
        row.from.address.as_str(),
        row.from.name.as_deref().unwrap_or(""),
        row.text.as_deref().unwrap_or(""),
        row.html.as_deref().unwrap_or(""),
    ]
    .join(" ")
    .to_lowercase();
    (query.is_empty() || haystack.contains(&query))
        && request.sender.as_deref().is_none_or(|sender| {
            let sender = sender.to_lowercase();
            row.from.address.to_lowercase().contains(&sender)
                || row
                    .from
                    .name
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&sender)
        })
        && (!request.has_attachments || row.has_attachments)
        && date_inclusive(row.date.as_deref(), request.date_from, request.date_to)
}

fn date_inclusive(value: Option<&str>, from: Option<i64>, to: Option<i64>) -> bool {
    let Some(raw) = value else {
        return from.is_none() && to.is_none();
    };
    let stamp = chrono::DateTime::parse_from_rfc3339(raw)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(raw))
        .map(|date| date.timestamp());
    match stamp {
        Ok(stamp) => from.is_none_or(|low| stamp >= low) && to.is_none_or(|high| stamp <= high),
        Err(_) => from.is_none() && to.is_none(),
    }
}

fn run_bounded_jobs<T, F, Fut, R>(jobs: Vec<T>, concurrency: usize, f: F) -> impl Stream<Item = R>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = R>,
{
    stream::iter(jobs)
        .map(f)
        .buffer_unordered(concurrency.clamp(1, 5))
}

async fn next_active_job<S>(jobs: &mut S, run: &SearchRun) -> Option<S::Item>
where
    S: Stream + Unpin,
{
    if run.is_cancelled() {
        None
    } else {
        jobs.next().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc;
    use crate::server::{handle_request_for_test, DaemonState};
    use chrono::TimeZone;
    use mailvault_core::maildir::INFO_PREFIX;
    use mailvault_core::search_index::{self as core_search, db};
    use mailvault_core::vault_eml::{LightAttachment, LightEmail, MaildirAddress};
    use serde_json::{json, Value};
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn state() -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true);
        (tmp, state)
    }

    fn target(account_id: &str, local_mailboxes: Option<Vec<&str>>) -> Value {
        json!({
            "accountId": account_id,
            "account": null,
            "localMailboxes": local_mailboxes,
            "knownMailboxes": ["INBOX", "Archive"],
            "serverMailboxes": []
        })
    }

    fn request(search_id: &str, concurrency: usize) -> Value {
        request_with_targets(
            search_id,
            concurrency,
            vec![target("acct", Some(vec!["INBOX"]))],
        )
    }

    fn request_with_targets(search_id: &str, concurrency: usize, targets: Vec<Value>) -> Value {
        json!({
            "searchId": search_id,
            "query": "",
            "location": "local",
            "concurrency": concurrency,
            "targets": targets
        })
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> ipc::RpcResponse {
        handle_request_for_test(state, method, params).await
    }

    async fn next_progress(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let line = rx.recv().await.unwrap();
                if let Some((name, payload)) = mailvault_core::daemon_ipc::parse_event(&line) {
                    if name == "mail-search-progress" {
                        return payload;
                    }
                }
            }
        })
        .await
        .expect("timed out waiting for search progress")
    }

    async fn collect_until_terminal(
        rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>,
        search_id: &str,
    ) -> Vec<Value> {
        let mut frames = Vec::new();
        loop {
            let frame = next_progress(rx).await;
            if frame["searchId"] == search_id {
                let terminal = !frame["terminal"].is_null();
                frames.push(frame);
                if terminal {
                    return frames;
                }
            }
        }
    }

    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("condition did not become true");
    }

    fn write_mail(root: &Path, account: &str, mailbox: &str, uid: u32, subject: &str, body: &str) {
        let safe = core_search::text::vault_dir_name(mailbox);
        let cur = root.join("Maildir").join(account).join(safe).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(
            cur.join(format!("{uid}{INFO_PREFIX}.eml")),
            format!(
                "From: Sender <sender@example.test>\r\nTo: Me <me@example.test>\r\nSubject: {subject}\r\nDate: Tue, 15 Nov 1994 12:45:26 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
            ),
        )
        .unwrap();
    }

    fn enable_index(
        state: &Arc<DaemonState>,
        rows: &[(&str, u32, &str, &str)],
        scans: &[(&str, i64)],
    ) {
        let conn = db::open(&state.data_dir).unwrap();
        db::meta_set(&conn, db::FIRST_PASS_DONE, "1").unwrap();
        for (mailbox, count) in scans {
            conn.execute(
                "INSERT INTO mailbox_scan (account_id, vault_dir, scanned_at, file_count) VALUES ('acct', ?1, 1, ?2)",
                rusqlite::params![mailbox, count],
            )
            .unwrap();
        }
        for (mailbox, uid, subject, row_json) in rows {
            let row = serde_json::from_str::<Value>(row_json).unwrap_or_default();
            let date_utc = row["date"]
                .as_str()
                .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
                .map(|date| date.timestamp())
                .unwrap_or(1);
            let filename = if serde_json::from_str::<Value>(row_json)
                .ok()
                .and_then(|row| row["isArchived"].as_bool())
                .unwrap_or(false)
            {
                format!("{uid}{INFO_PREFIX}A.eml")
            } else {
                format!("{uid}{INFO_PREFIX}.eml")
            };
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc, from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json) VALUES ('acct', ?1, ?2, ?3, 1, 1, NULL, ?4, 'sender@example.test', 'sender', ?5, '', 0, 1, ?6)",
                rusqlite::params![mailbox, uid, filename, date_utc, subject.to_lowercase(), row_json],
            )
            .unwrap();
            let row_id = conn.last_insert_rowid();
            let indexed_subject = row["subject"].as_str().unwrap_or(subject);
            conn.execute(
                "INSERT INTO msg_fts (rowid, subject, addrs, body, attach) VALUES (?1, ?2, 'sender@example.test', '', '')",
                rusqlite::params![row_id, indexed_subject],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO msg_cjk (rowid, subject, addrs, body, attach) VALUES (?1, ?2, '', '', '')",
                rusqlite::params![row_id, core_search::text::cjk_units(indexed_subject)],
            )
            .unwrap();
        }
        *state.search_index.db.lock().unwrap() = Some(conn);
        *state.search_index.enabled.lock().unwrap() = Some(true);
    }

    fn indexed_row(subject: &str) -> String {
        json!({
            "uid": 1,
            "messageId": "<indexed@example.test>",
            "subject": subject,
            "from": {"name":"Sender", "address":"sender@example.test"},
            "to": [], "cc": [], "bcc": [], "replyTo": [],
            "date": "1994-11-15T12:45:26Z",
            "attachments": [], "hasAttachments": false,
            "isArchived": false
        })
        .to_string()
    }

    #[tokio::test]
    async fn duplicate_id_is_rejected_and_cancel_is_named() {
        let (tmp, state) = state();
        write_mail(tmp.path(), "acct", "INBOX", 1, "slow local folder", "body");
        let gate = state.vault_gate.write().unwrap();
        let mut rx = state.events.subscribe();

        let start = call(&state, "mail_search_start", request("same", 3)).await;
        assert_eq!(start.result.unwrap()["started"], true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let duplicate = call(&state, "mail_search_start", request("same", 3)).await;
        assert_eq!(duplicate.error.unwrap().code, ipc::INVALID_PARAMS);

        let cancelled = call(&state, "mail_search_cancel", json!({"searchId":"same"})).await;
        assert_eq!(
            cancelled.result.unwrap(),
            json!({"success":true,"found":true})
        );
        drop(gate);
        wait_until(|| state.search_runs.lock().unwrap().is_empty()).await;

        let frames = collect_until_terminal(&mut rx, "same").await;
        assert_eq!(frames.last().unwrap()["terminal"], "cancelled");
        assert!(frames
            .iter()
            .all(|frame| frame["rows"].as_array().unwrap().is_empty()));
    }

    #[tokio::test]
    async fn empty_targets_emit_terminal_complete() {
        let (_tmp, state) = state();
        let mut rx = state.events.subscribe();
        let start = call(
            &state,
            "mail_search_start",
            request_with_targets("empty", 3, vec![]),
        )
        .await;
        assert_eq!(start.result.unwrap()["started"], true);
        let event = next_progress(&mut rx).await;
        assert_eq!(event["searchId"], "empty");
        assert_eq!(event["terminal"], "complete");
        wait_until(|| state.search_runs.lock().unwrap().is_empty()).await;
    }

    #[tokio::test]
    async fn account_id_cannot_escape_the_maildir_account_directory() {
        let (_tmp, state) = state();
        let response = call(
            &state,
            "mail_search_start",
            request_with_targets(
                "unsafe-account",
                1,
                vec![target("../outside", Some(vec!["INBOX"]))],
            ),
        )
        .await;
        assert_eq!(response.error.unwrap().code, ipc::INVALID_PARAMS);
        assert!(state.search_runs.lock().unwrap().is_empty());
    }

    #[test]
    fn finishing_old_guard_cannot_remove_a_new_run_with_the_same_id() {
        let (_tmp, state) = state();
        let first = Arc::new(SearchRun::default());
        state
            .search_runs
            .lock()
            .unwrap()
            .insert("same".into(), Arc::clone(&first));
        let old_guard = SearchRunGuard {
            state: Arc::clone(&state),
            search_id: "same".into(),
            run: first,
        };

        state.search_runs.lock().unwrap().remove("same");
        let newer = Arc::new(SearchRun::default());
        state
            .search_runs
            .lock()
            .unwrap()
            .insert("same".into(), Arc::clone(&newer));
        drop(old_guard);

        assert!(Arc::ptr_eq(
            state.search_runs.lock().unwrap().get("same").unwrap(),
            &newer
        ));
    }

    #[test]
    fn daemon_concurrency_defaults_and_clamps_to_one_through_five() {
        let parse = |value: Value| {
            serde_json::from_value::<MailSearchStart>(value)
                .unwrap()
                .effective_concurrency()
        };
        let targets = vec![target("acct", Some(vec!["INBOX"]))];
        assert_eq!(parse(request_with_targets("zero", 0, targets.clone())), 1);
        assert_eq!(parse(request_with_targets("high", 6, targets.clone())), 5);
        let mut omitted = request_with_targets("omitted", 3, targets);
        omitted.as_object_mut().unwrap().remove("concurrency");
        assert_eq!(parse(omitted), 1);
    }

    #[tokio::test]
    async fn local_index_is_published_before_fallback_only_scans_uncovered_folders() {
        let (tmp, state) = state();
        write_mail(tmp.path(), "acct", "INBOX", 1, "disk version", "disk body");
        write_mail(
            tmp.path(),
            "acct",
            "Archive",
            2,
            "archive only",
            "archive body",
        );
        enable_index(
            &state,
            &[(
                "INBOX",
                1,
                "already indexed",
                &indexed_row("already indexed"),
            )],
            &[("INBOX", 1)],
        );
        let mut rx = state.events.subscribe();
        let mut req = request("indexed", 2);
        req["targets"] = json!([target("acct", None)]);
        req["targets"][0]["knownMailboxes"] = json!(["INBOX", "Archive"]);

        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "indexed").await;
        assert_eq!(frames[0]["lane"], "local");
        assert_eq!(frames[0]["localMode"], "index");
        assert_eq!(frames[0]["fallbackReason"], "building");
        assert_eq!(frames[0]["rows"][0]["subject"], "already indexed");
        let fallback = frames
            .iter()
            .find(|frame| frame["localMode"] == "scan")
            .unwrap();
        assert_eq!(fallback["fallbackReason"], "building");
        let subjects = frames
            .iter()
            .flat_map(|frame| frame["rows"].as_array().unwrap())
            .filter_map(|row| row["subject"].as_str())
            .collect::<Vec<_>>();
        assert!(subjects.contains(&"archive only"));
        assert!(
            !subjects.contains(&"disk version"),
            "a complete indexed folder must not be MIME-parsed again: {subjects:?}"
        );
        let sequences = frames
            .iter()
            .map(|frame| frame["sequence"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert!(
            sequences.windows(2).all(|pair| pair[0] < pair[1]),
            "progress sequence must be increasing: {sequences:?}"
        );
    }

    #[tokio::test]
    async fn indexed_sql_search_publishes_cumulative_mailbox_batches_with_the_configured_limit() {
        let (_tmp, state) = state();
        let folders = (0..7).map(|n| format!("Folder{n}")).collect::<Vec<_>>();
        let owned_rows = folders.iter().enumerate().map(|(n, folder)| (
            folder.clone(), n as u32 + 1, "batch row".to_string(),
            json!({"uid": n + 1, "subject": format!("batch row {n}"), "messageId": format!("<batch-{n}@x.test>"), "date": format!("2026-09-{:02}T00:00:00Z", n + 1)}).to_string(),
        )).collect::<Vec<_>>();
        let rows = owned_rows
            .iter()
            .map(|(folder, uid, subject, row)| {
                (folder.as_str(), *uid, subject.as_str(), row.as_str())
            })
            .collect::<Vec<_>>();
        let scans = folders
            .iter()
            .map(|folder| (folder.as_str(), 1))
            .collect::<Vec<_>>();
        enable_index(&state, &rows, &scans);
        let mut rx = state.events.subscribe();
        let req = request_with_targets(
            "mailbox-batches",
            3,
            vec![target(
                "acct",
                Some(folders.iter().map(String::as_str).collect()),
            )],
        );

        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "mailbox-batches").await;
        let indexed = frames
            .iter()
            .filter(|frame| frame["replaceIndexAccountId"] == "acct")
            .collect::<Vec<_>>();
        assert_eq!(indexed.len(), 3, "7 selected directories at concurrency 3 should query three disjoint scopes: {frames:?}");
        let sizes = indexed
            .iter()
            .map(|frame| frame["rows"].as_array().unwrap().len())
            .collect::<Vec<_>>();
        assert_eq!(
            sizes,
            vec![3, 6, 7],
            "each indexed frame replaces with the cumulative, sorted account snapshot"
        );
        let unique = indexed.last().unwrap()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["uid"].as_u64().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(
            unique.len(),
            7,
            "every selected folder contributes exactly once"
        );
        assert_eq!(indexed.last().unwrap()["coverage"]["matched"], 7);
    }

    #[tokio::test]
    async fn configured_sql_batches_use_unique_bounded_directory_scopes_for_limits_one_three_and_five(
    ) {
        for limit in [1, 3, 5] {
            let (_tmp, state) = state();
            let mailboxes = vec![
                "Nested/Archive",
                "Nested_Archive",
                "Folder1",
                "Folder2",
                "Folder3",
                "Folder4",
                "Folder5",
            ];
            let vault_dirs = [
                "Nested_Archive",
                "Folder1",
                "Folder2",
                "Folder3",
                "Folder4",
                "Folder5",
            ];
            let owned_rows = vault_dirs.iter().enumerate().map(|(i, folder)| (
                folder.to_string(), i as u32 + 1, "".to_string(),
                json!({"uid": i + 1, "subject": format!("hit {i}"), "messageId": format!("<hit-{i}@x.test>"), "date": format!("2026-09-{:02}T00:00:00Z", i + 1)}).to_string(),
            )).collect::<Vec<_>>();
            let rows = owned_rows
                .iter()
                .map(|(folder, uid, subject, row)| {
                    (folder.as_str(), *uid, subject.as_str(), row.as_str())
                })
                .collect::<Vec<_>>();
            let scans = vault_dirs
                .iter()
                .map(|folder| (*folder, 1))
                .collect::<Vec<_>>();
            enable_index(&state, &rows, &scans);
            let mut rx = state.events.subscribe();
            let target = json!({"accountId":"acct", "account":null, "localMailboxes":mailboxes, "knownMailboxes":mailboxes, "serverMailboxes":[]});
            assert_eq!(
                call(
                    &state,
                    "mail_search_start",
                    request_with_targets(&format!("limit-{limit}"), limit, vec![target])
                )
                .await
                .result
                .unwrap()["started"],
                true
            );
            let frames = collect_until_terminal(&mut rx, &format!("limit-{limit}")).await;
            let scopes = state.search_index.search_scopes.lock().unwrap().clone();
            assert!(
                !scopes.iter().any(Option::is_none),
                "no account-wide SQL escaped batching: {scopes:?}"
            );
            assert!(
                scopes
                    .iter()
                    .flatten()
                    .all(|scope| !scope.is_empty() && scope.len() <= limit),
                "scope limit {limit}: {scopes:?}"
            );
            let flattened = scopes.into_iter().flatten().flatten().collect::<Vec<_>>();
            assert_eq!(
                flattened.len(),
                6,
                "the two aliases should produce one database scope"
            );
            assert_eq!(
                flattened.iter().collect::<HashSet<_>>().len(),
                6,
                "each unique directory must be searched once"
            );
            let last_indexed = frames
                .iter()
                .rev()
                .find(|frame| frame["replaceIndexAccountId"] == "acct")
                .expect("indexed batch should publish coverage");
            assert_eq!(last_indexed["coverage"]["matched"], 6);
        }
    }

    #[tokio::test]
    async fn an_explicitly_empty_mailbox_list_never_becomes_an_all_mailboxes_query() {
        let (_tmp, state) = state();
        enable_index(&state, &[], &[]);
        let mut rx = state.events.subscribe();
        assert_eq!(
            call(
                &state,
                "mail_search_start",
                request_with_targets("empty-local", 5, vec![target("acct", Some(vec![]))])
            )
            .await
            .result
            .unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "empty-local").await;
        assert!(state.search_index.search_scopes.lock().unwrap().is_empty());
        assert!(frames
            .iter()
            .all(|frame| frame["rows"].as_array().unwrap().is_empty()));
    }

    #[tokio::test]
    async fn all_folder_search_unions_disk_only_and_index_only_directories() {
        let (tmp, state) = state();
        write_mail(
            tmp.path(),
            "acct",
            "DiskOnly",
            2,
            "disk only hit",
            "disk body",
        );
        enable_index(
            &state,
            &[(
                "IndexOnly",
                1,
                "indexed only hit",
                &indexed_row("indexed only hit"),
            )],
            &[("IndexOnly", 1)],
        );
        let mut rx = state.events.subscribe();
        let req = request_with_targets("all-union", 1, vec![target("acct", None)]);
        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "all-union").await;

        let scopes = state.search_index.search_scopes.lock().unwrap().clone();
        let flattened = scopes
            .into_iter()
            .flatten()
            .flatten()
            .collect::<HashSet<_>>();
        assert_eq!(
            flattened,
            HashSet::from(["DiskOnly".to_string(), "IndexOnly".to_string()])
        );
        let subjects = frames
            .iter()
            .flat_map(|frame| frame["rows"].as_array().unwrap())
            .filter_map(|row| row["subject"].as_str().map(str::to_owned))
            .collect::<HashSet<_>>();
        assert!(subjects.contains("disk only hit"));
        assert!(subjects.contains("indexed only hit"));
    }

    fn make_unreadable_mailbox(root: &Path, mailbox: &str) {
        let cur = root.join("Maildir").join("acct").join(mailbox).join("cur");
        std::fs::create_dir_all(cur.parent().unwrap()).unwrap();
        std::fs::write(cur, "not a directory").unwrap();
    }

    #[tokio::test]
    async fn disk_only_folder_scan_failure_is_error_without_a_usable_index_result() {
        let (tmp, state) = state();
        make_unreadable_mailbox(tmp.path(), "Broken");
        enable_index(&state, &[], &[]);
        let mut rx = state.events.subscribe();
        let mut req = request_with_targets(
            "failed-disk-only",
            1,
            vec![target("acct", Some(vec!["Broken"]))],
        );
        req["query"] = json!("no matching message");
        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "failed-disk-only").await;
        let terminal = frames.last().unwrap();
        assert_eq!(terminal["terminal"], "error");
        assert_eq!(terminal["errorKey"], "search.allSourcesFailed");
        assert!(terminal["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["code"] == "mailbox"));
    }

    #[tokio::test]
    async fn partial_index_hit_is_retained_when_an_uncovered_folder_scan_fails() {
        let (tmp, state) = state();
        make_unreadable_mailbox(tmp.path(), "Broken");
        let row = indexed_row("needle partial result");
        enable_index(
            &state,
            &[("Indexed", 1, "needle partial result", &row)],
            &[("Indexed", 1)],
        );
        let mut rx = state.events.subscribe();
        let mut req = request_with_targets(
            "partial-index-before-failure",
            1,
            vec![target("acct", Some(vec!["Broken", "Indexed"]))],
        );
        req["query"] = json!("needle");
        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "partial-index-before-failure").await;
        let terminal = frames.last().unwrap();
        assert_eq!(terminal["terminal"], "complete");
        assert!(frames
            .iter()
            .flat_map(|frame| frame["rows"].as_array().unwrap())
            .any(|row| row["subject"] == "needle partial result"));
        assert!(terminal["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["code"] == "mailbox"));
    }

    #[tokio::test]
    async fn fallback_coverage_shown_includes_prior_successes_on_a_later_failure() {
        let (tmp, state) = state();
        for uid in 1..=10 {
            write_mail(tmp.path(), "acct", "A", uid, "fallback row", "body");
        }
        make_unreadable_mailbox(tmp.path(), "Z");
        let row = indexed_row("indexed row");
        enable_index(
            &state,
            &[("Indexed", 1, "indexed row", &row)],
            &[("Indexed", 1)],
        );
        let mut rx = state.events.subscribe();
        let req = request_with_targets(
            "fallback-shown",
            1,
            vec![target("acct", Some(vec!["Indexed", "A", "Z"]))],
        );
        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "fallback-shown").await;
        let successful_fallback = frames
            .iter()
            .find(|frame| {
                frame["localMode"] == "scan"
                    && frame["rows"]
                        .as_array()
                        .is_some_and(|rows| rows.len() == 10)
            })
            .unwrap();
        let failed_fallback = frames
            .iter()
            .find(|frame| {
                frame["localMode"] == "scan"
                    && frame["failures"]
                        .as_array()
                        .is_some_and(|failures| !failures.is_empty())
            })
            .unwrap();
        assert_eq!(successful_fallback["coverage"]["shown"], 11);
        assert_eq!(failed_fallback["coverage"]["shown"], 11);
    }

    #[tokio::test]
    async fn batched_merge_keeps_exact_newest_500_and_row_id_tie_order() {
        let (_tmp, state) = state();
        let mut owned_rows = Vec::new();
        for uid in 1..=501u32 {
            let date = chrono::Utc
                .timestamp_opt(1_700_000_000 + i64::from(uid) * 1_000, 0)
                .single()
                .unwrap()
                .to_rfc3339();
            owned_rows.push(("A".to_string(), uid, "".to_string(), json!({"uid":uid,"subject":format!("会議 filter A {uid}"),"messageId":format!("<a-{uid}@x.test>"),"date":date}).to_string()));
        }
        for uid in 502..=511u32 {
            let date = chrono::Utc
                .timestamp_opt(1_800_000_000, 0)
                .single()
                .unwrap()
                .to_rfc3339();
            owned_rows.push(("B".to_string(), uid, "".to_string(), json!({"uid":uid,"subject":format!("会議 filter B {uid}"),"messageId":format!("<b-{uid}@x.test>"),"date":date}).to_string()));
        }
        let rows = owned_rows
            .iter()
            .map(|(folder, uid, subject, row)| {
                (folder.as_str(), *uid, subject.as_str(), row.as_str())
            })
            .collect::<Vec<_>>();
        enable_index(&state, &rows, &[("A", 501), ("B", 10)]);
        let mut rx = state.events.subscribe();
        let mut req =
            request_with_targets("top-500", 1, vec![target("acct", Some(vec!["A", "B"]))]);
        req["query"] = json!("会議");
        req["sender"] = json!("sender@example.test");
        req["dateFrom"] = json!(1_700_000_000);
        req["dateTo"] = json!(1_800_000_000);
        assert_eq!(
            call(&state, "mail_search_start", req.clone())
                .await
                .result
                .unwrap()["started"],
            true
        );
        let frames = collect_until_terminal(&mut rx, "top-500").await;
        let indexed = frames
            .iter()
            .filter(|frame| frame["replaceIndexAccountId"] == "acct")
            .collect::<Vec<_>>();
        assert_eq!(indexed.len(), 2);
        assert_eq!(indexed[0]["rows"].as_array().unwrap().len(), 500);
        assert_eq!(indexed[1]["rows"].as_array().unwrap().len(), 500);
        assert_eq!(indexed[1]["coverage"]["matched"], 511);
        let rows = indexed[1]["rows"].as_array().unwrap();
        assert_eq!(
            rows.iter().filter(|row| row["vaultDir"] == "B").count(),
            10,
            "the later scope contains the newest row IDs at the equal-date boundary"
        );
        let top_b = rows
            .iter()
            .take(10)
            .map(|row| row["uid"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(top_b, (502u64..=511).rev().collect::<Vec<_>>());

        let parsed = serde_json::from_value::<MailSearchStart>(req.clone()).unwrap();
        let query = request_to_index(&parsed, &parsed.targets[0]);
        let (unbatched_page, unbatched_coverage, unbatched_rows) = {
            let guard = core_search::lock(&state.search_index.db);
            let conn = guard.as_ref().unwrap();
            let page = core_search::query::search(conn, &query).unwrap();
            let coverage =
                core_search::db::scope_coverage(conn, "acct", query.mailboxes.as_deref()).unwrap();
            let rows = crate::search_index::assemble_rows(&page);
            (page, coverage, rows)
        };
        let copy_key = |row: &Value| {
            (
                row["vaultDir"].as_str().unwrap().to_owned(),
                row["uid"].as_u64().unwrap(),
            )
        };
        assert_eq!(
            rows.iter().map(copy_key).collect::<Vec<_>>(),
            unbatched_rows.iter().map(copy_key).collect::<Vec<_>>(),
            "the exact final 500 copies and their order must match one unbatched SQL query"
        );
        assert_eq!(
            indexed[1]["coverage"]["indexed"],
            unbatched_coverage.indexed
        );
        assert_eq!(indexed[1]["coverage"]["total"], unbatched_coverage.total);
        assert_eq!(
            indexed[1]["coverage"]["complete"],
            unbatched_coverage.complete
        );
        assert_eq!(indexed[1]["coverage"]["matched"], unbatched_page.total);
        assert_eq!(indexed[1]["coverage"]["shown"], unbatched_page.hits.len());

        req["searchId"] = json!("top-500-zero-match");
        req["query"] = json!("不存在");
        let mut rx = state.events.subscribe();
        assert_eq!(
            call(&state, "mail_search_start", req.clone())
                .await
                .result
                .unwrap()["started"],
            true
        );
        let zero_frames = collect_until_terminal(&mut rx, "top-500-zero-match").await;
        let zero_indexed = zero_frames
            .iter()
            .filter(|frame| frame["replaceIndexAccountId"] == "acct")
            .last()
            .unwrap();
        let parsed_zero = serde_json::from_value::<MailSearchStart>(req).unwrap();
        let query_zero = request_to_index(&parsed_zero, &parsed_zero.targets[0]);
        let guard = core_search::lock(&state.search_index.db);
        let conn = guard.as_ref().unwrap();
        let unbatched_zero = core_search::query::search(conn, &query_zero).unwrap();
        let zero_coverage =
            core_search::db::scope_coverage(conn, "acct", query_zero.mailboxes.as_deref()).unwrap();
        assert_eq!(unbatched_zero.total, 0);
        assert!(unbatched_zero.hits.is_empty());
        assert_eq!(zero_indexed["rows"].as_array().unwrap().len(), 0);
        assert_eq!(zero_indexed["coverage"]["indexed"], zero_coverage.indexed);
        assert_eq!(zero_indexed["coverage"]["total"], zero_coverage.total);
        assert_eq!(zero_indexed["coverage"]["complete"], zero_coverage.complete);
        assert_eq!(zero_indexed["coverage"]["matched"], unbatched_zero.total);
        assert_eq!(zero_indexed["coverage"]["shown"], 0);
    }

    #[tokio::test]
    async fn cancelling_after_first_sql_batch_skips_later_batches_and_publication() {
        use std::sync::Mutex as StdMutex;
        let (_tmp, state) = state();
        let owned_rows = (0..7).map(|n| (
            format!("Folder{n}"), n as u32 + 1, "".to_string(),
            json!({"uid":n+1,"subject":format!("row {n}"),"messageId":format!("<row-{n}@x.test>"),"date":"2026-09-20T00:00:00Z"}).to_string(),
        )).collect::<Vec<_>>();
        let rows = owned_rows
            .iter()
            .map(|(folder, uid, subject, row)| {
                (folder.as_str(), *uid, subject.as_str(), row.as_str())
            })
            .collect::<Vec<_>>();
        let scans = owned_rows
            .iter()
            .map(|(folder, ..)| (folder.as_str(), 1))
            .collect::<Vec<_>>();
        enable_index(&state, &rows, &scans);
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let release_rx = Arc::new(StdMutex::new(release_rx));
        *state.search_index.search_batch_hook.lock().unwrap() = Some(Arc::new(move || {
            let _ = entered_tx.send(());
            let _ = release_rx.lock().unwrap().recv();
        }));
        let mut rx = state.events.subscribe();
        let mailboxes = owned_rows
            .iter()
            .map(|(folder, ..)| folder.as_str())
            .collect::<Vec<_>>();
        let req = request_with_targets("cancel-batch", 1, vec![target("acct", Some(mailboxes))]);
        assert_eq!(
            call(&state, "mail_search_start", req).await.result.unwrap()["started"],
            true
        );
        tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
            .await
            .unwrap();
        let cancelled_result = call(
            &state,
            "mail_search_cancel",
            json!({"searchId":"cancel-batch"}),
        )
        .await
        .result;
        let released = release_tx.send(());
        let frames = collect_until_terminal(&mut rx, "cancel-batch").await;
        let scopes = state.search_index.search_scopes.lock().unwrap().clone();
        assert_eq!(
            cancelled_result.unwrap(),
            json!({"success": true, "found": true})
        );
        assert!(
            released.is_ok(),
            "the blocked SQL hook must always be released"
        );
        assert_eq!(scopes.len(), 1, "the worker must observe cancellation before scheduling the next mailbox scope: {scopes:?}");
        assert!(
            frames
                .iter()
                .all(|frame| frame["replaceIndexAccountId"].is_null()),
            "no indexed result may publish after cancellation acknowledgement: {frames:?}"
        );
    }

    #[tokio::test]
    #[ignore = "coordinator first indexed publication benchmark"]
    async fn first_index_publication_latency_at_one_and_five_mailbox_batches() {
        for concurrency in [1, 5] {
            let (_tmp, state) = state();
            let folders = (0..50)
                .map(|n| format!("Mailbox{n:02}"))
                .collect::<Vec<_>>();
            let owned_rows = folders.iter().flat_map(|folder| (1..=20).map(move |uid| (
                folder.clone(), uid, "".to_string(),
                json!({"uid":uid,"subject":format!("{folder} {uid}"),"messageId":format!("<{folder}-{uid}@x.test>"),"date":"2026-09-20T00:00:00Z"}).to_string(),
            ))).collect::<Vec<_>>();
            let rows = owned_rows
                .iter()
                .map(|(folder, uid, subject, row)| {
                    (folder.as_str(), *uid, subject.as_str(), row.as_str())
                })
                .collect::<Vec<_>>();
            let scans = folders
                .iter()
                .map(|folder| (folder.as_str(), 20))
                .collect::<Vec<_>>();
            enable_index(&state, &rows, &scans);
            let mailboxes = folders.iter().map(String::as_str).collect::<Vec<_>>();
            let mut rx = state.events.subscribe();
            let started = std::time::Instant::now();
            assert_eq!(
                call(
                    &state,
                    "mail_search_start",
                    request_with_targets(
                        &format!("coordinator-{concurrency}"),
                        concurrency,
                        vec![target("acct", Some(mailboxes))],
                    )
                )
                .await
                .result
                .unwrap()["started"],
                true
            );
            loop {
                let frame = next_progress(&mut rx).await;
                if frame["searchId"] == format!("coordinator-{concurrency}")
                    && frame["replaceIndexAccountId"] == "acct"
                {
                    eprintln!(
                        "first indexed publication at concurrency {concurrency}: {:?}",
                        started.elapsed()
                    );
                    break;
                }
            }
            let _ = call(
                &state,
                "mail_search_cancel",
                json!({"searchId":format!("coordinator-{concurrency}")}),
            )
            .await;
            let _ = collect_until_terminal(&mut rx, &format!("coordinator-{concurrency}")).await;
        }
    }

    #[tokio::test]
    async fn indexed_local_rows_keep_custody_proof() {
        let (_tmp, state) = state();
        let mut row = serde_json::from_str::<Value>(&indexed_row("proven local copy")).unwrap();
        row["uid"] = json!(7);
        row["isArchived"] = json!(true);
        enable_index(
            &state,
            &[("INBOX", 7, "proven local copy", &row.to_string())],
            &[("INBOX", 1)],
        );
        crate::custody::open_into(&state).unwrap();
        crate::custody::with_conn(&state, |conn| {
            mailvault_core::custody::entries::upsert(
                conn,
                "acct",
                "INBOX",
                &[json!({"uid":7,"source":"local","serverDeleted":true,"serverAbsent":false})],
            )
            .map(|_| ())
        })
        .unwrap();

        let mut rx = state.events.subscribe();
        let frames = {
            call(&state, "mail_search_start", request("custody", 1)).await;
            collect_until_terminal(&mut rx, "custody").await
        };
        let hit = frames
            .iter()
            .flat_map(|frame| frame["rows"].as_array().unwrap())
            .find(|row| row["subject"] == "proven local copy")
            .unwrap();
        assert_eq!(hit["_origin"], "local");
        assert_eq!(hit["serverDeleted"], true);
        assert_eq!(hit["serverAbsent"], false);
        assert_eq!(hit["source"], "local-only");
    }

    #[test]
    fn custody_proof_maps_unique_vault_only_dirs_but_not_colliding_dirs() {
        let known = vec!["INBOX".to_owned()];
        let unique = custody_by_vault_uid(vec![(
            "VaultOnly".into(),
            json!({"uid":7,"source":"local","serverDeleted":true}),
        )]);
        let mut vault_only = json!({"uid":7,"isArchived":true});
        stamp_local_row(&mut vault_only, "acct", "VaultOnly", &known, true, &unique);
        assert_eq!(vault_only["source"], "local-only");
        assert_eq!(vault_only["serverDeleted"], true);

        let colliding_mailboxes = vec!["Projects/2026".to_owned(), "Projects_2026".to_owned()];
        let collision = custody_by_vault_uid(vec![
            (
                "Projects/2026".into(),
                json!({"uid":7,"source":"local","serverDeleted":true}),
            ),
            (
                "Projects_2026".into(),
                json!({"uid":7,"source":"local","serverAbsent":true}),
            ),
        ]);
        let mut ambiguous = json!({"uid":7,"isArchived":true});
        stamp_local_row(
            &mut ambiguous,
            "acct",
            "Projects_2026",
            &colliding_mailboxes,
            false,
            &collision,
        );
        assert_eq!(ambiguous["source"], "local");
        assert!(ambiguous.get("serverDeleted").is_none());
        assert!(ambiguous.get("serverAbsent").is_none());
    }

    #[tokio::test]
    async fn index_off_building_and_unavailable_each_report_the_fallback_reason() {
        for reason in ["off", "building", "unavailable"] {
            let (tmp, state) = state();
            write_mail(tmp.path(), "acct", "INBOX", 1, "fallback row", "body");
            match reason {
                "off" => *state.search_index.enabled.lock().unwrap() = Some(false),
                "building" => {
                    let conn = db::open(&state.data_dir).unwrap();
                    *state.search_index.db.lock().unwrap() = Some(conn);
                    *state.search_index.enabled.lock().unwrap() = Some(true);
                }
                _ => {}
            }
            let mut rx = state.events.subscribe();
            let frames = {
                call(&state, "mail_search_start", request(reason, 1)).await;
                collect_until_terminal(&mut rx, reason).await
            };
            let scan = frames
                .iter()
                .find(|frame| frame["localMode"] == "scan")
                .unwrap();
            assert_eq!(scan["fallbackReason"], reason);
            assert_eq!(frames.last().unwrap()["terminal"], "complete");
        }
    }

    #[tokio::test]
    async fn fallback_scheduler_honors_one_and_three_folder_limits() {
        async fn peak_at(limit: usize) -> usize {
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let current = Arc::clone(&active);
            let maximum = Arc::clone(&peak);
            let mut jobs = run_bounded_jobs((0..8usize).collect(), limit, move |_| {
                let current = Arc::clone(&current);
                let maximum = Arc::clone(&maximum);
                async move {
                    let count = current.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(count, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    current.fetch_sub(1, Ordering::SeqCst);
                }
            });
            while jobs.next().await.is_some() {}
            peak.load(Ordering::SeqCst)
        }
        assert_eq!(peak_at(1).await, 1);
        assert_eq!(peak_at(3).await, 3);
    }

    #[tokio::test]
    async fn cancelled_fallback_does_not_poll_or_schedule_the_next_folder() {
        let run = Arc::new(SearchRun::default());
        let started = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let worker_run = Arc::clone(&run);
        let worker_started = Arc::clone(&started);
        let worker_release = Arc::clone(&release);
        let mut jobs = run_bounded_jobs(vec![0, 1, 2], 1, move |folder| {
            let started = Arc::clone(&worker_started);
            let release = Arc::clone(&worker_release);
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                if folder == 0 {
                    release.notified().await;
                }
                folder
            }
        });
        let driver = tokio::spawn(async move {
            let mut completed = Vec::new();
            while let Some(folder) = next_active_job(&mut jobs, &worker_run).await {
                completed.push(folder);
            }
            completed
        });
        wait_until(|| started.load(Ordering::SeqCst) == 1).await;
        run.cancelled.store(true, Ordering::SeqCst);
        release.notify_one();
        assert_eq!(driver.await.unwrap(), vec![0]);
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_while_one_folder_is_gated_prevents_scheduling_later_folders() {
        let (tmp, state) = state();
        for (uid, mailbox) in [(1, "INBOX"), (2, "Archive"), (3, "Sent")] {
            write_mail(tmp.path(), "acct", mailbox, uid, "fallback row", "body");
        }
        let gate = state.vault_gate.write().unwrap();
        let mut rx = state.events.subscribe();
        let req = request_with_targets("cancel-schedule", 1, vec![target("acct", None)]);
        call(&state, "mail_search_start", req).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        call(
            &state,
            "mail_search_cancel",
            json!({"searchId":"cancel-schedule"}),
        )
        .await;
        drop(gate);

        let frames = collect_until_terminal(&mut rx, "cancel-schedule").await;
        assert_eq!(frames.last().unwrap()["terminal"], "cancelled");
        assert!(frames
            .iter()
            .all(|frame| frame["rows"].as_array().unwrap().is_empty()));
        assert!(state.search_runs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn vault_close_after_registration_reports_local_failure_and_terminal_error() {
        let (tmp, state) = state();
        write_mail(tmp.path(), "acct", "INBOX", 1, "unavailable", "body");
        let gate = state.vault_gate.write().unwrap();
        let mut rx = state.events.subscribe();
        call(&state, "mail_search_start", request("closed", 1)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        state.vault_closed.store(true, Ordering::SeqCst);
        drop(gate);

        let frames = collect_until_terminal(&mut rx, "closed").await;
        assert_eq!(frames.last().unwrap()["terminal"], "error");
        assert_eq!(
            frames.last().unwrap()["errorKey"],
            "search.allSourcesFailed"
        );
        assert_eq!(frames.last().unwrap()["failures"][0]["code"], "vault");
    }

    #[tokio::test]
    async fn vault_only_and_ambiguous_paths_are_marked_local_only() {
        for known in [
            vec!["INBOX", "Archive"],
            vec!["Projects/2026", "Projects_2026"],
        ] {
            let (tmp, state) = state();
            let mailbox = if known.len() == 2 && known[0] == "INBOX" {
                "VaultOnly"
            } else {
                "Projects_2026"
            };
            write_mail(tmp.path(), "acct", mailbox, 1, "local only", "body");
            let mut req = request("local-only", 1);
            req["targets"][0]["localMailboxes"] = Value::Null;
            req["targets"][0]["knownMailboxes"] = json!(known);
            let mut rx = state.events.subscribe();
            call(&state, "mail_search_start", req).await;
            let frames = collect_until_terminal(&mut rx, "local-only").await;
            let row = frames
                .iter()
                .flat_map(|frame| frame["rows"].as_array().unwrap())
                .find(|row| row["subject"] == "local only")
                .unwrap();
            assert_eq!(row["_localOnlyFolder"], true);
            assert_eq!(row["_mailbox"], mailbox);
            assert_eq!(row["vaultDir"], mailbox);
        }
    }

    #[test]
    fn local_filters_match_query_sender_attachments_and_inclusive_dates() {
        let row = LightEmail {
            uid: 1,
            message_id: None,
            subject: "Quarterly report".into(),
            from: MaildirAddress {
                name: Some("Alice Example".into()),
                address: "alice@example.test".into(),
            },
            to: vec![],
            cc: vec![],
            bcc: vec![],
            reply_to: vec![],
            date: Some("2026-09-01T00:00:00Z".into()),
            flags: vec![],
            text: Some("revenue update".into()),
            html: None,
            attachments: vec![LightAttachment {
                filename: Some("report.pdf".into()),
                content_type: "application/pdf".into(),
                content_disposition: Some("attachment".into()),
                size: 50,
                content_id: None,
            }],
            has_attachments: true,
            is_archived: false,
        };
        let req: MailSearchStart = serde_json::from_value(json!({
            "searchId":"filters", "location":"local", "query":"revenue", "sender":"ALICE",
            "hasAttachments":true, "dateFrom":1788220800, "dateTo":1788220800,
            "targets":[]
        }))
        .unwrap();
        assert!(matches_local_row(&row, &req));
        let wrong_sender = MailSearchStart {
            sender: Some("bob".into()),
            ..req.clone()
        };
        assert!(!matches_local_row(&row, &wrong_sender));
    }

    mod server {
        use super::*;
        use mock_imap::state::synthetic_mailbox;
        use mock_imap::{Action, MockImap, Scenario, Trigger};

        fn plaintext() {
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        }

        fn account(server: &MockImap) -> Value {
            json!({
                "email": "user@example.test",
                "password": "test-password",
                "imapHost": server.host(),
                "imapPort": server.port(),
                "imapSecure": false
            })
        }

        fn server_target(server: &MockImap, mailboxes: &[String]) -> Value {
            json!({
                "accountId": "acct",
                "account": account(server),
                "localMailboxes": [],
                "knownMailboxes": mailboxes,
                "serverMailboxes": mailboxes
            })
        }

        async fn run(
            state: &Arc<DaemonState>,
            rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>,
            search_id: &str,
            server: &MockImap,
            mailboxes: &[String],
            concurrency: usize,
            location: &str,
        ) -> Vec<Value> {
            let started = call(
                state,
                "mail_search_start",
                json!({
                    "searchId": search_id,
                    "query": "Message",
                    "location": location,
                    "concurrency": concurrency,
                    "targets": [server_target(server, mailboxes)]
                }),
            )
            .await;
            assert_eq!(started.result.unwrap()["started"], true);
            collect_until_terminal(rx, search_id).await
        }

        fn mailbox_names(prefix: &str, count: usize) -> Vec<String> {
            (0..count).map(|i| format!("{prefix}{i}")).collect()
        }

        fn scenario_for(mailboxes: &[String]) -> Scenario {
            mailboxes.iter().fold(Scenario::new(), |scenario, mailbox| {
                scenario.mailbox(synthetic_mailbox(mailbox, 2))
            })
        }

        #[test]
        fn server_filter_conversion_keeps_the_end_date_inclusive() {
            let from = chrono::DateTime::parse_from_rfc3339("2026-09-01T14:00:00Z")
                .unwrap()
                .timestamp();
            let to = chrono::DateTime::parse_from_rfc3339("2026-09-03T18:00:00Z")
                .unwrap()
                .timestamp();
            let filters = crate::handlers::imap::SearchFilters::for_mail_search(
                Some("alice@example.test".into()),
                Some(from),
                Some(to),
            );
            assert_eq!(filters.from.as_deref(), Some("alice@example.test"));
            assert_eq!(filters.since.as_deref(), Some("2026-09-01"));
            assert_eq!(filters.before.as_deref(), Some("2026-09-04"));
        }

        #[test]
        fn server_failures_use_stable_public_codes() {
            let cases = [
                ("TCP connect failed: connection refused", "connection"),
                (
                    "Login failed: NO [AUTHENTICATIONFAILED] Invalid credentials",
                    "credentials",
                ),
                ("SELECT Archive failed: NO [NONEXISTENT]", "mailbox"),
            ];
            for (error, code) in cases {
                let failure = server_failure("acct", "Archive", error);
                assert_eq!(serde_json::to_value(failure.lane).unwrap(), json!("server"));
                assert_eq!(failure.code, code);
            }
        }

        #[tokio::test]
        async fn server_lane_keeps_successes_after_retry_and_folder_failure() {
            plaintext();
            let mailboxes = vec!["RetryBox".to_string(), "INBOX".to_string()];
            let server = MockImap::start(
                scenario_for(&mailboxes).fault(Trigger::nth("SELECT", 1), Action::DropConnection),
            );
            let (_tmp, state) = state();
            let mut rx = state.events.subscribe();
            let frames = run(
                &state,
                &mut rx,
                "server-partial",
                &server,
                &["RetryBox".into(), "Missing".into(), "INBOX".into()],
                3,
                "server",
            )
            .await;

            let rows = frames
                .iter()
                .flat_map(|frame| frame["rows"].as_array().into_iter().flatten())
                .collect::<Vec<_>>();
            assert_eq!(
                rows.len(),
                4,
                "both valid folders should keep their rows: {rows:?}; frames: {frames:?}; commands: {:?}",
                server.commands()
            );
            assert!(rows.iter().all(|row| row["_accountId"] == "acct"));
            assert!(rows.iter().any(|row| row["_mailbox"] == "RetryBox"));
            assert!(rows.iter().any(|row| row["_mailbox"] == "INBOX"));

            let terminal = frames.last().unwrap();
            assert_eq!(terminal["terminal"], "complete");
            assert_eq!(terminal["failures"].as_array().unwrap().len(), 1);
            assert_eq!(terminal["failures"][0]["mailbox"], "Missing");
            assert_eq!(terminal["failures"][0]["lane"], "server");
            assert_eq!(terminal["failures"][0]["code"], "mailbox");
            assert!(
                server.connection_count() >= 2,
                "the dead socket should be replaced"
            );
        }

        #[tokio::test]
        async fn server_lane_honors_one_three_and_five_connection_limits() {
            plaintext();
            for concurrency in [1, 3, 5] {
                let names = mailbox_names(&format!("Box{concurrency}_"), 6);
                let server = MockImap::start(scenario_for(&names).fault(
                    Trigger::on("SEARCH"),
                    Action::Delay(Duration::from_millis(80)),
                ));
                let (_tmp, state) = state();
                let mut rx = state.events.subscribe();
                let frames = run(
                    &state,
                    &mut rx,
                    &format!("server-limit-{concurrency}"),
                    &server,
                    &names,
                    concurrency,
                    "server",
                )
                .await;

                assert_eq!(frames.last().unwrap()["terminal"], "complete");
                assert_eq!(server.count_commands("SEARCH"), names.len());
                assert_eq!(
                    server.connection_count(),
                    concurrency,
                    "the server lane should reach the requested limit {concurrency}"
                );
            }
        }

        #[tokio::test]
        async fn first_server_publication_waits_for_the_initial_local_frame() {
            plaintext();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let (tmp, state) = state();
            write_mail(tmp.path(), "acct", "INBOX", 1, "local result", "local body");
            let mut rx = state.events.subscribe();
            let gate = state.vault_gate.write().unwrap();
            let started = call(
                &state,
                "mail_search_start",
                json!({
                    "searchId": "server-after-local",
                    "query": "Message",
                    "location": "all",
                    "concurrency": 1,
                    "targets": [{
                        "accountId": "acct",
                        "account": account(&server),
                        "localMailboxes": ["INBOX"],
                        "knownMailboxes": ["INBOX"],
                        "serverMailboxes": ["INBOX"]
                    }]
                }),
            )
            .await;
            assert_eq!(started.result.unwrap()["started"], true);
            wait_until(|| server.count_commands("SEARCH") > 0).await;
            drop(gate);

            let frames = collect_until_terminal(&mut rx, "server-after-local").await;
            assert_eq!(frames[0]["lane"], "local");
            assert!(frames.iter().any(|frame| frame["lane"] == "server"));
        }
    }
}
