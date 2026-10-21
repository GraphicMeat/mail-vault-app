//! Auto-cleanup rules: which server copies a rule names, decided the way the
//! app's `cleanupEngine.js` decided it (pinned by
//! `tests/fixtures/cleanup-rule-cases.json`). Pure: the caller hands in the
//! settings state, the account list and two lookups (the account's cached
//! mailbox list, a folder's cached headers). Whether a candidate may really
//! go (vault copy, mirror copy, server state) is the abd engine's call, not
//! this module's.
//!
//! A rule is stored in the shape the Storage settings form writes:
//! `{ id, account: "all" | email, folder, age, unit: "days" | "months",
//! action: "delete" | "archive-then-delete", enabled }`, under
//! `mailvault-settings.state.cleanupRules`.
//!
//! Every rule that cannot be read safely is refused, never guessed: a
//! threshold that fails to parse must not fall through to "every message is
//! stale".

use serde::Serialize;
use serde_json::Value;

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The form's floor, enforced again here.
pub const MIN_THRESHOLD_MS: i64 = 7 * DAY_MS;
/// A run is due this long after the last one.
pub const RUN_INTERVAL_MS: i64 = DAY_MS;

/// Folders a rule may never touch.
pub const PROTECTED_FOLDERS: &[&str] = &["Drafts"];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// Only what the vault already holds goes; nothing is downloaded.
    Delete,
    /// Archive into the vault first, then delete what was verified.
    ArchiveThenDelete,
}

/// Why an enabled rule does nothing. Catalog keys for the UI.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub enum Refusal {
    #[serde(rename = "errors.cleanupRuleProtectedFolder")]
    ProtectedFolder,
    #[serde(rename = "errors.cleanupRuleBadThreshold")]
    BadThreshold,
    #[serde(rename = "errors.cleanupRuleUnknownAction")]
    UnknownAction,
}

impl Refusal {
    pub fn catalog_key(self) -> &'static str {
        match self {
            Refusal::ProtectedFolder => "errors.cleanupRuleProtectedFolder",
            Refusal::BadThreshold => "errors.cleanupRuleBadThreshold",
            Refusal::UnknownAction => "errors.cleanupRuleUnknownAction",
        }
    }
}

/// An enabled rule the engine can run.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: String,
    /// `"all"` or one account's email.
    pub account: String,
    /// A role word from the picker (`INBOX`, `Sent`, ...), `all`, or a path.
    pub folder: String,
    pub threshold_ms: i64,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub email: String,
}

/// One server copy a rule names, in the order the JS would have deleted it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// Index of the rule in the stored list.
    pub rule: usize,
    pub action: Action,
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    /// The header cache's Message-ID, if it has one.
    pub message_id: Option<String>,
    /// Only the Trash folder itself is emptied; everything else moves there.
    pub permanent: bool,
}

#[derive(Debug, Default, PartialEq)]
pub struct Selection {
    pub candidates: Vec<Candidate>,
    /// Enabled rules that do nothing, by index.
    pub refused: Vec<(usize, Refusal)>,
}

/// Why nothing runs at all (the JS answered `{archived: 0, deleted: 0}` and
/// recorded no run).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NoRun {
    NotPremium,
    NoEnabledRules,
}

// ── JS value semantics ─────────────────────────────────────────────────────

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// JavaScript `Number(v)` for the shapes a stored rule can hold. A string in
/// a form JS reads but Rust does not (`"0x10"`) is NaN here: refused, which
/// is the safe side.
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                // "Infinity" and "inf" both end up refused: not finite.
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// Epoch ms of a date the way `new Date(x).getTime()` reads the forms the
/// header cache and the billing profile hold: ISO 8601 / RFC 3339, RFC 2822
/// (a trailing comment like `(UTC)` dropped) and a number of ms. Anything
/// else is `None`: such a message is never stale, the safe side.
pub fn js_date_ms(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(|f| f as i64),
        Value::String(s) => parse_date_str(s),
        _ => None,
    }
}

fn parse_date_str(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(t) {
        return Some(d.timestamp_millis());
    }
    let mut rfc = t.to_string();
    if rfc.ends_with(')') {
        if let Some(open) = rfc.rfind('(') {
            rfc.truncate(open);
        }
    }
    let rfc = rfc.trim();
    if let Ok(d) = chrono::DateTime::parse_from_rfc2822(rfc) {
        return Some(d.timestamp_millis());
    }
    // "1 Jan 2020 12:00:00 GMT": RFC 2822 without the weekday is accepted by
    // chrono; a bare date is UTC midnight, as in JS.
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|n| n.and_utc().timestamp_millis());
    }
    None
}

