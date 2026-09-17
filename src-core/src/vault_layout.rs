//! Where the vault lives on disk, shared by the app (`vault::root`, the Tauri
//! shell) and the daemon (`resolve_mail_dir`).
//!
//! Before Task 2.5 the two processes disagreed: the app treated a folder as
//! ready when it held the marker OR any non-index `VAULT_DIRS` entry, while
//! the daemon only checked marker OR `Maildir`. A vault holding e.g. only
//! `custody/` + `email_cache/` read ready in the app and unreachable in the
//! daemon. With custody opening in the daemon (Task 2.9a/b) that divergence
//! decides where `custody.db` opens, so both processes now share this rule.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Mail-data directories that live in the vault. Everything else under the app
/// data dir (accounts.json, settings, logs, caches of app state) stays put.
pub const VAULT_DIRS: [&str; 8] = [
    "Maildir",          // the messages
    "maildir",          // legacy per-mailbox index dirs (now .pre-db files), kept so a move carries them
    "email_cache",      // header sidecars
    "attachment_cache", // extracted attachments
    "mailboxes",        // per-account folder lists
    "search_index",     // offline search index (derived; rebuilt from Maildir)
    "custody",          // custody records (what each stored message is); never derived, never deleted
    "contacts_index",   // sender address book (derived; rebuilt from email_cache) — final fix wave I-1
];

/// Marker written at the vault root so a re-selected folder can be recognised
/// as this app's vault (and told apart from someone else's).
pub const MARKER_FILE: &str = ".mailvault-vault.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMarker {
    pub app: String,
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

pub fn read_marker(dir: &Path) -> Option<VaultMarker> {
    let raw = std::fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    serde_json::from_str::<VaultMarker>(&raw).ok().filter(|m| m.app == "mailvault")
}

/// Phase 6: markers are now written by both processes (the app for its own
/// data-dir copy, the daemon for `adopt`/`move` destinations), so the writer
/// moved here next to the reader it must stay compatible with.
pub fn write_marker(dir: &Path, marker: &VaultMarker) -> Result<(), String> {
    let data = serde_json::to_string_pretty(marker).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MARKER_FILE), data).map_err(|e| format!("Cannot write vault marker: {}", e))
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Enough entropy to tell two vaults apart; not a security boundary.
pub fn new_vault_id() -> String {
    format!("{:x}-{:x}", now_millis(), std::process::id())
}

/// True if the folder already holds mail data, marker or not. A search index
/// or contacts index alone is derived data, not mail — a stray
/// `contacts_index/` left behind by an old, ungated flush (final fix wave
/// I-1) must not make an otherwise-empty folder look like a vault.
pub fn looks_like_vault(dir: &Path) -> bool {
    VAULT_DIRS
        .iter()
        .filter(|d| **d != "search_index" && **d != "contacts_index")
        .any(|d| dir.join(d).exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("mv-vault-layout-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_folder_with_only_custody_looks_like_a_vault() {
        let dir = scratch("custody-only");
        std::fs::create_dir_all(dir.join("custody")).unwrap();
        assert!(looks_like_vault(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_folder_does_not_look_like_a_vault() {
        let dir = scratch("empty");
        assert!(!looks_like_vault(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_search_index_only_folder_does_not_look_like_a_vault() {
        let dir = scratch("index-only");
        std::fs::create_dir_all(dir.join("search_index")).unwrap();
        assert!(!looks_like_vault(&dir), "a derived index alone is not mail");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_contacts_index_only_folder_does_not_look_like_a_vault() {
        // final fix wave I-1: a stray `contacts_index/` left in the old root
        // by an ungated flush must not make an otherwise-empty folder read
        // as this app's vault.
        let dir = scratch("contacts-index-only");
        std::fs::create_dir_all(dir.join("contacts_index")).unwrap();
        assert!(!looks_like_vault(&dir), "a derived contacts index alone is not mail");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_move_carries_the_contacts_index_dir() {
        assert!(VAULT_DIRS.contains(&"contacts_index"), "a vault move must carry the contacts index, not orphan it");
    }

    #[test]
    fn a_marker_from_another_app_is_not_accepted() {
        let dir = scratch("foreign-marker");
        std::fs::write(dir.join(MARKER_FILE), br#"{"app":"other","vaultId":"x","createdAt":1}"#).unwrap();
        assert!(read_marker(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_marker_round_trips_through_read_marker() {
        let dir = scratch("write-marker");
        write_marker(&dir, &VaultMarker { app: "mailvault".into(), vault_id: "abc".into(), created_at: 1 }).unwrap();
        assert_eq!(read_marker(&dir).unwrap().vault_id, "abc");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_vault_id_is_not_empty_and_varies() {
        let a = new_vault_id();
        assert!(!a.is_empty());
    }

    #[test]
    fn a_mailvault_marker_round_trips() {
        let dir = scratch("marker");
        let data = serde_json::to_string(&VaultMarker {
            app: "mailvault".into(),
            vault_id: "abc".into(),
            created_at: 1,
        })
        .unwrap();
        std::fs::write(dir.join(MARKER_FILE), data).unwrap();
        assert_eq!(read_marker(&dir).unwrap().vault_id, "abc");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
