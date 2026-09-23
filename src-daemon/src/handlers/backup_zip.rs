//! Daemon routes for `export_backup`/`import_backup` (Task 4.3), backed by
//! `crate::backup_zip`, moved from `src-tauri/src/main.rs`. **No cutover in
//! this task**: the Tauri commands in `main.rs` are untouched and still
//! serve the frontend; this router exists but nothing calls it yet. Task 4.4
//! deletes the Tauri commands and switches the frontend to `daemon_rpc`.
//!
//! `accounts.json` (decision 2): read here, once per call, never written.
//! `export_backup`'s account-id -> email lookup and `import_backup`'s
//! existing-account matching are both plain reads of the same file, done
//! before handing off to `backup_zip::export`/`import`, the same treatment
//! Task 3.6's `handlers::insights` already gives this file.
//!
//! Both routes run on `spawn_blocking` (`common::blocking`): a full ZIP
//! read-or-write pass is disk I/O end to end and must never run on a tokio
//! worker.

use crate::backup_zip::{self, AccountsJsonEntry, BackupAccount};
use crate::handlers::common::{blocking, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// Same failure mapping `handlers::insights::configured_account_ids` uses for
/// this exact file: a missing `accounts.json` is a documented empty list,
/// never a configuration error; a present-but-unparseable one is a real
/// `Err`.
fn read_accounts_entries(app_dir: &Path) -> Result<Vec<AccountsJsonEntry>, String> {
    let path = app_dir.join("accounts.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read accounts.json: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse accounts.json: {e}"))
}

