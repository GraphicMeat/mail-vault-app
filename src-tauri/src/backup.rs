use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::external_location;
use crate::imap::{self, ImapConfig, ImapPool};

// ── Event payload ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct BackupProgress {
    pub account_id: String,
    pub folder: String,
    pub total_folders: usize,
    pub completed_folders: usize,
    pub total_emails: usize,
    pub completed_emails: usize,
    pub errors: usize,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub missing_in_folder: usize,
}

// ── Backup status comparison ─────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct FolderBackupStatus {
    pub path: String,
    pub name: String,
    pub server_count: usize,
    pub app_count: usize,
    pub external_count: usize,
    pub children: Vec<FolderBackupStatus>,
    // Legacy aliases for frontend compat
    #[serde(rename = "folder")]
    pub folder_alias: String,
    #[serde(rename = "local_count")]
    pub local_count_alias: usize,
}

#[derive(Serialize)]
pub struct AccountBackupStatus {
    pub folders: Vec<FolderBackupStatus>,
    pub total_server: usize,
    pub total_local: usize,
    pub total_app: usize,
    pub total_external: usize,
    pub external_available: bool,
}

/// Resolve the effective external backup path.
/// Prefers the caller-supplied path, falls back to bookmark-resolved path.
/// On macOS, starts security-scoped access for the resolved path.
/// Returns (resolved_path, needs_release) — caller must call release_backup_path if needs_release is true.
fn resolve_backup_path(
    app_handle: &tauri::AppHandle,
    caller_path: Option<String>,
) -> (Option<String>, bool) {
    // If caller provided a path, use it directly (legacy/Linux behavior)
    if let Some(ref p) = caller_path {
        if !p.is_empty() {
            return (caller_path, false);
        }
    }

    // Try bookmark-based resolution
    let data_dir = match app_handle.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return (None, false),
    };

    match external_location::resolve_external_location(&data_dir) {
        Ok((resolved, _loc)) => {
            info!("backup: resolved external location via bookmark: {}", resolved);
            (Some(resolved), true) // needs_release on macOS
        }
        Err(_) => (None, false),
    }
}

/// Release bookmark-based access if it was started.
fn release_backup_path(path: &str) {
    external_location::release_external_access(path);
}

/// Scan UIDs from an external backup directory.
fn scan_external_uids(
    backup_path: &str,
    email: &str,
    mailbox: &str,
) -> HashSet<u32> {
    let cur_dir = std::path::PathBuf::from(backup_path)
        .join(email)
        .join(mailbox)
        .join("cur");
    if !cur_dir.exists() {
        return HashSet::new();
    }
    let mut uids = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&cur_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let uid_str = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or("");
            if let Ok(uid) = uid_str.parse::<u32>() {
                uids.insert(uid);
            }
        }
    }
    uids
}

/// Build a FolderBackupStatus for one folder.
fn build_folder_status(
    path: &str,
    name: &str,
    server_count: usize,
    app_handle: &tauri::AppHandle,
    account_id: &str,
    backup_path: Option<&str>,
    email: &str,
    children: Vec<FolderBackupStatus>,
) -> FolderBackupStatus {
    let app_count = scan_local_uids(app_handle, account_id, path).unwrap_or_default().len();
    let external_count = match backup_path {
        Some(bp) => scan_external_uids(bp, email, path).len(),
        None => 0,
    };
    FolderBackupStatus {
        path: path.to_string(),
        name: name.to_string(),
        server_count,
        app_count,
        external_count,
        children,
        folder_alias: path.to_string(),
        local_count_alias: app_count,
    }
}

/// Compare server email counts vs local backup counts for each folder.
pub async fn get_backup_status(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    backup_path: Option<String>,
) -> Result<AccountBackupStatus, String> {
    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    // Resolve external path via bookmark if needed
    let (resolved_path, needs_release) = resolve_backup_path(&app_handle, backup_path);

    let result = if account.oauth2_transport.as_deref() == Some("graph") {
        get_graph_backup_status(app_handle.clone(), account_id, account_json, resolved_path.clone()).await
    } else {
        get_imap_backup_status(app_handle.clone(), account_id, account, resolved_path.clone()).await
    };

    // Release bookmark access
    if needs_release {
        if let Some(ref p) = resolved_path { release_backup_path(p); }
    }

    result
}

