//! The outbox: `mobile.outbox.list/retry/discard`, the `mv-engine-outbox` worker, and the picked
//! files under `<cache>/out/`.
//!
//! A row is `queued` from `mobile.compose.send` on. The worker takes an account's queued rows in
//! `created_ms` order through one signed-in backend. Each attempt commits `queued -> sending` in
//! its own transaction BEFORE the network, reads the picked files (base64, in this thread, never
//! through the page), builds and submits the message under the row's stored Message-ID, and
//! commits `sending -> sent` as soon as the server accepted it; only then is the copy filed in
//! Sent (a failure there is logged, never retried). A row found `sending` when the engine opens
//! may have gone out: it becomes `uncertain` and is never sent again on its own (the user's
//! Retry sends it again under the same Message-ID, Discard drops it).
//!
//! The rows are core's outbox state machine (`mailvault_core::send::outbox`): [`Store`] is its
//! SQLite [`OutboxStore`], and where an attempt leaves a row is core's [`core_outbox::next_state`] (through
//! [`finish`]) under [`RETRY`], which never gives up on a transient failure.
//!
//! The backend says where a failure fell ([`SendFail`], from core's `send_built_phased`): one
//! that may have followed an acceptance (the connection broke or timed out during or after the
//! upload) makes the row `uncertain`, never resent on its own, exactly like a crash; a refusal no
//! retry can change (a permanent 5xx, core's `send::classify`) makes it `failed`; anything
//! that proves nothing was sent (connect, TLS, sign-in, MAIL/RCPT/DATA, a 4xx) puts it back to
//! `queued` with its wait in `not_before_ms` (5 s, doubling, at most 300 s, like the action
//! replay), and the account backs off as long. A row is only sent once its `not_before_ms` has
//! come, so the wait survives a restart; the user's Retry clears it.
//!
//! Send later (plan 4 Task 8): a scheduled row is `queued` with `not_before_ms` at its send time
//! and `scheduled_ms` holding the time the user picked. A failed attempt's backoff moves
//! `not_before_ms` only, so the list keeps showing the picked time. The list's "Scheduled"
//! section is `state = 'queued' AND scheduled_ms > now`. `reschedule` moves both (the delay checked
//! again, Premium included), Retry is "send now" (it clears both), Discard is "cancel". The worker
//! never looks at Premium: a lapse after scheduling cancels nothing. A background run sends the
//! rows that are due ([`due_accounts`], [`Outbox::wake_for_run`], [`Outbox::wait_rounds`]), and
//! while a scheduled row waits the engine asks the OS for background runs ([`has_scheduled`]).
//! `lastError` and an event's `reason` are codes, never core's text.
//!
//! Picked files: `<cache>/out/<dir>/` is deleted once no draft and no unsent outbox row names it
//! ([`release_dirs`]): when its row is sent or discarded, or its draft deleted. [`sweep`] removes,
//! at engine open, the dirs older than a day that nothing names (a pick the page never saved).

use crate::accounts::Code;
use crate::backend::{self, Backend, SendFail};
use crate::compose::{self, Fields};
use crate::db::{lock, Engine, EngineError, Shared};
use crate::events::SEND_RESULT;
use crate::outgoing::resolve_outgoing;
use crate::rpc::{parse, RpcError};
use crate::sync::{self, Fail};
use base64::Engine as _;
use mailvault_core::backoff::RetryPolicy;
use mailvault_core::send::classify::SendVerdict;
use mailvault_core::send::outbox::{self as core_outbox, finish, OutboxState, OutboxStore};
use mailvault_core::smtp::OutgoingAttachment;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const BACKOFF_BASE: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(300);
/// The mobile retry policy: 5 s doubling to 300 s, never giving up on a transient failure. A row
/// goes back to `queued` with this wait as its `not_before_ms`, and its account backs off as long.
/// The worker reads it from its own base and cap (tests shorten them).
pub(crate) const RETRY: RetryPolicy = RetryPolicy::new(BACKOFF_BASE, BACKOFF_CAP, None);
/// A picked dir nothing names is swept at open once it is this old.
pub(crate) const ORPHAN_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// `sent` rows are kept this long (for `uncertain` detection and support), then pruned at open.
const SENT_KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn emit_result(shared: &Shared, id: &str, account: &str, outcome: &str, reason: Option<&str>) {
    let mut v = json!({ "id": id, "accountId": account, "outcome": outcome });
    if let Some(r) = reason {
        v["reason"] = json!(r);
    }
    shared.emit(SEND_RESULT, v);
}

