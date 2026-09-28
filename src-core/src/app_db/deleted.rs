//! The deleted-mail bin (app.db schema v7).
//!
//! Every message the app deletes is recorded here first: a row naming where
//! it came from (account, folder, uid, Message-ID, flags, the list row) and
//! when, and its whole `.eml` in `<app_data_dir>/deleted/<id>.eml` when the
//! bytes are kept. A message moved to Trash with no local copy is recorded
//! byte-less (`has_eml` false): Trash holds it, and downloading it only to
//! keep a second copy would make every delete a download. Recover puts it
//! back on the server or into the vault; a row older than the retention
//! setting is purged, file and all.
//!
//! It lives beside app.db and never in the vault, so no vault walk, folder
//! list, search index, count, unified view or backup ever sees it, and the
//! daemon needs no entitlement for it. Written and read only by
//! `src-daemon/src/handlers/deleted.rs`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Beside app.db: `<app_data_dir>/deleted`.
pub const DIR: &str = "deleted";
pub const DEFAULT_RETENTION_DAYS: i64 = 1;
pub const MAX_RETENTION_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub id: String,
    pub account_id: String,
    pub mailbox: String,
    pub uid: u32,
    pub message_id: Option<String>,
    /// The server's flags at delete time (`\Seen`, ...).
    pub flags: Vec<String>,
    /// The list row (subject, from, date, ...) for the Settings list and the
    /// custody entry a local recover writes.
    pub row: Value,
    /// Where a delete that moved the message put it, and its uid there.
    pub trash: Option<String>,
    pub trash_uid: Option<u32>,
    /// Unix ms UTC.
    pub deleted_at: i64,
    /// Whether the bin holds the bytes; false: only the Trash copy does.
    pub has_eml: bool,
}

/// What a capture records about the message.
pub struct Capture<'a> {
    pub account_id: &'a str,
    pub mailbox: &'a str,
    pub uid: u32,
    pub message_id: Option<&'a str>,
    pub flags: &'a [String],
    pub row: &'a Value,
    pub deleted_at: i64,
}

pub fn bin_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(DIR)
}

fn eml_path(app_dir: &Path, id: &str) -> PathBuf {
    bin_dir(app_dir).join(format!("{id}.eml"))
}

/// The retention in days: `deletedRetentionDays` from the settings state,
/// 1 when unset, clamped to 1..=30.
pub fn retention_days(settings_state: &Value) -> i64 {
    settings_state
        .get("deletedRetentionDays")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_RETENTION_DAYS)
        .clamp(1, MAX_RETENTION_DAYS)
}

/// A row is live when its bytes are there, or it never had any.
fn live(app_dir: &Path, id: &str, has_eml: bool) -> bool {
    !has_eml || eml_path(app_dir, id).exists()
}

