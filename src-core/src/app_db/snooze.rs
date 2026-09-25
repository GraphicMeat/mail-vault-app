//! Snooze's durable queue (app.db schema v5).
//!
//! A snoozed message has been MOVED on the server to `snoozed_mailbox` (the
//! app's move workflow does that, so undo, the op journal and the list rules
//! hold); a row here is what `src-daemon/src/snooze_worker.rs` moves it back
//! to `from_mailbox` off, unread, at `wake_at`. The move changes the uid, and
//! the user can move the message again from any other client, so the row
//! keeps the Message-ID as its real handle and `uid_in_snoozed` (the move's
//! COPYUID, when the server gave one) only as a hint — see `pick_uid`.
//!
//! Same shape as `app_db::scheduled`: the worker is the only reader of
//! `due()`, the RPCs in `src-daemon/src/handlers/snooze.rs` own the rest.

use rusqlite::{params, Connection, OptionalExtension};

/// The one folder name snooze moves mail into. No IMAP special-use exists for
/// it, and Gmail's own snooze is not exposed over IMAP, so every provider gets
/// a plain folder (a label on Gmail) with this name.
pub const SNOOZED_MAILBOX: &str = "Snoozed";

/// Transient failures a row gets before it goes `failed`. A locked keychain
/// or an offline host never counts (`WakeOutcome::Wait`).
pub const MAX_ATTEMPTS: i64 = 5;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snooze {
    pub id: String,
    pub account_id: String,
    pub from_mailbox: String,
    pub snoozed_mailbox: String,
    pub uid_in_snoozed: Option<u32>,
    pub message_id: String,
    /// Unix ms UTC — what the user picked. Retries never move it.
    pub wake_at: i64,
    pub created_at: i64,
    /// "snoozed" | "woken" | "failed".
    pub state: String,
    pub attempts: i64,
    /// Unix ms; 0 when no retry is pending. A row is due at
    /// `max(wake_at, retry_at)`, so a backoff never rewrites the wake time.
    pub retry_at: i64,
    pub last_error: String,
}

/// What one wake attempt came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeOutcome {
    /// Moved back to `from_mailbox`, unread.
    Woken,
    /// Not in `snoozed_mailbox` any more: the user moved or deleted it from
    /// another client. Nothing to do, and nothing to report.
    NotFound,
    /// Worth another try, counted against `MAX_ATTEMPTS`.
    Transient(String),
    /// Offline, or the keychain gate is blocked: never counted, never
    /// terminal. The row stays due and is tried again when that clears.
    Wait(String),
}

/// Retry backoff after the `attempt`th transient failure: 30s, 1m, 2m, 4m.
pub fn backoff_ms(attempt: i64) -> i64 {
    30_000 * 2i64.pow((attempt.max(1) - 1).min(10) as u32)
}

