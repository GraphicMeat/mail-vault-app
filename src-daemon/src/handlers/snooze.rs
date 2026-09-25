//! Snooze RPCs. The queue lives in `app.db` (`mailvault_core::app_db::snooze`).
//!
//! `snooze.create` records a snooze; it does not move anything. The app moves
//! the message into the folder `snooze.ensure_folder` resolved, through its
//! own move workflow (journal, undo, list and cache rules), and then records
//! each moved message here with the COPYUID the move reported.
//! `snooze.cancel` unsnoozes now through the worker's own `wake_row`.
use crate::handlers::common::{blocking, done, opt_str_arg, opt_u32_arg, str_arg, u64_arg};
use crate::imap::{self, pool::PooledSessionGuard, ImapConfig};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use crate::snooze_worker;
use mailvault_core::app_db::{self, snooze};
use serde_json::{json, Value};
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

fn get_row(state: &Arc<DaemonState>, row_id: &str) -> Result<snooze::Snooze, String> {
    app_db::with(&state.app_dir, |c| snooze::get(c, row_id))?.ok_or_else(|| format!("No snooze {row_id}"))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "snooze.list" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || app_db::with(&state.app_dir, |c| json_of(snooze::list(c, account_id.as_deref())?)))
                    .await
                    .and_then(|r| r),
            )
        }

        "snooze.ensure_folder" => {
            let account = match params.get("account").and_then(|v| serde_json::from_value::<ImapConfig>(v.clone()).ok()) {
                Some(a) => a,
                None => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing or invalid account".to_string())),
            };
            match ensure_folder(state, &account).await {
                Ok(path) => RpcResponse::success(id, json!(path)),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "snooze.create" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let from_mailbox = req!(str_arg(&id, params, "mailbox"));
            let snoozed_mailbox = opt_str_arg(params, "snoozedMailbox").unwrap_or_else(|| snooze::SNOOZED_MAILBOX.to_string());
            let uid = opt_u32_arg(params, "uid");
            let message_id = req!(str_arg(&id, params, "messageId"));
            let wake_at = req!(u64_arg(&id, params, "wakeAt")) as i64;
            if message_id.trim().is_empty() {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "A snoozed message needs a Message-ID".to_string()));
            }
            let st = Arc::clone(state);
            let created = blocking(move || {
                let row_id = uuid::Uuid::new_v4().to_string();
                app_db::with(&st.app_dir, |c| {
                    snooze::insert(c, &row_id, &account_id, &from_mailbox, &snoozed_mailbox, uid, message_id.trim(), wake_at)
                })?;
                json_of(get_row(&st, &row_id)?)
            })
            .await
            .and_then(|r| r);
            state.snooze.wake();
            done(id, created)
        }

        "snooze.reschedule" => {
            let row_id = req!(str_arg(&id, params, "id"));
            let wake_at = req!(u64_arg(&id, params, "wakeAt")) as i64;
            let st = Arc::clone(state);
            let updated = blocking(move || {
                app_db::with(&st.app_dir, |c| snooze::reschedule(c, &row_id, wake_at))?;
                json_of(get_row(&st, &row_id)?)
            })
            .await
            .and_then(|r| r);
            state.snooze.wake();
            done(id, updated)
        }

        "snooze.cancel" => {
            let row_id = req!(str_arg(&id, params, "id"));
            cancel(state, &row_id, id).await
        }

        _ => return None,
    })
}

/// Resolve or create the Snoozed folder on the server; the app moves into
/// whatever path this answers.
async fn ensure_folder(state: &Arc<DaemonState>, account: &ImapConfig) -> Result<String, String> {
    let PooledSessionGuard { mut session, last_selected: _, _permit } = state.imap_pool.get_priority(account).await?;
    let path = imap::ensure_snoozed_mailbox(&mut session).await?;
    // CREATE changes the hierarchy under the socket: report nothing selected.
    let guard = PooledSessionGuard { session, last_selected: None, _permit };
    state.imap_pool.return_priority(account, guard).await;
    Ok(path)
}

/// Unsnooze now: the worker's own wake, under the worker's own lock.
async fn cancel(state: &Arc<DaemonState>, row_id: &str, id: Value) -> RpcResponse {
    let _held = state.snooze.lock.lock().await;
    let st = Arc::clone(state);
    let lookup = row_id.to_string();
    let row = match blocking(move || get_row(&st, &lookup)).await.and_then(|r| r) {
        Ok(row) => row,
        Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, e),
    };
    if row.state == "woken" {
        return done(id, json_of(row));
    }
    let outcome = snooze_worker::wake_row(state, &row).await;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let recorded = app_db::with(&state.app_dir, |c| snooze::record_outcome(c, &row.id, &outcome, now));
    if let Ok(row_state) = &recorded {
        snooze_worker::emit(state, &row.id, row_state);
    }
    match outcome {
        // The user asked for it back now: a failure is theirs to see, not a
        // retry to wait on.
        snooze::WakeOutcome::Transient(e) | snooze::WakeOutcome::Wait(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        _ => done(id, recorded.and_then(|_| json_of(get_row(state, &row.id)?))),
    }
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