// ── Picked files ────────────────────────────────────────────────────────────

/// The `<dir>` of a handle `out/<dir>/<name>`.
pub(crate) fn dir_of(handle: &str) -> Option<&str> {
    let mut parts = handle.split('/');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("out"), Some(dir), Some(name), None) if !dir.is_empty() && !name.is_empty() && dir != "." && dir != ".." => Some(dir),
        _ => None,
    }
}

/// Whether a draft or an unsent outbox row names a file in `out/<dir>/`.
fn referenced(c: &Connection, dir: &str) -> rusqlite::Result<bool> {
    let needle = format!("\"out/{dir}/");
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM drafts WHERE instr(json, ?1) > 0)
             OR EXISTS(SELECT 1 FROM outbox WHERE state != 'sent' AND instr(draft_json, ?1) > 0)",
        [&needle],
        |r| r.get(0),
    )
}

/// Deletes each `<cache>/out/<dir>` that no draft or unsent outbox row names any more.
pub(crate) fn release_dirs(shared: &Shared, cache_dir: &Path, dirs: &[String]) {
    for dir in dirs {
        if dir.is_empty() || dir.contains(['/', '\\']) || dir == "." || dir == ".." {
            continue;
        }
        match shared.read(|c| referenced(c, dir)) {
            Ok(false) => {
                let path = cache_dir.join("out").join(dir);
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        shared.log(&format!("[outbox] removing a picked dir: {e}"));
                    }
                }
            }
            Ok(true) => {}
            Err(e) => shared.log(&format!("[outbox] reading references: {e}")),
        }
    }
}

/// Removes the dirs under `<cache>/out` that are at least `older_than` old and that nothing
/// names: picks the page never saved into a draft or a send.
pub(crate) fn sweep(shared: &Shared, cache_dir: &Path, older_than: Duration) {
    let Ok(entries) = std::fs::read_dir(cache_dir.join("out")) else {
        return;
    };
    let mut stale = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(String::from) else { continue };
        let age = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).unwrap_or(Duration::ZERO);
        if age >= older_than {
            stale.push(name);
        }
    }
    release_dirs(shared, cache_dir, &stale);
}

// ── Startup ─────────────────────────────────────────────────────────────────

/// At open, before any worker runs: a row left `sending` may have gone out, so it becomes
/// `uncertain`; `sent` rows past their keep time go. Answers whether rows wait to be sent.
/// Runs on the writer before [`Shared`] exists; [`Store`]'s `on_open` is the same.
pub(crate) fn on_open(w: &Connection, now_ms: i64) -> rusqlite::Result<bool> {
    let sending = OutboxState::Sending;
    w.execute(
        "UPDATE outbox SET state = ?2, updated_ms = ?1 WHERE state = ?3",
        (now_ms, core_outbox::on_open(sending).as_str(), sending.as_str()),
    )?;
    w.execute("DELETE FROM outbox WHERE state = ?2 AND updated_ms < ?1", (now_ms - SENT_KEEP_MS, OutboxState::Sent.as_str()))?;
    w.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE state = ?1)", [OutboxState::Queued.as_str()], |r| r.get(0))
}

// ── The store ───────────────────────────────────────────────────────────────

/// The `outbox` table as core's [`OutboxStore`]. Every move is a compare-and-set on `state`, so a
/// row discarded or retried while it was being sent is left alone. `mark` stores a requeued row's
/// `not_before_ms` (`None` keeps the row's own), and `queued` answers only the rows whose time has
/// come.
pub(crate) struct Store<'a>(pub(crate) &'a Shared);

