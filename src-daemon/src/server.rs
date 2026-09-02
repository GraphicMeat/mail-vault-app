use crate::auth;
use crate::classification;
use crate::contacts_index;
use crate::handlers::*;
use crate::imap;
use crate::inference;
use crate::ipc::{self, AuthHandshake, RpcRequest, RpcResponse};
use crate::netgate::NetGate;
use crate::llm;
use crate::sync_engine;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tracing::{error, info, warn};

/// Daemon server state shared across connections.
pub struct DaemonState {
    pub token: String,
    /// Where the mail lives — the user-selected vault folder when set.
    pub data_dir: PathBuf,
    /// App data dir: models, logs, daemon bookkeeping. Never on a removable drive.
    pub app_dir: PathBuf,
    /// False when a custom mail folder is configured but unreachable.
    pub mail_dir_ok: bool,
    pub started_at: std::time::Instant,
    pub llm: Arc<llm::LlmState>,
    pub inference: Arc<inference::InferenceEngine>,
    pub classification: classification::ClassificationState,
    pub imap_pool: Arc<imap::ImapPool>,
    pub sync_engine: Arc<sync_engine::SyncEngine>,
    pub contacts: Arc<contacts_index::ContactsState>,
    /// Shut while the host has no connectivity. Sync consults it; user-initiated
    /// IMAP ops only *feed* it — a captive portal must never lock the user out
    /// of an action they explicitly asked for.
    pub net: Arc<NetGate>,
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

    // The user moved the mail off the app data dir and that folder is not
    // reachable. Anything that touches mail must fail loudly — writing into the
    // app data dir instead would silently start a second, divergent archive.
    if !state.mail_dir_ok
        && (req.method.starts_with("sync.")
            || req.method.starts_with("snapshot.")
            || req.method.starts_with("contacts_index."))
    {
        return RpcResponse::error(
            id,
            ipc::INTERNAL_ERROR,
            "Mail storage folder is not available. Reconnect the drive or choose the folder again in Settings.",
        );
    }

    match req.method.as_str() {
        "ping" => RpcResponse::success(id, serde_json::json!({"pong": true})),

        "daemon.heartbeat" => RpcResponse::success(id, serde_json::json!({
            "alive": true,
            "uptime_secs": state.started_at.elapsed().as_secs(),
            "version": env!("CARGO_PKG_VERSION"),
            "online": state.net.is_online(),
        })),

        "daemon.status" => RpcResponse::success(
            id,
            serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "uptime_secs": state.started_at.elapsed().as_secs(),
                "data_dir": state.data_dir.to_string_lossy(),
            }),
        ),

        // ── Connectivity ────────────────────────────────────────────
        "net.status" => RpcResponse::success(id, state.net.status()),
        // Forced probe. The app calls this on the webview's `online` event, so
        // a reconnect reopens the gate at once instead of waiting out the
        // watchdog's backoff.
        "net.probe" => {
            state.net.confirm_online().await;
            RpcResponse::success(id, state.net.status())
        }

        // ── Sync engine (Phase 3) ───────────────────────────────────
        "sync.now" => handle_sync_now(Arc::clone(state), req.params, id).await,
        "sync.wait" => handle_sync_wait(Arc::clone(&state.sync_engine), req.params, id).await,
        "sync.status" => handle_sync_status(&state.sync_engine, req.params, id).await,

        // Cache / local index / Graph ID map RPCs removed: they were backed by
        // mailvault_core::cache, a second cache format at a different path that
        // nothing ever read. transport.js routes every cache operation to the
        // Tauri sidecar implementation, and the daemon writes that same format
        // from sync_engine.

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
        "llm.load" => handle_llm_load(&state.app_dir, &state.llm, &state.inference, req.params, id).await,
        "llm.unload" => handle_llm_unload(&state.inference, id).await,
        "llm.classify" => handle_llm_classify(&state.inference, req.params, id).await,

        "classification.run" => handle_classification_run(Arc::clone(state), req.params, id).await,
        "classification.reclassify_all" => handle_reclassify_all(Arc::clone(state), req.params, id).await,
        "classification.cancel" => handle_classification_cancel(&state.classification, id).await,
        "classification.summary" => handle_classification_summary(&state.app_dir, req.params, id),
        "classification.results" => handle_classification_results(&state.app_dir, req.params, id),
        "classification.override" => handle_classification_override(&state.app_dir, req.params, id),
        "classification.status" => handle_classification_status(&state.classification, id).await,

        "learning.load" => handle_learning_load(&state.app_dir, req.params, id),
        "learning.save" => handle_learning_save(&state.app_dir, req.params, id),

        "contacts_index.get" => handle_contacts_index_get(Arc::clone(&state.contacts), req.params, id),

        _ => RpcResponse::error(id, ipc::METHOD_NOT_FOUND, format!("Unknown method: {}", req.method)),
    }
}

