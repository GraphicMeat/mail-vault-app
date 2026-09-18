//! Backup, as **bookmark forwarders only** (Phase 3 remainder, Task 5). The
//! whole algorithm — the IMAP and Graph runners, the mirror pre-sync, the
//! purge queue, the status comparison, the flag catch-up — now lives in
//! `mailvault_core::backup` and runs in the daemon
//! (`src-daemon/src/handlers/backup.rs`, Tasks 1-4). What could not move is
//! the one thing this file still does: resolving the backup mirror's
//! security-scoped bookmark. A daemon cannot resolve a bookmark the app was
//! granted (spec §3.4), so the app resolves it, passes the resolved path as
//! `mirrorRoot`, and releases it once the daemon is done with it.
//!
//! Release discipline, two shapes:
//!
//! - `backup_status`/`backup_purge_uids`/`backup_scan_uids` are bounded calls
//!   that finish before they reply, so `forward` releases on EVERY path —
//!   success, daemon error, budget expiry — exactly like
//!   `vault_flags.rs`'s own forwarder. A release skipped on an error path
//!   leaks the scoped access for the process's life.
//! - `backup_run_account` is fire-and-forget: the daemon ACKs the start and
//!   the run keeps going for minutes afterwards, still needing the mirror
//!   path live. Its forwarder therefore parks the resolved path in
//!   [`HeldBackupPaths`] and the release happens when that run's terminal
//!   `backup-progress` frame (`active: false`) comes back up the channel —
//!   see [`release_after_terminal_progress`], called from
//!   `daemon_channel.rs`'s re-emit path.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;
use tracing::{info, warn};

use crate::external_location;

/// Every mirror-touching daemon call shares this budget, same value and same
/// reasoning as `vault_flags.rs`'s (`reply_timeout`'s 600 s family): a
/// whole-account status comparison lists every folder over IMAP, and a purge
/// walks mirror directories on what can be a slow external drive.
const MIRROR_BUDGET: std::time::Duration = std::time::Duration::from_secs(600);

/// The daemon replies to `backup_run_account` as soon as it has spawned the
/// run, so this only has to cover the handshake and the spawn — not the run.
const RUN_ACK_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

/// Resolve the effective external backup path.
/// Always prefers the native bookmark/stored location. Caller-supplied raw paths
/// are only accepted on Linux as a temporary override; on macOS they are ignored
/// (raw paths lose sandbox access after restart).
/// Returns (resolved_path, needs_release) — caller must call release_backup_path if needs_release is true.
// `caller_path` is read only in the Linux-fallback arms below; a macOS
// build compiles them away. Pre-existing (2516915d), not a 5.4b regression.
#[cfg_attr(target_os = "macos", allow(unused_variables))]
pub(crate) fn resolve_backup_path(
    app_handle: &tauri::AppHandle,
    caller_path: Option<String>,
) -> (Option<String>, bool) {
    // Try bookmark-based resolution first (authoritative source)
    let data_dir = match app_handle.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => {
            // Fallback: use caller path on Linux only
            #[cfg(not(target_os = "macos"))]
            if let Some(ref p) = caller_path {
                if !p.is_empty() { return (caller_path, false); }
            }
            return (None, false);
        }
    };

    match external_location::resolve_external_location(&data_dir, external_location::SLOT_EXTERNAL_BACKUP) {
        Ok((resolved, _loc)) => {
            info!("backup: resolved external location via bookmark: {}", resolved);
            (Some(resolved), true) // needs_release on macOS
        }
        Err(_) => {
            // No valid bookmark — on Linux, accept caller path as fallback
            #[cfg(not(target_os = "macos"))]
            if let Some(ref p) = caller_path {
                if !p.is_empty() {
                    info!("backup: using caller-supplied path (Linux): {}", p);
                    return (caller_path, false);
                }
            }
            // On macOS, never fall back to raw paths — they lose access after restart
            (None, false)
        }
    }
}

/// Release bookmark-based access if it was started.
pub(crate) fn release_backup_path(path: &str) {
    external_location::release_external_access(path);
}

// ── Bookmark scopes held for an in-flight run ────────────────────────────────

/// `account_id` → the resolved mirror path whose security scope that
/// account's in-flight backup run is still using. An entry's presence IS the
/// "needs release" flag: `resolve_backup_path` only reports `needs_release`
/// when it resolved a bookmark, and only then is anything parked here.
///
/// ponytail: two accounts backing up to the same drive resolve the same path,
/// so the first terminal frame releases a scope the second run is still
/// using. Pre-existing shape — the app-side runner resolved and released
/// per-account too — and the next call re-resolves; refcount per path if a
/// real double-run problem ever shows up.
#[derive(Default)]
pub struct HeldBackupPaths(pub Mutex<HashMap<String, String>>);

