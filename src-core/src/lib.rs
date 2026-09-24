//! MailVault Core — shared types, Maildir operations, and cache management.
//!
//! This crate provides the business logic used by both the Tauri app and
//! the background daemon. Functions take explicit `data_dir` paths instead
//! of depending on Tauri's AppHandle.

pub mod ai;
pub mod app_db;
pub mod archive;
pub mod autostart;
pub mod windows_mailto;
pub mod backup;
pub mod fsx;
pub mod header_cache;
pub mod maildir;
pub mod search_index;
pub mod vault_eml;
pub mod vault_files;
pub mod vault_flags;
pub mod vault_layout;
pub mod vault_ops;
pub mod vault_registry;
pub mod op_journal;
pub mod custody;
pub mod mime;
pub mod imap;
pub mod graph;
pub mod graph_ledger;
pub mod keychain;
pub mod oauth2;
pub mod dns;
pub mod smtp;
pub mod spellcheck;
pub mod transfer_stats;
pub mod transfer;
pub mod net;
pub mod daemon_ipc;
pub mod transport;
pub mod paths;
pub mod update_track;

pub const BUILD_ID: &str = env!("MAILVAULT_BUILD_ID");

#[cfg(test)]
mod build_id_tests {
    #[test]
    fn the_build_id_is_never_empty() {
        assert!(!super::BUILD_ID.trim().is_empty());
    }
}
