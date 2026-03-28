//! External backup location management.
//!
//! On macOS sandboxed builds, user-selected folders must be persisted as
//! security-scoped bookmarks so the app can re-access them after restart.
//! On Linux, plain paths are sufficient.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalLocation {
    #[serde(rename = "displayPath")]
    pub display_path: String,
    pub platform: String,
    pub status: String, // "ready" | "needs_reauth" | "unavailable" | "invalid" | "not_configured"
    #[serde(rename = "lastValidatedAt", skip_serializing_if = "Option::is_none")]
    pub last_validated_at: Option<u64>,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Get the file where we persist the bookmark/path data.
fn bookmark_file(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join("external-backup-bookmark")
}

fn meta_file(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join("external-backup-meta.json")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── macOS implementation ────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    /// Create a security-scoped bookmark from a URL.
    /// Returns the raw bookmark bytes.
    pub fn create_bookmark(path: &str) -> Result<Vec<u8>, String> {
        unsafe {
            let url = path_to_nsurl(path)?;
            let options: usize = 1 << 11; // NSURLBookmarkCreationWithSecurityScope
            let nil: *const Object = std::ptr::null();

            let mut error: *const Object = std::ptr::null();
            let bookmark_data: *const Object = msg_send![url,
                bookmarkDataWithOptions: options
                includingResourceValuesForKeys: nil
                relativeToURL: nil
                error: &mut error
            ];

            if bookmark_data.is_null() {
                let desc = if !error.is_null() {
                    let desc: *const Object = msg_send![error, localizedDescription];
                    nsstring_to_string(desc)
                } else {
                    "Unknown error".to_string()
                };
                return Err(format!("Failed to create bookmark: {}", desc));
            }

            let length: usize = msg_send![bookmark_data, length];
            let bytes: *const u8 = msg_send![bookmark_data, bytes];
            Ok(std::slice::from_raw_parts(bytes, length).to_vec())
        }
    }

    /// Resolve a security-scoped bookmark back to a URL path.
    /// Returns (path, is_stale).
    pub fn resolve_bookmark(bookmark_bytes: &[u8]) -> Result<(String, bool), String> {
        unsafe {
            let nsdata = bytes_to_nsdata(bookmark_bytes);
            let options: usize = 1 << 10; // NSURLBookmarkResolutionWithSecurityScope
            let nil: *const Object = std::ptr::null();
            let mut is_stale: bool = false;
            let mut error: *const Object = std::ptr::null();

            let url: *const Object = msg_send![class!(NSURL),
                URLByResolvingBookmarkData: nsdata
                options: options
                relativeToBookmarkURL: nil
                bookmarkDataIsStale: &mut is_stale
                error: &mut error
            ];

            if url.is_null() {
                let desc = if !error.is_null() {
                    let desc: *const Object = msg_send![error, localizedDescription];
                    nsstring_to_string(desc)
                } else {
                    "Unknown error".to_string()
                };
                return Err(format!("Failed to resolve bookmark: {}", desc));
            }

            let path: *const Object = msg_send![url, path];
            let path_str = nsstring_to_string(path);
            Ok((path_str, is_stale))
        }
    }

    /// Start security-scoped access for a bookmark-resolved URL.
    pub fn start_access(path: &str) -> Result<(), String> {
        unsafe {
            let url = path_to_nsurl(path)?;
            let ok: bool = msg_send![url, startAccessingSecurityScopedResource];
            if ok {
                Ok(())
            } else {
                Err("startAccessingSecurityScopedResource returned NO".to_string())
            }
        }
    }

    /// Stop security-scoped access.
    pub fn stop_access(path: &str) {
        unsafe {
            if let Ok(url) = path_to_nsurl(path) {
                let _: () = msg_send![url, stopAccessingSecurityScopedResource];
            }
        }
    }

    // ── Helpers ──

    unsafe fn path_to_nsurl(path: &str) -> Result<*const Object, String> {
        let nsstring = string_to_nsstring(path);
        let url: *const Object = msg_send![class!(NSURL), fileURLWithPath: nsstring];
        if url.is_null() {
            Err(format!("Invalid path: {}", path))
        } else {
            Ok(url)
        }
    }

    unsafe fn string_to_nsstring(s: &str) -> *const Object {
        let cls = class!(NSString);
        let bytes = s.as_ptr();
        let len = s.len();
        let nsstring: *const Object = msg_send![cls, alloc];
        msg_send![nsstring, initWithBytes:bytes length:len encoding:4u64] // NSUTF8StringEncoding = 4
    }

    unsafe fn nsstring_to_string(ns: *const Object) -> String {
        if ns.is_null() { return String::new(); }
        let c_str: *const i8 = msg_send![ns, UTF8String];
        if c_str.is_null() { return String::new(); }
        std::ffi::CStr::from_ptr(c_str).to_string_lossy().into_owned()
    }

    unsafe fn bytes_to_nsdata(bytes: &[u8]) -> *const Object {
        let cls = class!(NSData);
        let nsdata: *const Object = msg_send![cls, alloc];
        msg_send![nsdata, initWithBytes:bytes.as_ptr() length:bytes.len()]
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Choose an external backup folder (called after dialog picker).
/// On macOS: creates and persists a security-scoped bookmark.
/// On Linux: just persists the path string.
pub fn save_external_location(app_data_dir: &std::path::Path, path: &str) -> Result<ExternalLocation, String> {
    fs::create_dir_all(app_data_dir).map_err(|e| format!("Cannot create app data dir: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        let bookmark = macos::create_bookmark(path)?;
        fs::write(bookmark_file(app_data_dir), &bookmark)
            .map_err(|e| format!("Failed to save bookmark: {}", e))?;
        info!("[external_location] Saved macOS security-scoped bookmark for {}", path);
    }

    #[cfg(not(target_os = "macos"))]
    {
        fs::write(bookmark_file(app_data_dir), path.as_bytes())
            .map_err(|e| format!("Failed to save path: {}", e))?;
        info!("[external_location] Saved path for {}", path);
    }

    // Save metadata
    let meta = serde_json::json!({
        "displayPath": path,
        "platform": std::env::consts::OS,
        "savedAt": now_millis(),
    });
    let _ = fs::write(meta_file(app_data_dir), meta.to_string());

    validate_external_location(app_data_dir)
}

/// Resolve and validate the saved external location.
/// On macOS: resolves the security-scoped bookmark and starts access.
/// Returns the location with current status.
pub fn resolve_external_location(app_data_dir: &std::path::Path) -> Result<(String, ExternalLocation), String> {
    let bf = bookmark_file(app_data_dir);
    if !bf.exists() {
        return Err("No external backup location configured".to_string());
    }

    let meta: serde_json::Value = fs::read_to_string(meta_file(app_data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let display_path = meta["displayPath"].as_str().unwrap_or("").to_string();

    #[cfg(target_os = "macos")]
    {
        let bookmark_bytes = fs::read(&bf)
            .map_err(|e| format!("Failed to read bookmark: {}", e))?;

        match macos::resolve_bookmark(&bookmark_bytes) {
            Ok((resolved_path, is_stale)) => {
                if is_stale {
                    warn!("[external_location] Bookmark is stale for {}, needs re-creation", resolved_path);
                    // Try to re-create the bookmark with the resolved path
                    if let Ok(new_bookmark) = macos::create_bookmark(&resolved_path) {
                        let _ = fs::write(&bf, &new_bookmark);
                    }
                }

                match macos::start_access(&resolved_path) {
                    Ok(()) => {
                        info!("[external_location] Security-scoped access started for {}", resolved_path);
                        let loc = ExternalLocation {
                            display_path: if display_path.is_empty() { resolved_path.clone() } else { display_path },
                            platform: "macos".to_string(),
                            status: "ready".to_string(),
                            last_validated_at: Some(now_millis()),
                            last_error: None,
                        };
                        Ok((resolved_path, loc))
                    }
                    Err(e) => {
                        warn!("[external_location] Failed to start access: {}", e);
                        let loc = ExternalLocation {
                            display_path,
                            platform: "macos".to_string(),
                            status: "needs_reauth".to_string(),
                            last_validated_at: Some(now_millis()),
                            last_error: Some(e),
                        };
                        Err(serde_json::to_string(&loc).unwrap_or_default())
                    }
                }
            }
            Err(e) => {
                warn!("[external_location] Failed to resolve bookmark: {}", e);
                let loc = ExternalLocation {
                    display_path,
                    platform: "macos".to_string(),
                    status: "needs_reauth".to_string(),
                    last_validated_at: Some(now_millis()),
                    last_error: Some(e),
                };
                Err(serde_json::to_string(&loc).unwrap_or_default())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let path = fs::read_to_string(&bf)
            .map_err(|e| format!("Failed to read path: {}", e))?;
        let path = path.trim().to_string();
        let dp = if display_path.is_empty() { path.clone() } else { display_path };
        let snap = is_snap_confined();
        let packaging = if snap { "snap" } else { "deb" };

        if !std::path::Path::new(&path).exists() {
            let loc = ExternalLocation {
                display_path: dp,
                platform: format!("linux-{}", packaging),
                status: "unavailable".to_string(),
                last_validated_at: Some(now_millis()),
                last_error: Some("Directory does not exist or is disconnected".to_string()),
            };
            return Err(serde_json::to_string(&loc).unwrap_or_default());
        }

        // Snap confinement: test actual write access (may be blocked by AppArmor)
        if snap {
            let test_file = PathBuf::from(&path).join(".mailvault-snap-test");
            match fs::write(&test_file, b"test") {
                Ok(()) => { let _ = fs::remove_file(&test_file); }
                Err(e) => {
                    let loc = ExternalLocation {
                        display_path: dp,
                        platform: "linux-snap".to_string(),
                        status: "invalid".to_string(),
                        last_validated_at: Some(now_millis()),
                        last_error: Some(format!("Snap confinement blocks write access: {}. Choose a path inside ~/snap/mailvault/ or your home directory.", e)),
                    };
                    return Err(serde_json::to_string(&loc).unwrap_or_default());
                }
            }
        }

        let loc = ExternalLocation {
            display_path: dp,
            platform: format!("linux-{}", packaging),
            status: "ready".to_string(),
            last_validated_at: Some(now_millis()),
            last_error: None,
        };
        Ok((path, loc))
    }
}

/// Stop security-scoped access (call after backup operation completes).
pub fn release_external_access(path: &str) {
    #[cfg(target_os = "macos")]
    {
        macos::stop_access(path);
        info!("[external_location] Security-scoped access released for {}", path);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path; // no-op on Linux
    }
}

/// Validate the saved external location by testing write access.
pub fn validate_external_location(app_data_dir: &std::path::Path) -> Result<ExternalLocation, String> {
    match resolve_external_location(app_data_dir) {
        Ok((resolved_path, mut loc)) => {
            // Test write access
            let test_file = PathBuf::from(&resolved_path).join(".mailvault-access-test");
            match fs::write(&test_file, b"test") {
                Ok(()) => {
                    let _ = fs::remove_file(&test_file);
                    loc.status = "ready".to_string();
                    loc.last_validated_at = Some(now_millis());
                    loc.last_error = None;
                    release_external_access(&resolved_path);
                    Ok(loc)
                }
                Err(e) => {
                    release_external_access(&resolved_path);
                    loc.status = "invalid".to_string();
                    loc.last_error = Some(format!("Write test failed: {}", e));
                    Ok(loc)
                }
            }
        }
        Err(json_or_msg) => {
            // Try to parse as ExternalLocation JSON (from resolve error path)
            if let Ok(loc) = serde_json::from_str::<ExternalLocation>(&json_or_msg) {
                Ok(loc)
            } else {
                Ok(ExternalLocation {
                    display_path: String::new(),
                    platform: std::env::consts::OS.to_string(),
                    status: "not_configured".to_string(),
                    last_validated_at: None,
                    last_error: Some(json_or_msg),
                })
            }
        }
    }
}

/// Get the current external location status without starting access.
pub fn get_external_location(app_data_dir: &std::path::Path) -> ExternalLocation {
    let bf = bookmark_file(app_data_dir);
    if !bf.exists() {
        return ExternalLocation {
            display_path: String::new(),
            platform: std::env::consts::OS.to_string(),
            status: "not_configured".to_string(),
            last_validated_at: None,
            last_error: None,
        };
    }

    let meta: serde_json::Value = fs::read_to_string(meta_file(app_data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    ExternalLocation {
        display_path: meta["displayPath"].as_str().unwrap_or("").to_string(),
        platform: std::env::consts::OS.to_string(),
        status: "unknown".to_string(), // caller should validate if needed
        last_validated_at: meta["savedAt"].as_u64(),
        last_error: None,
    }
}

/// Detect if running inside a strict Snap confinement.
fn is_snap_confined() -> bool {
    #[cfg(target_os = "linux")]
    { std::env::var("SNAP_NAME").is_ok() && std::env::var("SNAP_REVISION").is_ok() }
    #[cfg(not(target_os = "linux"))]
    { false }
}

/// Clear the saved external location.
pub fn clear_external_location(app_data_dir: &std::path::Path) -> Result<(), String> {
    let _ = fs::remove_file(bookmark_file(app_data_dir));
    let _ = fs::remove_file(meta_file(app_data_dir));
    info!("[external_location] Cleared external backup location");
    Ok(())
}

/// Migrate a legacy raw path to a bookmark-backed location.
/// Returns Ok if migration succeeded, Err if reauthorization needed.
pub fn migrate_legacy_path(app_data_dir: &std::path::Path, legacy_path: &str) -> Result<ExternalLocation, String> {
    if legacy_path.is_empty() {
        return Err("No legacy path to migrate".to_string());
    }

    // Check if we already have a bookmark
    if bookmark_file(app_data_dir).exists() {
        return validate_external_location(app_data_dir);
    }

    // On macOS, we can't create a bookmark from a raw path without a fresh dialog grant.
    // Mark as needs_reauth so the user is prompted to re-select.
    #[cfg(target_os = "macos")]
    {
        // Save metadata so the UI knows what path was configured
        let meta = serde_json::json!({
            "displayPath": legacy_path,
            "platform": "macos",
            "savedAt": now_millis(),
            "legacy": true,
        });
        let _ = fs::write(meta_file(app_data_dir), meta.to_string());

        warn!("[external_location] Legacy path {} needs reauthorization on macOS", legacy_path);
        return Ok(ExternalLocation {
            display_path: legacy_path.to_string(),
            platform: "macos".to_string(),
            status: "needs_reauth".to_string(),
            last_validated_at: Some(now_millis()),
            last_error: Some("Please re-select this folder to grant sandbox access".to_string()),
        });
    }

    // On Linux, just save the raw path — it works fine
    #[cfg(not(target_os = "macos"))]
    {
        save_external_location(app_data_dir, legacy_path)
    }
}
