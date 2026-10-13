//! `render.*`: the Blitz reader. Thin: validate params, forward to RenderHost.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let host = &state.blitz;
    let doc = || params["docId"].as_u64().unwrap_or(0);
    let res = match method {
        "render.open" => {
            if !params["html"].is_string() {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "html must be a string"));
            }
            host.open(params.clone()).await
        }
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
