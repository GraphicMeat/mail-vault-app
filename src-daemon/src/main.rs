// No console window on Windows: a console-subsystem exe gets one, which
// makes the background daemon show up as an app in the taskbar and Task
// Manager. Piped stdio (the `--extract-pdf` child) still works without it.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod attachment_extract;
mod auth;
mod auto_tag_worker;
mod backup_zip;
mod channel;
pub mod classification;
mod classification_worker;
pub mod contacts_index;
pub mod credentials;
pub mod custody;
// imap now lives in mailvault_core (shared with src-tauri).
pub use mailvault_core::graph;
pub use mailvault_core::imap;
// oauth2 now lives in mailvault_core too (Task 5.7) — the daemon holds the
// ONE OAuth2Manager instance in DaemonState (see server.rs), src-tauri no
// longer references this module at all.
pub use mailvault_core::oauth2;
mod events;
mod export_fetch;
mod handlers;
mod idle_watch;
mod inference;
mod insights;
mod ipc;
mod learning;
mod mbox;
mod migration;
mod netgate;
pub mod llm;
mod restore;
mod scheduled_send_worker;
mod server;
pub mod search_index;
mod snapshot;
pub mod sync_engine;

// Note: backup, external_location modules require tauri::AppHandle for data
// dirs and event emission (backup is Phase 3's still-open remainder, blocked
// on the bookmark-scope probe; external_location is shell-permanent). They
// remain in src-tauri and their commands fall through to Tauri invoke via
// transport.js. archive moved in Phase 3; migration and restore moved here in
// Task 4.7 (no cutover yet -- the Tauri commands in src-tauri still exist too
// and still serve the frontend until Task 4.8).

#[cfg(target_os = "macos")]
embed_plist::embed_info_plist!("../Info.plist");

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn, error, Level};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_appender::rolling::{RollingFileAppender, Rotation};

/// Data directory must match Tauri's `app_data_dir()` so the app and daemon
/// share the same socket / token path.
/// macOS: ~/Library/Application Support/com.mailvault.app
/// Linux: ~/.local/share/com.mailvault.app  (XDG_DATA_HOME)
fn get_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.mailvault.app")
}

/// Where the mail itself lives. Defaults to the app data dir; follows the
/// user-selected vault folder when the app has configured one (written by the
/// app as `<app_data_dir>/vault-meta.json`).
///
/// If the folder is not reachable — drive unplugged — the daemon falls back to
/// the app data dir for its own bookkeeping but must not sync into it, so the
/// caller logs loudly and the app surfaces the banner.
/// Returns (mail_dir, ok). `ok` is false when a custom folder is configured but
/// unreachable — the daemon then refuses every mail operation instead of
/// syncing into the app data dir and forking the archive.
/// Phase 6: `vault_get_status` needs more than `resolve_mail_dir`'s
/// `(dir, ok)` — the configured *display* path (kept even when `dir` falls
/// back to `app_dir`) and whether a custom folder is configured at all.
///
/// Message-fidelity trade-off, decided (not a gap): the app's own
/// `vault::resolve()` distinguishes "the bookmark itself won't resolve"
/// (a real OS/bookmark error, drive genuinely gone) from "the path resolves
/// but doesn't look like our vault" (marker missing) because it can see the
/// bookmark's own error text. The daemon only ever reads the plain
/// `displayPath` string — it has no bookmark API (spec §3.4: only the app
/// resolves bookmarks) — so both cases collapse into the one message below.
/// `status`/`isCustom`/`displayPath` stay accurate either way; only
/// `lastError`'s wording is less specific in the "drive truly unplugged"
/// sub-case.
pub(crate) struct VaultLocationInfo {
    pub dir: PathBuf,
    pub ok: bool,
    pub display_path: String,
    pub is_custom: bool,
    pub last_error: Option<String>,
}