// ── Rules ──────────────────────────────────────────────────────────────────

/// `age * unit` in ms, or 0 when it does not parse.
fn threshold_ms(rule: &Value) -> i64 {
    let unit_ms = match rule.get("unit").and_then(Value::as_str) {
        Some("days") => DAY_MS as f64,
        Some("months") => 30.0 * DAY_MS as f64,
        _ => return 0,
    };
    let age = js_number(rule.get("age"));
    if !age.is_finite() || age <= 0.0 {
        return 0;
    }
    (age * unit_ms) as i64
}

/// The stored rule as the engine runs it. `Ok(None)` for a disabled rule.
pub fn parse_rule(rule: &Value) -> Result<Option<Rule>, Refusal> {
    if !truthy(rule.get("enabled")) {
        return Ok(None);
    }
    let folder = js_string(rule.get("folder"));
    if PROTECTED_FOLDERS.contains(&folder.as_str()) {
        return Err(Refusal::ProtectedFolder);
    }
    let threshold = threshold_ms(rule);
    if threshold < MIN_THRESHOLD_MS {
        return Err(Refusal::BadThreshold);
    }
    let action = match rule.get("action").and_then(Value::as_str) {
        Some("delete") => Action::Delete,
        Some("archive-then-delete") => Action::ArchiveThenDelete,
        _ => return Err(Refusal::UnknownAction),
    };
    Ok(Some(Rule {
        id: js_string(rule.get("id")),
        account: rule.get("account").and_then(Value::as_str).unwrap_or("").to_string(),
        folder,
        threshold_ms: threshold,
        action,
    }))
}

/// `String(v || '')` for a string field.
fn js_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if truthy(v) => n.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        _ => String::new(),
    }
}

// ── Premium ────────────────────────────────────────────────────────────────

/// `hasPremiumAccess(billingProfile)` over the persisted settings state, the
/// share-to-unlock grant included. (The dev-only window override does not
/// exist outside the webview.)
pub fn has_premium_access(state: &Value, now_ms: i64) -> bool {
    if let Some(g) = state.get("shareGrant").filter(|g| truthy(Some(g))) {
        if let Some(exp) = g.get("expiresAt").filter(|e| truthy(Some(e))).and_then(|e| js_date_ms(Some(e))) {
            if exp > now_ms {
                return true;
            }
        }
    }
    let Some(bp) = state.get("billingProfile").filter(|b| b.is_object()) else { return false };
    if !truthy(bp.get("hasSubscription")) {
        return false;
    }
    if let Some(Value::Bool(b)) = bp.get("clientAccessGranted") {
        return *b;
    }
    if let Some(Value::Bool(b)) = bp.get("premiumAccess") {
        return *b;
    }
    match bp.get("status").and_then(Value::as_str) {
        Some("trialing" | "active" | "past_due") => true,
        Some("canceled") if truthy(bp.get("currentPeriodEnd")) => {
            js_date_ms(bp.get("currentPeriodEnd")).is_some_and(|end| end > now_ms)
        }
        _ => false,
    }
}

// ── Folders ────────────────────────────────────────────────────────────────

/// Last segment of a mailbox path, for either delimiter a server may use.
fn leaf(path: &str) -> &str {
    path.split(['/', '.']).filter(|s| !s.is_empty()).last().unwrap_or("")
}

fn str_field<'a>(b: &'a Value, key: &str) -> &'a str {
    b.get(key).and_then(Value::as_str).unwrap_or("")
}

fn is_drafts(b: &Value) -> bool {
    str_field(b, "specialUse") == "\\Drafts"
        || PROTECTED_FOLDERS.contains(&leaf(str_field(b, "path")))
        || PROTECTED_FOLDERS.contains(&str_field(b, "name"))
}

/// The one folder a rule may empty permanently. The name is a fallback for a
/// server that declares no Trash; where one is declared, a folder merely
/// called Trash (Gmail's `[Imap]/Trash` label) is an ordinary folder.
pub fn is_trash_folder(b: &Value, mailboxes: &[Value]) -> bool {
    if str_field(b, "specialUse") == "\\Trash" {
        return true;
    }
    if mailboxes.iter().any(|m| str_field(m, "specialUse") == "\\Trash") {
        return false;
    }
    leaf(str_field(b, "path")).eq_ignore_ascii_case("trash")
}

