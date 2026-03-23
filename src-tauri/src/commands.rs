use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::Deserialize;
use tracing::info;

use crate::imap::pool::PooledSessionGuard;
use crate::imap::{self, ImapConfig, ImapPool, ImapSession};
use crate::oauth2::OAuth2Manager;
use crate::smtp;
use crate::backup;
use crate::migration;

// Helper: run an IMAP operation with a session from the pool.
// On success, the session is returned to the pool with its last-selected mailbox.
// On error, the session guard is dropped (semaphore permit released, pool creates new next time).
async fn with_background<F, Fut, T>(
    pool: &ImapPool,
    account: &ImapConfig,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(ImapSession) -> Fut,
    Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
{
    let PooledSessionGuard { session, last_selected: _, _permit } =
        pool.get_background(account).await?;
    match f(session).await {
        Ok((result, session, selected_mailbox)) => {
            let return_guard = PooledSessionGuard {
                session,
                last_selected: selected_mailbox,
                _permit,
            };
            pool.return_background(account, return_guard).await;
            Ok(result)
        }
        Err(e) => Err(e), // _permit dropped here — semaphore released
    }
}

async fn with_priority<F, Fut, T>(
    pool: &ImapPool,
    account: &ImapConfig,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(ImapSession) -> Fut,
    Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
{
    let PooledSessionGuard { session, last_selected: _, _permit } =
        pool.get_priority(account).await?;
    match f(session).await {
        Ok((result, session, selected_mailbox)) => {
            let return_guard = PooledSessionGuard {
                session,
                last_selected: selected_mailbox,
                _permit,
            };
            pool.return_priority(account, return_guard).await;
            Ok(result)
        }
        Err(e) => Err(e),
    }
}

// ── Test connection ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_test_connection(account: ImapConfig) -> Result<serde_json::Value, String> {
    info!(
        "[test-connection] Testing {} → {}:{}",
        account.email,
        account.host,
        account.effective_port()
    );

    // Wrap entire test in a 20s timeout — auth/TLS steps have no individual timeout
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        imap::test_connection(&account),
    )
    .await
    .map_err(|_| format!("Connection test timed out for {}", account.email))?
    ?;

    Ok(serde_json::json!({
        "success": true,
        "message": "Connection successful"
    }))
}

// ── List mailboxes ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_get_mailboxes(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
) -> Result<serde_json::Value, String> {
    let mailboxes = with_background(&pool, &account, |mut session| async move {
        let result = imap::list_mailboxes(&mut session).await
            .map_err(|e| format!("Failed to fetch mailboxes: {}", e))?;
        Ok((result, session, None))
    }).await?;

    Ok(serde_json::json!({
        "success": true,
        "mailboxes": mailboxes
    }))
}

// ── Fetch emails (paginated) ────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_get_emails(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
    page: Option<u32>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let page = page.unwrap_or(1);
    let limit = limit.unwrap_or(200);

    let (emails, total, has_more, skipped_uids) =
        with_background(&pool, &account, |mut session| async move {
            let result = imap::fetch_emails_page(&mut session, &mailbox, page, limit).await
                .map_err(|e| format!("Failed to fetch emails: {}", e))?;
            Ok((result, session, Some(mailbox)))
        }).await?;

    Ok(serde_json::json!({
        "success": true,
        "emails": emails,
        "total": total,
        "page": page,
        "limit": limit,
        "hasMore": has_more,
        "skippedUids": skipped_uids
    }))
}

// ── Fetch emails by index range ─────────────────────────────────────────────

#[tauri::command]
pub async fn imap_get_emails_range(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
    start_index: Option<u32>,
    end_index: Option<u32>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let start = start_index.unwrap_or(0);
    let end = end_index.unwrap_or(50);

    let (emails, total, skipped_uids) =
        with_background(&pool, &account, |mut session| async move {
            let result = imap::fetch_emails_range(&mut session, &mailbox, start, end).await
                .map_err(|e| format!("Failed to fetch emails range: {}", e))?;
            Ok((result, session, Some(mailbox)))
        }).await?;

    Ok(serde_json::json!({
        "success": true,
        "emails": emails,
        "total": total,
        "startIndex": start,
        "endIndex": end,
        "skippedUids": skipped_uids
    }))
}

// ── Check mailbox status (delta-sync) ───────────────────────────────────

