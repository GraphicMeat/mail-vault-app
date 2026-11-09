//! A background run (plan Ruling 9): what iOS `BGAppRefreshTask` and the Android WorkManager
//! worker call through the shell, on the process's one engine (Ruling 12), with a budget.
//!
//! Notifications off: nothing, no network. Otherwise each account in turn gets one quick INBOX
//! pass, queued on the engine's sync worker like any other pass, so a run never writes beside a
//! pass the page started. A quick pass asks only for what arrived since the newest message the
//! list holds (IMAP `UID n:*`, Graph and JMAP by received date) and inserts those rows; flags and
//! removals wait for the next foreground pass. A parked account (`needs_auth = 1`) is never
//! dialled, nor one whose password the server refused (`hold.rs`).
//!
//! Budget: each account gets an equal share of what is left when its turn comes, and its pass
//! stops at the end of that share (between requests; a Graph throttle wait that would cross it is
//! not waited out). An account whose pass outlives its share is skipped and the run goes on with
//! the next one. No account starts once 80% of the budget is gone. The first account changes from
//! run to run, so a slow account never starves the same neighbour every time.
//!
//! What a run returns is computed on the sync worker the moment the pass completed (`collect`),
//! so another pass that is half way through inserting a burst of new mail cannot hide part of it
//! below the watermark. A run is two-phase: [`Engine::background_fetch`] returns the new unseen
//! INBOX mail and a commit token, the platform posts the notifications, then
//! [`Engine::background_commit`] moves each INBOX's watermark and records every notified message.
//! A run the platform ends before the commit returns the same mail next time (the platform's
//! notification id is stable per message, so a repost replaces). A folder with nothing to post
//! moves its watermark at once.
//!
//! Never twice: a message is notified once per identity (Message-ID, else the remote id), kept in
//! `notified` for 30 days, so one a server hands back under a new uid (a missed Graph page, a
//! renumbered folder) is not news again. Mail that arrived well before the baseline was taken
//! (notifications turned on, or a new UIDVALIDITY) is never news either. When the app leaves the
//! front, the watermark of each account it showed moves past what the list holds
//! ([`seen_in_front`]): mail the user saw listed is not notified later.

use crate::db::{lock, Engine, EngineError, Shared};
use crate::sync::{folder_path, Ended};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Mail that arrived this long before the baseline was taken is never news (clock skew between
/// the phone and the server stays inside it).
const ARRIVAL_SLACK_MS: i64 = 60 * 60 * 1000;
/// How long a notified message's identity is kept.
const NOTIFIED_KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Rows per write transaction.
const BATCH: usize = 200;
/// Commit tokens kept for a platform that has not committed yet (a later run supersedes them).
const PENDING_KEPT: usize = 4;
/// The settings key of the run counter that rotates which account goes first.
const ROTATION: &str = "bg.rotation";

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
    /// The message's identity (Message-ID, else the remote id): stable across uids, so a
    /// notification id made from it replaces rather than doubles.
    #[serde(skip)]
    pub key: String,
}

/// What [`Engine::background_fetch`] found: the mail to post, oldest first, and the token to hand
/// to [`Engine::background_commit`] once it is posted (`None` when there is nothing to post).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackgroundRun {
    pub mail: Vec<NewMail>,
    pub commit: Option<String>,
}

/// One INBOX's part of a run, read on the sync worker right after its pass completed.
#[derive(Clone, Debug)]
pub(crate) struct Collected {
    account: String,
    folder: String,
    /// The folder's generation the rows were read under.
    validity: Option<i64>,
    /// The highest uid read: the watermark once committed.
    top: i64,
    mail: Vec<NewMail>,
}

/// Runs whose mail was returned and not committed yet, by token.
#[derive(Default)]
pub(crate) struct Pending {
    runs: Mutex<Vec<(String, Vec<Collected>)>>,
    next: AtomicU64,
}

fn now_ms() -> i64 {
    crate::compose::now_ms()
}

/// Drops the account's background state (the account is being removed). Runs inside its write
/// transaction; `notify_state` and `notified` go with `PER_ACCOUNT_TABLES`.
pub(crate) fn forget(c: &Connection, account: &str) -> rusqlite::Result<()> {
    crate::sync::forget_quick_marks(c, account)?;
    crate::hold::forget(c, account)
}

/// The identity a notification is deduplicated by.
fn key_of(message_id: &str, remote_id: Option<&str>, folder: &str, validity: Option<i64>, uid: i64) -> String {
    let mid = message_id.trim();
    if !mid.is_empty() {
        format!("mid:{mid}")
    } else if let Some(r) = remote_id.filter(|r| !r.is_empty()) {
        format!("rid:{r}")
    } else {
        format!("uid:{folder}:{}:{uid}", validity.unwrap_or(0))
    }
}

