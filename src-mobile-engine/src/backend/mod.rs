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
use crate::sync::{self, Fail};
use mailvault_core::imap::{EmailHeader, PartInfo};
use mailvault_core::send::classify::{classify_unsent, SendVerdict};
use mailvault_core::smtp::OutgoingEmail;
use rusqlite::OptionalExtension;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What [`Backend::arrivals`] listed, oldest first.
pub(crate) struct Arrivals {
    pub uids: Vec<u32>,
    /// Everything that arrived is listed (false: the listing stopped at the deadline, newer
    /// arrivals wait for the next pass).
    pub complete: bool,
}

impl Arrivals {
    pub(crate) fn all(uids: Vec<u32>) -> Arrivals {
        Arrivals { uids, complete: true }
    }
}

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
    /// The server sent only the start of the text (a JMAP body value over its cap): shown, never
    /// cached as the whole message.
    pub(crate) truncated: bool,
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
    /// A move that failed part way (a transient failure after some messages moved): `moved` went
    /// (the journal records them and their follow-ups follow them), `gone` were not there, the
    /// rest is retried. `error` is the failure's code and text.
    Partial { gone: Vec<u32>, moved: Moved, error: (crate::accounts::Code, String) },
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

/// A send that did not go through, with core's verdict on it: `MayHaveSent` (must never be sent
/// again on its own), `Terminal` (a final refusal, a retry cannot help) or `Transient` (nothing
/// reached the server, try again).
pub(crate) struct SendFail {
    pub(crate) fail: Fail,
    pub(crate) verdict: SendVerdict,
}

impl SendFail {
    /// A failure before any send started: nothing went out.
    pub(crate) fn unsent(fail: Fail, permanent: bool) -> Self {
        SendFail { fail, verdict: classify_unsent(permanent) }
    }
}

/// What ended a [`Backend::wait_for_change`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    /// The folder changed on the server: sync it.
    Changed,
    /// The wait ended without news (stopped, or the server's idle limit).
    Quiet,
}

/// Ends a [`Backend::wait_for_change`] from another thread. Setting it cannot wake a blocked read:
/// an implementation waits in short cycles (at most 1 s) and checks the flag between them.
#[derive(Debug, Default)]
pub(crate) struct StopFlag(AtomicBool);