impl OutboxStore for Store<'_> {
    type Error = EngineError;

    fn claim_sending(&self, id: &str) -> Result<bool, EngineError> {
        self.mark(id, OutboxState::Queued, OutboxState::Sending, None, false, None)
    }

    fn mark(
        &self,
        id: &str,
        from: OutboxState,
        to: OutboxState,
        error: Option<&str>,
        count_attempt: bool,
        not_before_ms: Option<i64>,
    ) -> Result<bool, EngineError> {
        self.0
            .write(|c| {
                c.execute(
                    "UPDATE outbox SET state = ?3, last_error = ?4, attempts = attempts + ?5, updated_ms = ?6,
                     not_before_ms = COALESCE(?7, not_before_ms) WHERE id = ?1 AND state = ?2",
                    (id, from.as_str(), to.as_str(), error, count_attempt as i64, compose::now_ms(), not_before_ms),
                )
            })
            .map(|n| n == 1)
    }

    fn on_open(&self, now_ms: i64) -> Result<bool, EngineError> {
        self.0.write(|c| on_open(c, now_ms))
    }

    fn queued(&self, account: &str, now_ms: i64) -> Result<Vec<String>, EngineError> {
        self.0.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id FROM outbox WHERE account_id = ?1 AND state = ?2 AND not_before_ms <= ?3 ORDER BY created_ms, id",
            )?;
            let rows =
                st.query_map((account, OutboxState::Queued.as_str(), now_ms), |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
    }

    fn attempts(&self, id: &str) -> Result<u32, EngineError> {
        let n: Option<i64> = self.0.read(|c| c.query_row("SELECT attempts FROM outbox WHERE id = ?1", [id], |r| r.get(0)).optional())?;
        Ok(n.map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX)))
    }
}

/// A store answer, or `default` with the error logged (a failed move is a move that did not
/// happen: the row stays where it was).
fn logged<T>(shared: &Shared, what: &str, r: Result<T, EngineError>, default: T) -> T {
    r.unwrap_or_else(|e| {
        shared.log(&format!("[outbox] {what}: {e}"));
        default
    })
}

// ── RPCs ────────────────────────────────────────────────────────────────────

