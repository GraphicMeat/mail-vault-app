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
//! (`ServerView::lists_same`: same Message-ID, Subject and Date). The cached
//! rows decide alone only while they are the whole folder as the server has it
//! (`lists_whole_mailbox`, judged once per folder per run against a SELECT);
//! otherwise `UID SEARCH HEADER Message-ID` does, so a message an earlier run
//! uploaded is found before any sync has cached it. A message with no
//! Message-ID has only the cached rows (Subject and Date) to go by.
//!
//! The connection is the pipeline's own, not a pooled one, and uncompressed
//! (`create_imap_session_no_compress`, one slot of the account's connection
//! budget): Hostinger hangs an APPEND on a compressed stream. The literal is
//! LITERAL+ where the server offers it, since the same host also hung waiting
//! for the synchronous literal's `+`. The connection is dropped after anything
//! but an OK or a tagged NO: an APPEND cut off mid-literal leaves the server
//! reading whatever comes next as message bytes. One found dead before its
//! APPEND went out is replaced once; an APPEND is never sent twice.
//!
//! The pipeline never waits or retries beyond that: a failure is `Transient`
//! (throttling, a lost connection: the job backs off and tries the message
//! again) or `Permanent` (the server refused this message).

// The upload job (Task 10) is its caller.
#![cfg_attr(not(test), allow(dead_code))]

use crate::handlers::common::{self, blocking};
use crate::imap::{self, pool, ImapConfig, ImapSession};
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use mailvault_core::import_rehome::{self, Head, ServerView};
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::takeout::{self, FolderRef, Home, Role};
use mailvault_core::{maildir, vault_files};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use tracing::{info, warn};

/// An Outlook (Graph) account has no IMAP to upload over (D4); the app shows
/// `errors.E_MBOX_SERVER_GRAPH`.
pub const E_MBOX_SERVER_GRAPH: &str = "E_MBOX_SERVER_GRAPH";

/// What the connection is for on the Network Activity page: one of the
/// purposes the app has a name for.
const PURPOSE: &str = "sync";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailKind {
    /// Throttling, a busy server, a lost or silent connection: worth another
    /// try once the caller has waited.
    Transient,
    /// The server refused this message, or the account (a rejected sign-in).
    Permanent,
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
}

struct Conn {
    session: ImapSession,
    literal_plus: bool,
    selected: Option<String>,
}

/// One folder as this run knows it, from its first message on.
struct Folder {
    /// What the header cache held, plus what this run put there.
    view: ServerView,
    /// `view` is the whole folder: a message it lacks is not on the server.
    whole: bool,
    /// The lowest uid a message appended from now on can get: UIDNEXT at the
    /// first SELECT, raised past every uid this run was given.
    floor: u32,
}

impl Folder {
    /// A folder this run made: nothing cached belongs to it, and the server's
    /// search decides what it holds.
    fn made_again() -> Self {
        Folder { view: ServerView::default(), whole: false, floor: 1 }
    }
}

/// Why an attempt stopped. `appended`: its APPEND went out, so the message may
/// be on the server whatever the error says.
struct Fail {
    error: String,
    appended: bool,
}

