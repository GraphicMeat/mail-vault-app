//! Daemon process lifecycle: spawn, verify, stop, and the blocking RPC helper.

use super::*;

// ── Daemon RPC proxy ────────────────────────────────────────────────────────
// Bridges frontend invoke() calls to the mailvault-daemon Unix socket.
// In on-demand mode, auto-spawns the daemon if the socket isn't reachable.

/// Tracks a daemon child process spawned in on-demand mode.
pub(crate) static DAEMON_CHILD: LazyLock<Mutex<Option<std::process::Child>>> = LazyLock::new(|| Mutex::new(None));

/// Serializes daemon stop/verify/restart (`ensure_daemon_running`, `stop_daemon`)
/// against a concurrent `daemon_rpc` auto-spawn, so a build-mismatch restart and
/// an on-demand spawn from another request can never race each other.
/// Lock order: LIFECYCLE then CHILD — always take this one first; never take it
/// while already holding `DAEMON_CHILD`. `ensure_daemon_socket` only ever
/// takes CHILD alone, nested inside a caller that already holds LIFECYCLE.
/// `shutdown_daemon_child` also only ever takes CHILD alone, but is not
/// always nested inside LIFECYCLE: `stop_daemon` holds LIFECYCLE across it,
/// while `RunEvent::Exit` calls it bare at app shutdown — `APP_EXITING`,
/// not this lock, is what guards that path against a concurrent spawn.
pub(crate) static DAEMON_LIFECYCLE: Mutex<()> = Mutex::new(());

/// Set for the whole window a vault handler holds the index closed and is
/// copying/moving files (spec addendum D / C4): a crash or restart mid-move
/// must not let a reconnecting channel spawn a fresh daemon onto the root
/// being moved. Only `DaemonSuspended`'s constructor/`Drop` touch this.
pub(crate) static DAEMON_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// RAII guard for `DAEMON_SUSPENDED`. `Drop` clears the flag unconditionally
/// (including when dropped while unwinding from a panic), so a crashed vault
/// handler never leaves the daemon permanently unspawnable.
pub(crate) struct DaemonSuspended;

impl Drop for DaemonSuspended {
    fn drop(&mut self) {
        DAEMON_SUSPENDED.store(false, Ordering::SeqCst);
    }
}

/// Only the four vault handlers below call this, for exactly the window
/// between closing the index and either restarting the daemon (success) or
/// reopening the index (failure).
pub(crate) fn suspend_daemon() -> DaemonSuspended {
    DAEMON_SUSPENDED.store(true, Ordering::SeqCst);
    DaemonSuspended
}

/// Pure decision (addendum D.2): may `ensure_daemon_socket` spawn a fresh
/// daemon right now? False while a vault handler holds `DAEMON_SUSPENDED`.
pub(crate) fn may_spawn_daemon() -> bool {
    !DAEMON_SUSPENDED.load(Ordering::SeqCst)
}

/// Set at the very start of `RunEvent::Exit`, before `daemon_channel::stop()`
/// and `shutdown_daemon_child()` run. A reconnect attempt already blocked
/// inside `ensure_daemon_running` (e.g. behind `DAEMON_LIFECYCLE` held by a
/// vault-switch restart) can still be running after `shutdown_daemon_child()`
/// has released `DAEMON_CHILD` — this flag is what stops `ensure_daemon_socket`
/// from spawning a fresh orphan daemon in that window, checked right before
/// the spawn while still holding `DAEMON_CHILD` (no new lock, same order).
pub(crate) static APP_EXITING: AtomicBool = AtomicBool::new(false);

/// A daemon process id. `libc::pid_t` on unix; on Windows a pid is a DWORD and
/// `std::process::Child::id()` already returns it as a `u32`.
#[cfg(unix)]
pub(crate) type DaemonPid = libc::pid_t;
#[cfg(windows)]
pub(crate) type DaemonPid = u32;

/// Our own on-demand child's pid right now, if we have one. Locks `DAEMON_CHILD`
/// just long enough to read it — never held across a wait.
pub(crate) fn daemon_child_pid() -> Option<DaemonPid> {
    DAEMON_CHILD.lock().ok()?.as_ref().map(|c| c.id() as DaemonPid)
}

/// `<home>/.mailvault/{mv.sock, mv.token}` from `mailvault_core::paths::ipc_dir`,
/// the same resolver src-daemon's `ipc_dir()` uses. Inside the sandbox the
/// home is the container home, the same for app and daemon.
pub(crate) fn daemon_ipc_paths() -> Result<(PathBuf, PathBuf), String> {
    let dir = mailvault_core::paths::ipc_dir().map_err(|e| e.to_string())?;
    Ok((mailvault_core::transport::endpoint(&dir), dir.join("mv.token")))
}

