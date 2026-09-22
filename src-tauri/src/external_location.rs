//! External backup location management.
//!
//! On macOS sandboxed builds, user-selected folders must be persisted as
//! security-scoped bookmarks so the app can re-access them after restart.
//! On Linux, plain paths are sufficient.
//!
//! Both halves live in `app.db`'s `external_locations` table (they were
//! `<slot>-bookmark` and `<slot>-meta.json`, the vault slot's metadata file
//! being the one the daemon knew as `vault-meta.json`). The app opens that
//! store directly rather than going through the daemon: the bookmark is what
//! grants the daemon access to the vault in the first place, so it has to be
//! readable before the daemon exists.
//!
//! All macOS Objective-C calls are wrapped in catch_unwind so selector
//! mistakes or malformed bookmark data cannot crash the app.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn, error};

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

/// Storage slot for a persisted user-selected folder. Each slot is an
/// independent bookmark + metadata pair under the app data dir.
/// `"external-backup"` = the cold-storage second copy, `"vault"` = the working
/// mail store when the user moved it off the app data dir.
pub const SLOT_EXTERNAL_BACKUP: &str = "external-backup";
pub const SLOT_VAULT: &str = "vault";

use mailvault_core::app_db::{locations, with as with_app_db};

/// The stored metadata for a slot, or `None` when nothing is configured.
fn saved(app_data_dir: &std::path::Path, slot: &str) -> Option<locations::Saved> {
    with_app_db(app_data_dir, |conn| Ok(locations::get(conn, slot))).ok().flatten()
}

fn saved_bookmark(app_data_dir: &std::path::Path, slot: &str) -> Option<Vec<u8>> {
    with_app_db(app_data_dir, |conn| Ok(locations::bookmark(conn, slot))).ok().flatten()
}

fn put_meta(app_data_dir: &std::path::Path, slot: &str, display_path: &str, platform: &str, legacy: bool) {
    if let Err(e) = with_app_db(app_data_dir, |conn| {
        locations::save_meta(conn, slot, display_path, platform, now_millis(), legacy)
    }) {
        warn!("[external_location] Failed to save {} metadata: {}", slot, e);
    }
}

