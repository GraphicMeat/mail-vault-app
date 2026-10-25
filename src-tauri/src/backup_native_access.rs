//! Native-only scheduler access handoff, reconciled off the channel pump.
use super::*;
use mailvault_core::backup_access::{self as wire, Attach, Attempt, Query, Resolution};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

#[derive(Default)]
pub(crate) struct NativeBackupAccess {
    holds: Mutex<HashMap<Attempt, String>>,
    session: Mutex<Option<String>>,
    busy: AtomicBool,
    dirty: AtomicBool,
}
trait Ports {
    fn call(&self, method: &str, params: Value) -> Result<Value, String>;
    fn resolve(&self) -> AttachResolution;
    fn release(&self, path: &str);
}
struct AttachResolution {
    stamp: Option<String>,
    result: Resolution,
}
/// A resolver may renew a stale bookmark. Release the first acquisition and
/// resolve again against the new record. Never label its old root with a new
/// selection's stamp. Two changes defer to the next reconciliation.
fn resolve_saved(
    read: impl Fn() -> Result<Option<String>, String>,
    resolve: impl Fn() -> Result<String, String>,
    release: impl Fn(&str),
) -> AttachResolution {
    for _ in 0..2 {
        let before = match read() {
            Ok(Some(s)) => s,
            Ok(None) => {
                return AttachResolution {
                    stamp: None,
                    result: Resolution::NotConfigured,
                }
            }
            Err(_) => {
                return AttachResolution {
                    stamp: None,
                    result: Resolution::Unknown,
                }
            }
        };
        let root = match resolve() {
            Ok(root) => root,
            Err(_) => {
                return AttachResolution {
                    stamp: Some(before),
                    result: Resolution::Unavailable,
                }
            }
        };
        if read().ok().flatten().as_ref() == Some(&before) {
            return AttachResolution {
                stamp: Some(before),
                result: Resolution::Authorized { root },
            };
        }
        release(&root);
    }
    AttachResolution {
        stamp: None,
        result: Resolution::Unknown,
    }
}
fn resolve_native(path: &std::path::Path) -> AttachResolution {
    resolve_saved(
        || wire::slot_stamp(path),
        || {
            external_location::resolve_external_location(
                path,
                external_location::SLOT_EXTERNAL_BACKUP,
            )
            .map(|r| r.0)
        },
        release_backup_path,
    )
}
struct AppPorts<'a>(&'a tauri::AppHandle);
impl Ports for AppPorts<'_> {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        crate::daemon_call_blocking(self.0, method, params, RUN_ACK_BUDGET)
    }
    fn resolve(&self) -> AttachResolution {
        match mailvault_core::paths::app_data_dir() {
            Ok(path) => resolve_native(&path),
            Err(_) => AttachResolution {
                stamp: None,
                result: Resolution::Unknown,
            },
        }
    }
    fn release(&self, path: &str) {
        release_backup_path(path)
    }
}
fn release_receipt(
    held: &NativeBackupAccess,
    ports: &dyn Ports,
    expected: &Attempt,
    value: &Value,
) {
    let matches = serde_json::from_value::<Attempt>(value["attempt"].clone())
        .ok()
        .as_ref()
        == Some(expected);
    if !matches
        || value["safeRelease"] != true
        || !matches!(
            value["state"].as_str(),
            Some("drained" | "fenced" | "rejected")
        )
    {
        return;
    }
    let path = held
        .holds
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(expected);
    if let Some(path) = path {
        ports.release(&path);
    }
}
fn session_matches(held: &NativeBackupAccess, owner: &str) -> bool {
    held.session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_deref()
        == Some(owner)
}
fn reconcile(held: &NativeBackupAccess, ports: &dyn Ports, owner: &str) {
    // Sample exact acquisitions before each round trip. Old replies cannot
    // remove a replacement acquisition, even for the same logical run.
    let observed = held
        .holds
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for attempt in observed {
        let params = serde_json::to_value(Query {
            attempt: attempt.clone(),
            fence_unstarted: true,
        })
        .unwrap();
        if let Ok(reply) = ports.call("backup.access_status", params) {
            release_receipt(held, ports, &attempt, &reply);
        }
    }
    if !session_matches(held, owner) {
        return;
    }
    let Ok(status) = ports.call("backup.schedule.status", json!({})) else {
        return;
    };
    let Some(incarnation) = status["accessIncarnation"].as_str() else {
        return;
    };
    let Some(pending) = status["pendingAccess"].as_array() else {
        return;
    };
    for intent in pending {
        let (Some(run), Some(execution)) =
            (intent["runId"].as_str(), intent["executionId"].as_str())
        else {
            continue;
        };
        if !session_matches(held, owner) {
            return;
        }
        if held
            .holds
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .any(|a| a.incarnation == incarnation && a.execution_id == execution)
        {
            continue;
        }
        let resolved = ports.resolve();
        let attempt = Attempt {
            incarnation: incarnation.into(),
            run_id: run.into(),
            execution_id: execution.into(),
            owner_id: owner.into(),
            acquisition_id: uuid::Uuid::new_v4().to_string(),
        };
        let path = match &resolved.result {
            Resolution::Authorized { root } => Some(root.clone()),
            _ => None,
        };
        if !session_matches(held, owner) {
            // No attach has been sent, so this acquisition cannot be in use.
            if let Some(path) = path {
                ports.release(&path);
            }
            return;
        }
        if let Some(path) = path {
            held.holds
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(attempt.clone(), path);
        }
        let attach = Attach {
            attempt: attempt.clone(),
            slot_stamp: resolved.stamp,
            resolution: resolved.result,
        };
        // The hold already exists before this RPC: a terminal event may beat
        // the ACK. Errors/timeouts retain it until an exact serialized receipt.
        if let Ok(reply) = ports.call(
            "backup.attach_access",
            serde_json::to_value(attach).unwrap(),
        ) {
            release_receipt(held, ports, &attempt, &reply);
        }
    }
}
pub(crate) fn connected(app: &tauri::AppHandle, owner: String) {
    if let Some(held) = app.try_state::<NativeBackupAccess>() {
        *held.session.lock().unwrap_or_else(|p| p.into_inner()) = Some(owner);
    }
    schedule(app);
}
pub(crate) fn disconnected(app: &tauri::AppHandle, owner: &str) {
    if let Some(held) = app.try_state::<NativeBackupAccess>() {
        let mut session = held.session.lock().unwrap_or_else(|p| p.into_inner());
        if session.as_deref() == Some(owner) {
            *session = None;
        }
    }
}
pub(crate) fn schedule(app: &tauri::AppHandle) {
    let Some(held) = app.try_state::<NativeBackupAccess>() else {
        return;
    };
    held.dirty.store(true, SeqCst);
    if held
        .busy
        .compare_exchange(false, true, SeqCst, SeqCst)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(held) = app.try_state::<NativeBackupAccess>() else {
            return;
        };
        for _ in 0..4 {
            if !held.dirty.swap(false, SeqCst) {
                break;
            }
            let owner = held
                .session
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Some(owner) = owner {
                reconcile(&held, &AppPorts(&app), &owner);
            }
        }
        held.busy.store(false, SeqCst);
        if held.dirty.load(SeqCst) {
            schedule(&app);
        }
    });
}
#[cfg(test)]
#[path = "backup_native_access_tests.rs"]
mod tests;
