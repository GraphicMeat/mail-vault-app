//! Native authorization for operation-owned user bulk mirror access.
use crate::abd::{AppPorts, Ports};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::Manager;
const BUDGET: Duration = Duration::from_secs(30);

/// A reservation precedes resolve/call. Duplicate kickoffs never displace a
/// live scope. None means authorization is being resolved or no drive exists.
#[derive(Default)]
pub struct HeldBulkPaths(Mutex<HashMap<String, Hold>>);
struct Hold {
    path: Option<String>,
    pending: bool,
    revision: u64,
}
static NEXT_HOLD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
impl HeldBulkPaths {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Hold>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn contains(&self, id: &str) -> bool {
        self.map().contains_key(id)
    }
    fn take(&self, id: &str) -> Option<String> {
        self.map().remove(id).and_then(|h| h.path)
    }
}
fn set_root(params: &mut Value, root: Option<&str>) {
    if let Some(o) = params.as_object_mut() {
        o.remove("mirrorRoot");
        if let Some(r) = root {
            o.insert("mirrorRoot".into(), json!(r));
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
        .filter(|s| !s.is_empty())
        .ok_or("errors.bulkMissingId")?
        .to_string();
    set_root(&mut params, None);
    let backup = if method == "bulk.resume" {
        let status = ports.call("bulk.status", json!({}), BUDGET)?;
        let op = [&status["active"], &status["pending"]]
            .into_iter()
            .find(|s| s["id"].as_str() == Some(&id))
            .ok_or("errors.bulkStale")?;
        op["type"] == "archive_backup_delete"
    } else {
        params["type"] == "archive_backup_delete"
    };
    if !backup {
        return ports.call(method, params, BUDGET);
    }
    let existing = {
        let mut map = held.map();
        if let Some(hold) = map.get_mut(&id) {
            if hold.pending {
                return Err("errors.operationRunning".into());
            }
            hold.pending = true;
            hold.revision = NEXT_HOLD.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Some(hold.path.clone())
        } else {
            map.insert(
                id.clone(),
                Hold {
                    path: None,
                    pending: true,
                    revision: NEXT_HOLD.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                },
            );
            None
        }
    };
    let root = match existing {
        Some(root) => root,
        None => {
            let resolved = ports.resolve();
            let root = resolved.filter(|r| {
                if ports.exists(r) {
                    true
                } else {
                    ports.release(r);
                    false
                }
            });
            // A terminal frame may have removed the reservation while resolve
            // ran. Do not resurrect it, and release this acquisition once.
            let mut map = held.map();
            if let Some(slot) = map.get_mut(&id) {
                slot.path = root.clone();
            } else {
                if let Some(root) = root {
                    ports.release(&root);
                }
                return Err("errors.bulkStale".into());
            }
            root
        }
    };
    set_root(&mut params, root.as_deref());
    let result = ports.call(method, params, BUDGET);
    // A timeout is ambiguous: the worker may already own the path. Query the
    // actual owner, retaining the hold if status itself cannot be read.
    if let Some(hold) = held.map().get_mut(&id) {
        hold.pending = false;
    }
    if result.is_err()
        || result
            .as_ref()
            .ok()
            .and_then(|v| v["status"].as_str())
            .is_some_and(|s| matches!(s, "complete" | "cancelled" | "error"))
    {
        reconcile(held, ports)
    }
    result
}
fn release_frame(held: &HeldBulkPaths, ports: &dyn Ports, frame: &Value) {
    if frame["finished"] != true {
        return;
    }
    if let Some(id) = frame["operationId"].as_str() {
        if let Some(path) = held.take(id) {
            ports.release(&path)
        }
    }
}
fn reconcile(held: &HeldBulkPaths, ports: &dyn Ports) {
    // Snapshot reservations before status IO. A kickoff begun during that IO
    // changes its revision, so a stale empty status cannot release its scope.
    let reservations: Vec<_> = held
        .map()
        .iter()
        .filter(|(_, hold)| !hold.pending)
        .map(|(id, hold)| (id.clone(), hold.revision))
        .collect();
    if reservations.is_empty() {
        return;
    }
    let Ok(status) = ports.call("bulk.status", json!({}), BUDGET) else {
        return;
    };
    if status.get("pending").is_none() {
        return;
    }
    let active = match status.get("active") {
        Some(Value::Null) => None,
        Some(active) => match active["id"].as_str().filter(|id| !id.is_empty()) {
            Some(id) => Some(id),
            None => return,
        },
        None => return,
    };
    for (id, revision) in reservations {
        if active == Some(id.as_str()) {
            continue;
        }
        let path = {
            let mut map = held.map();
            if map
                .get(&id)
                .is_some_and(|hold| !hold.pending && hold.revision == revision)
            {
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
            self.calls.lock().unwrap().push((m.into(), p));
            if m == "bulk.status" {
                return Ok(if self.live {
                    json!({"active":{"id":"op","type":"archive_backup_delete"},"pending":null})
                } else {
                    json!({"active":null,"pending":null})
                });
            }
            assert!(
                self.held.contains("op"),
                "scope must be parked before kickoff"
            );
            if self.terminal {
                release_frame(
                    self.held,
                    self,
                    &json!({"operationId":"op","finished":true}),
                );
            }
            if self.fail {
                Err("timeout".into())
            } else {
                Ok(json!({"id":"op"}))
            }
        }
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
        assert_eq!(p.calls.lock().unwrap()[0].1["mirrorRoot"], "/drive");
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
        release_frame(&h, &p, &json!({"operationId":"op","finished":true}));
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
                if m == "bulk.status" {
                    forward_flow(
                        self.held,
                        self.base,
                        "bulk.start",
                        json!({"operationId":"op","type":"archive_backup_delete"}),
                    )?;
                    Ok(json!({"active":null,"pending":null}))
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
}
