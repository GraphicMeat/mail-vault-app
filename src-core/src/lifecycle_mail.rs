//! In-app lifecycle messages: short notes from MailVault, delivered into the
//! inbox view on this computer, about the user's own Premium state.
//!
//! Nothing here sends anything. MailVault has no account and no address for a
//! free user, so the messages are written and shown locally; the same four
//! kinds can later become real email from the billing server. The daemon asks
//! `evaluate` on launch, on focus and after a billing refresh (`lifecycle.sync`),
//! the app only renders the rows it answers.
//!
//! A kind is due when:
//!   * `trial-ending`: the trial ends within two days (once per trial end).
//!   * `checkout-left`: a checkout was opened a day to a week ago and no plan
//!     came of it (once per attempt).
//!   * `plan-ended`: a plan ended a day to a month ago and Premium is off.
//!   * `free-nudge`: the user finished onboarding, is free, never opened a
//!     checkout, and four days have passed since the daemon first saw that
//!     (once ever).
//!
//! At most one message is delivered per call, and never within a day of the
//! last one, so a user who returns after a month gets one note, not four.
//! `lifecycleMessages: false` in the settings turns every kind off.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;

pub const TRIAL_ENDING: &str = "trial-ending";
pub const CHECKOUT_LEFT: &str = "checkout-left";
pub const PLAN_ENDED: &str = "plan-ended";
pub const FREE_NUDGE: &str = "free-nudge";

/// Every kind `evaluate` can deliver (the app maps each to catalog keys).
pub const KINDS: [&str; 4] = [TRIAL_ENDING, CHECKOUT_LEFT, PLAN_ENDED, FREE_NUDGE];

const TRIAL_WARNING_MS: i64 = 2 * DAY_MS;
const CHECKOUT_WAIT_MS: i64 = DAY_MS;
const CHECKOUT_STALE_MS: i64 = 7 * DAY_MS;
const ENDED_WAIT_MS: i64 = DAY_MS;
const ENDED_STALE_MS: i64 = 30 * DAY_MS;
const FREE_WAIT_MS: i64 = 4 * DAY_MS;
const MIN_GAP_MS: i64 = DAY_MS;

/// A time as the app or the billing server writes it: epoch milliseconds or
/// seconds, an RFC 3339 string, or a naive `YYYY-MM-DD HH:MM:SS` in UTC (what a
/// database column prints). Anything else is absent.
fn parse_time_ms(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        // Below 1e11 it is seconds (year 5138), above it milliseconds (1973).
        return Some(if n.abs() < 100_000_000_000 { n * 1000 } else { n });
    }
    let s = v.as_str()?.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"]
        .iter()
        .find_map(|f| chrono::NaiveDateTime::parse_from_str(s, f).ok())
        .map(|n| n.and_utc().timestamp_millis())
}

/// What the decision reads, taken from the app's persisted settings state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Inputs {
    pub enabled: bool,
    pub onboarding_complete: bool,
    pub premium_access: bool,
    pub has_subscription: bool,
    pub status: Option<String>,
    pub period_end_ms: Option<i64>,
    pub checkout_started_ms: Option<i64>,
}

impl Inputs {
    /// The settings `state` as the app sends it (`lifecycleMessages`,
    /// `onboardingComplete`, `lifecycleCheckoutAt`, `billingProfile`). A
    /// missing or mistyped field reads as absent; only an explicit `false`
    /// turns the messages off.
    pub fn from_state(state: &Value) -> Inputs {
        let profile = state.get("billingProfile").filter(|p| p.is_object());
        let flag = |v: Option<&Value>| v.and_then(Value::as_bool).unwrap_or(false);
        Inputs {
            enabled: state.get("lifecycleMessages").and_then(Value::as_bool) != Some(false),
            onboarding_complete: flag(state.get("onboardingComplete")),
            premium_access: flag(profile.and_then(|p| p.get("premiumAccess"))),
            has_subscription: flag(profile.and_then(|p| p.get("hasSubscription"))),
            status: profile.and_then(|p| p.get("status")).and_then(Value::as_str).map(str::to_owned),
            period_end_ms: profile.and_then(|p| p.get("currentPeriodEnd")).and_then(parse_time_ms),
            checkout_started_ms: state.get("lifecycleCheckoutAt").and_then(parse_time_ms),
        }
    }
}

