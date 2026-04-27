use crate::auth;
use crate::classification;
use crate::contacts_index;
use crate::imap;
use crate::inference;
use crate::ipc::{self, AuthHandshake, RpcRequest, RpcResponse};
use crate::learning;
use crate::llm;
use crate::oauth2;
use crate::snapshot;
use crate::sync_engine;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tracing::{error, info, warn};

/// Daemon server state shared across connections.
pub struct DaemonState {
    pub token: String,
    pub data_dir: PathBuf,
    pub started_at: std::time::Instant,
    pub llm: Arc<llm::LlmState>,
    pub inference: Arc<inference::InferenceEngine>,
    pub classification: classification::ClassificationState,
    pub imap_pool: Arc<imap::ImapPool>,
    pub _oauth2_manager: oauth2::OAuth2Manager,
    pub sync_engine: Arc<sync_engine::SyncEngine>,
    pub contacts: Arc<contacts_index::ContactsState>,
}

/// Start the daemon socket server.
pub async fn run(state: Arc<DaemonState>, socket_path: &Path) -> std::io::Result<()> {
    // Remove socket only if it's stale (can't connect to it)
    if socket_path.exists() {
        match std::os::unix::net::UnixStream::connect(socket_path) {
            Ok(_) => {
                // Another daemon is actively serving — don't steal the socket
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    "Socket already in use by another daemon",
                ));
            }
            Err(_) => {
                // Stale socket — safe to remove
                std::fs::remove_file(socket_path)?;
            }
        }
    }

    // Ensure parent directory exists with restricted permissions
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
    }

    let listener = UnixListener::bind(socket_path)?;

    // Restrict socket file permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    }

    info!("Daemon listening on {:?}", socket_path);

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(state, stream).await {
                        warn!("Connection handler error: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("Failed to accept connection: {}", e);
            }
        }
    }
}

/// Handle a single client connection: authenticate, then process requests.
async fn handle_connection(
    state: Arc<DaemonState>,
    stream: tokio::net::UnixStream,
) -> std::io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // Step 1: Expect authentication handshake as the first message
    let auth_line = match lines.next_line().await? {
        Some(line) => line,
        None => return Ok(()), // Client disconnected immediately
    };

    let authenticated = match serde_json::from_str::<AuthHandshake>(&auth_line) {
        Ok(handshake) => auth::validate_token(&state.token, &handshake.token),
        Err(_) => false,
    };

    if !authenticated {
        let resp = RpcResponse::error(Value::Null, ipc::AUTH_FAILED, "Authentication failed");
        let mut buf = serde_json::to_vec(&resp).unwrap();
        buf.push(b'\n');
        writer.write_all(&buf).await?;
        warn!("Rejected unauthenticated connection");
        return Ok(());
    }

    // Send auth success
    let resp = RpcResponse::success(Value::Null, serde_json::json!({"authenticated": true}));
    let mut buf = serde_json::to_vec(&resp).unwrap();
    buf.push(b'\n');
    writer.write_all(&buf).await?;
    tracing::debug!("Client authenticated");

    // Step 2: Process JSON-RPC requests
    while let Some(line) = lines.next_line().await? {
        let response = match ipc::parse_request(&line) {
            Ok(req) => handle_request(&state, req).await,
            Err(err_resp) => err_resp,
        };

        let mut buf = serde_json::to_vec(&response).unwrap();
        buf.push(b'\n');
        writer.write_all(&buf).await?;
    }

    tracing::debug!("Client disconnected");
    Ok(())
}

