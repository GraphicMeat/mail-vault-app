//! Volatile source-bound freshness and closed-folder sweep state.

use crate::account_lifecycle::{AccountStamp, OperationPermit};
use crate::imap::{ImapConfig, NativeHeaderIdentity};
use crate::server::DaemonState;
use mailvault_core::accounts_doc;
use mailvault_core::sync_policy::{FOLDER_TTL_MS, PROBE_TTL_MS};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

const MAX_PROOFS: usize = 256;
const PROOF_LIFETIME: Duration = Duration::from_secs(60);

// The current runtime owns each blocking pool. Calls from an observation
// provider child therefore use this worker's background-QoS blocking pool.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|error| format!("Task join error: {error}"))
}

type Job = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

#[derive(Default)]
struct ObservationWorker(Mutex<Option<mpsc::UnboundedSender<Job>>>);

impl ObservationWorker {
    fn send(&self, job: Job) -> Result<(), String> {
        let mut sender = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if sender.as_ref().is_none_or(mpsc::UnboundedSender::is_closed) {
            let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
            std::thread::Builder::new()
                .name("sync-observation-worker".into())
                .stack_size(8 * 1024 * 1024)
                .spawn(move || {
                    #[cfg(target_os = "macos")]
                    unsafe {
                        libc::pthread_set_qos_class_self_np(
                            libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
                    }
                    let mut builder = tokio::runtime::Builder::new_current_thread();
                    builder.enable_all()
                        .thread_name("sync-observation-blocking")
                        .thread_stack_size(8 * 1024 * 1024)
                        .on_thread_start(|| {
                            // Tokio invokes this hook for the runtime's blocking
                            // pool threads as well as its async workers.
                            #[cfg(target_os = "macos")]
                            unsafe {
                                libc::pthread_set_qos_class_self_np(
                                    libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
                            }
                        });
                    let runtime = match builder.build() {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            warn!("sync observation worker could not start: {error}");
                            return;
                        }
                    };
                    runtime.block_on(async move {
                        while let Some(job) = rx.recv().await {
                            // The long provider future lives on the heap, never
                            // in the receiver loop's stack frame.
                            tokio::spawn(Box::pin(async move { job.await }));
                        }
                    });
                })
                .map_err(|error| format!("sync observation worker could not start: {error}"))?;
            *sender = Some(tx);
        }
        sender.as_ref().expect("worker sender installed").send(job)
            .map_err(|_| "sync observation worker stopped".to_owned())
    }
}

#[derive(Clone)]
pub(crate) struct Origin {
    pub original: AccountStamp,
    pub hash: String,
    pub graph: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SourceKey {
    pub account_id: String,
    pub mailbox: String,
    pub epoch: u64,
    pub origin_hash: String,
    pub cache_owner: Option<NativeHeaderIdentity>,
}

impl SourceKey {
    pub(crate) fn new(origin: &Origin, mailbox: &str, cache_owner: Option<NativeHeaderIdentity>) -> Self {
        Self {
            account_id: origin.original.id().to_owned(), mailbox: mailbox.to_owned(),
            epoch: origin.original.epoch(), origin_hash: origin.hash.clone(), cache_owner,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Generation {
    account: u64,
    mailbox: u64,
}

#[derive(Clone)]
pub(crate) struct TicketEvidence {
    original: AccountStamp,
    origin_hash: String,
    mailbox: String,
    generation: Generation,
    pub completed: Option<SourceKey>,
}

struct CheckProof {
    source: SourceKey,
    generation: Generation,
    created: Instant,
}

struct Marker {
    source: SourceKey,
    at_ms: i64,
}

#[derive(Clone, PartialEq, Eq)]
struct FolderKey {
    account_id: String,
    epoch: u64,
    origin_hash: String,
}

struct FolderRun {
    key: FolderKey,
    at_ms: i64,
}

#[derive(Default)]
struct Inner {
    next_generation: u64,
    account_generations: HashMap<String, u64>,
    mailbox_generations: HashMap<(String, String), u64>,
    folder_generations: HashMap<String, u64>,
    markers: Vec<Marker>,
    proofs: HashMap<String, CheckProof>,
    folder_runs: Vec<FolderRun>,
}

impl Inner {
    fn bump(&mut self) -> u64 {
        self.next_generation = self.next_generation.checked_add(1).expect("observation generation exhausted");
        self.next_generation
    }

    fn generation(&self, account: &str, mailbox: &str) -> Generation {
        Generation {
            account: *self.account_generations.get(account).unwrap_or(&0),
            mailbox: *self.mailbox_generations.get(&(account.to_owned(), mailbox.to_owned())).unwrap_or(&0),
        }
    }

    fn prune_proofs(&mut self) {
        self.proofs.retain(|_, proof| proof.created.elapsed() < PROOF_LIFETIME);
    }
}

#[derive(Default)]
pub(crate) struct ObservationState(Mutex<Inner>, ObservationWorker);

impl ObservationState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn spawn_job<T: Send + 'static>(&self, job: impl Future<Output = T> + Send + 'static)
        -> Result<oneshot::Receiver<T>, String> {
        let (reply, result) = oneshot::channel();
        self.1.send(Box::pin(async move {
            let value = job.await;
            let _ = reply.send(value);
        }))?;
        Ok(result)
    }

    pub(crate) fn marker_recent(&self, source: &SourceKey, now_ms: i64) -> bool {
        let inner = self.lock();
        let last = inner.markers.iter().find(|marker| marker.source == *source)
            .map_or(0, |marker| marker.at_ms);
        now_ms.saturating_sub(last) < PROBE_TTL_MS
    }

    pub(crate) fn generation(&self, source: &SourceKey) -> Generation {
        self.lock().generation(&source.account_id, &source.mailbox)
    }

    pub(crate) fn issue_check_proof(&self, source: SourceKey, generation: Generation) -> Option<String> {
        let mut inner = self.lock();
        inner.prune_proofs();
        if inner.generation(&source.account_id, &source.mailbox) != generation { return None; }
        while inner.proofs.len() >= MAX_PROOFS {
            let oldest = inner.proofs.iter().min_by_key(|(_, proof)| proof.created)
                .map(|(id, _)| id.clone())?;
            inner.proofs.remove(&oldest);
        }
        let reference = uuid::Uuid::new_v4().to_string();
        inner.proofs.insert(reference.clone(), CheckProof {
            source, generation, created: Instant::now(),
        });
        Some(reference)
    }

    pub(crate) fn mark_check(&self, source: &SourceKey, reference: &str, now_ms: i64) -> bool {
        let mut inner = self.lock();
        inner.prune_proofs();
        let Some(proof) = inner.proofs.remove(reference) else { return false };
        if proof.source != *source || inner.generation(&source.account_id, &source.mailbox) != proof.generation {
            return false;
        }
        Self::set_marker(&mut inner, source.clone(), now_ms);
        true
    }

    pub(crate) fn mark_ticket(&self, source: &SourceKey, evidence: &TicketEvidence, now_ms: i64) -> bool {
        if evidence.completed.as_ref() != Some(source) { return false; }
        let mut inner = self.lock();
        if inner.generation(&source.account_id, &source.mailbox) != evidence.generation { return false; }
        Self::set_marker(&mut inner, source.clone(), now_ms);
        true
    }

    fn set_marker(inner: &mut Inner, source: SourceKey, at_ms: i64) {
        inner.markers.retain(|marker| marker.source.account_id != source.account_id
            || marker.source.mailbox != source.mailbox);
        inner.markers.push(Marker { source, at_ms });
    }

    pub(crate) fn invalidate_probe(&self, account_id: &str, mailbox: Option<&str>) {
        let mut inner = self.lock();
        match mailbox.filter(|mailbox| !mailbox.is_empty()) {
            Some(mailbox) => {
                let generation = inner.bump();
                inner.mailbox_generations.insert((account_id.to_owned(), mailbox.to_owned()), generation);
                inner.markers.retain(|marker| marker.source.account_id != account_id || marker.source.mailbox != mailbox);
                inner.proofs.retain(|_, proof| proof.source.account_id != account_id || proof.source.mailbox != mailbox);
            }
            None => {
                let generation = inner.bump();
                inner.account_generations.insert(account_id.to_owned(), generation);
                inner.markers.retain(|marker| marker.source.account_id != account_id);
                inner.proofs.retain(|_, proof| proof.source.account_id != account_id);
            }
        }
    }

    pub(crate) fn issue_ticket(&self, origin: &Origin, mailbox: &str) -> TicketEvidence {
        TicketEvidence {
            original: origin.original.clone(), origin_hash: origin.hash.clone(),
            mailbox: mailbox.to_owned(),
            generation: self.lock().generation(origin.original.id(), mailbox),
            completed: None,
        }
    }

    pub(crate) fn ticket_current(&self, evidence: &TicketEvidence) -> bool {
        self.lock().generation(evidence.original.id(), &evidence.mailbox) == evidence.generation
    }

    pub(crate) fn folder_start(&self, origin: &Origin, now_ms: i64) -> Option<u64> {
        let key = FolderKey { account_id: origin.original.id().to_owned(),
            epoch: origin.original.epoch(), origin_hash: origin.hash.clone() };
        let mut inner = self.lock();
        let last = inner.folder_runs.iter().find(|run| run.key == key).map_or(0, |run| run.at_ms);
        if now_ms.saturating_sub(last) < FOLDER_TTL_MS { return None; }
        inner.folder_runs.retain(|run| run.key.account_id != key.account_id);
        inner.folder_runs.push(FolderRun { key: key.clone(), at_ms: now_ms });
        Some(*inner.folder_generations.get(&key.account_id).unwrap_or(&0))
    }

    pub(crate) fn folder_current(&self, account_id: &str, generation: u64) -> bool {
        *self.lock().folder_generations.get(account_id).unwrap_or(&0) == generation
    }

    pub(crate) fn invalidate_folder(&self, account_id: &str) {
        let mut inner = self.lock();
        let generation = inner.bump();
        inner.folder_generations.insert(account_id.to_owned(), generation);
        inner.folder_runs.retain(|run| run.key.account_id != account_id);
    }
}

fn authoritative_config(app_dir: &std::path::Path, account_id: &str) -> Result<(ImapConfig, bool), String> {
    let listing = accounts_doc::list(&accounts_doc::shared(app_dir))
        .map_err(|_| "errors.bulkIdentityUncertain".to_owned())?;
    if !accounts_doc::authoritative_ids(&listing.accounts).contains(account_id) {
        return Err("errors.bulkIdentityUncertain".to_owned());
    }
    let row = listing.accounts.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(account_id))
        .ok_or("errors.bulkIdentityUncertain")?;
    let graph = row.get("oauth2Transport").and_then(Value::as_str) == Some("graph");
    let config = serde_json::from_value(row.clone()).map_err(|_| "errors.bulkIdentityUncertain".to_owned())?;
    Ok((config, graph))
}

pub(crate) async fn origin(state: &Arc<DaemonState>, original: AccountStamp) -> Result<Origin, String> {
    let app_dir = state.app_dir.clone();
    let account_id = original.id().to_owned();
    let (config, graph) = blocking(move || authoritative_config(&app_dir, &account_id)).await??;
    let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&original))
        .map_err(|_| "errors.keychainBusy".to_owned())?;
    let hash = mailvault_core::bulk_worker::origin_hash(&config);
    Ok(Origin { original, hash, graph })
}

