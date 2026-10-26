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
use crate::handlers::deleted::{self, Source};
use crate::handlers::imap::{auto_cache_with_ids, backfill_refusal, email_date_ms, opened_intent, SearchFilters, BODY_FETCH_TIMEOUT};
use crate::imap::{EmailHeader, ImapConfig, MailboxStatus, MessageIdLocation, MessageIdProbe, ServerSearch};
use crate::ipc::{self, RpcResponse};
use crate::jmap_sessions::{in_mailbox, jmap_ledger_path, AccountJmap, JmapMeta, Mailboxes};
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use mailvault_core::graph_ledger;
use mailvault_core::jmap::headers::{flag_to_keyword, keywords_to_flags, to_header, HEADER_PROPS};
use mailvault_core::jmap::mailbox_map::DELIMITER;
use mailvault_core::jmap::{remove_from, JmapClient, JmapError, RemoveOutcome, SetOutcome};
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
    "imap_set_flags",
    "imap_move_emails",
    "imap_delete_email",
    "imap_create_mailbox",
    "imap_rename_mailbox",
    "imap_delete_mailbox",
    "imap_ensure_sent_mailbox",
];

/// `imap_*` RPCs a JMAP account is refused, with why. Empty: every IMAP arm
/// has a JMAP answer. A new arm in `imap.rs` goes into `HANDLED`, or here
/// with its reason; the guard tests read `imap.rs` and fail until it does.
pub const UNSUPPORTED: &[(&str, &str)] = &[];

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
    matches!(f, Fail::Rpc(e) if is_auth_error(e))
}

/// `E_JMAP_AUTH:`, the code of `JmapError::Unauthorized`.
pub(crate) fn is_auth_error(e: &str) -> bool {
    e.starts_with(&format!("{}:", JmapError::Unauthorized.code()))
}

/// Run `attempt` on the account's session. An expired or revoked session
/// (`E_JMAP_AUTH:`, from the connect or from `attempt`) is forgotten and
/// `attempt` runs once more on a fresh one, as a bridged RPC does
/// (`answer_with_retry`). For work that is safe to repeat: a second pass
/// finds what the first one did already done.
pub(crate) async fn with_session_retry<T, F, Fut>(state: &Arc<DaemonState>, config: &ImapConfig, mut attempt: F) -> Result<T, String>
where
    F: FnMut(Arc<AccountJmap>) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut forgot = false;
    loop {
        let result = match state.jmap.get(config).await {
            Ok(acct) => attempt(acct).await,
            Err(e) => Err(e.to_string()),
        };
        match result {
            Err(e) if !forgot && is_auth_error(&e) => {
                state.jmap.forget(config);
                forgot = true;
            }
            other => return other,
        }
    }
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
    intercept_with_stamp(state, method, id, params, None).await
}

