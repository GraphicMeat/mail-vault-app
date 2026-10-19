use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Complete feedback store for an account.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Feedback {
    pub rules: Vec<serde_json::Value>,
    pub corrections: Vec<serde_json::Value>,
    pub stats: FeedbackStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FeedbackStats {
    #[serde(default)]
    pub total_classified: usize,
    #[serde(default)]
    pub total_corrected: usize,
    #[serde(default)]
    pub accuracy_rate: f64,
}

fn feedback_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ai-feedback")
}

fn feedback_path(data_dir: &Path, account_id: &str) -> PathBuf {
    feedback_dir(data_dir).join(format!("{}.json", account_id))
}

/// Load feedback for an account.
pub fn load_feedback(data_dir: &Path, account_id: &str) -> Feedback {
    let path = feedback_path(data_dir, account_id);
    if !path.exists() {
        return Feedback::default();
    }

    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_else(|e| {
            // The file exists but does not parse — a truncated write. Saying so
            // is the only warning before the next save persists this default
            // over the user's rules.
            warn!("Feedback for {} is unreadable ({}), starting from empty: {}", account_id, e, path.display());
            Feedback::default()
        }),
        Err(e) => {
            warn!("Failed to read feedback for {}: {}", account_id, e);
            Feedback::default()
        }
    }
}

/// Save feedback for an account.
pub fn save_feedback(
    data_dir: &Path,
    account_id: &str,
    feedback: &Feedback,
) -> Result<(), String> {
    let dir = feedback_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let json = serde_json::to_string_pretty(feedback)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    let path = feedback_path(data_dir, account_id);
    crate::fsx::write_atomic(&path, json.as_bytes()).map_err(|e| format!("Failed to write: {}", e))?;

    info!(
        "Saved feedback for {} ({} rules, {} corrections)",
        account_id,
        feedback.rules.len(),
        feedback.corrections.len()
    );
    Ok(())
}

// ── Learning logic ────────────────────────────────────────────────────────
//
// A port of the app's former learningService.js and ruleExporter.js. Rules and
// corrections stay raw JSON (`Value`) so unknown keys, null versus missing and
// integer versus float survive exactly as the JS left them; the golden table in
// tests/fixtures/learning-cases.json pins every output.

/// Version of the anonymized rules export this build writes and reads.
pub const EXPORT_VERSION: u64 = 1;

/// Why an import file was refused: an i18n catalog key and its params.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportError {
    pub key: &'static str,
    pub params: Option<Value>,
}

/// The anonymized export: the payload and the exact file text the app saves.
#[derive(Debug, Clone)]
pub struct RulesExport {
    pub payload: Value,
    pub json: String,
}

const KEY_INVALID_FORMAT: &str = "svc.ruleExporter.invalidFormatMissingVersionRules";
const KEY_UNSUPPORTED_VERSION: &str = "svc.ruleExporter.unsupportedFormatVersionAppSupports";
const KEY_PARSE_ERROR: &str = "svc.ruleExporter.parseError";

/// `new Date(ms).toISOString()`.
fn iso_millis(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn pattern_field<'a>(rule: &'a Value, key: &str) -> Option<&'a Value> {
    rule.get("pattern").and_then(|p| p.get(key))
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    // A JS `undefined` property never reaches JSON: leave the key out.
    if let Some(v) = value {
        map.insert(key.to_string(), v.clone());
    }
}

fn learned_rule(id: String, pattern: Value, category: Option<&Value>, action: Option<&Value>, confidence: f64, learned_from: usize, now_ms: i64) -> Value {
    let mut rule = Map::new();
    rule.insert("id".into(), Value::String(id));
    rule.insert("type".into(), json!("sender-action"));
    rule.insert("pattern".into(), pattern);
    put(&mut rule, "category", category);
    rule.insert("importance".into(), Value::Null);
    put(&mut rule, "action", action);
    rule.insert("confidence".into(), json!(confidence));
    rule.insert("learnedFrom".into(), json!(learned_from));
    rule.insert("createdAt".into(), Value::String(iso_millis(now_ms)));
    rule.insert("source".into(), json!("learned"));
    Value::Object(rule)
}