fn resolve_vault_location(app_dir: &PathBuf) -> VaultLocationInfo {
    let default = || VaultLocationInfo {
        dir: app_dir.clone(),
        ok: true,
        display_path: app_dir.to_string_lossy().into_owned(),
        is_custom: false,
        last_error: None,
    };
    // `app.db`'s `vault` slot — the app writes it when the user relocates the
    // vault (it was `vault-meta.json`, which `app_db`'s import retires).
    let path = match mailvault_core::app_db::with(app_dir, |conn| {
        Ok(mailvault_core::app_db::locations::display_path(conn, "vault"))
    }) {
        Ok(Some(p)) => p,
        _ => return default(),
    };
    let dir = PathBuf::from(&path);
    // Task 2.5 (deviation 6): the same "does this look like a vault" rule the
    // app uses, so the two processes never disagree about a folder that holds
    // e.g. only `custody/` — with custody opening here (Task 2.9a/b), that
    // divergence used to decide where a second, orphaned store could open.
    if mailvault_core::vault_layout::read_marker(&dir).is_some() || mailvault_core::vault_layout::looks_like_vault(&dir) {
        return VaultLocationInfo { dir, ok: true, display_path: path, is_custom: true, last_error: None };
    }
    warn!("Configured mail storage {} is not reachable — mail operations disabled until it is back", path);
    let last_error = "The folder is reachable but does not contain your mail. If the drive was remounted elsewhere, choose the folder again.".to_string();
    VaultLocationInfo { dir: app_dir.clone(), ok: false, display_path: path, is_custom: true, last_error: Some(last_error) }
}

// Phase 6: production code calls `resolve_vault_location` directly now (it
// needs the richer fields); this tuple-shaped wrapper survives only for the
// tests below, which pin the (dir, ok) contract on its own.
#[cfg(test)]
fn resolve_mail_dir(app_dir: &PathBuf) -> (PathBuf, bool) {
    let info = resolve_vault_location(app_dir);
    (info.dir, info.ok)
}

/// IPC directory for socket and token.
/// Uses `dirs::home_dir()` which inside the App Sandbox returns the container
/// home — both the app and this sidecar daemon see the same path.
/// Outside the sandbox (dev/testing) it returns the real home.
fn ipc_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".mailvault");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The endpoint the app connects on: a socket file under `~/.mailvault`
/// (SUN_LEN ≤ 104 bytes), or a named pipe on Windows.
fn get_socket_path(_data_dir: &PathBuf) -> PathBuf {
    let ep = mailvault_core::transport::endpoint(&ipc_dir());
    info!("Daemon endpoint: {}", ep.display());
    ep
}

/// Token path — same directory as socket.
fn get_token_path() -> PathBuf {
    ipc_dir().join("mv.token")
}

fn setup_logging(data_dir: &PathBuf) -> tracing_appender::non_blocking::WorkerGuard {
    let log_dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = RollingFileAppender::new(Rotation::DAILY, &log_dir, "daemon.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_max_level(Level::DEBUG)
        .with_writer(non_blocking.and(std::io::stderr))
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .init();

    info!("Daemon logging initialized at {:?}", log_dir);
    guard
}

fn write_pid_file(data_dir: &PathBuf) {
    let pid_path = data_dir.join("daemon.pid");
    if let Err(e) = std::fs::write(&pid_path, std::process::id().to_string()) {
        error!("Failed to write PID file: {}", e);
    }
}

fn cleanup_pid_file(data_dir: &PathBuf) {
    let pid_path = data_dir.join("daemon.pid");
    let _ = std::fs::remove_file(pid_path);
}

/// Acquire exclusive flock on daemon.lock — ensures only one daemon per data dir.
/// Returns the File handle (must be kept alive for the lock to hold).
///
/// Unix only, and deliberately: on Windows `ServerOptions::first_pipe_instance`
/// in `server::run` already fails a second daemon, so a lock file would be a
/// second mechanism for a job that is done.
#[cfg(unix)]
fn acquire_singleton_lock(data_dir: &PathBuf) -> Option<std::fs::File> {
    use std::os::unix::io::AsRawFd;

    let lock_path = data_dir.join("daemon.lock");
    let file = match std::fs::OpenOptions::new()
        .read(true).write(true).create(true).truncate(false)
        .open(&lock_path)
    {
        Ok(f) => f,
        Err(e) => {
            error!("Failed to open lock file: {}", e);
            return None;
        }
    };

    let fd = file.as_raw_fd();
    let ret = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if ret != 0 {
        // Lock held by another daemon
        return None;
    }

    // Write our PID into the lock file for diagnostics
    use std::io::Write;
    let mut f = &file;
    let _ = f.write_all(std::process::id().to_string().as_bytes());

    Some(file)
}

/// `mailvault-daemon --extract-pdf`: read PDF bytes from stdin, write extracted text
/// to stdout. Runs only in its own re-exec'd process (see `attachment_extract.rs`'s
/// non-macOS `pdf_text_layer`), never in the main daemon or the search-index
/// worker thread, so a crash here just exits non-zero/gets killed rather than
/// taking anything else down. The `catch_unwind` below is a real safety net,
/// not decorative: `src-daemon/Cargo.toml` sets `[profile.release] panic =
/// "abort"`, but this workspace's root `Cargo.toml` declares no `[profile]`
/// table, and Cargo only honours profile settings from the workspace root —
/// a member manifest's own `[profile.*]` is ignored, with a cargo warning (confirmed via
/// `cargo add`/`cargo fetch` here, which both warn "profiles for the non
/// root package will be ignored"). So `panic = "abort"` in src-daemon's
/// Cargo.toml is dead in every build of this binary, debug or release, and
/// `catch_unwind` actually catches a `pdf-extract` panic today. It's kept
/// regardless of that: if the workspace root ever grows a `[profile.release]`
/// table and revives the abort setting, this still degrades gracefully to a
/// non-zero exit instead of silently going from "caught" to "uncaught".
#[cfg(not(target_os = "macos"))]
fn extract_pdf_subprocess_main() -> i32 {
    use std::io::Read;
    let mut bytes = Vec::new();
    if std::io::stdin().read_to_end(&mut bytes).is_err() {
        return 1;
    }
    match std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes)) {
        Ok(Ok(text)) => {
            print!("{text}");
            0
        }
        _ => 1,
    }
}

