// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

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
use walkdir::WalkDir;

mod archive;
mod backup;
mod commands;
mod dropped_files;
mod dns; // keeps the DNS-health-probe layer; resolver core comes from mailvault_core
mod export_fetch;
mod external_location;
mod github;
// graph/imap/oauth2 now live in mailvault_core (shared with src-daemon).
pub use mailvault_core::graph;
mod iap;
mod mailto;
pub use mailvault_core::imap;
mod migration;
mod move_emails;
mod pending_delete;
mod restore;
pub use mailvault_core::oauth2;
mod smtp;
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
fn mailto_make_default() -> mailto::MailtoStatus {
    mailto::make_default()
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
fn get_password(account_id: String) -> Result<String, String> {
    info!("=== GET PASSWORD START ===");
    info!("get_password called for account: {}", account_id);
    info!("Service name: {}", KEYRING_SERVICE);

    let entry = Entry::new(KEYRING_SERVICE, &account_id);
    info!("Entry::new result: {:?}", entry.is_ok());
    if let Err(ref e) = entry {
        error!("Entry::new error details: {:?}", e);
    }

    let entry = entry.map_err(|e| {
        error!("Failed to create keyring entry: {} - {:?}", e, e);
        format!("Failed to create keyring entry: {}", e)
    })?;

    info!("Attempting to get password from keyring...");
    let result = entry.get_password();
    match &result {
        Ok(pwd) => info!("Password retrieved successfully for account: {} (length: {} chars)", account_id, pwd.len()),
        Err(e) => {
            error!("Failed to retrieve password for account {}: {} - {:?}", account_id, e, e);
            // Try to list what's available (debug)
            info!("This could mean: 1) Password was never stored, 2) Stored with different service name, 3) Keychain access denied");
        }
    }
    info!("=== GET PASSWORD END ===");

    result.map_err(|e| format!("Failed to retrieve password: {}", e))
}

#[tauri::command]
fn delete_password(account_id: String) -> Result<(), String> {
    info!("=== DELETE PASSWORD START ===");
    info!("delete_password called for account: {}", account_id);
    info!("Service name: {}", KEYRING_SERVICE);

    let entry = Entry::new(KEYRING_SERVICE, &account_id);
    info!("Entry::new result: {:?}", entry.is_ok());

    let entry = entry.map_err(|e| {
        error!("Failed to create keyring entry: {} - {:?}", e, e);
        format!("Failed to create keyring entry: {}", e)
    })?;

    let result = entry.delete_credential();
    match &result {
        Ok(_) => info!("Password deleted successfully for account: {}", account_id),
        Err(e) => error!("Failed to delete password for account {}: {} - {:?}", account_id, e, e),
    }
    info!("=== DELETE PASSWORD END ===");

    result.map_err(|e| format!("Failed to delete password: {}", e))
}

#[tauri::command]
fn get_log_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let log_dir = get_log_dir(&app_handle);
    info!("get_log_path called, returning: {:?}", log_dir);
    Ok(log_dir.to_string_lossy().to_string())
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
fn request_notification_permission(app_handle: tauri::AppHandle) -> Result<bool, String> {
    info!("request_notification_permission called");

    use tauri_plugin_notification::NotificationExt;
    match app_handle.notification().request_permission() {
        Ok(perm) => {
            info!("Notification permission result: {:?}", perm);
            Ok(perm == tauri_plugin_notification::PermissionState::Granted)
        }
        Err(e) => {
            error!("Failed to request notification permission: {}", e);
            Err(format!("Failed to request notification permission: {}", e))
        }
    }
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
fn send_notification(app_handle: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    info!("send_notification called: {} - {}", title, body);

    use tauri_plugin_notification::NotificationExt;
    app_handle
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))?;

    Ok(())
}

// Email cache — per-email JSON sidecars
// Directory structure: email_cache/<accountId>_<mailbox>/_meta.json + <uid>.json per email
// Old monolithic format (single .json file) is auto-migrated on first save.

pub(crate) fn cache_base_name(account_id: &str, mailbox: &str) -> String {
    format!("{}_{}",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_")
    )
}

#[tauri::command]
async fn save_email_cache(app_handle: tauri::AppHandle, account_id: String, mailbox: String, data: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
    let base_dir = vault::root(&app_handle)?
        .join("email_cache");

    let base_name = cache_base_name(&account_id, &mailbox);
    let sidecar_dir = base_dir.join(&base_name);

    fs::create_dir_all(&sidecar_dir)
        .map_err(|e| format!("Failed to create sidecar directory: {}", e))?;

    let parsed: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse cache JSON: {}", e))?;

    // Write _meta.json, preserving fields the caller didn't supply.
    //
    // Most callers pass only (emails, totalEmails) — writing their missing
    // uidValidity/uidNext/highestModseq as null wiped the sync metadata the
    // daemon and the delta-sync path depend on, forcing a full page fetch on
    // the next sync. Null now means "unchanged", not "clear it".
    let meta_path = sidecar_dir.join("_meta.json");
    let mut meta = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = meta.as_object_mut() {
        for key in ["totalEmails", "uidValidity", "uidNext", "highestModseq", "lastSynced"] {
            match parsed.get(key) {
                Some(v) if !v.is_null() => { obj.insert(key.to_string(), v.clone()); }
                _ => {}
            }
        }
    }
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| format!("save_email_cache: failed to serialize _meta.json: {}", e))?;
    fs::write(&meta_path, meta_json)
        .map_err(|e| format!("save_email_cache: failed to write _meta.json: {}", e))?;

    // Write individual email files. Overwrite: the caller's copy carries the
    // current flags, and skipping existing files meant a read/star/unread
    // change never reached disk.
    if let Some(emails) = parsed.get("emails").and_then(|e| e.as_array()) {
        let mut written = 0usize;
        for email in emails {
            if let Some(uid) = email.get("uid").and_then(|u| u.as_u64()) {
                let email_json = serde_json::to_string(email)
                    .map_err(|e| format!("save_email_cache: failed to serialize email {}: {}", uid, e))?;
                fs::write(sidecar_dir.join(format!("{}.json", uid)), email_json)
                    .map_err(|e| format!("save_email_cache: failed to write email {}: {}", uid, e))?;
                written += 1;
            }
        }
        info!("Email cache saved: {} files in {}", written, base_name);
    }

    // Remove only UIDs the caller explicitly says are gone.
    //
    // This used to delete every sidecar not present in `emails` — but the store
    // holds ~500 headers while the cache holds the whole mailbox, so an ordinary
    // save truncated a 14k-message cache to 500. The list was then re-downloaded
    // from the server page by page, which is what made restarts slow.
    if let Some(removed) = parsed.get("removedUids").and_then(|v| v.as_array()) {
        let mut deleted = 0usize;
        for uid in removed.iter().filter_map(|v| v.as_u64()) {
            if fs::remove_file(sidecar_dir.join(format!("{}.json", uid))).is_ok() {
                deleted += 1;
            }
        }
        if deleted > 0 {
            info!("Email cache: removed {} expunged sidecars in {}", deleted, base_name);
        }
    }

    // Delete old monolithic file if it exists
    let old_monolithic = base_dir.join(format!("{}.json", base_name));
    if old_monolithic.exists() {
        let _ = fs::remove_file(&old_monolithic);
        info!("Removed old monolithic cache file: {:?}", old_monolithic);
    }

    Ok(())
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

// ── Dedicated mailbox cache (instant folder loading) ─────────────────────

#[tauri::command]
fn save_mailbox_cache(app_handle: tauri::AppHandle, account_id: String, data: String) -> Result<(), String> {
    let dir = vault::root(&app_handle)?
        .join("mailboxes")
        .join(&account_id);

    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create mailbox cache directory: {}", e))?;

    fs::write(dir.join("mailboxes.json"), data.as_bytes())
        .map_err(|e| format!("Failed to write mailboxes.json: {}", e))?;

    Ok(())
}

#[tauri::command]
fn load_mailbox_cache(app_handle: tauri::AppHandle, account_id: String) -> Result<Option<String>, String> {
    let file = vault::root(&app_handle)?
        .join("mailboxes")
        .join(&account_id)
        .join("mailboxes.json");

    if !file.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&file)
        .map_err(|e| format!("Failed to read mailboxes.json: {}", e))?;

    Ok(Some(data))
}

#[tauri::command]
fn delete_mailbox_cache(app_handle: tauri::AppHandle, account_id: String) -> Result<(), String> {
    let dir = vault::root(&app_handle)?
        .join("mailboxes")
        .join(&account_id);

    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove mailbox cache: {}", e))?;
    }

    Ok(())
}

// ── Graph ID map cache (UID → Graph message ID) ────────────────────────

/// Lives in the mailbox's sidecar directory alongside the `<uid>.json` files.
/// Its presence is what tells a reader that this mailbox's UIDs were allocated
/// by us over a date-ordered Graph listing rather than issued by an IMAP server
/// in arrival order — see `load_from_sidecars`.
const GRAPH_ID_MAP_FILE: &str = "graph_id_map.json";

#[tauri::command]
fn save_graph_id_map(app_handle: tauri::AppHandle, account_id: String, mailbox: String, data: String) -> Result<(), String> {
    let base_name = cache_base_name(&account_id, &mailbox);
    let dir = vault::root(&app_handle)?
        .join("email_cache")
        .join(&base_name);

    fs::create_dir_all(&dir)
        .map_err(|e| format!("save_graph_id_map: failed to create dir: {}", e))?;

    fs::write(dir.join(GRAPH_ID_MAP_FILE), data.as_bytes())
        .map_err(|e| format!("save_graph_id_map: failed to write: {}", e))?;

    Ok(())
}

#[tauri::command]
fn load_graph_id_map(app_handle: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    let base_name = cache_base_name(&account_id, &mailbox);
    let file = vault::root(&app_handle)?
        .join("email_cache")
        .join(&base_name)
        .join(GRAPH_ID_MAP_FILE);

    if !file.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&file)
        .map_err(|e| format!("load_graph_id_map: failed to read: {}", e))?;

    Ok(Some(data))
}

// ── Email header cache ───────────────────────────────────────────────────

#[tauri::command]
fn load_email_cache(app_handle: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    let base_dir = vault::root(&app_handle)?
        .join("email_cache");

    let base_name = cache_base_name(&account_id, &mailbox);
    let sidecar_dir = base_dir.join(&base_name);
    let meta_file = sidecar_dir.join("_meta.json");

    // Try sidecar format first
    if meta_file.exists() {
        return load_from_sidecars(&sidecar_dir, &meta_file, None);
    }

    // Fall back to old monolithic format
    let old_file = base_dir.join(format!("{}.json", base_name));
    if old_file.exists() {
        info!("Loading from old monolithic cache: {:?}", old_file);
        let data = fs::read_to_string(&old_file)
            .map_err(|e| format!("Failed to read cache file: {}", e))?;
        return Ok(Some(data));
    }

    Ok(None)
}

/// Load only the N most recent emails from sidecar cache (fast initial display)
#[tauri::command]
async fn load_email_cache_partial(app_handle: tauri::AppHandle, account_id: String, mailbox: String, limit: usize) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let base_dir = vault::root(&app_handle)?
            .join("email_cache");

        let base_name = cache_base_name(&account_id, &mailbox);
        let sidecar_dir = base_dir.join(&base_name);
        let meta_file = sidecar_dir.join("_meta.json");

        // Try sidecar format first
        if meta_file.exists() {
            return load_from_sidecars(&sidecar_dir, &meta_file, Some(limit));
        }

        // Fall back to old monolithic format (parse and truncate in memory)
        let old_file = base_dir.join(format!("{}.json", base_name));
        if old_file.exists() {
            info!("Partial load falling back to monolithic: {:?}", old_file);
            let data = fs::read_to_string(&old_file)
                .map_err(|e| format!("Failed to read cache file: {}", e))?;
            let mut parsed: serde_json::Value = serde_json::from_str(&data)
                .map_err(|e| format!("Failed to parse cache JSON: {}", e))?;

            let total_cached = parsed.get("emails")
                .and_then(|e| e.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            if let Some(emails) = parsed.get_mut("emails").and_then(|e| e.as_array_mut()) {
                if emails.len() > limit {
                    emails.truncate(limit);
                }
            }
            parsed.as_object_mut().map(|o| o.insert("totalCached".to_string(), serde_json::json!(total_cached)));

            let result = serde_json::to_string(&parsed)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            return Ok(Some(result));
        }

        Ok(None)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// Load email headers from sidecar cache for specific UIDs only.
/// Much faster than parsing .eml files — reads pre-cached JSON sidecars.
#[tauri::command]
async fn load_email_cache_by_uids(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        let base_dir = vault::root(&app_handle)?
            .join("email_cache");

        let base_name = cache_base_name(&account_id, &mailbox);
        let sidecar_dir = base_dir.join(&base_name);

        if !sidecar_dir.exists() {
            info!("load_email_cache_by_uids: sidecar dir does not exist");
            return Ok(Vec::new());
        }

        let mut emails: Vec<serde_json::Value> = Vec::with_capacity(uids.len());
        let mut found = 0usize;
        for uid in &uids {
            let file_path = sidecar_dir.join(format!("{}.json", uid));
            if let Ok(data) = fs::read_to_string(&file_path) {
                if let Ok(email) = serde_json::from_str(&data) {
                    emails.push(email);
                    found += 1;
                }
            }
        }

        info!("load_email_cache_by_uids: found {}/{} UIDs in sidecar cache", found, uids.len());
        Ok(emails)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// List the UIDs a mailbox has sidecars for, plus which of them were written
/// after `since_ms`.
///
/// Readdir only — no file is opened and nothing is parsed, so this costs one
/// directory scan regardless of mailbox size. That's what lets a caller holding
/// a stale in-memory header set re-read only the handful of messages that moved
/// instead of all 15,000 (`load_from_sidecars` is one read + one parse PER
/// message).
#[tauri::command]
async fn list_cached_uids(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    since_ms: Option<f64>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let base_dir = vault::root(&app_handle)?
            .join("email_cache");

        let sidecar_dir = base_dir.join(cache_base_name(&account_id, &mailbox));
        if !sidecar_dir.exists() {
            return Ok(serde_json::json!({ "uids": [], "changed": [] }));
        }

        let mut uids: Vec<u64> = Vec::new();
        let mut changed: Vec<u64> = Vec::new();

        if let Ok(entries) = fs::read_dir(&sidecar_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "_meta.json" { continue; }
                let Some(uid) = name.strip_suffix(".json").and_then(|s| s.parse::<u64>().ok())
                else { continue };
                uids.push(uid);

                // `DirEntry::metadata` is a stat the readdir usually already
                // primed — cheap next to opening the file.
                if let Some(since) = since_ms {
                    let mtime_ms = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as f64);
                    // Unreadable mtime counts as changed — an extra read is
                    // always safer than serving a header we can't vouch for.
                    if mtime_ms.map_or(true, |m| m > since) {
                        changed.push(uid);
                    }
                }
            }
        }

        info!(
            "list_cached_uids: {} sidecars, {} changed since {:?}",
            uids.len(), changed.len(), since_ms
        );
        Ok(serde_json::json!({ "uids": uids, "changed": changed }))
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// Read and parse the named sidecars, skipping any that are missing or corrupt.
fn read_sidecars(sidecar_dir: &Path, uids: &[u64]) -> Vec<serde_json::Value> {
    let mut emails = Vec::with_capacity(uids.len());
    for uid in uids {
        let file_path = sidecar_dir.join(format!("{}.json", uid));
        if let Ok(data) = fs::read_to_string(&file_path) {
            if let Ok(email) = serde_json::from_str(&data) {
                emails.push(email);
            }
        }
    }
    emails
}

/// A cached header's received time in epoch milliseconds, or `i64::MIN` when it
/// carries no date we can parse. Undated rows sort last: a header we can't place
/// in time must never displace one we can.
fn header_date_ms(email: &serde_json::Value) -> i64 {
    ["internalDate", "date"]
        .iter()
        .filter_map(|key| email.get(*key).and_then(|v| v.as_str()))
        .find_map(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .or_else(|_| chrono::DateTime::parse_from_rfc2822(s))
                .map(|d| d.timestamp_millis())
                .ok()
        })
        .unwrap_or(i64::MIN)
}

