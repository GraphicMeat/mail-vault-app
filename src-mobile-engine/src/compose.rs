//! Compose: `mobile.compose.prepare`, `mobile.compose.send` and the local drafts
//! (`mobile.drafts.save/list/get/delete`).
//!
//! A message's fields ([`Fields`]) are what a draft row (`drafts.json`) and an outbox row
//! (`outbox.draft_json`) hold: addresses, subject, text, threading ids and the handles of picked
//! files (`out/<16 hex>/<name>`, see `outgoing.rs`) with their name, size and type. Never the
//! file's bytes and never a secret: the bytes are read from the picked file when the outbox sends.
//!
//! `send` checks everything it can before it journals, with no network: the account, the
//! addresses (core's recipient check, as on desktop), every handle (`ATTACHMENT_MISSING`) and the
//! total attachment size (`TOO_LARGE` above the account's [`attachment_limit`]: 25 MB, what
//! fits Graph's 4 MB `sendMail` body for a Graph account, or a JMAP session's upload limits). Then one write
//! transaction adds the outbox row (with the Message-ID every attempt sends under) and removes the
//! draft it came from; the outbox worker does the rest (`outbox.rs`).
//!
//! Send later (plan 4 Task 8): `sendAtMs` holds the row back until then. The delay is checked by
//! core's `send::schedule::schedule_allowed` (free up to 5 minutes, Premium up to a day, never
//! further) with no network, and the row is written `queued` with both `not_before_ms` (the wait
//! the worker honours) and `scheduled_ms` (the time the user picked, which a retry wait never
//! moves) at that time. Nothing else schedules: the worker sends a row once its `not_before_ms`
//! has come, Premium or not (a lapse after scheduling cancels nothing).
//!
//! Drafts are local only (no IMAP Drafts folder). A draft keeps its picked files until it is
//! deleted or sent; a send moves them to the outbox row, which deletes them once sent.

use crate::accounts::{load_account, AccountRow};
use crate::db::{Engine, Shared};
use crate::outbox;
use crate::outgoing::resolve_outgoing;
use crate::rpc::{parse, RpcError};
use mailvault_core::filename_safety::safe_handle_name;
use mailvault_core::mime_types::mime_of_name;
use mailvault_core::compose_prep::{self, quoted_text, Account, Context, QuoteLabels};
use mailvault_core::send::limits;
use mailvault_core::send::schedule::schedule_allowed;
use mailvault_core::smtp::{self, OutgoingEmail};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Most bytes of attachments `f` may carry on account `account_id` (`acct`): core's
/// [`limits::attachment_budget`] for the account's kind, a JMAP account with the limits its last
/// session stored (`backend::jmap::stored_limits`).
pub(crate) fn attachment_limit(shared: &Shared, account_id: &str, acct: &AccountRow, f: &Fields) -> u64 {
    let header = (f.subject.len() + f.to.len() + f.cc.len() + f.bcc.len() + f.references.len()) as u64;
    let kind = limits::SendKind::of(&acct.kind);
    let jmap = if kind == limits::SendKind::Jmap {
        let (upload, attachments) = crate::backend::jmap::stored_limits(shared, account_id);
        limits::JmapLimits { upload, attachments }
    } else {
        limits::JmapLimits::default()
    };
    limits::attachment_budget(kind, f.text.len() as u64, header, jmap)
}

/// How long a reply or forward waits for a body that is not cached.
const BODY_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// A send held back until `at_ms` (unix ms; `now_ms` is the engine's clock): allowed as core's
/// [`schedule_allowed`] says with this phone's Premium answer, else `RpcError::Schedule`
/// (`PREMIUM_REQUIRED`, `SCHEDULE_TOO_FAR`). A time already past is no delay. Answers the time to
/// store as the row's schedule: `None` for one not in the future (sent at once, not "scheduled").
pub(crate) fn schedule_check(shared: &Shared, at_ms: i64, now_ms: i64) -> Result<Option<i64>, RpcError> {
    let delay = std::time::Duration::from_millis(u64::try_from(at_ms.saturating_sub(now_ms)).unwrap_or(0));
    schedule_allowed(delay, crate::premium::active(shared)).map_err(RpcError::Schedule)?;
    Ok((at_ms > now_ms).then_some(at_ms))
}

/// A string field the page may send as `null`.
fn nullable<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// One picked file: its handle, and what the page shows for it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Attached {
    #[serde(deserialize_with = "nullable")]
    pub(crate) handle: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) name: String,
    pub(crate) size: u64,
    #[serde(deserialize_with = "nullable")]
    pub(crate) mime: String,
}

