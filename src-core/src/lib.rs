//! MailVault Core — shared types, Maildir operations, and cache management.
//!
//! This crate provides the business logic used by both the Tauri app and
//! the background daemon. Functions take explicit `data_dir` paths instead
//! of depending on Tauri's AppHandle.

pub mod fsx;
pub mod maildir;
pub mod search_index;
pub mod vault_eml;
pub mod vault_files;
pub mod custody;
pub mod mime;
pub mod imap;
pub mod graph;
pub mod graph_ledger;
pub mod oauth2;
pub mod dns;
pub mod spellcheck;
pub mod transfer_stats;
pub mod net;
#[cfg(unix)]
pub mod daemon_ipc;

pub const BUILD_ID: &str = env!("MAILVAULT_BUILD_ID");

#[cfg(test)]
mod build_id_tests {
    #[test]
    fn the_build_id_is_never_empty() {
        assert!(!super::BUILD_ID.trim().is_empty());
    }
}
