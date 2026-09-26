use base64::Engine;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use tracing::info;

pub const MAX_ASSET_BYTES: usize = 5 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 10;
const MAX_REDIRECTS: usize = 3;

#[derive(Serialize)]
pub struct RemoteAsset {
    pub mime: String,
    pub base64: String,
    pub bytes: usize,
}

/// True for loopback/private/link-local/unspecified/multicast/broadcast
/// addresses and known cloud metadata endpoints (169.254.169.254 and its
/// IPv6 equivalents) — anything a server-side fetch must not reach.
fn is_blocked_ip(ip: &IpAddr) -> bool {
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

fn is_blocked_ipv4(v4: &Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local() // covers 169.254.169.254
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_broadcast()
        || v4.is_documentation()
}

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
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
fn validate_redirect_target(base: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
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
async fn validate_resolved(parsed: &reqwest::Url) -> Result<(), String> {
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

fn validate_mime(mime: &str) -> Result<(), String> {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if base.starts_with("image/") || base.starts_with("font/") || base == "text/css" {
        Ok(())
    } else {
        Err(format!("refused content-type: {}", base))
    }
}

fn check_declared_len(len: Option<usize>) -> Result<(), String> {
    match len {
        Some(n) if n > MAX_ASSET_BYTES => Err("asset over cap".into()),
        _ => Ok(()),
    }
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
pub(crate) async fn send_guarded(
    url: &str,
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

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;

    let mut redirects = 0;
    loop {
        let response = build(&client, parsed.clone())
            .header(reqwest::header::REFERER, "")
            .send()
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

/// Fetch one remote asset for an export mirror.
///
/// Deliberately anonymous: no Referer, capped redirects and size, no cookie
/// store (`send_guarded`). The exported file is an archive, not a session.
pub async fn fetch_remote_asset(url: String) -> Result<RemoteAsset, String> {
    let response = send_guarded(&url, Duration::from_secs(TIMEOUT_SECS), false, |c, u| c.get(u)).await?;

    if !response.status().is_success() {
        return Err(format!("http {}", response.status().as_u16()));
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    validate_mime(&mime)?;

    check_declared_len(response.content_length().map(|n| n as usize))?;

    let bytes = response.bytes().await.map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err("asset over cap".into());
    }

    info!("fetch_remote_asset mirrored {} bytes of {}", bytes.len(), mime);

    Ok(RemoteAsset {
        mime: mime.split(';').next().unwrap_or("application/octet-stream").trim().to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        bytes: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("ftp://x.test/a.png").is_err());
        assert!(validate_url("data:image/png;base64,AAAA").is_err());
    }

    #[test]
    fn rejects_credentials_in_url() {
        assert!(validate_url("https://user:pass@x.test/a.png").is_err());
    }

    #[test]
    fn accepts_plain_http_and_https() {
        assert!(validate_url("http://x.test/a.png").is_ok());
        assert!(validate_url("https://x.test/a.png").is_ok());
    }

    #[test]
    fn accepts_only_mirrorable_content_types() {
        assert!(validate_mime("image/png").is_ok());
        assert!(validate_mime("image/svg+xml").is_ok());
        assert!(validate_mime("text/css").is_ok());
        assert!(validate_mime("font/woff2").is_ok());
        assert!(validate_mime("text/html").is_err());
        assert!(validate_mime("application/octet-stream").is_err());
    }

    #[test]
    fn refuses_declared_length_over_cap() {
        assert!(check_declared_len(Some(MAX_ASSET_BYTES + 1)).is_err());
        assert!(check_declared_len(Some(MAX_ASSET_BYTES)).is_ok());
        assert!(check_declared_len(None).is_ok());
    }

    #[test]
    fn blocks_reserved_ipv4_ranges() {
        assert!(is_blocked_ip(&"127.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip(&"10.0.0.5".parse().unwrap()));
        assert!(is_blocked_ip(&"192.168.1.1".parse().unwrap()));
        assert!(is_blocked_ip(&"169.254.169.254".parse().unwrap())); // AWS/GCP metadata
        assert!(is_blocked_ip(&"0.0.0.0".parse().unwrap()));
        assert!(is_blocked_ip(&"224.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip(&"255.255.255.255".parse().unwrap()));
        assert!(!is_blocked_ip(&"93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn blocks_reserved_ipv6_ranges() {
        assert!(is_blocked_ip(&"::1".parse().unwrap()));
        assert!(is_blocked_ip(&"fc00::1".parse().unwrap())); // unique local
        assert!(is_blocked_ip(&"fe80::1".parse().unwrap())); // link-local
        assert!(is_blocked_ip(&"fd00:ec2::254".parse().unwrap())); // AWS v6 metadata (ULA)
        assert!(is_blocked_ip(&"::ffff:169.254.169.254".parse().unwrap())); // v4-mapped metadata
        assert!(!is_blocked_ip(&"2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()));
    }

    #[test]
    fn rejects_bare_blocked_ip_literals() {
        assert!(validate_url("http://127.0.0.1/x").is_err());
        assert!(validate_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_url("http://[::1]/x").is_err());
        assert!(validate_url("http://93.184.216.34/x").is_ok());
    }

    #[tokio::test]
    async fn https_only_refuses_plain_http_before_any_request() {
        let r = send_guarded("http://example.test/x", Duration::from_secs(1), true, |c, u| c.get(u)).await;
        assert!(r.unwrap_err().contains("refused scheme"));
    }

    #[tokio::test]
    async fn rejects_hostname_resolving_to_loopback() {
        let url = reqwest::Url::parse("http://localhost/x").unwrap();
        assert!(validate_resolved(&url).await.is_err());
    }

    // The redirect hop's own gate: pure and synchronous, so it's exercised
    // directly rather than via a real server + fetch_remote_asset (a real
    // local test server would itself be on loopback -- exactly what the
    // *initial*-fetch check blocks -- so an end-to-end test could never
    // reach the redirect branch at all).

    #[test]
    fn rejects_redirect_to_metadata_address() {
        let base = reqwest::Url::parse("http://example.test/start.png").unwrap();
        assert!(validate_redirect_target(&base, "http://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn rejects_redirect_to_loopback_literal() {
        let base = reqwest::Url::parse("http://example.test/start.png").unwrap();
        assert!(validate_redirect_target(&base, "http://127.0.0.1:1/internal").is_err());
    }

    #[test]
    fn rejects_redirect_with_credentials() {
        let base = reqwest::Url::parse("http://example.test/start.png").unwrap();
        assert!(validate_redirect_target(&base, "http://user:pass@example.test/x").is_err());
    }

    #[test]
    fn rejects_redirect_to_non_http_scheme() {
        let base = reqwest::Url::parse("http://example.test/start.png").unwrap();
        assert!(validate_redirect_target(&base, "file:///etc/passwd").is_err());
    }

    #[test]
    fn accepts_a_relative_redirect_to_a_safe_path() {
        let base = reqwest::Url::parse("http://example.test/start.png").unwrap();
        let next = validate_redirect_target(&base, "/other.png").unwrap();
        assert_eq!(next.as_str(), "http://example.test/other.png");
    }

    #[tokio::test]
    async fn rejects_redirect_to_a_hostname_resolving_to_loopback() {
        let base = reqwest::Url::parse("http://example.test/start.png").unwrap();
        let next = validate_redirect_target(&base, "http://localhost/internal").unwrap();
        assert!(validate_resolved(&next).await.is_err());
    }
}
