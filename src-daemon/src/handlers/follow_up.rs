//! Follow-up reminder RPCs. The queue lives in `app.db`
//! (`mailvault_core::app_db::follow_up`); `follow_up_worker` checks for
//! replies.
//!
//! `follow_up.create` is called by the app once a send went out, keyed on the
//! Message-ID it built the message with. `follow_up.dismiss` is every way the
//! user can be done with a resurfaced row (delete, archive, move): it only
//! ends the row, the real Sent copy is never touched.
use crate::follow_up_worker;
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, u64_arg};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::app_db::{self, follow_up};
use serde_json::Value;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn get_row(state: &Arc<DaemonState>, row_id: &str) -> Result<follow_up::FollowUp, String> {
    app_db::with(&state.app_dir, |c| follow_up::get(c, row_id))?.ok_or_else(|| format!("No follow-up reminder {row_id}"))
}

/// Run `write` on one row and answer the row as it is afterwards.
async fn update_row(
    state: &Arc<DaemonState>,
    row_id: String,
    write: fn(&app_db::Connection, &str) -> Result<(), String>,
) -> Result<Value, String> {
    let st = Arc::clone(state);
    blocking(move || {
        app_db::with(&st.app_dir, |c| write(c, &row_id))?;
        json_of(get_row(&st, &row_id)?)
    })
    .await
    .and_then(|r| r)
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "follow_up.list" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || app_db::with(&state.app_dir, |c| json_of(follow_up::list(c, account_id.as_deref())?)))
                    .await
                    .and_then(|r| r),
            )
        }

        "follow_up.create" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let sent_at = req!(u64_arg(&id, params, "sentAt")) as i64;
            let remind_at = req!(u64_arg(&id, params, "remindAt")) as i64;
            let subject = opt_str_arg(params, "subject").unwrap_or_default();
            let recipients = opt_str_arg(params, "recipients").unwrap_or_default();
            let sent_mailbox = opt_str_arg(params, "sentMailbox").unwrap_or_default();
            if message_id.trim().is_empty() {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "A follow-up reminder needs a Message-ID".to_string()));
            }
            let st = Arc::clone(state);
            let created = blocking(move || {
                let message_id = message_id.trim();
                let row_id = uuid::Uuid::new_v4().to_string();
                app_db::with(&st.app_dir, |c| {
                    follow_up::insert(c, &row_id, &account_id, message_id, &subject, &recipients, &sent_mailbox, sent_at, remind_at)?;
                    // A retried send inserts nothing: the first row answers.
                    follow_up::get_by_message(c, &account_id, message_id)?.ok_or_else(|| "row vanished after insert".to_string())
                })
                .and_then(json_of)
            })
            .await
            .and_then(|r| r);
            state.follow_up.wake();
            done(id, created)
        }

        "follow_up.mark_seen" => {
            let row_id = req!(str_arg(&id, params, "id"));
            // `seen: false` is the user marking the resurfaced row unread.
            let seen = params.get("seen").and_then(Value::as_bool).unwrap_or(true);
            let st = Arc::clone(state);
            let updated = blocking(move || {
                app_db::with(&st.app_dir, |c| follow_up::mark_seen(c, &row_id, seen))?;
                json_of(get_row(&st, &row_id)?)
            })
            .await
            .and_then(|r| r);
            done(id, updated)
        }

        "follow_up.mark_announced" => {
            let row_id = req!(str_arg(&id, params, "id"));
            done(id, update_row(state, row_id, follow_up::mark_announced).await)
        }

        "follow_up.dismiss" => {
            let row_id = req!(str_arg(&id, params, "id"));
            let dismissed = update_row(state, row_id.clone(), follow_up::dismiss).await;
            if let Ok(row) = &dismissed {
                follow_up_worker::emit(state, &row_id, row["state"].as_str().unwrap_or_default());
            }
            done(id, dismissed)
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-follow-up-handler-{}", uuid::Uuid::new_v4()));
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
            "messageId": "<m@x>",
            "subject": "Quote",
            "recipients": "Ana <ana@x.com>",
            "sentMailbox": "Sent",
            "sentAt": 1_000,
            "remindAt": 9_999_999_999_999i64,
        })
    }

    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "follow_up.list", json!({})).await;
        assert!(resp.result.is_some(), "follow_up.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn create_records_a_waiting_row_that_list_returns() {
        let s = st();
        let row = call(&s, "follow_up.create", create_params()).await;
        assert_eq!(row["state"], json!("waiting"));
        assert_eq!(row["messageId"], json!("<m@x>"));
        assert_eq!(row["subject"], json!("Quote"));
        assert_eq!(row["recipients"], json!("Ana <ana@x.com>"));
        assert_eq!(row["sentMailbox"], json!("Sent"));
        assert_eq!(row["remindAt"], json!(9_999_999_999_999i64));
        let listed = call(&s, "follow_up.list", json!({"accountId": "acc1"})).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(call(&s, "follow_up.list", json!({"accountId": "other"})).await, json!([]));
    }

    /// A send retried after a failure runs its success path again: the
    /// second create answers the first row, it never adds another.
    #[tokio::test]
    async fn a_second_create_for_the_same_message_answers_the_first_row() {
        let s = st();
        let first = call(&s, "follow_up.create", create_params()).await;
        let second = call(&s, "follow_up.create", create_params()).await;
        assert_eq!(first["id"], second["id"]);
        assert_eq!(call(&s, "follow_up.list", json!({})).await.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_refuses_a_message_without_a_message_id() {
        let s = st();
        let mut params = create_params();
        params["messageId"] = json!("  ");
        let resp = route(&s, "follow_up.create", &params, json!(1)).await.expect("routed");
        assert!(resp.error.is_some());
        assert_eq!(call(&s, "follow_up.list", json!({})).await, json!([]));
    }

    #[tokio::test]
    async fn seen_and_announced_are_remembered() {
        let s = st();
        let row = call(&s, "follow_up.create", create_params()).await;
        let seen = call(&s, "follow_up.mark_seen", json!({"id": row["id"]})).await;
        assert_eq!(seen["seen"], json!(true));
        let announced = call(&s, "follow_up.mark_announced", json!({"id": row["id"]})).await;
        assert_eq!(announced["announced"], json!(true));
        assert_eq!(announced["seen"], json!(true));
        let unread = call(&s, "follow_up.mark_seen", json!({"id": row["id"], "seen": false})).await;
        assert_eq!(unread["seen"], json!(false));
    }

    /// Dismissing ends the row and says so: every window drops it from its
    /// inbox off the event.
    #[tokio::test]
    async fn dismiss_ends_the_row_and_announces_it() {
        let s = st();
        let row = call(&s, "follow_up.create", create_params()).await;
        let mut events = s.events.subscribe();
        let ended = call(&s, "follow_up.dismiss", json!({"id": row["id"]})).await;
        assert_eq!(ended["state"], json!("dismissed"));
        let line = events.try_recv().expect("the dismissal is announced");
        assert_eq!(
            mailvault_core::daemon_ipc::parse_event(&line),
            Some(("follow-up".to_string(), json!({"id": row["id"], "state": "dismissed"})))
        );
        assert_eq!(call(&s, "follow_up.list", json!({})).await, json!([]));
    }

    #[tokio::test]
    async fn an_unknown_row_is_an_error() {
        let s = st();
        for method in ["follow_up.dismiss", "follow_up.mark_seen"] {
            let resp = route(&s, method, &json!({"id": "nope"}), json!(1)).await.expect("routed");
            assert!(resp.error.is_some(), "{method}");
        }
    }
}
