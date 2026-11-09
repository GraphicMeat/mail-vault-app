//! [`Backend`] over JMAP (RFC 8620, RFC 8621: Fastmail and other JMAP servers), through
//! mailvault-core's `JmapClient`, and the JMAP form of `mobile.accounts.add` ([`add`]).
//!
//! Identity (Ruling 7): a folder's stored path is its mailbox id, except the mailbox with role
//! `inbox`, stored as `INBOX` because the page and sync address it by that name; every request
//! names it by its id ([`JmapBackend::mailbox_id`]). JMAP mail is label-like (one email can sit
//! in several mailboxes) and keeps its id across a move, so a message's `remote_ids` entry is
//! folder-qualified, `<folder path>|<email id>` ([`key`]): the same email has its own uid in each
//! mailbox that holds it, and a move maps it anew in the target. JMAP has no UIDVALIDITY: every
//! folder's generation is the constant [`GENERATION`].
//!
//! A pass reads the Email state first, then lists the folder's 90-day window (`Email/query`
//! `inMailbox` + `after`, newest first, ids only) and gives new ids local uids oldest first.
//! `headers` reads the new rows with `Email/get`. `flags` follows `Email/changes` from the
//! folder's stored state (`sync_state.token`): only updated emails (and rows carrying a local
//! override that may now clear) are read again; with no stored state, or one the server can no
//! longer bridge (`cannotCalculateChanges`), every held row is read. The state read before the
//! window is then stored, so nothing that changed during the pass is skipped next time.
//!
//! Opening a message never downloads an attachment: the body comes from the email's
//! `bodyValues` (`fetchHTMLBodyValues` / `fetchTextBodyValues`, capped), the parts are its
//! `attachments` metadata, each part's section being its `partId`. A tapped attachment is its
//! blob streamed through the attachment worker's range reads (`JmapClient::open_download`), as
//! Graph's: the next bytes of the open download, a reopen and skip for a resume. The blob id that
//! goes on the wire is always the one the server listed for that part of that message.
//!
//! Delete follows core's label rule (`jmap::remove_from`): out of this mailbox into Trash, or
//! gone for good from Trash; never a destroy for want of a Trash mailbox. Send is core's
//! (`smtp::send_built_phased` routes a JMAP account to `send_via_jmap`): upload, `Email/import`
//! into Drafts, `EmailSubmission/set` as the identity that matches the From address, and
//! `onSuccessUpdateEmail` files it in Sent, so [`Backend::file_sent`] has nothing to do.
//!
//! Every request goes through [`JmapBackend::call`]: a 401 drops the cached session and connects
//! once more (an expired session), a second one is `AUTH_FAILED`; a 429 or 503 waits the
//! server's `Retry-After` (capped) a few times as a transient condition. One session per account
//! is kept in [`Sessions`] so a message open does not fetch the session again.

use super::{ApplyOutcome, Arrivals, Backend, BeforeWire, Change, FolderInfo, FolderRow, Flags, Header, Moved, RawBody, Selected, SendFail, SendOutcome, Watch, Window, STOP_CHECK};
use crate::accounts::{self, failure, load_account, map_error, AccountRow, Code};
use crate::actions::Kind;
use crate::db::{lock, Engine, Shared};
use crate::net::block_on;
use crate::remote_ids;
use crate::rpc::RpcError;
use crate::secrets::Credential;
use crate::sync::{self, Fail};
use mailvault_core::app_db::follow_up::{FollowUp, Outcome as ReplyOutcome};
use mailvault_core::follow_up::matcher;
use mailvault_core::actions::policy::{delete_disposition, jmap_trash_place, DeleteDisposition, FolderRole, WithoutTrash};
use mailvault_core::imap::PartInfo;
use mailvault_core::jmap::discover::{self, Discovered};
use mailvault_core::jmap::headers::{keywords_to_flags, to_header, HEADER_PROPS};
use mailvault_core::jmap::push::{SseParser, StateChange};
use mailvault_core::jmap::{BlobStream, JMailbox, JmapAuth, JmapClient, JmapError, RemoveOutcome};
use mailvault_core::send::classify::classify_failure;
use mailvault_core::send::sent_policy::{sent_copy_policy, SentCopy};
use mailvault_core::smtp::{self, OutgoingEmail};
use mailvault_core::sync_core::dates::utc_timestamp as timestamp;
use mailvault_core::sync_core::throttle::throttle_wait;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// JMAP has no UIDVALIDITY: every folder's generation, constant so sync never wipes.
pub(crate) const GENERATION: i64 = 1;
/// The `sync_state` folder key that holds the account's send limits (`{"upload", "attachments"}`
/// in bytes, from the session). A JMAP Id never holds `#`, so no mailbox path is this.
pub(crate) const LIMITS_KEY: &str = "#limits";
/// How many times one call waits out a 429 or 503 before it fails (transiently).
const THROTTLE_WAITS: u32 = 3;
/// The longest single wait a `Retry-After` gets.
const MAX_RETRY_AFTER: u64 = 30;
/// The wait when a throttle named none.
const DEFAULT_RETRY_AFTER: u64 = 5;
/// The most text one body value brings (a longer one is cut by the server, `isTruncated`).
const MAX_BODY_VALUE_BYTES: u64 = 2 * 1024 * 1024;
/// The EmailBodyPart properties a body or parts read asks for.
const PART_PROPS: [&str; 8] = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid"];
/// New mappings per write transaction (plus the one `uid_seq` row: at most 200 rows).
const BATCH: usize = 199;
/// Moves remapped per write transaction (a forget and an insert each, plus `uid_seq`).
const MOVE_BATCH: usize = 99;
/// The most replies a follow-up's reply search reads back (the daemon's `JMAP_REPLY_HITS`).
const REPLY_HITS: usize = 50;
/// Uids looked up per read for their local overrides.
const READ_CHUNK: usize = 500;

/// The `remote_ids` entry of email `id` in folder `folder` (see the module doc).
pub(crate) fn key(folder: &str, id: &str) -> String {
    format!("{folder}|{id}")
}

/// The email id of a [`key`]. A JMAP Id never holds `|`, so the last one splits it.
fn email_id(key: &str) -> &str {
    key.rsplit_once('|').map_or(key, |(_, id)| id)
}

fn is_inbox_role(m: &JMailbox) -> bool {
    m.role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case("inbox"))
}

fn has_role(m: &JMailbox, role: &str) -> bool {
    m.role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(role))
}

fn folder_info(m: &JMailbox) -> FolderInfo {
    let inbox = is_inbox_role(m);
    FolderInfo {
        path: if inbox { "INBOX".to_string() } else { m.id.clone() },
        name: m.name.clone(),
        special_use: if inbox { None } else { m.role.as_deref().and_then(mailvault_core::jmap::mailbox_map::role_special_use).map(str::to_string) },
        delimiter: None,
        noselect: false,
        counts: Some((m.unread_emails as i64, m.total_emails as i64)),
    }
}

/// A listed EmailBodyPart as a part, with the blob id its bytes download by. `None` for a part
/// with no partId or no blobId (nothing a tap could fetch).
fn part_info(v: &Value) -> Option<(PartInfo, String)> {
    let section = v["partId"].as_str().filter(|s| !s.is_empty())?.to_string();
    let blob = v["blobId"].as_str().filter(|s| !s.is_empty())?.to_string();
    let text = |k: &str| v[k].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let content_id = text("cid").map(|c| c.trim_start_matches('<').trim_end_matches('>').to_string()).filter(|c| !c.is_empty());
    let disposition = text("disposition").map(|d| d.to_ascii_lowercase());
    let part = PartInfo {
        section,
        mime: text("type").map(|t| t.to_ascii_lowercase()).unwrap_or_else(|| "application/octet-stream".into()),
        filename: text("name"),
        size: u32::try_from(v["size"].as_u64().unwrap_or(0)).unwrap_or(u32::MAX),
        // `download` hands out the decoded bytes: nothing to undo.
        encoding: "binary".into(),
        charset: text("charset"),
        disposition: disposition.or_else(|| Some(if content_id.is_some() { "inline" } else { "attachment" }.into())),
        content_id,
    };
    Some((part, blob))
}

/// The first part of `list` of type `mime` whose value `values` holds.
/// The text, and whether the server cut it short (`isTruncated`).
fn first_value(list: &Value, values: &Value, mime: &str) -> Option<(String, bool)> {
    list.as_array()?.iter().find_map(|p| {
        let is = p["type"].as_str().is_some_and(|t| t.eq_ignore_ascii_case(mime));
        let id = p["partId"].as_str()?;
        if !is {
            return None;
        }
        let v = &values[id];
        v["value"].as_str().map(|text| (text.to_string(), v["isTruncated"].as_bool() == Some(true)))
    })
}

