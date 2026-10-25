//! `credentials.*`: the app reads and changes the account credentials blob
//! (the keychain entry `com.mailvault.app` / `credentials`, the sealed store
//! on a portable drive). These routes expose native per-record capability;
//! the existing app adapters still use their Tauri credential commands.
//!
//! - `credentials.get {}`: what `get_credentials` answered: `{status,
//!   credentials}` or `{status, message}`.
//! - `credentials.save {records: {id: recordJson}}`: each record replaces the
//!   one stored under its id; every other account is kept. `{saved, version}`.
//! - `credentials.update {id, fields, chain?}`: top-level fields merged into
//!   the stored record (the OAuth2 pair the daemon refreshed). `{updated,
//!   version}`. With `chain` (the pair's grant fingerprints, from
//!   `oauth2.take_refreshed`) only over a stored record of that grant:
//!   another grant stored (a newer sign-in) answers `{updated: false,
//!   staleGrant: true}` and writes nothing; a refresh token is merged only
//!   when it is a new one of that grant.
//! - `credentials.delete {ids}`: `{deleted, version}`.
//!
//! A change that wrote emits `credentials-changed {ids, version}` (ids only)
//! and does what `oauth2.credentials_changed` does. Errors are catalog keys
//! (`errors.keychainUnavailable`: nothing was written; `errors.keychainWriteFailed`;
//! `errors.credentialsInvalid`). No record, password or token is ever logged.

use crate::credentials::{self, CredChange, CredError};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) const CHANGED_EVENT: &str = "credentials-changed";

pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    let (change, key) = match method {
        "credentials.get" => return Some(RpcResponse::success(id, credentials::app_read().await)),
        "credentials.save" => (save(params), "saved"),
        "credentials.update" => (update(params), "updated"),
        "credentials.delete" => (delete(params), "deleted"),
        _ => return None,
    };
    let Some(change) = change else {
        return Some(RpcResponse::error(
            id,
            ipc::INVALID_PARAMS,
            CredError::Invalid.catalog_key(),
        ));
    };
    Some(match credentials::change_credentials(change).await {
        Err(CredError::StaleGrant) => RpcResponse::success(
            id,
            json!({"updated": false, "staleGrant": true, "version": credentials::write_generation()}),
        ),
        Ok((ids, version)) => {
            if !ids.is_empty() {
                crate::handlers::oauth2::credentials_written(state);
                state
                    .events
                    .emit(CHANGED_EVENT, json!({"ids": ids, "version": version}));
            }
            let answer = if key == "updated" {
                json!(!ids.is_empty())
            } else {
                json!(ids)
            };
            let mut reply = serde_json::Map::new();
            reply.insert(key.to_string(), answer);
            reply.insert("version".to_string(), json!(version));
            RpcResponse::success(id, Value::Object(reply))
        }
        Err(e) => {
            let code = if e == CredError::Invalid {
                ipc::INVALID_PARAMS
            } else {
                ipc::INTERNAL_ERROR
            };
            RpcResponse::error(id, code, e.catalog_key())
        }
    })
}

fn save(params: &Value) -> Option<CredChange> {
    let records: HashMap<String, String> =
        serde_json::from_value(params.get("records")?.clone()).ok()?;
    Some(CredChange::Save(records))
}

fn update(params: &Value) -> Option<CredChange> {
    let id = params
        .get("id")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    let fields = params.get("fields")?.as_object()?.clone();
    let chain = match params.get("chain") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    Some(CredChange::Update { id, fields, chain })
}

