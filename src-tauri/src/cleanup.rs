//! Run All Now for the auto-cleanup rules, as a **bookmark forwarder only**.
//! The run lives in the daemon (`src-daemon/src/cleanup_worker.rs`); this file
//! does the one thing the daemon cannot: resolve the backup drive's
//! security-scoped bookmark, so a rule can check the second copy there before
//! a delete, and keep that access while the run reads the drive.
//!
//! [`cleanup_run_now`] resolves the drive (when one is set up and reachable),
//! parks the path in [`HeldCleanupPath`] BEFORE the call (a run that ends at
//! once can send its `cleanup-run` done event before the reply is read), and
//! forwards `cleanup.run_now {mirrorRoot}`. The hold is let go by the run's
//! done event, a reply saying no run started, an event-stream lag or a
//! channel reconnect. Releasing early is safe: the run then cannot read the
//! drive, and a copy it cannot see there stays on the server.
//!
//! With no drive set up, or one that will not resolve, the call goes without
//! `mirrorRoot`, and the daemon deletes nothing that needs the drive.
//! The daily run never has the drive (no window to resolve it).

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tracing::{info, warn};

use crate::abd::Ports;
use crate::external_location;

/// Daemon event of a run's start and end.
pub(crate) const CLEANUP_RUN: &str = "cleanup-run";

/// `cleanup.run_now` answers as soon as the run is handed to the worker.
const START_BUDGET: Duration = Duration::from_secs(30);

/// The resolved drive path held for the run that is going, if any.
#[derive(Default)]
pub struct HeldCleanupPath(pub Mutex<Option<String>>);

