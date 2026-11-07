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
//! attachment id. A tapped attachment is streamed whole (Graph serves no byte ranges) into
//! `<cache>/graph` (`download_attachment_to`, counted in the attachment cache's cap and LRU), and
//! the attachment worker's range reads come from that file; it goes once the last range was read.
//! A download that resumes after its staged file was evicted starts that file again from 0.
//!
//! Every request goes through [`GraphBackend::call`]: a 401 gets one token refresh and one retry
//! (a second 401 is handled as `ImapBackend::open` handles a fresh token refused), and a 429 waits
//! the server's `Retry-After` (capped) and retries, a few times, as a transient condition and
//! never as an error. `open` makes no request.

use super::{ApplyOutcome, Backend, BeforeWire, Change, FolderInfo, FolderRow, Flags, Header, Moved, RawBody, Selected, SendFail, SendOutcome, StopFlag, Window};
use crate::accounts::{load_account, map_error, Code};
use crate::actions::Kind;
use crate::db::Shared;
use crate::net::block_on;
use crate::remote_ids;
use crate::secrets::Credential;
use crate::sync::{self, Fail};
use mailvault_core::graph::{GraphAttachmentInfo, GraphClient, GraphMailFolder, GraphSynced};
use mailvault_core::imap::PartInfo;
use mailvault_core::smtp::{self, OutgoingEmail};
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

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
        Some(401 | 403) => Code::AuthFailed,
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

/// `2026-01-05T00:00:00Z` for epoch ms.
fn timestamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = sync::civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
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
/// (`binary`, nothing to undo).
fn part_info(a: GraphAttachmentInfo) -> PartInfo {
    PartInfo {
        section: a.id,
        mime: a.content_type.map(|t| t.to_ascii_lowercase()).filter(|t| !t.is_empty()).unwrap_or_else(|| "application/octet-stream".into()),
        filename: a.name.filter(|n| !n.trim().is_empty()),
        size: u32::try_from(a.size.max(0)).unwrap_or(u32::MAX),
        encoding: "binary".into(),
        charset: None,
        content_id: a.content_id.map(|id| id.trim().trim_start_matches('<').trim_end_matches('>').to_string()).filter(|id| !id.is_empty()),
        disposition: Some(if a.is_inline { "inline" } else { "attachment" }.to_string()),
    }
}

/// Bytes `offset..offset + len` of `file` (fewer at its end) and the file's length.
fn read_range(file: &std::path::Path, offset: u64, len: u32) -> std::io::Result<(Vec<u8>, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file)?;
    let size = f.metadata()?.len();
    let want = size.saturating_sub(offset).min(len as u64);
    let mut buf = Vec::with_capacity(want as usize);
    if want > 0 {
        f.seek(SeekFrom::Start(offset))?;
        f.take(want).read_to_end(&mut buf)?;
    }
    Ok((buf, size))
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

/// The attachment `part_range` is reading: its message, section and staged file.
struct Staged {
    folder: String,
    uid: u32,
    section: String,
    file: PathBuf,
    /// The file's length once the last range was read (the file is gone then; a probe past the
    /// end needs no download).
    ended: Option<u64>,
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
    /// The attachment `part_range` last read.
    staged: Option<Staged>,
    /// A request went through since `open`.
    worked: bool,
}

