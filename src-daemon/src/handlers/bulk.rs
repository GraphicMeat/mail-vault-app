//! User bulk RPCs validate/claim intent and return immediately. Mail work runs
//! on its named background thread; only matching operation controls apply.
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
            Some(s) => Some(s.to_string()),
            None => {
                return Some(RpcResponse::error(
                    id,
                    crate::ipc::INVALID_PARAMS,
                    "errors.bulkMissingId",
                ))
            }
        }
    };
    let (state, params, method) = (state.clone(), params.clone(), method.to_string());
    Some(done(
        id,
        blocking(move || -> Result<Value, String> {
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
                    let intent = work.intent.clone();
                    let (snapshot, duplicate) = {
                        let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                        let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                        let duplicate = bulk.active_id() == Some(operation_id);
                        let snapshot = bulk.claim(&state.app_dir, operation_id, intent.clone())?;
                        if !duplicate && bulk.active_id() == Some(operation_id) {
                            if let Err(e) = bulk.checkpoint(&state.app_dir, operation_id, &work) {
                                let _ = bulk.drained(operation_id);
                                return Err(e);
                            }
                        }
                        (
                            snapshot,
                            duplicate || bulk.active_id() != Some(operation_id),
                        )
                    };
                    if !duplicate {
                        if let Err(e) = crate::bulk_worker::launch(
                            state.clone(),
                            operation_id.into(),
                            work,
                            params["mirrorRoot"].as_str().map(str::to_owned),
                            false,
                        ) {
                            let _ = state
                                .bulk
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .drained(operation_id);
                            return Err(e);
                        }
                    }
                    Ok(snapshot)
                }
                "bulk.resume" => {
                    let work = {
                        let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                        let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                        if bulk.active_id() == Some(operation_id) {
                            return bulk.status(&state.app_dir).map(|s| s["active"].clone());
                        }
                        bulk.resume_worker(&state.app_dir, operation_id)?
                    };
                    if work.intent.action() == Action::DeleteEverywhere {
                        return Err("errors.bulkUnsupported".into());
                    }
                    if let Err(e) = crate::bulk_worker::launch(
                        state.clone(),
                        operation_id.into(),
                        work,
                        params["mirrorRoot"].as_str().map(str::to_owned),
                        true,
                    ) {
                        let _ = state
                            .bulk
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .drained(operation_id);
                        return Err(e);
                    }
                    Ok(json!({"id":operation_id,"status":"starting"}))
                }
                "bulk.cancel" => {
                    let bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                    bulk.cancel_token(operation_id)?
                        .store(true, Ordering::SeqCst);
                    // Acknowledgement is not terminal. Only the drained worker
                    // emits finished and permits the shell to release its scope.
                    Ok(json!({"id":operation_id,"status":"cancelling"}))
                }
                _ => {
                    let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                    let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
                    if method == "bulk.discard" {
                        bulk.discard(&state.app_dir, operation_id)
                            .map(|_| Value::Null)
                    } else {
                        bulk.status(&state.app_dir)
                    }
                }
            }
        })
        .await
        .map_err(|_| "errors.bulkWorkerUnavailable".to_string())
        .and_then(|r| r),
    ))
}
