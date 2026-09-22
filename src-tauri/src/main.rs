// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

// The `vault_eml` / `vault_files` / `header_cache` re-exports
// (`find_file_by_uid`, `parse_flags_from_filename`,
// `build_maildir_filename`, `cache_base_name`, ...) went with the backup
// runners in the Phase 3 remainder's Task 5: `backup.rs` was their last
// caller, and `mailvault_core::backup` now uses them in-crate.

/// Localize the menu bar without rebuilding it.
///
/// The menu is built in `setup`, before the webview exists. The chosen language
/// lives in the frontend's zustand store, persisted to the webview's
/// localStorage — which Rust cannot read. So Rust builds English at startup and
/// the frontend pushes translated labels down once it knows the locale, and
/// again on every change.
///
/// Setting text on the existing items beats rebuilding the menu: the `#[cfg]`
/// guards around `check_updates` (absent on MAS builds) and the per-platform
/// Settings accelerator stay exactly where they are.
/// Handle to the tray menu, kept because `TrayIcon` exposes no way back to it.
struct TrayMenu(tauri::menu::Menu<tauri::Wry>);

#[tauri::command]
fn apply_menu_labels(
    app: tauri::AppHandle,
    labels: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    fn relabel(
        items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>,
        labels: &std::collections::HashMap<String, String>,
    ) {
        for item in items {
            let id = item.id().0.clone();
            match item {
                tauri::menu::MenuItemKind::MenuItem(i) => {
                    if let Some(t) = labels.get(&id) {
                        let _ = i.set_text(t);
                    }
                }
                tauri::menu::MenuItemKind::Submenu(sub) => {
                    if let Some(t) = labels.get(&id) {
                        let _ = sub.set_text(t);
                    }
                    if let Ok(children) = sub.items() {
                        relabel(children, labels);
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            relabel(items, &labels);
        }
    }
    if let Some(tray) = app.try_state::<TrayMenu>() {
        if let Ok(items) = tray.0.items() {
            relabel(items, &labels);
        }
    }
    Ok(())
}

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error, Level};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_appender::rolling::{RollingFileAppender, Rotation};

mod autostart;
mod backup;
mod commands;
mod daemon_channel;
mod dropped_files;
// dns.rs is gone (Task 5.8) and smtp.rs is gone (Task 5.9): both had every
// #[tauri::command] on top of them moved to the daemon in an earlier task
// (5.8, 5.5) and were left as unreferenced re-export shims for that task to
// stay in scope; 5.9's cleanup pass confirmed each had zero remaining
// src-tauri callers and deleted both files outright, same treatment.
// archive.rs is gone the same way (Phase 3 remainder, Task 5): it was only
// the `run_with_backup` shim that built the core runner's context — root,
// the app's process-global `ImapPool`, a no-op write gate — for the app-side
// backup runner, and that runner now lives in the daemon, which builds the
// same context from its own state (`handlers::archive::archive_ctx`) under a
// real gate. Deleting it takes the app's last ungated vault writer with it.
mod external_location;
mod github;
// graph/imap/oauth2 all live in mailvault_core (shared with src-daemon) and
// src-tauri no longer references any of them: OAuth2Manager is constructed
// once in the daemon's DaemonState (Task 5.7), and the Phase 3 remainder's
// Task 5 moved the backup runners — this crate's last `GraphClient` and
// `ImapPool` callers — there too, so no re-export is left for any of the three.
mod iap;
mod mailto;
mod notification_open;
mod notification_sound;
mod spellcheck;
mod vault;
mod vault_flags;

#[cfg(target_os = "macos")]
use cocoa::appkit::NSApplication;
#[cfg(target_os = "macos")]
use cocoa::base::nil;
#[cfg(target_os = "macos")]
use cocoa::foundation::NSString;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

// Global log directory
struct LogDir(PathBuf);

fn get_log_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn setup_logging(log_dir: &PathBuf) -> tracing_appender::non_blocking::WorkerGuard {
    // Create log directory if it doesn't exist
    let _ = fs::create_dir_all(log_dir);

    // Set up rolling file appender (daily rotation)
    let file_appender = RollingFileAppender::new(
        Rotation::DAILY,
        log_dir,
        "mailvault.log",
    );

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_max_level(Level::DEBUG)
        .with_writer(non_blocking.and(std::io::stdout))
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .init();

    info!("Logging initialized. Log directory: {:?}", log_dir);

    guard
}

fn cleanup_old_logs(log_dir: &PathBuf) {
    let max_age_days = 7;
    let max_size_bytes: u64 = 5 * 1024 * 1024; // 5 MB

    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "log") {
                // Check file age
                if let Ok(metadata) = fs::metadata(&path) {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
                            if age.as_secs() > max_age_days * 24 * 60 * 60 {
                                info!("Removing old log file: {:?}", path);
                                let _ = fs::remove_file(&path);
                                continue;
                            }
                        }
                    }

                    // Check file size
                    if metadata.len() > max_size_bytes {
                        info!("Removing oversized log file: {:?} ({}MB)", path, metadata.len() / 1024 / 1024);
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn log_from_frontend(message: String) {
    info!("[FRONTEND] {}", message);
}

// ── Client identity (persistent per-install UUID for device registration) ────

/// Stands in for the OS handing over a `mailto:` URL.
///
/// The e2e harness disables `tauri-plugin-single-instance` (see the automation
/// carve-out below), and that plugin is exactly what forwards a real deep link
/// to the running app — so no test can produce a genuine handover. This injects
/// one at the same seam the real one uses (queue, then wake-up) and is inert
/// outside the `webdriver` build.
#[tauri::command]
fn e2e_queue_mailto(app: tauri::AppHandle, url: String) {
    #[cfg(feature = "webdriver")]
    {
        app.state::<mailto::PendingMailto>().push(url);
        let _ = app.emit("mailto-open", ());
    }
    #[cfg(not(feature = "webdriver"))]
    {
        let _ = (app, url);
    }
}

#[tauri::command]
fn take_pending_mailto(state: tauri::State<mailto::PendingMailto>) -> Vec<String> {
    state.take()
}

#[tauri::command]
fn mailto_default_status() -> mailto::MailtoStatus {
    mailto::status()
}

#[tauri::command]
async fn mailto_make_default() -> mailto::MailtoStatus {
    // macOS launches a helper and then polls LaunchServices for up to five
    // seconds; Linux shells out to `xdg-settings`. Neither belongs on the main
    // thread — the window would freeze for the duration.
    tauri::async_runtime::spawn_blocking(mailto::make_default)
        .await
        .unwrap_or_else(|_| mailto::status())
}

#[tauri::command]
fn get_client_info(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;

    // Ensure the data directory exists
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Could not create app data directory: {}", e))?;
    }

    let client_id_path = data_dir.join("client-id.txt");

    // Read existing client ID or generate a new one
    let client_id = if client_id_path.exists() {
        let contents = std::fs::read_to_string(&client_id_path)
            .map_err(|e| format!("Could not read client-id.txt: {}", e))?;
        let trimmed = contents.trim().to_string();
        if trimmed.is_empty() {
            let new_id = uuid::Uuid::new_v4().to_string();
            std::fs::write(&client_id_path, &new_id)
                .map_err(|e| format!("Could not write client-id.txt: {}", e))?;
            new_id
        } else {
            trimmed
        }
    } else {
        let new_id = uuid::Uuid::new_v4().to_string();
        std::fs::write(&client_id_path, &new_id)
            .map_err(|e| format!("Could not write client-id.txt: {}", e))?;
        info!("Generated new client ID: {}", new_id);
        new_id
    };

    // App version from Cargo package version (matches tauri.conf.json)
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    // Platform
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    };

    // OS version
    let os_version = get_os_version();

    // Client name: user-friendly device label
    let client_name = get_client_name();

    Ok(serde_json::json!({
        "clientId": client_id,
        "appVersion": app_version,
        "platform": platform,
        "osVersion": os_version,
        "clientName": client_name,
    }))
}

#[cfg(target_os = "macos")]
fn get_os_version() -> String {
    use std::process::Command;
    Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| format!("macOS {}", s.trim()))
        .unwrap_or_else(|| "macOS (unknown version)".to_string())
}

#[cfg(target_os = "windows")]
fn get_os_version() -> String {
    use std::process::Command;
    Command::new("cmd")
        .args(["/C", "ver"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Windows (unknown version)".to_string())
}

#[cfg(target_os = "linux")]
fn get_os_version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|contents| {
            contents.lines()
                .find(|l| l.starts_with("PRETTY_NAME="))
                .map(|l| l.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "Linux (unknown distro)".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn get_os_version() -> String {
    format!("{} (unknown version)", std::env::consts::OS)
}

fn get_client_name() -> String {
    // Try hostname as a reasonable device label
    #[cfg(target_os = "macos")]
    {
        // On macOS, try the ComputerName first (user-friendly like "Rokas's MacBook Pro")
        use std::process::Command;
        if let Ok(output) = Command::new("scutil").arg("--get").arg("ComputerName").output() {
            if output.status.success() {
                if let Ok(name) = String::from_utf8(output.stdout) {
                    let trimmed = name.trim().to_string();
                    if !trimmed.is_empty() {
                        return trimmed;
                    }
                }
            }
        }
    }

    // Fallback: hostname
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "Unknown Device".to_string())
}

#[tauri::command]
fn get_app_data_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    info!("get_app_data_dir called");
    app_handle
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Could not get app data directory: {}", e))
}

// Read frontend settings from JSON file on disk (replaces localStorage)
#[tauri::command]
fn read_settings_json(app_handle: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Could not get app data dir: {}", e))?;
    let settings_path = data_dir.join("frontend-settings.json");
    if settings_path.exists() {
        fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))
    } else {
        Ok(String::from("{}"))
    }
}

// Write frontend settings to JSON file on disk (replaces localStorage)
#[tauri::command]
fn write_settings_json(app_handle: tauri::AppHandle, data: String) -> Result<(), String> {
    let data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Could not get app data dir: {}", e))?;
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    let settings_path = data_dir.join("frontend-settings.json");
    fs::write(&settings_path, &data)
        .map_err(|e| format!("Failed to write settings: {}", e))
}

// Use a more specific service name with bundle ID for persistence across builds
const KEYRING_SERVICE: &str = "com.mailvault.app";
const CREDENTIALS_KEY: &str = "credentials";

/// E2E hatch: with `MAILVAULT_TEST_CREDENTIALS=<path>` the credential blob lives in
/// that file instead of the OS keychain. Tests get an isolated account set with no
/// keychain prompt, and — more importantly — cannot write mock accounts into the
/// developer's real credential entry. Debug builds only: a shipped binary ignores it.
#[cfg(debug_assertions)]
fn test_credentials_path() -> Option<std::path::PathBuf> {
    std::env::var_os("MAILVAULT_TEST_CREDENTIALS").map(std::path::PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn test_credentials_path() -> Option<std::path::PathBuf> {
    None
}

// Store all credentials as a single JSON object in keychain
// This triggers the keychain modal only once instead of per-account
// Async: runs on background thread so macOS keychain dialog can appear without blocking main thread
#[tauri::command]
async fn store_credentials(credentials: std::collections::HashMap<String, String>) -> Result<(), String> {
    info!("=== STORE CREDENTIALS START ===");
    info!("Storing credentials for {} account(s)", credentials.len());

    if let Some(path) = test_credentials_path() {
        warn!("MAILVAULT_TEST_CREDENTIALS set — writing credentials to {:?}, NOT the keychain", path);
        let json = serde_json::to_string(&credentials)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
        return std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write test credentials: {}", e));
    }

    tokio::task::spawn_blocking(move || {
        let json = serde_json::to_string(&credentials)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

        let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

        entry.set_password(&json)
            .map_err(|e| format!("Failed to store credentials: {}", e))?;

        info!("Credentials stored successfully");
        info!("=== STORE CREDENTIALS END ===");
        Ok(())
    }).await.map_err(|e| format!("Keychain task panicked: {}", e))?
}

// Get all credentials as a single JSON object from keychain.
// Returns a structured result with status so the frontend can distinguish
// granted/denied/cancelled/timed_out/empty/unavailable outcomes.
// Async: runs on background thread so macOS keychain dialog can appear without blocking main thread
#[tauri::command]
async fn get_credentials() -> Result<serde_json::Value, String> {
    info!("=== GET CREDENTIALS START ===");

    if let Some(path) = test_credentials_path() {
        warn!("MAILVAULT_TEST_CREDENTIALS set — reading credentials from {:?}, NOT the keychain", path);
        let credentials: std::collections::HashMap<String, String> = match std::fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| format!("Failed to parse test credentials: {}", e))?,
            // No file yet is the first-launch case, same as an empty keychain.
            Err(_) => std::collections::HashMap::new(),
        };
        let status = if credentials.is_empty() { "empty" } else { "granted" };
        info!("=== GET CREDENTIALS END (test file, status: {}) ===", status);
        return Ok(serde_json::json!({ "status": status, "credentials": credentials }));
    }

    let keychain_future = tokio::task::spawn_blocking(move || -> Result<(String, std::collections::HashMap<String, String>), String> {
        let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

        match entry.get_password() {
            Ok(json) => {
                let credentials: std::collections::HashMap<String, String> = serde_json::from_str(&json)
                    .map_err(|e| format!("Failed to parse credentials: {}", e))?;
                info!("Retrieved credentials for {} account(s)", credentials.len());
                if credentials.is_empty() {
                    Ok(("empty".to_string(), credentials))
                } else {
                    Ok(("granted".to_string(), credentials))
                }
            }
            Err(e) => {
                let err_str = format!("{}", e);
                let err_debug = format!("{:?}", e);
                warn!("get_credentials: keychain error: {} — debug: {}", err_str, err_debug);

                // Map platform errors to stable statuses
                let status = if err_debug.contains("NoEntry") || err_str.contains("not found") || err_str.contains("No password found") {
                    "empty" // No entry exists yet — first launch
                } else if err_str.contains("denied") || err_str.contains("not allowed") || err_debug.contains("Denied") {
                    "denied"
                } else if err_str.contains("cancel") || err_debug.contains("Cancel") || err_str.contains("user canceled") {
                    "cancelled"
                } else {
                    "unavailable" // Platform error (D-Bus down, keyring locked, etc.)
                };

                Err(format!("{}:{}", status, err_str))
            }
        }
    });

    // Timeout after 5 seconds — prevents slow keychain (D-Bus/Keychain) from blocking app startup
    // On timeout, retry once with 10s timeout before giving up
    match tokio::time::timeout(std::time::Duration::from_secs(5), keychain_future).await {
        Ok(join_result) => {
            match join_result.map_err(|e| format!("Keychain task panicked: {}", e))? {
                Ok((status, credentials)) => {
                    info!("=== GET CREDENTIALS END (status: {}) ===", status);
                    Ok(serde_json::json!({ "status": status, "credentials": credentials }))
                }
                Err(err) => {
                    // Parse "status:message" format from the spawn_blocking error
                    let (status, message) = err.split_once(':').unwrap_or(("unavailable", &err));
                    info!("=== GET CREDENTIALS END (status: {}) ===", status);
                    Ok(serde_json::json!({ "status": status, "message": message }))
                }
            }
        }
        Err(_) => {
            warn!("get_credentials: keychain timeout after 5s — retrying with 10s timeout");
            let retry_future = tokio::task::spawn_blocking(move || {
                let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
                    .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
                let json = entry.get_password()
                    .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;
                let credentials: std::collections::HashMap<String, String> = serde_json::from_str(&json)
                    .map_err(|e| format!("Failed to parse credentials: {}", e))?;
                info!("get_credentials: retry succeeded with {} account(s)", credentials.len());
                Ok::<_, String>(credentials)
            });
            match tokio::time::timeout(std::time::Duration::from_secs(10), retry_future).await {
                Ok(join_result) => {
                    match join_result.map_err(|e| format!("Keychain retry panicked: {}", e))? {
                        Ok(credentials) => {
                            let status = if credentials.is_empty() { "empty" } else { "granted" };
                            info!("=== GET CREDENTIALS END (retry, status: {}) ===", status);
                            Ok(serde_json::json!({ "status": status, "credentials": credentials }))
                        }
                        Err(err) => {
                            info!("=== GET CREDENTIALS END (retry failed) ===");
                            Ok(serde_json::json!({ "status": "unavailable", "message": err }))
                        }
                    }
                }
                Err(_) => {
                    warn!("get_credentials: keychain retry also timed out — returning timed_out");
                    info!("=== GET CREDENTIALS END (timed_out) ===");
                    Ok(serde_json::json!({ "status": "timed_out", "message": "Keychain access timed out after 15 seconds" }))
                }
            }
        }
    }
}

// Legacy function - store single password (kept for migration)
#[tauri::command]
fn store_password(account_id: String, password: String) -> Result<(), String> {
    info!("=== STORE PASSWORD START ===");
    info!("store_password called for account: {}", account_id);
    info!("Service name: {}", KEYRING_SERVICE);
    info!("Password length: {} chars", password.len());

    let entry = Entry::new(KEYRING_SERVICE, &account_id);
    info!("Entry::new result: {:?}", entry.is_ok());
    if let Err(ref e) = entry {
        error!("Entry::new error details: {:?}", e);
    }

    let entry = entry.map_err(|e| {
        error!("Failed to create keyring entry: {} - {:?}", e, e);
        format!("Failed to create keyring entry: {}", e)
    })?;

    info!("Attempting to set password in keyring...");
    let result = entry.set_password(&password);
    match &result {
        Ok(_) => {
            info!("Password stored successfully for account: {}", account_id);
            // Verify it was stored by reading it back
            match entry.get_password() {
                Ok(_) => info!("Verification: Password can be retrieved after storing"),
                Err(e) => warn!("Verification failed: Cannot retrieve password after storing: {}", e),
            }
        },
        Err(e) => error!("Failed to store password for account {}: {} - {:?}", account_id, e, e),
    }
    info!("=== STORE PASSWORD END ===");

    result.map_err(|e| format!("Failed to store password: {}", e))
}

#[tauri::command]
fn read_logs(app_handle: tauri::AppHandle, lines: Option<usize>) -> Result<String, String> {
    let log_dir = get_log_dir(&app_handle);
    let lines_to_read = lines.unwrap_or(500);

    info!("read_logs called, reading last {} lines", lines_to_read);

    // Find the most recent log file (files starting with "mailvault")
    let mut log_files: Vec<_> = fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.path()
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            name.starts_with("mailvault") && !name.ends_with(".tmp")
        })
        .collect();

    info!("Found {} log file(s) in {:?}", log_files.len(), log_dir);

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

    if let Some(latest_log) = log_files.first() {
        let file = fs::File::open(latest_log.path())
            .map_err(|e| format!("Failed to open log file: {}", e))?;
        let reader = BufReader::new(file);
        let all_lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();
        let start = all_lines.len().saturating_sub(lines_to_read);
        Ok(all_lines[start..].join("\n"))
    } else {
        Ok("No log files found".to_string())
    }
}

