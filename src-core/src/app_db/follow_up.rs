//! Follow-up reminders' durable queue (app.db schema v9): "remind me if no
//! reply". A row is one message the user sent and asked to hear about again.
//! At `remind_at` the daemon's `follow_up_worker.rs` looks for a reply; none
//! found, the row goes `due` and the app shows the SENT message at the top of
//! the inbox, unread, until the user opens or dismisses it. Nothing moves on
//! the server: `sent_mailbox`/`sent_uid` only say where the Sent copy is, so
//! the app can open it.
//!
//! Same shape as `app_db::snooze`: the worker is the only reader of `due()`,
//! the RPCs in `src-daemon/src/handlers/follow_up.rs` own the rest.

use rusqlite::{params, Connection, OptionalExtension};

/// Transient failures a row gets before it goes `failed`. Offline or a locked
/// keychain never counts (`Outcome::Wait`).
pub const MAX_ATTEMPTS: i64 = 5;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUp {
    pub id: String,
    pub account_id: String,
    /// The Message-ID header as sent, brackets kept.
    pub message_id: String,
    pub subject: String,
    /// Who it went to, as the app displays it.
    pub recipients: String,
    /// Unix ms UTC.
    pub sent_at: i64,
    /// Unix ms UTC — what the user picked. Retries never move it.
    pub remind_at: i64,
    pub created_at: i64,
    /// "waiting" | "due" | "replied" | "gone" | "dismissed" | "failed".
    pub state: String,
    /// The Sent folder the app filed the message in, as a hint for the
    /// check; where the copy was actually found once the row went `due`.
    pub sent_mailbox: String,
    pub sent_uid: Option<u32>,
    /// Every address the message was the user's under: its From, the login,
    /// the account's aliases. A message from any of them is no reply.
    pub own_addresses: Vec<String>,
    /// The user opened the resurfaced message.
    pub seen: bool,
    /// The app raised its one notification for it.
    pub announced: bool,
    pub attempts: i64,
    /// Unix ms; 0 when no retry is pending. A row is due at
    /// `max(remind_at, retry_at)`.
    pub retry_at: i64,
    pub last_error: String,
}

/// What one check at `remind_at` came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Someone answered: the row ends quietly.
    Replied,
    /// No answer, and this is the Sent copy the app shows.
    NoReply { sent_mailbox: String, sent_uid: u32 },
    /// No answer and no Sent copy left to show (deleted from another client).
    SentCopyGone,
    /// Worth another try, counted against `MAX_ATTEMPTS`.
    Transient(String),
    /// Offline, or the keychain gate is blocked: never counted, never
    /// terminal. The row stays due.
    Wait(String),
}

/// Retry backoff after the `attempt`th transient failure, as snooze's.
pub fn backoff_ms(attempt: i64) -> i64 {
    crate::app_db::snooze::backoff_ms(attempt)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const COLUMNS: &str = "id, account_id, message_id, subject, recipients, sent_at, remind_at, created_at, state, \
     sent_mailbox, sent_uid, seen, announced, attempts, retry_at, last_error, own_addresses";

fn row_to_follow_up(r: &rusqlite::Row) -> rusqlite::Result<FollowUp> {
    Ok(FollowUp {
        id: r.get(0)?,
        account_id: r.get(1)?,
        message_id: r.get(2)?,
        subject: r.get(3)?,
        recipients: r.get(4)?,
        sent_at: r.get(5)?,
        remind_at: r.get(6)?,
        created_at: r.get(7)?,
        state: r.get(8)?,
        sent_mailbox: r.get(9)?,
        sent_uid: r.get(10)?,
        seen: r.get::<_, i64>(11)? != 0,
        announced: r.get::<_, i64>(12)? != 0,
        attempts: r.get(13)?,
        retry_at: r.get(14)?,
        last_error: r.get(15)?,
        own_addresses: serde_json::from_str(&r.get::<_, String>(16)?).unwrap_or_default(),
    })
}

fn query(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<FollowUp>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(args, row_to_follow_up).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Record a reminder. A send that is retried runs its closure again, so a
/// second insert of the same (account, Message-ID) is ignored and returns
/// `false`; the first row stands.
#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    id: &str,
    account_id: &str,
    message_id: &str,
    subject: &str,
    recipients: &str,
    sent_mailbox: &str,
    own_addresses: &[String],
    sent_at: i64,
    remind_at: i64,
) -> Result<bool, String> {
    let own = serde_json::to_string(own_addresses).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO follow_ups(id, account_id, message_id, subject, recipients, sent_mailbox, own_addresses, sent_at, remind_at, created_at, state)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'waiting')",
        params![id, account_id, message_id, subject, recipients, sent_mailbox, own, sent_at, remind_at, now_ms()],
    )
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<FollowUp>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM follow_ups WHERE id = ?1"), [id], row_to_follow_up)
        .optional()
        .map_err(|e| e.to_string())
}

