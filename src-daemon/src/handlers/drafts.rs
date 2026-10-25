//! Local-only drafts. Heavy preparation precedes the draft commit lock; all
//! file effects use existing mailbox -> vault -> custody units on workers.
use crate::{custody as custody,handlers::common::{self,blocking,with_mailbox_write},ipc::{self,RpcResponse},server::DaemonState};
use mailvault_core::{app_db::{self,drafts as db,compose_receipts::{self,Identity,Receipt,Scope}},drafts::{self,Copy,Intent,Location,Record,Save},custody::{entries,cache},message_store,vault_files,smtp};
use serde_json::{json,Value};
use base64::{engine::general_purpose::STANDARD,Engine};
use std::{collections::{HashMap,HashSet},path::{Path,PathBuf},sync::{Arc,Mutex,LazyLock,Weak,atomic::AtomicBool}};
const PREPARED:&str=".mailvault-draft-prepared";
static LOCKS:LazyLock<Mutex<HashMap<(PathBuf,String),Weak<Mutex<()>>>>>=LazyLock::new(Default::default);
fn draft_lock(s:&DaemonState,id:&str)->Arc<Mutex<()>> {let mut map=LOCKS.lock().unwrap_or_else(|p|p.into_inner());map.retain(|_,v|v.strong_count()>0);let key=(s.app_dir.clone(),id.into());if let Some(lock)=map.get(&key).and_then(Weak::upgrade){return lock;}let lock=Arc::new(Mutex::new(()));map.insert(key,Arc::downgrade(&lock));lock}
fn load(s:&DaemonState,id:&str)->Result<Record,String>{app_db::with(&s.app_dir,|c|db::load(c,id)).map(|r|r.unwrap_or_else(||Record::new(id)))}
fn persist(s:&DaemonState,r:&Record)->Result<(),String>{app_db::with(&s.app_dir,|c|db::save(c,r))}
fn account(s:&DaemonState,id:&str,from:&str,name:&str)->Result<mailvault_core::imap::ImapConfig,String>{
    let raw=std::fs::read(s.app_dir.join("accounts.json")).map_err(|e|format!("draft account read: {e}"))?;
    let rows:Vec<Value>=serde_json::from_slice(&raw).map_err(|e|format!("draft account parse: {e}"))?;
    let mut found=rows.iter().filter(|r|r["id"].as_str()==Some(id));let r=found.next().ok_or("draft account missing")?;if found.next().is_some(){return Err("duplicate draft account".into());}
    let email=r["email"].as_str().filter(|s|!s.trim().is_empty()).ok_or("draft identity missing")?;
    // MIME construction needs no token, password, network, or keychain read.
    serde_json::from_value(json!({"email":email,"imapHost":r["imapHost"].as_str().unwrap_or(""),"name":name,"fromEmail":if from.is_empty(){email}else{from}})).map_err(|e|e.to_string())
}
fn mailbox(s:&DaemonState,id:&str)->Result<String,String>{let boxes=custody::with_conn(s,|c|cache::load_mailboxes(c,id))?;let value=boxes.map(|v|serde_json::from_str(&v).map_err(|e|format!("draft mailbox cache: {e}"))).transpose()?.unwrap_or(json!([]));Ok(drafts::drafts_mailbox(&value))}
fn scheduled(s:&DaemonState,l:&Location)->Result<bool,String>{app_db::with(&s.app_dir,|c|c.query_row("SELECT EXISTS(SELECT 1 FROM scheduled_sends WHERE account_id=?1 AND mailbox=?2 AND uid=?3)",rusqlite::params![l.account_id,l.mailbox,l.uid],|r|r.get(0)).map_err(|e|e.to_string()))}
struct Inventory {root:PathBuf,fence:mailvault_core::vault_registry::TargetFence,candidates:Vec<message_store::UidArtifact>}
fn inventory(s:&Arc<DaemonState>,l:&Location)->Result<Inventory,String>{
    let (root,fence)=with_mailbox_write(s,&l.account_id,&l.mailbox,|root|Ok((root.to_path_buf(),s.vault_registry.target_fence(root,&l.account_id,&l.mailbox,l.uid).ok_or("draft registry unavailable")?)))?;
    let mut all=message_store::inventory_uid_artifacts(&root,&l.account_id,&l.mailbox,&HashSet::from([l.uid]),&AtomicBool::new(false)).map_err(|e|e.to_string())?;
    Ok(Inventory{root,fence,candidates:all.remove(&l.uid).ok_or("draft inventory unavailable")?})
}
fn checked_bytes(s:&DaemonState,root:&Path,l:&Location,i:&Inventory)->Result<Option<Vec<u8>>,String>{
    if root!=i.root||s.vault_registry.target_fence(root,&l.account_id,&l.mailbox,l.uid).as_ref()!=Some(&i.fence){return Err("draft storage changed".into());}
    let raw=message_store::read_uid_candidates(root,&l.account_id,&l.mailbox,l.uid,&i.candidates).map_err(|e|e.to_string())?;
    if raw.iter().skip(1).any(|(_,b)|b!=&raw[0].1){return Err("conflicting draft artifacts".into());}Ok(raw.into_iter().next().map(|(_,b)|b))
}
fn receipt_history(s:&DaemonState,copy:&Copy,retire:bool)->Result<(),String>{app_db::with(&s.app_dir,|c|{
    let proof=Receipt::present(copy.identity.clone());let history=compose_receipts::load(c,&copy.identity.scope)?;
    if history.iter().any(|p|p!=&proof){return Err("conflicting draft receipt history".into());}
    if retire&&!history.is_empty()&&!compose_receipts::retire(c,&proof)? {return Err("draft receipt changed".into());}Ok(())
})}
fn draft_owner(c:&rusqlite::Connection,l:&Location,expected:&Copy)->Result<(),String>{let row=entries::get(c,&l.account_id,&l.mailbox,l.uid)?.ok_or("draft custody missing")?;if !drafts::editable(&row)||row["message_id"].as_str().and_then(mailvault_core::compose::normalize_message_id).as_deref()!=Some(&expected.identity.scope.message_id){return Err("draft custody changed".into());}Ok(())}
fn read_copy(s:&Arc<DaemonState>,copy:&Copy,require_owner:bool)->Result<Option<Vec<u8>>,String>{let l=copy.location();let i=inventory(s,&l)?;with_mailbox_write(s,&l.account_id,&l.mailbox,|root|custody::with_conn(s,|c|{let raw=checked_bytes(s,root,&l,&i)?;if require_owner {draft_owner(c,&l,copy)?;}if let Some(raw)=&raw {if !copy.identity.matches_bytes(raw){return Err("draft bytes changed".into());}}receipt_history(s,copy,false)?;Ok(raw)}))}
fn adopt(s:&Arc<DaemonState>,r:&mut Record,l:&Location)->Result<(),String>{
    if scheduled(s,l)?{return Err("scheduled ownership is not editable".into());}
    if app_db::with(&s.app_dir,|c|db::owner(c,l))?.is_some(){return Err("draft location already managed".into());}
    let i=inventory(s,l)?;
    let copy=with_mailbox_write(s,&l.account_id,&l.mailbox,|root|custody::with_conn(s,|c|{
        let row=entries::get(c,&l.account_id,&l.mailbox,l.uid)?.ok_or("legacy draft missing")?;
        if !drafts::editable(&row){return Err("not an editable local draft".into());}
        let raw=checked_bytes(s,root,l,&i)?.ok_or("draft body missing")?;
        let mid=row["message_id"].as_str().ok_or("legacy draft Message-ID missing")?;
        let proof=Scope::new(&l.account_id,&l.mailbox,l.uid,mid).and_then(|scope|Identity::from_bytes(scope,&raw)).ok_or("draft identity mismatch")?;
        let copy=Copy{identity:proof,entry:row};receipt_history(s,&copy,false)?;Ok(copy)
    }))?;
    r.current=Some(copy);persist(s,r)
}
fn allocate(s:&Arc<DaemonState>,account:&str,mailbox:&str)->Result<u32,String>{with_mailbox_write(s,account,mailbox,|root|{
    let mut uid=vault_files::free_local_uid(root,account,mailbox);
    loop {let loc=Location{account_id:account.into(),mailbox:mailbox.into(),uid};if app_db::with(&s.app_dir,|c|db::owner(c,&loc))?.is_none()&&!vault_files::exists(root,account,mailbox,uid){return Ok(uid);}uid=uid.checked_add(1).ok_or("draft uid exhausted")?;}
})}
fn install(s:&Arc<DaemonState>,copy:&Copy,raw:&[u8],flags:&[String])->Result<(),String>{
    let l=copy.location();let prepared=common::with_vault_write(s,|root|vault_files::prepare_store(root,&l.account_id,&l.mailbox,l.uid,raw.to_vec(),flags))?;
    let i=inventory(s,&l)?;
    with_mailbox_write(s,&l.account_id,&l.mailbox,|root|{
        if root!=prepared.root(){return Err("draft root changed".into());}
        let held=checked_bytes(s,root,&l,&i)?;
        if let Some(bytes)=held {if !copy.identity.matches_bytes(&bytes){return Err("draft destination occupied".into());}return Ok(());}
        if !vault_files::store_prepared(&s.vault_registry,root,&l.account_id,&l.mailbox,&prepared,flags,false)?{return Err("draft destination occupied".into());}Ok(())
    })
}
fn retire(s:&Arc<DaemonState>,copy:&Copy,prepared:bool)->Result<(),String>{
    let l=copy.location();if scheduled(s,&l)?{return Err("scheduled ownership cannot retire".into());}let i=inventory(s,&l)?;
    with_mailbox_write(s,&l.account_id,&l.mailbox,|root|custody::with_conn(s,|c|{
        let raw=checked_bytes(s,root,&l,&i)?;
        if let Some(row)=entries::get(c,&l.account_id,&l.mailbox,l.uid)? {if !drafts::editable(&row)||row["message_id"].as_str().and_then(mailvault_core::compose::normalize_message_id).as_deref()!=Some(&copy.identity.scope.message_id){return Err("draft cleanup custody conflict".into());}}
        if let Some(raw)=raw.as_deref(){if !copy.identity.matches_bytes(raw){return Err("draft cleanup bytes changed".into());}
            if !prepared {let proof=Receipt::present(copy.identity.clone());if crate::handlers::compose::retained_local_ownership_resolved_with_conn(c,&proof,Some(raw))?.is_none(){return Err("draft cleanup ownership changed".into());}}
        }
        receipt_history(s,copy,true)?;
        probe(s,if prepared{"retire_prepared"}else{"retire"})?;
        let result=vault_files::delete_uid_candidates(&s.vault_registry,root,&l.account_id,&l.mailbox,l.uid,&i.candidates)?;if result.failed{return Err("draft cleanup incomplete".into());}
        entries::remove(c,&l.account_id,&l.mailbox,&[l.uid])?;Ok(())
    }))
}
fn cleanup(s:&Arc<DaemonState>,r:&mut Record)->Result<(),String>{
    let copies=r.cleanup.clone();for copy in copies {let is_prepared=copy.identity.scope.mailbox==PREPARED;if retire(s,&copy,is_prepared).is_ok(){r.cleanup.retain(|c|c.identity!=copy.identity);persist(s,r)?;}}
    Ok(())
}
fn finish(s:&Arc<DaemonState>,r:&mut Record)->Result<(),String>{
    let Some(p)=r.pending.clone() else{return Ok(())};
    if r.discarded {r.cleanup.push(p.copy);r.cleanup.push(p.prepared);r.pending=None;persist(s,r)?;return cleanup(s,r);}
    if common::vault_root(s)?!=p.root{return Err("pending draft vault moved".into());}
    let raw=read_copy(s,&p.prepared,false)?.ok_or("prepared draft body unavailable")?;
    probe(s,"before_destination")?;
    install(s,&p.copy,&raw,&drafts::FLAGS.map(String::from))?;
    probe(s,"after_bytes")?;
    let l=p.copy.location();let i=inventory(s,&l)?;
    with_mailbox_write(s,&l.account_id,&l.mailbox,|root|custody::with_conn(s,|c|{
        let bytes=checked_bytes(s,root,&l,&i)?.ok_or("draft destination missing")?;if !p.copy.identity.matches_bytes(&bytes){return Err("draft destination readback failed".into());}
        if let Some(row)=entries::get(c,&l.account_id,&l.mailbox,l.uid)?{if !drafts::editable(&row)||row["message_id"]!=p.copy.entry["message_id"]{return Err("draft destination custody conflict".into());}}
        entries::upsert(c,&l.account_id,&l.mailbox,std::slice::from_ref(&p.copy.entry))?;Ok(())
    }))?;
    probe(s,"before_accept")?;
    if let Some(old)=r.current.take(){r.cleanup.push(old);}r.cleanup.push(p.prepared);
    r.current=Some(p.copy);r.revision=p.revision;r.request_hash=Some(p.request_hash);r.fingerprint=Some(p.fingerprint);r.pending=None;persist(s,r)?;cleanup(s,r)
}
fn response(r:&Record,disposition:&str)->Value{let mut v=json!({"draftId":r.draft_id,"revision":r.revision,"disposition":disposition,"cleanup":if r.cleanup.is_empty(){"complete"}else{"pending"},"current":r.current,"pending":r.pending.as_ref().map(|p|json!({"revision":p.revision,"identity":p.copy.identity,"preparedIdentity":p.prepared.identity})),"cleanupIdentities":r.cleanup.iter().map(|c|&c.identity).collect::<Vec<_>>(),"discarded":r.discarded});if let Some(copy)=&r.current{let l=copy.location();v["accountId"]=json!(l.account_id);v["mailbox"]=json!(l.mailbox);v["uid"]=json!(l.uid);v["entry"]=copy.entry.clone();v["entry"]["draftId"]=json!(r.draft_id);v["entry"]["revision"]=json!(r.revision);}v}
fn resolve_attachments(s:&Arc<DaemonState>,r:&mut Save)->Result<(),String>{
    let mut sources:HashMap<(String,String,u32),Vec<usize>>=HashMap::new();for (index,a) in r.snapshot.attachments.iter_mut().enumerate(){if let Some(content)=&a.content {a.content=Some(STANDARD.encode(STANDARD.decode(content).map_err(|e|e.to_string())?));}else{let src=a.source.as_ref().ok_or("attachment source missing")?;sources.entry((src.account_id.clone(),src.mailbox.clone(),src.uid)).or_default().push(index);}}
    for ((account,mailbox,uid),indices) in sources {let loc=Location{account_id:account,mailbox,uid};let i=inventory(s,&loc)?;let raw=with_mailbox_write(s,&loc.account_id,&loc.mailbox,|root|checked_bytes(s,root,&loc,&i))?.ok_or("attachment source unavailable")?;let requested:Vec<_>=indices.iter().map(|i|r.snapshot.attachments[*i].source.as_ref().unwrap().attachment_index).collect();let bytes=vault_files::attachments_of(&raw,&requested)?;for (index,content) in indices.into_iter().zip(bytes){r.snapshot.attachments[index].content=Some(content.ok_or("attachment source unavailable")?);}}
    Ok(())
}
fn save(s:&Arc<DaemonState>,mut request:Save)->Result<Value,String>{
    let request_hash=request.request_hash();
    // Retry first reconciles retained bytes, never regenerates the pending MIME.
    {let lock=draft_lock(s,&request.draft_id);let _held=lock.lock().unwrap_or_else(|p|p.into_inner());let mut r=load(s,&request.draft_id)?;
      if r.discarded{return Err("draft discarded".into());}
      if let Some(p)=&r.pending {if p.revision==request.revision&&p.request_hash!=request_hash{return Err("draft revision conflict".into());}finish(s,&mut r)?;}
      cleanup(s,&mut r)?;
      if request.revision<r.revision{return Ok(response(&r,"superseded"));}
      if request.revision==r.revision {if r.request_hash.as_deref()!=Some(&request_hash){return Err("draft revision conflict".into());}if let Some(current)=&r.current{read_copy(s,current,true)?.ok_or("draft body missing")?;}return Ok(response(&r,"unchanged"));}
      if !r.cleanup.is_empty(){return Err("draft cleanup pending".into());}
    }
    let account=account(s,&request.account_id,&request.from_address,&request.display_name)?;if request.from_address.is_empty(){request.from_address=account.email.clone();}
    resolve_attachments(s,&mut request)?;let fingerprint=request.content_hash();
    let raw=smtp::build_draft_mime(&account,&request.outgoing()?)?.raw_rfc2822;
    probe(s,"prepared")?;
    let lock=draft_lock(s,&request.draft_id);let _held=lock.lock().unwrap_or_else(|p|p.into_inner());let mut r=load(s,&request.draft_id)?;
    // Deliberately exercised by the native race tests before the final fence.
    if let Some(p)=&r.pending {let _=p;finish(s,&mut r)?;}
    cleanup(s,&mut r)?;if !r.cleanup.is_empty(){return Err("draft cleanup pending".into());}
    if r.current.is_none(){if let Some(loc)=&request.previous_identity{adopt(s,&mut r,loc)?;}}
    if let Some(current)=&r.current {read_copy(s,current,true)?.ok_or("draft current body missing")?;}
    let target_mailbox=match &r.current {Some(c) if c.identity.scope.account_id==request.account_id=>c.identity.scope.mailbox.clone(),_=>mailbox(s,&request.account_id)?};
    let uid=allocate(s,&request.account_id,&target_mailbox)?;let stage_uid=allocate(s,&request.account_id,PREPARED)?;
    let mid=mailvault_core::maildir::message_id_in(&raw).ok_or("draft Message-ID missing")?;
    let proof=|mailbox:&str,uid|Identity::from_bytes(Scope::new(&request.account_id,mailbox,uid,&mid).unwrap(),&raw).unwrap();
    let entry=request.row(uid,&mid,&mailvault_core::compose::now_iso());
    let prepared=Copy{identity:proof(PREPARED,stage_uid),entry:Value::Null};
    let intent=Intent{revision:request.revision,request_hash,fingerprint,copy:Copy{identity:proof(&target_mailbox,uid),entry},prepared:prepared.clone(),root:common::vault_root(s)?};
    r.pending=Some(intent);persist(s,&r)?;
    install(s,&prepared,&raw,&["seen".into()])?;
    probe(s,"after_prepared_store")?;
    finish(s,&mut r)?;Ok(response(&r,"saved"))
}
fn discard(s:&Arc<DaemonState>,id:&str)->Result<Value,String>{
    let lock=draft_lock(s,id);let _held=lock.lock().unwrap_or_else(|p|p.into_inner());let mut r=load(s,id)?;
    r.discarded=true;if let Some(c)=r.current.take(){r.cleanup.push(c);}if let Some(p)=r.pending.take(){r.cleanup.push(p.copy);r.cleanup.push(p.prepared);}persist(s,&r)?;cleanup(s,&mut r)?;
    Ok(json!({"draftId":id,"discarded":true,"cleanup":if r.cleanup.is_empty(){"complete"}else{"pending"},"cleanupIdentities":r.cleanup.iter().map(|c|&c.identity).collect::<Vec<_>>()}))
}
fn list(s:&Arc<DaemonState>,params:&Value)->Result<Value,String>{
    let exact=params.get("identity").map(|v|serde_json::from_value::<Location>(v.clone()).map_err(|e|e.to_string())).transpose()?;
    let content=params["includeContent"].as_bool().unwrap_or(false);if content&&exact.is_none(){return Err("draft content requires exact identity".into());}
    let accounts=if let Some(id)=params["accountId"].as_str(){vec![id.into()]}else{crate::handlers::insights::configured_account_ids(&s.app_dir)?};
    for account in accounts {let rows=custody::with_conn(s,|c|entries::entries_for_account(c,&account))?;for (mailbox,row) in rows {if !drafts::editable(&row){continue;}let Some(uid)=entries::uid_of(&row) else{continue};let l=Location{account_id:account.clone(),mailbox,uid};if scheduled(s,&l)?||app_db::with(&s.app_dir,|c|db::owner(c,&l))?.is_some(){continue;}
      let id=uuid::Uuid::new_v4().to_string();let lock=draft_lock(s,&id);let _held=lock.lock().unwrap_or_else(|p|p.into_inner());let mut r=Record::new(&id);let _=adopt(s,&mut r,&l);
    }}
    let mut records=app_db::with(&s.app_dir,db::all)?;
    let mut selected_id=None;
    if let Some(loc)=&exact {selected_id=app_db::with(&s.app_dir,|c|db::owner(c,loc))?;if let Some(id)=&selected_id {let r=load(s,id)?;let actual=r.current.iter().chain(&r.cleanup).find(|c|c.location()==*loc);if let Some(copy)=actual {read_copy(s,copy,true)?.ok_or("stale draft body missing")?;}else{return Ok(json!({"drafts":[],"missingBody":true}));}}}
    let mut out=vec![];
    for r in &mut records {if exact.is_some()&&selected_id.as_deref()!=Some(&r.draft_id){continue;}if params["accountId"].as_str().is_some_and(|a|r.current.as_ref().is_some_and(|c|c.identity.scope.account_id!=a)){continue;}
      let lock=draft_lock(s,&r.draft_id);let _held=lock.lock().unwrap_or_else(|p|p.into_inner());*r=load(s,&r.draft_id)?;let _=finish(s,r);let _=cleanup(s,r);
      let mut view=response(r,"unchanged");if content {if let Some(copy)=&r.current {let Some(raw)=read_copy(s,copy,true)? else{return Ok(json!({"drafts":[],"missingBody":true}));};let parsed=mailvault_core::vault_eml::parse_eml_bytes(&raw,copy.identity.scope.uid,drafts::FLAGS.map(String::from).to_vec())?;view["eml"]=serde_json::to_value(parsed).map_err(|e|e.to_string())?;}}
      out.push(view);
    }
    Ok(json!({"drafts":out,"missingBody":content&&exact.is_some()&&selected_id.is_none()}))
}
pub(crate) async fn route(state:&Arc<DaemonState>,method:&str,params:&Value,id:Value)->Option<RpcResponse>{
    if !matches!(method,"drafts.save"|"drafts.discard"|"drafts.list"){return None;}
    let request=if method=="drafts.save" {match Save::parse(params.clone()){Ok(r)=>Some(r),Err(e)=>return Some(RpcResponse::error(id,ipc::INVALID_PARAMS,e))}}else{None};
    let s=Arc::clone(state);let params=params.clone();let method=method.to_string();
    let result=blocking(move||match method.as_str(){"drafts.save"=>save(&s,request.unwrap()),"drafts.discard"=>params["draftId"].as_str().filter(|s|!s.is_empty()).ok_or("draftId required".into()).and_then(|id|discard(&s,id)),_=>list(&s,&params)}).await.and_then(|r|r);
    Some(common::done(id,result))
}
#[cfg(not(test))] fn probe(_: &DaemonState,_:&str)->Result<(),String>{Ok(())}
#[cfg(test)] fn probe(s:&DaemonState,point:&str)->Result<(),String>{tests::probe(s,point)}
#[cfg(test)] mod tests;
