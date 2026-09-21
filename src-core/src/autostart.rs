//! "Keep the daemon running" — the parts that are pure text and paths.
//!
//! The OS calls themselves (SMAppService, writing the file, the registry)
//! live in `src-tauri/src/autostart.rs`, because registering a login item is
//! platform integration and CLAUDE.md keeps that in the shell. What is here
//! is everything a test can check without an OS: the LaunchAgent plist, the
//! XDG `.desktop` entry, the registry command line, and — the part that has
//! actually bitten before — *which executable path is still valid after a
//! reboot*.
//!
//! The one rule the whole module exists for: an autostart entry outlives the
//! process that wrote it. A path that is correct right now but ephemeral (an
//! AppImage's `/tmp/.mount_*` root, a snap revision directory) produces an
//! entry that silently stops working on the next launch, which is worse than
//! refusing to write one.

use std::path::{Path, PathBuf};

/// launchd label and the `.plist` basename inside `Contents/Library/LaunchAgents`.
/// Changing it orphans every already-registered agent, which the user can then
/// only remove in System Settings.
pub const AGENT_LABEL: &str = "com.mailvault.daemon";

/// The daemon sidecar's path relative to the app bundle root, as launchd's
/// `BundleProgram` wants it. Tauri's `externalBin` puts the sidecar next to
/// the app binary.
pub const AGENT_BUNDLE_PROGRAM: &str = "Contents/MacOS/mailvault-daemon";

/// Basename of the shipped agent plist, and the argument
/// `SMAppService.agent(plistName:)` takes.
pub const AGENT_PLIST_NAME: &str = "com.mailvault.daemon.plist";

/// Basename of the XDG autostart entry.
pub const LINUX_ENTRY_NAME: &str = "mailvault-daemon.desktop";

/// `HKEY_CURRENT_USER` run key and the value name under it.
pub const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
pub const WINDOWS_RUN_VALUE: &str = "MailVaultDaemon";

/// The flag that makes the app binary start the daemon and exit instead of
/// opening a window. Linux and Windows autostart both point at the *app*
/// binary rather than the sidecar: on Linux the sidecar's path depends on the
/// packaging (`/usr/bin` for a .deb, an ephemeral mount for an AppImage),
/// while the app binary has a stable launcher in every channel.
pub const DAEMON_ONLY_FLAG: &str = "--daemon-only";

/// Why a platform cannot offer the toggle. The frontend turns each into a
/// catalogue key, so the set is closed and the strings never reach the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    /// Strict snap confinement: `~/.config/autostart` is a dot-directory, which
    /// the `home` interface does not grant, and snapd owns session startup for
    /// snaps anyway.
    Snap,
    /// No path to the executable that survives a reboot.
    NoStableExecutable,
}

impl Unsupported {
    pub fn as_str(self) -> &'static str {
        match self {
            Unsupported::Snap => "snap",
            Unsupported::NoStableExecutable => "no-stable-executable",
        }
    }
}

/// The `.plist` that `SMAppService.agent(plistName:)` registers.
///
/// It is a *shipped* file (`src-tauri/LaunchAgents/`), not something written
/// at runtime: it lives inside `Contents/Library/LaunchAgents`, which the app's
/// code signature seals — writing it at runtime would break the signature and
/// launchd would refuse the agent. This function is therefore the single
/// source of truth that `the_shipped_plist_is_the_one_this_module_defines`
/// holds the shipped copy to.
///
/// `BundleProgram` and not `Program`: `Program` is an absolute path, and the
/// app can be anywhere the user dragged it. `BundleProgram` is resolved
/// against the registering bundle, so the agent follows the app.
///
/// `KeepAlive` is the plain boolean: the daemon is meant to be up for as long
/// as the user is logged in, and it exits only on SIGTERM (a vault move) or a
/// crash — both cases where coming straight back is what the setting
/// promised. `ProcessType Background` keeps it out of the UI's way.
pub fn launch_agent_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{AGENT_LABEL}</string>
    <key>BundleProgram</key>
    <string>{AGENT_BUNDLE_PROGRAM}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"#
    )
}

