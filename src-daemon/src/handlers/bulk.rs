//! User bulk RPCs only claim/control work. Admission receipts are registered
//! before filesystem work, and a fence can rule out a late timed-out request.
use crate::handlers::common::{blocking, done};
use crate::{ipc::RpcResponse, server::DaemonState};
use mailvault_core::bulk::{Action, Scope};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};

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
    let receipt_state = state.clone();
    let (state, params, method) = (state.clone(), params.clone(), method.to_owned());
    let result = blocking(move || -> Result<Value, String> {
        let operation_id = operation_id.as_deref().unwrap_or("");
        match method.as_str() {
            "bulk.start" => {
                let action: Action = serde_json::from_value(params["type"].clone())
                    .map_err(|_| "errors.bulkUnsupported".to_string())?;
                if action == Action::DeleteEverywhere {
                    return Err("errors.bulkUnsupported".into());
                }
                let scope: Scope = serde_json::from_value(params["scope"].clone())
                    .map_err(|_| "errors.bulkPendingInvalid".to_string())?;
                let work = crate::bulk_worker::freeze(&state, action, scope)?;
                let (snapshot, duplicate) = {
                    let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                    let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                    let duplicate = bulk.active_id() == Some(operation_id);
                    let snapshot = bulk.claim_attempt(
                        &state.app_dir,
                        operation_id,
                        &attempt,
                        work.intent.clone(),
                    )?;
                    if !duplicate && bulk.active_id() == Some(operation_id) {
                        if let Err(error) = bulk.checkpoint(&state.app_dir, operation_id, &work) {
                            let _ = bulk.drained_attempt(operation_id, &attempt);
                            return Err(error);
                        }
                    }
                    (
                        snapshot,
                        duplicate || bulk.active_id() != Some(operation_id),
                    )
                };
                if !duplicate {
                    if let Err(error) = crate::bulk_worker::launch(
                        state.clone(),
                        operation_id.into(),
                        attempt.clone(),
                        work,
                        params["mirrorRoot"].as_str().map(str::to_owned),
                        false,
                    ) {
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
                let (work, snapshot) = {
                    let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                    let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                    if bulk.active_id() == Some(operation_id) {
                        return bulk
                            .status(&state.app_dir)
                            .map(|status| status["active"].clone());
                    }
                    let work =
                        bulk.resume_worker_attempt(&state.app_dir, operation_id, &attempt)?;
                    let snapshot = bulk.status(&state.app_dir)?["active"].clone();
                    (work, snapshot)
                };
                if let Err(error) = crate::bulk_worker::launch(
                    state.clone(),
                    operation_id.into(),
                    attempt.clone(),
                    work,
                    params["mirrorRoot"].as_str().map(str::to_owned),
                    true,
                ) {
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
                let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                if method == "bulk.discard" {
                    bulk.discard(&state.app_dir, operation_id)
                        .map(|_| Value::Null)
                } else {
                    let receipt = params["operationId"]
                        .as_str()
                        .zip(params["attemptId"].as_str());
                    if let Some((operation, attempt)) = receipt {
                        if params["fenceUnstarted"].as_bool() == Some(true) {
                            bulk.fence_admission(operation, attempt)?;
                        }
                    }
                    let mut status = bulk.status(&state.app_dir)?;
                    if let Some((operation, attempt)) = receipt {
                        status["admission"] = bulk.admission_receipt(operation, attempt);
                    }
                    Ok(status)
                }
            }
        }
    })
    .await
    .map_err(|_| "errors.bulkWorkerUnavailable".to_string())
    .and_then(|result| result)
    .map_err(|error| crate::bulk_worker::service_error(&error));
    if let Some((operation, attempt)) = receipt_context {
        receipt_state
            .bulk
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .finish_admission(&operation, &attempt, &result);
    }
    Some(done(id, result))
}