/// A message's fields, as drafts and the outbox keep them.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Fields {
    #[serde(deserialize_with = "nullable")]
    pub(crate) to: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) cc: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) bcc: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) subject: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) text: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) in_reply_to: String,
    #[serde(deserialize_with = "nullable")]
    pub(crate) references: String,
    pub(crate) attachments: Vec<Attached>,
    /// What the page started the message as (`new`, `reply`, `replyAll`, `forward`), so a
    /// reopened draft keeps its title. Not used for sending.
    #[serde(deserialize_with = "nullable", skip_serializing_if = "String::is_empty")]
    pub(crate) mode: String,
    /// An outbox row's follow-up reminder, in days (`mobile.compose.send` sets it after
    /// [`crate::followup::remind_check`]; a draft never carries one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) remind_after_days: Option<i64>,
}

impl Fields {
    /// What a stored row holds; a row that does not read is empty.
    pub(crate) fn read(json: &str) -> Fields {
        serde_json::from_str(json).unwrap_or_default()
    }

    /// The `out/` dirs the fields' handles name.
    pub(crate) fn dirs(&self) -> Vec<String> {
        let mut out: Vec<String> = self.attachments.iter().filter_map(|a| outbox::dir_of(&a.handle)).map(String::from).collect();
        out.sort();
        out.dedup();
        out
    }

    /// Core's outgoing message, with `attachments` already read and base64-encoded.
    pub(crate) fn outgoing(&self, message_id: Option<String>, attachments: Vec<smtp::OutgoingAttachment>) -> OutgoingEmail {
        let opt = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
        OutgoingEmail {
            to: self.to.clone(),
            subject: self.subject.clone(),
            text: Some(self.text.clone()),
            html: None,
            cc: opt(&self.cc),
            bcc: opt(&self.bcc),
            in_reply_to: opt(&self.in_reply_to),
            references: opt(&self.references),
            attachments: (!attachments.is_empty()).then_some(attachments),
            message_id,
        }
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 16 hex chars from the OS-keyed `RandomState` mixed with the clock.
pub(crate) fn random_hex() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    format!("{:016x}", h.finish())
}

/// A Message-ID under the account's domain: `<hex.ms@domain>`, printable ASCII only (core sends
/// a caller's id only when it is).
fn new_message_id(email: &str) -> String {
    let domain = email.rsplit_once('@').map(|(_, d)| d.trim()).unwrap_or("");
    let domain = if !domain.is_empty() && domain.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        domain
    } else {
        "mailvault.local"
    };
    format!("<{}.{}@{}>", random_hex(), now_ms(), domain)
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// The account's row, or `INVALID`.
fn account(shared: &Shared, id: &str) -> Result<AccountRow, RpcError> {
    load_account(shared, id).map_err(internal)?.ok_or_else(|| RpcError::Invalid("unknown account".into()))
}

/// Refuses recipients core's check refuses (`compose_prep::recipient_problem`, the desktop's
/// `compose.check` rule): a To is required, and every To, Cc and Bcc entry must read as an
/// address. No network and no secret. The text names no address (it is logged).
pub(crate) fn check_recipients(f: &Fields) -> Result<(), String> {
    match compose_prep::recipient_problem(&f.to, &f.cc, &f.bcc) {
        None => Ok(()),
        Some(("compose.pleaseEnterLeastOneRecipient", _)) => Err("a message needs a To address".into()),
        Some(_) => Err("a recipient is not an address".into()),
    }
}

/// A `type/subtype` media type as a server names one: ASCII token characters only.
fn plausible_mime(m: &str) -> bool {
    let token = |s: &str| !s.is_empty() && s.len() <= 127 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&b));
    matches!(m.split_once('/'), Some((t, s)) if token(t) && token(s))
}

/// `a`, checked: the handle resolves to a picked file, and name and size are the file's. The
/// type is the one the page sent when it is a plain media type (a forwarded part keeps what the
/// server called it, whatever its name says), else the file name's.
/// `None` when it does not resolve.
fn checked(cache_dir: &Path, a: &Attached) -> Option<Attached> {
    let path = resolve_outgoing(cache_dir, &a.handle).ok()?;
    let size = std::fs::metadata(&path).ok()?.len();
    let name = a.handle.rsplit('/').next().unwrap_or_default().to_string();
    let sent = a.mime.trim().to_ascii_lowercase();
    let mime = if plausible_mime(&sent) && sent != "application/octet-stream" { sent } else { mime_of_name(&name).to_string() };
    Some(Attached { handle: a.handle.clone(), name, size, mime })
}

