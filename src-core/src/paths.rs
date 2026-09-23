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
