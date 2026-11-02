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
//!   that owed it, and is announced with `delete-queue-landed`. A uid still
//!   refused after the last round keeps its entry and its reason
//!   (`op_journal::note_failures`, one write per entry per round) and is
//!   answered as `queued`; the journal
//!   change is announced with `delete-queue-changed`.
//! - Only an identity change (`errors.bulkIdentityChanged`) is refused for
//!   good (`dropped`, its uid cleared), as the app's replay does. A capture
//!   the delete required that failed, a credential read that failed and a
//!   server refusal are all retryable: the entry stays.
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
//! waiting. Journal reads and writes run on `spawn_blocking` under
//! `DaemonState.journal`, which is never held across an `.await`; the claim
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
    /// Still owed: refused through every round, offline, or being sent by
    /// another submit right now. In the journal.
    pub queued: Vec<u32>,
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
}

/// The queue's one reading of a `delete_one` result.
pub(crate) fn classify(uid: u32, result: &Result<Outcome, Refusal>) -> Verdict {
    match result {
        Ok(o) if o.gone && o.bin_id.is_none() => Verdict::Landed(Landed::Gone { uid }),
        Ok(o) => Verdict::Landed(Landed::Deleted { uid, trash: o.trash.clone(), trash_uid: o.trash_uid, bin_id: o.bin_id.clone() }),
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
}

pub(crate) const SUBMIT: How = How { rounds: DELETE_RETRY_MS.len() + 1, priority: true, read: crate::oauth_tokens::Read::Guarded, credentials_count: true, yields: false };
pub(crate) const REPLAY: How = How { rounds: 1, priority: false, read: crate::oauth_tokens::Read::Quiet, credentials_count: false, yields: true };

/// Why `send_owed` stopped before its rounds ran out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Halt {
    /// The connectivity gate is shut: nothing more can be sent anywhere.
    Offline,
    /// This account's credentials could not be read quietly.
    Account,
}

/// `send_owed`'s answer: the reply, how many uids the server refused on
/// their last send (`refused`, a subset of `reply.queued`), and why it
/// stopped early.
#[derive(Debug, Default)]
pub(crate) struct Sent {
    pub reply: SubmitReply,
    pub refused: usize,
    pub halt: Option<Halt>,
}

// ── submit ──────────────────────────────────────────────────────────────────

/// Journal, send, retry and settle `s`, on its own task: a caller that stops
/// waiting does not stop the delete.
pub(crate) async fn submit(state: &Arc<DaemonState>, s: Submit) -> Result<SubmitReply, String> {
    let st = Arc::clone(state);
    tokio::spawn(async move { run(&st, s).await }).await.map_err(|e| format!("delete queue worker failed: {e}"))?
}

/// `submit`'s body, on the caller's task (tests drop it mid-send to stand in
/// for a daemon killed between the journal write and the first send).
pub(crate) async fn run(state: &Arc<DaemonState>, s: Submit) -> Result<SubmitReply, String> {
    if s.uids.is_empty() {
        return Ok(SubmitReply::default());
    }
    refuse_unqueued(state, &s.account_id, &s.mailbox).await?;

    // 1. The journal, before anything reaches the server.
    let arg = entry_arg(&s);
    let owed = {
        let (st, account_id, mailbox, uids) = (Arc::clone(state), s.account_id.clone(), s.mailbox.clone(), s.uids.clone());
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

    Ok(send_owed(state, &s, &owed.owners, SUBMIT).await.reply)
}

/// Send `s`'s uids, each owed by the entry `owners` names, in `how.rounds`
/// send rounds: claim, re-read what is still owed, count the round, send,
/// settle. Shared by `submit` and the replay worker.
pub(crate) async fn send_owed(state: &Arc<DaemonState>, s: &Submit, owners: &[(u32, u64)], how: How) -> Sent {
    let mut out = Sent::default();
    let owner: BTreeMap<u32, u64> = owners.iter().copied().collect();

    // The claim: a uid another submit (or a replay) is sending is left to it.
    let asked: Vec<u32> = owners.iter().map(|(uid, _)| *uid).collect();
    let (_claim, mut pending, busy) = claim(state, &s.account_id, &s.mailbox, &asked);
    out.reply.queued.extend(busy);

    let mut refused_any = false;
    let mut refused_last: HashSet<u32> = HashSet::new();
    for round in 0..how.rounds {
        if pending.is_empty() {
            break;
        }
        if round > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(DELETE_RETRY_MS[round - 1])).await;
        }
        // A uid its entry no longer owes is not sent again. Cancelled by the
        // user: `dropped`. Otherwise another submit owned it and answered it
        // (its `delete-queue-landed` says how): left to that one, `queued`,
        // never reported as refused.
        let still = still_owed(state, &owner, &pending).await;
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
                    if how.yields {
                        crate::search_index::wait_foreground_quiet(&state.search_index).await;
                    }
                    // The gate shut mid-round (a send below confirmed it):
                    // the rest wait for it to open, unsent and uncounted.
                    if !state.net.is_online() {
                        unsent.push(uid);
                        continue;
                    }
                    let result = send(state, &config, s, uid, how.priority).await;
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
                    }
                }
            }
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
        if !failed.is_empty() {
            refused_any = true;
            note_failures(state, &owner, &failed).await;
        }
        refused_last = failed.iter().map(|(uid, _)| *uid).collect();
        out.reply.landed.extend(landed);
        out.reply.dropped.extend(dropped);
        pending = failed.into_iter().map(|(uid, _)| uid).chain(unsent.iter().copied()).collect();
        if !unsent.is_empty() {
            info!("[delete-queue] {}/{}: went offline, {} uid(s) not sent", s.account_id, s.mailbox, unsent.len());
            out.halt = Some(Halt::Offline);
            break;
        }
    }
    if !pending.is_empty() {
        info!("[delete-queue] {}/{}: {} uid(s) stay queued", s.account_id, s.mailbox, pending.len());
        if refused_any {
            changed(state);
        }
    }
    out.refused = pending.iter().filter(|uid| refused_last.contains(uid)).count();
    out.reply.queued.extend(pending);
    out
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
/// replay sends the same delete.
fn entry_arg(s: &Submit) -> Value {
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
    arg
}