/// The account's cached mailbox list: the last known good list when there is
/// one (an empty one included), else the current list. The old cache shape
/// is a bare array.
pub fn cached_mailboxes(entry: &Value) -> Option<Vec<Value>> {
    if let Value::Array(a) = entry {
        return Some(a.clone());
    }
    let pick = entry
        .get("lastKnownGoodMailboxes")
        .filter(|v| truthy(Some(v)))
        .or_else(|| entry.get("mailboxes").filter(|v| truthy(Some(v))))?;
    pick.as_array().cloned()
}

/// The mailboxes a rule's folder names on this account. Nothing matched is an
/// empty list, never a fallback to the literal.
pub fn resolve_folders(rule_folder: &str, mailboxes: &[Value]) -> Vec<Value> {
    let boxes: Vec<&Value> = mailboxes
        .iter()
        .filter(|b| !str_field(b, "path").is_empty() && !truthy(b.get("noselect")) && !is_drafts(b))
        .collect();
    if rule_folder == "all" {
        return boxes.into_iter().cloned().collect();
    }
    let wanted = rule_folder.to_lowercase();
    if wanted == "inbox" {
        return boxes.into_iter().find(|b| str_field(b, "path").to_lowercase() == "inbox").cloned().into_iter().collect();
    }
    let role = match rule_folder {
        "Sent" => Some("\\Sent"),
        "Trash" => Some("\\Trash"),
        "Junk" => Some("\\Junk"),
        "Archive" => Some("\\Archive"),
        _ => None,
    };
    let hit = role
        .and_then(|r| boxes.iter().find(|b| str_field(b, "specialUse") == r))
        .or_else(|| boxes.iter().find(|b| str_field(b, "path") == rule_folder))
        .or_else(|| boxes.iter().find(|b| leaf(str_field(b, "path")).to_lowercase() == wanted));
    hit.map(|b| (*b).clone()).into_iter().collect()
}

// ── Selection ──────────────────────────────────────────────────────────────

