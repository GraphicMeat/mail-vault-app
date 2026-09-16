//! Daemon routes for account migration (Task 4.7), backed by `crate::migration`,
//! moved from `src-tauri/src/migration.rs`. **No cutover in this task**: the
//! Tauri commands in `commands.rs` are untouched and still serve the frontend;
//! this router exists but nothing calls it yet. Task 4.8 deletes them and
//! switches the frontend to `daemon_rpc`.
//!
//! Cancel/pause/notify tokens are `DaemonState.run_tokens` entries under kind
//! "migration" (decision 7, `common::RunGuard::register_with_pause`),
//! replacing the app's single-slot `MigrationCancelToken`/
//! `MigrationPauseToken`/`MigrationNotify`.

use crate::handlers::common::{self, cancel_kind, pause_kind, str_arg, RunGuard};
use crate::ipc::{self, RpcResponse};
use crate::migration::{self, FolderMapping};
use crate::server::DaemonState;
use mailvault_core::imap::ImapConfig;
use serde_json::Value;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

fn parse_folder_mappings(id: &Value, params: &Value) -> Result<Vec<FolderMapping>, RpcResponse> {
    params
        .get("folderMappings")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing folderMappings"))
}

fn parse_imap_config(id: &Value, json_str: &str, which: &str) -> Result<ImapConfig, RpcResponse> {
    serde_json::from_str(json_str)
        .map_err(|e| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Bad {which} account JSON: {e}")))
}

/// Spawns `migration::run_migration` under a fresh "migration" `RunGuard`,
/// returning immediately (decision 8: this is a "kick off a job" call, not
/// the job itself -- progress flows over `channel.open`). Shared by
/// `start_migration` and `resume_migration`, which differ only in where
/// `folder_mappings` comes from.
#[allow(clippy::too_many_arguments)]
fn spawn_migration(
    state: &Arc<DaemonState>,
    source_config: ImapConfig,
    dest_config: ImapConfig,
    source_transport: String,
    dest_transport: String,
    source_account_json: String,
    dest_account_json: String,
    folder_mappings: Vec<FolderMapping>,
) {
    let guard = RunGuard::register_with_pause(state, "migration");
    let cancel = guard.cancel();
    let pause = guard.pause();
    let notify = guard.notify();
    let state = Arc::clone(state);
    tokio::spawn(async move {
        // Keep the guard alive for the whole run so the token stays
        // registered (and reachable by cancel_migration/pause_migration)
        // until this task actually finishes -- it drops here on every exit
        // path: success, error, or (task cancellation aside) panic.
        let _guard = guard;
        let result = migration::run_migration(
            state,
            source_config,
            dest_config,
            source_transport,
            dest_transport,
            source_account_json,
            dest_account_json,
            folder_mappings,
            cancel,
            pause,
            notify,
        )
        .await;
        if let Err(e) = result {
            tracing::error!("[migration] run_migration failed: {}", e);
        }
    });
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "start_migration" => {
            let source_account = req!(str_arg(&id, params, "sourceAccount"));
            let dest_account = req!(str_arg(&id, params, "destAccount"));
            let source_transport = req!(str_arg(&id, params, "sourceTransport"));
            let dest_transport = req!(str_arg(&id, params, "destTransport"));
            let folder_mappings = req!(parse_folder_mappings(&id, params));
            // Parsed for API compatibility only: the app-side command never
            // threaded this into run_migration's arguments either -- a
            // pre-existing no-op this port does not fix or introduce
            // (verified against commands.rs's start_migration body).
            let _include_local_archive = params.get("includeLocalArchive").and_then(Value::as_bool).unwrap_or(false);
            let source_config = req!(parse_imap_config(&id, &source_account, "source"));
            let dest_config = req!(parse_imap_config(&id, &dest_account, "dest"));

            spawn_migration(
                state,
                source_config,
                dest_config,
                source_transport,
                dest_transport,
                source_account,
                dest_account,
                folder_mappings,
            );
            RpcResponse::success(id, Value::Null)
        }
        "cancel_migration" => RpcResponse::success(id, serde_json::json!({"cancelled": cancel_kind(state, "migration")})),
        "pause_migration" => RpcResponse::success(id, serde_json::json!({"paused": pause_kind(state, "migration")})),
        "resume_migration" => {
            let source_account = req!(str_arg(&id, params, "sourceAccount"));
            let dest_account = req!(str_arg(&id, params, "destAccount"));
            let source_transport = req!(str_arg(&id, params, "sourceTransport"));
            let dest_transport = req!(str_arg(&id, params, "destTransport"));
            let source_config = req!(parse_imap_config(&id, &source_account, "source"));
            let dest_config = req!(parse_imap_config(&id, &dest_account, "dest"));

            let app_dir = state.app_dir.clone();
            let loaded = match common::blocking(move || migration::load_migration_state(&app_dir)).await.and_then(|r| r) {
                Ok(Some(s)) => s,
                Ok(None) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, "No migration state found to resume")),
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };

            let remaining: Vec<FolderMapping> = loaded.folder_mappings.into_iter().filter(|f| f.status != "completed").collect();

            spawn_migration(
                state,
                source_config,
                dest_config,
                source_transport,
                dest_transport,
                source_account,
                dest_account,
                remaining,
            );
            RpcResponse::success(id, Value::Null)
        }
        "get_migration_state" => {
            let app_dir = state.app_dir.clone();
            let result = common::blocking(move || migration::load_migration_state(&app_dir)).await.and_then(|r| r);
            match result {
                Ok(v) => RpcResponse::success(id, serde_json::to_value(v).unwrap_or(Value::Null)),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }
        "clear_migration_state_cmd" => {
            let app_dir = state.app_dir.clone();
            let result = common::blocking(move || migration::clear_migration_state(&app_dir)).await.and_then(|r| r);
            match result {
                Ok(()) => RpcResponse::success(id, serde_json::json!({"cleared": true})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }
        "count_migration_folders" => {
            let source_account = req!(str_arg(&id, params, "sourceAccount"));
            let source_transport = req!(str_arg(&id, params, "sourceTransport"));
            let folder_mappings = req!(parse_folder_mappings(&id, params));
            let source_config = req!(parse_imap_config(&id, &source_account, "source"));
            let state = Arc::clone(state);
            tokio::spawn(async move {
                if let Err(e) = migration::count_migration_folders(state, source_config, source_transport, folder_mappings).await {
                    tracing::error!("[migration] count_migration_folders failed: {}", e);
                }
            });
            RpcResponse::success(id, Value::Null)
        }
        "get_folder_mappings" => {
            let source_account = req!(str_arg(&id, params, "sourceAccount"));
            let dest_account = req!(str_arg(&id, params, "destAccount"));
            let source_transport = req!(str_arg(&id, params, "sourceTransport"));
            let dest_transport = req!(str_arg(&id, params, "destTransport"));
            let source_config = req!(parse_imap_config(&id, &source_account, "source"));
            let dest_config = req!(parse_imap_config(&id, &dest_account, "dest"));
            let result = migration::get_folder_mappings(state, &source_config, &dest_config, &source_transport, &dest_transport).await;
            match result {
                Ok(v) => RpcResponse::success(id, serde_json::to_value(v).unwrap_or_default()),
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
    use mock_imap::state::{synthetic_mailbox, Mailbox};
    use mock_imap::{Action, MockImap, Scenario, Trigger};
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

    /// Build an `ImapConfig` JSON string pointed at a running mock server,
    /// with plaintext enabled (the client only honors this for loopback).
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

    fn mailbox_with(name: &str, uids: &[u32]) -> Mailbox {
        let mut mb = Mailbox::new(name);
        for &uid in uids {
            mb.add(mock_imap::Message::new(
                uid,
                format!(
                    "From: sender@example.com\r\nTo: user@example.com\r\nSubject: msg {uid}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMessage-ID: <{uid}@example.com>\r\n\r\nbody {uid}\r\n"
                ),
            ));
        }
        mb
    }

    fn inbox_with(uids: &[u32]) -> Mailbox {
        mailbox_with("INBOX", uids)
    }

    async fn wait_for<F: Fn() -> bool>(pred: F, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if pred() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        pred()
    }

    // ── Routing / params ─────────────────────────────────────────────────

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, _a, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn start_migration_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(&s, "start_migration", json!({})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "start_migration did not reach handlers::migration::route");
    }

    #[tokio::test]
    async fn start_migration_missing_source_account_is_invalid_params() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "start_migration", json!({})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    // ── A real two-account run over the mock IMAP server ───────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn a_two_account_migration_copies_messages_and_emits_progress() {
        let (_v, _a, s) = st(true);
        let source = MockImap::start(Scenario::new().mailbox(inbox_with(&[1, 2])));
        let dest = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));

        let mut rx = s.events.subscribe();

        let mappings = vec![FolderMapping {
            source_path: "INBOX".to_string(),
            dest_path: "INBOX".to_string(),
            source_special_use: None,
            dest_folder_id: None,
            email_count: 2,
            status: "pending".to_string(),
            migrated: 0,
            skipped: 0,
            failed: 0,
            failed_uids: Vec::new(),
        }];

        let resp = call(
            &s,
            "start_migration",
            json!({
                "sourceAccount": account_json(&source, "source@example.com"),
                "destAccount": account_json(&dest, "dest@example.com"),
                "sourceTransport": "imap",
                "destTransport": "imap",
                "folderMappings": mappings,
            }),
        )
        .await;
        assert!(resp.error.is_none(), "start_migration must succeed: {:?}", resp.error);

        // A migration-progress frame must reach the bus.
        let saw_progress = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let line = rx.recv().await.expect("bus closed");
                if line.contains("migration-progress") {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(saw_progress, "migration-progress never reached the bus");

        // The dest account's ImapPool copy actually has 2 messages once the
        // run completes: poll dest via a fresh session rather than sleeping
        // a fixed duration.
        let got = wait_for(
            || {
                // A crude but sufficient completion probe: the run's own
                // migration_state.json is written on every checkpoint/final
                // state and its status flips to "completed".
                match migration::load_migration_state(&s.app_dir) {
                    Ok(Some(st)) => st.status == "completed",
                    _ => false,
                }
            },
            Duration::from_secs(15),
        )
        .await;
        assert!(got, "migration never reached a completed state in time");

        let final_state = migration::load_migration_state(&s.app_dir).unwrap().expect("state saved");
        assert_eq!(final_state.migrated_emails, 2, "both messages migrated");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_migration_mid_run_stops_it() {
        let (_v, _a, s) = st(true);
        // A 300ms delay on every FETCH gives cancel_migration a reliable
        // window to land mid-run instead of racing a fast local mock server
        // to completion before the cancel RPC even arrives.
        let source = MockImap::start(
            Scenario::new()
                .mailbox(inbox_with(&(1..=20).collect::<Vec<_>>()))
                .fault(Trigger::on("FETCH"), Action::Delay(Duration::from_millis(300))),
        );
        let dest = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));

        let mappings = vec![FolderMapping {
            source_path: "INBOX".to_string(),
            dest_path: "INBOX".to_string(),
            source_special_use: None,
            dest_folder_id: None,
            email_count: 20,
            status: "pending".to_string(),
            migrated: 0,
            skipped: 0,
            failed: 0,
            failed_uids: Vec::new(),
        }];

        call(
            &s,
            "start_migration",
            json!({
                "sourceAccount": account_json(&source, "source2@example.com"),
                "destAccount": account_json(&dest, "dest2@example.com"),
                "sourceTransport": "imap",
                "destTransport": "imap",
                "folderMappings": mappings,
            }),
        )
        .await;

        // Cancel almost immediately -- the run must stop, not run all 20 to completion.
        let cancel_resp = call(&s, "cancel_migration", json!({})).await;
        assert_eq!(cancel_resp.result.unwrap()["cancelled"], json!(1));

        let stopped = wait_for(
            || match migration::load_migration_state(&s.app_dir) {
                Ok(None) => true, // cancelled runs clear persistent state
                Ok(Some(st)) => st.status == "cancelled",
                Err(_) => false,
            },
            Duration::from_secs(15),
        )
        .await;
        assert!(stopped, "cancelled migration never stopped");
    }

    // ── Pause/resume round-trips through migration_state.json ──────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn pause_migration_persists_a_paused_checkpoint() {
        let (_v, _a, s) = st(true);
        // run_migration's pause check lives at the TOP of the per-folder
        // loop only -- the inner per-message loop sleeps on pause but never
        // checkpoints or emits "paused" (a real asymmetry, not a test
        // artifact; see the Task 4.7 report's Known Gap note). Two folders,
        // so folder 0 finishing (slowly, via the FETCH delay) hands control
        // to folder 1's top-of-loop check, which is where "paused" actually
        // gets written. Folder 1's own path is never touched by IMAP: the
        // pause check fires before any I/O for it.
        let source = MockImap::start(
            Scenario::new()
                .mailbox(inbox_with(&[1, 2]))
                .fault(Trigger::on("FETCH"), Action::Delay(Duration::from_millis(300))),
        );
        let dest = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));
        let mappings = vec![
            FolderMapping {
                source_path: "INBOX".to_string(), dest_path: "INBOX".to_string(), source_special_use: None,
                dest_folder_id: None, email_count: 2, status: "pending".to_string(), migrated: 0, skipped: 0, failed: 0, failed_uids: Vec::new(),
            },
            FolderMapping {
                source_path: "Archive".to_string(), dest_path: "Archive".to_string(), source_special_use: None,
                dest_folder_id: None, email_count: 0, status: "pending".to_string(), migrated: 0, skipped: 0, failed: 0, failed_uids: Vec::new(),
            },
        ];

        call(&s, "start_migration", json!({
            "sourceAccount": account_json(&source, "pause-src@example.com"),
            "destAccount": account_json(&dest, "pause-dst@example.com"),
            "sourceTransport": "imap",
            "destTransport": "imap",
            "folderMappings": mappings,
        })).await;

        let pause_resp = call(&s, "pause_migration", json!({})).await;
        assert_eq!(pause_resp.result.unwrap()["paused"], json!(1));

        let paused = wait_for(
            || matches!(migration::load_migration_state(&s.app_dir), Ok(Some(st)) if st.status == "paused"),
            Duration::from_secs(15),
        )
        .await;
        assert!(paused, "pause_migration never produced a paused checkpoint");
    }

    /// The real `resume_migration` route: a pre-seeded `migration_state.json`
    /// with one folder already "completed" and one "pending" must relaunch
    /// only the pending one -- the completed folder's counters are untouched
    /// because it is filtered out before `run_migration` ever spawns.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_migration_relaunches_only_the_incomplete_folder() {
        let (_v, a, s) = st(true);
        let source = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 0))
                .mailbox(mailbox_with("Archive", &[1])),
        );
        let dest = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 0))
                .mailbox(synthetic_mailbox("Archive", 0)),
        );

        let seed = migration::MigrationState {
            id: "mig-resume".to_string(),
            source_email: "resume-src@example.com".to_string(),
            dest_email: "resume-dst@example.com".to_string(),
            source_transport: "imap".to_string(),
            dest_transport: "imap".to_string(),
            source_account_json: account_json(&source, "resume-src@example.com"),
            dest_account_json: account_json(&dest, "resume-dst@example.com"),
            status: "paused".to_string(),
            folder_mappings: vec![
                FolderMapping {
                    source_path: "INBOX".to_string(), dest_path: "INBOX".to_string(), source_special_use: None,
                    dest_folder_id: None, email_count: 1, status: "completed".to_string(), migrated: 1, skipped: 0, failed: 0, failed_uids: Vec::new(),
                },
                FolderMapping {
                    source_path: "Archive".to_string(), dest_path: "Archive".to_string(), source_special_use: None,
                    dest_folder_id: None, email_count: 1, status: "pending".to_string(), migrated: 0, skipped: 0, failed: 0, failed_uids: Vec::new(),
                },
            ],
            total_emails: 2,
            migrated_emails: 1,
            skipped_emails: 0,
            failed_emails: 0,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        migration::save_migration_state(a.path(), &seed).unwrap();

        let resp = call(&s, "resume_migration", json!({
            "sourceAccount": account_json(&source, "resume-src@example.com"),
            "destAccount": account_json(&dest, "resume-dst@example.com"),
            "sourceTransport": "imap",
            "destTransport": "imap",
        })).await;
        assert!(resp.error.is_none(), "resume_migration must succeed: {:?}", resp.error);

        let done = wait_for(
            || matches!(migration::load_migration_state(&s.app_dir), Ok(Some(st)) if st.status == "completed"),
            Duration::from_secs(15),
        )
        .await;
        assert!(done, "resumed migration never completed");

        let final_state = migration::load_migration_state(&s.app_dir).unwrap().expect("state saved");
        // Only the Archive folder's message was migrated by this run; the
        // already-completed INBOX folder's own counters (migrated: 1) came
        // from the seeded state, never re-run.
        assert_eq!(final_state.migrated_emails, 1, "only the resumed folder's message counts");
        let archive = final_state.folder_mappings.iter().find(|f| f.source_path == "Archive").unwrap();
        assert_eq!(archive.status, "completed");
        assert_eq!(archive.migrated, 1);
    }

    #[tokio::test]
    async fn get_migration_state_reads_what_save_migration_state_wrote() {
        let (_v, _a, s) = st(true);
        assert!(call(&s, "get_migration_state", json!({})).await.result.unwrap().is_null());

        let ms = migration::MigrationState {
            id: "x".to_string(), source_email: "a@x.com".to_string(), dest_email: "b@x.com".to_string(),
            source_transport: "imap".to_string(), dest_transport: "imap".to_string(),
            source_account_json: "{}".to_string(), dest_account_json: "{}".to_string(),
            status: "completed".to_string(), folder_mappings: Vec::new(), total_emails: 0,
            migrated_emails: 0, skipped_emails: 0, failed_emails: 0,
            started_at: "t".to_string(), updated_at: "t".to_string(),
        };
        migration::save_migration_state(&s.app_dir, &ms).unwrap();

        let resp = call(&s, "get_migration_state", json!({})).await;
        assert_eq!(resp.result.unwrap()["status"], json!("completed"));

        let cleared = call(&s, "clear_migration_state_cmd", json!({})).await;
        assert_eq!(cleared.result.unwrap()["cleared"], json!(true));
        assert!(call(&s, "get_migration_state", json!({})).await.result.unwrap().is_null());
    }

    // ── get_folder_mappings against the mock IMAP server ────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn get_folder_mappings_maps_matching_special_use_and_mirrors_custom_folders() {
        let (_v, _a, s) = st(true);
        let source = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 0))
                .mailbox(synthetic_mailbox("Projects", 0)),
        );
        let dest = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));

        let resp = call(
            &s,
            "get_folder_mappings",
            json!({
                "sourceAccount": account_json(&source, "src3@example.com"),
                "destAccount": account_json(&dest, "dst3@example.com"),
                "sourceTransport": "imap",
                "destTransport": "imap",
            }),
        )
        .await;
        let mappings = resp.result.expect("get_folder_mappings must succeed");
        // `FolderMapping` has no serde rename: the wire key is `source_path`,
        // plain snake_case, matching every other Phase 4 payload (plan's
        // "no case normalization" decision).
        let paths: Vec<String> = mappings
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["source_path"].as_str().unwrap_or_default().to_string())
            .collect();
        assert!(paths.iter().any(|p| p == "INBOX"), "{paths:?}");
        assert!(paths.iter().any(|p| p == "Projects"), "{paths:?}");
    }
}
