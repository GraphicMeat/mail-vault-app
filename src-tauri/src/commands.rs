use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tracing::info;

use crate::oauth2::OAuth2Manager;
use crate::backup;

// `with_background`, `with_priority` and `conn_lost_message` moved to the
// daemon (Task 5.4a's `imap_get_email`/`imap_get_email_light`, Task 5.4b's
// remaining eight `imap_*` write/lifecycle commands — `src-daemon/src/
// handlers/imap.rs`), their only callers in this file. `PooledSessionGuard`/
// `ImapPool`/`ImapSession` are no longer imported here for the same reason.

// ── Test connection ─────────────────────────────────────────────────────────
//
// `imap_test_connection` moved to the daemon (Task 5.4b,
// `src-daemon/src/handlers/imap.rs`), same request/response JSON, same 20s
// timeout and timeout message text.

// `smtp_test_connection`, `smtp_build_mime`, `smtp_build_draft_mime` and
// `smtp_send_email` all moved to the daemon (Task 5.5, `src-daemon/src/
// handlers/smtp.rs`), same request/response JSON, routed via `transport.js`'s
// `DAEMON_OWNED` under their existing flat names — this was this file's last
// IMAP caller (`smtp_send_email`'s background Sent-folder APPEND used a
// dedicated `imap::create_imap_session_no_compress` session, never the app's
// pool) and last SMTP caller, so `use crate::imap::{self, ImapConfig}` and
// `use crate::smtp` are both gone from this file along with them.
// `smtp_send_email`'s `send-server-append-complete` event now goes through
// the daemon's own `EventBus` (`state.events.emit(...)`) instead of
// `app_handle.emit(...)` — `src-tauri/src/daemon_channel.rs` already
// re-emits any named daemon event to the frontend unchanged, so `Emitter` is
// no longer imported here either.

// ── List mailboxes ──────────────────────────────────────────────────────────

// `imap_get_mailboxes`, `imap_get_emails`, `imap_check_mailbox_status`,
// `imap_folder_status`, `imap_search_all_uids`, `imap_fetch_headers_by_uids`,
// `imap_fetch_changed_flags`, `imap_get_email` and `imap_get_email_light` all
// moved to the daemon (Task 5.4a, `src-daemon/src/handlers/imap.rs`), same
// request/response JSON, routed via `transport.js`'s `DAEMON_OWNED` under
// their existing names. `imap_get_email_light`'s auto-cache-to-vault side
// effect moved with it (now writing the already-in-memory bytes directly,
// no base64 round trip). `BODY_FETCH_TIMEOUT` moved with it too.

// `imap_set_flags`, `imap_delete_email`, `imap_ensure_sent_mailbox`,
// `imap_create_mailbox`, `imap_rename_mailbox` and `imap_delete_mailbox` all
// moved to the daemon (Task 5.4b, `src-daemon/src/handlers/imap.rs`), same
// request/response JSON, routed via `transport.js`'s `DAEMON_OWNED` under
// their existing names. `imap_ensure_sent_mailbox` still returns a bare
// string, not an object — matches its old `Result<String, String>`.

// `imap_search_emails` + its local `SearchFilters` moved to the daemon (Task
// 5.4a, `src-daemon/src/handlers/imap.rs`), same request/response JSON.

// `imap_find_message_id` and `imap_disconnect` moved to the daemon (Task
// 5.4b, `src-daemon/src/handlers/imap.rs`), same request/response JSON —
// `imap_find_message_id`'s reply is still the bare serialized probe struct,
// not wrapped in an object.

// ── OAuth2: Generate auth URL ───────────────────────────────────────────────

#[tauri::command]
pub async fn oauth2_auth_url(
    oauth: tauri::State<'_, OAuth2Manager>,
    email: Option<String>,
    provider: Option<String>,
    custom_client_id: Option<String>,
    tenant_id: Option<String>,
    use_graph: Option<bool>,
) -> Result<serde_json::Value, String> {
    let result = oauth.generate_auth_url(email, provider, custom_client_id, tenant_id, use_graph.unwrap_or(false)).await?;
    Ok(serde_json::json!({
        "success": true,
        "authUrl": result.auth_url,
        "state": result.state
    }))
}

// ── OAuth2: Exchange code for tokens ────────────────────────────────────────

#[tauri::command]
pub async fn oauth2_exchange(
    oauth: tauri::State<'_, OAuth2Manager>,
    state: String,
) -> Result<serde_json::Value, String> {
    let result = oauth.exchange_code(&state).await?;
    Ok(serde_json::json!({
        "success": true,
        "accessToken": result.access_token,
        "refreshToken": result.refresh_token,
        "expiresAt": result.expires_at
    }))
}

// ── OAuth2: Refresh token ───────────────────────────────────────────────────

