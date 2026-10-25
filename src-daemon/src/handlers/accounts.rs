//! Callable native account capability; application adapter cutover is pending.
//!
//! - `accounts.list {}`: `{accounts, version}` (`recovered` names where the
//!   list came from when the file on disk is broken).
//! - `accounts.get {id}`: `{account, version}`, `account` null when unknown.
//! - `accounts.put {entries | entry, ifAbsent?, baseVersion?}`: each entry is
//!   merged onto the one with its id, or appended; with `ifAbsent` only ids
//!   and identities the list lacks are appended. `{version, changed}`.
//! - `accounts.remove {ids | id, baseVersion?}`, `accounts.reorder {ids,
//!   baseVersion?}`, `accounts.replace_all {entries, baseVersion?}`: `{version,
//!   changed}`.
//!
//! The params are never named `account`: `oauth_tokens::inject` puts tokens
//! into such params, and `inject` skips this namespace as well. A write that
//! changed something emits `accounts-changed {ids, version}`: ids only.
//! Errors are catalog keys (`errors.accounts*`).

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::accounts_doc::{self, AccountsError};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const CHANGED_EVENT: &str = "accounts-changed";

pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    if !accounts_doc::METHODS.contains(&method) {
        return None;
    }
    let doc = accounts_doc::shared(&state.app_dir);
    let preserved = if accounts_doc::writes(method) {
        legacy_secrets_kept(state, &doc).await
    } else {
        None
    };
    #[cfg(test)]
    pause_after_preservation(&state.app_dir).await;
    let method = method.to_string();
    let params = params.clone();
    // File IO and an fsync: off the async workers.
    let joined = tokio::task::spawn_blocking(move || {
        let policy = preserved
            .as_ref()
            .map(accounts_doc::LiveScrub::Preserved)
            .unwrap_or(accounts_doc::LiveScrub::Preserve);
        accounts_doc::run(&doc, &method, &params, policy)
    })
    .await;
    let outcome =
        joined.unwrap_or_else(|_| Err(AccountsError::Io("accounts task failed".to_string())));
    Some(match outcome {
        Ok(out) => {
            if let Some(change) = &out.changed {
                state.events.emit(
                    CHANGED_EVENT,
                    json!({"ids": change.changed, "version": change.version}),
                );
            }
            RpcResponse::success(id, out.reply)
        }
        Err(e) => {
            let code = if matches!(e, AccountsError::Invalid) {
                ipc::INVALID_PARAMS
            } else {
                ipc::INTERNAL_ERROR
            };
            RpcResponse::error(id, code, e.catalog_key())
        }
    })
}

/// Before a write may scrub the list: every account it still holds a
/// password or token for (an older release wrote them there) is in the
/// keychain blob. One the blob lacks is copied in first, as the old app
/// used it (its own entry, secrets included); one the blob already holds
/// keeps the blob's record. The original listing is returned as ephemeral
/// proof, including on the no-legacy path. Failure cannot authorize blanket
/// live cleanup of retained records. No document lock crosses credential IO.
async fn legacy_secrets_kept(
    state: &Arc<DaemonState>,
    doc: &Arc<mailvault_core::json_doc::JsonDoc>,
) -> Option<accounts_doc::Listing> {
    let read = Arc::clone(doc);
    let listed = tokio::task::spawn_blocking(move || accounts_doc::list(&read)).await;
    let Ok(Ok(listed)) = listed else { return None };
    // A per-ID map cannot preserve ambiguous legacy rows. Skip credential
    // IO entirely and retain their live fields for this requested mutation.
    if !accounts_doc::legacy_secrets_representable(&listed.accounts) {
        return None;
    }
    let legacy = accounts_doc::legacy_secrets(&listed.accounts);
    if legacy.is_empty() {
        return Some(listed);
    }
    let records: std::collections::HashMap<String, String> = legacy.into_iter().collect();
    let count = records.len();
    match crate::credentials::change_credentials(
        state,
        crate::credentials::CredChange::SaveIfAbsent(records),
    )
    .await
    {
        Ok((ids, _version)) => {
            if !ids.is_empty() {
                tracing::info!("accounts: {} legacy account record(s) copied into the keychain before the list is scrubbed", ids.len());
            }
            Some(listed)
        }
        Err(e) => {
            tracing::warn!("accounts: {count} entr(ies) still hold secrets and the keychain could not take them ({}); left in place", e.catalog_key());
            None
        }
    }
}

