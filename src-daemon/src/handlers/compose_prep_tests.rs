use super::*;
use serde_json::json;
fn seed() -> (tempfile::TempDir, Arc<DaemonState>) {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(app.join("accounts.json"),json!([{"id":"one","email":"owner@example.test"},{"id":"two","email":"other@example.test"}]).to_string()).unwrap();
    std::fs::write(app.join("frontend-settings.json"),json!({"mailvault-settings":{"version":1,"state":{"aliases":{"two":[{"address":"alias@example.test"}]},"sendAsAddresses":{"one":"default@example.test"}}}}).to_string()).unwrap();
    (dir, DaemonState::for_test(vault, app, true))
}
fn msg() -> Value {
    json!({"kind":"message","requestId":"request","accountId":"one","pickedFrom":"removed@example.test","mode":"replyAll","original":{"header":{"from":{"address":"sender@example.test"},"to":[{"address":"owner@example.test"},{"address":"other@example.test"},{"address":"default@example.test"},{"address":"alias@example.test"},{"address":"removed@example.test"},{"address":"friend@example.test"}],"bcc":[{"address":"bcc-sentinel@example.test"}],"subject":"Topic"},"html":"<p>body-sentinel</p>"},"presentation":{"originalLabel":"Original","dateLabel":"","subjectCandidate":"Re: Topic"}})
}
fn chk() -> Value {
    json!({"requestId":"c","accountId":"one","fromAddress":"owner@example.test","mode":"new","to":"friend@example.test","cc":"","bcc":"explicit@example.test","subject":"","authoredBodyText":"words","attachmentCount":0,"timeZone":"UTC"})
}
async fn rpc(s: &Arc<DaemonState>, method: &str, p: Value) -> Result<Value, String> {
    let out = crate::server::handle_request_for_test(s, method, p).await;
    out.result.ok_or_else(|| out.error.unwrap().message)
}
#[tokio::test]
async fn compose_prep_routes_are_read_only_and_remove_every_own_identity() {
    let (_dir, s) = seed();
    let accounts = std::fs::read(s.app_dir.join("accounts.json")).unwrap();
    let settings = std::fs::read(s.app_dir.join("frontend-settings.json")).unwrap();
    let before_vault: Vec<_> = std::fs::read_dir(&s.data_dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    let answer = rpc(&s, "compose.reply_context", msg()).await.unwrap();
    assert_eq!(answer["to"], "sender@example.test, friend@example.test");
    assert_eq!(answer["bcc"], "");
    assert!(!answer.to_string().contains("bcc-sentinel"));
    assert_eq!(
        rpc(&s, "compose.check", chk()).await.unwrap()["kind"],
        "ready"
    );
    assert_eq!(
        std::fs::read(s.app_dir.join("accounts.json")).unwrap(),
        accounts
    );
    assert_eq!(
        std::fs::read(s.app_dir.join("frontend-settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::read_dir(&s.data_dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>(),
        before_vault
    );
    assert!(crate::search_index::is_foreground_method(
        "compose.reply_context"
    ));
    assert!(crate::search_index::is_foreground_method("compose.check"));
}
#[tokio::test]
async fn compose_prep_fails_closed_on_accounts_or_settings_read_failure() {
    for file in ["accounts.json", "frontend-settings.json"] {
        for bytes in ["{broken", "{}"] {
            let (_dir, s) = seed();
            std::fs::write(s.app_dir.join(file), bytes).unwrap();
            for method in ["compose.reply_context", "compose.check"] {
                let p = if method.ends_with("check") {
                    chk()
                } else {
                    msg()
                };
                let error = rpc(&s, method, p).await.unwrap_err();
                assert!(!error.contains("sentinel"));
            }
        }
    }
    let (_dir, s) = seed();
    std::fs::remove_file(s.app_dir.join("frontend-settings.json")).unwrap();
    assert!(rpc(&s, "compose.reply_context", msg()).await.is_err());
}
#[tokio::test]
async fn compose_prep_rejects_recovery_stale_version_and_present_malformed_maps() {
    let (_dir, s) = seed();
    let answer = rpc(&s, "compose.reply_context", msg()).await.unwrap();
    let version = answer["settingsVersion"].as_u64().unwrap();
    let mut p = msg();
    p["expectedSettingsVersion"] = json!(version + 1);
    assert_eq!(
        rpc(&s, "compose.reply_context", p).await.unwrap_err(),
        "errors.settingsConflict"
    );
    // Prime a good in-memory snapshot, then prove recovery cannot authorize recipients.
    std::fs::write(s.app_dir.join("frontend-settings.json"), "{torn").unwrap();
    assert!(rpc(&s, "compose.reply_context", msg()).await.is_err());
    for state in [
        json!({"aliases":[]}),
        json!({"aliases":{"one":"bad"}}),
        json!({"sendAsAddresses":{"one":3}}),
    ] {
        std::fs::write(
            s.app_dir.join("frontend-settings.json"),
            json!({"mailvault-settings":{"version":1,"state":state}}).to_string(),
        )
        .unwrap();
        assert!(rpc(&s, "compose.reply_context", msg()).await.is_err());
    }
}
#[tokio::test]
async fn compose_prep_coherent_default_store_keeps_optional_map_defaults() {
    let (_dir, s) = seed();
    std::fs::write(
        s.app_dir.join("frontend-settings.json"),
        json!({"mailvault-settings":{"version":1,"state":{}}}).to_string(),
    )
    .unwrap();
    let out = rpc(&s, "compose.reply_context", msg()).await.unwrap();
    assert_eq!(
        out["to"],
        "sender@example.test, default@example.test, alias@example.test, friend@example.test"
    );
    assert_eq!(
        rpc(&s, "compose.check", chk()).await.unwrap()["kind"],
        "ready"
    );
}
#[tokio::test]
async fn compose_prep_generations_are_verified_against_the_same_values() {
    let (_dir, s) = seed();
    let loaded = load(&s.app_dir).unwrap();
    std::fs::write(
        s.app_dir.join("accounts.json"),
        json!([{"id":"one","email":"changed@example.test"}]).to_string(),
    )
    .unwrap();
    assert!(unchanged(&s.app_dir, &loaded).is_err());
    let loaded = load(&s.app_dir).unwrap();
    SettingsDoc::shared(&s.app_dir).patch(&json!({"mailvault-settings":{"state":{"aliases":{"one":[{"address":"new@example.test"}]}}}}),None).unwrap();
    assert!(unchanged(&s.app_dir, &loaded).is_err());
}
#[tokio::test]
async fn compose_prep_bounds_input_and_does_not_wait_on_vault_locks() {
    let (_dir, s) = seed();
    // No body/attachment/network lookup, even with descriptors in the header.
    let mut p = msg();
    p["original"]["header"]["attachments"] =
        json!([{"_source":{"accountId":"missing","mailbox":"never","uid":1}}]);
    let _vault_gate = s.vault_gate.write().unwrap();
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        rpc(&s, "compose.reply_context", p),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(out["bodyAvailable"], true);
    let mut p = chk();
    p["authoredBodyText"] = json!("x".repeat(compose_prep::MAX_REQUEST_BYTES + 1));
    assert_eq!(rpc(&s, "compose.check", p).await.unwrap()["kind"], "ready");
    let mut p = chk();
    p["premium"] = json!(true);
    assert!(rpc(&s, "compose.check", p).await.is_err());
    assert!(
        rpc(&s, "compose.check", json!({"password":"body-sentinel"}))
            .await
            .unwrap_err()
            .starts_with("compose.")
    );
}

#[tokio::test]
async fn compose_prep_check_uses_the_native_injected_clock() {
    let (_dir, s) = seed();
    s.clock.set(1792886400000);
    let mut p = chk();
    p["sendPlan"] = json!({"kind":"in","minutes":6});
    assert_eq!(
        rpc(&s, "compose.check", p).await.unwrap()["route"],
        json!({"draft":{"localTime":"2026-10-25T00:06","tz":"UTC"}})
    );
}

// Test-only barriers identify the exact point after preparation and before its
// generation check. The production route has no hook registry or wait.
type Hook = Arc<dyn Fn() + Send + Sync>;
static HOOKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Hook>>,
> = std::sync::LazyLock::new(Default::default);
pub(super) fn before_finish(app: &Path) {
    let hook = HOOKS.lock().unwrap().get(app).cloned();
    if let Some(hook) = hook {
        hook();
    }
}
#[tokio::test]
async fn compose_prep_pending_account_or_alias_change_never_publishes_a_result() {
    for mutate_accounts in [true, false] {
        let (_dir, s) = seed();
        let started = Arc::new(tokio::sync::Notify::new());
        let (release, wait) = std::sync::mpsc::channel();
        let wait = std::sync::Mutex::new(wait);
        let notify = started.clone();
        HOOKS.lock().unwrap().insert(
            s.app_dir.clone(),
            Arc::new(move || {
                notify.notify_one();
                wait.lock().unwrap().recv().unwrap();
            }),
        );
        let state = s.clone();
        let pending =
            tokio::spawn(async move { rpc(&state, "compose.reply_context", msg()).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        if mutate_accounts {
            std::fs::write(
                s.app_dir.join("accounts.json"),
                json!([{"id":"one","email":"changed@example.test"}]).to_string(),
            )
            .unwrap();
        } else {
            SettingsDoc::shared(&s.app_dir).patch(&json!({"mailvault-settings":{"state":{"aliases":{"one":[{"address":"new@example.test"}]}}}}),None).unwrap();
        }
        release.send(()).unwrap();
        let result = pending.await.unwrap();
        HOOKS.lock().unwrap().remove(&s.app_dir);
        assert_eq!(result.unwrap_err(), "errors.settingsConflict");
    }
}

#[tokio::test]
async fn compose_prep_distinguishes_empty_accounts_from_unreadable_records() {
    let (_dir, s) = seed();
    std::fs::write(s.app_dir.join("accounts.json"), "[]").unwrap();
    assert_eq!(
        rpc(&s, "compose.check", chk()).await.unwrap()["key"],
        "compose.noAccountSelected"
    );
    std::fs::remove_file(s.app_dir.join("accounts.json")).unwrap();
    assert_eq!(
        rpc(&s, "compose.check", chk()).await.unwrap()["key"],
        "compose.noAccountSelected"
    );
    std::fs::create_dir(s.app_dir.join("accounts.json")).unwrap();
    assert_eq!(
        rpc(&s, "compose.check", chk()).await.unwrap_err(),
        "compose.preparationUnavailable"
    );
}

#[path = "../../../src-core/tests/support/compose_prep_supplement.rs"]
mod supplement;
#[tokio::test]
async fn compose_prep_routes_preserve_complete_large_message_bytes() {
    let (_dir, s) = seed();
    let mut refusals = Vec::new();
    for case in supplement::fixture()["largeCases"].as_array().unwrap() {
        match rpc(&s, "compose.reply_context", supplement::request(case)).await {
            Ok(out) => supplement::assert_digests(case, &out),
            Err(error) => refusals.push((case["spec"]["name"].clone(), error)),
        }
    }
    assert!(
        refusals.is_empty(),
        "source-supported complete route requests refused: {refusals:?}"
    );
}
#[tokio::test]
async fn compose_prep_large_worker_does_not_block_an_unrelated_runtime_request() {
    let (_dir, s) = seed();
    let fixture = supplement::fixture();
    let case = fixture["largeCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["spec"]["name"] == "aggregate-over-2MiB")
        .unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let (release, wait) = std::sync::mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    let notify = started.clone();
    HOOKS.lock().unwrap().insert(
        s.app_dir.clone(),
        Arc::new(move || {
            notify.notify_one();
            let _ = wait
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(5));
        }),
    );
    let state = s.clone();
    let p = supplement::request(case);
    let mut pending = tokio::spawn(async move { rpc(&state, "compose.reply_context", p).await });
    tokio::select! {
        _=started.notified()=>{},
        result=&mut pending=>panic!("large preparation rejected before worker progress control: {:?}",result.unwrap().err()),
    }
    let was_pending = !pending.is_finished();
    let other = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        crate::server::handle_request_for_test(&s, "ping", json!({})),
    )
    .await;
    release.send(()).unwrap();
    HOOKS.lock().unwrap().remove(&s.app_dir);
    let out = pending.await.unwrap().unwrap();
    assert!(was_pending);
    assert!(other.unwrap().result.is_some());
    supplement::assert_digests(case, &out);
}
#[tokio::test]
async fn compose_prep_account_file_bound_remains_independent() {
    let (_dir, s) = seed();
    std::fs::write(
        s.app_dir.join("accounts.json"),
        " ".repeat(compose_prep::MAX_REQUEST_BYTES + 1) + "[]",
    )
    .unwrap();
    assert_eq!(
        rpc(&s, "compose.reply_context", msg()).await.unwrap_err(),
        "compose.preparationUnavailable"
    );
}

#[tokio::test]
async fn compose_prep_large_check_is_read_only_and_keeps_ipc_responsive() {
    let (_dir, s) = seed();
    SettingsDoc::shared(&s.app_dir).patch(&json!({"mailvault-settings":{"state":{"billingProfile":{"hasSubscription":true,"status":"active"}}}}),None).unwrap();
    let accounts = std::fs::read(s.app_dir.join("accounts.json")).unwrap();
    let settings = std::fs::read(s.app_dir.join("frontend-settings.json")).unwrap();
    let before: Vec<_> = std::fs::read_dir(&s.data_dir).unwrap().map(|e| e.unwrap().path()).collect();
    let started = Arc::new(tokio::sync::Notify::new());
    let (release, wait) = std::sync::mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    let notify = started.clone();
    HOOKS.lock().unwrap().insert(s.app_dir.clone(), Arc::new(move || {
        notify.notify_one();
        let _ = wait.lock().unwrap().recv_timeout(std::time::Duration::from_secs(5));
    }));
    let mut p = chk();
    p["authoredBodyText"] = json!("界\\\"".repeat(400000) + " attached");
    assert!(serde_json::to_vec(&p).unwrap().len() > compose_prep::MAX_REQUEST_BYTES);
    let state = s.clone();
    let mut pending = tokio::spawn(async move { rpc(&state, "compose.check", p).await });
    tokio::select! {
        _=started.notified()=>{},
        result=&mut pending=>panic!("large check refused before worker control: {:?}",result.unwrap().err()),
    }
    let other = tokio::time::timeout(std::time::Duration::from_secs(2), crate::server::handle_request_for_test(&s,"ping",json!({}))).await;
    release.send(()).unwrap();
    HOOKS.lock().unwrap().remove(&s.app_dir);
    assert!(other.unwrap().result.is_some());
    assert_eq!(pending.await.unwrap().unwrap()["kind"], "confirm_attachment");
    assert_eq!(std::fs::read(s.app_dir.join("accounts.json")).unwrap(), accounts);
    assert_eq!(std::fs::read(s.app_dir.join("frontend-settings.json")).unwrap(), settings);
    assert_eq!(std::fs::read_dir(&s.data_dir).unwrap().map(|e| e.unwrap().path()).collect::<Vec<_>>(), before);
}