/// `try_state`, not `state`: `release_after_terminal_progress` runs inside
/// `daemon_channel.rs`'s read loop, and a panic there would take the app's
/// one daemon connection down with it.
fn held(app: &tauri::AppHandle) -> Option<tauri::State<'_, HeldBackupPaths>> {
    app.try_state::<HeldBackupPaths>()
}

/// Remember that `account_id`'s run needs `path` kept alive. A path already
/// parked for this account belonged to a run that never reported a terminal
/// frame or is a second start over the top of a live run: release it here
/// rather than leak it for the process's life.
fn hold_backup_path(app: &tauri::AppHandle, account_id: &str, path: &str) {
    let Some(held) = held(app) else {
        // Unreachable while the app runs (registered in `main.rs`'s
        // `.manage(...)` chain before any command can be invoked); releasing
        // now is the safe reading if it ever is not.
        warn!("backup: no HeldBackupPaths state — releasing the mirror scope immediately");
        release_backup_path(path);
        return;
    };
    let displaced = held
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(account_id.to_string(), path.to_string());
    if let Some(old) = displaced {
        warn!("backup: releasing a mirror scope left over from a previous run of {}", account_id);
        release_backup_path(&old);
    }
}

/// Claim `account_id`'s parked path, if there still is one. The map entry is
/// the claim: whoever removes it owns the release, so the two racers below
/// (this account's terminal frame and its own RPC error path) can never both
/// release the same scope, and neither can release nothing.
fn take_backup_path(app: &tauri::AppHandle, account_id: &str) -> Option<String> {
    held(app).and_then(|h| h.0.lock().unwrap_or_else(|p| p.into_inner()).remove(account_id))
}

/// A `backup-progress` frame just came up the daemon channel. When it is a
/// terminal one (`active: false`), the run that owned the mirror scope is
/// over: release it. Called for every `backup-progress` event, so anything
/// that is not terminal, or names no account we hold a scope for, is a no-op.
pub(crate) fn release_after_terminal_progress(app: &tauri::AppHandle, payload: &Value) {
    if payload.get("active").and_then(Value::as_bool) != Some(false) {
        return;
    }
    let Some(account_id) = payload.get("account_id").and_then(Value::as_str) else {
        return;
    };
    if let Some(path) = take_backup_path(app, account_id) {
        info!("backup: run for {} finished — releasing the mirror's scoped access", account_id);
        release_backup_path(&path);
    }
}

// ── Forwarders ───────────────────────────────────────────────────────────────

/// Resolve the mirror, let `params` see the resolved root (the status command
/// reports on that resolution), call the daemon with `mirrorRoot` added, then
/// release. Blocking on purpose — every caller is already inside
/// `spawn_blocking`. The release is unconditional: see the module doc.
pub(crate) fn forward(
    app: &tauri::AppHandle,
    method: &str,
    caller_path: Option<String>,
    params: impl FnOnce(Option<&str>) -> Value,
) -> Result<Value, String> {
    let (root, needs_release) = resolve_backup_path(app, caller_path);
    let mut params = params(root.as_deref());
    if let Some(obj) = params.as_object_mut() {
        obj.insert("mirrorRoot".into(), json!(root));
    }
    let result = crate::daemon_call_blocking(app, method, params, MIRROR_BUDGET);
    if needs_release {
        if let Some(ref p) = root {
            release_backup_path(p);
        }
    }
    if let Err(ref e) = result {
        if needs_release {
            // Same reasoning as `vault_flags.rs`'s: this fires on every error
            // with a mirror in play, not only a timeout — the daemon may
            // never have touched the mirror at all.
            warn!(
                "{method}: failed ({e}) — the backup mirror's access has been released; \
                 if this call timed out mid-purge, the next run's queue drain heals it"
            );
        }
    }
    result
}

