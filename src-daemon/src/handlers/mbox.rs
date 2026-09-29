//! Daemon routes for `export_mbox_all`/`import_mbox` (Task 4.5), backed by
//! `crate::mbox`, moved from `src-tauri/src/main.rs`. **No cutover in this
//! task**: the Tauri commands in `main.rs` are untouched and still serve the
//! frontend; this router exists but nothing calls it yet. Task 4.6 deletes
//! the Tauri commands (including the dead `export_mbox`) and switches the
//! frontend to `daemon_rpc`.
//!
//! Every route runs on `spawn_blocking` (`common::blocking`): a full mbox
//! read-or-write pass is disk I/O end to end and must never run on a tokio
//! worker. `mbox_probe` reads a bounded head of the file for the import
//! options dialog; `import_mbox` takes its `mode`, `useLabels` and
//! `fallbackMailbox`.

use crate::handlers::common::{blocking, done, opt_str_arg, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::mbox;
use crate::server::DaemonState;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// The answer to an import mode whose backend has not landed yet; the app
/// shows `errors.E_MBOX_MODE_UNAVAILABLE` for it.
const E_MBOX_MODE_UNAVAILABLE: &str = "E_MBOX_MODE_UNAVAILABLE";

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
            // `mode`: "local" (the default) files into the account's vault
            // folders; "server" and "folder" land in later tasks (R1).
            match params.get("mode").filter(|m| !m.is_null()).map_or(Some("local"), Value::as_str) {
                Some("local") => {}
                Some(m @ ("server" | "folder")) => {
                    let msg = format!("{E_MBOX_MODE_UNAVAILABLE}: import mode {m} is not available yet");
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, msg));
                }
                _ => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Unknown mode {}", params["mode"]))),
            }
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let use_labels = params.get("useLabels").and_then(Value::as_bool).unwrap_or(false);
            // With labels, what has no folder of its own goes to
            // `fallbackMailbox`, else to `mailbox`.
            let mailbox = if use_labels { opt_str_arg(params, "fallbackMailbox").unwrap_or(mailbox) } else { mailbox };

            let state = Arc::clone(state);
            let result: Result<Value, String> = blocking(move || -> Result<Value, String> {
                let emit = bus_emit(&state);
                let out = mbox::import_mbox(&state, PathBuf::from(&source_path), account_id, mailbox, use_labels, emit)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            })
            .await
            .and_then(|r| r);

            match result {
                Ok(v) => RpcResponse::success(id, v),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }
        "mbox_probe" => {
            let source_path = req!(str_arg(&id, params, "sourcePath"));
            let account_id = req!(str_arg(&id, params, "accountId"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let out = mbox::probe_mbox(&state, std::path::Path::new(&source_path), &account_id)?;
                    serde_json::to_value(out).map_err(|e| e.to_string())
                })
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

    // -- mode, useLabels, fallbackMailbox; mbox_probe -----------------------

    fn save_listing(s: &Arc<DaemonState>, paths: &[&str]) {
        let list: Vec<Value> = paths.iter().map(|p| json!({"name": p, "path": p, "specialUse": null, "flags": [], "delimiter": "/"})).collect();
        let listing = json!({"mailboxes": list}).to_string();
        crate::custody::with_conn(s, |c| mailvault_core::custody::cache::save_mailboxes(c, "acct1", &listing)).unwrap();
    }

    /// An mbox of messages with these `X-Gmail-Labels` values (`""`: no header).
    fn takeout(dir: &std::path::Path, labels: &[&str]) -> String {
        let mut out = String::new();
        for (i, l) in labels.iter().enumerate() {
            let header = if l.is_empty() { String::new() } else { format!("X-Gmail-Labels: {l}\r\n") };
            out.push_str(&format!("From x@y Mon Jan  1 00:00:00 2026\n{header}Message-ID: <{i}@x>\r\nSubject: m{i}\r\n\r\nbody {i}\n\n"));
        }
        let path = dir.join(format!("{}.mbox", uuid::Uuid::new_v4()));
        std::fs::write(&path, out).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn count_in(root: &std::path::Path, mailbox: &str) -> usize {
        std::fs::read_dir(mailvault_core::vault_files::cur_path(root, "acct1", mailbox)).map_or(0, |d| d.count())
    }

    #[tokio::test]
    async fn use_labels_routes_by_label_and_sends_the_rest_to_the_fallback_mailbox() {
        let (v, _a, s) = st(true);
        save_listing(&s, &["INBOX", "Work", "Archive"]);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work,Opened", "Ghost"]);
        let resp = call(&s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mailbox": "INBOX", "fallbackMailbox": "Archive", "useLabels": true})).await;
        let result = resp.result.expect("import_mbox must succeed");
        assert_eq!(result["emailCount"], json!(2));
        assert_eq!(result["foldersKnown"], json!(true));
        assert_eq!(
            result["folders"],
            json!([{"mailbox": "Work", "imported": 1, "skipped": 0}, {"mailbox": "Archive", "imported": 1, "skipped": 0}])
        );
        assert_eq!((count_in(v.path(), "Work"), count_in(v.path(), "Archive"), count_in(v.path(), "INBOX")), (1, 1, 0));
    }

    #[tokio::test]
    async fn use_labels_without_a_fallback_mailbox_falls_back_to_mailbox() {
        let (v, _a, s) = st(true);
        save_listing(&s, &["INBOX", "Work"]);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work", "Ghost"]);
        let resp = call(&s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mailbox": "Old Mail", "useLabels": true})).await;
        assert_eq!(resp.result.expect("import_mbox must succeed")["mailbox"], json!("Old Mail"));
        assert_eq!((count_in(v.path(), "Work"), count_in(v.path(), "Old Mail")), (1, 1));
    }

    #[tokio::test]
    async fn use_labels_without_a_cached_listing_sends_everything_to_the_fallback() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work", "Sent"]);
        let resp = call(&s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mailbox": "INBOX", "fallbackMailbox": "Archive", "useLabels": true})).await;
        let result = resp.result.expect("import_mbox must succeed");
        assert_eq!(result["foldersKnown"], json!(false));
        assert_eq!(result["folders"], json!([{"mailbox": "Archive", "imported": 2, "skipped": 0}]));
        assert_eq!((count_in(v.path(), "Archive"), count_in(v.path(), "INBOX"), count_in(v.path(), "Work")), (2, 0, 0));
    }

    /// The old call shape files everything in `mailbox`, labels or not, and an
    /// omitted `mailbox` is INBOX.
    #[tokio::test]
    async fn the_old_call_shape_ignores_labels_and_an_omitted_mailbox_is_inbox() {
        let (v, _a, s) = st(true);
        save_listing(&s, &["INBOX", "Work", "Receipts"]);
        let dir = tempfile::tempdir().unwrap();
        let resp = call(&s, "import_mbox", json!({"sourcePath": takeout(dir.path(), &["Work"]), "accountId": "acct1", "mailbox": "Receipts"})).await;
        let result = resp.result.expect("import_mbox must succeed");
        assert_eq!(result["folders"], json!([{"mailbox": "Receipts", "imported": 1, "skipped": 0}]));
        assert_eq!((count_in(v.path(), "Receipts"), count_in(v.path(), "Work")), (1, 0));

        let resp = call(&s, "import_mbox", json!({"sourcePath": takeout(dir.path(), &[""]), "accountId": "acct1"})).await;
        assert_eq!(resp.result.expect("mailbox is optional")["mailbox"], json!("INBOX"));
        assert_eq!(count_in(v.path(), "INBOX"), 1);
    }

    /// R1: modes whose backends land later answer with a code the app maps to
    /// a catalog key, before touching the file or the vault.
    #[tokio::test]
    async fn modes_not_built_yet_answer_with_their_code_and_write_nothing() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work"]);
        for mode in ["server", "folder"] {
            let resp = call(&s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mailbox": "INBOX", "mode": mode})).await;
            let err = resp.error.unwrap_or_else(|| panic!("mode {mode} must be refused"));
            assert!(err.message.starts_with("E_MBOX_MODE_UNAVAILABLE:"), "{}", err.message);
        }
        assert!(!mailvault_core::vault_files::account_dir(&v.path().join("Maildir"), "acct1").exists(), "nothing was imported");
        let resp = call(&s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mailbox": "INBOX", "mode": "local"})).await;
        assert_eq!(resp.result.expect("local is today's import")["emailCount"], json!(1));
    }

    #[tokio::test]
    async fn an_unknown_mode_is_invalid_params_and_writes_nothing() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work"]);
        for mode in [json!("restore"), json!(3)] {
            let resp = call(&s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mailbox": "INBOX", "mode": mode})).await;
            assert_eq!(resp.error.unwrap_or_else(|| panic!("mode {mode} must be refused")).code, ipc::INVALID_PARAMS);
        }
        assert!(!mailvault_core::vault_files::account_dir(&v.path().join("Maildir"), "acct1").exists(), "nothing was imported");
    }

    #[tokio::test]
    async fn mbox_probe_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(&s, "mbox_probe", json!({"sourcePath": "/nonexistent-xyz.mbox", "accountId": "a1"})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "mbox_probe did not reach handlers::mbox::route");
    }

    #[tokio::test]
    async fn mbox_probe_reports_size_labels_and_whether_the_folders_are_known() {
        let (_v, _a, s) = st(true);
        save_listing(&s, &["INBOX", "Work"]);
        let dir = tempfile::tempdir().unwrap();
        let labelled = takeout(dir.path(), &["", "Inbox,Opened"]);
        let resp = call(&s, "mbox_probe", json!({"sourcePath": labelled, "accountId": "acct1"})).await;
        let size = std::fs::metadata(&labelled).unwrap().len();
        assert_eq!(resp.result.expect("probe"), json!({"bytes": size, "hasLabels": true, "foldersKnown": true, "sampledMessages": 2}));

        let plain = takeout(dir.path(), &["", "", ""]);
        let resp = call(&s, "mbox_probe", json!({"sourcePath": plain, "accountId": "no-listing"})).await;
        let result = resp.result.expect("probe");
        assert_eq!((result["hasLabels"].clone(), result["foldersKnown"].clone(), result["sampledMessages"].clone()), (json!(false), json!(false), json!(3)));
    }

    #[tokio::test]
    async fn mbox_probe_missing_source_path_is_invalid_params() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "mbox_probe", json!({"accountId": "acct1"})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }
}