/// Every INBOX the list has synced gets its baseline now: the watermark at its newest uid, timed
/// now. One with no completed pass gets none (its first run takes it). Inside the caller's write
/// transaction (turning notifications on); at most one row per account.
pub(crate) fn seed_baselines(c: &Connection) -> rusqlite::Result<()> {
    c.execute("DELETE FROM notify_state", [])?;
    c.execute(
        "INSERT INTO notify_state (account_id, folder, last_uid, uid_validity, since_ms)
         SELECT f.account_id, f.path,
                COALESCE((SELECT MAX(m.uid) FROM messages m WHERE m.account_id = f.account_id AND m.folder = f.path AND m.out_of_window_ms IS NULL), 0),
                f.uid_validity, ?1
         FROM folders f WHERE f.path = 'INBOX' COLLATE NOCASE AND f.synced_ms IS NOT NULL",
        [now_ms()],
    )?;
    Ok(())
}

/// The app left the front: each INBOX of `accounts` that has a watermark moves it past every row
/// the list holds, and records the unseen ones it passed as notified (the user saw them listed).
pub(crate) fn seen_in_front(shared: &Shared, accounts: &[String]) {
    for account in accounts {
        let out = (|| -> Result<(), EngineError> {
            let Some(folder) = folder_path(shared, account, "INBOX")? else {
                return Ok(());
            };
            let mark: Option<i64> = shared.read(|c| {
                c.query_row("SELECT last_uid FROM notify_state WHERE account_id = ?1 AND folder = ?2", (account, &folder), |r| r.get(0))
                    .optional()
            })?;
            let Some(mark) = mark else { return Ok(()) };
            let (rows, top) = read_above(shared, account, &folder, mark)?;
            let keys: Vec<String> = rows.into_iter().filter(|r| r.unseen).map(|r| r.key).collect();
            record(shared, account, &folder, None, top, &keys)
        })();
        if let Err(e) = out {
            shared.log(&format!("[background] {account}: moving the watermark on leaving: {e}"));
        }
    }
}

/// A row above a watermark.
struct Above {
    uid: i64,
    from: String,
    subject: String,
    date_ms: i64,
    /// Unseen and not deleted on the phone.
    unseen: bool,
    key: String,
}

