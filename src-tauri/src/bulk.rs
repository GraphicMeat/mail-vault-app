//! Native bookmark authority belongs to one execution attempt. A timed-out
//! request is released only after a matching drain or definitive admission
//! fence/rejection, never from an instantaneous empty active snapshot.
use crate::abd::{AppPorts, Ports};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::Manager;
const BUDGET: Duration = Duration::from_secs(30);
#[derive(Default)]
pub struct HeldBulkPaths(Mutex<HashMap<String, Hold>>);
struct Hold {
    path: Option<String>,
    pending: bool,
    revision: u64,
    attempt: String,
}
static NEXT_HOLD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
impl HeldBulkPaths {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Hold>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    #[cfg(test)]
    fn contains(&self, id: &str) -> bool {
        self.map().contains_key(id)
    }
}
fn set_root(params: &mut Value, root: Option<&str>) {
    if let Some(object) = params.as_object_mut() {
        object.remove("mirrorRoot");
        if let Some(root) = root {
            object.insert("mirrorRoot".into(), json!(root));
        }
    }
}
fn forward_flow(
    held: &HeldBulkPaths,
    ports: &dyn Ports,
    method: &str,
    mut params: Value,
) -> Result<Value, String> {
    let id = params["operationId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("errors.bulkMissingId")?
        .to_owned();
    set_root(&mut params, None);
    // Bind the status sample to the hold present before the round trip.
    // Another caller may drain A and finish a same-id Resume B during it.
    let observed = held
        .map()
        .get(&id)
        .map(|hold| (hold.attempt.clone(), hold.revision, hold.pending));
    // Learn an already-active execution before acquiring a replacement scope.
    let status = ports.call("bulk.status", json!({}), BUDGET)?;
    let active =
        (status["active"]["id"].as_str() == Some(id.as_str())).then_some(&status["active"]);
    let resume = method == "bulk.resume";
    let operation = if resume {
        active
            .or_else(|| {
                (status["pending"]["id"].as_str() == Some(id.as_str()))
                    .then_some(&status["pending"])
            })
            .ok_or("errors.bulkStale")?
    } else {
        &params
    };
    let backup = operation["type"] == "archive_backup_delete";
    let active_attempt = active
        .and_then(|active| active["attemptId"].as_str())
        .filter(|attempt| !attempt.is_empty());
    if !backup {
        params["attemptId"] = json!(active_attempt
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
        return ports.call(method, params, BUDGET);
    }
    let new_execution = resume && active.is_none();
    let previous = new_execution.then(|| observed.clone()).flatten();
    if let Some((old_attempt, _, pending)) = &previous {
        if *pending {
            return Err("errors.operationRunning".into());
        }
        let old = ports.call(
            "bulk.status",
            json!({"operationId":id,"attemptId":old_attempt,"fenceUnstarted":true}),
            BUDGET,
        )?;
        let receipt = &old["admission"];
        if old["active"]["id"].as_str() == Some(id.as_str())
            || receipt["operationId"].as_str() != Some(id.as_str())
            || receipt["attemptId"].as_str() != Some(old_attempt.as_str())
            || !matches!(
                receipt["state"].as_str(),
                Some("done" | "fenced" | "rejected")
            )
        {
            return Err("errors.operationRunning".into());
        }
    }

    let revision = NEXT_HOLD.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (attempt, existing, old) = {
        let mut map = held.map();
        let current = map.get(&id).map(|hold| (&hold.attempt, hold.revision));
        let expected = observed
            .as_ref()
            .map(|(attempt, revision, _)| (attempt, *revision));
        if current != expected {
            return Err("errors.bulkStale".into());
        }
        if let Some(hold) = map.get_mut(&id) {
            if active_attempt.is_some_and(|attempt| attempt != hold.attempt) {
                return Err("errors.bulkStale".into());
            }
            if hold.pending {
                return Err("errors.operationRunning".into());
            }
            let old = if new_execution {
                hold.path.take()
            } else {
                None
            };
            if new_execution {
                hold.attempt = uuid::Uuid::new_v4().to_string();
            }
            if let Some(attempt) = active_attempt {
                hold.attempt = attempt.to_owned();
            }
            hold.pending = true;
            hold.revision = revision;
            (
                hold.attempt.clone(),
                (!new_execution).then(|| hold.path.clone()),
                old,
            )
        } else {
            let attempt = active_attempt
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            map.insert(
                id.clone(),
                Hold {
                    path: None,
                    pending: true,
                    revision,
                    attempt: attempt.clone(),
                },
            );
            (attempt, None, None)
        }
    };
    let root = match existing {
        Some(root) => root,
        None => {
            let root = ports.resolve().filter(|root| {
                if ports.exists(root) {
                    true
                } else {
                    ports.release(root);
                    false
                }
            });
            let parked = {
                let mut map = held.map();
                if let Some(hold) = map
                    .get_mut(&id)
                    .filter(|hold| hold.revision == revision && hold.attempt == attempt)
                {
                    hold.path = root.clone();
                    true
                } else {
                    false
                }
            };
            if let Some(old) = old {
                ports.release(&old);
            }
            if !parked {
                if let Some(root) = root {
                    ports.release(&root);
                }
                return Err("errors.bulkStale".into());
            }
            root
        }
    };
    params["attemptId"] = json!(attempt);
    set_root(&mut params, root.as_deref());
    let result = ports.call(method, params, BUDGET);
    let owner = result
        .as_ref()
        .ok()
        .and_then(|reply| reply["attemptId"].as_str())
        .filter(|owner| !owner.is_empty());
    let adopted = owner.is_some_and(|owner| owner != attempt);
    {
        let mut map = held.map();
        if let Some(hold) = map
            .get_mut(&id)
            .filter(|hold| hold.revision == revision && hold.attempt == attempt)
        {
            hold.pending = false;
            if let Some(owner) = owner {
                hold.attempt = owner.to_owned();
            }
        }
    }
    if result.is_err()
        || adopted
        || result
            .as_ref()
            .ok()
            .and_then(|reply| reply["status"].as_str())
            .is_some_and(|status| matches!(status, "complete" | "cancelled" | "error"))
    {
        reconcile(held, ports)
    }
    result
}
fn release_frame(held: &HeldBulkPaths, ports: &dyn Ports, frame: &Value) {
    if frame["finished"] != true {
        return;
    }
    let Some((id, attempt)) = frame["operationId"]
        .as_str()
        .zip(frame["attemptId"].as_str())
    else {
        return;
    };
    let path = {
        let mut map = held.map();
        if map.get(id).is_some_and(|hold| hold.attempt == attempt) {
            map.remove(id).and_then(|hold| hold.path)
        } else {
            None
        }
    };
    if let Some(path) = path {
        ports.release(&path)
    }
}
fn reconcile(held: &HeldBulkPaths, ports: &dyn Ports) {
    let reservations: Vec<_> = held
        .map()
        .iter()
        .filter(|(_, hold)| !hold.pending)
        .map(|(id, hold)| (id.clone(), hold.attempt.clone(), hold.revision))
        .collect();
    for (id, attempt, revision) in reservations {
        // If admission was delayed even before registration, this fence is
        // remembered and the late request can never claim this same attempt.
        let Ok(status) = ports.call(
            "bulk.status",
            json!({"operationId":id,"attemptId":attempt,"fenceUnstarted":true}),
            BUDGET,
        ) else {
            continue;
        };
        if status["active"]["id"].as_str() == Some(id.as_str())
            && status["active"]["attemptId"].as_str() == Some(attempt.as_str())
        {
            continue;
        }
        let receipt = &status["admission"];
        if receipt["operationId"].as_str() != Some(id.as_str())
            || receipt["attemptId"].as_str() != Some(attempt.as_str())
            || !matches!(
                receipt["state"].as_str(),
                Some("done" | "fenced" | "rejected")
            )
        {
            continue;
        }
        let path = {
            let mut map = held.map();
            if map.get(&id).is_some_and(|hold| {
                !hold.pending && hold.revision == revision && hold.attempt == attempt
            }) {
                map.remove(&id).and_then(|hold| hold.path)
            } else {
                None
            }
        };
        if let Some(path) = path {
            ports.release(&path)
        }
    }
}
pub(crate) fn forward(
    app: &tauri::AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let held = app.state::<HeldBulkPaths>();
    forward_flow(&held, &AppPorts(app), method, params)
}
pub(crate) fn release_after_frame(app: &tauri::AppHandle, frame: &Value) {
    let held = app.state::<HeldBulkPaths>();
    release_frame(&held, &AppPorts(app), frame)
}
pub(crate) fn reconcile_after_channel_change(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let held = app.state::<HeldBulkPaths>();
        reconcile(&held, &AppPorts(&app));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abd::Ports;
    use std::sync::Mutex;
    struct Fake<'a> {
        held: &'a HeldBulkPaths,
        calls: Mutex<Vec<(String, Value)>>,
        released: Mutex<Vec<String>>,
        fail: bool,
        live: bool,
        terminal: bool,
        definitive: bool,
        pending: bool,
    }
    impl Ports for Fake<'_> {
        fn resolve(&self) -> Option<String> {
            Some("/drive".into())
        }
        fn exists(&self, _: &str) -> bool {
            true
        }
        fn release(&self, p: &str) {
            self.released.lock().unwrap().push(p.into());
        }
        fn call(&self, m: &str, p: Value, _: std::time::Duration) -> Result<Value, String> {
            let attempt = p["attemptId"].clone();
            self.calls.lock().unwrap().push((m.into(), p));
            if m == "bulk.status" {
                let admission = if self.definitive {
                    json!({"operationId":"op","attemptId":attempt,"state":"rejected"})
                } else {
                    Value::Null
                };
                return Ok(
                    json!({"active":if self.live {json!({"id":"op","type":"archive_backup_delete","attemptId":attempt})}else{Value::Null},"pending":if self.pending {json!({"id":"op","type":"archive_backup_delete"})}else{Value::Null},"admission":admission}),
                );
            }
            assert!(
                self.held.contains("op"),
                "scope must be parked before kickoff"
            );
            if self.terminal {
                release_frame(
                    self.held,
                    self,
                    &json!({"operationId":"op","attemptId":attempt,"finished":true}),
                );
            }
            if self.fail {
                Err("timeout".into())
            } else {
                Ok(json!({"id":"op"}))
            }
        }
    }
    fn current_terminal(held: &HeldBulkPaths) -> Value {
        json!({"operationId":"op","attemptId":held.map().get("op").map(|hold|hold.attempt.clone()),"finished":true})
    }
    #[test]
    fn terminal_before_ack_releases_once_and_strips_client_path() {
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: false,
            live: false,
            terminal: true,
            definitive: false,
            pending: false,
        };
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete","mirrorRoot":"/client"}),
        )
        .unwrap();
        assert_eq!(*p.released.lock().unwrap(), vec!["/drive"]);
        assert!(!h.contains("op"));
        assert_eq!(
            p.calls
                .lock()
                .unwrap()
                .iter()
                .find(|(method, _)| method == "bulk.start")
                .unwrap()
                .1["mirrorRoot"],
            "/drive"
        );
    }
    #[test]
    fn ambiguous_timeout_retains_scope_for_live_worker_and_reconnect() {
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: true,
            live: true,
            terminal: false,
            definitive: false,
            pending: false,
        };
        assert!(forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"})
        )
        .is_err());
        reconcile(&h, &p);
        assert!(h.contains("op"));
        assert!(p.released.lock().unwrap().is_empty());
        release_frame(&h, &p, &json!({"operationId":"foreign","finished":true}));
        assert!(h.contains("op"));
        release_frame(&h, &p, &json!({"operationId":"op","finished":false}));
        assert!(h.contains("op"));
        release_frame(&h, &p, &current_terminal(&h));
        assert_eq!(p.released.lock().unwrap().len(), 1);
    }
    #[test]
    fn duplicate_kickoff_does_not_replace_or_release_live_hold() {
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: true,
            live: true,
            terminal: false,
            definitive: false,
            pending: false,
        };
        for _ in 0..2 {
            let _ = forward_flow(
                &h,
                &p,
                "bulk.start",
                json!({"operationId":"op","type":"archive_backup_delete"}),
            );
        }
        assert!(h.contains("op"));
        assert!(p.released.lock().unwrap().is_empty());
    }
    #[test]
    fn definitive_failed_kickoff_reconciles_and_releases_once() {
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: true,
            live: false,
            terminal: false,
            definitive: true,
            pending: false,
        };
        assert!(forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"})
        )
        .is_err());
        assert!(!h.contains("op"));
        assert_eq!(p.released.lock().unwrap().as_slice(), ["/drive"]);
    }
    #[test]
    fn stale_reconnect_status_cannot_release_a_newer_kickoff() {
        struct Racing<'a> {
            held: &'a HeldBulkPaths,
            base: &'a Fake<'a>,
        }
        impl Ports for Racing<'_> {
            fn resolve(&self) -> Option<String> {
                self.base.resolve()
            }
            fn exists(&self, p: &str) -> bool {
                self.base.exists(p)
            }
            fn release(&self, p: &str) {
                self.base.release(p)
            }
            fn call(&self, m: &str, p: Value, b: Duration) -> Result<Value, String> {
                if m == "bulk.status" && p.get("attemptId").is_some() {
                    forward_flow(
                        self.held,
                        self.base,
                        "bulk.start",
                        json!({"operationId":"op","type":"archive_backup_delete"}),
                    )?;
                    Ok(
                        json!({"active":null,"pending":null,"admission":{"operationId":"op","attemptId":p["attemptId"],"state":"done"}}),
                    )
                } else {
                    self.base.call(m, p, b)
                }
            }
        }
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: false,
            live: true,
            terminal: false,
            definitive: false,
            pending: false,
        };
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"}),
        )
        .unwrap();
        reconcile(&h, &Racing { held: &h, base: &p });
        assert!(h.contains("op"));
        assert!(p.released.lock().unwrap().is_empty());
    }
    #[test]
    fn unreadable_status_keeps_native_access() {
        struct Broken<'a>(&'a Fake<'a>);
        impl Ports for Broken<'_> {
            fn resolve(&self) -> Option<String> {
                self.0.resolve()
            }
            fn exists(&self, p: &str) -> bool {
                self.0.exists(p)
            }
            fn release(&self, p: &str) {
                self.0.release(p)
            }
            fn call(&self, _: &str, _: Value, _: Duration) -> Result<Value, String> {
                Ok(Value::Null)
            }
        }
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: false,
            live: true,
            terminal: false,
            definitive: false,
            pending: false,
        };
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"}),
        )
        .unwrap();
        reconcile(&h, &Broken(&p));
        assert!(h.contains("op"));
        assert!(p.released.lock().unwrap().is_empty());
    }
    #[test]
    fn unavailable_drive_still_forwards_archive_then_keep_mode() {
        struct Missing(Mutex<Vec<Value>>);
        impl Ports for Missing {
            fn resolve(&self) -> Option<String> {
                None
            }
            fn exists(&self, _: &str) -> bool {
                false
            }
            fn release(&self, _: &str) {
                panic!("no scope was acquired")
            }
            fn call(&self, m: &str, p: Value, _: Duration) -> Result<Value, String> {
                if m == "bulk.status" {
                    return Ok(json!({"active":null,"pending":null}));
                }
                assert_eq!(m, "bulk.start");
                self.0.lock().unwrap().push(p);
                Ok(json!({"id":"op","status":"starting"}))
            }
        }
        let h = HeldBulkPaths::default();
        let p = Missing(Mutex::new(vec![]));
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete","mirrorRoot":"/untrusted"}),
        )
        .unwrap();
        assert!(p.0.lock().unwrap()[0].get("mirrorRoot").is_none());
        release_frame(&h, &p, &current_terminal(&h));
        assert!(!h.contains("op"));
    }
    #[test]
    fn reviewed_old_attempt_terminal_cannot_release_resumed_hold() {
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: false,
            live: true,
            terminal: false,
            definitive: false,
            pending: false,
        };
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","attemptId":"first","type":"archive_backup_delete"}),
        )
        .unwrap();
        let old = p.calls.lock().unwrap().last().unwrap().1["attemptId"].clone();
        release_frame(
            &h,
            &p,
            &json!({"operationId":"op","attemptId":old,"finished":true}),
        );
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","attemptId":"second","type":"archive_backup_delete"}),
        )
        .unwrap();
        release_frame(
            &h,
            &p,
            &json!({"operationId":"op","attemptId":old,"finished":true}),
        );
        release_frame(
            &h,
            &p,
            &json!({"operationId":"op","attemptId":old,"finished":true}),
        );
        assert!(
            h.contains("op"),
            "earlier drain must not release a resumed execution"
        );
    }
    #[test]
    fn reviewed_timeout_before_visible_owner_keeps_authority() {
        let h = HeldBulkPaths::default();
        let p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: true,
            live: false,
            terminal: false,
            definitive: false,
            pending: false,
        };
        assert!(forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"})
        )
        .is_err());
        assert!(
            h.contains("op"),
            "empty active status does not prove a timed-out admission cannot start later"
        );
        assert!(p.released.lock().unwrap().is_empty());
    }
    #[test]
    fn stale_initial_status_cannot_rebind_a_newer_resumed_hold() {
        struct DelayedStatus<'a> {
            held: &'a HeldBulkPaths,
            delayed: std::sync::atomic::AtomicBool,
            current: Mutex<String>,
            released: Mutex<Vec<String>>,
        }
        impl Ports for DelayedStatus<'_> {
            fn resolve(&self) -> Option<String> {
                Some("/drive".into())
            }
            fn exists(&self, _: &str) -> bool {
                true
            }
            fn release(&self, path: &str) {
                self.released.lock().unwrap().push(path.into());
            }
            fn call(&self, method: &str, params: Value, _: Duration) -> Result<Value, String> {
                if method == "bulk.status"
                    && params.get("attemptId").is_none()
                    && !self.delayed.swap(true, std::sync::atomic::Ordering::SeqCst)
                {
                    // X's response was sampled while A was live. Before it
                    // arrives, A drains and Y successfully resumes as B.
                    *self.current.lock().unwrap() = String::new();
                    forward_flow(self.held, self, "bulk.resume", json!({"operationId":"op"}))?;
                    return Ok(
                        json!({"active":{"id":"op","type":"archive_backup_delete","attemptId":"A"},"pending":null}),
                    );
                }
                if method == "bulk.status" {
                    let current = self.current.lock().unwrap().clone();
                    let asked = params["attemptId"].as_str().unwrap_or("");
                    return Ok(json!({
                        "active":if current.is_empty() {Value::Null} else {json!({"id":"op","type":"archive_backup_delete","attemptId":current})},
                        "pending":{"id":"op","type":"archive_backup_delete"},
                        "admission":if asked.is_empty() {Value::Null} else {json!({"operationId":"op","attemptId":asked,"state":if asked=="A" {"done"} else {"running"}})}
                    }));
                }
                if method == "bulk.resume" {
                    let attempt = params["attemptId"].as_str().unwrap().to_owned();
                    *self.current.lock().unwrap() = attempt.clone();
                    return Ok(json!({"id":"op","attemptId":attempt,"status":"starting"}));
                }
                Err("errors.bulkStale".into())
            }
        }
        let held = HeldBulkPaths::default();
        held.map().insert(
            "op".into(),
            Hold {
                path: Some("/drive".into()),
                pending: false,
                revision: 1,
                attempt: "A".into(),
            },
        );
        let ports = DelayedStatus {
            held: &held,
            delayed: std::sync::atomic::AtomicBool::new(false),
            current: Mutex::new("A".into()),
            released: Mutex::new(vec![]),
        };
        assert!(forward_flow(
            &held,
            &ports,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"})
        )
        .is_err());
        let current = ports.current.lock().unwrap().clone();
        assert_ne!(current, "A");
        assert_eq!(
            held.map().get("op").map(|hold| hold.attempt.clone()),
            Some(current),
            "stale initial status must not rewrite B's hold to A"
        );
        assert_eq!(
            ports.released.lock().unwrap().len(),
            1,
            "only drained A may release; live B remains held"
        );
    }
    #[test]
    fn delayed_first_terminal_cannot_release_scope_acquired_by_explicit_resume() {
        let h = HeldBulkPaths::default();
        let mut p = Fake {
            held: &h,
            calls: Mutex::new(vec![]),
            released: Mutex::new(vec![]),
            fail: false,
            live: true,
            terminal: false,
            definitive: false,
            pending: false,
        };
        forward_flow(
            &h,
            &p,
            "bulk.start",
            json!({"operationId":"op","type":"archive_backup_delete"}),
        )
        .unwrap();
        let old = current_terminal(&h);
        p.live = false;
        p.pending = true;
        p.definitive = true;
        forward_flow(&h, &p, "bulk.resume", json!({"operationId":"op"})).unwrap();
        let current = current_terminal(&h);
        assert_ne!(old["attemptId"], current["attemptId"]);
        release_frame(&h, &p, &old);
        release_frame(&h, &p, &old);
        assert!(h.contains("op"));
        assert_eq!(p.released.lock().unwrap().len(), 1);
        release_frame(&h, &p, &current);
        assert!(!h.contains("op"));
        assert_eq!(p.released.lock().unwrap().len(), 2);
    }
}
