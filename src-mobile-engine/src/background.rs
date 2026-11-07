//! A background run (plan Ruling 9): what iOS `BGAppRefreshTask` and the Android WorkManager
//! worker call through the shell, on the process's one engine (Ruling 12), with a budget.
//!
//! Notifications off: nothing, no network. Otherwise each account in turn (oldest first) gets one
//! headers-only INBOX pass, queued on the engine's sync worker like any other pass, so a run
//! never writes beside a pass the page started. The pass is a `quick` one: Graph asks for its
//! newest message first and relists the window only when that message is new to it. A parked
//! account (`needs_auth = 1`) is never dialled, nor a password (or app password, or JMAP token)
//! account whose last sign-in was refused: servers ban an address after a few failed logins, and
//! a background run every 15 minutes would get there. A pass that signs in again (the app in
//! front, the user fixed the password) lifts that hold.
//!
//! The run waits for each pass until the budget is spent, and starts no account once 80% of it is
//! gone. A pass still running at the deadline goes on in the worker; its mail is the next run's.
//! After a pass that completed, one write transaction reads the unseen INBOX rows above the
//! folder's `notify_state` watermark and moves the watermark past every row it read, so mail is
//! returned once, and only mail the run returned (or that was read already) is ever passed. The
//! first run for a folder only sets the watermark at the folder's newest uid: turning
//! notifications on is no flood (turning them on also empties `notify_state`, see `settings.rs`).

use crate::db::{Engine, EngineError, Shared};
use crate::sync::{folder_path, Ended, Fail};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::time::{Duration, Instant};

/// One message a background run found: what a notification shows and what a tap opens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMail {
    pub account_id: String,
    pub account_email: String,
    /// The INBOX's stored path (`INBOX`).
    pub folder: String,
    pub uid: u32,
    /// The sender's display name, or the address when it has none.
    pub from: String,
    pub subject: String,
    /// Sort key only.
    #[serde(skip)]
    pub date_ms: i64,
}

/// The settings key that holds a refused sign-in back from background runs.
fn refused_key(account: &str) -> String {
    format!("bg.authRefused.{account}")
}

/// Called by the sync worker after every pass: a password-style account whose sign-in was refused
/// is held back from background runs; a pass that signed in lifts the hold. OAuth accounts have
/// their own path (refresh, then `needs_auth`).
pub(crate) fn note_sign_in(shared: &Shared, account: &str, out: &Result<(), Fail>) {
    let refused = matches!(out, Err(Fail::Code(crate::accounts::Code::AuthFailed, _)));
    if !refused && out.is_err() {
        return;
    }
    let key = refused_key(account);
    let held = shared
        .read(|c| c.query_row("SELECT 1 FROM settings WHERE key = ?1", [&key], |_| Ok(())).optional())
        .ok()
        .flatten()
        .is_some();
    if refused == held {
        return;
    }
    let result = shared.write(|c| {
        if refused {
            let oauth: Option<String> = c.query_row("SELECT auth FROM accounts WHERE id = ?1", [account], |r| r.get(0)).optional()?;
            if oauth.is_some_and(|a| a != "oauth2") {
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')", [&key])?;
            }
        } else {
            c.execute("DELETE FROM settings WHERE key = ?1", [&key])?;
        }
        Ok(())
    });
    if let Err(e) = result {
        shared.log(&format!("[background] sign-in hold for {account}: {e}"));
    }
}

/// Drops the account's hold (the account is being removed). Runs inside its write transaction.
pub(crate) fn forget(c: &Connection, account: &str) -> rusqlite::Result<()> {
    c.execute("DELETE FROM settings WHERE key = ?1", [refused_key(account)])?;
    Ok(())
}

struct Candidate {
    id: String,
    email: String,
}

