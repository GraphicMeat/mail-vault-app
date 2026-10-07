//! Daemon RPC routes for SMTP (Task 5.5), plan
//! `docs/superpowers/plans/2026-09-17-daemon-shell-phase5-network.md`.
//!
//! Naming deviation from the plan text (same convention as Task 5.4a/5.4b,
//! ledgered in `docs/superpowers/ledgers/2026-09-17-daemon-shell-phase5/
//! progress.md`): flat `smtp_*` names, not `smtp.*` — their Tauri twins are
//! deleted in this same task, so these belong in `transport.js`'s
//! `DAEMON_OWNED` with no rename layer and no Tauri fallback.
//!
//! Ported verbatim from `src-tauri/src/commands.rs` against
//! `mailvault_core::smtp` (relocated there by Task 5.3), same request/
//! response JSON, same log lines, same timeouts. `smtp_send_email`'s
//! background best-effort Sent-folder APPEND still opens its own dedicated
//! no-compress IMAP session (never the pool — same reasoning `commands.rs`
//! documented), but the completion event it used to `app_handle.emit(...)`
//! now goes through `state.events.emit(...)` (the daemon's `EventBus`,
//! `src-daemon/src/events.rs`) — `src-tauri/src/daemon_channel.rs`'s
//! `channel.open` reader already re-emits ANY named daemon event to the
//! frontend via `app.emit(&name, payload)` (see `search-index-progress` for
//! precedent), so `ComposeModal.jsx`'s `listen('send-server-append-complete',
//! ...)` picks this up unchanged — same payload shape, same event name, no
//! JS change needed for the event itself.
use crate::imap::{self, ImapConfig};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::smtp;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::info;

fn account_arg(id: &Value, params: &Value) -> Result<ImapConfig, RpcResponse> {
    params
        .get("account")
        .and_then(|v| serde_json::from_value::<ImapConfig>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing or invalid account".to_string()))
}

/// serde's own reason rides along ("missing field `content`"): without it a
/// malformed payload read only as "Missing or invalid email".
fn email_arg(id: &Value, params: &Value) -> Result<smtp::OutgoingEmail, RpcResponse> {
    let invalid = |why: String| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, why);
    let email = params.get("email").ok_or_else(|| invalid("Missing email".to_string()))?;
    serde_json::from_value::<smtp::OutgoingEmail>(email.clone()).map_err(|e| invalid(format!("Invalid email: {e}")))
}