/// Whether either body value the reply uses (the html, or the text a reply quotes and the viewer
/// falls back to) came cut short.
fn body_truncated(v: &Value) -> bool {
    let cut = |list: &str, mime: &str| first_value(&v[list], &v["bodyValues"], mime).is_some_and(|(_, cut)| cut);
    cut("htmlBody", "text/html") || cut("textBody", "text/plain")
}

/// A JMAP failure as a sync or a body read reports it (its text scrubbed already).
fn code_of(e: &JmapError) -> Code {
    match e {
        JmapError::Unauthorized => Code::AuthFailed,
        JmapError::RateLimited { .. } => Code::Timeout,
        JmapError::Transport(m) => match map_error(m) {
            Code::Invalid | Code::AuthFailed => Code::HostUnreachable,
            c => c,
        },
        JmapError::Protocol(m) if m.starts_with("HTTP 5") => Code::HostUnreachable,
        JmapError::Method { kind, .. } if is_server_fault(kind) => Code::HostUnreachable,
        _ => Code::Invalid,
    }
}

fn is_server_fault(kind: &str) -> bool {
    matches!(kind, "serverFail" | "serverUnavailable" | "serverPartialFail")
}

/// HTTP 404 as the client words it: a blob or resource the server does not have.
fn is_not_found(e: &JmapError) -> bool {
    matches!(e, JmapError::Protocol(m) if m == "HTTP 404") || matches!(e, JmapError::Method { kind, .. } if kind == "notFound")
}

/// Why a call did not return a value.
enum CallErr {
    /// Final: the account must sign in again, it is gone, or the engine is closing.
    Fail(Fail),
    /// The server's answer (or the lack of one); the caller decides what it means. The text is
    /// scrubbed.
    Jmap(JmapError, String),
}

impl From<CallErr> for Fail {
    fn from(e: CallErr) -> Fail {
        match e {
            CallErr::Fail(f) => f,
            CallErr::Jmap(e, text) => Fail::Code(code_of(&e), text),
        }
    }
}

/// An action's failure: a refusal the journal counts (the server answered no), or a failure it
/// retries (no answer, a server fault, a throttle that outlasted the waits), never dropped.
fn refused_or_fail(e: CallErr) -> Result<ApplyOutcome, Fail> {
    match e {
        CallErr::Jmap(JmapError::Method { kind, .. }, text) if !is_server_fault(&kind) => Ok(ApplyOutcome::Refused(text)),
        CallErr::Jmap(JmapError::NoTrash, text) => Ok(ApplyOutcome::Refused(text)),
        CallErr::Jmap(JmapError::Protocol(m), text) if m.starts_with("HTTP 4") => Ok(ApplyOutcome::Refused(text)),
        e => Err(e.into()),
    }
}

/// What a session needs: the URL, the credentials, and the address it is shown under.
fn auth_of(row: &AccountRow, cred: &Credential) -> Result<(String, JmapAuth), Fail> {
    let url = row.jmap_url.clone().filter(|u| !u.trim().is_empty()).ok_or_else(|| Fail::Code(Code::Invalid, "the account has no JMAP session URL".into()))?;
    let secret = cred.password.clone().filter(|p| !p.is_empty()).ok_or_else(|| Fail::Code(Code::AuthFailed, "no password or token is stored".into()))?;
    let auth = if row.auth == "bearer" { JmapAuth::Bearer(secret) } else { JmapAuth::Basic { username: row.email.clone(), password: secret } };
    Ok((url, auth))
}

/// The send limits a session names, as `sync_state` keeps them.
fn limits_json(c: &JmapClient) -> String {
    json!({ "upload": c.limits().max_size_upload, "attachments": c.max_size_attachments_per_email() }).to_string()
}

/// Stores the account's send limits when they changed (one row).
fn store_limits(shared: &Shared, account: &str, c: &JmapClient) -> Result<(), Fail> {
    let value = limits_json(c);
    let stored: Option<String> = shared
        .read(|db| {
            db.query_row("SELECT token FROM sync_state WHERE account_id = ?1 AND folder = ?2", (account, LIMITS_KEY), |r| r.get(0)).optional()
        })?
        .flatten();
    if stored.as_deref() != Some(value.as_str()) {
        sync::write_for(shared, account, |db| {
            db.execute(
                "INSERT INTO sync_state (account_id, folder, token) VALUES (?1, ?2, ?3)
                 ON CONFLICT (account_id, folder) DO UPDATE SET token = excluded.token",
                (account, LIMITS_KEY, &value),
            )
        })?;
    }
    Ok(())
}

/// The session limits stored for `account`: `(maxSizeUpload, maxSizeAttachmentsPerEmail)`, each
/// `None` when unknown.
pub(crate) fn stored_limits(shared: &Shared, account: &str) -> (Option<u64>, Option<u64>) {
    let stored: Option<String> = shared
        .read(|db| {
            db.query_row("SELECT token FROM sync_state WHERE account_id = ?1 AND folder = ?2", (account, LIMITS_KEY), |r| r.get(0)).optional()
        })
        .ok()
        .flatten()
        .flatten();
    let v: Value = stored.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    (v["upload"].as_u64().filter(|n| *n > 0), v["attachments"].as_u64().filter(|n| *n > 0))
}

// ── Sessions ────────────────────────────────────────────────────────────────

/// The engine's JMAP state, in [`Shared`]: one connected session per account.
#[derive(Default)]
pub(crate) struct Sessions {
    clients: Mutex<HashMap<String, Arc<JmapClient>>>,
    /// Tests: what discovery finds for any address (`Some(None)`: nothing).
    #[cfg(debug_assertions)]
    discovery: Mutex<Option<Option<Discovered>>>,
}

impl Sessions {
    fn get(&self, account: &str) -> Option<Arc<JmapClient>> {
        lock(&self.clients).get(account).cloned()
    }

    fn put(&self, account: &str, c: Arc<JmapClient>) {
        lock(&self.clients).insert(account.to_string(), c);
    }

    /// Forgets `account`'s session (removed, or its session refused).
    pub(crate) fn forget(&self, account: &str) {
        lock(&self.clients).remove(account);
    }

    fn discover(&self, email: &str) -> Option<Discovered> {
        #[cfg(debug_assertions)]
        if let Some(found) = lock(&self.discovery).clone() {
            return found;
        }
        block_on(discover::discover(email))
    }
}

#[cfg(debug_assertions)]
impl Engine {
    /// Tests: discovery finds `found` for every address (`None`: nothing), with no network.
    #[doc(hidden)]
    pub fn set_jmap_discovery(&self, found: Option<(&str, bool)>) {
        let found = found.map(|(url, confirm)| Discovered {
            session_url: url.to_string(),
            host: url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or_default().to_string(),
            needs_host_confirmation: confirm,
            source: "well-known",
        });
        *lock(&self.shared().jmap.discovery) = Some(found);
    }

    /// Tests: JMAP credentials may go to loopback http URLs (an in-process `mock-jmap`).
    #[doc(hidden)]
    pub fn allow_jmap_loopback(&self) {
        mailvault_core::jmap::base::allow_loopback_for_tests();
    }
}

/// Connects `account`'s session, waiting out a throttle like [`JmapBackend::call`].
fn connect(shared: &Shared, account: &str, row: &AccountRow, cred: &Credential) -> Result<Arc<JmapClient>, CallErr> {
    let (url, auth) = auth_of(row, cred).map_err(CallErr::Fail)?;
    let secrets: Vec<String> = cred.secrets().into_iter().map(String::from).collect();
    let mut waits = 0;
    loop {
        sync::not_closing(shared).map_err(CallErr::Fail)?;
        match block_on(JmapClient::connect(&url, auth.clone(), &row.email)) {
            Ok(c) => {
                let c = Arc::new(c);
                store_limits(shared, account, &c).map_err(CallErr::Fail)?;
                shared.jmap.put(account, Arc::clone(&c));
                // Removed meanwhile (its forget ran before this put): the session, which holds the
                // credentials, must not stay in memory.
                let exists = shared.read(|c| c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [account], |_| Ok(())).optional()).map_err(|e| CallErr::Fail(e.into()))?;
                if exists.is_none() {
                    shared.jmap.forget(account);
                    return Err(CallErr::Fail(Fail::Gone));
                }
                return Ok(c);
            }
            Err(JmapError::RateLimited { retry_after }) if waits < THROTTLE_WAITS => {
                waits += 1;
                pause(shared, retry_after)?;
            }
            Err(e) => {
                let text = scrub(&secrets, e.to_string());
                return Err(CallErr::Jmap(e, text));
            }
        }
    }
}

