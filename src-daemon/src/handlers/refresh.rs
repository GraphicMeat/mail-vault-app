//! Strict refresh receipt routes. Admission uses only local native metadata.

use crate::ipc::{self, RpcResponse};
use crate::refresh_worker::{ContextInput, ContextPhase, ContextView, Intent, Reason, RefreshState};
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
    let mailbox = match object.get("mailbox") {
        None => None,
        Some(value) => Some(name(Some(value))?),
    };
    let reason = match object.get("reason")?.as_str()? {
        "manual" => Reason::Manual,
        "scheduled" => Reason::Scheduled,
        "launch" => Reason::Launch,
        _ => return None,
    };
    Some(Intent { request_id, account_id, mailbox, reason })
}

pub(crate) fn sync_owner(params: &Value) -> Option<(String, u64)> {
    let object = fields(params, &["launchId", "revision"])?;
    let launch_id = identifier(object.get("launchId"))?;
    let revision = object.get("revision")?.as_u64().filter(|value| *value <= 9_007_199_254_740_991)?;
    Some((launch_id, revision))
}

fn context(params: &Value) -> Option<ContextInput> {
    let object = fields(params, &["launchId", "revision", "phase", "view"])?;
    let (launch_id, revision) = sync_owner(&serde_json::json!({
        "launchId":object.get("launchId")?, "revision":object.get("revision")?,
    }))?;
    let phase = match object.get("phase")?.as_str()? {
        "start" => ContextPhase::Start,
        "resume" => ContextPhase::Resume,
        _ => return None,
    };
    let view = match object.get("view")? {
        Value::Null => None,
        Value::Object(view) => {
            if view.get("accountId") == Some(&Value::Null) {
                if view.keys().any(|key| !["accountId", "mailbox", "unifiedFolder"].contains(&key.as_str()))
                    || view.get("mailbox")?.as_str()? != "UNIFIED" { return None; }
                let folder = match view.get("unifiedFolder") {
                    None => None,
                    Some(value) => Some(name(Some(value))?),
                };
                if folder.as_deref() == Some("UNIFIED") { return None; }
                Some(ContextView::Unified { folder })
            } else {
                if view.keys().any(|key| !["accountId", "mailbox", "scopePaths"].contains(&key.as_str())) {
                    return None;
                }
                let account_id = name(view.get("accountId"))?;
                let mailbox = name(view.get("mailbox"))?;
                if mailbox == "UNIFIED" { return None; }
                match view.get("scopePaths") {
                    None => Some(ContextView::Ordinary { account_id, mailbox }),
                    Some(Value::Array(paths)) => {
                        let paths: Vec<String> = paths.iter().map(|value| name(Some(value)))
                            .collect::<Option<_>>()?;
                        if paths.iter().any(|path| path == "UNIFIED") { return None; }
                        Some(ContextView::Subtree { account_id, mailbox, paths })
                    }
                    _ => return None,
                }
            }
        }
        _ => return None,
    };
    Some(ContextInput { launch_id, revision, phase, view })
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
        "sync.context" => {
            let Some(context) = context(&params) else {
                return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
            };
            match tokio::time::timeout(Duration::from_secs(30), RefreshState::accept_context(state, context)).await {
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