/// Start one account's backup run. Fire-and-forget: the reply is the
/// daemon's `{"runId": accountId}` ACK, and the run's own `backup-progress`
/// events carry its outcome. The mirror's scoped access is held until the
/// terminal frame — see the module doc and [`hold_backup_path`].
pub(crate) fn run_account(
    app: &tauri::AppHandle,
    account_id: String,
    account_json: String,
    caller_path: Option<String>,
    skip_folders: usize,
) -> Result<Value, String> {
    let (root, needs_release) = resolve_backup_path(app, caller_path);
    // Park the path BEFORE the call, not after it. The daemon spawns the run
    // and only then writes this reply, and the reply and the event stream are
    // two different connections read by two different app-side tasks: a run
    // that fails in microseconds (a bad credential refused by
    // `pool.get_background`) can have its terminal frame reach
    // `release_after_terminal_progress` before `daemon_call_blocking` here
    // has even returned. Parked first, that frame finds the entry and
    // releases it; parked after, it would find nothing, and this function
    // would then park a path with no run left to release it.
    if needs_release {
        if let Some(ref path) = root {
            hold_backup_path(app, &account_id, path);
        }
    }
    let params = json!({
        "accountId": account_id,
        "accountJson": account_json,
        "mirrorRoot": root,
        "skipFolders": skip_folders,
    });
    let result = crate::daemon_call_blocking(app, "backup_run_account", params, RUN_ACK_BUDGET);
    // An `Ok` leaves it parked for the run. An `Err` means nothing started,
    // so nothing will ever report a terminal frame for it — but the frame may
    // already have arrived and released it (the daemon can spawn a run whose
    // reply then fails to reach us), so claim the entry instead of releasing
    // `root` blindly. Whichever side removes it owns the release; the other
    // finds nothing and does nothing.
    if result.is_err() {
        if let Some(path) = take_backup_path(app, &account_id) {
            release_backup_path(&path);
        }
    }
    result
}

#[tauri::command]
pub async fn backup_purge_uids(
    app_handle: tauri::AppHandle,
    email: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        // `purge_uids` fails closed on a missing `externalStatus` (it treats
        // it as "not_configured" and does NOT queue), so this is the one
        // piece of bookmark-adjacent state the daemon has no way to read for
        // itself and must always be told: it is what separates "no backup
        // configured, nothing to queue" from "configured but unreachable,
        // queue it for the next run".
        let status = external_location_status(&app_handle);
        forward(&app_handle, "backup_purge_uids", None, |_root| {
            json!({"email": email, "mailbox": mailbox, "uids": uids, "externalStatus": status})
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Which uids of `<email>/<mailbox>` are present in the external mirror.
///
/// `null` means "could not determine" — no backup location configured, or
/// one configured but unreachable (drive unplugged, bookmark stale). The UI
/// renders that as an explicit unknown; it must never be confused with an
/// empty list, which is the positive claim "nothing here is mirrored".
#[tauri::command]
pub async fn backup_scan_uids(
    app_handle: tauri::AppHandle,
    email: String,
    mailbox: String,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        // Users with no backup drive pay nothing: bail before resolving a
        // bookmark or waking the daemon. Same `null` the daemon would answer.
        if external_location_status(&app_handle).as_deref() == Some("not_configured") {
            return Ok(Value::Null);
        }
        forward(&app_handle, "backup_scan_uids", None, |_root| {
            json!({"email": email, "mailbox": mailbox})
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// The stored external-location status (`"ready"`, `"needs_reauth"`,
/// `"not_configured"`, ...), or `None` when there is no app data dir to read
/// it from — which the callers below treat as "not configured", the same
/// fail-closed reading `mailvault_core::backup::purge_uids` applies.
fn external_location_status(app_handle: &tauri::AppHandle) -> Option<String> {
    let data_dir = app_handle.path().app_data_dir().ok()?;
    Some(external_location::get_external_location(&data_dir, external_location::SLOT_EXTERNAL_BACKUP).status)
}

/// How the external location resolved, as the two fields the status reply
/// carries to the UI. Verbatim from the old `get_backup_status`'s own
/// enrichment block: a configured location that would not resolve renders as
/// `needs_reauth` plus whatever `validate_external_location` says went wrong.
pub(crate) fn external_status_fields(
    app_handle: &tauri::AppHandle,
    resolved: Option<&str>,
) -> (String, Option<String>) {
    if resolved.is_some() {
        return ("ready".to_string(), None);
    }
    let Ok(data_dir) = app_handle.path().app_data_dir() else {
        return ("not_configured".to_string(), None);
    };
    let loc = external_location::get_external_location(&data_dir, external_location::SLOT_EXTERNAL_BACKUP);
    if loc.status == "not_configured" {
        return ("not_configured".to_string(), None);
    }
    // There IS a configured location but it failed to resolve.
    let err = external_location::validate_external_location(&data_dir, external_location::SLOT_EXTERNAL_BACKUP)
        .map(|l| l.last_error)
        .unwrap_or(None);
    ("needs_reauth".to_string(), err)
}
