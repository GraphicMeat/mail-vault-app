//! One named background worker per user bulk operation. Startup never adopts
//! pending work; explicit Resume is the only entry after a daemon restart.
use crate::{
    handlers::{archive, common},
    server::DaemonState,
};
use mailvault_core::{
    bulk::{FrozenIntent, Group, Mailbox},
    bulk_worker::{
        self, ArchiveOutcome, CopyProof, Identity, Ports, Selected, StoredProof, Workflow,
    },
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

/// Classify only this selected native target. A native server listing and
/// exact cached selected rows can prove plain server Delete independently
/// while the vault is closed. Missing/unreadable marker state alone cannot.
fn selected_target(
    state: &Arc<DaemonState>,
    group: &Group,
    action: mailvault_core::bulk::Action,
) -> Result<Option<Selected>, String> {
    let _gate = state.vault_gate.read().unwrap_or_else(|p| p.into_inner());
    let root = common::vault_root(state).ok();
    if let Some(root) = &root {
        if !root.is_dir() {
            return Err("errors.bulkLocalFoldersRead".into());
        }
        let account = mailvault_core::vault_files::account_dir(
            &root.join("Maildir"),
            &common::sanitize_mailbox_name(&group.account_id),
        );
        let target = account.join(mailvault_core::search_index::text::vault_dir_name(
            &group.mailbox,
        ));
        for path in [&account, &target] {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err("errors.bulkLocalFoldersRead".into()),
            }
        }
        let dir = target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("errors.bulkLocalFoldersRead")?;
        if mailvault_core::local_folder::read_marker(&account, dir)
            .map_err(|_| "errors.bulkLocalFoldersRead".to_string())?
            .is_some()
        {
            return Ok(None);
        }
    } else if action != mailvault_core::bulk::Action::Delete {
        return Err("errors.bulkLocalFoldersRead".into());
    }
    let (validity, rows, listing) = crate::custody::with_conn(state, |connection| {
        let meta = mailvault_core::custody::cache::load_meta(
            connection,
            &group.account_id,
            &group.mailbox,
        )?;
        let validity = meta
            .map(|text| serde_json::from_str::<Value>(&text))
            .transpose()
            .map_err(|_| "errors.bulkIdentityUncertain".to_string())?
            .and_then(|meta| meta["uidValidity"].as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0);
        Ok((
            validity,
            mailvault_core::custody::cache::load_by_uids(
                connection,
                &group.account_id,
                &group.mailbox,
                &group.uids,
            )?,
            mailvault_core::custody::cache::load_mailboxes(connection, &group.account_id)?,
        ))
    })?;
    let listed = listing.as_deref().is_some_and(|listing| {
        mailvault_core::takeout::folder_refs_from_listing(listing)
            .iter()
            .any(|folder| folder.path == group.mailbox)
    });
    let mut selected = Selected {
        validity,
        ..Default::default()
    };
    for row in rows {
        let Some(uid) = row["uid"].as_u64().and_then(|uid| u32::try_from(uid).ok()) else {
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
    if let Some(root) = &root {
        let sidecar =
            mailvault_core::header_cache::sidecar_dir(root, &group.account_id, &group.mailbox);
        for jmap in [false, true] {
            let ledger = mailvault_core::graph_ledger::load(
                &mailvault_core::graph_ledger::ledger_path(&sidecar, jmap),
            )?;
            let ids = group
                .uids
                .iter()
                .filter_map(|uid| ledger.get(uid).cloned().map(|id| (*uid, id)))
                .collect();
            if jmap {
                selected.jmap_ids = ids
            } else {
                selected.graph_ids = ids
            }
        }
    }
    let cached: HashSet<_> = selected.cached_uids.iter().copied().collect();
    let provider = selected.validity.is_some()
        || group
            .uids
            .iter()
            .all(|uid| selected.jmap_ids.contains_key(uid))
        || group
            .uids
            .iter()
            .all(|uid| selected.graph_ids.contains_key(uid));
    if !listed || !provider || !group.uids.iter().all(|uid| cached.contains(uid)) {
        return Err("errors.bulkLocalFoldersRead".into());
    }
    Ok(Some(selected))
}

/// New bulk snapshots persist service keys. Legacy helper diagnostics stay
/// outside this operation record, and their API behavior is unchanged.
pub(crate) fn service_error(error: &str) -> String {
    if error.starts_with("errors.")
        && error
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_'))
    {
        return error.into();
    }
    let code = error.split(':').next().unwrap_or("").trim();
    match code {
        "E_JMAP_AUTH" => "errors.jmapAuthFailed",
        "E_JMAP_TRANSPORT" => "errors.jmapConnect",
        "E_JMAP_FOREIGN_HOST" => "errors.jmapForeignHost",
        "E_JMAP_NO_TRASH" => "errors.jmapNoTrash",
        "E_JMAP_UNSUPPORTED" | "E_JMAP_NOT_IMAP" => "errors.jmapUnsupported",
        "E_JMAP_RATE" => "errors.conn.problem.providerThrottling",
        "E_JMAP_PROTOCOL" | "E_JMAP_CHANGES" | "E_JMAP_METHOD" => "errors.jmapServerFault",
        "E_OAUTH_SIGN_IN_NEEDED" => "errors.E_OAUTH_SIGN_IN_NEEDED",
        "E_OAUTH_KEYCHAIN_UNAVAILABLE" => "errors.E_OAUTH_KEYCHAIN_UNAVAILABLE",
        "E_ABD_CANNOT_DELETE" => "errors.E_ABD_CANNOT_DELETE",
        _ => "errors.bulkOperationFailed",
    }
    .into()
}

struct MailPorts {
    state: Arc<DaemonState>,
    id: String,
    attempt: String,
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
/// Preparation is selection-sized, so it owns no shared lock. The journal
/// then fences owner changes through the encoded write and compact publish.
pub(crate) fn checkpoint(
    state: &Arc<DaemonState>,
    id: &str,
    attempt: &str,
    work: &Workflow,
) -> Result<Value, String> {
    let seed = state
        .bulk
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .checkpoint_seed(id, attempt)?;
    let prepared = seed.prepare(work)?;
    let snapshot = {
        let _journal = state
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state
            .bulk
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .validate_checkpoint(&prepared)?;
        prepared.persist(&state.app_dir)?;
        state
            .bulk
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .publish_checkpoint(&prepared)?
    };
    // prepared owns the retired potentially large record; free it only here.
    drop(prepared);
    Ok(snapshot)
}
/// None, legacy and read-error states still observe the old facade's writes.
/// Versioned validated records have one owner and need no disk reconciliation.
pub(crate) fn reconcile_pending(state: &Arc<DaemonState>) -> Result<Value, String> {
    if let Some(status) = state
        .bulk
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .owned_status()
    {
        return status;
    }
    let retired = state
        .bulk
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .pending_view();
    let mut incoming = None;
    let result = {
        let _journal = state
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let owned = state
            .bulk
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .owned_status();
        if let Some(status) = owned {
            status
        } else {
            incoming = Some(mailvault_core::bulk::Coordinator::read_pending(
                &state.app_dir,
            ));
            let mut bulk = state
                .bulk
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            bulk.install_pending(incoming.as_ref().unwrap())
                .and_then(|()| bulk.cached_status())
        }
    };
    drop(retired);
    drop(incoming);
    result
}

pub(crate) fn duplicate_start(
    state: &Arc<DaemonState>, id: &str, attempt: &str,
    action: mailvault_core::bulk::Action, scope: &mailvault_core::bulk::Scope,
) -> Result<Option<Value>, String> {
    let seed = state.bulk.lock().unwrap_or_else(|p| p.into_inner()).duplicate_seed(id, attempt)?;
    let Some(prepared) = seed.prepare(action, scope)? else { return Ok(None) };
    let result = state.bulk.lock().unwrap_or_else(|p| p.into_inner()).publish_duplicate(&prepared);
    result.map(Some)
}

pub(crate) fn prepare_claim(
    state: &Arc<DaemonState>, id: &str, attempt: &str, intent: FrozenIntent,
) -> Result<(Value, bool), String> {
    reconcile_pending(state)?;
    if let Some(snapshot) = duplicate_start(state, id, attempt, intent.action(), intent.scope())? {
        return Ok((snapshot, true));
    }
    let seed = state.bulk.lock().unwrap_or_else(|p| p.into_inner()).claim_seed(id, attempt)?;
    let prepared = seed.prepare(intent)?;
    let result = {
        let _journal = state.journal.lock().unwrap_or_else(|p| p.into_inner());
        let validate = state.bulk.lock().unwrap_or_else(|p| p.into_inner()).validate_claim(&prepared);
        match validate {
            Err(error) => Err(error),
            Ok(()) => {
                match prepared.persist(&state.app_dir) {
                    Err(error) => {
                        state.bulk.lock().unwrap_or_else(|p| p.into_inner()).invalidate_pending();
                        Err(error)
                    }
                    Ok(()) => state.bulk.lock().unwrap_or_else(|p| p.into_inner()).publish_claim(&prepared),
                }
            }
        }
    };
    match result {
        Ok(snapshot) => Ok((snapshot, false)),
        Err(error) => {
            // Another identical claim can win between the off-lock seeds.
            // Compare its immutable actual owner off-lock; never launch twice.
            match duplicate_start(state, id, attempt, prepared.intent().action(), prepared.intent().scope()) {
                Ok(Some(snapshot)) => Ok((snapshot, true)),
                _ => Err(error),
            }
        }
    }
}

pub(crate) fn prepare_resume(
    state: &Arc<DaemonState>,
    id: &str,
    attempt: &str,
) -> Result<(Workflow, Value), String> {
    reconcile_pending(state)?;
    let seed = state
        .bulk
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .resume_seed(id, attempt)?;
    let prepared = seed.prepare()?;
    let snapshot = {
        let _journal = state
            .journal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state
            .bulk
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .validate_resume(&prepared)?;
        if let Err(error) = prepared.persist(&state.app_dir) {
            // An IO error need not mean SQLite committed nothing. Resolve disk
            // under the journal before another mutation uses this old revision.
            state
                .bulk
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .invalidate_pending();
            return Err(error);
        }
        state
            .bulk
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .publish_resume(&prepared)?
    };
    Ok((prepared.into_work(), snapshot))
}
impl Ports for MailPorts {
    async fn checkpoint(&mut self, w: &Workflow) -> Result<(), String> {
        let (state, id, attempt, mut w) = (
            self.state.clone(),
            self.id.clone(),
            self.attempt.clone(),
            w.clone(),
        );
        w.last_error = w.last_error.as_deref().map(service_error);
        let snapshot = common::blocking(move || checkpoint(&state, &id, &attempt, &w)).await??;
        self.state.events.emit(
            "bulk-progress",
            json!({"operationId":self.id,"attemptId":self.attempt,"finished":false,"operation":snapshot}),
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
                .map_err(|e| service_error(&e.to_string()))?;
            let boxes = acct
                .refresh()
                .await
                .map_err(|e| service_error(&e.to_string()))?;
            let mailbox_id = boxes
                .ids
                .get(&g.mailbox)
                .cloned()
                .ok_or("errors.bulkIdentityUncertain")?;
            let selected = self.selected.get(&(g.account_id.clone(), g.mailbox.clone())).ok_or("errors.bulkIdentityUncertain")?;
            let original_mailbox = selected.jmap_mailbox_id.as_ref().filter(|id| !id.is_empty()).ok_or("errors.bulkIdentityUncertain")?;
            if original_mailbox != &mailbox_id { return Err("errors.bulkIdentityChanged".into()); }
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
            let root = common::vault_root(&self.state)?;
            let sidecar = mailvault_core::header_cache::sidecar_dir(&root, &g.account_id, &g.mailbox);
            let current = mailvault_core::graph_ledger::load(&mailvault_core::graph_ledger::ledger_path(&sidecar, false))?;
            if g.uids.iter().any(|uid| selected.graph_ids.get(uid).is_none() || selected.graph_ids.get(uid) != current.get(uid)) {
                return Err("errors.bulkIdentityChanged".into());
            }
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
        let attempt = self.attempt.clone();
        let base = self.archive_base;
        let errors_base = self.archive_errors;
        let emit = Arc::new(move |name: &str, mut payload: Value| {
            if let Some(error) = payload["lastError"].as_str() {
                payload["lastError"] = json!(service_error(error));
            }
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
                        json!({"operationId":id,"attemptId":attempt,"finished":false,"operation":snapshot}),
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
        result.map(|(progress, stored)| {
            self.archive_errors += progress.errors;
            ArchiveOutcome {
                stored,
                errors: progress.errors,
                last_error: progress.last_error.as_deref().map(service_error),
            }
        })
    }
    async fn verify(
        &mut self,
        g: &Group,
        _identity: &Identity,
        stored: &[StoredProof],
    ) -> Result<Vec<u32>, String> {
        let (state, g, stored) = (self.state.clone(), g.clone(), stored.to_vec());
        common::blocking(move || {
            proved_sources(&state, &g, &g.uids, &stored).map(|sources| {
                g.uids
                    .iter()
                    .copied()
                    .filter(|uid| sources.contains_key(uid))
                    .collect()
            })
        })
        .await?
    }
    async fn copy(
        &mut self,
        g: &Group,
        uids: &[u32],
        stored: &[StoredProof],
    ) -> Result<CopyProof, String> {
        let config = self.config(g).await?;
        let root = common::vault_root(&self.state)?;
        let mirror = self.mirror.clone().ok_or("errors.bulkCopyChanged")?;
        let (state, g, uids, stored) = (
            self.state.clone(),
            g.clone(),
            uids.to_vec(),
            stored.to_vec(),
        );
        let proof = common::blocking(move || {
            let sources = proved_sources(&state, &g, &uids, &stored)?;
            let expected = stored
                .iter()
                .map(|proof| (proof.uid, proof.sha256.clone()))
                .collect();
            mailvault_core::backup::copy_uids_to_mirror_proved(
                &root,
                std::path::Path::new(&mirror),
                &g.account_id,
                &config.email,
                &g.mailbox,
                &uids,
                &sources,
                &expected,
            )
        })
        .await??;
        Ok(CopyProof {
            verified: proof.verified,
            missing: proof.missing,
            mismatched: proof.mismatched,
        })
    }
    async fn delete(
        &mut self,
        g: &Group,
        uids: &[u32],
        identity: &Identity,
        bin: bool,
        cancel: Arc<AtomicBool>,
        stored: &[StoredProof],
    ) -> Result<Vec<u32>, String> {
        let config = self.config(g).await?;
        // Copy proof is established by the worker. At the effect boundary,
        // verify the actual vault bytes again against the original Message-ID.
        if !bin {
            let (state, g, uids, stored) = (
                self.state.clone(),
                g.clone(),
                uids.to_vec(),
                stored.to_vec(),
            );
            let requested: HashSet<_> = uids.iter().copied().collect();
            let verified =
                common::blocking(move || proved_sources(&state, &g, &uids, &stored)).await??;
            if !requested.iter().all(|uid| verified.contains_key(uid)) {
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

/// No mailbox listing: the registry's writer-safe targeted lookup follows
/// native flag renames. Unknown/changed entries never become byte proof.
fn proved_sources(
    state: &Arc<DaemonState>,
    group: &Group,
    uids: &[u32],
    stored: &[StoredProof],
) -> Result<HashMap<u32, std::path::PathBuf>, String> {
    let proofs: HashMap<_, _> = stored.iter().map(|proof| (proof.uid, proof)).collect();
    let mut sources = HashMap::new();
    for uid in uids {
        let Some(proof) = proofs.get(uid) else {
            continue;
        };
        let path = common::with_mailbox_write(state, &group.account_id, &group.mailbox, |root| {
            let name = state
                .vault_registry
                .known(&group.account_id, &group.mailbox, *uid)
                .flatten()
                .ok_or("errors.bulkCopyChanged")?;
            if !mailvault_core::message_store::is_archived_entry(
                root,
                &group.account_id,
                &group.mailbox,
                &name,
            ) {
                return Err("errors.bulkCopyChanged".into());
            }
            let path = mailvault_core::message_store::entry_path(
                root,
                &group.account_id,
                &group.mailbox,
                &name,
            );
            let bytes = mailvault_core::message_store::read_path(&path)
                .map_err(|_| "errors.bulkCopyChanged".to_string())?;
            if mailvault_core::bulk_worker::bytes_hash(&bytes) != proof.sha256 {
                return Err("errors.bulkCopyChanged".into());
            }
            Ok(path)
        });
        if let Ok(path) = path {
            sources.insert(*uid, path);
        }
    }
    Ok(sources)
}

pub(crate) fn launch(
    state: Arc<DaemonState>,
    id: String,
    attempt: String,
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
                    let execution = attempt.clone();
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
                            attempt: execution,
                            mirror,
                            archive_base: 0,
                            archive_errors: 0,
                            selected,
                            origins,
                        };
                        if let Err(e) =
                            bulk_worker::run(&mut ports, &mut work, cancel, resume).await
                        {
                            let e = service_error(&e);
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
                    drained(&state, &id, &attempt);
                }),
                Err(e) => {
                    tracing::warn!("bulk runtime could not start: {e}");
                    drained(&state, &id, &attempt);
                }
            }
        })
        .map(|_| ())
        .map_err(|_| "errors.bulkWorkerUnavailable".into())
}
fn drained(state: &Arc<DaemonState>, id: &str, attempt: &str) {
    let journal = state
        .journal
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let snapshot = state
        .bulk
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drained_attempt(id, attempt);
    drop(journal);
    if let Ok(operation) = snapshot {
        state.events.emit(
            "bulk-progress",
            json!({"operationId":id,"attemptId":attempt,"finished":true,"operation":operation}),
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
    let mut hints = HashMap::new();
    for hint in &scope.target_hints {
        let key = (hint.account_id.clone(), hint.mailbox.clone(), hint.uid);
        if hint.uid == 0 || (!hint.message_id_present && hint.message_id.is_some()) {
            return Err("errors.bulkIdentityUncertain".into());
        }
        if let Some(previous) = hints.insert(key, hint) {
            if previous != hint { return Err("errors.bulkIdentityChanged".into()); }
        }
    }
    let mut local = vec![];
    let mut selected = HashMap::new();
    let mut origins = HashMap::new();
    for group in grouped.groups.iter().filter(|group| accounts.contains(&group.account_id)) {
        // Native local-folder markers retain their existing authority. Current
        // cache rows are eligibility evidence, never the original selection.
        if selected_target(state, group, action)?.is_none() {
            local.push(Mailbox { account_id: group.account_id.clone(), mailbox: group.mailbox.clone() });
            continue;
        }
        let mut proof = Selected::default();
        for uid in &group.uids {
            if *uid == 0 { return Err("errors.bulkIdentityUncertain".into()); }
            let hint = hints.get(&(group.account_id.clone(), group.mailbox.clone(), *uid))
                .ok_or("errors.bulkIdentityUncertain")?;
            let original = hint.native_identity.as_ref().ok_or("errors.bulkIdentityUncertain")?;
            if original.account_id != group.account_id || original.mailbox != group.mailbox {
                return Err("errors.bulkIdentityChanged".into());
            }
            if original.origin_hash.is_empty() || original.uid_validity == Some(0) {
                return Err("errors.bulkIdentityUncertain".into());
            }
            if let Some(previous) = origins.insert(group.account_id.clone(), original.origin_hash.clone()) {
                if previous != original.origin_hash { return Err("errors.bulkIdentityChanged".into()); }
            }
            if !proof.cached_uids.is_empty() && (proof.validity != original.uid_validity || proof.jmap_mailbox_id != original.jmap_mailbox_id) {
                return Err("errors.bulkIdentityChanged".into());
            }
            proof.validity = original.uid_validity;
            proof.origin_hash = Some(original.origin_hash.clone());
            proof.jmap_mailbox_id = original.jmap_mailbox_id.clone();
            proof.cached_uids.push(*uid);
            if let Some(id) = &hint.message_id {
                let id = mailvault_core::maildir::normalize_message_id(id);
                if !id.is_empty() { proof.message_ids.insert(*uid, id); }
            }
            if let Some(id) = hint.jmap_id.as_ref().filter(|id| !id.is_empty()) { proof.jmap_ids.insert(*uid, id.clone()); }
            if let Some(id) = hint.graph_id.as_ref().filter(|id| !id.is_empty()) { proof.graph_ids.insert(*uid, id.clone()); }
            if original.uid_validity.is_none() && !proof.graph_ids.contains_key(uid) {
                return Err("errors.bulkIdentityUncertain".into());
            }
        }
        selected.insert((group.account_id.clone(), group.mailbox.clone()), proof);
    }
    let mut work = Workflow::new(FrozenIntent::freeze(action, scope, &accounts, &local));
    for group in &mut work.groups {
        group.selected = selected.remove(&(group.group.account_id.clone(), group.group.mailbox.clone()));
        group.origin = group.selected.as_ref().and_then(|selected| selected.origin_hash.clone());
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
                let live: HashSet<_> = ids.iter().map(|(uid, _)| *uid).collect();
                if uids.iter().any(|uid| !live.contains(uid)) {
                    return Err("errors.bulkIdentityChanged".into());
                }
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
            selected_target(&state, &group(), mailvault_core::bulk::Action::Archive).unwrap_err(),
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
            selected_target(&state, &group(), mailvault_core::bulk::Action::Archive).unwrap_err(),
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
            seed_selection(&state, "INBOX");
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
            let mut params = json!({"operationId":name,"type":name,"scope":original_scope(&config, "INBOX", Some("<selected@test>"))});
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
        seed_selection(&state, "INBOX");
        let server = MockImap::start(Scenario::new().mailbox(inbox(1)).fault(
            mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
            mock_imap::Action::Delay(Duration::from_millis(500)),
        ));
        let config = config(&server);
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
        let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"slow","type":"archive_and_delete","scope":original_scope(&config, "INBOX", Some("<selected@test>"))})).await;
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
        let (progress, _) = mailvault_core::archive::run_config(
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
    #[test]
    fn bulk_original_selection_is_not_resampled_from_kickoff_cache() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let missing = serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":[7]})).unwrap();
        assert!(freeze(&state, mailvault_core::bulk::Action::Delete, missing).is_err(), "missing original snapshot must refuse instead of sampling kickoff cache");
        let scope = serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":[7],"targetHints":[{"accountId":"acc","mailbox":"INBOX","uid":7,"nativeIdentity":{"accountId":"acc","mailbox":"INBOX","uidValidity":2,"originHash":"original-origin"},"messageIdPresent":true,"messageId":"<original@test>"}]})).unwrap();
        let work = freeze(&state, mailvault_core::bulk::Action::Delete, scope).unwrap();
        let selected = work.groups[0].selected.as_ref().unwrap();
        assert_eq!(selected.validity, Some(2));
        assert_eq!(selected.message_ids.get(&7).map(String::as_str), Some("original@test"));
    }

    #[tokio::test]
    async fn bulk_original_missing_mid_requires_actual_live_uid() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("INBOX").with_uid_validity(1)));
        let mut original = selected();
        original.message_ids.clear();
        assert!(read_imap_identity(&state, &group(), &config(&server), &original).await.is_err(), "a missing MID still requires the original UID to exist");
        assert!(!server.commands().iter().any(|c| c.contains("UID STORE") || c.contains("EXPUNGE")));
    }

    #[test]
    fn bulk_original_snapshot_conflicts_and_zero_uid_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let hint = json!({"accountId":"acc","mailbox":"INBOX","uid":7,"nativeIdentity":{"accountId":"acc","mailbox":"INBOX","uidValidity":1,"originHash":"original"},"messageIdPresent":true,"messageId":"<selected@test>"});
        for change in [json!({"uid":0}), json!({"accountId":"other"}), json!({"nativeIdentity":null}), json!({"messageIdPresent":false,"messageId":"<conflict@test>"})] {
            let mut invalid = hint.clone();
            for (key, value) in change.as_object().unwrap() { invalid[key] = value.clone(); }
            let scope = serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":[7],"targetHints":[invalid]})).unwrap();
            assert!(freeze(&state, mailvault_core::bulk::Action::Delete, scope).is_err(), "conflict {change}");
        }
        let mut conflicting = hint.clone();
        conflicting["messageId"] = json!("<replacement@test>");
        let scope = serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":[7],"targetHints":[hint, conflicting]})).unwrap();
        assert!(freeze(&state, mailvault_core::bulk::Action::Archive, scope).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bulk_original_jmap_label_must_match_with_the_same_email() {
        use crate::jmap_test_support as support;
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        for original_label in [Some("label-L1-deleted"), None, Some("mb-inbox")] {
            for other_label in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
                seed_selection(&state, "INBOX");
                let mut scenario = support::scenario();
                if !other_label { scenario.accounts[0].mailboxes[0].emails[0].also_in.clear(); }
                let jmap = mock_jmap::MockJmap::start(scenario);
                let (_trap, port) = support::imap_trap();
                let account = support::account_json(&jmap, port);
                let cfg = support::config(&jmap, port);
                let credentials = dir.path().join("credentials.json");
                std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
                std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
                let ledger = crate::jmap_sessions::jmap_ledger_path(dir.path(), "acc", "INBOX");
                std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
                std::fs::write(ledger, "{\"7\":\"e1\"}").unwrap();
                let selected: Selected = serde_json::from_value(json!({"validity":1,"cachedUids":[7],"messageIds":{"7":"e1@x"},"jmapIds":{"7":"e1"},"graphIds":{},"originHash":bulk_worker::origin_hash(&cfg),"jmapMailboxId":original_label})).unwrap();
                let mut ports = MailPorts { state:state.clone(), id:"original".into(), attempt:"A".into(), mirror:None, archive_base:0, archive_errors:0, selected:HashMap::from([(("acc".into(),"INBOX".into()),selected)]), origins:HashMap::from([("acc".into(),bulk_worker::origin_hash(&cfg))]) };
                let result = ports.identity(&group()).await;
                assert_eq!(result.is_ok(), original_label == Some("mb-inbox"), "original label {original_label:?}, unrelated label {other_label}: {result:?}");
                assert_eq!(jmap.count_calls("Email/set"), 0);
                assert_eq!(support::emails_in(&jmap, "mb-inbox").len(), 2);
                assert!(mailvault_core::message_store::archived_paths(dir.path(), "acc", "INBOX").is_empty());
            }
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }

    fn original_scope(config: &crate::imap::ImapConfig, mailbox: &str, message_id: Option<&str>) -> Value {
        let identity = mailvault_core::imap::NativeHeaderIdentity::new(config, "acc", mailbox, if config.uses_graph() { None } else { Some(1) });
        json!({"accountId":"acc","mailbox":mailbox,"keys":[7],"targetHints":[{"accountId":"acc","mailbox":mailbox,"uid":7,"nativeIdentity":identity,"messageIdPresent":message_id.is_some(),"messageId":message_id,"jmapId":if config.uses_jmap() { Some("e1") } else { None }}]})
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bulk_original_selection_replacement_has_zero_effects_in_all_four_modes() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        for action in ["archive", "delete", "archive_and_delete", "archive_backup_delete"] {
            for change in ["generation", "message", "endpoint"] {
                let dir = tempfile::tempdir().unwrap();
                let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
                seed_selection(&state, "INBOX");
                let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
                let cfg = config(&server);
                let account = json!({"email":"one@example.test","password":"pw","imapHost":server.host(),"imapPort":server.port()});
                let credentials = dir.path().join("credentials.json");
                std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
                std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
                let mut scope = original_scope(&cfg, "INBOX", Some("<selected@test>"));
                match change {
                    "generation" => scope["targetHints"][0]["nativeIdentity"]["uidValidity"] = json!(2),
                    "message" => scope["targetHints"][0]["messageId"] = json!("<original-A@test>"),
                    _ => scope["targetHints"][0]["nativeIdentity"]["originHash"] = json!("original-endpoint"),
                }
                let reply = handle_request_for_test(&state, "bulk.start", json!({"operationId":"original","type":action,"scope":scope})).await;
                assert!(reply.error.is_none(), "{action}/{change}: {:?}", reply.error);
                let pending = wait_drained(&state).await;
                assert_eq!(pending["lastError"], "errors.bulkIdentityChanged", "{action}/{change}: {pending}");
                assert!(server.commands().iter().all(|c| !c.contains("BODY.PEEK[]") && !c.contains("UID STORE") && !c.contains("EXPUNGE")));
                assert!(mailvault_core::message_store::archived_paths(dir.path(), "acc", "INBOX").is_empty());
                let bin = handle_request_for_test(&state, "deleted.list", json!({})).await.result.unwrap();
                assert!(bin.as_array().unwrap().is_empty());
            }
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }

    fn seed_selection(state: &Arc<DaemonState>, mailbox: &str) {
        std::fs::write(state.app_dir.join("accounts.json"), "[{\"id\":\"acc\"}]").unwrap();
        crate::custody::with_conn(state, |c| {
            mailvault_core::custody::cache::save_mailboxes(
                c,
                "acc",
                &json!({"mailboxes":[{"path":mailbox,"name":mailbox}]}).to_string(),
            )?;
            mailvault_core::custody::cache::save_headers(
                c,
                "acc",
                mailbox,
                &json!({"uidValidity":1,"emails":[{"uid":7,"messageId":"<selected@test>"}]})
                    .to_string(),
            )
        })
        .unwrap();
    }
    #[test]
    fn reviewed_selected_server_ignores_unselected_corrupt_local_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let sibling = mailvault_core::vault_files::account_dir(&dir.path().join("Maildir"), "acc")
            .join("Unselected");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(
            sibling.join(mailvault_core::local_folder::MARKER_FILE),
            "{broken",
        )
        .unwrap();
        let scope = serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":[7],"targetHints":[{"accountId":"acc","mailbox":"INBOX","uid":7,"nativeIdentity":{"accountId":"acc","mailbox":"INBOX","uidValidity":1,"originHash":"original"},"messageIdPresent":true,"messageId":"<selected@test>"}]}))
            .unwrap();
        assert!(freeze(&state, mailvault_core::bulk::Action::Archive, scope).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn reviewed_selected_target_symlink_is_unknown_even_with_server_cache() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let account = mailvault_core::vault_files::account_dir(&dir.path().join("Maildir"), "acc");
        std::fs::create_dir_all(&account).unwrap();
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), account.join("INBOX")).unwrap();
        let scope = serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":[7]}))
            .unwrap();
        assert!(freeze(&state, mailvault_core::bulk::Action::Delete, scope).is_err());
    }
    #[test]
    fn selected_local_marker_wins_over_a_coincident_server_listing() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let folder = mailvault_core::message_store::mailbox_dir(dir.path(), "acc", "INBOX");
        std::fs::create_dir_all(&folder).unwrap();
        mailvault_core::local_folder::write_marker(
            &folder,
            &mailvault_core::local_folder::Marker {
                kind: "import".into(),
                name: "INBOX".into(),
                created: 1,
                source: "selected.mbox".into(),
            },
        )
        .unwrap();
        assert!(
            selected_target(&state, &group(), mailvault_core::bulk::Action::Delete)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn selected_nonregular_marker_and_unproved_missing_target_are_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let folder = mailvault_core::message_store::mailbox_dir(dir.path(), "acc", "INBOX");
        std::fs::create_dir_all(folder.join(mailvault_core::local_folder::MARKER_FILE)).unwrap();
        assert!(selected_target(&state, &group(), mailvault_core::bulk::Action::Delete).is_err());
        let unknown = Group {
            mailbox: "NotListed".into(),
            ..group()
        };
        assert!(selected_target(&state, &unknown, mailvault_core::bulk::Action::Delete).is_err());
    }
    #[test]
    fn proven_plain_server_delete_remains_available_when_the_vault_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        state.vault_closed.store(true, Ordering::SeqCst);
        assert!(
            selected_target(&state, &group(), mailvault_core::bulk::Action::Delete)
                .unwrap()
                .is_some()
        );
        assert!(selected_target(&state, &group(), mailvault_core::bulk::Action::Archive).is_err());
    }
    #[test]
    fn target_disappearance_during_close_cannot_become_archive_authority() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        seed_selection(&state, "INBOX");
        let folder = mailvault_core::message_store::mailbox_dir(dir.path(), "acc", "INBOX");
        std::fs::create_dir_all(&folder).unwrap();
        let gate = state.vault_gate.write().unwrap();
        let other = state.clone();
        let pending = std::thread::spawn(move || {
            selected_target(&other, &group(), mailvault_core::bulk::Action::Archive)
        });
        std::fs::remove_dir_all(&folder).unwrap();
        state.vault_closed.store(true, Ordering::SeqCst);
        drop(gate);
        assert!(pending.join().unwrap().is_err());
    }
    #[tokio::test]
    async fn mutated_receipt_bytes_refuse_verify_copy_and_delete_in_both_formats() {
        use mailvault_core::message_store::{self, Format};
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for format in [Format::Maildir, Format::Jmap] {
            let dir = tempfile::tempdir().unwrap();
            let mirror = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
            seed_selection(&state, "INBOX");
            message_store::set_vault_format(dir.path(), format).unwrap();
            message_store::create_messages_dir(dir.path(), "acc", "INBOX").unwrap();
            let original = b"Subject: selected without Message-ID\r\n\r\noriginal B\r\n";
            let replacement = b"Subject: unrelated replacement\r\n\r\nchanged A\r\n";
            let written = message_store::write_new(
                dir.path(),
                "acc",
                "INBOX",
                7,
                original,
                &["archived".into()],
                true,
            )
            .unwrap();
            state
                .vault_registry
                .uid_sets(dir.path(), "acc", "INBOX")
                .unwrap();
            let receipt = StoredProof {
                uid: 7,
                name: written.file_name().unwrap().to_string_lossy().into_owned(),
                sha256: mailvault_core::bulk_worker::bytes_hash(original),
            };
            let server = MockImap::start(Scenario::new().mailbox(inbox(1)));
            let config = config(&server);
            let credentials = dir.path().join("credentials.json");
            let account = json!({"email":config.email,"password":"pw","imapHost":server.host(),"imapPort":server.port()});
            std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
            let changed = message_store::write_new(
                dir.path(),
                "acc",
                "INBOX",
                7,
                replacement,
                &["archived".into()],
                true,
            )
            .unwrap();
            state.vault_registry.upsert("acc", "INBOX", 7, &changed);
            let mut ports = MailPorts {
                state: state.clone(),
                id: "mutation".into(),
                attempt: "mutation-attempt".into(),
                mirror: Some(mirror.path().to_string_lossy().into_owned()),
                archive_base: 0,
                archive_errors: 0,
                selected: HashMap::new(),
                origins: HashMap::from([(
                    "acc".into(),
                    mailvault_core::bulk_worker::origin_hash(&config),
                )]),
            };
            let identity = Identity::Imap {
                validity: 1,
                message_ids: HashMap::new(),
            };
            assert!(ports
                .verify(&group(), &identity, &[receipt.clone()])
                .await
                .unwrap()
                .is_empty());
            assert!(ports
                .copy(&group(), &[7], &[receipt.clone()])
                .await
                .unwrap()
                .verified
                .is_empty());
            assert!(ports
                .delete(
                    &group(),
                    &[7],
                    &identity,
                    false,
                    Arc::new(AtomicBool::new(false)),
                    &[receipt]
                )
                .await
                .is_err());
            assert!(server
                .commands()
                .iter()
                .all(|command| !command.contains("UID STORE")));
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[test]
    fn receipt_validation_uses_targeted_reads_across_many_delete_units_and_flag_renames() {
        use mailvault_core::message_store;
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        message_store::create_messages_dir(dir.path(), "acc", "INBOX").unwrap();
        let mut receipts = vec![];
        for uid in 1..=1000 {
            let raw = format!("Subject: selected {uid}\r\n\r\nbody {uid}\r\n");
            let path = message_store::write_new(
                dir.path(),
                "acc",
                "INBOX",
                uid,
                raw.as_bytes(),
                &["archived".into()],
                true,
            )
            .unwrap();
            if uid <= 80 {
                receipts.push(StoredProof {
                    uid,
                    name: path.file_name().unwrap().to_string_lossy().into_owned(),
                    sha256: mailvault_core::bulk_worker::bytes_hash(raw.as_bytes()),
                });
            }
        }
        state
            .vault_registry
            .uid_sets(dir.path(), "acc", "INBOX")
            .unwrap();
        let initial = state.vault_registry.listing_count();
        for batch in receipts.chunks(5) {
            for proof in batch {
                let old = message_store::entry_path(dir.path(), "acc", "INBOX", &proof.name);
                let renamed = mailvault_core::vault_files::cur_path(dir.path(), "acc", "INBOX")
                    .join(mailvault_core::vault_files::build_maildir_filename(
                        proof.uid,
                        &["archived".into(), "seen".into()],
                    ));
                std::fs::rename(old, &renamed).unwrap();
                state
                    .vault_registry
                    .upsert("acc", "INBOX", proof.uid, &renamed);
            }
            let uids: Vec<_> = batch.iter().map(|proof| proof.uid).collect();
            assert_eq!(
                proved_sources(
                    &state,
                    &Group {
                        uids: uids.clone(),
                        ..group()
                    },
                    &uids,
                    batch
                )
                .unwrap()
                .len(),
                5
            );
        }
        println!("BULK_PROOF_INITIAL_LISTINGS={initial} BULK_PROOF_FINAL_LISTINGS={} BULK_PROOF_DELETE_UNITS=16",state.vault_registry.listing_count());
        assert_eq!(state.vault_registry.listing_count(), initial);
    }
    #[tokio::test]
    async fn actual_jmap_archive_receipt_refuses_later_record_blob_replacement() {
        use crate::jmap_test_support as support;
        use mailvault_core::message_store::{self, Format};
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut scenario = support::scenario();
        scenario.accounts[0].mailboxes[0].emails[0].raw =
            "From: a@example.test\r\nSubject: selected without Message-ID\r\n\r\noriginal B\r\n"
                .into();
        let provider = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = support::imap_trap();
        let config = support::config(&provider, port);
        let dir = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        message_store::set_vault_format(dir.path(), Format::Jmap).unwrap();
        seed_selection(&state, "INBOX");
        let ledger = crate::jmap_sessions::jmap_ledger_path(dir.path(), "acc", "INBOX");
        std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        std::fs::write(&ledger, "{\"7\":\"e1\"}").unwrap();
        let identity = Identity::Jmap {
            mailbox_id: "mb-inbox".into(),
            ids: HashMap::from([(7, "e1".into())]),
        };
        let (progress, receipts) = mailvault_core::archive::run_config(
            archive::archive_ctx(&state, dir.path().into()),
            "acc".into(),
            config.clone(),
            "INBOX".into(),
            vec![7],
            Arc::new(AtomicBool::new(false)),
            true,
            identity.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            (progress.completed, progress.errors, receipts.len()),
            (1, 0, 1)
        );
        let credentials = dir.path().join("credentials.json");
        std::fs::write(
            &credentials,
            json!({"acc":support::account_json(&provider,port).to_string()}).to_string(),
        )
        .unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
        let changed = message_store::write_new(
            dir.path(),
            "acc",
            "INBOX",
            7,
            b"Subject: unrelated A\r\n\r\nchanged body\r\n",
            &["archived".into()],
            true,
        )
        .unwrap();
        state.vault_registry.upsert("acc", "INBOX", 7, &changed);
        let mut ports = MailPorts {
            state: state.clone(),
            id: "record-mutation".into(),
            attempt: "record-attempt".into(),
            mirror: Some(mirror.path().to_string_lossy().into_owned()),
            archive_base: 0,
            archive_errors: 0,
            selected: HashMap::new(),
            origins: HashMap::from([(
                "acc".into(),
                mailvault_core::bulk_worker::origin_hash(&config),
            )]),
        };
        assert!(ports
            .verify(&group(), &identity, &receipts)
            .await
            .unwrap()
            .is_empty());
        assert!(ports
            .copy(&group(), &[7], &receipts)
            .await
            .unwrap()
            .verified
            .is_empty());
        assert!(ports
            .delete(
                &group(),
                &[7],
                &identity,
                false,
                Arc::new(AtomicBool::new(false)),
                &receipts
            )
            .await
            .is_err());
        assert_eq!(support::emails_in(&provider, "mb-inbox").len(), 2);
        assert!(trap.accept().is_err());
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_original_claim_blocked_prepare_and_save_keep_controls_live() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        state.bulk.lock().unwrap().begin_admission("claim", "A").unwrap();
        let seed = state.bulk.lock().unwrap().claim_seed("claim", "A").unwrap();
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let intent = FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]);
        let (release, paused) = std::sync::mpsc::channel();
        let original = intent.clone();
        let prepare = std::thread::spawn(move || { paused.recv().unwrap(); seed.prepare(original).unwrap() });
        let controls = tokio::time::timeout(Duration::from_millis(200), async {
            let status = handle_request_for_test(&state, "bulk.status", json!({})).await;
            let cancel = handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"claim"})).await;
            (status, cancel)
        }).await;
        release.send(()).unwrap();
        let prepared = prepare.join().unwrap();
        let (status, cancel) = controls.expect("off-lock original preparation cannot block controls");
        assert!(status.error.is_none());
        assert_eq!(cancel.error.unwrap().message, "errors.bulkStale");
        drop(prepared);

        let writer = mailvault_core::app_db::db::open(dir.path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let worker_state = state.clone();
        let claim = std::thread::spawn(move || prepare_claim(&worker_state, "claim", "A", intent));
        for _ in 0..200 {
            if state.journal.try_lock().is_err() { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(state.journal.try_lock().is_err(), "encoded claim save must actually be blocked");
        let controls = tokio::time::timeout(Duration::from_millis(200), async {
            let status = handle_request_for_test(&state, "bulk.status", json!({})).await;
            let cancel = handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"claim"})).await;
            let fence = handle_request_for_test(&state, "bulk.status", json!({"operationId":"claim","attemptId":"A","fenceUnstarted":true})).await;
            let after_fence = handle_request_for_test(&state, "bulk.status", json!({})).await;
            let after_cancel = handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"claim"})).await;
            (status, cancel, fence, after_fence, after_cancel)
        }).await;
        writer.execute_batch("ROLLBACK").unwrap();
        assert!(claim.join().unwrap().is_err());
        let (status, cancel, fence, after_fence, after_cancel) = controls.expect("initial encoded save must leave controls live after an unstarted fence");
        assert!(status.error.is_none());
        assert!(status.result.unwrap()["active"].is_null());
        assert_eq!(cancel.error.unwrap().message, "errors.bulkStale");
        assert!(fence.error.is_none());
        assert!(after_fence.error.is_none());
        assert!(after_fence.result.unwrap()["active"].is_null());
        assert_eq!(after_cancel.error.unwrap().message, "errors.bulkStale");
        assert!(state.bulk.lock().unwrap().active_id().is_none());
        let raw = mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().unwrap();
        assert_eq!(raw["id"], "claim");
        assert_eq!(state.bulk.lock().unwrap().cached_status().unwrap()["pending"]["id"], "claim");
    }

    #[tokio::test]
    async fn bulk_original_empty_claim_seed_cannot_overwrite_a_legacy_write() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        state.bulk.lock().unwrap().begin_admission("new", "A").unwrap();
        let seed = state.bulk.lock().unwrap().claim_seed("new", "A").unwrap();
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let prepared = seed.prepare(FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[])).unwrap();
        let legacy = json!({"id":"legacy","type":"delete","totalUids":[7],"completedUids":[],"status":"deleting"});
        let reply = handle_request_for_test(&state, "save_pending_operation", json!({"operation":legacy})).await;
        assert!(reply.error.is_none(), "{:?}", reply.error);
        assert!(state.bulk.lock().unwrap().validate_claim(&prepared).is_err());
        assert_eq!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().unwrap(), legacy);
        reconcile_pending(&state).unwrap();
        assert!(state.bulk.lock().unwrap().claim_seed("new", "A").is_err());
        let clear = handle_request_for_test(&state, "clear_pending_operation", json!({})).await;
        assert!(clear.error.is_none());
        assert!(state.bulk.lock().unwrap().validate_claim(&prepared).is_err());
        reconcile_pending(&state).unwrap();
        assert!(state.bulk.lock().unwrap().claim_seed("new", "A").is_ok());
    }

    #[test]
    fn bulk_original_claim_failed_save_invalidates_empty_authority() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        mailvault_core::app_db::with(dir.path(), |conn| conn.execute_batch("CREATE TRIGGER deny_pending BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'forced failure'); END;").map_err(|e| e.to_string())).unwrap();
        state.bulk.lock().unwrap().begin_admission("new", "A").unwrap();
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let result = prepare_claim(&state, "new", "A", FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]));
        assert_eq!(result.unwrap_err(), "errors.bulkPendingWrite");
        assert!(state.bulk.lock().unwrap().active_id().is_none());
        assert!(state.bulk.lock().unwrap().claim_seed("new", "next").is_err());
        assert!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().is_none());
        mailvault_core::app_db::with(dir.path(), |conn| conn.execute_batch("DROP TRIGGER deny_pending;").map_err(|e| e.to_string())).unwrap();
        reconcile_pending(&state).unwrap();
        assert!(state.bulk.lock().unwrap().claim_seed("new", "next").is_ok());
    }

    #[tokio::test]
    async fn bulk_original_legacy_failed_write_keeps_empty_seed_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let seed = state.bulk.lock().unwrap().claim_seed("new", "A").unwrap();
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let prepared = seed.prepare(FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[])).unwrap();
        mailvault_core::app_db::with(dir.path(), |conn| conn.execute_batch("CREATE TRIGGER deny_pending BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'forced failure'); END;").map_err(|e| e.to_string())).unwrap();
        let reply = handle_request_for_test(&state, "save_pending_operation", json!({"operation":{"id":"legacy","type":"delete","totalUids":[7],"completedUids":[],"status":"deleting"}})).await;
        assert!(reply.error.is_some());
        assert!(state.bulk.lock().unwrap().validate_claim(&prepared).is_err());
        assert!(state.bulk.lock().unwrap().active_id().is_none());
        assert!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_resume_io_never_blocks_status_or_inactive_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let intent = FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]);
        state
            .bulk
            .lock()
            .unwrap()
            .claim(&state.app_dir, "restore", intent.clone())
            .unwrap();
        let work = Workflow::new(intent);
        checkpoint(&state, "restore", "restore", &work).unwrap();
        state
            .bulk
            .lock()
            .unwrap()
            .drained_attempt("restore", "restore")
            .unwrap();
        let writer = mailvault_core::app_db::db::open(dir.path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let worker_state = state.clone();
        let resume = tokio::spawn(async move {
            handle_request_for_test(
                &worker_state,
                "bulk.resume",
                json!({"operationId":"restore","attemptId":"next"}),
            )
            .await
        });
        for _ in 0..200 {
            if state.journal.try_lock().is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(state.journal.try_lock().is_err());
        let control = tokio::time::timeout(Duration::from_millis(200), async {
            tokio::join!(
                handle_request_for_test(&state, "bulk.status", json!({})),
                handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"restore"}))
            )
        })
        .await;
        writer.execute_batch("ROLLBACK").unwrap();
        assert!(resume.await.unwrap().error.is_none());
        let _ = wait_drained(&state).await;
        let (status, cancel) = control
            .expect("resume IO must not block pending status or inactive cancellation refusal");
        assert!(status.error.is_none());
        assert!(cancel.error.is_some());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_resume_fence_during_save_retains_durable_pending_without_launch() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let intent = FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]);
        state
            .bulk
            .lock()
            .unwrap()
            .claim(&state.app_dir, "fenced", intent.clone())
            .unwrap();
        let work = Workflow::new(intent);
        checkpoint(&state, "fenced", "fenced", &work).unwrap();
        state
            .bulk
            .lock()
            .unwrap()
            .drained_attempt("fenced", "fenced")
            .unwrap();
        let writer = mailvault_core::app_db::db::open(dir.path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let worker_state = state.clone();
        let resume = tokio::spawn(async move {
            handle_request_for_test(
                &worker_state,
                "bulk.resume",
                json!({"operationId":"fenced","attemptId":"late"}),
            )
            .await
        });
        for _ in 0..200 {
            if state.journal.try_lock().is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let fenced = tokio::time::timeout(
            Duration::from_millis(200),
            handle_request_for_test(
                &state,
                "bulk.status",
                json!({"operationId":"fenced","attemptId":"late","fenceUnstarted":true}),
            ),
        )
        .await;
        writer.execute_batch("ROLLBACK").unwrap();
        let reply = resume.await.unwrap();
        let fenced = fenced
            .expect("the exact attempt fence must remain responsive during resume save")
            .result
            .unwrap();
        assert_eq!(fenced["admission"]["state"], "fenced");
        assert!(
            reply.error.is_some(),
            "a fenced attempt must never publish Active or launch"
        );
        let status = handle_request_for_test(
            &state,
            "bulk.status",
            json!({"operationId":"fenced","attemptId":"late"}),
        )
        .await
        .result
        .unwrap();
        assert!(status["active"].is_null());
        assert_eq!(status["pending"]["attemptId"], "late");
        assert_eq!(status["pending"]["status"], "awaitingResume");
        assert_eq!(status["admission"]["state"], "fenced");
        let raw = mailvault_core::op_journal::pending_operation_read(dir.path())
            .unwrap()
            .unwrap();
        assert_eq!(raw["attemptId"], "late");
        let mut reopened = mailvault_core::bulk::Coordinator::load(dir.path());
        assert_eq!(
            reopened.status(dir.path()).unwrap()["pending"]["attemptId"],
            "late"
        );
        let fresh = handle_request_for_test(
            &state,
            "bulk.resume",
            json!({"operationId":"fenced","attemptId":"fresh"}),
        )
        .await;
        assert!(fresh.error.is_none());
        assert_eq!(wait_drained(&state).await["status"], "complete");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_worker_checkpoint_io_never_blocks_active_status_or_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let intent = FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]);
        state
            .bulk
            .lock()
            .unwrap()
            .claim(&state.app_dir, "io", intent.clone())
            .unwrap();
        let mut ports = MailPorts {
            state: state.clone(),
            id: "io".into(),
            attempt: "io".into(),
            mirror: None,
            archive_base: 0,
            archive_errors: 0,
            selected: HashMap::new(),
            origins: HashMap::new(),
        };
        let work = Workflow::new(intent);
        // A real SQLite writer blocks persistence deterministically; WAL
        // readers and the owned compact snapshot remain independently usable.
        let writer = mailvault_core::app_db::db::open(dir.path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let checkpoint = tokio::spawn(async move { ports.checkpoint(&work).await });
        for _ in 0..200 {
            if state.journal.try_lock().is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            state.journal.try_lock().is_err(),
            "checkpoint never reached durable write"
        );
        let control = tokio::time::timeout(Duration::from_millis(200), async {
            tokio::join!(
                handle_request_for_test(&state, "bulk.status", json!({})),
                handle_request_for_test(&state, "bulk.cancel", json!({"operationId":"io"})),
            )
        })
        .await;
        writer.execute_batch("ROLLBACK").unwrap();
        checkpoint.await.unwrap().unwrap();
        let (status, cancel) = control.expect(
            "active status and cancellation must answer while checkpoint IO remains blocked",
        );
        assert_eq!(status.result.unwrap()["active"]["id"], "io");
        assert!(cancel.error.is_none());
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn bulk_worker_auth_and_provider_failures_persist_service_keys() {
        use crate::jmap_test_support as support;
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for auth in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
            seed_selection(&state, "INBOX");
            let mut jmap_scenario = support::scenario();
            jmap_scenario.faults.push(mock_jmap::Fault::Unauthorized);
            let jmap = mock_jmap::MockJmap::start(jmap_scenario);
            let imap = MockImap::start(Scenario::new().mailbox(inbox(1)).fault(
                mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
                mock_imap::Action::Respond("NO".into(), "private-provider-description".into()),
            ));
            let _ = config(&imap);
            let account = if auth {
                support::account_json(&jmap, imap.port())
            } else {
                json!({"email":"one@example.test","password":"pw","imapHost":imap.host(),"imapPort":imap.port()})
            };
            let ledger = crate::jmap_sessions::jmap_ledger_path(dir.path(), "acc", "INBOX");
            std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
            std::fs::write(ledger, "{\"7\":\"e1\"}").unwrap();
            let credentials = dir.path().join("credentials.json");
            std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
            let reply = handle_request_for_test(&state, "bulk.start", json!({"operationId":"provider-error","type":"archive","scope":original_scope(&serde_json::from_value(account.clone()).unwrap(), "INBOX", Some("<selected@test>"))})).await;
            assert!(reply.error.is_none(), "{:?}", reply.error);
            let pending = wait_drained(&state).await;
            let expected = if auth {
                "errors.jmapAuthFailed"
            } else {
                "errors.bulkOperationFailed"
            };
            assert_eq!(pending["lastError"], expected);
            assert_eq!(pending["worker"]["lastError"], expected);
            assert!(!pending.to_string().contains("private-provider-description"));
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn no_message_id_workers_keep_server_b_when_archive_a_collides_or_fetch_fails() {
        use mailvault_core::message_store;
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for action in ["archive_and_delete", "archive_backup_delete"] {
            for (fail_fetch, old_archive, removed) in [
                (false, false, true),
                (true, true, false),
                (false, true, false),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let mirror = tempfile::tempdir().unwrap();
                let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
                seed_selection(&state, "INBOX");
                crate::custody::with_conn(&state, |connection| {
                    mailvault_core::custody::cache::save_headers(
                        connection,
                        "acc",
                        "INBOX",
                        &json!({"uidValidity":1,"emails":[{"uid":7}]}).to_string(),
                    )
                })
                .unwrap();
                let mut mailbox = inbox(1);
                mailbox.messages[0].raw =
                    b"From: a@example.test\r\nSubject: selected B\r\n\r\nwithout Message-ID\r\n"
                        .to_vec();
                let mut scenario = Scenario::new().mailbox(mailbox);
                if fail_fetch {
                    scenario = scenario.fault(
                        mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
                        mock_imap::Action::Respond("NO".into(), "fetch refused".into()),
                    );
                }
                let server = MockImap::start(scenario);
                let _ = config(&server);
                let credentials = dir.path().join("credentials.json");
                let account = json!({"email":"one@example.test","password":"pw","imapHost":server.host(),"imapPort":server.port()});
                std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string())
                    .unwrap();
                std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
                let old = b"Message-ID: <only-old-a@test>\r\n\r\nold archived A\r\n";
                let old_path = if old_archive {
                    message_store::create_messages_dir(dir.path(), "acc", "INBOX").unwrap();
                    Some(
                        message_store::write_new(
                            dir.path(),
                            "acc",
                            "INBOX",
                            7,
                            old,
                            &["archived".into()],
                            true,
                        )
                        .unwrap(),
                    )
                } else {
                    None
                };
                let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"no-id","type":action,"scope":original_scope(&serde_json::from_value(account.clone()).unwrap(), "INBOX", None),"mirrorRoot":mirror.path().to_string_lossy()})).await;
                assert!(reply.error.is_none(), "{:?}", reply.error);
                let pending = wait_drained(&state).await;
                assert_eq!(pending["status"], "complete", "{pending}");
                assert_eq!(pending["result"]["removed"], usize::from(removed));
                assert_eq!(
                    !server
                        .state()
                        .mailboxes
                        .iter()
                        .find(|mailbox| mailbox.name == "INBOX")
                        .unwrap()
                        .messages
                        .is_empty(),
                    !removed
                );
                if let Some(path) = old_path {
                    assert_eq!(std::fs::read(path).unwrap(), old);
                    assert_eq!(pending["completedUids"], json!([]));
                    assert_eq!(pending["result"]["keptNotArchived"], 1);
                }
            }
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
}
