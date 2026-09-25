//! "Keep the daemon running in the background" — the OS half.
//!
//! Registering a login item is platform integration, so it lives in the shell
//! (CLAUDE.md). Everything that is only text or paths — the plist body, the
//! `.desktop` entry, which executable path survives a reboot — is in
//! `mailvault_core::autostart`, where CI actually runs the tests.
//!
//! Three very different mechanisms, one toggle:
//!
//! * **macOS** — `SMAppService.mainApp`, in both channels: the app opens at
//!   login and spawns the daemon the way it always has. The bundled LaunchAgent
//!   (`com.mailvault.app.daemon.plist`) cannot be registered yet. Developer ID
//!   refused it with EPERM because a sandboxed app may not hand launchd an
//!   unsandboxed program; the App Store sidecar is signed
//!   `com.apple.security.inherit`, which aborts unless its sandboxed parent
//!   spawned it. Running the daemon as the agent needs it sandboxed on its own,
//!   and so its socket and vault moved to the `group.com.mailvault` container.
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

/// Help-menu probe (macOS): register the throwaway sandboxed agent and report
/// exactly what macOS said, plus whether the agent actually ran and reached
/// the group container. Throwaway with the probe itself.
#[cfg(target_os = "macos")]
pub fn probe_register_agent() -> Result<isize, String> {
    imp::register_agent_by_name("com.mailvault.app.probe.plist")
}

// Async so they leave the main thread, where a sync command runs: on Windows
// each one waits on a `reg.exe` child, and the Daemon tab froze for it.
#[tauri::command]
pub async fn autostart_state() -> Result<AutostartState, String> {
    if mailvault_core::paths::portable_root().is_some() {
        return Ok(AutostartState::unsupported("portable"));
    }
    off_main(imp::state).await
}

/// A portable copy never registers a login item: the host would try to start
/// an app from a drive that is usually not there.
#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<AutostartState, String> {
    if mailvault_core::paths::portable_root().is_some() {
        return Ok(AutostartState::unsupported("portable"));
    }
    off_main(move || {
        imp::set(enabled)?;
        Ok(imp::state())
    })
    .await?
}

async fn off_main<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A blocking-pool thread has no autorelease pool of its own, and the
        // SMAppService calls return autoreleased objects.
        #[cfg(target_os = "macos")]
        return objc2::rc::autoreleasepool(|_| f());
        #[cfg(not(target_os = "macos"))]
        f()
    })
    .await
    .map_err(|e| e.to_string())
}

// ── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod imp {
    use super::{core, AutostartState};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::NSString;
    use tracing::warn;

    /// `SMAppServiceStatus`.
    const NOT_REGISTERED: isize = 0;
    const ENABLED: isize = 1;
    const REQUIRES_APPROVAL: isize = 2;
    const NOT_FOUND: isize = 3;

    /// `None` below macOS 13, where the class simply does not exist. Looked up
    /// by name rather than with `class!`, which would abort there.
    fn service() -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"SMAppService")?;
        // Both channels register the app, never the daemon agent: the app is
        // sandboxed, and a sandboxed app asking launchd to run an unsandboxed
        // program gets EPERM (SMAppServiceErrorDomain, code 1). The App Store
        // sidecar is worse still — `inherit` aborts unless the app spawned it.
        // ponytail: the app opens at login and spawns the daemon; a UI-less
        // agent needs the daemon sandboxed + moved to the group container.
        unsafe { msg_send![cls, mainAppService] }
    }

    /// Whether this build actually ships the agent plist. See the `NotFound`
    /// arm below for why the distinction matters.
    fn bundled_plist_is_present() -> bool {
        std::env::current_exe()
            .ok()
            .and_then(|exe| core::bundled_plist_path(&exe))
            .map(|p| p.exists())
            .unwrap_or(false)
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
            // `NotFound` covers two opposite cases, and telling them apart is
            // the difference between an honest "this build cannot" and hiding
            // a real defect. A dev build has no `Contents/Library/LaunchAgents`
            // at all, so the switch is correctly unavailable. A *shipped*
            // bundle that has the plist and still gets `NotFound` has been
            // refused by macOS — leaving the switch enabled is what surfaces
            // the reason, because `register()` returns an NSError and a greyed
            // switch never calls it. (A label that is not prefixed by the app's
            // bundle id is exactly this case, and cost a whole signed build to
            // find the first time.)
            NOT_FOUND => {
                if bundled_plist_is_present() {
                    warn!(
                        "SMAppService rejected {}: the plist is in the bundle and status is still NotFound",
                        core::AGENT_PLIST_NAME
                    );
                    AutostartState::on(false)
                } else {
                    AutostartState::unsupported("not-bundled")
                }
            }
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

    /// Domain and code alongside the sentence. "The operation couldn't be
    /// completed. Operation not permitted" is what `localizedDescription`
    /// gives for a bare POSIX EPERM, and on its own it names neither who
    /// refused nor why — which cost a whole signed build to work out once.
    fn error_message(err: *mut AnyObject) -> Option<String> {
        if err.is_null() {
            return None;
        }
        unsafe {
            let desc: Option<Retained<NSString>> = msg_send![err, localizedDescription];
            let domain: Option<Retained<NSString>> = msg_send![err, domain];
            let code: isize = msg_send![err, code];
            let desc = desc.map(|d| d.to_string())?;
            Some(match domain {
                Some(d) => format!("{desc} ({}, code {code})", d.to_string()),
                None => format!("{desc} (code {code})"),
            })
        }
    }

    /// Register an arbitrary bundled agent by plist name and report what macOS
    /// said. Used by the Help-menu probe; the toggle goes through `set()`.
    pub fn register_agent_by_name(plist_name: &str) -> Result<isize, String> {
        let cls = AnyClass::get(c"SMAppService").ok_or("SMAppService needs macOS 13 or later")?;
        let svc: Retained<AnyObject> = unsafe {
            let name = NSString::from_str(plist_name);
            let svc: Option<Retained<AnyObject>> = msg_send![cls, agentServiceWithPlistName: &*name];
            svc.ok_or_else(|| format!("no agent service for {plist_name}"))?
        };
        // "If an app updates either the plist or the executable for a
        // LaunchAgent [...] the SMAppService must be re-registered or it may
        // not launch. It is recommended to also call unregister before
        // re-registering" — SMAppService.h. A probe is rebuilt constantly, so
        // it would otherwise keep launching the binary from the last run.
        let mut drop_err: *mut AnyObject = std::ptr::null_mut();
        let _: bool = unsafe { msg_send![&*svc, unregisterAndReturnError: &mut drop_err] };

        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = unsafe { msg_send![&*svc, registerAndReturnError: &mut err] };
        if ok {
            Ok(status(&svc))
        } else {
            Err(error_message(err).unwrap_or_else(|| "register refused, no NSError".into()))
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
    //! A `Run` value pointing at the app binary with `--daemon-only`. The NSIS
    //! uninstall hook (`src-tauri/windows/hooks.nsh`) deletes the same value.
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