fn main() {
    // Before any runtime or logging exists: this process only extracts one PDF.
    #[cfg(not(target_os = "macos"))]
    if std::env::args().nth(1).as_deref() == Some("--extract-pdf") {
        std::process::exit(extract_pdf_subprocess_main());
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("mailvault-daemon: cannot start the async runtime: {e}");
            std::process::exit(1);
        }
    };
    runtime.block_on(daemon_main());
}

/// The startup `.eml` sweep, gated (Task 2.8 review M2). `resolve_mail_dir`
/// falls back to the app data dir when the configured vault is unreachable,
/// and a sweep over that fallback would rename files in a directory that is
/// not the user's vault — the app copy this replaced had the same guard.
///
/// Known ceiling, unchanged by this fix: the sweep runs only here, so a drive
/// mounted after the daemon started waits for the next daemon restart.
fn startup_eml_migration(mail_dir: &Path, mail_dir_ok: bool) -> mailvault_core::maildir::EmlMigrationStats {
    if !mail_dir_ok {
        info!("Maildir .eml migration skipped: the mail storage folder is not reachable");
        return Default::default();
    }
    mailvault_core::maildir::migrate_add_eml_extension(mail_dir)
}

/// Flush the contacts index to disk, refusing while the vault is unreachable
/// or mid-move (final fix wave I-1). Extracted for testing: the ticker in
/// `daemon_main` cannot be unit-tested directly.
fn flush_contacts_if_open(state: &Arc<server::DaemonState>) {
    let _ = handlers::common::with_vault_write(state, |_root| {
        state.contacts.flush_dirty();
        Ok::<(), String>(())
    });
}