/// `Math.min(0.99, confidence + 0.01)`, NaN (null) when the sum is not a number.
fn strengthened_confidence(confidence: Option<&Value>) -> Value {
    let sum = js::plus(confidence, 0.01).to_number();
    js::number(if sum.is_nan() { f64::NAN } else { sum.min(0.99) })
}

/// Record a user's correction and learn from it. Answers
/// `{correctionSaved, ruleGenerated, rule}` like the JS did.
///
/// The stats are left alone: the JS bumped camelCase counters the store never
/// kept (`FeedbackStats` reads only its snake_case fields), so on disk they
/// never moved.
pub fn record_correction(fb: &mut Feedback, email: &Value, correction: &Value, now_ms: i64) -> Value {
    let mut entry = Map::new();
    put(&mut entry, "messageId", email.get("messageId"));
    put(&mut entry, "from", email.get("from"));
    put(&mut entry, "subject", email.get("subject"));
    put(&mut entry, "originalCategory", correction.get("originalCategory"));
    put(&mut entry, "correctedCategory", correction.get("correctedCategory"));
    put(&mut entry, "correctedAction", correction.get("correctedAction"));
    entry.insert("timestamp".into(), Value::String(iso_millis(now_ms)));
    fb.corrections.push(Value::Object(entry));

    let category = correction.get("correctedCategory");
    let action = correction.get("correctedAction");
    let mut rule_generated = false;
    let mut new_rule = Value::Null;

    let domain = extract_domain(email.get("from")).filter(|d| !d.is_empty());
    let address = extract_address(email.get("from")).filter(|a| !a.is_empty());

    if let Some(domain) = domain {
        let domain_value = Value::String(domain.clone());
        let same_domain = |c: &Value| extract_domain(c.get("from")).as_deref() == Some(domain.as_str());
        let domain_corrections: Vec<&Value> = fb
            .corrections
            .iter()
            .filter(|c| same_domain(c) && js::strict_eq(c.get("correctedCategory"), category))
            .collect();
        let conflicting = fb
            .corrections
            .iter()
            .any(|c| same_domain(c) && !js::strict_eq(c.get("correctedCategory"), category));

        if let (true, Some(address)) = (conflicting, address) {
            // Senders of one domain corrected to different categories: learn the address.
            let address_value = Value::String(address);
            let existing = fb.rules.iter_mut().find(|r| {
                js::strict_eq(pattern_field(r, "fromAddress"), Some(&address_value)) && js::strict_eq(r.get("category"), category)
            });
            match existing {
                None => {
                    new_rule = learned_rule(format!("r-{now_ms}"), json!({ "fromAddress": address_value }), category, action, 0.95, 1, now_ms);
                    fb.rules.push(new_rule.clone());
                    rule_generated = true;
                }
                Some(rule) => {
                    let learned_from = if js::truthy(rule.get("learnedFrom")) { js::plus(rule.get("learnedFrom"), 1.0).into_value() } else { json!(2) };
                    let confidence = strengthened_confidence(rule.get("confidence"));
                    if let Some(obj) = rule.as_object_mut() {
                        obj.insert("learnedFrom".into(), learned_from);
                        obj.insert("confidence".into(), confidence);
                    }
                }
            }
        } else if !domain_corrections.is_empty() {
            let existing = fb.rules.iter_mut().find(|r| {
                js::strict_eq(pattern_field(r, "fromDomain"), Some(&domain_value)) && js::strict_eq(r.get("category"), category)
            });
            match existing {
                None => {
                    new_rule = learned_rule(format!("r-{now_ms}"), json!({ "fromDomain": domain_value }), category, action, 0.95, domain_corrections.len(), now_ms);
                    fb.rules.push(new_rule.clone());
                    rule_generated = true;
                }
                Some(rule) => {
                    let confidence = strengthened_confidence(rule.get("confidence"));
                    if let Some(obj) = rule.as_object_mut() {
                        obj.insert("learnedFrom".into(), json!(domain_corrections.len()));
                        obj.insert("confidence".into(), confidence);
                        if js::truthy(action) {
                            put(obj, "action", action);
                        }
                    }
                }
            }
        }

        // Two or more corrections from the domain sharing a subject word: learn the word too.
        if domain_corrections.len() >= 2 {
            if let Some(word) = find_shared_subject_word(&domain_corrections) {
                let word_value = Value::String(word);
                let known = fb.rules.iter().any(|r| {
                    js::strict_eq(pattern_field(r, "fromDomain"), Some(&domain_value))
                        && js::strict_eq(pattern_field(r, "subjectContains"), Some(&word_value))
                        && js::strict_eq(r.get("category"), category)
                });
                if !known {
                    let rule = learned_rule(
                        format!("r-{now_ms}-subj"),
                        json!({ "fromDomain": domain_value, "subjectContains": word_value }),
                        category,
                        action,
                        0.90,
                        domain_corrections.len(),
                        now_ms,
                    );
                    fb.rules.push(rule);
                }
            }
        }
    }

    json!({ "correctionSaved": true, "ruleGenerated": rule_generated, "rule": new_rule })
}

