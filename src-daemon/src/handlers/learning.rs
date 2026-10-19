//! `learning.*`: the classification rules an account learns from the user's
//! corrections, kept per account in `<app_dir>/ai-feedback/<accountId>.json`
//! and applied by `classification_worker`. The logic is
//! `mailvault_core::learning`; this module loads, applies and saves.
//!
//! - `learning.record_correction {accountId, email, correction}` stores the
//!   correction and learns a domain, address or subject rule from it.
//!   Answers `{correctionSaved, ruleGenerated, rule}`.
//! - `learning.rules {accountId}` the rules; `learning.stats {accountId}` the
//!   stored stats plus `rulesCount` and `correctionsCount`.
//! - `learning.save_rule {accountId, rule}` adds a rule or merges it into the
//!   one with its `id`; `learning.delete_rule {accountId, ruleId}` removes it.
//! - `learning.export {accountId}` the anonymized rules, as `payload` and as
//!   the file text (`json`) the app saves.
//! - `learning.import {accountId, data}` checks a parsed rules file and adds
//!   the rules no existing one covers: `{valid: true, imported}`, or
//!   `{valid: false, errorKey, errorParams}` with an i18n catalog key.
//!
//! A read-modify-write holds `WRITE` so two corrections cannot drop each other.

use crate::handlers::common::str_arg;
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::learning;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

static WRITE: Mutex<()> = Mutex::new(());

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let app_dir = state.app_dir.as_path();
    let resp = match method {
        "learning.rules" => read(app_dir, params, id, |fb| Value::Array(fb.rules)),
        "learning.stats" => read(app_dir, params, id, |fb| learning::stats(&fb)),
        "learning.export" => read(app_dir, params, id, |fb| {
            let out = learning::export_rules(&fb, now_ms());
            json!({ "payload": out.payload, "json": out.json })
        }),
        "learning.record_correction" => {
            if let Err(resp) = str_arg(&id, params, "accountId") {
                return Some(resp);
            }
            let (Some(email), Some(correction)) = (object_arg(params, "email"), object_arg(params, "correction")) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing email or correction"));
            };
            update(app_dir, params, id, |fb| Some(learning::record_correction(fb, &email, &correction, now_ms())))
        }
        "learning.save_rule" => {
            if let Err(resp) = str_arg(&id, params, "accountId") {
                return Some(resp);
            }
            let Some(rule) = object_arg(params, "rule") else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing rule"));
            };
            update(app_dir, params, id, |fb| {
                learning::save_rule(fb, rule);
                Some(json!({ "saved": true }))
            })
        }
        "learning.delete_rule" => update(app_dir, params, id.clone(), |fb| {
            learning::delete_rule(fb, params.get("ruleId"));
            Some(json!({ "deleted": true }))
        }),
        "learning.import" => import(app_dir, params, id),
        _ => return None,
    };
    Some(resp)
}

