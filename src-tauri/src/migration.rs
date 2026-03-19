use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::graph::GraphClient;
use crate::imap::{self, ImapConfig, ImapPool, ImapSession, MailboxInfo};

// ── Data structures ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolderMapping {
    pub source_path: String,
    pub dest_path: String,
    pub source_special_use: Option<String>,
    pub dest_folder_id: Option<String>,
    pub email_count: u32,
    pub status: String,
    pub migrated: u32,
    pub skipped: u32,
    pub failed: u32,
    #[serde(default)]
    pub failed_uids: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MigrationLogEntry {
    pub timestamp: String,
    pub sender: String,
    pub subject: String,
    pub status: String, // "ok", "skipped", "failed"
}

#[derive(Clone, Debug, Serialize)]
pub struct MigrationProgress {
    pub source_email: String,
    pub dest_email: String,
    pub total_emails: u32,
    pub migrated_emails: u32,
    pub skipped_emails: u32,
    pub failed_emails: u32,
    pub current_folder: Option<String>,
    pub folder_progress: Option<String>,
    pub status: String,
    pub folders: Vec<FolderMapping>,
    pub started_at: String,
    pub elapsed_seconds: u64,
    pub last_log_entry: Option<MigrationLogEntry>,
    pub rate_limit_remaining: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigrationState {
    pub id: String,
    pub source_email: String,
    pub dest_email: String,
    pub source_transport: String,
    pub dest_transport: String,
    pub source_account_json: String,
    pub dest_account_json: String,
    pub status: String,
    pub folder_mappings: Vec<FolderMapping>,
    pub total_emails: u32,
    pub migrated_emails: u32,
    pub skipped_emails: u32,
    pub failed_emails: u32,
    pub started_at: String,
    pub updated_at: String,
}

// ── Cancel / Pause tokens (shared app state) ────────────────────────────────

pub struct MigrationCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);