impl From<String> for Fail {
    fn from(error: String) -> Self {
        Fail { error, appended: false }
    }
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
        })
    }

    /// Every folder a message went into this run (one made for it included):
    /// what the header cache no longer matches.
    pub fn touched(&self) -> &BTreeSet<String> {
        &self.touched
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
            Err(f) if !f.appended && pool::is_connection_lost(&f.error) => {
                warn!("[mbox_upload] {}: {}; reconnecting once", self.config.email, f.error);
                self.conn = None;
                self.attempt(&msg).await
            }
            other => other,
        };
        match result {
            Ok(outcome) => outcome,
            Err(f) => {
                if !is_tagged_no(&f.error) {
                    self.conn = None;
                }
                let kind = classify(&f.error);
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
        let uid = self.append(&path, msg, &labels, &head).await?;
        self.touched.insert(path.clone());
        if let Some(f) = self.boxes.get_mut(&path) {
            if let Some(uid) = uid {
                f.floor = f.floor.max(uid.saturating_add(1));
            }
            // Known to the view, so the same message later in the file reads as
            // there; one it cannot place is left to the server's search.
            if !f.view.add(uid, &head) {
                f.whole = false;
            }
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
        let literal_plus = caps.has_str("LITERAL+");
        if self.folders.is_none() {
            let listed = imap::list_mailboxes(&mut session).await?;
            self.folders = Some(takeout::folder_refs_from_listing(&json!({ "mailboxes": listed }).to_string()));
        }
        self.conn = Some(Conn { session, literal_plus, selected: None });
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
            let low = e.to_ascii_lowercase();
            if !low.contains("alreadyexists") && !low.contains("already exists") {
                return Err(e.into());
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
        let mailbox = imap::select_mailbox(&mut conn.session, path).await?;
        conn.selected = Some(path.to_string());
        Ok(mailbox)
    }

    /// A folder's first message this run: its UIDVALIDITY and UIDNEXT from a
    /// SELECT (a folder gone from the server is made again), then what the
    /// header cache holds of it and whether that is all of it. Rows cached
    /// under another UIDVALIDITY, or for a folder this run made, describe an
    /// earlier folder of that name, not this one: they count for nothing.
    async fn open(&mut self, path: &str) -> Result<(), Fail> {
        if self.boxes.contains_key(path) {
            return Ok(());
        }
        let mailbox = match self.select(path).await {
            Err(f) if needs_create(&f.error) && !self.created.contains(path) => {
                self.create(path).await?;
                self.select(path).await?
            }
            other => other?,
        };
        let (validity, next) = (mailbox.uid_validity, mailbox.uid_next);
        if self.created.contains(path) {
            self.boxes.insert(path.to_string(), Folder { floor: next.unwrap_or(1), ..Folder::made_again() });
            return Ok(());
        }
        let (st, account, p) = (Arc::clone(&self.state), self.account_id.clone(), path.to_string());
        let read = blocking(move || {
            crate::custody::with_conn(&st, |c| {
                let (cached_validity, _) = cache::sync_meta(c, &account, &p)?;
                if cached_validity.is_some() && cached_validity != validity {
                    return Ok((ServerView::default(), false));
                }
                let view = ServerView::from_headers(&cache::all_headers(c, &account, &p)?);
                let whole = match (validity, next) {
                    (Some(v), Some(n)) => cache::lists_whole_mailbox(c, &account, &p, v, n)?,
                    _ => false,
                };
                Ok((view, whole))
            })
        })
        .await
        .and_then(|r| r);
        let (view, whole) = read.unwrap_or_else(|e| {
            warn!("[mbox_upload] header cache of {path} unreadable, the server decides: {e}");
            (ServerView::default(), false)
        });
        self.boxes.insert(path.to_string(), Folder { view, whole, floor: next.unwrap_or(1) });
        Ok(())
    }

    /// Whether `path` already holds this message: the cached rows, then, while
    /// they are not the whole folder, the server's own search.
    async fn on_server(&mut self, path: &str, head: &Head) -> Result<bool, Fail> {
        let Some(folder) = self.boxes.get(path) else { return Ok(false) };
        if folder.view.lists_same(head) {
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
        if uids.is_empty() {
            return Ok(false);
        }
        let (headers, _) = imap::fetch_headers_by_uids(&mut self.conn()?.session, path, &uids).await?;
        let rows: Vec<Value> = headers.iter().filter_map(|h| serde_json::to_value(h).ok()).collect();
        Ok(ServerView::from_headers(&rows).lists_same(head))
    }

    /// APPEND with the message's own date and, with labels, its Starred and
    /// read state (R5). A folder the server says is missing is made once and
    /// the APPEND sent once more. The uid: APPENDUID, else the newest copy of
    /// its Message-ID at or past the folder's `floor`.
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
        let mut sent = self.append_once(path, msg, &flags, date.as_deref()).await;
        // A tagged NO: nothing was stored, so the one resend is safe. The
        // folder is a new one now: what the run knew of the old one goes.
        if matches!(&sent, Err(e) if needs_create(e)) && !self.created.contains(path) {
            self.create(path).await?;
            self.boxes.insert(path.to_string(), Folder::made_again());
            if let Some(conn) = self.conn.as_mut() {
                conn.selected = None;
            }
            sent = self.append_once(path, msg, &flags, date.as_deref()).await;
        }
        match sent {
            Ok(Some((_, uid))) => Ok(Some(uid)),
            Ok(None) => Ok(self.lookup_uid(path, head).await),
            Err(error) => {
                // Anything but a clean refusal may have stored it: the next try
                // asks the server, not the rows.
                if !is_tagged_no(&error) {
                    if let Some(f) = self.boxes.get_mut(path) {
                        f.whole = false;
                    }
                }
                Err(Fail { error, appended: true })
            }
        }
    }

    async fn append_once(&mut self, path: &str, msg: &[u8], flags: &str, date: Option<&str>) -> Result<Option<(u32, u32)>, String> {
        let conn = self.conn.as_mut().ok_or("connection lost")?;
        imap::append_email_with(&mut conn.session, path, msg, flags, date, conn.literal_plus).await
    }

    /// The uid a server without UIDPLUS gave the message just appended: the
    /// newest copy of its Message-ID at or past the folder's floor, so an older
    /// copy of the same id, or a search that has not caught up with the
    /// APPEND, never names it. `None` when there is none or the lookup fails:
    /// the message is stored either way.
    async fn lookup_uid(&mut self, path: &str, head: &Head) -> Option<u32> {
        let id = head.id.as_deref()?;
        let floor = self.boxes.get(path).map_or(1, |f| f.floor);
        let found = match self.select(path).await {
            Ok(_) => match self.conn.as_mut() {
                Some(c) => imap::message_id_uids(&mut c.session, id).await,
                None => Err("connection lost".to_string()),
            },
            Err(f) => Err(f.error),
        };
        match found {
            Ok(uids) => uids.into_iter().filter(|u| *u >= floor).max(),
            Err(e) => {
                warn!("[mbox_upload] stored in {path}, its uid not found: {e}");
                if pool::is_connection_lost(&e) {
                    self.conn = None;
                }
                None
            }
        }
    }

    /// The vault's copy of what the server now holds at `uid`, where sync keeps
    /// it (the account id as sync and `auto_cache` key it; mode 2's own folders
    /// use the sanitized one, the same for a UUID id): archived plus the label
    /// flags, written like any server copy (`vault_files::store`, atomic, its
    /// registry row). Never over a different message at that uid: this copy
    /// then goes to `orphaned/`. A failure is only logged: the message is on
    /// the server, and the next sync or backup brings its copy in.
    async fn keep_copy(&self, path: &str, uid: u32, msg: &[u8], labels: &[String], head: &Head) {
        let flags = if self.use_labels { crate::mbox::label_flags(labels) } else { vec!["archived".to_string()] };
        let (st, account, p, raw, head) = (Arc::clone(&self.state), self.account_id.clone(), path.to_string(), msg.to_vec(), head.clone());
        let kept = blocking(move || {
            common::with_mailbox_write(&st, &account, &p, |root| {
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
            })
        })
        .await
        .and_then(|r| r);
        match kept {
            Ok(None) => {}
            Ok(Some(aside)) => warn!("[mbox_upload] the vault holds another message at {path} uid {uid}; this copy is kept at {aside:?}"),
            Err(e) => warn!("[mbox_upload] {path} uid {uid} is on the server, its vault copy was not written: {e}"),
        }
    }
}

/// A tagged NO: the server refused and the connection is still in step.
fn is_tagged_no(error: &str) -> bool {
    error.contains("no response:")
}

/// The server says the folder is not there: RFC 3501's `[TRYCREATE]` (the
/// parser's `TryCreate`) or a wording `is_missing_mailbox` knows.
fn needs_create(error: &str) -> bool {
    imap::is_missing_mailbox(error) || error.to_ascii_lowercase().contains("trycreate")
}

/// Throttling (Gmail's `[THROTTLED]` and "Too many simultaneous
/// connections", its bandwidth cap), a busy server, a dropped, silent or
/// unreachable connection: another try after a wait can work. Anything else
/// is this message, or this account (a rejected sign-in), refused.
fn classify(error: &str) -> FailKind {
    const WAIT: [&str; 10] =
        ["[throttled]", "[unavailable]", "[inuse]", "[limit]", "too many", "rate limit", "bandwidth", "try again", "temporar", "timed out"];
    let low = error.to_ascii_lowercase();
    if pool::is_retryable_connect_error(error) || imap::is_bandwidth_limited(error) || WAIT.iter().any(|n| low.contains(n)) {
        FailKind::Transient
    } else {
        FailKind::Permanent
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

    // ---- classification ----

    #[test]
    fn a_failure_is_transient_only_when_waiting_can_help() {
        let no = |info: &str| format!(r#"IMAP APPEND to 'INBOX' failed: no response: code: None, info: Some("{info}")"#);
        for e in [
            no("[THROTTLED] Too many commands"),
            no("[UNAVAILABLE] Server busy, try again later"),
            no("[ALERT] Account exceeded command or bandwidth limits. (Failure)"),
            no("Rate limit exceeded"),
            r#"Login failed for u@gmail.com: no response: code: None, info: Some("[ALERT] Too many simultaneous connections. (Failure)")"#.to_string(),
            "IMAP APPEND to 'INBOX' failed: connection lost".to_string(),
            "IMAP APPEND to 'INBOX' failed: io: connection lost: no reply from the server for 180s".to_string(),
            "SELECT INBOX failed: io: Broken pipe (os error 32)".to_string(),
            "TCP connect to imap.example.com:993 failed: future timed out".to_string(),
            "Login for u@example.com timed out after 20s".to_string(),
        ] {
            assert_eq!(classify(&e), FailKind::Transient, "{e}");
        }
        for e in [
            no("[CANNOT] Message too large"),
            r#"IMAP APPEND to 'INBOX' failed: bad response: code: None, info: Some("Invalid arguments")"#.to_string(),
            r#"Login failed for u@example.com: no response: code: None, info: Some("[AUTHENTICATIONFAILED] Invalid credentials")"#.to_string(),
            r#"CREATE Evil failed: no response: code: None, info: Some("[CANNOT] create failure: NAME NOT ALLOWED")"#.to_string(),
        ] {
            assert_eq!(classify(&e), FailKind::Permanent, "{e}");
        }
    }

    #[test]
    fn a_trycreate_code_or_a_missing_mailbox_wording_asks_for_the_folder() {
        assert!(needs_create(r#"IMAP APPEND to 'Work' failed: no response: code: Some(TryCreate), info: Some("Folder gone")"#));
        assert!(needs_create(r#"SELECT Work failed: no response: code: None, info: Some("[NONEXISTENT] Unknown Mailbox: Work (Failure)")"#));
        assert!(!needs_create("IMAP APPEND to 'Work' failed: connection lost"));
        assert!(!needs_create(r#"IMAP APPEND to 'Work' failed: no response: code: None, info: Some("[CANNOT] Message too large")"#));
    }
}
