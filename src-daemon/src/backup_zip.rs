//! Backup ZIP export/import (Task 4.3), ported from `src-tauri/src/main.rs`'s
//! `export_backup`/`import_backup` (`:1490-1842` before this move). The walk,
//! the manifest shape and the ZIP entry paths are byte-identical to what
//! shipped before this move (except the account host keys, since renamed
//! `imapServer`/`smtpServer` -> `imapHost`/`smtpHost`); see `handlers::backup_zip` for the router that
//! calls these and the porting notes below for the two places this module's
//! signature had to diverge from the app version's.
//!
//! This module never writes `accounts.json`. ZIP import reads a fresh native
//! listing under account admission, keeps generated targets privately
//! reserved, and returns descriptors plus an opaque intent reference. Public
//! metadata activation is a later workflow.
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
//!    the router's own read. Import ignores its former caller snapshot and
//!    obtains the mapping from the native account document itself.
//! 2. `export`'s original body also takes `dest_path` (where to write the
//!    ZIP), omitted from the plan's abbreviated signature list entirely.
//!    Restored here; there is no other way to write a ZIP file.
//!
//! Export's read-only walk resolves the vault root once. Import holds finite
//! existing-target ownership, checks exact target publication per file, and
//! uses the vault gate for each write. A gate refusal stops extraction with
//! a truthful incomplete result and retained private reservation only when
//! a file effect may already have occurred.

use crate::handlers::common;
use crate::account_lifecycle::{AccountStamp, ImportTargetReservation, ImportTargetStamp, OperationPermit};
use crate::account_workflows::AccountWriteScope;
use crate::server::DaemonState;
use mailvault_core::accounts_doc;
use mailvault_core::maildir::{has_info, info_flags};
use mailvault_core::message_store;
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
    // `imapHost`/`smtpHost` match the account objects the app sends. Backups
    // written before this fix carry `imapServer`/`smtpServer` (always null,
    // since the app never had those fields), still accepted on import.
    #[serde(rename = "imapHost", alias = "imapServer")]
    pub imap_server: Option<String>,
    #[serde(rename = "smtpHost", alias = "smtpServer")]
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
    #[serde(rename = "importIntentId")]
    pub import_intent_id: String,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountsJsonEntry {
    pub id: String,
    pub email: Option<String>,
    // No legacy alias: this is also parsed from the live `accounts.json`,
    // where an entry holding both spellings would be a duplicate-field error.
    #[serde(rename = "imapHost")]
    pub imap_server: Option<String>,
    #[serde(rename = "smtpHost")]
    pub smtp_server: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
}

#[derive(Clone)]
enum ImportTarget {
    Existing { id: String, stamp: AccountStamp },
    New { id: String, stamp: ImportTargetStamp, descriptor: AccountsJsonEntry, reservation: ImportTargetReservation },
}
impl ImportTarget {
    fn id(&self) -> &str {
        match self { Self::Existing { id, .. } | Self::New { id, .. } => id }
    }
}

