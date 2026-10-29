//! Ordinary download-ahead body runner (Wave 4, S6).
//!
//! Consumes the exact scoped queues `pipeline_focus` derives (S5) and fetches
//! the bodies the account's download mode keeps, through the same stamped writer
//! the Hoarder sweep and IDLE arrivals use. It lives on its own named
//! background-QoS thread (`ordinary-body`, 8 MiB stack) and every pass is a heap
//! task, so no provider wait ever runs on a foreground or a request thread and no
//! lock is held across a body read.
//!
//! Shape, from the JS pipelines this replaces: the focused account runs three
//! slots, every other account one, walked one account at a time after the focused
//! pass settles; slots start 100ms apart and yield 10ms between fetches; a
//! transient failure retries after 3s, doubling to 120s, success resets it; a
//! spent daily limit puts the same UID back at the front and sleeps that account
//! until the native reset plus five seconds while the next account proceeds; a
//! download-cap change wakes it, a warning or upload-limit change does not; the
//! attachment prefetch runs once after the pass, with zero candidates too.
//!
//! None of Hoarder's private rules apply here: no 1,000 MiB budget, no fifteen
//! minute gap. The sweep and this runner only share an in-memory claim so one
//! exact message is never fetched by both at once.

use crate::account_lifecycle::AccountStamp;
use crate::server::DaemonState;
use mailvault_core::fetch_mode::FetchMode;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tracing::{info, warn};

const STAGGER: Duration = Duration::from_millis(100);
const YIELD: Duration = Duration::from_millis(10);
const RETRY_FIRST: Duration = Duration::from_secs(3);
const RETRY_MAX: Duration = Duration::from_secs(120);
/// The day has certainly turned over when the first fetch goes out again.
const LIMIT_MARGIN_MS: i64 = 5_000;
const TICK: Duration = Duration::from_millis(250);
/// A background account whose queue could not be derived yet is looked at again later.
const DERIVE_RETRY: Duration = Duration::from_secs(5);

/// Where a message stands after one body unit.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BodyUnitOutcome {
    /// The body is in the vault now (written, or a copy was already there).
    Stored,
    /// The download mode, the account's visibility or an On Demand policy says keep nothing.
    PolicySkipped,
    /// The server proved the message is gone.
    Gone,
    /// Today's daily download limit is spent; `resume_at_ms` is the next native reset.
    Limited { resume_at_ms: i64 },
    /// A failure worth another try after the backoff.
    Retryable(String),
    /// The account (or its source) was removed or replaced: nothing may be published.
    Retired,
}

pub(crate) fn next_retry_delay(current: Duration) -> Duration {
    (current * 2).min(RETRY_MAX)
}

// ── The in-flight claim shared with the Premium sweep ──────────────────────

type ClaimKey = (String, String, u32, u64);

/// Exact messages being fetched right now, by either fetcher. In memory only:
/// it is not a queue and nothing persists it.
#[derive(Default)]
pub(crate) struct Claims(Mutex<HashSet<ClaimKey>>);

pub(crate) struct ClaimGuard {
    claims: Arc<Claims>,
    key: ClaimKey,
}

