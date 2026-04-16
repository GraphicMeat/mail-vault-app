mod auth;
pub mod classification;
mod dns;
mod graph;
pub mod imap;
mod inference;
mod ipc;
mod learning;
pub mod llm;
mod oauth2;
mod server;
mod smtp;
mod snapshot;
pub mod sync_engine;

// Note: backup, migration, archive, external_location modules require
// tauri::AppHandle for data dirs and event emission. They remain in
// src-tauri and their commands fall through to Tauri invoke via transport.js.

use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, error, Level};
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

/// Resolve the real user home directory, bypassing macOS sandbox container redirect.
/// Inside the sandbox, $HOME and dirs::home_dir() both return
/// /Users/{name}/Library/Containers/{bundle}/Data — we strip at /Library/Containers/.
#[cfg(target_os = "macos")]
fn real_home_dir() -> Option<PathBuf> {
    let raw = std::env::var("HOME")
        .ok()
        .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().to_string()))?;

    let effective = if let Some(idx) = raw.find("/Library/Containers/") {
        info!("Extracting real home from sandbox container path: {}", raw);
        &raw[..idx]
    } else {
        &raw
    };

    let p = PathBuf::from(effective);
    if p.starts_with("/Users/") && p.is_dir() {
        info!("Resolved real home: {}", effective);
        Some(p)
    } else {
        error!("Could not resolve real home directory from: {}", raw);
        None
    }
}

/// App Group container shared between the sandboxed app and the daemon.
/// Both declare `group.com.mailvault` in their application-groups entitlement.
#[cfg(target_os = "macos")]
const APP_GROUP_ID: &str = "group.com.mailvault";

/// Resolve the App Group container directory using the real home path.
/// Inside the sandbox `real_home_dir()` strips the container prefix;
/// outside (launchd) `dirs::home_dir()` already returns the real home.
#[cfg(target_os = "macos")]
fn app_group_dir() -> Option<PathBuf> {
    let home = real_home_dir()?;
    let dir = home.join("Library/Group Containers").join(APP_GROUP_ID);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        error!("Failed to create App Group dir {:?}: {}", dir, e);
        return None;
    }
    Some(dir)
}

/// Socket path inside the App Group container (SUN_LEN ≤ 104 bytes).
/// Pattern proven by 1Password (SSH agent socket in Group Containers).
fn get_socket_path(_data_dir: &PathBuf) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(dir) = app_group_dir() {
            let sock = dir.join("mv.sock");
            info!("Daemon socket path: {}", sock.display());
            return sock;
        }
    }
    std::env::temp_dir().join("daemon.sock")
}

/// Token path — same directory as socket for consistency.
fn get_token_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(dir) = app_group_dir() {
            return dir.join("mv.token");
        }
    }
    std::env::temp_dir().join("mv.token")
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

    info!(
        "mailvault-daemon v{} starting (pid: {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );
    info!("Data directory: {:?}", data_dir);

    // Singleton guard — exit immediately if another daemon owns the lock
    let _lock_file = match acquire_singleton_lock(&data_dir) {
        Some(f) => f,
        None => {
            info!("Another daemon is already running for this data directory. Exiting.");
            std::process::exit(0);
        }
    };

    write_pid_file(&data_dir);

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
    let sync_eng = Arc::new(sync_engine::SyncEngine::new(Arc::clone(&imap_pool), data_dir.clone()));

    let state = Arc::new(server::DaemonState {
        token,
        data_dir: data_dir.clone(),
        started_at: std::time::Instant::now(),
        llm: llm_state,
        inference: inference_engine,
        classification: classification::ClassificationState::new(data_dir.clone()),
        imap_pool,
        _oauth2_manager: oauth2::OAuth2Manager::new(),
        sync_engine: sync_eng,
    });

    // Start background classification queue worker
    server::start_classification_worker(Arc::clone(&state));

    let socket_path = get_socket_path(&data_dir);

    // Handle graceful shutdown on SIGINT (ctrl_c) and SIGTERM (service stop / kill)
    let data_dir_cleanup = data_dir.clone();
    let socket_cleanup = socket_path.clone();
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
