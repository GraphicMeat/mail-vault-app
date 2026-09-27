//! Fetch policy + eviction selection (Track H, task H1).
//!
//! Pure decision logic for "download modes": how much mail a mode keeps on
//! disk, and which cached copies a mode is allowed to delete. No I/O here —
//! the daemon eviction worker (H3) reads a mailbox's cache files and the
//! search index, builds a `FetchPolicy`, and calls into this module to
//! decide what to touch. See `docs/superpowers/plans/2026-09-26-feedback-batch-sdd/track-H-spec.md`.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchMode {
    OnDemand,
    KeepRecent,
    IndexOnly,
    Hoarder,
}

/// Default mode/window when settings carry neither a `fetchMode` string a
/// caller recognizes nor a legacy signal to fall back on.
const DEFAULT_MODE: FetchMode = FetchMode::KeepRecent;
const DEFAULT_WINDOW_MONTHS: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchPolicy {
    pub mode: FetchMode,
    /// 0 = no cutoff (never evict on age).
    pub window_months: u32,
    /// Mirrors the frontend's persisted `fetchModePremium` (kept in sync
    /// with `hasPremiumAccess(billingProfile)`). The daemon has no
    /// entitlement check of its own; it trusts this flag.
    pub hoarder_premium: bool,
}

impl FetchPolicy {
    /// Builds a policy for one account from the *`mailvault-settings.state`*
    /// object — i.e. `parsed_frontend_settings["mailvault-settings"]["state"]`,
    /// not the full `frontend-settings.json` root (see `local_copy_months` in
    /// `src-daemon/src/handlers/imap.rs` for the shape this is read from).
    ///
    /// Resolution order: a hidden account short-circuits to `None` (no
    /// download at all, matching today's behavior). Otherwise the mode comes
    /// from `state.fetchModes[account_id]` (per-account override) if it
    /// parses as a `FetchMode`, else `state.fetchMode` if that parses, else a
    /// legacy fallback: `localCacheDurationMonths == 0` means `Hoarder`,
    /// anything else means `KeepRecent`. `window_months` is
    /// `localCacheDurationMonths` verbatim when it is a valid non-negative
    /// integer, else the default of 3. Any other malformed value (wrong
    /// type, unrecognized string) is treated the same as "missing".
    pub fn from_settings(state: &serde_json::Value, account_id: &str) -> Option<FetchPolicy> {
        let hidden = state
            .get("hiddenAccounts")
            .and_then(|h| h.get(account_id))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if hidden {
            return None;
        }

        let window_months = state
            .get("localCacheDurationMonths")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);

        let mode = state
            .get("fetchModes")
            .and_then(|m| m.get(account_id))
            .and_then(|v| serde_json::from_value::<FetchMode>(v.clone()).ok())
            .or_else(|| {
                state
                    .get("fetchMode")
                    .and_then(|v| serde_json::from_value::<FetchMode>(v.clone()).ok())
            })
            .unwrap_or_else(|| match window_months {
                Some(0) => FetchMode::Hoarder,
                _ => DEFAULT_MODE,
            });

        let hoarder_premium = state
            .get("fetchModePremium")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        Some(FetchPolicy {
            mode,
            window_months: window_months.unwrap_or(DEFAULT_WINDOW_MONTHS),
            hoarder_premium,
        })
    }

    /// Whether a body dated `date_ms` may be written to (or kept in) the
    /// vault. `OnDemand` never keeps a body on disk; `Hoarder` always does;
    /// `KeepRecent`/`IndexOnly` keep it while it is inside `window_months`
    /// (a window of 0 means "never evict on age", so always `true`).
    pub fn keeps_body(&self, date_ms: i64, now_ms: i64) -> bool {
        match self.mode {
            FetchMode::OnDemand => false,
            FetchMode::Hoarder => true,
            FetchMode::KeepRecent | FetchMode::IndexOnly => {
                self.window_months == 0 || date_ms >= cutoff_ms(now_ms, self.window_months)
            }
        }
    }

    /// Whether the daemon's proactive all-folders Hoarder worker should run
    /// for this account. Premium gates only this worker (ruling 09-27): a
    /// missing or lapsed Premium never deletes anything, it just leaves a
    /// `Hoarder` account behaving like today's free "keep all".
    pub fn runs_hoarder_worker(&self) -> bool {
        self.mode == FetchMode::Hoarder && self.hoarder_premium
    }
}

