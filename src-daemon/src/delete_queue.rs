//! The durable delete queue: a delete the user confirmed is written to the op
//! journal (`pending_ops` in app.db) BEFORE anything is sent, then sent by the
//! daemon itself, retried on the in-daemon schedule (`DELETE_RETRY_MS`), and
//! answered from the journal only once the server has it. What the daemon
//! learned on the way (send rounds, the last refusal per uid) is kept in the
//! entry, so it survives a restart and Settings can say why.
//!
//! - `submit` (RPC `delete_queue.submit`): journal first
//!   (`op_journal::queue_delete`, each uid owed by one delete entry at most),
//!   then `message_delete::delete_one` per uid on the priority lane, in send
//!   rounds. Each round counts once in the entry's `attempts` before it is
//!   sent. A landed uid gets the local bookkeeping
//!   (`handlers::archive::after_server_delete`), leaves every delete entry
//!   that owed it, and is announced with `delete-queue-landed`. A refused
//!   uid keeps its entry and its reason (`op_journal::note_failures`, one
//!   write per entry per round); the journal change is announced with
//!   `delete-queue-changed`.
//! - The submit always answers after its FIRST round, never after the whole
//!   schedule: what landed or was dropped so far, the rest `queued` (each
//!   refused one in `refused` with its reason). The later rounds go on in
//!   the same task, the claim still held, and what lands then is announced
//!   with `delete-queue-landed` like any replay's. A uid stuck on its
//!   capture (a 45 s ceiling per try) so delays only itself, never the undo
//!   or the custody of the rest of its batch.
//! - Only an identity change (`errors.bulkIdentityChanged`) is refused for
//!   good (`dropped`, its uid cleared), as the app's replay does. A capture
//!   the delete required that failed, a credential read that failed and a
//!   server refusal are all retryable: the entry stays.
//! - A uid is a name only inside one folder generation (UIDVALIDITY). The
//!   entry keeps the one its uids were read in (`arg.uidValidity`, from the
//!   daemon's header cache at submit, never the app's word; absent when
//!   unknown), and every send, the submit's own rounds and the replay's
//!   alike, goes only into that generation (`message_delete`, IMAP only). A
//!   server that renumbered the folder gets nothing: the uid is stopped
//!   (`op_journal::stop_by_id`), answered `dropped` with `RENUMBERED`, no
//!   longer owed (so no replay sends it and the app's relist shows its row
//!   again), and the rest of that entry is stopped with it unsent. The entry
//!   stays listed in Settings with the reason until the user cancels it. An
//!   entry with no recorded generation is sent as before.
//! - Offline (`NetGate` shut) nothing is sent; every uid is `queued`.
//! - One uid is never sent twice at once: a per-uid claim
//!   (`QueueState`, keyed by account, folder and uid) is held from before
//!   the first send to after the last; a second submit (or the replay
//!   worker, `worker`) that finds a uid claimed sends nothing for it and
//!   answers it `queued`, and the first one's `delete-queue-landed` says how
//!   it ended.
//! - Not queued: Graph accounts (their delete is addressed by a per-session
//!   message id the journal cannot replay) and vault-only local folders.
//!   `submit` refuses both before writing anything; a row the app knows is
//!   local-only (an unsent copy, a staged row) is the app's to keep out.
//!
//! Threading: every RPC is its own connection and tokio task, so the retry
//! sleeps (`tokio::time::sleep`) hold up nothing else. The work runs on its own
//! spawned task, so the delete goes on to its end even when the caller stops
//! waiting or has its answer already (a oneshot, sent once). Journal reads
//! and writes run on `spawn_blocking` under `DaemonState.journal`, which is
//! never held across an `.await`; the claim
//! set's mutex is held only to insert or remove keys. No lock is held across
//! the network.
//!
//! `delete_queue.list` answers the delete entries with their `attempts` and
//! `failures`; `delete_queue.cancel {id, uids}` clears those uids of one
//! entry and announces `delete-queue-changed`.

use crate::handlers::common::{blocking, done, str_arg, u64_arg, vec_arg};
use crate::ipc::{self, RpcResponse};
use crate::message_delete::{self, Mode, Outcome, Provider, Refusal};
use crate::server::DaemonState;
use mailvault_core::op_journal::{self, OpEntry};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

/// The wait before each retry round: 1, 2, 4, 8 and 16 s after the first send,
/// six rounds in all (the app's old `DELETE_RETRY` schedule).
pub(crate) const DELETE_RETRY_SCHEDULE_MS: [u64; 5] = [1000, 2000, 4000, 8000, 16000];

/// `DELETE_RETRY_SCHEDULE_MS`, with no waiting under test.
#[cfg(not(test))]
pub(crate) const DELETE_RETRY_MS: [u64; 5] = DELETE_RETRY_SCHEDULE_MS;
#[cfg(test)]
pub(crate) const DELETE_RETRY_MS: [u64; 5] = [0; 5];

