//! Pending user bulk state only. Start/resume remain unregistered until the
//! mail worker exists, so a successful RPC never promises unimplemented work.
use crate::handlers::common::{blocking, done};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !matches!(method, "bulk.status" | "bulk.discard") { return None; }
    let operation_id = if method == "bulk.discard" {
        match params.get("operationId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            Some(operation_id) => Some(operation_id.to_owned()),
            None => return Some(RpcResponse::error(id, crate::ipc::INVALID_PARAMS, "errors.bulkMissingId")),
        }
    } else { None };
    let state = Arc::clone(state);
    Some(done(id, blocking(move || {
        // Same order as compatibility pending writes. No mailbox/network IO
        // runs under either mutex, and no mutex is held across an await.
        let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
        let mut bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
        match operation_id {
            Some(id) => bulk.discard(&state.app_dir, &id).map(|_| Value::Null),
            None => bulk.status(&state.app_dir),
        }
    }).await.map_err(|_| "errors.bulkPendingRead".to_string()).and_then(|r| r)))
}
