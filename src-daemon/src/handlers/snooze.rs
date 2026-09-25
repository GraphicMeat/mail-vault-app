//! Snooze RPCs. The queue lives in `app.db` (`mailvault_core::app_db::snooze`).
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let _ = (state, method, params, id);
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-snooze-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    fn create_params() -> Value {
        json!({
            "accountId": "acc1",
            "mailbox": "INBOX",
            "snoozedMailbox": "Snoozed",
            "uid": 42,
            "messageId": "<m@x>",
            "wakeAt": 9_999_999_999_999i64,
        })
    }

    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "snooze.list", json!({})).await;
        assert!(resp.result.is_some(), "snooze.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn create_records_a_snoozed_row_that_list_returns() {
        let s = st();
        let row = call(&s, "snooze.create", create_params()).await;
        assert_eq!(row["state"], json!("snoozed"));
        assert_eq!(row["fromMailbox"], json!("INBOX"));
        assert_eq!(row["snoozedMailbox"], json!("Snoozed"));
        assert_eq!(row["uidInSnoozed"], json!(42));
        assert_eq!(row["messageId"], json!("<m@x>"));
        let listed = call(&s, "snooze.list", json!({"accountId": "acc1"})).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], row["id"]);
        assert_eq!(call(&s, "snooze.list", json!({"accountId": "other"})).await, json!([]));
    }

    /// Without a Message-ID the wake has no way to find the message again
    /// once its uid changes, so the row is refused rather than stranded.
    #[tokio::test]
    async fn create_refuses_a_message_without_a_message_id() {
        let s = st();
        let mut params = create_params();
        params["messageId"] = json!("  ");
        let resp = route(&s, "snooze.create", &params, json!(1)).await.expect("routed");
        assert!(resp.error.is_some(), "an empty Message-ID must be refused");
        assert_eq!(call(&s, "snooze.list", json!({})).await, json!([]));
    }

    #[tokio::test]
    async fn create_accepts_a_server_that_gave_no_uid() {
        let s = st();
        let mut params = create_params();
        params["uid"] = Value::Null;
        let row = call(&s, "snooze.create", params).await;
        assert_eq!(row["uidInSnoozed"], Value::Null);
    }

    #[tokio::test]
    async fn reschedule_moves_the_wake_time() {
        let s = st();
        let row = call(&s, "snooze.create", create_params()).await;
        let updated = call(&s, "snooze.reschedule", json!({"id": row["id"], "wakeAt": 123_456})).await;
        assert_eq!(updated["wakeAt"], json!(123_456));
        assert_eq!(updated["state"], json!("snoozed"));
    }

    #[tokio::test]
    async fn cancel_of_an_unknown_row_is_an_error() {
        let s = st();
        let resp = route(&s, "snooze.cancel", &json!({"id": "nope"}), json!(1)).await.expect("routed");
        assert!(resp.error.is_some());
    }
}
