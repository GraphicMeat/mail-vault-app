//! The `meta(key, value)` table app.db and custody.db both carry: one reader
//! and one writer, re-exported as `app_db::db::meta_*` and
//! `custody::db::meta_*`. A leaf, so `people` (whose tables live in
//! custody.db) reads it without naming `custody`.

use rusqlite::{Connection, OptionalExtension};

/// The value under `key`, or `None` when it is absent or unreadable.
pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", [key, value])
        .map(|_| ())
        .map_err(|e| e.to_string())
}