// ── mobile.compose.send ─────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    account_id: String,
    #[serde(default)]
    draft_id: Option<String>,
    /// Send later: not before this time (unix ms). Never part of the stored fields.
    #[serde(default)]
    send_at_ms: Option<i64>,
    /// "Remind me if no reply in N days" (1, 3 or 7; Premium): kept in the outbox row's fields
    /// until the send went out, then a `follow_ups` row (`followup.rs`).
    #[serde(default)]
    remind_after_days: Option<i64>,
    #[serde(flatten)]
    fields: Fields,
}

/// `mobile.compose.send {accountId, draftId?, to, cc, bcc, subject, text, inReplyTo?, references?,
/// attachments: [{handle}], sendAtMs?, remindAfterDays?}` -> `{id, state: "queued", scheduledMs}` (`scheduledMs`:
/// the send time when held back, else null). `INVALID` (no To, an address that does not read, an
/// unknown account), `ATTACHMENT_MISSING`, `TOO_LARGE`, `PREMIUM_REQUIRED` (`sendAtMs` more than
/// 5 minutes ahead without Premium, or `remindAfterDays` without Premium), `SCHEDULE_TOO_FAR`
/// (more than a day ahead), `INVALID` for `remindAfterDays` other than 1, 3, 7 or on a Graph
/// account, all before any write.
pub(crate) fn send(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SendParams = parse(params)?;
    let shared = engine.shared();
    let acct = account(shared, &p.account_id)?;
    let mut fields = p.fields;
    check_recipients(&fields).map_err(RpcError::Invalid)?;
    let mut attachments = Vec::with_capacity(fields.attachments.len());
    for a in &fields.attachments {
        let Some(ok) = checked(engine.cache_dir(), a) else {
            return Err(RpcError::AttachmentMissing("an attachment is gone".into()));
        };
        attachments.push(ok);
    }
    let total: u64 = attachments.iter().map(|a| a.size).sum();
    let limit = attachment_limit(shared, &p.account_id, &acct, &fields);
    if total > limit {
        return Err(RpcError::TooLarge { message: format!("attachments are {total} bytes, the limit is {limit}"), limit_bytes: limit });
    }
    fields.attachments = attachments;
    let now = now_ms();
    let scheduled = match p.send_at_ms {
        Some(at) => schedule_check(shared, at, now)?,
        None => None,
    };
    fields.remind_after_days = crate::followup::remind_check(shared, &acct, p.remind_after_days)?;
    let id = format!("out_{}", random_hex());
    let message_id = new_message_id(&acct.email);
    let json = serde_json::to_string(&fields).map_err(internal)?;
    let account_id = p.account_id;
    let old_draft: Option<String> = shared
        .write(|c| {
            let old: Option<String> = match &p.draft_id {
                Some(d) => c.query_row("SELECT json FROM drafts WHERE id = ?1", [d], |r| r.get(0)).optional()?,
                None => None,
            };
            c.execute(
                "INSERT INTO outbox (id, account_id, message_id, draft_json, state, attempts, last_error, created_ms, updated_ms,
                                     not_before_ms, scheduled_ms)
                 VALUES (?1, ?2, ?3, ?4, 'queued', 0, NULL, ?5, ?5, ?6, ?7)",
                (&id, &account_id, &message_id, &json, now, scheduled.unwrap_or(0), scheduled),
            )?;
            if let Some(d) = &p.draft_id {
                c.execute("DELETE FROM drafts WHERE id = ?1", [d])?;
            }
            Ok(old)
        })
        .map_err(internal)?;
    // A file the draft held that the send left out is no longer anyone's.
    if let Some(old) = old_draft {
        outbox::release_dirs(shared, engine.cache_dir(), &Fields::read(&old).dirs());
    }
    engine.outbox().wake(shared, Some(&account_id));
    Ok(json!({ "id": id, "state": "queued", "scheduledMs": scheduled }))
}

// ── mobile.compose.prepare ──────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareParams {
    account_id: String,
    mode: String,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    uid: Option<u32>,
    /// The quote's header line ("Original message" in the page's language).
    #[serde(default)]
    original_label: Option<String>,
    /// The original's date as the page shows it; the server's Date header when absent.
    #[serde(default)]
    date_label: Option<String>,
    /// The quote's field names in the page's language ("From", "Date", "Subject"); English when
    /// absent.
    #[serde(default)]
    from_label: Option<String>,
    #[serde(default)]
    date_field_label: Option<String>,
    #[serde(default)]
    subject_label: Option<String>,
}