/// Graph accounts, unknown accounts and vault-only folders are never
/// journalled: refused before anything is written.
async fn refuse_unqueued(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Result<(), String> {
    let (st, account_id, mailbox) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || {
        let listing = mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&st.app_dir));
        admit(listing, &account_id)?;
        // No vault reachable: no local folder this delete could be in (the
        // server delete must not wait on an unplugged drive). A reachable
        // vault whose folder marker will not read is refused: it may be a
        // vault-only folder, which must never be journalled.
        if crate::handlers::common::vault_root(&st).is_ok() {
            let group = mailvault_core::bulk::Group { account_id, mailbox, uids: Vec::new() };
            if crate::bulk_worker::native_local_folder(&st, &group)? {
                return Err(LOCAL_FOLDER.to_string());
            }
        }
        Ok(())
    })
    .await?
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
/// session, any other through the IMAP pool's priority lane).
async fn send(state: &Arc<DaemonState>, config: &crate::imap::ImapConfig, s: &Submit, uid: u32, priority: bool) -> Result<Outcome, Refusal> {
    #[cfg(test)]
    {
        state.delete_queue.sends.lock().unwrap().push((uid, priority));
        if let Some(scripted) = tests::scripted_send(state, uid) {
            return scripted;
        }
    }
    let provider = if config.uses_jmap() { Provider::Jmap(config) } else { Provider::Imap(config) };
    message_delete::delete_one_on(state, provider, &s.account_id, &s.mailbox, uid, s.mode, s.bin, priority).await
}

/// The uids of `pending` their entries still owe: one read per entry.
async fn still_owed(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, pending: &[u32]) -> HashSet<u32> {
    let by_id = by_owner(owner, pending.iter().copied());
    let st = Arc::clone(state);
    let read = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        let mut still = HashSet::new();
        for (id, uids) in by_id {
            if let Some(entry) = op_journal::get(&st.app_dir, id)? {
                still.extend(uids.into_iter().filter(|uid| entry.uids.contains(uid)));
            }
        }
        Ok::<_, String>(still)
    })
    .await
    .and_then(|r| r);
    match read {
        Ok(still) => still,
        Err(e) => {
            // Unreadable is not "cancelled": keep sending what was asked.
            warn!("[delete-queue] journal unreadable, sending as asked: {e}");
            pending.iter().copied().collect()
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

/// Keep the round's refusals: one write per entry, however many uids failed.
async fn note_failures(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, failed: &[(u32, String)]) {
    let by_id = by_owner(owner, failed.iter().cloned());
    let st = Arc::clone(state);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        st.delete_queue.wrote(by_id.len());
        by_id.iter().try_for_each(|(id, round)| op_journal::note_failures(&st.app_dir, *id, round))
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not keep the refusal reasons: {e}");
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
