// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
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
mod dns;
mod external_location;
pub mod graph;
mod imap;
mod migration;
mod move_emails;
mod oauth2;
mod smtp;

#[cfg(target_os = "macos")]
use cocoa::appkit::NSApplication;
#[cfg(target_os = "macos")]
use cocoa::base::nil;
#[cfg(target_os = "macos")]
use cocoa::foundation::NSString;
#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};

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

// Store all credentials as a single JSON object in keychain
// This triggers the keychain modal only once instead of per-account
// Async: runs on background thread so macOS keychain dialog can appear without blocking main thread
#[tauri::command]
async fn store_credentials(credentials: std::collections::HashMap<String, String>) -> Result<(), String> {
    info!("=== STORE CREDENTIALS START ===");
    info!("Storing credentials for {} account(s)", credentials.len());

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
fn check_network_connectivity() -> Result<bool, String> {
    info!("=== CHECK NETWORK CONNECTIVITY START ===");

    // Try to connect to a reliable server
    use std::net::TcpStream;
    use std::time::Duration;

    let hosts = [
        ("8.8.8.8", 53),         // Google DNS
        ("1.1.1.1", 53),         // Cloudflare DNS
        ("208.67.222.222", 53),  // OpenDNS
    ];

    // Use a shorter timeout for faster detection
    let timeout = Duration::from_millis(1500);

    for (host, port) in hosts {
        info!("Trying to connect to {}:{}...", host, port);
        let addr_str = format!("{}:{}", host, port);
        match addr_str.parse::<std::net::SocketAddr>() {
            Ok(addr) => {
                match TcpStream::connect_timeout(&addr, timeout) {
                    Ok(stream) => {
                        // Explicitly drop the stream
                        drop(stream);
                        info!("Network connectivity confirmed via {}", host);
                        info!("=== CHECK NETWORK CONNECTIVITY END (ONLINE) ===");
                        return Ok(true);
                    }
                    Err(e) => {
                        warn!("Failed to connect to {}:{} - Error: {} (kind: {:?})", host, port, e, e.kind());
                    }
                }
            }
            Err(e) => {
                error!("Failed to parse address {}: {}", addr_str, e);
            }
        }
    }

    warn!("No network connectivity detected - all connection attempts failed");
    info!("=== CHECK NETWORK CONNECTIVITY END (OFFLINE) ===");
    Ok(false)
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

fn cache_base_name(account_id: &str, mailbox: &str) -> String {
    format!("{}_{}",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_")
    )
}

#[tauri::command]
async fn save_email_cache(app_handle: tauri::AppHandle, account_id: String, mailbox: String, data: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
        .join("email_cache");

    let base_name = cache_base_name(&account_id, &mailbox);
    let sidecar_dir = base_dir.join(&base_name);

    fs::create_dir_all(&sidecar_dir)
        .map_err(|e| format!("Failed to create sidecar directory: {}", e))?;

    let parsed: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse cache JSON: {}", e))?;

    // Write _meta.json
    let meta = serde_json::json!({
        "totalEmails": parsed.get("totalEmails"),
        "uidValidity": parsed.get("uidValidity"),
        "uidNext": parsed.get("uidNext"),
        "highestModseq": parsed.get("highestModseq"),
        "lastSynced": parsed.get("lastSynced")
    });
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| format!("save_email_cache: failed to serialize _meta.json: {}", e))?;
    fs::write(sidecar_dir.join("_meta.json"), meta_json)
        .map_err(|e| format!("save_email_cache: failed to write _meta.json: {}", e))?;

    // Write individual email files (skip existing for performance)
    let mut valid_uids = std::collections::HashSet::new();
    if let Some(emails) = parsed.get("emails").and_then(|e| e.as_array()) {
        let mut written = 0usize;
        for email in emails {
            if let Some(uid) = email.get("uid").and_then(|u| u.as_u64()) {
                let uid_str = uid.to_string();
                valid_uids.insert(uid_str.clone());
                let file_path = sidecar_dir.join(format!("{}.json", uid_str));
                if !file_path.exists() {
                    let email_json = serde_json::to_string(email)
                        .map_err(|e| format!("save_email_cache: failed to serialize email {}: {}", uid, e))?;
                    fs::write(&file_path, email_json)
                        .map_err(|e| format!("save_email_cache: failed to write email {}: {}", uid, e))?;
                    written += 1;
                }
            }
        }
        info!("Email cache saved: {} new files, {} total UIDs in {}", written, valid_uids.len(), base_name);
    }

    // Clean up stale UID files (UIDs no longer in the list)
    if let Ok(entries) = fs::read_dir(&sidecar_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "_meta.json" { continue; }
            if let Some(uid) = name.strip_suffix(".json") {
                if !valid_uids.contains(uid) {
                    let _ = fs::remove_file(entry.path());
                }
            }
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
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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
    let file = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
        .join("mailboxes")
        .join(&account_id);

    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove mailbox cache: {}", e))?;
    }

    Ok(())
}

// ── Graph ID map cache (UID → Graph message ID) ────────────────────────

#[tauri::command]
fn save_graph_id_map(app_handle: tauri::AppHandle, account_id: String, mailbox: String, data: String) -> Result<(), String> {
    let base_name = cache_base_name(&account_id, &mailbox);
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("save_graph_id_map: could not get app data dir: {}", e))?
        .join("email_cache")
        .join(&base_name);

    fs::create_dir_all(&dir)
        .map_err(|e| format!("save_graph_id_map: failed to create dir: {}", e))?;

    fs::write(dir.join("graph_id_map.json"), data.as_bytes())
        .map_err(|e| format!("save_graph_id_map: failed to write: {}", e))?;

    Ok(())
}

