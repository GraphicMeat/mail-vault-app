//! Device identity for the frontend: client id, OS version, device name.

use super::*;

// Sync commands run on the main thread, and this one shells out (`cmd /C ver`,
// `sw_vers`, `scutil`): the first Billing visit froze the window for it.
#[tauri::command]
pub(crate) async fn get_client_info() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // Off the main thread two first calls can overlap (the JS caches only
        // the resolved value); unserialized, both would mint a client id.
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        client_info()
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn client_info() -> Result<serde_json::Value, String> {
    let data_dir = mailvault_core::paths::app_data_dir()
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
pub(crate) fn get_os_version() -> String {
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
pub(crate) fn get_os_version() -> String {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("cmd")
        .args(["/C", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Windows (unknown version)".to_string())
}

#[cfg(target_os = "linux")]
pub(crate) fn get_os_version() -> String {
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
pub(crate) fn get_os_version() -> String {
    format!("{} (unknown version)", std::env::consts::OS)
}

pub(crate) fn get_client_name() -> String {
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
