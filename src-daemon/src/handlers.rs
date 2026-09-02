//! JSON-RPC method handlers. `server::handle_request` routes to these.

use crate::classification;
use crate::classification_worker::{enqueue_for_classification, reclassify_all};
use crate::contacts_index;
use crate::inference;
use crate::ipc::{self, RpcResponse};
use crate::learning;
use crate::llm;
use crate::server::DaemonState;
use crate::snapshot;
use crate::sync_engine;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info};

pub(crate) fn handle_contacts_index_get(
    contacts: Arc<contacts_index::ContactsState>,
    params: Value,
    id: Value,
) -> RpcResponse {
    let account_ids: Vec<String> = match params.get("accountIds").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountIds"),
    };
    let snapshot = contacts.get_snapshot(&account_ids);
    match serde_json::to_value(&snapshot) {
        Ok(v) => RpcResponse::success(id, v),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Serialize: {}", e)),
    }
}

// ── Sync handlers (Phase 3) ─────────────────────────────────────────────────

pub(crate) async fn handle_sync_now(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account: sync_engine::SyncAccount = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let auto_classify = params.get("autoClassify").and_then(|v| v.as_bool()).unwrap_or(false);

    // Take the ticket BEFORE spawning: a `sync.wait` that beats the task to
    // the engine still has a channel to subscribe to.
    let ticket = state.sync_engine.begin(&account.id, mailbox);

    // Spawn sync as background task so RPC returns immediately
    let account_id = account.id.clone();
    let response_account_id = account_id.clone();
    let mailbox_clone = mailbox.to_string();
    tokio::spawn(async move {
        let result = state.sync_engine.run_ticket(ticket, &account, &mailbox_clone).await;

        // Auto-trigger heuristic classification after successful sync (if enabled)
        if auto_classify && result.success && result.new_emails > 0 {
            info!("[sync] Enqueuing post-sync classification for {}", account_id);
            enqueue_for_classification(Arc::clone(&state), &account_id, classification::QueueTier::New).await;
        }

        // Cold or partly-filled cache (a restored/migrated mailbox, or one the
        // app only ever paginated part of) — fill it here, once, instead of
        // letting the app re-page the whole mailbox off the server every launch.
        if result.success {
            let short = state.sync_engine.sidecar_shortfall(&account_id, &mailbox_clone, result.total_emails);
            if short > 0 {
                state.sync_engine.backfill_mailbox(&account, &mailbox_clone).await;
            }
        }
    });

    RpcResponse::success(id, serde_json::json!({"started": true, "accountId": response_account_id, "mailbox": mailbox, "ticket": ticket}))
}

