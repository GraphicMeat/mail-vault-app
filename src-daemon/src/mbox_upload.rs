//! Mode 1 of the mbox import, "Import and restore to the server", one message
//! at a time: the unit the upload job (Task 10) runs over a whole file.
//!
//! Per message: its Takeout labels pick one home folder among the server's
//! (`takeout::home_folder` with `create_missing`: the first custom label is
//! made on the server when no folder has it yet, R6/D3); a message that
//! folder already holds is skipped; anything else is APPENDed with its own
//! date and, with labels, its Starred and read state; and the vault keeps a
//! copy under the uid the server gave it, where sync keeps server mail.
//!
//! Dedupe asks the header cache first and the server second, by mode 2's rule
//! (`ServerView::lists_same`: same Message-ID, Subject and Date, every row
//! under the id tested). The cached rows decide alone only while they are the
//! whole folder as the server has it (`lists_whole_mailbox`, judged once per
//! folder per run against a SELECT); otherwise `UID SEARCH HEADER Message-ID`
//! does, so a message an earlier run uploaded is found before any sync has
//! cached it. A message with no Message-ID has only the cached rows (Subject
//! and Date) to go by. What this run uploaded is remembered as a fingerprint
//! per message, never as a row.
//!
//! The connection is the pipeline's own, not a pooled one, and uncompressed
//! (`create_imap_session_no_compress`, one slot of the account's connection
//! budget): Hostinger hangs an APPEND on a compressed stream. The literal is
//! LITERAL+ where the server offers it, since the same host also hung waiting
//! for the synchronous literal's `+`, and the whole APPEND is bounded in time
//! (a server that stops reading mid-literal would hold the write for ever).
//! The connection is dropped after anything but an OK or a tagged NO: an
//! APPEND cut off mid-literal leaves the server reading whatever comes next as
//! message bytes. One found dead before its APPEND went out is replaced once;
//! an APPEND is never sent twice.
//!
//! The pipeline never waits or retries beyond that: a failure is `Transient`
//! (throttling, a lost or silent connection: the job backs off and tries the
//! message again), `Permanent` (the server refused this message) or `SignIn`
//! (the server refused the account: the job stops for it). Only the
//! server's or the socket's own words are classified, never the folder name
//! an error carries: that name is a label, and the file chose it.

use crate::handlers::common::{self, blocking};
use crate::imap::{self, pool, ImapConfig, ImapSession};
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use mailvault_core::import_rehome::{self, Head, ServerView};
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::takeout::{self, FolderRef, Home, Role};
use mailvault_core::{maildir, vault_files};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use tracing::{info, warn};

/// An Outlook (Graph) account has no IMAP to upload over (D4); the app shows
/// `errors.E_MBOX_SERVER_GRAPH`.
pub const E_MBOX_SERVER_GRAPH: &str = "E_MBOX_SERVER_GRAPH";

/// What the connection is for on the Network Activity page: one of the
/// purposes the app has a name for.
const PURPOSE: &str = "sync";

/// An APPEND may take this long plus a second per `APPEND_MIN_RATE` bytes of
/// the message (a 35 MB Gmail maximum: about 20 minutes) before the server
/// counts as gone. Past that the connection is dropped and the message is a
/// `Transient` failure.
const APPEND_FLOOR_SECS: u64 = 120;
const APPEND_MIN_RATE: u64 = 32 * 1024;

/// Uids per custody unit when a folder's cached rows are read: the store's
/// lock, which every foreground header read shares, is held for one chunk.
const CACHE_CHUNK: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailKind {
    /// Throttling, a busy server, a lost or silent connection: worth another
    /// try once the caller has waited.
    Transient,
    /// The server refused this message.
    Permanent,
    /// The server refused the sign-in: the account, not this message. Every
    /// later message fails the same way until the credentials change, so the
    /// job stops for them rather than counting each one.
    SignIn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Stored in `mailbox`. `uid` when the server said (APPENDUID) or its
    /// Message-ID found it; `None` leaves the vault copy to the next sync.
    Uploaded { mailbox: String, uid: Option<u32> },
    /// `mailbox` already holds this message.
    Skipped { mailbox: String },
    /// Not stored, or not known to be; the text is the server's or the socket's.
    Failed(FailKind, String),
}

pub struct MboxUpload {
    state: Arc<DaemonState>,
    config: ImapConfig,
    account_id: String,
    fallback: String,
    use_labels: bool,
    conn: Option<Conn>,
    /// The server's folders, listed on the first connection, plus those this
    /// run made.
    folders: Option<Vec<FolderRef>>,
    boxes: HashMap<String, Folder>,
    created: BTreeSet<String>,
    touched: BTreeSet<String>,
    /// The APPEND bound: `APPEND_FLOOR_SECS` and `APPEND_MIN_RATE` (a test
    /// shortens them).
    append_floor_secs: u64,
    append_min_rate: u64,
}

struct Conn {
    session: ImapSession,
    literal_plus: bool,
    /// APPENDUID answers the uid; without it the pipeline looks it up.
    uidplus: bool,
    selected: Option<String>,
}

/// One folder as this run knows it, from its first message on.
struct Folder {
    /// What the header cache held when the run first opened the folder.
    view: ServerView,
    /// `view` is the whole folder: a message it lacks is not on the server.
    whole: bool,
    /// Fingerprints of what this run put here (`fingerprint`): the same
    /// message later in the file is known without keeping its row.
    uploaded: HashSet<u64>,
    /// The vault registry holds this folder: a uid's file is looked up, not
    /// searched for in `cur/`. Cleared when the registry stops answering.
    listed: bool,
}

impl Folder {
    /// A folder this run made: nothing cached belongs to it, and the server's
    /// search decides what it holds.
    fn made_again() -> Self {
        Folder { view: ServerView::default(), whole: false, uploaded: HashSet::new(), listed: false }
    }
}

/// Why an attempt stopped.
struct Fail {
    /// The whole text, for the log and the caller. It can name the folder.
    error: String,
    /// The server's or the socket's own words: `error` without the prefix our
    /// call put on it that names the folder. A folder name is a label, the
    /// file's to choose ("Temporary", "no response:"), so it is all a
    /// classifier reads.
    cause: String,
    /// The APPEND went out, so the message may be on the server whatever the
    /// error says.
    appended: bool,
}

impl Fail {
    /// `error` from a call whose own words start with `prefix`
    /// (`"SELECT <folder> failed: "`): only what follows is classified.
    fn named(prefix: &str, error: String, appended: bool) -> Self {
        let cause = error.strip_prefix(prefix).unwrap_or(&error).to_string();
        Fail { error, cause, appended }
    }
}

impl From<String> for Fail {
    fn from(error: String) -> Self {
        Fail { cause: error.clone(), error, appended: false }
    }
}

/// What the same-message rule compares (Message-ID, Subject, Date), as 8
/// bytes: a million uploads cost a few megabytes. `None` without a Date: the
/// rule never matches such a message, here as on the server.
fn fingerprint(head: &Head) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let date = head.date_secs?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&head.id, &head.subject, date).hash(&mut hasher);
    Some(hasher.finish())
}

impl MboxUpload {
    /// Nothing goes over the network before the first message. `fallback` is
    /// the server path of the folder mail no label homes goes to (the
    /// dialog's pick); without `use_labels` every message goes there, with no
    /// flags, as mode 2 files it.
    pub fn new(state: Arc<DaemonState>, config: ImapConfig, account_id: String, fallback: String, use_labels: bool) -> Result<Self, String> {
        if config.oauth2_transport.as_deref() == Some("graph") {
            return Err(format!("{E_MBOX_SERVER_GRAPH}: an Outlook account takes no upload over IMAP"));
        }
        Ok(MboxUpload {
            state,
            config,
            account_id,
            fallback,
            use_labels,
            conn: None,
            folders: None,
            boxes: HashMap::new(),
            created: BTreeSet::new(),
            touched: BTreeSet::new(),
            append_floor_secs: APPEND_FLOOR_SECS,
            append_min_rate: APPEND_MIN_RATE,
        })
    }

    /// Every folder an APPEND went out to this run (one made for it
    /// included), whether or not it was answered: what the header cache may
    /// no longer match.
    pub fn touched(&self) -> &BTreeSet<String> {
        &self.touched
    }

    /// Close the connection, so a paused job holds no slot of the account's
    /// budget; the next message makes a new one.
    pub fn disconnect(&mut self) {
        self.conn = None;
    }

    /// Folders this run made on the server (or found already there when it
    /// went to make them): the account's folder list is out of date.
    pub fn created(&self) -> &BTreeSet<String> {
        &self.created
    }

    /// Upload one message as the mbox holds it, `>From ` escapes and all (what
    /// the mbox reader hands over).
    pub async fn upload_message(&mut self, raw: &[u8]) -> Outcome {
        let msg = crate::mbox::mbox_unescape_from(raw);
        let result = match self.attempt(&msg).await {
            // Found dead before the APPEND went out: once more, on a new connection.
            Err(f) if !f.appended && pool::is_connection_lost(&f.cause) => {
                warn!("[mbox_upload] {}: {}; reconnecting once", self.config.email, f.error);
                self.conn = None;
                self.attempt(&msg).await
            }
            other => other,
        };
        match result {
            Ok(outcome) => outcome,
            Err(f) => {
                if !is_tagged_no(&f.cause) {
                    self.conn = None;
                }
                let kind = kind_of(&f.cause);
                warn!("[mbox_upload] {}: not uploaded ({kind:?}): {}", self.config.email, f.error);
                Outcome::Failed(kind, f.error)
            }
        }
    }

