//! Backup to another drive ("external backup", slot `external-backup`) is
//! Premium in the direct build. This is the one decision the daemon applies
//! where a drive root enters it (RPC `mirrorRoot`, the scheduler's native
//! access), so every writer below that point (backup runs, catch-up, flag
//! sync, renames, purge, bulk, cleanup, transport switch) sees no drive.
//! Archive, Back up & Delete keeps its own start-of-job Premium check.
//!
//! Without Premium nothing is written, moved or deleted on the drive; what is
//! already there stays. With Premium again, the next run catches up.
//!
//! The App Store build sells the drive as its own one-time purchase (the shell
//! refuses the folder without it), so the gate never applies there. The daemon
//! is one binary for both builds, so the App Store shell says which build it is
//! through [`STORE_BUILD_ENV`] when it spawns the daemon.

use serde_json::Value;

/// Set to `1` by the App Store shell on the daemon it spawns.
pub const STORE_BUILD_ENV: &str = "MAILVAULT_STORE_BUILD";

/// Whether this daemon was started by the App Store build.
pub fn store_build() -> bool {
    std::env::var(STORE_BUILD_ENV).is_ok_and(|v| v == "1")
}

/// May the daemon use the backup drive? `settings` is the persisted settings
/// state (`None` when it could not be read: fails closed, the drive is simply
/// skipped and caught up later).
pub fn drive_allowed(settings: Option<&Value>, now_ms: i64, store_build: bool) -> bool {
    store_build || settings.is_some_and(|s| crate::cleanup_rules::has_premium_access(s, now_ms))
}

/// The RPC methods that write, move or delete on the drive. Only these lose
/// the drive root: reading it (`backup_status`, `backup_scan_uids`) writes
/// nothing, so a free user still sees what is on the drive instead of "drive
/// not connected". A new method that takes `mirrorRoot` and writes belongs here.
pub const DRIVE_WRITERS: &[&str] = &[
    "backup_run_account",
    "backup_copy_uids",
    "backup_purge_uids",
    "vault_apply_flags",
    "vault_rename_mailbox",
    "vault_adopt_mailbox_dirs",
    "cleanup.run_now",
    "bulk.start",
    "bulk.resume",
    "accounts.switch_transport",
];

/// The drive-reading methods that keep the root without Premium.
pub const DRIVE_READERS: &[&str] = &["backup_status", "backup_scan_uids"];

pub fn writes_drive(method: &str) -> bool {
    DRIVE_WRITERS.contains(&method)
}

/// A transport switch re-homes the account's mail on the drive too. With the
/// drive paused it would leave the drive in the old layout, so it is refused,
/// the way the shell refuses it while a configured drive is unreachable.
pub const SWITCH_REFUSED: &str = "errors.transportSwitchDrivePaused";

/// The refusal for a writer that must not run at all without the drive.
pub fn refused_without_drive(method: &str) -> Option<&'static str> {
    (method == "accounts.switch_transport").then_some(SWITCH_REFUSED)
}

/// Whether RPC params carry a drive root the gate has to decide on.
pub fn carries_drive(params: &Value) -> bool {
    params.get("mirrorRoot").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

/// Takes the drive out of RPC params. A configured drive then reads as
/// unavailable (never "not configured"), the state the existing code already
/// answers safely: copies are skipped and caught up later, a purge waits in
/// its queue instead of being dropped.
pub fn withhold_drive(params: &mut Value) {
    let Some(obj) = params.as_object_mut() else { return };
    obj.remove("mirrorRoot");
    if let Some(status) = obj.get("externalStatus").and_then(Value::as_str) {
        if status != "not_configured" {
            obj.insert("externalStatus".into(), Value::String("unavailable".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_792_929_600_000; // 2026-10-25T12:00:00Z

    #[test]
    fn premium_uses_the_drive_free_and_lapsed_do_not() {
        let premium = json!({"billingProfile": {"hasSubscription": true, "status": "active"}});
        let lapsed = json!({"billingProfile": {"hasSubscription": true, "status": "canceled", "currentPeriodEnd": "2026-10-01T00:00:00Z"}});
        let canceled_still_paid = json!({"billingProfile": {"hasSubscription": true, "status": "canceled", "currentPeriodEnd": "2026-11-01T00:00:00Z"}});
        assert!(drive_allowed(Some(&premium), NOW, false));
        assert!(drive_allowed(Some(&canceled_still_paid), NOW, false));
        assert!(!drive_allowed(Some(&lapsed), NOW, false));
        assert!(!drive_allowed(Some(&json!({})), NOW, false));
        assert!(!drive_allowed(None, NOW, false), "unreadable settings fail closed");
    }

    #[test]
    fn only_writers_lose_the_drive_and_a_switch_is_refused() {
        for m in ["backup_copy_uids", "vault_apply_flags", "bulk.start", "cleanup.run_now"] {
            assert!(writes_drive(m), "{m}");
        }
        for m in DRIVE_READERS.iter().chain(["abd.start", "abd.attach_mirror"].iter()) {
            assert!(!writes_drive(m), "{m}");
        }
        assert_eq!(refused_without_drive("accounts.switch_transport"), Some(SWITCH_REFUSED));
        assert_eq!(refused_without_drive("backup_copy_uids"), None);
    }

    #[test]
    fn the_answer_can_change_when_a_paid_period_or_grant_ends() {
        use crate::cleanup_rules::premium_changes_at;
        let canceled = json!({"billingProfile": {"hasSubscription": true, "status": "canceled", "currentPeriodEnd": "2026-10-25T13:00:00Z"}});
        assert_eq!(premium_changes_at(&canceled, NOW), Some(NOW + 3_600_000));
        assert_eq!(premium_changes_at(&canceled, NOW + 3_600_000), None);
        let grant = json!({"shareGrant": {"expiresAt": NOW + 5}, "billingProfile": {"currentPeriodEnd": "2026-10-25T13:00:00Z"}});
        assert_eq!(premium_changes_at(&grant, NOW), Some(NOW + 5));
        assert_eq!(premium_changes_at(&json!({}), NOW), None);
    }

    #[test]
    fn the_app_store_build_is_never_gated() {
        assert!(drive_allowed(None, NOW, true));
        assert!(drive_allowed(Some(&json!({})), NOW, true));
    }

    #[test]
    fn withholding_removes_the_root_and_reads_as_unavailable() {
        let mut p = json!({"mirrorRoot": "/Volumes/B", "externalStatus": "ready", "uids": [1]});
        assert!(carries_drive(&p));
        withhold_drive(&mut p);
        assert_eq!(p, json!({"externalStatus": "unavailable", "uids": [1]}));
        assert!(!carries_drive(&p));

        let mut unset = json!({"mirrorRoot": "/x", "externalStatus": "not_configured"});
        withhold_drive(&mut unset);
        assert_eq!(unset, json!({"externalStatus": "not_configured"}));

        assert!(!carries_drive(&json!({"mirrorRoot": null})));
        assert!(!carries_drive(&json!({"mirrorRoot": ""})));
        assert!(!carries_drive(&json!({})));
    }
}
