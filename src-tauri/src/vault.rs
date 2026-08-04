//! Mail storage location ("the vault").
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

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tracing::{info, warn};

use crate::external_location::{self, SLOT_VAULT};

/// Mail-data directories that live in the vault. Everything else under the app
/// data dir (accounts.json, settings, logs, caches of app state) stays put.
pub const VAULT_DIRS: [&str; 5] = [
    "Maildir",          // the messages
    "maildir",          // per-mailbox local-index.json
    "email_cache",      // header sidecars
    "attachment_cache", // extracted attachments
    "mailboxes",        // per-account folder lists
];

/// Marker written at the vault root so a re-selected folder can be recognised
/// as this app's vault (and told apart from someone else's).
const MARKER_FILE: &str = ".mailvault-vault.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMarker {
    pub app: String,
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
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

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_vault_id() -> String {
    // Enough entropy to tell two vaults apart; not a security boundary.
    format!("{:x}-{:x}", now_millis(), std::process::id())
}

pub fn read_marker(dir: &Path) -> Option<VaultMarker> {
    let raw = std::fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    serde_json::from_str::<VaultMarker>(&raw).ok().filter(|m| m.app == "mailvault")
}

fn write_marker(dir: &Path, marker: &VaultMarker) -> Result<(), String> {
    let data = serde_json::to_string_pretty(marker).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MARKER_FILE), data).map_err(|e| format!("Cannot write vault marker: {}", e))
}

/// True if the folder already holds mail data, marker or not.
fn looks_like_vault(dir: &Path) -> bool {
    VAULT_DIRS.iter().any(|d| dir.join(d).exists())
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
                warn!("[vault] marker missing at {}", root.display());
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
            warn!("[vault] configured mail storage unavailable: {}", err);
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
                    Some(ref e) => Err(format!("Mail storage folder unavailable: {}", e)),
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

/// Outcome of inspecting a folder the user just picked.
#[derive(Debug, Serialize)]
pub struct FolderInspection {
    /// "our_vault" | "other_vault" | "unmarked_mail" | "empty" | "occupied"
    pub kind: String,
    #[serde(rename = "vaultId", skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    pub writable: bool,
    #[serde(rename = "emailCount")]
    pub email_count: usize,
}

fn count_messages(dir: &Path) -> usize {
    fn walk(dir: &Path, count: &mut usize) {
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count);
            } else if entry.file_name().to_string_lossy().contains(":2,") {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(&dir.join("Maildir"), &mut count);
    count
}

/// Classify a user-picked folder before doing anything destructive with it.
pub fn inspect_folder(app_handle: &tauri::AppHandle, path: &str) -> Result<FolderInspection, String> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err("That path is not a folder".to_string());
    }

    let probe = dir.join(".mailvault-write-test");
    let writable = std::fs::write(&probe, b"test").is_ok();
    let _ = std::fs::remove_file(&probe);

    let expected_id = app_handle
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| read_marker(&d))
        .map(|m| m.vault_id);

    let marker = read_marker(&dir);
    let kind = match (&marker, looks_like_vault(&dir)) {
        (Some(m), _) => {
            if expected_id.as_deref() == Some(m.vault_id.as_str()) { "our_vault" } else { "other_vault" }
        }
        (None, true) => "unmarked_mail",
        (None, false) => {
            let empty = std::fs::read_dir(&dir).map(|mut e| e.next().is_none()).unwrap_or(false);
            if empty { "empty" } else { "occupied" }
        }
    };

    Ok(FolderInspection {
        kind: kind.to_string(),
        vault_id: marker.map(|m| m.vault_id),
        writable,
        email_count: count_messages(&dir),
    })
}

/// Point the app at an existing vault folder (drive reconnected, or moved by
/// hand). Does not copy anything — the folder must already hold the mail.
pub fn adopt(app_handle: &tauri::AppHandle, path: &str) -> Result<VaultStatus, String> {
    let dir = PathBuf::from(path);
    let inspection = inspect_folder(app_handle, path)?;
    if !inspection.writable {
        return Err("MailVault cannot write to that folder. Check the drive is not read-only.".to_string());
    }
    if inspection.kind == "empty" || inspection.kind == "occupied" {
        return Err("That folder does not contain a MailVault store. Pick the folder your mail was moved to, or use \"Move mail here\" to set up a new one.".to_string());
    }

    if read_marker(&dir).is_none() {
        // Mail is there but the marker was lost (copied by hand, or written by
        // an older build) — stamp it so later re-selections verify cleanly.
        write_marker(&dir, &VaultMarker { app: "mailvault".into(), vault_id: new_vault_id(), created_at: now_millis() })?;
    }

    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    external_location::save_external_location(&data_dir, SLOT_VAULT, path)?;
    if let Some(marker) = read_marker(&dir) {
        let _ = write_marker(&data_dir, &marker); // remember which vault is ours
    }
    Ok(resolve(app_handle))
}

