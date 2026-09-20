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
///
/// A SQLite file since the JSON→SQL move, but deliberately **not** WAL: this
/// is three rows written once, and `-wal`/`-shm` siblings in the vault root
/// would travel badly on the network volumes and external drives a vault is
/// routinely put on. `read_marker` opens it read-only, so probing a folder the
/// user merely browsed to never creates anything in it.
pub const MARKER_FILE: &str = ".mailvault-vault.db";

/// The pre-SQL marker. `read_marker` still reads it, once, and retires it.
pub const LEGACY_MARKER_FILE: &str = ".mailvault-vault.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMarker {
    pub app: String,
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

fn read_marker_db(path: &Path) -> Option<VaultMarker> {
    use rusqlite::OpenFlags;
    // Read-only and no-create: this runs against whatever folder the user
    // picked in a native dialog, including ones that are not a vault at all.
    let conn = rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn.prepare("SELECT key, value FROM marker").ok()?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()?;
    let mut app = String::new();
    let mut vault_id = String::new();
    let mut created_at = 0u64;
    for (key, value) in rows.filter_map(Result::ok) {
        match key.as_str() {
            "app" => app = value,
            "vaultId" => vault_id = value,
            "createdAt" => created_at = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    (app == "mailvault").then_some(VaultMarker { app, vault_id, created_at })
}

/// The marker, reading the pre-SQL JSON file when that is all there is — and
/// moving it into the store on the way, so the next read is a plain one.
pub fn read_marker(dir: &Path) -> Option<VaultMarker> {
    let path = dir.join(MARKER_FILE);
    if path.is_file() {
        if let Some(marker) = read_marker_db(&path) {
            return Some(marker);
        }
    }
    let legacy = dir.join(LEGACY_MARKER_FILE);
    let raw = std::fs::read_to_string(&legacy).ok()?;
    let marker = serde_json::from_str::<VaultMarker>(&raw).ok().filter(|m| m.app == "mailvault")?;
    // Best effort: a read-only vault still reports its marker, it just keeps
    // reading the JSON copy.
    if write_marker(dir, &marker).is_ok() {
        let _ = crate::fsx::retire(&legacy, crate::fsx::retire_stamp());
    }
    Some(marker)
}

/// Phase 6: markers are now written by both processes (the app for its own
/// data-dir copy, the daemon for `adopt`/`move` destinations), so the writer
/// lives here next to the reader it must stay compatible with.
pub fn write_marker(dir: &Path, marker: &VaultMarker) -> Result<(), String> {
    let conn = rusqlite::Connection::open(dir.join(MARKER_FILE))
        .map_err(|e| format!("Cannot write vault marker: {e}"))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS marker (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|e| format!("Cannot write vault marker: {e}"))?;
    let rows = [
        ("app", marker.app.clone()),
        ("vaultId", marker.vault_id.clone()),
        ("createdAt", marker.created_at.to_string()),
    ];
    for (key, value) in rows {
        conn.execute("INSERT OR REPLACE INTO marker(key, value) VALUES (?1, ?2)", [key, value.as_str()])
            .map_err(|e| format!("Cannot write vault marker: {e}"))?;
    }
    Ok(())
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
        write_marker(&dir, &VaultMarker { app: "other".into(), vault_id: "x".into(), created_at: 1 }).unwrap();
        assert!(read_marker(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_marker_round_trips_through_read_marker() {
        let dir = scratch("write-marker");
        write_marker(&dir, &VaultMarker { app: "mailvault".into(), vault_id: "abc".into(), created_at: 1 }).unwrap();
        let marker = read_marker(&dir).unwrap();
        assert_eq!(marker.vault_id, "abc");
        assert_eq!(marker.created_at, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_vault_id_is_not_empty_and_varies() {
        let a = new_vault_id();
        assert!(!a.is_empty());
    }

    #[test]
    fn the_pre_sql_json_marker_is_read_once_then_retired() {
        let dir = scratch("legacy-marker");
        let data = serde_json::to_string(&VaultMarker {
            app: "mailvault".into(),
            vault_id: "abc".into(),
            created_at: 1,
        })
        .unwrap();
        std::fs::write(dir.join(LEGACY_MARKER_FILE), data).unwrap();

        assert_eq!(read_marker(&dir).unwrap().vault_id, "abc");
        assert!(dir.join(MARKER_FILE).is_file(), "the marker moved into the store");
        assert!(!dir.join(LEGACY_MARKER_FILE).exists(), "the JSON copy is retired, never deleted");
        assert!(std::fs::read_dir(&dir).unwrap().flatten().any(|e| {
            e.file_name().to_string_lossy().starts_with(&format!("{LEGACY_MARKER_FILE}.pre-db-"))
        }));
        assert_eq!(read_marker(&dir).unwrap().vault_id, "abc", "the second read comes from the store");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_with_no_marker_is_not_given_one_by_probing_it() {
        // `read_marker` runs against whatever the user picked in a native
        // dialog; it must never write into a folder that is not a vault.
        let dir = scratch("probe");
        assert!(read_marker(&dir).is_none());
        assert!(!dir.join(MARKER_FILE).exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_marker_file_that_is_not_a_database_reads_as_no_marker() {
        let dir = scratch("garbage-marker");
        std::fs::write(dir.join(MARKER_FILE), b"not a database").unwrap();
        assert!(read_marker(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