#[tauri::command]
fn clear_logs(app_handle: tauri::AppHandle) -> Result<String, String> {
    let log_dir = get_log_dir(&app_handle);
    info!("clear_logs called, clearing logs in: {:?}", log_dir);

    let mut cleared = 0;
    let mut truncated = 0;

    // Find all log files (files starting with "mailvault")
    let mut log_files: Vec<_> = match fs::read_dir(&log_dir) {
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

#[tauri::command]
async fn check_network_connectivity() -> Result<bool, String> {
    // Was a blocking `fn`: three sequential `TcpStream::connect_timeout` calls,
    // up to 4.5s of the UI thread with the window frozen. Now one async probe
    // that dials all three concurrently — 1.5s worst case, on the runtime.
    let online = mailvault_core::net::probe_internet().await;
    if online {
        info!("Network connectivity confirmed");
    } else {
        warn!("No network connectivity detected - all probe hosts unreachable");
    }
    Ok(online)
}

#[tauri::command]
fn send_notification(
    app_handle: tauri::AppHandle,
    title: String,
    body: String,
    sound: Option<String>,
    target: Option<notification_open::NotificationTarget>,
) -> Result<(), String> {
    info!("send_notification called: {} - {}", title, body);

    // The plugin's banner cannot report a click; this one opens `target`.
    #[cfg(target_os = "macos")]
    if notification_open::mac::available() {
        let sound = notification_sound::sound_name(sound.as_deref());
        return notification_open::mac::show(&title, &body, sound, target.as_ref());
    }
    let _ = target;

    use tauri_plugin_notification::NotificationExt;
    let notification = app_handle
        .notification()
        .builder()
        .title(&title)
        .body(&body);
    #[cfg(target_os = "macos")]
    let notification = match notification_sound::sound_name(sound.as_deref()) {
        Some(name) => notification.sound(name),
        None => notification,
    };
    #[cfg(not(target_os = "macos"))]
    let _ = sound;
    notification
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))?;

    Ok(())
}

// `graph_ledger_path`/`GRAPH_ID_MAP_FILE` are gone (Phase 3 remainder, Task
// 5): the Graph backup was the app's last caller of the Outlook uid ledger,
// and it now allocates from `mailvault_core::graph_ledger` inside the
// daemon, alongside the (already moved) `graph_allocate_uids`/
// `load_graph_id_map` routes — one process, one lock, one path builder.

