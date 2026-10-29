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
                let sync_owner = match req.params.get("syncOwner") {
                    None => None,
                    Some(value) => {
                        let Some((launch_id, revision)) = crate::handlers::refresh::sync_owner(value) else {
                            let mut buf = serde_json::to_vec(&RpcResponse::error(req.id.unwrap_or(Value::Null),
                                ipc::INVALID_PARAMS, "errors.accountsInvalid")).unwrap_or_default();
                            buf.push(b'\n');
                            writer.write_all(&buf).await?;
                            continue;
                        };
                        let Some(owner) = crate::refresh_worker::RefreshState::attach_owner(
                            &state, launch_id, revision) else {
                            let mut buf = serde_json::to_vec(&RpcResponse::error(req.id.unwrap_or(Value::Null),
                                ipc::INVALID_PARAMS, "errors.accountsInvalid")).unwrap_or_default();
                            buf.push(b'\n');
                            writer.write_all(&buf).await?;
                            continue;
                        };
                        Some(owner)
                    }
                };
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
                return crate::channel::run(Arc::clone(&state), rx, lines, writer, sync_owner).await;
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
            | "counts.unread"
            | "sync.refresh"
            | "sync.refresh_status"
            | "sync.context"
            | "pipeline.focus"
            | "pipeline.status"
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
        "counts.unread" => crate::handlers::counts::route(state, req.params, id).await,
        "sync.refresh" | "sync.refresh_status" | "sync.context" => crate::handlers::refresh::route(state, &req.method, req.params, id).await,
        "pipeline.focus" | "pipeline.status" => crate::handlers::pipeline::route(state, &req.method, req.params, id).await,

        // ── IDLE watchers + the change feed they push into ──────────
        "sync.watch" => handle_sync_watch(Arc::clone(state), req.params, id).await,
        "sync.unwatch" => handle_sync_unwatch(Arc::clone(state), req.params, id).await,
        "sync.events" => handle_sync_events(Arc::clone(state), req.params, id).await,
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
    Box::pin(handle_request(state, RpcRequest { method: method.into(), params, id: Some(serde_json::json!(1)) })).await
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
        async fn s3_counts_unread_route_recounts_owned_cache_with_persisted_local_snooze() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let accounts = json!([
                {"id":"acc1","email":"one@example.test","authType":"password",
                 "imapHost":server.host(),"imapPort":server.port(),"imapSecure":false},
                {"id":"acc2","email":"two@example.test","authType":"password",
                 "imapHost":server.host(),"imapPort":server.port(),"imapSecure":false}
            ]);
            std::fs::write(state.app_dir.join("accounts.json"), accounts.to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let original = state.account_lifecycle.capture("acc1").unwrap();
            let origin = crate::sync_observation::origin(&state, original).await.unwrap();
            let owner = json!({
                "accountId":"acc1","mailbox":"INBOX","uidValidity":1,"originHash":origin.hash
            });
            crate::custody::with_conn(&state, |conn| {
                mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX", &json!({
                    "emails":[
                        {"uid":1,"flags":[],"messageId":"<synthetic-1@example.com>"},
                        {"uid":2,"flags":[],"messageId":"<synthetic-2@example.com>"},
                        {"uid":3,"flags":["\\Seen"],"messageId":"<synthetic-3@example.com>"}
                    ],
                    "totalEmails":3,"syncTotalEmails":3,"syncUidNext":4,
                    "nativeIdentity":owner.clone(),"nativeExpectedIdentity":null
                }).to_string())
            }).unwrap();
            mailvault_core::app_db::with(&state.app_dir, |conn|
                mailvault_core::app_db::snooze::insert(conn, "local-snooze", "acc1", "INBOX", "",
                    None, "<synthetic-2@example.com>", 4_000_000_000_000)
            ).unwrap();
            let before_cache = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(before_cache["totalCached"], json!(3), "seeded cache must be complete");
            assert_eq!(before_cache["nativeIdentity"]["originHash"], owner["originHash"]);
            let before_snoozes = mailvault_core::app_db::with(&state.app_dir, |conn|
                mailvault_core::app_db::snooze::list(conn, Some("acc1"))).unwrap();
            let settings_path = mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).path();
            let before_settings = std::fs::read(&settings_path).ok();
            let before_commands = server.commands();

            let answer = boxed_request(&state, req("counts.unread", json!({
                "op":"recountCache", "accountId":"acc1",
                "baseline":{"acc1":9,"acc2":5},
                "presentation":{
                    "accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}],
                    "hiddenAccounts":{},"displayNames":{},"accountOrder":["acc1","acc2"]
                },
                "projection":{
                    "archivedKeys":[],"deleteTombstones":[],"autoTagRules":[],
                    "tagsByRow":{},"viewHiddenKeys":[],"hideViewMail":false,"followUps":[]
                }
            }))).await;
            assert!(answer.error.is_none(), "W4S3_ROUTE_RED counts.unread must dispatch: {:?}", answer.error);
            let result = answer.result.expect("counts.unread needs a result");
            assert_eq!(result["counts"], json!({"acc1":1,"acc2":5}));
            assert_eq!(result["rows"], json!([
                {"id":"acc1","label":"One","unread":1},
                {"id":"acc2","label":"Two","unread":5}
            ]));
            assert_eq!(result["total"], json!(6));
            assert_eq!(result["wrote"], json!(true));

            let explicit_empty = boxed_request(&state, req("counts.unread", json!({
                "op":"recountCache", "accountId":"acc1",
                "baseline":{"acc1":9,"acc2":5},
                "presentation":{
                    "accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}],
                    "hiddenAccounts":{},"displayNames":{},"accountOrder":["acc1","acc2"]
                },
                "projection":{
                    "archivedKeys":[],"deleteTombstones":[],"autoTagRules":[],
                    "tagsByRow":{},"viewHiddenKeys":[],"hideViewMail":false,
                    "followUps":[],"snoozes":[]
                }
            }))).await;
            assert!(explicit_empty.error.is_none(), "explicit empty snooze snapshot must dispatch: {:?}", explicit_empty.error);
            let explicit_empty = explicit_empty.result.unwrap();
            assert_eq!(explicit_empty["counts"], json!({"acc1":2,"acc2":5}),
                "an explicit empty transient snapshot overrides the persisted local snooze");
            assert_eq!(explicit_empty["total"], json!(7));
            assert_eq!(explicit_empty["wrote"], json!(true));
            mailvault_core::app_db::with(&state.app_dir, |conn| {
                let key=mailvault_core::app_db::identity::msg_key(
                    Some("<synthetic-1@example.com>"),"INBOX",1);
                conn.execute("INSERT INTO tags(id,name,color,created_at) VALUES ('hide-tag','Hidden','',1)", [])
                    .map_err(|e|e.to_string())?;
                conn.execute("INSERT INTO auto_tag_rules(id,name,instruction,constraints,tag_id,inbox_action,min_confidence,enabled,created_at,updated_at) VALUES ('rule','Hide','','{}','hide-tag','hide',0.5,1,1,1)", [])
                    .map_err(|e|e.to_string())?;
                conn.execute("INSERT INTO tag_assignments(tag_id,account_id,msg_key,at) VALUES (?1,?2,?3,1)",
                    rusqlite::params!["hide-tag","acc1",key]).map_err(|e|e.to_string())?;
                conn.execute("INSERT INTO follow_ups(id,account_id,message_id,sent_at,remind_at,created_at,state,sent_mailbox,sent_uid) VALUES ('due','acc1','<sent@example.com>',1,1,1,'due','Sent',42)", [])
                    .map_err(|e|e.to_string())?;
                Ok(())
            }).unwrap();
            let tag_fallback=boxed_request(&state,req("counts.unread",json!({
                "op":"recountCache","accountId":"acc1","baseline":{"acc1":9,"acc2":5},
                "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                    "viewHiddenKeys":[],"hideViewMail":false,"followUps":[]}
            }))).await;
            assert!(tag_fallback.error.is_none(),"omitted tag categories must read persisted predicates: {:?}",tag_fallback.error);
            assert_eq!(tag_fallback.result.unwrap()["counts"],json!({"acc1":1,"acc2":5}),
                "persisted hidden tag removes only its assigned INBOX row");
            let reminder_fallback=boxed_request(&state,req("counts.unread",json!({
                "op":"recountCache","accountId":"acc1","baseline":{"acc1":9,"acc2":5},
                "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                    "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],"hideViewMail":false}
            }))).await;
            assert!(reminder_fallback.error.is_none(),"omitted reminders must read persisted predicates: {:?}",reminder_fallback.error);
            assert_eq!(reminder_fallback.result.unwrap()["counts"],json!({"acc1":3,"acc2":5}),
                "a persisted due unread reminder adds one without reading its subject");
            for extra in [
                json!({"password":"not-a-count-field"}),
                json!({"accountEmail":"not-a-count-field"}),
                json!({"unknown":"not-a-count-field"}),
            ] {
                let mut params = json!({"op":"recountCache","accountId":"acc1",
                    "baseline":{"acc1":9,"acc2":5},"projection":{"snoozes":[]}});
                params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
                let denied = boxed_request(&state, req("counts.unread", params)).await;
                assert!(denied.result.is_none() && denied.error.is_some(),
                    "unknown or credential-shaped count fields must fail before OAuth injection");
            }
            for invalid in [
                json!({"op":"unknown","baseline":{"acc1":9}}),
                json!({"op":"rows","baseline":{"acc1":9},"accountId":"acc1"}),
                json!({"op":"shift","baseline":{"acc1":9},"entries":[],"sign":1,"mode":"unknown"}),
            ] {
                let denied=boxed_request(&state,req("counts.unread",invalid)).await;
                assert!(denied.result.is_none() && denied.error.is_some(),
                    "unknown operation variants and cross-variant fields must fail strictly");
            }
            assert_eq!(server.commands(), before_commands, "unread route may not dial IMAP");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX"), Some(before_cache));
            assert_eq!(mailvault_core::app_db::with(&state.app_dir, |conn|
                mailvault_core::app_db::snooze::list(conn, Some("acc1"))).unwrap(), before_snoozes);
            assert_eq!(std::fs::read(&settings_path).ok(), before_settings,
                "unread route may not replace settings");

            // Keep the same native owner, but make its INBOX coverage partial.
            // The actual route, not a renderer double, must distinguish an
            // additive fallback from an unavailable no-write answer.
            crate::custody::with_conn(&state, |conn| {
                mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX", &json!({
                    "emails":[
                        {"uid":1,"flags":[],"messageId":"<synthetic-1@example.com>"},
                        {"uid":2,"flags":[],"messageId":"<synthetic-2@example.com>"},
                        {"uid":3,"flags":["\\Seen"],"messageId":"<synthetic-3@example.com>"}
                    ],
                    "totalEmails":500,"nativeIdentity":owner.clone(),"nativeExpectedIdentity":null
                }).to_string())
            }).unwrap();
            let partial_params=|arrival:Option<i64>| {
                let mut params=json!({
                    "op":"recountCache","accountId":"acc1","baseline":{"acc1":9,"acc2":5},
                    "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                    "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                        "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],
                        "hideViewMail":false,"followUps":[]}
                });
                if let Some(n)=arrival { params["arrivalCount"]=json!(n); }
                params
            };
            let fallback=boxed_request(&state,req("counts.unread",partial_params(Some(2)))).await;
            assert!(fallback.error.is_none(),"partial fallback must dispatch: {:?}",fallback.error);
            let fallback=fallback.result.unwrap();
            assert_eq!(fallback["counts"],json!({"acc1":11,"acc2":5}));
            assert_eq!(fallback["wrote"],json!(true));
            let unavailable=boxed_request(&state,req("counts.unread",partial_params(None))).await;
            assert!(unavailable.error.is_none(),"partial no-fallback must dispatch: {:?}",unavailable.error);
            let unavailable=unavailable.result.unwrap();
            assert_eq!(unavailable["counts"],json!({"acc1":9,"acc2":5}));
            assert_eq!(unavailable["wrote"],json!(false));
            assert_eq!(server.commands(),before_commands,"count paths must not dial IMAP");
            assert_eq!(json!({
                "complete":result["recountSource"],
                "explicitComplete":explicit_empty["recountSource"],
                "arrivalFallback":fallback["recountSource"],
                "none":unavailable["recountSource"]
            }),json!({
                "complete":"complete","explicitComplete":"complete",
                "arrivalFallback":"arrivalFallback","none":"none"
            }),"W4S3_RECOUNT_SOURCE_RED actual serialized paths must distinguish complete, fallback and no-write");
        }

        #[tokio::test]
        async fn s3_counts_unread_rejects_a_replaced_inbox_owner_after_a_held_read() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 0)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = json!({"id":"acc1","email":"one@example.test","authType":"password",
                "imapHost":server.host(),"imapPort":server.port(),"imapSecure":false});
            std::fs::write(state.app_dir.join("accounts.json"), json!([account]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let original=state.account_lifecycle.capture("acc1").unwrap();
            let origin=crate::sync_observation::origin(&state,original).await.unwrap();
            let owner=json!({"accountId":"acc1","mailbox":"INBOX","uidValidity":1,
                "originHash":origin.hash});
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(conn,
                "acc1","INBOX",&json!({"emails":[{"uid":1,"flags":[]}],"totalEmails":1,
                    "nativeIdentity":owner,"nativeExpectedIdentity":null}).to_string())).unwrap();
            let (entered,release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let running=Arc::clone(&state);
            let request=tokio::spawn(async move { boxed_request(&running,req("counts.unread",json!({
                "op":"recountCache","accountId":"acc1","baseline":{"acc1":9,"acc2":5},
                "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                    "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],"hideViewMail":false,"followUps":[]}
            }))).await });
            tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(5)))
                .await.unwrap().expect("real cache read must reach the held boundary");
            let next_owner=json!({"accountId":"acc1","mailbox":"INBOX","uidValidity":2,
                "originHash":origin.hash});
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(conn,
                "acc1","INBOX",&json!({"emails":[{"uid":1,"flags":[]}],"totalEmails":1,
                    "nativeIdentity":next_owner,"nativeExpectedIdentity":owner}).to_string())).unwrap();
            release.send(()).unwrap();
            let answer=request.await.unwrap();
            assert!(answer.result.is_none() && answer.error.is_some(),
                "a replaced native cache owner cannot return the old count as current");
            let (entered,release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let running=Arc::clone(&state);
            let source_request=tokio::spawn(async move { boxed_request(&running,req("counts.unread",json!({
                "op":"recountCache","accountId":"acc1","baseline":{"acc1":9,"acc2":5},
                "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                    "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],"hideViewMail":false,"followUps":[]}
            }))).await });
            tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(5)))
                .await.unwrap().expect("second actual cache read must reach the held boundary");
            let mut replaced:serde_json::Value=serde_json::from_slice(
                &std::fs::read(state.app_dir.join("accounts.json")).unwrap()).unwrap();
            replaced[0]["imapHost"]=json!("other.example.test");
            std::fs::write(state.app_dir.join("accounts.json"),replaced.to_string()).unwrap();
            release.send(()).unwrap();
            let answer=source_request.await.unwrap();
            assert!(answer.result.is_none() && answer.error.is_some(),
                "a changed authoritative account source cannot receive an old cache count");
            assert!(server.commands().is_empty(),"read-only unread request may not dial IMAP");
        }

        #[tokio::test]
        async fn s3_counts_unread_accepts_graph_and_jmap_ids_without_credentials_or_provider_calls() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            let accounts=json!([
                {"id":"graph","email":"graph@example.test","authType":"oauth2",
                    "oauth2Provider":"microsoft","oauth2Transport":"graph"},
                {"id":"jmap","email":"jmap@example.test","authType":"password",
                    "imapHost":"127.0.0.1","imapPort":9,"jmapSessionUrl":"http://127.0.0.1:9/session",
                    "jmapAuth":"basic"}
            ]);
            std::fs::write(state.app_dir.join("accounts.json"),accounts.to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            for account in ["graph","jmap"] {
                let answer=boxed_request(&state,req("counts.unread",json!({
                    "op":"recountRows","accountId":account,"cache":{"emails":[],"totalEmails":0},
                    "baseline":{"graph":4,"jmap":5},
                    "presentation":{"accounts":[{"id":"graph","name":"Graph"},{"id":"jmap","name":"JMAP"}]},
                    "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                        "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],
                        "hideViewMail":false,"followUps":[]}
                }))).await;
                assert!(answer.error.is_none(),"{account} local count may not require a token: {:?}",answer.error);
                let result=answer.result.unwrap();
                assert_eq!(result["counts"][account],json!(0));
                assert_eq!(result["wrote"],json!(true));
            }
        }

        fn s3_bounded_read_request() -> crate::ipc::RpcRequest {
            req("counts.unread", json!({
                "op":"recountCache","accountId":"acc1","baseline":{"acc1":9,"acc2":5},
                "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                    "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],
                    "hideViewMail":false,"followUps":[]}
            }))
        }

        fn s3_seed_account(state: &Arc<DaemonState>) {
            let account=json!({"id":"acc1","email":"one@example.test","authType":"password",
                "imapHost":"127.0.0.1","imapPort":143,"imapSecure":false});
            std::fs::write(state.app_dir.join("accounts.json"),json!([account]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
        }

        #[tokio::test]
        async fn s3_counts_unread_closed_custody_refuses_without_publishing_a_count() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            s3_seed_account(&state);
            crate::custody::close(&state);
            let answer=boxed_request(&state,s3_bounded_read_request()).await;
            assert!(answer.result.is_none() && answer.error.is_some(),
                "closed custody must not turn an unknown cache into a zero count: {answer:?}");
        }

        #[tokio::test]
        async fn s3_counts_unread_unreadable_settings_refuses_without_publishing_a_count() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            s3_seed_account(&state);
            let settings_path=mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).path();
            assert!(!settings_path.exists(),"fixture starts without a settings document");
            std::fs::create_dir(&settings_path).unwrap();
            let answer=boxed_request(&state,req("counts.unread",json!({
                "op":"rows","baseline":{"acc1":9,"acc2":5}
            }))).await;
            assert!(answer.result.is_none() && answer.error.is_some(),
                "unreadable presentation settings cannot authorize a count projection: {answer:?}");
        }

        #[tokio::test]
        async fn s3_counts_unread_recovers_once_after_same_owner_generation_fence() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            s3_seed_account(&state);
            let original=state.account_lifecycle.capture("acc1").unwrap();
            let origin=crate::sync_observation::origin(&state,original).await.unwrap();
            let owner=json!({"accountId":"acc1","mailbox":"INBOX","uidValidity":1,
                "originHash":origin.hash});
            let rows:Vec<Value>=(1..=513).map(|uid|json!({"uid":uid,"flags":[],
                "messageId":format!("<s3-{uid}@example.test>")})).collect();
            let seed=json!({"emails":rows,"totalEmails":513,"nativeIdentity":owner,
                "nativeExpectedIdentity":null});
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                conn,"acc1","INBOX",&seed.to_string())).unwrap();
            let first_generation=crate::custody::generation(&state);
            let first_owner=crate::custody::with_conn(&state,|conn|
                mailvault_core::custody::cache::native_identity(conn,"acc1","INBOX")).unwrap();
            let (entered,release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let running=Arc::clone(&state);
            let pending=tokio::spawn(async move { boxed_request(&running,s3_bounded_read_request()).await });
            tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(5)))
                .await.unwrap().expect("the original-bound count must reach its first metadata sample");
            let mut current=seed.clone();
            current["emails"][0]["flags"]=json!(["\\Seen"]);
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                conn,"acc1","INBOX",&current.to_string())).unwrap();
            assert!(crate::custody::generation(&state)>first_generation);
            assert_eq!(crate::custody::with_conn(&state,|conn|
                mailvault_core::custody::cache::native_identity(conn,"acc1","INBOX")).unwrap(),
                first_owner,"only the cache generation changed, not its original owner");
            release.send(()).unwrap();
            let answer=pending.await.unwrap();
            assert!(answer.error.is_none(),
                "W4S3_COUNT_RECOVERY_RED one same-owner generation fence must reread under its original source: {answer:?}");
            let result=answer.result.unwrap();
            assert_eq!(result["counts"],json!({"acc1":512,"acc2":5}),
                "W4S3_COUNT_RECOVERY_RED the current cache and unaffected B must publish together");
            assert_eq!(result["wrote"],json!(true));
            assert_eq!(result["recountSource"],json!("complete"));
        }

        #[tokio::test]
        async fn s3_counts_unread_same_owner_generation_change_refuses_mixed_pages_and_keeps_foreground_live() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            s3_seed_account(&state);
            let original=state.account_lifecycle.capture("acc1").unwrap();
            let origin=crate::sync_observation::origin(&state,original).await.unwrap();
            let owner=json!({"accountId":"acc1","mailbox":"INBOX","uidValidity":1,
                "originHash":origin.hash});
            let rows: Vec<Value>=(1..=513).map(|uid|json!({"uid":uid,"flags":[],
                "messageId":format!("<s3-{uid}@example.test>")})).collect();
            let seed=json!({"emails":rows,"totalEmails":513,"nativeIdentity":owner,
                "nativeExpectedIdentity":null}).to_string();
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                conn,"acc1","INBOX",&seed)).unwrap();
            let before_generation=crate::custody::generation(&state);
            let (entered,release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let running=Arc::clone(&state);
            let pending=tokio::spawn(async move { boxed_request(&running,s3_bounded_read_request()).await });
            tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(5)))
                .await.unwrap().expect("actual cache read must hold after its first metadata sample");
            let foreground=tokio::time::timeout(std::time::Duration::from_secs(2),
                boxed_request(&state,req("accounts.list",json!({})))).await;
            let original_owner=crate::custody::with_conn(&state,|conn|
                mailvault_core::custody::cache::native_identity(conn,"acc1","INBOX")).unwrap();
            let (second_entered,second_release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let mut once:Value=serde_json::from_str(&seed).unwrap();
            once["emails"][0]["flags"]=json!(["\\Seen"]);
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                conn,"acc1","INBOX",&once.to_string())).unwrap();
            let after_generation=crate::custody::generation(&state);
            let same_owner=crate::custody::with_conn(&state,|conn|
                mailvault_core::custody::cache::native_identity(conn,"acc1","INBOX")).unwrap();
            release.send(()).unwrap();
            let second=tokio::task::spawn_blocking(move ||
                second_entered.recv_timeout(std::time::Duration::from_secs(5))).await.unwrap();
            if second.is_err() {
                crate::handlers::counts::clear_pending_cache_read_for_test();
                panic!("W4S3_COUNT_BOUNDED_RED a first generation refusal must try exactly one fresh original-bound read");
            }
            let mut twice=once;
            twice["emails"][1]["flags"]=json!(["\\Seen"]);
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                conn,"acc1","INBOX",&twice.to_string())).unwrap();
            assert!(crate::custody::generation(&state)>after_generation,
                "a second same-owner generation change reaches the bounded retry");
            second_release.send(()).unwrap();
            let answer=pending.await.unwrap();
            assert!(foreground.is_ok_and(|reply|reply.error.is_none()),
                "foreground accounts.list must finish while a count cache read is held");
            assert!(after_generation>before_generation,"same-owner cache rewrite must advance custody generation");
            assert_eq!(same_owner,original_owner,"this race changes generation, not native owner");
            if let Some(result)=answer.result {
                assert_eq!(result["counts"],json!({"acc1":9,"acc2":5}),
                    "two changing generations must keep A baseline and B continuity");
                assert_eq!(result["wrote"],json!(false),
                    "a twice mixed bounded read cannot authorize a current count");
            } else {
                assert!(answer.error.is_some(),"the second invalidated read needs an explicit refusal");
            }
        }

        #[tokio::test]
        async fn s3_counts_unread_retry_refuses_second_read_owner_or_original_retirement() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            for retire_original in [false,true] {
                let dir=tempfile::tempdir().unwrap();
                let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
                s3_seed_account(&state);
                let original=state.account_lifecycle.capture("acc1").unwrap();
                let origin=crate::sync_observation::origin(&state,original).await.unwrap();
                let owner=json!({"accountId":"acc1","mailbox":"INBOX","uidValidity":1,
                    "originHash":origin.hash});
                let rows:Vec<Value>=(1..=513).map(|uid|json!({"uid":uid,"flags":[],
                    "messageId":format!("<s3-{uid}@example.test>")})).collect();
                let seed=json!({"emails":rows,"totalEmails":513,"nativeIdentity":owner,
                    "nativeExpectedIdentity":null});
                crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                    conn,"acc1","INBOX",&seed.to_string())).unwrap();
                let (first_entered,first_release)=crate::handlers::counts::pause_next_cache_read_for_test();
                let running=Arc::clone(&state);
                let pending=tokio::spawn(async move { boxed_request(&running,s3_bounded_read_request()).await });
                tokio::task::spawn_blocking(move || first_entered.recv_timeout(std::time::Duration::from_secs(5)))
                    .await.unwrap().expect("first original-bound read must hold");
                let (second_entered,second_release)=crate::handlers::counts::pause_next_cache_read_for_test();
                let mut changed=seed.clone();
                changed["emails"][0]["flags"]=json!(["\\Seen"]);
                crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                    conn,"acc1","INBOX",&changed.to_string())).unwrap();
                first_release.send(()).unwrap();
                let second=tokio::task::spawn_blocking(move ||
                    second_entered.recv_timeout(std::time::Duration::from_secs(5))).await.unwrap();
                if second.is_err() {
                    crate::handlers::counts::clear_pending_cache_read_for_test();
                    panic!("same-owner generation change must enter the single retry before replacement");
                }
                if retire_original {
                    state.account_lifecycle.apply_committed_membership(None,
                        &mailvault_core::accounts_doc::MembershipDelta {
                            removed:["acc1".to_owned()].into(),..Default::default()
                        });
                } else {
                    // A replacement is a CAS write against the owner the held
                    // count read saw, not a write with no expected identity.
                    changed["nativeExpectedIdentity"]=changed["nativeIdentity"].clone();
                    changed["nativeIdentity"]["uidValidity"]=json!(2);
                    crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                        conn,"acc1","INBOX",&changed.to_string())).unwrap();
                }
                second_release.send(()).unwrap();
                let answer=pending.await.unwrap();
                if let Some(result)=answer.result {
                    assert_eq!(result["counts"],json!({"acc1":9,"acc2":5}),
                        "a changed retry owner/original cannot overwrite A or surviving B");
                    assert_eq!(result["wrote"],json!(false));
                } else {
                    assert!(answer.error.is_some(),
                        "a changed retry owner/original must explicitly refuse: {answer:?}");
                }
            }
        }

        #[tokio::test]
        async fn s3_counts_unread_retired_original_during_held_cache_read_cannot_publish() {
            let _serial=crate::handlers::counts::serialize_cache_gate_for_test();
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            s3_seed_account(&state);
            let original=state.account_lifecycle.capture("acc1").unwrap();
            let origin=crate::sync_observation::origin(&state,original).await.unwrap();
            let owner=json!({"accountId":"acc1","mailbox":"INBOX","uidValidity":1,
                "originHash":origin.hash});
            crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                conn,"acc1","INBOX",&json!({"emails":[{"uid":1,"flags":[]}],
                    "totalEmails":1,"nativeIdentity":owner,"nativeExpectedIdentity":null}).to_string())).unwrap();
            let (entered,release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let running=Arc::clone(&state);
            let pending=tokio::spawn(async move { boxed_request(&running,s3_bounded_read_request()).await });
            tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(5)))
                .await.unwrap().expect("actual cache read must enter before retirement");
            state.account_lifecycle.apply_committed_membership(None,
                &mailvault_core::accounts_doc::MembershipDelta {
                    removed:["acc1".to_owned()].into(),..Default::default()
                });
            release.send(()).unwrap();
            let answer=pending.await.unwrap();
            assert!(answer.result.is_none() && answer.error.is_some(),
                "retired original must not publish a stale account's count: {answer:?}");
        }

        #[tokio::test]
        async fn s4_held_a_source_change_keeps_real_b_cache_count_and_foreground_live() {
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().to_path_buf(),dir.path().to_path_buf(),true);
            let a=json!({"id":"acc1","email":"one@example.test","authType":"password",
                "imapHost":"127.0.0.1","imapPort":143,"imapSecure":false});
            let b=json!({"id":"acc2","email":"two@example.test","authType":"password",
                "imapHost":"127.0.0.1","imapPort":143,"imapSecure":false});
            std::fs::write(state.app_dir.join("accounts.json"),json!([a,b]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            for (id, rows) in [("acc1",json!([{"uid":1,"flags":["\\Seen"]}])),
                ("acc2",json!([{"uid":21,"flags":[]},{"uid":22,"flags":[]}]))] {
                let original=state.account_lifecycle.capture(id).unwrap();
                let origin=crate::sync_observation::origin(&state,original).await.unwrap();
                let owner=json!({"accountId":id,"mailbox":"INBOX","uidValidity":1,
                    "originHash":origin.hash});
                crate::custody::with_conn(&state,|conn|mailvault_core::custody::cache::save_headers(
                    conn,id,"INBOX",&json!({"emails":rows,"totalEmails":if id=="acc1" {1} else {2},
                        "nativeIdentity":owner,"nativeExpectedIdentity":null}).to_string())).unwrap();
            }
            let (entered,release)=crate::handlers::counts::pause_next_cache_read_for_test();
            let held=Arc::clone(&state);
            let a_count=tokio::spawn(async move { boxed_request(&held,s3_bounded_read_request()).await });
            tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(5)))
                .await.unwrap().expect("A's actual native cache read must be held");
            let b_count=tokio::time::timeout(std::time::Duration::from_secs(2),boxed_request(&state,
                req("counts.unread",json!({"op":"recountCache","accountId":"acc2",
                    "baseline":{"acc1":9,"acc2":5},
                    "presentation":{"accounts":[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]},
                    "projection":{"archivedKeys":[],"deleteTombstones":[],"snoozes":[],
                        "autoTagRules":[],"tagsByRow":{},"viewHiddenKeys":[],
                        "hideViewMail":false,"followUps":[]}
                })))).await.expect("B must finish while A is held");
            let b_result=b_count.result.expect("B's actual cache read must succeed");
            assert_eq!(b_result["counts"],json!({"acc1":9,"acc2":2}));
            let path=state.app_dir.join("accounts.json");
            let mut changed:Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            changed[0]["email"]=json!("changed@example.test");
            std::fs::write(path,changed.to_string()).unwrap();
            release.send(()).unwrap();
            let a_result=a_count.await.unwrap();
            if let Some(result)=a_result.result {
                assert_eq!(result["counts"],json!({"acc1":9,"acc2":5}));
                assert_eq!(result["wrote"],json!(false));
            } else {
                assert!(a_result.error.is_some(),"stale A must explicitly refuse");
            }
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
        async fn s4_real_imap_delta_prepares_source_bound_notification_red() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let since = state.sync_engine.change_gen();
            append_refresh_imap(&server, "A real new subject");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"s4-real-arrival-red", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "real refresh ACK: {:?}", accepted.error);
            let receipt = terminal_refresh(&state, "s4-real-arrival-red").await;
            assert_eq!(receipt["status"], json!("complete"), "provider delta must complete: {receipt:?}");
            let events = boxed_request(&state, req("sync.events", json!({
                "since":since, "timeoutMs":1000,
            }))).await;
            assert!(events.error.is_none(), "real change poll: {:?}", events.error);
            let body = events.result.expect("real change poll body");
            let changes = body["changes"].as_array().expect("real change array");
            assert!(changes.iter().any(|change| change["accountId"] == "acc1"
                && change["mailbox"] == "INBOX" && change["arrivalUids"] == json!([2])),
                "real mock IMAP delta must prove UID 2 before notice: {body:?}");
            let prepared = body["notifications"].as_array().is_some_and(|notices|
                notices.iter().any(|notice| notice["accountId"] == "acc1"
                    && notice["mailbox"] == "INBOX" && notice["uids"] == json!([2])
                    && notice["from"].as_str().is_some_and(|from| from.contains("New Sender"))));
            assert!(prepared, "W4S4_NATIVE_ARRIVAL_RED: source-bound real UID 2 and sender missing from prepared notice: {body:?}");
            let notice = body["notifications"].as_array().unwrap().iter()
                .find(|notice| notice["uids"] == json!([2])).unwrap();
            assert_eq!(notice["banner"], json!(true));
            assert_eq!(notice["target"]["uid"], json!(2));
            assert_eq!(notice["presentation"]["kind"], json!("singlePreview"));
            assert_eq!(notice["sourceRef"], changes.iter().find(|change|
                change["arrivalUids"] == json!([2])).unwrap()["sourceRef"]);
            assert!(notice.get("raw").is_none() && notice.get("body").is_none());
            let again = boxed_request(&state, req("sync.events", json!({
                "since":since, "timeoutMs":0,
            }))).await.result.unwrap();
            assert!(again["notifications"].as_array().unwrap().is_empty(),
                "one real delivery cannot claim another banner on a repeated poll: {again:?}");
            replace_refresh_source_same_epoch(&state);
            let stale = boxed_request(&state, req("sync.events", json!({
                "since":since, "timeoutMs":0,
            }))).await.result.unwrap();
            assert!(stale["changes"].as_array().unwrap().is_empty()
                && stale["notifications"].as_array().unwrap().is_empty(),
                "a retained old-source record cannot recount or notify after replacement: {stale:?}");
        }

        #[tokio::test]
        async fn s4_proved_uid_without_exact_header_uses_generic_folder_notice() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let since = state.sync_engine.change_gen();
            append_refresh_imap(&server, "A proved but uncached preview");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"s4-generic-exact-uid", "accountId":"acc1", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "s4-generic-exact-uid").await["status"], json!("complete"));
            let cached = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let owner = cached["nativeIdentity"].clone();
            crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn,
                "acc1", "INBOX", &json!({"emails":[],"removedUids":[2],
                    "nativeIdentity":owner.clone(),"nativeExpectedIdentity":owner}).to_string())).unwrap();
            let body = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert!(body["changes"].as_array().unwrap().iter().any(|row|
                row["arrivalUids"] == json!([2])), "original delivery proof must survive: {body:?}");
            let notice = body["notifications"].as_array().unwrap().first()
                .expect("proved delivery keeps a generic folder notice");
            assert_eq!(notice["presentation"]["kind"], json!("singlePrivate"));
            assert!(notice["target"].get("uid").is_none());
            assert_eq!(notice["uids"], json!([2]));
        }

        #[tokio::test]
        async fn s4_real_held_body_keeps_feed_prompt_and_emits_one_deadline_banner_then_code() {
            async fn next_event(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>,
                wanted: &str) -> Value {
                tokio::time::timeout(std::time::Duration::from_secs(7), async {
                    loop {
                        let line = rx.recv().await.expect("event channel remains open");
                        if let Some((name, value)) = mailvault_core::daemon_ipc::parse_event(&line) {
                            if name == wanted { return value; }
                        }
                    }
                }).await.expect("expected native deferred event")
            }
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let since = state.sync_engine.change_gen();
            let raw = "From: Codes <codes@example.test>\r\nTo: user@example.com\r\nSubject: Password Reset Request\r\nDate: Thu, 01 Jan 2026 12:01:00 +0000\r\nMessage-ID: <body-code-2@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is 364758.\r\n";
            server.mutate(|server_state| {
                server_state.find_mut("INBOX").unwrap()
                    .add(mock_imap::state::Message::new(2, raw).with_modseq(2));
            });
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"s4-held-body", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "s4-held-body").await["status"], json!("complete"));
            let mut events = state.events.subscribe();
            let pause = server.pause_command("FETCH");
            let reply = tokio::time::timeout(std::time::Duration::from_secs(2),
                boxed_request(&state, req("sync.events", json!({
                    "since":since,"timeoutMs":1000,
                })))).await.expect("the change feed must not wait for a body read")
                .result.unwrap();
            assert!(reply["changes"].as_array().unwrap().iter().any(|change|
                change["arrivalUids"] == json!([2])));
            assert!(reply["notifications"].as_array().unwrap().is_empty(),
                "a lone body-code candidate must wait for its bounded deadline");
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(5)),
                    "one actual provider FETCH must enter the code child");
                pause
            }).await.unwrap();
            let banner = next_event(&mut events, "notify").await;
            assert_eq!(banner["uids"], json!([2]));
            assert_eq!(banner["banner"], json!(true));
            assert!(banner["target"].get("code").is_none(),
                "the deadline banner cannot claim a code the held body has not supplied");
            pause.release();
            let mut second_banners = 0;
            let ready = tokio::time::timeout(std::time::Duration::from_secs(7), async {
                loop {
                    let line = events.recv().await.expect("event channel remains open");
                    if let Some((name, value)) = mailvault_core::daemon_ipc::parse_event(&line) {
                        if name == "notify" { second_banners += 1; }
                        if name == "code-ready" { return value; }
                    }
                }
            }).await.expect("the released real body must yield code-ready");
            assert_eq!(ready["uid"], json!(2));
            assert_eq!(ready["code"], json!("364758"));
            assert_eq!(second_banners, 0, "late code must not emit a second OS banner");
        }

        #[tokio::test]
        async fn s4_real_body_code_survives_muted_and_private_banner_paths() {
            for (label, enabled, show_preview) in [("muted", false, true), ("private", true, false)] {
                let _env_lock = crate::credentials::test_env_lock().lock()
                    .unwrap_or_else(|error| error.into_inner());
                let _env = CredentialsEnv::capture();
                let dir = tempfile::tempdir().unwrap();
                let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
                let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
                mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                    "mailvault-settings":{"state":{"notificationSettings":{
                        "enabled":enabled,"showPreview":show_preview,
                    }}},
                }), None).unwrap();
                let account = bind_account(&state, &server);
                seed_refresh_imap(&state, account).await;
                let since = state.sync_engine.change_gen();
                let raw = "From: Codes <codes@example.test>\r\nTo: user@example.com\r\nSubject: Password Reset Request\r\nDate: Thu, 01 Jan 2026 12:01:00 +0000\r\nMessage-ID: <body-code-2@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is 364758.\r\n";
                server.mutate(|rows| {
                    rows.find_mut("INBOX").unwrap()
                        .add(mock_imap::state::Message::new(2, raw).with_modseq(2));
                });
                let request_id = format!("s4-{label}-body-code");
                let accepted = boxed_request(&state, req("sync.refresh", json!({
                    "requestId":request_id,"accountId":"acc1","mailbox":"INBOX","reason":"manual",
                }))).await;
                assert!(accepted.error.is_none(), "{label}: real refresh ACK: {:?}", accepted.error);
                assert_eq!(terminal_refresh(&state, &request_id).await["status"], json!("complete"));
                let mut events = state.events.subscribe();
                let header_fetches = server.count_commands("FETCH");
                let reply = boxed_request(&state, req("sync.events", json!({
                    "since":since,"timeoutMs":1000,
                }))).await.result.unwrap();
                assert!(reply["changes"].as_array().unwrap().iter().any(|row|
                    row["arrivalUids"] == json!([2])), "{label}: real UID proof: {reply:?}");
                if !enabled {
                    let notice = reply["notifications"].as_array().unwrap().first()
                        .expect("muted policy outcome remains observable without an OS banner");
                    assert_eq!(notice["banner"], json!(false));
                    assert_eq!(notice["reason"], json!("notifications-off"));
                    assert_eq!(notice["logPolicy"], json!(true));
                } else {
                    let banner = tokio::time::timeout(std::time::Duration::from_secs(7), async {
                        loop {
                            let line = events.recv().await.expect("native event channel stays live");
                            if let Some((name, value)) = mailvault_core::daemon_ipc::parse_event(&line) {
                                if name == "notify" { return value; }
                            }
                        }
                    }).await.expect("private banner must arrive from real code preparation");
                    assert_eq!(banner["banner"], json!(true));
                    assert_eq!(banner["presentation"]["kind"], json!("singlePrivate"));
                    assert!(banner["target"].get("uid").is_none()
                        && banner["target"].get("code").is_none(),
                        "private OS target must contain neither UID nor code: {banner:?}");
                }
                let ready = tokio::time::timeout(std::time::Duration::from_secs(7), async {
                    loop {
                        let line = events.recv().await.expect("native event channel stays live");
                        if let Some((name, value)) = mailvault_core::daemon_ipc::parse_event(&line) {
                            if name == "code-ready" { return value; }
                        }
                    }
                }).await.expect("a muted/private banner cannot suppress the real body code");
                assert_eq!(ready["uid"], json!(2), "{label}: original UID survives");
                assert_eq!(ready["code"], json!("364758"), "{label}: real provider body was scanned");
                assert!(server.count_commands("FETCH") > header_fetches,
                    "{label}: provider body must be read after the header refresh");
            }
        }

        #[tokio::test]
        async fn s4_held_real_body_refuses_old_source_after_same_epoch_replacement() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let since = state.sync_engine.change_gen();
            let raw = "From: Codes <codes@example.test>\r\nTo: user@example.com\r\nSubject: Password Reset Request\r\nDate: Thu, 01 Jan 2026 12:01:00 +0000\r\nMessage-ID: <retired-body-code-2@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is 364758.\r\n";
            server.mutate(|rows| {
                rows.find_mut("INBOX").unwrap()
                    .add(mock_imap::state::Message::new(2, raw).with_modseq(2));
            });
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"s4-retired-code-body","accountId":"acc1",
                "mailbox":"INBOX","reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "s4-retired-code-body").await["status"], json!("complete"));
            let mut events = state.events.subscribe();
            let pause = server.pause_command("FETCH");
            let reply = tokio::time::timeout(std::time::Duration::from_secs(2),
                boxed_request(&state, req("sync.events", json!({
                    "since":since,"timeoutMs":1000,
                })))).await.expect("the real source-bound change must repaint before body I/O")
                .result.unwrap();
            assert!(reply["changes"].as_array().unwrap().iter().any(|change|
                change["arrivalUids"] == json!([2])));
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(5)),
                    "the real original-source code child must reach provider FETCH");
                pause
            }).await.unwrap();
            replace_refresh_source_same_epoch(&state);
            pause.release();
            let late = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let line = events.recv().await.expect("native event channel stays live");
                    if let Some((name, value)) = mailvault_core::daemon_ipc::parse_event(&line) {
                        if name == "notify" || name == "code-ready" { return (name, value); }
                    }
                }
            }).await;
            assert!(late.is_err(), "a retired original must not emit a late banner or code: {late:?}");
            assert!(!state.raw_messages.test_holds("acc1", "INBOX", 2),
                "an old provider body must not enter the replacement's raw-message memory");
            let stale = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert!(stale["notifications"].as_array().unwrap().is_empty(),
                "a second poll cannot rescue the retired original's notice: {stale:?}");
        }


        #[tokio::test]
        async fn s4_real_idle_arrival_publishes_original_source_and_prepared_notice() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account.clone()).await;
            let watched = boxed_request(&state, req("sync.watch", json!({
                "account":account,
            }))).await;
            assert_eq!(watched.result.expect("existing credential-resolving watch route")
                ["watching"], json!(true));
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while server.count_commands("IDLE") == 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }).await.expect("the original watcher must enter real provider IDLE");
            let since = state.sync_engine.change_gen();
            let raw = format!("From: Codes <codes@outside.test>\r\nTo: user@example.com\r\nSubject: Your verification code is 364758\r\nDate: {}\r\nMessage-ID: <s4-idle-2@outside.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour code is 364758.\r\n", chrono::Utc::now().to_rfc2822());
            server.mutate(|rows| {
                rows.find_mut("INBOX").unwrap().add(
                    mock_imap::state::Message::new(2, raw).with_modseq(2));
            });
            let (gen, _) = state.sync_engine.wait_changes(since, 10_000).await;
            assert!(gen > since, "real provider IDLE must publish the appended UID");
            let reply = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":1000,
            }))).await.result.unwrap();
            assert_eq!(reply["resyncRequired"], json!(false));
            let change = reply["changes"].as_array().unwrap().iter().find(|row|
                row["accountId"] == json!("acc1") && row["newEmails"] == json!(1))
                .expect("the actual watcher arrival must reach the native change feed");
            assert_eq!(change["arrivalUids"], json!([2]),
                "W4S4_IDLE_SOURCE_RED: actual IDLE must carry its proven unique UID: {reply:?}");
            let source_ref = change["sourceRef"].as_str()
                .filter(|reference| !reference.is_empty())
                .expect("W4S4_IDLE_SOURCE_RED: actual IDLE must publish its original source reference");
            let notices = reply["notifications"].as_array().unwrap();
            assert_eq!(notices.len(), 1,
                "one original-source IDLE arrival must prepare one native notice: {reply:?}");
            assert_eq!(notices[0]["sourceRef"], json!(source_ref));
            assert_eq!(notices[0]["target"]["uid"], json!(2));
            assert_eq!(notices[0]["codeReady"], json!({"uid":2,"code":"364758"}));
            let repeated = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert!(repeated["notifications"].as_array().unwrap().is_empty(),
                "an already claimed IDLE arrival cannot prepare a second notice");
            state.idle.shutdown().await;
        }

        #[tokio::test]
        async fn s4_real_idle_held_select_cannot_publish_or_cache_replaced_original() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account.clone()).await;
            let watched = boxed_request(&state, req("sync.watch", json!({"account":account}))).await;
            assert_eq!(watched.result.unwrap()["watching"], json!(true));
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while server.count_commands("IDLE") == 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }).await.expect("original watcher must reach real provider IDLE");
            let since = state.sync_engine.change_gen();
            let pause = server.pause_command("SELECT");
            append_refresh_imap(&server, "old source held at provider SELECT");
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(10)),
                    "actual IDLE child must hold its provider SELECT");
                pause
            }).await.unwrap();
            replace_refresh_source_same_epoch(&state);
            pause.release();
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    if state.idle.status().await.iter().any(|status|
                        status.account_id == "acc1" && status.wakeups > 0) { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }).await.expect("held IDLE round must finish after release");
            let reply = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert!(reply["changes"].as_array().unwrap().iter().all(|change|
                change["accountId"] != json!("acc1")),
                "a replacement cannot borrow any held original IDLE publication: {reply:?}");
            assert!(reply["notifications"].as_array().unwrap().is_empty(),
                "old original cannot prepare a replacement notice: {reply:?}");
            let saved = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert!(saved["emails"].as_array().unwrap().iter().all(|row| row["uid"] != json!(2)),
                "old provider work cannot write UID 2 under replacement: {saved:?}");
            state.idle.shutdown().await;
        }

        #[tokio::test]
        async fn s4_real_two_uid_batch_prepares_one_banner_and_newest_code() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let since = state.sync_engine.change_gen();
            for (uid, subject, from) in [(2, "First arrival", "One <one@outside.test>"),
                (3, "Your verification code is 364758", "Two <two@outside.test>")] {
                let raw = format!("From: {from}\r\nTo: user@example.com\r\nSubject: {subject}\r\nDate: Thu, 01 Jan 2026 12:01:00 +0000\r\nMessage-ID: <batch-{uid}@outside.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nBatch body.\r\n");
                server.mutate(|rows| {
                    rows.find_mut("INBOX").unwrap().add(mock_imap::state::Message::new(uid, raw).with_modseq(uid as u64));
                });
            }
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"s4-real-batch","accountId":"acc1","mailbox":"INBOX","reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "s4-real-batch").await["status"], json!("complete"));
            let reply = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":1000,
            }))).await.result.unwrap();
            let change = reply["changes"].as_array().unwrap().iter()
                .find(|row| row["accountId"] == json!("acc1") && row["mailbox"] == json!("INBOX"))
                .expect("the real batch must publish its INBOX change");
            assert_eq!(change["newEmails"], json!(2));
            let sorted_uids = |value: &Value| {
                let mut uids: Vec<u64> = value.as_array().unwrap().iter()
                    .map(|uid| uid.as_u64().expect("an actual arrival UID is positive")).collect();
                uids.sort_unstable();
                uids
            };
            assert_eq!(sorted_uids(&change["arrivalUids"]), vec![2, 3],
                "real batch UIDs must be proved exactly once: {reply:?}");
            let notices = reply["notifications"].as_array().unwrap();
            assert_eq!(notices.len(), 1, "one real provider batch makes one notice: {reply:?}");
            let notice = &notices[0];
            assert_eq!(sorted_uids(&notice["uids"]), vec![2, 3]);
            assert_eq!(notice["banner"], json!(true));
            assert_eq!(notice["presentation"]["kind"], json!("batchPreview"));
            assert_eq!(notice["target"]["uid"], json!(3));
            assert!(notice["target"].get("code").is_none()
                && notice["presentation"]["data"].get("code").is_none(),
                "a batch OS banner never carries even its newest code");
            assert_eq!(notice["codeReady"], json!({"uid":3,"code":"364758"}));
            let repeated = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert!(repeated["notifications"].as_array().unwrap().is_empty(),
                "same two-UId delivery cannot claim another banner");
        }

        #[tokio::test]
        async fn s4_real_alias_sender_and_sent_mailbox_suppress_only_their_banners() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailboxes(vec![
                synthetic_mailbox("INBOX", 1), synthetic_mailbox("Sent", 1),
            ]));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings":{"state":{"aliases":{"acc1":[
                    {"address":"alias@example.test","name":"Alias","source":"manual"}
                ]}}},
            }), None).unwrap();
            seed_refresh_imap(&state, account.clone()).await;
            let started = boxed_request(&state, req("sync.now", json!({
                "account":account,"mailbox":"Sent","autoClassify":false,
            }))).await;
            let ticket = started.result.unwrap()["ticket"].as_u64().unwrap();
            assert_eq!(boxed_request(&state, req("sync.wait", json!({
                "ticket":ticket,"timeoutMs":10_000,
            }))).await.result.unwrap()["success"], json!(true));
            let since = state.sync_engine.change_gen();
            let own = "From: Alias <alias@example.test>\r\nTo: user@example.com\r\nSubject: Own alias\r\nDate: Thu, 01 Jan 2026 12:01:00 +0000\r\nMessage-ID: <own-alias@example.test>\r\n\r\nBody\r\n";
            let sent = "From: Other <other@outside.test>\r\nTo: user@example.com\r\nSubject: Sent folder\r\nDate: Thu, 01 Jan 2026 12:02:00 +0000\r\nMessage-ID: <sent-folder@example.test>\r\n\r\nBody\r\n";
            server.mutate(|rows| {
                rows.find_mut("INBOX").unwrap().add(mock_imap::state::Message::new(2, own).with_modseq(2));
                rows.find_mut("Sent").unwrap().add(mock_imap::state::Message::new(2, sent).with_modseq(2));
            });
            for mailbox in ["INBOX", "Sent"] {
                let request_id = format!("s4-silent-{mailbox}");
                let accepted = boxed_request(&state, req("sync.refresh", json!({
                    "requestId":request_id,"accountId":"acc1","mailbox":mailbox,"reason":"manual",
                }))).await;
                assert!(accepted.error.is_none());
                assert_eq!(terminal_refresh(&state, &request_id).await["status"], json!("complete"));
            }
            let reply = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":1000,
            }))).await.result.unwrap();
            for mailbox in ["INBOX", "Sent"] {
                assert!(reply["changes"].as_array().unwrap().iter().any(|row|
                    row["mailbox"] == mailbox && row["arrivalUids"] == json!([2])),
                    "the silent banner still repaints its real source: {reply:?}");
            }
            assert!(reply["notifications"].as_array().unwrap().is_empty(),
                "authoritative own alias and actual Sent folder must not announce: {reply:?}");
        }

        #[tokio::test]
        async fn s4_lost_drain_reply_spends_once_but_keeps_cache_and_change_recovery() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let since = state.sync_engine.change_gen();
            append_refresh_imap(&server, "Lost prepared reply");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"s4-lost-reply","accountId":"acc1","mailbox":"INBOX","reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "s4-lost-reply").await["status"], json!("complete"));
            let lost = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":1000,
            }))).await.result.unwrap();
            assert_eq!(lost["notifications"].as_array().unwrap().len(), 1,
                "the first accepted drain actually spent a native banner");
            drop(lost);
            let recovered = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert!(recovered["changes"].as_array().unwrap().iter().any(|row|
                row["arrivalUids"] == json!([2])),
                "the same cursor still recovers the original change: {recovered:?}");
            assert!(recovered["notifications"].as_array().unwrap().is_empty(),
                "a lost prepared response may lose its OS banner but must not replay it");
            assert!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["emails"]
                .as_array().unwrap().iter().any(|row| row["uid"] == 2),
                "uncertain notification delivery cannot undo the native cache effect");
        }

        #[tokio::test]
        async fn s4_ring_overrun_requires_resync_without_historical_notices() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let original = state.account_lifecycle.capture("acc1").unwrap();
            let origin = crate::sync_observation::origin(&state, original).await.unwrap();
            let (_, source) = crate::sync_observation::source(&state, &origin, "INBOX").await.unwrap();
            let since = state.sync_engine.change_gen();
            for _ in 0..65 {
                state.sync_engine.note_source_change(source.clone(), vec![2], 0);
            }
            let reply = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            assert_eq!(reply["resyncRequired"], json!(true));
            assert_eq!(reply["gen"], json!(since + 65));
            assert_eq!(reply["changes"].as_array().unwrap().len(), 64,
                "the finite ring does not fabricate missing history");
            assert!(reply["notifications"].as_array().unwrap().is_empty(),
                "overrun recovery must never synthesize historical banners");
            let restart_cursor = boxed_request(&state, req("sync.events", json!({
                "since":since + 1000,"timeoutMs":0,
            }))).await.result.unwrap();
            assert_eq!(restart_cursor["resyncRequired"], json!(true));
            assert!(restart_cursor["notifications"].as_array().unwrap().is_empty());
        }

        #[tokio::test]
        async fn s4_jmap_real_body_code_and_email_get_failure_keep_original_uid_and_banner() {
            for fail_body in [false, true] {
                let _env_lock = crate::credentials::test_env_lock().lock()
                    .unwrap_or_else(|error| error.into_inner());
                let _env = CredentialsEnv::capture();
                let dir = tempfile::tempdir().unwrap();
                let mock = mock_jmap::MockJmap::start(crate::jmap_test_support::scenario());
                let (trap, imap_port) = crate::jmap_test_support::imap_trap();
                let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
                let account = bind_jmap_refresh(&state, &mock, imap_port);
                let seeded = state.sync_engine.sync_account(&account, "INBOX").await;
                assert!(seeded.success, "real JMAP baseline: {:?}", seeded.error);
                let since = state.sync_engine.change_gen();
                let mut new = crate::jmap_test_support::email("code-e9", "Password Reset Request",
                    "2026-10-04T10:00:00Z");
                new.raw = "From: Codes <codes@example.test>\r\nTo: alice@example.test\r\nSubject: Password Reset Request\r\nDate: Sun, 04 Oct 2026 10:00:00 +0000\r\nMessage-ID: <code-e9@x>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is 364758.\r\n".into();
                mock.mutate(|server| server.add_email("acc1", "mb-inbox", new));
                let request_id = if fail_body { "s4-jmap-code-fail" } else { "s4-jmap-code" };
                let accepted = boxed_request(&state, req("sync.refresh", json!({
                    "requestId":request_id,"accountId":"acc1","mailbox":"INBOX","reason":"manual",
                }))).await;
                assert!(accepted.error.is_none());
                assert_eq!(terminal_refresh(&state, request_id).await["status"], json!("complete"));
                let uid = jmap_refresh_ledger(&state).iter().find_map(|(uid,id)|
                    (id == "code-e9").then_some(*uid)).expect("new JMAP id must have a native UID");
                if fail_body {
                    mock.mutate(|server| server.faults.push(mock_jmap::Fault::ServerFail {
                        method:"Email/get".into(),
                    }));
                }
                let requests_before = mock.requests().len();
                let mut events = state.events.subscribe();
                let reply = boxed_request(&state, req("sync.events", json!({
                    "since":since,"timeoutMs":1000,
                }))).await.result.unwrap();
                assert!(reply["changes"].as_array().unwrap().iter().any(|change|
                    change["arrivalUids"] == json!([uid])),
                    "JMAP ID must retain its original allocated UID: {reply:?}");
                let (banner, maybe_code) = tokio::time::timeout(std::time::Duration::from_secs(7), async {
                    let mut banner = None;
                    loop {
                        let line = events.recv().await.expect("native event channel stays live");
                        if let Some((name, value)) = mailvault_core::daemon_ipc::parse_event(&line) {
                            if name == "notify" { banner = Some(value); }
                            else if name == "code-ready" { break (banner, Some(value)); }
                            if fail_body && banner.is_some() { break (banner, None); }
                        }
                    }
                }).await.expect("real JMAP body attempt must resolve to banner/code outcome");
                let banner = banner.expect("one proven delivery gets a banner even if body fails");
                assert_eq!(banner["uids"], json!([uid]));
                assert_eq!(banner["banner"], json!(true));
                if fail_body {
                    assert!(banner["target"].get("code").is_none());
                    assert!(maybe_code.is_none(), "failed JMAP Email/get cannot produce a code");
                } else {
                    let code = maybe_code.expect("real JMAP body supplies one code-ready event");
                    assert_eq!(code["uid"], json!(uid));
                    assert_eq!(code["code"], json!("364758"));
                }
                assert!(mock.requests().len() > requests_before,
                    "code child must ask the actual JMAP provider for Email/get");
                assert!(trap.accept().is_err(), "JMAP body read must never dial IMAP");
            }
        }

        #[tokio::test]
        async fn s4_change_published_under_its_short_source_lease_survives_feed_race() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let original = state.account_lifecycle.capture("acc1").unwrap();
            let origin = crate::sync_observation::origin(&state, original).await.unwrap();
            let (_, source) = crate::sync_observation::source(&state, &origin, "INBOX").await.unwrap();
            let lease = crate::sync_observation::source_lease(&state,
                &source.original, &source.origin_hash).unwrap();
            let since = state.sync_engine.change_gen();
            state.sync_engine.note_source_change(source, vec![2], 0);
            let waiting = Arc::clone(&state);
            let feed = tokio::spawn(async move {
                boxed_request(&waiting, req("sync.events", json!({
                    "since":since, "timeoutMs":1000,
                }))).await
            });
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            drop(lease);
            let body = feed.await.unwrap().result.unwrap();
            assert!(body["changes"].as_array().unwrap().iter().any(|change|
                change["accountId"] == "acc1" && change["arrivalUids"] == json!([2])),
                "W4S4_FEED_LEASE_RED: a valid published record cannot disappear merely because its publisher still held the short lease: {body:?}");
        }

        #[tokio::test]
        async fn s4_persistent_a_lease_keeps_cursor_for_a_and_b_after_release() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let rows = json!([
                {"id":"acc1","email":"one@example.test","imapHost":"127.0.0.1"},
                {"id":"acc2","email":"two@example.test","imapHost":"127.0.0.1"},
            ]);
            std::fs::write(state.app_dir.join("accounts.json"), rows.to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let mut sources = Vec::new();
            for (id, uid) in [("acc1", 1), ("acc2", 21)] {
                let original = state.account_lifecycle.capture(id).unwrap();
                let origin = crate::sync_observation::origin(&state, original).await.unwrap();
                let owner = json!({"accountId":id,"mailbox":"INBOX","uidValidity":1,
                    "originHash":origin.hash});
                crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(
                    conn, id, "INBOX", &json!({"emails":[{"uid":uid,"flags":[]}],
                        "totalEmails":1,"nativeIdentity":owner,"nativeExpectedIdentity":null}).to_string())).unwrap();
                let (_, source) = crate::sync_observation::source(&state, &origin, "INBOX").await.unwrap();
                sources.push(source);
            }
            let lease = crate::sync_observation::source_lease(&state,
                &sources[0].original, &sources[0].origin_hash).unwrap();
            let since = state.sync_engine.change_gen();
            state.sync_engine.note_source_change(sources[0].clone(), vec![1], 0);
            state.sync_engine.note_source_change(sources[1].clone(), vec![21], 0);
            let blocked = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await;
            assert!(blocked.error.as_ref().is_some_and(|error|
                error.message.contains("errors.keychainBusy")),
                "a persistently busy A must not advance the cursor or silently drop it: {blocked:?}");
            drop(lease);
            let recovered = boxed_request(&state, req("sync.events", json!({
                "since":since,"timeoutMs":0,
            }))).await.result.unwrap();
            let ids: Vec<_> = recovered["changes"].as_array().unwrap().iter()
                .map(|row| row["accountId"].as_str().unwrap()).collect();
            assert_eq!(ids, vec!["acc1", "acc2"], "A and unaffected B both remain observable: {recovered:?}");
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

        #[tokio::test]
        async fn refresh_imap_complete_multiple_real_chunks_finishes_without_stack_growth() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1601)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let mut account: crate::sync_engine::SyncAccount =
                serde_json::from_value(bind_account(&state, &server)).unwrap();
            // The direct seed bypasses sync.now's credential resolver.
            account.imap_config.password = Some("hunter2".into());
            let seed = state.sync_engine.sync_account(&account, "INBOX").await;
            assert!(seed.success, "cold seed failed: {:?}; SELECT/FETCH={:?}",
                seed.error, refresh_provider_trace(&server, 0));
            let before = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap();
            assert_eq!(before, 500, "cold page must leave two real older chunks");
            let command_before = server.commands().len();
            let (entered, release) = state.sync_engine.test_hold_after_complete_chunk();
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-complete-1601","mailbox":"INBOX","reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "large Complete must ACK without stack overflow");
            tokio::time::timeout(std::time::Duration::from_secs(20), entered.notified()).await
                .expect("first real Complete chunk must finish");
            let first_chunk = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap();
            assert_eq!(first_chunk, 1500, "cold page plus first 1,000-row chunk");
            release.notify_one();
            let settled = terminal_refresh(&state, "imap-complete-1601").await;
            assert_eq!(settled["status"], json!("complete"),
                "multiple real provider chunks must reach terminal success: {settled:?}");
            assert_eq!(crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap(), 1601);
            let trace = refresh_provider_trace(&server, command_before);
            let complete_fetches = trace.iter().filter(|(name, is_uid, args)|
                name == "FETCH" && *is_uid && args.contains("HEADER.FIELDS")).count();
            assert!(complete_fetches >= 2,
                "two real Complete chunks must issue provider header FETCH: {trace:?}");
        }

        #[tokio::test]
        async fn refresh_imap_complete_later_chunk_failure_retains_confirmed_fill_and_repaints() {
            use futures::FutureExt;
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2100)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account_json = bind_account(&state, &server);
            let mut account: crate::sync_engine::SyncAccount = serde_json::from_value(account_json.clone()).unwrap();
            // The direct seed bypasses sync.now's credential resolver.
            account.imap_config.password = Some("hunter2".into());
            let seed = state.sync_engine.sync_account(&account, "INBOX").await;
            assert!(seed.success, "cold seed failed: {:?}; SELECT/FETCH={:?}",
                seed.error, refresh_provider_trace(&server, 0));
            let baseline = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap();
            assert!(baseline < 1100, "cold page must leave two real backfill chunks: {baseline}");
            let _ = state.auto_tag_worker.notify.notified().now_or_never();
            let before_gen = state.sync_engine.change_gen();
            let (entered, release) = state.sync_engine.test_hold_after_complete_chunk();
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-complete-later-failure", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(20), entered.notified()).await
                .expect("first real backfill chunk must finish");
            let partial = crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap();
            assert!(partial > baseline && partial < 2100,
                "first chunk must leave confirmed partial headers: {partial}");
            let status = tokio::time::timeout(std::time::Duration::from_secs(3),
                boxed_request(&state, req("sync.refresh_status", json!({
                    "requestId":"imap-complete-later-failure"}))))
                .await.expect("receipt status stays responsive while a provider child is held");
            assert_eq!(status.result.unwrap()["found"], json!(true));
            let cache = tokio::time::timeout(std::time::Duration::from_secs(3),
                boxed_request(&state, req("load_email_cache", json!({
                    "accountId":"acc1","mailbox":"INBOX"}))))
                .await.expect("foreground cache route stays responsive during multi-chunk fill");
            assert!(cache.result.unwrap().is_string());
            // The legacy foreground body route takes a flat ImapConfig with its
            // credential; the credential-free refresh request uses stored secrets.
            let mut body_account = account_json["imapConfig"].clone();
            body_account["password"] = json!("hunter2");
            let body = tokio::time::timeout(std::time::Duration::from_secs(3),
                boxed_request(&state, req("imap_get_email", json!({
                    "account":body_account,"mailbox":"INBOX","uid":1}))))
                .await.expect("foreground mailbox read stays responsive during held backfill");
            assert!(body.error.is_none(), "foreground mailbox read failed: {:?}", body.error);
            assert_eq!(body.result.unwrap()["success"], json!(true));
            server.reset_scenario(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2100))
                .fault(mock_imap::Trigger::on("FETCH"),
                    mock_imap::Action::RefuseWith("NO".into(), "later chunk refusal".into())));
            release.notify_one();
            let settled = terminal_refresh(&state, "imap-complete-later-failure").await;
            assert_eq!(settled["status"], json!("failed"),
                "later FETCH refusal cannot claim Complete: {settled:?}");
            assert_eq!(crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::count(conn, "acc1", "INBOX")).unwrap(), partial);
            let (_, records) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert_eq!(records.len(), 1, "confirmed fill publishes one requested repaint: {records:?}");
            assert!(records[0].arrival_uids.is_empty(), "historical fill has no delivery UIDs");
            assert!(state.auto_tag_worker.notify.notified().now_or_never().is_some());
        }

        #[tokio::test]
        async fn refresh_imap_complete_competing_owner_after_first_chunk_refuses_later_writes() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2100)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let mut account: crate::sync_engine::SyncAccount = serde_json::from_value(bind_account(&state, &server)).unwrap();
            // The direct seed bypasses sync.now's credential resolver.
            account.imap_config.password = Some("hunter2".into());
            let seed = state.sync_engine.sync_account(&account, "INBOX").await;
            assert!(seed.success, "cold seed failed: {:?}; SELECT/FETCH={:?}",
                seed.error, refresh_provider_trace(&server, 0));
            let before_gen = state.sync_engine.change_gen();
            let (entered, release) = state.sync_engine.test_hold_after_complete_chunk();
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-complete-owner-after-chunk", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(20), entered.notified()).await
                .expect("first real backfill chunk must finish");
            let saved = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let owner = saved["nativeIdentity"].clone();
            let mut foreign = owner.clone();
            foreign["originHash"] = json!("foreign-imap-complete-owner");
            crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX",
                    &json!({"emails":[], "nativeIdentity":foreign,
                        "nativeExpectedIdentity":owner}).to_string())).unwrap();
            release.notify_one();
            let settled = terminal_refresh(&state, "imap-complete-owner-after-chunk").await;
            assert_eq!(settled["status"], json!("failed"),
                "competing native owner cannot claim Complete: {settled:?}");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()
                ["nativeIdentity"]["originHash"], json!("foreign-imap-complete-owner"));
            let (_, records) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert!(records.is_empty(), "stale owner suppresses requested source publication: {records:?}");
        }

        #[tokio::test]
        async fn refresh_imap_complete_resolved_sent_alias_keeps_its_exact_cache_and_receipt_mailbox() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mut sent = synthetic_mailbox("[Google Mail]/Sent Mail", 7);
            sent.attrs.push("\\Sent".into());
            sent.by_uid_mut(7).unwrap().raw =
                b"From: sent@example.test\r\nTo: user@example.com\r\nSubject: Sent seven\r\nMessage-ID: <sent-seven@example.test>\r\n\r\nsent".to_vec();
            let server = MockImap::start(Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 7)).mailbox(sent));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            let seed = boxed_request(&state, req("sync.now", json!({
                "account":account,"mailbox":"INBOX","autoClassify":false,
            }))).await.result.unwrap();
            let seeded = boxed_request(&state, req("sync.wait", json!({
                "ticket":seed["ticket"],"timeoutMs":10_000,
            }))).await.result.unwrap();
            assert_eq!(seeded["success"], json!(true));
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(7));
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-complete-sent-alias", "mailbox":"Sent", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none(), "all-account Complete must ACK: {:?}", accepted.error);
            let settled = terminal_refresh(&state, "imap-complete-sent-alias").await;
            assert_eq!(settled["status"], json!("complete"),
                "resolved alias must complete its actual provider coverage: {settled:?}");
            assert_eq!(settled["accountResults"][0]["mailbox"], json!("[Google Mail]/Sent Mail"));
            let alias_cache = refresh_cached_headers(&state, "acc1", "[Google Mail]/Sent Mail").unwrap();
            assert_eq!(alias_cache["totalCached"], json!(7));
            assert_eq!(alias_cache["nativeIdentity"]["mailbox"], json!("[Google Mail]/Sent Mail"));
            assert_eq!(refresh_cached_headers(&state, "acc1", "Sent"), None,
                "resolved headers may not leak into the requested alias path");
            let inbox_cache = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(inbox_cache["totalCached"], json!(7));
            let inbox_seven = inbox_cache["emails"].as_array().unwrap().iter().find(|row| row["uid"] == 7).unwrap();
            let sent_seven = alias_cache["emails"].as_array().unwrap().iter().find(|row| row["uid"] == 7).unwrap();
            assert_eq!(inbox_seven["subject"], json!("Message 7"));
            assert_eq!(sent_seven["subject"], json!("Sent seven"));
            let selects = commands_named(&server, "SELECT");
            let select_args: Vec<_> = selects.iter().map(|command| command.args.as_str()).collect();
            assert!(select_args.iter().any(|args| args.contains("[Google Mail]/Sent Mail")),
                "provider SELECT must use the resolved mailbox: {select_args:?}");
        }

        #[tokio::test]
        async fn refresh_imap_flags_and_removal_repaint_without_arrival_uids() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let mut flagged = synthetic_mailbox("INBOX", 1);
            flagged.by_uid_mut(1).unwrap().flags = vec!["\\Seen".into()];
            flagged.by_uid_mut(1).unwrap().modseq = 50;
            flagged.highest_modseq = 50;
            server.reset_scenario(Scenario::new().mailbox(flagged));
            let flag_gen = state.sync_engine.change_gen();
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-flags-only", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "imap-flags-only").await["status"], json!("complete"));
            let (_, flag_changes) = state.sync_engine.wait_changes(flag_gen, 0).await;
            assert_eq!(flag_changes.len(), 1, "flag-only refresh must repaint: {flag_changes:?}");
            assert!(flag_changes[0].updated_flags > 0);
            assert!(flag_changes[0].arrival_uids.is_empty());
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["emails"][0]["flags"],
                json!(["\\Seen"]));

            server.reset_scenario(Scenario::new().mailbox(Mailbox::new("INBOX")));
            let remove_gen = state.sync_engine.change_gen();
            let removed = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-removal-only", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(removed.error.is_none());
            assert_eq!(terminal_refresh(&state, "imap-removal-only").await["status"], json!("complete"));
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(0));
            let (_, remove_changes) = state.sync_engine.wait_changes(remove_gen, 0).await;
            assert_eq!(remove_changes.len(), 1, "removal-only refresh must repaint: {remove_changes:?}");
            assert!(remove_changes[0].arrival_uids.is_empty());
            assert_eq!(remove_changes[0].source.as_ref().unwrap().account_id, "acc1");
        }

        #[tokio::test]
        async fn refresh_final_publication_refuses_changed_source_after_real_header_write() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            append_refresh_imap(&server, "held before publication");
            let before = state.sync_engine.change_gen();
            let (entered, release) = crate::refresh_worker::test_hold_before_publication(&state);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"imap-stale-publication", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered)
                .await.expect("real native write must reach final publication gate")
                .expect("publication gate must signal");
            let written = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(written["totalCached"], json!(2),
                "the provider header must be saved before the final source gate");
            let held_status = boxed_request(&state, req("sync.refresh_status", json!({
                "requestId":"imap-stale-publication",
            }))).await.result.unwrap();
            assert_eq!(held_status["receipts"][0]["status"], json!("running"));
            let path = state.app_dir.join("accounts.json");
            let mut rows: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            rows[0]["imapHost"] = json!("127.0.0.2");
            std::fs::write(&path, rows.to_string()).unwrap();
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "imap-stale-publication").await;
            assert_eq!(settled["status"], json!("failed"));
            assert_eq!(settled["accountResults"][0]["errorKey"], json!("errors.bulkIdentityChanged"));
            let (_, changes) = state.sync_engine.wait_changes(before, 0).await;
            assert!(changes.is_empty(), "a retired source may not publish an arrival: {changes:?}");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX"), Some(written),
                "the final gate may not issue a second cache write");
        }

        #[tokio::test]
        async fn refresh_concurrent_same_id_joins_one_held_authoritative_admission_snapshot() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            bind_account(&state, &server);
            let (entered, release) = crate::refresh_worker::test_hold_after_admission_snapshot(&state);
            let params = json!({"requestId":"shared-admission", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual"});
            let first_state = Arc::clone(&state);
            let first_params = params.clone();
            let first = tokio::spawn(async move {
                boxed_request(&first_state, req("sync.refresh", first_params)).await
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), entered).await
                .expect("one authoritative listing must be read")
                .expect("admission snapshot gate must signal");
            let second_state = Arc::clone(&state);
            let second = tokio::spawn(async move {
                boxed_request(&second_state, req("sync.refresh", params)).await
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while state.refresh.test_duplicate_join_count() == 0 {
                    tokio::task::yield_now().await;
                }
            }).await.expect("duplicate request must join while the first source snapshot is held");
            let held = boxed_request(&state, req("sync.refresh_status", json!({
                "requestId":"shared-admission",
            }))).await.result.unwrap();
            assert_eq!(held["receipts"][0]["status"], json!("queued"));
            assert_eq!(crate::refresh_worker::test_admission_snapshot_count(&state), 1,
                "the concurrent duplicate cannot read a second authoritative listing");
            assert!(server.commands().is_empty(), "held admission cannot start provider IO");
            release.send(()).unwrap();
            let first = first.await.unwrap();
            let second = second.await.unwrap();
            assert!(first.error.is_none() && second.error.is_none());
            assert_eq!(first.result.as_ref().unwrap()["receipt"]["requestId"], json!("shared-admission"));
            assert_eq!(second.result.as_ref().unwrap()["receipt"]["requestId"], json!("shared-admission"));
            let terminal = terminal_refresh(&state, "shared-admission").await;
            assert_eq!(terminal["status"], json!("complete"));
            assert_eq!(crate::refresh_worker::test_admission_snapshot_count(&state), 1);
            assert_eq!(state.refresh.test_duplicate_join_count(), 1);
            assert_eq!(refresh_status_selects(&server, "INBOX"), 1,
                "one admitted target yields one real provider status observation");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(1));
        }

        fn replace_refresh_source_same_epoch(state: &Arc<DaemonState>) {
            let before = state.account_lifecycle.capture("acc1").unwrap().epoch();
            let path = state.app_dir.join("accounts.json");
            let mut rows: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            rows[0]["email"] = json!("replaced-source@example.test");
            std::fs::write(&path, rows.to_string()).unwrap();
            assert_eq!(state.account_lifecycle.capture("acc1").unwrap().epoch(), before,
                "source replacement must retain the lifecycle epoch for this race");
        }

        fn jmap_refresh_meta(state: &Arc<DaemonState>) -> (u64, Option<String>) {
            crate::custody::with_conn(state, |conn| Ok((
                crate::jmap_sessions::JmapMeta::modseq(conn, "acc1", "INBOX"),
                crate::jmap_sessions::JmapMeta::email_state(conn, "acc1", "acc1"),
            ))).unwrap()
        }

        #[tokio::test]
        async fn r2_jmap_delta_held_after_real_get_cannot_write_replaced_same_epoch_source() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(2));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            let before_cache = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let before_ledger = jmap_refresh_ledger(&state);
            let before_meta = jmap_refresh_meta(&state);
            let before_gen = state.sync_engine.change_gen();
            let before_get = mock.count_calls("Email/get");
            mock.mutate(|server| server.add_email("acc1", "mb-inbox",
                crate::jmap_test_support::email("r2-delta-new", "must stay old-source",
                    "2026-10-04T10:00:00Z")));
            let (entered, release) = crate::sync_jmap::source_write_test_pause::install(&state, "delta-get");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r2-held-delta", "accountId":"acc1", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("real delta Email/get must reach write gate").expect("delta gate signal");
            assert!(mock.count_calls("Email/get") > before_get, "test must use actual provider Email/get");
            replace_refresh_source_same_epoch(&state);
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "r2-held-delta").await;
            let after_cache = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let after_ledger = jmap_refresh_ledger(&state);
            let after_meta = jmap_refresh_meta(&state);
            let (_, changes) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert!(settled["status"] == "failed" && after_cache == before_cache
                && after_ledger == before_ledger && after_meta == before_meta && changes.is_empty(),
                "R2 held JMAP delta must not mutate cache, UID ledger, counter, Email state or changes after same-epoch source replacement; receipt={settled:?}; ledger={after_ledger:?}; changes={changes:?}");
        }

        #[tokio::test]
        async fn r2_jmap_complete_held_after_real_get_cannot_mint_replaced_source_uids() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            let before_ledger = jmap_refresh_ledger(&state);
            let before_meta = jmap_refresh_meta(&state);
            let before_gen = state.sync_engine.change_gen();
            let before_get = mock.count_calls("Email/get");
            let (entered, release) = crate::sync_jmap::source_write_test_pause::install(&state, "complete-get");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r2-held-complete", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("real Complete Email/get must reach write gate").expect("Complete gate signal");
            assert!(mock.count_calls("Email/get") > before_get, "test must use actual provider Email/get");
            replace_refresh_source_same_epoch(&state);
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "r2-held-complete").await;
            let after_ledger = jmap_refresh_ledger(&state);
            let (_, changes) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert!(settled["status"] == "failed" && jmap_refresh_cache_count(&state) == 500
                && after_ledger == before_ledger && jmap_refresh_meta(&state) == before_meta
                && changes.is_empty(),
                "R2 held JMAP Complete must not mint UID or write header, counter, Email state or changes after same-epoch source replacement; receipt={settled:?}; ledger={after_ledger:?}; changes={changes:?}");
        }

        #[tokio::test]
        async fn r5_jmap_partial_complete_wakes_and_repaints_after_unchanged_delta() {
            use futures::FutureExt;
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            let _ = state.auto_tag_worker.notify.notified().now_or_never();
            let before_gen = state.sync_engine.change_gen();
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r5-unchanged-delta-complete", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            let settled = terminal_refresh(&state, "r5-unchanged-delta-complete").await;
            assert_eq!(settled["status"], json!("complete"), "Complete must fill old row: {settled:?}");
            assert_eq!(jmap_refresh_cache_count(&state), 501);
            let woke = state.auto_tag_worker.notify.notified().now_or_never().is_some();
            let (_, changes) = state.sync_engine.wait_changes(before_gen, 0).await;
            let repaint = changes.len() == 1 && changes[0].arrival_uids.is_empty()
                && changes[0].source.as_ref().is_some_and(|source|
                    source.account_id == "acc1" && source.mailbox == "INBOX");
            assert!(woke && repaint,
                "R5 unchanged JMAP delta plus partial Complete must wake Auto Tags and publish one source-qualified zero-arrival backfill repaint; woke={woke}; changes={changes:?}");
        }

        #[tokio::test]
        async fn r4_graph_same_ids_changed_flags_publish_zero_arrival_repaint() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (_config, _origin) = graph_complete_source(&state).await;
            let credential = json!({"id":"acc1", "email":"complete@example.test",
                "authType":"oauth2", "oauth2Provider":"microsoft", "oauth2Transport":"graph",
                "oauth2AccessToken":"synthetic-graph-complete", "oauth2ExpiresAt":4_000_000_000_000i64});
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({"acc1":credential.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            let mut folder = refresh_graph_folder("fld-complete", "Inbox");
            folder["totalItemCount"] = json!(1);
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let unread = refresh_graph_message("same-graph-id", "same header");
            let mut read = unread.clone();
            read["isRead"] = json!(true);
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, json!({"value":[folder.clone()]}).to_string()), (200, batch.to_string()),
                (200, json!({"value":[unread],"@odata.nextLink":null}).to_string()),
                (200, json!({"value":[folder]}).to_string()), (200, batch.to_string()),
                (200, json!({"value":[read],"@odata.nextLink":null}).to_string()),
            ]);
            let first = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r4-graph-baseline", "accountId":"acc1", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(first.error.is_none());
            assert_eq!(terminal_refresh(&state, "r4-graph-baseline").await["status"], json!("complete"));
            let before = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(before["graphComplete"], json!(true));
            let before_gen = state.sync_engine.change_gen();
            let second = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r4-graph-read", "accountId":"acc1", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(second.error.is_none());
            assert_eq!(terminal_refresh(&state, "r4-graph-read").await["status"], json!("complete"));
            let after = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(after["totalCached"], json!(1));
            assert_eq!(after["nativeIdentity"], before["nativeIdentity"]);
            let before_flags = &before["emails"][0]["flags"];
            let after_flags = &after["emails"][0]["flags"];
            assert_ne!(after_flags, before_flags, "actual Graph isRead update must reach native cached flags");
            assert!(after_flags.as_array().unwrap().contains(&json!("\\Seen")));
            let (_, changes) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert!(changes.len() == 1 && changes[0].arrival_uids.is_empty()
                && changes[0].source.as_ref().is_some_and(|source|
                    source.account_id == "acc1" && source.mailbox == "INBOX"),
                "R4 Graph same-ID flags must publish one source-qualified zero-arrival repaint; changes={changes:?}");
        }

        async fn late_effect_publication_observation(mode: &str) -> (Value, usize, bool) {
            use futures::FutureExt;
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            let _ = state.auto_tag_worker.notify.notified().now_or_never();
            append_refresh_imap(&server, "held after effect read");
            let before_gen = state.sync_engine.change_gen();
            let (entered, release) = crate::refresh_worker::test_hold_after_effect_read(&state);
            let request_id = format!("r3-late-{mode}");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":request_id, "accountId":"acc1", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("actual refresh must finish effect read before test mutation")
                .expect("post-effect gate signal");
            let written = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(written["totalCached"], json!(2), "real provider write must precede race gate");
            match mode {
                "source" => replace_refresh_source_same_epoch(&state),
                "owner" => {
                    let owner = written["nativeIdentity"].clone();
                    let mut foreign = owner.clone();
                    foreign["originHash"] = json!("foreign-native-owner");
                    crate::custody::with_conn(&state, |conn|
                        mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX",
                            &json!({"emails":[], "nativeIdentity":foreign,
                                "nativeExpectedIdentity":owner}).to_string())).unwrap();
                    assert_ne!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["nativeIdentity"],
                        written["nativeIdentity"], "owner replacement must take effect while worker is held");
                }
                "ticket" => state.sync_observation.invalidate_probe("acc1", Some("INBOX")),
                _ => panic!("unknown race mode"),
            }
            let woke = state.auto_tag_worker.notify.notified().now_or_never().is_some();
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, &format!("r3-late-{mode}")).await;
            let (_, changes) = state.sync_engine.wait_changes(before_gen, 0).await;
            (settled, changes.len(), woke)
        }

        #[tokio::test]
        async fn r3_source_changed_after_effect_read_cannot_publish_or_succeed() {
            let (receipt, changes, woke) = late_effect_publication_observation("source").await;
            assert!(receipt["status"] == "failed" && changes == 0 && !woke,
                "R3 post-effect source replacement must prevent stale publication, wake and success; receipt={receipt:?}; changes={changes}; woke={woke}");
        }

        #[tokio::test]
        async fn r3_owner_changed_after_effect_read_cannot_publish_or_succeed() {
            let (receipt, changes, woke) = late_effect_publication_observation("owner").await;
            assert!(receipt["status"] == "failed" && changes == 0 && !woke,
                "R3 post-effect owner replacement must prevent stale publication, wake and success; receipt={receipt:?}; changes={changes}; woke={woke}");
        }

        #[tokio::test]
        async fn r3_ticket_invalidated_after_effect_read_cannot_publish_or_succeed() {
            let (receipt, changes, woke) = late_effect_publication_observation("ticket").await;
            assert!(receipt["status"] == "failed" && changes == 0 && !woke,
                "R3 post-effect ticket invalidation must prevent stale publication, wake and success; receipt={receipt:?}; changes={changes}; woke={woke}");
        }

        #[tokio::test]
        async fn c5_old_owner_drop_preserves_new_view_while_refresh_is_held() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .mailbox(synthetic_mailbox("Sent", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings":{"state":{"refreshOnLaunch":false,"refreshInterval":0}},
            }), None).unwrap();
            let pause = server.pause_command("SELECT");
            let held = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"c5-held-owner-refresh","accountId":"acc1",
                "mailbox":"INBOX","reason":"manual",
            }))).await;
            assert!(held.error.is_none(), "held original must be admitted");
            let mut pause = tokio::task::spawn_blocking(move || {
                assert!(pause.entered(std::time::Duration::from_secs(10)));
                pause
            }).await.unwrap();
            let old = crate::refresh_worker::RefreshState::attach_owner(
                &state, "c5-owner-held".into(), 1).unwrap();
            let context = |revision| json!({"launchId":"c5-owner-held","revision":revision,
                "phase":"resume","view":{"accountId":"acc1","mailbox":"Sent"}});
            assert_eq!(boxed_request(&state, req("sync.context", context(1)))
                .await.result.unwrap()["accepted"], json!(true));
            let newer = crate::refresh_worker::RefreshState::attach_owner(
                &state, "c5-owner-held".into(), 2).unwrap();
            assert_eq!(boxed_request(&state, req("sync.context", context(2)))
                .await.result.unwrap()["accepted"], json!(true));
            drop(old);
            let active = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"c5-new-owner-view","reason":"scheduled",
            }))).await.result.unwrap();
            assert_eq!(active["receipt"]["accountResults"][0]["mailbox"], json!("Sent"),
                "old drop must leave new owner's view priority while provider waits");
            drop(newer);
            let detached = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"c5-detached-owner-view","reason":"scheduled",
            }))).await.result.unwrap();
            assert_eq!(detached["receipt"]["accountResults"][0]["mailbox"], json!("INBOX"),
                "last owner loss returns automatic target to INBOX");
            pause.release();
            assert_eq!(terminal_refresh(&state, "c5-held-owner-refresh").await["status"], json!("complete"));
            assert_eq!(terminal_refresh(&state, "c5-new-owner-view").await["status"], json!("complete"));
            assert_eq!(terminal_refresh(&state, "c5-detached-owner-view").await["status"], json!("complete"));
        }

        #[tokio::test]
        async fn c5_captured_ordinary_unified_and_subtree_views_select_real_mailboxes() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .mailbox(synthetic_mailbox("Sent", 1))
                .mailbox(synthetic_mailbox("Projects", 1))
                .mailbox(synthetic_mailbox("Projects/2026", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let row = |id: &str| json!({"id":id,"email":"user@example.com","authType":"password",
                "imapHost":server.host(),"imapPort":server.port(),"imapSecure":false});
            std::fs::write(state.app_dir.join("accounts.json"),
                json!([row("acc1"),row("acc2")]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let credential = |id: &str| json!({"id":id,"email":"user@example.com",
                "authType":"password","password":"hunter2","imapHost":server.host(),
                "imapPort":server.port(),"imapSecure":false}).to_string();
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({"acc1":credential("acc1"),
                "acc2":credential("acc2")}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings":{"state":{"refreshOnLaunch":false,"refreshInterval":0}},
            }), None).unwrap();
            let context = |revision: u64, view: Value| json!({"launchId":"c5-target-view",
                "revision":revision,"phase":"start","view":view});
            assert_eq!(boxed_request(&state, req("sync.context", context(1,
                json!({"accountId":"acc1","mailbox":"Sent"})))).await.result.unwrap()["accepted"], true);
            let ordinary = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"c5-ordinary-targets","reason":"manual",
            }))).await.result.unwrap()["receipt"].clone();
            assert_eq!(ordinary["accountResults"][0]["mailbox"], json!("Sent"));
            assert_eq!(ordinary["accountResults"][1]["mailbox"], json!("INBOX"));
            let _ = terminal_refresh(&state, "c5-ordinary-targets").await;
            assert!(refresh_status_selects(&server, "Sent") > 0
                && refresh_status_selects(&server, "INBOX") > 0,
                "ordinary selection must reach real per-account folders");
            assert_eq!(boxed_request(&state, req("sync.context", context(2,
                json!({"accountId":null,"mailbox":"UNIFIED","unifiedFolder":"Sent"})))).await.result.unwrap()["accepted"], true);
            let unified = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"c5-unified-targets","mailbox":"UNIFIED","reason":"manual",
            }))).await.result.unwrap()["receipt"].clone();
            assert_eq!(unified["accountResults"].as_array().unwrap().len(), 2);
            assert!(unified["accountResults"].as_array().unwrap().iter().all(|row| row["mailbox"] == "Sent"));
            let _ = terminal_refresh(&state, "c5-unified-targets").await;
            assert!(server.commands().iter().all(|line| !line.contains("SELECT UNIFIED")),
                "UNIFIED may never reach provider SELECT");
            assert_eq!(boxed_request(&state, req("sync.context", context(3,
                json!({"accountId":"acc1","mailbox":"Projects",
                    "scopePaths":["Projects","Projects/2026"]})))).await.result.unwrap()["accepted"], true);
            let subtree = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"c5-subtree-targets","reason":"manual",
            }))).await.result.unwrap()["receipt"].clone();
            let paths: Vec<_> = subtree["accountResults"].as_array().unwrap().iter()
                .map(|row| (row["accountId"].as_str().unwrap().to_owned(),
                    row["mailbox"].as_str().unwrap().to_owned())).collect();
            assert_eq!(paths, vec![("acc1".into(),"Projects".into()),
                ("acc1".into(),"Projects/2026".into()),("acc2".into(),"INBOX".into())]);
            let _ = terminal_refresh(&state, "c5-subtree-targets").await;
            assert!(refresh_status_selects(&server, "Projects") > 0
                && refresh_status_selects(&server, "Projects/2026") > 0);
        }

        #[tokio::test]
        async fn r7_premium_classification_source_replaced_after_initial_check_cannot_enqueue() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings":{"state":{"billingProfile":{
                    "hasSubscription":true,"clientAccessGranted":true}}},
            }), None).unwrap();
            assert_eq!(state.classification.queue_depth().await, 0);
            let status_before = refresh_status_selects(&server, "INBOX");
            let (entered, release, finished) =
                crate::classification_worker::test_hold_before_enqueue(&state);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r7-premium-late-enqueue", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("Premium candidate must load real cached headers before enqueue")
                .expect("classification enqueue gate signal");
            assert!(refresh_status_selects(&server, "INBOX") > status_before,
                "classification candidate must follow an actual native provider refresh");
            assert_eq!(state.classification.queue_depth().await, 0,
                "queued rows must still be absent at the exact pre-insertion race gate");
            replace_refresh_source_same_epoch(&state);
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(10), finished).await
                .expect("classification enqueue attempt must finish").expect("completion signal");
            let settled = terminal_refresh(&state, "r7-premium-late-enqueue").await;
            assert_eq!(settled["status"], json!("complete"),
                "header refresh itself completed before classification source changed");
            let depth = state.classification.queue_depth().await;
            assert_eq!(depth, 0,
                "R7 Premium classification must not enqueue old-source headers after source replacement; depth={depth}");
        }

        #[tokio::test]
        async fn r7_premium_classification_owner_replaced_after_header_read_cannot_enqueue() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_account(&state, &server);
            seed_refresh_imap(&state, account).await;
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings":{"state":{"billingProfile":{
                    "hasSubscription":true,"clientAccessGranted":true}}},
            }), None).unwrap();
            let (entered, release, finished) =
                crate::classification_worker::test_hold_before_enqueue(&state);
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r7-premium-owner-late-enqueue", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("real cached headers must be read before owner replacement")
                .expect("classification enqueue gate signal");
            let saved = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let owner = saved["nativeIdentity"].clone();
            let mut foreign = owner.clone();
            foreign["originHash"] = json!("r7-foreign-cache-owner");
            crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX",
                    &json!({"emails":[], "nativeIdentity":foreign,
                        "nativeExpectedIdentity":owner}).to_string())).unwrap();
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(10), finished).await
                .expect("classification enqueue attempt must finish").expect("completion signal");
            assert_eq!(terminal_refresh(&state, "r7-premium-owner-late-enqueue").await["status"],
                json!("complete"));
            assert_eq!(state.classification.queue_depth().await, 0,
                "R7 cached-header owner replacement must suppress stale classification rows");
        }

        #[tokio::test]
        async fn r3_jmap_strict_touched_sources_revalidate_at_final_publication() {
            use futures::FutureExt;
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(2));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            assert!(state.sync_engine.sync_account(&account, "Work").await.success);
            let _ = state.auto_tag_worker.notify.notified().now_or_never();
            let before_gen = state.sync_engine.change_gen();
            let mut new = crate::jmap_test_support::email("r3-both-mailboxes", "both source rows",
                "2026-10-04T10:00:00Z");
            new.also_in.push("mb-work".into());
            mock.mutate(|server| server.add_email("acc1", "mb-inbox", new));
            let (entered, release) =
                crate::sync_jmap::source_write_test_pause::install(&state, "strict-publish");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"r3-jmap-strict-late-source", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("real JMAP delta must reach post-source-read publication gate")
                .expect("strict publication gate signal");
            let (_, before_release) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert!(before_release.is_empty(), "strict path cannot publish before final gate");
            replace_refresh_source_same_epoch(&state);
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "r3-jmap-strict-late-source").await;
            let (_, changes) = state.sync_engine.wait_changes(before_gen, 0).await;
            let woke = state.auto_tag_worker.notify.notified().now_or_never().is_some();
            assert!(settled["status"] == "failed" && changes.is_empty() && !woke,
                "R3 strict JMAP touched-source publication must refuse source replacement after source reads and before insertion, including wake; receipt={settled:?}; changes={changes:?}; woke={woke}");
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
        async fn refresh_jmap_complete_later_page_failure_publishes_only_proved_delta_once() {
            use futures::FutureExt;
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(801));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            let _ = state.auto_tag_worker.notify.notified().now_or_never();
            mock.mutate(|server| server.add_email("acc1", "mb-inbox",
                crate::jmap_test_support::email("later-failure-delta", "proved delivery",
                    "2026-10-04T10:00:00Z")));
            let before_gen = state.sync_engine.change_gen();
            let (entered, release) = crate::sync_jmap::source_write_test_pause::install(
                &state, "complete-midpage");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-later-failure", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(20), entered).await
                .expect("third real Complete page must be saved before later failure")
                .expect("midpage gate signal");
            let partial = jmap_refresh_cache_count(&state);
            assert!(partial > 501 && partial < 802,
                "successful older page must leave confirmed partial fill: {partial}");
            mock.mutate(|server| server.faults.push(mock_jmap::Fault::ServerFail {
                method: "Email/get".into(),
            }));
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "jmap-complete-later-failure").await;
            assert_eq!(settled["status"], json!("failed"),
                "a later provider failure cannot claim Complete: {settled:?}");
            assert_eq!(jmap_refresh_cache_count(&state), partial,
                "confirmed partial headers survive the failed later page");
            let (_, records) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert_eq!(records.len(), 1,
                "requested source publishes at most once after the Complete attempt: {records:?}");
            assert_eq!(records[0].mailbox, "INBOX");
            let delta_uid = jmap_refresh_ledger(&state).iter()
                .find_map(|(uid, id)| (id == "later-failure-delta").then_some(*uid)).unwrap();
            assert_eq!(records[0].arrival_uids, vec![delta_uid],
                "historical partial-fill UIDs may not be inferred as arrivals");
            assert!(state.auto_tag_worker.notify.notified().now_or_never().is_some(),
                "confirmed partial fill must wake Auto Tags once");
        }

        #[tokio::test]
        async fn refresh_jmap_complete_missing_email_get_row_preserves_old_headers() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            let before_ledger = jmap_refresh_ledger(&state);
            let before_get = mock.count_calls("Email/get");
            let (entered, release) = crate::sync_jmap::source_write_test_pause::install(
                &state, "complete-before-get");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-missing-get", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("final real Email/query page must precede Email/get")
                .expect("before-get gate signal");
            mock.mutate(|server| server.destroy_email("acc1", "e1"));
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "jmap-complete-missing-get").await;
            assert!(mock.count_calls("Email/get") > before_get,
                "Complete must issue the actual Email/get after successful query");
            assert_eq!(settled["status"], json!("failed"),
                "notFound in Email/get cannot claim Complete: {settled:?}");
            assert_eq!(jmap_refresh_cache_count(&state), 500);
            assert_eq!(jmap_refresh_ledger(&state), before_ledger,
                "missing get row may not mint its ledger UID");
        }

        #[tokio::test]
        async fn refresh_jmap_complete_competing_owner_after_first_page_refuses_later_writes() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let mock = mock_jmap::MockJmap::start(jmap_refresh_scenario(501));
            let (_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let account = bind_jmap_refresh(&state, &mock, imap_port);
            assert!(state.sync_engine.sync_account(&account, "INBOX").await.success);
            let before_ledger = jmap_refresh_ledger(&state);
            let before_gen = state.sync_engine.change_gen();
            let (entered, release) = crate::sync_jmap::source_write_test_pause::install(
                &state, "complete-first-page");
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"jmap-complete-owner-first-page", "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            tokio::time::timeout(std::time::Duration::from_secs(10), entered).await
                .expect("first real Complete page must be committed")
                .expect("first-page gate signal");
            let saved = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let owner = saved["nativeIdentity"].clone();
            let mut foreign = owner.clone();
            foreign["originHash"] = json!("foreign-complete-owner");
            crate::custody::with_conn(&state, |conn|
                mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX",
                    &json!({"emails":[], "nativeIdentity":foreign,
                        "nativeExpectedIdentity":owner}).to_string())).unwrap();
            release.send(()).unwrap();
            let settled = terminal_refresh(&state, "jmap-complete-owner-first-page").await;
            assert_eq!(settled["status"], json!("failed"),
                "competing native owner must prevent Complete: {settled:?}");
            assert_eq!(jmap_refresh_ledger(&state), before_ledger,
                "later page may not mint a UID under a competing owner");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()
                ["nativeIdentity"]["originHash"], json!("foreign-complete-owner"));
            let (_, records) = state.sync_engine.wait_changes(before_gen, 0).await;
            assert!(records.is_empty(), "competing owner suppresses stale source records: {records:?}");
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

        async fn graph_complete_source(state: &Arc<DaemonState>)
            -> (crate::imap::ImapConfig, crate::sync_observation::Origin) {
            let row = json!({"id":"acc1", "email":"complete@example.test", "authType":"oauth2",
                "oauth2Provider":"microsoft", "oauth2Transport":"graph"});
            std::fs::write(state.app_dir.join("accounts.json"), json!([row.clone()]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings": {"state": {
                    "graphFolderKeysAdopted": {"acc1": true},
                    "graphFolderKeysAdoptedFromListing": {"acc1": true},
                }},
            }), None).unwrap();
            let mut credential = row;
            credential["oauth2AccessToken"] = json!("synthetic-graph-complete");
            let config = crate::credentials::config_from_record(&credential).unwrap();
            let stamp = state.account_lifecycle.capture("acc1").unwrap();
            let origin = crate::sync_observation::origin(state, stamp).await.unwrap();
            (config, origin)
        }

        #[tokio::test]
        async fn refresh_graph_complete_follows_opaque_full_header_next_link() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, origin) = graph_complete_source(&state).await;
            let folders = json!({"value":[refresh_graph_folder("fld-complete", "Inbox")]});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let first = json!({"value":[refresh_graph_message("g-one", "first full header")],
                "@odata.nextLink":"{{GRAPH_BASE}}/me/mailFolders/fld-complete/messages?$skiptoken=opaque-page-two"});
            let second = json!({"value":[refresh_graph_message("g-two", "second full header")],
                "@odata.nextLink":null});
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, folders.to_string()), (200, batch.to_string()),
                (200, first.to_string()), (200, second.to_string()),
            ]);
            let added = crate::refresh_worker::graph_headers(&state, &origin, &config,
                "INBOX", crate::refresh_worker::Extent::Complete).await.unwrap();
            assert_eq!(added, 2);
            let cached = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(cached["totalCached"], json!(2));
            assert_eq!(cached["graphComplete"], json!(true));
            assert_eq!(cached["graphCompleteTotal"], json!(2));
            assert!(cached["emails"].as_array().unwrap().iter().any(|row|
                row["subject"] == "second full header"));
            assert_eq!(refresh_graph_map(&state, "acc1").await.unwrap().as_object().unwrap().len(), 2);
            let calls = crate::handlers::graph::test_graph_requests();
            assert_eq!(calls.len(), 4, "folder, batch and both full-header pages: {calls:?}");
            assert!(calls[2].path.contains("top=200") && calls[2].path.contains("skip=0"));
            assert!(calls[3].path.contains("skiptoken=opaque-page-two")
                && !calls[3].path.contains("skip=200"), "opaque continuation must be followed: {calls:?}");
        }

        #[tokio::test]
        async fn refresh_graph_complete_failed_continuation_keeps_first_owned_page() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, origin) = graph_complete_source(&state).await;
            let folders = json!({"value":[refresh_graph_folder("fld-complete", "Inbox")]});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let first = json!({"value":[refresh_graph_message("g-one", "first survives")],
                "@odata.nextLink":"{{GRAPH_BASE}}/me/mailFolders/fld-complete/messages?$skiptoken=failed-page"});
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, folders.to_string()), (200, batch.to_string()),
                (200, first.to_string()), (503, "temporary provider refusal".into()),
            ]);
            let outcome = crate::refresh_worker::graph_headers(&state, &origin, &config,
                "INBOX", crate::refresh_worker::Extent::Complete).await;
            assert!(outcome.is_err(), "failed provider page cannot claim Complete");
            let cached = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(cached["totalCached"], json!(1));
            assert_eq!(cached["graphComplete"], json!(false));
            assert_eq!(cached["emails"][0]["subject"], json!("first survives"));
            assert_eq!(refresh_graph_map(&state, "acc1").await.unwrap().as_object().unwrap().len(), 1);
            let calls = crate::handlers::graph::test_graph_requests();
            assert_eq!(calls.len(), 4);
            assert!(calls[3].path.contains("skiptoken=failed-page"));
        }

        #[tokio::test]
        async fn refresh_graph_complete_rejects_competing_cache_owner_before_second_page_allocation() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, origin) = graph_complete_source(&state).await;
            let folder = json!({"value":[refresh_graph_folder("fld-complete", "Inbox")]});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let first = json!({"value":[refresh_graph_message("first-id", "first page")],
                "@odata.nextLink":"{{GRAPH_BASE}}/me/mailFolders/fld-complete/messages?$skiptoken=second"});
            let second = json!({"value":[refresh_graph_message("second-id", "second page")],
                "@odata.nextLink":null});
            let mut pause = crate::handlers::graph::test_graph_paused_responses_after(vec![
                (200, folder.to_string()), (200, batch.to_string()),
                (200, first.to_string()), (200, second.to_string()),
            ], 3);
            let child_state = Arc::clone(&state);
            let child = tokio::spawn(async move {
                crate::refresh_worker::graph_headers(&child_state, &origin, &config,
                    "INBOX", crate::refresh_worker::Extent::Complete).await
            });
            (&mut pause.entered).await.expect("second real Graph page must wait after first page save");
            let saved = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(saved["totalCached"], json!(1));
            assert_eq!(saved["graphComplete"], json!(false));
            let first_owner = saved["nativeIdentity"].clone();
            let mut competing_owner = first_owner.clone();
            competing_owner["originHash"] = json!("competing-cache-owner");
            crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn,
                "acc1", "INBOX", &json!({"emails":[{"uid":77,"subject":"competing owner"}],
                    "nativeIdentity":competing_owner,"nativeExpectedIdentity":first_owner,
                    "graphComplete":false}).to_string())).unwrap();
            pause.release();
            assert_eq!(child.await.unwrap(), Err("errors.bulkIdentityChanged".to_owned()));
            let after = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(after["nativeIdentity"]["originHash"], json!("competing-cache-owner"));
            assert_eq!(after["totalCached"], json!(1));
            assert_eq!(after["emails"][0]["uid"], json!(77));
            assert_eq!(refresh_graph_map(&state, "acc1").await.unwrap().as_object().unwrap().len(), 1,
                "the second provider page must not mint a UID after owner replacement");
            let calls = crate::handlers::graph::test_graph_requests();
            assert_eq!(calls.len(), 4);
            assert!(calls[3].path.contains("skiptoken=second"));
        }

        #[tokio::test]
        async fn refresh_graph_static_ready_without_localized_listing_pairs_warms_headers() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, origin) = graph_complete_source(&state).await;
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings": {"state": {
                    "graphFolderKeysAdopted": {"acc1": true},
                    "graphFolderKeysAdoptedFromListing": {"acc1": false},
                }},
            }), None).unwrap();
            let folder = json!({"value":[refresh_graph_folder("fld-complete", "Inbox")]});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let page = json!({"value":[refresh_graph_message("no-pair-one", "first"),
                refresh_graph_message("no-pair-two", "second")], "@odata.nextLink":null});
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, folder.to_string()), (200, batch.to_string()), (200, page.to_string()),
            ]);
            let added = crate::refresh_worker::graph_headers(&state, &origin, &config,
                "INBOX", crate::refresh_worker::Extent::RefreshPage).await.unwrap();
            assert_eq!(added, 2, "zero localized adoption pairs permit the actual header page");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(2));
            assert_eq!(refresh_graph_map(&state, "acc1").await.unwrap().as_object().unwrap().len(), 2);
            assert_eq!(crate::handlers::graph::test_graph_requests().len(), 3);
        }

        #[tokio::test]
        async fn refresh_graph_same_numeric_uid_in_sent_keeps_separate_owned_headers() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, origin) = graph_complete_source(&state).await;
            for (mailbox, graph_id, subject) in [("INBOX", "inbox-id", "inbox row"),
                ("Sent", "sent-id", "sent row")] {
                let uids = crate::handlers::cache::graph_allocate_with_original(&state, &origin,
                    mailbox, Value::Null, vec![(graph_id.into(), None)]).await.unwrap();
                assert_eq!(uids, vec![1], "each real mailbox ledger starts with its own stable UID");
                let message: mailvault_core::graph::GraphMessage = serde_json::from_value(
                    refresh_graph_message(graph_id, subject)).unwrap();
                let added = crate::handlers::cache::graph_save_with_original(&state, &origin,
                    &config, mailbox, Value::Null, vec![message.to_email_header(uids[0])]).await.unwrap();
                assert_eq!(added, vec![1]);
            }
            let inbox = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            let sent = refresh_cached_headers(&state, "acc1", "Sent").unwrap();
            assert_eq!(inbox["emails"][0]["subject"], json!("inbox row"));
            assert_eq!(sent["emails"][0]["subject"], json!("sent row"));
            assert_eq!(inbox["emails"][0]["uid"], sent["emails"][0]["uid"]);
            assert_eq!(inbox["nativeIdentity"]["mailbox"], json!("INBOX"));
            assert_eq!(sent["nativeIdentity"]["mailbox"], json!("Sent"));
        }

        #[tokio::test]
        async fn refresh_graph_replaced_origin_during_provider_wait_cannot_mint_or_save() {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, origin) = graph_complete_source(&state).await;
            let folders = json!({"value":[refresh_graph_folder("fld-complete", "Inbox")]});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let page = json!({"value":[refresh_graph_message("stale-one", "must not save")],
                "@odata.nextLink":null});
            let mut pause = crate::handlers::graph::test_graph_paused_responses(vec![
                (200, folders.to_string()), (200, batch.to_string()), (200, page.to_string()),
            ]);
            let child_state = Arc::clone(&state);
            let child = tokio::spawn(async move {
                crate::refresh_worker::graph_headers(&child_state, &origin, &config,
                    "INBOX", crate::refresh_worker::Extent::RefreshPage).await
            });
            (&mut pause.entered).await.expect("real Graph folder request must wait");
            let replacement = json!([{"id":"acc1", "email":"replacement@example.test",
                "authType":"oauth2", "oauth2Provider":"microsoft", "oauth2Transport":"graph"}]);
            std::fs::write(state.app_dir.join("accounts.json"), replacement.to_string()).unwrap();
            pause.release();
            assert!(child.await.unwrap().is_err(), "replaced original must refuse publication");
            assert_eq!(refresh_graph_map(&state, "acc1").await, None,
                "stale Graph provider result may not mint a UID");
            assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX"), None,
                "stale Graph provider result may not save a header");
            assert_eq!(crate::handlers::graph::test_graph_requests().len(), 3);
        }

        #[tokio::test]
        async fn refresh_graph_complete_owned_baseline_announces_only_later_stable_arrival() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (_config, _origin) = graph_complete_source(&state).await;
            let credential = json!({"id":"acc1", "email":"complete@example.test",
                "authType":"oauth2", "oauth2Provider":"microsoft", "oauth2Transport":"graph",
                "oauth2AccessToken":"synthetic-graph-complete", "oauth2ExpiresAt":4_000_000_000_000i64});
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({"acc1":credential.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            let folder_two = refresh_graph_folder("fld-complete", "Inbox");
            let mut folder_three = folder_two.clone();
            folder_three["totalItemCount"] = json!(3);
            let mut folder_partial = folder_two.clone();
            folder_partial["totalItemCount"] = json!(201);
            let mut folder_after_partial = folder_two.clone();
            folder_after_partial["totalItemCount"] = json!(5);
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let old_one = refresh_graph_message("baseline-one", "baseline one");
            let old_two = refresh_graph_message("baseline-two", "baseline two");
            let delivery = refresh_graph_message("later-delivery", "later delivery");
            let partial = refresh_graph_message("partial-historical", "partial historical");
            let after_partial = refresh_graph_message("after-partial", "after partial");
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, json!({"value":[folder_two]}).to_string()),
                (200, batch.to_string()),
                (200, json!({"value":[old_one.clone(),old_two.clone()],"@odata.nextLink":null}).to_string()),
                (200, json!({"value":[folder_three]}).to_string()),
                (200, batch.to_string()),
                (200, json!({"value":[delivery.clone(),old_one.clone(),old_two.clone()],
                    "@odata.nextLink":null}).to_string()),
                (200, json!({"value":[folder_partial]}).to_string()),
                (200, batch.to_string()),
                (200, json!({"value":[partial.clone(),delivery.clone(),old_one.clone()],
                    "@odata.nextLink":"{{GRAPH_BASE}}/me/mailFolders/fld-complete/messages?$skiptoken=older"}).to_string()),
                (200, json!({"value":[folder_after_partial]}).to_string()),
                (200, batch.to_string()),
                (200, json!({"value":[after_partial,partial,delivery,old_one,old_two],
                    "@odata.nextLink":null}).to_string()),
            ]);
            let first_gen = state.sync_engine.change_gen();
            let first = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"graph-cold-baseline", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(first.error.is_none(), "cold Graph baseline ACK: {:?}", first.error);
            assert_eq!(terminal_refresh(&state, "graph-cold-baseline").await["status"], json!("complete"));
            let cold = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(cold["totalCached"], json!(2), "two provider IDs fully covered: {cold:?}");
            assert_eq!(cold["nativeIdentity"]["accountId"], json!("acc1"));
            assert_eq!(cold["graphComplete"], json!(true));
            assert_eq!(cold["graphCompleteTotal"], json!(2));
            let before_map = refresh_graph_map(&state, "acc1").await.unwrap();
            assert_eq!(before_map.as_object().unwrap().len(), 2);
            let (_, cold_changes) = state.sync_engine.wait_changes(first_gen, 0).await;
            assert!(cold_changes.iter().all(|record| record.arrival_uids.is_empty()),
                "cold Graph page cannot announce historical mail: {cold_changes:?}");

            let delivery_gen = state.sync_engine.change_gen();
            let second = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"graph-later-delivery", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(second.error.is_none(), "later Graph delivery ACK: {:?}", second.error);
            assert_eq!(terminal_refresh(&state, "graph-later-delivery").await["status"], json!("complete"));
            let after_map = refresh_graph_map(&state, "acc1").await.unwrap();
            for (old_uid, old_id) in before_map.as_object().unwrap() {
                assert_eq!(after_map.get(old_uid).unwrap(), old_id,
                    "reordered provider headers retain their existing ledger UID");
            }
            let uid = after_map.as_object().unwrap().iter().find_map(|(uid, graph_id)|
                (graph_id == "later-delivery").then(|| uid.parse::<u32>().unwrap())).unwrap();
            assert!(uid > before_map.as_object().unwrap().keys().map(|key| key.parse::<u32>().unwrap()).max().unwrap());
            let later = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(later["totalCached"], json!(3));
            assert_eq!(later["nativeIdentity"], cold["nativeIdentity"]);
            assert_eq!(later["graphComplete"], json!(true));
            let (_, delivery_changes) = state.sync_engine.wait_changes(delivery_gen, 0).await;
            assert_eq!(delivery_changes.len(), 1,
                "later provider delivery has one source-qualified publication: {delivery_changes:?}");
            assert_eq!(delivery_changes[0].arrival_uids, vec![uid],
                "Graph complete baseline and real new stable UID must announce exactly one arrival; changes={delivery_changes:?}");
            assert_eq!(delivery_changes[0].source.as_ref().unwrap().cache_owner.as_ref().unwrap().origin_hash.as_str(),
                cold["nativeIdentity"]["originHash"].as_str().unwrap());

            let partial_gen = state.sync_engine.change_gen();
            let third = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"graph-partial-page",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(third.error.is_none(), "partial Graph page ACK: {:?}", third.error);
            assert_eq!(terminal_refresh(&state, "graph-partial-page").await["status"], json!("complete"));
            let (_, partial_changes) = state.sync_engine.wait_changes(partial_gen, 0).await;
            assert!(partial_changes.iter().all(|record| record.arrival_uids.is_empty()),
                "partial Graph page cannot announce its newly minted historical UID: {partial_changes:?}");
            let partial_cache = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(partial_cache["graphComplete"], json!(false),
                "an incomplete page invalidates the previous complete baseline");

            let after_partial_gen = state.sync_engine.change_gen();
            let fourth = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"graph-after-partial", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(fourth.error.is_none(), "post-partial Graph ACK: {:?}", fourth.error);
            assert_eq!(terminal_refresh(&state, "graph-after-partial").await["status"], json!("complete"));
            let final_cache = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(final_cache["graphComplete"], json!(true));
            assert_eq!(final_cache["totalCached"], json!(5));
            let (_, after_partial_changes) = state.sync_engine.wait_changes(after_partial_gen, 0).await;
            assert!(after_partial_changes.iter().all(|record| record.arrival_uids.is_empty()),
                "a page after an invalidated baseline cannot announce historical mail: {after_partial_changes:?}");
            let calls = crate::handlers::graph::test_graph_requests();
            assert_eq!(calls.len(), 12, "four one-page refreshes each use folder/batch/messages: {calls:?}");
            assert_eq!(calls.iter().filter(|call| call.path.contains("/messages?")).count(), 4);

            let owner = final_cache["nativeIdentity"].clone();
            let after_partial_uid = refresh_graph_map(&state, "acc1").await.unwrap()
                .as_object().unwrap().iter().find_map(|(uid, graph_id)|
                    (graph_id == "after-partial").then(|| uid.parse::<u32>().unwrap())).unwrap();
            crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn,
                "acc1", "INBOX", &json!({"emails":[{"uid":99,"subject":"out-of-band row"}],
                    "removedUids":[after_partial_uid], "nativeIdentity":owner.clone(),
                    "nativeExpectedIdentity":owner}).to_string())).unwrap();
            let changed_count = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(changed_count["totalCached"], json!(5));
            assert_eq!(changed_count["graphComplete"], json!(true),
                "a generic cache writer may retain Graph's old metadata marker");
            assert!(!crate::handlers::cache::graph_baseline(&state, "acc1", "INBOX").await.unwrap().complete,
                "same-count UID replacement must invalidate the old marker by digest");
        }

        #[tokio::test]
        async fn s4_graph_real_body_code_or_provider_error_keeps_stable_uid_and_banner() {
            for fail_body in [false, true] {
                let _env_lock = crate::credentials::test_env_lock().lock()
                    .unwrap_or_else(|error| error.into_inner());
                let _env = CredentialsEnv::capture();
                let dir = tempfile::tempdir().unwrap();
                let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
                let (_config, _origin) = graph_complete_source(&state).await;
                let credential = json!({"id":"acc1", "email":"complete@example.test",
                    "authType":"oauth2", "oauth2Provider":"microsoft", "oauth2Transport":"graph",
                    "oauth2AccessToken":"synthetic-graph-complete", "oauth2ExpiresAt":4_000_000_000_000i64});
                let credentials = state.app_dir.join("credentials.json");
                std::fs::write(&credentials, json!({"acc1":credential.to_string()}).to_string()).unwrap();
                std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
                let folder = refresh_graph_folder("fld-complete", "Inbox");
                let mut folder_three = folder.clone();
                folder_three["totalItemCount"] = json!(3);
                let batch = json!({"responses":[{"id":"inbox","status":200,
                    "body":{"id":"fld-complete"}}]});
                let old_one = refresh_graph_message("baseline-one", "baseline one");
                let old_two = refresh_graph_message("baseline-two", "baseline two");
                let subject = "Password Reset Request";
                let delivery = refresh_graph_message("later-code", subject);
                let mut full = delivery.clone();
                full["body"] = json!({"contentType":"html",
                    "content":"<p>Use your verification code <strong>364758</strong> to sign in.</p>"});
                let body_response = if fail_body {
                    (404, "missing Graph body".to_owned())
                } else { (200, full.to_string()) };
                let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                    (200, json!({"value":[folder]}).to_string()),
                    (200, batch.to_string()),
                    (200, json!({"value":[old_one.clone(),old_two.clone()],
                        "@odata.nextLink":null}).to_string()),
                    (200, json!({"value":[folder_three]}).to_string()),
                    (200, batch.to_string()),
                    (200, json!({"value":[delivery,old_one,old_two],
                        "@odata.nextLink":null}).to_string()),
                    body_response,
                ]);
                let baseline = boxed_request(&state, req("sync.refresh", json!({
                    "requestId":"s4-graph-code-baseline", "accountId":"acc1",
                    "mailbox":"INBOX", "reason":"manual",
                }))).await;
                assert!(baseline.error.is_none(), "real Graph baseline ACK: {:?}", baseline.error);
                assert_eq!(terminal_refresh(&state, "s4-graph-code-baseline").await["status"], json!("complete"));
                let before = state.sync_engine.change_gen();
                let request_id = if fail_body { "s4-graph-code-fail" } else { "s4-graph-code" };
                let accepted = boxed_request(&state, req("sync.refresh", json!({
                    "requestId":request_id, "accountId":"acc1",
                    "mailbox":"INBOX", "reason":"manual",
                }))).await;
                assert!(accepted.error.is_none(), "real Graph delivery ACK: {:?}", accepted.error);
                assert_eq!(terminal_refresh(&state, request_id).await["status"], json!("complete"));
                let ledger = refresh_graph_map(&state, "acc1").await.unwrap();
                let uid = ledger.as_object().unwrap().iter().find_map(|(uid, id)|
                    (id == "later-code").then(|| uid.parse::<u32>().unwrap()))
                    .expect("the provider ID receives a stable native UID");
                let mut events = state.events.subscribe();
                let reply = boxed_request(&state, req("sync.events", json!({
                    "since":before,"timeoutMs":1000,
                }))).await.result.unwrap();
                assert!(reply["changes"].as_array().unwrap().iter().any(|row|
                    row["arrivalUids"] == json!([uid])),
                    "Graph arrival must keep its ledger UID: {reply:?}");
                let (notice, code) = tokio::time::timeout(std::time::Duration::from_secs(7), async {
                    let mut notice = None;
                    loop {
                        let line = events.recv().await.expect("native Graph event channel stays live");
                        if let Some((name, payload)) = mailvault_core::daemon_ipc::parse_event(&line) {
                            if name == "notify" { notice = Some(payload); }
                            else if name == "code-ready" { break (notice, Some(payload)); }
                            if fail_body && notice.is_some() { break (notice, None); }
                        }
                    }
                }).await.expect("real Graph body outcome must finish within the bounded child");
                let notice = notice.expect("a proved Graph UID retains its banner on body failure");
                assert_eq!(notice["uids"], json!([uid]));
                assert_eq!(notice["banner"], json!(true));
                if fail_body {
                    assert!(code.is_none(), "Graph 404 must not offer a code");
                    assert!(notice["target"].get("code").is_none());
                } else {
                    let code = code.expect("real Graph body supplies a code-ready event");
                    assert_eq!(code["uid"], json!(uid));
                    assert_eq!(code["code"], json!("364758"));
                }
                let calls = crate::handlers::graph::test_graph_requests();
                assert_eq!(calls.len(), 7, "the child must read the actual Graph message once: {calls:?}");
                assert!(calls[6].path.contains("/me/messages/later-code?"));
                assert_eq!(calls[6].headers.get("authorization").map(String::as_str),
                    Some("Bearer synthetic-graph-complete"));
            }
        }

        #[tokio::test]
        async fn refresh_graph_foreign_complete_owner_cannot_announce_historical_arrivals() {
            use sha2::{Digest, Sha256};
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let (config, _origin) = graph_complete_source(&state).await;
            let credential = json!({"id":"acc1", "email":"complete@example.test",
                "authType":"oauth2", "oauth2Provider":"microsoft", "oauth2Transport":"graph",
                "oauth2AccessToken":"synthetic-graph-complete", "oauth2ExpiresAt":4_000_000_000_000i64});
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials, json!({"acc1":credential.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            let mut foreign_config = config.clone();
            foreign_config.email = "old-owner@example.test".into();
            let foreign = mailvault_core::imap::NativeHeaderIdentity::new(&foreign_config, "acc1", "INBOX", None);
            let digest = format!("{:x}", Sha256::digest(42u32.to_be_bytes()));
            crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn,
                "acc1", "INBOX", &json!({"emails":[{"uid":42,"subject":"old owner"}],
                    "nativeIdentity":foreign,"nativeExpectedIdentity":null,"graphComplete":true,
                    "graphCompleteTotal":1,"graphCompleteUidDigest":digest}).to_string())).unwrap();
            let seeded = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(seeded["graphComplete"], json!(true));
            let folder = json!({"value":[refresh_graph_folder("fld-complete", "Inbox")]});
            let batch = json!({"responses":[{"id":"inbox", "status":200,
                "body":{"id":"fld-complete"}}]});
            let page = json!({"value":[refresh_graph_message("new-owner-one", "historical one"),
                refresh_graph_message("new-owner-two", "historical two")],"@odata.nextLink":null});
            let _graph = crate::handlers::graph::test_graph_mock_with(vec![
                (200, folder.to_string()), (200, batch.to_string()), (200, page.to_string()),
            ]);
            let before = state.sync_engine.change_gen();
            let accepted = boxed_request(&state, req("sync.refresh", json!({
                "requestId":"graph-owner-transition", "accountId":"acc1",
                "mailbox":"INBOX", "reason":"manual",
            }))).await;
            assert!(accepted.error.is_none());
            assert_eq!(terminal_refresh(&state, "graph-owner-transition").await["status"], json!("complete"));
            let current = refresh_cached_headers(&state, "acc1", "INBOX").unwrap();
            assert_eq!(current["nativeIdentity"]["originHash"],
                json!(mailvault_core::bulk_worker::origin_hash(&config)));
            assert_eq!(current["graphComplete"], json!(true));
            assert_eq!(current["totalCached"], json!(2));
            assert!(current["emails"].as_array().unwrap().iter().all(|row| row["uid"] != 42));
            let (_, changes) = state.sync_engine.wait_changes(before, 0).await;
            assert!(changes.iter().all(|record| record.arrival_uids.is_empty()),
                "a complete cache from another owner cannot announce historical mail: {changes:?}");
            assert_eq!(crate::handlers::graph::test_graph_requests().len(), 3);
        }

        #[tokio::test]
        async fn c5_activation_watches_hidden_imap_jmap_skips_graph_then_reconciles_removal() {
            let _env_lock = crate::credentials::test_env_lock().lock()
                .unwrap_or_else(|error| error.into_inner());
            let _env = CredentialsEnv::capture();
            let dir = tempfile::tempdir().unwrap();
            let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
            let jmap = mock_jmap::MockJmap::start(crate::jmap_test_support::scenario());
            let (imap_trap, imap_port) = crate::jmap_test_support::imap_trap();
            let mut jmap_credential = crate::jmap_test_support::account_json(&jmap, imap_port);
            jmap_credential["id"] = json!("jmap");
            let mut jmap_row = jmap_credential.clone();
            jmap_row.as_object_mut().unwrap().remove("password");
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            let imap = |id: &str| json!({"id":id,"email":"user@example.com",
                "authType":"password","imapHost":server.host(),"imapPort":server.port(),
                "imapSecure":false});
            let graph = json!({"id":"graph","email":"graph@example.test","authType":"oauth2",
                "oauth2Provider":"microsoft","oauth2Transport":"graph"});
            std::fs::write(state.app_dir.join("accounts.json"),
                json!([imap("hidden"),imap("visible"),jmap_row.clone(),graph.clone()]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
                &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let stored = |id: &str| json!({"id":id,"email":"user@example.com",
                "authType":"password","password":"hunter2","imapHost":server.host(),
                "imapPort":server.port(),"imapSecure":false}).to_string();
            let credentials = state.app_dir.join("credentials.json");
            std::fs::write(&credentials,
                json!({"hidden":stored("hidden"),"visible":stored("visible"),
                    "jmap":jmap_credential.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", credentials);
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
            mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
                "mailvault-settings":{"state":{"refreshOnLaunch":false,"refreshInterval":0,
                    "hiddenAccounts":{"hidden":true,"jmap":true}}},
            }), None).unwrap();
            assert!(state.idle.status().await.is_empty(),
                "ordinary boot must not register native watchers");
            let accepted = boxed_request(&state, req("sync.context", json!({
                "launchId":"c5-watchers","revision":1,"phase":"start","view":null,
            }))).await;
            assert_eq!(accepted.result.unwrap()["accepted"], json!(true));
            let mut watched = Vec::new();
            for _ in 0..200 {
                let statuses = state.idle.status().await;
                let jmap_active = statuses.iter().any(|status|
                    status.account_id == "jmap" && status.mode.is_some());
                watched = statuses.into_iter().map(|status| status.account_id).collect();
                watched.sort();
                if watched == vec!["hidden".to_string(), "jmap".to_string(),
                    "visible".to_string()] && jmap_active { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert_eq!(watched, vec!["hidden".to_string(), "jmap".to_string(),
                "visible".to_string()],
                "hidden IMAP/JMAP remain watched and Graph never enters IDLE");
            assert!(state.idle.status().await.iter().any(|status|
                status.account_id == "jmap" && status.mode.is_some()),
                "JMAP must enter its push branch, not an IMAP watcher");
            assert!(imap_trap.accept().is_err(), "JMAP watcher may not dial IMAP");
            std::fs::write(state.app_dir.join("accounts.json"),
                json!([imap("hidden"),graph]).to_string()).unwrap();
            state.events.emit("accounts-changed", json!({}));
            for _ in 0..200 {
                watched = state.idle.status().await.into_iter()
                    .map(|status| status.account_id).collect();
                if watched == vec!["hidden".to_string()] { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert_eq!(watched, vec!["hidden".to_string()],
                "removed IMAP and JMAP watchers must be withdrawn");
            assert!(imap_trap.accept().is_err(), "JMAP removal may not dial IMAP");
            state.idle.shutdown().await;
        }

        mod s5_pipeline {
            use super::*;
            use mock_imap::{MockImap, Scenario};
            use mock_imap::state::synthetic_mailbox;

            type Rig = (std::sync::MutexGuard<'static, ()>, CredentialsEnv, tempfile::TempDir, Arc<DaemonState>, MockImap);

            fn rig(scenario: Scenario) -> Rig {
                let lock = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
                let env = CredentialsEnv::capture();
                let dir = tempfile::tempdir().unwrap();
                std::fs::write(dir.path().join("frontend-settings.json"),
                    json!({"mailvault-settings": {"state": {"fetchMode": "hoarder"}}}).to_string()).unwrap();
                let server = MockImap::start(scenario);
                let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
                bind_account(&state, &server);
                (lock, env, dir, state, server)
            }

            fn focus_params(revision: u64, online: bool, mailbox: &str) -> Value {
                json!({"revision": revision, "online": online, "focus": {
                    "accountId": "acc1", "mailbox": mailbox, "scope": "folder", "rows": []}})
            }

            fn vault_files(dir: &std::path::Path) -> usize {
                let cur = mailvault_core::vault_files::cur_path(dir, "acc1", "INBOX");
                std::fs::read_dir(cur).map_or(0, |entries| entries.count())
            }

            #[tokio::test]
            async fn s5_focus_returns_before_provider_work_and_the_header_warm_lands_in_the_cache() {
                let (_lock, _env, dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
                let pause = server.pause_command("SELECT");
                let started = std::time::Instant::now();
                let answer = boxed_request(&state, req("pipeline.focus", focus_params(1, true, "INBOX"))).await;
                assert!(started.elapsed() < std::time::Duration::from_secs(1),
                    "the answer must not wait for the provider: {:?}", started.elapsed());
                assert_eq!(answer.result, Some(json!({"revision": 1, "accepted": true})), "{answer:?}");
                let mut pause = tokio::task::spawn_blocking(move || {
                    assert!(pause.entered(std::time::Duration::from_secs(10)), "the header warm must reach the provider");
                    pause
                }).await.unwrap();
                let status = boxed_request(&state, req("pipeline.status", json!({}))).await.result.unwrap();
                assert_eq!(status["accounts"]["acc1"]["phase"], json!("headers"), "{status}");
                let foreground = tokio::time::timeout(std::time::Duration::from_secs(2),
                    boxed_request(&state, req("accounts.list", json!({})))).await;
                assert!(foreground.is_ok_and(|reply| reply.error.is_none()), "a foreground read stays live while the provider is held");
                pause.release();
                state.hoarder_worker.pipeline.quiet().await;
                assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(3));
                assert_eq!(vault_files(dir.path()), 0, "no candidate rows were sent: nothing was downloaded");
                assert_eq!(state.hoarder_worker.pipeline.admissions(), 1);
            }

            #[tokio::test]
            async fn s5_a_repeated_focus_does_not_warm_twice_but_an_emptied_cache_does() {
                let (_lock, _env, _dir, state, _server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
                for revision in [1, 2] {
                    let answer = boxed_request(&state, req("pipeline.focus", focus_params(revision, true, "INBOX"))).await;
                    assert!(answer.error.is_none(), "{answer:?}");
                    state.hoarder_worker.pipeline.quiet().await;
                }
                assert_eq!(state.hoarder_worker.pipeline.admissions(), 1, "the second identical focus adds no work");
                assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(2));
                crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::clear_headers(conn, Some("acc1"), Some("INBOX"))).unwrap();
                let answer = boxed_request(&state, req("pipeline.focus", focus_params(3, true, "INBOX"))).await;
                assert!(answer.error.is_none(), "{answer:?}");
                state.hoarder_worker.pipeline.quiet().await;
                assert_eq!(state.hoarder_worker.pipeline.admissions(), 2, "an emptied cache resets the warm");
                assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(2));
            }

            #[tokio::test]
            async fn s5_offline_admits_no_provider_work_until_the_next_online_focus() {
                let (_lock, _env, _dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
                let answer = boxed_request(&state, req("pipeline.focus", focus_params(1, false, "INBOX"))).await;
                assert!(answer.error.is_none(), "{answer:?}");
                state.hoarder_worker.pipeline.quiet().await;
                let status = boxed_request(&state, req("pipeline.status", json!({}))).await.result.unwrap();
                assert_eq!(status["accounts"]["acc1"]["pausedReason"], json!("offline"), "{status}");
                assert_eq!(state.hoarder_worker.pipeline.admissions(), 0);
                assert_eq!(commands_named(&server, "SELECT").len(), 0, "an offline focus touches no provider");
                let back = boxed_request(&state, req("pipeline.focus", focus_params(2, true, "INBOX"))).await;
                assert!(back.error.is_none(), "{back:?}");
                state.hoarder_worker.pipeline.quiet().await;
                assert_eq!(state.hoarder_worker.pipeline.admissions(), 1);
                assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(2));
            }

            #[tokio::test]
            async fn s5_the_accounts_own_sent_folder_is_warmed_alongside_the_focused_folder() {
                let (_lock, _env, _dir, state, _server) = rig(Scenario::new()
                    .mailbox(synthetic_mailbox("INBOX", 2)).mailbox(synthetic_mailbox("Sent Items", 4)));
                let listing = json!({"mailboxes": [{"path": "INBOX", "name": "INBOX"},
                    {"path": "Sent Items", "name": "Sent Items"}]}).to_string();
                crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_mailboxes(conn, "acc1", &listing)).unwrap();
                let answer = boxed_request(&state, req("pipeline.focus", focus_params(1, true, "INBOX"))).await;
                assert!(answer.error.is_none(), "{answer:?}");
                state.hoarder_worker.pipeline.quiet().await;
                assert_eq!(refresh_cached_headers(&state, "acc1", "INBOX").unwrap()["totalCached"], json!(2));
                assert_eq!(refresh_cached_headers(&state, "acc1", "Sent Items").unwrap()["totalCached"], json!(4),
                    "Sent is found by name in the cached folder list and warmed under its own key");
                assert_eq!(state.hoarder_worker.pipeline.admissions(), 2);
            }

            mod s6_bodies {
                use super::*;

                fn raw(uid: u32, date: Option<&str>) -> String {
                    format!("From: s@example.test\r\nTo: user@example.com\r\nSubject: m{uid}\r\n{}Message-ID: <s6-{uid}@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody {uid}\r\n",
                        date.map(|d| format!("Date: {d}\r\n")).unwrap_or_default())
                }

                fn add_messages(server: &MockImap, rows: &[(u32, Option<String>)]) {
                    server.mutate(|st| {
                        let mailbox = st.find_mut("INBOX").expect("mock INBOX");
                        for (uid, date) in rows {
                            // The server's own arrival date follows the message: old mail arrived long ago.
                            let internal = if date.as_deref().is_some_and(|d| d.contains("2020")) { "01-Jan-2020 12:00:00 +0000".to_owned() }
                                else { mock_imap::state::internal_date_string(chrono::Utc::now().timestamp_millis(), 0) };
                            mailbox.add(mock_imap::state::Message::new(*uid, raw(*uid, date.as_deref()))
                                .with_modseq(u64::from(*uid)).with_internal_date(&internal));
                        }
                    });
                }

                fn seed_cache(state: &Arc<DaemonState>, rows: &[(u32, &str)]) {
                    let emails: Vec<Value> = rows.iter().map(|(uid, date)| json!({"uid": uid, "date": date, "internalDate": date,
                        "subject": format!("m{uid}"), "flags": []})).collect();
                    let body = json!({"emails": emails, "totalEmails": emails.len()}).to_string();
                    crate::custody::with_conn(state, |conn| mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX", &body)).unwrap();
                }

                fn settings(dir: &std::path::Path, state: Value) {
                    std::fs::write(dir.join("frontend-settings.json"), json!({"mailvault-settings": {"state": state}}).to_string()).unwrap();
                }

                fn stored_uids(dir: &std::path::Path) -> Vec<u32> {
                    let cur = mailvault_core::vault_files::cur_path(dir, "acc1", "INBOX");
                    let mut uids: Vec<u32> = std::fs::read_dir(cur).into_iter().flatten().flatten()
                        .filter_map(|entry| entry.file_name().to_string_lossy().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok())
                        .collect();
                    uids.sort_unstable();
                    uids
                }

                fn body_fetches(server: &MockImap) -> Vec<u32> {
                    let mut uids: Vec<u32> = commands_named(server, "FETCH").into_iter()
                        .filter(|command| command.args.contains("BODY.PEEK[]"))
                        .filter_map(|command| command.args.split_whitespace().next()?.parse().ok()).collect();
                    uids.sort_unstable();
                    uids
                }

                async fn row_focus(state: &Arc<DaemonState>, revision: u64, uids: &[u32]) {
                    let rows: Vec<Value> = uids.iter().map(|uid| json!({"accountId": "acc1", "mailbox": "INBOX", "uid": uid})).collect();
                    let answer = boxed_request(state, req("pipeline.focus", json!({"revision": revision, "online": true,
                        "focus": {"accountId": "acc1", "mailbox": "INBOX", "scope": "folder", "rows": rows}}))).await;
                    assert!(answer.error.is_none(), "{answer:?}");
                }

                async fn pass_done(state: &Arc<DaemonState>) {
                    for _ in 0..600 {
                        let status = boxed_request(state, req("pipeline.status", json!({}))).await.result.unwrap();
                        if status["accounts"]["acc1"]["phase"] == json!("done") && status["accounts"]["acc1"]["queued"] == json!(0) { return; }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    panic!("the ordinary pass never finished");
                }

                #[tokio::test]
                async fn s6_keep_recent_stores_recent_and_unknown_dated_bodies_and_skips_old_and_saved_ones() {
                    let (_lock, _env, dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
                    settings(dir.path(), json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 3}));
                    let recent = chrono::Utc::now().to_rfc2822();
                    add_messages(&server, &[(2, Some(recent.clone())), (3, Some("Wed, 01 Jan 2020 12:00:00 +0000".into())), (4, None)]);
                    seed_cache(&state, &[(1, &recent), (2, &recent), (3, "2020-01-01T12:00:00Z"), (4, "garbage")]);
                    let encoded = { use base64::Engine; base64::engine::general_purpose::STANDARD.encode(raw(1, Some(&recent))) };
                    let stored = boxed_request(&state, req("maildir_store", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1,
                        "rawSourceBase64": encoded, "flags": []}))).await;
                    assert!(stored.error.is_none(), "{stored:?}");
                    row_focus(&state, 1, &[1, 2, 3, 4]).await;
                    pass_done(&state).await;
                    assert_eq!(stored_uids(dir.path()), vec![1, 2, 4], "recent and unknown-dated unsaved bodies are kept; the old one and the saved one are not fetched");
                    assert_eq!(body_fetches(&server), vec![2, 4], "exactly the wanted bodies crossed the wire");
                }

                #[tokio::test]
                async fn s6_on_demand_issues_zero_background_body_fetches() {
                    let (_lock, _env, dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
                    settings(dir.path(), json!({"fetchMode": "onDemand"}));
                    let now = chrono::Utc::now().to_rfc3339();
                    seed_cache(&state, &[(1, &now), (2, &now), (3, &now)]);
                    row_focus(&state, 1, &[1, 2, 3]).await;
                    pass_done(&state).await;
                    assert!(body_fetches(&server).is_empty(), "On Demand fetches nothing ahead");
                    assert!(stored_uids(dir.path()).is_empty());
                }

                /// Queue a pass by hand, the way `plan` would have derived it earlier, so a test
                /// can change the world between the derivation and the first fetch.
                async fn submit_pass(state: &Arc<DaemonState>, uids: &[u32], identity: Option<String>, origin_hash: String) {
                    let stamp = state.account_lifecycle.capture("acc1").unwrap();
                    let runner = &state.hoarder_worker.ordinary;
                    runner.retarget(1, Vec::new());
                    runner.submit_active(state, 1, crate::ordinary_runner::Spec { account_id: "acc1".into(), mailbox: "INBOX".into(),
                        stamp, origin_hash, identity, uids: uids.to_vec() });
                }

                async fn pass_over(state: &Arc<DaemonState>) {
                    for _ in 0..400 {
                        match state.hoarder_worker.ordinary.pass_snapshot("acc1") {
                            None | Some((crate::ordinary_runner::Status::Done, ..)) => return,
                            _ => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
                        }
                    }
                    panic!("the pass neither finished nor was dropped");
                }

                async fn account_origin(state: &Arc<DaemonState>) -> String {
                    let stamp = state.account_lifecycle.capture("acc1").unwrap();
                    crate::sync_observation::origin(state, stamp).await.unwrap().hash
                }

                fn repoint(state: &Arc<DaemonState>, server: &MockImap) {
                    let row = json!({"id": "acc1", "email": "user@example.com", "authType": "password",
                        "imapHost": server.host(), "imapPort": server.port(), "imapSecure": false});
                    std::fs::write(state.app_dir.join("accounts.json"), json!([row]).to_string()).unwrap();
                    let stored = json!({"id": "acc1", "email": "user@example.com", "authType": "password", "password": "hunter2",
                        "imapHost": server.host(), "imapPort": server.port(), "imapSecure": false}).to_string();
                    std::fs::write(state.app_dir.join("credentials.json"), json!({"acc1": stored}).to_string()).unwrap();
                }

                #[tokio::test]
                async fn s6_a_server_edit_after_the_queue_was_derived_fetches_and_writes_nothing() {
                    let (_lock, _env, dir, state, server_a) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
                    let server_b = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
                    let now = chrono::Utc::now().to_rfc3339();
                    seed_cache(&state, &[(1, &now), (2, &now)]);
                    let derived_under_a = account_origin(&state).await;
                    // The user edits the account in place: same lifetime, another server.
                    repoint(&state, &server_b);
                    submit_pass(&state, &[1, 2], None, derived_under_a).await;
                    pass_over(&state).await;
                    assert!(stored_uids(dir.path()).is_empty(), "uids of server A were not written from server B");
                    assert!(body_fetches(&server_b).is_empty(), "server B was never asked for a body of A's queue");
                    assert!(body_fetches(&server_a).is_empty());
                }

                #[tokio::test]
                async fn s6_account_removal_is_not_refused_while_a_body_fetch_is_held() {
                    let (_lock, _env, _dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
                    let recent = chrono::Utc::now().to_rfc2822();
                    add_messages(&server, &[(2, Some(recent.clone()))]);
                    seed_cache(&state, &[(1, &recent), (2, &recent)]);
                    // Warm first (cache non-empty, rows empty): the next FETCH is the body.
                    row_focus(&state, 1, &[]).await;
                    state.hoarder_worker.pipeline.quiet().await;
                    pass_done(&state).await;
                    let mut pause = server.pause_command("FETCH");
                    row_focus(&state, 2, &[1, 2]).await;
                    let mut pause = tokio::task::spawn_blocking(move || {
                        assert!(pause.entered(std::time::Duration::from_secs(15)), "the body fetch must reach the provider");
                        pause
                    }).await.unwrap();
                    // The real close path, not a membership shortcut: a fetch in flight is not a lifetime owner.
                    let lease = crate::account_workflows::AccountLease::detached_for_test(
                        crate::account_workflows::AccountWriteScope { ids: ["acc1".to_owned()].into(), ..Default::default() });
                    let claim = state.account_lifecycle.try_close(lease, "acc1");
                    assert!(claim.is_ok(), "removal was refused for the length of a body fetch: {:?}", claim.err());
                    let mut claim = claim.unwrap();
                    let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(2)).await;
                    assert!(drained.is_ok(), "the held fetch kept the account from draining: {:?}", drained.err());
                    pause.release();
                }

                #[tokio::test]
                async fn s6_a_large_inbox_cascade_reads_the_cache_in_bounded_pages() {
                    let (_lock, _env, _dir, state, _server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
                    // One custody connection serves every reader: a single read of a whole
                    // INBOX would stall foreground header reads and flag writes behind it.
                    let rows: Vec<(u32, String)> = (1..=2500u32).map(|uid| (uid, "2026-08-10T12:00:00Z".to_owned())).collect();
                    let refs: Vec<(u32, &str)> = rows.iter().map(|(uid, date)| (*uid, date.as_str())).collect();
                    seed_cache(&state, &refs);
                    let stamp = state.account_lifecycle.capture("acc1").unwrap();
                    let hash = account_origin(&state).await;
                    let origin = crate::ordinary_runner::Origin { account_id: "acc1".into(), stamp, origin_hash: hash };
                    let spec = crate::pipeline_focus::derive_cascade(&state, &origin).await.expect("the INBOX is derived");
                    assert_eq!(spec.uids.len(), 2500, "every cached row is a candidate in Hoarder mode");
                    assert_eq!(spec.uids.first(), Some(&1));
                    assert!(crate::pipeline_focus::cache_reads_of("acc1") >= 3,
                        "a 2,500-row cache was read in {} custody hold(s), not in bounded pages", crate::pipeline_focus::cache_reads_of("acc1"));
                }

                #[tokio::test]
                async fn s6_a_failed_write_is_retried_and_never_counted_as_done() {
                    let (_lock, _env, dir, state, _server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
                    let hash = account_origin(&state).await;
                    // The vault is being moved: the write fails, which is not a download-mode decision.
                    state.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
                    submit_pass(&state, &[1], None, hash).await;
                    let mut seen = None;
                    for _ in 0..200 {
                        seen = state.hoarder_worker.ordinary.pass_snapshot("acc1");
                        if matches!(seen, Some((crate::ordinary_runner::Status::RetryWait { .. }, ..))) { break; }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    let (status, queued, completed, _) = seen.expect("the pass is still there");
                    assert!(matches!(status, crate::ordinary_runner::Status::RetryWait { .. }), "{status:?}");
                    assert_eq!((queued, completed), (1, 0), "the message is waiting for another try, not finished");
                    state.vault_closed.store(false, std::sync::atomic::Ordering::SeqCst);
                    assert!(stored_uids(dir.path()).is_empty());
                }

                #[tokio::test]
                async fn s6_a_uidvalidity_reset_before_the_fetch_stores_nothing() {
                    let (_lock, _env, dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
                    let hash = account_origin(&state).await;
                    let seed = json!({"emails": [{"uid": 1, "subject": "m1", "date": chrono::Utc::now().to_rfc3339()}], "totalEmails": 1,
                        "nativeIdentity": {"accountId": "acc1", "mailbox": "INBOX", "uidValidity": 1, "originHash": hash},
                        "nativeExpectedIdentity": null}).to_string();
                    crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX", &seed)).unwrap();
                    let identity = crate::custody::with_conn(&state, |conn|
                        mailvault_core::custody::cache::native_identity(conn, "acc1", "INBOX")).unwrap()
                        .map(|identity| serde_json::to_string(&identity).unwrap());
                    assert!(identity.is_some(), "the cache carries the identity the queue is derived under");
                    // The server's mailbox was reset: UID 1 now names another message.
                    server.mutate(|st| st.find_mut("INBOX").expect("INBOX").uid_validity = 2);
                    submit_pass(&state, &[1], identity, hash).await;
                    pass_over(&state).await;
                    assert!(stored_uids(dir.path()).is_empty(), "a body of the new mailbox lifetime was not stored under the old uid");
                }

                #[tokio::test]
                async fn s6_a_retired_account_never_publishes_a_body_it_was_holding() {
                    let (_lock, _env, dir, state, server) = rig(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
                    let recent = chrono::Utc::now().to_rfc2822();
                    add_messages(&server, &[(2, Some(recent.clone()))]);
                    seed_cache(&state, &[(1, &recent), (2, &recent)]);
                    // Warm first (cache non-empty, rows empty): the next FETCH is the body.
                    row_focus(&state, 1, &[]).await;
                    state.hoarder_worker.pipeline.quiet().await;
                    pass_done(&state).await;
                    let before = body_fetches(&server).len();
                    let mut pause = server.pause_command("FETCH");
                    row_focus(&state, 2, &[1, 2]).await;
                    let mut pause = tokio::task::spawn_blocking(move || {
                        assert!(pause.entered(std::time::Duration::from_secs(15)), "the body fetch must reach the provider");
                        pause
                    }).await.unwrap();
                    state.account_lifecycle.apply_committed_membership(None, &mailvault_core::accounts_doc::MembershipDelta {
                        removed: ["acc1".to_owned()].into(), ..Default::default() });
                    pause.release();
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    assert!(stored_uids(dir.path()).is_empty(), "the old lifetime wrote nothing after its removal");
                    assert!(body_fetches(&server).len() <= before + 1, "and the retired pass fetched no further body");
                }
            }
        }
    }

    #[tokio::test]
    async fn c5_context_start_activates_once_after_dormant_boot() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["acc1"]);
        let dormant = handle_request_for_test(&state, "sync.refresh_status", json!({})).await.result.unwrap();
        assert_eq!(dormant["automaticEnabled"], json!(false));
        assert_eq!(dormant["receipts"], json!([]), "ordinary boot cannot start a native refresh");
        let request = json!({"launchId":"c5-first-launch", "revision":1,
            "phase":"start", "view":null});
        let started = handle_request_for_test(&state, "sync.context", request.clone()).await;
        assert!(started.result.as_ref().is_some_and(|result| result["accepted"] == true),
            "C5 start context route must acknowledge native activation: {started:?}");
        assert_eq!(started.result.as_ref().unwrap()["revision"], json!(1));
        let mut receipts = Vec::new();
        for _ in 0..200 {
            let status = handle_request_for_test(&state, "sync.refresh_status", json!({})).await.result.unwrap();
            receipts = status["receipts"].as_array().unwrap().clone();
            if !receipts.is_empty() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(receipts.len(), 1, "first start with an authoritative account consumes one launch attempt");
        let retry = handle_request_for_test(&state, "sync.context", request).await;
        assert_eq!(retry.result.as_ref().unwrap()["accepted"], json!(true));
        let after = handle_request_for_test(&state, "sync.refresh_status", json!({})).await.result.unwrap();
        assert_eq!(after["automaticEnabled"], json!(true));
        assert_eq!(after["contextRevision"], json!(1));
        assert_eq!(after["receipts"].as_array().unwrap().len(), 1,
            "same live-daemon start retry cannot enqueue another launch attempt");
    }

    #[tokio::test]
    async fn c5_context_resume_on_new_instance_never_replays_launch() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["acc1"]);
        let resumed = handle_request_for_test(&state, "sync.context", json!({
            "launchId":"c5-reconnect", "revision":1, "phase":"resume", "view":null,
        })).await;
        assert!(resumed.result.as_ref().is_some_and(|result| result["accepted"] == true),
            "C5 resume context route must accept a new instance without launch replay: {resumed:?}");
        let later = handle_request_for_test(&state, "sync.context", json!({
            "launchId":"c5-reconnect", "revision":2, "phase":"start", "view":null,
        })).await;
        assert_eq!(later.result.as_ref().unwrap()["accepted"], json!(true));
        let status = handle_request_for_test(&state, "sync.refresh_status", json!({})).await.result.unwrap();
        assert_eq!(status["automaticEnabled"], json!(true));
        assert_eq!(status["contextRevision"], json!(2));
        assert_eq!(status["receipts"], json!([]),
            "a launch first observed as resume may never queue a new launch refresh");
    }

    #[tokio::test]
    async fn c5_context_revision_and_strict_view_validation() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.seed_accounts_for_test(&["acc1"]);
        mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).patch(&json!({
            "mailvault-settings":{"state":{"refreshOnLaunch":false}},
        }), None).unwrap();
        let request = json!({"launchId":"c5-revision", "revision":4, "phase":"start",
            "view":{"accountId":"acc1","mailbox":"INBOX"}});
        let first = handle_request_for_test(&state, "sync.context", request.clone()).await;
        assert!(first.result.as_ref().is_some_and(|result| result["accepted"] == true),
            "C5 context route must accept an authoritative ordinary view: {first:?}");
        let duplicate = handle_request_for_test(&state, "sync.context", request.clone()).await;
        assert_eq!(duplicate.result.as_ref().unwrap()["accepted"], json!(true));
        let lower = handle_request_for_test(&state, "sync.context", json!({
            "launchId":"c5-revision", "revision":3, "phase":"start", "view":null,
        })).await;
        assert_eq!(lower.result.as_ref().unwrap()["accepted"], json!(false));
        let mut conflict = request.clone();
        conflict["view"]["mailbox"] = json!("Sent");
        assert_eq!(handle_request_for_test(&state, "sync.context", conflict).await.error.unwrap().code,
            ipc::INVALID_PARAMS, "equal revision with different view must be invalid");
        for malformed in [
            json!({"launchId":"c5-revision","revision":-1,"phase":"start","view":null}),
            json!({"launchId":"c5-revision","revision":9007199254740992u64,"phase":"start","view":null}),
            json!({"launchId":"c5-revision","revision":5,"phase":"start","view":null,"password":"synthetic"}),
            json!({"launchId":"c5-revision","revision":5,"phase":"start",
                "view":{"accountId":null,"mailbox":"INBOX"}}),
        ] {
            assert_eq!(handle_request_for_test(&state, "sync.context", malformed).await.error.unwrap().code,
                ipc::INVALID_PARAMS, "malformed context cannot activate a provider target");
        }
        let status = handle_request_for_test(&state, "sync.refresh_status", json!({})).await.result.unwrap();
        assert_eq!(status["contextRevision"], json!(4));
        assert_eq!(status["receipts"], json!([]));
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
    async fn c5_sync_owner_notification_ack_reuses_same_channel_generation() {
        let served = Served::start().await;
        let (mut lines, mut w) = open_channel(&served).await;
        let owner = r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"c5-owner","revision":1}}"#;
        send(&mut w, owner).await;
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), recv(&mut lines)).await;
        assert!(first.is_ok(), "C5 same-channel sync.owner must emit a matching acknowledgement");
        let first = first.unwrap();
        assert_eq!(first["method"], json!("event"));
        assert_eq!(first["params"]["name"], json!("sync-owner"));
        let acknowledged = &first["params"]["payload"];
        assert_eq!(acknowledged["launchId"], json!("c5-owner"));
        assert_eq!(acknowledged["revision"], json!(1));
        assert_eq!(acknowledged["accepted"], json!(true));
        let generation = acknowledged["ownerGeneration"].as_u64()
            .expect("accepted same-channel owner must expose its native generation");
        let instance = handle_request_for_test(&served.state, "sync.refresh_status", json!({}))
            .await.result.unwrap()["instanceId"].clone();
        assert_eq!(acknowledged["instanceId"], instance);

        send(&mut w, owner).await;
        let duplicate = tokio::time::timeout(std::time::Duration::from_secs(2), recv(&mut lines))
            .await.expect("identical lost-ACK retry must receive an acknowledgement");
        assert_eq!(duplicate["params"]["name"], json!("sync-owner"));
        assert_eq!(duplicate["params"]["payload"]["accepted"], json!(true));
        assert_eq!(duplicate["params"]["payload"]["ownerGeneration"], json!(generation),
            "same tuple on the same socket may not replace its guard");

        send(&mut w, r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"c5-owner","revision":0}}"#).await;
        let stale = tokio::time::timeout(std::time::Duration::from_secs(2), recv(&mut lines))
            .await.expect("stale owner tuple must be explicitly acknowledged");
        assert_eq!(stale["params"]["name"], json!("sync-owner"));
        assert_eq!(stale["params"]["payload"]["accepted"], json!(false));
        served.stop();
    }


    #[tokio::test]
    async fn s4_same_channel_newer_owner_revision_recovers_without_reclaiming_stale_guard() {
        let served = Served::start().await;
        let (mut lines, mut writer) = open_channel(&served).await;
        send(&mut writer, r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"s4-live","revision":1}}"#).await;
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), recv(&mut lines))
            .await.expect("first real same-channel owner ACK");
        assert_eq!(first["params"]["payload"]["accepted"], json!(true));
        let first_generation = first["params"]["payload"]["ownerGeneration"].as_u64().unwrap();
        let admitted = handle_request_for_test(&served.state, "sync.context", json!({
            "launchId":"s4-live","revision":1,"phase":"resume","view":null,
        })).await.result.unwrap();
        assert_eq!(admitted["accepted"], json!(true));

        send(&mut writer, r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"s4-live","revision":2}}"#).await;
        let newer = tokio::time::timeout(std::time::Duration::from_secs(2), recv(&mut lines))
            .await.expect("newer same-channel owner ACK must be bounded");
        assert_eq!(newer["params"]["name"], json!("sync-owner"));
        assert_eq!(newer["params"]["payload"]["accepted"], json!(true),
            "W4S4_OWNER_REVISION_RED: a live launch's newer revision must replace its own same-channel guard: {newer:?}");
        let newer_generation = newer["params"]["payload"]["ownerGeneration"].as_u64()
            .expect("new accepted owner exposes its native generation");
        assert!(newer_generation > first_generation,
            "a replacement must retain a new generation when the old guard drops");
        let resumed = handle_request_for_test(&served.state, "sync.context", json!({
            "launchId":"s4-live","revision":2,"phase":"resume","view":null,
        })).await.result.unwrap();
        assert_eq!(resumed["accepted"], json!(true));
        assert_eq!(resumed["revision"], json!(2));

        send(&mut writer, r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"s4-live","revision":2}}"#).await;
        let duplicate = recv(&mut lines).await;
        assert_eq!(duplicate["params"]["payload"]["accepted"], json!(true));
        assert_eq!(duplicate["params"]["payload"]["ownerGeneration"], json!(newer_generation),
            "an identical retry cannot replace the new guard");
        send(&mut writer, r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"s4-live","revision":1}}"#).await;
        let stale = recv(&mut lines).await;
        assert_eq!(stale["params"]["payload"]["accepted"], json!(false),
            "an old revision cannot reclaim the same channel");
        send(&mut writer, r#"{"jsonrpc":"2.0","method":"sync.owner","params":{"launchId":"s4-other","revision":3}}"#).await;
        let other = recv(&mut lines).await;
        assert_eq!(other["params"]["payload"]["accepted"], json!(false),
            "another launch cannot take over an already owned same channel");
        let status = handle_request_for_test(&served.state, "sync.refresh_status", json!({}))
            .await.result.unwrap();
        assert_eq!(status["contextRevision"], json!(2));
        assert_eq!(status["automaticEnabled"], json!(true));
        served.stop();
    }

    #[tokio::test]
    async fn c5_channel_open_rejects_owner_older_than_accepted_context() {
        let served = Served::start().await;
        let accepted = handle_request_for_test(&served.state, "sync.context", json!({
            "launchId":"c5-new-channel","revision":2,"phase":"resume","view":null,
        })).await;
        assert_eq!(accepted.result.unwrap()["accepted"], json!(true));
        let (mut lines, mut writer) = served.connect().await;
        send(&mut writer, &format!(r#"{{"token":"{}"}}"#, served.state.token)).await;
        recv(&mut lines).await;
        send(&mut writer, r#"{"jsonrpc":"2.0","method":"channel.open","id":11,"params":{"syncOwner":{"launchId":"c5-new-channel","revision":1}}}"#).await;
        let stale = recv(&mut lines).await;
        assert_eq!(stale["error"]["code"], json!(ipc::INVALID_PARAMS));
        assert_eq!(stale["id"], json!(11));
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
