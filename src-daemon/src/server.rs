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
#[cfg(unix)]
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
    /// What was already purged or announced (`recent_actions`).
    pub recent: crate::recent_actions::RecentActions,
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
    pub(crate) sync_observation: crate::sync_observation::ObservationState,
    pub(crate) refresh: crate::refresh_worker::RefreshState,
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
    /// The Blitz render worker's supervisor (`render.*`); the worker process is spawned lazily.
    #[cfg(feature = "blitz-render")]
    pub blitz: Arc<crate::blitz::RenderPool>,
    pub search_index: Arc<crate::search_index::SearchIndexState>,
    /// What the vault holds, answered from `<app_dir>/vault_registry.db`
    /// (architecture.md "Reads come from the database"). Every vault writer
    /// updates or invalidates it before replying; built by
    /// `open_vault_registry`, which also feeds its changes to the index.
    pub vault_registry: Arc<mailvault_core::vault_registry::VaultRegistry>,
    /// Named local/server search runs. The handler removes entries by pointer
    /// identity so an older completion cannot unregister a newer run.
    pub(crate) search_runs: std::sync::Mutex<
        std::collections::HashMap<String, Arc<crate::handlers::mail_search::SearchRun>>,
    >,
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
    /// One user bulk owner; pending state stays in the existing app.db meta.
    pub(crate) bulk: std::sync::Mutex<mailvault_core::bulk::Coordinator>,
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
    /// Atomic account admission shared by legacy backup, the native worker
    /// and gap-save. Arc-matching guards remove only their own token after
    /// known drain; the adapter retains the real guard if drain is uncertain.
    /// Legacy account cancellation skips tokens owned by the native worker.
    pub backup_runs: std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    /// Task 3.6: in-daemon insights snapshots, moved whole from
    /// `src-tauri/src/insights.rs`. The app's own copy and its three Tauri
    /// commands still exist and still work until Task 3.7 cuts the frontend
    /// over and deletes them: this is a second, parallel copy of the state,
    /// not a replacement yet. Its 30s expiry sweeper is spawned once from
    /// `daemon_main` (`insights::InsightsSnapshots::start_cleanup`), not
    /// per-state.
    pub insights: crate::insights::InsightsSnapshots,
    /// Scheduled Send's wake signal — `handlers::scheduled`'s RPCs notify it
    /// on anything that changes what `scheduled_send_worker` should do next
    /// (create/reschedule/cancel), same shape `classification`'s `notify`
    /// wakes its own worker.
    pub scheduled_send: crate::scheduled_send_worker::ScheduledSendState,
    /// The OAuth2 access tokens this daemon refreshed and holds
    /// (`oauth_tokens`): every RPC and worker that needs one asks there.
    pub tokens: crate::oauth_tokens::TokenStore,
    pub(crate) account_admission: crate::account_workflows::AccountAdmission,
    pub(crate) account_lifecycle: crate::account_lifecycle::AccountLifecycle,
    pub(crate) zip_intents: crate::backup_zip::ZipIntents,
    /// Snooze's wake signal and pass lock — `handlers::snooze` pokes it on
    /// create/reschedule and holds the lock for an immediate unsnooze.
    pub snooze: crate::snooze_worker::SnoozeState,
    /// Follow-up reminders' wake signal — `handlers::follow_up` pokes it on
    /// create, a scheduled send on a reminder it recorded.
    pub follow_up: crate::follow_up_worker::FollowUpState,
    /// Auto Tags' wake signal — woken by the same "new mail arrived" points
    /// that already feed the classification path (`handle_sync_now`,
    /// `idle_watch`), shared with `idle` via `IdleWatchers::set_auto_tag_notify`
    /// so an IDLE wake-up sweeps auto-tag rules too.
    pub auto_tag_worker: crate::auto_tag_worker::AutoTagWorkerState,
    /// The download-mode eviction worker's wake signal:
    /// `storage.fetch_mode_changed` pokes it (Track H).
    pub eviction_worker: crate::eviction_worker::EvictionWorkerState,
    /// The Hoarder worker's wake signal and daily download budget (Track H4):
    /// `storage.fetch_mode_changed` and a sync that found new mail poke it.
    pub hoarder_worker: crate::hoarder_worker::HoarderWorkerState,
    /// The UTC clock every daily-download-limit check reads
    /// (`mailvault_core::transfer_limits`): the wall clock in production; a
    /// test moves it across midnight to see a stopped job carry on.
    pub clock: mailvault_core::transfer_limits::Clock,
    /// Server fallback for a message the vault has no copy of, and the
    /// in-memory copies On Demand keeps (`raw_message`, Track H3c).
    pub(crate) raw_messages: crate::raw_message::RawMessages,
    /// Folders whose old-import pass (`handlers::custody::rehome_imports_soon`)
    /// is running, so a folder opened twice runs it once.
    pub(crate) import_rehome_running: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
    /// The mbox-to-server upload job of each account (`mbox_upload_job`):
    /// running, or held in place until a resume.
    pub(crate) mbox_uploads: crate::mbox_upload_job::Uploads,
    /// The vault's storage format conversion (`format_migration_job`): the
    /// live job, running or held in place until a resume.
    pub(crate) format_migration: crate::format_migration_job::Migrations,
    /// Network Activity's kept events in `app.db`: the listener in main.rs
    /// feeds its writer, `handlers::net_activity` reads it.
    pub net_log: Arc<mailvault_core::net_log::NetLog>,
    /// Archive & delete jobs: the job registry, the dry-run listings, the
    /// access tokens the app pushed (memory only) and the attached backup
    /// folders. The work runs on the `abd-worker` thread
    /// (`abd_worker::start`), never on this runtime.
    pub abd: crate::abd_worker::AbdState,
    /// Auto-cleanup runs: the one-run slot and the `cleanup-worker` channel.
    pub(crate) cleanup: crate::cleanup_worker::CleanupState,
    pub(crate) backup_worker: crate::backup_worker::BackupState,
    /// Connected JMAP accounts (`jmap_sessions`), shared by the JMAP bridge
    /// (`handlers::jmap_bridge`) and the JMAP sync.
    pub(crate) jmap: crate::jmap_sessions::JmapSessions,
}

/// Opens the vault registry for the vault at `root` and points its change
/// hook at the search index: a mailbox change nudges that folder, a global
/// one sweeps. The one wiring both `daemon_main` and `for_test` use.
///
/// Synchronous and local (a SQLite file in `app_dir`, never on the vault's
/// drive), so it runs before the socket is bound without awaiting anything.
/// A root change respawns the daemon, and a registry opened for another root
/// drops its rows.
pub fn open_vault_registry(
    app_dir: &Path,
    root: &Path,
    search_index: &Arc<crate::search_index::SearchIndexState>,
) -> Arc<mailvault_core::vault_registry::VaultRegistry> {
    use mailvault_core::vault_registry::{Scope, VaultRegistry};
    let started = std::time::Instant::now();
    let registry = Arc::new(VaultRegistry::open(app_dir, root));
    let index = Arc::clone(search_index);
    registry.set_on_change(Box::new(move |scope| match scope {
        // `nudge` maps its mailbox through `vault_dir_name`, which is
        // idempotent, so the directory name goes in as is.
        Scope::Mailbox { account, vault_dir } => crate::search_index::nudge(&index, &account, &vault_dir),
        Scope::All => crate::search_index::sweep_soon(&index),
    }));
    info!("vault registry: opened in {:?}", started.elapsed());
    registry
}

/// Start the daemon socket server.
#[cfg(unix)]
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

/// Windows has no bind-once listener: a named pipe is a server *instance* that
/// serves exactly one client, so the next instance is created the moment the
/// current one is handed off.
///
/// `first_pipe_instance(true)` on the first instance is also the daemon
/// singleton — a second daemon fails here instead of needing the flock the unix
/// build takes in `main.rs`. And there is no stale endpoint to clean up: a pipe
/// leaves no filesystem residue when its owner dies.
#[cfg(windows)]
pub async fn run(state: Arc<DaemonState>, endpoint: &Path) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    // Retries until it succeeds: the caller must never be left without a
    // waiting instance (see the call sites below), and a transient failure
    // here must not end the listener the way a bare `?` would.
    async fn create_next_instance(name: &str) -> NamedPipeServer {
        // Finding 5 (final fix wave): the retry itself is unbounded on
        // purpose (the caller must never be left without a waiting instance),
        // but a permanently uncreatable pipe name would otherwise log at
        // `error!` every 50ms forever. Log the first failure only.
        let mut logged = false;
        loop {
            match ServerOptions::new().create(name) {
                Ok(next) => return next,
                Err(e) => {
                    if !logged {
                        error!("Failed to create the next pipe instance: {e}");
                        logged = true;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    let name = endpoint.to_string_lossy().to_string();

    let mut server = ServerOptions::new().first_pipe_instance(true).create(&name)?;
    info!("Daemon listening on {}", name);

    loop {
        if let Err(e) = server.connect().await {
            // The unix arm logs an accept error and keeps accepting; a bare
            // `?` here would instead kill the whole daemon over one client
            // that opened the pipe and dropped before ConnectNamedPipe
            // completed (an aborted liveness probe, a cancelled connect
            // racing a spawn). The failed instance itself is discarded
            // rather than retried: what `ConnectNamedPipe` leaves it in is
            // undocumented, so reusing it would be guessing. Recreating one
            // just reopens the same instance-less window `create()` below
            // already lives with — no new hazard class, just hit more often.
            error!("Failed to accept a pipe connection: {e}");
            server = create_next_instance(&name).await;
            continue;
        }
        let connected = server;
        // Create the replacement BEFORE spawning the handler, and never leave
        // the loop without one: between `connect()` returning and `create()`
        // succeeding there is no instance waiting on the name, and a probe that
        // lands in that window reads the daemon as down.
        server = create_next_instance(&name).await;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = handle_connection(state, connected).await {
                warn!("Connection handler error: {}", e);
            }
        });
    }
}

/// Run the socket server on its OWN OS thread, with its OWN tokio runtime.
///
/// Nothing else lives on that runtime: the sync engine, the IDLE watchers, the
/// classification worker and the timers all stay on the runtime `daemon_main`
/// built, so no amount of work over there can delay an accept or an RPC reply.
/// (2026-09-20: a startup import awaited before the socket was bound left the
/// app with no mail and a "Helper Not Running" card for seven minutes. The
/// import moved to its own thread; this makes the socket structurally immune
/// to the next thing that forgets.)
///
/// Default worker width, not a narrow pool: handlers spawn their long jobs
/// (restore, migration, backup, reclassify, `mail_search`) onto this runtime
/// too. `enable_all` is not optional — without the IO driver a `UnixListener`
/// cannot be driven at all.
///
/// `on_failure` runs on that thread if the runtime or the server dies; the
/// caller decides what a dead socket means (the daemon exits).
pub fn spawn_on_own_thread(
    state: Arc<DaemonState>,
    socket_path: PathBuf,
    on_failure: impl FnOnce(String) + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name("ipc-server".into()).spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => return on_failure(format!("server runtime failed to start: {e}")),
        };
        if let Err(e) = runtime.block_on(run(state, &socket_path)) {
            on_failure(format!("server failed: {e}"));
        }
    })
}

/// Handle a single client connection: authenticate, then process requests.
async fn handle_connection<S>(
    state: Arc<DaemonState>,
    stream: S,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
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
                let _backup_owner =
                    crate::backup_worker::channel_owner(&state, req.params["backupOwner"].as_str());
                let _backup_surface_owner = crate::backup_worker::surface_channel_owner(&state, req.params["backupSurfaceGeneration"].as_str());
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

/// Route a parsed RPC request, every connection it makes shown on Network
/// Activity as the account it names (`accountEmail`): Graph, a token refresh,
/// an unsubscribe, a sender logo, an export's remote content.
///
/// Every OAuth2 token a request carries is first replaced by the daemon's own
/// (`oauth_tokens::inject`), so no handler ever sends the app's copy.
async fn handle_request(state: &Arc<DaemonState>, mut req: RpcRequest) -> RpcResponse {
    let method = req.method.clone();
    // These strict contracts must reject account-bearing unknown fields
    // without ever resolving credentials. route_request retains foreground accounting.
    if matches!(
        method.as_str(),
        "sync.probe"
            | "sync.refresh"
            | "sync.refresh_status"
            | "folders.status"
            | "compose.reply_context"
            | "compose.check"
            | "backup.schedule.get"
            | "backup.schedule.set"
            | "backup.run_now"
            | "backup.cancel"
            | "backup.stop"
            | "backup.schedule.status"
            | "backup.attach_access"
            | "backup.access_status"
            | "backup.context"
            | "backup.surface_retire"
    ) {
        return route_request(state, req).await;
    }
    let crate::oauth_tokens::Injection { injected, refusal } =
        crate::oauth_tokens::inject(state, &method, &mut req.params).await;
    if let Some(message) = refusal {
        return RpcResponse::error(req.id.unwrap_or(Value::Null), ipc::INTERNAL_ERROR, message);
    }
    let resp = match req
        .params
        .get("accountEmail")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
        .map(str::to_owned)
    {
        Some(email) => {
            mailvault_core::net_activity::with_account(email, route_request(state, req)).await
        }
        None => route_request(state, req).await,
    };
    if let Some(line) = jmap_refusal_log_line(&method, &resp) {
        warn!("{line}");
    }
    match resp.error.as_ref() {
        Some(error) => crate::oauth_tokens::note_refusal(state, &injected, &error.message),
        None => crate::oauth_tokens::note_accepted(state, &injected),
    }
    resp
}

/// The log line for an RPC the pool refused because it reached an IMAP
/// session-opening entry with a JMAP account (`E_JMAP_NOT_IMAP`), or `None`
/// for any other response. A foreground path that forgot to branch on
/// `uses_jmap()` otherwise shows the user an error with no trace in the log;
/// the e2e battery greps `daemon.log` for this code and expects none.
fn jmap_refusal_log_line(method: &str, resp: &RpcResponse) -> Option<String> {
    let message = &resp.error.as_ref()?.message;
    message.starts_with("E_JMAP_NOT_IMAP").then(|| format!("[jmap] {method}: {message}"))
}

/// Route a parsed RPC request to the appropriate handler.
async fn route_request(state: &Arc<DaemonState>, req: RpcRequest) -> RpcResponse {
    let id = req.id.unwrap_or(Value::Null);

    if crate::search_index::is_foreground_method(&req.method) {
        crate::search_index::note_foreground(&state.search_index);
    }

    // The user moved the mail off the app data dir and that folder is not
    // reachable. Anything that touches mail must fail loudly — writing into the
    // app data dir instead would silently start a second, divergent archive.
    if !state.mail_dir_ok
        && ((req.method.starts_with("sync.") && req.method != "sync.refresh_status")
            || req.method.starts_with("snapshot.")
            || req.method.starts_with("contacts_index.")
            || req.method.starts_with("people."))
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

    if let Some(resp) = crate::handlers::mail_search::route(state, &req.method, &req.params, id.clone()).await {
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

    if let Some(resp) = crate::backup_worker::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::backup_schedule::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::backup::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::abd::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::insights::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::export_fetch::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::unsubscribe::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) = crate::handlers::deleted::route(state, &req.method, &req.params, id.clone()).await {
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

    if let Some(resp) = crate::handlers::bulk::route(state, &req.method, &req.params, id.clone()).await {
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
    if let Some(resp) = crate::handlers::drafts::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::compose_prep::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::compose::route(state, &req.method, &req.params, id.clone()).await {
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
    if let Some(resp) = crate::handlers::tags::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::auto_tags::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::views::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::notes::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::portable::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::transfer::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::fields::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::scheduled::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::snooze::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::follow_up::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::pgp::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::ai::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::release_notes::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::fonts::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    #[cfg(feature = "blitz-render")]
    if let Some(resp) = crate::blitz::routes::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::net_activity::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::aliases::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::alias_store::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::people::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::storage_format::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::learning::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::custody_probe::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::message::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::accounts::route(state, &req.method, &req.params, id.clone()).await { return resp; }
    if let Some(resp) = crate::handlers::settings::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::policy::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::notify::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::lifecycle::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::body::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }
    if let Some(resp) = crate::handlers::cleanup::route(state, &req.method, &req.params, id.clone()).await {
        return resp;
    }

    if let Some(resp) =
        crate::handlers::credentials::route(state, &req.method, &req.params, id.clone()).await
    {
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

        // ── Network Activity ────────────────────────────────────────
        // The reads and the retention setting are `handlers::net_activity`.
        // `net.report` records one the app shell made itself (it normally
        // comes as a channel notification instead).
        "net.report" => match mailvault_core::net_activity::record_reported(req.params["event"].clone()) {
            Ok(()) => RpcResponse::success(id, serde_json::json!({"ok": true})),
            Err(e) => RpcResponse::error(id, ipc::INVALID_PARAMS, e),
        },

        // ── Keychain gate ───────────────────────────────────────────
        "keychain.status" => RpcResponse::success(id, crate::credentials::GATE.status()),
        "keychain.retry" => {
            let result = crate::credentials::retry().await;
            // Rows the gate held back are still due: send them now rather
            // than at the worker's next look.
            if result["ok"] == true {
                state.scheduled_send.wake();
                state.snooze.wake();
                state.follow_up.wake();
            }
            RpcResponse::success(id, result)
        }

        // ── Download modes (Track H) ────────────────────────────────
        // The app saved a new download mode or window: the eviction worker
        // re-derives what it may delete now instead of at its daily pass, and
        // the Hoarder worker starts (or stops) downloading.
        "storage.fetch_mode_changed" => {
            state.eviction_worker.wake();
            state.hoarder_worker.wake();
            RpcResponse::success(id, serde_json::json!({"ok": true}))
        }

        // ── Sync engine (Phase 3) ───────────────────────────────────
        "sync.now" => handle_sync_now(Arc::clone(state), req.params, id).await,
        "sync.wait" => handle_sync_wait(Arc::clone(&state.sync_engine), req.params, id).await,
        "sync.status" => handle_sync_status(&state.sync_engine, req.params, id).await,
        "sync.probe" | "folders.status" => crate::handlers::sync_observation::route(state, &req.method, req.params, id).await,
        "sync.refresh" | "sync.refresh_status" => crate::handlers::refresh::route(state, &req.method, req.params, id).await,

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


        "contacts_index.get" => handle_contacts_index_get(Arc::clone(&state.contacts), req.params, id),

        _ => RpcResponse::error(id, ipc::METHOD_NOT_FOUND, format!("Unknown method: {}", req.method)),
    }
}

#[cfg(test)]
pub(crate) async fn handle_request_for_test(state: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
    // Synthetic fixtures commonly write their authoritative document after
    // constructing DaemonState. Seed once from that real fixture document.
    if !state.account_lifecycle.is_ready() {
        if let Ok(listing) =
            mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir))
        {
            state.account_lifecycle.seed(&listing);
        }
    }
    handle_request(state, RpcRequest { method: method.into(), params, id: Some(serde_json::json!(1)) }).await
}

/// The open-file cap the test process lifts its soft limit to, or the hard
/// limit if that is lower.
#[cfg(all(test, unix))]
const TEST_OPEN_FILES: libc::rlim_t = 10_240;

/// Every daemon test shares one process. Ten threads of states, mock servers
/// and temp files peaked near macOS's default soft limit of 256 open files,
/// and whichever test opened the one too many failed with "Too many open
/// files" (the mini, 2026-10-07). Lifted once, as `ulimit -n` would; Linux
/// starts far above it.
#[cfg(test)]
fn lift_open_file_limit() {
    #[cfg(unix)]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            // SAFETY: getrlimit/setrlimit only read and write the struct passed.
            unsafe {
                if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 && lim.rlim_cur < lim.rlim_max.min(TEST_OPEN_FILES) {
                    lim.rlim_cur = lim.rlim_max.min(TEST_OPEN_FILES);
                    libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
                }
            }
        });
    }
}

