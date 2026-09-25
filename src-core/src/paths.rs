//! Where MailVault keeps its data. The app and the daemon both resolve their
//! directories here, so they cannot disagree about where the other one is.
//!
//! - `app_data_dir()`: `<local data root>/com.mailvault.app`. macOS
//!   `~/Library/Application Support/com.mailvault.app` (the sandbox container's
//!   inside the sandbox), Linux `$XDG_DATA_HOME` or `~/.local/share`, Windows
//!   `%LOCALAPPDATA%` (Local, not Roaming: a mail archive must not roam).
//! - `ipc_dir()`: `<home>/.mailvault`, the socket (or the pipe's token) lives here.
//!
//! On Windows the two roots honour `LOCALAPPDATA` and `USERPROFILE` when they
//! hold an absolute path, and fall back to the known folders otherwise. In
//! every normal Windows session those variables equal the known folders, so
//! production behaviour is the known folder; the override is the Windows
//! equivalent of pointing `HOME` somewhere else on unix, which is what lets a
//! test run isolate itself. Unix is `dirs::*` unchanged (they already read
//! `HOME`/`XDG_DATA_HOME`).

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

pub const APP_IDENTIFIER: &str = "com.mailvault.app";

/// `value` when it is an absolute path, otherwise `fallback`. Pure so the
/// tests pass the env value in instead of mutating the process env.
#[cfg_attr(not(windows), allow(dead_code))]
fn env_or(value: Option<OsString>, fallback: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    value.map(PathBuf::from).filter(|p| p.is_absolute()).or_else(fallback)
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    return env_or(std::env::var_os("USERPROFILE"), dirs::home_dir);
    #[cfg(not(windows))]
    dirs::home_dir()
}

pub fn data_local_root() -> Option<PathBuf> {
    #[cfg(windows)]
    return env_or(std::env::var_os("LOCALAPPDATA"), dirs::data_local_dir);
    #[cfg(not(windows))]
    dirs::data_local_dir()
}

pub fn app_data_dir() -> io::Result<PathBuf> {
    data_local_root()
        .map(|d| d.join(APP_IDENTIFIER))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "could not resolve the local data directory"))
}

