//! Vault-only folders: mail kept on this computer in a Maildir folder no
//! server lists (MBOX import mode 3, "Import as a separate folder"). A folder
//! is one of these by the marker file in its directory, never by its name: an
//! unmarked directory belongs to a server folder, or to nobody known, and is
//! never listed or deleted as a local folder.
//!
//! The marker stores the display name because the directory is
//! `vault_dir_name(name)`, which turns the spaces into `_`.

use crate::search_index::text::vault_dir_name;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tracing::warn;

/// In the folder's directory, beside `cur/`, where no Maildir scan looks.
pub const MARKER_FILE: &str = ".mailvault-local.json";

/// The kind an MBOX import writes, and the only one a delete accepts.
pub const KIND_IMPORT: &str = "import";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    pub kind: String,
    /// The display name; the directory is `vault_dir_name(name)`.
    pub name: String,
    /// Unix ms.
    pub created: u64,
    /// The imported file's name, without its path.
    pub source: String,
}

/// `MBOX import <date>` for the first folder of a day, then ` 2`, ` 3`, ...
pub fn import_folder_name(date: &str, n: u32) -> String {
    if n <= 1 {
        format!("MBOX import {date}")
    } else {
        format!("MBOX import {date} {n}")
    }
}

/// Written whole or not at all: `fsx::write_atomic`'s temp is dot-prefixed,
/// so a killed write never leaves a file read as the marker.
pub fn write_marker(folder: &Path, marker: &Marker) -> std::io::Result<()> {
    let json = serde_json::to_vec(marker).map_err(std::io::Error::other)?;
    crate::fsx::write_atomic(&folder.join(MARKER_FILE), &json)
}

/// The marker of `account_dir/dir`. `Ok(None)`: it has none. `Err`: one that
/// is not a regular file, does not parse, or names another directory (a
/// copied folder would otherwise pass for the original).
pub fn read_marker(account_dir: &Path, dir: &str) -> Result<Option<Marker>, String> {
    let path = account_dir.join(dir).join(MARKER_FILE);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(meta) if !meta.is_file() => return Err("the marker is not a regular file".to_string()),
        Ok(_) => {}
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let marker: Marker = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if vault_dir_name(&marker.name) != dir {
        return Err(format!("the marker names another folder: {}", marker.name));
    }
    Ok(Some(marker))
}

/// Makes the next free `MBOX import <date>` folder in `account_dir`, marker
/// included, and returns the marker and the directory. A name is free when
/// nothing at all sits at its directory: `create_dir` is the test, so any
/// existing entry counts (a server folder's directory, one whose name
/// sanitizes the same, a stray file) and two imports never share a folder.
pub fn create_import_folder(account_dir: &Path, date: &str, source: &str, created: u64) -> std::io::Result<(Marker, String)> {
    fs::create_dir_all(account_dir)?;
    let mut n = 1;
    loop {
        let name = import_folder_name(date, n);
        let dir = vault_dir_name(&name);
        let folder = account_dir.join(&dir);
        match fs::create_dir(&folder) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1;
                continue;
            }
            other => other?,
        }
        let marker = Marker { kind: KIND_IMPORT.to_string(), name, created, source: source.to_string() };
        if let Err(e) = write_marker(&folder, &marker) {
            let _ = fs::remove_dir(&folder);
            return Err(e);
        }
        return Ok((marker, dir));
    }
}

/// Every marked folder in `account_dir` as `(dir, marker)`, oldest first.
/// Symlinks are skipped, never followed; a folder whose marker will not read
/// is logged and skipped. No account dir: none. One that cannot be listed is
/// an error, never "none".
pub fn list(account_dir: &Path) -> std::io::Result<Vec<(String, Marker)>> {
    let entries = match fs::read_dir(account_dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        other => other?,
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        // `DirEntry::file_type` does not follow a symlink.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = entry.file_name().to_string_lossy().into_owned();
        match read_marker(account_dir, &dir) {
            Ok(Some(marker)) => out.push((dir, marker)),
            Ok(None) => {}
            Err(e) => warn!("local folder {dir}: marker skipped: {e}"),
        }
    }
    out.sort_by(|a, b| (a.1.created, &a.0).cmp(&(b.1.created, &b.0)));
    Ok(out)
}