/// Path to the daemon's PID file. This is NOT under `daemon_ipc_paths()`'s
/// `~/.mailvault`: the daemon writes it into the app data dir
/// (src-daemon/src/main.rs `get_data_dir()` + `write_pid_file`), which both
/// processes resolve through `mailvault_core::paths::app_data_dir`.
pub(crate) fn daemon_pid_path() -> PathBuf {
    mailvault_core::paths::app_data_dir()
        .unwrap_or_else(|_| PathBuf::from(".").join(mailvault_core::paths::APP_IDENTIFIER))
        .join("daemon.pid")
}

/// Parse a PID file's content: a bare integer, optionally with surrounding
/// whitespace (`write_pid_file` writes no newline, but don't depend on that).
/// Anything else — empty, garbage, negative, non-numeric — is not a pid we
/// trust enough to signal.
pub(crate) fn parse_daemon_pid(content: &str) -> Option<DaemonPid> {
    content.trim().parse::<DaemonPid>().ok().filter(|&pid| pid > 0)
}

pub(crate) fn read_daemon_pid_file(path: &Path) -> Option<DaemonPid> {
    parse_daemon_pid(&std::fs::read_to_string(path).ok()?)
}

/// True if `file_name` names the daemon binary. Tolerates the " (deleted)"
/// suffix Linux appends to `/proc/<pid>/exe`'s readlink target once a package
/// upgrade replaces the file backing an already-running process, and a
/// trailing `.exe` (case-insensitively) — Windows always has one, and
/// `tasklist` reports the shipped filename.
pub(crate) fn is_daemon_exe_name(file_name: &str) -> bool {
    let name = file_name.strip_suffix(" (deleted)").unwrap_or(file_name);
    // `name[name.len() - 4..]` would be a byte-index slice and panics when
    // that index lands inside a multi-byte character (e.g. a CJK-named
    // binary reusing a stale pid). `str::get` returns `None` instead of
    // panicking when the index isn't a char boundary, and a boundary valid
    // for the tail slice is equally valid for the matching head slice below.
    let has_exe_suffix = name.len() >= 4 && name.get(name.len() - 4..).is_some_and(|suffix| suffix.eq_ignore_ascii_case(".exe"));
    let name = if has_exe_suffix { &name[..name.len() - 4] } else { name };
    name == "mailvault-daemon"
}

/// True only if `pid` is a running process whose executable is named
/// `mailvault-daemon` — never signal a pid before confirming this: a stale
/// pid file naming a since-reused pid must not kill an unrelated process.
#[cfg(target_os = "macos")]
pub(crate) fn pid_is_mailvault_daemon(pid: DaemonPid) -> bool {
    let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is sized exactly to Apple's documented
    // PROC_PIDPATHINFO_MAXSIZE; proc_pidpath writes at most buf.len() bytes
    // and returns the byte count written, or -1 on error (no such pid, etc).
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut _, buf.len() as u32) };
    if n <= 0 {
        return false;
    }
    std::str::from_utf8(&buf[..n as usize])
        .ok()
        .and_then(|s| Path::new(s).file_name())
        .and_then(|n| n.to_str())
        .is_some_and(is_daemon_exe_name)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn pid_is_mailvault_daemon(pid: DaemonPid) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|p| p.file_name().and_then(|n| n.to_str().map(str::to_owned)))
        .is_some_and(|s| is_daemon_exe_name(&s))
}

/// This app is `windows_subsystem = "windows"` in release, so any child we
/// spawn that is itself a console-subsystem binary (`tasklist`, `taskkill`)
/// would otherwise allocate and flash a fresh console window. `CREATE_NO_WINDOW`
/// (0x08000000) suppresses that, std-only, no new dependency.
#[cfg(windows)]
pub(crate) fn suppress_console_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Shared `tasklist /FI "PID eq <pid>" /FO CSV /NH` invocation behind
/// `pid_is_mailvault_daemon` and `pid_is_dead`, both of which are polled in
/// tight loops so this runs often enough that the console-suppression above
/// matters.
#[cfg(windows)]
pub(crate) fn tasklist_for_pid(pid: DaemonPid) -> std::io::Result<std::process::Output> {
    let mut cmd = std::process::Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    suppress_console_window(&mut cmd);
    cmd.output()
}

