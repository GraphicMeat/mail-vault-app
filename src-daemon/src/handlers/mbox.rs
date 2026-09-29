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
//! `fallbackMailbox`. `list_local_folders` and `delete_local_folder` read and
//! remove the vault-only folders `mode: "folder"` makes.

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
            // folders; "folder" into a new vault-only folder, and nothing
            // below it applies; "server" lands in a later task (R1).
            let as_folder = match params.get("mode").filter(|m| !m.is_null()).map_or(Some("local"), Value::as_str) {
                Some("local") => false,
                Some("folder") => true,
                Some(m @ "server") => {
                    let msg = format!("{E_MBOX_MODE_UNAVAILABLE}: import mode {m} is not available yet");
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, msg));
                }
                _ => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Unknown mode {}", params["mode"]))),
            };
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let use_labels = params.get("useLabels").and_then(Value::as_bool).unwrap_or(false);
            // With labels, what has no folder of its own goes to
            // `fallbackMailbox`, else to `mailbox`.
            let mailbox = if use_labels { opt_str_arg(params, "fallbackMailbox").unwrap_or(mailbox) } else { mailbox };

            let state = Arc::clone(state);
            let result: Result<Value, String> = blocking(move || -> Result<Value, String> {
                let emit = bus_emit(&state);
                let source = PathBuf::from(&source_path);
                let out = if as_folder {
                    mbox::import_mbox_as_folder(&state, source, account_id, emit)?
                } else {
                    mbox::import_mbox(&state, source, account_id, mailbox, use_labels, emit)?
                };
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
        "list_local_folders" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let state = Arc::clone(state);
            done(id, blocking(move || mbox::list_local_folders(&state, &account_id)).await.and_then(|r| r))
        }
        "delete_local_folder" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let name = req!(str_arg(&id, params, "name"));
            done(id, mbox::delete_local_folder(state, &account_id, &name).await)
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
    /// a catalog key, before touching the file or the vault. "folder" landed
    /// with Task 5 and is tested below.
    #[tokio::test]
    async fn modes_not_built_yet_answer_with_their_code_and_write_nothing() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work"]);
        for mode in ["server"] {
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

    // -- mode "folder": vault-only local folders ------------------------------

    use mailvault_core::app_db::{self, deleted as bin};
    use mailvault_core::local_folder;
    use mailvault_core::maildir::IMPORT_UID_BASE;
    use mailvault_core::search_index::text::vault_dir_name;
    use std::path::Path;

    /// The folder an import makes today: display name and vault dir.
    fn today_folder() -> (String, String) {
        let day = chrono::Local::now().format("%Y-%m-%d").to_string();
        (format!("MBOX import {day}"), format!("MBOX_import_{day}"))
    }

    fn account_dir(root: &Path) -> std::path::PathBuf {
        mailvault_core::vault_files::account_dir(&root.join("Maildir"), "acct1")
    }

    fn msg_with_id(id: &str, subject: &str) -> String {
        format!("Message-ID: <{id}>\r\nSubject: {subject}\r\n\r\nbody of {subject}")
    }

    /// A folder as an import leaves it: a marker of `kind`, and `bodies` at
    /// the import uids, archived.
    fn local_folder_with(root: &Path, name: &str, kind: &str, bodies: &[&str]) -> String {
        let cur = mailvault_core::vault_files::cur_path(root, "acct1", name);
        std::fs::create_dir_all(&cur).unwrap();
        for (i, body) in bodies.iter().enumerate() {
            let file = mailvault_core::vault_files::build_maildir_filename(IMPORT_UID_BASE + i as u32, &["archived".to_string()]);
            std::fs::write(cur.join(file), body).unwrap();
        }
        let marker = local_folder::Marker { kind: kind.into(), name: name.into(), created: 42, source: "t.mbox".into() };
        local_folder::write_marker(cur.parent().unwrap(), &marker).unwrap();
        vault_dir_name(name)
    }

    /// `(uid, file name, bytes)` of each message in the folder's `cur/`, by uid.
    fn files_in(root: &Path, dir: &str) -> Vec<(u32, String, Vec<u8>)> {
        let cur = account_dir(root).join(dir).join("cur");
        let mut out: Vec<_> = std::fs::read_dir(cur)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                Some((mailvault_core::maildir::vault_filename_uid(&name)?, name, std::fs::read(e.path()).unwrap()))
            })
            .collect();
        out.sort();
        out
    }

    async fn import_as_folder(s: &Arc<DaemonState>, src: &str) -> Value {
        call(s, "import_mbox", json!({"sourcePath": src, "accountId": "acct1", "mode": "folder"})).await.result.expect("a folder import")
    }

    async fn listed(s: &Arc<DaemonState>) -> Value {
        call(s, "list_local_folders", json!({"accountId": "acct1"})).await.result.expect("a listing")
    }

    async fn delete_folder(s: &Arc<DaemonState>, name: &str) -> RpcResponse {
        call(s, "delete_local_folder", json!({"accountId": "acct1", "name": name})).await
    }

    fn err_of(resp: RpcResponse) -> String {
        resp.error.expect("must be refused").message
    }

    fn binned(s: &Arc<DaemonState>) -> Vec<bin::Deleted> {
        app_db::with(&s.app_dir, |c| bin::list(c, &s.app_dir)).unwrap()
    }

    /// Mode 3: a new folder of its own with its marker, every message in it
    /// at an import uid with `A` only (labels are not read in this mode), and
    /// nothing in the account's other folders.
    #[tokio::test]
    async fn a_folder_import_fills_a_new_marked_folder_from_the_import_base() {
        let (v, _a, s) = st(true);
        save_listing(&s, &["INBOX", "Work"]);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["Work,Starred,Opened", ""]);
        let before = mailvault_core::vault_layout::now_millis();
        let r = import_as_folder(&s, &src).await;
        let (name, fdir) = today_folder();
        assert_eq!(r["folder"], json!({"name": name, "dir": fdir}));
        assert_eq!((r["emailCount"].clone(), r["skippedCount"].clone()), (json!(2), json!(0)));
        assert_eq!(r["folders"], json!([{"mailbox": name, "imported": 2, "skipped": 0}]));

        let files = files_in(v.path(), &fdir);
        assert_eq!(files.iter().map(|f| f.0).collect::<Vec<_>>(), vec![IMPORT_UID_BASE, IMPORT_UID_BASE + 1]);
        for (_, file, _) in &files {
            assert_eq!(mailvault_core::maildir::info_flags(file), Some("A.eml"), "{file}");
        }
        assert_eq!((count_in(v.path(), "Work"), count_in(v.path(), "INBOX")), (0, 0), "labels are not read in this mode");

        let marker = local_folder::read_marker(&account_dir(v.path()), &fdir).unwrap().expect("marked");
        let source = Path::new(&src).file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!((marker.kind.as_str(), marker.name.as_str(), marker.source.as_str()), ("import", name.as_str(), source.as_str()));
        assert!(marker.created >= before && marker.created <= mailvault_core::vault_layout::now_millis());
    }

    /// Each run makes its own folder, so the same file imports again in full
    /// (a new folder is a new dedupe scope) and the first folder is left alone.
    #[tokio::test]
    async fn importing_a_file_again_as_a_folder_fills_the_next_folder_of_the_day() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let src = takeout(dir.path(), &["", ""]);
        let first = import_as_folder(&s, &src).await;
        let again = import_as_folder(&s, &src).await;
        let (name, fdir) = today_folder();
        assert_eq!(first["folder"], json!({"name": name, "dir": fdir}));
        assert_eq!(again["folder"], json!({"name": format!("{name} 2"), "dir": format!("{fdir}_2")}));
        assert_eq!((again["emailCount"].clone(), again["skippedCount"].clone()), (json!(2), json!(0)));
        assert_eq!(files_in(v.path(), &fdir).len(), 2);
        assert_eq!(files_in(v.path(), &fdir), files_in(v.path(), &format!("{fdir}_2")), "the same uids and bytes, each folder its own");
    }

    /// A directory already at the sanitized name, here a server folder that
    /// happens to be called "MBOX import <today>", is never reused.
    #[tokio::test]
    async fn a_folder_import_steps_past_a_directory_already_at_its_name() {
        let (v, _a, s) = st(true);
        let (name, fdir) = today_folder();
        seed_file(v.path(), "acct1", &name, 7, &["S"]);
        let dir = tempfile::tempdir().unwrap();
        let r = import_as_folder(&s, &takeout(dir.path(), &[""])).await;
        assert_eq!(r["folder"], json!({"name": format!("{name} 2"), "dir": format!("{fdir}_2")}));
        assert_eq!(files_in(v.path(), &fdir).iter().map(|f| f.0).collect::<Vec<_>>(), vec![7], "the server folder keeps its one message");
        assert!(!account_dir(v.path()).join(&fdir).join(local_folder::MARKER_FILE).exists(), "and gets no marker");
    }

    /// The file is opened before a folder is made, and an import that fails
    /// before any message lands takes its empty folder with it.
    #[tokio::test]
    async fn a_folder_import_that_fails_leaves_no_folder_behind() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        // A directory opens on Unix and fails on its first read; elsewhere it
        // fails to open.
        for src in [dir.path().join("missing.mbox"), dir.path().to_path_buf()] {
            let resp = call(&s, "import_mbox", json!({"sourcePath": src.to_string_lossy(), "accountId": "acct1", "mode": "folder"})).await;
            assert!(resp.error.is_some(), "{src:?} must fail");
        }
        assert_eq!(listed(&s).await, json!([]));
        let left: Vec<_> = std::fs::read_dir(account_dir(v.path())).into_iter().flatten().flatten().map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "{left:?}");
    }

    /// Only a folder carrying its marker is listed: not a server folder, not
    /// one whose marker will not read, not a symlink to a local folder.
    #[tokio::test]
    async fn list_local_folders_answers_with_marked_folders_only() {
        let (v, _a, s) = st(true);
        let fdir = local_folder_with(v.path(), "MBOX import 2026-09-29", "import", &["Subject: a\r\n\r\na"]);
        seed_file(v.path(), "acct1", "INBOX", 1, &["S"]);
        local_folder_with(v.path(), "Broken", "import", &["Subject: b\r\n\r\nb"]);
        std::fs::write(account_dir(v.path()).join("Broken").join(local_folder::MARKER_FILE), b"{oops").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(account_dir(v.path()).join(&fdir), account_dir(v.path()).join("Linked")).unwrap();

        assert_eq!(listed(&s).await, json!([{"name": "MBOX import 2026-09-29", "dir": fdir, "kind": "import", "created": 42, "source": "t.mbox"}]));
        let other = call(&s, "list_local_folders", json!({"accountId": "nobody"})).await;
        assert_eq!(other.result.expect("an account with no vault dir"), json!([]));
    }

    /// Every message goes into the deleted-mail bin, bytes and all, under the
    /// folder's name; then the folder and its marker go, and the registry
    /// holds none of its messages.
    #[tokio::test]
    async fn delete_local_folder_bins_every_message_and_removes_the_folder() {
        let (v, _a, s) = st(true);
        let name = "MBOX import 2026-09-29";
        let fdir = local_folder_with(v.path(), name, "import", &[&msg_with_id("a@x", "one"), &msg_with_id("b@x", "two")]);
        let before = files_in(v.path(), &fdir);

        let resp = delete_folder(&s, name).await;
        assert_eq!(resp.result.expect("deleted"), json!({"dir": fdir, "deleted": 2}));
        assert!(!account_dir(v.path()).join(&fdir).exists(), "the folder and its marker are gone");
        let rows = binned(&s);
        assert!(rows.iter().all(|d| d.mailbox == name && d.account_id == "acct1" && d.has_eml), "{rows:?}");
        let mut kept: Vec<(u32, Vec<u8>)> = rows.iter().map(|d| (d.uid, bin::read_eml(&s.app_dir, &d.id).unwrap())).collect();
        kept.sort();
        assert_eq!(kept, before.into_iter().map(|(uid, _, raw)| (uid, raw)).collect::<Vec<_>>());
        assert_eq!(s.vault_registry.uid_sets(v.path(), "acct1", &fdir), Some((vec![], vec![])));
        assert_eq!(listed(&s).await, json!([]));
    }

    /// Never a folder without an import marker: a server folder, one whose
    /// marker will not read, one of another kind, a symlink to a local
    /// folder. Each keeps its mail and nothing reaches the bin; the real
    /// folder still deletes.
    #[tokio::test]
    async fn delete_local_folder_refuses_anything_without_an_import_marker() {
        let (v, _a, s) = st(true);
        let name = "MBOX import 2026-09-29";
        let fdir = local_folder_with(v.path(), name, "import", &[&msg_with_id("a@x", "one")]);
        seed_file(v.path(), "acct1", "INBOX", 7, &["S"]);
        local_folder_with(v.path(), "Broken", "import", &["Subject: b\r\n\r\nb"]);
        std::fs::write(account_dir(v.path()).join("Broken").join(local_folder::MARKER_FILE), b"{oops").unwrap();
        local_folder_with(v.path(), "Other", "something-else", &["Subject: o\r\n\r\no"]);
        #[allow(unused_mut)]
        let mut refused = vec!["INBOX", "Broken", "Other"];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(account_dir(v.path()).join(&fdir), account_dir(v.path()).join("Linked")).unwrap();
            refused.push("Linked");
        }
        for n in &refused {
            let msg = err_of(delete_folder(&s, n).await);
            assert!(msg.starts_with("E_NOT_LOCAL_FOLDER:"), "{n}: {msg}");
        }
        for dir in ["INBOX", "Broken", "Other", fdir.as_str()] {
            assert_eq!(files_in(v.path(), dir).len(), 1, "{dir} keeps its mail");
        }
        assert!(account_dir(v.path()).join(&fdir).join(local_folder::MARKER_FILE).exists());
        assert!(binned(&s).is_empty());
        assert_eq!(delete_folder(&s, name).await.result.expect("the real one deletes")["deleted"], json!(1));
    }

    /// Already gone is done: a name with no folder, and a second delete (by
    /// its dir, which names the same folder).
    #[tokio::test]
    async fn deleting_a_folder_that_is_gone_is_a_success() {
        let (v, _a, s) = st(true);
        let r = delete_folder(&s, "MBOX import 2000-01-01").await;
        assert_eq!(r.result.expect("nothing to delete"), json!({"dir": "MBOX_import_2000-01-01", "deleted": 0}));
        let name = "MBOX import 2026-09-29";
        let fdir = local_folder_with(v.path(), name, "import", &[&msg_with_id("a@x", "one")]);
        assert_eq!(delete_folder(&s, name).await.result.expect("deleted")["deleted"], json!(1));
        assert_eq!(delete_folder(&s, &fdir).await.result.expect("again, by its dir"), json!({"dir": fdir, "deleted": 0}));
        assert_eq!(binned(&s).len(), 1);
    }

    /// The bin knows a copy by (account, folder, uid, Message-ID). A folder's
    /// name comes free again once it is deleted and the next import restarts
    /// at the import base, so a message with no Message-ID can meet an older
    /// copy under its key. That copy must not stand in for it: the message
    /// stays and the delete says so. The same key holding the very same
    /// bytes (a delete cut off after its capture) counts as kept.
    #[tokio::test]
    async fn an_older_bin_copy_under_the_same_key_never_stands_in_for_another_message() {
        let (v, _a, s) = st(true);
        let name = "MBOX import 2026-09-29";
        let fdir = local_folder_with(v.path(), name, "import", &["Subject: chat one\r\n\r\nfirst"]);
        let first = crate::handlers::deleted::capture(&s, "acct1", name, IMPORT_UID_BASE, crate::handlers::deleted::Source::Local).await;
        assert!(first.expect("captured").is_some());
        assert_eq!(delete_folder(&s, name).await.result.expect("the kept copy is these bytes")["deleted"], json!(1));
        assert_eq!(binned(&s).len(), 1, "no second copy");

        local_folder_with(v.path(), name, "import", &["Subject: chat two\r\n\r\nsecond"]);
        let msg = err_of(delete_folder(&s, name).await);
        assert!(msg.starts_with("E_LOCAL_FOLDER_NOT_EMPTY:"), "{msg}");
        let left = files_in(v.path(), &fdir);
        assert_eq!(left.iter().map(|f| f.2.as_slice()).collect::<Vec<_>>(), vec![&b"Subject: chat two\r\n\r\nsecond"[..]]);
        assert!(account_dir(v.path()).join(&fdir).join(local_folder::MARKER_FILE).exists(), "still listed, so it can be deleted again");
        let rows = binned(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(bin::read_eml(&s.app_dir, &rows[0].id).unwrap(), b"Subject: chat one\r\n\r\nfirst");
    }

    /// A Graph account keys its server folders by storage key; a local folder
    /// is none of them and lives in the same account dir, made, listed and
    /// deleted the same way.
    #[tokio::test]
    async fn a_graph_account_gets_its_local_folder_the_same_way() {
        let (v, _a, s) = st(true);
        let g = |name: &str, path: &str| json!({"name": name, "path": path, "specialUse": null, "flags": [], "delimiter": "/", "_graphFolderId": "AAMk"});
        let listing = json!({"mailboxes": [g("INBOX", "INBOX"), g("Gesendet", "Sent")]}).to_string();
        crate::custody::with_conn(&s, |c| mailvault_core::custody::cache::save_mailboxes(c, "acct1", &listing)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let r = import_as_folder(&s, &takeout(dir.path(), &["Sent", ""])).await;
        let (name, fdir) = today_folder();
        assert_eq!(r["folder"], json!({"name": name, "dir": fdir}));
        assert_eq!(files_in(v.path(), &fdir).len(), 2);
        assert_eq!((count_in(v.path(), "Sent"), count_in(v.path(), "INBOX")), (0, 0));
        assert_eq!(listed(&s).await.as_array().map(|a| a.iter().map(|f| f["dir"].clone()).collect::<Vec<_>>()), Some(vec![json!(fdir)]));
        assert_eq!(delete_folder(&s, &name).await.result.expect("deleted")["deleted"], json!(2));
        assert!(!account_dir(v.path()).join(&fdir).exists());
    }

    #[tokio::test]
    async fn local_folder_routes_reach_this_router_and_want_their_params() {
        let (_v, _a, s) = st(true);
        for (method, params) in [("list_local_folders", json!({})), ("delete_local_folder", json!({"accountId": "acct1"}))] {
            let resp = handle_request_for_test(&s, method, params).await;
            assert_eq!(resp.error.expect("refused").code, ipc::INVALID_PARAMS, "{method}");
        }
    }
}