/// `now_ms` minus `months` calendar months, in UTC, with the day-of-month
/// clamped to the target month's last day when it doesn't exist there (e.g.
/// Jan 31 minus 1 month lands on Dec 31, not "rolls into" January). This
/// matches the frontend's `Date.setMonth` cutoff
/// (`src/services/EmailPipelineManager.js` `_getUncachedUids`) for every
/// day-of-month <= 28; it only diverges from `setMonth`'s own overflow
/// rollover behavior for the last few days of longer months, which is an
/// existing frontend quirk this function does not reproduce on purpose.
fn cutoff_ms(now_ms: i64, months: u32) -> i64 {
    use chrono::{DateTime, Datelike, NaiveDate, Timelike, Utc};

    let now = DateTime::<Utc>::from_timestamp_millis(now_ms).unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap());
    let total_months = now.year() * 12 + now.month0() as i32 - months as i32;
    let year = total_months.div_euclid(12);
    let month = (total_months.rem_euclid(12) as u32) + 1;

    let last_day_of_target_month = {
        let first_of_next = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)
        }
        .expect("month+1 is always a valid calendar month");
        first_of_next.pred_opt().expect("the day before day 1 always exists").day()
    };
    let day = now.day().min(last_day_of_target_month);

    let date = NaiveDate::from_ymd_opt(year, month, day).expect("day was clamped to a valid day of this month");
    let time = date
        .and_hms_milli_opt(now.hour(), now.minute(), now.second(), now.timestamp_subsec_millis())
        .expect("time-of-day copied from a valid DateTime is always valid");
    DateTime::<Utc>::from_naive_utc_and_offset(time, Utc).timestamp_millis()
}

/// A cached (Maildir) copy of a message, as far as eviction cares.
pub struct CacheFile {
    pub uid: u32,
    /// Maildir flag characters (e.g. `"AS"`, `"T"`, `"AD"`).
    pub flags: String,
    pub date_ms: i64,
}