#[tauri::command]
pub async fn oauth2_refresh(
    oauth: tauri::State<'_, OAuth2Manager>,
    refresh_token: String,
    provider: Option<String>,
    custom_client_id: Option<String>,
    tenant_id: Option<String>,
    use_graph: Option<bool>,
) -> Result<serde_json::Value, String> {
    let result = oauth.refresh_token(&refresh_token, provider, custom_client_id, tenant_id, use_graph.unwrap_or(false)).await?;
    Ok(serde_json::json!({
        "success": true,
        "accessToken": result.access_token,
        "refreshToken": result.refresh_token,
        "expiresAt": result.expires_at
    }))
}

// ── Graph API: List folders ─────────────────────────────────────────────────

#[tauri::command]
pub async fn graph_list_folders(access_token: String) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let folders = client.list_folders().await?;
    serde_json::to_value(&folders).map_err(|e| e.to_string())
}

// ── Graph API: List messages (paginated) ────────────────────────────────────

#[tauri::command]
pub async fn graph_list_messages(
    access_token: String,
    folder_id: String,
    top: u32,
    skip: u32,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let (messages, next_link) = client.list_messages(&folder_id, top, skip).await?;
    // The uid here is provisional — the message's position in a
    // `receivedDateTime desc` listing, which moves every time mail arrives or
    // leaves. It is not an identifier and nothing may persist by it.
    // cacheManager.listGraphMessages replaces it with an allocated uid before
    // any caller sees these rows, and is the only supported way to read this
    // command; the pairing with `graphMessageIds` below is what makes that
    // possible, so the two arrays must stay the same length and order.
    let headers: Vec<_> = messages
        .iter()
        .enumerate()
        .map(|(i, m)| m.to_email_header((skip + i as u32 + 1) as u32))
        .collect();
    // Also return Graph message IDs so frontend can map UIDs to Graph IDs for body fetches
    let graph_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    Ok(serde_json::json!({
        "headers": headers,
        "nextLink": next_link,
        "graphMessageIds": graph_ids,
    }))
}

// ── Graph API: Get single message ───────────────────────────────────────────

#[tauri::command]
pub async fn graph_get_message(
    access_token: String,
    message_id: String,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let msg = client.get_message(&message_id).await?;
    serde_json::to_value(&msg).map_err(|e| e.to_string())
}

// ── Graph API: Get MIME content (.eml) ──────────────────────────────────────

#[tauri::command]
pub async fn graph_get_mime(
    access_token: String,
    message_id: String,
) -> Result<Vec<u8>, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.get_mime_content(&message_id).await
}

// ── Graph API: Fetch MIME, cache to Maildir, return light email ─────────────

#[tauri::command]
pub async fn graph_cache_mime(
    app_handle: tauri::AppHandle,
    access_token: String,
    message_id: String,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let raw_bytes = client.get_mime_content(&message_id).await?;

    // Save to Maildir
    let cur_dir = crate::maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    std::fs::create_dir_all(&cur_dir)
        .map_err(|e| format!("Failed to create Maildir directory: {}", e))?;

    if crate::find_file_by_uid(&cur_dir, uid).is_none() {
        let filename = crate::build_maildir_filename(uid, &[] as &[String]);
        let file_path = cur_dir.join(&filename);
        std::fs::write(&file_path, &raw_bytes)
            .map_err(|e| format!("Failed to write .eml file: {}", e))?;
        info!("Graph: cached UID {} to {:?} ({} bytes)", uid, file_path, raw_bytes.len());
        crate::nudge_index(&account_id, &mailbox);
    }

    // Parse the .eml to return light email data
    let email = crate::parse_eml_bytes_light(&raw_bytes, uid, vec![])?;

    Ok(serde_json::json!({
        "success": true,
        "email": email
    }))
}

// ── Graph API: Set read status ──────────────────────────────────────────────

#[tauri::command]
pub async fn graph_set_read(
    access_token: String,
    message_id: String,
    is_read: bool,
) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.set_read_status(&message_id, is_read).await
}

// ── Graph API: Set the flag (our star) ──────────────────────────────────────

#[tauri::command]
pub async fn graph_set_flagged(
    access_token: String,
    message_id: String,
    flagged: bool,
) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.set_flag_status(&message_id, flagged).await
}

#[tauri::command]
pub async fn graph_delete_message(
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.delete_message(&message_id).await
}

// ── Graph API: Move emails to folder ─────────────────────────────────────

#[tauri::command]
pub async fn graph_move_emails(
    access_token: String,
    message_ids: Vec<String>,
    target_folder_id: String,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let mut moved = 0u32;

    for msg_id in &message_ids {
        client.move_message(msg_id, &target_folder_id).await?;
        moved += 1;
    }

    Ok(serde_json::json!({
        "success": true,
        "moved": moved
    }))
}

// ── Graph API: Folder management ─────────────────────────────────────────

#[tauri::command]
pub async fn graph_create_folder(
    access_token: String,
    display_name: String,
    parent_folder_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let folder = client
        .create_folder(&display_name, parent_folder_id.as_deref())
        .await?;
    serde_json::to_value(&folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn graph_rename_folder(
    access_token: String,
    folder_id: String,
    display_name: String,
) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.rename_folder(&folder_id, &display_name).await
}

#[tauri::command]
pub async fn graph_move_folder(
    access_token: String,
    folder_id: String,
    destination_id: String,
) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.move_folder(&folder_id, &destination_id).await
}