#[tauri::command]
fn check_running_from_dmg() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // Check if the app is running from a DMG (mounted volume)
        if let Ok(exe_path) = std::env::current_exe() {
            let path_str = exe_path.to_string_lossy();
            // DMG volumes are typically mounted under /Volumes/
            // But we need to exclude /Volumes/Macintosh HD which is the main disk
            if path_str.starts_with("/Volumes/") && !path_str.contains("Macintosh HD") {
                info!("Warning: App appears to be running from a DMG at: {}", path_str);
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn set_badge_count(_app_handle: tauri::AppHandle, count: i32) -> Result<(), String> {
    tracing::debug!("set_badge_count called with count: {}", count);

    #[cfg(target_os = "macos")]
    {
        unsafe {
            let app = NSApplication::sharedApplication(nil);
            let dock_tile: cocoa::base::id = msg_send![app, dockTile];

            if count > 0 {
                let badge_string = NSString::alloc(nil).init_str(&count.to_string());
                let _: () = msg_send![dock_tile, setBadgeLabel: badge_string];
            } else {
                let _: () = msg_send![dock_tile, setBadgeLabel: nil];
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Other platforms don't have native dock badges
        info!("Badge not supported on this platform");
    }

    Ok(())
}

#[tauri::command]
fn save_attachment_to(
    filename: String,
    content_base64: String,
    dest_path: String,
) -> Result<String, String> {
    use base64::Engine;

    info!("save_attachment_to called for: {} -> {}", filename, dest_path);

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // A "Save As" destination always exists, but an export written into a
    // cache subdirectory of our own naming does not. fs::write does not create
    // parents, so it is created here — once, for every caller — rather than in
    // a second write command that would drift from this one.
    if let Some(parent) = std::path::Path::new(&dest_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    fs::write(&dest_path, &decoded)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    info!("Attachment saved to: {}", dest_path);
    Ok(dest_path)
}

#[tauri::command]
fn show_in_folder(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    info!("show_in_folder called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        return finder_open(&app_handle, &path, true);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &app_handle;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")))
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

/// Hand a path to Finder, holding the security-scoped bookmark that covers it.
///
/// A path outside the sandbox container is refused unless the app holds the
/// bookmark's scope at that moment — and `.spawn()`ing `/usr/bin/open` threw
/// away the refusal, so the button appeared to do nothing.
#[cfg(target_os = "macos")]
fn finder_open(app_handle: &tauri::AppHandle, path: &str, reveal: bool) -> Result<(), String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
    external_location::open_in_finder(&data_dir, path, reveal)
}

#[tauri::command]
fn open_file(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    info!("open_file called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        // LaunchServices takes any folder ending in `.app` for a bundle — and
        // the app data dir is named `com.mailvault.app`. Opening it would try
        // to LAUNCH it, fail with "executable is missing", and show nothing.
        // Reveal such a folder in its parent instead; everything else opens.
        // ponytail: only `.app` is special-cased; add `.bundle`/`.framework`
        // if a data folder ever gets one of those names.
        let p = std::path::Path::new(&path);
        let reveal = p.is_dir() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"));
        return finder_open(&app_handle, &path, reveal);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &app_handle;

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn open_with_dialog(path: String) -> Result<(), String> {
    info!("open_with_dialog called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            set chosenApp to choose application with prompt "Open '{}' with:"
            set appPath to POSIX path of (path to chosenApp)
            do shell script "open -a " & quoted form of appPath & " " & quoted form of "{}"
            "#,
            Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
                .replace("\"", "\\\""),
            path.replace("\"", "\\\"")
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open 'Open With' dialog: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(["shell32.dll,OpenAs_RunDLL", &path])
            .spawn()
            .map_err(|e| format!("Failed to open 'Open With' dialog: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

// ==========================================
// Open email in a new window
// ==========================================

static WINDOW_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[tauri::command]
async fn open_email_window(app: tauri::AppHandle, html: String, title: String) -> Result<(), String> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    let n = WINDOW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("email-popup-{}", n);

    // Write HTML to a temp file — eval on about:blank fails on macOS WKWebView
    let cache_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("popup_cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let html_file = cache_dir.join(format!("email-popup-{}.html", n));
    fs::write(&html_file, &html).map_err(|e| e.to_string())?;

    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(
            format!("file://{}", html_file.to_string_lossy())
                .parse()
                .map_err(|e| format!("open_email_window: invalid URL: {}", e))?,
        ),
    )
    .title(&title)
    .inner_size(800.0, 600.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    info!("Opened email in new window: {}", label);
    Ok(())
}

// Compose is application UI, not untrusted email HTML. It gets its own
// webview so native resize and close behaviour remain owned by the platform.
#[tauri::command]
async fn open_compose_window(app: tauri::AppHandle, compose_id: String, token: String) -> Result<String, String> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    let compose_id: u64 = compose_id.parse().map_err(|_| "Invalid compose window id")?;
    if token.len() > 128 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid compose window token".into());
    }
    let n = WINDOW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("compose-{}-{}", compose_id, n);
    // Compose ids are generated by the main UI as integers. Keep the URL on
    // the app origin; the value is only a bridge routing key.
    let url = format!("app.html?compose={}&token={}", compose_id, token);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("New Message")
        .inner_size(900.0, 680.0)
        .min_inner_size(520.0, 420.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

// ==========================================
// Maildir .eml storage commands (remaining app-side writers)
//
// The read family and the attachment cache (maildir_read, maildir_read_light,
// maildir_read_light_batch, maildir_read_raw_source, maildir_read_attachment,
// maildir_exists, maildir_list, maildir_storage_stats, maildir_orphan_stats,
// cache_attachment, cached_attachment_path, prefetch_attachments) moved to
// the daemon (Task 2.6, `handlers::vault_files`), and the six simple writers
// (maildir_store, maildir_delete, maildir_set_flags, maildir_clear_cache,
// maildir_migrate_json_to_eml, maildir_migrate_email_dirs) moved with them
// (Task 2.8) — DAEMON_OWNED in transport.js, no Tauri command left for any of
// them. The custody-backed trio (maildir_delete_many,
// maildir_repair_generation, maildir_purge_orphans) followed in Task 2.9b,
// once custody.db itself opened in the daemon. `maildir_store_raw` (its only
// caller, `commands.rs`'s `imap_get_email_light`) moved to the daemon in
// Task 5.4a too — `handlers::imap` writes the already-in-memory bytes
// directly via `vault_files`'s store fn (called with overwrite: false),
// no base64 round trip, no app-side function left to call. What is left here
// is the three vault_flags forwarders in `vault_flags.rs`, which exist only
// to resolve the backup mirror's security-scoped bookmark for the daemon.
// ==========================================

// ── Mail storage location ───────────────────────────────────────────────────

/// Phase 6: the disk check (does the configured path still look like our
/// vault) now runs in the daemon (`handlers::vault::route`'s
/// `vault_get_status`, backed by fields the daemon computed once at its own
/// startup). This is a forward, not a cache read any more — see the phase 6
/// plan doc's accepted staleness trade-off (a poll racing an adopt/move's
/// restart window can be briefly stale; the `vault-status` event, emitted
/// straight after that restart, is what the frontend actually reconciles
/// against — `VaultAlertBanner.jsx` already swallows this call's rejection).
#[tauri::command]
async fn vault_get_status(app_handle: tauri::AppHandle) -> Result<vault::VaultStatus, String> {
    tokio::task::spawn_blocking(move || {
        let value = daemon_call_blocking(&app_handle, "vault_get_status", serde_json::json!({}), std::time::Duration::from_secs(30))?;
        serde_json::from_value(value).map_err(|e| format!("vault_get_status: unreadable reply: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn vault_inspect_folder(app_handle: tauri::AppHandle, path: String) -> Result<vault::FolderInspection, String> {
    vault::inspect_folder(&app_handle, &path)
}

/// Point the app at a folder that already holds the mail (drive reconnected at
/// a new path, or the folder was moved by hand). The classification and
/// marker work now run in the daemon (`handlers::vault::route`'s
/// `vault_adopt`); this command still owns the bookmark (spec §3.4) and the
/// close/restart choreography around it.
///
/// Async + blocking thread: closing the search index waits on its mutex.
#[tauri::command]
async fn vault_adopt(app_handle: tauri::AppHandle, path: String) -> Result<vault::VaultStatus, String> {
    tokio::task::spawn_blocking(move || {
        let suspended = suspend_daemon();
        daemon_vault_lifecycle_call(&app_handle, "vault_close", std::time::Duration::from_secs(300));
        let result = daemon_call_blocking(&app_handle, "vault_adopt", serde_json::json!({"path": path.clone()}), std::time::Duration::from_secs(600))
            .and_then(|_| {
                let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
                external_location::save_external_location(&data_dir, external_location::SLOT_VAULT, &path)
            })
            .map(|_| vault::resolve(&app_handle));
        let status = match result {
            Ok(s) => s,
            Err(e) => {
                drop(suspended);
                daemon_vault_lifecycle_call(&app_handle, "vault_reopen", std::time::Duration::from_secs(60));
                return Err(e);
            }
        };
        // The daemon reads the storage location once at startup: the channel
        // respawns it on the new root only once `suspended` clears below.
        stop_daemon();
        drop(suspended);
        let _ = app_handle.emit("vault-status", status.clone());
        Ok(status)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Copy the mail data to `path` (daemon `vault_move_to`), then either commit
/// (bookmark saved and it resolves as ready: delete the originals, switch
/// over) or abort (leave the source and the stray destination copy in
/// place) via `vault_move_finalize` — see the phase 6 plan doc's
/// "Restart-ordering fix" for why the delete can't happen in the same round
/// trip as the copy.
#[tauri::command]
async fn vault_move_to(app_handle: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        vault_move_finish(&handle, "vault_move_to", serde_json::json!({"path": path.clone()}), Some(&path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    // Pre-Phase-1 behaviour: emitted on success AND failure, so the UI always
    // learns the vault's current status even when the move fell back to the
    // app data dir.
    let _ = app_handle.emit("vault-status", vault::status(&app_handle));
    result
}

/// Bring the mail back into the app data dir, then stop using the custom folder.
#[tauri::command]
async fn vault_move_to_default(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || vault_move_finish(&handle, "vault_move_to_default", serde_json::json!({}), None))
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    let _ = app_handle.emit("vault-status", vault::status(&app_handle));
    result
}

/// Shared body for `vault_move_to`/`vault_move_to_default`: run the daemon's
/// copy step, then the app-only bookmark step, then finalize (commit or
/// abort) based on whether the new bookmark actually resolves. `new_path` is
/// `Some` for `vault_move_to` (save a bookmark to it), `None` for
/// `vault_move_to_default` (clear the bookmark instead).
fn vault_move_finish(
    app_handle: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    new_path: Option<&str>,
) -> Result<serde_json::Value, String> {
    let suspended = suspend_daemon();
    daemon_vault_lifecycle_call(app_handle, "vault_close", std::time::Duration::from_secs(300));

    // Unlike `reply_timeout`'s `None` (consulted only by the generic async
    // `daemon_rpc` passthrough), `daemon_call_blocking` always needs a finite
    // socket timeout. A vault can be very large on a slow external drive —
    // generous rather than unbounded, same reasoning `vault_close`'s 300s
    // already uses one call up.
    let copy_reply = daemon_call_blocking(app_handle, method, params, std::time::Duration::from_secs(6 * 3600));
    let copy_reply = match copy_reply {
        Ok(v) => v,
        Err(e) => {
            drop(suspended);
            daemon_vault_lifecycle_call(app_handle, "vault_reopen", std::time::Duration::from_secs(60));
            return Err(e);
        }
    };
    let move_id = copy_reply.get("moveId").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string());
    let bookmark_result = data_dir.and_then(|data_dir| match new_path {
        Some(p) => external_location::save_external_location(&data_dir, external_location::SLOT_VAULT, p).map(|_| ()),
        None => external_location::clear_external_location(&data_dir, external_location::SLOT_VAULT),
    });
    // Precise per-mode, not "ready or default": a `vault_move_to` whose
    // bookmark save silently no-opped must never read as success just
    // because `resolve()` still reports "default" — that would commit
    // (delete the source) while the app keeps reading the OLD root, losing
    // the just-copied data's only live copy.
    let expected_status = if new_path.is_some() { "ready" } else { "default" };
    let new_status = bookmark_result.map(|_| vault::resolve(app_handle));
    let commit = matches!(&new_status, Ok(s) if s.status == expected_status);

    let finalize_reply = daemon_call_blocking(
        app_handle,
        "vault_move_finalize",
        serde_json::json!({"moveId": move_id, "commit": commit}),
        std::time::Duration::from_secs(120),
    );

    if commit {
        // The data move itself already succeeded and verified (the daemon
        // reply we're merging into is the proof) and the bookmark already
        // points at the new location — a failed finalize here only means the
        // old copy wasn't cleaned up, not that mail was lost. Report it as
        // `sourceRemoved: false` rather than failing the whole move: telling
        // the user the move failed when their mail is safely at the new
        // location would be worse than a stray leftover copy.
        let mut merged = copy_reply;
        match &finalize_reply {
            Ok(reply) => {
                if let Some(removed) = reply.get("sourceRemoved") {
                    merged["sourceRemoved"] = removed.clone();
                }
            }
            Err(e) => {
                tracing::warn!("vault_move_finalize failed after a successful copy+switch: {e}");
                merged["sourceRemoved"] = serde_json::json!(false);
            }
        }
        stop_daemon();
        drop(suspended);
        Ok(merged)
    } else {
        drop(suspended);
        daemon_vault_lifecycle_call(app_handle, "vault_reopen", std::time::Duration::from_secs(60));
        match new_status {
            Err(e) => Err(e),
            Ok(s) => Err(s.last_error.unwrap_or_else(|| "New mail storage folder could not be opened".into())),
        }
    }
}

/// Go back to storing mail in the app data dir. Does not move anything.
/// Async + blocking thread: closing the search index waits on its mutex.
#[tauri::command]
async fn vault_reset(app_handle: tauri::AppHandle) -> Result<vault::VaultStatus, String> {
    tokio::task::spawn_blocking(move || {
        let suspended = suspend_daemon();
        daemon_vault_lifecycle_call(&app_handle, "vault_close", std::time::Duration::from_secs(300));
        let result = vault::reset(&app_handle);
        let status = match result {
            Ok(s) => s,
            Err(e) => {
                drop(suspended);
                daemon_vault_lifecycle_call(&app_handle, "vault_reopen", std::time::Duration::from_secs(60));
                return Err(e);
            }
        };
        stop_daemon();
        drop(suspended);
        let _ = app_handle.emit("vault-status", status.clone());
        Ok(status)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// `maildir_cur_path` (the app's `vault::root` + `vault_files::cur_path`
// wrapper) and `find_msg_file_by_uid` (its test-only per-uid mirror lookup)
// are gone with the backup runners too (Phase 3 remainder, Task 5) —
// `backup.rs` was the only caller of either, and the daemon builds the same
// paths from its own root.

// `maildir_store` moved to the daemon (Task 2.8, `handlers::vault_files`).
// `maildir_store_raw` (this file's own single-UID, non-overwriting writer,
// `imap_get_email_light`'s auto-cache side effect) moved to the daemon too in
// Task 5.4a (`src-daemon/src/handlers/imap.rs`) — its only caller went with
// it, so nothing here calls `mailvault_core::vault_files::store` anymore.

// ── Vault generation (UIDVALIDITY) ──────────────────────────────────────────
//
// `maildir_repair_generation` and `maildir_purge_orphans` moved to the daemon
// (Task 2.9b, `handlers::custody`) — they read and rewrite custody rows, and
// custody.db now opens in the daemon. `maildir_mailbox_path` went with them:
// the daemon derives the mailbox directory from its own root.

// `archive_emails`, `cancel_archive`, `bulk_delete_emails` and
// `verify_archived_emails` moved to the daemon (Task 3.5,
// `src-daemon/src/handlers/archive.rs`, Task 3.4): cancel tokens are now
// per-operation-kind daemon state instead of the app's single shared
// `ArchiveCancelToken` (inventory-archive-bulk N4, fixed at the same time).
// `src-tauri/src/archive.rs`, which kept the `run_with_backup` shim for
// `backup.rs` after that, is deleted too (Phase 3 remainder, Task 5) — the
// backup runners moved to the daemon and took its only caller with them.

// `maildir_delete` and `maildir_delete_many` both live in the daemon now
// (Tasks 2.8 and 2.9b).

// `maildir_set_flags`, `maildir_clear_cache`, `maildir_migrate_json_to_eml`
// and `maildir_migrate_email_dirs` all moved to the daemon (Task 2.8,
// `handlers::vault_files`), each now gated on `common::with_vault_write`
// (single-file writers) or a per-file/per-mailbox `gate` closure (the three
// whole-vault walkers), with the in-process nudge/sweep signal replacing
// `nudge_index`/`sweep_index_soon`.

// `export_backup` and `import_backup` moved to the daemon (Task 4.3/4.4,
// `src-daemon/src/backup_zip.rs`, `handlers::backup_zip`). `accounts.json`
// stays app-only (decision 2): the daemon route only reads it and hands
// back new-account descriptors; the app merges them itself via
// `src/services/db/accounts.js`'s `ensureAccountsInFile`, the same helper
// `init()` already calls for this file. `BackupManifest`/`BackupAccount`/
// `ExportResult`/`ImportResult`/`AccountsJsonEntry` and
// `read_accounts_json`/`write_accounts_json` moved with them (the daemon
// copy owns them now); nothing else in this file referenced them.
//
// `export_mbox_all`/`import_mbox` moved to the daemon too (Task 4.5/4.6,
// `src-daemon/src/mbox.rs`, `handlers::mbox`; import_mbox now also seeds the
// `archived` flag, decision 3). `sanitize_mailbox_name`,
// `mbox_escape_from`/`mbox_unescape_from`/`mbox_from_line`/`split_mbox` and
// `MboxExportResult`/`MboxImportResult` moved with them (the daemon copy
// owns them now, `sanitize_mailbox_name` promoted into
// `handlers::common` in Task 4.5), grep-confirmed nothing else in this
// file called any of them. The dead single-mailbox export variant was
// deleted outright in Task 4.5 (zero callers), not ported.

/// Process-wide guard preventing overlapping update checks.
struct UpdateCheckGuard(AtomicBool);
impl Default for UpdateCheckGuard {
    fn default() -> Self { Self(AtomicBool::new(false)) }
}

#[cfg(target_os = "linux")]
type PendingUpdate = std::sync::Mutex<Option<tauri_plugin_updater::Update>>;

#[cfg(target_os = "linux")]
#[tauri::command]
async fn install_pending_update(handle: tauri::AppHandle) -> Result<(), String> {
    let state = handle.state::<PendingUpdate>();
    // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
    let update = state.lock().unwrap().take();
    match update {
        Some(u) => {
            let h = handle.clone();
            let mut total_downloaded: u64 = 0;
            u.download_and_install(
                move |chunk_length, content_length| {
                    total_downloaded += chunk_length as u64;
                    let percent = content_length
                        .map(|total| ((total_downloaded as f64 / total as f64) * 100.0).min(100.0) as u8)
                        .unwrap_or(0);
                    let _ = h.emit("update-download-progress", serde_json::json!({
                        "downloaded": total_downloaded,
                        "total": content_length,
                        "percent": percent
                    }));
                },
                || {},
            ).await.map_err(|e| e.to_string())?;
            info!("Update installed successfully, restarting...");
            handle.restart();
        }
        None => Err("No pending update".to_string()),
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn install_pending_update(_handle: tauri::AppHandle) -> Result<(), String> {
    Err("macOS updates are installed via DMG download".to_string())
}

// ── Update track ────────────────────────────────────────────────────────────
// Two Sparkle feeds: the stable one is SUFeedURL in Info.plist, the nightly one
// rides the rolling `nightly` prerelease and is applied through the delegate's
// feed-URL override.

const NIGHTLY_APPCAST_URL: &str =
    "https://github.com/GraphicMeat/mail-vault-app/releases/download/nightly/appcast.xml";

/// Sparkle feed override for the chosen update track. `None` = use the
/// stable feed from Info.plist. With no saved choice a nightly build follows
/// the nightly feed and a stable build the stable one.
#[allow(dead_code)] // Only the macOS + Sparkle build applies it; the tests read it everywhere.
fn update_feed_override(track: Option<&str>, app_version: &str) -> Option<String> {
    match track {
        Some("nightly") => Some(NIGHTLY_APPCAST_URL.to_string()),
        Some("stable") => None,
        // Anything else is "no choice made": follow the build.
        _ => app_version
            .contains("-nightly")
            .then(|| NIGHTLY_APPCAST_URL.to_string()),
    }
}

/// Whether the user asked for the daemon to keep running after the app quits.
///
/// Read off disk rather than asked of the frontend: this runs inside
/// `RunEvent::Exit`, when the webview is already gone. Any problem reads as
/// "off", so a corrupt settings file costs a background daemon, never a
/// stray one the user cannot see or stop.
fn daemon_always_on(handle: &tauri::AppHandle) -> bool {
    let Ok(dir) = handle.path().app_data_dir() else { return false };
    let Ok(raw) = fs::read_to_string(dir.join("frontend-settings.json")) else { return false };
    mailvault_core::autostart::always_on_from_settings(&raw)
}

/// The frontend's persisted `updateTrack`, read straight off disk — this runs in
/// `setup()`, long before a window could be asked. Any problem reads as "unset".
fn persisted_update_track(handle: &tauri::AppHandle) -> Option<String> {
    let path = handle
        .path()
        .app_data_dir()
        .ok()?
        .join("frontend-settings.json");
    let raw = fs::read_to_string(path).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
    settings["mailvault-settings"]["state"]["updateTrack"]
        .as_str()
        .map(String::from)
}

#[cfg(all(target_os = "macos", feature = "sparkle"))]
fn apply_update_track(handle: &tauri::AppHandle, track: Option<&str>) {
    use tauri_plugin_sparkle_updater::SparkleUpdaterExt;

    let sparkle = match handle.sparkle_updater() {
        Some(s) => s,
        None => {
            warn!("Sparkle updater not available (dev mode?) — update track not applied");
            return;
        }
    };

    let feed = update_feed_override(track, env!("CARGO_PKG_VERSION"));
    let in_effect = feed.clone().unwrap_or_else(|| "stable feed".to_string());
    match sparkle.set_feed_url_override(feed) {
        Ok(()) => info!(
            "Update track '{}' — {}",
            track.unwrap_or("(unset)"),
            in_effect
        ),
        Err(e) => error!("Failed to set the Sparkle feed override: {}", e),
    }
}

// Linux uses tauri-plugin-updater and MAS builds update through the App Store:
// neither has a feed to override.
#[cfg(not(all(target_os = "macos", feature = "sparkle")))]
fn apply_update_track(_handle: &tauri::AppHandle, _track: Option<&str>) {}

#[tauri::command]
fn set_update_track(handle: tauri::AppHandle, track: String) -> Result<(), String> {
    apply_update_track(&handle, Some(&track));
    Ok(())
}

/// Shared update check logic for both manual menu trigger and startup auto-check.
/// `show_no_update` controls whether to show a dialog when already up-to-date.
#[cfg(target_os = "linux")]
async fn check_for_updates(handle: tauri::AppHandle, show_no_update: bool) {
    use tauri_plugin_updater::UpdaterExt;
    use tauri_plugin_dialog::DialogExt;

    // Single-flight guard: reject overlapping checks
    let guard = handle.state::<UpdateCheckGuard>();
    if guard.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        if show_no_update {
            info!("Manual update check ignored — another check is already in progress");
        }
        return;
    }
    // Ensure the flag is cleared on every exit path
    struct ClearGuard<'a>(&'a AtomicBool);
    impl Drop for ClearGuard<'_> {
        fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
    }
    let _clear = ClearGuard(&guard.0);

    // Snap packages update via the Snap Store — skip Tauri updater
    if std::env::var("SNAP").is_ok() {
        info!("Running as snap — updates managed by Snap Store");
        if show_no_update {
            handle.dialog()
                .message("This app was installed from the Snap Store.\nUpdates are delivered automatically through the Snap Store.")
                .title("Updates")
                .show(|_| {});
        }
        return;
    }

    info!("Checking for updates (manual={})", show_no_update);

    // Check for updates via latest.json
    // Note: Auto-update only works for AppImage installs. For .deb installs,
    // we can detect new versions but users must download manually.
    let updater = match handle.updater() {
        Ok(u) => u,
        Err(e) => {
            error!("Failed to create updater: {}", e);
            if show_no_update {
                handle.dialog()
                    .message("Auto-update is not available for this installation type.\nVisit https://mailvaultapp.com to check for new versions.")
                    .title("Updates")
                    .show(|_| {});
            }
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            info!("Update available: {} -> {}", env!("CARGO_PKG_VERSION"), update.version);
            let version = update.version.clone();
            let body = update.body.clone().unwrap_or_default();

            // Emit to frontend — React handles the UI
            let _ = handle.emit("update-available", serde_json::json!({
                "version": version,
                "notes": body,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "isManualCheck": show_no_update
            }));

            // Store the update object for later install
            let state = handle.state::<PendingUpdate>();
            // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
            *state.lock().unwrap() = Some(update);
        }
        Ok(None) => {
            info!("No updates available");
            if show_no_update {
                handle.dialog()
                    .message(format!("You're running the latest version (v{}).", env!("CARGO_PKG_VERSION")))
                    .title("No Updates Available")
                    .show(|_| {});
            }
        }
        Err(e) => {
            error!("Update check failed: {}", e);
            if show_no_update {
                handle.dialog()
                    .message("Could not check for updates.\nVisit https://mailvaultapp.com to check for new versions.")
                    .title("Update Error")
                    .show(|_| {});
            }
        }
    }
}

// MAS builds have no Sparkle — the App Store handles updates. No-op so the
// menu item and startup auto-check still link.
#[cfg(all(target_os = "macos", not(feature = "sparkle")))]
async fn check_for_updates(_handle: tauri::AppHandle, _show_no_update: bool) {
    info!("Update check skipped — updates are managed by the Mac App Store");
}

#[cfg(all(target_os = "macos", feature = "sparkle"))]
async fn check_for_updates(handle: tauri::AppHandle, show_no_update: bool) {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_sparkle_updater::SparkleUpdaterExt;

    // Single-flight guard: reject overlapping checks
    let guard = handle.state::<UpdateCheckGuard>();
    if guard.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        if show_no_update {
            info!("Manual update check ignored — another check is already in progress");
        }
        return;
    }
    struct ClearGuard<'a>(&'a AtomicBool);
    impl Drop for ClearGuard<'_> {
        fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
    }
    let _clear = ClearGuard(&guard.0);

    info!("Checking for updates via Sparkle (manual={})", show_no_update);

    let sparkle = match handle.sparkle_updater() {
        Some(s) => s,
        None => {
            warn!("Sparkle updater not available (dev mode?)");
            if show_no_update {
                handle.dialog()
                    .message("Auto-update is not available in development mode.")
                    .title("Updates")
                    .show(|_| {});
            }
            return;
        }
    };

    // Trigger a probe-only check — fires Sparkle events without showing native UI.
    // The frontend JS side listens for sparkle://did-find-valid-update directly.
    // Here we also poll last_found_update() to bridge into the existing update-available event.
    if let Err(e) = sparkle.check_for_update_information() {
        error!("Failed to initiate Sparkle update check: {}", e);
        if show_no_update {
            handle.dialog()
                .message("Could not check for updates. Please try again later.")
                .title("Update Error")
                .show(|_| {});
        }
        return;
    }

    // Give Sparkle time to fetch and parse the appcast
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    // Check if Sparkle found an update
    match sparkle.last_found_update() {
        Ok(Some(update_info)) => {
            let version = update_info.version.clone();
            let notes = update_info.release_notes.clone().unwrap_or_default();

            info!("Update available: {} -> {}", env!("CARGO_PKG_VERSION"), version);
            let _ = handle.emit("update-available", serde_json::json!({
                "version": version,
                "notes": notes,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "isManualCheck": show_no_update
            }));
        }
        _ => {
            info!("No updates available");
            if show_no_update {
                handle.dialog()
                    .message(format!("You're running the latest version (v{}).", env!("CARGO_PKG_VERSION")))
                    .title("No Updates Available")
                    .show(|_| {});
            }
        }
    }
}

// ── Daemon RPC proxy ────────────────────────────────────────────────────────
// Bridges frontend invoke() calls to the mailvault-daemon Unix socket.
// In on-demand mode, auto-spawns the daemon if the socket isn't reachable.

use std::sync::{LazyLock, Mutex, MutexGuard};

/// Tracks a daemon child process spawned in on-demand mode.
static DAEMON_CHILD: LazyLock<Mutex<Option<std::process::Child>>> = LazyLock::new(|| Mutex::new(None));

/// Serializes daemon stop/verify/restart (`ensure_daemon_running`, `stop_daemon`)
/// against a concurrent `daemon_rpc` auto-spawn, so a build-mismatch restart and
/// an on-demand spawn from another request can never race each other.
/// Lock order: LIFECYCLE then CHILD — always take this one first; never take it
/// while already holding `DAEMON_CHILD`. `ensure_daemon_socket` only ever
/// takes CHILD alone, nested inside a caller that already holds LIFECYCLE.
/// `shutdown_daemon_child` also only ever takes CHILD alone, but is not
/// always nested inside LIFECYCLE: `stop_daemon` holds LIFECYCLE across it,
/// while `RunEvent::Exit` calls it bare at app shutdown — `APP_EXITING`,
/// not this lock, is what guards that path against a concurrent spawn.
static DAEMON_LIFECYCLE: Mutex<()> = Mutex::new(());

/// Set for the whole window a vault handler holds the index closed and is
/// copying/moving files (spec addendum D / C4): a crash or restart mid-move
/// must not let a reconnecting channel spawn a fresh daemon onto the root
/// being moved. Only `DaemonSuspended`'s constructor/`Drop` touch this.
static DAEMON_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// RAII guard for `DAEMON_SUSPENDED`. `Drop` clears the flag unconditionally
/// (including when dropped while unwinding from a panic), so a crashed vault
/// handler never leaves the daemon permanently unspawnable.
struct DaemonSuspended;

impl Drop for DaemonSuspended {
    fn drop(&mut self) {
        DAEMON_SUSPENDED.store(false, Ordering::SeqCst);
    }
}

/// Only the four vault handlers below call this, for exactly the window
/// between closing the index and either restarting the daemon (success) or
/// reopening the index (failure).
fn suspend_daemon() -> DaemonSuspended {
    DAEMON_SUSPENDED.store(true, Ordering::SeqCst);
    DaemonSuspended
}

/// Pure decision (addendum D.2): may `ensure_daemon_socket` spawn a fresh
/// daemon right now? False while a vault handler holds `DAEMON_SUSPENDED`.
fn may_spawn_daemon() -> bool {
    !DAEMON_SUSPENDED.load(Ordering::SeqCst)
}

/// Set at the very start of `RunEvent::Exit`, before `daemon_channel::stop()`
/// and `shutdown_daemon_child()` run. A reconnect attempt already blocked
/// inside `ensure_daemon_running` (e.g. behind `DAEMON_LIFECYCLE` held by a
/// vault-switch restart) can still be running after `shutdown_daemon_child()`
/// has released `DAEMON_CHILD` — this flag is what stops `ensure_daemon_socket`
/// from spawning a fresh orphan daemon in that window, checked right before
/// the spawn while still holding `DAEMON_CHILD` (no new lock, same order).
static APP_EXITING: AtomicBool = AtomicBool::new(false);

/// Our own on-demand child's pid right now, if we have one. Locks `DAEMON_CHILD`
/// just long enough to read it — never held across a wait.
fn daemon_child_pid() -> Option<libc::pid_t> {
    DAEMON_CHILD.lock().ok()?.as_ref().map(|c| c.id() as libc::pid_t)
}

/// `$HOME/.mailvault/{mv.sock, mv.token}`; must match src-daemon's `ipc_dir()`.
/// Inside the sandbox HOME is the container home, the same for app and daemon.
pub(crate) fn daemon_ipc_paths() -> Result<(PathBuf, PathBuf), String> {
    let dir = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?.join(".mailvault");
    Ok((dir.join("mv.sock"), dir.join("mv.token")))
}

/// Path to the daemon's PID file. This is NOT under `daemon_ipc_paths()`'s
/// `~/.mailvault` — the daemon writes it into its app data dir
/// (src-daemon/src/main.rs `get_data_dir()` + `write_pid_file`, which join
/// `dirs::data_local_dir()` with the app identifier and `daemon.pid`).
/// `dirs::data_local_dir()` resolves to the sandbox container's data dir for
/// both processes, same as `home_dir()` does for the container home above, so
/// this needs no `AppHandle` to match Tauri's `app_data_dir()` (same
/// identifier, `com.mailvault.app`, from tauri.conf.json).
fn daemon_pid_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.mailvault.app")
        .join("daemon.pid")
}

/// Parse a PID file's content: a bare integer, optionally with surrounding
/// whitespace (`write_pid_file` writes no newline, but don't depend on that).
/// Anything else — empty, garbage, negative, non-numeric — is not a pid we
/// trust enough to signal.
fn parse_daemon_pid(content: &str) -> Option<libc::pid_t> {
    content.trim().parse::<libc::pid_t>().ok().filter(|&pid| pid > 0)
}

fn read_daemon_pid_file(path: &Path) -> Option<libc::pid_t> {
    parse_daemon_pid(&std::fs::read_to_string(path).ok()?)
}

/// True if `file_name` names the daemon binary. Tolerates the " (deleted)"
/// suffix Linux appends to `/proc/<pid>/exe`'s readlink target once a package
/// upgrade replaces the file backing an already-running process.
fn is_daemon_exe_name(file_name: &str) -> bool {
    file_name.strip_suffix(" (deleted)").unwrap_or(file_name) == "mailvault-daemon"
}

/// True only if `pid` is a running process whose executable is named
/// `mailvault-daemon` — never signal a pid before confirming this: a stale
/// pid file naming a since-reused pid must not kill an unrelated process.
#[cfg(target_os = "macos")]
fn pid_is_mailvault_daemon(pid: libc::pid_t) -> bool {
    let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is sized exactly to Apple's documented
    // PROC_PIDPATHINFO_MAXSIZE; proc_pidpath writes at most buf.len() bytes
    // and returns the byte count written, or -1 on error (no such pid, etc).
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut _, buf.len() as u32) };
    if n <= 0 {
        return false;
    }
    std::str::from_utf8(&buf[..n as usize])
        .ok()
        .and_then(|s| Path::new(s).file_name())
        .and_then(|n| n.to_str())
        .is_some_and(is_daemon_exe_name)
}

#[cfg(not(target_os = "macos"))]
fn pid_is_mailvault_daemon(pid: libc::pid_t) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|p| p.file_name().and_then(|n| n.to_str().map(str::to_owned)))
        .is_some_and(|s| is_daemon_exe_name(&s))
}

/// `kill(pid, 0)` sends no signal, only checks whether the process exists (and
/// is ours to signal). ESRCH means it is gone; any other outcome (alive, or
/// EPERM because it's alive but owned by someone else) is not "dead".
fn pid_is_dead(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 is documented as a pure existence/permission check —
    // it never actually signals the process.
    let ret = unsafe { libc::kill(pid, 0) };
    ret == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Find the daemon binary. Checks next to the app binary first, then common build paths.
fn find_daemon_binary(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Next to the Tauri app binary (release layout)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("mailvault-daemon");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Cargo workspace target directories (dev mode)
    let workspace_root = app_handle
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| p.parent().map(|pp| pp.to_path_buf()));

    for base in [
        workspace_root,
        std::env::current_dir().ok(),
    ].into_iter().flatten() {
        for profile in ["debug", "release"] {
            let candidate = base.join("target").join(profile).join("mailvault-daemon");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

/// The `--daemon-only` launcher: start the sidecar and return, leaving it
/// running as an orphan that init adopts.
///
/// No `AppHandle` exists yet at this point, so this cannot reuse
/// `find_daemon_binary`; the sidecar always sits next to the app binary in
/// every shipped layout, and in a dev tree the workspace `target/` dirs are
/// the fallback.
///
/// Doing nothing when a daemon is already up matters: on Linux the desktop
/// runs autostart entries again on every login, and a session that was never
/// fully torn down can leave the previous daemon alive.
fn spawn_detached_daemon() -> Result<(), String> {
    #[cfg(unix)]
    if let Ok((sock, _)) = daemon_ipc_paths() {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            return Ok(());
        }
    }

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "app binary has no parent directory".to_string())?;
    let candidates = [
        dir.join("mailvault-daemon"),
        dir.join("mailvault-daemon.exe"),
        dir.join("../target/debug/mailvault-daemon"),
        dir.join("../target/release/mailvault-daemon"),
    ];
    let bin = candidates
        .iter()
        .find(|c| c.exists())
        .ok_or_else(|| format!("mailvault-daemon not found next to {}", exe.display()))?;

    Command::new(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start {}: {e}", bin.display()))
}

/// Spawn daemon as a child process (on-demand mode). Waits for socket to appear.
fn ensure_daemon_socket(app_handle: &tauri::AppHandle, socket_path: &Path) -> Result<(), String> {
    // Already running?
    if socket_path.exists() {
        // Quick liveness check: can we connect?
        if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
            return Ok(());
        }
        // Stale socket — remove it
        let _ = std::fs::remove_file(socket_path);
    }

    let mut guard = DAEMON_CHILD.lock().map_err(|e| e.to_string())?;

    // Check if our child is still alive
    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(Some(_)) => { *guard = None; } // Exited, need to respawn
            Ok(None) => {
                // Still running but socket gone — wait a moment
                for _ in 0..20 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if socket_path.exists() { return Ok(()); }
                }
                return Err("Daemon child is running but socket not appearing".into());
            }
            Err(_) => { *guard = None; }
        }
    }

    // Checked here, still holding `guard` (DAEMON_CHILD): a reconnect that
    // reached this point after `shutdown_daemon_child()` already ran must not
    // spawn an orphan the app will never clean up.
    if APP_EXITING.load(Ordering::SeqCst) {
        return Err("app is exiting".into());
    }

    // Addendum D.2: a vault handler holds the index closed and is mid-move.
    // The socket isn't live (we're past the top-of-function early return), so
    // spawning here would open/create index.db inside a root being copied or
    // deleted. A live daemon is still used by the branches above this point —
    // only a fresh spawn is refused.
    if !may_spawn_daemon() {
        return Err("daemon suspended during a vault move".into());
    }

    // Spawn new daemon
    let daemon_bin = find_daemon_binary(app_handle)
        .ok_or_else(|| "mailvault-daemon binary not found".to_string())?;

    info!("Spawning daemon on-demand: {:?}", daemon_bin);

    let child = Command::new(&daemon_bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    *guard = Some(child);
    // A freshly spawned daemon has never had its build checked, whatever
    // inode last passed on this socket path. On Linux (ext4/tmpfs) a fresh
    // inode can reuse a just-freed number, so a stale VERIFIED_SOCKET_INO
    // could otherwise match the respawned daemon's socket by coincidence and
    // let it skip the build-mismatch check in ensure_daemon_running.
    VERIFIED_SOCKET_INO.store(0, Ordering::SeqCst);
    // A cached token is only trustworthy alongside the inode it was read
    // for; the fresh child above has never had its token read yet.
    set_cached_daemon_token(None);

    // Wait for socket to appear (up to 3 seconds)
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if socket_path.exists() {
            info!("Daemon socket ready");
            return Ok(());
        }
    }

    Err("Daemon spawned but socket did not appear within 3 seconds".into())
}

/// How long the app waits for a SIGTERM'd daemon to exit on its own before
/// escalating to SIGKILL. Must exceed the daemon's own shutdown budget (2s of
/// IMAP logout in src-daemon/src/main.rs) or we kill it mid-cleanup — and it
/// blocks app quit, so it can't be generous.
#[cfg(unix)]
const DAEMON_STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Stop the on-demand daemon child process (called on app exit).
///
/// SIGTERM first, so the daemon runs its own cleanup — LOGOUT of every pooled
/// IMAP session, socket and PID file removal. SIGKILL only if it won't go.
pub fn shutdown_daemon_child() {
    if let Ok(mut guard) = DAEMON_CHILD.lock() {
        if let Some(ref mut child) = *guard {
            info!("Shutting down on-demand daemon (PID {})", child.id());

            #[cfg(unix)]
            {
                // Safe from PID reuse: we have never reaped this child, so it
                // stays a zombie holding its PID until the wait() below.
                unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };

                let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
                while std::time::Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }

            let _ = child.kill();
            let _ = child.wait();
            *guard = None;
        }
    }
}

/// Inode of the socket whose daemon last passed the build check (0 = none).
static VERIFIED_SOCKET_INO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// One restart per app run for a build mismatch; a stale staged sidecar must not loop.
static RESTARTED_FOR_BUILD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Auth token cached from the last slow-path `ensure_daemon_running` run, for
/// `daemon_rpc`'s fast path (C7) to reuse without a file read. Trusted only
/// while `VERIFIED_SOCKET_INO != 0` and the channel is connected. The token
/// itself persists across daemon restarts (`src-daemon/src/auth.rs`
/// `load_or_generate_token_at` reuses the existing `mv.token` whenever it is
/// well-formed); the inode gate, not the token, keeps the fast path off an
/// unverified daemon. Cleared at every site that resets the inode to 0 (a
/// fresh spawn, `stop_daemon_locked`, or a fast-path retry) purely to keep
/// the two in lockstep, not because the token itself goes stale.
static DAEMON_TOKEN: Mutex<Option<String>> = Mutex::new(None);

fn cached_daemon_token() -> Option<String> {
    DAEMON_TOKEN.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn set_cached_daemon_token(token: Option<String>) {
    *DAEMON_TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = token;
}

fn socket_ino(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).map(|m| m.ino()).unwrap_or(0)
}

/// A daemon is listening AND it is this build's (spec §3.3). Blocking: call it
/// from a blocking thread.
///
/// Holds `DAEMON_LIFECYCLE` for the whole check (socket ensure + build verify,
/// including a possible restart) so a concurrent `daemon_rpc` auto-spawn can
/// never race a restart triggered by this one.
pub(crate) fn ensure_daemon_running(app_handle: &tauri::AppHandle, socket_path: &Path) -> Result<(), String> {
    let lifecycle = DAEMON_LIFECYCLE.lock().unwrap_or_else(|p| p.into_inner());
    ensure_daemon_socket(app_handle, socket_path)?;
    verify_daemon_build(app_handle, socket_path, &lifecycle)
}

/// Must only run with `DAEMON_LIFECYCLE` held — the `lifecycle` parameter is
/// proof of that (not used by the body), enforced by every caller going
/// through `ensure_daemon_running` above.
fn verify_daemon_build(app_handle: &tauri::AppHandle, socket_path: &Path, lifecycle: &MutexGuard<'_, ()>) -> Result<(), String> {
    use mailvault_core::daemon_ipc::{call, check_build, BuildCheck};
    use std::sync::atomic::Ordering::SeqCst;
    let ino = socket_ino(socket_path);
    if ino != 0 && VERIFIED_SOCKET_INO.load(SeqCst) == ino {
        return Ok(());
    }
    let (_, token_path) = daemon_ipc_paths()?;
    let token = std::fs::read_to_string(&token_path).map_err(|e| format!("daemon token: {e}"))?;
    let beat = call(socket_path, &token, "daemon.heartbeat", serde_json::json!({}), std::time::Duration::from_secs(3))
        .map_err(|e| format!("daemon heartbeat: {e:?}"))?;
    let theirs = beat.get("buildId").and_then(|v| v.as_str()).map(str::to_owned);
    match check_build(mailvault_core::BUILD_ID, theirs.as_deref(), RESTARTED_FOR_BUILD.load(SeqCst)) {
        BuildCheck::Same => {}
        BuildCheck::Accept => warn!("daemon build {theirs:?} still differs from app build {} after a restart; using it", mailvault_core::BUILD_ID),
        BuildCheck::Restart => {
            if RESTARTED_FOR_BUILD.compare_exchange(false, true, SeqCst, SeqCst).is_ok() {
                warn!("daemon build {theirs:?} differs from app build {}; restarting it", mailvault_core::BUILD_ID);
                stop_daemon_locked(lifecycle);
                ensure_daemon_socket(app_handle, socket_path)?;
                return verify_daemon_build(app_handle, socket_path, lifecycle); // can only be Same or Accept now
            }
            // With DAEMON_LIFECYCLE held for the whole of ensure_daemon_running,
            // only one caller can ever be in this arm — the CAS above cannot
            // lose. If it somehow did, don't cache a mismatched build as verified.
            return Err("daemon build verification raced with another restart".to_string());
        }
    }
    VERIFIED_SOCKET_INO.store(socket_ino(socket_path), SeqCst);
    Ok(())
}

// `nudge_index` is gone (Phase 3 remainder, Task 5): the app has no vault
// writer left to nudge the index for. Its last caller was `archive.rs`'s
// `run_with_backup` shim, deleted with the backup runners; the daemon signals
// its own index in-process.

/// One blocking daemon RPC: ensure the daemon is up, read its token, one
/// request/response round trip. Used by code that isn't already async — the
/// vault move handlers' `spawn_blocking` bodies below, and (Task 2.9b) the
/// app's remaining custody and backup bridge callers. Insights was one of
/// them until Task 3.7 moved it into the daemon, where it reads custody in
/// process.
///
/// Renamed from `daemon_index_call` (Task 2.5): it now returns the result
/// instead of always swallowing it, so a bridge caller can act on an error.
/// The vault handlers keep today's log-and-go-on behaviour themselves, via
/// `daemon_vault_lifecycle_call` below. While `DAEMON_SUSPENDED` is held and
/// no daemon is currently live, `ensure_daemon_running` fails fast instead of
/// spawning one (addendum D.5) — surfaced here as an ordinary `Err`.
pub(crate) fn daemon_call_blocking(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let (socket, token_path) = daemon_ipc_paths()?;
    ensure_daemon_running(app, &socket)?;
    let token = std::fs::read_to_string(&token_path).map_err(|e| e.to_string())?;
    mailvault_core::daemon_ipc::call(&socket, &token, method, params, timeout).map_err(|e| map_call_error(method, e))
}

/// I1 fix (Task 2.5 fix round 1): `daemon_call_blocking`'s old
/// `.map_err(|e| format!("{e:?}"))` handed callers Rust `Debug` text
/// (`Rpc("E_VAULT_UNAVAILABLE: ...")`, quotes escaped) instead of the
/// daemon's own message, breaking every `E_*:`/`custody store unavailable:`
/// text match the 2.9b forwarders and the bridge callers rely on. Same
/// contract as the async path's `map_rpc_error`: a daemon-answered error
/// passes through verbatim so its prefix survives; anything before a reply
/// line was even read (unreachable, refused, timed out) becomes the
/// `DAEMON_UNAVAILABLE` catalog key; a stale build's METHOD_NOT_FOUND
/// becomes `DAEMON_OUTDATED`. The real reason always still reaches the log.
fn map_call_error(method: &str, e: mailvault_core::daemon_ipc::CallError) -> String {
    use mailvault_core::daemon_ipc::CallError;
    match e {
        CallError::Rpc(m) if m.starts_with("Unknown method:") => {
            warn!("{method}: {m}");
            DAEMON_OUTDATED.to_string()
        }
        CallError::Rpc(m) => m,
        CallError::Unreachable(m) => {
            warn!("{method}: {m}");
            DAEMON_UNAVAILABLE.to_string()
        }
    }
}

/// True when a `daemon_call_blocking` error is the daemon answering
/// JSON-RPC METHOD_NOT_FOUND — a build that has not been rebuilt yet with
/// this RPC. Since `map_call_error` (I1) now maps that case to the
/// `DAEMON_OUTDATED` catalog key up front, this is just an equality check —
/// callers must treat it exactly like the daemon being unreachable — log
/// and continue the vault operation — never as a hard failure of the move.
fn is_stale_daemon_method(e: &str) -> bool {
    e == DAEMON_OUTDATED
}

/// I2 fix (Task 2.5 fix round 1): pure decision for `daemon_vault_lifecycle_call`
/// below — a failed `vault_close`/`vault_reopen` must stop the daemon
/// (`Err`); a successful one must leave it running (`Ok`). Split out so the
/// decision itself is unit-testable without touching the real socket/global
/// lifecycle state.
fn should_stop_after_lifecycle_call(result: &Result<serde_json::Value, String>) -> bool {
    result.is_err()
}

/// `vault_close` / `vault_reopen` on the daemon, blocking, for the vault
/// handlers: the daemon must release index.db (and, from Task 2.9a/b,
/// custody.db) before the app copies it. No daemon, or a daemon too old to
/// know the method, both mean nothing holds either store: log and go on.
///
/// I2 fix (Task 2.5 fix round 1): a failed close/reopen against a LIVE
/// daemon was previously just logged — the daemon could still be holding
/// index.db/custody.db open while the app started copying the root, and a
/// failed reopen left `vault_closed` stuck `true` forever, answering "the
/// vault is being moved" to every read/write until the app restarted. Now
/// any `Err` stops the daemon: cheap when there already isn't one to stop,
/// and `DAEMON_SUSPENDED` (held by every vault handler across its whole
/// move) blocks a respawn until the guard drops, so this can't race the
/// move's own copy step. The channel respawns a fresh daemon against
/// whichever root is current once the guard drops.
fn daemon_vault_lifecycle_call(app: &tauri::AppHandle, method: &str, timeout: std::time::Duration) {
    let started = std::time::Instant::now();
    let result = daemon_call_blocking(app, method, serde_json::json!({}), timeout);
    let took = started.elapsed();
    // I-2: `vault_close` can legitimately take a while (a search-index
    // batch/compaction in flight) — log how long every call actually took so
    // a slow close shows up in the log before it ever gets near the budget
    // above, not only once it times out.
    info!("{method} took {:?} (budget {:?})", took, timeout);
    if let Err(e) = &result {
        if is_stale_daemon_method(e) {
            warn!("{method}: daemon does not know this method yet (stale build); continuing as if unreachable");
        } else {
            warn!("{method} failed ({e}) after {:?}; stopping the daemon so nothing holds the vault", took);
        }
    }
    if should_stop_after_lifecycle_call(&result) {
        stop_daemon();
    }
}

/// Stop whichever daemon owns the socket, ours or an orphan left behind by a
/// crashed app, with the same cleanup as SIGTERM (`daemon.shutdown`), then
/// reap or kill our own tracked child. Blocking. Takes `DAEMON_LIFECYCLE` so
/// this can never race a concurrent `daemon_rpc` auto-spawn or restart.
pub(crate) fn stop_daemon() {
    let lifecycle = DAEMON_LIFECYCLE.lock().unwrap_or_else(|p| p.into_inner());
    stop_daemon_locked(&lifecycle);
}

/// Must only run with `DAEMON_LIFECYCLE` held — by `stop_daemon()` above, or
/// by `verify_daemon_build`'s restart arm (which already holds it via
/// `ensure_daemon_running`, so recursing into `stop_daemon()` there would
/// deadlock).
///
/// Returns only once the socket is gone and, when a pid was known, that pid
/// is confirmed dead — or after the SIGKILL escalation below runs out. A
/// replacement daemon must never be spawned while the old one still holds its
/// singleton lock: the daemon's own startup lock retry is capped at 2s
/// (src-daemon/src/main.rs `acquire_singleton_lock` loop), which a graceful
/// shutdown can exceed when IMAP LOGOUT hangs — so the caller waits here
/// rather than racing a respawn against that window.
fn stop_daemon_locked(_lifecycle: &MutexGuard<'_, ()>) {
    if let Ok((socket, token_path)) = daemon_ipc_paths() {
        let known_pid = read_daemon_pid_file(&daemon_pid_path());
        // Trap: if the pid file names our own on-demand child, it is a zombie
        // the moment it exits (we never reaped it yet), and kill(pid, 0) keeps
        // reporting a zombie as "alive" forever. Waiting for it to go "dead"
        // here — or treating it as an orphan to SIGTERM/SIGKILL ourselves —
        // would spin until every deadline below and could double-signal a
        // child that `shutdown_daemon_child()` already owns and can properly
        // try_wait()/reap. So: our own child's lifecycle is entirely its job.
        let is_own_child = known_pid.is_some() && known_pid == daemon_child_pid();

        if let Ok(token) = std::fs::read_to_string(&token_path) {
            let _ = mailvault_core::daemon_ipc::call(&socket, &token, "daemon.shutdown", serde_json::json!({}), std::time::Duration::from_secs(1));
        }
        let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
        while socket.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        if !is_own_child {
            // The socket disappearing doesn't guarantee the pid has actually
            // exited yet (the daemon removes the socket just before
            // process::exit) — wait for that too, same bounded/polled style.
            if let Some(pid) = known_pid {
                let deadline = std::time::Instant::now() + DAEMON_STOP_GRACE;
                while !pid_is_dead(pid) && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }

            // R3: an orphan from a build too old to answer `daemon.shutdown`
            // (or one the RPC above simply never reached) leaves the socket
            // and/or pid behind. Signal it ourselves instead of waiting forever.
            let still_up = socket.exists() || known_pid.is_some_and(|pid| !pid_is_dead(pid));
            if still_up {
                match known_pid {
                    Some(pid) if pid_is_mailvault_daemon(pid) => {
                        warn!("orphan daemon (pid {pid}) did not clear its socket/pid after daemon.shutdown; sending SIGTERM");
                        // SAFETY: pid was just confirmed to be a running mailvault-daemon process.
                        unsafe { libc::kill(pid, libc::SIGTERM) };
                        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                        while (socket.exists() || !pid_is_dead(pid)) && std::time::Instant::now() < deadline {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        if !pid_is_dead(pid) {
                            // Ruling-2: the pid could have exited and been reused by an
                            // unrelated process in the up-to-3s window since the last
                            // check — re-verify identity right before an irreversible kill.
                            if pid_is_mailvault_daemon(pid) {
                                warn!("orphan daemon (pid {pid}) ignored SIGTERM; sending SIGKILL");
                                // SAFETY: identity re-checked immediately above; SIGTERM already failed to stop it.
                                unsafe { libc::kill(pid, libc::SIGKILL) };
                                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
                                while !pid_is_dead(pid) && std::time::Instant::now() < deadline {
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                }
                            } else {
                                warn!("pid {pid} is no longer a mailvault-daemon process (likely exited and the pid was reused); not sending SIGKILL");
                            }
                        }
                        if socket.exists() {
                            let _ = std::fs::remove_file(&socket);
                        }
                    }
                    Some(pid) => warn!("daemon pid file names pid {pid}, which is not a mailvault-daemon process; leaving the socket alone"),
                    None => warn!("daemon socket outlived daemon.shutdown and no pid file was found; leaving it alone"),
                }
            }
        }
    }
    shutdown_daemon_child(); // reaps an exited child; SIGTERM then SIGKILL if ours is still up
    VERIFIED_SOCKET_INO.store(0, std::sync::atomic::Ordering::SeqCst);
    set_cached_daemon_token(None);
}

/// Marker string `daemon_rpc` returns for every failure before a response
/// line is read (spawn, build check, token, connect, auth, write, EOF). The
/// frontend's `daemonClient.js` classifier is text-matched, so this must stay
/// a literal `errors.` catalog key — the real reason goes to `warn!` instead.
const DAEMON_UNAVAILABLE: &str = "errors.daemonUnavailable";

/// Returned instead of the daemon's own message when a JSON-RPC error is
/// METHOD_NOT_FOUND (C5): a `BuildCheck::Accept`'d daemon (still on the old
/// build after our one restart) is missing this RPC entirely. A catalog key,
/// same contract as `DAEMON_UNAVAILABLE` — the frontend text-matches it.
const DAEMON_OUTDATED: &str = "errors.daemonOutdated";

/// JSON-RPC 2.0 reserved code for "the method does not exist / is not available".
const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;

/// Per-method reply budget for `daemon_rpc` (C8). When `Some`, `rpc_attempt`
/// wraps the *whole* attempt in it — connect, auth write, auth read, request
/// write and response read together, not only the final response read. `None`
/// (every legacy dotted method, unchanged) means no timeout at all.
///
/// Task 2.5 Step 4: every Phase 2 daemon-owned name is added here now, ahead
/// of its route landing (Tasks 2.6-2.9a), so a later task cannot forget the
/// budget. `search_index_destroy` gets the longest of the pre-existing family
/// because the daemon itself waits up to 120s for the index worker to finish
/// before replying; the 600s family covers vault-wide scans/migrations and
/// the mirror-spanning flag-rename forwarders (Task 2.9b); the 120s family
/// is one big read or write; everything else is a single-row/one-mailbox op.
fn reply_timeout(method: &str) -> Option<std::time::Duration> {
    use std::time::Duration;
    match method {
        "search_index_destroy" => Some(Duration::from_secs(150)),

        // The helper card's own probe (`isDaemonAvailable` -> `ping`).
        // Unbounded, a daemon that accepts the socket but never answers left
        // Settings on "Checking..." forever; a bounded failure at least says
        // "Helper Not Running" honestly. The dotted lifecycle methods stay
        // unbounded, like every other legacy dotted name.
        "ping" => Some(Duration::from_secs(10)),

        "vault_search" | "vault_rows" | "search_index_status" | "search_index_configure" | "search_index_rebuild"
        | "maildir_read" | "maildir_read_light" | "maildir_read_attachment"
        | "maildir_read_raw_source" | "maildir_exists" | "maildir_store" | "maildir_delete"
        | "maildir_delete_many" | "maildir_set_flags" | "cache_attachment" | "cached_attachment_path"
        | "save_email_cache" | "load_email_cache_partial" | "load_email_cache_meta" | "load_email_cache_by_uids"
        | "list_cached_uids" | "header_cache_month_histogram" | "save_mailbox_cache" | "load_mailbox_cache" | "delete_mailbox_cache"
        | "load_graph_id_map" | "op_journal_queue" | "op_journal_clear" | "op_journal_read"
        | "read_pending_operation" | "save_pending_operation" | "clear_pending_operation" | "local_index_read"
        | "local_index_append" | "local_index_remove" | "custody_status" | "maildir_repair_generation"
        | "maildir_orphan_stats" | "mail_search_start" | "mail_search_cancel" => Some(Duration::from_secs(30)),

        // I3 (2.6 review): `maildir_read_light_batch` and `maildir_list` can
        // be sent for a whole mailbox's uids in one call (`getLocalEmails`,
        // `src/services/db/emails.js`) — a full MIME parse per file, with no
        // chunking on this path (unlike `getArchivedEmails`, which chunks at
        // 200). The old Tauri commands they replace had no budget at all, so
        // 30s (bounding what used to be unbounded) can time out a large
        // archive on a slow drive that used to just run slow and succeed.
        "load_email_cache" | "graph_allocate_uids" | "maildir_storage_stats" | "clear_email_cache"
        | "maildir_read_light_batch" | "maildir_list" => {
            Some(Duration::from_secs(120))
        }

        // Final fix wave I-2: a `vault_close` can outlast 120s when the
        // search index worker is mid-batch/compaction — the app's budget
        // must be strictly larger than the daemon's own wait
        // (`si::close`/`custody::close` inside `handlers/search_index.rs`),
        // or the app SIGTERMs the daemon mid-write just before the vault
        // move starts copying. Not consulted by `daemon_vault_lifecycle_call`
        // (it passes its own explicit `Duration`, same as `vault_reopen`
        // below) — kept here so the budget is documented in one table and
        // pinned by a test, matching every call site.
        "vault_close" => Some(Duration::from_secs(300)),

        "maildir_clear_cache" | "maildir_migrate_json_to_eml" | "maildir_migrate_email_dirs" | "maildir_purge_orphans"
        | "prefetch_attachments" | "vault_apply_flags" | "vault_rename_mailbox" | "vault_adopt_mailbox_dirs" => {
            Some(Duration::from_secs(600))
        }

        // Task 3.5 decision 3: no budget. A 40k-uid archive or a large bulk
        // delete runs far past every other family's budget in this table:
        // the JS awaits the reply directly, and the way out of a long run is
        // the daemon's own cancel_archive/cancel_bulk_delete, not a timeout
        // that turns a slow success into a failure (Phase 2's 2.6 I3
        // lesson). Written as an explicit arm rather than left to the
        // `_ => None` catch-all below, so a later change to that default
        // cannot silently take the budget away from these two, and so the
        // test pinning this has something concrete to assert against.
        "archive_emails" | "bulk_delete_emails" => None,

        // One read_dir plus comparisons, same tier as the other Phase 2
        // single-pass readers.
        "verify_archived_emails" => Some(Duration::from_secs(120)),

        // Ungated, no vault access, one atomic store per registered token.
        "cancel_archive" | "cancel_bulk_delete" => Some(Duration::from_secs(30)),

        // Task 3.7, same decision 3 reasoning as archive: the inventory walk
        // behind a begin_snapshot reads every cached header of every account
        // in scope (50k in the e2e's LARGE mode) before it answers, and the
        // JS awaits that reply. Written as its own arm rather than left to
        // the `_ => None` catch-all so a later edit to that default cannot
        // silently hand this one a budget.
        "insights_begin_snapshot" => None,

        // One bounded page, same tier as the other single-pass readers.
        "insights_read_page" => Some(Duration::from_secs(120)),

        // Drops one snapshot out of a map.
        "insights_release_snapshot" => Some(Duration::from_secs(30)),

        // Task 4.2: its own internal reqwest timeout is 10s plus redirect
        // overhead (up to 3 hops); 30s is a safety margin around that, not a
        // new cap this budget could bind against in practice.
        "fetch_remote_asset" => Some(Duration::from_secs(30)),

        // Task 4.4 / decision 8: inline-blocking, same reasoning as
        // archive_emails/bulk_delete_emails above, the whole ZIP
        // read-or-write pass happens within this RPC call and the JS
        // awaits the return value directly. Written as its own arm so a
        // later edit to the `_ => None` default cannot silently take or
        // grant a budget here by accident.
        "export_backup" | "import_backup" => None,

        // Task 4.6, same reasoning as export_backup/import_backup above: the
        // whole mbox read-or-write pass happens within this RPC call and the
        // JS awaits the return value directly. Its own arm so a later edit
        // to the `_ => None` default cannot silently take or grant a budget.
        "export_mbox_all" | "import_mbox" => None,

        // Task 4.8 / decision 8: each of these ten either kicks off a
        // tokio::spawn and returns almost immediately (progress flows over
        // channel.open, not this reply) or is a fast local read/flag flip.
        // Written as its own arm, not left to the `_ => None` catch-all, so
        // a later edit to that default cannot silently take a budget these
        // never had a reason to lose.
        "start_migration" | "resume_migration" | "count_migration_folders" | "start_restore"
        | "cancel_migration" | "pause_migration" | "cancel_restore" | "clear_migration_state_cmd"
        | "get_migration_state" | "count_local_folder" => Some(Duration::from_secs(30)),

        // Task 4.8 / decision 8: a live IMAP LIST plus, when either side is
        // Graph, an HTTP list_folders call, bounded but genuinely
        // network-bound, matching Phase 2's precedent for similar calls.
        "get_folder_mappings" => Some(Duration::from_secs(120)),

        _ => None,
    }
}

/// Pure decision (C7): may `daemon_rpc` skip `ensure_daemon_running` and its
/// `spawn_blocking` entirely? Only when the long-lived channel is already
/// connected to a live daemon, that daemon's socket inode already passed the
/// build check (`verified_ino != 0`), and a token was cached from an earlier
/// slow-path run. Any one of those missing forces the slow path — this never
/// does I/O itself, just the decision.
///
/// ponytail: known ceiling — `connected`/`verified_ino` are read here, not
/// re-stat'd, so a daemon started outside this app (a second app instance,
/// or one run by hand) that replaces ours in the few ms between the old
/// socket's EOF reaching `daemon_channel::pump` and `CONNECTED` flipping to
/// false can receive one fast-path request never build-checked. Upgrade path
/// if that ever matters: compare a live `stat` of the socket inode here too,
/// which costs the `spawn_blocking` hop C7 exists to avoid — not worth it for
/// a multi-millisecond window.
fn rpc_fast_path(connected: bool, verified_ino: u64, token: Option<&str>) -> Option<String> {
    if connected && verified_ino != 0 {
        token.map(str::to_owned)
    } else {
        None
    }
}

/// Maps a JSON-RPC error object to what `daemon_rpc` returns to the frontend.
/// METHOD_NOT_FOUND becomes the `errors.daemonOutdated` catalog key (C5,
/// logged with the method); every other code keeps the daemon's own message,
/// unchanged from before this task.
fn map_rpc_error(error: &serde_json::Value, method: &str) -> String {
    if error.get("code").and_then(|c| c.as_i64()) == Some(JSONRPC_METHOD_NOT_FOUND) {
        warn!("daemon_rpc {method}: daemon replied METHOD_NOT_FOUND (stale/accepted build)");
        return DAEMON_OUTDATED.to_string();
    }
    error.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown daemon error").to_string()
}

/// One attempt at the auth handshake + JSON-RPC round trip over a fresh
/// connection, given an already-known token (fast or slow path — this
/// function doesn't care which).
#[derive(Debug)]
enum RpcOutcome {
    /// A successful RPC result.
    Ok(serde_json::Value),
    /// A real response from the daemon that isn't a plain success: an
    /// RPC-level error (already mapped by `map_rpc_error`) or an unparseable
    /// response line. Returned to the caller exactly as before this task —
    /// never wrapped in `DAEMON_UNAVAILABLE`, never retried (the request line
    /// was already written and answered).
    Direct(String),
    /// A transport/auth-level failure. `retryable` is true only when it
    /// happened strictly before the RPC request line was written — safe to
    /// retry on a fresh connection with a fresh token. Once that write
    /// succeeds, every later failure (response read, timeout, EOF) is
    /// `retryable: false`: retrying would send the request twice. When the
    /// method has a reply budget (C8), that budget wraps the whole attempt
    /// above (connect through response read), not only the response read —
    /// a hang anywhere in the handshake ends up here too, not just a slow reply.
    Unavailable { message: String, retryable: bool },
}

/// C8 / M3 (controller ruling): when `timeout` is `Some`, it bounds the
/// *whole* attempt — connect, auth write, auth read, request write and
/// response read together — not just the final read. A daemon that accepts
/// the connection and then never answers auth would otherwise hang
/// `vault_search`/`search_index_destroy` forever despite their 30s/150s
/// budgets. Expiry always returns `retryable: false` (never retried,
/// regardless of how far the inner attempt got — a connect that is merely
/// slow and a request already on the wire are indistinguishable from out
/// here, and retrying a possibly-already-sent mutating RPC is the unsafe
/// default). Legacy methods (`timeout: None`) are unbounded, unchanged.
async fn rpc_attempt(
    socket_path: &Path,
    token: &str,
    method: &str,
    params: &serde_json::Value,
    timeout: Option<std::time::Duration>,
) -> RpcOutcome {
    let attempt = rpc_attempt_inner(socket_path, token, method, params);
    match timeout {
        Some(t) => tokio::time::timeout(t, attempt).await.unwrap_or_else(|_| RpcOutcome::Unavailable {
            message: format!("no reply in {}s", t.as_secs()),
            retryable: false,
        }),
        None => attempt.await,
    }
}

/// The auth handshake + one JSON-RPC round trip, with no time budget of its
/// own — `rpc_attempt` above applies the whole-call timeout when the method
/// has one.
async fn rpc_attempt_inner(socket_path: &Path, token: &str, method: &str, params: &serde_json::Value) -> RpcOutcome {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;

    let stream = match UnixStream::connect(socket_path).await {
        Ok(s) => s,
        Err(e) => return RpcOutcome::Unavailable { message: format!("cannot connect to daemon: {e}"), retryable: true },
    };
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // Auth handshake
    let auth_msg = serde_json::json!({"token": token.trim()});
    let mut buf = serde_json::to_vec(&auth_msg).unwrap();
    buf.push(b'\n');
    if let Err(e) = writer.write_all(&buf).await {
        return RpcOutcome::Unavailable { message: e.to_string(), retryable: true };
    }

    let auth_resp = match lines.next_line().await {
        Ok(Some(l)) => l,
        Ok(None) => return RpcOutcome::Unavailable { message: "daemon closed connection during auth".to_string(), retryable: true },
        Err(e) => return RpcOutcome::Unavailable { message: e.to_string(), retryable: true },
    };
    let auth_result: serde_json::Value = match serde_json::from_str(&auth_resp) {
        Ok(v) => v,
        Err(e) => return RpcOutcome::Unavailable { message: format!("invalid auth response: {e}"), retryable: true },
    };
    if auth_result.get("error").is_some() {
        return RpcOutcome::Unavailable { message: "daemon authentication failed".to_string(), retryable: true };
    }

    // JSON-RPC request
    static RPC_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = RPC_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let rpc_req = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": id,
    });
    let mut buf = serde_json::to_vec(&rpc_req).unwrap();
    buf.push(b'\n');
    if let Err(e) = writer.write_all(&buf).await {
        // write_all failing partway through leaves no guarantee the daemon
        // saw a coherent request line, so still safe to retry.
        return RpcOutcome::Unavailable { message: e.to_string(), retryable: true };
    }

    // From here on, the request is on the wire: never retryable.
    let resp_line = match lines.next_line().await {
        Ok(Some(l)) => l,
        Ok(None) => return RpcOutcome::Unavailable { message: "daemon closed connection before responding".to_string(), retryable: false },
        Err(e) => return RpcOutcome::Unavailable { message: e.to_string(), retryable: false },
    };

    let resp: serde_json::Value = match serde_json::from_str(&resp_line) {
        Ok(v) => v,
        Err(e) => return RpcOutcome::Direct(format!("Invalid RPC response: {e}")),
    };

    if let Some(error) = resp.get("error") {
        return RpcOutcome::Direct(map_rpc_error(error, method));
    }

    RpcOutcome::Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn daemon_rpc(
    app_handle: tauri::AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (socket_path, token_path) = daemon_ipc_paths().map_err(|e| {
        warn!("daemon_rpc {method}: {e}");
        DAEMON_UNAVAILABLE.to_string()
    })?;
    let timeout = reply_timeout(&method);

    // Fast path (C7): a live, build-verified channel with a cached token
    // skips ensure_daemon_running (and its spawn_blocking) entirely. No
    // blocking I/O here — is_connected/the atomics/the token mutex are all
    // just reading in-memory state.
    let fast_token = rpc_fast_path(
        daemon_channel::is_connected(),
        VERIFIED_SOCKET_INO.load(Ordering::SeqCst),
        cached_daemon_token().as_deref(),
    );

    if let Some(token) = fast_token {
        match rpc_attempt(&socket_path, &token, &method, &params, timeout).await {
            RpcOutcome::Ok(v) => return Ok(v),
            RpcOutcome::Direct(msg) => return Err(msg),
            RpcOutcome::Unavailable { retryable: false, message } => {
                warn!("daemon_rpc {method}: {message}");
                return Err(DAEMON_UNAVAILABLE.to_string());
            }
            RpcOutcome::Unavailable { retryable: true, message } => {
                // The daemon may have died or been replaced; drop the cached
                // verification so the slow path re-checks the socket and
                // build. (The token file persists across restarts, so auth
                // alone does not detect a replacement.)
                warn!("daemon_rpc {method}: fast path failed ({message}); retrying once through the slow path");
                set_cached_daemon_token(None);
                VERIFIED_SOCKET_INO.store(0, Ordering::SeqCst);
            }
        }
    }

    // Slow path: verify (and, if needed, spawn/restart) the daemon, then
    // read a fresh token. Blocking I/O, so it all runs inside spawn_blocking
    // (mirrors daemon_channel::connect).
    let token = {
        let app = app_handle.clone();
        let sock = socket_path.clone();
        let tok_path = token_path.clone();
        let joined = tokio::task::spawn_blocking(move || {
            ensure_daemon_running(&app, &sock)?;
            std::fs::read_to_string(&tok_path).map_err(|e| format!("daemon token not found: {e}"))
        })
        .await
        .map_err(|e| format!("task join error: {e}"));
        match joined {
            Ok(Ok(t)) => t,
            Ok(Err(e)) | Err(e) => {
                warn!("daemon_rpc {method}: {e}");
                return Err(DAEMON_UNAVAILABLE.to_string());
            }
        }
    };
    set_cached_daemon_token(Some(token.clone()));

    match rpc_attempt(&socket_path, &token, &method, &params, timeout).await {
        RpcOutcome::Ok(v) => Ok(v),
        RpcOutcome::Direct(msg) => Err(msg),
        RpcOutcome::Unavailable { message, .. } => {
            warn!("daemon_rpc {method}: {message}");
            Err(DAEMON_UNAVAILABLE.to_string())
        }
    }
}

/// The daemon bridge: send one fire-and-forget notification on the channel.
#[tauri::command]
fn daemon_channel_notify(method: String, params: serde_json::Value) {
    daemon_channel::notify(&method, params);
}

fn main() {
    // Autostart on Linux and Windows points at *this* binary rather than at
    // the sidecar, because the sidecar's path depends on the packaging (an
    // AppImage's mount root is gone by the next login). Started that way the
    // app is only a launcher: hand over to the daemon and leave, before a
    // window, a single-instance lock or a tray icon exists.
    if std::env::args().any(|a| a == mailvault_core::autostart::DAEMON_ONLY_FLAG) {
        std::process::exit(match spawn_detached_daemon() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }

    // Log panics before abort — set_hook fires even with panic = "abort"
    std::panic::set_hook(Box::new(|info| {
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic".to_string()
        };
        eprintln!("PANIC at {}: {}", location, payload);
    }));

    // WebKit keeps its continuous-spell-checking state in NSUserDefaults and reads
    // it once, early. The key is absent in a fresh app domain, so the checker never
    // runs and the compose editor paints no squiggles no matter what its
    // `spellcheck` attribute says. Safari writes the same key; register ours before
    // any webview exists. Registration domain, not the app domain: a user who turns
    // spelling off in the webview's own context menu writes the app domain, and that
    // choice has to keep winning.
    #[cfg(target_os = "macos")]
    unsafe {
        let key = NSString::alloc(nil).init_str("WebContinuousSpellCheckingEnabled");
        let on: cocoa::base::id = msg_send![class!(NSNumber), numberWithBool: cocoa::base::YES];
        let defaults: cocoa::base::id = msg_send![class!(NSDictionary), dictionaryWithObject: on forKey: key];
        let user_defaults: cocoa::base::id = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let _: () = msg_send![user_defaults, registerDefaults: defaults];
    }

    // Under WebDriver automation (tauri-wd sets this), single-instance protection is an
    // anti-feature: each spec launches a fresh app instance, and a leftover instance from a
    // failed session would make every subsequent launch exit(0) immediately — the harness
    // then reports "App did not report plugin port in time" for the rest of the suite.
    let automation = std::env::var_os("TAURI_WEBVIEW_AUTOMATION").is_some();

    // Linux fallback: flock-based lock to prevent multiple instances.
    // The tauri-plugin-single-instance uses D-Bus which may not work in all Linux environments
    // (AppImage, Snap, restricted D-Bus sessions). flock is kernel-managed: automatically
    // released on process exit (even SIGKILL/crash), works in Snap strict confinement,
    // and has no stale lock issues.
    // When a second instance detects the lock, it sends SIGUSR1 to the running instance
    // which triggers window show+focus (handles clicking the app icon while already running).
    #[cfg(target_os = "linux")]
    let _lock_file = if automation { None } else {
        use std::io::{Read as _, Write as _};
        use std::os::unix::io::AsRawFd;

        let lock_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("com.mailvault.app");
        let _ = fs::create_dir_all(&lock_dir);
        let lock_path = lock_dir.join("mailvault.lock");

        match fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path) {
            Ok(mut file) => {
                let fd = file.as_raw_fd();
                // LOCK_EX = exclusive lock, LOCK_NB = non-blocking (fail immediately if locked)
                let ret = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
                if ret != 0 {
                    // Already running — read the PID and signal it to show the window
                    let mut pid_str = String::new();
                    let _ = file.read_to_string(&mut pid_str);
                    if let Ok(pid) = pid_str.trim().parse::<i32>() {
                        unsafe { libc::kill(pid, libc::SIGUSR2); }
                    }
                    std::process::exit(0);
                }
                // Write our PID so second instances can signal us
                let _ = file.set_len(0);
                let _ = file.write_all(std::process::id().to_string().as_bytes());
                let _ = file.sync_all();
                // Keep the file handle alive for the entire process lifetime.
                // When the process exits (normally or crashes), the kernel releases the lock.
                Some(file)
            }
            Err(e) => {
                eprintln!("Warning: could not create lock file: {}", e);
                None
            }
        }
    };

    let builder = tauri::Builder::default();
    // Same automation carve-out as the flock above: the D-Bus single-instance plugin
    // would make a second test-launched instance forward-and-exit instead of starting.
    let builder = if automation {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // When a second instance is launched, focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
                let _ = window.show();
            }
        }))
    };
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Dragging an attachment OUT to Finder: WKWebView's own HTML5 drag
        // hands the Desktop a .webloc, not the file, so the page cancels it
        // and this starts a real AppKit/Win32/GTK drag session instead.
        .plugin(tauri_plugin_drag::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    // Updater plugins — Sparkle on macOS (non-MAS), tauri-plugin-updater on Linux.
    // MAS builds (`appstore`, no `sparkle` feature) get updates via the App Store.
    #[cfg(all(target_os = "macos", feature = "sparkle"))]
    let builder = builder.plugin(tauri_plugin_sparkle_updater::init());
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // No `ImapPool` in this process at all any more: Task 5.4b moved the
    // interactive commands to the daemon's own pool, and the Phase 3
    // remainder's Task 5 moved the backup runners there too — with them went
    // `backup.rs`'s process-global `pool()` and `archive.rs`'s shim, the last
    // app-side IMAP callers.
    let builder = builder
        .manage(backup::HeldBackupPaths::default())
        .manage(dropped_files::DroppedPaths::default())
        .manage(iap::IapState::new())
        .manage(UpdateCheckGuard::default())
        .manage(vault::VaultState::default())
        .manage(mailto::PendingMailto::default())
        .manage(notification_open::PendingNotificationOpen::default());

    #[cfg(target_os = "linux")]
    let builder = builder.manage(PendingUpdate::default());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            apply_menu_labels,
            dropped_files::read_dropped_files,
            take_pending_mailto,
            notification_open::take_notification_open,
            e2e_queue_mailto,
            mailto_default_status,
            mailto_make_default,
            spellcheck::spellcheck_status,
            log_from_frontend,
            install_pending_update,
            set_update_track,
            get_client_info,
            get_app_data_dir,
            read_settings_json,
            write_settings_json,
            autostart::autostart_state,
            autostart::set_autostart,
            store_credentials,
            get_credentials,
            store_password,
            read_logs,
            clear_logs,
            check_network_connectivity,
            send_notification,
            notification_sound::preview_notification_sound,
            set_badge_count,
            check_running_from_dmg,
            save_attachment_to,
            show_in_folder,
            open_file,
            open_with_dialog,
            open_email_window,
            open_compose_window,
            vault_flags::vault_apply_flags,
            vault_flags::vault_rename_mailbox,
            vault_flags::vault_adopt_mailbox_dirs,
            // smtp_test_connection, smtp_build_mime, smtp_build_draft_mime and
            // smtp_send_email moved to the daemon (Task 5.5,
            // src-daemon/src/handlers/smtp.rs) — routed via transport.js's
            // DAEMON_OWNED, no Tauri command left to register.
            // oauth2_auth_url, oauth2_exchange and oauth2_refresh moved to
            // the daemon (Task 5.7, src-daemon/src/handlers/oauth2.rs) —
            // routed via transport.js's DAEMON_OWNED, no Tauri command left
            // to register.
            // graph_list_folders, graph_list_messages, graph_get_message,
            // graph_cache_mime, graph_set_read, graph_set_flagged,
            // graph_delete_message, graph_move_emails, graph_create_folder,
            // graph_rename_folder, graph_move_folder and graph_delete_folder
            // moved to the daemon (Task 5.6, src-daemon/src/handlers/
            // graph.rs) — routed via transport.js's DAEMON_OWNED, no Tauri
            // command left to register. graph_get_mime is not among them: it
            // had 0 callers (confirmed by grep) and was deleted outright,
            // not ported.
            // resolve_email_settings and dns_mail_health moved to the daemon
            // (Task 5.8, src-daemon/src/handlers/dns.rs) — routed via
            // transport.js's DAEMON_OWNED, no Tauri command left to register.
            commands::backup_run_account,
            commands::backup_status,
            commands::backup_save_external_location,
            commands::backup_get_external_location,
            commands::backup_validate_external_location,
            commands::backup_clear_external_location,
            commands::iap_is_entitled,
            commands::iap_purchase,
            commands::iap_restore,
            commands::backup_migrate_legacy_path,
            backup::backup_purge_uids,
            backup::backup_scan_uids,
            commands::get_transfer_stats,
            github::github_device_start,
            github::github_device_poll,
            github::github_check_star,
            daemon_rpc,
            vault_get_status, vault_inspect_folder, vault_adopt, vault_move_to, vault_move_to_default, vault_reset,
            daemon_channel_notify
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            notification_open::mac::install(app.handle());
            // `mailto:` from the OS. The queue is the source of truth and the
            // event is only a wake-up: when the click *launches* the app the URL
            // lands here before the webview exists, so a listener alone would
            // drop the first mailto of every cold start.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let queue = handle.state::<mailto::PendingMailto>();
                    for url in event.urls() {
                        queue.push(url.to_string());
                    }
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = handle.emit("mailto-open", ());
                });
                // The URL this process was launched with, if any.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let queue = app.state::<mailto::PendingMailto>();
                    for url in urls {
                        queue.push(url.to_string());
                    }
                }
                // Linux and Windows register at runtime; macOS is static, from
                // `CFBundleURLTypes` in the bundle.
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                let _ = app.deep_link().register_all();
            }

            // WebKitGTK's checker is off until it is switched on, and it needs a
            // dictionary on disk to say anything. Everywhere else the OS checks
            // spelling; this is a no-op there.
            if let Some(window) = app.get_webview_window("main") {
                spellcheck::enable_for_window(&window);
            }

            // Set up logging to app log directory
            let log_dir = get_log_dir(&app.handle());
            let _guard = setup_logging(&log_dir);

            // Store the guard to keep logging alive
            std::mem::forget(_guard);

            // Clean up old logs
            cleanup_old_logs(&log_dir);

            // Clean up stale popup cache files from previous sessions
            if let Ok(data_dir) = app.path().app_data_dir() {
                let popup_cache = data_dir.join("popup_cache");
                if popup_cache.exists() {
                    let _ = fs::remove_dir_all(&popup_cache);
                }
            }

            // Store log directory for later use
            app.manage(LogDir(log_dir));

            // Per-account transfer counters → `<app_data_dir>/transfer_stats/*.app.json`.
            // The daemon writes its own file; neither process locks the other's.
            if let Ok(stats_dir) = app.path().app_data_dir() {
                tauri::async_runtime::spawn(async move {
                    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
                    ticker.tick().await;
                    loop {
                        ticker.tick().await;
                        mailvault_core::transfer_stats::global().flush(&stats_dir, "app");
                    }
                });
            }

            // Install the StoreKit transaction observer (no-op on non-MAS builds)
            iap::install_observer(&app.state::<iap::IapState>());

            info!("MailVault application starting");
            info!("App version: {}", env!("CARGO_PKG_VERSION"));

            // Resolve the mail storage location once, before anything reads
            // mail. On macOS this starts security-scoped access and holds it for
            // the process lifetime. A missing drive is not fatal — the frontend
            // shows the banner and asks for the folder.
            let vault_status = vault::resolve(&app.handle());
            info!(
                "Mail storage: {} ({})",
                if vault_status.display_path.is_empty() { "app data dir" } else { &vault_status.display_path },
                vault_status.status
            );
            // The custody store opens in the DAEMON now (Task 2.9b), before
            // its socket exists: `custody.db` is EXCLUSIVE, so exactly one
            // process may hold it, and the legacy JSON import runs there.
            daemon_channel::start(app.handle());

            // The app's own `.eml` startup sweep is deleted (Task 2.8): the
            // daemon already runs `migrate_add_eml_extension` at startup
            // (`src-daemon/src/main.rs`), so running it here too would be one
            // process racing the other over the same renames. As of the
            // Phase 3 remainder (Task 5) the app is out of `cur/`
            // altogether: `graph_cache_mime` (Task 5.6), `restore.rs` (4.7),
            // the mbox and ZIP importers (4.6, 4.4) and finally the backup
            // runners and `archive.rs`'s shim all write from the daemon now
            // (Task 2.8 review M3, closed).

            // --- Set up app menu ---
            // No "Check for Updates" on MAS builds — the App Store handles updates.
            #[cfg(any(not(target_os = "macos"), feature = "sparkle"))]
            let check_updates = MenuItem::with_id(app, "check_updates", "Check for Updates...", true, None::<&str>)?;
            #[cfg(target_os = "macos")]
            let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("cmd+,"))?;
            #[cfg(not(target_os = "macos"))]
            let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("ctrl+,"))?;
            let report_bug = MenuItem::with_id(app, "report_bug", "Report Bug...", true, None::<&str>)?;
            let export_logs = MenuItem::with_id(app, "export_logs", "Export Logs...", true, None::<&str>)?;
            let logs_submenu = Submenu::with_id(app, "logs_submenu", "Logs", true)?;
            logs_submenu.append(&export_logs)?;
            let website_item = MenuItem::with_id(app, "open_website", "MailVault Website", true, None::<&str>)?;
            let more_apps_item = MenuItem::with_id(app, "open_more_apps", "More Apps by GraphicMeat", true, None::<&str>)?;
            // PROBE (not for merge): "Probe: Backup Bookmark Scope (automatic)".
            #[cfg(target_os = "macos")]
            let probe_backup_scope_item = MenuItem::with_id(app, "probe_backup_scope", "Probe: Backup Bookmark Scope (automatic)", true, None::<&str>)?;
            // PROBE (not for merge): "Probe: OAuth2 Loopback Bind (automatic)".
            // Runs in-process (not the external scripts/probe-oauth2-loopback.py script)
            // because that script's literal `~/.mailvault/mv.sock` path is invisible to an
            // unsandboxed checker once the app+daemon are actually sandboxed: App Sandbox
            // redirects $HOME for the (sandboxed) app/daemon pair into their Container, and
            // TCC blocks any unsandboxed process — even Rokas's own Terminal without Full
            // Disk Access — from reading in there. Doing the RPC + TCP check from inside the
            // already-sandboxed app process sidesteps that entirely.
            #[cfg(target_os = "macos")]
            let probe_oauth2_item = MenuItem::with_id(app, "probe_oauth2_loopback", "Probe: OAuth2 Loopback Bind (automatic)", true, None::<&str>)?;

            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                // Insert items below "About MailVault" in the app submenu
                if let Ok(items) = menu.items() {
                    if let Some(first) = items.first() {
                        if let Some(app_submenu) = first.as_submenu() {
                            let sep1 = PredefinedMenuItem::separator(app)?;
                            let sep2 = PredefinedMenuItem::separator(app)?;
                            let _ = app_submenu.insert(&sep1, 1);
                            #[cfg(feature = "sparkle")]
                            let _ = app_submenu.insert(&check_updates, 2);
                            #[cfg(feature = "sparkle")]
                            let _ = app_submenu.insert(&open_settings, 3);
                            #[cfg(not(feature = "sparkle"))]
                            let _ = app_submenu.insert(&open_settings, 2);
                            #[cfg(feature = "sparkle")]
                            let _ = app_submenu.insert(&report_bug, 4);
                            #[cfg(not(feature = "sparkle"))]
                            let _ = app_submenu.insert(&report_bug, 3);
                            #[cfg(feature = "sparkle")]
                            let _ = app_submenu.insert(&sep2, 5);
                            #[cfg(not(feature = "sparkle"))]
                            let _ = app_submenu.insert(&sep2, 4);
                        }
                    }
                }
                menu.append(&logs_submenu)?;

                // Populate the Help menu (default menu creates it empty)
                let shortcuts_item = MenuItem::with_id(app, "open_shortcuts", "Keyboard Shortcuts", true, Some("cmd+/"))?;
                if let Ok(items) = menu.items() {
                    for item in &items {
                        if let Some(sub) = item.as_submenu() {
                            if sub.text().unwrap_or_default() == "Help" {
                                let _ = sub.append(&website_item);
                                let _ = sub.append(&more_apps_item);
                                let _ = sub.append(&shortcuts_item);
                                let _ = sub.append(&probe_backup_scope_item);
                                let _ = sub.append(&probe_oauth2_item);
                                break;
                            }
                        }
                    }
                }
                app.set_menu(menu)?;
            }

            #[cfg(not(target_os = "macos"))]
            {
                let sep = PredefinedMenuItem::separator(app)?;
                let quit_item = MenuItem::with_id(app, "quit_app", "Quit", true, Some("ctrl+q"))?;
                let file_submenu = Submenu::with_id(app, "file_submenu", "File", true)?;
                file_submenu.append(&check_updates)?;
                file_submenu.append(&open_settings)?;
                file_submenu.append(&report_bug)?;
                file_submenu.append(&website_item)?;
                file_submenu.append(&more_apps_item)?;
                file_submenu.append(&sep)?;
                file_submenu.append(&quit_item)?;

                let menu = Menu::with_items(app, &[
                    &file_submenu as &dyn tauri::menu::IsMenuItem<_>,
                    &logs_submenu as &dyn tauri::menu::IsMenuItem<_>,
                ])?;
                app.set_menu(menu)?;
            }

            // Handle app menu events
            let app_handle_for_menu = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "check_updates" {
                    let handle = app_handle_for_menu.clone();
                    tauri::async_runtime::spawn(async move {
                        check_for_updates(handle, true).await;
                    });
                } else if event.id().as_ref() == "open_settings" {
                    let _ = app_handle_for_menu.emit("open-settings", ());
                } else if event.id().as_ref() == "report_bug" {
                    let _ = app_handle_for_menu.emit("report-bug", ());
                } else if event.id().as_ref() == "export_logs" {
                    use tauri_plugin_dialog::DialogExt;
                    let app_clone = app_handle_for_menu.clone();
                    let log_dir = get_log_dir(&app_clone);
                    app_clone.dialog()
                        .file()
                        .set_directory(&log_dir)
                        .set_file_name("mailvault-logs.txt")
                        .save_file(move |file_path| {
                            if let Some(file_path) = file_path {
                                if let Some(path) = file_path.as_path() {
                                    if let Ok(logs) = read_logs(app_clone.clone(), None) {
                                        let _ = fs::write(path, logs);
                                    }
                                }
                            }
                        });
                } else if event.id().as_ref() == "open_website" {
                    use tauri_plugin_shell::ShellExt;
                    let _ = app_handle_for_menu.shell().open("https://mailvaultapp.com", None::<tauri_plugin_shell::open::Program>);
                } else if event.id().as_ref() == "open_more_apps" {
                    use tauri_plugin_shell::ShellExt;
                    let _ = app_handle_for_menu.shell().open("https://graphicmeat.com", None::<tauri_plugin_shell::open::Program>);
                } else if event.id().as_ref() == "open_shortcuts" {
                    let _ = app_handle_for_menu.emit("open-shortcuts", ());
                } else if event.id().as_ref() == "probe_backup_scope" {
                    #[cfg(target_os = "macos")]
                    {
                        let h = app_handle_for_menu.clone();
                        std::thread::spawn(move || probe_backup_scope(h));
                    }
                } else if event.id().as_ref() == "probe_oauth2_loopback" {
                    #[cfg(target_os = "macos")]
                    {
                        let h = app_handle_for_menu.clone();
                        std::thread::spawn(move || probe_oauth2_loopback(h));
                    }
                } else if event.id().as_ref() == "quit_app" {
                    info!("Application quitting via menu");
                    std::process::exit(0);
                }
            });

            // --- Set up system tray ---
            let tray_show = MenuItem::with_id(app, "show", "Show MailVault", true, None::<&str>)?;
            let tray_view_logs = MenuItem::with_id(app, "tray_view_logs", "View Logs", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;

            let tray_menu = Menu::with_items(app, &[
                &tray_show as &dyn tauri::menu::IsMenuItem<_>,
                &sep1 as &dyn tauri::menu::IsMenuItem<_>,
                &tray_view_logs as &dyn tauri::menu::IsMenuItem<_>,
                &sep2 as &dyn tauri::menu::IsMenuItem<_>,
                &tray_quit as &dyn tauri::menu::IsMenuItem<_>,
            ])?;

            // TrayIcon exposes no `menu()` accessor, so keep a handle to the tray
            // menu in state — `apply_menu_labels` relabels it alongside the menu bar.
            app.manage(TrayMenu(tray_menu.clone()));

            let tray_icon_image = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .expect("Failed to load tray icon");

            TrayIconBuilder::new()
                .icon(tray_icon_image)
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "tray_view_logs" => {
                            if let Some(log_dir) = app.try_state::<LogDir>() {
                                #[cfg(target_os = "macos")]
                                let _ = std::process::Command::new("open").arg(&log_dir.0).spawn();
                                #[cfg(target_os = "windows")]
                                let _ = std::process::Command::new("explorer").arg(&log_dir.0).spawn();
                                #[cfg(target_os = "linux")]
                                let _ = std::process::Command::new("xdg-open").arg(&log_dir.0).spawn();
                            }
                        }
                        "quit" => {
                            info!("Application quitting via tray menu");
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Point Sparkle at the right feed before anything can check it —
            // both the delayed check below and Sparkle's own schedule.
            apply_update_track(&app.handle(), persisted_update_track(&app.handle()).as_deref());

            // Check for updates in background
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Delay update check to let the app initialize first
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                check_for_updates(update_handle, false).await;
            });

            info!("Application setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            // Paths from the latest native drop are the only ones the
            // webview may read back through read_dropped_files.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<dropped_files::DroppedPaths>().remember(paths);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only hide-to-tray for the main window; popup windows close normally
                if window.label() == "main" {
                    info!("Main window close requested, hiding to tray");
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Linux: listen for SIGUSR1 from second instances to show+focus the window
    #[cfg(target_os = "linux")]
    let sigusr1_flag = {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _ = signal_hook::flag::register(signal_hook::consts::SIGUSR2, std::sync::Arc::clone(&flag));
        flag
    };

    app.run(move |app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                tauri::RunEvent::Exit => {
                    info!("Application exiting — flushing transfer stats, cleaning up daemon child if on-demand");
                    // Before anything else: stops a reconnect blocked inside
                    // ensure_daemon_running from spawning an orphan daemon
                    // once shutdown_daemon_child() below has released DAEMON_CHILD.
                    APP_EXITING.store(true, Ordering::SeqCst);
                    // Runs on the main thread and blocks the quit, so keep the
                    // budget tight: an unreachable server must cost the user a
                    // beachball, not a hang. Worst case here plus
                    // DAEMON_STOP_GRACE below.
                    if let Ok(dir) = app_handle.path().app_data_dir() {
                        mailvault_core::transfer_stats::global().flush(&dir, "app");
                    }
                    // No IMAP sessions to log out of here any more: the app
                    // process holds no `ImapPool` at all since the backup
                    // runners moved to the daemon (Phase 3 remainder, Task
                    // 5), which owns the only pool and shuts it down itself.
                    daemon_channel::stop();
                    // "Keep the daemon running in the background": leave the
                    // child alive and let init adopt it. Its stdio is already
                    // null and it holds no handle on us, so nothing here is
                    // keeping it alive — only this SIGTERM would end it.
                    // `stop_daemon()` (vault moves, restarts) still stops it;
                    // this is the app-quit path alone.
                    if daemon_always_on(app_handle) {
                        info!("daemon left running in the background at app exit (always-on is on)");
                    } else {
                        shutdown_daemon_child();
                    }
                }
                #[cfg(target_os = "linux")]
                tauri::RunEvent::MainEventsCleared => {
                    if sigusr1_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        sigusr1_flag.store(false, std::sync::atomic::Ordering::Relaxed);
                        info!("SIGUSR2 received — bringing window to front");
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                }
                _ => {}
            }
        });
}