/// The only refusal that is final: the message is not the one the user chose.
const IDENTITY_CHANGED: &str = "errors.bulkIdentityChanged";
/// A Graph account's delete is not queued.
const GRAPH_UNSUPPORTED: &str = "errors.bulkGraphDeleteUnsupported";
/// No such account here (removed, or never added).
const ACCOUNT_UNAVAILABLE: &str = "errors.bulkAccountUnavailable";
/// A vault-only folder (an MBOX import) has no server to delete from.
const LOCAL_FOLDER: &str = "errors.bulkUnsupported";
/// The folder was renumbered on the server since the delete was queued:
/// stopped, nothing sent (a catalog key: Settings shows it).
const RENUMBERED: &str = "errors.deleteQueueMailboxRenumbered";
/// A uid whose entry the user cancelled while it was being retried. Never
/// shown: the app asked for the cancel and already restores the row.
const CANCELLED: &str = "cancelled";

/// One delete the user confirmed.
#[derive(Debug, Clone)]
pub(crate) struct Submit {
    pub account_id: String,
    pub mailbox: String,
    pub uids: Vec<u32>,
    pub mode: Mode,
    pub bin: bool,
    /// What the app wants kept with the entry (Settings' subjects and
    /// senders, `{total, messages}`); the daemon adds `mode` and `bin`.
    pub arg: Value,
}

/// How each uid of a `Submit` ended.
#[derive(Debug, Default, PartialEq, Serialize)]
pub(crate) struct SubmitReply {
    /// Deleted on the server, or no longer there. Out of the journal.
    pub landed: Vec<Landed>,
    /// Still owed: refused so far (a submit answers after its first round
    /// while the retries go on), offline, or being sent by another submit
    /// right now. In the journal.
    pub queued: Vec<u32>,
    /// The uids of `queued` the server (or a capture the delete needed)
    /// refused on their last send, each with that reason: the wire string
    /// the entry's `failures` keeps (`E_BIN_CAPTURE:<reason>: <detail>`, a
    /// catalog key, or the server's text). Never one offline, unsent or left
    /// to another submit.
    pub refused: Vec<(u32, String)>,
    /// Refused for good, with the reason. Out of the journal.
    pub dropped: Vec<(u32, String)>,
}

/// A uid the server no longer holds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Landed {
    /// Deleted now: where it went (`trash`/`trashUid`, `None` for a permanent
    /// delete) and its bin copy, for an undo.
    Deleted {
        uid: u32,
        trash: Option<String>,
        #[serde(rename = "trashUid")]
        trash_uid: Option<u32>,
        #[serde(rename = "binId")]
        bin_id: Option<String>,
    },
    /// Already gone: nothing was there to delete.
    Gone { uid: u32 },
}

impl Landed {
    fn uid(&self) -> u32 {
        match self {
            Landed::Deleted { uid, .. } | Landed::Gone { uid } => *uid,
        }
    }
}

/// What one send means for the queue.
#[derive(Debug, PartialEq)]
pub(crate) enum Verdict {
    Landed(Landed),
    /// Final: clear the uid and say why.
    Drop(String),
    /// Keep it owed and try again; the reason is kept.
    Retry(String),
    /// Final, nothing was sent: no longer owed, but kept listed with the
    /// reason (`op_journal::stop_by_id`) until the user cancels it.
    Stop(String),
}

/// The queue's one reading of a `delete_one` result.
pub(crate) fn classify(uid: u32, result: &Result<Outcome, Refusal>) -> Verdict {
    match result {
        Ok(o) if o.gone && o.bin_id.is_none() => Verdict::Landed(Landed::Gone { uid }),
        Ok(o) => Verdict::Landed(Landed::Deleted { uid, trash: o.trash.clone(), trash_uid: o.trash_uid, bin_id: o.bin_id.clone() }),
        Err(Refusal::Renumbered) => Verdict::Stop(RENUMBERED.to_string()),
        Err(Refusal::Server(e)) if e.contains(IDENTITY_CHANGED) => Verdict::Drop(IDENTITY_CHANGED.to_string()),
        // A capture the delete required is retried, never dropped: the
        // message is still on the server and the user still wants it gone.
        Err(Refusal::BinCapture(e)) => Verdict::Retry(e.wire()),
        Err(Refusal::Server(e)) => Verdict::Retry(e.clone()),
    }
}

// ── The claim ───────────────────────────────────────────────────────────────

type Key = (String, String, u32);

/// The uids being sent right now, process-wide, and which of them the user
/// cancelled while they were being sent.
#[derive(Default)]
pub(crate) struct QueueState {
    inner: Mutex<Claims>,
    /// Held for the whole of one replay pass (`worker`): one pass at a time,
    /// whichever trigger started it.
    pub(crate) pass: tokio::sync::Mutex<()>,
    /// Journal writes the queue made (`note_attempt`, `note_failures`,
    /// `clear_by_id`), for the tests that pin one write per entry per round.
    #[cfg(test)]
    pub(crate) journal_writes: std::sync::atomic::AtomicUsize,
    /// Every send `(uid, priority lane)`, and every credential read's mode.
    #[cfg(test)]
    pub(crate) sends: Mutex<Vec<(u32, bool)>>,
    #[cfg(test)]
    pub(crate) reads: Mutex<Vec<crate::oauth_tokens::Read>>,
    /// Replay passes started, and the most ever running at once.
    #[cfg(test)]
    pub(crate) passes: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pub(crate) running: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pub(crate) most_running: std::sync::atomic::AtomicUsize,
    /// Makes the next replay pass panic (the worker's isolation test).
    #[cfg(test)]
    pub(crate) panic_next_pass: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
struct Claims {
    held: HashSet<Key>,
    /// Marked by `delete_queue.cancel` for a uid some submit holds, so that
    /// submit can tell a cancel from a uid another submit answered. Lives no
    /// longer than the claim.
    cancelled: HashSet<Key>,
}

impl QueueState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Claims> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn held(&self) -> usize {
        self.lock().held.len()
    }