#[tauri::command]
pub async fn imap_check_mailbox_status(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let has_condstore = pool.has_capability(&account, "CONDSTORE").await;

    let (exists, uid_validity, uid_next, highest_modseq) =
        with_background(&pool, &account, |mut session| async move {
            let result = imap::check_mailbox_status(&mut session, &mailbox, has_condstore).await?;
            Ok((result, session, Some(mailbox)))
        }).await?;

    Ok(serde_json::json!({
        "exists": exists,
        "uidValidity": uid_validity,
        "uidNext": uid_next,
        "highestModseq": highest_modseq
    }))
}

// ── Search all UIDs (delta-sync) ────────────────────────────────────────

#[tauri::command]
pub async fn imap_search_all_uids(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let has_esearch = pool.has_capability(&account, "ESEARCH").await;

    let uids = with_background(&pool, &account, |mut session| async move {
        let result = imap::search_all_uids(&mut session, &mailbox, has_esearch).await?;
        Ok((result, session, Some(mailbox)))
    }).await?;

    Ok(serde_json::json!({
        "uids": uids
    }))
}

// ── Fetch headers by UIDs (delta-sync) ──────────────────────────────────

#[tauri::command]
pub async fn imap_fetch_headers_by_uids(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
    uids: Vec<u32>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());

    let (emails, total) = with_background(&pool, &account, |mut session| async move {
        let result = imap::fetch_headers_by_uids(&mut session, &mailbox, &uids).await?;
        Ok((result, session, Some(mailbox)))
    }).await?;

    Ok(serde_json::json!({
        "emails": emails,
        "total": total
    }))
}

// ── Fetch changed flags (CONDSTORE) ─────────────────────────────────────

#[tauri::command]
pub async fn imap_fetch_changed_flags(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
    since_modseq: u64,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());

    let changed = with_background(&pool, &account, |mut session| async move {
        let result = imap::fetch_changed_flags(&mut session, &mailbox, since_modseq).await?;
        Ok((result, session, Some(mailbox)))
    }).await?;

    // Convert to JSON-friendly format
    let changes: Vec<serde_json::Value> = changed
        .into_iter()
        .map(|(uid, flags)| serde_json::json!({ "uid": uid, "flags": flags }))
        .collect();

    Ok(serde_json::json!({
        "changes": changes
    }))
}

// ── Fetch single email ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_get_email(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    uid: u32,
    mailbox: Option<String>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());

    let email = with_priority(&pool, &account, |mut session| async move {
        let result = imap::fetch_email_by_uid(&mut session, &mailbox, uid).await
            .map_err(|e| format!("Failed to fetch email: {}", e))?;
        Ok((result, session, Some(mailbox)))
    }).await?;

    match email {
        Some(e) => Ok(serde_json::json!({
            "success": true,
            "email": e
        })),
        None => Err("Email not found".to_string()),
    }
}

// ── Fetch single email (light — no attachment binaries, no rawSource) ──

#[tauri::command]
pub async fn imap_get_email_light(
    app_handle: tauri::AppHandle,
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    uid: u32,
    mailbox: Option<String>,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let mb_clone = mailbox.clone();

    let email = with_priority(&pool, &account, |mut session| async move {
        let result = imap::fetch_email_by_uid_light(&mut session, &mailbox, uid).await
            .map_err(|e| format!("Failed to fetch email: {}", e))?;
        Ok((result, session, Some(mailbox)))
    }).await?;

    match email {
        Some(e) => {
            // Persist the full .eml to Maildir so attachments/rawSource can be loaded on-demand
            use base64::Engine;
            let raw_b64 = base64::engine::general_purpose::STANDARD.encode(&e.raw_source_bytes);
            let aid = account_id.unwrap_or_else(|| account.email.clone());
            let mb = mb_clone;

            if let Err(err) = crate::maildir_store_raw(
                &app_handle, &aid, &mb, e.uid, &raw_b64, &[]
            ) {
                tracing::warn!("Failed to auto-cache .eml for UID {}: {}", e.uid, err);
            }

            Ok(serde_json::json!({
                "success": true,
                "email": e
            }))
        }
        None => Err("Email not found".to_string()),
    }
}

// ── Set flags ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_set_flags(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    uid: u32,
    mailbox: Option<String>,
    flags: Vec<String>,
    action: Option<String>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let action = action.unwrap_or_else(|| "add".to_string());

    with_priority(&pool, &account, |mut session| async move {
        imap::set_flags(&mut session, &mailbox, uid, &flags, &action).await
            .map_err(|e| format!("Failed to update flags: {}", e))?;
        Ok(((), session, Some(mailbox)))
    }).await?;

    Ok(serde_json::json!({ "success": true }))
}