/// PROBE (not for merge): does `resolve_external_location`'s `start_access`
/// (which rebuilds a plain `fileURLWithPath:` from the resolved bookmark's
/// path string — see the comment in `external_location::macos::open_in_finder_inner`)
/// actually grant write access to the configured backup folder, or is it a
/// silent no-op? Three writes: cold (no start_access at all), warm (right
/// after `resolve_external_location`), post-release (after `release_external_access`).
///
/// Precondition: an external backup location must already be configured in
/// Settings > Backup Scope & Storage, saved in a PRIOR app launch. Quit and
/// relaunch this signed build before running the probe, so no NSOpenPanel
/// session grant from picking the folder is still live — only the persisted
/// bookmark is being tested.
#[cfg(target_os = "macos")]
fn probe_backup_scope(h: tauri::AppHandle) {
    use serde_json::json;
    use tauri_plugin_dialog::DialogExt;

    fn write_probe(dir: &Path) -> Result<(), String> {
        let f = dir.join(".mailvault-probe-scope.txt");
        std::fs::write(&f, b"probe\n").map_err(|e| format!("write: {e} (errno {:?})", e.raw_os_error()))?;
        let readback = std::fs::read(&f).map_err(|e| format!("readback: {e} (errno {:?})", e.raw_os_error()))?;
        let _ = std::fs::remove_file(&f);
        if readback != b"probe\n" {
            return Err("readback mismatch".to_string());
        }
        Ok(())
    }

    let data_dir = match h.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            h.dialog().message(format!("app_data_dir: {e}")).title("Probe: Backup Scope — FAIL").blocking_show();
            return;
        }
    };

    let display_path = mailvault_core::app_db::with(&data_dir, |conn| {
        Ok(mailvault_core::app_db::locations::display_path(conn, external_location::SLOT_EXTERNAL_BACKUP))
    })
    .ok()
    .flatten();

    let Some(display_path) = display_path else {
        h.dialog()
            .message("No external backup location configured. Set one in Settings > Backup Scope & Storage, quit, relaunch, then run this probe again.")
            .title("Probe: Backup Scope — SKIPPED")
            .blocking_show();
        return;
    };

    // Step A: cold write, before resolve_external_location is ever called this session.
    let cold_err: Option<String> = write_probe(&PathBuf::from(&display_path)).err();
    info!("[probe-backup-scope] cold (no start_access) error: {:?}", cold_err);

    // Step B: production resolve_external_location — resolves the bookmark, calls start_access.
    let resolved = external_location::resolve_external_location(&data_dir, external_location::SLOT_EXTERNAL_BACKUP);
    let resolve_err: Option<String> = resolved.as_ref().err().cloned();
    let resolved_path: Option<String> = resolved.ok().map(|(path, _loc)| path);
    let warm_err: Option<String> = match &resolved_path {
        Some(p) => write_probe(&PathBuf::from(p)).err(),
        None => None,
    };
    info!("[probe-backup-scope] resolve_external_location error: {:?}; warm write error: {:?}", resolve_err, warm_err);

    // Step C: release, then a control write — if this still succeeds, the
    // sandbox is not enforcing scope-loss on release either, which is its own finding.
    if let Some(p) = &resolved_path {
        external_location::release_external_access(p);
    }
    let post_release_err: Option<String> = resolved_path.as_ref().and_then(|p| write_probe(&PathBuf::from(p)).err());
    info!("[probe-backup-scope] post-release write error: {:?}", post_release_err);

    let verdict = match (&cold_err, &resolved_path.is_some(), &warm_err) {
        (None, _, _) => "INCONCLUSIVE: the cold write (before start_access was ever called) already succeeded. Either this folder never required scope, or a prior session's picker grant is still live — quit, relaunch, and rerun.",
        (Some(_), false, _) => "INCONCLUSIVE: resolve_external_location itself failed (see log) before start_access could be tested.",
        (Some(_), true, None) => "PASS: cold write was refused, the warm write (after resolve_external_location/start_access) succeeded. start_access genuinely grants access. The broker-vs-daemon-restart architectural fork is real — decide it on its own merits.",
        (Some(_), true, Some(_)) => "FAIL — BUG CONFIRMED: cold write refused AND the warm write after start_access was ALSO refused. resolve_external_location's start_access does not carry the security-scope extension (it rebuilds a plain fileURLWithPath: from the resolved path string — same defect the open_in_finder_inner fix in c393c14c worked around for Finder, but this call site was never fixed). Backups to this external folder are broken today after any relaunch, independent of the daemon migration. Fix: start scope on the NSURL object resolve_bookmark_inner already returns, never round-trip it through a path string. This is a Phase 3 prerequisite, not a broker-vs-restart tiebreaker.",
    };

    let summary = json!({
        "displayPath": display_path,
        "cold_write_error": cold_err,
        "resolve_external_location_error": resolve_err,
        "warm_write_error": warm_err,
        "post_release_write_error": post_release_err,
        "verdict": verdict,
    });
    info!("[probe-backup-scope] SUMMARY: {}", summary);
    h.dialog()
        .message(format!("{verdict}\n\nFull JSON in the log (search \"probe-backup-scope\")."))
        .title("Probe: Backup Bookmark Scope")
        .blocking_show();
}

