//! Daemon routes for the three insights methods (Task 3.6), backed by
//! `crate::insights`, moved whole from `src-tauri/src/insights.rs`. Task 3.7
//! deleted that file, its three Tauri commands and the app's snapshot map,
//! so these routes are the only implementation and the frontend
//! (`src/services/insightsApi.js`) reaches them through `daemon_rpc`.
//!
//! Wire shape (plan decision 5): `daemon_rpc`'s reply channel is
//! `Result<Value, String>`, which cannot carry insights' structured
//! `{code, coverage}` errors as an `Err` the way the app command's
//! `Result<Value, Value>` could. Every route here therefore always answers
//! `Ok`: success is today's app-command object plus `"ok": true`, and each
//! known failure code (`invalidAccountScope`, `vaultUnavailable`,
//! `accountConfigurationUnavailable`, `snapshotUnavailable`,
//! `snapshotExpired`, `invalidCursor`, `snapshotStale` (the last carrying
//! its own `coverage`) becomes `{"ok": false, "error": {...}}`, the same
//! pattern `search_index_destroy` already uses.

use crate::custody;
use crate::handlers::common::{blocking, opt_str_arg, str_arg, vault_root, vec_arg};
use crate::insights;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// Only the field insights ever reads (`crate::read_accounts_json` +
/// `.map(|a| a.id)` in the app version, collapsed into one step here).
#[derive(Deserialize)]
struct AccountsJsonEntry {
    id: String,
}

/// Same failure mapping as the app's `crate::read_accounts_json`: a missing
/// file is an empty list (as today), a torn or unparseable one is an `Err`
/// the caller maps to `accountConfigurationUnavailable`, never silently
/// "no accounts".
fn configured_account_ids(app_dir: &Path) -> Result<Vec<String>, String> {
    let path = app_dir.join("accounts.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read accounts.json: {e}"))?;
    let entries: Vec<AccountsJsonEntry> =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse accounts.json: {e}"))?;
    Ok(entries.into_iter().map(|e| e.id).collect())
}

fn ok(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        obj.insert("ok".into(), json!(true));
    }
    v
}

