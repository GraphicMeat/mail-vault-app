//! The engine's one door to a mail server. Sync, replay, bodies and attachment downloads talk to
//! a [`Backend`], never to a protocol: [`open`] picks the implementation from `accounts.kind`
//! (`imap`, `graph`, `jmap`) and signs in.
//!
//! A backend does the network work and nothing the list shows: no event, no log line, and no write
//! to `messages`, `folders`, `bodies`, `attachments` or the journal. The callers keep those writes,
//! their chunking and their order between the network steps. A backend may write its own mapping
//! state, through the `&Shared` it was opened with: `remote_ids` and `uid_seq` (local uids for
//! remote ids) and `sync_state` (delta tokens), at most 200 rows per write transaction, and never
//! holding the writer across network I/O (fetch first, then write). Every method blocks the
//! calling thread (the sync, replay or attachment worker; the RPC thread for a body) until the
//! server answered. A failure's text has had the account's secrets scrubbed out already.
//!
//! Identity is `(account, folder path, u32 uid)` for every backend: IMAP's own uids, and for Graph
//! and JMAP a local uid from `remote_ids`, with the remote folder id in `folders.path` (JMAP's
//! entries are folder-qualified, since one email can sit in several mailboxes). A backend
//! that assigns local uids assigns them in ascending received-date order, so sync's
//! newest-uid-first fill matches the list's order.

pub(crate) mod graph;
pub(crate) mod imap;
pub(crate) mod jmap;

use crate::actions::Kind;
use crate::db::Shared;
use crate::sync::Fail;
use mailvault_core::imap::{EmailHeader, PartInfo};
use mailvault_core::smtp::OutgoingEmail;
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
    /// IMAP's UIDVALIDITY. A backend without one returns a stable constant (1): any value that
    /// changes between passes makes sync wipe and refetch the folder every pass.
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
    /// The server could not list the attachments this time (`parts` is empty for that, not
    /// because there are none): the body is shown but not cached, and the next open asks again.
    pub(crate) attachments_unknown: bool,
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
    /// Done. `gone`: uids the server no longer had (skipped). `kept`: uids the server still has
    /// where they were, the action not done for them (a move whose target went away part way):
    /// their rows stay and show again.
    Done { gone: Vec<u32>, moved: Option<Moved>, kept: Vec<u32> },
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

/// What a send came to: the bytes that went out, and whether the server filed its own Sent copy
/// (then [`Backend::file_sent`] has nothing to do).
#[derive(Clone, Debug, Default)]
pub(crate) struct SendOutcome {
    pub(crate) raw: Vec<u8>,
    pub(crate) server_saved_sent: bool,
}

/// A send that did not go through. `may_have_sent`: the failure came after the message could have
/// been accepted (a broken connection or timeout during or after the upload), so it must never be
/// sent again on its own. `terminal`: the server's answer was final (a permanent refusal, a
/// sign-in it refused), so a retry cannot help. Neither: nothing reached the server, try again.
pub(crate) struct SendFail {
    pub(crate) fail: Fail,
    pub(crate) may_have_sent: bool,
    pub(crate) terminal: bool,
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

/// Ends a [`Backend::wait_for_change`] from another thread. Setting it cannot wake a blocked read:
/// an implementation waits in short cycles (at most 1 s) and checks the flag between them, unless
/// Task 11 adds a notifier.
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
    /// a generation other than `folder.uid_validity` fails the call. May rely on state the backend
    /// kept from the preceding [`Backend::window`] of the same pass (headers it already listed).
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
    /// Builds `email` (core's `smtp::build_mime`, under `email.message_id`) and submits it.
    /// `Ok` means the server accepted it; nothing is filed in Sent yet. A failure says whether
    /// the message may have gone out anyway ([`SendFail`]); its text is scrubbed, for the log.
    fn send(&mut self, email: &OutgoingEmail) -> Result<SendOutcome, SendFail>;
    /// Files the bytes of an accepted send in the account's Sent folder, read, unless the server
    /// does that itself (`server_saved_sent`, Gmail over SMTP). Called after the outbox row is
    /// committed `sent`, so a failure here never sends the message again.
    fn file_sent(&mut self, sent: &SendOutcome) -> Result<(), Fail>;
    /// Waits until `folder` changes on the server or `stop` is set (Task 11). Checks `stop` at
    /// least once a second (see [`StopFlag`]).
    #[allow(dead_code)]
    fn wait_for_change(&mut self, folder: &FolderRow, stop: &StopFlag) -> Result<Change, Fail>;
}

/// Signs in to `account_id` with the backend its `kind` names. `Fail::Gone` when the account does
/// not exist, [`Fail::auth`] with no network at all while it waits for a new sign-in
/// (`needs_auth = 1`). The backend may keep `shared` for its mapping writes (see the module doc).
pub(crate) fn open<'a>(shared: &'a Shared, account_id: &str) -> Result<Box<dyn Backend + 'a>, Fail> {
    let row: Option<(String, i64)> = shared.read(|c| {
        c.query_row("SELECT kind, needs_auth FROM accounts WHERE id = ?1", [account_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    })?;
    match row {
        None => Err(Fail::Gone),
        Some((_, needs_auth)) if needs_auth != 0 => Err(Fail::auth()),
        Some((kind, _)) if kind == "imap" => Ok(Box::new(imap::ImapBackend::open(shared, account_id)?)),
        Some((kind, _)) if kind == "graph" => Ok(Box::new(graph::GraphBackend::open(shared, account_id)?)),
        Some((kind, _)) if kind == "jmap" => Ok(Box::new(jmap::JmapBackend::open(shared, account_id)?)),
        Some((other, _)) => Err(Fail::unsupported(&format!("account kind {other}"))),
    }
}