/// Windows has no `proc_pidpath`/`/proc`; shell out to `tasklist` and read the
/// image name off its one CSV row for `pid`, the same approach `main.rs`
/// already uses for `get_os_version` (`cmd /C ver`) and reveal-in-Explorer.
#[cfg(windows)]
pub(crate) fn pid_is_mailvault_daemon(pid: DaemonPid) -> bool {
    // Treat any failure to even run `tasklist` as "not the daemon" — this
    // guards an irreversible kill, so "unsure" must mean "do not kill".
    let Ok(output) = tasklist_for_pid(pid) else {
        return false;
    };
    // No match: `tasklist` prints an `INFO:`-prefixed line (still exit 0)
    // instead of a data row. That line has no quoted first field, so it fails
    // the strip_prefix/strip_suffix below and this correctly reports false.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .and_then(|line| line.split(',').next())
        .and_then(|field| field.strip_prefix('"'))
        .and_then(|field| field.strip_suffix('"'))
        .is_some_and(is_daemon_exe_name)
}

/// `kill(pid, 0)` sends no signal, only checks whether the process exists (and
/// is ours to signal). ESRCH means it is gone; any other outcome (alive, or
/// EPERM because it's alive but owned by someone else) is not "dead".
#[cfg(unix)]
pub(crate) fn pid_is_dead(pid: DaemonPid) -> bool {
    // SAFETY: signal 0 is documented as a pure existence/permission check —
    // it never actually signals the process.
    let ret = unsafe { libc::kill(pid, 0) };
    ret == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Same `tasklist` query as `pid_is_mailvault_daemon`, without the image-name
/// check: dead when there is no CSV row for `pid` at all.
///
/// Note the asymmetry with unix: `kill(pid, 0)` returning EPERM means
/// alive-but-not-ours, whereas `tasklist` shows processes across every user
/// session, so this arm is if anything more willing to say "alive" than
/// unix's check — which is the safe direction for a function whose answer
/// gates a kill. A failure to run `tasklist` at all is treated the same way:
/// "not dead", so callers keep waiting/escalating instead of concluding the
/// orphan is already gone.
#[cfg(windows)]
pub(crate) fn pid_is_dead(pid: DaemonPid) -> bool {
    let Ok(output) = tasklist_for_pid(pid) else {
        return false;
    };
    !String::from_utf8_lossy(&output.stdout).lines().next().is_some_and(|line| line.starts_with('"'))
}

/// The sidecar's filename. Tauri appends `.exe` on Windows when it installs the
/// external binary, so the search has to look for the same name it shipped.
pub(crate) const DAEMON_EXE: &str = if cfg!(windows) { "mailvault-daemon.exe" } else { "mailvault-daemon" };

/// Find the daemon binary. Checks next to the app binary first, then common build paths.
pub(crate) fn find_daemon_binary(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Next to the Tauri app binary (release layout)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(DAEMON_EXE);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Cargo workspace target directories (dev mode)
    let workspace_root = app_handle
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| p.parent().map(|pp| pp.to_path_buf()));

    for base in [
        workspace_root,
        std::env::current_dir().ok(),
    ].into_iter().flatten() {
        for profile in ["debug", "release"] {
            let candidate = base.join("target").join(profile).join(DAEMON_EXE);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

/// The `--daemon-only` launcher: start the sidecar and return, leaving it
/// running as an orphan that init adopts.
///
/// No `AppHandle` exists yet at this point, so this cannot reuse
/// `find_daemon_binary`; the sidecar always sits next to the app binary in
/// every shipped layout, and in a dev tree the workspace `target/` dirs are
/// the fallback.
///
/// Doing nothing when a daemon is already up matters: on Linux the desktop
/// runs autostart entries again on every login, and a session that was never
/// fully torn down can leave the previous daemon alive.
pub(crate) fn spawn_detached_daemon() -> Result<(), String> {
    #[cfg(unix)]
    if let Ok((sock, _)) = daemon_ipc_paths() {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            return Ok(());
        }
    }

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "app binary has no parent directory".to_string())?;
    let candidates = [
        dir.join("mailvault-daemon"),
        dir.join("mailvault-daemon.exe"),
        dir.join("../target/debug/mailvault-daemon"),
        dir.join("../target/release/mailvault-daemon"),
    ];
    let bin = candidates
        .iter()
        .find(|c| c.exists())
        .ok_or_else(|| format!("mailvault-daemon not found next to {}", exe.display()))?;

    daemon_command(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start {}: {e}", bin.display()))
}

/// The daemon, told which portable root this app resolved, so the two can
/// never disagree about where the data is, wherever the daemon binary sits.
pub(crate) fn daemon_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    // Same malloc mode Info.plist's LSEnvironment gives the app, for a daemon
    // started from an app that LaunchServices did not launch (dev, e2e).
    #[cfg(target_os = "macos")]
    cmd.env("MallocSpaceEfficient", "1");
    if let Some(root) = mailvault_core::paths::portable_root() {
        cmd.env(mailvault_core::paths::PORTABLE_ENV, root);
    }
    cmd
}

/// Spawn daemon as a child process (on-demand mode). Waits for socket to appear.
pub(crate) fn ensure_daemon_socket(app_handle: &tauri::AppHandle, socket_path: &Path) -> Result<(), String> {
    // Already running?
    if mailvault_core::transport::is_listening(socket_path) {
        // Quick liveness check: can we actually connect? Unix-only, and
        // deliberately not `transport::connect_sync`: a unix socket *file*
        // can go stale (a crashed daemon leaves it behind), so this second,
        // real connect disambiguates "the path exists" from "something is
        // actually listening" — `connect_sync` would additionally have added
        // a read/write timeout and a `try_clone` (a `dup`) that the bare
        // `connect` never had, changing this unix path's failure modes for
        // no reason. On Windows there is no such residue: a named pipe
        // simply isn't enumerable once no server holds it, so `is_listening`
        // above (which already enumerates `\\.\pipe\`, see
        // `transport::is_listening`'s doc comment) is the complete answer.
        // Do NOT "restore" an open-based probe here for symmetry: it would
        // open the pipe, consuming the daemon's one waiting instance per
        // call and misreading `ERROR_PIPE_BUSY` or the accept/re-arm gap as
        // "down" — exactly what `transport::is_listening` exists to avoid.
        #[cfg(unix)]
        {
            if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
                return Ok(());
            }
            // Stale socket — remove it
            let _ = std::fs::remove_file(socket_path);
        }
        #[cfg(windows)]
        return Ok(());
    }

    let mut guard = DAEMON_CHILD.lock().map_err(|e| e.to_string())?;

    // Check if our child is still alive
    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(Some(_)) => { *guard = None; } // Exited, need to respawn
            Ok(None) => {
                // Still running but socket gone — wait a moment
                for _ in 0..20 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if mailvault_core::transport::is_listening(socket_path) { return Ok(()); }
                }
                return Err("Daemon child is running but socket not appearing".into());
            }
            Err(_) => { *guard = None; }
        }
    }

    // Checked here, still holding `guard` (DAEMON_CHILD): a reconnect that
    // reached this point after `shutdown_daemon_child()` already ran must not
    // spawn an orphan the app will never clean up.
    if APP_EXITING.load(Ordering::SeqCst) {
        return Err("app is exiting".into());
    }

    // Addendum D.2: a vault handler holds the index closed and is mid-move.
    // The socket isn't live (we're past the top-of-function early return), so
    // spawning here would open/create index.db inside a root being copied or
    // deleted. A live daemon is still used by the branches above this point —
    // only a fresh spawn is refused.
    if !may_spawn_daemon() {
        return Err("daemon suspended during a vault move".into());
    }

    // Spawn new daemon
    let daemon_bin = find_daemon_binary(app_handle)
        .ok_or_else(|| "mailvault-daemon binary not found".to_string())?;

    info!("Spawning daemon on-demand: {:?}", daemon_bin);

    let child = daemon_command(&daemon_bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    *guard = Some(child);
    // A freshly spawned daemon has never had its build checked, whatever
    // inode last passed on this socket path. On Linux (ext4/tmpfs) a fresh
    // inode can reuse a just-freed number, so a stale VERIFIED_SOCKET_INO
    // could otherwise match the respawned daemon's socket by coincidence and
    // let it skip the build-mismatch check in ensure_daemon_running.
    VERIFIED_SOCKET_INO.store(0, Ordering::SeqCst);
    // A cached token is only trustworthy alongside the inode it was read
    // for; the fresh child above has never had its token read yet.
    set_cached_daemon_token(None);

    // Wait for socket to appear (up to 3 seconds)
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if mailvault_core::transport::is_listening(socket_path) {
            info!("Daemon socket ready");
            return Ok(());
        }
    }

    Err("Daemon spawned but socket did not appear within 3 seconds".into())
}