struct PendingImport {
    targets: HashMap<String, ImportTarget>,
    consumed: std::collections::HashSet<String>,
    had_file_effect: bool,
    complete: bool,
}
#[derive(Default)]
pub(crate) struct ZipIntents(std::sync::Mutex<HashMap<String, PendingImport>>);
impl ZipIntents {
    fn install(&self, targets: HashMap<String, ImportTarget>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.0.lock().unwrap().insert(id.clone(), PendingImport { targets, consumed: Default::default(), had_file_effect: false, complete: false });
        id
    }
    fn mark_effect(&self, intent: &str) {
        if let Some(pending) = self.0.lock().unwrap().get_mut(intent) { pending.had_file_effect = true; }
    }
    fn finish(&self, intent: &str) {
        let mut intents = self.0.lock().unwrap();
        let no_new = if let Some(pending) = intents.get_mut(intent) {
            pending.complete = true;
            pending.targets.values().all(|target| matches!(target, ImportTarget::Existing { .. }))
        } else { false };
        if no_new { intents.remove(intent); }
    }
    fn remove_if_unused(&self, intent: &str) {
        let mut intents = self.0.lock().unwrap();
        if intents.get(intent).is_some_and(|pending| !pending.had_file_effect && !pending.complete) { intents.remove(intent); }
    }
    /// Lookup for a future metadata transaction; this is not public account
    /// authority. P6 must still acquire persistence and confirm MembershipDelta.
    pub(crate) fn reservation_for(&self, intent: &str, descriptor: &AccountsJsonEntry) -> Option<ImportTargetReservation> {
        let intents = self.0.lock().unwrap();
        let pending = intents.get(intent)?;
        if !pending.complete || pending.consumed.contains(&descriptor.id) { return None; }
        let target = pending.targets.get(descriptor.email.as_ref()?)?;
        match target {
            ImportTarget::New { descriptor: expected, reservation, .. } if expected == descriptor => Some(reservation.clone()),
            _ => None,
        }
    }
    /// P6 supplies confirmed membership and consumes this exact reservation.
    pub(crate) fn consume_confirmed(&self, intent: &str, descriptor: &AccountsJsonEntry, added: &std::collections::BTreeSet<String>) -> Option<ImportTargetReservation> {
        if !added.contains(&descriptor.id) { return None; }
        let mut intents = self.0.lock().unwrap();
        let pending = intents.get_mut(intent)?;
        if !pending.complete { return None; }
        if pending.consumed.contains(&descriptor.id) { return None; }
        let email = descriptor.email.as_ref()?;
        let target = pending.targets.get(email)?;
        match target {
            ImportTarget::New { descriptor: expected, reservation, .. } if expected == descriptor => {
                let reservation = reservation.clone();
                pending.consumed.insert(descriptor.id.clone());
                Some(reservation)
            }
            _ => None,
        }
    }
}
struct ImportAttempt<'a> { intents: &'a ZipIntents, id: String }
impl Drop for ImportAttempt<'_> {
    fn drop(&mut self) { self.intents.remove_if_unused(&self.id); }
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
                        for (fname, _) in message_store::info_files_at(&mailbox_dir.path()) {
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
                        for (filename, path) in message_store::info_files_at(&mailbox_dir.path()) {
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

                            let content = match std::fs::read(&path) {
                                Ok(c) => c,
                                Err(e) => {
                                    warn!("Failed to read {}: {}", path.display(), e);
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

/// A path segment that is empty or only dots (`.`, `..`, `...`) is a
/// parent/current-dir reference (or collapses to one on Windows), never a
/// real account or mailbox directory name.
fn is_dot_segment(seg: &str) -> bool {
    seg.chars().all(|c| c == '.')
}

#[cfg(test)]
struct ImportWritePause { entered: std::sync::mpsc::Sender<()>, release: std::sync::mpsc::Receiver<()> }
#[cfg(test)]
fn import_write_pauses() -> &'static std::sync::Mutex<HashMap<PathBuf, ImportWritePause>> {
    static ARMED: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, ImportWritePause>>> = std::sync::OnceLock::new();
    ARMED.get_or_init(Default::default)
}
#[cfg(test)]
fn import_write_pause(state: &Arc<DaemonState>) {
    let gate = import_write_pauses().lock().unwrap().remove(&state.app_dir);
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        let _ = gate.release.recv();
    }
}

/// The caller's former account snapshot is ignored. The native document read
/// under account admission supplies the only target mapping.
pub fn import(
    state: &Arc<DaemonState>,
    source_path: PathBuf,
    _existing_accounts: Vec<AccountsJsonEntry>,
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

    // Whole-store admission makes the document proof and the complete target
    // reservation one short, coherent transaction. No lease survives ZIP IO.
    let lease = state.account_admission.try_reserve(AccountWriteScope { whole_store: true, ..Default::default() })
        .map_err(|e| format!("ZIP account admission refused: {e:?}"))?;
    let listing = accounts_doc::list(&accounts_doc::shared(&state.app_dir))
        .map_err(|e| format!("ZIP account listing failed: {e:?}"))?;
    state.account_lifecycle.seed(&listing);
    let authoritative = accounts_doc::authoritative_ids(&listing.accounts);
    let mut email_to_id = HashMap::<String, String>::new();
    for row in &listing.accounts {
        if let (Some(id), Some(email)) = (row.get("id").and_then(Value::as_str), row.get("email").and_then(Value::as_str)) {
            if authoritative.contains(id) { email_to_id.insert(email.to_owned(), id.to_owned()); }
        }
    }
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
            new_accounts.push(entry);
        }
    }
    let mut targets = HashMap::<String, ImportTarget>::new();
    let mut existing_stamps = Vec::new();
    let manifest_emails: std::collections::HashSet<_> = manifest.accounts.iter().map(|account| account.email.as_str()).collect();
    for (email, id) in &email_to_id {
        if !manifest_emails.contains(email.as_str()) || new_accounts.iter().any(|entry| &entry.id == id) { continue; }
        let stamp = state.account_lifecycle.capture(id)
            .map_err(|e| format!("ZIP existing target refused: {e:?}"))?;
        existing_stamps.push(stamp.clone());
        targets.insert(email.clone(), ImportTarget::Existing { id: id.clone(), stamp });
    }
    let existing_owner: Option<OperationPermit> = if existing_stamps.is_empty() { None } else {
        Some(state.account_lifecycle.try_operation(&existing_stamps)
            .map_err(|e| format!("ZIP existing targets refused: {e:?}"))?)
    };
    for descriptor in &new_accounts {
        let reservation = state.account_lifecycle.reserve_import_target(&lease, &listing, &descriptor.id)
            .map_err(|e| format!("ZIP new target refused: {e:?}"))?;
        let stamp = reservation.stamp(&descriptor.id)
            .map_err(|e| format!("ZIP new target stamp refused: {e:?}"))?;
        targets.insert(descriptor.email.clone().unwrap(), ImportTarget::New {
            id: descriptor.id.clone(), stamp, descriptor: descriptor.clone(), reservation,
        });
    }
    let attempt = ImportAttempt { intents: &state.zip_intents, id: state.zip_intents.install(targets.clone()) };
    drop(lease);

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

    let mut complete = true;
    let mut had_effect = false;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(entry) => entry,
            Err(e) if had_effect => {
                warn!("import_backup: incomplete ZIP after a file effect: {e}");
                complete = false;
                break;
            }
            Err(e) => return Err(format!("Failed to read ZIP entry: {e}")),
        };
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

        if is_dot_segment(email_addr) || is_dot_segment(mailbox) {
            warn!("Skipping backup entry with a dot-only account or mailbox segment: {}", entry_name);
            continue;
        }

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

        let target = match targets.get(email_addr) {
            Some(target) => target,
            None => {
                warn!("No account ID for email {}, skipping", email_addr);
                continue;
            }
        };
        let account_id = target.id();

        let mut content = Vec::new();
        if let Err(e) = entry.read_to_end(&mut content) {
            if !had_effect { return Err(format!("Failed to read .eml from ZIP: {e}")); }
            warn!("import_backup: incomplete ZIP content after a file effect: {e}");
            complete = false;
            break;
        }

        // account_id joins the same filesystem path as mailbox; sanitize it
        // the same way rather than trusting the accounts-map value verbatim.
        let safe_account_id = common::sanitize_mailbox_name(account_id);
        let safe_mailbox = common::sanitize_mailbox_name(mailbox);
        if safe_account_id != account_id || is_dot_segment(&safe_account_id) || is_dot_segment(&safe_mailbox) {
            warn!("Skipping backup entry whose account id or mailbox is a dot-only path: {}", entry_name);
            continue;
        }
        // The zip entry's info separator is whatever platform wrote the
        // backup, which is routinely not this one (a mac/Linux export
        // imported on Windows, or vice versa). Written verbatim, `:2,` on
        // Windows is not an error — NTFS reads the `:` as an
        // alternate-data-stream separator and silently creates a hidden
        // stream under the bare uid instead of a real file. Respell it to
        // this platform's own info separator before it ever touches disk.
        let filename_owned = mailvault_core::maildir::respell_for_platform(filename);

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
        let _commit = match target {
            ImportTarget::Existing { stamp, .. } => state.account_lifecycle.try_commit(&[stamp.clone()]),
            ImportTarget::New { stamp, .. } => state.account_lifecycle.try_import_commit(stamp),
        };
        let _commit = match _commit { Ok(permit) => permit, Err(e) => {
            warn!("import_backup: target commit refused, stopping import: {e:?}");
            complete = false;
            break;
        }};
        let wrote = match common::with_mailbox_write(state, &safe_account_id, &safe_mailbox, |root| -> Result<bool, String> {
            // The directory named as is: `safe_mailbox` keeps a `.` or `..`
            // that `message_store::mailbox_dir` would rename.
            let folder = message_store::mailbox_dir_at(&root.join("Maildir"), &safe_account_id, &safe_mailbox);
            message_store::create_messages_dir_at(&folder).map_err(|e| format!("Failed to create directory: {}", e))?;
            let dest_path = message_store::entry_path_at(&folder, &filename_owned);
            if dest_path.exists() {
                info!("Skipping existing file: {:?}", dest_path);
                return Ok(false);
            }
            let uid = message_store::uid_in_name(&filename_owned);
            #[cfg(test)]
            import_write_pause(state);
            state.zip_intents.mark_effect(&attempt.id);
            had_effect = true;
            if let Err(e) = message_store::write_named_at(&folder, &filename_owned, &content) {
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
                complete = false;
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

    if complete { state.zip_intents.finish(&attempt.id); }
    drop(existing_owner);
    Ok(ImportResult {
        email_count,
        account_count: manifest.accounts.len() as u32,
        new_accounts,
        settings_json,
        import_intent_id: attempt.id.clone(),
        complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, mail_dir_ok);
        (vault, s)
    }

    fn import_fixture(state: &Arc<DaemonState>, path: PathBuf, existing: Vec<AccountsJsonEntry>, emit: impl Fn(&str, Value)) -> Result<ImportResult, String> {
        if !existing.is_empty() {
            std::fs::write(state.app_dir.join("accounts.json"), serde_json::to_vec(&existing).unwrap()).unwrap();
        }
        import(state, path, Vec::new(), emit)
    }

    #[test]
    fn p4_zip_private_new_target_handoff_is_exact_and_one_use() {
        let (vault, state) = state(true);
        let manifest = manifest_for(vec![BackupAccount { email: "new@test.com".into(), imap_server: Some("imap.test".into()), smtp_server: None }]);
        let zip = build_zip(&state.app_dir, "p4-new.zip", &[("mailvault-backup/emails/new@test.com/INBOX/8:2,.eml", b"body")], &manifest);
        let result = import(&state, zip, Vec::new(), |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1);
        assert!(result.complete);
        let descriptor = &result.new_accounts[0];
        assert!(message_store::read_raw(vault.path(), &descriptor.id, "INBOX", 8).unwrap().is_some());
        assert!(matches!(state.account_lifecycle.capture(&descriptor.id), Err(crate::account_lifecycle::LifecycleError::Busy)));
        let mut forged = descriptor.clone();
        forged.imap_server = Some("forged.test".into());
        assert!(state.zip_intents.reservation_for(&result.import_intent_id, &forged).is_none());
        let reservation = state.zip_intents.reservation_for(&result.import_intent_id, descriptor).unwrap();
        let added = [descriptor.id.clone()].into();
        assert!(state.zip_intents.consume_confirmed(&result.import_intent_id, &forged, &added).is_none());
        assert!(state.zip_intents.consume_confirmed("foreign", descriptor, &added).is_none());
        assert!(state.zip_intents.consume_confirmed(&result.import_intent_id, descriptor, &Default::default()).is_none());
        let scope = AccountWriteScope { ids: [descriptor.id.clone()].into(), ..Default::default() };
        let lease = crate::account_workflows::AccountLease::detached_for_test(scope.clone());
        let owner = state.account_lifecycle.try_import_persistence(lease, &scope, &reservation).unwrap();
        let outcome = accounts_doc::run(&accounts_doc::shared(&state.app_dir), "accounts.put",
            &serde_json::json!({"entry": descriptor, "ifAbsent": true}), accounts_doc::LiveScrub::Preserve).unwrap();
        assert_eq!(outcome.membership.added, added);
        state.account_lifecycle.apply_committed_membership(Some(&owner), &outcome.membership);
        assert!(state.account_lifecycle.capture(&descriptor.id).is_ok());
        let consumed = state.zip_intents.consume_confirmed(&result.import_intent_id, descriptor, &outcome.membership.added).unwrap();
        assert!(consumed.stamp(&descriptor.id).is_ok());
        assert!(state.zip_intents.consume_confirmed(&result.import_intent_id, descriptor, &outcome.membership.added).is_none());
        let restarted = DaemonState::for_test(vault.path().to_path_buf(), state.app_dir.clone(), true);
        assert!(restarted.zip_intents.reservation_for(&result.import_intent_id, descriptor).is_none());
    }

    #[test]
    fn p4_zip_ignores_stale_caller_mapping_and_uses_authoritative_target() {
        let (vault, state) = state(true);
        std::fs::write(state.app_dir.join("accounts.json"), r#"[{"id":"actual","email":"same@test.com"}]"#).unwrap();
        let zip = build_zip(&state.app_dir, "p4-mapping.zip", &[("mailvault-backup/emails/same@test.com/INBOX/6:2,.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "same@test.com".into(), imap_server: None, smtp_server: None }]));
        let stale = vec![AccountsJsonEntry { id: "caller-stale".into(), email: Some("same@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let result = import(&state, zip, stale, |_, _| {}).unwrap();
        assert!(result.complete);
        assert_eq!(result.email_count, 1);
        assert!(result.new_accounts.is_empty());
        assert!(message_store::read_raw(vault.path(), "actual", "INBOX", 6).unwrap().is_some());
        assert!(message_store::read_raw(vault.path(), "caller-stale", "INBOX", 6).unwrap().is_none());
    }

    #[test]
    fn p4_zip_pre_effect_unwind_releases_intent_and_reservation() {
        let (_vault, state) = state(true);
        let zip = build_zip(&state.app_dir, "p4-unwind.zip", &[("mailvault-backup/emails/new@test.com/INBOX/4:2,.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "new@test.com".into(), imap_server: None, smtp_server: None }]));
        let id = std::sync::Mutex::new(None::<String>);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = import(&state, zip, Vec::new(), |_, _| {
                let intents = state.zip_intents.0.lock().unwrap();
                let pending = intents.values().next().unwrap();
                *id.lock().unwrap() = Some(pending.targets.values().next().unwrap().id().to_owned());
                drop(intents);
                panic!("synthetic progress listener unwind before file effect");
            });
        }));
        assert!(caught.is_err());
        assert!(state.zip_intents.0.lock().unwrap().is_empty());
        let id = id.lock().unwrap().clone().unwrap();
        assert!(matches!(state.account_lifecycle.capture(&id), Err(crate::account_lifecycle::LifecycleError::Unknown)));
    }

    #[tokio::test]
    async fn p4_zip_close_first_refuses_before_file_effect() {
        let (vault, state) = state(true);
        std::fs::write(state.app_dir.join("accounts.json"), r#"[{"id":"a","email":"a@test.com"}]"#).unwrap();
        let listing = accounts_doc::list(&accounts_doc::shared(&state.app_dir)).unwrap();
        state.account_lifecycle.seed(&listing);
        let lease = crate::account_workflows::AccountLease::detached_for_test(AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() });
        let mut claim = state.account_lifecycle.try_close(lease, "a").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        let zip = build_zip(&state.app_dir, "p4-retired.zip", &[("mailvault-backup/emails/a@test.com/INBOX/9:2,.eml", b"body")],
            &manifest_for(vec![BackupAccount { email: "a@test.com".into(), imap_server: None, smtp_server: None }]));
        assert!(import(&state, zip, Vec::new(), |_, _| {}).is_err());
        assert!(message_store::read_raw(vault.path(), "a", "INBOX", 9).unwrap().is_none());
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

    #[tokio::test(flavor = "multi_thread")]
    async fn p4_zip_existing_target_child_blocks_close() {
        struct Drain { release: Option<std::sync::mpsc::Sender<()>>, done: Option<std::sync::mpsc::Receiver<Result<u32,String>>> }
        impl Drain {
            fn finish(&mut self) -> Result<u32,String> {
                let _ = self.release.take().unwrap().send(());
                let result = self.done.as_ref().unwrap().recv_timeout(std::time::Duration::from_secs(5));
                let Ok(result) = result else { std::process::abort(); };
                self.done.take();
                result
            }
        }
        impl Drop for Drain {
            fn drop(&mut self) {
                if let Some(release) = self.release.take() { let _ = release.send(()); }
                if let Some(done) = self.done.take() {
                    if done.recv_timeout(std::time::Duration::from_secs(5)).is_err() { std::process::abort(); }
                }
            }
        }
        let (vault, s) = state(true);
        std::fs::write(s.app_dir.join("accounts.json"), r#"[{"id":"a","email":"a@test.com"},{"id":"b","email":"b@test.com"}]"#).unwrap();
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
        let manifest = manifest_for(vec![BackupAccount { email: "a@test.com".into(), imap_server: None, smtp_server: None }]);
        let zip_path = build_zip(&s.app_dir, "p4.zip", &[("mailvault-backup/emails/a@test.com/INBOX/7:2,.eml", b"Subject: imported\r\n\r\nbody")], &manifest);
        let existing = vec![AccountsJsonEntry { id: "a".into(), email: Some("a@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        import_write_pauses().lock().unwrap().insert(s.app_dir.clone(), ImportWritePause { entered: entered_tx, release: release_rx });
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_state = s.clone();
        let waiter = std::thread::spawn(move || {
            let result = import(&worker_state, zip_path, existing, |_, _| {}).map(|result| result.email_count);
            let _ = done_tx.send(result);
        });
        let mut drain = Drain { release: Some(release_tx), done: Some(done_rx) };
        let entered = entered_rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok();
        drop(waiter);
        let before = message_store::read_raw(vault.path(), "a", "INBOX", 7).unwrap();
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() });
        let close = s.account_lifecycle.try_close(lease, "a");
        let busy = matches!(&close, Err(crate::account_lifecycle::LifecycleError::Busy));
        if let Ok(mut claim) = close {
            let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
            claim.mark_effects_started(drained).unwrap();
            claim.finish_retired().unwrap();
        }
        let imported = drain.finish().unwrap();
        let after = message_store::read_raw(vault.path(), "a", "INBOX", 7).unwrap();
        assert!(entered && before.is_none() && after.is_some() && imported == 1,
            "real ZIP write observation failed: entered={entered} before={before:?} after={after:?} imported={imported}");
        assert!(s.account_lifecycle.try_operation(&[s.account_lifecycle.capture("b").unwrap()]).is_ok());
        assert!(busy, "ZIP file landed after A retired");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() });
        assert!(s.account_lifecycle.try_close(lease, "a").is_ok());
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

    /// A vault-only folder (an MBOX import kept on this computer) is a Maildir
    /// folder like any other to the export: its mail goes into the ZIP under
    /// its directory. Its marker is not mail and does not.
    #[test]
    fn export_includes_a_local_folders_mail() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"server mail");
        seed_file(v.path(), "acct1", "MBOX import 2026-09-29", 3_221_225_472, &["A"], b"imported mail");
        let folder = mailvault_core::vault_files::cur_path(v.path(), "acct1", "MBOX import 2026-09-29").parent().unwrap().to_path_buf();
        let marker = mailvault_core::local_folder::Marker { kind: "import".into(), name: "MBOX import 2026-09-29".into(), created: 1, source: "t.mbox".into() };
        mailvault_core::local_folder::write_marker(&folder, &marker).unwrap();
        let entries = vec![AccountsJsonEntry { id: "acct1".into(), email: Some("a@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let dest = tempfile::tempdir().unwrap().keep().join("out.zip");

        let result = export(&s, dest.clone(), &entries, vec![], None, false, |_, _| {}).unwrap();

        assert_eq!(result.email_count, 2);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        let file = mailvault_core::vault_files::build_maildir_filename(3_221_225_472, &["A".to_string()]);
        let mut body = String::new();
        archive.by_name(&format!("mailvault-backup/emails/a@test.com/MBOX_import_2026-09-29/{file}")).unwrap().read_to_string(&mut body).unwrap();
        assert_eq!(body, "imported mail");
        assert!(!(0..archive.len()).any(|i| archive.by_index(i).unwrap().name().contains(mailvault_core::local_folder::MARKER_FILE)));
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

    /// A zip entry's info separator is whatever platform wrote the backup —
    /// a mac/Linux export commonly lands on a Windows machine. Written
    /// verbatim, `:2,` on Windows is not an error: NTFS reads the `:` as an
    /// alternate-data-stream separator and silently creates a hidden stream
    /// under the bare uid instead of a real file, so the import reports
    /// success while the message is not really on disk under any name a
    /// listing will find. Hardcode `:2,` regardless of which platform this
    /// test itself runs on (unlike the sibling test above, which hardcodes
    /// `;2,`) so both directions are proven everywhere the suite runs; on a
    /// unix/mac runner this is already the platform's own spelling, so the
    /// respell is a no-op rename and the test still passes.
    #[test]
    fn import_respells_a_colon_spelled_entry_to_this_platforms_own_separator() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[("mailvault-backup/emails/new@test.com/INBOX/1:2,S.eml", b"body bytes")],
            &manifest_for(vec![BackupAccount { email: "new@test.com".into(), imap_server: Some("imap.test".into()), smtp_server: None }]),
        );

        let result = import(&s, zip_path, vec![], |_, _| {}).unwrap();

        assert_eq!(result.email_count, 1);
        let new_account = &result.new_accounts[0];
        let cur = mailvault_core::vault_files::cur_path(v.path(), &new_account.id, "INBOX");
        let expected_name = format!("1{}S.eml", mailvault_core::maildir::INFO_PREFIX);
        let dest = cur.join(&expected_name);
        assert!(
            dest.exists(),
            "the imported file must be named with this platform's INFO_PREFIX ({expected_name}), not the zip entry's original spelling"
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"body bytes", "respelling the name must not touch the message bytes");
        let written: Vec<_> = std::fs::read_dir(&cur).unwrap().collect();
        assert_eq!(written.len(), 1, "exactly one file, under the respelled name only");
    }

    #[test]
    fn import_extracts_under_the_gate_and_returns_new_account_descriptors() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[(format!("mailvault-backup/emails/new@test.com/INBOX/1{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body")],
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
            &[(format!("mailvault-backup/emails/known@test.com/INBOX/1{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body")],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let result = import_fixture(&s, zip_path, existing, |_, _| {}).unwrap();
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
                (format!("mailvault-backup/emails/known@test.com/INBOX/1{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body"),
                (format!("mailvault-backup/emails/known@test.com/INBOX/x{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"no uid"),
            ],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let result = import_fixture(&s, zip_path, existing, |_, _| {}).unwrap();
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
                (format!("mailvault-backup/emails/known@test.com/INBOX/1{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body1"),
                (format!("mailvault-backup/emails/known@test.com/Archive/2{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body2"),
            ],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let s2 = Arc::clone(&s);
        let result = import_fixture(&s, zip_path, existing, move |name, payload| {
            if name == "import-progress" && payload["completed"].as_u64() == Some(1) {
                s2.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        })
        .unwrap();

        assert_eq!(result.email_count, 1, "must stop after the first file once the gate starts refusing");
        assert!(!result.complete);
        assert!(s.zip_intents.0.lock().unwrap().contains_key(&result.import_intent_id));
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

        let result = import_fixture(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 0, "a path-traversal filename must be skipped, not written");
        assert!(!std::path::Path::new("/tmp/evil").exists(), "nothing may land outside the vault's Maildir tree");
        let inbox = mailvault_core::vault_files::cur_path(v.path(), "acct-known", "INBOX");
        assert!(!inbox.exists() || std::fs::read_dir(&inbox).unwrap().count() == 0);
    }

    fn files_under(root: &std::path::Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p) } else { out.push(p) }
            }
        }
        out
    }

    #[test]
    fn import_rejects_a_dot_only_mailbox_or_account_segment() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let name = |acct: &str, mbox: &str| format!("mailvault-backup/emails/{acct}/{mbox}/1{}A.eml", mailvault_core::maildir::INFO_PREFIX);
        let (dotdot, dot, evil_acct, ok) = (name("known@test.com", ".."), name("known@test.com", "."), name("..", "INBOX"), name("known@test.com", "INBOX"));
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[(dotdot.as_str(), b"p1"), (dot.as_str(), b"p2"), (evil_acct.as_str(), b"p3"), (ok.as_str(), b"good")],
            &manifest_for(vec![
                BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None },
                BackupAccount { email: "..".into(), imap_server: None, smtp_server: None },
            ]),
        );
        let existing = vec![
            AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None },
            AccountsJsonEntry { id: "..".into(), email: Some("..".into()), imap_server: None, smtp_server: None, created_at: None },
        ];

        let result = import_fixture(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1, "only the entry with real segments may be written");
        let written = files_under(&v.path().join("Maildir"));
        assert_eq!(written.len(), 1, "nothing else may land anywhere in Maildir: {written:?}");
        let inbox = mailvault_core::vault_files::cur_path(v.path(), "acct-known", "INBOX");
        assert!(written[0].starts_with(&inbox), "the one file must sit in a real mailbox dir: {:?}", written[0]);
        assert!(!v.path().join("Maildir").join("cur").exists(), "'..' mailbox must not resolve to Maildir/cur");
    }

    #[test]
    fn import_refuses_a_path_traversal_account_id_without_aliasing_it() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[(format!("mailvault-backup/emails/evil@test.com/INBOX/1{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body")],
            &manifest_for(vec![BackupAccount { email: "evil@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing =
            vec![AccountsJsonEntry { id: "../../../../../../tmp/evil".into(), email: Some("evil@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];

        let result = import_fixture(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 0);
        // A sanitized alias has no account admission and cannot be published.
        let escaped_name = format!("/tmp/evil/INBOX/cur/1{}A.eml", mailvault_core::maildir::INFO_PREFIX);
        let escaped = std::path::Path::new(&escaped_name);
        assert!(!escaped.exists(), "must not escape the vault root via account_id");

        let maildir = v.path().join("Maildir");
        assert!(!maildir.exists() || std::fs::read_dir(&maildir).unwrap().next().is_none());
    }

    #[test]
    fn import_skips_an_already_extracted_file_idempotently() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let zip_path = build_zip(
            dir.path(),
            "in.zip",
            &[(format!("mailvault-backup/emails/known@test.com/INBOX/1{}A.eml", mailvault_core::maildir::INFO_PREFIX).as_str(), b"body")],
            &manifest_for(vec![BackupAccount { email: "known@test.com".into(), imap_server: None, smtp_server: None }]),
        );
        let existing = vec![AccountsJsonEntry { id: "acct-known".into(), email: Some("known@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        seed_file(v.path(), "acct-known", "INBOX", 1, &["A"], b"already there");

        let result = import_fixture(&s, zip_path, existing, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 0, "an existing file is skipped, not overwritten or double-counted");
    }

    /// Task 7: a JMAP vault's ZIP export holds `.eml` entries named by each
    /// message's flags, with the exact bytes, and imports back as records.
    #[test]
    fn zip_export_entries_stay_eml_in_jmap_vault() {
        use mailvault_core::message_store::{self, Format};
        let (v, s) = state(true);
        message_store::set_vault_format(v.path(), Format::Jmap).unwrap();
        message_store::write(v.path(), "acct1", "INBOX", 1, b"Subject: one\r\n\r\nbody one", &["archived".to_string()]).unwrap();
        message_store::write(v.path(), "acct1", "INBOX", 2, b"Subject: two\r\n\r\nbody two", &[]).unwrap();
        let entries = vec![AccountsJsonEntry { id: "acct1".into(), email: Some("a@test.com".into()), imap_server: None, smtp_server: None, created_at: None }];
        let dest = tempfile::tempdir().unwrap().keep().join("out.zip");
        let accounts = vec![BackupAccount { email: "a@test.com".into(), imap_server: Some("imap.test".into()), smtp_server: None }];
        let result = export(&s, dest.clone(), &entries, accounts, None, false, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 2);

        let mut archive = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        let mut emails: Vec<String> =
            (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).filter(|n| n.contains("/emails/")).collect();
        emails.sort();
        let one = mailvault_core::vault_files::build_maildir_filename(1, &["A".to_string()]);
        let two = mailvault_core::vault_files::build_maildir_filename(2, &[]);
        assert_eq!(emails, vec![format!("mailvault-backup/emails/a@test.com/INBOX/{one}"), format!("mailvault-backup/emails/a@test.com/INBOX/{two}")]);
        let mut body = String::new();
        archive.by_name(&emails[0]).unwrap().read_to_string(&mut body).unwrap();
        assert_eq!(body, "Subject: one\r\n\r\nbody one", "the blob's exact bytes");
        let archived_only = export(&s, tempfile::tempdir().unwrap().keep().join("a.zip"), &entries, vec![], None, true, |_, _| {}).unwrap();
        assert_eq!(archived_only.email_count, 1, "the archived filter reads the record's flags");

        // Imported into a JMAP vault, the entries become records.
        let (v2, s2) = state(true);
        message_store::set_vault_format(v2.path(), Format::Jmap).unwrap();
        let imported = import(&s2, dest, vec![], |_, _| {}).unwrap();
        assert_eq!(imported.email_count, 2);
        let account = &imported.new_accounts[0].id;
        let first = message_store::find(v2.path(), account, "INBOX", 1).unwrap();
        assert_eq!((first.name.as_str(), first.flags.clone()), ("1.json", vec!["archived".to_string()]));
        assert_eq!(message_store::read_raw(v2.path(), account, "INBOX", 2).unwrap(), Some(b"Subject: two\r\n\r\nbody two".to_vec()));
    }
}
