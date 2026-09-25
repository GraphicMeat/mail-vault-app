//! Portable mode's files: the sealed credential store on the drive.
//!
//! A portable copy writes nothing secret to the host. Account passwords,
//! OAuth tokens and the AI endpoint key live in `<root>/data/credentials.sealed`,
//! the `.mvtransfer` container (`transfer::crypto`: argon2id + XChaCha20-Poly1305)
//! around one JSON object, sealed with a passphrase the user types once per launch.

use crate::transfer::crypto::{self, Params, TransferError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

// ── Making a portable copy ──────────────────────────────────────────────────

/// The destination already holds a finished portable copy.
pub const E_EXISTS: &str = "E_PORTABLE_EXISTS";
/// This build is not something that can be copied to a drive (a distro
/// package, a dev build).
pub const E_UNSUPPORTED_BUILD: &str = "E_PORTABLE_UNSUPPORTED_BUILD";

/// What to copy so the app runs from the drive: the `.app` bundle, the
/// AppImage file, or (Windows) the install folder's files minus the host's
/// uninstaller.
pub fn app_payload(exe: &Path, appimage: Option<&Path>, windows: bool) -> Result<Vec<PathBuf>, String> {
    if let Some(bundle) = exe.ancestors().find(|a| a.extension().is_some_and(|e| e == "app")) {
        return Ok(vec![bundle.to_path_buf()]);
    }
    if let Some(img) = appimage {
        return Ok(vec![img.to_path_buf()]);
    }
    if !windows {
        return Err(E_UNSUPPORTED_BUILD.to_string());
    }
    let dir = exe.parent().ok_or_else(|| E_UNSUPPORTED_BUILD.to_string())?;
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    Ok(entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().eq_ignore_ascii_case("uninstall.exe"))
        .map(|e| e.path())
        .collect())
}

/// Copy a file or tree, recreating symlinks rather than following them: a
/// dereferenced `Versions/Current` breaks a macOS framework's signature.
/// `n` counts (files, bytes).
pub fn copy_preserving_links(src: &Path, dst: &Path, n: &mut (usize, u64)) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src).map_err(|e| format!("read {}: {e}", src.display()))?;
        let _ = std::fs::remove_file(dst);
        #[cfg(unix)]
        return std::os::unix::fs::symlink(&target, dst).map_err(|e| format!("link {}: {e}", dst.display()));
        // ponytail: Windows payloads carry no symlinks; copy the target if one ever does.
        #[cfg(not(unix))]
        return std::fs::copy(src, dst).map(|_| ()).map_err(|e| format!("copy {} ({target:?}): {e}", src.display()));
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
        for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))?.flatten() {
            copy_preserving_links(&entry.path(), &dst.join(entry.file_name()), n)?;
        }
        return Ok(());
    }
    // Checked against what was written, not the source: app data keeps
    // changing on the host while the mail copies, and the drive copy is a
    // snapshot of the moment it was taken.
    let written = std::fs::copy(src, dst).map_err(|e| format!("copy {}: {e}", src.display()))?;
    let landed = std::fs::metadata(dst).map(|m| m.len()).map_err(|e| format!("{} is missing from the drive: {e}", dst.display()))?;
    if landed != written {
        return Err(format!("{} copied as {landed} bytes, expected {written}", dst.display()));
    }
    n.0 += 1;
    n.1 += written;
    Ok(())
}

/// Every file arrived at its size, every symlink with its target.
pub fn verify_preserving_links(src: &Path, dst: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    let missing = |e: std::io::Error| format!("{} is missing from the drive: {e}", dst.display());
    if meta.file_type().is_symlink() {
        if std::fs::read_link(src).ok() != std::fs::read_link(dst).ok() {
            return Err(format!("{} did not arrive as the same link", dst.display()));
        }
        return Ok(());
    }
    if meta.is_dir() {
        for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))?.flatten() {
            verify_preserving_links(&entry.path(), &dst.join(entry.file_name()))?;
        }
        return Ok(());
    }
    let len = std::fs::metadata(dst).map_err(missing)?.len();
    if len != meta.len() {
        return Err(format!("{} copied as {len} bytes, expected {}", dst.display(), meta.len()));
    }
    Ok(())
}