/// Removes `folder` once no message is left anywhere in it (a vault file
/// name, `has_info`; symlinks are removed, never followed), the marker last so
/// a removal cut short still lists and can run again. `Ok(false)`: mail is
/// left and nothing was removed. A tree that cannot be walked is an error.
pub fn remove_if_no_mail(folder: &Path) -> Result<bool, String> {
    for entry in walkdir::WalkDir::new(folder) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() && crate::maildir::has_info(&entry.file_name().to_string_lossy()) {
            return Ok(false);
        }
    }
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == MARKER_FILE {
            continue;
        }
        let path = entry.path();
        let removed = match entry.file_type() {
            Ok(t) if t.is_dir() => fs::remove_dir_all(&path),
            _ => fs::remove_file(&path),
        };
        removed.map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
    }
    fs::remove_file(folder.join(MARKER_FILE)).map_err(|e| format!("Failed to remove the marker: {e}"))?;
    fs::remove_dir(folder).map_err(|e| format!("Failed to remove {}: {e}", folder.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;
    use serde_json::{json, Value};

    const DAY: &str = "2026-09-29";

    fn marker(name: &str, created: u64) -> Marker {
        Marker { kind: KIND_IMPORT.into(), name: name.into(), created, source: "takeout.mbox".into() }
    }

    /// A marked folder `name` in `account_dir`, the way an import leaves it.
    fn marked(account_dir: &Path, name: &str, created: u64) -> String {
        let dir = vault_dir_name(name);
        fs::create_dir_all(account_dir.join(&dir).join("cur")).unwrap();
        write_marker(&account_dir.join(&dir), &marker(name, created)).unwrap();
        dir
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn the_marker_round_trips_and_leaves_no_temp_file() {
        let t = tempfile::tempdir().unwrap();
        let dir = marked(t.path(), "MBOX import 2026-09-29", 1_790_000_000_000);
        assert_eq!(dir, "MBOX_import_2026-09-29");
        assert_eq!(read_marker(t.path(), &dir).unwrap(), Some(marker("MBOX import 2026-09-29", 1_790_000_000_000)));
        assert_eq!(names_in(&t.path().join(&dir)), vec![MARKER_FILE, "cur"], "the write-then-rename temp is gone");
        let on_disk: Value = serde_json::from_str(&fs::read_to_string(t.path().join(&dir).join(MARKER_FILE)).unwrap()).unwrap();
        assert_eq!(on_disk, json!({"kind": "import", "name": "MBOX import 2026-09-29", "created": 1_790_000_000_000u64, "source": "takeout.mbox"}));
    }

    /// No marker, a leftover temp of one, one that does not parse, one that
    /// names another directory (a copied folder) and one that is not a
    /// regular file: none of them makes a local folder.
    #[test]
    fn only_a_readable_marker_for_this_very_directory_counts() {
        let t = tempfile::tempdir().unwrap();
        let acct = t.path();
        let good = marked(acct, "MBOX import 2026-09-29", 5);
        assert!(read_marker(acct, &good).unwrap().is_some(), "the control reads");

        fs::create_dir_all(acct.join("INBOX/cur")).unwrap();
        assert_eq!(read_marker(acct, "INBOX").unwrap(), None);

        fs::create_dir_all(acct.join("Temp")).unwrap();
        fs::write(acct.join("Temp").join(format!(".{MARKER_FILE}.tmp-1-0")), serde_json::to_vec(&marker("Temp", 1)).unwrap()).unwrap();
        assert_eq!(read_marker(acct, "Temp").unwrap(), None, "a killed write's temp is not the marker");

        fs::create_dir_all(acct.join("Broken")).unwrap();
        fs::write(acct.join("Broken").join(MARKER_FILE), b"{not json").unwrap();
        assert!(read_marker(acct, "Broken").is_err());

        fs::create_dir_all(acct.join("Copy")).unwrap();
        fs::copy(acct.join(&good).join(MARKER_FILE), acct.join("Copy").join(MARKER_FILE)).unwrap();
        assert!(read_marker(acct, "Copy").is_err(), "a marker naming another directory");

        fs::create_dir_all(acct.join("Odd").join(MARKER_FILE)).unwrap();
        assert!(read_marker(acct, "Odd").is_err(), "a marker that is a directory");
    }

    #[test]
    fn names_follow_the_day_and_count_up_on_a_clash() {
        assert_eq!(import_folder_name(DAY, 1), "MBOX import 2026-09-29");
        assert_eq!(import_folder_name(DAY, 2), "MBOX import 2026-09-29 2");
        let t = tempfile::tempdir().unwrap();
        let acct = t.path().join("acct");
        let (m1, d1) = create_import_folder(&acct, DAY, "a.mbox", 1).unwrap();
        let (m2, d2) = create_import_folder(&acct, DAY, "a.mbox", 2).unwrap();
        let (m3, d3) = create_import_folder(&acct, DAY, "b.mbox", 3).unwrap();
        assert_eq!((m1.name.as_str(), d1.as_str()), ("MBOX import 2026-09-29", "MBOX_import_2026-09-29"));
        assert_eq!((m2.name.as_str(), d2.as_str()), ("MBOX import 2026-09-29 2", "MBOX_import_2026-09-29_2"));
        assert_eq!((m3.name.as_str(), d3.as_str()), ("MBOX import 2026-09-29 3", "MBOX_import_2026-09-29_3"));
        assert_eq!(read_marker(&acct, &d3).unwrap(), Some(m3.clone()));
        assert_eq!((m3.kind.as_str(), m3.created, m3.source.as_str()), ("import", 3, "b.mbox"));
        assert_eq!(create_import_folder(&acct, "2026-09-30", "c.mbox", 4).unwrap().1, "MBOX_import_2026-09-30", "a new day starts over");
    }

    /// The clash test is the directory entry at the sanitized name, whatever
    /// made it: a server folder spelled with the underscore, a stray file, a
    /// dangling symlink. None of them is touched.
    #[test]
    fn any_entry_already_at_the_sanitized_name_is_taken() {
        let t = tempfile::tempdir().unwrap();
        let acct = t.path().join("acct");
        fs::create_dir_all(acct.join("MBOX_import_2026-09-29/cur")).unwrap();
        let server_msg = acct.join("MBOX_import_2026-09-29/cur").join(format!("7{INFO_PREFIX}S.eml"));
        fs::write(&server_msg, b"a server message").unwrap();
        fs::write(acct.join("MBOX_import_2026-09-29_2"), b"a stray file").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(t.path().join("nowhere"), acct.join("MBOX_import_2026-09-29_3")).unwrap();
        let (m, d) = create_import_folder(&acct, DAY, "a.mbox", 1).unwrap();
        let want = if cfg!(unix) { 4 } else { 3 };
        assert_eq!(m.name, format!("MBOX import 2026-09-29 {want}"));
        assert_eq!(d, format!("MBOX_import_2026-09-29_{want}"));
        assert_eq!(names_in(&acct.join("MBOX_import_2026-09-29")), vec!["cur"], "the server folder got no marker");
        assert_eq!(fs::read(&server_msg).unwrap(), b"a server message");
        assert_eq!(fs::read(acct.join("MBOX_import_2026-09-29_2")).unwrap(), b"a stray file");
    }

    #[test]
    fn list_answers_with_marked_folders_only_oldest_first() {
        let t = tempfile::tempdir().unwrap();
        let acct = t.path().join("acct");
        let later = marked(&acct, "MBOX import 2026-09-29 2", 20);
        let first = marked(&acct, "MBOX import 2026-09-29", 10);
        fs::create_dir_all(acct.join("INBOX/cur")).unwrap();
        fs::create_dir_all(acct.join("Broken")).unwrap();
        fs::write(acct.join("Broken").join(MARKER_FILE), b"garbage").unwrap();
        fs::create_dir_all(acct.join("Copy")).unwrap();
        fs::copy(acct.join(&first).join(MARKER_FILE), acct.join("Copy").join(MARKER_FILE)).unwrap();
        fs::write(acct.join("stray"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(acct.join(&first), acct.join("Linked")).unwrap();

        let found = list(&acct).unwrap();
        assert_eq!(found, vec![(first, marker("MBOX import 2026-09-29", 10)), (later, marker("MBOX import 2026-09-29 2", 20))]);
        assert_eq!(list(&t.path().join("no-such-account")).unwrap(), vec![], "no account dir: none");
    }

    /// Nothing prunes a folder no server lists. The search index's vault walk
    /// lists it like any other (its folder prune drops only what the walk
    /// does not list), and Clear cached emails keeps its mail, which the
    /// import writes with `A`, and its marker. The INBOX cache copy is the
    /// control: the clear did run.
    #[test]
    fn the_index_walk_lists_a_local_folder_and_clearing_the_cache_keeps_it() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let acct = root.join("Maildir/acct");
        let dir = marked(&acct, "MBOX import 2026-09-29", 1);
        let mail = acct.join(&dir).join("cur").join(format!("3221225472{INFO_PREFIX}A.eml"));
        fs::write(&mail, b"imported").unwrap();
        fs::create_dir_all(acct.join("INBOX/cur")).unwrap();
        let cached = acct.join("INBOX/cur").join(format!("1{INFO_PREFIX}S.eml"));
        fs::write(&cached, b"a cache copy").unwrap();

        let dirs = crate::search_index::reconcile::list_vault_dirs(&root.join("Maildir")).unwrap();
        assert!(dirs.contains(&("acct".to_string(), dir.clone())), "{dirs:?}");

        let app = tempfile::tempdir().unwrap();
        let registry = crate::vault_registry::VaultRegistry::open(app.path(), root);
        let gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let cleared = crate::vault_files::clear_cache(&registry, root, &gate).unwrap();
        assert_eq!(cleared.deleted_count, 1);
        assert!(!cached.exists(), "the control: a cache copy goes");
        assert_eq!(fs::read(&mail).unwrap(), b"imported");
        assert_eq!(read_marker(&acct, &dir).unwrap().map(|m| m.name).as_deref(), Some("MBOX import 2026-09-29"));
    }

    /// Mail anywhere in the folder keeps it, `orphaned/` included; with none
    /// left it goes whole, the marker last. A symlink inside is removed as a
    /// link, never followed.
    #[test]
    fn a_folder_goes_only_when_no_mail_is_left_in_it() {
        let t = tempfile::tempdir().unwrap();
        let acct = t.path().join("acct");
        let dir = marked(&acct, "MBOX import 2026-09-29", 1);
        let folder = acct.join(&dir);
        let left = folder.join("cur").join(format!("3221225472{INFO_PREFIX}A.eml"));
        fs::write(&left, b"mail").unwrap();
        assert_eq!(remove_if_no_mail(&folder), Ok(false));
        assert!(left.exists() && folder.join(MARKER_FILE).exists());

        fs::remove_file(&left).unwrap();
        fs::create_dir_all(folder.join("orphaned")).unwrap();
        let orphan = folder.join("orphaned").join(format!("5{INFO_PREFIX}S.eml"));
        fs::write(&orphan, b"set aside").unwrap();
        assert_eq!(remove_if_no_mail(&folder), Ok(false));
        assert!(orphan.exists() && folder.join(MARKER_FILE).exists());

        fs::remove_dir_all(folder.join("orphaned")).unwrap();
        fs::write(folder.join(".DS_Store"), b"finder").unwrap();
        fs::create_dir_all(folder.join(".decrypted")).unwrap();
        fs::write(folder.join(".decrypted/7.eml"), b"a decrypted copy").unwrap();
        let outside = t.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let theirs = outside.join(format!("9{INFO_PREFIX}S.eml"));
        fs::write(&theirs, b"not ours").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, folder.join("ext")).unwrap();
        assert_eq!(remove_if_no_mail(&folder), Ok(true));
        assert!(!folder.exists());
        assert_eq!(fs::read(&theirs).unwrap(), b"not ours");
    }
}
