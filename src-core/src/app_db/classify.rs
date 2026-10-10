//! Classification state: per-account results, the learned model, and the
//! work queue. Was `classifications/<account>.json`,
//! `classification_models/<account>.json` and
//! `classification_queue/queue.json`.
//!
//! Rows are opaque JSON here on purpose — the shapes (`EmailClassification`,
//! `NaiveBayesModel`, `QueueItem`) live in the daemon, and moving them would
//! be a bigger change than the storage swap this is.

use rusqlite::{params, Connection};
use std::collections::HashSet;

// ── Results ─────────────────────────────────────────────────────────────────

pub fn load(conn: &Connection, account_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT email_key, entry_json FROM classifications WHERE account_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Replace everything this account has. The JSON file was rewritten whole on
/// every save, so a key the caller dropped has to disappear here too.
pub fn replace_account(conn: &Connection, account_id: &str, entries: &[(String, String)]) -> Result<(), String> {
    crate::app_db::db::in_txn(conn, || {
        conn.execute("DELETE FROM classifications WHERE account_id = ?1", [account_id])
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare_cached("INSERT OR REPLACE INTO classifications(account_id, email_key, entry_json) VALUES (?1,?2,?3)")
            .map_err(|e| e.to_string())?;
        for (key, json) in entries {
            stmt.execute(params![account_id, key, json]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// Whether a result is stored for this message.
pub fn has(conn: &Connection, account_id: &str, email_key: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM classifications WHERE account_id = ?1 AND email_key = ?2)",
        params![account_id, email_key],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Several results in one transaction, leaving every key not given alone. A
/// row pruned meanwhile (`remove_at`) is not written back.
pub fn put_many(conn: &Connection, account_id: &str, entries: &[(String, String)]) -> Result<(), String> {
    crate::app_db::db::in_txn(conn, || {
        let mut stmt = conn
            .prepare_cached("INSERT OR REPLACE INTO classifications(account_id, email_key, entry_json) VALUES (?1,?2,?3)")
            .map_err(|e| e.to_string())?;
        for (key, json) in entries {
            stmt.execute(params![account_id, key, json]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// Forget the results of these uids in `mailbox`: the server no longer has
/// them there (deleted, archived and removed, or moved out), so Cleanup must
/// not list them. A row with no snapshot mailbox was classified in INBOX.
/// Returns how many rows went.
pub fn remove_at(conn: &Connection, account_id: &str, mailbox: &str, uids: &[u32]) -> Result<usize, String> {
    let uids: HashSet<u64> = uids.iter().map(|&u| u64::from(u)).collect();
    remove_where(conn, account_id, mailbox, |uid| uid.is_some_and(|u| uids.contains(&u)))
}

/// Forget every result in `mailbox`: its UIDVALIDITY changed, so each stored
/// uid may now name another message.
pub fn remove_mailbox(conn: &Connection, account_id: &str, mailbox: &str) -> Result<usize, String> {
    remove_where(conn, account_id, mailbox, |_| true)
}

/// Delete the account's rows in `mailbox` whose snapshot uid `gone` picks.
/// One scan of the account reading only the two snapshot fields, then deletes
/// by key, all in one transaction so a concurrent save cannot interleave.
fn remove_where(conn: &Connection, account_id: &str, mailbox: &str, gone: impl Fn(Option<u64>) -> bool) -> Result<usize, String> {
    crate::app_db::db::in_txn(conn, || {
        let mut stmt = conn
            .prepare(
                "SELECT email_key, \
                        CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.snapshot.uid') END, \
                        CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.snapshot.mailbox') END \
                 FROM classifications WHERE account_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let keys: Vec<String> = stmt
            .query_map([account_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, Option<String>>(2)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|(_, uid, mb)| {
                let mb = mb.as_deref().filter(|m| !m.is_empty()).unwrap_or("INBOX");
                mb == mailbox && gone(uid.and_then(|u| u64::try_from(u).ok()))
            })
            .map(|(key, _, _)| key)
            .collect();
        drop(stmt);
        let mut delete = conn
            .prepare_cached("DELETE FROM classifications WHERE account_id = ?1 AND email_key = ?2")
            .map_err(|e| e.to_string())?;
        for key in &keys {
            delete.execute(params![account_id, key]).map_err(|e| e.to_string())?;
        }
        Ok(keys.len())
    })
}

/// One result, leaving every other key alone.
pub fn put(conn: &Connection, account_id: &str, email_key: &str, entry_json: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO classifications(account_id, email_key, entry_json) VALUES (?1,?2,?3)",
        params![account_id, email_key, entry_json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ── Model ───────────────────────────────────────────────────────────────────

pub fn load_model(conn: &Connection, account_id: &str) -> Option<String> {
    conn.query_row("SELECT model_json FROM classification_models WHERE account_id = ?1", [account_id], |r| r.get(0))
        .ok()
}

pub fn save_model(conn: &Connection, account_id: &str, model_json: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO classification_models(account_id, model_json) VALUES (?1,?2)",
        params![account_id, model_json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ── Queue ───────────────────────────────────────────────────────────────────

/// `(dedupe_key, item_json)` in queue order.
pub fn queue_load(conn: &Connection) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare("SELECT dedupe_key, item_json FROM classification_queue ORDER BY seq") else {
        return Vec::new();
    };
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// The whole queue, replacing what is stored. Matches the old
/// `persist_queue_locked`, which serialized the live `VecDeque` every time.
pub fn queue_replace(conn: &Connection, items: &[(String, String)]) -> Result<(), String> {
    crate::app_db::db::in_txn(conn, || {
        conn.execute("DELETE FROM classification_queue", []).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare_cached("INSERT INTO classification_queue(dedupe_key, item_json) VALUES (?1,?2)")
            .map_err(|e| e.to_string())?;
        for (key, json) in items {
            stmt.execute(params![key, json]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn(name: &str) -> (std::path::PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-classify-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    #[test]
    fn results_round_trip_per_account() {
        let (dir, c) = conn("roundtrip");
        replace_account(&c, "a", &[("k1".into(), "{\"category\":\"x\"}".into())]).unwrap();
        replace_account(&c, "b", &[("k1".into(), "{\"category\":\"y\"}".into())]).unwrap();
        assert_eq!(load(&c, "a").unwrap(), vec![("k1".to_string(), "{\"category\":\"x\"}".to_string())]);
        assert_eq!(load(&c, "b").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_drops_keys_the_caller_left_out() {
        let (dir, c) = conn("replace");
        replace_account(&c, "a", &[("k1".into(), "1".into()), ("k2".into(), "2".into())]).unwrap();
        replace_account(&c, "a", &[("k2".into(), "2".into())]).unwrap();
        let keys: Vec<String> = load(&c, "a").unwrap().into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["k2".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn put_leaves_the_other_keys_alone() {
        let (dir, c) = conn("put");
        replace_account(&c, "a", &[("k1".into(), "1".into())]).unwrap();
        put(&c, "a", "k2", "2").unwrap();
        assert_eq!(load(&c, "a").unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn row(uid: u64, mailbox: &str) -> String {
        serde_json::json!({"category": "newsletter", "snapshot": {"uid": uid, "subject": "s", "from": "f", "date": "d", "mailbox": mailbox}})
            .to_string()
    }

    fn keys(c: &Connection, account: &str) -> Vec<String> {
        let mut k: Vec<String> = load(c, account).unwrap().into_iter().map(|(k, _)| k).collect();
        k.sort();
        k
    }

    fn seeded(name: &str) -> (std::path::PathBuf, Connection) {
        let (dir, c) = conn(name);
        put_many(
            &c,
            "a",
            &[
                ("in1".into(), row(1, "INBOX")),
                ("in2".into(), row(2, "INBOX")),
                ("arch1".into(), row(1, "Archive")),
                ("legacy3".into(), row(3, "")),
            ],
        )
        .unwrap();
        put_many(&c, "b", &[("b1".into(), row(1, "INBOX"))]).unwrap();
        (dir, c)
    }

    #[test]
    fn put_many_leaves_the_other_keys_alone() {
        let (dir, c) = conn("put-many");
        put_many(&c, "a", &[("k1".into(), row(1, "INBOX"))]).unwrap();
        put_many(&c, "a", &[("k2".into(), row(2, "INBOX"))]).unwrap();
        assert_eq!(keys(&c, "a"), vec!["k1".to_string(), "k2".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn has_answers_per_account_and_key() {
        let (dir, c) = seeded("has");
        assert!(has(&c, "a", "in1").unwrap());
        assert!(!has(&c, "a", "b1").unwrap());
        assert!(!has(&c, "b", "in1").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_delete_forgets_exactly_the_deleted_uids_of_that_mailbox() {
        let (dir, c) = seeded("delete");
        assert_eq!(remove_at(&c, "a", "INBOX", &[1, 99]).unwrap(), 1);
        assert_eq!(keys(&c, "a"), vec!["arch1".to_string(), "in2".to_string(), "legacy3".to_string()]);
        assert_eq!(keys(&c, "b"), vec!["b1".to_string()], "another account's uid 1 stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_move_out_forgets_the_source_row_only() {
        let (dir, c) = seeded("move");
        // uid 1 moved out of Archive; INBOX's own uid 1 is another message.
        assert_eq!(remove_at(&c, "a", "Archive", &[1]).unwrap(), 1);
        assert_eq!(keys(&c, "a"), vec!["in1".to_string(), "in2".to_string(), "legacy3".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_archive_and_delete_forgets_a_legacy_row_with_no_mailbox_as_inbox() {
        let (dir, c) = seeded("legacy");
        assert_eq!(remove_at(&c, "a", "INBOX", &[3]).unwrap(), 1);
        assert!(!keys(&c, "a").contains(&"legacy3".to_string()));
        assert_eq!(remove_at(&c, "a", "Archive", &[2]).unwrap(), 0, "INBOX's uid 2 is not Archive's");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_uid_validity_change_forgets_the_whole_mailbox() {
        let (dir, c) = seeded("wipe");
        assert_eq!(remove_mailbox(&c, "a", "INBOX").unwrap(), 3);
        assert_eq!(keys(&c, "a"), vec!["arch1".to_string()]);
        assert_eq!(keys(&c, "b"), vec!["b1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_model_round_trips() {
        let (dir, c) = conn("model");
        assert_eq!(load_model(&c, "a"), None);
        save_model(&c, "a", "{\"v\":1}").unwrap();
        assert_eq!(load_model(&c, "a").as_deref(), Some("{\"v\":1}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_queue_keeps_its_order() {
        let (dir, c) = conn("queue");
        queue_replace(&c, &[("a".into(), "1".into()), ("b".into(), "2".into()), ("c".into(), "3".into())]).unwrap();
        let keys: Vec<String> = queue_load(&c).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
