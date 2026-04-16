// ── Background helper management ────────────────────────────────────────────
//
// Abstracts process lifecycle and IPC transport for the background helper
// (mailvault-daemon).  Frontend callers use the same daemonCall() API
// regardless of the underlying launch strategy or transport.
//
// Design:
//   - The main app is sandboxed.  The helper inherits its sandbox when
//     spawned as a sidecar (on-demand).  A standalone binary cannot opt
//     into its own sandbox (no Info.plist) — packaging as an app bundle
//     is required before the helper can be independently sandboxed.
//   - Shared state (socket, token) lives in the App Group container.
//   - Launch strategy is platform-specific and swappable:
//       macOS on-demand  → Tauri sidecar (inherits app sandbox)
//       macOS always-on  → launchd LaunchAgent (transitional; target is
//                          SMAppService login-item once the helper is
//                          packaged as a proper bundle)
//       Linux on-demand  → child process
//       Linux always-on  → systemd user service
//   - Transport is JSON-RPC 2.0 over a Unix domain socket with a pre-shared
//     token.  The socket lives in the App Group container on macOS so both
//     sandbox containers resolve to the same path.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;
use tracing::{info, warn};

// ── Shared constants ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
const APP_GROUP_ID: &str = "group.com.mailvault";

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "com.mailvault.daemon";

// ── Helper status model ─────────────────────────────────────────────────────

/// Structured status returned to the frontend via `helper_status` command.
#[derive(Debug, Clone, Serialize)]
pub struct HelperStatus {
    pub mode: String,
    pub registered: bool,
    pub reachable: bool,
    pub shared_container_ok: bool,
    pub auth_ok: bool,
    pub last_error: Option<String>,
}

// ── Path resolution ─────────────────────────────────────────────────────────

/// Resolve the real user home directory, bypassing macOS sandbox container
/// redirect.  Inside the sandbox $HOME points to
/// /Users/{name}/Library/Containers/{bundle}/Data — we strip at
/// /Library/Containers/.
#[cfg(target_os = "macos")]
pub fn real_home_dir() -> Option<PathBuf> {
    let raw = std::env::var("HOME")
        .ok()
        .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().to_string()))?;

    let effective = if let Some(idx) = raw.find("/Library/Containers/") {
        info!("Extracting real home from sandbox container path: {}", raw);
        &raw[..idx]
    } else {
        &raw
    };

    let p = PathBuf::from(effective);
    if p.starts_with("/Users/") && p.is_dir() {
        info!("Resolved real home: {}", effective);
        Some(p)
    } else {
        warn!("Could not resolve real home directory from: {}", raw);
        None
    }
}

/// App Group container directory shared between sandboxed app and helper.
/// Both declare `group.com.mailvault` in their
/// `com.apple.security.application-groups` entitlement, so the sandbox allows
/// access to this real-home-relative path regardless of container redirect.
#[cfg(target_os = "macos")]
fn app_group_dir() -> Result<PathBuf, String> {
    let home = real_home_dir().ok_or("Could not resolve real home directory for App Group")?;
    let dir = home.join("Library/Group Containers").join(APP_GROUP_ID);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create App Group dir {:?}: {}", dir, e))?;
    Ok(dir)
}

/// Socket path.  Must match the helper's `get_socket_path()`.
#[cfg(target_os = "macos")]
pub fn socket_path() -> Result<PathBuf, String> {
    Ok(app_group_dir()?.join("mv.sock"))
}

/// Token path.  Same directory as socket.
#[cfg(target_os = "macos")]
pub fn token_path() -> Result<PathBuf, String> {
    Ok(app_group_dir()?.join("mv.token"))
}

#[cfg(not(target_os = "macos"))]
pub fn socket_path() -> Result<PathBuf, String> {
    Ok(std::env::temp_dir().join("daemon.sock"))
}

#[cfg(not(target_os = "macos"))]
pub fn token_path() -> Result<PathBuf, String> {
    Ok(std::env::temp_dir().join("mv.token"))
}

// ── On-demand child process management ──────────────────────────────────────