impl Claims {
    pub(crate) fn claim(self: &Arc<Self>, account_id: &str, mailbox: &str, uid: u32, epoch: u64) -> Option<ClaimGuard> {
        let key = (account_id.to_owned(), mailbox.to_owned(), uid, epoch);
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.insert(key.clone()).then(|| ClaimGuard { claims: Arc::clone(self), key })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for ClaimGuard {
    fn drop(&mut self) {
        self.claims.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
    }
}

// ── One account's pass ─────────────────────────────────────────────────────

/// What `pipeline_focus` hands over: an exact folder, the identity its queue was
/// derived under, and the candidates in list order.
#[derive(Clone)]
pub(crate) struct Spec {
    pub account_id: String,
    pub mailbox: String,
    /// The ORIGINAL lifetime of the account. Never a fresh capture.
    pub stamp: AccountStamp,
    pub origin_hash: String,
    /// The folder cache's native header identity (UIDVALIDITY and origin) as JSON.
    pub identity: Option<String>,
    pub uids: Vec<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Role {
    Active,
    Background,
}

#[derive(Clone, PartialEq, Debug)]
pub(crate) enum Status {
    Pending,
    Running,
    /// The daily limit is spent. `limit` is the down limit at the time (`None`: cap off),
    /// compared on a settings change.
    Sleeping { resume_at_ms: i64, limit: Option<u64>, host: String },
    RetryWait { at: tokio::time::Instant },
    Done,
}

pub(crate) struct Pass {
    spec: Spec,
    role: Role,
    generation: u64,
    status: Status,
    queue: VecDeque<u32>,
    retry: Vec<u32>,
    delay: Duration,
    total: usize,
    completed: usize,
    attachments_done: bool,
    /// Body units in flight right now, for status and for pause checks.
    in_flight: usize,
}

/// What a pass does after its slots stopped.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settled {
    Sleeping,
    Finished,
    RetryLater,
    Interrupted,
}

impl Pass {
    fn new(spec: Spec, role: Role, generation: u64) -> Self {
        let queue: VecDeque<u32> = spec.uids.iter().copied().collect();
        let total = queue.len();
        Self { spec, role, generation, status: Status::Pending, queue, retry: Vec::new(), delay: RETRY_FIRST,
            total, completed: 0, attachments_done: false, in_flight: 0 }
    }

    fn take(&mut self) -> Option<u32> {
        self.queue.pop_front()
    }

    fn succeeded(&mut self) {
        self.completed += 1;
        self.delay = RETRY_FIRST;
    }

    fn gone(&mut self) {
        self.completed += 1;
    }

    fn failed(&mut self, uid: u32) {
        self.retry.push(uid);
    }

    /// A spent daily limit: the same UID goes back to the front and the whole
    /// account sleeps until the native reset plus five seconds.
    fn limited(&mut self, uid: u32, resume_at_ms: i64, limit: Option<u64>, host: &str) {
        self.queue.push_front(uid);
        self.status = Status::Sleeping { resume_at_ms: resume_at_ms + LIMIT_MARGIN_MS, limit, host: host.to_owned() };
    }

    fn settle(&mut self, now: tokio::time::Instant) -> Settled {
        if matches!(self.status, Status::Sleeping { .. }) { return Settled::Sleeping; }
        if self.queue.is_empty() && self.retry.is_empty() {
            self.status = Status::Done;
            return Settled::Finished;
        }
        if self.queue.is_empty() {
            self.status = Status::RetryWait { at: now + self.delay };
            return Settled::RetryLater;
        }
        self.status = Status::Pending;
        Settled::Interrupted
    }

    /// The backoff elapsed: stragglers go in front, the next wait doubles.
    fn requeue_retries(&mut self) {
        let mut merged: VecDeque<u32> = self.retry.drain(..).collect();
        merged.extend(self.queue.drain(..));
        self.queue = merged;
        self.delay = next_retry_delay(self.delay);
        self.status = Status::Pending;
    }

    /// Whether a sleeping pass may run again: its reset passed, or the cap was
    /// switched or the download limit changed (a warning or upload limit never is).
    fn should_wake(&self, now_ms: i64, limit_now: Option<Option<u64>>) -> bool {
        match &self.status {
            Status::Sleeping { resume_at_ms, limit, .. } =>
                now_ms >= *resume_at_ms || limit_now.is_some_and(|now| now != *limit),
            _ => false,
        }
    }

    fn progress(&self) -> crate::pipeline_focus::Progress {
        let (phase, paused) = match &self.status {
            Status::Pending | Status::Running => ("content", None),
            Status::Sleeping { .. } => ("idle", Some("dailyLimit")),
            Status::RetryWait { .. } => ("content", Some("retrying")),
            Status::Done => ("done", None),
        };
        crate::pipeline_focus::Progress { phase, queued: self.queue.len() + self.retry.len(), completed: self.completed,
            total: self.total, failed: self.retry.len(), paused, active: self.in_flight }
    }
}

// ── The runner ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct Inner {
    /// Offline or deliberately paused: nothing new launches until resumed.
    paused: bool,
    /// The focus generation that owns the passes below.
    generation: u64,
    passes: BTreeMap<String, Pass>,
    cascade: Vec<Origin>,
    walked: HashSet<(String, u64, String)>,
    skip_until: BTreeMap<String, tokio::time::Instant>,
    settings_dirty: bool,
    started: bool,
}

#[derive(Clone)]
pub(crate) struct Origin {
    pub account_id: String,
    pub stamp: AccountStamp,
    pub origin_hash: String,
}

#[derive(Default)]
pub(crate) struct OrdinaryRunner {
    inner: Mutex<Inner>,
    wake: Notify,
}

fn now_ms(state: &DaemonState) -> i64 {
    state.clock.now_ms()
}

impl OrdinaryRunner {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    /// The app went offline or came back. Running units finish; nothing new starts.
    pub(crate) fn set_paused(&self, paused: bool) {
        self.lock().paused = paused;
        self.wake();
    }

    /// A newer focus owns the runner: passes of any earlier one stop after their
    /// in-flight unit and are replaced. A running child keeps its own identity.
    pub(crate) fn retarget(&self, generation: u64, cascade: Vec<Origin>) {
        let mut inner = self.lock();
        inner.generation = generation;
        inner.passes.retain(|_, pass| pass.generation == generation);
        inner.cascade = cascade;
        drop(inner);
        self.wake();
    }

