//! `mailto:` handed over by the OS.
//!
//! Two jobs live here. Delivery: URLs arrive from LaunchServices / xdg / the
//! Windows shell before the webview necessarily exists, so they queue here and
//! the frontend drains them. And status: whether we are the system's mail
//! handler, and what — if anything — we can do about it.
//!
//! The asymmetry that shapes the second half: an app may *register* as a mailto
//! handler on every desktop, but claiming the default is a per-OS negotiation.
//! Linux answers directly. macOS refuses the write from inside the App Sandbox
//! (OSStatus -54, `lsd`: "Unentitled request to set default handler for URL
//! scheme"), and our Developer ID build is sandboxed too — so the call is made
//! by an unsandboxed helper app the bundle carries, launched through
//! LaunchServices. Windows has never allowed it at all. So nothing here reports
//! a success it did not observe: every setter attempts, re-queries, and returns
//! what the re-query said.

use std::sync::Mutex;

/// URLs the OS has handed over that the frontend has not taken yet.
#[derive(Default)]
pub struct PendingMailto(Mutex<Vec<String>>);

impl PendingMailto {
    pub fn push(&self, url: String) {
        if let Ok(mut q) = self.0.lock() {
            q.push(url);
        }
    }

    /// Hands the queue to the caller and leaves it empty.
    pub fn take(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut q| std::mem::take(&mut *q))
            .unwrap_or_default()
    }
}

/// What the frontend needs to render the "Default email app" row.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailtoStatus {
    pub is_default: bool,
    /// Whether this platform lets us even attempt the change.
    pub can_set: bool,
    /// Key, never a sentence — the copy lives in the catalogs.
    pub hint: &'static str,
}

/// Desktop-entry names to try on Linux, in order.
///
/// The name is not knowable statically: deb and AppImage derive it from the
/// product name, and the snap builds `<snap>_<app>.desktop`.
// ponytail: fixed list; scan XDG_DATA_DIRS if a packaging format ever lands
// that none of these match.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const DESKTOP_CANDIDATES: &[&str] = &[
    "mailvault.desktop",
    "MailVault.desktop",
    "mailvault_mailvault.desktop",
];

