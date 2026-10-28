//! Native probe and closed-folder STATUS routes.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use crate::sync_observation::{self, Origin, SourceKey};
use mailvault_core::sync_policy::{self, MailboxNode};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;

const PROBE_DEADLINE: Duration = Duration::from_secs(25);
const FOLDER_DEADLINE: Duration = Duration::from_secs(120);

#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct WorkerSample {
    pub kind: &'static str,
    pub mailbox: String,
    pub thread_name: Option<String>,
    #[cfg(target_os = "macos")]
    pub qos: Option<u32>,
    #[cfg(target_os = "macos")]
    pub stack_bytes: Option<usize>,
}

#[cfg(test)]
static WORKER_SAMPLES: std::sync::Mutex<Option<Vec<WorkerSample>>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) struct WorkerSampleGuard;

#[cfg(test)]
impl WorkerSampleGuard {
    pub(crate) fn start() -> Self {
        *WORKER_SAMPLES.lock().unwrap_or_else(|error| error.into_inner()) = Some(Vec::new());
        Self
    }

    pub(crate) fn take(&self) -> Vec<WorkerSample> {
        let mut samples = WORKER_SAMPLES.lock().unwrap_or_else(|error| error.into_inner());
        samples.as_mut().map(std::mem::take).unwrap_or_default()
    }
}

#[cfg(test)]
impl Drop for WorkerSampleGuard {
    fn drop(&mut self) {
        *WORKER_SAMPLES.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

#[cfg(test)]
pub(crate) fn sample_worker_thread_for_test(kind: &'static str, mailbox: &str) {
    #[cfg(target_os = "macos")]
    let (qos, stack_bytes) = unsafe {
        let thread = libc::pthread_self();
        let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
        let mut priority = 0;
        let rc = libc::pthread_get_qos_class_np(thread, &mut class, &mut priority);
        (if rc == 0 { Some(class as u32) } else { None },
            Some(libc::pthread_get_stacksize_np(thread) as usize))
    };
    let sample = WorkerSample {
        kind, mailbox: mailbox.to_owned(),
        thread_name: std::thread::current().name().map(str::to_owned),
        #[cfg(target_os = "macos")]
        qos,
        #[cfg(target_os = "macos")]
        stack_bytes,
    };
    if let Some(samples) = WORKER_SAMPLES.lock()
        .unwrap_or_else(|error| error.into_inner()).as_mut() {
        samples.push(sample);
    }
}

fn invalid(id: Value) -> RpcResponse {
    RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid")
}

fn fields<'a>(params: &'a Value, allowed: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = params.as_object()?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return None; }
    Some(object)
}

fn id_and_mailbox(params: &Value) -> Option<(&str, &str)> {
    let account_id = params.get("accountId")?.as_str().filter(|text| !text.is_empty())?;
    let mailbox = params.get("mailbox")?.as_str().filter(|text| !text.is_empty())?;
    Some((account_id, mailbox))
}

fn account_id(params: &Value) -> Option<&str> {
    params.get("accountId")?.as_str().filter(|text| !text.is_empty())
}

fn probe(unchanged: bool, reason: &str) -> Value {
    json!({ "unchanged": unchanged, "reason": reason })
}

async fn current_origin(state: &Arc<DaemonState>, account_id: &str) -> Result<Origin, String> {
    let original = state.account_lifecycle.capture(account_id)
        .map_err(|_| "errors.keychainBusy".to_owned())?;
    sync_observation::origin(state, original).await
}

