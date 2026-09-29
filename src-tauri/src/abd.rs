//! "Archive (& back up) & delete from server" jobs, as **bookmark forwarders
//! only** (Part D, T6). The whole job (planning, download, verify, delete,
//! resume) lives in the daemon (`mailvault_core::abd`, `abd_worker`); this file
//! does the one thing the daemon cannot: resolve the backup drive's
//! security-scoped bookmark and keep that access alive for as long as the job
//! is using the path it was handed.
//!
//! Three shell commands, each a forwarder:
//!
//! - [`abd_summarize`]: a bounded call. In backup mode the slot is resolved, the
//!   path is sent as `mirrorRoot` and released on EVERY path (same discipline as
//!   `backup::forward`). It never parks anything.
//! - [`abd_start`]: fire-and-forget like `backup::run_account`. In backup mode
//!   the resolved path is parked in [`HeldAbdPaths`] BEFORE the call (a job that
//!   fails at once can send its terminal frame before the reply is read), and is
//!   let go by the terminal `abd-progress` frame, a frame saying the job paused
//!   for the drive, a failed start, an event-stream lag or a channel reconnect.
//!   Archive-only mode never resolves or holds the drive.
//! - [`abd_attach`]: re-hands the drive to a job that is already running (app
//!   restart, channel reconnect, "drive is back"). Only the shell can resolve
//!   the bookmark, so this is how a job paused for the drive resumes.
//!
//! [`HeldAbdPaths`] is a separate map from `backup::HeldBackupPaths`: a
//! `backup-progress` frame must never release a job's drive and an
//! `abd-progress` frame must never release a backup run's.
//!
//! Releasing on a pause, a lag or a reconnect is safe: the daemon keeps running
//! on the path it was given, a lost scope makes the next mirror write or verify
//! fail (the job pauses `drive_unavailable`), every delete re-verifies the
//! mirror copy first, and the app re-attaches.
//!
//! The flows below take a [`Ports`] value so the hold and release behaviour is
//! unit tested without a Tauri runtime or a real bookmark.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tracing::{info, warn};

use crate::external_location;

/// Daemon event carrying one job's progress frame (6.6 of the design).
pub(crate) const ABD_PROGRESS: &str = "abd-progress";

/// Both job modes. Only the second one ever touches the drive.
const MODE_ARCHIVE_ONLY: &str = "archive_delete";
const MODE_BACKUP: &str = "archive_backup_delete";

/// A backup-mode job never starts without the drive. Code first, then an English
/// sentence, like the daemon's `E_ABD_*:` errors (the frontend maps the code).
const ERR_NO_BACKUP_DRIVE: &str = "E_ABD_NO_BACKUP_DRIVE: The backup folder is not available.";

/// `abd.start` and `abd.attach_mirror` answer as soon as the job is spawned or
/// the path stored: this covers the handshake and the spawn, not the job.
const START_BUDGET: Duration = Duration::from_secs(30);
const ATTACH_BUDGET: Duration = Duration::from_secs(30);
/// Same value and reasoning as `backup.rs`'s `MIRROR_BUDGET`: a summary reads
/// the mirror to count what is already on the drive, possibly a slow external one.
const SUMMARIZE_BUDGET: Duration = Duration::from_secs(600);

/// `account_id` -> the resolved mirror path held for that account's job.
/// Separate from `HeldBackupPaths`. The entry is the claim: whoever removes it
/// owns the release, so a terminal frame and a failed-start path can never both
/// release one scope.
#[derive(Default)]
pub struct HeldAbdPaths(pub Mutex<HashMap<String, String>>);