#[cfg(test)]
impl DaemonState {
    /// A state wired the way main.rs wires it, but pointed at scratch dirs.
    pub(crate) fn for_test(mail_dir: PathBuf, app_dir: PathBuf, mail_dir_ok: bool) -> Arc<DaemonState> {
        let imap_pool = Arc::new(imap::ImapPool::new());
        let contacts = contacts_index::ContactsState::new(mail_dir.clone());
        // A gate whose probe always answers "online": these tests are about
        // routing and state, never about connectivity.
        let net = NetGate::with_probe(Arc::new(|| Box::pin(async { true })));
        let sync_engine = Arc::new(sync_engine::SyncEngine::new(
            Arc::clone(&imap_pool),
            mail_dir.clone(),
            app_dir.clone(),
            Arc::clone(&contacts),
            Arc::clone(&net),
        ));
        Arc::new(DaemonState {
            net,
            token: "a".repeat(64),
            data_dir: mail_dir,
            app_dir: app_dir.clone(),
            mail_dir_ok,
            started_at: std::time::Instant::now(),
            llm: Arc::new(llm::LlmState::new(app_dir.clone())),
            inference: Arc::new(inference::InferenceEngine::new()),
            classification: classification::ClassificationState::new(app_dir),
            imap_pool,
            sync_engine,
            contacts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-server-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn req(method: &str, params: Value) -> RpcRequest {
        RpcRequest {
            method: method.into(),
            params,
            id: Some(json!(1)),
        }
    }

    fn err_message(resp: RpcResponse) -> String {
        resp.error.map(|e| e.message).unwrap_or_default()
    }

    // ── The mail-dir gate ──────────────────────────────────────────────

    #[tokio::test]
    async fn a_missing_vault_refuses_the_contacts_index() {
        let dir = scratch("gate");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), false);

        let resp = handle_request(&state, req("contacts_index.get", json!({"accountIds": ["acc1"]}))).await;

        let msg = err_message(resp);
        assert!(
            msg.contains("Mail storage folder"),
            "contacts_index.get must be refused while the vault is unreachable, got: {msg:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_gate_covers_every_mail_family_and_nothing_else() {
        let dir = scratch("gate-family");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), false);

        for (method, params) in [
            ("sync.status", json!({"accountId": "a"})),
            ("snapshot.list", json!({"accountId": "a"})),
            ("contacts_index.get", json!({"accountIds": ["a"]})),
        ] {
            let msg = err_message(handle_request(&state, req(method, params)).await);
            assert!(msg.contains("Mail storage folder"), "{method} was not refused, got: {msg:?}");
        }

        for (method, params) in [
            ("ping", json!({})),
            ("daemon.heartbeat", json!({})),
            ("learning.load", json!({"accountId": "a"})),
            ("classification.summary", json!({"accountId": "a"})),
        ] {
            let msg = err_message(handle_request(&state, req(method, params)).await);
            assert!(!msg.contains("Mail storage folder"), "{method} must not be gated, got: {msg:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Routing ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn an_unknown_method_names_itself_in_the_error() {
        let dir = scratch("route");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let resp = handle_request(&state, req("nope.nope", json!({}))).await;

        let err = resp.error.expect("unknown method must be an error");
        assert_eq!(err.code, ipc::METHOD_NOT_FOUND);
        assert!(err.message.contains("nope.nope"), "got: {}", err.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ping_answers_pong_under_the_request_id() {
        let dir = scratch("ping");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let mut r = req("ping", json!({}));
        r.id = Some(json!(42));
        let resp = handle_request(&state, r).await;

        assert_eq!(resp.result, Some(json!({"pong": true})));
        assert_eq!(resp.id, json!(42));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_request_without_an_id_answers_under_a_null_id() {
        let dir = scratch("noid");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let mut r = req("ping", json!({}));
        r.id = None;
        let resp = handle_request(&state, r).await;

        assert_eq!(resp.id, Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sync_wait_without_a_ticket_is_invalid_params() {
        let dir = scratch("syncwait");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let resp = handle_request(&state, req("sync.wait", json!({}))).await;

        assert_eq!(resp.error.expect("must be an error").code, ipc::INVALID_PARAMS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_list_without_an_account_is_invalid_params() {
        let dir = scratch("snaplist");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let resp = handle_request(&state, req("snapshot.list", json!({}))).await;

        assert_eq!(resp.error.expect("must be an error").code, ipc::INVALID_PARAMS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── The socket: handshake and framing ──────────────────────────────

    /// A short private dir: `run` chmods the socket's parent to 0700, and the
    /// whole socket path must stay under SUN_LEN (104 bytes).
    fn sock_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    struct Served {
        dir: PathBuf,
        path: PathBuf,
        state: Arc<DaemonState>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Served {
        async fn start() -> Served {
            let dir = sock_dir();
            let path = dir.join("s.sock");
            let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
            let (s, p) = (Arc::clone(&state), path.clone());
            let task = tokio::spawn(async move {
                let _ = run(s, &p).await;
            });
            for _ in 0..200 {
                if path.exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(path.exists(), "server never bound {path:?}");
            Served { dir, path, state, task }
        }

        async fn connect(&self) -> (tokio::io::Lines<BufReader<OwnedReadHalf>>, OwnedWriteHalf) {
            let (r, w) = tokio::net::UnixStream::connect(&self.path).await.unwrap().into_split();
            (BufReader::new(r).lines(), w)
        }

        fn stop(self) {
            self.task.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn send(w: &mut OwnedWriteHalf, line: &str) {
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
    }

    async fn recv(lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>) -> Value {
        let line = lines.next_line().await.unwrap().expect("server closed the connection");
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn a_bad_token_is_rejected_before_any_rpc() {
        let served = Served::start().await;
        let (mut lines, mut w) = served.connect().await;

        send(&mut w, r#"{"token":"nope"}"#).await;
        let resp = recv(&mut lines).await;

        assert_eq!(resp["error"]["code"], json!(ipc::AUTH_FAILED));
        assert!(
            lines.next_line().await.unwrap().is_none(),
            "a rejected connection must be closed, not kept open"
        );
        served.stop();
    }

    #[tokio::test]
    async fn a_good_token_then_ping_round_trips() {
        let served = Served::start().await;
        let (mut lines, mut w) = served.connect().await;

        send(&mut w, &format!(r#"{{"token":"{}"}}"#, served.state.token)).await;
        assert_eq!(recv(&mut lines).await["result"], json!({"authenticated": true}));

        send(&mut w, r#"{"jsonrpc":"2.0","method":"ping","id":7}"#).await;
        let resp = recv(&mut lines).await;
        assert_eq!(resp["result"], json!({"pong": true}));
        assert_eq!(resp["id"], json!(7));
        served.stop();
    }

    #[tokio::test]
    async fn a_garbage_line_after_auth_answers_a_parse_error_and_keeps_the_connection() {
        let served = Served::start().await;
        let (mut lines, mut w) = served.connect().await;
        send(&mut w, &format!(r#"{{"token":"{}"}}"#, served.state.token)).await;
        recv(&mut lines).await;

        send(&mut w, "not json").await;
        let resp = recv(&mut lines).await;
        assert_eq!(resp["error"]["code"], json!(ipc::PARSE_ERROR));
        assert_eq!(resp["id"], Value::Null);

        send(&mut w, r#"{"jsonrpc":"2.0","method":"ping","id":8}"#).await;
        let resp = recv(&mut lines).await;
        assert_eq!(resp["result"], json!({"pong": true}));
        assert_eq!(resp["id"], json!(8));
        served.stop();
    }

    #[tokio::test]
    async fn a_second_daemon_cannot_steal_a_live_socket() {
        let served = Served::start().await;
        let other = scratch("second");
        let state2 = DaemonState::for_test(other.clone(), other.clone(), true);

        let err = run(state2, &served.path).await.expect_err("binding a live socket must fail");

        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
        let _ = std::fs::remove_dir_all(&other);
        served.stop();
    }
}