/// The bin's id for this message and whether this call made it: the one
/// already there (a delete sent twice, a replay), else a new capture.
/// `raw` None records it byte-less. The file is written before the row, so a
/// row never names a file that was never written.
pub fn capture(conn: &Connection, app_dir: &Path, c: &Capture, raw: Option<&[u8]>) -> Result<(String, bool), String> {
    let existing: Option<(String, bool)> = conn
        .query_row(
            "SELECT id, has_eml FROM deleted_messages WHERE account_id = ?1 AND mailbox = ?2 AND uid = ?3 AND message_id IS ?4",
            params![c.account_id, c.mailbox, c.uid, c.message_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (id, upgrade) = match existing {
        Some((id, has_eml)) if live(app_dir, &id, has_eml) && (has_eml || raw.is_none()) => return Ok((id, false)),
        // Byte-less until now: keep the bytes this attempt has.
        Some((id, false)) => (id, true),
        _ => (uuid::Uuid::new_v4().to_string(), false),
    };
    let path = eml_path(app_dir, &id);
    if let Some(raw) = raw {
        std::fs::create_dir_all(bin_dir(app_dir)).map_err(|e| format!("create deleted bin: {e}"))?;
        crate::fsx::write_atomic(&path, raw).map_err(|e| format!("write deleted copy: {e}"))?;
    }
    if upgrade {
        conn.execute("UPDATE deleted_messages SET has_eml = 1 WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
        return Ok((id, false));
    }
    let flags = serde_json::to_string(c.flags).map_err(|e| e.to_string())?;
    let inserted = conn.execute(
        "INSERT INTO deleted_messages(id, account_id, mailbox, uid, message_id, flags, row_json, deleted_at, has_eml)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![id, c.account_id, c.mailbox, c.uid, c.message_id, flags, c.row.to_string(), c.deleted_at, raw.is_some()],
    );
    if let Err(e) = inserted {
        let _ = std::fs::remove_file(&path);
        return Err(e.to_string());
    }
    Ok((id, true))
}

/// The newest copy kept of (account, mailbox, uid), whatever its Message-ID:
/// for a retried delete whose message the server no longer holds.
pub fn find(conn: &Connection, app_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<String>, String> {
    let row: Option<(String, bool)> = conn
        .query_row(
            "SELECT id, has_eml FROM deleted_messages WHERE account_id = ?1 AND mailbox = ?2 AND uid = ?3 ORDER BY deleted_at DESC LIMIT 1",
            params![account_id, mailbox, uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.filter(|(id, has_eml)| live(app_dir, id, *has_eml)).map(|(id, _)| id))
}

/// Where the delete put the message, once it landed.
pub fn set_trash(conn: &Connection, id: &str, trash: Option<&str>, trash_uid: Option<u32>) -> Result<(), String> {
    conn.execute("UPDATE deleted_messages SET trash = ?2, trash_uid = ?3 WHERE id = ?1", params![id, trash, trash_uid])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Deleted> {
    let flags: String = r.get(5)?;
    let row: String = r.get(6)?;
    Ok(Deleted {
        id: r.get(0)?,
        account_id: r.get(1)?,
        mailbox: r.get(2)?,
        uid: r.get(3)?,
        message_id: r.get(4)?,
        flags: serde_json::from_str(&flags).unwrap_or_default(),
        row: serde_json::from_str(&row).unwrap_or(Value::Null),
        trash: r.get(7)?,
        trash_uid: r.get(8)?,
        deleted_at: r.get(9)?,
        has_eml: r.get(10)?,
    })
}

const COLUMNS: &str = "id, account_id, mailbox, uid, message_id, flags, row_json, trash, trash_uid, deleted_at, has_eml";

pub fn get(conn: &Connection, id: &str) -> Result<Option<Deleted>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM deleted_messages WHERE id = ?1"), [id], from_row)
        .optional()
        .map_err(|e| e.to_string())
}

/// Newest first. A row whose `.eml` went missing (a copied app.db, a file
/// removed by hand) has nothing to recover: it is dropped rather than listed.
/// A byte-less row is listed like any other.
pub fn list(conn: &Connection, app_dir: &Path) -> Result<Vec<Deleted>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM deleted_messages ORDER BY deleted_at DESC, id"))
        .map_err(|e| e.to_string())?;
    let rows: Vec<Deleted> = stmt
        .query_map([], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let (kept, gone): (Vec<_>, Vec<_>) = rows.into_iter().partition(|d| live(app_dir, &d.id, d.has_eml));
    for d in gone {
        remove(conn, app_dir, &d.id)?;
    }
    Ok(kept)
}

pub fn read_eml(app_dir: &Path, id: &str) -> Result<Vec<u8>, String> {
    std::fs::read(eml_path(app_dir, id)).map_err(|e| format!("deleted copy unreadable: {e}"))
}

/// Row first, then the file: a file with no row is invisible, a row with no
/// file would list a message nothing can recover.
pub fn remove(conn: &Connection, app_dir: &Path, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM deleted_messages WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    match std::fs::remove_file(eml_path(app_dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove deleted copy: {e}")),
    }
}

/// Everything deleted `retention_days` or longer before `now_ms`. Returns
/// how many went.
pub fn purge_expired(conn: &Connection, app_dir: &Path, now_ms: i64, retention_days: i64) -> Result<usize, String> {
    let cutoff = now_ms - retention_days * DAY_MS;
    let mut stmt = conn
        .prepare("SELECT id FROM deleted_messages WHERE deleted_at <= ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map([cutoff], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for id in &ids {
        remove(conn, app_dir, id)?;
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;
    use serde_json::json;

    fn store() -> (PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-deleted-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    fn cap<'a>(uid: u32, mid: Option<&'a str>, row: &'a Value, at: i64) -> Capture<'a> {
        Capture { account_id: "acc", mailbox: "INBOX", uid, message_id: mid, flags: &[], row, deleted_at: at }
    }

    #[test]
    fn a_capture_keeps_the_whole_message_and_lists_it() {
        let (dir, c) = store();
        let row = json!({"subject": "Hi"});
        let flags = vec!["\\Seen".to_string()];
        let (id, created) = capture(&c, &dir, &Capture { flags: &flags, ..cap(7, Some("<m@x>"), &row, 5) }, Some(&b"raw bytes"[..])).unwrap();
        assert!(created);
        assert_eq!(read_eml(&dir, &id).unwrap(), b"raw bytes");
        let listed = list(&c, &dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].uid, listed[0].flags.clone(), listed[0].row["subject"].clone()), (7, flags, json!("Hi")));
        assert!(bin_dir(&dir).starts_with(&dir) && !bin_dir(&dir).starts_with(dir.join("Maildir")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capturing_the_same_message_twice_keeps_one_row() {
        let (dir, c) = store();
        let row = json!({});
        let (a, _) = capture(&c, &dir, &cap(7, None, &row, 5), Some(&b"x"[..])).unwrap();
        let (b, created) = capture(&c, &dir, &cap(7, None, &row, 6), Some(&b"x"[..])).unwrap();
        assert_eq!(a, b);
        assert!(!created, "a replayed delete finds the capture it already made");
        // A different message under the same uid (a reused local pseudo-uid) is its own row.
        let (other, _) = capture(&c, &dir, &cap(7, Some("<other@x>"), &row, 7), Some(&b"y"[..])).unwrap();
        assert_ne!(a, other);
        assert_eq!(list(&c, &dir).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn purge_removes_only_what_is_older_than_the_retention() {
        let (dir, c) = store();
        let row = json!({});
        let now = 100 * DAY_MS;
        let (old, _) = capture(&c, &dir, &cap(1, None, &row, now - DAY_MS - 1), Some(&b"old"[..])).unwrap();
        let (fresh, _) = capture(&c, &dir, &cap(2, None, &row, now - DAY_MS / 2), Some(&b"fresh"[..])).unwrap();
        assert_eq!(purge_expired(&c, &dir, now, 1).unwrap(), 1);
        assert!(get(&c, &old).unwrap().is_none());
        assert!(!eml_path(&dir, &old).exists(), "the file goes with its row");
        assert!(get(&c, &fresh).unwrap().is_some());
        // A week's retention keeps both ages.
        let (week_old, _) = capture(&c, &dir, &cap(3, None, &row, now - 6 * DAY_MS), Some(&b"w"[..])).unwrap();
        assert_eq!(purge_expired(&c, &dir, now, 7).unwrap(), 0);
        assert!(get(&c, &week_old).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_byte_less_row_is_listed_and_takes_the_bytes_a_later_attempt_has() {
        let (dir, c) = store();
        let row = json!({"subject": "In Trash"});
        let (id, created) = capture(&c, &dir, &cap(9, Some("<t@x>"), &row, 1), None).unwrap();
        assert!(created);
        let listed = list(&c, &dir).unwrap();
        assert_eq!((listed.len(), listed[0].has_eml), (1, false));
        assert!(read_eml(&dir, &id).is_err(), "no bytes kept");
        let (again, created) = capture(&c, &dir, &cap(9, Some("<t@x>"), &row, 2), Some(&b"now"[..])).unwrap();
        assert_eq!((again.as_str(), created), (id.as_str(), false));
        assert_eq!(read_eml(&dir, &id).unwrap(), b"now");
        assert!(get(&c, &id).unwrap().unwrap().has_eml);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_row_without_its_file_is_not_listed() {
        let (dir, c) = store();
        let row = json!({});
        let (id, _) = capture(&c, &dir, &cap(1, None, &row, 1), Some(&b"x"[..])).unwrap();
        std::fs::remove_file(eml_path(&dir, &id)).unwrap();
        assert!(list(&c, &dir).unwrap().is_empty());
        assert!(get(&c, &id).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_defaults_to_a_day_and_stays_within_a_month() {
        assert_eq!(retention_days(&json!({})), 1);
        assert_eq!(retention_days(&json!({"deletedRetentionDays": 14})), 14);
        assert_eq!(retention_days(&json!({"deletedRetentionDays": 90})), 30);
        assert_eq!(retention_days(&json!({"deletedRetentionDays": 0})), 1);
    }
}