/// One delivered message. `id` is stable per occasion (`trial-ending:<day>`),
/// which is what keeps a kind from being delivered twice for the same one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub kind: String,
    pub at_ms: i64,
    #[serde(default)]
    pub seen: bool,
    #[serde(default)]
    pub dismissed: bool,
}

/// What the daemon remembers between calls (`<app_dir>/lifecycle.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    /// When the daemon first saw a finished onboarding with no subscription.
    #[serde(default)]
    pub free_since_ms: Option<i64>,
    #[serde(default)]
    pub rows: Vec<Row>,
}

impl Store {
    pub fn path(app_dir: &Path) -> PathBuf {
        app_dir.join("lifecycle.json")
    }

    /// A missing or unreadable file is an empty store: the worst case is one
    /// message delivered again, never a failed launch.
    pub fn load(app_dir: &Path) -> Store {
        std::fs::read(Self::path(app_dir))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app_dir: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::fsx::write_atomic(&Self::path(app_dir), &bytes)
    }

    /// The rows the app shows, newest first. Dismissed ones are kept (so the
    /// occasion is not delivered again) but never listed.
    pub fn visible(&self) -> Vec<Row> {
        let mut rows: Vec<Row> = self.rows.iter().filter(|r| !r.dismissed).cloned().collect();
        rows.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
        rows
    }

    /// True when `id` named a row that changed.
    pub fn mark_seen(&mut self, id: &str) -> bool {
        match self.rows.iter_mut().find(|r| r.id == id && !r.seen) {
            Some(row) => {
                row.seen = true;
                true
            }
            None => false,
        }
    }

    /// True when `id` named a row that changed.
    pub fn dismiss(&mut self, id: &str) -> bool {
        match self.rows.iter_mut().find(|r| r.id == id && !r.dismissed) {
            Some(row) => {
                row.dismissed = true;
                row.seen = true;
                true
            }
            None => false,
        }
    }
}

/// Decide whether a message is due at `now_ms`; deliver at most one by pushing
/// it onto `store` and returning it. Also stamps `free_since_ms` the first time
/// a finished onboarding with no subscription is seen.
pub fn evaluate(inputs: &Inputs, store: &mut Store, now_ms: i64) -> Option<Row> {
    if !inputs.enabled {
        return None;
    }
    let free = !inputs.premium_access && !inputs.has_subscription;
    if inputs.onboarding_complete && free && store.free_since_ms.is_none() {
        store.free_since_ms = Some(now_ms);
    }
    if store.rows.iter().any(|r| now_ms - r.at_ms < MIN_GAP_MS) {
        return None;
    }
    let (kind, id) = due(inputs, store, now_ms, free)?;
    let row = Row { id, kind: kind.to_string(), at_ms: now_ms, seen: false, dismissed: false };
    store.rows.push(row.clone());
    Some(row)
}

