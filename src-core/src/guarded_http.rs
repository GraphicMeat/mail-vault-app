//! The SSRF gate for a request to a URL that came from mail or a page (export mirrors, BIMI
//! logos, one-click unsubscribe on desktop and phone): http(s) only, no credentials in the URL,
//! no literal or resolved address in a loopback, private, link-local, metadata or multicast range,
//! and every redirect hop checked again by hand. Moved here from the daemon's `export_fetch` so the
//! phone engine sends through the same gate.
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

const MAX_REDIRECTS: usize = 3;

/// True for loopback/private/link-local/unspecified/multicast/broadcast
/// addresses and known cloud metadata endpoints (169.254.169.254 and its
/// IPv6 equivalents) — anything a server-side fetch must not reach.
pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_ipv4(&mapped);
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

pub fn is_blocked_ipv4(v4: &Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local() // covers 169.254.169.254
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_broadcast()
        || v4.is_documentation()
}

pub fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("bad url: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refused scheme: {}", parsed.scheme()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("refused: credentials in url".into());
    }
    // A literal IP in the URL bypasses DNS entirely, so reject reserved
    // ranges here before any lookup happens.
    if let Some(url::Host::Ipv4(v4)) = parsed.host() {
        if is_blocked_ipv4(&v4) {
            return Err("refused: blocked ip literal".into());
        }
    }
    if let Some(url::Host::Ipv6(v6)) = parsed.host() {
        if is_blocked_ip(&IpAddr::V6(v6)) {
            return Err("refused: blocked ip literal".into());
        }
    }
    Ok(parsed)
}

/// Resolve a redirect `Location` header against the URL it came from and
/// re-run every static check `validate_url` runs on the original URL. Split
/// out from the redirect loop (and kept synchronous) so it can be unit
/// tested directly, without needing a real server to drive a real redirect.
pub fn validate_redirect_target(base: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = base.join(location).map_err(|e| format!("bad redirect: {}", e))?;
    if !matches!(next.scheme(), "http" | "https") {
        return Err(format!("refused redirect scheme: {}", next.scheme()));
    }
    if !next.username().is_empty() || next.password().is_some() {
        return Err("refused: credentials in redirect url".into());
    }
    validate_url(next.as_str())
}

/// Resolve the URL's host and reject it if any resolved address is blocked.
/// This is the SSRF gate: scheme/credential checks alone don't stop a
/// hostname (or an open-redirect hop) from resolving to loopback, a private
/// range, link-local, or a cloud metadata address.
pub async fn validate_resolved(parsed: &reqwest::Url) -> Result<(), String> {
    let host = parsed.host_str().ok_or_else(|| "refused: no host".to_string())?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("dns lookup failed: {}", e))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_blocked_ip(&addr.ip()) {
            return Err(format!("refused: {} resolves to blocked address {}", host, addr.ip()));
        }
    }
    if !any {
        return Err("refused: host resolved to no addresses".into());
    }
    Ok(())
}

/// Send one request through the SSRF gate, following up to `MAX_REDIRECTS`
/// redirects by hand. Also the transport for one-click unsubscribe and BIMI
/// logos (`handlers::unsubscribe`), which pass `https_only` so no hop may
/// drop to plain http.
///
/// Redirects are followed manually (Policy::none()) so each hop's resolved
/// address can be re-checked: reqwest's built-in redirect policy runs
/// synchronously and can't do the async DNS lookup an SSRF check needs, so a
/// hop could otherwise land on a blocked address. `build` makes the request
/// for each hop. reqwest is built here without the `cookies` feature, so the
/// client has no cookie store: nothing sent carries the user's session.
pub async fn send_guarded(
    url: &str,
    purpose: &str,
    timeout: Duration,
    https_only: bool,
    build: impl Fn(&reqwest::Client, reqwest::Url) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let scheme_ok = |u: &reqwest::Url| {
        if https_only && u.scheme() != "https" {
            Err(format!("refused scheme: {}", u.scheme()))
        } else {
            Ok(())
        }
    };
    let mut parsed = validate_url(url)?;
    scheme_ok(&parsed)?;
    validate_resolved(&parsed).await?;

    // One Network Activity event per hop: a hop can change host.
    let client = crate::net_activity::http_client_with(
        purpose,
        reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()),
    );

    let mut redirects = 0;
    loop {
        let response = client
            .send(build(&client, parsed.clone()).header(reqwest::header::REFERER, ""))
            .await
            .map_err(|e| format!("fetch failed: {}", e))?;

        if !response.status().is_redirection() {
            return Ok(response);
        }
        redirects += 1;
        if redirects > MAX_REDIRECTS {
            return Err("too many redirects".into());
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "redirect with no location".to_string())?;
        let next = validate_redirect_target(&parsed, location)?;
        scheme_ok(&next)?;
        validate_resolved(&next).await?;
        parsed = next;
    }
}