impl HeldAbdPaths {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Park `path` for `account_id`; answers the path it displaced (a second
    /// start or attach over a live job), which the caller must release.
    pub fn hold(&self, account_id: &str, path: &str) -> Option<String> {
        self.map().insert(account_id.to_string(), path.to_string())
    }
    pub fn take(&self, account_id: &str) -> Option<String> {
        self.map().remove(account_id)
    }
    pub fn take_all(&self) -> Vec<String> {
        self.map().drain().map(|(_, path)| path).collect()
    }
    /// The path a frame lets go of, if the frame ends the hold and names an
    /// account we hold a path for.
    fn take_for_frame(&self, frame: &Value) -> Option<String> {
        if !frame_releases_drive(frame) {
            return None;
        }
        self.take(frame.get("accountId").and_then(Value::as_str)?)
    }
}

/// Whether an `abd-progress` frame ends the shell's hold on the drive: the job
/// is over (`finished: true`, exactly once per job end) or it paused because
/// the drive went away (`status.state == "paused"`, `status.reason ==
/// "drive_unavailable"`; the re-attach resolves again anyway).
pub(crate) fn frame_releases_drive(frame: &Value) -> bool {
    if frame.get("finished").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let Some(status) = frame.get("status") else { return false };
    status.get("state").and_then(Value::as_str) == Some("paused")
        && status.get("reason").and_then(Value::as_str) == Some("drive_unavailable")
}

// ── Ports: everything the flows touch outside their own arguments ────────────

pub(crate) trait Ports {
    /// Resolve the backup slot and start its scoped access. `Some` means the
    /// access is started and the caller owns one release.
    fn resolve(&self) -> Option<String>;
    fn exists(&self, path: &str) -> bool;
    fn release(&self, path: &str);
    fn call(&self, method: &str, params: Value, budget: Duration) -> Result<Value, String>;
}

struct AppPorts<'a>(&'a tauri::AppHandle);

impl Ports for AppPorts<'_> {
    fn resolve(&self) -> Option<String> {
        // `needs_release` is true exactly when a bookmark resolved (no caller
        // path is passed), so `Some` always owes one release.
        crate::backup::resolve_backup_path(self.0, None).0
    }
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }
    fn release(&self, path: &str) {
        external_location::release_external_access(path);
    }
    fn call(&self, method: &str, params: Value, budget: Duration) -> Result<Value, String> {
        crate::daemon_call_blocking(self.0, method, params, budget)
    }
}

// ── Flows ────────────────────────────────────────────────────────────────────

fn account_id(params: &Value) -> Result<String, String> {
    params
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Missing accountId".to_string())
}

/// `Ok(true)` for the backup mode, `Ok(false)` for archive-only.
fn is_backup_mode(params: &Value) -> Result<bool, String> {
    match params.get("mode").and_then(Value::as_str) {
        Some(MODE_BACKUP) => Ok(true),
        Some(MODE_ARCHIVE_ONLY) => Ok(false),
        other => Err(format!("Unknown abd mode: {}", other.unwrap_or("(none)"))),
    }
}

/// The frontend never sends `mirrorRoot`; whatever it may have sent is dropped
/// so only the shell's own resolution ever reaches the daemon.
fn set_mirror_root(params: &mut Value, root: Option<&str>) {
    if let Some(obj) = params.as_object_mut() {
        match root {
            Some(r) => obj.insert("mirrorRoot".into(), json!(r)),
            None => obj.remove("mirrorRoot"),
        };
    }
}

fn summarize_flow(ports: &dyn Ports, mut params: Value) -> Result<Value, String> {
    if !is_backup_mode(&params)? {
        set_mirror_root(&mut params, None);
        return ports.call("abd.summarize", params, SUMMARIZE_BUDGET);
    }
    // A drive that will not resolve forwards `mirrorRoot: null`; the summary
    // then reports nothing as already on the drive, which is the honest answer.
    let root = ports.resolve();
    if let Some(obj) = params.as_object_mut() {
        obj.insert("mirrorRoot".into(), json!(root));
    }
    let result = ports.call("abd.summarize", params, SUMMARIZE_BUDGET);
    // Bounded call: released on every path, success, daemon error or timeout.
    if let Some(r) = root {
        ports.release(&r);
    }
    result
}

