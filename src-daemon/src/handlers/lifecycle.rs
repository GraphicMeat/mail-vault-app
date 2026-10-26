//! `lifecycle.*`: the in-app lifecycle messages (trial ending, a checkout left,
//! a plan ended, a nudge for a free user), decided by
//! `mailvault_core::lifecycle_mail` and remembered in `<app_dir>/lifecycle.json`.
//! The app only renders the rows this answers.
//!
//! - `lifecycle.sync {state}` reads the settings facts the app hands over
//!   (`state`, see `Inputs::from_state`), delivers at most one message that is
//!   due, and answers `{rows}`: every message not dismissed, newest first. With
//!   `lifecycleMessages: false` it answers no rows and delivers nothing.
//! - `lifecycle.mark_seen {id}` and `lifecycle.dismiss {id}` record what the
//!   user did and answer `{ok}`. A dismissed message stays on file, so the same
//!   occasion is never delivered again.
//!
//! The facts come from the app's own call rather than the settings file: the
//! app persists settings on its own schedule, and a decision made on a file
//! that has not caught up with a billing refresh would miss it.
//!
//! Never fails on what it is sent: missing or mistyped params read as absent,
//! and a store that cannot be written costs one message delivered again later.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::lifecycle_mail::{self, Inputs, Store};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub(crate) const SYNC: &str = "lifecycle.sync";
pub(crate) const MARK_SEEN: &str = "lifecycle.mark_seen";
pub(crate) const DISMISS: &str = "lifecycle.dismiss";

/// Each call reads the store, changes it and writes it back; two at once
/// (launch and a focus, say) must not lose each other's change.
static STORE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !matches!(method, SYNC | MARK_SEEN | DISMISS) {
        return None;
    }
    let app_dir = state.app_dir.clone();
    let method = method.to_string();
    let params = params.clone();
    // Reads and writes a small file: off the async workers.
    let joined = tokio::task::spawn_blocking(move || run(&app_dir, &method, &params, now_ms())).await;
    Some(match joined {
        Ok(result) => RpcResponse::success(id, result),
        Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, "lifecycle.unavailable"),
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn run(app_dir: &Path, method: &str, params: &Value, now_ms: i64) -> Value {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut store = Store::load(app_dir);
    let before = store.clone();
    let result = match method {
        SYNC => {
            let inputs = Inputs::from_state(params.get("state").unwrap_or(&Value::Null));
            lifecycle_mail::evaluate(&inputs, &mut store, now_ms);
            json!({ "rows": if inputs.enabled { store.visible() } else { Vec::new() } })
        }
        MARK_SEEN => {
            if let Some(id) = params.get("id").and_then(Value::as_str) {
                store.mark_seen(id);
            }
            json!({ "ok": true })
        }
        _ => {
            if let Some(id) = params.get("id").and_then(Value::as_str) {
                store.dismiss(id);
            }
            json!({ "ok": true })
        }
    };
    if store != before {
        if let Err(e) = store.save(app_dir) {
            tracing::warn!("lifecycle: could not save {}: {e}", Store::path(app_dir).display());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};
    use mailvault_core::lifecycle_mail::{DAY_MS, HOUR_MS};

    fn rig() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        (dir, state)
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = handle_request_for_test(state, method, params).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        resp.result.unwrap()
    }

    fn trialing_in(hours: i64) -> Value {
        let end = chrono::Utc::now().timestamp_millis() + hours * HOUR_MS;
        json!({
            "onboardingComplete": true,
            "billingProfile": { "premiumAccess": true, "hasSubscription": true, "status": "trialing", "currentPeriodEnd": end },
        })
    }

    #[tokio::test]
    async fn delivers_a_due_message_through_the_route_chain_and_keeps_it() {
        let (dir, state) = rig();
        let answer = call(&state, SYNC, json!({ "state": trialing_in(30) })).await;
        let rows = answer["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kind"], "trial-ending");
        assert_eq!(rows[0]["seen"], false);
        assert!(dir.path().join("lifecycle.json").exists());

        // Asking again lists the same message and delivers nothing new.
        let again = call(&state, SYNC, json!({ "state": trialing_in(30) })).await;
        assert_eq!(again["rows"], answer["rows"]);
    }

    #[tokio::test]
    async fn a_message_read_or_dismissed_is_remembered() {
        let (_dir, state) = rig();
        let id = call(&state, SYNC, json!({ "state": trialing_in(30) })).await["rows"][0]["id"].as_str().unwrap().to_string();

        assert_eq!(call(&state, MARK_SEEN, json!({ "id": id })).await, json!({ "ok": true }));
        assert_eq!(call(&state, SYNC, json!({ "state": trialing_in(30) })).await["rows"][0]["seen"], true);

        assert_eq!(call(&state, DISMISS, json!({ "id": id })).await, json!({ "ok": true }));
        assert_eq!(call(&state, SYNC, json!({ "state": trialing_in(30) })).await["rows"], json!([]));
    }

    #[tokio::test]
    async fn switched_off_answers_nothing_and_writes_nothing() {
        let (dir, state) = rig();
        let mut off = trialing_in(30);
        off["lifecycleMessages"] = json!(false);
        assert_eq!(call(&state, SYNC, json!({ "state": off })).await, json!({ "rows": [] }));
        assert!(!dir.path().join("lifecycle.json").exists());
    }

    #[tokio::test]
    async fn junk_params_answer_no_rows_instead_of_failing() {
        let (_dir, state) = rig();
        assert_eq!(call(&state, SYNC, Value::Null).await["rows"], json!([]));
        assert_eq!(call(&state, SYNC, json!({ "state": "x" })).await["rows"], json!([]));
        assert_eq!(call(&state, MARK_SEEN, json!({ "id": 5 })).await, json!({ "ok": true }));
        assert_eq!(call(&state, DISMISS, Value::Null).await, json!({ "ok": true }));
    }

    #[test]
    fn a_free_user_is_nudged_four_days_after_the_first_sighting() {
        let dir = tempfile::tempdir().unwrap();
        let free = json!({ "state": { "onboardingComplete": true } });
        let t0 = 1_800_000_000_000_i64;

        assert_eq!(run(dir.path(), SYNC, &free, t0)["rows"], json!([]));
        let stored: Value = serde_json::from_slice(&std::fs::read(dir.path().join("lifecycle.json")).unwrap()).unwrap();
        assert_eq!(stored["freeSinceMs"], t0, "the first sighting starts the four days");

        assert_eq!(run(dir.path(), SYNC, &free, t0 + 4 * DAY_MS - 1)["rows"], json!([]));
        let due = run(dir.path(), SYNC, &free, t0 + 4 * DAY_MS);
        assert_eq!(due["rows"][0]["kind"], "free-nudge");
        assert_eq!(due["rows"][0]["atMs"], t0 + 4 * DAY_MS);
    }

    #[test]
    fn a_damaged_store_file_is_replaced_by_a_fresh_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("lifecycle.json"), b"{not json").unwrap();
        let free = json!({ "state": { "onboardingComplete": true } });
        assert_eq!(run(dir.path(), SYNC, &free, 1_800_000_000_000)["rows"], json!([]));
        let stored: Value = serde_json::from_slice(&std::fs::read(dir.path().join("lifecycle.json")).unwrap()).unwrap();
        assert_eq!(stored["freeSinceMs"], 1_800_000_000_000_i64);
    }
}
