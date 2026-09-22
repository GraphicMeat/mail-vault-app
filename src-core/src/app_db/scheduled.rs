//! Scheduled Send's durable queue (app.db schema v3).
//!
//! A row here points at a `.eml` already frozen and written into the
//! account's vault `Scheduled` mailbox (`mailbox`+`uid`, not `msg_key` — a
//! frozen draft has no Message-ID yet, and it lives in a mailbox only this
//! app ever writes or moves, so the identity churn `msg_key` exists for does
//! not apply here). `src-daemon/src/scheduled_send_worker.rs` is the only
//! reader of `due()`; the RPCs in `src-daemon/src/handlers/scheduled.rs` own
//! everything else.
//!
//! `fire_at` is a cache of `local_time`+`tz`, recomputed by the app on every
//! launch (see the plan's timezone rule) — this layer only ever compares it
//! to "now", never interprets the wall clock itself.

use super::db::in_txn;
use rusqlite::{params, Connection, OptionalExtension};

/// Retries a row gets — including a `sending` row a crash left behind — before
/// it is unrecoverable. Shared by "this failed 3 times in a row" and "this
/// crashed mid-send 3 times in a row"; both are the same question, "have we
/// tried enough that resending blind is worse than stopping".
pub const MAX_ATTEMPTS: i64 = 3;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledSend {
    pub id: String,
    pub account_id: String,
    pub mailbox: String,
    pub uid: u32,
    /// Opaque to this layer — `src-daemon`'s worker parses it. Documented
    /// shape: `{"from","to","cc","bcc"}` (comma-separated address lists, same
    /// as `OutgoingEmail`), plus whatever else the daemon needs to replay a
    /// send (e.g. the Sent-folder append target).
    pub envelope: String,
    pub local_time: String,
    pub tz: String,
    pub fire_at: i64,
    /// "queued" | "sending" | "sent" | "failed" | "cancelled".
    pub status: String,
    pub attempts: i64,
    pub last_error: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What `attempt_before_send` decided. `Send` means the caller may actually
/// dial out; `CeilingExceeded` means it already marked the row `failed` and
/// there is nothing left for the caller to do but report that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptOutcome {
    Send { attempt: i64 },
    CeilingExceeded,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const COLUMNS: &str =
    "id, account_id, mailbox, uid, envelope, local_time, tz, fire_at, status, attempts, last_error, created_at, updated_at";

fn row_to_scheduled(r: &rusqlite::Row) -> rusqlite::Result<ScheduledSend> {
    Ok(ScheduledSend {
        id: r.get(0)?,
        account_id: r.get(1)?,
        mailbox: r.get(2)?,
        uid: r.get(3)?,
        envelope: r.get(4)?,
        local_time: r.get(5)?,
        tz: r.get(6)?,
        fire_at: r.get(7)?,
        status: r.get(8)?,
        attempts: r.get(9)?,
        last_error: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

/// Insert a fresh row. `id`/`status`/`attempts`/`last_error`/`created_at`/
/// `updated_at` are this function's to set — the caller supplies only what a
/// new schedule actually varies on.
pub fn insert(
    conn: &Connection,
    id: &str,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    envelope: &str,
    local_time: &str,
    tz: &str,
    fire_at: i64,
) -> Result<(), String> {
    let at = now_ms();
    conn.execute(
        "INSERT INTO scheduled_sends(id, account_id, mailbox, uid, envelope, local_time, tz, fire_at, status, attempts, last_error, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'queued',0,'',?9,?9)",
        params![id, account_id, mailbox, uid, envelope, local_time, tz, fire_at, at],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Every row, newest schedule first, optionally narrowed to one account.
pub fn list(conn: &Connection, account_id: Option<&str>) -> Result<Vec<ScheduledSend>, String> {
    let sql = format!(
        "SELECT {COLUMNS} FROM scheduled_sends {} ORDER BY fire_at ASC",
        if account_id.is_some() { "WHERE account_id = ?1" } else { "" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match account_id {
        Some(a) => stmt.query_map(params![a], row_to_scheduled),
        None => stmt.query_map([], row_to_scheduled),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<ScheduledSend>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM scheduled_sends WHERE id = ?1"), [id], |r| row_to_scheduled(r))
        .optional()
        .map_err(|e| e.to_string())
}

/// Reschedule and/or re-arm a row a user edited. A `failed` or `cancelled`
/// row is un-stuck back to `queued` by this — rescheduling it *is* the user
/// asking for it to fire again, so it also gets a fresh `attempts` count: a
/// row that failed by running out of tries would otherwise hit the ceiling
/// on its very next firing and fail again without being sent. A `sent` row
/// is left alone, there is nothing left to schedule.
pub fn update_schedule(conn: &Connection, id: &str, local_time: &str, tz: &str, fire_at: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_sends
         SET local_time = ?2, tz = ?3, fire_at = ?4, updated_at = ?5,
             status = CASE WHEN status IN ('failed', 'cancelled') THEN 'queued' ELSE status END,
             attempts = CASE WHEN status IN ('failed', 'cancelled') THEN 0 ELSE attempts END
         WHERE id = ?1",
        params![id, local_time, tz, fire_at, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Undo a `bump_attempt` (via `attempt_before_send`) when the attempt never
/// actually happened — the row turned out to be offline, not sent-and-failed.
/// Floors at 0 so a release racing another one (or called on a row that was
/// never bumped) cannot go negative and desync the ceiling check in
/// `attempt_before_send`. Without this, repeated offline outcomes would burn
/// `MAX_ATTEMPTS` and eventually mark a never-sent message `failed`.
pub fn release_attempt(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_sends SET attempts = MAX(attempts - 1, 0), updated_at = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Push a row's `fire_at` forward without touching `local_time`/`tz`/status —
/// the worker's exponential-backoff step after a transient send failure.
/// Unlike `update_schedule` (a user reschedule), this never un-fails or
/// un-cancels a row; it is only ever called on one already `queued`.
pub fn push_fire_at(conn: &Connection, id: &str, fire_at: i64) -> Result<(), String> {
    conn.execute("UPDATE scheduled_sends SET fire_at = ?2, updated_at = ?3 WHERE id = ?1", params![id, fire_at, now_ms()])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn set_status(conn: &Connection, id: &str, status: &str, last_error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_sends SET status = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status, last_error, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// `+1` on `attempts`, returning the new count. The worker calls this before
/// every send it actually makes — including a replay of a `sending` row a
/// crash left behind — so the count always reflects tries, not successes.
pub fn bump_attempt(conn: &Connection, id: &str) -> Result<i64, String> {
    in_txn(conn, || {
        conn.execute(
            "UPDATE scheduled_sends SET attempts = attempts + 1, updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        conn.query_row("SELECT attempts FROM scheduled_sends WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|e| e.to_string())
    })
}

/// Idempotency guard for a row about to be sent — including one that comes
/// back `due()` because a `sending` row was left behind by a crash and may
/// already have reached the server. Bumps `attempts` unconditionally (never
/// silently resend without a trace), then refuses to hand the caller a `Send`
/// once that count is past `MAX_ATTEMPTS`: it marks the row `failed` itself,
/// with a message that says delivery is uncertain rather than claiming it
/// definitely failed.
pub fn attempt_before_send(conn: &Connection, id: &str) -> Result<AttemptOutcome, String> {
    let attempt = bump_attempt(conn, id)?;
    if attempt > MAX_ATTEMPTS {
        set_status(
            conn,
            id,
            "failed",
            "Delivery is uncertain after repeated attempts (possibly following a crash) — check the Sent folder before retrying.",
        )?;
        return Ok(AttemptOutcome::CeilingExceeded);
    }
    Ok(AttemptOutcome::Send { attempt })
}

pub fn cancel(conn: &Connection, id: &str) -> Result<(), String> {
    set_status(conn, id, "cancelled", "")
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM scheduled_sends WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
}

/// Rows worth firing right now: `queued` and due, plus `sending` (a crash
/// recovery case — see `attempt_before_send`). Never `sent`, `failed` or
/// `cancelled`. Oldest `fire_at` first, so a catch-up pass replays history in
/// the order the user asked for it.
pub fn due(conn: &Connection, now_ms: i64) -> Result<Vec<ScheduledSend>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM scheduled_sends
             WHERE status IN ('queued', 'sending') AND fire_at <= ?1
             ORDER BY fire_at ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![now_ms], row_to_scheduled).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// The earliest `fire_at` the worker still has to wake up for, across
/// `queued` and `sending` rows — its sleep target between catch-up passes.
pub fn next_fire_at(conn: &Connection) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT MIN(fire_at) FROM scheduled_sends WHERE status IN ('queued', 'sending')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-scheduled-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn seed(c: &Connection, id: &str, fire_at: i64) {
        insert(c, id, "acct", "Scheduled", 1, "{}", "2026-09-22T09:00", "Europe/Vilnius", fire_at).unwrap();
    }

    #[test]
    fn a_queued_row_due_in_the_past_is_returned() {
        let c = conn();
        seed(&c, "a", 1000);
        assert_eq!(due(&c, 2000).unwrap().len(), 1);
    }

    #[test]
    fn a_queued_row_due_in_the_future_is_not_returned() {
        let c = conn();
        seed(&c, "a", 5000);
        assert!(due(&c, 2000).unwrap().is_empty());
    }

    #[test]
    fn a_row_exactly_at_fire_at_is_due() {
        let c = conn();
        seed(&c, "a", 2000);
        assert_eq!(due(&c, 2000).unwrap().len(), 1, "fire_at <= now must include the boundary");
    }

    #[test]
    fn a_sending_row_left_by_a_crash_comes_back_as_due() {
        let c = conn();
        seed(&c, "a", 1000);
        set_status(&c, "a", "sending", "").unwrap();
        let found = due(&c, 2000).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].status, "sending");
    }

    #[test]
    fn sent_failed_and_cancelled_rows_are_never_due() {
        let c = conn();
        seed(&c, "sent", 1000);
        seed(&c, "failed", 1000);
        seed(&c, "cancelled", 1000);
        set_status(&c, "sent", "sent", "").unwrap();
        set_status(&c, "failed", "failed", "boom").unwrap();
        cancel(&c, "cancelled").unwrap();
        assert!(due(&c, 2000).unwrap().is_empty());
    }

    #[test]
    fn due_rows_come_back_oldest_first() {
        let c = conn();
        seed(&c, "later", 500);
        seed(&c, "earlier", 100);
        let found = due(&c, 1000).unwrap();
        assert_eq!(found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["earlier", "later"]);
    }

    #[test]
    fn next_fire_at_is_the_minimum_over_queued_and_sending_only() {
        let c = conn();
        assert_eq!(next_fire_at(&c).unwrap(), None);
        seed(&c, "a", 5000);
        seed(&c, "b", 1000);
        assert_eq!(next_fire_at(&c).unwrap(), Some(1000));
        set_status(&c, "b", "sent", "").unwrap();
        assert_eq!(next_fire_at(&c).unwrap(), Some(5000), "a sent row must drop out");
    }

    #[test]
    fn attempts_below_the_ceiling_are_handed_to_the_caller_to_send() {
        let c = conn();
        seed(&c, "a", 1000);
        for expected in 1..=MAX_ATTEMPTS {
            assert_eq!(attempt_before_send(&c, "a").unwrap(), AttemptOutcome::Send { attempt: expected });
        }
        assert_eq!(get(&c, "a").unwrap().unwrap().status, "queued", "still under the ceiling");
    }

    #[test]
    fn exceeding_the_ceiling_marks_the_row_failed_with_an_uncertain_message_and_refuses_to_send() {
        let c = conn();
        seed(&c, "a", 1000);
        for _ in 1..=MAX_ATTEMPTS {
            attempt_before_send(&c, "a").unwrap();
        }
        let outcome = attempt_before_send(&c, "a").unwrap();
        assert_eq!(outcome, AttemptOutcome::CeilingExceeded);
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.last_error.to_lowercase().contains("uncertain"), "{}", row.last_error);
    }

    #[test]
    fn a_crash_recovered_sending_row_is_also_subject_to_the_ceiling() {
        // The exact idempotency scenario the plan calls out: a `sending` row
        // may already have been delivered by the crashed attempt. Silently
        // resending it forever is worse than stopping and saying so.
        let c = conn();
        seed(&c, "a", 1000);
        set_status(&c, "a", "sending", "").unwrap();
        for _ in 1..=MAX_ATTEMPTS {
            attempt_before_send(&c, "a").unwrap();
        }
        assert_eq!(attempt_before_send(&c, "a").unwrap(), AttemptOutcome::CeilingExceeded);
        assert_eq!(get(&c, "a").unwrap().unwrap().status, "failed");
    }

    #[test]
    fn release_attempt_undoes_a_bump_with_a_floor_of_zero() {
        let c = conn();
        seed(&c, "a", 1000);
        attempt_before_send(&c, "a").unwrap();
        assert_eq!(get(&c, "a").unwrap().unwrap().attempts, 1);
        release_attempt(&c, "a").unwrap();
        assert_eq!(get(&c, "a").unwrap().unwrap().attempts, 0);
        // A release with nothing to undo must not go negative.
        release_attempt(&c, "a").unwrap();
        assert_eq!(get(&c, "a").unwrap().unwrap().attempts, 0);
    }

    /// The exact scenario the worker's offline branch exists for: a row that
    /// keeps discovering the network is down must never burn through the
    /// ceiling for it, however many times that happens in a row.
    #[test]
    fn repeated_offline_outcomes_never_reach_the_ceiling() {
        let c = conn();
        seed(&c, "a", 1000);
        for _ in 0..(MAX_ATTEMPTS * 5) {
            let outcome = attempt_before_send(&c, "a").unwrap();
            assert_eq!(outcome, AttemptOutcome::Send { attempt: 1 }, "a released attempt must not accumulate");
            release_attempt(&c, "a").unwrap();
        }
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.status, "queued", "must never have been marked failed");
        assert_eq!(row.attempts, 0);
    }

    #[test]
    fn push_fire_at_moves_the_wake_target_without_touching_local_time_or_status() {
        let c = conn();
        seed(&c, "a", 1000);
        push_fire_at(&c, "a", 5000).unwrap();
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.fire_at, 5000);
        assert_eq!(row.local_time, "2026-09-22T09:00", "only fire_at moves");
        assert_eq!(row.status, "queued");
        assert_eq!(next_fire_at(&c).unwrap(), Some(5000));
    }

    #[test]
    fn cancel_and_delete_change_exactly_what_they_say() {
        let c = conn();
        seed(&c, "a", 1000);
        cancel(&c, "a").unwrap();
        assert_eq!(get(&c, "a").unwrap().unwrap().status, "cancelled");
        delete(&c, "a").unwrap();
        assert!(get(&c, "a").unwrap().is_none());
    }

    #[test]
    fn rescheduling_a_failed_row_re_arms_it_but_leaves_a_sent_row_alone() {
        let c = conn();
        seed(&c, "failed", 1000);
        for _ in 0..MAX_ATTEMPTS {
            bump_attempt(&c, "failed").unwrap();
        }
        set_status(&c, "failed", "failed", "boom").unwrap();
        update_schedule(&c, "failed", "2026-10-01T09:00", "Europe/Vilnius", 9999).unwrap();
        let row = get(&c, "failed").unwrap().unwrap();
        assert_eq!(row.status, "queued", "rescheduling asks for another try");
        assert_eq!(row.fire_at, 9999);
        assert_eq!(row.attempts, 0, "a re-armed row starts its retry ladder over");
        assert!(
            matches!(attempt_before_send(&c, "failed").unwrap(), AttemptOutcome::Send { attempt: 1 }),
            "a row that had used up its tries must be sendable again once rescheduled"
        );

        seed(&c, "sent", 1000);
        set_status(&c, "sent", "sent", "").unwrap();
        update_schedule(&c, "sent", "2026-10-01T09:00", "Europe/Vilnius", 9999).unwrap();
        assert_eq!(get(&c, "sent").unwrap().unwrap().status, "sent", "a sent row is not un-sent");
    }

    #[test]
    fn list_narrows_by_account_when_asked() {
        let c = conn();
        insert(&c, "a", "acct-1", "Scheduled", 1, "{}", "t", "tz", 1000).unwrap();
        insert(&c, "b", "acct-2", "Scheduled", 2, "{}", "t", "tz", 1000).unwrap();
        assert_eq!(list(&c, None).unwrap().len(), 2);
        assert_eq!(list(&c, Some("acct-1")).unwrap().len(), 1);
    }
}
