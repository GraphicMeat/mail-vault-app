//! `sync.*` RPCs answered by `server::route_inline`: start a sync and wait on
//! or read its ticket, the IDLE watchers, and the change feed they push into.
use crate::classification;
use crate::classification_worker::enqueue_for_classification;
use crate::ipc::{self, RpcResponse};
use crate::state::DaemonState;
use crate::sync_engine;
use serde_json::Value;
use std::sync::Arc;
use tracing::info;

pub(crate) async fn handle_sync_now(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let mut account: sync_engine::SyncAccount = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    // Task 5.2: the payload no longer carries `password`/`oauth2AccessToken`
    // (toSyncAccount stopped sending them) — resolve them ourselves instead
    // of trusting whatever the JS side put in `imapConfig`.
    match crate::oauth_tokens::resolve(&state, &account.id, crate::oauth_tokens::Read::Guarded).await {
        Ok(resolved) => {
            account.imap_config.password = resolved.password;
            account.imap_config.access_token = resolved.access_token;
        }
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let auto_classify = params.get("autoClassify").and_then(|v| v.as_bool()).unwrap_or(false);
    // `complete`: after the ordinary sync, make the cache hold the WHOLE folder
    // (every provider; `complete_fill`). The `backfilling` flag goes up here,
    // before this returns, and comes down when the spawned task ends.
    let complete = params.get("complete").and_then(|v| v.as_bool()).unwrap_or(false);
    let fill = complete.then(|| state.sync_engine.begin_fill(&account.id, mailbox));
    let graph = account.imap_config.transport() == mailvault_core::imap::Transport::Graph;

    // Bind optional source evidence before issuing the ticket and spawning.
    // Existing callers without a strict account origin still keep sync.now's
    // established ticket behavior, but cannot mark from that ticket.
    let prepared = crate::sync_observation::prepare_ticket(&state, &account.imap_config,
        &account.id, mailbox).await;
    let (evidence, operation) = match prepared {
        Some((evidence, operation)) => (Some(evidence), Some(operation)),
        None => (None, None),
    };
    let ticket = state.sync_engine.begin_with_evidence(&account.id, mailbox, evidence);

    // Spawn sync as background task so RPC returns immediately
    let account_id = account.id.clone();
    let response_account_id = account_id.clone();
    let mailbox_clone = mailbox.to_string();
    // A Graph account has no IMAP sync to run: its newest page settles the
    // ticket and the fill, if asked for, walks the rest.
    if complete && graph {
        tokio::spawn(Box::pin(crate::complete_fill::graph(
            state, account, mailbox_clone, ticket, complete, fill)));
        return RpcResponse::success(id, serde_json::json!({"started": true, "accountId": response_account_id, "mailbox": mailbox, "ticket": ticket}));
    }
    tokio::spawn(Box::pin(async move {
        let _fill = fill;
        let observation_operation = operation;
        let result = state.sync_engine.run_ticket(ticket, &account, &mailbox_clone).await;
        drop(observation_operation);

        // Hoarder: real arrivals only. `new_emails` also counts backfill
        // pages, and every wake costs a STATUS sweep plus a listing of each
        // folder that moved.
        if result.success && result.arrivals > 0 {
            state.hoarder_worker.wake();
        }
        if result.success && result.new_emails > 0 {
            // Auto Tags' standing worker: the same "new mail arrived" signal
            // classification enqueues on below, but unconditional — auto-tag
            // rules are not gated by the classification feature's own toggle.
            state.auto_tag_worker.wake();

            // Auto-trigger heuristic classification after successful sync (if enabled)
            if auto_classify {
                info!("[sync] Enqueuing post-sync classification for {}", account_id);
                enqueue_for_classification(Arc::clone(&state), &account_id, classification::QueueTier::New).await;
            }
        }

        // Cold or partly-filled cache (a restored/migrated mailbox, or one the
        // app only ever paginated part of) — fill it here, once, instead of
        // letting the app re-page the whole mailbox off the server every launch.
        if result.success {
            if _fill.as_ref().is_some_and(|fill| fill.owner()) {
                // Asked for the whole folder: every provider, the folder the
                // sync actually served.
                crate::complete_fill::fill(&state, &account, &result).await;
            } else if _fill.is_none() {
                let short = state.sync_engine.sidecar_shortfall(&account_id, &mailbox_clone, result.total_emails).await;
                if short > 0 {
                    state.sync_engine.backfill_mailbox(&account, &mailbox_clone).await;
                }
            }
        }
    }));

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

// ── IDLE watchers + the change feed (Phase 2 parity) ────────────────────────

/// Register an account for IDLE. The app calls this for every account it has,
/// on every reconnect; an unchanged account is a no-op inside `watch`.
pub(crate) async fn handle_sync_watch(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let mut account: sync_engine::SyncAccount = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    // Task 5.2: same as sync.now — resolve credentials ourselves rather than
    // trusting the payload. This account is captured wholesale by the IDLE
    // watcher for the life of its task (idle_watch.rs `run`), including every
    // reconnect, so it must carry the real password/token before it gets
    // there — the watcher itself never re-resolves per-connection.
    match crate::oauth_tokens::resolve(&state, &account.id, crate::oauth_tokens::Read::Guarded).await {
        Ok(resolved) => {
            account.imap_config.password = resolved.password;
            account.imap_config.access_token = resolved.access_token;
        }
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
    // 29 minutes: RFC 2177 tells clients to re-issue IDLE at least that often
    // or the server may log them off.
    state.idle.watch(account, std::time::Duration::from_secs(29 * 60)).await;
    RpcResponse::success(id, serde_json::json!({"watching": true}))
}

pub(crate) async fn handle_sync_unwatch(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    state.idle.unwatch(account_id).await;
    RpcResponse::success(id, serde_json::json!({"watching": false}))
}

/// Long-poll for changes newer than `since`. The app re-issues it with the gen
/// it was handed, so nothing is lost between polls. No `since` = a new app:
/// resume after what the previous one acknowledged.
pub(crate) async fn handle_sync_events(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let since = params.get("since").and_then(|v| v.as_u64())
        .unwrap_or_else(|| state.sync_engine.acked_gen());
    let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64())
        .unwrap_or(25_000).min(60_000);
    let (gen, changes) = state.sync_engine.wait_changes(since, timeout_ms).await;
    let resync_required = since > gen || (gen > since && changes.first()
        .is_none_or(|change| change.gen != since.saturating_add(1)));
    let mut current_changes = Vec::new();
    for change in changes {
        if let Some(source) = change.source.clone() {
            let mut valid = None;
            for attempt in 0..11 {
                let current = Arc::clone(&state);
                let original_source = source.clone();
                match tokio::task::spawn_blocking(move ||
                    crate::sync_observation::current_source(&current, &original_source)).await {
                    Ok(Ok(answer)) => { valid = Some(answer); break; }
                    Ok(Err(error)) if error == "errors.keychainBusy" && attempt < 10 => {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    Ok(Err(error)) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, error),
                    Err(error) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, error.to_string()),
                }
            }
            if valid != Some(true) { continue; }
        }
        current_changes.push(change);
    }
    let notifications = if resync_required { Vec::new() }
        else { crate::arrival::prepare_changes(&state, &current_changes).await };
    let visible_changes: Vec<Value> = current_changes.iter().filter_map(|change| {
        let mut value = serde_json::to_value(change).ok()?;
        if let Some(reference) = change.source.as_ref().and_then(crate::arrival::source_ref) {
            value["sourceRef"] = serde_json::json!(reference);
        }
        Some(value)
    }).collect();
    RpcResponse::success(id, serde_json::json!({
        "gen":gen,"changes":visible_changes,"notifications":notifications,
        "resyncRequired":resync_required,"instanceId":state.refresh.instance_id(),
    }))
}
