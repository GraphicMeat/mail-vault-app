//! One named background worker per user bulk operation. Startup never adopts
//! pending work; explicit Resume is the only entry after a daemon restart.
use crate::{
    handlers::{archive, backup, common},
    server::DaemonState,
};
use mailvault_core::{
    bulk::{FrozenIntent, Group, Mailbox},
    bulk_worker::{self, CopyProof, Identity, Ports, Workflow},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
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
        crate::oauth_tokens::resolve(&self.state, &g.account_id, crate::oauth_tokens::Read::Quiet)
            .await
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
    async fn identity(&mut self, g: &Group) -> Result<Identity, String> {
        let config = self.config(g).await?;
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
            let ids = pairs
                .into_iter()
                .filter_map(|(u, id)| id.map(|id| (u, id)))
                .collect();
            return Ok(Identity::Jmap { mailbox_id, ids });
        }
        if config.uses_graph() {
            return Ok(Identity::Graph);
        }
        let pool = self.state.imap_pool.clone();
        let mailbox = g.mailbox.clone();
        let uids = g.uids.clone();
        pool.run_read(&config, false, |mut session| {
            let mailbox = mailbox.clone();
            let uids = uids.clone();
            async move {
                let validity = crate::imap::abd_cmds::uid_validity(&mut session, &mailbox)
                    .await?
                    .ok_or("errors.bulkIdentityUncertain")?;
                let ids = crate::imap::abd_cmds::message_ids(&mut session, &mailbox, &uids).await?;
                let message_ids = ids
                    .into_iter()
                    .filter_map(|(u, id)| id.map(|id| (u, id)))
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
        .await
    }
    async fn archive(&mut self, g: &Group, cancel: Arc<AtomicBool>) -> Result<(), String> {
        let config = self.config(g).await?;
        let root = common::vault_root(&self.state)?;
        let original = archive::archive_ctx(&self.state, root);
        let state = self.state.clone();
        let id = self.id.clone();
        let base = self.archive_base;
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
                        payload["errors"].as_u64().unwrap_or(0) as usize,
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
        let result = mailvault_core::archive::run(
            ctx,
            g.account_id.clone(),
            serde_json::to_string(&config).map_err(|e| e.to_string())?,
            g.mailbox.clone(),
            g.uids.clone(),
            cancel,
            true,
        )
        .await;
        self.archive_base += g.uids.len();
        result.map(|_| ())
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
            let requested = uids.len();
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
            if verified.len() != requested {
                return Err("errors.bulkCopyChanged".into());
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Ok(vec![]);
        }
        archive::delete_with_outcomes(
            &self.state,
            g.account_id.clone(),
            serde_json::to_string(&config).map_err(|e| e.to_string())?,
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
                        let mut ports = MailPorts {
                            state: st.clone(),
                            id: op.clone(),
                            mirror,
                            archive_base: 0,
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

pub(crate) fn freeze(
    state: &Arc<DaemonState>,
    action: mailvault_core::bulk::Action,
    scope: mailvault_core::bulk::Scope,
) -> Result<FrozenIntent, String> {
    let accounts = crate::handlers::insights::configured_account_ids(&state.app_dir)
        .map_err(|_| "errors.bulkAccountUnavailable".to_string())?;
    let local = local_mailboxes(state, &accounts)?;
    Ok(FrozenIntent::freeze(action, scope, &accounts, &local))
}
