//! One named background worker per user bulk operation. Startup never adopts
//! pending work; explicit Resume is the only entry after a daemon restart.
use crate::{
    account_lifecycle::{AccountStamp, OperationPermit},
    account_workflows::AccountWriteScope,
    handlers::{archive, common},
    server::DaemonState,
};
use mailvault_core::{
    bulk::{FrozenIntent, Group, Mailbox, Scope},
    bulk_worker::{
        self, ArchiveOutcome, CopyProof, Identity, Ports, Selected, StoredProof, Workflow,
        PurgeTarget, PurgeProof, PurgeEffect, PurgeMirror,
    },
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Clone)]
pub(crate) struct BulkAdmission {
    owner: OperationPermit,
    originals: HashMap<String, AccountStamp>,
}

fn admit_ids(state: &Arc<DaemonState>, ids: BTreeSet<String>) -> Result<BulkAdmission, String> {
    // A native account listing under its short complete lease initializes the
    // process-local fence if this RPC races the normal startup bootstrap.
    if !state.account_lifecycle.is_ready() {
        let lease = state.account_admission.try_reserve(AccountWriteScope { whole_store: true, ..Default::default() })
            .map_err(|_| "errors.keychainBusy".to_owned())?;
        let listing = mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir))
            .map_err(|_| "errors.keychainBusy".to_owned())?;
        state.account_lifecycle.seed(&listing);
        drop(lease);
    }
    if ids.is_empty() {
        return state.account_lifecycle.try_unscoped_operation()
            .map(|owner| BulkAdmission { owner, originals: HashMap::new() })
            .map_err(|_| "errors.keychainBusy".to_owned());
    }
    let stamps = ids.iter().map(|id| state.account_lifecycle.capture(id))
        .collect::<Result<Vec<_>, _>>().map_err(|_| "errors.keychainBusy".to_owned())?;
    let owner = state.account_lifecycle.try_operation(&stamps).map_err(|_| "errors.keychainBusy".to_owned())?;
    Ok(BulkAdmission { owner, originals: stamps.into_iter().map(|stamp| (stamp.id().to_owned(), stamp)).collect() })
}

fn scope_ids(scope: &Scope) -> BTreeSet<String> {
    let mut ids: BTreeSet<String> = mailvault_core::bulk::group_targets(scope).groups
        .into_iter().map(|group| group.account_id).collect();
    ids.extend(scope.account_id.iter().filter(|id| !id.is_empty()).cloned());
    ids.extend(scope.target_hints.iter().filter(|hint| !hint.account_id.is_empty()).map(|hint| hint.account_id.clone()));
    ids
}

pub(crate) fn admit_scope(state: &Arc<DaemonState>, scope: &Scope) -> Result<BulkAdmission, String> {
    admit_ids(state, scope_ids(scope))
}

fn admit_work(state: &Arc<DaemonState>, work: &Workflow) -> Result<BulkAdmission, String> {
    let mut ids = scope_ids(work.intent.scope());
    ids.extend(work.groups.iter().map(|group| group.group.account_id.clone()));
    ids.extend(work.purge_targets.iter().map(|target| target.account_id.clone()));
    admit_ids(state, ids)
}

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
        if local_folder_at(root,group)? { return Ok(None); }
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
            #[cfg(test)] local_ledger_probe(root);
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

