//! Ordinary download-ahead focus (Wave 4, S5). Lives beside the Hoarder worker
//! state (`HoarderWorkerState::pipeline`) and stays apart from its Premium
//! full-folder sweep: the sweep keeps its private budget, gaps and schedule, this
//! module has none of them.
//!
//! The app reports which view it shows (`pipeline.focus`: account, folder, scope
//! and the loaded rows as hints). Native derives everything else: the real folder,
//! the cached rows and dates, the kept set, the account's keep policy. It queues
//! the download-ahead candidates per exact `(account, folder)` and warms headers
//! (the focused folder and each Sent folder alongside, background accounts in
//! chunks of three) through the S2 refresh worker. The ordinary BODY runner is
//! S6: until then candidates are counted, never fetched, and the JS pipelines keep
//! running in production because no caller exists before the S7 cutover.

use crate::refresh_worker::{Intent, Reason, RefreshState};
use crate::server::DaemonState;
use mailvault_core::fetch_mode::{FetchMode, FetchPolicy};
use crate::account_lifecycle::AccountStamp;
use crate::ordinary_runner::{Origin, Spec};
use mailvault_core::pipeline::{self, Focus, Observation, Scoped};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Active,
    Background,
}

/// Where one account stands. Everything here is derived natively; the app only
/// reads it back (`pipeline.status`, `pipeline-progress`).
#[derive(Clone)]
struct Entry {
    role: Role,
    mailbox: String,
    phase: &'static str,
    queued: usize,
    completed: usize,
    total: usize,
    failed: usize,
    paused: Option<&'static str>,
    /// The account lifetime and configuration this entry was derived under; an
    /// entry whose account was removed or reconfigured is retired, never reused.
    epoch: u64,
    origin_hash: String,
    /// The candidates of the focused folder, in list order.
    runnable: Vec<u32>,
    /// The folder cache's native header identity the candidates were derived under.
    identity: Option<String>,
}

impl Entry {
    fn json(&self) -> Value {
        let mut value = json!({"phase": self.phase, "queued": self.queued, "completed": self.completed,
            "total": self.total, "failed": self.failed, "mailbox": self.mailbox});
        if let Some(reason) = self.paused { value["pausedReason"] = json!(reason); }
        value
    }
}

/// What the body runner reports about one account's pass.
pub(crate) struct Progress {
    pub phase: &'static str,
    pub queued: usize,
    pub completed: usize,
    pub total: usize,
    pub failed: usize,
    pub paused: Option<&'static str>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct WarmKey {
    account_id: String,
    mailbox: String,
    epoch: u64,
    origin_hash: String,
}

/// What the app reports. Rows are loaded-list observations, not authority.
pub(crate) struct FocusInput {
    pub revision: u64,
    pub online: bool,
    pub focus: Option<Focus>,
}

#[derive(Default)]
struct Inner {
    revision: u64,
    offline: bool,
    accepted: Option<u64>,
    /// The planning pass the current focus owns; a newer focus supersedes it.
    generation: u64,
    entries: BTreeMap<String, Entry>,
    warmed: HashSet<WarmKey>,
    request_seq: u64,
    /// The newest generation whose candidate planning finished.
    planned: u64,
    /// Header warms admitted by this focus that have not settled.
    in_flight: usize,
}

#[derive(Default)]
pub(crate) struct PipelineFocus {
    inner: Mutex<Inner>,
    #[cfg(test)]
    admissions: std::sync::atomic::AtomicUsize,
}

fn digest(input: &FocusInput) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.online.hash(&mut hasher);
    if let Some(focus) = &input.focus {
        focus.account_id.hash(&mut hasher);
        focus.mailbox.hash(&mut hasher);
        (focus.scope as u8).hash(&mut hasher);
        for row in &focus.rows {
            row.account_id.hash(&mut hasher);
            row.mailbox.hash(&mut hasher);
            row.uid.hash(&mut hasher);
            row.date.as_ref().map(Value::to_string).hash(&mut hasher);
            row.internal_date.as_ref().map(Value::to_string).hash(&mut hasher);
        }
    } else {
        0u8.hash(&mut hasher);
    }
    hasher.finish()
}