/// Stop using a custom folder. Leaves the mail where it is — the app falls back
/// to whatever is in the app data dir.
pub fn reset(app_handle: &tauri::AppHandle) -> Result<VaultStatus, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    external_location::clear_external_location(&data_dir, SLOT_VAULT)?;
    Ok(resolve(app_handle))
}

// ── Offload ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct MoveProgress {
    pub phase: String, // "copying" | "verifying" | "cleaning" | "done"
    pub copied: usize,
    pub total: usize,
    #[serde(rename = "currentDir")]
    pub current_dir: String,
}

#[derive(Debug, Serialize)]
pub struct MoveResult {
    #[serde(rename = "filesCopied")]
    pub files_copied: usize,
    #[serde(rename = "bytesCopied")]
    pub bytes_copied: u64,
    #[serde(rename = "sourceRemoved")]
    pub source_removed: bool,
    #[serde(rename = "displayPath")]
    pub display_path: String,
}

fn count_files(dir: &Path) -> usize {
    let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return 0 };
    entries.flatten().map(|e| {
        let p = e.path();
        if p.is_dir() { count_files(&p) } else { 1 }
    }).sum()
}

/// Copy `src` into `dst` recursively. Returns (files, bytes) actually written.
/// Existing destination files with the same size are left alone so an
/// interrupted offload can be resumed by running it again.
fn copy_tree(src: &Path, dst: &Path, copied: &mut usize, bytes: &mut u64) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {}", dst.display(), e))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("read {}: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to, copied, bytes)?;
            continue;
        }
        let src_len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if to.metadata().map(|m| m.len()) .ok() == Some(src_len) {
            *copied += 1;
            *bytes += src_len;
            continue;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {}", from.display(), e))?;
        *copied += 1;
        *bytes += src_len;
    }
    Ok(())
}

/// Verify every file in `src` exists in `dst` with the same size.
/// Returns the first mismatch found.
fn verify_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("read {}: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            verify_tree(&from, &to)?;
            continue;
        }
        let src_len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match to.metadata() {
            Ok(m) if m.len() == src_len => {}
            Ok(m) => return Err(format!("{} copied as {} bytes, expected {}", to.display(), m.len(), src_len)),
            Err(e) => return Err(format!("{} is missing from the new location: {}", to.display(), e)),
        }
    }
    Ok(())
}

/// Copy every vault dir present in `src_root` into `dst_root` and check it all
/// arrived. Nothing is deleted here — the caller switches over first.
/// Returns (dirs copied, files copied, bytes copied).
fn copy_and_verify<F: Fn(MoveProgress)>(
    src_root: &Path,
    dst_root: &Path,
    on_progress: &F,
) -> Result<(Vec<&'static str>, usize, u64), String> {
    let present: Vec<&'static str> = VAULT_DIRS.iter().copied().filter(|d| src_root.join(d).exists()).collect();
    let total: usize = present.iter().map(|d| count_files(&src_root.join(d))).sum();

    let mut copied = 0usize;
    let mut bytes = 0u64;
    for dir in &present {
        on_progress(MoveProgress { phase: "copying".into(), copied, total, current_dir: dir.to_string() });
        copy_tree(&src_root.join(dir), &dst_root.join(dir), &mut copied, &mut bytes)?;
    }

    on_progress(MoveProgress { phase: "verifying".into(), copied, total, current_dir: String::new() });
    for dir in &present {
        verify_tree(&src_root.join(dir), &dst_root.join(dir))?;
    }

    Ok((present, copied, bytes))
}

/// Delete the copied-from dirs. Only ever called once the destination is live.
fn remove_sources(src_root: &Path, present: &[&str]) -> bool {
    let mut removed = true;
    for dir in present {
        if let Err(e) = std::fs::remove_dir_all(src_root.join(dir)) {
            warn!("[vault] could not remove {} after offload: {}", dir, e);
            removed = false;
        }
    }
    removed
}

