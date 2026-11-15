use base64::Engine;
use serde::Serialize;
use std::time::Duration;
use tracing::info;

// The SSRF gate lives in core (`guarded_http`): the phone's one-click unsubscribe uses it too.
pub(crate) use mailvault_core::guarded_http::send_guarded;
#[cfg(test)]
use mailvault_core::guarded_http::{is_blocked_ip, validate_redirect_target, validate_resolved, validate_url};

pub const MAX_ASSET_BYTES: usize = 5 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 10;

#[derive(Serialize)]
pub struct RemoteAsset {
    pub mime: String,
    pub base64: String,
    pub bytes: usize,
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

/// Fetch one remote asset for an export mirror.
///
/// Deliberately anonymous: no Referer, capped redirects and size, no cookie
/// store (`send_guarded`). The exported file is an archive, not a session.
pub async fn fetch_remote_asset(url: String) -> Result<RemoteAsset, String> {
    let response = send_guarded(&url, "export", Duration::from_secs(TIMEOUT_SECS), false, |c, u| c.get(u)).await?;

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
        let r = send_guarded("http://example.test/x", "export", Duration::from_secs(1), true, |c, u| c.get(u)).await;
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