#[tauri::command]
fn load_graph_id_map(app_handle: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    let base_name = cache_base_name(&account_id, &mailbox);
    let file = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("load_graph_id_map: could not get app data dir: {}", e))?
        .join("email_cache")
        .join(&base_name)
        .join("graph_id_map.json");

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
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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
        let base_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Could not get app data directory: {}", e))?
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
        let base_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Could not get app data directory: {}", e))?
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

/// Read emails from sidecar directory. If limit is Some(n), only read the N most recent (highest UIDs).
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

    // Sort descending (newest first) and apply limit
    uids.sort_unstable_by(|a, b| b.cmp(a));
    if let Some(limit) = limit {
        uids.truncate(limit);
    }

    // Read selected email files
    let mut emails: Vec<serde_json::Value> = Vec::with_capacity(uids.len());
    for uid in &uids {
        let file_path = sidecar_dir.join(format!("{}.json", uid));
        if let Ok(data) = fs::read_to_string(&file_path) {
            if let Ok(email) = serde_json::from_str(&data) {
                emails.push(email);
            }
        }
    }

    info!("Sidecar cache loaded: {} of {} emails (limit: {:?})", emails.len(), total_cached, limit);

    // Build response in the same format as the old monolithic cache
    let result = serde_json::json!({
        "emails": emails,
        "totalEmails": meta.get("totalEmails"),
        "totalCached": total_cached,
        "uidValidity": meta.get("uidValidity"),
        "uidNext": meta.get("uidNext"),
        "lastSynced": meta.get("lastSynced")
    });

    serde_json::to_string(&result)
        .map(|s| Some(s))
        .map_err(|e| format!("Failed to serialize sidecar cache: {}", e))
}