/// Which uid in the Snoozed folder is this row's message. `found` is what a
/// `UID SEARCH HEADER Message-ID` there answered. The stored COPYUID wins when
/// the search confirms it (a duplicate copy of the same message may sit next
/// to it); otherwise the newest hit; `None` means it is not there at all.
pub fn pick_uid(stored: Option<u32>, found: &[u32]) -> Option<u32> {
    match stored {
        Some(uid) if found.contains(&uid) => Some(uid),
        _ => found.iter().copied().max(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const COLUMNS: &str =
    "id, account_id, from_mailbox, snoozed_mailbox, uid_in_snoozed, message_id, wake_at, created_at, state, attempts, retry_at, last_error";

fn row_to_snooze(r: &rusqlite::Row) -> rusqlite::Result<Snooze> {
    Ok(Snooze {
        id: r.get(0)?,
        account_id: r.get(1)?,
        from_mailbox: r.get(2)?,
        snoozed_mailbox: r.get(3)?,
        uid_in_snoozed: r.get(4)?,
        message_id: r.get(5)?,
        wake_at: r.get(6)?,
        created_at: r.get(7)?,
        state: r.get(8)?,
        attempts: r.get(9)?,
        retry_at: r.get(10)?,
        last_error: r.get(11)?,
    })
}

fn query(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Snooze>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(args, row_to_snooze).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn insert(
    conn: &Connection,
    id: &str,
    account_id: &str,
    from_mailbox: &str,
    snoozed_mailbox: &str,
    uid_in_snoozed: Option<u32>,
    message_id: &str,
    wake_at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO snoozes(id, account_id, from_mailbox, snoozed_mailbox, uid_in_snoozed, message_id, wake_at, created_at, state)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'snoozed')",
        params![id, account_id, from_mailbox, snoozed_mailbox, uid_in_snoozed, message_id, wake_at, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Snooze>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM snoozes WHERE id = ?1"), [id], |r| row_to_snooze(r))
        .optional()
        .map_err(|e| e.to_string())
}

/// Every `snoozed` or `failed` row (woken ones are history), soonest first,
/// optionally narrowed to one account.
pub fn list(conn: &Connection, account_id: Option<&str>) -> Result<Vec<Snooze>, String> {
    let base = format!("SELECT {COLUMNS} FROM snoozes WHERE state IN ('snoozed', 'failed')");
    match account_id {
        Some(a) => query(conn, &format!("{base} AND account_id = ?1 ORDER BY wake_at ASC"), params![a]),
        None => query(conn, &format!("{base} ORDER BY wake_at ASC"), params![]),
    }
}

/// `snoozed` rows whose `max(wake_at, retry_at)` has passed, soonest first.
pub fn due(conn: &Connection, now_ms: i64) -> Result<Vec<Snooze>, String> {
    query(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM snoozes WHERE state = 'snoozed' AND MAX(wake_at, retry_at) <= ?1
             ORDER BY MAX(wake_at, retry_at) ASC"
        ),
        params![now_ms],
    )
}

/// The worker's sleep target: the earliest `max(wake_at, retry_at)` over
/// `snoozed` rows.
pub fn next_wake_at(conn: &Connection) -> Result<Option<i64>, String> {
    conn.query_row("SELECT MIN(MAX(wake_at, retry_at)) FROM snoozes WHERE state = 'snoozed'", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// A new wake time from the user. Re-arms a `failed` row with a fresh retry
/// ladder; a `woken` row is left alone, there is nothing left to wake.
pub fn reschedule(conn: &Connection, id: &str, wake_at: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE snoozes SET wake_at = ?2, state = 'snoozed', attempts = 0, retry_at = 0, last_error = ''
         WHERE id = ?1 AND state IN ('snoozed', 'failed')",
        params![id, wake_at],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Write what a wake attempt came to. Returns the row's state afterwards.
pub fn record_outcome(conn: &Connection, id: &str, outcome: &WakeOutcome, now_ms: i64) -> Result<String, String> {
    let changed = match outcome {
        WakeOutcome::Woken | WakeOutcome::NotFound => {
            conn.execute("UPDATE snoozes SET state = 'woken', retry_at = 0, last_error = '' WHERE id = ?1", [id])
        }
        WakeOutcome::Wait(msg) => conn.execute("UPDATE snoozes SET last_error = ?2 WHERE id = ?1", params![id, msg]),
        WakeOutcome::Transient(msg) => conn.execute(
            "UPDATE snoozes SET attempts = attempts + 1, last_error = ?2,
                 state = CASE WHEN attempts + 1 >= ?3 THEN 'failed' ELSE state END,
                 retry_at = ?4 + ?5 * (1 << MIN(attempts, 10))
             WHERE id = ?1",
            params![id, msg, MAX_ATTEMPTS, now_ms, backoff_ms(1)],
        ),
    };
    changed.map_err(|e| e.to_string())?;
    conn.query_row("SELECT state FROM snoozes WHERE id = ?1", [id], |r| r.get(0)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-snooze-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn seed(c: &Connection, id: &str, wake_at: i64) {
        insert(c, id, "acct", "INBOX", SNOOZED_MAILBOX, Some(7), "<m@x>", wake_at).unwrap();
    }

    #[test]
    fn an_inserted_row_reads_back_snoozed_with_everything_it_was_given() {
        let c = conn();
        insert(&c, "a", "acct", "INBOX", "Snoozed", None, "<m@x>", 5000).unwrap();
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.account_id, "acct");
        assert_eq!(row.from_mailbox, "INBOX");
        assert_eq!(row.snoozed_mailbox, "Snoozed");
        assert_eq!(row.uid_in_snoozed, None, "a server without UIDPLUS gives no uid");
        assert_eq!(row.message_id, "<m@x>");
        assert_eq!(row.wake_at, 5000);
        assert_eq!(row.state, "snoozed");
        assert_eq!(row.attempts, 0);
        assert!(row.created_at > 0);
        assert!(get(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn list_narrows_by_account_and_leaves_woken_rows_out() {
        let c = conn();
        insert(&c, "a", "acct-1", "INBOX", "Snoozed", Some(1), "<a@x>", 2000).unwrap();
        insert(&c, "b", "acct-2", "INBOX", "Snoozed", Some(2), "<b@x>", 1000).unwrap();
        insert(&c, "c", "acct-1", "INBOX", "Snoozed", Some(3), "<c@x>", 3000).unwrap();
        record_outcome(&c, "c", &WakeOutcome::Woken, 4000).unwrap();
        let all = list(&c, None).unwrap();
        assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"], "soonest first, woken left out");
        assert_eq!(list(&c, Some("acct-1")).unwrap().len(), 1);
    }

    #[test]
    fn due_is_snoozed_rows_at_or_past_their_wake_time_soonest_first() {
        let c = conn();
        seed(&c, "later", 1500);
        seed(&c, "earlier", 500);
        seed(&c, "future", 9000);
        seed(&c, "boundary", 2000);
        let found = due(&c, 2000).unwrap();
        assert_eq!(found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["earlier", "later", "boundary"]);
    }

    #[test]
    fn woken_and_failed_rows_are_never_due() {
        let c = conn();
        seed(&c, "woken", 100);
        seed(&c, "failed", 100);
        record_outcome(&c, "woken", &WakeOutcome::Woken, 200).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            record_outcome(&c, "failed", &WakeOutcome::Transient("boom".into()), 200).unwrap();
        }
        assert_eq!(get(&c, "failed").unwrap().unwrap().state, "failed");
        assert!(due(&c, i64::MAX / 2).unwrap().is_empty());
    }

    #[test]
    fn next_wake_at_is_the_earliest_pending_wake() {
        let c = conn();
        assert_eq!(next_wake_at(&c).unwrap(), None);
        seed(&c, "a", 5000);
        seed(&c, "b", 1000);
        assert_eq!(next_wake_at(&c).unwrap(), Some(1000));
        record_outcome(&c, "b", &WakeOutcome::Woken, 1000).unwrap();
        assert_eq!(next_wake_at(&c).unwrap(), Some(5000), "a woken row drops out");
    }

    #[test]
    fn woken_and_not_found_both_end_the_row_quietly() {
        let c = conn();
        seed(&c, "moved", 100);
        seed(&c, "gone", 100);
        assert_eq!(record_outcome(&c, "moved", &WakeOutcome::Woken, 200).unwrap(), "woken");
        // The user moved it out of Snoozed from their phone: not an error.
        assert_eq!(record_outcome(&c, "gone", &WakeOutcome::NotFound, 200).unwrap(), "woken");
        let gone = get(&c, "gone").unwrap().unwrap();
        assert_eq!(gone.state, "woken");
        assert_eq!(gone.last_error, "");
    }

    #[test]
    fn a_transient_failure_backs_off_without_moving_the_wake_time() {
        let c = conn();
        seed(&c, "a", 1000);
        let state = record_outcome(&c, "a", &WakeOutcome::Transient("timeout".into()), 2000).unwrap();
        assert_eq!(state, "snoozed");
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.attempts, 1);
        assert_eq!(row.wake_at, 1000, "what the user picked stays");
        assert_eq!(row.last_error, "timeout");
        assert!(due(&c, 2000).unwrap().is_empty(), "not retried on the very next tick");
        assert_eq!(next_wake_at(&c).unwrap(), Some(2000 + backoff_ms(1)));
        assert_eq!(due(&c, 2000 + backoff_ms(1)).unwrap().len(), 1, "due again once the backoff passes");
    }

    #[test]
    fn running_out_of_attempts_marks_the_row_failed_with_the_last_error() {
        let c = conn();
        seed(&c, "a", 1000);
        for n in 1..MAX_ATTEMPTS {
            assert_eq!(record_outcome(&c, "a", &WakeOutcome::Transient(format!("try {n}")), 2000).unwrap(), "snoozed");
        }
        assert_eq!(record_outcome(&c, "a", &WakeOutcome::Transient("last".into()), 2000).unwrap(), "failed");
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.state, "failed");
        assert_eq!(row.last_error, "last");
    }

    #[test]
    fn waiting_on_the_keychain_or_the_network_never_burns_an_attempt() {
        let c = conn();
        seed(&c, "a", 1000);
        for _ in 0..(MAX_ATTEMPTS * 3) {
            assert_eq!(record_outcome(&c, "a", &WakeOutcome::Wait("keychain locked".into()), 2000).unwrap(), "snoozed");
        }
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.attempts, 0);
        assert_eq!(row.state, "snoozed");
        assert_eq!(due(&c, 2000).unwrap().len(), 1, "still due: tried again as soon as the wait clears");
    }

    #[test]
    fn rescheduling_re_arms_a_failed_row_but_leaves_a_woken_one_alone() {
        let c = conn();
        seed(&c, "failed", 1000);
        for _ in 0..MAX_ATTEMPTS {
            record_outcome(&c, "failed", &WakeOutcome::Transient("boom".into()), 2000).unwrap();
        }
        reschedule(&c, "failed", 9000).unwrap();
        let row = get(&c, "failed").unwrap().unwrap();
        assert_eq!(row.state, "snoozed");
        assert_eq!(row.wake_at, 9000);
        assert_eq!(row.attempts, 0);
        assert_eq!(row.retry_at, 0);
        assert_eq!(due(&c, 9000).unwrap().len(), 1);

        seed(&c, "woken", 1000);
        record_outcome(&c, "woken", &WakeOutcome::Woken, 1000).unwrap();
        reschedule(&c, "woken", 9000).unwrap();
        assert_eq!(get(&c, "woken").unwrap().unwrap().state, "woken", "a woken row is not re-snoozed");
    }

    #[test]
    fn the_stored_uid_wins_only_when_the_message_id_search_confirms_it() {
        assert_eq!(pick_uid(Some(7), &[3, 7, 9]), Some(7), "confirmed: use it");
        assert_eq!(pick_uid(Some(7), &[3, 9]), Some(9), "stale uid: the newest hit");
        assert_eq!(pick_uid(None, &[4]), Some(4), "no COPYUID: the search answers");
        assert_eq!(pick_uid(Some(7), &[]), None, "moved away from another client");
        assert_eq!(pick_uid(None, &[]), None);
    }
}
