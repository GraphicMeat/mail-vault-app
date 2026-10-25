//! Native account-backup lifecycle. Production automatic admission remains
//! disabled while JavaScript owns the surface/context coordinator.
use crate::{handlers::{backup as adapter, common}, ipc::{self, RpcResponse}, server::DaemonState};
use mailvault_core::{app_db::{self, db}, backup_schedule as policy, settings_doc::{SettingsDoc, SettingsError}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap}, future::Future, path::Path, pin::Pin, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::SeqCst}}, time::Duration};
use tokio::sync::{mpsc::{unbounded_channel, UnboundedSender, UnboundedReceiver}, oneshot};
use rusqlite::OptionalExtension;

const META: &str = "backup.scheduler.v1";
const STORE: &str = "mailvault-settings";
const EVENT: &str = "backup-schedule-changed";
const STALL_MS: i64 = 900_000;

#[derive(Default)]
pub(crate) struct BackupState {
    tx: OnceLock<UnboundedSender<Cmd>>,
    view: Mutex<Value>,
    controls: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // Kept outside the provider task. A provider panic cannot prove its nested
    // blocking work drained; retain real admission until process termination.
    uncertain: Mutex<Vec<adapter::BackupRunGuard>>,
    epoch: AtomicU64,
    progress: AtomicI64,
    execution: Mutex<Option<String>>,
    facts: Mutex<Facts>,
}
impl BackupState {
    pub(crate) fn retain_uncertain(&self, guard: adapter::BackupRunGuard) {self.uncertain.lock().unwrap_or_else(|p|p.into_inner()).push(guard);}
    fn note_progress(&self, now:i64) {self.progress.store(now,SeqCst);}
    pub(crate) fn observe_execution(&self, execution:&str, now:i64)->bool {
        if self.execution.lock().unwrap_or_else(|p|p.into_inner()).as_deref()!=Some(execution) {return false;}
        self.note_progress(now);true
    }
    pub(crate) fn owns_token(&self, token: &Arc<AtomicBool>) -> bool {
        self.controls.lock().unwrap_or_else(|p| p.into_inner()).values().any(|t| Arc::ptr_eq(t, token))
    }
    pub(crate) fn status(&self) -> Value {
        let mut view = self.view.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(run) = view["active"]["runId"].as_str() {
            let stopping = self.controls.lock().unwrap_or_else(|p|p.into_inner()).get(run).is_some_and(|t|t.load(SeqCst));
            if stopping && !matches!(view["active"]["stage"].as_str(), Some("uncertain"|"stopping_stall")) { view["active"]["stage"]=json!("stopping"); }
        }
        if view.is_null() { json!({"revision":0,"queue":[],"active":null,"pendingAccess":[],"lastOutcomes":[],"automaticOwner":"javascript","ready":false}) } else { view }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Intent {
    account_id: String,
    run_id: String,
    execution_id: String,
    manual: bool,
    requests: Vec<String>,
    stage: String,
    retries: usize,
    not_before: i64,
    checkpoint: usize,
    #[serde(default)] cap: Value,
    last_progress: i64,
    #[serde(default)] cancel_requested: bool,
    epoch: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Outcome {
    intent: Intent,
    status: String,
    at: i64,
    result: Option<Value>,
    terminal: Option<Value>,
    error: Option<String>,
    applied: bool,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Ledger {
    #[serde(default)] epoch: u64,
    revision: u64,
    queue: Vec<Intent>,
    active: Option<Intent>,
    outcomes: Vec<Outcome>,
    requests: BTreeMap<String, Value>,
}
impl Ledger {
    fn view(&self) -> Value {
        json!({"revision":self.revision,"queue":self.queue,"active":self.active,
            "pendingAccess":self.queue.iter().filter(|i| i.stage == "pending_access").collect::<Vec<_>>(),
            "lastOutcomes":self.outcomes,"requests":self.requests,"automaticOwner":"javascript","ready":true})
    }
}
#[derive(Default, Clone)]
struct Facts { automatic: bool, paused: bool, loading: bool, last_activity: i64 }
enum Cmd {
    #[cfg(test)]
    Facts(Facts),
    Manual { account: String, request: String, reply: oneshot::Sender<Result<Value,String>> },
    Wake,
    Cancel {run:String,reply:oneshot::Sender<Result<Value,String>>},
    Stop {reply:oneshot::Sender<Result<Value,String>>},
    Running { run: String, execution: String, cap: Value },
    Finished { run: String, execution: String, exit: RunExit },
    Due(Vec<String>),
    #[cfg(test)]
    Shutdown,
}
type Resolve = Arc<dyn Fn(Arc<DaemonState>, String, bool) -> Pin<Box<dyn Future<Output=Result<mailvault_core::imap::ImapConfig,String>> + Send>> + Send + Sync>;
#[derive(Clone)]
struct Services { resolve: Resolve, provider: adapter::Provider }
enum RunExit { Pending(String), Completed(adapter::JoinedBackup), Credentials(String), Missing }
impl Default for Services {
    fn default() -> Self {
        Self { resolve: Arc::new(|state,id,manual| Box::pin(async move {
            crate::oauth_tokens::resolve(&state, &id, if manual { crate::oauth_tokens::Read::Guarded } else { crate::oauth_tokens::Read::Quiet }).await
        })), provider: adapter::provider() }
    }
}
fn read_ledger(path: &Path) -> Result<Ledger,String> {
    app_db::with(path, |conn| {
        let raw: Option<String> = conn.query_row("SELECT value FROM meta WHERE key=?1", [META], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        raw.map(|s| serde_json::from_str(&s).map_err(|_| "errors.settingsInvalid".into())).unwrap_or_else(|| Ok(Ledger::default()))
    })
}
fn save_ledger(path: &Path, ledger: &Ledger) -> Result<(),String> {
    let bytes = serde_json::to_string(ledger).map_err(|e| e.to_string())?;
    app_db::with(path, |conn| db::in_txn(conn, || db::meta_set(conn, META, &bytes)))
}
async fn publish(state: &Arc<DaemonState>, ledger: &mut Ledger) -> Result<(),String> {
    ledger.epoch=state.backup_worker.epoch.load(SeqCst);
    ledger.revision = ledger.revision.saturating_add(1);
    let path=state.app_dir.clone(); let copy=ledger.clone();
    common::blocking(move || save_ledger(&path,&copy)).await??;
    let view=ledger.view();
    *state.backup_worker.view.lock().unwrap_or_else(|p| p.into_inner())=view.clone();
    state.events.emit(EVENT,view);
    Ok(())
}
fn response(intent: &Intent) -> Value {
    json!({"runId":intent.run_id,"executionId":intent.execution_id,"accountId":intent.account_id,"status":intent.stage})
}
pub(crate) fn start(state: Arc<DaemonState>) {
    let (tx,rx)=unbounded_channel();
    if state.backup_worker.tx.set(tx).is_err() { return; }
    let spawned=std::thread::Builder::new().name("backup-worker".into()).stack_size(8*1024*1024).spawn(move || {
        #[cfg(target_os="macos")]
        unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND,0); }
        if let Ok(rt)=tokio::runtime::Builder::new_current_thread().enable_all().build() {
            rt.block_on(tokio::task::LocalSet::new().run_until(worker_loop(state,rx,Services::default())));
        }
    });
    if spawned.is_err() { tracing::warn!("backup worker did not start"); }
}
async fn worker_loop(state: Arc<DaemonState>, mut rx: UnboundedReceiver<Cmd>, services: Services) {
    let path=state.app_dir.clone();
    let mut ledger=match common::blocking(move || read_ledger(&path)).await {
        Ok(Ok(l))=>l, _=> { *state.backup_worker.view.lock().unwrap()=json!({"ready":false,"error":"errors.settingsNotLoaded"}); return; }
    };
    state.backup_worker.epoch.store(ledger.epoch,SeqCst);
    // A fresh daemon has no surviving in-process execution. An ordinal alone
    // does not prove folder ordering; restart always resumes incrementally at 0.
    if let Some(mut interrupted)=ledger.active.take() {
        interrupted.execution_id=uuid::Uuid::new_v4().to_string(); interrupted.checkpoint=0;
        if interrupted.cancel_requested {
            let out=Outcome{intent:interrupted,status:"cancelled".into(),at:state.clock.now_ms(),result:None,terminal:None,error:None,applied:true};
            settle_requests(&mut ledger.requests,&out);ledger.outcomes.push(out);
        } else {interrupted.stage="queued".into(); ledger.queue.insert(0,interrupted);}
        if publish(&state,&mut ledger).await.is_err() { return; }
    }
    for intent in &ledger.queue { state.backup_worker.controls.lock().unwrap().insert(intent.run_id.clone(),Arc::new(AtomicBool::new(false))); }
    *state.backup_worker.view.lock().unwrap()=ledger.view();
    let mut tick=tokio::time::interval(Duration::from_secs(60)); tick.tick().await;
    let mut pending_finish=None;
    let _=state.backup_worker.tx.get().unwrap().send(Cmd::Wake);
    loop {
        let (cmd,scan)=tokio::select! { cmd=rx.recv()=>match cmd {Some(cmd)=>(cmd,false),None=>return}, _=tick.tick()=>(Cmd::Wake,true) };
        let mut scan=scan;
        match cmd {
            Cmd::Manual{account,request,reply}=> {
                let result=admit(&state,&mut ledger,account,request).await;
                let _=reply.send(result); scan=true;
            }
            Cmd::Wake=>scan=true,
            Cmd::Cancel{run,reply}=>{
                let mut next=ledger.clone();
                if let Some(i)=next.active.as_mut().filter(|i|i.run_id==run) {i.cancel_requested=true;if i.stage!="uncertain"{i.stage="stopping".into();}}
                let result=async {settle_cancelled(&state,&mut next).await?;publish(&state,&mut next).await?;Ok(json!({"accepted":true}))}.await;
                if result.is_ok(){ledger=next;}let _=reply.send(result);scan=true;
            }
            Cmd::Stop{reply}=>{
                let mut next=ledger.clone();
                if let Some(i)=next.active.as_mut(){i.cancel_requested=true;if i.stage!="uncertain"{i.stage="stopping".into();}}
                let result=async {settle_cancelled(&state,&mut next).await?;publish(&state,&mut next).await?;Ok(json!({"accepted":true}))}.await;
                if result.is_ok(){ledger=next;}let _=reply.send(result);scan=true;
            }
            #[cfg(test)] Cmd::Facts(facts)=> { *state.backup_worker.facts.lock().unwrap()=facts;scan=true; }
            Cmd::Running{run,execution,cap}=> {
                if let Some(i)=ledger.active.as_mut().filter(|i|i.run_id==run && i.execution_id==execution) {i.stage="running".into();i.cap=cap;let _=publish(&state,&mut ledger).await;}
            }
            Cmd::Finished{run,execution,exit}=>{
                // A real joined run may free work that was waiting behind it.
                // A pending probe must not immediately probe itself forever.
                if !matches!(exit,RunExit::Pending(_)){scan=true;}
                pending_finish=Some((run,execution,exit));
            },
            Cmd::Due(ids)=> {
                for id in ids {
                    if ledger.active.iter().chain(ledger.queue.iter()).any(|i|i.account_id==id) {continue;}
                    let mut intent=new_intent(&state,id,false);intent.stage="queued".into();
                    state.backup_worker.controls.lock().unwrap().insert(intent.run_id.clone(),Arc::new(AtomicBool::new(false)));
                    ledger.queue.push(intent);
                }
                let _=publish(&state,&mut ledger).await;
            }
            #[cfg(test)] Cmd::Shutdown=>return,
        }
        if let Some((run,execution,exit))=pending_finish.take() {
            match finish_run(&state,&ledger,&run,&execution,&exit).await {
                Ok(next)=>ledger=next,
                Err(_)=>pending_finish=Some((run,execution,exit)),
            }
        }
        if pending_finish.is_some() {continue;}
        if settle_cancelled(&state,&mut ledger).await.is_err() {continue;}
        if apply_retained(&state,&mut ledger).await.is_err() {continue;}
        if scan {
            check_stall(&state,&mut ledger).await;
            scan_automatic(&state);
        }
        pump(&state,&mut ledger,&services,scan).await;
    }
}
fn new_intent(state:&Arc<DaemonState>,account:String,manual:bool)->Intent {
    Intent {account_id:account,run_id:uuid::Uuid::new_v4().to_string(),execution_id:uuid::Uuid::new_v4().to_string(),manual,requests:Vec::new(),stage:"queued".into(),retries:0,not_before:0,checkpoint:0,cap:Value::Null,last_progress:state.clock.now_ms(),cancel_requested:false,epoch:state.backup_worker.epoch.load(SeqCst)}
}
fn cancelled(state:&Arc<DaemonState>, intent:&Intent)->bool {
    intent.cancel_requested || intent.epoch!=state.backup_worker.epoch.load(SeqCst) || state.backup_worker.controls.lock().unwrap().get(&intent.run_id).is_some_and(|t|t.load(SeqCst))
}
async fn settle_cancelled(state:&Arc<DaemonState>,ledger:&mut Ledger)->Result<(),String> {
    let mut next=ledger.clone();let mut changed=false;
    next.queue.retain(|intent| {
        if !cancelled(state,intent) {return true;}
        changed=true;
        let out=Outcome{intent:intent.clone(),status:"cancelled".into(),at:state.clock.now_ms(),result:None,terminal:None,error:None,applied:true};
        settle_requests(&mut next.requests,&out);next.outcomes.push(out);false
    });
    if changed {publish(state,&mut next).await?;*ledger=next;}
    Ok(())
}
fn settle_requests(requests:&mut BTreeMap<String,Value>,outcome:&Outcome) {
    for request in &outcome.intent.requests {
        let mut receipt=response(&outcome.intent);receipt["status"]=json!(outcome.status);
        receipt["result"]=json!(outcome.result);receipt["terminal"]=json!(outcome.terminal);receipt["message"]=json!(outcome.error);
        requests.insert(request.clone(),receipt);
    }
}
async fn check_stall(state:&Arc<DaemonState>,ledger:&mut Ledger) {
    if let Some(active)=ledger.active.as_mut() {
        if active.stage=="running" && state.clock.now_ms().saturating_sub(state.backup_worker.progress.load(SeqCst))>=STALL_MS {
            if let Some(token)=state.backup_worker.controls.lock().unwrap().get(&active.run_id) {token.store(true,SeqCst);}
            active.stage="stopping_stall".into();let _=publish(state,ledger).await;
        }
    }
}
fn loaded_settings(path:&Path)->Result<Value,String> {
    let s=SettingsDoc::shared(path).get(None).map_err(|e|e.catalog_key().to_string())?;
    if s.recovered.is_some() || !s.values[STORE]["state"].is_object() {return Err("errors.settingsNotLoaded".into());}
    Ok(s.values[STORE]["state"].clone())
}
fn scan_automatic(state:&Arc<DaemonState>) {
    let facts=state.backup_worker.facts.lock().unwrap().clone();
    if !facts.automatic || facts.paused || facts.loading || state.clock.now_ms().saturating_sub(facts.last_activity)<180_000 {return;}
    let state=state.clone();tokio::spawn(async move {
        let path=state.app_dir.clone();let now=state.clock.now_ms();
        let due=common::blocking(move || ->Result<Vec<String>,String> {
            let settings=loaded_settings(&path)?;
            let ids=crate::handlers::insights::configured_account_ids(&path)?;
            let zone=policy::local_zone().map_err(str::to_string)?;
            Ok(ids.into_iter().filter(|id|policy::scheduled(&settings,id,now) && policy::next_in_zone(&settings["backupState"][id],&policy::schedule_for(&settings,id),now,&zone).is_ok_and(|at|now>=at)).collect())
        }).await;
        if let Ok(Ok(ids))=due {let _=state.backup_worker.tx.get().unwrap().send(Cmd::Due(ids));}
    });
}
async fn pump(state:&Arc<DaemonState>,ledger:&mut Ledger,services:&Services,scan:bool) {
    if ledger.active.is_some() || ledger.outcomes.iter().any(|o|!o.applied) {return;}
    let facts=state.backup_worker.facts.lock().unwrap().clone();let now=state.clock.now_ms();
    let eligible=ledger.queue.iter().position(|i| {
        if !i.manual && (!facts.automatic || facts.paused || facts.loading || now.saturating_sub(facts.last_activity)<180_000) {return false;}
        if i.stage.starts_with("pending_") && !scan {return false;}
        i.not_before<=now || (i.stage=="limit" && scan)
    });
    let Some(index)=eligible else{return;};
    let mut next=ledger.clone();let mut intent=next.queue.remove(index);
    let driver_intent=intent.clone();intent.stage="preparing".into();intent.last_progress=now;next.active=Some(intent);
    if publish(state,&mut next).await.is_err() {return;}*ledger=next;
    state.backup_worker.note_progress(now);
    *state.backup_worker.execution.lock().unwrap()=Some(driver_intent.execution_id.clone());
    let st=state.clone();let services=services.clone();
    tokio::spawn(async move {
        let run=driver_intent.run_id.clone();let execution=driver_intent.execution_id.clone();
        let exit=run_intent(&st,&driver_intent,services).await;
        let _=st.backup_worker.tx.get().unwrap().send(Cmd::Finished{run,execution,exit});
    });
}
// Reads are fallible and off the control runtime. A failed slot query is not
// proof of absence, and accounts parse failure is not account removal.
async fn admission_facts(state:&Arc<DaemonState>)->Result<(Value,Vec<String>,bool),String> {
    let path=state.app_dir.clone();common::blocking(move || {
        let settings=loaded_settings(&path).map_err(|_|"pending_settings".to_string())?;
        let ids=crate::handlers::insights::configured_account_ids(&path).map_err(|_|"pending_accounts".to_string())?;
        let absent=app_db::with(&path,|conn|conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM external_locations WHERE slot='external-backup')",[],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())).unwrap_or(false);
        Ok((settings,ids,absent))
    }).await.map_err(|_|"pending_settings".to_string())?
}
async fn run_intent(state:&Arc<DaemonState>,intent:&Intent,services:Services)->RunExit {
    let (settings,ids,absent)=match admission_facts(state).await {Ok(f)=>f,Err(stage)=>return RunExit::Pending(stage)};
    if !ids.contains(&intent.account_id) {return RunExit::Missing;}
    if !absent {return RunExit::Pending("pending_access".into());}
    let now=state.clock.now_ms();
    if !intent.manual && !policy::scheduled(&settings,&intent.account_id,now) {return RunExit::Pending("pending_policy".into());}
    if intent.stage=="limit" && intent.not_before>now && !policy::download_cap_changed(&intent.cap,&settings["transferLimits"][&intent.account_id]) {return RunExit::Pending("limit".into());}
    let token=state.backup_worker.controls.lock().unwrap().get(&intent.run_id).cloned().unwrap();
    if cancelled(state,intent) {return RunExit::Completed(adapter::JoinedBackup{result:Some(json!({"cancelled":true})),..Default::default()});}
    let Some(guard)=adapter::claim_controlled(state,&intent.account_id,token.clone()) else {return RunExit::Pending("pending_claim".into());};
    let account=match (services.resolve)(state.clone(),intent.account_id.clone(),intent.manual).await {Ok(c)=>c,Err(e)=>return RunExit::Credentials(e)};
    let (fresh,ids,absent)=match admission_facts(state).await {Ok(f)=>f,Err(stage)=>return RunExit::Pending(stage)};
    if !ids.contains(&intent.account_id) {return RunExit::Missing;}
    if !absent {return RunExit::Pending("pending_access".into());}
    let facts=state.backup_worker.facts.lock().unwrap().clone();
    if !intent.manual && (!facts.automatic || facts.paused || facts.loading || state.clock.now_ms().saturating_sub(facts.last_activity)<180_000 || !policy::scheduled(&fresh,&intent.account_id,state.clock.now_ms())) {return RunExit::Pending("pending_policy".into());}
    if !intent.manual && intent.retries==0 && intent.stage=="queued" {
        let due=policy::local_zone().ok().and_then(|zone|policy::next_in_zone(&fresh["backupState"][&intent.account_id],&policy::schedule_for(&fresh,&intent.account_id),state.clock.now_ms(),&zone).ok()).is_some_and(|at|state.clock.now_ms()>=at);
        if !due{return RunExit::Pending("pending_policy".into());}
    }
    if cancelled(state,intent) {return RunExit::Completed(adapter::JoinedBackup{result:Some(json!({"cancelled":true})),..Default::default()});}
    crate::search_index::wait_foreground_quiet(&state.search_index).await;
    if cancelled(state,intent) {return RunExit::Completed(adapter::JoinedBackup{result:Some(json!({"cancelled":true})),..Default::default()});}
    let _=state.backup_worker.tx.get().unwrap().send(Cmd::Running{run:intent.run_id.clone(),execution:intent.execution_id.clone(),cap:fresh["transferLimits"][&intent.account_id].clone()});
    // No known server folder order is retained by these runners. An ordinal
    // checkpoint remains display/recovery evidence, never skip authority.
    RunExit::Completed(adapter::run_claimed(state.clone(),guard,intent.account_id.clone(),account,None,None,0,policy::mailbox_concurrency(&fresh,state.clock.now_ms()),Some((intent.run_id.clone(),intent.execution_id.clone())),services.provider).await)
}
async fn finish_run(state:&Arc<DaemonState>,ledger:&Ledger,run:&str,execution:&str,exit:&RunExit)->Result<Ledger,String> {
    let mut next=ledger.clone();let Some(mut intent)=next.active.take().filter(|i|i.run_id==run && i.execution_id==execution) else {return Ok(ledger.clone());};
    if let RunExit::Pending(stage)=exit {
        intent.stage=stage.clone();for request in &intent.requests {next.requests.insert(request.clone(),response(&intent));}next.queue.push(intent);
    } else {
        let at=state.clock.now_ms();
        let (status,result,terminal,error)=match exit {
            RunExit::Missing=>("missing_account",None,None,None),
            RunExit::Credentials(e)=>("failed_credentials",None,None,Some(e.clone())),
            RunExit::Completed(joined)=>{
                if joined.uncertain {
                    intent.stage="uncertain".into();next.active=Some(intent);publish(state,&mut next).await?;return Ok(next);
                }
                let value=joined.result.as_ref();let terminal=joined.terminal.as_ref();
                let limit=joined.error.is_none() && value.is_some() && terminal.is_some_and(|t|t["stop_reason"]=="limit_reached");
                let stalled=intent.stage=="stopping_stall";
                let status=if limit {"limit_reached"} else if stalled {"failed"} else if value.is_some_and(|v|v["cancelled"]==true) {"cancelled"} else if joined.error.is_none() && value.is_some_and(|v|v["success"]==true) {"success"} else {"failed"};
                (status,joined.result.clone(),joined.terminal.clone(),if stalled {Some("errors.backupStalled".into())} else {joined.error.clone().or_else(||value.and_then(|v|v["error_message"].as_str()).map(str::to_string))})
            }
            RunExit::Pending(_)=>unreachable!(),
        };
        if status=="failed" && !cancelled(state,&intent) || (status=="failed" && intent.stage=="stopping_stall") {
            if let Some(delay)=policy::retry_delay(intent.retries,intent.manual) {
                intent.retries+=1;intent.not_before=at.saturating_add(delay);intent.stage="retry".into();intent.execution_id=uuid::Uuid::new_v4().to_string();
                state.backup_worker.controls.lock().unwrap().insert(intent.run_id.clone(),Arc::new(AtomicBool::new(false)));
                next.queue.insert(0,intent);publish(state,&mut next).await?;return Ok(next);
            }
        }
        if status=="limit_reached" {
            let mut held=new_intent(state,intent.account_id.clone(),false);held.stage="limit".into();held.cap=intent.cap.clone();
            held.checkpoint=result.as_ref().and_then(|v|v["completed_folders"].as_u64()).unwrap_or(0) as usize;
            held.not_before=policy::limit_hold_until(at,terminal.as_ref().and_then(|v|v["resume_after_ms"].as_i64()));
            // Stop invalidates delayed intent even if the core was already
            // reporting the cap when the user stopped this execution.
            if intent.epoch==state.backup_worker.epoch.load(SeqCst) {state.backup_worker.controls.lock().unwrap().insert(held.run_id.clone(),Arc::new(AtomicBool::new(false)));next.queue.push(held);}
        }
        let outcome=Outcome{intent,status:status.into(),at,result,terminal,error,applied:false};next.outcomes.push(outcome);
    }
    publish(state,&mut next).await?;Ok(next)
}
async fn apply_retained(state:&Arc<DaemonState>,ledger:&mut Ledger)->Result<(),String> {
    for index in 0..ledger.outcomes.len() {
        if ledger.outcomes[index].applied {continue;}
        let path=state.app_dir.clone();let outcome=ledger.outcomes[index].clone();
        let change=common::blocking(move || apply_outcome(&path,&outcome)).await??;
        if let Some(change)=change.filter(|c|!c.changed.is_empty()) {state.events.emit(crate::handlers::settings::CHANGED_EVENT,json!({"keys":change.changed,"version":change.version}));}
        let mut next=ledger.clone();next.outcomes[index].applied=true;
        settle_requests(&mut next.requests,&next.outcomes[index]);
        publish(state,&mut next).await?;
        *state.backup_worker.execution.lock().unwrap()=None;
        state.backup_worker.controls.lock().unwrap().remove(&next.outcomes[index].intent.run_id);
        *ledger=next;
    }
    Ok(())
}
fn apply_outcome(path:&Path,out:&Outcome)->Result<Option<mailvault_core::settings_doc::Change>,String> {
    if matches!(out.status.as_str(),"cancelled"|"missing_account") {return Ok(None);}
    let doc=SettingsDoc::shared(path);
    for _ in 0..3 {
        let snapshot=doc.get(None).map_err(|e|e.catalog_key().to_string())?;
        if snapshot.recovered.is_some() || !snapshot.values[STORE]["state"].is_object() {return Err("errors.settingsNotLoaded".into());}
        let settings=&snapshot.values[STORE]["state"];let id=&out.intent.account_id;let old=&settings["backupState"][id];
        if old["lastSchedulerRunId"]==out.intent.run_id {return Ok(None);}
        let mut state=json!({"lastSchedulerRunId":out.intent.run_id});
        let mut patch=json!({});
        if out.status=="limit_reached" {state["lastStatus"]=json!("limit");state["lastError"]=Value::Null;}
        else {
            let fallback=json!({});let result=out.result.as_ref().unwrap_or(&fallback);
            let success=out.status=="success";let failed_credentials=out.status=="failed_credentials";
            let emails=if success {result["emails_backed_up"].as_u64().unwrap_or(0)} else {0};
            let external=result["external_copy_ok"]!=false;let errors=result["errors"].as_u64().unwrap_or(0);
            let error=out.error.clone().or_else(||result["error_message"].as_str().map(str::to_string));
            let mut history=settings["backupHistory"][id].as_array().cloned().unwrap_or_default();
            let mut entry=json!({"timestamp":out.at,"emailsBackedUp":emails,"durationSecs":if success {result["duration_secs"].as_f64().unwrap_or(0.0)} else {0.0},"success":success,"error":error});
            if success {entry["errors"]=json!(errors);entry["externalCopyOk"]=json!(external);entry["externalCopyError"]=result["external_copy_error"].clone();entry["externalCopyFailedCount"]=json!(result["external_copy_failed_count"].as_u64().unwrap_or(0));}
            history.insert(0,entry);history.truncate(5);patch["backupHistory"]=json!({id:history});
            state["lastStatus"]=json!(if success {if !external || errors>0 {"degraded"} else {"success"}} else {"failed"});
            state["lastError"]=json!(error.or_else(||if !external {result["external_copy_error"].as_str().map(str::to_string)} else {None}));
            if !failed_credentials {state["lastBackupTime"]=json!(out.at);}
            if success {state["emailsBackedUp"]=json!(old["emailsBackedUp"].as_u64().unwrap_or(0).saturating_add(emails));}
        }
        patch["backupState"]=json!({id:state});
        match doc.patch(&json!({STORE:{"state":patch}}),Some(snapshot.version)) {
            Ok(change)=>return Ok(Some(change)),Err(SettingsError::Conflict{..})=>continue,Err(e)=>return Err(e.catalog_key().into()),
        }
    }
    Err("errors.settingsConflict".into())
}
async fn admit(state:&Arc<DaemonState>, ledger:&mut Ledger, account:String, request:String)->Result<Value,String> {
    if let Some(receipt)=ledger.requests.get(&request) {
        return if receipt["accountId"] == account { Ok(receipt.clone()) } else { Err("errors.settingsInvalid".into()) };
    }
    let mut next=ledger.clone();
    if let Some(out)=next.outcomes.iter_mut().rev().find(|o|!o.applied && o.intent.account_id==account) {
        out.intent.requests.push(request.clone());let mut ack=response(&out.intent);ack["status"]=json!("applying");next.requests.insert(request,ack.clone());
        publish(state,&mut next).await?;*ledger=next;return Ok(ack);
    }
    let found=next.active.iter_mut().chain(next.queue.iter_mut()).find(|i| i.account_id==account);
    let intent=if let Some(i)=found { i.manual=true; i.requests.push(request.clone()); i.not_before=0; if i.stage!="running" && i.stage!="preparing" {i.stage="queued".into();} i.clone() } else {
        let mut i=new_intent(state,account.clone(),true);i.requests.push(request.clone());
        next.queue.insert(0,i.clone()); i
    };
    if let Some(index)=next.queue.iter().position(|i|i.run_id==intent.run_id) {let item=next.queue.remove(index);next.queue.insert(0,item);}
    let ack=response(&intent); next.requests.insert(request,ack.clone());
    publish(state,&mut next).await?; *ledger=next;
    state.backup_worker.controls.lock().unwrap().entry(intent.run_id).or_insert_with(|| Arc::new(AtomicBool::new(false)));
    Ok(ack)
}
pub(crate) async fn route(state:&Arc<DaemonState>, method:&str, params:&Value, id:Value)->Option<RpcResponse> {
    if !matches!(method,"backup.run_now"|"backup.cancel"|"backup.stop"|"backup.schedule.status") { return None; }
    let keys: &[&str]=match method { "backup.run_now"=> &["accountId","requestId"],"backup.cancel"=> &["runId"],_=> &[] };
    let valid=params.as_object().is_some_and(|p| p.len()==keys.len() && keys.iter().all(|k| p.get(*k).is_some_and(|v|v.as_str().is_some_and(|s| !s.is_empty() && s.len()<=256))));
    if !valid { return Some(RpcResponse::error(id,ipc::INVALID_PARAMS,"errors.settingsInvalid")); }
    start(state.clone());
    let result=match method {
        "backup.run_now"=> {
            let (tx,rx)=oneshot::channel();
            let sent=state.backup_worker.tx.get().unwrap().send(Cmd::Manual{account:params["accountId"].as_str().unwrap().into(),request:params["requestId"].as_str().unwrap().into(),reply:tx});
            if sent.is_err() { Err("errors.settingsNotLoaded".into()) } else { rx.await.unwrap_or_else(|_| Err("errors.settingsNotLoaded".into())) }
        }
        "backup.cancel"=> {
            let run=params["runId"].as_str().unwrap().to_string();
            if let Some(token)=state.backup_worker.controls.lock().unwrap().get(&run) {token.store(true,SeqCst);}
            let(tx,rx)=oneshot::channel();
            if state.backup_worker.tx.get().unwrap().send(Cmd::Cancel{run,reply:tx}).is_err(){Err("errors.settingsNotLoaded".into())}else{rx.await.unwrap_or_else(|_|Err("errors.settingsNotLoaded".into()))}
        }
        "backup.stop"=> {
            state.backup_worker.epoch.fetch_add(1,SeqCst);
            for token in state.backup_worker.controls.lock().unwrap().values(){token.store(true,SeqCst);}
            let(tx,rx)=oneshot::channel();
            if state.backup_worker.tx.get().unwrap().send(Cmd::Stop{reply:tx}).is_err(){Err("errors.settingsNotLoaded".into())}else{rx.await.unwrap_or_else(|_|Err("errors.settingsNotLoaded".into()))}
        }
        _=>Ok(state.backup_worker.status()),
    };
    Some(match result { Ok(v)=>RpcResponse::success(id,v),Err(e)=>RpcResponse::error(id,ipc::INTERNAL_ERROR,e) })
}

#[cfg(test)]
#[path="backup_worker_tests.rs"]
mod tests;
