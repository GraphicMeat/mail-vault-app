//! Selection answers were produced by the real JS manager on a remote runner.
use mailvault_core::bulk::{self, Action, Coordinator, FrozenIntent, Mailbox, Scope};
use mailvault_core::op_journal;
use serde_json::{json, Value};

fn scope(keys: Value) -> Scope {
    serde_json::from_value(json!({"accountId":"acc1", "mailbox":"INBOX", "spans":false, "keys":keys})).unwrap()
}
fn intent(keys: Value) -> FrozenIntent {
    FrozenIntent::freeze(Action::Delete, scope(keys), &["acc1".into(), "acc2".into()], &[])
}
fn legacy() -> Value {
    json!({"id":"old", "type":"delete", "accountId":"acc1", "mailbox":"INBOX", "totalUids":["acc1:Work:Clients:7", "acc2:Sent:8"], "completedUids":["acc1:Work:Clients:7"], "status":"deleting", "currentPhase":"delete", "unknownEvidence":{"keep":true}})
}

#[test]
fn grouping_matches_actual_js_without_narrowing_invalid_integers() {
    let corpus: Value = serde_json::from_str(include_str!("fixtures/bulk-operation-cases.json")).unwrap();
    for case in corpus["grouping"].as_array().unwrap() {
        if case["name"] == "numeric-boundaries" { continue; }
        let mut raw = case["scope"].clone();
        raw["keys"] = case["keys"].clone();
        let parsed: Scope = serde_json::from_value(raw).unwrap();
        let grouped = bulk::group_targets(&parsed);
        assert_eq!(serde_json::to_value(grouped).unwrap(), json!({"groups":case["groups"], "refused":case["refused"]}), "{}", case["name"]);
    }
    let grouped = bulk::group_targets(&scope(json!([0, -1, 4294967295u64, 4294967296u64, 1.5, "9007199254740992"])));
    assert_eq!(serde_json::to_value(grouped).unwrap(), json!({"groups":[{"accountId":"acc1","mailbox":"INBOX","uids":[0,4294967295u64]}],"refused":[-1,4294967296u64,1.5,"9007199254740992"]}));
}

#[test]
fn frozen_selection_counts_unknown_and_local_targets_separately() {
    let frozen = FrozenIntent::freeze(Action::Archive, scope(json!([1, "missing:INBOX:2", "acc1:Local:3", "acc1:INBOX:1", "bad"])), &["acc1".into()], &[Mailbox { account_id: "acc1".into(), mailbox: "Local".into() }]);
    assert_eq!(frozen.target_keys(), vec![json!("acc1:INBOX:1")]);
    assert_eq!(frozen.skipped(), 2);
    assert_eq!(frozen.skipped_local(), 1);
    let everywhere = FrozenIntent::freeze(Action::DeleteEverywhere, scope(json!([1, "acc1:Sent:8", 1])), &[], &[]);
    assert_eq!(everywhere.target_keys(), vec![json!(1), json!("acc1:Sent:8"), json!(1)]);
}

#[test]
fn legacy_recovery_keeps_evidence_and_requires_fresh_identity() {
    let dir = tempfile::tempdir().unwrap();
    let raw = legacy();
    op_journal::pending_operation_save(dir.path(), &raw).unwrap();
    let mut owner = Coordinator::load(dir.path());
    let status = owner.status(dir.path()).unwrap();
    assert_eq!(status["active"], Value::Null);
    assert_eq!(status["pending"]["status"], "awaitingResume");
    assert_eq!(status["pending"]["remaining"], 1);
    let plan = owner.resume_plan(dir.path(), "old").unwrap();
    assert_eq!(plan.keys, vec![json!("acc2:Sent:8")]);
    assert!(plan.requires_fresh_identity);
    assert_eq!(plan.operation, Action::Delete);
    assert_eq!(op_journal::pending_operation_read(dir.path()).unwrap(), Some(raw));
    assert!(owner.resume_plan(dir.path(), "stale").is_err());
}

