//! Daemon routes for restore (Task 4.7), backed by `crate::restore`, moved
//! from `src-tauri/src/restore.rs`. **No cutover in this task**: the Tauri
//! commands in `commands.rs` are untouched and still serve the frontend; this
//! router exists but nothing calls it yet. Task 4.8 deletes them and switches
//! the frontend to `daemon_rpc`.
//!
//! Cancel token is a `DaemonState.run_tokens` entry under kind "restore"
//! (decision 7, `common::RunGuard::register`, cancel-only like archive) --
//! replaces the app's single-slot `RestoreCancelToken`.
//!
//! `count_local_folder` is read-only (decision, verified against the original
//! `restore.rs`: `list_local_messages` only ever calls `std::fs::read_dir`) --
//! a plain `common::vault_root` check inside `restore::list_local_messages`,
//! no write gate.

use crate::handlers::common::{blocking, cancel_kind, str_arg, vec_arg, RunGuard};
use crate::ipc::{self, RpcResponse};
use crate::restore;
use crate::server::DaemonState;
use mailvault_core::imap::ImapConfig;
use serde_json::Value;
use std::sync::Arc;

fn mailbox_concurrency(params: &Value) -> usize {
    params.get("mailboxConcurrency").and_then(Value::as_u64).unwrap_or(1).clamp(1, 5) as usize
}

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "start_restore" => {
            let account = req!(str_arg(&id, params, "account"));
            let account_id = req!(str_arg(&id, params, "accountId"));
            let folders = req!(vec_arg::<String>(&id, params, "folders"));
            let mailbox_concurrency = mailbox_concurrency(params);
            let config: ImapConfig = match serde_json::from_str(&account) {
                Ok(c) => c,
                Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Bad account JSON: {e}"))),
            };

            let guard = RunGuard::register(state, "restore");
            let cancel = guard.cancel();
            let state = Arc::clone(state);
            tokio::spawn(async move {
                let _guard = guard;
                if let Err(e) = restore::run_restore(state, config, account_id, folders, cancel, mailbox_concurrency).await {
                    tracing::error!("[restore] run_restore failed: {}", e);
                }
            });
            RpcResponse::success(id, Value::Null)
        }
        "cancel_restore" => RpcResponse::success(id, serde_json::json!({"cancelled": cancel_kind(state, "restore")})),
        "count_local_folder" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            let result = blocking(move || restore::list_local_messages(&state, &account_id, &mailbox).map(|v| v.len()))
                .await
                .and_then(|r| r);
            match result {
                Ok(n) => RpcResponse::success(id, serde_json::json!(n)),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mailvault_core::vault_files;
    use mock_imap::state::synthetic_mailbox;
    use mock_imap::{MockImap, Scenario};
    use serde_json::json;
    use std::time::Duration;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), mail_dir_ok);
        (vault, app_dir, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn account_json(server: &MockImap, email: &str) -> String {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        json!({
            "email": email,
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
            "imapSecure": true,
        })
        .to_string()
    }

    /// Seed `n` local `.eml` files under the vault's INBOX `cur/` dir for
    /// `account_id`, in the same maildir shape `restore::list_local_messages`
    /// reads (uid:2,FLAGS.eml).
    fn seed_local_messages(vault_root: &std::path::Path, account_id: &str, mailbox: &str, n: u32) {
        let cur = vault_files::cur_path(vault_root, account_id, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        for uid in 1..=n {
            let name = vault_files::build_maildir_filename(uid, &[] as &[String]);
            let body = format!(
                "From: sender@example.com\r\nTo: user@example.com\r\nSubject: local {uid}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMessage-ID: <local-{uid}@example.com>\r\n\r\nbody {uid}\r\n"
            );
            std::fs::write(cur.join(name), body).unwrap();
        }
    }

    // ── Routing / params ─────────────────────────────────────────────────

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, _a, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn start_restore_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(&s, "start_restore", json!({})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "start_restore did not reach handlers::restore::route");
    }

    #[tokio::test]
    async fn start_restore_missing_folders_is_invalid_params() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "start_restore", json!({"account": "{}", "accountId": "a1"})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    // ── count_local_folder: read-only, matches list_local_messages ──────────

    #[tokio::test]
    async fn count_local_folder_matches_the_number_of_seeded_messages() {
        let (v, _a, s) = st(true);
        seed_local_messages(v.path(), "acct1", "INBOX", 3);

        let resp = call(&s, "count_local_folder", json!({"accountId": "acct1", "mailbox": "INBOX"})).await;
        assert_eq!(resp.result.unwrap(), json!(3));
    }

    #[tokio::test]
    async fn count_local_folder_is_gated_while_the_vault_is_being_moved() {
        let (_v, _a, s) = st(true);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let resp = call(&s, "count_local_folder", json!({"accountId": "acct1", "mailbox": "INBOX"})).await;
        let err = resp.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
    }

    // ── A real restore over the mock IMAP server ─────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn a_restore_reuploads_local_messages_and_emits_progress() {
        let (v, _a, s) = st(true);
        seed_local_messages(v.path(), "acct1", "INBOX", 2);

        let dest = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));
        let mut rx = s.events.subscribe();

        let resp = call(
            &s,
            "start_restore",
            json!({
                "account": account_json(&dest, "restore-dest@example.com"),
                "accountId": "acct1",
                "folders": ["INBOX"],
            }),
        )
        .await;
        assert!(resp.error.is_none(), "start_restore must succeed: {:?}", resp.error);

        let uploaded = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let line = rx.recv().await.expect("bus closed");
                if line.contains("restore-progress") && line.contains("\"completed\"") {
                    let parsed: Value = serde_json::from_str(&line).unwrap();
                    return parsed["params"]["payload"]["uploaded_emails"].as_u64();
                }
            }
        })
        .await
        .expect("restore-progress never reported completed");
        // Both seeded messages must actually upload, not just that a
        // "completed" frame arrived -- a real server rejection (e.g. a
        // malformed flag string) would still reach "completed" with
        // failed_emails: 2 and uploaded_emails: 0, which this catches.
        assert_eq!(uploaded, Some(2), "both seeded messages must upload");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_restore_mid_run_stops_it() {
        let (v, _a, s) = st(true);
        seed_local_messages(v.path(), "acct2", "INBOX", 25);
        // A 300ms delay on every APPEND gives cancel_restore a reliable
        // window to land mid-run instead of racing a fast local mock server
        // to completion before the cancel RPC even arrives.
        let dest = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 0))
                .fault(mock_imap::Trigger::on("APPEND"), mock_imap::Action::Delay(Duration::from_millis(300))),
        );
        let mut rx = s.events.subscribe();

        call(
            &s,
            "start_restore",
            json!({
                "account": account_json(&dest, "cancel-dest@example.com"),
                "accountId": "acct2",
                "folders": ["INBOX"],
            }),
        )
        .await;

        let cancel_resp = call(&s, "cancel_restore", json!({})).await;
        assert_eq!(cancel_resp.result.unwrap()["cancelled"], json!(1));

        // Wait for the run's own "cancelled" progress frame (run_restore
        // emits it and returns as soon as it next checks the flag) and read
        // uploaded_emails off it: proof the run stopped well short of all 25,
        // not just that it eventually finished.
        let uploaded = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let line = rx.recv().await.expect("bus closed");
                if line.contains("restore-progress") && line.contains("\"cancelled\"") {
                    let parsed: Value = serde_json::from_str(&line).unwrap();
                    return parsed["params"]["payload"]["uploaded_emails"].as_u64();
                }
            }
        })
        .await
        .expect("cancel_restore never produced a cancelled progress frame");

        assert!(uploaded.is_some(), "cancelled frame must carry a count");
        assert!(uploaded.unwrap() < 25, "cancel must stop the run before all 25 messages upload, got {uploaded:?}");
    }
}
    #[test]
    fn mailbox_concurrency_clamps_to_one_through_five() {
        assert_eq!(mailbox_concurrency(&serde_json::json!({})), 1);
        assert_eq!(mailbox_concurrency(&serde_json::json!({"mailboxConcurrency": 0})), 1);
        assert_eq!(mailbox_concurrency(&serde_json::json!({"mailboxConcurrency": 3})), 3);
        assert_eq!(mailbox_concurrency(&serde_json::json!({"mailboxConcurrency": 9})), 5);
    }
