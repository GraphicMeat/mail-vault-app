//! Execution-bound native authority. Roots and sessions are never journaled.
use super::*;
use mailvault_core::backup_access::{self as wire, Attempt, Attach, Query, Resolution};
struct Record {
    attempt: Attempt,
    phase: String,
    root: Option<String>,
    slot: Option<String>,
    lost: bool,
}
pub(super) struct State {
    pub(super) incarnation: String,
    records: Mutex<HashMap<Attempt, Record>>,
    owners: Mutex<HashSet<String>>,
}
impl Default for State {
    fn default() -> Self { Self { incarnation: uuid::Uuid::new_v4().to_string(), records: Mutex::default(), owners: Mutex::default() } }
}
fn receipt(record: &Record) -> Value {
    json!({"attempt":record.attempt,"state":record.phase,"safeRelease":matches!(record.phase.as_str(),"drained"|"fenced"|"rejected")})
}
impl State {
    pub(super) fn receipts(&self) -> Value { json!(self.records.lock().unwrap().values().map(receipt).collect::<Vec<_>>()) }
}
pub(super) enum Request { Attach(Attach), Status(Query) }
pub(crate) fn owner_connected(state: &Arc<DaemonState>, owner: &str) {
    state.backup_worker.access.owners.lock().unwrap().insert(owner.into());
}
pub(crate) fn owner_lost(state: &Arc<DaemonState>, owner: &str) {
    state.backup_worker.access.owners.lock().unwrap().remove(owner);
    let mut records=state.backup_worker.access.records.lock().unwrap();
    for r in records.values_mut().filter(|r|r.attempt.owner_id==owner && !matches!(r.phase.as_str(),"drained"|"fenced"|"rejected")) {
        r.lost=true;
        if let Some(t)=state.backup_worker.controls.lock().unwrap().get(&r.attempt.run_id) { t.store(true,SeqCst); }
    }
    if let Some(tx)=state.backup_worker.tx.get() {let _=tx.send(Cmd::OwnerLost(owner.into()));}
}
pub(super) fn interrupt_owner(state:&Arc<DaemonState>,ledger:&mut Ledger,owner:&str) {
    let records=state.backup_worker.access.records.lock().unwrap();
    for i in ledger.active.iter_mut().chain(ledger.queue.iter_mut()) {
        if records.values().any(|r|r.attempt.owner_id==owner && r.attempt.execution_id==i.execution_id && r.lost) && i.stage!="uncertain" {i.stage="stopping".into();}
    }
}
pub(super) async fn process(state:&Arc<DaemonState>, ledger:&mut Ledger, request:Request)->Result<Value,String> {
    let (attempt,fence)=match &request { Request::Attach(a)=>(&a.attempt,false), Request::Status(q)=>(&q.attempt,q.fence_unstarted) };
    let access=&state.backup_worker.access;
    let key=attempt.clone();
    if key.incarnation!=access.incarnation { return Ok(json!({"attempt":key,"state":"foreign_incarnation","safeRelease":false})); }
    {
        let records=access.records.lock().unwrap();
        if let Some(r)=records.get(&key) {return Ok(receipt(r));}
    }
    let current=ledger.active.iter().chain(ledger.queue.iter()).find(|i| i.run_id==key.run_id && i.execution_id==key.execution_id);
    let live=current.is_some_and(|i| !cancelled(state,i));
    let active=ledger.active.as_ref().is_some_and(|i|i.execution_id==key.execution_id);
    let conflict=access.records.lock().unwrap().values().any(|r|r.attempt.execution_id==key.execution_id && !matches!(r.phase.as_str(),"drained"|"fenced"|"rejected"));
    let mut record=Record{attempt:key.clone(),phase:"pending".into(),root:None,slot:None,lost:false};
    match request {
        Request::Status(_) if fence => { record.phase=if active {"preparing"} else {"fenced"}.into(); }
        Request::Status(_) => {return Ok(json!({"attempt":key,"state":"unknown","safeRelease":false}));}
        Request::Attach(attach) => {
            if !live || conflict || !access.owners.lock().unwrap().contains(&key.owner_id) {record.phase="rejected".into();}
            else {
                let path=state.app_dir.clone();
                let stamp=common::blocking(move||wire::slot_stamp(&path)).await?;
                match (stamp,&attach.resolution) {
                    (Ok(Some(stamp)),Resolution::Authorized{root}) if Some(&stamp)==attach.slot_stamp.as_ref() && !root.is_empty() => {record.phase="accepted".into();record.root=Some(root.clone());record.slot=Some(stamp);}
                    (Ok(None),Resolution::NotConfigured) if attach.slot_stamp.is_none()=>{record.phase="rejected".into();}
                    _=> {record.phase="rejected".into();}
                }
            }
        }
    }
    let out=receipt(&record);
    access.records.lock().unwrap().insert(key,record);
    if out["state"]=="accepted" {
        if let Some(i)=ledger.queue.iter_mut().find(|i|i.execution_id==attempt_execution(&out)) { i.stage="queued".into(); }
    }
    Ok(out)
}
fn attempt_execution(value:&Value)->&str { value["attempt"]["executionId"].as_str().unwrap_or("") }
pub(super) async fn route(state:&Arc<DaemonState>,method:&str,params:&Value,id:Value)->Option<RpcResponse> {
    let request=match method {
        "backup.attach_access"=>serde_json::from_value::<Attach>(params.clone()).ok().filter(|a|a.attempt.valid()).map(Request::Attach),
        "backup.access_status"=>serde_json::from_value::<Query>(params.clone()).ok().filter(|q|q.attempt.valid()).map(Request::Status),
        _=>return None,
    };
    let Some(request)=request else {return Some(RpcResponse::error(id,ipc::INVALID_PARAMS,"errors.settingsInvalid"));};
    start(state.clone());
    let (tx,rx)=oneshot::channel();
    let result=if state.backup_worker.tx.get().unwrap().send(Cmd::Access{request,reply:tx}).is_ok() {rx.await.unwrap_or_else(|_|Err("errors.settingsNotLoaded".into()))} else {Err("errors.settingsNotLoaded".into())};
    Some(match result {Ok(v)=>RpcResponse::success(id,v),Err(e)=>RpcResponse::error(id,ipc::INTERNAL_ERROR,e)})
}