/// The row for one sent message, whatever its state.
pub fn get_by_message(conn: &Connection, account_id: &str, message_id: &str) -> Result<Option<FollowUp>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM follow_ups WHERE account_id = ?1 AND message_id = ?2"),
        params![account_id, message_id],
        row_to_follow_up,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every `waiting` or `due` row (the rest are history), soonest first,
/// optionally narrowed to one account.
pub fn list(conn: &Connection, account_id: Option<&str>) -> Result<Vec<FollowUp>, String> {
    let base = format!("SELECT {COLUMNS} FROM follow_ups WHERE state IN ('waiting', 'due')");
    match account_id {
        Some(a) => query(conn, &format!("{base} AND account_id = ?1 ORDER BY remind_at ASC"), params![a]),
        None => query(conn, &format!("{base} ORDER BY remind_at ASC"), params![]),
    }
}

/// `waiting` rows whose `max(remind_at, retry_at)` has passed, soonest first.
pub fn due(conn: &Connection, now_ms: i64) -> Result<Vec<FollowUp>, String> {
    query(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM follow_ups WHERE state = 'waiting' AND MAX(remind_at, retry_at) <= ?1
             ORDER BY MAX(remind_at, retry_at) ASC"
        ),
        params![now_ms],
    )
}

/// The worker's sleep target: the earliest `max(remind_at, retry_at)` over
/// `waiting` rows.
pub fn next_wake_at(conn: &Connection) -> Result<Option<i64>, String> {
    conn.query_row("SELECT MIN(MAX(remind_at, retry_at)) FROM follow_ups WHERE state = 'waiting'", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Write what a check came to. Returns the row's state afterwards. Only a
/// `waiting` row moves: a user who dismissed it while the check ran keeps
/// their answer.
pub fn record_outcome(conn: &Connection, id: &str, outcome: &Outcome, now_ms: i64) -> Result<String, String> {
    let changed = match outcome {
        Outcome::Replied => conn.execute(
            "UPDATE follow_ups SET state = 'replied', retry_at = 0, last_error = '' WHERE id = ?1 AND state = 'waiting'",
            [id],
        ),
        Outcome::NoReply { sent_mailbox, sent_uid } => conn.execute(
            "UPDATE follow_ups SET state = 'due', sent_mailbox = ?2, sent_uid = ?3, retry_at = 0, last_error = ''
             WHERE id = ?1 AND state = 'waiting'",
            params![id, sent_mailbox, sent_uid],
        ),
        Outcome::SentCopyGone => conn.execute(
            "UPDATE follow_ups SET state = 'gone', retry_at = 0, last_error = '' WHERE id = ?1 AND state = 'waiting'",
            [id],
        ),
        Outcome::Wait(msg) => {
            conn.execute("UPDATE follow_ups SET last_error = ?2 WHERE id = ?1 AND state = 'waiting'", params![id, msg])
        }
        Outcome::Transient(msg) => conn.execute(
            "UPDATE follow_ups SET attempts = attempts + 1, last_error = ?2,
                 state = CASE WHEN attempts + 1 >= ?3 THEN 'failed' ELSE state END,
                 retry_at = ?4 + ?5 * (1 << MIN(attempts, 10))
             WHERE id = ?1 AND state = 'waiting'",
            params![id, msg, MAX_ATTEMPTS, now_ms, backoff_ms(1)],
        ),
    };
    changed.map_err(|e| e.to_string())?;
    conn.query_row("SELECT state FROM follow_ups WHERE id = ?1", [id], |r| r.get(0)).map_err(|e| e.to_string())
}

/// The user opened the resurfaced message (`seen`), or marked it unread
/// again: it stays in the list either way.
pub fn mark_seen(conn: &Connection, id: &str, seen: bool) -> Result<(), String> {
    conn.execute("UPDATE follow_ups SET seen = ?2 WHERE id = ?1", params![id, seen as i64])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The app raised the row's notification. Set once, so a relaunch never
/// announces it again.
pub fn mark_announced(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE follow_ups SET announced = 1 WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
}

/// The user is done with it: delete, archive or move on the resurfaced row,
/// or turning the reminder off before it fires. History rows stay as they are.
pub fn dismiss(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE follow_ups SET state = 'dismissed', retry_at = 0 WHERE id = ?1 AND state IN ('waiting', 'due', 'failed')",
        [id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-follow-up-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn seed(c: &Connection, id: &str, remind_at: i64) {
        insert(c, id, "acct", &format!("<{id}@x>"), "Quote", "Ana <ana@x.com>", "", &[], 100, remind_at).unwrap();
    }

    fn state_of(c: &Connection, id: &str) -> String {
        get(c, id).unwrap().unwrap().state
    }

    #[test]
    fn an_inserted_row_reads_back_waiting_with_everything_it_was_given() {
        let c = conn();
        assert!(insert(&c, "a", "acct", "<m@x>", "Quote", "Ana <ana@x.com>", "Sent", &["me@x.com".to_string(), "alias@x.com".to_string()], 1_000, 5_000).unwrap());
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.account_id, "acct");
        assert_eq!(row.message_id, "<m@x>");
        assert_eq!(row.subject, "Quote");
        assert_eq!(row.recipients, "Ana <ana@x.com>");
        assert_eq!(row.sent_at, 1_000);
        assert_eq!(row.remind_at, 5_000);
        assert_eq!(row.state, "waiting");
        assert_eq!(row.sent_mailbox, "Sent", "the app's Sent folder, a hint for the check");
        assert_eq!(row.own_addresses, vec!["me@x.com", "alias@x.com"]);
        assert_eq!(row.sent_uid, None);
        assert!(!row.seen);
        assert!(!row.announced);
        assert_eq!(row.attempts, 0);
        assert!(row.created_at > 0);
        assert!(get(&c, "nope").unwrap().is_none());
    }

    /// A send that is retried runs the code that records the reminder again:
    /// the first row stands, one message never gets two reminders.
    #[test]
    fn a_second_insert_of_the_same_message_is_ignored() {
        let c = conn();
        assert!(insert(&c, "a", "acct", "<m@x>", "Quote", "ana@x.com", "", &[], 1_000, 5_000).unwrap());
        assert!(!insert(&c, "b", "acct", "<m@x>", "Quote", "ana@x.com", "", &[], 2_000, 9_000).unwrap());
        assert!(get(&c, "b").unwrap().is_none());
        assert_eq!(get_by_message(&c, "acct", "<m@x>").unwrap().unwrap().id, "a");
        assert!(insert(&c, "c", "other", "<m@x>", "Quote", "ana@x.com", "", &[], 1_000, 5_000).unwrap(), "another account is another row");
    }

    #[test]
    fn list_holds_waiting_and_due_rows_soonest_first_and_narrows_by_account() {
        let c = conn();
        seed(&c, "late", 3_000);
        seed(&c, "early", 1_000);
        seed(&c, "resurfaced", 2_000);
        seed(&c, "answered", 500);
        insert(&c, "elsewhere", "acct-2", "<e@x>", "", "", "", &[], 100, 1_500).unwrap();
        record_outcome(&c, "resurfaced", &Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: 7 }, 2_000).unwrap();
        record_outcome(&c, "answered", &Outcome::Replied, 2_000).unwrap();
        let all: Vec<_> = list(&c, None).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(all, vec!["early", "elsewhere", "resurfaced", "late"]);
        let one: Vec<_> = list(&c, Some("acct")).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(one, vec!["early", "resurfaced", "late"]);
    }

    #[test]
    fn due_is_waiting_rows_at_or_past_their_remind_time_soonest_first() {
        let c = conn();
        seed(&c, "later", 1_500);
        seed(&c, "earlier", 500);
        seed(&c, "future", 9_000);
        seed(&c, "boundary", 2_000);
        let found: Vec<_> = due(&c, 2_000).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(found, vec!["earlier", "later", "boundary"]);
    }

    #[test]
    fn only_waiting_rows_are_ever_checked() {
        let c = conn();
        for id in ["due", "replied", "gone", "dismissed", "failed"] {
            seed(&c, id, 100);
        }
        record_outcome(&c, "due", &Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: 1 }, 200).unwrap();
        record_outcome(&c, "replied", &Outcome::Replied, 200).unwrap();
        record_outcome(&c, "gone", &Outcome::SentCopyGone, 200).unwrap();
        dismiss(&c, "dismissed").unwrap();
        for _ in 0..MAX_ATTEMPTS {
            record_outcome(&c, "failed", &Outcome::Transient("boom".into()), 200).unwrap();
        }
        assert_eq!(state_of(&c, "failed"), "failed");
        assert!(due(&c, i64::MAX / 2).unwrap().is_empty());
        assert_eq!(next_wake_at(&c).unwrap(), None);
    }

    #[test]
    fn next_wake_at_is_the_earliest_waiting_reminder() {
        let c = conn();
        assert_eq!(next_wake_at(&c).unwrap(), None);
        seed(&c, "a", 5_000);
        seed(&c, "b", 1_000);
        assert_eq!(next_wake_at(&c).unwrap(), Some(1_000));
        record_outcome(&c, "b", &Outcome::Replied, 1_000).unwrap();
        assert_eq!(next_wake_at(&c).unwrap(), Some(5_000));
    }

    #[test]
    fn no_reply_resurfaces_the_row_with_where_its_sent_copy_is() {
        let c = conn();
        seed(&c, "a", 100);
        let state = record_outcome(&c, "a", &Outcome::NoReply { sent_mailbox: "[Gmail]/Sent Mail".into(), sent_uid: 42 }, 200).unwrap();
        assert_eq!(state, "due");
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.sent_mailbox, "[Gmail]/Sent Mail");
        assert_eq!(row.sent_uid, Some(42));
        assert!(!row.seen, "resurfaces unread");
    }

    #[test]
    fn a_reply_or_a_vanished_sent_copy_ends_the_row_quietly() {
        let c = conn();
        seed(&c, "replied", 100);
        seed(&c, "gone", 100);
        assert_eq!(record_outcome(&c, "replied", &Outcome::Replied, 200).unwrap(), "replied");
        assert_eq!(record_outcome(&c, "gone", &Outcome::SentCopyGone, 200).unwrap(), "gone");
        assert_eq!(get(&c, "gone").unwrap().unwrap().last_error, "");
        assert!(list(&c, None).unwrap().is_empty());
    }

    #[test]
    fn a_transient_failure_backs_off_without_moving_the_remind_time() {
        let c = conn();
        seed(&c, "a", 1_000);
        assert_eq!(record_outcome(&c, "a", &Outcome::Transient("timeout".into()), 2_000).unwrap(), "waiting");
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.attempts, 1);
        assert_eq!(row.remind_at, 1_000);
        assert_eq!(row.last_error, "timeout");
        assert!(due(&c, 2_000).unwrap().is_empty(), "not retried on the very next tick");
        assert_eq!(next_wake_at(&c).unwrap(), Some(2_000 + backoff_ms(1)));
        assert_eq!(due(&c, 2_000 + backoff_ms(1)).unwrap().len(), 1);
    }

    #[test]
    fn running_out_of_attempts_marks_the_row_failed() {
        let c = conn();
        seed(&c, "a", 1_000);
        for n in 1..MAX_ATTEMPTS {
            assert_eq!(record_outcome(&c, "a", &Outcome::Transient(format!("try {n}")), 2_000).unwrap(), "waiting");
        }
        assert_eq!(record_outcome(&c, "a", &Outcome::Transient("last".into()), 2_000).unwrap(), "failed");
        assert_eq!(get(&c, "a").unwrap().unwrap().last_error, "last");
    }

    #[test]
    fn waiting_on_the_keychain_or_the_network_never_burns_an_attempt() {
        let c = conn();
        seed(&c, "a", 1_000);
        for _ in 0..(MAX_ATTEMPTS * 3) {
            assert_eq!(record_outcome(&c, "a", &Outcome::Wait("keychain locked".into()), 2_000).unwrap(), "waiting");
        }
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.attempts, 0);
        assert_eq!(due(&c, 2_000).unwrap().len(), 1);
    }

    /// The user dismissed the row while the check was out on the server: the
    /// check's answer must not bring it back.
    #[test]
    fn an_outcome_never_overrides_a_dismissal() {
        let c = conn();
        seed(&c, "a", 100);
        dismiss(&c, "a").unwrap();
        let state = record_outcome(&c, "a", &Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: 1 }, 200).unwrap();
        assert_eq!(state, "dismissed");
    }

    #[test]
    fn seen_and_announced_are_remembered_and_dismiss_ends_a_due_row() {
        let c = conn();
        seed(&c, "a", 100);
        record_outcome(&c, "a", &Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: 3 }, 200).unwrap();
        mark_announced(&c, "a").unwrap();
        mark_seen(&c, "a", true).unwrap();
        let row = get(&c, "a").unwrap().unwrap();
        assert!(row.seen);
        assert!(row.announced);
        assert_eq!(row.state, "due", "opening it keeps it in the list");
        mark_seen(&c, "a", false).unwrap();
        assert!(!get(&c, "a").unwrap().unwrap().seen, "marked unread again");
        mark_seen(&c, "a", true).unwrap();
        dismiss(&c, "a").unwrap();
        assert_eq!(state_of(&c, "a"), "dismissed");
        assert!(list(&c, None).unwrap().is_empty());
    }

    #[test]
    fn dismiss_leaves_a_finished_row_alone() {
        let c = conn();
        seed(&c, "a", 100);
        record_outcome(&c, "a", &Outcome::Replied, 200).unwrap();
        dismiss(&c, "a").unwrap();
        assert_eq!(state_of(&c, "a"), "replied");
    }
}
