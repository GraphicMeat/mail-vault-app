//! Characterization of the per-job scoped-access holds (export, abd,
//! cleanup, backup run) before they move onto one registry.

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

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

    #[derive(Default)]
    struct Old {
        export: crate::export_folder::HeldExportPaths,
        abd: crate::abd::HeldAbdPaths,
        cleanup: crate::cleanup::HeldCleanupPath,
        backup: crate::backup::HeldBackupPaths,
    }

    impl Reg for Old {
        fn hold(&self, k: K, id: &str, path: &str) -> Result<Option<String>, ()> {
            match k {
                K::Export => Ok(self.export.hold(id, path)),
                K::Abd => Ok(self.abd.hold(id, path)),
                K::Cleanup => self.cleanup.hold(path).then_some(None).ok_or(()),
                K::BackupRun => Ok(self.backup.0.lock().unwrap().insert(id.into(), path.into())),
            }
        }
        fn take(&self, k: K, id: &str) -> Option<String> {
            match k {
                K::Export => self.export.take(id),
                K::Abd => self.abd.take(id),
                K::Cleanup => self.cleanup.take(),
                K::BackupRun => self.backup.0.lock().unwrap().remove(id),
            }
        }
        // Mirrors daemon_channel.rs's pump, one arm per event it routes.
        fn event(&self, name: &str, payload: &Value) -> Vec<String> {
            let mut out = vec![];
            if name == "backup-progress" {
                crate::backup::release_legacy_frame(&self.backup, payload, |p| out.push(p.to_string()));
            }
            if name == crate::export_folder::EXPORT_PROGRESS {
                out.extend(self.export.take_finished(payload));
            }
            if name == crate::abd::ABD_PROGRESS {
                crate::abd::release_after_frame_with(&self.abd, payload, |p| out.push(p.to_string()));
            }
            if name == crate::cleanup::CLEANUP_RUN {
                crate::cleanup::release_after_event_with(&self.cleanup, payload, |p| out.push(p.to_string()));
            }
            out
        }
        // Mirrors daemon_channel.rs's reconnect and lag blocks.
        fn reset(&self) -> Vec<String> {
            let mut out = self.export.take_all();
            crate::abd::release_all_with(&self.abd, |p| out.push(p.to_string()));
            out.extend(self.cleanup.take());
            out
        }
    }

    fn reg() -> impl Reg {
        Old::default()
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
}