fn put_bookmark(app_data_dir: &std::path::Path, slot: &str, bytes: &[u8]) -> Result<(), String> {
    with_app_db(app_data_dir, |conn| locations::save_bookmark(conn, slot, bytes))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn needs_reauth_location(display_path: String, err: String) -> ExternalLocation {
    ExternalLocation {
        display_path,
        platform: "macos".to_string(),
        status: "needs_reauth".to_string(),
        last_validated_at: Some(now_millis()),
        last_error: Some(err),
    }
}

// ── macOS implementation ────────────────────────────────────────────────────
// All Objective-C calls go through safe_* wrappers that catch panics.

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    // ── Safe wrappers (catch_unwind) ──

    pub fn create_bookmark(path: &str) -> Result<Vec<u8>, String> {
        let p = path.to_string();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { create_bookmark_inner(&p) })) {
            Ok(result) => result,
            Err(e) => {
                let msg = format!("Bookmark creation panicked: {:?}", e.downcast_ref::<&str>().unwrap_or(&"unknown"));
                error!("[external_location] {}", msg);
                Err(msg)
            }
        }
    }

    pub fn resolve_bookmark(bookmark_bytes: &[u8]) -> Result<(String, bool), String> {
        let bytes = bookmark_bytes.to_vec();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { resolve_bookmark_inner(&bytes) })) {
            Ok(result) => result,
            Err(e) => {
                let msg = format!("Bookmark resolution panicked: {:?}", e.downcast_ref::<&str>().unwrap_or(&"unknown"));
                error!("[external_location] {}", msg);
                Err(msg)
            }
        }
    }

    pub fn start_access(path: &str) -> Result<(), String> {
        let p = path.to_string();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { start_access_inner(&p) })) {
            Ok(result) => result,
            Err(e) => {
                let msg = format!("start_access panicked: {:?}", e.downcast_ref::<&str>().unwrap_or(&"unknown"));
                error!("[external_location] {}", msg);
                Err(msg)
            }
        }
    }

    pub fn stop_access(path: &str) {
        let p = path.to_string();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { stop_access_inner(&p) }));
    }

    pub fn open_in_finder(path: &str, bookmark: Option<Vec<u8>>, reveal: bool, app: Option<&str>) -> Result<(), String> {
        let p = path.to_string();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { open_in_finder_inner(&p, bookmark, reveal, app) })) {
            Ok(result) => result,
            Err(e) => {
                let msg = format!("open_in_finder panicked: {:?}", e.downcast_ref::<&str>().unwrap_or(&"unknown"));
                error!("[external_location] {}", msg);
                Err(msg)
            }
        }
    }

    // ── Inner unsafe implementations ──

    unsafe fn create_bookmark_inner(path: &str) -> Result<Vec<u8>, String> {
        let url = path_to_nsurl(path)?;
        let options: usize = 1 << 11; // NSURLBookmarkCreationWithSecurityScope
        let nil: *const Object = std::ptr::null();
        let mut error_ptr: *const Object = std::ptr::null();

        info!("[external_location] Creating bookmark for path: {}", path);

        let bookmark_data: *const Object = msg_send![url,
            bookmarkDataWithOptions: options
            includingResourceValuesForKeys: nil
            relativeToURL: nil
            error: &mut error_ptr
        ];

        if bookmark_data.is_null() {
            let desc = extract_nserror(error_ptr);
            return Err(format!("Failed to create bookmark: {}", desc));
        }

        let length: usize = msg_send![bookmark_data, length];
        let bytes: *const u8 = msg_send![bookmark_data, bytes];
        let data = std::slice::from_raw_parts(bytes, length).to_vec();
        info!("[external_location] Bookmark created: {} bytes", data.len());
        Ok(data)
    }

    unsafe fn resolve_bookmark_inner(bookmark_bytes: &[u8]) -> Result<(String, bool), String> {
        let nsdata = bytes_to_nsdata(bookmark_bytes);
        // NSURLBookmarkResolutionWithSecurityScope = 1 << 10
        let options: usize = 1 << 10;
        let nil: *const Object = std::ptr::null();
        let mut is_stale: bool = false;
        let mut error_ptr: *const Object = std::ptr::null();

        info!("[external_location] Resolving bookmark ({} bytes)", bookmark_bytes.len());

        // CRITICAL: the parameter label is "relativeToURL", NOT "relativeToBookmarkURL".
        // Using the wrong label creates an invalid selector → doesNotRecognizeSelector → crash.
        let url: *const Object = msg_send![class!(NSURL),
            URLByResolvingBookmarkData: nsdata
            options: options
            relativeToURL: nil
            bookmarkDataIsStale: &mut is_stale
            error: &mut error_ptr
        ];

        if url.is_null() {
            let desc = extract_nserror(error_ptr);
            return Err(format!("Failed to resolve bookmark: {}", desc));
        }

        let path: *const Object = msg_send![url, path];
        let path_str = nsstring_to_string(path);
        info!("[external_location] Bookmark resolved to: {} (stale: {})", path_str, is_stale);
        Ok((path_str, is_stale))
    }

    unsafe fn start_access_inner(path: &str) -> Result<(), String> {
        let url = path_to_nsurl(path)?;
        let ok: bool = msg_send![url, startAccessingSecurityScopedResource];
        info!("[external_location] startAccessingSecurityScopedResource({}) = {}", path, ok);
        if ok {
            Ok(())
        } else {
            Err("startAccessingSecurityScopedResource returned NO — folder may need reauthorization".to_string())
        }
    }

    unsafe fn stop_access_inner(path: &str) {
        if let Ok(url) = path_to_nsurl(path) {
            let _: () = msg_send![url, stopAccessingSecurityScopedResource];
            info!("[external_location] stopAccessingSecurityScopedResource({})", path);
        }
    }

    /// Open (or reveal) `path` in Finder, holding the folder's security-scoped
    /// bookmark for the call.
    ///
    /// Without that scope a folder outside the sandbox container is refused
    /// (`_LSOpenURLsWithCompletionHandler ... error -54`) — and the app only
    /// ever starts the scope for the length of a backup or a validation, so a
    /// click arriving in between saw nothing at all. NSWorkspace also returns
    /// whether the open was accepted; spawning `/usr/bin/open` threw the exit
    /// code away, which is why the failure was silent.
    ///
    /// `app` (a bundle path) opens the file in that app instead of its default
    /// one. Both strings go to NSWorkspace as objects, never through a script
    /// or a shell, so a sender-chosen attachment name is only ever a name.
    unsafe fn open_in_finder_inner(path: &str, bookmark: Option<Vec<u8>>, reveal: bool, app: Option<&str>) -> Result<(), String> {
        let url = path_to_nsurl(path)?;

        // The scope has to be started on the URL the bookmark resolves to —
        // a plain fileURLWithPath: carries no extension to consume.
        let scoped: *const Object = match bookmark {
            Some(bytes) if !bytes.is_empty() => {
                let nsdata = bytes_to_nsdata(&bytes);
                let mut error_ptr: *const Object = std::ptr::null();
                let mut is_stale: bool = false;
                let url: *const Object = msg_send![class!(NSURL),
                    URLByResolvingBookmarkData: nsdata
                    options: 1usize << 10 // NSURLBookmarkResolutionWithSecurityScope
                    relativeToURL: std::ptr::null::<Object>()
                    bookmarkDataIsStale: &mut is_stale
                    error: &mut error_ptr
                ];
                url
            }
            _ => std::ptr::null(),
        };
        let started: bool = if scoped.is_null() {
            false
        } else {
            msg_send![scoped, startAccessingSecurityScopedResource]
        };

        let workspace: *const Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let result = if workspace.is_null() {
            Err("NSWorkspace unavailable".to_string())
        } else if reveal {
            let urls: *const Object = msg_send![class!(NSArray), arrayWithObject: url];
            let _: () = msg_send![workspace, activateFileViewerSelectingURLs: urls];
            Ok(())
        } else if let Some(app) = app {
            let ok: bool = msg_send![workspace, openFile: string_to_nsstring(path) withApplication: string_to_nsstring(app)];
            if ok { Ok(()) } else { Err(format!("{} refused to open {}", app, path)) }
        } else {
            let ok: bool = msg_send![workspace, openURL: url];
            if ok { Ok(()) } else { Err(format!("Finder refused to open {}", path)) }
        };

        if started {
            let _: () = msg_send![scoped, stopAccessingSecurityScopedResource];
        }
        info!("[external_location] open_in_finder({}, reveal: {}, app: {:?}, scoped: {}) -> {:?}", path, reveal, app, started, result);
        result
    }

    // ── Helpers ──

    unsafe fn path_to_nsurl(path: &str) -> Result<*const Object, String> {
        let nsstring = string_to_nsstring(path);
        if nsstring.is_null() { return Err(format!("Failed to create NSString from path: {}", path)); }
        let url: *const Object = msg_send![class!(NSURL), fileURLWithPath: nsstring];
        if url.is_null() {
            Err(format!("Failed to create NSURL from path: {}", path))
        } else {
            Ok(url)
        }
    }

    unsafe fn string_to_nsstring(s: &str) -> *const Object {
        let cls = class!(NSString);
        let nsstring: *const Object = msg_send![cls, alloc];
        msg_send![nsstring, initWithBytes:s.as_ptr() length:s.len() encoding:4usize] // NSUTF8StringEncoding = 4
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

    unsafe fn extract_nserror(error: *const Object) -> String {
        if error.is_null() { return "Unknown error".to_string(); }
        let desc: *const Object = msg_send![error, localizedDescription];
        nsstring_to_string(desc)
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Save an external backup location after folder picker selection.
/// On macOS: creates and persists a security-scoped bookmark.
/// On Linux: persists the path string.
/// Does NOT call validate — returns the save result directly to avoid chaining into crash-prone resolution.
pub fn save_external_location(app_data_dir: &std::path::Path, slot: &str, path: &str) -> Result<ExternalLocation, String> {
    fs::create_dir_all(app_data_dir).map_err(|e| format!("Cannot create app data dir: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        match macos::create_bookmark(path) {
            Ok(bookmark) => {
                put_bookmark(app_data_dir, slot, &bookmark)
                    .map_err(|e| format!("Failed to save bookmark: {}", e))?;
                info!("[external_location] Saved macOS security-scoped bookmark for {}", path);
            }
            Err(e) => {
                warn!("[external_location] Failed to create bookmark for {}: {}", path, e);
                // Save metadata anyway so user sees the path in UI
                put_meta(app_data_dir, slot, path, "macos", false);
                return Ok(needs_reauth_location(path.to_string(), e));
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        put_bookmark(app_data_dir, slot, path.as_bytes())
            .map_err(|e| format!("Failed to save path: {}", e))?;
        info!("[external_location] Saved path for {}", path);
    }

    put_meta(app_data_dir, slot, path, std::env::consts::OS, false);

    // Return success without full validation to avoid crash-prone resolution chain
    Ok(ExternalLocation {
        display_path: path.to_string(),
        platform: std::env::consts::OS.to_string(),
        status: "ready".to_string(),
        last_validated_at: Some(now_millis()),
        last_error: None,
    })
}

/// Resolve the saved external location and start security-scoped access.
/// On macOS: resolves the bookmark, starts access. Failures become needs_reauth.
/// Returns (resolved_path, location_status).
pub fn resolve_external_location(app_data_dir: &std::path::Path, slot: &str) -> Result<(String, ExternalLocation), String> {
    let Some(stored) = saved_bookmark(app_data_dir, slot) else {
        return Err("No external backup location configured".to_string());
    };
    let display_path = saved(app_data_dir, slot).map(|s| s.display_path).unwrap_or_default();

    #[cfg(target_os = "macos")]
    {
        let bookmark_bytes = stored;

        if bookmark_bytes.is_empty() {
            let msg = "Bookmark file is empty".to_string();
            warn!("[external_location] {}", msg);
            let loc = needs_reauth_location(display_path, msg.clone());
            return Err(serde_json::to_string(&loc).unwrap_or(msg));
        }

        // Resolve bookmark → path
        let (resolved_path, is_stale) = match macos::resolve_bookmark(&bookmark_bytes) {
            Ok(r) => r,
            Err(e) => {
                warn!("[external_location] Bookmark resolution failed: {}", e);
                let loc = needs_reauth_location(display_path, e.clone());
                return Err(serde_json::to_string(&loc).unwrap_or(e));
            }
        };

        // Re-create stale bookmarks
        if is_stale {
            warn!("[external_location] Bookmark is stale for {}, attempting re-creation", resolved_path);
            match macos::create_bookmark(&resolved_path) {
                Ok(new_bookmark) => { let _ = put_bookmark(app_data_dir, slot, &new_bookmark); }
                Err(e) => { warn!("[external_location] Stale bookmark re-creation failed: {}", e); }
            }
        }

        // Start security-scoped access
        match macos::start_access(&resolved_path) {
            Ok(()) => {
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
                warn!("[external_location] start_access failed: {}", e);
                let loc = needs_reauth_location(display_path, e.clone());
                Err(serde_json::to_string(&loc).unwrap_or(e))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let path = String::from_utf8(stored)
            .map_err(|e| format!("Failed to read path: {}", e))?
            .trim()
            .to_string();
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

/// Release security-scoped access (call after backup completes).
pub fn release_external_access(path: &str) {
    #[cfg(target_os = "macos")]
    {
        macos::stop_access(path);
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = path; }
}

/// Open (or reveal) `path` in Finder, holding the security-scoped bookmark of
/// whichever configured location contains it. macOS only — see
/// [`macos::open_in_finder_inner`] for why spawning `/usr/bin/open` cannot work
/// for a folder outside the sandbox container.
#[cfg(target_os = "macos")]
pub fn open_in_finder(app_data_dir: &std::path::Path, path: &str, reveal: bool, app: Option<&str>) -> Result<(), String> {
    let bookmark = [SLOT_EXTERNAL_BACKUP, SLOT_VAULT].iter().find_map(|slot| {
        let stored = saved(app_data_dir, slot)?;
        if stored.display_path.is_empty() || !std::path::Path::new(path).starts_with(&stored.display_path) {
            return None;
        }
        saved_bookmark(app_data_dir, slot)
    });
    macos::open_in_finder(path, bookmark, reveal, app)
}

/// Validate the saved external location by resolving + testing write access.
pub fn validate_external_location(app_data_dir: &std::path::Path, slot: &str) -> Result<ExternalLocation, String> {
    match resolve_external_location(app_data_dir, slot) {
        Ok((resolved_path, mut loc)) => {
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
pub fn get_external_location(app_data_dir: &std::path::Path, slot: &str) -> ExternalLocation {
    let not_configured = || ExternalLocation {
        display_path: String::new(),
        platform: std::env::consts::OS.to_string(),
        status: "not_configured".to_string(),
        last_validated_at: None,
        last_error: None,
    };
    // No bookmark is what "no `<slot>-bookmark` file" used to mean: metadata
    // alone is a location the user still has to re-authorize.
    let Some(stored) = saved(app_data_dir, slot).filter(|s| s.has_bookmark) else {
        return not_configured();
    };

    ExternalLocation {
        display_path: stored.display_path,
        platform: std::env::consts::OS.to_string(),
        status: "unknown".to_string(),
        last_validated_at: Some(stored.saved_at),
        last_error: None,
    }
}

/// Detect Snap confinement.
fn is_snap_confined() -> bool {
    #[cfg(target_os = "linux")]
    { std::env::var("SNAP_NAME").is_ok() && std::env::var("SNAP_REVISION").is_ok() }
    #[cfg(not(target_os = "linux"))]
    { false }
}

/// Clear the saved external location.
pub fn clear_external_location(app_data_dir: &std::path::Path, slot: &str) -> Result<(), String> {
    let _ = with_app_db(app_data_dir, |conn| locations::clear(conn, slot));
    info!("[external_location] Cleared external backup location");
    Ok(())
}

/// Migrate a legacy raw path to a bookmark-backed location.
pub fn migrate_legacy_path(app_data_dir: &std::path::Path, legacy_path: &str) -> Result<ExternalLocation, String> {
    if legacy_path.is_empty() {
        return Err("No legacy path to migrate".to_string());
    }

    if saved_bookmark(app_data_dir, SLOT_EXTERNAL_BACKUP).is_some() {
        return validate_external_location(app_data_dir, SLOT_EXTERNAL_BACKUP);
    }

    #[cfg(target_os = "macos")]
    {
        put_meta(app_data_dir, SLOT_EXTERNAL_BACKUP, legacy_path, "macos", true);

        warn!("[external_location] Legacy path {} needs reauthorization on macOS", legacy_path);
        return Ok(ExternalLocation {
            display_path: legacy_path.to_string(),
            platform: "macos".to_string(),
            status: "needs_reauth".to_string(),
            last_validated_at: Some(now_millis()),
            last_error: Some("Please re-select this folder to grant sandbox access".to_string()),
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        save_external_location(app_data_dir, SLOT_EXTERNAL_BACKUP, legacy_path)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod open_with_tests {
    use std::process::Command;
    use std::time::Duration;

    const TEXTEDIT: &str = "/System/Applications/TextEdit.app";

    fn textedit_window_names() -> String {
        let out = Command::new("osascript")
            .args(["-e", r#"tell application "System Events" to get name of every window of process "TextEdit""#])
            .output()
            .expect("osascript");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Launches TextEdit on whatever Mac runs it, hence `#[ignore]`: run it on
    /// the mini with `cargo test --bin mailvault open_with -- --ignored`.
    ///
    /// The name carries every character the old AppleScript choked on (a
    /// quote, an apostrophe, a backslash) plus a non-ASCII letter. Proof is the
    /// process table: a TextEdit this call launched, showing this document.
    #[test]
    #[ignore]
    fn open_with_hands_an_awkward_name_to_the_chosen_app_intact() {
        let _ = Command::new("pkill").args(["-x", "TextEdit"]).status();
        std::thread::sleep(Duration::from_millis(500));

        let dir = tempfile::tempdir().unwrap();
        let stem = r#"Sąskaita "q3" it's a\b"#;
        let path = dir.path().join(format!("{stem}.txt"));
        std::fs::write(&path, "open-with test\n").unwrap();

        super::macos::open_in_finder(path.to_str().unwrap(), None, false, Some(TEXTEDIT)).unwrap();

        let mut windows = String::new();
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(200));
            let running = Command::new("pgrep").args(["-x", "TextEdit"]).status().is_ok_and(|s| s.success());
            if running {
                windows = textedit_window_names();
                if windows.contains(stem) {
                    break;
                }
            }
        }
        let _ = Command::new("pkill").args(["-x", "TextEdit"]).status();
        assert!(windows.contains(stem), "TextEdit windows: {windows:?}");
    }
}
