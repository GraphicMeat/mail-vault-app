//! Backup ZIP export/import (Task 4.3), ported from `src-tauri/src/main.rs`'s
//! `export_backup`/`import_backup` (`:1490-1842` before this move). The walk,
//! the manifest shape and the ZIP entry paths are byte-identical to what
//! shipped before this move; see `handlers::backup_zip` for the router that
//! calls these and the porting notes below for the two places this module's
//! signature had to diverge from the app version's.
//!
//! `accounts.json` (plan decision 2): this module never writes it. `import`'s
//! new-account detection still runs: it decides which UUID a manifest
//! account's vault files get extracted under, and the caller (the app, via
//! `src/services/db/accounts.js`) needs those same descriptors to save, but
//! the write itself stays app-side. `export` never wrote it either (only
//! `import` did, in the original code), so no fix was needed there.
//!
//! Two porting notes beyond the plan's own inventory (the plan's Task 4.3
//! only named `app_handle.emit -> emit` and `vault::root(&app_handle)? ->
//! root` as needed substitutions; both of these were found by reading the
//! actual bodies, not assumed from the plan text):
//! 1. `export_backup`'s original body ALSO calls `read_accounts_json` (for an
//!    account-id -> email lookup used by the ZIP walk), a call the plan's own
//!    ledger entry for `accounts.json`'s dual-writer only named
//!    `import_backup`'s call, missing this one. Since decision 2 only
//!    forbids a daemon WRITE to this file, not a read, `export` keeps doing
//!    this lookup, but as a plain argument (`accounts_entries`) supplied by
//!    the router's own read, the same shape `import`'s `existing_accounts`
//!    already takes, so this module stays read-only-by-construction like
//!    `import` rather than reading the file itself.
//! 2. `export`'s original body also takes `dest_path` (where to write the
//!    ZIP), omitted from the plan's abbreviated signature list entirely.
//!    Restored here; there is no other way to write a ZIP file.
//!
//! Per-file gate (decision 10): `export`'s walk resolves the vault root once
//! up front (a read, not gate-sensitive); `import`'s extraction loop calls
//! `common::with_vault_write` inside the loop, once per file, and breaks
//! cleanly on a gate refusal instead of propagating it as a hard error,
//! matching this repo's "resilient over noisy" rule: a vault move mid-import
//! stops further writes but still returns whatever imported before it did.