    fn wrote(&self, n: usize) {
        #[cfg(test)]
        self.journal_writes.fetch_add(n, std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let _ = n;
    }
}

/// The uids one submit holds; released on drop, on every exit path.
struct Claim {
    state: Arc<DaemonState>,
    keys: Vec<Key>,
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut claims = self.state.delete_queue.lock();
        for key in &self.keys {
            claims.held.remove(key);
            claims.cancelled.remove(key);
        }
    }
}

/// Claim every uid of `uids` not claimed elsewhere: `(claim, held, busy)`.
fn claim(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uids: &[u32]) -> (Claim, Vec<u32>, Vec<u32>) {
    let mut claims = state.delete_queue.lock();
    let (mut keys, mut held, mut busy) = (Vec::new(), Vec::new(), Vec::new());
    for &uid in uids {
        let key = (account_id.to_string(), mailbox.to_string(), uid);
        if claims.held.insert(key.clone()) {
            keys.push(key);
            held.push(uid);
        } else {
            busy.push(uid);
        }
    }
    drop(claims);
    (Claim { state: Arc::clone(state), keys }, held, busy)
}

/// Whether the user cancelled `uid` while this submit held it.
fn was_cancelled(state: &DaemonState, account_id: &str, mailbox: &str, uid: u32) -> bool {
    state.delete_queue.lock().cancelled.contains(&(account_id.to_string(), mailbox.to_string(), uid))
}

/// `delete_queue.cancel`: clear `uids` of delete entry `id`, marking any a
/// submit is sending right now as cancelled first, so that submit reports
/// them `cancelled` rather than leaving them queued. `Ok(false)`: the entry
/// is already gone. Blocking: journal I/O under `state.journal`.
pub(crate) fn cancel(state: &DaemonState, id: u64, uids: &[u32]) -> Result<bool, String> {
    let _lock = state.journal.lock().unwrap_or_else(|p| p.into_inner());
    let entry = match op_journal::get(&state.app_dir, id)? {
        None => return Ok(false),
        Some(e) if e.op != "delete" => return Err("errors.bulkUnsupported".to_string()),
        Some(e) => e,
    };
    {
        let mut claims = state.delete_queue.lock();
        for uid in uids.iter().filter(|uid| entry.uids.contains(uid)) {
            let key = (entry.account_id.clone(), entry.mailbox.clone(), *uid);
            if claims.held.contains(&key) {
                claims.cancelled.insert(key);
            }
        }
    }
    op_journal::clear_by_id(&state.app_dir, id, uids)?;
    Ok(true)
}

// ── How a delete is sent ────────────────────────────────────────────────────

/// What differs between a delete the user is waiting on (`SUBMIT`) and the
/// replay of one already owed (`REPLAY`, the background worker).
#[derive(Clone, Copy, Debug)]
pub(crate) struct How {
    /// Send rounds: the first send plus `DELETE_RETRY_MS` retries for a
    /// submit, one for a replay (the worker's own triggers are its retries).
    rounds: usize,
    /// The IMAP pool's priority lane (a click) or its background lane.
    priority: bool,
    /// `Guarded` may raise the keychain prompt; `Quiet` never does.
    read: crate::oauth_tokens::Read,
    /// Whether an unreadable credential counts a send round and keeps its
    /// reason (a submit: the user asked now and Settings should say why) or
    /// leaves the entry exactly as it was and ends the account's pass (a
    /// replay: a locked keychain is not an answer from the server).
    credentials_count: bool,
    /// Wait for a quiet UI before each uid (`search_index::wait_foreground_quiet`).
    yields: bool,
    /// Whether a refusal counts one more replay pass for its uid
    /// (`Failure.passes`, what the worker's backoff reads).
    counts_pass: bool,
}

pub(crate) const SUBMIT: How = How { rounds: DELETE_RETRY_MS.len() + 1, priority: true, read: crate::oauth_tokens::Read::Guarded, credentials_count: true, yields: false, counts_pass: false };
pub(crate) const REPLAY: How = How { rounds: 1, priority: false, read: crate::oauth_tokens::Read::Quiet, credentials_count: false, yields: true, counts_pass: true };
/// `delete_queue.run` (Settings' Retry now): a replay the user asked for. It
/// restamps a refusal's time but counts no backoff pass, so the user's own
/// try never brings the daily wait closer.
pub(crate) const RETRY_NOW: How = How { counts_pass: false, ..REPLAY };

/// Why `send_owed` stopped before its rounds ran out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Halt {
    /// The connectivity gate is shut: nothing more can be sent anywhere.
    Offline,
    /// This account's credentials could not be read quietly.
    Account,
}

