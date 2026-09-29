//! The daily download limit, as it governs BACKGROUND downloads.
//!
//! Settings > Data usage keeps one `transferLimits[accountId]` entry per
//! account in the persisted frontend settings blob
//! (`<app_data_dir>/frontend-settings.json`,
//! `["mailvault-settings"].state.transferLimits`). The app already writes that
//! file on every settings change, so the daemon reads it fresh instead of
//! being pushed anything.
//!
//! What the limit governs (decided 2026-09-29): the downloaders nobody is
//! waiting on. A backup run, the Hoarder worker and the app's download-ahead
//! pipeline stop at the limit and carry on after midnight UTC. Everyday mail
//! (regular sync, IDLE arrivals, a message the user opens) never stops for it;
//! only Gmail's own cut-off can stop those.
//!
//! The one entry point for a caller is [`background_allowance`]: bytes left
//! today, `None` for "no limit applies". Every caller that needs a different
//! day (tests, a job that sleeps past midnight) passes a [`Clock`] or an
//! explicit `now_ms` to the `_at` variants, so the UTC rollover can be driven
//! without waiting for it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};
use serde::Deserialize;

use crate::transfer_stats;

pub const MB: u64 = 1024 * 1024;

/// Gmail cuts an account off near 2500 MB down / 500 MB up in a day, across
/// every client it has. The download default sits 500 MB below that so a
/// user who switches the limit on and leaves the field empty keeps room for
/// everyday mail. The app's `src/utils/transferLimits.js` repeats these two
/// numbers for display and a vitest pins the two files together: change both.
pub const GMAIL_DEFAULT_DOWN_MB: u64 = 2000;
pub const GMAIL_DEFAULT_UP_MB: u64 = 500;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Per-account transfer settings, as the app persists them.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferLimits {
    /// "Pause background downloads at daily limit".
    #[serde(default)]
    pub cap_enabled: bool,
    /// "Warn when nearing daily limit" (the app's banner reads it; the daemon
    /// only carries it).
    #[serde(default = "default_true")]
    pub warn_enabled: bool,
    #[serde(default)]
    pub daily_down_limit_bytes: Option<u64>,
    #[serde(default)]
    pub daily_up_limit_bytes: Option<u64>,
}

fn default_true() -> bool {
    true
}

/// `None` when the settings file, the map, or this account's entry is missing
/// or unreadable: the cap is off, which is the default.
pub fn read_limits(app_dir: &Path, account_id: &str) -> Option<TransferLimits> {
    let raw = std::fs::read_to_string(app_dir.join("frontend-settings.json")).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let entry = settings
        .get("mailvault-settings")?
        .get("state")?
        .get("transferLimits")?
        .get(account_id)?;
    serde_json::from_value(entry.clone()).ok()
}

/// The provider's default (down, up) limit, applied when the cap is on and the
/// field is empty. Only Gmail publishes a number; everyone else is unlimited.
/// Decided by the IMAP host, never the email domain (a Workspace address on
/// `imap.gmail.com` is Gmail; `user@gmail.com` on a custom host is not).
pub fn default_limits(host: &str) -> (Option<u64>, Option<u64>) {
    let host = host.to_ascii_lowercase();
    if host.contains("gmail") || host.contains("googlemail") {
        (Some(GMAIL_DEFAULT_DOWN_MB * MB), Some(GMAIL_DEFAULT_UP_MB * MB))
    } else {
        (None, None)
    }
}

/// The daily download limit that governs background downloads: `None` when the
/// cap is off (or never set) or when nothing applies (a non-Gmail host with an
/// empty field), else the user's number or the provider default.
pub fn background_down_limit(limits: Option<&TransferLimits>, host: &str) -> Option<u64> {
    let limits = limits.filter(|l| l.cap_enabled)?;
    limits.daily_down_limit_bytes.or(default_limits(host).0)
}

// ── The clock ───────────────────────────────────────────────────────────────

/// A UTC clock the limit checks read, so the day rollover can be driven from a
/// test. Cloning shares the same clock. `Clock::system()` follows the wall
/// clock until someone `set`s it.
#[derive(Clone)]
pub struct Clock(Arc<AtomicI64>);

const FOLLOW_SYSTEM: i64 = i64::MIN;

impl Clock {
    pub fn system() -> Self {
        Clock(Arc::new(AtomicI64::new(FOLLOW_SYSTEM)))
    }

