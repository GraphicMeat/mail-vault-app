//! Compose's send, in two RPCs, so the message is on disk before it goes.
//!
//! `compose.stage` builds the MIME, writes it into the vault (the account's
//! Sent folder, flags `draft`,`seen`, a uid of its own) and indexes it as a
//! `local_draft` row. A failure here is the only fatal one: nothing was sent.
//! It answers `{uid, mailbox, messageId, entry}`; the caller keeps that and
//! hands it to every attempt of `compose.send`, so a retried send is the same
//! message under the same uid.
//!
//! `compose.send` sends under the staged Message-ID (`smtp::send_email`, by
//! SMTP, Graph or JMAP as the account says). Once the transport took it,
//! nothing fails the call, or the outbox would offer a Retry that sends it
//! twice: an edited scheduled row it replaces is cancelled, the follow-up
//! reminder is recorded, the staged copy is rewritten as sent
//! (`archived`,`seen`, a `local_sent` row), and the server's Sent copy is
//! reported. When the server holds that copy the staged one is removed here,
//! before `send-server-append-complete` goes out: the app no longer has to be
//! listening for the copy to go.
//!
//! Errors the app shows are `E_COMPOSE_BUILD:` (the MIME could not be built)
//! and `E_COMPOSE_STAGE:` (the vault would not take the copy); a failed send
//! answers the transport's own words, as `smtp_send_email` does.
use crate::custody as daemon_custody;
use crate::handlers::common::{blocking, opt_str_arg, str_arg, u32_arg, with_mailbox_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::compose::{self, RowHints};
use mailvault_core::custody::entries;
use mailvault_core::imap::ImapConfig;
use mailvault_core::smtp::{self, OutgoingEmail};
use mailvault_core::vault_files;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{info, warn};

use crate::handlers::smtp::{account_arg, bracketed_message_id, email_arg, report_sent_copy, send_logged};

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// `snippet` and `hasAttachments`: what the row says that the bytes do not.
fn hints_arg(params: &Value) -> RowHints {
    RowHints {
        snippet: opt_str_arg(params, "snippet"),
        has_attachments: params.get("hasAttachments").and_then(Value::as_bool),
    }
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "compose.stage" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account = req!(account_arg(&id, params));
            let email = req!(email_arg(&id, params));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let hints = hints_arg(params);
            let state = Arc::clone(state);
            let staged = blocking(move || stage(&state, &account_id, &account, &email, &mailbox, &hints)).await.and_then(|r| r);
            match staged {
                Ok(v) => RpcResponse::success(id, v),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "compose.send" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account = req!(account_arg(&id, params));
            let mut email = req!(email_arg(&id, params));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let after = AfterSend {
                account_id,
                mailbox,
                uid,
                message_id: message_id.clone(),
                sent_mailbox: opt_str_arg(params, "sentMailbox"),
                remind_days: params.get("remindDays").and_then(Value::as_i64).unwrap_or(0),
                own_addresses: crate::handlers::follow_up::own_addresses_arg(params),
                cancel_scheduled_id: opt_str_arg(params, "cancelScheduledId").filter(|v| !v.is_empty()),
                hints: hints_arg(params),
            };
            // Under the id the copy was staged with: the server's copy, and
            // every reply to it, then matches the local one.
            email.message_id = Some(message_id);
            let sent = match send_logged(&account, &email).await {
                Ok(sent) => sent,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };
            // The message is out. Nothing below fails the call.
            let entry = after_send(state, &account, &email, &sent, after).await;
            RpcResponse::success(id, json!({"success": true, "messageId": sent.result.message_id, "entry": entry}))
        }

        _ => return None,
    })
}

