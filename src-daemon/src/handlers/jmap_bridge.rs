//! The JMAP bridge: a JMAP account's `imap_*` RPCs answered over JMAP, in one
//! place. `handlers::imap::route` (and `handlers::smtp::route`, for
//! `smtp_test_connection`) call `intercept` before their own `match`; it
//! answers when the `account` param is a JMAP account (`uses_jmap`) and
//! returns `None` otherwise, so IMAP accounts never reach this file.
//!
//! A JMAP account never falls through to the IMAP arms: an `imap_*` RPC this
//! file cannot answer yet is an `E_JMAP_UNSUPPORTED` error, never an IMAP
//! login to `imapHost` with the account's token.
//!
//! Every answer has the JSON shape of the IMAP arm it stands in for. Uids
//! come from the mailbox's JMAP ledger (`jmap_sessions`); `uidValidity` is
//! always 1, because ledger uids are never renumbered.

use crate::handlers::common::{blocking, vault_root};
use crate::handlers::imap::{auto_cache, backfill_refusal, email_date_ms, opened_intent, SearchFilters, BODY_FETCH_TIMEOUT};
use crate::imap::{EmailHeader, ImapConfig, MailboxStatus, MessageIdLocation, MessageIdProbe};
use crate::ipc::{self, RpcResponse};
use crate::jmap_sessions::{in_mailbox, jmap_ledger_path, AccountJmap, JmapMeta};
use crate::server::DaemonState;
use mailvault_core::graph_ledger;
use mailvault_core::jmap::headers::{keywords_to_flags, to_header, HEADER_PROPS};
use mailvault_core::jmap::{JmapClient, JmapError};
use mailvault_core::vault_eml;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tracing::{info, warn};

/// Every `imap_*` RPC answered over JMAP.
pub const HANDLED: &[&str] = &[
    "imap_test_connection",
    "imap_get_mailboxes",
    "imap_get_emails",
    "imap_check_mailbox_status",
    "imap_folder_status",
    "imap_search_all_uids",
    "imap_fetch_headers_by_uids",
    "imap_fetch_changed_flags",
    "imap_get_email",
    "imap_get_email_light",
    "imap_search_emails",
    "imap_find_message_id",
    "imap_disconnect",
];

/// `imap_*` RPCs a JMAP account is refused, with why. Must be empty at the
/// end of Task 5b, or each row justified.
pub const UNSUPPORTED: &[(&str, &str)] = &[
    ("imap_set_flags", "not answered over JMAP yet (Task 5b)"),
    ("imap_delete_email", "not answered over JMAP yet (Task 5b)"),
    ("imap_move_emails", "not answered over JMAP yet (Task 5b)"),
    ("imap_ensure_sent_mailbox", "not answered over JMAP yet (Task 5b)"),
    ("imap_create_mailbox", "not answered over JMAP yet (Task 5b)"),
    ("imap_rename_mailbox", "not answered over JMAP yet (Task 5b)"),
    ("imap_delete_mailbox", "not answered over JMAP yet (Task 5b)"),
];

/// `Email/query` page size for whole-mailbox walks: far below the 2^53-1
/// JMAP `UnsignedInt` ceiling a "give me everything" limit would cross.
const QUERY_PAGE: usize = 1000;
/// The IMAP search arm keeps the newest 200 matches; so does this.
const SEARCH_LIMIT: usize = 200;
/// How many copies of one Message-ID the probe looks at.
const FIND_LIMIT: usize = 50;

/// Why an answer failed: bad params (`INVALID_PARAMS`) or anything else.
enum Fail {
    Params(String),
    Rpc(String),
}

impl From<String> for Fail {
    fn from(e: String) -> Fail {
        Fail::Rpc(e)
    }
}

impl From<JmapError> for Fail {
    fn from(e: JmapError) -> Fail {
        Fail::Rpc(e.to_string())
    }
}

/// An expired or revoked session: forget it and connect once more.
fn is_auth_failure(f: &Fail) -> bool {
    matches!(f, Fail::Rpc(e) if e.starts_with(&format!("{}:", JmapError::Unauthorized.code())))
}

fn param<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T, Fail> {
    params
        .get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| Fail::Params(format!("Missing {key}")))
}

fn opt_param<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).and_then(|v| serde_json::from_value(v.clone()).ok())
}

fn mailbox_param(params: &Value) -> String {
    opt_param::<String>(params, "mailbox").unwrap_or_else(|| "INBOX".to_string())
}

/// The app's account id, which names the vault and ledger dirs: `accountId`,
/// else `account.id`. Never the address: a ledger kept under a second key
/// would issue uids that collide with the vault files of the first.
fn ledger_account(params: &Value) -> Result<String, Fail> {
    opt_param::<String>(params, "accountId")
        .or_else(|| params.get("account").and_then(|a| a.get("id")).and_then(Value::as_str).map(str::to_string))
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| Fail::Params("Missing accountId".to_string()))
}

/// Answer `method` over JMAP when `params.account` is a JMAP account, else
/// `None` (the caller's own arms answer it).
pub async fn intercept(state: &Arc<DaemonState>, method: &str, id: &Value, params: &Value) -> Option<RpcResponse> {
    if !method.starts_with("imap_") && method != "smtp_test_connection" {
        return None;
    }
    let account: ImapConfig = params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok())?;
    if !account.uses_jmap() {
        return None;
    }
    let id = id.clone();
    Some(match method {
        // Sending goes through JMAP (Task 8): there is no SMTP server to test.
        "smtp_test_connection" => RpcResponse::success(id, json!({"success": true})),
        "imap_test_connection" => test_connection(&account, id).await,
        "imap_disconnect" => {
            state.jmap.forget(&account);
            RpcResponse::success(id, json!({"success": true}))
        }
        m if HANDLED.contains(&m) => match answer_with_retry(state, m, params, &account).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(Fail::Params(e)) => RpcResponse::error(id, ipc::INVALID_PARAMS, e),
            Err(Fail::Rpc(e)) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        m => {
            let reason = UNSUPPORTED.iter().find(|(name, _)| *name == m).map_or("not answered over JMAP", |(_, r)| r);
            RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("E_JMAP_UNSUPPORTED: {m}: {reason}"))
        }
    })
}

/// `answer` on the account's session; an authentication failure on a cached
/// session (token revoked, session expired) forgets it and runs once more on
/// a fresh connect. Every bridged read is safe to run twice.
async fn answer_with_retry(state: &Arc<DaemonState>, method: &str, params: &Value, account: &ImapConfig) -> Result<Value, Fail> {
    let acct = state.jmap.get(account).await?;
    match answer(state, method, params, account, &acct).await {
        Err(f) if is_auth_failure(&f) => {
            state.jmap.forget(account);
            let acct = state.jmap.get(account).await?;
            answer(state, method, params, account, &acct).await
        }
        other => other,
    }
}