pub(crate) async fn cache(state: &Arc<DaemonState>, origin: &Origin, mailbox: &str)
    -> Result<(Option<Value>, Option<NativeHeaderIdentity>), String> {
    let state = Arc::clone(state);
    let account_id = origin.original.id().to_owned();
    let mailbox = mailbox.to_owned();
    blocking(move || {
        #[cfg(test)]
        crate::handlers::sync_observation::sample_worker_thread_for_test("cache-blocking", &mailbox);
        crate::custody::with_conn(&state, |conn| {
            let meta = mailvault_core::custody::cache::load_meta(conn, &account_id, &mailbox)?
                .map(|text| serde_json::from_str(&text).map_err(|_| "errors.bulkIdentityUncertain".to_owned()))
                .transpose()?;
            let owner = mailvault_core::custody::cache::native_identity(conn, &account_id, &mailbox)?;
            Ok((meta, owner))
        })
    }).await?
}

pub(crate) async fn owner(state: &Arc<DaemonState>, origin: &Origin, mailbox: &str)
    -> Result<Option<NativeHeaderIdentity>, String> {
    let state = Arc::clone(state);
    let account_id = origin.original.id().to_owned();
    let mailbox = mailbox.to_owned();
    blocking(move || crate::custody::with_conn(&state, |conn| {
        mailvault_core::custody::cache::native_identity(conn, &account_id, &mailbox)
    })).await?
}