/// Route a parsed RPC request to the appropriate handler.
async fn handle_request(state: &Arc<DaemonState>, req: RpcRequest) -> RpcResponse {
    let id = req.id.unwrap_or(Value::Null);

    match req.method.as_str() {
        "ping" => RpcResponse::success(id, serde_json::json!({"pong": true})),

        "daemon.heartbeat" => RpcResponse::success(id, serde_json::json!({
            "alive": true,
            "uptime_secs": state.started_at.elapsed().as_secs(),
            "version": env!("CARGO_PKG_VERSION"),
        })),

        "daemon.status" => RpcResponse::success(
            id,
            serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "uptime_secs": state.started_at.elapsed().as_secs(),
                "data_dir": state.data_dir.to_string_lossy(),
            }),
        ),

        // ── IMAP operations (Phase 3) ────────────────────────────────
        "imap.test_connection" => handle_imap_test_connection(req.params, id).await,
        "imap.get_mailboxes" => handle_imap_with_pool(&state, req.params, id, imap_op_get_mailboxes).await,
        "imap.get_emails" => handle_imap_with_pool(&state, req.params, id, imap_op_get_emails).await,
        "imap.get_emails_range" => handle_imap_with_pool(&state, req.params, id, imap_op_get_emails_range).await,
        "imap.check_mailbox_status" => handle_imap_with_pool(&state, req.params, id, imap_op_check_status).await,
        "imap.fetch_changed_flags" => handle_imap_with_pool(&state, req.params, id, imap_op_fetch_changed_flags).await,
        "imap.search_all_uids" => handle_imap_with_pool(&state, req.params, id, imap_op_search_all_uids).await,
        "imap.fetch_headers_by_uids" => handle_imap_with_pool(&state, req.params, id, imap_op_fetch_headers).await,
        "imap.get_email" => handle_imap_with_pool(&state, req.params, id, imap_op_get_email).await,
        "imap.get_email_light" => handle_imap_with_pool(&state, req.params, id, imap_op_get_email_light).await,
        "imap.set_flags" => handle_imap_with_pool(&state, req.params, id, imap_op_set_flags).await,
        "imap.delete_email" => handle_imap_with_pool(&state, req.params, id, imap_op_delete_email).await,
        "imap.fetch_raw" => handle_imap_with_pool(&state, req.params, id, imap_op_fetch_raw).await,
        "imap.append_email" => handle_imap_with_pool(&state, req.params, id, imap_op_append_email).await,
        "imap.search_emails" => handle_imap_with_pool(&state, req.params, id, imap_op_search_emails).await,
        "imap.disconnect" => handle_imap_disconnect(&state, req.params, id).await,
        "imap.move_emails" => handle_imap_with_pool(&state, req.params, id, imap_op_move_emails).await,

        // ── SMTP (Phase 3) ──────────────────────────────────────────
        "smtp.send_email" => handle_smtp_send(req.params, id).await,

        // ── DNS (Phase 3) ───────────────────────────────────────────
        "dns.resolve_email_settings" => handle_dns_resolve(req.params, id).await,

        // ── Graph API (Phase 5) ─────────────────────────────────────
        "graph.list_folders" => handle_graph(&state, req.params, id, "list_folders").await,
        "graph.list_messages" => handle_graph(&state, req.params, id, "list_messages").await,
        "graph.get_message" => handle_graph(&state, req.params, id, "get_message").await,
        "graph.get_mime" => handle_graph(&state, req.params, id, "get_mime").await,
        "graph.cache_mime" => handle_graph(&state, req.params, id, "cache_mime").await,
        "graph.set_read" => handle_graph(&state, req.params, id, "set_read").await,
        "graph.delete_message" => handle_graph(&state, req.params, id, "delete_message").await,
        "graph.move_emails" => handle_graph(&state, req.params, id, "move_emails").await,

        // ── Sync engine (Phase 3) ───────────────────────────────────
        "sync.now" => handle_sync_now(Arc::clone(state), req.params, id).await,
        "sync.wait" => handle_sync_wait(Arc::clone(&state.sync_engine), req.params, id).await,
        "sync.status" => handle_sync_status(&state.sync_engine, req.params, id).await,

        // ── Credentials (via keyring — Phase 4) ─────────────────────
        "credentials.store" => handle_credentials_store(req.params, id),
        "credentials.get" => handle_credentials_get(req.params, id),
        "credentials.delete" => handle_credentials_delete(req.params, id),

        // ── Maildir operations ───────────────────────────────────────
        "maildir.list" => handle_maildir_list(&state.data_dir, req.params, id),
        "maildir.store" => handle_maildir_store(&state.data_dir, req.params, id),
        "maildir.read_raw" => handle_maildir_read_raw(&state.data_dir, req.params, id),
        "maildir.read_header" => handle_maildir_read_header(&state.data_dir, req.params, id),
        "maildir.read_full" => handle_maildir_read_full(&state.data_dir, req.params, id),
        "maildir.read_light" => handle_maildir_read_light(&state.data_dir, req.params, id),
        "maildir.read_light_batch" => handle_maildir_read_light_batch(&state.data_dir, req.params, id),
        "maildir.read_attachment" => handle_maildir_read_attachment(&state.data_dir, req.params, id),
        "maildir.exists" => handle_maildir_exists(&state.data_dir, req.params, id),
        "maildir.delete" => handle_maildir_delete(&state.data_dir, req.params, id),
        "maildir.set_flags" => handle_maildir_set_flags(&state.data_dir, req.params, id),
        "maildir.storage_stats" => handle_maildir_storage_stats(&state.data_dir, req.params, id),

        // ── Cache operations ────────────────────────────────────────
        "cache.save_headers" => handle_cache_save(&state.data_dir, req.params, id),
        "cache.load_full" => handle_cache_load_full(&state.data_dir, req.params, id),
        "cache.load_meta" => handle_cache_load_meta(&state.data_dir, req.params, id),
        "cache.load_partial" => handle_cache_load_partial(&state.data_dir, req.params, id),
        "cache.load_by_uids" => handle_cache_load_by_uids(&state.data_dir, req.params, id),
        "cache.clear" => handle_cache_clear(&state.data_dir, req.params, id),
        "cache.save_mailboxes" => handle_cache_save_mailboxes(&state.data_dir, req.params, id),
        "cache.load_mailboxes" => handle_cache_load_mailboxes(&state.data_dir, req.params, id),
        "cache.delete_mailboxes" => handle_cache_delete_mailboxes(&state.data_dir, req.params, id),

        // ── Local index ─────────────────────────────────────────────
        "local_index.read" => handle_local_index_read(&state.data_dir, req.params, id),
        "local_index.append" => handle_local_index_append(&state.data_dir, req.params, id),
        "local_index.remove" => handle_local_index_remove(&state.data_dir, req.params, id),

        // ── Graph ID map ────────────────────────────────────────────
        "graph_id_map.save" => handle_graph_id_map_save(&state.data_dir, req.params, id),
        "graph_id_map.load" => handle_graph_id_map_load(&state.data_dir, req.params, id),

        "snapshot.create" => handle_snapshot_create(&state.data_dir, req.params, id),
        "snapshot.create_from_maildir" => handle_snapshot_create_from_maildir(&state.data_dir, req.params, id),
        "snapshot.list" => handle_snapshot_list(&state.data_dir, req.params, id),
        "snapshot.load" => handle_snapshot_load(&state.data_dir, req.params, id),
        "snapshot.delete" => handle_snapshot_delete(&state.data_dir, req.params, id),

        "llm.status" => handle_llm_status(&state.llm, id).await,
        "llm.list_models" => handle_llm_list_models(&state.llm, id).await,
        "llm.download" => handle_llm_download(Arc::clone(&state.llm), req.params, id).await,
        "llm.cancel_download" => handle_llm_cancel_download(&state.llm, id).await,
        "llm.delete_model" => handle_llm_delete_model(&state.llm, req.params, id),
        "llm.load" => handle_llm_load(&state.data_dir, &state.llm, &state.inference, req.params, id).await,
        "llm.unload" => handle_llm_unload(&state.inference, id).await,
        "llm.classify" => handle_llm_classify(&state.inference, req.params, id).await,

        "classification.run" => handle_classification_run(Arc::clone(state), req.params, id).await,
        "classification.reclassify_all" => handle_reclassify_all(Arc::clone(state), req.params, id).await,
        "classification.cancel" => handle_classification_cancel(&state.classification, id).await,
        "classification.summary" => handle_classification_summary(&state.data_dir, req.params, id),
        "classification.results" => handle_classification_results(&state.data_dir, req.params, id),
        "classification.override" => handle_classification_override(&state.data_dir, req.params, id),
        "classification.status" => handle_classification_status(&state.classification, id).await,

        "learning.load" => handle_learning_load(&state.data_dir, req.params, id),
        "learning.save" => handle_learning_save(&state.data_dir, req.params, id),

        "contacts_index.get" => handle_contacts_index_get(Arc::clone(&state.contacts), req.params, id),
        "contacts_index.flush" => handle_contacts_index_flush(Arc::clone(&state.contacts), id),

        _ => RpcResponse::error(id, ipc::METHOD_NOT_FOUND, format!("Unknown method: {}", req.method)),
    }
}

