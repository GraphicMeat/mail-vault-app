//! Historical JS dependency replies exercise the native orchestration ports.
//! Provider, custody and protected-queue IO are separate daemon acceptance.
use super::*;

struct Oracle {
    case: Value,
    trace: Vec<Value>,
}
impl Oracle {
    fn effect(&self,t:&PurgeTarget,name:&str)->Option<&Value> {
        self.case["effects"].as_array().unwrap().iter().find(|e| {
            if e["effect"]!=name {return false;}
            if name=="mirror-purge" {return e["email"].as_str()==self.email(t).as_deref() && e["mailbox"]==t.mailbox && e["uids"].as_array().is_some_and(|uids|uids.contains(&json!(t.uid)));}
            e["accountId"]==t.account_id && (name=="graph-delete" || (e["mailbox"]==t.mailbox &&
                (e["uid"]==t.uid || e["uids"].as_array().is_some_and(|uids|uids.contains(&json!(t.uid))))))
        })
    }
    fn email(&self,t:&PurgeTarget)->Option<String> {
        if self.case["name"]=="missing-account-local" || self.case["name"]=="missing-account-email" {return None;}
        Some(if t.account_id.starts_with('2') {"two@example.test"}else{"me@mock.test"}.into())
    }
    fn record(&mut self,mut effect:Value) {
        let object=effect.as_object_mut().unwrap();
        object.remove("order");object.remove("reply");object.remove("error");
        self.trace.push(effect);
    }
}
impl Ports for Oracle {
    async fn checkpoint(&mut self,w:&Workflow)->Result<(),String> {
        assert!(w.valid_for(&w.intent),"{}: unsupported native checkpoint",self.case["name"]);
        let roundtrip:Workflow=serde_json::from_value(json!(w)).unwrap();
        assert!(roundtrip.valid_for(&w.intent));
        Ok(())
    }
    async fn identity(&mut self,_:&Group)->Result<(Identity,String),String> {panic!("ordinary identity port")}
    async fn archive(&mut self,_:&Group,_:Arc<AtomicBool>,_:&Identity)->Result<ArchiveOutcome,String> {panic!("purge must not archive/download")}
    async fn verify(&mut self,_:&Group,_:&Identity,_:&[StoredProof])->Result<Vec<u32>,String> {panic!("ordinary verify")}
    async fn copy(&mut self,_:&Group,_:&[u32],_:&[StoredProof])->Result<CopyProof,String> {panic!("purge must not mirror-copy")}
    async fn delete(&mut self,_:&Group,_:&[u32],_:&Identity,_:bool,_:Arc<AtomicBool>,_:&[StoredProof])->Result<Vec<u32>,String> {panic!("ordinary delete")}
    async fn purge_prepare(&mut self,t:&PurgeTarget,hint:&mailvault_core::bulk::TargetHint)->Result<PurgeProof,String> {
        let raw=format!("Message-ID: <{}>\r\n\r\noracle native artifact",hint.message_id.as_deref().unwrap_or("native@test"));
        let stored=Some(StoredProof{uid:t.uid,name:format!("{}.eml",t.uid),sha256:bulk_worker::bytes_hash(raw.as_bytes())});
        if hint.native_identity.is_none() {
            let scope=mailvault_core::app_db::compose_receipts::Scope::new(&t.account_id,&t.mailbox,t.uid,hint.message_id.as_deref().unwrap()).unwrap();
            let identity=mailvault_core::app_db::compose_receipts::Identity::from_bytes(scope,raw.as_bytes()).unwrap();
            return Ok(PurgeProof::Local{email:self.email(t),receipt:mailvault_core::app_db::compose_receipts::Receipt::present(identity),stored});
        }
        if self.case["input"]["graph"]==true {
            let id=hint.graph_id.clone().ok_or("errors.bulkOperationFailed")?;
            return Ok(PurgeProof::Server{email:self.email(t).unwrap_or_default(),origin:"oracle-native-origin".into(),identity:Identity::Graph{ids:HashMap::from([(t.uid,id)])},stored});
        }
        let status=self.case["effects"].as_array().unwrap().iter().find(|e|e["effect"]=="status" && e["accountId"]==t.account_id && e["mailbox"]==t.mailbox);
        if status.is_some_and(|e|e.get("error").is_some()) {return Err("errors.bulkIdentityUncertain".into());}
        let validity=status.and_then(|e|e["reply"]["uidValidity"].as_u64()).and_then(|n|u32::try_from(n).ok()).ok_or("errors.bulkIdentityUncertain")?;
        Ok(PurgeProof::Server{email:self.email(t).unwrap_or_default(),origin:"oracle-native-origin".into(),identity:Identity::Imap{validity,message_ids:hint.message_id.as_ref().map(|id|(t.uid,mailvault_core::maildir::normalize_message_id(id))).into_iter().collect()},stored})
    }
    async fn purge_server(&mut self,t:&PurgeTarget,_:Arc<AtomicBool>)->Result<(),String> {
        let effect=self.effect(t,if matches!(t.proof,Some(PurgeProof::Server{identity:Identity::Graph{..},..})){"graph-delete"}else{"server-delete"})
            .unwrap_or_else(||panic!("{}: unexpected native server target {t:?}",self.case["name"])).clone();
        let failed=effect.get("error").is_some();
        self.record(effect);
        if failed {Err("errors.bulkOperationFailed".into())}else{Ok(())}
    }
    async fn purge_local(&mut self,t:&PurgeTarget)->Result<PurgeEffect,String> {
        let mut effect=self.effect(t,"vault-delete").unwrap_or_else(||panic!("{}: unexpected native local target {t:?}",self.case["name"])).clone();
        let failed=effect.get("error").is_some();effect["uids"]=json!([t.uid]);
        self.record(effect);
        if failed {Err("ordinary local IO failure".into())}else{Ok(PurgeEffect::Complete)}
    }
    async fn purge_mirror(&mut self,t:&PurgeTarget)->Result<PurgeMirror,String> {
        let Some(mut effect)=self.effect(t,"mirror-purge").cloned() else {return Ok(PurgeMirror{outcome:PurgeEffect::Unresolved,removed:0,issue:Some("MissingAccountEmail".into())});};
        let failed=effect.get("error").is_some();
        let queued=effect["reply"]["queued"].as_u64().unwrap_or(0)>0;
        effect["uids"]=json!([t.uid]);self.record(effect);
        Ok(PurgeMirror{outcome:if failed {PurgeEffect::Unresolved}else if queued {PurgeEffect::Queued}else{PurgeEffect::Complete},removed:usize::from(!failed&&!queued),issue:failed.then(||"scripted mirror failure".into())})
    }
}
fn units(effects:&[Value])->Vec<String> {
    let mut out=vec![];
    for e in effects.iter().filter(|e|matches!(e["effect"].as_str(),Some("server-delete"|"graph-delete"|"vault-delete"|"mirror-purge"))) {
        let mut e=e.clone();let object=e.as_object_mut().unwrap();object.remove("order");object.remove("reply");object.remove("error");
        if let Some(uids)=e["uids"].as_array().cloned() {
            for uid in uids {e["uids"]=json!([uid]);out.push(e.to_string());}
        } else {out.push(e.to_string());}
    }
    out.sort();out
}