/// `imap_test_connection` over JMAP: connect fresh (never the cached
/// session, so it proves the credentials as typed) and list the mailboxes.
async fn test_connection(account: &ImapConfig, id: Value) -> RpcResponse {
    let url = account.jmap_session_url.as_deref().unwrap_or_default().trim().to_string();
    let (host, port) = url::Url::parse(&url)
        .ok()
        .map(|u| (u.host_str().unwrap_or_default().to_string(), u.port_or_known_default().unwrap_or(443)))
        .unwrap_or_else(|| (account.host.clone(), 443));
    info!("[test-connection] Testing JMAP {} → {}:{}", account.email, host, port);
    let reached = async {
        let auth = account.jmap_auth().ok_or(JmapError::Unauthorized)?;
        let client = JmapClient::connect(&url, auth, &account.email).await?;
        let (list, _) = client.mailboxes().await?;
        Ok::<_, JmapError>(
            list.iter()
                .find(|m| m.role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case("inbox")))
                .map(|m| m.total_emails),
        )
    }
    .await;
    match reached {
        Ok(message_count) => RpcResponse::success(
            id,
            json!({
                "success": true,
                "message": "Connection successful",
                "host": host,
                "port": port,
                "messageCount": message_count,
                "fromAddress": account.from_address(),
            }),
        ),
        Err(e) => RpcResponse::success(id, super::failed_connection_test_with_code(&e.to_string(), e.code(), &host, port)),
    }
}

/// Email ids -> uids in `mailbox`. A page lists newest first; the ledger is
/// handed it oldest first, so the uids one listing issues follow arrival.
async fn uids_for(
    state: &Arc<DaemonState>,
    acct: &AccountJmap,
    account_id: &str,
    mailbox: &str,
    ids: &[String],
) -> Result<HashMap<String, u32>, Fail> {
    let oldest_first: Vec<String> = ids.iter().rev().cloned().collect();
    let uids = acct.ids_to_uids(state, account_id, mailbox, &oldest_first).await?;
    Ok(oldest_first.into_iter().zip(uids).collect())
}