fn header_uid(email: &serde_json::Value) -> u64 {
    email.get("uid").and_then(|u| u.as_u64()).unwrap_or(0)
}

/// Read `limit` sidecars' worth of the newest cached headers, or all of them
/// when `limit` is None.
///
/// "Newest" is the N highest UIDs for IMAP, where the server issues UIDs in
/// arrival order — the readdir alone picks them, and no file is opened that
/// isn't returned.
///
/// Graph offers no such guarantee, so those mailboxes are ordered by the header
/// date instead. Its listing is `receivedDateTime desc`, so the seed handed uid
/// 1 to the NEWEST message and counted upward into the past; messages that
/// arrive after the seed then take the highest numbers of all. UID order there
/// runs descending by date and then ascending, which is not an order at all —
/// sorting by it served up the OLDEST cached messages. `graph_id_map.json` is
/// the marker: it is written by the same allocator that hands out those uids,
/// so it exists for exactly the mailboxes whose uids can't be trusted to sort.
///
/// ponytail: the date path reads every sidecar, not `limit` of them — one read
/// per cached message on a Graph mailbox. If that shows up on the startup path,
/// index uid → date in `_meta.json` on write and sort from that instead.
fn load_from_sidecars(sidecar_dir: &Path, meta_file: &Path, limit: Option<usize>) -> Result<Option<String>, String> {
    // Read metadata
    let meta_data = fs::read_to_string(meta_file)
        .map_err(|e| format!("Failed to read _meta.json: {}", e))?;
    let meta: serde_json::Value = serde_json::from_str(&meta_data)
        .map_err(|e| format!("Failed to parse _meta.json: {}", e))?;

    // List all UID files, parse UIDs as numbers for sorting
    let mut uids: Vec<u64> = Vec::new();
    if let Ok(entries) = fs::read_dir(sidecar_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "_meta.json" { continue; }
            if let Some(uid_str) = name.strip_suffix(".json") {
                if let Ok(uid) = uid_str.parse::<u64>() {
                    uids.push(uid);
                }
            }
        }
    }

    let total_cached = uids.len();
    let uid_tracks_arrival = !sidecar_dir.join(GRAPH_ID_MAP_FILE).exists();

    let emails: Vec<serde_json::Value> = if uid_tracks_arrival {
        // Highest UIDs are the newest — pick them off the readdir, then read
        // only those files.
        uids.sort_unstable_by(|a, b| b.cmp(a));
        if let Some(limit) = limit {
            uids.truncate(limit);
        }
        read_sidecars(sidecar_dir, &uids)
    } else {
        // UID says nothing about age here, so every header has to be read
        // before the newest can be named. Ties break on UID only to keep the
        // result stable across filesystems — same-second arrivals have no
        // meaningful order.
        let mut all = read_sidecars(sidecar_dir, &uids);
        all.sort_by(|a, b| {
            header_date_ms(b)
                .cmp(&header_date_ms(a))
                .then_with(|| header_uid(b).cmp(&header_uid(a)))
        });
        if let Some(limit) = limit {
            all.truncate(limit);
        }
        all
    };

    info!(
        "Sidecar cache loaded: {} of {} emails (limit: {:?}, order: {})",
        emails.len(), total_cached, limit,
        if uid_tracks_arrival { "uid" } else { "date" }
    );

    // Build response in the same format as the old monolithic cache
    let result = serde_json::json!({
        "emails": emails,
        "totalEmails": meta.get("totalEmails"),
        "totalCached": total_cached,
        "uidValidity": meta.get("uidValidity"),
        "uidNext": meta.get("uidNext"),
        // Was omitted, so getEmailHeadersPartial().highestModseq always read null —
        // any caller trusting it would silently lose the CONDSTORE fast path.
        "highestModseq": meta.get("highestModseq"),
        "lastSynced": meta.get("lastSynced")
    });

    serde_json::to_string(&result)
        .map(|s| Some(s))
        .map_err(|e| format!("Failed to serialize sidecar cache: {}", e))
}

/// Load only cache metadata (no emails) — fast, for delta-sync parameters
#[tauri::command]
fn load_email_cache_meta(app_handle: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    let base_dir = vault::root(&app_handle)?
        .join("email_cache");

    let base_name = cache_base_name(&account_id, &mailbox);
    let sidecar_dir = base_dir.join(&base_name);
    let meta_file = sidecar_dir.join("_meta.json");

    // Try sidecar format
    if meta_file.exists() {
        let meta_data = fs::read_to_string(&meta_file)
            .map_err(|e| format!("Failed to read _meta.json: {}", e))?;
        let mut meta: serde_json::Value = serde_json::from_str(&meta_data)
            .map_err(|e| format!("Failed to parse _meta.json: {}", e))?;

        // Count message sidecars only. `_meta.json` and `graph_id_map.json` sit
        // in the same directory and are not messages; counting them reported a
        // mailbox with nothing cached as holding one.
        let total_cached = fs::read_dir(&sidecar_dir)
            .map(|entries| entries.flatten().filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.strip_suffix(".json").is_some_and(|s| s.parse::<u64>().is_ok())
            }).count())
            .unwrap_or(0);

        meta.as_object_mut().map(|o| o.insert("totalCached".to_string(), serde_json::json!(total_cached)));

        return serde_json::to_string(&meta)
            .map(|s| Some(s))
            .map_err(|e| format!("Failed to serialize: {}", e));
    }

    // Fall back to old monolithic format — parse only metadata
    let old_file = base_dir.join(format!("{}.json", base_name));
    if old_file.exists() {
        let data = fs::read_to_string(&old_file)
            .map_err(|e| format!("Failed to read cache file: {}", e))?;
        let parsed: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse cache JSON: {}", e))?;
        let total_cached = parsed.get("emails").and_then(|e| e.as_array()).map(|a| a.len()).unwrap_or(0);
        let meta = serde_json::json!({
            "totalEmails": parsed.get("totalEmails"),
            "uidValidity": parsed.get("uidValidity"),
            "uidNext": parsed.get("uidNext"),
            "highestModseq": parsed.get("highestModseq"),
            "lastSynced": parsed.get("lastSynced"),
            "totalCached": total_cached
        });
        return serde_json::to_string(&meta)
            .map(|s| Some(s))
            .map_err(|e| format!("Failed to serialize: {}", e));
    }

    Ok(None)
}

// ── Pending server deletes ──────────────────────────────────────────────────
//
// The journal lives in app_data_dir, NOT vault::root: the vault is relocatable
// and can be an external volume that is absent at launch, which is exactly when
// the replay needs to read this.

fn pending_delete_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))
}

#[tauri::command]
fn pending_delete_queue(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    let dir = pending_delete_dir(&app_handle)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data directory: {}", e))?;
    pending_delete::queue(&dir, &account_id, &mailbox, &uids)
}

#[tauri::command]
fn pending_delete_clear(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    pending_delete::clear(&pending_delete_dir(&app_handle)?, &account_id, &mailbox, &uids)
}

/// Everything still owed a server delete, as `[{accountId, mailbox, uids}]`.
#[tauri::command]
fn pending_delete_read(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let entries = pending_delete::entries(&pending_delete_dir(&app_handle)?)
        .into_iter()
        .map(|(account_id, mailbox, uids)| {
            serde_json::json!({ "accountId": account_id, "mailbox": mailbox, "uids": uids })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::Value::Array(entries))
}

#[tauri::command]
fn clear_email_cache(app_handle: tauri::AppHandle, account_id: Option<String>, mailbox: Option<String>) -> Result<(), String> {
    let cache_dir = vault::root(&app_handle)?
        .join("email_cache");

    if !cache_dir.exists() {
        return Ok(());
    }

    // Single mailbox — used when UIDVALIDITY changes and every cached UID in
    // that mailbox now refers to a different message.
    if let (Some(account_id), Some(mailbox)) = (account_id.as_ref(), mailbox.as_ref()) {
        let dir = cache_dir.join(cache_base_name(account_id, mailbox));
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Failed to clear mailbox cache: {}", e))?;
            info!("Cleared cache for {}/{}", account_id, mailbox);
        }
        return Ok(());
    }

    if let Some(account_id) = account_id {
        // Clear cache for specific account (both sidecar dirs and old monolithic files)
        let prefix = account_id.replace(|c: char| !c.is_alphanumeric(), "_");
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) {
                    let path = entry.path();
                    if path.is_dir() {
                        let _ = fs::remove_dir_all(&path);
                    } else {
                        let _ = fs::remove_file(&path);
                    }
                    info!("Removed cache entry: {:?}", path);
                }
            }
        }
    } else {
        // Clear all cache
        let _ = fs::remove_dir_all(&cache_dir);
        info!("Cleared all email cache");
    }

    Ok(())
}

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

fn get_unique_path(dir: &Path, filename: &str) -> PathBuf {
    let path = dir.join(filename);
    if !path.exists() {
        return path;
    }

    let stem = Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string());
    let ext = Path::new(filename)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let mut counter = 1u32;
    loop {
        let candidate = dir.join(format!("{} ({}){}", stem, counter, ext));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

#[tauri::command]
fn save_attachment(
    app_handle: tauri::AppHandle,
    filename: String,
    content_base64: String,
    account: Option<String>,
    folder: Option<String>,
) -> Result<String, String> {
    use base64::Engine;

    info!("save_attachment called for: {}", filename);

    let cache_dir = vault::root(&app_handle)?
        .join("attachment_cache");

    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create attachment cache dir: {}", e))?;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // Build a smart cache filename: {account}_{folder}_{filename}
    let safe = |s: &str| s.replace(|c: char| !c.is_alphanumeric() && c != '.' && c != '-', "_");
    let prefix = match (account.as_deref(), folder.as_deref()) {
        (Some(a), Some(f)) => format!("{}_{}_", safe(a), safe(f)),
        (Some(a), None) => format!("{}_", safe(a)),
        _ => String::new(),
    };
    let cache_name = format!("{}{}", prefix, filename);

    let dest = get_unique_path(&cache_dir, &cache_name);

    fs::write(&dest, &decoded)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    let path_str = dest.to_string_lossy().to_string();
    info!("Attachment saved to cache: {}", path_str);
    Ok(path_str)
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

// ==========================================
// Maildir .eml storage commands
// ==========================================

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MaildirAddress {
    name: Option<String>,
    address: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MaildirAttachment {
    filename: Option<String>,
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(rename = "contentDisposition")]
    content_disposition: Option<String>,
    size: usize,
    #[serde(rename = "contentId")]
    content_id: Option<String>,
    content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LightAttachment {
    filename: Option<String>,
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(rename = "contentDisposition")]
    content_disposition: Option<String>,
    size: usize,
    #[serde(rename = "contentId")]
    content_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ParsedEmail {
    uid: u32,
    #[serde(rename = "messageId")]
    message_id: Option<String>,
    subject: String,
    from: MaildirAddress,
    to: Vec<MaildirAddress>,
    cc: Vec<MaildirAddress>,
    bcc: Vec<MaildirAddress>,
    #[serde(rename = "replyTo")]
    reply_to: Vec<MaildirAddress>,
    date: Option<String>,
    flags: Vec<String>,
    text: Option<String>,
    html: Option<String>,
    attachments: Vec<MaildirAttachment>,
    #[serde(rename = "rawSource")]
    raw_source: String,
    #[serde(rename = "hasAttachments")]
    has_attachments: bool,
    #[serde(rename = "isArchived")]
    is_archived: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LightEmail {
    uid: u32,
    #[serde(rename = "messageId")]
    message_id: Option<String>,
    subject: String,
    from: MaildirAddress,
    to: Vec<MaildirAddress>,
    cc: Vec<MaildirAddress>,
    bcc: Vec<MaildirAddress>,
    #[serde(rename = "replyTo")]
    reply_to: Vec<MaildirAddress>,
    date: Option<String>,
    flags: Vec<String>,
    text: Option<String>,
    html: Option<String>,
    attachments: Vec<LightAttachment>,
    #[serde(rename = "hasAttachments")]
    has_attachments: bool,
    #[serde(rename = "isArchived")]
    is_archived: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct MaildirEmailSummary {
    uid: u32,
    flags: Vec<String>,
    #[serde(rename = "isArchived")]
    is_archived: bool,
    size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct MaildirStorageStats {
    #[serde(rename = "totalBytes")]
    total_bytes: u64,
    #[serde(rename = "totalMB")]
    total_mb: f64,
    #[serde(rename = "emailCount")]
    email_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct MaildirClearCacheResult {
    #[serde(rename = "deletedCount")]
    deleted_count: u32,
    #[serde(rename = "skippedArchived")]
    skipped_archived: u32,
}

// ── Mail storage location ───────────────────────────────────────────────────

#[tauri::command]
fn vault_get_status(app_handle: tauri::AppHandle) -> vault::VaultStatus {
    vault::status(&app_handle)
}

#[tauri::command]
fn vault_inspect_folder(app_handle: tauri::AppHandle, path: String) -> Result<vault::FolderInspection, String> {
    vault::inspect_folder(&app_handle, &path)
}

/// Point the app at a folder that already holds the mail (drive reconnected at
/// a new path, or the folder was moved by hand).
#[tauri::command]
fn vault_adopt(app_handle: tauri::AppHandle, path: String) -> Result<vault::VaultStatus, String> {
    let status = vault::adopt(&app_handle, &path)?;
    // The daemon reads the storage location once at startup — restart it so it
    // does not keep syncing into the old folder.
    shutdown_daemon_child();
    let _ = app_handle.emit("vault-status", status.clone());
    Ok(status)
}

/// Copy the mail data to `path`, verify it, delete the originals, switch over.
#[tauri::command]
async fn vault_move_to(app_handle: tauri::AppHandle, path: String) -> Result<vault::MoveResult, String> {
    let handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        let emitter = handle.clone();
        vault::move_to(&handle, &path, move |p| {
            let _ = emitter.emit("vault-move-progress", p);
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    shutdown_daemon_child();
    let _ = app_handle.emit("vault-status", vault::status(&app_handle));
    result
}

/// Bring the mail back into the app data dir, then stop using the custom folder.
#[tauri::command]
async fn vault_move_to_default(app_handle: tauri::AppHandle) -> Result<vault::MoveResult, String> {
    let handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        let emitter = handle.clone();
        vault::move_to_default(&handle, move |p| {
            let _ = emitter.emit("vault-move-progress", p);
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    shutdown_daemon_child();
    let _ = app_handle.emit("vault-status", vault::status(&app_handle));
    result
}

/// Go back to storing mail in the app data dir. Does not move anything.
#[tauri::command]
fn vault_reset(app_handle: tauri::AppHandle) -> Result<vault::VaultStatus, String> {
    let status = vault::reset(&app_handle)?;
    shutdown_daemon_child();
    let _ = app_handle.emit("vault-status", status.clone());
    Ok(status)
}

pub fn maildir_cur_path(app_handle: &tauri::AppHandle, account_id: &str, mailbox: &str) -> Result<PathBuf, String> {
    let safe_mailbox = mailbox.chars().map(|c| {
        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }
    }).collect::<String>();
    let base = vault::root(app_handle)?;
    Ok(base.join("Maildir").join(account_id).join(&safe_mailbox).join("cur"))
}

/// The flags a vault file name carries, as the Maildir words AND as the IMAP
/// names — `seen` and `\Seen` both, for a file named `12:2,AS`.
///
/// Every row in the app asks `flags.includes('\Seen')`; a row built from its
/// .eml used to get the words alone and render unread whatever the file said.
/// The words stay, because `build_maildir_filename` and the archived checks
/// read them; the names are what the rest of the app reads.
pub(crate) fn parse_flags_from_filename(filename: &str) -> Vec<String> {
    let Some(flags_part) = filename.split(":2,").nth(1) else { return Vec::new() };
    let mut flags = Vec::new();
    for c in flags_part.chars() {
        match c {
            'A' => flags.push("archived".to_string()),
            'D' => flags.push("draft".to_string()),
            'F' => flags.push("flagged".to_string()),
            'R' => flags.push("replied".to_string()),
            'S' => flags.push("seen".to_string()),
            'T' => flags.push("trashed".to_string()),
            _ => {}
        }
    }
    for (word, name) in [("seen", "\\Seen"), ("flagged", "\\Flagged"), ("replied", "\\Answered")] {
        if flags.iter().any(|f| f == word) {
            flags.push(name.to_string());
        }
    }
    flags
}

pub fn build_maildir_filename(uid: u32, flags: &[String]) -> String {
    let mut flag_chars: Vec<char> = Vec::new();
    for f in flags {
        match f.to_lowercase().as_str() {
            "archived" | "a" => flag_chars.push('A'),
            "draft" | "d" => flag_chars.push('D'),
            "flagged" | "f" => flag_chars.push('F'),
            "replied" | "r" => flag_chars.push('R'),
            "seen" | "s" => flag_chars.push('S'),
            "trashed" | "t" => flag_chars.push('T'),
            _ => {}
        }
    }
    flag_chars.sort();
    flag_chars.dedup();
    let flag_str: String = flag_chars.into_iter().collect();
    format!("{}:2,{}", uid, flag_str)
}

/// Find a message file for `uid` in a directory that may use either naming
/// scheme: Maildir (`<uid>:2,<flags>[.eml]`) or the legacy flagless external
/// backup name (`<uid>.eml`). Used for the external backup location, which
/// holds both after the flag-preserving rename.
pub fn find_msg_file_by_uid(dir: &Path, uid: u32) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let head = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or("");
        if head.parse::<u32>().ok() == Some(uid) {
            return Some(entry.path());
        }
    }
    None
}

pub fn find_file_by_uid(dir: &Path, uid: u32) -> Option<PathBuf> {
    let prefix = format!("{}:", uid);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Delete every Maildir file in `cur_dir` whose uid is in `uids`.
/// One directory pass — the per-uid `find_file_by_uid` rescans the whole
/// directory each call, which is quadratic over a bulk selection.
/// Vault filenames are always `<uid>:<flags>` (see `build_maildir_filename`),
/// so the uid is the run of digits before the first ':'.
pub fn delete_maildir_files(cur_dir: &Path, uids: &std::collections::HashSet<u32>) -> usize {
    let mut removed = 0usize;
    if let Ok(entries) = fs::read_dir(cur_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let uid = match name.split(':').next().and_then(|s| s.parse::<u32>().ok()) {
                Some(u) => u,
                None => continue,
            };
            if !uids.contains(&uid) {
                continue;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(e) => warn!("maildir purge: failed to remove {:?}: {}", entry.path(), e),
            }
        }
    }
    removed
}

/// Drop `uids` from a mailbox's `local-index.json` in a single read-modify-write.
/// A missing index is not an error — nothing was ever indexed.
pub fn prune_local_index(
    index_path: &Path,
    uids: &std::collections::HashSet<u32>,
) -> Result<(), String> {
    if !index_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(index_path)
        .map_err(|e| format!("Failed to read local index: {}", e))?;
    let mut entries: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();
    entries.retain(|e| {
        e.get("uid")
            .and_then(|u| u.as_u64())
            .map(|u| !uids.contains(&(u as u32)))
            .unwrap_or(true)
    });
    let data = serde_json::to_string(&entries)
        .map_err(|e| format!("Failed to serialize local index: {}", e))?;
    fs::write(index_path, &data).map_err(|e| format!("Failed to write local index: {}", e))
}

fn parse_address_str(header_value: &str) -> Vec<MaildirAddress> {
    match mailparse::addrparse(header_value) {
        Ok(addrs) => {
            addrs.iter().flat_map(|a| match a {
                mailparse::MailAddr::Single(info) => {
                    vec![MaildirAddress {
                        name: info.display_name.clone(),
                        address: info.addr.clone(),
                    }]
                }
                mailparse::MailAddr::Group(group) => {
                    group.addrs.iter().map(|info| MaildirAddress {
                        name: info.display_name.clone(),
                        address: info.addr.clone(),
                    }).collect()
                }
            }).collect()
        }
        Err(_) => {
            if !header_value.trim().is_empty() {
                vec![MaildirAddress { name: None, address: header_value.trim().to_string() }]
            } else {
                Vec::new()
            }
        }
    }
}

fn walk_mime_parts(
    part: &mailparse::ParsedMail,
    text_body: &mut Option<String>,
    html_body: &mut Option<String>,
    attachments: &mut Vec<MaildirAttachment>,
) {
    let content_type = part.ctype.mimetype.to_lowercase();

    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            walk_mime_parts(sub, text_body, html_body, attachments);
        }
        return;
    }

    // Leaf part
    let disposition = part.get_content_disposition();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !content_type.starts_with("text/");

    if is_attachment || is_inline_non_text {
        if let Ok(body) = part.get_body_raw() {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
            let filename = disposition.params.get("filename")
                .or_else(|| part.ctype.params.get("name"))
                .cloned();
            let content_id = part.headers.iter()
                .find(|h| h.get_key().eq_ignore_ascii_case("Content-ID"))
                .map(|h| h.get_value());

            attachments.push(MaildirAttachment {
                filename,
                content_type: content_type.clone(),
                content_disposition: Some(format!("{:?}", disposition.disposition)),
                size: body.len(),
                content_id,
                content: b64,
            });
        }
    } else if content_type == "text/plain" && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type == "text/html" && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
}

fn walk_mime_parts_light(
    part: &mailparse::ParsedMail,
    text_body: &mut Option<String>,
    html_body: &mut Option<String>,
    attachments: &mut Vec<LightAttachment>,
) {
    let content_type = part.ctype.mimetype.to_lowercase();

    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            walk_mime_parts_light(sub, text_body, html_body, attachments);
        }
        return;
    }

    let disposition = part.get_content_disposition();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !content_type.starts_with("text/");

    if is_attachment || is_inline_non_text {
        let size = part.get_body_raw().map(|b| b.len()).unwrap_or(0);
        let filename = disposition.params.get("filename")
            .or_else(|| part.ctype.params.get("name"))
            .cloned();
        let content_id = part.headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("Content-ID"))
            .map(|h| h.get_value());

        attachments.push(LightAttachment {
            filename,
            content_type: content_type.clone(),
            content_disposition: Some(format!("{:?}", disposition.disposition)),
            size,
            content_id,
        });
    } else if content_type == "text/plain" && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type == "text/html" && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
}

fn collect_attachment_parts<'a>(
    part: &'a mailparse::ParsedMail<'a>,
    out: &mut Vec<&'a mailparse::ParsedMail<'a>>,
) {
    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            collect_attachment_parts(sub, out);
        }
        return;
    }
    let disposition = part.get_content_disposition();
    let ct = part.ctype.mimetype.to_lowercase();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !ct.starts_with("text/");
    if is_attachment || is_inline_non_text {
        out.push(part);
    }
}