/// The part after the last `@`, `>` removed, lowercased. `None` when there is
/// no `@` past the first character.
fn extract_domain(from: Option<&Value>) -> Option<String> {
    let from = from?.as_str().filter(|s| !s.is_empty())?;
    let at = from.rfind('@')?;
    if at == 0 {
        return None;
    }
    Some(from[at + 1..].replace('>', "").to_lowercase())
}

/// The address inside the first `<...>`, else the whole string when it holds an `@`.
fn extract_address(from: Option<&Value>) -> Option<String> {
    let from = from?.as_str().filter(|s| !s.is_empty())?;
    for (i, _) in from.match_indices('<') {
        let rest = &from[i + 1..];
        if let Some(end) = rest.find('>') {
            if end > 0 {
                return Some(rest[..end].to_lowercase());
            }
        } else {
            break;
        }
    }
    if from.contains('@') {
        return Some(js::trim(from).to_lowercase());
    }
    None
}

/// The longest word (4+ UTF-16 units) every subject shares, the first
/// subject's order breaking ties.
fn find_shared_subject_word(corrections: &[&Value]) -> Option<String> {
    if corrections.len() < 2 {
        return None;
    }
    let sets: Vec<Vec<String>> = corrections
        .iter()
        .map(|c| {
            let subject = c.get("subject").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let mut words: Vec<String> = Vec::new();
            for w in subject.split(js::is_space).filter(|w| js::utf16_len(w) >= 4) {
                if !words.iter().any(|x| x == w) {
                    words.push(w.to_string());
                }
            }
            words
        })
        .collect();
    let mut shared: Vec<&String> = sets[0].iter().filter(|w| sets.iter().all(|s| s.contains(w))).collect();
    shared.sort_by_key(|w| std::cmp::Reverse(js::utf16_len(w)));
    shared.first().map(|w| (*w).clone())
}

/// Add a rule, or shallow-merge it into the rule with the same `id`.
pub fn save_rule(fb: &mut Feedback, rule: Value) {
    match fb.rules.iter_mut().find(|r| js::strict_eq(r.get("id"), rule.get("id"))) {
        Some(existing) => {
            if !(existing.is_object() && rule.is_object()) {
                *existing = rule;
            } else if let (Some(obj), Value::Object(update)) = (existing.as_object_mut(), rule) {
                obj.extend(update);
            }
        }
        None => fb.rules.push(rule),
    }
}

/// Remove every rule whose `id` is `rule_id` (a missing id matches rules without one).
pub fn delete_rule(fb: &mut Feedback, rule_id: Option<&Value>) {
    fb.rules.retain(|r| !js::strict_eq(r.get("id"), rule_id));
}

