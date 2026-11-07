//! User actions on messages and the offline queue behind them: `mobile.actions.apply`,
//! `mobile.actions.pending` and the replay worker.
//!
//! An action applies locally at once: in ONE write transaction it is appended to the
//! `pending_actions` journal and its `local_*` override is set on the rows (a moved or deleted row
//! is hidden through `local_deleted`). No network, no secret, so it answers with the network down.
//! The replay worker then pushes the journal to the server in `seq` order per account, one action at
//! a time, and reports each outcome as `mobile.action.result`.
//!
//! The journal holds only actions not yet settled (`queued`, or `retrying` after a failed attempt):
//! `done` and `dropped` delete the row. So "a row has a pending action" is exactly "a journal row
//! names its uid", which is what sync's guards ask (see `sync.rs`).
//!
//! `arg` is JSON `{target?, uidValidity?}`: the move target and the folder's UIDVALIDITY when the
//! action was applied. Replay compares the server's UIDVALIDITY with the journaled one, never with
//! the folder row's current one: after a resync a uid names a different message.

use crate::accounts::Code;
use crate::backend::{self, ApplyOutcome, Backend, FolderRow};
use crate::db::{lock, Engine, Shared};
use crate::events::{ACTION_RESULT, FOLDER_CHANGED};
use crate::rpc::{parse, RpcError};
use crate::sync::{self, Fail};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Most uids one apply takes: the journal row plus one row update each stays within the 200-row
/// write unit. A larger selection is applied in several calls.
pub(crate) const MAX_UIDS: usize = 199;
/// First retry after a refused or failed attempt; doubles per failure up to [`BACKOFF_CAP`].
const BACKOFF_BASE: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(300);
/// A server refusal (a tagged NO or BAD that is not the network, a timeout or the sign-in) is tried
/// this many times; then the action drops with `REFUSED`, so it cannot block the account for ever.
const MAX_REFUSALS: u32 = 3;

/// `uid IN` the uids any journal row of `(?1 account, ?2 folder)` names.
pub(crate) const PENDING_UIDS: &str =
    "SELECT j.value FROM pending_actions p, json_each(p.uids_json) j WHERE p.account_id = ?1 AND p.folder = ?2";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Seen,
    Unseen,
    Flag,
    Unflag,
    Move,
    Delete,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "seen" => Kind::Seen,
            "unseen" => Kind::Unseen,
            "flag" => Kind::Flag,
            "unflag" => Kind::Unflag,
            "move" => Kind::Move,
            "delete" => Kind::Delete,
            _ => return None,
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Kind::Seen => "seen",
            Kind::Unseen => "unseen",
            Kind::Flag => "flag",
            Kind::Unflag => "unflag",
            Kind::Move => "move",
            Kind::Delete => "delete",
        }
    }

    /// The override column the action sets locally.
    fn column(self) -> &'static str {
        match self {
            Kind::Seen | Kind::Unseen => "local_seen",
            Kind::Flag | Kind::Unflag => "local_flagged",
            Kind::Move | Kind::Delete => "local_deleted",
        }
    }

    pub(crate) fn value(self) -> i64 {
        match self {
            Kind::Unseen | Kind::Unflag => 0,
            _ => 1,
        }
    }

    /// The row leaves the folder (it is hidden locally, and removed once the server agrees).
    fn hides(self) -> bool {
        matches!(self, Kind::Move | Kind::Delete)
    }
}