impl Engine {
    /// One background run inside `budget`; see the module doc. Returns the new unseen INBOX mail,
    /// oldest first, already counted as notified.
    pub fn background_fetch(&self, budget: Duration) -> Result<Vec<NewMail>, EngineError> {
        let start = Instant::now();
        if !self.notifications_on() {
            return Ok(Vec::new());
        }
        let deadline = start + budget;
        let last_start = start + budget.mul_f32(0.8);
        let accounts: Vec<Candidate> = self.read(|c| {
            let mut st = c.prepare(
                "SELECT a.id, a.email FROM accounts a
                 WHERE a.needs_auth = 0
                   AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'bg.authRefused.' || a.id)
                 ORDER BY a.created_ms, a.id",
            )?;
            let rows = st.query_map([], |r| Ok(Candidate { id: r.get(0)?, email: r.get(1)? }))?.collect();
            rows
        })?;
        let mut found = Vec::new();
        for account in accounts {
            if Instant::now() >= last_start {
                self.shared().log(&format!("[background] budget mostly spent; {} waits for the next run", account.id));
                break;
            }
            let ticket = match self.sync_worker().enqueue_waited(self.shared(), &account.id) {
                Ok(t) => t,
                Err(e) => {
                    self.shared().log(&format!("[background] {}: {e}", account.id));
                    break;
                }
            };
            match ticket.wait_until(deadline) {
                None => {
                    self.shared().log(&format!("[background] {} did not finish in the budget", account.id));
                    break;
                }
                Some(Ended::Done) => match self.take_new_mail(&account) {
                    Ok(mut mail) => found.append(&mut mail),
                    Err(e) => self.shared().log(&format!("[background] {}: {e}", account.id)),
                },
                Some(Ended::Failed(code)) => self.shared().log(&format!("[background] {} pass ended {code}", account.id)),
            }
        }
        found.sort_by(|a, b| (a.date_ms, a.uid).cmp(&(b.date_ms, b.uid)));
        Ok(found)
    }

    /// The unseen INBOX rows of `account` above its watermark, and the watermark moved past every
    /// row read, in one write transaction. The first time (no watermark, or a folder whose uids
    /// started over below it) only sets the watermark.
    fn take_new_mail(&self, account: &Candidate) -> Result<Vec<NewMail>, EngineError> {
        let Some(folder) = folder_path(self.shared(), &account.id, "INBOX")? else {
            return Ok(Vec::new());
        };
        self.write(|c| {
            let id = account.id.as_str();
            let mark: Option<i64> = c
                .query_row("SELECT last_uid FROM notify_state WHERE account_id = ?1 AND folder = ?2", (id, &folder), |r| r.get(0))
                .optional()?;
            let top: i64 = c.query_row(
                "SELECT COALESCE(MAX(uid), 0) FROM messages WHERE account_id = ?1 AND folder = ?2",
                (id, &folder),
                |r| r.get(0),
            )?;
            let set = |c: &Connection, uid: i64| {
                c.execute(
                    "INSERT INTO notify_state (account_id, folder, last_uid) VALUES (?1, ?2, ?3)
                     ON CONFLICT (account_id, folder) DO UPDATE SET last_uid = excluded.last_uid",
                    (id, &folder, uid),
                )
            };
            let mark = match mark {
                Some(m) if m <= top => m,
                // First run, or the folder's uids started over (a new UIDVALIDITY): a new baseline.
                _ => {
                    set(c, top)?;
                    return Ok(Vec::new());
                }
            };
            let mut st = c.prepare(
                "SELECT uid, from_name, from_address, subject, date_ms,
                        COALESCE(local_seen, seen) = 0 AND local_deleted IS NULL
                 FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid > ?3 ORDER BY uid",
            )?;
            let rows = st
                .query_map((id, &folder, mark), |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, bool>(5)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let Some(last) = rows.last().map(|r| r.0) else {
                return Ok(Vec::new());
            };
            set(c, last)?;
            Ok(rows
                .into_iter()
                .filter(|r| r.5)
                .map(|(uid, name, address, subject, date_ms, _)| NewMail {
                    account_id: account.id.clone(),
                    account_email: account.email.clone(),
                    folder: folder.clone(),
                    uid: uid as u32,
                    from: if name.trim().is_empty() { address } else { name },
                    subject,
                    date_ms,
                })
                .collect())
        })
    }
}
