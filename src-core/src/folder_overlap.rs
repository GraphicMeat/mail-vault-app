//! A backup is a second copy, so it cannot share a folder with the mail it
//! copies. Two folders overlap when they are the same, or one is inside the
//! other. The app data dir stands in for the mail folder until the vault is
//! moved. Both the shell (saving a backup folder) and the daemon (moving or
//! adopting the vault) ask here, before anything is written or copied.

use crate::app_db::{self, locations};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// Refusal codes. The app maps each to a catalog sentence
/// (`src/services/storageFormat.js`); the text after the colon is the folder
/// it ran into.
pub const E_BACKUP_OVERLAPS_VAULT: &str = "E_BACKUP_OVERLAPS_VAULT";
pub const E_VAULT_OVERLAPS_BACKUP: &str = "E_VAULT_OVERLAPS_BACKUP";

/// `path` with `.`/`..` folded and every symlink resolved. A folder that does
/// not exist yet is placed by its nearest existing parent.
fn resolved(path: &Path) -> PathBuf {
    let mut folded = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                folded.pop();
            }
            other => folded.push(other.as_os_str()),
        }
    }
    let mut tail = Vec::new();
    let mut base = folded.as_path();
    loop {
        if let Ok(real) = base.canonicalize() {
            return tail.iter().rev().fold(real, |acc, part: &OsString| acc.join(part));
        }
        match (base.file_name(), base.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_owned());
                base = parent;
            }
            _ => return folded,
        }
    }
}

/// Whole path components, so `/Mail` and `/MailBackup` stay apart. APFS and
/// NTFS fold case, so there `Mail` and `mail` are one folder.
fn components(path: &Path) -> Vec<String> {
    resolved(path)
        .components()
        .map(|c| {
            let part = c.as_os_str().to_string_lossy();
            if cfg!(any(target_os = "macos", windows)) { part.to_lowercase() } else { part.into_owned() }
        })
        .collect()
}

pub fn overlaps(a: &Path, b: &Path) -> bool {
    let (a, b) = (components(a), components(b));
    a.starts_with(&b) || b.starts_with(&a)
}

/// Where the mail is kept: the moved vault, else the app data dir.
fn mail_folder(app_dir: &Path) -> PathBuf {
    saved_folder(app_dir, "vault").unwrap_or_else(|| app_dir.to_path_buf())
}

fn saved_folder(app_dir: &Path, slot: &'static str) -> Option<PathBuf> {
    app_db::with(app_dir, |c| Ok(locations::display_path(c, slot))).ok().flatten().map(PathBuf::from)
}

/// `candidate` as the backup folder: refused when it overlaps the mail folder.
pub fn check_backup_folder(app_dir: &Path, candidate: &Path) -> Result<(), String> {
    let mail = mail_folder(app_dir);
    if overlaps(&mail, candidate) {
        return Err(format!("{E_BACKUP_OVERLAPS_VAULT}: {}", mail.display()));
    }
    Ok(())
}

