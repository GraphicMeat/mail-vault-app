//! `<app_data_dir>/app.db` — what the app keeps about itself.
//!
//! Replaces eleven JSON files that sat beside it: the vault and external
//! backup locations (`<slot>-meta.json`, `<slot>-bookmark`, and the vault
//! slot's file under its old name `vault-meta.json`), the wire-byte counters,
//! classification results/model/queue, and the three journals of confirmed
//! work. `db::handle` imports and retires any that are still there.
//!
//! The mail itself is not here: that lives in the vault, in `custody.db` and
//! the `.eml` files.

pub mod classify;
pub mod db;
pub mod identity;
pub mod import;
pub mod locations;
pub mod ops;
pub mod stats;
pub mod tags;
pub mod views;

pub use db::{handle, with};
pub use rusqlite::Connection;