/// How long the app waits for a SIGTERM'd daemon to exit on its own before
/// escalating to SIGKILL. Must exceed the daemon's own shutdown budget (2s of
/// IMAP logout in src-daemon/src/main.rs) or we kill it mid-cleanup — and it
/// blocks app quit, so it can't be generous.
///
/// Not `cfg(unix)`-only: `stop_daemon_locked` uses it as a plain socket-gone
/// deadline on every platform, not just in the SIGTERM-specific unix arm of
/// `shutdown_daemon_child` below.
pub(crate) const DAEMON_STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Stop the on-demand daemon child process (called on app exit).
///
/// SIGTERM first, so the daemon runs its own cleanup — LOGOUT of every pooled
/// IMAP session, socket and PID file removal. SIGKILL only if it won't go.
pub fn shutdown_daemon_child() {
    if let Ok(mut guard) = DAEMON_CHILD.lock() {
        if let Some(ref mut child) = *guard {
            info!("Shutting down on-demand daemon (PID {})", child.id());

            #[cfg(unix)]
            {
                // Safe from PID reuse: we have never reaped this child, so it
                // stays a zombie holding its PID until the wait() below.
                unsafe { libc::kill(child.id() as DaemonPid, libc::SIGTERM) };

                let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
                while std::time::Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }

            #[cfg(windows)]
            {
                // Windows has no graceful inter-process signal to send here —
                // the graceful attempt already happened upstream (the app
                // sends the `daemon.shutdown` RPC before this path runs), so
                // reaching here means the daemon did not honour it.
                // `child.kill()` is `TerminateProcess`, immediately forceful;
                // still wait out the same grace period for it to actually
                // exit before falling through to the unconditional kill/wait
                // below.
                let _ = child.kill();

                let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
                while std::time::Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }

            let _ = child.kill();
            let _ = child.wait();
            *guard = None;
        }
    }
}