/// App data entries that stay on the host: the mail (copied as the vault),
/// the live databases (snapshotted instead), and this host's process state,
/// logs and derived caches keyed by host paths.
fn stays_on_host(name: &str) -> bool {
    const HOST_ONLY: [&str; 8] = [
        "logs", "daemon.pid", "daemon.lock", "daemon.token", "mailvault.lock", "EBWebView",
        crate::app_db::db::DB_FILE, crate::vault_registry::DB_FILE,
    ];
    crate::vault_layout::VAULT_DIRS.contains(&name)
        || HOST_ONLY.contains(&name)
        || ["-wal", "-shm", "-journal"].iter().any(|s| name.ends_with(s))
}

fn tree_bytes(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| tree_bytes(&e.path())).sum(),
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    }
}

/// Roughly what `create` writes to the drive: the app, the app data it takes
/// (app.db at its file size), and the mail when it is copied.
pub fn estimate(payload: &[PathBuf], app_dir: &Path, mail_dir: Option<&Path>) -> u64 {
    let app: u64 = payload.iter().map(|p| tree_bytes(p)).sum();
    let data: u64 = std::fs::read_dir(app_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| !stays_on_host(&e.file_name().to_string_lossy()))
        .map(|e| tree_bytes(&e.path()))
        .sum();
    let db = tree_bytes(&app_dir.join(crate::app_db::db::DB_FILE));
    // Names as they are on disk: `Maildir` and `maildir` are one folder on a
    // case-insensitive volume and must not count twice.
    let mail: u64 = mail_dir
        .map(|m| {
            std::fs::read_dir(m)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| crate::vault_layout::VAULT_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
                .map(|e| tree_bytes(&e.path()))
                .sum()
        })
        .unwrap_or(0);
    app + data + db + mail
}

pub struct CreateOptions<'a> {
    /// The folder the user picked on the drive.
    pub dest: &'a Path,
    pub payload: &'a [PathBuf],
    pub app_dir: &'a Path,
    /// Accounts, settings and app.db; off, the copy starts empty.
    pub copy_config: bool,
    /// Where the mail is now; `None` leaves it behind.
    pub mail_dir: Option<&'a Path>,
    pub secrets: &'a Secrets,
    pub passphrase: &'a str,
    pub params: Params,
}

#[derive(Debug)]
pub struct Created {
    pub root: PathBuf,
    /// The vault dirs copied, for a later removal from the host.
    pub mail_dirs: Vec<&'static str>,
    pub files: usize,
    pub bytes: u64,
}

/// Copy the app, its data, the mail and the sealed secrets to `dest`, verify
/// all of it, and only then write the marker that makes it a portable root.
/// A copy that fails anywhere is left unmarked: the app never runs from it,
/// and running create again resumes it. `progress(phase, done, total)`.
pub fn create(opts: &CreateOptions, progress: &dyn Fn(&str, usize, usize)) -> Result<Created, String> {
    create_with(opts, progress, &|_| {})
}