impl<'a> GraphBackend<'a> {
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
            staged: None,
            worked: false,
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
        self.secrets.iter().filter(|s| !s.is_empty()).fold(text, |t, s| t.replace(s.as_str(), "***"))
    }

    /// Waits `wait` in slices of at most a second, stopping early when the engine closes.
    fn pause(&self, wait: Duration) -> Result<(), CallErr> {
        let mut left = wait;
        while !left.is_zero() {
            sync::not_closing(self.shared).map_err(CallErr::Fail)?;
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
                        crate::oauth::fresh_token_refused(self.shared, &self.account).unwrap_or(Fail::Code(Code::AuthFailed, why)),
                    ));
                }
                refreshed = true;
                let token = crate::oauth::access_token_after_refusal(self.shared, &self.account, &self.token).map_err(CallErr::Fail)?;
                self.set_token(token);
                continue;
            }
            if GraphClient::is_rate_limited(&e) && waits < THROTTLE_WAITS {
                waits += 1;
                let secs = GraphClient::retry_after_from_error(&e).unwrap_or(DEFAULT_RETRY_AFTER).clamp(1, MAX_RETRY_AFTER);
                self.pause(Duration::from_secs(secs))?;
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

    /// Raw octets `offset..offset + len` of attachment `section`, from its staged file, staged
    /// first when it is not (a whole download). `None` when the message or attachment is gone.
    fn read(&mut self, folder: &FolderRow, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, Fail> {
        let same = |s: &Staged| s.folder == folder.path && s.uid == uid && s.section == section;
        if let Some(end) = self.staged.as_ref().filter(|s| same(s)).and_then(|s| s.ended) {
            if offset >= end {
                return Ok(Some(Vec::new()));
            }
        }
        for _ in 0..2 {
            let file = match self.staged.as_ref().filter(|s| same(s) && s.ended.is_none() && s.file.is_file()) {
                Some(s) => s.file.clone(),
                None => {
                    self.staged = None;
                    let Some(id) = self.remote_id(folder, uid)? else {
                        return Ok(None);
                    };
                    let file = self.shared.stage.path(&self.account, &id, section);
                    if file.is_file() {
                        self.shared.stage.touch(&file);
                    } else {
                        let target = file.clone();
                        match self.call(async |c| c.download_attachment_to(&id, section, &target).await) {
                            Ok(_) => self.shared.stage.written(&file),
                            Err(CallErr::Text(e)) if status_of(&e) == Some(404) => return Ok(None),
                            Err(e) => return Err(e.into()),
                        }
                    }
                    self.staged = Some(Staged { folder: folder.path.clone(), uid, section: section.to_string(), file: file.clone(), ended: None });
                    file
                }
            };
            match read_range(&file, offset, len) {
                Ok((bytes, file_len)) => {
                    if bytes.len() < len as usize {
                        // The last range: the attachment cache has it now.
                        let _ = std::fs::remove_file(&file);
                        if let Some(s) = self.staged.as_mut() {
                            s.ended = Some(file_len);
                        }
                    }
                    return Ok(Some(bytes));
                }
                // Evicted meanwhile: staged again from 0.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.staged = None,
                Err(e) => return Err(Fail::Code(Code::Invalid, format!("staged attachment: {e}"))),
            }
        }
        Err(Fail::Code(Code::Invalid, "the staged attachment went away twice".into()))
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
        // A message a page boundary showed twice counts once.
        let mut ids: HashSet<String> = HashSet::new();
        rows.retain(|r| ids.insert(r.message.id.clone()));

        // Local uids: known ids keep theirs; new ones get the next, oldest first.
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
        let listed: HashMap<u32, GraphSynced> = rows.into_iter().filter_map(|r| uids.get(&r.message.id).map(|u| (*u, r))).collect();
        let window: Vec<u32> = listed.keys().copied().collect();
        self.listed = Some((folder.to_string(), listed));
        let (unseen, _) = self.counts(folder)?;
        Ok(Window { uids: window, unseen })
    }

    fn headers(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<Header>, Fail> {
        let listed = self.listed(folder)?;
        Ok(uids
            .iter()
            .filter_map(|uid| {
                let row = listed.get(uid)?;
                let mut h = row.message.to_email_header(*uid);
                if row.flagged {
                    h.flags.push("\\Flagged".into());
                }
                Some(h)
            })
            .collect())
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
        let Some(parts) = self.attachments(&id)? else {
            return Ok(None);
        };
        let (kind, content) = got.body.map(|b| (b.content_type.unwrap_or_default(), b.content.unwrap_or_default())).unwrap_or_default();
        let (html, text) = if kind.eq_ignore_ascii_case("html") {
            (Some(content), None)
        } else if content.is_empty() {
            (None, got.body_preview.filter(|p| !p.is_empty()))
        } else {
            (None, Some(content))
        };
        Ok(Some(RawBody { parts, html, text }))
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
                // In Deleted Items already: a delete is permanent. Its `\Trash` comes only from
                // Graph's well-known name, so no folder merely named like it qualifies.
                let account = self.account.clone();
                let special: Option<String> = self
                    .shared
                    .read(|c| {
                        c.query_row("SELECT special_use FROM folders WHERE account_id = ?1 AND path = ?2", (&account, path), |r| r.get(0))
                            .optional()
                    })?
                    .flatten();
                let permanent = special.as_deref() == Some("\\Trash");
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
        let not_sent = |fail: Fail, terminal: bool| SendFail { fail, may_have_sent: false, terminal };
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
                Ok(sent) => return Ok(SendOutcome { raw: sent.raw_rfc2822, server_saved_sent: true }),
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
                    let terminal = e.permanent || smtp::is_terminal_send_error(&message);
                    let fail = if sign_in { Fail::Code(Code::AuthFailed, message) } else { Fail::from(message) };
                    return Err(SendFail { fail, may_have_sent: e.phase == smtp::SendPhase::MayHaveSent, terminal });
                }
            }
        }
    }

    fn file_sent(&mut self, _sent: &SendOutcome) -> Result<(), Fail> {
        // Graph's sendMail filed it in Sent Items.
        Ok(())
    }

    fn wait_for_change(&mut self, _folder: &FolderRow, _stop: &StopFlag) -> Result<Change, Fail> {
        Err(Fail::unsupported("wait for change"))
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
