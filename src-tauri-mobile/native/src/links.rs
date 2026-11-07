//! What a navigation of the app's webview may do. Every navigation the webview asks about comes
//! here: the app page's own load, the mail frame's `srcdoc`, and a link tapped in the mail, which
//! the frame's `<base target="_blank">` turns into a new-window request (iOS asks about it here,
//! with no target frame). Android never asks: its popup is caught in a bare, unshown WebView by the
//! plugin's `PopupChromeClient`, which applies the same rule in Kotlin (`PopupUrlPolicy`) and hands
//! the URL straight to the system, never to the app's WebView. Nothing but the app's own page and
//! the frame's document ever loads in the webview: a web or mail link is handed to the system
//! (browser, mail app) and the navigation is cancelled, everything else is cancelled.
//! The mail cleaner already keeps only http(s) and mailto links; this is the shell's own check.

use url::Url;

/// The origin the app page is served from: `tauri://localhost` on iOS, `http(s)://tauri.localhost`
/// on Android. Only that platform's form counts, so a mail link to the other form leaves the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppOrigin {
    /// iOS (and macOS): the `tauri` custom scheme on host `localhost`.
    TauriScheme,
    /// Android (and Windows): `http` or `https` on host `tauri.localhost`.
    TauriLocalhost,
}

impl AppOrigin {
    /// This build's form.
    pub const fn current() -> Self {
        if cfg!(any(target_os = "android", windows)) {
            AppOrigin::TauriLocalhost
        } else {
            AppOrigin::TauriScheme
        }
    }

    fn matches(self, url: &Url) -> bool {
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            return false;
        }
        match self {
            AppOrigin::TauriScheme => url.scheme() == "tauri" && url.host_str() == Some("localhost"),
            AppOrigin::TauriLocalhost => {
                matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
            }
        }
    }
}

/// The verdict on one navigation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Nav {
    /// Let it load in the webview: the app page or the mail frame's own document.
    Allow,
    /// Cancel it and hand this URL to the system (browser for http/https, mail app for mailto).
    External(String),
    /// Cancel it; nothing opens.
    Deny,
}

/// Longer URLs are refused outright; no mail link needs this much.
pub const MAX_URL_LEN: usize = 32 * 1024;

/// The verdict for `url` in a webview served from `app`.
pub fn decide(url: &Url, app: AppOrigin) -> Nav {
    if url.as_str().len() > MAX_URL_LEN {
        return Nav::Deny;
    }
    if app.matches(url) {
        return Nav::Allow;
    }
    match url.scheme() {
        // The mail frame's document (`srcdoc`) and an empty frame. Nothing else under `about:`.
        "about" => {
            if matches!(url.path(), "srcdoc" | "blank") && url.query().is_none() {
                Nav::Allow
            } else {
                Nav::Deny
            }
        }
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Nav::External(url.as_str().to_string()),
        "mailto" => Nav::External(url.as_str().to_string()),
        // javascript:, data:, blob:, file:, intent:, tauri: (any other host), ipc:, content:, ...
        _ => Nav::Deny,
    }
}

/// `decide` on a raw string, for callers that hold one. A string that does not parse is denied.
pub fn decide_str(url: &str, app: AppOrigin) -> Nav {
    match Url::parse(url) {
        Ok(u) => decide(&u, app),
        Err(_) => Nav::Deny,
    }
}

