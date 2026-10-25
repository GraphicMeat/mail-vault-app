use super::*;
use crate::server::handle_request_for_test;
use mailvault_core::backup::{BackupResult, BackupRunContext, BackupProgress};
const NOW:i64=1_792_929_600_000;
struct Call { ctx:BackupRunContext, reply:oneshot::Sender<Result<BackupResult,String>> }
struct Rig { _dir:tempfile::TempDir,state:Arc<DaemonState>,calls:UnboundedReceiver<Call>,worker:tokio::task::JoinHandle<()> }
fn settings(state:&Arc<DaemonState>)->Value { SettingsDoc::shared(&state.app_dir).get(None).unwrap().values[STORE]["state"].clone() }
fn patch(state:&Arc<DaemonState>, value:Value) { SettingsDoc::shared(&state.app_dir).patch(&json!({STORE:{"state":value}}),None).unwrap(); }
fn rig()->Rig { rig_with_resolve(Arc::new(|_,id,_|Box::pin(async move {Ok(serde_json::from_value(json!({"email":format!("{id}@test"),"imapHost":"127.0.0.1","imapPort":1})).unwrap())}))) }
fn rig_with_resolve(resolve:Resolve)->Rig {
    let dir=tempfile::tempdir().unwrap();
    let state=DaemonState::for_test(dir.path().join("mail"),dir.path().into(),true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir).replace(&json!({STORE:{"version":3,"state":{"language":"lt","backupState":{},"backupHistory":{}}}}),None).unwrap();
    std::fs::write(dir.path().join("accounts.json"),r#"[{"id":"one"},{"id":"two"}]"#).unwrap();
    let (call_tx,calls)=unbounded_channel();
    let services=Services {
        resolve,
        provider:Arc::new(move |ctx| {let tx=call_tx.clone();Box::pin(async move {let(reply,rx)=oneshot::channel();tx.send(Call{ctx,reply}).unwrap();rx.await.unwrap()})})
    };
    let (tx,rx)=unbounded_channel();state.backup_worker.tx.set(tx).ok().unwrap();
    let worker=tokio::spawn(worker_loop(state.clone(),rx,services));
    Rig{_dir:dir,state,calls,worker}
}
async fn rpc(state:&Arc<DaemonState>, method:&str,params:Value)->Value {
    let response=handle_request_for_test(state,method,params).await;
    assert!(response.error.is_none(),"{method}: {:?}",response.error);response.result.unwrap()
}
async fn manual(state:&Arc<DaemonState>,id:&str,request:&str)->Value { rpc(state,"backup.run_now",json!({"accountId":id,"requestId":request})).await }
async fn call(rig:&mut Rig)->Call {match tokio::time::timeout(Duration::from_secs(2),rig.calls.recv()).await {Ok(Some(call))=>call,_=>panic!("provider not called; lifecycle {}",rig.state.backup_worker.status())}}
async fn wait(state:&Arc<DaemonState>, predicate:impl Fn(&Value)->bool)->Value {
    tokio::time::timeout(Duration::from_secs(3),async {loop {let s=state.backup_worker.status();if predicate(&s){return s;}tokio::task::yield_now().await;}}).await.expect("worker never published expected lifecycle state")
}
fn result(emails:usize)->BackupResult {BackupResult{emails_backed_up:emails,errors:0,duration_secs:2.0,success:true,error_message:None,cancelled:false,completed_folders:4,external_copy_ok:true,external_copy_error:None,external_copy_failed_count:0}}
fn frame(ctx:&BackupRunContext)->BackupProgress {adapter::failed_frame(&ctx.account_id,"fixture error".into())}
// JSON stores JavaScript's integral seconds as 0 and Rust's f64 seconds as
// 0.0. Assert numeric duration equality, then compare every remaining field.
fn assert_history(actual:&Value,expected:&Value) {
    let mut actual=actual.clone();let a=actual.as_array_mut().unwrap();let e=expected.as_array().unwrap();assert_eq!(a.len(),e.len());
    for (a,e) in a.iter_mut().zip(e){assert_eq!(a["durationSecs"].as_f64(),e["durationSecs"].as_f64());a["durationSecs"]=e["durationSecs"].clone();}
    assert_eq!(&actual,expected);
}
async fn finish(rig:Rig) {let _=rig.state.backup_worker.tx.get().unwrap().send(Cmd::Shutdown);rig.worker.await.unwrap();}

#[tokio::test]
async fn backup_worker_manual_join_claim_and_retained_completion() {
    let mut r=rig();let guard=adapter::claim_run(&r.state,"one").unwrap();let token=guard.cancel();
    let first=manual(&r.state,"one","first").await;
    let again=manual(&r.state,"one","joined").await;assert_eq!(first["runId"],again["runId"]);
    manual(&r.state,"two","other").await;let c=call(&mut r).await;assert_eq!(c.ctx.account_id,"two");
    assert!(Arc::ptr_eq(r.state.backup_runs.lock().unwrap().get("one").unwrap(),&token));
    c.reply.send(Ok(result(2))).ok().unwrap();drop(guard);r.state.backup_worker.tx.get().unwrap().send(Cmd::Wake).unwrap();
    let c=call(&mut r).await;assert_eq!(c.ctx.account_id,"one");
    let replay=manual(&r.state,"one","first").await;assert_eq!(replay["runId"],first["runId"]);
    adapter::backup_cancel(&r.state,json!({"accountId":"one"})).await.unwrap();assert!(!c.ctx.cancel.load(SeqCst),"legacy cancel crossed native ownership");
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    c.reply.send(Ok(result(7))).ok().unwrap();
    wait(&r.state,|s|s["requests"]["first"]["status"]=="success" && s["requests"]["joined"]["status"]=="success").await;
    assert_eq!(settings(&r.state)["backupState"]["one"]["emailsBackedUp"],7);
    assert_eq!(settings(&r.state)["backupHistory"]["one"].as_array().unwrap().len(),1);
    let completed=manual(&r.state,"one","first").await;assert_eq!(completed["status"],"success");
    assert!(r.calls.try_recv().is_err());finish(r).await;
}
#[tokio::test]
async fn backup_worker_terminal_limit_waits_for_real_join_and_captures_metadata() {
    let mut r=rig();let ack=manual(&r.state,"one","limit").await;let c=call(&mut r).await;
    let mut terminal=frame(&c.ctx);terminal.cancelled=true;terminal.stop_reason=Some("limit_reached");terminal.limit_bytes=Some(1024);terminal.resume_after_ms=Some((NOW+1000) as u64);terminal.completed_folders=4;
    (c.ctx.on_progress)(terminal);
    rpc(&r.state,"backup.cancel",json!({"runId":ack["runId"]})).await;
    assert!(c.ctx.cancel.load(SeqCst));
    let status=rpc(&r.state,"backup.schedule.status",json!({})).await;
    assert_eq!(status["active"]["runId"],ack["runId"]);
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    let mut out=result(3);out.cancelled=true;out.success=false;c.reply.send(Ok(out)).ok().unwrap();
    let s=wait(&r.state,|s|s["requests"]["limit"]["status"]=="limit_reached").await;
    assert_eq!(s["lastOutcomes"][0]["terminal"]["limit_bytes"],1024);
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    assert_eq!(s["queue"][0]["notBefore"],NOW+31_000);
    finish(r).await;
}
#[tokio::test]
async fn backup_worker_stop_cancels_owned_work_but_keeps_drain_truth() {
    let mut r=rig();manual(&r.state,"one","active").await;let c=call(&mut r).await;manual(&r.state,"two","queued").await;
    rpc(&r.state,"backup.stop",json!({})).await;
    assert!(c.ctx.cancel.load(SeqCst));
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    let mut out=result(0);out.cancelled=true;c.reply.send(Ok(out)).ok().unwrap();
    wait(&r.state,|s|s["active"].is_null() && s["requests"]["queued"]["status"]=="cancelled").await;
    r.state.clock.set(NOW+1_000_000);r.state.backup_worker.tx.get().unwrap().send(Cmd::Wake).unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;assert!(r.calls.try_recv().is_err());finish(r).await;
}
#[tokio::test]
async fn backup_worker_configured_and_unknown_slot_stay_pending_without_provider() {
    let mut r=rig();app_db::with(&r.state.app_dir,|c|app_db::locations::save_meta(c,"external-backup","/display-only","macos",1,false)).unwrap();
    let ack=manual(&r.state,"one","pending").await;
    wait(&r.state,|s|s["pendingAccess"].as_array().is_some_and(|a|!a.is_empty())).await;
    assert!(r.calls.try_recv().is_err());assert_eq!(settings(&r.state)["language"],"lt");
    rpc(&r.state,"backup.cancel",json!({"runId":ack["runId"]})).await;
    wait(&r.state,|s|s["requests"]["pending"]["status"]=="cancelled").await;
    app_db::with(&r.state.app_dir,|c|{c.execute_batch("DROP TABLE external_locations").map_err(|e|e.to_string())}).unwrap();
    manual(&r.state,"two","unknown").await;
    wait(&r.state,|s|s["pendingAccess"].as_array().is_some_and(|a|!a.is_empty())).await;
    assert!(r.calls.try_recv().is_err());finish(r).await;
}
#[tokio::test]
async fn backup_worker_early_error_is_failed_once_with_real_bus_and_settings() {
    let mut r=rig();let mut events=r.state.events.subscribe();manual(&r.state,"one","failed").await;let c=call(&mut r).await;
    c.reply.send(Err("early provider failure".into())).ok().unwrap();
    let s=wait(&r.state,|s|s["requests"]["failed"]["status"]=="failed").await;
    assert_eq!(settings(&r.state)["backupState"]["one"]["lastBackupTime"],NOW);
    assert_eq!(settings(&r.state)["backupHistory"]["one"].as_array().unwrap().len(),1);
    let run=s["requests"]["failed"]["runId"].clone();let mut terminal=0;let mut settings_changed=0;
    while let Ok(e)=events.try_recv(){let (name,payload)=mailvault_core::daemon_ipc::parse_event(&e).unwrap();if name=="backup-progress" && payload["active"]==false {assert_eq!(payload["runId"],run);terminal+=1;} if name==crate::handlers::settings::CHANGED_EVENT{settings_changed+=1;}}
    assert_eq!(terminal,1);assert_eq!(settings_changed,1);finish(r).await;
}
#[tokio::test]
async fn backup_worker_panic_retains_actual_claim_as_uncertain() {
    let mut r=rig();manual(&r.state,"one","panic").await;let c=call(&mut r).await;
    drop(c.reply); // The controlled provider's await panics, like JoinError.
    let s=wait(&r.state,|s|s["active"]["stage"]=="uncertain").await;
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));
    assert!(s["requests"]["panic"]["status"]!="success");
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());finish(r).await;
}

