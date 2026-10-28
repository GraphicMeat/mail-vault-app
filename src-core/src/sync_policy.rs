//! Pure decisions for a cached mailbox probe and a closed-folder STATUS sweep.

use serde::Deserialize;
use serde_json::Value;

pub const PROBE_TTL_MS: i64 = 10_000;
pub const FOLDER_TTL_MS: i64 = 60_000;
pub const MAX_STATUS_FOLDERS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeDecision {
    pub unchanged: bool,
    pub reason: &'static str,
}

impl ProbeDecision {
    pub const fn new(unchanged: bool, reason: &'static str) -> Self {
        Self { unchanged, reason }
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => if *value { 1.0 } else { 0.0 },
        Some(Value::Number(value)) => value.as_f64().unwrap_or(f64::NAN),
        Some(value @ (Value::String(_) | Value::Array(_) | Value::Object(_))) => {
            let text = js_string(value);
            let text = text.trim();
            if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
        }
    }
}

fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// The cache preflight used before provider IO. A metadata read error is
/// reported by the caller because it has no metadata value to pass here.
pub fn cache_preflight(meta: Option<&Value>) -> Option<ProbeDecision> {
    let total = meta.and_then(|meta| meta.get("totalEmails"));
    if !truthy(total) {
        return Some(ProbeDecision::new(false, "no-cache"));
    }
    let cached = meta.and_then(|meta| non_null(meta.get("totalCached")));
    let zero = Value::from(0);
    let cached = cached.unwrap_or(&zero);
    let total = total.expect("truthy total exists");
    let short = match (cached, total) {
        (Value::String(a), Value::String(b)) => a < b,
        _ => js_number(Some(cached)) < js_number(Some(total)),
    };
    short.then_some(ProbeDecision::new(false, "partial-cache"))
}

/// The ordered decision after a nonempty provider status has arrived.
pub fn probe_decision(meta: &Value, status: &Value) -> ProbeDecision {
    let meta_validity = non_null(meta.get("uidValidity"));
    let status_validity = non_null(status.get("uidValidity"));
    if let (Some(a), Some(b)) = (status_validity, meta_validity) {
        if !strict_equal(a, b) {
            return ProbeDecision::new(false, "uidvalidity-changed");
        }
    }

    let meta_modseq = non_null(meta.get("highestModseq"));
    let status_modseq = non_null(status.get("highestModseq"));
    if let (Some(a), Some(b)) = (status_modseq, meta_modseq) {
        return if strict_equal(a, b) {
            ProbeDecision::new(true, "modseq-match")
        } else {
            ProbeDecision::new(false, "modseq-advanced")
        };
    }

    let same_uid_next = match (non_null(status.get("uidNext")), non_null(meta.get("uidNext"))) {
        (Some(a), Some(b)) => strict_equal(a, b),
        _ => false,
    };
    let same_exists = js_number(status.get("exists")) == js_number(meta.get("totalEmails"));
    if same_uid_next && same_exists {
        ProbeDecision::new(true, "uidnext-exists-match")
    } else if !same_uid_next {
        ProbeDecision::new(false, "uidnext-advanced")
    } else {
        ProbeDecision::new(false, "exists-changed")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailboxNode {
    pub path: String,
    #[serde(default)]
    pub noselect: bool,
    #[serde(default)]
    pub children: Vec<MailboxNode>,
}

/// Preorder through the displayed tree, visiting children of a nonselect
/// parent and excluding the open path before applying the fifty-path cap.
pub fn select_status_paths(nodes: &[MailboxNode], active: Option<&str>) -> Vec<String> {
    let mut selected = Vec::new();
    let mut stack: Vec<&MailboxNode> = nodes.iter().rev().collect();
    while let Some(node) = stack.pop() {
        if !node.noselect && Some(node.path.as_str()) != active {
            selected.push(node.path.clone());
            if selected.len() == MAX_STATUS_FOLDERS { break; }
        }
        stack.extend(node.children.iter().rev());
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn corpus() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/sync-observation-cases.json")).unwrap()
    }

    #[test]
    fn sync_policy_probe_decisions_match_the_frozen_js_export() {
        let mut compared = 0;
        let mut preflights = 0;
        for case in corpus()["probeCases"].as_array().unwrap() {
            for step in case["steps"].as_array().unwrap() {
                let input = &step["input"];
                if input["op"] != "check" { continue; }
                let expected = &step["observed"]["result"];
                let reason = expected["reason"].as_str().unwrap();
                if ["no-cache", "partial-cache"].contains(&reason) {
                    let actual = cache_preflight(input.get("meta"));
                    assert_eq!(actual.map(|decision| json!({
                        "unchanged": decision.unchanged, "reason": decision.reason,
                    })), Some(expected.clone()), "{}", case["name"]);
                    preflights += 1;
                }
                if !["uidvalidity-changed", "modseq-match", "modseq-advanced",
                    "uidnext-exists-match", "uidnext-advanced", "exists-changed"].contains(&reason) {
                    continue;
                }
                let actual = probe_decision(&input["meta"], &input["status"]);
                assert_eq!(json!({"unchanged": actual.unchanged, "reason": actual.reason}), *expected,
                    "{}", case["name"]);
                compared += 1;
            }
        }
        assert!(compared >= 17, "corpus must exercise ordered provider decisions");
        assert!(preflights >= 4, "corpus must exercise cache preflight boundaries");
    }

    #[test]
    fn sync_policy_folder_paths_match_the_frozen_js_provider_calls() {
        let mut compared = 0;
        for case in corpus()["folderCases"].as_array().unwrap() {
            for step in case["steps"].as_array().unwrap() {
                let input = &step["input"];
                if input["op"] != "refresh" { continue; }
                let Some(call) = step["observed"]["providerCalls"].as_array().and_then(|calls| calls.first()) else {
                    continue;
                };
                let nodes: Vec<MailboxNode> = serde_json::from_value(input["mailboxes"].clone()).unwrap();
                let active = input["activeMailbox"].as_str();
                let actual = select_status_paths(&nodes, active);
                assert_eq!(json!(actual), call["paths"], "{}", case["name"]);
                compared += 1;
            }
        }
        assert!(compared >= 8, "corpus must exercise multiple actual sweeps");
    }
}
