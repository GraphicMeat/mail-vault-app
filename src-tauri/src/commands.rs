use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::Deserialize;
use tauri::{Emitter, Manager};
use tracing::info;

use crate::imap::{self, ImapConfig};
use crate::oauth2::OAuth2Manager;
use crate::smtp;
use crate::backup;

// `with_background`, `with_priority` and `conn_lost_message` moved to the
// daemon (Task 5.4a's `imap_get_email`/`imap_get_email_light`, Task 5.4b's
// remaining eight `imap_*` write/lifecycle commands — `src-daemon/src/
// handlers/imap.rs`), their only callers in this file. `PooledSessionGuard`/
// `ImapPool`/`ImapSession` are no longer imported here for the same reason —
// `smtp_send_email` below is this file's last IMAP caller, and it only opens
// a dedicated session (`imap::create_imap_session_no_compress`), never the
// pool.

// ── Test connection ─────────────────────────────────────────────────────────
//
// `imap_test_connection` moved to the daemon (Task 5.4b,
// `src-daemon/src/handlers/imap.rs`), same request/response JSON, same 20s
// timeout and timeout message text.

#[tauri::command]
pub async fn smtp_test_connection(account: ImapConfig) -> Result<serde_json::Value, String> {
    info!(
        "[test-connection] Testing SMTP {} → {}:{}",
        account.email,
        account.smtp_host.as_deref().unwrap_or("<none>"),
        account.smtp_port.unwrap_or(587)
    );

    // Whole probe capped at 15s — the transport's own io_timeout is also 15s,
    // this guards against a stall before/around the handshake.
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        smtp::test_connection(&account),
    )
    .await
    .map_err(|_| format!("SMTP connection test timed out for {}", account.email))?
    ?;

    Ok(serde_json::json!({
        "success": true,
        "message": "SMTP connection successful"
    }))
}

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

/// Build the RFC2822 MIME bytes for an outgoing email WITHOUT sending.
/// Used by the JS compose flow so it can write the raw .eml to the local
/// Maildir archive BEFORE SMTP submission (and replace the on-disk copy with
/// a sent-state version after SMTP succeeds).
#[tauri::command]
pub async fn smtp_build_mime(
    account: ImapConfig,
    email: smtp::OutgoingEmail,
) -> Result<serde_json::Value, String> {
    built_mime_json(smtp::build_mime(&account, &email)?, &account)
}

/// Same, for the compose autosave: a draft is allowed to have no recipient yet.
/// See `smtp::build_draft_mime`.
#[tauri::command]
pub async fn smtp_build_draft_mime(
    account: ImapConfig,
    email: smtp::OutgoingEmail,
) -> Result<serde_json::Value, String> {
    built_mime_json(smtp::build_draft_mime(&account, &email)?, &account)
}

fn built_mime_json(built: smtp::BuiltMime, account: &ImapConfig) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let raw_base64 = base64::engine::general_purpose::STANDARD.encode(&built.raw_rfc2822);

    // Extract the Message-ID header from raw bytes for later server-side dedupe.
    // Returned with its angle brackets intact: the compose flow compares this
    // against `messageId` on rows that came back through `parse_header`, which
    // keeps `<...>`. Stripping here makes the optimistic Sent entry unmatchable.
    let message_id = {
        let text = String::from_utf8_lossy(&built.raw_rfc2822);
        text.lines()
            .take_while(|line| !line.is_empty())
            .find(|line| line.to_lowercase().starts_with("message-id:"))
            .map(|line| line.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
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
    account: ImapConfig,
    email: smtp::OutgoingEmail,
    #[allow(unused)] sent_mailbox: Option<String>,
) -> Result<serde_json::Value, String> {
    // Flow: local Maildir archive is handled by the JS side BEFORE and AFTER
    // this call (see ComposeModal.sendFn). This command only submits via SMTP
    // and best-effort appends to the server Sent folder in the background.
    //
    // Structured logging uses `[send]` prefix so step-by-step grep is trivial.
    //
    // Task 5.4b removed the `pool: tauri::State<'_, ImapPool>` param this
    // command used to take (the app's managed `ImapPool` is gone — the
    // interactive commands that used it all moved to the daemon). It was
    // dead weight even before that: the background APPEND below has always
    // used a dedicated `create_imap_session_no_compress` connection, never
    // the pool — `pool_clone`/`pool_for_log` were captured and cloned only
    // to be silenced (`let _ = (pool_clone, pool_for_log, ...)`), never
    // actually read. This command's own move to the daemon is Task 5.5, out
    // of scope here.

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
    // Brackets are stripped here on purpose, unlike in `smtp_build_mime`:
    // `SEARCH HEADER` matches a substring of the field value, so the bare id
    // hits `<id>` on servers that store the brackets and on those that don't.
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
                            // The Sent copy was written this instant — "now" is its real date.
                            None,
                        ).await;
                        // Best-effort logout regardless of result
                        let _ = session.logout().await;
                        tracing::info!("[send:dedicated_session_logout] account={}", account_id_inner);
                        res
                    },
                ).await;
                let _ = (account_clone, mailbox_clone);
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
