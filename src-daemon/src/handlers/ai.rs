//! AI provider RPCs (Phase 3b) — the one entry point every future AI feature
//! (Auto Tags, Quick Replies, AI Compose) calls through. The actual provider
//! logic lives in `llm.rs`; this layer only pulls RPC params apart.
use crate::credentials;
use crate::handlers::common::str_arg;
use crate::ipc::{self, RpcResponse};
use crate::llm;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;

/// Same early-return shape `handlers/scheduled.rs` uses: an `Err(RpcResponse)`
/// here returns straight out of `route`.
macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("ai.") {
        return None;
    }
    Some(match method {
        "ai.providers" => {
            let endpoint_url = params.get("endpointUrl").and_then(Value::as_str);
            let statuses = llm::providers_status(&state.llm, endpoint_url).await;
            match serde_json::to_value(statuses) {
                Ok(v) => RpcResponse::success(id, v),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()),
            }
        }

        "ai.generate" => {
            let provider: llm::Provider = match params.get("provider").and_then(|v| serde_json::from_value(v.clone()).ok()) {
                Some(p) => p,
                None => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing or invalid provider")),
            };
            let prompt = req!(str_arg(&id, params, "prompt"));
            let system = params.get("system").and_then(Value::as_str);
            let max_tokens = params.get("maxTokens").and_then(Value::as_u64).unwrap_or(512) as usize;

            match llm::generate(&provider, &state.inference, &prompt, system, max_tokens).await {
                Ok(text) => RpcResponse::success(id, serde_json::json!({ "text": text })),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "ai.set_endpoint_key" => {
            let key = req!(str_arg(&id, params, "key"));
            match credentials::store_ai_endpoint_key_guarded(key).await {
                Ok(()) => RpcResponse::success(id, serde_json::json!({ "stored": true })),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-ai-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    /// Registration guard, not a behaviour test: reached through
    /// `server::handle_request`, an unwired module answers "Unknown method"
    /// to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "ai.providers", json!({})).await;
        assert!(resp.result.is_some(), "ai.providers is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn providers_answers_degraded_with_nothing_configured_and_no_model_downloaded() {
        let s = st();
        let resp = call(&s, "ai.providers", json!({})).await;
        let statuses = resp.result.expect("ai.providers must not error just because nothing is set up");
        let list = statuses.as_array().unwrap();
        assert_eq!(list.len(), 3);
        let local = list.iter().find(|v| v["provider"] == "localGguf").unwrap();
        assert_eq!(local["available"], false);
        let endpoint = list.iter().find(|v| v["provider"] == "endpoint").unwrap();
        assert_eq!(endpoint["available"], false);
        assert_eq!(endpoint["reason"], "not configured");
    }

    #[tokio::test]
    async fn providers_reports_an_endpoint_as_configured_once_a_url_is_passed() {
        let s = st();
        let resp = call(&s, "ai.providers", json!({"endpointUrl": "http://localhost:11434/v1"})).await;
        let list = resp.result.unwrap();
        let endpoint = list.as_array().unwrap().iter().find(|v| v["provider"] == "endpoint").unwrap();
        assert_eq!(endpoint["available"], true);
    }

    #[tokio::test]
    async fn generate_requires_a_provider_and_a_prompt() {
        let s = st();
        let resp = route(&s, "ai.generate", &json!({"prompt": "hi"}), json!(1)).await.unwrap();
        assert!(resp.result.is_none(), "missing provider must be refused");

        let resp = route(&s, "ai.generate", &json!({"provider": {"type": "localGguf"}}), json!(1)).await.unwrap();
        assert!(resp.result.is_none(), "missing prompt must be refused");
    }

    #[tokio::test]
    async fn generate_with_local_gguf_and_no_model_loaded_fails_locally_not_as_invalid_params() {
        let s = st();
        let resp = call(&s, "ai.generate", json!({"provider": {"type": "localGguf"}, "prompt": "hi"})).await;
        assert!(resp.result.is_none());
        let msg = resp.error.unwrap().message;
        assert!(msg.contains("No model loaded"), "{msg}");
    }

    #[tokio::test]
    async fn set_endpoint_key_requires_a_key_and_never_echoes_it_back() {
        let s = st();
        let refused = route(&s, "ai.set_endpoint_key", &json!({}), json!(1)).await.unwrap();
        assert!(refused.result.is_none());

        let _guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MAILVAULT_TEST_AI_KEY", dir.path().join("ai_key"));

        let resp = call(&s, "ai.set_endpoint_key", json!({"key": "sk-super-secret"})).await;
        let body = resp.result.expect("a valid key must be stored");
        assert_eq!(body, json!({"stored": true}), "the stored key is never echoed back in the response");

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }
}