/// The stored stats plus `rulesCount` and `correctionsCount`.
pub fn stats(fb: &Feedback) -> Value {
    let mut out = match serde_json::to_value(&fb.stats) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    out.insert("rulesCount".into(), json!(fb.rules.len()));
    out.insert("correctionsCount".into(), json!(fb.corrections.len()));
    Value::Object(out)
}

#[derive(Serialize)]
struct ExportPayload {
    version: u64,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    #[serde(rename = "rulesCount")]
    rules_count: usize,
    rules: Vec<ExportRule>,
}

// Field order is the key order of the file the JS wrote.
#[derive(Serialize)]
struct ExportRule {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    rule_type: Option<Value>,
    pattern: ExportPattern,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    importance: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<Value>,
}

/// Only domains and subject keywords: `fromAddress` is too identifying.
#[derive(Serialize)]
struct ExportPattern {
    #[serde(rename = "fromDomain", skip_serializing_if = "Option::is_none")]
    from_domain: Option<Value>,
    #[serde(rename = "subjectContains", skip_serializing_if = "Option::is_none")]
    subject_contains: Option<Value>,
}

/// Export the rules without addresses, names or account ids.
pub fn export_rules(fb: &Feedback, now_ms: i64) -> RulesExport {
    let truthy_field = |rule: &Value, key: &str| pattern_field(rule, key).filter(|v| js::truthy(Some(v))).cloned();
    let rules: Vec<ExportRule> = fb
        .rules
        .iter()
        .map(|rule| ExportRule {
            rule_type: rule.get("type").cloned(),
            pattern: ExportPattern {
                from_domain: truthy_field(rule, "fromDomain"),
                subject_contains: truthy_field(rule, "subjectContains"),
            },
            category: rule.get("category").cloned(),
            importance: rule.get("importance").cloned(),
            action: rule.get("action").cloned(),
            confidence: rule.get("confidence").cloned(),
        })
        .collect();
    let payload = ExportPayload { version: EXPORT_VERSION, exported_at: iso_millis(now_ms), rules_count: rules.len(), rules };
    RulesExport {
        payload: serde_json::to_value(&payload).unwrap_or(Value::Null),
        json: serde_json::to_string_pretty(&payload).unwrap_or_default(),
    }
}

/// Check a parsed import file and normalize its rules.
///
/// A `null` document or rule entry made the JS throw while reading it, which
/// the app showed as a parse error with the engine's message; the same
/// message (V8's wording) comes back here.
pub fn validate_import(data: &Value) -> Result<Vec<Value>, ImportError> {
    let type_error = |prop: &str| ImportError {
        key: KEY_PARSE_ERROR,
        params: Some(json!({ "e": format!("Cannot read properties of null (reading '{prop}')") })),
    };
    if data.is_null() {
        return Err(type_error("version"));
    }
    let version = data.get("version");
    let rules = match data.get("rules") {
        Some(Value::Array(rules)) if js::truthy(version) => rules,
        _ => return Err(ImportError { key: KEY_INVALID_FORMAT, params: None }),
    };
    if js::to_number(version) > EXPORT_VERSION as f64 {
        return Err(ImportError {
            key: KEY_UNSUPPORTED_VERSION,
            params: Some(json!({ "data": version, "EXPORT_VERSION": EXPORT_VERSION })),
        });
    }
    if rules.iter().any(Value::is_null) {
        return Err(type_error("pattern"));
    }
    let or_null = |v: Option<&Value>| if js::truthy(v) { v.cloned().unwrap_or(Value::Null) } else { Value::Null };
    Ok(rules
        .iter()
        .filter(|r| js::truthy(r.get("pattern")) && js::truthy(r.get("type")))
        .map(|r| {
            json!({
                "type": r.get("type"),
                "pattern": r.get("pattern"),
                "category": or_null(r.get("category")),
                "importance": or_null(r.get("importance")),
                "action": or_null(r.get("action")),
                "confidence": if js::truthy(r.get("confidence")) { r["confidence"].clone() } else { json!(0.8) },
            })
        })
        .collect())
}