    async fn attempt(&mut self, msg: &[u8]) -> Result<Outcome, Fail> {
        self.connect().await?;
        let labels = if self.use_labels { takeout::labels_of(msg) } else { Vec::new() };
        // Compared with, and made as, the names the server lists.
        let wire: Vec<String> = labels.iter().map(|l| imap::utf7_encode(l)).collect();
        let path = match takeout::home_folder(&wire, self.folders.as_deref().unwrap_or_default(), true) {
            Home::Folder(f) => f.path,
            Home::Create(label) => {
                let path = label.replace('/', &self.delimiter().to_string());
                self.create(&path).await?;
                path
            }
            Home::Fallback => self.fallback.clone(),
        };
        self.open(&path).await?;
        let head = import_rehome::head_of(msg);
        if self.on_server(&path, &head).await? {
            return Ok(Outcome::Skipped { mailbox: path });
        }
        // Before the APPEND: one whose answer never came may still have landed.
        self.touched.insert(path.clone());
        let uid = self.append(&path, msg, &labels, &head).await?;
        if let (Some(f), Some(fp)) = (self.boxes.get_mut(&path), fingerprint(&head)) {
            f.uploaded.insert(fp);
        }
        if let Some(uid) = uid {
            self.keep_copy(&path, uid, msg, &labels, &head).await;
        }
        Ok(Outcome::Uploaded { mailbox: path, uid })
    }

    /// The pipeline's connection, made on the first message and after one was
    /// dropped. The first also lists the server's folders.
    async fn connect(&mut self) -> Result<(), Fail> {
        if self.conn.is_some() {
            return Ok(());
        }
        let connecting = imap::create_imap_session_no_compress(&self.config, &self.state.imap_pool);
        let mut session = mailvault_core::net_activity::with_purpose(PURPOSE, connecting).await?;
        let caps = session.capabilities().await.map_err(|e| format!("CAPABILITY failed: {e}"))?;
        let (literal_plus, uidplus) = (caps.has_str("LITERAL+"), caps.has_str("UIDPLUS"));
        if self.folders.is_none() {
            let listed = imap::list_mailboxes(&mut session).await?;
            self.folders = Some(takeout::folder_refs_from_listing(&json!({ "mailboxes": listed }).to_string()));
        }
        self.conn = Some(Conn { session, literal_plus, uidplus, selected: None });
        Ok(())
    }

    fn conn(&mut self) -> Result<&mut Conn, Fail> {
        self.conn.as_mut().ok_or_else(|| Fail::from("connection lost".to_string()))
    }

    /// The server's hierarchy delimiter, from INBOX's LIST line; `/` when none.
    fn delimiter(&self) -> char {
        let folders = self.folders.as_deref().unwrap_or_default();
        folders.iter().find(|f| f.role == Role::Inbox).or(folders.first()).map_or('/', |f| f.delim)
    }

    /// Make `path` on the server, once per run: the CREATE the
    /// `imap_create_mailbox` route sends, "already exists" taken as done.
    async fn create(&mut self, path: &str) -> Result<(), Fail> {
        if self.created.contains(path) {
            return Ok(());
        }
        if let Err(e) = imap::create_mailbox(&mut self.conn()?.session, path).await {
            let fail = Fail::named(&format!("CREATE {path} failed: "), e, false);
            let low = fail.cause.to_ascii_lowercase();
            if !is_tagged_no(&fail.cause) || !(low.contains("alreadyexists") || low.contains("already exists")) {
                return Err(fail);
            }
        }
        info!("[mbox_upload] {}: made folder {path}", self.config.email);
        self.created.insert(path.to_string());
        let delim = self.delimiter();
        let folders = self.folders.get_or_insert_with(Vec::new);
        if !folders.iter().any(|f| f.path == path) {
            folders.push(FolderRef { path: path.to_string(), dir: vault_dir_name(path), role: Role::Other, delim });
        }
        Ok(())
    }

    async fn select(&mut self, path: &str) -> Result<imap::async_imap::types::Mailbox, Fail> {
        let conn = self.conn()?;
        // A SELECT that fails leaves no mailbox selected.
        conn.selected = None;
        let mailbox = imap::select_mailbox(&mut conn.session, path).await.map_err(|e| Fail::named(&format!("SELECT {path} failed: "), e, false))?;
        conn.selected = Some(path.to_string());
        Ok(mailbox)
    }

    /// SELECT `path`, making it first when the server says it is missing (once
    /// per run). A folder made again is a new one: what the run knew of the
    /// old one goes.
    async fn select_or_make(&mut self, path: &str) -> Result<imap::async_imap::types::Mailbox, Fail> {
        match self.select(path).await {
            Err(f) if needs_create(&f.cause) && !self.created.contains(path) => {
                self.create(path).await?;
                if self.boxes.contains_key(path) {
                    self.boxes.insert(path.to_string(), Folder::made_again());
                }
                self.select(path).await
            }
            other => other,
        }
    }

    /// A folder's first message this run: its UIDVALIDITY and UIDNEXT from a
    /// SELECT, then what the header cache holds of it and whether that is all
    /// of it. Rows cached under another UIDVALIDITY, or for a folder this run
    /// made, describe an earlier folder of that name, not this one: they count
    /// for nothing. The rows are read a chunk at a time (`cached_rows`).
    async fn open(&mut self, path: &str) -> Result<(), Fail> {
        if self.boxes.contains_key(path) {
            return Ok(());
        }
        let mailbox = self.select_or_make(path).await?;
        if self.created.contains(path) {
            self.boxes.insert(path.to_string(), Folder::made_again());
            return Ok(());
        }
        let (validity, next) = (mailbox.uid_validity, mailbox.uid_next);
        let (st, account, p) = (Arc::clone(&self.state), self.account_id.clone(), path.to_string());
        let read = blocking(move || -> Result<(ServerView, bool), String> {
            let (cached_validity, whole) = crate::custody::with_conn(&st, |c| {
                let (cached_validity, _) = cache::sync_meta(c, &account, &p)?;
                let whole = match (validity, next) {
                    (Some(v), Some(n)) => cache::lists_whole_mailbox(c, &account, &p, v, n)?,
                    _ => false,
                };
                Ok((cached_validity, whole))
            })?;
            if cached_validity.is_some() && cached_validity != validity {
                return Ok((ServerView::default(), false));
            }
            let mut view = ServerView::default();
            cached_rows(&st, &account, &p, CACHE_CHUNK, |rows| view.extend(&rows))?;
            Ok((view, whole))
        })
        .await
        .and_then(|r| r);
        let (view, whole) = read.unwrap_or_else(|e| {
            warn!("[mbox_upload] header cache of {path} unreadable, the server decides: {e}");
            (ServerView::default(), false)
        });
        self.boxes.insert(path.to_string(), Folder { view, whole, uploaded: HashSet::new(), listed: false });
        Ok(())
    }

    /// Whether `path` already holds this message: the cached rows and this
    /// run's uploads, then, while the rows are not the whole folder, the
    /// server's own search.
    async fn on_server(&mut self, path: &str, head: &Head) -> Result<bool, Fail> {
        let Some(folder) = self.boxes.get(path) else { return Ok(false) };
        if folder.view.lists_same(head) || fingerprint(head).is_some_and(|fp| folder.uploaded.contains(&fp)) {
            return Ok(true);
        }
        let Some(id) = head.id.clone() else { return Ok(false) };
        if folder.whole {
            return Ok(false);
        }
        if self.conn()?.selected.as_deref() != Some(path) {
            self.select(path).await?;
        }
        let uids = match imap::message_id_uids(&mut self.conn()?.session, &id).await {
            Ok(uids) => uids,
            Err(e) if pool::is_connection_lost(&e) => return Err(e.into()),
            // A server that will not search headers, or an id no SEARCH can
            // carry: nothing found, as with no search at all.
            Err(e) => {
                warn!("[mbox_upload] {path}: no Message-ID search ({e}), uploading");
                return Ok(false);
            }
        };
        Ok(!self.same_message_uids(path, &uids, head).await?.is_empty())
    }