/// Check if any attachment is a "real" attachment (not an inline embedded image
/// or tracking pixel). Mirrors the JS-side `hasRealAttachments` logic.
fn is_real_attachment(
    content_type: &str,
    content_id: &Option<String>,
    filename: &Option<String>,
    size: usize,
    html: Option<&str>,
) -> bool {
    let ct = content_type.to_lowercase();
    // Non-image types are always real attachments
    if !ct.starts_with("image/") {
        return true;
    }
    // Inline image with Content-ID referenced in the HTML body → embedded, not real
    if let Some(ref cid) = content_id {
        if let Some(html_body) = html {
            let bare_cid = cid.trim_start_matches('<').trim_end_matches('>');
            if html_body.contains(&format!("cid:{}", bare_cid)) {
                return false;
            }
        }
    }
    // Tiny unnamed image → tracking pixel
    if filename.is_none() && size < 5000 {
        return false;
    }
    true
}

fn has_real_attachments(attachments: &[LightAttachment], html: Option<&str>) -> bool {
    attachments.iter().any(|att| {
        is_real_attachment(&att.content_type, &att.content_id, &att.filename, att.size, html)
    })
}

fn has_real_attachments_full(attachments: &[MaildirAttachment], html: Option<&str>) -> bool {
    attachments.iter().any(|att| {
        is_real_attachment(&att.content_type, &att.content_id, &att.filename, att.size, html)
    })
}

