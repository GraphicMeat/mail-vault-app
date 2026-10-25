use super::*;
use crate::server::handle_request_for_test;
use mailvault_core::backup::{BackupResult, BackupRunContext, BackupProgress};
const NOW:i64=1_792_929_600_000;
struct Call { ctx:BackupRunContext, reply:oneshot::Sender<Result<BackupResult,String>> }
struct Rig { _dir:tempfile::TempDir,state:Arc<DaemonState>,calls:UnboundedReceiver<Call>,worker:tokio::task::JoinHandle<()> }
fn settings(state:&Arc<DaemonState>)->Value { SettingsDoc::shared(&state.app_dir).get(None).unwrap().values[STORE]["state"].clone() }
fn patch(state:&Arc<DaemonState>, value:Value) { SettingsDoc::shared(&state.app_dir).patch(&json!({STORE:{"state":value}}),None).unwrap(); }
fn rig()->Rig {
    let dir=tempfile::tempdir().unwrap();
    let state=DaemonState::for_test(dir.path().join("mail"),dir.path().into(),true);
    state.clock.set(NOW);
    SettingsDoc::shared(&state.app_dir).replace(&json!({STORE:{"version":3,"state":{"language":"lt","backupState":{},"backupHistory":{}}}}),None).unwrap();
    std::fs::write(dir.path().join("accounts.json"),r#"[{"id":"one"},{"id":"two"}]"#).unwrap();
    let (call_tx,calls)=unbounded_channel();
    let services=Services {
        resolve:Arc::new(|_,id,_|Box::pin(async move {Ok(serde_json::from_value(json!({"email":format!("{id}@test"),"imapHost":"127.0.0.1","imapPort":1})).unwrap())})),
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
async fn call(rig:&mut Rig)->Call {tokio::time::timeout(Duration::from_secs(2),rig.calls.recv()).await.expect("admitted worker never invoked provider").unwrap()}
async fn wait(state:&Arc<DaemonState>, predicate:impl Fn(&Value)->bool)->Value {
    tokio::time::timeout(Duration::from_secs(3),async {loop {let s=state.backup_worker.status();if predicate(&s){return s;}tokio::task::yield_now().await;}}).await.expect("worker never published expected lifecycle state")
}
fn result(emails:usize)->BackupResult {BackupResult{emails_backed_up:emails,errors:0,duration_secs:2.0,success:true,error_message:None,cancelled:false,completed_folders:4,external_copy_ok:true,external_copy_error:None,external_copy_failed_count:0}}
fn frame(ctx:&BackupRunContext)->BackupProgress {adapter::failed_frame(&ctx.account_id,"fixture error".into())}
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
