//! Custody records of the vault: for every message archived, sent or drafted
//! here, the entry the app wrote when it stored it (`source`, `serverDeleted`,
//! `serverAbsent`, flags, threading headers, ...). Not derivable from the
//! `.eml` files, so unlike the search index it is never deleted or rebuilt:
//! a store this build cannot read is reported and left exactly as it is.
//! Kept in `<vault>/custody/custody.db`, its own file (rulings #39, #40).
//! Spec: docs/superpowers/specs/2026-09-13-offline-search-index-design.md §7.

pub mod db;
pub mod cache;
pub mod entries;
pub mod import;

pub use crate::search_index::{lock, SharedConn};
pub use rusqlite::Connection;
