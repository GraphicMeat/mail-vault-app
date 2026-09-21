//! Custom field RPCs: the schema a person adds to their own mail, and the
//! values they give it.
//!
//! Nothing here touches the `.eml` or the server. Values are keyed by
//! `app_db::identity::msg_key`, like tags, so they survive a move.
use crate::handlers::common::{blocking, done, MessageRef};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::app_db::{self, fields};
use serde_json::Value;
use std::sync::Arc;

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn arg(params: &Value, name: &str) -> Result<String, String> {
    params.get(name).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("Missing {name}"))
}

fn items(params: &Value) -> Result<Vec<MessageRef>, String> {
    serde_json::from_value(params.get("items").cloned().unwrap_or(Value::Null)).map_err(|e| format!("items: {e}"))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("fields.") {
        return None;
    }
    let app_dir = state.app_dir.clone();
    let params = params.clone();
    let method = method.to_string();
    Some(done(id, blocking(move || run(&app_dir, &method, &params)).await.and_then(|r| r)))
}

fn run(app_dir: &std::path::Path, method: &str, params: &Value) -> Result<Value, String> {
    app_db::with(app_dir, |conn| match method {
        "fields.list" => json_of(fields::list(conn, &arg(params, "accountId")?)?),
        "fields.save" => {
            let field: fields::Field = serde_json::from_value(params.get("field").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("field: {e}"))?;
            json_of(fields::save(conn, &field)?)
        }
        "fields.delete" => {
            let dropped = fields::delete(conn, &arg(params, "id")?)?;
            Ok(serde_json::json!({ "droppedValues": dropped }))
        }
        "fields.copy" => {
            let ids: Vec<String> = serde_json::from_value(params.get("fieldIds").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("fieldIds: {e}"))?;
            json_of(fields::copy_to_account(conn, &ids, &arg(params, "accountId")?)?)
        }
        // One entry per requested row, in request order: the app matches them
        // up by position rather than deriving a key of its own.
        "fields.values" => {
            let items = items(params)?;
            let mut per_account: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            let keys: Vec<(String, String)> = items.iter().map(|item| (item.account_id.clone(), item.msg_key())).collect();
            for (account_id, msg_key) in &keys {
                per_account.entry(account_id.clone()).or_default().push(msg_key.clone());
            }
            let mut found: std::collections::HashMap<(String, String), Value> = std::collections::HashMap::new();
            for (account_id, msg_keys) in per_account {
                for (msg_key, values) in fields::values_for(conn, &account_id, &msg_keys)? {
                    found.insert((account_id.clone(), msg_key), json_of(values)?);
                }
            }
            let rows: Vec<Value> = keys
                .iter()
                .map(|key| found.get(key).cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new())))
                .collect();
            Ok(serde_json::json!({ "values": rows }))
        }
        "fields.set" => {
            let item: MessageRef = serde_json::from_value(params.get("item").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("item: {e}"))?;
            // An explicit null clears the value; a payload with no `value` at
            // all is a caller bug, and silently forgetting the answer is the
            // worst possible reading of it.
            let value = params.get("value").ok_or("Missing value (send null to clear)")?;
            fields::set_value(conn, &item.account_id, &item.msg_key(), &arg(params, "fieldId")?, Some(value))
                .map(|_| Value::Null)
        }
        _ => Err(format!("Unknown method: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-fields-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    async fn priority(s: &Arc<DaemonState>, scope: &str) -> String {
        call(s, "fields.save", json!({"field": {
            "id": format!("f-{scope}"), "scope": scope, "name": "Priority", "kind": "select",
            "options": [{"id": "hi", "label": "High"}, {"id": "lo", "label": "Low"}]
        }}))
        .await["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn item(uid: u32, message_id: &str) -> Value {
        json!({"accountId": "a", "mailbox": "INBOX", "uid": uid, "messageId": message_id})
    }

    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "fields.list", json!({"accountId": "a"})).await;
        assert!(resp.result.is_some(), "fields.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn a_value_set_on_a_row_comes_back_for_that_row() {
        let s = st();
        let field = priority(&s, "a").await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": "hi"})).await;
        let got = call(&s, "fields.values", json!({"items": [item(7, "<one@x.test>"), item(8, "<two@x.test>")]})).await;
        assert_eq!(got["values"][0][&field], "hi");
        assert_eq!(got["values"][1], json!({}), "one entry per row, in order");
    }

    #[tokio::test]
    async fn a_value_follows_the_message_into_another_folder() {
        let s = st();
        let field = priority(&s, "a").await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": "hi"})).await;
        let moved = json!({"accountId": "a", "mailbox": "Archive", "uid": 4102, "messageId": "<one@x.test>"});
        let got = call(&s, "fields.values", json!({"items": [moved]})).await;
        assert_eq!(got["values"][0][&field], "hi");
    }

    #[tokio::test]
    async fn clearing_a_value_removes_it_rather_than_storing_nothing() {
        let s = st();
        let field = priority(&s, "a").await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": "hi"})).await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": null})).await;
        let got = call(&s, "fields.values", json!({"items": [item(7, "<one@x.test>")]})).await;
        assert_eq!(got["values"][0], json!({}));
    }

    #[tokio::test]
    async fn an_account_lists_the_global_fields_beside_its_own() {
        let s = st();
        priority(&s, "a").await;
        call(&s, "fields.save", json!({"field": {"id": "g1", "scope": "*", "name": "Owner", "kind": "text"}})).await;
        let listed = call(&s, "fields.list", json!({"accountId": "a"})).await;
        let names: Vec<&str> = listed.as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["Owner", "Priority"]);
        let other = call(&s, "fields.list", json!({"accountId": "b"})).await;
        assert_eq!(other.as_array().unwrap().len(), 1, "only the global one");
    }

    #[tokio::test]
    async fn a_schema_can_be_copied_to_another_account_without_its_answers() {
        let s = st();
        let field = priority(&s, "a").await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": "hi"})).await;
        let copied = call(&s, "fields.copy", json!({"fieldIds": [field], "accountId": "b"})).await;
        assert_eq!(copied.as_array().unwrap().len(), 1);
        assert_eq!(copied[0]["name"], "Priority");
        assert_eq!(copied[0]["options"].as_array().unwrap().len(), 2);
        let moved = json!({"accountId": "b", "mailbox": "INBOX", "uid": 7, "messageId": "<one@x.test>"});
        let got = call(&s, "fields.values", json!({"items": [moved]})).await;
        assert_eq!(got["values"][0], json!({}), "the schema travels, the answers do not");
    }

    #[tokio::test]
    async fn deleting_a_field_says_how_many_answers_went_with_it() {
        let s = st();
        let field = priority(&s, "a").await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": "hi"})).await;
        call(&s, "fields.set", json!({"item": item(8, "<two@x.test>"), "fieldId": field, "value": "lo"})).await;
        let out = call(&s, "fields.delete", json!({"id": field})).await;
        assert_eq!(out["droppedValues"], 2);
        assert!(call(&s, "fields.list", json!({"accountId": "a"})).await.as_array().unwrap().is_empty());
    }

    /// Forgetting an answer must be asked for, never inferred from a payload
    /// that lost a key on the way.
    #[tokio::test]
    async fn a_set_with_no_value_at_all_is_refused_rather_than_clearing() {
        let s = st();
        let field = priority(&s, "a").await;
        call(&s, "fields.set", json!({"item": item(7, "<one@x.test>"), "fieldId": field, "value": "hi"})).await;
        let resp = route(&s, "fields.set", &json!({"item": item(7, "<one@x.test>"), "fieldId": field}), json!(1))
            .await
            .expect("routed");
        assert!(resp.result.is_none());
        let got = call(&s, "fields.values", json!({"items": [item(7, "<one@x.test>")]})).await;
        assert_eq!(got["values"][0][&field], "hi", "the answer is still there");
    }

    #[tokio::test]
    async fn a_field_of_an_unknown_kind_is_refused_with_a_reason() {
        let s = st();
        let resp = route(
            &s,
            "fields.save",
            &json!({"field": {"id": "f1", "scope": "a", "name": "Stars", "kind": "rating"}}),
            json!(1),
        )
        .await
        .expect("routed");
        assert!(resp.result.is_none());
        assert!(format!("{:?}", resp.error).contains("rating"), "{:?}", resp.error);
    }
}
