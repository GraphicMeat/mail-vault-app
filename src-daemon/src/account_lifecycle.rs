//! Process-local authority for account publications and metadata membership.
//! The account document remains authoritative; this registry only fences work
//! admitted during this daemon process.

use crate::account_workflows::{AccountLease, AccountWriteScope};
use mailvault_core::accounts_doc::{self, Listing, MembershipDelta};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Notify;
use tokio::time::Instant;

pub(crate) fn start_bootstrap(state: Arc<crate::server::DaemonState>) {
    if !state.account_lifecycle.begin_bootstrap() {
        return;
    }
    tokio::task::spawn_blocking(move || {
        let scope = AccountWriteScope {
            whole_store: true,
            ..Default::default()
        };
        match state.account_admission.try_reserve(scope) {
            Ok(lease) => {
                #[cfg(test)]
                let done = bootstrap_pause(&state.app_dir);
                let seeded = match accounts_doc::list(&accounts_doc::shared(&state.app_dir)) {
                    Ok(listing) => {
                        state.account_lifecycle.seed(&listing);
                        true
                    }
                    Err(_) => {
                        state.account_lifecycle.fail_bootstrap();
                        false
                    }
                };
                drop(lease);
                #[cfg(test)]
                drop(done);
                if seeded {
                    crate::custody::dispatch_pending_import(&state);
                    crate::format_migration_job::bootstrap_ready(&state);
                    crate::abd_worker::bootstrap_ready(&state);
                }
            }
            Err(_) => state.account_lifecycle.fail_bootstrap(),
        }
    });
}

