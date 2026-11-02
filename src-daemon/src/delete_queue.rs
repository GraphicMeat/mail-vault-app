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
//!   (`op_journal::note_failure`) and is answered as `queued`; the journal
//!   change is announced with `delete-queue-changed`.
//! - Only an identity change (`errors.bulkIdentityChanged`) is refused for
//!   good (`dropped`, its uid cleared), as the app's replay does. A capture
//!   the delete required that failed, a credential read that failed and a
//!   server refusal are all retryable: the entry stays.
//! - Offline (`NetGate` shut) nothing is sent; every uid is `queued`.
//! - One uid is never sent twice at once: a per-uid claim
//!   (`QueueState`, keyed by account, folder and uid) is held from before
//!   the first send to after the last; a second submit (or, from Task 7, the
//!   replay worker) that finds a uid claimed sends nothing for it and
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

/// The uids being sent right now, process-wide.
#[derive(Default)]
pub(crate) struct QueueState {
    claims: Mutex<HashSet<Key>>,
}

/// The uids one submit holds; released on drop, on every exit path.
struct Claim {
    state: Arc<DaemonState>,
    keys: Vec<Key>,
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut claims = self.state.delete_queue.claims.lock().unwrap_or_else(|p| p.into_inner());
        for key in &self.keys {
            claims.remove(key);
        }
    }
}

/// Claim every uid of `uids` not claimed elsewhere: `(claim, held, busy)`.
fn claim(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uids: &[u32]) -> (Claim, Vec<u32>, Vec<u32>) {
    let mut claims = state.delete_queue.claims.lock().unwrap_or_else(|p| p.into_inner());
    let (mut keys, mut held, mut busy) = (Vec::new(), Vec::new(), Vec::new());
    for &uid in uids {
        let key = (account_id.to_string(), mailbox.to_string(), uid);
        if claims.insert(key.clone()) {
            keys.push(key);
            held.push(uid);
        } else {
            busy.push(uid);
        }
    }
    drop(claims);
    (Claim { state: Arc::clone(state), keys }, held, busy)
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
    let mut reply = SubmitReply::default();
    if s.uids.is_empty() {
        return Ok(reply);
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
    let owner: BTreeMap<u32, u64> = owed.owners.iter().copied().collect();

    // 2. The claim: a uid another submit is sending is left to it.
    let asked: Vec<u32> = owed.owners.iter().map(|(uid, _)| *uid).collect();
    let (_claim, mut pending, busy) = claim(state, &s.account_id, &s.mailbox, &asked);
    reply.queued.extend(busy);

    // 3. Send rounds.
    let mut refused_any = false;
    for round in 0..=DELETE_RETRY_MS.len() {
        if pending.is_empty() {
            break;
        }
        if round > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(DELETE_RETRY_MS[round - 1])).await;
        }
        // A uid its entry no longer owes was cancelled (or answered by
        // someone else): not sent again.
        let still = still_owed(state, &owner, &pending).await;
        for uid in pending.iter().filter(|uid| !still.contains(uid)) {
            reply.dropped.push((*uid, CANCELLED.to_string()));
        }
        pending.retain(|uid| still.contains(uid));
        if pending.is_empty() {
            break;
        }
        if !state.net.is_online() {
            info!("[delete-queue] {}/{}: offline, {} uid(s) stay queued", s.account_id, s.mailbox, pending.len());
            break;
        }
        note_round(state, &owner, &pending).await;

        let mut landed = Vec::new();
        let mut dropped = Vec::new();
        let mut failed = Vec::new();
        match crate::raw_message::account_config(state, &s.account_id).await {
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
                    let result = send(state, &config, &s, uid).await;
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
        reply.landed.extend(landed);
        reply.dropped.extend(dropped);
        pending = failed.into_iter().map(|(uid, _)| uid).collect();
    }
    if !pending.is_empty() {
        info!("[delete-queue] {}/{}: {} uid(s) stay queued", s.account_id, s.mailbox, pending.len());
        if refused_any {
            changed(state);
        }
    }
    reply.queued.extend(pending);
    Ok(reply)
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
        let listing = mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&st.app_dir)).map_err(|e| format!("{e:?}"))?;
        let Some(entry) = listing.accounts.iter().find(|a| a.get("id").and_then(Value::as_str) == Some(account_id.as_str())) else {
            return Err(ACCOUNT_UNAVAILABLE.to_string());
        };
        if entry.get("oauth2Transport").and_then(Value::as_str) == Some("graph") {
            return Err(GRAPH_UNSUPPORTED.to_string());
        }
        // An unreachable vault holds no local folder this delete could be in.
        let group = mailvault_core::bulk::Group { account_id, mailbox, uids: Vec::new() };
        if crate::bulk_worker::native_local_folder(&st, &group).unwrap_or(false) {
            return Err(LOCAL_FOLDER.to_string());
        }
        Ok(())
    })
    .await?
}

