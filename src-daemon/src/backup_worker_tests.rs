use super::*;
use crate::server::handle_request_for_test;
use mailvault_core::backup::{BackupProgress, BackupResult, BackupRunContext};
const NOW: i64 = 1_792_929_600_000;
struct Call {
    ctx: BackupRunContext,
    reply: oneshot::Sender<Result<BackupResult, String>>,
}
struct Rig {
    _dir: tempfile::TempDir,
    state: Arc<DaemonState>,
    calls: UnboundedReceiver<Call>,
    worker: tokio::task::JoinHandle<()>,
}
fn settings(state: &Arc<DaemonState>) -> Value {
    SettingsDoc::shared(&state.app_dir)
        .get(None)
        .unwrap()
        .values[STORE]["state"]
        .clone()
}
fn patch(state: &Arc<DaemonState>, value: Value) {
    SettingsDoc::shared(&state.app_dir)
        .patch(&json!({STORE:{"state":value}}), None)
        .unwrap();
}
fn rig() -> Rig {
    rig_with_resolve(Arc::new(|_, id, _| {
        Box::pin(async move {
            Ok(serde_json::from_value(
                json!({"email":format!("{id}@test"),"imapHost":"127.0.0.1","imapPort":1}),
            )
            .unwrap())
        })
    }))
}
fn rig_with_resolve(resolve: Resolve) -> Rig {
    rig_with_provider(resolve, None)
}
fn rig_with_provider(resolve: Resolve, provider: Option<adapter::Provider>) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let state = DaemonState::for_test(dir.path().join("mail"), dir.path().into(), true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir).replace(&json!({STORE:{"version":3,"state":{"language":"lt","backupState":{},"backupHistory":{}}}}),None).unwrap();
    std::fs::write(
        dir.path().join("accounts.json"),
        r#"[{"id":"one"},{"id":"two"}]"#,
    )
    .unwrap();
    let (call_tx, calls) = unbounded_channel();
    let services = Services {
        resolve,
        provider: provider.unwrap_or_else(|| {
            Arc::new(move |ctx| {
                let tx = call_tx.clone();
                Box::pin(async move {
                    let (reply, rx) = oneshot::channel();
                    tx.send(Call { ctx, reply }).unwrap();
                    rx.await.unwrap()
                })
            })
        }),
    };
    let (tx, rx) = unbounded_channel();
    state.backup_worker.tx.set(tx).ok().unwrap();
    let worker = tokio::spawn(worker_loop(state.clone(), rx, services));
    Rig {
        _dir: dir,
        state,
        calls,
        worker,
    }
}
async fn rpc(state: &Arc<DaemonState>, method: &str, params: Value) -> Value {
    let response = handle_request_for_test(state, method, params).await;
    assert!(response.error.is_none(), "{method}: {:?}", response.error);
    response.result.unwrap()
}
async fn manual(state: &Arc<DaemonState>, id: &str, request: &str) -> Value {
    rpc(
        state,
        "backup.run_now",
        json!({"accountId":id,"requestId":request}),
    )
    .await
}
async fn call(rig: &mut Rig) -> Call {
    match tokio::time::timeout(Duration::from_secs(2), rig.calls.recv()).await {
        Ok(Some(call)) => call,
        _ => panic!(
            "provider not called; lifecycle {}",
            rig.state.backup_worker.status()
        ),
    }
}
async fn wait(state: &Arc<DaemonState>, predicate: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let s = state.backup_worker.status();
            if predicate(&s) {
                return s;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("worker never published expected lifecycle state")
}
fn result(emails: usize) -> BackupResult {
    BackupResult {
        emails_backed_up: emails,
        errors: 0,
        duration_secs: 2.0,
        success: true,
        error_message: None,
        cancelled: false,
        completed_folders: 4,
        external_copy_ok: true,
        external_copy_error: None,
        external_copy_failed_count: 0,
    }
}
fn frame(ctx: &BackupRunContext) -> BackupProgress {
    adapter::failed_frame(&ctx.account_id, "fixture error".into())
}
// JSON stores JavaScript's integral seconds as 0 and Rust's f64 seconds as
// 0.0. Assert numeric duration equality, then compare every remaining field.
fn assert_history(actual: &Value, expected: &Value) {
    let mut actual = actual.clone();
    let a = actual.as_array_mut().unwrap();
    let e = expected.as_array().unwrap();
    assert_eq!(a.len(), e.len());
    for (a, e) in a.iter_mut().zip(e) {
        assert_eq!(a["durationSecs"].as_f64(), e["durationSecs"].as_f64());
        a["durationSecs"] = e["durationSecs"].clone();
    }
    assert_eq!(&actual, expected);
}
async fn finish(rig: Rig) {
    let _ = rig
        .state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Shutdown);
    rig.worker.await.unwrap();
}

