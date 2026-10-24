//! User bulk RPCs only claim/control work. Admission receipts are registered
//! before filesystem work, and a fence can rule out a late timed-out request.
use crate::handlers::common::{blocking, done};
use crate::{ipc::RpcResponse, server::DaemonState};
use mailvault_core::bulk::{Action, Scope};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};

/// The blocking operation owns admission lifetime even if its RPC waiter drops.
struct AdmissionCompletion {
    state: Arc<DaemonState>,
    context: Option<(String, String)>,
    finished: bool,
}
impl AdmissionCompletion {
    fn finish(&mut self, result: &Result<Value, String>) {
        if let Some((operation, attempt)) = &self.context {
            self.state.bulk.lock().unwrap_or_else(|p| p.into_inner())
                .finish_admission(operation, attempt, result);
        }
        self.finished = true;
    }
}
impl Drop for AdmissionCompletion {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(&Err("errors.bulkWorkerUnavailable".into()));
        }
    }
}

pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    if !matches!(
        method,
        "bulk.start" | "bulk.resume" | "bulk.status" | "bulk.cancel" | "bulk.discard"
    ) {
        return None;
    }
    let operation_id = if method == "bulk.status" {
        None
    } else {
        match params["operationId"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => Some(id.to_owned()),
            None => {
                return Some(RpcResponse::error(
                    id,
                    crate::ipc::INVALID_PARAMS,
                    "errors.bulkMissingId",
                ))
            }
        }
    };
    let kickoff = matches!(method, "bulk.start" | "bulk.resume");
    let attempt = params["attemptId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if kickoff {
        let begin = state
            .bulk
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .begin_admission(operation_id.as_deref().unwrap(), &attempt);
        match begin {
            Ok(Some(snapshot)) if method == "bulk.resume" => {
                return Some(RpcResponse::success(id, snapshot))
            }
            Ok(Some(_)) => {}
            Err(error) => return Some(RpcResponse::error(id, crate::ipc::INTERNAL_ERROR, error)),
            Ok(None) => {}
        }
    }
    let receipt_context = kickoff.then(|| (operation_id.clone().unwrap(), attempt.clone()));
    let (state, params, method) = (state.clone(), params.clone(), method.to_owned());
    let result = blocking(move || -> Result<Value, String> {
        let mut completion = AdmissionCompletion { state: state.clone(), context: receipt_context, finished: false };
        let result = (|| -> Result<Value, String> {
        let operation_id = operation_id.as_deref().unwrap_or("");
        match method.as_str() {
            "bulk.start" => {
                let action: Action = serde_json::from_value(params["type"].clone())
                    .map_err(|_| "errors.bulkUnsupported".to_string())?;
                let scope: Scope = serde_json::from_value(params["scope"].clone())
                    .map_err(|_| "errors.bulkPendingInvalid".to_string())?;
                if let Some(snapshot) = crate::bulk_worker::duplicate_start(&state, operation_id, &attempt, action, &scope)? {
                    return Ok(snapshot);
                }
                let work = crate::bulk_worker::freeze(&state, action, scope)?;
                let (snapshot, duplicate) = crate::bulk_worker::prepare_claim(&state, operation_id, &attempt, work.intent.clone())?;
                if !duplicate {
                    if let Err(error) =
                        crate::bulk_worker::checkpoint(&state, operation_id, &attempt, &work)
                    {
                        let _journal = state
                            .journal
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        let _ = state
                            .bulk
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .drained_attempt(operation_id, &attempt);
                        return Err(error);
                    }
                    if let Err(error) = crate::bulk_worker::launch(
                        state.clone(),
                        operation_id.into(),
                        attempt.clone(),
                        work,
                        // The shell intercepts both raw RPC paths, strips
                        // client values, then injects its attempt-held native
                        // bookmark path/status pair (src-tauri bulk.rs).
                        params["mirrorRoot"].as_str().map(str::to_owned),
                        params["externalStatus"].as_str().map(str::to_owned),
                        false,
                    ) {
                        let _journal = state
                            .journal
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        let _ = state
                            .bulk
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .drained_attempt(operation_id, &attempt);
                        return Err(error);
                    }
                }
                Ok(snapshot)
            }
            "bulk.resume" => {
                if let Some(snapshot) = state
                    .bulk
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .active_status()
                {
                    if snapshot["active"]["id"].as_str() == Some(operation_id) {
                        return Ok(snapshot["active"].clone());
                    }
                    return Err("errors.operationRunning".into());
                }
                let (work, snapshot) =
                    crate::bulk_worker::prepare_resume(&state, operation_id, &attempt)?;
                if let Err(error) = crate::bulk_worker::launch(
                    state.clone(),
                    operation_id.into(),
                    attempt.clone(),
                    work,
                    params["mirrorRoot"].as_str().map(str::to_owned),
                    params["externalStatus"].as_str().map(str::to_owned),
                    true,
                ) {
                    let _journal = state
                        .journal
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    let _ = state
                        .bulk
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .drained_attempt(operation_id, &attempt);
                    return Err(error);
                }
                Ok(snapshot)
            }
            "bulk.cancel" => {
                let bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                bulk.cancel_token(operation_id)?
                    .store(true, Ordering::SeqCst);
                Ok(json!({"id":operation_id,"status":"cancelling"}))
            }
            _ => {
                if method == "bulk.status" {
                    let mut bulk = state
                        .bulk
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    let receipt = params["operationId"]
                        .as_str()
                        .zip(params["attemptId"].as_str());
                    if let Some((operation, attempt)) = receipt {
                        if params["fenceUnstarted"].as_bool() == Some(true) {
                            bulk.fence_admission(operation, attempt)?;
                        }
                    }
                    let status = bulk
                        .admission_status()
                        .or_else(|| receipt.map(|_| bulk.cached_status()));
                    if let Some(status) = status {
                        let mut status = status?;
                        if let Some((operation, attempt)) = receipt {
                            status["admission"] = bulk.admission_receipt(operation, attempt);
                        }
                        return Ok(status);
                    }
                }
                if method == "bulk.status" {
                    let mut status = crate::bulk_worker::reconcile_pending(&state)?;
                    if let Some((operation, attempt)) = params["operationId"]
                        .as_str()
                        .zip(params["attemptId"].as_str())
                    {
                        status["admission"] = state
                            .bulk
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .admission_receipt(operation, attempt);
                    }
                    return Ok(status);
                }
                let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                bulk.discard(&state.app_dir, operation_id)
                    .map(|_| Value::Null)
            }
        }
        })();
        completion.finish(&result);
        result
    })
    .await
    .map_err(|_| "errors.bulkWorkerUnavailable".to_string())
    .and_then(|result| result)
    .map_err(|error| crate::bulk_worker::service_error(&error));
    Some(done(id, result))
}