fn err(e: Value) -> Value {
    json!({"ok": false, "error": e})
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "insights_begin_snapshot" => {
            let account_ids: Vec<String> = req!(vec_arg(&id, params, "accountIds"));
            let state = Arc::clone(state);
            let result = blocking(move || -> Value {
                let configured = match configured_account_ids(&state.app_dir) {
                    Ok(c) => c,
                    Err(_) => return err(insights::error("accountConfigurationUnavailable")),
                };
                // Scope validation before any caller-derived file resolution
                // (same ordering the app's original command used, a
                // redundant pre-check, since `begin_at` repeats it more
                // thoroughly, but one that must run before `vault_root`).
                if account_ids.iter().any(|a| !configured.contains(a)) {
                    return err(insights::error("invalidAccountScope"));
                }
                let root = match vault_root(&state) {
                    Ok(r) => r,
                    Err(_) => return err(insights::error("vaultUnavailable")),
                };
                let gen_fn = || custody::generation(&state);
                let rows = |account: &str| -> Result<Vec<(String, Value)>, String> {
                    custody::with_conn(&state, |c| mailvault_core::custody::entries::entries_for_account(c, account))
                };
                let headers = |account: &str| -> Result<(Option<Value>, Vec<(String, Value)>), String> {
                    custody::with_conn(&state, |c| {
                        use mailvault_core::custody::cache;
                        let list = cache::load_mailboxes(c, account)?
                            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
                        let mut out = Vec::new();
                        for (_, mailbox) in cache::mailboxes_with_headers(c, Some(account))? {
                            let Some(blob) = cache::load_headers(c, account, &mailbox, None)? else { continue };
                            let value: Value = serde_json::from_str(&blob).map_err(|e| e.to_string())?;
                            out.push((mailbox, value));
                        }
                        Ok((list, out))
                    })
                };
                match state.insights.begin_at(&root, &rows, &headers, &configured, &account_ids, &gen_fn) {
                    Ok(v) => ok(v),
                    Err(e) => err(e),
                }
            })
            .await
            .unwrap_or_else(|_| err(insights::error("snapshotUnavailable")));
            RpcResponse::success(id, result)
        }
        "insights_read_page" => {
            let snapshot_id = req!(str_arg(&id, params, "snapshotId"));
            let cursor = opt_str_arg(params, "cursor");
            let state = Arc::clone(state);
            let result = blocking(move || -> Value {
                let configured = match configured_account_ids(&state.app_dir) {
                    Ok(c) => c,
                    Err(_) => return err(insights::error("accountConfigurationUnavailable")),
                };
                let root = match vault_root(&state) {
                    Ok(r) => r,
                    Err(_) => return err(insights::error("vaultUnavailable")),
                };
                if let Err(e) = state.insights.validate_context(&snapshot_id, &root, &configured) {
                    state.insights.release(&snapshot_id);
                    return err(e);
                }
                let gen_fn = || custody::generation(&state);
                match state.insights.read(&snapshot_id, cursor.as_deref(), &gen_fn) {
                    Ok(v) => ok(v),
                    Err(e) => err(e),
                }
            })
            .await
            .unwrap_or_else(|_| err(insights::error("snapshotUnavailable")));
            RpcResponse::success(id, result)
        }
        "insights_release_snapshot" => {
            let snapshot_id = req!(str_arg(&id, params, "snapshotId"));
            let state = Arc::clone(state);
            let result = blocking(move || {
                state.insights.release(&snapshot_id);
                json!({"ok": true})
            })
            .await
            .unwrap_or_else(|_| err(insights::error("snapshotUnavailable")));
            RpcResponse::success(id, result)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, std::path::PathBuf, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.clone(), mail_dir_ok);
        (vault, app_dir, s)
    }

    fn set_accounts(app_dir: &Path, ids: &[&str]) {
        let list: Vec<Value> = ids.iter().map(|id| json!({"id": id})).collect();
        std::fs::write(app_dir.join("accounts.json"), json!(list).to_string()).unwrap();
    }

    /// The real production write path (`sync_engine` calls the same
    /// function to write a fetched header), not a hand-rolled `fs::write`,
    /// so a test using this genuinely pins "the daemon writes a header
    /// sidecar", not a simulation of it.
    fn seed_account(state: &Arc<DaemonState>, account: &str, mailbox: &str, uid: u32) {
        // Through the state's own connection: `custody.db` is EXCLUSIVE, so a
        // second opener in this process would only ever fail BUSY.
        custody::with_conn(state, |c| {
            mailvault_core::custody::cache::save_mailboxes(
                c,
                account,
                &json!({"mailboxes":[{"path": mailbox}]}).to_string(),
            )?;
            let data =
                json!({"emails":[{"uid": uid, "subject": "v1", "from": {"address": "a@example.test"}}]}).to_string();
            mailvault_core::custody::cache::save_headers(c, account, mailbox, &data)
        })
        .expect("seed reaches the open custody store");
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, _a, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn insights_begin_snapshot_reaches_this_router_through_handle_request() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        let resp = handle_request_for_test(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await;
        assert_eq!(resp.result.unwrap()["ok"], true);
    }

    // ── Success shapes: today's object plus "ok": true ───────────────────

    #[tokio::test]
    async fn begin_snapshot_success_adds_ok_true_to_todays_shape() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        let v = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(v["ok"], true);
        assert!(v["snapshotId"].is_string(), "{v}");
        assert_eq!(v["inventoryCount"], 1);
        assert!(v["coverage"].is_object());
    }

    #[tokio::test]
    async fn read_page_success_adds_ok_true_to_todays_shape() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        let begin = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        let id = begin["snapshotId"].as_str().unwrap().to_string();
        let v = call(&s, "insights_read_page", json!({"snapshotId": id})).await.result.unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["rows"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn release_snapshot_success_shape() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        let begin = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        let id = begin["snapshotId"].as_str().unwrap().to_string();
        let r = call(&s, "insights_release_snapshot", json!({"snapshotId": id})).await;
        assert_eq!(r.result.unwrap(), json!({"ok": true}));
        // A released snapshot is really gone: the next read answers
        // snapshotExpired, not a stale success.
        let after = call(&s, "insights_read_page", json!({"snapshotId": id})).await.result.unwrap();
        assert_eq!(after["error"]["code"], "snapshotExpired");
    }

    // ── Failure wire shapes: Ok({"ok": false, "error": {...}}) ───────────

    #[tokio::test]
    async fn begin_snapshot_invalid_account_scope_wire_shape() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["other"]);
        let v = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(v, json!({"ok": false, "error": {"code": "invalidAccountScope", "message": "invalidAccountScope"}}));
    }

    #[tokio::test]
    async fn begin_snapshot_vault_unavailable_wire_shape() {
        let (_vault, app_dir, s) = st(false); // mail_dir_ok = false
        set_accounts(&app_dir, &["acc"]);
        let v = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "vaultUnavailable");
    }

    #[tokio::test]
    async fn begin_snapshot_account_configuration_unavailable_wire_shape() {
        let (_vault, app_dir, s) = st(true);
        std::fs::write(app_dir.join("accounts.json"), "not json").unwrap();
        let v = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "accountConfigurationUnavailable");
    }

    /// A missing `accounts.json` is a documented empty list, never this
    /// code, the same distinction `configured_account_ids` (and the app's
    /// original `read_accounts_json`) draws between "no file" and "a file
    /// that would not parse".
    #[tokio::test]
    async fn begin_snapshot_a_missing_accounts_json_is_an_empty_list_not_a_configuration_error() {
        let (_vault, _app_dir, s) = st(true); // accounts.json never written
        let v = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "invalidAccountScope", "{v}");
    }

    #[tokio::test]
    async fn read_page_invalid_cursor_wire_shape() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        let begin = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        let id = begin["snapshotId"].as_str().unwrap().to_string();
        let first = call(&s, "insights_read_page", json!({"snapshotId": id})).await.result.unwrap();
        assert!(first["nextCursor"].is_null(), "{first}");
        let second = call(&s, "insights_read_page", json!({"snapshotId": id, "cursor": "bogus"})).await.result.unwrap();
        assert_eq!(second["ok"], false);
        assert_eq!(second["error"]["code"], "invalidCursor");
    }

    #[tokio::test]
    async fn read_page_snapshot_expired_wire_shape() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        let v = call(&s, "insights_read_page", json!({"snapshotId": "nope"})).await.result.unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "snapshotExpired");
    }

    #[tokio::test]
    async fn read_page_snapshot_stale_wire_shape_carries_coverage() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        let begin = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        let id = begin["snapshotId"].as_str().unwrap().to_string();
        // Mutate the same watched header sidecar: the file-stamp staleness
        // check must catch this.
        seed_account(&s, "acc", "INBOX", 1);
        let v = call(&s, "insights_read_page", json!({"snapshotId": id})).await.result.unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "snapshotStale");
        assert!(v["error"]["coverage"].is_object(), "{v}");
    }

    // ── Step 5's required mechanism-pinning test ──────────────────────────

    /// A snapshot open while the daemon writes a header sidecar under a
    /// written path is invalidated. Uses `custody::cache::save_headers` (the
    /// real function `sync_engine` calls to store a fetched header), rather
    /// than a raw write, so this pins the actual daemon write path against
    /// silently no longer being seen as a real write by Insights.
    #[tokio::test]
    async fn a_snapshot_open_while_the_daemon_caches_a_header_is_invalidated() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        custody::open_into(&s).expect("custody opens for a real mail_dir_ok vault");

        let begin = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(begin["ok"], true, "{begin}");
        let id = begin["snapshotId"].as_str().unwrap().to_string();

        // The daemon caches the same header again, in-process, the way
        // `sync_engine` would on a re-fetch.
        custody::with_conn(&s, |c| {
            mailvault_core::custody::cache::save_headers(
                c,
                "acc",
                "INBOX",
                &json!({"emails":[{"uid":1,"subject":"changed by the daemon"}]}).to_string(),
            )
        })
        .unwrap();

        let page = call(&s, "insights_read_page", json!({"snapshotId": id})).await.result.unwrap();
        assert_eq!(page["ok"], false, "{page}");
        assert_eq!(page["error"]["code"], "snapshotStale");
    }

    // ── Fix F3: a route-level test that drives a REAL open custody store ──

    /// The generation-counter tests elsewhere are unit-level (a mocked
    /// `SharedConn`, or `custody.rs`'s own tests), and none of them drive an
    /// insights route through an actually OPEN custody store:
    /// `DaemonState::for_test` defaults custody to closed. This proves Fix
    /// F1's before/after freshness window works end to end: open custody for
    /// real, begin through the real route, write through the real
    /// `with_conn` chokepoint after `begin` succeeds, and confirm
    /// `insights_read_page` reports `snapshotStale` rather than silently
    /// paging stale rows.
    #[tokio::test]
    async fn a_route_level_custody_write_after_begin_is_seen_as_stale_through_the_real_store() {
        let (_vault, app_dir, s) = st(true);
        set_accounts(&app_dir, &["acc"]);
        seed_account(&s, "acc", "INBOX", 1);
        custody::open_into(&s).expect("custody opens for a real mail_dir_ok vault");
        custody::with_conn(&s, |c| {
            mailvault_core::custody::entries::upsert(c, "acc", "Archive", &[json!({"uid": 9, "flags": []})]).map(|_| ())
        })
        .unwrap();

        let begin = call(&s, "insights_begin_snapshot", json!({"accountIds": ["acc"]})).await.result.unwrap();
        assert_eq!(begin["ok"], true, "{begin}");
        assert!(
            begin["coverage"]["errors"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["code"] != "unreadableLocation"),
            "an open custody store must read cleanly: {begin}"
        );
        let id = begin["snapshotId"].as_str().unwrap().to_string();

        // A real write through the real chokepoint, after `begin` succeeded.
        custody::with_conn(&s, |c| {
            mailvault_core::custody::entries::upsert(c, "acc", "Archive", &[json!({"uid": 10, "flags": []})]).map(|_| ())
        })
        .unwrap();

        let page = call(&s, "insights_read_page", json!({"snapshotId": id})).await.result.unwrap();
        assert_eq!(page["ok"], false, "{page}");
        assert_eq!(page["error"]["code"], "snapshotStale");
    }
}
