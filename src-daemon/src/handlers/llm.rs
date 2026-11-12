//! `llm.*` RPCs answered by `server::route_inline`: the local model's
//! download, load and inference (`crate::llm`, `crate::inference`).
use crate::inference;
use crate::ipc::{self, RpcResponse};
use crate::llm;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tracing::error;

pub(crate) async fn handle_llm_status(state: &llm::LlmState, id: Value) -> RpcResponse {
    let status = llm::get_status(state).await;
    RpcResponse::success(id, serde_json::to_value(status).unwrap())
}

pub(crate) async fn handle_llm_list_models(state: &llm::LlmState, id: Value) -> RpcResponse {
    let active = state.active_model_id.lock().await.clone();
    let models = llm::list_models(&state.data_dir, active.as_deref());
    RpcResponse::success(id, serde_json::to_value(models).unwrap())
}

pub(crate) async fn handle_llm_download(state: Arc<llm::LlmState>, params: Value, id: Value) -> RpcResponse {
    let model_id = match params.get("modelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing modelId"),
    };

    // Spawn download as background task so the RPC response returns immediately
    let state_clone = Arc::clone(&state);
    let model_id_clone = model_id.clone();
    tokio::spawn(async move {
        if let Err(e) = llm::download_model(state_clone, &model_id_clone).await {
            error!("Model download failed: {}", e);
        }
    });

    RpcResponse::success(id, serde_json::json!({"started": true, "modelId": model_id}))
}

pub(crate) async fn handle_llm_cancel_download(state: &llm::LlmState, id: Value) -> RpcResponse {
    // Set the cancel flag — the download loop checks it
    *state.cancel_flag.lock().await = true;
    RpcResponse::success(id, serde_json::json!({"cancelled": true}))
}

pub(crate) fn handle_llm_delete_model(state: &llm::LlmState, params: Value, id: Value) -> RpcResponse {
    let model_id = match params.get("modelId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing modelId"),
    };

    match llm::delete_model(&state.data_dir, model_id) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

pub(crate) async fn handle_llm_load(
    app_dir: &Path,
    llm_state: &llm::LlmState,
    engine: &inference::InferenceEngine,
    params: Value,
    id: Value,
) -> RpcResponse {
    let model_id = match params.get("modelId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing modelId"),
    };

    let registry = llm::get_model_registry();
    let model_info = match registry.iter().find(|m| m.id == model_id) {
        Some(m) => m,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Unknown model: {}", model_id)),
    };

    let model_path = app_dir.join("models").join(&model_info.filename);
    if !model_path.exists() {
        return RpcResponse::error(id, ipc::INTERNAL_ERROR, "Model not downloaded yet");
    }

    match engine.load_model(&model_path, model_id).await {
        Ok(()) => {
            *llm_state.active_model_id.lock().await = Some(model_id.to_string());
            RpcResponse::success(id, serde_json::json!({"loaded": true, "modelId": model_id}))
        }
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

pub(crate) async fn handle_llm_unload(engine: &inference::InferenceEngine, id: Value) -> RpcResponse {
    engine.unload().await;
    RpcResponse::success(id, serde_json::json!({"unloaded": true}))
}

pub(crate) async fn handle_llm_classify(
    engine: &inference::InferenceEngine,
    params: Value,
    id: Value,
) -> RpcResponse {
    let prompt = match params.get("prompt").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing prompt"),
    };

    let max_tokens = params.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(2048) as usize;

    match engine.infer(&prompt, max_tokens).await {
        Ok(response) => RpcResponse::success(id, serde_json::json!({"response": response})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}