pub fn ipc_dir() -> io::Result<PathBuf> {
    home_dir()
        .map(|h| h.join(".mailvault"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "could not resolve the home directory"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn abs() -> &'static str {
        if cfg!(windows) { r"C:\iso\home" } else { "/iso/home" }
    }

    #[test]
    fn an_absolute_override_wins() {
        assert_eq!(env_or(Some(abs().into()), || Some("/fallback".into())), Some(PathBuf::from(abs())));
    }

    #[test]
    fn an_unset_empty_or_relative_override_falls_back() {
        let fb = || Some(PathBuf::from("/fallback"));
        assert_eq!(env_or(None, fb), Some(PathBuf::from("/fallback")));
        assert_eq!(env_or(Some("".into()), fb), Some(PathBuf::from("/fallback")));
        assert_eq!(env_or(Some(r"relative\dir".into()), fb), Some(PathBuf::from("/fallback")));
        // Drive-relative (`C:foo`) and rooted-without-drive (`\foo`) are not
        // absolute on Windows, so they must not win there either.
        assert_eq!(env_or(Some("C:foo".into()), fb), Some(PathBuf::from("/fallback")));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_is_the_dirs_crate_unchanged() {
        assert_eq!(home_dir(), dirs::home_dir());
        assert_eq!(data_local_root(), dirs::data_local_dir());
        assert_eq!(app_data_dir().unwrap(), dirs::data_local_dir().unwrap().join("com.mailvault.app"));
        assert_eq!(ipc_dir().unwrap(), dirs::home_dir().unwrap().join(".mailvault"));
    }

    // ── Portable mode ─────────────────────────────────────────────────────
    // Every case goes through the pure `detect_portable_root`: the process
    // env is never touched (`portable_root()` caches the live answer once).

    fn portable_root_at(parent: &Path) -> PathBuf {
        let root = parent.join(PORTABLE_DIR);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(PORTABLE_MARKER), r#"{"version":1,"createdAt":0}"#).unwrap();
        root
    }

    #[test]
    fn a_marked_folder_beside_the_binary_is_the_portable_root() {
        let drive = tempfile::tempdir().unwrap();
        let root = portable_root_at(drive.path());
        let exe = drive.path().join("MailVault.exe");
        assert_eq!(detect_portable_root(None, Some(&exe), None), Some(root));
    }

    #[test]
    fn on_macos_the_folder_sits_beside_the_app_bundle_not_inside_it() {
        let drive = tempfile::tempdir().unwrap();
        let root = portable_root_at(drive.path());
        let exe = drive.path().join("MailVault.app").join("Contents").join("MacOS").join("MailVault");
        assert_eq!(detect_portable_root(None, Some(&exe), None), Some(root));
    }

    #[test]
    fn an_appimage_looks_beside_the_appimage_file_not_its_mount() {
        let drive = tempfile::tempdir().unwrap();
        let root = portable_root_at(drive.path());
        let mount = tempfile::tempdir().unwrap();
        let exe = mount.path().join("usr").join("bin").join("mailvault");
        let appimage = drive.path().join("MailVault.AppImage");
        assert_eq!(detect_portable_root(None, Some(&exe), Some(appimage.into_os_string())), Some(root));
    }

    #[test]
    fn the_folder_needs_its_marker() {
        let drive = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(drive.path().join(PORTABLE_DIR)).unwrap();
        let exe = drive.path().join("MailVault.exe");
        assert_eq!(detect_portable_root(None, Some(&exe), None), None);
    }

    #[test]
    fn a_marker_that_is_not_ours_is_ignored() {
        let drive = tempfile::tempdir().unwrap();
        let root = drive.path().join(PORTABLE_DIR);
        std::fs::create_dir_all(&root).unwrap();
        let exe = drive.path().join("MailVault.exe");
        for bad in ["", "not json", "[]", r#"{"createdAt":1}"#, r#"{"version":"one"}"#] {
            std::fs::write(root.join(PORTABLE_MARKER), bad).unwrap();
            assert_eq!(detect_portable_root(None, Some(&exe), None), None, "marker {bad:?}");
        }
    }

    #[test]
    fn the_env_root_wins_over_the_install_location() {
        let drive = tempfile::tempdir().unwrap();
        portable_root_at(drive.path());
        let other = tempfile::tempdir().unwrap();
        let explicit = portable_root_at(other.path());
        let exe = drive.path().join("MailVault.exe");
        assert_eq!(detect_portable_root(Some(explicit.clone().into_os_string()), Some(&exe), None), Some(explicit));
    }

    #[test]
    fn an_env_root_without_a_marker_or_relative_is_ignored() {
        let drive = tempfile::tempdir().unwrap();
        let root = portable_root_at(drive.path());
        let exe = drive.path().join("MailVault.exe");
        let unmarked = tempfile::tempdir().unwrap();
        assert_eq!(detect_portable_root(Some(unmarked.path().into()), Some(&exe), None), Some(root.clone()));
        assert_eq!(detect_portable_root(Some("relative/MailVault Data".into()), Some(&exe), None), Some(root));
        assert_eq!(detect_portable_root(Some(unmarked.path().into()), None, None), None);
    }

    #[test]
    fn portable_data_lives_under_the_root() {
        let root = Path::new(abs()).join(PORTABLE_DIR);
        assert_eq!(portable_data_dir(&root), root.join("data"));
    }

    #[test]
    fn the_portable_ipc_dir_is_per_root_and_on_the_host() {
        let home = Path::new(abs());
        let a = portable_ipc_dir(home, Path::new("/Volumes/USB A/MailVault Data"));
        let b = portable_ipc_dir(home, Path::new("/Volumes/USB B/MailVault Data"));
        assert!(a.starts_with(home.join(".mailvault")), "{a:?}");
        assert_ne!(a, home.join(".mailvault"), "never the installed copy's dir");
        assert_ne!(a, b);
        assert_eq!(a, portable_ipc_dir(home, Path::new("/Volumes/USB A/MailVault Data")), "stable");
    }

    #[test]
    fn the_portable_socket_fits_sun_len_whatever_the_drive_path() {
        let home = Path::new("/Users/someone-with-a-long-name");
        let deep = format!("/Volumes/{}/MailVault Data", "very long drive folder name ".repeat(12));
        let sock = portable_ipc_dir(home, Path::new(&deep)).join("mv.sock");
        assert!(sock.as_os_str().len() < 104, "{} bytes: {sock:?}", sock.as_os_str().len());
    }

    #[cfg(windows)]
    #[test]
    fn windows_reads_the_env_the_session_sets() {
        // Reads the live env, never mutates it (a test that sets or removes a
        // process-global var races every parallel test that reads it).
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute());
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from).filter(|p| p.is_absolute());
        assert_eq!(data_local_root(), local.or_else(dirs::data_local_dir));
        assert_eq!(home_dir(), home.or_else(dirs::home_dir));
    }
}
