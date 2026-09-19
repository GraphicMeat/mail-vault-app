use crate::handlers::common::vault_root;
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use futures::{stream, Stream, StreamExt};
use mailvault_core::search_index::{self as core_search, query::SearchRequest};
use mailvault_core::vault_eml::LightEmail;
use mailvault_core::vault_files;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
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
}

impl FallbackReason {
    fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("off") => Self::Off,
            Some("building") => Self::Building,
            _ => Self::Unavailable,
        }
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
    let mut report = LocalReport::default();
    if !request.targets.is_empty() && request.location != SearchLocation::Server {
        let (ready_tx, mut ready_rx) = watch::channel(false);
        let local_state = Arc::clone(&state);
        let local_run = Arc::clone(&run);
        let local_request = request.clone();
        let local = tokio::spawn(async move {
            run_local_lane(local_state, local_request, local_run, ready_tx).await
        });
        if let Ok(local_report) = local.await {
            report = local_report;
        }
        if !*ready_rx.borrow() {
            let _ = ready_rx.changed().await;
        }
    }

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
struct LocalReport {
    total_sources: usize,
    successful_sources: usize,
    completed: usize,
    total: usize,
    failures: Vec<SearchFailure>,
}

struct InitialSnapshot {
    reply: Result<Value, String>,
    on_disk_dirs: Result<Option<Vec<String>>, String>,
    indexed_dirs: HashSet<String>,
}