    /// The accounts the content cascade walks after the focused pass, in order.
    pub(crate) fn set_cascade(&self, generation: u64, cascade: Vec<Origin>) {
        {
            let mut inner = self.lock();
            if inner.generation != generation { return; }
            inner.cascade = cascade;
        }
        self.wake();
    }

    /// Queue the focused account's pass. Replaces whatever an earlier focus left
    /// for the same account; a stale generation is ignored.
    pub(crate) fn submit_active(self: &Arc<Self>, state: &Arc<DaemonState>, generation: u64, spec: Spec) {
        {
            let mut inner = self.lock();
            if inner.generation != generation { return; }
            inner.passes.insert(spec.account_id.clone(), Pass::new(spec, Role::Active, generation));
        }
        self.ensure_started(state);
        self.wake();
    }

    fn ensure_started(self: &Arc<Self>, state: &Arc<DaemonState>) {
        {
            let mut inner = self.lock();
            if inner.started { return; }
            inner.started = true;
        }
        start_thread(Arc::downgrade(state));
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn pass_snapshot(&self, account_id: &str) -> Option<(Status, usize, usize, usize)> {
        let inner = self.lock();
        inner.passes.get(account_id).map(|p| (p.status.clone(), p.queue.len() + p.retry.len(), p.completed, p.total))
    }

    /// The next candidate of a running pass, if the pass is still the current one
    /// and nothing is paused. The lock is never held across the fetch.
    fn next_unit(&self, account_id: &str, generation: u64) -> Option<(u32, Spec)> {
        let mut inner = self.lock();
        if inner.paused { return None; }
        let pass = inner.passes.get_mut(account_id).filter(|pass| pass.generation == generation)?;
        if pass.status != Status::Running { return None; }
        let uid = pass.take()?;
        Some((uid, pass.spec.clone()))
    }

    fn with_pass<T>(&self, account_id: &str, generation: u64, f: impl FnOnce(&mut Pass) -> T) -> Option<T> {
        let mut inner = self.lock();
        inner.passes.get_mut(account_id).filter(|pass| pass.generation == generation).map(f)
    }
}

// ── The body unit ──────────────────────────────────────────────────────────

/// One message: the limit and policy first, then exactly one provider fetch and
/// one stamped write. Provider kind decides the path BEFORE any pool checkout:
/// JMAP goes through its ledger, Graph through its own arm, IMAP through the pool.
pub(crate) async fn run_body_unit(state: &Arc<DaemonState>, stamp: &AccountStamp, config: &crate::imap::ImapConfig,
    account_id: &str, mailbox: &str, uid: u32) -> BodyUnitOutcome {
    use crate::handlers::common::blocking;
    // The finite local child owns its short permit through the whole unit.
    let Ok(_operation) = state.account_lifecycle.try_operation(std::slice::from_ref(stamp)) else {
        return BodyUnitOutcome::Retired;
    };
    let (app_dir, id) = (state.app_dir.clone(), account_id.to_owned());
    let policy = match blocking(move || crate::handlers::imap::download_policy(&app_dir, &id)).await {
        Ok(policy) => policy,
        Err(_) => return BodyUnitOutcome::Retryable("errors.syncUnavailable".into()),
    };
    // Hidden, or On Demand: nothing is fetched ahead.
    match policy {
        None => return BodyUnitOutcome::PolicySkipped,
        Some(policy) if policy.mode == FetchMode::OnDemand => return BodyUnitOutcome::PolicySkipped,
        Some(_) => {}
    }
    if let Some(refusal) = crate::handlers::imap::backfill_refusal(state, Some(account_id), &config.host, uid, mailbox).await {
        let resume = refusal["resumeAfterMs"].as_i64().unwrap_or_else(|| mailvault_core::transfer_limits::next_utc_midnight_ms(now_ms(state)));
        return BodyUnitOutcome::Limited { resume_at_ms: resume };
    }
    if config.uses_graph() {
        return crate::graph_body::run_graph_body_unit(state, stamp, config, account_id, mailbox, uid).await;
    }
    if config.uses_jmap() {
        return jmap_unit(state, stamp, config, account_id, mailbox, uid).await;
    }
    imap_unit(state, stamp, config, account_id, mailbox, uid).await
}

pub(crate) async fn stored(state: &Arc<DaemonState>, stamp: &AccountStamp, result: Result<bool, String>) -> BodyUnitOutcome {
    match result {
        Ok(true) => BodyUnitOutcome::Stored,
        // The download mode decided at the writer: outside the window, or hidden.
        Ok(false) => BodyUnitOutcome::PolicySkipped,
        Err(error) => {
            if state.account_lifecycle.try_operation(std::slice::from_ref(stamp)).is_err() { BodyUnitOutcome::Retired }
            else { BodyUnitOutcome::Retryable(error) }
        }
    }
}

async fn imap_unit(state: &Arc<DaemonState>, stamp: &AccountStamp, config: &crate::imap::ImapConfig, account_id: &str,
    mailbox: &str, uid: u32) -> BodyUnitOutcome {
    use crate::handlers::imap::{auto_cache, email_date_ms, BODY_FETCH_TIMEOUT};
    let fetch = state.imap_pool.run_read(config, false, |mut session| {
        let mb = mailbox.to_owned();
        async move {
            let email = crate::imap::fetch_email_by_uid_light(&mut session, &mb, uid).await?;
            Ok((email, session, Some(mb)))
        }
    });
    match tokio::time::timeout(BODY_FETCH_TIMEOUT, fetch).await {
        Ok(Ok(Some(email))) if email.uid == uid => {
            let dated = email_date_ms(email.date.as_deref(), email.internal_date.as_deref());
            let result = auto_cache(state, stamp.clone(), mailbox.to_owned(), uid, email.raw_source_bytes, dated, false).await;
            stored(state, stamp, result).await
        }
        // Proven absence (a tagged OK on the second probe), or another message under the number.
        Ok(Ok(_)) => BodyUnitOutcome::Gone,
        Ok(Err(error)) => {
            warn!("[ordinary] {account_id} {mailbox}: uid {uid} not fetched: {error}");
            BodyUnitOutcome::Retryable(error)
        }
        Err(_) => BodyUnitOutcome::Retryable("timed out".into()),
    }
}

async fn jmap_unit(state: &Arc<DaemonState>, stamp: &AccountStamp, config: &crate::imap::ImapConfig, account_id: &str,
    mailbox: &str, uid: u32) -> BodyUnitOutcome {
    use crate::handlers::imap::{auto_cache_with_ids, BODY_FETCH_TIMEOUT};
    let wanted = [uid];
    let fetch = crate::handlers::jmap_bridge::fetch_by_uids(state, config, account_id, mailbox, &wanted);
    match tokio::time::timeout(BODY_FETCH_TIMEOUT, fetch).await {
        // The ledger knows no id for this uid, or the message left the folder.
        Ok(Ok(bodies)) => match bodies.into_iter().find(|(got, _)| *got == uid) {
            None => BodyUnitOutcome::Gone,
            Some((_, Err(error))) => BodyUnitOutcome::Retryable(error),
            Some((_, Ok(body))) => {
                let dated = crate::handlers::jmap_bridge::dated_ms(&body.raw, body.received_at.as_deref());
                let result = auto_cache_with_ids(state, stamp.clone(), mailbox.to_owned(), uid, body.raw, dated, false, Some(body.ids)).await;
                stored(state, stamp, result).await
            }
        },
        Ok(Err(error)) => BodyUnitOutcome::Retryable(error),
        Err(_) => BodyUnitOutcome::Retryable("timed out".into()),
    }
}

/// Gone prunes only the header row of the exact native identity the queue was
/// derived under; a replaced mailbox is left alone.
async fn prune_gone(state: &Arc<DaemonState>, spec: &Spec, uid: u32) -> bool {
    let state2 = Arc::clone(state);
    let (account, mailbox, identity) = (spec.account_id.clone(), spec.mailbox.clone(), spec.identity.clone());
    let pruned = crate::handlers::common::blocking(move || {
        crate::custody::with_conn(&state2, |conn| {
            let now = mailvault_core::custody::cache::native_identity(conn, &account, &mailbox)?
                .and_then(|identity| serde_json::to_string(&identity).ok());
            if now != identity { return Ok(false); }
            Ok(mailvault_core::custody::cache::remove_headers(conn, &account, &mailbox, &[uid])? > 0)
        }).unwrap_or(false)
    }).await.unwrap_or(false);
    if pruned { state.sync_engine.note_change(&spec.account_id, &spec.mailbox, 0, 1); }
    pruned
}

/// Whether the folder cache is still the one this queue was derived under.
async fn identity_current(state: &Arc<DaemonState>, spec: &Spec) -> bool {
    let state2 = Arc::clone(state);
    let (account, mailbox, identity) = (spec.account_id.clone(), spec.mailbox.clone(), spec.identity.clone());
    crate::handlers::common::blocking(move || {
        crate::custody::with_conn(&state2, |conn| {
            let now = mailvault_core::custody::cache::native_identity(conn, &account, &mailbox)?
                .and_then(|identity| serde_json::to_string(&identity).ok());
            Ok(now == identity)
        }).unwrap_or(false)
    }).await.unwrap_or(false)
}

// ── Passes ─────────────────────────────────────────────────────────────────

fn report(state: &Arc<DaemonState>, spec: &Spec, progress: crate::pipeline_focus::Progress) {
    state.hoarder_worker.pipeline.report(state, &spec.account_id, spec.stamp.epoch(), &spec.origin_hash, progress);
}

async fn slot(state: Arc<DaemonState>, account_id: String, generation: u64, config: Arc<crate::imap::ImapConfig>, index: usize) {
    let runner = Arc::clone(&state.hoarder_worker.ordinary);
    tokio::time::sleep(STAGGER * index as u32).await;
    while let Some((uid, spec)) = runner.next_unit(&account_id, generation) {
        if !identity_current(&state, &spec).await {
            // The folder was replaced under this queue: it is never reinterpreted.
            runner.lock().passes.remove(&account_id);
            return;
        }
        let Some(_claim) = state.hoarder_worker.claims.claim(&account_id, &spec.mailbox, uid, spec.stamp.epoch()) else {
            runner.with_pass(&account_id, generation, |pass| pass.failed(uid));
            continue;
        };
        runner.with_pass(&account_id, generation, |pass| pass.in_flight += 1);
        let outcome = run_body_unit(&state, &spec.stamp, &config, &account_id, &spec.mailbox, uid).await;
        drop(_claim);
        runner.with_pass(&account_id, generation, |pass| pass.in_flight = pass.in_flight.saturating_sub(1));
        let mut sleeping = false;
        match outcome {
            BodyUnitOutcome::Stored | BodyUnitOutcome::PolicySkipped => { runner.with_pass(&account_id, generation, Pass::succeeded); }
            BodyUnitOutcome::Gone => {
                prune_gone(&state, &spec, uid).await;
                runner.with_pass(&account_id, generation, Pass::gone);
            }
            BodyUnitOutcome::Limited { resume_at_ms } => {
                let (app_dir, id, host, now) = (state.app_dir.clone(), account_id.clone(), config.host.clone(), now_ms(&state));
                let limit = crate::handlers::common::blocking(move ||
                    mailvault_core::transfer_limits::background_status_at(&app_dir, &id, &host, now).map(|a| a.limit_bytes))
                    .await.unwrap_or(None);
                runner.with_pass(&account_id, generation, |pass| pass.limited(uid, resume_at_ms, limit, &config.host));
                sleeping = true;
            }
            BodyUnitOutcome::Retryable(error) => {
                info!("[ordinary] {account_id}: uid {uid} will be retried: {error}");
                runner.with_pass(&account_id, generation, |pass| pass.failed(uid));
            }
            BodyUnitOutcome::Retired => {
                runner.lock().passes.remove(&account_id);
                return;
            }
        }
        if let Some(progress) = runner.with_pass(&account_id, generation, |pass| pass.progress()) {
            report(&state, &spec, progress);
        }
        if sleeping { return; }
        tokio::time::sleep(YIELD).await;
    }
}

async fn run_pass(state: Arc<DaemonState>, account_id: String, generation: u64) {
    let runner = Arc::clone(&state.hoarder_worker.ordinary);
    // The daemon's own token resolution, per round, so a retry after a refused
    // token already carries a renewed one. The renderer never sends one.
    let config = match crate::oauth_tokens::resolve(&state, &account_id, crate::oauth_tokens::Read::Quiet).await {
        Ok(config) => Arc::new(config),
        Err(error) => {
            warn!("[ordinary] {account_id}: credentials unavailable: {error}");
            runner.with_pass(&account_id, generation, |pass| {
                pass.status = Status::RetryWait { at: tokio::time::Instant::now() + pass.delay };
                pass.delay = next_retry_delay(pass.delay);
            });
            return;
        }
    };
    let slots = match runner.with_pass(&account_id, generation, |pass| pass.role) {
        Some(Role::Active) => mailvault_core::pipeline::ACTIVE_WORKERS,
        Some(Role::Background) => mailvault_core::pipeline::BACKGROUND_CONTENT_WORKERS,
        None => return,
    };
    let tasks: Vec<_> = (0..slots).map(|index| tokio::spawn(slot(Arc::clone(&state), account_id.clone(), generation,
        Arc::clone(&config), index))).collect();
    for task in tasks { let _ = task.await; }
    let now = tokio::time::Instant::now();
    let Some((settled, spec, attachments_done)) = runner.with_pass(&account_id, generation, |pass| {
        (pass.settle(now), pass.spec.clone(), pass.attachments_done)
    }) else { return };
    // Bodies first, attachments after: once per pass, stragglers or none.
    if matches!(settled, Settled::Finished | Settled::RetryLater) && !attachments_done {
        runner.with_pass(&account_id, generation, |pass| pass.attachments_done = true);
        prefetch_attachments_once(&state, &spec).await;
    }
    if settled == Settled::Finished {
        let key = (account_id.clone(), spec.stamp.epoch(), spec.origin_hash.clone());
        runner.lock().walked.insert(key);
    }
    if let Some(progress) = runner.with_pass(&account_id, generation, |pass| pass.progress()) {
        report(&state, &spec, progress);
    }
    runner.wake();
}

async fn prefetch_attachments_once(state: &Arc<DaemonState>, spec: &Spec) {
    let app_dir = state.app_dir.clone();
    let enabled = crate::handlers::common::blocking(move || {
        mailvault_core::settings_doc::SettingsDoc::shared(&app_dir).read().ok()
            .and_then(|doc| doc.get("mailvault-settings")?.get("state")?.get("autoDownloadAttachments")?.as_bool())
            .unwrap_or(false)
    }).await.unwrap_or(false);
    if !enabled { return; }
    if let Err(error) = crate::handlers::vault_files::prefetch_attachments_for(state, Ok(spec.stamp.clone()),
        &spec.account_id, &spec.mailbox).await {
        warn!("[ordinary] {}: attachment prefetch failed: {error}", spec.account_id);
    }
}

// ── The supervisor thread ──────────────────────────────────────────────────

fn start_thread(weak: std::sync::Weak<DaemonState>) {
    let spawned = std::thread::Builder::new().name("ordinary-body".into()).stack_size(8 * 1024 * 1024).spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
        }
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all()
            .thread_name("ordinary-body-blocking").thread_stack_size(8 * 1024 * 1024)
            .on_thread_start(|| {
                #[cfg(target_os = "macos")]
                unsafe {
                    libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
                }
            }).build();
        let Ok(runtime) = runtime else { return };
        runtime.block_on(supervise(weak));
    });
    if let Err(error) = spawned { warn!("ordinary body runner unavailable: {error}"); }
}