    /// A clock stopped at `ms` (epoch ms) until it is `set` or `advance`d.
    pub fn pinned(ms: i64) -> Self {
        Clock(Arc::new(AtomicI64::new(ms)))
    }

    pub fn now_ms(&self) -> i64 {
        match self.0.load(Ordering::Relaxed) {
            FOLLOW_SYSTEM => Utc::now().timestamp_millis(),
            ms => ms,
        }
    }

    /// Stop the clock at `ms`.
    pub fn set(&self, ms: i64) {
        self.0.store(ms, Ordering::Relaxed);
    }

    /// Move the clock forward by `ms` from where it reads now (pinning it).
    pub fn advance(&self, ms: i64) {
        self.0.store(self.now_ms().saturating_add(ms), Ordering::Relaxed);
    }
}

impl Default for Clock {
    fn default() -> Self {
        Clock::system()
    }
}

/// The UTC day (`YYYY-MM-DD`) `now_ms` falls in: the key `transfer_stats`
/// buckets its rows by.
pub fn day_key(now_ms: i64) -> String {
    Utc.timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%d")
        .to_string()
}

/// The next UTC midnight after `now_ms`, epoch ms: when today's allowance is
/// spent this is when downloads may resume.
pub fn next_utc_midnight_ms(now_ms: i64) -> i64 {
    (now_ms.div_euclid(DAY_MS) + 1) * DAY_MS
}

// ── The allowance ───────────────────────────────────────────────────────────

/// A limit and what has been spent against it today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allowance {
    pub limit_bytes: u64,
    pub used_bytes: u64,
}

impl Allowance {
    pub fn remaining(&self) -> u64 {
        self.limit_bytes.saturating_sub(self.used_bytes)
    }

    pub fn is_spent(&self) -> bool {
        self.used_bytes >= self.limit_bytes
    }
}

/// The background download limit for `account_id` and its usage on the UTC day
/// of `now_ms`. `None`: no limit applies. Two small reads (settings file, the
/// stats database): a blocking thread's work, not a tokio worker's.
pub fn background_status_at(app_dir: &Path, account_id: &str, host: &str, now_ms: i64) -> Option<Allowance> {
    let limits = read_limits(app_dir, account_id);
    let limit_bytes = background_down_limit(limits.as_ref(), host)?;
    let used = transfer_stats::usage_on(app_dir, account_id, &day_key(now_ms));
    Some(Allowance { limit_bytes, used_bytes: used.down })
}

/// Bytes the background downloaders may still fetch for `account_id` on the UTC
/// day of `now_ms`: `None` = cap off / unlimited, `Some(0)` = spent.
pub fn background_allowance_at(app_dir: &Path, account_id: &str, host: &str, now_ms: i64) -> Option<u64> {
    background_status_at(app_dir, account_id, host, now_ms).map(|a| a.remaining())
}

/// `background_allowance_at` on the wall clock.
pub fn background_allowance(app_dir: &Path, account_id: &str, host: &str) -> Option<u64> {
    background_allowance_at(app_dir, account_id, host, Clock::system().now_ms())
}

// ── A limit a running job carries ───────────────────────────────────────────

/// Reads the allowance afresh on every call. Injected so a test can hand a job
/// a script instead of a settings file.
pub type AllowanceFn = Arc<dyn Fn() -> Option<Allowance> + Send + Sync>;

/// The daily limit as one long-running background job sees it: how to read the
/// allowance, which clock says when it resets, how often to look, and (shared
/// by every clone, so parallel workers of one run agree) whether the job was
/// stopped by it. Build one per run: the "hit" mark is the run's.
#[derive(Clone)]
pub struct BackgroundLimit {
    allowance: AllowanceFn,
    pub clock: Clock,
    /// Look at the allowance once per this many messages a job fetches.
    pub check_every: usize,
    hit: Arc<Mutex<Option<Allowance>>>,
    /// When `check` last found the day spent (this job's clock).
    hit_at: Arc<Mutex<Option<i64>>>,
}

/// Messages between two looks at the allowance in a job. A look is a small
/// file read and a SQLite read; a message is a whole IMAP round trip.
pub const DEFAULT_CHECK_EVERY: usize = 10;

impl BackgroundLimit {
    /// The account's real limit: settings file + stats, on `clock`.
    pub fn for_account(app_dir: PathBuf, account_id: String, host: String, clock: Clock) -> Self {
        let read_clock = clock.clone();
        Self::with_allowance(
            Arc::new(move || background_status_at(&app_dir, &account_id, &host, read_clock.now_ms())),
            clock,
        )
    }