#[tokio::test]
async fn backup_worker_manual_join_claim_and_retained_completion() {
    let mut r = rig();
    let guard = adapter::claim_run(&r.state, "one").unwrap();
    let token = guard.cancel();
    let first = manual(&r.state, "one", "first").await;
    let again = manual(&r.state, "one", "joined").await;
    assert_eq!(first["runId"], again["runId"]);
    manual(&r.state, "two", "other").await;
    let c = call(&mut r).await;
    assert_eq!(c.ctx.account_id, "two");
    assert!(Arc::ptr_eq(
        r.state.backup_runs.lock().unwrap().get("one").unwrap(),
        &token
    ));
    c.reply.send(Ok(result(2))).ok().unwrap();
    drop(guard);
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Wake)
        .unwrap();
    let c = call(&mut r).await;
    assert_eq!(c.ctx.account_id, "one");
    let replay = manual(&r.state, "one", "first").await;
    assert_eq!(replay["runId"], first["runId"]);
    adapter::backup_cancel(&r.state, json!({"accountId":"one"}))
        .await
        .unwrap();
    assert!(
        !c.ctx.cancel.load(SeqCst),
        "legacy cancel crossed native ownership"
    );
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    c.reply.send(Ok(result(7))).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["first"]["status"] == "success"
            && s["requests"]["joined"]["status"] == "success"
    })
    .await;
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["emailsBackedUp"],
        7
    );
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let completed = manual(&r.state, "one", "first").await;
    assert_eq!(completed["status"], "success");
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_terminal_limit_waits_for_real_join_and_captures_metadata() {
    let mut r = rig();
    let ack = manual(&r.state, "one", "limit").await;
    let c = call(&mut r).await;
    let mut terminal = frame(&c.ctx);
    terminal.cancelled = true;
    terminal.stop_reason = Some("limit_reached");
    terminal.limit_bytes = Some(1024);
    terminal.resume_after_ms = Some((NOW + 1000) as u64);
    terminal.completed_folders = 4;
    (c.ctx.on_progress)(terminal);
    rpc(&r.state, "backup.cancel", json!({"runId":ack["runId"]})).await;
    assert!(c.ctx.cancel.load(SeqCst));
    let status = rpc(&r.state, "backup.schedule.status", json!({})).await;
    assert_eq!(status["active"]["runId"], ack["runId"]);
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    let mut out = result(3);
    out.cancelled = true;
    out.success = false;
    c.reply.send(Ok(out)).ok().unwrap();
    let s = wait(&r.state, |s| {
        s["requests"]["limit"]["status"] == "limit_reached"
    })
    .await;
    assert_eq!(s["lastOutcomes"][0]["terminal"]["limit_bytes"], 1024);
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    assert_eq!(s["queue"][0]["notBefore"], NOW + 31_000);
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_stop_cancels_owned_work_but_keeps_drain_truth() {
    let mut r = rig();
    manual(&r.state, "one", "active").await;
    let c = call(&mut r).await;
    manual(&r.state, "two", "queued").await;
    rpc(&r.state, "backup.stop", json!({})).await;
    assert!(c.ctx.cancel.load(SeqCst));
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    let mut out = result(0);
    out.cancelled = true;
    c.reply.send(Ok(out)).ok().unwrap();
    wait(&r.state, |s| {
        s["active"].is_null() && s["requests"]["queued"]["status"] == "cancelled"
    })
    .await;
    r.state.clock.set(NOW + 1_000_000);
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Wake)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(r.calls.try_recv().is_err());
    assert!(
        r.state.backup_worker.controls.lock().unwrap().is_empty(),
        "drained stop leaked cancellation controls"
    );
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_configured_and_unknown_slot_stay_pending_without_provider() {
    let mut r = rig();
    app_db::with(&r.state.app_dir, |c| {
        app_db::locations::save_meta(c, "external-backup", "/display-only", "macos", 1, false)
    })
    .unwrap();
    let ack = manual(&r.state, "one", "pending").await;
    wait(&r.state, |s| {
        s["pendingAccess"].as_array().is_some_and(|a| !a.is_empty())
    })
    .await;
    assert!(r.calls.try_recv().is_err());
    assert_eq!(settings(&r.state)["language"], "lt");
    rpc(&r.state, "backup.cancel", json!({"runId":ack["runId"]})).await;
    wait(&r.state, |s| {
        s["requests"]["pending"]["status"] == "cancelled"
    })
    .await;
    app_db::with(&r.state.app_dir, |c| {
        c.execute_batch("DROP TABLE external_locations")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    manual(&r.state, "two", "unknown").await;
    wait(&r.state, |s| {
        s["pendingAccess"].as_array().is_some_and(|a| !a.is_empty())
    })
    .await;
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_early_error_is_failed_once_with_real_bus_and_settings() {
    let mut r = rig();
    let mut events = r.state.events.subscribe();
    manual(&r.state, "one", "failed").await;
    let c = call(&mut r).await;
    c.reply
        .send(Err("early provider failure".into()))
        .ok()
        .unwrap();
    let s = wait(&r.state, |s| s["requests"]["failed"]["status"] == "failed").await;
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["lastBackupTime"],
        NOW
    );
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let run = s["requests"]["failed"]["runId"].clone();
    let mut terminal = 0;
    let mut settings_changed = 0;
    while let Ok(e) = events.try_recv() {
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&e).unwrap();
        if name == "backup-progress" && payload["active"] == false {
            assert_eq!(payload["runId"], run);
            terminal += 1;
        }
        if name == crate::handlers::settings::CHANGED_EVENT {
            settings_changed += 1;
        }
    }
    assert_eq!(terminal, 1);
    assert_eq!(settings_changed, 1);
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_panic_retains_actual_claim_as_uncertain() {
    let mut r = rig();
    manual(&r.state, "one", "panic").await;
    let c = call(&mut r).await;
    drop(c.reply); // The controlled provider's await panics, like JoinError.
    let s = wait(&r.state, |s| s["active"]["stage"] == "uncertain").await;
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert!(s["requests"]["panic"]["status"] != "success");
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    let run = s["active"]["runId"].clone();
    rpc(&r.state, "backup.stop", json!({})).await;
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert_eq!(r.state.backup_worker.uncertain.lock().unwrap().len(), 1);
    let joined = manual(&r.state, "one", "join-uncertain").await;
    assert_eq!(joined["runId"], run);
    assert_eq!(joined["status"], "uncertain");
    finish(r).await;
}

#[tokio::test]
async fn backup_worker_success_degraded_and_history_consume_isolated_oracle() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../src-core/tests/fixtures/backup-schedule-isolated-UTC.json"
    ))
    .unwrap();
    for name in ["success", "degraded"] {
        let expected = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["category"] == "coordinator" && c["name"] == name)
            .unwrap();
        let mut r = rig();
        patch(
            &r.state,
            json!({"backupState":{"one":{"lastError":"stale previous failure"}}}),
        );
        manual(&r.state, "one", name).await;
        let c = call(&mut r).await;
        let input = &expected["input"];
        let mut out = result(7);
        out.duration_secs = 0.0;
        out.errors = input["errors"].as_u64().unwrap_or(0) as usize;
        out.error_message = input["last_error"].as_str().map(str::to_string);
        out.external_copy_ok = input["external_copy_ok"] != false;
        out.external_copy_error = input["external_copy_error"].as_str().map(str::to_string);
        out.external_copy_failed_count =
            input["external_copy_failed_count"].as_u64().unwrap_or(0) as usize;
        c.reply.send(Ok(out)).ok().unwrap();
        wait(&r.state, |s| s["requests"][name]["status"] == "success").await;
        let mut observed = settings(&r.state)["backupState"]["one"].clone();
        observed
            .as_object_mut()
            .unwrap()
            .remove("lastSchedulerRunId");
        // A targeted RFC merge patch clears lastError by removing its key.
        // Both absence and explicit null represent no error to consumers.
        if observed.get("lastError").is_none() {
            observed["lastError"] = Value::Null;
        }
        assert_eq!(observed, expected["output"]["backupState"]["one"]);
        assert_history(
            &settings(&r.state)["backupHistory"]["one"],
            &expected["output"]["history"]["one"],
        );
        finish(r).await;
    }
    let mut r = rig();
    for n in 0..7 {
        r.state.clock.set(NOW + n * 1000);
        let request = format!("history-{n}");
        manual(&r.state, "one", &request).await;
        let c = call(&mut r).await;
        let mut out = result(7);
        out.duration_secs = 0.0;
        c.reply.send(Ok(out)).ok().unwrap();
        wait(&r.state, |s| s["requests"][&request]["status"] == "success").await;
    }
    let expected = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "history-newest-five-cumulative")
        .unwrap();
    assert_history(
        &settings(&r.state)["backupHistory"]["one"],
        &expected["output"]["history"]["one"],
    );
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["emailsBackedUp"],
        49
    );
    // History/request settlement is independent of pending manifest bookkeeping.
    let current = r.state.backup_worker.status();
    assert_eq!(current["requests"]["history-6"]["status"], "success");
    let run = current["requests"]["history-6"]["runId"].clone();
    wait(&r.state, |s| {
        s["lastOutcomes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|out| out["intent"]["runId"] == run && snapshots::settled(&out["snapshot"]))
            && s["lastOutcomes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|out| snapshots::settled(&out["snapshot"]))
    })
    .await;
    assert_eq!(
        r.state.backup_worker.status()["lastOutcomes"]
            .as_array()
            .unwrap()
            .len(),
        5,
        "retained applied outcomes must remain bounded"
    );
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_credentials_failure_history_never_advances_last_time() {
    let mut r = rig_with_resolve(Arc::new(|_, _, _| {
        Box::pin(async { Err("capture credentials unavailable".into()) })
    }));
    manual(&r.state, "one", "credentials").await;
    wait(&r.state, |s| {
        s["requests"]["credentials"]["status"] == "failed_credentials"
    })
    .await;
    assert!(r.calls.try_recv().is_err());
    assert!(settings(&r.state)["backupState"]["one"]["lastBackupTime"].is_null());
    let corpus: Value = serde_json::from_str(include_str!(
        "../../src-core/tests/fixtures/backup-schedule-isolated-UTC.json"
    ))
    .unwrap();
    let expected = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "credentials-failure")
        .unwrap();
    assert_history(
        &settings(&r.state)["backupHistory"]["one"],
        &expected["output"]["history"]["one"],
    );
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_retains_outcome_on_settings_failure_then_applies_once() {
    let mut r = rig();
    manual(&r.state, "one", "durable").await;
    let c = call(&mut r).await;
    let path = r.state.app_dir.join("frontend-settings.json");
    let saved = r.state.app_dir.join("saved-settings");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::create_dir(&path).unwrap();
    c.reply.send(Ok(result(7))).ok().unwrap();
    wait(&r.state, |s| {
        s["lastOutcomes"]
            .as_array()
            .is_some_and(|a| a.len() == 1 && a[0]["applied"] == false)
    })
    .await;
    assert!(!read_ledger(&r.state.app_dir).unwrap().outcomes[0].applied);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(saved, &path).unwrap();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Wake)
        .unwrap();
    wait(&r.state, |s| {
        s["requests"]["durable"]["status"] == "success" && s["lastOutcomes"][0]["applied"] == true
    })
    .await;
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["emailsBackedUp"],
        7
    );
    assert_eq!(settings(&r.state)["language"], "lt");
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_settings_marker_replays_after_metadata_ack_failure() {
    let mut r = rig();
    manual(&r.state, "one", "metadata-ack").await;
    let c = call(&mut r).await;
    app_db::with(&r.state.app_dir,|conn| conn.execute_batch(r#"CREATE TRIGGER fail_backup_ack BEFORE INSERT ON meta WHEN NEW.key='backup.scheduler.v1' AND instr(NEW.value, '"applied":true')>0 BEGIN SELECT RAISE(FAIL,'injected metadata ACK failure'); END;"#).map_err(|e|e.to_string())).unwrap();
    c.reply.send(Ok(result(7))).ok().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while settings(&r.state)["backupState"]["one"]["emailsBackedUp"] != 7 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!read_ledger(&r.state.app_dir).unwrap().outcomes[0].applied);
    app_db::with(&r.state.app_dir, |conn| {
        conn.execute_batch("DROP TRIGGER fail_backup_ack")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Wake)
        .unwrap();
    wait(&r.state, |s| s["lastOutcomes"][0]["applied"] == true).await;
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["emailsBackedUp"],
        7
    );
    finish(r).await;
}

fn automatic(state: &Arc<DaemonState>, paused: bool) {
    state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Facts(Facts {
            automatic: true,
            paused,
            loading: false,
            last_activity: NOW - 180_000,
        }))
        .unwrap();
}
fn wake(state: &Arc<DaemonState>) {
    state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Wake)
        .unwrap();
}
fn enabled(state: &Arc<DaemonState>) {
    patch(
        state,
        json!({"billingProfile":{"hasSubscription":true,"status":"active"},"backupGlobalEnabled":true,"backupGlobalConfig":{"interval":"daily"},"hiddenAccounts":{"two":true}}),
    );
}
#[tokio::test]
async fn backup_worker_empty_surfaces_preserve_native_admission() {
    let mut r = rig();
    enabled(&r.state);
    wake(&r.state);
    let c = call(&mut r).await;
    assert_eq!(c.ctx.account_id, "one");
    assert_eq!(r.state.backup_worker.status()["automaticOwner"], "daemon");
    c.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state, |s| {
        s["active"].is_null() && s["queue"].as_array().unwrap().is_empty()
    })
    .await;
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_retry_ladder_consumes_isolated_trace_without_early_history() {
    let mut r = rig();
    enabled(&r.state);
    automatic(&r.state, false);
    let corpus: Value = serde_json::from_str(include_str!(
        "../../src-core/tests/fixtures/backup-schedule-isolated-UTC.json"
    ))
    .unwrap();
    let expected = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "retry-exhaustion")
        .unwrap();
    for (attempt, time) in [NOW, NOW + 30_000, NOW + 150_000, NOW + 450_000]
        .into_iter()
        .enumerate()
    {
        if attempt > 0 {
            r.state.clock.set(time - 1);
            wake(&r.state);
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(r.calls.try_recv().is_err());
            r.state.clock.set(time);
            wake(&r.state);
        }
        let c = call(&mut r).await;
        assert_eq!(c.ctx.mailbox_concurrency, 3);
        assert_eq!(r.state.clock.now_ms(), time);
        // The real core error path sets the shared token to drain siblings.
        // That internal cancellation must not become explicit user intent.
        c.ctx.cancel.store(true, SeqCst);
        c.reply.send(Err("retry failure".into())).ok().unwrap();
        if attempt < 3 {
            wait(&r.state, |s| {
                s["active"].is_null() && s["queue"][0]["retries"] == attempt + 1
            })
            .await;
            assert!(settings(&r.state)["backupHistory"]["one"].is_null());
        }
    }
    wait(&r.state, |s| {
        s["lastOutcomes"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a[0]["applied"] == true)
    })
    .await;
    assert_history(
        &settings(&r.state)["backupHistory"]["one"],
        &expected["output"][3]["history"]["one"],
    );
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_manual_join_suppresses_retry_and_preserves_pause() {
    let mut r = rig();
    enabled(&r.state);
    automatic(&r.state, false);
    let c = call(&mut r).await;
    automatic(&r.state, true);
    let one = manual(&r.state, "one", "joined-auto").await;
    let again = manual(&r.state, "one", "replay").await;
    assert_eq!(one["runId"], again["runId"]);
    c.reply
        .send(Err("manual joined failure".into()))
        .ok()
        .unwrap();
    wait(&r.state, |s| {
        s["requests"]["joined-auto"]["status"] == "failed"
    })
    .await;
    r.state.clock.set(NOW + 60_000);
    wake(&r.state);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_progress_prevents_stall_and_stall_cancel_waits_for_join() {
    let mut r = rig();
    manual(&r.state, "one", "stall").await;
    let c = call(&mut r).await;
    r.state.clock.set(NOW + STALL_MS - 1);
    let mut f = frame(&c.ctx);
    f.active = true;
    (c.ctx.on_progress)(f);
    r.state.clock.set(NOW + STALL_MS + 1);
    wake(&r.state);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!c.ctx.cancel.load(SeqCst));
    r.state.clock.set(NOW + 2 * STALL_MS);
    wake(&r.state);
    wait(&r.state, |s| s["active"]["stage"] == "stopping_stall").await;
    assert!(c.ctx.cancel.load(SeqCst));
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    let mut out = result(0);
    out.cancelled = true;
    c.reply.send(Ok(out)).ok().unwrap();
    wait(&r.state, |s| s["requests"]["stall"]["status"] == "failed").await;
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_unreadable_accounts_are_pending_and_removed_account_is_distinct() {
    let mut r = rig();
    let guard = adapter::claim_run(&r.state, "one").unwrap();
    manual(&r.state, "one", "accounts").await;
    wait(&r.state, |s| s["queue"][0]["stage"] == "pending_claim").await;
    std::fs::write(r.state.app_dir.join("accounts.json"), "broken").unwrap();
    drop(guard);
    wake(&r.state);
    wait(&r.state, |s| s["queue"][0]["stage"] == "pending_accounts").await;
    assert!(r.calls.try_recv().is_err());
    std::fs::write(r.state.app_dir.join("accounts.json"), r#"[{"id":"two"}]"#).unwrap();
    wake(&r.state);
    wait(&r.state, |s| {
        s["requests"]["accounts"]["status"] == "missing_account"
    })
    .await;
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    finish(r).await;
}

#[tokio::test]
async fn backup_worker_stale_progress_and_cancel_cannot_change_new_execution() {
    let mut r = rig();
    let ack = manual(&r.state, "one", "old").await;
    let old = call(&mut r).await;
    let old_progress = old.ctx.on_progress.clone();
    let old_frame = frame(&old.ctx);
    old.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state, |s| s["requests"]["old"]["status"] == "success").await;
    manual(&r.state, "one", "new").await;
    let new = call(&mut r).await;
    rpc(&r.state, "backup.cancel", json!({"runId":ack["runId"]})).await;
    assert!(!new.ctx.cancel.load(SeqCst));
    r.state.clock.set(NOW + STALL_MS - 1);
    old_progress(old_frame);
    r.state.clock.set(NOW + STALL_MS + 1);
    wake(&r.state);
    wait(&r.state, |s| s["active"]["stage"] == "stopping_stall").await;
    let mut out = result(0);
    out.cancelled = true;
    new.reply.send(Ok(out)).ok().unwrap();
    wait(&r.state, |s| s["requests"]["new"]["status"] == "failed").await;
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_stop_fences_a_delayed_automatic_scan() {
    let mut r = rig();
    enabled(&r.state);
    automatic(&r.state, true);
    rpc(&r.state, "backup.stop", json!({})).await;
    // An earlier read of settings may return after Stop. It cannot re-enable
    // the scheduler or become fresh intent just by being delivered late.
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Due {
            epoch: 0,
            ids: vec!["one".into()],
        })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        r.state.backup_worker.status()["queue"]
            .as_array()
            .unwrap()
            .is_empty(),
        "late automatic scan recreated stopped intent"
    );
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_limit_cap_change_rechecks_current_entitlement() {
    let mut r = rig();
    enabled(&r.state);
    patch(
        &r.state,
        json!({"transferLimits":{"one":{"capEnabled":true,"dailyDownLimitBytes":1024}}}),
    );
    manual(&r.state, "one", "limit-cap").await;
    let c = call(&mut r).await;
    let mut terminal = frame(&c.ctx);
    terminal.cancelled = true;
    terminal.stop_reason = Some("limit_reached");
    terminal.limit_bytes = Some(1024);
    terminal.resume_after_ms = Some((NOW + 10_000) as u64);
    terminal.completed_folders = 4;
    (c.ctx.on_progress)(terminal);
    let mut out = result(0);
    out.success = false;
    out.cancelled = true;
    c.reply.send(Ok(out)).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["limit-cap"]["status"] == "limit_reached"
    })
    .await;
    patch(
        &r.state,
        json!({"billingProfile":{"hasSubscription":false,"status":"inactive"},"transferLimits":{"one":{"warningEnabled":false}}}),
    );
    automatic(&r.state, false);
    wait(&r.state, |s| {
        s["active"].is_null() && s["queue"][0]["stage"] == "pending_policy"
    })
    .await;
    assert!(r.calls.try_recv().is_err());
    patch(
        &r.state,
        json!({"billingProfile":{"hasSubscription":true,"status":"active"}}),
    );
    wake(&r.state);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(
        r.calls.try_recv().is_err(),
        "entitlement recheck erased the midnight hold"
    );
    patch(
        &r.state,
        json!({"transferLimits":{"one":{"capEnabled":false}}}),
    );
    wake(&r.state);
    let c = call(&mut r).await;
    assert_eq!(
        c.ctx.skip_folders, 0,
        "ordinal without known folder order became skip authority"
    );
    c.reply.send(Ok(result(7))).ok().unwrap();
    wait(&r.state, |s| {
        s["active"].is_null() && s["lastOutcomes"].as_array().is_some_and(|a| a.len() >= 2)
    })
    .await;
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_removed_during_credentials_is_not_failed_credentials() {
    let (release, rx) = oneshot::channel();
    let rx = Arc::new(Mutex::new(Some(rx)));
    let (entered, mut entered_rx) = unbounded_channel();
    let r = rig_with_resolve(Arc::new(move |_, _, _| {
        let rx = rx.lock().unwrap().take().unwrap();
        let entered = entered.clone();
        Box::pin(async move {
            entered.send(()).unwrap();
            rx.await.unwrap();
            Err("credentials no longer present".into())
        })
    }));
    manual(&r.state, "one", "removed").await;
    entered_rx.recv().await.unwrap();
    std::fs::write(r.state.app_dir.join("accounts.json"), r#"[{"id":"two"}]"#).unwrap();
    release.send(()).unwrap();
    wait(&r.state, |s| {
        s["requests"]["removed"]["status"] == "missing_account"
    })
    .await;
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    finish(r).await;
}

#[tokio::test]
async fn backup_worker_reopening_active_state_changes_execution_and_uses_zero_checkpoint() {
    let mut r = rig();
    let original = manual(&r.state, "one", "reopened").await;
    let c = call(&mut r).await;
    let mut persisted = read_ledger(&r.state.app_dir).unwrap();
    persisted.active.as_mut().unwrap().checkpoint = 4;
    let mut cancelled = result(0);
    cancelled.cancelled = true;
    c.reply.send(Ok(cancelled)).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["reopened"]["status"] == "cancelled"
    })
    .await;
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Shutdown)
        .unwrap();
    r.worker.await.unwrap();
    // This is state reopening after the first task actually drained. It is
    // not a process-kill/power-loss experiment and never overlaps that task.
    save_ledger(&r.state.app_dir, &persisted).unwrap();
    std::fs::write(
        r.state.app_dir.join("accounts.json"),
        r#"[{"id":"one","mailboxes":["Renamed","INBOX"]}]"#,
    )
    .unwrap();
    let state = DaemonState::for_test(r.state.data_dir.clone(), r.state.app_dir.clone(), true);
    state.clock.set(NOW + 1);
    let (calls_tx, mut calls) = unbounded_channel();
    let (tx, rx) = unbounded_channel();
    state.backup_worker.tx.set(tx).ok().unwrap();
    let services = Services {
        resolve: Arc::new(|_, _, _| {
            Box::pin(async {
                Ok(serde_json::from_value(
                    json!({"email":"one@test","imapHost":"127.0.0.1","imapPort":1}),
                )
                .unwrap())
            })
        }),
        provider: Arc::new(move |ctx| {
            let tx = calls_tx.clone();
            Box::pin(async move {
                let (reply, rx) = oneshot::channel();
                tx.send(Call { ctx, reply }).unwrap();
                rx.await.unwrap()
            })
        }),
    };
    let worker = tokio::spawn(worker_loop(state.clone(), rx, services));
    let resumed = tokio::time::timeout(Duration::from_secs(2), calls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resumed.ctx.skip_folders, 0);
    let live = state.backup_worker.status();
    assert_ne!(live["active"]["executionId"], original["executionId"]);
    let replay = manual(&state, "one", "reopened").await;
    assert_eq!(replay["runId"], original["runId"]);
    assert_eq!(replay["executionId"], live["active"]["executionId"]);
    resumed.reply.send(Ok(result(7))).ok().unwrap();
    wait(&state, |s| s["requests"]["reopened"]["status"] == "success").await;
    assert_eq!(
        settings(&state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Shutdown)
        .unwrap();
    worker.await.unwrap();
}