#[cfg(test)]
impl DaemonState {
    /// Explicitly prepare an authoritative account fixture before any route
    /// can bootstrap this state's lifecycle. `for_test` itself stays Unready.
    pub(crate) fn seed_accounts_for_test(&self, ids: &[&str]) {
        assert!(!self.account_lifecycle.is_ready(), "seed before the first route");
        let rows = Value::Array(ids.iter().map(|id| serde_json::json!({"id": id})).collect());
        std::fs::write(self.app_dir.join("accounts.json"), rows.to_string()).unwrap();
        self.account_lifecycle.seed(
            &mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&self.app_dir)).unwrap(),
        );
    }

    /// A state wired the way main.rs wires it, but pointed at scratch dirs.
    pub(crate) fn for_test(
        mail_dir: PathBuf,
        app_dir: PathBuf,
        mail_dir_ok: bool,
    ) -> Arc<DaemonState> {
        // A gate whose probe always answers "online": these tests are about
        // routing and state, never about connectivity.
        Self::for_test_with_probe(
            mail_dir,
            app_dir,
            mail_dir_ok,
            Arc::new(|| Box::pin(async { true })),
        )
    }

    /// `for_test` with the network gate's probe scripted by the caller, for
    /// a test about what a send does when the probe says the network is down.
    pub(crate) fn for_test_with_probe(
        mail_dir: PathBuf,
        app_dir: PathBuf,
        mail_dir_ok: bool,
        probe: crate::netgate::Probe,
    ) -> Arc<DaemonState> {
        lift_open_file_limit();
        let app_dir_for_index = app_dir.clone();
        let imap_pool = Arc::new(imap::ImapPool::new());
        let account_lifecycle = crate::account_lifecycle::AccountLifecycle::default();
        let contacts = contacts_index::ContactsState::new(mail_dir.clone(), account_lifecycle.clone());
        let net = NetGate::with_probe(probe);
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
            account_lifecycle.clone(),
        ));
        let idle = idle_watch::IdleWatchers::new(
            Arc::clone(&sync_engine),
            Arc::clone(&imap_pool),
            Arc::clone(&net),
            std::time::Duration::from_millis(50),
        );
        let auto_tag_worker = crate::auto_tag_worker::AutoTagWorkerState::default();
        idle.set_auto_tag_notify(Arc::clone(&auto_tag_worker.notify));
        let events = crate::events::EventBus::new(crate::events::CAPACITY);
        let custody = crate::custody::CustodyState::default();
        // Production opens custody at startup, before the socket is bound, and
        // the header cache lives in it — a state with it closed cannot cache a
        // sync or report one. `open_into` drops whatever is installed before
        // it opens, so a test that calls it later still gets a clean open.
        if mail_dir_ok {
            if let Ok(conn) = mailvault_core::custody::db::open(&mail_dir) {
                *mailvault_core::custody::lock(&custody.db) = Some(conn);
                *custody.root.lock().unwrap_or_else(|p| p.into_inner()) = Some(mail_dir.clone());
            }
        }
        sync_engine.attach_custody_db(Arc::clone(&custody.db));
        contacts.attach_db(Arc::clone(&custody.db));
        let search_index = crate::search_index::SearchIndexState::new(
            mail_dir.clone(),
            app_dir_for_index.clone(),
            mail_dir_ok,
            events.clone(),
        );
        search_index.attach_custody_db(Arc::clone(&custody.db));
        // A registry file of its own per state: many tests pass the vault dir
        // (or one shared dir) as `app_dir`, and one file under two roots wipes.
        let registry_dir = tempfile::tempdir().expect("registry tempdir").keep();
        let vault_registry = open_vault_registry(&registry_dir, &mail_dir, &search_index);
        // The worker process is spawned on the first call, so no reaper runs in tests.
        #[cfg(feature = "blitz-render")]
        let blitz = Arc::new(crate::blitz::RenderPool::new(|| {
            crate::blitz::RenderHost::new(
                events.clone(),
                crate::blitz::WorkerCommand::current_exe().expect("current_exe"),
            )
        }));
        let state = Arc::new(DaemonState {
            recent: Default::default(),
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
            sync_observation: Default::default(),
            refresh: Default::default(),
            contacts,
            shutdown: Arc::new(tokio::sync::Notify::new()),
            search_index,
            vault_registry,
            search_runs: std::sync::Mutex::new(std::collections::HashMap::new()),
            events,
            #[cfg(feature = "blitz-render")]
            blitz,
            prefetch_lock: std::sync::Mutex::new(()),
            prefetch_high_water: std::sync::Mutex::new(Vec::new()),
            journal: std::sync::Mutex::new(()),
            bulk: std::sync::Mutex::new(mailvault_core::bulk::Coordinator::load(
                &app_dir_for_index,
            )),
            custody,
            run_tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
            backup_runs: std::sync::Mutex::new(std::collections::HashMap::new()),
            insights: crate::insights::InsightsSnapshots::default(),
            scheduled_send: crate::scheduled_send_worker::ScheduledSendState::default(),
            tokens: crate::oauth_tokens::TokenStore::default(),
            account_admission: Default::default(),
            account_lifecycle,
            zip_intents: Default::default(),
            snooze: crate::snooze_worker::SnoozeState::default(),
            follow_up: crate::follow_up_worker::FollowUpState::default(),
            auto_tag_worker,
            eviction_worker: crate::eviction_worker::EvictionWorkerState::default(),
            hoarder_worker: crate::hoarder_worker::HoarderWorkerState::default(),
            clock: mailvault_core::transfer_limits::Clock::system(),
            raw_messages: Default::default(),
            import_rehome_running: Default::default(),
            mbox_uploads: Default::default(),
            format_migration: Default::default(),
            net_log: Arc::new(mailvault_core::net_log::NetLog::start(&app_dir_for_index)),
            abd: Default::default(),
            cleanup: Default::default(),
            backup_worker: Default::default(),
            jmap: Default::default(),
        });
        state.idle.set_daemon(&state);
        state.sync_engine.set_daemon(&state);
        crate::refresh_worker::start(&state);
        state
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn accounts_native_list_returns_legacy_array_without_rewriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        let bytes = b"[ { \"id\": \"legacy\", \"password\": \"synthetic-only\" } ]";
        std::fs::write(&path, bytes).unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        let reply = handle_request_for_test(&state, "accounts.list", serde_json::json!({})).await;
        assert!(
            reply.error.is_none(),
            "native list refused: {:?}",
            reply.error
        );
        let result = reply.result.unwrap();
        assert_eq!(
            result["accounts"],
            serde_json::json!([{"id":"legacy", "password":"synthetic-only"}])
        );
        assert!(result["version"].as_u64().is_some());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn stage1_credentials_save_preserves_other_records() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(v) => std::env::set_var("MAILVAULT_TEST_CREDENTIALS", v),
                    None => std::env::remove_var("MAILVAULT_TEST_CREDENTIALS"),
                }
            }
        }
        let _restore = Restore(std::env::var_os("MAILVAULT_TEST_CREDENTIALS"));
        let unrelated = "{ \"id\": \"b\", \"password\": \"synthetic-other\" }";
        std::fs::write(
            &path,
            json!({"a":"{\"id\":\"a\",\"password\":\"synthetic-old\"}", "b":unrelated}).to_string(),
        )
        .unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);
        let state = DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["a", "b"]);
        let response = handle_request(
            &state,
            req(
                "credentials.save",
                json!({"records":{"a":"{\"id\":\"a\",\"password\":\"synthetic-new\"}"}}),
            ),
        )
        .await;
        assert!(
            response.error.is_none(),
            "credential dispatch failed: {:?}",
            response.error
        );
        let result = response.result.unwrap();
        assert_eq!(result["saved"], json!(["a"]));
        assert!(result["version"].is_u64());
        assert_eq!(
            result.as_object().unwrap().len(),
            2,
            "mutation replies carry IDs/version only"
        );
        let blob: std::collections::HashMap<String, String> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(blob["b"], unrelated);
        assert!(blob["a"].contains("synthetic-new"));
    }

    /// The two halves of a client connection to the real socket server,
    /// scripted against the endpoint `mailvault_core::transport` also gives
    /// production: a unix socket on unix, a named pipe on Windows. Both
    /// underlying stream types implement `AsyncRead`/`AsyncWrite`, so
    /// `tokio::io::split` (the same call production's `rpc_attempt_inner`
    /// and `daemon_channel::connect` use) produces the same shape either way.
    #[cfg(unix)]
    type ConnRead = tokio::io::ReadHalf<tokio::net::UnixStream>;
    #[cfg(unix)]
    type ConnWrite = tokio::io::WriteHalf<tokio::net::UnixStream>;
    #[cfg(windows)]
    type ConnRead = tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>;
    #[cfg(windows)]
    type ConnWrite = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

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

    #[test]
    fn a_jmap_pool_refusal_has_a_log_line_and_nothing_else_does() {
        let refused = RpcResponse::error(
            json!(1),
            ipc::INTERNAL_ERROR,
            "E_JMAP_NOT_IMAP: a@x.test is a JMAP account; this path must branch on uses_jmap()",
        );
        assert_eq!(
            jmap_refusal_log_line("imap_list_folders", &refused).as_deref(),
            Some("[jmap] imap_list_folders: E_JMAP_NOT_IMAP: a@x.test is a JMAP account; this path must branch on uses_jmap()")
        );
        let other = RpcResponse::error(json!(1), ipc::INTERNAL_ERROR, "E_JMAP_UNSUPPORTED: nope");
        assert_eq!(jmap_refusal_log_line("imap_list_folders", &other), None);
        let ok = RpcResponse::success(json!(1), json!({}));
        assert_eq!(jmap_refusal_log_line("imap_list_folders", &ok), None);
    }

    #[tokio::test]
    async fn bulk_status_preserves_pending_without_replaying() {
        let dir = tempfile::tempdir().unwrap();
        let pending = json!({"id":"old", "type":"delete", "accountId":"a", "mailbox":"INBOX", "totalUids":["a:Sent:7", "a:INBOX:8"], "completedUids":["a:Sent:7"], "status":"deleting", "currentPhase":"delete"});
        mailvault_core::op_journal::pending_operation_save(dir.path(), &pending).unwrap();
        let state = DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), false);
        let status = handle_request_for_test(&state, "bulk.status", json!({})).await;
        assert!(status.error.is_none(), "bulk.status must expose awaiting-resume ownership: {:?}", status.error);
        let status = status.result.unwrap();
        assert_eq!(status["active"], Value::Null);
        assert_eq!(status["pending"]["id"], "old");
        assert_eq!(status["pending"]["status"], "awaitingResume");
        assert_eq!(status["pending"]["remaining"], 1);
        assert_eq!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap(), Some(pending));
    }

    #[tokio::test]
    async fn bulk_discard_refuses_stale_and_corrupt_records() {
        let dir = tempfile::tempdir().unwrap();
        let raw = json!({"id":"current", "type":"archive", "accountId":"a", "mailbox":"Sent", "totalUids":[7], "completedUids":[], "status":"archiving", "currentPhase":"archive"});
        mailvault_core::op_journal::pending_operation_save(dir.path(), &raw).unwrap();
        let state = DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), false);
        let stale = handle_request_for_test(&state, "bulk.discard", json!({"operationId":"old"})).await;
        assert!(stale.error.is_some());
        assert_eq!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap(), Some(raw));
        let discarded = handle_request_for_test(&state, "bulk.discard", json!({"operationId":"current"})).await;
        assert!(discarded.error.is_none(), "{:?}", discarded.error);
        assert_eq!(discarded.result, Some(Value::Null));
        mailvault_core::app_db::with(dir.path(), |conn| mailvault_core::app_db::db::meta_set(conn, mailvault_core::app_db::ops::PENDING_OPERATION_KEY, "{ invalid")).unwrap();
        for method in ["bulk.status", "bulk.discard"] {
            let response = handle_request_for_test(&state, method, json!({"operationId":"current"})).await;
            assert!(response.error.is_some(), "{method} must retain unreadable evidence");
        }
        assert!(mailvault_core::op_journal::pending_operation_read(dir.path()).is_err());
        // Implemented kickoffs must retain corrupt pending evidence too.
        for method in ["bulk.start","bulk.resume"] {
            let response=handle_request_for_test(&state,method,json!({"operationId":"current","type":"archive","scope":{"keys":[]}})).await;
            assert_eq!(response.error.unwrap().message,"errors.bulkPendingRead");
        }
    }

    #[tokio::test]
    async fn bulk_legacy_writes_cannot_replace_owned_or_future_records() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), false);
        // A future version must remain readable to its eventual owner.
        for record in [json!({"schemaVersion":99,"id":"future"}), json!({"schemaVersion":1,"id":"broken"})] {
            mailvault_core::op_journal::pending_operation_save(dir.path(), &record).unwrap();
            for (method, params) in [("save_pending_operation", json!({"operation":{"id":"legacy"}})), ("clear_pending_operation", json!({}))] {
                let response = handle_request_for_test(&state, method, params).await;
                assert!(response.error.is_some(), "{method} must retain existing evidence");
                assert_eq!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap(), Some(record.clone()));
            }
        }
        mailvault_core::op_journal::pending_operation_clear(dir.path()).unwrap();
        {
            let _journal = state.journal.lock().unwrap();
            let scope = serde_json::from_value(json!({"accountId":"a", "mailbox":"INBOX", "keys":[7]})).unwrap();
            let frozen = mailvault_core::bulk::FrozenIntent::freeze(mailvault_core::bulk::Action::Archive, scope, &["a".into()], &[]);
            state.bulk.lock().unwrap().claim(dir.path(), "owned", frozen).unwrap();
        }
        for (method, params) in [("save_pending_operation", json!({"operation":{"id":"legacy"}})), ("clear_pending_operation", json!({}))] {
            assert!(handle_request_for_test(&state, method, params).await.error.is_some());
        }
        assert_eq!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().unwrap()["id"], "owned");
    }

    #[tokio::test]
    async fn bulk_worker_start_finishes_empty_frozen_selection() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["a"]);
        let reply = handle_request_for_test(&state, "bulk.start", json!({"operationId":"empty-worker","type":"archive","scope":{"accountId":"a","mailbox":"INBOX","keys":[]}})).await;
        assert!(
            reply.error.is_none(),
            "bulk.start must launch the real worker: {:?}",
            reply.error
        );
        for _ in 0..100 {
            let status = handle_request_for_test(&state, "bulk.status", json!({}))
                .await
                .result
                .unwrap();
            if status["active"].is_null() {
                assert!(
                    status["pending"].is_null(),
                    "empty worker must reach terminal drain: {status}"
                );
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("empty worker never drained");
    }

    #[test]
    fn bulk_worker_kickoff_future_stays_small() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let params = json!({"operationId":"future","type":"archive","scope":{"keys":[]}});
        let future = crate::handlers::bulk::route(&state, "bulk.start", &params, json!(1));
        assert!(
            std::mem::size_of_val(&future) < 4096,
            "bulk RPC must never own the large mail future"
        );
    }

    #[tokio::test]
    async fn bulk_admission_fence_prevents_a_later_dispatched_request() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let status = handle_request_for_test(
            &state,
            "bulk.status",
            json!({"operationId":"late","attemptId":"late-attempt","fenceUnstarted":true}),
        )
        .await
        .result
        .unwrap();
        assert_eq!(status["admission"]["state"], "fenced");
        let late=handle_request_for_test(&state,"bulk.start",json!({"operationId":"late","attemptId":"late-attempt","type":"archive","scope":{"keys":[]}})).await;
        assert!(late.error.is_some());
        assert!(
            mailvault_core::op_journal::pending_operation_read(dir.path())
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_large_checkpoint_reports_foreground_control_latency() {
        use mailvault_core::bulk::{Action, FrozenIntent, Scope};
        use mailvault_core::bulk_worker::{Identity, Selected, Workflow};
        use std::time::Instant;
        for action in [Action::Delete, Action::ArchiveBackupDelete] {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let intent = FrozenIntent::freeze(
            action,
            Scope {
                account_id: Some("a".into()),
                mailbox: Some("INBOX".into()),
                spans: false,
                keys: (1..=20000).map(|uid| json!(uid)).collect(),
                target_hints: Vec::new(),
            },
            &["a".into()],
            &[],
        );
        let mut work = Workflow::new(intent.clone());
        let ids: std::collections::HashMap<_, _> = (1..=20000)
            .map(|uid| (uid, format!("{uid}@selected.test")))
            .collect();
        work.groups[0].identity = Some(Identity::Imap {
            validity: 1,
            message_ids: ids.clone(),
        });
        work.groups[0].origin = Some("native-origin".into());
        work.groups[0].selected = Some(Selected {
            validity: Some(1),
            cached_uids: (1..=20000).collect(),
            message_ids: ids,
            ..Default::default()
        });
        if action == Action::ArchiveBackupDelete {
            work.groups[0].stored = (1..=20000).map(|uid| mailvault_core::bulk_worker::StoredProof {
                uid, name:format!("{uid}.eml"), sha256:"a".repeat(64),
            }).collect();
            work.groups[0].verified = (1..=20000).collect();
            work.groups[0].eligible = (1..=20000).collect();
        }
        work.groups[0].attempted = vec![1, 2, 3, 4, 5];
        work.groups[0].deleted = vec![1, 2, 3, 4, 5];
        work.phase = "delete".into();
        work.status = "deleting".into();
        state
            .bulk
            .lock()
            .unwrap()
            .claim(&state.app_dir, "large", intent)
            .unwrap();
        // Seed the full worker, then measure the next actual steady-state checkpoint.
        crate::bulk_worker::checkpoint(&state, "large", "large", &work).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let writer = state.clone();
        let checkpoint = std::thread::spawn(move || {
            let started = Instant::now();
            tx.send(()).unwrap();
            crate::bulk_worker::checkpoint(&writer, "large", "large", &work).unwrap();
            started.elapsed()
        });
        rx.recv().unwrap();
        let status_started = Instant::now();
        let cancel_started = status_started;
        let (status, cancel) = tokio::join!(
            async {
                let reply = handle_request_for_test(&state, "bulk.status", json!({})).await;
                (reply, status_started.elapsed())
            },
            async {
                let reply =
                    handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"large"}))
                        .await;
                (reply, cancel_started.elapsed())
            }
        );
        let elapsed = checkpoint.join().unwrap();
        println!(
            "BULK_20K_MODE={action:?} BULK_20K_STEADY_CHECKPOINT_MS={} BULK_20K_STATUS_MS={} BULK_20K_CANCEL_MS={}",
            elapsed.as_millis(),
            status.1.as_millis(),
            cancel.1.as_millis()
        );
        assert_eq!(status.0.result.unwrap()["active"]["total"], 20000);
        assert!(cancel.0.error.is_none());
        assert!(status.1 < std::time::Duration::from_millis(200), "20k active status exceeded foreground latency bound: {:?}", status.1);
        assert!(cancel.1 < std::time::Duration::from_millis(200), "20k cancellation exceeded foreground latency bound: {:?}", cancel.1);
        assert!(state
            .bulk
            .lock()
            .unwrap()
            .cancel_token("large")
            .unwrap()
            .load(std::sync::atomic::Ordering::SeqCst));
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_large_admission_and_inactive_status_report_control_latency() {
        use mailvault_core::bulk::{Action, FrozenIntent, Scope};
        use mailvault_core::bulk_worker::{Identity, Selected, StoredProof, Workflow};
        use std::time::Instant;
        for action in [Action::Delete, Action::ArchiveBackupDelete] {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
            state.seed_accounts_for_test(&["a"]);
            let intent = FrozenIntent::freeze(
                action,
                Scope {
                    account_id: Some("a".into()),
                    mailbox: Some("INBOX".into()),
                    spans: false,
                    keys: (1..=20000).map(|uid| json!(uid)).collect(),
                target_hints: Vec::new(),
                },
                &["a".into()],
                &[],
            );
            let mut work = Workflow::new(intent.clone());
            let ids: std::collections::HashMap<_, _> = (1..=20000)
                .map(|uid| (uid, format!("{uid}@selected.test")))
                .collect();
            work.groups[0].identity = Some(Identity::Imap {
                validity: 1,
                message_ids: ids.clone(),
            });
            work.groups[0].origin = Some("native-origin".into());
            work.groups[0].selected = Some(Selected {
                validity: Some(1),
                cached_uids: (1..=20000).collect(),
                message_ids: ids,
                ..Default::default()
            });
            if action == Action::ArchiveBackupDelete {
                work.groups[0].stored = (1..=20000)
                    .map(|uid| StoredProof {
                        uid,
                        name: format!("{uid}.eml"),
                        sha256: "a".repeat(64),
                    })
                    .collect();
                work.groups[0].verified = (1..=20000).collect();
                work.groups[0].eligible = (1..=20000).collect();
            }
            work.phase = "delete".into();
            work.status = "deleting".into();
            for stage in ["claim", "inactive-status", "resume"] {
                let (tx, rx) = std::sync::mpsc::channel();
                let writer = state.clone();
                let original = intent.clone();
                let operation = std::thread::spawn(move || {
                    let started = Instant::now();
                    if stage == "claim" {
                        // Exercise the production off-lock admission seam, not
                        // the legacy core helper under an artificial outer lock.
                        writer.bulk.lock().unwrap()
                            .begin_admission("admission", "initial").unwrap();
                        tx.send(()).unwrap();
                        crate::bulk_worker::prepare_claim(
                            &writer, "admission", "initial", original,
                        ).unwrap();
                        return started.elapsed();
                    }
                    tx.send(()).unwrap();
                    match stage {
                        "inactive-status" => {
                            crate::bulk_worker::reconcile_pending(&writer).unwrap();
                        }
                        _ => {
                            crate::bulk_worker::prepare_resume(&writer, "admission", "restored")
                                .unwrap();
                        }
                    }
                    started.elapsed()
                });
                rx.recv().unwrap();
                let started = Instant::now();
                let (status, cancel) = tokio::join!(
                    async {
                        let reply = handle_request_for_test(&state, "bulk.status", json!({})).await;
                        (reply, started.elapsed())
                    },
                    async {
                        let reply = handle_request_for_test(
                            &state,
                            "bulk.cancel",
                            json!({"operationId":"admission"}),
                        )
                        .await;
                        (reply, started.elapsed())
                    },
                );
                let elapsed = operation.join().unwrap();
                println!("BULK_20K_ADMISSION_MODE={action:?} STAGE={stage} OP_MS={} STATUS_MS={} CANCEL_MS={}",elapsed.as_millis(),status.1.as_millis(),cancel.1.as_millis());
                assert!(status.0.error.is_none());
                assert!(
                    status.1 < std::time::Duration::from_millis(200),
                    "{action:?} {stage} status {:?}",
                    status.1
                );
                assert!(
                    cancel.1 < std::time::Duration::from_millis(200),
                    "{action:?} {stage} cancel {:?}",
                    cancel.1
                );
                if stage == "inactive-status" {
                    assert!(cancel.0.error.is_some());
                    for _ in 0..3 {
                        let reply = handle_request_for_test(&state, "bulk.status", json!({}))
                            .await
                            .result
                            .unwrap();
                        assert_eq!(reply["pending"]["remaining"], 20000);
                        assert_eq!(reply["pending"]["status"], "awaitingResume");
                    }
                }
                if stage == "resume" {
                    let reply = handle_request_for_test(
                        &state,
                        "bulk.cancel",
                        json!({"operationId":"admission"}),
                    )
                    .await;
                    assert!(
                        reply.error.is_none(),
                        "cancellation succeeds only after Active is published"
                    );
                }
                if stage == "claim" {
                    crate::bulk_worker::checkpoint(&state, "admission", "initial", &work).unwrap();
                    let _journal = state.journal.lock().unwrap();
                    state
                        .bulk
                        .lock()
                        .unwrap()
                        .drained_attempt("admission", "initial")
                        .unwrap();
                }
            }
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_realistic_original_selection_20k_control_latency() {
        use mailvault_core::bulk::{Action, FrozenIntent};
        use mailvault_core::bulk_worker::{Identity, Selected, StoredProof, Workflow};
        use std::time::Instant;
        for action in [Action::Delete, Action::ArchiveBackupDelete] {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
            state.seed_accounts_for_test(&["a"]);
            let intent = FrozenIntent::freeze(
                action,
                serde_json::from_value(json!({
                    "accountId":"a", "mailbox":"Work:Clients", "keys":(1..=20000).collect::<Vec<u32>>(),
                    "targetHints":(1..=20000).map(|uid| json!({
                        "accountId":"a", "mailbox":"Work:Clients", "uid":uid,
                        "nativeIdentity":{"accountId":"a","mailbox":"Work:Clients","uidValidity":1,"originHash":"a".repeat(64),"jmapMailboxId":"original-provider-mailbox-1731"},
                        "messageIdPresent":true,"messageId":format!("<original-message-{uid}@selection.test>"),
                        "jmapId":format!("original-provider-email-identity-{uid}")
                    })).collect::<Vec<_>>()
                })).unwrap(),
                &["a".into()],
                &[],
            );
            assert_eq!(serde_json::to_value(&intent).unwrap()["scope"]["targetHints"].as_array().map(Vec::len), Some(20000));
            let mut work = Workflow::new(intent.clone());
            let ids: std::collections::HashMap<_, _> = (1..=20000)
                .map(|uid| (uid, format!("original-provider-email-identity-{uid}")))
                .collect();
            work.groups[0].identity = Some(Identity::Jmap {
                mailbox_id: "original-provider-mailbox-1731".into(),
                ids: ids.clone(),
            });
            work.groups[0].origin = Some("a".repeat(64));
            work.groups[0].selected = Some(Selected {
                validity: Some(1),
                cached_uids: (1..=20000).collect(),
                message_ids: (1..=20000).map(|uid| (uid, format!("original-message-{uid}@selection.test"))).collect(),
                jmap_ids: ids,
                origin_hash: Some("a".repeat(64)),
                jmap_mailbox_id: Some("original-provider-mailbox-1731".into()),
                ..Default::default()
            });
            if action == Action::ArchiveBackupDelete {
                work.groups[0].stored = (1..=20000)
                    .map(|uid| StoredProof {
                        uid,
                        name: format!("{uid}.eml"),
                        sha256: "a".repeat(64),
                    })
                    .collect();
                work.groups[0].verified = (1..=20000).collect();
                work.groups[0].eligible = (1..=20000).collect();
            }
            work.phase = "delete".into();
            work.status = "deleting".into();
            for stage in ["claim", "inactive-status", "resume"] {
                let (tx, rx) = std::sync::mpsc::channel();
                let writer = state.clone();
                let original = intent.clone();
                let operation = std::thread::spawn(move || {
                    let started = Instant::now();
                    if stage == "claim" {
                        writer.bulk.lock().unwrap().begin_admission("admission", "initial").unwrap();
                        tx.send(()).unwrap();
                        crate::bulk_worker::prepare_claim(&writer, "admission", "initial", original).unwrap();
                        return started.elapsed();
                    }
                    tx.send(()).unwrap();
                    match stage {
                        "inactive-status" => {
                            crate::bulk_worker::reconcile_pending(&writer).unwrap();
                        }
                        _ => {
                            crate::bulk_worker::prepare_resume(&writer, "admission", "restored")
                                .unwrap();
                        }
                    }
                    started.elapsed()
                });
                rx.recv().unwrap();
                let started = Instant::now();
                let (status, cancel) = tokio::join!(
                    async {
                        let reply = handle_request_for_test(&state, "bulk.status", json!({})).await;
                        (reply, started.elapsed())
                    },
                    async {
                        let reply = handle_request_for_test(
                            &state,
                            "bulk.cancel",
                            json!({"operationId":"admission"}),
                        )
                        .await;
                        (reply, started.elapsed())
                    },
                );
                let elapsed = operation.join().unwrap();
                println!("BULK_REALISTIC_20K_ADMISSION_MODE={action:?} STAGE={stage} OP_MS={} STATUS_MS={} CANCEL_MS={}",elapsed.as_millis(),status.1.as_millis(),cancel.1.as_millis());
                assert!(status.0.error.is_none());
                assert!(
                    status.1 < std::time::Duration::from_millis(200),
                    "{action:?} {stage} status {:?}",
                    status.1
                );
                assert!(
                    cancel.1 < std::time::Duration::from_millis(200),
                    "{action:?} {stage} cancel {:?}",
                    cancel.1
                );
                if stage == "inactive-status" {
                    assert!(cancel.0.error.is_some());
                    for _ in 0..3 {
                        let reply = handle_request_for_test(&state, "bulk.status", json!({}))
                            .await
                            .result
                            .unwrap();
                        assert_eq!(reply["pending"]["remaining"], 20000);
                        assert_eq!(reply["pending"]["status"], "awaitingResume");
                    }
                }
                if stage == "resume" {
                    let reply = handle_request_for_test(
                        &state,
                        "bulk.cancel",
                        json!({"operationId":"admission"}),
                    )
                    .await;
                    assert!(
                        reply.error.is_none(),
                        "cancellation succeeds only after Active is published"
                    );
                }
                if stage == "claim" {
                    crate::bulk_worker::checkpoint(&state, "admission", "initial", &work).unwrap();
                    let _journal = state.journal.lock().unwrap();
                    state
                        .bulk
                        .lock()
                        .unwrap()
                        .drained_attempt("admission", "initial")
                        .unwrap();
                }
            }
        }
    }
    #[tokio::test]
    async fn bulk_duplicate_attempt_still_checks_the_frozen_intent() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let intent = mailvault_core::bulk::FrozenIntent::freeze(
            mailvault_core::bulk::Action::Archive,
            scope,
            &[],
            &[],
        );
        state
            .bulk
            .lock()
            .unwrap()
            .claim(&state.app_dir, "same", intent)
            .unwrap();
        let reply = handle_request_for_test(
            &state,
            "bulk.start",
            json!({"operationId":"same","attemptId":"same","type":"delete","scope":{"keys":[]}}),
        )
        .await;
        assert_eq!(reply.error.unwrap().message, "errors.operationRunning");
    }
    fn err_message(resp: RpcResponse) -> String {
        resp.error.map(|e| e.message).unwrap_or_default()
    }

    /// A test state lifts the process's soft open-file limit, so parallel
    /// tests do not run out at macOS's default of 256.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_test_state_lifts_the_open_file_limit() {
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let _s = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), true);
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
        assert!(lim.rlim_cur >= lim.rlim_max.min(TEST_OPEN_FILES), "soft {} of hard {}", lim.rlim_cur, lim.rlim_max);
    }

    // ── The index yields to the user ───────────────────────────────────

    #[tokio::test]
    async fn a_click_marks_foreground_activity_and_a_status_poll_does_not() {
        use std::sync::atomic::Ordering::SeqCst;
        let dir = scratch("foreground");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        handle_request(&state, req("search_index_status", json!({}))).await;
        handle_request(&state, req("ping", json!({}))).await;
        assert_eq!(state.search_index.last_foreground.load(SeqCst), 0, "index and health calls never hold the index back");
        handle_request(&state, req("maildir_read_light", json!({"accountId": "a", "mailbox": "INBOX", "uid": 1}))).await;
        assert_ne!(state.search_index.last_foreground.load(SeqCst), 0, "opening a message does");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Opening a saved view is a click the person waits on, read off the same
    /// index lock the indexer and the sidebar's badge counts take. The badges
    /// are bookkeeping and must not count as a click.
    #[test]
    fn opening_a_view_is_foreground_and_counting_the_badges_is_not() {
        assert!(crate::search_index::is_foreground_method("views.evaluate"));
        assert!(crate::search_index::is_foreground_method("views.senders"), "a click waits on who sends the view");
        assert!(!crate::search_index::is_foreground_method("views.counts"));
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
            ("people.list", json!({})),
            ("people.contacts.top", json!({"accountIds": ["a"]})),
            ("people.contacts.search", json!({"accountIds": ["a"], "query": "a"})),
            ("people.contacts.names", json!({"accountIds": ["a"]})),
        ] {
            let msg = err_message(handle_request(&state, req(method, params)).await);
            assert!(msg.contains("Mail storage folder"), "{method} was not refused, got: {msg:?}");
        }

        // Pins `MAILVAULT_GRAPH_BASE` to the shared Graph mock before anything
        // reads it, and keeps its response queue to this test while it runs.
        let _graph_mock = crate::handlers::graph::test_graph_mock();
        for (method, params) in [
            ("ping", json!({})),
            ("daemon.heartbeat", json!({})),
            ("learning.rules", json!({"accountId": "a"})),
            ("classification.summary", json!({"accountId": "a"})),
            // Task 5.4a: flat `imap_*` names have no `.`, so they never match
            // this gate's prefix check — a live IMAP read has nothing to do
            // with the vault. Bogus host/port so this fails fast on a
            // connection error, never on the gate text this test checks for.
            ("imap_get_mailboxes", json!({"account": {"email": "a@b.co", "imapHost": "127.0.0.1", "imapPort": 1}})),
            // Task 5.4b: same reasoning, write-path family. Bogus host/port
            // so this fails fast on a connection error too. A failed test is
            // a `success:false` result (no RPC error, so `err_message` is
            // empty), which still never contains the gate text.
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
            // a process-wide `OnceLock` on first use), so the call goes to
            // `handlers::graph`'s shared mock (guard held above). Setting the
            // variable to a dead port here would freeze that base for every
            // Graph test that runs after this one in the process.
            ("graph_set_read", json!({"accessToken": "x", "messageId": "m1", "isRead": true})),
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

    /// The app asks this on start and on every reconnect; with the vault gone
    /// it still has to answer, because a locked keychain is not a vault fault.
    #[tokio::test]
    async fn keychain_status_is_routed_and_ungated() {
        let dir = scratch("keychain");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), false);
        let resp = handle_request(&state, req("keychain.status", json!({}))).await;
        let status = resp.result.expect("keychain.status answers");
        assert!(status["blocked"].is_boolean(), "got: {status:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
        state.seed_accounts_for_test(&["acc1"]);

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

    /// The daemon outlives the app. A relaunched app has no cursor, and
    /// polling from 0 handed it the whole ring of recent changes, so every
    /// arrival of the last day was announced again on each cold start. Without
    /// a cursor it resumes after the last generation a poll acknowledged:
    /// what arrived while no app was listening still comes back, nothing the
    /// previous app already handled does.
    #[tokio::test]
    async fn sync_events_without_a_cursor_resumes_after_the_last_acknowledged_generation() {
        let dir = scratch("syncevents_resume");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);

        // The previous app saw gens 1 and 2 and came back with since=2.
        state.sync_engine.note_change("a1", "INBOX", 1, 0);
        state.sync_engine.note_change("a1", "INBOX", 1, 0);
        let first = handle_request(&state, req("sync.events", json!({"since": 0, "timeoutMs": 10}))).await;
        assert_eq!(first.result.expect("must succeed")["changes"].as_array().unwrap().len(), 2);
        handle_request(&state, req("sync.events", json!({"since": 2, "timeoutMs": 10}))).await;

        // It is killed; mail arrives while nobody listens; a new app polls cold.
        state.sync_engine.note_change("a1", "INBOX", 1, 0);
        let cold = handle_request(&state, req("sync.events", json!({"since": null, "timeoutMs": 10}))).await;

        let result = cold.result.expect("must succeed");
        assert_eq!(result["gen"], json!(3));
        let gens: Vec<u64> = result["changes"].as_array().unwrap().iter().map(|c| c["gen"].as_u64().unwrap()).collect();
        assert_eq!(gens, vec![3], "only the arrival nobody was told about");
        let _ = std::fs::remove_dir_all(&dir);
    }

    mod sync_observation_red {
        use super::*;
        use mock_imap::commands::{next_arg, parse_command};
        use mock_imap::state::{synthetic_mailbox, Mailbox};
        use mock_imap::{MockImap, Scenario};
        use serde_json::{json, Value};
        use std::sync::Arc;

        struct CredentialsEnv {
            credentials: Option<std::ffi::OsString>,
            plaintext: Option<std::ffi::OsString>,
        }

        impl CredentialsEnv {
            fn capture() -> Self {
                Self {
                    credentials: std::env::var_os("MAILVAULT_TEST_CREDENTIALS"),
                    plaintext: std::env::var_os("MAILVAULT_IMAP_PLAINTEXT"),
                }
            }
        }

        impl Drop for CredentialsEnv {
            fn drop(&mut self) {
                match self.credentials.take() {
                    Some(value) => std::env::set_var("MAILVAULT_TEST_CREDENTIALS", value),
                    None => std::env::remove_var("MAILVAULT_TEST_CREDENTIALS"),
                }
                match self.plaintext.take() {
                    Some(value) => std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", value),
                    None => std::env::remove_var("MAILVAULT_IMAP_PLAINTEXT"),
                }
            }
        }

        fn bind_account(state: &Arc<DaemonState>, server: &MockImap) -> Value {
            let row = json!({
                "id": "acc1", "email": "user@example.com", "authType": "password",
                "imapHost": server.host(), "imapPort": server.port(), "imapSecure": false,
            });
            std::fs::write(state.app_dir.join("accounts.json"), json!([row]).to_string()).unwrap();
            state.account_lifecycle.seed(
                &mailvault_core::accounts_doc::list(
                    &mailvault_core::accounts_doc::shared(&state.app_dir),
                ).unwrap(),
            );
            let stored = json!({
                "id": "acc1", "email": "user@example.com", "authType": "password",
                "password": "hunter2", "imapHost": server.host(),
                "imapPort": server.port(), "imapSecure": false,
            }).to_string();
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({"acc1": stored}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
            json!({
                "id": "acc1", "email": "user@example.com",
                "imapConfig": {
                    "email": "user@example.com", "imapHost": server.host(),
                    "imapPort": server.port(), "imapSecure": false,
                },
            })
        }

        fn commands_named(server: &MockImap, name: &str) -> Vec<mock_imap::commands::Command> {
            server.commands().iter()
                .filter_map(|line| parse_command(line))
                .filter(|command| command.name == name)
                .collect()
        }

        fn refresh_provider_trace(server: &MockImap, from: usize) -> Vec<(String, bool, String)> {
            server.commands().into_iter().skip(from)
                .filter_map(|line| parse_command(&line))
                .filter(|command| matches!(command.name.as_str(), "SELECT" | "FETCH"))
                .map(|command| (command.name, command.is_uid, command.args))
                .collect()
        }

        fn refresh_status_selects(server: &MockImap, mailbox: &str) -> usize {
            commands_named(server, "SELECT").into_iter().filter(|command| {
                let mut args = command.args.as_str();
                next_arg(&mut args).as_deref() == Some(mailbox)
                    && args.trim().eq_ignore_ascii_case("(CONDSTORE)")
            }).count()
        }

        // This dispatcher future is large in debug builds. Repeated inline
        // awaits made the later effect tests exceed a Windows test stack.
        async fn boxed_request(state: &Arc<DaemonState>, request: crate::ipc::RpcRequest)
            -> crate::ipc::RpcResponse {
            Box::pin(handle_request(state, request)).await
        }

        #[tokio::test]
        async fn sync_observation_rejects_unknown_account_fields_before_credential_lookup() {
            use std::sync::atomic::Ordering::SeqCst;

            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let credentials = state.app_dir.join("credentials.json");
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
            let backend = crate::credentials::TestKeychainGuard::install(credentials);
            let (release, gate) = std::sync::mpsc::channel::<()>();
            *backend.0.shared.gate.lock().unwrap() = Some(gate);

            let oauth_account = json!({
                "id": "acc1", "email": "user@example.com", "authType": "oauth2",
                "imapHost": server.host(), "imapPort": server.port(),
            });
            let mut requests = Vec::new();
            for (method, base) in [
                ("sync.probe", json!({"op":"check", "accountId":"acc1", "mailbox":"INBOX"})),
                ("sync.probe", json!({"op":"mark", "accountId":"acc1", "mailbox":"INBOX", "verificationRef":"proof"})),
                ("sync.probe", json!({"op":"invalidate", "accountId":"acc1", "mailbox":"INBOX"})),
                ("folders.status", json!({"op":"refresh", "accountId":"acc1", "activeMailbox":"INBOX", "mailboxes":[{"path":"Sent"}]})),
                ("folders.status", json!({"op":"invalidate", "accountId":"acc1"})),
            ] {
                for field in ["account", "accountJson", "targets"] {
                    let mut params = base.clone();
                    params[field] = match field {
                        "account" => oauth_account.clone(),
                        "accountJson" => json!(oauth_account.to_string()),
                        _ => json!([{"accountId":"acc1", "account":oauth_account}]),
                    };
                    requests.push((method, field, params));
                }
            }

            let mut pending = Vec::new();
            for (method, field, params) in &requests {
                let state = Arc::clone(&state);
                let method = *method;
                let field = *field;
                let params = params.clone();
                pending.push(tokio::spawn(async move {
                    (method, field, boxed_request(&state, req(method, params)).await)
                }));
            }
            let prompt = tokio::time::timeout(std::time::Duration::from_secs(2),
                futures::future::join_all(pending.iter_mut())).await;
            let credential_reads = backend.0.shared.starts.load(SeqCst);
            let token_reads = backend.0.modes.lock().unwrap().len();
            let _ = release.send(());
            if prompt.is_err() {
                for task in &pending { task.abort(); }
            }
            let replies = prompt.expect(
                "strict observation requests must answer before the held credential gate");
            assert_eq!(credential_reads, 0,
                "invalid observation fields must perform zero credential reads");
            assert_eq!(token_reads, 0,
                "invalid observation fields must perform zero token lookups");
            for reply in replies {
                let (method, field, reply) = reply.expect("dispatcher task must not panic");
                assert_eq!(reply.error.expect("strict request must reject").code,
                    ipc::INVALID_PARAMS, "{method} accepted forbidden {field}");
            }
            assert!(server.commands().is_empty(),
                "invalid observation requests must perform zero provider commands");
        }

        #[tokio::test]
        async fn sync_observation_provider_children_run_on_background_worker() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailboxes(vec![
                synthetic_mailbox("WorkerProbe", 2), Mailbox::new("WorkerFolder"),
            ]));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let started = boxed_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "WorkerProbe", "autoClassify": false,
            }))).await;
            let ticket = started.result.expect("seed sync must start")["ticket"]
                .as_u64().expect("seed sync ticket");
            let completed = boxed_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(completed.result.expect("seed sync must finish")["success"], json!(true));

            let capture = crate::handlers::sync_observation::WorkerSampleGuard::start();
            let probe = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "WorkerProbe",
            }))).await;
            assert_eq!(probe.result.expect("probe must answer")["reason"], json!("modseq-match"));
            let folder = boxed_request(&state, req("folders.status", json!({
                "op": "refresh", "accountId": "acc1", "activeMailbox": "WorkerProbe",
                "mailboxes": [{"path": "WorkerFolder"}],
            }))).await;
            assert_eq!(folder.result.expect("folder sweep must answer")["rows"]
                .as_array().map(Vec::len), Some(1));

            let samples = capture.take();
            let probe_index = samples.iter().position(|sample|
                sample.kind == "provider-probe" && sample.mailbox == "WorkerProbe")
                .expect("actual probe provider child must be observed");
            let probe_worker = &samples[probe_index];
            let folder_worker = samples.iter().find(|sample|
                sample.kind == "provider-folder" && sample.mailbox == "WorkerFolder")
                .expect("actual folder provider child must be observed");
            for sample in [probe_worker, folder_worker] {
                assert!(sample.thread_name.as_deref().is_some_and(|name|
                    name.starts_with("sync-observation-worker")),
                    "provider child must run on the named background worker: {sample:?}");
            }
            let post_provider_cache = samples.iter().skip(probe_index + 1).find(|sample|
                sample.kind == "cache-blocking" && sample.mailbox == "WorkerProbe")
                .expect("probe revalidation must include the actual blocking cache child");
            #[cfg(target_os = "macos")]
            {
                let background = libc::qos_class_t::QOS_CLASS_BACKGROUND as u32;
                for sample in [probe_worker, folder_worker, post_provider_cache] {
                    assert_eq!(sample.qos, Some(background),
                        "observation provider and blocking children must use background QoS: {sample:?}");
                }
                for sample in [probe_worker, folder_worker] {
                    assert!(sample.stack_bytes.is_some_and(|bytes| bytes >= 8 * 1024 * 1024),
                        "observation provider thread must have an explicit 8 MiB stack: {sample:?}");
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = post_provider_cache;
        }

        #[tokio::test]
        async fn sync_observation_red_equal_modseq_reaches_one_real_select() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let dir = tempfile::tempdir().unwrap();
            let _credentials_env = CredentialsEnv::capture();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);

            // The existing ticketed sync seeds a real, complete native cache.
            let started = handle_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = started.result.expect("existing sync.now must start")["ticket"]
                .as_u64().expect("ticket number");
            let completed = handle_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(completed.result.expect("existing sync.wait must finish")["success"], json!(true));

            let metadata = crate::custody::with_conn(&state, |conn| {
                mailvault_core::custody::cache::load_meta(conn, "acc1", "INBOX")
            }).unwrap().expect("native metadata after sync");
            let metadata: Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(metadata["totalEmails"], json!(2));
            assert_eq!(metadata["totalCached"], json!(2));
            assert!(metadata["highestModseq"].as_u64().is_some(),
                "CONDSTORE cache must carry a modseq before probing: {metadata:?}");

            let select_before = commands_named(&server, "SELECT").len();
            let reply = handle_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await;
            let select_after = commands_named(&server, "SELECT").len();
            assert!(reply.error.is_none(),
                "sync.probe check must be routed; error={:?}, real SELECT delta={}",
                reply.error, select_after - select_before);
            let result = reply.result.expect("sync.probe result");
            assert_eq!(result["unchanged"], json!(true));
            assert_eq!(result["reason"], json!("modseq-match"));
            assert!(result["verificationRef"].as_str().is_some_and(|value| !value.is_empty()),
                "a successful provider check must issue a native proof: {result:?}");
            assert_eq!(select_after - select_before, 1,
                "one actual CONDSTORE SELECT must check the provider");
        }

        #[tokio::test]
        async fn sync_observation_red_closed_folder_first_fifty_have_real_status_rows() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let dir = tempfile::tempdir().unwrap();
            let _credentials_env = CredentialsEnv::capture();
            let folders = std::iter::once(Mailbox::new("INBOX"))
                .chain((0..=50).map(|index| {
                    let path = format!("F{index:02}");
                    if index == 0 { synthetic_mailbox(&path, 2) } else { Mailbox::new(path.as_str()) }
                }))
                .collect();
            let server = MockImap::start(Scenario::new().mailboxes(folders));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            bind_account(&state, &server);

            // 51 eligible paths: a nonselect parent is traversed but never sent.
            let children: Vec<Value> = (0..2).map(|index|
                json!({"path": format!("F{index:02}"), "children": []})).collect();
            let mut nodes = vec![json!({"path": "INBOX"}),
                json!({"path": "Parent", "noselect": true, "children": children})];
            nodes.extend((2..=50).map(|index|
                json!({"path": format!("F{index:02}")})));

            let reply = handle_request(&state, req("folders.status", json!({
                "op": "refresh", "accountId": "acc1", "activeMailbox": "INBOX",
                "mailboxes": nodes,
            }))).await;
            let status_paths: Vec<String> = commands_named(&server, "STATUS")
                .iter().map(|command| {
                    let mut args = command.args.as_str();
                    next_arg(&mut args).expect("STATUS mailbox argument")
                }).collect();
            assert!(reply.error.is_none(),
                "folders.status refresh must be routed; error={:?}, real STATUS paths={status_paths:?}",
                reply.error);
            let result = reply.result.expect("folders.status result");
            let rows = result["rows"].as_array().expect("rows array");
            assert_eq!(rows.len(), 50, "native selection must cap at 50 actual rows");
            let expected: Vec<String> = (0..50).map(|index| format!("F{index:02}")).collect();
            assert_eq!(status_paths, expected,
                "provider STATUS order must follow preorder, exclude active and cap at 50");
            let first = rows.iter().find(|row| row["path"] == json!("F00"))
                .expect("F00 returned by actual mock provider");
            assert_eq!(first["messages"], json!(2));
            assert_eq!(first["unseen"], json!(2));
            assert!(first["uidNext"].as_u64().is_some());
            assert!(first["uidValidity"].as_u64().is_some());
            assert!(rows.iter().all(|row| row["path"] != json!("INBOX")
                && row["path"] != json!("Parent") && row["path"] != json!("F50")));
        }
        #[tokio::test]
        async fn sync_observation_checks_do_not_mark_until_a_proof_is_consumed() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let start = boxed_request(&state, req("sync.now", json!({"account": account, "mailbox": "INBOX"}))).await;
            let ticket = start.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({"ticket": ticket, "timeoutMs": 10_000}))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));

            let before = commands_named(&server, "SELECT").len();
            let first = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            let second = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(first["reason"], json!("modseq-match"));
            assert_eq!(second["reason"], json!("modseq-match"));
            assert_eq!(commands_named(&server, "SELECT").len() - before, 2,
                "two unmarked checks each reach the provider");
            let first_ref = first["verificationRef"].as_str().unwrap();
            let second_ref = second["verificationRef"].as_str().unwrap();
            assert_ne!(first_ref, second_ref);
            let marked = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "INBOX",
                "verificationRef": first_ref,
            }))).await.result.unwrap();
            assert_eq!(marked["marked"], json!(true));
            let recent = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(recent["reason"], json!("probed-recently"));
            assert_eq!(commands_named(&server, "SELECT").len() - before, 2);

            let invalidated = boxed_request(&state, req("sync.probe", json!({
                "op": "invalidate", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(invalidated["invalidated"], json!(true));
            let stale = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "INBOX",
                "verificationRef": second_ref,
            }))).await.result.unwrap();
            assert_eq!(stale["marked"], json!(false));
            let fresh = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(fresh["reason"], json!("modseq-match"));
            assert_eq!(commands_named(&server, "SELECT").len() - before, 3);
        }

        #[tokio::test]
        async fn sync_observation_completed_ticket_marks_only_its_issued_generation() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let start = boxed_request(&state, req("sync.now", json!({"account": account, "mailbox": "INBOX"}))).await;
            let ticket = start.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({"ticket": ticket, "timeoutMs": 10_000}))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));

            let wrong = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "Sent", "ticket": ticket,
            }))).await.result.unwrap();
            assert_eq!(wrong["marked"], json!(false));
            let marked = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "INBOX", "ticket": ticket,
            }))).await.result.unwrap();
            assert_eq!(marked["marked"], json!(true));
            let before = commands_named(&server, "SELECT").len();
            let recent = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(recent["reason"], json!("probed-recently"));
            assert_eq!(commands_named(&server, "SELECT").len(), before);
            boxed_request(&state, req("sync.probe", json!({
                "op": "invalidate", "accountId": "acc1", "mailbox": "INBOX",
            }))).await;
            let stale = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "INBOX", "ticket": ticket,
            }))).await.result.unwrap();
            assert_eq!(stale["marked"], json!(false));
        }

        #[tokio::test]
        async fn sync_observation_empty_and_partial_cache_never_contact_provider() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            bind_account(&state, &server);
            let empty = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(empty["reason"], json!("no-cache"));
            assert!(commands_named(&server, "SELECT").is_empty());
            crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX",
                    &json!({"totalEmails": 2, "uidValidity": 1, "highestModseq": 3}).to_string())
            ).unwrap();
            let partial = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(partial["reason"], json!("partial-cache"));
            assert!(commands_named(&server, "SELECT").is_empty());

            crate::custody::with_conn(&state, |conn| {
                conn.execute("UPDATE header_cache_meta SET meta_json='{broken' WHERE account_id='acc1' AND mailbox_path='INBOX'", [])
                    .map(|_| ()).map_err(|error| error.to_string())
            }).unwrap();
            let unreadable = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(unreadable["reason"], json!("meta-read-failed"));
            assert!(commands_named(&server, "SELECT").is_empty());
        }

        #[tokio::test]
        async fn sync_observation_failed_folder_sweep_consumes_throttle() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new()
                .mailboxes(vec![Mailbox::new("INBOX"), synthetic_mailbox("F00", 2)])
                .fault(mock_imap::Trigger::nth("STATUS", 1), mock_imap::Action::DropConnection));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            bind_account(&state, &server);
            let request = || json!({"op": "refresh", "accountId": "acc1", "activeMailbox": "INBOX",
                "mailboxes": [{"path": "INBOX"}, {"path": "F00"}]});
            let failed = boxed_request(&state, req("folders.status", request())).await;
            assert!(failed.error.is_some(), "the dropped provider sweep must fail");
            assert_eq!(commands_named(&server, "STATUS").len(), 1);
            let throttled = boxed_request(&state, req("folders.status", request())).await;
            assert!(throttled.error.is_none());
            assert_eq!(throttled.result, Some(Value::Null));
            assert_eq!(commands_named(&server, "STATUS").len(), 1);
            let invalidated = boxed_request(&state, req("folders.status", json!({
                "op": "invalidate", "accountId": "acc1",
            }))).await.result.unwrap();
            assert_eq!(invalidated["invalidated"], json!(true));
            let retried = boxed_request(&state, req("folders.status", request())).await;
            let rows = retried.result.expect("sweep after invalidation")["rows"].as_array().unwrap().clone();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["path"], json!("F00"));
            assert_eq!(commands_named(&server, "STATUS").len(), 2);
        }

        #[tokio::test]
        async fn sync_observation_provider_error_never_reports_unchanged() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let start = boxed_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = start.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));
            server.reset_scenario(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2))
                .fault(mock_imap::Trigger::nth("SELECT", 1), mock_imap::Action::DropConnection));
            let result = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(result["reason"], json!("probe-failed"));
            assert_eq!(result["unchanged"], json!(false));
            assert!(result.get("verificationRef").is_none());
            assert_eq!(commands_named(&server, "SELECT").len(), 1);
        }

        #[tokio::test]
        async fn sync_observation_native_probe_deadline_is_conservative() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let start = boxed_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = start.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));

            let before = commands_named(&server, "SELECT").len();
            let pause = server.pause_command("SELECT");
            let held_state = Arc::clone(&state);
            let held = tokio::spawn(async move {
                boxed_request(&held_state, req("sync.probe", json!({
                    "op": "check", "accountId": "acc1", "mailbox": "INBOX",
                }))).await
            });
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(5)),
                    "real provider SELECT must be held through the native deadline");
                pause
            }).await.unwrap();
            let reply = tokio::time::timeout(std::time::Duration::from_secs(29), held)
                .await.expect("native probe deadline must finish before the outer bound")
                .unwrap();
            let result = reply.result.unwrap();
            assert_eq!(result["reason"], json!("probe-failed"));
            assert_eq!(result["unchanged"], json!(false));
            assert!(result.get("verificationRef").is_none());
            assert_eq!(commands_named(&server, "SELECT").len() - before, 1);
            pause.release();
        }

        #[tokio::test]
        async fn sync_observation_probe_deadline_includes_guarded_credential_resolution() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let started = boxed_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = started.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));
            let before = commands_named(&server, "SELECT").len();

            // This gate is inside the actual credential spawn_blocking child, so the
            // route's async resolver yields and its deadline remains pollable.
            let backend = crate::credentials::TestKeychainGuard::install(
                state.app_dir.join("credentials.json"));
            let (read_release, read_gate) = std::sync::mpsc::channel::<()>();
            let (read_entered, read_notice) = std::sync::mpsc::channel::<()>();
            let (read_finished, read_done) = std::sync::mpsc::channel::<()>();
            *backend.0.shared.gate.lock().unwrap() = Some(read_gate);
            *backend.0.shared.captured.lock().unwrap() = Some(read_entered);
            *backend.0.shared.finished.lock().unwrap() = Some(read_finished);

            let provider_gate = server.pause_command("SELECT");
            let held_state = Arc::clone(&state);
            let mut held = tokio::spawn(async move {
                boxed_request(&held_state, req("sync.probe", json!({
                    "op": "check", "accountId": "acc1", "mailbox": "INBOX",
                }))).await
            });
            tokio::task::spawn_blocking(move ||
                read_notice.recv_timeout(std::time::Duration::from_secs(5))
            ).await.unwrap().expect("actual credential child must capture the stored record");
            tokio::time::pause();
            tokio::time::advance(std::time::Duration::from_secs(15)).await;
            tokio::time::resume();
            read_release.send(()).unwrap();
            tokio::task::spawn_blocking(move ||
                read_done.recv_timeout(std::time::Duration::from_secs(5))
            ).await.unwrap().expect("credential child must finish after release");
            let mut provider_gate = tokio::task::spawn_blocking(move || {
                assert!(provider_gate.entered(std::time::Duration::from_secs(5)),
                    "real provider SELECT must follow credential resolution");
                provider_gate
            }).await.unwrap();
            assert_eq!(commands_named(&server, "SELECT").len() - before, 1);

            tokio::time::pause();
            tokio::time::advance(std::time::Duration::from_secs(11)).await;
            let outcome = tokio::time::timeout(std::time::Duration::from_millis(1), &mut held).await;
            tokio::time::resume();
            provider_gate.release();
            if outcome.is_err() {
                held.abort();
                let _ = held.await;
            }
            let reply = outcome.expect("the entire native probe must finish within 25 seconds")
                .expect("probe route task must not panic");
            let result = reply.result.expect("probe timeout must answer conservatively");
            assert_eq!(result["unchanged"], json!(false));
            assert_eq!(result["reason"], json!("probe-failed"));
            assert!(result.get("verificationRef").is_none());
            assert_eq!(commands_named(&server, "SELECT").len() - before, 1);
        }

        #[tokio::test]
        async fn sync_observation_held_probe_yields_foreground_and_invalidation_fences_result() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let start = boxed_request(&state, req("sync.now", json!({"account": account, "mailbox": "INBOX"}))).await;
            let ticket = start.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({"ticket": ticket, "timeoutMs": 10_000}))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));

            let pause = server.pause_command("SELECT");
            let held_state = Arc::clone(&state);
            let held = tokio::spawn(async move {
                boxed_request(&held_state, req("sync.probe", json!({
                    "op": "check", "accountId": "acc1", "mailbox": "INBOX",
                }))).await
            });
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(5)), "provider SELECT must be reached");
                pause
            }).await.unwrap();
            let foreground = tokio::time::timeout(std::time::Duration::from_secs(3),
                boxed_request(&state, req("sync.status", json!({"accountId": "acc1"}))))
                .await.expect("foreground read must not wait on provider");
            assert!(foreground.error.is_none());
            let invalidated = boxed_request(&state, req("sync.probe", json!({
                "op": "invalidate", "accountId": "acc1", "mailbox": "INBOX",
            }))).await;
            assert!(invalidated.error.is_none());
            pause.release();
            let late = held.await.unwrap().result.unwrap();
            assert_eq!(late["unchanged"], json!(false));
            assert!(late.get("verificationRef").is_none(), "late check cannot issue a proof");
        }

        #[tokio::test]
        async fn sync_observation_complete_cache_requires_a_matching_native_owner() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let config: crate::imap::ImapConfig =
                serde_json::from_value(account["imapConfig"].clone()).unwrap();
            let started = boxed_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = started.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));

            let original = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::native_identity(conn, "acc1", "INBOX")
            ).unwrap().expect("complete synced cache has a native owner");
            assert_eq!(original.origin_hash,
                mailvault_core::bulk_worker::origin_hash(&config));
            let wrong_hash = if original.origin_hash == "f".repeat(64) {
                "e".repeat(64)
            } else { "f".repeat(64) };
            crate::custody::with_conn(&state, |conn| {
                let changed = conn.execute(
                    "UPDATE header_cache_meta SET meta_json=json_set(meta_json, '$.nativeIdentity.originHash', ?1) WHERE account_id=?2 AND mailbox_path=?3",
                    rusqlite::params![wrong_hash.as_str(), "acc1", "INBOX"],
                ).map_err(|error| error.to_string())?;
                if changed == 1 { Ok(()) } else { Err("expected one native metadata row".into()) }
            }).unwrap();
            let mutated = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::native_identity(conn, "acc1", "INBOX")
            ).unwrap().expect("wrong owner remains syntactically valid");
            assert_eq!(mutated.origin_hash, wrong_hash);

            let before = commands_named(&server, "SELECT").len();
            let wrong = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.expect("wrong-owner check answers conservatively");
            crate::custody::with_conn(&state, |conn| {
                let changed = conn.execute(
                    "UPDATE header_cache_meta SET meta_json=json_set(meta_json, '$.nativeIdentity', json('null')) WHERE account_id='acc1' AND mailbox_path='INBOX'",
                    [],
                ).map_err(|error| error.to_string())?;
                if changed == 1 { Ok(()) } else { Err("expected one native metadata row".into()) }
            }).unwrap();
            let missing_owner = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::native_identity(conn, "acc1", "INBOX")
            ).unwrap();
            assert!(missing_owner.is_none(), "legacy complete cache has no owner");
            let missing = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.expect("missing-owner check answers conservatively");
            let select_delta = commands_named(&server, "SELECT").len() - before;

            assert_eq!((wrong["unchanged"].clone(), wrong.get("verificationRef").is_none(),
                missing["unchanged"].clone(), missing.get("verificationRef").is_none(),
                select_delta), (json!(false), true, json!(false), true, 0),
                "unbound native cache must not issue a proof or contact the provider");
        }
        #[tokio::test]
        async fn sync_observation_marker_follows_origin_and_ignores_secret_rotation() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let started = boxed_request(&state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = started.result.unwrap()["ticket"].as_u64().unwrap();
            let waited = boxed_request(&state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(waited.result.unwrap()["success"], json!(true));
            let marked = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "INBOX", "ticket": ticket,
            }))).await.result.unwrap();
            assert_eq!(marked["marked"], json!(true));
            let before = commands_named(&server, "SELECT").len();

            let credentials_path = state.app_dir.join("credentials.json");
            let mut credentials: Value = serde_json::from_slice(&std::fs::read(&credentials_path).unwrap()).unwrap();
            let mut record: Value = serde_json::from_str(credentials["acc1"].as_str().unwrap()).unwrap();
            record["password"] = json!("rotated-secret");
            credentials["acc1"] = json!(record.to_string());
            std::fs::write(&credentials_path, credentials.to_string()).unwrap();
            let token_only = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(token_only["reason"], json!("probed-recently"),
                "secret rotation must preserve a source-bound marker");
            assert_eq!(commands_named(&server, "SELECT").len(), before);

            let document = state.app_dir.join("accounts.json");
            let mut rows: Value = serde_json::from_slice(&std::fs::read(&document).unwrap()).unwrap();
            rows[0]["imapHost"] = json!("127.0.0.2");
            std::fs::write(&document, rows.to_string()).unwrap();
            let changed = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(changed["unchanged"], json!(false),
                "changed authoritative origin cannot reuse the old marker");
            assert_ne!(changed["reason"], json!("probed-recently"));
            assert_eq!(commands_named(&server, "SELECT").len(), before);
            let stale_ticket = boxed_request(&state, req("sync.probe", json!({
                "op": "mark", "accountId": "acc1", "mailbox": "INBOX", "ticket": ticket,
            }))).await.result.unwrap();
            assert_eq!(stale_ticket["marked"], json!(false));

            state.account_lifecycle.apply_committed_membership(None,
                &mailvault_core::accounts_doc::MembershipDelta {
                    removed: ["acc1".to_owned()].into(), ..Default::default()
                });
            let retired = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc1", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(retired["unchanged"], json!(false));
            assert_eq!(commands_named(&server, "SELECT").len(), before);
        }

        #[tokio::test]
        async fn sync_observation_invalidation_fences_a_held_folder_sweep() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailboxes(vec![
                Mailbox::new("INBOX"), synthetic_mailbox("F00", 2),
            ]));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            bind_account(&state, &server);
            let request = json!({
                "op": "refresh", "accountId": "acc1", "activeMailbox": "INBOX",
                "mailboxes": [{"path": "INBOX"}, {"path": "F00"}],
            });
            let pause = server.pause_command("STATUS");
            let held_state = Arc::clone(&state);
            let held_request = request.clone();
            let held = tokio::spawn(async move {
                boxed_request(&held_state, req("folders.status", held_request)).await
            });
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(5)),
                    "real folder STATUS must be reached");
                pause
            }).await.unwrap();
            assert_eq!(commands_named(&server, "STATUS").len(), 1);
            let invalidated = boxed_request(&state, req("folders.status", json!({
                "op": "invalidate", "accountId": "acc1",
            }))).await.result.unwrap();
            assert_eq!(invalidated["invalidated"], json!(true));
            pause.release();
            let stale = held.await.unwrap();
            assert!(stale.error.is_none());
            assert_eq!(stale.result, Some(Value::Null),
                "held result cannot publish after invalidation");
            let fresh = boxed_request(&state, req("folders.status", request)).await;
            let rows = fresh.result.expect("new sweep after invalidation")["rows"].as_array().unwrap().clone();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["path"], json!("F00"));
            assert_eq!(rows[0]["messages"], json!(2));
            assert_eq!(commands_named(&server, "STATUS").len(), 2);
        }

        #[tokio::test]
        async fn sync_observation_empty_and_graph_folder_scopes_do_not_throttle() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailboxes(vec![
                Mailbox::new("INBOX"), synthetic_mailbox("F00", 2),
            ]));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            bind_account(&state, &server);
            let empty = boxed_request(&state, req("folders.status", json!({
                "op": "refresh", "accountId": "acc1", "activeMailbox": "INBOX",
                "mailboxes": [{"path": "INBOX"}],
            }))).await;
            assert_eq!(empty.result, Some(Value::Null));
            let document = state.app_dir.join("accounts.json");
            let mut rows: Value = serde_json::from_slice(&std::fs::read(&document).unwrap()).unwrap();
            rows[0]["oauth2Transport"] = json!("graph");
            std::fs::write(&document, rows.to_string()).unwrap();
            let wanted = || json!({
                "op": "refresh", "accountId": "acc1", "activeMailbox": "INBOX",
                "mailboxes": [{"path": "INBOX"}, {"path": "F00"}],
            });
            let graph = boxed_request(&state, req("folders.status", wanted())).await;
            assert_eq!(graph.result, Some(Value::Null));
            assert!(commands_named(&server, "STATUS").is_empty());
            rows[0].as_object_mut().unwrap().remove("oauth2Transport");
            std::fs::write(&document, rows.to_string()).unwrap();
            let eligible = boxed_request(&state, req("folders.status", wanted())).await;
            assert_eq!(eligible.result.unwrap()["rows"].as_array().unwrap().len(), 1);
            assert_eq!(commands_named(&server, "STATUS").len(), 1,
                "skipped scopes did not consume throttle");
        }

        #[tokio::test]
        async fn sync_observation_retirement_fences_held_probe_and_leaves_other_account_live() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let row = |id: &str, email: &str| json!({
                "id": id, "email": email, "authType": "password",
                "imapHost": server.host(), "imapPort": server.port(), "imapSecure": false,
            });
            let a = row("acc1", "one@example.test");
            let b = row("acc2", "two@example.test");
            std::fs::write(state.app_dir.join("accounts.json"), json!([a, b]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let credential = |id: &str, email: &str| json!({
                "id": id, "email": email, "authType": "password", "password": "hunter2",
                "imapHost": server.host(), "imapPort": server.port(), "imapSecure": false,
            }).to_string();
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({
                "acc1": credential("acc1", "one@example.test"),
                "acc2": credential("acc2", "two@example.test"),
            }).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
            for (id, email) in [("acc1", "one@example.test"), ("acc2", "two@example.test")] {
                let start = boxed_request(&state, req("sync.now", json!({
                    "account": {"id": id, "email": email, "imapConfig": row(id, email)},
                    "mailbox": "INBOX", "autoClassify": false,
                }))).await;
                let ticket = start.result.unwrap()["ticket"].as_u64().unwrap();
                let waited = boxed_request(&state, req("sync.wait", json!({
                    "ticket": ticket, "timeoutMs": 10_000,
                }))).await;
                assert_eq!(waited.result.unwrap()["success"], json!(true));
            }

            let before = commands_named(&server, "SELECT").len();
            let pause = server.pause_command("SELECT");
            let held_state = Arc::clone(&state);
            let held = tokio::spawn(async move {
                boxed_request(&held_state, req("sync.probe", json!({
                    "op": "check", "accountId": "acc1", "mailbox": "INBOX",
                }))).await
            });
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(5)),
                    "A's real SELECT must enter before retirement");
                pause
            }).await.unwrap();
            // A real Closing claim waits for the route's finite operation;
            // this test revokes the original epoch at the held provider gate.
            state.account_lifecycle.apply_committed_membership(None,
                &mailvault_core::accounts_doc::MembershipDelta {
                    removed: ["acc1".to_owned()].into(), ..Default::default()
                });
            pause.release();
            let late = held.await.unwrap().result.unwrap();
            assert_eq!(late["unchanged"], json!(false));
            assert!(late.get("verificationRef").is_none());
            let b_check = boxed_request(&state, req("sync.probe", json!({
                "op": "check", "accountId": "acc2", "mailbox": "INBOX",
            }))).await.result.unwrap();
            assert_eq!(b_check["reason"], json!("modseq-match"));
            assert!(b_check["verificationRef"].as_str().is_some());
            assert_eq!(commands_named(&server, "SELECT").len() - before, 2,
                "A's held SELECT and B's independent SELECT both reached the provider");
        }

        fn refresh_cached_headers(state: &Arc<DaemonState>, account: &str, mailbox: &str) -> Option<Value> {
            let saved = crate::custody::with_conn(state, |conn| {
                mailvault_core::custody::cache::load_headers(
                    conn, account, mailbox, None, mailvault_core::custody::cache::HeaderOrder::Arrival,
                )
            }).unwrap();
            saved.map(|text| serde_json::from_str(&text).unwrap())
        }

        async fn seed_refresh_imap(state: &Arc<DaemonState>, account: Value) {
            let started = boxed_request(state, req("sync.now", json!({
                "account": account, "mailbox": "INBOX", "autoClassify": false,
            }))).await;
            let ticket = started.result.expect("existing sync.now must seed real native headers")
                ["ticket"].as_u64().expect("seed ticket");
            let finished = boxed_request(state, req("sync.wait", json!({
                "ticket": ticket, "timeoutMs": 10_000,
            }))).await;
            assert_eq!(finished.result.expect("seed wait must finish")["success"], json!(true));
            assert_eq!(refresh_cached_headers(state, "acc1", "INBOX").unwrap()["totalCached"], json!(1));
        }

        fn append_refresh_imap(server: &MockImap, subject: &str) {
            let raw = format!(
                "From: New Sender <new@example.test>\r\nTo: user@example.com\r\nSubject: {subject}\r\nDate: Thu, 01 Jan 2026 12:01:00 +0000\r\nMessage-ID: <native-refresh-2@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nActual mock provider arrival.\r\n"
            );
            server.mutate(|server_state| {
                server_state.find_mut("INBOX").expect("real mock INBOX")
                    .add(mock_imap::state::Message::new(2, raw).with_modseq(2));
            });
        }

        async fn terminal_refresh(state: &Arc<DaemonState>, request_id: &str) -> Value {
            for _ in 0..300 {
                let response = boxed_request(state, req("sync.refresh_status", json!({
                    "requestId": request_id,
                }))).await;
                assert!(response.error.is_none(), "refresh status must route: {:?}", response.error);
                let status = response.result.expect("refresh status body");
                assert_eq!(status["found"], json!(true), "accepted ID must remain observable: {status:?}");
                let rows = status["receipts"].as_array().expect("receipt array");
                assert_eq!(rows.len(), 1, "one receipt for one requested ID: {status:?}");
                if rows[0]["status"] == "complete" || rows[0]["status"] == "failed" {
                    return rows[0].clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            panic!("accepted native refresh did not reach terminal status");
        }

        #[tokio::test]
        async fn refresh_route_red_detached_imap_observer_keeps_real_header_work() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            append_refresh_imap(&server, "Native refresh after observer loss");
            let command_before = server.commands().len();
            let select_before = commands_named(&server, "SELECT").len();
            let status_before = refresh_status_selects(&server, "INBOX");
            let pause = server.pause_command("SELECT");

            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId": "imap-detached-1", "accountId": "acc1",
                "mailbox": "INBOX", "reason": "manual",
            }))).await;
            assert!(accepted.error.is_none(),
                "refresh route must ACK before held IMAP provider work: {:?}; real SELECT delta={}; new header present={}",
                accepted.error, commands_named(&server, "SELECT").len() - select_before,
                refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["emails"]
                    .as_array().unwrap().iter().any(|row| row["uid"] == 2));
            let ack = accepted.result.expect("refresh ACK");
            assert_eq!(ack["receipt"]["requestId"], json!("imap-detached-1"));
            assert!(ack["receipt"]["status"] == "queued" || ack["receipt"]["status"] == "running");
            assert!(ack["instanceId"].as_str().is_some_and(|id| !id.is_empty()));
            drop(ack);

            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(10)),
                    "accepted refresh must reach the real mock IMAP SELECT");
                pause
            }).await.unwrap();
            let observer = boxed_request(&state, req("sync.refresh_status", json!({
                "requestId": "imap-detached-1",
            }))).await;
            assert!(observer.error.is_none(), "status must answer during held provider IO: {:?}", observer.error);
            assert_eq!(observer.result.as_ref().unwrap()["receipts"][0]["status"], json!("running"));
            drop(observer);
            pause.release();

            let receipt = terminal_refresh(&state, "imap-detached-1").await;
            assert_eq!(receipt["status"], json!("complete"), "detached observer cannot cancel accepted work: {receipt:?}");
            assert_eq!(receipt["accountResults"][0]["success"], json!(true));
            assert_eq!(receipt["accountResults"][0]["mailbox"], json!("INBOX"));
            let cached = refresh_cached_headers(&state, "acc1", "INBOX").expect("real native headers");
            assert_eq!(cached["totalCached"], json!(2));
            assert!(cached["emails"].as_array().unwrap().iter().any(|row|
                row["uid"] == 2 && row["subject"] == "Native refresh after observer loss"),
                "new mock provider header must be persisted in INBOX: {cached:?}");
            assert_eq!(cached["nativeIdentity"]["accountId"], json!("acc1"));
            assert_eq!(cached["nativeIdentity"]["mailbox"], json!("INBOX"));
            assert_eq!(refresh_status_selects(&server, "INBOX") - status_before, 1,
                "detached observer leaves one CONDSTORE status observation; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
        }

        #[tokio::test]
        async fn refresh_route_red_duplicate_id_has_one_provider_and_header_effect() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            append_refresh_imap(&server, "One header for duplicate ID");
            let command_before = server.commands().len();
            let select_before = commands_named(&server, "SELECT").len();
            let status_before = refresh_status_selects(&server, "INBOX");
            let pause = server.pause_command("SELECT");
            let params = json!({
                "requestId": "imap-duplicate-1", "accountId": "acc1",
                "mailbox": "INBOX", "reason": "manual",
            });
            let first = boxed_request(&state, req("sync.refresh", params.clone())).await;
            assert!(first.error.is_none(),
                "duplicate refresh ID must join accepted native work: {:?}; real SELECT delta={}; new header present={}",
                first.error, commands_named(&server, "SELECT").len() - select_before,
                refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["emails"]
                    .as_array().unwrap().iter().any(|row| row["uid"] == 2));
            assert_eq!(first.result.as_ref().unwrap()["receipt"]["requestId"], json!("imap-duplicate-1"));
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(10)),
                    "first duplicate-ID request must reach a real SELECT");
                pause
            }).await.unwrap();
            let second = boxed_request(&state, req("sync.refresh", params.clone())).await;
            assert!(second.error.is_none(), "same in-flight request ID must be accepted: {:?}", second.error);
            assert_eq!(second.result.as_ref().unwrap()["receipt"]["requestId"], json!("imap-duplicate-1"));
            assert_eq!(second.result.as_ref().unwrap()["receipt"]["status"], json!("running"));
            pause.release();

            let settled = terminal_refresh(&state, "imap-duplicate-1").await;
            assert_eq!(settled["status"], json!("complete"));
            let cached = refresh_cached_headers(&state, "acc1", "INBOX").expect("native header after duplicate");
            assert_eq!(cached["totalCached"], json!(2));
            assert_eq!(cached["emails"].as_array().unwrap().iter().filter(|row|
                row["uid"] == 2 && row["subject"] == "One header for duplicate ID").count(), 1);
            assert_eq!(refresh_status_selects(&server, "INBOX") - status_before, 1,
                "identical request ID may issue one CONDSTORE status observation only; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
            let commands = server.commands();
            let replay = boxed_request(&state, req("sync.refresh", params)).await;
            assert!(replay.error.is_none(), "completed identical ID must replay receipt: {:?}", replay.error);
            assert_eq!(replay.result.as_ref().unwrap()["receipt"], settled,
                "terminal duplicate must preserve completion timestamp and result");
            assert_eq!(server.commands(), commands, "duplicate replay must issue zero provider commands");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX"), Some(cached),
                "duplicate replay must leave the actual native header effect unchanged");
        }

        #[tokio::test]
        async fn refresh_route_trailing_ids_share_one_pending_provider_pass() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            append_refresh_imap(&server, "Trailing original-bound observation");
            let command_before = server.commands().len();
            let before = commands_named(&server, "SELECT").len();
            let status_before = refresh_status_selects(&server, "INBOX");
            let pause = server.pause_command("SELECT");
            let request = |id: &str| json!({"requestId":id,"accountId":"acc1",
                "mailbox":"INBOX","reason":"manual"});
            let first = boxed_request(&state, req("sync.refresh", request("trail-first"))).await;
            assert!(first.error.is_none(), "{:?}", first.error);
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(10)));
                pause
            }).await.unwrap();
            for id in ["trail-second", "trail-third", "trail-second"] {
                let answer = boxed_request(&state, req("sync.refresh", request(id))).await;
                assert!(answer.error.is_none(), "{id}: {:?}", answer.error);
                assert_eq!(answer.result.unwrap()["receipt"]["status"], json!("queued"));
            }
            let status = boxed_request(&state, req("sync.refresh_status",
                json!({"requestId":"trail-first"}))).await.result.unwrap();
            assert_eq!(status["receipts"][0]["status"], json!("running"));
            assert_eq!(commands_named(&server, "SELECT").len() - before, 1,
                "held first observation must keep the trailing unit queued; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
            assert_eq!(refresh_status_selects(&server, "INBOX") - status_before, 1,
                "only the held first pass may issue a status observation; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
            pause.release();
            for id in ["trail-first", "trail-second", "trail-third"] {
                let receipt = terminal_refresh(&state, id).await;
                assert_eq!(receipt["status"], json!("complete"), "{id}: {receipt}");
            }
            assert_eq!(refresh_status_selects(&server, "INBOX") - status_before, 2,
                "two new IDs behind a running unit share one trailing status observation; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
        }

        #[tokio::test]
        async fn refresh_route_queued_original_rejects_changed_account_metadata() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            append_refresh_imap(&server, "Old source must not publish");
            let command_before = server.commands().len();
            let before = commands_named(&server, "SELECT").len();
            let status_before = refresh_status_selects(&server, "INBOX");
            let pause = server.pause_command("SELECT");
            let request = |id: &str| json!({"requestId":id,"accountId":"acc1",
                "mailbox":"INBOX","reason":"manual"});
            let first = boxed_request(&state, req("sync.refresh", request("old-running"))).await;
            assert!(first.error.is_none(), "{:?}", first.error);
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(10)));
                pause
            }).await.unwrap();
            let queued = boxed_request(&state, req("sync.refresh", request("old-queued"))).await;
            assert!(queued.error.is_none(), "{:?}", queued.error);
            assert_eq!(queued.result.unwrap()["receipt"]["status"], json!("queued"));
            let path = state.app_dir.join("accounts.json");
            let mut rows: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            rows[0]["imapHost"] = json!("127.0.0.2");
            std::fs::write(&path, rows.to_string()).unwrap();
            pause.release();
            let running = terminal_refresh(&state, "old-running").await;
            let queued = terminal_refresh(&state, "old-queued").await;
            assert_eq!(running["status"], json!("failed"), "held old source cannot publish: {running}");
            assert_eq!(queued["status"], json!("failed"), "queued old stamp cannot be recaptured: {queued}");
            assert_eq!(commands_named(&server, "SELECT").len() - before, 1,
                "queued old source must issue no second provider observation; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
            assert_eq!(refresh_status_selects(&server, "INBOX") - status_before, 1,
                "queued old source must issue no second status observation; SELECT/FETCH trace={:?}",
                refresh_provider_trace(&server, command_before));
            let cached = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(cached["totalCached"], json!(1));
            assert!(!cached["emails"].as_array().unwrap().iter().any(|row| row["uid"] == 2),
                "old source may not leave a new native header");
        }

        #[tokio::test]
        async fn refresh_route_duplicate_intent_conflict_and_unknown_status_are_explicit() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            state.seed_accounts_for_test(&[]);
            let first = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"same-intent", "reason":"manual",
            }))).await;
            assert!(first.error.is_none(), "{:?}", first.error);
            let conflict = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"same-intent", "reason":"scheduled",
            }))).await;
            assert_eq!(conflict.error.unwrap().code, ipc::INVALID_PARAMS);
            let missing = boxed_request(&state, req("sync.refresh_status", json!({
                "requestId":"never-admitted",
            }))).await.result.unwrap();
            assert_eq!(missing["found"], json!(false));
            assert_eq!(missing["receipts"], json!([]));
            let credential_shaped = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"forged", "reason":"manual", "password":"nope",
            }))).await;
            assert_eq!(credential_shaped.error.unwrap().code, ipc::INVALID_PARAMS);
        }

        fn bind_jmap_refresh(state: &Arc<DaemonState>, mock: &mock_jmap::MockJmap,
            imap_port: u16) -> crate::sync_engine::SyncAccount {
            let mut credential = crate::jmap_test_support::account_json(mock, imap_port);
            credential["id"] = json!("acc1");
            let mut listing = credential.clone();
            listing.as_object_mut().unwrap().remove("password");
            std::fs::write(state.app_dir.join("accounts.json"),
                json!([listing]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({"acc1": credential.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            crate::sync_engine::SyncAccount {
                id: "acc1".into(), email: "alice@example.test".into(),
                imap_config: serde_json::from_value(credential).unwrap(),
            }
        }

        fn jmap_refresh_scenario(count: usize) -> mock_jmap::Scenario {
            let mut scenario = crate::jmap_test_support::scenario();
            assert!(count >= 2);
            for n in 3..=count {
                scenario.accounts[0].mailboxes[0].emails.push(crate::jmap_test_support::email(
                    &format!("jmap-bulk-{n:03}"), &format!("bulk {n}"),
                    "2026-10-03T10:00:00Z"));
            }
            scenario
        }

        fn jmap_refresh_query_positions(mock: &mock_jmap::MockJmap) -> Vec<usize> {
            let mut positions = Vec::new();
            for request in mock.requests().into_iter().filter(|request| request.is_api()) {
                let body: Value = serde_json::from_str(&request.body).unwrap();
                for call in body["methodCalls"].as_array().unwrap() {
                    if call[0] == "Email/query" {
                        positions.push(call[1]["position"].as_u64().unwrap() as usize);
                    }
                }
            }
            positions
        }

        fn jmap_refresh_cache_count(state: &Arc<DaemonState>) -> usize {
            crate::custody::with_conn(state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap()
        }

        fn jmap_refresh_ledger(state: &Arc<DaemonState>) -> mailvault_core::graph_ledger::Ledger {
            let path = crate::jmap_sessions::jmap_ledger_path(
                state.sync_engine.data_dir(), "acc1", "INBOX");
            mailvault_core::graph_ledger::load(&path).unwrap()
        }

        #[tokio::test]
        async fn refresh_jmap_complete_pages_all_headers_with_stable_uid_and_no_imap_dial() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let _account = bind_jmap_refresh(&state, &mock, imap_port);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-501-first", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "JMAP Complete must ACK: {:?}", accepted.error);
            let first = terminal_refresh(&state, "jmap-complete-501-first").await;
            assert_eq!(first["status"], json!("complete"),
                "Complete must cover all 501 real mock JMAP headers: {first:?}");
            assert_eq!(first["accountResults"][0]["success"], json!(true));
            assert_eq!(jmap_refresh_cache_count(&state), 501,
                "Complete must write every actual JMAP header, including the old page");
            let identity = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::native_identity(conn, "acc1", "INBOX")
            ).unwrap().expect("JMAP Complete native owner");
            assert_eq!(identity.jmap_mailbox_id.as_deref(), Some("mb-inbox"));
            let ledger = jmap_refresh_ledger(&state);
            assert_eq!(ledger.len(), 501);
            assert!(ledger.values().any(|id| id == "e1"));
            assert!(ledger.values().any(|id| id == "jmap-bulk-501"));
            let positions = jmap_refresh_query_positions(&mock);
            assert!(positions.contains(&200) && positions.contains(&400),
                "Complete must request actual older 200-row pages: {positions:?}");
            let next = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-501-repeat", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(next.error.is_none(), "repeat Complete must ACK: {:?}", next.error);
            let repeated = terminal_refresh(&state, "jmap-complete-501-repeat").await;
            assert_eq!(repeated["status"], json!("complete"));
            assert_eq!(jmap_refresh_ledger(&state), ledger,
                "repeat JMAP listing may not remint native UIDs");
            assert!(trap.accept().is_err(), "JMAP Complete must never dial the IMAP trap");
        }

        #[tokio::test]
        async fn refresh_jmap_complete_failed_provider_page_keeps_partial_cache_incomplete() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            let seeded = state.sync_engine.sync_account(&account, "INBOX").await;
            assert!(seeded.success, "existing JMAP cold sync must seed 500: {:?}", seeded.error);
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            let before_ledger = jmap_refresh_ledger(&state);
            let before_query = mock.count_calls("Email/query");
            let before_get = mock.count_calls("Email/get");
            mock.mutate(|server| server.faults.push(mock_jmap::Fault::ServerFail {
                method: "Email/get".into(),
            }));
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-failed-page", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "failed-page Complete must ACK: {:?}", accepted.error);
            let settled = terminal_refresh(&state, "jmap-complete-failed-page").await;
            assert!(mock.count_calls("Email/query") > before_query
                && mock.count_calls("Email/get") > before_get,
                "Complete must reach a real JMAP page before its provider failure; queries={:?}",
                jmap_refresh_query_positions(&mock));
            assert_eq!(settled["status"], json!("failed"),
                "failed provider page cannot claim complete: {settled:?}");
            assert_eq!(settled["accountResults"][0]["success"], json!(false));
            assert_eq!(jmap_refresh_cache_count(&state), 500,
                "failed page may not erase the previously cached 500 headers");
            assert_eq!(jmap_refresh_ledger(&state), before_ledger,
                "failed first page may not remint the existing JMAP IDs");
            assert!(trap.accept().is_err(), "failed JMAP Complete must not dial IMAP");
        }

        #[tokio::test]
        async fn refresh_jmap_complete_short_provider_page_does_not_report_complete() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            let seeded = state.sync_engine.sync_account(&account, "INBOX").await;
            assert!(seeded.success, "existing JMAP cold sync must seed 500: {:?}", seeded.error);
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            let before_ledger = jmap_refresh_ledger(&state);
            let before_query = mock.count_calls("Email/query");
            mock.mutate(|server| server.limits.max_query_limit = 0);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-short-page", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "short-page Complete must ACK: {:?}", accepted.error);
            let settled = terminal_refresh(&state, "jmap-complete-short-page").await;
            assert!(mock.count_calls("Email/query") > before_query,
                "Complete must ask the real provider for the missing page: {:?}",
                jmap_refresh_query_positions(&mock));
            assert_eq!(settled["status"], json!("failed"),
                "an empty provider page with total 501 cannot claim complete: {settled:?}");
            assert_eq!(settled["accountResults"][0]["success"], json!(false));
            assert_eq!(jmap_refresh_cache_count(&state), 500,
                "a short page must preserve the earlier native header rows");
            assert_eq!(jmap_refresh_ledger(&state), before_ledger);
            assert!(trap.accept().is_err(), "short JMAP Complete must not dial IMAP");
        }

        #[tokio::test]
        async fn refresh_jmap_account_delta_publishes_each_touched_source_once() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(2));
            let (trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            for mailbox in ["INBOX", "Work"] {
                let seeded = state.sync_engine.sync_account(&account, mailbox).await;
                assert!(seeded.success, "initial {mailbox} cache: {:?}", seeded.error);
            }
            let gen0 = state.sync_engine.change_gen();
            let mut new = crate::jmap_test_support::email("e9", "account-wide delivery",
                "2026-10-04T10:00:00Z");
            new.also_in.push("mb-work".into());
            mock.mutate(|server| server.add_email("acc1", "mb-inbox", new));
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-touched-source", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "JMAP account delta must ACK: {:?}", accepted.error);
            let settled = terminal_refresh(&state, "jmap-touched-source").await;
            assert_eq!(settled["status"], json!("complete"), "JMAP delta must settle: {settled:?}");
            let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
            assert_eq!(records.len(), 2,
                "account delta must publish each touched mailbox once, without a second requested-folder event: {records:?}");
            let inbox = records.iter().find(|record| record.mailbox == "INBOX").unwrap();
            let work = records.iter().find(|record| record.mailbox == "Work").unwrap();
            assert_eq!(inbox.arrival_uids.len(), 1, "only the real INBOX delivery is an arrival");
            assert!(work.arrival_uids.is_empty(), "the second label is a repaint, not another arrival");
            for record in &records {
                let source = record.source.as_ref().expect("each touched JMAP event needs native source proof");
                assert_eq!(source.account_id, "acc1");
                assert_eq!(source.mailbox, record.mailbox);
                assert!(source.cache_owner.as_ref().is_some_and(|owner|
                    owner.jmap_mailbox_id.is_some()), "touched mailbox needs its real owner: {record:?}");
            }
            assert!(trap.accept().is_err(), "JMAP account delta must not dial IMAP");
        }

        async fn refresh_graph_map(state: &Arc<DaemonState>, account: &str) -> Option<Value> {
            let response = boxed_request(state, req("load_graph_id_map", json!({
                "accountId": account, "mailbox": "INBOX",
            }))).await;
            let value = response.result.expect("existing Graph ledger reader must answer");
            if value.is_null() { None } else {
                Some(serde_json::from_str(value.as_str().expect("ledger JSON string")).unwrap())
            }
        }

        fn refresh_graph_folder(id: &str, name: &str) -> Value {
            json!({"id": id, "displayName": name, "totalItemCount": 2, "unreadItemCount": 2})
        }

        fn refresh_graph_message(id: &str, subject: &str) -> Value {
            json!({
                "id": id, "subject": subject, "from": null, "toRecipients": null,
                "ccRecipients": null, "bccRecipients": null,
                "receivedDateTime": "2026-01-01T00:00:00Z", "sentDateTime": null,
                "isRead": false, "hasAttachments": false,
                "internetMessageId": format!("<{id}@example.test>"),
                "body": null, "internetMessageHeaders": null,
            })
        }

        #[tokio::test]
        async fn refresh_graph_adopted_page_reaches_provider_and_writes_stable_native_headers() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let row = json!({"id":"acc1", "email":"ready@example.test", "authType":"oauth2",
                "oauth2Provider":"microsoft", "oauth2Transport":"graph"});
            std::fs::write(state.app_dir.join("accounts.json"), json!([row.clone()]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let mut credential = row;
            credential["oauth2AccessToken"] = json!("synthetic-graph-ready");
            credential["oauth2ExpiresAt"] = json!(4_000_000_000_000i64);
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials,
                json!({"acc1": credential.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings": {"state": {
                    "graphFolderKeysAdopted": {"acc1": true},
                    "graphFolderKeysAdoptedFromListing": {"acc1": true},
                }},
            }), None).unwrap();
            let folders = json!({"value":[refresh_graph_folder("fld-ready-inbox", "Inbox")],
                "@odata.nextLink": null});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-ready-inbox"}}]});
            let page = json!({"value":[
                refresh_graph_message("ready-old", "Ready old"),
                refresh_graph_message("ready-new", "Ready new"),
            ], "@odata.nextLink": null});
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, folders.to_string()), (200, batch.to_string()), (200, page.to_string()),
            ]);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"graph-adopted-page", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "adopted Graph page must ACK: {:?}", accepted.error);
            let settled = terminal_refresh(&state, "graph-adopted-page").await;
            assert_eq!(settled["status"], json!("complete"),
                "adopted Graph RefreshPage must reach actual provider and write native headers: {settled:?}; requests={:?}",
                crate::handlers::graph::test_graph_requests().len());
            let ledger = refresh_graph_map(&state, "acc1").await.expect("stable Graph ledger");
            assert_eq!(ledger.as_object().unwrap().len(), 2);
            let cached = refresh_cached_headers(&state, "acc1", "INBOX")
                .expect("native Graph header cache");
            assert_eq!(cached["totalCached"], json!(2));
            assert_eq!(cached["nativeIdentity"]["accountId"], json!("acc1"));
            assert_eq!(cached["nativeIdentity"]["mailbox"], json!("INBOX"));
            let calls = crate::handlers::graph::test_graph_requests();
            assert_eq!(calls.len(), 3, "one folder/listing pass plus one Graph message page");
            assert!(calls[2].path.contains("fld-ready-inbox")
                && calls[2].path.contains("/messages?")
                && calls[2].path.contains("top=200")
                && calls[2].path.contains("skip=0"),
                "RefreshPage must use the actual first provider page: {:?}", calls[2].path);
        }

        #[tokio::test]
        async fn refresh_route_red_graph_adoption_blocks_a_while_b_keeps_stable_owned_headers() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let a = json!({"id":"acc1", "email":"a@example.test", "authType":"oauth2",
                "oauth2Provider":"microsoft", "oauth2Transport":"graph"});
            let b = json!({"id":"acc2", "email":"b@example.test", "authType":"oauth2",
                "oauth2Provider":"microsoft", "oauth2Transport":"graph"});
            std::fs::write(state.app_dir.join("accounts.json"), json!([a.clone(), b.clone()]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let mut a_credential = a.clone();
            a_credential["oauth2AccessToken"] = json!("synthetic-graph-a");
            a_credential["oauth2ExpiresAt"] = json!(4_000_000_000_000i64);
            let mut b_credential = b.clone();
            b_credential["oauth2AccessToken"] = json!("synthetic-graph-b");
            b_credential["oauth2ExpiresAt"] = json!(4_000_000_000_000i64);
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({
                "acc1": a_credential.to_string(), "acc2": b_credential.to_string(),
            }).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings": {"state": {
                    "graphFolderKeysAdopted": {"acc1": true, "acc2": true},
                    "graphFolderKeysAdoptedFromListing": {"acc2": true},
                }},
            }), None).unwrap();

            // A's Inbox display name is a real unacknowledged listing pair:
            // Posteingang -> INBOX. B is already acknowledged and can write.
            let a_list = json!({"value": [refresh_graph_folder("fld-a-inbox", "Posteingang")],
                "@odata.nextLink": null});
            let a_batch = json!({"responses": [{"id":"inbox", "status":200,
                "body":{"id":"fld-a-inbox"}}]});
            let b_list = json!({"value": [refresh_graph_folder("fld-b-inbox", "Inbox")],
                "@odata.nextLink": null});
            let b_batch = json!({"responses": [{"id":"inbox", "status":200,
                "body":{"id":"fld-b-inbox"}}]});
            let old = refresh_graph_message("graph-b-old", "Graph B old");
            let new = refresh_graph_message("graph-b-new", "Graph B new");
            let first_page = json!({"value": [old.clone(), new.clone()], "@odata.nextLink": null});
            let second_page = json!({"value": [new.clone(), old.clone()], "@odata.nextLink": null});
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, a_list.to_string()), (200, a_batch.to_string()),
                (200, b_list.to_string()), (200, b_batch.to_string()),
                (200, first_page.to_string()),
                (200, b_list.to_string()), (200, b_batch.to_string()),
                (200, second_page.to_string()),
            ]);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId": "graph-adoption-and-b-1", "mailbox": "INBOX", "reason": "manual",
            }))).await;
            assert!(accepted.error.is_none(),
                "Graph refresh must ACK adopted B before provider work: {:?}; Graph requests={}; B native header present={}",
                accepted.error, crate::handlers::graph::test_graph_requests().len(),
                refresh_cached_headers(&state, "acc2", "INBOX").is_some());
            assert_eq!(accepted.result.as_ref().unwrap()["receipt"]["requestId"],
                json!("graph-adoption-and-b-1"));
            let settled = terminal_refresh(&state, "graph-adoption-and-b-1").await;
            assert_eq!(settled["status"], json!("failed"),
                "A prerequisite must fail the overall receipt while B continues: {settled:?}");
            let results = settled["accountResults"].as_array().expect("A and B result array");
            assert_eq!(results.len(), 2);
            assert_eq!(results[0]["accountId"], json!("acc1"));
            assert_eq!(results[0]["success"], json!(false));
            assert_eq!(results[0]["errorKey"], json!("errors.syncGraphAdoptionRequired"),
                "unacknowledged Graph listing pair must report the typed shell prerequisite");
            assert_eq!(results[0]["needsShellAdoption"], json!(true));
            assert_eq!(results[1]["accountId"], json!("acc2"));
            assert_eq!(results[1]["success"], json!(true));
            assert_eq!(results[1]["mailbox"], json!("INBOX"));
            assert_eq!(refresh_graph_map(&state, "acc1").await, None,
                "unadopted A must not allocate a Graph UID ledger");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX"), None,
                "unadopted A must not write native headers");

            let before_map = refresh_graph_map(&state, "acc2").await
                .expect("adopted B must own a persistent UID ledger");
            assert_eq!(before_map.as_object().unwrap().len(), 2);
            let before_headers = refresh_cached_headers(&state, "acc2", "INBOX")
                .expect("adopted B must own native headers");
            assert_eq!(before_headers["totalCached"], json!(2));
            assert_eq!(before_headers["nativeIdentity"]["accountId"], json!("acc2"));
            assert_eq!(before_headers["nativeIdentity"]["mailbox"], json!("INBOX"));
            assert!(before_headers["nativeIdentity"]["originHash"].as_str()
                .is_some_and(|hash| !hash.is_empty()));
            for (uid, graph_id) in before_map.as_object().unwrap() {
                let uid: u64 = uid.parse().unwrap();
                let expected = if graph_id == "graph-b-old" { "Graph B old" }
                    else if graph_id == "graph-b-new" { "Graph B new" }
                    else { panic!("unexpected Graph ID in persistent ledger: {graph_id}") };
                assert!(before_headers["emails"].as_array().unwrap().iter().any(|row|
                    row["uid"] == json!(uid) && row["subject"] == expected),
                    "stable UID must name the actual Graph header: {before_headers:?}");
            }
            let next = boxed_request(&state, req("sync.refresh", json!({
                "requestId": "graph-b-reordered-2", "accountId": "acc2",
                "mailbox": "INBOX", "reason": "manual",
            }))).await;
            assert!(next.error.is_none(), "new adopted B request must ACK: {:?}", next.error);
            let next_receipt = terminal_refresh(&state, "graph-b-reordered-2").await;
            assert_eq!(next_receipt["status"], json!("complete"));
            assert_eq!(next_receipt["accountResults"][0]["success"], json!(true));
            assert_eq!(refresh_graph_map(&state, "acc2").await, Some(before_map.clone()),
                "reordered Graph page must retain B's minted UIDs");
            let after_headers = refresh_cached_headers(&state, "acc2", "INBOX").unwrap();
            assert_eq!(after_headers["nativeIdentity"], before_headers["nativeIdentity"]);
            for (uid, graph_id) in before_map.as_object().unwrap() {
                let uid: u64 = uid.parse().unwrap();
                let expected = if graph_id == "graph-b-old" { "Graph B old" } else { "Graph B new" };
                assert!(after_headers["emails"].as_array().unwrap().iter().any(|row|
                    row["uid"] == json!(uid) && row["subject"] == expected),
                    "reordered page must not turn position into identity: {after_headers:?}");
            }
            let seen = crate::handlers::graph::test_graph_requests();
            assert_eq!(seen.len(), 8, "A readiness and two B pages use actual Graph requests: {seen:?}");
            assert!(seen[0].path.contains("/me/mailFolders?") && seen[1].path.contains("/$batch"));
            assert_eq!(seen[0].headers.get("authorization").map(String::as_str),
                Some("Bearer synthetic-graph-a"));
            let message_calls: Vec<_> = seen.iter().filter(|call| call.path.contains("/messages?")).collect();
            assert_eq!(message_calls.len(), 2, "A must make no message request before adoption");
            assert!(message_calls.iter().all(|call|
                call.headers.get("authorization").map(String::as_str)
                    == Some("Bearer synthetic-graph-b")
                && call.path.contains("fld-b-inbox")));
        }
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
    /// whole socket path must stay under SUN_LEN (104 bytes) on unix. Also
    /// used on Windows as the state's `mail_dir`/`app_dir` — the pipe name
    /// itself (`sock_path` below) lives outside the filesystem, so it does
    /// not need this dir.
    fn sock_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// The endpoint `run` binds: a socket file under `dir` on unix, a
    /// uniquely-named pipe on Windows (never the fixed per-user name
    /// `transport::endpoint` derives — many `Served` instances run
    /// concurrently across the test binary and must not collide on one).
    #[cfg(unix)]
    fn sock_path(dir: &Path) -> PathBuf {
        dir.join("s.sock")
    }
    #[cfg(windows)]
    fn sock_path(_dir: &Path) -> PathBuf {
        PathBuf::from(format!(r"\\.\pipe\mailvault-test-{}", uuid::Uuid::new_v4()))
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
            let path = sock_path(&dir);
            let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
            let (s, p) = (Arc::clone(&state), path.clone());
            let task = tokio::spawn(async move {
                let _ = run(s, &p).await;
            });
            // `path.exists()` only works on unix (a Windows pipe name is not
            // a filesystem entry — see `transport::is_listening`'s own doc
            // comment); `is_listening` is the one check that is right on
            // both.
            for _ in 0..200 {
                if mailvault_core::transport::is_listening(&path) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(mailvault_core::transport::is_listening(&path), "server never bound {path:?}");
            Served { dir, path, state, task }
        }

        async fn connect(&self) -> (tokio::io::Lines<BufReader<ConnRead>>, ConnWrite) {
            #[cfg(unix)]
            let stream = tokio::net::UnixStream::connect(&self.path).await.unwrap();
            #[cfg(windows)]
            let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(&self.path).unwrap();
            let (r, w) = tokio::io::split(stream);
            (BufReader::new(r).lines(), w)
        }

        fn stop(self) {
            self.task.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn send(w: &mut ConnWrite, line: &str) {
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
    }

    async fn recv(lines: &mut tokio::io::Lines<BufReader<ConnRead>>) -> Value {
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

    /// The socket is on its own thread and its own runtime: a ping is answered
    /// even when the runtime that started the server cannot run a single task.
    /// `#[tokio::test]` is `current_thread`, so a plain `std::thread::sleep`
    /// in the test body parks it completely; the client is
    /// `mailvault_core::transport::connect_sync` on a plain thread — a
    /// blocking unix-socket or named-pipe handle, touching no runtime at all
    /// either way. Before `spawn_on_own_thread` this could only hang.
    #[tokio::test]
    async fn the_server_answers_while_the_runtime_that_started_it_is_parked() {
        use std::io::{BufRead, Write};

        let dir = sock_dir();
        let path = sock_path(&dir);
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let token = state.token.clone();
        super::spawn_on_own_thread(Arc::clone(&state), path.clone(), |why| panic!("server died: {why}")).unwrap();
        for _ in 0..200 {
            if mailvault_core::transport::is_listening(&path) { break }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(mailvault_core::transport::is_listening(&path), "server never bound {path:?}");

        let (tx, rx) = std::sync::mpsc::channel();
        let socket = path.clone();
        let client = std::thread::spawn(move || {
            let (read, mut write) =
                mailvault_core::transport::connect_sync(&socket, std::time::Duration::from_secs(5)).unwrap();
            let mut read = std::io::BufReader::new(read);
            writeln!(write, "{{\"token\":\"{token}\"}}").unwrap();
            let mut auth = String::new();
            read.read_line(&mut auth).unwrap();
            writeln!(write, "{{\"jsonrpc\":\"2.0\",\"method\":\"ping\",\"id\":1}}").unwrap();
            let mut reply = String::new();
            read.read_line(&mut reply).unwrap();
            tx.send((auth, reply)).unwrap();
        });

        // The starting runtime is now dead to the world for 300ms.
        std::thread::sleep(std::time::Duration::from_millis(300));

        let (auth, reply) = rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("the server must answer while the runtime that started it is parked");
        assert!(auth.contains("\"authenticated\":true"), "{auth}");
        assert!(reply.contains("\"pong\":true"), "{reply}");
        client.join().unwrap();
        // The server thread has no stop: it owns its runtime until the process
        // exits. Only its directory is ours to clean up.
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn s23_jmap_rpc_survives_default_stack() {
        const CHILD: &str = "MV_S23_DEFAULT_STACK_CHILD";
        const DIR: &str = "MV_S23_DEFAULT_STACK_DIR";
        if std::env::var_os(CHILD).is_none() {
            struct RemoveDir(PathBuf);
            impl Drop for RemoveDir {
                fn drop(&mut self) {
                    let _ = std::fs::remove_dir_all(&self.0);
                }
            }
            let dir = sock_dir();
            let _cleanup = RemoveDir(dir.clone());
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("server::tests::s23_jmap_rpc_survives_default_stack")
                .arg("--exact")
                .arg("--nocapture")
                .env(CHILD, "1")
                .env(DIR, &dir)
                .env_remove("RUST_MIN_STACK")
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "default-stack JMAP socket child exited: {status}");
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    child.kill().unwrap();
                    let _ = child.wait();
                    panic!("default-stack JMAP socket child did not finish");
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }

        use std::io::{BufRead, Write};
        assert!(std::env::var_os("RUST_MIN_STACK").is_none());
        let dir = PathBuf::from(std::env::var_os(DIR).expect("parent supplied private socket dir"));
        let path = sock_path(&dir);
        std::fs::write(
            dir.join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"fetchMode": "hoarder"}}}).to_string(),
        )
        .unwrap();
        let mock = mock_jmap::MockJmap::start(crate::jmap_test_support::scenario());
        let (imap_trap, imap_port) = crate::jmap_test_support::imap_trap();
        let account = crate::jmap_test_support::account_json(&mock, imap_port);
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        state.seed_accounts_for_test(&["acct1"]);
        let token = state.token.clone();
        spawn_on_own_thread(Arc::clone(&state), path.clone(), |why| panic!("server died: {why}"))
            .unwrap();
        for _ in 0..200 {
            if mailvault_core::transport::is_listening(&path) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(mailvault_core::transport::is_listening(&path), "server did not bind");
        let (read, mut write) = mailvault_core::transport::connect_sync(
            &path,
            std::time::Duration::from_secs(10),
        )
        .unwrap();
        let mut read = std::io::BufReader::new(read);
        let mut line = String::new();
        writeln!(write, "{}", json!({"token": token})).unwrap();
        read.read_line(&mut line).unwrap();
        let auth: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(auth["result"]["authenticated"], true);

        let mut call = |method: &str, params: Value| -> Value {
            line.clear();
            writeln!(write, "{}", json!({"jsonrpc": "2.0", "method": method, "params": params, "id": 1})).unwrap();
            assert!(read.read_line(&mut line).unwrap() > 0, "socket closed before {method} reply");
            let response: Value = serde_json::from_str(&line).unwrap();
            assert!(response["error"].is_null(), "{method} returned an RPC error");
            response["result"].clone()
        };

        eprintln!("s23-stage=mailboxes");
        let mailboxes = call("imap_get_mailboxes", json!({"account": account}));
        assert_eq!(mailboxes["success"], true);
        assert!(mailboxes["mailboxes"].as_array().unwrap().iter().any(|m| m["path"] == "INBOX"));
        eprintln!("s23-stage=headers");
        let listing = call("imap_get_emails", json!({"account": account, "mailbox": "INBOX", "page": 1, "limit": 50}));
        assert_eq!(listing["success"], true);
        let uid = listing["emails"].as_array().unwrap().iter()
            .find(|e| e["messageId"] == "<e1@x>")
            .and_then(|e| e["uid"].as_u64())
            .expect("fixture header was listed");
        eprintln!("s23-stage=body");
        let body = call("imap_get_email_light", json!({"account": account, "mailbox": "INBOX", "uid": uid}));
        assert_eq!(body["success"], true);
        assert_eq!(body["email"]["subject"], "one");
        assert_eq!(body["email"]["messageId"], "<e1@x>");
        assert_eq!(body["email"]["uid"], uid);
        assert!(body["email"]["text"].as_str().unwrap().contains("body of one"));
        eprintln!("s23-stage=ping");
        assert_eq!(call("ping", json!({}))["pong"], true);
        assert!(mock.count_calls("Mailbox/get") > 0);
        assert!(mock.count_calls("Email/query") > 0);
        assert!(mock.count_calls("Email/get") > 0);
        assert!(imap_trap.accept().is_err(), "JMAP request dialled IMAP");
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

        // Windows has no AddrInUse-shaped error for this collision: a named
        // pipe's `FILE_FLAG_FIRST_PIPE_INSTANCE` (this crate's `run` always
        // sets it — see its own doc comment) makes `CreateNamedPipe` fail
        // with ERROR_ACCESS_DENIED when an instance under that name already
        // exists, which std maps to `PermissionDenied`, not `AddrInUse`.
        // Nothing downstream branches on the specific kind (grepped: no
        // caller of `run()` checks for `AddrInUse`), so this is a real OS
        // difference in wording, not a behavior gap — the second daemon is
        // refused either way.
        let expected = if cfg!(windows) { std::io::ErrorKind::PermissionDenied } else { std::io::ErrorKind::AddrInUse };
        assert_eq!(err.kind(), expected);
        let _ = std::fs::remove_dir_all(&other);
        served.stop();
    }

    // ── channel.open ─────────────────────────────────────────────────

    async fn open_channel(served: &Served) -> (tokio::io::Lines<BufReader<ConnRead>>, ConnWrite) {
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