/// The stored list row of the original, with what sync kept for a reply (`thread_json`).
struct Stored {
    subject: String,
    from_name: String,
    from_address: String,
    message_id: String,
    to_json: String,
    thread_json: String,
}

fn address(name: Option<&str>, address: &str) -> Value {
    json!({ "address": address, "name": name.filter(|n| !n.is_empty()) })
}

/// `[{name, address}]` as stored, as core's `reply_context` reads an address list.
fn stored_list(v: &Value) -> Vec<Value> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["address"].as_str().filter(|s| !s.is_empty()).map(|s| address(a["name"].as_str(), s)))
        .collect()
}

/// The original's header as core's `reply_context` reads it, from mobile.db only: the list row
/// plus `thread_json` (Cc, Reply-To, References and the Date header, kept by sync).
fn original_header(stored: &Stored) -> Value {
    let to: Value = serde_json::from_str(&stored.to_json).unwrap_or(Value::Null);
    let thread: Value = serde_json::from_str(&stored.thread_json).unwrap_or(Value::Null);
    json!({
        "from": address(Some(&stored.from_name), &stored.from_address),
        "to": stored_list(&to),
        "cc": stored_list(&thread["cc"]),
        "replyTo": stored_list(&thread["replyTo"]),
        "subject": stored.subject,
        "date": thread["date"].as_str().unwrap_or(""),
        "messageId": stored.message_id,
        "references": thread["references"].as_array().cloned().unwrap_or_default(),
    })
}

/// The body for the quote: from the cache at once, else fetched for at most [`BODY_WAIT`]. A fetch
/// that takes longer goes on in the background (and lands in the cache); the reply then has no
/// quote yet (`quotePending`).
fn body_within(shared: &Arc<Shared>, account: &str, folder: &str, uid: u32) -> Option<Value> {
    let (tx, rx) = std::sync::mpsc::channel();
    let sh = Arc::clone(shared);
    let params = json!({ "accountId": account, "folder": folder, "uid": uid });
    let spawned = std::thread::Builder::new().name("mv-engine-quote".into()).spawn(move || {
        let _ = tx.send(crate::body::body_for(&sh, params));
    });
    if spawned.is_err() {
        return None;
    }
    match rx.recv_timeout(BODY_WAIT) {
        Ok(Ok(v)) if v["gone"] != true => Some(v),
        _ => None,
    }
}