#[tokio::test]
async fn all_42_actual_js_cases_have_explicit_native_parity_or_safety_mapping() {
    let fixture:Value=serde_json::from_str(include_str!("../fixtures/purge-everywhere-cases.json")).unwrap();
    assert_eq!(fixture["runs"].as_array().unwrap().len(),42);
    for case in fixture["runs"].as_array().unwrap() {
        let name=case["name"].as_str().unwrap();
        // These are the accepted C/D original-identity/provenance narrowings,
        // including C's Undo rekey without a native restore identity. The JS
        // corpus remains unchanged and is never used as native authority.
        let refuse_original=match name {
            "graph-row-over-ledger"|"graph-ledger"|"offscreen-key"|"staged-without-custody"|"stale-winning-staged-row"|"undo-rekey-in-flight"|"unified-missing-account"=>true,
            "imap-equal"|"imap-missing-cached-generation"|"imap-missing-live-generation"|"imap-mismatched-generation"|"imap-status-offline"|
            "mixed-local-server-groups"|"mixed-generation-groups"|"server-refusal"|"vault-partial-failure"|"vault-partial-reply"|
            "backup-configured-offline"|"backup-unconfigured"|"backup-error"|"graph-miss"|"graph-refusal"|"jmap-transport"|
            "missing-account"|"missing-account-local"|"missing-account-email"|"custom-local-exclusion"|"local-sent"|"local-draft"|
            "unproven-local-display"|"stale-local-duplicate"|"merged-sent"|"mailbox-colons"|"offscreen-search-graph"|"no-message-id"|
            "unified-colliding-uids"|"tick-during-provenance"|"view-switch-during-server"|"view-switch-during-refresh"|"reader-thread-clear"|
            "clean-reporting-silence"|"empty"=>false,
            _=>panic!("unmapped real JS case: {name}"),
        };
        let mut raw_scope=case["selected"]["scope"].clone();raw_scope["keys"]=case["selected"]["keys"].clone();
        let mut scope:Scope=serde_json::from_value(raw_scope).unwrap();
        let grouped=mailvault_core::bulk::group_targets(&scope);
        let graph=case["input"]["graph"]==true;
        if !refuse_original {
            for g in &grouped.groups {for uid in &g.uids {
                let row=case["selected"]["rows"].as_object().unwrap().values().filter_map(Value::as_array).flatten().find(|r| {
                    r["uid"]==*uid && r["_accountId"].as_str().is_none_or(|a|a==g.account_id) && r["_mailbox"].as_str().is_none_or(|m|m==g.mailbox)
                });
                let local=case["effects"].as_array().unwrap().iter().any(|e|e["effect"]=="vault-delete" && e["accountId"]==g.account_id && e["mailbox"]==g.mailbox && e["uids"].as_array().is_some_and(|uids|uids.contains(&json!(uid))))
                    && !graph && !case["effects"].as_array().unwrap().iter().any(|e|e["effect"]=="server-delete"&&e["accountId"]==g.account_id&&e["mailbox"]==g.mailbox&&e["uid"]==*uid);
                let mid=row.and_then(|r|r["messageId"].as_str()).map(str::to_owned).or_else(||local.then(||format!("m{uid}@mock")));
                let validity=case["effects"].as_array().unwrap().iter().find(|e|e["effect"]=="headers-meta"&&e["accountId"]==g.account_id&&e["mailbox"]==g.mailbox).and_then(|e|e["reply"]["uidValidity"].as_u64());
                let graph_id=case["effects"].as_array().unwrap().iter().find(|e|e["effect"]=="graph-delete"&&e["accountId"]==g.account_id).and_then(|e|e["graphId"].as_str());
                scope.target_hints.push(serde_json::from_value(json!({"accountId":g.account_id,"mailbox":g.mailbox,"uid":uid,"messageIdPresent":mid.is_some(),"messageId":mid,"graphId":graph_id,
                    "nativeIdentity":if local {Value::Null}else{json!({"accountId":g.account_id,"mailbox":g.mailbox,"uidValidity":validity,"originHash":"oracle-native-origin"})}})).unwrap());
            }}
        }
        let mut work=Workflow::new(FrozenIntent::freeze(Action::DeleteEverywhere,scope,&[],&[]));
        if matches!(name,"missing-account"|"custom-local-exclusion") {for t in &mut work.purge_targets {t.skipped=true;}}
        let mut ports=Oracle{case:case.clone(),trace:vec![]};
        bulk_worker::run(&mut ports,&mut work,Arc::new(AtomicBool::new(false)),false).await.unwrap();
        if refuse_original {
            assert!(ports.trace.is_empty(),"{name}: missing original proof acquired effects");
            assert_eq!(work.purge_result.as_ref().unwrap().deleted,0,"{name}");
            continue;
        }
        assert_eq!(units(&ports.trace),units(case["effects"].as_array().unwrap()),"{name}: native mail effects");
        assert_eq!(json!(work.purge_result),case["result"],"{name}: original partial counters");
        let last_server=ports.trace.iter().rposition(|e|matches!(e["effect"].as_str(),Some("server-delete"|"graph-delete")));
        let first_local=ports.trace.iter().position(|e|matches!(e["effect"].as_str(),Some("vault-delete"|"mirror-purge")));
        if let (Some(server),Some(local))=(last_server,first_local) {assert!(server<local,"{name}: server first");}
        for t in &work.purge_targets {
            let local=ports.trace.iter().position(|e|e["effect"]=="vault-delete"&&e["accountId"]==t.account_id&&e["mailbox"]==t.mailbox&&e["uids"]==json!([t.uid]));
            let mirror=ports.trace.iter().position(|e|e["effect"]=="mirror-purge"&&e["email"].as_str()==ports.email(t).as_deref()&&e["mailbox"]==t.mailbox&&e["uids"]==json!([t.uid]));
            if let (Some(local),Some(mirror))=(local,mirror) {assert!(local<mirror,"{name}: local before mirror");}
        }
    }
}