async fn daemon_main() {
    let data_dir = get_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    let _log_guard = setup_logging(&data_dir);
    // Mail may live outside the app data dir; bookkeeping never does.
    let vault_location = resolve_vault_location(&data_dir);
    let (mail_dir, mail_dir_ok) = (vault_location.dir.clone(), vault_location.ok);

    info!(
        "mailvault-daemon v{} starting (pid: {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );
    info!("Data directory: {:?}", data_dir);
    info!("Mail directory: {:?} (available: {})", mail_dir, mail_dir_ok);

    // Singleton guard — exit if another daemon owns the lock. A daemon that was
    // just told to shut down (`daemon.shutdown`) may still hold the lock for a
    // moment while it releases it; wait it out instead of exiting immediately.
    //
    // Unix only: see `acquire_singleton_lock`'s doc comment for why Windows
    // has a different, authoritative mechanism instead (below and in
    // `server::run`).
    #[cfg(unix)]
    let _lock_file = {
        let mut lock = acquire_singleton_lock(&data_dir);
        for _ in 0..20 {
            if lock.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            lock = acquire_singleton_lock(&data_dir);
        }
        match lock {
            Some(f) => f,
            None => {
                info!("Another daemon is already running for this data directory. Exiting.");
                std::process::exit(0);
            }
        }
    };

    // Windows equivalent, advisory only — NOT a replacement for the real
    // rejection. That's `ServerOptions::first_pipe_instance(true)` inside
    // `server::run`, and it cannot run this early: creating a pipe instance
    // registers it with tokio's IO driver, so it has to happen on the
    // runtime that will drive it, and that runtime (and its own OS thread)
    // don't exist until `spawn_on_own_thread` below. `is_listening` is a
    // point-in-time enumeration of `\\.\pipe\`, not a lock — two daemons
    // launched within the same few hundred milliseconds of each other can
    // both pass this check, and only `first_pipe_instance` still tells them
    // apart when that happens. What this buys is the common case: a second
    // launch while one is already running exits now, for free, instead of
    // racing the live daemon through the PID file write, the `.eml`
    // migration, and opening `app.db`/`custody.db` below.
    #[cfg(windows)]
    if mailvault_core::transport::is_listening(&mailvault_core::transport::endpoint(&ipc_dir())) {
        info!("Another daemon appears to already be running for this data directory. Exiting.");
        std::process::exit(0);
    }

    write_pid_file(&data_dir);

    // One-time Maildir filename migration: append `.eml` to message files that
    // pre-date the extension change. Idempotent; version-guarded.
    // No vault registry update: it runs synchronously before the registry is
    // opened below, and a new session verifies every mailbox afresh (a rename
    // it did keeps its row by size and mtime). It is called nowhere else.
    let mig = startup_eml_migration(&mail_dir, mail_dir_ok);
    if mig.renamed > 0 || mig.errors > 0 {
        info!(
            "Maildir .eml migration: renamed={} already_ok={} skipped={} errors={}",
            mig.renamed, mig.already_ok, mig.skipped_non_message, mig.errors
        );
    }

    // Load or generate auth token — use the shared token path (same location as socket)
    let token_path = get_token_path();
    let token = match auth::load_or_generate_token_at(&token_path) {
        Ok(t) => t,
        Err(e) => {
            error!("Failed to initialize auth token: {}", e);
            std::process::exit(1);
        }
    };

    let llm_state = Arc::new(llm::LlmState::new(data_dir.clone()));

    let inference_engine = Arc::new(inference::InferenceEngine::new());

    let imap_pool = Arc::new(imap::ImapPool::new());
    let contacts = contacts_index::ContactsState::new(mail_dir.clone());
    // Connectivity gate. Its watchdog parks on a notify while online, so it
    // costs nothing until something actually fails.
    let net = netgate::NetGate::new();
    net.spawn_watchdog();
    let vault_closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let vault_gate = Arc::new(std::sync::RwLock::new(()));
    let sync_eng = Arc::new(sync_engine::SyncEngine::new(
        Arc::clone(&imap_pool),
        mail_dir.clone(),
        data_dir.clone(),
        Arc::clone(&contacts),
        Arc::clone(&net),
        Arc::clone(&vault_closed),
        Arc::clone(&vault_gate),
    ));

    // IDLE watchers. 30 s first backoff, doubling — a provider that refuses
    // connections must not be dialled every second by nine accounts.
    let idle = idle_watch::IdleWatchers::new(
        Arc::clone(&sync_eng),
        Arc::clone(&imap_pool),
        Arc::clone(&net),
        std::time::Duration::from_secs(30),
    );

    // Auto Tags' standing worker shares this Notify with `idle` (its own
    // "new mail" signal) so an IDLE wake-up sweeps auto-tag rules too,
    // without idle_watch needing to know DaemonState exists yet.
    let auto_tag_worker = auto_tag_worker::AutoTagWorkerState::default();
    idle.set_auto_tag_notify(Arc::clone(&auto_tag_worker.notify));

    let events = events::EventBus::new(events::CAPACITY);
    credentials::install_events(events.clone());
    let search_index_state = search_index::SearchIndexState::new(mail_dir.clone(), data_dir.clone(), mail_dir_ok, events.clone());

    // Keyed by the CONFIGURED vault, not `mail_dir`: an unplugged drive falls
    // back to `data_dir`, and opening the registry under that root would wipe
    // the real vault's rows for a session that cannot read them anyway.
    let vault_registry = server::open_vault_registry(&data_dir, Path::new(&vault_location.display_path), &search_index_state);

    let custody = custody::CustodyState::default();
    sync_eng.attach_custody_db(Arc::clone(&custody.db));
    contacts.attach_db(Arc::clone(&custody.db));
    let state = Arc::new(server::DaemonState {
        token,
        data_dir: mail_dir.clone(),
        app_dir: data_dir.clone(),
        mail_dir_ok,
        vault_display_path: std::sync::Mutex::new(vault_location.display_path),
        vault_is_custom: std::sync::Mutex::new(vault_location.is_custom),
        vault_last_error: std::sync::Mutex::new(vault_location.last_error),
        pending_move: std::sync::Mutex::new(None),
        vault_closed,
        vault_gate,
        started_at: std::time::Instant::now(),
        llm: llm_state,
        inference: inference_engine,
        classification: classification::ClassificationState::new(data_dir.clone()),
        imap_pool,
        oauth2: oauth2::OAuth2Manager::new(),
        sync_engine: sync_eng,
        idle,
        contacts: Arc::clone(&contacts),
        net,
        shutdown: Arc::new(tokio::sync::Notify::new()),
        events,
        search_index: Arc::clone(&search_index_state),
        vault_registry,
        search_runs: std::sync::Mutex::new(std::collections::HashMap::new()),
        prefetch_lock: std::sync::Mutex::new(()),
        prefetch_high_water: std::sync::Mutex::new(Vec::new()),
        journal: std::sync::Mutex::new(()),
        custody,
        run_tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
        backup_runs: std::sync::Mutex::new(std::collections::HashMap::new()),
        insights: insights::InsightsSnapshots::default(),
        scheduled_send: scheduled_send_worker::ScheduledSendState::default(),
        auto_tag_worker,
    });

    // Custody, before the socket exists (Task 2.9b Step 1): a route that
    // reads an entry must never be served by a store that is not open yet.
    // Only the OPEN is awaited here — schema migration, a few milliseconds.
    //
    // The legacy JSON import is not (2026-09-20): it used to run inside
    // `open_into`, and on a vault whose header sidecars are still on disk it
    // took 416 s, during which the socket did not exist at all — the app
    // showed an endless mail loader and "Helper Not Running" while the daemon
    // process was plainly there. It runs on its own thread below, once the
    // socket is up, taking the custody lock one mailbox at a time. A mailbox
    // not imported yet reads as "no cached headers", never as wrong headers:
    // the import only ever INSERTs rows the store does not have.
    {
        let custody_state = Arc::clone(&state);
        let started = std::time::Instant::now();
        let outcome = tokio::task::spawn_blocking(move || custody::open_into(&custody_state)).await;
        let took = started.elapsed();
        match outcome {
            Ok(Ok(())) => {
                if took > std::time::Duration::from_secs(2) {
                    warn!("custody store: open took {:?} — the app only waits 3s for the daemon socket", took);
                } else {
                    info!("custody store: opened in {:?}", took);
                }
            }
            // `open_into` already logged the reason; this line is only about
            // timing, so it must not repeat "opened in" over a failure.
            Ok(Err(e)) => warn!("custody store: failed to open in {:?}: {e}", took),
            // A panic here would otherwise leave `custody.error` at `None`
            // (task-2.11 carry-in M3): `VaultAlertBanner` renders nothing for
            // a `None` error while every custody route still answers `custody
            // store unavailable: closed`. Record it so the banner has
            // something to show.
            Err(join_err) => {
                let msg = format!("custody store: startup open panicked: {join_err}");
                error!("{msg}");
                *state.custody.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
            }
        }
    }

    // The one-time legacy import, off the startup path (see above).
    custody::spawn_legacy_import(Arc::clone(&state));

    // Start background classification queue worker
    classification_worker::start_classification_worker(Arc::clone(&state));

    // Scheduled Send's worker: a catch-up pass over anything already due
    // (the normal case — the daemon dies with the app in on-demand mode),
    // then sleeps until the next fire_at or a wake from handlers::scheduled.
    scheduled_send_worker::start(Arc::clone(&state));
    // Watches keychain access so a locked keychain is noticed without waiting
    // for something to ask for credentials; an unlock wakes the queued sends.
    {
        let state = Arc::clone(&state);
        credentials::start_watcher(move || state.scheduled_send.wake());
    }

    // Auto Tags' standing worker: sweeps enabled rules over newly-cached
    // headers on every wake from a sync/IDLE arrival (see `idle`'s
    // `set_auto_tag_notify` above and `handlers::handle_sync_now`) — never
    // polls the vault on its own.
    auto_tag_worker::start(Arc::clone(&state));

    // Its own OS thread; it opens nothing until the app configures it.
    search_index::start(Arc::clone(&state.search_index));

    // Insights' 300s snapshot expiry sweeper (Task 3.6), same 30s loop and
    // Weak-reference exit condition as the app's version.
    state.insights.start_cleanup();

    // Debounced flush of the contacts index to disk (every 30s). Gated like
    // every other vault write (final fix wave I-1): ungated, dirty entries
    // accumulated before a `vault_close` used to land in the OLD root mid
    // vault-move copy, and `contacts_index` was never in `VAULT_DIRS`, so the
    // leftover was neither carried by the move nor cleaned up.
    {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let state = Arc::clone(&state);
                // spawn_blocking: `flush_dirty` does disk I/O and must never
                // run on a tokio worker (global constraint).
                let _ = tokio::task::spawn_blocking(move || flush_contacts_if_open(&state)).await;
            }
        });
    }

    // Per-account transfer counters → `<app_data_dir>/transfer_stats/*.daemon.json`.
    // The app writes the `*.app.json` half; neither process locks the other's.
    {
        let app_dir = data_dir.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                mailvault_core::transfer_stats::global().flush(&app_dir, "daemon");
            }
        });
    }

    let socket_path = get_socket_path(&data_dir);

    // Handle graceful shutdown on SIGINT (ctrl_c) and SIGTERM (service stop / kill)
    let data_dir_cleanup = data_dir.clone();
    #[cfg_attr(windows, allow(unused_variables))]
    let socket_cleanup = socket_path.clone();
    let pool_cleanup = Arc::clone(&state.imap_pool);
    let idle_cleanup = Arc::clone(&state.idle);
    let shutdown_cleanup = Arc::clone(&state.shutdown);
    tokio::spawn(async move {
        let ctrl_c = tokio::signal::ctrl_c();

        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate()).expect("failed to register SIGTERM handler");

            tokio::select! {
                _ = ctrl_c => info!("Received SIGINT"),
                _ = sigterm.recv() => info!("Received SIGTERM"),
                _ = shutdown_cleanup.notified() => info!("Received daemon.shutdown"),
            }
        }

        #[cfg(not(unix))]
        {
            tokio::select! {
                _ = ctrl_c => info!("Received SIGINT"),
                _ = shutdown_cleanup.notified() => info!("Received daemon.shutdown"),
            }
        }

        // Stop the IDLE watchers first: a session parked in IDLE answers
        // nothing, so it would eat the whole 2s LOGOUT budget below.
        idle_cleanup.shutdown().await;

        // LOGOUT every pooled IMAP session so servers drop them now instead of
        // holding them open until their idle timeout. Bounded — a hung server
        // must not stop us from exiting, and the app that spawned us only waits
        // DAEMON_STOP_GRACE (3s) before escalating to SIGKILL, so stay under it.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool_cleanup.shutdown(),
        ).await;

        mailvault_core::transfer_stats::global().flush(&data_dir_cleanup, "daemon");
        cleanup_pid_file(&data_dir_cleanup);
        // Unix only: the socket file outlives the process and has to be
        // unlinked. A named pipe disappears with its last handle.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&socket_cleanup);
        info!("Cleanup complete, exiting");
        std::process::exit(0);
    });

    // The socket server gets its OWN OS thread and its OWN tokio runtime
    // (`server::spawn_on_own_thread`), so accepting a connection and
    // answering an RPC can never wait behind the runtime this function has
    // been using. Spawned HERE, at the line the old `server::run(...).await`
    // occupied, not earlier: everything above (the search index worker's
    // signal sender, the classification worker, the insights sweeper) must be
    // installed before the first request can land.
    {
        let thread_data_dir = data_dir.clone();
        let spawned = server::spawn_on_own_thread(state, socket_path.clone(), move |why| {
            error!("Daemon {why}");
            cleanup_pid_file(&thread_data_dir);
            std::process::exit(1);
        });
        if let Err(e) = spawned {
            error!("Daemon server thread did not start: {}", e);
            cleanup_pid_file(&data_dir);
            std::process::exit(1);
        }
    }

    // Nothing left to await here: the shutdown task above owns exiting the
    // process, and the server runs on its own thread until it does.
    std::future::pending::<()>().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-main-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Task 2.8 review M2: `resolve_mail_dir` hands back the app data dir with
    /// `ok = false` when the configured vault is unreachable. The startup sweep
    /// must not rename anything in that fallback.
    #[test]
    fn the_startup_eml_sweep_renames_nothing_when_the_vault_is_unreachable() {
        let dir = scratch("eml-sweep");
        let cur = dir.join("Maildir").join("acct").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        let legacy = cur.join("7:2,S");
        std::fs::write(&legacy, b"From: a@b\r\n\r\nx").unwrap();

        let skipped = startup_eml_migration(&dir, false);
        assert_eq!((skipped.renamed, skipped.already_ok), (0, 0));
        assert!(legacy.exists(), "the fallback directory must be left alone");

        let ran = startup_eml_migration(&dir, true);
        assert_eq!(ran.renamed, 1);
        assert!(cur.join("7:2,S.eml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_vault_meta_the_mail_lives_in_the_app_dir() {
        let app = scratch("no-meta");
        assert_eq!(resolve_mail_dir(&app), (app.clone(), true));
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn an_empty_display_path_means_no_custom_vault() {
        let app = scratch("empty-path");
        std::fs::write(app.join("vault-meta.json"), r#"{"displayPath":""}"#).unwrap();
        assert_eq!(resolve_mail_dir(&app), (app.clone(), true));
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn a_marked_vault_folder_becomes_the_mail_dir() {
        let app = scratch("marked-app");
        let vault = scratch("marked-vault");
        // Task 2.5: `resolve_mail_dir` now reads the marker through
        // `mailvault_core::vault_layout::read_marker`, which — like the app's
        // own `write_marker` — requires the real shape, not just any file at
        // that name.
        std::fs::write(
            vault.join(".mailvault-vault.json"),
            serde_json::json!({"app": "mailvault", "vaultId": "abc", "createdAt": 1}).to_string(),
        )
        .unwrap();
        std::fs::write(
            app.join("vault-meta.json"),
            serde_json::json!({"displayPath": vault.to_string_lossy()}).to_string(),
        )
        .unwrap();

        assert_eq!(resolve_mail_dir(&app), (vault.clone(), true));
        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_folder_with_only_custody_and_no_marker_is_still_a_vault() {
        // deviation 6: the daemon used to require the marker OR a `Maildir`
        // dir specifically; it now shares the app's broader `looks_like_vault`
        // rule (any non-index VAULT_DIRS entry), so a vault holding only
        // `custody/` + `email_cache/` reads the same way in both processes.
        let app = scratch("custody-only-app");
        let vault = scratch("custody-only-vault");
        std::fs::create_dir_all(vault.join("custody")).unwrap();
        std::fs::write(
            app.join("vault-meta.json"),
            serde_json::json!({"displayPath": vault.to_string_lossy()}).to_string(),
        )
        .unwrap();

        assert_eq!(resolve_mail_dir(&app), (vault.clone(), true));
        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_empty_configured_folder_is_not_a_vault() {
        let app = scratch("empty-configured-app");
        let vault = scratch("empty-configured-vault");
        std::fs::write(
            app.join("vault-meta.json"),
            serde_json::json!({"displayPath": vault.to_string_lossy()}).to_string(),
        )
        .unwrap();

        assert_eq!(resolve_mail_dir(&app), (app.clone(), false));
        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unreachable_vault_folder_disables_mail_operations() {
        let app = scratch("gone-app");
        let vault = scratch("gone-vault");
        std::fs::write(
            app.join("vault-meta.json"),
            serde_json::json!({"displayPath": vault.to_string_lossy()}).to_string(),
        )
        .unwrap();
        std::fs::remove_dir_all(&vault).unwrap();

        assert_eq!(resolve_mail_dir(&app), (app.clone(), false));
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn a_corrupt_vault_meta_falls_back_to_the_app_dir() {
        let app = scratch("corrupt");
        std::fs::write(app.join("vault-meta.json"), "not json at all").unwrap();
        assert_eq!(resolve_mail_dir(&app), (app.clone(), true));
        let _ = std::fs::remove_dir_all(&app);
    }

    /// Phase 6: `vault_get_status` needs the configured display path even
    /// when unreachable (`dir` falls back to `app_dir`, but the user should
    /// still see WHICH folder is missing) and whether a custom folder is
    /// configured at all.
    #[test]
    fn resolve_vault_location_reports_default_with_no_vault_meta() {
        let app = scratch("loc-default");
        let info = resolve_vault_location(&app);
        assert!(info.ok);
        assert!(!info.is_custom);
        assert_eq!(info.display_path, app.to_string_lossy());
        assert!(info.last_error.is_none());
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn resolve_vault_location_reports_custom_and_ready_for_a_marked_vault() {
        let app = scratch("loc-ready-app");
        let vault = scratch("loc-ready-vault");
        std::fs::write(
            vault.join(".mailvault-vault.json"),
            serde_json::json!({"app": "mailvault", "vaultId": "abc", "createdAt": 1}).to_string(),
        )
        .unwrap();
        std::fs::write(app.join("vault-meta.json"), serde_json::json!({"displayPath": vault.to_string_lossy()}).to_string()).unwrap();

        let info = resolve_vault_location(&app);
        assert!(info.ok);
        assert!(info.is_custom);
        assert_eq!(info.display_path, vault.to_string_lossy());
        assert!(info.last_error.is_none());
        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn resolve_vault_location_keeps_the_configured_display_path_when_unreachable() {
        let app = scratch("loc-missing-app");
        let vault = scratch("loc-missing-vault");
        std::fs::write(app.join("vault-meta.json"), serde_json::json!({"displayPath": vault.to_string_lossy()}).to_string()).unwrap();
        std::fs::remove_dir_all(&vault).unwrap();

        let info = resolve_vault_location(&app);
        assert!(!info.ok);
        assert!(info.is_custom);
        assert_eq!(info.dir, app, "the daemon's own working root falls back to app_dir");
        assert_eq!(info.display_path, vault.to_string_lossy(), "the user must still see which folder is missing");
        assert!(info.last_error.is_some());
        let _ = std::fs::remove_dir_all(&app);
    }

    /// Final fix wave I-1: `flush_dirty` used to run ungated on a 30 s
    /// ticker, so dirty entries accumulated before a `vault_close` landed in
    /// the OLD root mid vault-move copy. RED on the old code (no gate
    /// existed at all): this would write regardless of `vault_closed`.
    #[test]
    fn a_flush_while_vault_closed_writes_nothing() {
        let mail = scratch("contacts-flush-closed-mail");
        let app = scratch("contacts-flush-closed-app");
        let state = server::DaemonState::for_test(mail.clone(), app.clone(), true);
        state.contacts.seed_dirty_for_test("acc1");
        state.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);

        flush_contacts_if_open(&state);

        let stored = |state: &server::DaemonState| {
            crate::custody::with_conn(state, |c| {
                Ok(mailvault_core::custody::contacts::load(c, "acc1").len())
            })
            .unwrap_or(0)
        };
        assert_eq!(
            stored(&state),
            0,
            "a flush while the vault is closed for a move must not write into the old root"
        );

        // Control: with the vault open, the same dirty entry does get
        // written — proves the gate, not something else, is what refused it.
        state.vault_closed.store(false, std::sync::atomic::Ordering::SeqCst);
        state.contacts.seed_dirty_for_test("acc1");
        flush_contacts_if_open(&state);
        assert_eq!(stored(&state), 1);

        let _ = std::fs::remove_dir_all(&mail);
        let _ = std::fs::remove_dir_all(&app);
    }
}