/// PROBE (not for merge): can the signed, sandboxed daemon bind the OAuth2
/// loopback callback listener (127.0.0.1:19876)? Same question as
/// `scripts/probe-oauth2-loopback.py`, but run in-process: that script talks
/// to the daemon over its `~/.mailvault/mv.sock` control socket using the
/// LITERAL path, which only resolves for an unsandboxed checker. Once the
/// app+daemon are actually sandboxed, `$HOME` is redirected into the app's
/// Container for both of them, and TCC blocks any outside process (even
/// Rokas's own Terminal, without Full Disk Access) from reading in there —
/// discovered while trying to run that script against this exact build.
/// Doing the RPC (`oauth2_auth_url`, via the same `daemon_call_blocking` every
/// other bridge caller uses) and the TCP probe from inside the app process
/// sidesteps the whole problem: it shares the daemon's redirected view.
#[cfg(target_os = "macos")]
fn probe_oauth2_loopback(h: tauri::AppHandle) {
    use serde_json::json;
    use std::net::TcpStream;
    use std::time::{Duration, Instant};
    use tauri_plugin_dialog::DialogExt;

    const CALLBACK_PORT: u16 = 19876;

    let rpc_result = daemon_call_blocking(&h, "oauth2_auth_url", json!({}), Duration::from_secs(30));
    let (auth_url_ok, rpc_err) = match &rpc_result {
        Ok(v) => (v.get("authUrl").and_then(|s| s.as_str()).is_some(), None),
        Err(e) => (false, Some(e.clone())),
    };
    info!("[probe-oauth2-loopback] oauth2_auth_url result: ok={} err={:?}", auth_url_ok, rpc_err);

    if !auth_url_ok {
        let verdict = format!(
            "FAIL: oauth2_auth_url did not return an authUrl (daemon error: {}). The callback \
             server bind is only requested as a side effect of this call, so it was never attempted.",
            rpc_err.as_deref().unwrap_or("none, but authUrl missing from reply")
        );
        info!("[probe-oauth2-loopback] SUMMARY: {}", json!({"verdict": verdict}));
        h.dialog().message(verdict).title("Probe: OAuth2 Loopback Bind — FAIL").blocking_show();
        return;
    }

    // ensure_callback_server's bind runs on a spawned tokio task inside the
    // daemon — give it a moment, then poll for the listener actually
    // accepting connections, same 5 s budget as the external script.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut connected = false;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&"127.0.0.1:19876".parse().unwrap(), Duration::from_millis(500)).is_ok() {
            connected = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    let verdict = if connected {
        format!("PASS: the sandboxed daemon is listening on 127.0.0.1:{CALLBACK_PORT}. The OAuth2 loopback callback bind works under App Sandbox.")
    } else {
        format!(
            "FAIL: oauth2_auth_url succeeded, but nothing accepted a TCP connection on \
             127.0.0.1:{CALLBACK_PORT} within 5s — the sandboxed daemon likely could not bind the \
             loopback listener. Check daemon.log for '[OAuth2]' / 'Failed to bind callback server' / \
             'Operation not permitted'."
        )
    };
    info!("[probe-oauth2-loopback] SUMMARY: {}", json!({"auth_url_ok": auth_url_ok, "connected": connected, "verdict": &verdict}));
    h.dialog()
        .message(verdict)
        .title("Probe: OAuth2 Loopback Bind")
        .blocking_show();
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_ipc_paths_live_under_home_dot_mailvault() {
        let (sock, token) = crate::daemon_ipc_paths().unwrap();
        let home = dirs::home_dir().unwrap().join(".mailvault");
        assert_eq!(sock, home.join("mv.sock"));
        assert_eq!(token, home.join("mv.token"));
    }

    #[test]
    fn daemon_pid_path_lives_under_the_app_data_dir_not_the_ipc_dir() {
        // Must match src-daemon's get_data_dir() + write_pid_file, and must
        // differ from daemon_ipc_paths()'s ~/.mailvault — they are two
        // different directories the daemon writes into.
        let expected = dirs::data_local_dir().unwrap().join("com.mailvault.app").join("daemon.pid");
        assert_eq!(crate::daemon_pid_path(), expected);
        let (sock, _) = crate::daemon_ipc_paths().unwrap();
        assert_ne!(crate::daemon_pid_path().parent(), sock.parent());
    }

    #[test]
    fn parse_daemon_pid_reads_a_bare_integer() {
        assert_eq!(crate::parse_daemon_pid("4242"), Some(4242));
    }

    #[test]
    fn parse_daemon_pid_tolerates_a_trailing_newline() {
        assert_eq!(crate::parse_daemon_pid("4242\n"), Some(4242));
        assert_eq!(crate::parse_daemon_pid("  4242  \n"), Some(4242));
    }

    #[test]
    fn parse_daemon_pid_rejects_garbage() {
        assert_eq!(crate::parse_daemon_pid(""), None);
        assert_eq!(crate::parse_daemon_pid("not a pid"), None);
        assert_eq!(crate::parse_daemon_pid("-1"), None);
        assert_eq!(crate::parse_daemon_pid("0"), None);
    }

    #[test]
    fn is_daemon_exe_name_matches_the_plain_binary_name() {
        assert!(crate::is_daemon_exe_name("mailvault-daemon"));
    }

    #[test]
    fn is_daemon_exe_name_tolerates_the_proc_deleted_suffix() {
        // Linux's /proc/<pid>/exe readlink appends this after a package
        // upgrade replaces the file backing an already-running process.
        assert!(crate::is_daemon_exe_name("mailvault-daemon (deleted)"));
    }

    #[test]
    fn is_daemon_exe_name_rejects_anything_else() {
        assert!(!crate::is_daemon_exe_name("mailvault"));
        assert!(!crate::is_daemon_exe_name("mailvault-daemon-old"));
        assert!(!crate::is_daemon_exe_name(""));
    }

    #[test]
    fn an_explicit_update_track_wins_over_the_build() {
        // The whole point of the setting: a nightly can go back to stable, and a
        // stable build can opt into nightlies, whatever version it was built as.
        assert_eq!(
            update_feed_override(Some("nightly"), "2.12.0").as_deref(),
            Some(NIGHTLY_APPCAST_URL)
        );
        assert_eq!(
            update_feed_override(Some("stable"), "2.12.0-nightly.abc1234"),
            None
        );
    }

    #[test]
    fn with_no_choice_saved_the_build_picks_its_own_feed() {
        assert_eq!(
            update_feed_override(None, "2.12.0-nightly.abc1234").as_deref(),
            Some(NIGHTLY_APPCAST_URL)
        );
        assert_eq!(update_feed_override(None, "2.12.0"), None);
        // A value from an older or newer catalogue reads as "unset", not as nightly.
        assert_eq!(update_feed_override(Some("beta"), "2.12.0"), None);
    }

    #[test]
    fn save_attachment_to_creates_missing_parent_directories() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        // Two levels that do not exist yet — what openInDefaultApp asks for
        // the first time an export is opened on a fresh machine.
        let dest = dir.path().join("mailvault-export").join("nested").join("shot.png");
        let written = save_attachment_to(
            "shot.png".into(),
            base64::engine::general_purpose::STANDARD.encode(b"pixels"),
            dest.to_string_lossy().to_string(),
        )
        .expect("write into a missing directory should succeed");
        assert_eq!(std::fs::read(&written).unwrap(), b"pixels");
    }

    /// Phase 3 remainder, Task 5: `backup.rs` resolves and releases the
    /// backup mirror's bookmark and nothing else. Every write it used to do —
    /// the mirror pre-sync's `fs::copy` in both directions, the Graph fetch
    /// loop's `fs::write` into `cur/`, the purge queue's own file — moved to
    /// `mailvault_core::backup`, running in the daemon. A write reappearing
    /// here would be the app growing back a vault writer.
    ///
    /// The real gate on this claim is `tests/unit/vaultInDaemon.test.js`,
    /// which reads every file in this directory and runs in CI (`cargo test
    /// -p mailvault` does not). This is the same check from inside the crate.
    #[test]
    fn backup_rs_has_no_vault_or_mirror_writers_left() {
        let src = std::fs::read_to_string("src/backup.rs").expect("run from the crate root");
        for call in ["fs::write", "fs::copy", "fs::remove_file", "fs::create_dir_all"] {
            assert!(!src.contains(call), "backup.rs should only resolve/release the bookmark now, found {call}");
        }
        // Not vacuous: the file is still the bookmark broker the daemon
        // cannot be, and it still forwards.
        assert!(src.contains("resolve_external_location"), "backup.rs stopped resolving the bookmark");
        assert!(src.contains("daemon_call_blocking"), "backup.rs stopped forwarding to the daemon");
    }

    // -----------------------------------------------------------------------
    // Task 1.6b: daemon_rpc hardening — reply_timeout (C8)
    // -----------------------------------------------------------------------

    #[test]
    fn reply_timeout_bounds_the_helper_probe_so_settings_never_hangs_on_checking() {
        assert_eq!(crate::reply_timeout("ping"), Some(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn reply_timeout_gives_search_index_destroy_the_longest_budget() {
        assert_eq!(crate::reply_timeout("search_index_destroy"), Some(std::time::Duration::from_secs(150)));
    }

    #[test]
    fn reply_timeout_gives_the_search_and_vault_index_family_thirty_seconds() {
        for method in ["vault_search", "vault_rows", "search_index_status", "search_index_configure", "search_index_rebuild"] {
            assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
        }
    }

    #[test]
    fn reply_timeout_is_none_for_legacy_dotted_methods() {
        assert_eq!(crate::reply_timeout("sync.now"), None);
        assert_eq!(crate::reply_timeout("daemon.heartbeat"), None);
        assert_eq!(crate::reply_timeout("snapshot.create"), None);
    }

    // -----------------------------------------------------------------------
    // Task 2.5 Step 4: every Phase 2 daemon-owned name has a reply_timeout
    // entry, added ahead of its route landing so a later task cannot forget it.
    // -----------------------------------------------------------------------

    #[test]
    fn reply_timeout_gives_every_phase_2_thirty_second_method_thirty_seconds() {
        for method in [
            "maildir_read", "maildir_read_light", "maildir_read_attachment",
            "maildir_read_raw_source", "maildir_exists", "maildir_store", "maildir_delete",
            "maildir_delete_many", "maildir_set_flags", "cache_attachment", "cached_attachment_path",
            "save_email_cache", "load_email_cache_partial", "load_email_cache_meta", "load_email_cache_by_uids",
            "list_cached_uids", "header_cache_month_histogram", "save_mailbox_cache", "load_mailbox_cache", "delete_mailbox_cache",
            "load_graph_id_map", "op_journal_queue", "op_journal_clear", "op_journal_read",
            "read_pending_operation", "save_pending_operation", "clear_pending_operation", "local_index_read",
            "local_index_append", "local_index_remove", "custody_status", "maildir_repair_generation",
            "maildir_orphan_stats", "mail_search_start", "mail_search_cancel",
        ] {
            assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
        }
    }

    #[test]
    fn reply_timeout_gives_every_phase_2_hundred_twenty_second_method_that_budget() {
        // I3 (2.6 review fix round 1): `maildir_read_light_batch`/`maildir_list`
        // moved here from the 30s tier — they can cover a whole mailbox's
        // uids in one unchunked call, a full MIME parse per file.
        for method in [
            "load_email_cache", "graph_allocate_uids", "maildir_storage_stats", "clear_email_cache",
            "maildir_read_light_batch", "maildir_list",
        ] {
            assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(120)), "method={method}");
        }
    }

    /// Final fix wave I-2: raised from 120s so the app's budget is strictly
    /// larger than the daemon's own close wait. RED on the pre-fix code
    /// (120s).
    #[test]
    fn reply_timeout_gives_vault_close_a_five_minute_budget() {
        assert_eq!(crate::reply_timeout("vault_close"), Some(std::time::Duration::from_secs(300)));
    }

    #[test]
    fn reply_timeout_gives_every_phase_2_ten_minute_method_that_budget() {
        for method in [
            "maildir_clear_cache", "maildir_migrate_json_to_eml", "maildir_migrate_email_dirs",
            "maildir_purge_orphans", "prefetch_attachments", "vault_apply_flags", "vault_rename_mailbox",
            "vault_adopt_mailbox_dirs",
        ] {
            assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(600)), "method={method}");
        }
    }

    /// `vault_reopen` is deliberately absent from the plan's table (only the
    /// blocking `daemon_call_blocking` call sites use it, each passing their
    /// own explicit `Duration`, never through this async-`daemon_rpc` table).
    #[test]
    fn reply_timeout_is_none_for_vault_reopen() {
        assert_eq!(crate::reply_timeout("vault_reopen"), None);
    }

    // -----------------------------------------------------------------------
    // Task 3.5 (F1 follow-up from 3.4's review): archive_emails, bulk_delete_
    // emails, verify_archived_emails, cancel_archive, cancel_bulk_delete each
    // now have an explicit reply_timeout arm.
    // -----------------------------------------------------------------------

    /// Decision 3: archive_emails and bulk_delete_emails get no budget at
    /// all. Pinned explicitly (not just "happens to match the `_ => None`
    /// catch-all") so a later change to that default cannot silently take
    /// the budget away from these two.
    #[test]
    fn reply_timeout_is_none_for_archive_emails_and_bulk_delete_emails() {
        assert_eq!(crate::reply_timeout("archive_emails"), None);
        assert_eq!(crate::reply_timeout("bulk_delete_emails"), None);
    }

    #[test]
    fn reply_timeout_gives_verify_archived_emails_two_minutes() {
        assert_eq!(crate::reply_timeout("verify_archived_emails"), Some(std::time::Duration::from_secs(120)));
    }

    #[test]
    fn reply_timeout_gives_the_two_cancel_routes_thirty_seconds() {
        for method in ["cancel_archive", "cancel_bulk_delete"] {
            assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
        }
    }

    // -----------------------------------------------------------------------
    // Task 3.7: the three insights methods.
    // -----------------------------------------------------------------------

    /// Decision 3 again: a begin_snapshot walks every cached header of every
    /// account in scope before it answers, so it gets no budget at all.
    /// Pinned explicitly rather than left to the `_ => None` catch-all.
    #[test]
    fn reply_timeout_is_none_for_insights_begin_snapshot() {
        assert_eq!(crate::reply_timeout("insights_begin_snapshot"), None);
    }

    #[test]
    fn reply_timeout_gives_insights_read_page_two_minutes() {
        assert_eq!(crate::reply_timeout("insights_read_page"), Some(std::time::Duration::from_secs(120)));
    }

    #[test]
    fn reply_timeout_gives_insights_release_snapshot_thirty_seconds() {
        assert_eq!(crate::reply_timeout("insights_release_snapshot"), Some(std::time::Duration::from_secs(30)));
    }

    // -----------------------------------------------------------------------
    // Task 4.2: fetch_remote_asset.
    // -----------------------------------------------------------------------

    /// Pinned by its own name, not the `_ => None` default arm: its own
    /// internal reqwest timeout is 10s plus redirect overhead, so 30s is a
    /// safety margin around that budget, not a new cap.
    #[test]
    fn reply_timeout_gives_fetch_remote_asset_thirty_seconds() {
        assert_eq!(crate::reply_timeout("fetch_remote_asset"), Some(std::time::Duration::from_secs(30)));
    }

    /// Task 4.4, decision 8: pinned by name, not the `_ => None` default,
    /// the whole ZIP read-or-write pass runs inline within the RPC call.
    #[test]
    fn reply_timeout_is_none_for_export_backup_and_import_backup() {
        assert_eq!(crate::reply_timeout("export_backup"), None);
        assert_eq!(crate::reply_timeout("import_backup"), None);
    }

    /// Task 4.6, same reasoning as export_backup/import_backup above: pinned
    /// by name, not the `_ => None` default, the whole mbox read-or-write
    /// pass runs inline within the RPC call.
    #[test]
    fn reply_timeout_is_none_for_export_mbox_all_and_import_mbox() {
        assert_eq!(crate::reply_timeout("export_mbox_all"), None);
        assert_eq!(crate::reply_timeout("import_mbox"), None);
    }

    // -----------------------------------------------------------------------
    // Task 4.8: migration and restore.
    // -----------------------------------------------------------------------

    /// Pinned by name, not the `_ => None` default: each of these either
    /// spawns and returns almost immediately (progress arrives over
    /// channel.open, not this reply) or is a fast local read/flag flip.
    #[test]
    fn reply_timeout_gives_the_ten_migration_and_restore_kickoff_routes_thirty_seconds() {
        for method in [
            "start_migration", "resume_migration", "count_migration_folders", "start_restore",
            "cancel_migration", "pause_migration", "cancel_restore", "clear_migration_state_cmd",
            "get_migration_state", "count_local_folder",
        ] {
            assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
        }
    }

    /// Pinned by name: a live IMAP LIST plus, when either side is Graph, an
    /// HTTP list_folders call, bounded but genuinely network-bound.
    #[test]
    fn reply_timeout_gives_get_folder_mappings_two_minutes() {
        assert_eq!(crate::reply_timeout("get_folder_mappings"), Some(std::time::Duration::from_secs(120)));
    }

    // -----------------------------------------------------------------------
    // Task 2.5 fix round 1 (I1): map_call_error / is_stale_daemon_method
    // -----------------------------------------------------------------------

    #[test]
    fn map_call_error_a_stale_method_not_found_becomes_the_outdated_catalog_key() {
        let e = mailvault_core::daemon_ipc::CallError::Rpc("Unknown method: vault_close".to_string());
        assert_eq!(crate::map_call_error("vault_close", e), crate::DAEMON_OUTDATED);
    }

    #[test]
    fn map_call_error_a_daemon_answered_error_passes_through_verbatim() {
        let e = mailvault_core::daemon_ipc::CallError::Rpc(
            "E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved".to_string(),
        );
        assert_eq!(
            crate::map_call_error("maildir_store", e),
            "E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved"
        );
    }

    #[test]
    fn map_call_error_an_unreachable_daemon_becomes_the_unavailable_catalog_key() {
        let e = mailvault_core::daemon_ipc::CallError::Unreachable("cannot connect to daemon: os error 61".to_string());
        assert_eq!(crate::map_call_error("vault_close", e), crate::DAEMON_UNAVAILABLE);
    }

    #[test]
    fn a_method_not_found_reply_is_recognized_as_a_stale_daemon_method() {
        assert!(crate::is_stale_daemon_method(crate::DAEMON_OUTDATED));
    }

    #[test]
    fn other_daemon_errors_are_not_mistaken_for_a_stale_method() {
        assert!(!crate::is_stale_daemon_method(crate::DAEMON_UNAVAILABLE));
        assert!(!crate::is_stale_daemon_method("custody store unavailable: closed"));
    }

    // -----------------------------------------------------------------------
    // Task 2.5 fix round 1 (I2): should_stop_after_lifecycle_call
    // -----------------------------------------------------------------------

    #[test]
    fn a_failed_lifecycle_call_must_stop_the_daemon() {
        assert!(crate::should_stop_after_lifecycle_call(&Err("errors.daemonUnavailable".to_string())));
    }

    #[test]
    fn a_successful_lifecycle_call_must_not_stop_the_daemon() {
        assert!(!crate::should_stop_after_lifecycle_call(&Ok(serde_json::Value::Null)));
    }

    // -----------------------------------------------------------------------
    // Task 1.6b: daemon_rpc hardening — rpc_fast_path (C7)
    // -----------------------------------------------------------------------

    #[test]
    fn rpc_fast_path_allows_a_connected_verified_cached_call() {
        assert_eq!(crate::rpc_fast_path(true, 42, Some("tok")), Some("tok".to_string()));
    }

    #[test]
    fn rpc_fast_path_refuses_when_the_channel_is_not_connected() {
        assert_eq!(crate::rpc_fast_path(false, 42, Some("tok")), None);
    }

    #[test]
    fn rpc_fast_path_refuses_an_unverified_inode() {
        assert_eq!(crate::rpc_fast_path(true, 0, Some("tok")), None);
    }

    #[test]
    fn rpc_fast_path_refuses_without_a_cached_token() {
        assert_eq!(crate::rpc_fast_path(true, 42, None), None);
    }

    // -----------------------------------------------------------------------
    // Task 1.6b: daemon_rpc hardening — map_rpc_error (C5)
    // -----------------------------------------------------------------------

    #[test]
    fn map_rpc_error_method_not_found_becomes_the_outdated_catalog_key() {
        let err = serde_json::json!({"code": -32601, "message": "Unknown method: search_index_status"});
        assert_eq!(crate::map_rpc_error(&err, "search_index_status"), "errors.daemonOutdated");
    }

    #[test]
    fn map_rpc_error_any_other_code_keeps_the_daemons_own_message() {
        let err = serde_json::json!({"code": -32000, "message": "vault is busy"});
        assert_eq!(crate::map_rpc_error(&err, "vault_search"), "vault is busy");
    }

    #[test]
    fn map_rpc_error_falls_back_when_the_message_is_missing() {
        let err = serde_json::json!({"code": -32000});
        assert_eq!(crate::map_rpc_error(&err, "vault_search"), "Unknown daemon error");
    }

    // -----------------------------------------------------------------------
    // Task 1.6b fix round 1 (I2, M3): rpc_attempt's retryable classification
    // and the whole-call timeout, against a scripted UnixListener. No
    // AppHandle needed — rpc_attempt takes only a socket path and a token.
    // -----------------------------------------------------------------------

    fn tmp_socket_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mv.sock");
        (dir, path)
    }

    #[tokio::test]
    async fn rpc_attempt_is_retryable_when_no_daemon_is_listening() {
        let (_dir, path) = tmp_socket_path(); // nothing bound here — connect fails immediately
        match rpc_attempt(&path, "tok", "sync.now", &serde_json::json!({}), None).await {
            RpcOutcome::Unavailable { retryable: true, .. } => {}
            other => panic!("expected a retryable Unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_attempt_is_retryable_when_auth_is_rejected() {
        let (_dir, path) = tmp_socket_path();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let (stream, _) = listener.accept().await.unwrap();
            let (r, mut w) = stream.into_split();
            let mut lines = BufReader::new(r).lines();
            let _auth_line = lines.next_line().await.unwrap();
            w.write_all(b"{\"error\":\"bad token\"}\n").await.unwrap();
        });

        match rpc_attempt(&path, "tok", "sync.now", &serde_json::json!({}), None).await {
            RpcOutcome::Unavailable { retryable: true, .. } => {}
            other => panic!("expected a retryable Unavailable, got {other:?}"),
        }
    }

    /// Negative control for this test (documented, not run automatically):
    /// on the runner copy only, flip `rpc_attempt_inner`'s post-write EOF arm
    /// (`"daemon closed connection before responding"`) from `retryable:
    /// false` to `retryable: true`, rerun this test — it must fail — then
    /// restore the file from the worktree via rsync and confirm the md5s
    /// match again.
    #[tokio::test]
    async fn rpc_attempt_is_not_retryable_once_the_request_was_sent_and_the_server_drops() {
        let (_dir, path) = tmp_socket_path();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let (stream, _) = listener.accept().await.unwrap();
            let (r, mut w) = stream.into_split();
            let mut lines = BufReader::new(r).lines();
            let _auth_line = lines.next_line().await.unwrap();
            w.write_all(b"{}\n").await.unwrap();
            let _request_line = lines.next_line().await.unwrap(); // the request landed
            // Drop the connection here, deliberately answering nothing.
        });

        match rpc_attempt(&path, "tok", "search_index_status", &serde_json::json!({}), None).await {
            RpcOutcome::Unavailable { retryable: false, .. } => {}
            other => panic!("expected a non-retryable Unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_attempt_maps_method_not_found_to_the_outdated_key() {
        let (_dir, path) = tmp_socket_path();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let (stream, _) = listener.accept().await.unwrap();
            let (r, mut w) = stream.into_split();
            let mut lines = BufReader::new(r).lines();
            let _auth_line = lines.next_line().await.unwrap();
            w.write_all(b"{}\n").await.unwrap();
            let _request_line = lines.next_line().await.unwrap();
            w.write_all(b"{\"error\":{\"code\":-32601,\"message\":\"Unknown method: x\"}}\n").await.unwrap();
        });

        match rpc_attempt(&path, "tok", "some_new_method", &serde_json::json!({}), None).await {
            RpcOutcome::Direct(msg) => assert_eq!(msg, "errors.daemonOutdated"),
            other => panic!("expected Direct(errors.daemonOutdated), got {other:?}"),
        }
    }

    /// M3: a listener that answers the auth handshake and then never replies
    /// to the request must still be caught by the whole-call budget, and
    /// must never be retried.
    #[tokio::test]
    async fn rpc_attempt_response_timeout_is_bounded_and_not_retryable() {
        let (_dir, path) = tmp_socket_path();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let (stream, _) = listener.accept().await.unwrap();
            let (r, mut w) = stream.into_split();
            let mut lines = BufReader::new(r).lines();
            let _auth_line = lines.next_line().await.unwrap();
            w.write_all(b"{}\n").await.unwrap();
            let _request_line = lines.next_line().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(10)).await; // never replies
        });

        let started = std::time::Instant::now();
        let outcome = rpc_attempt(&path, "tok", "vault_search", &serde_json::json!({}), Some(std::time::Duration::from_millis(100))).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "the whole-call timeout must fire near its 100ms budget, not hang");
        match outcome {
            RpcOutcome::Unavailable { retryable: false, message } => assert!(message.contains("no reply in 0s"), "{message}"),
            other => panic!("expected a non-retryable timeout, got {other:?}"),
        }
    }

    /// M3: the whole-call budget also covers the auth phase, not just the
    /// response read — a daemon that accepts the connection and then hangs
    /// before ever answering auth must not block `daemon_rpc` forever, and
    /// (per the controller's ruling) must not be retried either, even though
    /// an immediate auth failure normally would be.
    #[tokio::test]
    async fn rpc_attempt_auth_timeout_is_bounded_and_not_retryable() {
        let (_dir, path) = tmp_socket_path();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap(); // accepted, never read, never replied
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        });

        let started = std::time::Instant::now();
        let outcome = rpc_attempt(&path, "tok", "vault_search", &serde_json::json!({}), Some(std::time::Duration::from_millis(100))).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "the whole-call timeout must fire near its 100ms budget, not hang");
        match outcome {
            RpcOutcome::Unavailable { retryable: false, .. } => {}
            other => panic!("even a hang during auth must be non-retryable under a whole-call budget, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // Task 1.7: DAEMON_SUSPENDED (addendum D) — both tests serialize on this
    // lock since they're the only two touching the shared DAEMON_SUSPENDED
    // static and cargo runs tests in parallel by default.
    // -----------------------------------------------------------------------
    static SUSPEND_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn a_suspended_daemon_is_never_spawned() {
        let _serial = SUSPEND_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        assert!(may_spawn_daemon(), "baseline: nothing suspended yet");
        let guard = suspend_daemon();
        assert!(!may_spawn_daemon(), "must not spawn while a vault handler holds the guard");
        drop(guard);
        assert!(may_spawn_daemon(), "clears once the guard drops normally");
    }

    #[test]
    fn the_suspension_clears_when_the_guard_drops_during_a_panic() {
        let _serial = SUSPEND_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        assert!(may_spawn_daemon(), "baseline: nothing suspended yet");
        let _ = std::panic::catch_unwind(|| {
            let _guard = suspend_daemon();
            panic!("simulated crash mid vault-move");
        });
        assert!(may_spawn_daemon(), "a panic must not leave the daemon permanently suspended");
    }

    // Task 1.7's MoveFollowUp/after_failed_move (the root-before/root-after
    // guess) is gone as of Phase 6: the two-phase daemon move protocol
    // (vault_move_to/vault_move_to_default copy-and-verify, then
    // vault_move_finalize commits or aborts based on whether the bookmark
    // the app just saved actually resolves) makes the guess unnecessary —
    // the app never touches the bookmark until the daemon has already
    // confirmed the copy, so a failure never leaves it wondering which root
    // is current. See src-daemon/src/handlers/vault.rs and the phase 6 plan
    // doc's "Restart-ordering fix".
}

#[cfg(test)]
mod verify_copies_tests {
    use std::collections::HashMap;

    // The verify_copies cases live with it in mailvault_core::maildir.
    #[test]
    fn expected_ids_cross_the_ipc_boundary_as_string_keys() {
        // The engine builds `{ [uid]: messageId }`, and JSON object keys are
        // strings. The command declares HashMap<u32, String>; if serde stopped
        // parsing "12" into 12u32 the whole Message-ID check would be skipped
        // silently and every present file would verify again.
        let value = serde_json::json!({ "12": "<a@host.test>", "7": "b@host.test" });
        let map: Option<HashMap<u32, String>> = serde_json::from_value(value).unwrap();
        let map = map.unwrap();
        assert_eq!(map.get(&12).map(String::as_str), Some("<a@host.test>"));
        assert_eq!(map.get(&7).map(String::as_str), Some("b@host.test"));
    }
}