// ── Delete email ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_delete_email(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    uid: u32,
    mailbox: Option<String>,
    permanent: Option<bool>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let permanent = permanent.unwrap_or(false);

    with_priority(&pool, &account, |mut session| async move {
        imap::delete_email(&mut session, &mailbox, uid, permanent).await
            .map_err(|e| format!("Failed to delete email: {}", e))?;
        Ok(((), session, Some(mailbox)))
    }).await?;

    Ok(serde_json::json!({ "success": true }))
}

// ── Fetch raw email (RFC 5322) ──────────────────────────────────────────────

#[tauri::command]
pub async fn imap_fetch_raw(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    uid: u32,
    mailbox: Option<String>,
) -> Result<String, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());

    let raw = with_priority(&pool, &account, |mut session| async move {
        let _mbox = imap::select_mailbox(&mut session, &mailbox).await?;
        let fetch_stream = session
            .uid_fetch(uid.to_string(), "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH raw failed: {}", e))?;

        use futures::StreamExt;
        let fetches: Vec<_> = fetch_stream.collect::<Vec<_>>().await
            .into_iter().filter_map(|r| r.ok()).collect();

        let body = fetches.first()
            .and_then(|f| f.body())
            .ok_or_else(|| "No body in FETCH response".to_string())?;

        let raw_str = String::from_utf8_lossy(body).to_string();
        Ok((raw_str, session, Some(mailbox)))
    }).await?;

    Ok(raw)
}

// ── Append email (IMAP APPEND) ─────────────────────────────────────────────

#[tauri::command]
pub async fn imap_append_email(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: String,
    raw_email: String,
    flags: Option<String>,
) -> Result<serde_json::Value, String> {
    let flags_str = flags.unwrap_or_default();

    with_priority(&pool, &account, |mut session| async move {
        imap::append_email(&mut session, &mailbox, raw_email.as_bytes(), &flags_str).await
            .map_err(|e| format!("Failed to append email: {}", e))?;
        Ok(((), session, Some(mailbox)))
    }).await?;

    Ok(serde_json::json!({ "success": true }))
}

// ── Send email ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn smtp_send_email(
    account: ImapConfig,
    email: smtp::OutgoingEmail,
) -> Result<serde_json::Value, String> {
    let message_id = smtp::send_email(&account, &email).await?;

    Ok(serde_json::json!({
        "success": true,
        "messageId": message_id
    }))
}

// ── Search emails ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SearchFilters {
    pub from: Option<String>,
    pub subject: Option<String>,
    pub since: Option<String>,
    pub before: Option<String>,
}

#[tauri::command]
pub async fn imap_search_emails(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    mailbox: Option<String>,
    query: Option<String>,
    filters: Option<SearchFilters>,
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let filters = filters.unwrap_or(SearchFilters {
        from: None,
        subject: None,
        since: None,
        before: None,
    });

    let (emails, total) = with_background(&pool, &account, |mut session| async move {
        let result = imap::search_emails(
            &mut session,
            &mailbox,
            query.as_deref(),
            filters.from.as_deref(),
            filters.subject.as_deref(),
            filters.since.as_deref(),
            filters.before.as_deref(),
        ).await.map_err(|e| format!("Failed to search emails: {}", e))?;
        Ok((result, session, Some(mailbox)))
    }).await?;

    Ok(serde_json::json!({
        "success": true,
        "emails": emails,
        "total": total
    }))
}

// ── Disconnect ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn imap_disconnect(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
) -> Result<serde_json::Value, String> {
    pool.disconnect(&account).await;
    Ok(serde_json::json!({ "success": true }))
}

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

// ── Move emails between folders ──────────────────────────────────────────

#[tauri::command]
pub async fn imap_move_emails(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    uids: Vec<u32>,
    source_mailbox: String,
    target_mailbox: String,
) -> Result<serde_json::Value, String> {
    let has_move = pool.has_capability(&account, "MOVE").await;

    let moved = with_priority(&pool, &account, |mut session| async move {
        let result = crate::move_emails::move_emails(
            &mut session,
            &source_mailbox,
            &target_mailbox,
            &uids,
            has_move,
        )
        .await?;
        Ok((result, session, Some(source_mailbox)))
    })
    .await?;

    Ok(serde_json::json!({
        "success": true,
        "moved": moved
    }))
}

// ── DNS: Resolve email server settings ───────────────────────────────────

