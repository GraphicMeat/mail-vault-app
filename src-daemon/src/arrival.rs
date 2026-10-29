//! Source-bound arrival presentation from the accepted sync change ring.
//! Only real delta UIDs may enter this path. The ring retains their original
//! account stamp and native mailbox owner, so a later same-ID account cannot
//! borrow an earlier arrival.

use crate::server::DaemonState;
use crate::sync_engine::ChangeRecord;
use crate::sync_observation::SourceKey;
use mailvault_core::{accounts_doc, arrival, custody::cache, notify_policy, settings_doc, verification_code};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Arc;

pub(crate) fn source_ref(source: &SourceKey) -> Option<String> {
    let owner = source.cache_owner.as_ref()?;
    let bytes = serde_json::to_vec(&json!({
        "account":source.account_id,"mailbox":source.mailbox,"epoch":source.epoch,
        "origin":source.origin_hash,"owner":owner,
    })).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

fn own_addresses(settings: Option<&Value>, account: &Value, account_id: &str) -> Vec<String> {
    let mut addresses = Vec::new();
    if let Some(email) = account.get("email").and_then(Value::as_str) {
        addresses.push(email.to_owned());
    }
    let state = settings.and_then(|document| document.get("mailvault-settings"))
        .and_then(|root| root.get("state"));
    if let Some(send_as) = state.and_then(|state| state.get("sendAsAddresses"))
        .and_then(|rows| rows.get(account_id)).and_then(Value::as_str) {
        addresses.push(send_as.to_owned());
    }
    if let Some(aliases) = state.and_then(|state| state.get("aliases"))
        .and_then(|rows| rows.get(account_id)).and_then(Value::as_array) {
        addresses.extend(aliases.iter().filter_map(|alias| alias.get("address")
            .and_then(Value::as_str).map(str::to_owned)));
    }
    addresses
}

fn prepare_one(state: &DaemonState, change: &ChangeRecord,
    code_eligible: bool, wake_reference: Option<&str>) -> Option<Prepared> {
    let source = change.source.as_ref()?;
    // This short lease stays in the actual blocking preparation child through
    // the native owner check and bounded claim.
    let lease = crate::sync_observation::source_lease(state,
        &source.original, &source.origin_hash).ok()?;
    prepare_one_under_lease(state, change, code_eligible, wake_reference, &lease)
}

fn prepare_one_under_lease(state: &DaemonState, change: &ChangeRecord,
    code_eligible: bool, wake_reference: Option<&str>,
    _lease: &crate::account_workflows::AccountLease) -> Option<Prepared> {
    let source = change.source.as_ref()?;
    let reference = wake_reference.map(str::to_owned).or_else(|| source_ref(source))?;
    if change.arrival_uids.is_empty() { return None; }
    let owner = source.cache_owner.as_ref()?;
    let account = accounts_doc::list(&accounts_doc::shared(&state.app_dir)).ok()?.accounts
        .into_iter().find(|row| row.get("id").and_then(Value::as_str) == Some(&source.account_id))?;
    let account_email = account.get("email").and_then(Value::as_str).unwrap_or("").to_owned();
    let mut uids = Vec::new();
    let mut unique = HashSet::new();
    for uid in &change.arrival_uids {
        if *uid > 0 && unique.insert(*uid) { uids.push(*uid); }
    }
    if uids.is_empty() { return None; }
    let preview_uid = if source.graph { *uids.first()? } else { *uids.iter().max()? };
    let header = crate::custody::with_conn(state, |conn| {
        if cache::native_identity(conn, &source.account_id, &source.mailbox)?.as_ref() != Some(owner) {
            return Err("errors.bulkIdentityChanged".to_owned());
        }
        Ok(cache::load_by_uids(conn, &source.account_id, &source.mailbox, &[preview_uid])?
            .into_iter().find(|row| row.get("uid").and_then(Value::as_u64) == Some(u64::from(preview_uid))))
    }).ok()?;
    let preview = header.as_ref().and_then(arrival::preview);
    let settings = settings_doc::SettingsDoc::shared(&state.app_dir).read().ok();
    let saved = settings.as_deref().and_then(|document| document.get("mailvault-settings"))
        .and_then(|root| root.get("state"));
    let notification = saved.and_then(|state| state.get("notificationSettings"));
    let show_preview = notification.and_then(|value| value.get("showPreview"))
        .and_then(Value::as_bool).unwrap_or(true);
    let sound = arrival::normalized_sound(notification.and_then(|value| value.get("sound"))
        .and_then(Value::as_str));
    let own = own_addresses(settings.as_deref(), &account, &source.account_id);
    let sent = account.get("sentFolderOverride").and_then(Value::as_str);
    let special_sent = header.as_ref().and_then(|row| row.get("_specialUse"))
        .and_then(Value::as_str) == Some("\\Sent");
    let banner_allowed = arrival::banner_allowed(uids.len(), &source.mailbox, sent, special_sent,
        preview.as_ref().map_or("", |row| row.from_address.as_str()), &own);
    let focus_until = settings.as_deref().and_then(|document| document.get("mailvault-focus"))
        .and_then(|root| root.get("state")).and_then(|state| state.get("endsAt"))
        .and_then(Value::as_i64).unwrap_or(0);
    let focus_held = focus_until > chrono::Utc::now().timestamp_millis();
    let from = preview.as_ref().map_or("", |row| row.from_address.as_str());
    let context = notify_policy::Ctx {
        account_id: Some(source.account_id.clone()), folder: Some(json!(source.mailbox)),
        from: from.to_owned(), domain: from.split_once('@').map_or("", |(_, domain)| domain).to_owned(),
        view_ids: None, focus_held,
    };
    let decision = notify_policy::decide(&context, &notify_policy::policy_from_state(saved),
        notify_policy::local_minutes_now());
    let allowed_by_policy = decision.deliver || decision.reason == notify_policy::FOCUS_HOLD;
    let subject = preview.as_ref().and_then(|row| row.subject.as_deref()).unwrap_or("");
    let snippet = preview.as_ref().and_then(|row| row.snippet.as_deref()).unwrap_or("");
    let code = if code_eligible && source.mailbox.eq_ignore_ascii_case("INBOX") {
        verification_code::find_verification_code(subject, snippet)
    } else { None };
    // A code offer is independent of banner policy, but only a proven cached
    // arrival UID may start its child. A muted banner spends no banner bit.
    let needs_body = code_eligible && code.is_none() && preview.is_some()
        && source.mailbox.eq_ignore_ascii_case("INBOX")
        && verification_code::body_may_hold_code(subject, snippet);
    let code_uid = preview.as_ref().filter(|_| code.is_some() || needs_body).map(|row| row.uid);
    // The last owner check and announcement claim share one custody hold.
    // A mailbox replacement cannot land between those two operations.
    let (banner_claimed, code_claimed) = crate::custody::with_conn(state, |conn| {
        if cache::native_identity(conn, &source.account_id, &source.mailbox)?.as_ref() != Some(owner) {
            return Err("errors.bulkIdentityChanged".to_owned());
        }
        Ok(state.recent.claim_native(&reference, &source.account_id,
            &source.mailbox, &uids, code_uid, banner_allowed && allowed_by_policy))
    }).ok()?;
    let log_policy = banner_allowed && !allowed_by_policy;
    if !banner_claimed && !code_claimed && !log_policy { return None; }
    let presentation = arrival::presentation(uids.len(), &account_email, show_preview,
        preview.as_ref(), code.as_deref());
    let mut target = json!({"accountId":source.account_id,"mailbox":source.mailbox});
    if show_preview {
        if let Some(row) = preview.as_ref() {
            target["uid"] = json!(row.uid);
            if uids.len() == 1 {
                if let Some(code) = code.as_deref() { target["code"] = json!(code); }
            }
        }
    }
    let notice = json!({
        "id":uuid::Uuid::new_v4().to_string(), "instanceId":state.refresh.instance_id(),
        "changeGen":change.gen,"sourceRef":reference,"accountId":source.account_id,
        "mailbox":source.mailbox,"uids":uids,
        "from":preview.as_ref().and_then(|row| row.sender.as_deref()).unwrap_or(""),
        "fromAddress":from,"banner":banner_claimed,"logPolicy":log_policy,
        "deliver":banner_claimed && decision.deliver,"reason":decision.reason,
        "presentation":presentation,"target":target,"sound":sound,
        "codeReady":(code_claimed && code.is_some()).then(|| json!({"uid":preview_uid,"code":code})),
    });
    let child = if code_claimed && needs_body {
        Some(CodeChild {
            source: source.clone(), uid: preview_uid,
            message_id: header.as_ref().and_then(|row| row.get("messageId"))
                .and_then(Value::as_str).map(str::to_owned),
            subject: subject.to_owned(), notice: notice.clone(),
            immediate: uids.len() != 1 || !banner_claimed,
        })
    } else { None };
    Some(Prepared { immediate: child.as_ref().is_none_or(|child| child.immediate),
        notice, child })
}

/// Bounded ring records only. This child performs no provider I/O; provider
/// body work, when required, is spawned separately and cannot delay repaint.
pub(crate) async fn prepare_changes(state: &Arc<DaemonState>, changes: &[ChangeRecord]) -> Vec<Value> {
    let state = Arc::clone(state);
    let mut groups: Vec<ChangeRecord> = Vec::new();
    for change in changes.iter().filter(|change| !change.arrival_uids.is_empty()) {
        if let Some(previous) = groups.iter_mut().find(|previous| previous.source.is_some()
            && previous.source == change.source) {
            previous.arrival_uids.extend(&change.arrival_uids);
            previous.gen = change.gen;
        } else if change.source.is_some() {
            groups.push(change.clone());
        }
    }
    // The actual preparation and any code child outlive a dropped long-poll
    // waiter. A lost reply may lose its banner, but it cannot release a claim
    // halfway through or start a second provider child on a retry.
    tokio::spawn(async move {
        let prepared: Vec<Prepared> = tokio::task::spawn_blocking({
            let state = Arc::clone(&state);
            move || groups.iter().filter_map(|change| prepare_one(&state, change, true, None)).collect()
        }).await.unwrap_or_default();
        let mut ready = Vec::new();
        for item in prepared {
            if item.immediate { ready.push(item.notice.clone()); }
            if let Some(child) = item.child {
                if let Ok(permit) = CODE_SLOTS.try_acquire() {
                    let state = Arc::clone(&state);
                    tokio::spawn(async move { run_code_child(state, child, permit).await });
                } else if !item.immediate && item.notice["banner"] == true {
                    // Optional body work is bounded. A proven banner is not
                    // lost solely because all code slots are occupied.
                    ready.push(item.notice);
                }
            }
        }
        ready
    }).await.unwrap_or_default()
}

const CODE_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
const CODE_BODY_LIMIT: usize = 32;
static CODE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(CODE_BODY_LIMIT);

struct Prepared {
    notice: Value,
    immediate: bool,
    child: Option<CodeChild>,
}

struct CodeChild {
    source: SourceKey,
    uid: u32,
    message_id: Option<String>,
    subject: String,
    notice: Value,
    immediate: bool,
}

fn valid_source(state: &DaemonState, source: &SourceKey, uid: u32,
    message_id: Option<&str>) -> Result<(), String> {
    let _lease = crate::sync_observation::source_lease(state, &source.original, &source.origin_hash)?;
    let owner = source.cache_owner.as_ref().ok_or("errors.bulkIdentityUncertain")?;
    crate::custody::with_conn(state, |conn| {
        if cache::native_identity(conn, &source.account_id, &source.mailbox)?.as_ref() != Some(owner) {
            return Err("errors.bulkIdentityChanged".to_owned());
        }
        let row = cache::load_by_uids(conn, &source.account_id, &source.mailbox, &[uid])?
            .into_iter().find(|row| row.get("uid").and_then(Value::as_u64) == Some(u64::from(uid)))
            .ok_or("errors.bulkIdentityChanged")?;
        let current_id = row.get("messageId").and_then(Value::as_str);
        if let Some(expected) = message_id {
            if current_id.and_then(cache::message_id_key) != cache::message_id_key(expected) {
                return Err("errors.bulkIdentityChanged".to_owned());
            }
        }
        Ok(())
    })
}

async fn source_still_valid(state: &Arc<DaemonState>, child: &CodeChild) -> bool {
    let state = Arc::clone(state);
    let source = child.source.clone();
    let uid = child.uid;
    let message_id = child.message_id.clone();
    tokio::task::spawn_blocking(move || valid_source(&state, &source, uid, message_id.as_deref()))
        .await.is_ok_and(|answer| answer.is_ok())
}

async fn emit_if_current(state: &Arc<DaemonState>, child: &CodeChild,
    event: &str, payload: Value) {
    let state = Arc::clone(state);
    let source = child.source.clone();
    let uid = child.uid;
    let message_id = child.message_id.clone();
    let event = event.to_owned();
    let _ = tokio::task::spawn_blocking(move || {
        valid_source(&state, &source, uid, message_id.as_deref())?;
        state.events.emit(&event, payload);
        Ok::<(), String>(())
    }).await;
}

fn remember_original(state: &DaemonState, source: &SourceKey, uid: u32,
    raw: Vec<u8>) -> Result<(), String> {
    let _lease = crate::sync_observation::source_lease(state,
        &source.original, &source.origin_hash)?;
    let owner = source.cache_owner.as_ref().ok_or("errors.bulkIdentityUncertain")?;
    crate::custody::with_conn(state, |conn| {
        if cache::native_identity(conn, &source.account_id, &source.mailbox)?.as_ref() != Some(owner) {
            return Err("errors.bulkIdentityChanged".to_owned());
        }
        let row = cache::load_by_uids(conn, &source.account_id, &source.mailbox, &[uid])?
            .into_iter().find(|row| row.get("uid").and_then(Value::as_u64) == Some(u64::from(uid)))
            .ok_or("errors.bulkIdentityChanged")?;
        
        state.raw_messages.remember(&source.original, &source.mailbox, uid, raw);
        Ok(())
    })
}

async fn body_code(state: &Arc<DaemonState>, child: &CodeChild) -> Option<String> {
    if !source_still_valid(state, child).await { return None; }
    let config = crate::oauth_tokens::resolve(state, &child.source.account_id,
        crate::oauth_tokens::Read::Guarded).await.ok()?;
    if mailvault_core::bulk_worker::origin_hash(&config) != child.source.origin_hash
        || !source_still_valid(state, child).await { return None; }
    let uid = child.uid;
    let source = &child.source;
    let (mut email, raw, dated, ids, fetched_id) = if source.graph {
        let root = state.data_dir.clone();
        let account = source.account_id.clone();
        let mailbox = source.mailbox.clone();
        let id = tokio::task::spawn_blocking(move || {
            let path = mailvault_core::header_cache::sidecar_dir(&root, &account, &mailbox)
                .join(mailvault_core::graph_ledger::LEDGER_FILE);
            mailvault_core::graph_ledger::load(&path).ok()?.get(&uid).cloned()
        }).await.ok().flatten()?;
        let token = config.access_token.as_deref()?;
        let message = mailvault_core::graph::GraphClient::for_purpose(token, "open message")
            .get_message(&id).await.ok()?;
        if message.id != id { return None; }
        let body = message.body?;
        let content = body.content.unwrap_or_default();
        let html = body.content_type.as_deref().is_some_and(|kind| kind.eq_ignore_ascii_case("html"));
        (json!({"text":if html { None } else { Some(content.clone()) },
            "html":if html { Some(content) } else { None }}),
            None, None, None, message.internet_message_id)
    } else if config.uses_jmap() {
        let rows = crate::handlers::jmap_bridge::fetch_by_uids(state, &config,
            &source.account_id, &source.mailbox, &[uid]).await.ok()?;
        let (_, body) = rows.into_iter().find(|(found, _)| *found == uid)?;
        let body = body.ok()?;
        let parsed = mailvault_core::vault_eml::parse_eml_bytes_light(&body.raw, uid, body.flags).ok()?;
        let dated = crate::handlers::jmap_bridge::dated_ms(&body.raw, body.received_at.as_deref());
        let fetched_id = parsed.message_id.clone();
        (json!(parsed), Some(body.raw), dated, Some(body.ids), fetched_id)
    } else {
        let mailbox = source.mailbox.clone();
        let validity = source.cache_owner.as_ref()?.uid_validity;
        let timings = std::sync::Mutex::new(crate::imap::pool::ReadTimings::default());
        let fetch = state.imap_pool.run_read_timed(&config, false, |mut session| {
            let mailbox = mailbox.clone();
            let timings = &timings;
            async move {
                let body = crate::imap::fetch_email_by_uid_light_timed_owned(
                    &mut session, &mailbox, uid, validity, timings).await?;
                Ok((body, session, Some(mailbox)))
            }
        }, Some(&timings));
        let body = tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, fetch)
            .await.ok()?.ok()??;
        if body.uid != uid { return None; }
        let dated = crate::handlers::imap::email_date_ms(body.date.as_deref(),
            body.internal_date.as_deref());
        let fetched_id = body.message_id.clone();
        let raw = body.raw_source_bytes.clone();
        (json!(body), Some(raw), dated, None, fetched_id)
    };
    if let Some(expected) = child.message_id.as_deref() {
        let found = fetched_id.as_deref()?;
        if cache::message_id_key(expected) != cache::message_id_key(found) { return None; }
    }
    if !source_still_valid(state, child).await { return None; }
    if let Some(raw) = raw {
        let cached = crate::handlers::imap::auto_cache_original(state, source, uid,
            raw.clone(), dated, ids).await.ok()?;
        if !cached {
            let state = Arc::clone(state);
            let source = source.clone();
            let raw_memory = raw.clone();
            tokio::task::spawn_blocking(move || remember_original(&state, &source, uid, raw_memory))
                .await.ok()?.ok()?;
        }
        if !source_still_valid(state, child).await { return None; }
        let state2 = Arc::clone(state);
        let original = source.clone();
        if let Ok((bytes, status)) = tokio::task::spawn_blocking(move ||
            crate::handlers::pgp::render_original(&state2, &original, uid, raw, cached)).await {
            crate::handlers::pgp::overlay(&mut email, &bytes, uid, status);
        }
    }
    if !source_still_valid(state, child).await { return None; }
    let subject = child.subject.as_str();
    let text = email.get("text").and_then(Value::as_str).map(str::to_owned)
        .unwrap_or_else(|| mailvault_core::search_index::text::html_to_text(
            email.get("html").and_then(Value::as_str).unwrap_or("")));
    verification_code::find_verification_code(subject, &text)
}

