//! `notify.decide`: whether a new-mail banner is shown, decided by
//! `mailvault_core::notify_policy` from the persisted `notificationSettings`
//! (the settings document) and the local time. The app hands over the
//! arrival and only renders what this answers.
//!
//! - `notify.decide {accountId, folder, from, domain?, viewIds?, focusHeld?, uids?, rearm?}`
//!   answers `{deliver, reason}`, `reason` one of `notify_policy::REASONS`, or
//!   `already-announced` when every one of `uids` already had its banner, unless
//!   `rearm` (a snooze's wake, which brings back a message announced on arrival)
//!   asks for this banner regardless; it still counts as the message's latest.
//!   `domain` defaults to what follows the first `@` of `from`. `focusHeld`
//!   is the window's Focus session: the shell holds those banners itself and
//!   flushes them when the session ends.
//!
//! Never fails on what it is sent: a missing field reads as absent, and
//! settings that cannot be read are the app's defaults (notify), because a
//! settings file mid-write must not silence mail.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::notify_policy::{self, Ctx};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const DECIDE: &str = "notify.decide";

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if method == "notify.arrival" {
        return Some(local_wake(state, params, id).await);
    }
    if method != DECIDE {
        return None;
    }
    let app_dir = state.app_dir.clone();
    let ctx = ctx_from_params(params);
    // The messages the banner is for, when the caller can name them (a refresh
    // can; the change feed cannot and sends none).
    let uids: Vec<u32> = params
        .get("uids")
        .and_then(Value::as_array)
        .map(|uids| uids.iter().filter_map(|uid| uid.as_u64().and_then(|uid| u32::try_from(uid).ok())).collect())
        .unwrap_or_default();
    let rearm = params.get("rearm").and_then(Value::as_bool).unwrap_or(false);
    let place = ctx.account_id.clone().zip(ctx.folder.as_ref().and_then(Value::as_str).map(str::to_owned));
    let for_policy = ctx.clone();
    // Reads the settings file: off the async workers.
    let joined = tokio::task::spawn_blocking(move || {
        notify_policy::decide(&for_policy, &notify_policy::read_policy(&app_dir), notify_policy::local_minutes_now())
    })
    .await;
    Some(match joined {
        Ok(d) => {
            // A banner (shown now, or held by a Focus session to be shown) is
            // allowed once per message: the policy's answer stands for the first.
            let shown = d.deliver || d.reason == notify_policy::FOCUS_HOLD;
            let again = shown
                && place.is_some_and(|(account, folder)| {
                    if rearm {
                        state.recent.reannounce(&account, &folder, &uids);
                        false
                    } else {
                        !state.recent.announce(&account, &folder, &uids)
                    }
                });
            if again {
                RpcResponse::success(id, json!({"deliver": false, "reason": notify_policy::ALREADY_ANNOUNCED}))
            } else {
                RpcResponse::success(id, json!({"deliver": d.deliver, "reason": d.reason}))
            }
        }
        Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, "notifyPolicy.reason.policyUnavailable"),
    })
}

/// The one-use native local-wake adapter. The native event carries no UID:
/// only this route can resolve the persisted Message-ID under the original
/// owner, and the claim is consumed before any asynchronous preparation.
async fn local_wake(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let Some(object) = params.as_object().filter(|object| object.len() == 3
        && object.keys().all(|key| ["snoozeId", "wakeRef", "rearm"].contains(&key.as_str()))) else {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    };
    let Some(snooze_id) = object.get("snoozeId").and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)) else {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    };
    if object.get("rearm") != Some(&Value::Bool(true)) {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    }
    let Some(reference) = object.get("wakeRef").and_then(Value::as_object)
        .filter(|reference| reference.len() == 2 && reference.contains_key("instanceId")
            && reference.contains_key("gen")) else {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    };
    let Some(instance) = reference.get("instanceId").and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)) else {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    };
    let Some(generation) = reference.get("gen").and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991) else {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    };
    if instance != state.refresh.instance_id() {
        return RpcResponse::success(id, json!({"status":"unavailable","reason":"expired-proof"}));
    }
    let Some(proof) = state.recent.consume_wake(snooze_id, generation) else {
        return RpcResponse::success(id, json!({"status":"unavailable",
            "reason":state.recent.wake_refusal(snooze_id, generation)}));
    };
    match crate::arrival::prepare_local_wake(state, snooze_id, proof).await {
        Ok(notification) => RpcResponse::success(id, json!({"status":"prepared","notification":notification})),
        Err(reason) => RpcResponse::success(id, json!({"status":"unavailable","reason":reason})),
    }
}