#[tauri::command]
pub async fn graph_delete_folder(access_token: String, folder_id: String) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.delete_folder(&folder_id).await
}

// `imap_move_emails` moved to the daemon (Task 5.4b,
// `src-daemon/src/handlers/imap.rs`), same request/response JSON.

// ── DNS: Resolve email server settings ───────────────────────────────────

#[tauri::command]
pub async fn resolve_email_settings(domain: String) -> Result<serde_json::Value, String> {
    let settings = crate::dns::resolve_email_settings(&domain).await?;
    serde_json::to_value(settings).map_err(|e| format!("Serialization error: {}", e))
}

#[tauri::command]
pub async fn dns_mail_health(
    domain: String,
    new_imap_host: Option<String>,
) -> Result<serde_json::Value, String> {
    let health = crate::dns::mail_dns_health(&domain, new_imap_host.as_deref()).await?;
    serde_json::to_value(health).map_err(|e| format!("Serialization error: {}", e))
}

// ── Backup: Run account backup ───────────────────────────────────────────

#[tauri::command]
pub async fn backup_run_account(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    backup_path: Option<String>,
    skip_folders: Option<usize>,
    cancel_token: tauri::State<'_, backup::BackupCancelToken>,
) -> Result<backup::BackupResult, String> {
    let cancel = {
        let mut guard = cancel_token.0.lock().unwrap();
        let fresh = Arc::new(AtomicBool::new(false));
        *guard = Arc::clone(&fresh);
        fresh
    };
    backup::run_account_backup(app_handle, account_id, account_json, cancel, backup_path, skip_folders.unwrap_or(0)).await
}

#[tauri::command]
pub async fn backup_status(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    backup_path: Option<String>,
) -> Result<backup::AccountBackupStatus, String> {
    backup::get_backup_status(app_handle, account_id, account_json, backup_path).await
}

#[tauri::command]
pub async fn backup_cancel(
    cancel_token: tauri::State<'_, backup::BackupCancelToken>,
) -> Result<(), String> {
    let guard = cancel_token.0.lock().unwrap();
    guard.store(true, Ordering::Relaxed);
    Ok(())
}

// ── External backup location ─────────────────────────────────────────────

#[tauri::command]
pub async fn backup_save_external_location(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<crate::external_location::ExternalLocation, String> {
    // MAS builds gate external backups behind a non-consumable IAP. Non-MAS
    // builds always pass this check (stub returns true).
    if !crate::iap::is_entitled("com.mailvault.app.backups") {
        return Err("Cloud Backups requires a one-time in-app purchase. Open Settings → Backups to unlock.".to_string());
    }
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::save_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP, &path)
}

#[tauri::command]
pub async fn backup_get_external_location(
    app_handle: tauri::AppHandle,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::external_location::get_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP))
}

#[tauri::command]
pub async fn backup_validate_external_location(
    app_handle: tauri::AppHandle,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::validate_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP)
}

#[tauri::command]
pub async fn backup_clear_external_location(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::clear_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP)
}

// ── In-app purchase (StoreKit on MAS, no-op stub elsewhere) ──────────────

/// Whether the given product is entitled. Non-MAS builds always return true.
#[tauri::command]
pub fn iap_is_entitled(product_id: String) -> bool {
    crate::iap::is_entitled(&product_id)
}

/// Start a StoreKit purchase. Resolves once the transaction completes.
/// On non-MAS builds this succeeds immediately (no paywall).
#[tauri::command]
pub async fn iap_purchase(product_id: String) -> Result<(), String> {
    crate::iap::purchase(&product_id).await
}

/// Restore prior non-consumable purchases for the signed-in Apple ID.
#[tauri::command]
pub async fn iap_restore() -> Result<(), String> {
    crate::iap::restore().await
}

#[tauri::command]
pub async fn backup_resolve_external_location(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    match crate::external_location::resolve_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP) {
        Ok((resolved_path, loc)) => Ok(serde_json::json!({
            "resolvedPath": resolved_path,
            "location": loc,
        })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn backup_migrate_legacy_path(
    app_handle: tauri::AppHandle,
    legacy_path: String,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::migrate_legacy_path(&data_dir, &legacy_path)
}

// ── Transfer stats ──────────────────────────────────────────────────────────

/// Per-account wire bytes: the app's and the daemon's own stat files merged,
/// plus this process's not-yet-flushed counters. Optional `accountId` narrows
/// the result to one account.
#[tauri::command]
pub fn get_transfer_stats(
    app_handle: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;

    let mut accounts = mailvault_core::transfer_stats::read_all(&app_dir);
    if let Some(id) = account_id {
        accounts.retain(|k, _| *k == id);
    }
    serde_json::to_value(serde_json::json!({ "accounts": accounts }))
        .map_err(|e| format!("Serialization error: {}", e))
}