impl PipelineFocus {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record a newer focus and return at once. Planning and header warming run
    /// as their own heap task, so the foreground never waits on a provider.
    pub(crate) fn accept(state: &Arc<DaemonState>, input: FocusInput) -> Result<Value, &'static str> {
        let this = &state.hoarder_worker.pipeline;
        let mut inner = this.lock();
        if input.revision < inner.revision {
            return Ok(json!({"revision": inner.revision, "accepted": false}));
        }
        let fingerprint = digest(&input);
        if input.revision == inner.revision && inner.accepted.is_some() {
            if inner.accepted != Some(fingerprint) { return Err("errors.accountsInvalid"); }
            return Ok(json!({"revision": inner.revision, "accepted": true}));
        }
        inner.revision = input.revision;
        inner.accepted = Some(fingerprint);
        inner.offline = !input.online;
        inner.generation += 1;
        let generation = inner.generation;
        let revision = inner.revision;
        let offline = inner.offline;
        match input.focus {
            None => {
                inner.entries.clear();
                drop(inner);
                state.hoarder_worker.ordinary.set_paused(offline);
                state.hoarder_worker.ordinary.retarget(generation, Vec::new());
            }
            Some(focus) => {
                // The previous focus's roles are over; its entries are rebuilt below.
                inner.entries.retain(|_, entry| entry.role == Role::Background);
                drop(inner);
                // Earlier passes stop after their in-flight unit; the new ones are queued by `plan`.
                state.hoarder_worker.ordinary.set_paused(offline);
                state.hoarder_worker.ordinary.retarget(generation, Vec::new());
                let state = Arc::clone(state);
                tokio::spawn(async move { plan(state, generation, focus).await });
            }
        }
        Ok(json!({"revision": revision, "accepted": true}))
    }

    fn current(&self, generation: u64) -> bool {
        self.lock().generation == generation
    }

    /// The runner's progress for an account, applied only to the entry derived
    /// under the same account lifetime and configuration.
    pub(crate) fn report(&self, state: &Arc<DaemonState>, account_id: &str, epoch: u64, origin_hash: &str, progress: Progress) {
        {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(account_id) else { return };
            if entry.epoch != epoch || entry.origin_hash != origin_hash { return; }
            entry.phase = progress.phase;
            entry.queued = progress.queued;
            entry.completed = progress.completed;
            entry.total = progress.total;
            entry.failed = progress.failed;
            entry.paused = progress.paused;
        }
        self.emit(state, account_id);
    }

    fn offline(&self) -> bool {
        self.lock().offline
    }

    /// The warm of this account's INBOX finished: its cache can be read for a cascade pass.
    fn headers_ready(&self, account_id: &str) -> bool {
        self.lock().entries.get(account_id).is_none_or(|entry| entry.phase != "headers")
    }

    fn snapshot(&self, instance_id: &str) -> Value {
        let inner = self.lock();
        let accounts: serde_json::Map<String, Value> = inner.entries.iter()
            .map(|(id, entry)| (id.clone(), entry.json())).collect();
        json!({"instanceId": instance_id, "revision": inner.revision, "accounts": accounts})
    }

    fn emit(&self, state: &Arc<DaemonState>, account_id: &str) {
        let entry = self.lock().entries.get(account_id).cloned();
        if let Some(entry) = entry {
            let mut payload = entry.json();
            payload["accountId"] = json!(account_id);
            payload["instanceId"] = json!(state.refresh.instance_id());
            payload["revision"] = json!(self.lock().revision);
            state.events.emit("pipeline-progress", payload);
        }
    }

    /// Drop every entry whose account is gone, hidden, replaced or reconfigured.
    pub(crate) async fn status(state: &Arc<DaemonState>) -> Value {
        let this = &state.hoarder_worker.pipeline;
        retire_stale(state).await;
        this.snapshot(state.refresh.instance_id())
    }

    #[cfg(test)]
    pub(crate) fn runnable(&self) -> Vec<(String, String, Vec<u32>)> {
        self.lock().entries.iter().filter(|(_, e)| e.role == Role::Active)
            .map(|(id, e)| (id.clone(), e.mailbox.clone(), e.runnable.clone())).collect()
    }

    /// Planning of the newest focus is done and no header warm is still running.
    #[cfg(test)]
    pub(crate) async fn quiet(&self) {
        for _ in 0..500 {
            {
                let inner = self.lock();
                if inner.planned == inner.generation && inner.in_flight == 0 { return; }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the pipeline focus never settled");
    }

    #[cfg(test)]
    pub(crate) fn admissions(&self) -> usize {
        self.admissions.load(std::sync::atomic::Ordering::SeqCst)
    }
}

async fn retire_stale(state: &Arc<DaemonState>) {
    let this = &state.hoarder_worker.pipeline;
    let ids: Vec<String> = this.lock().entries.keys().cloned().collect();
    if ids.is_empty() { return; }
    let Ok((listing, settings)) = crate::refresh_worker::authoritative_snapshot(state).await else { return };
    let authoritative = mailvault_core::accounts_doc::authoritative_ids(&listing.accounts);
    let visible = mailvault_core::refresh_policy::visible_account_ids(&listing.accounts, &authoritative, &settings);
    let mut inner = this.lock();
    for id in ids {
        let keep = visible.iter().any(|current| *current == id) && inner.entries.get(&id).is_some_and(|entry| {
            let row = listing.accounts.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()));
            let hash = row.and_then(|row| crate::credentials::config_from_record(row).ok())
                .map(|config| mailvault_core::bulk_worker::origin_hash(&config));
            let epoch = state.account_lifecycle.capture(&id).ok().map(|stamp| stamp.epoch());
            hash.as_deref() == Some(entry.origin_hash.as_str()) && epoch == Some(entry.epoch)
        });
        if !keep { inner.entries.remove(&id); }
    }
}

