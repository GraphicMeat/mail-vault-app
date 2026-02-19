// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_updater::UpdaterExt;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error, Level};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use walkdir::WalkDir;

mod archive;
mod commands;
mod imap;
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
#[tauri::command]
fn store_credentials(credentials: std::collections::HashMap<String, String>) -> Result<(), String> {
    info!("=== STORE CREDENTIALS START ===");
    info!("Storing credentials for {} account(s)", credentials.len());

    let json = serde_json::to_string(&credentials)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

    let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    entry.set_password(&json)
        .map_err(|e| format!("Failed to store credentials: {}", e))?;

    info!("Credentials stored successfully for {} account(s)", credentials.len());
    info!("=== STORE CREDENTIALS END ===");
    Ok(())
}

// Get all credentials as a single JSON object from keychain
#[tauri::command]
fn get_credentials() -> Result<std::collections::HashMap<String, String>, String> {
    info!("=== GET CREDENTIALS START ===");

    let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    let json = entry.get_password()
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let credentials: std::collections::HashMap<String, String> = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse credentials: {}", e))?;

    info!("Retrieved credentials for {} account(s)", credentials.len());
    info!("=== GET CREDENTIALS END ===");
    Ok(credentials)
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

// Email cache file operations
#[tauri::command]
fn save_email_cache(app_handle: tauri::AppHandle, account_id: String, mailbox: String, data: String) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
        .join("email_cache");

    // Create cache directory if it doesn't exist
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache directory: {}", e))?;

    // Create a safe filename from account_id and mailbox
    let safe_name = format!("{}_{}.json",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_")
    );
    let cache_file = cache_dir.join(&safe_name);

    info!("Saving email cache to {:?} ({} bytes)", cache_file, data.len());

    fs::write(&cache_file, &data)
        .map_err(|e| format!("Failed to write cache file: {}", e))?;

    info!("Email cache saved successfully");
    Ok(())
}