/// The journal's `arg` column.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Arg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uid_validity: Option<i64>,
    /// Set before a move or delete goes on the wire: if its uids are then all absent from the
    /// source on a later attempt (the engine died before the reply), the server did it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    sent: bool,
    /// Attempts the server refused so far (see [`MAX_REFUSALS`]).
    #[serde(default, skip_serializing_if = "is_zero")]
    refused: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Arg {
    fn read(text: Option<String>) -> Arg {
        text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
}

/// Why an action was dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    /// The uids are not on the server (expunged elsewhere, moved, or the folder's UIDVALIDITY
    /// changed so the journaled uids name nothing).
    Gone,
    /// The folder (or a move's target) no longer exists.
    FolderGone,
    /// The server refused it [`MAX_REFUSALS`] times.
    Refused,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Gone => "GONE",
            Reason::FolderGone => "FOLDER_GONE",
            Reason::Refused => "REFUSED",
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn emit_result(shared: &Shared, account: &str, seq: i64, outcome: &str, reason: Option<&str>) {
    let mut v = json!({ "seq": seq, "accountId": account, "outcome": outcome });
    if let Some(r) = reason {
        v["reason"] = json!(r);
    }
    shared.emit(ACTION_RESULT, v);
}

/// Publishes a new generation for the folder and tells the list what changed.
fn emit_folder_changed(shared: &Shared, account: &str, folder: &str, gen: i64, removed: usize, updated: usize) {
    let gen = shared.publish_list_gen(account, folder, gen);
    shared.emit(
        FOLDER_CHANGED,
        json!({ "accountId": account, "folder": folder, "added": 0, "removed": removed, "updated": updated, "listGen": gen }),
    );
}

// ── RPCs ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyParams {
    account_id: String,
    folder: String,
    uids: Vec<u32>,
    kind: String,
    #[serde(default)]
    target: Option<String>,
}

/// What the apply transaction did: the journal seq (none when every uid was skipped), the rows
/// changed, and the skipped uids.
type Applied = (Option<i64>, usize, Vec<u32>);

