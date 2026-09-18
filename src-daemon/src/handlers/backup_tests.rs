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

// ── backup_cancel (Task 4) ────────────────────────────────────────────────

#[tokio::test]
async fn cancelling_one_account_does_not_cancel_a_different_accounts_run() {
    let (_v, s) = st();
    let token_a = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let token_b = Arc::new(std::sync::atomic::AtomicBool::new(false));
    s.backup_runs.lock().unwrap().insert("acct-a".into(), token_a.clone());
    s.backup_runs.lock().unwrap().insert("acct-b".into(), token_b.clone());

    backup_cancel(&s, json!({"accountId": "acct-a"})).await.unwrap();

    assert!(token_a.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!token_b.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test]
async fn backup_cancel_on_an_unknown_account_is_a_tolerant_no_op() {
    let (_v, s) = st();
    // No entry for "ghost" at all -- must not error, matching the app-side
    // `backup_cancel` this replaces (always succeeds, cancel active or not).
    let result = backup_cancel(&s, json!({"accountId": "ghost"})).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), json!({}));
}

#[tokio::test]
async fn backup_cancel_rejects_missing_account_id() {
    let (_v, s) = st();
    let err = backup_cancel(&s, json!({})).await.unwrap_err();
    assert!(err.contains("accountId"), "{err}");
}

#[tokio::test]
async fn backup_cancel_via_route_returns_empty_object() {
    let (_v, s) = st();
    let r = call(&s, "backup_cancel", json!({"accountId": "acct1"})).await;
    assert_eq!(r.result.unwrap(), json!({}));
}

// ── BackupRunGuard panic-safety (Task 4) ─────────────────────────────────
//
// `backup_run_account` cannot easily be driven all the way through a panic
// in a unit test (the run itself dials IMAP/Graph). Exercised directly
// against a bare `BackupRunGuard` instead, same shape
// `handlers::archive`'s `guard_drops_when_the_task_holding_it_panics` uses
// for `RunGuard`: construct the guard, move it into a spawned task that
// panics, and assert the registry entry is gone once the task has finished
// unwinding -- proving the removal happens via `Drop`, not the (deleted)
// manual post-await removal this task replaced.

#[tokio::test(flavor = "multi_thread")]
async fn a_panicking_run_still_frees_its_backup_runs_entry() {
    let (_v, s) = st();
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    s.backup_runs.lock().unwrap().insert("acct-panics".into(), cancel.clone());
    let guard = BackupRunGuard { state: Arc::clone(&s), account_id: "acct-panics".into(), cancel: Arc::clone(&cancel) };

    let handle = tokio::spawn(async move {
        let _guard = guard;
        panic!("deliberate run-holder panic");
    });
    let joined = handle.await;

    assert!(joined.is_err(), "the spawned task must have panicked");
    assert!(!s.backup_runs.lock().unwrap().contains_key("acct-panics"), "a panicking run must not leak its backup_runs entry");
}

#[tokio::test]
async fn a_guards_drop_never_evicts_a_newer_runs_token_for_the_same_account() {
    let (_v, s) = st();
    let old_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let new_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    s.backup_runs.lock().unwrap().insert("acct1".into(), old_cancel.clone());
    let old_guard = BackupRunGuard { state: Arc::clone(&s), account_id: "acct1".into(), cancel: Arc::clone(&old_cancel) };

    // A fresh run for the same account replaces the map entry before the
    // old guard drops -- e.g. the old run took a while to unwind/finish.
    s.backup_runs.lock().unwrap().insert("acct1".into(), new_cancel.clone());
    drop(old_guard);

    let runs = s.backup_runs.lock().unwrap();
    assert!(runs.contains_key("acct1"), "the newer run's entry must survive the older guard's drop");
    assert!(Arc::ptr_eq(runs.get("acct1").unwrap(), &new_cancel));
}
