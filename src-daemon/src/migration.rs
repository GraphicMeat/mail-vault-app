use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::graph::GraphClient;
use crate::imap::pool::PooledSessionGuard;
use crate::imap::{self, ImapConfig, ImapSession, MailboxInfo};
use crate::jmap_sessions::{AccountJmap, Mailboxes};
use crate::server::DaemonState;
use mailvault_core::jmap::client::received_at_of;
use mailvault_core::jmap::headers::{flags_to_keywords, keywords_to_flags};
use mailvault_core::jmap::mailbox_map::DELIMITER;
use mailvault_core::jmap::{ImportResult, JmapError};
use mailvault_core::maildir::{message_id_key, message_id_value_key};
use serde_json::{json, Value};

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

// Cancel/pause/notify tokens: `handlers::common::RunGuard`, registered under
// kind "migration" (decision 7). The single-slot `MigrationCancelToken`/
// `MigrationPauseToken`/`MigrationNotify` this file used to define here are
// gone, a second concurrent migration used to silently replace their shared
// `Arc`, orphaning the first run uncancellably (inventory N4's sibling bug).

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
                // No matching special-use on dest, use same path with delimiter conversion
                dest_path = src.path.replace(src_delim, dst_delim);
            }
        } else {
            // Custom folder, mirror path with delimiter conversion
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

/// Fetch all Message-IDs from an IMAP mailbox for deduplication, bracketed
/// (`message_id_key`).
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

    Ok(fetches.iter().filter_map(|f| f.header()).filter_map(message_id_key).collect())
}

// ── Message-ID extraction from raw MIME ──────────────────────────────────────

/// Extract the Message-ID from raw MIME bytes (searches first 8KB of headers).
/// Returns the Message-ID value including angle brackets, e.g. `<abc@example.com>`.
pub fn extract_message_id(mime_bytes: &[u8]) -> Option<String> {
    // Only search the first 8KB, headers are always at the top
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

/// Migrate a single email to a Graph destination (from raw MIME).
/// Creates a draft from MIME, moves it to the target folder, sets read status.
/// Returns the message's id in the destination folder.
pub async fn migrate_email_to_graph(
    source_mime: &[u8],
    client: &GraphClient,
    dest_folder_id: &str,
    is_read: bool,
) -> Result<String, String> {
    // Create message from MIME (lands in Drafts)
    let draft_id = client.create_message_from_mime(source_mime).await?;

    // Move to destination folder
    let final_id = client.move_message(&draft_id, dest_folder_id).await?;

    // Set read status
    if is_read {
        client.set_read_status(&final_id, true).await?;
    }

    Ok(final_id)
}

// ── JMAP (either side) ──────────────────────────────────────────────────────

/// The transport a migration side really speaks: a JMAP account is "jmap"
/// whatever the app sent (its `getTransport` knows only "graph" and "imap"),
/// so no IMAP path ever dials it with the JMAP credentials.
pub fn effective_transport(config: &ImapConfig, transport: &str) -> String {
    if config.uses_jmap() {
        "jmap".to_string()
    } else {
        transport.to_string()
    }
}

/// Ensure a JMAP destination mailbox exists at `folder_path` (a path as
/// `mailbox_tree` gives it: "INBOX", "Work/Sub"), creating each missing
/// level with `Mailbox/set` under its parent, subscribed. A U+2215 in a
/// segment stands for a "/" inside that name (`mailbox_map`). Returns the
/// mailbox id.
pub async fn ensure_dest_folder_jmap(acct: &AccountJmap, folder_path: &str) -> Result<String, JmapError> {
    let boxes = acct.current().await?;
    ensure_dest_folder_in(acct, folder_path, boxes).await
}

/// `ensure_dest_folder_jmap` over a mailbox list the caller read (possibly
/// stale). A create the server refuses (`notCreated`: a concurrent restore
/// folder or another client made the same level first, so the sibling name is
/// taken) re-reads the list and carries on with the id found there; only a
/// level that is still missing after the refresh fails.
async fn ensure_dest_folder_in(acct: &AccountJmap, folder_path: &str, mut boxes: Mailboxes) -> Result<String, JmapError> {
    if let Some(id) = boxes.ids.get(folder_path) {
        return Ok(id.clone());
    }
    let mut parent: Option<String> = None;
    let mut path = String::new();
    for part in folder_path.split(DELIMITER) {
        if !path.is_empty() {
            path.push_str(DELIMITER);
        }
        path.push_str(part);
        if let Some(id) = boxes.ids.get(&path) {
            parent = Some(id.clone());
            continue;
        }
        let name = part.replace('\u{2215}', "/");
        if name.trim().is_empty() {
            return Err(JmapError::Protocol(format!("no folder name in {folder_path}")));
        }
        let r = acct
            .client
            .mailbox_set(json!({"create": {"f": {"name": name, "parentId": parent, "isSubscribed": true}}}))
            .await?;
        let Some(id) = r["created"]["f"]["id"].as_str() else {
            let e = &r["notCreated"]["f"];
            boxes = acct.refresh().await?;
            if let Some(id) = boxes.ids.get(&path) {
                parent = Some(id.clone());
                continue;
            }
            return Err(JmapError::Method {
                kind: e["type"].as_str().unwrap_or("serverFail").to_string(),
                description: Some(format!("{path}: {}", e["description"].as_str().unwrap_or("not created"))),
            });
        };
        info!("[migration] Created JMAP mailbox: {}", path);
        parent = Some(id.to_string());
    }
    if let Err(e) = acct.refresh().await {
        warn!("[migration] JMAP mailbox list not refreshed after a create: {}", e);
    }
    parent.ok_or_else(|| JmapError::Protocol("Empty folder path".into()))
}

/// Every Message-ID in a JMAP mailbox, bracketed as `extract_message_id`
/// gives them, for the run's dedupe.
pub async fn fetch_dest_message_ids_jmap(acct: &AccountJmap, mailbox_id: &str) -> Result<HashSet<String>, JmapError> {
    let ids = acct.client.all_email_ids(mailbox_id).await?;
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let got = acct.client.get_emails(&ids, &["id", "messageId"]).await?;
    Ok(got
        .list
        .iter()
        .flat_map(|e| e["messageId"].as_array().cloned().unwrap_or_default())
        .filter_map(|m| m.as_str().and_then(message_id_value_key))
        .collect())
}

/// A JMAP source mailbox as the run's source items, oldest first: the list
/// index, the email id, its read state, its bracketed Message-ID (the dedupe
/// the Graph source gets), sender and subject.
async fn jmap_source_items(state: &Arc<DaemonState>, config: &ImapConfig, mailbox: &str) -> Result<Vec<SourceItem>, String> {
    let acct = state.jmap.get(config).await.map_err(|e| e.to_string())?;
    let mailbox_id = acct.mailbox_id(mailbox).await.map_err(|e| e.to_string())?;
    let mut ids = acct.client.all_email_ids(&mailbox_id).await.map_err(|e| e.to_string())?;
    ids.reverse();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let got = acct
        .client
        .get_emails(&ids, &["id", "keywords", "messageId", "from", "subject"])
        .await
        .map_err(|e| e.to_string())?;
    let by_id: HashMap<String, Value> =
        got.list.into_iter().filter_map(|e| e["id"].as_str().map(str::to_string).map(|id| (id, e))).collect();
    Ok(ids
        .iter()
        .filter_map(|id| by_id.get(id).map(|e| (id, e)))
        .enumerate()
        .map(|(i, (id, e))| SourceItem {
            key: i as u32,
            remote_id: Some(id.clone()),
            is_read: keywords_to_flags(&e["keywords"]).iter().any(|f| f == "\\Seen"),
            message_id: e["messageId"][0].as_str().and_then(message_id_value_key),
            sender: e["from"][0]["email"].as_str().unwrap_or("unknown").to_string(),
            subject: e["subject"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

/// One IMAP message for a migration: its bytes, its flags (system flags
/// spelled `\Seen` and the like, keywords verbatim) and its INTERNALDATE. A
/// failed fetch never goes back to the pool: it can leave unread bytes on the
/// session.
async fn fetch_imap_message(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    lane: Lane,
    mailbox: &str,
    uid: u32,
) -> Result<(Vec<u8>, Vec<String>, Option<chrono::DateTime<chrono::FixedOffset>>), String> {
    use futures::StreamExt;
    let mut guard = checkout(state, config, lane).await?;
    let fetched = async {
        imap::select_mailbox(&mut guard.session, mailbox).await?;
        let stream = guard
            .session
            .uid_fetch(uid.to_string(), "(UID FLAGS INTERNALDATE BODY.PEEK[])")
            .await
            .map_err(|e| format!("UID FETCH {} failed: {}", uid, e))?;
        let fetches: Vec<_> = stream.collect::<Vec<_>>().await.into_iter().filter_map(|r| r.ok()).collect();
        let fetch = fetches.first().ok_or_else(|| format!("Email UID {} not found", uid))?;
        let raw = fetch.body().ok_or_else(|| format!("No body for UID {}", uid))?.to_vec();
        let flags: Vec<String> = fetch
            .flags()
            .filter_map(|f| {
                use crate::imap::async_imap::types::Flag;
                match f {
                    Flag::Seen => Some("\\Seen".to_string()),
                    Flag::Answered => Some("\\Answered".to_string()),
                    Flag::Flagged => Some("\\Flagged".to_string()),
                    Flag::Draft => Some("\\Draft".to_string()),
                    Flag::Custom(k) => Some(k.to_string()),
                    _ => None,
                }
            })
            .collect();
        Ok::<_, String>((raw, flags, fetch.internal_date()))
    }
    .await;
    match &fetched {
        Ok(_) => {
            guard.last_selected = Some(mailbox.to_string());
            checkin(state, config, lane, guard).await;
        }
        Err(_) => state.imap_pool.discard(config, guard).await,
    }
    fetched
}

/// One JMAP message for a migration: its blob, its keywords as IMAP flags
/// and its `receivedAt`.
async fn fetch_jmap_message(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    email_id: &str,
) -> Result<(Vec<u8>, Vec<String>, Option<chrono::DateTime<chrono::FixedOffset>>), JmapError> {
    let acct = state.jmap.get(config).await?;
    let got = acct.client.get_emails(&[email_id.to_string()], &["id", "blobId", "keywords", "receivedAt"]).await?;
    let email = got
        .list
        .into_iter()
        .find(|e| e["id"].as_str() == Some(email_id))
        .ok_or_else(|| JmapError::Protocol(format!("email {email_id} is gone")))?;
    let blob_id = email["blobId"].as_str().ok_or_else(|| JmapError::Protocol(format!("email {email_id} has no blobId")))?;
    let raw = acct.client.download(blob_id).await?;
    let date = email["receivedAt"].as_str().and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok());
    Ok((raw, keywords_to_flags(&email["keywords"]), date))
}

// ── Copy engine ─────────────────────────────────────────────────────────────

/// Which pool lane a copy's IMAP sessions come from: a migration the user
/// watches takes the priority lane, a background job the background one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    Priority,
    Background,
}

async fn checkout(state: &Arc<DaemonState>, config: &ImapConfig, lane: Lane) -> Result<PooledSessionGuard, String> {
    match lane {
        Lane::Priority => state.imap_pool.get_priority(config).await,
        Lane::Background => state.imap_pool.get_background(config).await,
    }
}

async fn checkin(state: &Arc<DaemonState>, config: &ImapConfig, lane: Lane, guard: PooledSessionGuard) {
    match lane {
        Lane::Priority => state.imap_pool.return_priority(config, guard).await,
        Lane::Background => state.imap_pool.return_background(config, guard).await,
    }
}

/// One account of a copy: its config, the transport it really speaks
/// (`effective_transport`) and its address.
pub(crate) struct Side {
    pub config: ImapConfig,
    pub transport: String,
    pub email: String,
}

impl Side {
    pub(crate) fn new(config: ImapConfig, transport: &str) -> Self {
        let transport = effective_transport(&config, transport);
        let email = config.email.clone();
        Side { config, transport, email }
    }

    fn graph(&self) -> Result<GraphClient, String> {
        let token = self.config.access_token.as_deref().ok_or_else(|| format!("No access token for {}", self.email))?;
        Ok(GraphClient::new(token).for_account(&self.email))
    }
}

/// One source message as the folder listing gives it. `key` is the IMAP uid,
/// or the message's index in a JMAP or Graph listing (its id is `remote_id`).
/// `message_id` is bracketed (`message_id_value_key`) when the listing has it,
/// so a message the destination holds is skipped before it is downloaded.
#[derive(Clone, Debug, Default)]
pub(crate) struct SourceItem {
    pub key: u32,
    pub remote_id: Option<String>,
    pub is_read: bool,
    pub message_id: Option<String>,
    pub sender: String,
    pub subject: String,
}

/// What the destination said about a write: the uid (APPENDUID) or id it
/// gave the message, or nothing (an IMAP server without UIDPLUS).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WriteAck {
    Uid(u32),
    Id(String),
    Unconfirmed,
}

/// What `copy_one` did with a message. `fingerprint` is
/// `folder_move::fingerprint` of the bytes (0 when skipped unread).
#[derive(Clone, Debug)]
pub(crate) enum CopyOutcome {
    Written { ack: WriteAck, message_id: Option<String>, fingerprint: u64, sender: String, subject: String },
    /// The destination already held it: nothing written.
    Present { message_id: Option<String>, fingerprint: u64, sender: String, subject: String },
}

/// What a copy runs with. `cancel`/`pause`/`notify` are the run's tokens.
pub(crate) struct CopyCtx<'a> {
    pub state: &'a Arc<DaemonState>,
    pub source: &'a Side,
    pub dest: &'a Side,
    pub lane: Lane,
    pub cancel: &'a AtomicBool,
    pub pause: &'a AtomicBool,
    pub notify: &'a tokio::sync::Notify,
    /// Graph destination folder path -> id, filled as folders are made.
    pub graph_folder_cache: HashMap<String, String>,
    /// Fingerprints of Message-ID-less mail a resumed job already copied:
    /// present, never written twice.
    pub seen_fingerprints: Option<&'a HashSet<u64>>,
}

/// A run's message counts across its folders.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Totals {
    pub total: u32,
    pub migrated: u32,
    pub skipped: u32,
    pub failed: u32,
}

/// One folder of a copy. `started`: the destination folder was there and the
/// source listed, so the folder's counts and status mean something.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FolderOutcome {
    pub migrated: u32,
    pub skipped: u32,
    pub failed: u32,
    pub bandwidth_hit: bool,
    pub cancelled: bool,
    pub started: bool,
}

