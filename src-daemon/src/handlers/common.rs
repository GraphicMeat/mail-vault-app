//! Shared plumbing for every Phase 2 router (`vault_files`, `cache`, `journal`,
//! `custody`, `vault_flags`, Tasks 2.6-2.9a): the blocking-task helper (moved
//! here from `handlers/search_index.rs`, which now imports it back), the
//! vault-unavailable gate, and small arg extractors.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Run `f` on a blocking-pool thread. Every Phase 2 handler touches disk, or a
/// mutex that guards disk work, so it never runs on a tokio worker.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Task join error: {e}"))
}

pub(crate) fn done(id: Value, r: Result<Value, String>) -> RpcResponse {
    match r {
        Ok(v) => RpcResponse::success(id, v),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// The exact message text every `E_VAULT_UNAVAILABLE:` gate answers with —
/// callers (JS and Rust) match on this prefix verbatim (Global constraints:
/// "Same JSON in/out" / error texts callers match on).
fn gate_message(reason: &str) -> String {
    format!("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: {reason}")
}

/// The gate every vault-rooted Phase 2 route calls before touching disk (spec
/// deviation 7). Never falls back to `state.app_dir`: a vault-rooted route
/// that did would silently start a second, divergent archive there when the
/// configured folder is unreachable.
pub(crate) fn vault_root(state: &Arc<DaemonState>) -> Result<PathBuf, String> {
    if !state.mail_dir_ok {
        return Err(gate_message("the folder is not reachable"));
    }
    if state.vault_closed.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(gate_message("the vault is being moved"));
    }
    Ok(state.data_dir.clone())
}

/// I3 fix (Task 2.5 fix round 1): `vault_root` alone is check-then-act — a
/// route that reads the root and only then writes can still be running when
/// `vault_close` returns, so a move can copy a store the daemon is still
/// writing into. Every Phase 2 write route (Tasks 2.6-2.9a) must go through
/// this instead of a bare `vault_root` call: it takes `vault_gate`'s read
/// side (shared across concurrent writers), re-checks `vault_root` under the
/// lock, then runs `f` with the root — `vault_close` takes the gate's write
/// side to wait out every writer already inside `f` before it closes the
/// index. MUST run on a blocking thread (`handlers::common::blocking` /
/// `spawn_blocking`): `vault_gate` is a `std::sync::RwLock` and must never be
/// held across a tokio `.await`. A job spanning many files/mailboxes calls
/// this once per file or per mailbox batch, re-checking each time, rather
/// than once around the whole job — otherwise a move would wait out the
/// entire job instead of just the current batch.
pub(crate) fn with_vault_write<T>(state: &Arc<DaemonState>, f: impl FnOnce(&std::path::Path) -> Result<T, String>) -> Result<T, String> {
    let _gate = state.vault_gate.read().unwrap_or_else(|p| p.into_inner());
    let root = vault_root(state)?;
    f(&root)
}

/// A required string param. `Err` names the missing key, as `INVALID_PARAMS`.
pub(crate) fn str_arg(id: &Value, params: &Value, key: &str) -> Result<String, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// An optional string param — absent or non-string both read as `None`.
pub(crate) fn opt_str_arg(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// An optional f64 param (`list_cached_uids`'s `sinceMs`) — absent or
/// non-numeric both read as `None`.
pub(crate) fn opt_f64_arg(params: &Value, key: &str) -> Option<f64> {
    params.get(key).and_then(Value::as_f64)
}

/// A required u32 param (JSON numbers arrive as u64; every uid fits u32).
pub(crate) fn u32_arg(id: &Value, params: &Value, key: &str) -> Result<u32, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// A required array param, deserialized element-wise (uid lists, change lists).
pub(crate) fn vec_arg<T: serde::de::DeserializeOwned>(id: &Value, params: &Value, key: &str) -> Result<Vec<T>, RpcResponse> {
    params
        .get(key)
        .and_then(|v| serde_json::from_value::<Vec<T>>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(mail_dir_ok: bool) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-common-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, mail_dir_ok)
    }

    #[test]
    fn vault_root_refuses_an_unreachable_folder() {
        let st = state(false);
        let err = vault_root(&st).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("not reachable"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn vault_root_refuses_while_the_vault_is_closed_for_a_move() {
        let st = state(true);
        st.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = vault_root(&st).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn vault_root_succeeds_when_ok_and_not_closed() {
        let st = state(true);
        assert_eq!(vault_root(&st).unwrap(), st.data_dir);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// Task 2.7 (2.3 review F1): cache handlers must pass the IDENTICAL
    /// `PathBuf` `sync_engine` writes into — the header-cache lock registry
    /// (`mailvault_core::header_cache::lock_tree`/`lock_mailbox`) keys on the
    /// raw path, so two spellings of the same root (e.g. one with a trailing
    /// component resolved differently) would silently give a cache handler
    /// and a sync write two different locks over one directory.
    ///
    /// Task 2.8 carry-in (2.7 review I2): the original version of this test
    /// used `state(true)`, whose helper wires one tempdir as both `mail_dir`
    /// and `app_dir` — so `vault_root` and `sync_engine.data_dir()` compared
    /// equal whether `vault_root` correctly returned `data_dir` OR incorrectly
    /// returned `app_dir`. Two distinct real tempdirs here so the assertion
    /// can actually fail on that bug.
    #[test]
    fn vault_root_and_sync_engines_root_are_the_same_path() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let st = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        assert_eq!(vault_root(&st).unwrap(), st.sync_engine.data_dir());
        assert_eq!(vault_root(&st).unwrap(), vault.path());
    }

    #[test]
    fn str_arg_names_the_missing_key() {
        let err = str_arg(&json!(1), &json!({}), "accountId").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("accountId"), "{}", error.message);
    }

    #[test]
    fn str_arg_reads_a_present_value() {
        assert_eq!(str_arg(&json!(1), &json!({"accountId": "a1"}), "accountId").unwrap(), "a1");
    }

    #[test]
    fn opt_str_arg_is_none_when_absent() {
        assert_eq!(opt_str_arg(&json!({}), "mailbox"), None);
        assert_eq!(opt_str_arg(&json!({"mailbox": "INBOX"}), "mailbox"), Some("INBOX".to_string()));
    }

    #[test]
    fn u32_arg_names_the_missing_key() {
        let err = u32_arg(&json!(1), &json!({}), "uid").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("uid"), "{}", error.message);
        assert_eq!(u32_arg(&json!(1), &json!({"uid": 7}), "uid").unwrap(), 7);
    }

    #[test]
    fn vec_arg_names_the_missing_key() {
        let err = vec_arg::<u32>(&json!(1), &json!({}), "uids").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("uids"), "{}", error.message);
        assert_eq!(vec_arg::<u32>(&json!(1), &json!({"uids": [1, 2]}), "uids").unwrap(), vec![1, 2]);
    }

    // -----------------------------------------------------------------------
    // Task 2.5 fix round 1 (I3): with_vault_write
    // -----------------------------------------------------------------------

    #[test]
    fn with_vault_write_runs_the_closure_with_the_vault_root() {
        let st = state(true);
        let root = with_vault_write(&st, |root| Ok(root.to_path_buf())).unwrap();
        assert_eq!(root, st.data_dir);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn with_vault_write_refuses_while_the_vault_is_closed_for_a_move() {
        let st = state(true);
        st.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = with_vault_write(&st, |_root| Ok(())).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// The other half of the drain lives in `handlers::search_index`'s
    /// `vault_close` route, tested end-to-end there against a real writer
    /// blocked inside `with_vault_write`; this only proves the primitive
    /// itself blocks a concurrent write side.
    #[test]
    fn with_vault_write_holds_the_gate_for_the_closures_duration() {
        let st = state(true);
        let order = Arc::new(std::sync::Mutex::new(Vec::<&str>::new()));
        let order2 = Arc::clone(&order);
        let st2 = Arc::clone(&st);
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn(move || {
            with_vault_write(&st2, |_root| {
                order2.lock().unwrap().push("writer-in");
                release_rx.recv().ok();
                order2.lock().unwrap().push("writer-out");
                Ok::<(), String>(())
            })
        });
        // Give the writer a chance to actually enter the closure first.
        while order.lock().unwrap().is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let drain_order = Arc::clone(&order);
        let st3 = Arc::clone(&st);
        let drainer = std::thread::spawn(move || {
            let _write_guard = st3.vault_gate.write().unwrap_or_else(|p| p.into_inner());
            drain_order.lock().unwrap().push("drain-acquired");
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(*order.lock().unwrap(), vec!["writer-in"], "the drain must not proceed while the writer is inside with_vault_write");
        release_tx.send(()).unwrap();
        writer.join().unwrap().unwrap();
        drainer.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["writer-in", "writer-out", "drain-acquired"]);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }
}