/// One uid above every uid the mailbox's ledger has issued.
async fn uid_next(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Result<u32, Fail> {
    let path = jmap_ledger_path(&vault_root(state)?, account_id, mailbox);
    let ledger = blocking(move || graph_ledger::load(&path)).await??;
    Ok(ledger.keys().next_back().map_or(1, |uid| uid.saturating_add(1)))
}

/// The mailbox's counter (`JmapMeta::modseq`), and what changed after
/// `since` when asked. Custody unavailable reads as counter 0 and "cannot
/// tell": the caller then answers every uid, which is slower, never wrong.
async fn meta_read(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, since: Option<u64>) -> (u64, Option<Vec<u32>>) {
    let (st, aid, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    let read = blocking(move || {
        crate::custody::with_conn(&st, |conn| {
            Ok((JmapMeta::modseq(conn, &aid, &mb), since.and_then(|s| JmapMeta::changed_since(conn, &aid, &mb, s))))
        })
    })
    .await;
    match read {
        Ok(Ok(v)) => v,
        Ok(Err(e)) | Err(e) => {
            warn!("[jmap] {}/{}: modseq unreadable: {}", account_id, mailbox, e);
            (0, None)
        }
    }
}

/// Every email id in the mailbox, newest first, paged by `QUERY_PAGE`.
async fn all_ids(acct: &AccountJmap, mailbox_id: &str) -> Result<Vec<String>, JmapError> {
    let mut ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut position = 0;
    loop {
        let (page, total) = acct.client.query_mailbox(mailbox_id, position, QUERY_PAGE).await?;
        let got = page.len();
        position += got;
        ids.extend(page.into_iter().filter(|id| seen.insert(id.clone())));
        if got < QUERY_PAGE || total.is_some_and(|t| position >= t) {
            return Ok(ids);
        }
    }
}

/// `Email/query` with any filter, newest first: up to `limit` ids and the
/// total match count.
async fn query_ids(client: &JmapClient, filter: Value, limit: usize) -> Result<(Vec<String>, usize), JmapError> {
    let args = json!({
        "accountId": client.account_id(),
        "filter": filter,
        "sort": [{"property": "receivedAt", "isAscending": false}],
        "position": 0,
        "limit": limit,
        "calculateTotal": true,
    });
    let out = client.call(vec![json!(["Email/query", args, "q"])]).await?;
    let r = out
        .into_iter()
        .find(|r| r[0] == "Email/query")
        .ok_or_else(|| JmapError::Protocol("no Email/query response".into()))?;
    let ids: Vec<String> = r[1]["ids"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let total = r[1]["total"].as_u64().map_or(ids.len(), |t| t as usize);
    Ok((ids, total))
}

/// `Email/get` objects by id (the server's list order is not the request's).
fn by_id(list: Vec<Value>) -> HashMap<String, Value> {
    list.into_iter().filter_map(|e| e["id"].as_str().map(str::to_string).map(|id| (id, e))).collect()
}

/// The mailbox at `path`, with its counts, from a fresh `Mailbox/get`.
async fn mailbox_counts(acct: &AccountJmap, path: &str) -> Result<mailvault_core::jmap::JMailbox, Fail> {
    let boxes = acct.refresh().await?;
    let missing = || Fail::from(JmapError::Protocol(format!("no mailbox {path}")));
    let id = boxes.ids.get(path).ok_or_else(missing)?;
    boxes.list.into_iter().find(|m| &m.id == id).ok_or_else(missing)
}

/// A message body fetched by uid.
struct Fetched {
    raw: Vec<u8>,
    flags: Vec<String>,
    received_at: Option<String>,
}

/// The raw message behind `uid` in `mailbox`, `None` when it is gone: the
/// ledger never issued the uid, the email no longer exists, or it left the
/// mailbox. One `Email/get` both finds the blob and re-checks membership.
async fn fetch_body(state: &Arc<DaemonState>, acct: &AccountJmap, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<Fetched>, Fail> {
    let pairs = acct.uid_to_id(state, account_id, mailbox, &[uid], false).await?;
    let Some(email_id) = pairs.into_iter().next().and_then(|(_, id)| id) else { return Ok(None) };
    let mailbox_id = acct.mailbox_id(mailbox).await?;
    let got = acct.client.get_emails(&[email_id.clone()], &["id", "blobId", "mailboxIds", "keywords", "receivedAt"]).await?;
    let Some(email) = by_id(got.list).remove(&email_id) else { return Ok(None) };
    if !in_mailbox(&email, &mailbox_id) {
        return Ok(None);
    }
    let blob_id = email["blobId"]
        .as_str()
        .ok_or_else(|| Fail::from(JmapError::Protocol("Email/get without blobId".into())))?;
    let raw = acct.client.download(blob_id).await?;
    Ok(Some(Fetched {
        raw,
        flags: keywords_to_flags(&email["keywords"]),
        received_at: email["receivedAt"].as_str().map(str::to_string),
    }))
}

/// `fetch_body` under the IMAP arms' body ceiling.
async fn fetch_body_timed(state: &Arc<DaemonState>, acct: &AccountJmap, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<Fetched>, Fail> {
    match tokio::time::timeout(BODY_FETCH_TIMEOUT, fetch_body(state, acct, account_id, mailbox, uid)).await {
        Ok(r) => r,
        Err(_) => Err(Fail::Rpc(format!(
            "Timed out after {}s fetching message UID {} from {}",
            BODY_FETCH_TIMEOUT.as_secs(),
            uid,
            mailbox
        ))),
    }
}

/// `YYYY-MM-DD` as the UTC midnight JMAP's `after`/`before` compare against.
fn day_start(day: Option<&str>) -> Option<String> {
    let day = chrono::NaiveDate::parse_from_str(day?.trim(), "%Y-%m-%d").ok()?;
    Some(format!("{}T00:00:00Z", day.format("%Y-%m-%d")))
}

/// One bridged read. Returns the success payload; `E_UID_GONE:` and every
/// other failure are `Fail`s.
async fn answer(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    account: &ImapConfig,
    acct: &Arc<AccountJmap>,
) -> Result<Value, Fail> {
    match method {
        "imap_get_mailboxes" => {
            let boxes = acct.refresh().await?;
            Ok(json!({"success": true, "mailboxes": boxes.infos}))
        }

        "imap_get_emails" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let page: u32 = opt_param(params, "page").unwrap_or(1);
            let limit: u32 = opt_param(params, "limit").unwrap_or(200);
            let mailbox_id = acct.mailbox_id(&mailbox).await?;
            let position = page.saturating_sub(1) as usize * limit as usize;
            let (ids, total) = acct.client.query_mailbox(&mailbox_id, position, limit as usize).await?;
            let total = total.unwrap_or(position + ids.len());
            let uids = uids_for(state, acct, &account_id, &mailbox, &ids).await?;
            let mut got = by_id(acct.client.get_emails(&ids, HEADER_PROPS).await?.list);
            let emails: Vec<EmailHeader> =
                ids.iter().filter_map(|id| Some(to_header(&got.remove(id)?, *uids.get(id)?))).collect();
            Ok(json!({
                "success": true, "emails": emails, "total": total, "page": page,
                "limit": limit, "hasMore": position + ids.len() < total, "skippedUids": Vec::<Option<u32>>::new(),
            }))
        }

        "imap_check_mailbox_status" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            // Task 6: `sync_jmap::delta_only` runs here first, so the ledger
            // and the counter below are current.
            let mb = mailbox_counts(acct, &mailbox).await?;
            let uid_next = uid_next(state, &account_id, &mailbox).await?;
            let (modseq, _) = meta_read(state, &account_id, &mailbox, None).await;
            Ok(json!({"exists": mb.total_emails, "uidValidity": 1, "uidNext": uid_next, "highestModseq": modseq}))
        }

        "imap_folder_status" => {
            let account_id = ledger_account(params)?;
            let wanted: Vec<String> = param(params, "mailboxes")?;
            // Task 6: `sync_jmap::delta_only` runs here first.
            let boxes = acct.refresh().await?;
            let mut statuses = Vec::new();
            for path in wanted {
                let Some(m) = boxes.ids.get(&path).and_then(|id| boxes.list.iter().find(|m| &m.id == id)) else { continue };
                // A badge needs no vault: without one, no uidNext.
                let uid_next = uid_next(state, &account_id, &path).await.ok();
                statuses.push(MailboxStatus {
                    path,
                    messages: m.total_emails,
                    unseen: Some(m.unread_emails),
                    uid_next,
                    uid_validity: Some(1),
                });
            }
            serde_json::to_value(&statuses).map_err(|e| Fail::Rpc(e.to_string()))
        }

        "imap_search_all_uids" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let mailbox_id = acct.mailbox_id(&mailbox).await?;
            let ids = all_ids(acct, &mailbox_id).await?;
            let mut uids: Vec<u32> = uids_for(state, acct, &account_id, &mailbox, &ids).await?.into_values().collect();
            uids.sort_unstable();
            Ok(json!({"uids": uids}))
        }

        "imap_fetch_headers_by_uids" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let uids: Vec<u32> = param(params, "uids")?;
            let mb = mailbox_counts(acct, &mailbox).await?;
            let pairs = acct.uid_to_id(state, &account_id, &mailbox, &uids, false).await?;
            let ids: Vec<String> = pairs.iter().filter_map(|(_, id)| id.clone()).collect();
            let mut got = by_id(acct.client.get_emails(&ids, HEADER_PROPS).await?.list);
            // `HEADER_PROPS` carries `mailboxIds`: a uid whose email left the
            // mailbox is left out, as IMAP leaves out an expunged uid.
            let emails: Vec<EmailHeader> = pairs
                .into_iter()
                .filter_map(|(uid, id)| got.remove(&id?).filter(|e| in_mailbox(e, &mb.id)).map(|e| to_header(&e, uid)))
                .collect();
            Ok(json!({"emails": emails, "total": mb.total_emails}))
        }

        "imap_fetch_changed_flags" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let since: u64 = param(params, "sinceModseq")?;
            let mailbox_id = acct.mailbox_id(&mailbox).await?;
            let (modseq, changed) = meta_read(state, &account_id, &mailbox, Some(since)).await;
            let pairs: Vec<(u32, String)> = match changed {
                Some(uids) => acct
                    .uid_to_id(state, &account_id, &mailbox, &uids, false)
                    .await?
                    .into_iter()
                    .filter_map(|(uid, id)| Some((uid, id?)))
                    .collect(),
                // Older than the log: every uid in the mailbox, with its flags.
                None => {
                    let ids = all_ids(acct, &mailbox_id).await?;
                    let uids = uids_for(state, acct, &account_id, &mailbox, &ids).await?;
                    let mut pairs: Vec<(u32, String)> = ids.into_iter().filter_map(|id| Some((*uids.get(&id)?, id))).collect();
                    pairs.sort_unstable_by_key(|(uid, _)| *uid);
                    pairs
                }
            };
            let ids: Vec<String> = pairs.iter().map(|(_, id)| id.clone()).collect();
            let got = if ids.is_empty() {
                HashMap::new()
            } else {
                by_id(acct.client.get_emails(&ids, &["id", "keywords", "mailboxIds"]).await?.list)
            };
            let changes: Vec<Value> = pairs
                .iter()
                .filter_map(|(uid, id)| got.get(id).filter(|e| in_mailbox(e, &mailbox_id)).map(|e| (uid, e)))
                .map(|(uid, e)| json!({"uid": uid, "flags": keywords_to_flags(&e["keywords"])}))
                .collect();
            Ok(json!({"changes": changes, "highestModseq": modseq}))
        }

        "imap_get_email" => {
            let account_id = ledger_account(params)?;
            let uid: u32 = param(params, "uid")?;
            let mailbox = mailbox_param(params);
            let Some(body) = fetch_body_timed(state, acct, &account_id, &mailbox, uid).await? else {
                return Err(Fail::Rpc(format!("E_UID_GONE: Message UID {} is no longer in {}", uid, mailbox)));
            };
            let parsed = vault_eml::parse_eml_bytes(&body.raw, uid, body.flags).map_err(Fail::Rpc)?;
            let mut email = json!(parsed);
            email["internalDate"] = json!(body.received_at);
            Ok(json!({"success": true, "email": email}))
        }

        "imap_get_email_light" => {
            let account_id = ledger_account(params)?;
            let uid: u32 = param(params, "uid")?;
            let mailbox = mailbox_param(params);
            let opened = opened_intent(params);
            // The daily download limit, exactly as the IMAP arm applies it
            // (keyed by `imapHost`, which for JMAP holds the session host).
            if !opened {
                let limit_account = opt_param::<String>(params, "accountId");
                if let Some(refusal) = backfill_refusal(state, limit_account.as_deref(), &account.host, uid, &mailbox).await {
                    return Ok(refusal);
                }
            }
            let Some(body) = fetch_body_timed(state, acct, &account_id, &mailbox, uid).await? else {
                return Ok(json!({"success": false, "gone": true, "uid": uid, "mailbox": mailbox}));
            };
            let light = vault_eml::parse_eml_bytes_light(&body.raw, uid, body.flags).map_err(Fail::Rpc)?;
            let dated = email_date_ms(light.date.as_deref(), body.received_at.as_deref());
            let cached = auto_cache(state, account_id.clone(), mailbox.clone(), uid, body.raw.clone(), dated, opened).await;
            // Not kept on disk (On Demand): the reads that follow this open
            // are served from memory (`raw_message`), as for IMAP.
            if !cached && opened {
                state.raw_messages.remember(&account_id, &mailbox, uid, body.raw.clone());
            }
            let (st, aid, mb, raw) = (Arc::clone(state), account_id.clone(), mailbox.clone(), body.raw);
            let rendered = blocking(move || crate::handlers::pgp::render(&st, &aid, &mb, uid, raw, cached)).await;
            let mut email = json!(light);
            email["internalDate"] = json!(body.received_at);
            if let Ok((bytes, status)) = rendered {
                crate::handlers::pgp::overlay(&mut email, &bytes, uid, status);
            }
            Ok(json!({"success": true, "email": email, "cached": cached}))
        }

        "imap_search_emails" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let query: Option<String> = opt_param(params, "query");
            let filters: SearchFilters = opt_param(params, "filters").unwrap_or_default();
            let mut conditions: Vec<Value> = Vec::new();
            for (key, value) in [("text", &query), ("from", &filters.from), ("subject", &filters.subject)] {
                if let Some(v) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                    let mut condition = serde_json::Map::new();
                    condition.insert(key.to_string(), json!(v));
                    conditions.push(Value::Object(condition));
                }
            }
            if let Some(after) = day_start(filters.since.as_deref()) {
                conditions.push(json!({"after": after}));
            }
            if let Some(before) = day_start(filters.before.as_deref()) {
                conditions.push(json!({"before": before}));
            }
            // Nothing asked: nothing found, as the IMAP arm answers.
            if conditions.is_empty() {
                return Ok(json!({"success": true, "emails": [], "total": 0}));
            }
            let mailbox_id = acct.mailbox_id(&mailbox).await?;
            conditions.insert(0, json!({"inMailbox": mailbox_id}));
            let filter = json!({"operator": "AND", "conditions": conditions});
            let (ids, total) = query_ids(&acct.client, filter, SEARCH_LIMIT).await?;
            let uids = uids_for(state, acct, &account_id, &mailbox, &ids).await?;
            let mut got = by_id(acct.client.get_emails(&ids, HEADER_PROPS).await?.list);
            let emails: Vec<EmailHeader> = ids
                .iter()
                .filter_map(|id| {
                    let mut header = to_header(&got.remove(id)?, *uids.get(id)?);
                    header.source = Some("server-search".to_string());
                    Some(header)
                })
                .collect();
            Ok(json!({"success": true, "emails": emails, "total": total}))
        }

        "imap_find_message_id" => {
            let account_id = ledger_account(params)?;
            let message_id: String = param(params, "messageId")?;
            let stop_on_first = opt_param::<bool>(params, "stopOnFirst").unwrap_or(true);
            let boxes = acct.refresh().await?;
            let term = message_id.trim().trim_start_matches('<').trim_end_matches('>').to_string();
            let (hits, _) = query_ids(&acct.client, json!({"header": ["Message-ID", term]}), FIND_LIMIT).await?;
            let got = if hits.is_empty() { Vec::new() } else { acct.client.get_emails(&hits, &["id", "mailboxIds"]).await?.list };
            let path_of: BTreeMap<&str, &str> = boxes.ids.iter().map(|(path, id)| (id.as_str(), path.as_str())).collect();
            let mut found = Vec::new();
            'emails: for email in &got {
                let Some(email_id) = email["id"].as_str() else { continue };
                let Some(mailbox_ids) = email["mailboxIds"].as_object() else { continue };
                for (mailbox_id, on) in mailbox_ids {
                    let Some(path) = path_of.get(mailbox_id.as_str()).filter(|_| on.as_bool() == Some(true)) else { continue };
                    let uids = uids_for(state, acct, &account_id, path, &[email_id.to_string()]).await?;
                    if let Some(uid) = uids.get(email_id) {
                        found.push(MessageIdLocation { mailbox: path.to_string(), uid: *uid });
                        if stop_on_first {
                            break 'emails;
                        }
                    }
                }
            }
            // One query covers every mailbox: all were searched, none failed.
            let probe = MessageIdProbe {
                message_id,
                found,
                searched: boxes.infos.iter().map(|m| m.path.clone()).collect(),
                failed: Vec::new(),
                complete: true,
            };
            serde_json::to_value(&probe).map_err(|e| Fail::Rpc(format!("Serialize probe: {e}")))
        }

        other => Err(Fail::Rpc(format!("E_JMAP_UNSUPPORTED: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::custody::db::{meta_get, meta_set};
    use mailvault_core::header_cache::sidecar_dir;
    use mock_jmap::{Limits, MockJmap, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
    use mailvault_core::graph_ledger::JMAP_LEDGER_FILE;

    // ── helpers ────────────────────────────────────────────────────────────

    const E1_RAW: &str = "Message-ID: <e1@x>\r\nSubject: one\r\n\r\nbody";

    const E2_RAW: &str = "Message-ID: <e2@x>\r\n\
In-Reply-To: <e1@x>\r\n\
References: <e1@x>\r\n\
From: Bob <bob@example.test>\r\n\
To: Alice <alice@example.test>\r\n\
Cc: carol@example.test\r\n\
Date: Fri, 02 Oct 2026 09:00:00 +0000\r\n\
Subject: two\r\n\
List-Unsubscribe: <mailto:unsub@example.test>,\r\n <https://example.test/unsub>\r\n\
Auto-Submitted: Auto-Replied\r\n\
\r\n\
second body";

    /// A plain message with a Message-ID of `<{id}@x>`.
    fn email(id: &str, subject: &str, received_at: &str) -> ScenarioEmail {
        ScenarioEmail {
            id: id.into(),
            raw: format!("Message-ID: <{id}@x>\r\nSubject: {subject}\r\n\r\nbody of {subject}"),
            keywords: vec![],
            received_at: received_at.into(),
            also_in: vec![],
        }
    }

    /// Task 1's scenario (`src-core/tests/common_jmap/mod.rs`): one account,
    /// Inbox (e1, e2), Work (e1 as a second label), Work/Sub (e3), Trash.
    /// Also lets this process send credentials to the mock's loopback http.
    fn common_scenario() -> Scenario {
        mailvault_core::jmap::base::allow_loopback_for_tests();
        let e1 = ScenarioEmail {
            id: "e1".into(),
            raw: E1_RAW.into(),
            keywords: vec!["$seen".into()],
            received_at: "2026-10-01T10:00:00Z".into(),
            also_in: vec!["mb-work".into()],
        };
        let e2 = ScenarioEmail {
            id: "e2".into(),
            raw: E2_RAW.into(),
            keywords: vec!["$flagged".into()],
            received_at: "2026-10-02T10:00:00Z".into(),
            also_in: vec![],
        };
        let e3 = email("e3", "three", "2026-10-03T10:00:00Z");
        let mailbox = |id: &str, name: &str, parent: Option<&str>, role: Option<&str>, emails: Vec<ScenarioEmail>| ScenarioMailbox {
            id: id.into(),
            name: name.into(),
            parent_id: parent.map(str::to_string),
            role: role.map(str::to_string),
            emails,
        };
        Scenario {
            accounts: vec![ScenarioAccount {
                username: "alice@example.test".into(),
                password: "pw".into(),
                token: Some("tok".into()),
                identities: vec![("alice@example.test".into(), "Alice".into())],
                mailboxes: vec![
                    mailbox("mb-inbox", "Inbox", None, Some("inbox"), vec![e1, e2]),
                    mailbox("mb-work", "Work", None, None, vec![]),
                    mailbox("mb-sub", "Sub", Some("mb-work"), None, vec![e3]),
                    mailbox("mb-trash", "Trash", None, Some("trash"), vec![]),
                ],
            }],
            faults: vec![],
            limits: Limits::default(),
        }
    }

    /// A daemon state on a scratch vault (`DaemonState::for_test`, vault root
    /// = data dir, as `imap.rs`'s tests set it), its settings on Hoarder so
    /// every opened body is kept, and the mock serving `s`.
    async fn test_state_with_mock(s: Scenario) -> (Arc<DaemonState>, MockJmap) {
        let dir = std::env::temp_dir().join(format!("mv-jmap-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"fetchMode": "hoarder"}}}).to_string(),
        )
        .unwrap();
        let state = DaemonState::for_test(dir.clone(), dir, true);
        (state, MockJmap::start(s))
    }

    /// The JMAP account as the app sends it (Basic: the address + "pw").
    fn jmap_account(m: &MockJmap) -> Value {
        json!({
            "id": "acct-1",
            "email": "alice@example.test",
            "authType": "password",
            "jmapSessionUrl": m.session_url(),
            "jmapAuth": "basic",
            "password": "pw",
            "imapHost": "127.0.0.1",
        })
    }

    fn config(account: &Value) -> ImapConfig {
        serde_json::from_value(account.clone()).unwrap()
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        intercept(state, method, &json!(1), &params).await.expect("a JMAP account is intercepted")
    }

    fn ok(resp: RpcResponse) -> Value {
        match (resp.result, resp.error) {
            (Some(v), None) => v,
            (_, e) => panic!("expected a result, got {e:?}"),
        }
    }

    fn err(resp: RpcResponse) -> String {
        resp.error.expect("expected an error").message
    }

    /// `imap_get_emails` of the whole mailbox.
    async fn list(state: &Arc<DaemonState>, a: &Value, mailbox: &str) -> Value {
        ok(call(state, "imap_get_emails", json!({"account": a, "mailbox": mailbox, "page": 1, "limit": 50})).await)
    }

    /// The uid a listing gave the email with `message_id`.
    fn uid_in(listing: &Value, message_id: &str) -> u32 {
        listing["emails"].as_array().unwrap().iter().find(|e| e["messageId"] == message_id).unwrap()["uid"].as_u64().unwrap() as u32
    }

    async fn status(state: &Arc<DaemonState>, a: &Value, mailbox: &str) -> Value {
        ok(call(state, "imap_check_mailbox_status", json!({"account": a, "mailbox": mailbox})).await)
    }

    fn ledger(state: &Arc<DaemonState>, mailbox: &str) -> graph_ledger::Ledger {
        let root = vault_root(state).unwrap();
        graph_ledger::load(&sidecar_dir(&root, "acct-1", mailbox).join(JMAP_LEDGER_FILE)).unwrap()
    }

    /// How many times a client fetched the session resource (one per connect).
    fn session_fetches(m: &MockJmap) -> usize {
        m.requests().iter().filter(|r| r.path.starts_with("/jmap/session")).count()
    }

    fn custody_conn() -> (tempfile::TempDir, mailvault_core::custody::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = mailvault_core::custody::db::open(dir.path()).unwrap();
        (dir, conn)
    }

    // ── routing ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn non_jmap_account_is_not_intercepted() {
        let (state, _m) = test_state_with_mock(common_scenario()).await;
        assert!(intercept(&state, "imap_get_mailboxes", &json!(1), &json!({"account": {"email":"a@b","imapHost":"imap.b"}})).await.is_none());
    }

    #[tokio::test]
    async fn other_rpcs_are_never_intercepted() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        assert!(intercept(&state, "smtp_build_mime", &json!(1), &json!({"account": a})).await.is_none());
        assert!(intercept(&state, "vault_rows", &json!(1), &json!({"account": a})).await.is_none());
        assert!(m.requests().is_empty());
    }

    #[test]
    fn every_imap_arm_is_handled_or_unsupported() {
        let arms: Vec<&str> = include_str!("imap.rs")
            .lines()
            .map(str::trim_start)
            .filter(|l| l.starts_with("\"imap_") && l.contains("\" =>"))
            .map(|l| &l[1..1 + l[1..].find('"').unwrap()])
            .collect();
        assert_eq!(arms.len(), 20, "{arms:?}");
        for arm in &arms {
            let handled = HANDLED.contains(arm);
            let refused = UNSUPPORTED.iter().any(|(name, _)| name == arm);
            assert!(handled ^ refused, "{arm} must be in exactly one of HANDLED and UNSUPPORTED");
        }
        assert_eq!(HANDLED.len() + UNSUPPORTED.len(), arms.len());
    }

    #[tokio::test]
    async fn unsupported_rpc_on_a_jmap_account_is_an_error_never_imap() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let resp = call(&state, "imap_set_flags", json!({"account": a, "uid": 1, "mailbox": "INBOX", "flags": ["\\Seen"]})).await;
        let message = err(resp);
        assert!(message.starts_with("E_JMAP_UNSUPPORTED: imap_set_flags"), "{message}");
        assert!(m.requests().is_empty(), "nothing may be sent for a refused RPC");
    }

    #[tokio::test]
    async fn imap_route_hands_a_jmap_account_to_the_bridge() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let resp = crate::handlers::imap::route(&state, "imap_get_mailboxes", &json!({"account": jmap_account(&m)}), json!(1))
            .await
            .expect("routed");
        assert_eq!(ok(resp)["success"], json!(true));
        assert!(m.count_calls("Mailbox/get") >= 1, "answered over JMAP");
    }

    #[tokio::test]
    async fn smtp_test_connection_succeeds_for_a_jmap_account() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let resp = crate::handlers::smtp::route(&state, "smtp_test_connection", &json!({"account": jmap_account(&m)}), json!(1))
            .await
            .expect("routed");
        assert_eq!(ok(resp), json!({"success": true}));
    }

    #[tokio::test]
    async fn missing_account_id_is_invalid_params() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let mut a = jmap_account(&m);
        a.as_object_mut().unwrap().remove("id");
        let resp = call(&state, "imap_get_emails", json!({"account": a, "mailbox": "INBOX"})).await;
        assert_eq!(resp.error.expect("error").code, ipc::INVALID_PARAMS);
    }

    // ── credentials ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn jmap_account_without_credentials_is_refused_before_any_request() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let mut no_secret = jmap_account(&m);
        no_secret.as_object_mut().unwrap().remove("password");
        let mut unknown_kind = jmap_account(&m);
        unknown_kind["jmapAuth"] = json!("digest");
        for a in [no_secret, unknown_kind] {
            let message = err(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
            assert!(message.starts_with("E_JMAP_AUTH:"), "{message}");
            assert!(state.jmap.get(&config(&a)).await.is_err_and(|e| e == JmapError::Unauthorized));
            let test = ok(call(&state, "imap_test_connection", json!({"account": a})).await);
            assert_eq!(test["success"], json!(false));
            assert_eq!(test["errorCode"], json!("E_JMAP_AUTH"));
        }
        assert!(m.requests().is_empty(), "no unauthenticated request may leave: {:?}", m.requests());
    }

    #[tokio::test]
    async fn changed_credentials_connect_a_new_session() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        ok(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
        ok(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
        assert_eq!(session_fetches(&m), 1, "one connect serves both calls");
        m.mutate(|s| s.account_mut("acc1").password = "pw2".into());
        let mut b = a.clone();
        b["password"] = json!("pw2");
        ok(call(&state, "imap_get_mailboxes", json!({"account": b})).await);
        assert_eq!(session_fetches(&m), 2);
    }

    #[tokio::test]
    async fn a_revoked_session_reconnects_once_then_fails() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        ok(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
        m.mutate(|s| s.account_mut("acc1").password = "revoked".into());
        let message = err(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
        assert!(message.starts_with("E_JMAP_AUTH:"), "{message}");
        assert_eq!(session_fetches(&m), 2, "exactly one reconnect");
    }

    // ── one test per table row ─────────────────────────────────────────────

    #[tokio::test]
    async fn test_connection_answers_the_imap_success_shape() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let r = ok(call(&state, "imap_test_connection", json!({"account": jmap_account(&m)})).await);
        assert_eq!(r["success"], json!(true));
        assert_eq!(r["host"], json!("127.0.0.1"));
        assert_eq!(r["port"], json!(m.port()));
        assert_eq!(r["messageCount"], json!(2));
        assert_eq!(r["fromAddress"], json!("alice@example.test"));
    }

    #[tokio::test]
    async fn test_connection_failure_carries_the_jmap_code() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let mut a = jmap_account(&m);
        a["password"] = json!("wrong");
        let r = ok(call(&state, "imap_test_connection", json!({"account": a})).await);
        assert_eq!(r["success"], json!(false));
        assert_eq!(r["errorCode"], json!("E_JMAP_AUTH"));
        assert!(r["error"].as_str().unwrap().starts_with("E_JMAP_AUTH:"));
        assert_eq!(r["host"], json!("127.0.0.1"));
        assert_eq!(r["port"], json!(m.port()));
    }

    #[tokio::test]
    async fn get_mailboxes_maps_inbox_and_children() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let resp = intercept(&state, "imap_get_mailboxes", &json!(1), &json!({"account": jmap_account(&m)})).await.unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["success"], json!(true));
        let list = result["mailboxes"].as_array().unwrap();
        assert!(list.iter().any(|m| m["path"] == "INBOX" && m["specialUse"] == "\\Inbox"));
        assert!(list.iter().any(|m| m["path"] == "Work/Sub" && m["delimiter"] == "/"));
        assert!(list.iter().any(|m| m["path"] == "Trash" && m["specialUse"] == "\\Trash"));
    }

    #[tokio::test]
    async fn get_emails_pages_newest_first_in_the_imap_shape() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let p1 = ok(call(&state, "imap_get_emails", json!({"account": a, "mailbox": "INBOX", "page": 1, "limit": 1})).await);
        assert_eq!(p1["success"], json!(true));
        assert_eq!(p1["total"], json!(2));
        assert_eq!(p1["page"], json!(1));
        assert_eq!(p1["limit"], json!(1));
        assert_eq!(p1["hasMore"], json!(true));
        assert_eq!(p1["skippedUids"], json!([]));
        assert_eq!(p1["emails"][0]["messageId"], json!("<e2@x>"));
        assert_eq!(p1["emails"][0]["source"], json!("jmap"));
        assert_eq!(p1["emails"][0]["flags"], json!(["\\Flagged"]));
        let p2 = ok(call(&state, "imap_get_emails", json!({"account": a, "mailbox": "INBOX", "page": 2, "limit": 1})).await);
        assert_eq!(p2["emails"][0]["messageId"], json!("<e1@x>"));
        assert_eq!(p2["hasMore"], json!(false));
        assert_ne!(p1["emails"][0]["uid"], p2["emails"][0]["uid"]);
    }

    #[tokio::test]
    async fn one_listing_issues_uids_in_arrival_order() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let listing = list(&state, &jmap_account(&m), "INBOX").await;
        assert_eq!(uid_in(&listing, "<e1@x>"), 1, "e1 arrived first");
        assert_eq!(uid_in(&listing, "<e2@x>"), 2);
        assert_eq!(ledger(&state, "INBOX"), [(1, "e1".to_string()), (2, "e2".to_string())].into_iter().collect());
    }

    #[tokio::test]
    async fn same_email_in_two_mailboxes_gets_a_uid_in_each_ledger() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let inbox = intercept(&state, "imap_get_emails", &json!(1), &json!({"account": a, "mailbox":"INBOX","page":1,"limit":50})).await.unwrap();
        let work  = intercept(&state, "imap_get_emails", &json!(2), &json!({"account": a, "mailbox":"Work","page":1,"limit":50})).await.unwrap();
        let uid_in = |r: &RpcResponse| r.result.as_ref().unwrap()["emails"].as_array().unwrap().iter().find(|e| e["messageId"] == "<e1@x>").unwrap()["uid"].as_u64().unwrap();
        let _ = (uid_in(&inbox), uid_in(&work)); // both exist
        let root = crate::handlers::common::vault_root(&state).unwrap();
        let ledger_in = graph_ledger::load(&sidecar_dir(&root, "acct-1", "INBOX").join(JMAP_LEDGER_FILE)).unwrap();
        let ledger_wk = graph_ledger::load(&sidecar_dir(&root, "acct-1", "Work").join(JMAP_LEDGER_FILE)).unwrap();
        assert!(ledger_in.values().any(|v| v == "e1") && ledger_wk.values().any(|v| v == "e1"));
    }

    #[tokio::test]
    async fn check_mailbox_status_reads_counts_and_the_ledger() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let before = status(&state, &a, "INBOX").await;
        assert_eq!(before["uidNext"], json!(1), "nothing issued yet");
        list(&state, &a, "INBOX").await;
        let after = status(&state, &a, "INBOX").await;
        assert_eq!(after, json!({"exists": 2, "uidValidity": 1, "uidNext": 3, "highestModseq": 0}));
    }

    #[tokio::test]
    async fn folder_status_is_a_bare_array_of_known_paths() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        list(&state, &a, "INBOX").await;
        let r = ok(call(&state, "imap_folder_status", json!({"account": a, "mailboxes": ["INBOX", "Work/Sub", "Nope"]})).await);
        let rows = r.as_array().expect("a bare array, as api.js returns it");
        assert_eq!(rows.len(), 2, "an unknown folder is absent: {rows:?}");
        assert_eq!(rows[0], json!({"path": "INBOX", "messages": 2, "unseen": 1, "uidNext": 3, "uidValidity": 1}));
        assert_eq!(rows[1], json!({"path": "Work/Sub", "messages": 1, "unseen": 1, "uidNext": 1, "uidValidity": 1}));
    }

    #[tokio::test]
    async fn search_all_uids_returns_every_uid_ascending() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let r = ok(call(&state, "imap_search_all_uids", json!({"account": jmap_account(&m), "mailbox": "INBOX"})).await);
        assert_eq!(r, json!({"uids": [1, 2]}));
    }

    #[tokio::test]
    async fn fetch_headers_by_uids_returns_only_the_asked_uids() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let listing = list(&state, &a, "INBOX").await;
        let e2 = uid_in(&listing, "<e2@x>");
        let r = ok(call(&state, "imap_fetch_headers_by_uids", json!({"account": a, "mailbox": "INBOX", "uids": [e2, 99]})).await);
        assert_eq!(r["total"], json!(2));
        let emails = r["emails"].as_array().unwrap();
        assert_eq!(emails.len(), 1);
        assert_eq!(emails[0]["uid"], json!(e2));
        assert_eq!(emails[0]["messageId"], json!("<e2@x>"));
        assert_eq!(emails[0]["from"]["address"], json!("bob@example.test"));
    }

    #[tokio::test]
    async fn fetch_changed_flags_without_a_log_returns_every_uid() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        list(&state, &a, "INBOX").await;
        let same = ok(call(&state, "imap_fetch_changed_flags", json!({"account": a, "mailbox": "INBOX", "sinceModseq": 0})).await);
        assert_eq!(same, json!({"changes": [], "highestModseq": 0}), "nothing changed since the current counter");
        let r = ok(call(&state, "imap_fetch_changed_flags", json!({"account": a, "mailbox": "INBOX", "sinceModseq": 5})).await);
        assert_eq!(
            r,
            json!({"changes": [{"uid": 1, "flags": ["\\Seen"]}, {"uid": 2, "flags": ["\\Flagged"]}], "highestModseq": 0}),
            "a counter the log cannot answer returns every uid"
        );
    }

    #[tokio::test]
    async fn fetch_changed_flags_reads_the_meta_log() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        // What Task 6's delta does when it sees e1's keywords change.
        m.mutate(|s| s.set_keywords("acc1", "e1", &["$seen", "$flagged"]));
        let bumped = crate::custody::with_conn(&state, |c| JmapMeta::bump(c, "acct-1", "INBOX", &[e1])).unwrap();
        assert_eq!(bumped, 1);
        let r = ok(call(&state, "imap_fetch_changed_flags", json!({"account": a, "mailbox": "INBOX", "sinceModseq": 0})).await);
        assert_eq!(r, json!({"changes": [{"uid": e1, "flags": ["\\Seen", "\\Flagged"]}], "highestModseq": 1}));
    }

    #[tokio::test]
    async fn get_email_returns_the_full_body() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        let r = ok(call(&state, "imap_get_email", json!({"account": a, "uid": e1, "mailbox": "INBOX"})).await);
        assert_eq!(r["success"], json!(true));
        assert_eq!(r["email"]["uid"], json!(e1));
        assert_eq!(r["email"]["subject"], json!("one"));
        assert_eq!(r["email"]["flags"], json!(["\\Seen"]));
        assert_eq!(r["email"]["internalDate"], json!("2026-10-01T10:00:00Z"));
        // base64, as the IMAP arm's `FullEmail.raw_source` is.
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD.decode(r["email"]["rawSource"].as_str().unwrap()).unwrap();
        assert_eq!(raw, E1_RAW.as_bytes());
    }

    #[tokio::test]
    async fn get_email_light_writes_eml_into_vault() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        let r = ok(call(&state, "imap_get_email_light", json!({"account": a, "uid": e1, "mailbox": "INBOX"})).await);
        assert_eq!(r["success"], json!(true));
        assert_eq!(r["cached"], json!(true));
        assert_eq!(r["email"]["subject"], json!("one"));
        assert_eq!(r["email"]["flags"], json!(["\\Seen"]));
        // `auto_cache` stores flagless (`<uid>:2,.eml`), exactly as for IMAP.
        let cur = mailvault_core::vault_files::cur_path(&vault_root(&state).unwrap(), "acct-1", "INBOX");
        let file = std::fs::read_dir(&cur)
            .unwrap()
            .flatten()
            .find(|f| mailvault_core::maildir::vault_filename_uid(&f.file_name().to_string_lossy()) == Some(e1))
            .expect("the opened message is in the vault");
        let raw = m.read(|s| s.raw("acc1", "e1")).unwrap();
        assert_eq!(std::fs::read(file.path()).unwrap(), raw);
        assert_eq!(raw, E1_RAW.as_bytes());
    }

    #[tokio::test]
    async fn acting_on_a_uid_whose_email_left_the_mailbox_answers_uid_gone() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        m.mutate(|s| s.remove_from_mailbox("acc1", "e1", "mb-inbox"));
        let message = err(call(&state, "imap_get_email", json!({"account": a, "uid": e1, "mailbox": "INBOX"})).await);
        assert!(message.starts_with("E_UID_GONE:"), "{message}");
        let light = ok(call(&state, "imap_get_email_light", json!({"account": a, "uid": e1, "mailbox": "INBOX"})).await);
        assert_eq!(light, json!({"success": false, "gone": true, "uid": e1, "mailbox": "INBOX"}));
        let never = err(call(&state, "imap_get_email", json!({"account": a, "uid": 99, "mailbox": "INBOX"})).await);
        assert!(never.starts_with("E_UID_GONE:"), "a uid the ledger never issued: {never}");
        assert!(ledger(&state, "INBOX").values().any(|id| id == "e1"), "ledger rows are never removed");
    }

    #[tokio::test]
    async fn uid_to_id_rechecks_mailbox_membership() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let listing = list(&state, &a, "INBOX").await;
        let (e1, e2) = (uid_in(&listing, "<e1@x>"), uid_in(&listing, "<e2@x>"));
        m.mutate(|s| s.remove_from_mailbox("acc1", "e1", "mb-inbox"));
        let acct = state.jmap.get(&config(&a)).await.unwrap();
        let fresh = acct.uid_to_id(&state, "acct-1", "INBOX", &[e1, e2, 99], true).await.unwrap();
        assert_eq!(fresh, vec![(e1, None), (e2, Some("e2".to_string())), (99, None)]);
        let stale = acct.uid_to_id(&state, "acct-1", "INBOX", &[e1], false).await.unwrap();
        assert_eq!(stale, vec![(e1, Some("e1".to_string()))], "without recheck: the ledger's answer");
    }

    #[tokio::test]
    async fn search_emails_filters_by_text_and_from() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let by_text = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "INBOX", "query": "two"})).await);
        assert_eq!(by_text["success"], json!(true));
        assert_eq!(by_text["total"], json!(1));
        assert_eq!(by_text["emails"][0]["messageId"], json!("<e2@x>"));
        assert_eq!(by_text["emails"][0]["source"], json!("server-search"));
        let by_from = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "INBOX", "filters": {"from": "bob"}})).await);
        assert_eq!(by_from["emails"].as_array().unwrap().len(), 1);
        assert_eq!(by_from["emails"][0]["messageId"], json!("<e2@x>"));
        let in_work = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "Work", "query": "two"})).await);
        assert_eq!(in_work["total"], json!(0), "the search stays in its mailbox");
        let nothing = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "INBOX"})).await);
        assert_eq!(nothing, json!({"success": true, "emails": [], "total": 0}));
    }

    #[tokio::test]
    async fn find_message_id_finds_every_mailbox_holding_it() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let r = ok(call(&state, "imap_find_message_id", json!({"account": a, "messageId": "<e1@x>", "stopOnFirst": false})).await);
        assert_eq!(r["messageId"], json!("<e1@x>"));
        assert_eq!(r["complete"], json!(true));
        assert_eq!(r["failed"], json!([]));
        assert_eq!(r["found"], json!([{"mailbox": "INBOX", "uid": 1}, {"mailbox": "Work", "uid": 1}]));
        assert!(r["searched"].as_array().unwrap().contains(&json!("Work/Sub")));
        let first = ok(call(&state, "imap_find_message_id", json!({"account": a, "messageId": "<e1@x>"})).await);
        assert_eq!(first["found"].as_array().unwrap().len(), 1, "stopOnFirst defaults to true");
        let none = ok(call(&state, "imap_find_message_id", json!({"account": a, "messageId": "<nope@x>"})).await);
        assert_eq!(none["found"], json!([]));
        assert_eq!(none["complete"], json!(true));
    }

    #[tokio::test]
    async fn disconnect_forgets_the_session() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        ok(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
        assert_eq!(session_fetches(&m), 1);
        assert_eq!(ok(call(&state, "imap_disconnect", json!({"account": a})).await), json!({"success": true}));
        ok(call(&state, "imap_get_mailboxes", json!({"account": a})).await);
        assert_eq!(session_fetches(&m), 2, "the next call connects again");
    }

    // ── JmapMeta ───────────────────────────────────────────────────────────

    #[test]
    fn jmap_meta_counts_and_logs_changes() {
        let (_dir, c) = custody_conn();
        assert_eq!(JmapMeta::modseq(&c, "acct-1", "INBOX"), 0);
        assert_eq!(JmapMeta::bump(&c, "acct-1", "INBOX", &[]).unwrap(), 0, "no uids, no bump");
        assert_eq!(JmapMeta::bump(&c, "acct-1", "INBOX", &[7, 5]).unwrap(), 1);
        assert_eq!(JmapMeta::bump(&c, "acct-1", "INBOX", &[5]).unwrap(), 2);
        assert_eq!(JmapMeta::modseq(&c, "acct-1", "INBOX"), 2);
        assert_eq!(JmapMeta::modseq(&c, "acct-1", "Work"), 0, "per mailbox");
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 0), Some(vec![5, 7]));
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 1), Some(vec![5]));
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 2), Some(vec![]));
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 3), None, "a counter from elsewhere");
        assert_eq!(meta_get(&c, "jmap:acct-1:INBOX:flaglog").as_deref(), Some("[[1,7],[1,5],[2,5]]"));
    }

    #[test]
    fn jmap_meta_a_cut_log_covers_only_what_it_still_holds() {
        let (_dir, c) = custody_conn();
        let first: Vec<u32> = (1..=1500).collect();
        let second: Vec<u32> = (2001..=3000).collect();
        JmapMeta::bump(&c, "acct-1", "INBOX", &first).unwrap();
        JmapMeta::bump(&c, "acct-1", "INBOX", &second).unwrap();
        // 2500 entries cut to 2000: modseq 1 kept only 1000 of its 1500 uids.
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 0), None);
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 1), Some(second));
    }

    #[test]
    fn jmap_meta_an_unreadable_log_restarts_and_says_so() {
        let (_dir, c) = custody_conn();
        meta_set(&c, "jmap:acct-1:INBOX:modseq", "4").unwrap();
        meta_set(&c, "jmap:acct-1:INBOX:flaglog", "not json").unwrap();
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 3), None);
        assert_eq!(JmapMeta::bump(&c, "acct-1", "INBOX", &[9]).unwrap(), 5);
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 4), Some(vec![9]));
        assert_eq!(JmapMeta::changed_since(&c, "acct-1", "INBOX", 3), None, "what came before the restart is lost");
    }

    #[test]
    fn jmap_meta_email_state_round_trips() {
        let (_dir, c) = custody_conn();
        assert_eq!(JmapMeta::email_state(&c, "acct-1", "acc1"), None);
        JmapMeta::set_email_state(&c, "acct-1", "acc1", "s7").unwrap();
        assert_eq!(JmapMeta::email_state(&c, "acct-1", "acc1").as_deref(), Some("s7"));
        assert_eq!(meta_get(&c, "jmap:acct-1:acc1:email_state").as_deref(), Some("s7"));
        assert_eq!(JmapMeta::email_state(&c, "acct-2", "acc1"), None);
    }

    // ── Task 6 ─────────────────────────────────────────────────────────────

    #[tokio::test]
    #[ignore = "needs Task 6 delta"]
    async fn arrival_plus_removal_in_one_interval_moves_status() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        list(&state, &a, "INBOX").await;
        let s0 = status(&state, &a, "INBOX").await;
        let (next0, modseq0) = (s0["uidNext"].as_u64().unwrap(), s0["highestModseq"].as_u64().unwrap());
        m.mutate(|s| {
            s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z"));
            s.destroy_email("acc1", "e2");
        });
        let s1 = status(&state, &a, "INBOX").await;
        assert_eq!(s1["exists"], s0["exists"], "one in, one out");
        assert!(s1["uidNext"].as_u64().unwrap() > next0, "{s0} -> {s1}");
        assert!(s1["highestModseq"].as_u64().unwrap() > modseq0, "{s0} -> {s1}");
        let e9 = ledger(&state, "INBOX").into_iter().find(|(_, id)| id == "e9").map(|(uid, _)| uid).expect("the delta issued e9 a uid");
        assert!(u64::from(e9) >= next0);
    }

    #[tokio::test]
    #[ignore = "needs Task 6 delta"]
    async fn changed_flags_since_modseq() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        let modseq0 = status(&state, &a, "INBOX").await["highestModseq"].as_u64().unwrap();
        m.mutate(|s| s.set_keywords("acc1", "e1", &["$seen", "$flagged"]));
        status(&state, &a, "INBOX").await;
        let r = ok(call(&state, "imap_fetch_changed_flags", json!({"account": a, "mailbox": "INBOX", "sinceModseq": modseq0})).await);
        assert_eq!(r["changes"], json!([{"uid": e1, "flags": ["\\Seen", "\\Flagged"]}]));
        assert!(r["highestModseq"].as_u64().unwrap() > modseq0);
    }
}
