//! A background run (plan Ruling 9): what iOS `BGAppRefreshTask` and the Android WorkManager
//! worker call through the shell, on the process's one engine (Ruling 12), with a budget.
//!
//! Scheduled sends (plan 4 Ruling 13): every run, notifications on or off, sends the outbox rows
//! that are due (a send-later time that came while the app was away, or a retry wait that ran
//! out): the outbox worker is woken for their accounts at the start of the run, so it sends beside
//! the INBOX passes rather than after them on what the passes left of the budget, and the run
//! waits for it before returning, inside the same budget. Follow-up reminders (plan 4 Task 9) go
//! the same way: a reminder whose time came wakes the follow-up worker, and the run waits for its
//! pass. Notifications off: only those, with no INBOX pass and nothing to post (a reminder with no
//! reply is listed, never posted); with nothing due either, no network at all. Notifications on:
//! the run also returns the reminders that found no reply and were not posted yet, committed
//! (announced) with the mail. Whether the OS should give the app runs at all is
//! [`Engine::wants_background`].
//!
//! With notifications on, each account in turn gets one quick INBOX
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
//!
//! Download (setting `backgroundDownload`, on by default; notifications on or off): after the
//! INBOX passes, each account in turn gets one download pass on the sync worker (`sync.rs`
//! `download_pass`): INBOX's new headers, the bodies of its recent mail (`body::prefetch`, bounded
//! by count, age and bytes inside the body cache's LRU), then the new headers of every other
//! folder the list has synced. So mail is there offline when the app opens. Same budget rules as
//! the INBOX passes (an equal share of what is left, none started past 80%), and the INBOX passes
//! go first, so a slow download never costs a notification. A download stops between steps (and
//! inside one between header chunks and between bodies) at its share's end, when the app comes to the front ([`set_in_front`]: the page's passes never
//! wait behind it) or when the platform ends the task ([`Engine::background_stop`]); what it wrote
//! stays, and the next run goes on from there. It never holds a write transaction across the
//! network: each body is its own short write, as an open's is.

use crate::db::{lock, Engine, EngineError, Shared};
use crate::followup::FollowUpDue;
use crate::sync::{folder_path, Ended};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// The same for the download passes.
const DOWNLOAD_ROTATION: &str = "bg.downloadRotation";

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

/// What [`Engine::background_fetch`] found: the mail to post, oldest first, the follow-up
/// reminders that found no reply (posted once each), and the token to hand to
/// [`Engine::background_commit`] once they are posted (`None` when there is nothing to post).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackgroundRun {
    pub mail: Vec<NewMail>,
    pub followups: Vec<FollowUpDue>,
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

/// What one returned run commits: each INBOX's part, and the follow-up reminders it posted.
struct Posted {
    collected: Vec<Collected>,
    followups: Vec<String>,
}

/// Runs whose mail was returned and not committed yet, by token.
#[derive(Default)]
pub(crate) struct Pending {
    runs: Mutex<Vec<(String, Posted)>>,
    next: AtomicU64,
    /// The app is in front (`mobile.app.state`): no download runs.
    in_front: AtomicBool,
    /// The platform ended the background task: the download in flight stops. Cleared when a run
    /// starts.
    stopped: AtomicBool,
    /// Held by the run in progress: one run at a time (the iOS leave-front run and a
    /// `BGAppRefreshTask`, Android's refresh and catch-up workers). A run that finds it held
    /// returns at once with nothing, so it never clears the running one's stop nor moves the
    /// rotation twice.
    running: Mutex<()>,
    /// Bodies a download fetched and could not cache (attachments not listed, cut short, gone):
    /// not asked for again while the engine runs. `(account, folder, uid)`.
    skipped: Mutex<HashSet<(String, String, u32)>>,
}

/// The app came to the front (`true`) or left it.
pub(crate) fn set_in_front(shared: &Shared, front: bool) {
    shared.background.in_front.store(front, Ordering::SeqCst);
}

/// Whether a download pass stops now: its share of the budget is spent, the app is in front, the
/// platform ended the task, or the engine is closing.
pub(crate) fn stop_downloading(shared: &Shared, deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|d| Instant::now() >= d)
        || shared.background.in_front.load(Ordering::SeqCst)
        || shared.background.stopped.load(Ordering::SeqCst)
        || shared.is_closing()
}