/// `mobile.outbox.list` -> `[{id, accountId, subject, state, lastError, scheduledMs, notBeforeMs}]`,
/// oldest first: every row not sent yet (`queued`, `sending`, `failed`, `uncertain`).
/// `scheduledMs` is the send time the user picked (null when not scheduled), `notBeforeMs` the
/// earliest time the worker takes the row (0: at once). A row is scheduled while `queued` with
/// `scheduledMs` still to come.
pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let rows = engine
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, account_id, draft_json, state, last_error, scheduled_ms, not_before_ms
                 FROM outbox WHERE state != 'sent' ORDER BY created_ms, id",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "accountId": r.get::<_, String>(1)?,
                        "subject": Fields::read(&r.get::<_, String>(2)?).subject,
                        "state": r.get::<_, String>(3)?,
                        "lastError": r.get::<_, Option<String>>(4)?,
                        "scheduledMs": r.get::<_, Option<i64>>(5)?,
                        "notBeforeMs": r.get::<_, i64>(6)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;
    Ok(Value::Array(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

/// `mobile.outbox.retry {id}` -> `{id, state: "queued"}`: a `failed` or `uncertain` row (or a
/// `queued` one, at once: a scheduled row's "send now") goes back to the worker, no longer
/// scheduled. `INVALID` for an unknown row, one being sent
/// or one already sent.
pub(crate) fn retry(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    let shared = engine.shared();
    let out = shared
        .write(|c| {
            let row: Option<(String, String)> =
                c.query_row("SELECT account_id, state FROM outbox WHERE id = ?1", [&p.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let Some((account, state)) = row else {
                return Ok(Err("unknown outbox row"));
            };
            if !OutboxState::parse(&state).is_some_and(OutboxState::user_may_retry) {
                return Ok(Err("the message is being sent or was sent"));
            }
            // The user's Retry is "now": whatever wait or schedule the row carried goes.
            c.execute(
                "UPDATE outbox SET state = ?3, last_error = NULL, updated_ms = ?2, not_before_ms = 0, scheduled_ms = NULL WHERE id = ?1",
                (&p.id, compose::now_ms(), OutboxState::Queued.as_str()),
            )?;
            Ok(Ok(account))
        })
        .map_err(internal)?;
    let account = out.map_err(|m| RpcError::Invalid(m.into()))?;
    engine.outbox().wake(shared, Some(&account));
    Ok(json!({ "id": p.id, "state": "queued" }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RescheduleParams {
    id: String,
    send_at_ms: i64,
}

/// `mobile.outbox.reschedule {id, sendAtMs}` -> `{id, state: "queued", scheduledMs}`: a `queued`
/// row's send time moves to `sendAtMs` (both its wait and its picked time; a time already past
/// sends it at once, no longer scheduled). The delay is checked again like a send's, with today's
/// Premium answer: `PREMIUM_REQUIRED`, `SCHEDULE_TOO_FAR`. `INVALID` for an unknown row or one
/// not queued (being sent, failed, uncertain).
pub(crate) fn reschedule(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RescheduleParams = parse(params)?;
    let shared = engine.shared();
    let now = compose::now_ms();
    let scheduled = compose::schedule_check(shared, p.send_at_ms, now)?;
    let account = shared
        .write(|c| {
            let queued = OutboxState::Queued.as_str();
            let account: Option<String> =
                c.query_row("SELECT account_id FROM outbox WHERE id = ?1 AND state = ?2", (&p.id, queued), |r| r.get(0)).optional()?;
            if account.is_some() {
                c.execute(
                    "UPDATE outbox SET not_before_ms = ?3, scheduled_ms = ?4, updated_ms = ?5 WHERE id = ?1 AND state = ?2",
                    (&p.id, queued, scheduled.unwrap_or(0), scheduled, now),
                )?;
            }
            Ok(account)
        })
        .map_err(internal)?
        .ok_or_else(|| RpcError::Invalid("the message is not waiting to be sent".into()))?;
    // The worker sleeps until the earliest wait it read: a time moved earlier needs a look now.
    engine.outbox().wake(shared, Some(&account));
    Ok(json!({ "id": p.id, "state": "queued", "scheduledMs": scheduled }))
}

/// A scheduled message waits to be sent (`queued` with a picked time, past or to come): the
/// engine wants background runs until it is gone (plan Ruling 13).
pub(crate) fn has_scheduled(shared: &Shared) -> bool {
    shared
        .read(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE state = ?1 AND scheduled_ms IS NOT NULL)", [OutboxState::Queued.as_str()], |r| r.get(0)))
        .unwrap_or_else(|e| {
            shared.log(&format!("[outbox] read: {e}"));
            false
        })
}

/// `mobile.outbox.discard {id}` -> `{discarded}`: the row goes, with the files only it held.
/// `INVALID` while it is being sent.
pub(crate) fn discard(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    let shared = engine.shared();
    let out = shared
        .write(|c| {
            let row: Option<(String, String)> =
                c.query_row("SELECT state, draft_json FROM outbox WHERE id = ?1", [&p.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            match row {
                None => Ok(Ok(None)),
                Some((state, _)) if state == OutboxState::Sending.as_str() => Ok(Err(())),
                Some((_, json)) => {
                    c.execute("DELETE FROM outbox WHERE id = ?1", [&p.id])?;
                    Ok(Ok(Some(json)))
                }
            }
        })
        .map_err(internal)?;
    let json = out.map_err(|()| RpcError::Invalid("the message is being sent".into()))?;
    let discarded = json.is_some();
    if let Some(json) = json {
        release_dirs(shared, engine.cache_dir(), &Fields::read(&json).dirs());
    }
    Ok(json!({ "discarded": discarded }))
}

// ── The worker ──────────────────────────────────────────────────────────────

struct Retry {
    at: Instant,
    /// Failures in a row for this account.
    failures: u32,
}

struct State {
    started: bool,
    stop: bool,
    kicked: bool,
    retry: HashMap<String, Retry>,
    base: Duration,
    cap: Duration,
    /// Rounds the worker has finished (each read the due rows, then sent what it could).
    rounds: u64,
}

struct Queue {
    state: Mutex<State>,
    cv: Condvar,
    cache_dir: PathBuf,
}

/// The engine's outbox worker. The thread starts on the first wake. A clone wakes the same worker.
#[derive(Clone)]
pub(crate) struct Outbox {
    queue: Arc<Queue>,
}

impl Outbox {
    pub(crate) fn new(cache_dir: &Path) -> Outbox {
        Outbox {
            queue: Arc::new(Queue {
                state: Mutex::new(State {
                    started: false,
                    stop: false,
                    kicked: false,
                    retry: HashMap::new(),
                    base: RETRY.base,
                    cap: RETRY.cap,
                    rounds: 0,
                }),
                cv: Condvar::new(),
                cache_dir: cache_dir.to_path_buf(),
            }),
        }
    }

    /// Starts the worker if needed and makes it look at the outbox now; with `account`, that
    /// account's backoff is forgiven (the user just sent or retried).
    pub(crate) fn wake(&self, shared: &Arc<Shared>, account: Option<&str>) {
        self.wake_all(shared, account.as_slice());
    }

    /// [`Outbox::wake`] for each of `accounts`, in one go. Answers the rounds the worker had
    /// finished, read under the same lock that forgave their backoff.
    fn wake_all(&self, shared: &Arc<Shared>, accounts: &[&str]) -> u64 {
        let mut st = lock(&self.queue.state);
        if st.stop {
            return st.rounds;
        }
        if !st.started {
            let (queue, sh) = (Arc::clone(&self.queue), Arc::clone(shared));
            match std::thread::Builder::new().name("mv-engine-outbox".into()).spawn(move || run(queue, sh)) {
                Ok(_) => st.started = true,
                Err(e) => {
                    shared.log(&format!("[outbox] worker: {e}"));
                    return st.rounds;
                }
            }
        }
        for a in accounts {
            st.retry.remove(*a);
        }
        st.kicked = true;
        self.queue.cv.notify_all();
        st.rounds
    }

    /// A background run: the worker takes `accounts`' due rows now (their backoff forgiven).
    /// Answers the mark to hand to [`Outbox::wait_rounds`].
    pub(crate) fn wake_for_run(&self, shared: &Arc<Shared>, accounts: &[String]) -> u64 {
        let refs: Vec<&str> = accounts.iter().map(String::as_str).collect();
        self.wake_all(shared, &refs)
    }

    /// Waits until the worker has tried every row that was due when [`Outbox::wake_for_run`]
    /// answered `mark`, or `until`. Two rounds: the one running at the wake may have read the
    /// rows (and the backoff) before it, the next one started after it. False on `until` (or a
    /// stop); the worker goes on either way.
    pub(crate) fn wait_rounds(&self, mark: u64, until: Instant) -> bool {
        let mut st = lock(&self.queue.state);
        loop {
            if st.rounds >= mark.saturating_add(2) {
                return true;
            }
            let now = Instant::now();
            if st.stop || now >= until {
                return false;
            }
            st = self.queue.cv.wait_timeout(st, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

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

/// The queued rows the worker may take: not on an account waiting for a new sign-in (parked) or
/// one whose password the server refused (held); those stay queued until reauth, or the user's
/// Retry, wakes it.
fn sendable_sql(select: &str) -> String {
    format!(
        "{select} FROM outbox o WHERE state = 'queued'
         AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = o.account_id AND a.needs_auth != 0)
         AND {}",
        crate::hold::NOT_HELD_SQL.replace("{account}", "o.account_id")
    )
}

/// Accounts with rows the worker would send now (`now_ms`): what a background run waits for.
pub(crate) fn due_accounts(shared: &Shared, now_ms: i64) -> Vec<String> {
    queued_accounts(shared, now_ms)
}

/// Accounts with queued rows whose `not_before_ms` has come (`now_ms`), oldest row first.
fn queued_accounts(shared: &Shared, now_ms: i64) -> Vec<String> {
    shared
        .read(|c| {
            let mut st = c.prepare_cached(&format!(
                "{} AND o.not_before_ms <= ?1 GROUP BY account_id ORDER BY min(created_ms)",
                sendable_sql("SELECT account_id")
            ))?;
            let rows = st.query_map([now_ms], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_else(|e| {
            shared.log(&format!("[outbox] read: {e}"));
            Vec::new()
        })
}

/// The earliest `not_before_ms` still to come (after `now_ms`) among the rows the worker may take:
/// when it must look again.
fn next_not_before(shared: &Shared, now_ms: i64) -> Option<i64> {
    shared
        .read(|c| c.query_row(&format!("{} AND o.not_before_ms > ?1", sendable_sql("SELECT min(o.not_before_ms)")), [now_ms], |r| r.get(0)))
        .unwrap_or_else(|e| {
            shared.log(&format!("[outbox] read: {e}"));
            None
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
        let now = Instant::now();
        let now_ms = compose::now_ms();
        // A row whose wait is still to come wakes the worker when it is up.
        let mut next: Option<Instant> =
            next_not_before(&shared, now_ms).map(|at| now + Duration::from_millis(u64::try_from(at - now_ms).unwrap_or(0)));
        let (ready, policy): (Vec<String>, RetryPolicy) = {
            let st = lock(&queue.state);
            let ready = queued_accounts(&shared, now_ms)
                .into_iter()
                .filter(|a| match st.retry.get(a) {
                    Some(r) if r.at > now => {
                        next = Some(next.map_or(r.at, |n| n.min(r.at)));
                        false
                    }
                    _ => true,
                })
                .collect();
            (ready, RetryPolicy::new(st.base, st.cap, None))
        };
        for account in &ready {
            if shared.is_closing() || lock(&queue.state).stop {
                return;
            }
            let ok = send_account(&shared, &queue.cache_dir, account, &policy);
            let mut st = lock(&queue.state);
            if ok {
                st.retry.remove(account);
            } else {
                let failures = st.retry.get(account).map_or(0, |r| r.failures).saturating_add(1);
                let delay = policy.next_delay(failures);
                st.retry.insert(account.clone(), Retry { at: Instant::now() + delay, failures });
            }
        }
        // A background run waits on this (`wait_rounds`).
        lock(&queue.state).rounds += 1;
        queue.cv.notify_all();
        if !ready.is_empty() {
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

fn queued_ids(shared: &Shared, account: &str) -> Result<Vec<String>, Fail> {
    Ok(Store(shared).queued(account, compose::now_ms())?)
}

/// Puts every queued row of `account` on hold after a failure to reach the server.
fn hold_account(shared: &Shared, account: &str, code: Code, why: &str) {
    crate::hold::note_failure(shared, account, code, why);
    let ids = queued_ids(shared, account).unwrap_or_default();
    shared.log(&format!("[outbox] {account}: {} {why}", code.as_str()));
    for id in ids {
        let marked = shared.write(|c| {
            c.execute(
                "UPDATE outbox SET attempts = attempts + 1, last_error = ?2, updated_ms = ?3 WHERE id = ?1 AND state = 'queued'",
                (&id, code.as_str(), compose::now_ms()),
            )
        });
        if matches!(marked, Ok(1)) {
            emit_result(shared, &id, account, "queued", Some(code.as_str()));
        }
    }
}

/// Sends `account`'s queued rows through one backend, a requeued row waiting as `policy` says.
/// `false` when the account must back off.
fn send_account(shared: &Shared, cache_dir: &Path, account: &str, policy: &RetryPolicy) -> bool {
    let ids = match queued_ids(shared, account) {
        Ok(ids) if !ids.is_empty() => ids,
        _ => return true,
    };
    let mut backend = match backend::open(shared, account) {
        Ok(b) => b,
        Err(Fail::Gone) | Err(Fail::Closing) => return true,
        Err(Fail::Code(code, why)) => {
            hold_account(shared, account, code, &why);
            return false;
        }
    };
    for id in ids {
        if sync::not_closing(shared).is_err() {
            return true;
        }
        if !send_one(shared, cache_dir, backend.as_mut(), account, &id, policy) {
            return false;
        }
    }
    true
}

/// Ends claimed row `id`'s attempt with `verdict` (core's [`finish`] under `policy`, [`RETRY`]
/// outside tests) and tells the page where it went, with `reason`.
fn end_attempt(shared: &Shared, account: &str, id: &str, verdict: SendVerdict, reason: Option<&str>, policy: &RetryPolicy) -> Option<OutboxState> {
    let to = logged(shared, id, finish(&Store(shared), id, verdict, reason, compose::now_ms(), policy), None)?;
    emit_result(shared, id, account, to.as_str(), reason.filter(|_| to != OutboxState::Sent));
    Some(to)
}

/// The picked files as core's attachments: read and base64-encoded here, on the worker. `Err`
/// when one is gone.
fn read_attachments(cache_dir: &Path, fields: &Fields) -> Result<Vec<OutgoingAttachment>, ()> {
    let mut out = Vec::with_capacity(fields.attachments.len());
    for a in &fields.attachments {
        let path = resolve_outgoing(cache_dir, &a.handle).map_err(|_| ())?;
        let bytes = std::fs::read(&path).map_err(|_| ())?;
        out.push(OutgoingAttachment {
            filename: a.name.clone(),
            content: base64::engine::general_purpose::STANDARD.encode(&bytes),
            content_type: (!a.mime.is_empty()).then(|| a.mime.clone()),
            cid: None,
        });
    }
    Ok(out)
}

/// One attempt at row `id`. `false` when the account must back off (the row is `queued` again,
/// or `uncertain`).
fn send_one(shared: &Shared, cache_dir: &Path, backend: &mut dyn Backend, account: &str, id: &str, policy: &RetryPolicy) -> bool {
    let store = Store(shared);
    let row: Option<(String, Option<String>)> = shared
        .read(|c| {
            c.query_row(
                "SELECT draft_json, message_id FROM outbox WHERE id = ?1 AND state = ?2",
                (id, OutboxState::Queued.as_str()),
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })
        .unwrap_or(None);
    let Some((json, message_id)) = row else {
        return true;
    };
    let fields = Fields::read(&json);
    if !matches!(crate::accounts::load_account(shared, account), Ok(Some(_))) {
        return true;
    }
    if let Err(why) = compose::check_recipients(&fields) {
        shared.log(&format!("[outbox] {account} {id}: INVALID {why}"));
        // Never tried: no attempt is counted.
        let failed = store.mark(id, OutboxState::Queued, OutboxState::Failed, Some("INVALID"), false, None);
        if logged(shared, id, failed, false) {
            emit_result(shared, id, account, OutboxState::Failed.as_str(), Some("INVALID"));
        }
        return true;
    }
    // Committed before the network: from here on, a crash leaves `sending`, read as `uncertain`.
    if !logged(shared, id, store.claim_sending(id), false) {
        return true;
    }
    let Ok(attachments) = read_attachments(cache_dir, &fields) else {
        end_attempt(shared, account, id, SendVerdict::Terminal, Some("ATTACHMENT_MISSING"), policy);
        return true;
    };
    let email = fields.outgoing(message_id, attachments);
    match backend.send(&email) {
        Ok(sent) => {
            drop(email);
            // The files go before the page hears `sent`.
            let sent_now = finish(&Store(shared), id, SendVerdict::Sent, None, compose::now_ms(), policy);
            if logged(shared, id, sent_now, None).is_some() {
                release_dirs(shared, cache_dir, &fields.dirs());
                emit_result(shared, id, account, OutboxState::Sent.as_str(), None);
            }
            if let Err(Fail::Code(code, why)) = backend.file_sent(&sent) {
                shared.log(&format!("[outbox] {account} {id}: filing in Sent: {} {why}", code.as_str()));
            }
            true
        }
        Err(SendFail { fail, verdict }) => {
            let code = match &fail {
                Fail::Code(code, why) => {
                    shared.log(&format!("[outbox] {account} {id}: {} {why}", code.as_str()));
                    *code
                }
                Fail::Gone | Fail::Closing => Code::HostUnreachable,
            };
            // `lastError` is a code: a final refusal says whether the sign-in or the message was
            // refused, anything else the failure's code.
            let reason = match verdict {
                SendVerdict::Terminal if code == Code::AuthFailed => "AUTH_FAILED",
                SendVerdict::Terminal => "REFUSED",
                _ => code.as_str(),
            };
            // An uncertain row is never sent again on its own (Retry or Discard in the UI); a
            // proven-unsent one is queued again. Either way the account backs off.
            end_attempt(shared, account, id, verdict, Some(reason), policy);
            !(verdict.is_uncertain() || verdict.may_retry_automatically())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_name_their_dir() {
        assert_eq!(dir_of("out/0123456789abcdef/a.pdf"), Some("0123456789abcdef"));
        for bad in ["out/a", "out//a", "att/x/a", "out/x/a/b", "out/../a", ""] {
            assert_eq!(dir_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn backoff_doubles_to_the_cap() {
        let p = RETRY;
        assert_eq!(p.next_delay(1), Duration::from_secs(5));
        assert_eq!(p.next_delay(2), Duration::from_secs(10));
        assert_eq!(p.next_delay(9), Duration::from_secs(300));
    }
}