/// Inode of the socket whose daemon last passed the build check (0 = none).
pub(crate) static VERIFIED_SOCKET_INO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// One restart per app run for a build mismatch; a stale staged sidecar must not loop.
pub(crate) static RESTARTED_FOR_BUILD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Auth token cached from the last slow-path `ensure_daemon_running` run, for
/// `daemon_rpc`'s fast path (C7) to reuse without a file read. Trusted only
/// while `VERIFIED_SOCKET_INO != 0` and the channel is connected. The token
/// itself persists across daemon restarts (`src-daemon/src/auth.rs`
/// `load_or_generate_token_at` reuses the existing `mv.token` whenever it is
/// well-formed); the inode gate, not the token, keeps the fast path off an
/// unverified daemon. Cleared at every site that resets the inode to 0 (a
/// fresh spawn, `stop_daemon_locked`, or a fast-path retry) purely to keep
/// the two in lockstep, not because the token itself goes stale.
pub(crate) static DAEMON_TOKEN: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn cached_daemon_token() -> Option<String> {
    DAEMON_TOKEN.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

pub(crate) fn set_cached_daemon_token(token: Option<String>) {
    *DAEMON_TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = token;
}

/// A cheap identity for "this exact endpoint was already build-verified".
///
/// Windows has no inode and a pipe has no metadata, so it returns 0 — which the
/// caller already reads as "no cache", costing one extra heartbeat per call
/// rather than a wrong cache hit.
pub(crate) fn socket_ino(path: &Path) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).map(|m| m.ino()).unwrap_or(0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        0
    }
}

/// A daemon is listening AND it is this build's (spec §3.3). Blocking: call it
/// from a blocking thread.
///
/// Holds `DAEMON_LIFECYCLE` for the whole check (socket ensure + build verify,
/// including a possible restart) so a concurrent `daemon_rpc` auto-spawn can
/// never race a restart triggered by this one.
pub(crate) fn ensure_daemon_running(app_handle: &tauri::AppHandle, socket_path: &Path) -> Result<(), String> {
    let lifecycle = DAEMON_LIFECYCLE.lock().unwrap_or_else(|p| p.into_inner());
    ensure_daemon_socket(app_handle, socket_path)?;
    verify_daemon_build(app_handle, socket_path, &lifecycle)
}

