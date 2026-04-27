use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::Deserialize;
use tauri::{Emitter, Manager};
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

    info!(
        "[CMD] imap_get_mailboxes: {} mailboxes returned for {}",
        mailboxes.len(),
        account.email
    );

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

// ── Ensure Sent mailbox (auto-create if missing) ──────────────────────────
//
// Tiered Sent-folder resolution for IMAP accounts whose server does not
// advertise SPECIAL-USE and whose Sent folder name doesn't match our
// heuristics. Falls back to CREATE "Sent" (Thunderbird-style lazy creation)
// so the user never has to configure it manually for generic IMAP.

#[tauri::command]
pub async fn imap_ensure_sent_mailbox(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
) -> Result<String, String> {
    with_background(&pool, &account, |mut session| async move {
        let path = imap::ensure_sent_mailbox(&mut session).await?;
        Ok((path, session, None))
    }).await
}

#[tauri::command]
pub async fn imap_ensure_drafts_mailbox(
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
) -> Result<String, String> {
    with_background(&pool, &account, |mut session| async move {
        let path = imap::ensure_drafts_mailbox(&mut session).await?;
        Ok((path, session, None))
    }).await
}

/// Build the RFC2822 MIME bytes for an outgoing email WITHOUT sending.
/// Used by the JS compose flow so it can write the raw .eml to the local
/// Maildir archive BEFORE SMTP submission (and replace the on-disk copy with
/// a sent-state version after SMTP succeeds).
#[tauri::command]
pub async fn smtp_build_mime(
    account: ImapConfig,
    email: smtp::OutgoingEmail,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let built = smtp::build_mime(&account, &email)?;
    let raw_base64 = base64::engine::general_purpose::STANDARD.encode(&built.raw_rfc2822);

    // Extract Message-ID header from raw bytes for later server-side dedupe.
    let message_id = {
        let text = String::from_utf8_lossy(&built.raw_rfc2822);
        text.lines()
            .take_while(|line| !line.is_empty())
            .find(|line| line.to_lowercase().starts_with("message-id:"))
            .map(|line| line.splitn(2, ':').nth(1).unwrap_or("").trim().trim_matches(|c| c == '<' || c == '>').to_string())
            .filter(|s| !s.is_empty())
    };

    tracing::info!(
        "[send:build_mime] account={} bytes={} messageId={:?}",
        account.email, built.raw_rfc2822.len(), message_id
    );

    Ok(serde_json::json!({
        "rawBase64": raw_base64,
        "messageId": message_id,
        "rawSize": built.raw_rfc2822.len(),
    }))
}