/// Build the MIME, write the copy, index it. The MIME build is kept for the
/// send that follows (`smtp::build_mime_staged`), so a first attempt sends
/// these very bytes.
fn stage(
    state: &Arc<DaemonState>,
    account_id: &str,
    account: &ImapConfig,
    email: &OutgoingEmail,
    mailbox: &str,
    hints: &RowHints,
) -> Result<Value, String> {
    let built = smtp::build_mime_staged(account, email).map_err(|e| format!("E_COMPOSE_BUILD: {e}"))?;
    let raw = built.raw_rfc2822;
    let message_id = bracketed_message_id(&raw);
    info!("[send:build_mime] account={} bytes={} messageId={:?}", account.email, raw.len(), message_id);

    let flags = compose::STAGED_FLAGS.map(String::from);
    let uid = with_mailbox_write(state, account_id, mailbox, |root| {
        let uid = vault_files::free_local_uid(root, account_id, mailbox);
        vault_files::store(&state.vault_registry, root, account_id, mailbox, uid, &raw, &flags, true)?;
        Ok(uid)
    })
    .map_err(|e| format!("E_COMPOSE_STAGE: {e}"))?;
    info!("[send:stage_local] account={} mailbox={} uid={}", account.email, mailbox, uid);

    let row = compose::staged_row(account, email, uid, message_id.as_deref(), hints, &compose::now_iso());
    let entry = compose::with_flags(&row, false);
    // The copy is on disk: a row that did not land costs the list a line,
    // never the message.
    if let Err(e) = daemon_custody::with_conn(state, |c| entries::upsert(c, account_id, mailbox, std::slice::from_ref(&entry))) {
        warn!("[send:stage_index_fail] account={} mailbox={} uid={} error={}", account.email, mailbox, uid, e);
    }
    Ok(json!({"uid": uid, "mailbox": mailbox, "messageId": message_id, "rawSize": raw.len(), "entry": entry}))
}

/// What `compose.send` does once the transport took the message.
struct AfterSend {
    account_id: String,
    mailbox: String,
    uid: u32,
    message_id: String,
    sent_mailbox: Option<String>,
    remind_days: i64,
    own_addresses: Vec<String>,
    cancel_scheduled_id: Option<String>,
    hints: RowHints,
}