/// Must only run with `DAEMON_LIFECYCLE` held — the `lifecycle` parameter is
/// proof of that (not used by the body), enforced by every caller going
/// through `ensure_daemon_running` above.
pub(crate) fn verify_daemon_build(app_handle: &tauri::AppHandle, socket_path: &Path, lifecycle: &MutexGuard<'_, ()>) -> Result<(), String> {
    use mailvault_core::daemon_ipc::{call, check_build, BuildCheck};
    use std::sync::atomic::Ordering::SeqCst;
    let ino = socket_ino(socket_path);
    if ino != 0 && VERIFIED_SOCKET_INO.load(SeqCst) == ino {
        return Ok(());
    }
    let (_, token_path) = daemon_ipc_paths()?;
    let token = std::fs::read_to_string(&token_path).map_err(|e| format!("daemon token: {e}"))?;
    let beat = call(socket_path, &token, "daemon.heartbeat", serde_json::json!({}), std::time::Duration::from_secs(3))
        .map_err(|e| format!("daemon heartbeat: {e:?}"))?;
    let theirs = beat.get("buildId").and_then(|v| v.as_str()).map(str::to_owned);
    match check_build(mailvault_core::BUILD_ID, theirs.as_deref(), RESTARTED_FOR_BUILD.load(SeqCst)) {
        BuildCheck::Same => {}
        BuildCheck::Accept => warn!("daemon build {theirs:?} still differs from app build {} after a restart; using it", mailvault_core::BUILD_ID),
        BuildCheck::Restart => {
            if RESTARTED_FOR_BUILD.compare_exchange(false, true, SeqCst, SeqCst).is_ok() {
                warn!("daemon build {theirs:?} differs from app build {}; restarting it", mailvault_core::BUILD_ID);
                stop_daemon_locked(lifecycle);
                ensure_daemon_socket(app_handle, socket_path)?;
                return verify_daemon_build(app_handle, socket_path, lifecycle); // can only be Same or Accept now
            }
            // With DAEMON_LIFECYCLE held for the whole of ensure_daemon_running,
            // only one caller can ever be in this arm — the CAS above cannot
            // lose. If it somehow did, don't cache a mismatched build as verified.
            return Err("daemon build verification raced with another restart".to_string());
        }
    }
    VERIFIED_SOCKET_INO.store(socket_ino(socket_path), SeqCst);
    Ok(())
}

// `nudge_index` is gone (Phase 3 remainder, Task 5): the app has no vault
// writer left to nudge the index for. Its last caller was `archive.rs`'s
// `run_with_backup` shim, deleted with the backup runners; the daemon signals
// its own index in-process.

/// One blocking daemon RPC: ensure the daemon is up, read its token, one
/// request/response round trip. Used by code that isn't already async — the
/// vault move handlers' `spawn_blocking` bodies below, and (Task 2.9b) the
/// app's remaining custody and backup bridge callers. Insights was one of
/// them until Task 3.7 moved it into the daemon, where it reads custody in
/// process.
///
/// Renamed from `daemon_index_call` (Task 2.5): it now returns the result
/// instead of always swallowing it, so a bridge caller can act on an error.
/// The vault handlers keep today's log-and-go-on behaviour themselves, via
/// `daemon_vault_lifecycle_call` below. While `DAEMON_SUSPENDED` is held and
/// no daemon is currently live, `ensure_daemon_running` fails fast instead of
/// spawning one (addendum D.5) — surfaced here as an ordinary `Err`.
pub(crate) fn daemon_call_blocking(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let (socket, token_path) = daemon_ipc_paths()?;
    ensure_daemon_running(app, &socket)?;
    let token = std::fs::read_to_string(&token_path).map_err(|e| e.to_string())?;
    mailvault_core::daemon_ipc::call(&socket, &token, method, params, timeout).map_err(|e| map_call_error(method, e))
}

/// I1 fix (Task 2.5 fix round 1): `daemon_call_blocking`'s old
/// `.map_err(|e| format!("{e:?}"))` handed callers Rust `Debug` text
/// (`Rpc("E_VAULT_UNAVAILABLE: ...")`, quotes escaped) instead of the
/// daemon's own message, breaking every `E_*:`/`custody store unavailable:`
/// text match the 2.9b forwarders and the bridge callers rely on. Same
/// contract as the async path's `map_rpc_error`: a daemon-answered error
/// passes through verbatim so its prefix survives; anything before a reply
/// line was even read (unreachable, refused, timed out) becomes the
/// `DAEMON_UNAVAILABLE` catalog key; a stale build's METHOD_NOT_FOUND
/// becomes `DAEMON_OUTDATED`. The real reason always still reaches the log.
pub(crate) fn map_call_error(method: &str, e: mailvault_core::daemon_ipc::CallError) -> String {
    use mailvault_core::daemon_ipc::CallError;
    match e {
        CallError::Rpc(m) if m.starts_with("Unknown method:") => {
            warn!("{method}: {m}");
            DAEMON_OUTDATED.to_string()
        }
        CallError::Rpc(m) => m,
        CallError::Unreachable(m) => {
            warn!("{method}: {m}");
            DAEMON_UNAVAILABLE.to_string()
        }
    }
}

/// True when a `daemon_call_blocking` error is the daemon answering
/// JSON-RPC METHOD_NOT_FOUND — a build that has not been rebuilt yet with
/// this RPC. Since `map_call_error` (I1) now maps that case to the
/// `DAEMON_OUTDATED` catalog key up front, this is just an equality check —
/// callers must treat it exactly like the daemon being unreachable — log
/// and continue the vault operation — never as a hard failure of the move.
pub(crate) fn is_stale_daemon_method(e: &str) -> bool {
    e == DAEMON_OUTDATED
}