/// A nested finite operation can carry its entry stamp through the provider
/// wait instead of capturing a new account epoch after that wait.
pub(crate) async fn intercept_with_stamp(state: &Arc<DaemonState>, method: &str, id: &Value, params: &Value, original: Option<&crate::account_lifecycle::AccountStamp>) -> Option<RpcResponse> {
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
        m if HANDLED.contains(&m) => match answer_with_retry(state, m, params, &account, original).await {
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
/// a fresh connect. Every bridged RPC is safe to run twice: a 401 or 403 means
/// the server applied nothing, and a write logs, never returns, the failures
/// that can follow its landed server change (the mailbox listing, a custody
/// row), so an authentication retry never repeats a write that landed.
async fn answer_with_retry(state: &Arc<DaemonState>, method: &str, params: &Value, account: &ImapConfig, carried: Option<&crate::account_lifecycle::AccountStamp>) -> Result<Value, Fail> {
    let original = carried.cloned().or_else(|| ledger_account(params).ok().and_then(|id| state.account_lifecycle.capture(&id).ok()));
    let acct = state.jmap.get(account).await?;
    match answer(state, method, params, account, &acct, original.as_ref()).await {
        Err(f) if is_auth_failure(&f) => {
            state.jmap.forget(account);
            let acct = state.jmap.get(account).await?;
            answer(state, method, params, account, &acct, original.as_ref()).await
        }
        other => other,
    }
}

pub(crate) async fn probe_connection(account: &ImapConfig) -> Result<Option<u32>, JmapError> {
    let url = account
        .jmap_session_url
        .as_deref()
        .unwrap_or_default()
        .trim();
    let auth = account.jmap_auth().ok_or(JmapError::Unauthorized)?;
    let client = JmapClient::connect(url, auth, &account.email).await?;
    let (list, _) = client.mailboxes().await?;
    Ok(list
        .iter()
        .find(|m| {
            m.role
                .as_deref()
                .is_some_and(|r| r.eq_ignore_ascii_case("inbox"))
        })
        .map(|m| m.total_emails))
}

/// `imap_test_connection` over JMAP: connect fresh (never the cached
/// session, so it proves the credentials as typed) and list the mailboxes.
async fn test_connection(account: &ImapConfig, id: Value) -> RpcResponse {
    let url = account
        .jmap_session_url
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    let (host, port) = url::Url::parse(&url)
        .ok()
        .map(|u| {
            (
                u.host_str().unwrap_or_default().to_string(),
                u.port_or_known_default().unwrap_or(443),
            )
        })
        .unwrap_or_else(|| (account.host.clone(), 443));
    info!(
        "[test-connection] Testing JMAP {} → {}:{}",
        account.email, host, port
    );
    let reached = probe_connection(account).await;
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
        Err(e) => RpcResponse::success(
            id,
            super::failed_connection_test_with_code(&e.to_string(), e.code(), &host, port),
        ),
    }
}

/// Email ids -> uids in `mailbox`. A page lists newest first; the ledger is
/// handed it oldest first, so the uids one listing issues follow arrival.
async fn uids_for(
    state: &Arc<DaemonState>,
    acct: &AccountJmap,
    original: &crate::account_lifecycle::AccountStamp,
    account_id: &str,
    mailbox: &str,
    ids: &[String],
) -> Result<HashMap<String, u32>, Fail> {
    let oldest_first: Vec<String> = ids.iter().rev().cloned().collect();
    let uids = acct.ids_to_uids(state, original.clone(), account_id, mailbox, &oldest_first).await?;
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
pub(crate) async fn query_ids(client: &JmapClient, filter: Value, limit: usize) -> Result<(Vec<String>, usize), JmapError> {
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

/// The mailbox at `path`, with its counts: the last listing while
/// `Mailbox/changes` says nothing moved, else a fresh `Mailbox/get`
/// (`AccountJmap::current`).
async fn mailbox_counts(acct: &AccountJmap, path: &str) -> Result<mailvault_core::jmap::JMailbox, Fail> {
    let boxes = acct.current().await?;
    let missing = || Fail::from(JmapError::Protocol(format!("no mailbox {path}")));
    let id = boxes.ids.get(path).ok_or_else(missing)?;
    boxes.list.into_iter().find(|m| &m.id == id).ok_or_else(missing)
}

/// A message body fetched by uid.
pub(crate) struct Fetched {
    pub(crate) raw: Vec<u8>,
    pub(crate) flags: Vec<String>,
    pub(crate) received_at: Option<String>,
    /// Its server ids, for the record a JMAP-format vault keeps (Plan A
    /// Task 14).
    pub(crate) ids: mailvault_core::jmap_store::record::ServerIds,
}

/// The server ids of `email`, an `Email/get` answer for `email_id` whose
/// `blobId` is `blob_id`, as a JMAP-format record keeps them. `threadId` is
/// `None` when the `Email/get` did not ask for it or the server sent none.
pub(crate) fn server_ids(email_id: &str, blob_id: &str, email: &Value) -> mailvault_core::jmap_store::record::ServerIds {
    mailvault_core::jmap_store::record::ServerIds {
        email_id: email_id.to_string(),
        blob_id: blob_id.to_string(),
        thread_id: email["threadId"].as_str().map(str::to_string),
    }
}

/// The raw message behind `uid` in `mailbox`, `None` when it is gone: the
/// ledger never issued the uid, the email no longer exists, or it left the
/// mailbox. One `Email/get` both finds the blob and re-checks membership.
async fn fetch_body(state: &Arc<DaemonState>, acct: &AccountJmap, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<Fetched>, Fail> {
    let pairs = acct.uid_to_id(state, account_id, mailbox, &[uid], false).await?;
    let Some(email_id) = pairs.into_iter().next().and_then(|(_, id)| id) else { return Ok(None) };
    let mailbox_id = acct.mailbox_id(mailbox).await?;
    fetch_body_id(acct,email_id,mailbox_id).await
}

async fn fetch_body_id(
    acct: &AccountJmap,
    email_id: String,
    mailbox_id: String,
) -> Result<Option<Fetched>, Fail> {
    let got = acct
        .client
        .get_emails(
            &[email_id.clone()],
            &[
                "id",
                "blobId",
                "threadId",
                "mailboxIds",
                "keywords",
                "receivedAt",
            ],
        )
        .await?;
    let Some(email) = by_id(got.list).remove(&email_id) else {
        return Ok(None);
    };
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
        ids: server_ids(&email_id, blob_id, &email),
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

/// One bridged RPC. Returns the success payload; `E_UID_GONE:` and every
/// other failure are `Fail`s. The write side's functions follow `answer`.
async fn answer(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    account: &ImapConfig,
    acct: &Arc<AccountJmap>,
    original: Option<&crate::account_lifecycle::AccountStamp>,
) -> Result<Value, Fail> {
    match method {
        "imap_get_mailboxes" => {
            let boxes = acct.refresh().await?;
            Ok(json!({"success": true, "mailboxes": boxes.infos}))
        }

        "imap_get_emails" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let expected = crate::handlers::cache::native_header_seed(state, &account_id, &mailbox).await;
            let page: u32 = opt_param(params, "page").unwrap_or(1);
            let limit: u32 = opt_param(params, "limit").unwrap_or(200);
            let mailbox_id = acct.mailbox_id(&mailbox).await?;
            let position = page.saturating_sub(1) as usize * limit as usize;
            let (ids, total) = acct.client.query_mailbox(&mailbox_id, position, limit as usize).await?;
            let total = total.unwrap_or(position + ids.len());
            let uids = uids_for(state, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?, &account_id, &mailbox, &ids).await?;
            let mut got = by_id(acct.client.get_emails(&ids, HEADER_PROPS).await?.list);
            let emails: Vec<EmailHeader> =
                ids.iter().filter_map(|id| Some(to_header(&got.remove(id)?, *uids.get(id)?))).collect();
            Ok(crate::handlers::cache::with_native_expectation(json!({
                "nativeIdentity": mailvault_core::imap::NativeHeaderIdentity::new(account, &account_id, &mailbox, Some(1)).with_jmap_mailbox(&mailbox_id), "uidValidity": 1,
                "success": true, "emails": emails, "total": total, "page": page,
                "limit": limit, "hasMore": position + ids.len() < total, "skippedUids": Vec::<Option<u32>>::new(),
            }), expected))
        }

        "imap_check_mailbox_status" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            // The account's delta first, so the ledger and the counter below
            // are current. A delta that fails fails the probe: the app then
            // syncs (`syncProbe.js` "probe-failed"), never trusts stale counts.
            crate::sync_jmap::delta_only(state, account, &account_id).await?;
            let mb = mailbox_counts(acct, &mailbox).await?;
            let uid_next = uid_next(state, &account_id, &mailbox).await?;
            let (modseq, _) = meta_read(state, &account_id, &mailbox, None).await;
            Ok(json!({"exists": mb.total_emails, "uidValidity": 1, "uidNext": uid_next, "highestModseq": modseq}))
        }

        "imap_folder_status" => {
            let account_id = ledger_account(params)?;
            let wanted: Vec<String> = param(params, "mailboxes")?;
            // The account's delta first. Badges still answer when it fails:
            // the counts below come from the server either way.
            if let Err(e) = crate::sync_jmap::delta_only(state, account, &account_id).await {
                warn!("[jmap] {}: delta before folder status failed: {}", account_id, e);
            }
            let boxes = acct.current().await?;
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
            let mut uids: Vec<u32> = uids_for(state, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?, &account_id, &mailbox, &ids).await?.into_values().collect();
            uids.sort_unstable();
            Ok(json!({"uids": uids}))
        }

        "imap_fetch_headers_by_uids" => {
            let account_id = ledger_account(params)?;
            let mailbox = mailbox_param(params);
            let expected = crate::handlers::cache::native_header_seed(state, &account_id, &mailbox).await;
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
            Ok(crate::handlers::cache::with_native_expectation(json!({"emails": emails, "total": mb.total_emails, "uidValidity": 1, "nativeIdentity": mailvault_core::imap::NativeHeaderIdentity::new(account, &account_id, &mailbox, Some(1)).with_jmap_mailbox(&mb.id)}), expected))
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
                    let uids = uids_for(state, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?, &account_id, &mailbox, &ids).await?;
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
            let stamp = state.account_lifecycle.capture(&account_id).map_err(|_| Fail::Rpc("errors.keychainBusy".into()))?;
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
            let cached = auto_cache_with_ids(state, stamp.clone(), mailbox.clone(), uid, body.raw.clone(), dated, opened, Some(body.ids)).await?;
            // Not kept on disk (On Demand): the reads that follow this open
            // are served from memory (`raw_message`), as for IMAP.
            if !cached && opened {
                let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&stamp)).map_err(|_| Fail::Rpc("errors.keychainBusy".into()))?;
                state.raw_messages.remember(&stamp, &mailbox, uid, body.raw.clone());
            }
            let (st, mb, raw) = (Arc::clone(state), mailbox.clone(), body.raw);
            let render_stamp = stamp.clone();
            let rendered = blocking(move || crate::handlers::pgp::render(&st, render_stamp, &mb, uid, raw, cached)).await;
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
            let expected = crate::handlers::cache::native_header_seed(state, &account_id, &mailbox).await;
            let query: Option<String> = opt_param(params, "query");
            let filters: SearchFilters = opt_param(params, "filters").unwrap_or_default();
            let search = ServerSearch {
                query: query.as_deref(),
                from: filters.from.as_deref(),
                subject: filters.subject.as_deref(),
                since: filters.since.as_deref(),
                before: filters.before.as_deref(),
                ..Default::default()
            };
            let (emails, total, mailbox_id) = search_mailbox(state, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?, &account_id, &mailbox, &search).await?;
            Ok(crate::handlers::cache::with_native_expectation(json!({"nativeIdentity": mailvault_core::imap::NativeHeaderIdentity::new(account, &account_id, &mailbox, Some(1)).with_jmap_mailbox(&mailbox_id), "uidValidity": 1, "success": true, "emails": emails, "total": total}), expected))
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
                    let uids = uids_for(state, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?, &account_id, path, &[email_id.to_string()]).await?;
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

        "imap_set_flags" => set_flags(state, params, acct).await,
        "imap_move_emails" => move_emails(state, params, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?).await,
        "imap_delete_email" => delete_email(state, params, account, acct, original.ok_or_else(|| Fail::Rpc("errors.keychainBusy".into()))?).await,
        "imap_create_mailbox" => create_mailbox(params, acct).await,
        "imap_rename_mailbox" => rename_mailbox(params, acct).await,
        "imap_delete_mailbox" => delete_mailbox(params, acct).await,
        "imap_ensure_sent_mailbox" => ensure_sent_mailbox(acct).await,

        other => Err(Fail::Rpc(format!("E_JMAP_UNSUPPORTED: {other}"))),
    }
}

/// The `Email/query` conditions for a server search, the keys the IMAP side
/// sends as `UID SEARCH` (`ServerSearch::criteria`): text, from, to and
/// subject as JMAP's filters of those names, `since` (inclusive) and
/// `before` (exclusive) as `after`/`before` at UTC midnight, unread as
/// `notKeyword $seen`, and each excluded term as a `NOT` text condition.
/// Empty: nothing was asked.
fn search_conditions(search: &ServerSearch<'_>) -> Vec<Value> {
    let mut conditions: Vec<Value> = Vec::new();
    for (key, value) in [("text", search.query), ("from", search.from), ("to", search.to), ("subject", search.subject)] {
        if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
            let mut condition = serde_json::Map::new();
            condition.insert(key.to_string(), json!(v));
            conditions.push(Value::Object(condition));
        }
    }
    if let Some(after) = day_start(search.since) {
        conditions.push(json!({"after": after}));
    }
    if let Some(before) = day_start(search.before) {
        conditions.push(json!({"before": before}));
    }
    if search.unseen {
        conditions.push(json!({"notKeyword": "$seen"}));
    }
    for term in search.exclude.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        conditions.push(json!({"operator": "NOT", "conditions": [{"text": term}]}));
    }
    conditions
}

/// One mailbox searched on the server, newest first: the matching headers
/// (`source: "server-search"`, the newest `SEARCH_LIMIT`, as the IMAP arm
/// keeps) and the match count. Nothing asked: nothing found, as the IMAP
/// side answers a search with no keys.
async fn search_mailbox(
    state: &Arc<DaemonState>,
    acct: &AccountJmap,
    original: &crate::account_lifecycle::AccountStamp,
    account_id: &str,
    mailbox: &str,
    search: &ServerSearch<'_>,
) -> Result<(Vec<EmailHeader>, usize, String), Fail> {
    let mailbox_id = acct.mailbox_id(mailbox).await?;
    let mut conditions = search_conditions(search);
    if conditions.is_empty() {
        return Ok((Vec::new(), 0, mailbox_id));
    }
    conditions.insert(0, json!({"inMailbox": mailbox_id}));
    let filter = json!({"operator": "AND", "conditions": conditions});
    let (ids, total) = query_ids(&acct.client, filter, SEARCH_LIMIT).await?;
    let uids = uids_for(state, acct, original, account_id, mailbox, &ids).await?;
    let mut got = by_id(acct.client.get_emails(&ids, HEADER_PROPS).await?.list);
    let emails: Vec<EmailHeader> = ids
        .iter()
        .filter_map(|id| {
            let mut header = to_header(&got.remove(id)?, *uids.get(id)?);
            header.source = Some("server-search".to_string());
            Some(header)
        })
        .collect();
    Ok((emails, total, mailbox_id))
}

