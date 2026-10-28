//! Pure native refresh selection and scheduling decisions.

use serde_json::Value;

pub const DEFAULT_INTERVAL_MINUTES: u64 = 5;

/// Keep the persisted order while ignoring retired and hidden rows.
pub fn visible_account_ids(rows: &[Value], authoritative: &std::collections::BTreeSet<String>,
    settings: &Value) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    rows.iter().filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| authoritative.contains(*id) && seen.insert((*id).to_owned()))
        .filter(|id| settings["hiddenAccounts"][*id] != true)
        .map(str::to_owned).collect()
}

pub fn interval_ms(settings: &Value) -> Option<u64> {
    if settings.get("refreshInterval").and_then(Value::as_i64).is_some_and(|value| value < 0) {
        return None;
    }
    let minutes = settings.get("refreshInterval").and_then(Value::as_u64)
        .unwrap_or(DEFAULT_INTERVAL_MINUTES);
    (minutes > 0).then(|| minutes.saturating_mul(60_000))
}

pub fn refresh_on_launch(settings: &Value) -> bool {
    settings.get("refreshOnLaunch").and_then(Value::as_bool).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refresh_policy_keeps_authoritative_order_and_excludes_hidden_rows() {
        let rows = vec![
            json!({"id":"hidden"}), json!({"id":"b"}), json!({"id":"retired"}),
            json!({"id":"a"}), json!({"id":"b"}),
        ];
        let authoritative = ["hidden", "b", "a"].into_iter().map(str::to_owned).collect();
        assert_eq!(visible_account_ids(&rows, &authoritative,
            &json!({"hiddenAccounts":{"hidden":true}})), vec!["b", "a"]);
    }

    #[test]
    fn refresh_policy_interval_and_launch_defaults_follow_native_settings() {
        assert_eq!(interval_ms(&json!({})), Some(300_000));
        assert_eq!(interval_ms(&json!({"refreshInterval":0})), None);
        assert_eq!(interval_ms(&json!({"refreshInterval":7})), Some(420_000));
        assert!(refresh_on_launch(&json!({})));
        assert!(!refresh_on_launch(&json!({"refreshOnLaunch":false})));
    }

    #[test]
    fn refresh_policy_negative_interval_disables_native_ticks() {
        assert_eq!(interval_ms(&json!({"refreshInterval":-1})), None,
            "negative interval must disable native scheduling");
        assert_eq!(interval_ms(&json!({"refreshInterval":-15})), None,
            "all negative persisted intervals must disable native scheduling");
    }
}
