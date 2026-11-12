//! Daemon-wide state: `DaemonState`, the run-token registry it holds, and the
//! wiring that builds the pieces only it owns. Sits below `server` (socket
//! accept and dispatch): handlers, jobs and workers import it from here and
//! never from `server`.
use crate::classification;
use crate::contacts_index;
use crate::idle_watch;
use crate::imap;
use crate::inference;
use crate::llm;
use crate::netgate::NetGate;
use crate::sync_engine;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tracing::info;

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
    /// The daemon's delete queue (`delete_queue`): which journalled deletes
    /// are being sent right now, so one uid is never sent twice at once.
    pub(crate) delete_queue: crate::delete_queue::QueueState,
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
    /// Folder moves (`folder_move_job`): the live jobs, running or held, and
    /// the `folder-move` thread they run on.
    pub(crate) folder_moves: crate::folder_move_job::FolderMoves,
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
