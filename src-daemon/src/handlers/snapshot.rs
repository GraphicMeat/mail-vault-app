//! `snapshot.*` RPCs answered by `server::route_inline`: thin wrappers over
//! `crate::snapshot`.
use crate::ipc::{self, RpcResponse};
use crate::snapshot;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Create a snapshot from provided email data (sent by frontend after backup).
pub(crate) fn handle_snapshot_create(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let account_email = params.get("accountEmail").and_then(|v| v.as_str()).unwrap_or("");

    let mailboxes_val = params.get("mailboxes");
    if account_id.is_empty() || mailboxes_val.is_none() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId or mailboxes");
    }

    let mailboxes: HashMap<String, snapshot::SnapshotMailbox> =
        match serde_json::from_value(mailboxes_val.unwrap().clone()) {
            Ok(m) => m,
            Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Invalid mailboxes: {}", e)),
        };

    match snapshot::create_snapshot(data_dir, account_id, account_email, mailboxes) {
        Ok(info) => RpcResponse::success(id, serde_json::to_value(info).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// Create a snapshot by scanning the local Maildir on disk.
pub(crate) fn handle_snapshot_create_from_maildir(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let account_email = params.get("accountEmail").and_then(|v| v.as_str()).unwrap_or("");

    if account_id.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId");
    }

    match snapshot::create_snapshot_from_maildir(data_dir, account_id, account_email) {
        Ok(info) => RpcResponse::success(id, serde_json::to_value(info).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// List all snapshots for an account.
pub(crate) fn handle_snapshot_list(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    if account_id.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId");
    }

    match snapshot::list_snapshots(data_dir, account_id) {
        Ok(list) => RpcResponse::success(id, serde_json::to_value(list).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// Load a full snapshot manifest.
pub(crate) fn handle_snapshot_load(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let filename = params.get("filename").and_then(|v| v.as_str()).unwrap_or("");

    if account_id.is_empty() || filename.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId or filename");
    }

    match snapshot::load_snapshot(data_dir, account_id, filename) {
        Ok(manifest) => RpcResponse::success(id, serde_json::to_value(manifest).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// Delete a snapshot.
pub(crate) fn handle_snapshot_delete(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let filename = params.get("filename").and_then(|v| v.as_str()).unwrap_or("");

    if account_id.is_empty() || filename.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId or filename");
    }

    match snapshot::delete_snapshot(data_dir, account_id, filename) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}
