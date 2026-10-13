//! Blitz reader tiles (module `blitz-render`). The shell renders nothing: it
//! forwards `mvrender://…/<docId>/<rev>/<index>` to the daemon's `render.tile`
//! and hands back the PNG bytes. Delete this file and its cfg lines in main.rs
//! to remove the module from the shell.
use base64::Engine;
use std::time::Duration;

/// Concrete `Wry`: `crate::daemon_rpc` is a `#[tauri::command]` over the
/// default-runtime `AppHandle`, so a generic runtime would not type-check.
pub fn register(b: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    b.register_asynchronous_uri_scheme_protocol("mvrender", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let path = request.uri().path().to_string();
        tauri::async_runtime::spawn(async move {
            let not_found = || tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
            let Some((doc, _rev, index)) = parse_tile_path(&path) else { return responder.respond(not_found()) };
            let reply = crate::daemon_rpc(app, "render.tile".into(), serde_json::json!({"docId": doc, "index": index})).await;
            let png = reply.ok()
                .and_then(|v| v["png"].as_str().map(str::to_owned))
                .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
            responder.respond(match png {
                Some(bytes) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "image/png")
                    .header("Cache-Control", "private, max-age=31536000, immutable")
                    .body(bytes)
                    .unwrap(),
                None => not_found(),
            });
        });
    })
}

/// Budgets just above the daemon's own (open 8 s, tile 4 s), so the daemon's
/// `render_unavailable` arrives first. Everything else in the family is quick.
pub fn reply_timeout(method: &str) -> Option<Duration> {
    match method {
        "render.open" => Some(Duration::from_secs(10)),
        "render.tile" | "render.textRuns" => Some(Duration::from_secs(6)),
        "render.image" => Some(Duration::from_secs(30)),
        "render.inspect" => Some(Duration::from_secs(6)),
        m if m.starts_with("render.") => Some(Duration::from_secs(3)),
        _ => None,
    }
}

/// `convertFileSrc` percent-encodes the slashes; other callers may not.
fn parse_tile_path(path: &str) -> Option<(u64, u32, u32)> {
    let decoded = path.trim_start_matches('/').replace("%2F", "/").replace("%2f", "/");
    let mut it = decoded.split('/');
    let (d, r, i) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    Some((d.parse().ok()?, r.parse().ok()?, i.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parse_tile_path_accepts_encoded_and_plain_separators() {
        assert_eq!(parse_tile_path("/7%2F3%2F0"), Some((7, 3, 0)));
        assert_eq!(parse_tile_path("/7/3/12"), Some((7, 3, 12)));
        assert_eq!(parse_tile_path("7%2f3%2f1"), Some((7, 3, 1)));
    }

    #[test]
    fn parse_tile_path_rejects_garbage() {
        for p in ["/", "/a/b/c", "/1/2", "/1/2/3/4", "/../../etc", "/1/2/-3"] {
            assert_eq!(parse_tile_path(p), None, "{p}");
        }
    }

    #[test]
    fn reply_timeout_bounds_the_render_family_and_ignores_the_rest() {
        assert_eq!(reply_timeout("render.open"), Some(Duration::from_secs(10)));
        assert_eq!(reply_timeout("render.tile"), Some(Duration::from_secs(6)));
        assert_eq!(reply_timeout("render.textRuns"), Some(Duration::from_secs(6)));
        assert_eq!(reply_timeout("render.image"), Some(Duration::from_secs(30)));
        assert_eq!(reply_timeout("render.inspect"), Some(Duration::from_secs(6)));
        for m in ["render.hit", "render.close", "render.fonts", "render.serialize", "render.fold"] {
            assert_eq!(reply_timeout(m), Some(Duration::from_secs(3)), "{m}");
        }
        assert_eq!(reply_timeout("maildir_read"), None);
    }
}
