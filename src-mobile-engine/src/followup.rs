//! Follow-up reminders on the phone (plan 4 Task 9, Rulings 7, 13, 14, 15): "remind me if no
//! reply in N days" on send. Worker and RPC glue only: the rows are core's `app_db::follow_up`
//! on `mobile.db`'s `follow_ups` (app.db's own DDL), what counts as a reply is core's
//! `follow_up::matcher`, and the IMAP server check is core's `follow_up::imap_check`, the
//! daemon's own.
//!
//! `mobile.compose.send {remindAfterDays: 1|3|7}` is checked before any write ([`remind_check`]:
//! Premium, and never on a Graph account, as on desktop); once the outbox commits the row `sent`
//! it records the reminder ([`record_sent`]): keyed on the Message-ID it went out under, due
//! `days` after the send, with the account's address as the sender's own.
//!
//! At the remind time the `mv-engine-followup` worker (asleep until core's `next_wake_at`, or a
//! background run's wake) checks every due row, account by account:
//!
//! 1. Locally first, no network: a `messages` row outside Sent and Drafts whose
//!    `thread_json.references` names the Message-ID, from someone other than the sender
//!    (`matcher::is_own_address`) and not titled like an automatic reply
//!    (`custody::cache::is_auto_reply_subject`), is the answer.
//! 2. Else the server, through [`Backend::reply_check`] on one backend per account: IMAP runs core
//!    `imap_check::check` (with `cache_miss` once the local check read rows of the account and
//!    found none), JMAP one `Email/query`. A reply ends the row; none, and the Sent copy found by
//!    Message-ID makes it `due`.
//!
//! A `due` row emits `mobile.followup.due` and is listed in "Follow up" (`mobile.followup.list`)
//! until the user dismisses it; with notifications on the next background run posts it once
//! ([`to_announce`], then `mark_announced` at the run's commit). Offline, or an account waiting
//! for a sign-in, never burns a try (`Outcome::Wait`); other failures back off as core says.
//! Removing the account deletes its rows (`follow_ups` is in `PER_ACCOUNT_TABLES`).

use crate::accounts::{load_account, AccountRow, Code};
use crate::backend::{self, Backend};
use crate::compose::{self, Fields};
use crate::db::{lock, Engine, EngineError, Shared};
use crate::events::FOLLOWUP_DUE;
use crate::rpc::{parse, RpcError};
use crate::sync::Fail;
use mailvault_core::app_db::follow_up::{self as store, FollowUp, Outcome};
use mailvault_core::custody::cache::is_auto_reply_subject;
use mailvault_core::follow_up::matcher;
use mailvault_core::maildir::normalize_message_id;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub(crate) const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The choices the compose sheet offers ("Remind me if no reply in N days").
const DAYS: [i64; 3] = [1, 3, 7];
/// The longest the worker sleeps between looks.
const MAX_SLEEP: Duration = Duration::from_secs(60 * 60);
/// After a pass that left a row waiting on the network (offline, a sign-in), or failed to record.
const OFFLINE_POLL: Duration = Duration::from_secs(60);
/// The shortest sleep between passes.
const MIN_SLEEP: Duration = Duration::from_secs(1);

/// One reminder a background run asks the platform to post: what the note shows and what its tap
/// opens (the Sent copy).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpDue {
    pub id: String,
    pub account_id: String,
    pub account_email: String,
    /// Where the Sent copy is, as the list stores folders.
    pub folder: String,
    pub uid: u32,
    pub subject: String,
    /// Who it went to, as the message's To said.
    pub recipients: String,
}

