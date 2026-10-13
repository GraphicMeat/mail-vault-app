//! One remote image for the Blitz worker: https only, image/* only, capped,
//! anonymous (`export_fetch::send_guarded`: SSRF guard, no Referer, no cookies).
//! Shown in Network Activity as "email images".
use crate::export_fetch::{send_guarded, MAX_ASSET_BYTES};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

fn validate_image_mime(mime: &str) -> Result<(), String> {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if base.starts_with("image/") { Ok(()) } else { Err(format!("refused content-type: {}", base)) }
}

pub async fn fetch_render_image(url: &str) -> Result<Vec<u8>, String> {
    let response = send_guarded(url, "email images", TIMEOUT, true, |c, u| c.get(u)).await?;
    if !response.status().is_success() {
        return Err(format!("http {}", response.status().as_u16()));
    }
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    validate_image_mime(&mime)?;
    if response.content_length().is_some_and(|n| n as usize > MAX_ASSET_BYTES) {
        return Err("asset over cap".into());
    }
    let bytes = response.bytes().await.map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err("asset over cap".into());
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn render_image_fetch_is_https_only() {
        let err = fetch_render_image("http://example.com/a.png").await.unwrap_err();
        assert!(err.contains("refused scheme"), "{err}");
    }

    #[tokio::test]
    async fn render_image_fetch_refuses_loopback() {
        assert!(fetch_render_image("https://127.0.0.1/a.png").await.is_err());
    }

    #[test]
    fn render_image_mime_accepts_only_images() {
        assert!(validate_image_mime("image/png").is_ok());
        assert!(validate_image_mime("image/svg+xml; charset=utf-8").is_ok());
        assert!(validate_image_mime("text/css").is_err());
        assert!(validate_image_mime("font/woff2").is_err());
    }
}
