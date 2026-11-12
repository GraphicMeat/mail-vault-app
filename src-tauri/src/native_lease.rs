//! Scoped access to a folder outside the sandbox, held by the shell for as
//! long as a daemon job uses it (architecture.md, "bookmark forwarders"). A
//! sandboxed daemon cannot resolve a security-scoped bookmark, so the shell
//! resolves it, parks the path here under the job's id BEFORE it calls the
//! daemon (a job that fails at once can send its last frame before the reply
//! is read), and lets go when one of these says the job no longer uses it:
//!
//! - the start call fails or says nothing started (the caller claims it back),
//! - the job's terminal frame comes up the daemon channel ([`KINDS`]),
//! - the channel reconnects or the event stream lags, for every kind whose
//!   job the app fails or re-attaches then (`release_on_reset`).
//!
//! The map entry is the claim: whoever removes it owns the one release, so a
//! terminal frame and a failed start can never both release one scope.
//! Nothing here expires on a clock: a job keeps its folder until one of the
//! above, and the call budgets stay with each forwarder.
//!
//! Bulk operations (`bulk.rs`) and the native backup scheduler
//! (`backup_native_access.rs`) hold the same drive under a different
//! protocol: their release waits for a daemon admission receipt for an exact
//! attempt, and a reconnect asks the daemon instead of letting go. They keep
//! their own code.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager;
use tracing::{info, warn};

use crate::external_location;

/// The jobs that hold a folder through this registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Job {
    /// An attachment or contacts export into a picked folder.
    Export,
    /// An archive-backup-delete job's hold on the backup drive.
    Abd,
    /// Run All Now of the auto-cleanup rules, one at a time.
    Cleanup,
    /// One account's backup run (`backup_run_account`).
    BackupRun,
}

/// What differs between the jobs, as data.
pub(crate) struct Kind {
    pub(crate) job: Job,
    /// Log prefix.
    pub(crate) label: &'static str,
    /// The daemon event carrying the job's progress.
    pub(crate) event: &'static str,
    /// The id the hold is parked under, read from a frame.
    pub(crate) id: fn(&Value) -> Option<&str>,
    /// Whether a frame says the job no longer uses the folder.
    pub(crate) ends: fn(&Value) -> bool,
    /// Whether a channel reconnect or an event-stream lag lets go (a terminal
    /// frame may be lost then). A backup run does not: its daemon run goes on
    /// and nothing re-attaches it.
    pub(crate) release_on_reset: bool,
}

fn job_id(frame: &Value) -> Option<&str> {
    frame.get("jobId").and_then(Value::as_str)
}
fn account_id(frame: &Value) -> Option<&str> {
    frame.get("accountId").and_then(Value::as_str)
}
fn legacy_account_id(frame: &Value) -> Option<&str> {
    frame.get("account_id").and_then(Value::as_str)
}
/// Cleanup runs one at a time: one slot, no id.
fn single(_: &Value) -> Option<&str> {
    Some("")
}

pub(crate) static KINDS: [Kind; 4] = [
    Kind {
        job: Job::Export,
        label: "export",
        event: crate::export_folder::EXPORT_PROGRESS,
        id: job_id,
        ends: crate::export_folder::job_over,
        release_on_reset: true,
    },
    Kind {
        job: Job::Abd,
        label: "abd",
        event: crate::abd::ABD_PROGRESS,
        id: account_id,
        ends: crate::abd::frame_releases_drive,
        release_on_reset: true,
    },
    Kind {
        job: Job::Cleanup,
        label: "cleanup",
        event: crate::cleanup::CLEANUP_RUN,
        id: single,
        ends: crate::cleanup::run_over,
        release_on_reset: true,
    },
    Kind {
        job: Job::BackupRun,
        label: "backup",
        event: crate::backup::BACKUP_PROGRESS,
        id: legacy_account_id,
        ends: crate::backup::legacy_run_over,
        release_on_reset: false,
    },
];