/// The uids of `folder` a download does not ask for again ([`Pending::skipped`]).
pub(crate) fn skipped_bodies(shared: &Shared, account: &str, folder: &str) -> HashSet<u32> {
    lock(&shared.background.skipped).iter().filter(|(a, f, _)| a == account && f == folder).map(|(_, _, u)| *u).collect()
}

pub(crate) fn skip_body(shared: &Shared, account: &str, folder: &str, uid: u32) {
    lock(&shared.background.skipped).insert((account.to_string(), folder.to_string(), uid));
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
    /// Whether the OS should keep giving the app background runs (plan Ruling 13): notifications
    /// are on, a scheduled message waits to be sent, or a follow-up reminder waits for its check.
    /// The shell re-applies its schedule from this after every RPC that can change it. Each
    /// reason is one `||` term.
    pub fn wants_background(&self) -> bool {
        self.notifications_on()
            || crate::outbox::has_scheduled(self.shared())
            || crate::followup::waiting(self.shared())
            || (self.background_download_on() && self.has_reachable_account())
    }

    /// Some account is not parked: a download has someone to dial.
    fn has_reachable_account(&self) -> bool {
        self.read(|c| c.query_row("SELECT 1 FROM accounts WHERE needs_auth = 0 LIMIT 1", [], |_| Ok(())).optional())
            .ok()
            .flatten()
            .is_some()
    }

    /// The platform is ending the background task (iOS expiration handler, Android
    /// `onStopped`): the download in flight stops before its next body or folder. The INBOX
    /// passes and sends end at their own deadlines. The next run clears it.
    pub fn background_stop(&self) {
        self.shared().background.stopped.store(true, Ordering::SeqCst);
    }

    /// One background run inside `budget`; see the module doc. The mail is not counted as
    /// notified until [`Engine::background_commit`] is called with the returned token. One run at
    /// a time: a call while another runs returns an empty run at once.
    pub fn background_fetch(&self, budget: Duration) -> Result<BackgroundRun, EngineError> {
        let start = Instant::now();
        let _running = match self.shared().background.running.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                self.shared().log("[background] a run is already in progress; this one returns with nothing");
                return Ok(BackgroundRun::default());
            }
        };
        // Every run raises Premium's clock mark, notifications on or off.
        crate::premium::observe_clock(self.shared());
        self.shared().background.stopped.store(false, Ordering::SeqCst);
        let notifications = self.notifications_on();
        let download = self.background_download_on()
            && !self.shared().background.in_front.load(Ordering::SeqCst)
            && self.has_reachable_account();
        let due = crate::outbox::due_accounts(self.shared(), now_ms());
        let checks = crate::followup::has_due(self.shared(), now_ms());
        if !notifications && !download && due.is_empty() && !checks {
            return Ok(BackgroundRun::default());
        }
        let deadline = start + budget;
        // Sends and follow-up checks beside the INBOX passes, each on its own worker thread.
        let sending = (!due.is_empty()).then(|| self.outbox().wake_for_run(self.shared(), &due));
        let checking = checks.then(|| self.shared().followup.wake_for_run());
        let run = if notifications { self.inbox_run(start, budget) } else { Ok((Vec::new(), Vec::new())) };
        // After the INBOX passes: a slow download never costs a notification.
        if download {
            if let Err(e) = self.download_run(start, budget) {
                self.shared().log(&format!("[background] download: {e}"));
            }
        }
        if let Some(mark) = sending {
            if !self.outbox().wait_rounds(mark, deadline) {
                self.shared().log("[background] the outbox did not finish inside the budget; it goes on while the app runs");
            }
        }
        if let Some(mark) = checking {
            if !self.shared().followup.wait_pass(mark, deadline) {
                self.shared().log("[background] the follow-up checks did not finish inside the budget; they go on while the app runs");
            }
        }
        let (mail, collected) = run?;
        // Notifications off: a reminder is listed, never posted.
        let followups = if notifications { crate::followup::to_announce(self.shared()) } else { Vec::new() };
        let commit = (!collected.is_empty() || !followups.is_empty()).then(|| {
            let pending = &self.shared().background;
            let token = format!("bg-{}", pending.next.fetch_add(1, Ordering::SeqCst) + 1);
            let mut runs = lock(&pending.runs);
            runs.push((token.clone(), Posted { collected, followups: followups.iter().map(|f| f.id.clone()).collect() }));
            let extra = runs.len().saturating_sub(PENDING_KEPT);
            runs.drain(..extra);
            token
        });
        Ok(BackgroundRun { mail, followups, commit })
    }

    /// The INBOX passes of a run that started at `start` with `budget` (notifications on): the
    /// new mail, oldest first, and each INBOX's part with mail in it.
    /// The accounts a run may dial (not parked, no refused password), rotated by the counter
    /// under `rotation`, which moves on by one.
    fn candidates(&self, rotation: &str) -> Result<Vec<Candidate>, EngineError> {
        let mut accounts: Vec<Candidate> = self.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT a.id FROM accounts a WHERE a.needs_auth = 0 AND {} ORDER BY a.created_ms, a.id",
                crate::hold::NOT_HELD_SQL.replace("{account}", "a.id")
            ))?;
            let rows = st.query_map([], |r| Ok(Candidate { id: r.get(0)? }))?.collect();
            rows
        })?;
        if !accounts.is_empty() {
            let turn: u64 = self.setting(rotation).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
            let first = (turn % accounts.len() as u64) as usize;
            accounts.rotate_left(first);
            if let Err(e) = self.write(|c| {
                c.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (rotation, (turn.wrapping_add(1)).to_string()),
                )
            }) {
                self.shared().log(&format!("[background] rotation: {e}"));
            }
        }
        Ok(accounts)
    }

    /// The download passes of a run that started at `start` with `budget`: one per account, read
    /// again after the INBOX passes (one may have found a refused password), each in an equal share
    /// of what is left, none started past 80% of the budget or while the app is in front.
    fn download_run(&self, start: Instant, budget: Duration) -> Result<(), EngineError> {
        let deadline = start + budget;
        let last_start = start + budget.mul_f32(0.8);
        let accounts = self.candidates(DOWNLOAD_ROTATION)?;
        let count = accounts.len();
        for (i, account) in accounts.into_iter().enumerate() {
            let now = Instant::now();
            if now >= last_start || crate::background::stop_downloading(self.shared(), Some(last_start)) {
                self.shared().log(&format!("[background] download of {} waits for the next run", account.id));
                break;
            }
            let share = deadline.saturating_duration_since(now) / (count - i) as u32;
            let until = now + share;
            let ticket = match self.sync_worker().enqueue_download(self.shared(), &account.id, until) {
                Ok(t) => t,
                Err(e) => {
                    self.shared().log(&format!("[background] {}: {e}", account.id));
                    break;
                }
            };
            match ticket.wait_until(until) {
                None => self.shared().log(&format!("[background] the download of {} did not finish in its share", account.id)),
                Some(Ended::Done) => {}
                Some(Ended::Failed(code)) => self.shared().log(&format!("[background] download of {} ended {code}", account.id)),
            }
        }
        Ok(())
    }

    fn inbox_run(&self, start: Instant, budget: Duration) -> Result<(Vec<NewMail>, Vec<Collected>), EngineError> {
        let deadline = start + budget;
        let last_start = start + budget.mul_f32(0.8);
        let accounts = self.candidates(ROTATION)?;
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
        Ok((mail, collected))
    }

    /// The platform posted the notifications of the run that returned `token`: each INBOX's
    /// watermark moves past what that run read, every message it returned is recorded as
    /// notified, and every follow-up reminder it returned as announced. An unknown or spent token
    /// changes nothing.
    pub fn background_commit(&self, token: &str) -> Result<(), EngineError> {
        let run = {
            let mut runs = lock(&self.shared().background.runs);
            let at = runs.iter().position(|(t, _)| t == token);
            at.map(|i| runs.remove(i).1)
        };
        let Some(run) = run else {
            return Ok(());
        };
        crate::followup::announced(self.shared(), &run.followups)?;
        for c in run.collected {
            let keys: Vec<String> = c.mail.iter().map(|m| m.key.clone()).collect();
            record(self.shared(), &c.account, &c.folder, c.validity, c.top, &keys)?;
        }
        Ok(())
    }
}