impl HeldCleanupPath {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Park `path`. `false` when one is already held (a run with the drive is
    /// going): the caller then must not resolve or hold another.
    fn hold(&self, path: &str) -> bool {
        let mut s = self.slot();
        if s.is_some() {
            return false;
        }
        *s = Some(path.to_string());
        true
    }
    fn busy(&self) -> bool {
        self.slot().is_some()
    }
    /// Whoever takes the entry owns its one release.
    fn take(&self) -> Option<String> {
        self.slot().take()
    }
}

fn started(reply: &Result<Value, String>) -> bool {
    matches!(reply, Ok(v) if v.get("started").and_then(Value::as_bool) == Some(true))
}

fn run_now_flow(held: &HeldCleanupPath, ports: &dyn Ports) -> Result<Value, String> {
    // A run with the drive is already going: the daemon answers `running`.
    // If it starts one instead, the held path was left by a done event that
    // never arrived: let it go (this run goes without the drive).
    if held.busy() {
        let reply = ports.call("cleanup.run_now", json!({}), START_BUDGET);
        if started(&reply) {
            if let Some(stale) = held.take() {
                ports.release(&stale);
            }
        }
        return reply;
    }
    let root = ports.resolve().filter(|r| {
        let ok = ports.exists(r);
        if !ok {
            ports.release(r);
        }
        ok
    });
    let Some(root) = root else {
        return ports.call("cleanup.run_now", json!({}), START_BUDGET);
    };
    if !held.hold(&root) {
        // Lost a race to another click: this one goes without the drive.
        ports.release(&root);
        return ports.call("cleanup.run_now", json!({}), START_BUDGET);
    }
    let reply = ports.call("cleanup.run_now", json!({ "mirrorRoot": root }), START_BUDGET);
    // No run started (one is going, or an error): no done event will come for
    // this hold. Claim it instead of releasing blindly: a done event of a run
    // that ended meanwhile may already have.
    if !started(&reply) {
        if let Some(path) = held.take() {
            ports.release(&path);
        }
    }
    reply
}

fn release_after_event_with(held: &HeldCleanupPath, payload: &Value, mut release: impl FnMut(&str)) {
    if payload.get("state").and_then(Value::as_str) != Some("done") {
        return;
    }
    if let Some(path) = held.take() {
        release(&path);
    }
}

// ── Tauri command ────────────────────────────────────────────────────────────

/// Start an auto-cleanup run now (daemon `cleanup.run_now`), with the backup
/// drive resolved when one is set up. Answers the daemon's `{started}`.
#[tauri::command]
pub async fn cleanup_run_now(app_handle: tauri::AppHandle) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let Some(held) = app_handle.try_state::<HeldCleanupPath>() else {
            return Err("errors.cleanupUnavailable".to_string());
        };
        run_now_flow(&held, &crate::abd::AppPorts(&app_handle))
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

// ── Called from daemon_channel.rs ────────────────────────────────────────────

/// A `cleanup-run` event came up the daemon channel: a done one lets the
/// drive go. `try_state`: this runs inside the channel's read loop.
pub(crate) fn release_after_event(app: &tauri::AppHandle, payload: &Value) {
    let Some(held) = app.try_state::<HeldCleanupPath>() else { return };
    release_after_event_with(&held, payload, |path| {
        info!("cleanup: run over, releasing the backup drive's scoped access");
        external_location::release_external_access(path);
    });
}

/// The event stream lagged or the channel reconnected: the done event may be gone.
pub(crate) fn release_all(app: &tauri::AppHandle, why: &str) {
    let Some(held) = app.try_state::<HeldCleanupPath>() else { return };
    if let Some(path) = held.take() {
        warn!("cleanup: {why}, releasing the backup drive's scoped access");
        external_location::release_external_access(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        root: Option<String>,
        missing: bool,
        reply: Option<Result<Value, String>>,
        calls: RefCell<Vec<Value>>,
        released: RefCell<Vec<String>>,
    }

    impl Ports for Fake {
        fn resolve(&self) -> Option<String> {
            self.root.clone()
        }
        fn exists(&self, _path: &str) -> bool {
            !self.missing
        }
        fn release(&self, path: &str) {
            self.released.borrow_mut().push(path.to_string());
        }
        fn call(&self, method: &str, params: Value, _budget: Duration) -> Result<Value, String> {
            assert_eq!(method, "cleanup.run_now");
            self.calls.borrow_mut().push(params);
            self.reply.clone().unwrap_or_else(|| Ok(json!({"started": true})))
        }
    }

    #[test]
    fn a_resolved_drive_is_handed_over_and_held_until_the_run_is_done() {
        let held = HeldCleanupPath::default();
        let f = Fake { root: Some("/Volumes/B".into()), ..Default::default() };
        run_now_flow(&held, &f).unwrap();
        assert_eq!(f.calls.borrow()[0], json!({"mirrorRoot": "/Volumes/B"}));
        assert!(f.released.borrow().is_empty(), "held while the run reads it");
        let mut released = Vec::new();
        release_after_event_with(&held, &json!({"state": "running"}), |p| released.push(p.to_string()));
        assert!(released.is_empty());
        release_after_event_with(&held, &json!({"state": "done"}), |p| released.push(p.to_string()));
        assert_eq!(released, vec!["/Volumes/B".to_string()]);
        release_after_event_with(&held, &json!({"state": "done"}), |p| released.push(p.to_string()));
        assert_eq!(released.len(), 1, "released once");
    }

    #[test]
    fn no_drive_goes_without_a_mirror_root() {
        let held = HeldCleanupPath::default();
        let f = Fake::default();
        run_now_flow(&held, &f).unwrap();
        assert_eq!(f.calls.borrow()[0], json!({}));
        let gone = Fake { root: Some("/Volumes/B".into()), missing: true, ..Default::default() };
        run_now_flow(&held, &gone).unwrap();
        assert_eq!(gone.calls.borrow()[0], json!({}));
        assert_eq!(*gone.released.borrow(), vec!["/Volumes/B".to_string()], "an unplugged drive's scope is let go");
        assert!(!held.busy());
    }

    #[test]
    fn a_run_that_did_not_start_lets_the_drive_go_at_once() {
        for reply in [Ok(json!({"started": false, "running": true})), Err("errors.cleanupUnavailable".to_string())] {
            let held = HeldCleanupPath::default();
            let f = Fake { root: Some("/Volumes/B".into()), reply: Some(reply), ..Default::default() };
            let _ = run_now_flow(&held, &f);
            assert_eq!(*f.released.borrow(), vec!["/Volumes/B".to_string()]);
            assert!(!held.busy());
        }
    }

    #[test]
    fn a_second_click_while_a_drive_run_is_going_resolves_nothing() {
        let held = HeldCleanupPath::default();
        held.hold("/Volumes/B");
        let f = Fake { root: Some("/Volumes/C".into()), reply: Some(Ok(json!({"started": false, "running": true}))), ..Default::default() };
        run_now_flow(&held, &f).unwrap();
        assert_eq!(f.calls.borrow()[0], json!({}));
        assert!(f.released.borrow().is_empty(), "the running run keeps its drive");
        assert_eq!(held.take().as_deref(), Some("/Volumes/B"));
    }

    #[test]
    fn a_hold_whose_done_event_was_lost_is_let_go_by_the_next_run() {
        let held = HeldCleanupPath::default();
        held.hold("/Volumes/B");
        let f = Fake { root: Some("/Volumes/C".into()), ..Default::default() };
        run_now_flow(&held, &f).unwrap();
        assert_eq!(*f.released.borrow(), vec!["/Volumes/B".to_string()]);
        assert!(!held.busy());
    }
}