/// Accounts the rule targets, out of the visible ones.
fn targets<'a>(rule: &Rule, visible: &'a [&'a Account]) -> Vec<&'a Account> {
    visible.iter().copied().filter(|a| rule.account == "all" || a.email == rule.account).collect()
}

fn hidden(state: &Value, account_id: &str) -> bool {
    truthy(state.get("hiddenAccounts").and_then(|h| h.get(account_id)))
}

/// The stored rules, enabled or not (`[]` when the key is missing or not a list).
pub fn stored_rules(state: &Value) -> Vec<Value> {
    state.get("cleanupRules").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// What a run would delete, given every copy proves out: per rule, per
/// target account, per resolved folder, the cached headers older than the
/// rule's cutoff, in cache order. `state` is `mailvault-settings.state`.
/// `mailboxes(account_id)` is the cached mailbox entry, `headers(account_id,
/// path)` the cached header rows of one folder.
pub fn select(
    state: &Value,
    accounts: &[Account],
    now_ms: i64,
    mut mailboxes: impl FnMut(&str) -> Option<Value>,
    mut headers: impl FnMut(&str, &str) -> Vec<Value>,
) -> Result<Selection, NoRun> {
    if !has_premium_access(state, now_ms) {
        return Err(NoRun::NotPremium);
    }
    let stored = stored_rules(state);
    if !stored.iter().any(|r| truthy(r.get("enabled"))) {
        return Err(NoRun::NoEnabledRules);
    }
    let visible: Vec<&Account> = accounts.iter().filter(|a| !hidden(state, &a.id)).collect();
    let mut out = Selection::default();
    for (idx, raw) in stored.iter().enumerate() {
        let rule = match parse_rule(raw) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(why) => {
                out.refused.push((idx, why));
                continue;
            }
        };
        let cutoff = now_ms - rule.threshold_ms;
        for account in targets(&rule, &visible) {
            let Some(list) = mailboxes(&account.id).as_ref().and_then(cached_mailboxes) else { continue };
            for b in resolve_folders(&rule.folder, &list) {
                let path = str_field(&b, "path").to_string();
                let permanent = is_trash_folder(&b, &list);
                for row in headers(&account.id, &path) {
                    let Some(uid) = row.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
                    if !truthy(row.get("date")) {
                        continue;
                    }
                    let Some(at) = js_date_ms(row.get("date")) else { continue };
                    if at >= cutoff {
                        continue;
                    }
                    let message_id = row
                        .get("messageId")
                        .filter(|v| truthy(Some(v)))
                        .or_else(|| row.get("message_id"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    out.candidates.push(Candidate {
                        rule: idx,
                        action: rule.action,
                        account_id: account.id.clone(),
                        folder: path.clone(),
                        uid,
                        message_id,
                        permanent,
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Whether a run is due: never run, or the last one is a day old.
pub fn due(last_run_at: Option<i64>, now_ms: i64) -> bool {
    last_run_at.map_or(true, |at| now_ms - at > RUN_INTERVAL_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../tests/fixtures/cleanup-rule-cases.json");

    fn accounts(v: &Value) -> Vec<Account> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|a| Account { id: a["id"].as_str().unwrap().to_string(), email: a["email"].as_str().unwrap().to_string() })
            .collect()
    }

    /// Every case of the fixture the JS engine answered: the same deletes, in
    /// the same order, and the same "nothing runs".
    #[test]
    fn selects_what_cleanup_engine_js_deleted() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let now = fixture["now"].as_i64().unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 40, "the fixture lost its cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let state = json!({
                "billingProfile": case["billingProfile"],
                "shareGrant": case["shareGrant"],
                "hiddenAccounts": case["hiddenAccounts"],
                "cleanupRules": case["rules"],
            });
            let accts = accounts(&case["accounts"]);
            let picked = select(
                &state,
                &accts,
                now,
                |id| case["mailboxes"].get(id).cloned(),
                |id, path| case["headers"].get(id).and_then(|h| h.get(path)).and_then(Value::as_array).cloned().unwrap_or_default(),
            );
            let expect = &case["expect"];
            if expect["result"]["ran"] == json!(false) {
                assert!(picked.is_err(), "{name}: nothing may run");
                continue;
            }
            let sel = picked.unwrap_or_else(|e| panic!("{name}: no run ({e:?})"));
            let got: Vec<Value> =
                sel.candidates.iter().map(|c| json!([c.account_id, c.folder, c.uid, c.permanent])).collect();
            assert_eq!(Value::Array(got), expect["deletes"], "{name}");
            let archived: usize = sel.candidates.iter().filter(|c| c.action == Action::ArchiveThenDelete).count();
            assert_eq!(archived as u64, expect["result"]["archived"].as_u64().unwrap(), "{name}: archived");
        }
    }

    #[test]
    fn a_refused_rule_is_named_with_its_catalog_key() {
        let state = json!({
            "billingProfile": {"hasSubscription": true, "status": "active"},
            "cleanupRules": [
                {"id": "a", "account": "all", "folder": "Drafts", "age": 30, "unit": "days", "action": "delete", "enabled": true},
                {"id": "b", "account": "all", "folder": "INBOX", "age": 3, "unit": "days", "action": "delete", "enabled": true},
                {"id": "c", "account": "all", "folder": "INBOX", "age": 30, "unit": "days", "action": "shred", "enabled": true},
                {"id": "d", "account": "all", "folder": "INBOX", "age": 30, "unit": "days", "action": "shred", "enabled": false},
            ],
        });
        let sel = select(&state, &[], 0, |_| None, |_, _| vec![]).unwrap();
        assert_eq!(sel.refused, vec![(0, Refusal::ProtectedFolder), (1, Refusal::BadThreshold), (2, Refusal::UnknownAction)]);
        assert_eq!(serde_json::to_value(Refusal::BadThreshold).unwrap(), json!("errors.cleanupRuleBadThreshold"));
        assert_eq!(Refusal::UnknownAction.catalog_key(), "errors.cleanupRuleUnknownAction");
    }

    #[test]
    fn a_run_is_due_a_day_after_the_last() {
        assert!(due(None, 5));
        assert!(!due(Some(0), DAY_MS));
        assert!(due(Some(0), DAY_MS + 1));
    }

    #[test]
    fn dates_read_like_javascript_for_the_forms_the_cache_holds() {
        let at = |s: &str| js_date_ms(Some(&json!(s)));
        assert_eq!(at("Wed, 01 Jan 2020 12:00:00 +0000 (UTC)"), Some(1_577_880_000_000));
        assert_eq!(at("1 Jan 2020 12:00:00 GMT"), Some(1_577_880_000_000));
        assert_eq!(at("2020-01-01T12:00:00.000Z"), Some(1_577_880_000_000));
        assert_eq!(at("2020-01-01"), Some(1_577_836_800_000));
        assert_eq!(at("not a date"), None);
        assert_eq!(at(""), None);
        assert_eq!(js_date_ms(Some(&json!(5))), Some(5));
    }
}