pub(crate) async fn source(state: &Arc<DaemonState>, origin: &Origin, mailbox: &str)
    -> Result<(Option<Value>, SourceKey), String> {
    let (meta, owner) = cache(state, origin, mailbox).await?;
    let key = SourceKey::new(origin, mailbox, owner);
    Ok((meta, key))
}

pub(crate) async fn revalidate(state: &Arc<DaemonState>, origin: &Origin, before: &SourceKey)
    -> Result<(), String> {
    let current = self::origin(state, origin.original.clone()).await?;
    if current.hash != origin.hash { return Err("errors.bulkIdentityChanged".to_owned()); }
    let (_, after) = source(state, &current, &before.mailbox).await?;
    if &after != before { return Err("errors.bulkIdentityChanged".to_owned()); }
    let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&origin.original))
        .map_err(|_| "errors.keychainBusy".to_owned())?;
    Ok(())
}

pub(crate) async fn prepare_ticket(state: &Arc<DaemonState>, config: &ImapConfig,
    account_id: &str, mailbox: &str) -> Option<(TicketEvidence, OperationPermit)> {
    let original = state.account_lifecycle.capture(account_id).ok()?;
    let origin = self::origin(state, original).await.ok()?;
    if origin.graph || mailvault_core::bulk_worker::origin_hash(config) != origin.hash { return None; }
    let permit = state.account_lifecycle.try_operation(std::slice::from_ref(&origin.original)).ok()?;
    let evidence = state.sync_observation.issue_ticket(&origin, mailbox);
    Some((evidence, permit))
}

