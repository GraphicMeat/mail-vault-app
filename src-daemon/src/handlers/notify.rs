//! `notify.decide`: whether a new-mail banner is shown, decided by
//! `mailvault_core::notify_policy` from the persisted `notificationSettings`
//! (the settings document) and the local time. The app hands over the
//! arrival and only renders what this answers.
//!
//! - `notify.decide {accountId, folder, from, domain?, viewIds?, focusHeld?}`
//!   answers `{deliver, reason}`, `reason` one of `notify_policy::REASONS`.
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
    if method != DECIDE {
        return None;
    }
    let app_dir = state.app_dir.clone();
    let ctx = ctx_from_params(params);
    // Reads the settings file: off the async workers.
    let joined = tokio::task::spawn_blocking(move || {
        notify_policy::decide(&ctx, &notify_policy::read_policy(&app_dir), notify_policy::local_minutes_now())
    })
    .await;
    Some(match joined {
        Ok(d) => RpcResponse::success(id, json!({"deliver": d.deliver, "reason": d.reason})),
        Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, "notifyPolicy.reason.policyUnavailable"),
    })
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

    #[tokio::test]
    async fn junk_params_and_a_broken_settings_file_still_notify() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("frontend-settings.json"), b"{not json").unwrap();
        assert_eq!(decide(&state, json!({"accountId": 5, "viewIds": "v"})).await["deliver"], true);
        assert_eq!(decide(&state, Value::Null).await["deliver"], true);
    }
}
