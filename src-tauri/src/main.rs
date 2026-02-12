// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_updater::UpdaterExt;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Child};
use std::sync::Mutex;
use keyring::Entry;
use tracing::{info, warn, error, Level};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_appender::rolling::{RollingFileAppender, Rotation};

#[cfg(target_os = "macos")]
use cocoa::appkit::NSApplication;
#[cfg(target_os = "macos")]
use cocoa::base::nil;
#[cfg(target_os = "macos")]
use cocoa::foundation::NSString;
#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};

// Global server process handle
struct ServerState(Mutex<Option<Child>>);

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

#[allow(unused_variables)]
fn start_backend_server(app_handle: &tauri::AppHandle) -> Option<Child> {
    info!("Starting backend server...");

    #[cfg(debug_assertions)]
    {
        info!("Running in development mode");

        let server_path = std::env::current_dir()
            .ok()
            .map(|p| p.join("server").join("index.js"));

        if let Some(path) = server_path {
            info!("Server path: {:?}", path);
            if path.exists() {
                match Command::new("node")
                    .arg(&path)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                {
                    Ok(child) => {
                        info!("Server started with PID: {}", child.id());
                        return Some(child);
                    }
                    Err(e) => {
                        error!("Failed to start server: {}", e);
                    }
                }
            } else {
                warn!("Server path does not exist: {:?}", path);
            }
        }

        warn!("Start the server manually with 'npm run server'");
        None
    }

    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_shell::ShellExt;
        use tauri_plugin_shell::process::CommandEvent;

        info!("Running in release mode, using sidecar");

        match app_handle.shell().sidecar("mailvault-server") {
            Ok(cmd) => {
                match cmd.spawn() {
                    Ok((mut rx, _child)) => {
                        tauri::async_runtime::spawn(async move {
                            while let Some(event) = rx.recv().await {
                                match event {
                                    CommandEvent::Stdout(line) => info!("[Server] {}", String::from_utf8_lossy(&line)),
                                    CommandEvent::Stderr(line) => warn!("[Server] {}", String::from_utf8_lossy(&line)),
                                    CommandEvent::Error(e) => error!("[Server Error] {}", e),
                                    CommandEvent::Terminated(p) => {
                                        info!("[Server] Terminated: {:?}", p.code);
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        });
                        info!("Sidecar server started");
                        return None;
                    }
                    Err(e) => error!("Failed to spawn sidecar: {}", e),
                }
            }
            Err(e) => error!("Failed to create sidecar command: {}", e),
        }
        None
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
fn request_notification_permission() -> Result<bool, String> {
    info!("request_notification_permission called");

    #[cfg(target_os = "macos")]
    {
        let script = r#"
            tell application "System Events"
                display notification "MailVault notifications are now enabled" with title "Notifications Enabled"
            end tell
        "#;
        let result = std::process::Command::new("osascript")
            .args(["-e", script])
            .output();

        match result {
            Ok(output) => {
                if output.status.success() {
                    info!("Notification permission request sent");
                    Ok(true)
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    warn!("Notification permission may need to be enabled in System Preferences: {}", stderr);
                    Ok(false)
                }
            }
            Err(e) => {
                error!("Failed to request notification permission: {}", e);
                Err(format!("Failed to request notification permission: {}", e))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
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
fn send_notification(title: String, body: String) -> Result<(), String> {
    info!("send_notification called: {} - {}", title, body);

    #[cfg(target_os = "macos")]
    {
        // Use macOS native notification via osascript
        let script = format!(
            r#"display notification "{}" with title "{}""#,
            body.replace("\"", "\\\""),
            title.replace("\"", "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to send notification: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Windows toast notification via PowerShell
        let script = format!(
            r#"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $textNodes = $template.GetElementsByTagName('text'); $textNodes.Item(0).AppendChild($template.CreateTextNode('{}')) | Out-Null; $textNodes.Item(1).AppendChild($template.CreateTextNode('{}')) | Out-Null; $toast = [Windows.UI.Notifications.ToastNotification]::new($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MailVault').Show($toast)"#,
            title.replace("'", "''"),
            body.replace("'", "''")
        );
        std::process::Command::new("powershell")
            .args(["-Command", &script])
            .spawn()
            .map_err(|e| format!("Failed to send notification: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("notify-send")
            .args([&title, &body])
            .spawn()
            .map_err(|e| format!("Failed to send notification: {}", e))?;
    }

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

fn main() {
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
        .manage(ServerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_app_data_dir,
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
            open_with_dialog
        ])
        .setup(|app| {
            // Set up logging to app log directory
            let log_dir = get_log_dir(&app.handle());
            let _guard = setup_logging(&log_dir);

            // Store the guard to keep logging alive
            std::mem::forget(_guard);

            // Clean up old logs
            cleanup_old_logs(&log_dir);

            // Store log directory for later use
            app.manage(LogDir(log_dir));

            info!("MailVault application starting");
            info!("App version: {}", env!("CARGO_PKG_VERSION"));

            // --- Set up app menu ---
            let check_updates = MenuItem::with_id(app, "check_updates", "Check for Updates...", true, None::<&str>)?;
            let export_logs = MenuItem::with_id(app, "export_logs", "Export Logs...", true, None::<&str>)?;
            let logs_submenu = Submenu::with_id(app, "logs_submenu", "Logs", true)?;
            logs_submenu.append(&export_logs)?;

            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                // Insert "Check for Updates..." into the app submenu (first submenu)
                if let Ok(items) = menu.items() {
                    if let Some(first) = items.first() {
                        if let Some(app_submenu) = first.as_submenu() {
                            let sep = PredefinedMenuItem::separator(app)?;
                            let _ = app_submenu.append(&sep);
                            let _ = app_submenu.append(&check_updates);
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
                            if let Some(state) = app.try_state::<ServerState>() {
                                if let Ok(mut guard) = state.0.lock() {
                                    if let Some(ref mut child) = *guard {
                                        let _ = child.kill();
                                    }
                                }
                            }
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Start the backend server
            let server_child = start_backend_server(&app.handle());

            // Store server process handle for cleanup
            if let Some(child) = server_child {
                if let Some(state) = app.try_state::<ServerState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                }
            }

            // Check for updates in background
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Delay update check to let the app initialize first
                std::thread::sleep(std::time::Duration::from_secs(5));

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
                info!("Window close requested, hiding to tray");
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
}
