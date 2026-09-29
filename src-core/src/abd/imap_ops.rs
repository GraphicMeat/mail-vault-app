//! `ServerOps` over IMAP: the mail-server half of an Archive & delete job.
//!
//! One background session is held for the job (`get_background`), used for a
//! command at a time and put back after each success. Any error discards it
//! (a failed command can leave unread bytes that the next command would take
//! for its own reply), and the next call connects afresh, which is how a
//! dropped connection recovers. A read-only command whose socket turned out
//! dead is asked once more on a brand-new connection; a mutation never is,
//! because a MOVE whose reply was lost may have been applied.
//!
//! Errors are classified by `abd::throttle` (Gmail's bandwidth wording, the
//! `[THROTTLED]` refusal, too many connections, a refused sign-in). A failure to
//! connect that is none of those (DNS, TCP, TLS) reads as `Offline`.
//!
//! Nothing here sends a plain `EXPUNGE`, nothing CREATEs a folder, and a
//! server with neither MOVE nor UIDPLUS is refused before any delete goes out.

use super::ops::{
    Caps, Fetched, FolderInfo, ListPage, ListedMsg, MoveResult, OpsError, ServerOps,
};
use super::plan::PreviewListing;
use super::state::{FolderRole, Provider};
use crate::imap::abd_cmds::{self, ListedRow};
use crate::imap::pool::{self, PooledSessionGuard};
use crate::imap::{self, ImapConfig, ImapPool, MailboxInfo};
use std::collections::HashMap;
use std::sync::Arc;

/// Rows per `UID FETCH` of a listing.
pub const LIST_PAGE: usize = 2000;
/// A failed listing chunk is asked again this many times before it is halved.
const CHUNK_RETRIES: u32 = 2;
/// A chunk is never halved below this many rows.
const MIN_CHUNK: usize = 50;
/// Uids per `UID SEARCH UID <set>` in `present`.
const PRESENT_CHUNK: usize = 1000;

/// The uid list of the folder being listed, read once under `validity`.
struct ListCache {
    path: String,
    validity: Option<u32>,
    uids: Vec<u32>,
}

pub struct ImapOps {
    pool: Arc<ImapPool>,
    config: ImapConfig,
    guard: Option<PooledSessionGuard>,
    caps: Option<Caps>,
    /// `Some(b)` overrides the host check for Gmail (the mock binds 127.0.0.1).
    gmail_host: Option<bool>,
    provider: Provider,
    folder_list: Option<Vec<FolderInfo>>,
    list_cache: Option<ListCache>,
}

/// A connect error that is none of the server's own answers is the network's.
fn connect_error(e: &str) -> OpsError {
    match OpsError::from_imap(e) {
        OpsError::Other(t) => {
            let l = t.to_ascii_lowercase();
            let network = l.contains("dns resolve failed")
                || l.contains("no ipv4 address")
                || l.contains("tcp connect to")
                || l.contains("tls handshake")
                || l.contains("failed to read server greeting")
                || l.contains("starttls");
            if network {
                OpsError::Offline(t)
            } else {
                OpsError::Other(t)
            }
        }
        other => other,
    }
}

/// Run `$body` (which may use `?` and `.await`, and ends in a
/// `Result<_, String>`) on the held session `$s`. Puts the session back on
/// success, discards it on error, and with `$retry` asks a read-only command
/// once more on a fresh connection when the socket turned out dead.
macro_rules! with_session {
    ($this:ident, $retry:expr, |$s:ident| $body:expr) => {{
        let mut attempt = 0u32;
        loop {
            let mut g = if attempt == 0 { $this.take().await? } else { $this.take_fresh().await? };
            let r = async {
                let $s = &mut g.session;
                $body
            }
            .await;
            match r {
                Ok(v) => {
                    $this.guard = Some(g);
                    break Ok(v);
                }
                Err(e) => {
                    let e: String = e;
                    $this.pool.discard(&$this.config, g).await;
                    if $retry && attempt == 0 && pool::is_connection_lost(&e) {
                        attempt += 1;
                        continue;
                    }
                    break Err(OpsError::from_imap(&e));
                }
            }
        }
    }};
}

impl ImapOps {
    pub fn new(pool: Arc<ImapPool>, config: ImapConfig) -> Self {
        ImapOps {
            pool,
            config,
            guard: None,
            caps: None,
            gmail_host: None,
            provider: Provider::Imap,
            folder_list: None,
            list_cache: None,
        }
    }

    /// Replace the credentials (a refreshed OAuth token). The held session is
    /// already signed in and stays; the next connect uses the new config.
    pub fn set_config(&mut self, c: ImapConfig) {
        self.config = c;
    }

