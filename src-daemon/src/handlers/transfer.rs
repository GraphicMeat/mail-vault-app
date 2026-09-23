//! Encrypted account-transfer RPCs (`transfer.export`, `transfer.decrypt`,
//! `transfer.apply_config`). The app never hands the daemon a user-chosen
//! file path (Global constraints, architecture rule); only bytes cross this
//! boundary, and only inside a password-derived AEAD envelope
//! (`mailvault_core::transfer::crypto`).
//!
//! Secret hygiene: the password and every decrypted/serialized plaintext are
//! held in `Zeroizing` wrappers so they are wiped on drop, and argon2 (inside
//! `crypto::encrypt`/`crypto::decrypt`) always runs on a blocking thread,
//! never on the async worker.
use crate::credentials;
use crate::handlers::common::{blocking, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use base64::Engine;
use mailvault_core::app_db;
use mailvault_core::transfer::{app_config, bundle, crypto};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use zeroize::Zeroizing;

/// Same early-return shape `handlers/ai.rs` uses: an `Err(RpcResponse)` here
/// returns straight out of `route`.
macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("transfer.") {
        return None;
    }
    Some(match method {
        "transfer.export" => {
            let password = Zeroizing::new(req!(str_arg(&id, params, "password")));
            if password.chars().count() < 12 {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "E_TRANSFER_PASSWORD".to_string()));
            }
            let mut bundle_val = params.get("bundle").cloned().unwrap_or_else(|| Value::Object(Default::default()));

            let problems = bundle::completeness_problems(&bundle_val);
            if !problems.is_empty() {
                return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("E_TRANSFER_INCOMPLETE: {}", problems.join(", "))));
            }

            let include_app_config = params.get("includeAppConfig").and_then(Value::as_bool).unwrap_or(false);
            if include_app_config {
                let app_dir = state.app_dir.clone();
                let cfg = match blocking(move || app_db::with(&app_dir, |conn| app_config::snapshot(conn))).await {
                    Ok(Ok(cfg)) => cfg,
                    Ok(Err(e)) | Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
                };
                let cfg_json = match serde_json::to_value(cfg) {
                    Ok(v) => v,
                    Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string())),
                };
                bundle_val["appConfig"] = cfg_json;
                // A locked/denied keychain must not fail the export — the app
                // account data still matters even if the AI key doesn't come
                // along.
                let key = credentials::resolve_ai_endpoint_key_guarded().await.ok().flatten();
                bundle_val["aiEndpointKey"] = key.map(Value::String).unwrap_or(Value::Null);
            } else {
                bundle_val["appConfig"] = Value::Null;
                bundle_val["aiEndpointKey"] = Value::Null;
            }

            let plaintext: Zeroizing<Vec<u8>> = match serde_json::to_vec(&bundle_val) {
                Ok(v) => Zeroizing::new(v),
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string())),
            };

            let encrypted = match blocking(move || crypto::encrypt(&password, &plaintext)).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(e)) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string())),
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };
            let data = base64::engine::general_purpose::STANDARD.encode(&encrypted);
            RpcResponse::success(id, serde_json::json!({ "data": data }))
        }

        "transfer.decrypt" => {
            let password = Zeroizing::new(req!(str_arg(&id, params, "password")));
            let data_b64 = req!(str_arg(&id, params, "data"));
            let encrypted = match base64::engine::general_purpose::STANDARD.decode(data_b64.as_bytes()) {
                Ok(v) => v,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("E_TRANSFER_FORMAT: {e}"))),
            };

            let plaintext: Zeroizing<Vec<u8>> = match blocking(move || crypto::decrypt(&password, &encrypted)).await {
                Ok(Ok(bytes)) => Zeroizing::new(bytes),
                Ok(Err(e)) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string())),
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };

            let bundle_val: Value = match serde_json::from_slice(&plaintext) {
                Ok(v) => v,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("E_TRANSFER_FORMAT: {e}"))),
            };
            match bundle_val.get("formatVersion").and_then(Value::as_u64) {
                Some(1) => {}
                _ => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, "E_TRANSFER_FORMAT: unsupported bundle version".to_string())),
            }
            RpcResponse::success(id, bundle_val)
        }

        "transfer.apply_config" => {
            let cfg: app_config::AppConfig =
                match serde_json::from_value(params.get("appConfig").cloned().unwrap_or_else(|| serde_json::json!({}))) {
                    Ok(c) => c,
                    Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("appConfig: {e}"))),
                };
            let account_map: HashMap<String, String> = match params.get("accountMap") {
                Some(v) => match serde_json::from_value(v.clone()) {
                    Ok(m) => m,
                    Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("accountMap: {e}"))),
                },
                None => HashMap::new(),
            };

            let app_dir = state.app_dir.clone();
            let report = match blocking(move || app_db::with(&app_dir, |conn| app_config::merge(conn, &cfg, &account_map))).await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) | Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };

            // Never overwrite a key the target already has; an absent key in
            // the bundle (nothing to offer) is the same as "don't store".
            let ai_key_stored = match params.get("aiEndpointKey").and_then(Value::as_str) {
                Some(key) => match credentials::resolve_ai_endpoint_key_guarded().await {
                    Ok(None) => match credentials::store_ai_endpoint_key_guarded(key.to_string()).await {
                        Ok(()) => true,
                        Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
                    },
                    Ok(Some(_)) => false,
                    Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
                },
                None => false,
            };

            let mut body = match serde_json::to_value(&report) {
                Ok(Value::Object(m)) => m,
                _ => serde_json::Map::new(),
            };
            body.insert("aiKeyStored".to_string(), Value::Bool(ai_key_stored));
            RpcResponse::success(id, Value::Object(body))
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-transfer-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn sample_bundle() -> Value {
        json!({
            "formatVersion": 1,
            "exportedAt": 1_790_000_000_000i64,
            "appVersion": "2.16.0",
            "accounts": [
                { "id": "a1", "email": "a@x.com", "authType": "password", "password": "pw" },
                { "id": "a2", "email": "b@x.com", "authType": "oauth2", "oauth2RefreshToken": "rt" }
            ],
            "accountSettings": {},
            "accountOrder": ["a1", "a2"],
            "appSettings": null,
        })
    }

    /// Registration guard, not a behaviour test: reached through
    /// `server::handle_request`, an unwired module answers "Unknown method"
    /// to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        for method in ["transfer.export", "transfer.decrypt", "transfer.apply_config"] {
            let params = match method {
                "transfer.export" => json!({ "password": "correct horse battery", "bundle": sample_bundle(), "includeAppConfig": false }),
                "transfer.decrypt" => json!({ "password": "correct horse battery", "data": "not-valid-base64!!" }),
                _ => json!({ "appConfig": {}, "accountMap": {} }),
            };
            let resp = crate::server::handle_request_for_test(&s, method, params).await;
            assert!(resp.result.is_some() || resp.error.is_some(), "{method} is not routed");
            // Unknown method is the one shape a wired-but-erroring route never
            // produces; that text is the registration-guard signal.
            if let Some(err) = &resp.error {
                assert!(!err.message.contains("Unknown method"), "{method} is not routed: {err:?}");
            }
        }
    }

    #[tokio::test]
    async fn export_then_decrypt_roundtrips_the_accounts() {
        let s = st();
        let bundle = sample_bundle();
        let exported = call(
            &s,
            "transfer.export",
            json!({ "password": "correct horse battery", "bundle": bundle.clone(), "includeAppConfig": false }),
        )
        .await;
        let data = exported.result.expect("export must succeed")["data"].as_str().unwrap().to_string();

        let decrypted = call(&s, "transfer.decrypt", json!({ "password": "correct horse battery", "data": data })).await;
        let out = decrypted.result.expect("decrypt must succeed");
        assert_eq!(out["accounts"], bundle["accounts"]);
        assert_eq!(out["appConfig"], Value::Null);
        assert_eq!(out["aiEndpointKey"], Value::Null);
    }

    #[tokio::test]
    async fn export_refuses_a_bundle_with_a_missing_secret() {
        let s = st();
        let mut bundle = sample_bundle();
        bundle["accounts"][0]["password"] = json!("");
        let resp = call(&s, "transfer.export", json!({ "password": "correct horse battery", "bundle": bundle, "includeAppConfig": false })).await;
        let msg = resp.error.expect("incomplete bundle must be refused").message;
        assert!(msg.starts_with("E_TRANSFER_INCOMPLETE"), "{msg}");
        assert!(msg.contains("a@x.com"), "{msg}");
    }

    #[tokio::test]
    async fn export_refuses_a_password_under_twelve_characters() {
        let s = st();
        let resp = call(&s, "transfer.export", json!({ "password": "short-11-ch", "bundle": sample_bundle(), "includeAppConfig": false })).await;
        assert_eq!(resp.error.expect("must be refused").message, "E_TRANSFER_PASSWORD");
    }

    #[tokio::test]
    async fn decrypt_with_the_wrong_password_is_a_generic_error() {
        let s = st();
        let exported = call(
            &s,
            "transfer.export",
            json!({ "password": "correct horse battery", "bundle": sample_bundle(), "includeAppConfig": false }),
        )
        .await;
        let data = exported.result.unwrap()["data"].as_str().unwrap().to_string();

        let resp = call(&s, "transfer.decrypt", json!({ "password": "wrong horse battery!", "data": data })).await;
        assert_eq!(resp.error.expect("must be refused").message, "E_TRANSFER_DECRYPT");
    }

    #[tokio::test]
    async fn decrypt_rejects_bad_base64_as_a_format_error() {
        let s = st();
        let resp = call(&s, "transfer.decrypt", json!({ "password": "correct horse battery", "data": "%%%not-base64%%%" })).await;
        let msg = resp.error.expect("must be refused").message;
        assert!(msg.starts_with("E_TRANSFER_FORMAT"), "{msg}");
    }

    #[tokio::test]
    async fn export_with_app_config_carries_the_snapshot_and_the_ai_key() {
        let _guard = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MAILVAULT_TEST_AI_KEY", dir.path().join("ai_key"));
        credentials::store_ai_endpoint_key_guarded("sk-export-test".to_string()).await.unwrap();

        let s = st();
        let exported = call(
            &s,
            "transfer.export",
            json!({ "password": "correct horse battery", "bundle": sample_bundle(), "includeAppConfig": true }),
        )
        .await;
        let data = exported.result.expect("export must succeed")["data"].as_str().unwrap().to_string();
        let decrypted = call(&s, "transfer.decrypt", json!({ "password": "correct horse battery", "data": data })).await;
        let out = decrypted.result.unwrap();
        assert_eq!(out["aiEndpointKey"], "sk-export-test");
        assert!(out["appConfig"].is_object(), "{out}");
        assert_eq!(out["appConfig"]["tags"], json!([]));

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }

    #[tokio::test]
    async fn apply_config_stores_the_ai_key_only_when_the_target_has_none() {
        let _guard = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MAILVAULT_TEST_AI_KEY", dir.path().join("ai_key"));

        let s = st();
        let resp = call(&s, "transfer.apply_config", json!({ "appConfig": {}, "accountMap": {}, "aiEndpointKey": "sk-imported" })).await;
        let body = resp.result.expect("apply_config must succeed");
        assert_eq!(body["aiKeyStored"], true);
        assert_eq!(credentials::resolve_ai_endpoint_key_guarded().await.unwrap().as_deref(), Some("sk-imported"));

        // A second import, now that the target has a key, must not clobber it.
        let resp2 = call(&s, "transfer.apply_config", json!({ "appConfig": {}, "accountMap": {}, "aiEndpointKey": "sk-other" })).await;
        assert_eq!(resp2.result.unwrap()["aiKeyStored"], false);
        assert_eq!(credentials::resolve_ai_endpoint_key_guarded().await.unwrap().as_deref(), Some("sk-imported"));

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }

    #[tokio::test]
    async fn apply_config_merges_tags_and_reports_the_count() {
        let s = st();
        let cfg = json!({ "tags": [{ "id": "f1", "name": "Work", "color": "#00f", "position": 0 }] });
        let resp = call(&s, "transfer.apply_config", json!({ "appConfig": cfg, "accountMap": {} })).await;
        let body = resp.result.expect("apply_config must succeed");
        assert_eq!(body["tagsAdded"], 1);
        assert_eq!(body["aiKeyStored"], false);
    }
}