static HELPER_CHILD: Lazy<Mutex<Option<CommandChild>>> = Lazy::new(|| Mutex::new(None));
pub static HELPER_SPAWNED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub static HELPER_TOKEN_CACHE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Spawn the helper as a Tauri sidecar (on-demand mode).
/// Waits up to 5 s for the socket to appear.
pub fn ensure_running(app_handle: &tauri::AppHandle, sock: &Path) -> Result<(), String> {
    // Already running?
    if sock.exists() {
        if std::os::unix::net::UnixStream::connect(sock).is_ok() {
            info!("Connected to existing helper at {:?}", sock);
            return Ok(());
        }
        info!("Removing stale helper socket at {:?}", sock);
        let _ = std::fs::remove_file(sock);
    }

    let mut guard = HELPER_CHILD.lock().map_err(|e| e.to_string())?;

    // If we have a tracked child but socket is gone, try waiting briefly
    if guard.is_some() {
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if sock.exists() { return Ok(()); }
        }
        if let Some(child) = guard.take() {
            info!("Killing stale helper child (PID {})", child.pid());
            let _ = child.kill();
        }
    }

    info!("Spawning helper on-demand via sidecar API");

    let sidecar_cmd = app_handle.shell().sidecar("mailvault-daemon")
        .map_err(|e| format!("Failed to create helper sidecar command: {}", e))?;

    let (_rx, child) = sidecar_cmd.spawn()
        .map_err(|e| format!("Failed to spawn helper: {}", e))?;

    let pid = child.pid();
    info!("Helper spawned with PID {}", pid);
    *guard = Some(child);

    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if sock.exists() {
            info!("Helper socket ready");
            return Ok(());
        }
    }

    Err("Helper spawned but socket did not appear within 5 seconds".into())
}

/// Kill the on-demand helper child (called on app exit).
pub fn shutdown_child() {
    if let Ok(mut guard) = HELPER_CHILD.lock() {
        if let Some(child) = guard.take() {
            info!("Shutting down on-demand helper (PID {})", child.pid());
            let _ = child.kill();
        }
    }
}

/// Reset cached spawn/token state (called on mode switch).
pub fn reset_cached_state() {
    HELPER_SPAWNED.store(false, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut g) = HELPER_TOKEN_CACHE.lock() { *g = None; }
}

// ── Background registration (always-on) ─────────────────────────────────────
//
// Current macOS implementation uses a launchd LaunchAgent.  This is
// transitional — the target is SMAppService login-item once the helper
// ships as a bundled .app inside Contents/Library/LoginItems/.

/// Register the helper for background/login availability.
pub fn register_background(app_handle: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        register_launchd(app_handle)
    }

    #[cfg(target_os = "linux")]
    {
        register_systemd(app_handle)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = app_handle;
        Err("Background helper not supported on this platform".to_string())
    }
}

/// Unregister the helper from background/login availability.
pub fn unregister_background() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unregister_launchd()
    }

    #[cfg(target_os = "linux")]
    {
        unregister_systemd()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err("Background helper not supported on this platform".to_string())
}

/// Check whether the helper is registered for background availability.
pub fn is_background_registered() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let plist = real_home_dir()
            .ok_or("Could not resolve real home directory")?
            .join(format!("Library/LaunchAgents/{}.plist", LAUNCHD_LABEL));
        Ok(plist.exists())
    }

    #[cfg(target_os = "linux")]
    {
        let unit = dirs::config_dir()
            .ok_or("Could not determine config directory")?
            .join("systemd/user/mailvault-daemon.service");
        Ok(unit.exists())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Ok(false)
}

/// Build a full status snapshot for the frontend.
pub fn status(mode: &str) -> HelperStatus {
    let registered = is_background_registered().unwrap_or(false);

    let sock = socket_path();
    let shared_container_ok = sock.is_ok();
    let reachable = sock
        .as_ref()
        .map(|p| p.exists() && std::os::unix::net::UnixStream::connect(p).is_ok())
        .unwrap_or(false);

    let auth_ok = token_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    let last_error = if !shared_container_ok {
        Some("Cannot resolve App Group container".to_string())
    } else if mode == "always-on" && !registered {
        Some("Background helper not registered — enable it in settings".to_string())
    } else if !reachable {
        Some("Helper not reachable".to_string())
    } else if !auth_ok {
        Some("Auth token missing or empty".to_string())
    } else {
        None
    };

    HelperStatus {
        mode: mode.to_string(),
        registered,
        reachable,
        shared_container_ok,
        auth_ok,
        last_error,
    }
}