pub(crate) async fn handle_sync_wait(engine: Arc<sync_engine::SyncEngine>, params: Value, id: Value) -> RpcResponse {
    let ticket = match params.get("ticket").and_then(|v| v.as_u64()) {
        Some(t) => t,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing ticket"),
    };
    let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(30_000);

    match engine.wait_for_ticket(ticket, timeout_ms).await {
        Ok(result) => RpcResponse::success(id, serde_json::to_value(result).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

pub(crate) async fn handle_sync_status(engine: &sync_engine::SyncEngine, params: Value, id: Value) -> RpcResponse {
    if let Some(account_id) = params.get("accountId").and_then(|v| v.as_str()) {
        let backfilling = engine.is_backfilling(account_id).await;
        match engine.get_state(account_id).await {
            Some(state) => {
                let mut value = serde_json::to_value(state).unwrap();
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("backfilling".to_string(), serde_json::json!(backfilling));
                }
                RpcResponse::success(id, value)
            }
            None => RpcResponse::success(id, serde_json::json!({"status": "unknown", "backfilling": backfilling})),
        }
    } else {
        let states = engine.get_states().await;
        RpcResponse::success(id, serde_json::to_value(states).unwrap())
    }
}

/// Create a snapshot from provided email data (sent by frontend after backup).
pub(crate) fn handle_snapshot_create(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let account_email = params.get("accountEmail").and_then(|v| v.as_str()).unwrap_or("");

    let mailboxes_val = params.get("mailboxes");
    if account_id.is_empty() || mailboxes_val.is_none() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId or mailboxes");
    }

    let mailboxes: HashMap<String, snapshot::SnapshotMailbox> =
        match serde_json::from_value(mailboxes_val.unwrap().clone()) {
            Ok(m) => m,
            Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Invalid mailboxes: {}", e)),
        };

    match snapshot::create_snapshot(data_dir, account_id, account_email, mailboxes) {
        Ok(info) => RpcResponse::success(id, serde_json::to_value(info).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// Create a snapshot by scanning the local Maildir on disk.
pub(crate) fn handle_snapshot_create_from_maildir(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let account_email = params.get("accountEmail").and_then(|v| v.as_str()).unwrap_or("");

    if account_id.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId");
    }

    match snapshot::create_snapshot_from_maildir(data_dir, account_id, account_email) {
        Ok(info) => RpcResponse::success(id, serde_json::to_value(info).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// List all snapshots for an account.
pub(crate) fn handle_snapshot_list(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    if account_id.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId");
    }

    match snapshot::list_snapshots(data_dir, account_id) {
        Ok(list) => RpcResponse::success(id, serde_json::to_value(list).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// Load a full snapshot manifest.
pub(crate) fn handle_snapshot_load(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let filename = params.get("filename").and_then(|v| v.as_str()).unwrap_or("");

    if account_id.is_empty() || filename.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId or filename");
    }

    match snapshot::load_snapshot(data_dir, account_id, filename) {
        Ok(manifest) => RpcResponse::success(id, serde_json::to_value(manifest).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// Delete a snapshot.
pub(crate) fn handle_snapshot_delete(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let filename = params.get("filename").and_then(|v| v.as_str()).unwrap_or("");

    if account_id.is_empty() || filename.is_empty() {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId or filename");
    }

    match snapshot::delete_snapshot(data_dir, account_id, filename) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── LLM handlers ───────────────────────────────────────────────────────────

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

// ── Classification handlers ────────────────────────────────────────────────

pub(crate) fn handle_classification_summary(app_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let summary = classification::get_summary(app_dir, account_id);
    RpcResponse::success(id, serde_json::to_value(summary).unwrap())
}

pub(crate) fn handle_classification_results(app_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };

    let all = classification::load_classifications(app_dir, account_id);

    let build_entry = |mid: &str, c: &classification::EmailClassification| {
        let snap = c.snapshot.as_ref();
        serde_json::json!({
            "messageId": mid,
            "classification": c,
            "subject": snap.map(|s| s.subject.as_str()).unwrap_or(""),
            "from": snap.map(|s| s.from.as_str()).unwrap_or(""),
            "date": snap.map(|s| s.date.as_str()).unwrap_or(""),
            "uid": snap.map(|s| s.uid).unwrap_or(0),
            "mailbox": snap.map(|s| s.mailbox.as_str()).unwrap_or("INBOX"),
        })
    };

    let mut entries: Vec<_> = if let Some(category) = params.get("category").and_then(|v| v.as_str()) {
        all.iter()
            .filter(|(_, c)| c.category == category)
            .map(|(mid, c)| build_entry(mid, c))
            .collect()
    } else {
        all.iter().map(|(mid, c)| build_entry(mid, c)).collect()
    };

    // Sort by snapshot date descending (newest first); missing/empty dates sort to end.
    entries.sort_by(|a, b| {
        let da = a.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let db = b.get("date").and_then(|v| v.as_str()).unwrap_or("");
        match (da.is_empty(), db.is_empty()) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => db.cmp(da),
        }
    });

    RpcResponse::success(id, serde_json::to_value(entries).unwrap())
}

pub(crate) fn handle_classification_override(app_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let message_id = match params.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing messageId"),
    };

    let category = params.get("category").and_then(|v| v.as_str());
    let importance = params.get("importance").and_then(|v| v.as_str());
    let action = params.get("action").and_then(|v| v.as_str());

    match classification::override_classification(app_dir, account_id, message_id, category, importance, action) {
        Ok(updated) => RpcResponse::success(id, serde_json::to_value(updated).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

pub(crate) async fn handle_classification_cancel(state: &classification::ClassificationState, id: Value) -> RpcResponse {
    *state.cancel_flag.lock().await = true;
    // Wake the worker so it can check the cancel flag and clear the queue
    state.notify.notify_one();
    RpcResponse::success(id, serde_json::json!({"cancelled": true}))
}

pub(crate) async fn handle_classification_status(state: &classification::ClassificationState, id: Value) -> RpcResponse {
    let progress = state.progress.lock().await.clone();
    RpcResponse::success(id, serde_json::to_value(progress).unwrap())
}

/// Zero the counters for a fresh manual run, keeping any queue items resumed
/// from a previous process in `total`.
async fn reset_progress_for_run(state: &classification::ClassificationState) {
    let existing_depth = state.queue_depth().await;
    let mut progress = state.progress.lock().await;
    progress.classified = 0;
    progress.total = existing_depth;
    progress.skipped_by_rules = 0;
}

pub(crate) async fn handle_classification_run(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };

    reset_progress_for_run(&state.classification).await;

    let aid = account_id.clone();
    let state_clone = Arc::clone(&state);
    tokio::spawn(async move {
        // Enqueue all unclassified: newest as New tier, then older as Backfill.
        // Since this is a manual "Reclassify All", everything goes through the queue
        // with New tier so it all processes newest-first in one pass.
        enqueue_for_classification(state_clone, &aid, classification::QueueTier::New).await;
    });

    RpcResponse::success(id, serde_json::json!({"started": true, "accountId": account_id}))
}

pub(crate) async fn handle_reclassify_all(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };

    reset_progress_for_run(&state.classification).await;

    let aid = account_id.clone();
    let state_clone = Arc::clone(&state);
    tokio::spawn(reclassify_all(state_clone, aid));

    RpcResponse::success(id, serde_json::json!({"started": true, "accountId": account_id}))
}

// ── Learning handlers ──────────────────────────────────────────────────────

pub(crate) fn handle_learning_load(app_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let feedback = learning::load_feedback(app_dir, account_id);
    RpcResponse::success(id, serde_json::to_value(feedback).unwrap())
}

pub(crate) fn handle_learning_save(app_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let feedback: learning::Feedback = match params.get("feedback").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(f) => f,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing or invalid feedback"),
    };

    match learning::save_feedback(app_dir, account_id, &feedback) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"saved": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}
