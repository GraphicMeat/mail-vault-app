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
//! - `backup_status`/`backup_purge_uids`/`backup_scan_uids`/`backup_copy_uids` are bounded calls
//!   that finish before they reply, so `forward` releases on EVERY path —
//!   success, daemon error, budget expiry — exactly like
//!   `vault_flags.rs`'s own forwarder. A release skipped on an error path
//!   leaks the scoped access for the process's life.
//! - `backup_run_account` is fire-and-forget: the daemon ACKs the start and
//!   the run keeps going for minutes afterwards, still needing the mirror
//!   path live. Its forwarder therefore parks the resolved path in the
//!   shell's `native_lease::Leases` (`Job::BackupRun`) and the release
//!   happens when that run's terminal `backup-progress` frame comes back up
//!   the channel (see [`legacy_run_over`]). Unlike the other jobs there, a
//!   channel reconnect or lag does not release it: the run goes on.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;
use tracing::{info, warn};

use crate::external_location;
use crate::native_lease::{Job, Leases};
#[path = "backup_native_access.rs"]
mod native_access;
pub(crate) use native_access::{
    connected as access_connected, disconnected as access_disconnected,
    schedule as reconcile_native_access, NativeBackupAccess,
};

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
    let data_dir = match mailvault_core::paths::app_data_dir() {
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

// ── The hold of an in-flight run ─────────────────────────────────────────────

/// Daemon event of a backup run's progress, legacy and native alike.
pub(crate) const BACKUP_PROGRESS: &str = "backup-progress";

/// Whether a `backup-progress` frame ends a legacy run's hold: the run is
/// over (`active: false`). A native scheduler frame carries `runId` or
/// `executionId` and never releases a legacy hold; its access is
/// `backup_native_access.rs`'s.
///
/// ponytail: two accounts backing up to the same drive resolve the same path,
/// so the first terminal frame releases a scope the second run is still
/// using. Pre-existing shape, and the next call re-resolves; refcount per
/// path if a real double-run problem ever shows up.
pub(crate) fn legacy_run_over(payload: &Value) -> bool {
    payload.get("runId").is_none()
        && payload.get("executionId").is_none()
        && payload.get("active").and_then(Value::as_bool) == Some(false)
}

#[cfg(test)]
mod native_access_tests {
    use super::*;
    #[test]
    fn backup_access_correlated_terminal_cannot_release_legacy_hold() {
        let held = Leases::default();
        held.hold(Job::BackupRun, "one", "/same-drive");
        let released = held.after_event(
            BACKUP_PROGRESS,
            &json!({"account_id":"one","active":false,"runId":"native-run","executionId":"native-execution"}),
        );
        assert!(released.is_empty(), "native progress released the independent legacy acquisition");
        assert_eq!(held.after_event(BACKUP_PROGRESS, &json!({"account_id":"one","active":false})).len(), 1);
    }
}

// ── Forwarders ───────────────────────────────────────────────────────────────

/// Resolve the mirror, let `params` see the resolved root (the status command
/// reports on that resolution), call the daemon with `mirrorRoot` added, then
/// release. Blocking on purpose: every caller is already inside
/// `spawn_blocking`. The release is unconditional: see the module doc.
pub(crate) fn forward(
    app: &tauri::AppHandle,
    method: &str,
    caller_path: Option<String>,
    params: impl FnOnce(Option<&str>) -> Value,
) -> Result<Value, String> {
    call_with_mirror(app, method, resolve_backup_path(app, caller_path), params, MIRROR_BUDGET)
}

/// The bounded-call half of [`forward`], for a caller that resolved the
/// mirror itself: call with `mirrorRoot`, release on EVERY path (success,
/// daemon error, budget expiry), then answer.
fn call_with_mirror(
    app: &tauri::AppHandle,
    method: &str,
    (root, needs_release): (Option<String>, bool),
    params: impl FnOnce(Option<&str>) -> Value,
    budget: std::time::Duration,
) -> Result<Value, String> {
    let mut params = params(root.as_deref());
    if let Some(obj) = params.as_object_mut() {
        obj.insert("mirrorRoot".into(), json!(root));
    }
    let result = crate::daemon_call_blocking(app, method, params, budget);
    if needs_release {
        if let Some(ref p) = root {
            release_backup_path(p);
        }
    }
    if let Err(ref e) = result {
        if needs_release {
            // This fires on every error with a mirror in play, not only a
            // timeout: the daemon may never have touched the mirror at all.
            // Say "if", so an unrelated failure does not read as proof the
            // mirror was mid-write.
            warn!(
                "{method}: failed ({e}): the backup mirror's access has been released; \
                 if this call timed out mid-write, the mirror may be left partly written, \
                 which the next backup run or catch-up heals"
            );
        }
    }
    result
}

/// Start one account's backup run. Fire-and-forget: the reply is the
/// daemon's `{"runId": accountId}` ACK, and the run's own `backup-progress`
/// events carry its outcome. The mirror's scoped access is held until the
/// terminal frame (see the module doc).
pub(crate) fn run_account(
    app: &tauri::AppHandle,
    account_id: String,
    account_json: String,
    caller_path: Option<String>,
    skip_folders: usize,
    mailbox_concurrency: usize,
) -> Result<Value, String> {
    let (root, needs_release) = resolve_backup_path(app, caller_path);
    let params = json!({
        "accountId": account_id,
        "accountJson": account_json,
        "mirrorRoot": root,
        "skipFolders": skip_folders,
        "mailboxConcurrency": mailbox_concurrency.clamp(1, 5),
    });
    let call = || crate::daemon_call_blocking(app, "backup_run_account", params, RUN_ACK_BUDGET);
    // Park the path BEFORE the call, not after it. The daemon spawns the run
    // and only then writes this reply, and the reply and the event stream are
    // two different connections read by two different app-side tasks: a run
    // that fails in microseconds (a bad credential refused by
    // `pool.get_background`) can have its terminal frame reach the channel
    // before `daemon_call_blocking` here has even returned. An `Err` means
    // nothing started, and the entry is claimed back (`call_holding`).
    let Some(path) = root.as_deref().filter(|_| needs_release) else {
        // Nothing to park, but a failed start still claims back a hold an
        // earlier run of this account left (its terminal frame never came).
        let result = call();
        if result.is_err() {
            if let Some(stale) = app.try_state::<Leases>().and_then(|l| l.take(Job::BackupRun, &account_id)) {
                release_backup_path(&stale);
            }
        }
        return result;
    };
    let Some(leases) = app.try_state::<Leases>() else {
        // Unreachable while the app runs (managed in `main.rs` before any
        // command can be invoked); releasing now is the safe reading.
        warn!("backup: no lease registry, releasing the mirror scope immediately");
        release_backup_path(path);
        return call();
    };
    leases.call_holding(Job::BackupRun, &account_id, path, &release_backup_path, call, Result::is_ok)
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
        let status = external_location_status();
        forward(&app_handle, "backup_purge_uids", None, |_root| {
            json!({"email": email, "mailbox": mailbox, "uids": uids, "externalStatus": status})
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Copy the vault files of `uids` into the external backup mirror and verify
/// each copy (daemon `backup_copy_uids`, `mailvault_core::backup::copy_uids_to_mirror`).
///
/// A bounded call like `backup_purge_uids`: the slot is resolved, held for the
/// call and released on every path by `forward`. There is deliberately no
/// `externalStatus` and no queue: a drive that cannot be reached is an error
/// the caller answers by keeping the mail on the server (the daemon answers
/// `Backup folder unavailable` for the `mirrorRoot: null` an unresolved
/// bookmark forwards). Every read, write and comparison happens in the daemon.
#[tauri::command]
pub async fn backup_copy_uids(
    app_handle: tauri::AppHandle,
    account_id: String,
    email: String,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        forward(&app_handle, "backup_copy_uids", None, |_root| {
            json!({"accountId": account_id, "email": email, "mailbox": mailbox, "uids": uids})
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// A Microsoft account's switch between Graph and IMAP
/// (`accounts.switch_transport`) re-files the account's backup folder with its
/// vault, so the shell resolves the drive and holds it for the switch. A drive
/// that is configured but will not resolve refuses the switch: the backup
/// would keep the old numbering and copy it back into the vault.
#[tauri::command]
pub async fn accounts_switch_transport(app_handle: tauri::AppHandle, params: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let configured = external_location_status().as_deref().is_some_and(|s| s != "not_configured");
        let resolved = if configured { resolve_backup_path(&app_handle, None) } else { (None, false) };
        if configured && resolved.0.is_none() {
            return Err("errors.transportSwitchBackupUnavailable".to_string());
        }
        call_with_mirror(&app_handle, "accounts.switch_transport", resolved, |_| params, SWITCH_BUDGET)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// A switch lists every folder over IMAP and re-files the vault and the
/// backup folder before it answers.
const SWITCH_BUDGET: std::time::Duration = std::time::Duration::from_secs(1800);

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
        if external_location_status().as_deref() == Some("not_configured") {
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
pub(crate) fn external_location_status() -> Option<String> {
    let data_dir = mailvault_core::paths::app_data_dir().ok()?;
    Some(external_location::get_external_location(&data_dir, external_location::SLOT_EXTERNAL_BACKUP).status)
}

/// How the external location resolved, as the two fields the status reply
/// carries to the UI. Verbatim from the old `get_backup_status`'s own
/// enrichment block: a configured location that would not resolve renders as
/// `needs_reauth` plus whatever `validate_external_location` says went wrong.
pub(crate) fn external_status_fields(
    resolved: Option<&str>,
) -> (String, Option<String>) {
    if resolved.is_some() {
        return ("ready".to_string(), None);
    }
    let Ok(data_dir) = mailvault_core::paths::app_data_dir() else {
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

// A channel surface generation is separate from mirror authorization.
static SURFACE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn surface_generation() -> String {
    static SHELL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    format!("{}:{}", SHELL.get_or_init(|| uuid::Uuid::new_v4().to_string()),SURFACE_GENERATION.load(std::sync::atomic::Ordering::SeqCst))
}
pub(crate) fn begin_surface_generation() -> String {
    SURFACE_GENERATION.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
    surface_generation()
}
pub(crate) fn surface_id(label: &str) -> String { format!("{}:{label}",surface_generation()) }
fn retired_surfaces() -> &'static Mutex<std::collections::BTreeSet<String>> {
    static RETIRED: std::sync::OnceLock<Mutex<std::collections::BTreeSet<String>>> = std::sync::OnceLock::new();
    RETIRED.get_or_init(Default::default)
}
fn bind_surface_params(generation: &str, label: &str, mut params: Value) -> Result<Value,String> {
    let id = format!("{generation}:{label}");
    if retired_surfaces().lock().unwrap_or_else(|p|p.into_inner()).contains(&id) { return Err("errors.settingsInvalid".into()); }
    let object = params.as_object_mut().ok_or("errors.settingsInvalid")?;
    object.insert("surfaceId".into(), json!(id));
    Ok(params)
}
pub(crate) fn surface_params(label: &str, params: Value) -> Result<Value,String> {
    if !crate::daemon_channel::is_connected() { return Err("errors.settingsNotLoaded".into()); }
    bind_surface_params(&surface_generation(),label,params)
}
pub(crate) fn retire_surface(label: &str) {
    let id = surface_id(label);
    retired_surfaces().lock().unwrap_or_else(|p|p.into_inner()).insert(id.clone());
    crate::daemon_channel::notify("backup.surface_retire", json!({"surfaceId":id}));
}
fn replay_retired_surfaces(mut send: impl FnMut(Value)) {
    let retired = retired_surfaces().lock().unwrap_or_else(|p|p.into_inner()).clone();
    for id in retired { send(json!({"surfaceId":id})); }
}
pub(crate) fn reconcile_surface_retirement() {
    replay_retired_surfaces(|params|crate::daemon_channel::notify("backup.surface_retire",params));
}
#[cfg(test)]
mod surface_tests {
    use super::*;
    #[test]
    fn backup_surface_identity_is_native_and_destroyed_generation_is_terminal() {
        let label = format!("surface-{}",uuid::Uuid::new_v4());
        let native = bind_surface_params(&surface_generation(),&label,json!({"surfaceId":"another-window","sessionId":"session"})).unwrap();
        assert_eq!(native["surfaceId"],surface_id(&label));
        retire_surface(&label);
        assert!(bind_surface_params(&surface_generation(),&label,json!({"surfaceId":"another-window"})).is_err());
        let mut replayed = vec![]; replay_retired_surfaces(|p|replayed.push(p));
        assert!(replayed.iter().any(|p|p["surfaceId"] == native["surfaceId"]),"disconnected destruction was lost before reconnect");
        assert!(bind_surface_params(&surface_generation(),&format!("{label}-new"),json!({})).is_ok());
    }
}