/// What one account's focused folder reads back from the native stores.
struct Read {
    /// Cache rows of the observed uids, in list order, with the cache's own dates.
    cached: Vec<Observation>,
    cache_total: Option<usize>,
    /// `None`: the vault could not be read, which is unknown and never empty.
    vault: Option<HashSet<u32>>,
    indexed: Option<HashSet<u32>>,
    local_only: bool,
    identity: Option<String>,
}

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

/// The account's ORIGINAL lifetime stamp and origin hash as they are now.
fn origin_of(state: &Arc<DaemonState>, accounts: &[Value], id: &str) -> Option<(AccountStamp, String)> {
    let row = accounts.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id))?;
    let config = crate::credentials::config_from_record(row).ok()?;
    let stamp = state.account_lifecycle.capture(id).ok()?;
    Some((stamp, mailvault_core::bulk_worker::origin_hash(&config)))
}

async fn read_focused(state: &Arc<DaemonState>, scoped: &Scoped, index_only: bool, all_cached: bool) -> Read {
    let state = Arc::clone(state);
    let scoped = scoped.clone();
    crate::handlers::common::blocking(move || {
        let (account, mailbox) = (scoped.account_id.as_str(), scoped.mailbox.as_str());
        let uids: Vec<u32> = scoped.rows.iter().map(|row| row.uid).collect();
        let cache = crate::custody::with_conn(&state, |conn| {
            let rows = if all_cached {
                // A background account has no list on screen: its whole cached INBOX is the list.
                let text = mailvault_core::custody::cache::load_headers(conn, account, mailbox, None,
                    mailvault_core::custody::cache::HeaderOrder::Arrival)?;
                text.and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|value| value.get("emails").and_then(Value::as_array).cloned()).unwrap_or_default()
            } else {
                mailvault_core::custody::cache::load_by_uids(conn, account, mailbox, &uids)?
            };
            let total = mailvault_core::custody::cache::uid_set(conn, account, mailbox)?.len();
            let identity = mailvault_core::custody::cache::native_identity(conn, account, mailbox)?
                .and_then(|identity| serde_json::to_string(&identity).ok());
            Ok((rows, total, identity))
        });
        let (found, cache_total, identity) = match cache {
            Ok((rows, total, identity)) => (rows, Some(total), identity),
            Err(_) => (Vec::new(), None, None),
        };
        let by_uid: HashMap<u32, &Value> = found.iter()
            .filter_map(|row| Some((u32::try_from(row.get("uid")?.as_u64()?).ok()?, row))).collect();
        // The rows are hints: only a uid the cache holds is work, and its date is the cache's.
        let cached = if all_cached {
            found.iter().filter_map(|row| Some(Observation { account_id: account.to_owned(), mailbox: mailbox.to_owned(),
                uid: u32::try_from(row.get("uid")?.as_u64()?).ok()?, date: row.get("date").cloned(),
                internal_date: row.get("internalDate").cloned() })).collect()
        } else {
            scoped.rows.iter().filter_map(|hint| {
                let row = by_uid.get(&hint.uid)?;
                Some(Observation { account_id: hint.account_id.clone(), mailbox: hint.mailbox.clone(), uid: hint.uid,
                    date: row.get("date").cloned(), internal_date: row.get("internalDate").cloned() })
            }).collect()
        };
        let stamp = state.account_lifecycle.capture(account);
        let vault = crate::handlers::vault_files::registry_read(&state, stamp, account, mailbox, |root| {
            state.vault_registry.uid_sets(root, account, mailbox)
        }).map(|(saved, _)| saved.into_iter().collect::<HashSet<u32>>());
        let indexed = if index_only {
            crate::search_index::body_indexed_uids(&state.search_index, account, mailbox).ok()
        } else { None };
        let local_only = crate::handlers::common::vault_root(&state).ok().is_some_and(|root| {
            let dir = mailvault_core::search_index::text::vault_dir_name(mailbox);
            let account_dir = mailvault_core::vault_files::account_dir(&root, account);
            mailvault_core::local_folder::read_marker(&account_dir, &dir).ok().flatten().is_some()
        });
        Read { cached, cache_total, vault, indexed, local_only, identity }
    }).await.unwrap_or(Read { cached: Vec::new(), cache_total: None, vault: None, indexed: None, local_only: false, identity: None })
}