impl FolderOutcome {
    fn progress(&self, total: u32) -> String {
        format!("{}/{}", self.migrated + self.skipped + self.failed, total)
    }
}

/// One moment of a copy, for the sink to report.
pub(crate) struct ProgressTick<'a> {
    /// "running", "paused", "rate_limited", or the run's final status.
    pub status: &'a str,
    pub folder: Option<&'a str>,
    /// "done/total" within the folder.
    pub folder_progress: Option<String>,
    pub folders: &'a [FolderMapping],
    pub totals: &'a Totals,
    /// The message just handled: sender, subject and "ok", "skipped" or "failed".
    pub log: Option<(&'a str, &'a str, &'a str)>,
    pub rate_limited_for: Option<u64>,
}

/// Where a copy reports to: the migration's event and state file, or a
/// folder move's.
pub(crate) trait CopySink: Send {
    fn progress(&mut self, tick: ProgressTick<'_>);
    fn checkpoint(&mut self, status: &str, folders: &[FolderMapping], totals: &Totals);
}

/// Make `m`'s destination folder, recording its JMAP or Graph id.
pub(crate) async fn ensure_dest_folder(ctx: &mut CopyCtx<'_>, m: &mut FolderMapping) -> Result<(), String> {
    let dest = ctx.dest;
    match dest.transport.as_str() {
        "imap" => {
            let mut guard = checkout(ctx.state, &dest.config, ctx.lane).await?;
            let made = ensure_dest_folder_imap(&mut guard.session, &m.dest_path).await;
            guard.last_selected = None;
            checkin(ctx.state, &dest.config, ctx.lane, guard).await;
            made
        }
        "jmap" => {
            let acct = ctx.state.jmap.get(&dest.config).await.map_err(|e| e.to_string())?;
            m.dest_folder_id = Some(ensure_dest_folder_jmap(&acct, &m.dest_path).await.map_err(|e| e.to_string())?);
            Ok(())
        }
        "graph" if dest.config.access_token.is_some() => {
            let client = dest.graph()?;
            m.dest_folder_id = Some(ensure_dest_folder_graph(&client, &m.dest_path, "/", &mut ctx.graph_folder_cache).await?);
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Every Message-ID the destination folder holds, bracketed
/// (`message_id_value_key`). A failed listing is an error, never an empty set.
pub(crate) async fn fetch_dest_ids(ctx: &CopyCtx<'_>, m: &FolderMapping) -> Result<HashSet<String>, String> {
    let dest = ctx.dest;
    let ids = match (dest.transport.as_str(), m.dest_folder_id.as_deref()) {
        ("imap", _) => {
            let mut guard = checkout(ctx.state, &dest.config, ctx.lane).await?;
            let listed = fetch_dest_message_ids_imap(&mut guard.session, &m.dest_path).await;
            match &listed {
                Ok(_) => {
                    guard.last_selected = Some(m.dest_path.clone());
                    checkin(ctx.state, &dest.config, ctx.lane, guard).await;
                }
                Err(_) => ctx.state.imap_pool.discard(&dest.config, guard).await,
            }
            listed?
        }
        ("graph", Some(id)) if dest.config.access_token.is_some() => {
            dest.graph()?.list_internet_message_ids(id).await?.into_iter().collect()
        }
        ("jmap", Some(id)) => {
            let acct = ctx.state.jmap.get(&dest.config).await.map_err(|e| e.to_string())?;
            fetch_dest_message_ids_jmap(&acct, id).await.map_err(|e| e.to_string())?
        }
        _ => HashSet::new(),
    };
    Ok(ids.iter().filter_map(|id| message_id_value_key(id)).collect())
}

/// The source folder's messages, oldest first. A Graph folder is addressed by
/// `src_folder_id` when the caller has it, else looked up by display name.
pub(crate) async fn list_source_items(ctx: &CopyCtx<'_>, src_path: &str, src_folder_id: Option<&str>) -> Result<Vec<SourceItem>, String> {
    let source = ctx.source;
    match source.transport.as_str() {
        "imap" => {
            let mut guard = checkout(ctx.state, &source.config, ctx.lane).await?;
            let uids = imap::search_all_uids(&mut guard.session, src_path, false).await;
            match &uids {
                Ok(_) => {
                    guard.last_selected = Some(src_path.to_string());
                    checkin(ctx.state, &source.config, ctx.lane, guard).await;
                }
                Err(_) => ctx.state.imap_pool.discard(&source.config, guard).await,
            }
            Ok(uids?.into_iter().map(|uid| SourceItem { key: uid, ..Default::default() }).collect())
        }
        "jmap" => jmap_source_items(ctx.state, &source.config, src_path).await,
        _ if source.config.access_token.is_none() => Ok(Vec::new()),
        _ => {
            let client = source.graph()?;
            let folder_id = match src_folder_id {
                Some(id) => id.to_string(),
                None => client
                    .list_folders()
                    .await?
                    .into_iter()
                    .find(|f| f.display_name == src_path || f.display_name == normalize_graph_folder(src_path))
                    .map(|f| f.id)
                    .ok_or_else(|| format!("Graph folder '{}' not found", src_path))?,
            };
            // Page by the link Graph gives: a `$skip` count drifts when mail
            // arrives or goes between pages.
            let mut items = Vec::new();
            let (mut messages, mut next_link) = client.list_messages(&folder_id, 100, 0).await?;
            loop {
                for msg in &messages {
                    items.push(SourceItem {
                        key: items.len() as u32,
                        remote_id: Some(msg.id.clone()),
                        is_read: msg.is_read.unwrap_or(false),
                        message_id: msg.internet_message_id.as_deref().and_then(message_id_value_key),
                        sender: msg.from.as_ref().and_then(|f| f.email_address.address.clone()).unwrap_or_else(|| "unknown".to_string()),
                        subject: msg.subject.clone().unwrap_or_default(),
                    });
                }
                match next_link {
                    Some(next) if !messages.is_empty() => (messages, next_link) = client.list_messages_next(&next).await?,
                    _ => break,
                }
            }
            Ok(items)
        }
    }
}

/// One message, any source to any destination. The source gives the raw
/// message, its flags and its date (IMAP `UID FETCH`, a JMAP blob with its
/// keywords and `receivedAt`, Graph MIME with its read state); a Message-ID
/// `dest_ids` holds (or, without one, a fingerprint `seen_fingerprints`
/// holds) is `Present` before anything is written; else the destination
/// writes it: IMAP APPEND with the flags and date, JMAP `import_raw` with the
/// flags as keywords and the date as `receivedAt` (it asks the server about
/// the Message-ID again, and the sync never announces what it imports),
/// Graph draft-and-move with the read state. A session whose command failed
/// is dropped, never pooled again. `read` gets the sender and subject once
/// the source's bytes are in, for a log line of a write that then failed.
pub(crate) async fn copy_one(
    ctx: &CopyCtx<'_>,
    src_path: &str,
    dst_path: &str,
    dest_folder_id: Option<&str>,
    item: &SourceItem,
    dest_ids: &HashSet<String>,
    read: &mut Option<(String, String)>,
) -> Result<CopyOutcome, String> {
    if let Some(id) = item.message_id.as_ref().filter(|id| dest_ids.contains(*id)) {
        return Ok(CopyOutcome::Present { message_id: Some(id.clone()), fingerprint: 0, sender: item.sender.clone(), subject: item.subject.clone() });
    }
    let (state, source, dest) = (ctx.state, ctx.source, ctx.dest);
    let (raw, flags, date) = match source.transport.as_str() {
        "imap" => fetch_imap_message(state, &source.config, ctx.lane, src_path, item.key).await?,
        "jmap" => {
            let id = item.remote_id.as_deref().ok_or("No JMAP email id")?;
            fetch_jmap_message(state, &source.config, id).await.map_err(|e| e.to_string())?
        }
        "graph" => {
            let gid = item.remote_id.as_deref().ok_or("No Graph message ID")?;
            let raw = source.graph()?.get_mime_content(gid).await?;
            (raw, if item.is_read { vec!["\\Seen".to_string()] } else { Vec::new() }, None)
        }
        other => return Err(format!("Unsupported transport combination: {} -> {}", other, dest.transport)),
    };
    let (sender, subject) = extract_sender_subject(&raw);
    *read = Some((sender.clone(), subject.clone()));
    let message_id = extract_message_id(&raw).and_then(|v| message_id_value_key(&v));
    let fingerprint = mailvault_core::folder_move::fingerprint(&raw);
    let present = match &message_id {
        Some(id) => dest_ids.contains(id),
        None => ctx.seen_fingerprints.is_some_and(|seen| seen.contains(&fingerprint)),
    };
    if present {
        return Ok(CopyOutcome::Present { message_id, fingerprint, sender, subject });
    }
    let ack = match dest.transport.as_str() {
        "jmap" => {
            let mailbox_id = dest_folder_id.ok_or("No destination JMAP mailbox id")?;
            let keywords = flags_to_keywords(flags.iter().map(String::as_str));
            let received_at = date
                .map(|d| d.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
                .or_else(|| received_at_of(&raw));
            let imported = state
                .jmap
                .import_raw(&dest.config, &raw, mailbox_id, &keywords, received_at.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            match imported {
                ImportResult::Created(made) => WriteAck::Id(made.id),
                // Present on the server, maybe only in another mailbox: that
                // copy gets the destination mailbox's label.
                ImportResult::AlreadyExists { existing_id } => {
                    let acct = state.jmap.get(&dest.config).await.map_err(|e| e.to_string())?;
                    crate::handlers::jmap_bridge::adopt_deduped(&acct, &existing_id, mailbox_id, dst_path).await?;
                    return Ok(CopyOutcome::Present { message_id, fingerprint, sender, subject });
                }
            }
        }
        "imap" => {
            let internal_date = date.map(|d| imap::imap_date_time(&d)).or_else(|| imap::internal_date_from_raw(&raw));
            let mut guard = checkout(state, &dest.config, ctx.lane).await?;
            let appended = imap::append_email(&mut guard.session, dst_path, &raw, &flags.join(" "), internal_date.as_deref()).await;
            match &appended {
                Ok(_) => {
                    guard.last_selected = Some(dst_path.to_string());
                    checkin(state, &dest.config, ctx.lane, guard).await;
                }
                Err(_) => state.imap_pool.discard(&dest.config, guard).await,
            }
            match appended? {
                Some((_, uid)) => WriteAck::Uid(uid),
                None => WriteAck::Unconfirmed,
            }
        }
        "graph" => {
            let folder_id = dest_folder_id.ok_or("No destination Graph folder ID")?;
            let is_read = flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen"));
            WriteAck::Id(migrate_email_to_graph(&raw, &dest.graph()?, folder_id, is_read).await?)
        }
        other => return Err(format!("Unsupported transport combination: {} -> {}", source.transport, other)),
    };
    Ok(CopyOutcome::Written { ack, message_id, fingerprint, sender, subject })
}

/// `copy_one` with the engine's retries. A Graph 429 waits as Graph asks (up
/// to five times; `on_rate_limit` hears each wait in seconds), and a cancel
/// ends the wait; any other failure is tried once more after 2s, except a
/// provider bandwidth limit, which comes back at once.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn copy_with_retries(
    ctx: &CopyCtx<'_>,
    src_path: &str,
    dst_path: &str,
    dest_folder_id: Option<&str>,
    item: &SourceItem,
    dest_ids: &HashSet<String>,
    read: &mut Option<(String, String)>,
    on_rate_limit: &mut (dyn FnMut(u64) + Send),
) -> Result<CopyOutcome, String> {
    let (mut rate_retries, mut retried) = (0u32, false);
    loop {
        match copy_one(ctx, src_path, dst_path, dest_folder_id, item, dest_ids, read).await {
            Ok(done) => return Ok(done),
            Err(e) if GraphClient::is_rate_limited(&e) && rate_retries < 5 => {
                rate_retries += 1;
                let wait_secs = mailvault_core::sync_core::throttle::retry_after_from(&e).unwrap_or(rate_retries as u64 * 5);
                warn!("[migration] Rate limited, waiting {}s", wait_secs);
                on_rate_limit(wait_secs);
                // A pause wakes the wait and the message is tried again at
                // once: only a cancel gives it up, and never as written.
                let woken = interruptible_sleep(std::time::Duration::from_secs(wait_secs), ctx.cancel, ctx.notify).await;
                if woken && ctx.cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled during rate-limit wait".to_string());
                }
            }
            Err(e) if !retried && !imap::is_bandwidth_limited(&e) => {
                warn!("[migration] Email {} failed (attempt 1): {}, retrying in 2s", item.key, e);
                retried = true;
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// A tick inside folder `folder`.
fn folder_tick<'a>(
    status: &'a str,
    folder: &'a str,
    folder_progress: Option<String>,
    folders: &'a [FolderMapping],
    totals: &'a Totals,
    log: Option<(&'a str, &'a str, &'a str)>,
    rate_limited_for: Option<u64>,
) -> ProgressTick<'a> {
    ProgressTick { status, folder: Some(folder), folder_progress, folders, totals, log, rate_limited_for }
}

/// Copy folder `idx` of `folders`: make the destination folder, list what it
/// holds and what the source holds, then copy each message, honouring
/// cancel and pause between messages. A Graph 429 waits as Graph asks (up to
/// five times, a cancel ends the wait); any other failure is tried once more
/// after 2s, except a provider bandwidth limit, which ends the folder. A
/// message that still fails is one failed message, never the run. The
/// folder's counts and status land in `folders[idx]` at the end.
pub(crate) async fn copy_folder(
    ctx: &mut CopyCtx<'_>,
    folders: &mut [FolderMapping],
    idx: usize,
    totals: &mut Totals,
    sink: &mut dyn CopySink,
) -> FolderOutcome {
    let mut out = FolderOutcome::default();
    folders[idx].status = "in_progress".to_string();
    let src_path = folders[idx].source_path.clone();
    let dst_path = folders[idx].dest_path.clone();
    info!("[migration] Processing folder: {} -> {}", src_path, dst_path);
    sink.progress(folder_tick("running", &src_path, Some("0/0".to_string()), folders, totals, None, None));

    if let Err(e) = ensure_dest_folder(ctx, &mut folders[idx]).await {
        warn!("[migration] Failed to create dest folder {}: {}", dst_path, e);
        folders[idx].status = "failed".to_string();
        return out;
    }
    let dest_ids = fetch_dest_ids(ctx, &folders[idx]).await.unwrap_or_else(|e| {
        warn!("[migration] Failed to fetch dest Message-IDs for {}: {}", dst_path, e);
        HashSet::new()
    });
    if !dest_ids.is_empty() {
        info!("[migration] Found {} existing messages in dest '{}' for dedup", dest_ids.len(), dst_path);
    }
    let items = match list_source_items(ctx, &src_path, None).await {
        Ok(items) => items,
        Err(e) => {
            warn!("[migration] Failed to list source folder {}: {}", src_path, e);
            folders[idx].status = "failed".to_string();
            return out;
        }
    };
    out.started = true;
    let folder_total = items.len() as u32;
    folders[idx].email_count = folder_total;
    let dest_folder_id = folders[idx].dest_folder_id.clone();

    for item in &items {
        if ctx.cancel.load(Ordering::Relaxed) {
            break;
        }
        // Pause: finish the message in hand, then park. The checkpoint
        // carries this folder's live counters, which `folders` only gets
        // when the folder ends.
        if ctx.pause.load(Ordering::Relaxed) {
            let mut snapshot = folders.to_vec();
            (snapshot[idx].migrated, snapshot[idx].skipped, snapshot[idx].failed) = (out.migrated, out.skipped, out.failed);
            sink.checkpoint("paused", &snapshot, totals);
            while ctx.pause.load(Ordering::Relaxed) && !ctx.cancel.load(Ordering::Relaxed) {
                sink.progress(folder_tick("paused", &src_path, Some(out.progress(folder_total)), folders, totals, None, None));
                let _ = interruptible_sleep(std::time::Duration::from_millis(500), ctx.cancel, ctx.notify).await;
            }
            if ctx.cancel.load(Ordering::Relaxed) {
                break;
            }
            sink.checkpoint("running", &snapshot, totals);
        }
        let mut read = None;
        let result = copy_with_retries(ctx, &src_path, &dst_path, dest_folder_id.as_deref(), item, &dest_ids, &mut read, &mut |wait_secs| {
            sink.progress(folder_tick("rate_limited", &src_path, Some(out.progress(folder_total)), folders, totals, None, Some(wait_secs)));
        })
        .await;

        let (sender, subject, status) = match &result {
            Ok(CopyOutcome::Present { sender, subject, .. }) => {
                out.skipped += 1;
                totals.skipped += 1;
                (sender.as_str(), subject.as_str(), "skipped")
            }
            Ok(CopyOutcome::Written { sender, subject, .. }) => {
                out.migrated += 1;
                totals.migrated += 1;
                (sender.as_str(), subject.as_str(), "ok")
            }
            Err(e) => {
                warn!("migration: email {} failed, skipping: {}", item.key, e);
                out.failed += 1;
                totals.failed += 1;
                folders[idx].failed_uids.push(item.key);
                if imap::is_bandwidth_limited(e) {
                    warn!("[migration] Email {} hit provider bandwidth limit, aborting run", item.key);
                    out.bandwidth_hit = true;
                }
                // What the message's own bytes said, when they were read.
                match &read {
                    Some((sender, subject)) => (sender.as_str(), subject.as_str(), "failed"),
                    None => (item.sender.as_str(), item.subject.as_str(), "failed"),
                }
            }
        };
        sink.progress(folder_tick("running", &src_path, Some(out.progress(folder_total)), folders, totals, Some((sender, subject, status)), None));
        if out.bandwidth_hit {
            break;
        }
    }

    out.cancelled = ctx.cancel.load(Ordering::Relaxed);
    let m = &mut folders[idx];
    (m.migrated, m.skipped, m.failed) = (out.migrated, out.skipped, out.failed);
    m.status = if out.cancelled {
        "cancelled"
    } else if out.bandwidth_hit || (out.failed > 0 && out.migrated == 0) {
        "failed"
    } else {
        "completed"
    }
    .to_string();
    out
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

/// `run_migration`'s sink: the `migration-progress` event and the
/// `migration_state.json` checkpoint.
struct MigrationSink<'a> {
    state: &'a Arc<DaemonState>,
    id: String,
    source: &'a Side,
    dest: &'a Side,
    source_account_json: String,
    dest_account_json: String,
    started_at: String,
    start: std::time::Instant,
}

impl MigrationSink<'_> {
    fn snapshot(&self, status: &str, folders: &[FolderMapping], totals: &Totals) -> MigrationState {
        MigrationState {
            id: self.id.clone(),
            source_email: self.source.email.clone(),
            dest_email: self.dest.email.clone(),
            source_transport: self.source.transport.clone(),
            dest_transport: self.dest.transport.clone(),
            source_account_json: self.source_account_json.clone(),
            dest_account_json: self.dest_account_json.clone(),
            status: status.to_string(),
            folder_mappings: folders.to_vec(),
            total_emails: totals.total,
            migrated_emails: totals.migrated,
            skipped_emails: totals.skipped,
            failed_emails: totals.failed,
            started_at: self.started_at.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

impl CopySink for MigrationSink<'_> {
    fn progress(&mut self, tick: ProgressTick<'_>) {
        let payload = MigrationProgress {
            source_email: self.source.email.clone(),
            dest_email: self.dest.email.clone(),
            total_emails: tick.totals.total,
            migrated_emails: tick.totals.migrated,
            skipped_emails: tick.totals.skipped,
            failed_emails: tick.totals.failed,
            current_folder: tick.folder.map(str::to_string),
            folder_progress: tick.folder_progress,
            status: tick.status.to_string(),
            folders: tick.folders.to_vec(),
            started_at: self.started_at.clone(),
            elapsed_seconds: self.start.elapsed().as_secs(),
            last_log_entry: tick.log.map(|(sender, subject, status)| MigrationLogEntry {
                timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                sender: sender.to_string(),
                subject: subject.to_string(),
                status: status.to_string(),
            }),
            rate_limit_remaining: tick.rate_limited_for,
        };
        self.state.events.emit("migration-progress", serde_json::to_value(&payload).unwrap_or_default());
    }

    /// Persists a checkpoint (status "paused" while parked, "running" once
    /// woken or after a folder) so migration_state.json always reflects a
    /// mid-folder pause too.
    fn checkpoint(&mut self, status: &str, folders: &[FolderMapping], totals: &Totals) {
        let _ = save_migration_state(&self.state.app_dir, &self.snapshot(status, folders, totals));
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run_migration(
    state: Arc<DaemonState>,
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
    // A JMAP side is "jmap" whatever the app sent (`effective_transport`).
    let source = Side::new(source_config, &source_transport);
    let dest = Side::new(dest_config, &dest_transport);

    info!(
        "[migration] run_migration tokens: cancel={:p}, pause={:p}, notify={:p}",
        &*cancel, &*pause, &*notify
    );
    info!(
        "[migration] Starting {} -> {} ({} -> {}, {} folders)",
        source.email, dest.email, source.transport, dest.transport, folder_mappings.len()
    );

    let mut sink = MigrationSink {
        state: &state,
        id: uuid::Uuid::new_v4().to_string(),
        source: &source,
        dest: &dest,
        source_account_json,
        dest_account_json,
        started_at: chrono::Utc::now().to_rfc3339(),
        start: std::time::Instant::now(),
    };
    // Total email count across all folders
    let mut totals = Totals { total: folder_mappings.iter().map(|f| f.email_count).sum(), ..Default::default() };
    let mut ctx = CopyCtx {
        state: &state,
        source: &source,
        dest: &dest,
        lane: Lane::Priority,
        cancel: &cancel,
        pause: &pause,
        notify: &notify,
        graph_folder_cache: HashMap::new(),
        seen_fingerprints: None,
    };

    // Pre-populate the Graph folder cache from existing destination folders
    if dest.transport == "graph" {
        if let Ok(client) = dest.graph() {
            if let Ok(folders) = client.list_folders().await {
                for f in folders {
                    ctx.graph_folder_cache.insert(f.display_name.clone(), f.id.clone());
                }
            }
        }
    }

    // Set when the IMAP server reports a daily bandwidth suspension (Gmail:
    // 2500 MB/day down, 500 MB/day APPEND up), abort the run instead of
    // failing every remaining email against a suspended account.
    let mut bandwidth_hit = false;

    for folder_idx in 0..folder_mappings.len() {
        info!("[migration] Folder loop iteration {}/{}, cancel={}, pause={}", folder_idx + 1, folder_mappings.len(), cancel.load(Ordering::Relaxed), pause.load(Ordering::Relaxed));
        if cancel.load(Ordering::Relaxed) {
            info!("[migration] Cancelled at folder loop check");
            folder_mappings[folder_idx].status = "cancelled".to_string();
            break;
        }

        // Pause loop, save state and wait
        if pause.load(Ordering::Relaxed) {
            sink.checkpoint("paused", &folder_mappings, &totals);
            info!("[migration] Paused, state saved to disk");

            while pause.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                sink.progress(ProgressTick {
                    status: "paused",
                    folder: Some(folder_mappings[folder_idx].source_path.as_str()),
                    folder_progress: None,
                    folders: &folder_mappings,
                    totals: &totals,
                    log: None,
                    rate_limited_for: None,
                });
                let _ = interruptible_sleep(std::time::Duration::from_millis(500), &cancel, &notify).await;
            }
            if !cancel.load(Ordering::Relaxed) {
                sink.checkpoint("running", &folder_mappings, &totals);
            }
        }

        if folder_mappings[folder_idx].status == "completed" {
            continue;
        }

        let done = copy_folder(&mut ctx, &mut folder_mappings, folder_idx, &mut totals, &mut sink).await;
        if !done.started {
            continue;
        }
        // Save checkpoint after each folder
        sink.checkpoint("running", &folder_mappings, &totals);
        info!("migration: folder '{}' completed, saved checkpoint", folder_mappings[folder_idx].source_path);
        if done.bandwidth_hit {
            bandwidth_hit = true;
            warn!("[migration] Provider bandwidth limit reached, stopping run; re-run after the limit resets (usually within 1 hour, up to 24 hours)");
            break;
        }
    }

    let final_status = if cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else if bandwidth_hit || (totals.failed > 0 && totals.migrated == 0) {
        "failed"
    } else {
        "completed"
    };
    let final_state = sink.snapshot(final_status, &folder_mappings, &totals);

    // Cancel discards persistent state; completed/failed saves final state
    if final_status == "cancelled" {
        let _ = clear_migration_state(&state.app_dir);
        info!("[migration] Cancelled, persistent state cleared");
    } else {
        let _ = save_migration_state(&state.app_dir, &final_state);
    }

    sink.progress(ProgressTick {
        status: final_status,
        folder: None,
        folder_progress: None,
        folders: &folder_mappings,
        totals: &totals,
        log: None,
        rate_limited_for: None,
    });

    info!(
        "[migration] {}, migrated: {}, skipped: {}, failed: {}",
        final_status, totals.migrated, totals.skipped, totals.failed
    );

    Ok(final_state)
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
    state: Arc<DaemonState>,
    source_config: ImapConfig,
    source_transport: String,
    folder_mappings: Vec<FolderMapping>,
) -> Result<(), String> {
    let source_transport = effective_transport(&source_config, &source_transport);
    for mapping in &folder_mappings {
        if source_transport == "imap" {
            let pool = &state.imap_pool;
            let mut guard = pool.get_priority(&source_config).await?;
            let uids = imap::search_all_uids(&mut guard.session, &mapping.source_path, false).await?;
            guard.last_selected = Some(mapping.source_path.clone());
            pool.return_priority(&source_config, guard).await;
            let count = uids.len() as u32;
            state.events.emit("migration-folder-count", serde_json::json!({
                "folder_path": mapping.source_path,
                "count": count,
                "counting": false,
            }));
        } else if source_transport == "jmap" {
            let acct = state.jmap.get(&source_config).await.map_err(|e| e.to_string())?;
            let boxes = acct.current().await.map_err(|e| e.to_string())?;
            let count = boxes
                .ids
                .get(&mapping.source_path)
                .and_then(|id| boxes.list.iter().find(|m| &m.id == id))
                .map_or(0, |m| m.total_emails);
            state.events.emit("migration-folder-count", serde_json::json!({
                "folder_path": mapping.source_path,
                "count": count,
                "counting": false,
            }));
        } else {
            // Graph source -- paginated counting
            if let Some(ref token) = source_config.access_token {
                let client = GraphClient::new(token).for_account(&source_config.email);
                let folders = client.list_folders().await?;
                let folder = folders.iter()
                    .find(|f| f.display_name == mapping.source_path || f.display_name == normalize_graph_folder(&mapping.source_path));
                if let Some(folder) = folder {
                    let mut total = 0u32;
                    let mut skip = 0u32;
                    loop {
                        let (messages, next_link) = client.list_messages(&folder.id, 100, skip).await?;
                        total += messages.len() as u32;
                        state.events.emit("migration-folder-count", serde_json::json!({
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
                    state.events.emit("migration-folder-count", serde_json::json!({
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

// ── Folder mappings (get_folder_mappings route logic) ───────────────────────

/// List a live account's IMAP/Graph mailboxes, returning `MailboxInfo` either
/// way so `build_folder_mappings` never needs to know which transport it came
/// from. IMAP failures never return the session to the pool (same treatment
/// `commands.rs`'s app-side `with_background` gave an error path).
async fn list_transport_mailboxes(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    transport: &str,
) -> Result<Vec<MailboxInfo>, String> {
    if transport == "jmap" {
        let acct = state.jmap.get(config).await.map_err(|e| e.to_string())?;
        return Ok(acct.current().await.map_err(|e| e.to_string())?.infos);
    }
    if transport == "graph" {
        let token = config.access_token.as_deref().ok_or("No access token for Graph")?;
        let client = GraphClient::new(token).for_account(&config.email);
        let graph_folders = client.list_folders().await?;
        Ok(graph_folders
            .into_iter()
            .map(|f| MailboxInfo {
                name: f.display_name.clone(),
                path: f.display_name,
                special_use: None,
                special_use_guessed: false,
                flags: Vec::new(),
                delimiter: Some("/".to_string()),
                noselect: false,
                children: Vec::new(),
            })
            .collect())
    } else {
        let pool = &state.imap_pool;
        let mut guard = pool.get_background(config).await?;
        match imap::list_mailboxes(&mut guard.session).await {
            Ok(folders) => {
                pool.return_background(config, guard).await;
                Ok(folders)
            }
            Err(e) => Err(e),
        }
    }
}

/// `get_folder_mappings` route logic (moved out of `commands.rs`, which built
/// this inline against `with_background`/`tauri::State<ImapPool>`). Same
/// special-use/delimiter mapping `build_folder_mappings` always did; only the
/// pool/session plumbing changed.
pub async fn get_folder_mappings(
    state: &Arc<DaemonState>,
    source_config: &ImapConfig,
    dest_config: &ImapConfig,
    source_transport: &str,
    dest_transport: &str,
) -> Result<Vec<FolderMapping>, String> {
    let source_transport = effective_transport(source_config, source_transport);
    let dest_transport = effective_transport(dest_config, dest_transport);
    let source_folders = list_transport_mailboxes(state, source_config, &source_transport).await?;
    let dest_folders = list_transport_mailboxes(state, dest_config, &dest_transport).await?;

    let src_delim = source_folders.first().and_then(|f| f.delimiter.as_deref()).unwrap_or("/");
    let dst_delim = dest_folders.first().and_then(|f| f.delimiter.as_deref()).unwrap_or("/");

    Ok(build_folder_mappings(&source_folders, &dest_folders, Some(src_delim), Some(dst_delim)))
}

// ── State persistence ───────────────────────────────────────────────────────

pub fn save_migration_state(app_dir: &Path, migration_state: &MigrationState) -> Result<(), String> {
    let path = app_dir.join("migration_state.json");

    let json = serde_json::to_string_pretty(migration_state)
        .map_err(|e| format!("Failed to serialize migration state: {}", e))?;

    std::fs::create_dir_all(app_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write migration state: {}", e))?;

    Ok(())
}

pub fn load_migration_state(app_dir: &Path) -> Result<Option<MigrationState>, String> {
    let path = app_dir.join("migration_state.json");

    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read migration state: {}", e))?;
    let migration_state: MigrationState = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse migration state: {}", e))?;

    Ok(Some(migration_state))
}

pub fn clear_migration_state(app_dir: &Path) -> Result<(), String> {
    let path = app_dir.join("migration_state.json");

    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete migration state: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    //! Migrations with a JMAP account on one side (Task 9b), run straight
    //! through `run_migration` against the mock IMAP and mock JMAP servers.
    //! Each passes the transports the app sends today (`getTransport`:
    //! "imap" for a JMAP account), so `effective_transport` is what routes
    //! the JMAP side.

    use super::*;
    use crate::jmap_test_support as support;
    use mock_imap::state::Mailbox;
    use mock_imap::MockImap;
    use mock_jmap::MockJmap;

    fn st() -> (tempfile::TempDir, tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        (vault, app_dir, s)
    }

    fn imap_config(server: &MockImap, email: &str) -> ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(serde_json::json!({
            "email": email,
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
            "imapSecure": true,
        }))
        .unwrap()
    }

    fn mapping(source: &str, dest: &str) -> FolderMapping {
        FolderMapping {
            source_path: source.to_string(),
            dest_path: dest.to_string(),
            source_special_use: None,
            dest_folder_id: None,
            email_count: 0,
            status: "pending".to_string(),
            migrated: 0,
            skipped: 0,
            failed: 0,
            failed_uids: Vec::new(),
        }
    }

    async fn migrate(s: &Arc<DaemonState>, source: &ImapConfig, dest: &ImapConfig, mappings: Vec<FolderMapping>) -> MigrationState {
        run_migration(
            Arc::clone(s),
            source.clone(),
            dest.clone(),
            "imap".to_string(),
            "imap".to_string(),
            "{}".to_string(),
            "{}".to_string(),
            mappings,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(tokio::sync::Notify::new()),
        )
        .await
        .expect("the run finishes")
    }

    /// An IMAP INBOX: uid 1 read with an INTERNALDATE of 2019-03-05T08:15Z,
    /// uid 2 flagged and answered.
    fn imap_source() -> MockImap {
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(
            mock_imap::Message::new(1, support::raw("m1", "first"))
                .with_flags(&["\\Seen"])
                .with_internal_date("05-Mar-2019 09:15:00 +0100"),
        );
        inbox.add(mock_imap::Message::new(2, support::raw("m2", "second")).with_flags(&["\\Flagged", "\\Answered"]));
        MockImap::start(mock_imap::Scenario::new().mailbox(inbox))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_migration_from_imap_moves_two_messages_and_keeps_flags() {
        let (_v, _a, s) = st();
        let source = imap_source();
        let m = MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let dest = support::config(&m, port);

        let done = migrate(&s, &imap_config(&source, "source@example.com"), &dest, vec![mapping("INBOX", "Archive/2019")]).await;

        assert_eq!(done.status, "completed");
        assert_eq!((done.migrated_emails, done.skipped_emails, done.failed_emails), (2, 0, 0));
        assert_eq!(done.dest_transport, "jmap", "the JMAP side is routed as JMAP whatever the app sent");
        let made = support::mailbox_named(&m, Some("Archive"), "2019").expect("Archive/2019 made on the server");
        let moved = support::emails_in(&m, &made);
        assert_eq!(moved.len(), 2);
        let m1 = moved.iter().find(|e| e.raw.contains("<m1@x>")).unwrap();
        let m2 = moved.iter().find(|e| e.raw.contains("<m2@x>")).unwrap();
        assert_eq!(m1.raw, support::raw("m1", "first"), "byte for byte");
        assert_eq!(m1.keywords, support::set(&["$seen"]));
        assert_eq!(m1.received_at, "2019-03-05T08:15:00Z", "the source INTERNALDATE, in UTC");
        assert_eq!(m2.keywords, support::set(&["$answered", "$flagged"]));
        assert!(s.jmap.is_own(&dest, &m1.id) && s.jmap.is_own(&dest, &m2.id), "never announced as arrivals");
        assert!(trap.accept().is_err(), "the JMAP side never dials IMAP");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_migration_rerun_skips_what_the_destination_holds() {
        let (_v, _a, s) = st();
        let source = imap_source();
        let m = MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        let (src, dest) = (imap_config(&source, "source@example.com"), support::config(&m, port));
        migrate(&s, &src, &dest, vec![mapping("INBOX", "INBOX")]).await;
        let imports = m.count_calls("Email/import");
        assert_eq!(imports, 2);

        let again = migrate(&s, &src, &dest, vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!((again.migrated_emails, again.skipped_emails, again.failed_emails), (0, 2, 0));
        assert_eq!(m.count_calls("Email/import"), imports, "nothing imported twice");
    }

    /// The server dedupes the import to a copy it holds in another mailbox
    /// (Work): the message counts as present, and the copy gets the
    /// destination mailbox's label so the folder lists it. Its other labels
    /// stay.
    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_migration_labels_the_copy_a_server_dedupe_names() {
        let (_v, _a, s) = st();
        let source = imap_source();
        let mut scenario = support::scenario();
        scenario.faults.push(mock_jmap::Fault::ImportAlreadyExists);
        scenario.accounts[0].mailboxes[1].emails.push(mock_jmap::ScenarioEmail {
            id: "w1".into(),
            raw: support::raw("m1", "first"),
            keywords: vec![],
            received_at: "2026-10-03T10:00:00Z".into(),
            also_in: vec![],
        });
        let m = MockJmap::start(scenario);
        let (_trap, port) = support::imap_trap();

        let done = migrate(&s, &imap_config(&source, "source@example.com"), &support::config(&m, port), vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!(done.status, "completed");
        // m1 is deduped to w1 (present); m2 is deduped by the same fault only
        // when the server holds it, which it does not.
        assert_eq!((done.skipped_emails, done.failed_emails), (1, 0), "{done:?}");
        let labels = m.read(|st| st.email("acc1", "w1").map(|e| e.mailbox_ids.clone()).unwrap_or_default());
        assert_eq!(labels, support::set(&["mb-inbox", "mb-work"]), "relabelled into the destination, Work kept");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_migration_to_imap_moves_messages_and_keeps_keywords() {
        let (_v, _a, s) = st();
        let m = MockJmap::start(support::scenario());
        let dest_server = MockImap::start(mock_imap::Scenario::new().mailbox(Mailbox::new("INBOX")));
        let (_trap, port) = support::imap_trap();

        let done = migrate(&s, &support::config(&m, port), &imap_config(&dest_server, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!((done.migrated_emails, done.failed_emails), (2, 0));
        assert_eq!(done.source_transport, "jmap");
        let state = dest_server.state();
        let inbox = state.find("INBOX").expect("INBOX");
        assert_eq!(inbox.messages.len(), 2);
        let e1 = inbox.messages.iter().find(|msg| String::from_utf8_lossy(&msg.raw).contains("<e1@x>")).expect("e1 appended");
        assert!(e1.has_flag("\\Seen"), "{:?}", e1.flags);
        let e2 = inbox.messages.iter().find(|msg| String::from_utf8_lossy(&msg.raw).contains("<e2@x>")).expect("e2 appended");
        assert!(!e2.has_flag("\\Seen"), "{:?}", e2.flags);
    }

    // ── imap -> imap characterization (pinned before the copy engine) ──────

    fn plain(uid: u32) -> String {
        format!(
            "From: sender@example.com\r\nTo: user@example.com\r\nSubject: msg {uid}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMessage-ID: <{uid}@example.com>\r\n\r\nbody {uid}\r\n"
        )
    }

    fn mailbox_of(name: &str, uids: &[u32]) -> Mailbox {
        let mut mb = Mailbox::new(name);
        for &uid in uids {
            mb.add(mock_imap::Message::new(uid, plain(uid)));
        }
        mb
    }

    fn inbox_of(uids: &[u32]) -> Mailbox {
        mailbox_of("INBOX", uids)
    }

    fn empty_dest(scenario: mock_imap::Scenario) -> MockImap {
        MockImap::start(scenario.mailbox(Mailbox::new("INBOX")))
    }

    /// Every `migration-progress` payload the bus carried so far, oldest first.
    fn progress_events(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(line) = rx.try_recv() {
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["params"]["name"] == "migration-progress" {
                out.push(v["params"]["payload"].clone());
            }
        }
        out
    }

    fn keys(v: &Value) -> Vec<&str> {
        let mut k: Vec<&str> = v.as_object().expect("an object").keys().map(String::as_str).collect();
        k.sort_unstable();
        k
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn imap_to_imap_rerun_skips_what_the_destination_holds() {
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2])));
        let dest = empty_dest(mock_imap::Scenario::new());
        let (src, dst) = (imap_config(&source, "source@example.com"), imap_config(&dest, "dest@example.com"));
        let first = migrate(&s, &src, &dst, vec![mapping("INBOX", "INBOX")]).await;
        assert_eq!((first.migrated_emails, first.skipped_emails, first.failed_emails), (2, 0, 0));

        let again = migrate(&s, &src, &dst, vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!((again.migrated_emails, again.skipped_emails, again.failed_emails), (0, 2, 0));
        assert_eq!(again.status, "completed");
        assert_eq!(dest.count_commands("APPEND"), 2, "nothing appended twice");
        assert_eq!(dest.state().find("INBOX").unwrap().messages.len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn imap_to_imap_keeps_internaldate_and_seen_flagged() {
        let (_v, _a, s) = st();
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(mock_imap::Message::new(1, plain(1)).with_flags(&["\\Seen"]).with_internal_date("05-Mar-2019 09:15:00 +0100"));
        inbox.add(mock_imap::Message::new(2, plain(2)).with_flags(&["\\Flagged"]));
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox));
        let dest = empty_dest(mock_imap::Scenario::new());

        let done = migrate(&s, &imap_config(&source, "source@example.com"), &imap_config(&dest, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!((done.status.as_str(), done.migrated_emails), ("completed", 2));
        let state = dest.state();
        let inbox = state.find("INBOX").unwrap();
        let m1 = inbox.messages.iter().find(|m| String::from_utf8_lossy(&m.raw).contains("<1@example.com>")).unwrap();
        let m2 = inbox.messages.iter().find(|m| String::from_utf8_lossy(&m.raw).contains("<2@example.com>")).unwrap();
        assert_eq!(m1.internal_date, "05-Mar-2019 09:15:00 +0100", "the source INTERNALDATE");
        assert!(m1.has_flag("\\Seen") && !m1.has_flag("\\Flagged"), "{:?}", m1.flags);
        assert!(m2.has_flag("\\Flagged") && !m2.has_flag("\\Seen"), "{:?}", m2.flags);
        assert_eq!(m1.raw, plain(1).into_bytes(), "byte for byte");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_append_records_the_uid_in_failed_uids_and_the_run_completes() {
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2, 3])));
        let dest = empty_dest(mock_imap::Scenario::new().fault(
            mock_imap::Trigger::with("APPEND", "Subject: msg 2"),
            mock_imap::Action::RefuseWith("NO".into(), "[CANNOT] refused".into()),
        ));

        let done = migrate(&s, &imap_config(&source, "source@example.com"), &imap_config(&dest, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!(done.status, "completed");
        assert_eq!((done.migrated_emails, done.skipped_emails, done.failed_emails), (2, 0, 1));
        assert_eq!(done.folder_mappings[0].failed_uids, vec![2]);
        assert_eq!(done.folder_mappings[0].status, "completed");
        assert_eq!(dest.state().find("INBOX").unwrap().messages.len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bandwidth_limit_aborts_the_run_as_failed() {
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2, 3])).mailbox(mailbox_of("Work", &[4])));
        let dest = empty_dest(mock_imap::Scenario::new().fault(mock_imap::Trigger::on("APPEND"), mock_imap::Action::throttled()));

        let done = migrate(
            &s,
            &imap_config(&source, "source@example.com"),
            &imap_config(&dest, "dest@example.com"),
            vec![mapping("INBOX", "INBOX"), mapping("Work", "INBOX")],
        )
        .await;

        assert_eq!(done.status, "failed");
        assert_eq!((done.migrated_emails, done.failed_emails), (0, 1));
        assert_eq!(dest.count_commands("APPEND"), 1, "no retry and no further message against a suspended account");
        assert_eq!(done.folder_mappings[0].status, "failed");
        assert_eq!(done.folder_mappings[1].status, "pending", "the next folder never starts");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn migration_progress_payload_keeps_its_snake_case_shape() {
        let (_v, a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2])));
        let dest = empty_dest(mock_imap::Scenario::new());
        let mut rx = s.events.subscribe();

        migrate(&s, &imap_config(&source, "source@example.com"), &imap_config(&dest, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        let events = progress_events(&mut rx);
        let seq: Vec<(String, Value, Value)> = events
            .iter()
            .map(|e| (e["status"].as_str().unwrap().to_string(), e["folder_progress"].clone(), e["last_log_entry"]["status"].clone()))
            .collect();
        assert_eq!(
            seq,
            vec![
                ("running".to_string(), json!("0/0"), Value::Null),
                ("running".to_string(), json!("1/2"), json!("ok")),
                ("running".to_string(), json!("2/2"), json!("ok")),
                ("completed".to_string(), Value::Null, Value::Null),
            ]
        );
        assert_eq!(
            keys(&events[1]),
            [
                "current_folder", "dest_email", "elapsed_seconds", "failed_emails", "folder_progress", "folders", "last_log_entry",
                "migrated_emails", "rate_limit_remaining", "skipped_emails", "source_email", "started_at", "status", "total_emails",
            ]
        );
        assert_eq!(
            keys(&events[1]["folders"][0]),
            ["dest_folder_id", "dest_path", "email_count", "failed", "failed_uids", "migrated", "skipped", "source_path", "source_special_use", "status"]
        );
        assert_eq!(keys(&events[1]["last_log_entry"]), ["sender", "status", "subject", "timestamp"]);
        assert_eq!(events[1]["last_log_entry"]["sender"], "sender@example.com");
        assert_eq!(events[1]["last_log_entry"]["subject"], "msg 1");
        assert_eq!(events[0]["folders"][0]["status"], "in_progress");
        assert_eq!(events[3]["folders"][0]["status"], "completed");
        assert_eq!(events[3]["current_folder"], Value::Null);

        let text = std::fs::read_to_string(a.path().join("migration_state.json")).unwrap();
        let top: Vec<&str> = text
            .lines()
            .filter(|l| l.starts_with("  \"") && !l.starts_with("   "))
            .map(|l| l.trim_start().split('"').nth(1).unwrap())
            .collect();
        assert_eq!(
            top,
            [
                "id", "source_email", "dest_email", "source_transport", "dest_transport", "source_account_json", "dest_account_json", "status",
                "folder_mappings", "total_emails", "migrated_emails", "skipped_emails", "failed_emails", "started_at", "updated_at",
            ]
        );
    }

    /// Deliberate change of the copy engine: imap -> imap maps flags as every
    /// other source does (`fetch_imap_message`), so a source `\Deleted` is no
    /// longer copied and keywords are.
    #[tokio::test(flavor = "multi_thread")]
    async fn imap_to_imap_drops_deleted_flag_and_keeps_keywords() {
        let (_v, _a, s) = st();
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(mock_imap::Message::new(1, plain(1)).with_flags(&["\\Seen", "\\Deleted", "$Work"]));
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox));
        let dest = empty_dest(mock_imap::Scenario::new());

        let done = migrate(&s, &imap_config(&source, "source@example.com"), &imap_config(&dest, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!(done.migrated_emails, 1);
        let state = dest.state();
        let m1 = &state.find("INBOX").unwrap().messages[0];
        assert!(m1.has_flag("\\Seen") && m1.has_flag("$Work"), "{:?}", m1.flags);
        assert!(!m1.has_flag("\\Deleted"), "{:?}", m1.flags);
    }

    /// Deliberate change of the copy engine: a destination session that dies
    /// mid-run is dropped, not pooled again, so it costs the message in hand
    /// and the next one gets a fresh connection.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_dest_connection_dropped_mid_run_fails_one_message_and_emits_a_final_event() {
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2, 3])));
        let dest = empty_dest(
            mock_imap::Scenario::new()
                .fault(mock_imap::Trigger::with("APPEND", "Subject: msg 2"), mock_imap::Action::ByeAndClose("gone".into())),
        );
        let mut rx = s.events.subscribe();

        let done = migrate(&s, &imap_config(&source, "source@example.com"), &imap_config(&dest, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        assert_eq!((done.migrated_emails, done.failed_emails), (2, 1), "{done:?}");
        assert_eq!(done.folder_mappings[0].failed_uids, vec![2]);
        assert_eq!(done.status, "completed");
        let last = progress_events(&mut rx).pop().expect("a final event");
        assert_eq!((last["status"].as_str(), last["current_folder"].as_str()), (Some("completed"), None));
    }

    /// Deliberate change of the copy engine: a source folder that cannot be
    /// listed fails that folder, and the run goes on to the next one and ends
    /// with its final event (it used to return an error with no final event).
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unlistable_source_folder_fails_that_folder_and_the_run_goes_on() {
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2])));
        let dest = empty_dest(mock_imap::Scenario::new());
        let mut rx = s.events.subscribe();

        let done = migrate(
            &s,
            &imap_config(&source, "source@example.com"),
            &imap_config(&dest, "dest@example.com"),
            vec![mapping("Gone", "INBOX"), mapping("INBOX", "INBOX")],
        )
        .await;

        let statuses: Vec<&str> = done.folder_mappings.iter().map(|f| f.status.as_str()).collect();
        assert_eq!(statuses, ["failed", "completed"]);
        assert_eq!((done.status.as_str(), done.migrated_emails, done.failed_emails), ("completed", 2, 0));
        let last = progress_events(&mut rx).pop().expect("a final event");
        assert_eq!((last["status"].as_str(), last["current_folder"].as_str()), (Some("completed"), None));
    }

    /// Every tick a copy reported: status, the rate-limit wait, the log status.
    struct Ticks(Vec<(String, Option<u64>, Option<String>)>);

    impl CopySink for Ticks {
        fn progress(&mut self, tick: ProgressTick<'_>) {
            self.0.push((tick.status.to_string(), tick.rate_limited_for, tick.log.map(|l| l.2.to_string())));
        }
        fn checkpoint(&mut self, _status: &str, _folders: &[FolderMapping], _totals: &Totals) {}
    }

    fn graph_message(id: &str) -> String {
        json!({
            "id": id, "subject": "msg 1", "from": null, "toRecipients": null, "ccRecipients": null, "bccRecipients": null,
            "receivedDateTime": "2026-01-01T12:00:00Z", "sentDateTime": null, "isRead": false, "hasAttachments": false,
            "internetMessageId": "<1@example.com>", "body": null, "internetMessageHeaders": null,
        })
        .to_string()
    }

    /// Graph throttles the upload once: the copy reports the wait Graph asked
    /// for, waits, and writes the message, which counts once.
    #[tokio::test(flavor = "multi_thread")]
    async fn graph_dest_rate_limit_retries_then_writes() {
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![
            (200, json!({"value": []}).to_string()),
            (429, json!({"error": {"code": "TooManyRequests"}}).to_string()),
            (200, graph_message("draft1")),
            (200, graph_message("m1")),
        ]);
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1])));
        let src = Side::new(imap_config(&source, "source@example.com"), "imap");
        let dest_config = serde_json::from_value(json!({"email": "dest@example.com", "imapHost": "outlook.office365.com", "oauth2AccessToken": "tok"})).unwrap();
        let dest = Side::new(dest_config, "graph");
        let (cancel, pause, notify) = (AtomicBool::new(false), AtomicBool::new(false), tokio::sync::Notify::new());
        // The mock sends no Retry-After, so Graph's wait reads as 30s: a
        // stored wake-up ends it early, as a pause would.
        notify.notify_one();
        let mut ctx = CopyCtx {
            state: &s,
            source: &src,
            dest: &dest,
            lane: Lane::Priority,
            cancel: &cancel,
            pause: &pause,
            notify: &notify,
            graph_folder_cache: HashMap::from([("Archive".to_string(), "fld-archive".to_string())]),
            seen_fingerprints: None,
        };
        let mut folders = vec![mapping("INBOX", "Archive")];
        let mut totals = Totals::default();
        let mut ticks = Ticks(Vec::new());

        let out = copy_folder(&mut ctx, &mut folders, 0, &mut totals, &mut ticks).await;

        assert_eq!((out.migrated, out.failed, totals.migrated), (1, 0, 1), "{:?}", ticks.0);
        assert_eq!(folders[0].dest_folder_id.as_deref(), Some("fld-archive"));
        assert_eq!(
            ticks.0[1..],
            [("rate_limited".to_string(), Some(30), None), ("running".to_string(), None, Some("ok".to_string()))]
        );
        let requests: Vec<String> = crate::handlers::graph::test_graph_requests()
            .iter()
            .map(|r| format!("{} {}", r.method, r.path.split('?').next().unwrap_or_default()))
            .collect();
        assert_eq!(
            requests,
            ["GET /me/mailFolders/fld-archive/messages", "POST /me/messages", "POST /me/messages", "POST /me/messages/draft1/move"]
        );
    }

    fn archive_count(m: &MockJmap) -> usize {
        m.read(|s| s.account("acc1").mailboxes.values().filter(|b| b.name == "Archive").count())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_ensure_folder_carries_on_when_a_parent_was_made_meanwhile() {
        let (_v, _a, s) = st();
        let m = MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        let acct = s.jmap.get(&support::config(&m, port)).await.unwrap();
        // The list this call works from, read before another folder's run
        // (or another client) makes "Archive".
        let stale = acct.current().await.unwrap();
        assert!(!stale.ids.contains_key("Archive"));
        m.mutate(|st| {
            st.add_mailbox(
                "acc1",
                mock_jmap::ScenarioMailbox { id: "mb-archive".into(), name: "Archive".into(), parent_id: None, role: None, emails: vec![] },
            )
        });

        let id = ensure_dest_folder_in(&acct, "Archive/2019", stale).await.expect("the create that lost the race is not a failure");

        assert_eq!(support::mailbox_named(&m, Some("Archive"), "2019"), Some(id));
        assert_eq!(archive_count(&m), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_ensure_folder_for_two_siblings_at_once_makes_the_parent_once() {
        let (_v, _a, s) = st();
        let m = MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        let acct = s.jmap.get(&support::config(&m, port)).await.unwrap();

        let (a, b) = tokio::join!(ensure_dest_folder_jmap(&acct, "Archive/2019"), ensure_dest_folder_jmap(&acct, "Archive/2020"));

        let (a, b) = (a.expect("2019"), b.expect("2020"));
        assert_eq!(support::mailbox_named(&m, Some("Archive"), "2019"), Some(a));
        assert_eq!(support::mailbox_named(&m, Some("Archive"), "2020"), Some(b));
        assert_eq!(archive_count(&m), 1, "one Archive, whoever got there first");
    }

    #[tokio::test]
    async fn jmap_folder_mappings_list_the_jmap_mailboxes() {
        let (_v, _a, s) = st();
        let m = MockJmap::start(support::scenario());
        let dest_server = MockImap::start(mock_imap::Scenario::new().mailbox(Mailbox::new("INBOX")));
        let (trap, port) = support::imap_trap();

        let mappings =
            get_folder_mappings(&s, &support::config(&m, port), &imap_config(&dest_server, "dest@example.com"), "imap", "imap")
                .await
                .unwrap();

        let sources: Vec<&str> = mappings.iter().map(|f| f.source_path.as_str()).collect();
        assert_eq!(sources, ["INBOX", "Work", "Sent", "Trash"], "mailbox_tree order: inbox, then sortOrder");
        assert!(trap.accept().is_err());
    }

    /// A message whose APPEND was refused after its bytes were read is
    /// logged with the sender and subject read from those bytes: an IMAP
    /// listing has neither.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_append_logs_the_sender_and_subject_it_read() {
        let (_v, _a, s) = st();
        let source = MockImap::start(mock_imap::Scenario::new().mailbox(inbox_of(&[1, 2])));
        let refused = || mock_imap::Action::RefuseWith("NO".into(), "[CANNOT] refused".into());
        let dest = empty_dest(
            mock_imap::Scenario::new()
                .fault(mock_imap::Trigger::nth_with("APPEND", "Subject: msg 2", 1), refused())
                .fault(mock_imap::Trigger::nth_with("APPEND", "Subject: msg 2", 2), refused()),
        );
        let mut rx = s.events.subscribe();

        migrate(&s, &imap_config(&source, "source@example.com"), &imap_config(&dest, "dest@example.com"), vec![mapping("INBOX", "INBOX")]).await;

        let failed: Vec<Value> = progress_events(&mut rx).into_iter().map(|e| e["last_log_entry"].clone()).filter(|l| l["status"] == json!("failed")).collect();
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert_eq!((failed[0]["sender"].clone(), failed[0]["subject"].clone()), (json!("sender@example.com"), json!("msg 2")));
    }

    /// A Graph source folder longer than a page: the listing follows the
    /// page link Graph gave (a `$skip` count drifts when mail arrives or
    /// goes between pages).
    #[tokio::test(flavor = "multi_thread")]
    async fn graph_source_listing_follows_the_next_link() {
        // The mock's address, for a page link under it.
        let base = {
            let _probe = crate::handlers::graph::test_graph_mock_with(vec![]);
            std::env::var("MAILVAULT_GRAPH_BASE").expect("the mock's base")
        };
        let page = |id: &str, next: Option<String>| {
            let mut v: Value = serde_json::from_str(&format!("{{\"value\": [{}]}}", graph_message(id))).unwrap();
            if let Some(next) = next {
                v["@odata.nextLink"] = json!(next);
            }
            v.to_string()
        };
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![
            (200, page("m1", Some(format!("{base}/me/mailFolders/fld-src/messages?$skiptoken=p2")))),
            (200, page("m2", None)),
        ]);
        let (_v, _a, s) = st();
        let config = serde_json::from_value(json!({"email": "source@example.com", "imapHost": "outlook.office365.com", "oauth2AccessToken": "tok"})).unwrap();
        let (src, dest) = (Side::new(config, "graph"), Side::new(imap_config(&MockImap::start(mock_imap::Scenario::new()), "d@example.com"), "imap"));
        let (cancel, pause, notify) = (AtomicBool::new(false), AtomicBool::new(false), tokio::sync::Notify::new());
        let ctx = CopyCtx {
            state: &s,
            source: &src,
            dest: &dest,
            lane: Lane::Priority,
            cancel: &cancel,
            pause: &pause,
            notify: &notify,
            graph_folder_cache: HashMap::new(),
            seen_fingerprints: None,
        };

        let items = list_source_items(&ctx, "Clients", Some("fld-src")).await.unwrap();

        let ids: Vec<Option<String>> = items.iter().map(|i| i.remote_id.clone()).collect();
        assert_eq!(ids, [Some("m1".to_string()), Some("m2".to_string())]);
        let requests: Vec<String> = crate::handlers::graph::test_graph_requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(requests.len(), 2, "{requests:?}");
        assert_eq!(requests[1], "/me/mailFolders/fld-src/messages?$skiptoken=p2", "{requests:?}");
    }

    /// Making `Archive/Clients` on Graph when `Clients` is already under
    /// `Archive` (a re-run): the 409 is resolved among `Archive`'s children,
    /// never by a top-level folder of the same name.
    #[tokio::test(flavor = "multi_thread")]
    async fn graph_folder_made_again_binds_the_child_not_a_top_level_namesake() {
        let child = json!({"value": [{"id": "fld-child", "displayName": "Clients", "totalItemCount": 0, "unreadItemCount": 0, "childFolderCount": 0}]});
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![
            (409, json!({"error": {"code": "ErrorFolderExists"}}).to_string()),
            (200, child.to_string()),
        ]);
        let client = GraphClient::new("tok");
        let mut cache = HashMap::from([("Archive".to_string(), "fld-archive".to_string())]);

        let id = ensure_dest_folder_graph(&client, "Archive/Clients", "/", &mut cache).await;

        let requests: Vec<String> = crate::handlers::graph::test_graph_requests()
            .iter()
            .map(|r| format!("{} {}", r.method, r.path.split('?').next().unwrap_or_default()))
            .collect();
        assert_eq!(id.as_deref(), Ok("fld-child"), "{requests:?}");
        assert_eq!(requests, ["POST /me/mailFolders/fld-archive/childFolders", "GET /me/mailFolders/fld-archive/childFolders"]);
    }
}