#[derive(Clone)]
struct LocalFolder {
    account_id: String,
    vault_dir: String,
    mailbox: String,
    local_only: bool,
    fallback_reason: Option<FallbackReason>,
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
) -> LocalReport {
    let mut ready = LocalReadyOnDrop(Some(initial_local_published));
    let mut report = LocalReport::default();
    let mut aggregate = SearchCoverage {
        complete: true,
        ..Default::default()
    };
    let mut has_coverage = false;
    let mut jobs = Vec::new();

    for target in &request.targets {
        if run.is_cancelled() {
            break;
        }
        let prior_failure_count = report.failures.len();
        let explicitly_empty = target.local_mailboxes.as_ref().is_some_and(Vec::is_empty);
        if explicitly_empty {
            continue;
        }
        let target = target.clone();
        let query = request_to_index(&request, &target);
        let snapshot_state = Arc::clone(&state);
        let snapshot_run = Arc::clone(&run);
        let snapshot_account_id = target.account_id.clone();
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
            let reply = crate::search_index::search_reply(&snapshot_state.search_index, &query);
            let on_disk_dirs = if needs_disk_dirs {
                mailvault_core::search_index::reconcile::list_vault_dirs(&root.join("Maildir")).map(
                    |dirs| {
                        Some(
                            dirs.into_iter()
                                .filter_map(|(account, dir)| {
                                    (account == snapshot_account_id).then_some(dir)
                                })
                                .collect(),
                        )
                    },
                )
            } else {
                Ok(None)
            };
            let indexed_dirs = if reply
                .as_ref()
                .ok()
                .is_some_and(|value| value["available"] == true)
            {
                list_indexed_dirs(&snapshot_state.search_index, &snapshot_account_id)
                    .unwrap_or_default()
            } else {
                HashSet::new()
            };
            Ok(InitialSnapshot {
                reply,
                on_disk_dirs,
                indexed_dirs,
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
                report
                    .failures
                    .push(failure(&target.account_id, "", "vault"));
                let mut frame = progress(&request.search_id);
                frame.lane = Some(SearchLane::Local);
                frame.local_mode = Some(LocalMode::Scan);
                frame.fallback_reason = Some(FallbackReason::Unavailable);
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

        let reply = snapshot.reply.unwrap_or_else(
            |error| json!({"available":false,"reason":"unavailable","error":error}),
        );
        let available = reply["available"] == true;
        let fallback_reason =
            (!available).then(|| FallbackReason::from_wire(reply["reason"].as_str()));
        let indexed_rows = reply["rows"].as_array().cloned().unwrap_or_default();
        let mut rows = indexed_rows;
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
            );
        }

        let index_coverage = reply["coverage"].clone();
        let uncovered: HashSet<String> = reply["uncoveredVaultDirs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let selected_dirs = match (&target.local_mailboxes, snapshot.on_disk_dirs) {
            (Some(mailboxes), _) => unique_vault_dirs(mailboxes),
            (None, Ok(Some(dirs))) => dirs.into_iter().collect::<HashSet<_>>(),
            (None, Err(error)) => {
                report.total_sources += 1;
                report
                    .failures
                    .push(failure(&target.account_id, "", "vault"));
                tracing::debug!(
                    "could not enumerate local folders for {}: {error}",
                    target.account_id
                );
                HashSet::new()
            }
            (None, Ok(None)) => HashSet::new(),
        };
        let mut fallback_dirs = if available {
            uncovered.clone()
        } else {
            selected_dirs.clone()
        };
        if target.local_mailboxes.is_none() && available {
            fallback_dirs.extend(selected_dirs.difference(&snapshot.indexed_dirs).cloned());
        }
        if !selected_dirs.is_empty() || !fallback_dirs.is_empty() {
            report.total_sources += selected_dirs.union(&uncovered).count().max(1);
        }
        if available {
            let complete_dirs = selected_dirs.difference(&fallback_dirs).count();
            report.successful_sources += complete_dirs;
            has_coverage = true;
            aggregate.indexed += index_coverage["indexed"].as_u64().unwrap_or(0);
            aggregate.total += index_coverage["total"].as_u64().unwrap_or(0);
            aggregate.matched += reply["total"].as_u64().unwrap_or(0);
            aggregate.shown += rows.len();
            aggregate.complete &=
                index_coverage["complete"].as_bool().unwrap_or(false) && fallback_dirs.is_empty();
        } else {
            aggregate.complete = false;
        }

        for dir in fallback_dirs {
            let (mailbox, local_only) = mailbox_for_vault_dir(&dir, &target.known_mailboxes);
            jobs.push(LocalFolder {
                account_id: target.account_id.clone(),
                vault_dir: dir,
                mailbox,
                local_only,
                fallback_reason,
            });
        }
        report.total = jobs.len();

        let mut frame = progress(&request.search_id);
        frame.lane = Some(SearchLane::Local);
        frame.rows = rows;
        frame.local_mode = Some(if available {
            LocalMode::Index
        } else {
            LocalMode::Scan
        });
        frame.fallback_reason = fallback_reason;
        frame.coverage = has_coverage.then(|| aggregate.clone());
        frame.total = report.total;
        frame.completed = report.completed;
        frame.failures = report.failures[prior_failure_count..].to_vec();
        emit_progress(&state, &run, frame);
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
                    let summaries = vault_files::list(
                        &root,
                        &folder_for_blocking.account_id,
                        &folder_for_blocking.mailbox,
                        None,
                    )?;
                    let uids = summaries
                        .iter()
                        .map(|summary| summary.uid)
                        .collect::<Vec<_>>();
                    let emails = vault_files::read_light_batch(
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
                if let Some(coverage) = frame.coverage.as_mut() {
                    coverage.shown += frame.rows.len();
                }
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
        if !run.is_cancelled() {
            emit_progress(&state, &run, frame);
        }
    }
    report
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

fn unique_vault_dirs(mailboxes: &[String]) -> HashSet<String> {
    mailboxes
        .iter()
        .map(|mailbox| core_search::text::vault_dir_name(mailbox))
        .collect()
}

fn mailbox_for_vault_dir(vault_dir: &str, known_mailboxes: &[String]) -> (String, bool) {
    let mut matches = known_mailboxes
        .iter()
        .filter(|mailbox| core_search::text::vault_dir_name(mailbox) == vault_dir);
    match (matches.next(), matches.next()) {
        (Some(mailbox), None) => (mailbox.clone(), false),
        _ => (vault_dir.to_owned(), true),
    }
}

fn stamp_local_row(
    row: &mut Value,
    account_id: &str,
    vault_dir: &str,
    known_mailboxes: &[String],
    already_local_only: bool,
) {
    let (mailbox, ambiguous) = mailbox_for_vault_dir(vault_dir, known_mailboxes);
    let local_only = already_local_only || ambiguous;
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
            cur.join(format!("{uid}:2,.eml")),
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
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc, from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json) VALUES ('acct', ?1, ?2, ?3, 1, 1, NULL, 1, 'sender@example.test', 'sender', ?4, '', 0, 1, ?5)",
                rusqlite::params![mailbox, uid, format!("{uid}:2,.eml"), subject.to_lowercase(), row_json],
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
        assert_eq!(frames[0]["rows"][0]["subject"], "already indexed");
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
}