/// I2 fix (Task 2.5 fix round 1): pure decision for `daemon_vault_lifecycle_call`
/// below — a failed `vault_close`/`vault_reopen` must stop the daemon
/// (`Err`); a successful one must leave it running (`Ok`). Split out so the
/// decision itself is unit-testable without touching the real socket/global
/// lifecycle state.
pub(crate) fn should_stop_after_lifecycle_call(result: &Result<serde_json::Value, String>) -> bool {
    result.is_err()
}

/// `vault_close` / `vault_reopen` on the daemon, blocking, for the vault
/// handlers: the daemon must release index.db (and, from Task 2.9a/b,
/// custody.db) before the app copies it. No daemon, or a daemon too old to
/// know the method, both mean nothing holds either store: log and go on.
///
/// I2 fix (Task 2.5 fix round 1): a failed close/reopen against a LIVE
/// daemon was previously just logged — the daemon could still be holding
/// index.db/custody.db open while the app started copying the root, and a
/// failed reopen left `vault_closed` stuck `true` forever, answering "the
/// vault is being moved" to every read/write until the app restarted. Now
/// any `Err` stops the daemon: cheap when there already isn't one to stop,
/// and `DAEMON_SUSPENDED` (held by every vault handler across its whole
/// move) blocks a respawn until the guard drops, so this can't race the
/// move's own copy step. The channel respawns a fresh daemon against
/// whichever root is current once the guard drops.
pub(crate) fn daemon_vault_lifecycle_call(app: &tauri::AppHandle, method: &str, timeout: std::time::Duration) {
    let started = std::time::Instant::now();
    let result = daemon_call_blocking(app, method, serde_json::json!({}), timeout);
    let took = started.elapsed();
    // I-2: `vault_close` can legitimately take a while (a search-index
    // batch/compaction in flight) — log how long every call actually took so
    // a slow close shows up in the log before it ever gets near the budget
    // above, not only once it times out.
    info!("{method} took {:?} (budget {:?})", took, timeout);
    if let Err(e) = &result {
        if is_stale_daemon_method(e) {
            warn!("{method}: daemon does not know this method yet (stale build); continuing as if unreachable");
        } else {
            warn!("{method} failed ({e}) after {:?}; stopping the daemon so nothing holds the vault", took);
        }
    }
    if should_stop_after_lifecycle_call(&result) {
        stop_daemon();
    }
}

/// Stop whichever daemon owns the socket, ours or an orphan left behind by a
/// crashed app, with the same cleanup as SIGTERM (`daemon.shutdown`), then
/// reap or kill our own tracked child. Blocking. Takes `DAEMON_LIFECYCLE` so
/// this can never race a concurrent `daemon_rpc` auto-spawn or restart.
pub(crate) fn stop_daemon() {
    let lifecycle = DAEMON_LIFECYCLE.lock().unwrap_or_else(|p| p.into_inner());
    stop_daemon_locked(&lifecycle);
}

