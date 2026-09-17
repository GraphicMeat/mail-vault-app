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

fn email_arg(id: &Value, params: &Value) -> Result<smtp::OutgoingEmail, RpcResponse> {
    params
        .get("email")
        .and_then(|v| serde_json::from_value::<smtp::OutgoingEmail>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing or invalid email".to_string()))
}

/// Ported verbatim from `commands.rs`'s `built_mime_json`: raw base64, the
/// Message-ID header extracted WITH its angle brackets (compare target for
/// the optimistic Sent row against `parse_header`'s rows, which also keep
/// `<...>` — stripping here would make the row unmatchable).
fn built_mime_json(built: smtp::BuiltMime, account: &ImapConfig) -> Value {
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

    info!(
        "[send:build_mime] account={} bytes={} messageId={:?}",
        account.email, built.raw_rfc2822.len(), message_id
    );

    json!({
        "rawBase64": raw_base64,
        "messageId": message_id,
        "rawSize": built.raw_rfc2822.len(),
    })
}

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
            match outcome {
                Ok(Ok(())) => RpcResponse::success(id, json!({"success": true, "message": "SMTP connection successful"})),
                Ok(Err(e)) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
                Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("SMTP connection test timed out for {}", account.email)),
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
            match smtp::build_mime(&account, &email) {
                Ok(built) => RpcResponse::success(id, built_mime_json(built, &account)),
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
                Ok(built) => RpcResponse::success(id, built_mime_json(built, &account)),
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
            info!("[send:smtp_start] account={} recipient={}", account_id_for_log, email.to);

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

            let header_preview = {
                let text = String::from_utf8_lossy(&result.raw_rfc2822);
                let end = text.find("\r\n\r\n").or_else(|| text.find("\n\n")).unwrap_or(text.len());
                text[..end.min(800)].to_string()
            };
            info!("[send:raw_headers]\n{}", header_preview);

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
                            let mut session = imap::create_imap_session_no_compress(&account_clone).await
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
                    let (ok, verify_payload) = match verified_result {
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

    #[tokio::test]
    async fn test_connection_reports_success_against_the_mock() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(&s, "smtp_test_connection", json!({"account": account_json(&server)})).await;
        let result = resp.result.expect("success");
        assert_eq!(result, json!({"success": true, "message": "SMTP connection successful"}));
    }

    #[tokio::test]
    async fn test_connection_against_a_bogus_host_is_an_error_not_a_panic() {
        let s = st(true);
        let account = json!({
            "email": "a@b.co", "password": "x",
            "imapHost": "127.0.0.1", "imapPort": 1,
            "smtpHost": "127.0.0.1", "smtpPort": 1, "smtpSecure": false,
        });
        let resp = call(&s, "smtp_test_connection", json!({"account": account})).await;
        assert!(resp.result.is_none(), "a bogus SMTP host must not report success");
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st(true);
        assert!(route(&s, "imap_get_mailboxes", &json!({}), json!(1)).await.is_none());
    }
}