/// Add the rules no existing rule already covers (same domain, category and
/// action); answers how many were added. The caller saves only when it is
/// above zero.
pub fn import_rules(fb: &mut Feedback, rules: &[Value], now_ms: i64) -> usize {
    let mut imported = 0;
    for rule in rules {
        let exists = fb.rules.iter().any(|r| {
            js::strict_eq(pattern_field(r, "fromDomain"), pattern_field(rule, "fromDomain"))
                && js::strict_eq(r.get("category"), rule.get("category"))
                && js::strict_eq(r.get("action"), rule.get("action"))
        });
        if exists {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(format!("r-imp-{now_ms}-{imported}")));
        if let Some(fields) = rule.as_object() {
            entry.extend(fields.clone());
        }
        entry.insert("learnedFrom".into(), json!(0));
        entry.insert("createdAt".into(), Value::String(iso_millis(now_ms)));
        entry.insert("source".into(), json!("imported"));
        fb.rules.push(Value::Object(entry));
        imported += 1;
    }
    imported
}

/// The JavaScript semantics the ported code depended on: truthiness, `===`,
/// `+` and `ToNumber` over JSON values (`None` is `undefined`), and the
/// whitespace and string length JS uses.
mod js {
    use serde_json::{json, Value};

    pub fn truthy(v: Option<&Value>) -> bool {
        match v {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        }
    }

    /// `===`. Two objects or arrays are never the same object here.
    pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
        match (a, b) {
            (None, None) => true,
            (Some(Value::Null), Some(Value::Null)) => true,
            (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
            (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
            (Some(Value::String(x)), Some(Value::String(y))) => x == y,
            _ => false,
        }
    }

    /// A JS number as JSON: integers stay integers, NaN and infinities are null.
    pub fn number(f: f64) -> Value {
        if !f.is_finite() {
            Value::Null
        } else if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
            json!(f as i64)
        } else {
            json!(f)
        }
    }

    pub fn number_to_string(f: f64) -> String {
        if f.is_nan() {
            return "NaN".into();
        }
        if f.is_infinite() {
            return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
        }
        if f == 0.0 {
            return "0".into();
        }
        let abs = f.abs();
        if abs >= 1e21 || abs < 1e-6 {
            let s = format!("{f:e}");
            return match s.split_once('e') {
                Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
                _ => s,
            };
        }
        format!("{f}")
    }

    /// `String(v)`.
    pub fn to_string(v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => s.clone(),
            Value::Array(items) => items
                .iter()
                .map(|i| if i.is_null() { String::new() } else { to_string(i) })
                .collect::<Vec<_>>()
                .join(","),
            Value::Object(_) => "[object Object]".into(),
        }
    }

    /// `Number(v)`.
    pub fn to_number(v: Option<&Value>) -> f64 {
        match v {
            None => f64::NAN,
            Some(Value::Null) => 0.0,
            Some(Value::Bool(b)) => f64::from(u8::from(*b)),
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(s)) => string_to_number(s),
            Some(other) => string_to_number(&to_string(other)),
        }
    }

    fn string_to_number(s: &str) -> f64 {
        let s = trim(s);
        if s.is_empty() {
            return 0.0;
        }
        match s {
            "Infinity" | "+Infinity" => return f64::INFINITY,
            "-Infinity" => return f64::NEG_INFINITY,
            _ => {}
        }
        for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
            if let Some(digits) = s.strip_prefix(prefix) {
                return u128::from_str_radix(digits, radix).map(|n| n as f64).unwrap_or(f64::NAN);
            }
        }
        let body = s.strip_prefix(['+', '-']).unwrap_or(s);
        let (mantissa, exponent) = match body.find(['e', 'E']) {
            Some(i) => (&body[..i], Some(&body[i + 1..])),
            None => (body, None),
        };
        let digits_ok = {
            let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            (!int.is_empty() || !frac.is_empty())
                && int.bytes().all(|b| b.is_ascii_digit())
                && frac.bytes().all(|b| b.is_ascii_digit())
        };
        let exponent_ok = exponent.map_or(true, |e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && e.bytes().all(|b| b.is_ascii_digit())
        });
        if digits_ok && exponent_ok {
            s.parse::<f64>().unwrap_or(f64::NAN)
        } else {
            f64::NAN
        }
    }

    /// `v + n`: string concatenation when `v` is a string, array or object,
    /// numeric addition otherwise.
    pub enum Sum {
        Text(String),
        Number(f64),
    }

    pub fn plus(v: Option<&Value>, n: f64) -> Sum {
        match v {
            Some(s @ (Value::String(_) | Value::Array(_) | Value::Object(_))) => {
                Sum::Text(format!("{}{}", to_string(s), number_to_string(n)))
            }
            other => Sum::Number(to_number(other) + n),
        }
    }

    impl Sum {
        pub fn to_number(&self) -> f64 {
            match self {
                Sum::Text(s) => string_to_number(s),
                Sum::Number(f) => *f,
            }
        }

        pub fn into_value(self) -> Value {
            match self {
                Sum::Text(s) => Value::String(s),
                Sum::Number(f) => number(f),
            }
        }
    }

    /// JS `\s` (WhiteSpace and LineTerminator).
    pub fn is_space(c: char) -> bool {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
                | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    }

    pub fn trim(s: &str) -> &str {
        s.trim_matches(is_space)
    }

    /// `str.length`.
    pub fn utf16_len(s: &str) -> usize {
        s.encode_utf16().count()
    }
}