#[tokio::test]
async fn backup_worker_cancel_followed_by_early_error_never_records_failed_history() {
    let mut r = rig();
    let ack = manual(&r.state, "one", "cancel-error").await;
    let c = call(&mut r).await;
    rpc(&r.state, "backup.cancel", json!({"runId":ack["runId"]})).await;
    c.reply
        .send(Err("transport ended after cancellation".into()))
        .ok()
        .unwrap();
    wait(&r.state, |s| {
        s["requests"]["cancel-error"]["status"] == "cancelled"
    })
    .await;
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    assert!(settings(&r.state)["backupState"]["one"]["lastBackupTime"].is_null());
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_provider_cancel_error_projects_failure_without_history_or_time() {
    let mut r = rig();
    patch(
        &r.state,
        json!({"backupState":{"one":{"lastBackupTime":42,"lastStatus":"success"}}}),
    );
    manual(&r.state, "one", "provider-stop").await;
    let c = call(&mut r).await;
    let mut stopped = result(1);
    stopped.cancelled = true;
    stopped.error_message = Some("provider download allowance spent".into());
    c.reply.send(Ok(stopped)).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["provider-stop"]["status"] == "cancelled"
    })
    .await;
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["lastStatus"],
        "failed"
    );
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["lastError"],
        "provider download allowance spent"
    );
    assert_eq!(
        settings(&r.state)["backupState"]["one"]["lastBackupTime"],
        42
    );
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    finish(r).await;
}

// These barriers pause the real command consumer, never a copied scheduler.
// The provider still returns through its actual joined adapter/completion path.
async fn pause_command(
    state: &Arc<DaemonState>,
    finished: bool,
) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
    let (armed, ready) = oneshot::channel();
    let (entered, waiting) = oneshot::channel();
    let (release, held) = oneshot::channel();
    let command = if finished {
        Cmd::PauseFinished {
            armed,
            entered,
            release: held,
        }
    } else {
        Cmd::PauseManual {
            armed,
            entered,
            release: held,
        }
    };
    state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(command)
        .ok()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    (waiting, release)
}

#[tokio::test]
async fn backup_fix1_cancel_consumption_cancels_replacement_retry_token() {
    let mut r = rig();
    enabled(&r.state);
    automatic(&r.state, false);
    let first = call(&mut r).await;
    let run = r.state.backup_worker.status()["active"]["runId"].clone();
    // Keep a fresh automatic scan from creating a separate logical run. The
    // already-owned retry remains eligible independently of this due time.
    patch(
        &r.state,
        json!({"backupState":{"one":{"lastBackupTime":NOW}}}),
    );
    let (entered, release) = pause_command(&r.state, true).await;
    first
        .reply
        .send(Err("joined automatic failure".into()))
        .ok()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !r.state.backup_runs.lock().unwrap().contains_key("one"),
        "actual provider must have drained before its Finished is consumed"
    );
    let mut cancel = Box::pin(rpc(&r.state, "backup.cancel", json!({"runId":run})));
    assert!(futures::poll!(cancel.as_mut()).is_pending());
    release.send(()).unwrap();
    assert_eq!(cancel.await["accepted"], true);
    let survived = r.state.backup_worker.status()["queue"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["runId"] == run);
    r.state.clock.set(NOW + 30_000);
    wake(&r.state);
    if survived {
        let retry = call(&mut r).await;
        let mut out = result(0);
        out.cancelled = true;
        retry.reply.send(Ok(out)).ok().unwrap();
        wait(&r.state, |s| s["active"].is_null()).await;
    } else {
        assert!(r.calls.try_recv().is_err());
    }
    finish(r).await;
    assert!(
        !survived,
        "accepted Cancel left the freshly installed retry intent/token live"
    );
}