/// Each step logs its own failure and goes on: the mail is already out.
/// Answers the sent copy's row.
async fn after_send(state: &Arc<DaemonState>, account: &ImapConfig, email: &OutgoingEmail, sent: &crate::handlers::smtp::Sent, after: AfterSend) -> Value {
    let AfterSend { account_id, mailbox, uid, message_id, sent_mailbox, remind_days, own_addresses, cancel_scheduled_id, hints } = after;

    // An edited scheduled email sent now instead: its row must not fire as
    // well. It stayed queued until the send was out, so an undo or a failed
    // send still left it holding the message.
    if let Some(row_id) = cancel_scheduled_id {
        let st = Arc::clone(state);
        let id_for_cancel = row_id.clone();
        match blocking(move || crate::handlers::scheduled::cancel(&st, &id_for_cancel)).await.and_then(|r| r) {
            Ok(_) => {
                state.scheduled_send.wake();
                state.events.emit("scheduled-send", json!({"id": row_id, "status": "cancelled"}));
            }
            Err(e) => warn!("[send:cancel_scheduled_fail] row={} error={}", row_id, e),
        }
    }

    // "Remind me if no reply", keyed on the Message-ID in the bytes that went
    // out. Not on Graph: the daemon has no way to look for a reply there.
    if remind_days > 0 && !account.uses_graph() {
        let own = compose::own_addresses_with_from(&own_addresses, account.from_address());
        let (st, id, raw, to, sm) =
            (Arc::clone(state), account_id.clone(), sent.result.raw_rfc2822.clone(), email.to.clone(), sent_mailbox.clone());
        let recorded = blocking(move || {
            crate::follow_up_worker::record_after_send(&st, &id, &raw, &to, sm.as_deref(), &own, remind_days)
        })
        .await;
        if let Err(e) = recorded {
            warn!("[send:follow_up_fail] account={} error={}", account.email, e);
        }
    }

    // The staged copy becomes the sent one: the staged bytes (what went out
    // on a first attempt), or the bytes sent when the copy is gone.
    let row = compose::staged_row(account, email, uid, Some(&message_id), &hints, &compose::now_iso());
    let entry = compose::with_flags(&row, true);
    let (st, id, mb, sent_raw, sent_entry) =
        (Arc::clone(state), account_id.clone(), mailbox.clone(), sent.result.raw_rfc2822.clone(), entry.clone());
    let archived = blocking(move || -> Result<(), String> {
        let root = crate::handlers::common::vault_root(&st)?;
        let raw = vault_files::read_eml(&st.vault_registry, &root, &id, &mb, uid).unwrap_or_else(|e| {
            warn!("[send:staged_copy_missing] mailbox={} uid={} error={} — keeping the bytes sent", mb, uid, e);
            sent_raw
        });
        let flags = compose::SENT_FLAGS.map(String::from);
        with_mailbox_write(&st, &id, &mb, |root| vault_files::store(&st.vault_registry, root, &id, &mb, uid, &raw, &flags, true))?;
        daemon_custody::with_conn(&st, |c| entries::upsert(c, &id, &mb, std::slice::from_ref(&sent_entry)))?;
        Ok(())
    })
    .await
    .and_then(|r| r);
    match archived {
        Ok(()) => info!("[send:mark_sent_local] account={} mailbox={} uid={}", account.email, mailbox, uid),
        Err(e) => warn!("[send:mark_sent_local_fail] account={} mailbox={} uid={} error={}", account.email, mailbox, uid, e),
    }

    // The server's Sent copy. Once it holds one, the staged copy goes: the
    // two are one message, and the list would show both.
    let extra = json!({"vaultAccountId": account_id, "stagedUid": uid, "localMailbox": mailbox});
    let st = Arc::clone(state);
    report_sent_copy(state, account, sent_mailbox, sent, extra, move |landed| async move {
        if !landed {
            return;
        }
        let (id, mb) = (account_id, mailbox);
        let removed = blocking(move || -> Result<(), String> {
            with_mailbox_write(&st, &id, &mb, |root| vault_files::delete(&st.vault_registry, root, &id, &mb, uid))?;
            daemon_custody::with_conn(&st, |c| entries::remove(c, &id, &mb, &[uid]))?;
            Ok(())
        })
        .await
        .and_then(|r| r);
        match removed {
            Ok(()) => info!("[send:staged_copy_removed] uid={}", uid),
            Err(e) => warn!("[send:staged_copy_remove_fail] uid={} error={}", uid, e),
        }
    })
    .await;
    entry
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::{MockImap, Scenario};

    fn st(mail_dir_ok: bool) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-compose-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir, mail_dir_ok);
        let _ = daemon_custody::open_into(&s);
        s
    }

    /// Through the server's dispatch, so a module never wired in fails here.
    async fn rpc(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        crate::server::handle_request_for_test(s, method, params).await
    }

    async fn ok(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = rpc(s, method, params).await;
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

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
            "name": "Luke",
        })
    }

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

    fn email() -> Value {
        json!({
            "to": "partner@example.com",
            "subject": "Wire subject",
            "text": "Body\n\n-------- Original Message --------\nPrior",
            "html": "<p>Body</p>",
            "inReplyTo": "<parent@example.com>",
            "references": "<root@example.com> <parent@example.com>",
        })
    }

    fn stage_params(account: Value) -> Value {
        json!({
            "accountId": "acct-1", "account": account, "email": email(), "mailbox": "Sent",
            "snippet": "Body", "hasAttachments": false,
        })
    }

    fn send_params(account: Value, staged: &Value, extra: Value) -> Value {
        let mut params = json!({
            "accountId": "acct-1", "account": account, "email": email(),
            "mailbox": staged["mailbox"], "uid": staged["uid"], "messageId": staged["messageId"],
            "snippet": "Body", "hasAttachments": false,
        });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        params
    }

    /// The vault words of `uid`'s file in Sent (sorted, no IMAP names), or
    /// None when the vault holds no such file.
    fn flags_of(s: &Arc<DaemonState>, uid: u32) -> Option<Vec<String>> {
        vault_files::list_on_disk(&s.data_dir, "acct-1", "Sent", None)
            .expect("the Sent folder lists")
            .into_iter()
            .find(|m| m.uid == uid)
            .map(|m| {
                let mut words: Vec<String> = m.flags.into_iter().filter(|f| !f.starts_with('\\')).collect();
                words.sort();
                words
            })
    }

    fn raw_of(s: &Arc<DaemonState>, uid: u32) -> Vec<u8> {
        vault_files::read_eml(&s.vault_registry, &s.data_dir, "acct-1", "Sent", uid).expect("the staged copy")
    }

    /// The index row of `uid` in Sent, or None.
    fn row_of(s: &Arc<DaemonState>, uid: u32) -> Option<Value> {
        let text = daemon_custody::with_conn(s, |c| entries::read(c, "acct-1", "Sent")).unwrap()?;
        let rows: Vec<Value> = serde_json::from_str(&text).unwrap();
        rows.into_iter().find(|r| r["uid"].as_u64() == Some(uid as u64))
    }

    async fn next_event(rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<str>>, name: &str) -> Value {
        loop {
            let line = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
                .await
                .unwrap_or_else(|_| panic!("{name} was never emitted"))
                .unwrap();
            let (event, payload) = mailvault_core::daemon_ipc::parse_event(&line).expect("a valid event line");
            if event == name {
                return payload;
            }
        }
    }

    // ── compose.stage ───────────────────────────────────────────────

    /// The copy is on disk, flagged as not sent, under a uid of its own, and
    /// the Sent list has the row compose used to write for it.
    #[tokio::test]
    async fn stage_writes_the_copy_and_its_row_before_anything_is_sent() {
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().expect("a uid") as u32;
        assert_eq!(staged["mailbox"], json!("Sent"));
        let message_id = staged["messageId"].as_str().expect("a Message-ID");
        assert!(message_id.starts_with('<') && message_id.ends_with('>'), "{message_id}");

        assert_eq!(flags_of(&s, uid), Some(vec!["draft".to_string(), "seen".to_string()]));
        let raw = String::from_utf8(raw_of(&s, uid)).unwrap();
        assert!(raw.contains(&format!("Message-ID: {message_id}")), "{raw}");
        assert!(server.sent_messages().is_empty(), "staging sends nothing");

        let row = row_of(&s, uid).expect("the staged row");
        assert_eq!(row["source"], json!("local_draft"));
        assert_eq!(row["flags"], json!(["draft", "seen"]));
        assert_eq!(row["message_id"], json!(message_id));
        assert_eq!(row["from"], json!({"address": "luke@mock.test", "name": "Luke"}));
        assert_eq!(row["to"], json!([{"address": "partner@example.com", "name": ""}]));
        assert_eq!(row["references"], json!(["<root@example.com>", "<parent@example.com>"]));
        assert_eq!(row["snippet"], json!("Body"));
        assert_eq!(staged["entry"], row, "the answer carries the row it wrote");
    }

    /// Two sends staged in the same second never share a uid: the second
    /// would overwrite the first one's only copy.
    #[tokio::test]
    async fn two_stages_in_one_second_get_two_uids() {
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let a = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let b = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        assert_ne!(a["uid"], b["uid"]);
        assert!(flags_of(&s, a["uid"].as_u64().unwrap() as u32).is_some());
        assert!(flags_of(&s, b["uid"].as_u64().unwrap() as u32).is_some());
    }

    #[tokio::test]
    async fn stage_names_a_message_that_cannot_be_built() {
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut params = stage_params(account_json(&server));
        params["email"]["to"] = json!("");
        let err = rpc(&s, "compose.stage", params).await.error.expect("no recipient, no message").message;
        assert!(err.starts_with("E_COMPOSE_BUILD: "), "{err}");
    }

    #[tokio::test]
    async fn stage_on_a_vault_that_is_away_fails_before_anything_is_sent() {
        let server = MockImap::start(Scenario::new());
        let s = st(false);
        let err = rpc(&s, "compose.stage", stage_params(account_json(&server))).await.error.expect("no vault, no send").message;
        assert!(err.starts_with("E_COMPOSE_STAGE: "), "{err}");
    }

    // ── compose.send ────────────────────────────────────────────────

    /// The staged bytes are the bytes SMTP got, the copy is rewritten as
    /// sent, and once the server's Sent copy landed the staged one is gone
    /// before the event says so: no app has to be listening for it.
    #[tokio::test]
    async fn send_sends_the_staged_bytes_and_drops_the_copy_once_the_server_holds_one() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st(true);
        let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let staged_raw = raw_of(&s, uid);

        let sent = ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        assert_eq!(sent["success"], json!(true));
        assert_eq!(sent["entry"]["source"], json!("local_sent"));
        assert_eq!(sent["entry"]["flags"], json!(["archived", "seen"]));
        assert_eq!(sent["entry"]["uid"], json!(uid));

        let smtp = server.sent_messages();
        assert_eq!(smtp.len(), 1, "commands: {:?}", server.smtp_commands());
        assert_eq!(smtp[0], staged_raw, "SMTP got the staged bytes");

        let payload = next_event(&mut rx, "send-server-append-complete").await;
        assert_eq!(payload["ok"], json!(true), "{payload}");
        assert_eq!(payload["accountId"], json!("luke@mock.test"));
        assert_eq!(payload["vaultAccountId"], json!("acct-1"));
        assert_eq!(payload["stagedUid"], json!(uid));
        assert_eq!(payload["localMailbox"], json!("Sent"));
        let bare = staged["messageId"].as_str().unwrap().trim_matches(['<', '>']);
        assert_eq!(payload["messageIdHeader"], json!(bare));
        assert_eq!(flags_of(&s, uid), None, "the staged copy is gone once the server holds one");
        assert_eq!(row_of(&s, uid), None, "and so is its row");
        assert_eq!(server.state().find("Sent").unwrap().messages.len(), 1);
    }

    /// No Sent folder to APPEND to: the copy that went out stays, as sent.
    #[tokio::test]
    async fn without_a_sent_folder_the_copy_stays_as_sent() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;

        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({}))).await;

        assert_eq!(flags_of(&s, uid), Some(vec!["archived".to_string(), "seen".to_string()]));
        let row = row_of(&s, uid).expect("the sent row");
        assert_eq!(row["source"], json!("local_sent"));
        assert_eq!(row["message_id"], staged["messageId"]);
    }

    /// A send the server refused: the RPC fails with the server's words and
    /// the staged copy is untouched, still a draft, for the retry.
    #[tokio::test]
    async fn a_refused_send_fails_and_leaves_the_staged_copy() {
        plaintext();
        let server = MockImap::start(Scenario::new().smtp_refuse("partner@example.com"));
        let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;

        let resp = rpc(&s, "compose.send", send_params(account_json(&server), &staged, json!({"remindDays": 3}))).await;
        assert!(resp.result.is_none(), "a refused send must fail");
        assert_eq!(flags_of(&s, uid), Some(vec!["draft".to_string(), "seen".to_string()]));
        assert_eq!(row_of(&s, uid).unwrap()["source"], json!("local_draft"));
        let reminders = mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::follow_up::list(c, None)).unwrap();
        assert!(reminders.is_empty(), "nothing went out, nothing to remind about");
    }

    /// "Remind me if no reply": recorded once the message is out, under the
    /// Message-ID it was staged with, the From among the user's addresses.
    #[tokio::test]
    async fn a_send_with_a_reminder_records_it_under_the_staged_id() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;

        let extra = json!({"remindDays": 3, "ownAddresses": ["luke+alias@mock.test"], "sentMailbox": ""});
        ok(&s, "compose.send", send_params(account_json(&server), &staged, extra)).await;

        let reminders = mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::follow_up::list(c, None)).unwrap();
        assert_eq!(reminders.len(), 1);
        let r = &reminders[0];
        assert_eq!(r.account_id, "acct-1");
        assert_eq!(&r.message_id, staged["messageId"].as_str().unwrap());
        assert_eq!(r.subject, "Wire subject");
        assert_eq!(r.recipients, "partner@example.com");
        assert_eq!(r.remind_at - r.sent_at, 3 * 24 * 60 * 60 * 1000);
        assert!(r.own_addresses.iter().any(|a| a == "luke@mock.test"), "{:?}", r.own_addresses);
        assert!(r.own_addresses.iter().any(|a| a == "luke+alias@mock.test"), "{:?}", r.own_addresses);
    }

    /// An edited scheduled email sent now instead: its row must not fire as
    /// well, and the app's list hears that it was cancelled.
    #[tokio::test]
    async fn a_send_cancels_the_scheduled_row_it_replaces() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut rx = s.events.subscribe();
        let row = ok(&s, "scheduled.create", json!({
            "accountId": "acct-1", "account": account_json(&server), "email": email(),
            "localTime": "2099-01-01T09:00", "tz": "UTC", "fireAt": 9_999_999_999_999i64,
        }))
        .await;
        let row_id = row["id"].as_str().unwrap().to_string();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;

        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"cancelScheduledId": row_id}))).await;

        let stored = mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::scheduled::get(c, &row_id)).unwrap().unwrap();
        assert_eq!(stored.status, "cancelled");
        let event = next_event(&mut rx, "scheduled-send").await;
        assert_eq!(event, json!({"id": row_id, "status": "cancelled"}));
    }

    /// Once the transport took the message, nothing after it fails the call:
    /// a failure would offer a Retry that sends the email twice. Here the
    /// vault goes away between the stage and the send, so the sent copy and
    /// the reminder cannot be written.
    #[tokio::test]
    async fn nothing_after_the_send_fails_a_send_that_went_out() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);

        let extra = json!({"cancelScheduledId": "no-such-row", "remindDays": 2});
        let sent = ok(&s, "compose.send", send_params(account_json(&server), &staged, extra)).await;
        assert_eq!(sent["success"], json!(true));
        assert_eq!(server.sent_messages().len(), 1);
    }

    /// A Graph account: Graph files its own Sent copy, so the staged one goes
    /// at once, and the event is out before the call answers. Graph gets no
    /// reminder: the daemon cannot look for a reply there.
    #[tokio::test]
    async fn a_graph_send_drops_the_staged_copy_and_reports_before_it_answers() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![(202, String::new())]);
        let s = st(true);
        let mut rx = s.events.subscribe();
        let mut stage = stage_params(graph_account_json(&server));
        stage["account"]["name"] = json!("Leia");
        let staged = ok(&s, "compose.stage", stage).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;

        let extra = json!({"remindDays": 3});
        ok(&s, "compose.send", send_params(graph_account_json(&server), &staged, extra)).await;

        // Already emitted, not merely coming: read without waiting.
        let mut payload = None;
        while let Ok(line) = rx.try_recv() {
            let (name, p) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if name == "send-server-append-complete" {
                payload = Some(p);
            }
        }
        let payload = payload.expect("the event is out before compose.send answers");
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["stagedUid"], json!(uid));
        assert_eq!(flags_of(&s, uid), None, "Graph holds the Sent copy; the staged one is gone");
        assert!(server.commands().is_empty(), "IMAP was dialled: {:?}", server.commands());
        let reminders = mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::follow_up::list(c, None)).unwrap();
        assert!(reminders.is_empty(), "a Graph send records no reminder");
    }
}