/// The scheme of a verdict, for a log line that must not carry the URL itself.
pub fn scheme_of(url: &Url) -> &str {
    match url.scheme() {
        s @ ("http" | "https" | "mailto" | "about" | "tauri") => s,
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IOS: AppOrigin = AppOrigin::TauriScheme;
    const ANDROID: AppOrigin = AppOrigin::TauriLocalhost;

    fn d(url: &str, app: AppOrigin) -> Nav {
        decide_str(url, app)
    }

    #[test]
    fn app_page_loads_on_its_own_platform() {
        assert_eq!(d("tauri://localhost/mobile.html", IOS), Nav::Allow);
        assert_eq!(d("tauri://localhost/mobile.html?ui=viewer", IOS), Nav::Allow);
        assert_eq!(d("http://tauri.localhost/mobile.html", ANDROID), Nav::Allow);
        assert_eq!(d("https://tauri.localhost/mobile.html", ANDROID), Nav::Allow);
    }

    #[test]
    fn the_other_platforms_app_origin_is_not_the_app() {
        // On iOS, http://tauri.localhost is a web host like any other: it leaves the app.
        assert_eq!(d("http://tauri.localhost/x", IOS), Nav::External("http://tauri.localhost/x".into()));
        // On Android, tauri://localhost is not a scheme anyone serves: denied.
        assert_eq!(d("tauri://localhost/mobile.html", ANDROID), Nav::Deny);
    }

    #[test]
    fn app_origin_lookalikes_are_not_the_app() {
        assert_eq!(d("tauri://evil.test/mobile.html", IOS), Nav::Deny);
        assert_eq!(d("tauri://user@localhost/mobile.html", IOS), Nav::Deny);
        assert_eq!(d("http://tauri.localhost:8080/", ANDROID), Nav::External("http://tauri.localhost:8080/".into()));
        assert_eq!(d("http://tauri.localhost.evil.test/", ANDROID), Nav::External("http://tauri.localhost.evil.test/".into()));
        assert_eq!(d("http://a:b@tauri.localhost/", ANDROID), Nav::External("http://a:b@tauri.localhost/".into()));
    }

    #[test]
    fn mail_frame_document_loads() {
        for app in [IOS, ANDROID] {
            assert_eq!(d("about:srcdoc", app), Nav::Allow);
            assert_eq!(d("about:blank", app), Nav::Allow);
            assert_eq!(d("about:blank?x=1", app), Nav::Deny);
            assert_eq!(d("about:config", app), Nav::Deny);
        }
    }

    #[test]
    fn web_and_mail_links_go_to_the_system() {
        for app in [IOS, ANDROID] {
            assert_eq!(d("https://example.com/a?b=c#d", app), Nav::External("https://example.com/a?b=c#d".into()));
            assert_eq!(d("http://example.com", app), Nav::External("http://example.com/".into()));
            assert_eq!(d("mailto:ada@example.test?subject=Hi", app), Nav::External("mailto:ada@example.test?subject=Hi".into()));
            assert_eq!(d("HTTPS://EXAMPLE.COM/", app), Nav::External("https://example.com/".into()));
        }
    }

    #[test]
    fn everything_else_is_denied() {
        for app in [IOS, ANDROID] {
            for url in [
                "javascript:alert(1)",
                "JavaScript:alert(1)",
                "data:text/html,<script>alert(1)</script>",
                "file:///etc/passwd",
                "blob:https://example.com/0f0e",
                "intent://scan/#Intent;scheme=zxing;package=com.evil;end",
                "intent:#Intent;component=com.mailvault.app/.MainActivity;end",
                "content://com.mailvault.app.fileprovider/share/x",
                "tel:+15550100",
                "sms:+15550100",
                "ipc://localhost/plugin",
                "tauri://evil/",
                "ftp://example.com/",
                "ws://example.com/",
                "market://details?id=com.evil",
                "not a url",
                "",
            ] {
                assert_eq!(d(url, app), Nav::Deny, "{url} on {app:?}");
            }
        }
    }

    #[test]
    fn very_long_urls_are_denied() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(d(&long, IOS), Nav::Deny);
        let ok = format!("https://example.com/{}", "a".repeat(1000));
        assert!(matches!(d(&ok, IOS), Nav::External(_)));
    }

    #[test]
    fn current_platform_is_the_ios_form_on_this_host() {
        if cfg!(target_os = "android") {
            assert_eq!(AppOrigin::current(), ANDROID);
        } else if !cfg!(windows) {
            assert_eq!(AppOrigin::current(), IOS);
        }
    }

    #[test]
    fn log_scheme_never_carries_the_url() {
        assert_eq!(scheme_of(&Url::parse("https://secret.example/?token=1").unwrap()), "https");
        assert_eq!(scheme_of(&Url::parse("intent://x").unwrap()), "other");
    }
}
