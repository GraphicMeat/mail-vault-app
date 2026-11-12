//! JavaScript truthiness of a JSON value, defined once.
//!
//! The ports of the app's settings and row logic test `if (x)` on values the
//! app wrote with any shape: `null`, `false`, `0` and `""` are false, an absent
//! key is false, everything else (including `"0"`, `[]` and `{}`) is true.
//! A JSON number is never NaN, so the NaN test some copies carried was dead.

use serde_json::Value;

/// `Boolean(v)` for a value that may be absent.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `Boolean(v)` for a value that is present.
pub fn truthy_value(v: &Value) -> bool {
    truthy(Some(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every input form the copies this replaced were exercised with.
    #[test]
    fn matches_javascript_truthiness() {
        let falsy = [json!(null), json!(false), json!(0), json!(0.0), json!(-0.0), json!("")];
        for v in &falsy {
            assert!(!truthy(Some(v)), "{v} is falsy");
            assert!(!truthy_value(v), "{v} is falsy");
        }
        let truthy_values = [
            json!(true), json!(1), json!(-1), json!(0.5), json!("0"), json!("false"), json!(" "),
            json!([]), json!({}), json!([0]), json!({"a": null}),
        ];
        for v in &truthy_values {
            assert!(truthy(Some(v)), "{v} is truthy");
            assert!(truthy_value(v), "{v} is truthy");
        }
        assert!(!truthy(None), "an absent key is falsy");
    }

    #[test]
    fn a_big_integer_is_truthy() {
        assert!(truthy(Some(&json!(u64::MAX))));
        assert!(truthy(Some(&json!(i64::MIN))));
    }
}