    pub fn with_allowance(allowance: AllowanceFn, clock: Clock) -> Self {
        Self {
            allowance,
            clock,
            check_every: DEFAULT_CHECK_EVERY,
            hit: Arc::new(Mutex::new(None)),
            hit_at: Arc::new(Mutex::new(None)),
        }
    }

    pub fn check_every(mut self, every: usize) -> Self {
        self.check_every = every.max(1);
        self
    }

    /// The current allowance (`None`: unlimited).
    pub fn status(&self) -> Option<Allowance> {
        (self.allowance)()
    }

    /// `Some` when today's allowance is spent. Also records the stop, so the
    /// run's final report can say why it ended.
    pub fn check(&self) -> Option<Allowance> {
        let spent = self.status().filter(Allowance::is_spent);
        if let Some(a) = spent {
            *self.hit.lock().unwrap_or_else(|p| p.into_inner()) = Some(a);
            *self.hit_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(self.clock.now_ms());
        }
        spent
    }

    /// What stopped this run, if the limit did.
    pub fn hit(&self) -> Option<Allowance> {
        *self.hit.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// When downloads may resume: the UTC midnight after the moment the limit
    /// stopped this job (the day that was spent), else after now. Reading the
    /// clock only when the final report is built would skip a whole day for a
    /// limit hit just before midnight and reported just after.
    pub fn resume_after_ms(&self) -> i64 {
        let at = (*self.hit_at.lock().unwrap_or_else(|p| p.into_inner())).unwrap_or_else(|| self.clock.now_ms());
        next_utc_midnight_ms(at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NOON: i64 = 1_773_144_000_000; // 2026-03-10T12:00:00Z

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-tl-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settings(dir: &Path, account: &str, cap: bool, down_mb: Option<u64>) {
        let mut entry = serde_json::json!({ "capEnabled": cap });
        if let Some(mb) = down_mb {
            entry["dailyDownLimitBytes"] = serde_json::json!(mb * MB);
        }
        let blob = serde_json::json!({
            "mailvault-settings": { "state": { "transferLimits": { account: entry } } }
        });
        fs::write(dir.join("frontend-settings.json"), blob.to_string()).unwrap();
    }

    fn spend(dir: &Path, account: &str, day: &str, down_mb: u64) {
        crate::app_db::with(dir, |c| crate::app_db::stats::add(c, account, day, "daemon", down_mb * MB, 0)).unwrap();
    }

    #[test]
    fn the_day_key_and_the_next_midnight_are_utc() {
        assert_eq!(day_key(NOON), "2026-03-10");
        assert_eq!(next_utc_midnight_ms(NOON), NOON + 12 * 60 * 60 * 1000);
        // Exactly at midnight the next reset is a whole day away, not now.
        assert_eq!(next_utc_midnight_ms(NOON + 12 * 60 * 60 * 1000), NOON + 36 * 60 * 60 * 1000);
        assert_eq!(day_key(next_utc_midnight_ms(NOON) - 1), "2026-03-10");
        assert_eq!(day_key(next_utc_midnight_ms(NOON)), "2026-03-11");
    }

    #[test]
    fn gmail_defaults_apply_by_host_and_nobody_else_gets_one() {
        assert_eq!(default_limits("imap.gmail.com"), (Some(2000 * MB), Some(500 * MB)));
        assert_eq!(default_limits("IMAP.GoogleMail.com"), (Some(2000 * MB), Some(500 * MB)));
        assert_eq!(default_limits("imap.hostinger.com"), (None, None));
    }

    #[test]
    fn no_settings_or_a_switched_off_cap_means_no_allowance_however_much_was_used() {
        let dir = scratch("off");
        spend(&dir, "acc", "2026-03-10", 9000);
        assert_eq!(background_allowance_at(&dir, "acc", "imap.gmail.com", NOON), None, "no settings file");

        settings(&dir, "acc", false, Some(100));
        assert_eq!(background_allowance_at(&dir, "acc", "imap.gmail.com", NOON), None, "cap switched off");

        // Another account's entry says nothing about this one.
        settings(&dir, "other", true, Some(100));
        assert_eq!(background_allowance_at(&dir, "acc", "imap.gmail.com", NOON), None, "no entry for the account");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_user_limit_leaves_what_is_left_of_it_today() {
        let dir = scratch("user");
        settings(&dir, "acc", true, Some(500));
        spend(&dir, "acc", "2026-03-10", 200);
        assert_eq!(background_allowance_at(&dir, "acc", "imap.example.com", NOON), Some(300 * MB));
        // A different day's traffic does not count against today.
        spend(&dir, "acc", "2026-03-09", 5000);
        assert_eq!(background_allowance_at(&dir, "acc", "imap.example.com", NOON), Some(300 * MB));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_field_on_gmail_uses_the_2000_mb_default_and_elsewhere_means_unlimited() {
        let dir = scratch("gmail");
        settings(&dir, "acc", true, None);
        spend(&dir, "acc", "2026-03-10", 500);
        assert_eq!(background_allowance_at(&dir, "acc", "imap.gmail.com", NOON), Some(1500 * MB));
        assert_eq!(background_allowance_at(&dir, "acc", "imap.example.com", NOON), None, "no default off Gmail");

        // An explicit number beats the default, in either direction.
        settings(&dir, "acc", true, Some(2400));
        assert_eq!(background_allowance_at(&dir, "acc", "imap.gmail.com", NOON), Some(1900 * MB));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_spent_allowance_is_zero_not_a_wrapped_number() {
        let dir = scratch("spent");
        settings(&dir, "acc", true, Some(100));
        spend(&dir, "acc", "2026-03-10", 100);
        assert_eq!(background_allowance_at(&dir, "acc", "imap.example.com", NOON), Some(0), "exactly spent");
        spend(&dir, "acc", "2026-03-10", 50);
        assert_eq!(background_allowance_at(&dir, "acc", "imap.example.com", NOON), Some(0), "overspent");
        let status = background_status_at(&dir, "acc", "imap.example.com", NOON).unwrap();
        assert_eq!((status.limit_bytes, status.used_bytes), (100 * MB, 150 * MB));
        assert!(status.is_spent());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_allowance_comes_back_when_the_clock_crosses_utc_midnight() {
        let dir = scratch("rollover");
        settings(&dir, "acc", true, Some(100));
        spend(&dir, "acc", "2026-03-10", 100);

        let clock = Clock::pinned(next_utc_midnight_ms(NOON) - 60_000);
        let limit = BackgroundLimit::for_account(dir.clone(), "acc".into(), "imap.example.com".into(), clock.clone());
        assert!(limit.check().is_some(), "a minute before midnight the day's limit is spent");
        assert_eq!(limit.hit().map(|a| a.limit_bytes), Some(100 * MB));
        assert_eq!(limit.resume_after_ms(), next_utc_midnight_ms(NOON));

        clock.advance(2 * 60_000);
        assert_eq!(day_key(clock.now_ms()), "2026-03-11");
        assert!(limit.check().is_none(), "the next UTC day starts with an empty tally");
        assert_eq!(limit.status().map(|a| a.remaining()), Some(100 * MB));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The limit is hit at 23:59:50 and the run's final report is built at
    /// 00:00:10: the wait is until the midnight that follows the hit, not a
    /// whole day more.
    #[test]
    fn the_resume_time_is_the_midnight_after_the_hit_not_after_the_report() {
        let midnight = next_utc_midnight_ms(NOON);
        let clock = Clock::pinned(midnight - 10_000);
        let limit = BackgroundLimit::with_allowance(
            Arc::new(|| Some(Allowance { limit_bytes: 10, used_bytes: 10 })),
            clock.clone(),
        );
        assert!(limit.check().is_some());
        clock.advance(20_000);
        assert_eq!(limit.resume_after_ms(), midnight);
    }

    #[test]
    fn a_scripted_allowance_and_a_pinned_clock_drive_a_job_limit() {
        let left = Arc::new(Mutex::new(Some(Allowance { limit_bytes: 10, used_bytes: 4 })));
        let seen = Arc::clone(&left);
        let limit = BackgroundLimit::with_allowance(Arc::new(move || *seen.lock().unwrap()), Clock::pinned(NOON)).check_every(3);
        assert_eq!(limit.check_every, 3);
        assert!(limit.check().is_none());
        *left.lock().unwrap() = Some(Allowance { limit_bytes: 10, used_bytes: 10 });
        assert!(limit.check().is_some());
        assert!(limit.hit().is_some());
        *left.lock().unwrap() = None;
        assert!(limit.check().is_none(), "unlimited never stops a job");
    }
}