#[cfg(test)]
type PreservationPause = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);
#[cfg(test)]
fn preservation_pauses(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, PreservationPause>> {
    static PAUSES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, PreservationPause>>,
    > = std::sync::OnceLock::new();
    PAUSES.get_or_init(Default::default)
}
#[cfg(test)]
async fn pause_after_preservation(path: &std::path::Path) {
    let pause = preservation_pauses().lock().unwrap().get(path).cloned();
    if let Some((entered, release)) = pause {
        entered.notify_one();
        release.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};

    struct TestScope {
        dir: tempfile::TempDir,
        _restore: crate::credentials::TestEnvRestore,
        _env: std::sync::MutexGuard<'static, ()>,
    }
    impl std::ops::Deref for TestScope {
        type Target = tempfile::TempDir;
        fn deref(&self) -> &Self::Target {
            &self.dir
        }
    }
    fn rig() -> (TestScope, Arc<DaemonState>) {
        let env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let restore = crate::credentials::TestEnvRestore::capture();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(
            "MAILVAULT_TEST_CREDENTIALS",
            dir.path().join("credentials.json"),
        );
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        (
            TestScope {
                dir,
                _restore: restore,
                _env: env,
            },
            state,
        )
    }

    fn on_disk(dir: &tempfile::TempDir) -> Value {
        serde_json::from_slice(&std::fs::read(dir.path().join("accounts.json")).unwrap()).unwrap()
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
        let resp = handle_request_for_test(state, method, params).await;
        match resp.error {
            Some(e) => Err(e.message),
            None => Ok(resp.result.unwrap_or(Value::Null)),
        }
    }

    struct PauseGuard(std::path::PathBuf, PreservationPause);
    impl Drop for PauseGuard {
        fn drop(&mut self) {
            preservation_pauses().lock().unwrap().remove(&self.0);
            self.1 .1.notify_one();
        }
    }
    async fn snapshot_race(initial_secret: bool) {
        let (dir, state) = rig();
        let a = if initial_secret {
            json!({"id":"a", "password":"legacy-A"})
        } else {
            json!({"id":"a"})
        };
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, json!([a.clone()]).to_string()).unwrap();
        let creds = dir.path().join("credentials.json");
        std::fs::write(&creds, "{}").unwrap();
        let pause = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
        );
        preservation_pauses()
            .lock()
            .unwrap()
            .insert(state.app_dir.clone(), pause.clone());
        let guard = PauseGuard(state.app_dir.clone(), pause.clone());
        let mut rx = state.events.subscribe();
        let requested = call(&state, "accounts.put", json!({"entry":{"id":"x"}}));
        let intervene = async {
            pause.0.notified().await;
            let blob: Value = serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap();
            assert_eq!(
                blob.get("a").is_some(),
                initial_secret,
                "preservation completed before pause"
            );
            // A compatibility writer completes while preservation holds no document lock.
            let bytes = serde_json::to_vec(&json!([a, {"id":"b", "password":"only-B"}])).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            // A core read can also finish while the route is paused.
            accounts_doc::run(
                &accounts_doc::shared(dir.path()),
                "accounts.reorder",
                &json!({"ids":[]}),
                accounts_doc::LiveScrub::Preserve,
            )
            .unwrap();
            pause.1.notify_one();
            bytes
        };
        let (result, rewritten) = tokio::join!(requested, intervene);
        drop(guard);
        let blob: Value = serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap();
        assert!(
            blob.get("b").is_none(),
            "B was not in the preserved snapshot"
        );
        assert_eq!(result, Err("errors.accountsConflict".to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), rewritten);
        assert!(!dir.path().join("accounts.json.bak1").exists());
        while let Ok(line) = rx.try_recv() {
            let (name, _) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            assert_ne!(name, CHANGED_EVENT);
        }
        // Only an explicit fresh caller attempt can preserve B and apply X.
        let fresh = call(&state, "accounts.list", json!({})).await.unwrap()["version"]
            .as_u64()
            .unwrap();
        call(
            &state,
            "accounts.put",
            json!({"entry":{"id":"x"}, "baseVersion":fresh}),
        )
        .await
        .unwrap();
        let blob: Value = serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap();
        let b: Value = serde_json::from_str(blob["b"].as_str().unwrap()).unwrap();
        assert_eq!(b["password"], "only-B");
        assert!(on_disk(&dir)
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == "x"));
        assert!(!std::fs::read_to_string(&path).unwrap().contains("only-B"));
    }
    async fn unrepresentable_legacy_retains_fields(entries: Value) {
        let (dir, state) = rig();
        let path = dir.path().join("accounts.json");
        let creds = dir.path().join("credentials.json");
        std::fs::write(&path, entries.to_string()).unwrap();
        std::fs::write(&creds, "{}").unwrap();
        call(&state, "accounts.put", json!({"entry":{"id":"x"}}))
            .await
            .unwrap();
        let live = on_disk(&dir);
        assert_eq!(
            &live.as_array().unwrap()[..entries.as_array().unwrap().len()],
            entries.as_array().unwrap().as_slice(),
            "retained legacy entries must not lose their fields"
        );
        assert_eq!(
            std::fs::read_to_string(&creds).unwrap(),
            "{}",
            "an unrepresentable list skips preservation entirely"
        );
        assert!(
            !std::fs::read_to_string(dir.path().join("accounts.json.bak1"))
                .unwrap()
                .contains("only-secret")
        );
    }
    #[tokio::test]
    async fn unrepresentable_legacy_missing_id_is_retained() {
        unrepresentable_legacy_retains_fields(json!([{"password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_empty_id_is_retained() {
        unrepresentable_legacy_retains_fields(json!([{"id":"", "password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_nonstring_id_is_retained() {
        unrepresentable_legacy_retains_fields(json!([{"id":7, "password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_duplicate_secret_ids_are_retained() {
        unrepresentable_legacy_retains_fields(
            json!([{"id":"a", "password":"only-secret-A"},{"id":"a", "password":"only-secret-B"}]),
        )
        .await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_id_duplicated_by_clean_record_is_retained() {
        unrepresentable_legacy_retains_fields(
            json!([{"id":"a", "password":"only-secret"},{"id":"a"}]),
        )
        .await;
    }

    #[tokio::test]
    async fn changed_legacy_snapshot_is_refused_before_live_scrub() {
        snapshot_race(true).await;
    }
    #[tokio::test]
    async fn changed_no_legacy_snapshot_is_refused_before_live_scrub() {
        snapshot_race(false).await;
    }

    #[tokio::test]
    async fn every_method_is_routed_through_the_server_chain() {
        let (_dir, state) = rig();
        for method in accounts_doc::METHODS {
            let resp = handle_request_for_test(&state, method, json!({})).await;
            if let Some(e) = &resp.error {
                assert!(
                    e.message.starts_with("errors.accounts"),
                    "{method} is not routed: {}",
                    e.message
                );
            }
        }
    }

    #[tokio::test]
    async fn put_list_remove_round_trip_and_keep_the_file_format() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            "[\n  {\n    \"id\": \"old\",\n    \"email\": \"old@x.test\"\n  }\n]",
        )
        .unwrap();
        let listed = call(&state, "accounts.list", json!({})).await.unwrap();
        assert_eq!(
            listed["accounts"],
            json!([{"id": "old", "email": "old@x.test"}])
        );
        let v0 = listed["version"].as_u64().unwrap();

        let put = call(
            &state,
            "accounts.put",
            json!({"entries": [{"id": "a", "email": "a@x.test"}]}),
        )
        .await
        .unwrap();
        assert_eq!(put["changed"], json!(["a"]));
        assert!(put["version"].as_u64().unwrap() > v0);
        assert_eq!(
            on_disk(&dir),
            json!([{"id": "old", "email": "old@x.test"}, {"id": "a", "email": "a@x.test"}])
        );

        let got = call(&state, "accounts.get", json!({"id": "a"}))
            .await
            .unwrap();
        assert_eq!(got["account"], json!({"id": "a", "email": "a@x.test"}));

        call(&state, "accounts.remove", json!({"ids": ["old"]}))
            .await
            .unwrap();
        assert_eq!(on_disk(&dir), json!([{"id": "a", "email": "a@x.test"}]));
        let stale = call(
            &state,
            "accounts.replace_all",
            json!({"entries": [], "baseVersion": v0}),
        )
        .await;
        assert_eq!(stale, Err("errors.accountsConflict".to_string()));
        assert_eq!(
            call(&state, "accounts.put", json!({"entries": [{"email": "x"}]})).await,
            Err("errors.accountsInvalid".to_string())
        );
    }

    /// The daemon holds a token for the account: a request naming its param
    /// `account` would get it injected. Neither the event, the reply nor the
    /// file may ever carry a secret.
    #[tokio::test]
    async fn no_secret_reaches_the_file_the_event_or_the_reply() {
        let (dir, state) = rig();
        let mut rx = state.events.subscribe();
        let secret = "ya29.SECRET-token";
        let reply = call(
            &state,
            "accounts.put",
            json!({
                "entry": {"id": "g", "email": "g@gmail.test", "authType": "oauth2", "oauth2AccessToken": secret, "oauth2RefreshToken": secret, "password": secret},
                "account": {"id": "g", "email": "g@gmail.test", "authType": "oauth2"},
            }),
        )
        .await
        .unwrap();
        assert!(!reply.to_string().contains(secret));
        let text = std::fs::read_to_string(dir.path().join("accounts.json")).unwrap();
        assert!(
            !text.contains(secret) && !text.contains("oauth2AccessToken"),
            "{text}"
        );
        let line = rx.try_recv().expect("an event");
        assert!(
            !line.contains("g@gmail.test") && !line.contains(secret),
            "the event carries ids only: {line}"
        );
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
        assert_eq!(name, CHANGED_EVENT);
        assert_eq!(payload, json!({"ids": ["g"], "version": reply["version"]}));
        // A write that changes nothing is silent.
        call(
            &state,
            "accounts.put",
            json!({"entry": {"id": "g", "email": "g@gmail.test", "authType": "oauth2"}}),
        )
        .await
        .unwrap();
        assert!(rx.try_recv().is_err());
    }

    /// An older release left passwords and tokens in accounts.json. The
    /// first write copies each one the keychain lacks into it, then the list
    /// and its backup are written without them.
    #[tokio::test]
    async fn legacy_secrets_move_into_the_keychain_before_the_list_is_scrubbed() {
        let (dir, state) = rig();
        let creds = dir.path().join("credentials.json");
        let kept = json!({"id": "b", "email": "b@x.test", "password": "keychain-pw"}).to_string();
        std::fs::write(&creds, json!({"b": kept}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let legacy = json!([
            {"id": "a", "email": "a@x.test", "password": "LEGACY-only-copy"},
            {"id": "b", "email": "b@x.test", "password": "LEGACY-stale"},
        ]);
        std::fs::write(
            dir.path().join("accounts.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let put = call(
            &state,
            "accounts.put",
            json!({"entry": {"id": "c", "email": "c@x.test"}}),
        )
        .await;
        let blob: std::collections::HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(&creds).unwrap()).unwrap();
        put.unwrap();

        let a: Value = serde_json::from_str(&blob["a"]).unwrap();
        assert_eq!(
            a["password"],
            json!("LEGACY-only-copy"),
            "the only copy of a's password is now in the keychain"
        );
        assert_eq!(
            blob["b"], kept,
            "the keychain's own record wins over the file's"
        );
        for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("accounts") {
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                assert!(
                    !text.contains("LEGACY"),
                    "{name} still holds a legacy secret"
                );
            }
        }
        assert!(dir.path().join("accounts.json.bak1").exists());
    }

    /// The keychain cannot be read: nothing is moved and the list keeps its
    /// secrets (no loss), but the backup the write takes holds none.
    #[tokio::test]
    async fn an_unreadable_keychain_leaves_the_legacy_secrets_in_place() {
        let (dir, state) = rig();
        let creds = dir.path().join("credentials.json");
        std::fs::write(&creds, "{\"broken").unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([{"id": "a", "password": "LEGACY-only-copy"}]).to_string(),
        )
        .unwrap();
        let put = call(&state, "accounts.put", json!({"entry": {"id": "c"}})).await;
        put.unwrap();
        assert!(std::fs::read_to_string(dir.path().join("accounts.json"))
            .unwrap()
            .contains("LEGACY-only-copy"));
        assert!(
            !std::fs::read_to_string(dir.path().join("accounts.json.bak1"))
                .unwrap()
                .contains("LEGACY")
        );
        assert_eq!(std::fs::read_to_string(&creds).unwrap(), "{\"broken");
    }

    #[tokio::test]
    async fn six_native_routes_complete_successfully() {
        let (_dir, state) = rig();
        assert_eq!(
            call(&state, "accounts.list", json!({})).await.unwrap()["accounts"],
            json!([])
        );
        call(
            &state,
            "accounts.put",
            json!({"entries":[{"id":"a"},{"id":"b"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&state, "accounts.get", json!({"id":"a"}))
                .await
                .unwrap()["account"],
            json!({"id":"a"})
        );
        call(&state, "accounts.reorder", json!({"ids":["b"]}))
            .await
            .unwrap();
        assert_eq!(
            call(&state, "accounts.list", json!({})).await.unwrap()["accounts"][0]["id"],
            "b"
        );
        call(&state, "accounts.remove", json!({"id":"b"}))
            .await
            .unwrap();
        call(
            &state,
            "accounts.replace_all",
            json!({"entries":[{"id":"c", "password":"incoming"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&state, "accounts.list", json!({})).await.unwrap()["accounts"],
            json!([{"id":"c"}])
        );
    }
    #[tokio::test]
    async fn scrub_only_emits_once_then_clean_noop_is_stable() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([{"id":"a", "password":"only-A"}]).to_string(),
        )
        .unwrap();
        let mut rx = state.events.subscribe();
        let first = call(&state, "accounts.reorder", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert_eq!(first["changed"], json!(["a"]));
        let mut account_events = 0;
        let mut credential_events = 0;
        while let Ok(line) = rx.try_recv() {
            let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if name == CHANGED_EVENT {
                account_events += 1;
                assert_eq!(payload["ids"], json!(["a"]));
            }
            if name == crate::handlers::credentials::CHANGED_EVENT {
                credential_events += 1;
            }
        }
        assert_eq!(account_events, 1);
        assert_eq!(
            credential_events, 1,
            "N1 finalizer owns one preservation notification"
        );
        let bytes = std::fs::read(dir.path().join("accounts.json")).unwrap();
        let second = call(&state, "accounts.reorder", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert_eq!(second, json!({"version":first["version"], "changed":[]}));
        assert_eq!(
            std::fs::read(dir.path().join("accounts.json")).unwrap(),
            bytes
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(
            call(&state, "accounts.put", json!({"entry":{}}))
                .await
                .unwrap_err(),
            "errors.accountsInvalid"
        );
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn the_route_logs_counts_and_keys_only() {
        let src = include_str!("accounts.rs");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        for line in code
            .lines()
            .filter(|l| l.contains("info!(") || l.contains("warn!(") || l.contains("error!("))
        {
            assert!(
                !line.contains("records")
                    && !line.contains("params")
                    && !line.contains("listed")
                    && !line.contains("ids)"),
                "{line}"
            );
        }
    }
}