/// Uids whose non-archived cache copy `policy` allows deleting right now.
///
/// Never evicted: a file carrying the `A` flag (backup/manual
/// archive/restore/drafts — see `vault_flags::store_flags`), a uid not
/// present in `on_server` (no fresh proof the server still has it), `Hoarder`
/// mode, or `KeepRecent` with `window_months == 0` ("never evict" is treated
/// as never evict, not evict-everything-not-yet-reached).
///
/// Otherwise, per mode: `OnDemand` evicts every remaining file; `KeepRecent`
/// evicts files whose body is older than the window; `IndexOnly` evicts
/// every remaining file whose uid is in `indexed` (the search index already
/// holds it, so the body is no longer needed).
pub fn eviction_candidates(
    files: &[CacheFile],
    policy: &FetchPolicy,
    now_ms: i64,
    on_server: &HashSet<u32>,
    indexed: &HashSet<u32>,
) -> Vec<u32> {
    if policy.mode == FetchMode::Hoarder {
        return Vec::new();
    }
    if policy.mode == FetchMode::KeepRecent && policy.window_months == 0 {
        return Vec::new();
    }

    files
        .iter()
        .filter(|f| !f.flags.contains('A'))
        .filter(|f| on_server.contains(&f.uid))
        .filter(|f| match policy.mode {
            FetchMode::OnDemand => true,
            FetchMode::KeepRecent => !policy.keeps_body(f.date_ms, now_ms),
            FetchMode::IndexOnly => indexed.contains(&f.uid),
            FetchMode::Hoarder => false, // unreachable: short-circuited above
        })
        .map(|f| f.uid)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../tests/fixtures/fetch-policy-cases.json");

    #[derive(Deserialize)]
    struct Fixture {
        #[serde(rename = "fromSettingsCases")]
        from_settings_cases: Vec<FromSettingsCase>,
        #[serde(rename = "keepsBodyCases")]
        keeps_body_cases: Vec<KeepsBodyCase>,
    }

    #[derive(Deserialize)]
    struct FromSettingsCase {
        name: String,
        state: serde_json::Value,
        #[serde(rename = "accountId")]
        account_id: String,
        expected: Option<ExpectedPolicy>,
    }

    #[derive(Deserialize)]
    struct ExpectedPolicy {
        mode: FetchMode,
        #[serde(rename = "windowMonths")]
        window_months: u32,
        #[serde(rename = "hoarderPremium")]
        hoarder_premium: bool,
    }

    #[derive(Deserialize)]
    struct KeepsBodyCase {
        name: String,
        policy: ExpectedPolicy,
        #[serde(rename = "dateMs")]
        date_ms: i64,
        #[serde(rename = "nowMs")]
        now_ms: i64,
        expected: bool,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("fixture is valid JSON matching the Fixture shape")
    }

    #[test]
    fn from_settings_matches_the_shared_fixture() {
        for case in fixture().from_settings_cases {
            let actual = FetchPolicy::from_settings(&case.state, &case.account_id);
            match case.expected {
                None => assert!(actual.is_none(), "case `{}`: expected None, got {:?}", case.name, actual),
                Some(expected) => {
                    let actual = actual.unwrap_or_else(|| panic!("case `{}`: expected Some(..), got None", case.name));
                    assert_eq!(actual.mode, expected.mode, "case `{}`: mode", case.name);
                    assert_eq!(actual.window_months, expected.window_months, "case `{}`: window_months", case.name);
                    assert_eq!(actual.hoarder_premium, expected.hoarder_premium, "case `{}`: hoarder_premium", case.name);
                }
            }
        }
    }

    #[test]
    fn keeps_body_matches_the_shared_fixture() {
        for case in fixture().keeps_body_cases {
            let policy = FetchPolicy {
                mode: case.policy.mode,
                window_months: case.policy.window_months,
                hoarder_premium: case.policy.hoarder_premium,
            };
            assert_eq!(
                policy.keeps_body(case.date_ms, case.now_ms),
                case.expected,
                "case `{}`",
                case.name
            );
        }
    }

    #[test]
    fn runs_hoarder_worker_is_true_only_for_hoarder_with_premium() {
        let hoarder_premium = FetchPolicy { mode: FetchMode::Hoarder, window_months: 0, hoarder_premium: true };
        let hoarder_free = FetchPolicy { mode: FetchMode::Hoarder, window_months: 0, hoarder_premium: false };
        let keep_recent_premium = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: true };

        assert!(hoarder_premium.runs_hoarder_worker());
        assert!(!hoarder_free.runs_hoarder_worker());
        assert!(!keep_recent_premium.runs_hoarder_worker());
    }

    fn file(uid: u32, flags: &str, date_ms: i64) -> CacheFile {
        CacheFile { uid, flags: flags.to_string(), date_ms }
    }

    #[test]
    fn an_archived_file_is_never_a_candidate_in_any_mode() {
        let files = vec![file(1, "A", 0)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = [1].into_iter().collect();
        for mode in [FetchMode::OnDemand, FetchMode::KeepRecent, FetchMode::IndexOnly, FetchMode::Hoarder] {
            let policy = FetchPolicy { mode, window_months: 3, hoarder_premium: false };
            assert!(
                eviction_candidates(&files, &policy, 10_000_000, &on_server, &indexed).is_empty(),
                "mode {:?} evicted an archived file",
                mode
            );
        }
    }

    #[test]
    fn a_draft_carries_the_archived_flag_and_is_never_a_candidate() {
        let files = vec![file(1, "AD", 0)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::OnDemand, window_months: 0, hoarder_premium: false };
        assert!(eviction_candidates(&files, &policy, 10_000_000, &on_server, &indexed).is_empty());
    }

    #[test]
    fn a_file_missing_from_a_fresh_server_listing_is_never_a_candidate() {
        let files = vec![file(1, "S", 0)];
        let on_server: HashSet<u32> = HashSet::new(); // server listing doesn't have uid 1
        let indexed: HashSet<u32> = [1].into_iter().collect();
        for mode in [FetchMode::OnDemand, FetchMode::KeepRecent, FetchMode::IndexOnly] {
            let policy = FetchPolicy { mode, window_months: 3, hoarder_premium: false };
            assert!(
                eviction_candidates(&files, &policy, 10_000_000, &on_server, &indexed).is_empty(),
                "mode {:?} evicted a file absent from on_server",
                mode
            );
        }
    }

    #[test]
    fn hoarder_never_evicts_anything() {
        let files = vec![file(1, "S", 0), file(2, "T", 0)];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = [1, 2].into_iter().collect();
        let policy = FetchPolicy { mode: FetchMode::Hoarder, window_months: 3, hoarder_premium: true };
        assert!(eviction_candidates(&files, &policy, 10_000_000, &on_server, &indexed).is_empty());
    }

    #[test]
    fn keep_recent_with_window_zero_never_evicts() {
        let files = vec![file(1, "S", 0)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 0, hoarder_premium: false };
        assert!(eviction_candidates(&files, &policy, 10_000_000_000, &on_server, &indexed).is_empty());
    }

    #[test]
    fn keep_recent_evicts_only_files_older_than_the_window() {
        let now_ms = 1_768_435_200_000; // 2026-01-15T00:00:00Z
        let fresh = file(1, "S", 1_768_348_800_000); // 2026-01-14, inside a 3-month window
        let stale = file(2, "S", 1_420_070_400_000); // 2015-01-01, well outside
        let files = vec![fresh, stale];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: false };
        assert_eq!(eviction_candidates(&files, &policy, now_ms, &on_server, &indexed), vec![2]);
    }

    #[test]
    fn on_demand_evicts_every_non_archived_on_server_file_including_trashed() {
        let files = vec![file(1, "S", 0), file(2, "T", 0)];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::OnDemand, window_months: 0, hoarder_premium: false };
        let mut evicted = eviction_candidates(&files, &policy, 10_000_000, &on_server, &indexed);
        evicted.sort();
        assert_eq!(evicted, vec![1, 2]);
    }

    #[test]
    fn index_only_evicts_only_files_the_index_already_holds() {
        let files = vec![file(1, "S", 0), file(2, "S", 0)];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = [1].into_iter().collect(); // 2 not indexed yet
        let policy = FetchPolicy { mode: FetchMode::IndexOnly, window_months: 3, hoarder_premium: false };
        assert_eq!(eviction_candidates(&files, &policy, 10_000_000, &on_server, &indexed), vec![1]);
    }
}