impl StopFlag {
    pub(crate) fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// How often a wait checks its [`StopFlag`] (and the engine closing) while it sleeps or listens.
pub(crate) const STOP_CHECK: Duration = Duration::from_millis(250);

/// What a [`Backend::wait_for_change`] runs under: the flag that ends it, the engine (whose
/// closing ends it too), and its timing (`live.rs` holds the defaults; tests shorten them).
pub(crate) struct Watch {
    pub(crate) stop: Arc<StopFlag>,
    pub(crate) shared: Arc<Shared>,
    /// The account listened on: parking it (another worker refused its grant) ends the watch.
    pub(crate) account: String,
    /// The park generation (`Shared::parks`) last checked against the database.
    pub(crate) parks_seen: AtomicU64,
    /// The account was found parked.
    pub(crate) parked: AtomicBool,
    /// Between two cheap checks of a server that cannot push (Graph, IMAP without IDLE).
    pub(crate) poll: Duration,
    /// The longest one IMAP IDLE runs before it is ended and issued again.
    pub(crate) reissue: Duration,
}

impl Watch {
    /// Sleeps `wait` in [`STOP_CHECK`] slices; `false` as soon as the watch is stopped or the
    /// engine closes.
    pub(crate) fn nap(&self, wait: Duration) -> bool {
        let until = Instant::now() + wait;
        loop {
            if self.stopped() {
                return false;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            std::thread::sleep(left.min(STOP_CHECK));
        }
    }

    /// Stopped, the engine is closing, or the account was parked. One atomic read per check;
    /// the database is read only after some account was parked.
    pub(crate) fn stopped(&self) -> bool {
        if self.stop.is_stopped() || sync::not_closing(&self.shared).is_err() || self.parked.load(Ordering::SeqCst) {
            return true;
        }
        let parks = self.shared.parks.load(Ordering::SeqCst);
        if parks != self.parks_seen.swap(parks, Ordering::SeqCst) && self.is_parked_now() {
            self.parked.store(true, Ordering::SeqCst);
            return true;
        }
        false
    }

    /// `needs_auth` of the account, from the database.
    pub(crate) fn is_parked_now(&self) -> bool {
        self.shared
            .read(|c| c.query_row("SELECT needs_auth FROM accounts WHERE id = ?1", [&self.account], |r| r.get::<_, i64>(0)).optional())
            .ok()
            .flatten()
            .is_some_and(|n| n != 0)
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
    /// Whether `folder` may hold mail the last pass did not list, asked before a background run's
    /// pass. `true` (the default) runs the pass; a backend whose pass is expensive answers from a
    /// cheap request (Graph: the folder's newest message has no local uid yet).
    fn has_news(&mut self, _folder: &FolderRow) -> Result<bool, Fail> {
        Ok(true)
    }
    /// A background run's cheap listing: the uids (local uids mapped as for [`Backend::window`])
    /// of the messages in `folder` that may have arrived since the newest one held (`newest_uid`,
    /// received at `newest_ms`), oldest first, ready for [`Backend::headers`]: the caller inserts
    /// in that order, so a pass cut part way has missed nothing below what it inserted. A backend
    /// that lists page by page may stop at the pass's deadline with the oldest pages only
    /// ([`Arrivals::complete`] false): the caller inserts those and the next pass resumes after
    /// them. May include ones already held;
    /// the caller skips those. `None` when the backend has no cheap way, or the folder's
    /// generation is not `folder.uid_validity`: the full pass runs. Never stores delta state.
    fn arrivals(&mut self, _folder: &FolderRow, _newest_uid: u32, _newest_ms: i64) -> Result<Option<Arrivals>, Fail> {
        Ok(None)
    }
    /// The moment a background run's pass must stop: a backend does not wait out a throttle past
    /// it. `None` (the default) for every other pass.
    fn set_deadline(&mut self, _deadline: Option<Instant>) {}
    /// The pass over `folder` wrote everything it read (flags, removals, new rows). A backend
    /// commits here what must never run ahead of those writes (JMAP: the Email state its next
    /// `flags` follows). Not called when the pass failed or stopped part way.
    fn pass_done(&mut self, _folder: &str) -> Result<(), Fail> {
        Ok(())
    }
    /// Builds `email` (core's `smtp::build_mime`, under `email.message_id`) and submits it.
    /// `Ok` means the server accepted it; nothing is filed in Sent yet. A failure says whether
    /// the message may have gone out anyway ([`SendFail`]); its text is scrubbed, for the log.
    fn send(&mut self, email: &OutgoingEmail) -> Result<SendOutcome, SendFail>;
    /// Files the bytes of an accepted send in the account's Sent folder, read, unless the server
    /// does that itself (`server_saved_sent`: Graph and JMAP, core's `sent_copy_policy`; Gmail over
    /// SMTP is appended like any SMTP account). Called after the outbox row is
    /// committed `sent`, so a failure here never sends the message again.
    fn file_sent(&mut self, sent: &SendOutcome) -> Result<(), Fail>;
    /// Waits until `folder` changes on the server ([`Change::Changed`]) or the wait ends without
    /// news ([`Change::Quiet`]: `watch` was stopped, or an IMAP IDLE reached `watch.reissue`).
    /// Checks `watch` at least once a second between requests (a request on the wire, such as
    /// the first SELECT or stream open, is bounded by core's timeouts, not by the stop). IMAP idles (or, without IDLE, polls a STATUS
    /// every `watch.poll`), JMAP reads its EventSource, Graph polls the newest message. A backend
    /// keeps what it listens on across calls; after an `Err` the caller drops it.
    fn wait_for_change(&mut self, folder: &FolderRow, watch: &Watch) -> Result<Change, Fail>;
}

/// Signs in to `account_id` with the backend its `kind` names. `Fail::Gone` when the account does
/// not exist, [`Fail::auth`] with no network at all while it waits for a new sign-in
/// (`needs_auth = 1`). The backend may keep `shared` for its mapping writes (see the module doc).
///
/// A password-style account (password, app password, JMAP token) whose sign-in the server refused
/// is held for every worker (`hold.rs`): [`Fail`] `AUTH_FAILED` with no network until the user's
/// Retry.
pub(crate) fn open<'a>(shared: &'a Shared, account_id: &str) -> Result<Box<dyn Backend + 'a>, Fail> {
    let row: Option<(String, i64, String)> = shared.read(|c| {
        c.query_row("SELECT kind, needs_auth, auth FROM accounts WHERE id = ?1", [account_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
    })?;
    let Some((kind, needs_auth, auth)) = row else {
        return Err(Fail::Gone);
    };
    if needs_auth != 0 {
        return Err(Fail::auth());
    }
    let password = auth != "oauth2";
    let probing = if password { crate::hold::before_open(shared, account_id)? } else { false };
    let out: Result<Box<dyn Backend + 'a>, Fail> = match kind.as_str() {
        "imap" => imap::ImapBackend::open(shared, account_id).map(|b| Box::new(b) as Box<dyn Backend + 'a>),
        "graph" => graph::GraphBackend::open(shared, account_id).map(|b| Box::new(b) as Box<dyn Backend + 'a>),
        "jmap" => jmap::JmapBackend::open(shared, account_id).map(|b| Box::new(b) as Box<dyn Backend + 'a>),
        other => Err(Fail::unsupported(&format!("account kind {other}"))),
    };
    if password {
        crate::hold::after_open(shared, account_id, probing, &out);
        return out.map_err(crate::hold::signed_in);
    }
    out
}