/// The first kind that is due and has not been delivered for this occasion.
fn due(inputs: &Inputs, store: &Store, now_ms: i64, free: bool) -> Option<(&'static str, String)> {
    let within = |age: i64, from: i64, to: i64| age >= from && age <= to;
    let mut candidates: Vec<(&'static str, String)> = Vec::new();

    if let (true, true, Some("trialing"), Some(end)) =
        (inputs.premium_access, inputs.has_subscription, inputs.status.as_deref(), inputs.period_end_ms)
    {
        if end > now_ms && end - now_ms <= TRIAL_WARNING_MS {
            candidates.push((TRIAL_ENDING, format!("{TRIAL_ENDING}:{}", end / DAY_MS)));
        }
    }
    if let (false, Some(started)) = (inputs.premium_access, inputs.checkout_started_ms) {
        if within(now_ms - started, CHECKOUT_WAIT_MS, CHECKOUT_STALE_MS) {
            candidates.push((CHECKOUT_LEFT, format!("{CHECKOUT_LEFT}:{started}")));
        }
    }
    if let (false, true, Some("canceled"), Some(end)) =
        (inputs.premium_access, inputs.has_subscription, inputs.status.as_deref(), inputs.period_end_ms)
    {
        if within(now_ms - end, ENDED_WAIT_MS, ENDED_STALE_MS) {
            candidates.push((PLAN_ENDED, format!("{PLAN_ENDED}:{}", end / DAY_MS)));
        }
    }
    if inputs.onboarding_complete
        && free
        && inputs.checkout_started_ms.is_none()
        && store.free_since_ms.is_some_and(|since| now_ms - since >= FREE_WAIT_MS)
    {
        candidates.push((FREE_NUDGE, FREE_NUDGE.to_string()));
    }

    candidates.into_iter().find(|(_, id)| !store.rows.iter().any(|r| &r.id == id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn free() -> Inputs {
        Inputs { enabled: true, onboarding_complete: true, ..Default::default() }
    }

    fn trialing(period_end_ms: i64) -> Inputs {
        Inputs {
            enabled: true,
            onboarding_complete: true,
            premium_access: true,
            has_subscription: true,
            status: Some("trialing".into()),
            period_end_ms: Some(period_end_ms),
            ..Default::default()
        }
    }

    fn ended(period_end_ms: i64) -> Inputs {
        Inputs {
            enabled: true,
            onboarding_complete: true,
            has_subscription: true,
            status: Some("canceled".into()),
            period_end_ms: Some(period_end_ms),
            ..Default::default()
        }
    }

    fn row(id: &str, kind: &str, at_ms: i64) -> Row {
        Row { id: id.into(), kind: kind.into(), at_ms, seen: false, dismissed: false }
    }

    // ── trial-ending ──

    #[test]
    fn trial_ending_is_delivered_inside_two_days_and_once_per_trial_end() {
        let mut store = Store::default();
        let inputs = trialing(NOW + 36 * HOUR_MS);
        let delivered = evaluate(&inputs, &mut store, NOW).expect("a trial ending in 36 hours is due");
        assert_eq!(delivered.kind, TRIAL_ENDING);
        assert!(delivered.id.starts_with("trial-ending:"), "{}", delivered.id);
        assert_eq!(delivered.at_ms, NOW);
        assert!(!delivered.seen && !delivered.dismissed);
        assert_eq!(store.rows, vec![delivered]);
        assert!(evaluate(&inputs, &mut store, NOW + 25 * HOUR_MS).is_none(), "the same trial end is never delivered twice");
    }

    #[test]
    fn trial_ending_waits_until_it_is_close_and_stops_once_it_is_over() {
        let mut store = Store::default();
        assert!(evaluate(&trialing(NOW + 3 * DAY_MS), &mut store, NOW).is_none());
        assert!(evaluate(&trialing(NOW - HOUR_MS), &mut store, NOW).is_none());
        assert!(store.rows.is_empty());
    }

    #[test]
    fn a_paid_plan_gets_no_trial_note() {
        let mut inputs = trialing(NOW + DAY_MS);
        inputs.status = Some("active".into());
        assert!(evaluate(&inputs, &mut Store::default(), NOW).is_none());
    }

    // ── checkout-left ──

    #[test]
    fn checkout_left_is_due_a_day_after_the_checkout_opened_and_only_that_week() {
        let mut inputs = free();
        inputs.checkout_started_ms = Some(NOW - 25 * HOUR_MS);
        let delivered = evaluate(&inputs, &mut Store::default(), NOW).expect("25 hours after the checkout");
        assert_eq!(delivered.kind, CHECKOUT_LEFT);
        assert_eq!(delivered.id, format!("checkout-left:{}", NOW - 25 * HOUR_MS));

        inputs.checkout_started_ms = Some(NOW - 23 * HOUR_MS);
        assert!(evaluate(&inputs, &mut Store::default(), NOW).is_none(), "too soon");
        inputs.checkout_started_ms = Some(NOW - 8 * DAY_MS);
        assert!(evaluate(&inputs, &mut Store::default(), NOW).is_none(), "too old to nag about");
    }

    #[test]
    fn checkout_left_is_silent_once_premium_is_on() {
        let mut inputs = trialing(NOW + 30 * DAY_MS);
        inputs.checkout_started_ms = Some(NOW - 2 * DAY_MS);
        assert!(evaluate(&inputs, &mut Store::default(), NOW).is_none());
    }

    #[test]
    fn each_checkout_attempt_is_its_own_occasion() {
        let mut store = Store::default();
        let mut inputs = free();
        inputs.checkout_started_ms = Some(NOW - 2 * DAY_MS);
        assert!(evaluate(&inputs, &mut store, NOW).is_some());
        assert!(evaluate(&inputs, &mut store, NOW + 2 * DAY_MS).is_none(), "same attempt, same note");
        let later = NOW + 5 * DAY_MS;
        inputs.checkout_started_ms = Some(later - 2 * DAY_MS);
        assert!(evaluate(&inputs, &mut store, later).is_some(), "a new attempt may be followed up again");
    }

    // ── plan-ended ──

    #[test]
    fn plan_ended_is_due_a_day_after_the_end_and_for_a_month() {
        let delivered = evaluate(&ended(NOW - 2 * DAY_MS), &mut Store::default(), NOW).expect("ended two days ago");
        assert_eq!(delivered.kind, PLAN_ENDED);
        assert!(delivered.id.starts_with("plan-ended:"));
        assert!(evaluate(&ended(NOW - 12 * HOUR_MS), &mut Store::default(), NOW).is_none(), "too soon");
        assert!(evaluate(&ended(NOW - 40 * DAY_MS), &mut Store::default(), NOW).is_none(), "too long ago");
    }

    #[test]
    fn a_cancelled_plan_still_inside_its_paid_period_is_not_ended() {
        let mut inputs = ended(NOW + 10 * DAY_MS);
        inputs.premium_access = true;
        assert!(evaluate(&inputs, &mut Store::default(), NOW).is_none());
    }

    // ── free-nudge ──

    #[test]
    fn free_nudge_counts_four_days_from_the_first_sighting_and_comes_once() {
        let mut store = Store::default();
        let inputs = free();
        assert!(evaluate(&inputs, &mut store, NOW).is_none());
        assert_eq!(store.free_since_ms, Some(NOW), "the first sighting is stamped");

        assert!(evaluate(&inputs, &mut store, NOW + 4 * DAY_MS - 1).is_none());
        assert_eq!(store.free_since_ms, Some(NOW), "stamped once, never moved");
        let delivered = evaluate(&inputs, &mut store, NOW + 4 * DAY_MS).expect("four days on");
        assert_eq!(delivered.kind, FREE_NUDGE);
        assert_eq!(delivered.id, "free-nudge");
        assert!(evaluate(&inputs, &mut store, NOW + 30 * DAY_MS).is_none(), "once ever");
    }

    #[test]
    fn free_nudge_needs_a_finished_onboarding_and_a_user_who_never_tried_to_buy() {
        let mut store = Store::default();
        let mut inputs = free();
        inputs.onboarding_complete = false;
        assert!(evaluate(&inputs, &mut store, NOW).is_none());
        assert_eq!(store.free_since_ms, None, "no clock starts before onboarding is done");

        let mut store = Store { free_since_ms: Some(NOW - 10 * DAY_MS), rows: vec![] };
        let mut inputs = free();
        inputs.checkout_started_ms = Some(NOW - 10 * DAY_MS);
        assert!(evaluate(&inputs, &mut store, NOW).is_none(), "a checkout was opened: that path has its own note");

        let mut inputs = free();
        inputs.has_subscription = true;
        assert!(evaluate(&inputs, &mut store, NOW).is_none(), "a subscriber is not nudged");
    }

    // ── across kinds ──

    #[test]
    fn one_message_at_a_time_and_a_day_apart() {
        let mut store = Store { free_since_ms: Some(NOW - 10 * DAY_MS), rows: vec![row("trial-ending:1", TRIAL_ENDING, NOW - HOUR_MS)] };
        let inputs = free();
        assert!(evaluate(&inputs, &mut store, NOW).is_none(), "an hour after the last one");
        assert!(evaluate(&inputs, &mut store, NOW - HOUR_MS + DAY_MS - 1).is_none());
        assert!(evaluate(&inputs, &mut store, NOW - HOUR_MS + DAY_MS).is_some(), "a day after the last one");
    }

    #[test]
    fn a_dismissed_message_still_counts_as_delivered() {
        let mut store = Store { free_since_ms: Some(NOW - 10 * DAY_MS), rows: vec![] };
        let delivered = evaluate(&free(), &mut store, NOW).expect("due");
        assert!(store.dismiss(&delivered.id));
        assert!(evaluate(&free(), &mut store, NOW + 5 * DAY_MS).is_none());
        assert!(store.visible().is_empty());
    }

    #[test]
    fn a_left_checkout_note_comes_before_a_plan_ended_note() {
        // Both are due; one is delivered per call, in this order.
        let mut store = Store::default();
        let mut inputs = ended(NOW - 3 * DAY_MS);
        inputs.checkout_started_ms = Some(NOW - 2 * DAY_MS);
        let delivered = evaluate(&inputs, &mut store, NOW).expect("due");
        assert_eq!(delivered.kind, CHECKOUT_LEFT);
        assert!(evaluate(&inputs, &mut store, NOW + 2 * DAY_MS).is_some_and(|r| r.kind == PLAN_ENDED));
    }

    #[test]
    fn turned_off_means_nothing_is_delivered_and_no_clock_starts() {
        let mut store = Store::default();
        let mut inputs = free();
        inputs.enabled = false;
        assert!(evaluate(&inputs, &mut store, NOW).is_none());
        assert!(evaluate(&inputs, &mut store, NOW + 30 * DAY_MS).is_none());
        assert_eq!(store, Store::default());
    }

    // ── reading the settings state ──

    #[test]
    fn reads_the_settings_state_the_app_sends() {
        let inputs = Inputs::from_state(&json!({
            "lifecycleMessages": true,
            "onboardingComplete": true,
            "lifecycleCheckoutAt": 1_793_000_000_000_i64,
            "billingProfile": {
                "premiumAccess": true, "hasSubscription": true, "status": "trialing",
                "currentPeriodEnd": "2026-11-05T10:00:00.000Z",
            },
        }));
        assert_eq!(inputs, Inputs {
            enabled: true,
            onboarding_complete: true,
            premium_access: true,
            has_subscription: true,
            status: Some("trialing".into()),
            period_end_ms: Some(1_793_872_800_000),
            checkout_started_ms: Some(1_793_000_000_000),
        });
    }

    #[test]
    fn reads_a_period_end_in_every_form_the_server_has_used() {
        for end in [json!("2026-11-05 10:00:00"), json!("2026-11-05T10:00:00Z"), json!(1_793_872_800_i64), json!(1_793_872_800_000_i64)] {
            let inputs = Inputs::from_state(&json!({ "billingProfile": { "currentPeriodEnd": end } }));
            assert_eq!(inputs.period_end_ms, Some(1_793_872_800_000), "{end}");
        }
        assert_eq!(Inputs::from_state(&json!({ "billingProfile": { "currentPeriodEnd": "soon" } })).period_end_ms, None);
    }

    #[test]
    fn a_missing_or_mistyped_field_is_absent_and_only_an_explicit_false_turns_it_off() {
        let on = Inputs::from_state(&json!({}));
        assert!(on.enabled);
        assert!(!on.onboarding_complete && !on.premium_access && !on.has_subscription);
        assert_eq!((on.status, on.period_end_ms, on.checkout_started_ms), (None, None, None));

        let odd = Inputs::from_state(&json!({ "lifecycleMessages": "no", "billingProfile": "x", "onboardingComplete": 1 }));
        assert!(odd.enabled && !odd.onboarding_complete);

        assert!(!Inputs::from_state(&json!({ "lifecycleMessages": false })).enabled);
        assert!(Inputs::from_state(&Value::Null).enabled);
    }

    // ── the store ──

    #[test]
    fn the_store_survives_a_restart_and_a_damaged_file_is_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Store::load(dir.path()), Store::default());

        let mut store = Store { free_since_ms: Some(NOW), rows: vec![row("free-nudge", FREE_NUDGE, NOW)] };
        store.save(dir.path()).unwrap();
        assert_eq!(Store::load(dir.path()), store);

        std::fs::write(Store::path(dir.path()), b"{not json").unwrap();
        assert_eq!(Store::load(dir.path()), Store::default());
    }

    #[test]
    fn the_rows_are_listed_newest_first_without_the_dismissed() {
        let mut store = Store { free_since_ms: None, rows: vec![row("a", PLAN_ENDED, 10), row("b", FREE_NUDGE, 30), row("c", CHECKOUT_LEFT, 20)] };
        assert_eq!(store.visible().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["b", "c", "a"]);
        assert!(store.dismiss("c"));
        assert!(!store.dismiss("c"), "already dismissed");
        assert!(!store.dismiss("nope"));
        assert_eq!(store.visible().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn marking_a_row_seen_changes_it_once() {
        let mut store = Store { free_since_ms: None, rows: vec![row("a", PLAN_ENDED, 10)] };
        assert!(store.mark_seen("a"));
        assert!(!store.mark_seen("a"));
        assert!(!store.mark_seen("nope"));
        assert!(store.rows[0].seen && !store.rows[0].dismissed);
    }

    #[test]
    fn the_row_json_is_what_the_app_reads() {
        let v = serde_json::to_value(row("free-nudge", FREE_NUDGE, 5)).unwrap();
        assert_eq!(v, json!({ "id": "free-nudge", "kind": "free-nudge", "atMs": 5, "seen": false, "dismissed": false }));
    }
}
