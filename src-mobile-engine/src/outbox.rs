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
//! The backend says where a failure fell ([`SendFail`], from core's `send_built_phased`): one
//! that may have followed an acceptance (the connection broke or timed out during or after the
//! upload) makes the row `uncertain`, never resent on its own, exactly like a crash; a refusal no
//! retry can change (a permanent 5xx, `smtp::is_terminal_send_error`) makes it `failed`; anything
//! that proves nothing was sent (connect, TLS, sign-in, MAIL/RCPT/DATA, a 4xx) puts it back to
//! `queued`, and the account backs off: 5 s, doubling, at most 300 s, like the action replay.
//! `lastError` and an event's `reason` are codes, never core's text.
//!
//! Picked files: `<cache>/out/<dir>/` is deleted once no draft and no unsent outbox row names it
//! ([`release_dirs`]): when its row is sent or discarded, or its draft deleted. [`sweep`] removes,
//! at engine open, the dirs older than a day that nothing names (a pick the page never saved).

use crate::accounts::{load_account, Code};
use crate::backend::{self, Backend, SendFail};
use crate::compose::{self, Fields};
use crate::db::{lock, Engine, Shared};
use crate::events::SEND_RESULT;
use crate::outgoing::resolve_outgoing;
use crate::rpc::{parse, RpcError};
use crate::sync::{self, Fail};
use base64::Engine as _;
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
pub(crate) fn on_open(w: &Connection, now_ms: i64) -> rusqlite::Result<bool> {
    w.execute("UPDATE outbox SET state = 'uncertain', updated_ms = ?1 WHERE state = 'sending'", [now_ms])?;
    w.execute("DELETE FROM outbox WHERE state = 'sent' AND updated_ms < ?1", [now_ms - SENT_KEEP_MS])?;
    w.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE state = 'queued')", [], |r| r.get(0))
}

// ── RPCs ────────────────────────────────────────────────────────────────────

/// `mobile.outbox.list` -> `[{id, accountId, subject, state, lastError}]`, oldest first: every
/// row not sent yet (`queued`, `sending`, `failed`, `uncertain`).
pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let rows = engine
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, account_id, draft_json, state, last_error FROM outbox WHERE state != 'sent' ORDER BY created_ms, id",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "accountId": r.get::<_, String>(1)?,
                        "subject": Fields::read(&r.get::<_, String>(2)?).subject,
                        "state": r.get::<_, String>(3)?,
                        "lastError": r.get::<_, Option<String>>(4)?,
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
/// `queued` one, at once) goes back to the worker. `INVALID` for an unknown row, one being sent
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
            if !matches!(state.as_str(), "queued" | "failed" | "uncertain") {
                return Ok(Err("the message is being sent or was sent"));
            }
            c.execute("UPDATE outbox SET state = 'queued', last_error = NULL, updated_ms = ?2 WHERE id = ?1", (&p.id, compose::now_ms()))?;
            Ok(Ok(account))
        })
        .map_err(internal)?;
    let account = out.map_err(|m| RpcError::Invalid(m.into()))?;
    engine.outbox().wake(shared, Some(&account));
    Ok(json!({ "id": p.id, "state": "queued" }))
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
                Some((state, _)) if state == "sending" => Ok(Err(())),
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
    delay: Duration,
}