async fn supervise(weak: std::sync::Weak<DaemonState>) {
    let mut events = match weak.upgrade() { Some(state) => state.events.subscribe(), None => return };
    loop {
        let Some(state) = weak.upgrade() else { return };
        let runner = Arc::clone(&state.hoarder_worker.ordinary);
        tick(&state, &runner).await;
        drop(state);
        tokio::select! {
            _ = runner.wake.notified() => {}
            _ = tokio::time::sleep(TICK) => {}
            event = events.recv() => match event {
                Ok(line) => {
                    let name = mailvault_core::daemon_ipc::parse_event(&line).map(|(name, _)| name).unwrap_or_default();
                    if name == "settings-changed" { runner.lock().settings_dirty = true; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => runner.lock().settings_dirty = true,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

/// One scheduling look: wake what may wake, launch what may run.
async fn tick(state: &Arc<DaemonState>, runner: &Arc<OrdinaryRunner>) {
    let now = tokio::time::Instant::now();
    // Sleeping passes: the reset passed, or the download cap changed.
    let (sleeping, dirty) = {
        let mut inner = runner.lock();
        let dirty = std::mem::take(&mut inner.settings_dirty);
        let sleeping: Vec<(String, String)> = inner.passes.iter().filter_map(|(id, pass)| match &pass.status {
            Status::Sleeping { host, .. } => Some((id.clone(), host.clone())), _ => None }).collect();
        (sleeping, dirty)
    };
    for (id, host) in sleeping {
        let limit_now = if dirty {
            let (app_dir, account, host, at) = (state.app_dir.clone(), id.clone(), host, now_ms(state));
            crate::handlers::common::blocking(move ||
                mailvault_core::transfer_limits::background_status_at(&app_dir, &account, &host, at).map(|a| a.limit_bytes))
                .await.ok()
        } else { None };
        let at = now_ms(state);
        let mut inner = runner.lock();
        if let Some(pass) = inner.passes.get_mut(&id) {
            if pass.should_wake(at, limit_now) { pass.status = Status::Pending; }
        }
    }
    // Retry waits that elapsed.
    {
        let mut inner = runner.lock();
        for pass in inner.passes.values_mut() {
            if matches!(pass.status, Status::RetryWait { at } if at <= now) { pass.requeue_retries(); }
        }
    }
    // Launch: the focused account first; the cascade one account at a time after it.
    let mut launch: Vec<(String, u64)> = Vec::new();
    let mut derive: Option<Origin> = None;
    {
        let mut inner = runner.lock();
        if inner.paused { return; }
        let active_blocks = inner.passes.values().any(|p| p.role == Role::Active
            && matches!(p.status, Status::Pending | Status::Running | Status::RetryWait { .. }));
        for pass in inner.passes.values_mut() {
            if pass.role == Role::Active && pass.status == Status::Pending {
                pass.status = Status::Running;
                launch.push((pass.spec.account_id.clone(), pass.generation));
            }
        }
        if !active_blocks {
            let background_busy = inner.passes.values().any(|p| p.role == Role::Background
                && matches!(p.status, Status::Running | Status::RetryWait { .. }));
            if !background_busy {
                if let Some(pass) = inner.passes.values_mut().find(|p| p.role == Role::Background && p.status == Status::Pending) {
                    pass.status = Status::Running;
                    launch.push((pass.spec.account_id.clone(), pass.generation));
                } else {
                    derive = inner.cascade.iter().find(|origin| {
                        !inner.passes.contains_key(&origin.account_id)
                            && !inner.walked.contains(&(origin.account_id.clone(), origin.stamp.epoch(), origin.origin_hash.clone()))
                            && inner.skip_until.get(&origin.account_id).is_none_or(|until| *until <= now)
                    }).cloned();
                }
            }
        }
    }
    if let Some(origin) = derive {
        let generation = runner.lock().generation;
        match crate::pipeline_focus::derive_cascade(state, &origin).await {
            Some(spec) => {
                let mut inner = runner.lock();
                if inner.generation == generation {
                    let id = spec.account_id.clone();
                    inner.passes.insert(id, Pass::new(spec, Role::Background, generation));
                }
                drop(inner);
                runner.wake();
            }
            None => { runner.lock().skip_until.insert(origin.account_id.clone(), now + DERIVE_RETRY); }
        }
    }
    for (account_id, generation) in launch {
        tokio::spawn(run_pass(Arc::clone(state), account_id, generation));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(uids: &[u32]) -> Spec {
        let lifecycle = crate::account_lifecycle::AccountLifecycle::default();
        lifecycle.seed(&mailvault_core::accounts_doc::Listing {
            accounts: vec![json!({"id": "acc1"})], version: 0, recovered: None });
        Spec { account_id: "acc1".into(), mailbox: "INBOX".into(), stamp: lifecycle.capture("acc1").unwrap(),
            origin_hash: "hash".into(), identity: Some("{\"uidValidity\":1}".into()), uids: uids.to_vec() }
    }

    #[test]
    fn s6_retry_delay_starts_at_three_seconds_doubles_to_120_and_success_resets_it() {
        let mut delay = RETRY_FIRST;
        let mut seen = vec![delay.as_secs()];
        for _ in 0..7 { delay = next_retry_delay(delay); seen.push(delay.as_secs()); }
        assert_eq!(seen, vec![3, 6, 12, 24, 48, 96, 120, 120]);
        let mut pass = Pass::new(spec(&[1]), Role::Active, 1);
        pass.delay = Duration::from_secs(48);
        pass.succeeded();
        assert_eq!(pass.delay, RETRY_FIRST, "a success resets the backoff to 3s");
    }

    #[test]
    fn s6_a_spent_limit_requeues_the_same_uid_at_the_front_and_sleeps_to_the_reset_plus_five_seconds() {
        let mut pass = Pass::new(spec(&[10, 11, 12]), Role::Active, 1);
        let first = pass.take().unwrap();
        assert_eq!(first, 10);
        pass.limited(first, 1_000_000, Some(50), "imap.example.test");
        assert_eq!(pass.queue.front(), Some(&10), "the refused uid goes back to the front, not the end");
        assert_eq!(pass.queue.len(), 3);
        assert_eq!(pass.status, Status::Sleeping { resume_at_ms: 1_005_000, limit: Some(50), host: "imap.example.test".into() });
        assert!(!pass.should_wake(1_004_999, None), "five seconds of margin after the native reset");
        assert!(pass.should_wake(1_005_000, None));
    }

    #[test]
    fn s6_only_a_download_cap_change_wakes_a_sleeping_pass_early() {
        let mut pass = Pass::new(spec(&[1]), Role::Active, 1);
        pass.limited(1, 10_000_000, Some(100), "h");
        assert!(!pass.should_wake(0, Some(Some(100))), "an unchanged download limit (a warning or upload edit) does not wake it");
        assert!(!pass.should_wake(0, None), "no settings change, no wake");
        assert!(pass.should_wake(0, Some(None)), "the cap switched off wakes it");
        assert!(pass.should_wake(0, Some(Some(200))), "a new download limit wakes it");
    }

    #[test]
    fn s6_stragglers_retry_in_front_after_the_backoff_and_the_wait_doubles() {
        let mut pass = Pass::new(spec(&[1, 2, 3]), Role::Background, 1);
        pass.status = Status::Running;
        let a = pass.take().unwrap();
        pass.failed(a);
        pass.queue.clear();
        let now = tokio::time::Instant::now();
        assert_eq!(pass.settle(now), Settled::RetryLater);
        assert_eq!(pass.status, Status::RetryWait { at: now + RETRY_FIRST });
        pass.requeue_retries();
        assert_eq!(pass.queue.front(), Some(&1));
        assert_eq!(pass.delay, Duration::from_secs(6));
        pass.queue.clear();
        assert_eq!(pass.settle(now), Settled::Finished, "a drained pass is done, zero candidates included");
        let mut empty = Pass::new(spec(&[]), Role::Active, 1);
        assert_eq!(empty.settle(now), Settled::Finished, "an empty queue still finishes, which runs the attachment prefetch");
    }

    #[test]
    fn s6_one_exact_message_has_one_fetcher_at_a_time() {
        let claims: Arc<Claims> = Arc::default();
        let first = claims.claim("acc1", "INBOX", 7, 1).expect("first claim");
        assert!(claims.claim("acc1", "INBOX", 7, 1).is_none(), "the sweep cannot fetch what the runner holds");
        assert!(claims.claim("acc1", "Sent", 7, 1).is_some(), "the same number in another folder is another message");
        assert!(claims.claim("acc2", "INBOX", 7, 1).is_some(), "and in another account");
        assert!(claims.claim("acc1", "INBOX", 7, 2).is_some(), "and under another account lifetime");
        drop(first);
        assert!(claims.claim("acc1", "INBOX", 7, 1).is_some(), "released on drop");
    }

    #[tokio::test]
    async fn s6_a_retired_account_is_refused_before_any_provider_or_policy_work() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"fetchMode": "hoarder"}}}).to_string()).unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        std::fs::write(dir.path().join("accounts.json"), json!([{"id": "acc1", "email": "a@example.test",
            "authType": "password", "imapHost": "127.0.0.1", "imapPort": 1, "imapSecure": false}]).to_string()).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
        let stamp = state.account_lifecycle.capture("acc1").unwrap();
        let config: crate::imap::ImapConfig = serde_json::from_value(json!({"email": "a@example.test",
            "imapHost": "127.0.0.1", "imapPort": 1, "imapSecure": false})).unwrap();
        state.account_lifecycle.apply_committed_membership(None, &mailvault_core::accounts_doc::MembershipDelta {
            removed: ["acc1".to_owned()].into(), ..Default::default() });
        let outcome = run_body_unit(&state, &stamp, &config, "acc1", "INBOX", 7).await;
        assert_eq!(outcome, BodyUnitOutcome::Retired, "the old lifetime can never fetch or publish");
        assert_eq!(state.hoarder_worker.claims.len(), 0);
    }

    #[tokio::test]
    async fn s6_on_demand_and_hidden_accounts_fetch_nothing_ahead() {
        for (state_json, label) in [(json!({"fetchMode": "onDemand"}), "on demand"),
            (json!({"fetchMode": "hoarder", "hiddenAccounts": {"acc1": true}}), "hidden")] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("frontend-settings.json"),
                json!({"mailvault-settings": {"state": state_json}}).to_string()).unwrap();
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            std::fs::write(dir.path().join("accounts.json"), json!([{"id": "acc1", "email": "a@example.test",
                "authType": "password", "imapHost": "127.0.0.1", "imapPort": 1, "imapSecure": false}]).to_string()).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
            let stamp = state.account_lifecycle.capture("acc1").unwrap();
            let config: crate::imap::ImapConfig = serde_json::from_value(json!({"email": "a@example.test",
                "imapHost": "127.0.0.1", "imapPort": 1, "imapSecure": false})).unwrap();
            // Port 1 refuses a connection: reaching the provider would be a Retryable, not a skip.
            let outcome = run_body_unit(&state, &stamp, &config, "acc1", "INBOX", 7).await;
            assert_eq!(outcome, BodyUnitOutcome::PolicySkipped, "{label}");
        }
    }

    #[tokio::test]
    async fn s6_gone_prunes_only_the_exact_native_identity() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        std::fs::write(dir.path().join("accounts.json"), json!([{"id": "acc1", "email": "a@example.test",
            "authType": "password", "imapHost": "127.0.0.1", "imapPort": 1, "imapSecure": false}]).to_string()).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
        let seed = json!({"emails": [{"uid": 7, "subject": "s"}, {"uid": 8, "subject": "t"}], "totalEmails": 2,
            "nativeIdentity": {"accountId": "acc1", "mailbox": "INBOX", "uidValidity": 5, "originHash": "o"},
            "nativeExpectedIdentity": null}).to_string();
        crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn, "acc1", "INBOX", &seed)).unwrap();
        let identity = crate::custody::with_conn(&state, |conn|
            mailvault_core::custody::cache::native_identity(conn, "acc1", "INBOX")).unwrap()
            .map(|identity| serde_json::to_string(&identity).unwrap());
        let mut other = spec(&[7]);
        other.identity = Some("{\"uidValidity\":999}".into());
        assert!(!prune_gone(&state, &other, 7).await, "a different identity prunes nothing");
        let mut exact = spec(&[7]);
        exact.identity = identity;
        assert!(prune_gone(&state, &exact, 7).await, "the exact identity prunes the gone row");
        let left = crate::custody::with_conn(&state, |conn|
            mailvault_core::custody::cache::uid_set(conn, "acc1", "INBOX")).unwrap();
        assert_eq!(left.into_iter().collect::<Vec<u32>>(), vec![8], "only the gone uid left the cache");
    }
}
