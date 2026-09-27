//! Attachment saves into a folder the person picked, as a **bookmark
//! forwarder** (architecture.md, "bookmark forwarders"). The daemon does the
//! whole export (`export_attachments`, `views.export_attachments`); what it
//! cannot do is reach a folder outside the vault on a sandboxed build. So the
//! shell does exactly what it does for the backup mirror: persist the picked
//! folder as a security-scoped bookmark in its own slot
//! (`SLOT_ATTACHMENT_EXPORT`, overwritten per pick, never the backup's),
//! check a real write lands there, resolve it and start access, forward the
//! call with the job running under that access, and release it when the job
//! is over. On Windows and Linux the same calls are a stored plain path plus
//! the write check (Snap confinement included).
//!
//! The export is a job (the daemon answers `{ jobId }` at once), so the
//! release follows `backup_run_account`'s shape, not the bounded calls': the
//! resolved path is parked under the job id BEFORE the call, and released by
//! the job's final `attachment-export-progress` frame, by a failed start, or,
//! for every job at once, when the event stream lags or the daemon channel
//! reconnects (either can have eaten a final frame).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;
use tracing::{info, warn};

use crate::external_location::{self, ExternalLocation, SLOT_ATTACHMENT_EXPORT};

/// The two daemon routes this forwards; anything else is refused.
const EXPORT_METHODS: [&str; 2] = ["export_attachments", "views.export_attachments"];

/// The daemon answers as soon as the job is spawned: this covers the start.
const START_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) const EXPORT_PROGRESS: &str = "attachment-export-progress";

/// Job id -> the resolved folder whose scoped access that job still uses.
/// The entry is the claim: whoever removes it owns the release.
#[derive(Default)]
pub struct HeldExportPaths(pub Mutex<HashMap<String, String>>);

impl HeldExportPaths {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Park `path` for `job_id`; answers a path a reused id displaced.
    fn hold(&self, job_id: &str, path: &str) -> Option<String> {
        self.map().insert(job_id.to_string(), path.to_string())
    }
    fn take(&self, job_id: &str) -> Option<String> {
        self.map().remove(job_id)
    }
    /// The path a final frame lets go of, if the frame is final and ours.
    fn take_finished(&self, frame: &Value) -> Option<String> {
        if frame.get("finished").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        self.take(frame.get("jobId").and_then(Value::as_str)?)
    }
    fn take_all(&self) -> Vec<String> {
        self.map().drain().map(|(_, path)| path).collect()
    }
}

/// A resolution or write-check failure says why in `lastError`; the rest is
/// noise to the person reading the save's error.
fn reason(err: String) -> String {
    serde_json::from_str::<ExternalLocation>(&err)
        .ok()
        .and_then(|loc| loc.last_error)
        .map(|e| format!("Folder not accessible: {e}"))
        .unwrap_or(err)
}

/// Start one export job whose files go under `folder`. `params` go to the
/// daemon unchanged (they already name `destDir` inside `folder` and the
/// client's `jobId`).
#[tauri::command]
pub async fn attachment_export_start(app_handle: tauri::AppHandle, method: String, folder: String, params: Value) -> Result<Value, String> {
    if !EXPORT_METHODS.contains(&method.as_str()) {
        return Err(format!("Not an export: {method}"));
    }
    tokio::task::spawn_blocking(move || start(&app_handle, &method, &folder, params))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

fn start(app: &tauri::AppHandle, method: &str, folder: &str, params: Value) -> Result<Value, String> {
    let job_id = params.get("jobId").and_then(Value::as_str).ok_or("Missing jobId")?.to_string();
    let data_dir = mailvault_core::paths::app_data_dir().map_err(|e| e.to_string())?;
    // The picker's grant is live right now: the bookmark made from it is what
    // outlives it. Then a real write, the same check the backup location gets.
    external_location::save_external_location(&data_dir, SLOT_ATTACHMENT_EXPORT, folder)?;
    let checked = external_location::validate_external_location(&data_dir, SLOT_ATTACHMENT_EXPORT)?;
    if checked.status != "ready" {
        return Err(format!("Folder not accessible: {}", checked.last_error.unwrap_or(checked.status)));
    }
    let (resolved, _) = external_location::resolve_external_location(&data_dir, SLOT_ATTACHMENT_EXPORT).map_err(reason)?;
    // Parked BEFORE the call: a job that fails at once can send its final
    // frame before this reply is read (see `backup::run_account`).
    let Some(held) = app.try_state::<HeldExportPaths>() else {
        external_location::release_external_access(&resolved);
        return Err("Export folder access is not set up".to_string());
    };
    if let Some(displaced) = held.hold(&job_id, &resolved) {
        external_location::release_external_access(&displaced);
    }
    let result = crate::daemon_call_blocking(app, method, params, START_BUDGET);
    if result.is_err() {
        if let Some(path) = held.take(&job_id) {
            external_location::release_external_access(&path);
        }
    }
    result
}

/// An `attachment-export-progress` frame came up the daemon channel: a final
/// one ends its job's hold on the folder.
pub(crate) fn release_after_final_frame(app: &tauri::AppHandle, frame: &Value) {
    let Some(held) = app.try_state::<HeldExportPaths>() else { return };
    if let Some(path) = held.take_finished(frame) {
        info!("export: job finished, releasing the folder's scoped access");
        external_location::release_external_access(&path);
    }
}

/// The event stream lagged or the channel reconnected: a final frame may be
/// gone, and the app has already failed every job in flight, so every hold
/// goes.
pub(crate) fn release_all(app: &tauri::AppHandle, why: &str) {
    let Some(held) = app.try_state::<HeldExportPaths>() else { return };
    let paths = held.take_all();
    if !paths.is_empty() {
        warn!("export: {why}, releasing {} export folder(s)", paths.len());
    }
    for path in paths {
        external_location::release_external_access(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_final_frame_of_a_held_job_releases_it() {
        let held = HeldExportPaths::default();
        assert_eq!(held.hold("j1", "/picked"), None);
        assert_eq!(held.take_finished(&json!({"jobId": "j1", "done": 1, "total": 2})), None);
        assert_eq!(held.take_finished(&json!({"jobId": "other", "finished": true})), None);
        assert_eq!(held.take_finished(&json!({"jobId": "j1", "finished": true, "error": "x"})), Some("/picked".to_string()));
        assert_eq!(held.take_finished(&json!({"jobId": "j1", "finished": true})), None, "released once");
    }

    #[test]
    fn a_lag_or_reconnect_releases_every_job() {
        let held = HeldExportPaths::default();
        held.hold("a", "/one");
        held.hold("b", "/two");
        let mut all = held.take_all();
        all.sort();
        assert_eq!(all, vec!["/one".to_string(), "/two".to_string()]);
        assert!(held.take_all().is_empty());
    }

    #[test]
    fn a_resolution_failure_reads_as_its_reason() {
        let loc = json!({"displayPath": "/p", "platform": "macos", "status": "needs_reauth", "lastError": "stale"});
        assert_eq!(reason(loc.to_string()), "Folder not accessible: stale");
        assert_eq!(reason("plain".into()), "plain");
    }
}