/// XDG autostart entry. `X-GNOME-Autostart-enabled` is what GNOME's own
/// Startup Applications writes; without it a user who has ever toggled the
/// entry there gets a file the desktop then ignores.
pub fn desktop_entry(exec: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=MailVault Daemon\n\
         Comment=Keeps MailVault syncing in the background\n\
         Exec={exec}\n\
         Terminal=false\n\
         NoDisplay=true\n\
         X-GNOME-Autostart-enabled=true\n"
    )
}

/// `<config home>/autostart/mailvault-daemon.desktop`.
pub fn linux_entry_path(config_home: &Path) -> PathBuf {
    config_home.join("autostart").join(LINUX_ENTRY_NAME)
}

/// What a `.desktop` `Exec=` (and the registry run value) should hold.
///
/// `appimage` is `$APPIMAGE`: inside a running AppImage `current_exe()` points
/// into the throwaway `/tmp/.mount_*` root, which is gone after the process
/// exits. The AppImage file itself is the only path that survives, and it
/// forwards its arguments to the app binary.
pub fn exec_command(current_exe: &Path, appimage: Option<&str>) -> Result<String, Unsupported> {
    let program = match appimage {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => current_exe.to_path_buf(),
    };
    if !program.is_absolute() {
        return Err(Unsupported::NoStableExecutable);
    }
    Ok(format!("{} {DAEMON_ONLY_FLAG}", quote(&program.to_string_lossy())))
}

/// Whether this Linux build can own an autostart entry at all.
///
/// Snap is refused rather than attempted: under strict confinement the write
/// fails with a bare permission error that reads to the user like a bug.
pub fn linux_supported(snap: Option<&str>) -> Result<(), Unsupported> {
    match snap {
        Some(s) if !s.trim().is_empty() => Err(Unsupported::Snap),
        _ => Ok(()),
    }
}

/// `~/.config` unless `XDG_CONFIG_HOME` names an absolute directory. A
/// relative `XDG_CONFIG_HOME` is invalid per the spec and is ignored, exactly
/// as the desktop itself ignores it.
pub fn config_home(xdg_config_home: Option<&str>, home: &Path) -> PathBuf {
    match xdg_config_home {
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        _ => home.join(".config"),
    }
}

/// Whether `frontend-settings.json` says the daemon should outlive app quit.
///
/// The app reads this inside `RunEvent::Exit`, when the webview is already
/// gone and nothing can be asked of the frontend — so it goes through the
/// persisted store, at the same `mailvault-settings.state` path Zustand
/// writes. Anything unreadable, unparseable or absent is "off": a corrupt
/// settings file costs a background daemon, never a stray one the user cannot
/// see or stop.
pub fn always_on_from_settings(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v["mailvault-settings"]["state"]["daemonAlwaysOn"].as_bool())
        .unwrap_or(false)
}