    /// Which of `uids` in `path` hold `head`'s message, judged by the rule on
    /// their fetched headers, every one of them.
    async fn same_message_uids(&mut self, path: &str, uids: &[u32], head: &Head) -> Result<Vec<u32>, Fail> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let fetched = imap::fetch_headers_by_uids(&mut self.conn()?.session, path, uids).await;
        let (headers, _) = fetched.map_err(|e| Fail::named(&format!("SELECT {path} failed: "), e, false))?;
        let rows: Vec<Value> = headers.iter().filter_map(|h| serde_json::to_value(h).ok()).collect();
        Ok(ServerView::from_headers(&rows).uids_of(head))
    }

    /// APPEND with the message's own date and, with labels, its Starred and
    /// read state (R5). A folder the server says is missing (a tagged NO) is
    /// made once and the APPEND sent once more. The uid: APPENDUID, else the
    /// newest copy of the message at or past the folder's UIDNEXT from right
    /// before this APPEND (`lookup_uid`).
    async fn append(&mut self, path: &str, msg: &[u8], labels: &[String], head: &Head) -> Result<Option<u32>, Fail> {
        let attrs = takeout::attrs_of(labels);
        let mut flags = Vec::new();
        if self.use_labels && !attrs.unread {
            flags.push("\\Seen");
        }
        if self.use_labels && attrs.flagged {
            flags.push("\\Flagged");
        }
        let flags = flags.join(" ");
        let date = imap::internaldate_of(msg);
        // Without UIDPLUS the uid is looked up afterwards: only a copy at or
        // past this UIDNEXT can be the one this APPEND stores.
        let lookup = !self.conn()?.uidplus && head.id.is_some();
        let mut before = if lookup { self.select_or_make(path).await?.uid_next } else { None };
        let mut sent = self.append_bounded(path, msg, &flags, date.as_deref()).await;
        if matches!(&sent, Err(f) if needs_create(&f.cause)) && !self.created.contains(path) {
            // A tagged NO [TRYCREATE]: nothing was stored. The folder made now
            // is a new one, so what the run knew of the old one goes, whatever
            // happens next; and from here an APPEND may be out.
            self.boxes.insert(path.to_string(), Folder::made_again());
            let remade = self.create(path).await;
            if let Some(conn) = self.conn.as_mut() {
                conn.selected = None;
            }
            remade.map_err(|f| Fail { appended: true, ..f })?;
            if lookup {
                before = self.select(path).await.map_err(|f| Fail { appended: true, ..f })?.uid_next;
            }
            sent = self.append_bounded(path, msg, &flags, date.as_deref()).await;
        }
        match sent {
            Ok(Some((_, uid))) => Ok(Some(uid)),
            Ok(None) => Ok(self.lookup_uid(path, head, before).await),
            Err(f) => {
                // Anything but a clean refusal may have stored it: the next try
                // asks the server, not the rows.
                if !is_tagged_no(&f.cause) {
                    if let Some(folder) = self.boxes.get_mut(path) {
                        folder.whole = false;
                    }
                }
                Err(f)
            }
        }
    }

    /// One APPEND, bounded by `append_floor_secs` plus a second per
    /// `append_min_rate` bytes: past that the server counts as gone (the
    /// stream's own deadline arms on reads only, so a server that stops
    /// reading mid-literal would hold the write for ever).
    async fn append_bounded(&mut self, path: &str, msg: &[u8], flags: &str, date: Option<&str>) -> Result<Option<(u32, u32)>, Fail> {
        let secs = self.append_floor_secs + msg.len() as u64 / self.append_min_rate.max(1);
        let conn = self.conn.as_mut().ok_or_else(|| Fail::from("connection lost".to_string()))?;
        let sending = imap::append_email_with(&mut conn.session, path, msg, flags, date, conn.literal_plus);
        imap::bounded("APPEND", secs, sending).await.map_err(|e| Fail::named(&format!("IMAP APPEND to '{path}' failed: "), e, true))
    }

    /// The uid a server without UIDPLUS gave the message just appended: the
    /// newest copy at or past `before` (the folder's UIDNEXT from right before
    /// the APPEND) whose fetched header is this message by the rule. An older
    /// copy, one whose Message-ID only contains this one, a search that has
    /// not caught up with the APPEND: none of them names it. `None` when there
    /// is none or the lookup fails: the message is stored either way.
    async fn lookup_uid(&mut self, path: &str, head: &Head, before: Option<u32>) -> Option<u32> {
        let (id, floor) = (head.id.as_deref()?, before?);
        match self.find_uid(path, id, floor, head).await {
            Ok(uid) => uid,
            Err(f) => {
                warn!("[mbox_upload] stored in {path}, its uid not found: {}", f.error);
                if !is_tagged_no(&f.cause) {
                    self.conn = None;
                }
                None
            }
        }
    }

    async fn find_uid(&mut self, path: &str, id: &str, floor: u32, head: &Head) -> Result<Option<u32>, Fail> {
        self.select(path).await?;
        let found = imap::message_id_uids(&mut self.conn()?.session, id).await?;
        let candidates: Vec<u32> = found.into_iter().filter(|u| *u >= floor).collect();
        Ok(self.same_message_uids(path, &candidates, head).await?.into_iter().max())
    }

    /// The vault's copy of what the server now holds at `uid`, where sync keeps
    /// it (the account id as sync and `auto_cache` key it; mode 2's own folders
    /// use the sanitized one, the same for a UUID id): archived plus the label
    /// flags, written like any server copy (`vault_files::store`, atomic, its
    /// registry row). Never over a different message at that uid: this copy
    /// then goes to `orphaned/`. A failure is only logged: the message is on
    /// the server, and the next sync or backup brings its copy in.
    ///
    /// The folder is listed through the registry once, outside the mailbox
    /// lock (a listing takes it), before its first copy and again only after
    /// the registry lost it: `store` then looks a uid up instead of sweeping
    /// `cur/` under the lock for every message.
    async fn keep_copy(&mut self, path: &str, uid: u32, msg: &[u8], labels: &[String], head: &Head) {
        let flags = if self.use_labels { crate::mbox::label_flags(labels) } else { vec!["archived".to_string()] };
        let listed = self.boxes.get(path).is_some_and(|f| f.listed);
        let (st, account, p, raw, head) = (Arc::clone(&self.state), self.account_id.clone(), path.to_string(), msg.to_vec(), head.clone());
        let done = blocking(move || {
            if !listed {
                if let Ok(root) = common::vault_root(&st) {
                    st.vault_registry.files(&root, &account, &p);
                }
            }
            let kept = common::with_mailbox_write(&st, &account, &p, |root| {
                if vault_files::store(&st.vault_registry, root, &account, &p, uid, &raw, &flags, false)? {
                    return Ok(None);
                }
                let cur = vault_files::cur_path(root, &account, &p);
                let there = maildir::find_by_uid(&cur, uid);
                if there.is_some_and(|copy| import_rehome::same_as_copy(&head, &import_rehome::body_of(&raw), &copy)) {
                    return Ok(None);
                }
                let name = vault_files::build_maildir_filename(uid, &flags);
                maildir::set_aside_copy(cur.parent().unwrap_or(&cur), &name, &raw).map(Some)
            });
            (kept, st.vault_registry.known(&account, &p, uid).is_some())
        })
        .await;
        let (kept, still_listed) = done.unwrap_or_else(|e| (Err(e), false));
        if let Some(f) = self.boxes.get_mut(path) {
            f.listed = still_listed;
        }
        match kept {
            Ok(None) => {}
            Ok(Some(aside)) => warn!("[mbox_upload] the vault holds another message at {path} uid {uid}; this copy is kept at {aside:?}"),
            Err(e) => warn!("[mbox_upload] {path} uid {uid} is on the server, its vault copy was not written: {e}"),
        }
    }
}

/// Every cached header row of `mailbox`, handed to `f` one chunk of uids at a
/// time, each chunk read in its own custody unit: the store's lock is never
/// held for a whole folder (All Mail, the Gmail fallback, is the largest).
fn cached_rows(state: &DaemonState, account: &str, mailbox: &str, chunk: usize, mut f: impl FnMut(Vec<Value>)) -> Result<(), String> {
    let mut uids: Vec<u32> = crate::custody::with_conn(state, |c| cache::uid_set(c, account, mailbox))?.into_iter().collect();
    uids.sort_unstable();
    for part in uids.chunks(chunk.max(1)) {
        f(crate::custody::with_conn(state, |c| cache::load_by_uids(c, account, mailbox, part))?);
    }
    Ok(())
}

/// A tagged NO: the server refused and the connection is still in step. Read
/// on a `Fail::cause`, which starts with the server's words.
fn is_tagged_no(cause: &str) -> bool {
    cause.starts_with("no response:")
}

/// The server refused because the folder is not there: a tagged NO with
/// RFC 3501's `[TRYCREATE]` (the parser's `TryCreate`) or a wording
/// `is_missing_mailbox` knows. Never a lost connection, whatever it says.
fn needs_create(cause: &str) -> bool {
    is_tagged_no(cause) && (imap::is_missing_mailbox(cause) || cause.to_ascii_lowercase().contains("trycreate"))
}

/// Throttling (Gmail's `[THROTTLED]` and "Too many simultaneous
/// connections", its bandwidth cap), a busy server, a dropped, silent or
/// unreachable connection: another try after a wait can work. Anything else
/// is this message, or this account (a rejected sign-in), refused. Read on a
/// `Fail::cause`; a reply the server did send is never a lost connection.
fn classify(cause: &str) -> FailKind {
    const BUSY: [&str; 10] =
        ["[throttled]", "[unavailable]", "[inuse]", "[limit]", "too many", "rate limit", "bandwidth", "try again", "temporar", "timed out"];
    let low = cause.to_ascii_lowercase();
    let answered = is_tagged_no(cause) || cause.starts_with("bad response:");
    let busy = imap::is_bandwidth_limited(cause) || BUSY.iter().any(|n| low.contains(n));
    if busy || (!answered && pool::is_retryable_connect_error(cause)) {
        FailKind::Transient
    } else {
        FailKind::Permanent
    }
}

