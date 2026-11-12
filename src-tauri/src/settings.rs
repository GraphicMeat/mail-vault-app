//! Settings the shell reads or writes on disk: the app data dir grant, `frontend-settings.json`, the accounts fallback and the persisted preferences.

use super::*;

/// The frontend's plugin-fs calls use absolute paths under the app data dir.
/// The capability's `$APPDATA` is Tauri's own resolver (Roaming on Windows,
/// blind to the env override in `paths`), so the real dir is allowed here, at
/// setup and again on every `get_app_data_dir` (which every frontend fs path
/// awaits first). Idempotent: the scope is a set.
pub(crate) fn allow_app_data_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri_plugin_fs::FsExt;
    let dir = mailvault_core::paths::app_data_dir().map_err(|e| format!("Could not get app data directory: {}", e))?;
    // Before the allow, so the scope stores the canonical form requests are matched in.
    let _ = fs::create_dir_all(&dir);
    app_handle.fs_scope().allow_directory(&dir, true).map_err(|e| format!("Could not allow app data directory: {}", e))?;
    Ok(dir)
}

#[tauri::command]
pub(crate) fn get_app_data_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    info!("get_app_data_dir called");
    allow_app_data_dir(&app_handle).map(|p| p.to_string_lossy().to_string())
}

// Read frontend settings from JSON file on disk (replaces localStorage)
#[tauri::command]
pub(crate) fn read_settings_json() -> Result<String, String> {
    let data_dir = mailvault_core::paths::app_data_dir()
        .map_err(|e| format!("Could not get app data dir: {}", e))?;
    let settings_path = data_dir.join(mailvault_core::settings_doc::FILE_NAME);
    if settings_path.exists() {
        fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))
    } else {
        Ok(String::from("{}"))
    }
}

// Write frontend settings to JSON file on disk (replaces localStorage).
// The daemon owns the file (`settings.replace`); this is safeStorage's
// fallback for a daemon without `settings.*` or one it cannot reach. Kept for
// one release. Atomic, refused unless a JSON object, under the daemon's lock;
// off the main thread (an fsync, and up to 2s waiting for that lock).
#[tauri::command(async)]
pub(crate) fn write_settings_json(
    data: String,
    values: Option<serde_json::Value>,
    bases: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    let data_dir = mailvault_core::paths::app_data_dir()
        .map_err(|e| format!("Could not get app data dir: {}", e))?;
    if let Some(values) = values {
        let doc = mailvault_core::settings_doc::SettingsDoc::shared(&data_dir);
        doc.replace_rebased(
            &values,
            &bases.unwrap_or_else(|| serde_json::json!({})),
            None,
        )
        .map_err(|e| e.catalog_key().to_string())?;
        let snapshot = doc.get(None).map_err(|e| e.catalog_key().to_string())?;
        let actual = serde_json::to_string(&snapshot.values)
            .map_err(|_| "errors.settingsWriteFailed".to_string())?;
        log_redact::set_verbose(log_redact::verbose_from_settings(&actual));
        return Ok(Some(
            serde_json::json!({"values":snapshot.values,"version":snapshot.version}),
        ));
    }
    mailvault_core::settings_doc::write_document(&data_dir, &data)?;
    log_redact::set_verbose(log_redact::verbose_from_settings(&data));
    Ok(None)
}

/// The daemon wrote the settings (`settings-changed`): the shell's own log
/// level follows `logVerbosity`, as it did when the shell wrote the file.
pub(crate) fn follow_settings_log_level(payload: &serde_json::Value) {
    let touches = payload["keys"].as_array().is_some_and(|keys| keys.iter().any(|k| k == mailvault_core::settings_doc::STORE));
    if !touches {
        return;
    }
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(dir) = mailvault_core::paths::app_data_dir() else { return };
        let raw = fs::read_to_string(dir.join(mailvault_core::settings_doc::FILE_NAME)).unwrap_or_default();
        log_redact::set_verbose(log_redact::verbose_from_settings(&raw));
    });
}

/// Callable account fallback capability. Uses the core document operations
/// and supported lock file. Application adapter activation is pending.
/// Unknown daemon outcomes do not authorize invoking this second writer.
#[tauri::command]
pub(crate) async fn accounts_fallback(
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    accounts_fallback_at(None, method, params).await
}

pub(crate) async fn accounts_fallback_at(
    dir: Option<std::path::PathBuf>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if dir.is_none() && !matches!(method.as_str(), "accounts.list" | "accounts.get") {
        return Err(crate::DAEMON_OUTDATED.to_string());
    }
    tokio::task::spawn_blocking(move || {
        let dir = match dir {
            Some(dir) => dir,
            None => mailvault_core::paths::app_data_dir()
                .map_err(|_| "errors.accountsWriteFailed".to_string())?,
        };
        let doc = mailvault_core::accounts_doc::shared(&dir);
        mailvault_core::accounts_doc::run(
            &doc,
            &method,
            &params,
            mailvault_core::accounts_doc::LiveScrub::Preserve,
        )
        .map(|out| out.reply)
        .map_err(|e| e.catalog_key().to_string())
    })
    .await
    .map_err(|_| "errors.accountsWriteFailed".to_string())?
}

/// Whether the user asked for the daemon to keep running after the app quits.
///
/// Read off disk rather than asked of the frontend: this runs inside
/// `RunEvent::Exit`, when the webview is already gone. Any problem reads as
/// "off", so a corrupt settings file costs a background daemon, never a
/// stray one the user cannot see or stop.
pub(crate) fn daemon_always_on() -> bool {
    // A portable copy's daemon dies with the app: the drive may leave next.
    if mailvault_core::paths::portable_root().is_some() {
        return false;
    }
    let Ok(dir) = mailvault_core::paths::app_data_dir() else { return false };
    let Ok(raw) = fs::read_to_string(dir.join(mailvault_core::settings_doc::FILE_NAME)) else { return false };
    mailvault_core::autostart::always_on_from_settings(&raw)
}

/// Whether closing the main window keeps the app in the tray (Windows and
/// Linux). Read off disk at close time, like `daemon_always_on`; any problem
/// reads as "off", so the close button quits.
pub(crate) fn close_to_tray() -> bool {
    let Ok(dir) = mailvault_core::paths::app_data_dir() else { return false };
    let Ok(raw) = fs::read_to_string(dir.join(mailvault_core::settings_doc::FILE_NAME)) else { return false };
    mailvault_core::autostart::close_to_tray_from_settings(&raw)
}

/// Linux: the menu bar choice saved by the frontend, read in `setup()` so a
/// hidden bar is never built and never flashes in before the settings hydrate.
#[cfg(target_os = "linux")]
pub(crate) fn persisted_show_menu_bar() -> bool {
    let read = || -> Option<bool> {
        let path = mailvault_core::paths::app_data_dir().ok()?.join(mailvault_core::settings_doc::FILE_NAME);
        let raw = fs::read_to_string(path).ok()?;
        let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
        mailvault_core::settings_doc::app_state(&settings)?.get("showMenuBar")?.as_bool()
    };
    read().unwrap_or(true)
}