/// Wrap in double quotes only when the path needs it. An unquoted path is
/// what every hand-written `.desktop` carries, and quoting unconditionally
/// would make the common case look odd in `reg query` output too.
fn quote(path: &str) -> String {
    if path.contains(' ') {
        format!("\"{path}\"")
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plist_names_the_daemon_and_asks_launchd_to_keep_it_up() {
        let plist = launch_agent_plist();
        assert!(plist.contains("<string>com.mailvault.daemon</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n    <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n    <true/>"));
    }

    /// `Program` is absolute; the app can be anywhere the user dragged it. Only
    /// `BundleProgram` resolves against the registering bundle.
    #[test]
    fn the_plist_points_at_the_sidecar_relative_to_the_bundle() {
        let plist = launch_agent_plist();
        assert!(plist.contains("<key>BundleProgram</key>\n    <string>Contents/MacOS/mailvault-daemon</string>"));
        assert!(!plist.contains("<key>Program</key>"));
    }

    /// The shipped copy is what launchd reads — this module only *defines* it.
    /// A rename of the sidecar, or a hand-edit of the plist, has to fail here
    /// rather than at a user's login.
    #[test]
    fn the_shipped_plist_is_the_one_this_module_defines() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src-tauri/LaunchAgents")
            .join(AGENT_PLIST_NAME);
        let shipped = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} is not readable: {e}", path.display()));
        assert_eq!(shipped, launch_agent_plist());
    }

    #[test]
    fn the_desktop_entry_runs_the_exec_line_without_a_window() {
        let entry = desktop_entry("/usr/bin/mailvault --daemon-only");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Exec=/usr/bin/mailvault --daemon-only\n"));
        assert!(entry.contains("NoDisplay=true\n"));
        assert!(entry.contains("X-GNOME-Autostart-enabled=true\n"));
    }

    #[test]
    fn the_entry_lands_in_the_autostart_directory() {
        assert_eq!(
            linux_entry_path(Path::new("/home/rokas/.config")),
            PathBuf::from("/home/rokas/.config/autostart/mailvault-daemon.desktop")
        );
    }

    #[test]
    fn the_exec_line_carries_the_daemon_only_flag() {
        let cmd = exec_command(Path::new("/usr/bin/mailvault"), None).unwrap();
        assert_eq!(cmd, "/usr/bin/mailvault --daemon-only");
    }

    /// The whole reason `$APPIMAGE` is threaded through: `current_exe()` inside
    /// an AppImage is a mount point that does not exist on the next boot.
    #[test]
    fn an_appimage_writes_the_appimage_path_not_the_mount_point() {
        let cmd = exec_command(
            Path::new("/tmp/.mount_MailVaXY12/usr/bin/mailvault"),
            Some("/home/rokas/Apps/MailVault.AppImage"),
        )
        .unwrap();
        assert_eq!(cmd, "/home/rokas/Apps/MailVault.AppImage --daemon-only");
    }

    /// `$APPIMAGE` is set to an empty string by some launchers; that is "not an
    /// AppImage", not "an AppImage at the empty path".
    #[test]
    fn an_empty_appimage_variable_falls_back_to_the_executable() {
        let cmd = exec_command(Path::new("/usr/bin/mailvault"), Some("   ")).unwrap();
        assert_eq!(cmd, "/usr/bin/mailvault --daemon-only");
    }

    #[test]
    fn a_path_with_spaces_is_quoted() {
        let cmd = exec_command(Path::new("/opt/Mail Vault/mailvault"), None).unwrap();
        assert_eq!(cmd, "\"/opt/Mail Vault/mailvault\" --daemon-only");
    }

    /// A relative `current_exe()` means the entry would resolve against
    /// whatever directory the desktop happens to start in.
    #[test]
    fn a_relative_executable_is_refused() {
        assert_eq!(
            exec_command(Path::new("target/debug/mailvault"), None),
            Err(Unsupported::NoStableExecutable)
        );
    }

    #[test]
    fn the_persisted_flag_is_read_from_the_zustand_state_object() {
        let on = r#"{"mailvault-settings":{"state":{"daemonAlwaysOn":true},"version":5}}"#;
        let off = r#"{"mailvault-settings":{"state":{"daemonAlwaysOn":false}}}"#;
        assert!(always_on_from_settings(on));
        assert!(!always_on_from_settings(off));
    }

    /// Every way the file can disappoint reads as "off" — the app then stops
    /// the daemon at quit, which is the behaviour it has always had.
    #[test]
    fn anything_unreadable_means_off() {
        for raw in ["", "{}", "not json", r#"{"mailvault-settings":{}}"#,
                    r#"{"mailvault-settings":{"state":{}}}"#,
                    r#"{"mailvault-settings":{"state":{"daemonAlwaysOn":"yes"}}}"#] {
            assert!(!always_on_from_settings(raw), "{raw:?} should read as off");
        }
    }

    #[test]
    fn a_snap_build_is_refused_with_a_reason() {
        assert_eq!(linux_supported(Some("/snap/mailvault/42")), Err(Unsupported::Snap));
        assert_eq!(linux_supported(None), Ok(()));
        assert_eq!(linux_supported(Some("")), Ok(()));
    }

    #[test]
    fn config_home_prefers_an_absolute_xdg_override() {
        let home = Path::new("/home/rokas");
        assert_eq!(config_home(Some("/custom/cfg"), home), PathBuf::from("/custom/cfg"));
        assert_eq!(config_home(None, home), PathBuf::from("/home/rokas/.config"));
        // Relative overrides are invalid per the XDG spec; the desktop ignores them.
        assert_eq!(config_home(Some("cfg"), home), PathBuf::from("/home/rokas/.config"));
    }
}
