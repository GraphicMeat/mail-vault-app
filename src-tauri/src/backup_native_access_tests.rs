use super::*;
use std::sync::atomic::AtomicUsize;
fn attempt(execution:&str,generation:&str)->Attempt {
    Attempt{incarnation:"daemon-a".into(),run_id:"logical-run".into(),execution_id:execution.into(),owner_id:"shell-a".into(),acquisition_id:generation.into()}
}
fn holder()->NativeBackupAccess {
    let held=NativeBackupAccess::default();*held.session.lock().unwrap()=Some("shell-a".into());held
}
struct Fake<'a> {
    held:&'a NativeBackupAccess,
    pending:Mutex<Vec<Value>>,
    receipts:Mutex<HashMap<Attempt,(&'static str,bool)>>,
    acquired:AtomicUsize,
    released:Mutex<Vec<String>>,
    attached:Mutex<Vec<Attempt>>,
}
impl<'a> Fake<'a> {
    fn new(held:&'a NativeBackupAccess)->Self {Self{held,pending:Mutex::new(vec![json!({"runId":"logical-run","executionId":"execution-a"})]),receipts:Mutex::default(),acquired:AtomicUsize::new(0),released:Mutex::default(),attached:Mutex::default()}}
}
impl Ports for Fake<'_> {
    fn call(&self,method:&str,params:Value)->Result<Value,String> {
        match method {
            "backup.schedule.status"=>Ok(json!({"accessIncarnation":"daemon-a","pendingAccess":*self.pending.lock().unwrap()})),
            "backup.attach_access"=>{
                let a:Attach=serde_json::from_value(params).unwrap();
                assert!(self.held.holds.lock().unwrap().contains_key(&a.attempt),"attach raced before native scope registration");
                self.attached.lock().unwrap().push(a.attempt.clone());
                self.receipts.lock().unwrap().insert(a.attempt,("running",false));
                Err("reply timed out after acceptance".into())
            },
            "backup.access_status"=>{
                let q:Query=serde_json::from_value(params).unwrap();
                let (phase,safe)=self.receipts.lock().unwrap().get(&q.attempt).copied().unwrap_or(("foreign_incarnation",false));
                Ok(json!({"attempt":q.attempt,"state":phase,"safeRelease":safe}))
            },
            _=>panic!("unexpected method"),
        }
    }
    fn resolve(&self)->AttachResolution {self.acquired.fetch_add(1,SeqCst);AttachResolution{stamp:Some("native-stamp".into()),result:Resolution::Authorized{root:"/shared-drive".into()}}}
    fn release(&self,path:&str) {self.released.lock().unwrap().push(path.into());}
}
#[test]
fn backup_access_lost_ack_and_terminal_event_wait_for_exact_joined_receipt() {
    let held=holder();let ports=Fake::new(&held);
    reconcile(&held,&ports,"shell-a");
    let a=ports.attached.lock().unwrap()[0].clone();
    assert_eq!(held.holds.lock().unwrap().len(),1);
    assert_eq!(ports.released.lock().unwrap().len(),0);
    reconcile(&held,&ports,"shell-a"); // Same-daemon reconnect, still running.
    assert_eq!(ports.acquired.load(SeqCst),1);
    assert_eq!(ports.released.lock().unwrap().len(),0);
    release_receipt(&held,&ports,&a,&json!({"attempt":a,"state":"stopping","safeRelease":false}));
    assert_eq!(held.holds.lock().unwrap().len(),1);
    ports.pending.lock().unwrap().clear();
    ports.receipts.lock().unwrap().insert(a.clone(),("drained",true));
    reconcile(&held,&ports,"shell-a");
    reconcile(&held,&ports,"shell-a");
    assert_eq!(ports.released.lock().unwrap().len(),1);
    assert!(held.holds.lock().unwrap().is_empty());
}
#[test]
fn backup_access_same_path_acquisitions_and_same_run_retry_are_independent() {
    let held=holder();let ports=Fake::new(&held);
    ports.pending.lock().unwrap().push(json!({"runId":"other-run","executionId":"execution-b"}));
    reconcile(&held,&ports,"shell-a");
    let attached=ports.attached.lock().unwrap().clone();
    assert_eq!(attached.len(),2);assert_eq!(ports.acquired.load(SeqCst),2);
    ports.pending.lock().unwrap().clear();
    ports.receipts.lock().unwrap().insert(attached[0].clone(),("drained",true));
    reconcile(&held,&ports,"shell-a");
    assert_eq!(ports.released.lock().unwrap().len(),1);assert_eq!(held.holds.lock().unwrap().len(),1);
    ports.pending.lock().unwrap().push(json!({"runId":"logical-run","executionId":"execution-retry"}));
    reconcile(&held,&ports,"shell-a");
    assert_eq!(ports.acquired.load(SeqCst),3);assert_eq!(held.holds.lock().unwrap().len(),2);
    release_receipt(&held,&ports,&attached[0],&json!({"attempt":attached[0],"state":"drained","safeRelease":true}));
    assert_eq!(ports.released.lock().unwrap().len(),1);
}
#[test]
fn backup_access_old_status_reply_cannot_release_replacement_generation() {
    let held=holder();let ports=Fake::new(&held);ports.pending.lock().unwrap().clear();
    let old=attempt("execution-a","old");let fresh=attempt("execution-a","fresh");
    held.holds.lock().unwrap().insert(old.clone(),"/shared-drive".into());
    struct Race<'a>{base:&'a Fake<'a>,old:Attempt,fresh:Attempt}
    impl Ports for Race<'_> {
        fn call(&self,method:&str,params:Value)->Result<Value,String> {
            if method=="backup.access_status" {
                let old=self.base.held.holds.lock().unwrap().remove(&self.old).unwrap();self.base.release(&old);
                self.base.held.holds.lock().unwrap().insert(self.fresh.clone(),"/shared-drive".into());
                return Ok(json!({"attempt":self.old,"state":"drained","safeRelease":true}));
            }
            self.base.call(method,params)
        }
        fn resolve(&self)->AttachResolution {self.base.resolve()}
        fn release(&self,path:&str) {self.base.release(path)}
    }
    reconcile(&held,&Race{base:&ports,old:old.clone(),fresh:fresh.clone()},"shell-a");
    assert!(held.holds.lock().unwrap().contains_key(&fresh));assert_eq!(ports.released.lock().unwrap().len(),1);
}
#[test]
fn backup_access_replacement_shell_requires_fresh_acquisition_and_keeps_unknown_old_hold() {
    let held=holder();let ports=Fake::new(&held);
    let old=attempt("old-execution","old");held.holds.lock().unwrap().insert(old,"/shared-drive".into());
    *held.session.lock().unwrap()=Some("shell-b".into());
    reconcile(&held,&ports,"shell-a");assert_eq!(ports.acquired.load(SeqCst),0);
    reconcile(&held,&ports,"shell-b");
    assert_eq!(ports.attached.lock().unwrap()[0].owner_id,"shell-b");
    assert_eq!(ports.acquired.load(SeqCst),1);assert_eq!(ports.released.lock().unwrap().len(),0);
    assert_eq!(held.holds.lock().unwrap().len(),2);
}
#[test]
fn backup_access_slot_change_during_resolution_never_relabels_old_root() {
    let dir=tempfile::tempdir().unwrap();
    let save=|at| mailvault_core::app_db::with(dir.path(),|c|mailvault_core::app_db::locations::save_meta(c,"external-backup","/chosen","native",at,false)).unwrap();
    save(1);let old=wire::slot_stamp(dir.path()).unwrap().unwrap();
    let acquired=AtomicUsize::new(0);let released=Mutex::new(Vec::<String>::new());
    let resolved=resolve_saved(||wire::slot_stamp(dir.path()),|| {
        if acquired.fetch_add(1,SeqCst)==0 {save(2);Ok("/old-root".into())} else {Ok("/fresh-root".into())}
    },|path|released.lock().unwrap().push(path.into()));
    assert!(matches!(resolved.result,Resolution::Authorized{root} if root=="/fresh-root"));
    assert_ne!(resolved.stamp.as_deref(),Some(old.as_str()));
    assert_eq!(*released.lock().unwrap(),vec!["/old-root"]);assert_eq!(acquired.load(SeqCst),2);
}
#[test]
fn backup_access_unknown_slot_is_not_absent_and_never_resolves_a_raw_path() {
    let called=AtomicUsize::new(0);
    let result=resolve_saved(||Err("unreadable".into()),||{called.fetch_add(1,SeqCst);Ok("/caller-path".into())},|_|panic!("nothing acquired"));
    assert!(matches!(result.result,Resolution::Unknown));assert_eq!(called.load(SeqCst),0);
    let result=resolve_saved(||Ok(None),||panic!("known absent needs no scope"),|_|panic!("nothing acquired"));
    assert!(matches!(result.result,Resolution::NotConfigured));
}
