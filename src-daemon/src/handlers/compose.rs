//! Compose's send, in two RPCs, so the message is on disk before it goes.
//!
//! `compose.stage` builds the MIME, writes it into the vault (the account's
//! Sent folder, flags `draft`,`seen`, a uid of its own) and indexes it as a
//! `local_draft` row. A failure here is the only fatal one: nothing was sent.
//! It answers `{uid, mailbox, messageId, entry}`; the caller keeps that and
//! hands it to every attempt of `compose.send`, so a retried send is the same
//! message under the same uid.
//!
//! `compose.send` sends the staged copy's bytes as they are, read back from
//! the vault by uid (`smtp::send_staged`, by SMTP, Graph or JMAP as the
//! account says), so every attempt is the copy the user keeps. Only a copy
//! the vault cannot give back is rebuilt, under the staged Message-ID. Once the transport took it,
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
use mailvault_core::app_db::{self, compose_receipts::{self, Identity, Receipt, Scope, State}};
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
        "compose.receipts.remove_account" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            if account_id.trim().is_empty() {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"));
            }
            let app_dir = state.app_dir.clone();
            let removed = blocking(move || app_db::with(&app_dir, |c| compose_receipts::remove_account(c, &account_id))).await.and_then(|r| r);
            match removed {
                Ok(n) => RpcResponse::success(id, json!({"removed": n})),
                Err(e) => {
                    warn!("[send:receipt_account_cleanup_fail] error={}", e);
                    RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.composeReceiptCleanup")
                }
            }
        }

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
            let mut after = AfterSend {
                account_id,
                mailbox,
                uid,
                own_copy: None,
                message_id: message_id.clone(),
                sent_mailbox: opt_str_arg(params, "sentMailbox"),
                remind_days: params.get("remindDays").and_then(Value::as_i64).unwrap_or(0),
                own_addresses: crate::handlers::follow_up::own_addresses_arg(params),
                cancel_scheduled_id: opt_str_arg(params, "cancelScheduledId").filter(|v| !v.is_empty()),
                hints: hints_arg(params),
            };
            // Under the id the copy was staged with: the server's copy, and
            // every reply to it, then matches the local one.
            email.message_id = Some(message_id.clone());
            let (st, id_for_read, mb) = (Arc::clone(state), after.account_id.clone(), after.mailbox.clone());
            let (staged, own_copy) = match blocking(move || staged_copy(&st, &id_for_read, &mb, uid, &message_id)).await {
                Ok(StagedCopy::Own(raw, identity)) => (Some(raw), Some(identity)),
                _ => (None, None),
            };
            after.own_copy = own_copy;
            let sent = match send_logged(&account, &email, staged).await {
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

/// What the vault holds at the staged uid.
enum StagedCopy {
    /// The copy staged under this Message-ID: sent as it is, and the uid is
    /// this message's to mark sent and to remove.
    Own(Vec<u8>, Identity),
    /// Another message: it is never sent, rewritten, re-flagged or removed.
    Foreign,
    /// Nothing the vault can give back. The uid is left alone too.
    Unreadable,
}

/// Execute one exact local message operation on a blocking thread while the
/// mailbox lock and vault gate still protect its bytes/custody. The callback
/// must not do network, mirror or batch work. E retains the complete proof in
/// the existing native pending record before exact retirement. Cleaned only
/// accounts for old local absence, never authority to prune a current row.
pub(crate) fn with_local_ownership<T>(
    state: &Arc<DaemonState>, scope: &Scope, expected_sha256: Option<&str>,
    use_proof: impl FnOnce(&std::path::Path, Receipt, Option<Vec<u8>>) -> Result<T, String>,
) -> Result<Option<T>, String> {
    with_mailbox_write(state, &scope.account_id, &scope.mailbox, |root| {
        let raw = local_bytes(root, scope)?;
        match local_ownership_under_lock(state, scope, expected_sha256, raw.as_deref())? {
            Some(proof) => use_proof(root, proof, raw).map(Some),
            None => Ok(None),
        }
    })
}

/// None is absent/unavailable custody; Some(false) is a known conflicting row.
fn local_custody(state: &Arc<DaemonState>, scope: &Scope) -> Option<bool> {
    daemon_custody::with_conn(state, |c| Ok(local_custody_with_conn(c,scope))).ok().flatten()
}
fn local_custody_with_conn(c:&rusqlite::Connection,scope:&Scope)->Option<bool> {
    entries::get(c,&scope.account_id,&scope.mailbox,scope.uid).ok().flatten().map(|r| {
        matches!(r["source"].as_str(), Some("local_draft" | "local_sent"))
            && r["message_id"].as_str().and_then(compose::normalize_message_id).as_deref() == Some(scope.message_id.as_str())
    })
}

fn local_ownership_under_lock(state: &Arc<DaemonState>, scope: &Scope, expected_sha256: Option<&str>, raw: Option<&[u8]>) -> Result<Option<Receipt>, String> {
    let custody = local_custody(state, scope);
    if custody == Some(false) { return Ok(None); }
    // Unreadable native history is unknown, never a successfully empty lookup.
    let mut candidates = app_db::with(&state.app_dir, |c| compose_receipts::load(c, scope))?;
    if let Some(digest) = expected_sha256 { candidates.retain(|r| r.identity.sha256 == digest); }
    if candidates.len() > 1 { return Ok(None); }
    Ok(match (candidates.pop(), raw) {
        (Some(receipt), Some(bytes)) if receipt.state == State::Present && receipt.identity.matches_bytes(bytes) => Some(receipt),
        (Some(receipt), None) if receipt.state == State::Cleaned => Some(receipt),
        (None, Some(bytes)) if custody == Some(true) => Identity::from_bytes(scope.clone(), bytes)
            .filter(|i| expected_sha256.is_none_or(|h| h == i.sha256)).map(Receipt::present),
        _ => None,
    })
}
/// E3's typed resolved-candidate entry. Caller owns the matching mailbox ->
/// vault gate and has checked the complete inventory fence and all candidate
/// bytes. This reuses D's ownership policy without another filesystem lookup.
pub(crate) fn local_ownership_resolved(state:&Arc<DaemonState>,scope:&Scope,expected_sha256:Option<&str>,raw:Option<&[u8]>)->Result<Option<Receipt>,String> {
    local_ownership_under_lock(state,scope,expected_sha256,raw)
}
pub(crate) fn retained_local_ownership_resolved(state:&Arc<DaemonState>,proof:&Receipt,raw:Option<&[u8]>)->Result<Option<Receipt>,String> {
    if !proof.is_valid() {return Err("invalid retained compose proof".into());}
    retained_local_ownership_checked(proof,raw,local_custody(state,&proof.identity.scope))
}
/// Matching mailbox -> vault gate -> custody is already held by the E3 local
/// unit. Reuse the same policy without recursively acquiring custody.
pub(crate) fn retained_local_ownership_resolved_with_conn(c:&rusqlite::Connection,proof:&Receipt,raw:Option<&[u8]>)->Result<Option<Receipt>,String> {
    if !proof.is_valid() {return Err("invalid retained compose proof".into());}
    retained_local_ownership_checked(proof,raw,local_custody_with_conn(c,&proof.identity.scope))
}
fn retained_local_ownership_checked(proof:&Receipt,raw:Option<&[u8]>,custody:Option<bool>)->Result<Option<Receipt>,String> {
    if custody==Some(false) {return Ok(None);}
    let matches=match (proof.state,raw) {
        (State::Present,Some(raw))=>proof.identity.matches_bytes(raw),
        (State::Cleaned,None)=>true,
        _=>false,
    };
    Ok(matches.then(||proof.clone()))
}

/// Revalidate proof retained by a supported native pending record after exact
/// receipt retirement. Never accepts proof from a compose/UI RPC.
pub(crate) fn with_retained_local_ownership<T>(
    state: &Arc<DaemonState>, proof: &Receipt,
    use_proof: impl FnOnce(&std::path::Path, Receipt, Option<Vec<u8>>) -> Result<T, String>,
) -> Result<Option<T>, String> {
    if !proof.is_valid() { return Err("invalid retained compose proof".into()); }
    let scope = &proof.identity.scope;
    with_mailbox_write(state, &scope.account_id, &scope.mailbox, |root| {
        let raw = local_bytes(root, scope)?;
        match retained_local_ownership_resolved(state,proof,raw.as_deref())? {
            Some(proof)=>use_proof(root,proof,raw).map(Some),
            None=>Ok(None),
        }
    })
}

/// Disk-only read under the mailbox lock. A failed directory listing is never
/// absence (read_raw's legacy Maildir lookup is deliberately lenient).
fn local_bytes(root: &std::path::Path, scope: &Scope) -> Result<Option<Vec<u8>>, String> {
    let raw = mailvault_core::message_store::read_raw(root, &scope.account_id, &scope.mailbox, scope.uid).map_err(|e| e.to_string())?;
    if raw.is_none() {
        for format in [mailvault_core::message_store::Format::Maildir, mailvault_core::message_store::Format::Jmap] {
            let uids = mailvault_core::message_store::uids_in_format(root, &scope.account_id, &scope.mailbox, format).map_err(|e| e.to_string())?;
            if uids.contains(&scope.uid) { return Err("local compose copy could not be read".into()); }
        }
    }
    Ok(raw)
}

fn staged_copy(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, message_id: &str) -> StagedCopy {
    let Some(scope) = Scope::new(account_id, mailbox, uid, message_id) else { return StagedCopy::Foreign };
    match with_local_ownership(state, &scope, None, |_, proof, raw| {
        Ok(if proof.state == State::Present { raw.map(|raw| StagedCopy::Own(raw, proof.identity)).unwrap_or(StagedCopy::Unreadable) } else { StagedCopy::Unreadable })
    }) {
        Ok(Some(copy)) => copy,
        Ok(None) => StagedCopy::Foreign,
        Err(e) => { warn!("[send:staged_copy_unreadable] mailbox={} uid={} error={} : rebuilding", mailbox, uid, e); StagedCopy::Unreadable }
    }
}

/// Build the MIME, write the copy, index it. `compose.send` sends the copy's
/// bytes (`staged_copy`), so every attempt sends these very bytes.
fn stage(
    state: &Arc<DaemonState>,
    account_id: &str,
    account: &ImapConfig,
    email: &OutgoingEmail,
    mailbox: &str,
    hints: &RowHints,
) -> Result<Value, String> {
    let built = smtp::build_mime(account, email).map_err(|e| format!("E_COMPOSE_BUILD: {e}"))?;
    let raw = built.raw_rfc2822;
    let message_id = bracketed_message_id(&raw);
    info!("[send:build_mime] account={} bytes={} messageId={:?}", account.email, raw.len(), message_id);

    let flags = compose::STAGED_FLAGS.map(String::from);
    with_mailbox_write(state, account_id, mailbox, |root| {
        let uid = vault_files::free_local_uid(root, account_id, mailbox);
        vault_files::store(&state.vault_registry, root, account_id, mailbox, uid, &raw, &flags, true)?;
        info!("[send:stage_local] account={} mailbox={} uid={}", account.email, mailbox, uid);
        let row = compose::staged_row(account, email, uid, message_id.as_deref(), hints, &compose::now_iso());
        let entry = compose::with_flags(&row, false);
        let _ = persist_present(state, account_id, mailbox, uid, &raw);
        if let Err(e) = daemon_custody::with_conn(state, |c| entries::upsert(c, account_id, mailbox, std::slice::from_ref(&entry))) {
            warn!("[send:stage_index_fail] mailbox={} uid={} error={}", mailbox, uid, e);
        }
        Ok(json!({"uid": uid, "mailbox": mailbox, "messageId": message_id, "rawSize": raw.len(), "entry": entry}))
    }).map_err(|e| format!("E_COMPOSE_STAGE: {e}"))
}

fn persist_present(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, raw: &[u8]) -> Option<Identity> {
    let identity = bracketed_message_id(raw).and_then(|mid| Scope::new(account_id, mailbox, uid, &mid)).and_then(|scope| Identity::from_bytes(scope, raw));
    if let Some(identity) = &identity {
        if let Err(e) = app_db::with(&state.app_dir, |c| compose_receipts::save(c, &Receipt::present(identity.clone()))) {
            warn!("[send:receipt_write_fail] mailbox={} uid={} error={}", mailbox, uid, e);
        }
    }
    identity
}

/// What `compose.send` does once the transport took the message.
struct AfterSend {
    account_id: String,
    mailbox: String,
    uid: u32,
    /// The vault held this message's own copy at `uid`. Otherwise `uid` is
    /// never written or removed, and the sent copy gets a uid of its own.
    own_copy: Option<Identity>,
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
    let AfterSend { account_id, mailbox, uid: staged_uid, own_copy, message_id, sent_mailbox, remind_days, own_addresses, cancel_scheduled_id, hints } = after;

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

    // The staged copy becomes the sent one, retaining its original local bytes
    // (Graph can add Bcc to transport bytes). Without exact local ownership,
    // the bytes sent go under a uid of their own and the staged uid is left
    // as it is: it may hold another message.
    let row = compose::staged_row(account, email, staged_uid, Some(&message_id), &hints, &compose::now_iso());
    let mut entry = compose::with_flags(&row, true);
    let (st, id, mb, sent_raw) = (Arc::clone(state), account_id.clone(), mailbox.clone(), sent.result.raw_rfc2822.clone());
    let row_template = entry.clone();
    let local_message_id = message_id.clone();
    let archive_identity = own_copy.clone();
    let archived = blocking(move || -> Result<(Identity, Value), String> {
        let flags = compose::SENT_FLAGS.map(String::from);
        with_mailbox_write(&st, &id, &mb, |root| {
            let scope = Scope::new(&id, &mb, staged_uid, &local_message_id).ok_or("invalid compose scope")?;
            let current = local_bytes(root, &scope)?;
            // Pin the exact local copy read before transport. Graph can add a
            // Bcc header to transport bytes; its local copy retains staged bytes.
            let can_reuse = match archive_identity.as_ref() {
                Some(original) => local_ownership_under_lock(&st, &scope, Some(&original.sha256), current.as_deref())?
                    .is_some_and(|proof| proof.state == State::Present && proof.identity == *original),
                None => false,
            };
            let (uid, kept_raw) = if can_reuse {
                (staged_uid, current.expect("present proof has bytes"))
            } else {
                if current.is_none() {
                    if let Ok(receipts) = app_db::with(&st.app_dir, |c| compose_receipts::load(c, &scope)) {
                        for mut receipt in receipts {
                            receipt.state = State::Cleaned;
                            if let Err(e) = app_db::with(&st.app_dir, |c| compose_receipts::save(c, &receipt)) {
                                warn!("[send:receipt_clean_fail] uid={} error={}", staged_uid, e);
                            }
                        }
                    }
                }
                let mut uid = vault_files::free_local_uid(root, &id, &mb);
                while uid == staged_uid || vault_files::exists(root, &id, &mb, uid) { uid += 1; }
                (uid, sent_raw)
            };
            vault_files::store(&st.vault_registry, root, &id, &mb, uid, &kept_raw, &flags, true)?;
            let mut sent_entry = row_template;
            sent_entry["uid"] = json!(uid);
            let identity = persist_present(&st, &id, &mb, uid, &kept_raw).ok_or("invalid local compose identity")?;
            if let Err(e) = daemon_custody::with_conn(&st, |c| entries::upsert(c, &id, &mb, std::slice::from_ref(&sent_entry))) {
                warn!("[send:sent_index_fail] uid={} error={}", uid, e);
            }
            Ok((identity, sent_entry))
        })
    })
    .await
    .and_then(|r| r);
    // Where this message's local copy is: the uid the server's copy removes.
    // With no copy written, the staged uid only when it was this message's.
    let local_copy = match archived {
        Ok((identity, sent_entry)) => {
            let uid = identity.scope.uid;
            info!("[send:mark_sent_local] account={} mailbox={} uid={} staged_uid={}", account.email, mailbox, uid, staged_uid);
            entry = sent_entry;
            Some(identity)
        }
        Err(e) => {
            warn!("[send:mark_sent_local_fail] account={} mailbox={} uid={} error={}", account.email, mailbox, staged_uid, e);
            own_copy
        }
    };

    // The server's Sent copy. Once it holds one, the staged copy goes: the
    // two are one message, and the list would show both.
    let local_uid = local_copy.as_ref().map(|identity| identity.scope.uid);
    let extra = json!({"vaultAccountId": account_id, "stagedUid": local_uid, "localMailbox": mailbox});
    let st = Arc::clone(state);
    report_sent_copy(state, account, sent_mailbox, sent, extra, move |landed| async move {
        let Some(identity) = local_copy.filter(|_| landed) else {
            return;
        };
        let uid = identity.scope.uid;
        let (id, mb) = (account_id, mailbox);
        let removed = blocking(move || -> Result<(), String> {
            with_local_ownership(&st, &identity.scope, Some(&identity.sha256), |root, mut proof, raw| {
                if raw.is_some() {
                    proof.state = State::Cleaned;
                    // Failure keeps the local copy and custody. Transport already
                    // succeeded, so this can only be a logged cleanup failure.
                    app_db::with(&st.app_dir, |c| compose_receipts::save(c, &proof))?;
                    vault_files::delete(&st.vault_registry, root, &id, &mb, uid)?;
                    daemon_custody::with_conn(&st, |c| entries::remove(c, &id, &mb, &[uid]))?;
                }
                Ok(())
            })?.ok_or("local compose identity changed before cleanup")?;
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

    fn proof_of(s: &Arc<DaemonState>, staged: &Value, digest: Option<&str>) -> Option<Receipt> {
        let scope = Scope::new("acct-1", staged["mailbox"].as_str().unwrap(), staged["uid"].as_u64().unwrap() as u32, staged["messageId"].as_str().unwrap()).unwrap();
        with_local_ownership(s, &scope, digest, |_, proof, _| Ok(proof)).unwrap()
    }

    #[tokio::test]
    async fn receipt_reader_uses_normal_custody_offline_but_never_a_server_collision() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        app_db::with(&s.app_dir, |c| compose_receipts::remove_account(c, "acct-1")).unwrap();
        let proof = proof_of(&s, &staged, None).expect("normal native local custody is sufficient offline");
        assert_eq!(proof.state, State::Present);
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let mut server_row = row_of(&s, uid).unwrap(); server_row["source"] = json!("imap");
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acct-1", "Sent", &[server_row])).unwrap();
        assert!(proof_of(&s, &staged, None).is_none(), "same UID and MID with server custody is not local ownership");
        assert!(server.commands().is_empty(), "pseudo UID is never sent to a server");
    }

    #[tokio::test]
    async fn receipt_known_server_custody_collision_overrules_an_old_local_receipt() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let mut row = row_of(&s, uid).unwrap(); row["source"] = json!("imap");
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acct-1", "Sent", &[row])).unwrap();
        assert!(proof_of(&s, &staged, None).is_none(), "a known server copy cannot inherit an old local receipt even with the same bytes");
        assert!(server.commands().is_empty());
    }

    #[tokio::test]
    async fn receipt_graph_bcc_cleanup_binds_the_actual_local_staged_bytes() {
        plaintext(); let server = MockImap::start(Scenario::new());
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![(202, String::new())]);
        let s = st(true);
        let mut params = stage_params(graph_account_json(&server));
        params["email"]["bcc"] = json!("hidden@example.test");
        let staged = ok(&s, "compose.stage", params.clone()).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let original = proof_of(&s, &staged, None).unwrap();
        let sent = ok(&s, "compose.send", send_params(graph_account_json(&server), &staged, json!({"email": params["email"]}))).await;
        assert_eq!(sent["success"], true);
        assert_eq!(sent["entry"]["uid"], staged["uid"], "Graph Bcc injection must preserve ordinary staged-copy identity");
        assert!(flags_of(&s, uid).is_none(), "Graph's local stage is cleaned after transport accepts it");
        let cleaned = proof_of(&s, &staged, None).unwrap();
        assert_eq!(cleaned.state, State::Cleaned); assert_eq!(cleaned.identity, original.identity);
        assert!(server.commands().is_empty());
    }

    fn replace_receipt_record(s: &Arc<DaemonState>, proof: &Receipt, text: &str) {
        app_db::with(&s.app_dir, |c| {
            let n = c.execute("UPDATE meta SET value = ?1 WHERE value = ?2", rusqlite::params![text, serde_json::to_string(proof).unwrap()]).map_err(|e| e.to_string())?;
            assert_eq!(n, 1, "the actual native receipt was changed");
            Ok(())
        }).unwrap();
    }

    #[tokio::test]
    async fn receipt_unreadable_malformed_history_is_never_an_empty_lookup() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let original = proof_of(&s, &staged, None).unwrap();
        replace_receipt_record(&s, &original, "{broken");
        let read = with_local_ownership(&s, &original.identity.scope, None, |_, p, _| Ok(p));
        assert!(matches!(read, Err(_) | Ok(None)), "normal custody must not convert unreadable native history into empty history");
    }

    #[tokio::test]
    async fn receipt_unreadable_future_history_is_never_an_empty_lookup() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let original = proof_of(&s, &staged, None).unwrap();
        let mut future = original.clone(); future.version = 999;
        replace_receipt_record(&s, &original, &serde_json::to_string(&future).unwrap());
        let read = with_local_ownership(&s, &original.identity.scope, None, |_, p, _| Ok(p));
        assert!(matches!(read, Err(_) | Ok(None)), "a future native record is unresolved despite readable custody and current bytes");
    }

    #[tokio::test]
    async fn receipt_unreadable_two_digest_history_cannot_choose_todays_bytes() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let original = proof_of(&s, &staged, None).unwrap();
        let uid = original.identity.scope.uid;
        let mut later = raw_of(&s, uid); later.extend_from_slice(b"NATIVE SECOND DIGEST");
        with_mailbox_write(&s, "acct-1", "Sent", |root| {
            vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &later, &["draft".into(), "seen".into()], true)?;
            persist_present(&s, "acct-1", "Sent", uid, &later).ok_or("native replacement has no identity")?;
            Ok(())
        }).unwrap();
        assert_eq!(persisted_receipts(&s).len(), 2, "native digests are distinguishable before corruption");
        assert!(proof_of(&s, &staged, None).is_none(), "readable digest history already refuses ambiguous originals");
        replace_receipt_record(&s, &original, "{broken");
        let read = with_local_ownership(&s, &original.identity.scope, None, |_, p, _| Ok(p));
        assert!(matches!(read, Err(_) | Ok(None)), "an unreadable sibling digest must not let today's bytes choose the original");
    }

    #[tokio::test]
    async fn receipt_unreadable_history_never_sends_same_mid_replacement_bytes() {
        plaintext(); let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let original = proof_of(&s, &staged, None).unwrap();
        let uid = original.identity.scope.uid;
        let mut foreign = raw_of(&s, uid); foreign.extend_from_slice(b"FOREIGN SAME MID");
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &foreign, &["seen".into()], true)).unwrap();
        assert!(proof_of(&s, &staged, None).is_none(), "the valid original receipt already refuses replacement bytes");
        replace_receipt_record(&s, &original, "{broken");
        let sent = ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({}))).await;
        assert_eq!(sent["success"], true, "unresolved local proof does not fail transport that succeeded");
        assert_ne!(server.sent_messages()[0], foreign, "same MID plus custody cannot send an unproved replacement");
        assert_eq!(raw_of(&s, uid), foreign, "the unproved replacement is preserved");
        assert_ne!(sent["entry"]["uid"], staged["uid"]);
    }

    #[tokio::test]
    async fn receipt_reader_binds_tuple_mid_digest_and_refuses_ambiguous_digest_history() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let proof = proof_of(&s, &staged, None).unwrap();
        for changed in [json!({"mailbox": "Drafts"}), json!({"uid": 1}), json!({"messageId": "<other@example.test>"})] {
            let mut wrong = staged.clone(); wrong.as_object_mut().unwrap().extend(changed.as_object().unwrap().clone());
            assert!(proof_of(&s, &wrong, None).is_none());
        }
        let wrong_account = Scope::new("other", "Sent", proof.identity.scope.uid, &proof.identity.scope.message_id).unwrap();
        assert!(with_local_ownership(&s, &wrong_account, None, |_, p, _| Ok(p)).unwrap().is_none());
        assert!(proof_of(&s, &staged, Some(&"0".repeat(64))).is_none());
        let mut other = raw_of(&s, proof.identity.scope.uid); other.extend_from_slice(b"different");
        let duplicate = Receipt::present(Identity::from_bytes(proof.identity.scope.clone(), &other).unwrap());
        app_db::with(&s.app_dir, |c| compose_receipts::save(c, &duplicate)).unwrap();
        assert!(proof_of(&s, &staged, None).is_none(), "current bytes cannot select an original from ambiguous tuple history");
        assert_eq!(proof_of(&s, &staged, Some(&proof.identity.sha256)), Some(proof));
    }

    #[tokio::test]
    async fn receipt_persistence_failure_keeps_transmitted_send_successful_and_local_proof() {
        plaintext(); let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent"))); let s = st(true);
        let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        app_db::with(&s.app_dir, |c| c.execute_batch("CREATE TRIGGER reject_receipt BEFORE INSERT ON meta WHEN NEW.key LIKE 'compose_receipt:%' BEGIN SELECT RAISE(FAIL, 'receipt unavailable'); END;").map_err(|e| e.to_string())).unwrap();
        let sent = ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        assert_eq!(next_event(&mut rx, "send-server-append-complete").await["ok"], true);
        assert_eq!(sent["success"], true); assert_eq!(server.sent_messages().len(), 1);
        assert!(flags_of(&s, staged["uid"].as_u64().unwrap() as u32).is_some(), "failed cleaned persistence preserves local copy and custody");
        assert_eq!(proof_of(&s, &staged, None).unwrap().state, State::Present);
    }

    #[tokio::test]
    async fn receipt_stage_persistence_failure_uses_custody_and_otherwise_refuses() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        app_db::with(&s.app_dir, |c| c.execute_batch("CREATE TRIGGER reject_receipt BEFORE INSERT ON meta WHEN NEW.key LIKE 'compose_receipt:%' BEGIN SELECT RAISE(FAIL, 'receipt unavailable'); END;").map_err(|e| e.to_string())).unwrap();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        assert!(persisted_receipts(&s).is_empty());
        assert!(proof_of(&s, &staged, None).is_some());
        daemon_custody::close(&s);
        assert!(proof_of(&s, &staged, None).is_none(), "missing receipt and custody never infer ownership from MID alone");
    }

    #[tokio::test]
    async fn receipt_cleaned_proof_cannot_authorize_a_replacement_mirror_or_queue() {
        plaintext(); let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent"))); let s = st(true);
        let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let original = proof_of(&s, &staged, None).unwrap();
        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        assert_eq!(next_event(&mut rx, "send-server-append-complete").await["ok"], true);
        let cleaned = proof_of(&s, &staged, None).unwrap(); assert_eq!(cleaned.state, State::Cleaned);
        assert_eq!(cleaned.identity, original.identity);
        let uid = cleaned.identity.scope.uid;
        let replacement = b"Message-ID: <foreign@example.test>\r\n\r\nkeep";
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, replacement, &["seen".into()], true)).unwrap();
        assert!(proof_of(&s, &staged, Some(&original.identity.sha256)).is_none());
        let queue = Scope::new("acct-1", "Scheduled", uid, &original.identity.scope.message_id).unwrap();
        assert!(with_local_ownership(&s, &queue, None, |_, p, _| Ok(p)).unwrap().is_none());
        assert_eq!(raw_of(&s, uid), replacement);
    }

    #[tokio::test]
    async fn receipt_cleaned_never_authorizes_identical_bytes_reappearing_at_the_uid() {
        plaintext(); let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent"))); let s = st(true);
        let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let old_raw = raw_of(&s, uid);
        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        assert_eq!(next_event(&mut rx, "send-server-append-complete").await["ok"], true);
        assert_eq!(proof_of(&s, &staged, None).unwrap().state, State::Cleaned);
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &old_raw, &["seen".into()], true)).unwrap();
        assert!(proof_of(&s, &staged, None).is_none(), "cleaned evidence never grants authority over a current colliding copy, even identical bytes");
        assert_eq!(raw_of(&s, uid), old_raw);
    }

    #[tokio::test]
    async fn receipt_after_send_rechecks_bytes_changed_while_transport_was_in_flight() {
        plaintext(); let server = MockImap::start(Scenario::new()); let s = st(true);
        let params = stage_params(account_json(&server));
        let staged = ok(&s, "compose.stage", params.clone()).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let account = account_arg(&json!(1), &params).unwrap();
        let mut email = email_arg(&json!(1), &params).unwrap();
        email.message_id = Some(staged["messageId"].as_str().unwrap().into());
        let original = raw_of(&s, uid);
        let original_identity = proof_of(&s, &staged, None).unwrap().identity;
        let sent = send_logged(&account, &email, Some(original.clone())).await.unwrap();
        let mut foreign = original.clone(); foreign.extend_from_slice(b"SAME MID REPLACEMENT");
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &foreign, &["seen".into()], true)).unwrap();
        let entry = after_send(&s, &account, &email, &sent, AfterSend {
            account_id: "acct-1".into(), mailbox: "Sent".into(), uid, own_copy: Some(original_identity),
            message_id: staged["messageId"].as_str().unwrap().into(), sent_mailbox: None,
            remind_days: 0, own_addresses: vec![], cancel_scheduled_id: None, hints: RowHints::default(),
        }).await;
        assert_eq!(raw_of(&s, uid), foreign, "the pre-transport read is not mutation authority");
        assert_ne!(entry["uid"], staged["uid"]);
        assert_eq!(raw_of(&s, entry["uid"].as_u64().unwrap() as u32), original);
    }

    #[tokio::test]
    async fn receipt_retained_present_proof_rechecks_exact_bytes_after_retirement() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let proof = proof_of(&s, &staged, None).unwrap();
        let uid = proof.identity.scope.uid; let original = raw_of(&s, uid);
        app_db::with(&s.app_dir, |c| compose_receipts::retire(c, &proof)).unwrap();
        let resumed = with_retained_local_ownership(&s, &proof, |_, p, raw| { assert_eq!(raw, Some(original.clone())); Ok(p) }).unwrap();
        assert_eq!(resumed, Some(proof.clone()));
        let mut changed = original; changed.extend_from_slice(b"SAME MID DIFFERENT BYTES");
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &changed, &["seen".into()], true)).unwrap();
        assert!(with_retained_local_ownership(&s, &proof, |_, p, _| Ok(p)).unwrap().is_none());
    }

    #[tokio::test]
    async fn receipt_retained_native_pending_proof_survives_exact_retirement_and_reopen() {
        plaintext(); let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent"))); let s = st(true);
        let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        assert_eq!(next_event(&mut rx, "send-server-append-complete").await["ok"], true);
        let proof = proof_of(&s, &staged, None).unwrap();
        assert_eq!(proof.state, State::Cleaned);
        app_db::with(&s.app_dir, |c| {
            // This stands for E's existing pending journal, not a second proof registry.
            mailvault_core::app_db::db::meta_set(c, "pending_operation", &serde_json::to_string(&proof).unwrap())?;
            assert!(compose_receipts::retire(c, &proof)?);
            Ok(())
        }).unwrap();
        let reopened = DaemonState::for_test(s.app_dir.clone(), s.data_dir.clone(), true);
        let retained: Receipt = app_db::with(&reopened.app_dir, |c| Ok(serde_json::from_str(&mailvault_core::app_db::db::meta_get(c, "pending_operation").unwrap()).unwrap())).unwrap();
        assert!(proof_of(&reopened, &staged, None).is_none());
        let resumed = with_retained_local_ownership(&reopened, &retained, |_, p, raw| { assert!(raw.is_none()); Ok(p) }).unwrap();
        assert_eq!(resumed, Some(proof), "pending native proof remains usable after receipt retirement");
        let mut unsupported = retained; unsupported.version = 999;
        assert!(with_retained_local_ownership(&reopened, &unsupported, |_, p, _| Ok(p)).is_err());
    }

    #[tokio::test]
    async fn receipt_cleanup_rechecks_a_copy_replaced_while_server_append_was_in_flight() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent"))
            .fault(mock_imap::Trigger::on("APPEND"), mock_imap::Action::Delay(std::time::Duration::from_millis(500))));
        let s = st(true); let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        let mut foreign = raw_of(&s, uid); foreign.extend_from_slice(b"DIFFERENT SAME MID");
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &foreign, &["seen".into()], true)).unwrap();
        assert_eq!(next_event(&mut rx, "send-server-append-complete").await["ok"], true);
        assert_eq!(raw_of(&s, uid), foreign, "cleanup must re-read after provider IO");
        assert!(proof_of(&s, &staged, None).is_none());
        assert_eq!(persisted_receipts(&s)[0]["state"], "present", "a collision is not cleaned evidence");
    }

    #[tokio::test]
    async fn receipt_account_cleanup_storage_failure_is_reported_without_vault_access() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        app_db::with(&s.app_dir, |c| c.execute_batch("CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON meta WHEN OLD.key LIKE 'compose_receipt:%' BEGIN SELECT RAISE(FAIL, 'receipt unavailable'); END;").map_err(|e| e.to_string())).unwrap();
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let failed = rpc(&s, "compose.receipts.remove_account", json!({"accountId": "acct-1"})).await;
        assert_eq!(failed.error.unwrap().message, "errors.composeReceiptCleanup");
        assert_eq!(persisted_receipts(&s).len(), 1);
        assert!(server.commands().is_empty());
    }

    #[tokio::test]
    async fn receipt_account_cleanup_is_explicit_isolated_idempotent_and_ungated() {
        let server = MockImap::start(Scenario::new()); let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let mut other = stage_params(account_json(&server)); other["accountId"] = json!("acct-1-other");
        ok(&s, "compose.stage", other).await;
        ok(&s, "clear_email_cache", json!({"accountId": "acct-1"})).await;
        ok(&s, "delete_mailbox_cache", json!({"accountId": "acct-1"})).await;
        assert_eq!(persisted_receipts(&s).len(), 2, "generic cache maintenance does not retire evidence");
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(ok(&s, "compose.receipts.remove_account", json!({"accountId": "acct-1"})).await["removed"], 1);
        assert_eq!(ok(&s, "compose.receipts.remove_account", json!({"accountId": "acct-1"})).await["removed"], 0);
        assert_eq!(persisted_receipts(&s).len(), 1);
        assert_eq!(persisted_receipts(&s)[0]["identity"]["accountId"], "acct-1-other");
        assert!(rpc(&s, "compose.receipts.remove_account", json!({})).await.error.is_some());
        assert!(rpc(&s, "compose.receipts.remove_account", json!({"accountId": " "})).await.error.is_some());
        assert!(server.commands().is_empty());
        assert!(staged["uid"].as_u64().is_some());
    }

    fn persisted_receipts(s: &Arc<DaemonState>) -> Vec<Value> {
        mailvault_core::app_db::with(&s.app_dir, |c| {
            let mut q = c.prepare("SELECT value FROM meta WHERE key LIKE 'compose_receipt:%'").map_err(|e| e.to_string())?;
            let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            rows.into_iter().map(|v| serde_json::from_str(&v).map_err(|e| e.to_string())).collect()
        }).unwrap()
    }

    // Missing custody must not erase native creation proof before the optimistic row arrives.
    #[tokio::test]
    async fn receipt_survives_stage_custody_failure_and_reopen() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        daemon_custody::close(&s);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let rows = persisted_receipts(&s);
        assert_eq!(rows.len(), 1, "stage must durably record exact native ownership even without custody");
        assert_eq!(rows[0]["state"], "present");
        assert_eq!(rows[0]["identity"]["uid"], staged["uid"]);
        assert_eq!(rows[0]["identity"]["messageId"], staged["messageId"]);
        let original = raw_of(&s, staged["uid"].as_u64().unwrap() as u32);
        let sent = ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({}))).await;
        assert_eq!(sent["success"], true);
        assert_eq!(server.sent_messages(), vec![original], "receipt proof sends the exact staged bytes while custody is closed");
        let reopened = DaemonState::for_test(s.app_dir.clone(), s.data_dir.clone(), true);
        assert_eq!(persisted_receipts(&reopened), rows);
        assert_eq!(proof_of(&reopened, &staged, None).unwrap().state, State::Present);
    }

    #[tokio::test]
    async fn receipt_survives_cleanup_before_the_optimistic_row() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st(true);
        let mut rx = s.events.subscribe();
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({"sentMailbox": "Sent"}))).await;
        assert_eq!(next_event(&mut rx, "send-server-append-complete").await["ok"], true);
        let rows = persisted_receipts(&s);
        assert_eq!(rows.len(), 1, "cleanup retains original exact proof");
        assert_eq!(rows[0]["state"], "cleaned");
        assert_eq!(rows[0]["identity"]["uid"], staged["uid"]);
        assert!(flags_of(&s, staged["uid"].as_u64().unwrap() as u32).is_none());
    }

    #[tokio::test]
    async fn receipt_refuses_same_mid_different_bytes_at_staged_uid() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let staged = ok(&s, "compose.stage", stage_params(account_json(&server))).await;
        let uid = staged["uid"].as_u64().unwrap() as u32;
        let mut foreign = raw_of(&s, uid);
        foreign.extend_from_slice(b"\r\nFOREIGN SAME MID");
        with_mailbox_write(&s, "acct-1", "Sent", |root| vault_files::store(&s.vault_registry, root, "acct-1", "Sent", uid, &foreign, &["seen".into()], true)).unwrap();
        let sent = ok(&s, "compose.send", send_params(account_json(&server), &staged, json!({}))).await;
        assert_ne!(server.sent_messages()[0], foreign, "duplicate MID does not prove staged byte ownership");
        assert_eq!(raw_of(&s, uid), foreign, "replacement is preserved");
        assert_ne!(sent["entry"]["uid"], staged["uid"]);
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

    /// `stage_params` and the matching `send_params` email under `subject`.
    async fn stage_with_subject(s: &Arc<DaemonState>, server: &MockImap, subject: &str) -> (Value, Value) {
        let mut stage = stage_params(account_json(server));
        stage["email"]["subject"] = json!(subject);
        let staged = ok(s, "compose.stage", stage).await;
        let mut send = send_params(account_json(server), &staged, json!({}));
        send["email"]["subject"] = json!(subject);
        (staged, send)
    }

    /// Several sends staged before the first goes (an outbox of queued
    /// sends): each one still sends the bytes of its own staged copy, not a
    /// rebuild with another Date and MIME boundary.
    #[tokio::test]
    async fn a_send_sends_its_own_staged_copy_while_more_are_staged() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let mut staged = Vec::new();
        for i in 0..4 {
            staged.push(stage_with_subject(&s, &server, &format!("Queued {i}")).await);
        }
        let (first, send) = &staged[0];
        let uid = first["uid"].as_u64().unwrap() as u32;
        let staged_raw = raw_of(&s, uid);

        ok(&s, "compose.send", send.clone()).await;

        let smtp = server.sent_messages();
        assert_eq!(smtp.len(), 1);
        assert_eq!(String::from_utf8_lossy(&smtp[0]), String::from_utf8_lossy(&staged_raw), "SMTP got the staged bytes");
    }

    /// The same email staged twice (sent again before the first went): the
    /// first send still goes out as its own staged copy.
    #[tokio::test]
    async fn the_same_email_staged_twice_sends_each_staged_copy() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let (a, send_a) = stage_with_subject(&s, &server, "Twice").await;
        let (b, send_b) = stage_with_subject(&s, &server, "Twice").await;
        let (raw_a, raw_b) = (raw_of(&s, a["uid"].as_u64().unwrap() as u32), raw_of(&s, b["uid"].as_u64().unwrap() as u32));

        ok(&s, "compose.send", send_a).await;
        ok(&s, "compose.send", send_b).await;

        let smtp = server.sent_messages();
        assert_eq!(smtp.len(), 2);
        assert_eq!(String::from_utf8_lossy(&smtp[0]), String::from_utf8_lossy(&raw_a), "the first send is the first copy");
        assert_eq!(String::from_utf8_lossy(&smtp[1]), String::from_utf8_lossy(&raw_b), "the second send is the second copy");
    }

    /// A retry after a refused send is the same message: the bytes of the
    /// staged copy again, not a rebuild with a new Date and boundary.
    #[tokio::test]
    async fn a_retried_send_sends_the_staged_copy_again() {
        plaintext();
        let server = MockImap::start(Scenario::new().smtp_refuse("partner@example.com"));
        let s = st(true);
        let (staged, send) = stage_with_subject(&s, &server, "Retried").await;
        let staged_raw = raw_of(&s, staged["uid"].as_u64().unwrap() as u32);
        assert!(rpc(&s, "compose.send", send.clone()).await.result.is_none(), "the first attempt is refused");

        let retry = MockImap::start(Scenario::new());
        let mut send = send;
        send["account"] = account_json(&retry);
        ok(&s, "compose.send", send).await;

        let smtp = retry.sent_messages();
        assert_eq!(smtp.len(), 1);
        assert_eq!(String::from_utf8_lossy(&smtp[0]), String::from_utf8_lossy(&staged_raw), "the retry sends the staged bytes");
    }

    /// The staged uid now holds another message B: A is staged at `uid`,
    /// B's bytes, flags and row are put there in its place. Answers B's raw
    /// bytes and row.
    fn put_foreign_message_at(s: &Arc<DaemonState>, uid: u32, b: &Value) -> (Vec<u8>, Value) {
        let foreign = raw_of(s, b["uid"].as_u64().unwrap() as u32);
        vault_files::store(&s.vault_registry, &s.data_dir, "acct-1", "Sent", uid, &foreign, &["seen".to_string()], true).unwrap();
        let mut row = b["entry"].clone();
        row["uid"] = json!(uid);
        row["flags"] = json!(["seen"]);
        daemon_custody::with_conn(s, |c| entries::upsert(c, "acct-1", "Sent", std::slice::from_ref(&row))).unwrap();
        (foreign, row)
    }

    /// The Sent copies of `message_id` on disk, other than at `uid`.
    fn copies_elsewhere(s: &Arc<DaemonState>, uid: u32, message_id: &str) -> Vec<u32> {
        vault_files::list_on_disk(&s.data_dir, "acct-1", "Sent", None)
            .expect("the Sent folder lists")
            .into_iter()
            .map(|m| m.uid)
            .filter(|&u| u != uid && bracketed_message_id(&raw_of(s, u)).as_deref() == Some(message_id))
            .collect()
    }

    /// `raw` is the message staged as "Mine" under `id`.
    fn assert_is_mine(raw: &[u8], id: &str) {
        let raw = String::from_utf8_lossy(raw).to_string();
        assert!(raw.contains(&format!("Message-ID: {id}\r\n")), "{raw}");
        assert!(raw.contains("Subject: Mine\r\n"), "{raw}");
    }

    /// The staged uid holds another message: that message is never sent in
    /// this one's place, and never rewritten, re-flagged or removed. The
    /// copy of what went out lives under a uid of its own.
    #[tokio::test]
    async fn a_staged_uid_that_holds_another_message_keeps_it() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let (a, send_a) = stage_with_subject(&s, &server, "Mine").await;
        let (b, _) = stage_with_subject(&s, &server, "Someone else's").await;
        let uid = a["uid"].as_u64().unwrap() as u32;
        let id_a = a["messageId"].as_str().unwrap();
        let (foreign, foreign_row) = put_foreign_message_at(&s, uid, &b);

        let sent = ok(&s, "compose.send", send_a).await;

        let smtp = server.sent_messages();
        assert_eq!(smtp.len(), 1);
        assert_is_mine(&smtp[0], id_a);
        assert_eq!(raw_of(&s, uid), foreign, "the other message's bytes stay");
        assert_eq!(flags_of(&s, uid), Some(vec!["seen".to_string()]), "and its flags");
        assert_eq!(row_of(&s, uid), Some(foreign_row), "and its row");
        let elsewhere = copies_elsewhere(&s, uid, id_a);
        assert_eq!(elsewhere.len(), 1, "the sent copy is kept under a uid of its own");
        assert_eq!(raw_of(&s, elsewhere[0]), smtp[0], "as the bytes that went out");
        assert_eq!(sent["entry"]["uid"], json!(elsewhere[0]));
        assert_eq!(row_of(&s, elsewhere[0]).unwrap()["message_id"], json!(id_a));
    }

    /// The same, when the server's Sent copy lands and the local one goes:
    /// what goes is this message's copy, never the message at the staged uid.
    #[tokio::test]
    async fn a_landed_sent_copy_never_removes_another_message_at_the_staged_uid() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st(true);
        let mut rx = s.events.subscribe();
        let (a, mut send_a) = stage_with_subject(&s, &server, "Mine").await;
        send_a["sentMailbox"] = json!("Sent");
        let (b, _) = stage_with_subject(&s, &server, "Someone else's").await;
        let uid = a["uid"].as_u64().unwrap() as u32;
        let id_a = a["messageId"].as_str().unwrap();
        let (foreign, foreign_row) = put_foreign_message_at(&s, uid, &b);

        let sent = ok(&s, "compose.send", send_a).await;
        let payload = next_event(&mut rx, "send-server-append-complete").await;

        assert_eq!(payload["ok"], json!(true), "{payload}");
        assert_is_mine(&server.sent_messages()[0], id_a);
        assert_eq!(raw_of(&s, uid), foreign, "the other message's bytes stay");
        assert_eq!(flags_of(&s, uid), Some(vec!["seen".to_string()]), "and its flags");
        assert_eq!(row_of(&s, uid), Some(foreign_row), "and its row");
        let own = sent["entry"]["uid"].as_u64().unwrap() as u32;
        assert_ne!(own, uid);
        assert_eq!(payload["stagedUid"], json!(own), "the event names the copy that went");
        assert!(copies_elsewhere(&s, uid, id_a).is_empty(), "this message's local copy went");
    }

    /// The staged copy is gone from the vault: the send rebuilds under the
    /// staged id, and the copy of what went out gets a uid of its own.
    #[tokio::test]
    async fn a_staged_copy_that_is_gone_is_rebuilt_and_kept_under_a_new_uid() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);
        let (a, send_a) = stage_with_subject(&s, &server, "Mine").await;
        let uid = a["uid"].as_u64().unwrap() as u32;
        let id_a = a["messageId"].as_str().unwrap();
        vault_files::delete(&s.vault_registry, &s.data_dir, "acct-1", "Sent", uid).unwrap();

        let sent = ok(&s, "compose.send", send_a).await;

        let smtp = server.sent_messages();
        assert_eq!(smtp.len(), 1);
        assert_is_mine(&smtp[0], id_a);
        assert!(!vault_files::exists(&s.data_dir, "acct-1", "Sent", uid), "nothing is written at the staged uid");
        let elsewhere = copies_elsewhere(&s, uid, id_a);
        assert_eq!(elsewhere.len(), 1, "the sent copy is kept under a uid of its own");
        assert_eq!(raw_of(&s, elsewhere[0]), smtp[0]);
        assert_eq!(sent["entry"]["uid"], json!(elsewhere[0]));
        assert_eq!(proof_of(&s, &a, None).unwrap().state, State::Cleaned);
        let mut replacement = a.clone(); replacement["uid"] = json!(elsewhere[0]);
        assert_eq!(proof_of(&s, &replacement, None).unwrap().state, State::Present);
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
