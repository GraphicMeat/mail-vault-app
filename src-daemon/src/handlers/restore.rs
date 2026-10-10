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

/// Refuse an `accountId` that is not one plain path component before it
/// reaches the vault (`vault_files::account_dir` would neutralise it anyway;
/// this is the boundary check).
fn plain_account_id(id: &Value, account_id: String) -> Result<String, RpcResponse> {
    if mailvault_core::vault_files::is_plain_account_id(&account_id) {
        Ok(account_id)
    } else {
        Err(RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Invalid accountId: {account_id:?}")))
    }
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
            let account_id = req!(str_arg(&id, params, "accountId").and_then(|a| plain_account_id(&id, a)));
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
            let account_id = req!(str_arg(&id, params, "accountId").and_then(|a| plain_account_id(&id, a)));
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

    /// A traversal `accountId` is refused, and a maildir seeded where the
    /// traversal resolves (`{root}/outside/INBOX/cur`) is never counted.
    #[tokio::test]
    async fn count_local_folder_refuses_an_account_id_that_escapes_the_vault() {
        let (v, _a, s) = st(true);
        let escaped = v.path().join("Maildir").join("../outside").join("INBOX").join("cur");
        std::fs::create_dir_all(&escaped).unwrap();
        std::fs::write(escaped.join(vault_files::build_maildir_filename(1, &[] as &[String])), b"x").unwrap();

        let resp = call(&s, "count_local_folder", json!({"accountId": "../outside", "mailbox": "INBOX"})).await;
        assert!(resp.error.is_some(), "a traversal accountId must be refused, got {:?}", resp.result);
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn start_restore_refuses_an_account_id_that_escapes_the_vault() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "start_restore", json!({"account": json!({"email": "x@example.com", "imapHost": "127.0.0.1"}).to_string(), "accountId": "../outside", "folders": ["INBOX"]})).await;
        assert_eq!(resp.error.expect("a traversal accountId must be refused").code, ipc::INVALID_PARAMS);
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

    // ── A JMAP destination (`import_raw`, Task 9b) ───────────────────────

    use crate::jmap_test_support as support;
    use mock_jmap::{Fault, MockJmap, ScenarioEmail};

    /// One dated local message per entry of `letters` under the vault's
    /// `mailbox` for `account_id`: uid i + 1 named `{uid}:2,{letters[i]}`,
    /// Message-ID `<local-{uid}@x>`. Their bytes, in uid order.
    fn seed_lettered(vault_root: &std::path::Path, account_id: &str, mailbox: &str, letters: &[&str]) -> Vec<Vec<u8>> {
        let cur = vault_files::cur_path(vault_root, account_id, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        letters
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let uid = i as u32 + 1;
                let body = support::raw(&format!("local-{uid}"), &format!("local {uid}")).into_bytes();
                std::fs::write(cur.join(format!("{uid}{}{l}.eml", mailvault_core::maildir::INFO_PREFIX)), &body).unwrap();
                body
            })
            .collect()
    }

    /// `start_restore` of `folders` into `account`, and the payload of its
    /// last `restore-progress` frame (status no longer "running").
    async fn restore_into(s: &Arc<DaemonState>, account: &Value, folders: &[&str]) -> Value {
        let mut rx = s.events.subscribe();
        let resp = call(s, "start_restore", json!({"account": account.to_string(), "accountId": "acct1", "folders": folders})).await;
        assert!(resp.error.is_none(), "start_restore must succeed: {:?}", resp.error);
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let line = rx.recv().await.expect("bus closed");
                if let Some((name, payload)) = mailvault_core::daemon_ipc::parse_event(&line) {
                    if name == "restore-progress" && payload["status"] != json!("running") {
                        return payload;
                    }
                }
            }
        })
        .await
        .expect("restore-progress never finished")
    }

    /// (uploaded, skipped, failed) off a progress payload.
    fn counts(p: &Value) -> (u64, u64, u64) {
        (p["uploaded_emails"].as_u64().unwrap(), p["skipped_emails"].as_u64().unwrap(), p["failed_emails"].as_u64().unwrap())
    }

    /// The restored copies in a mailbox: the server's emails with a `local-` id.
    fn restored(m: &MockJmap, mailbox_id: &str) -> Vec<support::Stored> {
        support::emails_in(m, mailbox_id).into_iter().filter(|e| e.raw.contains("<local-")).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_restore_creates_each_message_with_its_keywords() {
        let (v, _a, s) = st(true);
        let m = MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let raws = seed_lettered(v.path(), "acct1", "INBOX", &["S", "FS"]);

        let done = restore_into(&s, &support::account_json(&m, port), &["INBOX"]).await;

        assert_eq!(done["status"], json!("completed"), "{done}");
        assert_eq!(counts(&done), (2, 0, 0), "{done}");
        let inbox = restored(&m, "mb-inbox");
        assert_eq!(inbox.len(), 2);
        let keywords_of = |raw: &[u8]| inbox.iter().find(|e| e.raw.as_bytes() == raw).expect("restored byte for byte").keywords.clone();
        assert_eq!(keywords_of(&raws[0]), support::set(&["$seen"]));
        assert_eq!(keywords_of(&raws[1]), support::set(&["$flagged", "$seen"]));
        assert!(inbox.iter().all(|e| e.received_at == "2019-03-05T08:15:00Z"), "the Date header is the receivedAt: {inbox:?}");
        assert!(trap.accept().is_err(), "a JMAP restore never dials IMAP");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_restore_into_a_missing_mailbox_makes_it() {
        let (v, _a, s) = st(true);
        let m = MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        seed_lettered(v.path(), "acct1", "Archive/2019", &["S"]);

        let done = restore_into(&s, &support::account_json(&m, port), &["Archive/2019"]).await;

        assert_eq!(counts(&done), (1, 0, 0), "{done}");
        let made = support::mailbox_named(&m, Some("Archive"), "2019").expect("Archive/2019 made on the server");
        assert_eq!(restored(&m, &made).len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_restore_counts_a_repaired_import_once_and_a_rerun_imports_nothing() {
        let (v, _a, s) = st(true);
        let mut scenario = support::scenario();
        scenario.faults.push(Fault::ImportRepairs);
        let m = MockJmap::start(scenario);
        let (_trap, port) = support::imap_trap();
        let account = support::account_json(&m, port);
        seed_lettered(v.path(), "acct1", "INBOX", &["S", ""]);

        let first = restore_into(&s, &account, &["INBOX"]).await;
        assert_eq!(counts(&first), (2, 0, 0), "a repaired import is an import: {first}");
        let imports = m.count_calls("Email/import");
        assert_eq!(imports, 2);

        let second = restore_into(&s, &account, &["INBOX"]).await;
        assert_eq!(counts(&second), (0, 2, 0), "found by Message-ID: {second}");
        assert_eq!(m.count_calls("Email/import"), imports, "the rerun imports nothing");
        assert_eq!(restored(&m, "mb-inbox").len(), 2, "no duplicates");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_restore_counts_a_server_dedupe_as_present() {
        let (v, _a, s) = st(true);
        let mut scenario = support::scenario();
        scenario.faults.push(Fault::ImportAlreadyExists);
        // The same Message-ID already sits in Work: the INBOX lookup misses
        // it, and the server's own dedupe answers the import.
        scenario.accounts[0].mailboxes[1].emails.push(ScenarioEmail {
            id: "w1".into(),
            raw: support::raw("local-1", "local 1"),
            keywords: vec![],
            received_at: "2026-10-03T10:00:00Z".into(),
            also_in: vec![],
        });
        let m = MockJmap::start(scenario);
        let (_trap, port) = support::imap_trap();
        seed_lettered(v.path(), "acct1", "INBOX", &["S"]);

        let done = restore_into(&s, &support::account_json(&m, port), &["INBOX"]).await;

        assert_eq!(counts(&done), (0, 1, 0), "present, never failed: {done}");
        assert_eq!(m.count_calls("Email/import"), 1, "the server was asked and said alreadyExists");
        assert!(restored(&m, "mb-inbox").is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_restored_messages_are_never_announced_as_arrivals() {
        let (v, _a, s) = st(true);
        let m = MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        let account = support::account_json(&m, port);
        let sync_account: crate::sync_engine::SyncAccount =
            serde_json::from_value(json!({"id": "acct1", "email": "alice@example.test", "imapConfig": account})).unwrap();
        seed_lettered(v.path(), "acct1", "INBOX", &["S", ""]);
        let cold = s.sync_engine.sync_account(&sync_account, "INBOX").await;
        assert!(cold.success, "{:?}", cold.error);
        let gen0 = s.sync_engine.change_gen();

        let done = restore_into(&s, &account, &["INBOX"]).await;
        assert_eq!(counts(&done), (2, 0, 0), "{done}");
        let ids: Vec<String> = restored(&m, "mb-inbox").into_iter().map(|e| e.id).collect();
        let config: ImapConfig = serde_json::from_value(account.clone()).unwrap();
        assert!(ids.iter().all(|id| s.jmap.is_own(&config, id)), "every import is recorded as the daemon's own");

        let r = s.sync_engine.sync_account(&sync_account, "INBOX").await;
        assert!(r.success, "{:?}", r.error);
        assert_eq!((r.arrivals, r.new_emails), (0, 2), "written, not announced");
        let (_, records) = s.sync_engine.wait_changes(gen0, 0).await;
        assert!(records.iter().all(|rec| rec.new_emails == 0), "{records:?}");
    }
}
    #[test]
    fn mailbox_concurrency_clamps_to_one_through_five() {
        assert_eq!(mailbox_concurrency(&serde_json::json!({})), 1);
        assert_eq!(mailbox_concurrency(&serde_json::json!({"mailboxConcurrency": 0})), 1);
        assert_eq!(mailbox_concurrency(&serde_json::json!({"mailboxConcurrency": 3})), 3);
        assert_eq!(mailbox_concurrency(&serde_json::json!({"mailboxConcurrency": 9})), 5);
    }