struct State {
    started: bool,
    stop: bool,
    kicked: bool,
    retry: HashMap<String, Retry>,
    base: Duration,
    cap: Duration,
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

fn next_delay(prev: Option<Duration>, base: Duration, cap: Duration) -> Duration {
    match prev {
        None => base.min(cap),
        Some(d) => d.saturating_mul(2).min(cap),
    }
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
                    base: BACKOFF_BASE,
                    cap: BACKOFF_CAP,
                }),
                cv: Condvar::new(),
                cache_dir: cache_dir.to_path_buf(),
            }),
        }
    }

    /// Starts the worker if needed and makes it look at the outbox now; with `account`, that
    /// account's backoff is forgiven (the user just sent or retried).
    pub(crate) fn wake(&self, shared: &Arc<Shared>, account: Option<&str>) {
        let mut st = lock(&self.queue.state);
        if st.stop {
            return;
        }
        if !st.started {
            let (queue, sh) = (Arc::clone(&self.queue), Arc::clone(shared));
            match std::thread::Builder::new().name("mv-engine-outbox".into()).spawn(move || run(queue, sh)) {
                Ok(_) => st.started = true,
                Err(e) => {
                    shared.log(&format!("[outbox] worker: {e}"));
                    return;
                }
            }
        }
        if let Some(a) = account {
            st.retry.remove(a);
        }
        st.kicked = true;
        self.queue.cv.notify_all();
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

/// Accounts with queued rows, oldest row first.
fn queued_accounts(shared: &Shared) -> Vec<String> {
    shared
        .read(|c| {
            // An account waiting for a new sign-in is parked, and one whose password the server
            // refused is held: its rows stay queued until reauth, or the user's Retry, wakes it.
            let mut st = c.prepare_cached(&format!(
                "SELECT account_id FROM outbox o WHERE state = 'queued'
                 AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = o.account_id AND a.needs_auth != 0)
                 AND {}
                 GROUP BY account_id ORDER BY min(created_ms)",
                crate::hold::NOT_HELD_SQL.replace("{account}", "o.account_id")
            ))?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_else(|e| {
            shared.log(&format!("[outbox] read: {e}"));
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
        let now = Instant::now();
        let mut next: Option<Instant> = None;
        let ready: Vec<String> = {
            let st = lock(&queue.state);
            queued_accounts(&shared)
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
            let ok = send_account(&shared, &queue.cache_dir, account);
            let mut st = lock(&queue.state);
            if ok {
                st.retry.remove(account);
            } else {
                let delay = next_delay(st.retry.get(account).map(|r| r.delay), st.base, st.cap);
                st.retry.insert(account.clone(), Retry { at: Instant::now() + delay, delay });
            }
        }
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
    Ok(shared.read(|c| {
        let mut st = c.prepare_cached("SELECT id FROM outbox WHERE account_id = ?1 AND state = 'queued' ORDER BY created_ms, id")?;
        let rows = st.query_map([account], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        Ok(rows)
    })?)
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

/// Sends `account`'s queued rows through one backend. `false` when the account must back off.
fn send_account(shared: &Shared, cache_dir: &Path, account: &str) -> bool {
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
        if !send_one(shared, cache_dir, backend.as_mut(), account, &id) {
            return false;
        }
    }
    true
}

/// Moves row `id` from `from` to `to`; `false` when it was not in `from` (discarded, retried).
fn transition(shared: &Shared, id: &str, from: &str, to: &str, error: Option<&str>, attempt: bool) -> bool {
    shared
        .write(|c| {
            c.execute(
                "UPDATE outbox SET state = ?3, last_error = ?4, attempts = attempts + ?5, updated_ms = ?6 WHERE id = ?1 AND state = ?2",
                (id, from, to, error, attempt as i64, compose::now_ms()),
            )
        })
        .map(|n| n == 1)
        .unwrap_or_else(|e| {
            shared.log(&format!("[outbox] {id}: {from} -> {to}: {e}"));
            false
        })
}

/// Ends row `id` as `failed` with `reason`, from `from`.
fn fail_row(shared: &Shared, account: &str, id: &str, from: &str, reason: &str) {
    if transition(shared, id, from, "failed", Some(reason), from == "sending") {
        emit_result(shared, id, account, "failed", Some(reason));
    }
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

/// One attempt at row `id`. `false` when the account must back off (the row is `queued` again).
fn send_one(shared: &Shared, cache_dir: &Path, backend: &mut dyn Backend, account: &str, id: &str) -> bool {
    let row: Option<(String, Option<String>)> = shared
        .read(|c| {
            c.query_row("SELECT draft_json, message_id FROM outbox WHERE id = ?1 AND state = 'queued'", [id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
        })
        .unwrap_or(None);
    let Some((json, message_id)) = row else {
        return true;
    };
    let fields = Fields::read(&json);
    let checked = match load_account(shared, account) {
        Ok(Some(acct)) => compose::check_recipients(&acct, &fields),
        _ => return true,
    };
    if let Err(why) = checked {
        shared.log(&format!("[outbox] {account} {id}: INVALID {why}"));
        fail_row(shared, account, id, "queued", "INVALID");
        return true;
    }
    // Committed before the network: from here on, a crash leaves `sending`, read as `uncertain`.
    if !transition(shared, id, "queued", "sending", None, false) {
        return true;
    }
    let Ok(attachments) = read_attachments(cache_dir, &fields) else {
        fail_row(shared, account, id, "sending", "ATTACHMENT_MISSING");
        return true;
    };
    let email = fields.outgoing(message_id, attachments);
    match backend.send(&email) {
        Ok(sent) => {
            drop(email);
            if transition(shared, id, "sending", "sent", None, true) {
                release_dirs(shared, cache_dir, &fields.dirs());
                emit_result(shared, id, account, "sent", None);
            }
            if let Err(Fail::Code(code, why)) = backend.file_sent(&sent) {
                shared.log(&format!("[outbox] {account} {id}: filing in Sent: {} {why}", code.as_str()));
            }
            true
        }
        Err(SendFail { fail, may_have_sent, terminal }) => {
            let code = match &fail {
                Fail::Code(code, why) => {
                    shared.log(&format!("[outbox] {account} {id}: {} {why}", code.as_str()));
                    *code
                }
                Fail::Gone | Fail::Closing => Code::HostUnreachable,
            };
            if may_have_sent {
                // The server may have it: never again on its own (Retry or Discard in the UI).
                if transition(shared, id, "sending", "uncertain", Some(code.as_str()), true) {
                    emit_result(shared, id, account, "uncertain", Some(code.as_str()));
                }
                false
            } else if terminal {
                let reason = if code == Code::AuthFailed { "AUTH_FAILED" } else { "REFUSED" };
                fail_row(shared, account, id, "sending", reason);
                true
            } else {
                // Proven not sent: back to the queue, and the account backs off.
                if transition(shared, id, "sending", "queued", Some(code.as_str()), true) {
                    emit_result(shared, id, account, "queued", Some(code.as_str()));
                }
                false
            }
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
        let (b, c) = (BACKOFF_BASE, BACKOFF_CAP);
        assert_eq!(next_delay(None, b, c), Duration::from_secs(5));
        assert_eq!(next_delay(Some(Duration::from_secs(5)), b, c), Duration::from_secs(10));
        assert_eq!(next_delay(Some(Duration::from_secs(200)), b, c), Duration::from_secs(300));
    }
}