#[tokio::test]
async fn backup_fix1_stop_consumption_fences_manual_already_ahead_in_channel() {
    let mut r = rig();
    manual(&r.state, "one", "held-before-stop").await;
    let first = call(&mut r).await;
    let (entered, release) = pause_command(&r.state, false).await;
    let mut queued = Box::pin(manual(&r.state, "two", "queued-before-stop"));
    assert!(futures::poll!(queued.as_mut()).is_pending());
    tokio::time::timeout(Duration::from_secs(2), entered)
        .await
        .unwrap()
        .unwrap();
    let mut stop = Box::pin(rpc(&r.state, "backup.stop", json!({})));
    assert!(futures::poll!(stop.as_mut()).is_pending());
    release.send(()).unwrap();
    queued.await;
    assert_eq!(stop.await["accepted"], true);
    assert!(first.ctx.cancel.load(SeqCst));
    assert!(
        r.state.backup_runs.lock().unwrap().contains_key("one"),
        "Stop ACK must retain the undrained first run"
    );
    let survived =
        r.state.backup_worker.status()["requests"]["queued-before-stop"]["status"] != "cancelled";
    let mut out = result(0);
    out.cancelled = true;
    first.reply.send(Ok(out)).ok().unwrap();
    if survived {
        let unexpected = call(&mut r).await;
        assert_eq!(unexpected.ctx.account_id, "two");
        let mut out = result(0);
        out.cancelled = true;
        unexpected.reply.send(Ok(out)).ok().unwrap();
    }
    wait(&r.state, |s| s["active"].is_null()).await;
    if !survived {
        manual(&r.state, "two", "manual-after-accepted-stop").await;
        let later = call(&mut r).await;
        later.reply.send(Ok(result(1))).ok().unwrap();
        wait(&r.state, |s| {
            s["requests"]["manual-after-accepted-stop"]["status"] == "success"
        })
        .await;
    }
    finish(r).await;
    assert!(
        !survived,
        "accepted Stop left an earlier queued Manual alive in the RPC's newer epoch"
    );
}

// Keep the paused runtime busy while blocking filesystem workers complete:
// Tokio's idle auto-advance must not substitute a later minute maintenance tick.
async fn paused_state(state: &Arc<DaemonState>, predicate: impl Fn(&Value) -> bool) {
    let until = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if predicate(&state.backup_worker.status()) {
            return;
        }
        assert!(
            std::time::Instant::now() < until,
            "paused worker did not publish expected state"
        );
        tokio::task::yield_now().await;
    }
}
async fn paused_call(rig: &mut Rig) -> Call {
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(call) = rig.calls.try_recv() {
            return call;
        }
        assert!(
            std::time::Instant::now() < until,
            "retry deadline did not autonomously invoke the provider"
        );
        tokio::task::yield_now().await;
    }
}
// First consume all earlier loop iterations, then wait for their real scan
// tasks to post results, then consume those FIFO results. No hidden scan
// completion can act as an unrelated command at the measured deadline.
async fn paused_quiescent(state: &Arc<DaemonState>) {
    async fn probe(state: &Arc<DaemonState>) {
        let (done, mut observed) = oneshot::channel();
        state
            .backup_worker
            .tx
            .get()
            .unwrap()
            .send(Cmd::Probe { done })
            .ok()
            .unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if observed.try_recv().is_ok() {
                return;
            }
            assert!(
                std::time::Instant::now() < until,
                "paused FIFO probe did not finish"
            );
            tokio::task::yield_now().await;
        }
    }
    probe(state).await;
    let until = std::time::Instant::now() + Duration::from_secs(3);
    while state.backup_worker.scans_in_flight.load(SeqCst) != 0 {
        assert!(
            std::time::Instant::now() < until,
            "automatic scan did not drain"
        );
        tokio::task::yield_now().await;
    }
    probe(state).await;
}
#[tokio::test(start_paused = true)]
async fn backup_fix1_retry_timer_wakes_real_loop_without_deadline_command() {
    let began = tokio::time::Instant::now();
    let mut r = rig();
    enabled(&r.state);
    automatic(&r.state, false);
    let first = paused_call(&mut r).await;
    // The first actual provider starts only after worker startup consumed the
    // interval's immediate initial tick. Keep time fixed until that traffic drains.
    paused_quiescent(&r.state).await;
    assert_eq!(tokio::time::Instant::now() - began, Duration::ZERO);
    r.state.clock.set(NOW + 17_000);
    tokio::time::advance(Duration::from_secs(17)).await;
    first.reply.send(Err("timer retry".into())).ok().unwrap();
    paused_state(&r.state, |s| {
        s["active"].is_null() && s["queue"][0]["retries"] == 1
    })
    .await;
    paused_quiescent(&r.state).await;
    assert_eq!(
        r.state.backup_worker.status()["queue"][0]["notBefore"],
        NOW + 47_000
    );
    r.state.clock.set(NOW + 46_999);
    tokio::time::advance(Duration::from_millis(29_999)).await;
    paused_quiescent(&r.state).await;
    assert!(
        r.calls.try_recv().is_err(),
        "retry began before its deadline"
    );
    r.state.clock.set(NOW + 47_000);
    tokio::time::advance(Duration::from_millis(1)).await;
    // No Wake, Facts, Probe or RPC is issued at47s. The next maintenance tick
    // is60s, so only a production deadline timer can initiate this retry.
    let retry = paused_call(&mut r).await;
    assert_eq!(tokio::time::Instant::now() - began, Duration::from_secs(47));
    retry.reply.send(Ok(result(1))).ok().unwrap();
    paused_state(&r.state, |s| {
        s["active"].is_null()
            && s["queue"].as_array().unwrap().is_empty()
            && s["lastOutcomes"][0]["applied"] == true
    })
    .await;
    tokio::time::resume();
    finish(r).await;
}

fn access_slot(r: &Rig) -> String {
    app_db::with(&r.state.app_dir, |c| {
        app_db::locations::save_meta(c, "external-backup", "/display-only", "native", 1, false)
    })
    .unwrap();
    mailvault_core::backup_access::slot_stamp(&r.state.app_dir)
        .unwrap()
        .unwrap()
}
fn access_attempt(r: &Rig, ack: &Value, owner: &str) -> Value {
    access::owner_connected(&r.state, owner);
    json!({"incarnation":r.state.backup_worker.access.incarnation,"runId":ack["runId"],"executionId":ack["executionId"],"ownerId":owner,"acquisitionId":uuid::Uuid::new_v4().to_string()})
}
async fn access_attach(r: &Rig, attempt: &Value, stamp: &str, root: &str) -> Value {
    rpc(&r.state,"backup.attach_access",json!({"attempt":attempt,"slotStamp":stamp,"resolution":{"status":"authorized","root":root}})).await
}
#[tokio::test]
async fn backup_access_authorized_root_reaches_actual_provider() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "native-root").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    let attached = access_attach(&r, &attempt, &stamp, "/native-authorized").await;
    assert_eq!(attached["state"], "accepted");
    let journal = app_db::with(&r.state.app_dir, |c| {
        c.query_row("SELECT value FROM meta WHERE key=?1", [META], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(
        !journal.contains("/native-authorized"),
        "resolved scope was persisted as reusable authority"
    );
    let reached = tokio::time::timeout(Duration::from_millis(200), r.calls.recv()).await;
    let observed = reached.is_ok();
    if let Ok(Some(c)) = reached {
        assert_eq!(c.ctx.mirror_root.as_deref(), Some("/native-authorized"));
        c.reply.send(Ok(result(1))).ok();
        wait(&r.state, |s| {
            s["requests"]["native-root"]["status"] == "success"
        })
        .await;
    }
    finish(r).await;
    assert!(
        observed,
        "accepted native authority never reached the real worker/provider handoff"
    );
}
#[tokio::test]
async fn backup_access_fence_before_attach_prevents_start() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "fence").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    let fenced = rpc(
        &r.state,
        "backup.access_status",
        json!({"attempt":attempt,"fenceUnstarted":true}),
    )
    .await;
    assert_eq!(fenced["safeRelease"], true);
    let late = access_attach(&r, &attempt, &stamp, "/native-authorized").await;
    assert_eq!(late["state"], "fenced");
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}
async fn access_query(r: &Rig, attempt: &Value, fence: bool) -> Value {
    rpc(
        &r.state,
        "backup.access_status",
        json!({"attempt":attempt,"fenceUnstarted":fence}),
    )
    .await
}
#[tokio::test]
async fn backup_access_terminal_and_cancel_ack_are_not_drain() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "joined-scope").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    assert_eq!(
        access_attach(&r, &attempt, &stamp, "/native-authorized").await["state"],
        "accepted"
    );
    let c = call(&mut r).await;
    (c.ctx.on_progress)(frame(&c.ctx));
    rpc(&r.state, "backup.cancel", json!({"runId":ack["runId"]})).await;
    let status = access_query(&r, &attempt, true).await;
    assert_eq!(status["safeRelease"], false);
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    c.reply.send(Ok(result(2))).ok().unwrap();
    wait(&r.state, |s| s["active"].is_null()).await;
    assert_eq!(access_query(&r, &attempt, true).await["state"], "drained");
    assert_eq!(access_query(&r, &attempt, false).await["safeRelease"], true);
    finish(r).await;
}
#[tokio::test]
async fn backup_access_stale_slot_and_foreign_identity_cannot_start() {
    let mut r = rig();
    let old = access_slot(&r);
    let ack = manual(&r.state, "one", "slot-change").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    app_db::with(&r.state.app_dir, |c| {
        app_db::locations::save_meta(c, "external-backup", "/replacement", "native", 2, false)
    })
    .unwrap();
    assert_eq!(
        access_attach(&r, &attempt, &old, "/old-root").await["state"],
        "rejected"
    );
    let mut foreign = attempt.clone();
    foreign["incarnation"] = json!("old-daemon");
    assert_eq!(access_query(&r, &foreign, true).await["safeRelease"], false);
    let mut stale = attempt.clone();
    stale["executionId"] = json!("previous-execution");
    assert_eq!(
        access_attach(&r, &stale, &old, "/old-root").await["state"],
        "rejected"
    );
    assert!(r.calls.try_recv().is_err());
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    finish(r).await;
}
#[tokio::test]
async fn backup_access_owner_loss_waits_for_join_then_needs_fresh_scope() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "owner-loss").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    access_attach(&r, &attempt, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    access::owner_lost(&r.state, "shell-a");
    assert!(c.ctx.cancel.load(SeqCst));
    assert_eq!(access_query(&r, &attempt, true).await["safeRelease"], false);
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    c.reply.send(Ok(result(1))).ok().unwrap();
    let s = wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
            && s["pendingAccess"][0]["executionId"] != ack["executionId"]
    })
    .await;
    let fresh = s["pendingAccess"][0].clone();
    assert_eq!(fresh["runId"], ack["runId"]);
    assert_eq!(access_query(&r, &attempt, false).await["safeRelease"], true);
    assert!(r.calls.try_recv().is_err());
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    let replacement = access_attempt(&r, &fresh, "shell-b");
    access_attach(&r, &replacement, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    assert!(!c.ctx.cancel.load(SeqCst));
    let late = access_attach(&r, &attempt, &stamp, "/redirect").await;
    assert_eq!(late["state"], "drained");
    assert_eq!(
        access_query(&r, &replacement, true).await["safeRelease"],
        false
    );
    c.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["owner-loss"]["status"] == "success"
    })
    .await;
    finish(r).await;
}
#[tokio::test]
async fn backup_access_provider_panic_retains_authority_and_guard() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "uncertain-scope").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    access_attach(&r, &attempt, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    drop(c.reply); // Actual provider future panics on its oneshot, adapter joins it.
    wait(&r.state, |s| s["active"]["stage"] == "uncertain").await;
    access::owner_lost(&r.state, "shell-a");
    assert_eq!(access_query(&r, &attempt, true).await["state"], "uncertain");
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    finish(r).await;
}
#[tokio::test]
async fn backup_access_retry_receipt_is_execution_specific() {
    let mut r = rig();
    let stamp = access_slot(&r);
    enabled(&r.state);
    automatic(&r.state, false);
    let s = wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let first = s["pendingAccess"][0].clone();
    let a = access_attempt(&r, &first, "shell-a");
    access_attach(&r, &a, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    c.reply.send(Err("retry fixture".into())).ok().unwrap();
    let s = wait(&r.state, |s| {
        s["active"].is_null() && s["queue"][0]["retries"] == 1
    })
    .await;
    let retry = s["queue"][0].clone();
    assert_eq!(retry["runId"], first["runId"]);
    assert_ne!(retry["executionId"], first["executionId"]);
    assert_eq!(access_query(&r, &a, false).await["state"], "drained");
    r.state.clock.set(NOW + 30_000);
    wake(&r.state);
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    assert!(r.calls.try_recv().is_err());
    let b = access_attempt(&r, &retry, "shell-a");
    access_attach(&r, &b, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    assert_eq!(
        access_attach(&r, &a, &stamp, "/redirect").await["state"],
        "drained"
    );
    assert_eq!(access_query(&r, &b, true).await["safeRelease"], false);
    c.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state, |s| {
        s["lastOutcomes"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a[0]["applied"] == true)
    })
    .await;
    assert_eq!(access_query(&r, &b, false).await["state"], "drained");
    finish(r).await;
}
#[tokio::test]
async fn backup_access_joined_receipt_survives_failed_history_application() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "scope-history").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    access_attach(&r, &attempt, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    let path = r.state.app_dir.join("frontend-settings.json");
    let saved = r.state.app_dir.join("saved-settings");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::create_dir(&path).unwrap();
    c.reply.send(Ok(result(7))).ok().unwrap();
    wait(&r.state, |s| s["lastOutcomes"][0]["applied"] == false).await;
    assert_eq!(access_query(&r, &attempt, true).await["safeRelease"], true);
    assert_eq!(
        access_attach(&r, &attempt, &stamp, "/redirect").await["state"],
        "drained"
    );
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(saved, &path).unwrap();
    wake(&r.state);
    wait(&r.state, |s| {
        s["requests"]["scope-history"]["status"] == "success"
    })
    .await;
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}
#[tokio::test]
async fn backup_access_slot_changed_during_credentials_blocks_provider() {
    let (entered_tx, entered_rx) = oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered_tx)));
    let (release_tx, release_rx) = oneshot::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let mut r = rig_with_resolve(Arc::new(move |_, _, _| {
        let entered = entered.lock().unwrap().take();
        let release = release.lock().unwrap().take();
        Box::pin(async move {
            if let Some(entered) = entered {
                entered.send(()).ok();
            }
            if let Some(release) = release {
                release.await.ok();
            }
            Ok(serde_json::from_value(
                json!({"email":"one@test","imapHost":"127.0.0.1","imapPort":1}),
            )
            .unwrap())
        })
    }));
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "credential-slot").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    access_attach(&r, &attempt, &stamp, "/old-native-root").await;
    entered_rx.await.unwrap();
    let ping = handle_request_for_test(&r.state, "ping", json!({})).await;
    assert!(ping.error.is_none());
    assert_eq!(
        access_query(&r, &attempt, false).await["safeRelease"],
        false
    );
    app_db::with(&r.state.app_dir, |c| {
        app_db::locations::save_meta(c, "external-backup", "/new-choice", "native", 2, false)
    })
    .unwrap();
    release_tx.send(()).ok();
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
            && s["pendingAccess"][0]["executionId"] != ack["executionId"]
    })
    .await;
    assert_eq!(access_query(&r, &attempt, false).await["state"], "drained");
    assert!(r.calls.try_recv().is_err());
    finish(r).await;
}

