mod auth;
pub mod classification;
mod classification_worker;
pub mod contacts_index;
// imap now lives in mailvault_core (shared with src-tauri).
pub use mailvault_core::imap;
mod handlers;
mod inference;
mod ipc;
mod learning;
mod netgate;
pub mod llm;
mod server;
mod snapshot;
pub mod sync_engine;

// Note: backup, migration, archive, external_location modules require
// tauri::AppHandle for data dirs and event emission. They remain in
// src-tauri and their commands fall through to Tauri invoke via transport.js.

use std::path::PathBuf;
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
fn resolve_mail_dir(app_dir: &PathBuf) -> (PathBuf, bool) {
    let meta = match std::fs::read_to_string(app_dir.join("vault-meta.json")) {
        Ok(m) => m,
        Err(_) => return (app_dir.clone(), true),
    };
    let path = match serde_json::from_str::<serde_json::Value>(&meta) {
        Ok(v) => v["displayPath"].as_str().unwrap_or("").to_string(),
        Err(_) => return (app_dir.clone(), true),
    };
    if path.is_empty() {
        return (app_dir.clone(), true);
    }
    let dir = PathBuf::from(&path);
    if dir.join(".mailvault-vault.json").exists() || dir.join("Maildir").exists() {
        return (dir, true);
    }
    warn!("Configured mail storage {} is not reachable — mail operations disabled until it is back", path);
    (app_dir.clone(), false)
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

/// Socket path — under ~/.mailvault/ (SUN_LEN ≤ 104 bytes).
fn get_socket_path(_data_dir: &PathBuf) -> PathBuf {
    let sock = ipc_dir().join("mv.sock");
    info!("Daemon socket path: {}", sock.display());
    sock
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

#[cfg(not(unix))]
fn acquire_singleton_lock(_data_dir: &PathBuf) -> Option<std::fs::File> {
    Some(std::fs::File::open("/dev/null").ok()?) // No-op on non-unix
}

#[tokio::main]
async fn main() {
    let data_dir = get_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    let _log_guard = setup_logging(&data_dir);
    // Mail may live outside the app data dir; bookkeeping never does.
    let (mail_dir, mail_dir_ok) = resolve_mail_dir(&data_dir);

    info!(
        "mailvault-daemon v{} starting (pid: {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );
    info!("Data directory: {:?}", data_dir);
    info!("Mail directory: {:?} (available: {})", mail_dir, mail_dir_ok);

    // Singleton guard — exit immediately if another daemon owns the lock
    let _lock_file = match acquire_singleton_lock(&data_dir) {
        Some(f) => f,
        None => {
            info!("Another daemon is already running for this data directory. Exiting.");
            std::process::exit(0);
        }
    };

    write_pid_file(&data_dir);

    // One-time Maildir filename migration: append `.eml` to message files that
    // pre-date the extension change. Idempotent; version-guarded.
    let mig = mailvault_core::maildir::migrate_add_eml_extension(&mail_dir);
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
    let sync_eng = Arc::new(sync_engine::SyncEngine::new(
        Arc::clone(&imap_pool),
        mail_dir.clone(),
        data_dir.clone(),
        Arc::clone(&contacts),
        Arc::clone(&net),
    ));

    let state = Arc::new(server::DaemonState {
        token,
        data_dir: mail_dir.clone(),
        app_dir: data_dir.clone(),
        mail_dir_ok,
        started_at: std::time::Instant::now(),
        llm: llm_state,
        inference: inference_engine,
        classification: classification::ClassificationState::new(data_dir.clone()),
        imap_pool,
        sync_engine: sync_eng,
        contacts: Arc::clone(&contacts),
        net,
    });

    // Start background classification queue worker
    classification_worker::start_classification_worker(Arc::clone(&state));

    // Debounced flush of the contacts index to disk (every 30s).
    {
        let contacts = Arc::clone(&contacts);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                contacts.flush_dirty();
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
    let socket_cleanup = socket_path.clone();
    let pool_cleanup = Arc::clone(&state.imap_pool);
    tokio::spawn(async move {
        let ctrl_c = tokio::signal::ctrl_c();

        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate()).expect("failed to register SIGTERM handler");

            tokio::select! {
                _ = ctrl_c => info!("Received SIGINT"),
                _ = sigterm.recv() => info!("Received SIGTERM"),
            }
        }

        #[cfg(not(unix))]
        {
            ctrl_c.await.ok();
            info!("Received shutdown signal");
        }

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
        let _ = std::fs::remove_file(&socket_cleanup);
        info!("Cleanup complete, exiting");
        std::process::exit(0);
    });

    // Start the socket server
    if let Err(e) = server::run(state, &socket_path).await {
        error!("Daemon server failed: {}", e);
        cleanup_pid_file(&data_dir);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-main-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
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
        std::fs::write(vault.join(".mailvault-vault.json"), "{}").unwrap();
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
}