fn delete(params: &Value) -> Option<CredChange> {
    let ids = params
        .get("ids")?
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    Some(CredChange::Delete(ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};
    use std::time::Duration;

    const SECRET: &str = "hunter2-SECRET-pw";

    struct Rig {
        _dir: tempfile::TempDir,
        state: Arc<DaemonState>,
        creds: std::path::PathBuf,
        previous_env: Option<std::ffi::OsString>,
        _env: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            match self.previous_env.take() {
                Some(v) => std::env::set_var("MAILVAULT_TEST_CREDENTIALS", v),
                None => std::env::remove_var("MAILVAULT_TEST_CREDENTIALS"),
            }
        }
    }

    /// The debug file bypass, never the real keychain: the test box has an
    /// installed MailVault whose entry this must not touch.
    fn rig(blob: Option<Value>) -> Rig {
        let env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous_env = std::env::var_os("MAILVAULT_TEST_CREDENTIALS");
        let dir = tempfile::tempdir().unwrap();
        let creds = dir.path().join("credentials.json");
        if let Some(blob) = blob {
            std::fs::write(&creds, blob.to_string()).unwrap();
        }
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        Rig {
            _dir: dir,
            state,
            creds,
            previous_env,
            _env: env,
        }
    }

    fn record(id: &str, password: &str) -> String {
        json!({"id": id, "email": format!("{id}@x.test"), "imapHost": "imap.x.test", "authType": "password", "password": password}).to_string()
    }

    fn stored(rig: &Rig) -> HashMap<String, String> {
        serde_json::from_str(&std::fs::read_to_string(&rig.creds).unwrap()).unwrap()
    }

    async fn call(rig: &Rig, method: &str, params: Value) -> Result<Value, String> {
        let resp = handle_request_for_test(&rig.state, method, params).await;
        match resp.error {
            Some(e) => Err(e.message),
            None => Ok(resp.result.unwrap_or(Value::Null)),
        }
    }

    #[tokio::test]
    async fn get_answers_the_shape_get_credentials_answered() {
        let rig = rig(None);
        assert_eq!(
            call(&rig, "credentials.get", json!({})).await.unwrap(),
            json!({"status": "empty", "credentials": {}})
        );
        std::fs::write(&rig.creds, json!({"a": record("a", "pa")}).to_string()).unwrap();
        let got = call(&rig, "credentials.get", json!({})).await.unwrap();
        assert_eq!(got["status"], json!("granted"));
        assert_eq!(got["credentials"]["a"], json!(record("a", "pa")));
        // Unparseable: a failure, never "empty" (an empty answer lets the
        // next whole-blob write drop every account), and no content quoted.
        std::fs::write(&rig.creds, format!("{{\"a\": {SECRET}")).unwrap();
        let broken = call(&rig, "credentials.get", json!({})).await.unwrap();
        assert!(
            broken["status"] == json!("unavailable") || broken["status"] == json!("denied"),
            "{broken}"
        );
        assert!(!broken.to_string().contains(SECRET));
    }

    #[tokio::test]
    async fn save_replaces_its_own_records_and_keeps_every_other_account() {
        let rig = rig(Some(
            json!({"old": record("old", "keep"), "a": record("a", "stale")}),
        ));
        let reply = call(
            &rig,
            "credentials.save",
            json!({"records": {"a": record("a", "new"), "b": record("b", "pb")}}),
        )
        .await
        .unwrap();
        assert_eq!(reply["saved"], json!(["a", "b"]));
        let blob = stored(&rig);
        assert_eq!(blob.len(), 3);
        assert_eq!(
            blob["old"],
            record("old", "keep"),
            "an account the request did not name is untouched"
        );
        assert_eq!(blob["a"], record("a", "new"));
        // Saving the same again writes nothing and keeps the version.
        let again = call(
            &rig,
            "credentials.save",
            json!({"records": {"b": record("b", "pb")}}),
        )
        .await
        .unwrap();
        assert_eq!(again["saved"], json!([]));
        assert_eq!(again["version"], reply["version"]);
    }

    #[tokio::test]
    async fn a_fresh_install_starts_from_an_empty_blob() {
        let rig = rig(None);
        call(
            &rig,
            "credentials.save",
            json!({"records": {"a": record("a", "pa")}}),
        )
        .await
        .unwrap();
        assert_eq!(stored(&rig).keys().collect::<Vec<_>>(), vec!["a"]);
    }

    /// The trap the app's `saveAccounts` guarded: a blob that could not be
    /// read must never be replaced by one holding only the new account.
    #[tokio::test]
    async fn an_unreadable_blob_refuses_every_change_and_is_left_as_it_was() {
        let rig = rig(None);
        let broken = format!("{{\"old\": \"{SECRET}\"");
        std::fs::write(&rig.creds, &broken).unwrap();
        for (method, params) in [
            (
                "credentials.save",
                json!({"records": {"a": record("a", "pa")}}),
            ),
            (
                "credentials.update",
                json!({"id": "old", "fields": {"oauth2AccessToken": "x"}}),
            ),
            ("credentials.delete", json!({"ids": ["old"]})),
        ] {
            let err = call(&rig, method, params).await.unwrap_err();
            assert_eq!(err, "errors.keychainUnavailable", "{method}");
        }
        assert_eq!(std::fs::read_to_string(&rig.creds).unwrap(), broken);
    }

    #[tokio::test]
    async fn update_merges_fields_into_the_stored_record_only() {
        let rig = rig(Some(
            json!({"g": json!({"id": "g", "authType": "oauth2", "oauth2RefreshToken": "rt-1", "oauth2ClientId": "c"}).to_string(), "p": record("p", "pp")}),
        ));
        let reply = call(
            &rig,
            "credentials.update",
            json!({"id": "g", "fields": {"oauth2AccessToken": "at-2", "oauth2ExpiresAt": 99}}),
        )
        .await
        .unwrap();
        assert_eq!(reply["updated"], json!(true));
        let g: Value = serde_json::from_str(&stored(&rig)["g"]).unwrap();
        assert_eq!(
            g,
            json!({"id": "g", "authType": "oauth2", "oauth2RefreshToken": "rt-1", "oauth2ClientId": "c", "oauth2AccessToken": "at-2", "oauth2ExpiresAt": 99})
        );
        assert_eq!(stored(&rig)["p"], record("p", "pp"));
        let missing = call(
            &rig,
            "credentials.update",
            json!({"id": "gone", "fields": {"oauth2AccessToken": "x"}}),
        )
        .await
        .unwrap();
        assert_eq!(missing["updated"], json!(false));
        assert!(
            !stored(&rig).contains_key("gone"),
            "an update never creates a record"
        );
    }

    #[tokio::test]
    async fn delete_removes_only_the_named_ids() {
        let rig = rig(Some(
            json!({"a": record("a", "pa"), "b": record("b", "pb")}),
        ));
        let reply = call(&rig, "credentials.delete", json!({"ids": ["a", "zz"]}))
            .await
            .unwrap();
        assert_eq!(reply["deleted"], json!(["a"]));
        assert_eq!(stored(&rig).keys().collect::<Vec<_>>(), vec!["b"]);
    }

    #[tokio::test]
    async fn twenty_parallel_saves_to_different_ids_all_survive() {
        let rig = rig(Some(json!({"old": record("old", "keep")})));
        let tasks: Vec<_> = (0..20)
            .map(|i| {
                let state = Arc::clone(&rig.state);
                tokio::spawn(async move {
                    let id = format!("acct-{i}");
                    handle_request_for_test(
                        &state,
                        "credentials.save",
                        json!({"records": {id.clone(): record(&id, "p")}}),
                    )
                    .await
                })
            })
            .collect();
        let mut versions = Vec::new();
        for t in tasks {
            let resp = t.await.unwrap();
            assert!(resp.error.is_none(), "{:?}", resp.error);
            versions.push(resp.result.unwrap()["version"].as_u64().unwrap());
        }
        versions.sort();
        versions.dedup();
        assert_eq!(
            versions.len(),
            20,
            "one change at a time, each its own version"
        );
        let blob = stored(&rig);
        assert_eq!(blob.len(), 21);
        for i in 0..20 {
            assert!(blob.contains_key(&format!("acct-{i}")), "acct-{i} lost");
        }
    }

    #[tokio::test]
    async fn malformed_requests_are_refused_with_a_catalog_key() {
        let rig = rig(Some(json!({"a": record("a", "pa")})));
        for (method, params) in [
            ("credentials.save", json!({})),
            ("credentials.save", json!({"records": {"a": 5}})),
            ("credentials.save", json!({"records": {"a": "not json"}})),
            ("credentials.save", json!({"records": {"a": "[1]"}})),
            ("credentials.save", json!({"records": {"": "{}"}})),
            ("credentials.update", json!({"id": "a"})),
            ("credentials.delete", json!({"ids": [1]})),
        ] {
            assert_eq!(
                call(&rig, method, params.clone()).await.unwrap_err(),
                "errors.credentialsInvalid",
                "{method} {params}"
            );
        }
        assert_eq!(stored(&rig).len(), 1);
    }

    /// Ids only on the event; no record in a reply, an event or an error.
    #[tokio::test]
    async fn no_secret_reaches_an_event_a_reply_or_an_error() {
        let rig = rig(Some(json!({"a": record("a", "pa")})));
        let mut rx = rig.state.events.subscribe();
        let reply = call(
            &rig,
            "credentials.save",
            json!({"records": {"s": record("s", SECRET)}}),
        )
        .await
        .unwrap();
        assert!(!reply.to_string().contains(SECRET));
        let line = rx.try_recv().expect("an event");
        assert!(
            !line.contains(SECRET) && !line.contains("s@x.test"),
            "{line}"
        );
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
        assert_eq!(name, CHANGED_EVENT);
        assert_eq!(payload, json!({"ids": ["s"], "version": reply["version"]}));
        let err = call(
            &rig,
            "credentials.save",
            json!({"records": {"s": format!("{{\"password\": \"{SECRET}\"")}}),
        )
        .await
        .unwrap_err();
        assert!(!err.contains(SECRET));
        // A change that writes nothing is silent.
        call(
            &rig,
            "credentials.save",
            json!({"records": {"s": record("s", SECRET)}}),
        )
        .await
        .unwrap();
        assert!(rx.try_recv().is_err());
    }

    fn oauth_record(rt: &str, at: &str) -> Value {
        json!({"id": "g", "email": "g@gmail.test", "authType": "oauth2", "oauth2Provider": "google",
               "oauth2ClientId": "client-1", "oauth2RefreshToken": rt, "oauth2AccessToken": at, "oauth2ExpiresAt": 1})
    }

    fn fp(record: &Value, rt: Option<&str>) -> String {
        crate::oauth_tokens::record_fingerprint(record, rt).unwrap()
    }

    /// Window A holds grant A; window B reconnects (grant B, RT2). The pair
    /// the daemon refreshed for grant A, saved late from A's stale copy,
    /// must not touch the new sign-in.
    #[tokio::test]
    async fn a_stale_grants_update_never_overwrites_a_newer_sign_in() {
        let rig = rig(None);
        let grant_a = oauth_record("RT1", "at-1");
        call(
            &rig,
            "credentials.save",
            json!({"records": {"g": grant_a.to_string()}}),
        )
        .await
        .unwrap();
        let grant_b = oauth_record("RT2", "at-reconnect");
        call(
            &rig,
            "credentials.save",
            json!({"records": {"g": grant_b.to_string()}}),
        )
        .await
        .unwrap();
        let before = stored(&rig);
        let mut rx = rig.state.events.subscribe();
        let reply = call(
            &rig,
            "credentials.update",
            json!({"id": "g", "fields": {"oauth2AccessToken": "at-refreshed-A", "oauth2RefreshToken": "RT1", "oauth2ExpiresAt": 9}, "chain": [fp(&grant_a, None)]}),
        )
        .await
        .unwrap();
        assert_eq!(reply["updated"], json!(false));
        assert_eq!(reply["staleGrant"], json!(true));
        assert_eq!(stored(&rig), before, "the new sign-in is untouched");
        assert!(rx.try_recv().is_err(), "nothing written, nothing announced");
    }

    #[tokio::test]
    async fn a_same_grant_update_saves_a_rotated_pair_and_never_a_foreign_refresh_token() {
        let rig = rig(None);
        let record = oauth_record("RT1", "at-1");
        call(
            &rig,
            "credentials.save",
            json!({"records": {"g": record.to_string()}}),
        )
        .await
        .unwrap();
        let chain = json!([fp(&record, None), fp(&record, Some("RT3"))]);
        let reply = call(
            &rig,
            "credentials.update",
            json!({"id": "g", "fields": {"oauth2AccessToken": "at-3", "oauth2RefreshToken": "RT3", "oauth2ExpiresAt": 30}, "chain": chain}),
        )
        .await
        .unwrap();
        assert_eq!(reply["updated"], json!(true));
        let g: Value = serde_json::from_str(&stored(&rig)["g"]).unwrap();
        assert_eq!(
            (
                g["oauth2AccessToken"].clone(),
                g["oauth2RefreshToken"].clone(),
                g["oauth2ExpiresAt"].clone()
            ),
            (json!("at-3"), json!("RT3"), json!(30))
        );
        // A refresh token the chain does not name is never merged; the
        // access token of the same grant still is.
        let chain = json!([fp(&g, None)]);
        call(&rig, "credentials.update", json!({"id": "g", "fields": {"oauth2AccessToken": "at-4", "oauth2RefreshToken": "RT-foreign"}, "chain": chain}))
            .await
            .unwrap();
        let g: Value = serde_json::from_str(&stored(&rig)["g"]).unwrap();
        assert_eq!(
            (
                g["oauth2AccessToken"].clone(),
                g["oauth2RefreshToken"].clone()
            ),
            (json!("at-4"), json!("RT3"))
        );
    }

    /// A write that outlives its clock (a keychain prompt nobody answers)
    /// keeps the lock until it returns, so a change asked for meanwhile is
    /// refused at once, and nothing that write lands overwrites a later one.
    #[tokio::test]
    async fn a_parked_write_makes_the_next_change_busy_and_never_clobbers_a_later_one() {
        use std::sync::atomic::Ordering::SeqCst;
        let rig = rig(Some(json!({"old": record("old", "keep")})));
        struct ResetWriteTest;
        impl Drop for ResetWriteTest {
            fn drop(&mut self) {
                crate::credentials::TEST_WRITE_TIMEOUT_MS.store(0, SeqCst);
                crate::credentials::TEST_WRITE_GATE
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
            }
        }
        let _reset = ResetWriteTest;
        crate::credentials::TEST_WRITE_TIMEOUT_MS.store(300, SeqCst);
        let (release, parked) = std::sync::mpsc::channel::<()>();
        *crate::credentials::TEST_WRITE_GATE.lock().unwrap() = Some(parked);

        let first = call(
            &rig,
            "credentials.save",
            json!({"records": {"a": record("a", "pa")}}),
        )
        .await;
        let started = std::time::Instant::now();
        let second = call(
            &rig,
            "credentials.save",
            json!({"records": {"b": record("b", "pb")}}),
        )
        .await;
        let elapsed = started.elapsed();
        let second_wrote = stored(&rig).contains_key("b");

        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while crate::credentials::WRITE_PARKED.load(SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the parked write returned");
        // Assert only after releasing and joining the synthetic late write.
        assert_eq!(
            first,
            Err("errors.keychainWriteFailed".to_string()),
            "the reply timed out; its write completed later"
        );
        assert_eq!(second, Err("errors.keychainBusy".to_string()));
        assert!(
            elapsed < Duration::from_secs(2),
            "busy at once, not queued: {elapsed:?}"
        );
        assert!(!second_wrote);
        let third = call(
            &rig,
            "credentials.save",
            json!({"records": {"c": record("c", "pc")}}),
        )
        .await;
        crate::credentials::TEST_WRITE_TIMEOUT_MS.store(0, SeqCst);
        third.unwrap();
        let blob = stored(&rig);
        let mut ids: Vec<&String> = blob.keys().collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["a", "c", "old"],
            "the parked write landed first, the later change on top of it"
        );
    }

    // The runtime keeps a second worker available so Drop can release and join
    // a synthetic blocking job even while an assertion unwinds this test.
    struct ParkedWrite {
        release: Option<std::sync::mpsc::Sender<()>>,
        entered: std::sync::mpsc::Receiver<()>,
        done: Option<std::sync::mpsc::Receiver<()>>,
    }

    impl ParkedWrite {
        fn arm() -> Self {
            use crate::credentials::{TEST_WRITE_ENTERED, TEST_WRITE_FINISHED, TEST_WRITE_GATE, TEST_WRITE_TIMEOUT_MS};
            let (release, gate) = std::sync::mpsc::channel();
            let (started, entered) = std::sync::mpsc::channel();
            let (finished, done) = std::sync::mpsc::channel();
            *TEST_WRITE_GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(gate);
            *TEST_WRITE_ENTERED.lock().unwrap_or_else(|e| e.into_inner()) = Some(started);
            *TEST_WRITE_FINISHED.lock().unwrap_or_else(|e| e.into_inner()) = Some(finished);
            TEST_WRITE_TIMEOUT_MS.store(300, std::sync::atomic::Ordering::SeqCst);
            Self { release: Some(release), entered, done: Some(done) }
        }

        fn wait_until_entered(&self) {
            self.entered.recv_timeout(Duration::from_secs(5)).expect("the synthetic write entered its gate");
        }

        fn finish(&mut self) {
            self.release.take();
            self.done.take().unwrap().recv_timeout(Duration::from_secs(5)).expect("terminal completion and exclusion release");
        }
    }

    impl Drop for ParkedWrite {
        fn drop(&mut self) {
            self.release.take();
            if let Some(done) = self.done.take() {
                let _ = done.recv_timeout(Duration::from_secs(5));
            }
            crate::credentials::TEST_WRITE_TIMEOUT_MS.store(0, std::sync::atomic::Ordering::SeqCst);
            crate::credentials::TEST_WRITE_GATE.lock().unwrap_or_else(|e| e.into_inner()).take();
            crate::credentials::TEST_WRITE_ENTERED.lock().unwrap_or_else(|e| e.into_inner()).take();
            crate::credentials::TEST_WRITE_FINISHED.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }

    struct RecheckAck {
        owner: usize,
        done: std::sync::mpsc::Receiver<()>,
    }

    impl RecheckAck {
        fn arm(state: &Arc<DaemonState>) -> Self {
            let owner = Arc::as_ptr(state) as usize;
            let (sender, done) = std::sync::mpsc::channel();
            *crate::oauth_tokens::TEST_RECHECK_DONE.lock().unwrap_or_else(|e| e.into_inner()) = Some((owner, sender));
            Self { owner, done }
        }

        fn finish(&self) {
            self.done.recv_timeout(Duration::from_secs(5)).expect("the actual quiet recheck finished");
        }
    }

    impl Drop for RecheckAck {
        fn drop(&mut self) {
            let mut hook = crate::oauth_tokens::TEST_RECHECK_DONE.lock().unwrap_or_else(|e| e.into_inner());
            if hook.as_ref().is_some_and(|(owner, _)| *owner == self.owner) {
                hook.take();
            }
        }
    }

    fn fresh_oauth(rt: &str, at: &str) -> Value {
        let mut record = oauth_record(rt, at);
        record["imapHost"] = json!("imap.gmail.com");
        record["oauth2ExpiresAt"] = json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 3_600_000);
        record
    }

    async fn prime_cached_grant(rig: &Rig, token: &str) {
        let got = crate::oauth_tokens::access_token(&rig.state, "g", crate::oauth_tokens::Read::Quiet).await.unwrap();
        assert!(got.as_deref() == Some(token), "the seeded grant must be loaded");
        assert!(rig.state.tokens.has_trusted_token_for_test("g"), "a trusted cache entry must exist before the parked write");
    }

    fn changed_events(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Vec<Value> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|line| mailvault_core::daemon_ipc::parse_event(&line))
            .filter_map(|(name, payload)| (name == CHANGED_EVENT).then_some(payload))
            .collect()
    }

    fn token_waiter(rig: &Rig) -> Arc<crate::abd_worker::JobHandle> {
        use mailvault_core::abd::{DateScope, DeleteMode, JobFile, Mode, NewJob, Provider, Scope, Timing};
        let job = JobFile::create(NewJob {
            account_id: "g".into(), account_email: "g@gmail.test".into(), host: "imap.gmail.com".into(),
            provider: Provider::Imap, mode: Mode::ArchiveDelete, timing: Timing::AfterAll,
            delete_mode: DeleteMode::MoveToTrashAndEmpty,
            scope: Scope { folders: vec!["INBOX".into()], dates: DateScope::All, date_choice: "all".into(), year_bounds: vec![] },
            now_ms: rig.state.clock.now_ms(),
        });
        let handle = crate::abd_worker::JobHandle::new(&job);
        *handle.parked.lock().unwrap_or_else(|e| e.into_inner()) = Some(crate::abd_worker::Parked::Token);
        rig.state.abd.jobs.lock().unwrap_or_else(|e| e.into_inner()).insert("g".into(), Arc::clone(&handle));
        handle
    }

    async fn parked_reply(rig: &Rig, gate: &ParkedWrite, method: &'static str, params: Value) -> crate::ipc::RpcResponse {
        let state = Arc::clone(&rig.state);
        let pending = tokio::spawn(async move { handle_request_for_test(&state, method, params).await });
        gate.wait_until_entered();
        pending.await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_save_invalidates_cached_grant_after_timeout() {
        let old = fresh_oauth("synthetic-old-grant", "synthetic-old-token");
        let new = fresh_oauth("synthetic-new-grant", "synthetic-new-token");
        let rig = rig(Some(json!({"g": old.to_string(), "other": record("other", "keep")})));
        prime_cached_grant(&rig, "synthetic-old-token").await;
        let mut rx = rig.state.events.subscribe();
        let mut gate = ParkedWrite::arm();
        let timed = parked_reply(&rig, &gate, "credentials.save", json!({"records":{"g":new.to_string()}})).await;
        let busy = call(&rig, "credentials.delete", json!({"ids":["other"]})).await;
        let premature = changed_events(&mut rx);
        gate.finish();
        assert_eq!(timed.error.unwrap().message, "errors.keychainWriteFailed");
        assert_eq!(busy, Err("errors.keychainBusy".into()));
        assert!(premature.is_empty());
        assert_eq!(stored(&rig)["g"], new.to_string());
        assert_eq!(stored(&rig)["other"], record("other", "keep"));
        let got = crate::oauth_tokens::access_token(&rig.state, "g", crate::oauth_tokens::Read::Quiet).await.unwrap();
        assert!(got.as_deref() == Some("synthetic-new-token"), "late save must stop serving the trusted old grant");
        let events = changed_events(&mut rx);
        assert_eq!(events, vec![json!({"ids":["g"],"version":credentials::write_generation()})]);
        assert!(changed_events(&mut rx).is_empty(), "one terminal change event only");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_delete_invalidates_cached_grant_after_timeout() {
        let old = fresh_oauth("synthetic-old-grant", "synthetic-old-token");
        let rig = rig(Some(json!({"g":old.to_string()})));
        prime_cached_grant(&rig, "synthetic-old-token").await;
        let mut rx = rig.state.events.subscribe();
        let mut gate = ParkedWrite::arm();
        let timed = parked_reply(&rig, &gate, "credentials.delete", json!({"ids":["g"]})).await;
        gate.finish();
        assert_eq!(timed.error.unwrap().message, "errors.keychainWriteFailed");
        assert!(!stored(&rig).contains_key("g"));
        let got = crate::oauth_tokens::access_token(&rig.state, "g", crate::oauth_tokens::Read::Quiet).await;
        assert!(matches!(got, Err(crate::oauth_tokens::TokenError { kind: crate::oauth_tokens::FailKind::NoRecord, .. })), "late delete must stop serving its cached grant");
        assert_eq!(changed_events(&mut rx), vec![json!({"ids":["g"],"version":credentials::write_generation()})]);
        assert!(changed_events(&mut rx).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_failed_write_invalidates_trust_without_changed_notice_or_wake() {
        use futures::FutureExt;
        let old = fresh_oauth("synthetic-old-grant", "synthetic-old-token");
        let rig = rig(Some(json!({"g":old.to_string()})));
        prime_cached_grant(&rig, "synthetic-old-token").await;
        let waiter = token_waiter(&rig);
        let quiet = RecheckAck::arm(&rig.state);
        let mut rx = rig.state.events.subscribe();
        let before = credentials::write_generation();
        let mut gate = ParkedWrite::arm();
        let timed = parked_reply(&rig, &gate, "credentials.save", json!({"records":{"g":fresh_oauth("synthetic-new-grant","synthetic-new-token").to_string()}})).await;
        std::fs::remove_file(&rig.creds).unwrap();
        std::fs::create_dir(&rig.creds).unwrap();
        gate.finish();
        assert_eq!(timed.error.unwrap().message, "errors.keychainWriteFailed");
        assert!(credentials::write_generation() > before);
        assert!(!rig.state.tokens.has_trusted_token_for_test("g"), "terminal uncertainty invalidates token trust");
        let got = crate::oauth_tokens::access_token(&rig.state, "g", crate::oauth_tokens::Read::Quiet).await;
        assert!(matches!(got, Err(crate::oauth_tokens::TokenError { kind: crate::oauth_tokens::FailKind::Unreadable, .. })), "an unreadable store cannot be hidden by a cached grant");
        assert!(changed_events(&mut rx).is_empty());
        assert!(waiter.ctl.wake.notified().now_or_never().is_none());
        assert!(matches!(quiet.done.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_saved_refresh_wakes_token_wait_and_rechecks_unsaved_pair() {
        let mut old = fresh_oauth("synthetic-original-refresh", "synthetic-expired-token");
        old["oauth2ExpiresAt"] = json!(1);
        let rig = rig(Some(json!({"g":old.to_string()})));
        let _mock = crate::handlers::oauth2::test_token_mock(vec![(200,json!({"access_token":"synthetic-refreshed-token","refresh_token":"synthetic-rotated-refresh","expires_in":3600}).to_string())]);
        let token = crate::oauth_tokens::access_token(&rig.state, "g", crate::oauth_tokens::Read::Quiet).await.unwrap();
        assert!(token.as_deref() == Some("synthetic-refreshed-token"));
        let offered = call(&rig, "oauth2.take_refreshed", json!({})).await.unwrap();
        assert_eq!(offered["tokens"].as_array().unwrap().len(), 1);
        let pair = &offered["tokens"][0];
        let mut saved = old;
        saved["oauth2AccessToken"] = pair["accessToken"].clone();
        saved["oauth2RefreshToken"] = pair["refreshToken"].clone();
        saved["oauth2ExpiresAt"] = pair["expiresAt"].clone();
        let waiter = token_waiter(&rig);
        let quiet = RecheckAck::arm(&rig.state);
        let mut rx = rig.state.events.subscribe();
        let mut gate = ParkedWrite::arm();
        let timed = parked_reply(&rig, &gate, "credentials.save", json!({"records":{"g":saved.to_string()}})).await;
        gate.finish();
        quiet.finish();
        assert_eq!(timed.error.unwrap().message, "errors.keychainWriteFailed");
        tokio::time::timeout(Duration::from_secs(5), waiter.ctl.wake.notified()).await.expect("the real parked-token control was woken");
        let offered = call(&rig, "oauth2.take_refreshed", json!({})).await.unwrap();
        assert!(offered["tokens"].as_array().unwrap().is_empty(), "the real quiet recheck observed the saved pair");
        assert_eq!(changed_events(&mut rx), vec![json!({"ids":["g"],"version":credentials::write_generation()})]);
        assert!(changed_events(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn timely_changes_notify_once_and_noops_or_refusals_stay_silent() {
        use futures::FutureExt;
        let old = fresh_oauth("synthetic-old-grant", "synthetic-old-token");
        let rig = rig(Some(json!({"g":old.to_string()})));
        prime_cached_grant(&rig, "synthetic-old-token").await;
        let new = fresh_oauth("synthetic-new-grant", "synthetic-new-token");
        let mut rx = rig.state.events.subscribe();
        let saved = call(&rig, "credentials.save", json!({"records":{"g":new.to_string()}})).await.unwrap();
        assert_eq!(changed_events(&mut rx), vec![json!({"ids":["g"],"version":saved["version"]})]);
        prime_cached_grant(&rig, "synthetic-new-token").await;
        let waiter = token_waiter(&rig);
        let version = credentials::write_generation();
        for (method, params) in [
            ("credentials.save", json!({"records":{"g":new.to_string()}})),
            ("credentials.delete", json!({"ids":["missing"]})),
            ("credentials.update", json!({"id":"g","fields":{"oauth2AccessToken":"synthetic-stale"},"chain":[fp(&old,None)]})),
            ("credentials.save", json!({})),
        ] {
            let reply = call(&rig, method, params).await;
            assert!(reply.is_ok() || reply == Err("errors.credentialsInvalid".into()));
            assert_eq!(credentials::write_generation(), version);
            assert!(changed_events(&mut rx).is_empty());
            assert!(waiter.ctl.wake.notified().now_or_never().is_none());
        }
        let deleted = call(&rig, "credentials.delete", json!({"ids":["g"]})).await.unwrap();
        assert_eq!(changed_events(&mut rx), vec![json!({"ids":["g"],"version":deleted["version"]})]);
        let got = crate::oauth_tokens::access_token(&rig.state, "g", crate::oauth_tokens::Read::Quiet).await;
        assert!(matches!(got, Err(crate::oauth_tokens::TokenError { kind: crate::oauth_tokens::FailKind::NoRecord, .. })));
    }

    #[test]
    fn the_handler_and_the_writer_log_no_record() {
        for src in [
            include_str!("credentials.rs"),
            include_str!("../credentials.rs"),
        ] {
            let code = &src[..src.rfind("#[cfg(test)]\nmod tests").unwrap()];
            for line in code
                .lines()
                .filter(|l| l.contains("info!(") || l.contains("warn!(") || l.contains("error!("))
            {
                assert!(
                    !line.contains("record")
                        && !line.contains("blob)")
                        && !line.contains("json)")
                        && !line.contains("params"),
                    "{line}"
                );
            }
        }
    }
}
