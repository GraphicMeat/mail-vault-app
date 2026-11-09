//! [`Backend`] over Microsoft Graph, through mailvault-core's `GraphClient` (plan Ruling 5:
//! Microsoft accounts on mobile are Graph accounts).
//!
//! Identity: a folder's stored path is its Graph id (Ruling 7), except the inbox, stored as
//! `INBOX` because the page and sync address it by that name; every request names it by Graph's
//! well-known `inbox` ([`remote_folder`]). A message gets a local uid from `remote_ids`, handed out
//! in ascending received order by [`GraphBackend::window`]; Graph has no UIDVALIDITY, so every
//! folder's generation is the constant [`GENERATION`].
//!
//! A pass lists the folder's 90-day window once (`GraphClient::list_since`, newest first, with the
//! read and flag state) and serves `headers` and `flags` from that listing.
//!
//! Opening a message never downloads an attachment (Ruling 13 as revised): the body comes from
//! the message resource (`GraphClient::get_body`, HTML where there is one), the parts are the
//! attachments' metadata (`list_attachments`, no bytes), each part's section being its Graph
//! attachment id. A listing that fails leaves the body with no attachments rather than failing
//! the open. A cloud link (`referenceAttachment`) is listed with encoding [`LINK`] and never
//! fetched; an attached message (`itemAttachment`) is `message/rfc822` named `.eml`.
//!
//! A tapped attachment is one response streamed through the attachment worker's range reads
//! (Graph serves no byte ranges): each `part_range` takes the next bytes of the open response, so
//! the worker writes its cache file chunk by chunk, with progress, and a cancel stops it between
//! chunks. A range that does not continue the open response (a resumed download) opens it again
//! and skips to the offset.
//!
//! Every request goes through [`GraphBackend::call`]: a 401 gets one token refresh and one retry
//! (a second 401 is handled as `ImapBackend::open` handles a fresh token refused), and a 429 waits
//! the server's `Retry-After` (capped) and retries, a few times, as a transient condition and
//! never as an error. `open` makes no request.

use super::{ApplyOutcome, Arrivals, Backend, BeforeWire, Change, FolderInfo, FolderRow, Flags, Header, Moved, RawBody, Selected, SendFail, SendOutcome, StopFlag, Watch, Window};
use crate::accounts::{load_account, map_error, Code};
use crate::actions::Kind;
use crate::db::Shared;
use crate::net::block_on;
use crate::remote_ids;
use crate::secrets::Credential;
use crate::sync::{self, Fail};
use mailvault_core::actions::policy::{delete_disposition, graph_trash_place, DeleteDisposition, FolderRole, WithoutTrash};
use mailvault_core::graph::{AttachmentStream, GraphAttachmentInfo, GraphClient, GraphMailFolder, GraphSynced};
use mailvault_core::imap::PartInfo;
use mailvault_core::send::classify::classify_failure;
use mailvault_core::send::sent_policy::{sent_copy_policy, SentCopy};
use mailvault_core::smtp::{self, OutgoingEmail};
use mailvault_core::sync_core::dates::utc_timestamp as timestamp;
use mailvault_core::sync_core::throttle::{retry_after_from, throttle_wait};
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Graph has no UIDVALIDITY: every folder's generation, constant so sync never wipes.
pub(crate) const GENERATION: i64 = 1;
/// How many times one call waits out a 429 before it fails (transiently).
const THROTTLE_WAITS: u32 = 3;
/// The longest single wait a `Retry-After` gets.
const MAX_RETRY_AFTER: u64 = 30;
/// The wait when a 429 named none.
const DEFAULT_RETRY_AFTER: u64 = 5;
/// A connection that has not opened by then fails (as no answer: retried).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Silence on an open request (before the answer, or between chunks of a body) that fails it,
/// so a half-open socket after a network switch never holds a worker or the RPC thread.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

fn client(token: &str) -> GraphClient {
    GraphClient::with_stall_limits(token, "sync", CONNECT_TIMEOUT, READ_TIMEOUT)
}
/// The `encoding` of a Graph cloud-link attachment: listed, never fetched (it has no bytes).
pub(crate) const LINK: &str = "link";

/// New mappings per write transaction (plus the one `uid_seq` row: at most 200 rows).
const BATCH: usize = 199;
/// Moves remapped per write transaction (a forget and an insert each, plus `uid_seq`).
const MOVE_BATCH: usize = 99;

/// The id a request names `path` by: the inbox by Graph's well-known name, any other folder by
/// the Graph id stored as its path.
fn remote_folder(path: &str) -> &str {
    if sync::is_inbox(path) {
        "inbox"
    } else {
        path
    }
}