/// Ported verbatim from `commands.rs`'s `built_mime_json`: raw base64, the
/// Message-ID header extracted WITH its angle brackets (compare target for
/// the optimistic Sent row against `parse_header`'s rows, which also keep
/// `<...>` — stripping here would make the row unmatchable).
fn built_mime_json(built: smtp::BuiltMime, account: &ImapConfig, tag: &str) -> Value {
    use base64::Engine;
    let raw_base64 = base64::engine::general_purpose::STANDARD.encode(&built.raw_rfc2822);

    let message_id = {
        let text = String::from_utf8_lossy(&built.raw_rfc2822);
        text.lines()
            .take_while(|line| !line.is_empty())
            .find(|line| line.to_lowercase().starts_with("message-id:"))
            .map(|line| line.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // `tag` tells the two callers apart: compose autosaves a draft build (own
    // Message-ID, never sent) on every pause, so one user send logs a
    // `build_draft_mime` line seconds before its `build_mime` + `smtp_start`.
    info!(
        "[send:{}] account={} bytes={} messageId={:?}",
        tag, account.email, built.raw_rfc2822.len(), message_id
    );

    json!({
        "rawBase64": raw_base64,
        "messageId": message_id,
        "rawSize": built.raw_rfc2822.len(),
    })
}

/// UID of the message carrying `message_id` (brackets stripped) in the Sent
/// `mailbox`, asked on a fresh session: the one the APPEND ran on may be the
/// thing that hung. Bounded, because it runs after the APPEND's own 60 s.
///
/// It keeps looking for the whole budget rather than asking once. A server
/// slow to file an APPEND is slow for the reason the client gave up on it, and
/// the timed-out session's LOGOUT is no measure of when it is done: it gives
/// up after `CMD_STALL` of silence, which can be before the server has stored
/// the message. A single look taken then found nothing, so the staged local
/// copy stayed beside the server's for good.
/// The sent message's header block for the Verbose log: without its `Bcc:`
/// lines (a Graph send writes the Bcc into the MIME, and hidden recipients
/// have no place in a log), cut to 800 bytes on a character boundary.
fn header_preview(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    // The first blank line, whichever line ending it has.
    let end = match (text.find("\r\n\r\n"), text.find("\n\n")) {
        (Some(c), Some(l)) => c.min(l),
        (c, l) => c.or(l).unwrap_or(text.len()),
    };
    let mut preview = String::new();
    let mut in_bcc = false;
    for line in text[..end].split_inclusive('\n') {
        // A line that starts with white space continues the header above it.
        if !line.starts_with([' ', '\t']) {
            in_bcc = line
                .get(..3)
                .is_some_and(|name| name.eq_ignore_ascii_case("bcc"))
                && line[3..].trim_start_matches([' ', '\t']).starts_with(':');
        }
        if !in_bcc {
            preview.push_str(line);
        }
    }
    // A Bcc as the last header leaves the line ending of the one before it.
    preview.truncate(preview.trim_end_matches(['\r', '\n']).len());
    let mut cut = preview.len().min(800);
    while !preview.is_char_boundary(cut) {
        cut -= 1;
    }
    preview.truncate(cut);
    preview
}

async fn sent_copy_uid(pool: &imap::ImapPool, account: &ImapConfig, mailbox: &str, message_id: &str) -> Option<u32> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(SENT_RECHECK_SECS);
    let mut session = match tokio::time::timeout_at(deadline, imap::create_imap_session_no_compress(account, pool)).await {
        Ok(Ok(session)) => session,
        Ok(Err(e)) => {
            tracing::warn!("[send:server_append_recheck_fail] mailbox={} error={}", mailbox, e);
            return None;
        }
        Err(_) => {
            tracing::warn!("[send:server_append_recheck_timeout] mailbox={} timeout={}s", mailbox, SENT_RECHECK_SECS);
            return None;
        }
    };
    let mut looks = 0u32;
    let look = async {
        loop {
            looks += 1;
            // SELECT again each time: some servers show a message another
            // session filed only to a mailbox opened after it landed.
            imap::select_mailbox(&mut session, mailbox).await.map(|_| ())?;
            if let Some(uid) = imap::uid_of_message_id(&mut session, message_id).await? {
                return Ok::<_, String>(Some(uid));
            }
            if tokio::time::Instant::now() + SENT_RECHECK_INTERVAL >= deadline {
                return Ok(None);
            }
            tokio::time::sleep(SENT_RECHECK_INTERVAL).await;
        }
    };
    let found = match tokio::time::timeout_at(deadline, look).await {
        Ok(Ok(Some(uid))) => Some(uid),
        Ok(Ok(None)) => {
            tracing::warn!("[send:server_append_recheck_miss] mailbox={} looks={} the server does not hold the message", mailbox, looks);
            None
        }
        Ok(Err(e)) => {
            tracing::warn!("[send:server_append_recheck_fail] mailbox={} looks={} error={}", mailbox, looks, e);
            None
        }
        Err(_) => {
            tracing::warn!("[send:server_append_recheck_timeout] mailbox={} looks={} timeout={}s", mailbox, looks, SENT_RECHECK_SECS);
            None
        }
    };
    // Outside the budget and bounded on its own: what the looks found stands
    // whatever the goodbye does.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), session.logout()).await;
    found
}

/// The re-check's budget. With the APPEND's 60 s it bounds when the completion
/// event can arrive; compose listens for 90 s (`APPEND_LISTEN_MS`).
const SENT_RECHECK_SECS: u64 = 15;

/// The wait between two of the re-check's looks.
const SENT_RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "smtp_test_connection" => {
            let account = match account_arg(&id, params) {
                Ok(a) => a,
                Err(resp) => return Some(resp),
            };
            info!(
                "[test-connection] Testing SMTP {} → {}:{}",
                account.email,
                account.smtp_host.as_deref().unwrap_or("<none>"),
                account.smtp_port.unwrap_or(587)
            );
            // Whole probe capped at 15s — the transport's own io_timeout is
            // also 15s, this guards against a stall before/around the
            // handshake. Verbatim from commands.rs.
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), smtp::test_connection(&account)).await;
            let (host, port) = (account.smtp_host.as_deref().unwrap_or(""), account.smtp_port.unwrap_or(587));
            match outcome {
                Ok(Ok(())) => RpcResponse::success(id, json!({"success": true, "message": "SMTP connection successful"})),
                Ok(Err(e)) => RpcResponse::success(id, super::failed_connection_test(&e, host, port)),
                Err(_) => RpcResponse::success(
                    id,
                    super::failed_connection_test(&format!("SMTP connection test timed out for {}", account.email), host, port),
                ),
            }
        }

        "smtp_build_mime" => {
            let account = match account_arg(&id, params) {
                Ok(a) => a,
                Err(resp) => return Some(resp),
            };
            let email = match email_arg(&id, params) {
                Ok(e) => e,
                Err(resp) => return Some(resp),
            };
            match smtp::build_mime_staged(&account, &email) {
                Ok(built) => RpcResponse::success(id, built_mime_json(built, &account, "build_mime")),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "smtp_build_draft_mime" => {
            let account = match account_arg(&id, params) {
                Ok(a) => a,
                Err(resp) => return Some(resp),
            };
            let email = match email_arg(&id, params) {
                Ok(e) => e,
                Err(resp) => return Some(resp),
            };
            match smtp::build_draft_mime(&account, &email) {
                Ok(built) => RpcResponse::success(id, built_mime_json(built, &account, "build_draft_mime")),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "smtp_send_email" => {
            let account = match account_arg(&id, params) {
                Ok(a) => a,
                Err(resp) => return Some(resp),
            };
            let email = match email_arg(&id, params) {
                Ok(e) => e,
                Err(resp) => return Some(resp),
            };
            let sent_mailbox = params.get("sentMailbox").and_then(Value::as_str).map(str::to_owned);

            let account_id_for_log = account.email.clone();
            info!("[send:smtp_start] account={}", account_id_for_log);

            let result = match smtp::send_email(&account, &email).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("[send:smtp_fail] account={} error={}", account_id_for_log, e);
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e));
                }
            };

            info!(
                "[send:smtp_ok] account={} messageId={} raw_bytes={}",
                account_id_for_log, result.message_id, result.raw_rfc2822.len()
            );

            // To/Cc and Subject: Verbose logs only.
            tracing::debug!("[send:raw_headers]\n{}", header_preview(&result.raw_rfc2822));

            let message_id_for_response = result.message_id.clone();

            // Message-ID header, brackets stripped (unlike built_mime_json
            // above): SEARCH HEADER matches a substring of the field value,
            // so the bare id hits `<id>` on servers that store the brackets
            // and on those that don't. Verbatim from commands.rs.
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
                        let stripped: String = after_colon.trim().trim_start_matches('<').trim_end_matches('>').to_string();
                        if stripped.is_empty() { None } else { Some(stripped) }
                    })
            };

            info!("[send:messageid_header] account={} extracted={:?}", account_id_for_log, message_id_header);

            // Microsoft Graph filed its own copy in Sent Items when it took
            // the message (202), and a Graph account has no IMAP to APPEND
            // over. Compose drops its staged local copy on this event, so it
            // comes now, naming this message. Waiting to see the copy in Sent
            // Items instead could wait for good: Exchange may rewrite the
            // Message-ID.
            if result.server_saved_sent {
                let payload = json!({
                    "accountId": account_id_for_log,
                    "mailbox": sent_mailbox,
                    "messageId": result.message_id,
                    "messageIdHeader": message_id_header,
                    "ok": true,
                    "verify": {"serverSaved": true},
                });
                info!("[send:server_saved_sent] account={} Graph filed the Sent copy, no APPEND", account_id_for_log);
                state.events.emit("send-server-append-complete", payload);
                return Some(RpcResponse::success(id, json!({"success": true, "messageId": message_id_for_response})));
            }

            // Background: best-effort APPEND to the server Sent folder. Never
            // blocks the RPC response. Uses a dedicated no-compress session,
            // never the daemon's pooled ImapPool — same reasoning
            // `commands.rs` documented (Hostinger APPEND hang).
            //
            // Two distinct skip reasons, kept apart (not collapsed into one
            // `filter`) so the `[send:server_append_skip]` log line still
            // says which one happened — verbatim from `commands.rs`, which
            // this repo has needed exact `[send:...]` log shapes to diagnose
            // before.
            let sent_mailbox_present = sent_mailbox.is_some();
            if let Some(mailbox) = sent_mailbox.filter(|m| !m.is_empty()) {
                let raw_bytes: Vec<u8> = result.raw_rfc2822.clone();
                let account_clone = account.clone();
                let state_clone = Arc::clone(state);
                let account_id_bg = account_id_for_log.clone();
                let message_id_bg = result.message_id.clone();
                let message_id_header_bg = message_id_header.clone();
                tokio::spawn(async move {
                    let mailbox_for_log = mailbox.clone();
                    info!(
                        "[send:server_append_start] account={} mailbox={} bytes={} messageId_header={:?}",
                        account_id_bg, mailbox_for_log, raw_bytes.len(), message_id_header_bg
                    );
                    let account_id_inner = account_id_bg.clone();
                    info!("[send:dedicated_session_start] account={} mailbox={} — using fresh no-compress session to avoid Hostinger APPEND hang", account_id_inner, mailbox_for_log);
                    let mid_for_closure = message_id_header_bg.clone();
                    let mailbox_for_closure = mailbox.clone();
                    let verified_result: Result<Result<(u32, u32, Option<u32>), String>, tokio::time::error::Elapsed> = tokio::time::timeout(
                        std::time::Duration::from_secs(60),
                        async {
                            let mut session = imap::create_imap_session_no_compress(&account_clone, &state_clone.imap_pool).await
                                .map_err(|e| format!("dedicated session create failed: {}", e))?;
                            info!("[send:dedicated_session_ok] account={} — calling append_email_verified", account_id_inner);
                            let res = imap::append_email_verified(
                                &mut session,
                                &mailbox_for_closure,
                                &raw_bytes,
                                "\\Seen",
                                mid_for_closure.as_deref(),
                                // The Sent copy was written this instant — "now" is its real date.
                                None,
                            ).await;
                            let _ = session.logout().await;
                            info!("[send:dedicated_session_logout] account={}", account_id_inner);
                            res
                        },
                    ).await;
                    let (mut ok, mut verify_payload) = match verified_result {
                        Ok(Ok((before, after, found_uid))) => {
                            let delta = after as i64 - before as i64;
                            info!(
                                "[send:server_append_ok] account={} mailbox={} messageId={} messageId_header={:?} exists_before={} exists_after={} delta={} searched_uid={:?}",
                                account_id_bg, mailbox_for_log, message_id_bg, message_id_header_bg, before, after, delta, found_uid
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
                            (true, json!({"existsBefore": before, "existsAfter": after, "delta": delta, "foundUid": found_uid}))
                        }
                        Ok(Err(e)) => {
                            tracing::warn!("[send:server_append_fail] account={} mailbox={} error={}", account_id_bg, mailbox_for_log, e);
                            (false, json!({"error": e}))
                        }
                        Err(_) => {
                            tracing::warn!("[send:server_append_timeout] account={} mailbox={} timeout=60s", account_id_bg, mailbox_for_log);
                            (false, json!({"error": "timeout"}))
                        }
                    };
                    // A client that gave up is not a server that refused: a
                    // slow server keeps an APPEND the client timed out on
                    // (Hostinger went silent 15s+ and still filed it). Ask it.
                    // A failure reported for a message it holds left the
                    // staged local copy beside the server's for good.
                    if !ok {
                        if let Some(mid) = message_id_header_bg.as_deref() {
                            if let Some(uid) = sent_copy_uid(&state_clone.imap_pool, &account_clone, &mailbox_for_log, mid).await {
                                info!(
                                    "[send:server_append_recovered] account={} mailbox={} uid={} — the APPEND reported failure but the server holds the message",
                                    account_id_bg, mailbox_for_log, uid
                                );
                                ok = true;
                                verify_payload = json!({"recovered": true, "error": verify_payload["error"].clone(), "foundUid": uid});
                            }
                        }
                    }
                    let payload = json!({
                        "accountId": account_id_bg,
                        "mailbox": mailbox_for_log,
                        "messageId": message_id_bg,
                        "messageIdHeader": message_id_header_bg,
                        "ok": ok,
                        "verify": verify_payload,
                    });
                    info!("[send:server_append_event_emit] payload={}", payload);
                    state_clone.events.emit("send-server-append-complete", payload);
                });
            } else if sent_mailbox_present {
                tracing::warn!("[send:server_append_skip] account={} reason=empty_sent_mailbox", account_id_for_log);
            } else {
                tracing::warn!("[send:server_append_skip] account={} reason=no_sent_mailbox_passed", account_id_for_log);
            }

            RpcResponse::success(id, json!({"success": true, "messageId": message_id_for_response}))
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::{MockImap, Scenario};

    fn st(mail_dir_ok: bool) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-smtp-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, mail_dir_ok)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    /// The Verbose log's header preview is for To/Cc and Subject. A Graph
    /// send writes the Bcc into the MIME it sends, and the hidden recipients
    /// must not land in a log file: every `Bcc:` line goes, in any case, with
    /// the lines folded under it, for either line ending.
    #[test]
    fn the_header_preview_leaves_out_bcc() {
        let crlf = b"From: a@x.com\r\nTo: b@x.com\r\nBcc: Hidden One <hidden1@x.com>,\r\n Hidden Two <hidden2@x.com>\r\nbCC:\thidden3@x.com\r\nSubject: s\r\n\r\nBcc: not a header\r\n";
        assert_eq!(header_preview(crlf), "From: a@x.com\r\nTo: b@x.com\r\nSubject: s");

        let lf = b"From: a@x.com\nBCC: hidden@x.com,\n\tmore@x.com\nSubject: s\n\nbody";
        assert_eq!(header_preview(lf), "From: a@x.com\nSubject: s");

        let last = b"From: a@x.com\r\nBcc: hidden@x.com\r\n\r\nbody";
        assert_eq!(header_preview(last), "From: a@x.com");

        // Bcc-ish names that are other headers stay.
        let other = b"Bcc-Note: kept\r\nX-Bcc: kept\r\n\r\nbody";
        assert_eq!(header_preview(other), "Bcc-Note: kept\r\nX-Bcc: kept");
    }

    /// Cut to 800 bytes on a character boundary: a cut through a multi-byte
    /// character would panic the handler of a send that had already gone out.
    #[test]
    fn the_header_preview_is_cut_on_a_character_boundary() {
        let raw = format!("Subject: {}\r\n\r\nbody", "\u{e9}".repeat(600));
        let preview = header_preview(raw.as_bytes());
        assert!(preview.len() <= 800 && preview.len() >= 798, "{}", preview.len());
        assert!(raw.starts_with(&preview));
    }

    /// Both mock listeners (IMAP + SMTP) are set before any connection is
    /// attempted. `smtp_send_email`'s background APPEND dials IMAP too, so
    /// tests exercising it need both plaintext hatches, same as
    /// `src-core/src/smtp.rs`'s own `wire_tests`.
    fn plaintext() {
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    }

    fn account_json(server: &MockImap) -> Value {
        json!({
            "email": "luke@mock.test",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
            "smtpHost": server.host(),
            "smtpPort": server.smtp_port(),
            "smtpSecure": false,
        })
    }

    fn outgoing_email(to: &str) -> Value {
        json!({"to": to, "subject": "Wire subject", "text": "Body"})
    }

    #[tokio::test]
    async fn build_mime_returns_the_raw_base64_and_message_id() {
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(&s, "smtp_build_mime", json!({"account": account_json(&server), "email": outgoing_email("to@example.com")})).await;
        let result = resp.result.expect("success");
        assert!(result["rawBase64"].as_str().unwrap().len() > 0);
        assert!(result["rawSize"].as_u64().unwrap() > 0);
        // Brackets intact (unlike smtp_send_email's SEARCH-HEADER copy) — the
        // compose flow matches this against parse_header's rows, which also
        // keep `<...>`; stripping here would make the optimistic Sent row
        // unmatchable. lettre always sets a Message-ID when none is given.
        let message_id = result["messageId"].as_str().expect("messageId must be present");
        assert!(message_id.starts_with('<') && message_id.ends_with('>'), "{message_id}");
    }

    #[tokio::test]
    async fn build_mime_without_a_recipient_is_an_error_but_build_draft_mime_accepts_it() {
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut draft = outgoing_email("");
        draft["to"] = json!("");

        let resp = call(&s, "smtp_build_mime", json!({"account": account_json(&server), "email": draft.clone()})).await;
        assert!(resp.result.is_none(), "a recipient-less email must fail smtp_build_mime");

        let resp = call(&s, "smtp_build_draft_mime", json!({"account": account_json(&server), "email": draft})).await;
        resp.result.expect("smtp_build_draft_mime must accept a draft with no recipient yet");
    }

    // A forward used to hand over attachments with no bytes (the light fetch
    // carries none), and the reason was dropped: the user saw only "Missing or
    // invalid email". The field serde stumbled on has to reach them.
    #[tokio::test]
    async fn build_mime_names_the_field_a_malformed_email_is_missing() {
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut email = outgoing_email("to@example.com");
        email["attachments"] = json!([{ "filename": "a.pdf", "contentType": "application/pdf" }]);

        let resp = call(&s, "smtp_build_mime", json!({"account": account_json(&server), "email": email})).await;
        let message = resp.error.expect("an attachment without content must be refused").message;
        assert!(message.contains("content"), "{message}");
    }

    #[tokio::test]
    async fn send_email_succeeds_against_the_mock_and_the_server_holds_the_message() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(
            &s,
            "smtp_send_email",
            json!({"account": account_json(&server), "email": outgoing_email("partner@example.com")}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert!(result["messageId"].as_str().unwrap().len() > 0);

        let sent = server.sent_messages();
        assert_eq!(sent.len(), 1, "commands: {:?}", server.smtp_commands());
    }

    /// Compose's two calls: `smtp_build_mime` stages the local Sent copy, then
    /// `smtp_send_email` sends under that id. The server must receive the staged
    /// bytes, so its copy is the local copy (same Date, same everything).
    #[tokio::test]
    async fn send_email_after_build_mime_sends_the_staged_bytes() {
        use base64::Engine;
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut email = outgoing_email("staged-partner@example.com");

        let built = call(&s, "smtp_build_mime", json!({"account": account_json(&server), "email": email.clone()})).await;
        let built = built.result.expect("build success");
        let staged = base64::engine::general_purpose::STANDARD.decode(built["rawBase64"].as_str().unwrap()).unwrap();
        email["messageId"] = built["messageId"].clone();

        let resp = call(&s, "smtp_send_email", json!({"account": account_json(&server), "email": email})).await;
        assert_eq!(resp.result.expect("success")["success"], json!(true));

        let sent = server.sent_messages();
        assert_eq!(sent.len(), 1, "commands: {:?}", server.smtp_commands());
        assert_eq!(sent[0], staged);
    }

    #[tokio::test]
    async fn send_email_with_no_sent_mailbox_does_not_append() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(
            &s,
            "smtp_send_email",
            json!({"account": account_json(&server), "email": outgoing_email("partner@example.com")}),
        )
        .await;
        assert_eq!(resp.result.expect("success")["success"], json!(true));
        // No sentMailbox param at all — the background APPEND path must
        // never even open an IMAP connection (`if let Some(mailbox) = ...`
        // is skipped whole), so nothing IMAP-side ever runs. Give the
        // background task a moment to have run if it (wrongly) did.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(server.count_commands("APPEND"), 0, "commands: {:?}", server.commands());
    }

    #[tokio::test]
    async fn send_email_appends_to_the_sent_mailbox_and_emits_the_event() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st(true);
        let mut rx = s.events.subscribe();

        let resp = call(
            &s,
            "smtp_send_email",
            json!({
                "account": account_json(&server),
                "email": outgoing_email("partner@example.com"),
                "sentMailbox": "Sent",
            }),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));

        // The background APPEND is fire-and-forget — wait for its completion
        // event on the daemon's own EventBus rather than sleeping.
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("send-server-append-complete must be emitted")
            .unwrap();
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).expect("a valid event line");
        assert_eq!(name, "send-server-append-complete");
        assert_eq!(payload["accountId"], json!("luke@mock.test"));
        assert_eq!(payload["mailbox"], json!("Sent"));
        assert_eq!(payload["ok"], json!(true));
    }

    /// The id compose staged its local copy under is the id of the message
    /// the SMTP server received, of the server's Sent copy, and of the one the
    /// completion event names — so the local copy and the server's can be
    /// matched, and a listener can tell its own send's event from another's.
    #[tokio::test]
    async fn send_email_keeps_the_staged_message_id_end_to_end() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st(true);
        let mut rx = s.events.subscribe();
        let mut email = outgoing_email("partner@example.com");
        email["messageId"] = json!("<staged.99@mock.test>");

        let resp = call(
            &s,
            "smtp_send_email",
            json!({"account": account_json(&server), "email": email, "sentMailbox": "Sent"}),
        )
        .await;
        resp.result.expect("success");

        let line = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("send-server-append-complete must be emitted")
            .unwrap();
        let (_, payload) = mailvault_core::daemon_ipc::parse_event(&line).expect("a valid event line");
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["messageIdHeader"], json!("staged.99@mock.test"));

        let has_id = |raw: &[u8]| String::from_utf8_lossy(raw).contains("Message-ID: <staged.99@mock.test>\r\n");
        let sent = server.sent_messages();
        assert_eq!(sent.len(), 1);
        assert!(has_id(&sent[0]), "SMTP got: {}", String::from_utf8_lossy(&sent[0]));
        let state = server.state();
        let copies = &state.find("Sent").expect("Sent").messages;
        assert_eq!(copies.len(), 1);
        assert!(has_id(&copies[0].raw), "Sent copy: {}", String::from_utf8_lossy(&copies[0].raw));
    }

    /// Send with a staged id to a server whose APPEND misbehaves as `action`,
    /// and return the completion event's payload.
    async fn append_event_when(action: mock_imap::Action) -> (MockImap, Value) {
        plaintext();
        let server = MockImap::start(
            Scenario::new()
                .mailbox(mock_imap::state::Mailbox::new("Sent"))
                .fault(mock_imap::Trigger::on("APPEND"), action),
        );
        let s = st(true);
        let mut rx = s.events.subscribe();
        let mut email = outgoing_email("partner@example.com");
        email["messageId"] = json!("<staged.5@mock.test>");
        let resp = call(
            &s,
            "smtp_send_email",
            json!({"account": account_json(&server), "email": email, "sentMailbox": "Sent"}),
        )
        .await;
        resp.result.expect("the SMTP send itself succeeds");
        let line = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
            .await
            .expect("send-server-append-complete must be emitted")
            .unwrap();
        let (_, payload) = mailvault_core::daemon_ipc::parse_event(&line).expect("a valid event line");
        (server, payload)
    }

    /// The client gave up on the APPEND (a refusal here; a timeout on a slow
    /// server) but the server kept the message. Reporting that as a failure
    /// left the staged local copy beside the server's for good: the event has
    /// to say what the server holds.
    #[tokio::test]
    async fn an_append_reported_failed_that_the_server_kept_counts_as_landed() {
        let (server, payload) = append_event_when(mock_imap::Action::Respond("NO".into(), "Try again later".into())).await;
        assert_eq!(server.state().find("Sent").unwrap().messages.len(), 1, "the fault stores, then refuses");
        assert_eq!(payload["ok"], json!(true), "{payload}");
        assert_eq!(payload["messageIdHeader"], json!("staged.5@mock.test"));
        assert_eq!(payload["verify"]["recovered"], json!(true), "{payload}");
        assert!(payload["verify"]["foundUid"].as_u64().is_some(), "{payload}");
    }

    /// A slow server files the APPEND after the client gave up on it, and
    /// after the re-check's first look too: the timed-out session's LOGOUT can
    /// come back (a read timeout) before the server has stored the message.
    /// One look then found nothing and the staged local copy stayed beside the
    /// server's for good; the re-check has to keep looking for its budget.
    #[tokio::test]
    async fn the_recheck_finds_a_copy_the_server_files_after_its_first_look() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st(true);
        let account: ImapConfig = serde_json::from_value(account_json(&server)).unwrap();
        let raw = b"From: luke@mock.test\r\nTo: partner@example.com\r\nSubject: late\r\nMessage-ID: <late.1@mock.test>\r\n\r\nbody\r\n".to_vec();

        let (found, ()) = tokio::join!(
            sent_copy_uid(&s.imap_pool, &account, "Sent", "late.1@mock.test"),
            async {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                server.mutate(|st| {
                    st.find_mut("Sent").unwrap().add(mock_imap::state::Message::new(7, raw));
                });
            },
        );

        assert_eq!(found, Some(7), "commands: {:?}", server.commands());
    }

    /// And an APPEND that really never landed stays a failure.
    #[tokio::test]
    async fn an_append_the_server_never_got_stays_a_failure() {
        let (server, payload) = append_event_when(mock_imap::Action::DropConnection).await;
        assert!(server.state().find("Sent").unwrap().messages.is_empty());
        assert_eq!(payload["ok"], json!(false), "{payload}");
    }

    /// A header injection through the id is dropped at the daemon boundary: a
    /// fresh id goes out and no smuggled header reaches the wire.
    #[tokio::test]
    async fn send_email_refuses_an_injected_message_id() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut email = outgoing_email("partner@example.com");
        email["messageId"] = json!("<x@mock.test>\r\nBcc: evil@attacker.test");

        let resp = call(&s, "smtp_send_email", json!({"account": account_json(&server), "email": email})).await;
        resp.result.expect("success");

        let sent = server.sent_messages();
        assert_eq!(sent.len(), 1);
        let raw = String::from_utf8_lossy(&sent[0]).to_string();
        assert!(!raw.contains("evil@attacker.test"), "{raw}");
        assert!(!raw.contains("<x@mock.test>"), "{raw}");
        let log = server.smtp_commands();
        assert!(!log.iter().any(|l| l.contains("evil@attacker.test")), "{log:?}");
    }

    /// An Outlook.com account signed in with Microsoft: Graph transport and
    /// token, no SMTP server. Its IMAP host is a live mock so a test can prove
    /// nothing ever dialled it.
    fn graph_account_json(server: &MockImap) -> Value {
        json!({
            "email": "leia@outlook.test",
            "imapHost": server.host(),
            "imapPort": server.port(),
            "authType": "oauth2",
            "oauth2Transport": "graph",
            "oauth2AccessToken": "graph-token-123",
        })
    }

    /// The Graph send (discussion #22). Graph files its own copy in Sent Items
    /// and there is no IMAP to APPEND over, so the completion event compose
    /// waits for (to drop its staged local copy) comes straight after Graph's
    /// 202, naming this message. Without it the staged copy stayed beside the
    /// server's for good. A `sentMailbox` passed anyway changes nothing.
    #[tokio::test]
    async fn a_graph_send_goes_through_graph_and_reports_the_sent_copy_without_imap() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![(202, String::new())]);
        let s = st(true);
        let mut rx = s.events.subscribe();
        let mut email = outgoing_email("partner@example.com");
        email["bcc"] = json!("hidden@example.com");
        email["messageId"] = json!("<graph.7@outlook.test>");

        let resp = call(
            &s,
            "smtp_send_email",
            json!({"account": graph_account_json(&server), "email": email, "sentMailbox": "Sent"}),
        )
        .await;
        let result = resp.result.unwrap_or_else(|| panic!("the Graph send failed: {:?}", resp.error));
        assert_eq!(result["success"], json!(true));

        let requests = crate::handlers::graph::test_graph_requests();
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(requests[0].method, "POST");
        assert!(requests[0].path.ends_with("/me/sendMail"), "{}", requests[0].path);

        let line = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("send-server-append-complete must be emitted")
            .unwrap();
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).expect("a valid event line");
        assert_eq!(name, "send-server-append-complete");
        assert_eq!(payload["accountId"], json!("leia@outlook.test"));
        assert_eq!(payload["ok"], json!(true), "{payload}");
        assert_eq!(payload["messageIdHeader"], json!("graph.7@outlook.test"), "{payload}");

        // Graph has no IMAP: nothing was appended, nothing even connected.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(server.commands().is_empty(), "IMAP was dialled: {:?}", server.commands());
        assert!(server.state().find("Sent").unwrap().messages.is_empty());
    }

    /// A refused Graph send is an RPC error in Graph's terms, and no
    /// completion event: the staged copy is all the user has.
    #[tokio::test]
    async fn a_refused_graph_send_is_an_error_and_emits_nothing() {
        let server = MockImap::start(Scenario::new());
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![(
            401,
            json!({"error": {"code": "InvalidAuthenticationToken", "message": "Access token has expired."}}).to_string(),
        )]);
        let s = st(true);
        let mut rx = s.events.subscribe();

        let resp = call(
            &s,
            "smtp_send_email",
            json!({"account": graph_account_json(&server), "email": outgoing_email("partner@example.com")}),
        )
        .await;
        let err = resp.error.expect("a 401 must fail the send").message;
        assert!(err.contains("Sign in to this account again"), "{err}");
        assert!(!err.contains("Authentication failed for"), "{err}");
        assert!(tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await.is_err(), "no event for a failed send");
    }

    #[tokio::test]
    async fn test_connection_reports_success_against_the_mock() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(&s, "smtp_test_connection", json!({"account": account_json(&server)})).await;
        let result = resp.result.expect("success");
        assert_eq!(result, json!({"success": true, "message": "SMTP connection successful"}));
    }

    /// A failed test answers `success:false` with a code the app words its
    /// message by, and the host and port a blocked-port message names. Not an
    /// RPC error: the shell forwards only an error's text, and the code would
    /// never reach the account form.
    #[tokio::test]
    async fn test_connection_against_a_bogus_host_says_what_failed() {
        let s = st(true);
        let account = json!({
            "email": "a@b.co", "password": "x",
            "imapHost": "127.0.0.1", "imapPort": 1,
            "smtpHost": "127.0.0.1", "smtpPort": 1, "smtpSecure": false,
        });
        let resp = call(&s, "smtp_test_connection", json!({"account": account})).await;
        let result = resp.result.expect("a failed test is a result, not an RPC error");
        assert_eq!(result["success"], json!(false), "a bogus SMTP host must not report success");
        assert_eq!(result["errorCode"], json!("refused"), "error was: {}", result["error"]);
        assert_eq!(result["host"], json!("127.0.0.1"));
        assert_eq!(result["port"], json!(1));
        assert!(result["error"].as_str().is_some_and(|e| !e.is_empty()), "the text stays");
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st(true);
        assert!(route(&s, "imap_get_mailboxes", &json!({}), json!(1)).await.is_none());
    }
}