/// Load only cache metadata (no emails) — fast, for delta-sync parameters
#[tauri::command]
fn load_email_cache_meta(app_handle: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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

        // Count UID files for totalCached
        let total_cached = fs::read_dir(&sidecar_dir)
            .map(|entries| entries.flatten().filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name != "_meta.json" && name.ends_with(".json")
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

#[tauri::command]
fn clear_email_cache(app_handle: tauri::AppHandle, account_id: Option<String>) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
        .join("email_cache");

    if !cache_dir.exists() {
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

    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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

    fs::write(&dest_path, &decoded)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    info!("Attachment saved to: {}", dest_path);
    Ok(dest_path)
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    info!("show_in_folder called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }

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

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    info!("open_file called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

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

pub fn maildir_cur_path(app_handle: &tauri::AppHandle, account_id: &str, mailbox: &str) -> Result<PathBuf, String> {
    let safe_mailbox = mailbox.chars().map(|c| {
        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }
    }).collect::<String>();
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
    Ok(base.join("Maildir").join(account_id).join(&safe_mailbox).join("cur"))
}

fn parse_flags_from_filename(filename: &str) -> Vec<String> {
    if let Some(flags_part) = filename.split(":2,").nth(1) {
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
        flags
    } else {
        Vec::new()
    }
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

#[tauri::command]
async fn local_index_read(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
) -> Result<Option<String>, String> {
    let data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
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
    let data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
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
    let data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
    let index_path = data_dir.join("maildir").join(&account_id).join(&mailbox).join("local-index.json");

    if !index_path.exists() {
        return Ok(());
    }

    let content = tokio::fs::read_to_string(&index_path).await
        .map_err(|e| format!("Failed to read: {}", e))?;
    let mut entries: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();
    entries.retain(|e| e.get("uid").and_then(|u| u.as_u64()) != Some(uid as u64));

    let data = serde_json::to_string(&entries)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    tokio::fs::write(&index_path, &data).await
        .map_err(|e| format!("Failed to write: {}", e))?;

    Ok(())
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
        None => return Err(format!("Email UID {} not found in Maildir", uid)),
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
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
        .join("Maildir");

    if !base.exists() {
        return Ok(MaildirClearCacheResult { deleted_count: 0, skipped_archived: 0 });
    }

    let mut deleted_count: u32 = 0;
    let mut skipped_archived: u32 = 0;

    for entry in WalkDir::new(&base).into_iter().flatten() {
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

    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
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
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
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

    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
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

    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
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

    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;

    let safe_mailbox = sanitize_mailbox_name(&mailbox);
    let cur_dir = base.join("Maildir").join(&account_id).join(&safe_mailbox).join("cur");

    if !cur_dir.exists() {
        return Err(format!("No emails found for mailbox '{}'", mailbox));
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

    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
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

    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;

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
                    .message("Auto-update is not available for this installation type.\nVisit https://mailvault.app to check for new versions.")
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
                    .message("Could not check for updates.\nVisit https://mailvault.app to check for new versions.")
                    .title("Update Error")
                    .show(|_| {});
            }
        }
    }
}

#[cfg(target_os = "macos")]
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
// Uses Tauri's shell sidecar API so the daemon runs correctly under App Sandbox.

use std::sync::Mutex;
use once_cell::sync::Lazy;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

/// Resolve the real user home directory, bypassing macOS sandbox container redirect.
/// Inside a sandboxed process, dirs::home_dir() returns ~/Library/Containers/<bundle>/Data/
/// instead of the actual /Users/<name>. We use $HOME with validation.
#[cfg(target_os = "macos")]
fn real_home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(&home);
        if p.to_string_lossy().contains("/Library/Containers/") {
            info!("$HOME points to sandbox container ({}), skipping", home);
        } else if p.starts_with("/Users/") && p.is_dir() {
            return Some(p);
        } else {
            warn!("$HOME={} rejected (not /Users/... or not a directory), trying fallback", home);
        }
    }
    if let Some(fb) = dirs::home_dir() {
        if fb.to_string_lossy().contains("/Library/Containers/") {
            warn!("dirs::home_dir() also containerized ({}), no valid home found", fb.display());
            return None;
        }
        if !fb.starts_with("/Users/") || !fb.is_dir() {
            warn!("dirs::home_dir()={} rejected (not /Users/... or not a directory)", fb.display());
            return None;
        }
        return Some(fb);
    }
    None
}

/// Get the daemon socket path. Must match the daemon's get_socket_path().
#[cfg(target_os = "macos")]
fn daemon_socket_path() -> Result<PathBuf, String> {
    let home = real_home_dir().ok_or("Could not resolve real home directory for daemon socket")?;
    let group_dir = home.join("Library/Group Containers/group.com.mailvault");
    let _ = std::fs::create_dir_all(&group_dir);
    Ok(group_dir.join("daemon.sock"))
}

#[cfg(not(target_os = "macos"))]
fn daemon_socket_path() -> Result<PathBuf, String> {
    Ok(std::env::temp_dir().join("daemon.sock"))
}

/// Tracks a daemon child process spawned in on-demand mode.
static DAEMON_CHILD: Lazy<Mutex<Option<CommandChild>>> = Lazy::new(|| Mutex::new(None));

/// Spawn daemon as a child process (on-demand mode). Waits for socket to appear.
fn ensure_daemon_running(app_handle: &tauri::AppHandle, socket_path: &Path) -> Result<(), String> {
    // Already running? Try to connect to existing daemon.
    if socket_path.exists() {
        if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
            info!("Connected to existing daemon at {:?}", socket_path);
            return Ok(());
        }
        // Stale socket — remove it
        info!("Removing stale daemon socket at {:?}", socket_path);
        let _ = std::fs::remove_file(socket_path);
    }

    let mut guard = DAEMON_CHILD.lock().map_err(|e| e.to_string())?;

    // If we have a tracked child but socket is gone, drop it and respawn
    if guard.is_some() {
        // Socket was stale or gone — wait briefly in case daemon is still starting
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if socket_path.exists() { return Ok(()); }
        }
        // Kill stale child and respawn
        if let Some(child) = guard.take() {
            info!("Killing stale daemon child (PID {})", child.pid());
            let _ = child.kill();
        }
    }

    // Spawn new daemon via Tauri sidecar API (works under App Sandbox)
    info!("Spawning daemon on-demand via sidecar API");

    let sidecar_cmd = app_handle.shell().sidecar("mailvault-daemon")
        .map_err(|e| format!("Failed to create daemon sidecar command: {}", e))?;

    let (_rx, child) = sidecar_cmd.spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    let pid = child.pid();
    info!("Daemon spawned with PID {}", pid);
    *guard = Some(child);

    // Wait for socket to appear (up to 5 seconds)
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if socket_path.exists() {
            info!("Daemon socket ready");
            return Ok(());
        }
    }

    Err("Daemon spawned but socket did not appear within 5 seconds".into())
}

