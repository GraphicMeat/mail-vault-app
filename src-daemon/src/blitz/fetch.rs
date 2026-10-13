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

/// Append one body chunk, refusing the moment the running total passes `cap`.
/// The caller stops reading then, so a server that never ends costs `cap`
/// bytes of memory, not its bandwidth for the whole timeout.
fn push_capped(body: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > cap {
        return Err("asset over cap".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

pub async fn fetch_render_image(url: &str) -> Result<Vec<u8>, String> {
    let mut response = send_guarded(url, "email images", TIMEOUT, true, |c, u| c.get(u)).await?;
    if !response.status().is_success() {
        return Err(format!("http {}", response.status().as_u16()));
    }
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    validate_image_mime(&mime)?;
    if response.content_length().is_some_and(|n| n as usize > MAX_ASSET_BYTES) {
        return Err("asset over cap".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("read failed: {}", e))? {
        push_capped(&mut body, &chunk, MAX_ASSET_BYTES)?;
    }
    Ok(body)
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
        // Without the SSRF guard this is a refused connection, which is also an
        // Err; the guard's own text is what proves the address was blocked.
        let err = fetch_render_image("https://127.0.0.1/a.png").await.unwrap_err();
        assert!(err.contains("blocked"), "{err}");
    }

    #[test]
    fn the_body_cap_stops_at_the_cap_chunk_by_chunk() {
        let mut body = Vec::new();
        assert!(push_capped(&mut body, &[1; 6], 10).is_ok());
        assert!(push_capped(&mut body, &[2; 4], 10).is_ok(), "exactly the cap is fine");
        assert_eq!(body.len(), 10);
        assert_eq!(push_capped(&mut body, &[3], 10).unwrap_err(), "asset over cap");
        assert_eq!(body.len(), 10, "the refused chunk is not kept");
        let mut huge = Vec::new();
        assert!(push_capped(&mut huge, &[0; 8], usize::MAX).is_ok());
        assert!(push_capped(&mut huge, &[0; 1], 4).is_err(), "no overflow on the running total");
    }

    #[test]
    fn render_image_mime_accepts_only_images() {
        assert!(validate_image_mime("image/png").is_ok());
        assert!(validate_image_mime("image/svg+xml; charset=utf-8").is_ok());
        assert!(validate_image_mime("text/css").is_err());
        assert!(validate_image_mime("font/woff2").is_err());
    }
}