fn bus_emit(state: &Arc<DaemonState>) -> impl Fn(&str, Value) {
    let bus = state.events.clone();
    move |name: &str, payload: Value| bus.emit(name, payload)
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "export_backup" => {
            let dest_path = req!(str_arg(&id, params, "destPath"));
            let archived_only = params.get("archivedOnly").and_then(Value::as_bool).unwrap_or(false);
            let accounts_json_str = req!(str_arg(&id, params, "accountsJson"));
            let manifest_accounts: Vec<BackupAccount> = match serde_json::from_str(&accounts_json_str) {
                Ok(v) => v,
                Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Failed to parse accounts: {e}"))),
            };
            let settings_json_str = params.get("settingsJson").and_then(Value::as_str).unwrap_or("");
            let settings: Option<Value> = if settings_json_str.is_empty() { None } else { serde_json::from_str(settings_json_str).ok() };

            let state = Arc::clone(state);
            let result: Result<Value, String> = blocking(move || -> Result<Value, String> {
                let accounts_entries = read_accounts_entries(&state.app_dir)?;
                let emit = bus_emit(&state);
                let out = backup_zip::export(&state, PathBuf::from(&dest_path), &accounts_entries, manifest_accounts, settings, archived_only, emit)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            })
            .await
            .and_then(|r| r);

            match result {
                Ok(v) => RpcResponse::success(id, v),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }
        "import_backup" => {
            let source_path = req!(str_arg(&id, params, "sourcePath"));
            let state = Arc::clone(state);
            let result: Result<Value, String> = blocking(move || -> Result<Value, String> {
                let existing_accounts = read_accounts_entries(&state.app_dir)?;
                let emit = bus_emit(&state);
                let out = backup_zip::import(&state, PathBuf::from(&source_path), existing_accounts, emit)?;
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
    use std::io::Write as _;

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
    async fn export_backup_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(
            &s,
            "export_backup",
            json!({"destPath": "/nonexistent-dir-xyz/out.zip", "archivedOnly": false, "settingsJson": "", "accountsJson": "not json"}),
        )
        .await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "export_backup did not reach handlers::backup_zip::route");
    }

    #[tokio::test]
    async fn export_backup_writes_a_zip_and_returns_counts() {
        let (v, a, s) = st(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"]);
        std::fs::write(
            a.path().join("accounts.json"),
            json!([{"id": "acct1", "email": "a@test.com"}]).to_string(),
        )
        .unwrap();
        let dest = v.path().parent().unwrap().join(format!("out-{}.zip", uuid::Uuid::new_v4()));

        let resp = call(
            &s,
            "export_backup",
            json!({
                "destPath": dest.to_string_lossy(),
                "archivedOnly": false,
                "settingsJson": "",
                "accountsJson": json!([{"email": "a@test.com"}]).to_string(),
            }),
        )
        .await;

        let result = resp.result.expect("export_backup must succeed");
        assert_eq!(result["emailCount"], json!(1));
        assert_eq!(result["accountCount"], json!(1));
        assert!(dest.exists());
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    async fn import_backup_extracts_under_the_gate_and_returns_new_account_descriptors() {
        let (v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("in.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("mailvault-backup/manifest.json", options).unwrap();
            zip.write_all(
                json!({"version": 2, "exportedAt": "2026-01-01T00:00:00Z", "accounts": [{"email": "new@test.com"}], "settings": null})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
            zip.start_file("mailvault-backup/emails/new@test.com/INBOX/1:2,A.eml", options).unwrap();
            zip.write_all(b"body").unwrap();
            zip.finish().unwrap();
        }

        let resp = call(&s, "import_backup", json!({"sourcePath": zip_path.to_string_lossy()})).await;
        let result = resp.result.expect("import_backup must succeed");
        assert_eq!(result["emailCount"], json!(1));
        let new_accounts = result["newAccounts"].as_array().unwrap();
        assert_eq!(new_accounts.len(), 1);
        assert_eq!(new_accounts[0]["email"], json!("new@test.com"));
        let new_id = new_accounts[0]["id"].as_str().unwrap();

        let cur = mailvault_core::vault_files::cur_path(v.path(), new_id, "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 1);
    }

    /// Decision 2, re-verified at the route level: a real import run must
    /// leave `accounts.json` byte- and mtime-identical, even though it
    /// discovers a brand-new account. If the daemon route ever regressed to
    /// calling a write helper, this would catch it independent of the unit
    /// test in `backup_zip.rs` (which only proves the core function takes no
    /// such action; this proves the route wired around it never adds one of
    /// its own, e.g. in `read_accounts_entries` or elsewhere in the router).
    #[tokio::test]
    async fn import_backup_never_touches_accounts_json_on_disk() {
        let (_v, a, s) = st(true);
        let accounts_path = a.path().join("accounts.json");
        let original = json!([{"id": "acct-known", "email": "known@test.com"}]).to_string();
        std::fs::write(&accounts_path, &original).unwrap();
        let before_mtime = std::fs::metadata(&accounts_path).unwrap().modified().unwrap();
        let before_bytes = std::fs::read(&accounts_path).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("in.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("mailvault-backup/manifest.json", options).unwrap();
            zip.write_all(
                json!({"version": 2, "exportedAt": "2026-01-01T00:00:00Z", "accounts": [{"email": "brand-new@test.com"}], "settings": null})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
            zip.start_file("mailvault-backup/emails/brand-new@test.com/INBOX/1:2,A.eml", options).unwrap();
            zip.write_all(b"body").unwrap();
            zip.finish().unwrap();
        }

        let resp = call(&s, "import_backup", json!({"sourcePath": zip_path.to_string_lossy()})).await;
        let result = resp.result.expect("import_backup must succeed");
        assert_eq!(result["newAccounts"].as_array().unwrap().len(), 1, "a genuinely new account was discovered");

        let after_mtime = std::fs::metadata(&accounts_path).unwrap().modified().unwrap();
        let after_bytes = std::fs::read(&accounts_path).unwrap();
        assert_eq!(before_mtime, after_mtime, "accounts.json's mtime must be unchanged: the daemon route must never write it");
        assert_eq!(before_bytes, after_bytes, "accounts.json's bytes must be unchanged");
    }

    #[tokio::test]
    async fn import_backup_reaches_this_router_through_handle_request() {
        let (_v, _a, s) = st(true);
        let resp = handle_request_for_test(&s, "import_backup", json!({"sourcePath": "/nonexistent-xyz.zip"})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "import_backup did not reach handlers::backup_zip::route");
    }

    /// The app's account objects carry `imapHost`/`smtpHost`; a backup must
    /// hand those same hosts back as the restored account descriptors.
    #[tokio::test]
    async fn export_then_import_carries_the_account_hosts_through_the_manifest() {
        let (v, a, s) = st(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"]);
        std::fs::write(a.path().join("accounts.json"), json!([{"id": "acct1", "email": "a@test.com"}]).to_string()).unwrap();
        let dest = v.path().parent().unwrap().join(format!("out-{}.zip", uuid::Uuid::new_v4()));
        let accounts = json!([{"email": "a@test.com", "imapHost": "imap.a.test", "smtpHost": "smtp.a.test"}]);
        let resp = call(
            &s,
            "export_backup",
            json!({"destPath": dest.to_string_lossy(), "archivedOnly": false, "settingsJson": "", "accountsJson": accounts.to_string()}),
        )
        .await;
        resp.result.expect("export_backup must succeed");

        // Fresh install: no accounts.json, so the account comes back as new.
        let (_v2, _a2, s2) = st(true);
        let resp = call(&s2, "import_backup", json!({"sourcePath": dest.to_string_lossy()})).await;
        let _ = std::fs::remove_file(&dest);
        let new_accounts = resp.result.expect("import_backup must succeed")["newAccounts"].clone();
        assert_eq!(new_accounts[0]["email"], json!("a@test.com"));
        assert_eq!(new_accounts[0]["imapHost"], json!("imap.a.test"));
        assert_eq!(new_accounts[0]["smtpHost"], json!("smtp.a.test"));
    }

    /// Backups written before the host-key fix used `imapServer`/`smtpServer`.
    #[tokio::test]
    async fn import_backup_reads_the_legacy_server_keys() {
        let (_v, _a, s) = st(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("in.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("mailvault-backup/manifest.json", options).unwrap();
            zip.write_all(
                json!({"version": 2, "exportedAt": "2026-01-01T00:00:00Z", "accounts": [{"email": "old@test.com", "imapServer": "imap.old.test", "smtpServer": null}], "settings": null})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
            zip.finish().unwrap();
        }

        let resp = call(&s, "import_backup", json!({"sourcePath": zip_path.to_string_lossy()})).await;
        let new_accounts = resp.result.expect("import_backup must succeed")["newAccounts"].clone();
        assert_eq!(new_accounts[0]["imapHost"], json!("imap.old.test"));
        assert_eq!(new_accounts[0]["smtpHost"], Value::Null);
    }

    #[tokio::test]
    async fn export_backup_missing_dest_path_is_invalid_params() {
        let (_v, _a, s) = st(true);
        let resp = call(&s, "export_backup", json!({"accountsJson": "[]"})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }
}
