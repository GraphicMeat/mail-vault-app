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
pub const VAULT_DIRS: [&str; 7] = [
    "Maildir",          // the messages
    "maildir",          // legacy per-mailbox index dirs (now .pre-db files), kept so a move carries them
    "email_cache",      // header sidecars
    "attachment_cache", // extracted attachments
    "mailboxes",        // per-account folder lists
    "search_index",     // offline search index (derived; rebuilt from Maildir)
    "custody",          // custody records (what each stored message is); never derived, never deleted
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

/// True if the folder already holds mail data, marker or not. A search index
/// alone is derived data, not mail.
pub fn looks_like_vault(dir: &Path) -> bool {
    VAULT_DIRS.iter().filter(|d| **d != "search_index").any(|d| dir.join(d).exists())
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
    fn a_marker_from_another_app_is_not_accepted() {
        let dir = scratch("foreign-marker");
        std::fs::write(dir.join(MARKER_FILE), br#"{"app":"other","vaultId":"x","createdAt":1}"#).unwrap();
        assert!(read_marker(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
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
