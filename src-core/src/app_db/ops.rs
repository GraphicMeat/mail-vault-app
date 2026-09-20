//! The two journals and the purge queue that used to be `pending_ops.json`,
//! `pending_operations.json` and `pending_backup_purge.json`.
//!
//! All three are work the user already confirmed, so nothing here starts over
//! on a read error the way the JSON readers did — a failed open is reported by
//! `app_db::db` and the caller decides.

use rusqlite::{params, Connection};
use std::collections::BTreeMap;

/// The single in-flight bulk operation the UI is mid-way through.
pub const PENDING_OPERATION_KEY: &str = "pending_operation";

// ── Op journal ──────────────────────────────────────────────────────────────

/// One journal row: `(id, op, account_id, mailbox, uids_json, arg_json, at)`.
pub type Row = (u64, String, String, String, String, String, u64);

pub fn read(conn: &Connection) -> Vec<Row> {
    let Ok(mut stmt) = conn
        .prepare("SELECT id, op, account_id, mailbox, uids_json, arg_json, at FROM pending_ops ORDER BY id")
    else {
        return Vec::new();
    };
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)? as u64,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get::<_, i64>(6)? as u64,
        ))
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

/// Record an intent; the row id is assigned by the table.
pub fn queue(
    conn: &Connection,
    op: &str,
    account_id: &str,
    mailbox: &str,
    uids_json: &str,
    arg_json: &str,
    at: u64,
) -> Result<u64, String> {
    conn.execute(
        "INSERT INTO pending_ops(op, account_id, mailbox, uids_json, arg_json, at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![op, account_id, mailbox, uids_json, arg_json, at as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid() as u64)
}

/// Rewrite one row's uids, or delete it when nothing is left owed.
pub fn set_uids(conn: &Connection, id: u64, uids_json: &str, empty: bool) -> Result<(), String> {
    if empty {
        conn.execute("DELETE FROM pending_ops WHERE id = ?1", [id as i64]).map_err(|e| e.to_string())?;
    } else {
        conn.execute("UPDATE pending_ops SET uids_json = ?2 WHERE id = ?1", params![id as i64, uids_json])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Pending backup purge ────────────────────────────────────────────────────

pub fn purge_read(conn: &Connection) -> BTreeMap<String, Vec<u32>> {
    let Ok(mut stmt) = conn.prepare("SELECT scope, uid FROM pending_backup_purge ORDER BY scope, uid") else {
        return BTreeMap::new();
    };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (scope, uid) in rows.filter_map(Result::ok) {
        out.entry(scope).or_default().push(uid);
    }
    out
}

/// Replace the whole queue — the JSON writer rewrote the map every time.
pub fn purge_write(conn: &Connection, queue: &BTreeMap<String, Vec<u32>>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pending_backup_purge", []).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached("INSERT OR REPLACE INTO pending_backup_purge(scope, uid) VALUES (?1,?2)")
            .map_err(|e| e.to_string())?;
        for (scope, uids) in queue {
            for uid in uids {
                stmt.execute(params![scope, *uid as i64]).map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn(name: &str) -> (std::path::PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-ops-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    #[test]
    fn queued_ops_come_back_oldest_first_with_rising_ids() {
        let (dir, c) = conn("order");
        let a = queue(&c, "delete", "acc", "INBOX", "[1]", "{}", 10).unwrap();
        let b = queue(&c, "flag", "acc", "INBOX", "[2]", "{\"action\":\"add\"}", 11).unwrap();
        assert!(b > a);
        let rows = read(&c);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, "delete");
        assert_eq!(rows[1].1, "flag");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_emptied_row_is_removed() {
        let (dir, c) = conn("empty");
        let id = queue(&c, "delete", "acc", "INBOX", "[1]", "{}", 1).unwrap();
        set_uids(&c, id, "[]", true).unwrap();
        assert!(read(&c).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_purge_queue_round_trips() {
        let (dir, c) = conn("purge");
        let mut q = BTreeMap::new();
        q.insert("acc|INBOX".to_string(), vec![4u32, 9]);
        q.insert("acc|Sent".to_string(), vec![2u32]);
        purge_write(&c, &q).unwrap();
        assert_eq!(purge_read(&c), q);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_the_purge_queue_replaces_it() {
        let (dir, c) = conn("purge-replace");
        let mut q = BTreeMap::new();
        q.insert("a".to_string(), vec![1u32, 2]);
        purge_write(&c, &q).unwrap();
        purge_write(&c, &BTreeMap::new()).unwrap();
        assert!(purge_read(&c).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pending_operation_is_one_meta_row() {
        let (dir, c) = conn("pending-op");
        assert_eq!(db::meta_get(&c, PENDING_OPERATION_KEY), None);
        db::meta_set(&c, PENDING_OPERATION_KEY, "{\"kind\":\"delete\"}").unwrap();
        assert_eq!(db::meta_get(&c, PENDING_OPERATION_KEY).as_deref(), Some("{\"kind\":\"delete\"}"));
        db::meta_clear(&c, PENDING_OPERATION_KEY).unwrap();
        assert_eq!(db::meta_get(&c, PENDING_OPERATION_KEY), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