    pub fn config(&self) -> &ImapConfig {
        &self.config
    }

    /// Decide Gmail by this instead of the host (tests: the mock is 127.0.0.1).
    pub fn with_gmail_host(mut self, gmail: bool) -> Self {
        self.gmail_host = Some(gmail);
        self
    }

    /// Whether the host counts as Gmail: the override, else the same host rule
    /// the daily limit uses (`transfer_limits::default_limits`).
    pub fn is_gmail_host(&self) -> bool {
        self.gmail_host
            .unwrap_or_else(|| crate::transfer_limits::default_limits(&self.config.host).0.is_some())
    }

    /// Probe the server and the folder list, and settle the provider. Cheap to
    /// call again: the folder list is read afresh, the capabilities are kept.
    pub async fn detect(&mut self) -> Result<Provider, OpsError> {
        self.caps().await?;
        self.folder_list = None;
        self.folders().await?;
        Ok(self.provider)
    }

    async fn take(&mut self) -> Result<PooledSessionGuard, OpsError> {
        if let Some(g) = self.guard.take() {
            return Ok(g);
        }
        let got = crate::net_activity::with_purpose("backup", self.pool.get_background(&self.config)).await;
        got.map_err(|e| connect_error(&e))
    }

    /// A brand-new connection, for the second try of a read after a dead socket.
    async fn take_fresh(&mut self) -> Result<PooledSessionGuard, OpsError> {
        let got = crate::net_activity::with_purpose("backup", self.pool.get_background_fresh(&self.config)).await;
        got.map_err(|e| connect_error(&e))
    }

    /// Split a folder listing into roles. Gmail's All Mail is a role only in
    /// Gmail mode: any other server that declares `\All` keeps it as a folder.
    fn roles(&self, boxes: &[MailboxInfo], gmail: bool) -> Vec<FolderInfo> {
        let trash = abd_cmds::resolve_trash(boxes);
        let mut out: Vec<FolderInfo> = boxes
            .iter()
            .map(|b| {
                let role = if trash.as_deref() == Some(b.path.as_str()) {
                    FolderRole::Trash
                } else if gmail && abd_cmds::has_attr(&b.flags, "All") {
                    FolderRole::AllMail
                } else if abd_cmds::has_attr(&b.flags, "Junk") || abd_cmds::has_attr(&b.flags, "Spam") {
                    FolderRole::Spam
                } else {
                    FolderRole::Normal
                };
                FolderInfo {
                    path: b.path.clone(),
                    name: b.name.clone(),
                    role,
                    graph_id: None,
                    selectable: !b.noselect,
                }
            })
            .collect();
        // INBOX first, the rest in LIST order.
        out.sort_by_key(|f| if f.path.eq_ignore_ascii_case("INBOX") { 0 } else { 1 });
        out
    }

