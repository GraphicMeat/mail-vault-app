use super::*;
use std::sync::Condvar;
type Hook = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
static HOOKS: LazyLock<Mutex<HashMap<PathBuf, Hook>>> = LazyLock::new(Default::default);
pub(super) fn probe(s: &DaemonState, point: &str) -> Result<(), String> {
    let hook = HOOKS.lock().unwrap().get(&s.app_dir).cloned();
    hook.map(|h| h(point)).unwrap_or(Ok(()))
}
struct Harness {
    _dir: tempfile::TempDir,
    s: Arc<DaemonState>,
}
impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let app = dir.path().join("app");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("accounts.json"),json!([{"id":"one","email":"one@example.test","imapHost":"offline.invalid"},{"id":"two","email":"two@example.test","imapHost":"offline.invalid"},{"id":"three","email":"three@example.test","imapHost":"offline.invalid"}]).to_string()).unwrap();
        let s = DaemonState::for_test(root, app, true);
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
        Self { _dir: dir, s }
    }
    fn hook(&self, h: impl Fn(&str) -> Result<(), String> + Send + Sync + 'static) {
        HOOKS
            .lock()
            .unwrap()
            .insert(self.s.app_dir.clone(), Arc::new(h));
    }
    fn clear(&self) {
        HOOKS.lock().unwrap().remove(&self.s.app_dir);
    }
    fn seed_lifecycle(&self) {
        self.s.account_lifecycle.seed(&mailvault_core::accounts_doc::Listing {
            accounts: vec![json!({"id":"one"}), json!({"id":"two"}), json!({"id":"three"})],
            version: 0,
            recovered: None,
        });
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.clear();
    }
}
fn req(id: &str, revision: u64, text: &str) -> Value {
    json!({"draftId":id,"revision":revision,"accountId":"one","fromAddress":"alias@example.test","displayName":"Alias","snippet":text,"snapshot":{"to":"next@example.test","cc":"copy@example.test","bcc":"blind@example.test","subject":"Draft","html":format!("<p>{text}</p>"),"text":text,"inReplyTo":"<parent@example.test>","references":"<root@example.test> <parent@example.test>","attachments":[]}})
}
async fn rpc(s: &Arc<DaemonState>, method: &str, p: Value) -> Result<Value, String> {
    let r = crate::server::handle_request_for_test(s, method, p).await;
    r.result.ok_or_else(|| r.error.unwrap().message)
}
async fn saved(s: &Arc<DaemonState>, p: Value) -> Value {
    rpc(s, "drafts.save", p).await.unwrap()
}
fn loc(v: &Value) -> Value {
    json!({"accountId":v["accountId"],"mailbox":v["mailbox"],"uid":v["uid"]})
}
fn row(s: &DaemonState, id: &str) -> Record {
    load(s, id).unwrap()
}
fn wait_preparation(
    h: &Harness,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    Arc<(Mutex<bool>, Condvar)>,
) {
    wait_at(h, "prepared")
}
fn wait_at(
    h: &Harness,
    held_point: &'static str,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    Arc<(Mutex<bool>, Condvar)>,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let copy = release.clone();
    h.hook(move |point| {
        if point == held_point {
            let notify = { tx.lock().unwrap().take() };
            if let Some(tx) = notify {
                let _ = tx.send(());
                let (lock, cv) = &*copy;
                let mut ready = lock.lock().unwrap();
                while !*ready {
                    let (next, timeout) = cv
                        .wait_timeout(ready, std::time::Duration::from_secs(10))
                        .unwrap();
                    ready = next;
                    if timeout.timed_out() {
                        return Err("preparation test gate timed out".into());
                    }
                }
            }
        }
        Ok(())
    });
    (rx, release)
}
fn release(gate: Arc<(Mutex<bool>, Condvar)>) {
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
}
fn lifecycle_lease(id: &str) -> crate::account_workflows::AccountLease {
    crate::account_workflows::AccountLease::detached_for_test(
        crate::account_workflows::AccountWriteScope {
            ids: [id.to_owned()].into(),
            ..Default::default()
        },
    )
}
async fn retire_account(s: &Arc<DaemonState>, id: &str) {
    let mut claim = s.account_lifecycle.try_close(lifecycle_lease(id), id).unwrap();
    let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
    claim.mark_effects_started(drained).unwrap();
    claim.finish_retired().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p3_old_draft_preparation_cannot_publish_after_retirement() {
    let h = Harness::new();
    h.seed_lifecycle();
    let (started, gate) = wait_preparation(&h);
    let s = h.s.clone();
    let old = tokio::spawn(async move { rpc(&s, "drafts.save", req("retired-preparation", 1, "late" )).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), started).await.unwrap().unwrap();
    retire_account(&h.s, "one").await;
    release(gate);
    let result = old.await.unwrap();
    let record = row(&h.s, "retired-preparation");
    let late_copy = record.current.as_ref().or_else(|| record.pending.as_ref().map(|p| &p.copy));
    let late_file = late_copy.is_some_and(|copy| {
        let l = copy.location();
        message_store::read_raw(&h.s.data_dir, &l.account_id, &l.mailbox, l.uid).unwrap().is_some()
    });
    let mut b = req("other-preparation", 1, "ordinary");
    b["accountId"] = json!("two");
    let b_result = rpc(&h.s, "drafts.save", b).await;
    assert!(b_result.is_ok(), "unrelated B draft remains usable: {b_result:?}");
    assert!(result.is_err() && record.current.is_none() && record.pending.is_none() && !late_file,
        "retired A draft published: response={result:?} record={record:?} late_file={late_file}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p3_admitted_draft_child_keeps_complete_account_scope() {
    let h = Harness::new();
    h.seed_lifecycle();
    let first = saved(&h.s, req("move-scope", 1, "original")).await;
    let (started, gate) = wait_at(&h, "after_prepared_store");
    let mut moved = req("move-scope", 2, "new account");
    moved["accountId"] = json!("two");
    let s = h.s.clone();
    let (done, completed) = std::sync::mpsc::channel();
    let waiter = tokio::spawn(async move {
        let result = rpc(&s, "drafts.save", moved).await;
        let _ = done.send(result);
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), started).await.unwrap().unwrap();
    drop(waiter);
    let mut a = Some(h.s.account_lifecycle.try_close(lifecycle_lease("one"), "one").unwrap());
    let mut b = Some(h.s.account_lifecycle.try_close(lifecycle_lease("two"), "two").unwrap());
    let a_early = if let Ok(Ok(drained)) = tokio::time::timeout(std::time::Duration::from_millis(50),
        a.as_ref().unwrap().wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5))).await {
        a.as_mut().unwrap().mark_effects_started(drained).unwrap();
        a.take().unwrap().finish_retired().unwrap();
        true
    } else { false };
    let b_early = if let Ok(Ok(drained)) = tokio::time::timeout(std::time::Duration::from_millis(50),
        b.as_ref().unwrap().wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5))).await {
        b.as_mut().unwrap().mark_effects_started(drained).unwrap();
        b.take().unwrap().finish_retired().unwrap();
        true
    } else { false };
    let c = h.s.account_lifecycle.capture("three").unwrap();
    assert!(h.s.account_lifecycle.try_commit(&[c]).is_ok(), "unrelated C remains usable");
    release(gate);
    let result = completed.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    for claim in [a.take(), b.take()].into_iter().flatten() {
        let mut claim = claim;
        let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
    }
    let record = row(&h.s, "move-scope");
    let old = first["uid"].as_u64().unwrap() as u32;
    let old_file = message_store::read_raw(&h.s.data_dir, "one", first["mailbox"].as_str().unwrap(), old).unwrap().is_some();
    assert!(!a_early && !b_early && result.is_ok() && record.current.as_ref().is_some_and(|c| c.location().account_id == "two") && !old_file,
        "multi-account draft child escaped close: a_early={a_early} b_early={b_early} result={result:?} record={record:?} old_file={old_file}");
}

