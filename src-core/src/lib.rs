//! MailVault Core — shared types, Maildir operations, and cache management.
//!
//! This crate provides the business logic used by both the Tauri app and
//! the background daemon. Functions take explicit `data_dir` paths instead
//! of depending on Tauri's AppHandle.

pub mod maildir;
pub mod types;
pub mod cache;
