//! The engine's one door to a mail server. Sync, replay, bodies and attachment downloads talk to
//! a [`Backend`], never to a protocol: [`open`] picks the implementation from `accounts.kind`
//! (`imap` today; Graph and JMAP later) and signs in.
//!
//! A backend does network work only: no `mobile.db` write, no event, no log line. The callers keep
//! every write, its chunking and its order between the network steps. Every method blocks the
//! calling thread (the sync, replay or attachment worker; the RPC thread for a body) until the
//! server answered. A failure's text has had the account's secrets scrubbed out already.
//!
//! Identity is `(account, folder path, u32 uid)` for every backend: IMAP's own uids, and for Graph
//! and JMAP a local uid from `remote_ids`, with the remote folder id in `folders.path`.

pub(crate) mod imap;

use crate::actions::Kind;
use crate::db::Shared;
use crate::sync::Fail;
use mailvault_core::imap::{EmailHeader, PartInfo};
use rusqlite::OptionalExtension;
use std::sync::atomic::{AtomicBool, Ordering};

/// A folder as a backend call names it: its stored path (the remote id) and the generation the
/// caller's uids belong to (IMAP's UIDVALIDITY). What `None` means is up to each method.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FolderRow {
    pub(crate) path: String,
    pub(crate) uid_validity: Option<i64>,
}

impl FolderRow {
    pub(crate) fn new(path: &str, uid_validity: Option<i64>) -> FolderRow {
        FolderRow { path: path.to_string(), uid_validity }
    }
}

/// One folder of the server's list.
#[derive(Clone, Debug)]
pub(crate) struct FolderInfo {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) special_use: Option<String>,
    pub(crate) delimiter: Option<String>,
    pub(crate) noselect: bool,
    /// `(unseen, total)`, `None` when the server did not count it (not selectable, or its STATUS
    /// was refused): the stored counts stay.
    pub(crate) counts: Option<(i64, i64)>,
}

/// A folder as a pass opens it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Selected {
    pub(crate) uid_validity: i64,
    pub(crate) uid_next: Option<i64>,
    pub(crate) total: i64,
}

/// The folder's sync window: the uids that arrived since its first day, and the folder's unread
/// count (the whole folder, not only the window).
#[derive(Clone, Debug)]
pub(crate) struct Window {
    pub(crate) uids: Vec<u32>,
    pub(crate) unseen: i64,
}

/// A list row's headers, as core reads them.
pub(crate) type Header = EmailHeader;

/// The flags a list row shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Flags {
    pub(crate) seen: bool,
    pub(crate) flagged: bool,
}

impl Flags {
    /// From IMAP-style flag names (`\Seen`, `\Flagged`, any case).
    pub(crate) fn of(flags: &[String]) -> Flags {
        Flags { seen: has_flag(flags, "\\Seen"), flagged: has_flag(flags, "\\Flagged") }
    }
}

pub(crate) fn has_flag(flags: &[String], flag: &str) -> bool {
    flags.iter().any(|f| f.eq_ignore_ascii_case(flag))
}

/// A message's readable body: every part, and the decoded text of the first `text/html` and
/// first `text/plain` part that are not attachments.
#[derive(Clone, Debug)]
pub(crate) struct RawBody {
    pub(crate) parts: Vec<PartInfo>,
    pub(crate) html: Option<String>,
    pub(crate) text: Option<String>,
}

/// Where a move put its messages, when the server said: `(old uid, new uid)` pairs and the
/// target's generation.
#[derive(Clone, Debug)]
pub(crate) struct Moved {
    pub(crate) pairs: Vec<(u32, u32)>,
    pub(crate) uid_validity: Option<i64>,
}

/// What the server made of one journaled action, in network facts; the journal decides what each
/// means for the action (`actions::run_action`).
#[derive(Debug)]
pub(crate) enum ApplyOutcome {
    /// Done. `gone`: uids the server no longer had (skipped).
    Done { gone: Vec<u32>, moved: Option<Moved> },
    /// None of the uids is in the folder (proven by the server's answer); nothing was sent.
    NonePresent,
    /// The folder, or a move's target, is proven gone.
    FolderGone,
    /// The folder's generation is not the journaled one: the uids name other messages, or none.
    OtherGeneration,
    /// The server answered a command with a refusal (its text, for the log).
    Refused(String),
}

