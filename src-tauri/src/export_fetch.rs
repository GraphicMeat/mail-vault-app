use base64::Engine;
use serde::Serialize;
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

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("bad url: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refused scheme: {}", parsed.scheme()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("refused: credentials in url".into());
    }
    Ok(parsed)
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
/// Deliberately anonymous: no Referer, capped redirects and size. reqwest is
/// built here without the `cookies` feature, so the client has no cookie store
/// to disable — the fetch cannot carry the user's session anywhere, which is
/// the point: the exported file is an archive, not a session.
#[tauri::command]
pub async fn fetch_remote_asset(url: String) -> Result<RemoteAsset, String> {
    let parsed = validate_url(&url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;

    let response = client
        .get(parsed)
        .header(reqwest::header::REFERER, "")
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;

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
}
