//! `people.*` write-side RPCs. Added with the write RPCs; routed from `people::route`.
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn route(_state: &Arc<DaemonState>, _method: &str, _p: &Value, _id: Value) -> Option<RpcResponse> {
    None
}
