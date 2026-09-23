//! Daemon RPC routes for Microsoft Graph (Task 5.6), plan
//! `docs/superpowers/plans/2026-09-17-daemon-shell-phase5-network.md`.
//!
//! Naming deviation from the plan text (same convention as Tasks
//! 5.4a/5.4b/5.5, ledgered in `docs/superpowers/ledgers/
//! 2026-09-17-daemon-shell-phase5/progress.md`): flat `graph_*` names, not
//! `graph.*` — their Tauri twins are deleted in this same task, so these
//! belong in `transport.js`'s `DAEMON_OWNED` with no rename layer and no
//! Tauri fallback.
//!
//! Ported verbatim from `src-tauri/src/commands.rs` against
//! `mailvault_core::graph::GraphClient` (already daemon-reachable —
//! `backup.rs` and `src-daemon/src/migration.rs` already construct it
//! in-process), same request/response JSON, one fresh stateless
//! `GraphClient::new(&access_token)` per call, matching the existing
//! stateless-per-call pattern (no new pooling, per the plan).
//!
//! `graph_get_mime` is NOT ported — 0 callers anywhere in `src/` (only its
//! own Tauri definition and `generate_handler!` entry referenced it), so it
//! is deleted outright along with its Tauri twin, not routed here.
//!
//! `graph_cache_mime` bypasses the daemon's `with_vault_write` gate, a
//! pre-existing, already-documented exception (architecture.md:
//! "commands.rs (`graph_cache_mime`)"). It was migrated AS-IS, still ungated
//! (uses `common::vault_root`, not `common::with_vault_write`), per the Task
//! 5.6 scoping call ("fixing it is out of scope, would be scope creep on a
//! security-sensitive migration phase"). Its write itself now goes through
//! `vault_files::store(.., overwrite: false)` under the vault registry's
//! mailbox lock, so the registry holds the row it wrote (vault registry
//! plan, Task 2b); the gate stays off.
use crate::handlers::common::{self, blocking, opt_str_arg, str_arg, u32_arg, vec_arg};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::graph::GraphClient;
use mailvault_core::vault_eml;
use mailvault_core::vault_files;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::info;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// A required bool param — `graph_set_read`/`graph_set_flagged`'s
/// isRead/flagged have no sensible default, unlike the optional booleans
/// elsewhere in this crate (`background`, `permanent`, ...), so this mirrors
/// `common::str_arg`/`u32_arg` rather than an `unwrap_or`.
fn bool_arg(id: &Value, params: &Value, key: &str) -> Result<bool, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "graph_list_folders" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let client = GraphClient::new(&access_token);
            match client.list_folders().await {
                Ok(folders) => match serde_json::to_value(&folders) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_list_messages" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let folder_id = req!(str_arg(&id, params, "folderId"));
            let top = req!(u32_arg(&id, params, "top"));
            let skip = req!(u32_arg(&id, params, "skip"));
            let client = GraphClient::new(&access_token);
            match client.list_messages(&folder_id, top, skip).await {
                Ok((messages, next_link)) => {
                    // The uid here is provisional — the message's position in a
                    // `receivedDateTime desc` listing, which moves every time mail
                    // arrives or leaves. It is not an identifier and nothing may
                    // persist by it. cacheManager.listGraphMessages replaces it
                    // with an allocated uid before any caller sees these rows, and
                    // is the only supported way to read this command; the pairing
                    // with `graphMessageIds` below is what makes that possible, so
                    // the two arrays must stay the same length and order.
                    // Verbatim from commands.rs.
                    let headers: Vec<_> = messages
                        .iter()
                        .enumerate()
                        .map(|(i, m)| m.to_email_header((skip + i as u32 + 1) as u32))
                        .collect();
                    let graph_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
                    RpcResponse::success(
                        id,
                        json!({
                            "headers": headers,
                            "nextLink": next_link,
                            "graphMessageIds": graph_ids,
                        }),
                    )
                }
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_get_message" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let client = GraphClient::new(&access_token);
            match client.get_message(&message_id).await {
                Ok(msg) => match serde_json::to_value(&msg) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_cache_mime" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));

            let client = GraphClient::new(&access_token);
            let raw_bytes = match client.get_mime_content(&message_id).await {
                Ok(b) => b,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };

            // Raw write, deliberately NOT behind `common::with_vault_write`'s
            // gate — see the module doc comment. `common::vault_root` alone
            // still fails with `E_VAULT_UNAVAILABLE:` when the folder is
            // unreachable (same failure mode `vault::root(app_handle)` gave
            // the app-side version), it just never takes the RwLock that
            // would serialize this against a concurrent vault move.
            let root = match common::vault_root(state) {
                Ok(r) => r,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };
            let raw_for_write = raw_bytes.clone();
            let write_state = Arc::clone(state);
            let (write_account, write_mailbox) = (account_id.clone(), mailbox.clone());
            // Unlike `imap_get_email_light`'s auto-cache (best-effort, only
            // `warn!`s on failure), this write failing fails the whole
            // command — verbatim from commands.rs's `?` propagation, because
            // here the cache write IS the operation, not a side effect of one.
            // `overwrite: false` skips a uid that already has a file, as the
            // `find_file_by_uid` check it replaces did; a write upserts the
            // row and the registry's hook nudges the index.
            let write = blocking(move || -> Result<bool, String> {
                let registry = &write_state.vault_registry;
                registry.serialized(&write_account, &write_mailbox, || {
                    vault_files::store(registry, &root, &write_account, &write_mailbox, uid, &raw_for_write, &[], false)
                })
            })
            .await;

            match write {
                Ok(Ok(wrote)) => {
                    if wrote {
                        info!("Graph: cached UID {} for {}/{} ({} bytes)", uid, account_id, mailbox, raw_bytes.len());
                    }
                }
                Ok(Err(e)) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
                Err(join_err) => {
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Task join error: {join_err}")));
                }
            }

            let email = match vault_eml::parse_eml_bytes_light(&raw_bytes, uid, vec![]) {
                Ok(e) => e,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };

            // Reached only when `store` succeeded: the uid's file is in the vault.
            RpcResponse::success(id, json!({"success": true, "email": email, "cached": true}))
        }

        "graph_set_read" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let is_read = req!(bool_arg(&id, params, "isRead"));
            let client = GraphClient::new(&access_token);
            match client.set_read_status(&message_id, is_read).await {
                Ok(()) => RpcResponse::success(id, Value::Null),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_set_flagged" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let flagged = req!(bool_arg(&id, params, "flagged"));
            let client = GraphClient::new(&access_token);
            match client.set_flag_status(&message_id, flagged).await {
                Ok(()) => RpcResponse::success(id, Value::Null),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_delete_message" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let client = GraphClient::new(&access_token);
            match client.delete_message(&message_id).await {
                Ok(()) => RpcResponse::success(id, Value::Null),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_move_emails" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let message_ids = req!(vec_arg::<String>(&id, params, "messageIds"));
            let target_folder_id = req!(str_arg(&id, params, "targetFolderId"));
            let client = GraphClient::new(&access_token);
            let mut moved = 0u32;
            for msg_id in &message_ids {
                if let Err(e) = client.move_message(msg_id, &target_folder_id).await {
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e));
                }
                moved += 1;
            }
            RpcResponse::success(id, json!({"success": true, "moved": moved}))
        }

        "graph_create_folder" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let display_name = req!(str_arg(&id, params, "displayName"));
            let parent_folder_id = opt_str_arg(params, "parentFolderId");
            let client = GraphClient::new(&access_token);
            match client.create_folder(&display_name, parent_folder_id.as_deref()).await {
                Ok(folder) => match serde_json::to_value(&folder) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_rename_folder" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let folder_id = req!(str_arg(&id, params, "folderId"));
            let display_name = req!(str_arg(&id, params, "displayName"));
            let client = GraphClient::new(&access_token);
            match client.rename_folder(&folder_id, &display_name).await {
                Ok(()) => RpcResponse::success(id, Value::Null),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_move_folder" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let folder_id = req!(str_arg(&id, params, "folderId"));
            let destination_id = req!(str_arg(&id, params, "destinationId"));
            let client = GraphClient::new(&access_token);
            match client.move_folder(&folder_id, &destination_id).await {
                Ok(()) => RpcResponse::success(id, Value::Null),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "graph_delete_folder" => {
            let access_token = req!(str_arg(&id, params, "accessToken"));
            let folder_id = req!(str_arg(&id, params, "folderId"));
            let client = GraphClient::new(&access_token);
            match client.delete_folder(&folder_id).await {
                Ok(()) => RpcResponse::success(id, Value::Null),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Mutex, OnceLock};

    // `GraphClient`'s base URL (`mailvault_core::graph::graph_base`) is a
    // process-wide `OnceLock`, read once from `MAILVAULT_GRAPH_BASE` — so
    // every test in this module must share ONE mock server; a second,
    // differently-ported one would be silently ignored after the first test
    // to touch it. `TEST_LOCK` serializes the whole module so no two tests
    // ever race over the shared response queue; `QUEUE` holds exactly the
    // response(s) the next accepted connection(s) should get, popped one per
    // connection in order. The mock never inspects the request itself
    // (method/path/body) — these tests check that `route()` wraps
    // GraphClient's Ok/Err correctly, not Graph's wire protocol (that is
    // `src-core/src/graph.rs`'s own job).
    //
    // ponytail: hand-rolled single-shot HTTP/1.1 responder (no chunked
    // request bodies, no keep-alive, no request inspection) — sufficient for
    // a test fixture; reach for a real crate (wiremock) only if a future
    // test needs to assert on the outgoing request itself.
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    static QUEUE: Mutex<VecDeque<(u16, String)>> = Mutex::new(VecDeque::new());

    fn mock_server_port() -> u16 {
        static PORT: OnceLock<u16> = OnceLock::new();
        *PORT.get_or_init(|| {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock graph server");
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    handle_conn(stream);
                }
            });
            std::env::set_var("MAILVAULT_GRAPH_BASE", format!("http://127.0.0.1:{port}"));
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

    /// Queue the response(s) this test's call is expected to trigger, in
    /// order, and return a guard that serializes this test against every
    /// other test in the module. Callers must hold the guard for the whole
    /// test (`let _g = mock_graph(...)`).
    fn mock_graph(responses: Vec<(u16, String)>) -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        mock_server_port();
        let mut q = QUEUE.lock().unwrap();
        q.clear();
        q.extend(responses);
        drop(q);
        guard
    }

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-graph-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    /// Every optional field present (even as `null`) — none of `GraphMessage`'s
    /// fields carry `#[serde(default)]`, so a key missing entirely is a
    /// deserialization error, not a `None`.
    fn graph_message_json(id: &str) -> Value {
        json!({
            "id": id, "subject": "Hi", "from": null, "toRecipients": null,
            "ccRecipients": null, "bccRecipients": null, "receivedDateTime": "2026-01-01T00:00:00Z",
            "sentDateTime": null, "isRead": false, "hasAttachments": false,
            "internetMessageId": null, "body": null, "internetMessageHeaders": null,
        })
    }

    fn graph_folder_json(id: &str, name: &str) -> Value {
        json!({"id": id, "displayName": name, "totalItemCount": 5, "unreadItemCount": 1})
    }

    #[tokio::test]
    async fn list_folders_resolves_well_known_names_and_assigns_storage_keys() {
        // Two requests: GET /me/mailFolders, then POST /me/$batch resolving
        // the six well-known folder ids (`resolve_well_known_ids`).
        let list_resp = json!({"value": [graph_folder_json("fld-inbox", "Inbox")], "@odata.nextLink": null});
        let batch_resp = json!({"responses": [{"id": "inbox", "status": 200, "body": {"id": "fld-inbox"}}]});
        let _g = mock_graph(vec![(200, list_resp.to_string()), (200, batch_resp.to_string())]);
        let s = st();

        let resp = call(&s, "graph_list_folders", json!({"accessToken": "tok"})).await;
        let folders = resp.result.expect("success");
        let folders = folders.as_array().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["id"], json!("fld-inbox"));
        assert_eq!(folders[0]["storageKey"], json!("INBOX"));
    }

    #[tokio::test]
    async fn list_messages_shapes_headers_and_graph_message_ids() {
        let list_resp = json!({
            "value": [graph_message_json("m1"), graph_message_json("m2")],
            "@odata.nextLink": null,
        });
        let _g = mock_graph(vec![(200, list_resp.to_string())]);
        let s = st();

        let resp = call(
            &s,
            "graph_list_messages",
            json!({"accessToken": "tok", "folderId": "inbox", "top": 50, "skip": 0}),
        )
        .await;
        let result = resp.result.expect("success");
        let headers = result["headers"].as_array().unwrap();
        assert_eq!(headers.len(), 2);
        // uid = skip + i + 1, matching commands.rs's synthetic allocation.
        assert_eq!(headers[0]["uid"], json!(1));
        assert_eq!(headers[1]["uid"], json!(2));
        assert_eq!(result["graphMessageIds"], json!(["m1", "m2"]));
        assert!(result["nextLink"].is_null());
    }

    #[tokio::test]
    async fn get_message_returns_the_graph_message() {
        let _g = mock_graph(vec![(200, graph_message_json("m1").to_string())]);
        let s = st();

        let resp = call(&s, "graph_get_message", json!({"accessToken": "tok", "messageId": "m1"})).await;
        assert_eq!(resp.result.expect("success")["id"], json!("m1"));
    }

    #[tokio::test]
    async fn get_message_propagates_a_graph_error() {
        let _g = mock_graph(vec![(401, json!({"error": "expired token"}).to_string())]);
        let s = st();

        let resp = call(&s, "graph_get_message", json!({"accessToken": "tok", "messageId": "m1"})).await;
        assert!(resp.result.is_none(), "a Graph 401 must not report success");
    }

    #[tokio::test]
    async fn cache_mime_writes_the_vault_file_and_returns_the_light_email() {
        let raw_eml = "From: a@b.com\r\nSubject: hi\r\n\r\nBody text";
        let _g = mock_graph(vec![(200, raw_eml.to_string())]);
        let s = st();

        let resp = call(
            &s,
            "graph_cache_mime",
            json!({"accessToken": "tok", "messageId": "m1", "accountId": "acct1", "mailbox": "INBOX", "uid": 7}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["email"]["subject"], json!("hi"));

        let cur_dir = vault_files::cur_path(&s.data_dir, "acct1", "INBOX");
        assert!(vault_eml::find_file_by_uid(&cur_dir, 7).is_some(), "the raw .eml must land in the vault's cur dir");
        assert_eq!(result["cached"], json!(true));
    }

    /// The write goes through `vault_files::store`, so a verified mailbox
    /// holds the new row with no relisting.
    #[tokio::test]
    async fn cache_mime_records_the_file_in_a_verified_registry() {
        let _g = mock_graph(vec![(200, "From: a@b.com\r\nSubject: hi\r\n\r\nBody".to_string())]);
        let s = st();
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(&s.data_dir, "acct1", "INBOX"), Some((vec![], vec![])));

        let resp = call(
            &s,
            "graph_cache_mime",
            json!({"accessToken": "tok", "messageId": "m1", "accountId": "acct1", "mailbox": "INBOX", "uid": 7}),
        )
        .await;
        assert_eq!(resp.result.expect("success")["cached"], json!(true));
        assert_eq!(reg.uid_sets(&s.data_dir, "acct1", "INBOX"), Some((vec![7], vec![])));
        assert_eq!(reg.listing_count(), 1, "the row came from the write, not a relisting");
    }

    #[tokio::test]
    async fn cache_mime_skips_the_write_when_a_file_for_the_uid_already_exists() {
        let raw_eml = "From: a@b.com\r\nSubject: first\r\n\r\nBody";
        let s = st();
        let cur_dir = vault_files::cur_path(&s.data_dir, "acct1", "INBOX");
        std::fs::create_dir_all(&cur_dir).unwrap();
        std::fs::write(cur_dir.join(format!("7{}.eml", mailvault_core::maildir::INFO_PREFIX)), b"already here").unwrap();

        let _g = mock_graph(vec![(200, raw_eml.to_string())]);
        let resp = call(
            &s,
            "graph_cache_mime",
            json!({"accessToken": "tok", "messageId": "m1", "accountId": "acct1", "mailbox": "INBOX", "uid": 7}),
        )
        .await;
        assert_eq!(resp.result.expect("success")["success"], json!(true));
        // The pre-existing file must be untouched (`maildir_store_raw`
        // semantics: overwrite: false), not replaced with the fetched bytes.
        assert_eq!(std::fs::read(cur_dir.join(format!("7{}.eml", mailvault_core::maildir::INFO_PREFIX))).unwrap(), b"already here");
    }

    #[tokio::test]
    async fn set_read_succeeds_and_returns_null() {
        let _g = mock_graph(vec![(200, String::new())]);
        let s = st();
        let resp = call(&s, "graph_set_read", json!({"accessToken": "tok", "messageId": "m1", "isRead": true})).await;
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn set_flagged_succeeds_and_returns_null() {
        let _g = mock_graph(vec![(200, String::new())]);
        let s = st();
        let resp = call(&s, "graph_set_flagged", json!({"accessToken": "tok", "messageId": "m1", "flagged": true})).await;
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn delete_message_succeeds_and_returns_null() {
        let _g = mock_graph(vec![(200, String::new())]);
        let s = st();
        let resp = call(&s, "graph_delete_message", json!({"accessToken": "tok", "messageId": "m1"})).await;
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn move_emails_moves_each_id_and_counts_them() {
        let _g = mock_graph(vec![
            (200, graph_message_json("m1").to_string()),
            (200, graph_message_json("m2").to_string()),
        ]);
        let s = st();
        let resp = call(
            &s,
            "graph_move_emails",
            json!({"accessToken": "tok", "messageIds": ["m1", "m2"], "targetFolderId": "fld-archive"}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["moved"], json!(2));
    }

    #[tokio::test]
    async fn create_folder_returns_the_graph_folder() {
        let _g = mock_graph(vec![(200, graph_folder_json("fld-new", "Projects").to_string())]);
        let s = st();
        let resp = call(&s, "graph_create_folder", json!({"accessToken": "tok", "displayName": "Projects", "parentFolderId": null})).await;
        assert_eq!(resp.result.expect("success")["displayName"], json!("Projects"));
    }

    #[tokio::test]
    async fn rename_folder_succeeds_and_returns_null() {
        let _g = mock_graph(vec![(200, String::new())]);
        let s = st();
        let resp = call(&s, "graph_rename_folder", json!({"accessToken": "tok", "folderId": "fld-1", "displayName": "New Name"})).await;
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn move_folder_succeeds_and_returns_null() {
        let _g = mock_graph(vec![(200, String::new())]);
        let s = st();
        let resp = call(&s, "graph_move_folder", json!({"accessToken": "tok", "folderId": "fld-1", "destinationId": "fld-2"})).await;
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn delete_folder_succeeds_and_returns_null() {
        let _g = mock_graph(vec![(200, String::new())]);
        let s = st();
        let resp = call(&s, "graph_delete_folder", json!({"accessToken": "tok", "folderId": "fld-1"})).await;
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn graph_get_mime_is_no_longer_routed_here() {
        let s = st();
        assert!(
            route(&s, "graph_get_mime", &json!({"accessToken": "tok", "messageId": "m1"}), json!(1)).await.is_none(),
            "graph_get_mime is dead (0 callers) and was deleted, not ported"
        );
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st();
        assert!(route(&s, "imap_get_mailboxes", &json!({}), json!(1)).await.is_none());
    }
}
