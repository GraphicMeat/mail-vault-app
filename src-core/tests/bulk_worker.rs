use mailvault_core::bulk::{Action, FrozenIntent, Group, Scope};
use mailvault_core::bulk_worker::{self, ArchiveOutcome, CopyProof, Identity, Ports, Workflow};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Default)]
struct Fake {
    trace: Vec<Value>,
    checkpoints: Vec<Workflow>,
    copies: usize,
    missing: Option<u32>,
    drive_gone_at: Option<usize>,
    fail_checkpoint_at: Option<usize>,
    cancel_copy: Option<Arc<AtomicBool>>,
    stray: bool,
    fail_after_delete: bool,
    copy_partition: bool,
    fail_stage: Option<&'static str>,
}
impl Ports for Fake {
    async fn checkpoint(&mut self, w: &Workflow) -> Result<(), String> {
        if self.fail_after_delete && self.trace.last().is_some_and(|e| e["effect"] == "delete") {
            return Err("disk full after remote reply".into());
        }
        if self.fail_checkpoint_at == Some(self.checkpoints.len() + 1) {
            return Err("disk full".into());
        }
        self.checkpoints.push(w.clone());
        Ok(())
    }
    async fn identity(&mut self, g: &Group) -> Result<Identity, String> {
        Ok(Identity::Imap {
            validity: 1,
            message_ids: g.uids.iter().map(|u| (*u, format!("<{u}@test>"))).collect(),
        })
    }
    async fn archive(
        &mut self,
        g: &Group,
        _cancel: Arc<AtomicBool>,
    ) -> Result<ArchiveOutcome, String> {
        if self.fail_stage == Some("archive") {
            return Err("archive failed".into());
        }
        self.trace.push(json!({"effect":"archive","accountId":g.account_id,"mailbox":g.mailbox,"uids":g.uids,"background":true}));
        Ok(ArchiveOutcome::default())
    }
    async fn verify(&mut self, g: &Group, _identity: &Identity) -> Result<Vec<u32>, String> {
        if self.fail_stage == Some("verify") {
            return Err("verify failed".into());
        }
        self.trace.push(
            json!({"effect":"verify","accountId":g.account_id,"mailbox":g.mailbox,"uids":g.uids}),
        );
        let mut v: Vec<_> = g
            .uids
            .iter()
            .copied()
            .filter(|u| Some(*u) != self.missing)
            .collect();
        if self.stray {
            v.extend([9999, 9999]);
        }
        Ok(v)
    }
    async fn copy(&mut self, g: &Group, uids: &[u32]) -> Result<CopyProof, String> {
        self.trace.push(
            json!({"effect":"copy","accountId":g.account_id,"mailbox":g.mailbox,"uids":uids}),
        );
        self.copies += 1;
        if let Some(c) = &self.cancel_copy {
            c.store(true, Ordering::SeqCst);
        }
        if self.drive_gone_at == Some(self.copies) {
            return Err("drive gone".into());
        }
        if self.copy_partition {
            return Ok(CopyProof {
                verified: vec![1, 1, 9999],
                mismatched: vec![2, 3],
                missing: vec![3, 4],
            });
        }
        Ok(CopyProof {
            verified: uids.to_vec(),
            ..Default::default()
        })
    }
    async fn delete(
        &mut self,
        g: &Group,
        uids: &[u32],
        _identity: &Identity,
        bin: bool,
        _cancel: Arc<AtomicBool>,
    ) -> Result<Vec<u32>, String> {
        if self.fail_stage == Some("delete") {
            return Err("delete failed".into());
        }
        self.trace.push(json!({"effect":"delete","accountId":g.account_id,"mailbox":g.mailbox,"uids":uids,"bin":bin}));
        Ok(uids.to_vec())
    }
}
fn work(action: Action, keys: Vec<Value>) -> Workflow {
    Workflow::new(FrozenIntent::freeze(
        action,
        Scope {
            account_id: Some("acc1".into()),
            mailbox: Some("INBOX".into()),
            spans: false,
            keys,
        },
        &["acc1".into(), "acc2".into()],
        &[],
    ))
}
async fn run(w: &mut Workflow, f: &mut Fake) -> Result<(), String> {
    bulk_worker::run(f, w, Arc::new(AtomicBool::new(false)), false).await
}
#[tokio::test]
async fn four_mode_effect_order_matches_actual_manager_fixture() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/bulk-operation-cases.json")).unwrap();
    for (name, action) in [
        ("archive", Action::Archive),
        ("delete", Action::Delete),
        ("archive_and_delete", Action::ArchiveAndDelete),
        ("archive_backup_delete", Action::ArchiveBackupDelete),
    ] {
        let c = fixture["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let mut w = work(action, c["keys"].as_array().unwrap().clone());
        let mut f = Fake::default();
        run(&mut w, &mut f).await.unwrap();
        let expected: Vec<_> = c["trace"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["effect"] != "clear")
            .cloned()
            .collect();
        let actual: Vec<_> = f
            .trace
            .into_iter()
            .filter(|e| action != Action::Archive || e["effect"] != "verify")
            .collect();
        assert_eq!(actual, expected, "{name}");
        assert_eq!(w.status, "complete");
    }
}
#[tokio::test]
async fn lost_drive_keeps_prior_proved_batches_only() {
    let mut w = work(
        Action::ArchiveBackupDelete,
        (1..=201).map(|u| json!(u)).collect(),
    );
    let mut f = Fake {
        drive_gone_at: Some(2),
        ..Default::default()
    };
    run(&mut w, &mut f).await.unwrap();
    assert_eq!(
        f.trace
            .iter()
            .filter(|e| e["effect"] == "copy")
            .map(|e| e["uids"].as_array().unwrap().len())
            .collect::<Vec<_>>(),
        vec![100, 100]
    );
    assert_eq!(w.result.removed, 100);
    assert_eq!(w.result.kept_backup_unreachable, 101);
    assert!(f
        .trace
        .iter()
        .filter(|e| e["effect"] == "delete")
        .flat_map(|e| e["uids"].as_array().unwrap())
        .all(|u| u.as_u64().unwrap() <= 100));
}
#[tokio::test]
async fn cancellation_drains_copy_before_no_more_effects() {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut w = work(Action::ArchiveBackupDelete, vec![json!(1)]);
    let mut f = Fake {
        cancel_copy: Some(cancel.clone()),
        ..Default::default()
    };
    bulk_worker::run(&mut f, &mut w, cancel, false)
        .await
        .unwrap();
    assert_eq!(w.status, "cancelled");
    assert!(!f.trace.iter().any(|e| e["effect"] == "delete"));
}
#[tokio::test]
async fn stray_duplicate_proofs_cannot_widen_frozen_selection() {
    let mut w = work(Action::ArchiveBackupDelete, vec![json!(1), json!(2)]);
    let mut f = Fake {
        stray: true,
        missing: Some(2),
        ..Default::default()
    };
    run(&mut w, &mut f).await.unwrap();
    assert_eq!(w.result.removed, 1);
    assert_eq!(w.result.kept_not_archived, 1);
    assert_eq!(w.groups[0].deleted, vec![1]);
}
#[tokio::test]
async fn checkpoint_failure_prevents_next_effect() {
    let mut w = work(Action::Delete, vec![json!(1)]);
    let mut f = Fake {
        fail_checkpoint_at: Some(1),
        ..Default::default()
    };
    assert!(run(&mut w, &mut f).await.is_err());
    assert!(f.trace.is_empty());
}
#[tokio::test]
async fn uncertain_delete_is_never_blindly_replayed_on_resume() {
    let mut w = work(Action::Delete, vec![json!(1), json!(2)]);
    w.groups[0].identity = Some(Identity::Imap {
        validity: 1,
        message_ids: HashMap::from([(1, "<1@test>".into()), (2, "<2@test>".into())]),
    });
    w.groups[0].attempted = vec![1];
    let mut f = Fake::default();
    bulk_worker::run(&mut f, &mut w, Arc::new(AtomicBool::new(false)), true)
        .await
        .unwrap();
    assert_eq!(w.result.removed, 1);
    assert_eq!(w.result.kept_delete_failed, 1);
    assert_eq!(w.groups[0].deleted, vec![2]);
}
#[tokio::test]
async fn resumed_destructive_work_requires_original_identity_evidence() {
    let mut w = work(Action::ArchiveAndDelete, vec![json!(1)]);
    let mut f = Fake::default();
    assert!(
        bulk_worker::run(&mut f, &mut w, Arc::new(AtomicBool::new(false)), true)
            .await
            .is_err()
    );
    assert!(f.trace.is_empty());
}