/// `send_owed`'s answer: the reply (its `refused`: the uids the server
/// refused on their last send, a subset of `queued`), and why it stopped
/// early.
#[derive(Debug, Default)]
pub(crate) struct Sent {
    pub reply: SubmitReply,
    pub halt: Option<Halt>,
}

// ── submit ──────────────────────────────────────────────────────────────────

/// Where a submit's first answer goes: the caller waiting on it, once.
type Answer = Option<tokio::sync::oneshot::Sender<Result<SubmitReply, String>>>;

/// Journal, send, retry and settle `s`, on its own task: a caller that stops
/// waiting does not stop the delete. Always answered after the first send
/// round (`send_owed`): what landed is settled then, and a uid still being
/// retried lands on its own `delete-queue-landed`.
pub(crate) async fn submit(state: &Arc<DaemonState>, s: Submit) -> Result<SubmitReply, String> {
    let st = Arc::clone(state);
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut answer = Some(tx);
        let result = run_answering(&st, s, &mut answer).await;
        if let Some(tx) = answer {
            let _ = tx.send(result);
        }
    });
    rx.await.map_err(|e| format!("delete queue worker failed: {e}"))?
}

/// `submit`'s body with every round on the caller's task, answered once they
/// end (tests drop it mid-send to stand in for a daemon killed between the
/// journal write and the first send).
pub(crate) async fn run(state: &Arc<DaemonState>, s: Submit) -> Result<SubmitReply, String> {
    run_answering(state, s, &mut None).await
}

/// `run`, answering `answer` early when `send_owed` does.
async fn run_answering(state: &Arc<DaemonState>, s: Submit, answer: &mut Answer) -> Result<SubmitReply, String> {
    if s.uids.is_empty() {
        return Ok(SubmitReply::default());
    }
    refuse_unqueued(state, &s.account_id, &s.mailbox).await?;

    // 1. The journal, before anything reaches the server, with the folder
    // generation the uids were read in.
    let arg = entry_arg(&s, recorded_generation(state, &s.account_id, &s.mailbox).await);
    let owed = {
        let (st, account_id, mailbox, uids, arg) = (Arc::clone(state), s.account_id.clone(), s.mailbox.clone(), s.uids.clone(), arg.clone());
        blocking(move || {
            let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
            std::fs::create_dir_all(&st.app_dir).map_err(|e| format!("Failed to create data directory: {e}"))?;
            op_journal::queue_delete(&st.app_dir, &account_id, &mailbox, &uids, &arg)
        })
        .await??
    };
    if owed.id.is_some() {
        changed(state);
    }
    #[cfg(test)]
    tests::after_journal(state);

    // Sent as journalled: a uid owed by an older entry goes by that entry's
    // generation (`still_owed`), this one by its own.
    let s = Submit { arg, ..s };
    Ok(send_owed_answering(state, &s, &owed.owners, SUBMIT, answer).await.reply)
}

/// The generation of `mailbox` the daemon's header cache holds (its native
/// owner's UIDVALIDITY, else the meta's `uidValidity`): the one the rows the
/// user chose from were read in. `None` when unknown or unreadable: nothing
/// is recorded and the delete is sent unchecked, as before.
async fn recorded_generation(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Option<u32> {
    let (st, account, folder) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || {
        crate::custody::with_conn(&st, |c| {
            let owner = mailvault_core::custody::cache::native_identity(c, &account, &folder).ok().flatten().and_then(|o| o.uid_validity);
            if owner.is_some() {
                return Ok(owner);
            }
            let meta = mailvault_core::custody::cache::load_meta(c, &account, &folder).ok().flatten();
            Ok(meta.and_then(|m| serde_json::from_str::<Value>(&m).ok()).and_then(|m| op_journal::uid_validity_of(&m)))
        })
    })
    .await
    .ok()
    .and_then(|r| r.ok())
    .flatten()
}

/// Send `s`'s uids, each owed by the entry `owners` names, in `how.rounds`
/// send rounds: claim, re-read what is still owed, count the round, send,
/// settle. Shared by `submit` and the replay worker.
pub(crate) async fn send_owed(state: &Arc<DaemonState>, s: &Submit, owners: &[(u32, u64)], how: How) -> Sent {
    send_owed_answering(state, s, owners, how, &mut None).await
}