#[test]
fn frozen_intent_is_durable_before_single_owner_accepts_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let selected = intent(json!([1, "acc2:Sent:8"]));
    let first = owner.claim(dir.path(), "new", selected.clone()).unwrap();
    assert_eq!(owner.claim(dir.path(), "new", selected.clone()).unwrap(), first);
    assert!(owner.claim(dir.path(), "new", intent(json!([2]))).is_err());
    assert!(owner.claim(dir.path(), "other", selected).is_err());
    let record = op_journal::pending_operation_read(dir.path()).unwrap().unwrap();
    assert_eq!(record["schemaVersion"], 1);
    assert_eq!(record["totalUids"], json!(["acc1:INBOX:1", "acc2:Sent:8"]));
    assert_eq!(owner.status(dir.path()).unwrap()["active"]["id"], "new");
    assert_eq!(owner.status(dir.path()).unwrap()["pending"], Value::Null);
    assert!(owner.discard(dir.path(), "new").is_err());
    let mut restarted = Coordinator::load(dir.path());
    let snapshot = restarted.status(dir.path()).unwrap();
    assert_eq!(snapshot["active"], Value::Null);
    assert_eq!(snapshot["pending"]["remaining"], 2);
    assert!(restarted.resume_plan(dir.path(), "new").unwrap().requires_fresh_identity);
}

#[test]
fn discard_is_matching_and_corruption_never_becomes_empty() {
    let dir = tempfile::tempdir().unwrap();
    op_journal::pending_operation_save(dir.path(), &legacy()).unwrap();
    let mut owner = Coordinator::load(dir.path());
    assert!(owner.discard(dir.path(), "newer").is_err());
    assert_eq!(op_journal::pending_operation_read(dir.path()).unwrap(), Some(legacy()));
    owner.discard(dir.path(), "old").unwrap();
    assert_eq!(op_journal::pending_operation_read(dir.path()).unwrap(), None);
    for corrupt in [json!({"id":"corrupt"}), json!({"schemaVersion":99,"id":"future"})] {
        op_journal::pending_operation_save(dir.path(), &corrupt).unwrap();
        let mut broken = Coordinator::load(dir.path());
        assert!(broken.status(dir.path()).is_err());
        assert!(broken.discard(dir.path(), "corrupt").is_err());
        assert!(broken.claim(dir.path(), "replacement", intent(json!([1]))).is_err());
        assert_eq!(op_journal::pending_operation_read(dir.path()).unwrap(), Some(corrupt));
    }
}

#[test]
fn all_completed_legacy_and_unknown_accounts_do_not_widen_resume() {
    let dir = tempfile::tempdir().unwrap();
    let mut raw = legacy();
    raw["completedUids"] = raw["totalUids"].clone();
    op_journal::pending_operation_save(dir.path(), &raw).unwrap();
    let mut owner = Coordinator::load(dir.path());
    assert!(owner.resume_plan(dir.path(), "old").unwrap().keys.is_empty());
    assert_eq!(owner.status(dir.path()).unwrap()["pending"]["remaining"], 0);
    raw["completedUids"] = json!([]);
    raw["totalUids"] = json!(["missing:Sent:9"]);
    op_journal::pending_operation_save(dir.path(), &raw).unwrap();
    assert_eq!(owner.resume_plan(dir.path(), "old").unwrap().keys, vec![json!("missing:Sent:9")]);
}

#[test]
fn legacy_resume_selection_matches_real_manager_answers() {
    let corpus: Value = serde_json::from_str(include_str!("fixtures/bulk-operation-cases.json")).unwrap();
    for case in corpus["runs"].as_array().unwrap() {
        if case["resumeInput"].is_null() { continue; }
        let dir = tempfile::tempdir().unwrap();
        op_journal::pending_operation_save(dir.path(), &case["resumeInput"]).unwrap();
        let mut owner = Coordinator::load(dir.path());
        let plan = owner.resume_plan(dir.path(), case["resumeInput"]["id"].as_str().unwrap()).unwrap();
        let frozen = FrozenIntent::freeze(plan.operation, Scope { account_id: Some("acc1".into()), mailbox: Some("INBOX".into()), spans: false, keys: plan.keys }, &["acc1".into(), "acc2".into()], &[]);
        let expected = case["pending"].as_array().unwrap().first().map(|p| p["totalUids"].clone()).unwrap_or_else(|| json!([]));
        assert_eq!(serde_json::to_value(frozen.target_keys()).unwrap(), expected, "{}", case["name"]);
        assert!(plan.requires_fresh_identity);
    }
}

#[test]
fn all_five_frozen_actions_match_actual_initial_persistence() {
    let corpus: Value = serde_json::from_str(include_str!("fixtures/bulk-operation-cases.json")).unwrap();
    for case in corpus["runs"].as_array().unwrap() {
        if !case["resumeInput"].is_null() { continue; }
        let action: Action = serde_json::from_value(case["type"].clone()).unwrap();
        let frozen = FrozenIntent::freeze(action, scope(case["keys"].clone()), &["acc1".into(), "acc2".into()], &[Mailbox { account_id:"acc1".into(), mailbox:"Local".into() }]);
        assert_eq!(serde_json::to_value(frozen.target_keys()).unwrap(), case["pending"][0]["totalUids"], "{}", case["name"]);
        assert_eq!(json!(frozen.skipped()), case["snapshots"][0]["skipped"], "{}", case["name"]);
        assert_eq!(json!(frozen.skipped_local()), case["snapshots"][0]["skippedLocal"], "{}", case["name"]);
    }
}