fn ctx_from_params(params: &Value) -> Ctx {
    let mut ctx = Ctx::from_value(params);
    if !params.get("domain").is_some_and(Value::is_string) {
        ctx.domain = ctx.from.split_once('@').map(|(_, d)| d.to_string()).unwrap_or_default();
    }
    ctx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};

    fn rig() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        (dir, state)
    }

    fn save(dir: &tempfile::TempDir, notification_settings: Value) {
        let doc = json!({"mailvault-settings": {"state": {"notificationSettings": notification_settings}, "version": 20}});
        std::fs::write(dir.path().join("frontend-settings.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
    }

    async fn decide(state: &Arc<DaemonState>, params: Value) -> Value {
        let resp = handle_request_for_test(state, DECIDE, params).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        resp.result.unwrap()
    }

    #[tokio::test]
    async fn local_wake_route_rejects_caller_policy_and_missing_or_expired_proof() {
        let (_dir, state) = rig();
        for malformed in [
            json!({"snoozeId":"a","wakeRef":{"instanceId":"x","gen":1},"rearm":true,
                "subject":"caller cannot choose the banner"}),
            json!({"snoozeId":"a","wakeRef":{"instanceId":"x","gen":0},"rearm":true}),
            json!({"snoozeId":"a","wakeRef":{"instanceId":"x","gen":1},"rearm":false}),
        ] {
            let response = handle_request_for_test(&state, "notify.arrival", malformed).await;
            assert_eq!(response.error.unwrap().code, ipc::INVALID_PARAMS);
        }
        let expired = handle_request_for_test(&state, "notify.arrival", json!({
            "snoozeId":"a","wakeRef":{"instanceId":"old-process","gen":1},"rearm":true,
        })).await.result.unwrap();
        assert_eq!(expired, json!({"status":"unavailable","reason":"expired-proof"}));
        let missing = handle_request_for_test(&state, "notify.arrival", json!({
            "snoozeId":"a","wakeRef":{"instanceId":state.refresh.instance_id(),"gen":1},"rearm":true,
        })).await.result.unwrap();
        assert_eq!(missing, json!({"status":"unavailable","reason":"missing-proof"}));
    }

    #[tokio::test]
    async fn decides_through_the_route_chain_from_the_settings_document() {
        let (dir, state) = rig();
        let arrival = json!({"accountId": "a1", "folder": "INBOX", "from": "x@y.com"});

        // Nothing saved yet: the defaults, which notify.
        assert_eq!(decide(&state, arrival.clone()).await, json!({"deliver": true, "reason": "delivered-default"}));

        save(&dir, json!({"enabled": true, "accounts": {"a1": {"enabled": false, "folders": ["INBOX"]}}}));
        assert_eq!(decide(&state, arrival.clone()).await, json!({"deliver": false, "reason": "account-muted"}));

        save(&dir, json!({"enabled": false}));
        assert_eq!(decide(&state, arrival).await, json!({"deliver": false, "reason": "notifications-off"}));
    }

    #[tokio::test]
    async fn a_focus_session_holds_before_any_rule() {
        let (dir, state) = rig();
        save(&dir, json!({"enabled": false}));
        let held = decide(&state, json!({"accountId": "a1", "folder": "INBOX", "focusHeld": true})).await;
        assert_eq!(held, json!({"deliver": false, "reason": "focus-hold"}));
    }

    #[tokio::test]
    async fn the_domain_comes_from_the_sender_when_not_given() {
        let (dir, state) = rig();
        save(&dir, json!({"enabled": true, "accounts": {"a1": {"enabled": false}}, "importantSenders": [{"match": "corp.example"}]}));
        let derived = decide(&state, json!({"accountId": "a1", "folder": "INBOX", "from": "boss@corp.example"})).await;
        assert_eq!(derived["reason"], "priority-allowlist");
        // A given domain wins over the sender's.
        let given = decide(&state, json!({"accountId": "a1", "folder": "INBOX", "from": "boss@corp.example", "domain": "other.example"})).await;
        assert_eq!(given["reason"], "account-muted");
    }

    /// A refresh that sees the same arrival again, or any second path that
    /// reaches the banner for a message already announced, must not raise it
    /// twice: the first answer is the only `deliver` for an (account, folder, uid).
    #[tokio::test]
    async fn a_banner_for_a_message_is_delivered_once() {
        let (dir, state) = rig();
        let arrival = |uids: Value| json!({"accountId": "a1", "folder": "INBOX", "from": "x@y.com", "uids": uids});
        assert_eq!(decide(&state, arrival(json!([31616]))).await, json!({"deliver": true, "reason": "delivered-default"}));
        assert_eq!(decide(&state, arrival(json!([31616]))).await, json!({"deliver": false, "reason": "already-announced"}), "the same message again");
        assert_eq!(decide(&state, arrival(json!([31616, 31617]))).await["deliver"], true, "a new message in the batch is a banner");
        assert_eq!(decide(&state, arrival(json!([31617, 31616]))).await["reason"], "already-announced");
        // A banner that names no message is never held back (the change feed cannot say which).
        assert_eq!(decide(&state, arrival(json!([]))).await["deliver"], true);
        assert_eq!(decide(&state, json!({"accountId": "a1", "folder": "INBOX"})).await["deliver"], true);
        // Another folder, another account: not the same message.
        assert_eq!(decide(&state, json!({"accountId": "a1", "folder": "Archive", "uids": [31616]})).await["deliver"], true);
        assert_eq!(decide(&state, json!({"accountId": "a2", "folder": "INBOX", "uids": [31616]})).await["deliver"], true);

        // A banner the policy withheld is not spent: unmute, and the arrival is shown.
        save(&dir, json!({"enabled": false}));
        let muted = json!({"accountId": "a1", "folder": "INBOX", "uids": [900]});
        assert_eq!(decide(&state, muted.clone()).await, json!({"deliver": false, "reason": "notifications-off"}));
        save(&dir, json!({"enabled": true}));
        assert_eq!(decide(&state, muted).await["deliver"], true);
    }

    /// A local snooze's wake brings back a message whose arrival banner was
    /// shown: the wake is a banner of its own, and a refresh right after it is not.
    #[tokio::test]
    async fn a_wake_banner_is_shown_after_the_arrival_and_holds_back_the_refresh() {
        let (_dir, state) = rig();
        let arrival = json!({"accountId": "a1", "folder": "INBOX", "uids": [5]});
        assert_eq!(decide(&state, arrival.clone()).await["deliver"], true);
        let wake = json!({"accountId": "a1", "folder": "INBOX", "uids": [5], "rearm": true});
        assert_eq!(decide(&state, wake.clone()).await["deliver"], true, "announced on arrival, shown again on wake");
        assert_eq!(decide(&state, arrival).await["reason"], "already-announced", "the refresh after the wake");
        assert_eq!(decide(&state, wake).await["deliver"], true, "snoozed and woken a second time");
    }

    /// A Focus session holds the banner and shows it when the session ends: that
    /// is the one banner for the message, so asking again must not hold a second.
    #[tokio::test]
    async fn a_focus_held_banner_counts_as_announced() {
        let (_dir, state) = rig();
        let held = json!({"accountId": "a1", "folder": "INBOX", "focusHeld": true, "uids": [7]});
        assert_eq!(decide(&state, held.clone()).await, json!({"deliver": false, "reason": "focus-hold"}));
        assert_eq!(decide(&state, held).await, json!({"deliver": false, "reason": "already-announced"}));
    }

    #[tokio::test]
    async fn junk_params_and_a_broken_settings_file_still_notify() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("frontend-settings.json"), b"{not json").unwrap();
        assert_eq!(decide(&state, json!({"accountId": 5, "viewIds": "v"})).await["deliver"], true);
        assert_eq!(decide(&state, Value::Null).await["deliver"], true);
    }
}
