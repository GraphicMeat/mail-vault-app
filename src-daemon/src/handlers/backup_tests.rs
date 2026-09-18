use super::*;
use crate::server::handle_request_for_test;
use serde_json::json;

// `test_daemon_state()`/`test_account_json()` (named in the plan brief) don't
// exist anywhere in this tree — no `handlers/*_tests.rs` file existed before
// this one either. Local helpers here follow `handlers/archive.rs`'s own
// `st()`/`account_json_for()` pattern instead.

fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
    let vault = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap().keep();
    let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, true);
    (vault, s)
}

/// Enough for `ImapConfig`'s two required fields (`email`, `imapHost`) to
/// deserialize. Never actually dialled in these tests — `backup_run_account`
/// must return before the spawned run gets anywhere near a socket.
fn account_json() -> String {
    json!({"email": "user@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string()
}

async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
    route(s, method, &params, json!(1)).await.expect("routed")
}

// ── RPC shape: fire-and-forget ──────────────────────────────────────────

#[tokio::test]
async fn backup_run_account_returns_immediately_with_a_run_id() {
    let (_v, s) = st();
    let params = json!({"accountId": "acct1", "accountJson": account_json(), "mirrorRoot": null});

    let start = std::time::Instant::now();
    let result = backup_run_account(&s, params).await.unwrap();

    assert!(start.elapsed() < std::time::Duration::from_millis(200), "must not block on the run itself");
    assert_eq!(result.get("runId"), Some(&json!("acct1")));
}

#[tokio::test]
async fn backup_run_account_registers_a_cancel_token_before_returning() {
    let (_v, s) = st();
    let params = json!({"accountId": "acct-reg", "accountJson": account_json(), "mirrorRoot": null});

    backup_run_account(&s, params).await.unwrap();

    assert!(
        s.backup_runs.lock().unwrap().contains_key("acct-reg"),
        "the run's cancel token must be registered synchronously, not from inside the spawned task"
    );
}

#[tokio::test]
async fn backup_run_account_rejects_missing_account_id() {
    let (_v, s) = st();
    let err = backup_run_account(&s, json!({"accountJson": account_json()})).await.unwrap_err();
    assert!(err.contains("accountId"), "{err}");
}

#[tokio::test]
async fn backup_run_account_rejects_bad_account_json() {
    let (_v, s) = st();
    let err = backup_run_account(&s, json!({"accountId": "acct1", "accountJson": "not json"})).await.unwrap_err();
    assert!(err.contains("Bad account JSON"), "{err}");
}

// ── Gating: same posture as archive_emails ──────────────────────────────

#[tokio::test]
async fn backup_run_account_is_gated_while_the_vault_is_being_moved() {
    let (_v, s) = st();
    s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
    let err = backup_run_account(&s, json!({"accountId": "acct1", "accountJson": account_json()})).await.unwrap_err();
    assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
    assert!(!s.backup_runs.lock().unwrap().contains_key("acct1"), "a gated call must not register a token it never runs");
}

// ── Routing ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn backup_run_account_reaches_this_router_through_handle_request() {
    let (_v, s) = st();
    // Bad JSON, same probe `archive_emails_reaches_this_router_through_handle_request`
    // uses: proves the request reached this module's own parse error rather
    // than falling through to "unknown method".
    let resp =
        handle_request_for_test(&s, "backup_run_account", json!({"accountId": "acct1", "accountJson": "not json"})).await;
    let err = resp.error.expect("must be an error");
    assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "backup_run_account did not reach handlers::backup::route");
    assert!(err.message.contains("Bad account JSON"), "{}", err.message);
}

#[tokio::test]
async fn another_domains_method_is_not_routed_here() {
    let (_v, s) = st();
    assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
}

#[tokio::test]
async fn backup_run_account_via_route_returns_the_run_id() {
    let (_v, s) = st();
    let r = call(&s, "backup_run_account", json!({"accountId": "acct1", "accountJson": account_json()})).await;
    assert_eq!(r.result.unwrap(), json!({"runId": "acct1"}));
}
