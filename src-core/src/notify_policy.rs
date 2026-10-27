//! The new-mail notification policy: whether a mail-arrival banner is shown,
//! and why not when it is not. The daemon answers it (`notify.decide`) from the
//! persisted `notificationSettings`; the shell only renders the banner.
//!
//! Precedence, highest first (each answers its own reason code):
//!   1. `focus-hold`: the caller says a Focus session is running. The hold and
//!      the flush at its end are the shell's (the session is window state).
//!   2. `notifications-off`: the master switch. An important sender does not
//!      punch through it: off means silence, not silence with exceptions.
//!   3. `priority-allowlist`: sender address or bare domain on the important
//!      list. Beats every mute below, and quiet hours unless that entry says
//!      `throughQuietHours: false` (only an explicit false; missing is true).
//!   4. `quiet-hours`: the account's window in local time, may cross midnight.
//!   5. `view-muted`: one of the message's views is muted.
//!   6. `account-muted`, then `folder-not-watched`: only for an account that
//!      has an entry; an unconfigured account notifies for every folder.
//!   7. `delivered-default`.
//!
//! Ported from the app's `notificationPolicy.js` with its JavaScript reading
//! of the settings kept: switches are truthy, not strictly boolean, a field of
//! the wrong type is ignored rather than failing the whole decision.
//! `tests/fixtures/notify-policy-cases.json` holds that file's answers.

use serde_json::{json, Map, Value};
use std::path::Path;

pub const FOCUS_HOLD: &str = "focus-hold";
pub const NOTIFICATIONS_OFF: &str = "notifications-off";
pub const PRIORITY_ALLOWLIST: &str = "priority-allowlist";
pub const QUIET_HOURS: &str = "quiet-hours";
pub const VIEW_MUTED: &str = "view-muted";
pub const ACCOUNT_MUTED: &str = "account-muted";
pub const FOLDER_NOT_WATCHED: &str = "folder-not-watched";
pub const DELIVERED_DEFAULT: &str = "delivered-default";
/// The daemon's own answer, not `decide`'s: every message the banner is for
/// already had one (`handlers::notify`).
pub const ALREADY_ANNOUNCED: &str = "already-announced";

/// Every reason `decide` answers (the app maps each to a catalog key).
pub const REASONS: [&str; 8] = [
    FOCUS_HOLD,
    NOTIFICATIONS_OFF,
    PRIORITY_ALLOWLIST,
    QUIET_HOURS,
    VIEW_MUTED,
    ACCOUNT_MUTED,
    FOLDER_NOT_WATCHED,
    DELIVERED_DEFAULT,
];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Decision {
    pub deliver: bool,
    pub reason: &'static str,
}

fn decision(deliver: bool, reason: &'static str) -> Decision {
    Decision { deliver, reason }
}

/// What the arrival is: which account and folder it landed in, who sent it,
/// which saved views it matches, and whether a Focus session holds banners.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ctx {
    pub account_id: Option<String>,
    pub folder: Option<Value>,
    pub from: String,
    pub domain: String,
    /// `None` when the caller sent no list (nothing is view-muted then).
    pub view_ids: Option<Vec<Value>>,
    pub focus_held: bool,
}