fn start_flow(held: &HeldAbdPaths, ports: &dyn Ports, mut params: Value) -> Result<Value, String> {
    let account = account_id(&params)?;
    if !is_backup_mode(&params)? {
        // Archive-only: no drive is resolved, held or sent.
        set_mirror_root(&mut params, None);
        return ports.call("abd.start", params, START_BUDGET);
    }
    // Never start a backup-mode job without the drive (nothing may be deleted
    // on a vault-only copy under this option).
    let Some(root) = ports.resolve() else {
        return Err(ERR_NO_BACKUP_DRIVE.to_string());
    };
    if !ports.exists(&root) {
        ports.release(&root);
        return Err(ERR_NO_BACKUP_DRIVE.to_string());
    }
    // Parked BEFORE the call, not after it: the daemon spawns the job and only
    // then writes its reply, and the reply and the event stream are read by two
    // different app-side tasks, so a job that fails in microseconds can have its
    // terminal frame reach `release_after_frame` before this function returns
    // (same race as `backup::run_account`).
    if let Some(displaced) = held.hold(&account, &root) {
        warn!("abd: releasing a drive scope left over from a previous start of {account}");
        ports.release(&displaced);
    }
    set_mirror_root(&mut params, Some(&root));
    let result = ports.call("abd.start", params, START_BUDGET);
    // An Ok leaves it parked for the job. An Err means nothing started, but the
    // frame may already have released it: claim the entry instead of releasing
    // `root` blindly, so exactly one side releases.
    if result.is_err() {
        if let Some(path) = held.take(&account) {
            ports.release(&path);
        }
    }
    result
}

fn attach_flow(held: &HeldAbdPaths, ports: &dyn Ports, account: &str) -> Result<Value, String> {
    let Some(root) = ports.resolve() else {
        return Ok(json!({"attached": false}));
    };
    if !ports.exists(&root) {
        ports.release(&root);
        return Ok(json!({"attached": false}));
    }
    // Same parking-first order as `start_flow`.
    if let Some(displaced) = held.hold(account, &root) {
        ports.release(&displaced);
    }
    let params = json!({"accountId": account, "mirrorRoot": root});
    let result = ports.call("abd.attach_mirror", params, ATTACH_BUDGET);
    let attached = matches!(&result, Ok(v) if v.get("attached").and_then(Value::as_bool) == Some(true));
    if !attached {
        if let Some(path) = held.take(account) {
            ports.release(&path);
        }
    }
    result
}

/// Release what a frame lets go of. Pure over the map and a release callback.
fn release_after_frame_with(held: &HeldAbdPaths, frame: &Value, mut release: impl FnMut(&str)) {
    if let Some(path) = held.take_for_frame(frame) {
        release(&path);
    }
}

fn release_all_with(held: &HeldAbdPaths, mut release: impl FnMut(&str)) -> usize {
    let paths = held.take_all();
    let n = paths.len();
    for path in paths {
        release(&path);
    }
    n
}

// ── Called from daemon_channel.rs ────────────────────────────────────────────

/// An `abd-progress` frame just came up the daemon channel. `try_state`, not
/// `state`: this runs inside the channel's read loop, and a panic there would
/// take the app's one daemon connection down with it.
pub(crate) fn release_after_frame(app: &tauri::AppHandle, payload: &Value) {
    let Some(held) = app.try_state::<HeldAbdPaths>() else { return };
    release_after_frame_with(&held, payload, |path| {
        info!("abd: job over or paused for the drive, releasing the backup drive's scoped access");
        external_location::release_external_access(path);
    });
}