/// The focused folder's entry, derived from what the native stores hold now.
async fn derive(state: &Arc<DaemonState>, settings: &Value, scoped: &Scoped, epoch: u64,
    origin_hash: &str, offline: bool, all_cached: bool) -> Entry {
    let policy = FetchPolicy::from_settings(settings, &scoped.account_id);
    let keep = policy.as_ref().map(|policy| policy.keep_bodies(now_ms()));
    let index_only = policy.as_ref().is_some_and(|policy| policy.mode == FetchMode::IndexOnly);
    let read = read_focused(state, scoped, index_only, all_cached).await;
    let mut entry = Entry { role: Role::Active, mailbox: scoped.mailbox.clone(), phase: "idle", queued: 0,
        completed: 0, total: 0, failed: 0, paused: None, epoch, origin_hash: origin_hash.to_owned(), runnable: Vec::new(),
        identity: read.identity.clone() };
    if read.local_only {
        // A folder only this computer holds is never provider work.
        entry.paused = Some("localOnly");
    } else if read.cache_total.is_none() {
        entry.paused = Some("cacheUnknown");
    } else if read.cache_total == Some(0) {
        // Nothing cached yet: headers come first, then the candidates are derived again.
        entry.phase = "headers";
    } else if let Some(saved) = read.vault.as_ref() {
        let kept = pipeline::kept_uids(index_only, saved, read.indexed.as_ref());
        let mut seen = HashSet::new();
        entry.runnable = pipeline::uncached_uids(&read.cached, &kept, keep).into_iter()
            .filter(|uid| seen.insert(*uid)).collect();
        entry.total = entry.runnable.len();
        entry.queued = entry.total;
        entry.phase = if entry.total == 0 { "done" } else { "content" };
    } else {
        // An unreadable vault is unknown, not empty: nothing is queued and the account stays retryable.
        entry.paused = Some("vaultUnknown");
    }
    // A blocking fact about the account (an unreadable vault, a local-only folder) is
    // the better reason to show than the transient offline pause.
    if offline && entry.paused.is_none() { entry.paused = Some("offline"); }
    entry
}

/// The account's own Sent folder from its cached folder list, when one is cached.
async fn sent_path(state: &Arc<DaemonState>, accounts: &[Value], id: &str) -> Option<String> {
    let state = Arc::clone(state);
    let override_path = accounts.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|row| row.get("sentFolderOverride")).and_then(Value::as_str).map(str::to_owned);
    let id = id.to_owned();
    crate::handlers::common::blocking(move || {
        let raw = crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::load_mailboxes(conn, &id)).ok()??;
        let entry: Value = serde_json::from_str(&raw).ok()?;
        let list = mailvault_core::cleanup_rules::cached_mailboxes(&entry)?;
        pipeline::find_sent_mailbox_path(&list, override_path.as_deref())
    }).await.ok().flatten()
}

async fn cache_is_empty(state: &Arc<DaemonState>, id: &str, mailbox: &str) -> bool {
    let state = Arc::clone(state);
    let (id, mailbox) = (id.to_owned(), mailbox.to_owned());
    crate::handlers::common::blocking(move || {
        crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::uid_set(conn, &id, &mailbox))
            .map_or(false, |uids| uids.is_empty())
    }).await.unwrap_or(false)
}

