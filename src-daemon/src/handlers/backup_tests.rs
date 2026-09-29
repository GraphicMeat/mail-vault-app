use super::*;

#[test]
fn mailbox_concurrency_clamps_to_one_through_five() {
    assert_eq!(mailbox_concurrency(&json!({})), 1);
    assert_eq!(mailbox_concurrency(&json!({"mailboxConcurrency": 0})), 1);
    assert_eq!(mailbox_concurrency(&json!({"mailboxConcurrency": 3})), 3);
    assert_eq!(mailbox_concurrency(&json!({"mailboxConcurrency": 9})), 5);
}
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

// ── The daily download limit (a backup is background work) ────────────────

mod daily_limit {
    use super::*;
    use mock_imap::state::synthetic_mailbox;
    use mock_imap::{MockImap, Scenario};

    const NOON: i64 = 1_773_144_000_000; // 2026-03-10T12:00:00Z
    const MIB: u64 = 1024 * 1024;

    /// The next `backup-progress` frame with `active: false` on the bus.
    async fn terminal_frame(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Value {
        loop {
            let line = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
                .await
                .expect("the run never sent a terminal backup-progress frame")
                .unwrap();
            if let Some((name, payload)) = mailvault_core::daemon_ipc::parse_event(&line) {
                if name == "backup-progress" && payload["active"] == json!(false) {
                    return payload;
                }
            }
        }
    }

    fn account_json_for(server: &MockImap) -> String {
        json!({
            "email": "user@example.com", "password": "hunter2",
            "imapHost": server.host(), "imapPort": server.port(), "imapSecure": true,
        })
        .to_string()
    }

    fn stored(s: &Arc<DaemonState>) -> usize {
        let root = common::vault_root(s).unwrap();
        let cur = mailvault_core::vault_files::cur_path(&root, "acct1", "INBOX");
        std::fs::read_dir(cur).map(|d| d.flatten().count()).unwrap_or(0)
    }

    /// The whole wiring: the user's settings and the day's stats decide, the
    /// daemon's clock says which day it is, the terminal frame says why the
    /// run ended and when to come back, and after midnight the same call
    /// finishes the job.
    #[tokio::test]
    async fn a_backup_at_the_users_daily_limit_stops_with_limit_reached_and_finishes_after_midnight() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let (_v, s) = st();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 4)));
        s.clock.set(NOON);
        std::fs::write(
            s.app_dir.join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"transferLimits": {"acct1": {
                "capEnabled": true, "dailyDownLimitBytes": MIB,
            }}}}})
            .to_string(),
        )
        .unwrap();
        // The whole limit is spent on the UTC day the clock is stopped at.
        mailvault_core::app_db::with(&s.app_dir, |c| {
            mailvault_core::app_db::stats::add(c, "acct1", "2026-03-10", "daemon", MIB, 0)
        })
        .unwrap();
        let mut rx = s.events.subscribe();

        backup_run_account(&s, json!({"accountId": "acct1", "accountJson": account_json_for(&server)})).await.unwrap();
        let stopped = terminal_frame(&mut rx).await;

        assert_eq!(stopped["stop_reason"], json!("limit_reached"), "{stopped}");
        assert_eq!(stopped["limit_bytes"], json!(MIB));
        assert_eq!(stopped["resume_after_ms"], json!(NOON + 12 * 60 * 60 * 1000), "the next UTC midnight");
        assert_eq!(stopped["cancelled"], json!(true), "the app's checkpoint branch keys off it");
        assert!(stopped.get("last_error").map_or(true, |e| e.is_null()), "no English prose on the frame: {stopped}");
        assert_eq!(stored(&s), 0, "a spent day downloads nothing");

        // The clock crosses midnight; the scheduler runs the account again.
        s.clock.set(stopped["resume_after_ms"].as_i64().unwrap());
        backup_run_account(&s, json!({
            "accountId": "acct1", "accountJson": account_json_for(&server),
            "skipFolders": stopped["completed_folders"],
        }))
        .await
        .unwrap();
        let done = terminal_frame(&mut rx).await;

        assert!(done.get("stop_reason").is_none(), "{done}");
        assert_eq!(done["cancelled"], json!(false));
        assert_eq!(done["completed_emails"], json!(4));
        assert_eq!(stored(&s), 4);
    }

    /// Cap off: the same spent day changes nothing.
    #[tokio::test]
    async fn a_backup_with_the_cap_off_never_stops_for_the_limit() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let (_v, s) = st();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        s.clock.set(NOON);
        std::fs::write(
            s.app_dir.join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"transferLimits": {"acct1": {
                "capEnabled": false, "dailyDownLimitBytes": MIB,
            }}}}})
            .to_string(),
        )
        .unwrap();
        mailvault_core::app_db::with(&s.app_dir, |c| {
            mailvault_core::app_db::stats::add(c, "acct1", "2026-03-10", "daemon", 10 * MIB, 0)
        })
        .unwrap();
        let mut rx = s.events.subscribe();

        backup_run_account(&s, json!({"accountId": "acct1", "accountJson": account_json_for(&server)})).await.unwrap();
        let done = terminal_frame(&mut rx).await;

        assert!(done.get("stop_reason").is_none(), "{done}");
        assert_eq!(done["completed_emails"], json!(3));
    }
}

