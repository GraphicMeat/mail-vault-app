//! Daemon RPC routes for OAuth2 (Task 5.7), plan
//! `docs/superpowers/plans/2026-09-17-daemon-shell-phase5-network.md`.
//!
//! Naming deviation from the plan text (same convention as Tasks
//! 5.4a/5.4b/5.5/5.6, ledgered in `docs/superpowers/ledgers/
//! 2026-09-17-daemon-shell-phase5/progress.md`): flat `oauth2_*` names, not
//! `oauth2.*` — their Tauri twins are deleted in this same task, so these
//! belong in `transport.js`'s `DAEMON_OWNED` with no rename layer and no
//! Tauri fallback.
//!
//! Ported verbatim from `src-tauri/src/commands.rs` against
//! `mailvault_core::oauth2::OAuth2Manager`, same request/response JSON.
//! Unlike `GraphClient` (stateless, one per call), `OAuth2Manager` is
//! constructed ONCE in `DaemonState` (`state.oauth2`, same pattern as
//! `state.imap_pool`) — its `pending`/`senders` maps must survive between an
//! `oauth2_auth_url` call and the `oauth2_exchange` call that later redeems
//! the same `state` token, and its `ensure_callback_server` must only ever
//! bind `127.0.0.1:19876` once per process. A per-call `OAuth2Manager::new()`
//! here would silently break every OAuth flow (each call would see an empty
//! `pending` map).
//!
//! `generate_auth_url`'s first call binds the loopback TCP listener
//! (`127.0.0.1:19876`, `oauth2.rs`'s `CALLBACK_PORT`) from inside the daemon
//! process now, not the app's — this is the one part of Task 5.7 that is
//! UNVERIFIED under a signed sandboxed build (`com.apple.security.
//! network.server` was already added to `src-daemon/entitlements.plist` in
//! Task 5.1, but whether a spawned, sandboxed child can actually bind a
//! listening socket under inheritance has never been tested; P0.1 only
//! proved file-access and SCM_RIGHTS inheritance). See the probe script
//! (`scripts/probe-oauth2-loopback.py`) and the ledger.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "oauth2_auth_url" => {
            let email = params.get("email").and_then(Value::as_str).map(str::to_owned);
            let provider = params.get("provider").and_then(Value::as_str).map(str::to_owned);
            let custom_client_id = params.get("customClientId").and_then(Value::as_str).map(str::to_owned);
            let tenant_id = params.get("tenantId").and_then(Value::as_str).map(str::to_owned);
            let use_graph = params.get("useGraph").and_then(Value::as_bool).unwrap_or(false);

            match state.oauth2.generate_auth_url(email, provider, custom_client_id, tenant_id, use_graph).await {
                Ok(result) => RpcResponse::success(
                    id,
                    json!({"success": true, "authUrl": result.auth_url, "state": result.state}),
                ),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "oauth2_exchange" => {
            let oauth_state = match params.get("state").and_then(Value::as_str) {
                Some(s) => s,
                None => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing state")),
            };
            match state.oauth2.exchange_code(oauth_state).await {
                Ok(result) => RpcResponse::success(
                    id,
                    json!({
                        "success": true,
                        "accessToken": result.access_token,
                        "refreshToken": result.refresh_token,
                        "expiresAt": result.expires_at,
                    }),
                ),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "oauth2_refresh" => {
            let refresh_token = match params.get("refreshToken").and_then(Value::as_str) {
                Some(s) => s,
                None => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing refreshToken")),
            };
            let provider = params.get("provider").and_then(Value::as_str).map(str::to_owned);
            let custom_client_id = params.get("customClientId").and_then(Value::as_str).map(str::to_owned);
            let tenant_id = params.get("tenantId").and_then(Value::as_str).map(str::to_owned);
            let use_graph = params.get("useGraph").and_then(Value::as_bool).unwrap_or(false);

            match state.oauth2.refresh_token(refresh_token, provider, custom_client_id, tenant_id, use_graph).await {
                Ok(result) => RpcResponse::success(
                    id,
                    json!({
                        "success": true,
                        "accessToken": result.access_token,
                        "refreshToken": result.refresh_token,
                        "expiresAt": result.expires_at,
                    }),
                ),
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
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Mutex, OnceLock};

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-oauth2-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    // `refresh_token` posts straight to `mailvault_core::oauth2`'s per-provider
    // token endpoint. Plan requirement: "no live Microsoft/Google call" — this
    // module points it at a one-shot local mock instead, using the
    // MAILVAULT_MS_TOKEN_ENDPOINT / MAILVAULT_GOOGLE_TOKEN_ENDPOINT loopback
    // override added alongside this task (same safety rule as GraphClient's
    // MAILVAULT_GRAPH_BASE, Task 5.6: debug-only, loopback-http only). One
    // listener serves both providers' env vars, same as graph.rs's tests
    // sharing one `MAILVAULT_GRAPH_BASE` mock; `TEST_LOCK` serializes this
    // module's tests over the shared response queue.
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    static QUEUE: Mutex<std::collections::VecDeque<(u16, String)>> = Mutex::new(std::collections::VecDeque::new());

    fn mock_server_port() -> u16 {
        static PORT: OnceLock<u16> = OnceLock::new();
        *PORT.get_or_init(|| {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock oauth2 token server");
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    handle_conn(stream);
                }
            });
            let base = format!("http://127.0.0.1:{port}");
            std::env::set_var("MAILVAULT_MS_TOKEN_ENDPOINT", &base);
            std::env::set_var("MAILVAULT_GOOGLE_TOKEN_ENDPOINT", &base);
            port
        })
    }

    fn handle_conn(mut stream: TcpStream) {
        let mut buf = [0u8; 8192];
        let _ = stream.read(&mut buf);
        let (status, body) = QUEUE.lock().unwrap().pop_front().unwrap_or((500, "no response queued".into()));
        let reason = if (200..300).contains(&status) { "OK" } else { "Mock Error" };
        let resp = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
    }

    /// Queue the mock's next response and return a guard held for the whole
    /// test, serializing against every other test in this module (the token
    /// endpoint override is a process-wide env var, like graph.rs's).
    fn mock_token_response(status: u16, body: &str) -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        mock_server_port();
        QUEUE.lock().unwrap().push_back((status, body.to_string()));
        guard
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    // These are RPC-shape/argument-marshaling tests only, per the plan
    // ("Do NOT test the actual loopback socket binding in a unit test — that
    // is what the probe script is for"). `generate_auth_url` builds the URL
    // and registers the pending flow entirely in-process — it does not
    // require the callback HTTP server to have accepted a connection, only
    // that `ensure_callback_server` was able to spawn the bind attempt. A
    // real bind failure (port already in use) surfaces as a background task
    // error/log, not as an `Err` returned to this call, so these tests never
    // depend on port 19876 actually being free.

    #[tokio::test]
    async fn auth_url_returns_a_url_and_a_state_token_no_provider_given_defaults_to_microsoft() {
        let s = st();
        let resp = call(&s, "oauth2_auth_url", json!({})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        let auth_url = result["authUrl"].as_str().expect("authUrl present");
        assert!(auth_url.starts_with("https://login.microsoftonline.com/"), "{auth_url}");
        assert!(!result["state"].as_str().expect("state present").is_empty());
    }

    #[tokio::test]
    async fn auth_url_honours_an_explicit_google_provider() {
        let s = st();
        let resp = call(&s, "oauth2_auth_url", json!({"provider": "google"})).await;
        let result = resp.result.expect("success");
        let auth_url = result["authUrl"].as_str().expect("authUrl present");
        assert!(auth_url.starts_with("https://accounts.google.com/"), "{auth_url}");
    }

    #[tokio::test]
    async fn auth_url_rejects_an_unknown_provider() {
        let s = st();
        let resp = call(&s, "oauth2_auth_url", json!({"provider": "not-a-real-provider"})).await;
        assert!(resp.result.is_none(), "an unknown provider must not succeed");
    }

    #[tokio::test]
    async fn exchange_with_no_pending_flow_for_that_state_is_an_error_not_a_panic() {
        let s = st();
        let resp = call(&s, "oauth2_exchange", json!({"state": "never-issued"})).await;
        assert!(resp.result.is_none(), "exchanging an unknown state must fail");
    }

    #[tokio::test]
    async fn exchange_reuses_the_state_generate_auth_url_issued() {
        let s = st();
        let auth_resp = call(&s, "oauth2_auth_url", json!({})).await;
        let issued_state = auth_resp.result.expect("success")["state"].as_str().unwrap().to_string();

        // No callback has landed, so this call blocks on the pending
        // oneshot — exercise it with a short timeout instead of awaiting it
        // forever; the point of this test is that the pending flow was
        // actually registered under `issued_state` (an unknown state fails
        // immediately, per the previous test), not that a code arrives.
        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            call(&s, "oauth2_exchange", json!({"state": issued_state})),
        )
        .await;
        assert!(outcome.is_err(), "no callback has landed yet, so exchange must still be waiting, not already failed");
    }

    #[tokio::test]
    async fn exchange_missing_state_param_is_invalid_params() {
        let s = st();
        let resp = call(&s, "oauth2_exchange", json!({})).await;
        assert_eq!(resp.error.map(|e| e.code), Some(ipc::INVALID_PARAMS));
    }

    #[tokio::test]
    async fn refresh_missing_refresh_token_is_invalid_params() {
        let s = st();
        let resp = call(&s, "oauth2_refresh", json!({})).await;
        assert_eq!(resp.error.map(|e| e.code), Some(ipc::INVALID_PARAMS));
    }

    #[tokio::test]
    async fn refresh_against_a_mocked_provider_returns_the_new_tokens() {
        let _g = mock_token_response(
            200,
            r#"{"access_token":"new-access-token","refresh_token":"new-refresh-token","expires_in":3600}"#,
        );
        let s = st();
        let resp = call(
            &s,
            "oauth2_refresh",
            json!({"refreshToken": "old-refresh-token", "provider": "microsoft"}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["accessToken"], json!("new-access-token"));
        assert_eq!(result["refreshToken"], json!("new-refresh-token"));
        assert!(result["expiresAt"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn refresh_surfaces_a_mocked_provider_error_cleanly() {
        let _g = mock_token_response(
            400,
            r#"{"error":"invalid_grant","error_description":"Token expired"}"#,
        );
        let s = st();
        let resp = call(
            &s,
            "oauth2_refresh",
            json!({"refreshToken": "expired-refresh-token", "provider": "google"}),
        )
        .await;
        assert!(resp.result.is_none(), "a provider-reported invalid_grant must not report success");
        let msg = resp.error.expect("error").message;
        assert!(msg.contains("Token expired"), "{msg}");
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st();
        assert!(route(&s, "imap_get_mailboxes", &json!({}), json!(1)).await.is_none());
    }
}