/// The rows of `folder` above `mark`, and the highest uid among them (`mark` when none).
fn read_above(shared: &Shared, account: &str, folder: &str, mark: i64) -> Result<(Vec<Above>, i64), EngineError> {
    let validity: Option<i64> = shared.read(|c| {
        c.query_row("SELECT uid_validity FROM folders WHERE account_id = ?1 AND path = ?2", (account, folder), |r| r.get(0)).optional()
    })?
    .flatten();
    let rows = shared.read(|c| {
        let mut st = c.prepare(
            "SELECT m.uid, m.from_name, m.from_address, m.subject, m.date_ms,
                    COALESCE(m.local_seen, m.seen) = 0 AND m.local_deleted IS NULL,
                    m.message_id, r.remote_id
             FROM messages m
             LEFT JOIN remote_ids r ON r.account_id = m.account_id AND r.folder = m.folder AND r.uid = m.uid
             WHERE m.account_id = ?1 AND m.folder = ?2 AND m.uid > ?3 AND m.out_of_window_ms IS NULL ORDER BY m.uid",
        )?;
        let rows = st
            .query_map((account, folder, mark), |r| {
                let uid: i64 = r.get(0)?;
                let name: String = r.get(1)?;
                let address: String = r.get(2)?;
                let message_id: Option<String> = r.get(6)?;
                let remote: Option<String> = r.get(7)?;
                Ok(Above {
                    uid,
                    from: if name.trim().is_empty() { address } else { name },
                    subject: r.get(3)?,
                    date_ms: r.get(4)?,
                    unseen: r.get(5)?,
                    key: key_of(message_id.as_deref().unwrap_or(""), remote.as_deref(), folder, validity, uid),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let top = rows.last().map_or(mark, |r| r.uid);
    Ok((rows, top))
}

/// Records `keys` as notified (in transactions of at most [`BATCH`] rows), then moves the
/// watermark of `folder` up to `top`, unless the folder's generation is no longer `validity`
/// (then the next run takes a new baseline anyway). Identities older than 30 days are pruned.
fn record(shared: &Shared, account: &str, folder: &str, validity: Option<i64>, top: i64, keys: &[String]) -> Result<(), EngineError> {
    let now = now_ms();
    for chunk in keys.chunks(BATCH) {
        shared.write(|c| {
            let mut st = c.prepare_cached("INSERT OR IGNORE INTO notified (account_id, key, ms) VALUES (?1, ?2, ?3)")?;
            for k in chunk {
                st.execute((account, k, now))?;
            }
            Ok(())
        })?;
    }
    shared.write(|c| {
        c.execute(
            "UPDATE notify_state SET last_uid = MAX(last_uid, ?3), uid_validity = COALESCE(uid_validity, ?4)
             WHERE account_id = ?1 AND folder = ?2 AND (?4 IS NULL OR uid_validity IS NULL OR uid_validity = ?4)",
            (account, folder, top, validity),
        )?;
        c.execute(
            &format!("DELETE FROM notified WHERE (account_id, key) IN (SELECT account_id, key FROM notified WHERE ms < ?1 LIMIT {BATCH})"),
            [now - NOTIFIED_KEEP_MS],
        )
        .map(|_| ())
    })
}

/// Called on the sync worker right after a pass of `account` completed, before any other pass
/// starts: the new unseen INBOX mail above the watermark (`None`: no INBOX). Takes the baseline
/// when there is none, or when the folder's generation changed since it was taken; moves the
/// watermark at once when there is nothing to post.
pub(crate) fn collect(shared: &Shared, account: &str) -> Result<Option<Collected>, EngineError> {
    let Some(folder) = folder_path(shared, account, "INBOX")? else {
        return Ok(None);
    };
    let email: String = shared
        .read(|c| c.query_row("SELECT email FROM accounts WHERE id = ?1", [account], |r| r.get(0)).optional())?
        .unwrap_or_default();
    let (validity, state, top): (Option<i64>, Option<(i64, Option<i64>, Option<i64>)>, i64) = shared.read(|c| {
        let validity: Option<i64> =
            c.query_row("SELECT uid_validity FROM folders WHERE account_id = ?1 AND path = ?2", (account, &folder), |r| r.get(0)).optional()?.flatten();
        let state = c
            .query_row(
                "SELECT last_uid, uid_validity, since_ms FROM notify_state WHERE account_id = ?1 AND folder = ?2",
                (account, &folder),
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let top: i64 = c.query_row("SELECT COALESCE(MAX(uid), 0) FROM messages WHERE account_id = ?1 AND folder = ?2 AND out_of_window_ms IS NULL", (account, &folder), |r| r.get(0))?;
        Ok((validity, state, top))
    })?;
    let baseline = |shared: &Shared| -> Result<Option<Collected>, EngineError> {
        shared.write(|c| {
            c.execute(
                "INSERT INTO notify_state (account_id, folder, last_uid, uid_validity, since_ms) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (account_id, folder) DO UPDATE SET
                   last_uid = excluded.last_uid, uid_validity = excluded.uid_validity, since_ms = excluded.since_ms",
                (account, &folder, top, validity, now_ms()),
            )
        })?;
        Ok(Some(Collected { account: account.to_string(), folder: folder.clone(), validity, top, mail: Vec::new() }))
    };
    let (mark, since_ms) = match state {
        // First run, a folder whose uids started over below the mark, or a new UIDVALIDITY.
        None => return baseline(shared),
        Some((mark, _, _)) if mark > top => return baseline(shared),
        Some((_, Some(was), _)) if validity.is_some_and(|v| v != was) => return baseline(shared),
        Some((mark, _, since)) => (mark, since),
    };
    let (rows, scanned) = read_above(shared, account, &folder, mark)?;
    let keys: Vec<String> = rows.iter().filter(|r| r.unseen).map(|r| r.key.clone()).collect();
    let known: std::collections::HashSet<String> = shared.read(|c| {
        let mut st = c.prepare_cached("SELECT 1 FROM notified WHERE account_id = ?1 AND key = ?2")?;
        let mut out = std::collections::HashSet::new();
        for k in &keys {
            if st.query_row((account, k), |_| Ok(())).optional()?.is_some() {
                out.insert(k.clone());
            }
        }
        Ok(out)
    })?;
    let floor = since_ms.map(|s| s - ARRIVAL_SLACK_MS);
    let mail: Vec<NewMail> = rows
        .into_iter()
        .filter(|r| r.unseen && !known.contains(&r.key) && floor.is_none_or(|f| r.date_ms >= f))
        .map(|r| NewMail {
            account_id: account.to_string(),
            account_email: email.clone(),
            folder: folder.clone(),
            uid: r.uid as u32,
            from: r.from,
            subject: r.subject,
            date_ms: r.date_ms,
            key: r.key,
        })
        .collect();
    if mail.is_empty() {
        // Nothing to post: nothing a lost commit could lose.
        if scanned > mark {
            record(shared, account, &folder, validity, scanned, &[])?;
        }
    }
    Ok(Some(Collected { account: account.to_string(), folder, validity, top: scanned, mail }))
}

struct Candidate {
    id: String,
}

impl Engine {
    /// One background run inside `budget`; see the module doc. The mail is not counted as
    /// notified until [`Engine::background_commit`] is called with the returned token.
    pub fn background_fetch(&self, budget: Duration) -> Result<BackgroundRun, EngineError> {
        let start = Instant::now();
        // Every run raises Premium's clock mark, notifications on or off.
        crate::premium::observe_clock(self.shared());
        if !self.notifications_on() {
            return Ok(BackgroundRun::default());
        }
        let deadline = start + budget;
        let last_start = start + budget.mul_f32(0.8);
        let mut accounts: Vec<Candidate> = self.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT a.id FROM accounts a WHERE a.needs_auth = 0 AND {} ORDER BY a.created_ms, a.id",
                crate::hold::NOT_HELD_SQL.replace("{account}", "a.id")
            ))?;
            let rows = st.query_map([], |r| Ok(Candidate { id: r.get(0)? }))?.collect();
            rows
        })?;
        if !accounts.is_empty() {
            let turn: u64 = self.setting(ROTATION).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
            let first = (turn % accounts.len() as u64) as usize;
            accounts.rotate_left(first);
            if let Err(e) = self.write(|c| {
                c.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (ROTATION, (turn.wrapping_add(1)).to_string()),
                )
            }) {
                self.shared().log(&format!("[background] rotation: {e}"));
            }
        }
        let mut collected: Vec<Collected> = Vec::new();
        let count = accounts.len();
        for (i, account) in accounts.into_iter().enumerate() {
            let now = Instant::now();
            if now >= last_start {
                self.shared().log(&format!("[background] budget mostly spent; {} waits for the next run", account.id));
                break;
            }
            // An equal share of what is left; the last account may use all of it.
            let share = deadline.saturating_duration_since(now) / (count - i) as u32;
            let until = now + share;
            let ticket = match self.sync_worker().enqueue_waited(self.shared(), &account.id, until) {
                Ok(t) => t,
                Err(e) => {
                    self.shared().log(&format!("[background] {}: {e}", account.id));
                    break;
                }
            };
            match ticket.wait_until(until) {
                None => self.shared().log(&format!("[background] {} did not finish in its share of the budget", account.id)),
                Some(Ended::Done) => match ticket.collected() {
                    Some(Ok(Some(c))) => collected.push(c),
                    Some(Ok(None)) | None => {}
                    Some(Err(e)) => self.shared().log(&format!("[background] {}: {e}", account.id)),
                },
                Some(Ended::Failed(code)) => self.shared().log(&format!("[background] {} pass ended {code}", account.id)),
            }
        }
        collected.retain(|c| !c.mail.is_empty());
        let mut mail: Vec<NewMail> = collected.iter().flat_map(|c| c.mail.iter().cloned()).collect();
        mail.sort_by(|a, b| (a.date_ms, a.uid).cmp(&(b.date_ms, b.uid)));
        let commit = (!collected.is_empty()).then(|| {
            let pending = &self.shared().background;
            let token = format!("bg-{}", pending.next.fetch_add(1, Ordering::SeqCst) + 1);
            let mut runs = lock(&pending.runs);
            runs.push((token.clone(), collected));
            let extra = runs.len().saturating_sub(PENDING_KEPT);
            runs.drain(..extra);
            token
        });
        Ok(BackgroundRun { mail, commit })
    }

    /// The platform posted the notifications of the run that returned `token`: each INBOX's
    /// watermark moves past what that run read, and every message it returned is recorded as
    /// notified. An unknown or spent token changes nothing.
    pub fn background_commit(&self, token: &str) -> Result<(), EngineError> {
        let run = {
            let mut runs = lock(&self.shared().background.runs);
            let at = runs.iter().position(|(t, _)| t == token);
            at.map(|i| runs.remove(i).1)
        };
        let Some(run) = run else {
            return Ok(());
        };
        for c in run {
            let keys: Vec<String> = c.mail.iter().map(|m| m.key.clone()).collect();
            record(self.shared(), &c.account, &c.folder, c.validity, c.top, &keys)?;
        }
        Ok(())
    }
}