/// `mobile.actions.apply {accountId, folder, uids, kind, target?}` -> `{queued: seq|null,
/// skipped: [uid]}`. Applies locally and journals in one write transaction the uids that have a
/// row in the folder (the rest are `skipped`; with none left nothing is journaled), emits
/// `mobile.folder.changed`, wakes replay.
pub(crate) fn apply(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ApplyParams = parse(params)?;
    let kind = Kind::parse(&p.kind).ok_or_else(|| RpcError::Invalid(format!("unknown action kind {}", p.kind)))?;
    let mut uids = p.uids;
    uids.sort_unstable();
    uids.dedup();
    if uids.is_empty() || uids.contains(&0) {
        return Err(RpcError::Invalid("uids must be a non-empty list of uids".into()));
    }
    if uids.len() > MAX_UIDS {
        return Err(RpcError::Invalid(format!("at most {MAX_UIDS} uids per action")));
    }
    let target = match (kind, p.target) {
        (Kind::Move, Some(t)) if !t.is_empty() => Some(t),
        (Kind::Move, _) => return Err(RpcError::Invalid("move needs a target folder".into())),
        (_, Some(_)) => return Err(RpcError::Invalid("only move takes a target".into())),
        (_, None) => None,
    };
    let shared = engine.shared();
    let Some(folder) = sync::folder_path(shared, &p.account_id, &p.folder).map_err(internal)? else {
        return Err(RpcError::Invalid("unknown folder".into()));
    };
    let gen = shared.list_gen(&p.account_id, &folder).map_err(internal)? + 1;
    let list = sync::uid_list(&uids);
    let account = p.account_id;
    let out = shared
        .write(|c| -> rusqlite::Result<Result<Applied, RpcError>> {
            let exists = c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [&account], |_| Ok(())).optional()?.is_some();
            if !exists {
                return Ok(Err(RpcError::Invalid("unknown account".into())));
            }
            let validity: Option<Option<i64>> = c
                .query_row("SELECT uid_validity FROM folders WHERE account_id = ?1 AND path = ?2", (&account, &folder), |r| r.get(0))
                .optional()?;
            let Some(validity) = validity else {
                return Ok(Err(RpcError::Invalid("unknown folder".into())));
            };
            if let Some(t) = &target {
                let known = c
                    .query_row("SELECT 1 FROM folders WHERE account_id = ?1 AND path = ?2", (&account, t), |_| Ok(()))
                    .optional()?
                    .is_some();
                if !known || *t == folder {
                    return Ok(Err(RpcError::Invalid("unknown move target".into())));
                }
            }
            // Only uids the list can show here: a row in this folder that is visible, or hidden by
            // an action still pending (a follow-up on a moved row reaches the moved copy). A uid
            // with no row may name another message after a UIDVALIDITY change: it is skipped.
            let held: HashSet<u32> = {
                let mut st = c.prepare(&format!(
                    "SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid IN ({list})
                       AND (COALESCE(local_deleted, 0) = 0 OR uid IN ({PENDING_UIDS}))"
                ))?;
                let rows = st.query_map((&account, &folder), |r| r.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
                rows.into_iter().map(|u| u as u32).collect()
            };
            let (kept, skipped): (Vec<u32>, Vec<u32>) = uids.iter().partition(|u| held.contains(u));
            if kept.is_empty() {
                return Ok(Ok((None, 0, skipped)));
            }
            let uids_json = serde_json::to_string(&kept).unwrap_or_default();
            let list = sync::uid_list(&kept);
            let arg = serde_json::to_string(&Arg { target: target.clone(), uid_validity: validity, ..Arg::default() }).unwrap_or_default();
            c.execute(
                "INSERT INTO pending_actions (account_id, folder, uids_json, kind, arg, state, attempts, created_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, ?6)",
                (&account, &folder, &uids_json, kind.as_str(), &arg, now_ms()),
            )?;
            let seq = c.last_insert_rowid();
            let col = kind.column();
            let n = c.execute(
                &format!(
                    "UPDATE messages SET {col} = ?3, list_gen = ?4
                     WHERE account_id = ?1 AND folder = ?2 AND uid IN ({list}) AND {col} IS NOT ?3"
                ),
                (&account, &folder, kind.value(), gen),
            )?;
            Ok(Ok((Some(seq), n, skipped)))
        })
        .map_err(internal)?;
    let (seq, n, skipped) = out?;
    if n > 0 {
        let (removed, updated) = if kind.hides() { (n, 0) } else { (0, n) };
        emit_folder_changed(shared, &account, &folder, gen, removed, updated);
    }
    if seq.is_some() {
        engine.replay().wake(shared, Some(&account));
    }
    Ok(json!({ "queued": seq, "skipped": skipped }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingParams {
    #[serde(default)]
    account_id: Option<String>,
}

/// `mobile.actions.pending {accountId?}` -> `{pending: [{seq, accountId, folder, kind, uids, state,
/// lastError}]}` in `seq` order. `lastError` is an accounts error code, never core's text.
pub(crate) fn pending(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: PendingParams = parse(params)?;
    let rows = engine
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT seq, account_id, folder, kind, uids_json, state, last_error FROM pending_actions
                 WHERE ?1 IS NULL OR account_id = ?1 ORDER BY seq",
            )?;
            let rows = st
                .query_map([&p.account_id], |r| {
                    let uids: Value = serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Array(Vec::new()));
                    Ok(json!({
                        "seq": r.get::<_, i64>(0)?,
                        "accountId": r.get::<_, String>(1)?,
                        "folder": r.get::<_, String>(2)?,
                        "kind": r.get::<_, String>(3)?,
                        "uids": uids,
                        "state": r.get::<_, String>(5)?,
                        "lastError": r.get::<_, Option<String>>(6)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;
    Ok(json!({ "pending": rows }))
}

/// Whether the journal holds anything (for any account when `account` is `None`).
pub(crate) fn has_pending(shared: &Shared, account: Option<&str>) -> bool {
    shared
        .read(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM pending_actions WHERE ?1 IS NULL OR account_id = ?1)", [account], |r| r.get(0)))
        .unwrap_or(false)
}

// ── Sync's side: dropping a folder's actions ────────────────────────────────

/// Drops the journaled actions of `folder` (only those whose journaled UIDVALIDITY is not
/// `keep_validity`, when given) with `reason`, emitting one `dropped` result each after the commit.
/// Used by sync before it wipes a folder whose UIDVALIDITY changed (`GONE`) or removes a folder the
/// server no longer lists (`FOLDER_GONE`). Their rows are about to be deleted, so no override is
/// cleared here.
pub(crate) fn drop_folder_actions(
    shared: &Shared,
    account: &str,
    folder: &str,
    keep_validity: Option<i64>,
    reason: Reason,
) -> Result<(), Fail> {
    let seqs: Vec<i64> = shared.read(|c| {
        let mut st = c.prepare_cached("SELECT seq, arg FROM pending_actions WHERE account_id = ?1 AND folder = ?2 ORDER BY seq")?;
        let rows = st
            .query_map((account, folder), |r| Ok((r.get::<_, i64>(0)?, Arg::read(r.get(1)?))))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|(_, arg)| keep_validity.is_none() || arg.uid_validity != keep_validity)
            .map(|(seq, _)| seq)
            .collect())
    })?;
    for chunk in seqs.chunks(200) {
        let dropped = sync::write_for(shared, account, |c| {
            let mut out = Vec::new();
            for seq in chunk {
                if c.execute("DELETE FROM pending_actions WHERE seq = ?1", [seq])? > 0 {
                    out.push(*seq);
                }
            }
            if !out.is_empty() {
                shared.bump_settle(account, folder);
            }
            Ok(out)
        })?;
        for seq in dropped {
            emit_result(shared, account, seq, "dropped", Some(reason.as_str()));
        }
    }
    Ok(())
}

// ── The replay worker ───────────────────────────────────────────────────────

struct Retry {
    at: Instant,
    delay: Duration,
    /// The head failed to sign in. A new apply or a refresh does not forgive this backoff: each
    /// would be one more login with a password the server already refused.
    auth: bool,
}

struct ReplayState {
    started: bool,
    stop: bool,
    /// Set by every wake; cleared before the worker reads the journal, so a wake that lands while
    /// it works is never slept through.
    kicked: bool,
    /// Per account: when its head may be tried again, and the delay that got it there.
    retry: HashMap<String, Retry>,
    base: Duration,
    cap: Duration,
}

impl Default for ReplayState {
    fn default() -> Self {
        ReplayState { started: false, stop: false, kicked: false, retry: HashMap::new(), base: BACKOFF_BASE, cap: BACKOFF_CAP }
    }
}

#[derive(Default)]
struct Queue {
    state: Mutex<ReplayState>,
    cv: Condvar,
}

/// The engine's replay worker. The thread starts on the first wake.
#[derive(Default)]
pub(crate) struct Replay {
    queue: Arc<Queue>,
}

/// The next delay after a failure: `base` first, then doubling, never above `cap`.
fn next_delay(prev: Option<Duration>, base: Duration, cap: Duration) -> Duration {
    match prev {
        None => base.min(cap),
        Some(d) => d.saturating_mul(2).min(cap),
    }
}

impl Replay {
    /// Starts the worker if needed and makes it look at the journal now. With `account`, that
    /// account's backoff is forgiven (the user just acted or refreshed, so try at once), unless its
    /// head last failed to sign in.
    pub(crate) fn wake(&self, shared: &Arc<Shared>, account: Option<&str>) {
        let mut st = lock(&self.queue.state);
        if st.stop {
            return;
        }
        if !st.started {
            let (queue, sh) = (Arc::clone(&self.queue), Arc::clone(shared));
            match std::thread::Builder::new().name("mv-engine-replay".into()).spawn(move || run(queue, sh)) {
                Ok(_) => st.started = true,
                Err(e) => {
                    shared.log(&format!("[actions] replay worker: {e}"));
                    return;
                }
            }
        }
        if let Some(a) = account {
            if !st.retry.get(a).is_some_and(|r| r.auth) {
                st.retry.remove(a);
            }
        }
        st.kicked = true;
        self.queue.cv.notify_all();
    }

    /// Asks the thread to exit before its next action. Does not wait for it.
    pub(crate) fn stop(&self) {
        lock(&self.queue.state).stop = true;
        self.queue.cv.notify_all();
    }

    pub(crate) fn set_backoff(&self, base: Duration, cap: Duration) {
        let mut st = lock(&self.queue.state);
        st.base = base;
        st.cap = cap;
    }
}

/// The accounts with journaled actions, oldest head first.
fn pending_accounts(shared: &Shared) -> Vec<String> {
    shared
        .read(|c| {
            // An account waiting for a new sign-in is parked: its journal stays until reauth wakes it.
            let mut st = c.prepare_cached(
                "SELECT account_id FROM pending_actions p
                 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id AND a.needs_auth != 0)
                 GROUP BY account_id ORDER BY min(seq)",
            )?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_else(|e| {
            shared.log(&format!("[actions] journal read: {e}"));
            Vec::new()
        })
}

fn run(queue: Arc<Queue>, shared: Arc<Shared>) {
    sync::background_qos();
    loop {
        {
            let mut st = lock(&queue.state);
            if st.stop {
                return;
            }
            st.kicked = false;
        }
        let accounts = pending_accounts(&shared);
        let now = Instant::now();
        let mut next: Option<Instant> = None;
        let ready: Vec<String> = {
            let st = lock(&queue.state);
            accounts
                .into_iter()
                .filter(|a| match st.retry.get(a) {
                    Some(r) if r.at > now => {
                        next = Some(next.map_or(r.at, |n| n.min(r.at)));
                        false
                    }
                    _ => true,
                })
                .collect()
        };
        for account in &ready {
            if shared.is_closing() || lock(&queue.state).stop {
                return;
            }
            let out = replay_account(&shared, account);
            let mut st = lock(&queue.state);
            match out {
                Ok(()) => {
                    st.retry.remove(account);
                }
                Err(code) => {
                    let delay = next_delay(st.retry.get(account).map(|r| r.delay), st.base, st.cap);
                    st.retry.insert(account.clone(), Retry { at: Instant::now() + delay, delay, auth: code == Code::AuthFailed });
                }
            }
        }
        if !ready.is_empty() {
            // Look again: more may have been queued, and a failed account now waits its turn.
            continue;
        }
        let mut st = lock(&queue.state);
        loop {
            if st.stop {
                return;
            }
            if st.kicked {
                break;
            }
            match next {
                None => st = queue.cv.wait(st).unwrap_or_else(|p| p.into_inner()),
                Some(at) => {
                    let now = Instant::now();
                    if at <= now {
                        break;
                    }
                    st = queue.cv.wait_timeout(st, at - now).unwrap_or_else(|p| p.into_inner()).0;
                }
            }
        }
    }
}

/// One journaled action.
struct Journaled {
    seq: i64,
    folder: String,
    uids: Vec<u32>,
    kind: Option<Kind>,
    arg: Arg,
}

fn head(shared: &Shared, account: &str) -> Result<Option<Journaled>, Fail> {
    Ok(shared.read(|c| {
        c.query_row(
            "SELECT seq, folder, uids_json, kind, arg FROM pending_actions WHERE account_id = ?1 ORDER BY seq LIMIT 1",
            [account],
            |r| {
                let mut uids: Vec<u32> = serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default();
                uids.sort_unstable();
                uids.dedup();
                Ok(Journaled {
                    seq: r.get(0)?,
                    folder: r.get(1)?,
                    uids,
                    kind: Kind::parse(&r.get::<_, String>(3)?),
                    arg: Arg::read(r.get(4)?),
                })
            },
        )
        .optional()
    })?)
}

/// Replays `account`'s journal through one session until it is empty. `Err(code)` when an attempt
/// failed: the head stays queued as `retrying` and the account backs off.
fn replay_account(shared: &Shared, account: &str) -> Result<(), Code> {
    let mut backend = match backend::open(shared, account) {
        Ok(b) => b,
        Err(Fail::Gone) | Err(Fail::Closing) => return Ok(()),
        Err(Fail::Code(code, why)) => {
            fail_head(shared, account, code, &why);
            return Err(code);
        }
    };
    let out = drain(shared, backend.as_mut(), account);
    // Signs out.
    drop(backend);
    match out {
        Ok(true) | Err(Fail::Gone) | Err(Fail::Closing) => Ok(()),
        // The head was refused and marked already.
        Ok(false) => Err(Code::Invalid),
        Err(Fail::Code(code, why)) => {
            fail_head(shared, account, code, &why);
            Err(code)
        }
    }
}

/// Marks the account's head `retrying` with the failure's code and reports it. `why` is for the log
/// only (scrubbed of the password by the caller).
fn fail_head(shared: &Shared, account: &str, code: Code, why: &str) {
    let marked = shared.write(|c| {
        let seq: Option<i64> = c
            .query_row("SELECT seq FROM pending_actions WHERE account_id = ?1 ORDER BY seq LIMIT 1", [account], |r| r.get(0))
            .optional()?;
        if let Some(seq) = seq {
            c.execute(
                "UPDATE pending_actions SET state = 'retrying', attempts = attempts + 1, last_error = ?2 WHERE seq = ?1",
                (seq, code.as_str()),
            )?;
        }
        Ok(seq)
    });
    match marked {
        Ok(Some(seq)) => {
            shared.log(&format!("[actions] {account} seq {seq}: {} {why}", code.as_str()));
            emit_result(shared, account, seq, "retrying", Some(code.as_str()));
        }
        Ok(None) => {}
        Err(e) => shared.log(&format!("[actions] {account}: marking the head failed: {e}")),
    }
}

/// Where a move put its messages, when COPYUID said: the target, `(old uid, new uid)` pairs and
/// the target's UIDVALIDITY.
struct Remap {
    target: String,
    pairs: Vec<(u32, u32)>,
    validity: Option<i64>,
}

/// What one attempt at an action came to, when it did not fail.
enum Outcome {
    /// Done on the server. `gone`: uids the server no longer had (skipped).
    Done { gone: Vec<u32>, remap: Option<Remap> },
    /// Not done and never will be. `uids_gone`: the uids are proven absent from the folder, so
    /// their rows go too; otherwise the action's overrides are withdrawn.
    Dropped { reason: Reason, uids_gone: bool },
    /// The server answered the command with a refusal (core's text, for the log).
    Refused(String),
}

/// Replays the account's actions until the journal is empty (`Ok(true)`) or the head was refused
/// and must back off (`Ok(false)`, already marked).
fn drain(shared: &Shared, backend: &mut dyn Backend, account: &str) -> Result<bool, Fail> {
    loop {
        sync::not_closing(shared)?;
        let Some(a) = head(shared, account)? else {
            return Ok(true);
        };
        let outcome = match a.kind {
            Some(kind) => run_action(shared, backend, account, &a, kind)?,
            // A kind this build does not know: nothing can replay it.
            None => Outcome::Dropped { reason: Reason::Gone, uids_gone: false },
        };
        if let Outcome::Refused(why) = outcome {
            if !refuse(shared, account, &a, &why)? {
                return Ok(false);
            }
            continue;
        }
        record(shared, account, &a, outcome)?;
    }
}

/// Counts a refusal of the head. Below [`MAX_REFUSALS`] it is marked `retrying` with `REFUSED`
/// (false: back off); at the limit it drops with `REFUSED` (true: go on with the next action).
fn refuse(shared: &Shared, account: &str, a: &Journaled, why: &str) -> Result<bool, Fail> {
    // The stored `arg`, not the head snapshot: `mark_sent` may have written it in this attempt.
    let refused = sync::write_for(shared, account, |c| {
        let Some(stored) = c
            .query_row("SELECT arg FROM pending_actions WHERE seq = ?1", [a.seq], |r| r.get::<_, Option<String>>(0))
            .optional()?
        else {
            return Ok(None);
        };
        let mut arg = Arg::read(stored);
        arg.refused += 1;
        if arg.refused < MAX_REFUSALS {
            c.execute(
                "UPDATE pending_actions SET state = 'retrying', attempts = attempts + 1, last_error = 'REFUSED', arg = ?2 WHERE seq = ?1",
                (a.seq, serde_json::to_string(&arg).unwrap_or_default()),
            )?;
        }
        Ok(Some(arg.refused))
    })?;
    // Gone meanwhile (sync dropped it, or the account went): nothing to report.
    let Some(refused) = refused else {
        return Ok(true);
    };
    shared.log(&format!("[actions] {account} seq {}: REFUSED ({refused} of {MAX_REFUSALS}) {why}", a.seq));
    if refused >= MAX_REFUSALS {
        record(shared, account, a, Outcome::Dropped { reason: Reason::Refused, uids_gone: false })?;
        return Ok(true);
    }
    emit_result(shared, account, a.seq, "retrying", Some(Reason::Refused.as_str()));
    Ok(false)
}

/// Records, before a move or delete goes on the wire, that it may have happened.
fn mark_sent(shared: &Shared, account: &str, a: &Journaled) -> Result<(), Fail> {
    if a.arg.sent {
        return Ok(());
    }
    let mut arg = a.arg.clone();
    arg.sent = true;
    let text = serde_json::to_string(&arg).unwrap_or_default();
    sync::write_for(shared, account, |c| c.execute("UPDATE pending_actions SET arg = ?2 WHERE seq = ?1", (a.seq, &text)))?;
    Ok(())
}

/// One attempt at the head action, through the backend; what the server's answer means for the
/// journal.
fn run_action(shared: &Shared, backend: &mut dyn Backend, account: &str, a: &Journaled, kind: Kind) -> Result<Outcome, Fail> {
    let folder = FolderRow::new(&a.folder, a.arg.uid_validity);
    let target = a.arg.target.as_deref();
    let mut before_wire = || mark_sent(shared, account, a);
    Ok(match backend.apply(&folder, kind, &a.uids, target, &mut before_wire)? {
        ApplyOutcome::Done { gone, moved } => Outcome::Done {
            gone,
            remap: moved.map(|m| Remap { target: target.unwrap_or_default().to_string(), pairs: m.pairs, validity: m.uid_validity }),
        },
        // A move or delete that went on the wire before, and every uid has left the source: the
        // server did it, and only the reply was lost (the engine died or the link dropped).
        ApplyOutcome::NonePresent if kind.hides() && a.arg.sent => Outcome::Done { gone: Vec::new(), remap: None },
        ApplyOutcome::NonePresent => Outcome::Dropped { reason: Reason::Gone, uids_gone: true },
        ApplyOutcome::FolderGone => Outcome::Dropped { reason: Reason::FolderGone, uids_gone: false },
        // Another generation: the journaled uids name other messages, or none.
        ApplyOutcome::OtherGeneration => Outcome::Dropped { reason: Reason::Gone, uids_gone: false },
        ApplyOutcome::Refused(why) => Outcome::Refused(why),
    })
}

/// Rewrites the account's later journal rows that name only uids the move took from `a.folder`, to
/// the target folder and the new uids. A later row naming some moved and some unmoved uids is left
/// alone: its moved uids are gone from the source and are skipped there.
fn remap_later(c: &Connection, account: &str, a: &Journaled, remap: &Remap) -> rusqlite::Result<()> {
    let (target, validity) = (remap.target.as_str(), remap.validity);
    let map: HashMap<u32, u32> = remap.pairs.iter().copied().collect();
    let later: Vec<(i64, String, Option<String>)> = {
        let mut st = c.prepare_cached("SELECT seq, uids_json, arg FROM pending_actions WHERE account_id = ?1 AND folder = ?2 AND seq > ?3")?;
        let rows = st.query_map((account, &a.folder, a.seq), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (seq, uids_json, arg) in later {
        let uids: Vec<u32> = serde_json::from_str(&uids_json).unwrap_or_default();
        if uids.is_empty() || !uids.iter().all(|u| map.contains_key(u)) {
            continue;
        }
        let mut new: Vec<u32> = uids.iter().map(|u| map[u]).collect();
        new.sort_unstable();
        let mut arg = Arg::read(arg);
        arg.uid_validity = validity;
        arg.sent = false;
        arg.refused = 0;
        if arg.target.as_deref() == Some(target) {
            continue;
        }
        c.execute(
            "UPDATE pending_actions SET folder = ?2, uids_json = ?3, arg = ?4 WHERE seq = ?1",
            (seq, target, serde_json::to_string(&new).unwrap_or_default(), serde_json::to_string(&arg).unwrap_or_default()),
        )?;
    }
    Ok(())
}

/// Deletes the rows of `uids` (with their bodies and attachments) that no other journal row names,
/// and tells the list when any went.
fn remove_rows(shared: &Shared, account: &str, folder: &str, uids: &[u32]) -> Result<(), Fail> {
    if uids.is_empty() {
        return Ok(());
    }
    let gen = shared.list_gen(account, folder)? + 1;
    let removed = sync::delete_uids(shared, account, folder, uids, true)?;
    if removed > 0 {
        emit_folder_changed(shared, account, folder, gen, removed, 0);
    }
    Ok(())
}

/// Writes an outcome: the journal row goes (only if it is still there; sync may have dropped it
/// meanwhile, which already reported it), then the rows follow.
fn record(shared: &Shared, account: &str, a: &Journaled, outcome: Outcome) -> Result<(), Fail> {
    let kind = a.kind;
    match outcome {
        // Counted by `refuse`, which records the drop at the limit.
        Outcome::Refused(why) => refuse(shared, account, a, &why).map(|_| ()),
        Outcome::Done { gone, remap } => {
            let settled = sync::write_for(shared, account, |c| {
                if c.execute("DELETE FROM pending_actions WHERE seq = ?1", [a.seq])? == 0 {
                    return Ok(false);
                }
                shared.bump_settle(account, &a.folder);
                if let Some(remap) = &remap {
                    remap_later(c, account, a, remap)?;
                }
                Ok(true)
            })?;
            if !settled {
                return Ok(());
            }
            // A flag override stays until a later sync agrees (see sync.rs); a moved or deleted
            // row has left the folder on the server, and so leaves it here. The result goes out
            // after the rows, so a listener never sees a settled action with rows still to go.
            let doomed = if kind.is_some_and(Kind::hides) { a.uids.clone() } else { gone };
            let out = remove_rows(shared, account, &a.folder, &doomed);
            emit_result(shared, account, a.seq, "done", None);
            out
        }
        Outcome::Dropped { reason, uids_gone } => {
            let gen = shared.list_gen(account, &a.folder)? + 1;
            let list = sync::uid_list(&a.uids);
            let changed = sync::write_for(shared, account, |c| {
                if c.execute("DELETE FROM pending_actions WHERE seq = ?1", [a.seq])? == 0 {
                    return Ok(None);
                }
                shared.bump_settle(account, &a.folder);
                let mut n = 0;
                if let (false, Some(kind)) = (uids_gone, kind) {
                    // Withdraw this action's override where no other pending action holds one.
                    let col = kind.column();
                    n = c.execute(
                        &format!(
                            "UPDATE messages SET {col} = NULL, list_gen = ?3
                             WHERE account_id = ?1 AND folder = ?2 AND uid IN ({list}) AND {col} IS NOT NULL
                               AND uid NOT IN ({PENDING_UIDS})"
                        ),
                        (account, &a.folder, gen),
                    )?;
                }
                Ok(Some(n))
            })?;
            let Some(n) = changed else {
                return Ok(());
            };
            let out = if uids_gone {
                remove_rows(shared, account, &a.folder, &a.uids)
            } else {
                if n > 0 {
                    let hides = kind.is_some_and(Kind::hides);
                    emit_folder_changed(shared, account, &a.folder, gen, 0, if hides { 0 } else { n });
                }
                Ok(())
            };
            emit_result(shared, account, a.seq, "dropped", Some(reason.as_str()));
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_the_cap() {
        let mut d = None;
        let mut seen = Vec::new();
        for _ in 0..9 {
            let next = next_delay(d, BACKOFF_BASE, BACKOFF_CAP);
            seen.push(next.as_secs());
            d = Some(next);
        }
        assert_eq!(seen, vec![5, 10, 20, 40, 80, 160, 300, 300, 300]);
    }

    /// Only the server's tagged NO or BAD, as core renders it, is a refusal; anything else
    /// (a transport error whose words miss the network needles, an unknown failure) stays a
    /// retryable failure.
    #[test]
    fn refusal_needs_a_tagged_no_or_bad() {
        let refused = |e: &str| matches!(crate::backend::imap::refused_or_fail(e.to_string()), Ok(ApplyOutcome::Refused(_)));
        assert!(refused("STORE flags failed: no response: [CANNOT] read only"));
        assert!(refused("SELECT Work failed: bad response: unknown mailbox"));
        assert!(refused("SEARCH failed: No [THROTTLED] slow down"));
        assert!(refused("UID MOVE 1 \"Archive\" failed: No [TRYCREATE] no such mailbox"));
        assert!(refused("UID COPY 1 \"Trash\" failed: Bad command"));
        for e in [
            "STORE flags failed: io: Software caused connection abort (os error 53)",
            "UID MOVE 1 \"Archive\" failed: io: Socket is not connected (os error 57)",
            "SEARCH failed: io: Broken pipe (os error 32)",
            "STORE flags failed: io: Connection reset by peer (os error 54)",
            "STORE flags failed: parse: something odd",
            "TCP connect to h:993 failed: No route to host (os error 65)",
            "something nobody has seen before",
        ] {
            assert!(!refused(e), "{e} counted as a refusal");
        }
    }

    #[test]
    fn kinds_round_trip() {
        for k in [Kind::Seen, Kind::Unseen, Kind::Flag, Kind::Unflag, Kind::Move, Kind::Delete] {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::parse("archive"), None);
    }
}
