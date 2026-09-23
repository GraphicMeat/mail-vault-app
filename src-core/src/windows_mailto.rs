//! "Default email app" on Windows — the parts that are pure text.
//!
//! Windows lists an app under Settings > Default apps > MAILTO only when it is
//! a *registered application*: a ProgID that opens the link, a `Capabilities`
//! key whose `URLAssociations` names that ProgID for `mailto`, and a
//! `RegisteredApplications` value pointing at `Capabilities`. Registering the
//! bare scheme (what the deep-link plugin does) is not enough, which is why
//! MailVault never showed up in that list. The layout follows Thunderbird's
//! (`Software\Clients\Mail\<name>\Capabilities`), written per user under
//! `HKEY_CURRENT_USER` so it needs no elevation.
//!
//! Claiming the default is still the user's click: `UserChoice` is
//! hash-protected, so the app only opens Settings on its own page and reads
//! `UserChoice\ProgId` back afterwards. The registry writes live in
//! `src-tauri/src/mailto.rs`; the NSIS uninstall hook
//! (`src-tauri/windows/hooks.nsh`) deletes the same keys and must stay in step
//! with [`CLASS_KEY`], [`CLIENT_KEY`] and [`APP_NAME`].

/// The `RegisteredApplications` value name, and what the Settings deep link
/// passes as `registeredAppUser` — the two must match exactly.
pub const APP_NAME: &str = "MailVault";

/// The ProgID a `mailto:` link resolves to once the user picks MailVault.
pub const MAILTO_PROGID: &str = "MailVault.Url.mailto";

/// `HKCU` subkeys.
pub const CLASS_KEY: &str = r"Software\Classes\MailVault.Url.mailto";
pub const CLIENT_KEY: &str = r"Software\Clients\Mail\MailVault";
pub const CAPABILITIES_KEY: &str = r"Software\Clients\Mail\MailVault\Capabilities";
pub const REGISTERED_APPS_KEY: &str = r"Software\RegisteredApplications";
pub const USER_CHOICE_KEY: &str =
    r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice";

/// Opens Settings on MailVault's own default-apps page (Windows 11; Windows 10
/// ignores the query and shows the default-apps list).
pub const SETTINGS_URI: &str = "ms-settings:defaultapps?registeredAppUser=MailVault";

/// One registry string to write: `(HKCU subkey, value name, data)`. An empty
/// value name is the key's default value.
pub type RegValue = (&'static str, &'static str, String);

/// Every string MailVault writes to be listed as a mail handler, for the app
/// binary at `exe`. Rewritten on every launch so a moved install repoints.
pub fn registration(exe: &str) -> Vec<RegValue> {
    let icon = format!("\"{exe}\",0");
    vec![
        (CLASS_KEY, "", "URL:MailTo Protocol".into()),
        (CLASS_KEY, "FriendlyTypeName", "MailVault mail link".into()),
        (r"Software\Classes\MailVault.Url.mailto\DefaultIcon", "", icon.clone()),
        (
            r"Software\Classes\MailVault.Url.mailto\shell\open\command",
            "",
            format!("\"{exe}\" \"%1\""),
        ),
        (CLIENT_KEY, "", APP_NAME.into()),
        (CAPABILITIES_KEY, "ApplicationName", APP_NAME.into()),
        (
            CAPABILITIES_KEY,
            "ApplicationDescription",
            "Email client that keeps a local copy of your mail.".into(),
        ),
        (CAPABILITIES_KEY, "ApplicationIcon", icon),
        (
            r"Software\Clients\Mail\MailVault\Capabilities\URLAssociations",
            "mailto",
            MAILTO_PROGID.into(),
        ),
        (REGISTERED_APPS_KEY, APP_NAME, CAPABILITIES_KEY.into()),
    ]
}

/// Whether the ProgId under `UserChoice` is ours.
pub fn is_ours(progid: &str) -> bool {
    progid.trim().eq_ignore_ascii_case(MAILTO_PROGID)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\a b\AppData\Local\MailVault\MailVault.exe";

    fn value(key: &str, name: &str) -> String {
        registration(EXE)
            .into_iter()
            .find(|(k, n, _)| *k == key && *n == name)
            .map(|(_, _, v)| v)
            .unwrap_or_else(|| panic!("{key} / {name:?} not written"))
    }

    #[test]
    fn registered_applications_points_at_the_capabilities_key() {
        assert_eq!(value(REGISTERED_APPS_KEY, APP_NAME), CAPABILITIES_KEY);
    }

    #[test]
    fn capabilities_map_mailto_to_our_progid() {
        let assoc = format!(r"{CAPABILITIES_KEY}\URLAssociations");
        assert_eq!(value(&assoc, "mailto"), MAILTO_PROGID);
        assert_eq!(value(CAPABILITIES_KEY, "ApplicationName"), APP_NAME);
    }

    #[test]
    fn progid_opens_the_link_with_a_quoted_exe_path() {
        // Unquoted, a path with a space splits into two arguments and Windows
        // tries to launch `C:\Users\a`.
        let command = format!(r"{CLASS_KEY}\shell\open\command");
        assert_eq!(value(&command, ""), format!("\"{EXE}\" \"%1\""));
    }

    #[test]
    fn every_key_lives_under_our_own_class_or_client_key() {
        // The uninstall hook removes CLASS_KEY and CLIENT_KEY whole and one
        // value from RegisteredApplications; anything written elsewhere would
        // outlive the app.
        for (key, name, _) in registration(EXE) {
            let owned = key.starts_with(CLASS_KEY) || key.starts_with(CLIENT_KEY);
            let listed = key == REGISTERED_APPS_KEY && name == APP_NAME;
            assert!(owned || listed, "{key} / {name} would survive an uninstall");
        }
    }

    #[test]
    fn settings_deep_link_names_the_registered_app() {
        assert!(SETTINGS_URI.ends_with(&format!("registeredAppUser={APP_NAME}")));
    }

    #[test]
    fn recognises_only_our_progid() {
        assert!(is_ours("MailVault.Url.mailto"));
        assert!(is_ours(" mailvault.url.MAILTO\r\n"));
        for other in ["", "Outlook.URL.mailto.15", "Thunderbird.Url.mailto", "MailVault"] {
            assert!(!is_ours(other), "{other:?} must not read as ours");
        }
    }
}