/// `send_owed`, answering `answer` after the first round when a uid is still
/// to be retried: what landed or was dropped so far, the rest `queued` (with
/// its last refusal in `refused`). The later rounds go on here, the claim
/// held, and announce what lands. A dropped receiver stops nothing.
async fn send_owed_answering(state: &Arc<DaemonState>, s: &Submit, owners: &[(u32, u64)], how: How, answer: &mut Answer) -> Sent {
    let mut out = Sent::default();
    let owner: BTreeMap<u32, u64> = owners.iter().copied().collect();

    // The claim: a uid another submit (or a replay) is sending is left to it.
    let asked: Vec<u32> = owners.iter().map(|(uid, _)| *uid).collect();
    let (_claim, mut pending, busy) = claim(state, &s.account_id, &s.mailbox, &asked);
    out.reply.queued.extend(busy);

    let mut refused_any = false;
    // Each uid the latest round refused, with its reason.
    let mut refused_last: BTreeMap<u32, String> = BTreeMap::new();
    // The generation `s` was journalled in, for an owner the journal read
    // could not name.
    let journalled = op_journal::uid_validity_of(&s.arg);
    // Entries a send found renumbered: the rest of each is stopped unsent.
    let mut renumbered: HashSet<u64> = HashSet::new();
    for round in 0..how.rounds {
        if pending.is_empty() {
            break;
        }
        if round > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(DELETE_RETRY_MS[round - 1])).await;
        }
        #[cfg(test)]
        tests::before_round(state, round).await;
        // A uid its entry no longer owes is not sent again. Cancelled by the
        // user: `dropped`. Otherwise another submit owned it and answered it
        // (its `delete-queue-landed` says how): left to that one, `queued`,
        // never reported as refused.
        let (still, generations) = still_owed(state, &owner, &pending).await;
        for &uid in pending.iter().filter(|uid| !still.contains(uid)) {
            refused_last.remove(&uid);
            if was_cancelled(state, &s.account_id, &s.mailbox, uid) {
                out.reply.dropped.push((uid, CANCELLED.to_string()));
            } else {
                out.reply.queued.push(uid);
            }
        }
        pending.retain(|uid| still.contains(uid));
        if pending.is_empty() {
            break;
        }
        if !state.net.is_online() {
            info!("[delete-queue] {}/{}: offline, {} uid(s) stay queued", s.account_id, s.mailbox, pending.len());
            out.halt = Some(Halt::Offline);
            break;
        }
        let config = account_config(state, &s.account_id, how.read).await;
        if let (Err(e), false) = (&config, how.credentials_count) {
            // Not an answer, and not a round: the entry stays as it was.
            info!("[delete-queue] {}/{}: credentials not readable quietly, {} uid(s) stay queued: {e}", s.account_id, s.mailbox, pending.len());
            out.halt = Some(Halt::Account);
            break;
        }
        note_round(state, &owner, &pending).await;

        let mut landed = Vec::new();
        let mut dropped = Vec::new();
        let mut failed = Vec::new();
        let mut unsent = Vec::new();
        let mut stopped: Vec<(u32, String)> = Vec::new();
        let mut stop: Option<Halt> = None;
        match config {
            Err(e) => {
                // Not an answer: the credentials could not be read now.
                warn!("[delete-queue] {}/{}: credentials unavailable, round {} not sent: {e}", s.account_id, s.mailbox, round + 1);
                failed.extend(pending.iter().map(|uid| (*uid, e.clone())));
            }
            Ok(config) if config.uses_graph() && !config.uses_jmap() => {
                dropped.extend(pending.iter().map(|uid| (*uid, GRAPH_UNSUPPORTED.to_string())));
            }
            Ok(config) => {
                for &uid in &pending {
                    let entry = owner.get(&uid).copied();
                    if entry.is_some_and(|id| renumbered.contains(&id)) {
                        stopped.push((uid, RENUMBERED.to_string()));
                        continue;
                    }
                    if stop.is_some() {
                        unsent.push(uid);
                        continue;
                    }
                    if how.yields {
                        crate::search_index::wait_foreground_quiet(&state.search_index).await;
                    }
                    // The gate shut mid-round (a send below confirmed it):
                    // the rest wait for it to open, unsent and uncounted.
                    if !state.net.is_online() {
                        stop = Some(Halt::Offline);
                        unsent.push(uid);
                        continue;
                    }
                    // A replay re-checks the account before each uid: one
                    // that began closing (removal, a credential change)
                    // mid-entry keeps the rest, unsent and with no reason.
                    // A submit is the user's own click and goes on.
                    if !how.priority && state.account_lifecycle.capture(&s.account_id).is_err() {
                        stop = Some(Halt::Account);
                        unsent.push(uid);
                        continue;
                    }
                    let generation = entry.and_then(|id| generations.get(&id).copied()).unwrap_or(journalled);
                    let result = send(state, &config, s, uid, how.priority, generation).await;
                    match classify(uid, &result) {
                        Verdict::Landed(l) => {
                            state.net.note_success();
                            landed.push(l);
                        }
                        Verdict::Drop(reason) => dropped.push((uid, reason)),
                        Verdict::Retry(reason) => {
                            state.net.note_failure(&reason).await;
                            failed.push((uid, reason));
                        }
                        Verdict::Stop(reason) => {
                            renumbered.extend(entry);
                            stopped.push((uid, reason));
                        }
                    }
                }
            }
        }
        // What this round refused or left of a renumbered entry is that
        // generation too: stopped, never sent again.
        if !renumbered.is_empty() {
            let of_renumbered = |uid: &u32| owner.get(uid).is_some_and(|id| renumbered.contains(id));
            let (gone, kept): (Vec<_>, Vec<_>) = failed.into_iter().partition(|(uid, _)| of_renumbered(uid));
            failed = kept;
            stopped.extend(gone.into_iter().map(|(uid, _)| (uid, RENUMBERED.to_string())));
            let (gone, kept): (Vec<u32>, Vec<u32>) = unsent.into_iter().partition(of_renumbered);
            unsent = kept;
            stopped.extend(gone.into_iter().map(|uid| (uid, RENUMBERED.to_string())));
        }

        if !landed.is_empty() {
            settle_landed(state, &s.account_id, &s.mailbox, &landed).await;
        }
        if !dropped.is_empty() {
            let uids: Vec<u32> = dropped.iter().map(|(uid, _)| *uid).collect();
            clear_owned(state, &owner, &uids).await;
            for (uid, reason) in &dropped {
                warn!("[delete-queue] {}/{} uid={uid} dropped: {reason}", s.account_id, s.mailbox);
            }
            changed(state);
        }
        if !stopped.is_empty() {
            stop_owned(state, &owner, &stopped).await;
            warn!("[delete-queue] {}/{}: {} uid(s) stopped, nothing sent: the folder was renumbered on the server", s.account_id, s.mailbox, stopped.len());
            changed(state);
            out.reply.dropped.extend(stopped);
        }
        if !failed.is_empty() {
            refused_any = true;
            note_failures(state, &owner, &failed, how.counts_pass).await;
        }
        refused_last = failed.iter().cloned().collect();
        out.reply.landed.extend(landed);
        out.reply.dropped.extend(dropped);
        pending = failed.into_iter().map(|(uid, _)| uid).chain(unsent.iter().copied()).collect();
        if !unsent.is_empty() {
            let why = if stop == Some(Halt::Account) { "the account began closing" } else { "went offline" };
            info!("[delete-queue] {}/{}: {why}, {} uid(s) not sent", s.account_id, s.mailbox, unsent.len());
            out.halt = stop;
            break;
        }
        // A uid the user cancelled while this round sent it is not retried.
        pending.retain(|&uid| {
            if !was_cancelled(state, &s.account_id, &s.mailbox, uid) {
                return true;
            }
            refused_last.remove(&uid);
            out.reply.dropped.push((uid, CANCELLED.to_string()));
            false
        });
        // More rounds to come: the caller has what is settled now, and a
        // stuck uid delays only itself.
        if !pending.is_empty() && round + 1 < how.rounds {
            if let Some(tx) = answer.take() {
                let _ = tx.send(Ok(so_far(&out.reply, &pending, &refused_last)));
            }
        }
    }
    if !pending.is_empty() {
        info!("[delete-queue] {}/{}: {} uid(s) stay queued", s.account_id, s.mailbox, pending.len());
        if refused_any {
            changed(state);
        }
    }
    out.reply = so_far(&out.reply, &pending, &refused_last);
    out
}