/// The status of a core Graph error text (`Graph <what> failed (<status>) …`, or
/// `(429:retry_after=N)`); `None` for a request that got no answer.
fn status_of(e: &str) -> Option<u16> {
    let rest = &e[e.find("failed (")? + "failed (".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// A Graph failure as a sync or a body read reports it.
fn graph_fail(e: String) -> Fail {
    let code = match status_of(&e) {
        // 403 is Graph refusing one resource (a folder the mailbox may not open): no sign-in fixes it.
        Some(401) => Code::AuthFailed,
        Some(429) => Code::Timeout,
        Some(s) if s >= 500 => Code::HostUnreachable,
        Some(_) => Code::Invalid,
        None => match map_error(&e) {
            Code::Invalid => Code::HostUnreachable,
            c => c,
        },
    };
    Fail::Code(code, e)
}

/// A Graph failure of an action: a refusal (4xx) the journal counts, or a failure it retries
/// (5xx, a throttle that outlasted the waits, no answer), never dropped as refused.
fn refused_or_fail(e: String) -> Result<ApplyOutcome, Fail> {
    match status_of(&e) {
        Some(s) if (400..500).contains(&s) && s != 429 && s != 401 => Ok(ApplyOutcome::Refused(e)),
        _ => Err(graph_fail(e)),
    }
}

/// A listed row as the header sync stores: core's conversion plus Outlook's flag and where a
/// reply goes (core's header leaves both unset for Graph).
fn header_of(uid: u32, row: &GraphSynced) -> Header {
    let mut h = row.message.to_email_header(uid);
    if row.flagged {
        h.flags.push("\\Flagged".into());
    }
    if let Some(to) = row.reply_to.first() {
        h.reply_to = Some(to.clone());
    }
    h
}

fn special_use(well_known: Option<&str>) -> Option<String> {
    let s = match well_known? {
        "sentitems" => "\\Sent",
        "drafts" => "\\Drafts",
        "deleteditems" => "\\Trash",
        "junkemail" => "\\Junk",
        "archive" => "\\Archive",
        _ => return None,
    };
    Some(s.to_string())
}

fn folder_info(f: &GraphMailFolder) -> FolderInfo {
    let inbox = f.well_known_name.as_deref() == Some("inbox");
    FolderInfo {
        path: if inbox { "INBOX".to_string() } else { f.id.clone() },
        name: f.display_name.clone(),
        special_use: special_use(f.well_known_name.as_deref()),
        delimiter: None,
        noselect: false,
        counts: Some((f.unread_item_count, f.total_item_count)),
    }
}

/// A Graph attachment as a part: its id is the section; its bytes come as Graph stores them
/// (`binary`, nothing to undo). A cloud link is encoding [`LINK`] with no size; an attached
/// message is `message/rfc822` named `.eml`.
fn part_info(a: GraphAttachmentInfo) -> PartInfo {
    let kind = a.odata_type.as_deref().unwrap_or("").to_ascii_lowercase();
    let link = kind.ends_with("referenceattachment");
    let item = kind.ends_with("itemattachment");
    let mut filename = a.name.filter(|n| !n.trim().is_empty());
    if item {
        let base = filename.unwrap_or_else(|| "message".into());
        filename = Some(if base.to_ascii_lowercase().ends_with(".eml") { base } else { format!("{base}.eml") });
    }
    let mime = if item {
        "message/rfc822".to_string()
    } else {
        a.content_type.map(|t| t.to_ascii_lowercase()).filter(|t| !t.is_empty()).unwrap_or_else(|| "application/octet-stream".into())
    };
    PartInfo {
        section: a.id,
        mime,
        filename,
        size: if link { 0 } else { u32::try_from(a.size.max(0)).unwrap_or(u32::MAX) },
        encoding: if link { LINK } else { "binary" }.into(),
        charset: None,
        content_id: None,
        disposition: Some(if a.is_inline { "inline" } else { "attachment" }.to_string()),
    }
}

/// Why a call did not return a value.
enum CallErr {
    /// Final: the account must sign in again, it is gone, or the engine is closing.
    Fail(Fail),
    /// Graph's answer (or the lack of one), scrubbed; the caller decides what it means.
    Text(String),
}

impl From<CallErr> for Fail {
    fn from(e: CallErr) -> Fail {
        match e {
            CallErr::Fail(f) => f,
            CallErr::Text(t) => graph_fail(t),
        }
    }
}

/// The attachment response `part_range` is reading.
struct Streaming {
    folder: String,
    uid: u32,
    section: String,
    stream: AttachmentStream,
    /// Bytes received and not yet handed out.
    buf: Vec<u8>,
    /// The offset of `buf`'s first byte.
    pos: u64,
    ended: bool,
}

pub(crate) struct GraphBackend<'a> {
    shared: &'a Shared,
    account: String,
    client: GraphClient,
    token: String,
    /// The account's secrets, scrubbed out of every failure text.
    secrets: Vec<String>,
    /// The last `select`: the folder's path and its `(unread, total)`.
    selected: Option<(String, (i64, i64))>,
    /// The last `window`: the folder's path and its listed messages by uid.
    listed: Option<(String, HashMap<u32, GraphSynced>)>,
    /// The attachment response `part_range` is reading.
    streaming: Option<Streaming>,
    /// A request went through since `open`.
    worked: bool,
    /// The live poll's last look at the inbox's newest message: `(id, lastModifiedDateTime)`,
    /// `Some(None)` for an empty folder.
    newest: Option<Option<(String, Option<String>)>>,
    /// While a live wait runs: its stop, which also ends a throttle's wait.
    stop: Option<Arc<StopFlag>>,
    /// A background run's pass stops here: no throttle is waited out past it.
    deadline: Option<Instant>,
}

impl<'a> GraphBackend<'a> {
    /// Whether `id` is listed in `folder`: mapped, and its row landed (a pass cut off between the
    /// two leaves a mapping with no row, which is still news).
    fn is_listed(&self, folder: &str, id: &str) -> Result<bool, Fail> {
        let account = self.account.as_str();
        Ok(self
            .shared
            .read(|c| {
                c.query_row(
                    "SELECT 1 FROM remote_ids r JOIN messages m ON m.account_id = r.account_id AND m.folder = r.folder AND m.uid = r.uid
                     WHERE r.account_id = ?1 AND r.folder = ?2 AND r.remote_id = ?3",
                    (account, folder, id),
                    |_| Ok(()),
                )
                .optional()
            })?
            .is_some())
    }

    /// Whether `id` already has a local uid in `folder` (a pass listed it).
    fn is_mapped(&self, folder: &str, id: &str) -> Result<bool, Fail> {
        let account = self.account.as_str();
        Ok(self
            .shared
            .read(|c| {
                c.query_row("SELECT 1 FROM remote_ids WHERE account_id = ?1 AND folder = ?2 AND remote_id = ?3", (account, folder, id), |_| Ok(()))
                    .optional()
            })?
            .is_some())
    }

    /// The live poll: every `watch.poll`, the folder's newest message (`$top=1`, id and
    /// `lastModifiedDateTime`) against the last one seen; a change only when they differ, so a
    /// quiet minute costs one small request and never a listing of the window. The first look
    /// is a change when that newest message has no local uid yet (it came in since the last
    /// sync).
    fn poll_newest(&mut self, folder: &FolderRow, watch: &Watch) -> Result<Change, Fail> {
        let remote = remote_folder(&folder.path).to_string();
        if self.newest.is_none() {
            let now = self.call(async |c| c.newest_in(&remote).await)?;
            let known = match &now {
                None => true,
                Some((id, _)) => self.is_mapped(&folder.path, id)?,
            };
            self.newest = Some(now);
            if !known {
                return Ok(Change::Changed);
            }
        }
        if !watch.nap(watch.poll) {
            return Ok(Change::Quiet);
        }
        let now = self.call(async |c| c.newest_in(&remote).await)?;
        Ok(if self.newest.replace(now.clone()) == Some(now) { Change::Quiet } else { Change::Changed })
    }

    /// The account's backend with its current token (refreshed when about to expire). No request:
    /// the first call proves the token.
    pub(crate) fn open(shared: &'a Shared, account: &str) -> Result<GraphBackend<'a>, Fail> {
        if load_account(shared, account)?.is_none() {
            return Err(Fail::Gone);
        }
        let token = crate::oauth::access_token(shared, account)?;
        let mut backend = GraphBackend {
            shared,
            account: account.to_string(),
            client: client(&token),
            token: String::new(),
            secrets: Vec::new(),
            selected: None,
            listed: None,
            streaming: None,
            worked: false,
            newest: None,
            stop: None,
            deadline: None,
        };
        backend.set_token(token);
        Ok(backend)
    }

    fn set_token(&mut self, token: String) {
        self.client = client(&token);
        let mut secrets: Vec<String> = match self.shared.secrets().get(&self.account) {
            Ok(Some(s)) => Credential::parse(&s).secrets().into_iter().map(String::from).collect(),
            _ => Vec::new(),
        };
        secrets.push(token.clone());
        self.secrets = secrets;
        self.token = token;
    }

    fn scrub(&self, text: String) -> String {
        mailvault_core::secret_scrub::scrub(&text, &self.secrets.iter().map(String::as_str).collect::<Vec<_>>())
    }

    /// Waits `wait` in slices of at most a second, stopping early when the engine closes.
    fn pause(&self, wait: Duration) -> Result<(), CallErr> {
        if self.deadline.is_some_and(|d| Instant::now() + wait >= d) {
            return Err(CallErr::Fail(Fail::Code(Code::Timeout, "throttled past the background run's budget".into())));
        }
        let mut left = wait;
        while !left.is_zero() {
            sync::not_closing(self.shared).map_err(CallErr::Fail)?;
            if self.stop.as_ref().is_some_and(|s| s.is_stopped()) {
                return Err(CallErr::Fail(Fail::Closing));
            }
            let step = left.min(Duration::from_secs(1));
            std::thread::sleep(step);
            left -= step;
        }
        Ok(())
    }

    /// Runs one request: a 401 refreshes the token once and retries; a 429 waits `Retry-After`
    /// and retries up to [`THROTTLE_WAITS`] times. Anything else comes back as Graph's text.
    fn call<T>(&mut self, op: impl AsyncFn(&GraphClient) -> Result<T, String>) -> Result<T, CallErr> {
        let mut refreshed = false;
        let mut waits = 0;
        loop {
            sync::not_closing(self.shared).map_err(CallErr::Fail)?;
            let out = block_on(op(&self.client));
            let e = match out {
                Ok(v) => {
                    if !self.worked {
                        self.worked = true;
                        crate::oauth::sign_in_worked(self.shared, &self.account);
                    }
                    return Ok(v);
                }
                Err(e) => e,
            };
            if GraphClient::is_token_expired(&e) {
                if refreshed {
                    // Refused with a token minted just now: parked after a few in a row, as an
                    // IMAP account whose server refuses a fresh token.
                    let why = self.scrub(e);
                    return Err(CallErr::Fail(
                        crate::oauth::fresh_token_refused(self.shared, &self.account, &self.token).unwrap_or(Fail::Code(Code::AuthFailed, why)),
                    ));
                }
                refreshed = true;
                let token = crate::oauth::access_token_after_refusal(self.shared, &self.account, &self.token).map_err(CallErr::Fail)?;
                self.set_token(token);
                continue;
            }
            if GraphClient::is_rate_limited(&e) && waits < THROTTLE_WAITS {
                waits += 1;
                let wait = throttle_wait(retry_after_from(&e), DEFAULT_RETRY_AFTER, MAX_RETRY_AFTER);
                self.pause(wait)?;
                continue;
            }
            return Err(CallErr::Text(self.scrub(e)));
        }
    }

    /// The folder's `(unread, total)` (from the pass's `select` when it was this folder).
    fn counts(&mut self, folder: &str) -> Result<(i64, i64), Fail> {
        if let Some((path, counts)) = &self.selected {
            if path == folder {
                return Ok(*counts);
            }
        }
        let remote = remote_folder(folder).to_string();
        let f = self.call(async |c| c.get_folder(&remote).await)?;
        let counts = (f.unread_item_count, f.total_item_count);
        self.selected = Some((folder.to_string(), counts));
        Ok(counts)
    }

    /// The pass's listing of `folder.path`, read again when this backend has not listed it.
    fn listed(&mut self, folder: &FolderRow) -> Result<&HashMap<u32, GraphSynced>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Err(Fail::Code(Code::Invalid, format!("generation of {} changed during sync", folder.path)));
        }
        if self.listed.as_ref().is_none_or(|(p, _)| *p != folder.path) {
            self.window(&folder.path, sync::window_start_ms(crate::compose::now_ms()))?;
        }
        Ok(&self.listed.as_ref().expect("listed just now").1)
    }

    fn remote_ids(&self, folder: &str, uids: &[u32]) -> Result<Vec<(u32, Option<String>)>, Fail> {
        let account = self.account.as_str();
        Ok(self.shared.read(|c| uids.iter().map(|u| Ok((*u, remote_ids::remote_for(c, account, folder, *u)?))).collect::<rusqlite::Result<Vec<_>>>())?)
    }

    /// The remote id of `uid` in `folder`; `None` when it has none or the generation is not
    /// [`GENERATION`].
    fn remote_id(&self, folder: &FolderRow, uid: u32) -> Result<Option<String>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Ok(None);
        }
        Ok(self.remote_ids(&folder.path, &[uid])?.pop().and_then(|(_, id)| id))
    }

    /// The message's attachments as parts (metadata, no bytes); `None` when the message is gone.
    fn attachments(&mut self, id: &str) -> Result<Option<Vec<PartInfo>>, Fail> {
        match self.call(async |c| c.list_attachments(id).await) {
            Ok(list) => Ok(Some(list.into_iter().map(part_info).collect())),
            Err(CallErr::Text(e)) if status_of(&e) == Some(404) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Octets `offset..offset + len` of attachment `section` (fewer at its end): the next bytes of
    /// the open response when it is that attachment's at `offset`, else a new response skipped to
    /// `offset`. `None` when the message or attachment is gone.
    fn read(&mut self, folder: &FolderRow, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, Fail> {
        if section.bytes().all(|b| b == b'.') {
            return Err(Fail::Code(Code::Invalid, "an attachment id made of dots".into()));
        }
        let continues = self.streaming.as_ref().is_some_and(|s| {
            s.folder == folder.path && s.uid == uid && s.section == section && s.pos <= offset && (offset <= s.pos + s.buf.len() as u64 || !s.ended)
        });
        if !continues {
            self.streaming = None;
            let Some(id) = self.remote_id(folder, uid)? else {
                return Ok(None);
            };
            let att = section.to_string();
            let stream = match self.call(async |c| c.open_attachment(&id, &att).await) {
                Ok(s) => s,
                Err(CallErr::Text(e)) if status_of(&e) == Some(404) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            self.streaming =
                Some(Streaming { folder: folder.path.clone(), uid, section: section.to_string(), stream, buf: Vec::new(), pos: 0, ended: false });
        }
        let shared = self.shared;
        let s = self.streaming.as_mut().expect("opened above");
        let want = offset + len as u64;
        // Fill until the range is in hand or the response ended; bytes before `offset` (a resume)
        // are dropped as they arrive.
        let mut failed = None;
        while !s.ended && s.pos + (s.buf.len() as u64) < want {
            if let Err(f) = sync::not_closing(shared) {
                return Err(f);
            }
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
            return Err(graph_fail(self.scrub(e)));
        }
        let skip = offset.saturating_sub(s.pos).min(s.buf.len() as u64) as usize;
        s.buf.drain(..skip);
        s.pos += skip as u64;
        let take = (len as usize).min(s.buf.len());
        let out: Vec<u8> = s.buf.drain(..take).collect();
        s.pos += take as u64;
        Ok(Some(out))
    }

    /// Local uids for listed `rows` of `folder`: known ids keep theirs; new ones get the next,
    /// oldest first. A message a page boundary showed twice counts once.
    fn map_listed(&self, folder: &str, mut rows: Vec<GraphSynced>) -> Result<HashMap<u32, GraphSynced>, Fail> {
        let mut ids: HashSet<String> = HashSet::new();
        rows.retain(|r| ids.insert(r.message.id.clone()));
        let account = self.account.clone();
        let known = self.shared.read(|c| remote_ids::folder_map(c, &account, folder))?;
        let received = |r: &GraphSynced| r.message.received_date_time.as_deref().and_then(sync::rfc3339_ms).unwrap_or(0);
        let mut fresh: Vec<(i64, String)> = rows.iter().filter(|r| !known.contains_key(&r.message.id)).map(|r| (received(r), r.message.id.clone())).collect();
        fresh.sort();
        let mut uids = known;
        for chunk in fresh.chunks(BATCH) {
            let ids: Vec<String> = chunk.iter().map(|(_, id)| id.clone()).collect();
            let got = sync::write_for(self.shared, &account, |c| remote_ids::uids_for(c, &account, folder, &ids))?;
            uids.extend(ids.into_iter().zip(got));
        }
        Ok(rows.into_iter().filter_map(|r| uids.get(&r.message.id).map(|u| (*u, r))).collect())
    }

    /// Writes the mapping changes of an apply: `forget` drops `(folder, uid)`, `moved` maps a new
    /// id in `target`. Returns the `(old uid, new uid)` pairs.
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
            let ids: Vec<String> = chunk.iter().map(|(_, id)| id.clone()).collect();
            let new = sync::write_for(self.shared, account, |c| {
                for (old, _) in chunk {
                    remote_ids::forget(c, account, folder, *old)?;
                }
                remote_ids::uids_for(c, account, target, &ids)
            })?;
            pairs.extend(chunk.iter().map(|(old, _)| *old).zip(new));
        }
        Ok(pairs)
    }
}

impl Backend for GraphBackend<'_> {
    fn folders(&mut self) -> Result<Vec<FolderInfo>, Fail> {
        let top = self.call(async |c| c.list_folders().await)?;
        let mut out = Vec::new();
        let mut parents: Vec<String> = Vec::new();
        for f in &top {
            out.push(folder_info(f));
            if f.child_folder_count > 0 {
                parents.push(f.id.clone());
            }
        }
        let mut seen: HashSet<String> = top.iter().map(|f| f.id.clone()).collect();
        while let Some(parent) = parents.pop() {
            let kids = self.call(async |c| c.list_child_folders(&parent).await)?;
            for f in kids {
                if !seen.insert(f.id.clone()) {
                    continue;
                }
                if f.child_folder_count > 0 {
                    parents.push(f.id.clone());
                }
                out.push(folder_info(&f));
            }
        }
        Ok(out)
    }

    fn select(&mut self, folder: &str) -> Result<Selected, Fail> {
        self.selected = None;
        let (_, total) = self.counts(folder)?;
        Ok(Selected { uid_validity: GENERATION, uid_next: None, total })
    }

    fn window(&mut self, folder: &str, window_start_ms: i64) -> Result<Window, Fail> {
        let remote = remote_folder(folder).to_string();
        let since = timestamp(window_start_ms);
        let mut rows: Vec<GraphSynced> = Vec::new();
        let mut next: Option<String> = None;
        loop {
            sync::not_closing(self.shared)?;
            let link = next.clone();
            let (page, more) = self.call(async |c| c.list_since(&remote, &since, link.as_deref()).await)?;
            rows.extend(page);
            match more {
                Some(l) => next = Some(l),
                None => break,
            }
        }
        // The mappings as they were before the listing: only these can be judged by it (a move
        // replay maps into this folder meanwhile, and that mapping must stay).
        let account = self.account.clone();
        let before = self.shared.read(|c| remote_ids::folder_map(c, &account, folder))?;
        let listed = self.map_listed(folder, rows)?;
        // A mapping no longer listed and with no row (its row never landed, or the message moved
        // here from outside the window): nothing else would ever remove it. One with a row goes
        // with the row (`sync::delete_uids`); one a pending action names is the journal's.
        let rows_held: HashSet<u32> = self.shared.read(|c| {
            let mut st = c.prepare_cached("SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2")?;
            let rows = st.query_map((&account, folder), |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(|u| u as u32).collect())
        })?;
        let pending: HashSet<u32> = self.shared.read(|c| {
            let mut st = c.prepare_cached(crate::actions::PENDING_UIDS)?;
            let rows = st.query_map((&account, folder), |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(|u| u as u32).collect())
        })?;
        let orphans: Vec<u32> =
            before.values().copied().filter(|u| !listed.contains_key(u) && !rows_held.contains(u) && !pending.contains(u)).collect();
        self.remap(folder, &orphans, None, &[])?;
        let window: Vec<u32> = listed.keys().copied().collect();
        self.listed = Some((folder.to_string(), listed));
        let (unseen, _) = self.counts(folder)?;
        Ok(Window { uids: window, unseen })
    }

    fn headers(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<Header>, Fail> {
        let listed = self.listed(folder)?;
        Ok(uids.iter().filter_map(|uid| listed.get(uid).map(|row| header_of(*uid, row))).collect())
    }

    /// Graph's `$search` over the folder (one request, no paging), each hit under its local uid.
    fn search(&mut self, folder: &FolderRow, query: &str, limit: usize) -> Result<Vec<Header>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Err(Fail::Code(Code::Invalid, format!("generation of {} changed during search", folder.path)));
        }
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let remote = remote_folder(&folder.path).to_string();
        let found = self.call(async |c| c.search_folder(&remote, query, limit).await)?;
        let mapped = self.map_listed(&folder.path, found)?;
        let mut headers: Vec<Header> = mapped.iter().map(|(uid, row)| header_of(*uid, row)).collect();
        headers.sort_by_key(|h| std::cmp::Reverse((h.internal_date.clone(), h.uid)));
        Ok(headers)
    }

    fn flags(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<(u32, Flags)>, Fail> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let listed = self.listed(folder)?;
        Ok(uids
            .iter()
            .filter_map(|uid| listed.get(uid).map(|r| (*uid, Flags { seen: r.message.is_read == Some(true), flagged: r.flagged })))
            .collect())
    }

    fn parts(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<Vec<PartInfo>>, Fail> {
        let Some(id) = self.remote_id(folder, uid)? else {
            return Ok(None);
        };
        self.attachments(&id)
    }

    fn body(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<RawBody>, Fail> {
        let Some(id) = self.remote_id(folder, uid)? else {
            return Ok(None);
        };
        let got = match self.call(async |c| c.get_body(&id).await) {
            Ok(b) => b,
            Err(CallErr::Text(e)) if status_of(&e) == Some(404) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        // The body shows without its attachments rather than not at all, marked so it is not
        // cached as a message with none.
        let (parts, attachments_unknown) = match self.attachments(&id) {
            Ok(Some(parts)) => (parts, false),
            Ok(None) => return Ok(None),
            Err(Fail::Code(code, why)) if code != Code::NeedsAuth => {
                self.shared.log(&format!("[graph] {}: the message's attachments were not listed: {} {why}", self.account, code.as_str()));
                (Vec::new(), true)
            }
            Err(f) => return Err(f),
        };
        let (kind, content) = got.body.map(|b| (b.content_type.unwrap_or_default(), b.content.unwrap_or_default())).unwrap_or_default();
        let (html, text) = if kind.eq_ignore_ascii_case("html") {
            (Some(content), None)
        } else if content.is_empty() {
            (None, got.body_preview.filter(|p| !p.is_empty()))
        } else {
            (None, Some(content))
        };
        Ok(Some(RawBody { parts, html, text, attachments_unknown, truncated: false }))
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
        let mut gone: Vec<u32> = Vec::new();
        let mut present: Vec<(u32, String)> = Vec::new();
        for (uid, id) in self.remote_ids(path, uids)? {
            match id {
                Some(id) => present.push((uid, id)),
                None => gone.push(uid),
            }
        }
        if present.is_empty() {
            return Ok(ApplyOutcome::NonePresent);
        }
        let asked = present.len();
        match kind {
            Kind::Seen | Kind::Unseen | Kind::Flag | Kind::Unflag => {
                // Graph answers a stale id's mark with success (core reads its 404 as done).
                let on = kind.value() == 1;
                let read = matches!(kind, Kind::Seen | Kind::Unseen);
                for (_, id) in &present {
                    let out = if read {
                        self.call(async |c| c.set_read_status(id, on).await)
                    } else {
                        self.call(async |c| c.set_flag_status(id, on).await)
                    };
                    match out {
                        Ok(()) => {}
                        Err(CallErr::Fail(f)) => return Err(f),
                        Err(CallErr::Text(e)) => return refused_or_fail(e),
                    }
                }
                Ok(ApplyOutcome::Done { gone, moved: None, kept: Vec::new() })
            }
            Kind::Delete => {
                // Core's delete rule (`actions::policy`): Deleted Items is known by the `\Trash`
                // its well-known name stored, so no folder merely named like it qualifies.
                let account = self.account.clone();
                let special: Option<String> = self
                    .shared
                    .read(|c| {
                        c.query_row("SELECT special_use FROM folders WHERE account_id = ?1 AND path = ?2", (&account, path), |r| r.get(0))
                            .optional()
                    })?
                    .flatten();
                let permanent = delete_disposition(FolderRole::of(path, special.as_deref()), graph_trash_place(special.as_deref()), WithoutTrash::MoveToTrash)
                    == DeleteDisposition::Permanent;
                before_wire()?;
                let mut done: Vec<u32> = Vec::new();
                let mut failed = None;
                for (uid, id) in &present {
                    let out = if permanent {
                        self.call(async |c| c.permanent_delete(id).await)
                    } else {
                        self.call(async |c| c.move_message(id, "deleteditems").await).map(|_| ())
                    };
                    match out {
                        Ok(()) => done.push(*uid),
                        Err(CallErr::Text(e)) if status_of(&e) == Some(404) => gone.push(*uid),
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                // What went is recorded before any failure is reported.
                self.remap(path, &done, None, &[])?;
                match failed {
                    Some(CallErr::Fail(f)) => Err(f),
                    Some(CallErr::Text(e)) => refused_or_fail(e),
                    None if done.is_empty() && gone.len() >= asked => Ok(ApplyOutcome::NonePresent),
                    None => Ok(ApplyOutcome::Done { gone, moved: None, kept: Vec::new() }),
                }
            }
            Kind::Move => {
                let Some(target) = target else {
                    return Ok(ApplyOutcome::FolderGone);
                };
                let dest = remote_folder(target).to_string();
                before_wire()?;
                let mut moved: Vec<(u32, String)> = Vec::new();
                let mut failed = None;
                let mut target_gone = false;
                for (uid, id) in &present {
                    match self.call(async |c| c.move_message(id, &dest).await) {
                        Ok(new_id) => moved.push((*uid, new_id)),
                        Err(CallErr::Text(e)) if status_of(&e) == Some(404) => {
                            // The message, or the target: only Graph can say which.
                            match self.call(async |c| c.message_exists(id).await) {
                                Ok(false) => gone.push(*uid),
                                Ok(true) => {
                                    target_gone = true;
                                    break;
                                }
                                Err(e) => {
                                    failed = Some(e);
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                let pairs = self.remap(path, &[], Some(target), &moved)?;
                // Failed part way after some moved: what moved is recorded (its follow-ups follow
                // it), and the rest is retried.
                if let (Some(e), false) = (&failed, moved.is_empty()) {
                    let fail = match e {
                        CallErr::Fail(Fail::Code(code, why)) => Some((*code, why.clone())),
                        CallErr::Fail(_) => None,
                        CallErr::Text(t) => match refused_or_fail(t.clone()) {
                            Err(Fail::Code(code, why)) => Some((code, why)),
                            _ => None,
                        },
                    };
                    if let Some(error) = fail {
                        return Ok(ApplyOutcome::Partial { gone, moved: Moved { pairs, uid_validity: Some(GENERATION) }, error });
                    }
                }
                match failed {
                    Some(CallErr::Fail(f)) => Err(f),
                    Some(CallErr::Text(e)) => refused_or_fail(e),
                    None if target_gone && moved.is_empty() => Ok(ApplyOutcome::FolderGone),
                    None if moved.is_empty() && gone.len() >= asked => Ok(ApplyOutcome::NonePresent),
                    None => {
                        // The target went away part way: what did not move stays where it was.
                        let kept: Vec<u32> = if target_gone {
                            present.iter().map(|(u, _)| *u).filter(|u| !gone.contains(u) && !moved.iter().any(|(m, _)| m == u)).collect()
                        } else {
                            Vec::new()
                        };
                        Ok(ApplyOutcome::Done { gone, moved: Some(Moved { pairs, uid_validity: Some(GENERATION) }), kept })
                    }
                }
            }
        }
    }

    fn send(&mut self, email: &OutgoingEmail) -> Result<SendOutcome, SendFail> {
        let not_sent = SendFail::unsent;
        let mut refreshed = false;
        loop {
            let acct = match load_account(self.shared, &self.account) {
                Ok(Some(a)) => a,
                Ok(None) => return Err(not_sent(Fail::Gone, true)),
                Err(e) => return Err(not_sent(Fail::from(e), false)),
            };
            let cred = Credential { access: Some(self.token.clone()), ..Credential::default() };
            let config = crate::net::core_config(&acct, &cred).map_err(|e| not_sent(Fail::Code(Code::Invalid, e), true))?;
            let built = smtp::build_mime(&config, email).map_err(|e| not_sent(Fail::Code(Code::Invalid, self.scrub(e)), true))?;
            // Core's Graph send (`sendMail`, Bcc carried in the MIME since Graph reads recipients
            // from it). Graph files the Sent copy itself.
            match block_on(smtp::send_built_phased(&config, email, built)) {
                Ok(sent) => return Ok(SendOutcome { server_saved_sent: sent_copy_policy(&config, &sent) == SentCopy::ServerFiled, raw: sent.raw_rfc2822 }),
                Err(e) => {
                    let message = self.scrub(e.message);
                    let sign_in = message.contains(smtp::SIGN_IN_AGAIN);
                    if sign_in && e.phase == smtp::SendPhase::NotSent && !refreshed {
                        // A refused token: nothing went out. One refresh, one more try.
                        refreshed = true;
                        match crate::oauth::access_token_after_refusal(self.shared, &self.account, &self.token) {
                            Ok(t) => {
                                self.set_token(t);
                                continue;
                            }
                            Err(f) => return Err(not_sent(f, true)),
                        }
                    }
                    let verdict = classify_failure(e.phase, e.permanent, &message);
                    let fail = if sign_in { Fail::Code(Code::AuthFailed, message) } else { Fail::from(message) };
                    return Err(SendFail { fail, verdict });
                }
            }
        }
    }

    fn file_sent(&mut self, _sent: &SendOutcome) -> Result<(), Fail> {
        // Graph's sendMail filed it in Sent Items.
        Ok(())
    }

    /// One `$top=1` request instead of relisting the 90-day window: news when the folder's newest
    /// message has no local uid yet. A flag change elsewhere is not news here (a background run
    /// only looks for new mail).
    fn has_news(&mut self, folder: &FolderRow) -> Result<bool, Fail> {
        let remote = remote_folder(&folder.path).to_string();
        match self.call(async |c| c.newest_in(&remote).await)? {
            None => Ok(false),
            Some((id, _)) => Ok(!self.is_listed(&folder.path, &id)?),
        }
    }

    /// What was received since the newest message held (a second early, for messages of the
    /// same second), oldest first, page by page (core `list_since_oldest_first`): usually one
    /// small request, never the window. When the next page would not come back before the pass's
    /// deadline (judged by the slowest page so far), the listing stops with the pages it has,
    /// which are the oldest arrivals: the caller inserts them and the next pass resumes after
    /// them. The pages are mapped in one go, so local uids follow arrival.
    fn arrivals(&mut self, folder: &FolderRow, _newest_uid: u32, newest_ms: i64) -> Result<Option<Arrivals>, Fail> {
        if folder.uid_validity.is_some_and(|v| v != GENERATION) {
            return Ok(None);
        }
        let remote = remote_folder(&folder.path).to_string();
        let since = timestamp((newest_ms - 1000).max(sync::window_start_ms(crate::compose::now_ms())));
        let mut rows: Vec<GraphSynced> = Vec::new();
        let mut next: Option<String> = None;
        let mut slowest = Duration::ZERO;
        let complete = loop {
            let link = next.clone();
            let asked = Instant::now();
            let (page, more) = self.call(async |c| c.list_since_oldest_first(&remote, &since, link.as_deref()).await)?;
            slowest = slowest.max(asked.elapsed());
            rows.extend(page);
            match more {
                Some(l) => {
                    if self.deadline.is_some_and(|d| Instant::now() + slowest >= d) {
                        break false;
                    }
                    next = Some(l);
                }
                None => break true,
            }
        };
        let listed = self.map_listed(&folder.path, rows)?;
        let received = |r: &GraphSynced| r.message.received_date_time.as_deref().and_then(sync::rfc3339_ms).unwrap_or(0);
        let mut order: Vec<(i64, u32)> = listed.iter().map(|(uid, r)| (received(r), *uid)).collect();
        order.sort_unstable();
        self.listed = Some((folder.path.clone(), listed));
        Ok(Some(Arrivals { uids: order.into_iter().map(|(_, uid)| uid).collect(), complete }))
    }

    fn set_deadline(&mut self, deadline: Option<Instant>) {
        self.deadline = deadline;
    }

    fn wait_for_change(&mut self, folder: &FolderRow, watch: &Watch) -> Result<Change, Fail> {
        // A throttle's wait inside a call ends on the stop too.
        self.stop = Some(Arc::clone(&watch.stop));
        let out = self.poll_newest(folder, watch);
        self.stop = None;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_read_from_core_error_text() {
        assert_eq!(status_of("Graph move_message failed (404) {\"error\":{}}"), Some(404));
        assert_eq!(status_of("Graph list_since failed (429:retry_after=3) x"), Some(429));
        assert_eq!(status_of("Graph list_since request failed: error sending request"), None);
    }

    /// A folder Graph refuses (403) is no sign-in problem: a new sign-in would not fix it.
    #[test]
    fn a_403_is_not_an_auth_failure() {
        assert!(matches!(graph_fail("Graph get_folder failed (403) {\"error\":{\"code\":\"ErrorAccessDenied\"}}".into()), Fail::Code(Code::Invalid, _)));
        assert!(matches!(graph_fail("Graph get_folder failed (401) expired".into()), Fail::Code(Code::AuthFailed, _)));
    }

    #[test]
    fn only_a_plain_4xx_is_a_refusal() {
        assert!(matches!(refused_or_fail("Graph set_read_status failed (400) bad".into()), Ok(ApplyOutcome::Refused(_))));
        assert!(matches!(refused_or_fail("Graph set_read_status failed (403) denied".into()), Ok(ApplyOutcome::Refused(_))));
        for transient in [
            "Graph set_read_status failed (429:retry_after=30) slow down",
            "Graph set_read_status failed (503) busy",
            "Graph set_read_status request failed: error sending request",
        ] {
            assert!(refused_or_fail(transient.into()).is_err(), "{transient}");
        }
    }

    #[test]
    fn the_inbox_is_asked_for_by_its_well_known_name() {
        assert_eq!(remote_folder("INBOX"), "inbox");
        assert_eq!(remote_folder("Inbox"), "inbox");
        assert_eq!(remote_folder("AAMkFolder="), "AAMkFolder=");
        assert_eq!(timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(1_767_225_600_000 + 3_661_000), "2026-01-01T01:01:01Z");
    }
}
