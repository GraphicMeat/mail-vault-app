//! The engine-wide hold on a refused password (or app password, or JMAP token): servers ban an
//! address after a few failed logins (fail2ban-style rules), and the app has many workers that
//! sign in (sync, live, outbox, replay, bodies, attachments, background runs). The first one the
//! server refuses holds the account; from then on [`crate::backend::open`] answers `AUTH_FAILED`
//! with no network for every worker, the outbox and replay skip the account, and background runs
//! leave it out, until the user's Retry (`mobile.accounts.retrySignIn`). Retry lets exactly one
//! sign-in through: it worked, the hold goes and the outbox and replay are woken; it was refused
//! again, the hold stays. A sign-in that failed for another reason (no network) leaves the one try
//! for the next attempt.
//!
//! OAuth accounts have their own path (refresh, `needs_auth`, `oauth.rs`). A temporary refusal
//! (`NO [UNAVAILABLE]` and the other RFC 5530 codes) is not a refusal (`accounts::map_error`).
//!
//! The hold is a `settings` row `bg.authRefused.<account>` (its name from the background run that
//! introduced it): `1` held, `probe` while a Retry's one try is due.

use crate::accounts::Code;
use crate::db::{Engine, Shared};
use crate::events::SYNC_STATE;
use crate::rpc::{parse, RpcError};
use crate::sync::Fail;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A SQL condition true when `{account}` (an expression naming the account id) is not held.
pub(crate) const NOT_HELD_SQL: &str = "NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'bg.authRefused.' || {account})";

/// How long a Retry waits for its pass before it wakes the outbox and replay anyway.
const RETRY_WAIT: Duration = Duration::from_secs(5 * 60);

fn key(account: &str) -> String {
    format!("bg.authRefused.{account}")
}

fn held_fail() -> Fail {
    Fail::Code(Code::AuthFailed, "held: the server refused the password; waiting for the user's Retry".into())
}

/// The hold's row, if any.
fn state(shared: &Shared, account: &str) -> Option<String> {
    shared
        .read(|c| c.query_row("SELECT value FROM settings WHERE key = ?1", [key(account)], |r| r.get::<_, Option<String>>(0)).optional())
        .ok()
        .flatten()
        .flatten()
}

/// Whether `account` is held (a Retry's pending try counts as held for everyone but that try).
pub(crate) fn is_held(shared: &Shared, account: &str) -> bool {
    state(shared, account).is_some()
}

/// Before a password-style sign-in: `Ok(false)` to go ahead, `Ok(true)` to go ahead as the
/// Retry's one try, [`Fail`] `AUTH_FAILED` (no network) while held.
pub(crate) fn before_open(shared: &Shared, account: &str) -> Result<bool, Fail> {
    match state(shared, account).as_deref() {
        None => Ok(false),
        Some("probe") => {
            let claimed = shared.write(|c| c.execute("UPDATE settings SET value = '1' WHERE key = ?1 AND value = 'probe'", [key(account)]))?;
            if claimed == 1 {
                Ok(true)
            } else {
                Err(held_fail())
            }
        }
        Some(_) => Err(held_fail()),
    }
}

/// After a password-style sign-in: a refusal holds the account (and says so once); the Retry's
/// try that worked lifts the hold; one that failed for another reason gives the try back.
pub(crate) fn after_open<T>(shared: &Shared, account: &str, probing: bool, out: &Result<T, Fail>) {
    let k = key(account);
    let result = match out {
        Err(Fail::Code(Code::AuthFailed, why)) => {
            let newly = shared.write(|c| {
                let before = c.query_row("SELECT 1 FROM settings WHERE key = ?1", [&k], |_| Ok(())).optional()?.is_none();
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')", [&k])?;
                Ok(before)
            });
            if matches!(newly, Ok(true)) {
                shared.log(&format!("[auth] {account}: the server refused the sign-in; held until Retry: {why}"));
                shared.emit(SYNC_STATE, json!({ "accountId": account, "state": "error", "code": Code::AuthFailed.as_str(), "held": true }));
            }
            newly.map(|_| ())
        }
        Ok(_) if probing => shared.write(|c| c.execute("DELETE FROM settings WHERE key = ?1", [&k]).map(|_| ())),
        Err(_) if probing => shared.write(|c| c.execute("UPDATE settings SET value = 'probe' WHERE key = ?1 AND value = '1'", [&k]).map(|_| ())),
        _ => Ok(()),
    };
    if let Err(e) = result {
        shared.log(&format!("[auth] {account}: hold: {e}"));
    }
}

/// A worker's request failed with `code` after the sign-in (a JMAP session that answered 401 on a
/// later call): a refused password-style account is held as if its sign-in had been refused.
pub(crate) fn note_failure(shared: &Shared, account: &str, code: Code) {
    if code != Code::AuthFailed {
        return;
    }
    let password = shared
        .read(|c| c.query_row("SELECT auth FROM accounts WHERE id = ?1", [account], |r| r.get::<_, String>(0)).optional())
        .ok()
        .flatten()
        .is_some_and(|a| a != "oauth2");
    if password {
        after_open::<()>(shared, account, false, &Err(Fail::Code(Code::AuthFailed, "refused after the sign-in".into())));
    }
}

/// Drops the account's hold (the account is being removed). Inside its write transaction.
pub(crate) fn forget(c: &Connection, account: &str) -> rusqlite::Result<()> {
    c.execute("DELETE FROM settings WHERE key = ?1", [key(account)])?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetryParams {
    account_id: String,
}

/// `mobile.accounts.retrySignIn {accountId}` -> `{queued: true}`: the user's Retry. A held
/// account gets exactly one sign-in, through one INBOX pass; when that pass ends the outbox and
/// replay look at the account again (they skip it while it is still held). Answers at once.
pub(crate) fn retry(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RetryParams = parse(params)?;
    let account = p.account_id;
    let known = engine
        .write(|c| {
            let known = c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [&account], |_| Ok(())).optional()?.is_some();
            if known {
                c.execute("UPDATE settings SET value = 'probe' WHERE key = ?1", [key(&account)])?;
            }
            Ok(known)
        })
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    if !known {
        return Err(RpcError::Invalid("unknown account".into()));
    }
    let ticket = engine.sync_worker().enqueue_inbox_waited(engine.shared(), &account).map_err(RpcError::Internal)?;
    let shared = Arc::clone(engine.shared());
    let (outbox, replay) = (engine.outbox().clone(), engine.replay().clone());
    std::thread::Builder::new()
        .name("mv-engine-retry".into())
        .spawn(move || {
            let _ = ticket.wait_until(Instant::now() + RETRY_WAIT);
            if !is_held(&shared, &account) {
                outbox.wake(&shared, Some(&account));
                replay.wake(&shared, Some(&account));
            }
        })
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    Ok(json!({ "queued": true }))
}