// ── macOS: launchd LaunchAgent (transitional) ───────────────────────────────

#[cfg(target_os = "macos")]
fn register_launchd(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let daemon_bin = app_handle.path().resource_dir()
        .ok()
        .and_then(|d| {
            let bin = d.join("mailvault-daemon");
            if bin.exists() { return Some(bin); }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let candidate = dir.join("mailvault-daemon");
                    if candidate.exists() { return Some(candidate); }
                }
            }
            None
        })
        .ok_or_else(|| "Helper binary not found in app bundle".to_string())?;

    let daemon_path_str = daemon_bin.to_string_lossy();
    let sock = socket_path()?;

    let home = real_home_dir().ok_or("Could not resolve real home directory")?;
    let plist_dir = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&plist_dir)
        .map_err(|e| format!("Failed to create LaunchAgents dir: {}", e))?;

    let plist_path = plist_dir.join(format!("{}.plist", LAUNCHD_LABEL));

    // NOTE: This LaunchAgent approach is transitional.  The daemon runs as a
    // sandboxed helper (via its own entitlements) but is registered through
    // launchctl rather than SMAppService.  The target migration path is to
    // package the helper as a login-item bundle in
    // Contents/Library/LoginItems/ and use SMAppService.loginItem(identifier:).
    let plist_content = format!(
r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>AssociatedBundleIdentifiers</key>
    <string>com.mailvault.app</string>
</dict>
</plist>"#,
        label = LAUNCHD_LABEL,
        bin = daemon_path_str,
    );

    let uid = unsafe { libc::getuid() };

    // Bootout existing service (ignore errors — may not be loaded)
    let _ = Command::new("launchctl")
        .args(["bootout", &format!("gui/{}/{}", uid, LAUNCHD_LABEL)])
        .output();

    std::fs::write(&plist_path, &plist_content)
        .map_err(|e| format!("Failed to write plist: {}", e))?;

    // Remove stale sockets (new group-container path + legacy ~/mv.sock)
    let _ = std::fs::remove_file(&sock);
    if let Some(old) = dirs::home_dir().map(|h| h.join("mv.sock")) {
        let _ = std::fs::remove_file(&old);
    }
    if let Some(old) = dirs::home_dir().map(|h| h.join("mv.token")) {
        let _ = std::fs::remove_file(&old);
    }

    let output = Command::new("launchctl")
        .args(["bootstrap", &format!("gui/{}", uid), &plist_path.to_string_lossy()])
        .output()
        .map_err(|e| format!("Failed to run launchctl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("launchctl bootstrap failed: {}", stderr));
    }

    reset_cached_state();
    info!("Registered background helper via launchd: {}", LAUNCHD_LABEL);
    Ok(format!("Helper registered at {}", plist_path.display()))
}

#[cfg(target_os = "macos")]
fn unregister_launchd() -> Result<(), String> {
    let home = real_home_dir().ok_or("Could not resolve real home directory")?;
    let plist_path = home.join(format!("Library/LaunchAgents/{}.plist", LAUNCHD_LABEL));

    if plist_path.exists() {
        let uid = unsafe { libc::getuid() };
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{}/{}", uid, LAUNCHD_LABEL)])
            .output();
        std::fs::remove_file(&plist_path)
            .map_err(|e| format!("Failed to remove plist: {}", e))?;
    }

    reset_cached_state();
    info!("Unregistered background helper: {}", LAUNCHD_LABEL);
    Ok(())
}