/// The reply as it stands: `reply`'s landed and dropped, `pending` still
/// queued, each with the reason its latest round refused it (none for a uid
/// unsent or left to another submit).
fn so_far(reply: &SubmitReply, pending: &[u32], refused_last: &BTreeMap<u32, String>) -> SubmitReply {
    SubmitReply {
        landed: reply.landed.clone(),
        queued: reply.queued.iter().chain(pending).copied().collect(),
        refused: pending.iter().filter_map(|uid| refused_last.get(uid).map(|reason| (*uid, reason.clone()))).collect(),
        dropped: reply.dropped.clone(),
    }
}

/// The account's credentials, read `read`-wise (`Quiet` never raises the
/// keychain prompt).
#[cfg(not(test))]
async fn account_config(state: &DaemonState, account_id: &str, read: crate::oauth_tokens::Read) -> Result<crate::imap::ImapConfig, String> {
    crate::oauth_tokens::resolve(state, account_id, read).await
}

#[cfg(test)]
async fn account_config(state: &DaemonState, account_id: &str, read: crate::oauth_tokens::Read) -> Result<crate::imap::ImapConfig, String> {
    state.delete_queue.reads.lock().unwrap().push(read);
    crate::raw_message::account_config(state, account_id).await
}

/// The entry's `arg`: the app's, with the delete's own intent added so a
/// replay sends the same delete, and the folder generation the daemon read
/// (`generation`; none known: no key, whatever the app sent).
fn entry_arg(s: &Submit, generation: Option<u32>) -> Value {
    let mut arg = match &s.arg {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({}),
    };
    let mode = match s.mode {
        Mode::Auto => "auto",
        Mode::Trash => "trash",
        Mode::Permanent => "permanent",
    };
    arg["mode"] = json!(mode);
    arg["bin"] = json!(s.bin);
    if let Some(map) = arg.as_object_mut() {
        match generation {
            Some(v) => map.insert(op_journal::UID_VALIDITY_KEY.to_string(), json!(v)),
            None => map.remove(op_journal::UID_VALIDITY_KEY),
        };
    }
    arg
}

/// Graph accounts, unknown accounts and vault-only folders are never
/// journalled: refused before anything is written.
async fn refuse_unqueued(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Result<(), String> {
    let (st, account_id, mailbox) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || {
        let listing = mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&st.app_dir));
        admit(listing, &account_id)?;
        if vault_only_folder(&st, account_id, mailbox)? {
            return Err(LOCAL_FOLDER.to_string());
        }
        Ok(())
    })
    .await?
}