#[tokio::test]
async fn copy_outcomes_partition_every_exact_target_once() {
    let mut w = work(
        Action::ArchiveBackupDelete,
        (1..=5).map(|u| json!(u)).collect(),
    );
    let mut f = Fake {
        copy_partition: true,
        ..Default::default()
    };
    run(&mut w, &mut f).await.unwrap();
    assert_eq!(w.result.removed, 1);
    assert_eq!(w.result.kept_copy_mismatch, 2);
    assert_eq!(w.result.kept_not_archived, 1);
    assert_eq!(w.result.kept_backup_unreachable, 1);
}
#[tokio::test]
async fn failure_after_remote_delete_stops_next_unit_and_retains_uncertainty() {
    let mut w = work(Action::Delete, (1..=11).map(|u| json!(u)).collect());
    let mut f = Fake {
        fail_after_delete: true,
        ..Default::default()
    };
    assert!(run(&mut w, &mut f).await.is_err());
    assert_eq!(
        f.trace.iter().filter(|e| e["effect"] == "delete").count(),
        1
    );
    let durable = f.checkpoints.last().unwrap();
    assert_eq!(durable.groups[0].attempted, vec![1, 2, 3, 4, 5]);
    assert!(durable.groups[0].deleted.is_empty());
}
#[tokio::test]
async fn thrown_phase_failures_stop_later_mail_effects() {
    for stage in ["archive", "verify", "delete"] {
        let mut w = work(
            Action::ArchiveAndDelete,
            vec![json!(1), json!("acc2:INBOX:1")],
        );
        let mut f = Fake {
            fail_stage: Some(stage),
            ..Default::default()
        };
        assert!(run(&mut w, &mut f).await.is_err(), "{stage}");
        assert!(!f.trace.iter().any(|e| e["effect"] == "delete"));
    }
}