fn kind(job: Job) -> &'static Kind {
    KINDS.iter().find(|k| k.job == job).expect("every job has a kind")
}

/// Whether a daemon event can end a hold, so the pump clones its payload only then.
pub(crate) fn is_lease_event(name: &str) -> bool {
    KINDS.iter().any(|k| k.event == name)
}

/// (job, id) -> the resolved path whose scoped access that job still uses.
#[derive(Default)]
pub struct Leases(Mutex<HashMap<(Job, String), String>>);

impl Leases {
    fn map(&self) -> MutexGuard<'_, HashMap<(Job, String), String>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Park `path`; answers the path a second start under the same id
    /// displaced, which the caller must release.
    pub(crate) fn hold(&self, job: Job, id: &str, path: &str) -> Option<String> {
        self.map().insert((job, id.to_string()), path.to_string())
    }
    /// Park `path` unless one is already held; `false` leaves it to the caller.
    pub(crate) fn hold_if_free(&self, job: Job, id: &str, path: &str) -> bool {
        let mut map = self.map();
        let key = (job, id.to_string());
        if map.contains_key(&key) {
            return false;
        }
        map.insert(key, path.to_string());
        true
    }
    pub(crate) fn is_held(&self, job: Job, id: &str) -> bool {
        self.map().contains_key(&(job, id.to_string()))
    }
    pub(crate) fn take(&self, job: Job, id: &str) -> Option<String> {
        self.map().remove(&(job, id.to_string()))
    }
    #[cfg(test)]
    pub(crate) fn peek(&self, job: Job, id: &str) -> Option<String> {
        self.map().get(&(job, id.to_string())).cloned()
    }
    /// The holds a daemon event ends.
    pub(crate) fn after_event(&self, name: &str, payload: &Value) -> Vec<(&'static Kind, String)> {
        KINDS
            .iter()
            .filter(|k| k.event == name && (k.ends)(payload))
            .filter_map(|k| Some((k, self.take(k.job, (k.id)(payload)?)?)))
            .collect()
    }
    /// The holds a channel reconnect or an event-stream lag ends.
    pub(crate) fn on_reset(&self) -> Vec<(&'static Kind, String)> {
        let mut map = self.map();
        let keys: Vec<_> = map.keys().filter(|(job, _)| kind(*job).release_on_reset).cloned().collect();
        keys.into_iter().filter_map(|key| Some((kind(key.0), map.remove(&key)?))).collect()
    }
    /// Park `path` for (`job`, `id`), then run the start `call`. When
    /// `started` says no job took it, claim the entry back and release it; a
    /// terminal frame that beat the reply may already have, and then nothing
    /// is released twice.
    pub(crate) fn call_holding<R>(
        &self,
        job: Job,
        id: &str,
        path: &str,
        release: &dyn Fn(&str),
        call: impl FnOnce() -> R,
        started: impl FnOnce(&R) -> bool,
    ) -> R {
        if let Some(displaced) = self.hold(job, id, path) {
            warn!("{}: releasing a scope left over from a previous start of {id}", kind(job).label);
            release(&displaced);
        }
        let reply = call();
        if !started(&reply) {
            if let Some(path) = self.take(job, id) {
                release(&path);
            }
        }
        reply
    }
}

// ── Called from daemon_channel.rs ────────────────────────────────────────────

/// A daemon event came up the channel, after it went to the frontend.
/// `try_state`: this runs inside the channel's read loop, and a panic there
/// would take the app's one daemon connection down with it.
pub(crate) fn after_event(app: &tauri::AppHandle, name: &str, payload: &Value) {
    let Some(leases) = app.try_state::<Leases>() else { return };
    for (kind, path) in leases.after_event(name, payload) {
        info!("{}: job over, releasing its folder's scoped access", kind.label);
        external_location::release_external_access(&path);
    }
}