impl Ctx {
    /// The fields as the app sends them (`accountId`, `folder`, `from`,
    /// `domain`, `viewIds`, `focusHeld`). Missing or mistyped fields read as
    /// absent; `domain` is taken as given, never derived from `from`.
    pub fn from_value(v: &Value) -> Ctx {
        Ctx {
            account_id: v.get("accountId").and_then(js_key),
            folder: v.get("folder").filter(|f| !f.is_null()).cloned(),
            from: js_string(v.get("from")),
            domain: js_string(v.get("domain")),
            view_ids: v.get("viewIds").and_then(Value::as_array).cloned(),
            focus_held: v.get("focusHeld").is_some_and(truthy),
        }
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(v || '')` for the scalar values settings hold.
fn js_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if truthy(&Value::Number(n.clone())) => n.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        _ => String::new(),
    }
}

/// An object key the way JavaScript would index with it.
fn js_key(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// `HH:MM` (or `H:MM`) to minutes past midnight. Like the app it checks the
/// shape only, not the range: `25:00` is 1500.
fn to_minutes(v: Option<&Value>) -> Option<u32> {
    let s = v?.as_str()?.trim();
    let (h, m) = s.split_once(':')?;
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    if !(1..=2).contains(&h.len()) || m.len() != 2 || !digits(h) || !digits(m) {
        return None;
    }
    Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?)
}

fn in_quiet_hours(quiet_hours: Option<&Value>, minutes: u32) -> bool {
    let Some(q) = quiet_hours else { return false };
    if !q.get("enabled").is_some_and(truthy) {
        return false;
    }
    // An invalid or degenerate (start == end) window reads as "never quiet"
    // rather than "always quiet": a typo should not go silent all day.
    let (Some(start), Some(end)) = (to_minutes(q.get("start")), to_minutes(q.get("end"))) else {
        return false;
    };
    if start == end {
        return false;
    }
    if start < end {
        minutes >= start && minutes < end
    } else {
        minutes >= start || minutes < end // crosses midnight
    }
}

fn match_allowlist<'a>(list: Option<&'a Value>, from: &str, domain: &str) -> Option<&'a Value> {
    let f = from.to_lowercase();
    let d = domain.to_lowercase();
    list?.as_array()?.iter().find(|entry| {
        let m = js_string(entry.get("match")).to_lowercase();
        let m = m.trim();
        !m.is_empty() && (m == f || m == d)
    })
}

/// The decision for one arrival under `policy` (the `notificationSettings`
/// object) at `minutes` past local midnight.
pub fn decide(ctx: &Ctx, policy: &Value, minutes: u32) -> Decision {
    if ctx.focus_held {
        return decision(false, FOCUS_HOLD);
    }
    if !policy.get("enabled").is_some_and(truthy) {
        return decision(false, NOTIFICATIONS_OFF);
    }

    let account = ctx
        .account_id
        .as_deref()
        .and_then(|id| policy.get("accounts").and_then(|a| a.get(id)));
    let quiet = in_quiet_hours(account.and_then(|a| a.get("quietHours")), minutes);

    if let Some(entry) = match_allowlist(policy.get("importantSenders"), &ctx.from, &ctx.domain) {
        let through_quiet_hours = entry.get("throughQuietHours") != Some(&Value::Bool(false));
        if !quiet || through_quiet_hours {
            return decision(true, PRIORITY_ALLOWLIST);
        }
    }

    if quiet {
        return decision(false, QUIET_HOURS);
    }

    if let Some(ids) = &ctx.view_ids {
        let muted = policy.get("mutedViewIds").and_then(Value::as_array);
        if muted.is_some_and(|muted| ids.iter().any(|id| muted.contains(id))) {
            return decision(false, VIEW_MUTED);
        }
    }

    if let Some(account) = account.filter(|a| truthy(a)) {
        if !account.get("enabled").is_some_and(truthy) {
            return decision(false, ACCOUNT_MUTED);
        }
        if let Some(folders) = account.get("folders").and_then(Value::as_array) {
            if !ctx.folder.as_ref().is_some_and(|f| folders.contains(f)) {
                return decision(false, FOLDER_NOT_WATCHED);
            }
        }
    }

    decision(true, DELIVERED_DEFAULT)
}

/// The app's defaults for the fields `decide` reads (settingsStore.js).
fn defaults() -> Map<String, Value> {
    match json!({ "enabled": true, "accounts": {}, "mutedViewIds": [], "importantSenders": [] }) {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

/// The policy the app is running with, from the persisted
/// `mailvault-settings.state` object: the defaults with whatever the user
/// saved laid over them key by key, the way the app's store merges them.
/// Nothing saved (a fresh install, before the first write) is the defaults,
/// which notify: a missing setting must not mean silence.
pub fn policy_from_state(state: Option<&Value>) -> Value {
    let mut policy = defaults();
    if let Some(Value::Object(saved)) = state.and_then(|s| s.get("notificationSettings")) {
        for (k, v) in saved {
            policy.insert(k.clone(), v.clone());
        }
    }
    Value::Object(policy)
}

/// `policy_from_state` over `frontend-settings.json` in `app_dir`. An
/// unreadable document reads as nothing saved.
pub fn read_policy(app_dir: &Path) -> Value {
    let doc = crate::settings_doc::SettingsDoc::shared(app_dir).read().ok();
    policy_from_state(doc.as_deref().and_then(|d| d.get("mailvault-settings")).and_then(|s| s.get("state")))
}

/// Minutes past local midnight now.
pub fn local_minutes_now() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/notify-policy-cases.json");

    fn minutes(hhmm: &str) -> u32 {
        let (h, m) = hhmm.split_once(':').unwrap();
        h.parse::<u32>().unwrap() * 60 + m.parse::<u32>().unwrap()
    }

    #[test]
    fn matches_every_case_of_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 60, "fixture lost its cases");
        let mut wrong = Vec::new();
        for c in cases {
            let got = decide(&Ctx::from_value(&c["ctx"]), &c["policy"], minutes(c["local"].as_str().unwrap()));
            let want = (c["expected"]["deliver"].as_bool().unwrap(), c["expected"]["reason"].as_str().unwrap());
            if (got.deliver, got.reason) != want {
                wrong.push(format!("{}: got {:?}, want {:?}", c["name"], got, want));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn every_reason_the_fixture_expects_is_listed() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for c in fixture["cases"].as_array().unwrap() {
            let reason = c["expected"]["reason"].as_str().unwrap();
            assert!(REASONS.contains(&reason), "{reason}");
        }
    }

    fn arrival() -> Ctx {
        Ctx { account_id: Some("a1".into()), folder: Some(json!("INBOX")), ..Ctx::default() }
    }

    #[test]
    fn nothing_saved_notifies() {
        for state in [None, Some(json!({})), Some(json!({"notificationSettings": null})), Some(json!({"notificationSettings": "x"}))] {
            let policy = policy_from_state(state.as_ref());
            assert_eq!(decide(&arrival(), &policy, 720), decision(true, DELIVERED_DEFAULT), "{state:?}");
        }
    }

    #[test]
    fn saved_fields_lay_over_the_defaults_key_by_key() {
        // A blob saved before `enabled` existed keeps the default switch on.
        let state = json!({"notificationSettings": {"accounts": {"a1": {"enabled": false}}, "sound": "Glass"}});
        let policy = policy_from_state(Some(&state));
        assert_eq!(policy["enabled"], json!(true));
        assert_eq!(policy["importantSenders"], json!([]));
        assert_eq!(decide(&arrival(), &policy, 720), decision(false, ACCOUNT_MUTED));

        let off = json!({"notificationSettings": {"enabled": false}});
        assert_eq!(decide(&arrival(), &policy_from_state(Some(&off)), 720), decision(false, NOTIFICATIONS_OFF));
    }

    #[test]
    fn read_policy_reads_the_settings_document_and_survives_its_absence() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(decide(&arrival(), &read_policy(dir.path()), 720), decision(true, DELIVERED_DEFAULT));

        let doc = json!({"mailvault-settings": {"state": {"notificationSettings": {"enabled": true, "accounts": {"a1": {"enabled": false}}}}, "version": 20}});
        std::fs::write(dir.path().join("frontend-settings.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(decide(&arrival(), &read_policy(dir.path()), 720), decision(false, ACCOUNT_MUTED));
    }

    #[test]
    fn ctx_reads_the_app_fields_leniently() {
        let ctx = Ctx::from_value(&json!({
            "accountId": "a1", "folder": "INBOX", "from": "x@y.com", "domain": "y.com",
            "viewIds": ["v1"], "focusHeld": true,
        }));
        assert_eq!(ctx.account_id.as_deref(), Some("a1"));
        assert_eq!(ctx.folder, Some(json!("INBOX")));
        assert_eq!((ctx.from.as_str(), ctx.domain.as_str()), ("x@y.com", "y.com"));
        assert_eq!(ctx.view_ids, Some(vec![json!("v1")]));
        assert!(ctx.focus_held);

        let empty = Ctx::from_value(&json!({"from": null, "viewIds": "v1", "focusHeld": 0}));
        assert_eq!(empty, Ctx::default());
        assert_eq!(Ctx::from_value(&Value::Null), Ctx::default());
    }

    #[test]
    fn local_minutes_is_inside_a_day() {
        assert!(local_minutes_now() < 24 * 60);
    }
}