/// Whether `xdg-settings get default-url-scheme-handler mailto` names us.
///
/// Compared case-insensitively so the deb/AppImage casing difference does not
/// have to be pinned down before the first build.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn is_ours(current: &str) -> bool {
    let current = current.trim();
    !current.is_empty()
        && DESKTOP_CANDIDATES
            .iter()
            .any(|c| c.eq_ignore_ascii_case(current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_every_desktop_entry_name_we_ship_under() {
        for name in ["mailvault.desktop", "MailVault.desktop", "mailvault_mailvault.desktop"] {
            assert!(is_ours(name), "{name} should be recognised as ours");
        }
    }

    #[test]
    fn tolerates_the_trailing_newline_xdg_settings_prints() {
        assert!(is_ours("mailvault.desktop\n"));
        assert!(is_ours("  MailVault.desktop  "));
    }

    #[test]
    fn does_not_claim_another_clients_registration() {
        for name in ["thunderbird.desktop", "evolution.desktop", "", "   ", "mailvault"] {
            assert!(!is_ours(name), "{name:?} must not read as ours");
        }
    }

    #[test]
    fn queue_hands_each_url_over_exactly_once() {
        let q = PendingMailto::default();
        q.push("mailto:a@b.test".into());
        q.push("mailto:c@d.test".into());

        assert_eq!(q.take(), vec!["mailto:a@b.test", "mailto:c@d.test"]);
        // The whole cold-start design rests on this: a second drain must not
        // reopen compose for a URL already delivered.
        assert!(q.take().is_empty());
    }
}

// ── Platform: is MailVault the system's mail handler, and can we change it? ──

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::process::Command;

    fn xdg_get() -> Option<String> {
        let out = Command::new("xdg-settings")
            .args(["get", "default-url-scheme-handler", "mailto"])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn status() -> MailtoStatus {
        match xdg_get() {
            // `xdg-settings` answered, so it is here and we may try a set.
            Some(current) => MailtoStatus {
                is_default: is_ours(&current),
                can_set: true,
                hint: "",
            },
            None => MailtoStatus { is_default: false, can_set: false, hint: "linux_manual" },
        }
    }

    pub fn make_default() -> MailtoStatus {
        for entry in DESKTOP_CANDIDATES {
            let _ = Command::new("xdg-settings")
                .args(["set", "default-url-scheme-handler", "mailto", entry])
                .output();
            // Believe the re-query, never the exit code: under snap confinement
            // the call can succeed and change nothing on the host.
            if xdg_get().is_some_and(|c| is_ours(&c)) {
                return MailtoStatus { is_default: true, can_set: true, hint: "" };
            }
        }
        MailtoStatus { is_default: false, can_set: false, hint: "linux_manual" }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    /// The bundle identifier macOS would launch for a `mailto:` link.
    fn current_handler() -> Option<String> {
        std::panic::catch_unwind(|| unsafe {
            let scheme = nsstring("mailto:");
            if scheme.is_null() {
                return None;
            }
            let url: *const Object = msg_send![class!(NSURL), URLWithString: scheme];
            if url.is_null() {
                return None;
            }
            let workspace: *const Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            let app_url: *const Object = msg_send![workspace, URLForApplicationToOpenURL: url];
            if app_url.is_null() {
                return None;
            }
            let bundle: *const Object = msg_send![class!(NSBundle), bundleWithURL: app_url];
            if bundle.is_null() {
                return None;
            }
            let ident: *const Object = msg_send![bundle, bundleIdentifier];
            let s = nsstring_to_string(ident);
            (!s.is_empty()).then_some(s)
        })
        .ok()
        .flatten()
    }

    unsafe fn nsstring(s: &str) -> *const Object {
        let cls = class!(NSString);
        let ns: *const Object = msg_send![cls, alloc];
        msg_send![ns, initWithBytes: s.as_ptr() length: s.len() encoding: 4usize]
    }

    unsafe fn nsstring_to_string(ns: *const Object) -> String {
        if ns.is_null() {
            return String::new();
        }
        let c_str: *const i8 = msg_send![ns, UTF8String];
        if c_str.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(c_str).to_string_lossy().into_owned()
    }

    fn is_default() -> bool {
        current_handler().is_some_and(|id| id.eq_ignore_ascii_case("com.mailvault.app"))
    }

    /// The unsandboxed helper that makes the change, when the bundle has one.
    ///
    /// `Contents/MacOS/<exe>` → `Contents/Helpers/…`. Absent in the Mac App
    /// Store build (`build-appstore.sh` strips it — the store requires every
    /// executable to be sandboxed) and in a plain `cargo build`, and the row
    /// falls back to instructions in both.
    fn helper_url() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let contents = exe.parent()?.parent()?;
        let helper = contents.join("Helpers/MailVault Default Mail Helper.app");
        helper.exists().then_some(helper)
    }

    pub fn status() -> MailtoStatus {
        let can_set = helper_url().is_some();
        MailtoStatus {
            is_default: is_default(),
            can_set,
            hint: if can_set { "" } else { "macos_mail_app" },
        }
    }

    /// Asks LaunchServices to run the helper, then watches for the change.
    ///
    /// The write itself is Thunderbird's — `LSSetDefaultHandlerForURLScheme`
    /// with our bundle id (comm-central `nsMacShellService.cpp`) — but it is
    /// refused inside the App Sandbox, so it happens over in the helper, which
    /// is not sandboxed. A sandboxed caller's launch *arguments* are dropped by
    /// LaunchServices too, hence a helper with one fixed job and no argv.
    pub fn make_default() -> MailtoStatus {
        let Some(helper) = helper_url() else { return status() };
        launch(&helper);

        // Believe the re-query, never the launch: the helper may still be
        // waiting on a consent dialog, and older macOS shows one.
        for _ in 0..25 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if is_default() {
                return MailtoStatus { is_default: true, can_set: true, hint: "" };
            }
        }
        MailtoStatus { is_default: false, can_set: true, hint: "macos_confirm" }
    }

    fn launch(helper: &std::path::Path) {
        let _ = std::panic::catch_unwind(|| unsafe {
            let path = nsstring(&helper.to_string_lossy());
            if path.is_null() {
                return;
            }
            let url: *const Object = msg_send![class!(NSURL), fileURLWithPath: path];
            let cfg: *mut Object = msg_send![class!(NSWorkspaceOpenConfiguration), configuration];
            if url.is_null() || cfg.is_null() {
                return;
            }
            // No stealing focus: the helper has no UI of its own.
            let _: () = msg_send![cfg, setActivates: objc::runtime::NO];
            let workspace: *const Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            // The completion handler is nullable, and the poll above is the only
            // answer worth having anyway.
            let done: *const std::ffi::c_void = std::ptr::null();
            let _: () = msg_send![
                workspace,
                openApplicationAtURL: url
                configuration: cfg
                completionHandler: done
            ];
        });
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    /// Dormant. There is no Windows build yet — no job in `release.yml` and no
    /// signing — so this compiles and ships nothing, and nobody has run it.
    ///
    /// Windows has never allowed an app to claim a default: `UserChoice` is
    /// hash-protected, so the only honest move is to send the user to Settings.
    // ponytail: reads no registry. When a Windows build actually exists, query
    // `HKCU\...\mailto\UserChoice\ProgId` here so the row can say "yes".
    pub fn status() -> MailtoStatus {
        MailtoStatus { is_default: false, can_set: false, hint: "windows_settings" }
    }

    pub fn make_default() -> MailtoStatus {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .spawn();
        status()
    }
}

pub use platform::{make_default, status};