#[tokio::test]
async fn p3_draft_publication_unwind_releases_all_account_owners() {
    let h = Harness::new();
    saved(&h.s, req("unwind-scope", 1, "original")).await;
    h.hook(|point| {
        if point == "after_prepared_store" { panic!("injected actual draft publication unwind"); }
        Ok(())
    });
    let mut moved = req("unwind-scope", 2, "new account");
    moved["accountId"] = json!("two");
    let result = rpc(&h.s, "drafts.save", moved).await;
    h.clear();
    let record = row(&h.s, "unwind-scope");
    assert!(result.is_err() && record.pending.is_some() && record.current.as_ref().is_some_and(|c| c.location().account_id == "one"),
        "unwound draft lost retained COW evidence: result={result:?} record={record:?}");
    for id in ["one", "two"] {
        let mut claim = h.s.account_lifecycle.try_close(lifecycle_lease(id), id).expect("unwound actual child released account owner");
        let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
    }
}
#[tokio::test]
async fn drafts_real_save_readback_and_provenance_in_both_formats() {
    for format in [message_store::Format::Maildir, message_store::Format::Jmap] {
        let h = Harness::new();
        message_store::set_vault_format(&h.s.data_dir, format).unwrap();
        let v = saved(&h.s, req("roundtrip", 1, "offline words")).await;
        assert_eq!(v["entry"]["source"], "local_draft");
        assert_eq!(v["cleanup"], "complete");
        let list = rpc(
            &h.s,
            "drafts.list",
            json!({"accountId":"one","identity":loc(&v),"includeContent":true}),
        )
        .await
        .unwrap();
        assert!(list["drafts"][0]["eml"]["html"]
            .as_str()
            .unwrap()
            .contains("offline words"));
        assert_eq!(
            list["drafts"][0]["eml"]["bcc"][0]["address"],
            "blind@example.test"
        );
        assert_eq!(
            list["drafts"][0]["entry"]["references"],
            "<root@example.test> <parent@example.test>"
        );
    }
}
#[tokio::test]
async fn drafts_save_accepts_a_half_typed_recipient_and_a_later_revision_replaces_it() {
    let h = Harness::new();
    let reopened = |v: Value| {
        let h = &h;
        async move {
            let list = rpc(
                &h.s,
                "drafts.list",
                json!({"accountId":"one","identity":loc(&v),"includeContent":true}),
            )
            .await
            .unwrap();
            list["drafts"][0]["eml"].clone()
        }
    };
    let mut p = req("typing", 1, "body");
    p["snapshot"]["to"] = json!("prime@");
    p["snapshot"]["cc"] = json!("bad,");
    let first = saved(&h.s, p).await;
    assert_eq!(first["disposition"], "saved");
    let eml = reopened(first.clone()).await;
    assert_eq!(eml["to"][0]["address"], "prime@");
    assert_eq!(eml["cc"][0]["address"], "bad");
    assert_eq!(eml["bcc"][0]["address"], "blind@example.test");

    let mut p = req("typing", 2, "body");
    p["snapshot"]["to"] = json!("prime@example.test");
    let second = saved(&h.s, p).await;
    assert_eq!(second["disposition"], "saved");
    assert_eq!(second["revision"], 2);
    let eml = reopened(second).await;
    assert_eq!(eml["to"].as_array().unwrap().len(), 1);
    assert_eq!(eml["to"][0]["address"], "prime@example.test");
}
#[tokio::test]
async fn drafts_duplicate_revision_conflict_clear_and_zero_bytes() {
    let h = Harness::new();
    let p = req("edit", 1, "first");
    let first = saved(&h.s, p.clone()).await;
    let duplicate = saved(&h.s, p).await;
    assert_eq!(first["uid"], duplicate["uid"]);
    assert_eq!(duplicate["disposition"], "unchanged");
    assert!(rpc(&h.s, "drafts.save", req("edit", 1, "other"))
        .await
        .unwrap_err()
        .contains("conflict"));
    let mut p = req("edit", 2, "");
    p["snapshot"]["html"] = json!("");
    for f in ["to", "cc", "bcc", "inReplyTo", "references"] {
        p["snapshot"][f] = json!("");
    }
    p["snapshot"]["attachments"] =
        json!([{"filename":"empty","contentType":"application/octet-stream","content":""}]);
    let second = saved(&h.s, p).await;
    assert_ne!(first["uid"], second["uid"]);
    let raw = read_copy(&h.s, row(&h.s, "edit").current.as_ref().unwrap(), true)
        .unwrap()
        .unwrap();
    let parsed = mailvault_core::vault_eml::parse_eml_bytes(&raw, 1, vec![]).unwrap();
    assert!(parsed.to.is_empty());
    assert_eq!(parsed.attachments[0].content, "");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_slow_old_preparation_cannot_replace_new_revision() {
    let h = Harness::new();
    let (started, gate) = wait_preparation(&h);
    let s = h.s.clone();
    let old = tokio::spawn(async move { rpc(&s, "drafts.save", req("race", 1, "old")).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let latest = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        saved(&h.s, req("race", 2, "new")),
    )
    .await;
    release(gate);
    let latest = latest.unwrap();
    let old = old.await.unwrap().unwrap();
    assert_eq!(old["disposition"], "superseded");
    assert_eq!(row(&h.s, "race").revision, 2);
    assert_eq!(
        row(&h.s, "race").current.unwrap().identity.scope.uid,
        latest["uid"].as_u64().unwrap() as u32
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_discard_during_first_preparation_survives_restart() {
    let h = Harness::new();
    let (started, gate) = wait_preparation(&h);
    let s = h.s.clone();
    let old =
        tokio::spawn(
            async move { rpc(&s, "drafts.save", req("terminal", 1, "must not appear")).await },
        );
    tokio::time::timeout(std::time::Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let discarded = rpc(&h.s, "drafts.discard", json!({"draftId":"terminal"}))
        .await
        .unwrap();
    assert_eq!(discarded["cleanup"], "complete");
    release(gate);
    assert!(old.await.unwrap().is_err());
    h.clear();
    let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
    assert!(rpc(&reopened, "drafts.save", req("terminal", 99, "later"))
        .await
        .is_err());
    assert!(row(&reopened, "terminal").current.is_none());
}
#[tokio::test]
async fn drafts_custody_failure_keeps_recoverable_prepared_bytes_and_reuses_destination() {
    let h = Harness::new();
    let first = saved(&h.s, req("repair", 1, "old")).await;
    h.hook(|p| {
        if p == "after_bytes" {
            Err("injected custody unavailable".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("repair", 2, "new"))
        .await
        .is_err());
    let pending = row(&h.s, "repair");
    assert_eq!(
        pending.current.as_ref().unwrap().identity.scope.uid,
        first["uid"].as_u64().unwrap() as u32
    );
    let target = pending.pending.as_ref().unwrap().copy.identity.scope.uid;
    assert!(
        read_copy(&h.s, &pending.pending.as_ref().unwrap().prepared, false)
            .unwrap()
            .is_some()
    );
    h.clear();
    let repaired = saved(&h.s, req("repair", 2, "new")).await;
    assert_eq!(repaired["uid"], target);
    assert_eq!(repaired["cleanup"], "complete");
}
#[tokio::test]
async fn drafts_failed_account_destination_preserves_old_and_retry_reuses_one_target() {
    let h = Harness::new();
    let first = saved(&h.s, req("move", 1, "old")).await;
    h.hook(|p| {
        if p == "before_destination" {
            Err("destination unavailable".into())
        } else {
            Ok(())
        }
    });
    let mut p = req("move", 2, "new");
    p["accountId"] = json!("two");
    assert!(rpc(&h.s, "drafts.save", p.clone()).await.is_err());
    let r = row(&h.s, "move");
    let uid = r.pending.as_ref().unwrap().copy.identity.scope.uid;
    assert!(read_copy(&h.s, r.current.as_ref().unwrap(), true)
        .unwrap()
        .is_some());
    assert_eq!(
        r.current.unwrap().identity.scope.uid,
        first["uid"].as_u64().unwrap() as u32
    );
    h.clear();
    let second = saved(&h.s, p).await;
    assert_eq!(second["uid"], uid);
    assert_eq!(second["accountId"], "two");
}
#[tokio::test]
async fn drafts_failed_retirement_blocks_further_copy_growth_and_keeps_every_proof() {
    let h = Harness::new();
    saved(&h.s, req("bound", 1, "a")).await;
    h.hook(|p| {
        if p == "retire" {
            Err("retirement blocked".into())
        } else {
            Ok(())
        }
    });
    let mut p = req("bound", 2, "b");
    p["accountId"] = json!("two");
    let current = saved(&h.s, p).await;
    assert_eq!(current["cleanup"], "pending");
    let before = row(&h.s, "bound");
    let obligations: Vec<_> = before.cleanup.iter().map(|c| c.identity.clone()).collect();
    assert_eq!(obligations.len(), 1);
    for rev in [3, 4, 5] {
        assert!(rpc(&h.s, "drafts.save", req("bound", rev, "c"))
            .await
            .unwrap_err()
            .contains("cleanup pending"));
    }
    let after = row(&h.s, "bound");
    assert!(after.pending.is_none());
    assert_eq!(
        after.current.unwrap().identity.scope,
        before.current.unwrap().identity.scope
    );
    assert_eq!(
        after
            .cleanup
            .iter()
            .map(|c| c.identity.clone())
            .collect::<Vec<_>>(),
        obligations
    );
    h.clear();
    saved(&h.s, req("bound", 6, "finally")).await;
}
#[tokio::test]
async fn drafts_exact_replacement_is_never_deleted_or_overwritten() {
    let h = Harness::new();
    let saved = saved(&h.s, req("replace", 1, "original")).await;
    let copy = row(&h.s, "replace").current.unwrap();
    let l = copy.location();
    with_mailbox_write(&h.s, &l.account_id, &l.mailbox, |root| {
        vault_files::store(
            &h.s.vault_registry,
            root,
            &l.account_id,
            &l.mailbox,
            l.uid,
            b"Message-ID: <foreign@example.test>\r\n\r\nforeign",
            &drafts::FLAGS.map(String::from),
            true,
        )
    })
    .unwrap();
    let result = rpc(&h.s, "drafts.discard", json!({"draftId":"replace"}))
        .await
        .unwrap();
    assert_eq!(result["cleanup"], "pending");
    let raw = vault_files::read_eml(
        &h.s.vault_registry,
        &h.s.data_dir,
        "one",
        saved["mailbox"].as_str().unwrap(),
        l.uid,
    )
    .unwrap();
    assert!(raw.ends_with(b"foreign"));
    assert!(
        rpc(&h.s, "drafts.save", req("replace", 2, "no resurrection"))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn drafts_source_attachments_are_pinned_for_retry_and_missing_source_keeps_current() {
    let h = Harness::new();
    let mut original = req("source", 1, "source");
    original["snapshot"]["attachments"] = json!([{"filename":"source.bin","contentType":"application/octet-stream","content":"AAEC"}]);
    let source = saved(&h.s, original).await;
    saved(&h.s, req("target", 1, "old")).await;
    let mut target = req("target", 2, "with file");
    target["snapshot"]["attachments"] = json!([{"filename":"copy.bin","contentType":"application/octet-stream","source":{"accountId":"one","mailbox":source["mailbox"],"uid":source["uid"],"attachmentIndex":0}}]);
    h.hook(|p| {
        if p == "before_destination" {
            Err("offline disk".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", target.clone()).await.is_err());
    h.clear();
    rpc(&h.s, "drafts.discard", json!({"draftId":"source"}))
        .await
        .unwrap();
    let result = saved(&h.s, target).await;
    let current = row(&h.s, "target").current.unwrap();
    let raw = read_copy(&h.s, &current, true).unwrap().unwrap();
    assert_eq!(
        vault_files::attachments_of(&raw, &[0]).unwrap(),
        vec![Some("AAEC".into())]
    );
    let mut missing = req("target", 3, "missing");
    missing["snapshot"]["attachments"] = json!([{"filename":"gone","contentType":"application/octet-stream","source":{"accountId":"one","mailbox":"missing","uid":7,"attachmentIndex":0}}]);
    assert!(rpc(&h.s, "drafts.save", missing).await.is_err());
    assert_eq!(
        row(&h.s, "target").current.unwrap().identity.scope.uid,
        result["uid"].as_u64().unwrap() as u32
    );
}
#[tokio::test]
async fn drafts_legacy_adoption_is_exclusive_and_purpose_checked() {
    let h = Harness::new();
    let v = saved(&h.s, req("legacy-writer", 1, "legacy")).await;
    let original = row(&h.s, "legacy-writer").current.unwrap();
    app_db::with(&h.s.app_dir, |c| {
        c.execute("DELETE FROM local_draft_locations", []).unwrap();
        c.execute("DELETE FROM local_drafts", []).unwrap();
        Ok(())
    })
    .unwrap();
    let list = rpc(&h.s, "drafts.list", json!({"accountId":"one"}))
        .await
        .unwrap();
    assert_eq!(list["drafts"].as_array().unwrap().len(), 1);
    assert_eq!(list["drafts"][0]["disposition"], "unadopted");
    assert!(app_db::with(&h.s.app_dir, db::all).unwrap().is_empty());
    rpc(
        &h.s,
        "drafts.list",
        json!({"identity":loc(&v),"includeContent":true}),
    )
    .await
    .unwrap();
    let mut p = req("competing-adopter", 1, "other");
    p["previousIdentity"] = loc(&v);
    assert!(rpc(&h.s, "drafts.save", p).await.is_err());
    for source in ["local_sent", "server"] {
        custody::with_conn(&h.s, |c| {
            let mut entry = original.entry.clone();
            entry["source"] = json!(source);
            entries::upsert(c, "one", "Drafts", &[entry]).map(|_| ())
        })
        .unwrap();
        assert!(rpc(
            &h.s,
            "drafts.list",
            json!({"identity":loc(&v),"includeContent":true})
        )
        .await
        .is_err());
    }
}
#[tokio::test]
async fn drafts_actual_staged_send_and_scheduled_ownership_are_refused() {
    let h = Harness::new();
    let staged=rpc(&h.s,"compose.stage",json!({"accountId":"one","mailbox":"CustomSent","account":{"email":"one@example.test","imapHost":"offline.invalid"},"email":{"to":"next@example.test","subject":"staged","text":"staged"}})).await.unwrap();
    let l = json!({"accountId":"one","mailbox":"CustomSent","uid":staged["uid"]});
    let mut p = req("not-send", 1, "steal");
    p["previousIdentity"] = l;
    assert!(rpc(&h.s, "drafts.save", p)
        .await
        .unwrap_err()
        .contains("not an editable"));
    let actual = saved(&h.s, req("schedule-shape", 1, "frozen")).await;
    app_db::with(&h.s.app_dir, |c| {
        c.execute("DELETE FROM local_draft_locations", []).unwrap();
        c.execute("DELETE FROM local_drafts", []).unwrap();
        mailvault_core::app_db::scheduled::insert(
            c,
            "frozen",
            "one",
            actual["mailbox"].as_str().unwrap(),
            actual["uid"].as_u64().unwrap() as u32,
            "{}",
            "2026-10-26T12:00",
            "UTC",
            0,
        )
        .map(|_| ())
    })
    .unwrap();
    let mut p = req("not-scheduled", 1, "steal");
    p["previousIdentity"] = loc(&actual);
    assert!(rpc(&h.s, "drafts.save", p)
        .await
        .unwrap_err()
        .contains("scheduled"));
}
#[tokio::test]
async fn drafts_destination_publication_cannot_accept_replaced_custody() {
    let h = Harness::new();
    let s = h.s.clone();
    h.hook(move |point| {
        if point == "before_accept" {
            let pending = row(&s, "custody-race").pending.unwrap();
            let l = pending.copy.location();
            custody::with_conn(&s, |c| {
                let mut foreign = pending.copy.entry;
                foreign["source"] = json!("server");
                entries::upsert(c, &l.account_id, &l.mailbox, &[foreign]).map(|_| ())
            })?;
        }
        Ok(())
    });
    assert!(
        rpc(&h.s, "drafts.save", req("custody-race", 1, "user text"))
            .await
            .is_err()
    );
    assert!(row(&h.s, "custody-race").current.is_none());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_equal_revision_divergent_preparation_conflicts() {
    let h = Harness::new();
    let (started, gate) = wait_preparation(&h);
    let s = h.s.clone();
    let old =
        tokio::spawn(async move { rpc(&s, "drafts.save", req("equal-race", 1, "first")).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let accepted = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        saved(&h.s, req("equal-race", 1, "different")),
    )
    .await;
    release(gate);
    accepted.unwrap();
    assert!(old.await.unwrap().unwrap_err().contains("conflict"));
}
#[tokio::test]
async fn drafts_pending_publication_recovers_from_disk_after_state_reopen() {
    let h = Harness::new();
    saved(&h.s, req("restart", 1, "last good")).await;
    h.hook(|p| {
        if p == "before_accept" {
            Err("acceptance interrupted".into())
        } else {
            Ok(())
        }
    });
    assert!(
        rpc(&h.s, "drafts.save", req("restart", 2, "prepared words"))
            .await
            .is_err()
    );
    let pending = row(&h.s, "restart").pending.unwrap();
    let uid = pending.copy.identity.scope.uid;
    h.clear();
    crate::custody::close(&h.s);
    let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
    let result = saved(&reopened, req("restart", 2, "prepared words")).await;
    assert_eq!(result["uid"], uid);
    let raw = read_copy(
        &reopened,
        row(&reopened, "restart").current.as_ref().unwrap(),
        true,
    )
    .unwrap()
    .unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("prepared words"));
}
#[tokio::test]
async fn drafts_discard_cleans_pending_installed_copies_and_stays_terminal_after_reopen() {
    let h = Harness::new();
    saved(&h.s, req("discard-pending", 1, "old")).await;
    h.hook(|p| {
        if p == "after_bytes" {
            Err("custody unavailable".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("discard-pending", 2, "new"))
        .await
        .is_err());
    let before = row(&h.s, "discard-pending");
    let copies = vec![
        before.current.unwrap(),
        before.pending.as_ref().unwrap().copy.clone(),
        before.pending.unwrap().prepared,
    ];
    h.clear();
    let discarded = rpc(&h.s, "drafts.discard", json!({"draftId":"discard-pending"}))
        .await
        .unwrap();
    assert_eq!(discarded["cleanup"], "complete");
    for copy in copies {
        assert!(read_copy(&h.s, &copy, false).unwrap().is_none());
    }
    crate::custody::close(&h.s);
    let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
    assert!(rpc(
        &reopened,
        "drafts.save",
        req("discard-pending", 100, "late")
    )
    .await
    .unwrap_err()
    .contains("discarded"));
    assert!(row(&reopened, "discard-pending").discarded);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_preparation_leaves_foreground_heartbeat_and_metadata_reads_responsive() {
    let h = Harness::new();
    let (started, gate) = wait_preparation(&h);
    let s = h.s.clone();
    let pending =
        tokio::spawn(async move { rpc(&s, "drafts.save", req("foreground", 1, "slow")).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let heartbeat = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        rpc(&h.s, "daemon.heartbeat", json!({})),
    )
    .await;
    let listing = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        rpc(&h.s, "drafts.list", json!({"accountId":"one"})),
    )
    .await;
    release(gate);
    heartbeat.unwrap().unwrap();
    listing.unwrap().unwrap();
    pending.await.unwrap().unwrap();
}
#[tokio::test]
async fn drafts_partial_requests_have_no_draft_local_effects() {
    let h = Harness::new();
    for field in [
        "to",
        "cc",
        "bcc",
        "subject",
        "html",
        "text",
        "inReplyTo",
        "references",
        "attachments",
    ] {
        let mut value = req("partial", 1, "words");
        value["snapshot"].as_object_mut().unwrap().remove(field);
        let result = crate::server::handle_request_for_test(&h.s, "drafts.save", value).await;
        assert_eq!(result.error.unwrap().code, ipc::INVALID_PARAMS);
    }
    assert!(app_db::with(&h.s.app_dir, db::all).unwrap().is_empty());
    assert!(message_store::list(&h.s.data_dir, "one", PREPARED)
        .unwrap()
        .is_empty());
    assert!(message_store::list(&h.s.data_dir, "one", "Drafts")
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn drafts_never_installed_stage_failure_allows_same_revision_retry() {
    let h = Harness::new();
    let first = saved(&h.s, req("preinstall", 1, "last good")).await;
    h.hook(|p| {
        if p == "before_prepared_store" {
            Err("stage write unavailable".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("preinstall", 2, "same complete revision")
    )
    .await
    .is_err());
    let before = row(&h.s, "preinstall");
    assert_eq!(
        before.current.as_ref().unwrap().identity.scope.uid,
        first["uid"].as_u64().unwrap() as u32
    );
    assert!(
        read_copy(&h.s, &before.pending.as_ref().unwrap().prepared, false)
            .unwrap()
            .is_none()
    );
    h.clear();
    let _ = rpc(
        &h.s,
        "drafts.save",
        req("preinstall", 2, "same complete revision"),
    )
    .await;
    let result = saved(&h.s, req("preinstall", 2, "same complete revision")).await;
    assert_eq!(result["revision"], 2);
    assert!(row(&h.s, "preinstall").epoch > before.epoch);
}
#[tokio::test]
async fn drafts_preinstall_intent_reopen_keeps_same_revision_content_constraint() {
    let h = Harness::new();
    h.hook(|p| {
        if p == "before_prepared_store" {
            Err("stage absent".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("preinstall-restart", 1, "original")
    )
    .await
    .is_err());
    h.clear();
    crate::custody::close(&h.s);
    let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
    let _ = rpc(
        &reopened,
        "drafts.save",
        req("preinstall-restart", 1, "changed"),
    )
    .await;
    assert!(rpc(
        &reopened,
        "drafts.save",
        req("preinstall-restart", 1, "changed")
    )
    .await
    .is_err());
    let _ = rpc(
        &reopened,
        "drafts.save",
        req("preinstall-restart", 1, "original"),
    )
    .await;
    saved(&reopened, req("preinstall-restart", 1, "original")).await;
}
#[tokio::test]
async fn drafts_staged_receipt_remains_protected_after_archived_flag_patch() {
    let h = Harness::new();
    let staged=rpc(&h.s,"compose.stage",json!({"accountId":"one","mailbox":"CustomSent","account":{"email":"one@example.test","imapHost":"offline.invalid"},"email":{"to":"next@example.test","subject":"active staged send","text":"must stay"}})).await.unwrap();
    let uid = staged["uid"].as_u64().unwrap() as u32;
    let mut entry = staged["entry"].clone();
    entry["flags"] = json!(["archived", "seen", "draft"]);
    custody::with_conn(&h.s, |c| {
        entries::upsert(c, "one", "CustomSent", &[entry]).map(|_| ())
    })
    .unwrap();
    let metadata = rpc(&h.s, "drafts.list", json!({"accountId":"one"}))
        .await
        .unwrap();
    assert!(metadata["drafts"].as_array().unwrap().is_empty());
    let metadata = rpc(&h.s, "drafts.list", json!({"accountId":"one"}))
        .await
        .unwrap();
    assert!(metadata["drafts"].as_array().unwrap().is_empty());
    let raw = vault_files::read_eml(&h.s.vault_registry, &h.s.data_dir, "one", "CustomSent", uid)
        .unwrap();
    let scope = Scope::new(
        "one",
        "CustomSent",
        uid,
        staged["messageId"].as_str().unwrap(),
    )
    .unwrap();
    let history = app_db::with(&h.s.app_dir, |c| compose_receipts::load(c, &scope)).unwrap();
    let mut p = req("not-an-editor", 1, "overwrite");
    p["previousIdentity"] = json!({"accountId":"one","mailbox":"CustomSent","uid":uid});
    assert!(rpc(&h.s, "drafts.save", p).await.is_err());
    assert_eq!(
        vault_files::read_eml(&h.s.vault_registry, &h.s.data_dir, "one", "CustomSent", uid)
            .unwrap(),
        raw
    );
    assert_eq!(
        app_db::with(&h.s.app_dir, |c| compose_receipts::load(c, &scope)).unwrap(),
        history
    );
}

#[tokio::test]
async fn drafts_real_custody_write_error_retains_exact_repairable_intent() {
    let h = Harness::new();
    saved(&h.s, req("sql-custody", 1, "old")).await;
    custody::with_conn(&h.s, |c| c.execute_batch("CREATE TRIGGER reject_draft_row BEFORE INSERT ON vault_entries BEGIN SELECT RAISE(FAIL,'injected custody write failure'); END;").map_err(|e| e.to_string())).unwrap();
    assert!(rpc(&h.s, "drafts.save", req("sql-custody", 2, "new"))
        .await
        .is_err());
    let pending = row(&h.s, "sql-custody").pending.unwrap();
    assert!(read_copy(&h.s, &pending.prepared, false).unwrap().is_some());
    custody::with_conn(&h.s, |c| {
        c.execute_batch("DROP TRIGGER reject_draft_row")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    saved(&h.s, req("sql-custody", 2, "new")).await;
    assert_eq!(
        row(&h.s, "sql-custody").current.unwrap().identity,
        pending.copy.identity
    );
}

#[tokio::test]
async fn drafts_real_metadata_accept_error_keeps_last_good_and_exact_pending_copy() {
    let h = Harness::new();
    let first = saved(&h.s, req("sql-meta", 1, "old")).await;
    app_db::with(&h.s.app_dir, |c| c.execute_batch("CREATE TRIGGER reject_draft_accept BEFORE UPDATE ON local_drafts WHEN json_extract(NEW.state_json,'$.revision')=2 BEGIN SELECT RAISE(FAIL,'injected app.db write failure'); END;").map_err(|e| e.to_string())).unwrap();
    assert!(rpc(&h.s, "drafts.save", req("sql-meta", 2, "new"))
        .await
        .is_err());
    let record = row(&h.s, "sql-meta");
    assert_eq!(
        record.current.as_ref().unwrap().identity.scope.uid,
        first["uid"].as_u64().unwrap() as u32
    );
    let pending = record.pending.unwrap();
    app_db::with(&h.s.app_dir, |c| {
        c.execute_batch("DROP TRIGGER reject_draft_accept")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    saved(&h.s, req("sql-meta", 2, "new")).await;
    assert_eq!(
        row(&h.s, "sql-meta").current.unwrap().identity,
        pending.copy.identity
    );
}

#[tokio::test]
async fn drafts_default_legacy_listing_does_not_require_body_bytes() {
    let h = Harness::new();
    let result = saved(&h.s, req("legacy-missing", 1, "indexed words")).await;
    let copy = row(&h.s, "legacy-missing").current.unwrap();
    let location = copy.location();
    with_mailbox_write(&h.s, &location.account_id, &location.mailbox, |root| {
        vault_files::delete(
            &h.s.vault_registry,
            root,
            &location.account_id,
            &location.mailbox,
            location.uid,
        )
    })
    .unwrap();
    app_db::with(&h.s.app_dir, |c| {
        c.execute_batch("DELETE FROM local_draft_locations; DELETE FROM local_drafts;")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    let metadata = rpc(&h.s, "drafts.list", json!({"accountId":"one"}))
        .await
        .unwrap();
    assert_eq!(metadata["drafts"][0]["disposition"], "unadopted");
    assert!(app_db::with(&h.s.app_dir, db::all).unwrap().is_empty());
    let opened = rpc(
        &h.s,
        "drafts.list",
        json!({"identity":loc(&result),"includeContent":true}),
    )
    .await
    .unwrap();
    assert_eq!(opened["missingBody"], true);
    assert!(opened["drafts"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn drafts_actual_scheduled_and_staged_bytes_keep_bcc_send_policy() {
    let h = Harness::new();
    let account = json!({"email":"one@example.test","imapHost":"offline.invalid"});
    let email = json!({"to":"next@example.test","bcc":"blind@example.test","subject":"frozen","text":"frozen words"});
    let staged = rpc(
        &h.s,
        "compose.stage",
        json!({"accountId":"one","mailbox":"CustomSent","account":account,"email":email}),
    )
    .await
    .unwrap();
    let scheduled = rpc(&h.s, "scheduled.create", json!({"accountId":"one","account":account,"email":email,"localTime":"2030-01-01T12:00","tz":"UTC","fireAt":1893499200000u64})).await.unwrap();
    for (mailbox, uid) in [
        ("CustomSent", staged["uid"].as_u64().unwrap() as u32),
        ("Scheduled", scheduled["uid"].as_u64().unwrap() as u32),
    ] {
        let raw =
            vault_files::read_eml(&h.s.vault_registry, &h.s.data_dir, "one", mailbox, uid).unwrap();
        assert!(
            mailvault_core::vault_eml::parse_eml_bytes(&raw, uid, vec![])
                .unwrap()
                .bcc
                .is_empty()
        );
        let mut request = req("not-frozen", 1, "cannot adopt");
        request["previousIdentity"] = json!({"accountId":"one","mailbox":mailbox,"uid":uid});
        assert!(rpc(&h.s, "drafts.save", request).await.is_err());
        assert_eq!(
            vault_files::read_eml(&h.s.vault_registry, &h.s.data_dir, "one", mailbox, uid).unwrap(),
            raw
        );
    }
}

#[tokio::test]
async fn drafts_preinstall_first_transfer_survives_failure_and_conditional_db_error() {
    let h = Harness::new();
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("stage write failed".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("abort-gap", 1, "words"))
        .await
        .is_err());
    let original = row(&h.s, "abort-gap").pending.unwrap();
    h.hook(|point| {
        if point == "abort_stage_checked" {
            Err("crash between absence transfers".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("abort-gap", 1, "words"))
        .await
        .is_err());
    let retained = row(&h.s, "abort-gap");
    assert_eq!(
        retained.pending.as_ref().unwrap().attempt_id,
        original.attempt_id
    );
    assert!(retained
        .cleanup
        .iter()
        .any(|copy| copy.identity == original.prepared.identity));
    h.clear();
    app_db::with(&h.s.app_dir, |c| c.execute_batch("CREATE TRIGGER reject_abort BEFORE UPDATE ON local_drafts WHEN json_extract(NEW.state_json,'$.epoch')>json_extract(OLD.state_json,'$.epoch') BEGIN SELECT RAISE(FAIL,'conditional abort write failure'); END;").map_err(|e| e.to_string())).unwrap();
    assert!(rpc(&h.s, "drafts.save", req("abort-gap", 1, "words"))
        .await
        .is_err());
    assert_eq!(
        row(&h.s, "abort-gap").pending.as_ref().unwrap().attempt_id,
        original.attempt_id
    );
    app_db::with(&h.s.app_dir, |c| {
        c.execute_batch("DROP TRIGGER reject_abort")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    crate::custody::close(&h.s);
    let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
    assert!(rpc(&reopened, "drafts.save", req("abort-gap", 1, "words"))
        .await
        .is_err());
    assert_eq!(row(&reopened, "abort-gap").epoch, 1);
    assert!(row(&reopened, "abort-gap").pending.is_none());
    assert!(
        rpc(&reopened, "drafts.save", req("abort-gap", 1, "changed"))
            .await
            .unwrap_err()
            .contains("conflict")
    );
    saved(&reopened, req("abort-gap", 1, "words")).await;
}

#[tokio::test]
async fn drafts_preinstall_publication_after_first_absence_keeps_all_evidence() {
    let h = Harness::new();
    saved(&h.s, req("absence-race", 1, "last good")).await;
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("stage absent".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("absence-race", 2, "new"))
        .await
        .is_err());
    let old = row(&h.s, "absence-race");
    let pending = old.pending.as_ref().unwrap().clone();
    let state = h.s.clone();
    h.hook(move |point| {
        if point == "abort_stage_checked" {
            let prepared = row(&state, "absence-race").pending.unwrap().prepared;
            let location = prepared.location();
            with_mailbox_write(&state, &location.account_id, &location.mailbox, |root| {
                vault_files::store(&state.vault_registry, root, &location.account_id, &location.mailbox, location.uid, b"Message-ID: <foreign@example.test>\r\n\r\nforeign", &["seen".into()], true)
            })?;
            custody::with_conn(&state, |c| entries::upsert(c, &location.account_id, &location.mailbox, &[json!({"uid":location.uid,"source":"server","message_id":"foreign@example.test","flags":["seen"]})]).map(|_| ()))?;
        }
        Ok(())
    });
    assert!(rpc(&h.s, "drafts.save", req("absence-race", 2, "new"))
        .await
        .is_err());
    let after = row(&h.s, "absence-race");
    assert_eq!(after.pending.unwrap().attempt_id, pending.attempt_id);
    assert!(after
        .cleanup
        .iter()
        .any(|copy| copy.identity == pending.prepared.identity));
    assert_eq!(
        after.current.unwrap().identity,
        old.current.unwrap().identity
    );
    assert_eq!(after.epoch, old.epoch);
    let location = pending.prepared.location();
    assert!(message_store::read_raw(
        &h.s.data_dir,
        &location.account_id,
        &location.mailbox,
        location.uid
    )
    .unwrap()
    .unwrap()
    .ends_with(b"foreign"));
}

#[tokio::test]
async fn drafts_unreadable_or_changed_root_never_aborts_uninstalled_intent() {
    let h = Harness::new();
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("stage absent".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("unknown", 1, "words"))
        .await
        .is_err());
    let before = row(&h.s, "unknown").pending.unwrap();
    h.clear();
    let stage = before.prepared.location();
    let directory = message_store::mailbox_dir(&h.s.data_dir, &stage.account_id, &stage.mailbox);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("jmap"), b"not a readable message directory").unwrap();
    assert!(rpc(&h.s, "drafts.save", req("unknown", 1, "words"))
        .await
        .is_err());
    assert_eq!(
        row(&h.s, "unknown").pending.as_ref().unwrap().attempt_id,
        before.attempt_id
    );
    let different_root = h._dir.path().join("different-vault");
    std::fs::create_dir_all(&different_root).unwrap();
    let reopened = DaemonState::for_test(different_root, h.s.app_dir.clone(), true);
    assert!(rpc(&reopened, "drafts.save", req("unknown", 1, "words"))
        .await
        .is_err());
    assert_eq!(
        row(&reopened, "unknown")
            .pending
            .as_ref()
            .unwrap()
            .attempt_id,
        before.attempt_id
    );
}

#[tokio::test]
async fn drafts_jmap_backing_blob_recovers_exact_mime_without_repreparing_revision() {
    let h = Harness::new();
    message_store::set_vault_format(&h.s.data_dir, message_store::Format::Jmap).unwrap();
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("record install failed".into())
        } else {
            Ok(())
        }
    });
    assert!(
        rpc(&h.s, "drafts.save", req("backing", 1, "exact blob words"))
            .await
            .is_err()
    );
    let pending = row(&h.s, "backing").pending.unwrap();
    h.clear();
    saved(&h.s, req("backing", 1, "exact blob words")).await;
    let after = row(&h.s, "backing");
    assert_eq!(after.epoch, 0);
    assert_eq!(after.current.unwrap().identity, pending.copy.identity);
}

#[tokio::test]
async fn drafts_preinstall_abort_retires_only_exact_receipt_and_keeps_failure_evidence() {
    let h = Harness::new();
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("stage absent".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", req("receipt-abort", 1, "words"))
        .await
        .is_err());
    let pending = row(&h.s, "receipt-abort").pending.unwrap();
    let proof = Receipt::present(pending.prepared.identity.clone());
    app_db::with(&h.s.app_dir, |c| { compose_receipts::save(c, &proof)?; c.execute_batch("CREATE TRIGGER reject_retire BEFORE DELETE ON meta WHEN OLD.key LIKE 'compose_receipt:%' BEGIN SELECT RAISE(FAIL,'receipt retirement failure'); END;").map_err(|e| e.to_string()) }).unwrap();
    h.clear();
    assert!(rpc(&h.s, "drafts.save", req("receipt-abort", 1, "words"))
        .await
        .is_err());
    assert_eq!(
        row(&h.s, "receipt-abort")
            .pending
            .as_ref()
            .unwrap()
            .attempt_id,
        pending.attempt_id
    );
    assert_eq!(
        app_db::with(&h.s.app_dir, |c| compose_receipts::load(
            c,
            &proof.identity.scope
        ))
        .unwrap(),
        vec![proof.clone()]
    );
    app_db::with(&h.s.app_dir, |c| {
        c.execute_batch("DROP TRIGGER reject_retire")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(rpc(&h.s, "drafts.save", req("receipt-abort", 1, "words"))
        .await
        .is_err());
    saved(&h.s, req("receipt-abort", 1, "words")).await;
    assert!(app_db::with(&h.s.app_dir, |c| compose_receipts::load(
        c,
        &proof.identity.scope
    ))
    .unwrap()
    .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_old_preparation_epoch_cannot_publish_after_abort_or_discard() {
    for terminal in [false, true] {
        let h = Harness::new();
        let (started, gate) = wait_preparation(&h);
        let original_hook = HOOKS.lock().unwrap().get(&h.s.app_dir).unwrap().clone();
        let fail_once = std::sync::atomic::AtomicBool::new(true);
        h.hook(move |point| {
            original_hook(point)?;
            if point == "before_prepared_store"
                && fail_once.swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err("drained pre-install writer failed".into());
            }
            Ok(())
        });
        let state = h.s.clone();
        let old = tokio::spawn(async move {
            rpc(&state, "drafts.save", req("attempt-epoch", 1, "same words")).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(10), started)
            .await
            .unwrap()
            .unwrap();
        assert!(
            rpc(&h.s, "drafts.save", req("attempt-epoch", 1, "same words"))
                .await
                .is_err()
        );
        let aborted = rpc(&h.s, "drafts.save", req("attempt-epoch", 1, "same words")).await;
        assert!(aborted.is_err());
        let epoch = row(&h.s, "attempt-epoch").epoch;
        if terminal {
            rpc(&h.s, "drafts.discard", json!({"draftId":"attempt-epoch"}))
                .await
                .unwrap();
        }
        release(gate);
        assert!(old.await.unwrap().is_err());
        assert_eq!(epoch, 1);
        assert!(row(&h.s, "attempt-epoch").current.is_none());
        h.clear();
        if terminal {
            assert!(
                rpc(&h.s, "drafts.save", req("attempt-epoch", 1, "same words"))
                    .await
                    .is_err()
            );
        } else {
            saved(&h.s, req("attempt-epoch", 1, "same words")).await;
        }
    }
}

#[tokio::test]
async fn drafts_aborted_source_revision_rejects_changed_or_missing_bytes_then_accepts_exact_retry()
{
    let h = Harness::new();
    let mut source_request = req("mutable-source", 1, "original source");
    source_request["snapshot"]["attachments"] = json!([{"filename":"source.bin","contentType":"application/octet-stream","content":"AAEC"}]);
    let source = saved(&h.s, source_request).await;
    let source_copy = row(&h.s, "mutable-source").current.unwrap();
    let source_location = source_copy.location();
    let original_raw = read_copy(&h.s, &source_copy, true).unwrap().unwrap();
    let first = saved(&h.s, req("source-retry", 1, "last good")).await;
    let mut target = req("source-retry", 2, "with source");
    target["snapshot"]["attachments"] = json!([{"filename":"copy.bin","contentType":"application/octet-stream","source":{"accountId":"one","mailbox":source["mailbox"],"uid":source["uid"],"attachmentIndex":0}}]);
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("stage absent".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(&h.s, "drafts.save", target.clone()).await.is_err());
    h.clear();
    assert!(rpc(&h.s, "drafts.save", target.clone()).await.is_err());
    assert!(row(&h.s, "source-retry").retry.is_some());
    let mut changed = req("mutable-source", 2, "changed source");
    changed["snapshot"]["attachments"] = json!([{"filename":"source.bin","contentType":"application/octet-stream","content":"AwIB"}]);
    let config = account(&h.s, "one", "alias@example.test", "Alias").unwrap();
    let changed = Save::parse(changed).unwrap();
    let changed_raw = smtp::build_local_draft_mime(&config, &changed.outgoing().unwrap()).unwrap();
    with_mailbox_write(
        &h.s,
        &source_location.account_id,
        &source_location.mailbox,
        |root| {
            vault_files::store(
                &h.s.vault_registry,
                root,
                &source_location.account_id,
                &source_location.mailbox,
                source_location.uid,
                &changed_raw,
                &drafts::FLAGS.map(String::from),
                true,
            )
        },
    )
    .unwrap();
    assert!(rpc(&h.s, "drafts.save", target.clone())
        .await
        .unwrap_err()
        .contains("conflict"));
    with_mailbox_write(
        &h.s,
        &source_location.account_id,
        &source_location.mailbox,
        |root| {
            vault_files::delete(
                &h.s.vault_registry,
                root,
                &source_location.account_id,
                &source_location.mailbox,
                source_location.uid,
            )
        },
    )
    .unwrap();
    assert!(rpc(&h.s, "drafts.save", target.clone()).await.is_err());
    assert_eq!(
        row(&h.s, "source-retry")
            .current
            .unwrap()
            .identity
            .scope
            .uid,
        first["uid"].as_u64().unwrap() as u32
    );
    with_mailbox_write(
        &h.s,
        &source_location.account_id,
        &source_location.mailbox,
        |root| {
            vault_files::store(
                &h.s.vault_registry,
                root,
                &source_location.account_id,
                &source_location.mailbox,
                source_location.uid,
                &original_raw,
                &drafts::FLAGS.map(String::from),
                true,
            )
        },
    )
    .unwrap();
    saved(&h.s, target).await;
}

#[tokio::test]
async fn drafts_malformed_or_absent_native_account_never_replaces_last_good_content() {
    let h = Harness::new();
    let first = saved(&h.s, req("native-account", 1, "last good")).await;
    for document in ["{broken", "[]"] {
        std::fs::write(h.s.app_dir.join("accounts.json"), document).unwrap();
        assert!(rpc(&h.s, "drafts.save", req("native-account", 2, "new"))
            .await
            .is_err());
        let state = row(&h.s, "native-account");
        assert!(state.pending.is_none());
        assert_eq!(
            state.current.unwrap().identity.scope.uid,
            first["uid"].as_u64().unwrap() as u32
        );
    }
}

#[tokio::test]
async fn drafts_current_mailbox_stays_fixed_when_native_cached_role_changes() {
    let h = Harness::new();
    let first = saved(&h.s, req("fixed-mailbox", 1, "first")).await;
    custody::with_conn(&h.s, |c| {
        cache::save_mailboxes(
            c,
            "one",
            &json!([{"path":"NewDrafts","specialUse":"\\Drafts"}]).to_string(),
        )
    })
    .unwrap();
    let second = saved(&h.s, req("fixed-mailbox", 2, "second")).await;
    assert_eq!(second["mailbox"], first["mailbox"]);
}

#[tokio::test]
async fn drafts_native_contract_stable_id_reopens_current_and_rejects_wrong_tuple() {
    for format in [message_store::Format::Maildir, message_store::Format::Jmap] {
        let h = Harness::new();
        message_store::set_vault_format(&h.s.data_dir, format).unwrap();
        let old = saved(&h.s, req("stable-native-open", 1, "old words")).await;
        let mut current_request = req("stable-native-open", 2, "current words");
        current_request["snapshot"]["to"] =
            json!("\"Doe, Jane\" <jane@example.test>, next@example.test");
        let current = saved(&h.s, current_request).await;
        assert_ne!(old["uid"], current["uid"]);
        let opened = rpc(
            &h.s,
            "drafts.list",
            json!({"draftId":"stable-native-open","includeContent":true}),
        )
        .await
        .unwrap();
        assert_eq!(opened["drafts"][0]["uid"], current["uid"]);
        assert_eq!(
            opened["drafts"][0]["eml"]["to"][0]["address"],
            "jane@example.test"
        );
        assert_eq!(
            opened["drafts"][0]["eml"]["to"][1]["address"],
            "next@example.test"
        );
        assert!(opened["drafts"][0]["eml"]["html"]
            .as_str()
            .unwrap()
            .contains("current words"));
        assert!(rpc(
            &h.s,
            "drafts.list",
            json!({"draftId":"stable-native-open","identity":loc(&old),"includeContent":true})
        )
        .await
        .is_err());
        let old_location: Location = serde_json::from_value(loc(&old)).unwrap();
        with_mailbox_write(
            &h.s,
            &old_location.account_id,
            &old_location.mailbox,
            |root| {
                vault_files::store(
                    &h.s.vault_registry,
                    root,
                    &old_location.account_id,
                    &old_location.mailbox,
                    old_location.uid,
                    b"Message-ID: <foreign-reuse@example.test>\r\n\r\nforeign",
                    &["archived".into()],
                    true,
                )
            },
        )
        .unwrap();
        custody::with_conn(&h.s, |c| entries::upsert(c, &old_location.account_id, &old_location.mailbox, &[json!({"uid":old_location.uid,"source":"server","message_id":"foreign-reuse@example.test","flags":["archived"]})]).map(|_| ())).unwrap();
        assert!(rpc(
            &h.s,
            "drafts.list",
            json!({"draftId":"stable-native-open","identity":loc(&old),"includeContent":true})
        )
        .await
        .is_err());
        let other = saved(&h.s, req("other-native-draft", 1, "other")).await;
        assert!(rpc(
            &h.s,
            "drafts.list",
            json!({"draftId":"stable-native-open","identity":loc(&other),"includeContent":true})
        )
        .await
        .is_err());
        crate::custody::close(&h.s);
        let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
        let opened = rpc(
            &reopened,
            "drafts.list",
            json!({"draftId":"stable-native-open","includeContent":true}),
        )
        .await
        .unwrap();
        assert_eq!(opened["drafts"][0]["uid"], current["uid"]);
        assert_eq!(
            opened["drafts"][0]["eml"]["to"][0]["address"],
            "jane@example.test"
        );
        assert_eq!(
            opened["drafts"][0]["eml"]["to"][1]["address"],
            "next@example.test"
        );
        rpc(
            &reopened,
            "drafts.discard",
            json!({"draftId":"stable-native-open"}),
        )
        .await
        .unwrap();
        let terminal = rpc(
            &reopened,
            "drafts.list",
            json!({"draftId":"stable-native-open","includeContent":true}),
        )
        .await
        .unwrap();
        assert_eq!(terminal["terminal"], true);
        assert!(terminal["drafts"].as_array().unwrap().is_empty());
    }
}

#[tokio::test]
async fn drafts_native_contract_pending_recovery_requires_current_account() {
    let h = Harness::new();
    let configured = std::fs::read(h.s.app_dir.join("accounts.json")).unwrap();
    saved(&h.s, req("recover-account", 1, "last good")).await;
    h.hook(|point| {
        if point == "before_destination" {
            Err("destination unavailable".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("recover-account", 2, "prepared words")
    )
    .await
    .is_err());
    h.clear();
    let pending = row(&h.s, "recover-account").pending.unwrap();
    let destination = pending.copy.location();
    for document in [Some("[]"), Some("{broken"), None] {
        match document {
            Some(value) => std::fs::write(h.s.app_dir.join("accounts.json"), value).unwrap(),
            None => std::fs::remove_file(h.s.app_dir.join("accounts.json")).unwrap(),
        }
        let error = rpc(
            &h.s,
            "drafts.save",
            req("recover-account", 2, "prepared words"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("account"));
        assert_eq!(
            row(&h.s, "recover-account")
                .pending
                .as_ref()
                .unwrap()
                .attempt_id,
            pending.attempt_id
        );
        assert!(message_store::read_raw(
            &h.s.data_dir,
            &destination.account_id,
            &destination.mailbox,
            destination.uid
        )
        .unwrap()
        .is_none());
    }
    std::fs::write(h.s.app_dir.join("accounts.json"), configured).unwrap();
    saved(&h.s, req("recover-account", 2, "prepared words")).await;
    assert_eq!(
        row(&h.s, "recover-account").current.unwrap().identity,
        pending.copy.identity
    );
    std::fs::remove_file(h.s.app_dir.join("accounts.json")).unwrap();
    let discarded = rpc(&h.s, "drafts.discard", json!({"draftId":"recover-account"}))
        .await
        .unwrap();
    assert_eq!(discarded["cleanup"], "complete");
}

#[tokio::test]
async fn drafts_stable_id_reports_pending_terminal_and_missing_without_blank_content() {
    let h = Harness::new();
    h.hook(|point| {
        if point == "before_destination" {
            Err("pending destination".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("pending-native-open", 1, "recoverable words")
    )
    .await
    .is_err());
    let metadata = rpc(
        &h.s,
        "drafts.list",
        json!({"draftId":"pending-native-open"}),
    )
    .await
    .unwrap();
    assert_eq!(metadata["pending"], true);
    assert!(metadata["drafts"].as_array().unwrap().is_empty());
    let content = rpc(
        &h.s,
        "drafts.list",
        json!({"draftId":"pending-native-open","includeContent":true}),
    )
    .await
    .unwrap();
    assert_eq!(content["pending"], true);
    assert_eq!(content["missingBody"], false);
    assert!(content["drafts"].as_array().unwrap().is_empty());
    let missing = rpc(
        &h.s,
        "drafts.list",
        json!({"draftId":"unknown-native-open","includeContent":true}),
    )
    .await
    .unwrap();
    assert_eq!(missing["missingBody"], true);
    h.clear();
    std::fs::remove_file(h.s.app_dir.join("accounts.json")).unwrap();
    let discarded = rpc(
        &h.s,
        "drafts.discard",
        json!({"draftId":"pending-native-open"}),
    )
    .await
    .unwrap();
    assert_eq!(discarded["cleanup"], "complete");
    let terminal = rpc(
        &h.s,
        "drafts.list",
        json!({"draftId":"pending-native-open","includeContent":true}),
    )
    .await
    .unwrap();
    assert_eq!(terminal["terminal"], true);
    assert!(terminal["drafts"].as_array().unwrap().is_empty());
}

async fn foreign_custody_before_install(point: &'static str, stage: bool) {
    let h = Harness::new();
    saved(&h.s, req("preinstall-foreign", 1, "accepted words")).await;
    let prior = row(&h.s, "preinstall-foreign").current.unwrap();
    let prior_raw = read_copy(&h.s, &prior, true).unwrap().unwrap();
    let s = h.s.clone();
    h.hook(move |at| {
        if at == point {
            let pending = row(&s, "preinstall-foreign").pending.unwrap();
            let copy = if stage {
                pending.prepared
            } else {
                pending.copy
            };
            let l = copy.location();
            custody::with_conn(&s, |c| {
                entries::upsert(
                    c,
                    &l.account_id,
                    &l.mailbox,
                    &[json!({
                        "uid":l.uid,"message_id":"<foreign@example.test>",
                        "source":"server","flags":["seen"]
                    })],
                )
                .map(|_| ())
            })?;
        }
        Ok(())
    });
    let result = rpc(
        &h.s,
        "drafts.save",
        req("preinstall-foreign", 2, "new words"),
    )
    .await;
    let after = row(&h.s, "preinstall-foreign");
    let pending = after.pending.as_ref().expect("exact intent retained");
    let copy = if stage {
        &pending.prepared
    } else {
        &pending.copy
    };
    let l = copy.location();
    assert!(
        message_store::read_raw(&h.s.data_dir, &l.account_id, &l.mailbox, l.uid)
            .unwrap()
            .is_none(),
        "foreign custody-only tuple received draft bytes"
    );
    assert!(result.is_err());
    assert_eq!(after.revision, 1);
    assert_eq!(after.current.as_ref().unwrap().identity, prior.identity);
    assert_eq!(read_copy(&h.s, &prior, true).unwrap().unwrap(), prior_raw);
    assert_eq!(
        custody::with_conn(&h.s, |c| entries::get(c, &l.account_id, &l.mailbox, l.uid))
            .unwrap()
            .unwrap()["source"],
        "server"
    );
}

#[tokio::test]
async fn drafts_review_stage_refuses_foreign_custody_before_bytes() {
    foreign_custody_before_install("before_prepared_store", true).await;
}

#[tokio::test]
async fn drafts_review_destination_refuses_foreign_custody_before_bytes() {
    foreign_custody_before_install("before_destination", false).await;
}

#[tokio::test]
async fn drafts_review_higher_aborted_fingerprint_survives_lower_revision_and_reopen() {
    let h = Harness::new();
    saved(&h.s, req("aborted-higher", 1, "accepted one")).await;
    h.hook(|point| {
        if point == "before_prepared_store" {
            Err("stage unavailable".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("aborted-higher", 3, "frozen three")
    )
    .await
    .is_err());
    h.clear();
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("aborted-higher", 3, "frozen three")
    )
    .await
    .is_err());
    assert_eq!(row(&h.s, "aborted-higher").retry.unwrap().revision, 3);
    // Either defer revision 2 or accept it while retaining revision 3's constraint.
    let _ = rpc(
        &h.s,
        "drafts.save",
        req("aborted-higher", 2, "intervening two"),
    )
    .await;
    crate::custody::close(&h.s);
    let reopened = DaemonState::for_test(h.s.data_dir.clone(), h.s.app_dir.clone(), true);
    assert!(
        rpc(
            &reopened,
            "drafts.save",
            req("aborted-higher", 3, "changed three")
        )
        .await
        .is_err(),
        "intervening revision erased the higher fingerprint"
    );
    assert_eq!(row(&reopened, "aborted-higher").retry.unwrap().revision, 3);
    let accepted = saved(&reopened, req("aborted-higher", 3, "frozen three")).await;
    assert_eq!(accepted["revision"], 3);
}

#[tokio::test]
async fn drafts_review_stable_id_rejects_absent_tracked_tuple() {
    let h = Harness::new();
    saved(&h.s, req("absent-association", 1, "current words")).await;
    h.hook(|point| {
        if point == "before_destination" {
            Err("destination unavailable".into())
        } else {
            Ok(())
        }
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("absent-association", 2, "pending words")
    )
    .await
    .is_err());
    let pending = row(&h.s, "absent-association").pending.unwrap();
    let l = pending.copy.location();
    let exact = json!({"accountId":l.account_id,"mailbox":l.mailbox,"uid":l.uid});
    assert!(
        rpc(
            &h.s,
            "drafts.list",
            json!({"draftId":"absent-association", "identity":exact,"includeContent":true})
        )
        .await
        .is_err(),
        "absent pending tuple silently resolved accepted content"
    );
    let stable = rpc(
        &h.s,
        "drafts.list",
        json!({"draftId":"absent-association","includeContent":true}),
    )
    .await
    .unwrap();
    assert!(stable["drafts"][0]["eml"]["html"]
        .as_str()
        .unwrap()
        .contains("current words"));
}

async fn foreign_receipt_before_install(
    point: &'static str,
    after: &'static str,
    stage: bool,
    state: compose_receipts::State,
    same_mid: bool,
) {
    let h = Harness::new();
    saved(&h.s, req("preinstall-receipt", 1, "accepted words")).await;
    let prior = row(&h.s, "preinstall-receipt").current.unwrap();
    let prior_raw = read_copy(&h.s, &prior, true).unwrap().unwrap();
    let s = h.s.clone();
    h.hook(move |at| {
        if at == point {
            let pending = row(&s, "preinstall-receipt").pending.unwrap();
            let copy = if stage {
                pending.prepared
            } else {
                pending.copy
            };
            let mut scope = copy.identity.scope.clone();
            scope.message_id = "<foreign-receipt@example.test>".into();
            let raw = b"Message-ID: <foreign-receipt@example.test>\r\n\r\nforeign";
            let identity = if same_mid {
                copy.identity
            } else {
                Identity::from_bytes(scope, raw).unwrap()
            };
            let mut receipt = Receipt::present(identity);
            receipt.state = state;
            app_db::with(&s.app_dir, |c| compose_receipts::save(c, &receipt))?;
        }
        if at == after {
            return Err("observe immediately after install".into());
        }
        Ok(())
    });
    assert!(rpc(
        &h.s,
        "drafts.save",
        req("preinstall-receipt", 2, "new words")
    )
    .await
    .is_err());
    let pending = row(&h.s, "preinstall-receipt").pending.unwrap();
    let copy = if stage {
        pending.prepared
    } else {
        pending.copy
    };
    let l = copy.location();
    assert!(
        message_store::read_raw(&h.s.data_dir, &l.account_id, &l.mailbox, l.uid)
            .unwrap()
            .is_none(),
        "different-MID receipt tuple received draft bytes"
    );
    assert_eq!(
        row(&h.s, "preinstall-receipt").current.unwrap().identity,
        prior.identity
    );
    assert_eq!(read_copy(&h.s, &prior, true).unwrap().unwrap(), prior_raw);
    let mut foreign_scope = copy.identity.scope;
    if !same_mid {
        foreign_scope.message_id = "<foreign-receipt@example.test>".into();
    }
    let history =
        app_db::with(&h.s.app_dir, |c| compose_receipts::load(c, &foreign_scope)).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].state, state);
}

#[tokio::test]
async fn drafts_review_receipts_stage_refuses_different_mid_before_bytes() {
    for state in [
        compose_receipts::State::Present,
        compose_receipts::State::Cleaned,
    ] {
        for same_mid in [false, true] {
            foreign_receipt_before_install(
                "before_prepared_store",
                "after_prepared_store",
                true,
                state,
                same_mid,
            )
            .await;
        }
    }
}

#[tokio::test]
async fn drafts_review_receipts_destination_refuses_different_mid_before_bytes() {
    for state in [
        compose_receipts::State::Present,
        compose_receipts::State::Cleaned,
    ] {
        for same_mid in [false, true] {
            foreign_receipt_before_install(
                "before_destination",
                "after_bytes",
                false,
                state,
                same_mid,
            )
            .await;
        }
    }
}

#[tokio::test]
async fn drafts_review_receipt_inventory_commit_before_install_is_unresolved() {
    for stage in [true, false] {
        let h = Harness::new();
        saved(&h.s, req("receipt-version", 1, "accepted words")).await;
        let prior = row(&h.s, "receipt-version").current.unwrap();
        let s = h.s.clone();
        h.hook(move |point| {
            let target = if stage {
                "after_prepared_receipt_inventory"
            } else {
                "after_destination_receipt_inventory"
            };
            if point == target {
                app_db::with(&s.app_dir, |c| {
                    app_db::db::meta_set(c, "unrelated-commit", "new value")
                })?;
            }
            Ok(())
        });
        assert!(
            rpc(&h.s, "drafts.save", req("receipt-version", 2, "new words"))
                .await
                .is_err()
        );
        let record = row(&h.s, "receipt-version");
        let pending = record.pending.unwrap();
        let copy = if stage {
            pending.prepared
        } else {
            pending.copy
        };
        let l = copy.location();
        assert!(
            message_store::read_raw(&h.s.data_dir, &l.account_id, &l.mailbox, l.uid)
                .unwrap()
                .is_none()
        );
        assert_eq!(record.current.unwrap().identity, prior.identity);
    }
}

#[tokio::test]
async fn drafts_review_install_refuses_scheduled_ownership_and_invalid_receipt_history() {
    for stage in [true, false] {
        for evidence in ["scheduled", "malformed", "future", "mismatched-key"] {
            let h = Harness::new();
            saved(&h.s, req("purpose-preinstall", 1, "accepted words")).await;
            let prior = row(&h.s, "purpose-preinstall").current.unwrap();
            let s = h.s.clone();
            h.hook(move |point| {
                let before = if stage {
                    "before_prepared_store"
                } else {
                    "before_destination"
                };
                if point == before {
                    let pending = row(&s, "purpose-preinstall").pending.unwrap();
                    let copy = if stage {
                        pending.prepared
                    } else {
                        pending.copy
                    };
                    let l = copy.location();
                    app_db::with(&s.app_dir, |c| {
                        if evidence == "scheduled" {
                            mailvault_core::app_db::scheduled::insert(
                                c,
                                "scheduled-owner",
                                &l.account_id,
                                &l.mailbox,
                                l.uid,
                                "{}",
                                "2026-10-26T12:00",
                                "UTC",
                                0,
                            )?;
                        } else {
                            let proof = Receipt::present(copy.identity);
                            compose_receipts::save(c, &proof)?;
                            let mut invalid = proof;
                            let value = match evidence {
                                "malformed" => "{broken".to_string(),
                                "future" => {
                                    invalid.version = 42;
                                    serde_json::to_string(&invalid).unwrap()
                                }
                                _ => {
                                    invalid.identity.scope.uid += 1;
                                    serde_json::to_string(&invalid).unwrap()
                                }
                            };
                            c.execute(
                                "UPDATE meta SET value=?1 WHERE key LIKE 'compose_receipt:%'",
                                [value],
                            )
                            .map_err(|e| e.to_string())?;
                        }
                        Ok(())
                    })?;
                }
                Ok(())
            });
            assert!(
                rpc(
                    &h.s,
                    "drafts.save",
                    req("purpose-preinstall", 2, "new words")
                )
                .await
                .is_err(),
                "{stage}/{evidence}"
            );
            let record = row(&h.s, "purpose-preinstall");
            let pending = record.pending.unwrap();
            let copy = if stage {
                pending.prepared
            } else {
                pending.copy
            };
            let l = copy.location();
            assert!(
                message_store::read_raw(&h.s.data_dir, &l.account_id, &l.mailbox, l.uid)
                    .unwrap()
                    .is_none(),
                "{stage}/{evidence}"
            );
            assert_eq!(record.current.unwrap().identity, prior.identity);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_review_large_private_receipt_inventory_leaves_shared_work_responsive() {
    let h = Harness::new();
    app_db::with(&h.s.app_dir, |c| {
        let transaction = c.unchecked_transaction().map_err(|e| e.to_string())?;
        for uid in 1..=2048 {
            let raw = b"Message-ID: <history@example.test>\r\n\r\nhistory";
            let scope = Scope::new("one", "Unrelated", uid, "history@example.test").unwrap();
            compose_receipts::save(
                &transaction,
                &Receipt::present(Identity::from_bytes(scope, raw).unwrap()),
            )?;
        }
        transaction.commit().map_err(|e| e.to_string())
    })
    .unwrap();
    let (tx, started) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let pause = gate.clone();
    h.hook(move |point| {
        if point == "after_prepared_receipt_inventory" {
            let notify = { tx.lock().unwrap().take() };
            if let Some(tx) = notify {
                let _ = tx.send(());
                let mut ready = pause.0.lock().unwrap();
                while !*ready {
                    let (next, timeout) = pause
                        .1
                        .wait_timeout(ready, std::time::Duration::from_secs(10))
                        .unwrap();
                    ready = next;
                    if timeout.timed_out() {
                        return Err("private inventory pause timed out".into());
                    }
                }
            }
        }
        Ok(())
    });
    let s = h.s.clone();
    let pending =
        tokio::spawn(
            async move { rpc(&s, "drafts.save", req("receipt-foreground", 1, "words")).await },
        );
    tokio::time::timeout(std::time::Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    let heartbeat = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        rpc(&h.s, "daemon.heartbeat", json!({})),
    )
    .await;
    let s = h.s.clone();
    let work = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::task::spawn_blocking(move || {
            with_mailbox_write(&s, "one", "Unrelated", |_| {
                custody::with_conn(&s, |c| entries::get(c, "one", "Unrelated", 1).map(|_| ()))?;
                app_db::with(&s.app_dir, |c| {
                    app_db::db::meta_set(c, "foreground", "complete")
                })
            })
        }),
    )
    .await;
    release(gate);
    heartbeat.unwrap().unwrap();
    work.unwrap().unwrap().unwrap();
    assert!(pending.await.unwrap().is_err());
    h.clear();
    let _ = rpc(&h.s, "drafts.save", req("receipt-foreground", 1, "words")).await;
    saved(&h.s, req("receipt-foreground", 1, "words")).await;
}


#[tokio::test]
async fn drafts_conditional_cleanup_keeps_higher_accepted_bytes() {
    let h = Harness::new();
    saved(&h.s, req("conditional-accepted", 1, "sent one")).await;
    saved(&h.s, req("conditional-accepted", 2, "newer two")).await;
    let before = serde_json::to_value(row(&h.s, "conditional-accepted")).unwrap();
    let outcome = rpc(&h.s, "drafts.discard", json!({"draftId":"conditional-accepted","throughRevision":1})).await.unwrap();
    assert_eq!(outcome["discarded"], false);
    assert_eq!(outcome["reason"], "newer_revision");
    assert_eq!(serde_json::to_value(row(&h.s, "conditional-accepted")).unwrap(), before);
    assert!(String::from_utf8(read_copy(&h.s, row(&h.s, "conditional-accepted").current.as_ref().unwrap(), true).unwrap().unwrap()).unwrap().contains("newer two"));
    assert_eq!(rpc(&h.s, "drafts.discard", json!({"draftId":"conditional-accepted"})).await.unwrap()["discarded"], true);
}
#[tokio::test]
async fn drafts_conditional_cleanup_keeps_higher_pending_and_retry_claims() {
    for point in ["after_bytes", "before_prepared_store"] {
        let h = Harness::new();
        saved(&h.s, req("conditional-intent", 1, "accepted one")).await;
        h.hook(move |actual| if actual == point { Err("injected higher save failure".into()) } else { Ok(()) });
        assert!(rpc(&h.s, "drafts.save", req("conditional-intent", 3, "retained three")).await.is_err());
        h.clear();
        // An uninstalled failed intent becomes the existing durable retry
        // constraint when its normal recovery boundary rejects that retry.
        if point == "before_prepared_store" {
            assert!(rpc(&h.s, "drafts.save", req("conditional-intent", 3, "retained three")).await.is_err());
        }
        let before = serde_json::to_value(row(&h.s, "conditional-intent")).unwrap();
        if point == "after_bytes" { assert_eq!(before["pending"]["revision"], 3); }
        else { assert_eq!(before["retry"]["revision"], 3); }
        let outcome = rpc(&h.s, "drafts.discard", json!({"draftId":"conditional-intent","throughRevision":1})).await.unwrap();
        assert_eq!(outcome["discarded"], false);
        assert_eq!(outcome["reason"], "newer_revision");
        assert_eq!(serde_json::to_value(row(&h.s, "conditional-intent")).unwrap(), before);
    }
}
#[tokio::test]
async fn drafts_conditional_cleanup_rejects_malformed_bound_without_effects() {
    for bound in [json!(null), json!(-1), json!(1.5), json!("1"), json!(9007199254740992_u64)] {
        let h = Harness::new();
        saved(&h.s, req("conditional-invalid", 1, "keep words")).await;
        assert!(rpc(&h.s, "drafts.discard", json!({"draftId":"conditional-invalid","throughRevision":bound})).await.is_err());
        assert!(!row(&h.s, "conditional-invalid").discarded);
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drafts_conditional_cleanup_fences_higher_preparation_and_is_idempotent() {
    let h = Harness::new();
    saved(&h.s, req("conditional-race", 1, "sent one")).await;
    let (started, gate) = wait_preparation(&h);
    let state = h.s.clone();
    let higher = tokio::spawn(async move { rpc(&state, "drafts.save", req("conditional-race", 2, "unpublished two")).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), started).await.unwrap().unwrap();
    let outcome = rpc(&h.s, "drafts.discard", json!({"draftId":"conditional-race","throughRevision":1})).await.unwrap();
    release(gate);
    assert_eq!(outcome["discarded"], true);
    assert!(higher.await.unwrap().is_err());
    assert_eq!(rpc(&h.s, "drafts.discard", json!({"draftId":"conditional-race","throughRevision":1})).await.unwrap()["cleanup"], "complete");
}