/// IMAP backup status with folder hierarchy.
async fn get_imap_backup_status(
    app_handle: tauri::AppHandle,
    account_id: String,
    account: ImapConfig,
    backup_path: Option<String>,
) -> Result<AccountBackupStatus, String> {
    let pool = app_handle.state::<ImapPool>();

    let mailboxes = {
        let mut guard = pool.get_background(&account).await?;
        let result = imap::list_mailboxes(&mut guard.session).await?;
        pool.return_background(&account, guard).await;
        result
    };

    let mut total_server = 0usize;
    let mut total_app = 0usize;
    let mut total_external = 0usize;

    // Build tree recursively, getting server counts via IMAP
    async fn build_tree(
        pool: &ImapPool,
        account: &ImapConfig,
        app_handle: &tauri::AppHandle,
        account_id: &str,
        mailboxes: &[imap::MailboxInfo],
        backup_path: Option<&str>,
        total_server: &mut usize,
        total_app: &mut usize,
        total_external: &mut usize,
    ) -> Vec<FolderBackupStatus> {
        let mut result = Vec::new();
        for mbox in mailboxes {
            // Recurse into children first
            let children = Box::pin(build_tree(
                pool, account, app_handle, account_id,
                &mbox.children, backup_path,
                total_server, total_app, total_external,
            )).await;

            if mbox.noselect {
                // Non-selectable folder: include only if it has children with data
                if !children.is_empty() {
                    result.push(FolderBackupStatus {
                        path: mbox.path.clone(),
                        name: mbox.name.clone(),
                        server_count: 0,
                        app_count: 0,
                        external_count: 0,
                        children,
                        folder_alias: mbox.path.clone(),
                        local_count_alias: 0,
                    });
                }
                continue;
            }

            let server_uids = {
                let mut guard = pool.get_background(account).await.unwrap_or_else(|_| panic!("pool"));
                let r = imap::search_all_uids(&mut guard.session, &mbox.path, false).await;
                pool.return_background(account, guard).await;
                r.unwrap_or_default()
            };
            let sc = server_uids.len();

            let status = build_folder_status(
                &mbox.path, &mbox.name, sc,
                app_handle, account_id, backup_path, &account.email,
                children,
            );

            *total_server += sc;
            *total_app += status.app_count;
            *total_external += status.external_count;

            if sc > 0 || status.app_count > 0 || status.external_count > 0 || !status.children.is_empty() {
                result.push(status);
            }
        }
        result
    }

    let folders = build_tree(
        &pool, &account, &app_handle, &account_id,
        &mailboxes, backup_path.as_deref(),
        &mut total_server, &mut total_app, &mut total_external,
    ).await;

    // Check if external path exists and is accessible
    let external_available = backup_path.as_ref().map_or(false, |p| std::path::Path::new(p).exists());

    Ok(AccountBackupStatus {
        folders,
        total_server,
        total_local: total_app, // legacy compat
        total_app,
        total_external,
        external_available,
    })
}

/// Graph/Outlook backup status — uses total_item_count from folder metadata.
async fn get_graph_backup_status(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    backup_path: Option<String>,
) -> Result<AccountBackupStatus, String> {
    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;
    let access_token = account
        .access_token
        .as_deref()
        .ok_or_else(|| "Missing OAuth2 access token for Graph account".to_string())?;
    let email = account.email.as_str();

    let client = crate::graph::GraphClient::new(access_token);
    let graph_folders = client.list_folders().await?;

    let mut folders = Vec::new();
    let mut total_server = 0usize;
    let mut total_app = 0usize;
    let mut total_external = 0usize;

    for gf in &graph_folders {
        let mailbox_path = normalize_graph_folder_name(&gf.display_name);
        let sc = gf.total_item_count.max(0) as usize;
        let app_count = scan_local_uids(&app_handle, &account_id, &mailbox_path).unwrap_or_default().len();
        let ext_count = match backup_path.as_deref() {
            Some(bp) => scan_external_uids(bp, email, &mailbox_path).len(),
            None => 0,
        };

        total_server += sc;
        total_app += app_count;
        total_external += ext_count;

        if sc > 0 || app_count > 0 || ext_count > 0 {
            folders.push(FolderBackupStatus {
                path: mailbox_path.clone(),
                name: gf.display_name.clone(),
                server_count: sc,
                app_count,
                external_count: ext_count,
                children: vec![],
                folder_alias: mailbox_path,
                local_count_alias: app_count,
            });
        }
    }

    let external_available = backup_path.as_ref().map_or(false, |p| std::path::Path::new(p).exists());

    Ok(AccountBackupStatus {
        folders,
        total_server,
        total_local: total_app,
        total_app,
        total_external,
        external_available,
    })
}