fn scrub(secrets: &[String], text: String) -> String {
    mailvault_core::secret_scrub::scrub(&text, &secrets.iter().map(String::as_str).collect::<Vec<_>>())
}

/// Waits a throttle's `Retry-After` (capped) in slices of at most a second, stopping early when
/// the engine closes.
fn pause(shared: &Shared, retry_after: Option<u64>) -> Result<(), CallErr> {
    let mut left = throttle_wait(retry_after, DEFAULT_RETRY_AFTER, MAX_RETRY_AFTER);
    while !left.is_zero() {
        sync::not_closing(shared).map_err(CallErr::Fail)?;
        let step = left.min(Duration::from_secs(1));
        std::thread::sleep(step);
        left -= step;
    }
    Ok(())
}

// ── The backend ─────────────────────────────────────────────────────────────

/// A listed part and the blob id its bytes download by.
type ListedPart = (PartInfo, String);
/// `(uid, email id)` pairs.
type Mapped = Vec<(u32, String)>;

/// The blob download `part_range` is reading.
struct Streaming {
    folder: String,
    uid: u32,
    section: String,
    stream: BlobStream,
    /// Bytes received and not yet handed out.
    buf: Vec<u8>,
    /// The offset of `buf`'s first byte.
    pos: u64,
    ended: bool,
}

pub(crate) struct JmapBackend<'a> {
    shared: &'a Shared,
    account: String,
    row: AccountRow,
    cred: Credential,
    client: Arc<JmapClient>,
    /// The account's secrets, scrubbed out of every failure text.
    secrets: Vec<String>,
    /// The last `Mailbox/get` of this backend.
    mailboxes: Option<Vec<JMailbox>>,
    /// The last `window`: the folder's path and its listed email ids by uid.
    listed: Option<(String, HashMap<u32, String>)>,
    /// The Email state read before the last `window`, and its folder.
    pass_state: Option<(String, String)>,
    /// The state `flags` read changes against the stored one up to, and its folder: stored by
    /// `pass_done`, once sync has written every flag it vouches for.
    pending_state: Option<(String, String)>,
    /// The last parts read: folder, uid, and each part with its blob id.
    parts: Option<(String, u32, Vec<ListedPart>)>,
    streaming: Option<Streaming>,
    /// The live EventSource stream, open across waits.
    events: Option<EventStream>,
}