/// Whether `mailbox` is a vault-only folder (an MBOX import), which has no
/// server to delete from. No vault reachable: no local folder this delete
/// could be in (a server delete must not wait on an unplugged drive). A
/// reachable vault whose folder marker will not read is an `Err`: it may be
/// vault-only. Blocking: reads the vault. Shared by `submit` (refused before
/// journalling) and the replay worker (dropped).
pub(crate) fn vault_only_folder(state: &Arc<DaemonState>, account_id: String, mailbox: String) -> Result<bool, String> {
    if crate::handlers::common::vault_root(state).is_err() {
        return Ok(false);
    }
    crate::bulk_worker::native_local_folder(state, &mailvault_core::bulk::Group { account_id, mailbox, uids: Vec::new() })
}

/// The accounts listing's verdict on `account_id`, as a catalog key.
fn admit(listing: Result<mailvault_core::accounts_doc::Listing, mailvault_core::accounts_doc::AccountsError>, account_id: &str) -> Result<(), String> {
    let listing = listing.map_err(|e| {
        warn!("[delete-queue] accounts unreadable, nothing queued: {e:?}");
        ACCOUNT_UNAVAILABLE.to_string()
    })?;
    admit_listed(&listing, account_id)
}

/// A listing that read: no such account, or a Graph one, is refused.
fn admit_listed(listing: &mailvault_core::accounts_doc::Listing, account_id: &str) -> Result<(), String> {
    let Some(entry) = listing.accounts.iter().find(|a| a.get("id").and_then(Value::as_str) == Some(account_id)) else {
        return Err(ACCOUNT_UNAVAILABLE.to_string());
    };
    if entry.get("oauth2Transport").and_then(Value::as_str) == Some("graph") {
        return Err(GRAPH_UNSUPPORTED.to_string());
    }
    Ok(())
}

/// One `delete_one` on the account's provider (a JMAP account through its
/// session, any other through the IMAP pool's priority lane), into the folder
/// generation `generation` names (IMAP; `None`: unchecked).
async fn send(state: &Arc<DaemonState>, config: &crate::imap::ImapConfig, s: &Submit, uid: u32, priority: bool, generation: Option<u32>) -> Result<Outcome, Refusal> {
    #[cfg(test)]
    {
        state.delete_queue.sends.lock().unwrap().push((uid, priority));
        if let Some(scripted) = tests::scripted_send(state, uid) {
            return scripted;
        }
    }
    let provider = if config.uses_jmap() { Provider::Jmap(config) } else { Provider::Imap(config) };
    message_delete::delete_one_on(state, provider, &s.account_id, &s.mailbox, uid, s.mode, s.bin, priority, generation).await
}

/// The uids of `pending` their entries still owe, and the folder generation
/// each of those entries was queued in: one read per entry.
async fn still_owed(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, pending: &[u32]) -> (HashSet<u32>, BTreeMap<u64, Option<u32>>) {
    let by_id = by_owner(owner, pending.iter().copied());
    let st = Arc::clone(state);
    let read = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        let mut still = HashSet::new();
        let mut generations = BTreeMap::new();
        for (id, uids) in by_id {
            if let Some(entry) = op_journal::get(&st.app_dir, id)? {
                still.extend(uids.into_iter().filter(|uid| entry.uids.contains(uid)));
                generations.insert(id, entry.uid_validity());
            }
        }
        Ok::<_, String>((still, generations))
    })
    .await
    .and_then(|r| r);
    match read {
        Ok(read) => read,
        Err(e) => {
            // Unreadable is not "cancelled": keep sending what was asked
            // (each uid in the generation its send was journalled with).
            warn!("[delete-queue] journal unreadable, sending as asked: {e}");
            (pending.iter().copied().collect(), BTreeMap::new())
        }
    }
}

/// `items` grouped by the entry that owes each uid.
fn by_owner<T>(owner: &BTreeMap<u32, u64>, items: impl IntoIterator<Item = T>) -> BTreeMap<u64, Vec<T>>
where
    T: Owned,
{
    let mut grouped: BTreeMap<u64, Vec<T>> = BTreeMap::new();
    for item in items {
        if let Some(id) = owner.get(&item.uid()) {
            grouped.entry(*id).or_default().push(item);
        }
    }
    grouped
}

trait Owned {
    fn uid(&self) -> u32;
}
impl Owned for u32 {
    fn uid(&self) -> u32 {
        *self
    }
}
impl Owned for (u32, String) {
    fn uid(&self) -> u32 {
        self.0
    }
}

/// One more round for every entry that owes a uid of `pending`.
async fn note_round(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, pending: &[u32]) {
    let ids: std::collections::BTreeSet<u64> = pending.iter().filter_map(|uid| owner.get(uid).copied()).collect();
    let st = Arc::clone(state);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        st.delete_queue.wrote(ids.len());
        ids.into_iter().try_for_each(|id| op_journal::note_attempt(&st.app_dir, id))
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not count the send round: {e}");
    }
}

/// Keep the round's refusals: one write per entry, however many uids failed,
/// stamped by the daemon's clock (`state.clock`, the backoff's too). A
/// replay's round (`pass`) counts one more pass for each refused uid.
async fn note_failures(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, failed: &[(u32, String)], pass: bool) {
    let by_id = by_owner(owner, failed.iter().cloned());
    let st = Arc::clone(state);
    let at = u64::try_from(state.clock.now_ms()).unwrap_or(0);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        st.delete_queue.wrote(by_id.len());
        by_id.iter().try_for_each(|(id, round)| op_journal::note_failures_at(&st.app_dir, *id, round, at, pass))
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not keep the refusal reasons: {e}");
    }
}