/// One header warm through the S2 refresh worker: admitted as a scheduled
/// refresh of exactly this account and folder, then waited out. The refresh
/// worker owns the provider call, the cache write and the lifecycle checks.
async fn warm_once(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> bool {
    let this = &state.hoarder_worker.pipeline;
    let request_id = {
        let mut inner = this.lock();
        inner.request_seq += 1;
        format!("pipeline-{}-{}", state.refresh.instance_id(), inner.request_seq)
    };
    #[cfg(test)]
    this.admissions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let intent = Intent { request_id: request_id.clone(), account_id: Some(account_id.to_owned()),
        mailbox: Some(mailbox.to_owned()), reason: Reason::Scheduled };
    match tokio::time::timeout(Duration::from_secs(30), RefreshState::admit(state, intent)).await {
        Ok(Ok(_)) => {}
        _ => return false,
    }
    for _ in 0..1_200 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let answer = state.refresh.status(Some(&request_id));
        match answer["receipts"][0]["status"].as_str() {
            Some("complete") => return true,
            Some("failed") => return false,
            _ => {}
        }
    }
    false
}

/// Warm `mailbox` once per account lifetime, again only when its cache was emptied.
async fn warm_folder(state: &Arc<DaemonState>, generation: u64, account_id: &str, mailbox: &str,
    epoch: u64, origin_hash: &str) -> Option<bool> {
    let this = &state.hoarder_worker.pipeline;
    let key = WarmKey { account_id: account_id.to_owned(), mailbox: mailbox.to_owned(), epoch,
        origin_hash: origin_hash.to_owned() };
    let emptied = cache_is_empty(state, account_id, mailbox).await;
    {
        let mut inner = this.lock();
        if inner.generation != generation || inner.offline { return None; }
        if emptied { inner.warmed.remove(&key); }
        if !inner.warmed.insert(key) { return None; }
        inner.in_flight += 1;
    }
    let ok = warm_once(state, account_id, mailbox).await;
    this.lock().in_flight -= 1;
    Some(ok)
}

/// One account's header warms: its folder, then its own Sent folder.
async fn warm_account(state: Arc<DaemonState>, generation: u64, accounts: Arc<Vec<Value>>, id: String,
    first: String, epoch: u64, origin_hash: String) {
    let this = &state.hoarder_worker.pipeline;
    let mut failed = 0;
    let mut warmed_any = false;
    for step in 0..2 {
        let mailbox = if step == 0 { Some(first.clone()) } else { sent_path(&state, &accounts, &id).await };
        let Some(mailbox) = mailbox else { continue };
        if step == 1 && mailbox == first { continue; }
        match warm_folder(&state, generation, &id, &mailbox, epoch, &origin_hash).await {
            Some(true) => warmed_any = true,
            Some(false) => { failed += 1; warmed_any = true; }
            None => {}
        }
    }
    // A folder warmed earlier in this account's lifetime counts as settled: the
    // cascade only waits for warms that are still in flight.
    let _ = warmed_any;
    {
        let mut inner = this.lock();
        if inner.generation != generation { return; }
        if let Some(entry) = inner.entries.get_mut(&id) {
            entry.failed += failed;
            if entry.role == Role::Background { entry.phase = "done"; }
        }
    }
    this.emit(&state, &id);
}

/// Background accounts warm in chunks: a chunk's accounts run together and the
/// next chunk is admitted only when the whole chunk settled and the focus that
/// asked for it is still the current one.
async fn run_chunks<F, Fut>(chunks: Vec<Vec<String>>, current: impl Fn() -> bool, mut run: F)
where F: FnMut(String) -> Fut, Fut: std::future::Future<Output = ()> + Send + 'static {
    for chunk in chunks {
        if !current() { return; }
        let tasks: Vec<_> = chunk.into_iter().map(|id| tokio::spawn(run(id))).collect();
        for task in tasks { let _ = task.await; }
    }
}

/// The pass to queue for a derived entry: only when the cache, the vault and the
/// policy could be judged. Zero candidates still queue one, which settles at once,
/// runs the attachment prefetch and hands the cascade on.
fn submission(scoped: &Scoped, stamp: &AccountStamp, origin_hash: &str, entry: &Entry) -> Option<Spec> {
    (matches!(entry.phase, "content" | "done") && entry.paused.is_none()).then(|| Spec {
        account_id: scoped.account_id.clone(), mailbox: scoped.mailbox.clone(), stamp: stamp.clone(),
        origin_hash: origin_hash.to_owned(), identity: entry.identity.clone(), uids: entry.runnable.clone() })
}