#[cfg(test)]
mod fixture_tests {
    //! The golden table the JS produced before it was deleted (its harness was
    //! src/services/__tests__/learningCharacterization.test.js, commit 752041bb7).
    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../tests/fixtures/learning-cases.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        scenarios: Vec<Scenario>,
        preview_cases: Vec<PreviewCase>,
    }

    #[derive(Deserialize)]
    struct Scenario {
        name: String,
        initial: Option<Feedback>,
        steps: Vec<Value>,
    }

    #[derive(Deserialize)]
    struct PreviewCase {
        name: String,
        text: String,
        expect: Value,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("learning-cases.json parses")
    }

    /// JSON numbers as f64, so `0` and `0.0` (or `1` and `1.0`) compare equal
    /// the way JS sees them.
    fn canon(v: &Value) -> Value {
        match v {
            Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap()).map(Value::Number).unwrap_or(Value::Null),
            Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), canon(v))).collect()),
            other => other.clone(),
        }
    }

    fn run_scenario(scenario: &Scenario) {
        let mut fb = scenario.initial.clone().unwrap_or_default();
        for (i, step) in scenario.steps.iter().enumerate() {
            let op = step["op"].as_str().unwrap();
            let now = step.get("now").and_then(Value::as_i64).unwrap_or(0);
            let ctx = format!("{} / step {} ({})", scenario.name, i, op);
            let (got, saved) = match op {
                "recordCorrection" => (record_correction(&mut fb, &step["email"], &step["correction"], now), true),
                "getRules" => (Value::Array(fb.rules.clone()), false),
                "getStats" => (stats(&fb), false),
                "saveRule" => {
                    save_rule(&mut fb, step["rule"].clone());
                    (Value::Null, true)
                }
                "deleteRule" => {
                    delete_rule(&mut fb, step.get("ruleId"));
                    (Value::Null, true)
                }
                "exportRules" => {
                    let out = export_rules(&fb, now);
                    assert_eq!(out.json, step["expect"]["json"].as_str().unwrap(), "{ctx}: file text");
                    (serde_json::json!({ "payload": out.payload, "json": out.json }), false)
                }
                "importRules" => {
                    let rules = step["rules"].as_array().unwrap().clone();
                    let n = import_rules(&mut fb, &rules, now);
                    (serde_json::json!({ "imported": n }), n > 0)
                }
                other => panic!("unknown op {other}"),
            };
            assert_eq!(canon(&got), canon(&step["expect"]), "{ctx}: answer");
            assert_eq!(saved, step["saved"].as_bool().unwrap(), "{ctx}: saved");
            let after = serde_json::to_value(&fb).unwrap();
            assert_eq!(canon(&after), canon(&step["after"]), "{ctx}: stored feedback");
        }
    }

    fn scenario(name: &str) -> Scenario {
        fixture().scenarios.into_iter().find(|s| s.name == name).unwrap_or_else(|| panic!("no scenario {name}"))
    }

    #[test]
    fn corrections_make_domain_subject_and_address_rules() {
        run_scenario(&scenario("corrections make domain, subject and address rules"));
    }

    #[test]
    fn sender_strings_that_make_no_rule_or_an_odd_domain() {
        run_scenario(&scenario("sender strings that make no rule or an odd domain"));
    }

    #[test]
    fn strengthening_imported_and_manual_rules() {
        run_scenario(&scenario("strengthening imported and manual rules"));
    }

    #[test]
    fn subject_words_separators_ties_and_no_shared_word() {
        run_scenario(&scenario("subject words: separators, ties and no shared word"));
    }

    #[test]
    fn saving_and_deleting_rules() {
        run_scenario(&scenario("saving and deleting rules"));
    }

    #[test]
    fn importing_rules() {
        run_scenario(&scenario("importing rules"));
    }

    #[test]
    fn every_scenario_has_a_test() {
        let names: Vec<String> = fixture().scenarios.into_iter().map(|s| s.name).collect();
        assert_eq!(names.len(), 6, "a new scenario needs its own #[test] above: {names:?}");
    }

    #[test]
    fn import_files_are_checked_like_the_app_did() {
        let mut checked = 0;
        for case in fixture().preview_cases {
            let Ok(data) = serde_json::from_str::<Value>(&case.text) else {
                // Text that is not JSON never reaches the daemon: the app parses
                // the picked file and words the parse error itself.
                assert_eq!(case.expect["error"]["key"], "svc.ruleExporter.parseError", "{}", case.name);
                continue;
            };
            let got = match validate_import(&data) {
                Ok(rules) => serde_json::json!({ "valid": true, "rules": rules, "error": null }),
                Err(e) => serde_json::json!({ "valid": false, "rules": [], "error": { "key": e.key, "params": e.params } }),
            };
            assert_eq!(canon(&got), canon(&case.expect), "{}", case.name);
            checked += 1;
        }
        assert_eq!(checked, 18);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_nonexistent_feedback() {
        let dir = std::env::temp_dir().join(format!("mailvault-test-learning-load-{}", uuid::Uuid::new_v4()));
        let feedback = load_feedback(&dir, "nonexistent");
        assert!(feedback.rules.is_empty());
        assert!(feedback.corrections.is_empty());
    }

    #[test]
    fn test_save_and_load_feedback() {
        let dir = std::env::temp_dir().join(format!("mailvault-test-learning-save-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);

        let feedback = Feedback {
            rules: vec![serde_json::json!({"id": "r1", "pattern": {"fromDomain": "test.com"}})],
            corrections: vec![serde_json::json!({"messageId": "<m@t>", "correctedCategory": "work"})],
            stats: FeedbackStats { total_classified: 100, total_corrected: 5, accuracy_rate: 0.95 },
        };

        save_feedback(&dir, "acc1", &feedback).unwrap();

        let loaded = load_feedback(&dir, "acc1");
        assert_eq!(loaded.rules.len(), 1);
        assert_eq!(loaded.corrections.len(), 1);
        assert_eq!(loaded.stats.total_classified, 100);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_feedback_file_is_reported_not_silently_emptied() {
        let dir = std::env::temp_dir().join(format!("mailvault-test-learning-corrupt-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("ai-feedback")).unwrap();
        fs::write(dir.join("ai-feedback").join("acc1.json"), "{not json").unwrap();

        let loaded = load_feedback(&dir, "acc1");

        assert!(loaded.rules.is_empty(), "a torn file still reads as the default");
        assert!(loaded.corrections.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
