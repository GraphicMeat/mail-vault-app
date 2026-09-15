//! The search index RPCs (spec 2026-09-14 §5.3), same names and payloads as the
//! app's former Tauri commands. Every route blocks on the index: spawn_blocking.
use crate::ipc::{self, RpcResponse};
use crate::search_index as si;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Task join error: {e}"))
}

fn done(id: Value, r: Result<Value, String>) -> RpcResponse {
    match r {
        Ok(v) => RpcResponse::success(id, v),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let st = Arc::clone(&state.search_index);
    Some(match method {
        "search_index_status" => done(id, blocking(move || si::status_json(&st)).await),
        "search_index_configure" => {
            let Some(args) = params.get("config").and_then(|c| serde_json::from_value::<si::ConfigArgs>(c.clone()).ok()) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing config"));
            };
            done(id, blocking(move || { si::configure(&st, args); Value::Null }).await)
        }
        "search_index_rebuild" => done(id, blocking(move || { si::rebuild(&st); Value::Null }).await),
        // Two minutes: the worker finishes its current batch or compaction first.
        "search_index_destroy" => done(id, blocking(move || si::destroy(&st, Duration::from_secs(120))).await),
        "search_index_close" => done(id, blocking(move || { si::close(&st); Value::Null }).await),
        "search_index_reopen" => done(id, blocking(move || { si::reopen(&st); Value::Null }).await),
        "vault_search" => {
            let Some(request) = params.get("request").and_then(|r| serde_json::from_value::<mailvault_core::search_index::query::SearchRequest>(r.clone()).ok()) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing request"));
            };
            done(id, blocking(move || si::search_reply(&st, &request)).await.and_then(|r| r))
        }
        "vault_rows" => {
            let account = params.get("accountId").and_then(Value::as_str).map(str::to_owned);
            let mailbox = params.get("mailbox").and_then(Value::as_str).map(str::to_owned);
            let uids = params.get("uids").and_then(|u| serde_json::from_value::<Vec<u32>>(u.clone()).ok());
            let (Some(account), Some(mailbox), Some(uids)) = (account, mailbox, uids) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId, mailbox or uids"));
            };
            done(id, blocking(move || Value::Array(si::rows_reply(&st, &account, &mailbox, &uids))).await)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::ipc;
    use crate::server::DaemonState;
    use serde_json::json;

    fn st() -> (tempfile::TempDir, std::sync::Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true);
        (tmp, s)
    }

    async fn call(s: &std::sync::Arc<DaemonState>, method: &str, params: serde_json::Value) -> ipc::RpcResponse {
        super::route(s, method, &params, json!(1)).await.expect("routed")
    }

    #[tokio::test]
    async fn status_before_any_configure_is_unavailable_with_first_pass_done_false() {
        let (_t, s) = st();
        let r = call(&s, "search_index_status", json!({})).await.result.unwrap();
        assert_eq!(r["state"], "unavailable");
        assert_eq!(r["firstPassDone"], false);
    }

    #[tokio::test]
    async fn configure_off_answers_null_and_status_reports_off_without_a_file() {
        let (t, s) = st();
        let r = call(&s, "search_index_configure", json!({"config": {"enabled": false, "bodies": true, "attachments": false, "imageText": false}})).await;
        assert_eq!(r.result, Some(serde_json::Value::Null));
        assert_eq!(call(&s, "search_index_status", json!({})).await.result.unwrap()["state"], "off");
        assert!(!t.path().join("search_index").join("index.db").exists());
    }

    #[tokio::test]
    async fn configure_without_config_is_invalid_params() {
        let (_t, s) = st();
        assert_eq!(call(&s, "search_index_configure", json!({})).await.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn vault_search_on_a_closed_index_is_unavailable() {
        let (_t, s) = st();
        let r = call(&s, "vault_search", json!({"request": {"accountId": "a", "query": "x"}})).await.result.unwrap();
        assert_eq!(r, json!({"available": false}));
    }

    #[tokio::test]
    async fn vault_rows_needs_account_mailbox_and_uids() {
        let (_t, s) = st();
        assert_eq!(call(&s, "vault_rows", json!({"accountId": "a", "mailbox": "INBOX"})).await.error.unwrap().code, ipc::INVALID_PARAMS);
        assert_eq!(call(&s, "vault_rows", json!({"accountId": "a", "mailbox": "INBOX", "uids": [1]})).await.result.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn destroy_on_a_switching_index_is_busy() {
        let (_t, s) = st();
        assert_eq!(call(&s, "search_index_close", json!({})).await.result, Some(serde_json::Value::Null));
        assert_eq!(call(&s, "search_index_destroy", json!({})).await.result.unwrap(), json!({"ok": false, "error": "searchIndex.busy"}));
        assert_eq!(call(&s, "search_index_reopen", json!({})).await.result, Some(serde_json::Value::Null));
    }

    #[tokio::test]
    async fn rebuild_answers_null() {
        let (_t, s) = st();
        assert_eq!(call(&s, "search_index_rebuild", json!({})).await.result, Some(serde_json::Value::Null));
    }

    #[tokio::test]
    async fn search_index_methods_are_not_behind_the_mail_dir_gate() {
        let tmp = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        let resp = crate::server::handle_request_for_test(&s, "search_index_status", json!({})).await;
        assert_eq!(resp.result.unwrap()["state"], "unavailable");
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_t, s) = st();
        assert!(super::route(&s, "sync.now", &json!({}), json!(1)).await.is_none());
    }

    /// Review focus 1.6: "`vault_search` query errors surface as JSON-RPC
    /// errors". Drops the `messages` table out from under an otherwise
    /// available, first-pass-done index so `core::query::search`'s own
    /// `SELECT ... FROM messages` fails — the one way `search_reply` can
    /// return `Err` once past its `available`/`first_pass_done` guards.
    #[tokio::test]
    async fn vault_search_query_errors_surface_as_json_rpc_errors() {
        let (t, s) = st();
        {
            use mailvault_core::search_index::{db, lock};
            *lock(&s.search_index.db) = Some(db::open(t.path()).unwrap());
            *s.search_index.root.lock().unwrap() = Some(t.path().to_path_buf());
            let guard = lock(&s.search_index.db);
            let conn = guard.as_ref().unwrap();
            db::meta_set(conn, db::FIRST_PASS_DONE, "1").unwrap();
            conn.execute_batch("DROP TABLE messages;").unwrap();
        }
        let r = call(&s, "vault_search", json!({"request": {"accountId": "a", "query": "x"}})).await;
        assert_eq!(r.error.expect("a broken index must answer a JSON-RPC error, not a bare {available:false}").code, ipc::INTERNAL_ERROR);
    }
}