// ── backup_copy_uids (Archive, Back up & Delete) ──────────────────────────

/// One archived vault message, the way `archive_emails` names it.
fn seed_archived(vault: &std::path::Path, account: &str, mailbox: &str, uid: u32, id: &str) -> std::path::PathBuf {
    let cur = mailvault_core::vault_files::cur_path(vault, account, mailbox);
    std::fs::create_dir_all(&cur).unwrap();
    let path = cur.join(mailvault_core::vault_files::build_maildir_filename(uid, &["archived".to_string(), "seen".to_string()]));
    std::fs::write(&path, format!("Message-ID: <{id}>\r\nSubject: t\r\n\r\nbody {uid}")).unwrap();
    path
}

#[tokio::test]
async fn backup_copy_uids_copies_into_the_mirror_and_answers_the_outcome() {
    let (v, s) = st();
    let mirror = tempfile::tempdir().unwrap();
    let src = seed_archived(v.path(), "acct1", "INBOX", 7, "a@x");

    let r = call(
        &s,
        "backup_copy_uids",
        json!({"accountId": "acct1", "email": "me@x.test", "mailbox": "INBOX", "uids": [7, 8],
               "mirrorRoot": mirror.path().to_string_lossy()}),
    )
    .await;

    let out = r.result.expect("a reachable drive answers with an outcome");
    assert_eq!(out["copied"], json!([7]));
    assert_eq!(out["verified"], json!([7]));
    assert_eq!(out["missing"], json!([8]));
    assert_eq!(out["mismatched"], json!([]));
    assert_eq!(out["failed"], json!([]));
    let dst = mirror.path().join("me@x.test").join("INBOX").join("cur").join(src.file_name().unwrap());
    assert_eq!(std::fs::read(dst).unwrap(), std::fs::read(src).unwrap());
}

#[tokio::test]
async fn backup_copy_uids_without_a_resolved_mirror_is_an_error_not_an_empty_success() {
    let (v, s) = st();
    seed_archived(v.path(), "acct1", "INBOX", 7, "a@x");
    // The shell passes `mirrorRoot: null` when the bookmark did not resolve. Unlike
    // purge there is no queue for a copy: the caller must keep the mail on the server.
    let err = backup_copy_uids(
        &s,
        json!({"accountId": "acct1", "email": "me@x.test", "mailbox": "INBOX", "uids": [7], "mirrorRoot": null}),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Backup folder unavailable"), "{err}");
}

#[tokio::test]
async fn backup_copy_uids_names_the_missing_param() {
    let (_v, s) = st();
    let base = json!({"accountId": "acct1", "email": "me@x.test", "mailbox": "INBOX", "uids": [1], "mirrorRoot": "/x"});
    for key in ["accountId", "email", "mailbox", "uids"] {
        let mut p = base.clone();
        p.as_object_mut().unwrap().remove(key);
        let err = backup_copy_uids(&s, p).await.unwrap_err();
        assert!(err.contains(key), "{key}: {err}");
    }
}

#[tokio::test]
async fn backup_copy_uids_is_gated_while_the_vault_is_being_moved() {
    let (v, s) = st();
    let mirror = tempfile::tempdir().unwrap();
    seed_archived(v.path(), "acct1", "INBOX", 7, "a@x");
    s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
    let err = backup_copy_uids(
        &s,
        json!({"accountId": "acct1", "email": "me@x.test", "mailbox": "INBOX", "uids": [7],
               "mirrorRoot": mirror.path().to_string_lossy()}),
    )
    .await
    .unwrap_err();
    assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
    assert!(!mirror.path().join("me@x.test").exists(), "a gated call writes nothing");
}

#[tokio::test]
async fn backup_copy_uids_reaches_this_router_through_handle_request() {
    let (_v, s) = st();
    let resp = handle_request_for_test(&s, "backup_copy_uids", json!({})).await;
    let err = resp.error.expect("missing params is an error");
    assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "backup_copy_uids did not reach handlers::backup::route");
    assert!(err.message.contains("accountId"), "{}", err.message);
}

/// The copy is disk work on what may be a slow external drive: it must run on
/// the blocking pool, so a runtime worker keeps polling sockets while it does.
#[tokio::test(flavor = "current_thread")]
async fn backup_copy_uids_leaves_the_runtime_thread_free() {
    let (v, s) = st();
    let mirror = tempfile::tempdir().unwrap();
    for uid in 1..=40 {
        seed_archived(v.path(), "acct1", "INBOX", uid, &format!("m{uid}@x"));
    }
    let ticks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let t = ticks.clone();
    let ticker = tokio::spawn(async move {
        loop {
            t.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::task::yield_now().await;
        }
    });

    let uids: Vec<u32> = (1..=40).collect();
    let r = backup_copy_uids(
        &s,
        json!({"accountId": "acct1", "email": "me@x.test", "mailbox": "INBOX", "uids": uids,
               "mirrorRoot": mirror.path().to_string_lossy()}),
    )
    .await
    .unwrap();
    ticker.abort();

    assert_eq!(r["verified"].as_array().unwrap().len(), 40);
    assert!(
        ticks.load(std::sync::atomic::Ordering::SeqCst) > 1,
        "the runtime thread polled other tasks while the copy ran"
    );
}