/// The search screen's server lane for a JMAP account
/// (`mail_search::run_server_lane`), on the account's session: the matching
/// headers of `mailbox` (`search_mailbox`) and the mailbox's count. An
/// expired or revoked session is forgotten and the search runs once more,
/// as a bridged RPC does (`answer_with_retry`).
pub(crate) async fn server_search(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    search: &ServerSearch<'_>,
) -> Result<(Vec<EmailHeader>, u32, mailvault_core::imap::NativeHeaderIdentity), String> {
    let original = state.account_lifecycle.capture(account_id).map_err(|_| "errors.keychainBusy".to_owned())?;
    let once = || async {
        let acct = state.jmap.get(config).await?;
        let exists = mailbox_counts(&acct, mailbox).await?.total_emails;
        let (emails, _, mailbox_id) = search_mailbox(state, &acct, &original, account_id, mailbox, search).await?;
        let identity = mailvault_core::imap::NativeHeaderIdentity::new(config, account_id, mailbox, Some(1)).with_jmap_mailbox(&mailbox_id);
        Ok::<_, Fail>((emails, exists, identity))
    };
    let answer = match once().await {
        Err(f) if is_auth_failure(&f) => {
            state.jmap.forget(config);
            once().await
        }
        other => other,
    };
    answer.map_err(|f| match f {
        Fail::Params(e) | Fail::Rpc(e) => e,
    })
}

// ── write side ──────────────────────────────────────────────────────────────

/// The IMAP arms' gone answer, word for word (api.js `UID_GONE_PREFIX`).
fn uid_gone(uid: u32, mailbox: &str) -> Fail {
    Fail::Rpc(format!("E_UID_GONE: Message UID {} is no longer in {}", uid, mailbox))
}

/// Can `keyword` be a JMAP keyword? RFC 8621 §4.1.1: 1 to 255 printable
/// ASCII characters, none of `( ) { ] % * " \`. So `\Deleted` and `\Recent`,
/// which `flag_to_keyword` passes through verbatim, have none.
fn is_keyword(keyword: &str) -> bool {
    !keyword.is_empty()
        && keyword.len() <= 255
        && keyword.bytes().all(|b| (0x21..=0x7e).contains(&b) && !b"(){]%*\"\\".contains(&b))
}

/// The raw message, flags and `receivedAt` behind `uid` in `mailbox`: a blob
/// download over the account's session, under the IMAP arms' body ceiling.
/// Every daemon path that reads one JMAP body by uid outside an RPC comes
/// through here: the deleted-mail bin, the raw-message fallback, the arrival
/// prefetch. `None`: gone (the ledger never issued the uid, the email no
/// longer exists, or it left the mailbox).
pub(crate) async fn fetch_by_uid(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    uid: u32,
) -> Result<Option<Fetched>, String> {
    let acct = state.jmap.get(config).await.map_err(|e| e.to_string())?;
    match fetch_body_timed(state, &acct, account_id, mailbox, uid).await {
        Ok(fetched) => Ok(fetched),
        Err(Fail::Params(e) | Fail::Rpc(e)) => Err(e),
    }
}

/// `fetch_by_uid` for several uids of one mailbox: the ledger is read once
/// and the emails are read back with one `Email/get` (not once per uid), then
/// each body is one blob download under the body ceiling. Only the uids that
/// are still there come back, in the order given; a body that could not be
/// downloaded is that uid's own `Err`, so one failure never hides the rest.
pub(crate) async fn fetch_by_uids(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    uids: &[u32],
) -> Result<Vec<(u32, Result<Fetched, String>)>, String> {
    let acct = state.jmap.get(config).await.map_err(|e| e.to_string())?;
    let pairs = acct.uid_to_id(state, account_id, mailbox, uids, false).await?;
    let ids: Vec<String> = pairs.iter().filter_map(|(_, id)| id.clone()).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mailbox_id = acct.mailbox_id(mailbox).await.map_err(|e| e.to_string())?;
    let mut got = by_id(
        acct.client
            .get_emails(&ids, &["id", "blobId", "threadId", "mailboxIds", "keywords", "receivedAt"])
            .await
            .map_err(|e| e.to_string())?
            .list,
    );
    let mut out = Vec::new();
    for (uid, id) in pairs {
        let Some((id, email)) = id.and_then(|id| got.remove(&id).map(|email| (id, email))).filter(|(_, email)| in_mailbox(email, &mailbox_id)) else {
            continue;
        };
        let fetched = match email["blobId"].as_str() {
            None => Err("E_JMAP_PROTOCOL: Email/get without blobId".to_string()),
            Some(blob) => match tokio::time::timeout(BODY_FETCH_TIMEOUT, acct.client.download(blob)).await {
                Ok(Ok(raw)) => Ok(Fetched {
                    raw,
                    flags: keywords_to_flags(&email["keywords"]),
                    received_at: email["receivedAt"].as_str().map(str::to_string),
                    ids: server_ids(&id, blob, &email),
                }),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err(format!(
                    "Timed out after {}s fetching message UID {} from {}",
                    BODY_FETCH_TIMEOUT.as_secs(),
                    uid,
                    mailbox
                )),
            },
        };
        out.push((uid, fetched));
    }
    Ok(out)
}

/// `fetch_by_uid` for the deleted-mail bin (`deleted::capture`,
/// `Source::Jmap`): the bytes and the flags.
pub(crate) async fn fetch_for_capture(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    uid: u32,
) -> Result<Option<(Vec<u8>, Vec<String>)>, String> {
    Ok(fetch_by_uid(state, config, account_id, mailbox, uid).await?.map(|f| (f.raw, f.flags)))
}

/// A user bulk capture reads its frozen stable provider id, never a uid
/// remapped by a later ledger read. Existing capture callers keep their path.
pub(crate) async fn fetch_for_capture_identified(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    mailbox: &str,
    mailbox_id: &str,
    email_id: &str,
) -> Result<Option<(Vec<u8>, Vec<String>)>, String> {
    let acct = state.jmap.get(config).await.map_err(|e| e.to_string())?;
    if acct.mailbox_id(mailbox).await.map_err(|e| e.to_string())? != mailbox_id {
        return Err("errors.bulkIdentityChanged".into());
    }
    match tokio::time::timeout(
        BODY_FETCH_TIMEOUT,
        fetch_body_id(&acct, email_id.to_owned(), mailbox_id.to_owned()),
    )
    .await
    {
        Ok(Ok(fetched)) => Ok(fetched.map(|f| (f.raw, f.flags))),
        Ok(Err(Fail::Params(e) | Fail::Rpc(e))) => Err(e),
        Err(_) => Err("errors.bulkIdentityUncertain".into()),
    }
}

/// A JMAP body's date in epoch ms, read as the download gates read an IMAP
/// one (`email_date_ms`): its own `Date:` header, else `receivedAt`.
pub(crate) fn dated_ms(raw: &[u8], received_at: Option<&str>) -> Option<i64> {
    mailvault_core::import_rehome::head_of(raw)
        .date_secs
        .and_then(|secs| secs.checked_mul(1000))
        .or_else(|| email_date_ms(None, received_at))
}

/// The emails whose Message-ID is `message_id` (bracketed or bare), in
/// `mailbox_id` or, with `None`, anywhere in the account, newest first. The
/// `header` filter matches a substring (RFC 8621 §4.4.1), so each hit is read
/// back and only an equal id counts: `<pre-e1@x>` never stands in for
/// `<e1@x>`.
pub(crate) async fn emails_with_message_id(
    client: &JmapClient,
    mailbox_id: Option<&str>,
    message_id: &str,
) -> Result<Vec<String>, JmapError> {
    let wanted = mailvault_core::maildir::normalize_message_id(message_id);
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let mut filter = json!({"header": ["Message-ID", wanted]});
    if let Some(id) = mailbox_id {
        filter["inMailbox"] = json!(id);
    }
    let (hits, _) = query_ids(client, filter, FIND_LIMIT).await?;
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let mut got = by_id(client.get_emails(&hits, &["id", "messageId"]).await?.list);
    let equal = |email: &Value| {
        email["messageId"]
            .as_array()
            .is_some_and(|ids| ids.iter().filter_map(Value::as_str).any(|m| mailvault_core::maildir::normalize_message_id(m) == wanted))
    };
    Ok(hits.into_iter().filter(|id| got.remove(id).is_some_and(|e| equal(&e))).collect())
}

