//! Native account-backup lifecycle. Production automatic admission remains
//! disabled while JavaScript owns the surface/context coordinator.
use crate::{handlers::{backup as adapter, common}, ipc::{self, RpcResponse}, server::DaemonState};
use mailvault_core::{app_db::{self, db}, backup_schedule as policy, settings_doc::{SettingsDoc, SettingsError}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap}, future::Future, path::Path, pin::Pin, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering::SeqCst}}, time::Duration};
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
}
impl BackupState {
    pub(crate) fn owns_token(&self, token: &Arc<AtomicBool>) -> bool {
        self.controls.lock().unwrap_or_else(|p| p.into_inner()).values().any(|t| Arc::ptr_eq(t, token))
    }
    pub(crate) fn status(&self) -> Value {
        let view = self.view.lock().unwrap_or_else(|p| p.into_inner()).clone();
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
    last_progress: i64,
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
enum Cmd {
    Manual { account: String, request: String, reply: oneshot::Sender<Result<Value,String>> },
    Wake,
    Finished { run: String, execution: String, joined: adapter::JoinedBackup },
    #[cfg(test)]
    Shutdown,
}
type Resolve = Arc<dyn Fn(Arc<DaemonState>, String, bool) -> Pin<Box<dyn Future<Output=Result<mailvault_core::imap::ImapConfig,String>> + Send>> + Send + Sync>;
#[derive(Clone)]
struct Services { resolve: Resolve, provider: adapter::Provider }
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
async fn worker_loop(state: Arc<DaemonState>, mut rx: UnboundedReceiver<Cmd>, _services: Services) {
    let path=state.app_dir.clone();
    let mut ledger=match common::blocking(move || read_ledger(&path)).await {
        Ok(Ok(l))=>l, _=> { *state.backup_worker.view.lock().unwrap()=json!({"ready":false,"error":"errors.settingsNotLoaded"}); return; }
    };
    *state.backup_worker.view.lock().unwrap()=ledger.view();
    while let Some(cmd)=rx.recv().await {
        match cmd {
            Cmd::Manual{account,request,reply}=> {
                let result=admit(&state,&mut ledger,account,request).await;
                let _=reply.send(result);
            }
            Cmd::Wake=>{},
            Cmd::Finished{..}=>{},
            #[cfg(test)] Cmd::Shutdown=>return,
        }
    }
}
async fn admit(state:&Arc<DaemonState>, ledger:&mut Ledger, account:String, request:String)->Result<Value,String> {
    if let Some(receipt)=ledger.requests.get(&request) {
        return if receipt["accountId"] == account { Ok(receipt.clone()) } else { Err("errors.settingsInvalid".into()) };
    }
    let mut next=ledger.clone();
    let found=next.active.iter_mut().chain(next.queue.iter_mut()).find(|i| i.account_id==account);
    let intent=if let Some(i)=found { i.manual=true; i.requests.push(request.clone()); i.clone() } else {
        let i=Intent { account_id:account.clone(),run_id:uuid::Uuid::new_v4().to_string(),execution_id:uuid::Uuid::new_v4().to_string(),manual:true,requests:vec![request.clone()],stage:"queued".into(),retries:0,not_before:0,checkpoint:0,last_progress:state.clock.now_ms(),epoch:state.backup_worker.epoch.load(SeqCst) };
        next.queue.insert(0,i.clone()); i
    };
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
        "backup.cancel"=> { if let Some(token)=state.backup_worker.controls.lock().unwrap().get(params["runId"].as_str().unwrap()) { token.store(true,SeqCst); } let _=state.backup_worker.tx.get().unwrap().send(Cmd::Wake); Ok(json!({"accepted":true})) }
        "backup.stop"=> { state.backup_worker.epoch.fetch_add(1,SeqCst); for token in state.backup_worker.controls.lock().unwrap().values() {token.store(true,SeqCst);} let _=state.backup_worker.tx.get().unwrap().send(Cmd::Wake); Ok(json!({"accepted":true})) }
        _=>Ok(state.backup_worker.status()),
    };
    Some(match result { Ok(v)=>RpcResponse::success(id,v),Err(e)=>RpcResponse::error(id,ipc::INTERNAL_ERROR,e) })
}

#[cfg(test)]
#[path="backup_worker_tests.rs"]
mod tests;