#[cfg(test)]
struct BootstrapGate {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
    done: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
fn bootstrap_gates() -> &'static Mutex<BTreeMap<std::path::PathBuf, BootstrapGate>> {
    static GATES: std::sync::OnceLock<Mutex<BTreeMap<std::path::PathBuf, BootstrapGate>>> =
        std::sync::OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
pub(crate) fn pause_bootstrap_for_test(path: &std::path::Path) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    bootstrap_gates().lock().unwrap().insert(path.to_path_buf(), BootstrapGate { entered: entered_tx, release: release_rx, done: done_tx });
    (entered_rx, release_tx, done_rx)
}
#[cfg(test)]
fn bootstrap_pause(path: &std::path::Path) -> Option<crate::credentials::TestTaskDone> {
    let gate = bootstrap_gates().lock().unwrap().remove(path);
    gate.map(|gate| {
        let _ = gate.entered.send(());
        let _ = gate.release.recv();
        crate::credentials::TestTaskDone(gate.done)
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LifecycleError {
    Unready,
    Unknown,
    Busy,
    Stale,
    RetiredIds(BTreeSet<String>),
}

#[derive(Clone)]
pub(crate) struct AccountLifecycle(Arc<Inner>);
struct Inner {
    state: Mutex<State>,
    notify: Notify,
}
#[derive(Default)]
struct State {
    ready: bool,
    bootstrapping: bool,
    next_epoch: u64,
    entries: BTreeMap<String, Entry>,
    unscoped: usize,
}
struct Entry {
    phase: Phase,
    epoch: u64,
    local: usize,
    operations: usize,
    reservation: Option<u64>,
    uncertain: Option<u64>,
    claim_active: bool,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Open,
    Reserved,
    Closing,
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AccountStamp {
    id: String,
    epoch: u64,
}
impl AccountStamp {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }
}
pub(crate) struct LocalCommitPermit(Arc<CountOwner>);
pub(crate) struct OperationPermit(Arc<CountOwner>);
struct CountOwner {
    lifecycle: AccountLifecycle,
    ids: Vec<String>,
    kind: CountKind,
}
#[derive(Clone, Copy)]
enum CountKind {
    Local,
    Operation,
    Unscoped,
}

#[derive(Clone)]
pub(crate) struct CreationReservation(Arc<ReservationOwner>);
struct ReservationOwner {
    lifecycle: AccountLifecycle,
    ids: BTreeMap<String, u64>,
}
#[derive(Clone)]
pub(crate) struct ImportTargetReservation(CreationReservation);
impl ImportTargetReservation {
    pub fn stamp(&self, id: &str) -> Result<ImportTargetStamp, LifecycleError> {
        let Some(epoch) = self.0 .0.ids.get(id) else {
            return Err(LifecycleError::Unknown);
        };
        Ok(ImportTargetStamp {
            reservation: self.0.clone(),
            id: id.to_owned(),
            epoch: *epoch,
        })
    }
}
#[derive(Clone)]
pub(crate) struct ImportTargetStamp {
    reservation: CreationReservation,
    id: String,
    epoch: u64,
}
#[derive(Clone)]
pub(crate) struct ClaimAuthority {
    identity: Weak<()>,
    registry: Weak<Inner>,
    id: String,
    epoch: u64,
}
#[derive(Clone)]
pub(crate) enum PersistenceAuthority {
    Ordinary,
    Create(CreationReservation),
    DeleteOnly,
    Claim(ClaimAuthority),
}
#[derive(Clone)]
pub(crate) struct PersistenceOwner {
    pub lease: AccountLease,
    _operation: OperationPermit,
    pub authority: PersistenceAuthority,
}
#[derive(Clone)]
pub(crate) struct UncertainMembershipCompletion {
    ids: BTreeMap<String, u64>,
}
pub(crate) struct RemovalClaim {
    lifecycle: AccountLifecycle,
    id: String,
    previous: Option<Phase>,
    epoch: u64,
    effects: bool,
    finished: bool,
    identity: Arc<()>,
    _lease: AccountLease,
}
pub(crate) struct Drained {
    id: String,
    epoch: u64,
}

impl Default for AccountLifecycle {
    fn default() -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            notify: Notify::new(),
        }))
    }
}
impl State {
    fn epoch(&mut self) -> u64 {
        self.next_epoch = self
            .next_epoch
            .checked_add(1)
            .expect("account lifecycle epoch exhausted");
        self.next_epoch
    }
}
impl AccountLifecycle {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn begin_bootstrap(&self) -> bool {
        let mut s = self.lock();
        if s.ready || s.bootstrapping {
            return false;
        }
        s.bootstrapping = true;
        true
    }
    pub fn fail_bootstrap(&self) {
        self.lock().bootstrapping = false;
    }
    pub fn seed(&self, listing: &Listing) {
        let mut s = self.lock();
        s.bootstrapping = false;
        if s.ready {
            return;
        }
        for id in accounts_doc::authoritative_ids(&listing.accounts) {
            let epoch = s.epoch();
            s.entries.insert(
                id,
                Entry {
                    phase: Phase::Open,
                    epoch,
                    local: 0,
                    operations: 0,
                    reservation: None,
                    uncertain: None,
                    claim_active: false,
                },
            );
        }
        s.ready = true;
        self.0.notify.notify_waiters();
    }
    pub fn is_ready(&self) -> bool {
        self.lock().ready
    }
    pub fn capture(&self, id: &str) -> Result<AccountStamp, LifecycleError> {
        let s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        match s.entries.get(id) {
            Some(e) if e.phase == Phase::Open => Ok(AccountStamp {
                id: id.to_owned(),
                epoch: e.epoch,
            }),
            Some(e) if e.phase == Phase::Retired => {
                Err(LifecycleError::RetiredIds([id.to_owned()].into()))
            }
            Some(_) => Err(LifecycleError::Busy),
            None => Err(LifecycleError::Unknown),
        }
    }
    fn admit(
        &self,
        stamps: &[AccountStamp],
        kind: CountKind,
    ) -> Result<CountOwner, LifecycleError> {
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        if stamps.is_empty() {
            return Err(LifecycleError::Unknown);
        }
        let mut ids = BTreeSet::new();
        for stamp in stamps {
            let Some(e) = s.entries.get(&stamp.id) else {
                return Err(LifecycleError::Unknown);
            };
            if e.epoch != stamp.epoch {
                return Err(LifecycleError::Stale);
            }
            if e.phase != Phase::Open {
                return Err(LifecycleError::Busy);
            }
            ids.insert(stamp.id.clone());
        }
        for id in &ids {
            let e = s.entries.get_mut(id).unwrap();
            match kind {
                CountKind::Local => e.local += 1,
                CountKind::Operation => e.operations += 1,
                CountKind::Unscoped => unreachable!(),
            }
        }
        Ok(CountOwner {
            lifecycle: self.clone(),
            ids: ids.into_iter().collect(),
            kind,
        })
    }
    pub fn try_commit(&self, stamps: &[AccountStamp]) -> Result<LocalCommitPermit, LifecycleError> {
        Ok(LocalCommitPermit(Arc::new(
            self.admit(stamps, CountKind::Local)?,
        )))
    }
    pub fn try_operation(
        &self,
        stamps: &[AccountStamp],
    ) -> Result<OperationPermit, LifecycleError> {
        Ok(OperationPermit(Arc::new(
            self.admit(stamps, CountKind::Operation)?,
        )))
    }
    pub fn try_unscoped_operation(&self) -> Result<OperationPermit, LifecycleError> {
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        if s.entries
            .values()
            .any(|entry| entry.phase == Phase::Closing)
        {
            return Err(LifecycleError::Busy);
        }
        s.unscoped += 1;
        Ok(OperationPermit(Arc::new(CountOwner {
            lifecycle: self.clone(),
            ids: Vec::new(),
            kind: CountKind::Unscoped,
        })))
    }
    pub fn reserve_creation(
        &self,
        lease: &AccountLease,
        proof: &Listing,
        ids: &BTreeSet<String>,
    ) -> Result<CreationReservation, LifecycleError> {
        self.reserve_creation_checked(lease, proof, ids, None)
    }
    pub fn reserve_creation_for_save(
        &self,
        lease: &AccountLease,
        proof: &Listing,
        ids: &BTreeSet<String>,
        scope: &AccountWriteScope,
        allow_retired_refusal: bool,
    ) -> Result<CreationReservation, LifecycleError> {
        self.reserve_creation_checked(lease, proof, ids, Some((scope, allow_retired_refusal)))
    }
    fn reserve_creation_checked(
        &self,
        lease: &AccountLease,
        proof: &Listing,
        ids: &BTreeSet<String>,
        save_scope: Option<(&AccountWriteScope, bool)>,
    ) -> Result<CreationReservation, LifecycleError> {
        if ids.is_empty() || ids.iter().any(|id| id.is_empty()) {
            return Err(LifecycleError::Unknown);
        }
        let required = AccountWriteScope {
            ids: ids.clone(),
            ..Default::default()
        };
        if !lease.covers(&required) {
            return Err(LifecycleError::Busy);
        }
        if save_scope.is_some_and(|(scope, _)| !lease.covers(scope)) {
            return Err(LifecycleError::Busy);
        }
        if proof.accounts.iter().any(|row| {
            row.get("id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|id| ids.contains(id))
        }) {
            return Err(LifecycleError::Stale);
        }
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        if let Some((scope, _)) = save_scope {
            for id in scope.ids.difference(ids) {
                match s.entries.get(id) {
                    Some(entry) if entry.phase == Phase::Open => (),
                    Some(_) => return Err(LifecycleError::Busy),
                    None => return Err(LifecycleError::Unknown),
                }
            }
        }
        let mut retired = BTreeSet::new();
        for id in ids {
            match s.entries.get(id) {
                None => (),
                Some(entry) if entry.phase == Phase::Retired && save_scope.is_some_and(|(_, allow)| allow) => {
                    retired.insert(id.clone());
                }
                Some(_) => return Err(LifecycleError::Busy),
            }
        }
        if !retired.is_empty() {
            return Err(LifecycleError::RetiredIds(retired));
        }
        let mut reserved = BTreeMap::new();
        for id in ids {
            let epoch = s.epoch();
            s.entries.insert(
                id.clone(),
                Entry {
                    phase: Phase::Reserved,
                    epoch,
                    local: 0,
                    operations: 0,
                    reservation: Some(epoch),
                    uncertain: None,
                    claim_active: false,
                },
            );
            reserved.insert(id.clone(), epoch);
        }
        Ok(CreationReservation(Arc::new(ReservationOwner {
            lifecycle: self.clone(),
            ids: reserved,
        })))
    }
    pub fn reserve_import_target(
        &self,
        lease: &AccountLease,
        proof: &Listing,
        id: &str,
    ) -> Result<ImportTargetReservation, LifecycleError> {
        self.reserve_creation(lease, proof, &[id.to_owned()].into())
            .map(ImportTargetReservation)
    }
    pub fn try_import_commit(
        &self,
        stamp: &ImportTargetStamp,
    ) -> Result<LocalCommitPermit, LifecycleError> {
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        let Some(e) = s.entries.get_mut(&stamp.id) else {
            return Err(LifecycleError::Unknown);
        };
        if e.phase != Phase::Reserved
            || e.epoch != stamp.epoch
            || e.reservation != Some(stamp.epoch)
            || !Arc::ptr_eq(&self.0, &stamp.reservation.0.lifecycle.0)
            || stamp.reservation.0.ids.get(&stamp.id) != Some(&stamp.epoch)
        {
            return Err(LifecycleError::Stale);
        }
        e.local += 1;
        Ok(LocalCommitPermit(Arc::new(CountOwner {
            lifecycle: self.clone(),
            ids: vec![stamp.id.clone()],
            kind: CountKind::Local,
        })))
    }
    pub fn try_import_persistence(
        &self,
        lease: AccountLease,
        scope: &AccountWriteScope,
        target: &ImportTargetReservation,
    ) -> Result<PersistenceOwner, LifecycleError> {
        self.try_persistence(lease, scope, PersistenceAuthority::Create(target.0.clone()))
    }
    pub fn try_persistence(
        &self,
        lease: AccountLease,
        scope: &AccountWriteScope,
        authority: PersistenceAuthority,
    ) -> Result<PersistenceOwner, LifecycleError> {
        if !lease.covers(scope) {
            return Err(LifecycleError::Busy);
        }
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        if scope.whole_store
            && (s.unscoped > 0 || s.entries.values().any(|e| e.phase == Phase::Closing))
        {
            return Err(LifecycleError::Busy);
        }
        if let PersistenceAuthority::Claim(bound) = &authority {
            if scope.whole_store
                || scope.ids.len() != 1
                || !scope.ids.contains(&bound.id)
                || bound.identity.upgrade().is_none()
                || !bound
                    .registry
                    .upgrade()
                    .is_some_and(|inner| Arc::ptr_eq(&inner, &self.0))
            {
                return Err(LifecycleError::Busy);
            }
        }
        let mut retired = BTreeSet::new();
        for id in &scope.ids {
            match s.entries.get(id) {
                Some(e) if e.phase == Phase::Open => (),
                Some(e)
                    if e.phase == Phase::Reserved
                        && matches!(&authority, PersistenceAuthority::Create(r) if Arc::ptr_eq(&self.0, &r.0.lifecycle.0) && r.0.ids.get(id) == Some(&e.epoch)) =>
                {
                    ()
                }
                Some(e)
                    if e.phase == Phase::Closing
                        && e.claim_active
                        && matches!(&authority, PersistenceAuthority::Claim(bound) if bound.id == *id && bound.epoch == e.epoch && bound.identity.upgrade().is_some()) =>
                {
                    ()
                }
                Some(e)
                    if e.phase == Phase::Retired
                        && matches!(&authority, PersistenceAuthority::DeleteOnly) =>
                {
                    ()
                }
                None if matches!(&authority, PersistenceAuthority::DeleteOnly) => (),
                Some(e) if e.phase == Phase::Retired => {
                    retired.insert(id.clone());
                }
                Some(_) => return Err(LifecycleError::Busy),
                None => return Err(LifecycleError::Unknown),
            }
        }
        if !retired.is_empty() {
            return Err(LifecycleError::RetiredIds(retired));
        }
        for id in &scope.ids {
            if let Some(e) = s.entries.get_mut(id) {
                e.operations += 1;
            }
        }
        let operation = OperationPermit(Arc::new(CountOwner {
            lifecycle: self.clone(),
            ids: scope
                .ids
                .iter()
                .filter(|id| s.entries.contains_key(*id))
                .cloned()
                .collect(),
            kind: CountKind::Operation,
        }));
        Ok(PersistenceOwner {
            lease,
            _operation: operation,
            authority,
        })
    }
    pub fn validate_owner(
        &self,
        owner: &PersistenceOwner,
        scope: &AccountWriteScope,
    ) -> Result<(), LifecycleError> {
        if !owner.lease.covers(scope) {
            return Err(LifecycleError::Busy);
        }
        if let PersistenceAuthority::Claim(bound) = &owner.authority {
            if scope.whole_store || scope.ids.len() != 1 || !scope.ids.contains(&bound.id) {
                return Err(LifecycleError::Busy);
            }
        }
        let s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        for id in &scope.ids {
            let Some(e) = s.entries.get(id) else {
                return Err(LifecycleError::Unknown);
            };
            match &owner.authority {
                PersistenceAuthority::Create(r)
                    if e.phase == Phase::Reserved
                        && Arc::ptr_eq(&self.0, &r.0.lifecycle.0)
                        && r.0.ids.get(id) == Some(&e.epoch) =>
                {
                    ()
                }
                PersistenceAuthority::DeleteOnly if e.phase == Phase::Retired => (),
                PersistenceAuthority::Claim(bound)
                    if e.phase == Phase::Closing
                        && e.claim_active
                        && bound.id == *id
                        && bound.epoch == e.epoch
                        && bound.identity.upgrade().is_some()
                        && bound
                            .registry
                            .upgrade()
                            .is_some_and(|inner| Arc::ptr_eq(&inner, &self.0)) =>
                {
                    ()
                }
                _ if e.phase == Phase::Open => (),
                _ => return Err(LifecycleError::Busy),
            }
        }
        Ok(())
    }
    pub fn apply_committed_membership(
        &self,
        owner: Option<&PersistenceOwner>,
        delta: &MembershipDelta,
    ) {
        let mut s = self.lock();
        if !s.ready {
            return;
        }
        for id in &delta.removed {
            // Full removal owns the live Closing claim through credentials and
            // local cleanup. A document commit cannot retire its epoch early.
            if matches!(owner, Some(PersistenceOwner { authority: PersistenceAuthority::Claim(bound), .. })
                if bound.id == *id && bound.identity.upgrade().is_some()
                    && s.entries.get(id).is_some_and(|e| e.phase == Phase::Closing
                        && e.epoch == bound.epoch && e.claim_active)) {
                continue;
            }
            let epoch = s.epoch();
            if let Some(e) = s.entries.get_mut(id) {
                e.phase = Phase::Retired;
                e.epoch = epoch;
                e.uncertain = None;
            }
        }
        for id in &delta.added {
            let Some(PersistenceOwner {
                authority: PersistenceAuthority::Create(r),
                ..
            }) = owner
            else {
                continue;
            };
            if s.entries
                .get(id)
                .is_some_and(|e| e.phase == Phase::Reserved && r.0.ids.get(id) == Some(&e.epoch))
            {
                let epoch = s.epoch();
                let e = s.entries.get_mut(id).unwrap();
                e.phase = Phase::Open;
                e.epoch = epoch;
                e.reservation = None;
                e.uncertain = None;
            }
        }
        self.0.notify.notify_waiters();
    }
    pub fn mark_uncertain(
        &self,
        reservation: &CreationReservation,
    ) -> UncertainMembershipCompletion {
        let mut s = self.lock();
        for (id, epoch) in &reservation.0.ids {
            if let Some(e) = s.entries.get_mut(id) {
                if e.phase == Phase::Reserved && e.epoch == *epoch {
                    e.uncertain = Some(*epoch);
                }
            }
        }
        UncertainMembershipCompletion {
            ids: reservation.0.ids.clone(),
        }
    }
    pub fn recover_uncertain_membership(
        &self,
        marker: &UncertainMembershipCompletion,
        lease: &AccountLease,
        listing: &Listing,
    ) -> Result<(), LifecycleError> {
        if !lease.covers(&AccountWriteScope {
            whole_store: true,
            ..Default::default()
        }) {
            return Err(LifecycleError::Busy);
        }
        let present = accounts_doc::authoritative_ids(&listing.accounts);
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        for (id, epoch) in &marker.ids {
            if s.entries.get(id).is_some_and(|e| {
                e.phase == Phase::Reserved && e.epoch == *epoch && e.uncertain == Some(*epoch)
            }) {
                if present.contains(id) {
                    let next = s.epoch();
                    let e = s.entries.get_mut(id).unwrap();
                    e.phase = Phase::Open;
                    e.epoch = next;
                    e.reservation = None;
                    e.uncertain = None;
                } else {
                    s.entries.remove(id);
                }
            }
        }
        Ok(())
    }
    pub fn pending_uncertain(&self) -> Option<UncertainMembershipCompletion> {
        let s = self.lock();
        let ids: BTreeMap<String, u64> = s
            .entries
            .iter()
            .filter_map(|(id, e)| e.uncertain.map(|epoch| (id.clone(), epoch)))
            .collect();
        if ids.is_empty() {
            None
        } else {
            Some(UncertainMembershipCompletion { ids })
        }
    }
    pub fn try_close(&self, lease: AccountLease, id: &str) -> Result<RemovalClaim, LifecycleError> {
        if !lease.covers(&AccountWriteScope {
            ids: [id.to_owned()].into(),
            ..Default::default()
        }) {
            tracing::info!("S24_CLOSE_REFUSED reason=scope");
            return Err(LifecycleError::Busy);
        }
        let mut s = self.lock();
        if !s.ready {
            tracing::info!("S24_CLOSE_REFUSED reason=unready");
            return Err(LifecycleError::Unready);
        }
        if s.unscoped > 0 {
            tracing::info!("S24_CLOSE_REFUSED reason=unscoped count={}", s.unscoped);
            return Err(LifecycleError::Busy);
        }
        let Some(e) = s.entries.get(id) else {
            return Err(LifecycleError::Unknown);
        };
        if e.operations > 0 {
            tracing::info!("S24_CLOSE_REFUSED reason=operations count={} local={}", e.operations, e.local);
            return Err(LifecycleError::Busy);
        }
        if e.claim_active {
            tracing::info!("S24_CLOSE_REFUSED reason=claim_active local={}", e.local);
            return Err(LifecycleError::Busy);
        }
        if !matches!(e.phase, Phase::Open | Phase::Retired | Phase::Closing) {
            tracing::info!("S24_CLOSE_REFUSED reason=phase");
            return Err(LifecycleError::Busy);
        }
        if e.phase == Phase::Closing && e.local > 0 {
            tracing::info!("S24_CLOSE_REFUSED reason=closing_local count={}", e.local);
            return Err(LifecycleError::Busy);
        }
        let previous = e.phase;
        let epoch = s.epoch();
        let e = s.entries.get_mut(id).unwrap();
        e.phase = Phase::Closing;
        e.epoch = epoch;
        e.claim_active = true;
        Ok(RemovalClaim {
            lifecycle: self.clone(),
            id: id.to_owned(),
            previous: Some(previous),
            epoch,
            effects: false,
            finished: false,
            identity: Arc::new(()),
            _lease: lease,
        })
    }

    /// Removal-only recovery for a target absent from a fresh, successful
    /// authoritative document listing. It never publishes an Open ID.
    pub fn try_close_absent(
        &self,
        lease: AccountLease,
        id: &str,
        proof: &Listing,
    ) -> Result<RemovalClaim, LifecycleError> {
        if id.is_empty()
            || proof.recovered.is_some()
            || accounts_doc::authoritative_ids(&proof.accounts).contains(id)
            || !lease.covers(&AccountWriteScope {
                ids: [id.to_owned()].into(),
                ..Default::default()
            })
        {
            return Err(LifecycleError::Busy);
        }
        let mut s = self.lock();
        if !s.ready {
            return Err(LifecycleError::Unready);
        }
        if s.unscoped > 0 || s.entries.contains_key(id) {
            return Err(LifecycleError::Busy);
        }
        let epoch = s.epoch();
        s.entries.insert(id.to_owned(), Entry {
            phase: Phase::Closing,
            epoch,
            local: 0,
            operations: 0,
            reservation: None,
            uncertain: None,
            claim_active: true,
        });
        Ok(RemovalClaim {
            lifecycle: self.clone(),
            id: id.to_owned(),
            previous: None,
            epoch,
            effects: false,
            finished: false,
            identity: Arc::new(()),
            _lease: lease,
        })
    }
}
impl Clone for LocalCommitPermit {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl Clone for OperationPermit {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl Drop for CountOwner {
    fn drop(&mut self) {
        let mut s = self.lifecycle.lock();
        match self.kind {
            CountKind::Unscoped => s.unscoped -= 1,
            CountKind::Local | CountKind::Operation => {
                for id in &self.ids {
                    if let Some(e) = s.entries.get_mut(id) {
                        match self.kind {
                            CountKind::Local => e.local -= 1,
                            CountKind::Operation => e.operations -= 1,
                            CountKind::Unscoped => unreachable!(),
                        }
                    }
                }
            }
        }
        for id in &self.ids {
            if s.entries.get(id).is_some_and(|e| {
                e.phase == Phase::Reserved
                    && e.reservation.is_none()
                    && e.uncertain.is_none()
                    && e.local == 0
                    && e.operations == 0
            }) {
                s.entries.remove(id);
            }
        }
        self.lifecycle.0.notify.notify_waiters();
    }
}
impl Drop for ReservationOwner {
    fn drop(&mut self) {
        let mut s = self.lifecycle.lock();
        for (id, epoch) in &self.ids {
            if let Some(e) = s.entries.get_mut(id) {
                if e.phase == Phase::Reserved && e.epoch == *epoch && e.uncertain.is_none() {
                    e.reservation = None;
                    if e.local == 0 && e.operations == 0 {
                        s.entries.remove(id);
                    }
                }
            }
        }
    }
}
impl RemovalClaim {
    pub fn cleanup_authority(&self) -> Result<PersistenceAuthority, LifecycleError> {
        if !self.effects {
            return Err(LifecycleError::Busy);
        }
        Ok(PersistenceAuthority::Claim(ClaimAuthority {
            identity: Arc::downgrade(&self.identity),
            registry: Arc::downgrade(&self.lifecycle.0),
            id: self.id.clone(),
            epoch: self.epoch,
        }))
    }
    pub async fn wait_local_until(&self, deadline: Instant) -> Result<Drained, LifecycleError> {
        loop {
            let notified = self.lifecycle.0.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let s = self.lifecycle.lock();
                let Some(e) = s.entries.get(&self.id) else {
                    return Err(LifecycleError::Stale);
                };
                if e.phase != Phase::Closing || e.epoch != self.epoch {
                    return Err(LifecycleError::Stale);
                }
                if e.local == 0 {
                    return Ok(Drained {
                        id: self.id.clone(),
                        epoch: self.epoch,
                    });
                }
            }
            tokio::time::timeout_at(deadline, notified)
                .await
                .map_err(|_| LifecycleError::Busy)?;
        }
    }
    pub fn mark_effects_started(&mut self, drained: Drained) -> Result<(), LifecycleError> {
        if drained.id != self.id || drained.epoch != self.epoch {
            return Err(LifecycleError::Stale);
        }
        let s = self.lifecycle.lock();
        if !s.entries.get(&self.id).is_some_and(|e| {
            e.phase == Phase::Closing && e.epoch == self.epoch && e.local == 0 && e.operations == 0
        }) {
            return Err(LifecycleError::Busy);
        }
        drop(s);
        self.effects = true;
        Ok(())
    }
    pub fn finish_retired(mut self) -> Result<(), LifecycleError> {
        if !self.effects {
            return Err(LifecycleError::Busy);
        }
        let mut s = self.lifecycle.lock();
        if !s.entries.get(&self.id).is_some_and(|e| {
            e.phase == Phase::Closing && e.epoch == self.epoch && e.local == 0 && e.operations == 0
        }) {
            return Err(LifecycleError::Busy);
        }
        let epoch = s.epoch();
        let e = s.entries.get_mut(&self.id).unwrap();
        e.phase = Phase::Retired;
        e.epoch = epoch;
        e.claim_active = false;
        self.finished = true;
        Ok(())
    }
}
impl Drop for RemovalClaim {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut s = self.lifecycle.lock();
        if s.entries
            .get(&self.id)
            .is_some_and(|e| e.phase == Phase::Closing && e.epoch == self.epoch)
        {
            if self.effects {
                s.entries.get_mut(&self.id).unwrap().claim_active = false;
            } else {
                let epoch = s.epoch();
                if let Some(previous) = self.previous {
                    let e = s.entries.get_mut(&self.id).unwrap();
                    e.phase = previous;
                    e.epoch = epoch;
                    e.claim_active = false;
                } else {
                    s.entries.remove(&self.id);
                }
            }
        }
        self.lifecycle.0.notify.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn listing(ids: &[&str]) -> Listing {
        Listing {
            accounts: ids.iter().map(|id| serde_json::json!({"id":id})).collect(),
            version: 1,
            recovered: None,
        }
    }
    fn lease(ids: &[&str]) -> AccountLease {
        AccountLease::detached_for_test(AccountWriteScope {
            ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            ..Default::default()
        })
    }
    struct BootstrapPause {
        release: Option<std::sync::mpsc::Sender<()>>,
        entered: std::sync::mpsc::Receiver<()>,
        done: Option<std::sync::mpsc::Receiver<()>>,
    }
    impl BootstrapPause {
        fn arm(state: &Arc<crate::server::DaemonState>) -> Self {
            let (release, gate) = std::sync::mpsc::channel();
            let (entered, notice) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            bootstrap_gates().lock().unwrap().insert(
                state.app_dir.clone(),
                BootstrapGate {
                    entered,
                    release: gate,
                    done,
                },
            );
            Self {
                release: Some(release),
                entered: notice,
                done: Some(finished),
            }
        }
        fn entered(&self) {
            self.entered
                .recv_timeout(Duration::from_secs(5))
                .expect("actual bootstrap read entered");
        }
        fn finish(&mut self) {
            self.release.take();
            self.done
                .take()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .expect("actual bootstrap read finished");
        }
    }
    impl Drop for BootstrapPause {
        fn drop(&mut self) {
            self.release.take();
            if let Some(done) = self.done.take() {
                if done.recv_timeout(Duration::from_secs(5)).is_err() {
                    std::process::abort();
                }
            }
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_real_bootstrap_read_failure_stays_unready_then_finite_retry_seeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::create_dir(&path).unwrap();
        let state = crate::server::DaemonState::for_test(
            dir.path().join("mail"),
            dir.path().to_path_buf(),
            true,
        );
        let mut first = BootstrapPause::arm(&state);
        start_bootstrap(Arc::clone(&state));
        first.entered();
        let unready_while_reading = !state.account_lifecycle.is_ready();
        let one_live_read = !state.account_lifecycle.begin_bootstrap();
        let whole_store_owned = state
            .account_admission
            .try_reserve(AccountWriteScope {
                whole_store: true,
                ..Default::default()
            })
            .is_err();
        start_bootstrap(Arc::clone(&state));
        first.finish();
        let still_unready_after_error = !state.account_lifecycle.is_ready();
        let lease_released = state
            .account_admission
            .try_reserve(AccountWriteScope {
                whole_store: true,
                ..Default::default()
            })
            .is_ok();
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, serde_json::json!([{"id":"a"}]).to_string()).unwrap();
        let no_autonomous_retry = !state.account_lifecycle.is_ready();
        let mut second = BootstrapPause::arm(&state);
        start_bootstrap(Arc::clone(&state));
        second.entered();
        let unready_until_read = !state.account_lifecycle.is_ready();
        second.finish();
        let seeded = state.account_lifecycle.capture("a").is_ok();
        assert!(unready_while_reading && one_live_read && whole_store_owned && still_unready_after_error && lease_released && no_autonomous_retry && unready_until_read && seeded,
            "real bootstrap: unready_while_reading={unready_while_reading}, one_live_read={one_live_read}, whole_store_owned={whole_store_owned}, still_unready_after_error={still_unready_after_error}, lease_released={lease_released}, no_autonomous_retry={no_autonomous_retry}, unready_until_read={unready_until_read}, seeded={seeded}");
    }
    #[test]
    fn p1_unknown_and_atomic_multi_account_owners() {
        let life = AccountLifecycle::default();
        assert!(matches!(life.capture("a"), Err(LifecycleError::Unready)));
        life.seed(&listing(&["a", "b"]));
        assert!(matches!(
            life.capture("orphan"),
            Err(LifecycleError::Unknown)
        ));
        let a = life.capture("a").unwrap();
        let b = life.capture("b").unwrap();
        let op = life.try_operation(&[a.clone(), b.clone()]).unwrap();
        assert!(matches!(
            life.try_close(lease(&["a"]), "a"),
            Err(LifecycleError::Busy)
        ));
        drop(op);
        let claim = life.try_close(lease(&["a"]), "a").unwrap();
        assert!(matches!(
            life.try_operation(&[a, b.clone()]),
            Err(LifecycleError::Stale)
        ));
        assert!(
            life.try_operation(&[b]).is_ok(),
            "B stays independent of Closing A"
        );
        drop(claim);
        assert!(life.capture("a").is_ok());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_real_blocking_child_drains_after_stamp_revocation() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a"]));
        let old = life.capture("a").unwrap();
        let permit = life.try_commit(&[old.clone()]).unwrap();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let (entered, in_child) = std::sync::mpsc::channel::<()>();
        let child = tokio::task::spawn_blocking(move || {
            let _real_owner = permit;
            entered.send(()).unwrap();
            gate.recv().unwrap();
        });
        in_child.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut claim = life.try_close(lease(&["a"]), "a").unwrap();
        assert!(matches!(
            life.try_commit(&[old]),
            Err(LifecycleError::Stale)
        ));
        let waiter = tokio::spawn(async move {
            let drained = claim
                .wait_local_until(Instant::now() + Duration::from_secs(5))
                .await
                .unwrap();
            claim.mark_effects_started(drained).unwrap();
            claim.finish_retired().unwrap();
        });
        assert!(
            !waiter.is_finished(),
            "actual child still owns its finite publication"
        );
        release.send(()).unwrap();
        child.await.unwrap();
        waiter.await.unwrap();
        assert!(matches!(
            life.capture("a"),
            Err(LifecycleError::RetiredIds(_))
        ));
    }
    #[tokio::test]
    async fn p1_before_effect_reopens_at_new_epoch_post_effect_does_not() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a"]));
        let old = life.capture("a").unwrap();
        let claim = life.try_close(lease(&["a"]), "a").unwrap();
        drop(claim);
        let fresh = life.capture("a").unwrap();
        assert!(matches!(
            life.try_commit(&[old]),
            Err(LifecycleError::Stale)
        ));
        assert!(life.try_commit(&[fresh]).is_ok());
        let mut claim = life.try_close(lease(&["a"]), "a").unwrap();
        let drained = claim
            .wait_local_until(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        claim.mark_effects_started(drained).unwrap();
        drop(claim);
        assert!(matches!(life.capture("a"), Err(LifecycleError::Busy)));
        let mut resumed = life.try_close(lease(&["a"]), "a").unwrap();
        let drained = resumed
            .wait_local_until(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        resumed.mark_effects_started(drained).unwrap();
        resumed.finish_retired().unwrap();
        assert!(matches!(
            life.capture("a"),
            Err(LifecycleError::RetiredIds(_))
        ));
    }
    #[test]
    fn p1_reservation_requires_actual_absence_and_confirmed_addition() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a"]));
        assert!(matches!(
            life.reserve_creation(&lease(&["a"]), &listing(&["a"]), &["a".into()].into()),
            Err(LifecycleError::Stale) | Err(LifecycleError::Busy)
        ));
        let reserved = life
            .reserve_creation(&lease(&["new"]), &listing(&["a"]), &["new".into()].into())
            .unwrap();
        assert!(matches!(life.capture("new"), Err(LifecycleError::Busy)));
        let scope = AccountWriteScope {
            ids: ["new".into()].into(),
            ..Default::default()
        };
        let owner = life
            .try_persistence(
                lease(&["new"]),
                &scope,
                PersistenceAuthority::Create(reserved.clone()),
            )
            .unwrap();
        life.apply_committed_membership(Some(&owner), &MembershipDelta::default());
        assert!(life.capture("new").is_err());
        life.apply_committed_membership(
            Some(&owner),
            &MembershipDelta {
                added: ["new".into()].into(),
                removed: BTreeSet::new(),
            },
        );
        assert!(life.capture("new").is_ok());
        drop(owner);
        drop(reserved);
    }
    #[test]
    fn p1_failed_bootstrap_stays_unready_and_has_one_live_attempt() {
        let life = AccountLifecycle::default();
        assert!(life.begin_bootstrap());
        assert!(!life.begin_bootstrap(), "one live read only");
        life.fail_bootstrap();
        assert!(!life.is_ready());
        assert!(matches!(life.capture("a"), Err(LifecycleError::Unready)));
        assert!(life.begin_bootstrap(), "later explicit retry is finite");
        life.seed(&listing(&[]));
        assert!(life.is_ready());
        assert!(matches!(life.capture("a"), Err(LifecycleError::Unknown)));
        life.seed(&listing(&["a"]));
        assert!(
            matches!(life.capture("a"), Err(LifecycleError::Unknown)),
            "later seed cannot reopen absent ID"
        );
    }
    #[test]
    fn p1_uncertain_recovery_requires_bound_current_phase_and_presence() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&[]));
        let whole = AccountLease::detached_for_test(AccountWriteScope {
            whole_store: true,
            ..Default::default()
        });
        let absent = life
            .reserve_creation(
                &lease(&["absent"]),
                &listing(&[]),
                &["absent".into()].into(),
            )
            .unwrap();
        let missing = life.mark_uncertain(&absent);
        drop(absent);
        life.recover_uncertain_membership(&missing, &whole, &listing(&[]))
            .unwrap();
        assert!(matches!(
            life.capture("absent"),
            Err(LifecycleError::Unknown)
        ));