/// Kill the on-demand daemon child process (called on app exit).
pub fn shutdown_daemon_child() {
    if let Ok(mut guard) = DAEMON_CHILD.lock() {
        if let Some(child) = guard.take() {
            info!("Shutting down on-demand daemon (PID {})", child.pid());
            let _ = child.kill();
        }
    }
}

// ── Daemon service management (launchd / systemd) ───────────────────────────
// Installs or removes a persistent system service so the daemon survives app exit.

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "com.mailvault.daemon";

/// Install the daemon as a launchd LaunchAgent (macOS) or systemd user service (Linux).
#[tauri::command]
async fn install_daemon_service(app_handle: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // Find daemon binary inside the app bundle
        let daemon_bin = app_handle.path().resource_dir()
            .ok()
            .and_then(|d| {
                let bin = d.join("mailvault-daemon");
                if bin.exists() { return Some(bin); }
                // Sidecar naming: check Contents/MacOS/
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(dir) = exe.parent() {
                        let candidate = dir.join("mailvault-daemon");
                        if candidate.exists() { return Some(candidate); }
                    }
                }
                None
            })
            .ok_or_else(|| "Daemon binary not found in app bundle".to_string())?;

        let daemon_path = daemon_bin.to_string_lossy();
        let socket_path = daemon_socket_path()?;

        let home = real_home_dir().ok_or("Could not resolve real home directory for LaunchAgent")?;
        let plist_dir = home.join("Library/LaunchAgents");
        std::fs::create_dir_all(&plist_dir)
            .map_err(|e| format!("Failed to create LaunchAgents dir: {}", e))?;

        let plist_path = plist_dir.join(format!("{}.plist", LAUNCHD_LABEL));

        let plist_content = format!(
r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>AssociatedBundleIdentifiers</key>
    <string>com.mailvault.app</string>
</dict>
</plist>"#,
            label = LAUNCHD_LABEL,
            bin = daemon_path,
        );

        let uid = unsafe { libc::getuid() };

        // Bootout existing service if present (ignore errors — may not be loaded)
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{}/{}", uid, LAUNCHD_LABEL)])
            .output();

        std::fs::write(&plist_path, &plist_content)
            .map_err(|e| format!("Failed to write plist: {}", e))?;

        // Remove stale socket before loading
        let _ = std::fs::remove_file(&socket_path);

        let output = Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{}", uid), &plist_path.to_string_lossy()])
            .output()
            .map_err(|e| format!("Failed to run launchctl: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("launchctl bootstrap failed: {}", stderr));
        }

        info!("Installed launchd service: {}", LAUNCHD_LABEL);
        Ok(format!("Service installed at {}", plist_path.display()))
    }

    #[cfg(target_os = "linux")]
    {
        let daemon_bin = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join("mailvault-daemon")))
            .filter(|p| p.exists())
            .ok_or_else(|| "Daemon binary not found".to_string())?;

        let unit_dir = dirs::config_dir()
            .ok_or("Could not determine config directory")?
            .join("systemd/user");
        std::fs::create_dir_all(&unit_dir)
            .map_err(|e| format!("Failed to create systemd user dir: {}", e))?;

        let unit_path = unit_dir.join("mailvault-daemon.service");
        let unit_content = format!(
            "[Unit]\nDescription=MailVault Background Daemon\n\n[Service]\nExecStart={}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
            daemon_bin.display()
        );

        std::fs::write(&unit_path, &unit_content)
            .map_err(|e| format!("Failed to write unit file: {}", e))?;

        Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output()
            .map_err(|e| format!("systemctl daemon-reload failed: {}", e))?;

        let output = Command::new("systemctl")
            .args(["--user", "enable", "--now", "mailvault-daemon.service"])
            .output()
            .map_err(|e| format!("systemctl enable failed: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("systemctl enable failed: {}", stderr));
        }

        info!("Installed systemd user service: mailvault-daemon.service");
        Ok(format!("Service installed at {}", unit_path.display()))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err("Daemon service not supported on this platform".to_string())
}

