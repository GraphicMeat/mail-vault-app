//! "Keep the daemon running in the background" — the OS half.
//!
//! Registering a login item is platform integration, so it lives in the shell
//! (CLAUDE.md). Everything that is only text or paths — the plist body, the
//! `.desktop` entry, which executable path survives a reboot — is in
//! `mailvault_core::autostart`, where CI actually runs the tests.
//!
//! Three very different mechanisms, one toggle:
//!
//! * **macOS** — `SMAppService`. Developer ID registers the bundled LaunchAgent
//!   (`Contents/Library/LaunchAgents/com.mailvault.daemon.plist`), so launchd
//!   runs the *daemon* with no UI at all. The App Store build cannot: its
//!   sidecar is signed `app-sandbox` + `com.apple.security.inherit`, and a
//!   binary with `inherit` aborts unless its sandboxed parent spawned it —
//!   launchd is not that parent. There it falls back to registering the app
//!   itself, which spawns the daemon the way it always has.
//! * **Linux** — an XDG autostart `.desktop`. Refused under snap confinement.
//! * **Windows** — the `HKCU` Run key. The daemon's IPC is a Unix socket, so
//!   nothing on Windows can start today; this is here so the switch is already
//!   wired when that changes.
//!
//! Turning the toggle *off* only removes the login item. The daemon that is
//! running right now keeps running — `RunEvent::Exit` stops it at the next
//! quit, which is the behaviour the user just asked for.

use mailvault_core::autostart as core;
use serde::Serialize;

/// What the Daemon settings tab draws.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartState {
    /// False hides the toggle behind an explanation rather than offering a
    /// switch that cannot work.
    pub supported: bool,
    pub enabled: bool,
    /// Catalogue key suffix for *why* it is unsupported — never a raw string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// macOS only: registered, but the user still has to allow it in System
    /// Settings > General > Login Items. Without surfacing this the toggle
    /// looks on while nothing starts.
    pub needs_approval: bool,
}

impl AutostartState {
    fn unsupported(reason: &str) -> Self {
        Self { supported: false, enabled: false, reason: Some(reason.to_string()), needs_approval: false }
    }
    fn on(enabled: bool) -> Self {
        Self { supported: true, enabled, reason: None, needs_approval: false }
    }
}

#[tauri::command]
pub fn autostart_state() -> AutostartState {
    imp::state()
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<AutostartState, String> {
    imp::set(enabled)?;
    Ok(imp::state())
}

// ── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod imp {
    use super::{core, AutostartState};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::NSString;

    /// `SMAppServiceStatus`.
    const NOT_REGISTERED: isize = 0;
    const ENABLED: isize = 1;
    const REQUIRES_APPROVAL: isize = 2;
    const NOT_FOUND: isize = 3;

    /// `None` below macOS 13, where the class simply does not exist. Looked up
    /// by name rather than with `class!`, which would abort there.
    fn service() -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"SMAppService")?;
        unsafe {
            // The App Store sidecar carries `com.apple.security.inherit` and
            // aborts unless the sandboxed app spawned it, so launchd may not
            // start it directly — register the app instead.
            #[cfg(feature = "appstore")]
            let svc: Option<Retained<AnyObject>> = msg_send![cls, mainAppService];
            #[cfg(not(feature = "appstore"))]
            let svc: Option<Retained<AnyObject>> = {
                let name = NSString::from_str(core::AGENT_PLIST_NAME);
                msg_send![cls, agentServiceWithPlistName: &*name]
            };
            svc
        }
    }

    fn status(svc: &AnyObject) -> isize {
        unsafe { msg_send![svc, status] }
    }

    pub fn state() -> AutostartState {
        let Some(svc) = service() else {
            return AutostartState::unsupported("macos-version");
        };
        match status(&svc) {
            ENABLED => AutostartState::on(true),
            REQUIRES_APPROVAL => AutostartState {
                supported: true,
                enabled: true,
                reason: None,
                needs_approval: true,
            },
            // `NotFound` means the bundle holds no such plist — an unsigned or
            // half-built bundle (`cargo tauri dev` has no LaunchAgents dir).
            // Reported as unsupported rather than as a toggle that fails.
            NOT_FOUND => AutostartState::unsupported("not-bundled"),
            NOT_REGISTERED => AutostartState::on(false),
            other => {
                tracing::warn!("SMAppService returned unknown status {other}");
                AutostartState::on(false)
            }
        }
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let svc = service().ok_or_else(|| "login items need macOS 13 or later".to_string())?;
        // Re-registering an already-enabled service returns an error on some
        // releases; unregistering one that was never registered likewise.
        // Both are "already what you asked for", so neither is a failure.
        let current = status(&svc);
        if enabled && matches!(current, ENABLED | REQUIRES_APPROVAL) {
            return Ok(());
        }
        if !enabled && current == NOT_REGISTERED {
            return Ok(());
        }
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = unsafe {
            if enabled {
                msg_send![&*svc, registerAndReturnError: &mut err]
            } else {
                msg_send![&*svc, unregisterAndReturnError: &mut err]
            }
        };
        if ok {
            return Ok(());
        }
        Err(error_message(err).unwrap_or_else(|| {
            let verb = if enabled { "register" } else { "remove" };
            format!("macOS refused to {verb} the login item")
        }))
    }

    fn error_message(err: *mut AnyObject) -> Option<String> {
        if err.is_null() {
            return None;
        }
        unsafe {
            let desc: Option<Retained<NSString>> = msg_send![err, localizedDescription];
            desc.map(|d| d.to_string())
        }
    }
}