        let reserved = life
            .reserve_creation(&lease(&["x"]), &listing(&[]), &["x".into()].into())
            .unwrap();
        let marker = life.mark_uncertain(&reserved);
        drop(reserved);
        life.recover_uncertain_membership(&marker, &whole, &listing(&["x"]))
            .unwrap();
        assert!(life.capture("x").is_ok());
        let claim = life.try_close(lease(&["x"]), "x").unwrap();
        life.recover_uncertain_membership(&marker, &whole, &listing(&["x"]))
            .unwrap();
        assert!(
            matches!(life.capture("x"), Err(LifecycleError::Busy)),
            "stale marker cannot cross Closing"
        );
        drop(claim);
        life.apply_committed_membership(
            None,
            &MembershipDelta {
                added: BTreeSet::new(),
                removed: ["x".into()].into(),
            },
        );
        life.recover_uncertain_membership(&marker, &whole, &listing(&["x"]))
            .unwrap();
        assert!(
            matches!(life.capture("x"), Err(LifecycleError::RetiredIds(_))),
            "stale marker cannot reopen a tombstone"
        );
        assert!(matches!(
            life.capture("orphan"),
            Err(LifecycleError::Unknown)
        ));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_closing_excludes_real_unscoped_child_in_both_orders() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a", "b"]));
        let b = life.capture("b").unwrap();
        let global = life.try_unscoped_operation().unwrap();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let (entered, in_child) = std::sync::mpsc::channel::<()>();
        let child = tokio::task::spawn_blocking(move || {
            let _actual_owner = global;
            entered.send(()).unwrap();
            let _ = gate.recv_timeout(Duration::from_secs(5));
        });
        in_child.recv_timeout(Duration::from_secs(5)).unwrap();
        let opposite_order_refused = matches!(
            life.try_close(lease(&["a"]), "a"),
            Err(LifecycleError::Busy)
        );
        release.send(()).unwrap();
        child.await.unwrap();