/// Take `uids`' rows off the mailbox's header cache after the server took
/// them out of it. Their ledger rows stay: a uid is never issued twice, and
/// a label added back gets its old uid again. The server change has already
/// landed, so a custody failure is logged, never returned: an error would
/// have the app put the rows back and send the change a second time.
async fn drop_header_rows(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uids: Vec<u32>) {
    if uids.is_empty() {
        return;
    }
    let (st, aid, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    let removed = blocking(move || crate::custody::with_conn(&st, |c| cache::remove_headers(c, &aid, &mb, &uids)))
        .await
        .and_then(|r| r);
    if let Err(e) = removed {
        warn!("[jmap] {}/{}: header rows not removed: {}", account_id, mailbox, e);
    }
}

/// The path and id of the mailbox with `role` in a fresh listing.
pub(crate) fn role_mailbox(boxes: &Mailboxes, role: &str) -> Option<(String, String)> {
    let id = &boxes.list.iter().find(|m| m.role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(role)))?.id;
    let (path, _) = boxes.ids.iter().find(|(_, mailbox_id)| *mailbox_id == id)?;
    Some((path.clone(), id.clone()))
}

/// One `mailboxIds` patch: `mailbox_id`'s label on, Trash's off.
pub(crate) async fn put_back(acct: &AccountJmap, id: &str, mailbox_id: &str, trash_id: Option<String>, mailbox: &str) -> Result<(), String> {
    let mut toggles = vec![(mailbox_id.to_string(), true)];
    toggles.extend(trash_id.map(|t| (t, false)));
    let out = acct.client.set_mailboxes(&[(id.to_string(), toggles)]).await.map_err(|e| e.to_string())?;
    if !out.ok.iter().any(|ok| ok == id) {
        let kind = out.failed.iter().find(|(f, _)| f == id).map_or("serverFail", |(_, k)| k.as_str());
        return Err(format!("E_JMAP_METHOD: {kind}: {id} was not put back in {mailbox}"));
    }
    Ok(())
}

/// A server dedupe (`ImportResult::AlreadyExists`) named `existing_id` as the
/// copy of a message imported into `mailbox_id` (`mailbox` is its path, for the
/// error text). The copy may sit only in another mailbox, so the mailbox the
/// import was for gets its label, exactly as a recover relabels an email found
/// by Message-ID (`put_back`): the target on, Trash off, every other label as
/// it was. A copy that already carries the label, or that is gone, is left alone.
pub(crate) async fn adopt_deduped(acct: &AccountJmap, existing_id: &str, mailbox_id: &str, mailbox: &str) -> Result<(), String> {
    let got = acct.client.get_emails(&[existing_id.to_string()], &["id", "mailboxIds"]).await.map_err(|e| e.to_string())?;
    let Some(copy) = got.list.iter().find(|e| e["id"].as_str() == Some(existing_id)) else { return Ok(()) };
    if in_mailbox(copy, mailbox_id) {
        return Ok(());
    }
    let boxes = acct.current().await.map_err(|e| e.to_string())?;
    let trash_id = role_mailbox(&boxes, "trash").map(|(_, id)| id).filter(|t| t != mailbox_id);
    put_back(acct, existing_id, mailbox_id, trash_id, mailbox).await
}

/// `imap_set_flags`: the flags as keywords on the email behind `uid`, after
/// a re-check that it is still in the mailbox (gone: `E_UID_GONE:`).
/// `written` is what the server kept, as the IMAP arm's PERMANENTFLAGS
/// answer is: a flag with no JMAP keyword is left out, and a SetError
/// writes nothing (`[]`), a success the caller has to see, not an error.
async fn set_flags(state: &Arc<DaemonState>, params: &Value, acct: &AccountJmap) -> Result<Value, Fail> {
    let account_id = ledger_account(params)?;
    let uid: u32 = param(params, "uid")?;
    let mailbox = mailbox_param(params);
    let flags: Vec<String> = param(params, "flags")?;
    let add = opt_param::<String>(params, "action").as_deref().unwrap_or("add") == "add";
    let written: Vec<String> = flags.into_iter().filter(|f| is_keyword(&flag_to_keyword(f))).collect();
    if written.is_empty() {
        return Ok(json!({"success": true, "written": []}));
    }
    let pairs = acct.uid_to_id(state, &account_id, &mailbox, &[uid], true).await?;
    let Some(email_id) = pairs.into_iter().next().and_then(|(_, id)| id) else {
        return Err(uid_gone(uid, &mailbox));
    };
    let toggles: Vec<(String, bool)> = written.iter().map(|f| (flag_to_keyword(f), add)).collect();
    let out = acct.client.set_keywords(&[(email_id.clone(), toggles)]).await?;
    if out.ok.contains(&email_id) {
        return Ok(json!({"success": true, "written": written}));
    }
    match out.failed.iter().find(|(id, _)| *id == email_id) {
        Some((_, kind)) => {
            info!("[jmap] set_flags uid={} mailbox={}: {:?} not kept ({})", uid, mailbox, written, kind);
            Ok(json!({"success": true, "written": []}))
        }
        None => Err(JmapError::Protocol("Email/set did not answer for the email".into()).into()),
    }
}

/// `imap_move_emails`: one `mailboxIds` patch per email, the source label
/// off and the target's on, after a re-check that each uid is still in the
/// source (a gone uid moves nothing). The source ledger rows stay; only
/// their header rows go. `newUids` are the target ledger's uids, in the
/// order of `uids`, and null unless every uid moved: a shorter list would
/// pair a uid with the wrong message, and the IMAP arm's rule is never a
/// guess. A refusal other than `notFound` fails the move, as a refused
/// UID MOVE fails the IMAP arm.
async fn move_emails(state: &Arc<DaemonState>, params: &Value, acct: &AccountJmap, original: &crate::account_lifecycle::AccountStamp) -> Result<Value, Fail> {
    let account_id = ledger_account(params)?;
    let uids: Vec<u32> = param(params, "uids")?;
    let source: String = param(params, "sourceMailbox")?;
    let target: String = param(params, "targetMailbox")?;
    if uids.is_empty() {
        return Ok(json!({"success": true, "moved": 0, "newUids": null}));
    }
    let source_id = acct.mailbox_id(&source).await?;
    let target_id = acct.mailbox_id(&target).await?;
    if source_id == target_id {
        return Ok(json!({"success": true, "moved": 0, "newUids": null}));
    }
    let pairs = acct.uid_to_id(state, &account_id, &source, &uids, true).await?;
    let patches: Vec<(String, Vec<(String, bool)>)> = pairs
        .iter()
        .filter_map(|(_, id)| id.clone())
        .map(|id| (id, vec![(source_id.clone(), false), (target_id.clone(), true)]))
        .collect();
    let out = if patches.is_empty() { SetOutcome::default() } else { acct.client.set_mailboxes(&patches).await? };
    let moved: Vec<(u32, String)> =
        pairs.into_iter().filter_map(|(uid, id)| id.filter(|id| out.ok.contains(id)).map(|id| (uid, id))).collect();
    drop_header_rows(state, &account_id, &source, moved.iter().map(|(uid, _)| *uid).collect()).await;
    if let Some((id, kind)) = out.failed.iter().find(|(_, kind)| kind != "notFound") {
        warn!("[jmap] move {} -> {}: {} refused ({})", source, target, id, kind);
        return Err(JmapError::Method {
            kind: kind.clone(),
            description: Some(format!("{} of {} moved from {} to {}", moved.len(), uids.len(), source, target)),
        }
        .into());
    }
    let new_uids = if moved.len() == uids.len() {
        let ids: Vec<String> = moved.iter().map(|(_, id)| id.clone()).collect();
        match acct.ids_to_uids(state, original.clone(), &account_id, &target, &ids).await {
            Ok(new_uids) => Some(new_uids),
            Err(e) => {
                warn!("[jmap] move {} -> {}: no target uids: {}", source, target, e);
                None
            }
        }
    } else {
        None
    };
    Ok(json!({"success": true, "moved": moved.len(), "newUids": new_uids}))
}

/// What `remove_one` did on the server.
struct Removed {
    /// Where the message went, for an undo: Trash's path and its uid there.
    trash: Option<String>,
    trash_uid: Option<u32>,
    /// False when nothing changed: already gone, or a plain delete from Trash.
    changed: bool,
}