/// A background account's INBOX pass, derived when its turn comes: from the
/// whole cached INBOX (it has no list on screen) after its headers were warmed,
/// under the account lifetime the focus recorded. `None`: not ready, or the
/// account changed, or the vault could not be judged; the runner looks again later.
pub(crate) async fn derive_cascade(state: &Arc<DaemonState>, origin: &Origin) -> Option<Spec> {
    let this = &state.hoarder_worker.pipeline;
    if this.offline() || !this.headers_ready(&origin.account_id) { return None; }
    let (listing, settings) = crate::refresh_worker::authoritative_snapshot(state).await.ok()?;
    let authoritative = mailvault_core::accounts_doc::authoritative_ids(&listing.accounts);
    let visible = mailvault_core::refresh_policy::visible_account_ids(&listing.accounts, &authoritative, &settings);
    if !visible.iter().any(|id| *id == origin.account_id) { return None; }
    let (stamp, hash) = origin_of(state, &listing.accounts, &origin.account_id)?;
    if stamp.epoch() != origin.stamp.epoch() || hash != origin.origin_hash { return None; }
    let scoped = Scoped { account_id: origin.account_id.clone(), mailbox: "INBOX".to_owned(), rows: Vec::new() };
    let entry = derive(state, &settings, &scoped, stamp.epoch(), &hash, false, true).await;
    let spec = submission(&scoped, &origin.stamp, &hash, &entry)?;
    this.report(state, &origin.account_id, stamp.epoch(), &hash, Progress { phase: "content", queued: spec.uids.len(),
        completed: 0, total: spec.uids.len(), failed: 0, paused: None });
    Some(spec)
}

