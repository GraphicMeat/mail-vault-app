//! Strict refresh receipt routes. Admission uses only local native metadata.

use crate::ipc::{self, RpcResponse};
use crate::refresh_worker::{Intent, Reason, RefreshState};
use crate::server::DaemonState;
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::Duration;

fn fields<'a>(params: &'a Value, allowed: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = params.as_object()?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return None; }
    Some(object)
}

fn identifier(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && text.len() <= 128 && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

fn name(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && text.len() <= 1024 && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

fn intent(params: &Value) -> Option<Intent> {
    let object = fields(params, &["requestId", "accountId", "mailbox", "reason"])?;
    let request_id = identifier(object.get("requestId"))?;
    let account_id = match object.get("accountId") {
        None => None,
        Some(value) => Some(name(Some(value))?),
    };
    let mailbox = Some(match object.get("mailbox") {
        None => "INBOX".to_owned(),
        Some(value) => name(Some(value))?,
    });
    if mailbox.as_deref() == Some("UNIFIED") { return None; }
    let reason = match object.get("reason")?.as_str()? {
        "manual" => Reason::Manual,
        "scheduled" => Reason::Scheduled,
        "launch" => Reason::Launch,
        _ => return None,
    };
    Some(Intent { request_id, account_id, mailbox, reason })
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: Value, id: Value) -> RpcResponse {
    match method {
        "sync.refresh" => {
            let Some(intent) = intent(&params) else {
                return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
            };
            match tokio::time::timeout(Duration::from_secs(30), RefreshState::admit(state, intent)).await {
                Ok(Ok(result)) => RpcResponse::success(id, result),
                Ok(Err("errors.accountsInvalid")) => RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid"),
                Ok(Err(error)) => RpcResponse::error(id, ipc::INTERNAL_ERROR, error),
                Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.syncUnavailable"),
            }
        }
        "sync.refresh_status" => {
            let Some(object) = fields(&params, &["requestId"]) else {
                return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
            };
            let request_id = match object.get("requestId") {
                None => None,
                Some(value) => match identifier(Some(value)) {
                    Some(id) => Some(id),
                    None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid"),
                },
            };
            RpcResponse::success(id, state.refresh.status(request_id.as_deref()))
        }
        _ => RpcResponse::error(id, ipc::METHOD_NOT_FOUND, "errors.syncUnavailable"),
    }
}