/// The channel reconnected or the event stream lagged: a terminal frame may
/// be gone.
pub(crate) fn release_on_reset(app: &tauri::AppHandle, why: &str) {
    let Some(leases) = app.try_state::<Leases>() else { return };
    for (kind, path) in leases.on_reset() {
        warn!("{}: {why}, releasing a held folder's scoped access", kind.label);
        external_location::release_external_access(&path);
    }
}

// ── Ports: the backup drive and the daemon, for flows tested without Tauri ───

pub(crate) trait Ports {
    /// Resolve the backup slot and start its scoped access. `Some` means the
    /// access is started and the caller owns one release.
    fn resolve(&self) -> Option<String>;
    fn external_status(&self) -> Option<String> {
        None
    }
    fn exists(&self, path: &str) -> bool;
    fn release(&self, path: &str);
    fn call(&self, method: &str, params: Value, budget: Duration) -> Result<Value, String>;
}

pub(crate) struct AppPorts<'a>(pub(crate) &'a tauri::AppHandle);

impl Ports for AppPorts<'_> {
    fn external_status(&self) -> Option<String> {
        crate::backup::external_location_status()
    }
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

#[cfg(test)]
mod tests {
    use super::{Job, Leases};
    use serde_json::{json, Value};
    use std::cell::RefCell;

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum K {
        Export,
        Abd,
        Cleanup,
        BackupRun,
    }
    const ALL: [K; 4] = [K::Export, K::Abd, K::Cleanup, K::BackupRun];

    /// What the daemon channel does with a feature's hold, through one seam.
    /// Only `Reg`'s implementation changes when the holds move; the
    /// assertions below stay as they are.
    trait Reg {
        /// Park `path` for `id`. `Err(())` when the kind refuses a second
        /// hold, `Ok(displaced)` otherwise.
        fn hold(&self, k: K, id: &str, path: &str) -> Result<Option<String>, ()>;
        fn take(&self, k: K, id: &str) -> Option<String>;
        /// A daemon event came up the channel: the paths it released.
        fn event(&self, name: &str, payload: &Value) -> Vec<String>;
        /// The channel reconnected or the event stream lagged.
        fn reset(&self) -> Vec<String>;
    }

    impl Reg for super::Leases {
        fn hold(&self, k: K, id: &str, path: &str) -> Result<Option<String>, ()> {
            if k == K::Cleanup {
                return self.hold_if_free(job(k), id, path).then_some(None).ok_or(());
            }
            Ok(super::Leases::hold(self, job(k), id, path))
        }
        fn take(&self, k: K, id: &str) -> Option<String> {
            super::Leases::take(self, job(k), id)
        }
        fn event(&self, name: &str, payload: &Value) -> Vec<String> {
            self.after_event(name, payload).into_iter().map(|(_, p)| p).collect()
        }
        fn reset(&self) -> Vec<String> {
            self.on_reset().into_iter().map(|(_, p)| p).collect()
        }
    }
    fn job(k: K) -> Job {
        match k {
            K::Export => Job::Export,
            K::Abd => Job::Abd,
            K::Cleanup => Job::Cleanup,
            K::BackupRun => Job::BackupRun,
        }
    }

    fn reg() -> impl Reg {
        Leases::default()
    }