// ── Result ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct BackupResult {
    pub emails_backed_up: usize,
    pub errors: usize,
    pub duration_secs: f64,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// True if backup was cancelled mid-run (for resume support)
    #[serde(default)]
    pub cancelled: bool,
    /// Number of folders completed before cancel/finish (resume checkpoint)
    #[serde(default)]
    pub completed_folders: usize,
}

// ── Cancellation token (shared app state) ────────────────────────────────────

pub struct BackupCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);

impl Default for BackupCancelToken {
    fn default() -> Self {
        BackupCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

// ── Scan local UIDs from Maildir ─────────────────────────────────────────────

fn scan_local_uids(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
) -> Result<HashSet<u32>, String> {
    let cur_dir = crate::maildir_cur_path(app_handle, account_id, mailbox)?;
    if !cur_dir.exists() {
        return Ok(HashSet::new());
    }

    let mut uids = HashSet::new();
    let entries = std::fs::read_dir(&cur_dir)
        .map_err(|e| format!("Failed to read Maildir cur dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Filename format: "<uid>:<flags>.eml" or "<uid>.eml" or "<uid>_<flags>.eml"
        let uid_str = name
            .split(|c: char| c == ':' || c == '.' || c == '_')
            .next()
            .unwrap_or("");
        if let Ok(uid) = uid_str.parse::<u32>() {
            uids.insert(uid);
        }
    }

    Ok(uids)
}

// ── Core backup runner ───────────────────────────────────────────────────────

pub async fn run_account_backup(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    cancel: Arc<AtomicBool>,
    backup_path: Option<String>,
    skip_folders: usize,
) -> Result<BackupResult, String> {
    let start = std::time::Instant::now();

    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;

    // Resolve external path via bookmark if needed
    let (resolved_path, needs_release) = resolve_backup_path(&app_handle, backup_path);
    if resolved_path.is_some() {
        info!("backup: using external path: {:?}", resolved_path);
    }

    // Check if this is a Graph account
    let is_graph = account.oauth2_transport.as_deref() == Some("graph");

    let result = if is_graph {
        run_graph_backup(app_handle, account_id, account_json, cancel, start, resolved_path.clone(), skip_folders).await
    } else {
        run_imap_backup_inner(app_handle, account_id, account_json, account, cancel, start, resolved_path.clone(), skip_folders).await
    };

    // Release bookmark access after backup completes
    if needs_release {
        if let Some(ref p) = resolved_path { release_backup_path(p); }
    }

    result
}

async fn run_imap_backup_inner(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    account: ImapConfig,
    cancel: Arc<AtomicBool>,
    start: std::time::Instant,
    backup_path: Option<String>,
    skip_folders: usize,
) -> Result<BackupResult, String> {

    // ── IMAP path ────────────────────────────────────────────────────────────

    let pool = app_handle.state::<ImapPool>();

    // List all mailboxes
    let mailboxes = {
        let mut guard = pool.get_background(&account).await?;
        let result = imap::list_mailboxes(&mut guard.session).await?;
        pool.return_background(&account, guard).await;
        result
    };

    // Flatten and filter to selectable mailboxes
    let all_flat = flatten_mailboxes(&mailboxes);
    info!(
        "backup: {} — {} total mailboxes from LIST, names: [{}]",
        account.email,
        all_flat.len(),
        all_flat.iter().map(|m| format!("{}(noselect={})", m.path, m.noselect)).collect::<Vec<_>>().join(", ")
    );
    let selectable: Vec<_> = all_flat
        .into_iter()
        .filter(|m| !m.noselect)
        .collect();

    let total_folders = selectable.len();
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;

    info!(
        "backup: starting for {} ({} selectable folders)",
        account.email, total_folders
    );

    let mut cancelled = false;

    for (folder_idx, mbox) in selectable.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            warn!("backup: cancelled for {} at folder {}/{}", account.email, completed_folders, total_folders);
            cancelled = true;
            break;
        }

        // Skip folders already completed in a previous run (resume support)
        if folder_idx < skip_folders {
            completed_folders += 1;
            continue;
        }

        let mailbox_path = &mbox.path;

        // Every 5 folders, drop pooled sessions to force re-auth on next use.
        // This prevents OAuth2 token expiry during long backups (tokens last ~1 hour).
        if folder_idx > 0 && folder_idx % 5 == 0 {
            pool.clear_background(&account).await;
            info!("backup: cleared pool sessions at folder {} to refresh auth", folder_idx);
        }

        // Get server UIDs — always use plain UID SEARCH ALL for backup reliability.
        // ESEARCH can corrupt the session buffer on large mailboxes (imap_proto parser limit),
        // and the corrupted session makes all subsequent commands return 0 results.
        let server_uids = {
            let mut guard = pool.get_background(&account).await?;
            let result = imap::search_all_uids(&mut guard.session, mailbox_path, false).await;
            pool.return_background(&account, guard).await;
            result?
        };

        // Get local UIDs
        let local_uids = scan_local_uids(&app_handle, &account_id, mailbox_path)?;

        // Compute delta
        let missing: Vec<u32> = server_uids
            .iter()
            .filter(|uid| !local_uids.contains(uid))
            .copied()
            .collect();

        info!(
            "backup: {} — server={} uids, local={} uids, missing={} to back up",
            mailbox_path,
            server_uids.len(),
            local_uids.len(),
            missing.len()
        );

        // Only emit progress at 25%, 50%, 75% and completion — not every folder
        // This prevents flooding the JS event loop with re-renders
        let progress_pct = if total_folders > 0 { (folder_idx * 100) / total_folders } else { 0 };
        let should_emit = folder_idx == 0 || progress_pct % 25 == 0 || missing.len() > 0;
        if should_emit {
            let _ = app_handle.emit(
                "backup-progress",
                BackupProgress {
                    account_id: account_id.clone(),
                    folder: mailbox_path.clone(),
                    total_folders,
                    completed_folders,
                    total_emails: total_backed_up + total_errors,
                    completed_emails: total_backed_up,
                    errors: total_errors,
                    active: true,
                    last_error: None,
                    missing_in_folder: missing.len(),
                },
            );
        }

        // Pre-sync: copy files that exist in one location but not the other
        if let Some(ref custom_path) = backup_path {
            let app_dir = crate::maildir_cur_path(&app_handle, &account_id, mailbox_path)?;
            let backup_dir = std::path::PathBuf::from(custom_path)
                .join(&account.email)
                .join(mailbox_path)
                .join("cur");
            let synced = sync_locations(&app_dir, &backup_dir);
            if synced > 0 {
                info!("backup: pre-synced {} files between app and backup for {}", synced, mailbox_path);
            }
        }

        if !missing.is_empty() {
            // Fetch and store to BOTH app dir and backup dir simultaneously
            let archive_result = crate::archive::run_with_backup(
                app_handle.clone(),
                account_id.clone(),
                account_json.clone(),
                mailbox_path.clone(),
                missing,
                Arc::clone(&cancel),
                backup_path.clone(),
                Some(account.email.clone()),
            )
            .await?;

            total_backed_up += archive_result.completed;
            total_errors += archive_result.errors;
        }

        completed_folders += 1;
    }

    // Emit final completion/cancelled event (single event per account)
    let _ = app_handle.emit(
        "backup-progress",
        BackupProgress {
            account_id: account_id.clone(),
            folder: if cancelled { "Cancelled".to_string() } else { "Complete".to_string() },
            total_folders,
            completed_folders,
            total_emails: total_backed_up + total_errors,
            completed_emails: total_backed_up,
            errors: total_errors,
            active: false,
            last_error: None,
            missing_in_folder: 0,
        },
    );

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup: {} for {} — {} new emails backed up, {} errors, {:.1}s{} (folders: {}/{})",
        if cancelled { "cancelled" } else { "completed" },
        account.email, total_backed_up, total_errors, duration,
        if let Some(ref p) = backup_path { format!(" (copied to {})", p) } else { String::new() },
        completed_folders, total_folders
    );