#[tokio::test]
async fn backup_worker_success_degraded_and_history_consume_isolated_oracle() {
    let corpus:Value=serde_json::from_str(include_str!("../../src-core/tests/fixtures/backup-schedule-isolated-UTC.json")).unwrap();
    for name in ["success","degraded"] {
        let expected=corpus["cases"].as_array().unwrap().iter().find(|c|c["category"]=="coordinator" && c["name"]==name).unwrap();
        let mut r=rig();patch(&r.state,json!({"backupState":{"one":{"lastError":"stale previous failure"}}}));manual(&r.state,"one",name).await;let c=call(&mut r).await;
        let input=&expected["input"];let mut out=result(7);out.duration_secs=0.0;out.errors=input["errors"].as_u64().unwrap_or(0) as usize;
        out.error_message=input["last_error"].as_str().map(str::to_string);out.external_copy_ok=input["external_copy_ok"]!=false;
        out.external_copy_error=input["external_copy_error"].as_str().map(str::to_string);out.external_copy_failed_count=input["external_copy_failed_count"].as_u64().unwrap_or(0) as usize;
        c.reply.send(Ok(out)).ok().unwrap();wait(&r.state,|s|s["requests"][name]["status"]=="success").await;
        let mut observed=settings(&r.state)["backupState"]["one"].clone();observed.as_object_mut().unwrap().remove("lastSchedulerRunId");
        // A targeted RFC merge patch clears lastError by removing its key.
        // Both absence and explicit null represent no error to consumers.
        if observed.get("lastError").is_none(){observed["lastError"]=Value::Null;}
        assert_eq!(observed,expected["output"]["backupState"]["one"]);
        assert_history(&settings(&r.state)["backupHistory"]["one"],&expected["output"]["history"]["one"]);finish(r).await;
    }
    let mut r=rig();
    for n in 0..7 {r.state.clock.set(NOW+n*1000);let request=format!("history-{n}");manual(&r.state,"one",&request).await;let c=call(&mut r).await;let mut out=result(7);out.duration_secs=0.0;c.reply.send(Ok(out)).ok().unwrap();wait(&r.state,|s|s["requests"][&request]["status"]=="success").await;}
    let expected=corpus["cases"].as_array().unwrap().iter().find(|c|c["name"]=="history-newest-five-cumulative").unwrap();
    assert_history(&settings(&r.state)["backupHistory"]["one"],&expected["output"]["history"]["one"]);
    assert_eq!(settings(&r.state)["backupState"]["one"]["emailsBackedUp"],49);finish(r).await;
}
#[tokio::test]
async fn backup_worker_credentials_failure_history_never_advances_last_time() {
    let mut r=rig_with_resolve(Arc::new(|_,_,_|Box::pin(async {Err("capture credentials unavailable".into())})));
    manual(&r.state,"one","credentials").await;
    wait(&r.state,|s|s["requests"]["credentials"]["status"]=="failed_credentials").await;
    assert!(r.calls.try_recv().is_err());
    assert!(settings(&r.state)["backupState"]["one"]["lastBackupTime"].is_null());
    let corpus:Value=serde_json::from_str(include_str!("../../src-core/tests/fixtures/backup-schedule-isolated-UTC.json")).unwrap();
    let expected=corpus["cases"].as_array().unwrap().iter().find(|c|c["name"]=="credentials-failure").unwrap();
    assert_history(&settings(&r.state)["backupHistory"]["one"],&expected["output"]["history"]["one"]);finish(r).await;
}
#[tokio::test]
async fn backup_worker_retains_outcome_on_settings_failure_then_applies_once() {
    let mut r=rig();manual(&r.state,"one","durable").await;let c=call(&mut r).await;
    let path=r.state.app_dir.join("frontend-settings.json");let saved=r.state.app_dir.join("saved-settings");
    std::fs::rename(&path,&saved).unwrap();std::fs::create_dir(&path).unwrap();
    c.reply.send(Ok(result(7))).ok().unwrap();
    wait(&r.state,|s|s["lastOutcomes"].as_array().is_some_and(|a|a.len()==1 && a[0]["applied"]==false)).await;
    assert!(!read_ledger(&r.state.app_dir).unwrap().outcomes[0].applied);
    std::fs::remove_dir(&path).unwrap();std::fs::rename(saved,&path).unwrap();
    r.state.backup_worker.tx.get().unwrap().send(Cmd::Wake).unwrap();
    wait(&r.state,|s|s["requests"]["durable"]["status"]=="success" && s["lastOutcomes"][0]["applied"]==true).await;
    assert_eq!(settings(&r.state)["backupState"]["one"]["emailsBackedUp"],7);assert_eq!(settings(&r.state)["language"],"lt");
    assert_eq!(settings(&r.state)["backupHistory"]["one"].as_array().unwrap().len(),1);finish(r).await;
}
#[tokio::test]
async fn backup_worker_settings_marker_replays_after_metadata_ack_failure() {
    let mut r=rig();manual(&r.state,"one","metadata-ack").await;let c=call(&mut r).await;
    app_db::with(&r.state.app_dir,|conn| conn.execute_batch(r#"CREATE TRIGGER fail_backup_ack BEFORE INSERT ON meta WHEN NEW.key='backup.scheduler.v1' AND instr(NEW.value, '"applied":true')>0 BEGIN SELECT RAISE(FAIL,'injected metadata ACK failure'); END;"#).map_err(|e|e.to_string())).unwrap();
    c.reply.send(Ok(result(7))).ok().unwrap();
    tokio::time::timeout(Duration::from_secs(3),async {while settings(&r.state)["backupState"]["one"]["emailsBackedUp"]!=7 {tokio::task::yield_now().await;}}).await.unwrap();
    assert!(!read_ledger(&r.state.app_dir).unwrap().outcomes[0].applied);
    app_db::with(&r.state.app_dir,|conn|conn.execute_batch("DROP TRIGGER fail_backup_ack").map_err(|e|e.to_string())).unwrap();
    r.state.backup_worker.tx.get().unwrap().send(Cmd::Wake).unwrap();
    wait(&r.state,|s|s["lastOutcomes"][0]["applied"]==true).await;
    assert_eq!(settings(&r.state)["backupHistory"]["one"].as_array().unwrap().len(),1);
    assert_eq!(settings(&r.state)["backupState"]["one"]["emailsBackedUp"],7);finish(r).await;
}

fn automatic(state:&Arc<DaemonState>,paused:bool) {
    state.backup_worker.tx.get().unwrap().send(Cmd::Facts(Facts{automatic:true,paused,loading:false,last_activity:NOW-180_000})).unwrap();
}
fn wake(state:&Arc<DaemonState>) {state.backup_worker.tx.get().unwrap().send(Cmd::Wake).unwrap();}
fn enabled(state:&Arc<DaemonState>) {patch(state,json!({"billingProfile":{"hasSubscription":true,"status":"active"},"backupGlobalEnabled":true,"backupGlobalConfig":{"interval":"daily"},"hiddenAccounts":{"two":true}}));}
#[tokio::test]
async fn backup_worker_automatic_owner_is_inactive_in_production_stage() {
    let mut r=rig();enabled(&r.state);wake(&r.state);tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(r.calls.try_recv().is_err());assert_eq!(r.state.backup_worker.status()["automaticOwner"],"javascript");finish(r).await;
}
#[tokio::test]
async fn backup_worker_retry_ladder_consumes_isolated_trace_without_early_history() {
    let mut r=rig();enabled(&r.state);automatic(&r.state,false);
    let corpus:Value=serde_json::from_str(include_str!("../../src-core/tests/fixtures/backup-schedule-isolated-UTC.json")).unwrap();
    let expected=corpus["cases"].as_array().unwrap().iter().find(|c|c["name"]=="retry-exhaustion").unwrap();
    for (attempt,time) in [NOW,NOW+30_000,NOW+150_000,NOW+450_000].into_iter().enumerate() {
        if attempt>0 {r.state.clock.set(time-1);wake(&r.state);tokio::time::sleep(Duration::from_millis(20)).await;assert!(r.calls.try_recv().is_err());r.state.clock.set(time);wake(&r.state);}
        let c=call(&mut r).await;assert_eq!(c.ctx.mailbox_concurrency,3);assert_eq!(r.state.clock.now_ms(),time);
        c.reply.send(Err("retry failure".into())).ok().unwrap();
        if attempt<3 {wait(&r.state,|s|s["active"].is_null() && s["queue"][0]["retries"]==attempt+1).await;assert!(settings(&r.state)["backupHistory"]["one"].is_null());}
    }
    wait(&r.state,|s|s["lastOutcomes"].as_array().is_some_and(|a|!a.is_empty() && a[0]["applied"]==true)).await;
    assert_history(&settings(&r.state)["backupHistory"]["one"],&expected["output"][3]["history"]["one"]);finish(r).await;
}
#[tokio::test]
async fn backup_worker_manual_join_suppresses_retry_and_preserves_pause() {
    let mut r=rig();enabled(&r.state);automatic(&r.state,false);let c=call(&mut r).await;automatic(&r.state,true);
    let one=manual(&r.state,"one","joined-auto").await;let again=manual(&r.state,"one","replay").await;assert_eq!(one["runId"],again["runId"]);
    c.reply.send(Err("manual joined failure".into())).ok().unwrap();wait(&r.state,|s|s["requests"]["joined-auto"]["status"]=="failed").await;
    r.state.clock.set(NOW+60_000);wake(&r.state);tokio::time::sleep(Duration::from_millis(30)).await;assert!(r.calls.try_recv().is_err());finish(r).await;
}
#[tokio::test]
async fn backup_worker_progress_prevents_stall_and_stall_cancel_waits_for_join() {
    let mut r=rig();manual(&r.state,"one","stall").await;let c=call(&mut r).await;
    r.state.clock.set(NOW+STALL_MS-1);let mut f=frame(&c.ctx);f.active=true;(c.ctx.on_progress)(f);
    r.state.clock.set(NOW+STALL_MS+1);wake(&r.state);tokio::time::sleep(Duration::from_millis(20)).await;assert!(!c.ctx.cancel.load(SeqCst));
    r.state.clock.set(NOW+2*STALL_MS);wake(&r.state);wait(&r.state,|s|s["active"]["stage"]=="stopping_stall").await;assert!(c.ctx.cancel.load(SeqCst));
    assert!(r.state.backup_runs.lock().unwrap().contains_key("one"));assert!(settings(&r.state)["backupHistory"]["one"].is_null());
    let mut out=result(0);out.cancelled=true;c.reply.send(Ok(out)).ok().unwrap();wait(&r.state,|s|s["requests"]["stall"]["status"]=="failed").await;finish(r).await;
}
#[tokio::test]
async fn backup_worker_unreadable_accounts_are_pending_and_removed_account_is_distinct() {
    let mut r=rig();let guard=adapter::claim_run(&r.state,"one").unwrap();manual(&r.state,"one","accounts").await;
    wait(&r.state,|s|s["queue"][0]["stage"]=="pending_claim").await;
    std::fs::write(r.state.app_dir.join("accounts.json"),"broken").unwrap();drop(guard);wake(&r.state);
    wait(&r.state,|s|s["queue"][0]["stage"]=="pending_accounts").await;assert!(r.calls.try_recv().is_err());
    std::fs::write(r.state.app_dir.join("accounts.json"),r#"[{"id":"two"}]"#).unwrap();wake(&r.state);
    wait(&r.state,|s|s["requests"]["accounts"]["status"]=="missing_account").await;assert!(settings(&r.state)["backupHistory"]["one"].is_null());finish(r).await;
}

#[tokio::test]
async fn backup_worker_stale_progress_and_cancel_cannot_change_new_execution() {
    let mut r=rig();let ack=manual(&r.state,"one","old").await;let old=call(&mut r).await;
    let old_progress=old.ctx.on_progress.clone();let old_frame=frame(&old.ctx);old.reply.send(Ok(result(1))).ok().unwrap();
    wait(&r.state,|s|s["requests"]["old"]["status"]=="success").await;
    manual(&r.state,"one","new").await;let new=call(&mut r).await;
    rpc(&r.state,"backup.cancel",json!({"runId":ack["runId"]})).await;assert!(!new.ctx.cancel.load(SeqCst));
    r.state.clock.set(NOW+STALL_MS-1);old_progress(old_frame);
    r.state.clock.set(NOW+STALL_MS+1);wake(&r.state);
    wait(&r.state,|s|s["active"]["stage"]=="stopping_stall").await;
    let mut out=result(0);out.cancelled=true;new.reply.send(Ok(out)).ok().unwrap();wait(&r.state,|s|s["requests"]["new"]["status"]=="failed").await;finish(r).await;
}
#[tokio::test]
async fn backup_worker_stop_fences_a_delayed_automatic_scan() {
    let mut r=rig();enabled(&r.state);automatic(&r.state,true);
    rpc(&r.state,"backup.stop",json!({})).await;
    // An earlier read of settings may return after Stop. It cannot re-enable
    // the scheduler or become fresh intent just by being delivered late.
    r.state.backup_worker.tx.get().unwrap().send(Cmd::Due{epoch:0,ids:vec!["one".into()]}).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(r.state.backup_worker.status()["queue"].as_array().unwrap().is_empty(),"late automatic scan recreated stopped intent");
    assert!(r.calls.try_recv().is_err());finish(r).await;
}
#[tokio::test]
async fn backup_worker_limit_cap_change_rechecks_current_entitlement() {
    let mut r=rig();enabled(&r.state);patch(&r.state,json!({"transferLimits":{"one":{"capEnabled":true,"dailyDownLimitBytes":1024}}}));
    manual(&r.state,"one","limit-cap").await;let c=call(&mut r).await;
    let mut terminal=frame(&c.ctx);terminal.cancelled=true;terminal.stop_reason=Some("limit_reached");terminal.limit_bytes=Some(1024);terminal.resume_after_ms=Some((NOW+10_000) as u64);terminal.completed_folders=4;(c.ctx.on_progress)(terminal);
    let mut out=result(0);out.success=false;out.cancelled=true;c.reply.send(Ok(out)).ok().unwrap();
    wait(&r.state,|s|s["requests"]["limit-cap"]["status"]=="limit_reached").await;
    patch(&r.state,json!({"billingProfile":{"hasSubscription":false,"status":"inactive"},"transferLimits":{"one":{"warningEnabled":false}}}));automatic(&r.state,false);
    wait(&r.state,|s|s["active"].is_null() && s["queue"][0]["stage"]=="pending_policy").await;assert!(r.calls.try_recv().is_err());
    patch(&r.state,json!({"billingProfile":{"hasSubscription":true,"status":"active"}}));wake(&r.state);
    tokio::time::sleep(Duration::from_millis(40)).await;assert!(r.calls.try_recv().is_err(),"entitlement recheck erased the midnight hold");
    patch(&r.state,json!({"transferLimits":{"one":{"capEnabled":false}}}));wake(&r.state);
    let c=call(&mut r).await;assert_eq!(c.ctx.skip_folders,0,"ordinal without known folder order became skip authority");
    c.reply.send(Ok(result(7))).ok().unwrap();wait(&r.state,|s|s["active"].is_null() && s["lastOutcomes"].as_array().is_some_and(|a|a.len()>=2)).await;finish(r).await;
}
#[tokio::test]
async fn backup_worker_removed_during_credentials_is_not_failed_credentials() {
    let (release,rx)=oneshot::channel();let rx=Arc::new(Mutex::new(Some(rx)));let (entered,mut entered_rx)=unbounded_channel();
    let r=rig_with_resolve(Arc::new(move |_,_,_|{let rx=rx.lock().unwrap().take().unwrap();let entered=entered.clone();Box::pin(async move {entered.send(()).unwrap();rx.await.unwrap();Err("credentials no longer present".into())})}));
    manual(&r.state,"one","removed").await;entered_rx.recv().await.unwrap();
    std::fs::write(r.state.app_dir.join("accounts.json"),r#"[{"id":"two"}]"#).unwrap();release.send(()).unwrap();
    wait(&r.state,|s|s["requests"]["removed"]["status"]=="missing_account").await;
    assert!(settings(&r.state)["backupHistory"]["one"].is_null());finish(r).await;
}

#[tokio::test]
async fn backup_worker_reopening_active_state_changes_execution_and_uses_zero_checkpoint() {
    let mut r=rig();let original=manual(&r.state,"one","reopened").await;let c=call(&mut r).await;
    let mut persisted=read_ledger(&r.state.app_dir).unwrap();persisted.active.as_mut().unwrap().checkpoint=4;
    let mut cancelled=result(0);cancelled.cancelled=true;c.reply.send(Ok(cancelled)).ok().unwrap();
    wait(&r.state,|s|s["requests"]["reopened"]["status"]=="cancelled").await;
    r.state.backup_worker.tx.get().unwrap().send(Cmd::Shutdown).unwrap();r.worker.await.unwrap();
    // This is state reopening after the first task actually drained. It is
    // not a process-kill/power-loss experiment and never overlaps that task.
    save_ledger(&r.state.app_dir,&persisted).unwrap();
    std::fs::write(r.state.app_dir.join("accounts.json"),r#"[{"id":"one","mailboxes":["Renamed","INBOX"]}]"#).unwrap();
    let state=DaemonState::for_test(r.state.data_dir.clone(),r.state.app_dir.clone(),true);state.clock.set(NOW+1);
    let (calls_tx,mut calls)=unbounded_channel();let (tx,rx)=unbounded_channel();state.backup_worker.tx.set(tx).ok().unwrap();
    let services=Services{resolve:Arc::new(|_,_,_|Box::pin(async {Ok(serde_json::from_value(json!({"email":"one@test","imapHost":"127.0.0.1","imapPort":1})).unwrap())})),provider:Arc::new(move |ctx|{let tx=calls_tx.clone();Box::pin(async move{let(reply,rx)=oneshot::channel();tx.send(Call{ctx,reply}).unwrap();rx.await.unwrap()})})};
    let worker=tokio::spawn(worker_loop(state.clone(),rx,services));
    let resumed=tokio::time::timeout(Duration::from_secs(2),calls.recv()).await.unwrap().unwrap();assert_eq!(resumed.ctx.skip_folders,0);
    let live=state.backup_worker.status();assert_ne!(live["active"]["executionId"],original["executionId"]);
    let replay=manual(&state,"one","reopened").await;assert_eq!(replay["runId"],original["runId"]);assert_eq!(replay["executionId"],live["active"]["executionId"]);
    resumed.reply.send(Ok(result(7))).ok().unwrap();wait(&state,|s|s["requests"]["reopened"]["status"]=="success").await;
    assert_eq!(settings(&state)["backupHistory"]["one"].as_array().unwrap().len(),1);
    state.backup_worker.tx.get().unwrap().send(Cmd::Shutdown).unwrap();worker.await.unwrap();
}