impl<'a> JmapBackend<'a> {
    /// The account's backend on its cached session, connecting when there is none.
    pub(crate) fn open(shared: &'a Shared, account: &str) -> Result<JmapBackend<'a>, Fail> {
        let Some(row) = load_account(shared, account)? else {
            return Err(Fail::Gone);
        };
        let cred = match shared.secrets().get(account) {
            Ok(Some(s)) => Credential::parse(&s),
            Ok(None) => return Err(Fail::Code(Code::AuthFailed, "no password or token is stored".into())),
            Err(e) => return Err(Fail::Code(Code::Invalid, format!("secret store: {e}"))),
        };
        let secrets: Vec<String> = cred.secrets().into_iter().map(String::from).collect();
        let client = match shared.jmap.get(account) {
            Some(c) => c,
            None => connect(shared, account, &row, &cred)?,
        };
        Ok(JmapBackend {
            shared,
            account: account.to_string(),
            row,
            cred,
            client,
            secrets,
            mailboxes: None,
            listed: None,
            pass_state: None,
            pending_state: None,
            parts: None,
            streaming: None,
            events: None,
        })
    }

    fn scrub(&self, text: String) -> String {
        scrub(&self.secrets, text)
    }

    /// Runs one request: a 401 connects again once (the cached session may have expired) and
    /// retries; a throttle waits `Retry-After` and retries up to [`THROTTLE_WAITS`] times.
    fn call<T>(&mut self, op: impl AsyncFn(&JmapClient) -> Result<T, JmapError>) -> Result<T, CallErr> {
        let mut reconnected = false;
        let mut waits = 0;
        loop {
            sync::not_closing(self.shared).map_err(CallErr::Fail)?;
            let client = Arc::clone(&self.client);
            match block_on(op(&client)) {
                Ok(v) => return Ok(v),
                Err(JmapError::Unauthorized) if !reconnected => {
                    reconnected = true;
                    self.shared.jmap.forget(&self.account);
                    self.client = connect(self.shared, &self.account, &self.row, &self.cred)?;
                }
                Err(JmapError::RateLimited { retry_after }) if waits < THROTTLE_WAITS => {
                    waits += 1;
                    pause(self.shared, retry_after)?;
                }
                Err(e) => {
                    if e == JmapError::Unauthorized {
                        self.shared.jmap.forget(&self.account);
                    }
                    let text = self.scrub(e.to_string());
                    return Err(CallErr::Jmap(e, text));
                }
            }
        }
    }

    /// Every mailbox, read once per backend unless `fresh`.
    fn mailboxes(&mut self, fresh: bool) -> Result<&[JMailbox], Fail> {
        if fresh || self.mailboxes.is_none() {
            let (list, _) = self.call(async |c| c.mailboxes().await)?;
            self.mailboxes = Some(list);
        }
        Ok(self.mailboxes.as_deref().unwrap_or_default())
    }

    /// The mailbox id a request names `path` by: the inbox role's id for `INBOX`, the stored id
    /// for any other folder.
    fn mailbox_id(&mut self, path: &str) -> Result<String, Fail> {
        if !sync::is_inbox(path) {
            return Ok(path.to_string());
        }
        self.mailboxes(false)?
            .iter()
            .find(|m| is_inbox_role(m))
            .map(|m| m.id.clone())
            .ok_or_else(|| Fail::Code(Code::Invalid, "the account has no inbox".into()))
    }

    /// The mailbox of `path` from this backend's list.
    fn mailbox(&mut self, path: &str, fresh: bool) -> Result<JMailbox, Fail> {
        let inbox = sync::is_inbox(path);
        self.mailboxes(fresh)?
            .iter()
            .find(|m| if inbox { is_inbox_role(m) } else { m.id == path })
            .cloned()
            .ok_or_else(|| Fail::Code(Code::Invalid, format!("no mailbox {path}")))
    }

    /// The pass's listing of `folder.path`, read again when this backend has not listed it.
    fn listed(&mut self, folder: &FolderRow) -> Result<&HashMap<u32, String>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Err(Fail::Code(Code::Invalid, format!("generation of {} changed during sync", folder.path)));
        }
        if self.listed.as_ref().is_none_or(|(p, _)| *p != folder.path) {
            self.window(&folder.path, sync::window_start_ms(crate::compose::now_ms()))?;
        }
        Ok(&self.listed.as_ref().expect("listed just now").1)
    }

    /// `(uid, email id)` of each of `uids` in `folder` that has a mapping; the rest in the second
    /// list.
    fn email_ids(&self, folder: &str, uids: &[u32]) -> Result<(Mapped, Vec<u32>), Fail> {
        let account = self.account.as_str();
        let found = self.shared.read(|c| uids.iter().map(|u| Ok((*u, remote_ids::remote_for(c, account, folder, *u)?))).collect::<rusqlite::Result<Vec<_>>>())?;
        let mut present = Vec::new();
        let mut gone = Vec::new();
        for (uid, k) in found {
            match k {
                Some(k) => present.push((uid, email_id(&k).to_string())),
                None => gone.push(uid),
            }
        }
        Ok((present, gone))
    }

    /// The email id of `uid` in `folder`; `None` when it has none or the generation is not
    /// [`GENERATION`].
    fn one_email_id(&self, folder: &FolderRow, uid: u32) -> Result<Option<String>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Ok(None);
        }
        Ok(self.email_ids(&folder.path, &[uid])?.0.pop().map(|(_, id)| id))
    }

    /// `Email/get` of one email with the body properties: `values` asks for the text of the html
    /// and text parts. `None` when the server no longer has it.
    fn get_one(&mut self, id: &str, properties: &[&str], values: bool) -> Result<Option<Value>, CallErr> {
        let wanted = id.to_string();
        let out = self.call(async |c| {
            let mut args = json!({
                "accountId": c.account_id(),
                "ids": [wanted],
                "properties": properties,
                "bodyProperties": PART_PROPS,
            });
            if values {
                args["fetchHTMLBodyValues"] = json!(true);
                args["fetchTextBodyValues"] = json!(true);
                args["maxBodyValueBytes"] = json!(MAX_BODY_VALUE_BYTES);
            }
            c.call(vec![json!(["Email/get", args, "b"])]).await
        })?;
        let got = out.into_iter().find(|r| r[0] == "Email/get").map(|mut r| r[1].take()).unwrap_or(Value::Null);
        Ok(got["list"].as_array().and_then(|l| l.iter().find(|e| e["id"] == id)).cloned())
    }

    /// The listed attachments of `v` with their blob ids; `None` when the answer holds no list
    /// (unknown, not "none").
    fn attachments_of(v: &Value) -> Option<Vec<(PartInfo, String)>> {
        let list = v["attachments"].as_array()?;
        let mut seen = HashSet::new();
        Some(list.iter().filter_map(part_info).filter(|(p, _)| seen.insert(p.section.clone())).collect())
    }

    /// The parts of `uid` (cached from this backend's last read of it); `None` when it is gone.
    fn listed_parts(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<Vec<(PartInfo, String)>>, Fail> {
        if let Some((f, u, parts)) = &self.parts {
            if *f == folder.path && *u == uid {
                return Ok(Some(parts.clone()));
            }
        }
        let Some(id) = self.one_email_id(folder, uid)? else {
            return Ok(None);
        };
        let Some(v) = self.get_one(&id, &["attachments"], false)? else {
            return Ok(None);
        };
        let parts = Self::attachments_of(&v).ok_or_else(|| Fail::Code(Code::HostUnreachable, "the server listed no attachments property".into()))?;
        self.parts = Some((folder.path.clone(), uid, parts.clone()));
        Ok(Some(parts))
    }

    /// Octets `offset..offset + len` of part `section` (fewer at its end): the next bytes of the
    /// open download when it is that part's at `offset`, else a new download skipped to
    /// `offset`. `None` when the message or its blob is gone. A section the message does not
    /// list is refused: the blob id on the wire is always the listed one.
    fn read(&mut self, folder: &FolderRow, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, Fail> {
        if section.is_empty() || section.bytes().all(|b| b == b'.') {
            return Err(Fail::Code(Code::Invalid, "a part id made of dots".into()));
        }
        let continues = self.streaming.as_ref().is_some_and(|s| {
            s.folder == folder.path && s.uid == uid && s.section == section && s.pos <= offset && (offset <= s.pos + s.buf.len() as u64 || !s.ended)
        });
        if !continues {
            self.streaming = None;
            let Some(parts) = self.listed_parts(folder, uid)? else {
                return Ok(None);
            };
            let Some((part, blob)) = parts.into_iter().find(|(p, _)| p.section == section) else {
                return Err(Fail::Code(Code::Invalid, format!("not an attachment of the message: {section}")));
            };
            let name = part.filename.clone().unwrap_or_else(|| "attachment".into());
            let stream = match self.call(async |c| c.open_download(&blob, &part.mime, &name).await) {
                Ok(s) => s,
                Err(CallErr::Jmap(e, _)) if is_not_found(&e) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            self.streaming = Some(Streaming { folder: folder.path.clone(), uid, section: section.to_string(), stream, buf: Vec::new(), pos: 0, ended: false });
        }
        let shared = self.shared;
        let s = self.streaming.as_mut().expect("opened above");
        let want = offset + len as u64;
        // Fill until the range is in hand or the download ended; bytes before `offset` (a
        // resume) are dropped as they arrive.
        let mut failed = None;
        while !s.ended && s.pos + (s.buf.len() as u64) < want {
            sync::not_closing(shared)?;
            match block_on(s.stream.chunk()) {
                Ok(Some(chunk)) => {
                    s.buf.extend_from_slice(&chunk);
                    let skip = offset.saturating_sub(s.pos).min(s.buf.len() as u64) as usize;
                    if skip > 0 {
                        s.buf.drain(..skip);
                        s.pos += skip as u64;
                    }
                }
                Ok(None) => s.ended = true,
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        if let Some(e) = failed {
            self.streaming = None;
            let text = self.scrub(e.to_string());
            return Err(Fail::Code(code_of(&e), text));
        }
        let skip = offset.saturating_sub(s.pos).min(s.buf.len() as u64) as usize;
        s.buf.drain(..skip);
        s.pos += skip as u64;
        let take = (len as usize).min(s.buf.len());
        let out: Vec<u8> = s.buf.drain(..take).collect();
        s.pos += take as u64;
        Ok(Some(out))
    }

    /// The flags of `ids` (email ids) by `Email/get` keywords; a missing one is left out.
    fn keyword_flags(&mut self, ids: Vec<(u32, String)>) -> Result<Vec<(u32, Flags)>, Fail> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: Vec<String> = ids.iter().map(|(_, id)| id.clone()).collect();
        let got = self.call(async |c| c.get_emails(&wanted, &["id", "keywords"]).await)?;
        let by_id: HashMap<&str, &Value> = got.list.iter().filter_map(|e| Some((e["id"].as_str()?, e))).collect();
        Ok(ids.iter().filter_map(|(uid, id)| by_id.get(id.as_str()).map(|e| (*uid, Flags::of(&keywords_to_flags(&e["keywords"]))))).collect())
    }

    /// The uids of `folder` among `uids` whose row carries a local override (it may now clear).
    fn overridden(&self, folder: &str, uids: &[u32]) -> Result<HashSet<u32>, Fail> {
        let account = self.account.as_str();
        let mut out = HashSet::new();
        for chunk in uids.chunks(READ_CHUNK) {
            let sql = format!(
                "SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid IN ({})
                   AND (local_seen IS NOT NULL OR local_flagged IS NOT NULL OR local_deleted IS NOT NULL)",
                sync::uid_list(chunk)
            );
            let found = self.shared.read(|c| {
                let mut st = c.prepare(&sql)?;
                let rows = st.query_map((account, folder), |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })?;
            out.extend(found.into_iter().map(|u| u as u32));
        }
        Ok(out)
    }

    /// The uids of `folder` a journaled action still names: their mappings are the journal's
    /// until it settles (replay decides what is gone).
    fn pending_uids(&self, folder: &str) -> Result<HashSet<u32>, Fail> {
        let account = self.account.as_str();
        Ok(self.shared.read(|c| {
            let mut st = c.prepare_cached(crate::actions::PENDING_UIDS)?;
            let rows = st.query_map((account, folder), |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(|u| u as u32).collect())
        })?)
    }

    fn stored_state(&self, folder: &str) -> Result<Option<String>, Fail> {
        let account = self.account.as_str();
        Ok(self
            .shared
            .read(|c| c.query_row("SELECT token FROM sync_state WHERE account_id = ?1 AND folder = ?2", (account, folder), |r| r.get(0)).optional())?
            .flatten())
    }

    fn store_state(&self, folder: &str, state: &str) -> Result<(), Fail> {
        let account = self.account.as_str();
        sync::write_for(self.shared, account, |c| {
            c.execute(
                "INSERT INTO sync_state (account_id, folder, token) VALUES (?1, ?2, ?3)
                 ON CONFLICT (account_id, folder) DO UPDATE SET token = excluded.token",
                (account, folder, state),
            )
        })?;
        Ok(())
    }

    /// Writes the mapping changes of an apply: `forget` drops `(folder, uid)`, `moved` maps each
    /// email id in `target`. Returns the `(old uid, new uid)` pairs.
    fn remap(&self, folder: &str, forget: &[u32], target: Option<&str>, moved: &[(u32, String)]) -> Result<Vec<(u32, u32)>, Fail> {
        let account = self.account.as_str();
        for chunk in forget.chunks(BATCH) {
            sync::write_for(self.shared, account, |c| chunk.iter().try_for_each(|uid| remote_ids::forget(c, account, folder, *uid).map(|_| ())))?;
        }
        let mut pairs = Vec::new();
        let Some(target) = target else {
            return Ok(pairs);
        };
        for chunk in moved.chunks(MOVE_BATCH) {
            let keys: Vec<String> = chunk.iter().map(|(_, id)| key(target, id)).collect();
            let new = sync::write_for(self.shared, account, |c| {
                for (old, _) in chunk {
                    remote_ids::forget(c, account, folder, *old)?;
                }
                remote_ids::uids_for(c, account, target, &keys)
            })?;
            pairs.extend(chunk.iter().map(|(old, _)| *old).zip(new));
        }
        Ok(pairs)
    }
}

impl Backend for JmapBackend<'_> {
    fn folders(&mut self) -> Result<Vec<FolderInfo>, Fail> {
        Ok(self.mailboxes(true)?.iter().map(folder_info).collect())
    }

    fn select(&mut self, folder: &str) -> Result<Selected, Fail> {
        let m = self.mailbox(folder, true)?;
        Ok(Selected { uid_validity: GENERATION, uid_next: None, total: m.total_emails as i64 })
    }

    fn window(&mut self, folder: &str, window_start_ms: i64) -> Result<Window, Fail> {
        // The state first: whatever changes from here on shows in the next pass's changes.
        let state = self.call(async |c| c.email_state().await)?;
        let mailbox = self.mailbox_id(folder)?;
        let after = timestamp(window_start_ms);
        // The mappings as they were before the query: only these can be judged by its answer (a
        // move replay maps into this folder after the query is not in it, and must stay).
        let account = self.account.clone();
        let known = self.shared.read(|c| remote_ids::folder_map(c, &account, folder))?;
        let ids = self.call(async |c| c.query_mailbox_since(&mailbox, &after).await)?;

        // Local uids: known ids keep theirs; new ones get the next, oldest first (the query is
        // newest first). `uids_for` hands back a mapping made meanwhile unchanged.
        let fresh: Vec<String> = ids.iter().rev().map(|id| key(folder, id)).filter(|k| !known.contains_key(k)).collect();
        let mut uids = known;
        for chunk in fresh.chunks(BATCH) {
            let got = sync::write_for(self.shared, &account, |c| remote_ids::uids_for(c, &account, folder, chunk))?;
            uids.extend(chunk.iter().cloned().zip(got));
        }
        let listed: HashMap<u32, String> = ids.into_iter().filter_map(|id| uids.get(&key(folder, &id)).map(|u| (*u, id))).collect();
        // A mapping no longer listed and with no row (its headers never came): nothing else
        // would ever remove it. One with a row goes with the row (`sync::delete_uids`).
        let rows: HashSet<u32> = self.shared.read(|c| {
            let mut st = c.prepare_cached("SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2")?;
            let rows = st.query_map((&account, folder), |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(|u| u as u32).collect())
        })?;
        let pending = self.pending_uids(folder)?;
        let orphans: Vec<u32> =
            uids.values().copied().filter(|u| !listed.contains_key(u) && !rows.contains(u) && !pending.contains(u)).collect();
        self.remap(folder, &orphans, None, &[])?;
        let window: Vec<u32> = listed.keys().copied().collect();
        self.listed = Some((folder.to_string(), listed));
        self.pass_state = Some((folder.to_string(), state));
        let unseen = self.mailbox(folder, false)?.unread_emails as i64;
        Ok(Window { uids: window, unseen })
    }

    /// One `Email/query` of what was received since the newest message held (a second early,
    /// for messages of the same second), never the window, and no Email state: flags and the
    /// state stay the next full pass's (`pass_done` is not reached).
    fn arrivals(&mut self, folder: &FolderRow, _newest_uid: u32, newest_ms: i64) -> Result<Option<Arrivals>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Ok(None);
        }
        let path = folder.path.clone();
        let mailbox = self.mailbox_id(&path)?;
        let after = timestamp((newest_ms - 1000).max(sync::window_start_ms(crate::compose::now_ms())));
        let account = self.account.clone();
        let known = self.shared.read(|c| remote_ids::folder_map(c, &account, &path))?;
        let ids = self.call(async |c| c.query_mailbox_since(&mailbox, &after).await)?;
        let fresh: Vec<String> = ids.iter().rev().map(|id| key(&path, id)).filter(|k| !known.contains_key(k)).collect();
        let mut uids = known;
        for chunk in fresh.chunks(BATCH) {
            let got = sync::write_for(self.shared, &account, |c| remote_ids::uids_for(c, &account, &path, chunk))?;
            uids.extend(chunk.iter().cloned().zip(got));
        }
        // `Email/query` answers newest first: the caller wants oldest first.
        let out: Vec<u32> = ids.iter().rev().filter_map(|id| uids.get(&key(&path, id)).copied()).collect();
        let listed: HashMap<u32, String> = ids.into_iter().filter_map(|id| uids.get(&key(&path, &id)).map(|u| (*u, id))).collect();
        self.listed = Some((path, listed));
        Ok(Some(Arrivals::all(out)))
    }

    fn headers(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<Header>, Fail> {
        let listed = self.listed(folder)?;
        let wanted: Vec<(u32, String)> = uids.iter().filter_map(|u| listed.get(u).map(|id| (*u, id.clone()))).collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = wanted.iter().map(|(_, id)| id.clone()).collect();
        let got = self.call(async |c| c.get_emails(&ids, HEADER_PROPS).await)?;
        let by_id: HashMap<&str, &Value> = got.list.iter().filter_map(|e| Some((e["id"].as_str()?, e))).collect();
        // Listed, then gone before its headers came: no row will hold its mapping, so it goes now.
        let pending = self.pending_uids(&folder.path)?;
        let missing: Vec<u32> =
            wanted.iter().filter(|(u, id)| !by_id.contains_key(id.as_str()) && !pending.contains(u)).map(|(u, _)| *u).collect();
        let headers = wanted.iter().filter_map(|(uid, id)| by_id.get(id.as_str()).map(|e| to_header(e, *uid))).collect();
        self.remap(&folder.path, &missing, None, &[])?;
        Ok(headers)
    }

    /// `Email/query` with the server's `text` filter over the mailbox, then `Email/get` of the hits;
    /// each under its local uid (new ones get the next, oldest first, as `window` gives them).
    fn search(&mut self, folder: &FolderRow, query: &str, limit: usize) -> Result<Vec<Header>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Err(Fail::Code(Code::Invalid, format!("generation of {} changed during search", folder.path)));
        }
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let path = folder.path.clone();
        let mailbox = self.mailbox_id(&path)?;
        let ids = self.call(async |c| c.search_mailbox(&mailbox, query, limit).await)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let got = self.call(async |c| c.get_emails(&ids, HEADER_PROPS).await)?;
        let by_id: HashMap<&str, &Value> = got.list.iter().filter_map(|e| Some((e["id"].as_str()?, e))).collect();
        // `ids` is newest first: the uids of the new ones go oldest first.
        let present: Vec<&String> = ids.iter().filter(|id| by_id.contains_key(id.as_str())).collect();
        let account = self.account.clone();
        let mut uids = self.shared.read(|c| remote_ids::folder_map(c, &account, &path))?;
        let fresh: Vec<String> = present.iter().rev().map(|id| key(&path, id)).filter(|k| !uids.contains_key(k)).collect();
        for chunk in fresh.chunks(BATCH) {
            let got = sync::write_for(self.shared, &account, |c| remote_ids::uids_for(c, &account, &path, chunk))?;
            uids.extend(chunk.iter().cloned().zip(got));
        }
        Ok(present.iter().filter_map(|id| Some(to_header(by_id[id.as_str()], *uids.get(&key(&path, id))?))).collect())
    }

    fn flags(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<(u32, Flags)>, Fail> {
        let listed = self.listed(folder)?.clone();
        let state = self.pass_state.as_ref().filter(|(f, _)| *f == folder.path).map(|(_, s)| s.clone());
        let held: Vec<(u32, String)> = uids.iter().filter_map(|u| listed.get(u).map(|id| (*u, id.clone()))).collect();
        let out = if held.is_empty() {
            Vec::new()
        } else {
            // What changed since the folder's stored state; `None`: read every held row.
            let changed: Option<HashSet<String>> = match self.stored_state(&folder.path)? {
                None => None,
                Some(since) => match self.call(async |c| c.email_changes(&since).await) {
                    Ok(ch) => Some(ch.updated.into_iter().chain(ch.created).collect()),
                    Err(CallErr::Jmap(JmapError::CannotCalculateChanges, _)) => None,
                    Err(e) => return Err(e.into()),
                },
            };
            let wanted: Vec<(u32, String)> = match changed {
                None => held,
                Some(changed) => {
                    let held_uids: Vec<u32> = held.iter().map(|(u, _)| *u).collect();
                    let overridden = self.overridden(&folder.path, &held_uids)?;
                    held.into_iter().filter(|(u, id)| changed.contains(id) || overridden.contains(u)).collect()
                }
            };
            self.keyword_flags(wanted)?
        };
        // Stored only when the pass has written these flags (`pass_done`): stored now, a pass that
        // stopped before its flag writes would leave those changes behind for good.
        self.pending_state = state.filter(|s| !s.is_empty()).map(|s| (folder.path.clone(), s));
        Ok(out)
    }

    fn parts(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<Vec<PartInfo>>, Fail> {
        self.parts = None;
        Ok(self.listed_parts(folder, uid)?.map(|parts| parts.into_iter().map(|(p, _)| p).collect()))
    }

    fn body(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<RawBody>, Fail> {
        let Some(id) = self.one_email_id(folder, uid)? else {
            return Ok(None);
        };
        let Some(v) = self.get_one(&id, &["htmlBody", "textBody", "bodyValues", "attachments"], true)? else {
            return Ok(None);
        };
        let html = first_value(&v["htmlBody"], &v["bodyValues"], "text/html");
        let text = first_value(&v["textBody"], &v["bodyValues"], "text/plain");
        // A value over `MAX_BODY_VALUE_BYTES` arrives cut: shown with a note, never cached.
        let truncated = body_truncated(&v);
        let (html, text) = (html.map(|(h, _)| h), text.map(|(t, _)| t));
        // An answer without the attachments list says nothing about them: shown, never cached.
        let (parts, attachments_unknown) = match Self::attachments_of(&v) {
            Some(parts) => {
                self.parts = Some((folder.path.clone(), uid, parts.clone()));
                (parts.into_iter().map(|(p, _)| p).collect(), false)
            }
            None => (Vec::new(), true),
        };
        Ok(Some(RawBody { parts, html, text, attachments_unknown, truncated }))
    }

    fn part_range(&mut self, folder: &FolderRow, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, Fail> {
        self.read(folder, uid, section, offset, len)
    }

    fn apply(
        &mut self,
        folder: &FolderRow,
        kind: Kind,
        uids: &[u32],
        target: Option<&str>,
        before_wire: BeforeWire<'_>,
    ) -> Result<ApplyOutcome, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Ok(ApplyOutcome::OtherGeneration);
        }
        let path = folder.path.as_str();
        let (present, mut gone) = self.email_ids(path, uids)?;
        if present.is_empty() {
            return Ok(ApplyOutcome::NonePresent);
        }
        let asked = present.len();
        match kind {
            Kind::Seen | Kind::Unseen | Kind::Flag | Kind::Unflag => {
                let on = kind.value() == 1;
                let keyword = if matches!(kind, Kind::Seen | Kind::Unseen) { "$seen" } else { "$flagged" };
                let patches: Vec<(String, Vec<(String, bool)>)> = present.iter().map(|(_, id)| (id.clone(), vec![(keyword.to_string(), on)])).collect();
                let out = match self.call(async |c| c.set_keywords(&patches).await) {
                    Ok(o) => o,
                    Err(e) => return refused_or_fail(e),
                };
                for (uid, id) in &present {
                    if let Some((_, why)) = out.failed.iter().find(|(f, _)| f == id) {
                        if why == "notFound" {
                            gone.push(*uid);
                        } else {
                            return Ok(ApplyOutcome::Refused(format!("Email/set refused {why}")));
                        }
                    }
                }
                Ok(ApplyOutcome::Done { gone, moved: None, kept: Vec::new() })
            }
            Kind::Delete => {
                let source = self.mailbox_id(path)?;
                let trash = self.mailboxes(false)?.iter().find(|m| has_role(m, "trash")).map(|m| m.id.clone());
                // Core's delete rule (`actions::policy`): in Trash, permanent (gone for good, or its
                // last label off); elsewhere a move, refused when the account has no Trash.
                let place = jmap_trash_place(&source, trash.as_deref());
                let permanent = delete_disposition(FolderRole::of(path, None), place, WithoutTrash::MoveToTrash) == DeleteDisposition::Permanent;
                before_wire()?;
                let mut done: Vec<u32> = Vec::new();
                let mut failed = None;
                for (uid, id) in &present {
                    let trash = trash.clone();
                    let source = source.clone();
                    match self.call(async |c| mailvault_core::jmap::remove_from(c, id, &source, trash.as_deref(), permanent).await) {
                        Ok(RemoveOutcome::Gone) => gone.push(*uid),
                        Ok(_) => done.push(*uid),
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                // What went is recorded before any failure is reported.
                self.remap(path, &done, None, &[])?;
                match failed {
                    Some(e) => refused_or_fail(e),
                    None if done.is_empty() && gone.len() >= asked => Ok(ApplyOutcome::NonePresent),
                    None => Ok(ApplyOutcome::Done { gone, moved: None, kept: Vec::new() }),
                }
            }
            Kind::Move => {
                let Some(target) = target else {
                    return Ok(ApplyOutcome::FolderGone);
                };
                let source = self.mailbox_id(path)?;
                let dest = match self.mailbox_id(target) {
                    Ok(d) => d,
                    Err(Fail::Code(Code::Invalid, _)) => return Ok(ApplyOutcome::FolderGone),
                    Err(f) => return Err(f),
                };
                if !self.mailboxes(true)?.iter().any(|m| m.id == dest) {
                    return Ok(ApplyOutcome::FolderGone);
                }
                before_wire()?;
                // The email keeps its id; only its labels change.
                let patches: Vec<(String, Vec<(String, bool)>)> =
                    present.iter().map(|(_, id)| (id.clone(), vec![(source.clone(), false), (dest.clone(), true)])).collect();
                let out = match self.call(async |c| c.set_mailboxes(&patches).await) {
                    Ok(o) => o,
                    Err(e) => return refused_or_fail(e),
                };
                let mut moved: Vec<(u32, String)> = Vec::new();
                let mut refused = None;
                for (uid, id) in &present {
                    match out.failed.iter().find(|(f, _)| f == id) {
                        None => moved.push((*uid, id.clone())),
                        Some((_, why)) if why == "notFound" => gone.push(*uid),
                        Some((_, why)) => refused = Some(format!("Email/set refused {why}")),
                    }
                }
                let pairs = self.remap(path, &[], Some(target), &moved)?;
                match refused {
                    Some(why) if moved.is_empty() => Ok(ApplyOutcome::Refused(why)),
                    _ if moved.is_empty() && gone.len() >= asked => Ok(ApplyOutcome::NonePresent),
                    _ => {
                        // A refused email stays where it was.
                        let kept: Vec<u32> =
                            present.iter().map(|(u, _)| *u).filter(|u| !gone.contains(u) && !moved.iter().any(|(m, _)| m == u)).collect();
                        Ok(ApplyOutcome::Done { gone, moved: Some(Moved { pairs, uid_validity: Some(GENERATION) }), kept })
                    }
                }
            }
        }
    }

    fn pass_done(&mut self, folder: &str) -> Result<(), Fail> {
        if let Some((f, state)) = self.pending_state.take() {
            if f == folder {
                self.store_state(folder, &state)?;
            }
        }
        Ok(())
    }

    /// The daemon's JMAP check (`follow_up_worker::check_row_jmap`) on this session: one
    /// `Email/query` for mail outside Sent and Drafts whose In-Reply-To or References names the
    /// message (core `matcher::jmap_reply_filter`), read back so a draft, the user's own mail and
    /// an automatic reply never count; then the Sent copy by exact Message-ID, in the folder the
    /// row names, then the role=sent mailbox, under its local uid.
    fn reply_check(&mut self, row: &FollowUp, own: &[String], _cache_miss: bool) -> Result<ReplyOutcome, Fail> {
        let term = mailvault_core::maildir::normalize_message_id(&row.message_id);
        if term.is_empty() {
            return Ok(ReplyOutcome::SentCopyGone);
        }
        let boxes = self.mailboxes(true)?.to_vec();
        let role = |r: &str| boxes.iter().find(|m| has_role(m, r)).map(|m| m.id.clone());
        let skip: Vec<String> = [role("sent"), role("drafts")].into_iter().flatten().collect();
        let filter = matcher::jmap_reply_filter(&term, &skip);
        let hits = self.call(async |c| c.query_emails(filter.clone(), REPLY_HITS).await)?;
        if !hits.is_empty() {
            let got = self.call(async |c| c.get_emails(&hits, &matcher::JMAP_REPLY_PROPS).await)?;
            if got.list.iter().any(|e| matcher::jmap_reply_from_someone_else(e, &term, own)) {
                return Ok(ReplyOutcome::Replied);
            }
        }
        let mut candidates: Vec<String> = Vec::new();
        let filed = Some(row.sent_mailbox.clone()).filter(|m| !m.is_empty() && boxes.iter().any(|b| b.id == *m));
        for id in filed.into_iter().chain(role("sent")) {
            if !candidates.contains(&id) {
                candidates.push(id);
            }
        }
        for mailbox in candidates {
            let found = self.call(async |c| c.find_message_id(&mailbox, &term).await)?;
            if let Some(email_id) = found {
                let account = self.account.clone();
                let keys = [key(&mailbox, &email_id)];
                let uids = sync::write_for(self.shared, &account, |c| remote_ids::uids_for(c, &account, &mailbox, &keys))?;
                if let Some(sent_uid) = uids.first().copied() {
                    return Ok(ReplyOutcome::NoReply { sent_mailbox: mailbox, sent_uid });
                }
            }
        }
        Ok(ReplyOutcome::SentCopyGone)
    }

    fn send(&mut self, email: &OutgoingEmail) -> Result<SendOutcome, SendFail> {
        let not_sent = SendFail::unsent;
        let config = crate::net::core_config(&self.row, &self.cred).map_err(|e| not_sent(Fail::Code(Code::Invalid, e), true))?;
        let built = smtp::build_mime(&config, email).map_err(|e| not_sent(Fail::Code(Code::Invalid, self.scrub(e)), true))?;
        // Core's JMAP send: identity for the From address, upload, import into Drafts, submit,
        // and `onSuccessUpdateEmail` files it in Sent.
        match block_on(smtp::send_built_phased(&config, email, built)) {
            Ok(sent) => Ok(SendOutcome { server_saved_sent: sent_copy_policy(&config, &sent) == SentCopy::ServerFiled, raw: sent.raw_rfc2822 }),
            Err(e) => {
                let message = self.scrub(e.message);
                let auth = message.starts_with("E_JMAP_AUTH");
                if auth {
                    self.shared.jmap.forget(&self.account);
                }
                let verdict = classify_failure(e.phase, e.permanent, &message);
                let fail = if auth { Fail::Code(Code::AuthFailed, message) } else { Fail::from(message) };
                Err(SendFail { fail, verdict })
            }
        }
    }

    fn file_sent(&mut self, _sent: &SendOutcome) -> Result<(), Fail> {
        // The submission's `onSuccessUpdateEmail` filed it in Sent.
        Ok(())
    }

    fn wait_for_change(&mut self, folder: &FolderRow, watch: &Watch) -> Result<Change, Fail> {
        if self.client.event_source_url().is_none() {
            // No push: the Email state every `watch.poll`, against the one the last pass stored.
            if !watch.nap(watch.poll) {
                return Ok(Change::Quiet);
            }
            let state = self.call(async |c| c.email_state().await)?;
            return Ok(if self.stored_state(&folder.path)?.as_deref() == Some(state.as_str()) { Change::Quiet } else { Change::Changed });
        }
        if self.events.is_none() {
            let resp = self.call(async |c| c.open_event_source(EVENT_TYPES, EVENT_PING_SECS).await)?;
            self.events = Some(EventStream { resp, parser: SseParser::default() });
        }
        loop {
            if watch.stopped() {
                return Ok(Change::Quiet);
            }
            let stream = self.events.as_mut().expect("opened above");
            // Short reads, so a stop is seen within one. A dead stream ends on core's read-idle
            // timeout (the server pings every minute).
            let read = block_on(async { async_std::future::timeout(STOP_CHECK, stream.resp.chunk()).await });
            let bytes = match read {
                Err(_) => continue,
                Ok(Ok(Some(bytes))) => bytes,
                Ok(Ok(None)) => {
                    self.events = None;
                    return Err(Fail::Code(Code::HostUnreachable, "the EventSource stream closed".into()));
                }
                Ok(Err(e)) => {
                    self.events = None;
                    let text = self.scrub(format!("EventSource read failed: {e}"));
                    return Err(Fail::Code(Code::HostUnreachable, text));
                }
            };
            let events = stream.parser.feed(&bytes);
            for event in events {
                if event.kind == "state" && self.pushed_email_change(&folder.path, &event.data)? {
                    return Ok(Change::Changed);
                }
            }
        }
    }
}

impl JmapBackend<'_> {
    /// A pushed StateChange names an Email state for this JMAP account other than the one the
    /// last pass of `folder` stored. Another account's entry, or an unreadable one, is no change.
    fn pushed_email_change(&self, folder: &str, data: &str) -> Result<bool, Fail> {
        let Some(change) = StateChange::parse(data) else {
            return Ok(false);
        };
        let Some(pushed) = change.email_state(self.client.account_id()) else {
            return Ok(false);
        };
        Ok(self.stored_state(folder)?.as_deref() != Some(pushed))
    }
}

/// What the live stream asks to hear about.
const EVENT_TYPES: &str = "Email,Mailbox";
/// The server's keep-alive interval on the live stream.
const EVENT_PING_SECS: u32 = 60;
/// The live EventSource response and what has been read of it.
struct EventStream {
    resp: reqwest::Response,
    parser: SseParser,
}

// ── mobile.accounts.add for kind = jmap ─────────────────────────────────────

/// What the JMAP form sends: `{kind: "jmap", email, password, jmapUrl?, displayName?}`. Read by
/// hand so an error names the field, never the value (serde would quote the password).
struct JmapForm {
    email: String,
    password: String,
    url: Option<String>,
    display_name: Option<String>,
}

fn read_form(params: &Value) -> Result<JmapForm, String> {
    let obj = params.as_object().ok_or("params must be an object")?;
    let text = |k: &str| -> Result<String, String> {
        match obj.get(k) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(format!("{k} must be a string")),
        }
    };
    let optional = |k: &str| -> Result<Option<String>, String> {
        match obj.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
            _ => Err(format!("{k} must be a string")),
        }
    };
    let email = text("email")?.trim().to_string();
    let at = email.find('@');
    if at.is_none_or(|i| i == 0 || i + 1 >= email.len()) || email.chars().any(char::is_whitespace) {
        return Err("email is not an address".into());
    }
    let password = text("password")?;
    if password.is_empty() {
        return Err("password is empty".into());
    }
    Ok(JmapForm { email, password, url: optional("jmapUrl")?, display_name: optional("displayName")? })
}

/// A typed session URL as a URL: `https://` when it names no scheme, `/.well-known/jmap` when it
/// names no path. `Err` is the reply: not a URL, credentials in it, or not https (a loopback
/// http URL passes only under the debug test override).
fn session_url(typed: &str) -> Result<url::Url, Value> {
    let full = if typed.contains("://") { typed.to_string() } else { format!("https://{typed}") };
    let mut url = url::Url::parse(&full).map_err(|_| failure(Code::Invalid, "the server address is not a URL"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(failure(Code::Invalid, "the server address must not hold a user name or password"));
    }
    if !mailvault_core::jmap::base::url_allowed(&url) {
        return Err(failure_code("HTTPS_REQUIRED", "the server address must be https"));
    }
    if url.path().is_empty() || url.path() == "/" {
        url.set_path("/.well-known/jmap");
    }
    url.set_fragment(None);
    Ok(url)
}

/// A reply code the accounts [`Code`] list does not have (JMAP only).
fn failure_code(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// The host as the account row shows it, with the port when it is not 443.
fn host_port(url: &url::Url) -> (String, u16) {
    (url.host_str().unwrap_or_default().to_ascii_lowercase(), url.port_or_known_default().unwrap_or(443))
}

/// A connect failure as the add form's reply.
fn add_failure(e: &JmapError, password: &str) -> Value {
    let text = mailvault_core::secret_scrub::scrub(&e.to_string(), &[password]);
    match e {
        JmapError::Protocol(m) if m.contains("requires https") || m.contains("must be https") => failure_code("HTTPS_REQUIRED", &text),
        _ => failure(code_of(e), text),
    }
}

/// `mobile.accounts.add` with `kind: "jmap"`: finds the session (the typed URL, else the
/// Fastmail preset or discovery), signs in with the password as an app password (Basic) or as a
/// token (Bearer), whichever the server takes, proves the mailbox list reads, then stores the
/// secret and the row. A discovered host the address's domain does not vouch for is never sent
/// the password: the reply is `CONFIRM_HOST` with the host and URL, and the page sends the URL
/// back as typed once the user confirms it. Nothing found: `JMAP_NOT_FOUND`.
pub(crate) fn add(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let form = match read_form(&params) {
        Ok(f) => f,
        Err(m) => return Ok(failure(Code::Invalid, m)),
    };
    if accounts::email_taken(engine, &form.email)? {
        return Ok(failure(Code::Duplicate, "this account is already added"));
    }
    let shared = engine.shared();
    let domain = discover::email_domain(&form.email).unwrap_or_default();
    let fastmail_domain = matches!(domain.as_str(), "fastmail.com" | "fastmail.fm");
    let url = match &form.url {
        Some(typed) => match session_url(typed) {
            Ok(u) => u,
            Err(reply) => return Ok(reply),
        },
        None => {
            let found = if fastmail_domain { Some(discover::fastmail_preset()) } else { shared.jmap.discover(&form.email) };
            let Some(found) = found else {
                return Ok(failure_code("JMAP_NOT_FOUND", "no JMAP server was found for this address"));
            };
            if found.needs_host_confirmation {
                return Ok(json!({
                    "ok": false, "code": "CONFIRM_HOST", "message": "the server is not on the address's domain",
                    "host": found.host, "jmapUrl": found.session_url,
                }));
            }
            match session_url(&found.session_url) {
                Ok(u) => u,
                Err(reply) => return Ok(reply),
            }
        }
    };
    let fastmail = url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(discover::FASTMAIL_API_HOST));
    // Fastmail's JMAP takes an API token, not an app password: try that first there.
    let order = if fastmail { ["bearer", "password"] } else { ["password", "bearer"] };
    let mut connected = None;
    let mut last = JmapError::Unauthorized;
    for auth in order {
        let jauth = if auth == "bearer" {
            JmapAuth::Bearer(form.password.clone())
        } else {
            JmapAuth::Basic { username: form.email.clone(), password: form.password.clone() }
        };
        match block_on(JmapClient::connect(url.as_str(), jauth, &form.email)) {
            Ok(c) => {
                connected = Some((c, auth));
                break;
            }
            Err(JmapError::Unauthorized) => last = JmapError::Unauthorized,
            Err(e) => return Ok(add_failure(&e, &form.password)),
        }
    }
    let Some((client, auth)) = connected else {
        return Ok(add_failure(&last, &form.password));
    };
    let mailboxes = match block_on(client.mailboxes()) {
        Ok((list, _)) => list,
        Err(e) => return Ok(add_failure(&e, &form.password)),
    };
    let Some(inbox) = mailboxes.iter().find(|m| is_inbox_role(m)) else {
        return Ok(failure(Code::Invalid, "the account has no inbox"));
    };
    let count = inbox.total_emails;

    let id = accounts::new_account_id();
    let secret = Credential::from_password(&form.password).to_secret();
    engine
        .secrets()
        .set(&id, &secret)
        .map_err(|e| RpcError::Internal(mailvault_core::secret_scrub::scrub(&e, &[secret.as_str(), form.password.as_str()])))?;
    let display_name = form.display_name.clone().unwrap_or_else(|| form.email.clone());
    let (host, port) = host_port(&url);
    let session = url.to_string();
    let inserted = engine.write(|c| {
        c.execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, jmap_url, needs_auth, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'ssl', 'jmap', ?6, ?7, 0, ?8)",
            rusqlite::params![&id, &form.email, &display_name, &host, port as i64, auth, &session, accounts::now_ms()],
        )?;
        c.execute(
            "INSERT INTO sync_state (account_id, folder, token) VALUES (?1, ?2, ?3)
             ON CONFLICT (account_id, folder) DO UPDATE SET token = excluded.token",
            (&id, LIMITS_KEY, limits_json(&client)),
        )?;
        Ok(())
    });
    if let Err(e) = inserted {
        let _ = engine.secrets().delete(&id);
        if accounts::is_unique_violation(&e.to_string()) {
            return Ok(failure(Code::Duplicate, "this account is already added"));
        }
        return Err(RpcError::Internal(e.to_string()));
    }
    shared.jmap.put(&id, Arc::new(client));
    let mut account = accounts::account_json(&id, &form.email, &display_name, &host, port as i64, "ssl", (None, None, None));
    account["kind"] = json!("jmap");
    account["provider"] = Value::Null;
    account["needsAuth"] = json!(false);
    Ok(json!({ "ok": true, "messageCount": count, "account": account }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_folder_qualified_and_split_back() {
        assert_eq!(key("INBOX", "Mabc"), "INBOX|Mabc");
        assert_eq!(email_id("INBOX|Mabc"), "Mabc");
        assert_eq!(email_id("P1|Mx-_9"), "Mx-_9");
        assert_ne!(key("INBOX", "M1"), key("P1", "M1"), "one email has a mapping per mailbox");
        assert_eq!(timestamp(1_767_225_600_000 + 3_661_000), "2026-01-01T01:01:01Z");
    }

    #[test]
    fn a_typed_session_url_must_be_https() {
        assert_eq!(session_url("jmap.example.com").unwrap().as_str(), "https://jmap.example.com/.well-known/jmap");
        assert_eq!(session_url("https://api.example.com/jmap/session").unwrap().as_str(), "https://api.example.com/jmap/session");
        assert_eq!(session_url("http://jmap.example.com/jmap").unwrap_err()["code"], "HTTPS_REQUIRED");
        assert_eq!(session_url("ftp://jmap.example.com/").unwrap_err()["code"], "HTTPS_REQUIRED");
        assert_eq!(session_url("https://u:p@jmap.example.com/").unwrap_err()["code"], "INVALID");
    }

    #[test]
    fn parts_carry_their_part_id_and_blob() {
        let (p, blob) = part_info(&json!({"partId": "3", "blobId": "Gx_3", "size": 12, "name": "a.pdf", "type": "Application/PDF", "disposition": "attachment"})).unwrap();
        assert_eq!((p.section.as_str(), blob.as_str(), p.mime.as_str(), p.size, p.encoding.as_str()), ("3", "Gx_3", "application/pdf", 12, "binary"));
        let (p, _) = part_info(&json!({"partId": "4", "blobId": "B", "type": "image/png", "cid": "<img1@x>"})).unwrap();
        assert_eq!((p.content_id.as_deref(), p.disposition.as_deref()), (Some("img1@x"), Some("inline")));
        assert!(part_info(&json!({"blobId": "B"})).is_none(), "no partId: nothing to name it by");
    }

    #[test]
    fn a_cut_body_value_says_so() {
        let parts = json!([{"partId": "1", "type": "text/html"}]);
        let cut = json!({"1": {"value": "<p>start", "isTruncated": true}});
        assert_eq!(first_value(&parts, &cut, "text/html"), Some(("<p>start".to_string(), true)));
        let whole = json!({"1": {"value": "<p>all</p>", "isTruncated": false}});
        assert_eq!(first_value(&parts, &whole, "text/html"), Some(("<p>all</p>".to_string(), false)));
        assert_eq!(first_value(&parts, &whole, "text/plain"), None);
    }

    #[test]
    fn a_cut_text_value_beside_a_whole_html_one_is_a_cut_body() {
        let v = json!({
            "htmlBody": [{"partId": "2", "type": "text/html"}],
            "textBody": [{"partId": "1", "type": "text/plain"}],
            "bodyValues": {"1": {"value": "start", "isTruncated": true}, "2": {"value": "<p>all</p>", "isTruncated": false}},
        });
        assert!(body_truncated(&v));
        let whole = json!({"htmlBody": v["htmlBody"], "textBody": v["textBody"], "bodyValues": {"1": {"value": "all"}, "2": {"value": "<p>all</p>"}}});
        assert!(!body_truncated(&whole));
    }

    #[test]
    fn an_answer_without_the_attachments_list_is_unknown_not_none() {
        assert!(JmapBackend::attachments_of(&json!({"id": "e1"})).is_none(), "missing: unknown");
        assert!(JmapBackend::attachments_of(&json!({"id": "e1", "attachments": null})).is_none(), "null: unknown");
        assert_eq!(JmapBackend::attachments_of(&json!({"id": "e1", "attachments": []})).unwrap().len(), 0, "an empty list: none");
        let two_same = json!({"attachments": [{"partId": "2", "blobId": "B"}, {"partId": "2", "blobId": "B"}, {"partId": "3", "blobId": "B"}]});
        assert_eq!(JmapBackend::attachments_of(&two_same).unwrap().len(), 2, "one row per partId, even for one blob");
    }

    #[test]
    fn only_an_answered_refusal_is_refused() {
        let t = String::new;
        assert!(matches!(refused_or_fail(CallErr::Jmap(JmapError::Method { kind: "invalidProperties".into(), description: None }, t())), Ok(ApplyOutcome::Refused(_))));
        assert!(matches!(refused_or_fail(CallErr::Jmap(JmapError::NoTrash, t())), Ok(ApplyOutcome::Refused(_))));
        assert!(matches!(refused_or_fail(CallErr::Jmap(JmapError::Protocol("HTTP 400".into()), t())), Ok(ApplyOutcome::Refused(_))));
        for transient in [
            JmapError::Method { kind: "serverFail".into(), description: None },
            JmapError::Protocol("HTTP 502".into()),
            JmapError::Transport("connection reset".into()),
            JmapError::RateLimited { retry_after: Some(3) },
        ] {
            assert!(refused_or_fail(CallErr::Jmap(transient.clone(), t())).is_err(), "{transient:?}");
        }
    }
}