/// The journal's hook into [`Backend::apply`]: called once, right before the first command that
/// moves or deletes goes on the wire, to record that it may have happened.
pub(crate) type BeforeWire<'a> = &'a mut dyn FnMut() -> Result<(), Fail>;

/// An outgoing message's SMTP envelope. Filled by compose (Task 5).
#[allow(dead_code)]
#[derive(Clone, Debug, Default)]
pub(crate) struct Envelope {
    pub(crate) from: String,
    pub(crate) to: Vec<String>,
}

/// What a send came to. Filled by compose (Task 5).
#[allow(dead_code)]
#[derive(Clone, Debug, Default)]
pub(crate) struct SendOutcome {
    pub(crate) message_id: Option<String>,
}

/// What ended a [`Backend::wait_for_change`] (Task 11).
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    /// The folder changed on the server: sync it.
    Changed,
    /// The wait ended without news (stopped, or the server's idle limit).
    Quiet,
}

/// Ends a [`Backend::wait_for_change`] from another thread.
#[allow(dead_code)]
#[derive(Debug, Default)]
pub(crate) struct StopFlag(AtomicBool);

#[allow(dead_code)]
impl StopFlag {
    pub(crate) fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// One signed-in connection to an account's server. Dropping it signs out.
pub(crate) trait Backend: Send {
    /// Every folder the server lists, with its counts.
    fn folders(&mut self) -> Result<Vec<FolderInfo>, Fail>;
    /// Opens `folder` for a pass: its generation, next uid and message count.
    fn select(&mut self, folder: &str) -> Result<Selected, Fail>;
    /// The uids in `folder` that arrived on or after the day of `window_start_ms`, and its unread
    /// count.
    fn window(&mut self, folder: &str, window_start_ms: i64) -> Result<Window, Fail>;
    /// The headers of `uids` (at most one write chunk). A uid the server no longer has is left out;
    /// a generation other than `folder.uid_validity` fails the call.
    fn headers(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<Header>, Fail>;
    /// The flags of `uids`. A uid missing from the reply is not reported (the window decides what is
    /// gone); a generation other than `folder.uid_validity` fails the call.
    fn flags(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<(u32, Flags)>, Fail>;
    /// The parts of `uid`. `None` when the uid is gone or the folder's generation is not
    /// `folder.uid_validity`. Leaves the folder ready for [`Backend::part_range`].
    fn parts(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<Vec<PartInfo>>, Fail>;
    /// The parts and readable body of `uid`; `None` as [`Backend::parts`], or when the uid went
    /// away between the parts and the text.
    fn body(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<RawBody>, Fail>;
    /// Raw (transfer-encoded) octets `offset..offset + len` of part `section`, after
    /// [`Backend::parts`] of the same uid. `None` when the uid is gone; fewer than `len` octets at
    /// the part's end.
    fn part_range(&mut self, folder: &FolderRow, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, Fail>;
    /// Applies one journaled action to `uids` of `folder` (a move to `target`). When
    /// `folder.uid_validity` is set, another generation is [`ApplyOutcome::OtherGeneration`].
    /// `before_wire` runs before the first command of a move or delete.
    fn apply(
        &mut self,
        folder: &FolderRow,
        kind: Kind,
        uids: &[u32],
        target: Option<&str>,
        before_wire: BeforeWire<'_>,
    ) -> Result<ApplyOutcome, Fail>;
    /// Sends one message (Task 5).
    #[allow(dead_code)]
    fn send(&mut self, raw: &[u8], envelope: &Envelope) -> Result<SendOutcome, Fail>;
    /// Waits until `folder` changes on the server or `stop` is set (Task 11).
    #[allow(dead_code)]
    fn wait_for_change(&mut self, folder: &FolderRow, stop: &StopFlag) -> Result<Change, Fail>;
}

/// Signs in to `account_id` with the backend its `kind` names. `Fail::Gone` when the account does
/// not exist.
pub(crate) fn open(shared: &Shared, account_id: &str) -> Result<Box<dyn Backend>, Fail> {
    let kind: Option<String> =
        shared.read(|c| c.query_row("SELECT kind FROM accounts WHERE id = ?1", [account_id], |r| r.get(0)).optional())?;
    match kind.as_deref() {
        None => Err(Fail::Gone),
        Some("imap") => Ok(Box::new(imap::ImapBackend::open(shared, account_id)?)),
        Some(other) => Err(Fail::unsupported(&format!("account kind {other}"))),
    }
}