pub(crate) async fn complete_ticket(state: &Arc<DaemonState>, evidence: &TicketEvidence)
    -> Option<SourceKey> {
    let origin = self::origin(state, evidence.original.clone()).await.ok()?;
    if origin.hash != evidence.origin_hash || !state.sync_observation.ticket_current(evidence) {
        return None;
    }
    let (_, source) = self::source(state, &origin, &evidence.mailbox).await.ok()?;
    let owner = source.cache_owner.as_ref()?;
    if owner.origin_hash != origin.hash || owner.account_id != source.account_id
        || owner.mailbox != source.mailbox { return None; }
    let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&origin.original)).ok()?;
    state.sync_observation.ticket_current(evidence).then_some(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_lifecycle::AccountLifecycle;
    use serde_json::json;

    fn key(account_id: &str, mailbox: &str) -> SourceKey {
        SourceKey { account_id: account_id.to_owned(), mailbox: mailbox.to_owned(),
            epoch: 1, origin_hash: "origin-one".to_owned(), cache_owner: None }
    }

    fn origin(account_id: &str) -> Origin {
        let lifecycle = AccountLifecycle::default();
        lifecycle.seed(&accounts_doc::Listing {
            accounts: vec![json!({"id": account_id})], version: 0, recovered: None,
        });
        let original = lifecycle.capture(account_id).unwrap();
        Origin { original, hash: "origin-one".to_owned(), graph: false }
    }

    #[test]
    fn sync_observation_marker_requires_explicit_proof_and_expires_at_ten_seconds() {
        let state = ObservationState::default();
        let inbox = key("a", "INBOX");
        assert!(state.marker_recent(&inbox, 0), "the old JS missing marker defaults to time zero");
        assert!(!state.marker_recent(&inbox, 100_000));
        let generation = state.generation(&inbox);
        let reference = state.issue_check_proof(inbox.clone(), generation).unwrap();
        assert!(!state.marker_recent(&inbox, 100_001), "check never writes the marker");
        assert!(state.mark_check(&inbox, &reference, 100_001));
        assert!(!state.mark_check(&inbox, &reference, 100_002), "proof is consumed once");
        assert!(state.marker_recent(&inbox, 110_000));
        assert!(!state.marker_recent(&inbox, 110_001));
    }

    #[test]
    fn sync_observation_invalidation_is_scoped_and_fences_old_proofs_and_tickets() {
        let state = ObservationState::default();
        let inbox = key("a", "INBOX");
        let sent = key("a", "Sent");
        let other = key("b", "INBOX");
        for source in [&inbox, &sent, &other] {
            let reference = state.issue_check_proof(source.clone(), state.generation(source)).unwrap();
            assert!(state.mark_check(source, &reference, 100_000));
        }
        let stale = state.issue_check_proof(inbox.clone(), state.generation(&inbox)).unwrap();
        let mut ticket = state.issue_ticket(&origin("a"), "INBOX");
        ticket.completed = Some(inbox.clone());
        state.invalidate_probe("a", Some("INBOX"));
        assert!(!state.marker_recent(&inbox, 100_001));
        assert!(state.marker_recent(&sent, 100_001));
        assert!(state.marker_recent(&other, 100_001));
        assert!(!state.mark_check(&inbox, &stale, 100_001));
        assert!(!state.mark_ticket(&inbox, &ticket, 100_001));
        state.invalidate_probe("a", None);
        assert!(!state.marker_recent(&sent, 100_002));
        assert!(state.marker_recent(&other, 100_002));
    }

    #[test]
    fn sync_observation_proofs_are_bounded_and_expire_without_a_marker() {
        let state = ObservationState::default();
        let inbox = key("a", "INBOX");
        let generation = state.generation(&inbox);
        let oldest = state.issue_check_proof(inbox.clone(), generation).unwrap();
        for _ in 0..MAX_PROOFS {
            state.issue_check_proof(inbox.clone(), generation).unwrap();
        }
        assert_eq!(state.lock().proofs.len(), MAX_PROOFS);
        assert!(!state.mark_check(&inbox, &oldest, 100_000));
        let expired = state.issue_check_proof(inbox.clone(), generation).unwrap();
        state.lock().proofs.get_mut(&expired).unwrap().created =
            Instant::now() - PROOF_LIFETIME - Duration::from_millis(1);
        assert!(!state.mark_check(&inbox, &expired, 100_000));
        assert!(!state.marker_recent(&inbox, 100_001));
    }

    #[test]
    fn sync_observation_folder_failure_keeps_throttle_until_invalidation_or_ttl() {
        let state = ObservationState::default();
        let a = origin("a");
        let b = origin("b");
        let first = state.folder_start(&a, 100_000).unwrap();
        assert_eq!(state.folder_start(&a, 159_999), None);
        assert!(state.folder_start(&b, 100_001).is_some(), "other account is independent");
        state.invalidate_folder("a");
        assert!(!state.folder_current("a", first));
        assert!(state.folder_start(&a, 100_002).is_some());
        assert_eq!(state.folder_start(&a, 160_001), None);
        assert!(state.folder_start(&a, 160_002).is_some());
    }
}