use crate::handlers::common;
use crate::server::DaemonState;
use mailvault_core::maildir::{has_info, info_flags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, warn};
use zip::write::SimpleFileOptions;

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u32,
    #[serde(rename = "exportedAt")]
    pub exported_at: String,
    pub accounts: Vec<BackupAccount>,
    pub settings: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupAccount {
    pub email: String,
    #[serde(rename = "imapServer")]
    pub imap_server: Option<String>,
    #[serde(rename = "smtpServer")]
    pub smtp_server: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportResult {
    #[serde(rename = "emailCount")]
    pub email_count: u32,
    #[serde(rename = "accountCount")]
    pub account_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    #[serde(rename = "emailCount")]
    pub email_count: u32,
    #[serde(rename = "accountCount")]
    pub account_count: u32,
    /// Decision 2 / decision 4: was `Vec<String>` (bare emails) in the Tauri
    /// command. The daemon route never writes `accounts.json`, so it hands
    /// back the full descriptor the app needs to do that write itself: the
    /// one payload in this whole plan that isn't byte-identical to its
    /// predecessor.
    #[serde(rename = "newAccounts")]
    pub new_accounts: Vec<AccountsJsonEntry>,
    #[serde(rename = "settingsJson")]
    pub settings_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountsJsonEntry {
    pub id: String,
    pub email: Option<String>,
    #[serde(rename = "imapServer")]
    pub imap_server: Option<String>,
    #[serde(rename = "smtpServer")]
    pub smtp_server: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
}

/// `accounts_entries`: the router's own one-time read of `accounts.json`
/// (id -> email), read-only, passed in rather than read here: see the
/// module doc's porting note 1.
pub fn export(
    state: &Arc<DaemonState>,
    dest_path: PathBuf,
    accounts_entries: &[AccountsJsonEntry],
    manifest_accounts: Vec<BackupAccount>,
    settings: Option<Value>,
    archived_only: bool,
    emit: impl Fn(&str, Value),
) -> Result<ExportResult, String> {
    // Decision 10: a single up-front root resolution for the whole read-only
    // walk, since reads are not gate-sensitive the same way writes are, matching
    // every other Phase 2/3 read route. No `with_vault_write` anywhere below.
    let root = common::vault_root(state)?;

    info!("export_backup called: dest={}, archived_only={}", dest_path.display(), archived_only);

    let mut id_to_email: HashMap<String, String> = HashMap::new();
    for entry in accounts_entries {
        if let Some(ref email) = entry.email {
            id_to_email.insert(entry.id.clone(), email.clone());
        }
    }

    let maildir_base = root.join("Maildir");

    let file = std::fs::File::create(&dest_path).map_err(|e| format!("Failed to create ZIP file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut email_count: u32 = 0;
    let mut account_count: u32 = 0;

    // Count total files first for progress tracking.
    let mut total_files: u32 = 0;
    if maildir_base.exists() {
        if let Ok(account_dirs) = std::fs::read_dir(&maildir_base) {
            for account_dir in account_dirs.flatten() {
                if !account_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    continue;
                }
                let acct_id = account_dir.file_name().to_string_lossy().to_string();
                if !id_to_email.contains_key(&acct_id) {
                    continue;
                }
                if let Ok(mailbox_dirs) = std::fs::read_dir(account_dir.path()) {
                    for mailbox_dir in mailbox_dirs.flatten() {
                        if !mailbox_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                            continue;
                        }
                        let cur_dir = mailbox_dir.path().join("cur");
                        if !cur_dir.exists() {
                            continue;
                        }
                        if let Ok(files) = std::fs::read_dir(&cur_dir) {
                            for file_entry in files.flatten() {
                                let fname = file_entry.file_name().to_string_lossy().to_string();
                                if !has_info(&fname) {
                                    continue;
                                }
                                if archived_only {
                                    if let Some(flags_part) = info_flags(&fname) {
                                        if !flags_part.contains('A') {
                                            continue;
                                        }
                                    } else {
                                        continue;
                                    }
                                }
                                total_files += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    emit(
        "export-progress",
        serde_json::json!({"total": total_files, "completed": 0, "active": true}),
    );

    if maildir_base.exists() {
        if let Ok(account_dirs) = std::fs::read_dir(&maildir_base) {
            for account_dir in account_dirs.flatten() {
                if !account_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    continue;
                }
                let account_id = account_dir.file_name().to_string_lossy().to_string();
                let email_addr = match id_to_email.get(&account_id) {
                    Some(e) => e.clone(),
                    None => {
                        warn!("No email found for account {}, skipping", account_id);
                        continue;
                    }
                };

                let mut account_has_emails = false;

                if let Ok(mailbox_dirs) = std::fs::read_dir(account_dir.path()) {
                    for mailbox_dir in mailbox_dirs.flatten() {
                        if !mailbox_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                            continue;
                        }
                        let mailbox_name = mailbox_dir.file_name().to_string_lossy().to_string();
                        let cur_dir = mailbox_dir.path().join("cur");
                        if !cur_dir.exists() {
                            continue;
                        }

                        if let Ok(files) = std::fs::read_dir(&cur_dir) {
                            for file_entry in files.flatten() {
                                let filename = file_entry.file_name().to_string_lossy().to_string();
                                if !has_info(&filename) {
                                    continue;
                                }

                                if archived_only {
                                    if let Some(flags_part) = info_flags(&filename) {
                                        if !flags_part.contains('A') {
                                            continue;
                                        }
                                    } else {
                                        continue;
                                    }
                                }

                                let zip_path = format!("mailvault-backup/emails/{}/{}/{}", email_addr, mailbox_name, filename);

                                let content = match std::fs::read(file_entry.path()) {
                                    Ok(c) => c,
                                    Err(e) => {
                                        warn!("Failed to read {}: {}", file_entry.path().display(), e);
                                        continue;
                                    }
                                };

                                zip.start_file(&zip_path, options).map_err(|e| format!("Failed to add file to ZIP: {}", e))?;
                                zip.write_all(&content).map_err(|e| format!("Failed to write to ZIP: {}", e))?;

                                email_count += 1;
                                account_has_emails = true;

                                emit(
                                    "export-progress",
                                    serde_json::json!({"total": total_files, "completed": email_count, "active": true}),
                                );
                            }
                        }
                    }
                }

                if account_has_emails {
                    account_count += 1;
                }
            }
        }
    }

    let manifest = BackupManifest {
        version: 2,
        exported_at: chrono::Utc::now().to_rfc3339(),
        accounts: manifest_accounts,
        settings,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    zip.start_file("mailvault-backup/manifest.json", options)
        .map_err(|e| format!("Failed to add manifest to ZIP: {}", e))?;
    zip.write_all(manifest_json.as_bytes()).map_err(|e| format!("Failed to write manifest: {}", e))?;

    zip.finish().map_err(|e| format!("Failed to finalize ZIP: {}", e))?;

    emit(
        "export-progress",
        serde_json::json!({"total": total_files, "completed": email_count, "active": false}),
    );

    info!("Backup exported: {} emails from {} accounts to {}", email_count, account_count, dest_path.display());

    Ok(ExportResult { email_count, account_count })
}

/// `existing_accounts`: the router's own one-time read of `accounts.json`,
/// read-only (decision 2): this function never reads or writes that file.
pub fn import(
    state: &Arc<DaemonState>,
    source_path: PathBuf,
    existing_accounts: Vec<AccountsJsonEntry>,
    emit: impl Fn(&str, Value),
) -> Result<ImportResult, String> {
    info!("import_backup called: source={}", source_path.display());

    let file = std::fs::File::open(&source_path).map_err(|e| format!("Failed to open ZIP file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    let manifest: BackupManifest = {
        let mut manifest_file = archive
            .by_name("mailvault-backup/manifest.json")
            .map_err(|e| format!("No manifest.json found in backup: {}", e))?;
        let mut manifest_str = String::new();
        manifest_file.read_to_string(&mut manifest_str).map_err(|e| format!("Failed to read manifest: {}", e))?;
        serde_json::from_str(&manifest_str).map_err(|e| format!("Failed to parse manifest: {}", e))?
    };

    info!(
        "Backup manifest: version={}, accounts={}, exported_at={}",
        manifest.version,
        manifest.accounts.len(),
        manifest.exported_at
    );

    let mut existing_accounts = existing_accounts;
    let mut email_to_id: HashMap<String, String> = HashMap::new();
    for entry in &existing_accounts {
        if let Some(ref email) = entry.email {
            email_to_id.insert(email.clone(), entry.id.clone());
        }
    }

    // Still runs in full (decision 2's carve-out is the write, not this
    // detection): every extracted file needs to land under the right UUID
    // directory, and the caller needs these descriptors back either way.
    let mut new_accounts: Vec<AccountsJsonEntry> = Vec::new();
    for manifest_acct in &manifest.accounts {
        if !email_to_id.contains_key(&manifest_acct.email) {
            let new_id = uuid::Uuid::new_v4().to_string();
            info!("Creating new account for {}: {}", manifest_acct.email, new_id);
            email_to_id.insert(manifest_acct.email.clone(), new_id.clone());

            let entry = AccountsJsonEntry {
                id: new_id,
                email: Some(manifest_acct.email.clone()),
                imap_server: manifest_acct.imap_server.clone(),
                smtp_server: manifest_acct.smtp_server.clone(),
                created_at: Some(chrono::Utc::now().to_rfc3339()),
            };
            existing_accounts.push(entry.clone());
            new_accounts.push(entry);
        }
    }
    // No `write_accounts_json` call (decision 2): the app merges
    // `new_accounts` into `accounts.json` itself, via `db/accounts.js`.

    let mut email_count: u32 = 0;
    let email_prefix = "mailvault-backup/emails/";

    let total_entries: u32 = (0..archive.len())
        .filter(|&i| {
            if let Ok(entry) = archive.by_index(i) {
                let name = entry.name().to_string();
                name.starts_with(email_prefix) && !entry.is_dir() && has_info(&name)
            } else {
                false
            }
        })
        .count() as u32;

    emit(
        "import-progress",
        serde_json::json!({"total": total_entries, "completed": 0, "active": true}),
    );

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Failed to read ZIP entry: {}", e))?;
        let entry_name = entry.name().to_string();

        if !entry_name.starts_with(email_prefix) || entry.is_dir() {
            continue;
        }

        let relative = &entry_name[email_prefix.len()..];
        let parts: Vec<&str> = relative.splitn(3, '/').collect();
        if parts.len() != 3 {
            warn!("Skipping malformed path: {}", entry_name);
            continue;
        }

        let email_addr = parts[0];
        let mailbox = parts[1];
        let filename = parts[2];

        // A maildir filename is a single path component by definition; a
        // crafted ZIP entry with `../../..` (or an absolute-looking path) in
        // this position must not be allowed to escape the account/mailbox
        // directory it's about to be joined under.
        if filename.is_empty()
            || !has_info(filename)
            || filename.contains('/')
            || filename.contains('\\')
            || filename.contains("..")
        {
            warn!("Skipping unsafe filename in backup entry: {}", entry_name);
            continue;
        }

        let account_id = match email_to_id.get(email_addr) {
            Some(id) => id.clone(),
            None => {
                warn!("No account ID for email {}, skipping", email_addr);
                continue;
            }
        };

        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|e| format!("Failed to read .eml from ZIP: {}", e))?;

        // account_id joins the same filesystem path as mailbox; sanitize it
        // the same way rather than trusting the accounts-map value verbatim.
        let safe_account_id = common::sanitize_mailbox_name(&account_id);
        let safe_mailbox = common::sanitize_mailbox_name(mailbox);
        let filename_owned = filename.to_string();

        // Decision 10: the gate is re-acquired here, inside the loop, once
        // per file, never once around the whole extraction. A refusal
        // (e.g. the vault closing mid-import for a move) stops the loop
        // cleanly instead of propagating as a hard error: whatever imported
        // before the refusal is still a valid partial result, matching this
        // repo's "resilient over noisy" rule.
        //
        // Under the vault registry's lock for the folder (keyed by the
        // sanitized names, the directory itself). A name the registry's
        // listing reads a uid from lands as a row right after its write; any
        // other name is not a vault message to it, as on a relisting.
        let wrote = match common::with_mailbox_write(state, &safe_account_id, &safe_mailbox, |root| -> Result<bool, String> {
            let cur_dir = root.join("Maildir").join(&safe_account_id).join(&safe_mailbox).join("cur");
            std::fs::create_dir_all(&cur_dir).map_err(|e| format!("Failed to create directory: {}", e))?;
            let dest_path = cur_dir.join(&filename_owned);
            if dest_path.exists() {
                info!("Skipping existing file: {:?}", dest_path);
                return Ok(false);
            }
            let uid = mailvault_core::maildir::vault_filename_uid(&filename_owned);
            if let Err(e) = std::fs::write(&dest_path, &content) {
                if uid.is_some() {
                    // A failed plain write can leave a partial file.
                    state.vault_registry.invalidate(&safe_account_id, &safe_mailbox);
                }
                return Err(format!("Failed to write .eml file: {}", e));
            }
            if let Some(uid) = uid {
                state.vault_registry.upsert(&safe_account_id, &safe_mailbox, uid, &dest_path);
            }
            Ok(true)
        }) {
            Ok(w) => w,
            Err(e) => {
                warn!("import_backup: vault gate refused a write, stopping the import early: {}", e);
                break;
            }
        };

        if wrote {
            email_count += 1;
            emit(
                "import-progress",
                serde_json::json!({"total": total_entries, "completed": email_count, "active": true}),
            );
        }
    }

    emit(
        "import-progress",
        serde_json::json!({"total": total_entries, "completed": email_count, "active": false}),
    );

    let settings_json = manifest.settings.map(|s| serde_json::to_string(&s).unwrap_or_default());

    info!("Backup imported: {} emails, {} new accounts", email_count, new_accounts.len());
    if email_count > 0 {
        // Decision 9: files landed in any number of accounts and folders,
        // the in-process equivalent of the app's own `sweep_index_soon()`.
        crate::search_index::sweep_soon(&state.search_index);
    }

    Ok(ImportResult {
        email_count,
        account_count: manifest.accounts.len() as u32,
        new_accounts,
        settings_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn state(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, mail_dir_ok);
        (vault, s)
    }

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str], body: &[u8]) {
        let flags: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
        let cur = mailvault_core::vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(mailvault_core::vault_files::build_maildir_filename(uid, &flags)), body).unwrap();
    }

    /// Writes a file under an exact, caller-chosen name -- `seed_file` always
    /// goes through `build_maildir_filename`, which on darwin only ever
    /// emits `:`, so it cannot produce a `;`-spelled (Windows) fixture.
    fn seed_file_named(root: &std::path::Path, account: &str, mailbox: &str, filename: &str, body: &[u8]) {
        let cur = mailvault_core::vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(filename), body).unwrap();
    }

    fn build_zip(dir: &std::path::Path, name: &str, entries: &[(&str, &[u8])], manifest: &BackupManifest) -> PathBuf {
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("mailvault-backup/manifest.json", options).unwrap();
        zip.write_all(serde_json::to_string(manifest).unwrap().as_bytes()).unwrap();
        for (zip_path, body) in entries {
            zip.start_file(*zip_path, options).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    fn manifest_for(accounts: Vec<BackupAccount>) -> BackupManifest {
        BackupManifest { version: 2, exported_at: "2026-01-01T00:00:00Z".into(), accounts, settings: None }
    }

    // ── export ───────────────────────────────────────────────────────────

    #[test]
    fn export_writes_a_well_formed_zip_with_the_right_manifest() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"body1");
        let entries = vec![AccountsJsonEntry {
            id: "acct1".into(),
            email: Some("a@test.com".into()),
            imap_server: None,
            smtp_server: None,
            created_at: None,
        }];
        let dest = tempfile::tempdir().unwrap().keep().join("out.zip");
        let result = export(
            &s,
            dest.clone(),
            &entries,
            vec![BackupAccount { email: "a@test.com".into(), imap_server: None, smtp_server: None }],
            None,
            false,
            |_, _| {},
        )
        .unwrap();
        assert_eq!(result.email_count, 1);
        assert_eq!(result.account_count, 1);

        let file = std::fs::File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut manifest_str = String::new();
        archive.by_name("mailvault-backup/manifest.json").unwrap().read_to_string(&mut manifest_str).unwrap();
        let manifest: BackupManifest = serde_json::from_str(&manifest_str).unwrap();
        assert_eq!(manifest.accounts.len(), 1);
        assert_eq!(manifest.accounts[0].email, "a@test.com");
        assert!((0..archive.len()).any(|i| archive.by_index(i).unwrap().name().contains("INBOX")));
    }

    #[test]
    fn export_archived_only_skips_unarchived_files() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"archived");
        seed_file(v.path(), "acct1", "INBOX", 2, &[], b"not archived");
        let entries = vec![AccountsJsonEntry { id: "acct1".into(), email: Some("a@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let dest = tempfile::tempdir().unwrap().keep().join("out.zip");
        let result = export(&s, dest, &entries, vec![], None, true, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1, "only the archived file should be exported");
    }

    /// Task 1b: a `;2,`-spelled (Windows) vault file must be recognized both
    /// as a vault message at all (`has_info`, was a bare `contains(":2,")`)
    /// and for its flags (`info_flags`, was `split(":2,").nth(1)`). Two
    /// fixtures, one spelling each, so a vacuous pass (filter skipped
    /// entirely) would show up as exporting 2 rather than the expected 1.
    #[test]
    fn export_reads_files_under_either_info_separator() {
        let (v, s) = state(true);
        seed_file_named(v.path(), "acct1", "INBOX", "1;2,A.eml", b"archived, semicolon");
        seed_file_named(v.path(), "acct1", "INBOX", "2;2,.eml", b"not archived, semicolon");
        let entries = vec![AccountsJsonEntry { id: "acct1".into(), email: Some("a@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let dest = tempfile::tempdir().unwrap().keep().join("out.zip");
        let result = export(&s, dest, &entries, vec![], None, true, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1, "only the archived ';2,' file should be exported");
    }

    /// Decision 10 (b): the export walk performs zero gate acquisitions.
    /// Holding the write side of `vault_gate` before calling export proves
    /// this: if export ever called `with_vault_write`, it would block
    /// forever on this same thread's write lock (a std `RwLock` is not
    /// reentrant), run on a background thread with a bounded wait so a
    /// regression fails the test instead of hanging the suite.
    #[test]
    fn export_never_touches_the_vault_write_gate() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"body");
        let entries = vec![AccountsJsonEntry { id: "acct1".into(), email: Some("a@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let dest = tempfile::tempdir().unwrap().keep().join("out.zip");

        let _write_guard = s.vault_gate.write().unwrap();
        let s2 = Arc::clone(&s);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let r = export(&s2, dest, &entries, vec![], None, false, |_, _| {});
            let _ = tx.send(r);
        });
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(Ok(result)) => assert_eq!(result.email_count, 1),
            Ok(Err(e)) => panic!("export failed: {e}"),
            Err(_) => panic!("export blocked on the vault write gate: it must never call with_vault_write"),
        }
    }

    // ── import ───────────────────────────────────────────────────────────

    /// Task 1b: a `;2,`-spelled zip entry name (produced by a backup taken
    /// on Windows) must import the same as the `:2,` spelling -- both the
    /// progress-total count (line ~365, `has_info` over the archive entry
    /// name) and the unsafe-filename guard (line ~401, `!has_info` inside a
    /// larger `||` chain) hardcoded `:2,` before this fix.
    #[test]
    fn import_reads_a_zip_entry_under_the_semicolon_info_separator() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/new@test.com/INBOX/1;2,A.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "new@test.com".into(), imap_server: Some("imap.test".into()), smtp_server: None }]),
        );

        let result = import(&s, zip_path, vec![], |_, _| {}).unwrap();

        assert_eq!(result.email_count, 1, "the ';2,' spelled entry must be imported, not skipped as unsafe");
        let new_account = &result.new_accounts[0];
        let cur = mailvault_core::vault_files::cur_path(v.path(), &new_account.id, "INBOX");
        let written: Vec<_> = std::fs::read_dir(&cur).unwrap().collect();
        assert_eq!(written.len(), 1);
    }

    #[test]
    fn import_extracts_under_the_gate_and_returns_new_account_descriptors() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/new@test.com/INBOX/1:2,A.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "new@test.com".into(), imap_server: Some("imap.test".into()), smtp_server: None }]),
        );

        let result = import(&s, zip_path, vec![], |_, _| {}).unwrap();

        assert_eq!(result.email_count, 1);
        assert_eq!(result.new_accounts.len(), 1);
        let new_account = &result.new_accounts[0];
        assert_eq!(new_account.email.as_deref(), Some("new@test.com"));
        assert_eq!(new_account.imap_server.as_deref(), Some("imap.test"));
        assert!(!new_account.id.is_empty());

        let cur = mailvault_core::vault_files::cur_path(v.path(), &new_account.id, "INBOX");
        let written: Vec<_> = std::fs::read_dir(&cur).unwrap().collect();
        assert_eq!(written.len(), 1, "the .eml landed under the vault root the gate was given");
    }

    #[test]
    fn import_matches_an_existing_account_by_email_instead_of_minting_a_new_one() {
        let (_v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/known@test.com/INBOX/1:2,A.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let result = import(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.new_accounts.len(), 0, "an already-known email must not mint a new account");
        assert_eq!(result.email_count, 1);
    }

    /// Each imported file lands in the vault registry as it is written: a
    /// folder verified before the import answers with the new uid and no
    /// relisting. A name with no uid the registry reads is not recorded.
    #[test]
    fn import_records_each_file_in_a_verified_registry() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct-known", "INBOX", 5, &["A"], b"already");
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acct-known", "INBOX"), Some((vec![5], vec![5])));

        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[
                ("mailvault-backup/emails/known@test.com/INBOX/1:2,A.eml", b"body"),
                ("mailvault-backup/emails/known@test.com/INBOX/x:2,A.eml", b"no uid"),
            ],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let result = import(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 2);

        assert_eq!(reg.uid_sets(v.path(), "acct-known", "INBOX"), Some((vec![1, 5], vec![1, 5])));
        assert_eq!(reg.listing_count(), 1, "the rows came from the import, not a relisting");
    }

    /// Decision 10 (a) + (c): the gate is re-acquired per file, inside the
    /// loop, not once for the whole pass. Two files for the same known
    /// account; the test's own `emit` closure flips `vault_closed` right
    /// after the first file's write completes (no thread timing needed:
    /// `import` is synchronous, so this fires deterministically between file
    /// 1 and file 2). Proves both that per-file writes each go through their
    /// own gate check (file 2 is refused although file 1 already succeeded)
    /// and that a mid-loop refusal stops cleanly with a correct partial
    /// count rather than panicking or discarding file 1's result.
    #[test]
    fn import_stops_cleanly_with_a_correct_partial_count_when_the_gate_fails_mid_loop() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[
                ("mailvault-backup/emails/known@test.com/INBOX/1:2,A.eml", b"body1"),
                ("mailvault-backup/emails/known@test.com/Archive/2:2,A.eml", b"body2"),
            ],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let s2 = Arc::clone(&s);
        let result = import(&s, zip_path, existing, move |name, payload| {
            if name == "import-progress" && payload["completed"].as_u64() == Some(1) {
                s2.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        })
        .unwrap();

        assert_eq!(result.email_count, 1, "must stop after the first file once the gate starts refusing");
        let inbox = std::fs::read_dir(mailvault_core::vault_files::cur_path(v.path(), "acct-known", "INBOX")).unwrap().count();
        let archive = mailvault_core::vault_files::cur_path(v.path(), "acct-known", "Archive");
        assert_eq!(inbox, 1, "the file that landed before the refusal must still be on disk");
        assert!(!archive.exists() || std::fs::read_dir(&archive).unwrap().count() == 0, "the refused file must not have landed");
    }

    #[test]
    fn import_rejects_a_path_traversal_filename() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/known@test.com/INBOX/../../../../../../tmp/evil:2,A.eml", b"payload")],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let result = import(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 0, "a path-traversal filename must be skipped, not written");
        assert!(!std::path::Path::new("/tmp/evil").exists(), "nothing may land outside the vault's Maildir tree");
        let inbox = mailvault_core::vault_files::cur_path(v.path(), "acct-known", "INBOX");
        assert!(!inbox.exists() || std::fs::read_dir(&inbox).unwrap().count() == 0);
    }

    #[test]
    fn import_sanitizes_a_path_traversal_account_id() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/evil@test.com/INBOX/1:2,A.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "evil@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing =
            vec![AccountsJsonEntry { id: "../../../../../../tmp/evil".into(), email: Some("evil@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let result = import(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1);
        // The write must land under the sanitized id INSIDE the vault, not escape it.
        let escaped = std::path::Path::new("/tmp/evil/INBOX/cur/1:2,A.eml");
        assert!(!escaped.exists(), "must not escape the vault root via account_id");

        // The sanitizer keeps '.', so the escaped-looking id becomes one
        // dot-and-underscore-laden component, not a clean name -- check
        // containment (single component, still under the vault root), not
        // the absence of ".." as a substring.
        let maildir = v.path().join("Maildir");
        let entries: Vec<_> = std::fs::read_dir(&maildir).unwrap().map(|e| e.unwrap()).collect();
        assert_eq!(entries.len(), 1, "exactly one sanitized account dir, not a tree of '..' components");
        let account_dir = entries[0].path();
        assert_eq!(account_dir.components().count(), maildir.components().count() + 1, "must be a single path component under Maildir/, not a multi-level escape");
        let canonical_root = v.path().canonicalize().unwrap();
        let canonical_written = account_dir.canonicalize().unwrap();
        assert!(canonical_written.starts_with(&canonical_root), "escaped the vault root: {:?} not under {:?}", canonical_written, canonical_root);
    }

    #[test]
    fn import_skips_an_already_extracted_file_idempotently() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/known@test.com/INBOX/1:2,A.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        seed_file(v.path(), "acct-known", "INBOX", 1, &["A"], b"already there");

        let result = import(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 0, "an existing file is skipped, not overwritten or double-counted");
    }
}
