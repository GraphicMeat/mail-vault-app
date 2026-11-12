//! `classification.*` RPCs answered by `server::route_inline`. The store and
//! the queue are `crate::classification` and `crate::classification_worker`.
use crate::classification;
use crate::classification_worker::{enqueue_for_classification, reclassify_all};
use crate::ipc::{self, RpcResponse};
use crate::state::DaemonState;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

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
    let entries = result_rows(&all, params.get("category").and_then(|v| v.as_str()));
    RpcResponse::success(id, serde_json::to_value(entries).unwrap())
}

/// The `classification.results` rows: one per classified message (only
/// `category`'s when one is given), with the snapshot's fields beside the
/// classification, newest snapshot date first and undated rows last.
fn result_rows(
    all: &HashMap<String, classification::EmailClassification>,
    category: Option<&str>,
) -> Vec<Value> {
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

    let mut entries: Vec<Value> = all
        .iter()
        .filter(|(_, c)| category.is_none_or(|category| c.category == category))
        .map(|(mid, c)| build_entry(mid, c))
        .collect();

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
    entries
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

#[cfg(test)]
mod tests {
    use super::*;
    use classification::{ClassificationSource, EmailClassification, EmailSnapshot};

    fn classified(category: &str, date: Option<&str>) -> EmailClassification {
        EmailClassification {
            category: category.into(),
            importance: "normal".into(),
            action: "none".into(),
            confidence: 1.0,
            classified_at: String::new(),
            model_used: String::new(),
            source: ClassificationSource::default(),
            snapshot: date.map(|date| EmailSnapshot {
                uid: 7,
                subject: "s".into(),
                from: "f".into(),
                date: date.into(),
                mailbox: "Archive".into(),
            }),
        }
    }

    fn all() -> HashMap<String, EmailClassification> {
        HashMap::from([
            ("old".to_string(), classified("news", Some("2026-01-01T00:00:00Z"))),
            ("undated".to_string(), classified("news", None)),
            ("new".to_string(), classified("work", Some("2026-03-01T00:00:00Z"))),
        ])
    }

    fn ids(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["messageId"].as_str().unwrap()).collect()
    }

    #[test]
    fn rows_run_newest_first_with_undated_last() {
        let rows = result_rows(&all(), None);
        assert_eq!(ids(&rows), ["new", "old", "undated"]);
        assert_eq!(rows[0]["mailbox"], "Archive");
        assert_eq!(rows[0]["uid"], 7);
        assert_eq!(rows[0]["classification"]["category"], "work");
        assert_eq!((rows[2]["mailbox"].as_str(), rows[2]["uid"].as_u64()), (Some("INBOX"), Some(0)));
    }

    #[test]
    fn a_category_keeps_only_its_rows() {
        assert_eq!(ids(&result_rows(&all(), Some("news"))), ["old", "undated"]);
        assert!(result_rows(&all(), Some("none")).is_empty());
    }
}