/// `classify`, with a refused sign-in told apart from a refused message (the
/// hoarder's words for one). A sign-in turned away because the server is busy
/// ("Too many simultaneous connections") stays `Transient`.
fn kind_of(cause: &str) -> FailKind {
    match classify(cause) {
        FailKind::Permanent if crate::hoarder_worker::is_sign_in_failure(cause) => FailKind::SignIn,
        kind => kind,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::{Action, Mailbox, Message, MockImap, Scenario, Trigger};
    use std::path::Path;

    /// Its INTERNALDATE: 05-Mar-2019 08:15:00 +0000.
    const DATE: &str = "Tue, 05 Mar 2019 09:15:00 +0100";

    fn state() -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, true);
        (vault, s)
    }

    fn config(server: &MockImap) -> ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(json!({
            "email": "user@example.com",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
        }))
        .unwrap()
    }

    /// A Takeout message as the mbox reader hands it over (its trailing line
    /// break trimmed), with an escaped `From ` line in the body.
    fn tmsg(id: &str, subject: &str, labels: &str) -> Vec<u8> {
        format!("X-Gmail-Labels: {labels}\r\nMessage-ID: <{id}>\r\nSubject: {subject}\r\nDate: {DATE}\r\n\r\nbody of {subject}\r\n>From the team")
            .into_bytes()
    }

    /// `tmsg` as the server and the vault get it.
    fn stored(id: &str, subject: &str, labels: &str) -> Vec<u8> {
        crate::mbox::mbox_unescape_from(&tmsg(id, subject, labels))
    }

    /// A Gmail-shaped server: INBOX holding uids 1 to 4 (UIDNEXT 5), Sent Mail,
    /// All Mail (`\All`, the fallback) and Work, all empty.
    fn gmail() -> Scenario {
        let mut inbox = Mailbox::new("INBOX");
        for uid in 1..=4 {
            inbox.add(Message::new(uid, format!("Message-ID: <old{uid}@x>\r\nSubject: old {uid}\r\nDate: {DATE}\r\n\r\nold")));
        }
        Scenario::new()
            .mailbox(inbox)
            .mailbox(Mailbox::new("[Gmail]/Sent Mail").with_attrs(&["\\HasNoChildren", "\\Sent"]))
            .mailbox(Mailbox::new("[Gmail]/All Mail").with_attrs(&["\\HasNoChildren", "\\All"]))
            .mailbox(Mailbox::new("Work"))
    }

    fn upload(s: &Arc<DaemonState>, server: &MockImap) -> MboxUpload {
        MboxUpload::new(Arc::clone(s), config(server), "acct1".into(), "[Gmail]/All Mail".into(), true).unwrap()
    }

    fn uploaded(mailbox: &str, uid: u32) -> Outcome {
        Outcome::Uploaded { mailbox: mailbox.into(), uid: Some(uid) }
    }

    fn skipped(mailbox: &str) -> Outcome {
        Outcome::Skipped { mailbox: mailbox.into() }
    }

    fn subjects(server: &MockImap, mailbox: &str) -> Vec<String> {
        let state = server.state();
        let Some(mb) = state.find(mailbox) else { return Vec::new() };
        mb.messages
            .iter()
            .map(|m| String::from_utf8_lossy(&m.raw).lines().find_map(|l| l.strip_prefix("Subject: ")).unwrap_or_default().to_string())
            .collect()
    }

    fn server_message(server: &MockImap, mailbox: &str, uid: u32) -> Message {
        server.state().find(mailbox).and_then(|m| m.by_uid(uid).cloned()).expect("on the server")
    }

    /// File names in the vault dir sync writes for `mailbox`, sorted.
    fn names_in(root: &Path, mailbox: &str) -> Vec<String> {
        let cur = vault_files::cur_path(root, "acct1", mailbox);
        let mut names: Vec<String> = std::fs::read_dir(cur).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn seed_vault(root: &Path, mailbox: &str, name: &str, raw: &[u8]) {
        let cur = vault_files::cur_path(root, "acct1", mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(name), raw).unwrap();
    }

    fn cache_headers(s: &Arc<DaemonState>, mailbox: &str, value: Value) {
        crate::custody::with_conn(s, |c| cache::save_headers(c, "acct1", mailbox, &value.to_string())).unwrap();
    }

    fn append_line(server: &MockImap) -> String {
        server.commands().into_iter().find(|c| c.contains("APPEND")).expect("an APPEND")
    }

    // ---- routing ----

    #[tokio::test]
    async fn each_message_goes_to_its_home_folder_and_a_new_label_is_made_once() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        let mut got = Vec::new();
        for (id, subject, labels) in [
            ("a@x", "inbox one", "Inbox,Important,Opened"),
            ("b@x", "sent one", "Sent,Opened"),
            ("c@x", "work one", "Work,Opened"),
            ("d@x", "new one", "Projects/2026,Opened"),
            ("e@x", "new two", "Projects/2026,Unread"),
            ("f@x", "no home", "Category Promotions,Opened"),
        ] {
            got.push(up.upload_message(&tmsg(id, subject, labels)).await);
        }
        assert_eq!(
            got,
            vec![
                uploaded("INBOX", 5),
                uploaded("[Gmail]/Sent Mail", 1),
                uploaded("Work", 1),
                uploaded("Projects/2026", 1),
                uploaded("Projects/2026", 2),
                uploaded("[Gmail]/All Mail", 1),
            ]
        );
        assert_eq!(subjects(&server, "Projects/2026"), ["new one", "new two"]);
        assert_eq!(server.count_commands("CREATE"), 1, "one CREATE for the new label, however many messages it homes");
        assert_eq!(up.created().iter().collect::<Vec<_>>(), ["Projects/2026"]);
        assert_eq!(up.touched().len(), 5);
        assert_eq!(server_message(&server, "INBOX", 5).raw, stored("a@x", "inbox one", "Inbox,Important,Opened"), "the body's `>From ` is unescaped");
        assert_eq!(server.connection_count(), 1, "one connection for the whole run");
    }

    /// A label's `/` hierarchy takes the server's delimiter, and its name the
    /// modified UTF-7 the server lists: an existing folder is found by it, a
    /// new one is made under it.
    #[tokio::test]
    async fn a_label_folder_takes_the_servers_delimiter_and_its_utf7_name() {
        let mut scenario = gmail().mailbox(Mailbox::new("Kunden.&ANw-bung"));
        scenario.state.delimiter = ".".into();
        let server = MockImap::start(scenario);
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Projects/2026")).await, uploaded("Projects.2026", 1));
        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Kunden/Übung")).await, uploaded("Kunden.&ANw-bung", 1));
        assert_eq!(up.upload_message(&tmsg("c@x", "three", "Café")).await, uploaded("Caf&AOk-", 1));
        assert_eq!(up.created().iter().collect::<Vec<_>>(), ["Caf&AOk-", "Projects.2026"]);
        assert_eq!(server.count_commands("CREATE"), 2, "the existing folder is not made again");
    }

    /// A label is the file's to choose: a CR/LF in it never reaches the wire
    /// raw, and a `..` never names a directory outside the account's.
    #[tokio::test]
    async fn a_hostile_label_never_splits_a_command_or_leaves_the_account_dir() {
        let server = MockImap::start(gmail());
        let (v, s) = state();
        let mut up = upload(&s, &server);
        let evil = up.upload_message(&tmsg("a@x", "evil", "=?UTF-8?Q?Evil=0D=0AA1_DELETE_INBOX?=")).await;
        assert_eq!(evil, uploaded("Evil&AA0ACg-A1 DELETE INBOX", 1));
        assert_eq!(subjects(&server, "INBOX").len(), 4, "INBOX is untouched");
        // A CR/LF sent raw would have made the rest of the name a command of its own.
        assert!(server.commands().iter().all(|c| c.split_whitespace().nth(1) != Some("DELETE")));

        assert_eq!(up.upload_message(&tmsg("b@x", "dots", "..")).await, uploaded("..", 1));
        let account_dir = v.path().join("Maildir").join("acct1");
        assert_eq!(std::fs::read_dir(account_dir.join("__").join("cur")).unwrap().count(), 1);
        assert!(!v.path().join("Maildir").join("cur").exists() && !v.path().join("cur").exists());
    }

    // ---- flags, date, vault copy ----

    #[tokio::test]
    async fn the_server_gets_the_flags_and_date_and_the_vault_a_copy_at_its_uid() {
        let server = MockImap::start(gmail());
        let (v, s) = state();
        // The vault already holds the server's uid 1, so the registry answers for
        // INBOX without listing it again.
        seed_vault(v.path(), "INBOX", "1:2,S.eml", b"Message-ID: <old1@x>\r\nSubject: old 1\r\n\r\nold");
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acct1", "INBOX"), Some((vec![1], vec![])));

        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "starred unread", "Inbox,Starred,Unread")).await, uploaded("INBOX", 5));
        assert_eq!(up.upload_message(&tmsg("b@x", "read", "Inbox,Opened")).await, uploaded("INBOX", 6));

        let starred = server_message(&server, "INBOX", 5);
        assert_eq!(starred.flags, ["\\Flagged"]);
        assert_eq!(starred.internal_date, "05-Mar-2019 08:15:00 +0000");
        assert_eq!(server_message(&server, "INBOX", 6).flags, ["\\Seen"]);

        assert_eq!(names_in(v.path(), "INBOX"), ["1:2,S.eml", "5:2,AF.eml", "6:2,AS.eml"]);
        let cur = vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read(cur.join("5:2,AF.eml")).unwrap(), stored("a@x", "starred unread", "Inbox,Starred,Unread"));
        assert_eq!(reg.uid_sets(v.path(), "acct1", "INBOX"), Some((vec![1, 5, 6], vec![5, 6])));
        assert_eq!(reg.listing_count(), 1, "the rows came from the upload, not a relisting");
    }

    /// Without labels every message goes to the fallback with no flags, as
    /// mode 2 files a plain mbox.
    #[tokio::test]
    async fn without_labels_everything_goes_to_the_one_folder_unflagged() {
        let server = MockImap::start(gmail());
        let (v, s) = state();
        let mut up = MboxUpload::new(Arc::clone(&s), config(&server), "acct1".into(), "Work".into(), false).unwrap();
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Inbox,Starred")).await, uploaded("Work", 1));
        assert!(server_message(&server, "Work", 1).flags.is_empty());
        assert_eq!(names_in(v.path(), "Work"), ["1:2,A.eml"]);
    }

    #[tokio::test]
    async fn a_different_message_at_the_servers_uid_in_the_vault_is_never_overwritten() {
        let server = MockImap::start(gmail());
        let (v, s) = state();
        let theirs = b"Message-ID: <other@x>\r\nSubject: other\r\n\r\nthe vault's own".to_vec();
        seed_vault(v.path(), "INBOX", "5:2,S.eml", &theirs);
        // uid 6 already holds this very message, as a sync that got there first would leave it.
        seed_vault(v.path(), "INBOX", "6:2,S.eml", &stored("b@x", "two", "Inbox,Opened"));
        let mut up = upload(&s, &server);

        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Inbox,Opened")).await, uploaded("INBOX", 5));
        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Inbox,Opened")).await, uploaded("INBOX", 6));

        assert_eq!(names_in(v.path(), "INBOX"), ["5:2,S.eml", "6:2,S.eml"]);
        let cur = vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read(cur.join("5:2,S.eml")).unwrap(), theirs, "never overwritten");
        let aside = cur.parent().unwrap().join(maildir::ORPHAN_DIR);
        let kept: Vec<_> = std::fs::read_dir(&aside).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap())).collect();
        assert_eq!(kept, vec![("5:2,AS.eml".to_string(), stored("a@x", "one", "Inbox,Opened"))], "the new copy is set aside, the same message is not");
    }

    // ---- dedupe ----

    #[tokio::test]
    async fn a_second_run_finds_what_the_first_uploaded_on_the_server_itself() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let messages = [tmsg("a@x", "one", "Inbox"), tmsg("b@x", "two", "Work")];
        let mut first = upload(&s, &server);
        for m in &messages {
            assert!(matches!(first.upload_message(m).await, Outcome::Uploaded { .. }));
        }
        let searches = server.count_commands("SEARCH");

        // No header cache at all: only the server can say.
        let mut second = upload(&s, &server);
        assert_eq!(second.upload_message(&messages[0]).await, skipped("INBOX"));
        assert_eq!(second.upload_message(&messages[1]).await, skipped("Work"));
        assert_eq!(server.count_commands("APPEND"), 2, "uploaded once");
        assert!(server.count_commands("SEARCH") > searches, "the server's search answered");
        // Its Message-ID under another Subject is another message.
        assert_eq!(second.upload_message(&tmsg("a@x", "another subject", "Inbox")).await, uploaded("INBOX", 6));
    }

    /// The sync cached every row it counted and nothing arrived since: the rows
    /// answer alone, a message in them is skipped and a new one uploaded with
    /// no search, and the same message twice in one file goes up once.
    #[tokio::test]
    async fn a_whole_fresh_header_cache_answers_alone() {
        let mut scenario = gmail();
        scenario.state.find_mut("Work").unwrap().add(Message::new(1, stored("a@x", "one", "Work")));
        let server = MockImap::start(scenario);
        let (_v, s) = state();
        let row = json!({"uid": 1, "messageId": "<a@x>", "subject": "one", "messageDate": DATE});
        cache_headers(&s, "Work", json!({"uidValidity": 1, "syncTotalEmails": 1, "syncUidNext": 2, "emails": [row]}));
        let mut up = upload(&s, &server);

        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Work")).await, skipped("Work"));
        assert_eq!(up.upload_message(&tmsg("z@x", "new", "Work")).await, uploaded("Work", 2));
        assert_eq!(up.upload_message(&tmsg("z@x", "new", "Work")).await, skipped("Work"));
        assert_eq!(server.count_commands("SEARCH"), 0, "the rows are the folder: nothing to ask");
        assert_eq!(server.count_commands("APPEND"), 1);
    }

    /// Rows cached before the latest arrival are not the folder: a message they
    /// lack is looked for on the server.
    #[tokio::test]
    async fn a_header_cache_synced_before_the_last_arrival_is_checked_on_the_server() {
        let mut scenario = gmail();
        let work = scenario.state.find_mut("Work").unwrap();
        work.add(Message::new(1, stored("a@x", "one", "Work")));
        work.add(Message::new(2, stored("b@x", "two", "Work")));
        let server = MockImap::start(scenario);
        let (_v, s) = state();
        let row = json!({"uid": 1, "messageId": "<a@x>", "subject": "one", "messageDate": DATE});
        cache_headers(&s, "Work", json!({"uidValidity": 1, "syncTotalEmails": 1, "syncUidNext": 2, "emails": [row]}));
        let mut up = upload(&s, &server);

        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Work")).await, skipped("Work"));
        assert_eq!(server.count_commands("APPEND"), 0);
        assert!(server.count_commands("SEARCH") > 0);
    }

    /// Rows cached for an earlier folder of that name (another UIDVALIDITY: it
    /// was deleted and made again) describe mail that folder no longer holds.
    #[tokio::test]
    async fn rows_cached_for_another_generation_of_the_folder_skip_nothing() {
        let server = MockImap::start(gmail().mailbox(Mailbox::new("Work").with_uid_validity(77)));
        let (_v, s) = state();
        let row = json!({"uid": 1, "messageId": "<a@x>", "subject": "one", "messageDate": DATE});
        cache_headers(&s, "Work", json!({"uidValidity": 1, "emails": [row]}));
        let mut up = upload(&s, &server);

        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Work")).await, uploaded("Work", 1));
        assert_eq!(subjects(&server, "Work"), ["one"]);
    }

    /// A chat or draft has no Message-ID: only the cached rows can match it, by
    /// Subject and Date, and no search is sent for it.
    #[tokio::test]
    async fn a_message_without_a_message_id_is_matched_by_subject_and_date_in_the_cache() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        cache_headers(&s, "Work", json!({"emails": [{"uid": 1, "subject": "Chat with Ann", "messageDate": DATE}]}));
        let chat = |date: &str| format!("X-Gmail-Labels: Work,Chat\r\nSubject: Chat with Ann\r\nDate: {date}\r\n\r\nhi").into_bytes();
        let mut up = upload(&s, &server);

        assert_eq!(up.upload_message(&chat(DATE)).await, skipped("Work"));
        let later = "Tue, 05 Mar 2019 09:16:00 +0100";
        assert_eq!(up.upload_message(&chat(later)).await, uploaded("Work", 1));
        assert_eq!(up.upload_message(&chat(later)).await, skipped("Work"));
        assert_eq!(server.count_commands("SEARCH"), 0);
    }

    // ---- without UIDPLUS ----

    #[tokio::test]
    async fn without_uidplus_the_uid_comes_from_the_message_id() {
        let server = MockImap::start(gmail().without_cap("UIDPLUS"));
        let (v, s) = state();
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Inbox,Opened")).await, uploaded("INBOX", 5));
        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Inbox,Opened")).await, uploaded("INBOX", 6));
        assert_eq!(names_in(v.path(), "INBOX"), ["5:2,AS.eml", "6:2,AS.eml"]);
    }

    /// The lookup sees only an older copy of the same Message-ID (a search that
    /// lags the APPEND): its uid is below the folder's UIDNEXT before the
    /// APPEND, so it is not taken, and no vault copy is filed under it.
    #[tokio::test]
    async fn the_uid_lookup_never_takes_an_older_copy_of_the_same_message_id() {
        let mut scenario = gmail().without_cap("UIDPLUS");
        scenario.state.find_mut("INBOX").unwrap().add(Message::new(7, stored("a@x", "an older one", "Inbox")));
        // SEARCH 1 is the dedupe (which sees uid 7 as another message); SEARCH 2,
        // the lookup after the APPEND, answers with half its hits: uid 7 only.
        let server = MockImap::start(scenario.fault(Trigger::nth("SEARCH", 2), Action::PartialSearchResult(0.5)));
        let (v, s) = state();
        let mut up = upload(&s, &server);

        let got = up.upload_message(&tmsg("a@x", "one", "Inbox,Opened")).await;
        assert_eq!(got, Outcome::Uploaded { mailbox: "INBOX".into(), uid: None });
        assert_eq!(subjects(&server, "INBOX").last().unwrap(), "one", "stored at uid 8");
        assert!(names_in(v.path(), "INBOX").is_empty(), "no copy under another message's uid");
    }

    // ---- account and connection ----

    #[test]
    fn a_graph_account_is_refused_with_its_catalog_code() {
        let (_v, s) = state();
        let config: ImapConfig =
            serde_json::from_value(json!({"email": "u@outlook.com", "imapHost": "outlook.office365.com", "oauth2Transport": "graph"})).unwrap();
        let err = MboxUpload::new(s, config, "acct1".into(), "Archive".into(), true).err().expect("refused");
        assert!(err.starts_with("E_MBOX_SERVER_GRAPH: "), "{err}");
    }

    #[tokio::test]
    async fn a_literal_plus_server_gets_the_message_without_a_go_ahead() {
        let server = MockImap::start(gmail().with_cap("LITERAL+"));
        let (_v, s) = state();
        let msg = tmsg("a@x", "one", "Inbox");
        assert_eq!(upload(&s, &server).upload_message(&msg).await, uploaded("INBOX", 5));
        assert!(append_line(&server).ends_with(&format!("{{{}+}}", stored("a@x", "one", "Inbox").len())), "{}", append_line(&server));

        let plain = MockImap::start(gmail());
        assert_eq!(upload(&s, &plain).upload_message(&msg).await, uploaded("INBOX", 5));
        assert!(append_line(&plain).ends_with(&format!("{{{}}}", stored("a@x", "one", "Inbox").len())), "{}", append_line(&plain));
    }

    /// A NO is the server's answer on a connection still in step: kept. The
    /// fault only rewrites the reply, the mock's APPEND still ran; what the
    /// pipeline knows is the refusal, so it files no copy.
    #[tokio::test]
    async fn a_throttled_append_is_transient_and_keeps_the_connection() {
        let throttled = Action::Respond("NO".into(), "[THROTTLED] Too many commands, slow down".into());
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "throttle-me"), throttled));
        let (v, s) = state();
        let mut up = upload(&s, &server);

        let got = up.upload_message(&tmsg("a@x", "throttle-me", "Inbox")).await;
        assert!(matches!(&got, Outcome::Failed(FailKind::Transient, e) if e.contains("THROTTLED")), "{got:?}");
        assert_eq!(subjects(&server, "INBOX").last().unwrap(), "throttle-me", "the mock's APPEND ran");
        assert!(names_in(v.path(), "INBOX").is_empty());
        assert_eq!(up.upload_message(&tmsg("b@x", "next", "Inbox")).await, uploaded("INBOX", 6));
        assert_eq!(server.connection_count(), 1, "a tagged NO leaves the connection in step");
    }

    /// A BAD after a LITERAL+ APPEND can mean the server never took the
    /// literal as one and read the message as commands: the connection goes,
    /// and the next message gets a new one.
    #[tokio::test]
    async fn a_bad_reply_to_the_append_drops_the_connection() {
        let bad = Action::Respond("BAD".into(), "Invalid literal".into());
        let server = MockImap::start(gmail().with_cap("LITERAL+").fault(Trigger::with("APPEND", "bad-one"), bad));
        let (_v, s) = state();
        let mut up = upload(&s, &server);

        let got = up.upload_message(&tmsg("a@x", "bad-one", "Inbox")).await;
        assert!(matches!(got, Outcome::Failed(FailKind::Permanent, _)), "{got:?}");
        assert_eq!(up.upload_message(&tmsg("b@x", "next", "Inbox")).await, uploaded("INBOX", 6));
        assert_eq!(server.connection_count(), 2);
    }

    #[tokio::test]
    async fn a_refused_append_is_permanent() {
        let refused = Action::Respond("NO".into(), "[CANNOT] Message too large".into());
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "too-big"), refused));
        let (_v, s) = state();
        let got = upload(&s, &server).upload_message(&tmsg("a@x", "too-big", "Inbox")).await;
        assert!(matches!(&got, Outcome::Failed(FailKind::Permanent, e) if e.contains("too large")), "{got:?}");
    }

    /// Cut off during its APPEND: maybe stored, maybe not, so not sent again;
    /// the connection is dropped, and the next message gets a new one.
    #[tokio::test]
    async fn a_connection_lost_during_the_append_is_transient_and_the_next_message_reconnects() {
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "drop-me"), Action::DropConnection));
        let (_v, s) = state();
        let mut up = upload(&s, &server);

        let got = up.upload_message(&tmsg("a@x", "drop-me", "Inbox")).await;
        assert!(matches!(got, Outcome::Failed(FailKind::Transient, _)), "{got:?}");
        assert_eq!(server.count_commands("APPEND"), 1, "an APPEND is never sent twice");
        assert_eq!(subjects(&server, "INBOX").len(), 4, "the mock dropped it unstored");

        assert_eq!(up.upload_message(&tmsg("b@x", "next", "Inbox")).await, uploaded("INBOX", 5));
        assert_eq!(server.connection_count(), 2);
    }

    /// Dead before its APPEND went out: replaced once, and the message goes up.
    #[tokio::test]
    async fn a_connection_found_dead_before_the_append_is_replaced_once() {
        let server = MockImap::start(gmail().fault(Trigger::nth("SELECT", 2), Action::DropConnection));
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Inbox")).await, uploaded("INBOX", 5));
        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Work")).await, uploaded("Work", 1));
        assert_eq!(server.connection_count(), 2);
        assert_eq!(server.count_commands("APPEND"), 2);
    }

    /// A folder the run already used is gone from the server: the APPEND's
    /// `[TRYCREATE]` makes it again, once, and the message goes in.
    #[tokio::test]
    async fn an_append_into_a_folder_gone_from_the_server_makes_it_and_sends_once_more() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Work")).await, uploaded("Work", 1));
        server.mutate(|st| st.mailboxes.retain(|m| m.name != "Work"));

        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Work")).await, uploaded("Work", 1));
        assert_eq!(subjects(&server, "Work"), ["two"]);
        assert_eq!(server.count_commands("CREATE"), 1);
        assert_eq!(up.created().iter().collect::<Vec<_>>(), ["Work"]);
    }

    /// The folder was whole when the run opened it, then went: once the run
    /// makes it again, nothing the old folder held counts as there, and the
    /// server's search decides.
    #[tokio::test]
    async fn a_folder_made_again_mid_run_forgets_what_the_old_one_held() {
        // The old folder's uids (5, 6) are ones the new folder never reaches
        // here, so no new row can overwrite an old one in the view.
        let mut work = Mailbox::new("Work").with_uid_validity(77);
        work.add(Message::new(5, stored("a@x", "one", "Work")));
        let server = MockImap::start(gmail().mailbox(work));
        let (_v, s) = state();
        let row = json!({"uid": 5, "messageId": "<a@x>", "subject": "one", "messageDate": DATE});
        cache_headers(&s, "Work", json!({"uidValidity": 77, "syncTotalEmails": 1, "syncUidNext": 6, "emails": [row]}));
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("z@x", "new", "Work")).await, uploaded("Work", 6));
        server.mutate(|st| st.mailboxes.retain(|m| m.name != "Work"));

        assert_eq!(up.upload_message(&tmsg("y@x", "made again", "Work")).await, uploaded("Work", 1));
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Work")).await, uploaded("Work", 2));
        assert_eq!(up.upload_message(&tmsg("z@x", "new", "Work")).await, uploaded("Work", 3));
        assert_eq!(subjects(&server, "Work"), ["made again", "one", "new"]);
    }

    /// Two non-ASCII labels whose names differ only in the case of their
    /// base64 (日 is `&ZeU-`, 摅 is `&ZEU-`) are two folders. The mock looks
    /// names up case-blind, so what is asserted is what the pipeline sends.
    #[tokio::test]
    async fn labels_that_differ_only_in_the_case_of_their_utf7_are_two_folders() {
        let server = MockImap::start(gmail().mailbox(Mailbox::new("&ZeU-")));
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        let mailbox_of = |outcome: Outcome| match outcome {
            Outcome::Uploaded { mailbox, .. } => mailbox,
            other => panic!("{other:?}"),
        };
        assert_eq!(mailbox_of(up.upload_message(&tmsg("a@x", "one", "摅")).await), "&ZEU-");
        assert_eq!(mailbox_of(up.upload_message(&tmsg("b@x", "two", "日")).await), "&ZeU-");
        let creates: Vec<String> = server.commands().into_iter().filter(|c| c.contains(" CREATE ")).collect();
        assert_eq!(creates.len(), 1, "{creates:?}");
        assert!(creates[0].ends_with("CREATE \"&ZEU-\""), "{creates:?}");
    }

    // ---- fix round 1 ----

    /// A Subject with an encoded word that touches plain text (mailparse
    /// leaves it raw, the fetch decodes it), and a message with no Subject at
    /// all (the fetch writes `(No Subject)`): a second run finds both.
    #[tokio::test]
    async fn an_encoded_word_subject_and_a_missing_one_are_found_on_a_second_run() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let encoded = format!("Message-ID: <d@x>\r\nSubject: =?utf-8?Q?Dovan=C4=97l=C4=97_?=naujagimiui\r\nDate: {DATE}\r\n\r\ngift").into_bytes();
        let bare = format!("Message-ID: <e@x>\r\nDate: {DATE}\r\n\r\nno subject").into_bytes();
        let mut first = upload(&s, &server);
        assert_eq!(first.upload_message(&encoded).await, uploaded("[Gmail]/All Mail", 1));
        assert_eq!(first.upload_message(&bare).await, uploaded("[Gmail]/All Mail", 2));

        let mut second = upload(&s, &server);
        assert_eq!(second.upload_message(&encoded).await, skipped("[Gmail]/All Mail"));
        assert_eq!(second.upload_message(&bare).await, skipped("[Gmail]/All Mail"));
        assert_eq!(server.count_commands("APPEND"), 2);
    }

    /// Two messages share a Message-ID under different Subjects: a later run
    /// compares every copy the server search finds, not only one of them.
    #[tokio::test]
    async fn every_copy_of_a_message_id_on_the_server_is_compared_on_a_later_run() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let (one, another) = (tmsg("a@x", "one", "Inbox"), tmsg("a@x", "another subject", "Inbox"));
        assert_eq!(upload(&s, &server).upload_message(&one).await, uploaded("INBOX", 5));
        assert_eq!(upload(&s, &server).upload_message(&another).await, uploaded("INBOX", 6));

        let mut third = upload(&s, &server);
        assert_eq!(third.upload_message(&one).await, skipped("INBOX"));
        assert_eq!(third.upload_message(&another).await, skipped("INBOX"));
        assert_eq!(server.count_commands("APPEND"), 2);
    }

    /// The same, answered by the header cache alone.
    #[tokio::test]
    async fn every_cached_copy_of_a_message_id_is_compared() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let row = |uid: u32, subject: &str| json!({"uid": uid, "messageId": "<a@x>", "subject": subject, "messageDate": DATE});
        cache_headers(&s, "Work", json!({"emails": [row(5, "one"), row(6, "another subject")]}));
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Work")).await, skipped("Work"));
        assert_eq!(up.upload_message(&tmsg("a@x", "another subject", "Work")).await, skipped("Work"));
        assert_eq!(server.count_commands("APPEND"), 0);
    }

    /// A server that stops answering mid-APPEND is given up on within the
    /// bound: `Transient`, sent once, and the connection goes with it.
    #[tokio::test]
    async fn an_append_the_server_stops_answering_is_cut_off_and_transient() {
        let stall = Action::Delay(std::time::Duration::from_secs(4));
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "stalls"), stall));
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        up.append_floor_secs = 1;
        up.append_min_rate = u64::MAX;

        let started = std::time::Instant::now();
        let got = up.upload_message(&tmsg("a@x", "stalls", "Inbox")).await;
        assert!(matches!(&got, Outcome::Failed(FailKind::Transient, e) if e.contains("timed out")), "{got:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
        assert_eq!(server.count_commands("APPEND"), 1, "never sent twice");

        let next = up.upload_message(&tmsg("b@x", "next", "Inbox")).await;
        assert!(matches!(next, Outcome::Uploaded { .. }), "{next:?}");
        assert_eq!(server.connection_count(), 2, "the stalled connection is not used again");
    }

    /// Folders named like a busy server: a refusal stays `Permanent`.
    #[tokio::test]
    async fn a_folder_named_like_a_busy_server_keeps_a_refusal_permanent() {
        let refused = Action::Respond("NO".into(), "[CANNOT] Message too large".into());
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "too-big"), refused));
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        for (i, label) in ["Temporary", "Too many", "Try again", "Bandwidth"].into_iter().enumerate() {
            let got = up.upload_message(&tmsg(&format!("m{i}@x"), "too-big", label)).await;
            assert!(matches!(got, Outcome::Failed(FailKind::Permanent, _)), "{label}: {got:?}");
        }
        assert_eq!(server.connection_count(), 1, "a tagged NO keeps the connection");
    }

    /// A folder named like a missing one: a connection lost during its APPEND
    /// is not a `[TRYCREATE]`, so no folder is made and the message, which may
    /// have landed, is not sent again.
    #[tokio::test]
    async fn a_folder_named_like_a_missing_one_never_gets_a_second_append() {
        let scenario = gmail().mailbox(Mailbox::new("does not exist")).fault(Trigger::nth_with("APPEND", "drop-me", 1), Action::DropConnection);
        let server = MockImap::start(scenario);
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        let got = up.upload_message(&tmsg("a@x", "drop-me", "does not exist")).await;
        assert!(matches!(got, Outcome::Failed(FailKind::Transient, _)), "{got:?}");
        assert_eq!(server.count_commands("APPEND"), 1, "an APPEND that may have landed is never sent again");
        assert_eq!(server.count_commands("CREATE"), 0);
    }

    /// A folder named "no response:": a BAD still drops the connection.
    #[tokio::test]
    async fn a_folder_named_no_response_never_keeps_a_connection_out_of_step() {
        let bad = Action::Respond("BAD".into(), "Invalid literal".into());
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "bad-one"), bad));
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        let got = up.upload_message(&tmsg("a@x", "bad-one", "no response:")).await;
        assert!(matches!(got, Outcome::Failed(FailKind::Permanent, _)), "{got:?}");
        let next = up.upload_message(&tmsg("b@x", "next", "Inbox")).await;
        assert!(matches!(next, Outcome::Uploaded { .. }), "{next:?}");
        assert_eq!(server.connection_count(), 2, "dropped whatever the folder is called");
    }

    /// This run's uploads are remembered as fingerprints: the folder's view
    /// keeps only the cached rows, and a duplicate later in the file is still
    /// skipped with no search.
    #[tokio::test]
    async fn uploads_are_remembered_without_growing_the_folder_view() {
        let mut scenario = gmail();
        scenario.state.find_mut("Work").unwrap().add(Message::new(1, stored("a@x", "one", "Work")));
        let server = MockImap::start(scenario);
        let (_v, s) = state();
        let row = json!({"uid": 1, "messageId": "<a@x>", "subject": "one", "messageDate": DATE});
        cache_headers(&s, "Work", json!({"uidValidity": 1, "syncTotalEmails": 1, "syncUidNext": 2, "emails": [row]}));
        let mut up = upload(&s, &server);
        for i in 0..5 {
            let got = up.upload_message(&tmsg(&format!("z{i}@x"), &format!("new {i}"), "Work")).await;
            assert_eq!(got, uploaded("Work", i + 2));
        }
        let folder = &up.boxes["Work"];
        assert_eq!((folder.view.rows(), folder.uploaded.len()), (1, 5));

        assert_eq!(up.upload_message(&tmsg("z2@x", "new 2", "Work")).await, skipped("Work"));
        assert_eq!(server.count_commands("SEARCH"), 0);
    }

    /// The cached rows come a chunk of uids at a time, each chunk its own
    /// custody unit, and together they are every row the one-shot read gives.
    #[test]
    fn the_cache_is_read_a_chunk_at_a_time_with_every_row() {
        let (_v, s) = state();
        let rows: Vec<Value> =
            (1..=5).map(|uid| json!({"uid": uid, "messageId": format!("<m{uid}@x>"), "subject": format!("m{uid}"), "messageDate": DATE})).collect();
        cache_headers(&s, "Work", json!({ "emails": rows }));
        let mut chunks: Vec<Vec<Value>> = Vec::new();
        cached_rows(&s, "acct1", "Work", 2, |part| chunks.push(part)).unwrap();
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [2, 2, 1]);

        let uid_of = |r: &Value| r["uid"].as_u64().unwrap();
        let mut chunked: Vec<Value> = chunks.into_iter().flatten().collect();
        let mut whole = crate::custody::with_conn(&s, |c| cache::all_headers(c, "acct1", "Work")).unwrap();
        chunked.sort_by_key(uid_of);
        whole.sort_by_key(uid_of);
        assert_eq!(chunked, whole);
    }

    /// Without UIDPLUS: an earlier upload whose uid was never learned carries a
    /// Message-ID that contains this one, and the lookup search lags and sees
    /// only that one. Its uid is below this APPEND's UIDNEXT and its header is
    /// another message: not taken, so no vault copy is filed under it.
    #[tokio::test]
    async fn the_uid_lookup_never_names_an_earlier_upload_whose_id_holds_this_one() {
        // SEARCH 1 and 3 are the dedupes; 2 and 4 the lookups after each APPEND.
        let scenario = gmail()
            .without_cap("UIDPLUS")
            .fault(Trigger::nth("SEARCH", 2), Action::PartialSearchResult(0.0))
            .fault(Trigger::nth("SEARCH", 4), Action::PartialSearchResult(0.5));
        let server = MockImap::start(scenario);
        let (v, s) = state();
        let mut up = upload(&s, &server);
        let unknown = Outcome::Uploaded { mailbox: "INBOX".into(), uid: None };
        assert_eq!(up.upload_message(&tmsg("xa@x", "earlier", "Inbox")).await, unknown);
        assert_eq!(up.upload_message(&tmsg("a@x", "this one", "Inbox")).await, unknown);
        assert_eq!(subjects(&server, "INBOX")[4..], ["earlier", "this one"]);
        assert!(names_in(v.path(), "INBOX").is_empty(), "no copy under another message's uid");
    }

    /// Without UIDPLUS: between the APPEND and its lookup another message
    /// arrives whose Message-ID contains this one. Newer, so the highest uid,
    /// but its header is another message: the lookup keeps this one's uid.
    #[tokio::test]
    async fn the_uid_lookup_takes_only_a_copy_whose_header_is_this_message() {
        // SEARCH 2 is the lookup: it waits long enough for the other message to land.
        let wait = Action::Delay(std::time::Duration::from_millis(800));
        let server = MockImap::start(gmail().without_cap("UIDPLUS").fault(Trigger::nth("SEARCH", 2), wait));
        let (v, s) = state();
        let mut up = upload(&s, &server);
        // Gives up after about 10 s, so an upload that never stores the message
        // fails the test instead of stalling the run.
        let arrives = async {
            for _ in 0..2000 {
                if server.state().find("INBOX").unwrap().messages.len() >= 5 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            server.mutate(|st| {
                let inbox = st.find_mut("INBOX").unwrap();
                let uid = inbox.uid_next;
                inbox.add(Message::new(uid, stored("a@x.elsewhere", "someone else's", "Inbox")));
            });
        };
        let msg = tmsg("a@x", "one", "Inbox");
        let (got, ()) = tokio::join!(up.upload_message(&msg), arrives);
        assert_eq!(got, uploaded("INBOX", 5));
        assert_eq!(subjects(&server, "INBOX")[4..], ["one", "someone else's"]);
        assert_eq!(names_in(v.path(), "INBOX"), ["5:2,AS.eml"]);
    }

    /// A folder whose vault dir the registry has not listed is listed once,
    /// before its first copy, and never swept again per message.
    #[tokio::test]
    async fn a_folder_is_listed_once_not_swept_per_message() {
        let server = MockImap::start(gmail());
        let (v, s) = state();
        for uid in 1..=4 {
            seed_vault(v.path(), "INBOX", &format!("{uid}:2,S.eml"), format!("Message-ID: <old{uid}@x>\r\n\r\nold").as_bytes());
        }
        let reg = &s.vault_registry;
        assert_eq!(reg.listing_count(), 0);
        let mut up = upload(&s, &server);
        for i in 0..3 {
            let got = up.upload_message(&tmsg(&format!("n{i}@x"), &format!("n{i}"), "Inbox")).await;
            assert_eq!(got, uploaded("INBOX", 5 + i));
        }
        assert_eq!(reg.listing_count(), 1, "one listing for the folder, not a sweep per message");
        assert!(matches!(reg.known("acct1", "INBOX", 7), Some(Some(_))), "the registry answers for the folder");
        assert_eq!(names_in(v.path(), "INBOX").len(), 7);
    }

    /// A label too long for a directory name: the message is on the server,
    /// and nothing is written anywhere but inside the account's dir.
    #[tokio::test]
    async fn a_very_long_label_never_names_a_directory_outside_the_account() {
        let server = MockImap::start(gmail());
        let (v, s) = state();
        let label = "x".repeat(300);
        assert_eq!(upload(&s, &server).upload_message(&tmsg("a@x", "long", &label)).await, uploaded(&label, 1));
        let maildir = v.path().join("Maildir");
        let top: Vec<String> = std::fs::read_dir(&maildir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(top.iter().all(|name| name == "acct1"), "{top:?}");
    }

    // ---- classification ----

    /// An APPEND error as the pipeline sees it: our prefix naming the folder,
    /// then the server's or the socket's words.
    fn append_fail(folder: &str, rest: &str) -> Fail {
        let prefix = format!("IMAP APPEND to '{folder}' failed: ");
        Fail::named(&prefix, format!("{prefix}{rest}"), true)
    }

    fn no(info: &str) -> String {
        format!(r#"no response: code: None, info: Some("{info}")"#)
    }

    #[test]
    fn a_failure_is_transient_only_when_waiting_can_help() {
        for f in [
            append_fail("INBOX", &no("[THROTTLED] Too many commands")),
            append_fail("INBOX", &no("[UNAVAILABLE] Server busy, try again later")),
            append_fail("INBOX", &no("[ALERT] Account exceeded command or bandwidth limits. (Failure)")),
            append_fail("INBOX", &no("Rate limit exceeded")),
            append_fail("INBOX", "connection lost"),
            append_fail("INBOX", "io: connection lost: no reply from the server for 180s"),
            Fail::from("APPEND timed out after 120s".to_string()),
            Fail::named("SELECT INBOX failed: ", "SELECT INBOX failed: io: Broken pipe (os error 32)".into(), false),
            Fail::from(r#"Login failed for u@gmail.com: no response: code: None, info: Some("[ALERT] Too many simultaneous connections. (Failure)")"#.to_string()),
            Fail::from("TCP connect to imap.example.com:993 failed: future timed out".to_string()),
            Fail::from("Login for u@example.com timed out after 20s".to_string()),
        ] {
            assert_eq!(classify(&f.cause), FailKind::Transient, "{}", f.error);
        }
        for f in [
            append_fail("INBOX", &no("[CANNOT] Message too large")),
            append_fail("INBOX", r#"bad response: code: None, info: Some("Invalid arguments")"#),
            Fail::from(r#"Login failed for u@example.com: no response: code: None, info: Some("[AUTHENTICATIONFAILED] Invalid credentials")"#.to_string()),
            Fail::named("CREATE Evil failed: ", format!("CREATE Evil failed: {}", no("[CANNOT] create failure: NAME NOT ALLOWED")), false),
        ] {
            assert_eq!(classify(&f.cause), FailKind::Permanent, "{}", f.error);
        }
    }

    /// A folder name is a label the file chose: named "Temporary", "Too many",
    /// "Try again" or "Bandwidth" it never makes a refusal worth retrying;
    /// named "does not exist" it never makes a lost connection read as a
    /// missing folder; named "no response:" it never keeps a connection that
    /// failed on I/O.
    #[test]
    fn a_folder_name_never_sways_the_classifiers() {
        for folder in ["Temporary", "Too many", "Try again", "Bandwidth", "Rate limit", "[THROTTLED]", "timed out", "connection lost"] {
            let refused = append_fail(folder, &no("[CANNOT] Message too large"));
            assert_eq!(classify(&refused.cause), FailKind::Permanent, "{}", refused.error);
            assert!(is_tagged_no(&refused.cause));
        }
        for folder in ["does not exist", "[NONEXISTENT] Nonexistent", "TryCreate", "no response:"] {
            let lost = append_fail(folder, "connection lost");
            assert!(!needs_create(&lost.cause), "{}", lost.error);
            assert!(!is_tagged_no(&lost.cause), "{}", lost.error);
            assert_eq!(classify(&lost.cause), FailKind::Transient, "{}", lost.error);
        }
    }

    #[test]
    fn a_trycreate_code_or_a_missing_mailbox_wording_asks_for_the_folder() {
        assert!(needs_create(&append_fail("Work", r#"no response: code: Some(TryCreate), info: Some("Folder gone")"#).cause));
        let select = Fail::named("SELECT Work failed: ", format!("SELECT Work failed: {}", no("[NONEXISTENT] Unknown Mailbox: Work (Failure)")), false);
        assert!(needs_create(&select.cause));
        assert!(!needs_create(&append_fail("Work", "connection lost").cause));
        assert!(!needs_create(&append_fail("Work", "io: Mailbox does not exist").cause), "only a tagged NO says so");
        assert!(!needs_create(&append_fail("Work", &no("[CANNOT] Message too large")).cause));
    }

    // ---- Task 10: what the job needs from the pipeline ----

    /// A refused sign-in is the account's, not the message's: its own kind.
    /// Turned away because the server is busy, it stays worth a retry; a
    /// refused message stays `Permanent`.
    #[test]
    fn a_refused_sign_in_is_its_own_kind_and_a_busy_one_is_not() {
        for cause in [
            r#"Login failed for u@example.com: no response: code: None, info: Some("[AUTHENTICATIONFAILED] Invalid credentials")"#,
            r#"XOAUTH2 auth failed for u@gmail.com: no response: code: None, info: Some("Invalid credentials (Failure)")"#,
            "OAuth2 access token missing",
            "Password missing",
        ] {
            assert_eq!(kind_of(cause), FailKind::SignIn, "{cause}");
        }
        let busy = r#"Login failed for u@gmail.com: no response: code: None, info: Some("[ALERT] Too many simultaneous connections. (Failure)")"#;
        assert_eq!(kind_of(busy), FailKind::Transient);
        assert_eq!(kind_of(&no("[CANNOT] Message too large")), FailKind::Permanent);
        assert_eq!(kind_of("connection lost"), FailKind::Transient);
    }

    /// The server turns the sign-in away: the outcome says so, and no APPEND
    /// is sent.
    #[tokio::test]
    async fn a_refused_sign_in_is_reported_as_one() {
        let mut scenario = gmail();
        scenario.state.expect_login = Some(("user@example.com".into(), "another password".into()));
        let server = MockImap::start(scenario);
        let (_v, s) = state();
        let got = upload(&s, &server).upload_message(&tmsg("a@x", "one", "Inbox")).await;
        assert!(matches!(&got, Outcome::Failed(FailKind::SignIn, e) if e.contains("Login failed")), "{got:?}");
        assert_eq!(server.count_commands("APPEND"), 0);
    }

    /// An APPEND whose answer never came may have landed: its folder is
    /// touched, so the job's refresh at the end covers it (carry-in 2).
    #[tokio::test]
    async fn a_folder_an_append_went_out_to_is_touched_even_when_its_answer_never_came() {
        let server = MockImap::start(gmail().fault(Trigger::with("APPEND", "drop-me"), Action::DropConnection));
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        let got = up.upload_message(&tmsg("a@x", "drop-me", "Work")).await;
        assert!(matches!(got, Outcome::Failed(FailKind::Transient, _)), "{got:?}");
        assert_eq!(up.touched().iter().collect::<Vec<_>>(), ["Work"]);
    }

    /// A paused job lets its connection go; the next message makes a new one.
    #[tokio::test]
    async fn a_disconnected_pipeline_reconnects_for_the_next_message() {
        let server = MockImap::start(gmail());
        let (_v, s) = state();
        let mut up = upload(&s, &server);
        assert_eq!(up.upload_message(&tmsg("a@x", "one", "Inbox")).await, uploaded("INBOX", 5));
        up.disconnect();
        assert_eq!(up.upload_message(&tmsg("b@x", "two", "Inbox")).await, uploaded("INBOX", 6));
        assert_eq!(server.connection_count(), 2);
    }
}