// ── Linux: systemd user service ─────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn register_systemd(_app_handle: &tauri::AppHandle) -> Result<String, String> {
    let daemon_bin = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("mailvault-daemon")))
        .filter(|p| p.exists())
        .ok_or_else(|| "Helper binary not found".to_string())?;

    let unit_dir = dirs::config_dir()
        .ok_or("Could not determine config directory")?
        .join("systemd/user");
    std::fs::create_dir_all(&unit_dir)
        .map_err(|e| format!("Failed to create systemd user dir: {}", e))?;

    let unit_path = unit_dir.join("mailvault-daemon.service");
    let unit_content = format!(
        "[Unit]\nDescription=MailVault Background Helper\n\n[Service]\nExecStart={}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        daemon_bin.display()
    );

    std::fs::write(&unit_path, &unit_content)
        .map_err(|e| format!("Failed to write unit file: {}", e))?;

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()
        .map_err(|e| format!("systemctl daemon-reload failed: {}", e))?;

    let output = Command::new("systemctl")
        .args(["--user", "enable", "--now", "mailvault-daemon.service"])
        .output()
        .map_err(|e| format!("systemctl enable failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("systemctl enable failed: {}", stderr));
    }

    reset_cached_state();
    info!("Registered background helper via systemd");
    Ok(format!("Helper registered at {}", unit_path.display()))
}

#[cfg(target_os = "linux")]
fn unregister_systemd() -> Result<(), String> {
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "mailvault-daemon.service"])
        .output();

    let unit_path = dirs::config_dir()
        .ok_or("Could not determine config directory")?
        .join("systemd/user/mailvault-daemon.service");

    if unit_path.exists() {
        std::fs::remove_file(&unit_path)
            .map_err(|e| format!("Failed to remove unit file: {}", e))?;
    }

    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();

    reset_cached_state();
    info!("Unregistered background helper (systemd)");
    Ok(())
}

// ── RPC transport ───────────────────────────────────────────────────────────
//
// Per-request Unix socket connections with a cached auth token.
// The transport is separated from launch strategy so a future XPC-backed
// implementation can replace the socket without touching callers.

/// Execute a JSON-RPC call against the helper.
/// Handles on-demand spawning, token auth, and per-request socket connections.
pub async fn rpc(
    app_handle: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    daemon_mode: Option<&str>,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    static RPC_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    let sock = socket_path()?;

    // Ensure helper is running (once per process)
    if !HELPER_SPAWNED.load(std::sync::atomic::Ordering::Relaxed) {
        let mode = daemon_mode.unwrap_or("on-demand");
        if mode == "always-on" {
            // In always-on mode the platform service manages the helper.
            if !sock.exists() || std::os::unix::net::UnixStream::connect(&sock).is_err() {
                return Err(
                    "Background helper not running. Enable it in Settings > Background Helper."
                        .to_string(),
                );
            }
        } else {
            ensure_running(app_handle, &sock)?;
        }
        HELPER_SPAWNED.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    // Read token (cached after first read)
    let token = {
        let guard = HELPER_TOKEN_CACHE.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let token = match token {
        Some(t) => t,
        None => {
            let tf = token_path()?;
            let t = std::fs::read_to_string(&tf)
                .map_err(|_| format!("Helper token not found at {:?} — is the helper running?", tf))?
                .trim()
                .to_string();
            if let Ok(mut g) = HELPER_TOKEN_CACHE.lock() {
                *g = Some(t.clone());
            }
            t
        }
    };

    // Per-request connection (supports full concurrency)
    let stream = tokio::net::UnixStream::connect(&sock)
        .await
        .map_err(|e| format!("Cannot connect to helper — is it running? ({})", e))?;

    let (reader, mut writer) = stream.into_split();
    let mut lines = tokio::io::BufReader::new(reader).lines();

    // Auth handshake
    let mut buf = serde_json::to_vec(&serde_json::json!({"token": token})).unwrap();
    buf.push(b'\n');
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;

    let auth_resp = lines
        .next_line()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Helper closed connection during auth".to_string())?;

    if serde_json::from_str::<serde_json::Value>(&auth_resp)
        .ok()
        .and_then(|v| v.get("error").cloned())
        .is_some()
    {
        return Err("Helper authentication failed".to_string());
    }

    // Send request
    let id = RPC_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut buf = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0", "method": method, "params": params, "id": id,
    }))
    .unwrap();
    buf.push(b'\n');
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;

    // Read response
    let resp_line = lines
        .next_line()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Helper closed connection before responding".to_string())?;

    let resp: serde_json::Value =
        serde_json::from_str(&resp_line).map_err(|e| format!("Invalid RPC response: {}", e))?;

    if let Some(error) = resp.get("error") {
        return Err(error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown helper error")
            .to_string());
    }

    Ok(resp
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}