/// Must only run with `DAEMON_LIFECYCLE` held — by `stop_daemon()` above, or
/// by `verify_daemon_build`'s restart arm (which already holds it via
/// `ensure_daemon_running`, so recursing into `stop_daemon()` there would
/// deadlock).
///
/// Returns only once the socket is gone and, when a pid was known, that pid
/// is confirmed dead — or after the SIGKILL escalation below runs out. A
/// replacement daemon must never be spawned while the old one still holds its
/// singleton lock: the daemon's own startup lock retry is capped at 2s
/// (src-daemon/src/main.rs `acquire_singleton_lock` loop), which a graceful
/// shutdown can exceed when IMAP LOGOUT hangs — so the caller waits here
/// rather than racing a respawn against that window.
pub(crate) fn stop_daemon_locked(_lifecycle: &MutexGuard<'_, ()>) {
    if let Ok((socket, token_path)) = daemon_ipc_paths() {
        let known_pid = read_daemon_pid_file(&daemon_pid_path());
        // Trap: if the pid file names our own on-demand child, it is a zombie
        // the moment it exits (we never reaped it yet), and kill(pid, 0) keeps
        // reporting a zombie as "alive" forever. Waiting for it to go "dead"
        // here — or treating it as an orphan to SIGTERM/SIGKILL ourselves —
        // would spin until every deadline below and could double-signal a
        // child that `shutdown_daemon_child()` already owns and can properly
        // try_wait()/reap. So: our own child's lifecycle is entirely its job.
        let is_own_child = known_pid.is_some() && known_pid == daemon_child_pid();

        if let Ok(token) = std::fs::read_to_string(&token_path) {
            let _ = mailvault_core::daemon_ipc::call(&socket, &token, "daemon.shutdown", serde_json::json!({}), std::time::Duration::from_secs(1));
        }
        let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
        while mailvault_core::transport::is_listening(&socket) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        if !is_own_child {
            // The socket disappearing doesn't guarantee the pid has actually
            // exited yet (the daemon removes the socket just before
            // process::exit) — wait for that too, same bounded/polled style.
            if let Some(pid) = known_pid {
                let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
                while !pid_is_dead(pid) && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }

            // R3: an orphan from a build too old to answer `daemon.shutdown`
            // (or one the RPC above simply never reached) leaves the socket
            // and/or pid behind. Signal it ourselves instead of waiting forever.
            let still_up = mailvault_core::transport::is_listening(&socket) || known_pid.is_some_and(|pid| !pid_is_dead(pid));
            if still_up {
                match known_pid {
                    Some(pid) if pid_is_mailvault_daemon(pid) => {
                        #[cfg(unix)]
                        {
                            warn!("orphan daemon (pid {pid}) did not clear its socket/pid after daemon.shutdown; sending SIGTERM");
                            // SAFETY: pid was just confirmed to be a running mailvault-daemon process.
                            unsafe { libc::kill(pid, libc::SIGTERM) };
                            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                            while (mailvault_core::transport::is_listening(&socket) || !pid_is_dead(pid)) && std::time::Instant::now() < deadline {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                            if !pid_is_dead(pid) {
                                // Ruling-2: the pid could have exited and been reused by an
                                // unrelated process in the up-to-3s window since the last
                                // check — re-verify identity right before an irreversible kill.
                                if pid_is_mailvault_daemon(pid) {
                                    warn!("orphan daemon (pid {pid}) ignored SIGTERM; sending SIGKILL");
                                    // SAFETY: identity re-checked immediately above; SIGTERM already failed to stop it.
                                    unsafe { libc::kill(pid, libc::SIGKILL) };
                                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
                                    while !pid_is_dead(pid) && std::time::Instant::now() < deadline {
                                        std::thread::sleep(std::time::Duration::from_millis(50));
                                    }
                                } else {
                                    warn!("pid {pid} is no longer a mailvault-daemon process (likely exited and the pid was reused); not sending SIGKILL");
                                }
                            }
                        }
                        #[cfg(windows)]
                        {
                            // Windows has no weaker-than-forced-kill signal, so
                            // there is no SIGTERM-then-wait step to collapse
                            // into: the guard above (`pid_is_mailvault_daemon`)
                            // is only the decision to try — it is what governs
                            // whether we log and attempt a kill at all. The
                            // real safety property is the two ANDed `/FI`
                            // filters below: the guard's own `tasklist` spawn
                            // and this `taskkill` spawn each cost tens of
                            // milliseconds, unlike unix's immediate kill(2)
                            // syscall, so the guard's answer can be stale by
                            // the time the kill actually runs. Passing both
                            // "PID eq <pid>" and "IMAGENAME eq mailvault-daemon.exe"
                            // makes taskkill itself re-verify identity
                            // atomically at the instant it terminates the
                            // process — it kills only a process that is still
                            // both this pid and this image name right then, no
                            // separate re-check of our own needed.
                            warn!("orphan daemon (pid {pid}) did not clear its socket/pid after daemon.shutdown; forcing termination with taskkill /F");
                            let mut cmd = std::process::Command::new("taskkill");
                            cmd.args(["/F", "/FI", &format!("PID eq {pid}"), "/FI", &format!("IMAGENAME eq {DAEMON_EXE}")]);
                            suppress_console_window(&mut cmd);
                            let _ = cmd.output();
                            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
                            while !pid_is_dead(pid) && std::time::Instant::now() < deadline {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                        }
                        if mailvault_core::transport::is_listening(&socket) {
                            let _ = std::fs::remove_file(&socket);
                        }
                    }
                    Some(pid) => warn!("daemon pid file names pid {pid}, which is not a mailvault-daemon process; leaving the socket alone"),
                    None => warn!("daemon socket outlived daemon.shutdown and no pid file was found; leaving it alone"),
                }
            }
        }
    }
    shutdown_daemon_child(); // reaps an exited child; SIGTERM then SIGKILL if ours is still up
    VERIFIED_SOCKET_INO.store(0, std::sync::atomic::Ordering::SeqCst);
    set_cached_daemon_token(None);
}