/// `imap_delete_email`, the IMAP arm's steps over JMAP:
/// 1. Into the deleted-mail bin first (`deleted::capture`, `Source::Jmap`),
///    unless the caller opts out (`bin: false`). A permanent delete that
///    cannot be captured is refused (`E_BIN_CAPTURE`): the bin would be its
///    only copy.
/// 2. `remove_one`: the label semantics rule.
/// 3. A capture this call made is dropped when the delete failed (not for a
///    permanent one, whose request may have landed with its reply lost, as
///    the IMAP arm keeps it) or changed nothing. On success the bin row
///    learns where the message went (`deleted::landed`).
async fn delete_email(state: &Arc<DaemonState>, params: &Value, account: &ImapConfig, acct: &AccountJmap, original: &crate::account_lifecycle::AccountStamp) -> Result<Value, Fail> {
    let account_id = ledger_account(params)?;
    let uid: u32 = param(params, "uid")?;
    let mailbox = mailbox_param(params);
    let permanent = opt_param::<bool>(params, "permanent").unwrap_or(false);
    let binned = if opt_param::<bool>(params, "bin").unwrap_or(true) {
        match deleted::capture_stamped(state, original.clone(), &account_id, &mailbox, uid, Source::Jmap { config: account }).await {
            Ok(binned) => binned,
            // An expired or revoked session read nothing: answered as itself,
            // so `answer_with_retry` connects again and runs the delete once
            // more, capture first.
            Err(e) if permanent && is_auth_error(&e) => return Err(Fail::Rpc(e)),
            Err(e) if permanent => {
                tracing::error!("[jmap] delete uid={} not deleted: could not keep a copy first: {}", uid, e);
                return Err(Fail::Rpc(format!("E_BIN_CAPTURE: {e}")));
            }
            Err(e) => {
                warn!("[jmap] delete uid={} goes ahead: could not keep a bin copy first (the server keeps it): {}", uid, e);
                None
            }
        }
    } else {
        None
    };
    match remove_one(state, acct, original, &account_id, &mailbox, uid, permanent).await {
        Ok(removed) => {
            let bin_id = match binned {
                Some((id, true)) if !removed.changed => {
                    deleted::forget_stamped(state, id, original.clone()).await;
                    None
                }
                other => other.map(|(id, _)| id),
            };
            if let (Some(id), true) = (bin_id.clone(), removed.changed) {
                deleted::landed_stamped(state, id, removed.trash.clone(), removed.trash_uid, original.clone()).await;
            }
            Ok(json!({"success": true, "trash": removed.trash, "trashUid": removed.trash_uid, "binId": bin_id}))
        }
        Err(f) => {
            if let Some((id, true)) = binned.filter(|_| !permanent) {
                deleted::forget_stamped(state, id, original.clone()).await;
            }
            Err(f)
        }
    }
}

/// Take the email behind `uid` out of `mailbox` by the label semantics rule
/// (`jmap::ops::remove_from`, ruling R5):
/// - A delete that needs Trash on an account without one is refused
///   (`E_JMAP_NO_TRASH`): Trash is never created, nothing is destroyed.
/// - A permanent delete from X treats X as Trash.
/// - A plain delete from Trash changes nothing.
///
/// The header row goes whenever the email is no longer in the mailbox; the
/// ledger row stays.
///
/// The mailbox and Trash ids come from the last listing (`last_listing`):
/// a delete moves counts, never ids or roles, so a full `Mailbox/get` per
/// delete would only fetch the same answer. A listing that lacks the
/// mailbox or a Trash (or none yet) is fetched again first.
///
/// No `ifInState` guard on the read-then-set in `remove_from` (Task 2's
/// deferred minor, decided here): the JMAP Email state is account-wide, so
/// any arrival anywhere in the account would fail the guard and turn deletes
/// on a busy account into retries. The patches are key-relative
/// (`mailboxIds/<id>`), so a label another client adds in between survives
/// them. Only a destroy acts on a stale read (a label added in between goes
/// with the email), and a destroy is a permanent delete, which
/// `delete_email` refuses to run without a bin copy.
async fn remove_one(
    state: &Arc<DaemonState>,
    acct: &AccountJmap,
    original: &crate::account_lifecycle::AccountStamp,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    permanent: bool,
) -> Result<Removed, Fail> {
    let listed = acct.last_listing().filter(|b| b.ids.contains_key(mailbox) && role_mailbox(b, "trash").is_some());
    let boxes = match listed {
        Some(boxes) => boxes,
        None => acct.refresh().await?,
    };
    let mailbox_id = boxes
        .ids
        .get(mailbox)
        .cloned()
        .ok_or_else(|| Fail::from(JmapError::Protocol(format!("no mailbox {mailbox}"))))?;
    let trash = role_mailbox(&boxes, "trash");
    let trash_id = trash.as_ref().map(|(_, id)| id.as_str());
    let pairs = acct.uid_to_id(state, account_id, mailbox, &[uid], false).await?;
    let unchanged = Removed { trash: None, trash_uid: None, changed: false };
    let Some(email_id) = pairs.into_iter().next().and_then(|(_, id)| id) else {
        // The ledger never issued it: nothing on the server to delete.
        return Ok(unchanged);
    };
    let outcome = match remove_from(&acct.client, &email_id, &mailbox_id, trash_id, permanent).await {
        Ok(outcome) => outcome,
        Err(JmapError::NoTrash) => {
            return Err(Fail::Rpc(format!(
                "E_JMAP_NO_TRASH: the account has no Trash mailbox to move UID {} from {} into",
                uid, mailbox
            )));
        }
        Err(e) => return Err(e.into()),
    };
    Ok(match outcome {
        RemoveOutcome::MovedToTrash if trash_id == Some(mailbox_id.as_str()) => unchanged,
        RemoveOutcome::Gone => {
            drop_header_rows(state, account_id, mailbox, vec![uid]).await;
            unchanged
        }
        RemoveOutcome::MovedToTrash => {
            drop_header_rows(state, account_id, mailbox, vec![uid]).await;
            let trash_path = trash.map(|(path, _)| path);
            let trash_uid = match &trash_path {
                Some(path) => match acct.ids_to_uids(state, original.clone(), account_id, path, &[email_id]).await {
                    Ok(uids) => uids.first().copied(),
                    Err(e) => {
                        warn!("[jmap] delete uid={}: no Trash uid: {}", uid, e);
                        None
                    }
                },
                None => None,
            };
            Removed { trash: trash_path, trash_uid, changed: true }
        }
        RemoveOutcome::LabelRemoved | RemoveOutcome::Destroyed => {
            drop_header_rows(state, account_id, mailbox, vec![uid]).await;
            Removed { trash: None, trash_uid: None, changed: true }
        }
    })
}

/// A `Mailbox/set` refusal of `key` under `not` ("notCreated", "notUpdated",
/// "notDestroyed") as an error naming its SetError type:
/// `E_JMAP_METHOD: <type>: <what>[: <description>]`.
fn refused(r: &Value, not: &str, key: &str, what: &str) -> Option<Fail> {
    let e = r[not].get(key)?;
    let kind = e["type"].as_str().unwrap_or("serverFail").to_string();
    let description = Some(match e["description"].as_str() {
        Some(d) => format!("{what}: {d}"),
        None => what.to_string(),
    });
    Some(JmapError::Method { kind, description }.into())
}

