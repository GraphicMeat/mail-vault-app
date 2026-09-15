//! The op journal and pending-operation persistence (Task 2.7). Rooted at
//! `state.app_dir`, NOT the vault: the vault is relocatable and can be an
//! external volume absent at launch, which is exactly when a replay needs to
//! read this — so these routes are UNGATED (spec deviation 7 only lists
//! vault-rooted routes behind `common::vault_root`; these never call it).
//!
//! `op_journal_queue`/`op_journal_clear` do their own load-modify-write over
//! `pending_ops.json` (`mailvault_core::op_journal::{queue,clear}`) with no
//! lock of their own — safe when the app called them one at a time on its
//! main thread, but these routes run on `spawn_blocking`, so two concurrent
//! calls (a bulk flag change queues one `op_journal_queue` per message in a
//! loop) can race: both load the same on-disk journal, both append, and the
//! second write clobbers the first's entry. `DaemonState.journal` is a
//! `std::sync::Mutex<()>` spanning the ENTIRE `queue`/`clear` call (load
//! through write), held only across sync file I/O, never a tokio `.await`.
//! `op_journal_read` needs no lock: every write already goes through
//! `fsx::write_atomic`, so a concurrent reader only ever sees a complete
//! journal, old or new, never a torn one.
use crate::handlers::common::{blocking, done, str_arg, vec_arg};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::op_journal::{self, OpEntry};
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

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "op_journal_queue" => {
            let Some(entry) = params.get("entry").and_then(|e| serde_json::from_value::<OpEntry>(e.clone()).ok()) else {
                return Some(RpcResponse::error(id, crate::ipc::INVALID_PARAMS, "Missing entry"));
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let _lock = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                    std::fs::create_dir_all(&state.app_dir).map_err(|e| format!("Failed to create data directory: {e}"))?;
                    op_journal::queue(&state.app_dir, entry).map(|id| Value::from(id))
                })
                .await
                .and_then(|r| r),
            )
        }
        "op_journal_clear" => {
            let op = req!(str_arg(&id, params, "op"));
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let arg = params.get("arg").cloned().unwrap_or(Value::Null);
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let _lock = state.journal.lock().unwrap_or_else(|p| p.into_inner());
                    op_journal::clear(&state.app_dir, &op, &account_id, &mailbox, &uids, &arg).map(|_| Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "op_journal_read" => {
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    serde_json::to_value(op_journal::read(&state.app_dir)).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "read_pending_operation" => {
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    op_journal::pending_operation_read(&state.app_dir).map(|v| v.unwrap_or(Value::Null))
                })
                .await
                .and_then(|r| r),
            )
        }
        "save_pending_operation" => {
            let Some(operation) = params.get("operation").cloned() else {
                return Some(RpcResponse::error(id, crate::ipc::INVALID_PARAMS, "Missing operation"));
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    op_journal::pending_operation_save(&state.app_dir, &operation).map(|_| Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "clear_pending_operation" => {
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> { op_journal::pending_operation_clear(&state.app_dir).map(|_| Value::Null) })
                    .await
                    .and_then(|r| r),
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        // mail_dir_ok = false: these routes must work even when the vault
        // itself is unreachable — they are rooted at app_dir, never the vault.
        let s = DaemonState::for_test(tmp.path().join("vault"), tmp.path().to_path_buf(), false);
        (tmp, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn entry(uids: &[u32]) -> Value {
        json!({"id": 0, "op": "delete", "accountId": "a", "mailbox": "INBOX", "uids": uids, "arg": {}, "at": 0})
    }

    #[tokio::test]
    async fn journal_routes_are_not_gated_by_mail_dir_ok() {
        let (_t, s) = st(); // mail_dir_ok = false
        let r = call(&s, "op_journal_queue", json!({"entry": entry(&[1])})).await;
        assert!(r.error.is_none(), "{:?}", r.error);
    }

    #[tokio::test]
    async fn queue_then_read_then_clear_round_trips() {
        let (_t, s) = st();
        let id1 = call(&s, "op_journal_queue", json!({"entry": entry(&[1, 2])})).await.result.unwrap();
        assert_eq!(id1, json!(0));
        let read = call(&s, "op_journal_read", json!({})).await.result.unwrap();
        assert_eq!(read.as_array().unwrap().len(), 1);
        assert_eq!(read[0]["uids"], json!([1, 2]));

        call(&s, "op_journal_clear", json!({"op": "delete", "accountId": "a", "mailbox": "INBOX", "uids": [1, 2], "arg": {}})).await;
        let read = call(&s, "op_journal_read", json!({})).await.result.unwrap();
        assert_eq!(read.as_array().unwrap().len(), 0, "an entry with no uids left must be dropped");
    }

    /// Task 2.7 Step 1: RED without `DaemonState.journal` — 50 concurrent
    /// `op_journal_queue` calls (one bulk flag change queuing one entry per
    /// message, `messageMutations.js`) must keep all 50 entries. Run with the
    /// mutex acquisition inside the route removed (temporarily, on the
    /// runner copy only) this loses entries to the classic load-modify-write
    /// race; with it, none are lost.
    #[tokio::test]
    async fn fifty_concurrent_queues_keep_fifty_entries() {
        let (_t, s) = st();
        let mut tasks = Vec::new();
        for uid in 0..50u32 {
            let s = Arc::clone(&s);
            tasks.push(tokio::spawn(async move {
                call(&s, "op_journal_queue", json!({"entry": entry(&[uid])})).await
            }));
        }
        for t in tasks {
            let r = t.await.unwrap();
            assert!(r.error.is_none(), "{:?}", r.error);
        }
        let read = call(&s, "op_journal_read", json!({})).await.result.unwrap();
        assert_eq!(read.as_array().unwrap().len(), 50, "every queued entry must survive concurrent queuing");
    }

    #[tokio::test]
    async fn pending_operation_round_trips() {
        let (_t, s) = st();
        assert_eq!(call(&s, "read_pending_operation", json!({})).await.result, Some(Value::Null));
        call(&s, "save_pending_operation", json!({"operation": {"kind": "bulkDelete", "uids": [1, 2]}})).await;
        let read = call(&s, "read_pending_operation", json!({})).await.result.unwrap();
        assert_eq!(read["kind"], json!("bulkDelete"));
        call(&s, "clear_pending_operation", json!({})).await;
        assert_eq!(call(&s, "read_pending_operation", json!({})).await.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_t, s) = st();
        assert!(route(&s, "sync.now", &json!({}), json!(1)).await.is_none());
    }
}
