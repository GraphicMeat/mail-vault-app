use crate::auth;
use crate::classification;
use crate::contacts_index;
use crate::handlers::*;
use crate::idle_watch;
use crate::imap;
use crate::inference;
use crate::ipc::{self, AuthHandshake, RpcRequest, RpcResponse};
use crate::netgate::NetGate;
use crate::llm;
use crate::sync_engine;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tracing::{error, info, warn};

/// One run's cancel/pause/notify trio, registered under an operation kind
/// ("archive", "bulk_delete", "migration", "restore") in
/// `DaemonState.run_tokens`. Task 4.7 decision 7: generalizes Task 3.4's
/// archive/bulk-delete-only `cancels: HashMap<&str, Vec<Arc<AtomicBool>>>`
/// into one registry every cancellable long-running route shares. Archive and
/// bulk delete only ever need `cancel`; migration additionally needs
/// `pause`+`notify` for its pause/resume flow; restore needs only `cancel`,
/// like archive. `handlers::common::RunGuard` is the only writer.
pub struct RunTokens {
    pub cancel: Arc<AtomicBool>,
    pub pause: Option<Arc<AtomicBool>>,
    pub notify: Option<Arc<tokio::sync::Notify>>,
}

/// Daemon server state shared across connections.
pub struct DaemonState {
    pub token: String,
    /// Where the mail lives — the user-selected vault folder when set.
    pub data_dir: PathBuf,
    /// App data dir: models, logs, daemon bookkeeping. Never on a removable drive.
    pub app_dir: PathBuf,
    /// False when a custom mail folder is configured but unreachable.
    pub mail_dir_ok: bool,
    /// Phase 6: the configured vault's human-readable path — kept even when
    /// `data_dir` has fallen back to `app_dir` because it's unreachable, so
    /// `vault_get_status` can still tell the user *which* folder it's
    /// looking for. Set once at startup (`resolve_vault_location`), like
    /// `data_dir`/`mail_dir_ok` themselves — a location switch always
    /// restarts the daemon (spec §3.4a), never mutates these live.
    pub vault_display_path: std::sync::Mutex<String>,
    /// Whether a custom (non-default) folder is configured at all —
    /// `data_dir == app_dir` alone can't tell "using the default" apart from
    /// "custom folder that happens to fail all the way back to app_dir".
    pub vault_is_custom: std::sync::Mutex<bool>,
    /// User-facing reason the configured folder isn't usable, if any.
    pub vault_last_error: std::sync::Mutex<Option<String>>,
    /// Task 6.3: set by `vault_move_to`/`vault_move_to_default` between the
    /// copy and `vault_move_finalize`, keyed by `move_id` so a stale or
    /// mismatched finalize call can never commit (delete source files for) a
    /// move it wasn't answering.
    pub pending_move: std::sync::Mutex<Option<crate::handlers::vault::PendingMove>>,
    /// Set between `vault_close` and `vault_reopen` (Task 2.5, spec deviation
    /// 8): every vault-rooted Phase 2 route refuses through
    /// `handlers::common::vault_root` while this is set, so nothing writes
    /// into a root the app is mid-copy on.
    ///
    /// Task 2.7 (2.5 review I4): `Arc`-wrapped, not just a bare `AtomicBool`,
    /// because `sync_engine::SyncEngine` now holds a clone of the exact same
    /// flag — a sync write checks it directly (per write, never across an
    /// `.await`) instead of going through a route at all, so `vault_close`
    /// drains sync writers too, not only RPC-handler ones.
    pub vault_closed: Arc<AtomicBool>,
    /// I3 fix (Task 2.5 fix round 1): `vault_closed` alone is check-then-act
    /// — a writer that already read `vault_root` can still be mid-write when
    /// `vault_close` returns. Every vault write takes this lock's read side
    /// via `handlers::common::with_vault_write` (many writers at once, never
    /// blocking each other); `vault_close` takes the write side just long
    /// enough to drain every writer already in flight before it closes the
    /// index (and, from Task 2.9a/b, custody). Always taken from a blocking
    /// thread (`spawn_blocking`), never held across a tokio `.await`. Long
    /// jobs (Tasks 2.8, 2.9a) take it per file/mailbox batch, never once
    /// around the whole job, so a drain can't be blocked out for minutes.
    ///
    /// Task 2.7: also `Arc`-shared with `SyncEngine` (see `vault_closed`
    /// above) so `vault_close`'s drain waits out an in-flight sync write too.
    pub vault_gate: Arc<std::sync::RwLock<()>>,
    pub started_at: std::time::Instant,
    pub llm: Arc<llm::LlmState>,
    pub inference: Arc<inference::InferenceEngine>,
    pub classification: classification::ClassificationState,
    pub imap_pool: Arc<imap::ImapPool>,
    /// Task 5.7: the ONE `OAuth2Manager` instance for the process — its
    /// `pending`/`senders` maps must survive between an `oauth2_auth_url`
    /// call and the later `oauth2_exchange` that redeems the same `state`
    /// token, and its loopback callback server (`127.0.0.1:19876`) must only
    /// ever be bound once. Moved from the app's `.manage(OAuth2Manager::new())`
    /// (main.rs) — no extra `Arc` needed, its own internals are already
    /// `Arc<Mutex<_>>`-backed and `DaemonState` itself is always behind one.
    pub oauth2: mailvault_core::oauth2::OAuth2Manager,
    pub sync_engine: Arc<sync_engine::SyncEngine>,
    /// One IDLE watcher per registered account. The app registers them
    /// (`sync.watch`) — the daemon holds no account list of its own.
    pub idle: Arc<idle_watch::IdleWatchers>,
    pub contacts: Arc<contacts_index::ContactsState>,
    /// Shut while the host has no connectivity. Sync consults it; user-initiated
    /// IMAP ops only *feed* it — a captive portal must never lock the user out
    /// of an action they explicitly asked for.
    pub net: Arc<NetGate>,
    /// Woken by `daemon.shutdown`; main's signal task runs the SIGTERM cleanup.
    pub shutdown: Arc<tokio::sync::Notify>,
    /// Broadcast bus for `channel.open` connections; any module can `emit` into it.
    pub events: crate::events::EventBus,
    pub search_index: Arc<crate::search_index::SearchIndexState>,
    /// Task 2.9a: not opened at daemon startup by this task (Task 2.9b wires
    /// that, once nothing in the app still holds the exclusive lock on
    /// `custody.db`) — see `crate::custody`.
    pub custody: crate::custody::CustodyState,
    /// Task 2.6: one attachment-prefetch sweep at a time, process-wide — the
    /// daemon's own copy of the app's `PREFETCH_LOCK` static (main.rs:1898).
    pub prefetch_lock: std::sync::Mutex<()>,
    /// Per-(account,mailbox) newest-uid-already-swept mark — the daemon's own
    /// copy of `PREFETCH_HIGH_WATER` (main.rs:1899). Resets on every daemon
    /// restart (reconnect, vault switch, version mismatch): cheap (skips
    /// existing cache files by stat), inventory-maildir oddity 9.
    pub prefetch_high_water: std::sync::Mutex<Vec<(String, u32)>>,
    /// Task 2.7: guards `op_journal_queue`/`op_journal_clear`'s
    /// load-modify-write. Both are handler routes on `spawn_blocking`, so
    /// without this two concurrent `queueOp`s (a bulk flag change queues one
    /// per message in a loop, `messageMutations.js`) race: both load the same
    /// on-disk journal, both append, and the second write clobbers the
    /// first's entry — a confirmed server op silently forgotten
    /// (`inventory-cache.md` §4b.3). `op_journal_read` does not need it: every
    /// write already goes through `fsx::write_atomic`, so a concurrent reader
    /// only ever sees a complete journal, old or new, never a torn one.
    pub journal: std::sync::Mutex<()>,
    /// Task 3.4, generalized by Task 4.7 (decision 7): per-operation-kind run
    /// tokens ("archive", "bulk_delete", "migration", "restore"). Replaces
    /// the app's single global `ArchiveCancelToken`/`MigrationCancelToken`/
    /// `MigrationPauseToken`/`MigrationNotify`/`RestoreCancelToken`
    /// (inventory-archive-bulk N4 and its migration-side sibling): keyed by
    /// kind so `cancel_archive` never stops a bulk delete, and `Vec`-valued
    /// per kind so two concurrent runs of the same kind are each still
    /// individually cancellable. `handlers::common::RunGuard` is the only
    /// writer; every exit path (success, error, cancellation, panic) removes
    /// its own entry via `Drop`, keyed by pointer identity so it never
    /// removes a sibling run's.
    pub run_tokens: std::sync::Mutex<std::collections::HashMap<&'static str, Vec<Arc<RunTokens>>>>,
    /// Task 3.6: in-daemon insights snapshots, moved whole from
    /// `src-tauri/src/insights.rs`. The app's own copy and its three Tauri
    /// commands still exist and still work until Task 3.7 cuts the frontend
    /// over and deletes them: this is a second, parallel copy of the state,
    /// not a replacement yet. Its 30s expiry sweeper is spawned once from
    /// `daemon_main` (`insights::InsightsSnapshots::start_cleanup`), not
    /// per-state.
    pub insights: crate::insights::InsightsSnapshots,
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
            Ok(req) if req.method == "channel.open" => {
                // Subscribe before answering: no event emitted after the client
                // sees this response can be missed.
                let rx = state.events.subscribe();
                let mut buf = serde_json::to_vec(&RpcResponse::success(
                    req.id.unwrap_or(Value::Null),
                    serde_json::json!({"channel": true}),
                ))
                .unwrap_or_default();
                buf.push(b'\n');
                writer.write_all(&buf).await?;
                // From here the connection is a duplex notification channel:
                // no more request/response framing, ever.
                return crate::channel::run(Arc::clone(&state), rx, lines, writer).await;
            }
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