pub(crate) fn create_with(
    opts: &CreateOptions,
    progress: &dyn Fn(&str, usize, usize),
    before_verify: &dyn Fn(&Path),
) -> Result<Created, String> {
    use crate::paths::{is_portable_root, portable_data_dir, PORTABLE_DIR, PORTABLE_MARKER};
    let root = opts.dest.join(PORTABLE_DIR);
    if is_portable_root(&root) {
        return Err(format!("{E_EXISTS}: {}", root.display()));
    }
    // A copy into the data it copies would walk into itself.
    if opts.dest.starts_with(opts.app_dir) || opts.mail_dir.is_some_and(|m| opts.dest.starts_with(m)) {
        return Err("Choose a folder outside MailVault's own data and mail folders.".to_string());
    }
    let data = portable_data_dir(&root);
    std::fs::create_dir_all(&data).map_err(|e| format!("mkdir {}: {e}", data.display()))?;
    let mut n = (0usize, 0u64);

    progress("app", 0, opts.payload.len());
    for (i, item) in opts.payload.iter().enumerate() {
        let name = item.file_name().ok_or_else(|| format!("{} has no name", item.display()))?;
        copy_preserving_links(item, &opts.dest.join(name), &mut n)?;
        progress("app", i + 1, opts.payload.len());
    }

    if opts.copy_config {
        progress("settings", 0, 1);
        for entry in std::fs::read_dir(opts.app_dir).map_err(|e| format!("read {}: {e}", opts.app_dir.display()))?.flatten() {
            let name = entry.file_name();
            if !stays_on_host(&name.to_string_lossy()) {
                copy_preserving_links(&entry.path(), &data.join(&name), &mut n)?;
            }
        }
        // A live WAL database is never copied raw: a snapshot through SQLite.
        let db = data.join(crate::app_db::db::DB_FILE);
        let _ = std::fs::remove_file(&db); // a previous, unmarked attempt's
        crate::app_db::with(opts.app_dir, |c| {
            c.execute("VACUUM INTO ?1", [db.to_string_lossy()]).map(|_| ()).map_err(|e| format!("snapshot app.db: {e}"))
        })?;
        // Host folders mean nothing on another computer: the copy keeps its
        // mail in its own data dir, and backups are set up again there.
        let conn = crate::app_db::db::open(&data).map_err(|e| e.to_string())?;
        crate::app_db::locations::clear(&conn, "vault")?;
        crate::app_db::locations::clear(&conn, "external-backup")?;
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err(format!("the copied app.db failed its integrity check: {check}"));
        }
        progress("settings", 1, 1);
    }

    let mut mail_dirs = Vec::new();
    if let Some(mail) = opts.mail_dir {
        let (present, files, bytes) = crate::vault_ops::copy_and_verify(mail, &data, &|p| progress("mail", p.copied, p.total))?;
        mail_dirs = present;
        n.0 += files;
        n.1 += bytes;
    }

    write_sealed(&data.join(SEALED_FILE), opts.passphrase, opts.secrets, opts.params)?;

    before_verify(&data);
    progress("verifying", 0, 1);
    for item in opts.payload {
        verify_preserving_links(item, &opts.dest.join(item.file_name().unwrap_or_default()))?;
    }
    // The vault is closed while this runs, so the mail can be held to its
    // source; app data was checked as it landed.
    if let Some(mail) = opts.mail_dir {
        for dir in &mail_dirs {
            crate::vault_ops::verify_tree(&mail.join(dir), &data.join(dir))?;
        }
    }
    if read_sealed(&data.join(SEALED_FILE), opts.passphrase)? != *opts.secrets {
        return Err("the sealed credentials did not read back".to_string());
    }

    let marker = serde_json::json!({"version": 1, "createdAt": crate::vault_layout::now_millis()});
    std::fs::write(root.join(PORTABLE_MARKER), marker.to_string()).map_err(|e| format!("write marker: {e}"))?;
    progress("verifying", 1, 1);
    Ok(Created { root, mail_dirs, files: n.0, bytes: n.1 })
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
        std::fs::write(cur.join(format!("1.eml{}S", crate::maildir::INFO_PREFIX)), b"From: a@example.com\r\n\r\nhello").unwrap();
        let dest = tmp.path().join("USB");
        std::fs::create_dir_all(&dest).unwrap();
        Host { app_dir, payload: vec![app], dest, _tmp: tmp }
    }

    fn opts<'a>(h: &'a Host, copy_mail: bool, secrets: &'a Secrets) -> CreateOptions<'a> {
        CreateOptions {
            dest: &h.dest,
            payload: &h.payload,
            app_dir: &h.app_dir,
            copy_config: true,
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
        assert!(data.join(format!("Maildir/acct/INBOX/cur/1.eml{}S", crate::maildir::INFO_PREFIX)).exists());
        assert!(!data.join("daemon.pid").exists(), "host process state stays behind");
        assert!(!data.join("logs").exists());
        assert_eq!(read_sealed(&data.join(SEALED_FILE), "drive passphrase").unwrap(), s);

        // The copied app.db is a consistent snapshot, and no longer points
        // the vault at a folder on the host.
        let conn = crate::app_db::db::open(&data).unwrap();
        assert_eq!(crate::app_db::locations::display_path(&conn, "vault"), None);
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        assert!(created.mail_dirs.contains(&"Maildir"), "{:?}", created.mail_dirs);
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
    fn without_the_configuration_nothing_of_the_host_setup_travels() {
        let h = host();
        let s = Secrets::default();
        let o = CreateOptions { copy_config: false, ..opts(&h, false, &s) };
        create(&o, &|_, _, _| {}).unwrap();
        let data = portable_data_dir(&h.dest.join(PORTABLE_DIR));
        assert!(!data.join("frontend-settings.json").exists());
        assert!(!data.join("app.db").exists(), "the portable copy starts its own");
        assert!(is_portable_root(&h.dest.join(PORTABLE_DIR)));
    }

    #[test]
    fn a_destination_inside_the_data_being_copied_is_refused() {
        // The copy would walk into itself.
        let h = host();
        let s = secrets();
        let inside = h.app_dir.join("USB");
        std::fs::create_dir_all(&inside).unwrap();
        let o = CreateOptions { dest: &inside, ..opts(&h, true, &s) };
        assert!(create(&o, &|_, _, _| {}).is_err());
        assert!(!inside.join(PORTABLE_DIR).exists(), "refused before anything is written");
    }

    #[test]
    fn the_estimate_counts_what_create_copies_and_nothing_it_leaves() {
        // Plain files, no live database: sizes are exact.
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("MailVault.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("MailVault"), b"binary").unwrap();
        let app_dir = tmp.path().join("host");
        std::fs::create_dir_all(app_dir.join("logs")).unwrap();
        std::fs::create_dir_all(app_dir.join("Maildir/cur")).unwrap();
        std::fs::write(app_dir.join("app.db"), vec![0u8; 4096]).unwrap();
        std::fs::write(app_dir.join("app.db-wal"), vec![0u8; 100]).unwrap();
        std::fs::write(app_dir.join("frontend-settings.json"), b"{}").unwrap();
        std::fs::write(app_dir.join("daemon.pid"), b"123").unwrap();
        std::fs::write(app_dir.join("logs/daemon.log"), b"log").unwrap();
        std::fs::write(app_dir.join(format!("Maildir/cur/1.eml{}S", crate::maildir::INFO_PREFIX)), b"hello").unwrap();
        let payload = vec![app];
        // pid file, logs and the WAL stay on the host; app.db counts at its file size.
        assert_eq!(estimate(&payload, &app_dir, Some(&app_dir)), 6 + 4096 + 2 + 5);
        assert_eq!(estimate(&payload, &app_dir, None), 6 + 4096 + 2);
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
            std::fs::write(data.join(format!("Maildir/acct/INBOX/cur/1.eml{}S", crate::maildir::INFO_PREFIX)), b"trunc").unwrap();
        };
        let err = create_with(&opts(&h, true, &s), &|_, _, _| {}, &truncate).unwrap_err();
        assert!(err.contains("1.eml"), "{err}");
        assert!(!is_portable_root(&root), "no marker: the drive copy is not used");
        assert!(h.app_dir.join(format!("Maildir/acct/INBOX/cur/1.eml{}S", crate::maildir::INFO_PREFIX)).exists(), "the host copy is untouched");
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