pub fn parse_eml_bytes_light(raw: &[u8], uid: u32, flags: Vec<String>) -> Result<LightEmail, String> {
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let get_header = |name: &str| -> Option<String> {
        headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };

    let subject = get_header("Subject").unwrap_or_else(|| "(No Subject)".to_string());
    let message_id = get_header("Message-ID");
    let date = get_header("Date");

    let from_str = get_header("From").unwrap_or_default();
    let from_addrs = parse_address_str(&from_str);
    let from = from_addrs.into_iter().next().unwrap_or(MaildirAddress {
        name: Some("Unknown".to_string()),
        address: "unknown@unknown.com".to_string(),
    });

    let to = get_header("To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let cc = get_header("Cc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let bcc = get_header("Bcc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let reply_to = get_header("Reply-To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();

    let mut text_body: Option<String> = None;
    let mut html_body: Option<String> = None;
    let mut attachments: Vec<LightAttachment> = Vec::new();

    walk_mime_parts_light(&parsed, &mut text_body, &mut html_body, &mut attachments);

    let is_archived = flags.iter().any(|f| f == "archived");
    let has_attachments = has_real_attachments(&attachments, html_body.as_deref());

    Ok(LightEmail {
        uid,
        message_id,
        subject,
        from,
        to,
        cc,
        bcc,
        reply_to,
        date,
        flags,
        text: text_body,
        html: html_body,
        attachments,
        has_attachments,
        is_archived,
    })
}

fn parse_eml_bytes(raw: &[u8], uid: u32, flags: Vec<String>) -> Result<ParsedEmail, String> {
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let get_header = |name: &str| -> Option<String> {
        headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };

    let subject = get_header("Subject").unwrap_or_else(|| "(No Subject)".to_string());
    let message_id = get_header("Message-ID");
    let date = get_header("Date");

    let from_str = get_header("From").unwrap_or_default();
    let from_addrs = parse_address_str(&from_str);
    let from = from_addrs.into_iter().next().unwrap_or(MaildirAddress {
        name: Some("Unknown".to_string()),
        address: "unknown@unknown.com".to_string(),
    });

    let to = get_header("To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let cc = get_header("Cc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let bcc = get_header("Bcc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let reply_to = get_header("Reply-To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();

    let mut text_body: Option<String> = None;
    let mut html_body: Option<String> = None;
    let mut attachments: Vec<MaildirAttachment> = Vec::new();

    walk_mime_parts(&parsed, &mut text_body, &mut html_body, &mut attachments);

    let is_archived = flags.iter().any(|f| f == "archived");
    let has_attachments = has_real_attachments_full(&attachments, html_body.as_deref());

    use base64::Engine;
    let raw_source = base64::engine::general_purpose::STANDARD.encode(raw);

    Ok(ParsedEmail {
        uid,
        message_id,
        subject,
        from,
        to,
        cc,
        bcc,
        reply_to,
        date,
        flags,
        text: text_body,
        html: html_body,
        attachments,
        raw_source,
        has_attachments,
        is_archived,
    })
}

/// Store an .eml file to Maildir — callable from commands.rs
/// Only writes if the file doesn't already exist for this UID.
pub fn maildir_store_raw(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    raw_source_base64: &str,
    flags: &[String],
) -> Result<(), String> {
    use base64::Engine;

    let cur_dir = maildir_cur_path(app_handle, account_id, mailbox)?;
    fs::create_dir_all(&cur_dir)
        .map_err(|e| format!("Failed to create Maildir directory: {}", e))?;

    // Skip if already cached on disk
    if find_file_by_uid(&cur_dir, uid).is_some() {
        return Ok(());
    }

    let filename = build_maildir_filename(uid, flags);
    let file_path = cur_dir.join(&filename);

    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_source_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    fs::write(&file_path, &raw_bytes)
        .map_err(|e| format!("Failed to write .eml file: {}", e))?;

    info!("Stored email UID {} to {:?} ({} bytes)", uid, file_path, raw_bytes.len());
    Ok(())
}

#[tauri::command]
fn maildir_store(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
    raw_source_base64: String,
    flags: Vec<String>,
) -> Result<(), String> {
    use base64::Engine;

    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    fs::create_dir_all(&cur_dir)
        .map_err(|e| format!("Failed to create Maildir directory: {}", e))?;

    // Remove existing file for this UID if any (maildir_store always overwrites)
    if let Some(existing) = find_file_by_uid(&cur_dir, uid) {
        let _ = fs::remove_file(&existing);
    }

    let filename = build_maildir_filename(uid, &flags);
    let file_path = cur_dir.join(&filename);

    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(&raw_source_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    fs::write(&file_path, &raw_bytes)
        .map_err(|e| format!("Failed to write .eml file: {}", e))?;

    info!("Stored email UID {} to {:?} ({} bytes)", uid, file_path, raw_bytes.len());
    Ok(())
}

// ── Local index (local-index.json) ──────────────────────────────────────────

pub(crate) fn local_index_path(app_handle: &tauri::AppHandle, account_id: &str, mailbox: &str) -> Result<PathBuf, String> {
    Ok(vault::root(app_handle)?.join("maildir").join(account_id).join(mailbox).join("local-index.json"))
}

#[tauri::command]
async fn local_index_read(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
) -> Result<Option<String>, String> {
    let data_dir = vault::root(&app_handle)?;
    let index_path = data_dir.join("maildir").join(&account_id).join(&mailbox).join("local-index.json");

    if !index_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&index_path).await
        .map_err(|e| format!("Failed to read local-index.json: {}", e))?;
    Ok(Some(content))
}

#[tauri::command]
async fn local_index_append(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    entries_json: String,
) -> Result<(), String> {
    let data_dir = vault::root(&app_handle)?;
    let dir_path = data_dir.join("maildir").join(&account_id).join(&mailbox);
    tokio::fs::create_dir_all(&dir_path).await
        .map_err(|e| format!("Failed to create dir: {}", e))?;
    let index_path = dir_path.join("local-index.json");

    let new_entries: Vec<serde_json::Value> = serde_json::from_str(&entries_json)
        .map_err(|e| format!("Failed to parse entries: {}", e))?;

    let mut existing: Vec<serde_json::Value> = if index_path.exists() {
        let content = tokio::fs::read_to_string(&index_path).await.unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    let new_uids: std::collections::HashSet<u64> = new_entries.iter()
        .filter_map(|e| e.get("uid").and_then(|u| u.as_u64()))
        .collect();
    existing.retain(|e| {
        e.get("uid").and_then(|u| u.as_u64()).map_or(true, |uid| !new_uids.contains(&uid))
    });
    existing.extend(new_entries);

    let tmp_path = index_path.with_extension("json.tmp");
    let data = serde_json::to_string(&existing)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    tokio::fs::write(&tmp_path, &data).await
        .map_err(|e| format!("Failed to write tmp: {}", e))?;
    tokio::fs::rename(&tmp_path, &index_path).await
        .map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn local_index_remove(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<(), String> {
    let index_path = local_index_path(&app_handle, &account_id, &mailbox)?;
    // ponytail: sync fs call in an async command — fine for a small JSON file,
    // same tradeoff maildir_delete_many already makes.
    prune_local_index(&index_path, &std::collections::HashSet::from([uid]))
}

// ── Vault generation (UIDVALIDITY) ──────────────────────────────────────────
//
// See `mailvault_core::maildir`'s generation section for what this repairs and
// why nothing here deletes mail.

/// The mailbox directory — parent of `cur/`, and where `.uidvalidity` and
/// `orphaned/` live. Uses the same sanitized name `maildir_cur_path` does, so
/// the stamp always sits beside the files it describes.
fn maildir_mailbox_path(app_handle: &tauri::AppHandle, account_id: &str, mailbox: &str) -> Result<PathBuf, String> {
    let cur = maildir_cur_path(app_handle, account_id, mailbox)?;
    cur.parent().map(|p| p.to_path_buf())
        .ok_or_else(|| "Maildir path has no parent".to_string())
}

/// Message-ID → uid for the mailbox's *current* generation, read from the
/// sidecar cache the sync engine already maintains.
///
/// The sidecars are the only complete, already-on-disk picture of what the
/// server holds right now; asking the server instead would put a full header
/// fetch in front of every mailbox open. A message the cache hasn't reached is
/// read as absent, which is the safe direction — `orphaned/` keeps the file
/// either way, and the next repair after a fuller sync re-binds it.
fn sidecar_message_id_map(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
) -> (std::collections::HashMap<String, u32>, u64) {
    let mut map = std::collections::HashMap::new();
    let mut sidecars = 0u64;
    let dir = match vault::root(app_handle) {
        Ok(root) => root.join("email_cache").join(cache_base_name(account_id, mailbox)),
        Err(_) => return (map, 0),
    };
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return (map, 0),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // `_meta.json` and anything else that isn't `{uid}.json`.
        let uid: u32 = match name.strip_suffix(".json").and_then(|s| s.parse().ok()) {
            Some(u) => u,
            None => continue,
        };
        sidecars += 1;
        let value: serde_json::Value = match fs::read_to_string(entry.path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(v) => v,
            None => continue,
        };
        // Sidecars written by the frontend carry `messageId`; ones serialized
        // from `EmailHeader` carry `message_id`.
        let raw = value.get("messageId").or_else(|| value.get("message_id"))
            .and_then(|v| v.as_str());
        if let Some(raw) = raw {
            let id = mailvault_core::maildir::normalize_message_id(raw);
            if !id.is_empty() {
                map.insert(id, uid);
            }
        }
    }
    (map, sidecars)
}

/// Uids in this mailbox that the server never issued — messages composed here
/// that live only in the vault (`local_sent`, `local_draft`). A UID reissue
/// says nothing about them, and a repair that moved them aside for "not on the
/// server" would hide the user's own sent mail and drafts.
fn locally_created_uids(index_path: &Path) -> std::collections::HashSet<u32> {
    let mut uids = std::collections::HashSet::new();
    let entries: Vec<serde_json::Value> = fs::read_to_string(index_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for entry in entries {
        let source = entry.get("source").and_then(|v| v.as_str()).unwrap_or("");
        if source == "local_sent" || source == "local_draft" {
            if let Some(uid) = entry.get("uid").and_then(|u| u.as_u64()) {
                uids.insert(uid as u32);
            }
        }
    }
    uids
}

/// Follow a repair through `local-index.json`: rebound uids are rewritten,
/// orphaned ones dropped. A *recovered* file needs no entry — it is back
/// because the server has it, so the list renders it from the server's own
/// headers and reads its archived mark off the file itself.
///
/// Leaving the index alone would keep the rows the list renders pointing at
/// uids whose files just moved — the same "claims a row is archived when the
/// archived thing is a different message" the repair exists to end.
fn remap_local_index(
    index_path: &Path,
    report: &mailvault_core::maildir::GenerationRepair,
) -> Result<(), String> {
    if !index_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(index_path)
        .map_err(|e| format!("Failed to read local index: {}", e))?;
    let mut entries: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();

    let moved: std::collections::HashMap<u64, u64> =
        report.rebound.iter().map(|(o, n)| (*o as u64, *n as u64)).collect();
    let dropped: std::collections::HashSet<u64> =
        report.orphaned.iter().map(|u| *u as u64).collect();

    entries.retain(|e| {
        e.get("uid").and_then(|u| u.as_u64()).map_or(true, |u| !dropped.contains(&u))
    });
    for entry in entries.iter_mut() {
        let uid = entry.get("uid").and_then(|u| u.as_u64());
        if let (Some(uid), Some(obj)) = (uid, entry.as_object_mut()) {
            if let Some(new_uid) = moved.get(&uid) {
                obj.insert("uid".to_string(), serde_json::json!(new_uid));
            }
        }
    }

    let data = serde_json::to_string(&entries)
        .map_err(|e| format!("Failed to serialize local index: {}", e))?;
    let tmp = index_path.with_extension("json.tmp");
    fs::write(&tmp, &data).map_err(|e| format!("Failed to write local index tmp: {}", e))?;
    fs::rename(&tmp, index_path).map_err(|e| format!("Failed to replace local index: {}", e))
}

/// What the sync engine last recorded for this mailbox: the UIDVALIDITY its
/// UIDs belong to, and how many messages the server said it holds.
///
/// Both are `None` for a mailbox that has never synced, and for Graph accounts
/// — which have no IMAP UID space to reissue, so there is nothing here for a
/// repair to do.
fn cached_sync_meta(app_handle: &tauri::AppHandle, account_id: &str, mailbox: &str) -> (Option<u32>, Option<u64>) {
    let read = || -> Option<serde_json::Value> {
        let path = vault::root(app_handle).ok()?
            .join("email_cache")
            .join(cache_base_name(account_id, mailbox))
            .join("_meta.json");
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    };
    match read() {
        Some(meta) => (
            meta.get("uidValidity").and_then(|v| v.as_u64()).map(|v| v as u32),
            meta.get("totalEmails").and_then(|v| v.as_u64()),
        ),
        None => (None, None),
    }
}

/// Bring a mailbox's vault files onto the server's current UID generation.
///
/// Cheap when there is nothing to do: two small file reads, and the sidecar
/// scan below only runs when they disagree. Safe to call on every mailbox open,
/// which is the point — a reissue has to be caught before anything asks "is uid
/// N archived?", not after the answer has already been believed.
///
/// The generation comes from `_meta.json` rather than an argument so that every
/// caller gets the same answer from the same place; a caller that had to fetch
/// and pass it is a caller that can pass a stale one.
#[tauri::command]
async fn maildir_repair_generation(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
) -> Result<mailvault_core::maildir::GenerationRepair, String> {
    tokio::task::spawn_blocking(move || {
        let (cached_uv, cached_total) = cached_sync_meta(&app_handle, &account_id, &mailbox);
        let uid_validity = match cached_uv {
            Some(uv) => uv,
            // Nothing to compare against. Stamping the vault with a generation
            // we did not verify would be worse than leaving it unstamped: the
            // next repair would trust it.
            None => return Ok(mailvault_core::maildir::GenerationRepair::default()),
        };
        let mailbox_dir = maildir_mailbox_path(&app_handle, &account_id, &mailbox)?;

        // Same check `repair_generation` makes, made again here so the hot path
        // never builds the Message-ID map — that is a read of every sidecar in
        // the mailbox, and this runs on every open.
        if mailvault_core::maildir::read_generation(&mailbox_dir) == Some(uid_validity) {
            return Ok(mailvault_core::maildir::GenerationRepair {
                generation: uid_validity,
                ..Default::default()
            });
        }

        // Moving a file aside says "the server does not have this message". The
        // sidecars are the evidence for that, and a partial cache is not
        // evidence of anything — during a cold start it is empty, and every
        // message in the vault would read as gone. Nothing runs until the cache
        // covers the mailbox; until then the vault stays as it is, which is no
        // worse than before, and `_readVerifiedLocal` still guards what opens.
        let (id_to_uid, sidecars) = sidecar_message_id_map(&app_handle, &account_id, &mailbox);
        let total = cached_total.unwrap_or(0);
        if total == 0 || sidecars < total {
            info!(
                "maildir_repair_generation: {}/{} — cache covers {}/{}, waiting for a fuller sync",
                account_id, mailbox, sidecars, total,
            );
            return Ok(mailvault_core::maildir::GenerationRepair::default());
        }

        let index_path = local_index_path(&app_handle, &account_id, &mailbox)?;
        let protected = locally_created_uids(&index_path);

        let report = mailvault_core::maildir::repair_generation(
            &mailbox_dir, uid_validity, &id_to_uid, &protected,
        );

        if !report.rebound.is_empty() || !report.orphaned.is_empty() {
            if let Err(e) = remap_local_index(&index_path, &report) {
                warn!("maildir_repair_generation: local index remap failed: {}", e);
            }
        }
        Ok(report)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// Count what previous repairs moved out of the uid namespace, for one account
/// or the whole vault.
#[tauri::command]
async fn maildir_orphan_stats(
    app_handle: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<mailvault_core::maildir::OrphanStats, String> {
    tokio::task::spawn_blocking(move || {
        let base = vault::root(&app_handle)?.join("Maildir");
        let mut total = mailvault_core::maildir::OrphanStats::default();
        for mailbox_dir in orphan_mailbox_dirs(&base, account_id.as_deref()) {
            let s = mailvault_core::maildir::orphan_stats(&mailbox_dir);
            total.count += s.count;
            total.bytes += s.bytes;
        }
        Ok(total)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// Delete every orphan folder for one account, or the whole vault.
///
/// These are messages the current server does not have, so this is the one
/// place in the vault where deleting can lose the last copy. Only ever reached
/// from an explicit user action.
#[tauri::command]
async fn maildir_purge_orphans(
    app_handle: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        let base = vault::root(&app_handle)?.join("Maildir");
        let mut removed = 0u64;
        for mailbox_dir in orphan_mailbox_dirs(&base, account_id.as_deref()) {
            match mailvault_core::maildir::purge_orphans(&mailbox_dir) {
                Ok(n) => removed += n,
                Err(e) => warn!("maildir_purge_orphans: {}", e),
            }
        }
        info!("maildir_purge_orphans: removed {} files", removed);
        Ok(removed)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// Every `Maildir/{account}/{mailbox}` directory, scoped to one account when
/// asked. Two levels, not a full walk — the vault below these is large.
fn orphan_mailbox_dirs(base: &Path, account_id: Option<&str>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let accounts: Vec<PathBuf> = match account_id {
        Some(id) => vec![base.join(id)],
        None => fs::read_dir(base)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect(),
    };
    for account_dir in accounts {
        if let Ok(entries) = fs::read_dir(&account_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    dirs.push(entry.path());
                }
            }
        }
    }
    dirs
}

#[tauri::command]
async fn archive_emails(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, archive::ArchiveCancelToken>,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<archive::ArchiveProgress, String> {
    // Reset cancellation flag for this run
    let cancel = {
        // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
        let mut guard = state.0.lock().unwrap();
        let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *guard = std::sync::Arc::clone(&token);
        token
    };

    archive::run(
        app_handle,
        account_id,
        account_json,
        mailbox,
        uids,
        cancel,
    ).await
}

#[tauri::command]
fn cancel_archive(state: tauri::State<'_, archive::ArchiveCancelToken>) -> Result<(), String> {
    // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
    state.0.lock().unwrap().store(true, std::sync::atomic::Ordering::Relaxed);
    info!("cancel_archive: cancellation requested");
    Ok(())
}

// ── Bulk delete emails (concurrent) ─────────────────────────────────────────

#[tauri::command]
async fn bulk_delete_emails(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, archive::ArchiveCancelToken>,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<archive::ArchiveProgress, String> {
    let cancel = {
        // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
        let mut guard = state.0.lock().unwrap();
        let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *guard = std::sync::Arc::clone(&token);
        token
    };

    archive::bulk_delete(
        app_handle, account_id, account_json, mailbox, uids, cancel,
    ).await
}

// ── Verify archived emails on disk ──────────────────────────────────────────

#[tauri::command]
async fn verify_archived_emails(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;

        let mut verified: Vec<u32> = Vec::new();
        let mut missing: Vec<u32> = Vec::new();

        for uid in &uids {
            if find_file_by_uid(&cur_dir, *uid).is_some() {
                verified.push(*uid);
            } else {
                missing.push(*uid);
            }
        }

        info!(
            "verify_archived_emails: {}/{} verified, {} missing",
            verified.len(), uids.len(), missing.len()
        );

        Ok(serde_json::json!({
            "verified": verified,
            "missing": missing,
        }))
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

// ── Pending operation persistence ───────────────────────────────────────────

#[tauri::command]
async fn read_pending_operation(
    app_handle: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let path = app_handle.path().app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?
        .join("pending_operations.json");
    if !path.exists() {
        return Ok(None);
    }
    let data = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read pending_operations.json: {}", e))?;
    let val: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("parse pending_operations.json: {}", e))?;
    Ok(Some(val))
}

#[tauri::command]
async fn save_pending_operation(
    app_handle: tauri::AppHandle,
    operation: serde_json::Value,
) -> Result<(), String> {
    let path = app_handle.path().app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?
        .join("pending_operations.json");
    let json = serde_json::to_string_pretty(&operation)
        .map_err(|e| format!("serialize: {}", e))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("write pending_operations.json: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn clear_pending_operation(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let path = app_handle.path().app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?
        .join("pending_operations.json");
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("remove pending_operations.json: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn maildir_read(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<Option<ParsedEmail>, String> {
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;

    let file_path = match find_file_by_uid(&cur_dir, uid) {
        Some(p) => p,
        None => return Ok(None),
    };

    let filename = file_path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let flags = parse_flags_from_filename(&filename);

    let raw = fs::read(&file_path)
        .map_err(|e| format!("Failed to read .eml file: {}", e))?;

    let email = parse_eml_bytes(&raw, uid, flags)?;
    Ok(Some(email))
}

#[tauri::command]
fn maildir_read_light(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<Option<LightEmail>, String> {
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;

    let file_path = match find_file_by_uid(&cur_dir, uid) {
        Some(p) => p,
        None => return Ok(None),
    };

    let filename = file_path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let flags = parse_flags_from_filename(&filename);

    let raw = fs::read(&file_path)
        .map_err(|e| format!("Failed to read .eml file: {}", e))?;

    let email = parse_eml_bytes_light(&raw, uid, flags)?;
    Ok(Some(email))
}

#[tauri::command]
async fn maildir_read_light_batch(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Vec<Option<LightEmail>>, String> {
    tokio::task::spawn_blocking(move || {
        let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
        let mut results = Vec::with_capacity(uids.len());

        for uid in &uids {
            match find_file_by_uid(&cur_dir, *uid) {
                Some(file_path) => {
                    let filename = file_path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let flags = parse_flags_from_filename(&filename);
                    match fs::read(&file_path) {
                        Ok(raw) => match parse_eml_bytes_light(&raw, *uid, flags) {
                            Ok(email) => results.push(Some(email)),
                            Err(_) => results.push(None),
                        },
                        Err(_) => results.push(None),
                    }
                }
                None => results.push(None),
            }
        }

        Ok(results)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn maildir_read_attachment(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
    attachment_index: usize,
) -> Result<String, String> {
    use base64::Engine;

    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    let file_path = find_file_by_uid(&cur_dir, uid)
        .ok_or_else(|| format!("Email UID {} not found", uid))?;

    let raw = fs::read(&file_path)
        .map_err(|e| format!("Failed to read .eml file: {}", e))?;

    let parsed = mailparse::parse_mail(&raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let mut attach_parts: Vec<&mailparse::ParsedMail> = Vec::new();
    collect_attachment_parts(&parsed, &mut attach_parts);

    let part = attach_parts.get(attachment_index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", attachment_index, attach_parts.len()))?;

    let body = part.get_body_raw()
        .map_err(|e| format!("Failed to get attachment body: {}", e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&body))
}

#[tauri::command]
fn maildir_read_raw_source(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<String, String> {
    use base64::Engine;

    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    let file_path = find_file_by_uid(&cur_dir, uid)
        .ok_or_else(|| format!("Email UID {} not found", uid))?;

    let raw = fs::read(&file_path)
        .map_err(|e| format!("Failed to read .eml file: {}", e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&raw))
}

#[tauri::command]
fn maildir_exists(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<bool, String> {
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    Ok(find_file_by_uid(&cur_dir, uid).is_some())
}

/// Read archived email headers from cache file. Returns empty vec on cache miss.
/// Cache is valid when UID count matches. This is a fast read-only operation.
#[tauri::command]
async fn maildir_read_archived_cached(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    expected_count: u32,
) -> Result<Vec<LightEmail>, String> {
    tokio::task::spawn_blocking(move || {
        let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
        let cache_path = cur_dir.parent()
            .ok_or_else(|| "No parent dir".to_string())?
            .join("archived_headers.json");

        if !cache_path.exists() {
            info!("maildir_read_archived_cached: no cache file, returning empty");
            return Ok(Vec::new());
        }

        let raw = fs::read_to_string(&cache_path)
            .map_err(|e| format!("Failed to read cache: {}", e))?;

        #[derive(Deserialize)]
        struct CacheFile {
            uid_count: usize,
            emails: Vec<LightEmail>,
        }

        match serde_json::from_str::<CacheFile>(&raw) {
            Ok(cached) if cached.uid_count == expected_count as usize => {
                info!("maildir_read_archived_cached: cache hit, {} emails", cached.emails.len());
                Ok(cached.emails)
            }
            Ok(cached) => {
                info!("maildir_read_archived_cached: cache stale ({} vs {})", cached.uid_count, expected_count);
                Ok(Vec::new())
            }
            Err(_) => {
                info!("maildir_read_archived_cached: cache corrupt, returning empty");
                Ok(Vec::new())
            }
        }
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// Save archived email headers to cache file for instant subsequent loads.
/// Called after batch loading completes so the next load is instant.
#[tauri::command]
async fn maildir_save_archived_cache(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    emails: Vec<LightEmail>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
        let cache_path = cur_dir.parent()
            .ok_or_else(|| "No parent dir".to_string())?
            .join("archived_headers.json");

        #[derive(Serialize)]
        struct CacheFile<'a> {
            uid_count: usize,
            emails: &'a [LightEmail],
        }
        let cache = CacheFile { uid_count: emails.len(), emails: &emails };
        let json = serde_json::to_string(&cache)
            .map_err(|e| format!("JSON serialize error: {}", e))?;
        fs::write(&cache_path, json)
            .map_err(|e| format!("Failed to write cache: {}", e))?;
        info!("maildir_save_archived_cache: saved {} emails to cache", emails.len());
        Ok(())
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn maildir_list(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    require_flag: Option<String>,
) -> Result<Vec<MaildirEmailSummary>, String> {
    let rf_clone = require_flag.clone();
    tokio::task::spawn_blocking(move || {
        let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;

        if !cur_dir.exists() {
            info!("maildir_list: cur_dir does not exist: {:?} (require_flag={:?})", cur_dir, rf_clone);
            return Ok(Vec::new());
        }

        let entries = fs::read_dir(&cur_dir)
            .map_err(|e| format!("Failed to read Maildir: {}", e))?;

        let mut results = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            let uid: u32 = match name.split(':').next().and_then(|s| s.parse().ok()) {
                Some(u) => u,
                None => continue,
            };

            let flags = parse_flags_from_filename(&name);
            let is_archived = flags.iter().any(|f| f == "archived");

            if let Some(ref required) = &require_flag {
                if !flags.iter().any(|f| f == required) {
                    continue;
                }
            }

            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

            results.push(MaildirEmailSummary {
                uid,
                flags,
                is_archived,
                size,
            });
        }

        if rf_clone.is_some() {
            info!("maildir_list: require_flag={:?}, found {} results", rf_clone, results.len());
        }
        Ok(results)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn maildir_delete(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
) -> Result<(), String> {
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    if let Some(path) = find_file_by_uid(&cur_dir, uid) {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete .eml file: {}", e))?;
        info!("Deleted email UID {} from {:?}", uid, path);
    }
    Ok(())
}

#[tauri::command]
fn maildir_delete_many(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<serde_json::Value, String> {
    let uid_set: std::collections::HashSet<u32> = uids.into_iter().collect();
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    let removed = delete_maildir_files(&cur_dir, &uid_set);

    let index_path = local_index_path(&app_handle, &account_id, &mailbox)?;
    if let Err(e) = prune_local_index(&index_path, &uid_set) {
        warn!("maildir_delete_many: index prune failed: {}", e);
    }

    info!(
        "maildir_delete_many: removed {} files from {}/{}",
        removed, account_id, mailbox
    );
    Ok(serde_json::json!({ "removed": removed }))
}

#[tauri::command]
fn maildir_set_flags(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    uid: u32,
    flags: Vec<String>,
) -> Result<(), String> {
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;
    let old_path = match find_file_by_uid(&cur_dir, uid) {
        Some(p) => p,
        None => return Err(format!("E_UID_NOT_IN_MAILDIR: Email UID {} not found in Maildir", uid)),
    };

    let new_filename = build_maildir_filename(uid, &flags);
    let new_path = cur_dir.join(&new_filename);

    if old_path != new_path {
        fs::rename(&old_path, &new_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;
        info!("Updated flags for UID {}: {:?} -> {:?}", uid, old_path.file_name(), new_path.file_name());
    }
    Ok(())
}

#[tauri::command]
fn maildir_storage_stats(
    app_handle: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<MaildirStorageStats, String> {
    let base = vault::root(&app_handle)?
        .join("Maildir");

    let scan_dir = match account_id {
        Some(ref id) => base.join(id),
        None => base,
    };

    if !scan_dir.exists() {
        return Ok(MaildirStorageStats { total_bytes: 0, total_mb: 0.0, email_count: 0 });
    }

    let mut total_bytes: u64 = 0;
    let mut email_count: u32 = 0;

    for entry in WalkDir::new(&scan_dir).into_iter().flatten() {
        if entry.file_type().is_file() {
            let name = entry.file_name().to_string_lossy();
            if name.contains(":2,") {
                if let Ok(meta) = entry.metadata() {
                    total_bytes += meta.len();
                    email_count += 1;
                }
            }
        }
    }

    Ok(MaildirStorageStats {
        total_bytes,
        total_mb: total_bytes as f64 / (1024.0 * 1024.0),
        email_count,
    })
}

#[tauri::command]
fn maildir_clear_cache(
    app_handle: tauri::AppHandle,
) -> Result<MaildirClearCacheResult, String> {
    let base = vault::root(&app_handle)?
        .join("Maildir");

    if !base.exists() {
        return Ok(MaildirClearCacheResult { deleted_count: 0, skipped_archived: 0 });
    }

    let mut deleted_count: u32 = 0;
    let mut skipped_archived: u32 = 0;

    for entry in WalkDir::new(&base).into_iter().flatten() {
        // `orphaned/` holds mail set aside by a UID generation repair: messages
        // the current server does not have, so this copy may be the only one.
        // "Clear cached emails" promises saved mail survives it, and a file in
        // here whose flags happen to be empty would otherwise read as cache.
        if entry.path().components().any(|c| c.as_os_str() == mailvault_core::maildir::ORPHAN_DIR) {
            continue;
        }
        if entry.file_type().is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(":2,") {
                let flags = parse_flags_from_filename(&name);
                if flags.iter().any(|f| f == "archived") {
                    skipped_archived += 1;
                } else {
                    if let Err(e) = fs::remove_file(entry.path()) {
                        warn!("Failed to delete cached email {:?}: {}", entry.path(), e);
                    } else {
                        deleted_count += 1;
                    }
                }
            }
        }
    }

    info!("Cleared email cache: deleted {} files, skipped {} archived", deleted_count, skipped_archived);
    Ok(MaildirClearCacheResult { deleted_count, skipped_archived })
}

#[tauri::command]
fn maildir_migrate_json_to_eml(
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use base64::Engine;

    let base = vault::root(&app_handle)?
        .join("Maildir");

    if !base.exists() {
        return Ok("No Maildir directory found, nothing to migrate.".to_string());
    }

    let mut migrated = 0u32;
    let mut skipped = 0u32;
    let mut errors = 0u32;

    for entry in WalkDir::new(&base).into_iter().flatten() {
        if !entry.file_type().is_file() { continue; }
        let path = entry.path().to_path_buf();
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("json") { continue; }

        let json_str = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                warn!("Could not read {:?}: {}", path, e);
                errors += 1;
                continue;
            }
        };

        let json_val: serde_json::Value = match serde_json::from_str(&json_str) {
            Ok(v) => v,
            Err(e) => {
                warn!("Could not parse JSON {:?}: {}", path, e);
                errors += 1;
                continue;
            }
        };

        let uid: u32 = match path.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse().ok())
        {
            Some(u) => u,
            None => {
                warn!("Could not extract UID from {:?}", path);
                errors += 1;
                continue;
            }
        };

        if let Some(raw_b64) = json_val.get("rawSource").and_then(|v| v.as_str()) {
            let raw_bytes = match base64::engine::general_purpose::STANDARD.decode(raw_b64) {
                Ok(b) => b,
                Err(e) => {
                    warn!("Could not decode rawSource for {:?}: {}", path, e);
                    errors += 1;
                    continue;
                }
            };

            let cur_dir = match path.parent() {
                Some(d) => d,
                None => {
                    warn!("migrate_json_to_eml: path {:?} has no parent dir", path);
                    errors += 1;
                    continue;
                }
            };
            let eml_filename = build_maildir_filename(uid, &["archived".to_string(), "seen".to_string()]);
            let eml_path = cur_dir.join(&eml_filename);

            match fs::write(&eml_path, &raw_bytes) {
                Ok(_) => {
                    let _ = fs::remove_file(&path);
                    migrated += 1;
                    info!("Migrated {:?} -> {:?}", path, eml_path);
                }
                Err(e) => {
                    warn!("Failed to write .eml for {:?}: {}", path, e);
                    errors += 1;
                }
            }
        } else {
            warn!("No rawSource in {:?}, cannot migrate to .eml — removing", path);
            let _ = fs::remove_file(&path);
            skipped += 1;
        }
    }

    let result = format!(
        "Migration complete. Migrated: {}, Skipped (no rawSource): {}, Errors: {}",
        migrated, skipped, errors
    );
    info!("{}", result);
    Ok(result)
}

#[tauri::command]
fn maildir_migrate_email_dirs(
    app_handle: tauri::AppHandle,
    account_map: std::collections::HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let base = vault::root(&app_handle)?;
    let maildir_base = base.join("Maildir");

    if !maildir_base.exists() {
        return Ok(serde_json::json!({ "migrated": 0 }));
    }

    let mut migrated = 0u32;

    for (email, uuid) in &account_map {
        let email_dir = maildir_base.join(email);
        let uuid_dir = maildir_base.join(uuid);

        if !email_dir.exists() || email_dir == uuid_dir {
            continue;
        }

        if let Ok(mailbox_entries) = fs::read_dir(&email_dir) {
            for mb_entry in mailbox_entries.flatten() {
                if !mb_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let mb_name = mb_entry.file_name();
                let src_cur = mb_entry.path().join("cur");
                if !src_cur.exists() { continue; }

                let dst_cur = uuid_dir.join(&mb_name).join("cur");
                if let Err(e) = fs::create_dir_all(&dst_cur) {
                    tracing::warn!("Migration: failed to create {:?}: {}", dst_cur, e);
                    continue;
                }

                if let Ok(files) = fs::read_dir(&src_cur) {
                    for file in files.flatten() {
                        let fname = file.file_name();
                        let dst_path = dst_cur.join(&fname);
                        if !dst_path.exists() {
                            if let Err(e) = fs::rename(file.path(), &dst_path) {
                                tracing::warn!("Migration: failed to move {:?}: {}", fname, e);
                            } else {
                                migrated += 1;
                            }
                        }
                    }
                }
            }
        }

        let _ = fs::remove_dir_all(&email_dir);
    }

    info!("Maildir migration: moved {} files from email-address dirs to UUID dirs", migrated);
    Ok(serde_json::json!({ "migrated": migrated }))
}

// ==========================================
// Backup export/import (ZIP of .eml files)
// ==========================================

#[derive(Debug, Serialize, Deserialize)]
struct BackupManifest {
    version: u32,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    accounts: Vec<BackupAccount>,
    settings: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupAccount {
    email: String,
    #[serde(rename = "imapServer")]
    imap_server: Option<String>,
    #[serde(rename = "smtpServer")]
    smtp_server: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExportResult {
    #[serde(rename = "emailCount")]
    email_count: u32,
    #[serde(rename = "accountCount")]
    account_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct ImportResult {
    #[serde(rename = "emailCount")]
    email_count: u32,
    #[serde(rename = "accountCount")]
    account_count: u32,
    #[serde(rename = "newAccounts")]
    new_accounts: Vec<String>,
    #[serde(rename = "settingsJson")]
    settings_json: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AccountsJsonEntry {
    id: String,
    email: Option<String>,
    #[serde(rename = "imapServer")]
    imap_server: Option<String>,
    #[serde(rename = "smtpServer")]
    smtp_server: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
}

fn read_accounts_json(app_handle: &tauri::AppHandle) -> Result<Vec<AccountsJsonEntry>, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
    let accounts_path = base.join("accounts.json");
    if !accounts_path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&accounts_path)
        .map_err(|e| format!("Failed to read accounts.json: {}", e))?;
    serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse accounts.json: {}", e))
}

fn write_accounts_json(app_handle: &tauri::AppHandle, accounts: &[AccountsJsonEntry]) -> Result<(), String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
    let accounts_path = base.join("accounts.json");
    let data = serde_json::to_string_pretty(accounts)
        .map_err(|e| format!("Failed to serialize accounts: {}", e))?;
    fs::write(&accounts_path, data)
        .map_err(|e| format!("Failed to write accounts.json: {}", e))
}

fn sanitize_mailbox_name(mailbox: &str) -> String {
    mailbox.chars().map(|c| {
        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }
    }).collect()
}

#[tauri::command]
async fn export_backup(
    app_handle: tauri::AppHandle,
    dest_path: String,
    archived_only: bool,
    settings_json: String,
    accounts_json: String,
) -> Result<ExportResult, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    info!("export_backup called: dest={}, archived_only={}", dest_path, archived_only);

    let accounts: Vec<BackupAccount> = serde_json::from_str(&accounts_json)
        .map_err(|e| format!("Failed to parse accounts: {}", e))?;

    let settings: Option<serde_json::Value> = if settings_json.is_empty() {
        None
    } else {
        serde_json::from_str(&settings_json).ok()
    };

    // Read accounts.json to get accountId -> email mapping
    let accounts_entries = read_accounts_json(&app_handle)?;
    let mut id_to_email: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for entry in &accounts_entries {
        if let Some(ref email) = entry.email {
            id_to_email.insert(entry.id.clone(), email.clone());
        }
    }

    let base = vault::root(&app_handle)?;
    let maildir_base = base.join("Maildir");

    let file = fs::File::create(&dest_path)
        .map_err(|e| format!("Failed to create ZIP file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut email_count: u32 = 0;
    let mut account_count: u32 = 0;

    // Count total files first for progress tracking
    let mut total_files: u32 = 0;
    if maildir_base.exists() {
        if let Ok(account_dirs) = fs::read_dir(&maildir_base) {
            for account_dir in account_dirs.flatten() {
                if !account_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) { continue; }
                let acct_id = account_dir.file_name().to_string_lossy().to_string();
                if !id_to_email.contains_key(&acct_id) { continue; }
                if let Ok(mailbox_dirs) = fs::read_dir(account_dir.path()) {
                    for mailbox_dir in mailbox_dirs.flatten() {
                        if !mailbox_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) { continue; }
                        let cur_dir = mailbox_dir.path().join("cur");
                        if !cur_dir.exists() { continue; }
                        if let Ok(files) = fs::read_dir(&cur_dir) {
                            for file_entry in files.flatten() {
                                let fname = file_entry.file_name().to_string_lossy().to_string();
                                if !fname.contains(":2,") { continue; }
                                if archived_only {
                                    if let Some(flags_part) = fname.split(":2,").nth(1) {
                                        if !flags_part.contains('A') { continue; }
                                    } else { continue; }
                                }
                                total_files += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = app_handle.emit("export-progress", serde_json::json!({
        "total": total_files, "completed": 0, "active": true
    }));

    if maildir_base.exists() {
        // Walk each account directory
        if let Ok(account_dirs) = fs::read_dir(&maildir_base) {
            for account_dir in account_dirs.flatten() {
                if !account_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    continue;
                }
                let account_id = account_dir.file_name().to_string_lossy().to_string();
                let email_addr = match id_to_email.get(&account_id) {
                    Some(e) => e.clone(),
                    None => {
                        warn!("No email found for account {}, skipping", account_id);
                        continue;
                    }
                };

                let mut account_has_emails = false;

                // Walk each mailbox directory
                if let Ok(mailbox_dirs) = fs::read_dir(account_dir.path()) {
                    for mailbox_dir in mailbox_dirs.flatten() {
                        if !mailbox_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                            continue;
                        }
                        let mailbox_name = mailbox_dir.file_name().to_string_lossy().to_string();
                        let cur_dir = mailbox_dir.path().join("cur");
                        if !cur_dir.exists() {
                            continue;
                        }

                        if let Ok(files) = fs::read_dir(&cur_dir) {
                            for file_entry in files.flatten() {
                                let filename = file_entry.file_name().to_string_lossy().to_string();
                                if !filename.contains(":2,") {
                                    continue;
                                }

                                // If archived_only, check for 'A' flag
                                if archived_only {
                                    if let Some(flags_part) = filename.split(":2,").nth(1) {
                                        if !flags_part.contains('A') {
                                            continue;
                                        }
                                    } else {
                                        continue;
                                    }
                                }

                                let zip_path = format!(
                                    "mailvault-backup/emails/{}/{}/{}",
                                    email_addr, mailbox_name, filename
                                );

                                let content = match fs::read(file_entry.path()) {
                                    Ok(c) => c,
                                    Err(e) => {
                                        warn!("Failed to read {}: {}", file_entry.path().display(), e);
                                        continue;
                                    }
                                };

                                zip.start_file(&zip_path, options)
                                    .map_err(|e| format!("Failed to add file to ZIP: {}", e))?;
                                zip.write_all(&content)
                                    .map_err(|e| format!("Failed to write to ZIP: {}", e))?;

                                email_count += 1;
                                account_has_emails = true;

                                let _ = app_handle.emit("export-progress", serde_json::json!({
                                    "total": total_files, "completed": email_count, "active": true
                                }));
                            }
                        }
                    }
                }

                if account_has_emails {
                    account_count += 1;
                }
            }
        }
    }

    // Write manifest.json
    let manifest = BackupManifest {
        version: 2,
        exported_at: chrono::Utc::now().to_rfc3339(),
        accounts,
        settings,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    zip.start_file("mailvault-backup/manifest.json", options)
        .map_err(|e| format!("Failed to add manifest to ZIP: {}", e))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    zip.finish()
        .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;

    let _ = app_handle.emit("export-progress", serde_json::json!({
        "total": total_files, "completed": email_count, "active": false
    }));

    info!("Backup exported: {} emails from {} accounts to {}", email_count, account_count, dest_path);

    Ok(ExportResult {
        email_count,
        account_count,
    })
}

#[tauri::command]
async fn import_backup(
    app_handle: tauri::AppHandle,
    source_path: String,
) -> Result<ImportResult, String> {
    use std::io::Read;

    info!("import_backup called: source={}", source_path);

    let file = fs::File::open(&source_path)
        .map_err(|e| format!("Failed to open ZIP file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    // Read manifest.json
    let manifest: BackupManifest = {
        let mut manifest_file = archive.by_name("mailvault-backup/manifest.json")
            .map_err(|e| format!("No manifest.json found in backup: {}", e))?;
        let mut manifest_str = String::new();
        manifest_file.read_to_string(&mut manifest_str)
            .map_err(|e| format!("Failed to read manifest: {}", e))?;
        serde_json::from_str(&manifest_str)
            .map_err(|e| format!("Failed to parse manifest: {}", e))?
    };

    info!("Backup manifest: version={}, accounts={}, exported_at={}",
        manifest.version, manifest.accounts.len(), manifest.exported_at);

    // Read existing accounts to match by email
    let mut existing_accounts = read_accounts_json(&app_handle)?;
    let mut email_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for entry in &existing_accounts {
        if let Some(ref email) = entry.email {
            email_to_id.insert(email.clone(), entry.id.clone());
        }
    }

    // Map manifest emails to account IDs (existing or new)
    let mut new_accounts: Vec<String> = Vec::new();
    for manifest_acct in &manifest.accounts {
        if !email_to_id.contains_key(&manifest_acct.email) {
            let new_id = uuid::Uuid::new_v4().to_string();
            info!("Creating new account for {}: {}", manifest_acct.email, new_id);
            email_to_id.insert(manifest_acct.email.clone(), new_id.clone());

            existing_accounts.push(AccountsJsonEntry {
                id: new_id,
                email: Some(manifest_acct.email.clone()),
                imap_server: manifest_acct.imap_server.clone(),
                smtp_server: manifest_acct.smtp_server.clone(),
                created_at: Some(chrono::Utc::now().to_rfc3339()),
            });

            new_accounts.push(manifest_acct.email.clone());
        }
    }

    // Save updated accounts.json
    write_accounts_json(&app_handle, &existing_accounts)?;

    let base = vault::root(&app_handle)?;
    let maildir_base = base.join("Maildir");

    // Extract .eml files
    let mut email_count: u32 = 0;
    let email_prefix = "mailvault-backup/emails/";

    // Count total email entries for progress
    let total_entries: u32 = (0..archive.len())
        .filter(|&i| {
            if let Ok(entry) = archive.by_index(i) {
                let name = entry.name().to_string();
                name.starts_with(email_prefix) && !entry.is_dir() && name.contains(":2,")
            } else {
                false
            }
        })
        .count() as u32;

    let _ = app_handle.emit("import-progress", serde_json::json!({
        "total": total_entries, "completed": 0, "active": true
    }));

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry: {}", e))?;
        let entry_name = entry.name().to_string();

        if !entry_name.starts_with(email_prefix) || entry.is_dir() {
            continue;
        }

        // Parse path: emails/{email}/{mailbox}/{filename}
        let relative = &entry_name[email_prefix.len()..];
        let parts: Vec<&str> = relative.splitn(3, '/').collect();
        if parts.len() != 3 {
            warn!("Skipping malformed path: {}", entry_name);
            continue;
        }

        let email_addr = parts[0];
        let mailbox = parts[1];
        let filename = parts[2];

        if filename.is_empty() || !filename.contains(":2,") {
            continue;
        }

        let account_id = match email_to_id.get(email_addr) {
            Some(id) => id.clone(),
            None => {
                warn!("No account ID for email {}, skipping", email_addr);
                continue;
            }
        };

        let safe_mailbox = sanitize_mailbox_name(mailbox);
        let cur_dir = maildir_base.join(&account_id).join(&safe_mailbox).join("cur");
        fs::create_dir_all(&cur_dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;

        let dest_path = cur_dir.join(filename);

        // Skip if file already exists (idempotent)
        if dest_path.exists() {
            info!("Skipping existing file: {:?}", dest_path);
            continue;
        }

        let mut content = Vec::new();
        entry.read_to_end(&mut content)
            .map_err(|e| format!("Failed to read .eml from ZIP: {}", e))?;

        fs::write(&dest_path, &content)
            .map_err(|e| format!("Failed to write .eml file: {}", e))?;

        email_count += 1;

        let _ = app_handle.emit("import-progress", serde_json::json!({
            "total": total_entries, "completed": email_count, "active": true
        }));
    }

    let _ = app_handle.emit("import-progress", serde_json::json!({
        "total": total_entries, "completed": email_count, "active": false
    }));

    let settings_json = manifest.settings
        .map(|s| serde_json::to_string(&s).unwrap_or_default());

    info!("Backup imported: {} emails, {} new accounts", email_count, new_accounts.len());

    Ok(ImportResult {
        email_count,
        account_count: manifest.accounts.len() as u32,
        new_accounts,
        settings_json,
    })
}

// ── MBOX Export / Import ────────────────────────────────────────────────────

/// Escape "From " at the start of lines in an email body for mbox format.
fn mbox_escape_from(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 256);
    for line in raw.split(|&b| b == b'\n') {
        if line.starts_with(b"From ") {
            out.push(b'>');
        }
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    // Remove trailing extra newline added by split
    if raw.last() != Some(&b'\n') && out.last() == Some(&b'\n') {
        out.pop();
    }
    out
}

/// Unescape ">From " at start of lines back to "From " when importing mbox.
fn mbox_unescape_from(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    for line in raw.split(|&b| b == b'\n') {
        if line.starts_with(b">From ") {
            out.extend_from_slice(&line[1..]);
        } else {
            out.extend_from_slice(line);
        }
        out.push(b'\n');
    }
    if raw.last() != Some(&b'\n') && out.last() == Some(&b'\n') {
        out.pop();
    }
    out
}

/// Extract a usable "From " envelope line from raw .eml bytes.
/// Falls back to "unknown" sender and current time if headers can't be parsed.
fn mbox_from_line(raw: &[u8]) -> String {
    let sender = mailparse::parse_mail(raw)
        .ok()
        .and_then(|parsed| {
            parsed.headers.iter()
                .find(|h| h.get_key().eq_ignore_ascii_case("from"))
                .and_then(|h| {
                    let val = h.get_value();
                    // Extract bare email from "Name <email>" or plain "email"
                    if let Some(start) = val.find('<') {
                        val[start + 1..].split('>').next().map(|s| s.to_string())
                    } else {
                        Some(val.trim().to_string())
                    }
                })
        })
        .unwrap_or_else(|| "unknown@unknown".to_string());

    let date = mailparse::parse_mail(raw)
        .ok()
        .and_then(|parsed| {
            parsed.headers.iter()
                .find(|h| h.get_key().eq_ignore_ascii_case("date"))
                .and_then(|h| mailparse::dateparse(&h.get_value()).ok())
        })
        .map(|ts| {
            chrono::DateTime::from_timestamp(ts, 0)
                .unwrap_or_else(|| chrono::Utc::now())
                .format("%a %b %e %H:%M:%S %Y")
                .to_string()
        })
        .unwrap_or_else(|| chrono::Utc::now().format("%a %b %e %H:%M:%S %Y").to_string());

    format!("From {} {}", sender, date)
}

#[derive(Debug, Serialize, Deserialize)]
struct MboxExportResult {
    #[serde(rename = "emailCount")]
    email_count: u32,
    #[serde(rename = "accountCount")]
    account_count: u32,
    #[serde(rename = "filePath")]
    file_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MboxImportResult {
    #[serde(rename = "emailCount")]
    email_count: u32,
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "mailbox")]
    mailbox: String,
}

#[tauri::command]
async fn export_mbox(
    app_handle: tauri::AppHandle,
    dest_path: String,
    account_id: String,
    mailbox: String,
    archived_only: bool,
) -> Result<MboxExportResult, String> {
    use std::io::Write;

    info!("export_mbox called: dest={}, account={}, mailbox={}, archived_only={}",
        dest_path, account_id, mailbox, archived_only);

    let base = vault::root(&app_handle)?;

    let safe_mailbox = sanitize_mailbox_name(&mailbox);
    let cur_dir = base.join("Maildir").join(&account_id).join(&safe_mailbox).join("cur");

    if !cur_dir.exists() {
        return Err(format!("E_MAILBOX_EMPTY: No emails found for mailbox '{}'", mailbox));
    }

    let mut file = fs::File::create(&dest_path)
        .map_err(|e| format!("Failed to create mbox file: {}", e))?;

    let mut email_count: u32 = 0;

    // Count total for progress
    let entries: Vec<_> = fs::read_dir(&cur_dir)
        .map_err(|e| format!("Failed to read directory: {}", e))?
        .flatten()
        .filter(|e| {
            let fname = e.file_name().to_string_lossy().to_string();
            if !fname.contains(":2,") { return false; }
            if archived_only {
                fname.split(":2,").nth(1).map(|f| f.contains('A')).unwrap_or(false)
            } else {
                true
            }
        })
        .collect();

    let total = entries.len() as u32;
    let _ = app_handle.emit("mbox-export-progress", serde_json::json!({
        "total": total, "completed": 0, "active": true
    }));

    for entry in &entries {
        let raw = match fs::read(entry.path()) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read {}: {}", entry.path().display(), e);
                continue;
            }
        };

        // Write mbox "From " envelope line
        let from_line = mbox_from_line(&raw);
        writeln!(file, "{}", from_line)
            .map_err(|e| format!("Failed to write mbox: {}", e))?;

        // Write escaped email content
        let escaped = mbox_escape_from(&raw);
        file.write_all(&escaped)
            .map_err(|e| format!("Failed to write mbox: {}", e))?;

        // Ensure blank line between messages
        writeln!(file).map_err(|e| format!("Failed to write mbox: {}", e))?;

        email_count += 1;
        let _ = app_handle.emit("mbox-export-progress", serde_json::json!({
            "total": total, "completed": email_count, "active": true
        }));
    }

    let _ = app_handle.emit("mbox-export-progress", serde_json::json!({
        "total": total, "completed": email_count, "active": false
    }));

    info!("MBOX exported: {} emails to {}", email_count, dest_path);

    Ok(MboxExportResult {
        email_count,
        account_count: 1,
        file_path: dest_path,
    })
}

#[tauri::command]
async fn export_mbox_all(
    app_handle: tauri::AppHandle,
    dest_path: String,
    archived_only: bool,
) -> Result<MboxExportResult, String> {
    use std::io::Write;

    info!("export_mbox_all called: dest={}, archived_only={}", dest_path, archived_only);

    let base = vault::root(&app_handle)?;
    let maildir_base = base.join("Maildir");

    if !maildir_base.exists() {
        return Err("No email data found".to_string());
    }

    let mut file = fs::File::create(&dest_path)
        .map_err(|e| format!("Failed to create mbox file: {}", e))?;

    let mut email_count: u32 = 0;
    let mut account_count: u32 = 0;

    let _ = app_handle.emit("mbox-export-progress", serde_json::json!({
        "total": 0, "completed": 0, "active": true
    }));

    if let Ok(account_dirs) = fs::read_dir(&maildir_base) {
        for account_dir in account_dirs.flatten() {
            if !account_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) { continue; }
            let mut account_has_emails = false;

            if let Ok(mailbox_dirs) = fs::read_dir(account_dir.path()) {
                for mailbox_dir in mailbox_dirs.flatten() {
                    if !mailbox_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) { continue; }
                    let cur_dir = mailbox_dir.path().join("cur");
                    if !cur_dir.exists() { continue; }

                    if let Ok(files) = fs::read_dir(&cur_dir) {
                        for file_entry in files.flatten() {
                            let fname = file_entry.file_name().to_string_lossy().to_string();
                            if !fname.contains(":2,") { continue; }
                            if archived_only {
                                if !fname.split(":2,").nth(1).map(|f| f.contains('A')).unwrap_or(false) {
                                    continue;
                                }
                            }

                            let raw = match fs::read(file_entry.path()) {
                                Ok(c) => c,
                                Err(e) => {
                                    warn!("Failed to read {}: {}", file_entry.path().display(), e);
                                    continue;
                                }
                            };

                            let from_line = mbox_from_line(&raw);
                            writeln!(file, "{}", from_line)
                                .map_err(|e| format!("Failed to write mbox: {}", e))?;

                            let escaped = mbox_escape_from(&raw);
                            file.write_all(&escaped)
                                .map_err(|e| format!("Failed to write mbox: {}", e))?;

                            writeln!(file).map_err(|e| format!("Failed to write mbox: {}", e))?;

                            email_count += 1;
                            account_has_emails = true;

                            if email_count % 100 == 0 {
                                let _ = app_handle.emit("mbox-export-progress", serde_json::json!({
                                    "total": 0, "completed": email_count, "active": true
                                }));
                            }
                        }
                    }
                }
            }

            if account_has_emails { account_count += 1; }
        }
    }

    let _ = app_handle.emit("mbox-export-progress", serde_json::json!({
        "total": email_count, "completed": email_count, "active": false
    }));

    info!("MBOX exported: {} emails from {} accounts to {}", email_count, account_count, dest_path);

    Ok(MboxExportResult {
        email_count,
        account_count,
        file_path: dest_path,
    })
}

#[tauri::command]
async fn import_mbox(
    app_handle: tauri::AppHandle,
    source_path: String,
    account_id: String,
    mailbox: String,
) -> Result<MboxImportResult, String> {
    info!("import_mbox called: source={}, account={}, mailbox={}", source_path, account_id, mailbox);

    let data = fs::read(&source_path)
        .map_err(|e| format!("Failed to read mbox file: {}", e))?;

    let base = vault::root(&app_handle)?;

    let safe_mailbox = sanitize_mailbox_name(&mailbox);
    let cur_dir = base.join("Maildir").join(&account_id).join(&safe_mailbox).join("cur");
    fs::create_dir_all(&cur_dir)
        .map_err(|e| format!("Failed to create maildir: {}", e))?;

    // Find the highest existing UID in this mailbox to continue from
    let mut max_uid: u32 = 0;
    if let Ok(files) = fs::read_dir(&cur_dir) {
        for f in files.flatten() {
            let fname = f.file_name().to_string_lossy().to_string();
            if let Some(uid_str) = fname.split(':').next() {
                if let Ok(uid) = uid_str.parse::<u32>() {
                    if uid > max_uid { max_uid = uid; }
                }
            }
        }
    }

    // Split mbox into individual messages
    // Mbox messages start with "From " at the beginning of a line (after a blank line)
    let messages = split_mbox(&data);

    let total = messages.len() as u32;
    let _ = app_handle.emit("mbox-import-progress", serde_json::json!({
        "total": total, "completed": 0, "active": true
    }));

    let mut email_count: u32 = 0;

    for msg_raw in &messages {
        let unescaped = mbox_unescape_from(msg_raw);

        max_uid += 1;
        let filename = format!("{}:2,", max_uid);
        let dest = cur_dir.join(&filename);

        if dest.exists() {
            max_uid += 1;
            let filename2 = format!("{}:2,", max_uid);
            let dest2 = cur_dir.join(&filename2);
            fs::write(&dest2, &unescaped)
                .map_err(|e| format!("Failed to write .eml: {}", e))?;
        } else {
            fs::write(&dest, &unescaped)
                .map_err(|e| format!("Failed to write .eml: {}", e))?;
        }

        email_count += 1;

        if email_count % 50 == 0 || email_count == total {
            let _ = app_handle.emit("mbox-import-progress", serde_json::json!({
                "total": total, "completed": email_count, "active": true
            }));
        }
    }

    let _ = app_handle.emit("mbox-import-progress", serde_json::json!({
        "total": total, "completed": email_count, "active": false
    }));

    info!("MBOX imported: {} emails into {}/{}", email_count, account_id, mailbox);

    Ok(MboxImportResult {
        email_count,
        account_id,
        mailbox,
    })
}

/// Split raw mbox data into individual email messages.
/// Each message starts with a line matching "From " after a blank line (or at file start).
fn split_mbox(data: &[u8]) -> Vec<&[u8]> {
    let mut messages: Vec<&[u8]> = Vec::new();
    let mut start: Option<usize> = None;

    let mut i = 0;
    let len = data.len();

    while i < len {
        // Check for "From " at this position
        let is_from_line = if i + 5 <= len && &data[i..i + 5] == b"From " {
            // Valid if at file start or preceded by \n\n or \r\n\r\n
            i == 0
                || (i >= 1 && data[i - 1] == b'\n'
                    && (i >= 2 && data[i - 2] == b'\n'
                        || (i >= 3 && data[i - 2] == b'\r' && data[i - 3] == b'\n')))
        } else {
            false
        };

        if is_from_line {
            // Save previous message
            if let Some(msg_start) = start {
                let mut end = i;
                // Trim trailing blank lines between messages
                while end > msg_start && (data[end - 1] == b'\n' || data[end - 1] == b'\r') {
                    end -= 1;
                }
                if end > msg_start {
                    messages.push(&data[msg_start..end]);
                }
            }

            // Skip the "From " envelope line to get to the actual email content
            let line_end = data[i..].iter().position(|&b| b == b'\n')
                .map(|p| i + p + 1)
                .unwrap_or(len);
            start = Some(line_end);
            i = line_end;
        } else {
            i += 1;
        }
    }

    // Don't forget the last message
    if let Some(msg_start) = start {
        let mut end = len;
        while end > msg_start && (data[end - 1] == b'\n' || data[end - 1] == b'\r') {
            end -= 1;
        }
        if end > msg_start {
            messages.push(&data[msg_start..end]);
        }
    }

    messages
}

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

use std::sync::{LazyLock, Mutex};

/// Tracks a daemon child process spawned in on-demand mode.
static DAEMON_CHILD: LazyLock<Mutex<Option<std::process::Child>>> = LazyLock::new(|| Mutex::new(None));

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

/// Spawn daemon as a child process (on-demand mode). Waits for socket to appear.
fn ensure_daemon_running(app_handle: &tauri::AppHandle, socket_path: &Path) -> Result<(), String> {
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

#[tauri::command]
async fn daemon_rpc(
    app_handle: tauri::AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;

    // Must match src-daemon's ipc_dir(): $HOME/.mailvault (the sandbox container
    // home when sandboxed). NOT app_data_dir — the path there is too long for
    // SUN_LEN and the daemon never binds it.
    let ipc_dir = dirs::home_dir()
        .ok_or_else(|| "Could not resolve home directory".to_string())?
        .join(".mailvault");

    let socket_path = ipc_dir.join("mv.sock");
    let token_path = ipc_dir.join("mv.token");

    // Auto-spawn daemon if not running (on-demand mode)
    ensure_daemon_running(&app_handle, &socket_path)?;

    // Read auth token
    let token = std::fs::read_to_string(&token_path)
        .map_err(|_| "Daemon token not found — is the daemon running?".to_string())?;

    // Connect to daemon socket
    let stream = UnixStream::connect(&socket_path)
        .await
        .map_err(|e| format!("Cannot connect to daemon — is it running? ({})", e))?;

    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // Send auth handshake
    let auth_msg = serde_json::json!({"token": token.trim()});
    let mut buf = serde_json::to_vec(&auth_msg).unwrap();
    buf.push(b'\n');
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;

    // Read auth response
    let auth_resp = lines.next_line().await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Daemon closed connection during auth".to_string())?;

    let auth_result: serde_json::Value = serde_json::from_str(&auth_resp)
        .map_err(|e| format!("Invalid auth response: {}", e))?;

    if auth_result.get("error").is_some() {
        return Err("Daemon authentication failed".to_string());
    }

    // Send JSON-RPC request
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
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;

    // Read response
    let resp_line = lines.next_line().await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Daemon closed connection before responding".to_string())?;

    let resp: serde_json::Value = serde_json::from_str(&resp_line)
        .map_err(|e| format!("Invalid RPC response: {}", e))?;

    if let Some(error) = resp.get("error") {
        let msg = error.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown daemon error");
        return Err(msg.to_string());
    }

    Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

fn main() {
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
        .plugin(tauri_plugin_notification::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    // Updater plugins — Sparkle on macOS (non-MAS), tauri-plugin-updater on Linux.
    // MAS builds (`appstore`, no `sparkle` feature) get updates via the App Store.
    #[cfg(all(target_os = "macos", feature = "sparkle"))]
    let builder = builder.plugin(tauri_plugin_sparkle_updater::init());
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
        .manage(archive::ArchiveCancelToken::default())
        .manage(backup::BackupCancelToken::default())
        .manage(migration::MigrationCancelToken::default())
        .manage(migration::MigrationPauseToken::default())
        .manage(migration::MigrationNotify::default())
        .manage(dropped_files::DroppedPaths::default())
        .manage(restore::RestoreCancelToken::default())
        .manage(imap::ImapPool::new())
        .manage(oauth2::OAuth2Manager::new())
        .manage(iap::IapState::new())
        .manage(UpdateCheckGuard::default())
        .manage(vault::VaultState::default())
        .manage(mailto::PendingMailto::default());

    #[cfg(target_os = "linux")]
    let builder = builder.manage(PendingUpdate::default());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            apply_menu_labels,
            dropped_files::read_dropped_files,
            take_pending_mailto,
            e2e_queue_mailto,
            mailto_default_status,
            mailto_make_default,
            spellcheck::spellcheck_status,
            log_from_frontend,
            install_pending_update,
            get_client_info,
            get_app_data_dir,
            read_settings_json,
            write_settings_json,
            store_credentials,
            get_credentials,
            store_password,
            get_password,
            delete_password,
            get_log_path,
            read_logs,
            clear_logs,
            request_notification_permission,
            check_network_connectivity,
            send_notification,
            set_badge_count,
            check_running_from_dmg,
            save_email_cache,
            load_email_cache,
            load_email_cache_partial,
            load_email_cache_meta,
            load_email_cache_by_uids,
            list_cached_uids,
            clear_email_cache,
            pending_delete_queue,
            pending_delete_clear,
            pending_delete_read,
            save_mailbox_cache,
            load_mailbox_cache,
            delete_mailbox_cache,
            save_graph_id_map,
            load_graph_id_map,
            save_attachment,
            save_attachment_to,
            export_fetch::fetch_remote_asset,
            show_in_folder,
            open_file,
            open_with_dialog,
            open_email_window,
            maildir_store,
            maildir_read,
            maildir_read_light,
            maildir_read_light_batch,
            maildir_read_archived_cached,
            maildir_save_archived_cache,
            maildir_read_attachment,
            maildir_read_raw_source,
            maildir_exists,
            maildir_list,
            maildir_delete,
            maildir_delete_many,
            maildir_set_flags,
            vault_flags::vault_apply_flags,
            maildir_storage_stats,
            maildir_clear_cache,
            maildir_migrate_json_to_eml,
            maildir_migrate_email_dirs,
            export_backup,
            import_backup,
            export_mbox,
            export_mbox_all,
            import_mbox,
            local_index_read,
            local_index_append,
            local_index_remove,
            maildir_repair_generation,
            maildir_orphan_stats,
            maildir_purge_orphans,
            archive_emails,
            cancel_archive,
            bulk_delete_emails,
            verify_archived_emails,
            read_pending_operation,
            save_pending_operation,
            clear_pending_operation,
            commands::imap_test_connection,
            commands::smtp_test_connection,
            commands::imap_ensure_sent_mailbox,
            commands::smtp_build_mime,
            commands::smtp_build_draft_mime,
            commands::imap_get_mailboxes,
            commands::imap_get_emails,
            commands::imap_get_emails_range,
            commands::imap_check_mailbox_status,
            commands::imap_fetch_changed_flags,
            commands::imap_search_all_uids,
            commands::imap_fetch_headers_by_uids,
            commands::imap_get_email,
            commands::imap_get_email_light,
            commands::imap_set_flags,
            commands::imap_delete_email,
            commands::smtp_send_email,
            commands::imap_search_emails,
            commands::imap_find_message_id,
            commands::imap_disconnect,
            commands::oauth2_auth_url,
            commands::oauth2_exchange,
            commands::oauth2_refresh,
            commands::graph_list_folders,
            commands::graph_list_messages,
            commands::graph_get_message,
            commands::graph_get_mime,
            commands::graph_cache_mime,
            commands::graph_set_read,
            commands::graph_delete_message,
            commands::graph_move_emails,
            commands::imap_move_emails,
            commands::resolve_email_settings,
            commands::dns_mail_health,
            commands::backup_run_account,
            commands::backup_status,
            commands::backup_cancel,
            commands::backup_save_external_location,
            commands::backup_get_external_location,
            commands::backup_validate_external_location,
            commands::backup_clear_external_location,
            commands::iap_is_entitled,
            commands::iap_purchase,
            commands::iap_restore,
            commands::backup_resolve_external_location,
            commands::backup_migrate_legacy_path,
            backup::backup_purge_uids,
            backup::backup_scan_uids,
            commands::start_migration,
            commands::cancel_migration,
            commands::pause_migration,
            commands::resume_migration,
            commands::get_migration_state,
            commands::clear_migration_state_cmd,
            commands::count_migration_folders,
            commands::get_folder_mappings,
            commands::start_restore,
            commands::cancel_restore,
            commands::get_transfer_stats,
            commands::count_local_folder,
            github::github_device_start,
            github::github_device_poll,
            github::github_check_star,
            daemon_rpc,
            vault_get_status, vault_inspect_folder, vault_adopt, vault_move_to, vault_move_to_default, vault_reset
        ])
        .setup(|app| {
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
                    info!("Application exiting — logging out IMAP sessions, cleaning up daemon child if on-demand");
                    // Runs on the main thread and blocks the quit, so keep the
                    // budget tight: an unreachable server must cost the user a
                    // beachball, not a hang. Worst case here plus
                    // DAEMON_STOP_GRACE below.
                    if let Ok(dir) = app_handle.path().app_data_dir() {
                        mailvault_core::transfer_stats::global().flush(&dir, "app");
                    }
                    let pool = app_handle.state::<imap::ImapPool>().inner().clone();
                    tauri::async_runtime::block_on(async move {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(2),
                            pool.shutdown(),
                        ).await;
                    });
                    shutdown_daemon_child();
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

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vault_file_name_reports_its_flags_by_both_names() {
        // The IMAP name is what every row reads; the word is what the
        // archived checks and build_maildir_filename read.
        assert_eq!(parse_flags_from_filename("12:2,AS.eml"), vec!["archived", "seen", "\\Seen"]);
        assert_eq!(parse_flags_from_filename("12:2,A"), vec!["archived"]);
        assert_eq!(parse_flags_from_filename("12:2,FRS"), vec!["flagged", "replied", "seen", "\\Seen", "\\Flagged", "\\Answered"]);
        // The names round-trip through the builder without changing the name.
        assert_eq!(build_maildir_filename(12, &parse_flags_from_filename("12:2,AS")), "12:2,AS");
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

    // -- Fixtures --

    const PLAIN_EMAIL: &[u8] = b"From: alice@example.com\r\n\
Subject: Hello\r\n\
Date: Wed, 19 Feb 2026 10:00:00 +0000\r\n\
Content-Type: text/plain\r\n\
\r\n\
Hello, World!";

    const HTML_EMAIL: &[u8] = b"From: alice@example.com\r\n\
Subject: Hello HTML\r\n\
Content-Type: text/html\r\n\
\r\n\
<p>Hello</p>";

    fn multipart_with_attachment() -> Vec<u8> {
        b"From: bob@example.com\r\n\
Subject: With attachment\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"BOUNDARY\"\r\n\
\r\n\
--BOUNDARY\r\n\
Content-Type: text/plain\r\n\
\r\n\
Body text\r\n\
--BOUNDARY\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--BOUNDARY--\r\n".to_vec()
    }

    fn multipart_with_inline_image() -> Vec<u8> {
        b"From: carol@example.com\r\n\
Subject: Inline image\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"RELBOUND\"\r\n\
\r\n\
--RELBOUND\r\n\
Content-Type: text/html\r\n\
\r\n\
<html><body><img src=\"cid:logo123\"></body></html>\r\n\
--RELBOUND\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo123>\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--RELBOUND--\r\n".to_vec()
    }

    fn multipart_mixed_and_inline() -> Vec<u8> {
        b"From: dave@example.com\r\n\
Subject: Mixed attachments\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"MIX\"\r\n\
\r\n\
--MIX\r\n\
Content-Type: text/plain\r\n\
\r\n\
See attached.\r\n\
--MIX\r\n\
Content-Type: image/jpeg\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
/9j/4AAQ\r\n\
--MIX\r\n\
Content-Type: application/zip; name=\"archive.zip\"\r\n\
Content-Disposition: attachment; filename=\"archive.zip\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
UEsFBg==\r\n\
--MIX--\r\n".to_vec()
    }

    fn multipart_two_attachments() -> Vec<u8> {
        b"From: eve@example.com\r\n\
Subject: Two attachments\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"TWO\"\r\n\
\r\n\
--TWO\r\n\
Content-Type: text/html\r\n\
\r\n\
<p>Please review</p>\r\n\
--TWO\r\n\
Content-Type: application/pdf; name=\"doc1.pdf\"\r\n\
Content-Disposition: attachment; filename=\"doc1.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--TWO\r\n\
Content-Type: image/png; name=\"screenshot.png\"\r\n\
Content-Disposition: attachment; filename=\"screenshot.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--TWO--\r\n".to_vec()
    }

    // -----------------------------------------------------------------------
    // parse_eml_bytes_light — basic fields
    // -----------------------------------------------------------------------

    #[test]
    fn light_parse_plain_email_fields() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 42, vec![]).unwrap();
        assert_eq!(email.uid, 42);
        assert_eq!(email.subject, "Hello");
        assert_eq!(email.from.address, "alice@example.com");
        assert_eq!(email.text.as_deref(), Some("Hello, World!"));
        assert!(email.html.is_none());
    }

    #[test]
    fn light_parse_html_email() {
        let email = parse_eml_bytes_light(HTML_EMAIL, 1, vec![]).unwrap();
        assert!(email.html.is_some());
        assert!(email.html.unwrap().contains("<p>Hello</p>"));
    }

    // -----------------------------------------------------------------------
    // parse_eml_bytes_light — attachment detection
    // -----------------------------------------------------------------------

    #[test]
    fn light_parse_no_attachments_plain() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 1, vec![]).unwrap();
        assert!(!email.has_attachments);
        assert!(email.attachments.is_empty());
    }

    #[test]
    fn light_parse_detects_attachment() {
        let raw = multipart_with_attachment();
        let email = parse_eml_bytes_light(&raw, 2, vec![]).unwrap();
        assert!(email.has_attachments);
        assert_eq!(email.attachments.len(), 1);
        assert_eq!(email.attachments[0].filename.as_deref(), Some("report.pdf"));
        assert_eq!(email.attachments[0].content_type, "application/pdf");
        assert!(email.attachments[0].size > 0);
    }

    #[test]
    fn light_parse_detects_inline_non_text() {
        let raw = multipart_with_inline_image();
        let email = parse_eml_bytes_light(&raw, 3, vec![]).unwrap();
        // Inline image referenced via cid: in HTML should NOT set has_attachments
        assert!(!email.has_attachments, "Embedded inline image should not count as attachment");
        // But the attachment metadata should still be present for the viewer
        assert_eq!(email.attachments.len(), 1);
        assert_eq!(email.attachments[0].content_type, "image/png");
        assert!(email.attachments[0].content_id.is_some());
    }

    #[test]
    fn light_parse_mixed_inline_and_attachment() {
        let raw = multipart_mixed_and_inline();
        let email = parse_eml_bytes_light(&raw, 4, vec![]).unwrap();
        assert!(email.has_attachments);
        assert_eq!(email.attachments.len(), 2); // inline jpeg + attached zip
        let filenames: Vec<_> = email.attachments.iter().map(|a| a.filename.as_deref()).collect();
        assert!(filenames.contains(&Some("archive.zip")));
    }

    #[test]
    fn light_parse_two_attachments() {
        let raw = multipart_two_attachments();
        let email = parse_eml_bytes_light(&raw, 5, vec![]).unwrap();
        assert!(email.has_attachments);
        assert_eq!(email.attachments.len(), 2);
        let names: Vec<_> = email.attachments.iter()
            .filter_map(|a| a.filename.as_deref())
            .collect();
        assert!(names.contains(&"doc1.pdf"));
        assert!(names.contains(&"screenshot.png"));
    }

    // -----------------------------------------------------------------------
    // Light attachment metadata — no binary content
    // -----------------------------------------------------------------------

    #[test]
    fn light_attachment_has_no_content_field() {
        // LightAttachment struct has no `content` field — this is a compile-time
        // guarantee, but we verify the JSON representation also omits it.
        let raw = multipart_with_attachment();
        let email = parse_eml_bytes_light(&raw, 6, vec![]).unwrap();
        let json = serde_json::to_value(&email.attachments[0]).unwrap();
        assert!(json.get("content").is_none(), "LightAttachment should not have content");
        assert!(json.get("contentType").is_some(), "LightAttachment should have contentType");
        assert!(json.get("filename").is_some());
        assert!(json.get("size").is_some());
    }

    // -----------------------------------------------------------------------
    // collect_attachment_parts — on-demand single attachment fetch
    // -----------------------------------------------------------------------

    #[test]
    fn collect_parts_matches_light_count() {
        let raw = multipart_two_attachments();
        let parsed = mailparse::parse_mail(&raw).unwrap();
        let mut parts = Vec::new();
        collect_attachment_parts(&parsed, &mut parts);
        // Should find same count as walk_mime_parts_light
        let email = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(parts.len(), email.attachments.len());
    }

    #[test]
    fn collect_parts_empty_for_plain() {
        let parsed = mailparse::parse_mail(PLAIN_EMAIL).unwrap();
        let mut parts = Vec::new();
        collect_attachment_parts(&parsed, &mut parts);
        assert!(parts.is_empty());
    }

    // -----------------------------------------------------------------------
    // Flags parsing
    // -----------------------------------------------------------------------

    #[test]
    fn light_parse_archived_flag() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 1, vec!["archived".to_string()]).unwrap();
        assert!(email.is_archived);
    }

    #[test]
    fn light_parse_not_archived_by_default() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 1, vec![]).unwrap();
        assert!(!email.is_archived);
    }

    // -----------------------------------------------------------------------
    // Full parse vs light parse consistency
    // -----------------------------------------------------------------------

    #[test]
    fn full_and_light_parse_same_attachment_count() {
        let raw = multipart_two_attachments();
        let full = parse_eml_bytes(&raw, 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(full.attachments.len(), light.attachments.len());
        assert_eq!(full.has_attachments, light.has_attachments);
    }

    #[test]
    fn full_and_light_parse_same_subject() {
        let raw = multipart_with_attachment();
        let full = parse_eml_bytes(&raw, 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(full.subject, light.subject);
    }

    #[test]
    fn full_and_light_parse_same_body_text() {
        let raw = multipart_with_attachment();
        let full = parse_eml_bytes(&raw, 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(full.text, light.text);
    }

    // ── is_real_attachment tests ────────────────────────────────────────

    #[test]
    fn real_attachment_pdf() {
        assert!(is_real_attachment("application/pdf", &None, &Some("report.pdf".into()), 10000, None));
    }

    #[test]
    fn real_attachment_zip() {
        assert!(is_real_attachment("application/zip", &None, &Some("archive.zip".into()), 50000, None));
    }

    #[test]
    fn inline_image_with_cid_referenced_in_html() {
        let cid = Some("<logo123>".to_string());
        let html = Some(r#"<html><body><img src="cid:logo123"></body></html>"#);
        assert!(!is_real_attachment("image/png", &cid, &Some("logo.png".into()), 15000, html));
    }

    #[test]
    fn inline_image_with_cid_not_in_html() {
        let cid = Some("<logo123>".to_string());
        let html = Some("<html><body><p>No images</p></body></html>");
        assert!(is_real_attachment("image/png", &cid, &Some("logo.png".into()), 15000, html));
    }

    #[test]
    fn inline_image_with_cid_no_html_body() {
        let cid = Some("<logo123>".to_string());
        assert!(is_real_attachment("image/png", &cid, &Some("logo.png".into()), 15000, None));
    }

    #[test]
    fn tracking_pixel_tiny_unnamed_image() {
        assert!(!is_real_attachment("image/gif", &None, &None, 43, None));
    }

    #[test]
    fn tracking_pixel_boundary() {
        // Just under 5000 — still a tracking pixel
        assert!(!is_real_attachment("image/png", &None, &None, 4999, None));
        // At 5000 — counts as real
        assert!(is_real_attachment("image/png", &None, &None, 5000, None));
    }

    #[test]
    fn named_inline_image_no_cid() {
        // Has filename but no Content-ID → user-attached image, counts as real
        assert!(is_real_attachment("image/jpeg", &None, &Some("photo.jpg".into()), 50000, Some("<p>hello</p>")));
    }

    #[test]
    fn non_image_inline_always_real() {
        // Even with Content-ID, non-image types are always real attachments
        let cid = Some("<doc1>".to_string());
        assert!(is_real_attachment("application/pdf", &cid, &Some("doc.pdf".into()), 10000, Some("<p>hello</p>")));
    }

    // ── has_real_attachments integration tests ─────────────────────────

    #[test]
    fn has_real_attachments_mixed_inline_and_real() {
        let attachments = vec![
            LightAttachment {
                filename: Some("logo.png".into()),
                content_type: "image/png".into(),
                content_disposition: Some("Inline".into()),
                size: 15000,
                content_id: Some("<logo1>".into()),
            },
            LightAttachment {
                filename: Some("report.pdf".into()),
                content_type: "application/pdf".into(),
                content_disposition: Some("Attachment".into()),
                size: 102400,
                content_id: None,
            },
        ];
        let html = Some(r#"<img src="cid:logo1">"#);
        assert!(has_real_attachments(&attachments, html));
    }

    #[test]
    fn has_real_attachments_only_embedded_images() {
        let attachments = vec![
            LightAttachment {
                filename: Some("banner.png".into()),
                content_type: "image/png".into(),
                content_disposition: Some("Inline".into()),
                size: 20000,
                content_id: Some("<banner>".into()),
            },
        ];
        let html = Some(r#"<img src="cid:banner">"#);
        assert!(!has_real_attachments(&attachments, html));
    }

    #[test]
    fn has_real_attachments_only_tracking_pixel() {
        let attachments = vec![
            LightAttachment {
                filename: None,
                content_type: "image/gif".into(),
                content_disposition: Some("Inline".into()),
                size: 43,
                content_id: None,
            },
        ];
        assert!(!has_real_attachments(&attachments, Some("<p>hello</p>")));
    }

    #[test]
    fn eml_with_inline_image_has_attachments_false() {
        let raw = b"From: sender@test.com\r\n\
            To: rcpt@test.com\r\n\
            Subject: Inline image test\r\n\
            MIME-Version: 1.0\r\n\
            Content-Type: multipart/related; boundary=\"boundary1\"\r\n\
            \r\n\
            --boundary1\r\n\
            Content-Type: text/html; charset=\"utf-8\"\r\n\
            \r\n\
            <html><body><img src=\"cid:img1\"></body></html>\r\n\
            --boundary1\r\n\
            Content-Type: image/png\r\n\
            Content-Disposition: inline; filename=\"logo.png\"\r\n\
            Content-ID: <img1>\r\n\
            Content-Transfer-Encoding: base64\r\n\
            \r\n\
            iVBORw0KGgoAAAANSUhEUg==\r\n\
            --boundary1--\r\n";
        let email = parse_eml_bytes_light(raw, 1, vec![]).unwrap();
        assert!(!email.has_attachments, "Inline embedded image should not set has_attachments");
        assert_eq!(email.attachments.len(), 1, "Inline image should still be in attachments list");
    }

    #[test]
    fn eml_with_real_plus_inline_has_attachments_true() {
        let raw = b"From: sender@test.com\r\n\
            To: rcpt@test.com\r\n\
            Subject: Mixed attachments\r\n\
            MIME-Version: 1.0\r\n\
            Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
            \r\n\
            --outer\r\n\
            Content-Type: multipart/related; boundary=\"inner\"\r\n\
            \r\n\
            --inner\r\n\
            Content-Type: text/html; charset=\"utf-8\"\r\n\
            \r\n\
            <html><body><img src=\"cid:img1\"><p>Hello</p></body></html>\r\n\
            --inner\r\n\
            Content-Type: image/png\r\n\
            Content-Disposition: inline; filename=\"logo.png\"\r\n\
            Content-ID: <img1>\r\n\
            Content-Transfer-Encoding: base64\r\n\
            \r\n\
            iVBORw0KGgoAAAANSUhEUg==\r\n\
            --inner--\r\n\
            --outer\r\n\
            Content-Type: application/pdf\r\n\
            Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
            Content-Transfer-Encoding: base64\r\n\
            \r\n\
            JVBERi0xLjQK\r\n\
            --outer--\r\n";
        let email = parse_eml_bytes_light(raw, 1, vec![]).unwrap();
        assert!(email.has_attachments, "Email with real PDF attachment should set has_attachments");
    }
}

#[cfg(test)]
mod purge_tests {
    use super::*;
    use std::collections::HashSet;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn deletes_only_requested_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        touch(cur, "101:2,S");
        touch(cur, "102:2,");
        touch(cur, "103:2,S");
        // A uid that is a prefix of another must not be swept up.
        touch(cur, "1010:2,S");

        let mut uids = HashSet::new();
        uids.insert(101u32);
        uids.insert(103u32);

        let removed = delete_maildir_files(cur, &uids);

        assert_eq!(removed, 2);
        assert!(!cur.join("101:2,S").exists());
        assert!(!cur.join("103:2,S").exists());
        assert!(cur.join("102:2,").exists());
        assert!(cur.join("1010:2,S").exists(), "1010 must survive a purge of 101");
    }

    #[test]
    fn prunes_only_requested_uids_from_index() {
        let tmp = tempfile::tempdir().unwrap();
        let index = tmp.path().join("local-index.json");
        std::fs::write(
            &index,
            r#"[{"uid":101,"subject":"a"},{"uid":102,"subject":"b"},{"uid":103,"subject":"c"}]"#,
        )
        .unwrap();

        let mut uids = HashSet::new();
        uids.insert(102u32);

        prune_local_index(&index, &uids).unwrap();

        let left: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&index).unwrap()).unwrap();
        let kept: Vec<u64> = left.iter().map(|e| e["uid"].as_u64().unwrap()).collect();
        assert_eq!(kept, vec![101, 103]);
    }

    #[test]
    fn missing_index_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mut uids = HashSet::new();
        uids.insert(1u32);
        assert!(prune_local_index(&tmp.path().join("nope.json"), &uids).is_ok());
    }
}

#[cfg(test)]
mod sidecar_order_tests {
    use super::*;

    fn write_meta(dir: &Path) {
        fs::write(dir.join("_meta.json"), br#"{"totalEmails":9}"#).unwrap();
    }

    /// One header sidecar, carrying only the fields the ordering reads.
    fn write_header(dir: &Path, uid: u64, internal_date: &str) {
        let body = serde_json::json!({
            "uid": uid,
            "subject": format!("msg {}", uid),
            "internalDate": internal_date,
        });
        fs::write(dir.join(format!("{}.json", uid)), body.to_string()).unwrap();
    }

    fn returned_uids(json: &str) -> Vec<u64> {
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        parsed["emails"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["uid"].as_u64().unwrap())
            .collect()
    }

    /// An IMAP mailbox: the server issued the uids in arrival order, so the
    /// highest are the newest and the cheap readdir sort is right.
    #[test]
    fn imap_mailbox_takes_the_highest_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        write_header(dir, 1, "2026-01-01T00:00:00Z");
        write_header(dir, 2, "2026-02-01T00:00:00Z");
        write_header(dir, 3, "2026-03-01T00:00:00Z");

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), Some(2))
            .unwrap()
            .unwrap();

        assert_eq!(returned_uids(&out), vec![3, 2]);
    }

    /// A Graph mailbox: uid 1 is the NEWEST message (the seed walked a
    /// `receivedDateTime desc` listing) and uid 4 is the oldest, while uid 5
    /// arrived after the seed and is newer than all of them. Sorting by uid
    /// returns the oldest cached mail — this is the bug.
    #[test]
    fn graph_mailbox_takes_the_newest_dates_not_the_highest_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        write_header(dir, 1, "2026-08-01T00:00:00Z"); // newest at seed time
        write_header(dir, 2, "2026-07-01T00:00:00Z");
        write_header(dir, 3, "2026-06-01T00:00:00Z");
        write_header(dir, 4, "2026-05-01T00:00:00Z"); // oldest at seed time
        write_header(dir, 5, "2026-08-15T00:00:00Z"); // arrived after the seed

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), Some(3))
            .unwrap()
            .unwrap();

        assert_eq!(returned_uids(&out), vec![5, 1, 2]);
    }

    /// `graph_id_map.json` is not a message: it must not be counted, read, or
    /// returned as one.
    #[test]
    fn graph_id_map_is_not_counted_as_a_message() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        write_header(dir, 1, "2026-08-01T00:00:00Z");

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), None)
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();

        assert_eq!(returned_uids(&out), vec![1]);
        assert_eq!(parsed["totalCached"].as_u64(), Some(1));
    }

    /// A header with no date can't be placed in time, so it must never take a
    /// slot from one that can.
    #[test]
    fn undated_graph_header_sorts_last() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        fs::write(dir.join("7.json"), br#"{"uid":7,"subject":"no date"}"#).unwrap();
        write_header(dir, 1, "2026-08-01T00:00:00Z");
        write_header(dir, 2, "2026-07-01T00:00:00Z");

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), Some(2))
            .unwrap()
            .unwrap();

        assert_eq!(returned_uids(&out), vec![1, 2]);
    }

    /// IMAP headers carry RFC 2822 dates; Graph carries RFC 3339. Both parse.
    #[test]
    fn header_date_ms_reads_both_date_formats() {
        let rfc3339 = serde_json::json!({ "internalDate": "2026-08-01T00:00:00Z" });
        let rfc2822 = serde_json::json!({ "date": "Sat, 1 Aug 2026 00:00:00 +0000" });
        let undated = serde_json::json!({ "subject": "x" });

        assert_eq!(header_date_ms(&rfc3339), header_date_ms(&rfc2822));
        assert_eq!(header_date_ms(&undated), i64::MIN);
    }
}
