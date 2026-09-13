//! Offline search index kept inside the vault (`<vault>/search_index/index.db`).
//! Spec: docs/superpowers/specs/2026-09-13-offline-search-index-design.md §6.

pub mod db;
pub mod plan;
pub mod query;
pub mod reconcile;
pub mod slot;
pub mod text;

/// The one connection an app process holds. `None` while the vault is being
/// switched or when the index could not be opened.
pub type SharedConn = std::sync::Mutex<Option<rusqlite::Connection>>;

pub fn lock(db: &SharedConn) -> std::sync::MutexGuard<'_, Option<rusqlite::Connection>> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}