#[tokio::test]
async fn backup_access_real_blocking_mirror_drain_retains_scope_after_terminal() {
    use mailvault_core::mirror_mutation::MirrorRoot;
    // This fixture alone logs its loopback provider position, never user data.
    let _provider_trace = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_env_filter("mailvault_core::imap=info")
            .with_test_writer()
            .finish(),
    );

    async fn wait_stage(state: &Arc<DaemonState>, stage: &str, predicate: impl Fn(&Value) -> bool) {
        let reached = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let view = state.backup_worker.status();
                if predicate(&view) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        if reached.is_err() {
            let view = state.backup_worker.status();
            let summary = json!({"stage":stage,"activeStage":view["active"]["stage"],"activeRun":view["active"]["runId"],"activeExecution":view["active"]["executionId"],"cancelRequested":view["active"]["cancelRequested"],"pendingCount":view["pendingAccess"].as_array().map(Vec::len),"requestStatus":view["requests"]["real-blocking-scope"]["status"],"ownsAccount":state.backup_runs.lock().unwrap().contains_key("one"),"revision":view["revision"]});
            panic!("real mirror drain stage timed out: {summary}");
        }
    }
    // A refused closed port costs about two seconds per attempt on Windows.
    // End real transport deterministically; keep the actual provider and drain.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = accepted.clone();
    let (stop_transport, mut transport_stop) = oneshot::channel::<()>();
    let transport = tokio::spawn(async move {
        loop {
            tokio::select! {
                connection = listener.accept() => { let (socket,_) = connection.unwrap(); observed.fetch_add(1,SeqCst); drop(socket); }
                _ = &mut transport_stop => break,
            }
        }
    });
    let (entered_tx, entered_rx) = oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered_tx)));
    let provider: adapter::Provider = Arc::new(move |ctx| {
        (ctx.on_progress)(frame(&ctx));
        if let Some(entered) = entered.lock().unwrap().take() {
            entered.send(()).ok();
        }
        adapter::provider()(ctx)
    });
    let r = rig_with_provider(
        Arc::new(move |_, _, _| {
            Box::pin(async move {
                Ok(serde_json::from_value(
                    json!({"email":"one@test","imapHost":"127.0.0.1","imapPort":port}),
                )
                .unwrap())
            })
        }),
        Some(provider),
    );
    let stamp = access_slot(&r);
    let mirror = tempfile::tempdir().unwrap();
    let cur = mailvault_core::maildir::mirror_cur(mirror.path(), "one@test", "INBOX").unwrap();
    std::fs::create_dir_all(&cur).unwrap();
    std::fs::write(cur.join("7.eml"), b"legacy queued copy").unwrap();
    app_db::with(&r.state.app_dir, |c| {
        app_db::ops::purge_append_legacy(c, &BTreeMap::from([("one@test|INBOX".into(), vec![7])]))
    })
    .unwrap();
    let root = MirrorRoot::resolve(mirror.path()).unwrap();
    let (locked_tx, locked_rx) = oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let holding = tokio::task::spawn_blocking(move || {
        root.mutate(|_| {
            locked_tx.send(()).ok();
            release_rx.recv().unwrap();
            Ok(())
        })
    });
    locked_rx.await.unwrap();
    let ack = manual(&r.state, "one", "real-blocking-scope").await;
    wait_stage(&r.state, "initial pending access", |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    let attempt = access_attempt(&r, &ack, "shell-a");
    access_attach(&r, &attempt, &stamp, mirror.path().to_str().unwrap()).await;
    entered_rx.await.unwrap();
    rpc(&r.state, "backup.cancel", json!({"runId":ack["runId"]})).await;
    let before = access_query(&r, &attempt, true).await;
    let claimed = r.state.backup_runs.lock().unwrap().contains_key("one");
    let file_remains = cur.join("7.eml").exists();
    release_tx.send(()).unwrap();
    holding.await.unwrap().unwrap();
    wait_stage(&r.state, "joined drain after mirror release", |s| {
        s["active"].is_null()
    })
    .await;
    assert_eq!(before["safeRelease"], false);
    assert!(claimed);
    assert!(file_remains);
    assert_eq!(access_query(&r, &attempt, false).await["state"], "drained");
    assert!(
        accepted.load(SeqCst) > 0,
        "the real provider never reached the owned transport"
    );
    stop_transport.send(()).ok();
    transport.await.unwrap();
    finish(r).await;
}

#[tokio::test]
async fn backup_access_foreign_status_does_not_reprobe_pending_intent() {
    async fn probe(state: &Arc<DaemonState>) {
        let (done, wait) = oneshot::channel();
        state
            .backup_worker
            .tx
            .get()
            .unwrap()
            .send(Cmd::Probe { done })
            .unwrap();
        wait.await.unwrap();
    }
    let mut r = rig();
    access_slot(&r);
    let ack = manual(&r.state, "one", "foreign-probe").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    probe(&r.state).await;
    // Drain the real initial Wake, its coalesced preparing recheck, and any
    // scan/Due traffic before attributing revisions to the foreign queries.
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (done, idle) = oneshot::channel();
            r.state
                .backup_worker
                .tx
                .get()
                .unwrap()
                .send(Cmd::AccessIdle { done })
                .unwrap();
            if idle.await.unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("initial access probe traffic never settled");
    let current = access_attempt(&r, &ack, "shell-a");
    let mut foreign = current.clone();
    foreign["incarnation"] = json!("previous-daemon");
    let revision = r.state.backup_worker.status()["revision"].clone();
    let mut observed = Vec::new();
    for fence in [false, true] {
        assert_eq!(
            access_query(&r, &foreign, fence).await["state"],
            "foreign_incarnation"
        );
        probe(&r.state).await;
        observed.push(r.state.backup_worker.status()["revision"].clone());
        wait(&r.state, |s| {
            !s["pendingAccess"].as_array().unwrap().is_empty()
        })
        .await;
    }
    // A current successful fence keeps its existing recheck/wake semantics.
    app_db::with(&r.state.app_dir, |c| {
        app_db::locations::clear(c, "external-backup")
    })
    .unwrap();
    assert_eq!(access_query(&r, &current, true).await["state"], "fenced");
    let c = call(&mut r).await;
    let local = c.ctx.mirror_root.is_none();
    c.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["foreign-probe"]["status"] == "success"
    })
    .await;
    finish(r).await;
    assert!(local);
    assert_eq!(
        observed,
        vec![revision.clone(), revision],
        "foreign status spuriously re-admitted pending intent"
    );
}

