//! Portable mode's files: the sealed credential store on the drive.
//!
//! A portable copy writes nothing secret to the host. Account passwords,
//! OAuth tokens and the AI endpoint key live in `<root>/data/credentials.sealed`,
//! the `.mvtransfer` container (`transfer::crypto`: argon2id + XChaCha20-Poly1305)
//! around one JSON object, sealed with a passphrase the user types once per launch.

use crate::transfer::crypto::{self, Params, TransferError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use zeroize::Zeroizing;

pub const SEALED_FILE: &str = "credentials.sealed";
/// Wrong passphrase or a modified file; deliberately one answer for both.
pub const E_PASSPHRASE: &str = "E_PORTABLE_PASSPHRASE";

/// What the host keychain holds in an installed copy.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    /// `{ accountId: JSON-string-of-account }`, the keychain blob's shape.
    pub credentials: HashMap<String, String>,
    #[serde(default)]
    pub ai_endpoint_key: Option<String>,
}

/// Seal `secrets` into `path`, whole or not at all (temp file + rename).
pub fn write_sealed(path: &Path, passphrase: &str, secrets: &Secrets, params: Params) -> Result<(), String> {
    let plain = Zeroizing::new(serde_json::to_vec(secrets).map_err(|e| e.to_string())?);
    let sealed = crypto::encrypt_with(passphrase, &plain, params).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("sealed-writing");
    std::fs::write(&tmp, sealed).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

pub fn read_sealed(path: &Path, passphrase: &str) -> Result<Secrets, String> {
    let data = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let plain = Zeroizing::new(crypto::decrypt(passphrase, &data).map_err(|e| match e {
        TransferError::Decrypt => E_PASSPHRASE.to_string(),
        other => other.to_string(),
    })?);
    serde_json::from_slice(&plain).map_err(|e| format!("sealed store unreadable: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::crypto::{Params, MIN_M_KIB};

    const CHEAP: Params = Params { m_kib: MIN_M_KIB, t: 1, p: 1 };

    fn secrets() -> Secrets {
        let mut credentials = std::collections::HashMap::new();
        credentials.insert("acct-1".to_string(), r#"{"email":"a@example.com","password":"hunter2"}"#.to_string());
        Secrets { credentials, ai_endpoint_key: Some("sk-1".to_string()) }
    }

    #[test]
    fn a_sealed_store_reads_back_with_its_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        assert_eq!(read_sealed(&path, "correct horse").unwrap(), secrets());
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from(SEALED_FILE)], "no temp file left behind");
    }

    #[test]
    fn the_file_holds_no_secret_in_the_clear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        let raw = std::fs::read(&path).unwrap();
        for needle in [&b"hunter2"[..], b"a@example.com", b"sk-1"] {
            assert!(!raw.windows(needle.len()).any(|w| w == needle));
        }
    }

    #[test]
    fn a_wrong_passphrase_is_refused_with_its_own_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        let err = read_sealed(&path, "wrong horse").unwrap_err();
        assert!(err.starts_with(E_PASSPHRASE), "{err}");
    }

    #[test]
    fn a_tampered_store_is_refused_like_a_wrong_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        let mut raw = std::fs::read(&path).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        std::fs::write(&path, raw).unwrap();
        assert!(read_sealed(&path, "correct horse").unwrap_err().starts_with(E_PASSPHRASE));
    }

    // ── Making a portable copy ───────────────────────────────────────────

    use crate::paths::{is_portable_root, portable_data_dir, PORTABLE_DIR};
    use std::path::{Path, PathBuf};

    struct Host {
        _tmp: tempfile::TempDir,
        app_dir: PathBuf,
        payload: Vec<PathBuf>,
        dest: PathBuf,
    }

    /// A host with a stub app bundle, app data (a live app.db with the vault
    /// pointed at a host folder, settings, a pid file, logs) and mail in the
    /// app data dir (the default vault location).
    fn host() -> Host {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("Applications").join("MailVault.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/MailVault"), b"binary").unwrap();
        let app_dir = tmp.path().join("host-data");
        crate::app_db::with(&app_dir, |c| crate::app_db::locations::save_meta(c, "vault", "/Volumes/Old/mail", "macos", 1, false)).unwrap();
        std::fs::write(app_dir.join("frontend-settings.json"), b"{\"theme\":\"dark\"}").unwrap();
        std::fs::write(app_dir.join("daemon.pid"), b"123").unwrap();
        std::fs::create_dir_all(app_dir.join("logs")).unwrap();
        std::fs::write(app_dir.join("logs/daemon.log"), b"log").unwrap();
        let cur = app_dir.join("Maildir/acct/INBOX/cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join("1.eml:2,S"), b"From: a@example.com\r\n\r\nhello").unwrap();
        let dest = tmp.path().join("USB");
        std::fs::create_dir_all(&dest).unwrap();
        Host { app_dir, payload: vec![app], dest, _tmp: tmp }
    }

    fn opts<'a>(h: &'a Host, copy_mail: bool, secrets: &'a Secrets) -> CreateOptions<'a> {
        CreateOptions {
            dest: &h.dest,
            payload: &h.payload,
            app_dir: &h.app_dir,
            mail_dir: copy_mail.then_some(h.app_dir.as_path()),
            secrets,
            passphrase: "drive passphrase",
            params: CHEAP,
        }
    }

    #[test]
    fn create_copies_the_app_data_mail_and_sealed_secrets_then_marks_the_root() {
        let h = host();
        let s = secrets();
        let created = create(&opts(&h, true, &s), &|_, _, _| {}).unwrap();

        let root = h.dest.join(PORTABLE_DIR);
        assert_eq!(created.root, root);
        assert!(is_portable_root(&root), "the marker is written");
        assert!(h.dest.join("MailVault.app/Contents/MacOS/MailVault").exists(), "the app sits beside the data");

        let data = portable_data_dir(&root);
        assert_eq!(std::fs::read(data.join("frontend-settings.json")).unwrap(), b"{\"theme\":\"dark\"}");
        assert!(data.join("Maildir/acct/INBOX/cur/1.eml:2,S").exists());
        assert!(!data.join("daemon.pid").exists(), "host process state stays behind");
        assert!(!data.join("logs").exists());
        assert_eq!(read_sealed(&data.join(SEALED_FILE), "drive passphrase").unwrap(), s);

        // The copied app.db is a consistent snapshot, and no longer points
        // the vault at a folder on the host.
        let conn = crate::app_db::open(&data).unwrap();
        assert_eq!(crate::app_db::locations::display_path(&conn, "vault"), None);
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        assert_eq!(created.mail_dirs, vec!["Maildir"]);
    }

    #[test]
    fn without_mail_only_the_configuration_travels() {
        let h = host();
        let s = Secrets::default();
        create(&opts(&h, false, &s), &|_, _, _| {}).unwrap();
        let data = portable_data_dir(&h.dest.join(PORTABLE_DIR));
        assert!(data.join("frontend-settings.json").exists());
        assert!(!data.join("Maildir").exists());
    }

    #[test]
    fn a_finished_portable_copy_is_never_overwritten() {
        let h = host();
        let s = secrets();
        create(&opts(&h, false, &s), &|_, _, _| {}).unwrap();
        let err = create(&opts(&h, false, &s), &|_, _, _| {}).unwrap_err();
        assert!(err.starts_with(E_EXISTS), "{err}");
    }

    #[test]
    fn a_copy_that_does_not_verify_is_never_marked_portable() {
        let h = host();
        let s = secrets();
        let root = h.dest.join(PORTABLE_DIR);
        let truncate = |data: &Path| {
            std::fs::write(data.join("Maildir/acct/INBOX/cur/1.eml:2,S"), b"trunc").unwrap();
        };
        let err = create_with(&opts(&h, true, &s), &|_, _, _| {}, &truncate).unwrap_err();
        assert!(err.contains("1.eml"), "{err}");
        assert!(!is_portable_root(&root), "no marker: the drive copy is not used");
        assert!(h.app_dir.join("Maildir/acct/INBOX/cur/1.eml:2,S").exists(), "the host copy is untouched");
    }

    #[cfg(unix)]
    #[test]
    fn the_app_copy_keeps_symlinks_as_symlinks() {
        // A dereferenced `Versions/Current` breaks a framework's code signature.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("Sparkle.framework");
        std::fs::create_dir_all(src.join("Versions/B")).unwrap();
        std::fs::write(src.join("Versions/B/Sparkle"), b"lib").unwrap();
        std::os::unix::fs::symlink("B", src.join("Versions/Current")).unwrap();
        let dst = tmp.path().join("copy/Sparkle.framework");
        let mut n = (0, 0);
        copy_preserving_links(&src, &dst, &mut n).unwrap();
        let link = dst.join("Versions/Current");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_link(&link).unwrap(), PathBuf::from("B"));
        verify_preserving_links(&src, &dst).unwrap();
    }

    #[test]
    fn the_app_payload_follows_the_packaging() {
        let bundle = Path::new("/Applications/MailVault.app");
        assert_eq!(app_payload(&bundle.join("Contents/MacOS/mailvault-daemon"), None, false).unwrap(), vec![bundle.to_path_buf()]);
        let img = Path::new("/home/u/MailVault.AppImage");
        assert_eq!(app_payload(Path::new("/tmp/.mount_x/usr/bin/mailvault-daemon"), Some(img), false).unwrap(), vec![img.to_path_buf()]);
        // A distro package's binary sits among the system's: nothing to copy.
        assert!(app_payload(Path::new("/usr/bin/mailvault-daemon"), None, false).is_err());

        let tmp = tempfile::tempdir().unwrap();
        for name in ["MailVault.exe", "mailvault-daemon.exe", "uninstall.exe"] {
            std::fs::write(tmp.path().join(name), b"x").unwrap();
        }
        let mut names: Vec<_> = app_payload(&tmp.path().join("mailvault-daemon.exe"), None, true)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["MailVault.exe", "mailvault-daemon.exe"], "the host's uninstaller stays behind");
    }

    #[test]
    fn a_missing_store_is_not_a_wrong_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_sealed(&dir.path().join(SEALED_FILE), "correct horse").unwrap_err();
        assert!(!err.starts_with(E_PASSPHRASE), "{err}");
    }
}