/// Stop `stopped` in the entries that own them (`op_journal::stop_by_id`):
/// one write per entry.
async fn stop_owned(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, stopped: &[(u32, String)]) {
    let by_id = by_owner(owner, stopped.iter().cloned());
    let st = Arc::clone(state);
    let at = u64::try_from(state.clock.now_ms()).unwrap_or(0);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        st.delete_queue.wrote(by_id.len());
        by_id.iter().try_for_each(|(id, uids)| op_journal::stop_by_id(&st.app_dir, *id, uids, at))
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not stop the renumbered uids: {e}");
    }
}

/// Clear `uids` from the entries that own them.
async fn clear_owned(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, uids: &[u32]) {
    let by_id = by_owner(owner, uids.iter().copied());
    let st = Arc::clone(state);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        st.delete_queue.wrote(by_id.len());
        by_id.iter().try_for_each(|(id, uids)| op_journal::clear_by_id(&st.app_dir, *id, uids))
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not clear dropped uids: {e}");
    }
}

/// The server has these: local bookkeeping, then out of every delete entry
/// of this folder that owes them (one written by the app's own journal
/// included), then `delete-queue-landed`.
async fn settle_landed(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, landed: &[Landed]) {
    let uids: Vec<u32> = landed.iter().map(Landed::uid).collect();
    match state.account_lifecycle.capture(account_id).and_then(|stamp| state.account_lifecycle.try_operation(&[stamp])) {
        Ok(owner) => crate::handlers::archive::after_server_delete(state, account_id, mailbox, &uids, &owner).await,
        Err(_) => warn!("[delete-queue] {account_id}/{mailbox}: the account is closing; header cache and custody not updated for {} deleted uid(s)", uids.len()),
    }
    let (st, account, folder, gone) = (Arc::clone(state), account_id.to_string(), mailbox.to_string(), uids.clone());
    let cleared = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        let mut cleared = 0;
        for entry in op_journal::read(&st.app_dir) {
            if entry.op != "delete" || entry.account_id != account || entry.mailbox != folder {
                continue;
            }
            let owed: Vec<u32> = entry.uids.iter().copied().filter(|uid| gone.contains(uid)).collect();
            if !owed.is_empty() {
                st.delete_queue.wrote(1);
                op_journal::clear_by_id(&st.app_dir, entry.id, &owed)?;
                cleared += 1;
            }
        }
        Ok::<_, String>(cleared)
    })
    .await
    .and_then(|r| r);
    let cleared = cleared.unwrap_or_else(|e| {
        // The delete happened; a replay of a uid that is gone lands as gone.
        warn!("[delete-queue] {account_id}/{mailbox}: deleted, but the journal still lists them: {e}");
        0
    });
    state.events.emit("delete-queue-landed", json!({ "accountId": account_id, "mailbox": mailbox, "landed": landed }));
    // The queue itself changed too: a list that refreshes on `changed` must
    // not keep showing what just landed.
    if cleared > 0 {
        changed(state);
    }
}

fn changed(state: &Arc<DaemonState>) {
    state.events.emit("delete-queue-changed", json!({}));
}

// ── Routes ─────────────────────────────────────────────────────────────────

fn reply_json(reply: &SubmitReply) -> Value {
    json!({
        "landed": reply.landed,
        "queued": reply.queued,
        "refused": reply.refused.iter().map(|(uid, reason)| json!({"uid": uid, "reason": reason})).collect::<Vec<_>>(),
        "dropped": reply.dropped.iter().map(|(uid, reason)| json!({"uid": uid, "reason": reason})).collect::<Vec<_>>(),
    })
}

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "delete_queue.submit" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let mode = match Mode::from_params(params) {
                Ok(mode) => mode,
                Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, e)),
            };
            let bin = params.get("bin").and_then(Value::as_bool).unwrap_or(true);
            let arg = params.get("arg").cloned().unwrap_or_else(|| json!({}));
            let s = Submit { account_id, mailbox, uids, mode, bin, arg };
            done(id, submit(state, s).await.map(|reply| reply_json(&reply)))
        }
        "delete_queue.list" => {
            let st = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
                    let entries: Vec<OpEntry> = op_journal::read(&st.app_dir).into_iter().filter(|e| e.op == "delete").collect();
                    serde_json::to_value(entries).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "delete_queue.cancel" => {
            let entry = req!(u64_arg(&id, params, "id"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let st = Arc::clone(state);
            let result = blocking(move || cancel(&st, entry, &uids)).await.and_then(|r| r);
            if matches!(result, Ok(true)) {
                changed(state);
            }
            done(id, result.map(|_| Value::Null))
        }
        "delete_queue.run" => {
            let reason = params.get("reason").and_then(Value::as_str).unwrap_or(worker::MANUAL).to_string();
            done(id, worker::run_now(state, reason).await.map(|counts| json!(counts)))
        }
        _ => return None,
    })
}

mod worker;
pub(crate) use worker::spawn_worker;

#[cfg(test)]
pub(crate) mod tests;