async fn run_code_child(state: Arc<DaemonState>, child: CodeChild,
    _permit: tokio::sync::SemaphorePermit<'static>) {
    let mut fetch = Box::pin(body_code(&state, &child));
    let mut notice_sent = child.immediate;
    let code = if child.immediate {
        fetch.await
    } else {
        match tokio::time::timeout(CODE_WAIT, &mut fetch).await {
            Ok(code) => code,
            Err(_) => {
                if child.notice["banner"] == true {
                    emit_if_current(&state, &child, "notify", child.notice.clone()).await;
                }
                notice_sent = true;
                fetch.await
            }
        }
    };
    if !notice_sent && child.notice["banner"] == true {
        let mut notice = child.notice.clone();
        if let Some(code) = code.as_deref() {
            if notice["presentation"]["kind"] == "singlePreview" {
                notice["presentation"]["key"] = json!("notify.arrival.singlePreviewCode");
                notice["presentation"]["data"]["code"] = json!(code);
                notice["target"]["code"] = json!(code);
            }
        }
        emit_if_current(&state, &child, "notify", notice).await;
    }
    if let Some(code) = code {
        let ready = json!({
            "id":uuid::Uuid::new_v4().to_string(),"noticeId":child.notice["id"],
            "instanceId":state.refresh.instance_id(),"changeGen":child.notice["changeGen"],
            "sourceRef":child.notice["sourceRef"],"accountId":child.source.account_id,
            "mailbox":child.source.mailbox,"uid":child.uid,"code":code,
            "sender":child.notice["from"],
            "subject":child.notice["presentation"]["data"]["subject"],
        });
        emit_if_current(&state, &child, "code-ready", ready).await;
    }
}