/// Move the mail data to `path`: copy everything, verify it byte-count for
/// byte-count, only then delete the originals, and finally switch over.
/// A failure at any point before the switch leaves the current store intact.
pub fn move_to<F: Fn(MoveProgress)>(
    app_handle: &tauri::AppHandle,
    path: &str,
    on_progress: F,
) -> Result<MoveResult, String> {
    let dst_root = PathBuf::from(path);
    let src_root = root(app_handle)?;
    if dst_root == src_root {
        return Err("Mail is already stored in that folder".to_string());
    }
    if dst_root.starts_with(&src_root) {
        return Err("Choose a folder outside the current mail storage folder".to_string());
    }

    let inspection = inspect_folder(app_handle, path)?;
    if !inspection.writable {
        return Err("MailVault cannot write to that folder. Check the drive is not read-only.".to_string());
    }
    if inspection.kind == "other_vault" {
        return Err("That folder already holds a different MailVault store. Pick an empty folder, or select it as your existing storage instead.".to_string());
    }

    let (present, copied, bytes) = copy_and_verify(&src_root, &dst_root, &on_progress)?;

    // Everything is safely on the other side — stamp, switch, then clean up.
    let marker = read_marker(&dst_root).unwrap_or(VaultMarker {
        app: "mailvault".into(),
        vault_id: new_vault_id(),
        created_at: now_millis(),
    });
    write_marker(&dst_root, &marker)?;

    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    external_location::save_external_location(&data_dir, SLOT_VAULT, path)?;
    let _ = write_marker(&data_dir, &marker);
    let new_status = resolve(app_handle);
    if new_status.status != "ready" {
        // Do not delete the source while the destination is not actually usable.
        let _ = external_location::clear_external_location(&data_dir, SLOT_VAULT);
        resolve(app_handle);
        return Err(new_status.last_error.unwrap_or_else(|| "New mail storage folder could not be opened".into()));
    }

    on_progress(MoveProgress { phase: "cleaning".into(), copied, total: copied, current_dir: String::new() });
    let source_removed = remove_sources(&src_root, &present);

    on_progress(MoveProgress { phase: "done".into(), copied, total: copied, current_dir: String::new() });
    info!("[vault] offloaded {} files ({} bytes) to {}", copied, bytes, path);

    Ok(MoveResult {
        files_copied: copied,
        bytes_copied: bytes,
        source_removed,
        display_path: path.to_string(),
    })
}

/// Bring the mail back into the app data dir and stop using the custom folder.
/// Same ordering as [`move_to`]: copy, verify, switch, only then delete.
pub fn move_to_default<F: Fn(MoveProgress)>(
    app_handle: &tauri::AppHandle,
    on_progress: F,
) -> Result<MoveResult, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    // Errors when the custom folder is unreachable — there is nothing to move
    // back and clearing the setting is the other button's job.
    let src_root = root(app_handle)?;
    if src_root == data_dir {
        return Err("Mail is already stored in the default location".to_string());
    }

    let (present, copied, bytes) = copy_and_verify(&src_root, &data_dir, &on_progress)?;

    external_location::clear_external_location(&data_dir, SLOT_VAULT)?;
    let new_status = resolve(app_handle);
    if new_status.status != "default" {
        // Leave the source alone while the app is not actually reading the default dir.
        return Err(new_status.last_error.unwrap_or_else(|| "Could not switch back to the default location".into()));
    }

    on_progress(MoveProgress { phase: "cleaning".into(), copied, total: copied, current_dir: String::new() });
    let source_removed = remove_sources(&src_root, &present);

    on_progress(MoveProgress { phase: "done".into(), copied, total: copied, current_dir: String::new() });
    info!("[vault] moved {} files ({} bytes) back to the default location", copied, bytes);

    Ok(MoveResult {
        files_copied: copied,
        bytes_copied: bytes,
        source_removed,
        display_path: data_dir.to_string_lossy().into(),
    })
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
    fn copy_then_verify_detects_a_truncated_file() {
        let base = tmp("mv-vault-verify");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("Maildir/acc/INBOX/cur")).unwrap();
        fs::write(src.join("Maildir/acc/INBOX/cur/1:2,S.eml"), b"hello world").unwrap();

        let (mut n, mut b) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n, &mut b).unwrap();
        assert_eq!(n, 1);
        assert_eq!(b, 11);
        verify_tree(&src, &dst).unwrap();

        // A short write on the destination must be caught before any delete.
        fs::write(dst.join("Maildir/acc/INBOX/cur/1:2,S.eml"), b"hel").unwrap();
        assert!(verify_tree(&src, &dst).is_err());

        // Missing entirely is caught too.
        fs::remove_file(dst.join("Maildir/acc/INBOX/cur/1:2,S.eml")).unwrap();
        assert!(verify_tree(&src, &dst).is_err());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_tree_resumes_without_recopying() {
        let base = tmp("mv-vault-resume");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.eml"), b"aaaa").unwrap();
        fs::write(src.join("b.eml"), b"bb").unwrap();

        let (mut n, mut b) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n, &mut b).unwrap();
        assert_eq!((n, b), (2, 6));

        // Truncate one file: the resume pass must rewrite it, then verify clean.
        fs::write(dst.join("a.eml"), b"x").unwrap();
        let (mut n2, mut b2) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n2, &mut b2).unwrap();
        assert_eq!((n2, b2), (2, 6));
        verify_tree(&src, &dst).unwrap();

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn marker_round_trips_and_rejects_foreign_files() {
        let base = tmp("mv-vault-marker");
        assert!(read_marker(&base).is_none());
        write_marker(&base, &VaultMarker { app: "mailvault".into(), vault_id: "abc".into(), created_at: 1 }).unwrap();
        assert_eq!(read_marker(&base).unwrap().vault_id, "abc");

        fs::write(base.join(MARKER_FILE), br#"{"app":"other","vaultId":"x","createdAt":1}"#).unwrap();
        assert!(read_marker(&base).is_none(), "a marker from another app must not be accepted");

        let _ = fs::remove_dir_all(&base);
    }
}
