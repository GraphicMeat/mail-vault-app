//! One endpoint, two implementations.
//!
//! On unix the app and the daemon talk over a unix domain socket under
//! `~/.mailvault`. Windows has no such thing, so the same conversation — the
//! same token handshake, the same line-delimited JSON — runs over a named pipe
//! at `\\.\pipe\mailvault-<user>`. Nothing above this module knows which.
//!
//! The endpoint stays a `PathBuf` on both platforms: Win32 accepts a pipe name
//! as a path for `CreateFile`, so no signature above here has to change. What
//! does change is that a pipe name is **not a filesystem entry** — `exists()`
//! is not a liveness test, which is what `is_listening` is for.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Win32 `ERROR_PIPE_BUSY`: the pipe exists but every instance is in use.
/// A busy pipe means the daemon is **up**, not absent.
pub const PIPE_BUSY: i32 = 231;

/// The endpoint the app and the daemon meet on. `ipc_dir` is `~/.mailvault`,
/// which both processes already resolve identically; on Windows it is used
/// only for the token file that sits beside the (nameless) pipe.
#[cfg(unix)]
pub fn endpoint(ipc_dir: &Path) -> PathBuf {
    ipc_dir.join("mv.sock")
}

/// Per-user, because the named-pipe namespace is machine-global and two users
/// logged into one machine would otherwise fight over one pipe. `USERNAME` is
/// set for every interactive Windows session; the fallback only matters for a
/// service context that does not have one, where a single shared name is still
/// better than a panic.
#[cfg(windows)]
pub fn endpoint(_ipc_dir: &Path) -> PathBuf {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    PathBuf::from(format!(r"\\.\pipe\mailvault-{}", windows_pipe_name(&user)))
}

/// FNV-1a over the raw bytes. Not `std::collections::hash_map::DefaultHasher`:
/// its output is explicitly unspecified across Rust versions, and the app and
/// the daemon are two separately compiled binaries that must land on the same
/// pipe name from the same username, so the hash has to be a fixed algorithm,
/// not "whatever this toolchain happens to do today".
#[cfg(any(windows, test))]
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// The sanitized username, for readability, plus a hex hash of the *raw*
/// username, for correctness: periods and spaces are legal in Windows account
/// names and the sanitizer strips both, so `bob.smith` and `bobsmith` — or
/// `John Doe` and `JohnDoe` — would otherwise sanitize to the same string and
/// collide on one pipe. The second user to connect would then be talking to
/// the first user's daemon, get its own token rejected, and see a permanently
/// unreachable daemon indistinguishable from "not running". Compiled outside
/// `cfg(windows)` too (see the `cfg` on this and `fnv1a`) so the collision
/// case can be asserted on darwin.
#[cfg(any(windows, test))]
fn windows_pipe_name(user: &str) -> String {
    let safe: String = user.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    let safe = if safe.is_empty() { "default".to_string() } else { safe };
    format!("{safe}-{:x}", fnv1a(user.as_bytes()))
}

/// Is a daemon serving this endpoint right now?
#[cfg(unix)]
pub fn is_listening(endpoint: &Path) -> bool {
    endpoint.exists()
}

/// **Does not connect.** `\\.\pipe\` is an enumerable directory on Windows, so
/// the question "is that pipe there" is answered by listing it — no handle, no
/// instance consumed, no connection for the daemon to accept and discard.
///
/// This matters more than it looks. The daemon keeps one unconnected instance
/// waiting at a time (`server::run`), and the app polls this function in the
/// two wait loops inside `ensure_daemon_socket` (`src-tauri/src/main.rs`). A
/// probe that *opened* the pipe would eat
/// that instance on every poll, spawn a handler task for a client that says
/// nothing, and — in the window between the daemon's `connect()` returning and
/// its next `create()` — a following probe would find no instance and report
/// the daemon **down** while it is alive. The app's answer to "down" is to
/// spawn a second daemon.
///
/// The open-based probe is kept only as a fallback for the case where the pipe
/// directory cannot be listed at all, where `ERROR_PIPE_BUSY` still proves the
/// name is taken and therefore that a daemon holds it.
#[cfg(windows)]
pub fn is_listening(endpoint: &Path) -> bool {
    let Some(name) = endpoint.file_name() else { return false };
    match std::fs::read_dir(r"\\.\pipe\") {
        Ok(entries) => return entries.flatten().any(|e| e.file_name() == name),
        Err(e) => {
            // The happy path just stopped working silently otherwise: this
            // branch falls through to the open-based probe the design review
            // rejected for routine use (it consumes the daemon's one waiting
            // instance). Nothing else marks that a Windows build is on the
            // fallback path instead of the enumeration one, so a first
            // tester on a machine where this errors would have no way to
            // tell the two modes apart without this line.
            tracing::warn!("transport::is_listening: read_dir(\\\\.\\pipe\\) failed, falling back to an open probe: {e}");
        }
    }
    match std::fs::OpenOptions::new().read(true).write(true).open(endpoint) {
        Ok(_) => true,
        Err(e) => e.raw_os_error() == Some(PIPE_BUSY),
    }
}

/// A blocking client connection, split into the two halves `daemon_ipc` wants.
#[cfg(unix)]
pub fn connect_sync(endpoint: &Path, timeout: Duration) -> std::io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    let stream = std::os::unix::net::UnixStream::connect(endpoint)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let writer = stream.try_clone()?;
    Ok((Box::new(stream), Box::new(writer)))
}

/// A named-pipe client is an ordinary file handle opened on the pipe name, so
/// `File` gives both halves with `try_clone`.
///
/// `timeout` is unused here and that is a real difference from unix: a pipe
/// handle has no per-read deadline without overlapped IO. `daemon_ipc::call`
/// puts the deadline back at a level above (see its Windows arm), so no caller
/// loses the timeout — but do not "simplify" that arm away.
#[cfg(windows)]
pub fn connect_sync(endpoint: &Path, _timeout: Duration) -> std::io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    let file = std::fs::OpenOptions::new().read(true).write(true).open(endpoint)?;
    let writer = file.try_clone()?;
    Ok((Box::new(file), Box::new(writer)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_endpoint_is_a_socket_file_on_unix_and_a_pipe_name_on_windows() {
        let ep = endpoint(Path::new("/home/u/.mailvault"));
        if cfg!(windows) {
            let s = ep.to_string_lossy().to_string();
            assert!(s.starts_with(r"\\.\pipe\mailvault-"), "{s}");
            // The pipe namespace is machine-global, so the name must be
            // per-user or two logged-in users collide.
            assert_ne!(s, r"\\.\pipe\mailvault-");
        } else {
            assert_eq!(ep, Path::new("/home/u/.mailvault/mv.sock"));
        }
    }

    #[test]
    fn nothing_is_listening_on_a_name_nobody_created() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_listening(&dir.path().join("mv.sock")));
    }

    #[cfg(unix)]
    #[test]
    fn a_bound_socket_is_listening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mv.sock");
        let _l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        assert!(is_listening(&path));
    }

    #[test]
    fn two_usernames_that_sanitize_identically_still_get_different_pipe_names() {
        // Periods and spaces are legal in Windows account names and the
        // sanitizer strips both, so these pairs collide after sanitizing —
        // the raw-username hash is what has to keep them apart.
        assert_ne!(windows_pipe_name("bob.smith"), windows_pipe_name("bobsmith"));
        assert_ne!(windows_pipe_name("John Doe"), windows_pipe_name("JohnDoe"));
    }
}
