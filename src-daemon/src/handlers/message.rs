//! Verdicts on one message that every UI shell shows the same way:
//!
//! - `message.verify_sender`: the sender shield and its details popover
//!   (`mailvault_core::sender_check`). Params are the message's header fields
//!   (`from {name, address}`, `replyTo`, `returnPath`,
//!   `authenticationResults`, `dkimSignature`); the answer is
//!   `{status, tooltip, issues, auth, dkim}`, its text as catalog keys and
//!   values for the app's `t()`. The signer's key size stays a separate DNS
//!   question (`dkim_key`), asked only when the popover opens.
//! - `message.code`: the one-time code in a mail
//!   (`mailvault_core::verification_code`). Params `{subject, text}`; the
//!   answer is `{code, needsBody}`, `needsBody` when no code was found but the
//!   subject or snippet talks about one (or the subject about a password
//!   reset), so the body is worth reading for it.
//!
//! Both read only what they are handed: no vault, no network.
use crate::handlers::common::{blocking, done};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::{sender_check, verification_code};
use serde_json::{json, Value};
use std::sync::Arc;

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

pub(crate) async fn route(_state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "message.verify_sender" => done(id, serde_json::to_value(sender_check::verify_sender(params)).map_err(|e| e.to_string())),
        // A body can be long: read it off the runtime's threads.
        "message.code" => {
            let (subject, body) = (text(params, "subject"), text(params, "text"));
            done(
                id,
                blocking(move || {
                    let code = verification_code::find_verification_code(&subject, &body);
                    let needs_body = code.is_none() && verification_code::body_may_hold_code(&subject, &body);
                    json!({"code": code, "needsBody": needs_body})
                })
                .await,
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-message-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = handle_request_for_test(s, method, params).await;
        assert!(resp.error.is_none(), "{method} routed and answered: {:?}", resp.error);
        resp.result.unwrap()
    }

    const SENDER_CASES: &str = include_str!("../../../src-core/tests/fixtures/sender-check-cases.json");
    const CODE_CASES: &str = include_str!("../../../src-core/tests/fixtures/verification-code-cases.json");

    /// Every case the app's JS answered, answered the same through the RPC.
    #[tokio::test]
    async fn verify_sender_answers_every_case_the_js_did() {
        let s = st();
        let fixture: Value = serde_json::from_str(SENDER_CASES).unwrap();
        let mut wrong = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            // The app sends the header fields as the params object; a missing message sends none.
            let params = if case["input"].is_null() { json!({}) } else { case["input"].clone() };
            let got = call(&s, "message.verify_sender", params).await;
            if got != case["expected"] {
                wrong.push(format!("{}: got {got}\n  want {}", case["name"], case["expected"]));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[tokio::test]
    async fn code_answers_every_case_the_js_did() {
        let s = st();
        let fixture: Value = serde_json::from_str(CODE_CASES).unwrap();
        let mut wrong = Vec::new();
        for case in fixture["codes"].as_array().unwrap() {
            let as_text = |v: &Value| match v {
                Value::Null => Value::Null,
                Value::String(_) => v.clone(),
                other => Value::String(other.to_string()),
            };
            let params = json!({"subject": as_text(&case["input"]["subject"]), "text": as_text(&case["input"]["text"])});
            let got = call(&s, "message.code", params).await;
            if got["code"] != case["expected"] {
                wrong.push(format!("{}: got {}, want {}", case["name"], got["code"], case["expected"]));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// The bubble reads a body only for a mail whose subject or snippet talks
    /// about a code (or a password reset) and held none.
    #[tokio::test]
    async fn needs_body_only_when_the_mail_announces_a_code_it_does_not_hold() {
        let s = st();
        let r = call(&s, "message.code", json!({"subject": "Sign in to Acme", "text": "Hello there"})).await;
        assert_eq!(r, json!({"code": null, "needsBody": true}));
        let r = call(&s, "message.code", json!({"subject": "Your code is 364758"})).await;
        assert_eq!(r, json!({"code": "364758", "needsBody": false}));
        // A snippet cut off before the code it announces.
        let r = call(&s, "message.code", json!({"subject": "Lunch", "text": "your verification"})).await;
        assert_eq!(r, json!({"code": null, "needsBody": true}));
        // A reset mail whose subject names no code and whose header has no snippet.
        let r = call(&s, "message.code", json!({"subject": "Password Reset Request", "text": ""})).await;
        assert_eq!(r, json!({"code": null, "needsBody": true}));
        let r = call(&s, "message.code", json!({"subject": "Weekly digest", "text": "Hello there"})).await;
        assert_eq!(r, json!({"code": null, "needsBody": false}));
        let r = call(&s, "message.code", json!({})).await;
        assert_eq!(r, json!({"code": null, "needsBody": false}));
    }

    #[tokio::test]
    async fn verify_sender_keys_are_catalog_keys() {
        let s = st();
        let r = call(&s, "message.verify_sender", json!({"from": {"name": "paypal.com", "address": "a@x.example"}, "authenticationResults": "mx; spf=fail"})).await;
        assert_eq!(r["status"], "danger");
        let catalog: Value = serde_json::from_str(include_str!("../../../src/i18n/locales/en.json")).unwrap();
        for line in r["tooltip"].as_array().unwrap() {
            let key = line["key"].as_str().unwrap();
            assert!(catalog.get(key).is_some_and(Value::is_string), "{key} is in the English catalog");
        }
    }
}