fn local_folder_at(root:&std::path::Path,group:&Group)->Result<bool,String> {
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
            return Ok(true);
        }
    Ok(false)
}
fn native_local_folder(state:&Arc<DaemonState>,group:&Group)->Result<bool,String> {
    let _gate=state.vault_gate.read().unwrap_or_else(|p|p.into_inner());
    let root=common::vault_root(state).map_err(|_|"errors.bulkLocalFoldersRead".to_string())?;
    local_folder_at(&root,group)
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
fn identity_error(error:&str)->bool {
    matches!(error,"errors.bulkIdentityChanged"|"errors.bulkIdentityUncertain")
}

struct MailPorts {
    state: Arc<DaemonState>,
    owner: BulkAdmission,
    id: String,
    attempt: String,
    mirror: Option<String>,
    external_status: Option<String>,
    archive_base: usize,
    archive_errors: usize,
    selected: HashMap<(String, String), Selected>,
    origins: HashMap<String, String>,
    inventories:HashMap<(String,String),Result<Arc<LocalInventory>,String>>,
}
struct LocalInventory {
    root:std::path::PathBuf,
    fences:HashMap<u32,mailvault_core::vault_registry::TargetFence>,
    candidates:HashMap<u32,Vec<mailvault_core::message_store::UidArtifact>>,
}
impl MailPorts {
    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
        let owner = self.owner.owner.clone();
        common::blocking(move || {
            let _owner = owner;
            f()
        }).await
    }
    fn local_inventory(&self,t:&PurgeTarget)->Result<Arc<LocalInventory>,String> {
        self.inventories.get(&(t.account_id.clone(),t.mailbox.clone())).cloned().unwrap_or_else(||Err("errors.bulkIdentityUncertain".into()))
    }
    async fn config(&self, g: &Group) -> Result<crate::imap::ImapConfig, String> {
        let (state, account) = (self.state.clone(), g.account_id.clone());
        let member = self.blocking(move || {
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

type ClaimSeeds = (
    mailvault_core::bulk::DuplicateSeed,
    Result<mailvault_core::bulk::ClaimSeed, String>,
);

fn capture_claim_seeds(state: &Arc<DaemonState>, id: &str, attempt: &str) -> Result<ClaimSeeds, String> {
    let bulk = state.bulk.lock().unwrap_or_else(|p| p.into_inner());
    // An active exact duplicate intentionally has no eligible new-claim seed.
    // Capture that result alongside its immutable owner under the same lock.
    Ok((bulk.duplicate_seed(id, attempt)?, bulk.claim_seed(id, attempt)))
}

pub(crate) fn prepare_claim(
    state: &Arc<DaemonState>, id: &str, attempt: &str, intent: FrozenIntent,
) -> Result<(Value, bool), String> {
    reconcile_pending(state)?;
    let seeds = capture_claim_seeds(state, id, attempt)?;
    prepare_seeded_claim(state, id, attempt, intent, seeds)
}

fn prepare_seeded_claim(
    state: &Arc<DaemonState>, id: &str, attempt: &str, intent: FrozenIntent,
    (duplicate, seed): ClaimSeeds,
) -> Result<(Value, bool), String> {
    if let Some(prepared) = duplicate.prepare(intent.action(), intent.scope())? {
        let result = state.bulk.lock().unwrap_or_else(|p| p.into_inner()).publish_duplicate(&prepared);
        return result.map(|snapshot| (snapshot, true));
    }
    let seed = seed?;
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
) -> Result<(Workflow, Value, BulkAdmission), String> {
    reconcile_pending(state)?;
    let seed = state
        .bulk
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .resume_seed(id, attempt)?;
    let prepared = seed.prepare()?;
    let owner = admit_work(state, prepared.work())?;
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
    Ok((prepared.into_work(), snapshot, owner))
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
        for target in &mut w.purge_targets {target.last_error=target.last_error.as_deref().map(service_error);}
        let target=w.purge_current.and_then(|index|w.purge_targets.get(index)).map(|target|json!(target));
        let snapshot = self.blocking(move || checkpoint(&state, &id, &attempt, &w)).await??;
        self.state.events.emit(
            "bulk-progress",
            json!({"operationId":self.id,"attemptId":self.attempt,"finished":false,"operation":snapshot,"target":target}),
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
                    ids: g.uids.iter().filter_map(|uid|selected.graph_ids.get(uid).cloned().map(|id|(*uid,id))).collect(),
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
        let original = archive::archive_ctx_owned(&self.state, root, self.owner.owner.clone());
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
                last_error: if progress.bandwidth_limited {
                    Some("errors.bulkDownloadLimited".into())
                } else {
                    progress.last_error.as_deref().map(service_error)
                },
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
        self.blocking(move || {
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
        let proof = self.blocking(move || {
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
                self.blocking(move || proved_sources(&state, &g, &uids, &stored)).await??;
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
            self.owner.originals.get(&g.account_id).cloned().ok_or("errors.keychainBusy")?,
            self.owner.owner.clone(),
        )
        .await
        .map(|(_, deleted)| deleted)
    }
    async fn purge_begin(&mut self,targets:&[PurgeTarget],cancel:Arc<AtomicBool>)->Result<(),String> {
        let mut groups:Vec<Group>=vec![];let mut indexes=HashMap::new();
        for target in targets.iter().filter(|t|!t.skipped&&!t.refused&&t.local==PurgeEffect::Pending&&(t.proof.is_none()||t.local_only()||matches!(t.server,PurgeEffect::Pending|PurgeEffect::Complete))) {
            let index=*indexes.entry((target.account_id.clone(),target.mailbox.clone())).or_insert_with(||{let index=groups.len();groups.push(Group{account_id:target.account_id.clone(),mailbox:target.mailbox.clone(),uids:vec![]});index});
            groups[index].uids.push(target.uid);
        }
        let state=self.state.clone();
        let inventories=self.blocking(move||groups.into_iter().map(|group| {
            let result=capture_local_inventory(&state,&group,&cancel);
            ((group.account_id,group.mailbox),result)
        }).collect()).await?;
        self.inventories=inventories;
        Ok(())
    }
    async fn purge_prepare(&mut self,t:&PurgeTarget,hint:&mailvault_core::bulk::TargetHint)->Result<PurgeProof,String> {
        let inventory=self.local_inventory(t)?;
        if hint.native_identity.is_none() {
            let email = crate::credentials::resolve_account_credentials_quiet(&t.account_id).await.ok().map(|config|config.email).filter(|email|!email.is_empty());
            let scope = mailvault_core::app_db::compose_receipts::Scope::new(&t.account_id,&t.mailbox,t.uid,
                hint.message_id.as_deref().ok_or("errors.bulkIdentityUncertain")?).ok_or("errors.bulkIdentityUncertain")?;
            let (state,target) = (self.state.clone(),t.clone());
            return self.blocking(move || common::with_mailbox_write(&state,&scope.account_id,&scope.mailbox,|root| {
                    let artifacts=inventory_artifacts(&state,root,&target,&inventory)?;
                    let raw=identical_artifact_bytes(&artifacts)?;
                    let receipt=crate::handlers::compose::local_ownership_resolved(&state,&scope,None,raw)?.ok_or("errors.bulkIdentityUncertain")?;
                    let stored = artifacts.first().map(|(name,raw)| StoredProof{uid:target.uid,name:name.clone(),sha256:bulk_worker::bytes_hash(raw)});
                    Ok(PurgeProof::Local{email,receipt,stored})
            })).await?;
        }
        let config = self.config(&t.group()).await?;
        let original = hint.native_identity.as_ref().unwrap();
        let selected = Selected{validity:original.uid_validity,origin_hash:Some(original.origin_hash.clone()),jmap_mailbox_id:original.jmap_mailbox_id.clone(),
            cached_uids:vec![t.uid],message_ids:hint.message_id.as_ref().map(|id|(t.uid,mailvault_core::maildir::normalize_message_id(id))).into_iter().collect(),
            jmap_ids:hint.jmap_id.as_ref().map(|id|(t.uid,id.clone())).into_iter().collect(),graph_ids:hint.graph_id.as_ref().map(|id|(t.uid,id.clone())).into_iter().collect()};
        if bulk_worker::origin_hash(&config) != original.origin_hash { return Err("errors.bulkIdentityChanged".into()); }
        // Original hints, live provider identity and native configuration are
        // the server authority. Inventory already checked native eligibility;
        // a later whole-cache/ledger selection must not replace that snapshot.
        let retained=self.selected.entry((t.account_id.clone(),t.mailbox.clone())).or_default();
        retained.validity=selected.validity; retained.origin_hash=selected.origin_hash; retained.jmap_mailbox_id=selected.jmap_mailbox_id;
        retained.cached_uids.extend(selected.cached_uids); retained.message_ids.extend(selected.message_ids); retained.jmap_ids.extend(selected.jmap_ids); retained.graph_ids.extend(selected.graph_ids);
        let identified=self.identity(&t.group()).await;
        let (identity,origin)=match identified {
            Err(error) if config.uses_jmap() && (error=="errors.jmapAuthFailed" || crate::handlers::jmap_bridge::is_auth_error(&error))=>{
                self.state.jmap.forget(&config);
                self.identity(&t.group()).await?
            }
            other=>other?,
        };
        let (state,target,identity_copy,original_origin,mid)=(self.state.clone(),t.clone(),identity.clone(),origin.clone(),hint.message_id.clone());
        let captured = self.blocking(move || common::with_mailbox_write(&state,&target.account_id,&target.mailbox,|root| {
            let artifacts=inventory_artifacts(&state,root,&target,&inventory)?;
            server_local_proof(&state,root,&target,&identity_copy,&original_origin,None,mid.as_deref(),&artifacts).map(ServerLocalEvidence::into_stored)
        })).await?;
        let stored=match captured {Ok(proof)=>proof,Err(error) if identity_error(&error)=>return Err(error),Err(error)=>{tracing::warn!("bulk purge local evidence: {error}");None}};
        Ok(PurgeProof::Server{email:config.email,origin,identity,stored})
    }
    async fn purge_server(&mut self,t:&PurgeTarget,cancel:Arc<AtomicBool>)->Result<(),String> {
        let Some(PurgeProof::Server{identity,origin,email,..})=&t.proof else { return Err("errors.bulkIdentityUncertain".into()); };
        let config=self.config(&t.group()).await?;
        if bulk_worker::origin_hash(&config) != *origin || config.email!=*email || !identity.matches_transport(&config) { return Err("errors.bulkIdentityChanged".into()); }
        if cancel.load(Ordering::SeqCst) { return Err("errors.bulkIdentityUncertain".into()); }
        if let Identity::Graph{ids}=identity {
            let id=ids.get(&t.uid).ok_or("errors.bulkIdentityUncertain")?;
            // Revalidate original ledger binding immediately before Graph IO.
            let now=self.identity(&t.group()).await?.0;
            if !identity.matches(&now,&[t.uid]) { return Err("errors.bulkIdentityChanged".into()); }
            let token=config.access_token.as_deref().ok_or("errors.bulkAccountUnavailable")?;
            return mailvault_core::graph::GraphClient::new(token).delete_message(id).await;
        }
        let (_,deleted)=archive::delete_provider_only(&self.state,t.account_id.clone(),config,t.mailbox.clone(),vec![t.uid],cancel,Some(identity),self.owner.owner.clone()).await?;
        if deleted == [t.uid] { Ok(()) } else { Err("errors.bulkOperationFailed".into()) }
    }
    async fn purge_local(&mut self,t:&PurgeTarget)->Result<PurgeEffect,String> {
        if let Some(PurgeProof::Server{origin,email,..})=&t.proof {
            let config=match self.config(&t.group()).await {
                Err(error) if identity_error(&error)=>return Ok(PurgeEffect::Conflict),
                other=>other?,
            };
            if bulk_worker::origin_hash(&config) != *origin || config.email!=*email { return Ok(PurgeEffect::Conflict); }
        }
        let mid=self.selected.get(&(t.account_id.clone(),t.mailbox.clone())).and_then(|s|s.message_ids.get(&t.uid)).cloned();
        let inventory=match self.local_inventory(t) {Ok(inventory)=>inventory,Err(_)=>return Ok(PurgeEffect::Conflict)};
        let (state,target)=(self.state.clone(),t.clone());
        match self.blocking(move || purge_local_target(&state,&target,mid.as_deref(),&inventory)).await? {
            Err(error) if identity_error(&error)=>Ok(PurgeEffect::Conflict),
            other=>other,
        }
    }
    async fn purge_mirror(&mut self,t:&PurgeTarget)->Result<PurgeMirror,String> {
        let (email,proof) = match t.proof.as_ref().ok_or("errors.bulkIdentityUncertain")? {
            PurgeProof::Server{email,origin,identity,stored} => (Some(email.clone()),stored.as_ref().map(|stored|
                mailvault_core::app_db::ops::MirrorPurgeProof::server(email,&t.group(),origin,identity,stored)).transpose()?),
            PurgeProof::Local{email,receipt,stored} => {
                if receipt.state == mailvault_core::app_db::compose_receipts::State::Cleaned { return Ok(PurgeMirror{outcome:PurgeEffect::Unresolved,removed:0,issue:Some("CleanedLocal".into())}); }
                (email.clone(), match (email,stored) { (Some(email),Some(stored))=>Some(mailvault_core::app_db::ops::MirrorPurgeProof::local(email,receipt,stored)?), _=>None })
            }
        };
        let Some(email)=email else { return Ok(PurgeMirror{outcome:PurgeEffect::Unresolved,removed:0,issue:Some("MissingAccountEmail".into())}); };
        // Re-read native configuration without provider/token refresh. The
        // retained raw email is an original target, never today's substitute.
        if self.mirror.is_some() || self.external_status.as_deref().unwrap_or("not_configured")!="not_configured" {
            let config=match crate::credentials::resolve_account_credentials_quiet(&t.account_id).await {
                Ok(config)=>config,
                Err(_)=>return Ok(PurgeMirror{outcome:PurgeEffect::Unresolved,removed:0,issue:Some("MissingNativeConfig".into())}),
            };
            if config.email!=email || matches!(&t.proof,Some(PurgeProof::Server{origin,..}) if bulk_worker::origin_hash(&config)!=*origin) {
                return Ok(PurgeMirror{outcome:PurgeEffect::Unresolved,removed:0,issue:Some("InvalidProof".into())});
            }
        }
        let target=mailvault_core::app_db::ops::MirrorPurgeTarget{email,mailbox:t.mailbox.clone(),uid:t.uid};
        let (app_dir,mirror,status)=(self.state.app_dir.clone(),self.mirror.clone(),self.external_status.clone());
        let outcome=self.blocking(move || mailvault_core::backup::purge_proved(&app_dir,mirror.as_deref().map(std::path::Path::new),status.as_deref(),&target,proof.as_ref())).await?;
        Ok(match outcome {
            mailvault_core::backup::ProvedPurgeOutcome::Removed{files}=>PurgeMirror{outcome:PurgeEffect::Complete,removed:files,issue:None},
            mailvault_core::backup::ProvedPurgeOutcome::Queued=>PurgeMirror{outcome:PurgeEffect::Queued,removed:0,issue:None},
            mailvault_core::backup::ProvedPurgeOutcome::Unconfigured=>PurgeMirror{outcome:PurgeEffect::Unconfigured,removed:0,issue:None},
            mailvault_core::backup::ProvedPurgeOutcome::Unresolved{removed,reason}=>PurgeMirror{outcome:PurgeEffect::Unresolved,removed,issue:Some(format!("{reason:?}"))},
        })
    }
}

/// Inspect every physical same-UID artifact, including the other format.
/// A first-entry lookup cannot authorize removal of a colliding sibling.
#[cfg(test)]
struct InventoryProbe {
    walks:std::sync::atomic::AtomicUsize,
    pause:std::sync::Mutex<Option<(std::sync::mpsc::Sender<()>,std::sync::mpsc::Receiver<()>)>>,
}
#[cfg(test)]
static INVENTORY_PROBES:std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf,Arc<InventoryProbe>>>>=std::sync::OnceLock::new();
#[cfg(test)]
static LOCAL_LEDGER_PROBES:std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf,Arc<std::sync::atomic::AtomicUsize>>>>=std::sync::OnceLock::new();
#[cfg(test)]
struct LocalEffectProbe {
    checked:std::sync::mpsc::Sender<()>,
    release:std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    publishing:std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
static LOCAL_EFFECT_PROBES:std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf,Arc<LocalEffectProbe>>>>=std::sync::OnceLock::new();
#[cfg(test)]
fn local_effect_probe(root:&std::path::Path) {
    let probe=LOCAL_EFFECT_PROBES.get_or_init(Default::default).lock().unwrap().get(root).cloned();
    if let Some(probe)=probe {let _=probe.checked.send(());let _=probe.release.lock().unwrap().recv_timeout(std::time::Duration::from_secs(5));}
}
#[cfg(test)]
pub(crate) fn cache_publication_probe(root:&std::path::Path) {
    if let Some(probe)=LOCAL_EFFECT_PROBES.get_or_init(Default::default).lock().unwrap().get(root) {let _=probe.publishing.send(());}
}
#[cfg(test)]
struct LocalEffectWatch(std::path::PathBuf);
#[cfg(test)]
impl Drop for LocalEffectWatch {
    fn drop(&mut self) {LOCAL_EFFECT_PROBES.get_or_init(Default::default).lock().unwrap().remove(&self.0);}
}
#[cfg(test)]
fn local_ledger_probe(root:&std::path::Path) {
    if let Some(count)=LOCAL_LEDGER_PROBES.get_or_init(Default::default).lock().unwrap().get(root) {count.fetch_add(1,Ordering::SeqCst);}
}
#[cfg(test)]
struct LocalLedgerWatch(std::path::PathBuf);
#[cfg(test)]
impl Drop for LocalLedgerWatch {
    fn drop(&mut self) {LOCAL_LEDGER_PROBES.get_or_init(Default::default).lock().unwrap().remove(&self.0);}
}
#[cfg(test)]
fn inventory_probe(root:&std::path::Path) {
    let probe=INVENTORY_PROBES.get_or_init(Default::default).lock().unwrap().get(root).cloned();
    if let Some(probe)=probe {
        if probe.walks.fetch_add(1,Ordering::SeqCst)==0 {
            let pause=probe.pause.lock().unwrap().take();
            if let Some((entered,release))=pause {let _=entered.send(());let _=release.recv_timeout(std::time::Duration::from_secs(5));}
        }
    }
}
#[cfg(test)]
struct InventoryWatch(std::path::PathBuf);
#[cfg(test)]
impl Drop for InventoryWatch {
    fn drop(&mut self) {INVENTORY_PROBES.get_or_init(Default::default).lock().unwrap().remove(&self.0);}
}
fn capture_local_inventory(state:&Arc<DaemonState>,group:&Group,cancel:&AtomicBool)->Result<Arc<LocalInventory>,String> {
    let mut captured_root=None;let mut fences=HashMap::new();
    for batch in group.uids.chunks(100) {
        if cancel.load(Ordering::SeqCst) {return Err("errors.bulkIdentityUncertain".into());}
        let (root,captured)=common::with_mailbox_write(state,&group.account_id,&group.mailbox,|root| {
            if !root.is_dir() || local_folder_at(root,group)? {return Err("errors.bulkLocalFoldersRead".into());}
            let captured:Vec<_>=batch.iter().filter_map(|uid|state.vault_registry.target_fence(root,&group.account_id,&group.mailbox,*uid).map(|fence|(*uid,fence))).collect();
            Ok((root.to_path_buf(),captured))
        })?;
        if captured_root.as_ref().is_some_and(|old|old!=&root) {return Err("errors.bulkIdentityChanged".into());}
        captured_root=Some(root);fences.extend(captured);
    }
    let root=captured_root.ok_or("errors.bulkIdentityUncertain")?;
    #[cfg(test)] inventory_probe(&root);
    let candidates=mailvault_core::message_store::inventory_uid_artifacts(&root,&group.account_id,&group.mailbox,&group.uids.iter().copied().collect(),cancel)
        .map_err(|_|"errors.bulkIdentityUncertain".to_string())?;
    Ok(Arc::new(LocalInventory{root,fences,candidates}))
}
fn inventory_artifacts(state:&Arc<DaemonState>,root:&std::path::Path,t:&PurgeTarget,inventory:&LocalInventory)->Result<Vec<(String,Vec<u8>)>,String> {
    if root!=inventory.root.as_path() || !root.is_dir() {return Err("errors.bulkIdentityUncertain".into());}
    let before=inventory.fences.get(&t.uid).ok_or("errors.bulkIdentityUncertain")?;
    let current=state.vault_registry.target_fence(root,&t.account_id,&t.mailbox,t.uid).ok_or("errors.bulkIdentityUncertain")?;
    if before!=&current {return Err("errors.bulkIdentityChanged".into());}
    let candidates=inventory.candidates.get(&t.uid).ok_or("errors.bulkIdentityUncertain")?;
    mailvault_core::message_store::read_uid_candidates(root,&t.account_id,&t.mailbox,t.uid,candidates).map_err(|error| {
        if error.kind()==std::io::ErrorKind::InvalidData {"errors.bulkIdentityChanged".into()}else{error.to_string()}
    })
}
fn identical_artifact_bytes(artifacts:&[(String,Vec<u8>)])->Result<Option<&[u8]>,String> {
    let raw=artifacts.first().map(|(_,raw)|raw.as_slice());
    if artifacts.iter().any(|(_,bytes)|Some(bytes.as_slice())!=raw) {return Err("errors.bulkIdentityChanged".into());}
    Ok(raw)
}
enum ServerLocalEvidence {
    Unresolved,
    Checked(Option<StoredProof>),
}
impl ServerLocalEvidence {
    fn into_stored(self)->Option<StoredProof> {match self {Self::Unresolved=>None,Self::Checked(stored)=>stored}}
}
fn server_local_proof(state:&Arc<DaemonState>,root:&std::path::Path,t:&PurgeTarget,identity:&Identity,origin:&str,expected:Option<&StoredProof>,original_mid:Option<&str>,artifacts:&[(String,Vec<u8>)])->Result<ServerLocalEvidence,String> {
    crate::custody::with_conn(state,|c|server_local_proof_with_conn(c,root,t,identity,origin,expected,original_mid,artifacts))
}
// Caller holds custody for every owner/row read. The final effect uses this
// same connection without releasing custody or recursively acquiring it.
fn server_local_proof_with_conn(c:&rusqlite::Connection,root:&std::path::Path,t:&PurgeTarget,identity:&Identity,origin:&str,expected:Option<&StoredProof>,original_mid:Option<&str>,artifacts:&[(String,Vec<u8>)])->Result<ServerLocalEvidence,String> {
    let owner=mailvault_core::custody::cache::native_identity(c,&t.account_id,&t.mailbox).map_err(|_|"errors.bulkIdentityUncertain")?;
    let expected_owner=mailvault_core::imap::NativeHeaderIdentity {
        account_id:t.account_id.clone(),mailbox:t.mailbox.clone(),origin_hash:origin.into(),
        uid_validity:match identity {Identity::Imap{validity,..}=>Some(*validity),Identity::Jmap{..}=>Some(1),Identity::Graph{..}=>None},
        jmap_mailbox_id:match identity {Identity::Jmap{mailbox_id,..}=>Some(mailbox_id.clone()),_=>None},
    };
    if owner.as_ref().is_some_and(|owner|owner!=&expected_owner) {return Err("errors.bulkIdentityChanged".into());}
    let row=mailvault_core::custody::entries::get(c,&t.account_id,&t.mailbox,t.uid)?;
    if row.as_ref().is_some_and(|r|matches!(r["source"].as_str(),Some("local_draft"|"local_sent"|"import"))) {return Err("errors.bulkIdentityChanged".into());}
    // The native mailbox generation binds cached bytes, including messages
    // without a Message-ID, to the original IMAP UID space.
    if let Identity::Imap{validity,..}=identity {
        // Read one metadata scalar, without load_meta's whole-row count.
        use rusqlite::OptionalExtension;
        let generation=c.query_row("SELECT json_extract(meta_json,'$.uidValidity') FROM header_cache_meta WHERE account_id=?1 AND mailbox_path=?2",rusqlite::params![t.account_id,t.mailbox],|r|r.get::<_,Option<u32>>(0)).optional().map(Option::flatten).map_err(|_|"errors.bulkIdentityUncertain".to_string())?;
        if generation!=Some(*validity) {return Err("errors.bulkIdentityChanged".into());}
        if !artifacts.is_empty() && mailvault_core::maildir::read_generation(&mailvault_core::message_store::mailbox_dir(root,&t.account_id,&t.mailbox)) != Some(*validity) {
            return Err("errors.bulkIdentityUncertain".into());
        }
    }
    let expected_mid=original_mid.map(mailvault_core::maildir::normalize_message_id);
    if row.as_ref().and_then(|r|r.get("message_id")).and_then(Value::as_str).map(mailvault_core::maildir::normalize_message_id)
        .is_some_and(|mid|Some(mid)!=expected_mid) {return Err("errors.bulkIdentityChanged".into());}
    let cached=mailvault_core::custody::cache::load_by_uids(c,&t.account_id,&t.mailbox,&[t.uid])?;
    if cached.iter().any(|r| {
        let mid=r.get("messageId").or_else(||r.get("message_id")).and_then(Value::as_str).map(mailvault_core::maildir::normalize_message_id).filter(|mid|!mid.is_empty());
        if mid != expected_mid {return true;}
        match identity {
            Identity::Graph{ids}=>r.get("_graphId").and_then(Value::as_str).is_some_and(|id|ids.get(&t.uid).map(String::as_str)!=Some(id)),
            Identity::Jmap{ids,..}=>r.get("_jmapId").and_then(Value::as_str).is_some_and(|id|ids.get(&t.uid).map(String::as_str)!=Some(id)),
            _=>false,
        }
    }) {return Err("errors.bulkIdentityChanged".into());}
    // Native header publication binds each targeted provider row to its full
    // mailbox owner. Legacy/missing rows cannot prove Graph/JMAP local bytes;
    // they do not suppress the independently proved original server action.
    let provider_key=match identity {Identity::Graph{..}=>Some("_graphId"),Identity::Jmap{..}=>Some("_jmapId"),_=>None};
    if let Some(key)=provider_key {
        if owner.is_none() || !cached.iter().any(|r|r.get(key).and_then(Value::as_str).is_some_and(|id|!id.is_empty())) {return Ok(ServerLocalEvidence::Unresolved);}
    }
    let mut proof=None;
    for (name,raw) in artifacts {
        if mailvault_core::maildir::message_id_in(&raw).map(|id|mailvault_core::maildir::normalize_message_id(&id)).filter(|mid|!mid.is_empty()) != expected_mid {return Err("errors.bulkIdentityChanged".into());}
        let hash=bulk_worker::bytes_hash(&raw);
        if expected.is_some_and(|p|p.sha256!=hash) || proof.as_ref().is_some_and(|p:&StoredProof|p.sha256!=hash) {return Err("errors.bulkIdentityChanged".into());}
        proof=Some(StoredProof{uid:t.uid,name:name.clone(),sha256:hash});
    }
    Ok(ServerLocalEvidence::Checked(proof))
}
fn purge_local_target(state:&Arc<DaemonState>,t:&PurgeTarget,original_mid:Option<&str>,inventory:&LocalInventory)->Result<PurgeEffect,String> {
    common::with_mailbox_write(state,&t.account_id,&t.mailbox,|root| {
      crate::custody::with_conn(state,|c| {
        let artifacts=inventory_artifacts(state,root,t,inventory)?;
        match t.proof.as_ref().ok_or("errors.bulkIdentityUncertain")? {
            PurgeProof::Local{receipt,..}=>{
                let raw=identical_artifact_bytes(&artifacts)?;
                let Some(proof)=crate::handlers::compose::retained_local_ownership_resolved_with_conn(c,receipt,raw)? else {return Ok(PurgeEffect::Conflict);};
                let retired=mailvault_core::app_db::with(&state.app_dir,|c| {
                    let current=mailvault_core::app_db::compose_receipts::load(c,&proof.identity.scope)?;
                    if current.iter().any(|r|r!=&proof) {return Ok(false);}
                    if current.is_empty() {return Ok(true);}
                    mailvault_core::app_db::compose_receipts::retire(c,&proof)
                })?;
                if !retired {return Ok(PurgeEffect::Conflict);}
                if proof.state==mailvault_core::app_db::compose_receipts::State::Cleaned {return Ok(PurgeEffect::Complete);}
            }
            PurgeProof::Server{identity,origin,stored,..}=>{
                match server_local_proof_with_conn(c,root,t,identity,origin,stored.as_ref(),original_mid,&artifacts) {
                    Err(error) if identity_error(&error)=>return Ok(PurgeEffect::Conflict),
                    Err(error)=>return Err(error),
                    Ok(ServerLocalEvidence::Unresolved)=>return Ok(PurgeEffect::Conflict),
                    Ok(ServerLocalEvidence::Checked(Some(_))) if stored.is_none()=>return Ok(PurgeEffect::Conflict),
                    _=>{}
                }
            }
        }
        #[cfg(test)] local_effect_probe(root);
        let candidates=inventory.candidates.get(&t.uid).ok_or("errors.bulkIdentityUncertain")?;
        let outcome=mailvault_core::vault_files::delete_uid_candidates(&state.vault_registry,root,&t.account_id,&t.mailbox,t.uid,candidates)?;
        if outcome.failed {return Ok(PurgeEffect::Failed);}
        mailvault_core::custody::entries::remove(c,&t.account_id,&t.mailbox,&[t.uid])?;
        mailvault_core::custody::cache::save_headers(c,&t.account_id,&t.mailbox,&json!({"removedUids":[t.uid]}).to_string())?;
        crate::classification::forget_at(&state.app_dir,&t.account_id,&t.mailbox,&[t.uid]);
        if let Ok(ids)=mailvault_core::app_db::with(&state.app_dir,|c|mailvault_core::app_db::follow_up::dismiss_at(c,&t.account_id,&t.mailbox,&[t.uid])) {
            for id in ids {crate::follow_up_worker::emit(state,&id,"dismissed");}
        }
        tracing::info!("bulk purge: removed {} local artifacts",outcome.removed);
        Ok(PurgeEffect::Complete)
      })
    })
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
    external_status: Option<String>,
    resume: bool,
    owner: BulkAdmission,
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
                    let worker_owner = owner.clone();
                    let task = tokio::spawn(Box::pin(async move {
                        let mut work = work;
                        let mut selected:HashMap<(String,String),Selected> = work
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
                        let original_hints=work.intent.hint_map().unwrap_or_default();
                        for target in &work.purge_targets {
                            if let Some(hint)=original_hints.get(&(target.account_id.as_str(),target.mailbox.as_str(),target.uid)) {
                                if let Some(original)=&hint.native_identity {
                                    let s=selected.entry((target.account_id.clone(),target.mailbox.clone())).or_default();
                                    s.validity=original.uid_validity;s.origin_hash=Some(original.origin_hash.clone());s.jmap_mailbox_id=original.jmap_mailbox_id.clone();s.cached_uids.push(target.uid);
                                    if let Some(mid)=&hint.message_id {s.message_ids.insert(target.uid,mailvault_core::maildir::normalize_message_id(mid));}
                                    if let Some(id)=&hint.graph_id {s.graph_ids.insert(target.uid,id.clone());}
                                    if let Some(id)=&hint.jmap_id {s.jmap_ids.insert(target.uid,id.clone());}
                                }
                            }
                        }
                        let mut origins:HashMap<String,String> = work
                            .groups
                            .iter()
                            .filter_map(|g| {
                                g.origin
                                    .clone()
                                    .map(|origin| (g.group.account_id.clone(), origin))
                            })
                            .collect();
                        for target in &work.purge_targets {
                            if let Some(PurgeProof::Server{origin,..})=&target.proof {origins.insert(target.account_id.clone(),origin.clone());}
                        }
                        let mut ports = MailPorts {
                            state: st.clone(),
                            owner: worker_owner,
                            id: op.clone(),
                            attempt: execution,
                            mirror,
                            external_status,
                            archive_base: 0,
                            archive_errors: 0,
                            selected,
                            origins,
                            inventories:HashMap::new(),
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
                    drop(owner);
                }),
                Err(e) => {
                    tracing::warn!("bulk runtime could not start: {e}");
                    drained(&state, &id, &attempt);
                    drop(owner);
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
    if action == mailvault_core::bulk::Action::DeleteEverywhere {
        let grouped=mailvault_core::bulk::group_targets(&scope);
        if !grouped.refused.is_empty() || grouped.groups.iter().any(|g|g.uids.contains(&0)) {return Err("errors.bulkIdentityUncertain".into());}
        let mut work=Workflow::new(FrozenIntent::freeze(action,scope,&[],&[]));
        let accounts=crate::handlers::insights::configured_account_ids(&state.app_dir);
        for target in &mut work.purge_targets {
            if accounts.as_ref().is_ok_and(|accounts|!accounts.contains(&target.account_id)) && target.hint(&work.intent).is_some_and(|h|h.native_identity.is_some()) {
                target.skipped=true;
                continue;
            }
            match native_local_folder(state,&target.group()) {
                Ok(true)=>target.skipped=true,
                Ok(false)=>{},
                Err(error)=>{target.refused=true;target.last_error=Some(error);}
            }
        }
        return Ok(work);
    }
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
        message_ids: g.uids.iter().filter_map(|uid|selected.message_ids.get(uid).cloned().map(|id|(*uid,id))).collect(),
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

    fn test_owner(state: &Arc<DaemonState>) -> BulkAdmission {
        if !state.app_dir.join("accounts.json").exists() {
            std::fs::write(state.app_dir.join("accounts.json"), r#"[{"id":"acc"}]"#).unwrap();
        }
        let listed = mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap();
        admit_ids(state, mailvault_core::accounts_doc::authoritative_ids(&listed.accounts)).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p4_bulk_admission_and_child_keep_complete_scope() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        std::fs::write(dir.path().join("accounts.json"), r#"[{"id":"a"},{"id":"b"},{"id":"c"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
        let scope = serde_json::from_value(json!({"spans":true,"keys":["a:INBOX:1","b:INBOX:2"]})).unwrap();
        let intent = FrozenIntent::freeze(mailvault_core::bulk::Action::DeleteEverywhere, scope, &[], &[]);
        state.bulk.lock().unwrap().claim(&state.app_dir, "p4", intent.clone()).unwrap();
        let work = Workflow::new(intent);
        assert_eq!(work.purge_targets.len(), 2, "both targets must be in the durable work");
        let mut ports = MailPorts {
            state: state.clone(), owner: admit_work(&state, &work).unwrap(), id: "p4".into(), attempt: "p4".into(),
            mirror: None, external_status: None, archive_base: 0, archive_errors: 0,
            selected: HashMap::new(), origins: HashMap::new(), inventories: HashMap::new(),
        };
        let before = mailvault_core::op_journal::pending_operation_read(&state.app_dir).unwrap().unwrap();
        let writer = mailvault_core::app_db::db::open(dir.path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let checkpoint = tokio::spawn(async move { ports.checkpoint(&work).await });
        let mut entered = false;
        for _ in 0..200 {
            if state.journal.try_lock().is_err() { entered = true; break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let mut early = Vec::new();
        if entered {
            for id in ["a", "b"] {
                let lease = crate::account_workflows::AccountLease::detached_for_test(
                    crate::account_workflows::AccountWriteScope { ids: [id.to_owned()].into(), ..Default::default() });
                let close = state.account_lifecycle.try_close(lease, id);
                let busy = matches!(&close, Err(crate::account_lifecycle::LifecycleError::Busy));
                if let Ok(mut claim) = close {
                    let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
                    claim.mark_effects_started(drained).unwrap();
                    claim.finish_retired().unwrap();
                }
                early.push((id, busy));
            }
        }
        writer.execute_batch("ROLLBACK").unwrap();
        let checkpoint_result = checkpoint.await.unwrap();
        let after = mailvault_core::op_journal::pending_operation_read(&state.app_dir).unwrap().unwrap();
        assert!(entered && checkpoint_result.is_ok() && before != after,
            "actual checkpoint did not persist after release: entered={entered} result={checkpoint_result:?} before={before} after={after}");
        assert!(early.iter().all(|(_, busy)| *busy), "checkpoint wrote after A/B retirement: {early:?} pending={after}");
        assert!(state.account_lifecycle.try_operation(&[state.account_lifecycle.capture("c").unwrap()]).is_ok());
    }

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
    // Exercise the real archive result adapter, worker checkpoint and durable
    // status contract. A fake ArchiveOutcome would miss a discarded typed flag.
    #[tokio::test(flavor = "multi_thread")]
    async fn bulk_worker_archive_download_limit_survives_durable_status() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (refusal, limited, expected, phase, status, errors) in [
            (
                "copy refused",
                false,
                "errors.bulkOperationFailed",
                "delete",
                "complete",
                0,
            ),
            (
                "Account exceeded bandwidth limits. (Failure)",
                true,
                "errors.bulkDownloadLimited",
                "archive",
                "cancelled",
                1,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
            seed_selection(&state, "INBOX");
            let server = MockImap::start(Scenario::new().mailbox(inbox(1)).fault(
                mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
                mock_imap::Action::Respond("NO".into(), refusal.into()),
            ));
            let config = config(&server);
            let credentials = dir.path().join("credentials.json");
            let account = json!({"id":"acc","email":config.email,"password":"pw","imapHost":server.host(),"imapPort":server.port()});
            std::fs::write(&credentials, json!({"acc":account.to_string()}).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &credentials);
            std::fs::write(dir.path().join("accounts.json"), "[{\"id\":\"acc\"}]").unwrap();
            let mut frames = state.events.subscribe();
            let reply = handle_request_for_test(&state, "bulk.start", json!({
                "operationId":"download-limit", "attemptId":"download-attempt", "type":"archive_and_delete",
                "scope":original_scope(&config, "INBOX", Some("<selected@test>")),
            })).await;
            assert!(reply.error.is_none(), "{:?}", reply.error);
            let pending = wait_drained(&state).await;
            assert!(
                server
                    .commands()
                    .iter()
                    .any(|command| command.contains("BODY.PEEK[]")),
                "must reach actual archive IO"
            );
            let mut archive = Vec::new();
            let terminal = loop {
                let line = tokio::time::timeout(Duration::from_secs(2), frames.recv())
                    .await
                    .unwrap()
                    .unwrap();
                let frame: Value = serde_json::from_str(&line).unwrap();
                if frame["params"]["name"] == "archive-progress" {
                    let payload = &frame["params"]["payload"];
                    archive.push(json!({"active":payload["active"], "errors":payload["errors"], "bandwidthLimited":payload["bandwidthLimited"]}));
                }
                if frame["params"]["name"] == "bulk-progress"
                    && frame["params"]["payload"]["finished"] == true
                {
                    break frame["params"]["payload"].clone();
                }
            };
            assert_eq!(
                archive.last(),
                Some(&json!({"active":false,"errors":1,"bandwidthLimited":limited})),
                "actual final archive result must reach the adapter"
            );
            // Counts describe the current phase. Ordinary archive errors survive
            // as diagnostics while entering delete resets that phase's count.
            assert_eq!(pending["currentPhase"], phase);
            assert_eq!(pending["status"], status);
            assert_eq!(pending["worker"]["errors"], errors);
            assert_eq!(pending["lastError"], expected, "typed archive diagnostic");
            assert_eq!(pending["worker"]["lastError"], expected);
            assert_eq!(terminal["operationId"], "download-limit");
            assert_eq!(terminal["attemptId"], pending["attemptId"]);
            assert_eq!(terminal["operation"]["lastError"], expected);
            assert_eq!(terminal["operation"]["status"], status);
            assert!(
                !server
                    .commands()
                    .iter()
                    .any(|command| command.contains("UID STORE")),
                "unarchived mail stays on server"
            );
            let snapshot = handle_request_for_test(
                &state,
                "bulk.status",
                json!({
                    "operationId":"download-limit", "attemptId":"download-attempt",
                }),
            )
            .await
            .result
            .unwrap();
            assert!(snapshot["active"].is_null());
            // Terminal pending records are compacted out of status; the owned
            // durable record is the frontend's documented recovery source.
            let raw = handle_request_for_test(&state, "read_pending_operation", json!({}))
                .await
                .result
                .unwrap();
            assert_eq!(raw["lastError"], expected);
            assert_eq!(raw["attemptId"], pending["attemptId"]);
            std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        }
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
        let admitted = test_owner(&state);
        let (progress, deleted) = archive::delete_with_config(
            &state,
            "acc".into(),
            config,
            "INBOX".into(),
            vec![7],
            true,
            Arc::new(AtomicBool::new(false)),
            Some(&identity),
            admitted.originals.get("acc").cloned().unwrap(),
            admitted.owner,
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
                let mut ports = MailPorts { state:state.clone(), owner:test_owner(&state), id:"original".into(), attempt:"A".into(), mirror:None, external_status:None, archive_base:0, archive_errors:0, selected:HashMap::from([(("acc".into(),"INBOX".into()),selected)]), inventories:HashMap::new(), origins:HashMap::from([("acc".into(),bulk_worker::origin_hash(&cfg))]) };
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
    const PURGE_RAW:&[u8]=b"From: a@example.test\r\nTo: one@example.test\r\nSubject: selected\r\nMessage-ID: <selected@test>\r\n\r\nbody\r\n";
    fn purge_credentials(state:&Arc<DaemonState>,server:&MockImap)->crate::imap::ImapConfig {
        let cfg=config(server);
        let path=state.app_dir.join("credentials.json");
        let account=json!({"email":cfg.email,"password":"pw","imapHost":server.host(),"imapPort":server.port()});
        std::fs::write(&path,json!({"acc":account.to_string()}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS",&path);
        cfg
    }
    fn seed_purge_file(state:&Arc<DaemonState>,raw:&[u8]) {
        common::with_mailbox_write(state,"acc","INBOX",|root| {
            mailvault_core::vault_files::store(&state.vault_registry,root,"acc","INBOX",7,raw,&[],true)?;
            mailvault_core::maildir::write_generation(&mailvault_core::message_store::mailbox_dir(root,"acc","INBOX"),1)?;
            crate::custody::with_conn(state,|c|mailvault_core::custody::entries::upsert(c,"acc","INBOX",&[json!({"uid":7,"source":"server","message_id":"<selected@test>"})]).map(|_|()))
        }).unwrap();
    }
    fn purge_ports(state:&Arc<DaemonState>)->MailPorts {
        MailPorts{state:state.clone(),owner:test_owner(state),id:"test".into(),attempt:"A".into(),mirror:None,external_status:Some("unavailable".into()),archive_base:0,archive_errors:0,selected:HashMap::new(),inventories:HashMap::new(), origins:HashMap::new()}
    }
    fn publish_purge_owner(state:&Arc<DaemonState>,owner:&mailvault_core::imap::NativeHeaderIdentity,rows:Value) {
        crate::custody::with_conn(state,|c| {
            let expected=mailvault_core::custody::cache::native_identity(c,"acc","INBOX")?;
            mailvault_core::custody::cache::save_headers(c,"acc","INBOX",&json!({"nativeIdentity":owner,"nativeExpectedIdentity":expected,"uidValidity":owner.uid_validity,"emails":rows}).to_string())
        }).unwrap();
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_review_native_cache_publisher_cannot_cross_final_check_use() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
        let provider=MockImap::start(Scenario::new().mailbox(inbox(1)));let cfg=purge_credentials(&state,&provider);let owner_a=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",Some(1));publish_purge_owner(&state,&owner_a,json!([{"uid":7,"messageId":"selected@test"}]));
        let work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(original_scope(&cfg,"INBOX",Some("selected@test"))).unwrap()).unwrap();let mut target=work.purge_targets[0].clone();let hint=target.hint(&work.intent).unwrap().clone();let mut ports=purge_ports(&state);
        ports.purge_begin(std::slice::from_ref(&target),Arc::new(AtomicBool::new(false))).await.unwrap();target.proof=Some(ports.purge_prepare(&target,&hint).await.unwrap());ports.purge_server(&target,Arc::new(AtomicBool::new(false))).await.unwrap();target.server=PurgeEffect::Complete;
        let (checked_tx,checked_rx)=std::sync::mpsc::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();let (publishing_tx,publishing_rx)=std::sync::mpsc::channel();
        LOCAL_EFFECT_PROBES.get_or_init(Default::default).lock().unwrap().insert(dir.path().into(),Arc::new(LocalEffectProbe{checked:checked_tx,release:std::sync::Mutex::new(release_rx),publishing:publishing_tx}));let _watch=LocalEffectWatch(dir.path().into());
        let local=tokio::spawn(async move{ports.purge_local(&target).await});checked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // Admit a real native cache publication after A's final check. Its
        // credential check uses B; the account returns to A before local use.
        let mut cfg_b=cfg.clone();cfg_b.host="endpoint-b.example.test".into();let owner_b=mailvault_core::imap::NativeHeaderIdentity::new(&cfg_b,"acc","INBOX",Some(1));
        let credential_path=dir.path().join("credentials.json");let account_b=json!({"email":cfg_b.email,"password":"pw","imapHost":cfg_b.host,"imapPort":cfg_b.port});std::fs::write(&credential_path,json!({"acc":account_b.to_string()}).to_string()).unwrap();
        let data=json!({"nativeIdentity":owner_b,"nativeExpectedIdentity":owner_a,"uidValidity":1,"emails":[{"uid":7,"messageId":"selected@test","subject":"native B publication","_nativeIdentity":owner_b}]}).to_string();
        let publish_state=state.clone();let (done_tx,done_rx)=std::sync::mpsc::channel();let publication=tokio::spawn(async move{let reply=handle_request_for_test(&publish_state,"save_email_cache",json!({"accountId":"acc","mailbox":"INBOX","data":data})).await;let _=done_tx.send(reply.error.is_none());reply});
        publishing_rx.recv_timeout(Duration::from_secs(5)).unwrap();let custody_protected=state.custody.db.try_lock().is_err();let publication_waited=done_rx.recv_timeout(Duration::from_millis(100)).is_err();purge_credentials(&state,&provider);let _=release_tx.send(());
        let local_result=local.await.unwrap().unwrap();let published=publication.await.unwrap();assert!(published.error.is_none(),"actual native publisher: {:?}",published.error);
        let rows=crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::load_by_uids(c,"acc","INBOX",&[7])).unwrap();let owner=crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::native_identity(c,"acc","INBOX")).unwrap();
        assert!(((custody_protected&&publication_waited)||local_result==PurgeEffect::Conflict)&&rows.len()==1&&rows[0]["subject"]=="native B publication"&&owner==Some(owner_b),"publication must wait or purge refuse: protected={custody_protected}, waited={publication_waited}, local={local_result:?}, rows={rows:?}");
        assert!(mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap().is_empty());std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_review_conflicting_native_owner_never_blesses_current_bytes() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        let mut observed=vec![];
        for phase in ["initial","final"] {
            for mid in [Some("selected@test"),None] {
                let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");
                let raw=if mid.is_some(){PURGE_RAW}else{b"Subject: same absent MID\r\n\r\nendpoint B bytes"};seed_purge_file(&state,raw);
                crate::custody::with_conn(&state,|c|mailvault_core::custody::entries::upsert(c,"acc","INBOX",&[json!({"uid":7,"source":"server","message_id":mid})]).map(|_|())).unwrap();
                let mut mailbox=mock_imap::state::Mailbox::new("INBOX").with_uid_validity(1);mailbox.add(mock_imap::Message::new(7,std::str::from_utf8(raw).unwrap()));
                let provider=MockImap::start(Scenario::new().mailbox(mailbox));let cfg=purge_credentials(&state,&provider);
                let original=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",Some(1));
                publish_purge_owner(&state,&original,json!([{"uid":7,"messageId":mid}]));
                let drive=tempfile::tempdir().unwrap();let cur=mailvault_core::maildir::mirror_cur(drive.path(),&cfg.email,"INBOX").unwrap();std::fs::create_dir_all(&cur).unwrap();std::fs::write(cur.join("7.eml"),raw).unwrap();
                let mut cfg_b=cfg.clone();cfg_b.host="endpoint-b.example.test".into();let owner_b=mailvault_core::imap::NativeHeaderIdentity::new(&cfg_b,"acc","INBOX",Some(1));
                let scope=original_scope(&cfg,"INBOX",mid);
                let result=if phase=="initial" {
                    publish_purge_owner(&state,&owner_b,json!([{"uid":7,"messageId":mid}]));
                    let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"owner-conflict","type":"delete_everywhere","scope":scope,"mirrorRoot":drive.path()})).await;assert!(reply.error.is_none());
                    let pending=wait_drained(&state).await;pending["result"]["failed"]==1
                } else {
                    let work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(scope).unwrap()).unwrap();let mut target=work.purge_targets[0].clone();let hint=target.hint(&work.intent).unwrap().clone();let mut ports=purge_ports(&state);
                    ports.purge_begin(std::slice::from_ref(&target),Arc::new(AtomicBool::new(false))).await.unwrap();target.proof=Some(ports.purge_prepare(&target,&hint).await.unwrap());
                    ports.purge_server(&target,Arc::new(AtomicBool::new(false))).await.unwrap();target.server=PurgeEffect::Complete;
                    publish_purge_owner(&state,&owner_b,json!([{"uid":7,"messageId":mid}]));
                    ports.purge_local(&target).await.unwrap()==PurgeEffect::Conflict
                };
                let file=mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap();let rows=crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::load_by_uids(c,"acc","INBOX",&[7])).unwrap();
                let owner=crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::native_identity(c,"acc","INBOX")).unwrap();
                let queued=mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap();
                observed.push((phase,mid.is_some(),result,file.as_deref()==Some(raw),rows.len()==1,owner==Some(owner_b),std::fs::read(cur.join("7.eml")).ok().as_deref()==Some(raw),queued.is_empty()));
            }
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(observed.iter().all(|(_,_,refused,file,cache,owner,mirror,queue)|*refused&&*file&&*cache&&*owner&&*mirror&&*queue),"conflicting coherent native owner: {observed:?}");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_review_resume_retained_pending_server_reaches_local_and_mirror() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
        seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);let provider=MockImap::start(Scenario::new().mailbox(inbox(1)));let cfg=purge_credentials(&state,&provider);
        let owner=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",Some(1));publish_purge_owner(&state,&owner,json!([{"uid":7,"messageId":"selected@test"}]));
        let mut work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(original_scope(&cfg,"INBOX",Some("selected@test"))).unwrap()).unwrap();
        let mut ports=purge_ports(&state);ports.purge_begin(&work.purge_targets,Arc::new(AtomicBool::new(false))).await.unwrap();work.purge_targets[0].proof=Some(ports.purge_prepare(&work.purge_targets[0],work.purge_targets[0].hint(&work.intent).unwrap()).await.unwrap());
        let retained=work.purge_targets[0].proof.clone();state.bulk.lock().unwrap().begin_admission("server-pending","A").unwrap();prepare_claim(&state,"server-pending","A",work.intent.clone()).unwrap();checkpoint(&state,"server-pending","A",&work).unwrap();
        let drive=tempfile::tempdir().unwrap();let cur=mailvault_core::maildir::mirror_cur(drive.path(),&cfg.email,"INBOX").unwrap();std::fs::create_dir_all(&cur).unwrap();std::fs::write(cur.join("7.eml"),PURGE_RAW).unwrap();drop(ports);drop(state);
        let restarted=DaemonState::for_test(dir.path().into(),dir.path().into(),true);let reply=handle_request_for_test(&restarted,"bulk.resume",json!({"operationId":"server-pending","attemptId":"B","mirrorRoot":drive.path()})).await;assert!(reply.error.is_none(),"{:?}",reply.error);let pending=wait_drained(&restarted).await;
        assert_eq!(pending["result"],json!({"deleted":1,"failed":0,"queuedBackup":0,"needsResync":0}),"{pending}");
        assert_eq!(pending["worker"]["purgeTargets"][0]["proof"],json!(retained.unwrap()));assert_eq!(pending["worker"]["purgeTargets"][0]["local"],"complete");assert_eq!(pending["worker"]["purgeTargets"][0]["mirror"],"complete");
        assert!(provider.commands().iter().any(|command|command.contains("UID EXPUNGE 7")));assert!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().is_none());assert!(!cur.join("7.eml").exists());std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_review_provider_local_units_use_bounded_owner_rows_not_large_ledgers() {
        let mut observed=vec![];
        for jmap in [false,true] {
            let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");
            let cfg:crate::imap::ImapConfig=serde_json::from_value(json!({"email":"provider@example.test","imapHost":"provider.example.test","password":"pw"})).unwrap();
            let mut owner=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",if jmap{Some(1)}else{None});if jmap {owner=owner.with_jmap_mailbox("original-label");}
            let mut ledger=serde_json::Map::new();let mut rows=vec![];
            for uid in 1..=12 {
                common::with_mailbox_write(&state,"acc","INBOX",|root|mailvault_core::vault_files::store(&state.vault_registry,root,"acc","INBOX",uid,PURGE_RAW,&[],true).map(|_|())).unwrap();
                let mut row=json!({"uid":uid,"messageId":"selected@test"});row[if jmap{"_jmapId"}else{"_graphId"}]=json!(format!("original-{uid}"));rows.push(row);ledger.insert(uid.to_string(),json!(format!("original-{uid}")));
            }
            for uid in 1000..3000 {ledger.insert(uid.to_string(),json!(format!("unselected-{uid}")));}
            publish_purge_owner(&state,&owner,json!(rows));let path=mailvault_core::graph_ledger::ledger_path(&mailvault_core::header_cache::sidecar_dir(dir.path(),"acc","INBOX"),jmap);std::fs::create_dir_all(path.parent().unwrap()).unwrap();std::fs::write(&path,Value::Object(ledger).to_string()).unwrap();
            let count=Arc::new(std::sync::atomic::AtomicUsize::new(0));LOCAL_LEDGER_PROBES.get_or_init(Default::default).lock().unwrap().insert(dir.path().into(),count.clone());let _watch=LocalLedgerWatch(dir.path().into());
            let group=Group{account_id:"acc".into(),mailbox:"INBOX".into(),uids:(1..=12).collect()};let inventory=capture_local_inventory(&state,&group,&AtomicBool::new(false)).unwrap();
            let mut completed=0;
            for uid in 1..=12 {
                let ids=HashMap::from([(uid,format!("original-{uid}"))]);let identity=if jmap{Identity::Jmap{mailbox_id:"original-label".into(),ids}}else{Identity::Graph{ids}};
                let mut scope=original_scope(&cfg,"INBOX",Some("selected@test"));scope["keys"]=json!([uid]);scope["targetHints"][0]["uid"]=json!(uid);scope["targetHints"][0]["nativeIdentity"]=json!(owner);scope["targetHints"][0][if jmap{"jmapId"}else{"graphId"}]=json!(format!("original-{uid}"));
                let work=Workflow::new(FrozenIntent::freeze(mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(scope).unwrap(),&["acc".into()],&[]));let mut target=work.purge_targets[0].clone();
                let stored=common::with_mailbox_write(&state,"acc","INBOX",|root|{let artifacts=inventory_artifacts(&state,root,&target,&inventory)?;server_local_proof(&state,root,&target,&identity,&owner.origin_hash,None,Some("selected@test"),&artifacts).map(ServerLocalEvidence::into_stored)}).unwrap();
                target.proof=Some(PurgeProof::Server{email:cfg.email.clone(),origin:owner.origin_hash.clone(),identity,stored});target.server=PurgeEffect::Complete;
                if uid==12 {let mut changed=rows.clone();changed[11][if jmap{"_jmapId"}else{"_graphId"}]=json!("replacement");publish_purge_owner(&state,&owner,json!(changed));}
                let result=purge_local_target(&state,&target,Some("selected@test"),&inventory).unwrap();
                if uid<12 {completed+=usize::from(result==PurgeEffect::Complete);}else{assert_eq!(result,PurgeEffect::Conflict);assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",uid).unwrap().as_deref(),Some(PURGE_RAW));}
            }
            observed.push((jmap,count.load(Ordering::SeqCst),completed));
        }
        assert!(observed.iter().all(|(_,loads,completed)|*loads==0&&*completed==11),"large provider ledger must not be parsed inside target units: {observed:?}");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_review_missing_or_unreadable_provider_binding_preserves_local_work() {
        let mut observed=vec![];
        for jmap in [false,true] {
            for missing in ["owner","id","unreadable"] {
                let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
                let cfg:crate::imap::ImapConfig=serde_json::from_value(json!({"email":"provider@example.test","imapHost":"provider.example.test","password":"pw"})).unwrap();
                let mut owner=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",if jmap{Some(1)}else{None});if jmap{owner=owner.with_jmap_mailbox("original-label");}
                let mut row=json!({"uid":7,"messageId":"selected@test"});if missing!="id"{row[if jmap{"_jmapId"}else{"_graphId"}]=json!("original");}publish_purge_owner(&state,&owner,json!([row]));
                crate::custody::with_conn(&state,|c| {
                    let text=mailvault_core::custody::cache::load_meta(c,"acc","INBOX")?.unwrap();let mut meta:Value=serde_json::from_str(&text).unwrap();
                    if missing=="owner"{meta.as_object_mut().unwrap().remove("nativeIdentity");}if missing=="unreadable"{meta["nativeIdentity"]=json!({"originHash":9});}
                    c.execute("UPDATE header_cache_meta SET meta_json=?1 WHERE account_id='acc' AND mailbox_path='INBOX'",[meta.to_string()]).map(|_|()).map_err(|e|e.to_string())
                }).unwrap();
                let path=mailvault_core::graph_ledger::ledger_path(&mailvault_core::header_cache::sidecar_dir(dir.path(),"acc","INBOX"),jmap);std::fs::create_dir_all(path.parent().unwrap()).unwrap();std::fs::write(path,"{\"7\":\"original\"}").unwrap();
                let identity=if jmap{Identity::Jmap{mailbox_id:"original-label".into(),ids:HashMap::from([(7,"original".into())])}}else{Identity::Graph{ids:HashMap::from([(7,"original".into())])}};
                let mut scope=original_scope(&cfg,"INBOX",Some("selected@test"));scope["targetHints"][0]["nativeIdentity"]=json!(owner);scope["targetHints"][0][if jmap{"jmapId"}else{"graphId"}]=json!("original");
                let work=Workflow::new(FrozenIntent::freeze(mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(scope).unwrap(),&["acc".into()],&[]));let mut target=work.purge_targets[0].clone();let inventory=capture_local_inventory(&state,&group(),&AtomicBool::new(false)).unwrap();
                target.proof=Some(PurgeProof::Server{email:cfg.email.clone(),origin:owner.origin_hash.clone(),identity,stored:Some(StoredProof{uid:7,name:mailvault_core::message_store::entry_name(7,&[]),sha256:bulk_worker::bytes_hash(PURGE_RAW)})});target.server=PurgeEffect::Complete;
                let result=purge_local_target(&state,&target,Some("selected@test"),&inventory);let refused=matches!(&result,Ok(PurgeEffect::Conflict))||result.as_ref().err().is_some_and(|error|identity_error(error));let bytes=mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap();let rows=crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::load_by_uids(c,"acc","INBOX",&[7])).unwrap();
                observed.push((jmap,missing,refused,bytes.as_deref()==Some(PURGE_RAW),rows.len()==1));
            }
        }
        assert!(observed.iter().all(|(_,_,refused,bytes,rows)|*refused&&*bytes&&*rows),"unproved provider local ownership stays unresolved: {observed:?}");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_inventory_walk_is_once_and_releases_same_mailbox_foreground_lock() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");
        let mut mailbox=mock_imap::state::Mailbox::new("INBOX").with_uid_validity(1);let mut rows=vec![];
        for uid in 1..=12 {
            let mid=format!("{uid}@inventory.test");let raw=format!("Message-ID: <{mid}>\r\n\r\noriginal {uid}");mailbox.add(mock_imap::Message::new(uid,raw.clone()));
            common::with_mailbox_write(&state,"acc","INBOX",|root|mailvault_core::vault_files::store(&state.vault_registry,root,"acc","INBOX",uid,raw.as_bytes(),&[],true).map(|_|())).unwrap();
            rows.push(json!({"uid":uid,"messageId":mid}));
        }
        let mbox=mailvault_core::message_store::mailbox_dir(dir.path(),"acc","INBOX");mailvault_core::maildir::write_generation(&mbox,1).unwrap();
        for uid in 1000..3000 {std::fs::write(mbox.join("cur").join(mailvault_core::message_store::entry_name(uid,&[])),b"unselected").unwrap();}
        crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::save_headers(c,"acc","INBOX",&json!({"uidValidity":1,"emails":rows}).to_string())).unwrap();
        let server=MockImap::start(Scenario::new().mailbox(mailbox));let cfg=purge_credentials(&state,&server);let original=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",Some(1));
        let hints:Vec<_>=(1..=12).map(|uid|json!({"accountId":"acc","mailbox":"INBOX","uid":uid,"nativeIdentity":original,"messageIdPresent":true,"messageId":format!("{uid}@inventory.test")})).collect();
        let work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(json!({"accountId":"acc","mailbox":"INBOX","keys":(1..=12).collect::<Vec<_>>(),"targetHints":hints})).unwrap()).unwrap();
        state.bulk.lock().unwrap().begin_admission("inventory","A").unwrap();prepare_claim(&state,"inventory","A",work.intent.clone()).unwrap();checkpoint(&state,"inventory","A",&work).unwrap();
        let (entered_tx,entered_rx)=std::sync::mpsc::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();
        let probe=Arc::new(InventoryProbe{walks:std::sync::atomic::AtomicUsize::new(0),pause:std::sync::Mutex::new(Some((entered_tx,release_rx)))});
        INVENTORY_PROBES.get_or_init(Default::default).lock().unwrap().insert(dir.path().into(),probe.clone());let _watch=InventoryWatch(dir.path().into());
        let worker_state=state.clone();let worker=std::thread::spawn(move|| {
            let mut ports=purge_ports(&worker_state);ports.id="inventory".into();ports.external_status=Some("not_configured".into());let mut work=work;
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(bulk_worker::run(&mut ports,&mut work,Arc::new(AtomicBool::new(false)),false)).map(|_|work)
        });
        let entered=entered_rx.recv_timeout(Duration::from_secs(5));
        let foreground_state=state.clone();let (foreground_tx,foreground_rx)=std::sync::mpsc::channel();let foreground=std::thread::spawn(move||{let result=common::with_mailbox_write(&foreground_state,"acc","INBOX",|_|crate::custody::with_conn(&foreground_state,|c|mailvault_core::custody::entries::get(c,"acc","INBOX",1)).map(|_|()));let _=foreground_tx.send(result);});
        let observed=foreground_rx.recv_timeout(Duration::from_secs(1));let _=release_tx.send(());foreground.join().unwrap();let work=worker.join().unwrap().unwrap();
        let walks=probe.walks.load(Ordering::SeqCst);
        assert!(entered.is_ok() && matches!(observed,Ok(Ok(()))) && walks==1,"actual inventory must be one off-lock walk: entered={entered:?}, foreground={observed:?}, walks={walks}");
        assert_eq!(work.purge_result.unwrap().deleted,12);
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_inventory_row_tombstone_and_invalidation_fences_prevent_stale_delete() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());let mut observed=vec![];
        for mutation in ["row","tombstone","mailbox","global"] {
            let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
            let server=MockImap::start(Scenario::new().mailbox(inbox(1)));let cfg=purge_credentials(&state,&server);let work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(original_scope(&cfg,"INBOX",Some("selected@test"))).unwrap()).unwrap();
            let mut target=work.purge_targets[0].clone();let hint=target.hint(&work.intent).unwrap().clone();let mut ports=purge_ports(&state);ports.purge_begin(std::slice::from_ref(&target),Arc::new(AtomicBool::new(false))).await.unwrap();target.proof=Some(ports.purge_prepare(&target,&hint).await.unwrap());ports.purge_server(&target,Arc::new(AtomicBool::new(false))).await.unwrap();target.server=PurgeEffect::Complete;
            common::with_mailbox_write(&state,"acc","INBOX",|root| {
                match mutation {
                    "row"=>{let entry=mailvault_core::message_store::find(root,"acc","INBOX",7).unwrap();state.vault_registry.upsert("acc","INBOX",7,&mailvault_core::message_store::entry_path(root,"acc","INBOX",&entry.name));},
                    "tombstone"=>state.vault_registry.remove("acc","INBOX",&[7]),
                    "mailbox"=>state.vault_registry.invalidate("acc","INBOX"),
                    _=>state.vault_registry.invalidate_all(),
                }
                Ok(())
            }).unwrap();
            let result=ports.purge_local(&target).await.unwrap();let survives=mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().as_deref()==Some(PURGE_RAW);observed.push((mutation,result,survives));
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(observed.iter().all(|(_,result,survives)|*result==PurgeEffect::Conflict&&*survives),"stale all-candidate authority must refuse: {observed:?}");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_post_server_origin_provider_row_and_nonfile_conflicts_are_refusals() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        let modes=["origin","provider-row"].into_iter().chain(cfg!(unix).then_some("non-file"));
        for mode in modes {
            let _graph=(mode=="provider-row").then(||crate::handlers::graph::test_graph_mock_with(vec![(204,String::new())]));
            let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
            let server=MockImap::start(Scenario::new().mailbox(inbox(1)));
            let mut cfg=purge_credentials(&state,&server);
            let mut account=json!({"email":cfg.email,"password":"pw","imapHost":server.host(),"imapPort":server.port()});
            if mode=="provider-row" {
                account=json!({"email":"graph@example.test","imapHost":"outlook.office365.com","authType":"oauth2","oauth2Transport":"graph","oauth2AccessToken":"token"});
                cfg=serde_json::from_value(account.clone()).unwrap();
                std::fs::write(dir.path().join("credentials.json"),json!({"acc":account.to_string()}).to_string()).unwrap();
                let ledger=mailvault_core::graph_ledger::ledger_path(&mailvault_core::header_cache::sidecar_dir(dir.path(),"acc","INBOX"),false);std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();std::fs::write(ledger,"{\"7\":\"graph-A\"}").unwrap();
                let owner=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",None);publish_purge_owner(&state,&owner,json!([{"uid":7,"messageId":"selected@test","_graphId":"graph-A"}]));
            }
            let mut scope=original_scope(&cfg,"INBOX",Some("selected@test"));
            if mode=="provider-row" {scope["targetHints"][0]["graphId"]=json!("graph-A");}
            let work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(scope).unwrap()).unwrap();
            let mut target=work.purge_targets[0].clone();let hint=target.hint(&work.intent).unwrap().clone();let mut ports=purge_ports(&state);
            ports.purge_begin(std::slice::from_ref(&target),Arc::new(AtomicBool::new(false))).await.unwrap();
            target.proof=Some(ports.purge_prepare(&target,&hint).await.unwrap());
            let original_path=match target.proof.as_ref().unwrap() {PurgeProof::Server{stored:Some(stored),..}=>mailvault_core::message_store::entry_path(dir.path(),"acc","INBOX",&stored.name),_=>panic!("native file proof")};
            ports.purge_server(&target,Arc::new(AtomicBool::new(false))).await.unwrap();target.server=PurgeEffect::Complete;
            if mode=="origin" {account["imapPort"]=json!(server.port()+1);std::fs::write(dir.path().join("credentials.json"),json!({"acc":account.to_string()}).to_string()).unwrap();}
            if mode=="provider-row" {let owner=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",None);publish_purge_owner(&state,&owner,json!([{"uid":7,"messageId":"selected@test","_graphId":"graph-B"}]));}
            #[cfg(unix)] if mode=="non-file" {
                let foreign=dir.path().join("foreign.eml");std::fs::write(&foreign,b"foreign bytes").unwrap();std::os::unix::fs::symlink(&foreign,original_path.parent().unwrap().join("7:2,S.eml")).unwrap();
                state.vault_registry.invalidate("acc","INBOX");
                ports.purge_begin(std::slice::from_ref(&target),Arc::new(AtomicBool::new(false))).await.unwrap();
            }
            assert_eq!(ports.purge_local(&target).await.unwrap(),PurgeEffect::Conflict,"{mode}");
            assert_eq!(std::fs::read(original_path).unwrap(),PURGE_RAW,"{mode}");
            assert!(crate::custody::with_conn(&state,|c|mailvault_core::custody::entries::get(c,"acc","INBOX",7)).unwrap().is_some());
            assert!(mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap().is_empty());
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_native_imap_and_protected_mirror_preserve_partial_results() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        let modes=["online","offline","unconfigured","refused","no_uidplus","missing-proof","offline-missing-proof","jmap-store","mirror-conflict"].into_iter().chain(cfg!(unix).then_some("local-io"));
        for mode in modes {
            let dir=tempfile::tempdir().unwrap();
            let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
            seed_selection(&state,"INBOX");
            if mode=="jmap-store" {mailvault_core::message_store::set_vault_format(dir.path(),mailvault_core::message_store::Format::Jmap).unwrap();}
            if !matches!(mode,"missing-proof"|"offline-missing-proof") {seed_purge_file(&state,PURGE_RAW);}
            if mode=="jmap-store" {mailvault_core::message_store::write(dir.path(),"acc","INBOX",8,PURGE_RAW,&[]).unwrap();}
            #[cfg(unix)] if mode=="local-io" {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(mailvault_core::message_store::mailbox_dir(dir.path(),"acc","INBOX").join("cur"),std::fs::Permissions::from_mode(0o555)).unwrap();
            }
            let mut mailbox=inbox(1);mailbox.add(mock_imap::Message::new(9,"Message-ID: <other@test>\r\n\r\nkeep").with_flags(&["\\Deleted"]));
            let mut scenario=Scenario::new().mailbox(mailbox);
            if mode=="no_uidplus" {scenario=scenario.without_cap("UIDPLUS");}
            if mode=="refused" {scenario=scenario.fault(mock_imap::Trigger::with("STORE","\\Deleted"),mock_imap::Action::Respond("NO".into(),"refused".into()));}
            let server=MockImap::start(scenario);let cfg=purge_credentials(&state,&server);
            let drive=tempfile::tempdir().unwrap();
            let cur=mailvault_core::maildir::mirror_cur(drive.path(),&cfg.email,"INBOX").unwrap();
            std::fs::create_dir_all(&cur).unwrap();std::fs::write(cur.join("7.eml"),PURGE_RAW).unwrap();
            if mode=="mirror-conflict" {std::fs::write(cur.join("7_copy.eml"),b"replacement mirror bytes").unwrap();}
            let mut scope=original_scope(&cfg,"INBOX",Some("<selected@test>"));
            if mode=="online" {scope["targetHints"][0]["localIdentity"]=json!({"source":"local_sent","staged":true});}
            let mut params=json!({"operationId":"purge","type":"delete_everywhere","scope":scope,"externalStatus":if mode=="unconfigured" {"not_configured"}else{"unavailable"}});
            if !matches!(mode,"offline"|"unconfigured"|"offline-missing-proof") {params["mirrorRoot"]=json!(drive.path());}
            let reply=handle_request_for_test(&state,"bulk.start",params).await;
            assert!(reply.error.is_none(),"{mode}: {:?}",reply.error);
            let pending=wait_drained(&state).await;
            #[cfg(unix)] if mode=="local-io" {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(mailvault_core::message_store::mailbox_dir(dir.path(),"acc","INBOX").join("cur"),std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let failed=matches!(mode,"refused"|"no_uidplus");
            assert_eq!(pending["result"],json!({"deleted":usize::from(!failed),"failed":usize::from(failed),"queuedBackup":usize::from(mode=="offline"),"needsResync":0}),"{mode}: {pending}");
            assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().is_some(),failed||mode=="local-io","{mode}");
            assert_eq!(cur.join("7.eml").exists(),!matches!(mode,"online"|"jmap-store"|"local-io"|"mirror-conflict"),"{mode}");
            if matches!(mode,"missing-proof"|"offline-missing-proof") {assert_eq!(pending["worker"]["purgeTargets"][0]["mirrorIssue"],"MissingProof");}
            if mode=="jmap-store" {assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",8).unwrap().as_deref(),Some(PURGE_RAW),"shared blob owner survives");}
            let queued=mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap();
            assert_eq!(queued.len(),usize::from(matches!(mode,"offline"|"mirror-conflict")),"{mode}");
            assert!(queued.iter().all(|item|item.proved().is_ok()));
            if mode=="mirror-conflict" {assert!(cur.join("7_copy.eml").exists());assert_eq!(pending["worker"]["purgeTargets"][0]["mirrorRemoved"],1);assert_eq!(pending["worker"]["purgeTargets"][0]["mirrorIssue"],"Mismatch");}
            assert!(server.state().mailboxes[0].messages.iter().any(|message|message.uid==9),"unrelated Deleted UID must survive");
            if mode=="no_uidplus" {assert!(server.commands().iter().all(|command|!command.contains("UID STORE")&&!command.contains("EXPUNGE")));}
            assert!(handle_request_for_test(&state,"deleted.list",json!({})).await.result.unwrap().as_array().unwrap().is_empty());
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_provider_completion_leaves_local_state_until_exact_phase() {
        let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
        seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
        let server=MockImap::start(Scenario::new().mailbox(inbox(1)));
        let cfg=config(&server);let identity=Identity::Imap{validity:1,message_ids:HashMap::from([(7,"selected@test".into())])};
        let (_,deleted)=archive::delete_provider_only(&state,"acc".into(),cfg,"INBOX".into(),vec![7],Arc::new(AtomicBool::new(false)),Some(&identity),test_owner(&state).owner).await.unwrap();
        assert_eq!(deleted,vec![7]);
        assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().as_deref(),Some(PURGE_RAW));
        let custody=crate::custody::with_conn(&state,|c|mailvault_core::custody::entries::get(c,"acc","INBOX",7)).unwrap().unwrap();
        assert!(custody.get("serverDeleted").is_none());
        assert_eq!(crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::load_by_uids(c,"acc","INBOX",&[7])).unwrap().len(),1);
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_native_closed_vault_and_import_marker_have_zero_effects() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        for import in [false,true] {
            let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
            seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
            let server=MockImap::start(Scenario::new().mailbox(inbox(1)));let cfg=purge_credentials(&state,&server);
            if import {
                mailvault_core::local_folder::write_marker(&mailvault_core::message_store::mailbox_dir(dir.path(),"acc","INBOX"),&mailvault_core::local_folder::Marker{kind:"import".into(),name:"INBOX".into(),created:1,source:"native.mbox".into()}).unwrap();
            } else {state.vault_closed.store(true,Ordering::SeqCst);}
            let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"excluded","type":"delete_everywhere","scope":original_scope(&cfg,"INBOX",Some("selected@test")),"externalStatus":"unavailable"})).await;
            assert!(reply.error.is_none());let pending=wait_drained(&state).await;
            assert_eq!(pending["result"]["deleted"],0);assert_eq!(pending["result"]["failed"],usize::from(!import));
            assert!(server.commands().is_empty());assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().as_deref(),Some(PURGE_RAW));
            assert!(mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap().is_empty());
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_no_message_id_uses_native_generation_and_exact_bytes() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
        seed_selection(&state,"INBOX");let raw=b"Subject: no Message-ID\r\n\r\noriginal native bytes";seed_purge_file(&state,raw);
        crate::custody::with_conn(&state,|c| {
            mailvault_core::custody::cache::save_headers(c,"acc","INBOX",&json!({"uidValidity":1,"emails":[{"uid":7,"messageId":null}]}).to_string())?;
            mailvault_core::custody::entries::upsert(c,"acc","INBOX",&[json!({"uid":7,"source":"local","message_id":null})]).map(|_|())
        }).unwrap();
        let mut mailbox=mock_imap::state::Mailbox::new("INBOX").with_uid_validity(1);mailbox.add(mock_imap::Message::new(7,std::str::from_utf8(raw).unwrap()));
        let server=MockImap::start(Scenario::new().mailbox(mailbox));let cfg=purge_credentials(&state,&server);
        let drive=tempfile::tempdir().unwrap();let cur=mailvault_core::maildir::mirror_cur(drive.path(),&cfg.email,"INBOX").unwrap();std::fs::create_dir_all(&cur).unwrap();std::fs::write(cur.join("7.eml"),raw).unwrap();
        let capture_wire = std::env::var_os("MAILVAULT_BULK_WIRE_FIXTURE").is_some();
        let mut wire_events = state.events.subscribe();
        let request = json!({"operationId":"no-mid","type":"delete_everywhere","scope":original_scope(&cfg,"INBOX",None),"mirrorRoot":drive.path()});
        let reply=handle_request_for_test(&state,"bulk.start",request.clone()).await;
        assert!(reply.error.is_none());let pending=wait_drained(&state).await;
        assert_eq!(pending["result"],json!({"deleted":1,"failed":0,"queuedBackup":0,"needsResync":0}),"{pending}");
        assert!(!cur.join("7.eml").exists());assert!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().is_none());
        if capture_wire {
            let mut frames = Vec::new();
            loop {
                let line = tokio::time::timeout(Duration::from_secs(2), wire_events.recv()).await.unwrap().unwrap();
                let frame: Value = serde_json::from_str(&line).unwrap();
                if frame["params"]["name"] != "bulk-progress" { continue; }
                let payload = frame["params"]["payload"].clone();
                let finished = payload["finished"].as_bool() == Some(true);
                frames.push(payload);
                if finished { break; }
            }
            // Synthetic mock-provider identities/hashes only. No raw body,
            // credential or native mirror path is part of the wire artifact.
            let request = json!({"type":request["type"],"scope":request["scope"]});
            println!("F_NATIVE_WIRE_JSON={}", json!({"request":request,"accepted":reply.result,"pending":pending,"events":frames}));
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_local_replacement_after_actual_server_success_is_preserved() {
        let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
        seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
        let server=MockImap::start(Scenario::new().mailbox(inbox(1)));let cfg=config(&server);
        let mut work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,serde_json::from_value(original_scope(&cfg,"INBOX",Some("<selected@test>"))).unwrap()).unwrap();
        let identity=Identity::Imap{validity:1,message_ids:HashMap::from([(7,"selected@test".into())])};
        let inventory=capture_local_inventory(&state,&group(),&AtomicBool::new(false)).unwrap();
        let stored=common::with_mailbox_write(&state,"acc","INBOX",|root| {
            let artifacts=inventory_artifacts(&state,root,&work.purge_targets[0],&inventory)?;
            server_local_proof(&state,root,&work.purge_targets[0],&identity,&bulk_worker::origin_hash(&cfg),None,Some("selected@test"),&artifacts).map(ServerLocalEvidence::into_stored)
        }).unwrap().unwrap();
        work.purge_targets[0].proof=Some(PurgeProof::Server{email:cfg.email.clone(),origin:bulk_worker::origin_hash(&cfg),identity:identity.clone(),stored:Some(stored)});
        archive::delete_provider_only(&state,"acc".into(),cfg,"INBOX".into(),vec![7],Arc::new(AtomicBool::new(false)),Some(&identity),test_owner(&state).owner).await.unwrap();
        let replacement=b"Message-ID: <selected@test>\r\n\r\nreplacement bytes";
        seed_purge_file(&state,replacement);
        let fresh=capture_local_inventory(&state,&group(),&AtomicBool::new(false)).unwrap();
        assert_eq!(purge_local_target(&state,&work.purge_targets[0],Some("selected@test"),&fresh).unwrap(),PurgeEffect::Conflict);
        assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().as_deref(),Some(replacement.as_slice()));
        assert!(crate::custody::with_conn(&state,|c|mailvault_core::custody::entries::get(c,"acc","INBOX",7)).unwrap().is_some());
        assert!(mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap().is_empty());
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_supported_workflow_resumes_actual_stage_after_exact_retirement() {
        let dir=tempfile::tempdir().unwrap();
        let server=MockImap::start(Scenario::new().mailbox(inbox(1)));
        let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
        std::fs::write(dir.path().join("accounts.json"),r#"[{"id":"acc"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
        let staged=handle_request_for_test(&state,"compose.stage",json!({"accountId":"acc","account":{"email":"one@example.test","password":"pw","imapHost":server.host(),"imapPort":server.port()},"mailbox":"Sent",
            "email":{"to":"recipient@example.test","subject":"stage","text":"local bytes"}})).await.result.unwrap();
        let uid=staged["uid"].as_u64().unwrap() as u32;
        let scope:mailvault_core::bulk::Scope=serde_json::from_value(json!({"accountId":"acc","mailbox":"Sent","keys":[uid],"targetHints":[{
            "accountId":"acc","mailbox":"Sent","uid":uid,"messageIdPresent":true,"messageId":staged["messageId"],"localIdentity":{"source":"local_sent","staged":true}}]})).unwrap();
        let mut work=freeze(&state,mailvault_core::bulk::Action::DeleteEverywhere,scope).unwrap();
        let mut ports=MailPorts{state:state.clone(),owner:test_owner(&state),id:"retained".into(),attempt:"A".into(),mirror:None,external_status:Some("not_configured".into()),archive_base:0,archive_errors:0,selected:HashMap::new(),inventories:HashMap::new(), origins:HashMap::new()};
        ports.purge_begin(&work.purge_targets,Arc::new(AtomicBool::new(false))).await.unwrap();
        let proof=ports.purge_prepare(&work.purge_targets[0],work.purge_targets[0].hint(&work.intent).unwrap()).await.unwrap();
        let PurgeProof::Local{receipt,..}=&proof else {panic!("stage must have native local proof")};
        let original=receipt.clone();work.purge_targets[0].proof=Some(proof);
        state.bulk.lock().unwrap().begin_admission("retained","A").unwrap();
        prepare_claim(&state,"retained","A",work.intent.clone()).unwrap();
        checkpoint(&state,"retained","A",&work).unwrap();
        assert!(mailvault_core::app_db::with(dir.path(),|c|mailvault_core::app_db::compose_receipts::retire(c,&original)).unwrap());
        drop(ports);drop(state);
        let restarted=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
        let reply=handle_request_for_test(&restarted,"bulk.resume",json!({"operationId":"retained","attemptId":"B","externalStatus":"not_configured"})).await;
        assert!(reply.error.is_none(),"{:?}",reply.error);
        let pending=wait_drained(&restarted).await;
        assert_eq!(pending["result"]["deleted"],1,"{pending}");
        assert_eq!(pending["result"]["failed"],0);
        assert_eq!(pending["worker"]["purgeTargets"][0]["proof"]["receipt"],json!(original));
        assert!(mailvault_core::message_store::read_raw(dir.path(),"acc","Sent",uid).unwrap().is_none());
        assert!(mailvault_core::app_db::with(dir.path(),|c|mailvault_core::app_db::compose_receipts::load(c,&original.identity.scope)).unwrap().is_empty());
        assert!(server.commands().is_empty(),"local-only Resume must not contact provider");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_actual_cleaned_stage_never_authorizes_reoccupied_slot_or_mirror() {
        let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);let server=MockImap::start(Scenario::new().mailbox(inbox(1)));
        std::fs::write(dir.path().join("accounts.json"),r#"[{"id":"local-only"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
        let staged=handle_request_for_test(&state,"compose.stage",json!({"accountId":"local-only","account":{"email":"one@example.test","password":"pw","imapHost":server.host(),"imapPort":server.port()},"mailbox":"Sent","email":{"to":"recipient@example.test","subject":"stage","text":"local bytes"}})).await.result.unwrap();
        let uid=staged["uid"].as_u64().unwrap() as u32;
        let scope=mailvault_core::app_db::compose_receipts::Scope::new("local-only","Sent",uid,staged["messageId"].as_str().unwrap()).unwrap();
        let mut receipt=crate::handlers::compose::with_local_ownership(&state,&scope,None,|_,proof,_|Ok(proof)).unwrap().unwrap();receipt.state=mailvault_core::app_db::compose_receipts::State::Cleaned;
        mailvault_core::app_db::with(dir.path(),|c|mailvault_core::app_db::compose_receipts::save(c,&receipt)).unwrap();
        let raw=mailvault_core::message_store::read_raw(dir.path(),"local-only","Sent",uid).unwrap().unwrap();
        let drive=tempfile::tempdir().unwrap();let cur=mailvault_core::maildir::mirror_cur(drive.path(),"one@example.test","Sent").unwrap();std::fs::create_dir_all(&cur).unwrap();let mirror=cur.join(format!("{uid}.eml"));std::fs::write(&mirror,&raw).unwrap();
        let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"cleaned","type":"delete_everywhere","mirrorRoot":drive.path(),"scope":{"accountId":"local-only","mailbox":"Sent","keys":[uid],"targetHints":[{
            "accountId":"local-only","mailbox":"Sent","uid":uid,"messageIdPresent":true,"messageId":staged["messageId"],"localIdentity":{"source":"local_sent","staged":true}}]}})).await;
        assert!(reply.error.is_none());let pending=wait_drained(&state).await;
        assert_eq!(pending["result"]["deleted"],0);assert_eq!(pending["result"]["failed"],1);
        assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"local-only","Sent",uid).unwrap(),Some(raw.clone()));assert_eq!(std::fs::read(mirror).unwrap(),raw);
        assert!(mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap().is_empty());assert!(server.commands().is_empty());
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_graph_uses_original_id_without_bin_and_refuses_uid_collision() {
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        for mode in ["success","collision","refused","missing-owner","missing-id"] {
            let _graph=crate::handlers::graph::test_graph_mock_with(if mode=="collision" {vec![]}else if mode=="refused" {vec![(400,"refused".into())]}else{vec![(204,String::new())]});
            let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
            seed_selection(&state,"INBOX");seed_purge_file(&state,PURGE_RAW);
            let account=json!({"email":"graph@example.test","imapHost":"outlook.office365.com","authType":"oauth2","oauth2Transport":"graph","oauth2AccessToken":"test-token"});
            let cfg:crate::imap::ImapConfig=serde_json::from_value(account.clone()).unwrap();
            let owner=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",None);
            let row=if mode=="missing-id"{json!({"uid":7,"messageId":"selected@test"})}else{json!({"uid":7,"messageId":"selected@test","_graphId":"graph-A"})};
            if mode!="missing-owner"{publish_purge_owner(&state,&owner,json!([row]));}else{crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::save_headers(c,"acc","INBOX",&json!({"emails":[row]}).to_string())).unwrap();}
            let loads=Arc::new(std::sync::atomic::AtomicUsize::new(0));LOCAL_LEDGER_PROBES.get_or_init(Default::default).lock().unwrap().insert(dir.path().into(),loads.clone());let _watch=LocalLedgerWatch(dir.path().into());
            let credentials=dir.path().join("credentials.json");std::fs::write(&credentials,json!({"acc":account.to_string()}).to_string()).unwrap();std::env::set_var("MAILVAULT_TEST_CREDENTIALS",&credentials);
            let ledger=mailvault_core::graph_ledger::ledger_path(&mailvault_core::header_cache::sidecar_dir(dir.path(),"acc","INBOX"),false);
            std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();std::fs::write(&ledger,json!({"7":if mode=="collision" {"graph-B"}else{"graph-A"}}).to_string()).unwrap();
            let drive=tempfile::tempdir().unwrap();let cur=mailvault_core::maildir::mirror_cur(drive.path(),&cfg.email,"INBOX").unwrap();std::fs::create_dir_all(&cur).unwrap();std::fs::write(cur.join("7.eml"),PURGE_RAW).unwrap();
            let mut scope=original_scope(&cfg,"INBOX",Some("<selected@test>"));scope["targetHints"][0]["graphId"]=json!("graph-A");
            let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"graph-purge","type":"delete_everywhere","scope":scope,"mirrorRoot":drive.path()})).await;
            assert!(reply.error.is_none(),"{mode}: {:?}",reply.error);
            let pending=wait_drained(&state).await;
            assert_eq!(pending["result"]["deleted"],usize::from(matches!(mode,"success"|"missing-owner"|"missing-id")),"{mode}: {pending}");
            assert_eq!(pending["result"]["failed"],usize::from(mode!="success"),"{mode}: {pending}");
            assert_eq!(mailvault_core::message_store::read_raw(dir.path(),"acc","INBOX",7).unwrap().is_none(),mode=="success");
            assert_eq!(cur.join("7.eml").exists(),mode!="success");
            let requests=crate::handlers::graph::test_graph_requests();
            assert_eq!(requests.len(),usize::from(mode!="collision"),"{mode}");
            assert!(requests.iter().all(|request|request.method=="DELETE"&&request.path.ends_with("/messages/graph-A")),"existing Deleted Items API only");
            assert!(handle_request_for_test(&state,"deleted.list",json!({})).await.result.unwrap().as_array().unwrap().is_empty());
            assert!(mailvault_core::app_db::with(dir.path(),mailvault_core::app_db::ops::purge_items).unwrap().is_empty());
            assert_eq!(loads.load(Ordering::SeqCst),0,"fifth-action proof must not invoke a gate-held whole ledger read");
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
    #[tokio::test(flavor="multi_thread")]
    async fn bulk_purge_jmap_preserves_original_label_ids_gone_and_auth_retry() {
        use crate::jmap_test_support as support;
        let _env=crate::credentials::test_env_lock().lock().unwrap_or_else(|e|e.into_inner());
        for mode in ["labels","last","gone","replacement-label","auth-retry"] {
            let mut scenario=support::scenario();
            let email_id=if mode=="last" {"e2"}else{"e1"};
            if mode=="gone" {scenario.accounts[0].mailboxes[0].emails.retain(|email|email.id!="e1");}
            if mode=="replacement-label" {scenario.accounts[0].mailboxes[0].id="mb-new".into();}
            if mode=="auth-retry" {scenario.faults.push(mock_jmap::Fault::UnauthorizedOnce);}
            let provider=mock_jmap::MockJmap::start(scenario);let (trap,port)=support::imap_trap();
            let cfg=support::config(&provider,port);let dir=tempfile::tempdir().unwrap();let state=DaemonState::for_test(dir.path().into(),dir.path().into(),true);
            seed_selection(&state,"INBOX");
            let mid=format!("{email_id}@x");
            crate::custody::with_conn(&state,|c|mailvault_core::custody::cache::save_headers(c,"acc","INBOX",&json!({"uidValidity":1,"emails":[{"uid":7,"messageId":mid}]}).to_string())).unwrap();
            let ledger=crate::jmap_sessions::jmap_ledger_path(dir.path(),"acc","INBOX");std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();let ledger_bytes=json!({"7":email_id}).to_string();std::fs::write(&ledger,&ledger_bytes).unwrap();
            let credentials=dir.path().join("credentials.json");std::fs::write(&credentials,json!({"acc":support::account_json(&provider,port).to_string()}).to_string()).unwrap();std::env::set_var("MAILVAULT_TEST_CREDENTIALS",&credentials);
            let original=mailvault_core::imap::NativeHeaderIdentity::new(&cfg,"acc","INBOX",Some(1)).with_jmap_mailbox("mb-inbox");
            publish_purge_owner(&state,&original,json!([{"uid":7,"messageId":mid,"_jmapId":email_id}]));
            let loads=Arc::new(std::sync::atomic::AtomicUsize::new(0));LOCAL_LEDGER_PROBES.get_or_init(Default::default).lock().unwrap().insert(dir.path().into(),loads.clone());let _watch=LocalLedgerWatch(dir.path().into());
            let reply=handle_request_for_test(&state,"bulk.start",json!({"operationId":"jmap-purge","type":"delete_everywhere","scope":{"accountId":"acc","mailbox":"INBOX","keys":[7],"targetHints":[{
                "accountId":"acc","mailbox":"INBOX","uid":7,"nativeIdentity":original,"jmapId":email_id,"messageIdPresent":true,"messageId":mid}]}})).await;
            assert!(reply.error.is_none(),"{mode}: {:?}",reply.error);
            let pending=wait_drained(&state).await;
            assert_eq!(pending["result"]["deleted"],usize::from(mode!="replacement-label"),"{mode}: {pending}");
            assert_eq!(pending["result"]["failed"],usize::from(mode=="replacement-label"),"{mode}: {pending}");
            assert_eq!(std::fs::read_to_string(&ledger).unwrap(),ledger_bytes,"no UID allocation or ledger retirement");
            provider.read(|s| {
                if matches!(mode,"labels"|"auth-retry") {assert_eq!(s.email("acc1","e1").unwrap().mailbox_ids,std::collections::BTreeSet::from(["mb-work".into()]));}
                if matches!(mode,"last"|"gone") {assert!(s.email("acc1",email_id).is_none());}
                if mode=="replacement-label" {assert!(s.email("acc1","e1").unwrap().mailbox_ids.contains("mb-new"));}
            });
            if mode=="replacement-label" {assert_eq!(provider.count_calls("Email/set"),0);}
            assert_eq!(loads.load(Ordering::SeqCst),0,"JMAP local proof must use bounded native owner/row data");
            assert!(trap.accept().is_err(),"JMAP must never fall back to IMAP");
            assert!(handle_request_for_test(&state,"deleted.list",json!({})).await.result.unwrap().as_array().unwrap().is_empty());
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
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
                owner: test_owner(&state),
                id: "mutation".into(),
                attempt: "mutation-attempt".into(),
                mirror: Some(mirror.path().to_string_lossy().into_owned()),
                external_status: None,
                archive_base: 0,
                archive_errors: 0,
                selected: HashMap::new(),
                inventories:HashMap::new(), origins: HashMap::from([(
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
            owner: test_owner(&state),
            id: "record-mutation".into(),
            attempt: "record-attempt".into(),
            mirror: Some(mirror.path().to_string_lossy().into_owned()),
                external_status: None,
            archive_base: 0,
            archive_errors: 0,
            selected: HashMap::new(),
            inventories:HashMap::new(), origins: HashMap::from([(
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
        let writer = mailvault_core::app_db::db::open(dir.path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let worker_state = state.clone();
        let (saving, at_save) = std::sync::mpsc::channel();
        let claim = std::thread::spawn(move || -> Result<Value, String> {
            let _journal = worker_state.journal.lock().unwrap();
            worker_state.bulk.lock().unwrap().validate_claim(&prepared)?;
            saving.send(()).unwrap();
            if let Err(error) = prepared.persist(&worker_state.app_dir) {
                worker_state.bulk.lock().unwrap().invalidate_pending();
                return Err(error);
            }
            let result = worker_state.bulk.lock().unwrap().publish_claim(&prepared);
            result
        });
        at_save.recv().unwrap();
        assert!(state.journal.try_lock().is_err(), "validated encoded save owns journal before controls run");
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_original_fenced_handler_cleanup_restores_disk_reconciliation() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let journal = state.journal.lock().unwrap();
        let starting = state.clone();
        let start = tokio::spawn(async move {
            handle_request_for_test(&starting, "bulk.start", json!({"operationId":"fenced","attemptId":"A","type":"delete","scope":{"keys":[]}})).await
        });
        for _ in 0..200 {
            if state.bulk.lock().unwrap().admission_receipt("fenced", "A")["state"] == "freezing" { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let fence = tokio::time::timeout(Duration::from_millis(200), handle_request_for_test(&state, "bulk.status", json!({"operationId":"fenced","attemptId":"A","fenceUnstarted":true}))).await.unwrap();
        assert!(fence.error.is_none());
        drop(journal);
        assert!(start.await.unwrap().error.is_some());
        assert!(state.bulk.lock().unwrap().admission_status().is_none(), "a completed rejected handler cannot retain an initial-status shortcut");
        assert!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().is_none());
        // A fence registered before any handler never creates an in-flight claim.
        state.bulk.lock().unwrap().fence_admission("unseen", "never-started").unwrap();
        assert!(state.bulk.lock().unwrap().admission_status().is_none());
        let legacy = json!({"id":"later-legacy","type":"delete","totalUids":[7],"completedUids":[],"status":"deleting"});
        let saved = handle_request_for_test(&state, "save_pending_operation", json!({"operation":legacy})).await;
        assert!(saved.error.is_none());
        let status = handle_request_for_test(&state, "bulk.status", json!({})).await.result.unwrap();
        assert_eq!(status["pending"]["id"], "later-legacy");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_original_cancelled_rpc_waiter_cannot_retain_claim_shortcut() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let journal = state.journal.lock().unwrap();
        let starting = state.clone();
        let waiter = tokio::spawn(async move {
            handle_request_for_test(&starting, "bulk.start", json!({"operationId":"dropped","attemptId":"A","type":"delete","scope":{"keys":[]}})).await
        });
        for _ in 0..200 {
            if state.bulk.lock().unwrap().admission_receipt("dropped", "A")["state"] == "freezing" { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let fence = handle_request_for_test(&state, "bulk.status", json!({"operationId":"dropped","attemptId":"A","fenceUnstarted":true})).await;
        assert!(fence.error.is_none());
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        drop(journal);
        for _ in 0..200 {
            if state.bulk.lock().unwrap().admission_status().is_none() { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(state.bulk.lock().unwrap().admission_status().is_none(), "the actual blocking handler must retire its shortcut even when its RPC waiter was dropped");
        let legacy = json!({"id":"after-drop","type":"delete","totalUids":[7],"completedUids":[],"status":"deleting"});
        let saved = handle_request_for_test(&state, "save_pending_operation", json!({"operation":legacy})).await;
        assert!(saved.error.is_none());
        assert_eq!(handle_request_for_test(&state, "bulk.status", json!({})).await.result.unwrap()["pending"]["id"], "after-drop");
    }

    #[test]
    fn bulk_original_concurrent_identical_starts_attach_to_one_owner() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().into(), dir.path().into(), true);
        let scope = serde_json::from_value(json!({"keys":[]})).unwrap();
        let intent = FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]);
        state.bulk.lock().unwrap().begin_admission("same", "A").unwrap();
        state.bulk.lock().unwrap().begin_admission("same", "B").unwrap();
        let first = capture_claim_seeds(&state, "same", "A").unwrap();
        let (captured, ready) = std::sync::mpsc::channel();
        let (release, paused) = std::sync::mpsc::channel();
        let other = state.clone();
        let original = intent.clone();
        let duplicate = std::thread::spawn(move || {
            let second = capture_claim_seeds(&other, "same", "B").unwrap();
            captured.send(()).unwrap();
            paused.recv().unwrap();
            prepare_seeded_claim(&other, "same", "B", original, second).unwrap()
        });
        ready.recv().unwrap();
        let (snapshot, is_duplicate) = prepare_seeded_claim(&state, "same", "A", intent.clone(), first).unwrap();
        assert!(!is_duplicate);
        let token = state.bulk.lock().unwrap().cancel_token("same").unwrap();
        let original_record = mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().unwrap();
        release.send(()).unwrap();
        let (again, is_duplicate) = duplicate.join().unwrap();
        assert!(is_duplicate);
        assert_eq!(again, snapshot);
        assert!(Arc::ptr_eq(&token, &state.bulk.lock().unwrap().cancel_token("same").unwrap()));
        assert_eq!(state.bulk.lock().unwrap().admission_receipt("same", "B")["ownerAttemptId"], "A");
        // A seed captured after the winner has a duplicate owner plus a new-
        // claim error. The duplicate must win over that expected error.
        state.bulk.lock().unwrap().begin_admission("same", "C").unwrap();
        let active = capture_claim_seeds(&state, "same", "C").unwrap();
        assert!(active.1.is_err());
        assert!(prepare_seeded_claim(&state, "same", "C", intent, active).unwrap().1);
        assert_eq!(mailvault_core::op_journal::pending_operation_read(dir.path()).unwrap().unwrap(), original_record);
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
            owner: test_owner(&state),
            id: "io".into(),
            attempt: "io".into(),
            mirror: None,
            external_status: None,
            archive_base: 0,
            archive_errors: 0,
            selected: HashMap::new(),
            inventories:HashMap::new(), origins: HashMap::new(),
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