/// Uninstall the daemon system service.
#[tauri::command]
async fn uninstall_daemon_service() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home = real_home_dir().ok_or("Could not resolve real home directory")?;
        let plist_path = home.join(format!("Library/LaunchAgents/{}.plist", LAUNCHD_LABEL));

        if plist_path.exists() {
            let uid = unsafe { libc::getuid() };
            let _ = Command::new("launchctl")
                .args(["bootout", &format!("gui/{}/{}", uid, LAUNCHD_LABEL)])
                .output();
            std::fs::remove_file(&plist_path)
                .map_err(|e| format!("Failed to remove plist: {}", e))?;
        }

        info!("Uninstalled launchd service: {}", LAUNCHD_LABEL);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", "mailvault-daemon.service"])
            .output();

        let unit_path = dirs::config_dir()
            .ok_or("Could not determine config directory")?
            .join("systemd/user/mailvault-daemon.service");

        if unit_path.exists() {
            std::fs::remove_file(&unit_path)
                .map_err(|e| format!("Failed to remove unit file: {}", e))?;
        }

        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output();

        info!("Uninstalled systemd user service");
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err("Daemon service not supported on this platform".to_string())
}

/// Check if the daemon system service is installed.
#[tauri::command]
async fn is_daemon_service_installed() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let plist_path = real_home_dir()
            .ok_or("Could not resolve real home directory")?
            .join(format!("Library/LaunchAgents/{}.plist", LAUNCHD_LABEL));
        Ok(plist_path.exists())
    }

    #[cfg(target_os = "linux")]
    {
        let unit_path = dirs::config_dir()
            .ok_or("Could not determine config directory")?
            .join("systemd/user/mailvault-daemon.service");
        Ok(unit_path.exists())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Ok(false)
}