/// A local wake never derives its UID from the saved COPYUID hint. The
/// persisted Message-ID must resolve to exactly one row under the original
/// cache owner, then the usual policy/presentation path runs without code IO.
pub(crate) async fn prepare_local_wake(state: &Arc<DaemonState>, snooze_id: &str,
    proof: crate::recent_actions::WakeProof) -> Result<Value, &'static str> {
    let state = Arc::clone(state);
    let snooze_id = snooze_id.to_owned();
    tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            let source = proof.source;
            let owner = source.cache_owner.as_ref().ok_or("stale-source")?;
            let _lease = crate::sync_observation::source_lease(&state,
                &source.original, &source.origin_hash).map_err(|_| "stale-source")?;
            let uid = crate::custody::with_conn(&state, |conn| {
                if cache::native_identity(conn, &source.account_id, &source.mailbox)?.as_ref() != Some(owner) {
                    return Err("errors.bulkIdentityChanged".to_owned());
                }
                cache::unique_uid_by_message_id(conn, &source.account_id,
                    &source.mailbox, &proof.message_id)
            }).map_err(|error| if error == "ambiguous-message" { "ambiguous-message" }
                else if error == "errors.bulkIdentityChanged" { "stale-source" }
                else { "missing-message" })?.ok_or("missing-message")?;
            let reference = format!("{}:wake:{}:{}", source_ref(&source).ok_or("stale-source")?,
                snooze_id, proof.generation);
            let change = ChangeRecord {
                gen:proof.generation, account_id:source.account_id.clone(),
                mailbox:source.mailbox.clone(), new_emails:1, updated_flags:0,
                arrival_uids:vec![uid], source:Some(source), at:0,
            };
            prepare_one_under_lease(&state, &change, false, Some(&reference), &_lease)
                .map(|prepared| prepared.notice).ok_or("stale-source")
        }).await.map_err(|_| "stale-source")?
    }).await.map_err(|_| "stale-source")?
}
