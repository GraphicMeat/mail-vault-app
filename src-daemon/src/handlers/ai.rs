//! AI provider RPCs (Phase 3b) — the one entry point every future AI feature
//! (Auto Tags, Quick Replies, AI Compose) calls through. The actual provider
//! logic lives in `llm.rs`; this layer only pulls RPC params apart and asks
//! `ai_gate` whether the mail may go to that provider.
use crate::ai_gate;
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

            // Every request that carries mail says whose (`accountIds`). A
            // cloud provider is refused unless it does, and unless none of
            // those accounts is a Google one. `noMailContent` is the explicit
            // way for a prompt that holds no mail at all (Settings' "send a
            // test") to say so; naming accounts as well still gets them checked.
            let declared = ai_gate::declared_account_ids(params);
            let no_mail = params.get("noMailContent").and_then(Value::as_bool).unwrap_or(false);
            if !(no_mail && declared.is_none()) {
                if let Err(refused) = ai_gate::check(&state.app_dir, &provider, declared.as_deref()).await {
                    tracing::info!("ai.generate refused: Gmail mail is only processed by on-device AI");
                    return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, refused));
                }
            }

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

    // ── Gmail mail only reaches on-device AI ────────────────────────────

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Where a refused cloud call would have gone when no LAN mock exists
    /// (TEST-NET-1, never routable): the refusal tests still prove the
    /// refusal; only the hit counter is lost.
    fn cloud_target() -> (String, Option<Arc<AtomicUsize>>) {
        match lan_mock() {
            Some((url, hits)) => (url, Some(hits)),
            None => ("http://192.0.2.1:9".to_string(), None),
        }
    }

    fn seed_accounts(s: &Arc<DaemonState>) {
        crate::ai_gate::test_support::seed_accounts(&s.app_dir);
    }

    fn lan_mock() -> Option<(String, Arc<AtomicUsize>)> {
        crate::ai_gate::test_support::lan_mock("ok")
    }

    fn require_lan_mock() -> (String, Arc<AtomicUsize>) {
        crate::ai_gate::test_support::require_lan_mock("ok")
    }

    fn generate_params(url: &str, account_ids: Option<Value>) -> Value {
        let mut params = json!({"provider": {"type": "endpoint", "url": url, "model": "m"}, "prompt": "hi"});
        if let Some(ids) = account_ids {
            params["accountIds"] = ids;
        }
        params
    }

    fn refused_with_the_gmail_code(resp: &RpcResponse) -> bool {
        resp.result.is_none() && resp.error.as_ref().is_some_and(|e| e.message.starts_with("E_GOOGLE_MAIL_ON_DEVICE_ONLY"))
    }

    fn hits(counter: &Option<Arc<AtomicUsize>>) -> usize {
        counter.as_ref().map_or(0, |c| c.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn a_cloud_endpoint_is_refused_for_a_google_account_and_nothing_is_sent() {
        let s = st();
        seed_accounts(&s);
        let (url, counter) = cloud_target();
        for ids in [json!(["g-oauth"]), json!(["g-imap"]), json!(["plain", "g-oauth"])] {
            let resp = call(&s, "ai.generate", generate_params(&url, Some(ids.clone()))).await;
            assert!(refused_with_the_gmail_code(&resp), "{ids}: {:?}", resp.error);
            assert!(resp.error.unwrap().message.contains("only processed by on-device AI"));
        }
        assert_eq!(hits(&counter), 0, "a refused request must never reach the endpoint");
    }

    #[tokio::test]
    async fn a_cloud_endpoint_still_serves_a_non_google_account() {
        let s = st();
        seed_accounts(&s);
        let (url, counter) = require_lan_mock();
        for ids in [json!(["plain"]), json!(["ms"]), json!(["plain", "ms"])] {
            let resp = call(&s, "ai.generate", generate_params(&url, Some(ids.clone()))).await;
            assert_eq!(resp.result.unwrap_or_else(|| panic!("{ids} failed")), json!({"text": "ok"}));
        }
        assert_eq!(counter.load(Ordering::SeqCst), 3, "every allowed request reached the endpoint");
    }

    #[tokio::test]
    async fn a_cloud_endpoint_is_refused_when_the_request_does_not_say_whose_mail_it_carries() {
        let s = st();
        seed_accounts(&s);
        let (url, counter) = cloud_target();
        for ids in [None, Some(json!([])), Some(json!("plain")), Some(json!([7])), Some(json!([""]))] {
            let resp = call(&s, "ai.generate", generate_params(&url, ids.clone())).await;
            assert!(refused_with_the_gmail_code(&resp), "{ids:?}: {:?}", resp.error);
        }
        assert_eq!(hits(&counter), 0);
    }

    #[tokio::test]
    async fn a_cloud_endpoint_is_refused_for_an_account_the_daemon_cannot_resolve() {
        let _guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let creds = dir.path().join("credentials.json");
        std::fs::write(&creds, "{}").unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);

        let s = st();
        seed_accounts(&s);
        let (url, counter) = cloud_target();
        let resp = call(&s, "ai.generate", generate_params(&url, Some(json!(["no-such-account"])))).await;
        assert!(refused_with_the_gmail_code(&resp), "{:?}", resp.error);
        let mixed = call(&s, "ai.generate", generate_params(&url, Some(json!(["plain", "no-such-account"])))).await;
        assert!(refused_with_the_gmail_code(&mixed), "one unknown account taints the request");
        assert_eq!(hits(&counter), 0);

        // With no accounts.json at all every account is unknown.
        std::fs::remove_file(s.app_dir.join("accounts.json")).unwrap();
        let resp = call(&s, "ai.generate", generate_params(&url, Some(json!(["plain"])))).await;
        assert!(refused_with_the_gmail_code(&resp), "{:?}", resp.error);

        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }

    #[tokio::test]
    async fn an_account_only_the_keychain_knows_is_judged_by_its_stored_record() {
        let _guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let creds = dir.path().join("credentials.json");
        let blob = json!({
            "kc-google": json!({"id": "kc-google", "authType": "oauth2", "oauth2Provider": "google"}).to_string(),
            "kc-plain": json!({"id": "kc-plain", "authType": "password", "imapHost": "imap.fastmail.com"}).to_string(),
        });
        std::fs::write(&creds, blob.to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);

        let s = st(); // no accounts.json: only the keychain lists these
        let (url, counter) = cloud_target();
        let resp = call(&s, "ai.generate", generate_params(&url, Some(json!(["kc-google"])))).await;
        assert!(refused_with_the_gmail_code(&resp), "{:?}", resp.error);
        assert_eq!(hits(&counter), 0);
        let (url, counter) = require_lan_mock();
        let ok = call(&s, "ai.generate", generate_params(&url, Some(json!(["kc-plain"])))).await;
        assert!(ok.result.is_some(), "{:?}", ok.error);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }

    #[tokio::test]
    async fn a_loopback_endpoint_serves_a_google_account() {
        let s = st();
        seed_accounts(&s);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
        let hit = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&hit);
        std::thread::spawn(move || {
            if let Some(Ok(mut stream)) = listener.incoming().next() {
                counted.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let body = json!({"choices": [{"message": {"content": "local"}}]}).to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let resp = call(&s, "ai.generate", generate_params(&url, Some(json!(["g-oauth", "g-imap"])))).await;
        assert_eq!(resp.result.expect("on this computer, so allowed"), json!({"text": "local"}));
        assert_eq!(hit.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_on_device_providers_never_ask_which_accounts() {
        let s = st();
        seed_accounts(&s);
        // Reaches the engine (and fails there for want of a model), not the gate.
        for provider in [json!({"type": "localGguf"})] {
            let resp = call(&s, "ai.generate", json!({"provider": provider, "prompt": "hi", "accountIds": ["g-oauth"]})).await;
            assert!(!refused_with_the_gmail_code(&resp));
            assert!(resp.error.unwrap().message.contains("No model loaded"));
        }
    }

    #[tokio::test]
    async fn a_prompt_that_declares_it_holds_no_mail_may_go_to_a_cloud_endpoint() {
        let s = st();
        seed_accounts(&s);
        let (url, counter) = require_lan_mock();
        let mut params = generate_params(&url, None);
        params["noMailContent"] = json!(true);
        let resp = call(&s, "ai.generate", params).await;
        assert!(resp.result.is_some(), "{:?}", resp.error);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Naming a Google account as well still gets it refused.
        let hits_before = counter.load(Ordering::SeqCst);
        let mut params = generate_params(&url, Some(json!(["g-oauth"])));
        params["noMailContent"] = json!(true);
        let resp = call(&s, "ai.generate", params).await;
        assert!(refused_with_the_gmail_code(&resp));
        assert_eq!(counter.load(Ordering::SeqCst), hits_before);
    }
}