/// After a `Mailbox/set` landed: the path -> id map from a fresh listing. A
/// failed listing empties the map (the next lookup lists again) and is never
/// returned: the change is made, and an error would have the app send it
/// a second time.
async fn refresh_after_write(acct: &AccountJmap) {
    if let Err(e) = acct.refresh().await {
        warn!("[jmap] mailbox list not refreshed after a change: {}", e);
        acct.mailbox_ids.write().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

/// Where the folder at `path` goes: its parent's id (`None` at the top) and
/// its JMAP name. A U+2215 in the last segment stands for a "/" inside the
/// name (`mailbox_map`).
async fn placement(acct: &AccountJmap, path: &str) -> Result<(Option<String>, String), Fail> {
    let (parent, leaf) = match path.rsplit_once(DELIMITER) {
        Some((parent, leaf)) => (Some(parent), leaf),
        None => (None, path),
    };
    let name = leaf.replace('\u{2215}', "/");
    if name.trim().is_empty() {
        return Err(Fail::Params(format!("No folder name in {path}")));
    }
    let parent_id = match parent {
        Some(parent) => Some(acct.mailbox_id(parent).await?),
        None => None,
    };
    Ok((parent_id, name))
}

/// `imap_create_mailbox`: `Mailbox/set create` under the parent the path
/// names, subscribed as the IMAP arm subscribes (for the account's other
/// clients).
async fn create_mailbox(params: &Value, acct: &AccountJmap) -> Result<Value, Fail> {
    let path: String = param(params, "path")?;
    let (parent_id, name) = placement(acct, &path).await?;
    let r = acct
        .client
        .mailbox_set(json!({"create": {"new": {"name": name, "parentId": parent_id, "isSubscribed": true}}}))
        .await?;
    if let Some(f) = refused(&r, "notCreated", "new", &path) {
        return Err(f);
    }
    if r["created"].get("new").is_none() {
        return Err(JmapError::Protocol(format!("Mailbox/set did not create {path}")).into());
    }
    refresh_after_write(acct).await;
    Ok(json!({"success": true}))
}

/// `imap_rename_mailbox`: a new name, and a new parent when `to` sits
/// elsewhere (the app "deletes" a folder by renaming it under Trash).
/// Children follow on the server, as they follow an IMAP RENAME.
async fn rename_mailbox(params: &Value, acct: &AccountJmap) -> Result<Value, Fail> {
    let from: String = param(params, "from")?;
    let to: String = param(params, "to")?;
    let id = acct.mailbox_id(&from).await?;
    let (parent_id, name) = placement(acct, &to).await?;
    let mut update = serde_json::Map::new();
    update.insert(id.clone(), json!({"name": name, "parentId": parent_id}));
    let r = acct.client.mailbox_set(json!({"update": update})).await?;
    if let Some(f) = refused(&r, "notUpdated", &id, &from) {
        return Err(f);
    }
    if r["updated"].get(&id).is_none() {
        return Err(JmapError::Protocol(format!("Mailbox/set did not rename {from}")).into());
    }
    refresh_after_write(acct).await;
    Ok(json!({"success": true}))
}

/// `imap_delete_mailbox`: every path destroyed in one `Mailbox/set`, deepest
/// first (a mailbox cannot go before its children), with
/// `onDestroyRemoveEmails: false`: a folder that still holds mail is refused
/// (`mailboxHasEmail`), never emptied by the server. `deleted` counts the
/// mailboxes destroyed.
async fn delete_mailbox(params: &Value, acct: &AccountJmap) -> Result<Value, Fail> {
    let mut paths: Vec<String> = param(params, "paths")?;
    paths.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    paths.dedup();
    if paths.is_empty() {
        return Ok(json!({"success": true, "deleted": 0}));
    }
    let mut ids = Vec::with_capacity(paths.len());
    for path in &paths {
        ids.push(acct.mailbox_id(path).await?);
    }
    let r = acct.client.mailbox_set(json!({"destroy": ids, "onDestroyRemoveEmails": false})).await?;
    let destroyed = r["destroyed"].as_array().map_or(0, Vec::len);
    let refusal = paths.iter().zip(&ids).find_map(|(path, id)| refused(&r, "notDestroyed", id, path));
    refresh_after_write(acct).await;
    match refusal {
        Some(f) => Err(f),
        None => Ok(json!({"success": true, "deleted": destroyed})),
    }
}

/// `snooze.ensure_folder` over JMAP: the path of the role=snoozed mailbox,
/// else of one named "Snoozed" anywhere in the tree
/// (`app_db::snooze::SNOOZED_MAILBOX`, as the IMAP side reuses
/// `INBOX.Snoozed`), else of a new top-level one made with `Mailbox/set`. A
/// create the server answers with a SetError is a server that will not host
/// it: `E_SNOOZE_FOLDER_REFUSED:`, and the app snoozes on this computer.
pub(crate) async fn ensure_snoozed_mailbox(acct: &AccountJmap) -> Result<String, String> {
    let name = mailvault_core::app_db::snooze::SNOOZED_MAILBOX;
    let boxes = acct.refresh().await.map_err(|e| e.to_string())?;
    let existing = role_mailbox(&boxes, "snoozed").map(|(path, _)| path).or_else(|| {
        let m = boxes.list.iter().find(|m| m.name.eq_ignore_ascii_case(name))?;
        boxes.ids.iter().find(|(_, id)| **id == m.id).map(|(path, _)| path.clone())
    });
    if let Some(path) = existing {
        return Ok(path);
    }
    let r = acct
        .client
        .mailbox_set(json!({"create": {"snoozed": {"name": name, "parentId": null, "isSubscribed": true}}}))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(e) = r["notCreated"].get("snoozed") {
        return Err(format!(
            "{} {}: {}",
            crate::imap::SNOOZE_FOLDER_REFUSED,
            e["type"].as_str().unwrap_or("serverFail"),
            e["description"].as_str().unwrap_or("the server will not create a Snoozed folder")
        ));
    }
    let created = r["created"]["snoozed"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| JmapError::Protocol("Mailbox/set did not create Snoozed".into()).to_string())?;
    refresh_after_write(acct).await;
    let path = acct.mailbox_ids.read().unwrap_or_else(|p| p.into_inner()).iter().find(|(_, id)| **id == created).map(|(p, _)| p.clone());
    // A top-level mailbox's path is its name.
    Ok(path.unwrap_or_else(|| name.to_string()))
}

/// `imap_ensure_sent_mailbox`: the path of the role=sent mailbox, else of a
/// top-level "Sent" with no role (a create would clash with its name), else
/// of a new `{name: "Sent", role: "sent"}`. A bare string, as the IMAP arm
/// answers.
async fn ensure_sent_mailbox(acct: &AccountJmap) -> Result<Value, Fail> {
    let boxes = acct.refresh().await?;
    if let Some((path, _)) = role_mailbox(&boxes, "sent") {
        return Ok(json!(path));
    }
    let plain = boxes.list.iter().find(|m| m.parent_id.is_none() && m.role.is_none() && m.name.eq_ignore_ascii_case("Sent"));
    if let Some((path, _)) = plain.and_then(|m| boxes.ids.iter().find(|(_, id)| **id == m.id)) {
        return Ok(json!(path));
    }
    let r = acct
        .client
        .mailbox_set(json!({"create": {"sent": {"name": "Sent", "role": "sent", "isSubscribed": true}}}))
        .await?;
    if let Some(f) = refused(&r, "notCreated", "sent", "Sent") {
        return Err(f);
    }
    let created = r["created"]["sent"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| Fail::from(JmapError::Protocol("Mailbox/set did not create Sent".into())))?;
    refresh_after_write(acct).await;
    let path = acct.mailbox_ids.read().unwrap_or_else(|p| p.into_inner()).iter().find(|(_, id)| **id == created).map(|(p, _)| p.clone());
    // A top-level mailbox's path is its name.
    Ok(json!(path.unwrap_or_else(|| "Sent".to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::custody::db::{meta_get, meta_set};
    use mailvault_core::header_cache::sidecar_dir;
    use mock_jmap::{Limits, MockJmap, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
    use mailvault_core::graph_ledger::JMAP_LEDGER_FILE;
    use mailvault_core::app_db::{self, deleted as bin};
    use mailvault_core::custody::cache;
    use std::collections::BTreeSet;

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
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        std::fs::write(dir.join("accounts.json"), r#"[{"id":"acct-1"}]"#).unwrap();
        state.account_lifecycle.seed(
            &mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&dir)).unwrap(),
        );
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
        // Every real `imap_*` arm is answered since Task 5b: an arm added to
        // `imap.rs` later, before it is bridged, takes this path.
        let resp = call(&state, "imap_not_bridged", json!({"account": a, "uid": 1, "mailbox": "INBOX"})).await;
        let message = err(resp);
        assert!(message.starts_with("E_JMAP_UNSUPPORTED: imap_not_bridged"), "{message}");
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
        assert_eq!(p1["nativeIdentity"]["jmapMailboxId"], "mb-inbox");
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
        assert_eq!(emails[0]["_jmapId"], json!("e2"));
        assert_eq!(r["nativeIdentity"]["uidValidity"], json!(1));
        assert_eq!(r["nativeIdentity"]["jmapMailboxId"], "mb-inbox");
        assert_eq!(r["nativeIdentity"]["originHash"].as_str().map(str::len), Some(64));
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
        let mailbox = mailvault_core::message_store::mailbox_dir(&vault_root(&state).unwrap(), "acct-1", "INBOX");
        assert!(!mailbox.join("jmap").exists(), "a Maildir vault keeps no record and no server ids");
    }

    /// Plan A Task 14: opened in a JMAP-format vault, the message is a record
    /// carrying the server's ids (`server`, and the `email.id` and
    /// `email.threadId` they give). Opened again, the record already holds
    /// them and is not rewritten.
    #[tokio::test]
    async fn get_email_light_records_server_ids_in_a_jmap_vault() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let root = vault_root(&state).unwrap();
        mailvault_core::message_store::set_vault_format(&root, mailvault_core::message_store::Format::Jmap).unwrap();
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        let open = json!({"account": a, "uid": e1, "mailbox": "INBOX"});

        let r = ok(call(&state, "imap_get_email_light", open.clone()).await);

        assert_eq!(r["cached"], json!(true));
        let record = mailvault_core::message_store::mailbox_dir(&root, "acct-1", "INBOX").join("jmap").join(format!("{e1}.json"));
        let rec: Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        let blob = m.read(|s| s.email("acc1", "e1").map(|e| e.blob_id.clone())).unwrap();
        assert_eq!(rec["server"], json!({"emailId": "e1", "blobId": blob, "threadId": "Te1"}));
        assert_eq!((rec["email"]["id"].clone(), rec["email"]["threadId"].clone()), (json!("e1"), json!("Te1")));

        let stamp = || (std::fs::read(&record).unwrap(), std::fs::metadata(&record).unwrap().modified().unwrap());
        let before = stamp();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let again = ok(call(&state, "imap_get_email_light", open).await);
        assert_eq!(again["cached"], json!(true));
        assert_eq!(stamp(), before, "the same ids: the record is not rewritten");
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
        assert_eq!(by_text["nativeIdentity"]["jmapMailboxId"], "mb-inbox");
        assert_eq!(by_text["total"], json!(1));
        assert_eq!(by_text["emails"][0]["messageId"], json!("<e2@x>"));
        assert_eq!(by_text["emails"][0]["source"], json!("server-search"));
        let by_from = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "INBOX", "filters": {"from": "bob"}})).await);
        assert_eq!(by_from["emails"].as_array().unwrap().len(), 1);
        assert_eq!(by_from["emails"][0]["messageId"], json!("<e2@x>"));
        let in_work = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "Work", "query": "two"})).await);
        assert_eq!(in_work["total"], json!(0), "the search stays in its mailbox");
        let nothing = ok(call(&state, "imap_search_emails", json!({"account": a, "mailbox": "INBOX"})).await);
        let config = serde_json::from_value(a).unwrap();
        assert_eq!(nothing, json!({"success": true, "emails": [], "total": 0, "uidValidity": 1,
            "nativeIdentity": mailvault_core::imap::NativeHeaderIdentity::new(&config, "acct-1", "INBOX", Some(1)).with_jmap_mailbox("mb-inbox"),
            "nativeExpectedIdentity": null}));
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

    // ── write side (Task 5b) ───────────────────────────────────────────────

    /// The app's header rows for `mailbox`, as its list writes them: a
    /// listing alone writes none.
    fn seed_headers(state: &Arc<DaemonState>, mailbox: &str, listing: &Value) {
        let rows = json!({"emails": listing["emails"]}).to_string();
        crate::custody::with_conn(state, |c| cache::save_headers(c, "acct-1", mailbox, &rows)).unwrap();
    }

    fn header_uids(state: &Arc<DaemonState>, mailbox: &str) -> Vec<u32> {
        let mut uids: Vec<u32> = crate::custody::with_conn(state, |c| cache::uid_set(c, "acct-1", mailbox)).unwrap().into_iter().collect();
        uids.sort_unstable();
        uids
    }

    /// The mailbox ids the mock has `email_id` in (empty: destroyed).
    fn labels(m: &MockJmap, email_id: &str) -> BTreeSet<String> {
        m.read(|s| s.email("acc1", email_id).map(|e| e.mailbox_ids.clone()).unwrap_or_default())
    }

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// The bytes the deleted-mail bin keeps for `bin_id`.
    fn binned(state: &Arc<DaemonState>, bin_id: &str) -> Vec<u8> {
        bin::read_eml(&state.app_dir, bin_id).unwrap()
    }

    #[tokio::test]
    async fn set_flags_adds_and_removes_keywords() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e2 = uid_in(&list(&state, &a, "INBOX").await, "<e2@x>");
        let keywords = || m.read(|s| s.email("acc1", "e2").unwrap().keywords.clone());
        let added = ok(call(&state, "imap_set_flags", json!({"account": a, "uid": e2, "mailbox": "INBOX", "flags": ["\\Seen", "\\Deleted"], "action": "add"})).await);
        assert_eq!(added, json!({"success": true, "written": ["\\Seen"]}), "\\Deleted has no JMAP keyword");
        assert_eq!(keywords(), set(&["$flagged", "$seen"]));
        let removed = ok(call(&state, "imap_set_flags", json!({"account": a, "uid": e2, "mailbox": "INBOX", "flags": ["\\Flagged"], "action": "remove"})).await);
        assert_eq!(removed, json!({"success": true, "written": ["\\Flagged"]}));
        assert_eq!(keywords(), set(&["$seen"]));
        let none = ok(call(&state, "imap_set_flags", json!({"account": a, "uid": e2, "mailbox": "INBOX", "flags": ["\\Recent"]})).await);
        assert_eq!(none, json!({"success": true, "written": []}), "nothing writable is a success, not an error");
        assert_eq!(m.count_calls("Email/set"), 2, "no request for nothing writable");
    }

    #[tokio::test]
    async fn set_flags_on_a_uid_that_left_the_mailbox_answers_uid_gone() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e1 = uid_in(&list(&state, &a, "INBOX").await, "<e1@x>");
        m.mutate(|s| s.remove_from_mailbox("acc1", "e1", "mb-inbox"));
        let message = err(call(&state, "imap_set_flags", json!({"account": a, "uid": e1, "mailbox": "INBOX", "flags": ["\\Flagged"]})).await);
        assert_eq!(message, format!("E_UID_GONE: Message UID {e1} is no longer in INBOX"));
        let never = err(call(&state, "imap_set_flags", json!({"account": a, "uid": 99, "mailbox": "INBOX", "flags": ["\\Flagged"]})).await);
        assert!(never.starts_with("E_UID_GONE:"), "a uid the ledger never issued: {never}");
        assert_eq!(m.count_calls("Email/set"), 0, "nothing is written for a gone uid");
        assert!(ledger(&state, "INBOX").values().any(|id| id == "e1"), "ledger rows are never removed");
    }

    #[tokio::test]
    async fn move_relabels_and_keeps_the_source_ledger_row() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let listing = list(&state, &a, "INBOX").await;
        let (e1, e2) = (uid_in(&listing, "<e1@x>"), uid_in(&listing, "<e2@x>"));
        seed_headers(&state, "INBOX", &listing);
        assert_eq!(header_uids(&state, "INBOX"), vec![e1, e2]);
        let r = ok(call(&state, "imap_move_emails", json!({"account": a, "uids": [e1], "sourceMailbox": "INBOX", "targetMailbox": "Work"})).await);
        assert_eq!(r["success"], json!(true));
        assert_eq!(r["moved"], json!(1));
        let work_uid = r["newUids"][0].as_u64().expect("e1 has a Work uid") as u32;
        assert_eq!(ledger(&state, "Work").get(&work_uid).map(String::as_str), Some("e1"));
        assert_eq!(labels(&m, "e1"), set(&["mb-work"]));
        assert_eq!(ledger(&state, "INBOX").get(&e1).map(String::as_str), Some("e1"), "the INBOX ledger row is kept");
        assert_eq!(header_uids(&state, "INBOX"), vec![e2], "only the moved uid's header row goes");
        let back = ok(call(&state, "imap_move_emails", json!({"account": a, "uids": [work_uid], "sourceMailbox": "Work", "targetMailbox": "INBOX"})).await);
        assert_eq!(back["newUids"], json!([e1]), "a label added back gets its old uid");
        let again = ok(call(&state, "imap_move_emails", json!({"account": a, "uids": [work_uid], "sourceMailbox": "Work", "targetMailbox": "INBOX"})).await);
        assert_eq!(again, json!({"success": true, "moved": 0, "newUids": null}), "a uid no longer in the source moves nothing");
    }

    #[tokio::test]
    async fn delete_of_an_email_with_another_label_removes_only_that_label() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let listing = list(&state, &a, "INBOX").await;
        let (e1, e2) = (uid_in(&listing, "<e1@x>"), uid_in(&listing, "<e2@x>"));
        seed_headers(&state, "INBOX", &listing);
        let r = ok(call(&state, "imap_delete_email", json!({"account": a, "uid": e1, "mailbox": "INBOX", "permanent": false})).await);
        assert_eq!(r["success"], json!(true));
        assert_eq!((&r["trash"], &r["trashUid"]), (&Value::Null, &Value::Null), "nothing went to Trash: {r}");
        assert_eq!(labels(&m, "e1"), set(&["mb-work"]), "still in Work, not in Trash");
        assert_eq!(binned(&state, r["binId"].as_str().expect("captured first")), E1_RAW.as_bytes());
        assert_eq!(ledger(&state, "INBOX").get(&e1).map(String::as_str), Some("e1"), "the ledger row is kept");
        assert_eq!(header_uids(&state, "INBOX"), vec![e2], "the header row goes");
    }

    #[tokio::test]
    async fn delete_of_a_lone_email_moves_it_to_trash_then_a_permanent_delete_destroys_it() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e2 = uid_in(&list(&state, &a, "INBOX").await, "<e2@x>");
        let r = ok(call(&state, "imap_delete_email", json!({"account": a, "uid": e2, "mailbox": "INBOX", "permanent": false})).await);
        assert_eq!(r["trash"], json!("Trash"));
        let trash_uid = r["trashUid"].as_u64().expect("the Trash uid, for an undo") as u32;
        assert_eq!(ledger(&state, "Trash").get(&trash_uid).map(String::as_str), Some("e2"));
        assert_eq!(labels(&m, "e2"), set(&["mb-trash"]));
        assert_eq!(binned(&state, r["binId"].as_str().expect("captured first")), E2_RAW.as_bytes());

        let purged = ok(call(&state, "imap_delete_email", json!({"account": a, "uid": trash_uid, "mailbox": "Trash", "permanent": true})).await);
        assert_eq!((&purged["trash"], &purged["trashUid"]), (&Value::Null, &Value::Null));
        assert!(m.read(|s| s.email("acc1", "e2").is_none()), "destroyed: Trash was its only mailbox");
        assert_eq!(binned(&state, purged["binId"].as_str().expect("a permanent delete keeps a copy")), E2_RAW.as_bytes());
        assert_eq!(ledger(&state, "Trash").get(&trash_uid).map(String::as_str), Some("e2"), "ledger rows are never removed");

        let again = ok(call(&state, "imap_delete_email", json!({"account": a, "uid": trash_uid, "mailbox": "Trash", "permanent": true})).await);
        assert_eq!(again["success"], json!(true), "deleting what is already gone is not an error");
        assert_eq!(again["binId"], purged["binId"], "the copy the first attempt kept");
    }

    #[tokio::test]
    async fn delete_that_needs_a_trash_the_account_lacks_is_refused() {
        let mut s = common_scenario();
        s.accounts[0].mailboxes.retain(|mb| mb.id != "mb-trash");
        let (state, m) = test_state_with_mock(s).await;
        let a = jmap_account(&m);
        let listing = list(&state, &a, "INBOX").await;
        let (e1, e2) = (uid_in(&listing, "<e1@x>"), uid_in(&listing, "<e2@x>"));
        let message = err(call(&state, "imap_delete_email", json!({"account": a, "uid": e2, "mailbox": "INBOX", "permanent": false})).await);
        assert!(message.starts_with("E_JMAP_NO_TRASH:"), "{message}");
        assert_eq!(labels(&m, "e2"), set(&["mb-inbox"]), "untouched, never destroyed");
        assert_eq!(m.count_calls("Email/set"), 0);
        let kept = app_db::with(&state.app_dir, |c| bin::find(c, &state.app_dir, "acct-1", "INBOX", e2)).unwrap();
        assert_eq!(kept, None, "the capture of a delete that did not happen is dropped");
        // e1 has another label: taking INBOX's off needs no Trash.
        let r = ok(call(&state, "imap_delete_email", json!({"account": a, "uid": e1, "mailbox": "INBOX", "permanent": false})).await);
        assert_eq!(r["trash"], Value::Null);
        assert_eq!(labels(&m, "e1"), set(&["mb-work"]));
    }

    #[tokio::test]
    async fn create_rename_and_delete_mailbox() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let named = |name: &str| {
            m.read(|s| s.account("acc1").mailboxes.values().find(|mb| mb.name == name).map(|mb| (mb.id.clone(), mb.parent_id.clone())))
        };
        assert_eq!(ok(call(&state, "imap_create_mailbox", json!({"account": a, "path": "Work/New"})).await), json!({"success": true}));
        let (new_id, parent) = named("New").expect("created");
        assert_eq!(parent.as_deref(), Some("mb-work"));

        // The app "deletes" a folder by renaming it under Trash.
        assert_eq!(ok(call(&state, "imap_rename_mailbox", json!({"account": a, "from": "Work/New", "to": "Trash/Old"})).await), json!({"success": true}));
        assert_eq!(named("Old"), Some((new_id.clone(), Some("mb-trash".to_string()))));
        let acct = state.jmap.get(&config(&a)).await.unwrap();
        let ids = acct.mailbox_ids.read().unwrap().clone();
        assert_eq!(ids.get("Trash/Old"), Some(&new_id), "the path map is refreshed");
        assert!(!ids.contains_key("Work/New"));

        assert_eq!(ok(call(&state, "imap_delete_mailbox", json!({"account": a, "paths": ["Trash/Old"]})).await), json!({"success": true, "deleted": 1}));
        assert_eq!(named("Old"), None);
        assert!(m.requests().iter().any(|r| r.body_contains("\"onDestroyRemoveEmails\":false")));

        // A folder that still holds mail is refused, never emptied.
        let refused = err(call(&state, "imap_delete_mailbox", json!({"account": a, "paths": ["Work/Sub"]})).await);
        assert!(refused.contains("mailboxHasEmail"), "{refused}");
        assert!(named("Sub").is_some());
        assert!(m.read(|s| s.email("acc1", "e3").is_some()));
    }

    #[tokio::test]
    async fn ensure_sent_mailbox_finds_or_creates_the_sent_role() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        assert_eq!(ok(call(&state, "imap_ensure_sent_mailbox", json!({"account": a})).await), json!("Sent"), "a bare path, as the IMAP arm answers");
        assert!(m.read(|s| s.account("acc1").mailboxes.values().any(|mb| mb.name == "Sent" && mb.role.as_deref() == Some("sent"))));
        assert_eq!(ok(call(&state, "imap_ensure_sent_mailbox", json!({"account": a})).await), json!("Sent"));
        assert_eq!(m.count_calls("Mailbox/set"), 1, "found the second time, not created again");
    }

    #[tokio::test]
    async fn ensure_sent_mailbox_takes_a_top_level_sent_without_a_role() {
        let mut s = common_scenario();
        s.accounts[0].mailboxes.push(ScenarioMailbox { id: "mb-sent".into(), name: "Sent".into(), parent_id: None, role: None, emails: vec![] });
        let (state, m) = test_state_with_mock(s).await;
        assert_eq!(ok(call(&state, "imap_ensure_sent_mailbox", json!({"account": jmap_account(&m)})).await), json!("Sent"));
        assert_eq!(m.count_calls("Mailbox/set"), 0, "a create would clash with its name");
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

    // ── Task 9c ────────────────────────────────────────────────────────────

    /// A delete reads the mailbox list it already holds: two deletes in a row
    /// send no `Mailbox/get`, though each moves the counts.
    #[tokio::test]
    async fn jmap_a_delete_reads_the_mailbox_list_without_a_full_mailbox_get() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let listing = list(&state, &a, "INBOX").await;
        let (e1, e2) = (uid_in(&listing, "<e1@x>"), uid_in(&listing, "<e2@x>"));
        let before = m.count_calls("Mailbox/get");
        ok(call(&state, "imap_delete_email", json!({"account": a, "uid": e1, "mailbox": "INBOX", "permanent": false})).await);
        let r = ok(call(&state, "imap_delete_email", json!({"account": a, "uid": e2, "mailbox": "INBOX", "permanent": false})).await);
        assert_eq!(r["trash"], json!("Trash"), "the Trash the last listing named");
        assert_eq!(m.count_calls("Mailbox/get"), before, "no full listing per delete");
        assert_eq!(labels(&m, "e1"), set(&["mb-work"]));
        assert_eq!(labels(&m, "e2"), set(&["mb-trash"]));
    }

    /// A permanent delete on a revoked session: the capture's `E_JMAP_AUTH`
    /// is answered as itself, so the delete connects again once, never
    /// `E_BIN_CAPTURE` (which no retry follows). Nothing is destroyed.
    #[tokio::test]
    async fn jmap_a_permanent_delete_on_a_revoked_session_reconnects_instead_of_failing_the_capture() {
        let (state, m) = test_state_with_mock(common_scenario()).await;
        let a = jmap_account(&m);
        let e2 = uid_in(&list(&state, &a, "INBOX").await, "<e2@x>");
        m.mutate(|s| s.account_mut("acc1").password = "revoked".into());
        let message = err(call(&state, "imap_delete_email", json!({"account": a, "uid": e2, "mailbox": "INBOX", "permanent": true})).await);
        assert!(message.starts_with("E_JMAP_AUTH:"), "{message}");
        assert_eq!(session_fetches(&m), 2, "the retry connected again");
        assert_eq!(labels(&m, "e2"), set(&["mb-inbox"]), "nothing destroyed");
    }
}

/// Mechanism over memory: every `"imap_…" =>` arm in `handlers/imap.rs` has
/// a JMAP decision, `HANDLED` or `UNSUPPORTED` with its reason.
#[cfg(test)]
mod guard {
    #[test]
    fn every_imap_rpc_has_a_jmap_decision() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/handlers/imap.rs")).unwrap();
        let arms: std::collections::BTreeSet<String> = src.lines()
            .filter_map(|l| l.trim().strip_prefix('"').and_then(|r| r.split_once("\" =>")).map(|(n, _)| n.to_string()))
            .filter(|n| n.starts_with("imap_")).collect();
        let decided: std::collections::BTreeSet<String> = super::HANDLED.iter().map(|s| s.to_string())
            .chain(super::UNSUPPORTED.iter().map(|(s, _)| s.to_string())).collect();
        let missing: Vec<_> = arms.difference(&decided).collect();
        assert!(missing.is_empty(), "imap RPCs with no JMAP decision: {missing:?}");
    }
}
