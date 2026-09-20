//! Per-account wire-byte day buckets. Was
//! `transfer_stats/<account>.app.json` / `<account>.daemon.json`, one file per
//! writing process so neither had to lock the other.
//!
//! `source` ('app' / 'daemon') stays in the primary key for exactly that
//! reason: each process only ever touches its own rows, so two concurrent
//! flushes still sum instead of clobbering, and readers add both sources up
//! the way they used to add both files up.

use rusqlite::{params, Connection};
use std::collections::BTreeMap;

pub fn add(conn: &Connection, account_id: &str, day: &str, source: &str, down: u64, up: u64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO transfer_stats(account_id, day, source, down, up) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(account_id, day, source) DO UPDATE SET
            down = down + excluded.down,
            up   = up   + excluded.up",
        params![account_id, day, source, down as i64, up as i64],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Drop day buckets older than `cutoff` (a `YYYY-MM-DD` key, exclusive).
pub fn prune(conn: &Connection, cutoff: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM transfer_stats WHERE day < ?1", [cutoff]).map_err(|e| e.to_string())
}

/// account id → day → (down, up), both sources summed.
pub fn all(conn: &Connection) -> BTreeMap<String, BTreeMap<String, (u64, u64)>> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT account_id, day, SUM(down), SUM(up) FROM transfer_stats GROUP BY account_id, day",
    ) else {
        return BTreeMap::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, i64>(3)? as u64,
        ))
    }) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, BTreeMap<String, (u64, u64)>> = BTreeMap::new();
    for (id, day, down, up) in rows.filter_map(Result::ok) {
        out.entry(id).or_default().insert(day, (down, up));
    }
    out
}

/// One account's total for one day across both sources.
pub fn day_total(conn: &Connection, account_id: &str, day: &str) -> (u64, u64) {
    conn.query_row(
        "SELECT COALESCE(SUM(down),0), COALESCE(SUM(up),0) FROM transfer_stats WHERE account_id = ?1 AND day = ?2",
        params![account_id, day],
        |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
    )
    .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn(name: &str) -> (std::path::PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-stats-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    #[test]
    fn deltas_accumulate_into_one_bucket() {
        let (dir, c) = conn("accumulate");
        add(&c, "acc", "2026-09-21", "daemon", 10, 1).unwrap();
        add(&c, "acc", "2026-09-21", "daemon", 5, 2).unwrap();
        assert_eq!(day_total(&c, "acc", "2026-09-21"), (15, 3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_two_processes_sum_instead_of_clobbering() {
        // The whole reason `source` is in the key: the app and the daemon both
        // flush the same account and day, and neither may lose the other's bytes.
        let (dir, c) = conn("two-writers");
        add(&c, "acc", "2026-09-21", "app", 100, 0).unwrap();
        add(&c, "acc", "2026-09-21", "daemon", 20, 0).unwrap();
        assert_eq!(day_total(&c, "acc", "2026-09-21"), (120, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn all_groups_by_account_and_day() {
        let (dir, c) = conn("all");
        add(&c, "a", "2026-09-20", "app", 1, 1).unwrap();
        add(&c, "a", "2026-09-21", "daemon", 2, 2).unwrap();
        add(&c, "b", "2026-09-21", "app", 3, 3).unwrap();
        let all = all(&c);
        assert_eq!(all["a"].len(), 2);
        assert_eq!(all["b"]["2026-09-21"], (3, 3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_drops_only_older_days() {
        let (dir, c) = conn("prune");
        add(&c, "a", "2024-01-01", "app", 1, 1).unwrap();
        add(&c, "a", "2026-09-21", "app", 2, 2).unwrap();
        prune(&c, "2026-01-01").unwrap();
        assert_eq!(all(&c)["a"].len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