/// One `delete_one` on the account's provider (a JMAP account through its
/// session, any other through the IMAP pool's priority lane).
async fn send(state: &Arc<DaemonState>, config: &crate::imap::ImapConfig, s: &Submit, uid: u32) -> Result<Outcome, Refusal> {
    #[cfg(test)]
    if let Some(scripted) = tests::scripted_send(state, uid) {
        return scripted;
    }
    let provider = if config.uses_jmap() { Provider::Jmap(config) } else { Provider::Imap(config) };
    message_delete::delete_one(state, provider, &s.account_id, &s.mailbox, uid, s.mode, s.bin).await
}

/// The uids of `pending` their entries still owe.
async fn still_owed(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, pending: &[u32]) -> HashSet<u32> {
    let (st, owner, asked) = (Arc::clone(state), owner.clone(), pending.to_vec());
    let read = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        let mut still = HashSet::new();
        for uid in asked {
            let Some(id) = owner.get(&uid) else { continue };
            if op_journal::get(&st.app_dir, *id)?.is_some_and(|e| e.uids.contains(&uid)) {
                still.insert(uid);
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

/// One more round for every entry that owes a uid of `pending`.
async fn note_round(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, pending: &[u32]) {
    let ids: std::collections::BTreeSet<u64> = pending.iter().filter_map(|uid| owner.get(uid).copied()).collect();
    let st = Arc::clone(state);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        ids.into_iter().try_for_each(|id| op_journal::note_attempt(&st.app_dir, id))
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not count the send round: {e}");
    }
}

async fn note_failures(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, failed: &[(u32, String)]) {
    let (st, owner, failed) = (Arc::clone(state), owner.clone(), failed.to_vec());
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        failed.iter().try_for_each(|(uid, reason)| match owner.get(uid) {
            Some(id) => op_journal::note_failure(&st.app_dir, *id, *uid, reason),
            None => Ok(()),
        })
    })
    .await
    .and_then(|r| r);
    if let Err(e) = result {
        warn!("[delete-queue] could not keep the refusal reasons: {e}");
    }
}

/// Clear `uids` from the entries that own them.
async fn clear_owned(state: &Arc<DaemonState>, owner: &BTreeMap<u32, u64>, uids: &[u32]) {
    let mut by_id: BTreeMap<u64, Vec<u32>> = BTreeMap::new();
    for uid in uids {
        if let Some(id) = owner.get(uid) {
            by_id.entry(*id).or_default().push(*uid);
        }
    }
    let st = Arc::clone(state);
    let result = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
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
        for entry in op_journal::read(&st.app_dir) {
            if entry.op != "delete" || entry.account_id != account || entry.mailbox != folder {
                continue;
            }
            let owed: Vec<u32> = entry.uids.iter().copied().filter(|uid| gone.contains(uid)).collect();
            if !owed.is_empty() {
                op_journal::clear_by_id(&st.app_dir, entry.id, &owed)?;
            }
        }
        Ok::<_, String>(())
    })
    .await
    .and_then(|r| r);
    if let Err(e) = cleared {
        // The delete happened; a replay of a uid that is gone lands as gone.
        warn!("[delete-queue] {account_id}/{mailbox}: deleted, but the journal still lists them: {e}");
    }
    state.events.emit("delete-queue-landed", json!({ "accountId": account_id, "mailbox": mailbox, "landed": landed }));
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
            let result = blocking(move || -> Result<bool, String> {
                let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
                match op_journal::get(&st.app_dir, entry)? {
                    None => Ok(false),
                    Some(e) if e.op != "delete" => Err("errors.bulkUnsupported".to_string()),
                    Some(_) => op_journal::clear_by_id(&st.app_dir, entry, &uids).map(|()| true),
                }
            })
            .await
            .and_then(|r| r);
            if matches!(result, Ok(true)) {
                changed(state);
            }
            done(id, result.map(|_| Value::Null))
        }
        _ => return None,
    })
}

#[cfg(test)]
pub(crate) mod tests;
