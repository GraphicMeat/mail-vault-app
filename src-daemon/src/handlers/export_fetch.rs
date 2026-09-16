//! Daemon route for `fetch_remote_asset` (Task 4.2), backed by
//! `crate::export_fetch`, moved whole from `src-tauri/src/export_fetch.rs`.
//! No vault gate: the function never touches the vault, `state.app_dir` or
//! any other daemon state — it is a pure `reqwest` fetch keyed only by the
//! caller-supplied url, so there is nothing here for a gate to protect.

use crate::export_fetch;
use crate::handlers::common::str_arg;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn route(_state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "fetch_remote_asset" => {
            let url = match str_arg(&id, params, "url") {
                Ok(u) => u,
                Err(resp) => return Some(resp),
            };
            match export_fetch::fetch_remote_asset(url).await {
                Ok(asset) => RpcResponse::success(id, serde_json::to_value(asset).unwrap()),
                Err(e) => RpcResponse::error(id, crate::ipc::INTERNAL_ERROR, e),
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-export-fetch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st();
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn missing_url_is_invalid_params() {
        let s = st();
        let resp = route(&s, "fetch_remote_asset", &json!({}), json!(1)).await.expect("routed");
        assert!(resp.result.is_none());
        assert_eq!(resp.error.unwrap().code, crate::ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn a_refused_scheme_reaches_the_route_as_an_error_reply_not_a_panic() {
        let s = st();
        let resp = route(&s, "fetch_remote_asset", &json!({"url": "file:///etc/passwd"}), json!(1))
            .await
            .expect("routed");
        assert!(resp.result.is_none());
        assert_eq!(resp.error.unwrap().code, crate::ipc::INTERNAL_ERROR);
    }

    #[tokio::test]
    async fn fetch_remote_asset_reaches_this_router_through_handle_request() {
        let s = st();
        let resp = handle_request_for_test(&s, "fetch_remote_asset", json!({"url": "ftp://x.test/a.png"})).await;
        assert!(resp.result.is_none(), "refused scheme still routes through this handler, just fails");
        assert!(resp.error.is_some());
    }
}
