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
use tauri::Manager;

use crate::external_location::{self, ExternalLocation, SLOT_ATTACHMENT_EXPORT};
use crate::native_lease::{Job, Leases};

/// The daemon routes this forwards; anything else is refused.
const EXPORT_METHODS: [&str; 3] = ["export_attachments", "views.export_attachments", "people.export_vcf"];

/// The daemon answers as soon as the job is spawned: this covers the start.
const START_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) const EXPORT_PROGRESS: &str = "attachment-export-progress";

/// Whether an `attachment-export-progress` frame is its job's last.
pub(crate) fn job_over(frame: &Value) -> bool {
    frame.get("finished").and_then(Value::as_bool) == Some(true)
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
    // frame before this reply is read (see `native_lease`).
    let Some(leases) = app.try_state::<Leases>() else {
        external_location::release_external_access(&resolved);
        return Err("Export folder access is not set up".to_string());
    };
    leases.call_holding(
        Job::Export,
        &job_id,
        &resolved,
        &external_location::release_external_access,
        || crate::daemon_call_blocking(app, method, params, START_BUDGET),
        Result::is_ok,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contacts_export_is_an_allowed_export_method() {
        assert!(EXPORT_METHODS.contains(&"people.export_vcf"));
        assert!(EXPORT_METHODS.contains(&"export_attachments"));
    }

    #[test]
    fn only_a_final_frame_of_a_held_job_releases_it() {
        let held = Leases::default();
        assert_eq!(held.hold(Job::Export, "j1", "/picked"), None);
        let take = |frame: Value| held.after_event(EXPORT_PROGRESS, &frame).into_iter().map(|(_, p)| p).next();
        assert_eq!(take(json!({"jobId": "j1", "done": 1, "total": 2})), None);
        assert_eq!(take(json!({"jobId": "other", "finished": true})), None);
        assert_eq!(take(json!({"jobId": "j1", "finished": true, "error": "x"})), Some("/picked".to_string()));
        assert_eq!(take(json!({"jobId": "j1", "finished": true})), None, "released once");
    }

    #[test]
    fn a_lag_or_reconnect_releases_every_job() {
        let held = Leases::default();
        held.hold(Job::Export, "a", "/one");
        held.hold(Job::Export, "b", "/two");
        let mut all: Vec<_> = held.on_reset().into_iter().map(|(_, p)| p).collect();
        all.sort();
        assert_eq!(all, vec!["/one".to_string(), "/two".to_string()]);
        assert!(held.on_reset().is_empty());
    }

    #[test]
    fn a_resolution_failure_reads_as_its_reason() {
        let loc = json!({"displayPath": "/p", "platform": "macos", "status": "needs_reauth", "lastError": "stale"});
        assert_eq!(reason(loc.to_string()), "Folder not accessible: stale");
        assert_eq!(reason("plain".into()), "plain");
    }
}