impl Default for MigrationCancelToken {
    fn default() -> Self {
        MigrationCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

pub struct MigrationPauseToken(pub std::sync::Mutex<Arc<AtomicBool>>);

impl Default for MigrationPauseToken {
    fn default() -> Self {
        MigrationPauseToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

pub struct MigrationNotify(pub std::sync::Mutex<Arc<tokio::sync::Notify>>);

impl Default for MigrationNotify {
    fn default() -> Self {
        MigrationNotify(std::sync::Mutex::new(Arc::new(tokio::sync::Notify::new())))
    }
}

// ── Folder mapping ──────────────────────────────────────────────────────────

/// Flatten a tree of MailboxInfo into a flat list (including children).
fn flatten_mailboxes(mailboxes: &[MailboxInfo]) -> Vec<&MailboxInfo> {
    let mut result = Vec::new();
    for mbox in mailboxes {
        result.push(mbox);
        if !mbox.children.is_empty() {
            result.extend(flatten_mailboxes(&mbox.children));
        }
    }
    result
}

/// Build folder mappings between source and destination mailbox lists.
/// Special-use folders (Sent, Trash, Drafts, Junk, Archive) are mapped by attribute.
/// Custom folders mirror the path with delimiter conversion.
/// Noselect folders are skipped.
pub fn build_folder_mappings(
    source_folders: &[MailboxInfo],
    dest_folders: &[MailboxInfo],
    source_delimiter: Option<&str>,
    dest_delimiter: Option<&str>,
) -> Vec<FolderMapping> {
    let src_flat = flatten_mailboxes(source_folders);
    let dst_flat = flatten_mailboxes(dest_folders);

    let src_delim = source_delimiter.unwrap_or("/");
    let dst_delim = dest_delimiter.unwrap_or("/");

    // Build a map of special-use -> dest path for quick lookup
    let mut dest_special_map: HashMap<String, String> = HashMap::new();
    let mut dest_special_id_map: HashMap<String, Option<String>> = HashMap::new();
    for d in &dst_flat {
        if let Some(ref su) = d.special_use {
            dest_special_map.insert(su.clone(), d.path.clone());
            dest_special_id_map.insert(su.clone(), None); // Graph ID populated later
        }
    }

    let mut mappings = Vec::new();

    for src in &src_flat {
        if src.noselect {
            continue;
        }

        let dest_path;
        let dest_folder_id = None;

        if let Some(ref su) = src.special_use {
            // Map by special-use attribute
            if let Some(dp) = dest_special_map.get(su) {
                dest_path = dp.clone();
            } else {
                // No matching special-use on dest — use same path with delimiter conversion
                dest_path = src.path.replace(src_delim, dst_delim);
            }
        } else {
            // Custom folder — mirror path with delimiter conversion
            dest_path = src.path.replace(src_delim, dst_delim);
        }

        mappings.push(FolderMapping {
            source_path: src.path.clone(),
            dest_path,
            source_special_use: src.special_use.clone(),
            dest_folder_id,
            email_count: 0,
            status: "pending".to_string(),
            migrated: 0,
            skipped: 0,
            failed: 0,
            failed_uids: Vec::new(),
        });
    }

    mappings
}

// ── Destination folder creation ─────────────────────────────────────────────

/// Ensure an IMAP destination folder exists (CREATE, ignore "already exists").
pub async fn ensure_dest_folder_imap(
    session: &mut ImapSession,
    folder_path: &str,
) -> Result<(), String> {
    match session.create(folder_path).await {
        Ok(_) => {
            info!("[migration] Created IMAP folder: {}", folder_path);
            Ok(())
        }
        Err(e) => {
            let err_str = format!("{}", e);
            let lower = err_str.to_lowercase();
            if lower.contains("alreadyexists") || lower.contains("already exists") || lower.contains("mailbox already exists") {
                Ok(())
            } else {
                Err(format!("CREATE {} failed: {}", folder_path, err_str))
            }
        }
    }
}

/// Ensure a Graph destination folder path exists, creating each level as needed.
/// Returns the final folder ID.
pub async fn ensure_dest_folder_graph(
    client: &GraphClient,
    folder_path: &str,
    delimiter: &str,
    folder_cache: &mut HashMap<String, String>,
) -> Result<String, String> {
    let parts: Vec<&str> = folder_path.split(delimiter).collect();
    let mut parent_id: Option<String> = None;
    let mut current_path = String::new();

    for part in parts {
        if !current_path.is_empty() {
            current_path.push_str(delimiter);
        }
        current_path.push_str(part);

        if let Some(cached_id) = folder_cache.get(&current_path) {
            parent_id = Some(cached_id.clone());
            continue;
        }

        let folder = client
            .create_folder(part, parent_id.as_deref())
            .await?;
        folder_cache.insert(current_path.clone(), folder.id.clone());
        parent_id = Some(folder.id);
    }

    parent_id.ok_or_else(|| "Empty folder path".to_string())
}

// ── Source Message-ID fetching (for dedup) ──────────────────────────────────

/// Fetch all Message-IDs from an IMAP mailbox for deduplication.
pub async fn fetch_dest_message_ids_imap(
    session: &mut ImapSession,
    mailbox: &str,
) -> Result<HashSet<String>, String> {
    use futures::StreamExt;

    let _mbox = imap::select_mailbox(session, mailbox).await?;

    let fetch_stream = session
        .uid_fetch("1:*", "BODY.PEEK[HEADER.FIELDS (Message-ID)]")
        .await
        .map_err(|e| format!("UID FETCH Message-ID failed: {}", e))?;

    let fetches: Vec<_> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut ids = HashSet::new();
    for fetch in &fetches {
        if let Some(header_bytes) = fetch.header() {
            let header_str = String::from_utf8_lossy(header_bytes);
            // Extract Message-ID from header
            for line in header_str.lines() {
                let lower = line.to_lowercase();
                if lower.starts_with("message-id:") {
                    let value = line["message-id:".len()..].trim();
                    if !value.is_empty() {
                        ids.insert(value.to_string());
                    }
                }
            }
        }
    }

    Ok(ids)
}

/// Fetch all internet message IDs from a Graph folder for deduplication.
pub async fn fetch_dest_message_ids_graph(
    client: &GraphClient,
    folder_id: &str,
) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    let mut skip = 0u32;
    let top = 1000u32;

    loop {
        let url = format!(
            "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages?$select=internetMessageId&$top={}&$skip={}",
            folder_id, top, skip
        );

        let resp = client.client
            .get(&url)
            .bearer_auth(&client.access_token)
            .send()
            .await
            .map_err(|e| format!("Graph fetch message IDs failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph fetch message IDs failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        #[derive(Deserialize)]
        struct MsgId {
            #[serde(rename = "internetMessageId")]
            internet_message_id: Option<String>,
        }

        let list: crate::graph::GraphListResponse<MsgId> = resp
            .json()
            .await
            .map_err(|e| format!("Graph message IDs parse error: {}", e))?;

        for msg in &list.value {
            if let Some(ref id) = msg.internet_message_id {
                ids.insert(id.clone());
            }
        }

        if list.next_link.is_none() || list.value.is_empty() {
            break;
        }
        skip += top;
    }

    Ok(ids)
}

// ── Message-ID extraction from raw MIME ──────────────────────────────────────

/// Extract the Message-ID from raw MIME bytes (searches first 8KB of headers).
/// Returns the Message-ID value including angle brackets, e.g. `<abc@example.com>`.
pub fn extract_message_id(mime_bytes: &[u8]) -> Option<String> {
    // Only search the first 8KB — headers are always at the top
    let search_len = mime_bytes.len().min(8192);
    let header_str = String::from_utf8_lossy(&mime_bytes[..search_len]);

    let mut in_message_id = false;
    let mut value = String::new();

    for line in header_str.lines() {
        if in_message_id {
            // Continuation line (starts with whitespace)
            if line.starts_with(' ') || line.starts_with('\t') {
                value.push_str(line.trim());
                continue;
            } else {
                // End of Message-ID header
                break;
            }
        }

        let lower = line.to_lowercase();
        if lower.starts_with("message-id:") {
            in_message_id = true;
            value = line["message-id:".len()..].trim().to_string();
        }
    }

    if value.is_empty() {
        return None;
    }

    // Extract the content between < and > if present
    if let Some(start) = value.find('<') {
        if let Some(end) = value.find('>') {
            if end > start {
                return Some(value[start..=end].to_string());
            }
        }
    }

    // Return raw value if no angle brackets
    Some(value)
}

// ── Single-email migration helpers ──────────────────────────────────────────

/// Migrate a single email: IMAP source -> IMAP destination.
pub async fn migrate_email_imap_to_imap(
    source_session: &mut ImapSession,
    dest_session: &mut ImapSession,
    source_mailbox: &str,
    dest_mailbox: &str,
    uid: u32,
) -> Result<bool, String> {
    use futures::StreamExt;

    // Fetch raw MIME + flags from source
    let _mbox = imap::select_mailbox(source_session, source_mailbox).await?;

    let fetch_stream = source_session
        .uid_fetch(uid.to_string(), "(UID FLAGS BODY.PEEK[])")
        .await
        .map_err(|e| format!("UID FETCH {} failed: {}", uid, e))?;

    let fetches: Vec<_> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Email UID {} not found", uid))?;

    let mime_bytes = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {}", uid))?;

    // Extract flags — convert async-imap Flag enum to IMAP flag strings
    let flags: Vec<String> = fetch
        .flags()
        .filter_map(|f| {
            use async_imap::types::Flag;
            match f {
                Flag::Seen => Some("\\Seen".to_string()),
                Flag::Answered => Some("\\Answered".to_string()),
                Flag::Flagged => Some("\\Flagged".to_string()),
                Flag::Deleted => Some("\\Deleted".to_string()),
                Flag::Draft => Some("\\Draft".to_string()),
                Flag::Recent => None, // Recent is server-only, skip
                _ => None,
            }
        })
        .collect();
    let flags_str = flags.join(" ");

    // Append to destination
    imap::append_email(dest_session, dest_mailbox, mime_bytes, &flags_str).await?;

    Ok(true)
}

/// Migrate a single email: Graph source -> IMAP destination.
pub async fn migrate_email_graph_to_imap(
    client: &GraphClient,
    dest_session: &mut ImapSession,
    message_id: &str,
    dest_mailbox: &str,
    is_read: bool,
) -> Result<bool, String> {
    let mime_bytes = client.get_mime_content(message_id).await?;

    let flags_str = if is_read { "\\Seen".to_string() } else { String::new() };

    imap::append_email(dest_session, dest_mailbox, &mime_bytes, &flags_str).await?;

    Ok(true)
}

/// Migrate a single email to a Graph destination (from raw MIME).
/// Creates a draft from MIME, moves it to the target folder, sets read status.
pub async fn migrate_email_to_graph(
    source_mime: &[u8],
    client: &GraphClient,
    dest_folder_id: &str,
    is_read: bool,
) -> Result<bool, String> {
    // Create message from MIME (lands in Drafts)
    let draft_id = client.create_message_from_mime(source_mime).await?;

    // Move to destination folder
    let final_id = client.move_message(&draft_id, dest_folder_id).await?;

    // Set read status
    if is_read {
        client.set_read_status(&final_id, true).await?;
    }

    Ok(true)
}

// ── Interruptible sleep & helpers ─────────────────────────────────────────────

/// Interruptible async sleep. Returns true if interrupted (cancel/pause signaled), false if sleep completed normally.
async fn interruptible_sleep(
    duration: std::time::Duration,
    cancel: &AtomicBool,
    notify: &tokio::sync::Notify,
) -> bool {
    let _ = cancel; // used by caller after wakeup
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        _ = notify.notified() => true,
    }
}

/// Parse retry-after seconds from error string format "(429:retry_after=N)"
fn parse_retry_after(err: &str) -> Option<u64> {
    let marker = "(429:retry_after=";
    let start = err.find(marker)? + marker.len();
    let rest = &err[start..];
    rest.split(')').next()?.parse().ok()
}

/// Extract sender email and subject from raw MIME bytes for log display.
/// Returns (sender, subject) -- falls back to "unknown" if parsing fails.
fn extract_sender_subject(mime_bytes: &[u8]) -> (String, String) {
    let search_len = mime_bytes.len().min(8192);
    let header_str = String::from_utf8_lossy(&mime_bytes[..search_len]);

    let mut sender = String::from("unknown");
    let mut subject = String::new();

    for line in header_str.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("from:") {
            let val = line["from:".len()..].trim();
            // Extract email from "Name <email>" or bare email
            if let Some(start) = val.find('<') {
                if let Some(end) = val.find('>') {
                    sender = val[start + 1..end].to_string();
                }
            } else if val.contains('@') {
                sender = val.to_string();
            } else {
                sender = val.to_string();
            }
        } else if lower.starts_with("subject:") {
            subject = line["subject:".len()..].trim().to_string();
        }
        // Stop after blank line (end of headers)
        if line.is_empty() {
            break;
        }
    }

    (sender, subject)
}

// ── Main migration runner ───────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn run_migration(
    app_handle: tauri::AppHandle,
    source_config: ImapConfig,
    dest_config: ImapConfig,
    source_transport: String,
    dest_transport: String,
    source_account_json: String,
    dest_account_json: String,
    mut folder_mappings: Vec<FolderMapping>,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
) -> Result<MigrationState, String> {
    let source_email = source_config.email.clone();
    let dest_email = dest_config.email.clone();
    let started_at = chrono::Utc::now().to_rfc3339();
    let start_instant = std::time::Instant::now();

    let migration_id = uuid::Uuid::new_v4().to_string();

    info!(
        "[migration] run_migration tokens: cancel={:p}, pause={:p}, notify={:p}",
        &*cancel, &*pause, &*notify
    );
    info!(
        "[migration] Starting {} -> {} ({} -> {}, {} folders)",
        source_email, dest_email, source_transport, dest_transport, folder_mappings.len()
    );

    let pool = app_handle.state::<ImapPool>();

    // Total email count across all folders
    let total_emails: u32 = folder_mappings.iter().map(|f| f.email_count).sum();
    let mut migrated_total: u32 = 0;
    let mut skipped_total: u32 = 0;
    let mut failed_total: u32 = 0;

    let emit_progress = |status: &str,
                         current_folder: Option<String>,
                         folder_progress: Option<String>,
                         migrated: u32,
                         skipped: u32,
                         failed: u32,
                         folders: &[FolderMapping],
                         started_at: &str,
                         elapsed: u64,
                         source_email: &str,
                         dest_email: &str,
                         total: u32,
                         app: &tauri::AppHandle,
                         last_log_entry: Option<MigrationLogEntry>,
                         rate_limit_remaining: Option<u64>| {
        let _ = app.emit(
            "migration-progress",
            MigrationProgress {
                source_email: source_email.to_string(),
                dest_email: dest_email.to_string(),
                total_emails: total,
                migrated_emails: migrated,
                skipped_emails: skipped,
                failed_emails: failed,
                current_folder,
                folder_progress,
                status: status.to_string(),
                folders: folders.to_vec(),
                started_at: started_at.to_string(),
                elapsed_seconds: elapsed,
                last_log_entry,
                rate_limit_remaining,
            },
        );
    };

    // Graph folder cache for destination
    let mut graph_folder_cache: HashMap<String, String> = HashMap::new();

    // Pre-populate Graph folder cache from existing destination folders
    if dest_transport == "graph" {
        if let Some(ref token) = dest_config.access_token {
            let client = GraphClient::new(token);
            if let Ok(folders) = client.list_folders().await {
                for f in folders {
                    graph_folder_cache.insert(f.display_name.clone(), f.id.clone());
                }
            }
        }
    }

    let sem = Arc::new(Semaphore::new(3));

    for folder_idx in 0..folder_mappings.len() {
        if cancel.load(Ordering::Relaxed) {
            info!("[migration] Cancelled");
            folder_mappings[folder_idx].status = "cancelled".to_string();
            break;
        }

        // Pause loop — save state and wait
        if pause.load(Ordering::Relaxed) {
            let paused_state = MigrationState {
                id: migration_id.clone(),
                source_email: source_email.clone(),
                dest_email: dest_email.clone(),
                source_transport: source_transport.clone(),
                dest_transport: dest_transport.clone(),
                source_account_json: source_account_json.clone(),
                dest_account_json: dest_account_json.clone(),
                status: "paused".to_string(),
                folder_mappings: folder_mappings.clone(),
                total_emails,
                migrated_emails: migrated_total,
                skipped_emails: skipped_total,
                failed_emails: failed_total,
                started_at: started_at.clone(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            };
            let _ = save_migration_state(&app_handle, &paused_state);
            info!("[migration] Paused, state saved to disk");

            while pause.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                emit_progress(
                    "paused",
                    Some(folder_mappings[folder_idx].source_path.clone()),
                    None,
                    migrated_total,
                    skipped_total,
                    failed_total,
                    &folder_mappings,
                    &started_at,
                    start_instant.elapsed().as_secs(),
                    &source_email,
                    &dest_email,
                    total_emails,
                    &app_handle,
                    None,
                    None,
                );
                let _ = interruptible_sleep(std::time::Duration::from_millis(500), &cancel, &notify).await;
            }
        }

        if folder_mappings[folder_idx].status == "completed" {
            continue;
        }

        folder_mappings[folder_idx].status = "in_progress".to_string();
        let src_path = folder_mappings[folder_idx].source_path.clone();
        let dst_path = folder_mappings[folder_idx].dest_path.clone();

        info!("[migration] Processing folder: {} -> {}", src_path, dst_path);

        emit_progress(
            "running",
            Some(src_path.clone()),
            Some("0/0".to_string()),
            migrated_total,
            skipped_total,
            failed_total,
            &folder_mappings,
            &started_at,
            start_instant.elapsed().as_secs(),
            &source_email,
            &dest_email,
            total_emails,
            &app_handle,
            None,
            None,
        );

        // Ensure destination folder exists
        if dest_transport == "imap" {
            let mut guard = pool.get_priority(&dest_config).await?;
            if let Err(e) = ensure_dest_folder_imap(&mut guard.session, &dst_path).await {
                warn!("[migration] Failed to create dest folder {}: {}", dst_path, e);
                folder_mappings[folder_idx].status = "failed".to_string();
                guard.last_selected = None;
                pool.return_priority(&dest_config, guard).await;
                continue;
            }
            guard.last_selected = None;
            pool.return_priority(&dest_config, guard).await;
        } else if dest_transport == "graph" {
            if let Some(ref token) = dest_config.access_token {
                let client = GraphClient::new(token);
                match ensure_dest_folder_graph(&client, &dst_path, "/", &mut graph_folder_cache)
                    .await
                {
                    Ok(folder_id) => {
                        folder_mappings[folder_idx].dest_folder_id = Some(folder_id);
                    }
                    Err(e) => {
                        warn!(
                            "[migration] Failed to create Graph dest folder {}: {}",
                            dst_path, e
                        );
                        folder_mappings[folder_idx].status = "failed".to_string();
                        continue;
                    }
                }
            }
        }

        // Fetch destination Message-IDs for deduplication
        let dest_message_ids: HashSet<String> = if dest_transport == "imap" {
            let mut guard = pool.get_priority(&dest_config).await?;
            let ids = match fetch_dest_message_ids_imap(&mut guard.session, &dst_path).await {
                Ok(ids) => ids,
                Err(e) => {
                    warn!("[migration] Failed to fetch dest Message-IDs for {}: {}", dst_path, e);
                    HashSet::new()
                }
            };
            guard.last_selected = Some(dst_path.clone());
            pool.return_priority(&dest_config, guard).await;
            ids
        } else if dest_transport == "graph" {
            if let Some(ref dest_folder_id) = folder_mappings[folder_idx].dest_folder_id {
                if let Some(ref token) = dest_config.access_token {
                    let client = GraphClient::new(token);
                    match fetch_dest_message_ids_graph(&client, dest_folder_id).await {
                        Ok(ids) => ids,
                        Err(e) => {
                            warn!("[migration] Failed to fetch dest Graph Message-IDs for {}: {}", dst_path, e);
                            HashSet::new()
                        }
                    }
                } else {
                    HashSet::new()
                }
            } else {
                HashSet::new()
            }
        } else {
            HashSet::new()
        };

        if !dest_message_ids.is_empty() {
            info!("[migration] Found {} existing messages in dest '{}' for dedup", dest_message_ids.len(), dst_path);
        }

        // Fetch source UIDs / message IDs
        // Tuple: (uid_or_index, graph_msg_id, is_read, internet_message_id, sender, subject)
        let source_items: Vec<(u32, Option<String>, bool, Option<String>, String, String)>;

        if source_transport == "imap" {
            let mut guard = pool.get_priority(&source_config).await?;
            let uids = imap::search_all_uids(&mut guard.session, &src_path, false).await?;
            guard.last_selected = Some(src_path.clone());
            pool.return_priority(&source_config, guard).await;

            source_items = uids.into_iter().map(|uid| (uid, None, false, None, String::new(), String::new())).collect();
        } else {
            // Graph source — collect internetMessageId for dedup
            if let Some(ref token) = source_config.access_token {
                let client = GraphClient::new(token);
                let folders = client.list_folders().await?;
                let folder = folders
                    .iter()
                    .find(|f| f.display_name == src_path || f.display_name == normalize_graph_folder(&src_path))
                    .ok_or_else(|| format!("Graph folder '{}' not found", src_path))?;

                let mut items = Vec::new();
                let mut skip = 0u32;
                loop {
                    let (messages, next_link) =
                        client.list_messages(&folder.id, 100, skip).await?;
                    for (i, msg) in messages.iter().enumerate() {
                        let is_read = msg.is_read.unwrap_or(false);
                        let inet_msg_id = msg.internet_message_id.clone();
                        let sender = msg.from.as_ref()
                            .and_then(|f| f.email_address.address.clone())
                            .unwrap_or_else(|| "unknown".to_string());
                        let subject = msg.subject.clone().unwrap_or_default();
                        items.push(((skip + i as u32), Some(msg.id.clone()), is_read, inet_msg_id, sender, subject));
                    }
                    if next_link.is_none() || messages.is_empty() {
                        break;
                    }
                    skip += 100;
                }
                source_items = items;
            } else {
                source_items = Vec::new();
            }
        }

        let folder_total = source_items.len() as u32;
        folder_mappings[folder_idx].email_count = folder_total;
        let mut folder_migrated: u32 = 0;
        let mut folder_skipped: u32 = 0;
        let mut folder_failed: u32 = 0;

        // Process emails in batches of 50
        for batch in source_items.chunks(50) {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            for (uid, graph_id, is_read, src_inet_msg_id, item_sender, item_subject) in batch {
                let uid = *uid;
                let is_read = *is_read;
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                // Pause check — finish current email then stop
                while pause.load(Ordering::Relaxed) {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let _ = interruptible_sleep(std::time::Duration::from_millis(500), &cancel, &notify).await;
                }

                // Track sender/subject for log entries
                let mut email_sender = item_sender.clone();
                let mut email_subject = item_subject.clone();

                // Dedup check for Graph source (has internetMessageId already)
                if let Some(ref inet_id) = src_inet_msg_id {
                    if !dest_message_ids.is_empty() && dest_message_ids.contains(inet_id) {
                        folder_skipped += 1;
                        skipped_total += 1;
                        let log_entry = MigrationLogEntry {
                            timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                            sender: email_sender.clone(),
                            subject: email_subject.clone(),
                            status: "skipped".to_string(),
                        };
                        emit_progress(
                            "running", Some(src_path.clone()),
                            Some(format!("{}/{}", folder_migrated + folder_skipped + folder_failed, folder_total)),
                            migrated_total, skipped_total, failed_total,
                            &folder_mappings, &started_at, start_instant.elapsed().as_secs(),
                            &source_email, &dest_email, total_emails, &app_handle,
                            Some(log_entry), None,
                        );
                        continue;
                    }
                }

                let _permit = sem.acquire().await.unwrap();

                // For IMAP source: fetch MIME first to check dedup, then migrate
                // For Graph source: dedup already checked above via internetMessageId
                let migrate_result = match (source_transport.as_str(), dest_transport.as_str()) {
                    ("imap", "imap") => {
                        let mut src_guard = pool.get_priority(&source_config).await?;
                        let mut dst_guard = pool.get_priority(&dest_config).await?;

                        // Fetch MIME + flags for dedup check and migration
                        let fetch_result = {
                            use futures::StreamExt;
                            let _mbox = imap::select_mailbox(&mut src_guard.session, &src_path).await?;
                            let fetch_stream = src_guard.session
                                .uid_fetch(uid.to_string(), "(UID FLAGS BODY.PEEK[])")
                                .await
                                .map_err(|e| format!("UID FETCH {} failed: {}", uid, e))?;
                            let fetches: Vec<_> = fetch_stream
                                .collect::<Vec<_>>()
                                .await
                                .into_iter()
                                .filter_map(|r| r.ok())
                                .collect();
                            fetches.into_iter().next()
                                .ok_or_else(|| format!("Email UID {} not found", uid))
                        };

                        match fetch_result {
                            Ok(fetch) => {
                                // Extract sender/subject for log entry
                                if let Some(body) = fetch.body() {
                                    let (s, subj) = extract_sender_subject(body);
                                    email_sender = s;
                                    email_subject = subj;
                                }
                                // Dedup check via Message-ID extraction from MIME
                                if !dest_message_ids.is_empty() {
                                    if let Some(body) = fetch.body() {
                                        if let Some(msg_id) = extract_message_id(body) {
                                            if dest_message_ids.contains(&msg_id) {
                                                src_guard.last_selected = Some(src_path.clone());
                                                pool.return_priority(&source_config, src_guard).await;
                                                pool.return_priority(&dest_config, dst_guard).await;
                                                folder_skipped += 1;
                                                skipped_total += 1;
                                                // Emit progress and continue to next email
                                                let skip_log = MigrationLogEntry {
                                                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                                                    sender: email_sender.clone(),
                                                    subject: email_subject.clone(),
                                                    status: "skipped".to_string(),
                                                };
                                                emit_progress(
                                                    "running", Some(src_path.clone()),
                                                    Some(format!("{}/{}", folder_migrated + folder_skipped + folder_failed, folder_total)),
                                                    migrated_total, skipped_total, failed_total,
                                                    &folder_mappings, &started_at, start_instant.elapsed().as_secs(),
                                                    &source_email, &dest_email, total_emails, &app_handle,
                                                    Some(skip_log), None,
                                                );
                                                continue;
                                            }
                                        }
                                    }
                                }

                                // Not a duplicate — append to destination
                                let r = if let Some(mime_bytes) = fetch.body() {
                                    let flags: Vec<String> = fetch.flags()
                                        .filter_map(|f| {
                                            use async_imap::types::Flag;
                                            match f {
                                                Flag::Seen => Some("\\Seen".to_string()),
                                                Flag::Answered => Some("\\Answered".to_string()),
                                                Flag::Flagged => Some("\\Flagged".to_string()),
                                                Flag::Deleted => Some("\\Deleted".to_string()),
                                                Flag::Draft => Some("\\Draft".to_string()),
                                                Flag::Recent => None,
                                                _ => None,
                                            }
                                        })
                                        .collect();
                                    let flags_str = flags.join(" ");
                                    imap::append_email(&mut dst_guard.session, &dst_path, mime_bytes, &flags_str).await
                                } else {
                                    Err(format!("No body for UID {}", uid))
                                };
                                src_guard.last_selected = Some(src_path.clone());
                                dst_guard.last_selected = Some(dst_path.clone());
                                pool.return_priority(&source_config, src_guard).await;
                                pool.return_priority(&dest_config, dst_guard).await;
                                r.map(|_| true)
                            }
                            Err(e) => {
                                src_guard.last_selected = Some(src_path.clone());
                                pool.return_priority(&source_config, src_guard).await;
                                pool.return_priority(&dest_config, dst_guard).await;
                                Err(e)
                            }
                        }
                    }
                    ("graph", "imap") => {
                        // Dedup already checked above for Graph source
                        if let Some(ref gid) = graph_id {
                            let src_token = source_config
                                .access_token
                                .as_deref()
                                .ok_or("No source access token")?;
                            let client = GraphClient::new(src_token);
                            let mut dst_guard = pool.get_priority(&dest_config).await?;
                            let r = migrate_email_graph_to_imap(
                                &client,
                                &mut dst_guard.session,
                                gid,
                                &dst_path,
                                is_read,
                            )
                            .await;
                            dst_guard.last_selected = Some(dst_path.clone());
                            pool.return_priority(&dest_config, dst_guard).await;
                            r
                        } else {
                            Err("No Graph message ID".to_string())
                        }
                    }
                    ("imap", "graph") => {
                        let dest_folder_id = folder_mappings[folder_idx]
                            .dest_folder_id
                            .as_deref()
                            .ok_or("No destination Graph folder ID")?;
                        let dst_token = dest_config
                            .access_token
                            .as_deref()
                            .ok_or("No dest access token")?;
                        let client = GraphClient::new(dst_token);

                        // Fetch MIME from IMAP source
                        let mut src_guard = pool.get_priority(&source_config).await?;
                        let mime_result = fetch_raw_mime(&mut src_guard.session, &src_path, uid).await;
                        src_guard.last_selected = Some(src_path.clone());
                        pool.return_priority(&source_config, src_guard).await;

                        match mime_result {
                            Ok(mime_bytes) => {
                                // Extract sender/subject for log entry
                                let (s, subj) = extract_sender_subject(&mime_bytes);
                                email_sender = s;
                                email_subject = subj;
                                // Dedup check for IMAP source -> Graph dest
                                if !dest_message_ids.is_empty() {
                                    if let Some(msg_id) = extract_message_id(&mime_bytes) {
                                        if dest_message_ids.contains(&msg_id) {
                                            folder_skipped += 1;
                                            skipped_total += 1;
                                            let skip_log = MigrationLogEntry {
                                                timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                                                sender: email_sender.clone(),
                                                subject: email_subject.clone(),
                                                status: "skipped".to_string(),
                                            };
                                            emit_progress(
                                                "running", Some(src_path.clone()),
                                                Some(format!("{}/{}", folder_migrated + folder_skipped + folder_failed, folder_total)),
                                                migrated_total, skipped_total, failed_total,
                                                &folder_mappings, &started_at, start_instant.elapsed().as_secs(),
                                                &source_email, &dest_email, total_emails, &app_handle,
                                                Some(skip_log), None,
                                            );
                                            continue;
                                        }
                                    }
                                }

                                let mut retries = 0;
                                loop {
                                    match migrate_email_to_graph(
                                        &mime_bytes,
                                        &client,
                                        dest_folder_id,
                                        is_read,
                                    )
                                    .await
                                    {
                                        Ok(v) => break Ok(v),
                                        Err(e) if GraphClient::is_rate_limited(&e) && retries < 5 => {
                                            retries += 1;
                                            let wait_secs = parse_retry_after(&e).unwrap_or(retries as u64 * 5);
                                            let wait = std::time::Duration::from_secs(wait_secs);
                                            warn!("[migration] Rate limited, waiting {:?}", wait);
                                            let folder_progress_str = format!("{}/{}", folder_migrated + folder_skipped + folder_failed, folder_total);
                                            emit_progress("rate_limited", Some(src_path.clone()), Some(folder_progress_str), migrated_total, skipped_total, failed_total, &folder_mappings, &started_at, start_instant.elapsed().as_secs(), &source_email, &dest_email, total_emails, &app_handle, None, Some(wait_secs));
                                            let interrupted = interruptible_sleep(wait, &cancel, &notify).await;
                                            if interrupted {
                                                if cancel.load(Ordering::Relaxed) {
                                                    break Err("Cancelled during rate-limit wait".to_string());
                                                }
                                                if pause.load(Ordering::Relaxed) {
                                                    break Ok(true);
                                                }
                                            }
                                        }
                                        Err(e) => break Err(e),
                                    }
                                }
                            }
                            Err(e) => Err(e),
                        }
                    }
                    ("graph", "graph") => {
                        // Dedup already checked above for Graph source
                        if let Some(ref gid) = graph_id {
                            let src_token = source_config
                                .access_token
                                .as_deref()
                                .ok_or("No source access token")?;
                            let src_client = GraphClient::new(src_token);
                            let mime_bytes = src_client.get_mime_content(gid).await?;

                            let dest_folder_id = folder_mappings[folder_idx]
                                .dest_folder_id
                                .as_deref()
                                .ok_or("No destination Graph folder ID")?;
                            let dst_token = dest_config
                                .access_token
                                .as_deref()
                                .ok_or("No dest access token")?;
                            let dst_client = GraphClient::new(dst_token);

                            let mut retries = 0;
                            loop {
                                match migrate_email_to_graph(
                                    &mime_bytes,
                                    &dst_client,
                                    dest_folder_id,
                                    is_read,
                                )
                                .await
                                {
                                    Ok(v) => break Ok(v),
                                    Err(e) if GraphClient::is_rate_limited(&e) && retries < 5 => {
                                        retries += 1;
                                        let wait_secs = parse_retry_after(&e).unwrap_or(retries as u64 * 5);
                                        let wait = std::time::Duration::from_secs(wait_secs);
                                        warn!("[migration] Rate limited, waiting {:?}", wait);
                                        let folder_progress_str = format!("{}/{}", folder_migrated + folder_skipped + folder_failed, folder_total);
                                        emit_progress("rate_limited", Some(src_path.clone()), Some(folder_progress_str), migrated_total, skipped_total, failed_total, &folder_mappings, &started_at, start_instant.elapsed().as_secs(), &source_email, &dest_email, total_emails, &app_handle, None, Some(wait_secs));
                                        let interrupted = interruptible_sleep(wait, &cancel, &notify).await;
                                        if interrupted {
                                            if cancel.load(Ordering::Relaxed) {
                                                break Err("Cancelled during rate-limit wait".to_string());
                                            }
                                            if pause.load(Ordering::Relaxed) {
                                                break Ok(true);
                                            }
                                        }
                                    }
                                    Err(e) => break Err(e),
                                }
                            }
                        } else {
                            Err("No Graph message ID".to_string())
                        }
                    }
                    _ => Err(format!(
                        "Unsupported transport combination: {} -> {}",
                        source_transport, dest_transport
                    )),
                };

                // Determine log status from result
                let email_status;

                // Handle result with retry-once logic for failures
                match migrate_result {
                    Ok(_) => {
                        folder_migrated += 1;
                        migrated_total += 1;
                        email_status = "ok";
                    }
                    Err(ref first_err) => {
                        // Retry once after 2-second delay
                        warn!(
                            "[migration] Email UID {} failed (attempt 1): {}, retrying in 2s",
                            uid, first_err
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                        // Simple retry — re-run the same migration
                        let retry_result = match (source_transport.as_str(), dest_transport.as_str()) {
                            ("imap", "imap") => {
                                let mut sg = pool.get_priority(&source_config).await?;
                                let mut dg = pool.get_priority(&dest_config).await?;
                                let r = migrate_email_imap_to_imap(&mut sg.session, &mut dg.session, &src_path, &dst_path, uid).await;
                                sg.last_selected = Some(src_path.clone());
                                dg.last_selected = Some(dst_path.clone());
                                pool.return_priority(&source_config, sg).await;
                                pool.return_priority(&dest_config, dg).await;
                                r
                            }
                            ("graph", "imap") => {
                                if let Some(ref gid) = graph_id {
                                    let t = source_config.access_token.as_deref().ok_or("No source access token")?;
                                    let c = GraphClient::new(t);
                                    let mut dg = pool.get_priority(&dest_config).await?;
                                    let r = migrate_email_graph_to_imap(&c, &mut dg.session, gid, &dst_path, is_read).await;
                                    dg.last_selected = Some(dst_path.clone());
                                    pool.return_priority(&dest_config, dg).await;
                                    r
                                } else { Err("No Graph message ID".to_string()) }
                            }
                            ("imap", "graph") => {
                                let dfid = folder_mappings[folder_idx].dest_folder_id.as_deref().ok_or("No destination Graph folder ID")?;
                                let t = dest_config.access_token.as_deref().ok_or("No dest access token")?;
                                let c = GraphClient::new(t);
                                let mut sg = pool.get_priority(&source_config).await?;
                                let mr = fetch_raw_mime(&mut sg.session, &src_path, uid).await;
                                sg.last_selected = Some(src_path.clone());
                                pool.return_priority(&source_config, sg).await;
                                match mr {
                                    Ok(mb) => migrate_email_to_graph(&mb, &c, dfid, is_read).await,
                                    Err(e) => Err(e),
                                }
                            }
                            ("graph", "graph") => {
                                if let Some(ref gid) = graph_id {
                                    let st = source_config.access_token.as_deref().ok_or("No source access token")?;
                                    let sc = GraphClient::new(st);
                                    let mb = sc.get_mime_content(gid).await?;
                                    let dfid = folder_mappings[folder_idx].dest_folder_id.as_deref().ok_or("No destination Graph folder ID")?;
                                    let dt = dest_config.access_token.as_deref().ok_or("No dest access token")?;
                                    let dc = GraphClient::new(dt);
                                    migrate_email_to_graph(&mb, &dc, dfid, is_read).await
                                } else { Err("No Graph message ID".to_string()) }
                            }
                            _ => Err("Unsupported transport".to_string()),
                        };

                        match retry_result {
                            Ok(_) => {
                                folder_migrated += 1;
                                migrated_total += 1;
                                email_status = "ok";
                                info!("[migration] Email UID {} succeeded on retry", uid);
                            }
                            Err(e) => {
                                warn!("migration: email UID {} failed twice, skipping: {}", uid, e);
                                folder_failed += 1;
                                failed_total += 1;
                                email_status = "failed";
                                folder_mappings[folder_idx].failed_uids.push(uid);
                            }
                        }
                    }
                }

                let log_entry = MigrationLogEntry {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    sender: email_sender.clone(),
                    subject: email_subject.clone(),
                    status: email_status.to_string(),
                };
                emit_progress(
                    "running",
                    Some(src_path.clone()),
                    Some(format!("{}/{}", folder_migrated + folder_skipped + folder_failed, folder_total)),
                    migrated_total,
                    skipped_total,
                    failed_total,
                    &folder_mappings,
                    &started_at,
                    start_instant.elapsed().as_secs(),
                    &source_email,
                    &dest_email,
                    total_emails,
                    &app_handle,
                    Some(log_entry),
                    None,
                );
            }
        }

        // Update folder mapping
        folder_mappings[folder_idx].migrated = folder_migrated;
        folder_mappings[folder_idx].skipped = folder_skipped;
        folder_mappings[folder_idx].failed = folder_failed;
        folder_mappings[folder_idx].status = if cancel.load(Ordering::Relaxed) {
            "cancelled".to_string()
        } else if folder_failed > 0 && folder_migrated == 0 {
            "failed".to_string()
        } else {
            "completed".to_string()
        };

        // Save checkpoint after each folder
        let checkpoint_state = MigrationState {
            id: migration_id.clone(),
            source_email: source_email.clone(),
            dest_email: dest_email.clone(),
            source_transport: source_transport.clone(),
            dest_transport: dest_transport.clone(),
            source_account_json: source_account_json.clone(),
            dest_account_json: dest_account_json.clone(),
            status: "running".to_string(),
            folder_mappings: folder_mappings.clone(),
            total_emails,
            migrated_emails: migrated_total,
            skipped_emails: skipped_total,
            failed_emails: failed_total,
            started_at: started_at.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let _ = save_migration_state(&app_handle, &checkpoint_state);
        info!("migration: folder '{}' completed, saved checkpoint", src_path);
    }

    let final_status = if cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else if failed_total > 0 && migrated_total == 0 {
        "failed"
    } else {
        "completed"
    };

    let final_state = MigrationState {
        id: migration_id,
        source_email: source_email.clone(),
        dest_email: dest_email.clone(),
        source_transport: source_transport.clone(),
        dest_transport: dest_transport.clone(),
        source_account_json,
        dest_account_json,
        status: final_status.to_string(),
        folder_mappings: folder_mappings.clone(),
        total_emails,
        migrated_emails: migrated_total,
        skipped_emails: skipped_total,
        failed_emails: failed_total,
        started_at: started_at.clone(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    // Cancel discards persistent state; completed/failed saves final state
    if final_status == "cancelled" {
        let _ = clear_migration_state(&app_handle);
        info!("[migration] Cancelled — persistent state cleared");
    } else {
        let _ = save_migration_state(&app_handle, &final_state);
    }

    emit_progress(
        final_status,
        None,
        None,
        migrated_total,
        skipped_total,
        failed_total,
        &folder_mappings,
        &started_at,
        start_instant.elapsed().as_secs(),
        &source_email,
        &dest_email,
        total_emails,
        &app_handle,
        None,
        None,
    );

    info!(
        "[migration] {} — migrated: {}, skipped: {}, failed: {}",
        final_status, migrated_total, skipped_total, failed_total
    );

    Ok(final_state)
}

// ── Helper: fetch raw MIME from IMAP ────────────────────────────────────────

async fn fetch_raw_mime(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    use futures::StreamExt;

    let _mbox = imap::select_mailbox(session, mailbox).await?;

    let fetch_stream = session
        .uid_fetch(uid.to_string(), "BODY.PEEK[]")
        .await
        .map_err(|e| format!("UID FETCH {} BODY.PEEK[] failed: {}", uid, e))?;

    let fetches: Vec<_> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Email UID {} not found", uid))?;

    fetch
        .body()
        .map(|b| b.to_vec())
        .ok_or_else(|| format!("No body for UID {}", uid))
}

// ── Graph folder name normalization ─────────────────────────────────────────

/// Convert IMAP-style folder names to Graph display names.
fn normalize_graph_folder(imap_name: &str) -> String {
    match imap_name.to_lowercase().as_str() {
        "inbox" => "Inbox".to_string(),
        "sent" | "sent items" | "sent messages" => "Sent Items".to_string(),
        "trash" | "deleted" | "deleted items" => "Deleted Items".to_string(),
        "drafts" | "draft" => "Drafts".to_string(),
        "junk" | "spam" | "junk email" => "Junk Email".to_string(),
        "archive" => "Archive".to_string(),
        _ => imap_name.to_string(),
    }
}

// ── Background folder counting ───────────────────────────────────────────────

/// Count emails per folder in background, emitting incremental count events.
pub async fn count_migration_folders(
    app_handle: tauri::AppHandle,
    source_config: ImapConfig,
    source_transport: String,
    folder_mappings: Vec<FolderMapping>,
) -> Result<(), String> {
    for mapping in &folder_mappings {
        if source_transport == "imap" {
            let pool = app_handle.state::<ImapPool>();
            let mut guard = pool.get_priority(&source_config).await?;
            let uids = imap::search_all_uids(&mut guard.session, &mapping.source_path, false).await?;
            guard.last_selected = Some(mapping.source_path.clone());
            pool.return_priority(&source_config, guard).await;
            let count = uids.len() as u32;
            let _ = app_handle.emit("migration-folder-count", serde_json::json!({
                "folder_path": mapping.source_path,
                "count": count,
                "counting": false,
            }));
        } else {
            // Graph source -- paginated counting
            if let Some(ref token) = source_config.access_token {
                let client = GraphClient::new(token);
                let folders = client.list_folders().await?;
                let folder = folders.iter()
                    .find(|f| f.display_name == mapping.source_path || f.display_name == normalize_graph_folder(&mapping.source_path));
                if let Some(folder) = folder {
                    let mut total = 0u32;
                    let mut skip = 0u32;
                    loop {
                        let (messages, next_link) = client.list_messages(&folder.id, 100, skip).await?;
                        total += messages.len() as u32;
                        let _ = app_handle.emit("migration-folder-count", serde_json::json!({
                            "folder_path": mapping.source_path,
                            "count": total,
                            "counting": next_link.is_some() && !messages.is_empty(),
                        }));
                        if next_link.is_none() || messages.is_empty() {
                            break;
                        }
                        skip += 100;
                    }
                } else {
                    let _ = app_handle.emit("migration-folder-count", serde_json::json!({
                        "folder_path": mapping.source_path,
                        "count": 0,
                        "counting": false,
                    }));
                }
            }
        }
    }
    Ok(())
}

// ── State persistence ───────────────────────────────────────────────────────

pub fn save_migration_state(
    app_handle: &tauri::AppHandle,
    state: &MigrationState,
) -> Result<(), String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let path = data_dir.join("migration_state.json");

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize migration state: {}", e))?;

    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write migration state: {}", e))?;

    Ok(())
}

pub fn load_migration_state(
    app_handle: &tauri::AppHandle,
) -> Result<Option<MigrationState>, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let path = data_dir.join("migration_state.json");

    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read migration state: {}", e))?;
    let state: MigrationState = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse migration state: {}", e))?;

    Ok(Some(state))
}

pub fn clear_migration_state(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let path = data_dir.join("migration_state.json");

    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete migration state: {}", e))?;
    }

    Ok(())
}