    if let Some(resp) = crate::handlers::daemon::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::search_index::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::vault_files::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::vault::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::archive::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::insights::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::export_fetch::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::backup_zip::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::mbox::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::migration::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::restore::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::cache::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::journal::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::custody::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::vault_flags::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::imap::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::smtp::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::graph::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::oauth2::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::dns::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    match req.method.as_str() {
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

        // ── IDLE watchers + the change feed they push into ──────────
        "sync.watch" => handle_sync_watch(Arc::clone(state), req.params, id).await,
        "sync.unwatch" => handle_sync_unwatch(Arc::clone(state), req.params, id).await,
        "sync.events" => handle_sync_events(Arc::clone(&state.sync_engine), req.params, id).await,
        "sync.watch_status" => RpcResponse::success(
            id,
            serde_json::to_value(state.idle.status().await).unwrap_or_default(),
        ),

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
pub(crate) async fn handle_request_for_test(state: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
    handle_request(state, RpcRequest { method: method.into(), params, id: Some(serde_json::json!(1)) }).await
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
        let vault_closed = Arc::new(AtomicBool::new(false));
        let vault_gate = Arc::new(std::sync::RwLock::new(()));
        let sync_engine = Arc::new(sync_engine::SyncEngine::new(
            Arc::clone(&imap_pool),
            mail_dir.clone(),
            app_dir.clone(),
            Arc::clone(&contacts),
            Arc::clone(&net),
            Arc::clone(&vault_closed),
            Arc::clone(&vault_gate),
        ));
        let idle = idle_watch::IdleWatchers::new(
            Arc::clone(&sync_engine),
            Arc::clone(&imap_pool),
            Arc::clone(&net),
            std::time::Duration::from_millis(50),
        );
        let events = crate::events::EventBus::new(crate::events::CAPACITY);
        Arc::new(DaemonState {
            net,
            idle,
            token: "a".repeat(64),
            data_dir: mail_dir.clone(),
            app_dir: app_dir.clone(),
            mail_dir_ok,
            vault_display_path: std::sync::Mutex::new(mail_dir.to_string_lossy().into_owned()),
            vault_is_custom: std::sync::Mutex::new(false),
            vault_last_error: std::sync::Mutex::new(None),
            pending_move: std::sync::Mutex::new(None),
            vault_closed,
            vault_gate,
            started_at: std::time::Instant::now(),
            llm: Arc::new(llm::LlmState::new(app_dir.clone())),
            inference: Arc::new(inference::InferenceEngine::new()),
            classification: classification::ClassificationState::new(app_dir),
            imap_pool,
            oauth2: mailvault_core::oauth2::OAuth2Manager::new(),
            sync_engine,
            contacts,
            shutdown: Arc::new(tokio::sync::Notify::new()),
            search_index: crate::search_index::SearchIndexState::new(mail_dir, mail_dir_ok, events.clone()),
            events,
            prefetch_lock: std::sync::Mutex::new(()),
            prefetch_high_water: std::sync::Mutex::new(Vec::new()),
            journal: std::sync::Mutex::new(()),
            custody: crate::custody::CustodyState::default(),
            run_tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
            insights: crate::insights::InsightsSnapshots::default(),
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
            ("sync.watch", json!({})),
            ("sync.unwatch", json!({})),
            ("sync.events", json!({})),
            ("sync.watch_status", json!({})),
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
            // Task 5.4a: flat `imap_*` names have no `.`, so they never match
            // this gate's prefix check — a live IMAP read has nothing to do
            // with the vault. Bogus host/port so this fails fast on a
            // connection error, never on the gate text this test checks for.
            ("imap_get_mailboxes", json!({"account": {"email": "a@b.co", "imapHost": "127.0.0.1", "imapPort": 1}})),
            // Task 5.4b: same reasoning, write-path family. Bogus host/port
            // so this fails fast on a connection error too, never a success.
            ("imap_test_connection", json!({"account": {"email": "a@b.co", "imapHost": "127.0.0.1", "imapPort": 1}})),
            // Task 5.5: SMTP is its own flat family, same reasoning — a live
            // SMTP probe has nothing to do with the vault gate. `imapHost` is
            // a required `ImapConfig` field even though this command never
            // dials IMAP, so it must be present for this to fail on the bogus
            // SMTP connection rather than on param deserialization.
            ("smtp_test_connection", json!({"account": {"email": "a@b.co", "imapHost": "127.0.0.1", "imapPort": 1, "smtpHost": "127.0.0.1", "smtpPort": 1}})),
            // Task 5.6: Graph is its own flat family too, same reasoning — a
            // live Graph HTTP call has nothing to do with the vault gate.
            // Unlike IMAP/SMTP, `GraphClient` takes no host/port in its
            // params — its base URL is `MAILVAULT_GRAPH_BASE` (read once into
            // a process-wide `OnceLock` on first use), so this points it at a
            // closed local port instead. If `handlers::graph`'s own tests
            // already initialized that `OnceLock` to their mock server
            // earlier in this process, this `set_var` is a no-op and the
            // call reaches that mock instead — either way the response is an
            // error that never contains "Mail storage folder", which is all
            // this assertion checks.
            ("graph_set_read", {
                std::env::set_var("MAILVAULT_GRAPH_BASE", "http://127.0.0.1:1");
                json!({"accessToken": "x", "messageId": "m1", "isRead": true})
            }),
            // Task 5.7: OAuth2 is its own flat family too — a token exchange
            // has nothing to do with the vault gate. An unknown `state`
            // fails immediately in-process (no pending flow to await, no
            // network call), which keeps this assertion fast and
            // deterministic without touching the loopback callback port.
            ("oauth2_exchange", json!({"state": "no-such-pending-flow"})),
        ] {
            let msg = err_message(handle_request(&state, req(method, params)).await);
            assert!(!msg.contains("Mail storage folder"), "{method} must not be gated, got: {msg:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Routing ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn daemon_methods_route_through_the_domain_router_and_ungated() {
        let dir = scratch("router");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), false);
        let resp = handle_request(&state, req("daemon.heartbeat", json!({}))).await;
        assert_eq!(resp.result.expect("heartbeat works with the vault gone")["buildId"], json!(mailvault_core::BUILD_ID));
        let _ = std::fs::remove_dir_all(&dir);
    }

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
    async fn sync_watch_without_an_account_is_invalid_params() {
        let dir = scratch("syncwatch");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let resp = handle_request(&state, req("sync.watch", json!({}))).await;

        assert_eq!(resp.error.expect("must be an error").code, ipc::INVALID_PARAMS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Task 5.2: `sync.now`'s payload no longer carries a password —
    /// `toSyncAccount` (src/services/syncService.js) stops sending it. The
    /// handler must resolve it itself via `credentials::resolve_account_credentials`
    /// (the `MAILVAULT_TEST_CREDENTIALS` file bypass here, standing in for the
    /// keychain) rather than trusting whatever the payload's `imapConfig` says.
    /// The mock server's `expect_login` only accepts the REAL password
    /// ("hunter2"), which never appears in the RPC payload below — so this
    /// only goes green if resolution actually happened.
    #[tokio::test]
    async fn sync_now_authenticates_via_resolved_credentials_not_the_payload() {
        use mock_imap::state::synthetic_mailbox;

        // `MAILVAULT_TEST_CREDENTIALS` is a process-global env var; hold the
        // crate-shared lock (see `credentials::test_env_lock`) for its whole
        // set-use-remove span so this doesn't race credentials.rs's own test.
        let _env_guard = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let dir = scratch("syncnow-creds");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");

        let mut scenario = mock_imap::Scenario::new().mailbox(synthetic_mailbox("INBOX", 1));
        scenario.state.expect_login = Some(("user@example.com".to_string(), "hunter2".to_string()));
        let server = mock_imap::MockImap::start(scenario);

        // The test-credentials bypass file: same shape as the real keychain
        // blob (`{ accountId: JSON-string-of-account }`), same shape
        // `resolve_account_credentials`'s own unit test uses.
        let creds_path = dir.join("credentials.json");
        let account_json = json!({
            "id": "acc1",
            "email": "user@example.com",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
        })
        .to_string();
        let mut blob = std::collections::HashMap::new();
        blob.insert("acc1".to_string(), account_json);
        std::fs::write(&creds_path, serde_json::to_string(&blob).unwrap()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds_path);

        // No `password`/`oauth2AccessToken` anywhere in this payload — the
        // post-5.2 shape `toSyncAccount` sends.
        let payload = json!({
            "account": {
                "id": "acc1",
                "email": "user@example.com",
                "imapConfig": {
                    "email": "user@example.com",
                    "imapHost": server.host(),
                    "imapPort": server.port(),
                }
            },
            "mailbox": "INBOX",
        });

        let resp = handle_request(&state, req("sync.now", payload)).await;
        let result = resp.result.expect("sync.now must accept a payload with no password");
        let ticket = result["ticket"].as_u64().expect("ticket");

        let wait = handle_request(
            &state,
            req("sync.wait", json!({"ticket": ticket, "timeoutMs": 5000})),
        )
        .await;
        let sync_result = wait.result.expect("sync.wait must succeed");
        assert_eq!(
            sync_result["success"],
            json!(true),
            "sync must authenticate using credentials resolved in the daemon, not the payload: {sync_result:?}"
        );

        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The long-poll answers with the current generation even when nothing has
    /// happened — the app needs a number to come back with.
    #[tokio::test]
    async fn sync_events_answers_the_current_generation_when_nothing_changed() {
        let dir = scratch("syncevents");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        let resp = handle_request(&state, req("sync.events", json!({"timeoutMs": 10}))).await;

        let result = resp.result.expect("must succeed");
        assert_eq!(result["gen"], json!(0));
        assert_eq!(result["changes"], json!([]));
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

    // ── channel.open ─────────────────────────────────────────────────

    async fn open_channel(served: &Served) -> (tokio::io::Lines<BufReader<OwnedReadHalf>>, OwnedWriteHalf) {
        let (mut lines, mut w) = served.connect().await;
        send(&mut w, &format!(r#"{{"token":"{}"}}"#, served.state.token)).await;
        recv(&mut lines).await;
        send(&mut w, r#"{"jsonrpc":"2.0","method":"channel.open","id":3}"#).await;
        let opened = recv(&mut lines).await;
        assert_eq!(opened["result"], json!({"channel": true}));
        assert_eq!(opened["id"], json!(3));
        (lines, w)
    }

    #[tokio::test]
    async fn an_open_channel_forwards_bus_events() {
        let served = Served::start().await;
        let (mut lines, _w) = open_channel(&served).await;
        served.state.events.emit("search-index-progress", json!({"indexed": 5}));
        let ev = recv(&mut lines).await;
        assert_eq!(ev["method"], "event");
        assert_eq!(ev["params"]["name"], "search-index-progress");
        assert_eq!(ev["params"]["payload"], json!({"indexed": 5}));
        assert!(ev.get("id").is_none(), "events carry no id");
        served.stop();
    }

    #[tokio::test]
    async fn a_ping_notification_on_the_channel_comes_back_as_an_event() {
        let served = Served::start().await;
        let (mut lines, mut w) = open_channel(&served).await;
        send(&mut w, r#"{"jsonrpc":"2.0","method":"daemon.ping","params":{"nonce":"n1"}}"#).await;
        let ev = recv(&mut lines).await;
        assert_eq!(ev["params"]["name"], "daemon-ping");
        assert_eq!(ev["params"]["payload"], json!({"nonce": "n1"}));
        served.stop();
    }

    #[tokio::test]
    async fn an_unknown_notification_is_ignored_and_the_channel_stays_open() {
        let served = Served::start().await;
        let (mut lines, mut w) = open_channel(&served).await;
        send(&mut w, r#"{"jsonrpc":"2.0","method":"nope.nope","params":{}}"#).await;
        send(&mut w, "not json").await;
        send(&mut w, r#"{"jsonrpc":"2.0","method":"daemon.ping","params":{"nonce":"after"}}"#).await;
        let ev = recv(&mut lines).await;
        assert_eq!(ev["params"]["payload"]["nonce"], "after", "nothing was answered to the bad lines");
        served.stop();
    }

    /// Final review Important 1 / deferred #26: `run` used to share one task
    /// and one `select!` between reading incoming notifications and writing
    /// bus events out. A write that blocks — the client isn't reading, and a
    /// macOS/Linux AF_UNIX socket's default buffer is only ~8 KB each way —
    /// used to stop that same task from ever getting back to
    /// `lines.next_line()`, so a client that goes quiet after `channel.open`
    /// (exactly what a wedged app-side channel looks like, Phase 1's nudge
    /// volume makes this reachable) could never have another notification
    /// dispatched, forever. The fix spawns the bus→socket forwarder as its
    /// own task so `run`'s read+dispatch loop never shares a stalled write.
    ///
    /// This test never reads `lines` again after `channel.open`, and floods
    /// the bus with far more than 8 KB from a second connection's-independent
    /// producer, so the forwarder's write blocks solidly for the rest of the
    /// test. It then sends one notification and proves — via a THIRD,
    /// separate bus subscriber, so the proof doesn't depend on the write ever
    /// reaching the non-reading client — that `dispatch` still ran. Bounded
    /// by a timeout so a regression fails, not hangs, the test suite.
    #[tokio::test]
    async fn dispatch_keeps_progressing_while_the_client_never_reads_a_flooded_bus() {
        let served = Served::start().await;
        let (_lines, mut w) = open_channel(&served).await;
        // `_lines` is deliberately never read again below.

        let mut proof_rx = served.state.events.subscribe();

        let bus = served.state.events.clone();
        let flood = tokio::spawn(async move {
            let payload = "x".repeat(64 * 1024);
            for i in 0..80 {
                bus.emit("flood", json!({ "i": i, "pad": payload.clone() }));
            }
        });
        // emit() is a synchronous, non-blocking broadcast send — joining here
        // just guarantees all 80 events are already queued for this
        // connection's forwarder before the notification below is sent.
        flood.await.expect("flood task panicked");

        send(&mut w, r#"{"jsonrpc":"2.0","method":"daemon.ping","params":{"nonce":"through-the-flood"}}"#).await;

        let dispatched = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                match proof_rx.recv().await {
                    Ok(line) if line.contains("through-the-flood") => return true,
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
                }
            }
        })
        .await
        .expect("dispatch must not hang while the client is not reading (deadlock regression)");
        assert!(dispatched, "the daemon.ping notification sent after the flood was never dispatched");

        served.stop();
    }

    #[tokio::test]
    async fn a_request_connection_never_receives_events() {
        let served = Served::start().await;
        let (mut lines, mut w) = served.connect().await;
        send(&mut w, &format!(r#"{{"token":"{}"}}"#, served.state.token)).await;
        recv(&mut lines).await;
        served.state.events.emit("x", json!({}));
        send(&mut w, r#"{"jsonrpc":"2.0","method":"ping","id":9}"#).await;
        let resp = recv(&mut lines).await;
        assert_eq!(resp["id"], json!(9));
        assert_eq!(resp["result"], json!({"pong": true}));
        served.stop();
    }
}
