//! Unsubscribe history and the BIMI logo cache (app.db schema v6). Written
//! and read only by `src-daemon/src/handlers/unsubscribe.rs`.

use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsubscribe {
    pub address: String,
    pub account_id: String,
    /// Unix ms UTC.
    pub unsubscribed_at: i64,
    /// "one-click" | "browser" | "mailto".
    pub method: String,
    /// "ok" | "failed" (one-click) | "opened" (handed to the browser or compose).
    pub status: String,
}

pub fn record(conn: &Connection, row: &Unsubscribe) -> Result<(), String> {
    conn.execute(
        "INSERT INTO unsubscribes(address, account_id, unsubscribed_at, method, status) VALUES (?1,?2,?3,?4,?5)",
        params![row.address.to_lowercase(), row.account_id, row.unsubscribed_at, row.method, row.status],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Newest first; every account when `account_id` is None.
pub fn history(conn: &Connection, account_id: Option<&str>) -> Result<Vec<Unsubscribe>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT address, account_id, unsubscribed_at, method, status FROM unsubscribes
             WHERE ?1 IS NULL OR account_id = ?1 ORDER BY unsubscribed_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], |r| {
            Ok(Unsubscribe {
                address: r.get(0)?,
                account_id: r.get(1)?,
                unsubscribed_at: r.get(2)?,
                method: r.get(3)?,
                status: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// A live cache entry: `Some(None)` is a cached "no logo", `None` a miss.
pub fn bimi_get(conn: &Connection, domain: &str, now_ms: i64) -> Result<Option<Option<Vec<u8>>>, String> {
    conn.query_row(
        "SELECT svg FROM bimi_cache WHERE domain = ?1 AND expires_at > ?2",
        params![domain, now_ms],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn bimi_put(conn: &Connection, domain: &str, svg: Option<&[u8]>, expires_at_ms: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO bimi_cache(domain, svg, expires_at) VALUES (?1,?2,?3)",
        params![domain, svg, expires_at_ms],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> (std::path::PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-unsub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    fn row(address: &str, account: &str, at: i64) -> Unsubscribe {
        Unsubscribe { address: address.into(), account_id: account.into(), unsubscribed_at: at, method: "one-click".into(), status: "ok".into() }
    }

    #[test]
    fn history_is_newest_first_and_scoped_by_account() {
        let (dir, c) = conn();
        record(&c, &row("News@Brand.test", "a", 1)).unwrap();
        record(&c, &row("deals@shop.test", "b", 2)).unwrap();
        let all = history(&c, None).unwrap();
        assert_eq!(all.iter().map(|r| r.unsubscribed_at).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(all[1].address, "news@brand.test", "stored lowercased");
        let only_a = history(&c, Some("a")).unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].account_id, "a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bimi_cache_hits_until_it_expires_and_keeps_negative_entries() {
        let (dir, c) = conn();
        assert_eq!(bimi_get(&c, "brand.test", 0).unwrap(), None);
        bimi_put(&c, "brand.test", Some(b"<svg/>"), 100).unwrap();
        bimi_put(&c, "none.test", None, 100).unwrap();
        assert_eq!(bimi_get(&c, "brand.test", 50).unwrap(), Some(Some(b"<svg/>".to_vec())));
        assert_eq!(bimi_get(&c, "none.test", 50).unwrap(), Some(None));
        assert_eq!(bimi_get(&c, "brand.test", 100).unwrap(), None, "expired");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
