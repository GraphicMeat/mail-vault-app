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

/// The text of the no-network answer while held. A worker that notes it afterwards
/// ([`note_failure`]) changes nothing: it learnt nothing from the server.
const HELD: &str = "held: the server refused the password; waiting for the user's Retry";
/// How a sign-in refusal's text starts once [`after_open`] has recorded it ([`signed_in`]): a
/// worker noting it again changes nothing either (a Retry may have signed in fine meanwhile).
const REFUSED_AT_SIGN_IN: &str = "sign-in refused: ";

fn held_fail() -> Fail {
    Fail::Code(Code::AuthFailed, HELD.into())
}

/// A password-style sign-in's failure as the worker sees it: a refusal is marked as recorded.
pub(crate) fn signed_in(fail: Fail) -> Fail {
    match fail {
        Fail::Code(Code::AuthFailed, why) if why != HELD && !why.starts_with(REFUSED_AT_SIGN_IN) => {
            Fail::Code(Code::AuthFailed, format!("{REFUSED_AT_SIGN_IN}{why}"))
        }
        other => other,
    }
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

/// After a password-style sign-in: a refusal holds the account (and says so once), but never
/// replaces a Retry's pending try (only the Retry's own try, refused, goes back to held); any
/// sign-in that worked lifts the hold; the Retry's try that failed for another reason (no
/// network) is given back. Nothing else touches the hold.
pub(crate) fn after_open<T>(shared: &Shared, account: &str, probing: bool, out: &Result<T, Fail>) {
    let k = key(account);
    let result = match out {
        Err(Fail::Code(Code::AuthFailed, why)) => {
            let newly = shared.write(|c| {
                let before = c.query_row("SELECT 1 FROM settings WHERE key = ?1", [&k], |_| Ok(())).optional()?.is_none();
                let sql = if probing {
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')"
                } else {
                    "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, '1')"
                };
                c.execute(sql, [&k])?;
                Ok(before)
            });
            if matches!(newly, Ok(true)) {
                shared.log(&format!("[auth] {account}: the server refused the sign-in; held until Retry: {why}"));
                shared.emit(SYNC_STATE, json!({ "accountId": account, "state": "error", "code": Code::AuthFailed.as_str(), "held": true }));
            }
            newly.map(|_| ())
        }
        Ok(_) if probing || is_held(shared, account) => shared.write(|c| c.execute("DELETE FROM settings WHERE key = ?1", [&k]).map(|_| ())),
        Err(_) if probing => shared.write(|c| c.execute("UPDATE settings SET value = 'probe' WHERE key = ?1 AND value = '1'", [&k]).map(|_| ())),
        _ => Ok(()),
    };
    if let Err(e) = result {
        shared.log(&format!("[auth] {account}: hold: {e}"));
    }
}

/// A worker's request failed with `code` after the sign-in (a JMAP session that answered 401 on a
/// later call): a refused password-style account is held as if its sign-in had been refused.
/// The held answer and a sign-in refusal (`why` from [`signed_in`]) were decided at the sign-in
/// and change nothing here; neither does any other failure.
pub(crate) fn note_failure(shared: &Shared, account: &str, code: Code, why: &str) {
    if code != Code::AuthFailed || why == HELD || why.starts_with(REFUSED_AT_SIGN_IN) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    fn engine() -> (tempfile::TempDir, Engine) {
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        e.write(|c| {
            c.execute(
                "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, needs_auth, created_ms)
                 VALUES ('acc_p', 'p@example.test', '', 'imap.example.test', 993, 'ssl', 'imap', 'password', 0, 1)",
                [],
            )
        })
        .unwrap();
        (tmp, e)
    }

    fn row(e: &Engine) -> Option<String> {
        state(e.shared(), "acc_p")
    }

    fn set(e: &Engine, value: &str) {
        e.write(|c| c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", (key("acc_p"), value))).unwrap();
    }

    /// The held answer a worker got with no network, noted after the user's Retry: the Retry's
    /// one try still dials.
    #[test]
    fn a_held_answer_noted_late_never_takes_a_fresh_retry_away() {
        let (_t, e) = engine();
        set(&e, "1");
        let Err(Fail::Code(code, why)) = before_open(e.shared(), "acc_p") else { panic!("held") };
        set(&e, "probe");
        note_failure(e.shared(), "acc_p", code, &why);
        assert_eq!(row(&e).as_deref(), Some("probe"));
        assert_eq!(before_open(e.shared(), "acc_p").ok(), Some(true), "the Retry's try goes ahead");
    }

    /// The same late note after the Retry's try worked: the good password is not held again.
    #[test]
    fn a_held_answer_noted_after_a_good_retry_never_holds_again() {
        let (_t, e) = engine();
        set(&e, "1");
        let Err(Fail::Code(code, why)) = before_open(e.shared(), "acc_p") else { panic!("held") };
        set(&e, "probe");
        assert_eq!(before_open(e.shared(), "acc_p").ok(), Some(true));
        after_open::<()>(e.shared(), "acc_p", true, &Ok(()));
        assert_eq!(row(&e), None);
        note_failure(e.shared(), "acc_p", code, &why);
        assert_eq!(row(&e), None, "a good password held again");
    }

    /// A refusal after the sign-in (a JMAP 401 on a later call) holds, but never replaces a
    /// pending Retry; a network failure never touches the hold.
    #[test]
    fn a_later_refusal_holds_without_replacing_a_pending_retry() {
        let (_t, e) = engine();
        note_failure(e.shared(), "acc_p", Code::HostUnreachable, "no route");
        assert_eq!(row(&e), None);
        set(&e, "probe");
        note_failure(e.shared(), "acc_p", Code::AuthFailed, "Graph list_since failed (401)");
        assert_eq!(row(&e).as_deref(), Some("probe"));
        e.write(|c| c.execute("DELETE FROM settings WHERE key = ?1", [key("acc_p")])).unwrap();
        note_failure(e.shared(), "acc_p", Code::AuthFailed, "Graph list_since failed (401)");
        assert_eq!(row(&e).as_deref(), Some("1"));
        after_open::<()>(e.shared(), "acc_p", false, &Err(Fail::Code(Code::HostUnreachable, "no route".into())));
        assert_eq!(row(&e).as_deref(), Some("1"), "a network failure leaves the hold");
        after_open::<()>(e.shared(), "acc_p", false, &Err(Fail::Code(Code::AuthFailed, "refused".into())));
        assert_eq!(row(&e).as_deref(), Some("1"));
    }

    /// Any sign-in that worked lifts the hold, not only the Retry's.
    #[test]
    fn a_successful_sign_in_always_clears_the_hold() {
        let (_t, e) = engine();
        set(&e, "1");
        after_open::<()>(e.shared(), "acc_p", false, &Ok(()));
        assert_eq!(row(&e), None);
        set(&e, "probe");
        after_open::<()>(e.shared(), "acc_p", false, &Ok(()));
        assert_eq!(row(&e), None);
    }

    /// A sign-in refusal its worker notes again after the user's Retry signed in fine: the good
    /// password is not held again (the sign-in already recorded the refusal).
    #[test]
    fn a_sign_in_refusal_noted_after_a_good_retry_never_holds_again() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, "From: a@example.test\nSubject: x\nMessage-ID: <h1@example.test>\n\nx\n".to_string()));
        let good = Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]));
        let server = MockImap::start(good.clone());
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "u@example.test", "password": "pw-hold-unit", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        assert_eq!(added["ok"], true, "{added}");
        let account = added["account"]["id"].as_str().unwrap().to_string();
        server.reset_scenario(good.clone().fault(Trigger::on("LOGIN"), Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())));
        let Err(Fail::Code(code, why)) = crate::backend::open(e.shared(), &account).map(|_| ()) else { panic!("refused") };
        assert!(code == Code::AuthFailed);
        assert!(is_held(e.shared(), &account));
        // The password works again and a sign-in goes through (the user's Retry, or a worker that
        // dialled before the hold) before the refused worker notes its failure.
        server.reset_scenario(good);
        e.write(|c| c.execute("DELETE FROM settings WHERE key = ?1", [key(&account)])).unwrap();
        assert!(crate::backend::open(e.shared(), &account).is_ok());
        assert!(!is_held(e.shared(), &account));
        note_failure(e.shared(), &account, code, &why);
        assert!(!is_held(e.shared(), &account), "a good password held again");
    }
}