/// `candidate` as the mail folder: refused when it overlaps the backup folder.
pub fn check_vault_folder(app_dir: &Path, candidate: &Path) -> Result<(), String> {
    match saved_folder(app_dir, "external-backup") {
        Some(backup) if overlaps(&backup, candidate) => Err(format!("{E_VAULT_OVERLAPS_BACKUP}: {}", backup.display())),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::{self, locations};
    use std::fs;
    use std::path::PathBuf;

    fn dir(root: &Path, rel: &str) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn save(app_dir: &Path, slot: &'static str, path: &Path) {
        app_db::with(app_dir, |c| locations::save_meta(c, slot, &path.to_string_lossy(), "native", 1, false)).unwrap();
    }

    #[test]
    fn the_same_folder_overlaps() {
        let t = tempfile::tempdir().unwrap();
        let a = dir(t.path(), "mail");
        assert!(overlaps(&a, &a));
    }

    #[test]
    fn a_folder_inside_the_other_overlaps_both_ways() {
        let t = tempfile::tempdir().unwrap();
        let outer = dir(t.path(), "mail");
        let inner = dir(t.path(), "mail/backup/deeper");
        assert!(overlaps(&outer, &inner));
        assert!(overlaps(&inner, &outer));
    }

    #[test]
    fn a_sibling_that_shares_a_name_prefix_does_not_overlap() {
        let t = tempfile::tempdir().unwrap();
        let mail = dir(t.path(), "Mail");
        let backup = dir(t.path(), "MailBackup");
        assert!(!overlaps(&mail, &backup));
        assert!(!overlaps(&backup, &mail));
    }

    #[test]
    fn a_folder_that_does_not_exist_yet_is_placed_by_its_nearest_existing_parent() {
        let t = tempfile::tempdir().unwrap();
        let mail = dir(t.path(), "mail");
        assert!(overlaps(&mail, &t.path().join("mail/new/backup")));
        assert!(!overlaps(&mail, &t.path().join("elsewhere/new")));
    }

    #[test]
    fn dot_dot_and_trailing_separators_do_not_hide_an_overlap() {
        let t = tempfile::tempdir().unwrap();
        let mail = dir(t.path(), "mail");
        dir(t.path(), "other");
        assert!(overlaps(&mail, &t.path().join("other/../mail/")));
        assert!(overlaps(&mail, &t.path().join("other/../mail/x/../y")));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_into_the_mail_folder_overlaps_it() {
        let t = tempfile::tempdir().unwrap();
        let mail = dir(t.path(), "mail");
        let link = t.path().join("shortcut");
        std::os::unix::fs::symlink(&mail, &link).unwrap();
        assert!(overlaps(&mail, &link));
        assert!(overlaps(&mail, &link.join("inner")));
    }

    // APFS and NTFS fold case; `canonicalize` of a folder that is not there yet
    // does not.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn case_does_not_hide_an_overlap_on_a_case_insensitive_disk() {
        let t = tempfile::tempdir().unwrap();
        let mail = dir(t.path(), "Mail");
        assert!(overlaps(&mail, &t.path().join("mail/Backup")));
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn case_separates_folders_on_a_case_sensitive_disk() {
        let t = tempfile::tempdir().unwrap();
        let mail = dir(t.path(), "Mail");
        assert!(!overlaps(&mail, &t.path().join("mail/Backup")));
    }

    #[test]
    fn a_backup_folder_cannot_be_the_default_mail_folder_or_around_or_inside_it() {
        let t = tempfile::tempdir().unwrap();
        let app_dir = dir(t.path(), "home/appdata");
        for bad in [app_dir.clone(), app_dir.join("Maildir"), t.path().join("home")] {
            let err = check_backup_folder(&app_dir, &bad).expect_err(&bad.to_string_lossy());
            assert!(err.starts_with("E_BACKUP_OVERLAPS_VAULT: "), "{err}");
        }
        check_backup_folder(&app_dir, &dir(t.path(), "drive/backup")).expect("a separate folder is fine");
    }

    #[test]
    fn a_backup_folder_is_checked_against_the_moved_mail_folder_not_the_app_dir() {
        let t = tempfile::tempdir().unwrap();
        let app_dir = dir(t.path(), "appdata");
        let vault = dir(t.path(), "drive/mail");
        save(&app_dir, "vault", &vault);
        for bad in [vault.clone(), vault.join("sub"), t.path().join("drive")] {
            let err = check_backup_folder(&app_dir, &bad).expect_err(&bad.to_string_lossy());
            assert!(err.starts_with("E_BACKUP_OVERLAPS_VAULT: "), "{err}");
        }
        check_backup_folder(&app_dir, &dir(t.path(), "drive/backup")).expect("beside the mail is fine");
        check_backup_folder(&app_dir, &dir(t.path(), "appdata/backup")).expect("the app dir no longer holds the mail");
    }

    #[test]
    fn a_mail_folder_cannot_be_the_backup_folder_or_around_or_inside_it() {
        let t = tempfile::tempdir().unwrap();
        let app_dir = dir(t.path(), "appdata");
        let backup = dir(t.path(), "drive/backup");
        save(&app_dir, "external-backup", &backup);
        for bad in [backup.clone(), backup.join("sub"), t.path().join("drive")] {
            let err = check_vault_folder(&app_dir, &bad).expect_err(&bad.to_string_lossy());
            assert!(err.starts_with("E_VAULT_OVERLAPS_BACKUP: "), "{err}");
        }
        check_vault_folder(&app_dir, &dir(t.path(), "drive/mail")).expect("beside the backup is fine");
    }

    #[test]
    fn with_no_backup_folder_any_mail_folder_is_fine() {
        let t = tempfile::tempdir().unwrap();
        let app_dir = dir(t.path(), "appdata");
        check_vault_folder(&app_dir, &dir(t.path(), "anywhere")).expect("nothing to collide with");
    }

    #[test]
    fn moving_the_mail_back_to_the_default_is_refused_when_the_backup_sits_there() {
        let t = tempfile::tempdir().unwrap();
        let app_dir = dir(t.path(), "appdata");
        save(&app_dir, "external-backup", &app_dir.join("backup"));
        let err = check_vault_folder(&app_dir, &app_dir).expect_err("the default holds the backup");
        assert!(err.starts_with("E_VAULT_OVERLAPS_BACKUP: "), "{err}");
    }
}
