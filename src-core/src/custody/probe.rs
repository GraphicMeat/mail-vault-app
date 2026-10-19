//! "Is the server copy gone?": what the every-folder Message-ID sweep may
//! write into a message's custody entry. The sweep itself is the daemon's
//! (`custody.probe_server_copy`); the rules for its answer live here.
//!
//! The gold "your only copy" row makes the loudest claim the app makes, so
//! only one answer is written down as absence: every selectable folder
//! answered and none holds the Message-ID. A copy found anywhere tears up an
//! earlier absence stamp. Anything else (a folder that would not open, no
//! Message-ID, a sweep that errored) is unknown and writes nothing.

use serde_json::{json, Map, Value};

/// A non-empty string field, as a JS truthiness test reads one.
fn truthy<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The Message-ID to sweep for: the custody entry's (it outlives the row in
/// memory), else the one the app read off this message's own row.
pub fn message_id(entry: Option<&Value>, row_hint: Option<&str>) -> Option<String> {
    entry
        .and_then(|e| truthy(e, "message_id").or_else(|| truthy(e, "messageId")))
        .or(row_hint.filter(|s| !s.is_empty()))
        .map(str::to_string)
}

/// Whether the entry carries an absence stamp a found copy disproves.
pub fn stamped_absent(entry: Option<&Value>) -> bool {
    entry.and_then(|e| e.get("serverAbsent")) == Some(&Value::Bool(true))
}

/// The entry to write with `extra` merged in: the stored one, or, for a
/// message with no entry yet, the one the app built from its row (offered
/// only for a message the vault holds). `None` when there is nothing to
/// stamp: no claim is made about a message the vault does not hold.
pub fn stamp(current: Option<&Value>, fallback: Option<&Value>, uid: u32, extra: &Value) -> Option<Value> {
    let mut out: Map<String, Value> = current.or(fallback)?.as_object()?.clone();
    if current.is_none() {
        out.insert("uid".into(), json!(uid));
    }
    for (k, v) in extra.as_object().into_iter().flatten() {
        out.insert(k.clone(), v.clone());
    }
    Some(Value::Object(out))
}

/// The fields a completed sweep that found nothing stamps.
pub fn absent_fields(checked_at: &str) -> Value {
    json!({"serverAbsent": true, "serverAbsentAt": checked_at})
}

/// The fields a found copy stamps over an earlier absence.
pub fn present_fields() -> Value {
    json!({"serverAbsent": false, "serverAbsentAt": null})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_id_comes_from_the_entry_before_the_row() {
        let entry = json!({"uid": 7, "message_id": "<kept@x.test>"});
        assert_eq!(message_id(Some(&entry), Some("<row@x.test>")).as_deref(), Some("<kept@x.test>"));
        let camel = json!({"uid": 7, "messageId": "<camel@x.test>"});
        assert_eq!(message_id(Some(&camel), None).as_deref(), Some("<camel@x.test>"));
        let empty = json!({"uid": 7, "message_id": null});
        assert_eq!(message_id(Some(&empty), Some("<row@x.test>")).as_deref(), Some("<row@x.test>"));
        assert_eq!(message_id(Some(&empty), None), None);
        assert_eq!(message_id(None, Some("")), None);
        assert_eq!(message_id(Some(&json!({"message_id": ""})), None), None);
    }

    #[test]
    fn only_a_true_absence_stamp_counts() {
        assert!(stamped_absent(Some(&json!({"serverAbsent": true}))));
        assert!(!stamped_absent(Some(&json!({"serverAbsent": false}))));
        assert!(!stamped_absent(Some(&json!({"serverAbsent": "true"}))));
        assert!(!stamped_absent(Some(&json!({}))));
        assert!(!stamped_absent(None));
    }

    #[test]
    fn a_stamp_merges_into_the_stored_entry_and_keeps_every_other_field() {
        let entry = json!({"uid": 7, "subject": "Aruodas", "serverDeleted": false, "custom": [1, 2]});
        let out = stamp(Some(&entry), None, 7, &absent_fields("2026-10-19T00:00:00.000Z")).unwrap();
        assert_eq!(out, json!({"uid": 7, "subject": "Aruodas", "serverDeleted": false, "custom": [1, 2], "serverAbsent": true, "serverAbsentAt": "2026-10-19T00:00:00.000Z"}));
        let cleared = stamp(Some(&out), None, 7, &present_fields()).unwrap();
        assert_eq!(cleared["serverAbsent"], json!(false));
        assert_eq!(cleared["serverAbsentAt"], Value::Null);
        assert_eq!(cleared["custom"], json!([1, 2]));
    }

    #[test]
    fn a_stored_entry_wins_over_the_rows_fallback() {
        let entry = json!({"uid": 7, "subject": "stored"});
        let row = json!({"uid": 7, "subject": "row"});
        assert_eq!(stamp(Some(&entry), Some(&row), 7, &present_fields()).unwrap()["subject"], "stored");
    }

    #[test]
    fn with_no_entry_the_rows_fallback_is_written_under_the_asked_uid() {
        let row = json!({"uid": 9, "subject": "row", "source": "local"});
        let out = stamp(None, Some(&row), 7, &absent_fields("t")).unwrap();
        assert_eq!(out["uid"], json!(7));
        assert_eq!(out["subject"], "row");
        assert_eq!(out["serverAbsent"], json!(true));
    }

    #[test]
    fn no_entry_and_no_vault_copy_is_nothing_to_stamp() {
        assert_eq!(stamp(None, None, 7, &absent_fields("t")), None);
        assert_eq!(stamp(None, Some(&json!("not an object")), 7, &absent_fields("t")), None);
    }
}