#[tokio::test]
async fn backup_access_attach_after_pending_decision_keeps_new_authority() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    *r.state.backup_worker.pending_access_exit.lock().unwrap() = Some((entered_tx, release_rx));
    let ack = manual(&r.state, "one", "late-access-decision").await;
    entered_rx.await.unwrap();
    let attempt = access_attempt(&r, &ack, "shell-b");
    assert_eq!(
        access_attach(&r, &attempt, &stamp, "/native-authorized").await["state"],
        "accepted"
    );
    assert_eq!(
        access_query(&r, &attempt, false).await["safeRelease"],
        false
    );
    release_tx.send(()).unwrap();
    let provider = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(call) = r.calls.try_recv() {
                break Some(call);
            }
            let status = r.state.backup_worker.status();
            if status["accessReceipts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["attempt"] == attempt && v["safeRelease"] == true)
            {
                break None;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let started = provider.is_some();
    let mut held_until_join = false;
    if let Some(c) = provider {
        held_until_join = access_query(&r, &attempt, true).await["safeRelease"] == false;
        assert_eq!(c.ctx.mirror_root.as_deref(), Some("/native-authorized"));
        c.reply.send(Ok(result(1))).ok().unwrap();
        wait(&r.state, |s| {
            s["requests"]["late-access-decision"]["status"] == "success"
        })
        .await;
    }
    finish(r).await;
    assert!(
        started,
        "a pre-attach Pending result drained newer accepted authority before provider admission"
    );
    assert!(held_until_join);
}

async fn late_access_negative(lose_owner: bool) {
    let mut r = rig();
    let stamp = access_slot(&r);
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    *r.state.backup_worker.pending_access_exit.lock().unwrap() = Some((entered_tx, release_rx));
    let ack = manual(&r.state, "one", "late-access-negative").await;
    entered_rx.await.unwrap();
    let attempt = access_attempt(&r, &ack, "shell-b");
    assert_eq!(
        access_attach(&r, &attempt, &stamp, "/native-authorized").await["state"],
        "accepted"
    );
    if lose_owner {
        access::owner_lost(&r.state, "shell-b");
    } else {
        app_db::with(&r.state.app_dir, |c| {
            app_db::locations::save_meta(
                c,
                "external-backup",
                "/changed-choice",
                "native",
                2,
                false,
            )
        })
        .unwrap();
    }
    release_tx.send(()).unwrap();
    let provider = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(call) = r.calls.try_recv() {
                break Some(call);
            }
            let s = r.state.backup_worker.status();
            if s["pendingAccess"]
                .as_array()
                .is_some_and(|a| a.iter().any(|i| i["executionId"] != ack["executionId"]))
                && s["accessReceipts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["attempt"] == attempt && v["safeRelease"] == true)
            {
                break None;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let did_start = provider.is_some();
    if let Some(c) = provider {
        c.reply.send(Ok(result(1))).ok().unwrap();
        wait(&r.state, |s| s["active"].is_null()).await;
    }
    let drained = access_query(&r, &attempt, false).await["state"] == "drained";
    let no_history = settings(&r.state)["backupHistory"]["one"].is_null();
    finish(r).await;
    assert!(
        !did_start,
        "late authority bypassed fresh slot/owner validation"
    );
    assert!(drained);
    assert!(no_history);
}
#[tokio::test]
async fn backup_access_late_attach_revalidates_slot_before_provider() {
    late_access_negative(false).await;
}
#[tokio::test]
async fn backup_access_late_attach_cannot_keep_a_lost_owner() {
    late_access_negative(true).await;
}

#[tokio::test]
async fn backup_access_cap_wake_during_pending_probe_is_not_lost() {
    let mut r = rig();
    enabled(&r.state);
    patch(
        &r.state,
        json!({"transferLimits":{"one":{"capEnabled":true,"dailyDownLimitBytes":1024}}}),
    );
    manual(&r.state, "one", "cap-probe-wake").await;
    let c = call(&mut r).await;
    let mut terminal = frame(&c.ctx);
    terminal.cancelled = true;
    terminal.stop_reason = Some("limit_reached");
    terminal.limit_bytes = Some(1024);
    terminal.resume_after_ms = Some((NOW + 10_000) as u64);
    (c.ctx.on_progress)(terminal);
    let mut limited = result(0);
    limited.success = false;
    limited.cancelled = true;
    c.reply.send(Ok(limited)).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["cap-probe-wake"]["status"] == "limit_reached"
    })
    .await;
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    *r.state.backup_worker.pending_limit_exit.lock().unwrap() = Some((entered_tx, release_rx));
    automatic(&r.state, false);
    entered_rx.await.unwrap();
    patch(
        &r.state,
        json!({"transferLimits":{"one":{"capEnabled":false}}}),
    );
    wake(&r.state);
    let (done, consumed) = oneshot::channel();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Probe { done })
        .unwrap();
    consumed.await.unwrap();
    release_tx.send(()).unwrap();
    let next = tokio::time::timeout(Duration::from_secs(2), r.calls.recv())
        .await
        .ok()
        .flatten();
    let resumed = next.is_some();
    if let Some(c) = next {
        assert_eq!(c.ctx.skip_folders, 0);
        c.reply.send(Ok(result(1))).ok().unwrap();
        wait(&r.state, |s| {
            s["active"].is_null() && s["lastOutcomes"].as_array().is_some_and(|a| a.len() >= 2)
        })
        .await;
    }
    finish(r).await;
    assert!(resumed,"a real cap-change Wake consumed during preparing was lost after its old limit Pending result");
}

#[tokio::test]
async fn backup_access_unavailable_observations_stay_quiet_and_can_recover() {
    let mut r = rig();
    let stamp = access_slot(&r);
    let ack = manual(&r.state, "one", "unavailable-fix1").await;
    wait(&r.state, |s| {
        !s["pendingAccess"].as_array().unwrap().is_empty()
    })
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (done, idle) = oneshot::channel();
            r.state
                .backup_worker
                .tx
                .get()
                .unwrap()
                .send(Cmd::AccessIdle { done })
                .unwrap();
            if idle.await.unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let revision = r.state.backup_worker.status()["revision"].clone();
    let mut events = r.state.events.subscribe();
    let mut attempts = Vec::new();
    for status in ["unavailable", "unknown"] {
        let attempt = access_attempt(&r, &ack, "shell-unavailable");
        let reply = rpc(
            &r.state,
            "backup.attach_access",
            json!({"attempt":attempt,"slotStamp":stamp,"resolution":{"status":status}}),
        )
        .await;
        assert_eq!(reply["state"], "rejected");
        attempts.push(attempt);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let (done, idle) = oneshot::channel();
                r.state
                    .backup_worker
                    .tx
                    .get()
                    .unwrap()
                    .send(Cmd::AccessIdle { done })
                    .unwrap();
                if idle.await.unwrap() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    let quiet_revision = r.state.backup_worker.status()["revision"].clone();
    let mut needed = 0;
    while let Ok(event) = events.try_recv() {
        if serde_json::from_str::<Value>(&event).unwrap()["params"]["name"]
            == "backup-access-needed"
        {
            needed += 1;
        }
    }
    let pending = r.state.backup_worker.status();
    let same = pending["pendingAccess"][0]["executionId"] == ack["executionId"]
        && pending["pendingAccess"][0]["runId"] == ack["runId"];
    let no_history = settings(&r.state)["backupHistory"]["one"].is_null();
    let no_provider = r.calls.try_recv().is_err();
    let authorized = access_attempt(&r, &ack, "shell-unavailable");
    access_attach(&r, &authorized, &stamp, "/native-authorized").await;
    let c = call(&mut r).await;
    c.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state, |s| {
        s["requests"]["unavailable-fix1"]["status"] == "success"
    })
    .await;
    finish(r).await;
    assert!(same && no_history && no_provider);
    assert_eq!(
        quiet_revision, revision,
        "unchanged unavailable/unknown access re-probed pending intent"
    );
    assert_eq!(
        needed, 0,
        "unavailable observation published its own next resolver trigger"
    );
}

fn observation(
    surface: &str,
    session: &str,
    sequence: u64,
    kind: &str,
    activity: i64,
    loading: bool,
) -> Value {
    if kind == "retire" {
        return json!({"surfaceId":surface,"sessionId":session,"sequence":sequence,"kind":kind});
    }
    json!({"surfaceId":surface,"sessionId":session,"sequence":sequence,"kind":kind,"lastActivityAt":activity,"loading":loading,"visibility":"visible","online":true,"observedAt":NOW})
}
#[tokio::test]
async fn backup_worker_retired_surface_cannot_resume_or_clear_main_loading() {
    let mut r = rig();
    enabled(&r.state);
    rpc(
        &r.state,
        "backup.context",
        observation("main", "a", 1, "attach", NOW - 180_000, true),
    )
    .await;
    rpc(
        &r.state,
        "backup.context",
        observation("child", "b", 1, "attach", NOW - 180_000, false),
    )
    .await;
    rpc(
        &r.state,
        "backup.context",
        observation("child", "b", 2, "retire", 0, false),
    )
    .await;
    let rejected = rpc(
        &r.state,
        "backup.context",
        observation("child", "b", 3, "update", 0, false),
    )
    .await;
    assert_eq!(rejected["accepted"], false);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(r.calls.try_recv().is_err(), "child cleared main loading");
    rpc(
        &r.state,
        "backup.context",
        observation("main", "a", 2, "retire", 0, false),
    )
    .await;
    let c = call(&mut r).await;
    c.reply.send(Ok(result(1))).ok();
    wait(&r.state, |s| {
        !s["lastOutcomes"].as_array().unwrap().is_empty()
    })
    .await;
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_context_sequence_and_strictmode_fence_late_attach() {
    let r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "old", 2, "retire", 0, false),
    )
    .await;
    let old = rpc(
        &r.state,
        "backup.context",
        observation("main", "old", 1, "attach", NOW, true),
    )
    .await;
    assert_eq!(old["accepted"], false);
    let new = rpc(
        &r.state,
        "backup.context",
        observation("main", "new", 1, "attach", NOW, false),
    )
    .await;
    assert_eq!(new["accepted"], true);
    let stale = rpc(
        &r.state,
        "backup.context",
        observation("main", "new", 1, "update", 0, true),
    )
    .await;
    assert_eq!(stale["accepted"], false);
    assert!(!r.state.backup_worker.facts.lock().unwrap().loading);
    finish(r).await;
}