#[test]
fn large_selection_keeps_order_and_exact_legacy_key_types() {
    let count = 20_000u32;
    let keys: Vec<Value> = (0..count).chain((0..count).rev()).map(|uid| json!(uid)).collect();
    let grouped = bulk::group_targets(&scope(json!(keys)));
    assert_eq!(grouped.groups.len(), 1);
    assert_eq!(grouped.groups[0].uids, (0..count).collect::<Vec<_>>());
    let dir = tempfile::tempdir().unwrap();
    let mut raw = legacy();
    raw["totalUids"] = json!((0..count).map(|uid| json!(uid)).chain([json!("1"), json!("acc1:INBOX:1")]).collect::<Vec<_>>());
    raw["completedUids"] = json!((0..count).step_by(2).collect::<Vec<_>>());
    op_journal::pending_operation_save(dir.path(), &raw).unwrap();
    let mut owner = Coordinator::load(dir.path());
    let plan = owner.resume_plan(dir.path(), "old").unwrap();
    let expected: Vec<Value> = (1..count).step_by(2).map(|uid| json!(uid)).chain([json!("1"), json!("acc1:INBOX:1")]).collect();
    assert_eq!(plan.keys, expected);
    assert_eq!(owner.status(dir.path()).unwrap()["pending"]["remaining"], count / 2 + 2);
}

#[test]
fn worker_checkpoints_keep_cross_folder_exact_outcomes_and_pending_choice() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!(["acc1:INBOX:7", "acc2:Sent:7"]));
    owner.claim(dir.path(), "exact", intent.clone()).unwrap();
    let mut work = mailvault_core::bulk_worker::Workflow::new(intent);
    work.phase = "delete".into();
    work.status = "deleting".into();
    work.groups[0].attempted = vec![7];
    work.groups[0].deleted = vec![7];
    owner.checkpoint(dir.path(), "exact", &work).unwrap();
    let mut restarted = Coordinator::load(dir.path());
    let status = restarted.status(dir.path()).unwrap();
    assert_eq!(status["pending"]["completed"], 1);
    assert_eq!(status["pending"]["remaining"], 1);
    let pending = op_journal::pending_operation_read(dir.path())
        .unwrap()
        .unwrap();
    assert_eq!(pending["completedUids"], json!(["acc1:INBOX:7"]));
    assert_eq!(pending["totalUids"], json!(["acc1:INBOX:7", "acc2:Sent:7"]));
    let resumed = restarted.resume_worker(dir.path(), "exact").unwrap();
    assert_eq!(resumed.groups[0].deleted, vec![7]);
    assert!(resumed.groups[1].deleted.is_empty());
}
#[test]
fn malformed_worker_evidence_is_retained_by_status_and_discard() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!([7]));
    owner
        .claim(dir.path(), "broken-worker", intent.clone())
        .unwrap();
    let mut raw = op_journal::pending_operation_read(dir.path())
        .unwrap()
        .unwrap();
    let mut work = mailvault_core::bulk_worker::Workflow::new(intent);
    work.groups[0].attempted = vec![999];
    raw["worker"] = json!(work);
    op_journal::pending_operation_save(dir.path(), &raw).unwrap();
    let mut restarted = Coordinator::load(dir.path());
    assert!(restarted.status(dir.path()).is_err());
    assert!(restarted.discard(dir.path(), "broken-worker").is_err());
    assert_eq!(
        op_journal::pending_operation_read(dir.path())
            .unwrap()
            .unwrap(),
        raw
    );
}
#[test]
fn duplicate_terminal_kickoff_attaches_without_new_worker_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!([]));
    owner.claim(dir.path(), "terminal", intent.clone()).unwrap();
    let mut work = mailvault_core::bulk_worker::Workflow::new(intent.clone());
    work.status = "complete".into();
    owner.checkpoint(dir.path(), "terminal", &work).unwrap();
    owner.drained("terminal").unwrap();
    assert_eq!(
        owner.claim(dir.path(), "terminal", intent).unwrap()["status"],
        "complete"
    );
    assert!(owner.active_id().is_none());
}