/// `mobile.compose.prepare {accountId, mode: "new"|"reply"|"replyAll"|"forward", folder?, uid?,
/// originalLabel?, dateLabel?, fromLabel?, dateFieldLabel?, subjectLabel?}` -> `{to, cc, subject, quote, quoteText, inReplyTo, references,
/// quotePending, attachments: [{handle, name, size, mime, section}], pending: [{section, filename, mime,
/// size}]}`. Answered from mobile.db (sync keeps Cc, Reply-To and References in `thread_json`);
/// no sign-in on the tap. `quote` is core's quoted HTML, `quoteText` the same as plain text for a
/// text body. A body not cached is fetched for at most 3 s; past that `quotePending` is true and
/// the quote is empty (prepare again once the body is in the cache). Forward
/// copies each original attachment already in the attachment cache into `<cache>/out`;
/// `pending` lists the ones not downloaded yet (fetch them, then prepare again).
pub(crate) fn prepare(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: PrepareParams = parse(params)?;
    let shared = engine.shared();
    let acct = account(shared, &p.account_id)?;
    let mode = match p.mode.as_str() {
        "new" => {
            return Ok(json!({
                "to": "", "cc": "", "subject": "", "quote": "", "quoteText": "", "quotePending": false, "inReplyTo": "",
                "references": "", "attachments": [], "pending": [],
            }))
        }
        m @ ("reply" | "replyAll" | "forward") => m,
        other => return Err(RpcError::Invalid(format!("unknown compose mode {other}"))),
    };
    let forward = mode == "forward";
    let (Some(folder), Some(uid)) = (p.folder, p.uid) else {
        return Err(RpcError::Invalid("a reply or forward needs folder and uid".into()));
    };
    let row = shared
        .read(|c| {
            c.query_row(
                "SELECT subject, from_name, from_address, message_id, to_json, thread_json
                 FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                (&p.account_id, &folder, uid as i64),
                |r| {
                    Ok(Stored {
                        subject: r.get(0)?,
                        from_name: r.get(1)?,
                        from_address: r.get(2)?,
                        message_id: r.get(3)?,
                        to_json: r.get(4)?,
                        thread_json: r.get(5)?,
                    })
                },
            )
            .optional()
        })
        .map_err(internal)?;
    let Some(stored) = row else {
        return Err(RpcError::Invalid("unknown message".into()));
    };
    // Addresses and threading come from mobile.db; only an uncached body waits, and briefly.
    let body = body_within(shared, &p.account_id, &folder, uid);
    let quote_pending = body.is_none();
    let body = body.unwrap_or(Value::Null);
    let header = original_header(&stored);
    let date = p.date_label.unwrap_or_else(|| header["date"].as_str().unwrap_or("").to_string());
    let label = p.original_label.unwrap_or_else(|| "Original message".into());
    // A label is one line: a newline from the page must not forge a header line of the quote.
    let line = |v: Option<String>, d: &str| v.map(|s| s.replace(['\r', '\n'], " ")).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| d.into());
    let labels = QuoteLabels {
        original: line(Some(label.clone()), "Original message"),
        from: line(p.from_label, "From"),
        date: line(p.date_field_label, "Date"),
        subject: line(p.subject_label, "Subject"),
    };
    let html = body["html"].as_str().map(String::from);
    let text = body["text"].as_str().map(String::from);
    let accounts: Vec<Account> = shared
        .read(|c| {
            let mut st = c.prepare_cached("SELECT id, email FROM accounts ORDER BY created_ms, id")?;
            let rows = st.query_map([], |r| Ok(Account { id: r.get(0)?, email: r.get(1)?, ..Account::default() }))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;
    let request = json!({
        "kind": "message",
        "requestId": "mobile",
        "accountId": p.account_id,
        "pickedFrom": acct.email,
        "mode": mode,
        "original": { "header": header, "html": html, "text": text },
        "presentation": {
            "originalLabel": label,
            "dateLabel": date,
            "subjectCandidate": format!("{} {}", if forward { "Fwd:" } else { "Re:" }, header["subject"].as_str().unwrap_or("")),
        },
    });
    let ctx = Context { accounts, settings: json!({}), settings_version: 0 };
    let out = compose_prep::reply_context(&request, &ctx).map_err(|e| RpcError::Internal(e.to_string()))?;
    let str_of = |k: &str| out[k].as_str().unwrap_or("").to_string();
    let quote_body = text.clone().unwrap_or_default();
    let mut attachments = Vec::new();
    let mut pending = Vec::new();
    if forward {
        for a in body["attachments"].as_array().into_iter().flatten() {
            let section = a["section"].as_str().unwrap_or("");
            let name = safe_handle_name(a["filename"].as_str().unwrap_or("attachment"));
            match crate::attachments::cached_part(engine, &p.account_id, &folder, uid, section) {
                Some(src) => {
                    let dir = engine.cache_dir().join("out").join(random_hex());
                    let dst = dir.join(&name);
                    let copied = std::fs::create_dir_all(&dir).and_then(|()| std::fs::copy(&src, &dst));
                    match copied {
                        Ok(size) => {
                            let handle = format!("out/{}/{}", dir.file_name().and_then(|d| d.to_str()).unwrap_or(""), name);
                            let mime = a["mime"].as_str().filter(|m| !m.is_empty()).unwrap_or_else(|| mime_of_name(&name));
                            attachments.push(json!({ "handle": handle, "name": name, "size": size, "mime": mime, "section": section }));
                        }
                        Err(e) => {
                            let _ = std::fs::remove_dir_all(&dir);
                            shared.log(&format!("[compose] copying a forwarded attachment: {e}"));
                            pending.push(a.clone());
                        }
                    }
                }
                None => pending.push(a.clone()),
            }
        }
    }
    Ok(json!({
        "to": str_of("to"),
        "cc": str_of("cc"),
        "subject": str_of("subject"),
        "quote": str_of("quotedHtml"),
        "quoteText": if quote_pending { String::new() } else { quoted_text(&labels, &header, &date, &quote_body) },
        "quotePending": quote_pending,
        "inReplyTo": str_of("inReplyTo"),
        "references": str_of("references"),
        "attachments": attachments,
        "pending": pending,
    }))
}

// ── Drafts ──────────────────────────────────────────────────────────────────

fn valid_draft_id(id: &str) -> bool {
    id.strip_prefix("drf_").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveParams {
    #[serde(default)]
    id: Option<String>,
    account_id: String,
    #[serde(flatten)]
    fields: Fields,
}

/// `mobile.drafts.save {id?, accountId, to, cc, bcc, subject, text, inReplyTo?, references?,
/// attachments: [{handle}]}` -> `{id}`. Without `id` a new draft; with one, that draft is
/// replaced. A handle that no longer resolves is left out (autosave never fails on a file the
/// system purged). Files the previous version held and this one does not are deleted.
pub(crate) fn drafts_save(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SaveParams = parse(params)?;
    let shared = engine.shared();
    account(shared, &p.account_id)?;
    let id = match p.id {
        Some(id) if valid_draft_id(&id) => id,
        Some(_) => return Err(RpcError::Invalid("not a draft id".into())),
        None => format!("drf_{}", random_hex()),
    };
    let mut fields = p.fields;
    fields.remind_after_days = None;
    fields.attachments = fields.attachments.iter().filter_map(|a| checked(engine.cache_dir(), a)).collect();
    let json = serde_json::to_string(&fields).map_err(internal)?;
    let account_id = p.account_id;
    let old: Option<String> = shared
        .write(|c| {
            let old: Option<String> = c.query_row("SELECT json FROM drafts WHERE id = ?1", [&id], |r| r.get(0)).optional()?;
            c.execute(
                "INSERT INTO drafts (id, account_id, json, updated_ms) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, json = excluded.json, updated_ms = excluded.updated_ms",
                (&id, &account_id, &json, now_ms()),
            )?;
            Ok(old)
        })
        .map_err(internal)?;
    if let Some(old) = old {
        let keep = fields.dirs();
        let gone: Vec<String> = Fields::read(&old).dirs().into_iter().filter(|d| !keep.contains(d)).collect();
        outbox::release_dirs(shared, engine.cache_dir(), &gone);
    }
    Ok(json!({ "id": id }))
}

/// `mobile.drafts.list` -> `[{id, accountId, to, subject, updatedMs}]`, newest first.
pub(crate) fn drafts_list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let rows = engine
        .read(|c| {
            let mut st = c.prepare_cached("SELECT id, account_id, json, updated_ms FROM drafts ORDER BY updated_ms DESC, id")?;
            let rows = st
                .query_map([], |r| {
                    let f = Fields::read(&r.get::<_, String>(2)?);
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "accountId": r.get::<_, String>(1)?,
                        "to": f.to,
                        "subject": f.subject,
                        "updatedMs": r.get::<_, i64>(3)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;
    Ok(Value::Array(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

/// `mobile.drafts.get {id}` -> `{id, accountId, updatedMs, to, cc, bcc, subject, text, inReplyTo,
/// references, attachments: [{handle, name, size, mime}]}`; `INVALID` for an unknown draft.
pub(crate) fn drafts_get(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    let row: Option<(String, String, i64)> = engine
        .read(|c| {
            c.query_row("SELECT account_id, json, updated_ms FROM drafts WHERE id = ?1", [&p.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
        })
        .map_err(internal)?;
    let Some((account_id, json, updated)) = row else {
        return Err(RpcError::Invalid("unknown draft".into()));
    };
    let mut v = serde_json::to_value(Fields::read(&json)).map_err(internal)?;
    v["id"] = json!(p.id);
    v["accountId"] = json!(account_id);
    v["updatedMs"] = json!(updated);
    Ok(v)
}

/// `mobile.drafts.delete {id}` -> `{deleted}`, deleting the files only it held.
pub(crate) fn drafts_delete(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    let shared = engine.shared();
    let old: Option<String> = shared
        .write(|c| {
            let old: Option<String> = c.query_row("SELECT json FROM drafts WHERE id = ?1", [&p.id], |r| r.get(0)).optional()?;
            c.execute("DELETE FROM drafts WHERE id = ?1", [&p.id])?;
            Ok(old)
        })
        .map_err(internal)?;
    let deleted = old.is_some();
    if let Some(old) = old {
        outbox::release_dirs(shared, engine.cache_dir(), &Fields::read(&old).dirs());
    }
    Ok(json!({ "deleted": deleted }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_ids_are_safe_for_core() {
        let id = new_message_id("u@example.test");
        assert!(id.starts_with('<') && id.ends_with("@example.test>"), "{id}");
        assert_eq!(new_message_id("u@exämple.test").rsplit('@').next(), Some("mailvault.local>"));
        assert_ne!(new_message_id("u@x.test"), new_message_id("u@x.test"));
    }
}
