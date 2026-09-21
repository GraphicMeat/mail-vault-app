//! Custom metadata fields: the columns a person adds to their own mail.
//!
//! A field is a definition (name, kind, options) plus a value per message. Both
//! live here, never in the `.eml` and never on a server: MailVault writes
//! nothing back to the message, so a field works the same on every provider and
//! disappears from nobody else's copy.
//!
//! A field belongs to one account, or to every account when its scope is `*`.
//! Values are always per account, because the same message in two accounts is
//! two messages to the person reading it.

use super::db::in_txn;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::collections::HashMap;

/// Every account's fields, not just one's.
pub const GLOBAL: &str = "*";

pub const KINDS: [&str; 5] = ["select", "multi_select", "date", "checkbox", "text"];

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    /// An account id, or [`GLOBAL`].
    pub scope: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub options: Vec<FieldOption>,
    #[serde(default)]
    pub position: i64,
}

/// How a saved view narrows on a field.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldFilter {
    pub field_id: String,
    /// `is`, `isNot`, `isSet`, `isEmpty`, `before`, `after`.
    pub op: String,
    #[serde(default)]
    pub value: serde_json::Value,
}

/// The fields this account can use: the global ones first, then its own.
pub fn list(conn: &Connection, account_id: &str) -> Result<Vec<Field>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, name, kind, options_json, position FROM fields
             WHERE scope = ?1 OR scope = ?2
             ORDER BY scope = ?2, position, name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![GLOBAL, account_id], row_to_field).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn save(conn: &Connection, field: &Field) -> Result<Field, String> {
    let name = field.name.trim();
    if name.is_empty() {
        return Err("a field needs a name".into());
    }
    if !KINDS.contains(&field.kind.as_str()) {
        return Err(format!("unknown field kind: {}", field.kind));
    }
    in_txn(conn, || {
        // One scope cannot hold two fields of one name, whatever the case.
        let clash: Option<String> = conn
            .query_row(
                "SELECT id FROM fields WHERE scope = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3",
                params![field.scope, name, field.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if clash.is_some() {
            return Err(format!("{} already has a field called {name}", field.scope));
        }
        let existing: Option<i64> = conn
            .query_row("SELECT position FROM fields WHERE id = ?1", [&field.id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let position = match existing {
            Some(position) => position,
            None => conn
                .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM fields WHERE scope = ?1", [&field.scope], |r| r.get(0))
                .map_err(|e| e.to_string())?,
        };
        let options_json = serde_json::to_string(&field.options).map_err(|e| e.to_string())?;
        // An UPDATE, never `INSERT OR REPLACE`: this store enforces foreign
        // keys, and REPLACE deletes the row before re-inserting it, so every
        // value of the field would cascade away. Editing a field must not be
        // a way to lose what people wrote in it.
        let changed = conn
            .execute(
                "UPDATE fields SET scope = ?2, name = ?3, kind = ?4, options_json = ?5, position = ?6 WHERE id = ?1",
                params![field.id, field.scope, name, field.kind, options_json, position],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            conn.execute(
                "INSERT INTO fields(id, scope, name, kind, options_json, position) VALUES (?1,?2,?3,?4,?5,?6)",
                params![field.id, field.scope, name, field.kind, options_json, position],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(Field { name: name.to_string(), position, ..field.clone() })
    })
}

/// Delete the field and every value anyone gave it. Returns how many values went.
pub fn delete(conn: &Connection, id: &str) -> Result<usize, String> {
    in_txn(conn, || {
        let dropped = conn.execute("DELETE FROM field_values WHERE field_id = ?1", [id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM fields WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(dropped)
    })
}

/// Copy these field definitions into another account's schema. Values are not
/// copied: the schema is what is being shared, not one account's answers. A
/// name the account already uses is left alone rather than duplicated.
pub fn copy_to_account(conn: &Connection, field_ids: &[String], account_id: &str) -> Result<Vec<Field>, String> {
    let mut copied = Vec::new();
    in_txn(conn, || {
        for id in field_ids {
            let Some(source) = get(conn, id)? else { continue };
            let taken: Option<String> = conn
                .query_row(
                    "SELECT id FROM fields WHERE scope = ?1 AND name = ?2 COLLATE NOCASE",
                    params![account_id, source.name],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if taken.is_some() {
                continue;
            }
            let copy = Field {
                id: uuid::Uuid::new_v4().to_string(),
                scope: account_id.to_string(),
                ..source
            };
            copied.push(save(conn, &copy)?);
        }
        Ok(())
    })?;
    Ok(copied)
}

/// Values per message, for one page of rows: `msg_key -> field_id -> value`.
pub fn values_for(
    conn: &Connection,
    account_id: &str,
    msg_keys: &[String],
) -> Result<HashMap<String, HashMap<String, serde_json::Value>>, String> {
    let mut out: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    // Chunked: SQLite stops at 999 parameters and a list page asks for all of
    // its rows at once.
    for chunk in msg_keys.chunks(800) {
        let places = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT msg_key, field_id, value_json FROM field_values
             WHERE account_id = ?1 AND msg_key IN ({places})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let args = std::iter::once(account_id.to_string()).chain(chunk.iter().cloned());
        let rows = stmt
            .query_map(params_from_iter(args), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (key, field_id, value_json) = row.map_err(|e| e.to_string())?;
            let value = serde_json::from_str(&value_json).unwrap_or(serde_json::Value::Null);
            out.entry(key).or_default().insert(field_id, value);
        }
    }
    Ok(out)
}

/// Set one value, or clear it with `None`.
pub fn set_value(
    conn: &Connection,
    account_id: &str,
    msg_key: &str,
    field_id: &str,
    value: Option<&serde_json::Value>,
) -> Result<(), String> {
    // A cleared value is a deleted row, not a stored null: "no answer" and
    // "answered nothing" would otherwise read the same to every filter.
    let Some(value) = value.filter(|v| !v.is_null()) else {
        conn.execute(
            "DELETE FROM field_values WHERE field_id = ?1 AND account_id = ?2 AND msg_key = ?3",
            params![field_id, account_id, msg_key],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())?;
        return Ok(());
    };
    let value_json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO field_values(field_id, account_id, msg_key, value_json, at) VALUES (?1,?2,?3,?4,?5)",
        params![field_id, account_id, msg_key, value_json, now()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The identities matching one field filter, for a saved view.
pub fn messages_matching(conn: &Connection, account_id: &str, filter: &FieldFilter) -> Result<Vec<String>, String> {
    let json = serde_json::to_string(&filter.value).map_err(|e| e.to_string())?;
    let text = filter.value.as_str().unwrap_or("").to_string();
    let (clause, args): (&str, Vec<String>) = match filter.op.as_str() {
        // `is` covers both a single value and one entry of a multi-select: the
        // stored JSON is either the value itself or an array holding it.
        "is" => ("(value_json = ?3 OR instr(value_json, ?4) > 0)", vec![json.clone(), format!("[\"{text}\"")]),
        "isNot" => ("(value_json <> ?3 AND instr(value_json, ?4) = 0)", vec![json.clone(), format!("[\"{text}\"")]),
        "isSet" => ("1", Vec::new()),
        "isEmpty" => return messages_without(conn, account_id, &filter.field_id),
        // Dates are stored as `YYYY-MM-DD`, which sorts as text.
        "before" => ("value_json < ?3", vec![json.clone()]),
        "after" => ("value_json > ?3", vec![json.clone()]),
        other => return Err(format!("unknown field filter: {other}")),
    };
    let sql =
        format!("SELECT msg_key FROM field_values WHERE field_id = ?1 AND account_id = ?2 AND {clause} ORDER BY msg_key");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let bound = vec![filter.field_id.clone(), account_id.to_string()].into_iter().chain(args);
    let rows = stmt.query_map(params_from_iter(bound), |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Messages this account has given no value for. Only the ones it knows about:
/// "every message without a value" is the whole mailbox, which is the index's
/// answer to give, not this store's.
fn messages_without(conn: &Connection, account_id: &str, field_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT msg_key FROM field_values WHERE account_id = ?1
             AND msg_key NOT IN (SELECT msg_key FROM field_values WHERE account_id = ?1 AND field_id = ?2)
             ORDER BY msg_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![account_id, field_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn get(conn: &Connection, id: &str) -> Result<Option<Field>, String> {
    conn.query_row("SELECT id, scope, name, kind, options_json, position FROM fields WHERE id = ?1", [id], row_to_field)
        .optional()
        .map_err(|e| e.to_string())
}

fn row_to_field(r: &rusqlite::Row<'_>) -> rusqlite::Result<Field> {
    let options_json: String = r.get(4)?;
    Ok(Field {
        id: r.get(0)?,
        scope: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        options: serde_json::from_str(&options_json).unwrap_or_default(),
        position: r.get(5)?,
    })
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;
    use serde_json::json;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-fields-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn field(id: &str, scope: &str, name: &str, kind: &str) -> Field {
        Field {
            id: id.into(),
            scope: scope.into(),
            name: name.into(),
            kind: kind.into(),
            options: vec![
                FieldOption { id: "hi".into(), label: "High".into(), color: "#f00".into() },
                FieldOption { id: "lo".into(), label: "Low".into(), color: String::new() },
            ],
            position: 0,
        }
    }

    #[test]
    fn an_account_sees_its_own_fields_and_the_global_ones() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        save(&c, &field("f2", "home", "Chore", "checkbox")).unwrap();
        save(&c, &field("f3", GLOBAL, "Owner", "text")).unwrap();
        let names: Vec<String> = list(&c, "work").unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["Owner".to_string(), "Priority".to_string()], "global first, then the account's");
    }

    #[test]
    fn two_accounts_may_both_have_a_field_called_priority() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        save(&c, &field("f2", "home", "Priority", "select")).unwrap();
        assert_eq!(list(&c, "work").unwrap().len(), 1);
        assert_eq!(list(&c, "home").unwrap().len(), 1);
    }

    #[test]
    fn one_account_cannot_have_the_same_field_name_twice() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        assert!(save(&c, &field("f2", "work", "priority", "select")).is_err(), "case does not make it a new field");
    }

    #[test]
    fn a_field_of_an_unknown_kind_is_refused() {
        let c = conn();
        assert!(save(&c, &field("f1", "work", "Priority", "rating")).is_err());
    }

    #[test]
    fn a_value_round_trips_and_can_be_cleared() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        set_value(&c, "work", "msg@x", "f1", Some(&json!("hi"))).unwrap();
        let got = values_for(&c, "work", &["msg@x".into()]).unwrap();
        assert_eq!(got["msg@x"]["f1"], json!("hi"));
        set_value(&c, "work", "msg@x", "f1", None).unwrap();
        assert!(values_for(&c, "work", &["msg@x".into()]).unwrap().is_empty());
    }

    #[test]
    fn the_same_message_in_two_accounts_holds_two_values() {
        let c = conn();
        save(&c, &field("f1", GLOBAL, "Owner", "text")).unwrap();
        set_value(&c, "work", "msg@x", "f1", Some(&json!("Ann"))).unwrap();
        set_value(&c, "home", "msg@x", "f1", Some(&json!("Bo"))).unwrap();
        assert_eq!(values_for(&c, "work", &["msg@x".into()]).unwrap()["msg@x"]["f1"], json!("Ann"));
        assert_eq!(values_for(&c, "home", &["msg@x".into()]).unwrap()["msg@x"]["f1"], json!("Bo"));
    }

    #[test]
    fn deleting_a_field_takes_every_value_of_it() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        set_value(&c, "work", "one@x", "f1", Some(&json!("hi"))).unwrap();
        set_value(&c, "work", "two@x", "f1", Some(&json!("lo"))).unwrap();
        assert_eq!(delete(&c, "f1").unwrap(), 2);
        assert!(list(&c, "work").unwrap().is_empty());
        assert!(values_for(&c, "work", &["one@x".into()]).unwrap().is_empty());
    }

    #[test]
    fn a_field_can_be_moved_to_every_account_and_keeps_its_values() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        set_value(&c, "work", "msg@x", "f1", Some(&json!("hi"))).unwrap();
        save(&c, &Field { scope: GLOBAL.into(), ..field("f1", "work", "Priority", "select") }).unwrap();
        assert_eq!(list(&c, "home").unwrap().len(), 1, "every account sees it now");
        let kept: i64 = c.query_row("SELECT COUNT(*) FROM field_values", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "editing a field must not cascade its values away");
        assert_eq!(values_for(&c, "work", &["msg@x".into()]).unwrap()["msg@x"]["f1"], json!("hi"));
    }

    #[test]
    fn copying_a_schema_brings_the_fields_but_not_the_answers() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        set_value(&c, "work", "msg@x", "f1", Some(&json!("hi"))).unwrap();
        let copied = copy_to_account(&c, &["f1".to_string()], "home").unwrap();
        assert_eq!(copied.len(), 1);
        assert_ne!(copied[0].id, "f1", "a copy is its own field");
        assert_eq!(copied[0].name, "Priority");
        assert_eq!(copied[0].options.len(), 2);
        assert!(values_for(&c, "home", &["msg@x".into()]).unwrap().is_empty());
    }

    #[test]
    fn copying_a_field_the_account_already_has_by_name_changes_nothing() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        save(&c, &field("f2", "home", "Priority", "select")).unwrap();
        assert!(copy_to_account(&c, &["f1".to_string()], "home").unwrap().is_empty());
        assert_eq!(list(&c, "home").unwrap().len(), 1);
    }

    #[test]
    fn a_view_can_ask_for_one_value() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        set_value(&c, "work", "one@x", "f1", Some(&json!("hi"))).unwrap();
        set_value(&c, "work", "two@x", "f1", Some(&json!("lo"))).unwrap();
        let filter = FieldFilter { field_id: "f1".into(), op: "is".into(), value: json!("hi") };
        assert_eq!(messages_matching(&c, "work", &filter).unwrap(), vec!["one@x".to_string()]);
    }

    #[test]
    fn a_view_can_ask_which_messages_have_any_value_at_all() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        set_value(&c, "work", "one@x", "f1", Some(&json!("hi"))).unwrap();
        let filter = FieldFilter { field_id: "f1".into(), op: "isSet".into(), value: json!(null) };
        assert_eq!(messages_matching(&c, "work", &filter).unwrap(), vec!["one@x".to_string()]);
    }

    #[test]
    fn a_multi_select_matches_on_any_one_of_its_values() {
        let c = conn();
        save(&c, &field("f1", "work", "Tags", "multi_select")).unwrap();
        set_value(&c, "work", "one@x", "f1", Some(&json!(["hi", "lo"]))).unwrap();
        set_value(&c, "work", "two@x", "f1", Some(&json!(["lo"]))).unwrap();
        let filter = FieldFilter { field_id: "f1".into(), op: "is".into(), value: json!("hi") };
        assert_eq!(messages_matching(&c, "work", &filter).unwrap(), vec!["one@x".to_string()]);
    }

    #[test]
    fn a_date_field_answers_before_and_after() {
        let c = conn();
        save(&c, &field("f1", "work", "Due", "date")).unwrap();
        set_value(&c, "work", "early@x", "f1", Some(&json!("2026-01-05"))).unwrap();
        set_value(&c, "work", "late@x", "f1", Some(&json!("2026-11-30"))).unwrap();
        let before = FieldFilter { field_id: "f1".into(), op: "before".into(), value: json!("2026-06-01") };
        let after = FieldFilter { field_id: "f1".into(), op: "after".into(), value: json!("2026-06-01") };
        assert_eq!(messages_matching(&c, "work", &before).unwrap(), vec!["early@x".to_string()]);
        assert_eq!(messages_matching(&c, "work", &after).unwrap(), vec!["late@x".to_string()]);
    }

    #[test]
    fn a_page_of_keys_does_not_blow_the_parameter_limit() {
        let c = conn();
        save(&c, &field("f1", "work", "Priority", "select")).unwrap();
        let keys: Vec<String> = (0..2500).map(|n| format!("k{n}@x")).collect();
        for key in &keys {
            set_value(&c, "work", key, "f1", Some(&json!("hi"))).unwrap();
        }
        assert_eq!(values_for(&c, "work", &keys).unwrap().len(), 2500);
    }
}
