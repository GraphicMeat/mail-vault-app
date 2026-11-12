//! The `meta(key, value)` table app.db, custody.db and the search index all
//! carry: one reader and one writer, re-exported as `app_db::db::meta_*`,
//! `custody::db::meta_*` and `search_index::db::meta_*`. A leaf, so `people`
//! (whose tables live in custody.db) reads it without naming `custody`.

use rusqlite::{Connection, OptionalExtension};

/// The value under `key`, or `None` when it is absent or unreadable. A read
/// error reads as "not set": only for values where that is harmless; a
/// decision that would write over the stored value uses [`meta_get_checked`].
pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    meta_get_checked(conn, key).ok().flatten()
}

/// `Ok(None)` only when the key is not stored.
pub fn meta_get_checked(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", [key, value])
        .map(|_| ())
        .map_err(|e| e.to_string())
}