fn handle_contacts_index_get(
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

fn handle_contacts_index_flush(
    contacts: Arc<contacts_index::ContactsState>,
    id: Value,
) -> RpcResponse {
    contacts.flush_dirty();
    RpcResponse::success(id, serde_json::json!({"ok": true}))
}

/// Proof-of-concept: list UIDs in a Maildir folder.
fn handle_maildir_list(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");

    let maildir_path = data_dir
        .join("Maildir")
        .join(account_id)
        .join(mailbox)
        .join("cur");

    if !maildir_path.exists() {
        return RpcResponse::success(id, serde_json::json!({"uids": [], "count": 0}));
    }

    let mut uids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&maildir_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Extract UID from filename (format: {uid}:{flags}:{timestamp})
            if let Some(uid_str) = name.split(':').next() {
                if let Ok(uid) = uid_str.parse::<u64>() {
                    uids.push(uid);
                }
            }
        }
    }

    uids.sort();
    let count = uids.len();
    RpcResponse::success(id, serde_json::json!({"uids": uids, "count": count}))
}

fn handle_maildir_store(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let raw_b64 = params.get("rawBase64").and_then(|v| v.as_str()).unwrap_or("");
    let flags: Vec<String> = params.get("flags").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();

    use base64::Engine;
    let raw_bytes = match base64::engine::general_purpose::STANDARD.decode(raw_b64) {
        Ok(b) => b,
        Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Invalid base64: {}", e)),
    };

    match mailvault_core::maildir::store(data_dir, account_id, mailbox, uid, &raw_bytes, &flags) {
        Ok(_) => RpcResponse::success(id, serde_json::json!({"stored": true, "uid": uid})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_read_raw(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    use base64::Engine;
    match mailvault_core::maildir::read_raw(data_dir, account_id, mailbox, uid) {
        Ok(bytes) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            RpcResponse::success(id, serde_json::json!({"rawBase64": b64, "size": bytes.len()}))
        }
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_read_header(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    match mailvault_core::maildir::read_raw(data_dir, account_id, mailbox, uid) {
        Ok(bytes) => match mailvault_core::maildir::parse_header(&bytes) {
            Ok(mut header) => {
                header.uid = uid;
                RpcResponse::success(id, serde_json::to_value(header).unwrap())
            }
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_delete(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    match mailvault_core::maildir::delete(data_dir, account_id, mailbox, uid) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_storage_stats(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let stats = mailvault_core::maildir::storage_stats(data_dir, account_id);
    RpcResponse::success(id, serde_json::to_value(stats).unwrap())
}

fn handle_cache_save(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");

    let headers: Vec<mailvault_core::types::EmailHeader> = match params.get("headers").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(h) => h,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing headers"),
    };

    let meta: mailvault_core::cache::CacheMeta = params.get("meta")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    match mailvault_core::cache::save_headers(data_dir, account_id, mailbox, &headers, meta) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"saved": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_cache_load_meta(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");

    match mailvault_core::cache::load_meta(data_dir, account_id, mailbox) {
        Some(meta) => RpcResponse::success(id, serde_json::to_value(meta).unwrap()),
        None => RpcResponse::success(id, Value::Null),
    }
}

fn handle_cache_load_partial(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(500) as usize;

    match mailvault_core::cache::load_partial(data_dir, account_id, mailbox, limit) {
        Some(entry) => RpcResponse::success(id, serde_json::to_value(entry).unwrap()),
        None => RpcResponse::success(id, Value::Null),
    }
}

fn handle_cache_clear(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");

    match mailvault_core::cache::clear(data_dir, account_id, mailbox) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"cleared": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── New Maildir handlers (Phase 2) ──────────────────────────────────────────

fn handle_maildir_read_full(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    match mailvault_core::maildir::read_full(data_dir, account_id, mailbox, uid) {
        Ok(email) => RpcResponse::success(id, serde_json::to_value(email).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_read_light(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    match mailvault_core::maildir::read_light(data_dir, account_id, mailbox, uid) {
        Ok(header) => RpcResponse::success(id, serde_json::to_value(header).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_read_light_batch(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uids: Vec<u32> = params.get("uids")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let results = mailvault_core::maildir::read_light_batch(data_dir, account_id, mailbox, &uids);
    RpcResponse::success(id, serde_json::to_value(results).unwrap())
}

fn handle_maildir_read_attachment(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let index = params.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

    match mailvault_core::maildir::read_attachment(data_dir, account_id, mailbox, uid, index) {
        Ok((filename, content_type, data)) => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            RpcResponse::success(id, serde_json::json!({
                "filename": filename,
                "contentType": content_type,
                "content": b64,
                "size": data.len(),
            }))
        }
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_maildir_exists(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let exists = mailvault_core::maildir::email_exists(data_dir, account_id, mailbox, uid);
    RpcResponse::success(id, serde_json::json!({"exists": exists}))
}

fn handle_maildir_set_flags(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let flags: Vec<String> = params.get("flags")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    match mailvault_core::maildir::set_flags(data_dir, account_id, mailbox, uid, &flags) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"updated": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── New Cache handlers (Phase 2) ────────────────────────────────────────────

fn handle_cache_load_full(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    match mailvault_core::cache::load_full(data_dir, account_id, mailbox) {
        Some(entry) => RpcResponse::success(id, serde_json::to_value(entry).unwrap()),
        None => RpcResponse::success(id, Value::Null),
    }
}

fn handle_cache_load_by_uids(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uids: Vec<u32> = params.get("uids")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let results = mailvault_core::cache::load_by_uids(data_dir, account_id, mailbox, &uids);
    RpcResponse::success(id, serde_json::to_value(results).unwrap())
}

fn handle_cache_save_mailboxes(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailboxes = params.get("mailboxes").cloned().unwrap_or(Value::Null);
    match mailvault_core::cache::save_mailboxes(data_dir, account_id, &mailboxes) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"saved": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_cache_load_mailboxes(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    match mailvault_core::cache::load_mailboxes(data_dir, account_id) {
        Some(data) => RpcResponse::success(id, data),
        None => RpcResponse::success(id, Value::Null),
    }
}

fn handle_cache_delete_mailboxes(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    match mailvault_core::cache::delete_mailbox_cache(data_dir, account_id) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── Local index handlers ────────────────────────────────────────────────────

fn handle_local_index_read(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    match mailvault_core::cache::read_local_index(data_dir, account_id, mailbox) {
        Some(data) => RpcResponse::success(id, data),
        None => RpcResponse::success(id, Value::Null),
    }
}

fn handle_local_index_append(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let entries = params.get("entries").cloned().unwrap_or(Value::Null);
    match mailvault_core::cache::append_local_index(data_dir, account_id, mailbox, &entries) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"appended": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_local_index_remove(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uids: Vec<u32> = params.get("uids")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    match mailvault_core::cache::remove_from_local_index(data_dir, account_id, mailbox, &uids) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"removed": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── Graph ID map handlers ───────────────────────────────────────────────────

fn handle_graph_id_map_save(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    let map = params.get("map").cloned().unwrap_or(Value::Null);
    match mailvault_core::cache::save_graph_id_map(data_dir, account_id, &map) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"saved": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn handle_graph_id_map_load(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
    match mailvault_core::cache::load_graph_id_map(data_dir, account_id) {
        Some(data) => RpcResponse::success(id, data),
        None => RpcResponse::success(id, Value::Null),
    }
}

// ── IMAP handlers (Phase 3) ─────────────────────────────────────────────────

use crate::graph;
use crate::imap::pool::{ImapSession, PooledSessionGuard};
use crate::dns;
use crate::smtp;

fn parse_account(params: &Value) -> Result<imap::ImapConfig, RpcResponse> {
    params.get("account")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(Value::Null, ipc::INVALID_PARAMS, "Missing or invalid account"))
}

/// Run an IMAP operation with a session from the pool.
async fn handle_imap_with_pool<F, Fut>(
    state: &Arc<DaemonState>,
    params: Value,
    id: Value,
    op: F,
) -> RpcResponse
where
    F: FnOnce(ImapSession, Value) -> Fut,
    Fut: std::future::Future<Output = Result<(Value, ImapSession, Option<String>), String>>,
{
    let account = match parse_account(&params) {
        Ok(a) => a,
        Err(resp) => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };

    let guard = match state.imap_pool.get_background(&account).await {
        Ok(g) => g,
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    };

    let PooledSessionGuard { session, last_selected: _, _permit } = guard;

    match op(session, params).await {
        Ok((result, session, selected_mailbox)) => {
            let return_guard = PooledSessionGuard {
                session,
                last_selected: selected_mailbox,
                _permit,
            };
            state.imap_pool.return_background(&account, return_guard).await;
            RpcResponse::success(id, result)
        }
        Err(e) => {
            // _permit dropped — semaphore released, pool creates new session next time
            RpcResponse::error(id, ipc::INTERNAL_ERROR, e)
        }
    }
}

async fn handle_imap_test_connection(params: Value, id: Value) -> RpcResponse {
    let account: imap::ImapConfig = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    match imap::test_connection(&account).await {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"success": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

async fn handle_imap_disconnect(state: &Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account: imap::ImapConfig = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    state.imap_pool.disconnect(&account).await;
    RpcResponse::success(id, serde_json::json!({"disconnected": true}))
}

// IMAP operation closures — each takes (session, params) → (result_json, session, selected_mailbox)

async fn imap_op_get_mailboxes(mut session: ImapSession, _params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let result = imap::list_mailboxes(&mut session).await?;
    Ok((serde_json::json!({"success": true, "mailboxes": result}), session, None))
}

async fn imap_op_get_emails(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let page = params.get("page").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(200) as u32;
    let result = imap::fetch_emails_page(&mut session, mailbox, page, limit).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_get_emails_range(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let start = params.get("startSeq").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let end = params.get("endSeq").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let result = imap::fetch_emails_range(&mut session, mailbox, start, end).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_check_status(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let has_condstore = params.get("hasCondstore").and_then(|v| v.as_bool()).unwrap_or(false);
    let result = imap::check_mailbox_status(&mut session, mailbox, has_condstore).await?;
    Ok((serde_json::to_value(result).unwrap(), session, None))
}

async fn imap_op_fetch_changed_flags(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let since = params.get("sinceModseq").and_then(|v| v.as_u64()).unwrap_or(0);
    let result = imap::fetch_changed_flags(&mut session, mailbox, since).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_search_all_uids(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let has_esearch = params.get("hasEsearch").and_then(|v| v.as_bool()).unwrap_or(false);
    let result = imap::search_all_uids(&mut session, mailbox, has_esearch).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_fetch_headers(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uids: Vec<u32> = params.get("uids").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let result = imap::fetch_headers_by_uids(&mut session, mailbox, &uids).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_get_email(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let result = imap::fetch_email_by_uid(&mut session, mailbox, uid).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_get_email_light(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let result = imap::fetch_email_by_uid_light(&mut session, mailbox, uid).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_set_flags(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let flags: Vec<String> = params.get("flags").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("add");
    imap::set_flags(&mut session, mailbox, uid, &flags, action).await?;
    Ok((serde_json::json!({"updated": true}), session, Some(mailbox.to_string())))
}

async fn imap_op_delete_email(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    imap::delete_email(&mut session, mailbox, uid, true).await?;
    Ok((serde_json::json!({"deleted": true}), session, Some(mailbox.to_string())))
}

async fn imap_op_fetch_raw(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let result = imap::fetch_email_by_uid(&mut session, mailbox, uid).await?;
    let raw_b64 = result.map(|e| e.raw_source).unwrap_or_default();
    Ok((serde_json::json!({"rawSource": raw_b64}), session, Some(mailbox.to_string())))
}

async fn imap_op_append_email(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let raw_b64 = params.get("rawBase64").and_then(|v| v.as_str()).unwrap_or("");
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD.decode(raw_b64)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let flags = params.get("flags").and_then(|v| v.as_str()).unwrap_or("");
    imap::append_email(&mut session, mailbox, &raw, flags).await?;
    Ok((serde_json::json!({"appended": true}), session, None))
}

async fn imap_op_search_emails(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let query = params.get("query").and_then(|v| v.as_str());
    let from_filter = params.get("fromFilter").and_then(|v| v.as_str());
    let subject_filter = params.get("subjectFilter").and_then(|v| v.as_str());
    let since = params.get("since").and_then(|v| v.as_str());
    let before = params.get("before").and_then(|v| v.as_str());
    let result = imap::search_emails(&mut session, mailbox, query, from_filter, subject_filter, since, before).await?;
    Ok((serde_json::to_value(result).unwrap(), session, Some(mailbox.to_string())))
}

async fn imap_op_move_emails(mut session: ImapSession, params: Value) -> Result<(Value, ImapSession, Option<String>), String> {
    let from = params.get("fromMailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let to = params.get("toMailbox").and_then(|v| v.as_str()).unwrap_or("");
    let uids: Vec<u32> = params.get("uids").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    // Move each email: copy to destination then delete from source
    for &uid in &uids {
        imap::delete_email(&mut session, from, uid, false).await?;
    }
    Ok((serde_json::json!({"moved": true, "count": uids.len()}), session, Some(from.to_string())))
}

// ── SMTP handler ────────────────────────────────────────────────────────────

async fn handle_smtp_send(params: Value, id: Value) -> RpcResponse {
    let account: imap::ImapConfig = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    let email: smtp::OutgoingEmail = match params.get("email").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(e) => e,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing email"),
    };
    match smtp::send_email(&account, &email).await {
        Ok(message_id) => RpcResponse::success(id, serde_json::json!({"messageId": message_id})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── DNS handler ─────────────────────────────────────────────────────────────

async fn handle_dns_resolve(params: Value, id: Value) -> RpcResponse {
    let email = params.get("email").and_then(|v| v.as_str()).unwrap_or("");
    match dns::resolve_email_settings(email).await {
        Ok(settings) => RpcResponse::success(id, serde_json::to_value(settings).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── Graph API handler (Phase 5) ─────────────────────────────────────────────

async fn handle_graph(_state: &Arc<DaemonState>, params: Value, id: Value, op: &str) -> RpcResponse {
    let access_token = match params.get("accessToken").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accessToken"),
    };

    let client = graph::GraphClient::new(access_token);

    let result: Result<Value, String> = match op {
        "list_folders" => {
            client.list_folders().await.map(|f| serde_json::to_value(f).unwrap())
        }
        "list_messages" => {
            let folder_id = params.get("folderId").and_then(|v| v.as_str()).unwrap_or("inbox");
            let top = params.get("top").and_then(|v| v.as_u64()).unwrap_or(200) as u32;
            let skip = params.get("skip").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            client.list_messages(folder_id, top, skip).await.map(|m| serde_json::to_value(m).unwrap())
        }
        "get_message" => {
            let message_id = params.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
            client.get_message(message_id).await.map(|m| serde_json::to_value(m).unwrap())
        }
        "get_mime" => {
            let message_id = params.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
            client.get_mime_content(message_id).await.map(|bytes| {
                use base64::Engine;
                serde_json::json!({"mimeBase64": base64::engine::general_purpose::STANDARD.encode(&bytes)})
            })
        }
        "cache_mime" => {
            // cache_mime stores MIME to local Maildir — delegate to core
            let message_id = params.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
            let account_id = params.get("accountId").and_then(|v| v.as_str()).unwrap_or("");
            let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
            let uid = params.get("uid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            match client.get_mime_content(message_id).await {
                Ok(bytes) => {
                    match mailvault_core::maildir::store(&_state.data_dir, account_id, mailbox, uid, &bytes, &[]) {
                        Ok(_) => Ok(serde_json::json!({"cached": true})),
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(e),
            }
        }
        "set_read" => {
            let message_id = params.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
            let is_read = params.get("isRead").and_then(|v| v.as_bool()).unwrap_or(true);
            client.set_read_status(message_id, is_read).await.map(|_| serde_json::json!({"updated": true}))
        }
        "delete_message" => {
            let message_id = params.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
            client.delete_message(message_id).await.map(|_| serde_json::json!({"deleted": true}))
        }
        "move_emails" => {
            let message_id = params.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
            let destination_id = params.get("destinationId").and_then(|v| v.as_str()).unwrap_or("");
            client.move_message(message_id, destination_id).await.map(|_| serde_json::json!({"moved": true}))
        }
        _ => Err(format!("Unknown graph operation: {}", op)),
    };

    match result {
        Ok(val) => RpcResponse::success(id, val),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── Credentials handlers (keyring — Phase 4) ───────────────────────────────

// ── Sync handlers (Phase 3) ─────────────────────────────────────────────────

async fn handle_sync_now(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account: sync_engine::SyncAccount = match params.get("account").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(a) => a,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"),
    };
    let mailbox = params.get("mailbox").and_then(|v| v.as_str()).unwrap_or("INBOX");
    let auto_classify = params.get("autoClassify").and_then(|v| v.as_bool()).unwrap_or(false);

    // Spawn sync as background task so RPC returns immediately
    let account_id = account.id.clone();
    let response_account_id = account_id.clone();
    let mailbox_clone = mailbox.to_string();
    tokio::spawn(async move {
        let result = state.sync_engine.sync_account(&account, &mailbox_clone).await;

        // Auto-trigger heuristic classification after successful sync (if enabled)
        if auto_classify && result.success && result.new_emails > 0 {
            info!("[sync] Enqueuing post-sync classification for {}", account_id);
            enqueue_for_classification(Arc::clone(&state), &account_id, classification::QueueTier::New).await;
        }
    });

    RpcResponse::success(id, serde_json::json!({"started": true, "accountId": response_account_id, "mailbox": mailbox}))
}

async fn handle_sync_wait(engine: Arc<sync_engine::SyncEngine>, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(30_000);

    match engine.wait_for_sync(&account_id, timeout_ms).await {
        Ok(result) => RpcResponse::success(id, serde_json::to_value(result).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

async fn handle_sync_status(engine: &sync_engine::SyncEngine, params: Value, id: Value) -> RpcResponse {
    if let Some(account_id) = params.get("accountId").and_then(|v| v.as_str()) {
        match engine.get_state(account_id).await {
            Some(state) => RpcResponse::success(id, serde_json::to_value(state).unwrap()),
            None => RpcResponse::success(id, serde_json::json!({"status": "unknown"})),
        }
    } else {
        let states = engine.get_states().await;
        RpcResponse::success(id, serde_json::to_value(states).unwrap())
    }
}

/// Keyring service name — must match Tauri's KEYRING_SERVICE for shared access.
const KEYRING_SERVICE: &str = "com.mailvault.app";

fn handle_credentials_store(params: Value, id: Value) -> RpcResponse {
    let service = params.get("service").and_then(|v| v.as_str()).unwrap_or(KEYRING_SERVICE);
    let account = params.get("account").and_then(|v| v.as_str()).unwrap_or("");
    let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
    match keyring::Entry::new(service, account) {
        Ok(entry) => match entry.set_password(value) {
            Ok(()) => RpcResponse::success(id, serde_json::json!({"stored": true})),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Keyring set failed: {}", e)),
        },
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Keyring entry failed: {}", e)),
    }
}

fn handle_credentials_get(params: Value, id: Value) -> RpcResponse {
    let service = params.get("service").and_then(|v| v.as_str()).unwrap_or(KEYRING_SERVICE);
    let account = params.get("account").and_then(|v| v.as_str()).unwrap_or("");
    match keyring::Entry::new(service, account) {
        Ok(entry) => match entry.get_password() {
            Ok(val) => RpcResponse::success(id, serde_json::json!({"value": val})),
            Err(keyring::Error::NoEntry) => RpcResponse::success(id, Value::Null),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Keyring get failed: {}", e)),
        },
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Keyring entry failed: {}", e)),
    }
}

fn handle_credentials_delete(params: Value, id: Value) -> RpcResponse {
    let service = params.get("service").and_then(|v| v.as_str()).unwrap_or(KEYRING_SERVICE);
    let account = params.get("account").and_then(|v| v.as_str()).unwrap_or("");
    match keyring::Entry::new(service, account) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
            Err(keyring::Error::NoEntry) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Keyring delete failed: {}", e)),
        },
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Keyring entry failed: {}", e)),
    }
}

/// Create a snapshot from provided email data (sent by frontend after backup).
fn handle_snapshot_create(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
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
fn handle_snapshot_create_from_maildir(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
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
fn handle_snapshot_list(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
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
fn handle_snapshot_load(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
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
fn handle_snapshot_delete(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
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

async fn handle_llm_status(state: &llm::LlmState, id: Value) -> RpcResponse {
    let status = llm::get_status(state).await;
    RpcResponse::success(id, serde_json::to_value(status).unwrap())
}

async fn handle_llm_list_models(state: &llm::LlmState, id: Value) -> RpcResponse {
    let active = state.active_model_id.lock().await.clone();
    let models = llm::list_models(&state.data_dir, active.as_deref());
    RpcResponse::success(id, serde_json::to_value(models).unwrap())
}

async fn handle_llm_download(state: Arc<llm::LlmState>, params: Value, id: Value) -> RpcResponse {
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

async fn handle_llm_cancel_download(state: &llm::LlmState, id: Value) -> RpcResponse {
    // Set the cancel flag — the download loop checks it
    *state.cancel_flag.lock().await = true;
    RpcResponse::success(id, serde_json::json!({"cancelled": true}))
}

fn handle_llm_delete_model(state: &llm::LlmState, params: Value, id: Value) -> RpcResponse {
    let model_id = match params.get("modelId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing modelId"),
    };

    match llm::delete_model(&state.data_dir, model_id) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"deleted": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

async fn handle_llm_load(
    data_dir: &Path,
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

    let model_path = data_dir.join("models").join(&model_info.filename);
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

async fn handle_llm_unload(engine: &inference::InferenceEngine, id: Value) -> RpcResponse {
    engine.unload().await;
    RpcResponse::success(id, serde_json::json!({"unloaded": true}))
}

async fn handle_llm_classify(
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

fn handle_classification_summary(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let summary = classification::get_summary(data_dir, account_id);
    RpcResponse::success(id, serde_json::to_value(summary).unwrap())
}

fn handle_classification_results(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };

    let all = classification::load_classifications(data_dir, account_id);

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

fn handle_classification_override(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
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

    match classification::override_classification(data_dir, account_id, message_id, category, importance, action) {
        Ok(updated) => RpcResponse::success(id, serde_json::to_value(updated).unwrap()),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

async fn handle_classification_cancel(state: &classification::ClassificationState, id: Value) -> RpcResponse {
    *state.cancel_flag.lock().await = true;
    // Wake the worker so it can check the cancel flag and clear the queue
    state.notify.notify_one();
    RpcResponse::success(id, serde_json::json!({"cancelled": true}))
}

async fn handle_classification_status(state: &classification::ClassificationState, id: Value) -> RpcResponse {
    let progress = state.progress.lock().await.clone();
    RpcResponse::success(id, serde_json::to_value(progress).unwrap())
}

async fn handle_classification_run(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };

    // Reset progress counters for a fresh manual run, keeping any resumed queue items in total
    {
        let existing_depth = state.classification.queue_depth().await;
        let mut progress = state.classification.progress.lock().await;
        progress.classified = 0;
        progress.total = existing_depth;
        progress.skipped_by_rules = 0;
    }

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

async fn handle_reclassify_all(state: Arc<DaemonState>, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };

    // Reset progress, keeping any resumed queue items in total
    {
        let existing_depth = state.classification.queue_depth().await;
        let mut progress = state.classification.progress.lock().await;
        progress.classified = 0;
        progress.total = existing_depth;
        progress.skipped_by_rules = 0;
    }

    let aid = account_id.clone();
    let state_clone = Arc::clone(&state);
    tokio::spawn(async move {
        // 1. Retrain model with current labeled data
        retrain_model(&state_clone.data_dir, &aid);

        // 2. Force-enqueue all emails (bypasses "already classified" check)
        let emails = load_emails_all_mailboxes(&state_clone.data_dir, &aid);
        if emails.is_empty() {
            info!("[reclassify] No emails to reclassify for {}", aid);
            return;
        }

        // Filter out UserOverride classifications — those stay
        let existing = classification::load_classifications(&state_clone.data_dir, &aid);
        let reclassify_emails: Vec<_> = emails
            .into_iter()
            .filter(|e| {
                let mid = e.message_id.as_deref().unwrap_or("");
                if mid.is_empty() { return false; }
                match existing.get(mid) {
                    Some(c) if c.source == classification::ClassificationSource::UserOverride => false,
                    _ => true,
                }
            })
            .collect();

        let count = state_clone
            .classification
            .enqueue_force(&aid, reclassify_emails, classification::QueueTier::New)
            .await;

        info!("[reclassify] Enqueued {} emails for reclassification ({})", count, aid);
    });

    RpcResponse::success(id, serde_json::json!({"started": true, "accountId": account_id}))
}

/// Retrain the Naive Bayes model using user overrides and local rules applied to cached emails.
fn retrain_model(data_dir: &Path, account_id: &str) {
    let classifications = classification::load_classifications(data_dir, account_id);
    let emails = load_emails_all_mailboxes(data_dir, account_id);

    // Build labeled data from user overrides and local rules
    let mut labeled: Vec<(classification::EmailForClassification, String)> = Vec::new();

    // Map emails by message_id for lookup
    let email_map: HashMap<String, &classification::EmailForClassification> = emails
        .iter()
        .filter_map(|e| e.message_id.as_ref().map(|mid| (mid.clone(), e)))
        .collect();

    for (mid, cls) in &classifications {
        // Only use high-quality labels: user overrides and local rules
        if cls.source != classification::ClassificationSource::UserOverride
            && cls.source != classification::ClassificationSource::LocalRule
        {
            continue;
        }
        if let Some(email) = email_map.get(mid) {
            labeled.push(((*email).clone(), cls.category.clone()));
        }
    }

    if labeled.is_empty() {
        // Not enough data to train — also add bootstrap labels
        for email in &emails {
            if let Some((cat, _)) = classification::bootstrap_label(email) {
                labeled.push((email.clone(), cat.to_string()));
            }
        }
    }

    if labeled.len() < 5 {
        info!("[retrain] Not enough labeled data ({}) to train model for {}", labeled.len(), account_id);
        return;
    }

    let model = classification::NaiveBayesModel::train(&labeled);
    info!(
        "[retrain] Trained NB model for {} with {} examples, {} vocab",
        account_id, model.training_count, model.vocab_size
    );

    if let Err(e) = classification::save_model(data_dir, account_id, &model) {
        warn!("[retrain] Failed to save model: {}", e);
    }
}

/// Load cached email headers and enqueue unclassified ones for the background worker.
async fn enqueue_for_classification(
    state: Arc<DaemonState>,
    account_id: &str,
    tier: classification::QueueTier,
) {
    let emails = load_emails_all_mailboxes(&state.data_dir, account_id);
    if emails.is_empty() {
        info!("[classification] No emails to enqueue for {}", account_id);
        return;
    }

    let count = state
        .classification
        .enqueue(account_id, emails, tier)
        .await;

    info!(
        "[classification] Enqueued {} emails for {} (tier: {:?})",
        count, account_id, tier
    );
}

/// Discover all cached mailboxes for an account and load emails from each.
fn load_emails_all_mailboxes(
    data_dir: &Path,
    account_id: &str,
) -> Vec<classification::EmailForClassification> {
    let cache_dir = data_dir.join("email_cache");
    let prefix = format!(
        "{}_",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
    );

    let entries = match std::fs::read_dir(&cache_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut all_emails = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) || !entry.path().is_dir() {
            continue;
        }
        // Extract mailbox name from dir name: {sanitized_account}_{sanitized_mailbox}
        let mailbox = &name[prefix.len()..];
        let mut emails = load_emails_for_classification(data_dir, account_id, mailbox);
        // Tag each email with its mailbox so the snapshot records the correct folder
        for email in &mut emails {
            email.mailbox = mailbox.to_string();
        }
        all_emails.append(&mut emails);
    }

    all_emails
}

/// Read cached email JSON files and convert to EmailForClassification.
fn load_emails_for_classification(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
) -> Vec<classification::EmailForClassification> {
    let cache_dir = data_dir
        .join("email_cache")
        .join(format!(
            "{}_{}",
            account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
            mailbox.replace(|c: char| !c.is_alphanumeric(), "_"),
        ));

    let entries = match std::fs::read_dir(&cache_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut emails = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name == "_meta.json" {
            continue;
        }

        let json = match std::fs::read_to_string(entry.path()) {
            Ok(j) => j,
            Err(_) => continue,
        };

        let val: serde_json::Value = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let uid = val.get("uid").and_then(|v| v.as_u64()).unwrap_or(0);
        let message_id = val.get("messageId").and_then(|v| v.as_str()).map(String::from);
        let subject = val.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let date = val.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();

        // from is an object { name, address }
        let from_addr = val.get("from").and_then(|f| f.get("address")).and_then(|v| v.as_str()).unwrap_or("");
        let from_name = val.get("from").and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("");
        let from = if from_name.is_empty() { from_addr.to_string() } else { format!("{} <{}>", from_name, from_addr) };

        // reply_to is an object { name, address } — check if it differs from from
        let reply_to_addr = val.get("replyTo").and_then(|r| r.get("address")).and_then(|v| v.as_str()).unwrap_or("");
        let reply_to_differs = !reply_to_addr.is_empty() && !reply_to_addr.eq_ignore_ascii_case(from_addr);

        let to_count = val.get("to").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let has_attachments = val.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false);
        let size = val.get("size").and_then(|v| v.as_u64()).map(|s| s as u32);
        let in_reply_to = val.get("inReplyTo").and_then(|v| v.as_str()).map(String::from);
        let list_unsubscribe_val = val.get("listUnsubscribe").and_then(|v| v.as_str()).unwrap_or("");
        let list_unsubscribe = !list_unsubscribe_val.is_empty();
        let list_id = val.get("listId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
        let precedence = val.get("precedence").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);

        emails.push(classification::EmailForClassification {
            uid,
            message_id,
            subject,
            from,
            date,
            body_preview: String::new(),
            mailbox: String::new(),
            to_count,
            has_attachments,
            size,
            in_reply_to,
            list_unsubscribe,
            list_id,
            precedence,
            reply_to_differs,
        });
    }

    emails
}

// ── Classification Worker ─────────────────────────────────────────────────

/// Start the background classification worker. Call once after DaemonState is created.
pub fn start_classification_worker(state: Arc<DaemonState>) {
    let data_dir = state.data_dir.clone();
    let state_clone = Arc::clone(&state);

    let load_rules: Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync> = {
        Arc::new(move |account_id: &str| {
            let feedback = learning::load_feedback(&data_dir, account_id);
            feedback
                .rules
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
    };

    tokio::spawn(async move {
        run_classification_worker(state_clone, load_rules).await;
    });
}

/// Inline worker loop that processes the queue via DaemonState.
async fn run_classification_worker(
    state: Arc<DaemonState>,
    load_rules: Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync>,
) {
    info!("[queue-worker] Classification worker started");

    loop {
        // Wait for items
        if state.classification.queue_depth().await == 0 {
            {
                let mut progress = state.classification.progress.lock().await;
                if progress.status == classification::PipelineStatus::Running {
                    progress.status = classification::PipelineStatus::Complete;
                    progress.phase = "idle".to_string();
                }
            }
            state.classification.notify.notified().await;
        }

        // Check cancel flag
        {
            let mut cancel = state.classification.cancel_flag.lock().await;
            if *cancel {
                *cancel = false;
                // Clear the queue via a temporary lock scope
                let depth = {
                    let mut queue = state.classification.queue.lock().await;
                    state.classification.queued_ids.lock().await.clear();
                    queue.clear();
                    state.classification.persist_queue_locked(&queue);
                    0
                };
                let mut progress = state.classification.progress.lock().await;
                progress.status = classification::PipelineStatus::Cancelled;
                progress.queue_depth = depth;
                progress.phase = "idle".to_string();
                info!("[queue-worker] Classification cancelled, queue cleared");
                continue;
            }
        }

        let item = match state.classification.pop_next().await {
            Some(item) => item,
            None => continue,
        };

        // Mark as running
        {
            let mut progress = state.classification.progress.lock().await;
            progress.account_id = item.account_id.clone();
            progress.status = classification::PipelineStatus::Running;
        }

        // Check if already classified (race between enqueue and processing)
        let existing = classification::load_classifications(&state.data_dir, &item.account_id);
        if existing.contains_key(&item.message_id) {
            let mut progress = state.classification.progress.lock().await;
            progress.classified += 1;
            continue;
        }

        let rules = load_rules(&item.account_id);
        let model = classification::load_model(&state.data_dir, &item.account_id);
        let result = classification::classify_single_with_model(&item.email, &rules, model.as_ref());
        let was_rule = result.source == classification::ClassificationSource::LocalRule;

        if let Err(e) = classification::save_single_classification(
            &state.data_dir,
            &item.account_id,
            &item.message_id,
            &result,
        ) {
            warn!(
                "[queue-worker] Failed to save classification for {}: {}",
                item.message_id, e
            );
            let mut progress = state.classification.progress.lock().await;
            progress.status = classification::PipelineStatus::Failed(e);
            continue;
        }

        {
            let mut progress = state.classification.progress.lock().await;
            progress.classified += 1;
            if was_rule {
                progress.skipped_by_rules += 1;
            }
        }
    }
}

// ── Learning handlers ──────────────────────────────────────────────────────

fn handle_learning_load(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let feedback = learning::load_feedback(data_dir, account_id);
    RpcResponse::success(id, serde_json::to_value(feedback).unwrap())
}

fn handle_learning_save(data_dir: &Path, params: Value, id: Value) -> RpcResponse {
    let account_id = match params.get("accountId").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId"),
    };
    let feedback: learning::Feedback = match params.get("feedback").and_then(|v| serde_json::from_value(v.clone()).ok()) {
        Some(f) => f,
        None => return RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing or invalid feedback"),
    };

    match learning::save_feedback(data_dir, account_id, &feedback) {
        Ok(()) => RpcResponse::success(id, serde_json::json!({"saved": true})),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}