    Ok(BackupResult {
        emails_backed_up: total_backed_up,
        errors: total_errors,
        duration_secs: duration,
        success: !cancelled && total_errors == 0,
        error_message: None,
        cancelled,
        completed_folders,
    })
}

/// Sync files between app Maildir and backup location (bidirectional).
/// - App dir files missing from backup → copy to backup as <uid>.eml
/// - Backup .eml files missing from app dir → copy to app dir
/// Returns total files synced.
fn sync_locations(app_dir: &std::path::Path, backup_dir: &std::path::Path) -> usize {
    use std::fs;
    let mut synced = 0;

    // Ensure both dirs exist; if backup dir can't be created (disconnected drive), skip
    let _ = fs::create_dir_all(app_dir);
    if fs::create_dir_all(backup_dir).is_err() {
        return 0; // Backup location not available — skip sync, backup to app dir only
    }

    // App → Backup: copy app files that don't exist in backup
    if let Ok(entries) = fs::read_dir(app_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            let uid_str = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or(&name);
            if uid_str.parse::<u32>().is_err() { continue; }
            let dst = backup_dir.join(format!("{}.eml", uid_str));
            if !dst.exists() {
                if fs::copy(entry.path(), &dst).is_ok() { synced += 1; }
            }
        }
    }

    // Backup → App: copy backup .eml files that don't exist in app dir
    if let Ok(entries) = fs::read_dir(backup_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".eml") { continue; }
            let uid_str = name.trim_end_matches(".eml");
            if uid_str.parse::<u32>().is_err() { continue; }
            // Check if app dir already has this UID (any filename starting with uid)
            let uid: u32 = uid_str.parse().unwrap();
            let exists_in_app = super::find_file_by_uid(app_dir, uid).is_some();
            if !exists_in_app {
                let dst = app_dir.join(format!("{}:2,", uid));
                if fs::copy(entry.path(), &dst).is_ok() { synced += 1; }
            }
        }
    }

    synced
}