/// One planning pass for one accepted focus.
async fn plan(state: Arc<DaemonState>, generation: u64, focus: Focus) {
    let this = &state.hoarder_worker.pipeline;
    let finish = |state: &Arc<DaemonState>| {
        let mut inner = state.hoarder_worker.pipeline.lock();
        if inner.generation == generation { inner.planned = generation; }
    };
    let Ok((listing, settings)) = crate::refresh_worker::authoritative_snapshot(&state).await else {
        finish(&state);
        return;
    };
    let authoritative = mailvault_core::accounts_doc::authoritative_ids(&listing.accounts);
    let visible = mailvault_core::refresh_policy::visible_account_ids(&listing.accounts, &authoritative, &settings);
    let offline = this.lock().offline;
    let focused = visible.iter().any(|id| *id == focus.account_id)
        .then(|| origin_of(&state, &listing.accounts, &focus.account_id)).flatten();
    let (Some((stamp, origin_hash)), Ok(scoped)) = (focused, pipeline::scope_focus(&focus)) else {
        // A focus on an account that is gone, hidden or unreadable leaves no work behind.
        this.lock().entries.retain(|id, _| *id != focus.account_id);
        finish(&state);
        return;
    };
    let epoch = stamp.epoch();
    let entry = derive(&state, &settings, &scoped, epoch, &origin_hash, offline, false).await;
    let spec = submission(&scoped, &stamp, &origin_hash, &entry);
    {
        let mut inner = this.lock();
        if inner.generation != generation { return; }
        inner.entries.insert(scoped.account_id.clone(), entry);
    }
    this.emit(&state, &scoped.account_id);
    // Bodies follow the candidates natively; a focus that cannot be judged queues nothing.
    if let Some(spec) = spec { state.hoarder_worker.ordinary.submit_active(&state, generation, spec); }
    if !offline {
        let accounts = Arc::new(listing.accounts.clone());
        // Background accounts: their own entries, then headers in chunks of three.
        let mut background = Vec::new();
        for id in visible.iter().filter(|id| **id != scoped.account_id) {
            let Some((stamp, hash)) = origin_of(&state, &accounts, id) else { continue };
            let epoch = stamp.epoch();
            {
                let mut inner = this.lock();
                if inner.generation != generation { return; }
                inner.entries.insert(id.clone(), Entry { role: Role::Background, mailbox: "INBOX".into(),
                    phase: "headers", queued: 0, completed: 0, total: 0, failed: 0, paused: None, epoch,
                    origin_hash: hash.clone(), runnable: Vec::new(), identity: None });
            }
            this.emit(&state, id);
            background.push((id.clone(), stamp, hash));
        }
        let ids: Vec<String> = background.iter().map(|(id, _, _)| id.clone()).collect();
        let chunks = pipeline::header_chunks(&ids, pipeline::BACKGROUND_HEADER_CHUNK);
        // The content cascade walks these one at a time once the focused pass settles.
        state.hoarder_worker.ordinary.set_cascade(generation, background.iter().map(|(id, stamp, hash)|
            Origin { account_id: id.clone(), stamp: stamp.clone(), origin_hash: hash.clone() }).collect());
        let origins: HashMap<String, (u64, String)> = background.into_iter().map(|(id, s, h)| (id, (s.epoch(), h))).collect();
        let active = {
            let (state, accounts, id, mailbox, hash) = (Arc::clone(&state), Arc::clone(&accounts),
                scoped.account_id.clone(), scoped.mailbox.clone(), origin_hash.clone());
            tokio::spawn(async move { warm_account(state, generation, accounts, id, mailbox, epoch, hash).await })
        };
        let runner = {
            let (state, accounts) = (Arc::clone(&state), Arc::clone(&accounts));
            let watcher = Arc::clone(&state);
            run_chunks(chunks, move || watcher.hoarder_worker.pipeline.current(generation), move |id| {
                let (e, h) = origins.get(&id).cloned().unwrap_or_default();
                let (state, accounts) = (Arc::clone(&state), Arc::clone(&accounts));
                warm_account(state, generation, accounts, id, "INBOX".to_owned(), e, h)
            })
        };
        let _ = tokio::join!(runner, active);
        // A focused folder that had no cached rows is derived again now that headers landed.
        let rederive = this.lock().entries.get(&scoped.account_id).is_some_and(|entry| entry.phase == "headers");
        if rederive && this.current(generation) {
            let entry = derive(&state, &settings, &scoped, epoch, &origin_hash, false, false).await;
            let spec = submission(&scoped, &stamp, &origin_hash, &entry);
            let mut inner = this.lock();
            if inner.generation == generation { inner.entries.insert(scoped.account_id.clone(), entry); }
            drop(inner);
            this.emit(&state, &scoped.account_id);
            if let Some(spec) = spec { state.hoarder_worker.ordinary.submit_active(&state, generation, spec); }
        }
    }
    finish(&state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[tokio::test]
    async fn s5_background_headers_run_in_chunks_of_three_and_stop_when_the_focus_moves() {
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let ids: Vec<String> = ["a1", "a2", "a3", "a4", "a5"].iter().map(|s| s.to_string()).collect();
        let chunks = pipeline::header_chunks(&ids, pipeline::BACKGROUND_HEADER_CHUNK);
        let (log2, live2, peak2) = (Arc::clone(&log), Arc::clone(&live), Arc::clone(&peak));
        run_chunks(chunks, || true, move |id| {
            let (log, live, peak) = (Arc::clone(&log2), Arc::clone(&live2), Arc::clone(&peak2));
            async move {
                log.lock().unwrap().push(format!("start {id}"));
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                live.fetch_sub(1, Ordering::SeqCst);
                log.lock().unwrap().push(format!("done {id}"));
            }
        }).await;
        assert_eq!(peak.load(Ordering::SeqCst), 3, "three accounts at a time, never more");
        let log = log.lock().unwrap().clone();
        let position = |entry: &str| log.iter().position(|line| line == entry).unwrap();
        for first in ["a1", "a2", "a3"] {
            for second in ["a4", "a5"] {
                assert!(position(&format!("done {first}")) < position(&format!("start {second}")),
                    "{second} waits for the whole first chunk: {log:?}");
            }
        }

        // A newer focus pauses ordinary background admission: the next chunk is never admitted.
        let moved = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicUsize::new(0));
        let (moved2, started2) = (Arc::clone(&moved), Arc::clone(&started));
        let chunks = pipeline::header_chunks(&ids, 3);
        run_chunks(chunks, { let moved = Arc::clone(&moved); move || !moved.load(Ordering::SeqCst) }, move |_id| {
            let (moved, started) = (Arc::clone(&moved2), Arc::clone(&started2));
            async move { started.fetch_add(1, Ordering::SeqCst); moved.store(true, Ordering::SeqCst); }
        }).await;
        assert_eq!(started.load(Ordering::SeqCst), 3, "the running chunk finishes, the next one is never admitted");
    }
}