#[test]
fn reviewed_all_provider_maps_roundtrip_through_real_coordinator_storage() {
 use mailvault_core::bulk_worker::{Identity,Workflow};use std::collections::HashMap;
 for identity in [Identity::Imap{validity:1,message_ids:HashMap::from([(7,"selected@test".into())])},Identity::Jmap{mailbox_id:"mb".into(),ids:HashMap::from([(7,"email-id".into())])},Identity::Graph{ids:HashMap::from([(7,"graph-id".into())])}] {
  let dir=tempfile::tempdir().unwrap();let mut owner=Coordinator::load(dir.path());let intent=intent(json!([7]));owner.claim(dir.path(),"persist",intent.clone()).unwrap();let mut work=Workflow::new(intent);work.groups[0].identity=Some(identity.clone());work.groups[0].origin=Some("native-origin".into());owner.checkpoint(dir.path(),"persist",&work).unwrap();
  assert_eq!(owner.status(dir.path()).unwrap()["active"]["id"],"persist");let mut restarted=Coordinator::load(dir.path());assert_eq!(restarted.resume_worker(dir.path(),"persist").unwrap().groups[0].identity,Some(identity));
 }
}

#[test]
fn admission_fence_blocks_both_unregistered_and_already_freezing_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    owner.fence_admission("late", "unseen").unwrap();
    assert!(owner.begin_admission("late", "unseen").is_err());
    assert!(owner
        .claim_attempt(dir.path(), "late", "unseen", intent(json!([])))
        .is_err());
    assert!(owner.begin_admission("freezing", "seen").unwrap().is_none());
    owner.fence_admission("freezing", "seen").unwrap();
    assert!(owner
        .claim_attempt(dir.path(), "freezing", "seen", intent(json!([])))
        .is_err());
    assert!(op_journal::pending_operation_read(dir.path())
        .unwrap()
        .is_none());
}
#[test]
fn earlier_drained_attempt_cannot_drain_a_resumed_execution() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!([]));
    owner.begin_admission("same", "first").unwrap();
    owner
        .claim_attempt(dir.path(), "same", "first", intent.clone())
        .unwrap();
    let mut work = mailvault_core::bulk_worker::Workflow::new(intent);
    work.status = "error".into();
    owner.checkpoint(dir.path(), "same", &work).unwrap();
    owner.drained_attempt("same", "first").unwrap();
    owner.begin_admission("same", "second").unwrap();
    owner
        .resume_worker_attempt(dir.path(), "same", "second")
        .unwrap();
    assert!(owner.drained_attempt("same", "first").is_err());
    assert_eq!(
        owner.status(dir.path()).unwrap()["active"]["attemptId"],
        "second"
    );
    assert_eq!(owner.admission_receipt("same", "first")["state"], "done");
}

#[test]
fn prepared_checkpoint_rejects_old_revision_and_attempt_before_write() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!([7]));
    owner.claim_attempt(dir.path(), "owned", "A", intent.clone()).unwrap();
    let work = mailvault_core::bulk_worker::Workflow::new(intent);
    let first = owner.checkpoint_seed("owned", "A").unwrap().prepare(&work).unwrap();
    let stale = owner.checkpoint_seed("owned", "A").unwrap().prepare(&work).unwrap();
    owner.validate_checkpoint(&first).unwrap();
    first.persist(dir.path()).unwrap();
    owner.publish_checkpoint(&first).unwrap();
    assert!(owner.validate_checkpoint(&stale).is_err());
    let old_attempt = owner.checkpoint_seed("owned", "A").unwrap().prepare(&work).unwrap();
    owner.drained_attempt("owned", "A").unwrap();
    owner.resume_worker_attempt(dir.path(), "owned", "B").unwrap();
    assert!(owner.validate_checkpoint(&old_attempt).is_err());
    assert!(owner.checkpoint_seed("owned", "A").is_err());
    assert_eq!(op_journal::pending_operation_read(dir.path()).unwrap().unwrap()["attemptId"], "B");
}

#[test]
fn prepared_checkpoint_failure_keeps_committed_state_and_durable_restart_proof() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!([7]));
    owner.claim_attempt(dir.path(), "owned", "A", intent.clone()).unwrap();
    let mut work = mailvault_core::bulk_worker::Workflow::new(intent);
    work.phase = "delete".into();
    work.status = "deleting".into();
    work.groups[0].attempted = vec![7];
    let prepared = owner.checkpoint_seed("owned", "A").unwrap().prepare(&work).unwrap();
    let blocked = dir.path().join("not-directory");
    std::fs::write(&blocked, "blocked").unwrap();
    assert!(prepared.persist(&blocked).is_err());
    assert_eq!(owner.status(dir.path()).unwrap()["active"]["status"], "starting");
    owner.validate_checkpoint(&prepared).unwrap();
    prepared.persist(dir.path()).unwrap();
    // Crash after durable commit, before publication: restart owns the new
    // attempted uncertainty and never starts any work automatically.
    let mut restarted = Coordinator::load(dir.path());
    assert_eq!(restarted.status(dir.path()).unwrap()["pending"]["status"], "awaitingResume");
    assert_eq!(restarted.resume_worker_attempt(dir.path(), "owned", "B").unwrap().groups[0].attempted, vec![7]);
}