// ── Linux ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod imp {
    use super::{core, AutostartState};
    use std::path::PathBuf;

    fn entry_path() -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        let cfg = core::config_home(std::env::var("XDG_CONFIG_HOME").ok().as_deref(), &home);
        Some(core::linux_entry_path(&cfg))
    }

    /// Both the reason the toggle is unavailable and, when it is available,
    /// the `Exec=` line to write.
    fn exec_line() -> Result<String, core::Unsupported> {
        core::linux_supported(std::env::var("SNAP").ok().as_deref())?;
        let exe = std::env::current_exe().map_err(|_| core::Unsupported::NoStableExecutable)?;
        core::exec_command(&exe, std::env::var("APPIMAGE").ok().as_deref())
    }

    pub fn state() -> AutostartState {
        match exec_line() {
            Err(why) => AutostartState::unsupported(why.as_str()),
            Ok(_) => {
                let enabled = entry_path().map(|p| p.exists()).unwrap_or(false);
                AutostartState::on(enabled)
            }
        }
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let exec = exec_line().map_err(|why| format!("autostart unavailable: {}", why.as_str()))?;
        let path = entry_path().ok_or_else(|| "no home directory".to_string())?;
        if !enabled {
            // A missing entry is the requested state, not a failure.
            return match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("could not remove {}: {e}", path.display())),
            };
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        // Rewritten every time rather than left alone when it exists: the app
        // may have moved, or been replaced by a different packaging, since the
        // entry was written — and a stale `Exec=` fails silently at login.
        std::fs::write(&path, core::desktop_entry(&exec))
            .map_err(|e| format!("could not write {}: {e}", path.display()))
    }
}

// ── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    //! Unreachable today: the daemon speaks over a Unix socket, so no Windows
    //! build exists to run it. Kept complete so the toggle works the day the
    //! IPC grows a named-pipe transport.
    //!
    //! `reg.exe` rather than a registry crate — this is the only registry the
    //! app touches, and it is not worth a dependency that nothing here can
    //! exercise.
    use super::{core, AutostartState};
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// Never flash a console window on a GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> std::io::Result<std::process::Output> {
        Command::new("reg").args(args).creation_flags(CREATE_NO_WINDOW).output()
    }

    fn command_line() -> Result<String, core::Unsupported> {
        let exe = std::env::current_exe().map_err(|_| core::Unsupported::NoStableExecutable)?;
        core::exec_command(&exe, None)
    }

    pub fn state() -> AutostartState {
        if command_line().is_err() {
            return AutostartState::unsupported(core::Unsupported::NoStableExecutable.as_str());
        }
        let enabled = reg(&["query", core::WINDOWS_RUN_KEY, "/v", core::WINDOWS_RUN_VALUE])
            .map(|o| o.status.success())
            .unwrap_or(false);
        AutostartState::on(enabled)
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let out = if enabled {
            let cmd = command_line()
                .map_err(|why| format!("autostart unavailable: {}", why.as_str()))?;
            reg(&["add", core::WINDOWS_RUN_KEY, "/v", core::WINDOWS_RUN_VALUE, "/t", "REG_SZ", "/d", &cmd, "/f"])
        } else {
            // `/f` makes a missing value a success, which is the state asked for.
            reg(&["delete", core::WINDOWS_RUN_KEY, "/v", core::WINDOWS_RUN_VALUE, "/f"])
        };
        match out {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => Err(format!("reg.exe failed: {}", String::from_utf8_lossy(&o.stderr).trim())),
            Err(e) => Err(format!("could not run reg.exe: {e}")),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod imp {
    use super::AutostartState;
    pub fn state() -> AutostartState {
        AutostartState::unsupported("platform")
    }
    pub fn set(_enabled: bool) -> Result<(), String> {
        Err("this platform has no login items".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend branches on `supported`/`reason`; a raw OS string must
    /// never reach it.
    #[test]
    fn an_unsupported_state_carries_a_key_not_a_sentence() {
        let s = AutostartState::unsupported("snap");
        assert!(!s.supported);
        assert!(!s.enabled);
        assert_eq!(s.reason.as_deref(), Some("snap"));
    }

    #[test]
    fn a_supported_state_has_no_reason() {
        assert_eq!(AutostartState::on(true).reason, None);
        assert!(AutostartState::on(true).enabled);
        assert!(!AutostartState::on(false).enabled);
    }
}