// ── Daemon RPC — per-request connections with cached auth token ──────────────
// Each request gets its own socket (supports full concurrency).
// Token and daemon-spawn state are cached to avoid redundant I/O.

static DAEMON_TOKEN_CACHE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static DAEMON_SPAWNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
async fn daemon_rpc(
    app_handle: tauri::AppHandle,
    method: String,
    params: serde_json::Value,
    #[allow(unused)] daemon_mode: Option<String>,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    static RPC_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;

    // Socket path must be short (SUN_LEN ≤ 104 bytes) and accessible from both
    // the sandboxed app and the launchd-launched daemon. The App Group container
    // satisfies both constraints (~69 bytes, shared via group.com.mailvault entitlement).
    let socket_path = daemon_socket_path()?;

    // Spawn daemon once (not on every call)
    if !DAEMON_SPAWNED.load(std::sync::atomic::Ordering::Relaxed) {
        let mode = daemon_mode.as_deref().unwrap_or("on-demand");
        if mode == "always-on" {
            // In always-on mode, never spawn — the system service manages the daemon.
            // Just check if it's reachable.
            if !socket_path.exists() || std::os::unix::net::UnixStream::connect(&socket_path).is_err() {
                return Err("Daemon not running. Install the daemon service in Settings > Background Daemon.".to_string());
            }
        } else {
            ensure_daemon_running(&app_handle, &socket_path)?;
        }
        DAEMON_SPAWNED.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    // Read token once, cache for future calls
    let token = {
        let guard = DAEMON_TOKEN_CACHE.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let token = match token {
        Some(t) => t,
        None => {
            let t = std::fs::read_to_string(data_dir.join("daemon.token"))
                .map_err(|_| "Daemon token not found — is the daemon running?".to_string())?
                .trim().to_string();
            if let Ok(mut g) = DAEMON_TOKEN_CACHE.lock() { *g = Some(t.clone()); }
            t
        }
    };

    // Per-request connection (supports full concurrency)
    let stream = tokio::net::UnixStream::connect(&socket_path)
        .await
        .map_err(|e| format!("Cannot connect to daemon — is it running? ({})", e))?;

    let (reader, mut writer) = stream.into_split();
    let mut lines = tokio::io::BufReader::new(reader).lines();

    // Auth handshake (fast — token is cached)
    let mut buf = serde_json::to_vec(&serde_json::json!({"token": token})).unwrap();
    buf.push(b'\n');
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;

    let auth_resp = lines.next_line().await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Daemon closed connection during auth".to_string())?;

    if serde_json::from_str::<serde_json::Value>(&auth_resp)
        .ok().and_then(|v| v.get("error").cloned()).is_some() {
        return Err("Daemon authentication failed".to_string());
    }

    // Send request
    let id = RPC_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut buf = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0", "method": method, "params": params, "id": id,
    })).unwrap();
    buf.push(b'\n');
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;

    // Read response
    let resp_line = lines.next_line().await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Daemon closed connection before responding".to_string())?;

    let resp: serde_json::Value = serde_json::from_str(&resp_line)
        .map_err(|e| format!("Invalid RPC response: {}", e))?;

    if let Some(error) = resp.get("error") {
        return Err(error.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown daemon error").to_string());
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

    // Linux fallback: flock-based lock to prevent multiple instances.
    // The tauri-plugin-single-instance uses D-Bus which may not work in all Linux environments
    // (AppImage, Snap, restricted D-Bus sessions). flock is kernel-managed: automatically
    // released on process exit (even SIGKILL/crash), works in Snap strict confinement,
    // and has no stale lock issues.
    // When a second instance detects the lock, it sends SIGUSR1 to the running instance
    // which triggers window show+focus (handles clicking the app icon while already running).
    #[cfg(target_os = "linux")]
    let _lock_file = {
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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // When a second instance is launched, focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    // Updater plugins — Sparkle on macOS, tauri-plugin-updater on Linux
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_sparkle_updater::init());
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
        .manage(archive::ArchiveCancelToken::default())
        .manage(backup::BackupCancelToken::default())
        .manage(migration::MigrationCancelToken::default())
        .manage(migration::MigrationPauseToken::default())
        .manage(migration::MigrationNotify::default())
        .manage(imap::ImapPool::new())
        .manage(oauth2::OAuth2Manager::new())
        .manage(UpdateCheckGuard::default());

    #[cfg(target_os = "linux")]
    let builder = builder.manage(PendingUpdate::default());

    let app = builder
        .invoke_handler(tauri::generate_handler![
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
            clear_email_cache,
            save_mailbox_cache,
            load_mailbox_cache,
            delete_mailbox_cache,
            save_graph_id_map,
            load_graph_id_map,
            save_attachment,
            save_attachment_to,
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
            maildir_set_flags,
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
            archive_emails,
            cancel_archive,
            bulk_delete_emails,
            verify_archived_emails,
            read_pending_operation,
            save_pending_operation,
            clear_pending_operation,
            commands::imap_test_connection,
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
            commands::imap_fetch_raw,
            commands::imap_append_email,
            commands::smtp_send_email,
            commands::imap_search_emails,
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
            commands::backup_run_account,
            commands::backup_status,
            commands::backup_cancel,
            commands::backup_save_external_location,
            commands::backup_get_external_location,
            commands::backup_validate_external_location,
            commands::backup_clear_external_location,
            commands::backup_resolve_external_location,
            commands::backup_migrate_legacy_path,
            commands::start_migration,
            commands::cancel_migration,
            commands::pause_migration,
            commands::resume_migration,
            commands::get_migration_state,
            commands::clear_migration_state_cmd,
            commands::count_migration_folders,
            commands::get_folder_mappings,
            daemon_rpc,
            install_daemon_service,
            uninstall_daemon_service,
            is_daemon_service_installed
        ])
        .setup(|app| {
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

            info!("MailVault application starting");
            info!("App version: {}", env!("CARGO_PKG_VERSION"));

            // --- Set up app menu ---
            let check_updates = MenuItem::with_id(app, "check_updates", "Check for Updates...", true, None::<&str>)?;
            #[cfg(target_os = "macos")]
            let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("cmd+,"))?;
            #[cfg(not(target_os = "macos"))]
            let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("ctrl+,"))?;
            let report_bug = MenuItem::with_id(app, "report_bug", "Report Bug...", true, None::<&str>)?;
            let export_logs = MenuItem::with_id(app, "export_logs", "Export Logs...", true, None::<&str>)?;
            let logs_submenu = Submenu::with_id(app, "logs_submenu", "Logs", true)?;
            logs_submenu.append(&export_logs)?;

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
                            let _ = app_submenu.insert(&check_updates, 2);
                            let _ = app_submenu.insert(&open_settings, 3);
                            let _ = app_submenu.insert(&report_bug, 4);
                            let _ = app_submenu.insert(&sep2, 5);
                        }
                    }
                }
                menu.append(&logs_submenu)?;

                // Populate the Help menu (default menu creates it empty)
                let website_item = MenuItem::with_id(app, "open_website", "MailVault Website", true, None::<&str>)?;
                let shortcuts_item = MenuItem::with_id(app, "open_shortcuts", "Keyboard Shortcuts", true, Some("cmd+/"))?;
                if let Ok(items) = menu.items() {
                    for item in &items {
                        if let Some(sub) = item.as_submenu() {
                            if sub.text().unwrap_or_default() == "Help" {
                                let _ = sub.append(&website_item);
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
                    let _ = app_handle_for_menu.shell().open("https://mailvault.app", None::<tauri_plugin_shell::open::Program>);
                } else if event.id().as_ref() == "open_shortcuts" {
                    let _ = app_handle_for_menu.emit("open-shortcuts", ());
                } else if event.id().as_ref() == "quit_app" {
                    info!("Application quitting via menu");
                    app_handle_for_menu.exit(0);
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
                            app.exit(0);
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
                    info!("Application exiting — cleaning up daemon child if on-demand");
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