async fn check(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Value {
    let origin = match current_origin(state, account_id).await {
        Ok(origin) if !origin.graph => origin,
        _ => return probe(false, "probe-failed"),
    };
    // A recent marker is checked before the full metadata read. Its owner is
    // read separately so a replaced native cache cannot reuse the marker.
    let owner = match sync_observation::owner(state, &origin, mailbox).await {
        Ok(owner) => owner,
        Err(_) => return probe(false, "meta-read-failed"),
    };
    let source = SourceKey::new(&origin, mailbox, owner.clone());
    let now = mailvault_core::people::model::now_ms();
    if state.sync_observation.marker_recent(&source, now) {
        let current = sync_observation::origin(state, origin.original.clone()).await;
        if !current.is_ok_and(|current| current.hash == origin.hash)
            || sync_observation::owner(state, &origin, mailbox).await.ok() != Some(owner) {
            return probe(false, "probe-failed");
        }
        let _permit = match state.account_lifecycle.try_commit(std::slice::from_ref(&origin.original)) {
            Ok(permit) => permit,
            Err(_) => return probe(false, "probe-failed"),
        };
        return probe(true, "probed-recently");
    }
    let (meta, confirmed_owner) = match sync_observation::cache(state, &origin, mailbox).await {
        Ok(value) => value,
        Err(_) => return probe(false, "meta-read-failed"),
    };
    if confirmed_owner != owner { return probe(false, "probe-failed"); }
    if let Some(decision) = sync_policy::cache_preflight(meta.as_ref()) {
        return probe(decision.unchanged, decision.reason);
    }
    let Some(meta) = meta else { return probe(false, "no-cache") };
    if !source.cache_owner.as_ref().is_some_and(|owner|
        owner.account_id == source.account_id && owner.mailbox == source.mailbox
            && owner.origin_hash == origin.hash) {
        return probe(false, "probe-failed");
    }

    let config = match crate::oauth_tokens::resolve(state, account_id,
        crate::oauth_tokens::Read::Guarded).await {
        Ok(config) if mailvault_core::bulk_worker::origin_hash(&config) == origin.hash => config,
        _ => return probe(false, "probe-failed"),
    };
    let current = match sync_observation::origin(state, origin.original.clone()).await {
        Ok(current) if current.hash == origin.hash => current,
        _ => return probe(false, "probe-failed"),
    };
    let generation = state.sync_observation.generation(&source);
    let operation = match state.account_lifecycle.try_operation(std::slice::from_ref(&origin.original)) {
        Ok(operation) => operation,
        Err(_) => return probe(false, "probe-failed"),
    };
    let child_state = Arc::clone(state);
    let mailbox = mailbox.to_owned();
    let mut child = match state.sync_observation.spawn_job(async move {
        let state = child_state;
        let _operation = operation;
        crate::search_index::wait_foreground_quiet(&state.search_index).await;
        #[cfg(test)]
        sample_worker_thread_for_test("provider-probe", &mailbox);
        let status = if config.uses_jmap() {
            crate::handlers::jmap_bridge::observation_probe_status(&state, &config,
                current.original.id(), &mailbox, &current.original).await
        } else {
            crate::handlers::imap::observation_probe_status(&state, &config, &mailbox).await
        };
        let status = match status {
            Ok(status) if !status.is_null() => status,
            Ok(_) => return probe(false, "probe-empty"),
            Err(_) => return probe(false, "probe-failed"),
        };
        let decision = sync_policy::probe_decision(&meta, &status);
        if !decision.unchanged { return probe(false, decision.reason); }
        if sync_observation::revalidate(&state, &current, &source).await.is_err() {
            return probe(false, "probe-failed");
        }
        let _permit = match state.account_lifecycle.try_commit(std::slice::from_ref(&current.original)) {
            Ok(permit) => permit,
            Err(_) => return probe(false, "probe-failed"),
        };
        let Some(reference) = state.sync_observation.issue_check_proof(source, generation) else {
            return probe(false, "probe-failed");
        };
        json!({ "unchanged": true, "reason": decision.reason, "verificationRef": reference })
    }) {
        Ok(child) => child,
        Err(_) => return probe(false, "probe-failed"),
    };
    match tokio::time::timeout(PROBE_DEADLINE, &mut child).await {
        Ok(Ok(value)) => value,
        _ => probe(false, "probe-failed"),
    }
}

async fn mark(state: &Arc<DaemonState>, account_id: &str, mailbox: &str,
    reference: Option<&str>, ticket: Option<u64>) -> bool {
    let origin = match current_origin(state, account_id).await {
        Ok(origin) => origin,
        Err(_) => return false,
    };
    let (_, source) = match sync_observation::source(state, &origin, mailbox).await {
        Ok(value) => value,
        Err(_) => return false,
    };
    if sync_observation::revalidate(state, &origin, &source).await.is_err() { return false; }
    let _permit = match state.account_lifecycle.try_commit(std::slice::from_ref(&origin.original)) {
        Ok(permit) => permit,
        Err(_) => return false,
    };
    let now = mailvault_core::people::model::now_ms();
    match (reference, ticket) {
        (Some(reference), None) => state.sync_observation.mark_check(&source, reference, now),
        (None, Some(ticket)) => state.sync_engine.ticket_evidence(ticket)
            .is_some_and(|evidence| state.sync_observation.mark_ticket(&source, &evidence, now)),
        _ => false,
    }
}

async fn refresh(state: &Arc<DaemonState>, account_id: &str, active: Option<&str>,
    nodes: Vec<MailboxNode>) -> Result<Option<Value>, String> {
    let origin = match current_origin(state, account_id).await {
        Ok(origin) if !origin.graph => origin,
        _ => return Ok(None),
    };
    let paths = sync_policy::select_status_paths(&nodes, active);
    if paths.is_empty() { return Ok(None); }
    let now = mailvault_core::people::model::now_ms();
    let Some(generation) = state.sync_observation.folder_start(&origin, now) else {
        return Ok(None);
    };
    let config = crate::oauth_tokens::resolve(state, account_id,
        crate::oauth_tokens::Read::Guarded).await
        .map_err(|_| "errors.connectionFailed".to_owned())?;
    if mailvault_core::bulk_worker::origin_hash(&config) != origin.hash {
        return Ok(None);
    }
    let current = match sync_observation::origin(state, origin.original.clone()).await {
        Ok(current) if current.hash == origin.hash => current,
        _ => return Ok(None),
    };
    let operation = match state.account_lifecycle.try_operation(std::slice::from_ref(&origin.original)) {
        Ok(operation) => operation,
        Err(_) => return Ok(None),
    };
    let child_state = Arc::clone(state);
    let mut child = state.sync_observation.spawn_job(async move {
        let state = child_state;
        let _operation = operation;
        crate::search_index::wait_foreground_quiet(&state.search_index).await;
        #[cfg(test)]
        sample_worker_thread_for_test("provider-folder", paths.first().map(String::as_str).unwrap_or(""));
        let statuses = if config.uses_jmap() {
            crate::handlers::jmap_bridge::observation_folder_status(&state, &config,
                current.original.id(), paths, &current.original).await
        } else {
            crate::handlers::imap::observation_folder_status(&state, &config, &paths).await
        }?;
        let after = sync_observation::origin(&state, current.original.clone()).await?;
        if after.hash != current.hash || !state.sync_observation.folder_current(after.original.id(), generation) {
            return Ok(None);
        }
        let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&current.original))
            .map_err(|_| "errors.keychainBusy".to_owned())?;
        Ok::<Option<Value>, String>(Some(json!({"rows": statuses})))
    }).map_err(|_| "errors.connectionFailed".to_owned())?;
    match tokio::time::timeout(FOLDER_DEADLINE, &mut child).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) | Err(_) => Err("errors.connectionFailed".to_owned()),
    }
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: Value, id: Value) -> RpcResponse {
    match (method, params.get("op").and_then(Value::as_str)) {
        ("sync.probe", Some("check")) => {
            if fields(&params, &["op", "accountId", "mailbox"]).is_none() {
                return invalid(id);
            }
            let Some((account_id, mailbox)) = id_and_mailbox(&params) else { return invalid(id) };
            let decision = tokio::time::timeout(PROBE_DEADLINE,
                check(state, account_id, mailbox)).await
                .unwrap_or_else(|_| probe(false, "probe-failed"));
            RpcResponse::success(id, decision)
        }
        ("sync.probe", Some("mark")) => {
            if fields(&params, &["op", "accountId", "mailbox", "verificationRef", "ticket"]).is_none() {
                return invalid(id);
            }
            let Some((account_id, mailbox)) = id_and_mailbox(&params) else { return invalid(id) };
            let reference = params.get("verificationRef").and_then(Value::as_str).filter(|text| !text.is_empty());
            let ticket = params.get("ticket").and_then(Value::as_u64);
            if (reference.is_some() == ticket.is_some()) ||
                (params.get("verificationRef").is_some() && reference.is_none()) ||
                (params.get("ticket").is_some() && ticket.is_none()) {
                return invalid(id);
            }
            RpcResponse::success(id, json!({"marked": mark(state, account_id, mailbox, reference, ticket).await}))
        }
        ("sync.probe", Some("invalidate")) => {
            if fields(&params, &["op", "accountId", "mailbox"]).is_none() { return invalid(id); }
            let Some(account_id) = account_id(&params) else { return invalid(id) };
            let mailbox = match params.get("mailbox") {
                Some(Value::String(mailbox)) => Some(mailbox.as_str()),
                None => None,
                _ => return invalid(id),
            };
            state.sync_observation.invalidate_probe(account_id, mailbox);
            RpcResponse::success(id, json!({"invalidated": true}))
        }
        ("folders.status", Some("refresh")) => {
            if fields(&params, &["op", "accountId", "activeMailbox", "mailboxes"]).is_none() {
                return invalid(id);
            }
            let Some(account_id) = account_id(&params) else { return invalid(id) };
            let active = match params.get("activeMailbox") {
                Some(Value::String(path)) => Some(path.as_str()),
                Some(Value::Null) => None,
                _ => return invalid(id),
            };
            let Some(nodes) = params.get("mailboxes").and_then(|value|
                serde_json::from_value::<Vec<MailboxNode>>(value.clone()).ok()) else {
                return invalid(id);
            };
            let outcome = tokio::time::timeout(FOLDER_DEADLINE,
                refresh(state, account_id, active, nodes)).await
                .unwrap_or_else(|_| Err("errors.connectionFailed".to_owned()));
            match outcome {
                Ok(Some(value)) => RpcResponse::success(id, value),
                Ok(None) => RpcResponse::success(id, Value::Null),
                Err(error) => RpcResponse::error(id, ipc::INTERNAL_ERROR, error),
            }
        }
        ("folders.status", Some("invalidate")) => {
            if fields(&params, &["op", "accountId"]).is_none() { return invalid(id); }
            let Some(account_id) = account_id(&params) else { return invalid(id) };
            state.sync_observation.invalidate_folder(account_id);
            RpcResponse::success(id, json!({"invalidated": true}))
        }
        _ => invalid(id),
    }
}