// ── Send email ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn smtp_send_email(
    app_handle: tauri::AppHandle,
    pool: tauri::State<'_, ImapPool>,
    account: ImapConfig,
    email: smtp::OutgoingEmail,
    #[allow(unused)] sent_mailbox: Option<String>,
) -> Result<serde_json::Value, String> {
    // Flow: local Maildir archive is handled by the JS side BEFORE and AFTER
    // this call (see ComposeModal.sendFn). This command only submits via SMTP
    // and best-effort appends to the server Sent folder in the background.
    //
    // Structured logging uses `[send]` prefix so step-by-step grep is trivial.

    let account_id_for_log = account.email.clone();
    tracing::info!("[send:smtp_start] account={} recipient={}", account_id_for_log, email.to);

    let result = smtp::send_email(&account, &email).await
        .map_err(|e| {
            tracing::error!("[send:smtp_fail] account={} error={}", account_id_for_log, e);
            e
        })?;

    tracing::info!(
        "[send:smtp_ok] account={} messageId={} raw_bytes={}",
        account_id_for_log, result.message_id, result.raw_rfc2822.len()
    );

    // Dump the first 800 bytes of the raw MIME so we can see what headers
    // lettre produced — specifically whether Message-ID is present.
    let header_preview = {
        let text = String::from_utf8_lossy(&result.raw_rfc2822);
        let end = text.find("\r\n\r\n").or_else(|| text.find("\n\n")).unwrap_or(text.len());
        let headers_only = &text[..end.min(800)];
        headers_only.to_string()
    };
    tracing::info!("[send:raw_headers]\n{}", header_preview);

    let message_id_for_response = result.message_id.clone();

    // Extract the Message-ID header from the RFC2822 raw bytes — used by the
    // post-APPEND UID SEARCH so we can prove the server indexed the message.
    // Handle both LF and CRLF line endings, folded header continuations, and
    // optional whitespace around the `:`.
    let message_id_header: Option<String> = {
        let text = String::from_utf8_lossy(&result.raw_rfc2822);
        let header_block = match text.find("\r\n\r\n") {
            Some(idx) => &text[..idx],
            None => match text.find("\n\n") {
                Some(idx) => &text[..idx],
                None => &text,
            },
        };
        header_block
            .lines()
            .find(|line| line.to_lowercase().starts_with("message-id"))
            .and_then(|line| {
                let after_colon = line.splitn(2, ':').nth(1)?;
                let trimmed = after_colon.trim();
                let stripped: String = trimmed
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_string();
                if stripped.is_empty() { None } else { Some(stripped) }
            })
    };

    tracing::info!(
        "[send:messageid_header] account={} extracted={:?}",
        account_id_for_log, message_id_header
    );

    // Background: APPEND to server Sent folder. Never blocks the UI response.
    if let Some(ref mailbox) = sent_mailbox {
        if !mailbox.is_empty() {
            let raw_bytes: Vec<u8> = result.raw_rfc2822.clone();
            let account_clone = account.clone();
            let mailbox_clone = mailbox.clone();
            let pool_clone: ImapPool = (*pool).clone();
            let app_handle_clone = app_handle.clone();
            let account_id_bg = account_id_for_log.clone();
            let message_id_bg = result.message_id.clone();
            let message_id_header_bg = message_id_header.clone();
            tauri::async_runtime::spawn(async move {
                let mailbox_for_log = mailbox_clone.clone();
                tracing::info!(
                    "[send:server_append_start] account={} mailbox={} bytes={} messageId_header={:?}",
                    account_id_bg, mailbox_for_log, raw_bytes.len(), message_id_header_bg
                );
                let mid_for_closure = message_id_header_bg.clone();
                let mailbox_for_closure = mailbox_clone.clone();
                let pool_for_log = pool_clone.clone();
                let account_for_log = account_clone.clone();
                let account_id_inner = account_id_bg.clone();
                tracing::info!("[send:dedicated_session_start] account={} mailbox={} — using fresh no-compress session to avoid Hostinger APPEND hang", account_id_inner, mailbox_for_log);
                let verified_result: Result<Result<(u32, u32, Option<u32>), String>, tokio::time::error::Elapsed> = tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    async {
                        let mut session = imap::create_imap_session_no_compress(&account_for_log).await
                            .map_err(|e| format!("dedicated session create failed: {}", e))?;
                        tracing::info!("[send:dedicated_session_ok] account={} — calling append_email_verified", account_id_inner);
                        let res = imap::append_email_verified(
                            &mut session,
                            &mailbox_for_closure,
                            &raw_bytes,
                            "\\Seen",
                            mid_for_closure.as_deref(),
                        ).await;
                        // Best-effort logout regardless of result
                        let _ = session.logout().await;
                        tracing::info!("[send:dedicated_session_logout] account={}", account_id_inner);
                        res
                    },
                ).await;
                let _ = (pool_clone, pool_for_log, account_clone, mailbox_clone);
                let (ok, verify_payload) = match verified_result {
                    Ok(Ok((before, after, found_uid))) => {
                        let _ = (before, after, found_uid); // silence unused if refactored
                        let delta = after as i64 - before as i64;
                        tracing::info!(
                            "[send:server_append_ok] account={} mailbox={} messageId={} messageId_header={:?} exists_before={} exists_after={} delta={} searched_uid={:?}",
                            account_id_bg, mailbox_for_log, message_id_bg, message_id_header_bg,
                            before, after, delta, found_uid
                        );
                        if delta <= 0 {
                            tracing::warn!(
                                "[send:server_append_no_delta] account={} mailbox={} server reports no change in EXISTS — APPEND may have been silently rejected or routed elsewhere",
                                account_id_bg, mailbox_for_log
                            );
                        }
                        if found_uid.is_none() && message_id_header_bg.is_some() {
                            tracing::warn!(
                                "[send:server_append_search_miss] account={} mailbox={} Message-ID {:?} not found via UID SEARCH HEADER — server may not index Message-ID or email is in a different folder",
                                account_id_bg, mailbox_for_log, message_id_header_bg
                            );
                        }
                        (true, serde_json::json!({
                            "existsBefore": before,
                            "existsAfter": after,
                            "delta": delta,
                            "foundUid": found_uid,
                        }))
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(
                            "[send:server_append_fail] account={} mailbox={} error={}",
                            account_id_bg, mailbox_for_log, e
                        );
                        (false, serde_json::json!({ "error": e }))
                    }
                    Err(_) => {
                        tracing::warn!(
                            "[send:server_append_timeout] account={} mailbox={} timeout=60s",
                            account_id_bg, mailbox_for_log
                        );
                        (false, serde_json::json!({ "error": "timeout" }))
                    }
                };
                // Emit UI event so the frontend can refresh the Sent view.
                let payload = serde_json::json!({
                    "accountId": account_id_bg,
                    "mailbox": mailbox_for_log,
                    "messageId": message_id_bg,
                    "messageIdHeader": message_id_header_bg,
                    "ok": ok,
                    "verify": verify_payload,
                });
                tracing::info!("[send:server_append_event_emit] payload={}", payload);
                if let Err(e) = app_handle_clone.emit("send-server-append-complete", payload) {
                    tracing::warn!("[send:event_emit_fail] error={}", e);
                }
            });
        } else {
            tracing::warn!("[send:server_append_skip] account={} reason=empty_sent_mailbox", account_id_for_log);
        }
    } else {
        tracing::warn!("[send:server_append_skip] account={} reason=no_sent_mailbox_passed", account_id_for_log);
    }

    Ok(serde_json::json!({
        "success": true,
        "messageId": message_id_for_response,
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

// ── External backup location ─────────────────────────────────────────────

#[tauri::command]
pub async fn backup_save_external_location(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::save_external_location(&data_dir, &path)
}

#[tauri::command]
pub async fn backup_get_external_location(
    app_handle: tauri::AppHandle,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::external_location::get_external_location(&data_dir))
}

#[tauri::command]
pub async fn backup_validate_external_location(
    app_handle: tauri::AppHandle,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::validate_external_location(&data_dir)
}

#[tauri::command]
pub async fn backup_clear_external_location(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::clear_external_location(&data_dir)
}

#[tauri::command]
pub async fn backup_resolve_external_location(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    match crate::external_location::resolve_external_location(&data_dir) {
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