#[tauri::command]
pub async fn resolve_email_settings(domain: String) -> Result<serde_json::Value, String> {
    let settings = crate::dns::resolve_email_settings(&domain).await?;
    serde_json::to_value(settings).map_err(|e| format!("Serialization error: {}", e))
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

// ── Migration ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_migration(
    app_handle: tauri::AppHandle,
    source_account: String,
    dest_account: String,
    source_transport: String,
    dest_transport: String,
    folder_mappings: Vec<migration::FolderMapping>,
    include_local_archive: Option<bool>,
    cancel_token: tauri::State<'_, migration::MigrationCancelToken>,
    pause_token: tauri::State<'_, migration::MigrationPauseToken>,
    notify_token: tauri::State<'_, migration::MigrationNotify>,
) -> Result<(), String> {
    let source_config: ImapConfig = serde_json::from_str(&source_account)
        .map_err(|e| format!("Bad source account JSON: {}", e))?;
    let dest_config: ImapConfig = serde_json::from_str(&dest_account)
        .map_err(|e| format!("Bad dest account JSON: {}", e))?;

    let _include_local = include_local_archive.unwrap_or(false);
    tracing::info!("[migration] start_migration command received (include_local_archive={})", _include_local);
    // Reset cancel and pause to false
    let cancel = {
        let mut guard = cancel_token.0.lock().unwrap();
        let fresh = Arc::new(AtomicBool::new(false));
        *guard = Arc::clone(&fresh);
        fresh
    };
    let pause = {
        let mut guard = pause_token.0.lock().unwrap();
        let fresh = Arc::new(AtomicBool::new(false));
        *guard = Arc::clone(&fresh);
        fresh
    };
    let notify = {
        let mut guard = notify_token.0.lock().unwrap();
        let fresh = Arc::new(tokio::sync::Notify::new());
        *guard = Arc::clone(&fresh);
        fresh
    };
    tracing::info!("[migration] tokens created: cancel={:p}, pause={:p}, notify={:p}", &*cancel, &*pause, &*notify);

    let src_json = source_account.clone();
    let dst_json = dest_account.clone();

    tokio::spawn(async move {
        let result = migration::run_migration(
            app_handle,
            source_config,
            dest_config,
            source_transport,
            dest_transport,
            src_json,
            dst_json,
            folder_mappings,
            cancel,
            pause,
            notify,
        )
        .await;
        if let Err(e) = result {
            tracing::error!("[migration] run_migration failed: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_migration(
    cancel_token: tauri::State<'_, migration::MigrationCancelToken>,
    notify_token: tauri::State<'_, migration::MigrationNotify>,
) -> Result<(), String> {
    let guard = cancel_token.0.lock().unwrap();
    tracing::info!("[migration] cancel_migration command received, token={:p}", &*guard);
    guard.store(true, Ordering::SeqCst);
    drop(guard);
    tracing::info!("[migration] cancel flag set to true, notifying waiters");
    let notify = notify_token.0.lock().unwrap();
    notify.notify_waiters();
    tracing::info!("[migration] cancel_migration: waiters notified");
    Ok(())
}

#[tauri::command]
pub async fn pause_migration(
    pause_token: tauri::State<'_, migration::MigrationPauseToken>,
    notify_token: tauri::State<'_, migration::MigrationNotify>,
) -> Result<(), String> {
    let guard = pause_token.0.lock().unwrap();
    tracing::info!("[migration] pause_migration command received, token={:p}", &*guard);
    guard.store(true, Ordering::SeqCst);
    drop(guard);
    tracing::info!("[migration] pause flag set to true, notifying waiters");
    let notify = notify_token.0.lock().unwrap();
    notify.notify_waiters();
    tracing::info!("[migration] pause_migration: waiters notified");
    Ok(())
}

#[tauri::command]
pub async fn resume_migration(
    app_handle: tauri::AppHandle,
    source_account: String,
    dest_account: String,
    source_transport: String,
    dest_transport: String,
    cancel_token: tauri::State<'_, migration::MigrationCancelToken>,
    pause_token: tauri::State<'_, migration::MigrationPauseToken>,
    notify_token: tauri::State<'_, migration::MigrationNotify>,
) -> Result<(), String> {
    let state = migration::load_migration_state(&app_handle)?
        .ok_or("No migration state found to resume")?;

    let source_config: ImapConfig = serde_json::from_str(&source_account)
        .map_err(|e| format!("Bad source account JSON: {}", e))?;
    let dest_config: ImapConfig = serde_json::from_str(&dest_account)
        .map_err(|e| format!("Bad dest account JSON: {}", e))?;

    // Reset pause and cancel to false
    let cancel = {
        let mut guard = cancel_token.0.lock().unwrap();
        let fresh = Arc::new(AtomicBool::new(false));
        *guard = Arc::clone(&fresh);
        fresh
    };
    let pause = {
        let mut guard = pause_token.0.lock().unwrap();
        let fresh = Arc::new(AtomicBool::new(false));
        *guard = Arc::clone(&fresh);
        fresh
    };
    let notify = {
        let mut guard = notify_token.0.lock().unwrap();
        let fresh = Arc::new(tokio::sync::Notify::new());
        *guard = Arc::clone(&fresh);
        fresh
    };

    // Filter out completed folders
    let remaining: Vec<migration::FolderMapping> = state
        .folder_mappings
        .into_iter()
        .filter(|f| f.status != "completed")
        .collect();

    let src_json = source_account.clone();
    let dst_json = dest_account.clone();

    tokio::spawn(async move {
        let result = migration::run_migration(
            app_handle,
            source_config,
            dest_config,
            source_transport,
            dest_transport,
            src_json,
            dst_json,
            remaining,
            cancel,
            pause,
            notify,
        )
        .await;
        if let Err(e) = result {
            tracing::error!("[migration] resume failed: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn get_migration_state(
    app_handle: tauri::AppHandle,
) -> Result<Option<migration::MigrationState>, String> {
    migration::load_migration_state(&app_handle)
}

#[tauri::command]
pub async fn clear_migration_state_cmd(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    migration::clear_migration_state(&app_handle)
}

#[tauri::command]
pub async fn count_migration_folders(
    app_handle: tauri::AppHandle,
    source_account: String,
    source_transport: String,
    folder_mappings: Vec<migration::FolderMapping>,
) -> Result<(), String> {
    let source_config: ImapConfig = serde_json::from_str(&source_account)
        .map_err(|e| format!("Bad source account JSON: {}", e))?;

    tokio::spawn(async move {
        if let Err(e) = migration::count_migration_folders(
            app_handle, source_config, source_transport, folder_mappings,
        ).await {
            tracing::error!("[migration] count_migration_folders failed: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn get_folder_mappings(
    pool: tauri::State<'_, ImapPool>,
    source_account: String,
    dest_account: String,
    source_transport: String,
    dest_transport: String,
) -> Result<Vec<migration::FolderMapping>, String> {
    let source_config: ImapConfig = serde_json::from_str(&source_account)
        .map_err(|e| format!("Bad source account JSON: {}", e))?;
    let dest_config: ImapConfig = serde_json::from_str(&dest_account)
        .map_err(|e| format!("Bad dest account JSON: {}", e))?;

    // Get source folders
    let source_folders = if source_transport == "graph" {
        if let Some(ref token) = source_config.access_token {
            let client = crate::graph::GraphClient::new(token);
            let graph_folders = client.list_folders().await?;
            graph_folders
                .into_iter()
                .map(|f| crate::imap::MailboxInfo {
                    name: f.display_name.clone(),
                    path: f.display_name,
                    special_use: None,
                    flags: Vec::new(),
                    delimiter: Some("/".to_string()),
                    noselect: false,
                    children: Vec::new(),
                })
                .collect()
        } else {
            return Err("No source access token for Graph".to_string());
        }
    } else {
        with_background(&pool, &source_config, |mut session| async move {
            let result = imap::list_mailboxes(&mut session).await?;
            Ok((result, session, None))
        })
        .await?
    };

    // Get destination folders
    let dest_folders = if dest_transport == "graph" {
        if let Some(ref token) = dest_config.access_token {
            let client = crate::graph::GraphClient::new(token);
            let graph_folders = client.list_folders().await?;
            graph_folders
                .into_iter()
                .map(|f| crate::imap::MailboxInfo {
                    name: f.display_name.clone(),
                    path: f.display_name,
                    special_use: None,
                    flags: Vec::new(),
                    delimiter: Some("/".to_string()),
                    noselect: false,
                    children: Vec::new(),
                })
                .collect()
        } else {
            return Err("No dest access token for Graph".to_string());
        }
    } else {
        with_background(&pool, &dest_config, |mut session| async move {
            let result = imap::list_mailboxes(&mut session).await?;
            Ok((result, session, None))
        })
        .await?
    };

    // Extract delimiters
    let src_delim = source_folders
        .first()
        .and_then(|f| f.delimiter.as_deref())
        .unwrap_or("/");
    let dst_delim = dest_folders
        .first()
        .and_then(|f| f.delimiter.as_deref())
        .unwrap_or("/");

    let mappings =
        migration::build_folder_mappings(&source_folders, &dest_folders, Some(src_delim), Some(dst_delim));

    Ok(mappings)
}
