//! Which URLs may carry JMAP credentials.
//!
//! Every JMAP request carries the user's password or API token, so it goes
//! over https only. The one exception is a loopback mock: the debug-only
//! `MAILVAULT_JMAP_BASE` override (e2e), read the way `graph.rs` reads
//! `MAILVAULT_GRAPH_BASE`, and `allow_loopback_for_tests` for in-process
//! tests (an env var set inside a test races every parallel test).

use std::sync::OnceLock;
use tracing::warn;

/// `localhost` or a loopback IP literal (`127.0.0.1`, `[::1]`).
pub fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The e2e override: a plain-http loopback URL with no userinfo, trailing `/`
/// trimmed. Anything else is ignored, because a base anywhere else would be
/// handed the user's credentials.
pub fn resolve_jmap_override(env: Option<&str>) -> Option<String> {
    let raw = env.map(str::trim).filter(|s| !s.is_empty())?;
    let loopback = url::Url::parse(raw).ok().is_some_and(|url| {
        url.scheme() == "http"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(is_loopback_host)
    });
    if loopback {
        warn!("[JMAP] MAILVAULT_JMAP_BASE={}: requests may go to a loopback mock", raw);
        Some(raw.trim_end_matches('/').to_string())
    } else {
        warn!("[JMAP] MAILVAULT_JMAP_BASE={} ignored: not a loopback http URL", raw);
        None
    }
}

/// The override in force, read once.
pub fn jmap_override() -> Option<&'static str> {
    static BASE: OnceLock<Option<String>> = OnceLock::new();
    BASE.get_or_init(|| resolve_jmap_override(jmap_base_env().as_deref())).as_deref()
}

/// Read in debug builds only: a shipped binary ignores it, so whoever launches
/// MailVault cannot point the user's credentials at a listener of their own.
#[cfg(debug_assertions)]
fn jmap_base_env() -> Option<String> {
    std::env::var("MAILVAULT_JMAP_BASE").ok()
}

#[cfg(not(debug_assertions))]
fn jmap_base_env() -> Option<String> {
    None
}

#[cfg(any(test, debug_assertions))]
static TEST_LOOPBACK: OnceLock<()> = OnceLock::new();

/// Let this process send credentials to loopback http URLs (in-process tests
/// against `mock-jmap`). Set once, never cleared.
#[cfg(any(test, debug_assertions))]
pub fn allow_loopback_for_tests() {
    let _ = TEST_LOOPBACK.set(());
}

#[cfg(any(test, debug_assertions))]
fn test_loopback() -> bool {
    TEST_LOOPBACK.get().is_some()
}

#[cfg(not(any(test, debug_assertions)))]
fn test_loopback() -> bool {
    false
}

/// Whether loopback http URLs may carry credentials in this process.
pub fn override_active() -> bool {
    test_loopback() || jmap_override().is_some()
}

/// May a request to `url` carry credentials? https on any host; http only to
/// a loopback host, and only while the override is active.
pub fn url_allowed(url: &url::Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => override_active() && url.host_str().is_some_and(is_loopback_host),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jmap_override_accepts_only_plain_loopback_http() {
        assert_eq!(resolve_jmap_override(None), None);
        assert_eq!(resolve_jmap_override(Some("  ")), None);
        assert_eq!(resolve_jmap_override(Some("http://127.0.0.1:8080/")), Some("http://127.0.0.1:8080".to_string()));
        assert_eq!(resolve_jmap_override(Some("http://localhost:1")), Some("http://localhost:1".to_string()));
        assert_eq!(resolve_jmap_override(Some("http://[::1]:9")), Some("http://[::1]:9".to_string()));
        assert_eq!(resolve_jmap_override(Some("https://127.0.0.1:8080")), None);
        assert_eq!(resolve_jmap_override(Some("http://evil.example")), None);
        assert_eq!(resolve_jmap_override(Some("http://user:pw@127.0.0.1:1")), None);
    }

    #[test]
    fn https_is_allowed_anywhere_and_http_only_on_loopback() {
        allow_loopback_for_tests();
        let ok = |u: &str| url_allowed(&url::Url::parse(u).unwrap());
        assert!(ok("https://api.fastmail.com/jmap/session"));
        assert!(ok("https://www.fastmailusercontent.com/jmap/download/"));
        assert!(ok("http://127.0.0.1:4000/jmap/api"));
        assert!(!ok("http://evil.example/api"));
        assert!(!ok("ftp://127.0.0.1/"));
    }
}