        let claim = life.try_close(lease(&["a"]), "a").unwrap();
        let b_independent = life.try_operation(&[b]).is_ok();
        let pre = life.try_unscoped_operation();
        let pre_effect_refused = matches!(&pre, Err(LifecycleError::Busy));
        drop(pre);
        drop(claim);
        let pre_effect_reopened = life.capture("a").is_ok();
        let reopened_allows_global = life.try_unscoped_operation().is_ok();

        let mut claim = life.try_close(lease(&["a"]), "a").unwrap();
        let drained = claim
            .wait_local_until(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        claim.mark_effects_started(drained).unwrap();
        let post = life.try_unscoped_operation();
        let post_effect_refused = matches!(&post, Err(LifecycleError::Busy));
        drop(post);
        drop(claim);
        let dropped = life.try_unscoped_operation();
        let post_drop_refused = matches!(&dropped, Err(LifecycleError::Busy));
        drop(dropped);

        let mut resumed = life.try_close(lease(&["a"]), "a").unwrap();
        let drained = resumed
            .wait_local_until(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        resumed.mark_effects_started(drained).unwrap();
        let late = life.try_unscoped_operation();
        let close_first_admitted = late.is_ok();
        let mut premature_retirement = false;
        if let Ok(owner) = late {
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let (entered, in_child) = std::sync::mpsc::channel::<()>();
            let child = tokio::task::spawn_blocking(move || {
                let _actual_owner = owner;
                entered.send(()).unwrap();
                let _ = gate.recv_timeout(Duration::from_secs(5));
            });
            in_child.recv_timeout(Duration::from_secs(5)).unwrap();
            let finished = resumed.finish_retired().is_ok();
            premature_retirement =
                finished && matches!(life.capture("a"), Err(LifecycleError::RetiredIds(_)));
            release.send(()).unwrap();
            child.await.unwrap();
            if !finished {
                let mut retry = life.try_close(lease(&["a"]), "a").unwrap();
                let drained = retry
                    .wait_local_until(Instant::now() + Duration::from_secs(5))
                    .await
                    .unwrap();
                retry.mark_effects_started(drained).unwrap();
                retry.finish_retired().unwrap();
            }
        } else {
            resumed.finish_retired().unwrap();
        }
        let retired = matches!(life.capture("a"), Err(LifecycleError::RetiredIds(_)));
        let retired_allows_global = life.try_unscoped_operation().is_ok();
        assert!(opposite_order_refused && b_independent && pre_effect_refused && pre_effect_reopened && reopened_allows_global && post_effect_refused && post_drop_refused && !close_first_admitted && !premature_retirement && retired && retired_allows_global,
            "unscoped/Closing: opposite_order_refused={opposite_order_refused}, b_independent={b_independent}, pre_effect_refused={pre_effect_refused}, pre_effect_reopened={pre_effect_reopened}, reopened_allows_global={reopened_allows_global}, post_effect_refused={post_effect_refused}, post_drop_refused={post_drop_refused}, close_first_admitted={close_first_admitted}, premature_retirement={premature_retirement}, retired={retired}, retired_allows_global={retired_allows_global}");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_local_drain_timeout_revokes_old_stamp() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a", "b"]));
        let old = life.capture("a").unwrap();
        let b = life.capture("b").unwrap();
        let local = life.try_commit(std::slice::from_ref(&old)).unwrap();
        let claim = life.try_close(lease(&["a"]), "a").unwrap();
        let wait = claim.wait_local_until(Instant::now() + Duration::from_millis(20)).await;
        assert!(matches!(wait, Err(LifecycleError::Busy)));
        assert!(life.try_operation(&[b]).is_ok(), "B remains independent during A's drain");
        drop(claim);
        drop(local);
        let fresh = life.capture("a").unwrap();
        assert_ne!(old.epoch, fresh.epoch, "a refused pre-effect drain must advance its epoch");
        assert!(matches!(life.try_commit(&[old]), Err(LifecycleError::Stale)),
            "S24_DRAIN_STAMP: prior A observation cannot publish after Busy");
    }

    #[test]
    fn p1_scope_mismatch_and_unscoped_owner_never_partially_admit() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a", "b"]));
        let scope = AccountWriteScope {
            ids: ["a".into(), "b".into()].into(),
            ..Default::default()
        };
        assert!(matches!(
            life.try_persistence(lease(&["a"]), &scope, PersistenceAuthority::Ordinary),
            Err(LifecycleError::Busy)
        ));
        assert!(
            life.try_close(lease(&["a"]), "a").is_ok(),
            "failed acquisition owns no partial A"
        );
        let unscoped = life.try_unscoped_operation().unwrap();
        assert!(matches!(
            life.try_close(lease(&["b"]), "b"),
            Err(LifecycleError::Busy)
        ));
        drop(unscoped);
        assert!(life.try_close(lease(&["b"]), "b").is_ok());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_live_claim_binds_exact_closing_cleanup_authority() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&["a", "b"]));
        let mut claim = life.try_close(lease(&["a"]), "a").unwrap();
        let scope_a = AccountWriteScope {
            ids: ["a".into()].into(),
            ..Default::default()
        };
        let scope_b = AccountWriteScope {
            ids: ["b".into()].into(),
            ..Default::default()
        };
        let pre_effect_refused = claim.cleanup_authority().is_err();
        let drained = claim
            .wait_local_until(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        claim.mark_effects_started(drained).unwrap();
        let bound = claim.cleanup_authority().unwrap();
        let ordinary_refused = life
            .try_persistence(lease(&["a"]), &scope_a, PersistenceAuthority::Ordinary)
            .is_err();
        let public_delete_refused = life
            .try_persistence(lease(&["a"]), &scope_a, PersistenceAuthority::DeleteOnly)
            .is_err();
        let other_refused = life
            .try_persistence(lease(&["b"]), &scope_b, bound.clone())
            .is_err();
        let exact = life.try_persistence(lease(&["a"]), &scope_a, bound.clone());
        let exact_admitted = exact.is_ok();
        let mut child_held = false;
        if let Ok(owner) = exact {
            let child_owner = owner.clone();
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let (entered, in_child) = std::sync::mpsc::channel::<()>();
            let child = tokio::task::spawn_blocking(move || {
                let _actual_owner = child_owner;
                entered.send(()).unwrap();
                gate.recv().unwrap();
            });
            in_child.recv_timeout(Duration::from_secs(5)).unwrap();
            drop(owner);
            drop(claim);
            let busy_while_child = life.try_close(lease(&["a"]), "a").is_err();
            release.send(()).unwrap();
            child.await.unwrap();
            let eligible_after_child = life.try_close(lease(&["a"]), "a").is_ok();
            child_held = busy_while_child && eligible_after_child;
        } else {
            drop(claim);
        }
        let stale_refused = life
            .try_persistence(lease(&["a"]), &scope_a, bound)
            .is_err();
        let nonopen_after_effect = matches!(life.capture("a"), Err(LifecycleError::Busy));
        assert!(pre_effect_refused && ordinary_refused && public_delete_refused && other_refused && exact_admitted && child_held && stale_refused && nonopen_after_effect,
            "claim-bound cleanup: pre_effect_refused={pre_effect_refused}, ordinary_refused={ordinary_refused}, public_delete_refused={public_delete_refused}, other_refused={other_refused}, exact_admitted={exact_admitted}, child_held={child_held}, stale_refused={stale_refused}, nonopen_after_effect={nonopen_after_effect}");
    }
    #[test]
    fn p1_import_target_publication_needs_bound_reservation() {
        let life = AccountLifecycle::default();
        life.seed(&listing(&[]));
        let import = life
            .reserve_import_target(&lease(&["zip"]), &listing(&[]), "zip")
            .unwrap();
        assert!(matches!(life.capture("zip"), Err(LifecycleError::Busy)));
        assert!(matches!(
            import.stamp("other"),
            Err(LifecycleError::Unknown)
        ));
        let stamp = import.stamp("zip").unwrap();
        let permit = life.try_import_commit(&stamp).unwrap();
        let scope = AccountWriteScope {
            ids: ["zip".into()].into(),
            ..Default::default()
        };
        let owner = life
            .try_import_persistence(lease(&["zip"]), &scope, &import)
            .unwrap();
        assert!(life.capture("zip").is_err());
        let unrelated = AccountLifecycle::default();
        unrelated.seed(&listing(&[]));
        let other_import = unrelated
            .reserve_import_target(&lease(&["zip"]), &listing(&[]), "zip")
            .unwrap();
        assert!(life
            .try_import_commit(&other_import.stamp("zip").unwrap())
            .is_err());
        assert!(life
            .try_import_persistence(lease(&["zip"]), &scope, &other_import)
            .is_err());
        life.apply_committed_membership(
            Some(&owner),
            &MembershipDelta {
                added: ["zip".into()].into(),
                removed: BTreeSet::new(),
            },
        );
        assert!(life.capture("zip").is_ok());
        drop(permit);
        drop(owner);
        drop(stamp);
        drop(import);
        drop(other_import);

        let leftover = life
            .reserve_import_target(&lease(&["unused"]), &listing(&["zip"]), "unused")
            .unwrap();
        let held = life
            .try_import_commit(&leftover.stamp("unused").unwrap())
            .unwrap();
        drop(leftover);
        assert!(matches!(life.capture("unused"), Err(LifecycleError::Busy)));
        drop(held);
        assert!(matches!(
            life.capture("unused"),
            Err(LifecycleError::Unknown)
        ));
    }
}