#[test]
fn exact_duplicate_start_attaches_without_resampling_removed_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut owner = Coordinator::load(dir.path());
    let intent = intent(json!([7]));
    owner.claim_attempt(dir.path(), "owned", "A", intent.clone()).unwrap();
    let mut work = mailvault_core::bulk_worker::Workflow::new(intent);
    work.status = "complete".into();
    owner.checkpoint(dir.path(), "owned", &work).unwrap();
    owner.drained_attempt("owned", "A").unwrap();
    assert_eq!(owner.duplicate_start("owned", Action::Delete, &scope(json!([7]))).unwrap().unwrap()["status"], "complete");
    assert!(owner.duplicate_start("owned", Action::Archive, &scope(json!([7]))).is_err());
    assert!(owner.duplicate_start("owned", Action::Delete, &scope(json!([8]))).is_err());
    assert!(owner.active_id().is_none());
}

#[test]
fn prepared_resume_fences_before_and_during_write_without_reusing_old_base() {
    let dir=tempfile::tempdir().unwrap();
    let mut owner=Coordinator::load(dir.path());
    let intent=intent(json!([]));
    owner.claim_attempt(dir.path(),"restore","A",intent.clone()).unwrap();
    owner.checkpoint(dir.path(),"restore",&mailvault_core::bulk_worker::Workflow::new(intent)).unwrap();
    owner.drained_attempt("restore","A").unwrap();
    owner.begin_admission("restore","before").unwrap();
    let before=owner.resume_seed("restore","before").unwrap().prepare().unwrap();
    owner.fence_admission("restore","before").unwrap();
    assert!(owner.validate_resume(&before).is_err());
    assert_eq!(op_journal::pending_operation_read(dir.path()).unwrap().unwrap()["attemptId"],"A");
    owner.begin_admission("restore","during").unwrap();
    let during=owner.resume_seed("restore","during").unwrap().prepare().unwrap();
    owner.validate_resume(&during).unwrap();
    during.persist(dir.path()).unwrap();
    owner.fence_admission("restore","during").unwrap();
    assert!(owner.publish_resume(&during).is_err());
    let status=owner.owned_status().unwrap().unwrap();
    assert!(status["active"].is_null());
    assert_eq!(status["pending"]["attemptId"],"during");
    assert_eq!(owner.admission_receipt("restore","during")["state"],"fenced");
    assert!(owner.validate_resume(&before).is_err());
    let mut reopened=Coordinator::load(dir.path());
    assert_eq!(reopened.status(dir.path()).unwrap()["pending"]["attemptId"],"during");
    owner.begin_admission("restore","fresh").unwrap();
    let fresh=owner.resume_seed("restore","fresh").unwrap().prepare().unwrap();
    owner.validate_resume(&fresh).unwrap();
    fresh.persist(dir.path()).unwrap();
    assert_eq!(owner.publish_resume(&fresh).unwrap()["attemptId"],"fresh");
    assert!(owner.validate_resume(&during).is_err());
}

#[test]
fn failed_resume_save_requires_fresh_disk_evidence_before_another_seed() {
    let dir=tempfile::tempdir().unwrap();
    let mut owner=Coordinator::load(dir.path());
    let intent=intent(json!([]));
    owner.claim_attempt(dir.path(),"restore","A",intent.clone()).unwrap();
    owner.checkpoint(dir.path(),"restore",&mailvault_core::bulk_worker::Workflow::new(intent)).unwrap();
    owner.drained_attempt("restore","A").unwrap();
    let prepared=owner.resume_seed("restore","B").unwrap().prepare().unwrap();
    let blocked=dir.path().join("not-dir"); std::fs::write(&blocked,"blocked").unwrap();
    assert!(prepared.persist(&blocked).is_err());
    owner.invalidate_pending();
    assert!(owner.owned_status().is_none());
    assert!(owner.resume_seed("restore","C").is_err());
    let read=Coordinator::read_pending(dir.path());
    owner.install_pending(&read).unwrap();
    assert_eq!(owner.owned_status().unwrap().unwrap()["pending"]["attemptId"],"A");
    assert!(owner.resume_seed("restore","C").is_ok());
}
