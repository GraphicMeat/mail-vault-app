//! Shared plumbing for every Phase 2 router (`vault_files`, `cache`, `journal`,
//! `custody`, `vault_flags`, Tasks 2.6-2.9a): the blocking-task helper (moved
//! here from `handlers/search_index.rs`, which now imports it back), the
//! vault-unavailable gate, and small arg extractors.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Run `f` on a blocking-pool thread. Every Phase 2 handler touches disk, or a
/// mutex that guards disk work, so it never runs on a tokio worker.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Task join error: {e}"))
}

pub(crate) fn done(id: Value, r: Result<Value, String>) -> RpcResponse {
    match r {
        Ok(v) => RpcResponse::success(id, v),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// The exact message text every `E_VAULT_UNAVAILABLE:` gate answers with —
/// callers (JS and Rust) match on this prefix verbatim (Global constraints:
/// "Same JSON in/out" / error texts callers match on).
fn gate_message(reason: &str) -> String {
    format!("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: {reason}")
}

/// The gate every vault-rooted Phase 2 route calls before touching disk (spec
/// deviation 7). Never falls back to `state.app_dir`: a vault-rooted route
/// that did would silently start a second, divergent archive there when the
/// configured folder is unreachable.
pub(crate) fn vault_root(state: &Arc<DaemonState>) -> Result<PathBuf, String> {
    if !state.mail_dir_ok {
        return Err(gate_message("the folder is not reachable"));
    }
    if state.vault_closed.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(gate_message("the vault is being moved"));
    }
    Ok(state.data_dir.clone())
}

/// An `E_VAULT_UNAVAILABLE:` reply as an `RpcResponse`. `INTERNAL_ERROR` so
/// `RpcOutcome::Direct` (`src-tauri/src/main.rs` `map_rpc_error`) passes the
/// message to JS unchanged instead of treating it as a transport failure.
pub(crate) fn gate_err(id: Value, msg: String) -> RpcResponse {
    RpcResponse::error(id, ipc::INTERNAL_ERROR, msg)
}

/// A required string param. `Err` names the missing key, as `INVALID_PARAMS`.
pub(crate) fn str_arg(id: &Value, params: &Value, key: &str) -> Result<String, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// An optional string param — absent or non-string both read as `None`.
pub(crate) fn opt_str_arg(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A required u32 param (JSON numbers arrive as u64; every uid fits u32).
pub(crate) fn u32_arg(id: &Value, params: &Value, key: &str) -> Result<u32, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// A required array param, deserialized element-wise (uid lists, change lists).
pub(crate) fn vec_arg<T: serde::de::DeserializeOwned>(id: &Value, params: &Value, key: &str) -> Result<Vec<T>, RpcResponse> {
    params
        .get(key)
        .and_then(|v| serde_json::from_value::<Vec<T>>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(mail_dir_ok: bool) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-common-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, mail_dir_ok)
    }

    #[test]
    fn vault_root_refuses_an_unreachable_folder() {
        let st = state(false);
        let err = vault_root(&st).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("not reachable"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn vault_root_refuses_while_the_vault_is_closed_for_a_move() {
        let st = state(true);
        st.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = vault_root(&st).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn vault_root_succeeds_when_ok_and_not_closed() {
        let st = state(true);
        assert_eq!(vault_root(&st).unwrap(), st.data_dir);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn gate_err_carries_the_message_verbatim_as_internal_error() {
        let msg = "E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the folder is not reachable".to_string();
        let resp = gate_err(json!(1), msg.clone());
        let err = resp.error.expect("gate_err must answer an error");
        assert_eq!(err.code, ipc::INTERNAL_ERROR);
        assert_eq!(err.message, msg);
    }

    #[test]
    fn str_arg_names_the_missing_key() {
        let err = str_arg(&json!(1), &json!({}), "accountId").unwrap_err();
        assert_eq!(err.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    #[test]
    fn str_arg_reads_a_present_value() {
        assert_eq!(str_arg(&json!(1), &json!({"accountId": "a1"}), "accountId").unwrap(), "a1");
    }

    #[test]
    fn opt_str_arg_is_none_when_absent() {
        assert_eq!(opt_str_arg(&json!({}), "mailbox"), None);
        assert_eq!(opt_str_arg(&json!({"mailbox": "INBOX"}), "mailbox"), Some("INBOX".to_string()));
    }

    #[test]
    fn u32_arg_names_the_missing_key() {
        let err = u32_arg(&json!(1), &json!({}), "uid").unwrap_err();
        assert_eq!(err.error.unwrap().code, ipc::INVALID_PARAMS);
        assert_eq!(u32_arg(&json!(1), &json!({"uid": 7}), "uid").unwrap(), 7);
    }

    #[test]
    fn vec_arg_names_the_missing_key() {
        let err = vec_arg::<u32>(&json!(1), &json!({}), "uids").unwrap_err();
        assert_eq!(err.error.unwrap().code, ipc::INVALID_PARAMS);
        assert_eq!(vec_arg::<u32>(&json!(1), &json!({"uids": [1, 2]}), "uids").unwrap(), vec![1, 2]);
    }
}