#[tokio::test]
async fn backup_worker_snapshot_success_is_native_without_ui_listener() {
    let mut r = rig();
    patch(
        &r.state,
        json!({"billingProfile":{"hasSubscription":true,"status":"active"},"snapshotAutoEnabled":true,"snapshotCadence":"after_every_backup"}),
    );
    std::fs::write(
        r.state.app_dir.join("accounts.json"),
        r#"[{"id":"one","email":"one@test"},{"id":"two","email":"two@test"}]"#,
    )
    .unwrap();
    let cur = r.state.data_dir.join("Maildir/one/INBOX/cur");
    std::fs::create_dir_all(&cur).unwrap();
    std::fs::write(
        cur.join(format!("7{}AS.eml", mailvault_core::maildir::INFO_PREFIX)),
        b"From: fixture@test\r\n\r\nfixture",
    )
    .unwrap();
    let ack = manual(&r.state, "one", "snapshot-native").await;
    let c = call(&mut r).await;
    c.reply.send(Ok(result(1))).ok();
    wait(&r.state, |s| {
        s["requests"]["snapshot-native"]["status"] == "success"
    })
    .await;
    let saved = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if settings(&r.state)["snapshotLastTimes"]["one"]
                .as_i64()
                .is_some()
            {
                return true;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    assert!(
        saved,
        "successful native completion never created/applied its automatic snapshot"
    );
    let snapshots = crate::snapshot::list_snapshots(&r.state.data_dir, "one").unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let replay = manual(&r.state, "one", "snapshot-native").await;
    assert_eq!(replay["runId"], ack["runId"]);
    assert_eq!(
        crate::snapshot::list_snapshots(&r.state.data_dir, "one")
            .unwrap()
            .len(),
        1
    );
    finish(r).await;
}

#[test]
fn backup_worker_snapshot_recovery_preserves_receipts_and_skips_legacy() {
    let r = tempfile::tempdir().unwrap();
    let state = DaemonState::for_test(r.path().join("mail"), r.path().into(), true);
    let make = |applied, snapshot| Outcome {
        intent: new_intent(&state, "one".into(), true),
        status: "success".into(),
        at: NOW,
        result: Some(json!({"success":true})),
        terminal: None,
        error: None,
        applied,
        snapshot,
    };
    let mut ledger = Ledger::default();
    ledger.outcomes = vec![
        make(true, Value::Null),
        make(false, Value::Null),
        make(true, json!({"status":"queued"})),
        make(true, json!({"status":"dispatched"})),
        make(
            true,
            json!({"status":"created","receipt":{"filename":"known.gz"},"createdAt":NOW}),
        ),
    ];
    assert!(snapshots::recover(&mut ledger));
    assert_eq!(ledger.outcomes[0].snapshot["reason"], "legacy_skipped");
    assert!(ledger.outcomes[1].snapshot.is_null());
    assert_eq!(ledger.outcomes[2].snapshot["status"], "queued");
    assert_eq!(ledger.outcomes[3].snapshot["status"], "uncertain");
    assert_eq!(
        ledger.outcomes[4].snapshot["receipt"]["filename"],
        "known.gz"
    );
}

#[tokio::test]
async fn backup_worker_snapshot_scan_keeps_controls_responsive_and_stop_truthful() {
    let mut r = rig();
    patch(
        &r.state,
        json!({"billingProfile":{"hasSubscription":true,"status":"active"},"snapshotAutoEnabled":true}),
    );
    std::fs::write(
        r.state.app_dir.join("accounts.json"),
        r#"[{"id":"one","email":"one@test"}]"#,
    )
    .unwrap();
    std::fs::create_dir_all(r.state.data_dir.join("Maildir/one/INBOX/cur")).unwrap();
    let (entered, rx) = oneshot::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    *r.state.backup_worker.snapshot_barrier.lock().unwrap() = Some((entered, wait_release));
    manual(&r.state, "one", "snapshot-held").await;
    let c = call(&mut r).await;
    c.reply.send(Ok(result(1))).ok();
    tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .unwrap()
        .unwrap();
    let s = rpc(&r.state, "backup.schedule.status", json!({})).await;
    assert_eq!(s["requests"]["snapshot-held"]["status"], "success");
    assert_eq!(s["lastOutcomes"][0]["snapshot"]["status"], "dispatched");
    patch(&r.state, json!({"language":"de"}));
    rpc(&r.state, "backup.stop", json!({})).await;
    assert_eq!(
        r.state.backup_worker.status()["lastOutcomes"][0]["snapshot"]["status"],
        "dispatched",
        "Stop pretended the scan drained"
    );
    release.send(()).unwrap();
    wait(&r.state, |s| {
        s["lastOutcomes"][0]["snapshot"]["status"] == "applied"
    })
    .await;
    assert_eq!(settings(&r.state)["language"], "de");
    assert!(settings(&r.state)["snapshotLastTimes"]["one"]
        .as_i64()
        .is_some());
    finish(r).await;
}

#[tokio::test]
async fn backup_worker_snapshot_explicit_undecided_is_decided_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let state = DaemonState::for_test(dir.path().join("mail"), dir.path().into(), true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir)
        .replace(
            &json!({STORE:{"version":3,"state":{"snapshotAutoEnabled":false}}}),
            None,
        )
        .unwrap();
    let mut ledger = Ledger::default();
    ledger.outcomes.push(Outcome {
        intent: new_intent(&state, "one".into(), true),
        status: "success".into(),
        at: NOW,
        result: Some(json!({"success":true})),
        terminal: None,
        error: None,
        applied: true,
        snapshot: json!({"status":"undecided"}),
    });
    snapshots::recover(&mut ledger);
    snapshots::drive(&state, &mut ledger).await.unwrap();
    assert_eq!(
        ledger.outcomes[0].snapshot["status"], "not_due",
        "new-version undecided completion was stranded as an unknown snapshot state"
    );
}
#[tokio::test]
async fn backup_worker_snapshot_new_completion_records_decision_before_applied_boundary() {
    let mut r = rig();
    let mut events = r.state.events.subscribe();
    let ack = manual(&r.state, "one", "new-snapshot-state").await;
    let c = call(&mut r).await;
    c.reply.send(Ok(result(1))).ok();
    let observed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let line = events.recv().await.unwrap();
            let event: Value = serde_json::from_str(&line).unwrap();
            if event["params"]["name"] != EVENT {
                continue;
            }
            if let Some(out) = event["params"]["payload"]["lastOutcomes"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|o| o["intent"]["runId"] == ack["runId"] && o["applied"] == false)
                })
            {
                break out.clone();
            }
        }
    })
    .await
    .unwrap();
    finish(r).await;
    assert_eq!(
        observed["snapshot"]["status"], "undecided",
        "new completion did not persist ownership before history application"
    );
}
#[tokio::test]
async fn backup_worker_snapshot_unapplied_legacy_gains_explicit_decision_before_ack() {
    let dir = tempfile::tempdir().unwrap();
    let state = DaemonState::for_test(dir.path().join("mail"), dir.path().into(), true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir)
        .replace(
            &json!({STORE:{"version":3,"state":{"backupState":{},"backupHistory":{}}}}),
            None,
        )
        .unwrap();
    let mut ledger = Ledger::default();
    ledger.outcomes.push(Outcome {
        intent: new_intent(&state, "one".into(), true),
        status: "success".into(),
        at: NOW,
        result: Some(json!({"success":true})),
        terminal: None,
        error: None,
        applied: false,
        snapshot: Value::Null,
    });
    apply_retained(&state, &mut ledger).await.unwrap();
    let mut after_crash = read_ledger(&state.app_dir).unwrap();
    snapshots::recover(&mut after_crash);
    assert_eq!(
        after_crash.outcomes[0].snapshot["status"], "undecided",
        "applying a retained legacy outcome lost its new-version snapshot decision"
    );
}

#[tokio::test(start_paused = true)]
async fn backup_worker_native_idle_deadline_starts_without_js_tick() {
    let mut r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "idle", 1, "attach", NOW, false),
    )
    .await;
    enabled(&r.state);
    wake(&r.state);
    paused_quiescent(&r.state).await;
    r.state.clock.set(NOW + 179_999);
    tokio::time::advance(Duration::from_millis(179_999)).await;
    paused_quiescent(&r.state).await;
    assert!(r.calls.try_recv().is_err());
    r.state.clock.set(NOW + 180_000);
    tokio::time::advance(Duration::from_millis(1)).await;
    let c = paused_call(&mut r).await;
    assert_eq!(c.ctx.account_id, "one");
    c.reply.send(Ok(result(1))).ok();
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_hidden_gap_and_retired_wake_keep_stop_fence() {
    let r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "heartbeat", 1, "attach", NOW, false),
    )
    .await;
    let mut hidden = observation("main", "heartbeat", 2, "update", NOW, false);
    hidden["visibility"] = json!("hidden");
    hidden["heartbeatGap"] = json!(75000);
    rpc(&r.state, "backup.context", hidden).await;
    assert!(!r.state.backup_worker.facts.lock().unwrap().paused);
    let mut slept = observation("main", "heartbeat", 3, "update", NOW, false);
    slept["heartbeatGap"] = json!(150001);
    rpc(&r.state, "backup.context", slept).await;
    assert!(r.state.backup_worker.facts.lock().unwrap().paused);
    rpc(&r.state, "backup.stop", json!({})).await;
    rpc(
        &r.state,
        "backup.context",
        observation("main", "heartbeat", 4, "retire", 0, false),
    )
    .await;
    r.state.clock.set(NOW + 20000);
    wake(&r.state);
    rpc(
        &r.state,
        "backup.context",
        observation("main", "heartbeat", 5, "update", NOW, false),
    )
    .await;
    assert!(!r.state.backup_worker.facts.lock().unwrap().automatic);
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_activity_consumption_fences_due_scan_and_destroyed_surface() {
    let mut r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "loading", 1, "attach", NOW, true),
    )
    .await;
    enabled(&r.state);
    let epoch = r.state.backup_worker.epoch.load(SeqCst);
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Due {
            epoch,
            ids: vec!["one".into()],
        })
        .unwrap();
    let (done, rx) = oneshot::channel();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Probe { done })
        .unwrap();
    rx.await.unwrap();
    assert!(r.state.backup_worker.status()["queue"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(r.calls.try_recv().is_err());
    rpc(
        &r.state,
        "backup.surface_retire",
        json!({"surfaceId":"main"}),
    )
    .await;
    let late = rpc(
        &r.state,
        "backup.context",
        observation("main", "late", 1, "attach", NOW, true),
    )
    .await;
    assert_eq!(late["accepted"], false);
    assert!(!r.state.backup_worker.facts.lock().unwrap().loading);
    assert_eq!(
        r.state.backup_worker.facts.lock().unwrap().last_activity,
        NOW
    );
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_snapshot_created_receipt_repairs_only_time_and_never_regresses() {
    let dir = tempfile::tempdir().unwrap();
    let state = DaemonState::for_test(dir.path().join("mail"), dir.path().into(), true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir)
        .replace(
            &json!({STORE:{"version":3,"state":{"language":"de","snapshotLastTimes":{}}}}),
            None,
        )
        .unwrap();
    let mut ledger = Ledger::default();
    ledger.outcomes.push(Outcome{intent:new_intent(&state,"one".into(),true),status:"success".into(),at:NOW,result:Some(json!({"success":true})),terminal:None,error:None,applied:true,snapshot:json!({"status":"created","receipt":{"filename":"already-created.gz"},"createdAt":NOW})});
    snapshots::drive(&state, &mut ledger).await.unwrap();
    assert_eq!(ledger.outcomes[0].snapshot["status"], "applied");
    assert_eq!(settings(&state)["snapshotLastTimes"]["one"], NOW);
    assert_eq!(settings(&state)["language"], "de");
    assert!(
        !state.data_dir.join("snapshots").exists(),
        "repair called the manifest helper"
    );
    patch(&state, json!({"snapshotLastTimes":{"one":NOW+10000}}));
    ledger.outcomes[0].snapshot["status"] = json!("created");
    snapshots::drive(&state, &mut ledger).await.unwrap();
    assert_eq!(settings(&state)["snapshotLastTimes"]["one"], NOW + 10000);
}
#[tokio::test]
async fn backup_worker_snapshot_helper_failure_does_not_fail_manual_history() {
    let mut r = rig();
    patch(
        &r.state,
        json!({"billingProfile":{"hasSubscription":true,"status":"active"},"snapshotAutoEnabled":true}),
    );
    std::fs::write(
        r.state.app_dir.join("accounts.json"),
        r#"[{"id":"one","email":"one@test"}]"#,
    )
    .unwrap();
    manual(&r.state, "one", "snapshot-failure").await;
    let c = call(&mut r).await;
    c.reply.send(Ok(result(2))).ok();
    let s = wait(&r.state, |s| {
        s["lastOutcomes"][0]["snapshot"]["status"] == "failed"
    })
    .await;
    assert_eq!(s["requests"]["snapshot-failure"]["status"], "success");
    assert_eq!(
        settings(&r.state)["backupHistory"]["one"][0]["success"],
        true
    );
    assert!(settings(&r.state)["snapshotLastTimes"]["one"].is_null());
    finish(r).await;
}

#[tokio::test]
async fn backup_worker_pause_manual_join_preserves_pause_and_real_drain() {
    let mut r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "pause", 1, "attach", NOW - 180000, false),
    )
    .await;
    enabled(&r.state);
    wake(&r.state);
    let c = call(&mut r).await;
    let active = r.state.backup_worker.status()["active"].clone();
    let mut offline = observation("main", "pause", 2, "update", NOW - 180000, false);
    offline["online"] = json!(false);
    rpc(&r.state, "backup.context", offline).await;
    let ack = manual(&r.state, "one", "pause-join").await;
    assert_eq!(ack["runId"], active["runId"]);
    assert!(
        r.calls.try_recv().is_err(),
        "manual join overlapped the interrupted execution"
    );
    let mut cancelled = result(1);
    cancelled.success = false;
    cancelled.cancelled = true;
    c.reply.send(Ok(cancelled)).ok();
    let resumed = call(&mut r).await;
    assert_eq!(
        r.state.backup_worker.status()["active"]["runId"],
        active["runId"]
    );
    assert_ne!(
        r.state.backup_worker.status()["active"]["executionId"],
        active["executionId"]
    );
    assert!(r.state.backup_worker.facts.lock().unwrap().paused);
    resumed.reply.send(Ok(result(1))).ok();
    wait(&r.state, |s| {
        s["requests"]["pause-join"]["status"] == "success"
    })
    .await;
    assert!(r.state.backup_worker.facts.lock().unwrap().paused);
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_pause_after_real_success_does_not_repeat_completed_run() {
    let mut r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "completed-pause", 1, "attach", NOW - 180000, false),
    )
    .await;
    enabled(&r.state);
    wake(&r.state);
    let c = call(&mut r).await;
    let mut offline = observation("main", "completed-pause", 2, "update", NOW - 180000, false);
    offline["online"] = json!(false);
    rpc(&r.state, "backup.context", offline).await;
    c.reply.send(Ok(result(3))).ok();
    let completed = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            if settings(&r.state)["backupState"]["one"]["lastStatus"] == "success" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    finish(r).await;
    assert!(
        completed,
        "a successfully drained backup was discarded merely because a pause raced its return"
    );
}

