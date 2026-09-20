//! User-selected folders the app keeps access to: the external backup mirror
//! (`external-backup`) and a relocated vault (`vault`).
//!
//! Was `<slot>-bookmark` (raw bytes: a macOS security-scoped bookmark, or the
//! path string on Linux) plus `<slot>-meta.json` (`{displayPath, platform,
//! savedAt, legacy?}`). The daemon read the `vault` slot's meta under its old
//! name, `vault-meta.json`.
//!
//! A row with `bookmark IS NULL` is the case the old code expressed as "meta
//! file present, bookmark file absent": metadata saved so the UI can still
//! show the path, but no access token — bookmark creation failed, or a legacy
//! raw path is waiting for the user to re-select the folder.

use rusqlite::{params, Connection, OptionalExtension};

/// What is persisted for a slot. `status`/`last_error` are decided at
/// resolve time and never stored, exactly as before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub display_path: String,
    pub platform: String,
    pub saved_at: u64,
    pub legacy: bool,
    pub has_bookmark: bool,
}

pub fn get(conn: &Connection, slot: &str) -> Option<Saved> {
    conn.query_row(
        "SELECT display_path, platform, saved_at, legacy, bookmark IS NOT NULL
           FROM external_locations WHERE slot = ?1",
        [slot],
        |r| {
            Ok(Saved {
                display_path: r.get(0)?,
                platform: r.get(1)?,
                saved_at: r.get::<_, i64>(2)? as u64,
                legacy: r.get::<_, i64>(3)? != 0,
                has_bookmark: r.get::<_, i64>(4)? != 0,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// The display path only — what the daemon needs to find a relocated vault.
pub fn display_path(conn: &Connection, slot: &str) -> Option<String> {
    get(conn, slot).map(|s| s.display_path).filter(|p| !p.is_empty())
}

pub fn bookmark(conn: &Connection, slot: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT bookmark FROM external_locations WHERE slot = ?1", [slot], |r| {
        r.get::<_, Option<Vec<u8>>>(0)
    })
    .optional()
    .ok()
    .flatten()
    .flatten()
}

/// Upsert the metadata, leaving any stored bookmark alone.
pub fn save_meta(
    conn: &Connection,
    slot: &str,
    display_path: &str,
    platform: &str,
    saved_at: u64,
    legacy: bool,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO external_locations(slot, display_path, platform, saved_at, legacy, bookmark)
              VALUES (?1, ?2, ?3, ?4, ?5, NULL)
         ON CONFLICT(slot) DO UPDATE SET
              display_path = excluded.display_path,
              platform     = excluded.platform,
              saved_at     = excluded.saved_at,
              legacy       = excluded.legacy",
        params![slot, display_path, platform, saved_at as i64, legacy as i64],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Upsert the bookmark, leaving any stored metadata alone. A slot can get its
/// bookmark before its metadata (`save_external_location` writes them in that
/// order), so this inserts a placeholder row rather than failing.
pub fn save_bookmark(conn: &Connection, slot: &str, bookmark: &[u8]) -> Result<(), String> {
    conn.execute(
        "INSERT INTO external_locations(slot, display_path, platform, saved_at, legacy, bookmark)
              VALUES (?1, '', '', 0, 0, ?2)
         ON CONFLICT(slot) DO UPDATE SET bookmark = excluded.bookmark",
        params![slot, bookmark],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn clear(conn: &Connection, slot: &str) -> Result<(), String> {
    conn.execute("DELETE FROM external_locations WHERE slot = ?1", [slot])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Every configured slot, for the Finder-reveal lookup that has to find which
/// location contains a path.
pub fn all(conn: &Connection) -> Vec<(String, Saved)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT slot, display_path, platform, saved_at, legacy, bookmark IS NOT NULL
           FROM external_locations ORDER BY slot",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Saved {
                display_path: r.get(1)?,
                platform: r.get(2)?,
                saved_at: r.get::<_, i64>(3)? as u64,
                legacy: r.get::<_, i64>(4)? != 0,
                has_bookmark: r.get::<_, i64>(5)? != 0,
            },
        ))
    });
    rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn scratch(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("mv-loc-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_saved_slot_reads_back() {
        let dir = scratch("roundtrip");
        let conn = db::open(&dir).unwrap();
        save_bookmark(&conn, "vault", b"bookmark-bytes").unwrap();
        save_meta(&conn, "vault", "/Volumes/Mail", "macos", 1700, false).unwrap();
        let saved = get(&conn, "vault").unwrap();
        assert_eq!(saved.display_path, "/Volumes/Mail");
        assert!(saved.has_bookmark);
        assert_eq!(bookmark(&conn, "vault").as_deref(), Some(&b"bookmark-bytes"[..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_metadata_does_not_drop_the_bookmark() {
        // `save_external_location` writes the bookmark, then the metadata.
        let dir = scratch("keep-bookmark");
        let conn = db::open(&dir).unwrap();
        save_bookmark(&conn, "external-backup", b"abc").unwrap();
        save_meta(&conn, "external-backup", "/tmp/x", "macos", 1, false).unwrap();
        assert_eq!(bookmark(&conn, "external-backup").as_deref(), Some(&b"abc"[..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadata_without_a_bookmark_is_the_needs_reauth_case() {
        let dir = scratch("meta-only");
        let conn = db::open(&dir).unwrap();
        save_meta(&conn, "external-backup", "/old/path", "macos", 5, true).unwrap();
        let saved = get(&conn, "external-backup").unwrap();
        assert!(!saved.has_bookmark, "no bookmark: the old code saw no `<slot>-bookmark` file");
        assert!(saved.legacy);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unconfigured_slot_is_none() {
        let dir = scratch("empty");
        let conn = db::open(&dir).unwrap();
        assert_eq!(get(&conn, "vault"), None);
        assert_eq!(display_path(&conn, "vault"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_display_path_is_not_a_configured_vault() {
        // `vault-meta.json` with `"displayPath": ""` meant "use the default".
        let dir = scratch("empty-path");
        let conn = db::open(&dir).unwrap();
        save_meta(&conn, "vault", "", "macos", 1, false).unwrap();
        assert_eq!(display_path(&conn, "vault"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_both_halves() {
        let dir = scratch("clear");
        let conn = db::open(&dir).unwrap();
        save_bookmark(&conn, "vault", b"x").unwrap();
        save_meta(&conn, "vault", "/p", "macos", 1, false).unwrap();
        clear(&conn, "vault").unwrap();
        assert_eq!(get(&conn, "vault"), None);
        assert_eq!(bookmark(&conn, "vault"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
