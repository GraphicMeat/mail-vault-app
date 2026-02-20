use serde::Deserialize;
use tracing::info;

use crate::imap::{self, ImapConfig, ImapPool, ImapSession};
use crate::oauth2::OAuth2Manager;
use crate::smtp;

// Helper: run an IMAP operation with a session from the pool.
// On success, the session is returned to the pool. On error, the session is
// logged out to avoid leaking TCP connections.
async fn with_background<F, Fut, T>(
    pool: &ImapPool,
    account: &ImapConfig,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(ImapSession) -> Fut,
    Fut: std::future::Future<Output = Result<(T, ImapSession), String>>,
{
    let session = pool.get_background(account).await?;
    match f(session).await {
        Ok((result, session)) => {
            pool.return_background(account, session).await;
            Ok(result)
        }
        Err(e) => Err(e), // session dropped — pool created a new TCP conn, so nothing to return
    }
}

async fn with_priority<F, Fut, T>(
    pool: &ImapPool,
    account: &ImapConfig,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(ImapSession) -> Fut,
    Fut: std::future::Future<Output = Result<(T, ImapSession), String>>,
{
    let session = pool.get_priority(account).await?;
    match f(session).await {
        Ok((result, session)) => {
            pool.return_priority(account, session).await;
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
        Ok((result, session))
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
    let limit = limit.unwrap_or(50);

    let (emails, total, has_more, skipped_uids) =
        with_background(&pool, &account, |mut session| async move {
            let result = imap::fetch_emails_page(&mut session, &mailbox, page, limit).await
                .map_err(|e| format!("Failed to fetch emails: {}", e))?;
            Ok((result, session))
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
            Ok((result, session))
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

    let (exists, uid_validity, uid_next) =
        with_background(&pool, &account, |mut session| async move {
            let result = imap::check_mailbox_status(&mut session, &mailbox).await?;
            Ok((result, session))
        }).await?;

    Ok(serde_json::json!({
        "exists": exists,
        "uidValidity": uid_validity,
        "uidNext": uid_next
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

    let uids = with_background(&pool, &account, |mut session| async move {
        let result = imap::search_all_uids(&mut session, &mailbox).await?;
        Ok((result, session))
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
        Ok((result, session))
    }).await?;

    Ok(serde_json::json!({
        "emails": emails,
        "total": total
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
        Ok((result, session))
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
) -> Result<serde_json::Value, String> {
    let mailbox = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let mb_clone = mailbox.clone();

    let email = with_priority(&pool, &account, |mut session| async move {
        let result = imap::fetch_email_by_uid_light(&mut session, &mailbox, uid).await
            .map_err(|e| format!("Failed to fetch email: {}", e))?;
        Ok((result, session))
    }).await?;

    match email {
        Some(e) => {
            // Persist the full .eml to Maildir so attachments/rawSource can be loaded on-demand
            use base64::Engine;
            let raw_b64 = base64::engine::general_purpose::STANDARD.encode(&e.raw_source_bytes);
            let account_id = account.email.clone();
            let mb = mb_clone;

            if let Err(err) = crate::maildir_store_raw(
                &app_handle, &account_id, &mb, e.uid, &raw_b64, &[]
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
        Ok(((), session))
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
        Ok(((), session))
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
        Ok((result, session))
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
) -> Result<serde_json::Value, String> {
    let result = oauth.generate_auth_url(email, provider).await?;
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
) -> Result<serde_json::Value, String> {
    let result = oauth.refresh_token(&refresh_token, provider).await?;
    Ok(serde_json::json!({
        "success": true,
        "accessToken": result.access_token,
        "refreshToken": result.refresh_token,
        "expiresAt": result.expires_at
    }))
}
