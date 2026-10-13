//! `render.*`: the Blitz reader. Thin: validate params, forward to RenderHost.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;

/// Check `render.open` params and return the frame the worker gets, with
/// defaults filled in. A bad request is refused here: the worker would drop
/// a line it cannot parse, and the caller would wait out the open timeout.
/// The size message is the error code the failure view already knows.
pub(crate) fn validate_open(p: &Value) -> Result<Value, String> {
    let html = p["html"].as_str().ok_or("html must be a string")?;
    if html.len() > mailvault_render::MAX_HTML_BYTES {
        return Err("render_too_large".into());
    }
    let max_w = mailvault_render::MAX_CSS_WIDTH as u64;
    let css_width = match p["cssWidth"].as_u64() {
        Some(w) if (1..=max_w).contains(&w) => w,
        _ => return Err(format!("cssWidth must be an integer 1..={max_w}")),
    };
    let (lo, hi) = (mailvault_render::MIN_SCALE as f64, mailvault_render::MAX_SCALE as f64);
    let scale = match &p["scale"] {
        Value::Null => 1.0,
        v => match v.as_f64() {
            Some(s) if (lo..=hi).contains(&s) => s,
            _ => return Err(format!("scale must be a number {lo}..={hi}")),
        },
    };
    let allow_remote = match &p["allowRemote"] {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ => return Err("allowRemote must be a boolean".into()),
    };
    Ok(json!({"html": html, "cssWidth": css_width, "scale": scale, "allowRemote": allow_remote, "theme": p["theme"].clone()}))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let host = &state.blitz;
    let doc = || params["docId"].as_u64().unwrap_or(0);
    let res = match method {
        "render.open" => match validate_open(params) {
            Ok(frame) => host.open(frame).await,
            Err(msg) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, &msg)),
        },
        "render.tile" => host
            .tile(doc(), params["index"].as_u64().unwrap_or(0) as u32)
            .await
            .map(|png| json!({"png": base64::engine::general_purpose::STANDARD.encode(png)})),
        "render.hit" => host.hit(doc(), params["x"].as_f64().unwrap_or(0.0) as f32, params["y"].as_f64().unwrap_or(0.0) as f32).await,
        "render.close" => {
            host.close(doc()).await;
            Ok(json!({}))
        }
        _ => return None,
    };
    Some(match res {
        Ok(v) => RpcResponse::success(id, v),
        Err(code) => RpcResponse::error(id, ipc::INTERNAL_ERROR, &code),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(p: Value) -> Value {
        validate_open(&p).expect("valid")
    }
    fn err(p: Value) -> String {
        validate_open(&p).expect_err("invalid")
    }

    #[test]
    fn defaults_are_filled_in() {
        let f = ok(json!({"html": "<p>x", "cssWidth": 600}));
        assert_eq!((f["scale"].as_f64(), f["allowRemote"].as_bool()), (Some(1.0), Some(false)));
        assert_eq!(f["cssWidth"], 600);
    }

    #[test]
    fn bad_params_are_refused_without_a_worker() {
        assert!(err(json!({"cssWidth": 600})).contains("html"));
        assert!(err(json!({"html": 5, "cssWidth": 600})).contains("html"));
        for w in [json!(null), json!(0), json!(4001), json!(-3), json!(300.5), json!("300")] {
            assert!(err(json!({"html": "x", "cssWidth": w})).contains("cssWidth"), "{w}");
        }
        for s in [json!(0.4), json!(4.1), json!("2"), json!(true)] {
            assert!(err(json!({"html": "x", "cssWidth": 300, "scale": s})).contains("scale"), "{s}");
        }
        assert!(err(json!({"html": "x", "cssWidth": 300, "allowRemote": "yes"})).contains("allowRemote"));
    }

    #[test]
    fn range_edges_are_accepted() {
        ok(json!({"html": "x", "cssWidth": 1, "scale": 0.5}));
        ok(json!({"html": "x", "cssWidth": 4000, "scale": 4.0, "allowRemote": true}));
    }

    #[test]
    fn oversize_html_keeps_its_known_error_code() {
        let big = "a".repeat(mailvault_render::MAX_HTML_BYTES + 1);
        assert_eq!(err(json!({"html": big, "cssWidth": 300})), "render_too_large");
    }
}