fn sql_err(e: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(e.into())
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

// ── Set at send time ────────────────────────────────────────────────────────

/// `remindAfterDays` of a send: `None` for none; otherwise 1, 3 or 7 (`INVALID` else), never on
/// a Graph account (`INVALID`: there is no reply check for one, as on desktop), and only with
/// Premium (`PREMIUM_REQUIRED`). No network, no write.
pub(crate) fn remind_check(shared: &Shared, acct: &AccountRow, days: Option<i64>) -> Result<Option<i64>, RpcError> {
    let Some(days) = days else { return Ok(None) };
    if !DAYS.contains(&days) {
        return Err(RpcError::Invalid(format!("remindAfterDays must be one of {DAYS:?}")));
    }
    if acct.kind == "graph" {
        return Err(RpcError::Invalid("follow-up reminders are not offered for this account".into()));
    }
    if !crate::premium::active(shared) {
        return Err(RpcError::Premium("PREMIUM_REQUIRED"));
    }
    Ok(Some(days))
}

/// The outbox committed `message_id` of `account` sent, and the send asked for a reminder in
/// `days`: the row goes in (once per Message-ID: a retried send inserts nothing twice) and the
/// worker looks at its new wake time.
pub(crate) fn record_sent(shared: &Shared, account: &str, message_id: &str, fields: &Fields, days: i64) {
    let acct = match load_account(shared, account) {
        Ok(Some(a)) => a,
        Ok(None) => return,
        Err(e) => {
            shared.log(&format!("[follow-up] {account}: reading the account: {e}"));
            return;
        }
    };
    let sent_mailbox = sent_folder(shared, account).unwrap_or_default();
    let own = vec![acct.email.clone()];
    let now = compose::now_ms();
    let id = format!("fu_{}", compose::random_hex());
    let inserted = shared.write(|c| {
        store::insert(c, &id, account, message_id, &fields.subject, &fields.to, &sent_mailbox, &own, now, now + days * DAY_MS).map_err(sql_err)
    });
    match inserted {
        Ok(_) => shared.followup.wake(),
        Err(e) => shared.log(&format!("[follow-up] {account}: recording the reminder: {e}")),
    }
}

/// The account's Sent folder as the list stores it, when it has one.
fn sent_folder(shared: &Shared, account: &str) -> Option<String> {
    shared
        .read(|c| {
            use rusqlite::OptionalExtension;
            c.query_row(
                "SELECT path FROM folders WHERE account_id = ?1 AND special_use = '\\Sent' COLLATE NOCASE ORDER BY path LIMIT 1",
                [account],
                |r| r.get(0),
            )
            .optional()
        })
        .ok()
        .flatten()
}

// ── The worker ──────────────────────────────────────────────────────────────

#[derive(Default)]
struct State {
    started: bool,
    stop: bool,
    kicked: bool,
    /// Passes begun and finished: a background run waits for one begun after its wake.
    begun: u64,
    finished: u64,
}

/// The engine's follow-up worker (`Shared::followup`): started at open, stopped with the engine.
#[derive(Default)]
pub(crate) struct Worker {
    state: Mutex<State>,
    cv: Condvar,
    /// Held for a whole pass, so two passes never check one row twice.
    pass: Mutex<()>,
}

impl Worker {
    /// Makes the worker look at the rows now.
    pub(crate) fn wake(&self) {
        let mut st = lock(&self.state);
        st.kicked = true;
        self.cv.notify_all();
    }

    /// A background run: a pass now. Answers the mark for [`Worker::wait_pass`].
    pub(crate) fn wake_for_run(&self) -> u64 {
        let mut st = lock(&self.state);
        st.kicked = true;
        self.cv.notify_all();
        st.begun
    }

    /// Waits until a pass begun after [`Worker::wake_for_run`] answered `mark` has finished, or
    /// `until`. False on `until` (or a stop); the worker goes on either way.
    pub(crate) fn wait_pass(&self, mark: u64, until: Instant) -> bool {
        let mut st = lock(&self.state);
        loop {
            if st.finished > mark {
                return true;
            }
            let now = Instant::now();
            if st.stop || !st.started || now >= until {
                return false;
            }
            st = self.cv.wait_timeout(st, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    pub(crate) fn stop(&self) {
        lock(&self.state).stop = true;
        self.cv.notify_all();
    }
}

/// Starts the worker thread (at engine open).
pub(crate) fn start(shared: &Arc<Shared>) {
    let mut st = lock(&shared.followup.state);
    if st.started || st.stop {
        return;
    }
    let sh = Arc::clone(shared);
    match std::thread::Builder::new().name("mv-engine-followup".into()).spawn(move || run(sh)) {
        Ok(_) => st.started = true,
        Err(e) => shared.log(&format!("[follow-up] worker: {e}")),
    }
}

fn run(shared: Arc<Shared>) {
    crate::sync::background_qos();
    let worker = &shared.followup;
    loop {
        {
            let mut st = lock(&worker.state);
            if st.stop || shared.is_closing() {
                return;
            }
            st.kicked = false;
            st.begun += 1;
        }
        let unsettled = pass(&shared);
        {
            let mut st = lock(&worker.state);
            st.finished += 1;
            worker.cv.notify_all();
        }
        let wait = if unsettled { OFFLINE_POLL } else { next_wait(&shared) }.max(MIN_SLEEP);
        let until = Instant::now() + wait;
        let mut st = lock(&worker.state);
        loop {
            if st.stop || shared.is_closing() {
                return;
            }
            if st.kicked {
                break;
            }
            let now = Instant::now();
            if now >= until {
                break;
            }
            st = worker.cv.wait_timeout(st, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
    }
}

/// Until the earliest waiting row's time, at most [`MAX_SLEEP`].
fn next_wait(shared: &Shared) -> Duration {
    let at = shared.read(|c| store::next_wake_at(c).map_err(sql_err)).ok().flatten();
    match at {
        Some(at) => Duration::from_millis(u64::try_from(at - compose::now_ms()).unwrap_or(0)).min(MAX_SLEEP),
        None => MAX_SLEEP,
    }
}

/// What the local rows said about one reminder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Local {
    /// A row the phone holds answers it.
    Hit,
    /// Rows of the account were read and none does.
    Miss,
    /// The phone holds no row of the account outside Sent and Drafts: no answer at all.
    Unknown,
}

/// The local check of `row` against the account's rows (see the module doc).
fn local_answer(c: &Connection, row: &FollowUp, own: &[String]) -> rusqlite::Result<Local> {
    let term = normalize_message_id(&row.message_id).to_lowercase();
    let mut skip: HashSet<String> = HashSet::new();
    let mut st = c.prepare_cached("SELECT path, special_use FROM folders WHERE account_id = ?1")?;
    for f in st.query_map([&row.account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))? {
        let (path, special) = f?;
        let own_mail = special.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("\\Sent") || s.eq_ignore_ascii_case("\\Drafts"));
        if own_mail || mailvault_core::imap::is_own_mail_path(&path) {
            skip.insert(path);
        }
    }
    let mut st = c.prepare_cached("SELECT DISTINCT folder FROM messages WHERE account_id = ?1")?;
    let read_any = st.query_map([&row.account_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?.iter().any(|f| !skip.contains(f));
    if term.is_empty() {
        return Ok(Local::Unknown);
    }
    let mut st = c.prepare_cached(
        "SELECT folder, from_address, subject, thread_json FROM messages WHERE account_id = ?1 AND instr(lower(thread_json), ?2) > 0",
    )?;
    let rows = st.query_map((&row.account_id, &term), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    for r in rows {
        let (folder, from, subject, thread) = r?;
        if skip.contains(&folder) {
            continue;
        }
        let thread: Value = serde_json::from_str(&thread).unwrap_or(Value::Null);
        let names_it = thread["references"]
            .as_array()
            .is_some_and(|ids| ids.iter().filter_map(Value::as_str).any(|m| normalize_message_id(m).eq_ignore_ascii_case(&term)));
        if names_it && !matcher::is_own_address(own, &from) && !is_auto_reply_subject(&subject) {
            return Ok(Local::Hit);
        }
    }
    Ok(if read_any { Local::Miss } else { Local::Unknown })
}

/// What a failure means for a row: offline, a sign-in to wait for, or the account going away
/// never burn a try; anything else is a try to repeat later (core backs off, then `failed`).
/// `None`: the engine is closing, stop.
fn outcome_of(fail: Fail) -> Option<Outcome> {
    match fail {
        Fail::Closing => None,
        Fail::Gone => Some(Outcome::Wait("GONE".into())),
        Fail::Code(code, _) => Some(match code {
            Code::HostUnreachable | Code::Timeout | Code::TlsFailed | Code::AuthFailed | Code::NeedsAuth | Code::Cancelled => {
                Outcome::Wait(code.as_str().into())
            }
            _ => Outcome::Transient(code.as_str().into()),
        }),
    }
}

/// The outcome as a log line names it (codes only).
fn outcome_name(o: &Outcome) -> String {
    match o {
        Outcome::Replied => "replied".into(),
        Outcome::NoReply { .. } => "no reply".into(),
        Outcome::SentCopyGone => "sent copy gone".into(),
        Outcome::Wait(code) => format!("wait {code}"),
        Outcome::Transient(code) => format!("transient {code}"),
    }
}

/// One pass over every due row; true when a row is left for the network to come back (or could
/// not be recorded), so the worker looks again soon rather than at the next remind time.
fn pass(shared: &Shared) -> bool {
    let _held = lock(&shared.followup.pass);
    let now = compose::now_ms();
    let due = match shared.read(|c| store::due(c, now).map_err(sql_err)) {
        Ok(d) => d,
        Err(e) => {
            shared.log(&format!("[follow-up] reading due rows: {e}"));
            return true;
        }
    };
    let mut by_account: HashMap<String, Vec<FollowUp>> = HashMap::new();
    for row in due {
        by_account.entry(row.account_id.clone()).or_default().push(row);
    }
    let mut unsettled = false;
    let mut accounts: Vec<String> = by_account.keys().cloned().collect();
    accounts.sort();
    for account in accounts {
        if shared.is_closing() {
            return false;
        }
        let rows = by_account.remove(&account).unwrap_or_default();
        match check_account(shared, &account, rows, now) {
            Some(u) => unsettled |= u,
            None => return false,
        }
    }
    unsettled
}

/// Checks and records `rows` of `account`. `None` when the engine closes part way.
fn check_account(shared: &Shared, account: &str, rows: Vec<FollowUp>, now: i64) -> Option<bool> {
    let acct = match load_account(shared, account) {
        Ok(Some(a)) => a,
        // Removed: its rows went with it.
        Ok(None) => return Some(false),
        Err(e) => {
            shared.log(&format!("[follow-up] {account}: reading the account: {e}"));
            return Some(true);
        }
    };
    let mut unsettled = false;
    let mut backend: Option<Box<dyn Backend + '_>> = None;
    // The sign-in failed once this pass: the account's other rows get the same answer.
    let mut open_failed: Option<Outcome> = None;
    for row in rows {
        if shared.is_closing() {
            return None;
        }
        // The row's own addresses and the login, as the daemon does.
        let mut own = row.own_addresses.clone();
        own.push(acct.email.clone());
        let outcome = if acct.kind == "graph" {
            shared.log(&format!("[follow-up] {} is on a Graph account, which has no reminder check; ending it", row.id));
            Outcome::SentCopyGone
        } else {
            let local = match shared.read(|c| local_answer(c, &row, &own)) {
                Ok(l) => l,
                Err(e) => {
                    shared.log(&format!("[follow-up] {}: reading the local rows: {e}", row.id));
                    Local::Unknown
                }
            };
            if local == Local::Hit {
                shared.log(&format!("[follow-up] {} answered on the phone", row.id));
                Outcome::Replied
            } else if let Some(failed) = &open_failed {
                failed.clone()
            } else {
                if backend.is_none() {
                    match backend::open(shared, account) {
                        Ok(b) => backend = Some(b),
                        Err(f) => {
                            let o = outcome_of(f)?;
                            open_failed = Some(o.clone());
                            record(shared, &row, &o, now, &mut unsettled);
                            continue;
                        }
                    }
                }
                let b = backend.as_mut().expect("opened above");
                match b.reply_check(&row, &own, local == Local::Miss) {
                    Ok(o) => o,
                    Err(f) => {
                        // A failed command can leave unread bytes: the next row signs in again.
                        backend = None;
                        outcome_of(f)?
                    }
                }
            }
        };
        record(shared, &row, &outcome, now, &mut unsettled);
    }
    Some(unsettled)
}

/// Writes what one check came to, and tells the page about a row that went `due`.
fn record(shared: &Shared, row: &FollowUp, outcome: &Outcome, now: i64, unsettled: &mut bool) {
    if matches!(outcome, Outcome::Wait(_)) {
        *unsettled = true;
    }
    match shared.write(|c| store::record_outcome(c, &row.id, outcome, now).map_err(sql_err)) {
        Ok(state) => {
            shared.log(&format!("[follow-up] {} checked: {}", row.id, outcome_name(outcome)));
            if state == "due" {
                shared.emit(FOLLOWUP_DUE, json!({ "id": row.id, "accountId": row.account_id }));
            }
        }
        Err(e) => {
            *unsettled = true;
            shared.log(&format!("[follow-up] {}: recording {}: {e}", row.id, outcome_name(outcome)));
        }
    }
}

// ── Background runs ─────────────────────────────────────────────────────────

/// A reminder waits for its check: the engine wants background runs (plan Ruling 13).
pub(crate) fn waiting(shared: &Shared) -> bool {
    shared
        .read(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM follow_ups WHERE state = 'waiting')", [], |r| r.get(0)))
        .unwrap_or_else(|e| {
            shared.log(&format!("[follow-up] read: {e}"));
            false
        })
}

/// A reminder's check is due now: a background run does it even with notifications off.
pub(crate) fn has_due(shared: &Shared, now_ms: i64) -> bool {
    shared
        .read(|c| {
            c.query_row("SELECT EXISTS(SELECT 1 FROM follow_ups WHERE state = 'waiting' AND MAX(remind_at, retry_at) <= ?1)", [now_ms], |r| r.get(0))
        })
        .unwrap_or_else(|e| {
            shared.log(&format!("[follow-up] read: {e}"));
            false
        })
}

/// The due reminders not posted yet (and not opened): what a background run with notifications on
/// hands the platform, oldest first.
pub(crate) fn to_announce(shared: &Shared) -> Vec<FollowUpDue> {
    shared
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT f.id, f.account_id, a.email, f.sent_mailbox, f.sent_uid, f.subject, f.recipients
                 FROM follow_ups f JOIN accounts a ON a.id = f.account_id
                 WHERE f.state = 'due' AND f.announced = 0 AND f.seen = 0 AND f.sent_uid IS NOT NULL
                 ORDER BY f.remind_at, f.id",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(FollowUpDue {
                        id: r.get(0)?,
                        account_id: r.get(1)?,
                        account_email: r.get(2)?,
                        folder: r.get(3)?,
                        uid: r.get(4)?,
                        subject: r.get(5)?,
                        recipients: r.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap_or_else(|e| {
            shared.log(&format!("[follow-up] read: {e}"));
            Vec::new()
        })
}

/// The platform posted these reminders: never again.
pub(crate) fn announced(shared: &Shared, ids: &[String]) -> Result<(), EngineError> {
    shared.write(|c| {
        for id in ids {
            store::mark_announced(c, id).map_err(sql_err)?;
        }
        Ok(())
    })
}

// ── RPC ─────────────────────────────────────────────────────────────────────

/// `mobile.followup.list` -> `{items: [{id, accountId, subject, recipients, sentAt, remindAt,
/// state: "waiting"|"due", folder, uid, seen}]}`: every active reminder, soonest first. `folder`
/// and `uid` name the Sent copy once the row is `due` (null before).
pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let rows = engine.read(|c| store::list(c, None).map_err(sql_err)).map_err(internal)?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let due = r.state == "due";
            json!({
                "id": r.id,
                "accountId": r.account_id,
                "subject": r.subject,
                "recipients": r.recipients,
                "sentAt": r.sent_at,
                "remindAt": r.remind_at,
                "state": r.state,
                "folder": if due { Value::from(r.sent_mailbox) } else { Value::Null },
                "uid": if due { json!(r.sent_uid) } else { Value::Null },
                "seen": r.seen,
            })
        })
        .collect();
    Ok(json!({ "items": items }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

/// `mobile.followup.dismiss {id}` -> `{id}`: the reminder ends (waiting or due); unknown ids are
/// no error.
pub(crate) fn dismiss(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    engine.write(|c| store::dismiss(c, &p.id).map_err(sql_err)).map_err(internal)?;
    Ok(json!({ "id": p.id }))
}

/// `mobile.followup.seen {id}` -> `{id}`: the user opened the Sent copy; it stays listed, and is
/// never posted as a notification after this.
pub(crate) fn seen(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    engine.write(|c| store::mark_seen(c, &p.id, true).map_err(sql_err)).map_err(internal)?;
    Ok(json!({ "id": p.id }))
}

// ── Test seam ───────────────────────────────────────────────────────────────

impl Engine {
    /// Tests: wakes the follow-up worker and waits (at most `wait`) for a pass that began after
    /// the wake. False when none finished in time.
    #[doc(hidden)]
    pub fn followup_check_now(&self, wait: Duration) -> bool {
        let mark = self.shared().followup.wake_for_run();
        self.shared().followup.wait_pass(mark, Instant::now() + wait)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_waits_or_backs_off_by_its_code() {
        assert_eq!(outcome_of(Fail::Code(Code::HostUnreachable, "x".into())), Some(Outcome::Wait("HOST_UNREACHABLE".into())));
        assert_eq!(outcome_of(Fail::Code(Code::AuthFailed, "x".into())), Some(Outcome::Wait("AUTH_FAILED".into())));
        assert_eq!(outcome_of(Fail::Code(Code::Invalid, "secret text".into())), Some(Outcome::Transient("INVALID".into())));
        assert_eq!(outcome_of(Fail::Closing), None);
    }
}
