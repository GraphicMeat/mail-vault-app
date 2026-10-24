use mailvault_core::bulk::{Action, FrozenIntent, Group, Scope};
use mailvault_core::bulk_worker::{
    self, ArchiveOutcome, CopyProof, Identity, Ports, StoredProof, Workflow,
};
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
    cancel_stage: Option<(&'static str, Arc<AtomicBool>)>,
    copy_mismatched: Vec<u32>,
    copy_missing: Vec<u32>,
    copy_failed: Vec<u32>,
    delete_failed: usize,
    archive_errors: usize,
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
    async fn identity(&mut self, g: &Group) -> Result<(Identity, String), String> {
        Ok((
            Identity::Imap {
                validity: 1,
                message_ids: g.uids.iter().map(|u| (*u, format!("<{u}@test>"))).collect(),
            },
            "fake-origin".into(),
        ))
    }
    async fn archive(
        &mut self,
        g: &Group,
        _cancel: Arc<AtomicBool>,
        _identity: &Identity,
    ) -> Result<ArchiveOutcome, String> {
        self.trace.push(json!({"effect":"archive","accountId":g.account_id,"mailbox":g.mailbox,"uids":g.uids,"background":true}));
        if let Some((phase, cancel)) = &self.cancel_stage {
            if *phase == "archive" {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        if self.fail_stage == Some("archive") {
            return Err("archive failed".into());
        }
        Ok(ArchiveOutcome {
            stored: if self.archive_errors == 0 {
                g.uids
                    .iter()
                    .map(|uid| StoredProof {
                        uid: *uid,
                        name: format!("{uid}:2,A.eml"),
                        sha256: bulk_worker::bytes_hash(uid.to_string().as_bytes()),
                    })
                    .collect()
            } else {
                vec![]
            },
            errors: self.archive_errors,
            ..Default::default()
        })
    }
    async fn verify(
        &mut self,
        g: &Group,
        _identity: &Identity,
        _stored: &[StoredProof],
    ) -> Result<Vec<u32>, String> {
        self.trace.push(
            json!({"effect":"verify","accountId":g.account_id,"mailbox":g.mailbox,"uids":g.uids}),
        );
        if let Some((phase, cancel)) = &self.cancel_stage {
            if *phase == "verify" {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        if self.fail_stage == Some("verify") {
            return Err("verify failed".into());
        }
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
    async fn copy(
        &mut self,
        g: &Group,
        uids: &[u32],
        _stored: &[StoredProof],
    ) -> Result<CopyProof, String> {
        self.trace.push(
            json!({"effect":"copy","accountId":g.account_id,"mailbox":g.mailbox,"uids":uids}),
        );
        self.copies += 1;
        if let Some((phase, cancel)) = &self.cancel_stage {
            if *phase == "copy" {
                cancel.store(true, Ordering::SeqCst);
            }
        }
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
            verified: uids
                .iter()
                .copied()
                .filter(|u| {
                    !self.copy_mismatched.contains(u)
                        && !self.copy_missing.contains(u)
                        && !self.copy_failed.contains(u)
                })
                .chain([9999])
                .collect(),
            mismatched: self.copy_mismatched.clone(),
            missing: self.copy_missing.clone(),
        })
    }
    async fn delete(
        &mut self,
        g: &Group,
        uids: &[u32],
        _identity: &Identity,
        bin: bool,
        _cancel: Arc<AtomicBool>,
        _stored: &[StoredProof],
    ) -> Result<Vec<u32>, String> {
        self.trace.push(json!({"effect":"delete","accountId":g.account_id,"mailbox":g.mailbox,"uids":uids,"bin":bin}));
        if let Some((phase, cancel)) = &self.cancel_stage {
            if *phase == "delete" {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        if self.fail_stage == Some("delete") {
            return Err("delete failed".into());
        }
        Ok(uids
            .iter()
            .copied()
            .take(uids.len().saturating_sub(self.delete_failed))
            .collect())
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
    w.groups[0].origin = Some("fake-origin".into());
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
async fn resumed_work_requires_original_identity_even_for_archive() {
    for action in [
        Action::Archive,
        Action::Delete,
        Action::ArchiveAndDelete,
        Action::ArchiveBackupDelete,
    ] {
        let mut w = work(action, vec![json!(1)]);
        let mut f = Fake::default();
        assert!(
            bulk_worker::run(&mut f, &mut w, Arc::new(AtomicBool::new(false)), true)
                .await
                .is_err()
        );
        assert!(f.trace.is_empty());
    }
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
        let deletes = f.trace.iter().filter(|e| e["effect"] == "delete").count();
        assert_eq!(deletes, usize::from(stage == "delete"));
    }
}

#[test]
fn provider_origin_keeps_secret_refresh_but_rejects_retargeting() {
    let config:mailvault_core::imap::ImapConfig=serde_json::from_value(json!({"email":"me@example.test","imapHost":"mail.example.test","password":"old","oauth2AccessToken":"old-token"})).unwrap();
    let origin = bulk_worker::origin_hash(&config);
    let mut refreshed = config.clone();
    refreshed.password = Some("new".into());
    refreshed.access_token = Some("new-token".into());
    assert_eq!(bulk_worker::origin_hash(&refreshed), origin);
    refreshed.host = "other.example.test".into();
    assert_ne!(bulk_worker::origin_hash(&refreshed), origin);
    let mut changed = config;
    changed.email = "someone@example.test".into();
    assert_ne!(bulk_worker::origin_hash(&changed), origin);
    assert!(!origin.contains("example.test"));
    assert_eq!(origin.len(), 64);
}

#[tokio::test]
async fn archive_resume_preserves_exact_completed_folder_identities() {
    let mut w = work(
        Action::Archive,
        vec![json!("acc1:INBOX:1"), json!("acc2:Sent:1")],
    );
    w.groups[0].verified = vec![1];
    w.groups[0].stored = vec![StoredProof {
        uid: 1,
        name: "1:2,A.eml".into(),
        sha256: bulk_worker::bytes_hash(b"1"),
    }];
    for group in &mut w.groups {
        group.identity = Some(Identity::Imap {
            validity: 1,
            message_ids: HashMap::from([(1, "<1@test>".into())]),
        });
        group.origin = Some("fake-origin".into());
    }
    let mut f = Fake::default();
    bulk_worker::run(&mut f, &mut w, Arc::new(AtomicBool::new(false)), true)
        .await
        .unwrap();
    assert!(f.trace.iter().all(|e| e["accountId"] == "acc2"));
    assert_eq!(
        w.completed_keys(),
        vec![json!("acc1:INBOX:1"), json!("acc2:Sent:1")]
    );
}

#[tokio::test]
async fn fully_attempted_group_cannot_reenter_stale_copy_or_delete_lists() {
    for action in [Action::ArchiveAndDelete, Action::ArchiveBackupDelete] {
        let mut w = work(action, vec![json!(1)]);
        w.groups[0].attempted = vec![1];
        w.groups[0].verified = vec![1];
        w.groups[0].stored = vec![StoredProof {
            uid: 1,
            name: "1:2,A.eml".into(),
            sha256: bulk_worker::bytes_hash(b"1"),
        }];
        w.groups[0].eligible = vec![1];
        let mut f = Fake::default();
        bulk_worker::run(&mut f, &mut w, Arc::new(AtomicBool::new(false)), true)
            .await
            .unwrap();
        assert!(f.trace.is_empty());
        assert_eq!(w.result.kept_delete_failed, 1);
        assert_eq!(w.result.removed, 0);
    }
}
fn normalized_trace(trace: &[Value], action: Action) -> Vec<Value> {
    let mut normalized: Vec<Value> = vec![];
    for effect in trace.iter().filter(|effect| {
        effect["effect"] != "clear" && !(action == Action::Archive && effect["effect"] == "verify")
    }) {
        if effect["effect"] == "delete" {
            if let Some(previous) = normalized.last_mut().filter(|previous| {
                previous["effect"] == "delete"
                    && previous["accountId"] == effect["accountId"]
                    && previous["mailbox"] == effect["mailbox"]
                    && previous["bin"] == effect["bin"]
            }) {
                previous["uids"]
                    .as_array_mut()
                    .unwrap()
                    .extend(effect["uids"].as_array().unwrap().iter().cloned());
                continue;
            }
        }
        normalized.push(effect.clone());
    }
    normalized
}
#[tokio::test]
async fn captured_failure_copy_and_cancel_mail_decisions_match_real_js() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/bulk-operation-cases.json")).unwrap();
    for name in [
        "verify-subset",
        "copy-201",
        "copy-partition",
        "copy-drive-gone-later",
        "copy-drive-gone-first",
        "partial-delete",
        "cancel-archive",
        "cancel-verify",
        "cancel-copy",
        "cancel-delete",
        "archive-error",
        "verify-error",
        "delete-error",
    ] {
        let fixture = corpus["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap();
        let action: Action = serde_json::from_value(fixture["type"].clone()).unwrap();
        let mut w = work(action, fixture["keys"].as_array().unwrap().clone());
        let cancel = Arc::new(AtomicBool::new(false));
        let mut f = Fake::default();
        match name {
            "verify-subset" => f.missing = Some(2),
            "copy-partition" => {
                f.missing = Some(1);
                f.copy_mismatched = vec![2];
                f.copy_missing = vec![3];
                f.copy_failed = vec![4];
            }
            "copy-drive-gone-later" => f.drive_gone_at = Some(2),
            "copy-drive-gone-first" => f.drive_gone_at = Some(1),
            "partial-delete" => f.delete_failed = 1,
            "cancel-archive" => f.cancel_stage = Some(("archive", cancel.clone())),
            "cancel-verify" => f.cancel_stage = Some(("verify", cancel.clone())),
            "cancel-copy" => f.cancel_stage = Some(("copy", cancel.clone())),
            "cancel-delete" => f.cancel_stage = Some(("delete", cancel.clone())),
            "archive-error" => f.fail_stage = Some("archive"),
            "verify-error" => f.fail_stage = Some("verify"),
            "delete-error" => f.fail_stage = Some("delete"),
            _ => {}
        }
        let result = bulk_worker::run(&mut f, &mut w, cancel, false).await;
        assert_eq!(
            normalized_trace(&f.trace, action),
            normalized_trace(fixture["trace"].as_array().unwrap(), action),
            "{name}"
        );
        let expected = fixture["snapshots"].as_array().unwrap().last().unwrap();
        if result.is_err() {
            assert_eq!(expected["status"], "error", "{name}");
        } else {
            assert_eq!(w.status, expected["status"].as_str().unwrap(), "{name}");
        }
        if name == "cancel-delete" {
            // JS emitted its cancel snapshot before its mocked delete reply.
            // The daemon publishes terminal only after the actual UID outcome.
            assert_eq!(expected["result"]["removed"], 0);
            assert_eq!(w.result.removed, 1);
        }
        if action == Action::ArchiveBackupDelete && expected["result"].is_object() {
            let mut expected_result = expected["result"].clone();
            if name == "cancel-delete" {
                expected_result["removed"] = json!(1);
            }
            assert_eq!(
                serde_json::to_value(&w.result).unwrap(),
                expected_result,
                "{name}"
            );
        }
    }
}

#[tokio::test]
async fn stricter_proof_intentionally_refuses_the_oracles_stray_verified_uid() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/bulk-operation-cases.json")).unwrap();
    let legacy = corpus["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "stray-verify")
        .unwrap();
    assert!(legacy["trace"]
        .as_array()
        .unwrap()
        .iter()
        .any(|effect| effect["effect"] == "copy"
            && effect["uids"].as_array().unwrap().contains(&json!(9999))));
    let mut w = work(
        Action::ArchiveBackupDelete,
        legacy["keys"].as_array().unwrap().clone(),
    );
    let mut f = Fake {
        stray: true,
        ..Default::default()
    };
    run(&mut w, &mut f).await.unwrap();
    assert!(f
        .trace
        .iter()
        .filter(|effect| effect["effect"] == "copy" || effect["effect"] == "delete")
        .all(|effect| effect["uids"] == json!([1])));
    assert_eq!(w.result.removed, 1);
    assert_eq!(w.result.kept_not_archived, 0);
}

#[test]
fn reviewed_provider_identity_survives_persisted_checkpoint_roundtrip() {
    let identity = Identity::Imap {
        validity: 1,
        message_ids: HashMap::from([(7, "selected@test".into())]),
    };
    let result = serde_json::from_value::<Identity>(serde_json::to_value(&identity).unwrap());
    assert!(result.is_ok(), "identity must roundtrip: {result:?}");
    assert_eq!(result.unwrap(), identity);
}
#[test]
fn reviewed_jmap_query_edit_changes_provider_origin() {
    let mut config:mailvault_core::imap::ImapConfig=serde_json::from_value(json!({"email":"me@example.test","imapHost":"host","jmapSessionUrl":"https://host/session?tenant=a","jmapAuth":"basic","password":"pw"})).unwrap();
    let origin = bulk_worker::origin_hash(&config);
    config.jmap_session_url = Some("https://host/session?tenant=b".into());
    assert_ne!(bulk_worker::origin_hash(&config), origin);
}
#[tokio::test]
async fn reviewed_failed_archive_cannot_turn_stale_uid_presence_into_delete_proof() {
    for action in [Action::ArchiveAndDelete, Action::ArchiveBackupDelete] {
        let mut w = work(action, vec![json!(7)]);
        let mut f = Fake {
            archive_errors: 1,
            ..Default::default()
        };
        run(&mut w, &mut f).await.unwrap();
        assert!(!f
            .trace
            .iter()
            .any(|effect| effect["effect"] == "delete" || effect["effect"] == "copy"));
        assert_eq!(w.result.removed, 0);
    }
}

#[test]
fn reviewed_uid_map_rejects_ambiguous_or_overflowing_wire_keys() {
    for key in ["07", "-1", "4294967296", "+7"] {
        let mut ids = serde_json::Map::new();
        ids.insert(key.to_owned(), json!("selected@test"));
        let value = json!({"transport":"imap","validity":1,"message_ids":ids});
        assert!(serde_json::from_value::<Identity>(value).is_err(), "{key}");
    }
}

#[test]
fn reviewed_mirror_proof_uses_raw_bytes_in_both_storage_formats() {
    use mailvault_core::{backup, maildir, message_store};
    for format in [message_store::Format::Maildir, message_store::Format::Jmap] {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        message_store::set_vault_format(vault.path(), format).unwrap();
        message_store::create_messages_dir(vault.path(), "acc", "INBOX").unwrap();
        let raw = b"Message-ID: <same@test>\r\n\r\nselected B\r\n";
        let old = b"Message-ID: <same@test>\r\n\r\nselected A\r\n";
        let source = message_store::write_new(
            vault.path(),
            "acc",
            "INBOX",
            7,
            raw,
            &["archived".into()],
            true,
        )
        .unwrap();
        let sources = HashMap::from([(7, source)]);
        let expected = HashMap::from([(7, bulk_worker::bytes_hash(raw))]);
        let cur = maildir::mirror_cur(mirror.path(), "one@example.test", "INBOX").unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let existing = cur.join("7.eml");
        std::fs::write(&existing, old).unwrap();
        let result = backup::copy_uids_to_mirror_proved(
            vault.path(),
            mirror.path(),
            "acc",
            "one@example.test",
            "INBOX",
            &[7],
            &sources,
            &expected,
        )
        .unwrap();
        assert_eq!(result.mismatched, vec![7]);
        assert_eq!(std::fs::read(&existing).unwrap(), old);
        std::fs::remove_file(&existing).unwrap();
        let copied = backup::copy_uids_to_mirror_proved(
            vault.path(),
            mirror.path(),
            "acc",
            "one@example.test",
            "INBOX",
            &[7],
            &sources,
            &expected,
        )
        .unwrap();
        assert_eq!(copied.verified, vec![7]);
        assert_eq!(copied.copied, vec![7]);
        let saved = std::fs::read_dir(&cur)
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "eml")
            })
            .unwrap();
        assert_eq!(std::fs::read(saved.path()).unwrap(), raw);
    }
}

#[test]
fn native_header_origin_covers_supported_endpoint_edits() {
    let base: mailvault_core::imap::ImapConfig = serde_json::from_value(json!({"email":"me@example.test", "imapHost":"host.example.test", "imapPort":993, "imapSecurity":"tls", "password":"first"})).unwrap();
    let original = bulk_worker::origin_hash(&base);
    let mut changed = base.clone();
    changed.port = Some(1993);
    assert_ne!(bulk_worker::origin_hash(&changed), original);
    changed = base.clone();
    changed.security = Some("starttls".into());
    assert_ne!(bulk_worker::origin_hash(&changed), original);
    changed = base.clone();
    changed.password = Some("refresh".into());
    changed.access_token = Some("refreshed-access".into());
    assert_eq!(bulk_worker::origin_hash(&changed), original);
    let mut jmap = base;
    jmap.jmap_session_url = Some("https://jmap.example.test/session".into());
    jmap.jmap_auth = Some("basic".into());
    jmap.jmap_username = Some("original-login".into());
    let original = bulk_worker::origin_hash(&jmap);
    jmap.jmap_username = Some("edited-login".into());
    assert_ne!(bulk_worker::origin_hash(&jmap), original);
}
