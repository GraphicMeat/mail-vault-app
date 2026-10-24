//! One named background worker per user bulk operation. Startup never adopts
//! pending work; explicit Resume is the only entry after a daemon restart.
use crate::{
    handlers::{archive, backup, common},
    server::DaemonState,
};
use mailvault_core::{
    bulk::{FrozenIntent, Group, Mailbox},
    bulk_worker::{self, ArchiveOutcome, CopyProof, Identity, Ports, Selected, Workflow},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub(crate) fn local_mailboxes(
    state: &DaemonState,
    accounts: &[String],
) -> Result<Vec<Mailbox>, String> {
    // Local provenance is the existing native import marker, not a UI claim.
    // Reading markers needs no open-vault write authorization; plain Delete
    // remains usable while the vault is closed for a move.
    if !accounts.is_empty() && !state.mail_dir_ok {
        return Err("errors.bulkLocalFoldersRead".into());
    }
    let mut local = Vec::new();
    for account in accounts {
        let dir = mailvault_core::vault_files::account_dir(
            &state.data_dir.join("Maildir"),
            &common::sanitize_mailbox_name(account),
        );
        if !state.data_dir.is_dir() {
            return Err("errors.bulkLocalFoldersRead".into());
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("errors.bulkLocalFoldersRead".into()),
        };
        // The broad folder-list UI deliberately skips unreadable markers.
        // A destructive coordinator cannot interpret that omission as proof
        // that a selected folder lives on the server. Use its same marker
        // reader, retaining errors instead of that UI-only fallback.
        for entry in entries {
            let entry = entry.map_err(|_| "errors.bulkLocalFoldersRead".to_string())?;
            if !entry
                .file_type()
                .map_err(|_| "errors.bulkLocalFoldersRead".to_string())?
                .is_dir()
            {
                continue;
            }
            let dir = entry.file_name().to_string_lossy().into_owned();
            if let Some(marker) =
                mailvault_core::local_folder::read_marker(&entry.path().parent().unwrap(), &dir)
                    .map_err(|_| "errors.bulkLocalFoldersRead".to_string())?
            {
                local.push(Mailbox {
                    account_id: account.clone(),
                    mailbox: dir,
                });
                local.push(Mailbox {
                    account_id: account.clone(),
                    mailbox: marker.name,
                });
            }
        }
    }
    Ok(local)
}
struct MailPorts {
    state: Arc<DaemonState>,
    id: String,
    mirror: Option<String>,
    archive_base: usize,
    archive_errors: usize,
    selected: HashMap<(String, String), Selected>,
    origins: HashMap<String, String>,
}
impl MailPorts {
    async fn config(&self, g: &Group) -> Result<crate::imap::ImapConfig, String> {
        let (state, account) = (self.state.clone(), g.account_id.clone());
        let member = common::blocking(move || {
            crate::handlers::insights::configured_account_ids(&state.app_dir)
                .map(|ids| ids.contains(&account))
        })
        .await??;
        if !member {
            return Err("errors.bulkAccountUnavailable".into());
        }
        let config = crate::oauth_tokens::resolve(
            &self.state,
            &g.account_id,
            crate::oauth_tokens::Read::Quiet,
        )
        .await?;
        let origin = bulk_worker::origin_hash(&config);
        if self
            .origins
            .get(&g.account_id)
            .is_some_and(|old| old != &origin)
        {
            return Err("errors.bulkIdentityChanged".into());
        }
        Ok(config)
    }
}
impl Ports for MailPorts {
    async fn checkpoint(&mut self, w: &Workflow) -> Result<(), String> {
        let (state, id, w) = (self.state.clone(), self.id.clone(), w.clone());
        let snapshot = common::blocking(move || {
            let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
            state
                .bulk
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .checkpoint(&state.app_dir, &id, &w)
        })
        .await??;
        self.state.events.emit(
            "bulk-progress",
            json!({"operationId":self.id,"finished":false,"operation":snapshot}),
        );
        Ok(())
    }
    async fn identity(&mut self, g: &Group) -> Result<(Identity, String), String> {
        let config = self.config(g).await?;
        let origin = bulk_worker::origin_hash(&config);
        self.origins.insert(g.account_id.clone(), origin.clone());
        if config.uses_jmap() {
            let acct = self
                .state
                .jmap
                .get(&config)
                .await
                .map_err(|e| e.to_string())?;
            let boxes = acct.current().await.map_err(|e| e.to_string())?;
            let mailbox_id = boxes
                .ids
                .get(&g.mailbox)
                .cloned()
                .ok_or("errors.bulkIdentityUncertain")?;
            let pairs = acct
                .uid_to_id(&self.state, &g.account_id, &g.mailbox, &g.uids, false)
                .await?;
            let ids: HashMap<_, _> = pairs
                .into_iter()
                .filter_map(|(uid, id)| id.map(|id| (uid, id)))
                .collect();
            let selected = self
                .selected
                .get(&(g.account_id.clone(), g.mailbox.clone()))
                .ok_or("errors.bulkIdentityUncertain")?;
            if g.uids.iter().any(|uid| {
                selected.jmap_ids.get(uid).is_none() || selected.jmap_ids.get(uid) != ids.get(uid)
            }) {
                return Err("errors.bulkIdentityChanged".into());
            }
            return Ok((Identity::Jmap { mailbox_id, ids }, origin));
        }
        if config.uses_graph() {
            let selected = self
                .selected
                .get(&(g.account_id.clone(), g.mailbox.clone()))
                .ok_or("errors.bulkIdentityUncertain")?;
            return Ok((
                Identity::Graph {
                    ids: selected.graph_ids.clone(),
                },
                origin,
            ));
        }
        let selected = self
            .selected
            .get(&(g.account_id.clone(), g.mailbox.clone()))
            .ok_or("errors.bulkIdentityUncertain")?;
        read_imap_identity(&self.state, g, &config, selected)
            .await
            .map(|identity| (identity, origin))
    }
    async fn archive(
        &mut self,
        g: &Group,
        cancel: Arc<AtomicBool>,
        identity: &Identity,
    ) -> Result<ArchiveOutcome, String> {
        let config = self.config(g).await?;
        let root = common::vault_root(&self.state)?;
        let original = archive::archive_ctx(&self.state, root);
        let state = self.state.clone();
        let id = self.id.clone();
        let base = self.archive_base;
        let errors_base = self.archive_errors;
        let emit = Arc::new(move |name: &str, payload: Value| {
            // Only this runner's injected sink updates its operation. Global
            // archive/delete events from other jobs are never subscribed to.
            state.events.emit(name, payload.clone());
            if name == "archive-progress" {
                let snapshot = state
                    .bulk
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .progress(
                        &id,
                        base + payload["completed"].as_u64().unwrap_or(0) as usize,
                        errors_base + payload["errors"].as_u64().unwrap_or(0) as usize,
                    );
                if let Some(snapshot) = snapshot {
                    state.events.emit(
                        "bulk-progress",
                        json!({"operationId":id,"finished":false,"operation":snapshot}),
                    );
                }
            }
        });
        let ctx = Arc::new(mailvault_core::archive::ArchiveCtx {
            root: original.root.clone(),
            pool: original.pool.clone(),
            gate: original.gate.clone(),
            registry: original.registry.clone(),
            sinks: mailvault_core::archive::ArchiveSinks {
                emit,
                custody_append: original.sinks.custody_append.clone(),
            },
        });
        let result = mailvault_core::archive::run_config(
            ctx,
            g.account_id.clone(),
            config,
            g.mailbox.clone(),
            g.uids.clone(),
            cancel,
            true,
            identity.clone(),
        )
        .await;
        self.archive_base += g.uids.len();
        result.map(|progress| {
            self.archive_errors += progress.errors;
            ArchiveOutcome {
                errors: progress.errors,
                last_error: progress.last_error,
            }
        })
    }
    async fn verify(&mut self, g: &Group, identity: &Identity) -> Result<Vec<u32>, String> {
        let root = common::vault_root(&self.state)?;
        let g = g.clone();
        let identity = identity.clone();
        common::blocking(move || {
            let expected = match &identity {
                Identity::Imap { message_ids, .. } => Some(message_ids),
                _ => None,
            };
            mailvault_core::message_store::verify_archived(
                &root,
                &g.account_id,
                &g.mailbox,
                &g.uids,
                expected,
            )
            .0
        })
        .await
    }
    async fn copy(&mut self, g: &Group, uids: &[u32]) -> Result<CopyProof, String> {
        let config = self.config(g).await?;
        let proof=backup::backup_copy_uids(&self.state,json!({"accountId":g.account_id,"email":config.email,"mailbox":g.mailbox,"uids":uids,"mirrorRoot":self.mirror})).await?;
        let list = |name: &str| serde_json::from_value(proof[name].clone()).unwrap_or_default();
        Ok(CopyProof {
            verified: list("verified"),
            missing: list("missing"),
            mismatched: list("mismatched"),
        })
    }
    async fn delete(
        &mut self,
        g: &Group,
        uids: &[u32],
        identity: &Identity,
        bin: bool,
        cancel: Arc<AtomicBool>,
    ) -> Result<Vec<u32>, String> {
        let config = self.config(g).await?;
        // Copy proof is established by the worker. At the effect boundary,
        // verify the actual vault bytes again against the original Message-ID.
        if !bin {
            let root = common::vault_root(&self.state)?;
            let (g, uids, identity) = (g.clone(), uids.to_vec(), identity.clone());
            let requested: HashSet<u32> = uids.iter().copied().collect();
            let verified = common::blocking(move || {
                let listing =
                    mailvault_core::message_store::archived_paths(&root, &g.account_id, &g.mailbox);
                let expected = match identity {
                    Identity::Imap { message_ids, .. } => message_ids,
                    _ => HashMap::new(),
                };
                mailvault_core::message_store::verify_archived_strict(
                    &root,
                    &g.account_id,
                    &g.mailbox,
                    &listing,
                    &uids,
                    &expected,
                )
                .0
            })
            .await?;
            let verified: HashSet<u32> = verified.into_iter().collect();
            if !requested.is_subset(&verified) {
                return Err("errors.bulkCopyChanged".into());
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Ok(vec![]);
        }
        archive::delete_with_config(
            &self.state,
            g.account_id.clone(),
            config,
            g.mailbox.clone(),
            uids.to_vec(),
            bin,
            cancel,
            Some(identity),
        )
        .await
        .map(|(_, deleted)| deleted)
    }
}

pub(crate) fn launch(
    state: Arc<DaemonState>,
    id: String,
    work: Workflow,
    mirror: Option<String>,
    resume: bool,
) -> Result<(), String> {
    let cancel = state
        .bulk
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .cancel_token(&id)?;
    std::thread::Builder::new()
        .name("bulk-worker".into())
        .spawn(move || {
            #[cfg(target_os = "macos")]
            unsafe {
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
            }
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match result {
                Ok(rt) => rt.block_on(async move {
                    // The command/RPC future owns only the small kickoff; the long
                    // mail future has heap ownership on this worker's runtime.
                    let st = state.clone();
                    let op = id.clone();
                    let task = tokio::spawn(Box::pin(async move {
                        let mut work = work;
                        let selected = work
                            .groups
                            .iter()
                            .filter_map(|g| {
                                g.selected.clone().map(|selected| {
                                    (
                                        (g.group.account_id.clone(), g.group.mailbox.clone()),
                                        selected,
                                    )
                                })
                            })
                            .collect();
                        let origins = work
                            .groups
                            .iter()
                            .filter_map(|g| {
                                g.origin
                                    .clone()
                                    .map(|origin| (g.group.account_id.clone(), origin))
                            })
                            .collect();
                        let mut ports = MailPorts {
                            state: st.clone(),
                            id: op.clone(),
                            mirror,
                            archive_base: 0,
                            archive_errors: 0,
                            selected,
                            origins,
                        };
                        if let Err(e) =
                            bulk_worker::run(&mut ports, &mut work, cancel, resume).await
                        {
                            tracing::warn!("bulk worker {op}: {e}");
                            work.status = "error".into();
                            work.last_error = Some(e);
                            // A failed checkpoint cannot authorize further IO. The
                            // earlier intent remains evidence if this also fails.
                            let _ = ports.checkpoint(&work).await;
                        }
                    }));
                    let joined = task.await;
                    if let Err(e) = joined {
                        tracing::warn!("bulk worker {id} stopped: {e}");
                    }
                    drained(&state, &id);
                }),
                Err(e) => {
                    tracing::warn!("bulk runtime could not start: {e}");
                    drained(&state, &id);
                }
            }
        })
        .map(|_| ())
        .map_err(|_| "errors.bulkWorkerUnavailable".into())
}
fn drained(state: &Arc<DaemonState>, id: &str) {
    let snapshot = state
        .bulk
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drained(id);
    if let Ok(operation) = snapshot {
        state.events.emit(
            "bulk-progress",
            json!({"operationId":id,"finished":true,"operation":operation}),
        );
    }
}

/// Freeze native identity metadata with the keys at RPC admission. No secret
/// or account config is serialized into this operation record.
pub(crate) fn freeze(
    state: &Arc<DaemonState>,
    action: mailvault_core::bulk::Action,
    scope: mailvault_core::bulk::Scope,
) -> Result<Workflow, String> {
    let accounts = crate::handlers::insights::configured_account_ids(&state.app_dir)
        .map_err(|_| "errors.bulkAccountUnavailable".to_string())?;
    let grouped = mailvault_core::bulk::group_targets(&scope);
    let selected_accounts: Vec<_> = accounts
        .iter()
        .filter(|account| {
            grouped
                .groups
                .iter()
                .any(|group| &group.account_id == *account)
        })
        .cloned()
        .collect();
    let local = local_mailboxes(state, &selected_accounts)?;
    let mut work = Workflow::new(FrozenIntent::freeze(action, scope, &accounts, &local));
    for group in &mut work.groups {
        let g = &group.group;
        let (validity, rows) = crate::custody::with_conn(state, |c| {
            let meta = mailvault_core::custody::cache::load_meta(c, &g.account_id, &g.mailbox)?;
            let validity = meta
                .map(|s| serde_json::from_str::<Value>(&s))
                .transpose()
                .map_err(|_| "errors.bulkIdentityUncertain".to_string())?
                .and_then(|v| v["uidValidity"].as_u64())
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0);
            Ok((
                validity,
                mailvault_core::custody::cache::load_by_uids(
                    c,
                    &g.account_id,
                    &g.mailbox,
                    &g.uids,
                )?,
            ))
        })?;
        let mut selected = Selected {
            validity,
            ..Default::default()
        };
        for row in rows {
            let Some(uid) = row["uid"].as_u64().and_then(|u| u32::try_from(u).ok()) else {
                continue;
            };
            selected.cached_uids.push(uid);
            if let Some(id) = row
                .get("messageId")
                .or_else(|| row.get("message_id"))
                .and_then(Value::as_str)
            {
                let id = mailvault_core::maildir::normalize_message_id(id);
                if !id.is_empty() {
                    selected.message_ids.insert(uid, id);
                }
            }
        }
        let ledger = mailvault_core::graph_ledger::load(&crate::jmap_sessions::jmap_ledger_path(
            &state.data_dir,
            &g.account_id,
            &g.mailbox,
        ))?;
        selected.jmap_ids = g
            .uids
            .iter()
            .filter_map(|u| ledger.get(u).cloned().map(|id| (*u, id)))
            .collect();
        let sidecar =
            mailvault_core::header_cache::sidecar_dir(&state.data_dir, &g.account_id, &g.mailbox);
        let ledger = mailvault_core::graph_ledger::load(
            &mailvault_core::graph_ledger::ledger_path(&sidecar, false),
        )?;
        selected.graph_ids = g
            .uids
            .iter()
            .filter_map(|u| ledger.get(u).cloned().map(|id| (*u, id)))
            .collect();
        group.selected = Some(selected);
    }
    Ok(work)
}

async fn read_imap_identity(
    state: &Arc<DaemonState>,
    g: &Group,
    config: &crate::imap::ImapConfig,
    selected: &Selected,
) -> Result<Identity, String> {
    let validity = selected.validity.ok_or("errors.bulkIdentityUncertain")?;
    let cached: HashSet<_> = selected.cached_uids.iter().copied().collect();
    if g.uids.iter().any(|u| !cached.contains(u)) {
        return Err("errors.bulkIdentityUncertain".into());
    }
    let expected = Identity::Imap {
        validity,
        message_ids: selected.message_ids.clone(),
    };
    let pool = state.imap_pool.clone();
    let mailbox = g.mailbox.clone();
    let uids = g.uids.clone();
    let current = pool
        .run_read(config, false, |mut session| {
            let mailbox = mailbox.clone();
            let uids = uids.clone();
            async move {
                let validity = crate::imap::abd_cmds::uid_validity(&mut session, &mailbox)
                    .await?
                    .ok_or("errors.bulkIdentityUncertain")?;
                let ids = crate::imap::abd_cmds::message_ids(&mut session, &mailbox, &uids).await?;
                let message_ids = ids
                    .into_iter()
                    .filter_map(|(u, id)| {
                        id.map(|id| (u, mailvault_core::maildir::normalize_message_id(&id)))
                    })
                    .collect();
                Ok((
                    Identity::Imap {
                        validity,
                        message_ids,
                    },
                    session,
                    Some(mailbox),
                ))
            }
        })
        .await?;
    if !expected.matches(&current, &g.uids) {
        return Err("errors.bulkIdentityChanged".into());
    }
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mock_imap::{MockImap, Scenario};
    use std::time::Duration;

    fn inbox(validity: u32) -> mock_imap::state::Mailbox {
        let mut mailbox = mock_imap::state::Mailbox::new("INBOX").with_uid_validity(validity);
        mailbox.add(mock_imap::Message::new(7,"From: a@example.test\r\nTo: one@example.test\r\nSubject: selected\r\nMessage-ID: <selected@test>\r\n\r\nbody\r\n"));
        mailbox
    }
    fn selected() -> Selected {
        Selected {
            validity: Some(1),
            cached_uids: vec![7],
            message_ids: HashMap::from([(7, "selected@test".into())]),
            ..Default::default()
        }
    }
    fn config(server: &MockImap) -> crate::imap::ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(json!({"email":"one@example.test","password":"pw","imapHost":server.host(),"imapPort":server.port()})).unwrap()
    }
    fn group() -> Group {
        Group {
            account_id: "acc".into(),
            mailbox: "INBOX".into(),
            uids: vec![7],
        }
    }
    #[tokio::test]
    async fn bulk_worker_stale_selected_generation_refuses_before_mail_effects() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(2)));
        assert_eq!(
            read_imap_identity(&state, &group(), &config(&server), &selected())
                .await
                .unwrap_err(),
            "errors.bulkIdentityChanged"
        );
        assert!(server.commands().iter().all(|c| !c.contains("BODY.PEEK[]")
            && !c.contains("UID STORE")
            && !c.contains("EXPUNGE")));
    }
    #[tokio::test]
    async fn bulk_worker_same_generation_with_different_message_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
        let mut proof = selected();
        proof.message_ids.insert(7, "different@test".into());
        assert_eq!(
            read_imap_identity(&state, &group(), &config(&server), &proof)
                .await
                .unwrap_err(),
            "errors.bulkIdentityChanged"
        );
    }
    #[tokio::test]
    async fn bulk_worker_missing_original_generation_never_samples_new_authority() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
        let mut proof = selected();
        proof.validity = None;
        assert_eq!(
            read_imap_identity(&state, &group(), &config(&server), &proof)
                .await
                .unwrap_err(),
            "errors.bulkIdentityUncertain"
        );
        assert!(server.commands().is_empty());
    }
    #[test]
    fn bulk_worker_unavailable_actual_root_cannot_be_inferred_from_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), false);
        assert_eq!(
            local_mailboxes(&state, &["acc".into()]).unwrap_err(),
            "errors.bulkLocalFoldersRead"
        );
    }
    #[test]
    fn bulk_worker_corrupt_local_marker_is_unknown_even_while_vault_closed() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let folder = mailvault_core::vault_files::account_dir(&dir.path().join("Maildir"), "acc")
            .join("Imported");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(".mailvault-local.json"), "{broken").unwrap();
        state.vault_closed.store(true, Ordering::SeqCst);
        assert_eq!(
            local_mailboxes(&state, &["acc".into()]).unwrap_err(),
            "errors.bulkLocalFoldersRead"
        );
    }
    async fn wait_drained(state: &Arc<DaemonState>) -> Value {
        for _ in 0..400 {
            let status = handle_request_for_test(state, "bulk.status", json!({}))
                .await
                .result
                .unwrap();
            if status["active"].is_null() {
                return mailvault_core::op_journal::pending_operation_read(&state.app_dir)
                    .unwrap()
                    .unwrap();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("bulk worker did not drain")
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn bulk_worker_real_four_modes_use_exact_permanent_delete_and_bin_policy() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (name, deleted, archived, bin, mirror, fail_capture) in [
            ("archive", false, true, false, false, false),
            ("delete", true, false, true, false, false),
            ("delete", false, false, false, false, true),
            ("archive_and_delete", true, true, false, false, false),
            ("archive_backup_delete", true, true, false, true, false),
            ("archive_backup_delete", false, true, false, false, false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
            let mut scenario = Scenario::new().mailbox(inbox(1));
            if fail_capture {
                scenario = scenario.fault(
                    mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
                    mock_imap::Action::Respond("NO".into(), "copy refused".into()),
                );
            }
            let server = MockImap::start(scenario);
            let config = config(&server);
            let credentials = dir.path().join("credentials.json");
            let account = json!({"id":"acc","email":config.email,"password":"pw","imapHost":server.host(),"imapPort":server.port()});
            std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
            std::fs::write(dir.path().join("accounts.json"), "[{\"id\":\"acc\"}]").unwrap();
            crate::custody::with_conn(&state, |c| {
                mailvault_core::custody::cache::save_headers(
                    c,
                    "acc",
                    "INBOX",
                    &json!({"uidValidity":1,"emails":[{"uid":7,"messageId":"<selected@test>"}]})
                        .to_string(),
                )
            })
            .unwrap();
            let drive = tempfile::tempdir().unwrap();
            let mut params = json!({"operationId":name,"type":name,"scope":{"accountId":"acc","mailbox":"INBOX","keys":[7]}});
            if mirror {
                params["mirrorRoot"] = json!(drive.path().to_string_lossy());
            }
            let reply = handle_request_for_test(&state, "bulk.start", params.clone()).await;
            assert!(reply.error.is_none(), "{name}: {:?}", reply.error);
            let pending = wait_drained(&state).await;
            assert_eq!(pending["status"], "complete", "{name}: {pending}");
            assert_eq!(
                !server
                    .state()
                    .mailboxes
                    .iter()
                    .find(|mailbox| mailbox.name == "INBOX")
                    .unwrap()
                    .messages
                    .iter()
                    .any(|m| m.uid == 7),
                deleted,
                "{name}"
            );
            let held = mailvault_core::message_store::archived_paths(dir.path(), "acc", "INBOX");
            assert_eq!(held.contains_key(&7), archived, "{name}");
            let listed = handle_request_for_test(&state, "deleted.list", json!({}))
                .await
                .result
                .unwrap();
            assert_eq!(
                !listed.as_array().unwrap().is_empty(),
                bin,
                "{name}: {listed}"
            );
            // A duplicate ACK after terminal cannot launch the same operation again.
            let commands = server.commands().len();
            let duplicate = handle_request_for_test(&state, "bulk.start", params).await;
            assert!(duplicate.error.is_none());
            assert_eq!(server.commands().len(), commands);
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn bulk_worker_foreground_status_and_cancel_stay_responsive_during_provider_io() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)).fault(
            mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
            mock_imap::Action::Delay(Duration::from_millis(500)),
        ));
        let _ = config(&server);
        let credentials = dir.path().join("credentials.json");
        let account = json!({"id":"acc","email":"one@example.test","password":"pw","imapHost":server.host(),"imapPort":server.port()});
        std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
        std::fs::write(dir.path().join("accounts.json"), "[{\"id\":\"acc\"}]").unwrap();
        crate::custody::with_conn(&state, |c| {
            mailvault_core::custody::cache::save_headers(
                c,
                "acc",
                "INBOX",
                &json!({"uidValidity":1,"emails":[{"uid":7,"messageId":"<selected@test>"}]})
                    .to_string(),
            )
        })
        .unwrap();
        let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"slow","type":"archive_and_delete","scope":{"accountId":"acc","mailbox":"INBOX","keys":[7]}})).await;
        assert!(reply.error.is_none());
        for _ in 0..100 {
            if server.commands().iter().any(|c| c.contains("BODY.PEEK[]")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            server.commands().iter().any(|c| c.contains("BODY.PEEK[]")),
            "blocked provider phase must actually start"
        );
        let legacy = common::RunGuard::register(&state, "archive");
        let legacy_cancel = legacy.cancel();
        state.events.emit(
            "archive-progress",
            json!({"accountId":"foreign","mailbox":"INBOX","completed":999999,"errors":999999}),
        );
        let status = tokio::time::timeout(
            Duration::from_millis(200),
            handle_request_for_test(&state, "bulk.status", json!({})),
        )
        .await
        .expect("status stays responsive");
        let status = status.result.unwrap();
        assert_eq!(status["active"]["id"], "slow");
        assert_ne!(status["active"]["completed"], 999999);
        assert!(
            handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"foreign"}))
                .await
                .error
                .is_some()
        );
        assert!(
            handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"slow"}))
                .await
                .error
                .is_none()
        );
        let pending = wait_drained(&state).await;
        assert_eq!(pending["status"], "cancelled");
        assert!(!legacy_cancel.load(Ordering::SeqCst));
        drop(legacy);
        assert!(!server.commands().iter().any(|c| c.contains("UID STORE")));
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test]
    async fn bulk_worker_archive_generation_race_preserves_existing_vault_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
        let config = config(&server);
        let identity = read_imap_identity(&state, &group(), &config, &selected())
            .await
            .unwrap();
        let cur = mailvault_core::vault_files::cur_path(dir.path(), "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let filename = mailvault_core::vault_files::build_maildir_filename(7, &["archived".into()]);
        let file = cur.join(filename);
        let original = b"Message-ID: <selected@test>\r\nSubject: saved original\r\n\r\nkeep these exact bytes\r\n";
        std::fs::write(&file, original).unwrap();
        server.mutate(|state| {
            let mailbox = state
                .mailboxes
                .iter_mut()
                .find(|m| m.name == "INBOX")
                .unwrap();
            mailbox.uid_validity = 2;
            mailbox.messages[0].raw =
                b"Message-ID: <replacement@test>\r\n\r\nreplacement\r\n".to_vec();
        });
        let progress = mailvault_core::archive::run_config(
            archive::archive_ctx(&state, dir.path().into()),
            "acc".into(),
            config,
            "INBOX".into(),
            vec![7],
            Arc::new(AtomicBool::new(false)),
            true,
            identity,
        )
        .await
        .unwrap();
        assert_eq!((progress.completed, progress.errors), (0, 1));
        assert_eq!(std::fs::read(&file).unwrap(), original);
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 1);
    }
    #[tokio::test]
    async fn bulk_worker_bin_capture_generation_race_never_saves_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
        let config = config(&server);
        let identity = read_imap_identity(&state, &group(), &config, &selected())
            .await
            .unwrap();
        server.mutate(|state| {
            state
                .mailboxes
                .iter_mut()
                .find(|m| m.name == "INBOX")
                .unwrap()
                .uid_validity = 2
        });
        let (progress, deleted) = archive::delete_with_config(
            &state,
            "acc".into(),
            config,
            "INBOX".into(),
            vec![7],
            true,
            Arc::new(AtomicBool::new(false)),
            Some(&identity),
        )
        .await
        .unwrap();
        assert_eq!((progress.completed, progress.errors), (0, 1));
        assert!(deleted.is_empty());
        let listed = handle_request_for_test(&state, "deleted.list", json!({}))
            .await
            .result
            .unwrap();
        assert!(listed.as_array().unwrap().is_empty());
        assert!(!server.commands().iter().any(|c| c.contains("UID STORE")));
    }
    #[tokio::test]
    async fn reviewed_valid_selected_message_cannot_overwrite_different_archive() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
        let config = config(&server);
        let identity = read_imap_identity(&state, &group(), &config, &selected())
            .await
            .unwrap();
        let cur = mailvault_core::vault_files::cur_path(dir.path(), "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let file = cur.join(mailvault_core::vault_files::build_maildir_filename(
            7,
            &["archived".into()],
        ));
        let original = b"Message-ID: <older-only-copy@test>\r\n\r\noriginal archived A\r\n";
        std::fs::write(&file, original).unwrap();
        let _ = mailvault_core::archive::run_config(
            archive::archive_ctx(&state, dir.path().into()),
            "acc".into(),
            config,
            "INBOX".into(),
            vec![7],
            Arc::new(AtomicBool::new(false)),
            true,
            identity,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(&file).unwrap(),
            original,
            "valid current B is not permission to remove archived A"
        );
    }
}
