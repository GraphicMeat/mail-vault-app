//! Daemon routes for `export_mbox_all`/`import_mbox` (Task 4.5), backed by
//! `crate::mbox`, moved from `src-tauri/src/main.rs`. **No cutover in this
//! task**: the Tauri commands in `main.rs` are untouched and still serve the
//! frontend; this router exists but nothing calls it yet. Task 4.6 deletes
//! the Tauri commands (including the dead `export_mbox`) and switches the
//! frontend to `daemon_rpc`.
//!
//! Both routes run on `spawn_blocking` (`common::blocking`): a full mbox
//! read-or-write pass is disk I/O end to end and must never run on a tokio
//! worker.

use crate::handlers::common::{blocking, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::mbox;
use crate::server::DaemonState;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

fn bus_emit(state: &Arc<DaemonState>) -> impl Fn(&str, Value) {
    let bus = state.events.clone();
    move |name: &str, payload: Value| {
        bus.emit(name, payload);
    }
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "export_mbox_all" => {
            let dest_path = req!(str_arg(&id, params, "destPath"));
            let archived_only = params.get("archivedOnly").and_then(Value::as_bool).unwrap_or(false);

            let state = Arc::clone(state);
            let result: Result<Value, String> = blocking(move || -> Result<Value, String> {
                let emit = bus_emit(&state);
                let out = mbox::export_mbox_all(&state, PathBuf::from(&dest_path), archived_only, emit)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            })
            .await
            .and_then(|r| r);

            match result {
                Ok(v) => RpcResponse::success(id, v),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }
        "import_mbox" => {
            let source_path = req!(str_arg(&id, params, "sourcePath"));
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));

            let state = Arc::clone(state);
            let result: Result<Value, String> = blocking(move || -> Result<Value, String> {
                let emit = bus_emit(&state);
                let out = mbox::import_mbox(&state, PathBuf::from(&source_path), account_id, mailbox, emit)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            })
            .await
            .and_then(|r| r);

            match result {
                Ok(v) => RpcResponse::success(id, v),
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
    use serde_json::json;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), mail_dir_ok);
        (vault, app_dir, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str]) {
        let flags: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
        let cur = mailvault_core::vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(mailvault_core::vault_files::build_maildir_filename(uid, &flags)), b"body").unwrap();
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, _a, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn export_mbox_all_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(&s, "export_mbox_all", json!({"destPath": "/nonexistent-dir-xyz/out.mbox", "archivedOnly": false})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "export_mbox_all did not reach handlers::mbox::route");
    }

    #[tokio::test]
    async fn export_mbox_all_writes_a_mbox_file_and_returns_counts() {
        let (v, _a, s) = st(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"]);
        let dest = v.path().parent().unwrap().join(format!("out-{}.mbox", uuid::Uuid::new_v4()));

        let resp = call(&s, "export_mbox_all", json!({"destPath": dest.to_string_lossy(), "archivedOnly": false})).await;

        let result = resp.result.expect("export_mbox_all must succeed");
        assert_eq!(result["emailCount"], json!(1));
        assert_eq!(result["accountCount"], json!(1));
        assert!(dest.exists());
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    async fn export_mbox_all_missing_dest_path_is_invalid_params() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "export_mbox_all", json!({})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn import_mbox_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(&s, "import_mbox", json!({"sourcePath": "/nonexistent-xyz.mbox", "accountId": "a1", "mailbox": "INBOX"})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "import_mbox did not reach handlers::mbox::route");
    }

    /// Decision 3, at the route level: an imported message carries the
    /// archived flag in its written filename and lands under the vault root
    /// the gate was given (route-level counterpart to `mbox.rs`'s own
    /// `imported_message_survives_clear_cache` test, which proves the same
    /// fix directly against `vault_files::clear_cache`).
    #[tokio::test]
    async fn import_mbox_writes_under_the_gate_with_the_archived_flag_and_returns_correct_counts() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = dir.path().join("in.mbox");
        std::fs::write(&mbox_path, "From sender@test.com Mon Jan  1 00:00:00 2026\nSubject: hi\r\n\r\nbody\n\n").unwrap();

        let resp = call(&s, "import_mbox", json!({"sourcePath": mbox_path.to_string_lossy(), "accountId": "acct1", "mailbox": "INBOX"})).await;

        let result = resp.result.expect("import_mbox must succeed");
        assert_eq!(result["emailCount"], json!(1));
        assert_eq!(result["accountId"], json!("acct1"));
        assert_eq!(result["mailbox"], json!("INBOX"));

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        let names: Vec<String> = std::fs::read_dir(&cur).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].contains(&format!("{}A", mailvault_core::maildir::INFO_PREFIX)), "{:?}", names);
    }

    #[tokio::test]
    async fn import_mbox_missing_account_id_is_invalid_params() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "import_mbox", json!({"sourcePath": "/tmp/x.mbox", "mailbox": "INBOX"})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }
}