// ── Graph API backup path ────────────────────────────────────────────────────

async fn run_graph_backup(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    cancel: Arc<AtomicBool>,
    start: std::time::Instant,
    backup_path: Option<String>,
    skip_folders: usize,
) -> Result<BackupResult, String> {
    let account: ImapConfig = serde_json::from_str(&account_json)
        .map_err(|e| format!("Bad account JSON: {}", e))?;
    let access_token = account
        .access_token
        .as_deref()
        .ok_or_else(|| "Missing OAuth2 access token for Graph account".to_string())?;

    let client = crate::graph::GraphClient::new(access_token);

    // List folders
    let folders = client.list_folders().await?;
    let total_folders = folders.len();
    let mut completed_folders = 0usize;
    let mut total_backed_up = 0usize;
    let mut total_errors = 0usize;

    info!(
        "backup(graph): starting for account {} ({} folders, skipping first {})",
        account_id, total_folders, skip_folders
    );

    let mut cancelled = false;

    for (folder_idx, folder) in folders.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            warn!("backup(graph): cancelled for account {} at folder {}/{}", account_id, completed_folders, total_folders);
            cancelled = true;
            break;
        }

        // Skip folders already completed in a previous run (resume support)
        if folder_idx < skip_folders {
            completed_folders += 1;
            continue;
        }

        let folder_name = &folder.display_name;
        // Normalize folder name for Maildir path (same as frontend mapping)
        let mailbox_path = normalize_graph_folder_name(folder_name);

        // Get local UIDs
        let local_uids = scan_local_uids(&app_handle, &account_id, &mailbox_path)?;

        // Pre-sync: copy files between app and external backup (bidirectional)
        if let Some(ref custom_path) = backup_path {
            let app_dir = crate::maildir_cur_path(&app_handle, &account_id, &mailbox_path)?;
            let backup_dir = std::path::PathBuf::from(custom_path)
                .join(&account.email)
                .join(&mailbox_path)
                .join("cur");
            let synced = sync_locations(&app_dir, &backup_dir);
            if synced > 0 {
                info!("backup(graph): pre-synced {} files between app and backup for {}", synced, mailbox_path);
            }
        }

        // Paginate through all messages to find missing ones
        let mut skip = 0u32;
        let page_size = 100u32;
        let mut uid_counter = 0u32;

        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let (messages, next_link) = client.list_messages(&folder.id, page_size, skip).await?;
            if messages.is_empty() {
                break;
            }

            for msg in &messages {
                uid_counter += 1;
                if local_uids.contains(&uid_counter) {
                    continue;
                }

                // Fetch MIME content and store to app dir + external backup dir
                match client.get_mime_content(&msg.id).await {
                    Ok(raw_bytes) => {
                        let cur_dir =
                            crate::maildir_cur_path(&app_handle, &account_id, &mailbox_path)?;
                        std::fs::create_dir_all(&cur_dir)
                            .map_err(|e| format!("mkdir: {}", e))?;

                        if crate::find_file_by_uid(&cur_dir, uid_counter).is_none() {
                            let filename = crate::build_maildir_filename(
                                uid_counter,
                                &[] as &[String],
                            );
                            std::fs::write(cur_dir.join(&filename), &raw_bytes)
                                .map_err(|e| format!("write .eml: {}", e))?;

                            // Also write to external backup if configured
                            if let Some(ref custom_path) = backup_path {
                                let backup_dir = std::path::PathBuf::from(custom_path)
                                    .join(&account.email)
                                    .join(&mailbox_path)
                                    .join("cur");
                                let _ = std::fs::create_dir_all(&backup_dir);
                                let dst = backup_dir.join(format!("{}.eml", uid_counter));
                                if !dst.exists() {
                                    let _ = std::fs::write(&dst, &raw_bytes);
                                }
                            }

                            total_backed_up += 1;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "backup(graph): failed to fetch message {} in {}: {}",
                            msg.id, folder_name, e
                        );
                        total_errors += 1;
                    }
                }
            }

            if next_link.is_none() || messages.len() < page_size as usize {
                break;
            }
            skip += page_size;
        }

        completed_folders += 1;

        let _ = app_handle.emit(
            "backup-progress",
            BackupProgress {
                account_id: account_id.clone(),
                folder: mailbox_path,
                total_folders,
                completed_folders,
                total_emails: total_backed_up + total_errors,
                completed_emails: total_backed_up,
                errors: total_errors,
                active: completed_folders < total_folders,
                last_error: None,
                missing_in_folder: 0,
            },
        );
    }

    let duration = start.elapsed().as_secs_f64();
    info!(
        "backup(graph): {} for {} — {} emails backed up, {} errors, {:.1}s (folders: {}/{})",
        if cancelled { "cancelled" } else { "completed" },
        account_id, total_backed_up, total_errors, duration,
        completed_folders, total_folders
    );

    Ok(BackupResult {
        emails_backed_up: total_backed_up,
        errors: total_errors,
        duration_secs: duration,
        success: !cancelled && total_errors == 0,
        error_message: None,
        cancelled,
        completed_folders,
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Flatten nested mailbox tree into a flat list
fn flatten_mailboxes(mailboxes: &[imap::MailboxInfo]) -> Vec<&imap::MailboxInfo> {
    let mut result = Vec::new();
    for m in mailboxes {
        result.push(m);
        if !m.children.is_empty() {
            result.extend(flatten_mailboxes(&m.children));
        }
    }
    result
}

/// Normalize Graph folder display name to IMAP-style path
fn normalize_graph_folder_name(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "inbox" => "INBOX".to_string(),
        "sent items" => "Sent".to_string(),
        "deleted items" => "Trash".to_string(),
        "drafts" => "Drafts".to_string(),
        "junk email" => "Junk".to_string(),
        "archive" => "Archive".to_string(),
        _ => name.to_string(),
    }
}
