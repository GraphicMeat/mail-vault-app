//! Shell log directory, tracing setup and the log commands (Logs tab, export).

use super::*;

// Global log directory
pub(crate) struct LogDir(pub(crate) PathBuf);

/// macOS: Tauri's `~/Library/Logs/com.mailvault.app`. Elsewhere Tauri's answer
/// is `<local data>/com.mailvault.app/logs`, i.e. `<app_data_dir>/logs`, which
/// is spelled out here so Windows follows `paths`' env override with the rest.
pub(crate) fn get_log_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    // A portable copy keeps its logs on the drive with everything else.
    #[cfg(target_os = "macos")]
    if mailvault_core::paths::portable_root().is_none() {
        return app_handle.path().app_log_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    let _ = app_handle;
    mailvault_core::paths::app_data_dir().map(|d| d.join("logs")).unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn setup_logging(log_dir: &PathBuf) -> tracing_appender::non_blocking::WorkerGuard {
    // Create log directory if it doesn't exist
    let _ = fs::create_dir_all(log_dir);

    // Set up rolling file appender (daily rotation)
    let file_appender = RollingFileAppender::new(
        Rotation::DAILY,
        log_dir,
        "mailvault.log",
    );

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Standard (INFO, addresses masked) unless the persisted settings ask for
    // Verbose; a change applies through `follow_settings_log_level` (the
    // daemon's `settings-changed`) or `write_settings_json`. The salt is
    // shared with the daemon, which reads the same file.
    let data_dir = mailvault_core::paths::app_data_dir().unwrap_or_else(|_| log_dir.clone());
    let settings = fs::read_to_string(data_dir.join("frontend-settings.json")).unwrap_or_default();
    log_redact::set_verbose(log_redact::verbose_from_settings(&settings));
    let salt = log_redact::load_or_create_salt(&data_dir);
    let tee = non_blocking.and(std::io::stdout);
    tracing_subscriber::fmt()
        .with_max_level(Level::DEBUG)
        .with_writer(move || log_redact::RedactingWriter { inner: MakeWriter::make_writer(&tee), salt })
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .finish()
        .with(tracing_subscriber::filter::filter_fn(|m| *m.level() <= log_redact::max_level()))
        .init();

    info!("Logging initialized. Log directory: {:?}", log_dir);

    guard
}

#[tauri::command]
pub(crate) fn log_from_frontend(message: String) {
    info!("[FRONTEND] {}", message);
}

// Off the main thread: a sync command runs there, and the Logs tab stalled the
// window for as long as the read took.
#[tauri::command]
pub(crate) async fn read_logs(app_handle: tauri::AppHandle, lines: Option<usize>) -> Result<String, String> {
    let log_dir = get_log_dir(&app_handle);
    let lines_to_read = lines.unwrap_or(500);
    tauri::async_runtime::spawn_blocking(move || read_latest_log(&log_dir, lines_to_read))
        .await
        .map_err(|e| e.to_string())?
}

/// `read_logs` with every address masked, whatever the log verbosity: Verbose
/// writes raw values, and this tail leaves the machine as a bug-report
/// attachment. Standard lines are already tokens and pass through unchanged.
#[tauri::command]
pub(crate) async fn read_anonymous_logs(app_handle: tauri::AppHandle, lines: Option<usize>) -> Result<String, String> {
    let log_dir = get_log_dir(&app_handle);
    let lines_to_read = lines.unwrap_or(500);
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = mailvault_core::paths::app_data_dir().unwrap_or_else(|_| log_dir.clone());
        let salt = log_redact::load_or_create_salt(&data_dir);
        read_latest_log(&log_dir, lines_to_read).map(|logs| log_redact::redact(&logs, &salt))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The tail of the newest shell log, then of the newest daemon log, which on
/// macOS lives in the app data dir rather than `log_dir`.
pub(crate) fn read_latest_log(log_dir: &Path, lines_to_read: usize) -> Result<String, String> {
    info!("read_logs called, reading last {} lines", lines_to_read);
    if !log_dir.is_dir() {
        return Err(format!("Failed to read log directory: {:?}", log_dir));
    }
    let daemon_dir = mailvault_core::paths::app_data_dir().map(|d| d.join("logs")).unwrap_or_else(|_| log_dir.to_path_buf());
    let mut out = String::new();
    for (dir, prefix) in [(log_dir, "mailvault"), (daemon_dir.as_path(), "daemon.log")] {
        if let Some(path) = log_redact::latest_log(dir, prefix) {
            if prefix == "daemon.log" {
                out.push_str("\n===== daemon.log =====\n");
            }
            // An unreadable daemon log must not hide the shell's.
            match mailvault_core::fsx::tail_lines(&path, lines_to_read) {
                Ok(tail) => out.push_str(&tail),
                Err(e) if prefix == "daemon.log" => out.push_str(&format!("Failed to read {:?}: {}\n", path, e)),
                Err(e) => return Err(format!("Failed to read log file: {}", e)),
            }
        }
    }
    if out.is_empty() {
        return Ok("No log files found".to_string());
    }
    Ok(out)
}

#[tauri::command]
pub(crate) async fn clear_logs(app_handle: tauri::AppHandle) -> Result<String, String> {
    let log_dir = get_log_dir(&app_handle);
    tauri::async_runtime::spawn_blocking(move || clear_log_files(&log_dir))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn clear_log_files(log_dir: &Path) -> Result<String, String> {
    info!("clear_logs called, clearing logs in: {:?}", log_dir);

    let mut cleared = 0;
    let mut truncated = 0;

    // Find all log files (files starting with "mailvault")
    let mut log_files: Vec<_> = match fs::read_dir(log_dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| {
                e.path()
                    .file_name()
                    .map_or(false, |name| name.to_string_lossy().starts_with("mailvault"))
            })
            .collect(),
        Err(e) => {
            error!("Could not read log directory: {}", e);
            return Err(format!("Could not read log directory: {}", e));
        }
    };

    info!("Found {} log file(s)", log_files.len());

    // Sort by modification time (newest first)
    log_files.sort_by(|a, b| {
        b.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .cmp(
                &a.metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
    });

    for (index, entry) in log_files.iter().enumerate() {
        let path = entry.path();
        info!("Processing log file {}: {:?}", index, path);

        if index == 0 {
            // This is the active log file - try to truncate it
            info!("Attempting to truncate active log file: {:?}", path);
            match fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
            {
                Ok(_) => {
                    info!("Successfully truncated active log: {:?}", path);
                    truncated += 1;
                }
                Err(e) => {
                    warn!("Could not truncate active log {:?}: {}", path, e);
                }
            }
        } else {
            // Old log files - delete them
            info!("Attempting to delete old log file: {:?}", path);
            match fs::remove_file(&path) {
                Ok(_) => {
                    info!("Successfully removed: {:?}", path);
                    cleared += 1;
                }
                Err(e) => {
                    warn!("Could not remove {:?}: {}", path, e);
                }
            }
        }
    }

    let result_msg = if truncated > 0 || cleared > 0 {
        format!("Logs cleared. Truncated: {}, Deleted: {}", truncated, cleared)
    } else {
        "No log files found to clear.".to_string()
    };

    info!("{}", result_msg);
    Ok(result_msg)
}

pub(crate) fn setup_logging_and_data_dir(app: &mut tauri::App) {
    // Set up logging to app log directory
    let log_dir = get_log_dir(&app.handle());
    let _guard = setup_logging(&log_dir);
    #[cfg(target_os = "linux")]
    mailvault_core::snap_keyring::install_if_snap();

    // Store the guard to keep logging alive
    std::mem::forget(_guard);

    // Clean up old logs: the daemon's live in the app data dir, which
    // on macOS is not the shell's log dir. An always-on daemon may not
    // restart for weeks, so its own startup cleanup is not enough.
    let now = std::time::SystemTime::now();
    log_redact::cleanup_old_logs(&log_dir, now);
    if let Ok(data_dir) = mailvault_core::paths::app_data_dir() {
        log_redact::cleanup_old_logs(&data_dir.join("logs"), now);
    }

    if let Err(e) = allow_app_data_dir(app.handle()) {
        warn!("{e}");
    }

    // Clean up stale popup cache files from previous sessions
    if let Ok(data_dir) = mailvault_core::paths::app_data_dir() {
        let popup_cache = data_dir.join("popup_cache");
        if popup_cache.exists() {
            let _ = fs::remove_dir_all(&popup_cache);
        }
    }

    // Store log directory for later use
    app.manage(LogDir(log_dir));
}