    /// Cleanup has one slot; every other kind is keyed by its job's id.
    fn id(k: K) -> &'static str {
        if k == K::Cleanup {
            ""
        } else {
            "a"
        }
    }
    fn event(k: K) -> &'static str {
        match k {
            K::Export => "attachment-export-progress",
            K::Abd => "abd-progress",
            K::Cleanup => "cleanup-run",
            K::BackupRun => "backup-progress",
        }
    }
    fn terminal(k: K, id: &str) -> Value {
        match k {
            K::Export => json!({"jobId": id, "finished": true, "error": "x"}),
            K::Abd => json!({"accountId": id, "finished": true, "outcome": "failed"}),
            K::Cleanup => json!({"state": "done"}),
            K::BackupRun => json!({"account_id": id, "active": false}),
        }
    }
    fn not_terminal(k: K, id: &str) -> Vec<Value> {
        match k {
            K::Export => vec![json!({"jobId": id, "done": 1, "total": 2}), json!({"jobId": id, "finished": false})],
            K::Abd => vec![
                json!({"accountId": id, "finished": false, "status": {"state": "running"}}),
                json!({"accountId": id, "status": {"state": "paused", "reason": "user"}}),
            ],
            K::Cleanup => vec![json!({"state": "running"}), json!({})],
            K::BackupRun => vec![
                json!({"account_id": id, "active": true}),
                json!({"account_id": id}),
                // A native scheduler frame shares the event name: never the legacy hold.
                json!({"account_id": id, "active": false, "runId": "r", "executionId": "e"}),
                json!({"account_id": id, "active": false, "executionId": "e"}),
                json!({"accountId": id, "active": false}),
            ],
        }
    }

    #[test]
    fn a_terminal_frame_releases_its_hold_once() {
        for k in ALL {
            let r = reg();
            r.hold(k, id(k), "/p").unwrap();
            assert_eq!(r.event(event(k), &terminal(k, id(k))), vec!["/p".to_string()], "{k:?}");
            assert!(r.event(event(k), &terminal(k, id(k))).is_empty(), "{k:?} released twice");
            assert_eq!(r.take(k, id(k)), None, "{k:?}");
        }
    }

    #[test]
    fn a_frame_that_is_not_terminal_releases_nothing() {
        for k in ALL {
            let r = reg();
            r.hold(k, id(k), "/p").unwrap();
            for frame in not_terminal(k, id(k)) {
                assert!(r.event(event(k), &frame).is_empty(), "{k:?} {frame}");
            }
            assert_eq!(r.take(k, id(k)).as_deref(), Some("/p"), "{k:?}");
        }
    }

    #[test]
    fn a_terminal_frame_of_another_job_id_releases_nothing() {
        for k in ALL.into_iter().filter(|k| *k != K::Cleanup) {
            let r = reg();
            r.hold(k, "a", "/p").unwrap();
            assert!(r.event(event(k), &terminal(k, "other")).is_empty(), "{k:?}");
            assert!(r.event(event(k), &json!({"finished": true, "active": false})).is_empty(), "{k:?} names no id");
            assert_eq!(r.take(k, "a").as_deref(), Some("/p"), "{k:?}");
        }
    }

    #[test]
    fn a_frame_of_one_kind_never_releases_another_kinds_hold() {
        for k in ALL {
            let r = reg();
            for other in ALL {
                r.hold(other, id(other), &format!("/{other:?}")).unwrap();
            }
            assert_eq!(r.event(event(k), &terminal(k, id(k))), vec![format!("/{k:?}")], "{k:?}");
            for other in ALL.into_iter().filter(|o| *o != k) {
                assert_eq!(r.take(other, id(other)), Some(format!("/{other:?}")), "{k:?} released {other:?}");
            }
        }
    }

    #[test]
    fn an_abd_pause_for_the_drive_releases_but_other_pauses_do_not() {
        let r = reg();
        r.hold(K::Abd, "a", "/p").unwrap();
        let paused = |reason: &str| json!({"accountId": "a", "finished": false, "status": {"state": "paused", "reason": reason}});
        for reason in ["user", "sign_in_needed", "vault_unavailable"] {
            assert!(r.event("abd-progress", &paused(reason)).is_empty(), "{reason}");
        }
        assert_eq!(r.event("abd-progress", &paused("drive_unavailable")), vec!["/p".to_string()]);
    }

    /// Lag and reconnect release export, abd and cleanup holds. A legacy
    /// backup run keeps its mirror: the daemon run goes on and nothing
    /// re-attaches it.
    #[test]
    fn a_reconnect_or_lag_releases_every_kind_but_the_backup_run() {
        let r = reg();
        for k in ALL {
            r.hold(k, id(k), &format!("/{k:?}")).unwrap();
        }
        r.hold(K::Export, "b", "/Export-b").unwrap();
        r.hold(K::Abd, "b", "/Abd-b").unwrap();
        let mut released = r.reset();
        released.sort();
        assert_eq!(released, ["/Abd", "/Abd-b", "/Cleanup", "/Export", "/Export-b"]);
        assert!(r.reset().is_empty(), "released once");
        assert_eq!(r.take(K::BackupRun, "a").as_deref(), Some("/BackupRun"));
    }

    #[test]
    fn a_second_hold_displaces_the_first_except_for_cleanup_which_refuses() {
        for k in ALL {
            let r = reg();
            assert_eq!(r.hold(k, id(k), "/old"), Ok(None), "{k:?}");
            let second = r.hold(k, id(k), "/new");
            if k == K::Cleanup {
                assert_eq!(second, Err(()), "a running cleanup keeps its drive");
                assert_eq!(r.take(k, id(k)).as_deref(), Some("/old"));
            } else {
                assert_eq!(second, Ok(Some("/old".to_string())), "{k:?}");
                assert_eq!(r.take(k, id(k)).as_deref(), Some("/new"), "{k:?}");
            }
        }
    }

    #[test]
    fn an_unrelated_event_releases_nothing() {
        let r = reg();
        for k in ALL {
            r.hold(k, id(k), "/p").unwrap();
        }
        for name in ["settings-changed", "daemon-events-lagged", "backup-access-release", "bulk-progress"] {
            for k in ALL {
                assert!(r.event(name, &terminal(k, id(k))).is_empty(), "{name}");
            }
        }
    }

    // ── the start discipline every kind shares ──

    #[test]
    fn the_path_is_parked_before_the_start_call() {
        let leases = Leases::default();
        let released = RefCell::new(vec![]);
        let seen = leases.call_holding(Job::Export, "j", "/p", &|p| released.borrow_mut().push(p.to_string()), || leases.is_held(Job::Export, "j"), |_| true);
        assert!(seen, "a terminal frame that beats the reply finds the hold");
        assert!(released.borrow().is_empty());
        assert_eq!(leases.take(Job::Export, "j").as_deref(), Some("/p"));
    }

    #[test]
    fn a_start_that_fails_or_times_out_releases_at_once() {
        let leases = Leases::default();
        let released = RefCell::new(vec![]);
        let reply: Result<(), String> = leases.call_holding(Job::BackupRun, "a", "/p", &|p| released.borrow_mut().push(p.to_string()), || Err("daemon did not answer in 30s".into()), Result::is_ok);
        assert!(reply.is_err());
        assert_eq!(*released.borrow(), ["/p"]);
        assert!(!leases.is_held(Job::BackupRun, "a"));
    }

    #[test]
    fn a_terminal_frame_during_a_failed_start_leaves_nothing_to_release_twice() {
        let leases = Leases::default();
        let released = RefCell::new(vec![]);
        let by_frame = RefCell::new(vec![]);
        let _ = leases.call_holding(
            Job::Export,
            "j",
            "/p",
            &|p| released.borrow_mut().push(p.to_string()),
            || {
                by_frame.borrow_mut().extend(leases.after_event("attachment-export-progress", &json!({"jobId": "j", "finished": true})));
                Err::<(), _>("boom")
            },
            Result::is_ok,
        );
        assert_eq!(by_frame.borrow().len(), 1, "the frame owned the release");
        assert!(released.borrow().is_empty());
    }

    #[test]
    fn a_second_start_releases_the_displaced_path() {
        let leases = Leases::default();
        let released = RefCell::new(vec![]);
        leases.hold(Job::Abd, "a", "/old");
        leases.call_holding(Job::Abd, "a", "/new", &|p| released.borrow_mut().push(p.to_string()), || (), |_| true);
        assert_eq!(*released.borrow(), ["/old"]);
        assert_eq!(leases.take(Job::Abd, "a").as_deref(), Some("/new"));
    }
}