#[tokio::test]
async fn backup_worker_foreign_authorization_channel_cannot_retire_surface_facts() {
    let r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("surface-owner:main", "live", 1, "attach", NOW, true),
    )
    .await;
    let foreign = channel_owner(&r.state, Some("foreign-authorizer")).unwrap();
    drop(foreign);
    let (done, rx) = oneshot::channel();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Probe { done })
        .unwrap();
    rx.await.unwrap();
    let still_loading = r.state.backup_worker.facts.lock().unwrap().loading;
    finish(r).await;
    assert!(
        still_loading,
        "an unrelated mirror authorizer erased live surface loading"
    );
}
#[tokio::test]
async fn backup_worker_surface_channel_retires_only_its_generation_and_reconnects_fresh() {
    let r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("shell-a:main", "a", 1, "attach", NOW, true),
    )
    .await;
    rpc(
        &r.state,
        "backup.context",
        observation("shell-b:settings", "b", 1, "attach", NOW, false),
    )
    .await;
    // This RAII hook is installed by the real channel.open handler, separately
    // from its unchanged mirror authorization owner.
    let owner = surface_channel_owner(&r.state, Some("shell-a")).unwrap();
    drop(owner);
    let (done, rx) = oneshot::channel();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Probe { done })
        .unwrap();
    rx.await.unwrap();
    let own_old = rpc(
        &r.state,
        "backup.context",
        observation("shell-a:main", "a", 2, "update", NOW, true),
    )
    .await;
    let other = rpc(
        &r.state,
        "backup.context",
        observation("shell-b:settings", "b", 2, "update", NOW, false),
    )
    .await;
    let delayed = rpc(
        &r.state,
        "backup.context",
        observation("shell-a:main", "unseen-before-loss", 1, "attach", NOW, true),
    )
    .await;
    let fresh = rpc(
        &r.state,
        "backup.context",
        observation("shell-a-new:main", "fresh", 1, "attach", NOW, true),
    )
    .await;
    finish(r).await;
    assert_eq!(own_old["accepted"], false);
    assert_eq!(
        other["accepted"], true,
        "the owning drop retired a different surface generation"
    );
    assert_eq!(
        delayed["accepted"], false,
        "a delayed old-generation attach resurrected loading"
    );
    assert_eq!(
        fresh["accepted"], true,
        "same-process reconnect could not establish fresh facts"
    );
}

#[tokio::test]
async fn backup_worker_config_removal_cannot_rearm_stop_but_explicit_enable_can() {
    async fn consumed(state: &Arc<DaemonState>) {
        let (done, rx) = oneshot::channel();
        state
            .backup_worker
            .tx
            .get()
            .unwrap()
            .send(Cmd::Probe { done })
            .unwrap();
        rx.await.unwrap();
    }
    let r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "stop-config", 1, "attach", NOW, true),
    )
    .await;
    rpc(&r.state, "backup.stop", json!({})).await;
    rpc(
        &r.state,
        "backup.schedule.set",
        json!({"patch":{"backupSchedules":{"one":null}}}),
    )
    .await;
    consumed(&r.state).await;
    let removed = r.state.backup_worker.facts.lock().unwrap().automatic;
    rpc(
        &r.state,
        "backup.schedule.set",
        json!({"patch":{"backupSchedules":{"one":{"enabled":false,"interval":"daily"}}}}),
    )
    .await;
    consumed(&r.state).await;
    let disabled = r.state.backup_worker.facts.lock().unwrap().automatic;
    rpc(
        &r.state,
        "backup.schedule.set",
        json!({"patch":{"backupSchedules":{"one":{"enabled":true,"interval":"daily"}}}}),
    )
    .await;
    let (done, rx) = oneshot::channel();
    r.state
        .backup_worker
        .tx
        .get()
        .unwrap()
        .send(Cmd::Probe { done })
        .unwrap();
    rx.await.unwrap();
    let enabled = r.state.backup_worker.facts.lock().unwrap().automatic;
    finish(r).await;
    assert!(!removed, "removing a schedule silently rearmed Stop");
    assert!(!disabled, "disabling a schedule silently rearmed Stop");
    assert!(enabled, "explicit enable did not rearm native ownership");
}

// Signal at the real foreground wait; final admission must observe facts consumed here.
async fn foreground_admission_regression(activity: bool, manual_run: bool) {
    let mut r = rig();
    rpc(
        &r.state,
        "backup.context",
        observation("main", "foreground", 1, "attach", NOW - 180_000, false),
    )
    .await;
    let (entered, waiting) = oneshot::channel();
    *r.state
        .backup_worker
        .foreground_wait_entered
        .lock()
        .unwrap() = Some(entered);
    crate::search_index::note_foreground(&r.state.search_index);
    if manual_run {
        manual(&r.state, "one", "foreground-manual").await;
    } else {
        enabled(&r.state);
        wake(&r.state);
    }
    tokio::time::timeout(Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    // Refresh the real 400ms quiet period, then consume a real surface observation.
    crate::search_index::note_foreground(&r.state.search_index);
    rpc(
        &r.state,
        "backup.context",
        observation(
            "main",
            "foreground",
            2,
            "update",
            if activity { NOW } else { NOW - 180_000 },
            !activity,
        ),
    )
    .await;
    if manual_run {
        let c = call(&mut r).await;
        c.reply.send(Ok(result(1))).ok();
        finish(r).await;
        return;
    }
    let early = tokio::select! {
        c = r.calls.recv() => Some(c.unwrap()),
        _ = wait(&r.state, |s| s["active"].is_null() && s["queue"].as_array().is_some_and(|q|q.iter().any(|i|i["stage"] == "pending_policy"))) => None,
    };
    if let Some(c) = early {
        c.reply.send(Ok(result(1))).ok();
        finish(r).await;
        panic!("automatic provider entered after new activity/loading during foreground wait");
    }
    assert!(r.calls.try_recv().is_err());
    r.state.clock.set(NOW + 180_001);
    rpc(
        &r.state,
        "backup.context",
        observation("main", "foreground", 3, "update", NOW, false),
    )
    .await;
    wake(&r.state);
    let c = call(&mut r).await;
    c.reply.send(Ok(result(1))).ok();
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_foreground_wait_rechecks_activity_before_provider() {
    foreground_admission_regression(true, false).await;
}
#[tokio::test]
async fn backup_worker_foreground_wait_rechecks_loading_before_provider() {
    foreground_admission_regression(false, false).await;
}
#[tokio::test]
async fn backup_worker_foreground_wait_preserves_manual_bypass() {
    foreground_admission_regression(false, true).await;
}
#[tokio::test]
async fn backup_worker_snapshot_recovery_decides_seven_unsettled_before_compaction() {
    let dir = tempfile::tempdir().unwrap();
    let state = DaemonState::for_test(dir.path().join("mail"), dir.path().into(), true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir)
        .replace(
            &json!({STORE:{"version":3,"state":{"snapshotAutoEnabled":false}}}),
            None,
        )
        .unwrap();
    let mut ledger = Ledger::default();
    for n in 0..7 {
        ledger.outcomes.push(Outcome {
            intent: new_intent(&state, "one".into(), true),
            status: "success".into(),
            at: NOW + n,
            result: Some(json!({"success":true})),
            terminal: None,
            error: None,
            applied: true,
            snapshot: json!({"status":"undecided"}),
        });
    }
    save_ledger(&state.app_dir, &ledger).unwrap();
    let mut recovered = read_ledger(&state.app_dir).unwrap();
    snapshots::recover(&mut recovered);
    snapshots::drive(&state, &mut recovered).await.unwrap();
    assert_eq!(recovered.outcomes.len(), 5);
    assert!(recovered
        .outcomes
        .iter()
        .all(|o| o.snapshot["status"] == "not_due"));
    assert_eq!(
        recovered.outcomes.iter().map(|o| o.at).collect::<Vec<_>>(),
        (2..7).map(|n| NOW + n).collect::<Vec<_>>()
    );
    assert_eq!(read_ledger(&state.app_dir).unwrap().outcomes.len(), 5);
}
