//! Keychain-backed credential blob and the `get_credentials` command.

use super::*;

// Use a more specific service name with bundle ID for persistence across builds
pub(crate) const KEYRING_SERVICE: &str = "com.mailvault.app";
pub(crate) const CREDENTIALS_KEY: &str = "credentials";

/// E2E hatch: with `MAILVAULT_TEST_CREDENTIALS=<path>` the credential blob lives in
/// that file instead of the OS keychain. Tests get an isolated account set with no
/// keychain prompt, and — more importantly — cannot write mock accounts into the
/// developer's real credential entry. Debug builds only: a shipped binary ignores it.
#[cfg(debug_assertions)]
pub(crate) fn test_credentials_path() -> Option<std::path::PathBuf> {
    std::env::var_os("MAILVAULT_TEST_CREDENTIALS").map(std::path::PathBuf::from)
}

#[cfg(not(debug_assertions))]
pub(crate) fn test_credentials_path() -> Option<std::path::PathBuf> {
    None
}

// Store all credentials as a single JSON object in keychain
// This triggers the keychain modal only once instead of per-account
// Async: runs on background thread so macOS keychain dialog can appear without blocking main thread
/// A portable copy keeps its secrets in the daemon's sealed store on the
/// drive, never in this host's keychain: both credential commands forward.
pub(crate) fn portable_credentials_call(app: tauri::AppHandle, method: &'static str, params: serde_json::Value) -> impl std::future::Future<Output = Result<serde_json::Value, String>> {
    async move {
        tokio::task::spawn_blocking(move || daemon_call_blocking(&app, method, params, std::time::Duration::from_secs(30)))
            .await
            .map_err(|e| format!("Credential task panicked: {}", e))?
    }
}

/// A keyring error, led by the `snap connect` command when that is the fix.
pub(crate) fn with_snap_keyring_hint(err: String) -> String {
    match mailvault_core::keychain::snap_keyring_hint(std::env::var_os("SNAP").is_some(), &err) {
        Some(hint) => format!("{hint} ({err})"),
        None => err,
    }
}

pub(crate) fn keyring_entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, name).map_err(|e| format!("Failed to create keyring entry: {}", e))
}

/// The blob, split across entries where the platform caps a secret's size
/// (Windows). Parts first, then the manifest, then the previous generation's
/// parts go: a reader always finds a complete set.
pub(crate) fn write_credentials_blob(json: &str) -> Result<(), String> {
    use mailvault_core::keychain::{
        secret_limit, write_split_secret, SecretStore, SplitWriteError,
    };
    // The same write the daemon's `credentials.save` does (one order, in core).
    struct Keyring;
    impl SecretStore for Keyring {
        fn get(&mut self, name: &str) -> Result<Option<String>, String> {
            match keyring_entry(name)?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        fn set(&mut self, name: &str, value: &str) -> Result<(), String> {
            keyring_entry(name)?
                .set_password(value)
                .map_err(|e| e.to_string())
        }
        fn delete(&mut self, name: &str) -> Result<(), String> {
            keyring_entry(name)?
                .delete_credential()
                .map_err(|e| e.to_string())
        }
    }
    let generation = format!(
        "{:x}",
        mailvault_core::clock::now_ms_u64()
    );
    let written = write_split_secret(
        &mut Keyring,
        CREDENTIALS_KEY,
        json,
        secret_limit(),
        &generation,
    )
    .map_err(|e| match e {
        SplitWriteError::Part(e) => format!("Failed to store credentials part: {}", e),
        SplitWriteError::Primary(e) => format!("Failed to store credentials: {}", e),
    })?;
    if written.parts > 0 {
        info!("Credentials stored in {} parts", written.parts);
    }
    for (name, e) in written.stale_left {
        warn!(
            "store_credentials: could not remove stale part {}: {}",
            name, e
        );
    }
    Ok(())
}

/// A stored primary resolved to the blob it stands for (see `join_secret`).
pub(crate) fn join_credentials_blob(primary: &str) -> Result<String, String> {
    mailvault_core::keychain::join_secret(CREDENTIALS_KEY, primary, &mut |name| {
        match keyring_entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
}

/// The app's credential read never raises macOS's keychain prompt: the
/// daemon's unlock card owns that, once per blocked episode, and two prompts
/// at launch (this read's and the daemon's) were the live bug. A read that
/// would need one fails fast with errSecInteractionNotAllowed and reports
/// "unavailable"; once the card's unlock clears the gate, the app's recovery
/// reads again and succeeds. An item this app created never needs a prompt
/// for the app itself, so first run is unaffected. The switch is process-wide,
/// hence the lock around switch, read and restore.
pub(crate) fn quiet_get_password(entry: &Entry) -> keyring::Result<String> {
    #[cfg(target_os = "macos")]
    {
        static SWITCH: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _held = SWITCH.lock().unwrap_or_else(|e| e.into_inner());
        // Restores prompts on drop, before the lock is released.
        let _quiet = security_framework::os::macos::keychain::SecKeychain::disable_user_interaction();
        entry.get_password()
    }
    #[cfg(not(target_os = "macos"))]
    entry.get_password()
}

// Get all credentials as a single JSON object from keychain.
// Returns a structured result with status so the frontend can distinguish
// granted/denied/cancelled/timed_out/empty/unavailable outcomes.
// Async: runs on a background thread so a slow keychain never blocks the main thread
#[tauri::command]
pub(crate) async fn get_credentials(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    info!("=== GET CREDENTIALS START ===");

    if mailvault_core::paths::portable_root().is_some() {
        // Unreachable daemon: the same "unavailable" a failed keychain read gives.
        return Ok(portable_credentials_call(app_handle, "portable.get_credentials", serde_json::json!({}))
            .await
            .unwrap_or_else(|e| serde_json::json!({ "status": "unavailable", "message": e })));
    }

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

        match quiet_get_password(&entry) {
            Ok(json) => {
                let json = join_credentials_blob(&json).map_err(|e| format!("unavailable:{}", e))?;
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
                } else if err_str.contains("interaction is not allowed") {
                    "unavailable" // Quiet read of a locked or unapproved item: the daemon's unlock card handles it
                } else if err_str.contains("denied") || err_str.contains("not allowed") || err_debug.contains("Denied") {
                    "denied"
                } else if err_str.contains("cancel") || err_debug.contains("Cancel") || err_str.contains("user canceled") {
                    "cancelled"
                } else {
                    "unavailable" // Platform error (D-Bus down, keyring locked, etc.)
                };

                Err(format!("{}:{}", status, with_snap_keyring_hint(err_str)))
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
                let json = quiet_get_password(&entry)
                    .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;
                let json = join_credentials_blob(&json)?;
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