fn object_arg(params: &Value, key: &str) -> Option<Value> {
    params.get(key).filter(|v| v.is_object()).cloned()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Answer something read from the account's feedback.
fn read(app_dir: &Path, params: &Value, id: Value, answer: impl FnOnce(learning::Feedback) -> Value) -> RpcResponse {
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    RpcResponse::success(id, answer(learning::load_feedback(app_dir, &account_id)))
}

/// Load, change and save the account's feedback under `WRITE`. `change`
/// answers the reply, or `None` to answer `{}` without saving.
fn update(app_dir: &Path, params: &Value, id: Value, change: impl FnOnce(&mut learning::Feedback) -> Option<Value>) -> RpcResponse {
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut feedback = learning::load_feedback(app_dir, &account_id);
    let Some(answer) = change(&mut feedback) else {
        return RpcResponse::success(id, json!({}));
    };
    match learning::save_feedback(app_dir, &account_id, &feedback) {
        Ok(()) => RpcResponse::success(id, answer),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

fn import(app_dir: &Path, params: &Value, id: Value) -> RpcResponse {
    if let Err(resp) = str_arg(&id, params, "accountId") {
        return resp;
    }
    let data = params.get("data").cloned().unwrap_or(Value::Null);
    let rules = match learning::validate_import(&data) {
        Ok(rules) => rules,
        Err(e) => {
            return RpcResponse::success(id, json!({ "valid": false, "errorKey": e.key, "errorParams": e.params }));
        }
    };
    let mut imported = 0;
    let resp = update(app_dir, params, id.clone(), |fb| {
        imported = learning::import_rules(fb, &rules, now_ms());
        // Nothing new: the file stays as it was.
        (imported > 0).then(|| json!({}))
    });
    if resp.error.is_some() {
        return resp;
    }
    RpcResponse::success(id, json!({ "valid": true, "imported": imported }))
}

#[cfg(test)]
mod tests {
    use crate::server::{handle_request_for_test, DaemonState};
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn state() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        (dir, s)
    }

    async fn ok(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = handle_request_for_test(s, method, params).await;
        assert!(resp.error.is_none(), "{method} failed: {:?}", resp.error.map(|e| e.message));
        resp.result.expect("a result")
    }

    fn correction(from: &str, subject: &str, category: &str) -> Value {
        json!({
            "accountId": "acc1",
            "email": { "messageId": format!("<{subject}@x>"), "from": from, "subject": subject },
            "correction": { "originalCategory": "personal", "correctedCategory": category, "correctedAction": "archive" },
        })
    }

    #[tokio::test]
    async fn a_correction_learns_a_rule_the_classifier_file_keeps() {
        let (_dir, s) = state();
        let out = ok(&s, "learning.record_correction", correction("Shop <news@shop.com>", "Weekly deals", "promotional")).await;
        assert_eq!(out["correctionSaved"], true);
        assert_eq!(out["ruleGenerated"], true);
        assert_eq!(out["rule"]["pattern"], json!({"fromDomain": "shop.com"}));
        assert_eq!(out["rule"]["action"], "archive");

        let rules = ok(&s, "learning.rules", json!({"accountId": "acc1"})).await;
        assert_eq!(rules.as_array().unwrap().len(), 1);
        assert_eq!(rules[0]["id"], out["rule"]["id"]);
        // What `classification_worker` reads.
        let stored = mailvault_core::learning::load_feedback(&s.app_dir, "acc1");
        assert_eq!(stored.corrections.len(), 1);
        assert_eq!(stored.corrections[0]["from"], "Shop <news@shop.com>");
    }

    #[tokio::test]
    async fn stats_count_rules_and_corrections() {
        let (_dir, s) = state();
        ok(&s, "learning.record_correction", correction("a@shop.com", "Weekly deals", "promotional")).await;
        ok(&s, "learning.record_correction", correction("b@shop.com", "More weekly deals", "promotional")).await;
        let stats = ok(&s, "learning.stats", json!({"accountId": "acc1"})).await;
        // A domain rule and a subject rule ("weekly").
        assert_eq!(stats["rulesCount"], 2);
        assert_eq!(stats["correctionsCount"], 2);
        assert_eq!(stats["total_classified"], 0);
    }

    #[tokio::test]
    async fn save_rule_merges_and_delete_rule_removes() {
        let (_dir, s) = state();
        let rule = json!({"id": "m1", "type": "sender-action", "pattern": {"fromDomain": "a.com"}, "category": "work", "action": "keep", "confidence": 0.95, "source": "manual"});
        ok(&s, "learning.save_rule", json!({"accountId": "acc1", "rule": rule})).await;
        ok(&s, "learning.save_rule", json!({"accountId": "acc1", "rule": {"id": "m1", "pattern": {"fromDomain": "b.com"}, "action": "archive"}})).await;
        let rules = ok(&s, "learning.rules", json!({"accountId": "acc1"})).await;
        assert_eq!(rules[0]["pattern"], json!({"fromDomain": "b.com"}));
        assert_eq!(rules[0]["action"], "archive");
        assert_eq!(rules[0]["source"], "manual", "a merge keeps the fields the update leaves out");

        ok(&s, "learning.delete_rule", json!({"accountId": "acc1", "ruleId": "m1"})).await;
        let rules = ok(&s, "learning.rules", json!({"accountId": "acc1"})).await;
        assert_eq!(rules, json!([]));
    }

    #[tokio::test]
    async fn export_leaves_out_addresses_and_import_adds_only_new_rules() {
        let (_dir, s) = state();
        for rule in [
            json!({"id": "d", "type": "sender-action", "pattern": {"fromDomain": "a.com"}, "category": "work", "action": "keep", "confidence": 0.95}),
            json!({"id": "x", "type": "sender-action", "pattern": {"fromAddress": "me@a.com"}, "category": "work", "action": "keep", "confidence": 0.95}),
        ] {
            ok(&s, "learning.save_rule", json!({"accountId": "acc1", "rule": rule})).await;
        }
        let out = ok(&s, "learning.export", json!({"accountId": "acc1"})).await;
        assert_eq!(out["payload"]["version"], 1);
        assert_eq!(out["payload"]["rulesCount"], 2);
        assert_eq!(out["payload"]["rules"][1]["pattern"], json!({}));
        assert!(!out["json"].as_str().unwrap().contains("me@a.com"));

        let file: Value = serde_json::from_str(out["json"].as_str().unwrap()).unwrap();
        let back = ok(&s, "learning.import", json!({"accountId": "acc2", "data": file})).await;
        assert_eq!(back, json!({"valid": true, "imported": 2}));
        let again = ok(&s, "learning.import", json!({"accountId": "acc2", "data": file})).await;
        assert_eq!(again, json!({"valid": true, "imported": 0}));
        let rules = ok(&s, "learning.rules", json!({"accountId": "acc2"})).await;
        assert_eq!(rules.as_array().unwrap().len(), 2);
        assert_eq!(rules[0]["source"], "imported");
    }

    #[tokio::test]
    async fn import_refuses_a_bad_file_with_a_catalog_key() {
        let (_dir, s) = state();
        let out = ok(&s, "learning.import", json!({"accountId": "acc1", "data": {"version": 2, "rules": []}})).await;
        assert_eq!(out["valid"], false);
        assert_eq!(out["errorKey"], "svc.ruleExporter.unsupportedFormatVersionAppSupports");
        assert_eq!(out["errorParams"], json!({"data": 2, "EXPORT_VERSION": 1}));
        let out = ok(&s, "learning.import", json!({"accountId": "acc1", "data": {"rules": []}})).await;
        assert_eq!(out["errorKey"], "svc.ruleExporter.invalidFormatMissingVersionRules");
        assert!(!s.app_dir.join("ai-feedback").join("acc1.json").exists(), "a refused file writes nothing");
    }

    #[tokio::test]
    async fn every_learning_call_needs_an_account() {
        let (_dir, s) = state();
        for method in [
            "learning.record_correction", "learning.rules", "learning.stats", "learning.save_rule",
            "learning.delete_rule", "learning.export", "learning.import",
        ] {
            let resp = handle_request_for_test(&s, method, json!({})).await;
            let msg = resp.error.map(|e| e.message).unwrap_or_default();
            assert_eq!(msg, "Missing accountId", "{method}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_corrections_all_land() {
        let (_dir, s) = state();
        let calls = (0..16).map(|i| {
            let s = Arc::clone(&s);
            tokio::spawn(async move {
                handle_request_for_test(&s, "learning.record_correction", correction(&format!("u{i}@d{i}.com"), "Hello", "work")).await
            })
        });
        for c in calls {
            assert!(c.await.unwrap().error.is_none());
        }
        let stats = ok(&s, "learning.stats", json!({"accountId": "acc1"})).await;
        assert_eq!(stats["correctionsCount"], 16);
        assert_eq!(stats["rulesCount"], 16);
    }
}