#[tauri::command]
fn load_email_cache(app_handle: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?
        .join("email_cache");

    let safe_name = format!("{}_{}.json",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_")
    );
    let cache_file = cache_dir.join(&safe_name);

    if !cache_file.exists() {
        info!("No cache file found at {:?}", cache_file);
        return Ok(None);
    }

    info!("Loading email cache from {:?}", cache_file);

    let data = fs::read_to_string(&cache_file)
        .map_err(|e| format!("Failed to read cache file: {}", e))?;

    info!("Email cache loaded successfully ({} bytes)", data.len());
    Ok(Some(data))
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
        // Clear cache for specific account
        let prefix = account_id.replace(|c: char| !c.is_alphanumeric(), "_");
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) {
                    let _ = fs::remove_file(entry.path());
                    info!("Removed cache file: {:?}", entry.path());
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
    info!("set_badge_count called with count: {}", count);

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
                .unwrap(),
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
struct LightEmail {
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

fn parse_eml_bytes_light(raw: &[u8], uid: u32, flags: Vec<String>) -> Result<LightEmail, String> {
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
    state.0.lock().unwrap().store(true, std::sync::atomic::Ordering::Relaxed);
    info!("cancel_archive: cancellation requested");
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

#[tauri::command]
fn maildir_list(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    require_flag: Option<String>,
) -> Result<Vec<MaildirEmailSummary>, String> {
    let cur_dir = maildir_cur_path(&app_handle, &account_id, &mailbox)?;

    if !cur_dir.exists() {
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

        if let Some(ref required) = require_flag {
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

    Ok(results)
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

            let cur_dir = path.parent().unwrap();
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
    }

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

    tauri::Builder::default()
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .manage(archive::ArchiveCancelToken::default())
        .manage(imap::ImapPool::new())
        .manage(oauth2::OAuth2Manager::new())
        .invoke_handler(tauri::generate_handler![
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
            clear_email_cache,
            save_attachment,
            save_attachment_to,
            show_in_folder,
            open_file,
            open_with_dialog,
            open_email_window,
            maildir_store,
            maildir_read,
            maildir_read_light,
            maildir_read_attachment,
            maildir_read_raw_source,
            maildir_exists,
            maildir_list,
            maildir_delete,
            maildir_set_flags,
            maildir_storage_stats,
            maildir_migrate_json_to_eml,
            export_backup,
            import_backup,
            archive_emails,
            cancel_archive,
            commands::imap_test_connection,
            commands::imap_get_mailboxes,
            commands::imap_get_emails,
            commands::imap_get_emails_range,
            commands::imap_check_mailbox_status,
            commands::imap_search_all_uids,
            commands::imap_fetch_headers_by_uids,
            commands::imap_get_email,
            commands::imap_get_email_light,
            commands::imap_set_flags,
            commands::imap_delete_email,
            commands::smtp_send_email,
            commands::imap_search_emails,
            commands::imap_disconnect,
            commands::oauth2_auth_url,
            commands::oauth2_exchange,
            commands::oauth2_refresh
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
            let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("cmd+,"))?;
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
                            let _ = app_submenu.insert(&sep2, 4);
                        }
                    }
                }
                menu.append(&logs_submenu)?;
                app.set_menu(menu)?;
            }

            #[cfg(not(target_os = "macos"))]
            {
                let quit_item = PredefinedMenuItem::quit(app, Some("Quit"))?;
                let file_submenu = Submenu::with_id(app, "file_submenu", "File", true)?;
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
                        use tauri_plugin_updater::UpdaterExt;
                        use tauri_plugin_dialog::DialogExt;
                        info!("Manual update check triggered");
                        let updater = match handle.updater() {
                            Ok(u) => u,
                            Err(e) => {
                                error!("Failed to create updater: {}", e);
                                handle.dialog()
                                    .message(format!("Failed to check for updates: {}", e))
                                    .title("Update Error")
                                    .show(|_| {});
                                return;
                            }
                        };
                        match updater.check().await {
                            Ok(Some(update)) => {
                                info!("Update available: {}", update.version);
                                let version = update.version.clone();
                                let body = update.body.clone().unwrap_or_default();
                                let handle_clone = handle.clone();
                                handle.dialog()
                                    .message(format!(
                                        "A new version of MailVault is available!\n\nCurrent: v{}\nNew: v{}\n\n{}",
                                        env!("CARGO_PKG_VERSION"), version, body
                                    ))
                                    .title("Update Available")
                                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("Update Now".to_string(), "Later".to_string()))
                                    .show(move |confirmed| {
                                        if confirmed {
                                            let h = handle_clone.clone();
                                            tauri::async_runtime::spawn(async move {
                                                match update.download_and_install(|_, _| {}, || {}).await {
                                                    Ok(_) => { h.restart(); }
                                                    Err(e) => { error!("Failed to install update: {}", e); }
                                                }
                                            });
                                        }
                                    });
                            }
                            Ok(None) => {
                                handle.dialog()
                                    .message(format!("You're running the latest version (v{}).", env!("CARGO_PKG_VERSION")))
                                    .title("No Updates Available")
                                    .show(|_| {});
                            }
                            Err(e) => {
                                error!("Update check failed: {}", e);
                                handle.dialog()
                                    .message(format!("Failed to check for updates: {}", e))
                                    .title("Update Error")
                                    .show(|_| {});
                            }
                        }
                    });
                } else if event.id().as_ref() == "open_settings" {
                    let _ = app_handle_for_menu.emit("open-settings", ());
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

                info!("Checking for updates...");
                let updater = match update_handle.updater() {
                    Ok(u) => u,
                    Err(e) => {
                        warn!("Failed to create updater: {}", e);
                        return;
                    }
                };
                match updater.check().await {
                    Ok(Some(update)) => {
                        info!("Update available: {} -> {}", env!("CARGO_PKG_VERSION"), update.version);

                        use tauri_plugin_dialog::DialogExt;
                        let version = update.version.clone();
                        let body = update.body.clone().unwrap_or_default();

                        let handle_clone = update_handle.clone();
                        update_handle.dialog()
                            .message(format!(
                                "A new version of MailVault is available!\n\nCurrent: v{}\nNew: v{}\n\n{}",
                                env!("CARGO_PKG_VERSION"),
                                version,
                                body
                            ))
                            .title("Update Available")
                            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("Update Now".to_string(), "Later".to_string()))
                            .show(move |confirmed| {
                                if confirmed {
                                    info!("User accepted update, downloading...");
                                    let handle = handle_clone.clone();
                                    tauri::async_runtime::spawn(async move {
                                        match update.download_and_install(|_, _| {}, || {}).await {
                                            Ok(_) => {
                                                info!("Update installed successfully, restarting...");
                                                handle.restart();
                                            }
                                            Err(e) => {
                                                error!("Failed to install update: {}", e);
                                            }
                                        }
                                    });
                                } else {
                                    info!("User deferred update");
                                }
                            });
                    }
                    Ok(None) => {
                        info!("No updates available");
                    }
                    Err(e) => {
                        warn!("Failed to check for updates: {}", e);
                    }
                }
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
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                tauri::RunEvent::Exit => {
                    info!("Application exiting");
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