    /// Where a listing chunk fails, ask again, then halve it (down to 50 rows).
    /// The failing session is discarded each time (`with_session!`).
    async fn rows_resilient(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<ListedRow>, OpsError> {
        let gmail = self.provider == Provider::Gmail;
        let labels = gmail && folder.role == FolderRole::AllMail;
        let path = folder.path.clone();
        let mut out: Vec<ListedRow> = Vec::with_capacity(uids.len());
        let mut work: Vec<Vec<u32>> = vec![uids.to_vec()];
        while let Some(chunk) = work.pop() {
            let mut tries = 0u32;
            loop {
                let r: Result<Vec<ListedRow>, OpsError> = with_session!(self, true, |s| {
                    imap::bounded("abd list", 300, abd_cmds::list_rows(s, &path, &chunk, gmail, labels)).await
                });
                match r {
                    Ok(rows) => {
                        out.extend(rows);
                        break;
                    }
                    Err(OpsError::Other(t)) if t.contains("page incomplete") => {
                        if tries < CHUNK_RETRIES {
                            tries += 1;
                            continue;
                        }
                        if chunk.len() > MIN_CHUNK {
                            let (left, right) = chunk.split_at(chunk.len() / 2);
                            work.push(right.to_vec());
                            work.push(left.to_vec());
                            break;
                        }
                        return Err(OpsError::Other(t));
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        out.sort_unstable_by_key(|r| r.uid);
        out.dedup_by_key(|r| r.uid);
        Ok(out)
    }

    /// The uids in `folder` that carry Gmail's `X-GM-MSGID`, or, failing that,
    /// exactly this Message-ID. `UID SEARCH X-GM-MSGID` is asked only when the
    /// server advertises `X-GM-EXT-1`. The Message-ID fallback is the recovery
    /// path when a folder was rebuilt under a job.
    pub async fn locate(
        &mut self,
        folder: &FolderInfo,
        gm_msgid: Option<u64>,
        message_id: Option<&str>,
    ) -> Result<Vec<u32>, OpsError> {
        let ext = self.caps().await?.gmail_ext;
        let path = folder.path.clone();
        if let (Some(g), true) = (gm_msgid, ext) {
            let found: Vec<u32> = with_session!(self, true, |s| {
                imap::bounded("abd locate", 120, abd_cmds::uid_search(s, &path, &format!("X-GM-MSGID {}", g))).await
            })?;
            if !found.is_empty() {
                return Ok(found);
            }
        }
        match message_id {
            Some(id) => self.uids_by_message_id(folder, id).await,
            None => Ok(Vec::new()),
        }
    }

    /// The uids in `folder` whose Message-ID is exactly `message_id`.
    pub async fn uids_by_message_id(&mut self, folder: &FolderInfo, message_id: &str) -> Result<Vec<u32>, OpsError> {
        let path = folder.path.clone();
        let id = message_id.to_string();
        with_session!(self, true, |s| {
            imap::bounded("abd message-id search", 120, abd_cmds::uids_by_message_id(s, &path, &id)).await
        })
    }
}

impl ServerOps for ImapOps {
    fn provider(&self) -> Provider {
        self.provider
    }

    async fn caps(&mut self) -> Result<Caps, OpsError> {
        if let Some(c) = self.caps {
            return Ok(c);
        }
        let c: Caps = with_session!(self, true, |s| imap::bounded("CAPABILITY", 60, abd_cmds::capabilities(s)).await)?;
        self.caps = Some(c);
        Ok(c)
    }

    async fn folders(&mut self) -> Result<Vec<FolderInfo>, OpsError> {
        let caps = self.caps().await?;
        let boxes: Vec<MailboxInfo> =
            with_session!(self, true, |s| imap::bounded("LIST", 120, imap::list_mailboxes(s)).await)?;
        let gmail = self.is_gmail_host()
            && caps.gmail_ext
            && boxes.iter().any(|b| !b.noselect && abd_cmds::has_attr(&b.flags, "All"));
        self.provider = if gmail { Provider::Gmail } else { Provider::Imap };
        let list = self.roles(&boxes, gmail);
        self.folder_list = Some(list.clone());
        Ok(list)
    }

    async fn trash(&mut self) -> Result<Option<FolderInfo>, OpsError> {
        if self.folder_list.is_none() {
            self.folders().await?;
        }
        Ok(self
            .folder_list
            .as_ref()
            .and_then(|l| l.iter().find(|f| f.role == FolderRole::Trash).cloned()))
    }

    async fn list_page(&mut self, folder: &FolderInfo, cursor: Option<String>) -> Result<ListPage, OpsError> {
        let after: u32 = match &cursor {
            Some(c) => c.parse().map_err(|_| OpsError::Other(format!("bad listing cursor {c:?}")))?,
            None => 0,
        };
        let path = folder.path.clone();
        let have = self.list_cache.as_ref().is_some_and(|c| c.path == folder.path);
        if cursor.is_none() || !have {
            let (validity, uids): (Option<u32>, Vec<u32>) = with_session!(self, true, |s| {
                imap::bounded("abd list uids", 600, abd_cmds::list_uids(s, &path)).await
            })?;
            self.list_cache = Some(ListCache { path: folder.path.clone(), validity, uids });
        } else {
            // A later page: the uid list is the one read on the first page, so
            // the folder must still be the same generation.
            let now: Option<u32> = with_session!(self, true, |s| {
                imap::bounded("abd uidvalidity", 60, abd_cmds::uid_validity(s, &path)).await
            })?;
            let before = self.list_cache.as_ref().and_then(|c| c.validity);
            if now != before {
                self.list_cache = None;
                return Err(OpsError::Other(format!(
                    "UIDVALIDITY of {} changed while it was being listed ({:?} to {:?})",
                    folder.path, before, now
                )));
            }
        }
        let (validity, chunk, more) = {
            let c = self.list_cache.as_ref().expect("list cache was just filled");
            let start = c.uids.partition_point(|u| *u <= after);
            let end = (start + LIST_PAGE).min(c.uids.len());
            (c.validity, c.uids[start..end].to_vec(), end < c.uids.len())
        };
        let rows = self.rows_resilient(folder, &chunk).await?;
        let gmail_all = self.provider == Provider::Gmail && folder.role == FolderRole::AllMail;
        let mut items = Vec::with_capacity(rows.len());
        for r in rows {
            let Some(ms) = r.internal_ms else {
                // A missing date must never become 1970, which "Older than 2
                // years" would select. The page fails; nothing is guessed.
                return Err(OpsError::Other(format!(
                    "the server sent no INTERNALDATE for UID {} in {}",
                    r.uid, folder.path
                )));
            };
            items.push(ListedMsg {
                uid: r.uid,
                internal_ms: ms,
                size: r.size,
                gm_msgid: r.gm_msgid,
                unlabelled: if gmail_all {
                    Some(r.labels.as_deref().map(abd_cmds::is_unlabelled).unwrap_or(false))
                } else {
                    None
                },
                graph_id: None,
                message_id: None,
            });
        }
        let next = if more { chunk.last().map(|u| u.to_string()) } else { None };
        Ok(ListPage { uid_validity: validity, items, next })
    }

    async fn message_ids(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<(u32, Option<String>)>, OpsError> {
        let path = folder.path.clone();
        let uids = uids.to_vec();
        with_session!(self, true, |s| {
            imap::bounded("abd message-ids", 300, abd_cmds::message_ids(s, &path, &uids)).await
        })
    }

    async fn uid_validity(&mut self, folder: &FolderInfo) -> Result<Option<u32>, OpsError> {
        let path = folder.path.clone();
        with_session!(self, true, |s| {
            imap::bounded("abd uidvalidity", 60, abd_cmds::uid_validity(s, &path)).await
        })
    }

    async fn fetch(&mut self, folder: &FolderInfo, msg: &ListedMsg) -> Result<Fetched, OpsError> {
        let path = folder.path.clone();
        let uid = msg.uid;
        let got: Option<abd_cmds::RawMessage> = with_session!(self, true, |s| {
            imap::bounded(&format!("UID FETCH {}", uid), 60, abd_cmds::fetch_raw(s, &path, uid)).await
        })?;
        let m = got.ok_or(OpsError::Gone)?;
        let message_id = crate::maildir::message_id_in(&m.raw);
        Ok(Fetched { raw: m.raw, flags: m.flags, internal_ms: m.internal_ms, message_id })
    }

    async fn present(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<u32>, OpsError> {
        let path = folder.path.clone();
        let mut out: Vec<u32> = Vec::new();
        for chunk in uids.chunks(PRESENT_CHUNK) {
            let criteria = format!("UID {}", imap::compress_uid_ranges(chunk));
            let found: Vec<u32> = with_session!(self, true, |s| {
                imap::bounded("abd present", 120, abd_cmds::uid_search(s, &path, &criteria)).await
            })?;
            out.extend(found);
        }
        out.sort_unstable();
        out.dedup();
        Ok(out)
    }

    async fn move_to_trash(
        &mut self,
        folder: &FolderInfo,
        msgs: &[ListedMsg],
        trash: &FolderInfo,
    ) -> Result<MoveResult, OpsError> {
        let caps = self.caps().await?;
        if !caps.move_cmd && !caps.uidplus {
            return Err(OpsError::Other("This server has neither MOVE nor UIDPLUS: refusing to delete".to_string()));
        }
        let uids: Vec<u32> = msgs.iter().map(|m| m.uid).collect();
        if uids.is_empty() {
            return Ok(MoveResult::default());
        }
        let (src, dst) = (folder.path.clone(), trash.path.clone());
        let cu: Option<abd_cmds::CopyUid> = with_session!(self, false, |s| {
            imap::bounded(
                "abd move",
                600,
                abd_cmds::move_uids_scoped(s, &src, &dst, &uids, caps.move_cmd, caps.uidplus),
            )
            .await
        })?;
        if let Some(cu) = cu.filter(|c| !c.src.is_empty()) {
            let asked: std::collections::HashSet<u32> = uids.iter().copied().collect();
            let pairs: HashMap<u32, u32> = cu
                .src
                .iter()
                .copied()
                .zip(cu.dst.iter().copied())
                .filter(|(s, _)| asked.contains(s))
                .collect();
            let moved: Vec<u32> = cu.src.iter().copied().filter(|u| asked.contains(u)).collect();
            let complete = cu.src.len() == cu.dst.len() && moved.iter().all(|u| pairs.contains_key(u));
            let trash_uids = complete.then(|| moved.iter().map(|u| pairs[u]).collect::<Vec<u32>>());
            return Ok(MoveResult { moved, trash_uids, trash_validity: cu.validity, graph_new_ids: None });
        }
        // No COPYUID (no UIDPLUS): ask the server which of them are gone.
        let criteria = format!("UID {}", imap::compress_uid_ranges(&uids));
        let still: Vec<u32> = with_session!(self, true, |s| {
            imap::bounded("abd moved?", 120, abd_cmds::uid_search(s, &src, &criteria)).await
        })?;
        let moved: Vec<u32> = uids.iter().copied().filter(|u| !still.contains(u)).collect();
        Ok(MoveResult { moved, trash_uids: None, trash_validity: None, graph_new_ids: None })
    }

    async fn expunge_exact(
        &mut self,
        trash: &FolderInfo,
        trash_uids: &[u32],
        expect: &[(u32, String)],
    ) -> Result<Vec<u32>, OpsError> {
        let caps = self.caps().await?;
        if !caps.uidplus {
            return Err(OpsError::Other("UIDPLUS is required for an exact expunge".to_string()));
        }
        // Only what is still the message the job moved: re-read every Message-ID.
        let read = self.message_ids(trash, trash_uids).await?;
        let want: HashMap<u32, String> =
            expect.iter().map(|(u, id)| (*u, crate::maildir::normalize_message_id(id))).collect();
        let mut matched: Vec<u32> = read
            .into_iter()
            .filter(|(u, id)| {
                let have = id.as_deref().map(crate::maildir::normalize_message_id);
                have.is_some() && have.as_ref() == want.get(u) && trash_uids.contains(u)
            })
            .map(|(u, _)| u)
            .collect();
        matched.sort_unstable();
        matched.dedup();
        if matched.is_empty() {
            return Ok(matched);
        }
        let path = trash.path.clone();
        let set = matched.clone();
        with_session!(self, false, |s| {
            imap::bounded("abd expunge", 600, abd_cmds::expunge_exact(s, &path, &set, true)).await
        })?;
        Ok(matched)
    }

    async fn find_in_trash(&mut self, trash: &FolderInfo, message_ids: &[String]) -> Result<Vec<(String, u32)>, OpsError> {
        let path = trash.path.clone();
        let ids = message_ids.to_vec();
        with_session!(self, true, |s| {
            let mut out: Vec<(String, u32)> = Vec::new();
            for id in &ids {
                let hits = imap::bounded("abd find in trash", 120, abd_cmds::uids_by_message_id(s, &path, id)).await?;
                for u in hits {
                    out.push((id.clone(), u));
                }
            }
            Ok::<_, String>(out)
        })
    }

    async fn release(&mut self) {
        if let Some(g) = self.guard.take() {
            self.pool.return_background(&self.config, g).await;
        }
    }

    fn uncounted_bytes(&mut self) -> u64 {
        0
    }
}

/// List an account for the dry run: capabilities, folders, Trash and every
/// selectable folder's rows, in pages. Gmail's All Mail goes to `all_mail` only
/// (with its labels, ticked or not); every other folder, Trash and Spam
/// included, is in `folders`. `progress(folder, rows_so_far)` is called after
/// each page.
pub async fn build_preview<S: ServerOps>(
    ops: &mut S,
    preview_id: &str,
    now_ms: i64,
    progress: &mut dyn FnMut(&str, usize),
) -> Result<PreviewListing, OpsError> {
    let caps = ops.caps().await?;
    let list = ops.folders().await?;
    let provider = ops.provider();
    let trash = ops.trash().await?;
    let mut folders: Vec<(FolderInfo, Option<u32>, Vec<ListedMsg>)> = Vec::new();
    let mut all_mail: Option<(FolderInfo, u32, Vec<ListedMsg>)> = None;
    for f in list.into_iter().filter(|f| f.selectable) {
        let mut rows: Vec<ListedMsg> = Vec::new();
        let mut validity: Option<u32> = None;
        let mut cursor: Option<String> = None;
        loop {
            let page = ops.list_page(&f, cursor.take()).await?;
            validity = page.uid_validity.or(validity);
            rows.extend(page.items);
            progress(&f.path, rows.len());
            match page.next {
                Some(n) => cursor = Some(n),
                None => break,
            }
        }
        if provider == Provider::Gmail && f.role == FolderRole::AllMail {
            let v = validity
                .ok_or_else(|| OpsError::Other(format!("{} reported no UIDVALIDITY", f.path)))?;
            all_mail = Some((f, v, rows));
        } else {
            folders.push((f, validity, rows));
        }
    }
    Ok(PreviewListing { preview_id: preview_id.to_string(), provider, caps, trash, folders, all_mail, listed_at_ms: now_ms })
}
