//! Mail storage location ("the vault") — the app's own bookmark broker and
//! local status cache.
//!
//! By default the working copy of the mail lives in the app data dir. The user
//! can move it to any folder on any drive; from then on every mail-data read
//! and write goes through [`root`].
//!
//! Only mail data moves. Accounts, settings, logs and the daemon socket stay in
//! the app data dir so the app can always boot far enough to report a missing
//! drive and ask for the folder again.
//!
//! macOS keeps access alive through a security-scoped bookmark resolved once at
//! startup and held for the process lifetime — a raw path loses sandbox access
//! across restarts.
//!
//! Phase 6: the real work behind `vault_get_status`/`vault_adopt`/
//! `vault_move_to`/`vault_move_to_default` (folder classification, copy,
//! verify, marker writes) moved to the daemon (`mailvault_core::vault_ops`,
//! `src-daemon/src/handlers/vault.rs`) — those commands' bodies now live in
//! `main.rs` as thin forwarders. What's left here is the app-only bookmark
//! resolution (`external_location`) and the local `VaultState` cache that
//! `archive.rs`'s `build_ctx` and `main.rs`'s `graph_ledger_path` still read
//! synchronously (both feed `backup.rs`'s still-unmoved Graph backup path,
//! a documented Known Gap, out of this phase's scope) — plus `reset()`
//! (clearing a bookmark is the entire operation; there is no file work to
//! move) and `inspect_folder()` (a one-shot pick preview using access the
//! app already holds from the picker; decided to stay, same category as
//! `save_attachment_to`).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tracing::info;

use crate::external_location::{self, SLOT_VAULT};
// Task 2.5 (spec deviation 6): the vault-is-ready rule is shared with the
// daemon's `resolve_vault_location` so the two processes never disagree
// about whether a folder holds mail.
pub use mailvault_core::vault_layout::{looks_like_vault, read_marker, VaultMarker, MARKER_FILE, VAULT_DIRS};
pub use mailvault_core::vault_ops::FolderInspection;

// Deserialize: `vault_get_status` (main.rs) now parses this back out of the
// daemon's JSON reply, the same shape `vault_status_json` in
// `handlers/vault.rs` serializes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStatus {
    /// "default" (app data dir) | "ready" (custom folder in use) | "missing"
    /// (configured but not reachable) | "wrong_folder" (a folder was picked
    /// that belongs to a different vault)
    pub status: String,
    #[serde(rename = "displayPath")]
    pub display_path: String,
    #[serde(rename = "isCustom")]
    pub is_custom: bool,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Resolved vault, computed once at startup and after every switch.
#[derive(Default)]
pub struct VaultState {
    inner: Mutex<Option<Resolved>>,
}

#[derive(Clone)]
struct Resolved {
    root: PathBuf,
    display_path: String,
    error: Option<String>,
}

/// Resolve the configured vault (if any) and start security-scoped access.
/// Called at startup and after a switch; the result is cached in [`VaultState`].
pub fn resolve(app_handle: &tauri::AppHandle) -> VaultStatus {
    let data_dir = match app_handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            return VaultStatus {
                status: "missing".into(),
                display_path: String::new(),
                is_custom: false,
                last_error: Some(format!("No app data dir: {}", e)),
            }
        }
    };

    let configured = external_location::get_external_location(&data_dir, SLOT_VAULT);
    if configured.status == "not_configured" {
        set_state(app_handle, Some(Resolved { root: data_dir.clone(), display_path: data_dir.to_string_lossy().into(), error: None }));
        return VaultStatus {
            status: "default".into(),
            display_path: data_dir.to_string_lossy().into(),
            is_custom: false,
            last_error: None,
        };
    }

    let display = configured.display_path.clone();

    match external_location::resolve_external_location(&data_dir, SLOT_VAULT) {
        Ok((path, _loc)) => {
            let root = PathBuf::from(&path);
            // A resolvable path is not proof the drive is mounted with our data
            // on it — a stale mount point resolves to an empty directory.
            if read_marker(&root).is_none() && !looks_like_vault(&root) {
                let err = "The folder is reachable but does not contain your mail. If the drive was remounted elsewhere, choose the folder again.".to_string();
                tracing::warn!("[vault] marker missing at {}", root.display());
                set_state(app_handle, Some(Resolved { root: root.clone(), display_path: display.clone(), error: Some(err.clone()) }));
                return VaultStatus { status: "missing".into(), display_path: display, is_custom: true, last_error: Some(err) };
            }
            info!("[vault] using custom mail storage at {}", root.display());
            set_state(app_handle, Some(Resolved { root, display_path: display.clone(), error: None }));
            VaultStatus { status: "ready".into(), display_path: display, is_custom: true, last_error: None }
        }
        Err(json_or_msg) => {
            let err = serde_json::from_str::<external_location::ExternalLocation>(&json_or_msg)
                .ok()
                .and_then(|l| l.last_error)
                .unwrap_or(json_or_msg);
            tracing::warn!("[vault] configured mail storage unavailable: {}", err);
            set_state(app_handle, Some(Resolved {
                root: data_dir,
                display_path: display.clone(),
                error: Some(err.clone()),
            }));
            VaultStatus { status: "missing".into(), display_path: display, is_custom: true, last_error: Some(err) }
        }
    }
}

