//! Classification state: per-account results, the learned model, and the
//! work queue. Was `classifications/<account>.json`,
//! `classification_models/<account>.json` and
//! `classification_queue/queue.json`.
//!
//! Rows are opaque JSON here on purpose — the shapes (`EmailClassification`,
//! `NaiveBayesModel`, `QueueItem`) live in the daemon, and moving them would
//! be a bigger change than the storage swap this is.

use rusqlite::{params, Connection};

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