/// The event stream lagged or the channel reconnected: a terminal frame may be
/// gone. Every hold goes; the app re-attaches through `abd_attach`.
pub(crate) fn release_all(app: &tauri::AppHandle, why: &str) {
    let Some(held) = app.try_state::<HeldAbdPaths>() else { return };
    let n = release_all_with(&held, external_location::release_external_access);
    if n > 0 {
        warn!("abd: {why}, releasing {n} backup drive scope(s)");
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Preview totals for a chosen scope (daemon `abd.summarize`). `params` is the
/// 6.6 request without `mirrorRoot`; the shell adds it in backup mode.
#[tauri::command]
pub async fn abd_summarize(app_handle: tauri::AppHandle, params: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || summarize_flow(&AppPorts(&app_handle), params))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Start one account's job (daemon `abd.start`); answers `{jobId}`. Errors keep
/// the daemon's `E_ABD_*:` prefixes, plus `E_ABD_NO_BACKUP_DRIVE:` from here.
#[tauri::command]
pub async fn abd_start(app_handle: tauri::AppHandle, params: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let Some(held) = app_handle.try_state::<HeldAbdPaths>() else {
            return Err("Backup drive access is not set up".to_string());
        };
        start_flow(&held, &AppPorts(&app_handle), params)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Re-hand the backup drive to `account_id`'s running backup-mode job
/// (daemon `abd.attach_mirror`). Answers `{attached: bool}`.
#[tauri::command]
pub async fn abd_attach(app_handle: tauri::AppHandle, account_id: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let Some(held) = app_handle.try_state::<HeldAbdPaths>() else {
            return Err("Backup drive access is not set up".to_string());
        };
        attach_flow(&held, &AppPorts(&app_handle), &account_id)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    type CallHook = Box<dyn Fn(&str, &Value)>;

    /// A scripted drive + daemon. Records every release and every daemon call.
    struct Fake {
        resolves: RefCell<u32>,
        root: Option<String>,
        drive_present: bool,
        released: RefCell<Vec<String>>,
        calls: RefCell<Vec<(String, Value)>>,
        reply: RefCell<Result<Value, String>>,
        on_call: Option<CallHook>,
    }

    impl Fake {
        fn with_drive(root: &str) -> Self {
            Fake {
                resolves: RefCell::new(0),
                root: Some(root.to_string()),
                drive_present: true,
                released: RefCell::new(vec![]),
                calls: RefCell::new(vec![]),
                reply: RefCell::new(Ok(json!({"jobId": "j1"}))),
                on_call: None,
            }
        }
        fn reply(self, r: Result<Value, String>) -> Self {
            *self.reply.borrow_mut() = r;
            self
        }
    }

    impl Ports for Fake {
        fn resolve(&self) -> Option<String> {
            *self.resolves.borrow_mut() += 1;
            self.root.clone()
        }
        fn exists(&self, _path: &str) -> bool {
            self.drive_present
        }
        fn release(&self, path: &str) {
            self.released.borrow_mut().push(path.to_string());
        }
        fn call(&self, method: &str, params: Value, _budget: Duration) -> Result<Value, String> {
            if let Some(hook) = &self.on_call {
                hook(method, &params);
            }
            self.calls.borrow_mut().push((method.to_string(), params));
            self.reply.borrow().clone()
        }
    }

    fn start_params(mode: &str) -> Value {
        json!({"accountId": "acc1", "previewId": "p1", "mode": mode, "confirmed": true})
    }
    fn finished(account: &str) -> Value {
        json!({"accountId": account, "finished": true, "outcome": "completed",
               "status": {"state": "completed"}})
    }
    fn drive_paused(account: &str) -> Value {
        json!({"accountId": account, "finished": false,
               "status": {"state": "paused", "reason": "drive_unavailable"}})
    }
    fn held_of(pairs: &[(&str, &str)]) -> HeldAbdPaths {
        let h = HeldAbdPaths::default();
        for (a, p) in pairs {
            h.hold(a, p);
        }
        h
    }

    // ── frame predicate + release on frames ──

    #[test]
    fn a_finished_frame_releases_only_its_account() {
        let held = held_of(&[("acc1", "/drive/a"), ("acc2", "/drive/b")]);
        let out = RefCell::new(vec![]);
        release_after_frame_with(&held, &finished("acc1"), |p| out.borrow_mut().push(p.to_string()));
        assert_eq!(*out.borrow(), vec!["/drive/a".to_string()]);
        assert!(held.take("acc1").is_none());
        assert_eq!(held.take("acc2"), Some("/drive/b".to_string()));
    }

    #[test]
    fn a_finished_frame_releases_a_failed_and_a_cancelled_job_too() {
        for outcome in ["failed", "cancelled", "completed"] {
            let held = held_of(&[("acc1", "/drive/a")]);
            let frame = json!({"accountId": "acc1", "finished": true, "outcome": outcome});
            let out = RefCell::new(vec![]);
            release_after_frame_with(&held, &frame, |p| out.borrow_mut().push(p.to_string()));
            assert_eq!(out.borrow().len(), 1, "{outcome}");
        }
    }

    #[test]
    fn a_drive_pause_frame_releases_the_scope() {
        let held = held_of(&[("acc1", "/drive/a")]);
        let out = RefCell::new(vec![]);
        release_after_frame_with(&held, &drive_paused("acc1"), |p| out.borrow_mut().push(p.to_string()));
        assert_eq!(*out.borrow(), vec!["/drive/a".to_string()]);
        assert!(held.take("acc1").is_none());
    }

    /// The predicate is pinned to the daemon's real serde, not to hand-typed
    /// JSON: `progress_frame` puts `"status": job.status` and `"finished":
    /// job.status.is_finished()` next to `"accountId"`.
    #[test]
    fn the_predicate_reads_the_status_the_core_really_serializes() {
        use mailvault_core::abd::{JobStatus, PauseReason};
        let frame = |status: &JobStatus, account: &str| {
            json!({"accountId": account, "status": status, "finished": status.is_finished()})
        };
        let paused = |reason| JobStatus::Paused { reason };
        assert!(frame_releases_drive(&frame(&paused(PauseReason::DriveUnavailable), "a")));
        for reason in [PauseReason::User, PauseReason::SignInNeeded, PauseReason::VaultUnavailable, PauseReason::AccountMissing] {
            assert!(!frame_releases_drive(&frame(&paused(reason), "a")), "{reason:?}");
        }
        for done in [JobStatus::Completed, JobStatus::Cancelled, JobStatus::Failed { error: "x".into() }] {
            assert!(frame_releases_drive(&frame(&done, "a")), "{done:?}");
        }
        for live in [JobStatus::Planning, JobStatus::Waiting { reason: mailvault_core::abd::WaitReason::DailyLimit, until_ms: Some(1) }] {
            assert!(!frame_releases_drive(&frame(&live, "a")), "{live:?}");
        }
        let held = held_of(&[("a", "/drive")]);
        assert_eq!(held.take_for_frame(&frame(&paused(PauseReason::DriveUnavailable), "a")), Some("/drive".to_string()));
    }

    #[test]
    fn a_running_frame_releases_nothing() {
        let held = held_of(&[("acc1", "/drive/a")]);
        let out = RefCell::new(vec![]);
        for frame in [
            json!({"accountId": "acc1", "finished": false, "status": {"state": "running", "phase": "download"}}),
            json!({"accountId": "acc1", "finished": false, "status": {"state": "waiting", "reason": "daily_limit", "untilMs": 5}}),
            json!({"accountId": "acc1", "finished": false, "status": {"state": "paused", "reason": "user"}}),
            json!({"accountId": "acc1", "finished": false, "status": {"state": "paused", "reason": "sign_in_needed"}}),
            json!({"accountId": "acc1", "finished": false, "status": {"state": "paused", "reason": "vault_unavailable"}}),
            json!({"accountId": "acc1", "status": {"state": "planning"}}),
            json!({"accountId": "acc1"}),
            json!({"finished": true}), // names no account: nothing to claim
            json!("not an object"),
        ] {
            release_after_frame_with(&held, &frame, |p| out.borrow_mut().push(p.to_string()));
        }
        assert!(out.borrow().is_empty());
        assert_eq!(held.take("acc1"), Some("/drive/a".to_string()));
    }

    #[test]
    fn a_frame_for_an_account_we_hold_nothing_for_is_a_no_op() {
        let held = held_of(&[("acc1", "/drive/a")]);
        let out = RefCell::new(vec![]);
        release_after_frame_with(&held, &finished("other"), |p| out.borrow_mut().push(p.to_string()));
        assert!(out.borrow().is_empty());
        assert_eq!(held.take("acc1"), Some("/drive/a".to_string()));
    }

    #[test]
    fn a_frame_releases_once() {
        let held = held_of(&[("acc1", "/drive/a")]);
        let out = RefCell::new(vec![]);
        release_after_frame_with(&held, &finished("acc1"), |p| out.borrow_mut().push(p.to_string()));
        release_after_frame_with(&held, &finished("acc1"), |p| out.borrow_mut().push(p.to_string()));
        assert_eq!(out.borrow().len(), 1);
    }

    #[test]
    fn a_second_hold_releases_the_displaced_path() {
        let held = HeldAbdPaths::default();
        assert_eq!(held.hold("acc1", "/drive/old"), None);
        assert_eq!(held.hold("acc1", "/drive/new"), Some("/drive/old".to_string()));
        assert_eq!(held.take("acc1"), Some("/drive/new".to_string()));
    }

    #[test]
    fn take_all_empties_the_map() {
        let held = held_of(&[("a", "/one"), ("b", "/two")]);
        let mut all = held.take_all();
        all.sort();
        assert_eq!(all, vec!["/one".to_string(), "/two".to_string()]);
        assert!(held.take_all().is_empty());
    }

    // ── lag and reconnect ──

    #[test]
    fn a_lag_or_reconnect_releases_every_hold() {
        let held = held_of(&[("a", "/one"), ("b", "/two")]);
        let out = RefCell::new(vec![]);
        let n = release_all_with(&held, |p| out.borrow_mut().push(p.to_string()));
        assert_eq!(n, 2);
        let mut got = out.borrow().clone();
        got.sort();
        assert_eq!(got, vec!["/one".to_string(), "/two".to_string()]);
        assert_eq!(release_all_with(&held, |_| panic!("released twice")), 0);
    }

    // ── start ──

    #[test]
    fn a_backup_start_parks_the_drive_and_injects_mirror_root() {
        let held = HeldAbdPaths::default();
        let fake = Fake::with_drive("/drive");
        // A stale mirrorRoot from the caller is replaced by the shell's own.
        let mut params = start_params(MODE_BACKUP);
        params["mirrorRoot"] = json!("/attacker");
        let out = start_flow(&held, &fake, params).unwrap();
        assert_eq!(out, json!({"jobId": "j1"}));
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "abd.start");
        assert_eq!(calls[0].1["mirrorRoot"], json!("/drive"));
        assert_eq!(calls[0].1["accountId"], json!("acc1"));
        assert_eq!(calls[0].1["confirmed"], json!(true));
        assert!(fake.released.borrow().is_empty(), "a running job keeps its scope");
        assert_eq!(held.take("acc1"), Some("/drive".to_string()));
    }

    #[test]
    fn the_drive_is_parked_before_the_daemon_is_called() {
        // A job that fails at once can send its terminal frame before the reply
        // is read: the entry must already be there for that frame to claim.
        let held = std::rc::Rc::new(HeldAbdPaths::default());
        let seen = std::rc::Rc::new(RefCell::new(None));
        let mut fake = Fake::with_drive("/drive");
        {
            let held = held.clone();
            let seen = seen.clone();
            fake.on_call = Some(Box::new(move |_, _| {
                *seen.borrow_mut() = held.0.lock().unwrap().get("acc1").cloned();
            }));
        }
        start_flow(&held, &fake, start_params(MODE_BACKUP)).unwrap();
        assert_eq!(*seen.borrow(), Some("/drive".to_string()));
    }

    #[test]
    fn a_terminal_frame_during_the_start_leaves_a_failed_start_with_nothing_to_release_twice() {
        let held = std::rc::Rc::new(HeldAbdPaths::default());
        let mut fake = Fake::with_drive("/drive").reply(Err("boom".into()));
        let released_by_frame = std::rc::Rc::new(RefCell::new(0u32));
        {
            let held = held.clone();
            let counter = released_by_frame.clone();
            fake.on_call = Some(Box::new(move |_, _| {
                // the terminal frame lands before the error reply is handled
                release_after_frame_with(&held, &finished("acc1"), |_| *counter.borrow_mut() += 1);
            }));
        }
        assert!(start_flow(&held, &fake, start_params(MODE_BACKUP)).is_err());
        assert_eq!(*released_by_frame.borrow(), 1);
        assert!(fake.released.borrow().is_empty(), "the frame owned the release");
    }

    #[test]
    fn a_failed_start_releases_the_drive() {
        let held = HeldAbdPaths::default();
        let fake = Fake::with_drive("/drive").reply(Err("E_ABD_JOB_EXISTS: already running".into()));
        let err = start_flow(&held, &fake, start_params(MODE_BACKUP)).unwrap_err();
        assert!(err.starts_with("E_ABD_JOB_EXISTS:"), "daemon error text passes through: {err}");
        assert_eq!(*fake.released.borrow(), vec!["/drive".to_string()]);
        assert!(held.take("acc1").is_none());
    }

    #[test]
    fn a_second_start_for_the_same_account_releases_the_displaced_path() {
        let held = held_of(&[("acc1", "/drive/old")]);
        let fake = Fake::with_drive("/drive/new");
        start_flow(&held, &fake, start_params(MODE_BACKUP)).unwrap();
        assert_eq!(*fake.released.borrow(), vec!["/drive/old".to_string()]);
        assert_eq!(held.take("acc1"), Some("/drive/new".to_string()));
    }

    #[test]
    fn a_backup_start_without_a_resolvable_drive_never_calls_the_daemon() {
        let held = HeldAbdPaths::default();
        let mut fake = Fake::with_drive("/drive");
        fake.root = None;
        let err = start_flow(&held, &fake, start_params(MODE_BACKUP)).unwrap_err();
        assert!(err.starts_with("E_ABD_NO_BACKUP_DRIVE:"), "{err}");
        assert!(fake.calls.borrow().is_empty());
        assert!(held.take("acc1").is_none());
    }

    #[test]
    fn a_backup_start_with_a_missing_drive_releases_what_it_resolved() {
        let held = HeldAbdPaths::default();
        let mut fake = Fake::with_drive("/drive");
        fake.drive_present = false;
        let err = start_flow(&held, &fake, start_params(MODE_BACKUP)).unwrap_err();
        assert!(err.starts_with("E_ABD_NO_BACKUP_DRIVE:"), "{err}");
        assert!(fake.calls.borrow().is_empty());
        assert_eq!(*fake.released.borrow(), vec!["/drive".to_string()]);
        assert!(held.take("acc1").is_none());
    }

    #[test]
    fn an_archive_only_start_never_touches_the_slot() {
        let held = HeldAbdPaths::default();
        let fake = Fake::with_drive("/drive");
        let mut params = start_params(MODE_ARCHIVE_ONLY);
        params["mirrorRoot"] = json!("/attacker");
        start_flow(&held, &fake, params).unwrap();
        assert_eq!(*fake.resolves.borrow(), 0, "the slot is never resolved");
        assert!(fake.released.borrow().is_empty());
        assert!(held.take_all().is_empty(), "nothing is held");
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0, "abd.start");
        assert!(calls[0].1.get("mirrorRoot").is_none(), "no mirrorRoot reaches an archive-only job");
    }

    #[test]
    fn an_archive_only_failed_start_releases_nothing() {
        let held = held_of(&[("acc1", "/drive/live-job")]);
        let fake = Fake::with_drive("/drive").reply(Err("E_ABD_PREVIEW_EXPIRED:".into()));
        assert!(start_flow(&held, &fake, start_params(MODE_ARCHIVE_ONLY)).is_err());
        assert!(fake.released.borrow().is_empty());
        assert_eq!(held.take("acc1"), Some("/drive/live-job".to_string()));
    }

    #[test]
    fn a_start_needs_an_account_and_a_known_mode() {
        let held = HeldAbdPaths::default();
        let fake = Fake::with_drive("/drive");
        assert!(start_flow(&held, &fake, json!({"mode": MODE_BACKUP})).is_err());
        assert!(start_flow(&held, &fake, json!({"accountId": "acc1", "mode": "other"})).is_err());
        assert!(start_flow(&held, &fake, json!({"accountId": "acc1"})).is_err());
        assert_eq!(*fake.resolves.borrow(), 0);
        assert!(fake.calls.borrow().is_empty());
    }

    // ── summarize ──

    #[test]
    fn a_backup_summarize_injects_mirror_root_and_releases_without_holding() {
        let fake = Fake::with_drive("/drive").reply(Ok(json!({"previewId": "p1"})));
        let out = summarize_flow(&fake, start_params(MODE_BACKUP)).unwrap();
        assert_eq!(out, json!({"previewId": "p1"}));
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0, "abd.summarize");
        assert_eq!(calls[0].1["mirrorRoot"], json!("/drive"));
        assert_eq!(*fake.released.borrow(), vec!["/drive".to_string()]);
    }

    #[test]
    fn a_backup_summarize_releases_on_a_daemon_error_too() {
        let fake = Fake::with_drive("/drive").reply(Err("E_ABD_PREVIEW_EXPIRED:".into()));
        assert!(summarize_flow(&fake, start_params(MODE_BACKUP)).is_err());
        assert_eq!(*fake.released.borrow(), vec!["/drive".to_string()]);
    }

    #[test]
    fn a_backup_summarize_without_a_drive_forwards_a_null_root_and_releases_nothing() {
        let mut fake = Fake::with_drive("/drive");
        fake.root = None;
        summarize_flow(&fake, start_params(MODE_BACKUP)).unwrap();
        assert_eq!(fake.calls.borrow()[0].1["mirrorRoot"], Value::Null);
        assert!(fake.released.borrow().is_empty());
    }

    #[test]
    fn an_archive_only_summarize_never_touches_the_slot() {
        let fake = Fake::with_drive("/drive");
        summarize_flow(&fake, start_params(MODE_ARCHIVE_ONLY)).unwrap();
        assert_eq!(*fake.resolves.borrow(), 0);
        assert!(fake.released.borrow().is_empty());
        assert!(fake.calls.borrow()[0].1.get("mirrorRoot").is_none());
    }

    // ── attach ──

    #[test]
    fn an_attach_parks_the_drive_and_sends_it_to_the_daemon() {
        let held = HeldAbdPaths::default();
        let fake = Fake::with_drive("/drive").reply(Ok(json!({"attached": true})));
        let out = attach_flow(&held, &fake, "acc1").unwrap();
        assert_eq!(out, json!({"attached": true}));
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0, "abd.attach_mirror");
        assert_eq!(calls[0].1, json!({"accountId": "acc1", "mirrorRoot": "/drive"}));
        assert!(fake.released.borrow().is_empty());
        assert_eq!(held.take("acc1"), Some("/drive".to_string()));
    }

    #[test]
    fn an_attach_with_no_drive_answers_not_attached_without_a_call() {
        let held = HeldAbdPaths::default();
        let mut fake = Fake::with_drive("/drive");
        fake.root = None;
        assert_eq!(attach_flow(&held, &fake, "acc1").unwrap(), json!({"attached": false}));
        assert!(fake.calls.borrow().is_empty());

        let mut gone = Fake::with_drive("/drive");
        gone.drive_present = false;
        assert_eq!(attach_flow(&held, &gone, "acc1").unwrap(), json!({"attached": false}));
        assert!(gone.calls.borrow().is_empty());
        assert_eq!(*gone.released.borrow(), vec!["/drive".to_string()], "the resolved scope is let go");
        assert!(held.take_all().is_empty());
    }

    #[test]
    fn an_attach_the_daemon_refuses_or_fails_releases_the_drive() {
        for reply in [Ok(json!({"attached": false})), Err("boom".to_string())] {
            let held = HeldAbdPaths::default();
            let fake = Fake::with_drive("/drive").reply(reply);
            let _ = attach_flow(&held, &fake, "acc1");
            assert_eq!(*fake.released.borrow(), vec!["/drive".to_string()]);
            assert!(held.take("acc1").is_none());
        }
    }

    #[test]
    fn an_attach_over_a_held_path_releases_the_displaced_one() {
        let held = held_of(&[("acc1", "/drive/old")]);
        let fake = Fake::with_drive("/drive/new").reply(Ok(json!({"attached": true})));
        attach_flow(&held, &fake, "acc1").unwrap();
        assert_eq!(*fake.released.borrow(), vec!["/drive/old".to_string()]);
        assert_eq!(held.take("acc1"), Some("/drive/new".to_string()));
    }

    // ── separation from the backup hold ──

    #[test]
    fn the_hold_map_is_separate_from_the_backup_one() {
        use crate::backup::HeldBackupPaths;
        let backup = HeldBackupPaths::default();
        backup.0.lock().unwrap().insert("acc1".into(), "/drive/backup-run".into());
        let abd = held_of(&[("acc1", "/drive/abd-job")]);

        // an abd terminal frame releases the job's path, never the backup run's
        let out = RefCell::new(vec![]);
        release_after_frame_with(&abd, &finished("acc1"), |p| out.borrow_mut().push(p.to_string()));
        assert_eq!(*out.borrow(), vec!["/drive/abd-job".to_string()]);
        assert_eq!(backup.0.lock().unwrap().get("acc1").map(String::as_str), Some("/drive/backup-run"));

        // and a lag releasing every abd hold leaves the backup run's alone
        abd.hold("acc2", "/drive/abd-2");
        release_all_with(&abd, |_| {});
        assert_eq!(backup.0.lock().unwrap().len(), 1);

        // a backup run's map never sees an abd hold
        abd.hold("acc3", "/drive/abd-3");
        assert!(backup.0.lock().unwrap().get("acc3").is_none());
    }
}
