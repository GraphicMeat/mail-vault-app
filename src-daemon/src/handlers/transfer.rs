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
            // A missing or non-object bundle must never reach the `["appConfig"] =`
            // writes below: `Value::IndexMut` panics on anything but an object,
            // and a silently-defaulted `{}` would export a file with no accounts.
            let mut bundle_val = match params.get("bundle") {
                Some(v) if v.is_object() => v.clone(),
                _ => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing or invalid bundle".to_string())),
            };
            let obj = bundle_val.as_object_mut().expect("validated as an object above");
            // The daemon owns the file format, not the caller: stamp the real
            // version in rather than trusting (or requiring) one in `bundle`.
            obj.insert("formatVersion".to_string(), Value::from(1));

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
                let obj = bundle_val.as_object_mut().expect("validated as an object above");
                obj.insert("appConfig".to_string(), cfg_json);
                // A locked/denied keychain must not fail the export — the app
                // account data still matters even if the AI key doesn't come
                // along.
                let key = credentials::resolve_ai_endpoint_key_guarded().await.ok().flatten();
                let obj = bundle_val.as_object_mut().expect("validated as an object above");
                obj.insert("aiEndpointKey".to_string(), key.map(Value::String).unwrap_or(Value::Null));
            } else {
                let obj = bundle_val.as_object_mut().expect("validated as an object above");
                obj.insert("appConfig".to_string(), Value::Null);
                obj.insert("aiEndpointKey".to_string(), Value::Null);
            }

            // Serialize straight into the zeroized buffer rather than building
            // a throwaway `Vec` with `to_vec` and copying it in, so the
            // plaintext bundle exists in as few places as possible before it
            // is wiped.
            let mut plaintext: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(4096));
            if let Err(e) = serde_json::to_writer(&mut *plaintext, &bundle_val) {
                return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()));
            }

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
            // Required: an empty map is a valid choice (nothing maps), but a
            // caller that forgot to send one at all must not silently merge
            // every account-scoped row as "not on this machine".
            let account_map: HashMap<String, String> = match params.get("accountMap") {
                Some(v) if v.is_object() => match serde_json::from_value(v.clone()) {
                    Ok(m) => m,
                    Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("accountMap: {e}"))),
                },
                _ => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountMap".to_string())),
            };

            let app_dir = state.app_dir.clone();
            let report = match blocking(move || app_db::with(&app_dir, |conn| app_config::merge(conn, &cfg, &account_map))).await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) | Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };

            // The app.db merge above already committed. A keychain hiccup on
            // the AI key must never turn into an RPC error at this point — the
            // caller would have no way to tell "nothing merged" from "merged,
            // but the key didn't make it" apart, and would be tempted to retry
            // the whole import. Report it as a plain (non-secret) flag instead.
            // Never overwrite a key the target already has; an absent key in
            // the bundle (nothing to offer) is the same as "don't store".
            let (ai_key_stored, ai_key_error) = match params.get("aiEndpointKey").and_then(Value::as_str) {
                Some(key) => match credentials::resolve_ai_endpoint_key_guarded().await {
                    Ok(None) => match credentials::store_ai_endpoint_key_guarded(key.to_string()).await {
                        Ok(()) => (true, false),
                        Err(_) => (false, true),
                    },
                    Ok(Some(_)) => (false, false),
                    Err(_) => (false, true),
                },
                None => (false, false),
            };

            let mut body = match serde_json::to_value(&report) {
                Ok(Value::Object(m)) => m,
                _ => serde_json::Map::new(),
            };
            body.insert("aiKeyStored".to_string(), Value::Bool(ai_key_stored));
            body.insert("aiKeyError".to_string(), Value::Bool(ai_key_error));
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

    /// Fix round 1, Important 1: a non-object `bundle` used to reach
    /// `bundle_val["appConfig"] = ...`, which panics on anything but an
    /// object. It must be refused before that, not crash the handler.
    #[tokio::test]
    async fn export_refuses_a_non_object_bundle_without_panicking() {
        let s = st();
        for bad in [json!([]), json!("x"), json!(5), Value::Null] {
            let resp = call(&s, "transfer.export", json!({ "password": "correct horse battery", "bundle": bad, "includeAppConfig": false })).await;
            assert_eq!(resp.error.expect("must be refused").code, ipc::INVALID_PARAMS);
        }
    }

    #[tokio::test]
    async fn export_refuses_a_missing_bundle() {
        let s = st();
        let resp = call(&s, "transfer.export", json!({ "password": "correct horse battery", "includeAppConfig": false })).await;
        assert_eq!(resp.error.expect("must be refused").code, ipc::INVALID_PARAMS);
    }

    /// Fix round 1 ruling: the daemon stamps `formatVersion` itself, so a
    /// caller need not (and cannot) get it wrong.
    #[tokio::test]
    async fn export_stamps_format_version_even_when_the_caller_omits_it() {
        let s = st();
        let mut bundle = sample_bundle();
        bundle.as_object_mut().unwrap().remove("formatVersion");
        let exported = call(&s, "transfer.export", json!({ "password": "correct horse battery", "bundle": bundle, "includeAppConfig": false })).await;
        let data = exported.result.expect("export must succeed")["data"].as_str().unwrap().to_string();

        let decrypted = call(&s, "transfer.decrypt", json!({ "password": "correct horse battery", "data": data })).await;
        assert_eq!(decrypted.result.expect("decrypt must succeed")["formatVersion"], 1);
    }

    /// A well-formed container whose JSON bundle claims a future format must
    /// be refused, not partially trusted.
    #[tokio::test]
    async fn decrypt_refuses_a_bundle_declaring_a_future_format_version() {
        let mut bundle = sample_bundle();
        bundle["formatVersion"] = json!(2);
        let plaintext = serde_json::to_vec(&bundle).unwrap();
        let container = crypto::encrypt("correct horse battery", &plaintext).unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(&container);

        let s = st();
        let resp = call(&s, "transfer.decrypt", json!({ "password": "correct horse battery", "data": data })).await;
        let msg = resp.error.expect("must be refused").message;
        assert!(msg.starts_with("E_TRANSFER_FORMAT"), "{msg}");
    }

    /// A keychain that cannot be read (forced here by pointing the test file
    /// bypass at a directory, so the read fails rather than just missing)
    /// must not stop the account/app-config export from producing a file.
    #[tokio::test]
    async fn export_still_produces_a_file_when_the_ai_key_read_fails() {
        let _guard = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        // A directory, not a file: `resolve_ai_endpoint_key`'s `read_to_string`
        // fails with something other than `NotFound`, forcing the `Err` arm
        // rather than the ordinary "nothing stored yet" `Ok(None)`.
        std::env::set_var("MAILVAULT_TEST_AI_KEY", dir.path());

        let s = st();
        let exported = call(
            &s,
            "transfer.export",
            json!({ "password": "correct horse battery", "bundle": sample_bundle(), "includeAppConfig": true }),
        )
        .await;
        let body = exported.result.expect("export must still succeed");
        assert!(body["data"].as_str().is_some_and(|d| !d.is_empty()));

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }

    /// Fix round 1, Important 2: an AI-key failure must never turn into an
    /// RPC error once `merge` has already committed the app.db change.
    #[tokio::test]
    async fn apply_config_reports_an_ai_key_error_instead_of_failing_after_the_merge_committed() {
        let _guard = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MAILVAULT_TEST_AI_KEY", dir.path());

        let s = st();
        let cfg = json!({ "tags": [{ "id": "f1", "name": "Work", "color": "#00f", "position": 0 }] });
        let resp = call(&s, "transfer.apply_config", json!({ "appConfig": cfg, "accountMap": {}, "aiEndpointKey": "sk-x" })).await;
        let body = resp.result.expect("must succeed despite the keychain failure");
        assert_eq!(body["aiKeyStored"], false);
        assert_eq!(body["aiKeyError"], true);
        // The merge itself must still have landed.
        assert_eq!(body["tagsAdded"], 1);

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }

    #[tokio::test]
    async fn apply_config_requires_account_map() {
        let s = st();
        let resp = call(&s, "transfer.apply_config", json!({ "appConfig": {} })).await;
        assert_eq!(resp.error.expect("must be refused").code, ipc::INVALID_PARAMS);

        let resp2 = call(&s, "transfer.apply_config", json!({ "appConfig": {}, "accountMap": "not-a-map" })).await;
        assert_eq!(resp2.error.expect("must be refused").code, ipc::INVALID_PARAMS);
    }
}