fn set_state(app_handle: &tauri::AppHandle, resolved: Option<Resolved>) {
    if let Some(state) = app_handle.try_state::<VaultState>() {
        if let Ok(mut guard) = state.inner.lock() {
            *guard = resolved;
        }
    }
}

/// Root directory for mail data. Errors when the user moved the vault to a
/// drive that is currently unreachable — callers must not silently fall back to
/// the app data dir and start a second, divergent copy of the archive.
pub fn root(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(state) = app_handle.try_state::<VaultState>() {
        if let Ok(guard) = state.inner.lock() {
            if let Some(ref r) = *guard {
                return match r.error {
                    Some(ref e) => Err(format!("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: {}", e)),
                    None => Ok(r.root.clone()),
                };
            }
        }
    }
    app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))
}

pub fn status(app_handle: &tauri::AppHandle) -> VaultStatus {
    let data_dir = app_handle.path().app_data_dir().ok();
    if let Some(state) = app_handle.try_state::<VaultState>() {
        if let Ok(guard) = state.inner.lock() {
            if let Some(ref r) = *guard {
                let is_custom = data_dir.as_ref().map(|d| *d != r.root).unwrap_or(false) || r.error.is_some();
                return VaultStatus {
                    status: match (&r.error, is_custom) {
                        (Some(_), _) => "missing".into(),
                        (None, true) => "ready".into(),
                        (None, false) => "default".into(),
                    },
                    display_path: r.display_path.clone(),
                    is_custom,
                    last_error: r.error.clone(),
                };
            }
        }
    }
    resolve(app_handle)
}

/// Classify a user-picked folder before doing anything destructive with it.
/// A one-shot pick preview (spec §3.4 case b territory — fd-passing, not
/// built this phase): the app's own in-process access from the native
/// picker is what makes this read possible before any bookmark exists.
pub fn inspect_folder(app_handle: &tauri::AppHandle, path: &str) -> Result<FolderInspection, String> {
    let dir = PathBuf::from(path);
    let expected_id = app_handle
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| read_marker(&d))
        .map(|m| m.vault_id);
    mailvault_core::vault_ops::classify_folder(&dir, expected_id.as_deref())
}

/// Stop using a custom folder. Leaves the mail where it is — the app falls back
/// to whatever is in the app data dir. The entire operation is a bookmark
/// clear (app-only, spec §3.4) — there is no file work to move to the daemon.
pub fn reset(app_handle: &tauri::AppHandle) -> Result<VaultStatus, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    external_location::clear_external_location(&data_dir, SLOT_VAULT)?;
    Ok(resolve(app_handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn inspect_folder_classifies_unmarked_mail() {
        let dir = tmp("mv-vault-inspect-unmarked");
        fs::create_dir_all(dir.join("Maildir")).unwrap();
        let result = mailvault_core::vault_ops::classify_folder(&dir, None).unwrap();
        assert_eq!(result.kind, "unmarked_mail");
        let _ = fs::remove_dir_all(&dir);
    }
}
