//! Moving a folder (with every folder under it) in one account or to another,
//! as a daemon job. The pure half (what goes where, whether the copies are
//! trusted, the journal) is `mailvault_core::folder_move`; this is the I/O.
//!
//! - **Move = copy, verify, retire.** Every message of every folder is copied
//!   with the migration's copy engine (`migration::copy_one`), deduped by
//!   Message-ID against the destination, by content for mail without one.
//!   The destination is listed again after the copy and judged
//!   (`folder_move::verify`); a failed listing is an error, never an empty
//!   set. Just before the retire every source folder is listed again and
//!   mail that arrived meanwhile goes through copy and verify (two rounds at
//!   most). Only when every folder is verified, nothing failed and nothing
//!   was cancelled is the source retired: one rename of its root under Trash
//!   (IMAP, JMAP, with the vault's folders renamed to follow) or Graph's move
//!   to Deleted Items. Anything else keeps the source untouched and ends the
//!   job `partial` with a `sourceKeptReason`.
//! - **Same account, free destination:** one native rename (IMAP RENAME, JMAP
//!   reparent, Graph folder move) instead of a copy; a refused rename falls
//!   back to the copy.
//! - **Worker.** Every job runs on the `folder-move` OS thread, at background
//!   QoS, on a runtime of its own that lives as long as the daemon (pooled
//!   IMAP sessions it opens stay usable), on the pool's background lane, and
//!   waits for the user to go quiet before each message
//!   (`search_index::wait_foreground_quiet`). RPCs never wait on it.
//! - **Control.** Pause, cancel and discard take effect between messages. A
//!   pause holds the job, its journal checkpointed; a cancel ends it and keeps
//!   the journal; a discard ends it and deletes the journal (never mail).
//!   One job per account, as source or destination.
//! - **Journal** `<app data>/folder_moves/<jobId>.json`, atomic: the plan, each
//!   folder's phase and counts and the keys of the messages done. A resumed
//!   job skips verified folders and, within a folder, mail the destination
//!   lists (Message-ID) or the journal names (content fingerprint). A daemon
//!   restart leaves it `stopped`; it never resumes unasked.
//! - **Progress** is the `folder-move-progress` event, at most one per
//!   `progress_every` plus every change of state; the last has `active: false`.
//!
//! Logs carry counts and ids: never message text, folder names or credentials.

use crate::account_lifecycle::{AccountStamp, OperationPermit};
use crate::handlers::common::blocking;
use crate::migration::{self, CopyCtx, CopyOutcome, FolderMapping, Lane, Side, SourceItem, WriteAck};
use crate::server::DaemonState;
use mailvault_core::folder_move::{self as fm, FolderPhase, Journal, JournalFolder, Kind, Outcome, Record, Target};
use mailvault_core::imap::{self, ImapConfig, MailboxInfo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tracing::{info, warn};

/// A job for one of the two accounts is already running or held here; the
/// text after the prefix is that job's id.
pub const E_FOLDER_MOVE_RUNNING: &str = "E_FOLDER_MOVE_RUNNING";
/// No job and no journal with this id.
pub const E_FOLDER_MOVE_NOT_FOUND: &str = "E_FOLDER_MOVE_NOT_FOUND";
/// The source folder is gone (a resumed job whose root is no longer listed).
pub const E_FOLDER_MOVE_SOURCE_MISSING: &str = "E_FOLDER_MOVE_SOURCE_MISSING";
/// An account's credentials could not be read.
pub const E_FOLDER_MOVE_SIGN_IN: &str = "E_FOLDER_MOVE_SIGN_IN";

const EVENT: &str = "folder-move-progress";
const JOURNAL_DIR: &str = "folder_moves";

const RUNNING: &str = "running";
const PAUSED: &str = "paused";
const VERIFYING: &str = "verifying";
const RETIRING: &str = "retiring";
const DONE: &str = "done";
const PARTIAL: &str = "partial";
const CANCELLED: &str = "cancelled";
const FAILED: &str = "failed";
const STOPPED: &str = "stopped";
const DISCARDED: &str = "discarded";

/// Why the source was kept (`sourceKeptReason`).
const KEPT_UNVERIFIED: &str = "unverified";
const KEPT_FAILED: &str = "failed";
const KEPT_NO_TRASH: &str = "no_trash";
const KEPT_RENAME_FAILED: &str = "rename_failed";
const KEPT_CANCELLED: &str = "cancelled";

/// Listings of the source just before the retire: the first and one more
/// may bring new mail to copy; new mail on a third keeps the source.
const RELIST_ROUNDS: usize = 2;

#[derive(Debug, Clone)]
pub(crate) struct Tuning {
    /// At most one progress event per this long, changes of state aside.
    pub progress_every: Duration,
    /// The journal is written every this many messages, and on every change
    /// of phase or state.
    pub checkpoint_every: u32,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning { progress_every: Duration::from_millis(500), checkpoint_every: 25 }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ── the job and its registry ────────────────────────────────────────────────

/// A live job: running, or held by a pause.
pub(crate) struct Job {
    id: String,
    accounts: [String; 2],
    cancel: AtomicBool,
    pause: AtomicBool,
    discard: AtomicBool,
    notify: tokio::sync::Notify,
    /// Held with its journal checkpointed, or ended: what a quit waits for.
    settled: Mutex<bool>,
    settled_wake: Condvar,
    /// The worker sent its own last event.
    ended: AtomicBool,
    view: Mutex<Value>,
    #[cfg(test)]
    thread: Mutex<Option<String>>,
}

impl Job {
    fn new(id: &str, source: &str, dest: &str) -> Self {
        Job {
            id: id.to_string(),
            accounts: [source.to_string(), dest.to_string()],
            cancel: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            discard: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
            settled: Mutex::new(false),
            settled_wake: Condvar::new(),
            ended: AtomicBool::new(false),
            view: Mutex::new(Value::Null),
            #[cfg(test)]
            thread: Mutex::new(None),
        }
    }

    fn touches(&self, account: &str) -> bool {
        self.accounts.iter().any(|a| a == account)
    }

    fn wake(&self) {
        self.notify.notify_one();
    }

    fn set_settled(&self, settled: bool) {
        *lock(&self.settled) = settled;
        self.settled_wake.notify_all();
    }

    fn wait_settled(&self, until: Instant) -> bool {
        let mut settled = lock(&self.settled);
        while !*settled {
            let now = Instant::now();
            if now >= until {
                return false;
            }
            settled = self.settled_wake.wait_timeout(settled, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
        true
    }

    fn view(&self) -> Value {
        lock(&self.view).clone()
    }
}

type Task = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// The live jobs by id, and the `folder-move` thread they run on.
#[derive(Default)]
pub(crate) struct FolderMoves {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    worker: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Task>>>,
    #[cfg(test)]
    pub(crate) tuning: Mutex<Option<Tuning>>,
    /// Every job started, so a test can read a finished run.
    #[cfg(test)]
    ran: Mutex<Vec<Arc<Job>>>,
}

impl FolderMoves {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<Job>>> {
        lock(&self.jobs)
    }

    fn live(&self, job_id: &str) -> Option<Arc<Job>> {
        self.lock().get(job_id).cloned()
    }

    fn tuning(&self) -> Tuning {
        #[cfg(test)]
        if let Some(t) = lock(&self.tuning).clone() {
            return t;
        }
        Tuning::default()
    }

    /// Runs `task` on the `folder-move` thread, started on first use. Its
    /// runtime lives as long as this registry: a pooled IMAP session the job
    /// opened stays usable by the rest of the daemon.
    fn submit(&self, task: Task) -> Result<(), String> {
        let mut slot = lock(&self.worker);
        let task = match slot.as_ref() {
            Some(tx) => match tx.send(task) {
                Ok(()) => return Ok(()),
                Err(e) => e.0,
            },
            None => task,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .on_thread_start(crate::mbox_upload_job::background_qos)
            .build()
            .map_err(|e| format!("the folder move could not start: {e}"))?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Task>();
        std::thread::Builder::new()
            .name("folder-move".into())
            .spawn(move || {
                crate::mbox_upload_job::background_qos();
                rt.block_on(async move {
                    while let Some(task) = rx.recv().await {
                        tokio::spawn(task);
                    }
                });
            })
            .map_err(|e| format!("the folder move could not start: {e}"))?;
        tx.send(task).map_err(|_| "the folder move could not start".to_string())?;
        *slot = Some(tx);
        Ok(())
    }
}

/// Every live move asked to pause, then waited for until `limit` (one
/// deadline for all): the daemon is quitting, and a held job has its journal
/// checkpointed. Returns how many settled.
pub(crate) fn pause_all_and_wait(state: &DaemonState, limit: Duration) -> usize {
    let until = Instant::now() + limit;
    let live: Vec<Arc<Job>> = state.folder_moves.lock().values().cloned().collect();
    for job in &live {
        job.pause.store(true, Ordering::SeqCst);
        job.wake();
    }
    let settled = live.iter().filter(|job| job.wait_settled(until)).count();
    if !live.is_empty() {
        info!("[folder_move] quitting: {settled} of {} move(s) held at a checkpoint", live.len());
    }
    settled
}

/// Unregisters its job when the worker ends, however it ends. A worker that
/// never sent its last event (a panic) leaves one, `stopped` and inactive.
struct Registered(Arc<DaemonState>, Arc<Job>);

impl Drop for Registered {
    fn drop(&mut self) {
        let (state, job) = (&self.0, &self.1);
        unregister(state, job);
        if !job.ended.swap(true, Ordering::SeqCst) {
            warn!("[folder_move] job {} stopped unexpectedly; its journal stays resumable", job.id);
            let mut last = job.view();
            if last.is_object() {
                last["active"] = json!(false);
                last["state"] = json!(STOPPED);
                state.events.emit(EVENT, last);
            }
        }
        job.set_settled(true);
    }
}

fn unregister(state: &DaemonState, job: &Arc<Job>) {
    let mut jobs = state.folder_moves.lock();
    if jobs.get(&job.id).is_some_and(|j| Arc::ptr_eq(j, job)) {
        jobs.remove(&job.id);
    }
}

// ── the journal ─────────────────────────────────────────────────────────────

/// The core journal plus what the daemon keeps about the run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct JobFile {
    #[serde(flatten)]
    pub journal: Journal,
    /// The Graph folder ids the app gave (`_graphFolderId`).
    pub source_folder_id: Option<String>,
    pub dest_folder_id: Option<String>,
    /// The run's state as the event names it.
    pub state: String,
    pub source_kept_reason: Option<String>,
    pub error: Option<String>,
    pub retired_to: Option<String>,
    pub folders_created: u32,
    pub updated_at: u64,
}

/// A job id names files: only what `uuid` writes gets through.
pub(crate) fn is_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn journal_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(JOURNAL_DIR)
}

fn journal_path(app_dir: &Path, id: &str) -> PathBuf {
    journal_dir(app_dir).join(format!("{id}.json"))
}

fn write_journal(app_dir: &Path, file: &JobFile) -> Result<(), String> {
    std::fs::create_dir_all(journal_dir(app_dir)).map_err(|e| format!("Failed to create the folder move journal dir: {e}"))?;
    let bytes = serde_json::to_vec(file).map_err(|e| e.to_string())?;
    mailvault_core::fsx::write_atomic(&journal_path(app_dir, &file.journal.job_id), &bytes)
        .map_err(|e| format!("Failed to write the folder move journal: {e}"))
}

fn read_journal(app_dir: &Path, id: &str) -> Option<JobFile> {
    let raw = std::fs::read(journal_path(app_dir, id)).ok()?;
    serde_json::from_slice::<JobFile>(&raw).ok().filter(|f| f.journal.job_id == id)
}

fn list_journals(app_dir: &Path) -> Vec<JobFile> {
    std::fs::read_dir(journal_dir(app_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").filter(|id| is_job_id(id)).map(str::to_string))
        .filter_map(|id| read_journal(app_dir, &id))
        .collect()
}

fn remove_journal(app_dir: &Path, id: &str) {
    if let Err(e) = std::fs::remove_file(journal_path(app_dir, id)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!("[folder_move] job {id}: its journal was not removed: {e}");
        }
    }
}

// ── progress ────────────────────────────────────────────────────────────────

/// What the app renders, for a live job's events and status alike.
fn progress(f: &JobFile, active: bool, state: &str) -> Value {
    let j = &f.journal;
    let folders: Vec<Value> = j
        .plan
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let jf = j.folders.get(i).cloned().unwrap_or_default();
            json!({"src": item.src_path, "dest": item.dest_path, "phase": jf.phase, "total": jf.total,
                   "copied": jf.copied, "skipped": jf.skipped, "failed": jf.failed})
        })
        .collect();
    let sum = |pick: fn(&JournalFolder) -> u32| j.folders.iter().map(pick).sum::<u32>();
    json!({
        "jobId": j.job_id,
        "sourceAccountId": j.source_account_id,
        "destAccountId": j.dest_account_id,
        "sourcePath": j.root,
        "destPath": match &j.target { Target::Into(p) => json!(p), Target::TopLevel => Value::Null },
        "state": state,
        "active": active,
        "total": sum(|f| f.total),
        "copied": sum(|f| f.copied),
        "skipped": sum(|f| f.skipped),
        "failed": sum(|f| f.failed),
        "currentFolder": Value::Null,
        "folders": folders,
        "retired": f.retired_to.is_some(),
        "retiredTo": f.retired_to,
        "sourceKeptReason": f.source_kept_reason,
        "rateLimitedFor": Value::Null,
        "error": f.error,
        "foldersCreated": f.folders_created,
    })
}

// ── the accounts ────────────────────────────────────────────────────────────

/// The account's credentials, read by the worker itself: quietly, a
/// background job never raises the keychain's prompt.
#[cfg(not(test))]
async fn quiet_config(state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    crate::oauth_tokens::resolve(state, account_id, crate::oauth_tokens::Read::Quiet).await
}

#[cfg(test)]
async fn quiet_config(state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    crate::raw_message::account_config(state, account_id).await
}

fn side_of(config: ImapConfig) -> Side {
    let transport = if config.uses_graph() { "graph" } else { "imap" };
    Side::new(config, transport)
}

fn kind_of(side: &Side) -> Kind {
    match side.transport.as_str() {
        "jmap" => Kind::Jmap,
        "graph" => Kind::Graph,
        _ => Kind::Imap,
    }
}

fn graph_client(side: &Side) -> Result<mailvault_core::graph::GraphClient, String> {
    let token = side.config.access_token.as_deref().ok_or_else(|| format!("No access token for {}", side.email))?;
    Ok(mailvault_core::graph::GraphClient::new(token).for_account(&side.email))
}

/// An account's folders as listed now, and for Graph each folder's id by
/// path. A Graph folder is keyed by its storage key, as the app keys it; its
/// well-known name stands as its special use and its children as
/// `\HasChildren` (the listing is top-level only), so `plan` reserves a
/// localized Inbox and refuses a folder with subfolders.
async fn live_tree(state: &Arc<DaemonState>, side: &Side) -> Result<(Vec<MailboxInfo>, HashMap<String, String>), String> {
    match side.transport.as_str() {
        "jmap" => {
            let acct = state.jmap.get(&side.config).await.map_err(|e| e.to_string())?;
            Ok((acct.refresh().await.map_err(|e| e.to_string())?.infos, HashMap::new()))
        }
        "graph" => {
            let folders = graph_client(side)?.list_folders().await?;
            let ids = folders.iter().map(|f| (f.storage_key.clone(), f.id.clone())).collect();
            let boxes = folders
                .into_iter()
                .map(|f| MailboxInfo {
                    name: f.display_name.clone(),
                    path: f.storage_key.clone(),
                    special_use: f.well_known_name.clone(),
                    special_use_guessed: false,
                    flags: if f.child_folder_count > 0 { vec!["\\HasChildren".to_string()] } else { Vec::new() },
                    delimiter: Some("/".to_string()),
                    noselect: false,
                    children: Vec::new(),
                })
                .collect();
            Ok((boxes, ids))
        }
        _ => {
            let mut guard = state.imap_pool.get_background(&side.config).await?;
            match imap::list_mailboxes(&mut guard.session).await {
                Ok(boxes) => {
                    state.imap_pool.return_background(&side.config, guard).await;
                    Ok((boxes, HashMap::new()))
                }
                Err(e) => {
                    state.imap_pool.discard(&side.config, guard).await;
                    Err(e)
                }
            }
        }
    }
}

fn flatten(tree: &[MailboxInfo]) -> Vec<&MailboxInfo> {
    let mut out = Vec::new();
    for m in tree {
        out.push(m);
        out.extend(flatten(&m.children));
    }
    out
}

/// The root and every folder under it, by path.
fn subtree_paths(tree: &[MailboxInfo], root: &str, d: Option<&str>) -> Vec<String> {
    flatten(tree)
        .into_iter()
        .map(|m| m.path.clone())
        .filter(|p| p == root || d.is_some_and(|d| p.strip_prefix(root).is_some_and(|r| r.starts_with(d))))
        .collect()
}

/// A rename's vault pairs: the root and every folder under it, each to its
/// place under `to`, as the app's own rename sends them.
fn rename_pairs(tree: &[MailboxInfo], root: &str, to: &str, d: Option<&str>) -> Vec<mailvault_core::vault_flags::RenamePair> {
    subtree_paths(tree, root, d)
        .into_iter()
        .map(|p| mailvault_core::vault_flags::RenamePair { to: format!("{to}{}", &p[root.len()..]), from: p })
        .collect()
}

// ── the routes' side ────────────────────────────────────────────────────────

/// `folder_move.start` and `folder_move.plan`.
#[derive(Debug, Clone)]
pub(crate) struct Request {
    pub source_account_id: String,
    pub source_path: String,
    pub source_folder_id: Option<String>,
    pub dest_account_id: String,
    /// `None`: the top level.
    pub dest_path: Option<String>,
    pub dest_folder_id: Option<String>,
}

fn not_found(id: &str) -> String {
    format!("{E_FOLDER_MOVE_NOT_FOUND}: {id}")
}

/// An account's folder list as the app last cached it (no network), or
/// `None` when there is none.
fn cached_tree(state: &DaemonState, account: &str) -> Option<Vec<MailboxInfo>> {
    fn boxes_of(list: &Value) -> Vec<MailboxInfo> {
        list.as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let path = m["path"].as_str().filter(|p| !p.is_empty())?;
                Some(MailboxInfo {
                    name: m["name"].as_str().unwrap_or(path).to_string(),
                    path: path.to_string(),
                    special_use: m["specialUse"].as_str().map(str::to_string),
                    special_use_guessed: m["specialUseGuessed"].as_bool() == Some(true),
                    flags: m["flags"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(str::to_string)).collect(),
                    delimiter: m["delimiter"].as_str().map(str::to_string),
                    noselect: m["noselect"].as_bool() == Some(true),
                    children: boxes_of(&m["children"]),
                })
            })
            .collect()
    }
    let raw = crate::custody::with_conn(state, |c| mailvault_core::custody::cache::load_mailboxes(c, account)).ok()??;
    let listing: Value = serde_json::from_str(&raw).ok()?;
    let list = if listing.is_array() { &listing } else { &listing["mailboxes"] };
    Some(boxes_of(list)).filter(|b| !b.is_empty())
}

/// What an account speaks, from its row in the accounts document.
fn cached_kind(state: &DaemonState, account: &str) -> Kind {
    let rows = mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir)).map(|l| l.accounts).unwrap_or_default();
    let row = rows.iter().find(|r| r["id"].as_str() == Some(account)).cloned().unwrap_or(Value::Null);
    if row["jmapSessionUrl"].as_str().is_some_and(|u| !u.trim().is_empty()) {
        Kind::Jmap
    } else if row["oauth2Transport"].as_str() == Some("graph") {
        Kind::Graph
    } else {
        Kind::Imap
    }
}

/// `folder_move.plan`: what the move would create, from the cached folder
/// lists only. `refusal` is the code that stops it (the app disables
/// Confirm); a Graph folder's subfolders are known only to the live listing
/// the job makes.
pub(crate) fn plan_cached(state: &DaemonState, req: &Request) -> Value {
    let refusal = |code: &str| json!({"items": [], "fastRename": null, "refusal": code});
    if fm::is_reserved(&req.source_path, None, None) {
        return refusal(fm::PlanError::Reserved.code());
    }
    let same = req.source_account_id == req.dest_account_id;
    let (Some(src), Some(dst)) = (cached_tree(state, &req.source_account_id), cached_tree(state, &req.dest_account_id)) else {
        return refusal(fm::PlanError::NotFound.code());
    };
    let target = req.dest_path.clone().map_or(Target::TopLevel, Target::Into);
    let kinds = (cached_kind(state, &req.source_account_id), cached_kind(state, &req.dest_account_id));
    match fm::plan(&src, &req.source_path, &dst, &target, same, kinds.0, kinds.1) {
        Ok(plan) => json!({"items": plan.items, "fastRename": plan.fast_rename, "refusal": null}),
        Err(e) => refusal(e.code()),
    }
}

/// The stamps of the job's accounts (one for a same-account move) and the
/// permit that keeps both open until the job ends.
fn admit(state: &DaemonState, source: &str, dest: &str) -> Result<(Vec<AccountStamp>, OperationPermit), String> {
    let busy = |_| "errors.keychainBusy".to_owned();
    let mut stamps = vec![state.account_lifecycle.capture(source).map_err(busy)?];
    if dest != source {
        stamps.push(state.account_lifecycle.capture(dest).map_err(busy)?);
    }
    let owner = state.account_lifecycle.try_operation(&stamps).map_err(busy)?;
    Ok((stamps, owner))
}

/// Starts a move and answers at once: `{jobId}`. Both accounts must have
/// readable credentials and no job here; the worker lists both live and
/// plans again before anything is written.
pub(crate) async fn start(state: &Arc<DaemonState>, req: Request) -> Result<Value, String> {
    // The cached lists refuse what they can (a folder they do not hold is
    // left to the live listing); the worker plans again live.
    let (st, checked) = (Arc::clone(state), req.clone());
    let cached = blocking(move || plan_cached(&st, &checked)).await?;
    if let Some(code) = cached["refusal"].as_str().filter(|c| *c != fm::PlanError::NotFound.code()) {
        return Err(code.to_string());
    }
    let (stamps, owner) = admit(state, &req.source_account_id, &req.dest_account_id)?;
    for id in [&req.source_account_id, &req.dest_account_id] {
        crate::raw_message::account_config(state, id).await.map_err(|e| format!("{E_FOLDER_MOVE_SIGN_IN}: {e}"))?;
    }
    let st = Arc::clone(state);
    blocking(move || {
        let mut jobs = st.folder_moves.lock();
        if let Some(running) = jobs.values().find(|j| j.touches(&req.source_account_id) || j.touches(&req.dest_account_id)) {
            return Err(format!("{E_FOLDER_MOVE_RUNNING}: {}", running.id));
        }
        let file = JobFile {
            journal: Journal {
                job_id: uuid::Uuid::new_v4().to_string(),
                source_account_id: req.source_account_id,
                dest_account_id: req.dest_account_id,
                root: req.source_path,
                target: req.dest_path.map_or(Target::TopLevel, Target::Into),
                ..Default::default()
            },
            source_folder_id: req.source_folder_id,
            dest_folder_id: req.dest_folder_id,
            state: RUNNING.to_string(),
            updated_at: now_ms(),
            ..Default::default()
        };
        write_journal(&st.app_dir, &file)?;
        let id = file.journal.job_id.clone();
        if let Err(e) = spawn(&st, &mut jobs, file, stamps, owner) {
            remove_journal(&st.app_dir, &id);
            return Err(e);
        }
        Ok(json!({"jobId": id}))
    })
    .await
    .and_then(|r| r)
}

/// A held job here goes on; otherwise its journal starts a new worker that
/// skips what the journal says is done.
pub(crate) async fn resume(state: &Arc<DaemonState>, job_id: &str) -> Result<Value, String> {
    if let Some(job) = state.folder_moves.live(job_id) {
        job.pause.store(false, Ordering::SeqCst);
        job.wake();
        return Ok(json!({"jobId": job_id, "resumed": !job.ended.load(Ordering::SeqCst)}));
    }
    let (st, id) = (Arc::clone(state), job_id.to_string());
    let file = blocking(move || read_journal(&st.app_dir, &id).ok_or_else(|| not_found(&id))).await.and_then(|r| r)?;
    let (stamps, owner) = admit(state, &file.journal.source_account_id, &file.journal.dest_account_id)?;
    let st = Arc::clone(state);
    let id = job_id.to_string();
    blocking(move || {
        let mut jobs = st.folder_moves.lock();
        let mut file = read_journal(&st.app_dir, &id).ok_or_else(|| not_found(&id))?;
        let (src, dst) = (&file.journal.source_account_id, &file.journal.dest_account_id);
        if let Some(running) = jobs.values().find(|j| j.touches(src) || j.touches(dst)) {
            return Err(format!("{E_FOLDER_MOVE_RUNNING}: {}", running.id));
        }
        (file.state, file.error, file.source_kept_reason) = (RUNNING.to_string(), None, None);
        file.updated_at = now_ms();
        write_journal(&st.app_dir, &file)?;
        spawn(&st, &mut jobs, file, stamps, owner)?;
        Ok(json!({"jobId": id, "resumed": true}))
    })
    .await
    .and_then(|r| r)
}

/// Holds a running job at its next message.
pub(crate) fn pause(state: &DaemonState, id: &str) -> Result<Value, String> {
    if let Some(job) = state.folder_moves.live(id) {
        job.pause.store(true, Ordering::SeqCst);
        job.wake();
        return Ok(json!({"jobId": id, "paused": !job.ended.load(Ordering::SeqCst)}));
    }
    read_journal(&state.app_dir, id).map(|_| json!({"jobId": id, "paused": true})).ok_or_else(|| not_found(id))
}

/// Ends a job at its next message, keeping its journal for a resume or a
/// discard. The source is never touched by a cancel.
pub(crate) fn cancel(state: &DaemonState, id: &str) -> Result<Value, String> {
    if let Some(job) = state.folder_moves.live(id) {
        job.cancel.store(true, Ordering::SeqCst);
        job.wake();
        return Ok(json!({"jobId": id, "cancelled": !job.ended.load(Ordering::SeqCst)}));
    }
    let mut file = read_journal(&state.app_dir, id).ok_or_else(|| not_found(id))?;
    file.state = CANCELLED.to_string();
    file.updated_at = now_ms();
    write_journal(&state.app_dir, &file)?;
    Ok(json!({"jobId": id, "cancelled": true}))
}

/// Ends a job and deletes its journal. Mail already copied stays where it is.
pub(crate) fn discard(state: &DaemonState, id: &str) -> Result<Value, String> {
    if let Some(job) = state.folder_moves.live(id) {
        job.discard.store(true, Ordering::SeqCst);
        job.cancel.store(true, Ordering::SeqCst);
        job.wake();
        return Ok(json!({"jobId": id, "discarded": !job.ended.load(Ordering::SeqCst)}));
    }
    let file = read_journal(&state.app_dir, id).ok_or_else(|| not_found(id))?;
    remove_journal(&state.app_dir, id);
    state.events.emit(EVENT, progress(&file, false, DISCARDED));
    Ok(json!({"jobId": id, "discarded": true}))
}

/// `{jobs: [...]}`: every live job (`live: true`), then every journal with no
/// worker here, newest first. A journal left running or paused by a daemon
/// that stopped reads `stopped`.
pub(crate) fn status(state: &DaemonState) -> Value {
    let live: Vec<Arc<Job>> = state.folder_moves.lock().values().cloned().collect();
    let mut jobs: Vec<Value> = live
        .iter()
        .map(|job| {
            let mut v = job.view();
            v["live"] = json!(true);
            v
        })
        .collect();
    let mut rest: Vec<JobFile> = list_journals(&state.app_dir).into_iter().filter(|f| !live.iter().any(|l| l.id == f.journal.job_id)).collect();
    rest.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    jobs.extend(rest.iter().map(|f| {
        let shown = if matches!(f.state.as_str(), RUNNING | PAUSED | VERIFYING | RETIRING) { STOPPED } else { f.state.as_str() };
        let mut v = progress(f, false, shown);
        v["live"] = json!(false);
        v["updatedAt"] = json!(f.updated_at);
        v
    }));
    json!({ "jobs": jobs })
}

/// Registers the job and hands its worker to the `folder-move` thread.
/// `jobs` is the registry, locked by the caller.
fn spawn(
    state: &Arc<DaemonState>,
    jobs: &mut HashMap<String, Arc<Job>>,
    file: JobFile,
    stamps: Vec<AccountStamp>,
    owner: OperationPermit,
) -> Result<(), String> {
    let job = Arc::new(Job::new(&file.journal.job_id, &file.journal.source_account_id, &file.journal.dest_account_id));
    *lock(&job.view) = progress(&file, true, RUNNING);
    let runner = Runner {
        state: Arc::clone(state),
        job: Arc::clone(&job),
        tuning: state.folder_moves.tuning(),
        file,
        stamps,
        since_checkpoint: 0,
        emitted: None,
        current: None,
        rate_limited_for: None,
        touched: BTreeSet::new(),
        vault_incomplete: false,
    };
    let registered = Registered(Arc::clone(state), Arc::clone(&job));
    state.folder_moves.submit(Box::pin(async move {
        let _registered = registered;
        let _owner = owner;
        #[cfg(test)]
        {
            *lock(&runner.job.thread) = std::thread::current().name().map(str::to_string);
        }
        runner.run().await;
    }))?;
    #[cfg(test)]
    lock(&state.folder_moves.ran).push(Arc::clone(&job));
    jobs.insert(job.id.clone(), job);
    Ok(())
}

// ── the worker ──────────────────────────────────────────────────────────────

/// Why the copy stopped before the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Cancel,
    /// The provider's bandwidth limit: nothing more goes up today.
    Bandwidth,
}

/// One folder's copy in this run.
struct FolderRun {
    idx: usize,
    mapping: FolderMapping,
    /// The Graph id of the source folder.
    src_id: Option<String>,
    /// The destination's Message-IDs before the copy.
    dest_ids: HashSet<String>,
    records: Vec<Record>,
    /// Every source message this run handled: uid, or JMAP/Graph id.
    handled: HashSet<String>,
    /// A listing or a folder failed: nothing here can be verified.
    broken: bool,
}

fn identity(item: &SourceItem) -> String {
    item.remote_id.clone().unwrap_or_else(|| item.key.to_string())
}

fn mapping(src: &str, dest: &str) -> FolderMapping {
    FolderMapping {
        source_path: src.to_string(),
        dest_path: dest.to_string(),
        source_special_use: None,
        dest_folder_id: None,
        email_count: 0,
        status: "pending".to_string(),
        migrated: 0,
        skipped: 0,
        failed: 0,
        failed_uids: Vec::new(),
    }
}

/// Content fingerprints a journal folder says were done (mail without a
/// Message-ID): present, never written twice.
fn fingerprints_of(folder: Option<&JournalFolder>) -> HashSet<u64> {
    folder
        .into_iter()
        .flat_map(|f| f.done.iter())
        .filter(|k| !k.starts_with('<'))
        .filter_map(|k| u64::from_str_radix(k, 16).ok())
        .collect()
}

struct Runner {
    state: Arc<DaemonState>,
    job: Arc<Job>,
    tuning: Tuning,
    file: JobFile,
    stamps: Vec<AccountStamp>,
    since_checkpoint: u32,
    emitted: Option<Instant>,
    current: Option<String>,
    rate_limited_for: Option<u64>,
    /// Destination folders a message was written to.
    touched: BTreeSet<String>,
    vault_incomplete: bool,
}

/// How the run ended: its state, why the source was kept, an error code.
struct End {
    state: &'static str,
    kept: Option<&'static str>,
    error: Option<String>,
}

impl End {
    fn failed(error: String) -> Self {
        End { state: FAILED, kept: Some(KEPT_FAILED), error: Some(error) }
    }
    fn partial(kept: &'static str) -> Self {
        End { state: if kept == KEPT_CANCELLED { CANCELLED } else { PARTIAL }, kept: Some(kept), error: None }
    }
}

impl Runner {
    async fn run(mut self) {
        info!("[folder_move] job {} starting", self.job.id);
        self.emit(true, RUNNING);
        let end = self.work().await;
        self.finish(end).await;
    }

    fn cancelled(&self) -> bool {
        self.job.cancel.load(Ordering::SeqCst)
    }

    async fn work(&mut self) -> End {
        let (src_id, dst_id) = (self.file.journal.source_account_id.clone(), self.file.journal.dest_account_id.clone());
        let same = src_id == dst_id;
        let source = match quiet_config(&self.state, &src_id).await {
            Ok(c) => side_of(c),
            Err(_) => return End::failed(E_FOLDER_MOVE_SIGN_IN.to_string()),
        };
        let dest = if same {
            side_of(source.config.clone())
        } else {
            match quiet_config(&self.state, &dst_id).await {
                Ok(c) => side_of(c),
                Err(_) => return End::failed(E_FOLDER_MOVE_SIGN_IN.to_string()),
            }
        };
        let state = Arc::clone(&self.state);
        let (src_tree, src_ids) = match live_tree(&state, &source).await {
            Ok(t) => t,
            Err(e) => return End::failed(e),
        };
        let (dst_tree, dst_ids) = if same {
            (src_tree.clone(), src_ids.clone())
        } else {
            match live_tree(&state, &dest).await {
                Ok(t) => t,
                Err(e) => return End::failed(e),
            }
        };
        let root = self.file.journal.root.clone();
        let root_listed = flatten(&src_tree).iter().any(|m| m.path == root);

        if self.file.journal.plan.items.is_empty() {
            let planned = fm::plan(&src_tree, &root, &dst_tree, &self.file.journal.target, same, kind_of(&source), kind_of(&dest));
            match planned {
                Ok(plan) => {
                    self.file.journal.folders = vec![JournalFolder::default(); plan.items.len()];
                    self.file.journal.plan = plan;
                    self.checkpoint(RUNNING);
                }
                Err(e) => return End::failed(e.code().to_string()),
            }
        } else if !root_listed {
            // The journal of a run whose retire landed but whose last write
            // was lost: every folder verified and the root gone is a retire.
            let all_verified = self.file.journal.folders.iter().all(|f| matches!(f.phase, FolderPhase::Verified | FolderPhase::Retired));
            return if all_verified && !self.file.journal.folders.is_empty() {
                End { state: DONE, kept: None, error: None }
            } else {
                End::failed(E_FOLDER_MOVE_SOURCE_MISSING.to_string())
            };
        }

        let src_d = flatten(&src_tree).into_iter().find(|m| m.path == root).and_then(|m| m.delimiter.clone()).filter(|d| !d.is_empty());
        let src_folder_id = self.file.source_folder_id.clone().or_else(|| src_ids.get(&root).cloned());

        // Same account, free destination: one native rename.
        let untouched = self.file.journal.folders.iter().all(|f| f.phase == FolderPhase::Pending);
        if let (Some(to), true) = (self.file.journal.plan.fast_rename.clone(), untouched) {
            let parent_id = match &self.file.journal.target {
                Target::Into(p) => self.file.dest_folder_id.clone().or_else(|| dst_ids.get(p).cloned()),
                Target::TopLevel => Some("msgfolderroot".to_string()),
            };
            match self.native_rename(&source, &root, &to, src_folder_id.as_deref(), parent_id.as_deref()).await {
                Ok(()) => {
                    if source.transport != "graph" {
                        self.rename_vault(&source, &src_tree, &root, &to, src_d.as_deref()).await;
                    }
                    for f in &mut self.file.journal.folders {
                        f.phase = FolderPhase::Retired;
                    }
                    self.file.retired_to = None;
                    return End { state: DONE, kept: None, error: None };
                }
                Err(e) => warn!("[folder_move] job {}: the native rename was refused ({e}); copying instead", self.job.id),
            }
        }

        // Copy.
        let dest_paths: HashSet<String> = flatten(&dst_tree).into_iter().map(|m| m.path.clone()).collect();
        let job = Arc::clone(&self.job);
        let mut graph_cache: HashMap<String, String> = dst_ids.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut runs: Vec<FolderRun> = Vec::new();
        let mut stop = None;
        for idx in fm::resume_items(&self.file.journal) {
            if self.cancelled() {
                stop = Some(Stop::Cancel);
                break;
            }
            let item = self.file.journal.plan.items[idx].clone();
            let src_graph_id = if item.src_path == root { src_folder_id.clone() } else { src_ids.get(&item.src_path).cloned() };
            let fps = fingerprints_of(self.file.journal.folders.get(idx));
            let mut ctx = CopyCtx {
                state: &state,
                source: &source,
                dest: &dest,
                lane: Lane::Background,
                cancel: &job.cancel,
                pause: &job.pause,
                notify: &job.notify,
                graph_folder_cache: std::mem::take(&mut graph_cache),
                yield_to_ui: true,
                seen_fingerprints: Some(&fps),
            };
            let mut run = FolderRun {
                idx,
                mapping: mapping(&item.src_path, &item.dest_path),
                src_id: src_graph_id,
                dest_ids: HashSet::new(),
                records: Vec::new(),
                handled: HashSet::new(),
                broken: false,
            };
            self.current = Some(item.src_path.clone());
            self.set_phase(idx, FolderPhase::Copying, RUNNING);
            let made = migration::ensure_dest_folder(&mut ctx, &mut run.mapping).await;
            if made.is_ok() && !dest_paths.contains(&item.dest_path) {
                self.file.folders_created += 1;
            }
            let outcome = match made {
                Err(e) => {
                    warn!("[folder_move] job {}: a destination folder was not made: {e}", self.job.id);
                    run.broken = true;
                    None
                }
                Ok(()) if item.container => None,
                Ok(()) => self.copy_folder(&ctx, &mut run).await,
            };
            graph_cache = std::mem::take(&mut ctx.graph_folder_cache);
            runs.push(run);
            if outcome.is_some() {
                stop = outcome;
                break;
            }
        }
        self.current = None;
        match stop {
            Some(Stop::Cancel) => return End::partial(KEPT_CANCELLED),
            Some(Stop::Bandwidth) => return End::partial(KEPT_FAILED),
            None => {}
        }

        // Verify: the source listed again (mail that arrived meanwhile is
        // copied), then each destination folder listed again and judged.
        self.emit(true, VERIFYING);
        let mut late = false;
        for round in 0..=RELIST_ROUNDS {
            let mut found = false;
            for run in runs.iter_mut() {
                if run.broken || self.file.journal.plan.items[run.idx].container {
                    continue;
                }
                let fps = fingerprints_of(self.file.journal.folders.get(run.idx));
                let ctx = CopyCtx {
                    state: &state,
                    source: &source,
                    dest: &dest,
                    lane: Lane::Background,
                    cancel: &job.cancel,
                    pause: &job.pause,
                    notify: &job.notify,
                    graph_folder_cache: HashMap::new(),
                    yield_to_ui: true,
                    seen_fingerprints: Some(&fps),
                };
                let listed = match migration::list_source_items(&ctx, &run.mapping.source_path, run.src_id.as_deref()).await {
                    Ok(items) => items,
                    Err(e) => {
                        warn!("[folder_move] job {}: a source folder did not list again: {e}", self.job.id);
                        run.broken = true;
                        continue;
                    }
                };
                let new: Vec<SourceItem> = listed.into_iter().filter(|i| !run.handled.contains(&identity(i))).collect();
                if new.is_empty() {
                    continue;
                }
                found = true;
                if round == RELIST_ROUNDS {
                    continue;
                }
                info!("[folder_move] job {}: {} message(s) arrived during the move", self.job.id, new.len());
                self.file.journal.folders[run.idx].total += new.len() as u32;
                if let Some(stop) = self.copy_items(&ctx, run, &new).await {
                    return End::partial(if stop == Stop::Cancel { KEPT_CANCELLED } else { KEPT_FAILED });
                }
            }
            if !found {
                break;
            }
            late = round == RELIST_ROUNDS;
        }

        let mut verified = true;
        for run in &runs {
            if self.file.journal.plan.items[run.idx].container {
                if !run.broken {
                    self.set_phase(run.idx, FolderPhase::Verified, VERIFYING);
                }
                verified &= !run.broken;
                continue;
            }
            let ctx = CopyCtx {
                state: &state,
                source: &source,
                dest: &dest,
                lane: Lane::Background,
                cancel: &job.cancel,
                pause: &job.pause,
                notify: &job.notify,
                graph_folder_cache: HashMap::new(),
                yield_to_ui: true,
                seen_fingerprints: None,
            };
            let after = if run.broken { Err("the folder did not copy".to_string()) } else { migration::fetch_dest_ids(&ctx, &run.mapping).await };
            let verdict = fm::verify(&run.records, after.as_ref().map_err(String::as_str));
            let ok = verdict.retire_ok && !run.broken;
            self.set_phase(run.idx, if ok { FolderPhase::Verified } else { FolderPhase::Unverified }, VERIFYING);
            verified &= ok;
        }
        let failed: u32 = self.file.journal.folders.iter().map(|f| f.failed).sum();
        if self.cancelled() {
            return End::partial(KEPT_CANCELLED);
        }
        if failed > 0 || runs.iter().any(|r| r.broken) {
            return End::partial(KEPT_FAILED);
        }
        if !verified || late || self.file.journal.folders.iter().any(|f| f.phase != FolderPhase::Verified) {
            return End::partial(KEPT_UNVERIFIED);
        }

        // Retire.
        self.emit(true, RETIRING);
        let source = match quiet_config(&self.state, &src_id).await {
            Ok(c) => side_of(c),
            Err(_) => return End::partial(KEPT_RENAME_FAILED),
        };
        if let Err(kept) = self.retire(&source, &src_tree, &root, src_d.as_deref(), src_folder_id.as_deref()).await {
            return End::partial(kept);
        }
        for f in &mut self.file.journal.folders {
            f.phase = FolderPhase::Retired;
        }
        End { state: DONE, kept: None, error: None }
    }

    /// Copy folder `run`: list what the destination holds and what the
    /// source holds, then each message. `Some` when the job has to stop.
    async fn copy_folder(&mut self, ctx: &CopyCtx<'_>, run: &mut FolderRun) -> Option<Stop> {
        run.dest_ids = match migration::fetch_dest_ids(ctx, &run.mapping).await {
            Ok(ids) => ids,
            Err(e) => {
                warn!("[folder_move] job {}: a destination folder did not list: {e}", self.job.id);
                run.broken = true;
                return None;
            }
        };
        let items = match migration::list_source_items(ctx, &run.mapping.source_path, run.src_id.as_deref()).await {
            Ok(items) => items,
            Err(e) => {
                warn!("[folder_move] job {}: a source folder did not list: {e}", self.job.id);
                run.broken = true;
                return None;
            }
        };
        let f = &mut self.file.journal.folders[run.idx];
        (f.total, f.copied, f.skipped, f.failed) = (items.len() as u32, 0, 0, 0);
        self.emit(true, RUNNING);
        self.copy_items(ctx, run, &items).await
    }

    async fn copy_items(&mut self, ctx: &CopyCtx<'_>, run: &mut FolderRun, items: &[SourceItem]) -> Option<Stop> {
        for item in items {
            if !self.go_on().await {
                return Some(Stop::Cancel);
            }
            crate::search_index::wait_foreground_quiet(&self.state.search_index).await;
            let mut waited = None;
            let result = migration::copy_with_retries(
                ctx,
                &run.mapping.source_path,
                &run.mapping.dest_path,
                run.mapping.dest_folder_id.as_deref(),
                item,
                &run.dest_ids,
                &mut |secs| waited = Some(secs),
            )
            .await;
            self.rate_limited_for = None;
            if waited.is_some() && result.is_err() {
                self.rate_limited_for = waited;
            }
            let f = &mut self.file.journal.folders[run.idx];
            let (outcome, message_id, fingerprint) = match &result {
                Ok(CopyOutcome::Present { message_id, fingerprint, .. }) => {
                    f.skipped += 1;
                    (Outcome::Present, message_id.clone(), *fingerprint)
                }
                Ok(CopyOutcome::Written { ack, message_id, fingerprint, .. }) => {
                    f.copied += 1;
                    self.touched.insert(run.mapping.dest_path.clone());
                    (Outcome::Copied { acked: *ack != WriteAck::Unconfirmed }, message_id.clone(), *fingerprint)
                }
                Err(_) => {
                    f.failed += 1;
                    (Outcome::Failed, None, 0)
                }
            };
            // A key the journal can trust on resume: a Message-ID the
            // destination listing proves, or content the destination
            // acknowledged (or already held).
            let trusted = matches!(outcome, Outcome::Present | Outcome::Copied { acked: true }) || message_id.is_some();
            if trusted && outcome != Outcome::Failed && !(message_id.is_none() && fingerprint == 0) {
                f.done.push(fm::done_key(message_id.as_deref(), fingerprint));
            }
            run.records.push(Record { key: item.key, message_id, fingerprint, outcome });
            run.handled.insert(identity(item));
            self.since_checkpoint += 1;
            if self.since_checkpoint >= self.tuning.checkpoint_every {
                self.checkpoint(RUNNING);
            }
            self.emit(false, RUNNING);
            if let Err(e) = &result {
                warn!("[folder_move] job {}: a message did not copy", self.job.id);
                if imap::is_bandwidth_limited(e) {
                    warn!("[folder_move] job {}: provider bandwidth limit, stopping", self.job.id);
                    return Some(Stop::Bandwidth);
                }
            }
        }
        None
    }

    /// Between messages: go on, hold for a pause, or stop for a cancel.
    async fn go_on(&mut self) -> bool {
        if self.cancelled() {
            return false;
        }
        if !self.job.pause.load(Ordering::SeqCst) {
            return true;
        }
        self.checkpoint(PAUSED);
        self.emit(true, PAUSED);
        self.job.set_settled(true);
        info!("[folder_move] job {} held", self.job.id);
        let job = Arc::clone(&self.job);
        while job.pause.load(Ordering::SeqCst) && !job.cancel.load(Ordering::SeqCst) {
            tokio::select! {
                _ = job.notify.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
        job.set_settled(false);
        if self.cancelled() {
            return false;
        }
        self.checkpoint(RUNNING);
        self.emit(true, RUNNING);
        true
    }

    /// One rename on the server: IMAP RENAME, JMAP reparent, Graph move.
    async fn native_rename(&self, side: &Side, from: &str, to: &str, graph_id: Option<&str>, graph_parent: Option<&str>) -> Result<(), String> {
        match side.transport.as_str() {
            "graph" => {
                let id = graph_id.ok_or("No Graph folder id")?;
                graph_client(side)?.move_folder(id, graph_parent.ok_or("No Graph parent id")?).await
            }
            "jmap" => {
                let stamp = self.stamps.iter().find(|s| s.id() == self.file.journal.source_account_id).ok_or("errors.keychainBusy")?;
                crate::handlers::jmap_bridge::answer_for(&self.state, "imap_rename_mailbox", &json!({"from": from, "to": to}), &side.config, stamp)
                    .await
                    .map(|_| ())
            }
            _ => {
                let mut guard = self.state.imap_pool.get_background(&side.config).await?;
                let renamed = imap::rename_mailbox(&mut guard.session, from, to).await;
                guard.last_selected = None;
                match &renamed {
                    Ok(()) => self.state.imap_pool.return_background(&side.config, guard).await,
                    Err(_) => self.state.imap_pool.discard(&side.config, guard).await,
                }
                renamed
            }
        }
    }

    /// The vault's folders of a renamed subtree follow it, as the app's own
    /// rename moves them. A half-done rename is reported, never fatal: the
    /// server rename has landed.
    async fn rename_vault(&mut self, side: &Side, tree: &[MailboxInfo], root: &str, to: &str, d: Option<&str>) {
        let pairs = rename_pairs(tree, root, to, d);
        let (state, account, email) = (Arc::clone(&self.state), self.file.journal.source_account_id.clone(), side.email.clone());
        let renamed = blocking(move || {
            let (moved, result) = crate::handlers::vault_flags::rename_mailbox(&state, &account, Some(&email), None, pairs);
            if moved > 0 {
                crate::search_index::sweep_soon(&state.search_index);
            }
            result
        })
        .await
        .and_then(|r| r);
        if let Err(e) = renamed {
            warn!("[folder_move] job {}: the vault rename is incomplete: {e}", self.job.id);
            self.vault_incomplete = true;
        }
    }

    /// The source root goes under Trash (IMAP, JMAP: one rename, the vault
    /// following) or to Deleted Items (Graph). `Err` is why it was kept.
    async fn retire(&mut self, side: &Side, tree: &[MailboxInfo], root: &str, d: Option<&str>, graph_id: Option<&str>) -> Result<(), &'static str> {
        let flat = flatten(tree);
        if side.transport == "graph" {
            self.native_rename(side, root, root, graph_id, Some("deleteditems")).await.map_err(|e| {
                warn!("[folder_move] job {}: the source was not moved to Deleted Items: {e}", self.job.id);
                KEPT_RENAME_FAILED
            })?;
            self.file.retired_to =
                Some(flat.iter().find(|m| m.special_use.as_deref() == Some("deleteditems")).map_or("deleteditems".to_string(), |m| m.path.clone()));
            return Ok(());
        }
        let trash = flat.iter().find(|m| m.special_use.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("\\Trash"))).map(|m| m.path.clone());
        let (Some(trash), Some(d)) = (trash, d) else { return Err(KEPT_NO_TRASH) };
        let leaf = root.rsplit(d).next().unwrap_or(root);
        let existing: HashSet<String> = flat.iter().map(|m| m.path.clone()).collect();
        let to = fm::trash_target(&existing, &trash, leaf, d);
        self.native_rename(side, root, &to, None, None).await.map_err(|e| {
            warn!("[folder_move] job {}: the source was not renamed under Trash: {e}", self.job.id);
            KEPT_RENAME_FAILED
        })?;
        self.rename_vault(side, tree, root, &to, Some(d)).await;
        self.file.retired_to = Some(to);
        Ok(())
    }

    fn set_phase(&mut self, idx: usize, phase: FolderPhase, state: &str) {
        if let Some(f) = self.file.journal.folders.get_mut(idx) {
            f.phase = phase;
        }
        self.checkpoint(state);
        self.emit(true, state);
    }

    fn checkpoint(&mut self, state: &str) {
        self.file.state = state.to_string();
        self.file.updated_at = now_ms();
        if let Err(e) = write_journal(&self.state.app_dir, &self.file) {
            warn!("[folder_move] job {} not checkpointed: {e}", self.job.id);
        }
        self.since_checkpoint = 0;
    }

    fn emit(&mut self, force: bool, state: &str) {
        let mut payload = progress(&self.file, true, state);
        payload["currentFolder"] = json!(self.current);
        payload["rateLimitedFor"] = json!(self.rate_limited_for);
        *lock(&self.job.view) = payload.clone();
        if force || self.emitted.is_none_or(|at| at.elapsed() >= self.tuning.progress_every) {
            self.state.events.emit(EVENT, payload);
            self.emitted = Some(Instant::now());
        }
    }

    /// The end, however it came: the journal made durable (deleted when the
    /// move is done or discarded), the accounts refreshed, the job
    /// unregistered, then the last event.
    async fn finish(mut self, end: End) {
        let discard = self.job.discard.load(Ordering::SeqCst);
        self.file.source_kept_reason = end.kept.map(str::to_string);
        self.file.error = end.error;
        let state = if discard { DISCARDED } else { end.state };
        self.checkpoint(state);
        self.refresh().await;
        if discard || end.state == DONE {
            remove_journal(&self.state.app_dir, &self.job.id);
        }
        let f = &self.file;
        info!(
            "[folder_move] job {} {state}: copied={} skipped={} failed={} kept={:?}",
            self.job.id,
            f.journal.folders.iter().map(|f| f.copied).sum::<u32>(),
            f.journal.folders.iter().map(|f| f.skipped).sum::<u32>(),
            f.journal.folders.iter().map(|f| f.failed).sum::<u32>(),
            f.source_kept_reason
        );
        unregister(&self.state, &self.job);
        let mut last = progress(&self.file, false, state);
        if self.vault_incomplete {
            last["vaultRenameIncomplete"] = json!(true);
        }
        *lock(&self.job.view) = last.clone();
        self.job.ended.store(true, Ordering::SeqCst);
        self.state.events.emit(EVENT, last);
    }

    /// What the app shows, brought up to date. Nothing here fails the job: an
    /// IMAP destination's written folders synced (0 new: no banner), the
    /// cached folder lists marked out of date where folders were made or the
    /// source went, one index pass.
    async fn refresh(&mut self) {
        let (src, dst) = (self.file.journal.source_account_id.clone(), self.file.journal.dest_account_id.clone());
        if !self.touched.is_empty() {
            if let Ok(config) = quiet_config(&self.state, &dst).await {
                if !config.uses_jmap() && !config.uses_graph() {
                    let account = crate::sync_engine::SyncAccount { id: dst.clone(), email: config.email.clone(), imap_config: config };
                    for folder in &self.touched {
                        let result = self.state.sync_engine.sync_account(&account, folder).await;
                        if result.success {
                            self.state.sync_engine.note_change(&account.id, folder, 0, result.updated_flags);
                        }
                    }
                }
            }
        }
        let retired = self.file.journal.folders.iter().any(|f| f.phase == FolderPhase::Retired);
        let mut stale = Vec::new();
        if self.file.folders_created > 0 || (retired && src == dst) {
            stale.push(dst.clone());
        }
        if retired && src != dst {
            stale.push(src);
        }
        for account in stale {
            if let Err(e) = crate::mbox_upload_job::folder_list_stale(&self.state, &account) {
                warn!("[folder_move] {account}: the cached folder list was not marked out of date: {e}");
            }
        }
        if !self.touched.is_empty() || retired {
            crate::search_index::sweep_soon(&self.state.search_index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::RpcResponse;
    use crate::jmap_test_support as support;
    use crate::server::handle_request_for_test;
    use mock_imap::{Action, Mailbox, Message, MockImap, Scenario, Trigger};
    use tokio::sync::broadcast;

    fn fast() -> Tuning {
        Tuning { progress_every: Duration::ZERO, checkpoint_every: 2 }
    }

    fn raw(id: &str, subject: &str) -> String {
        format!("From: a@example.com\r\nMessage-ID: <{id}@x>\r\nSubject: {subject}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\n\r\nbody of {subject}\r\n")
    }

    /// A chat or a draft: no Message-ID.
    fn idless(subject: &str) -> String {
        format!("From: a@example.com\r\nSubject: {subject}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\n\r\nbody of {subject}\r\n")
    }

    fn folder(name: &str, messages: &[String]) -> Mailbox {
        let mut mb = Mailbox::new(name);
        for (i, m) in messages.iter().enumerate() {
            mb.add(Message::new(i as u32 + 1, m.clone()));
        }
        mb
    }

    /// INBOX, Trash (`\Trash`), and `Clients` (c1, c2) with `Clients/2025` (y1).
    fn source() -> Scenario {
        Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Clients", &[raw("c1", "one"), raw("c2", "two")]).with_attrs(&["\\HasChildren"]))
            .mailbox(folder("Clients/2025", &[raw("y1", "three")]))
    }

    fn dest() -> Scenario {
        Scenario::new().mailbox(folder("INBOX", &[])).mailbox(Mailbox::new("Archive"))
    }

    fn config(server: &MockImap, email: &str) -> ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(json!({"email": email, "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()})).unwrap()
    }

    struct Rig {
        src: MockImap,
        dst: MockImap,
        s: Arc<DaemonState>,
        rx: broadcast::Receiver<Arc<str>>,
        _vault: tempfile::TempDir,
        _app: tempfile::TempDir,
    }

    fn rig_with(src: Scenario, dst: Scenario, tuning: Tuning) -> Rig {
        let (src, dst) = (MockImap::start(src), MockImap::start(dst));
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let s = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), true);
        s.seed_accounts_for_test(&["src", "dst"]);
        s.raw_messages.accounts.lock().unwrap().insert("src".into(), config(&src, "src@example.com"));
        s.raw_messages.accounts.lock().unwrap().insert("dst".into(), config(&dst, "dst@example.com"));
        *lock(&s.folder_moves.tuning) = Some(tuning);
        let rx = s.events.subscribe();
        Rig { src, dst, s, rx, _vault: vault, _app: app }
    }

    fn rig(src: Scenario, dst: Scenario) -> Rig {
        rig_with(src, dst, fast())
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        handle_request_for_test(s, method, params).await
    }

    fn ok(resp: RpcResponse) -> Value {
        match (resp.result, resp.error) {
            (Some(v), None) => v,
            (_, e) => panic!("refused: {e:?}"),
        }
    }

    fn move_params(dest_account: &str, dest_path: Option<&str>) -> Value {
        json!({"sourceAccountId": "src", "sourcePath": "Clients", "destAccountId": dest_account, "destPath": dest_path})
    }

    async fn start(rig: &Rig, params: Value) -> String {
        let started = ok(call(&rig.s, "folder_move.start", params).await);
        started["jobId"].as_str().expect("a job id").to_string()
    }

    async fn control(rig: &Rig, method: &str, job: &str) -> Value {
        ok(call(&rig.s, method, json!({"jobId": job})).await)
    }

    /// The next progress event `want` accepts.
    async fn next(rx: &mut broadcast::Receiver<Arc<str>>, want: impl Fn(&Value) -> bool) -> Value {
        let wait = async {
            loop {
                match rx.recv().await {
                    Ok(line) => {
                        let v: Value = serde_json::from_str(&line).unwrap();
                        if v["params"]["name"] == EVENT && want(&v["params"]["payload"]) {
                            return v["params"]["payload"].clone();
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(e) => panic!("event bus: {e}"),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait).await.expect("the progress event never came")
    }

    /// Every progress event up to and including the job's last one.
    async fn until_done(rx: &mut broadcast::Receiver<Arc<str>>) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let e = next(rx, |_| true).await;
            let last = e["active"] == json!(false);
            seen.push(e);
            if last {
                return seen;
            }
        }
    }

    fn subjects(server: &MockImap, mailbox: &str) -> Vec<String> {
        let state = server.state();
        let Some(mb) = state.find(mailbox) else { return Vec::new() };
        mb.messages
            .iter()
            .map(|m| String::from_utf8_lossy(&m.raw).lines().find_map(|l| l.strip_prefix("Subject: ")).unwrap_or_default().to_string())
            .collect()
    }

    fn has(server: &MockImap, mailbox: &str) -> bool {
        server.state().find(mailbox).is_some()
    }

    async fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
        for _ in 0..3000 {
            if ready() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("never: {what}");
    }

    fn the_run(rig: &Rig, job: &str) -> Arc<Job> {
        lock(&rig.s.folder_moves.ran).iter().rev().find(|j| j.id == job).cloned().expect("a run")
    }

    /// The whole subtree lands under the picked parent, the source root goes
    /// under Trash with its subfolder (one RENAME), and the vault's folders
    /// follow it.
    #[tokio::test(flavor = "multi_thread")]
    async fn cross_account_imap_move_copies_subtree_then_renames_source_under_trash() {
        let mut rig = rig(source(), dest());
        let root = crate::handlers::common::vault_root(&rig.s).unwrap();
        let old_dir = mailvault_core::message_store::mailbox_dir(&root, "src", "Clients");
        std::fs::create_dir_all(old_dir.join("cur")).unwrap();

        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!(last["jobId"], json!(job));
        assert_eq!((last["state"].clone(), last["retiredTo"].clone(), last["sourceKeptReason"].clone()), (json!(DONE), json!("Trash/Clients"), Value::Null), "{last}");
        assert_eq!((last["copied"].clone(), last["failed"].clone(), last["foldersCreated"].clone()), (json!(3), json!(0), json!(2)));
        assert_eq!(subjects(&rig.dst, "Archive/Clients"), ["one", "two"]);
        assert_eq!(subjects(&rig.dst, "Archive/Clients/2025"), ["three"]);
        assert!(!has(&rig.src, "Clients") && !has(&rig.src, "Clients/2025"));
        assert_eq!(subjects(&rig.src, "Trash/Clients"), ["one", "two"], "the source is kept in Trash, whole");
        assert_eq!(subjects(&rig.src, "Trash/Clients/2025"), ["three"]);
        assert_eq!(rig.src.count_commands("RENAME"), 1);
        assert!(!old_dir.exists(), "the vault folder followed the rename");
        assert!(mailvault_core::message_store::mailbox_dir(&root, "src", "Trash/Clients").join("cur").exists());
        assert!(read_journal(&rig.s.app_dir, &job).is_none(), "a finished move keeps no journal");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_append_keeps_the_source_untouched() {
        let refused = Action::RefuseWith("NO".into(), "[CANNOT] refused".into());
        let mut rig = rig(source(), dest().fault(Trigger::with("APPEND", "Subject: two"), refused));
        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!((last["state"].clone(), last["sourceKeptReason"].clone(), last["retired"].clone()), (json!(PARTIAL), json!(KEPT_FAILED), json!(false)), "{last}");
        assert_eq!(subjects(&rig.src, "Clients"), ["one", "two"], "untouched");
        assert_eq!(rig.src.count_commands("RENAME"), 0);
        assert_eq!(read_journal(&rig.s.app_dir, &job).map(|f| f.state), Some(PARTIAL.to_string()), "kept for a re-run");
    }

    /// A message that lands in the source while the copy runs is copied
    /// before the source is retired.
    #[tokio::test(flavor = "multi_thread")]
    async fn mail_arriving_mid_run_is_copied_before_retire() {
        let mut rig = rig(source(), dest());
        let gate = rig.dst.pause_command("APPEND");
        start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)), "the first APPEND went out");
        rig.src.mutate(|st| {
            st.find_mut("Clients").unwrap().add(Message::new(9, raw("late", "late")));
        });
        drop(gate);
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!(last["state"], json!(DONE), "{last}");
        assert_eq!(subjects(&rig.dst, "Archive/Clients"), ["one", "two", "late"]);
        assert_eq!(subjects(&rig.src, "Trash/Clients"), ["one", "two", "late"]);
    }

    /// No APPENDUID and no Message-ID: nothing proves the copy landed.
    #[tokio::test(flavor = "multi_thread")]
    async fn unverifiable_without_uidplus_or_message_id_keeps_source() {
        let src = Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Clients", &[raw("c1", "one"), idless("chat")]));
        let mut rig = rig(src, dest().without_cap("UIDPLUS"));
        start(&rig, move_params("dst", None)).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!((last["state"].clone(), last["sourceKeptReason"].clone()), (json!(PARTIAL), json!(KEPT_UNVERIFIED)), "{last}");
        assert_eq!(subjects(&rig.dst, "Clients"), ["one", "chat"], "copied all the same");
        assert_eq!(subjects(&rig.src, "Clients"), ["one", "chat"]);
        assert_eq!(rig.src.count_commands("RENAME"), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_trash_keeps_source_and_reports_no_trash() {
        let src = Scenario::new().mailbox(folder("INBOX", &[])).mailbox(folder("Clients", &[raw("c1", "one")]));
        let mut rig = rig(src, dest());
        start(&rig, move_params("dst", Some("Archive"))).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!((last["state"].clone(), last["sourceKeptReason"].clone()), (json!(PARTIAL), json!(KEPT_NO_TRASH)), "{last}");
        assert_eq!(subjects(&rig.dst, "Archive/Clients"), ["one"]);
        assert_eq!(subjects(&rig.src, "Clients"), ["one"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_stops_at_next_message_and_keeps_journal() {
        let mut rig = rig(source(), dest());
        let gate = rig.dst.pause_command("APPEND");
        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)));
        assert_eq!(control(&rig, "folder_move.cancel", &job).await["cancelled"], json!(true));
        drop(gate);
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!((last["state"].clone(), last["sourceKeptReason"].clone()), (json!(CANCELLED), json!(KEPT_CANCELLED)), "{last}");
        assert_eq!(rig.dst.count_commands("APPEND"), 1, "nothing after the message in hand");
        assert_eq!(subjects(&rig.src, "Clients"), ["one", "two"]);
        let journal = read_journal(&rig.s.app_dir, &job).expect("kept");
        assert_eq!((journal.state.as_str(), journal.journal.folders[0].done.len()), (CANCELLED, 1));
        let listed = ok(call(&rig.s, "folder_move.status", json!({})).await);
        assert_eq!((listed["jobs"][0]["state"].clone(), listed["jobs"][0]["live"].clone()), (json!(CANCELLED), json!(false)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pause_then_resume_continues_the_same_job() {
        let mut rig = rig(source(), dest());
        let gate = rig.dst.pause_command("APPEND");
        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)));
        assert_eq!(control(&rig, "folder_move.pause", &job).await["paused"], json!(true));
        drop(gate);
        let held = next(&mut rig.rx, |e| e["state"] == json!(PAUSED)).await;
        assert_eq!((held["copied"].clone(), held["active"].clone()), (json!(1), json!(true)));
        assert_eq!(read_journal(&rig.s.app_dir, &job).unwrap().state, PAUSED);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rig.dst.count_commands("APPEND"), 1, "held");

        assert_eq!(control(&rig, "folder_move.resume", &job).await["resumed"], json!(true));
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["jobId"].clone(), last["state"].clone(), last["copied"].clone()), (json!(job), json!(DONE), json!(3)));
        assert_eq!(lock(&rig.s.folder_moves.ran).len(), 1, "the same worker went on");
    }

    /// A daemon that stopped mid-folder: its journal names the chat it copied
    /// (no Message-ID, so only its content fingerprint), and the resumed job
    /// does not write it again.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_after_restart_skips_done_messages_without_message_id() {
        let src = Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Clients", &[idless("chat one"), idless("chat two")]));
        let dst = dest().mailbox(folder("Archive/Clients", &[idless("chat one")]));
        let mut rig = rig(src, dst);
        let id = uuid::Uuid::new_v4().to_string();
        let file = JobFile {
            journal: Journal {
                job_id: id.clone(),
                source_account_id: "src".into(),
                dest_account_id: "dst".into(),
                root: "Clients".into(),
                target: Target::Into("Archive".into()),
                plan: fm::Plan { items: vec![fm::PlanItem { src_path: "Clients".into(), dest_path: "Archive/Clients".into(), container: false }], fast_rename: None },
                folders: vec![JournalFolder {
                    phase: FolderPhase::Copying,
                    copied: 1,
                    done: vec![fm::done_key(None, fm::fingerprint(idless("chat one").as_bytes()))],
                    ..Default::default()
                }],
            },
            state: RUNNING.into(),
            ..Default::default()
        };
        write_journal(&rig.s.app_dir, &file).unwrap();
        let listed = ok(call(&rig.s, "folder_move.status", json!({})).await);
        assert_eq!(listed["jobs"][0]["state"], json!(STOPPED), "a journal a dead daemon left running is stopped");

        assert_eq!(control(&rig, "folder_move.resume", &id).await["resumed"], json!(true));
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!(rig.dst.count_commands("APPEND"), 1, "only the chat not yet done");
        assert_eq!(subjects(&rig.dst, "Archive/Clients"), ["chat one", "chat two"]);
        assert_eq!(last["state"], json!(DONE), "{last}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn discard_removes_journal_and_never_deletes_copied_mail() {
        let mut rig = rig(source(), dest());
        let gate = rig.dst.pause_command("APPEND");
        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)));
        control(&rig, "folder_move.cancel", &job).await;
        drop(gate);
        until_done(&mut rig.rx).await;
        assert!(read_journal(&rig.s.app_dir, &job).is_some());

        assert_eq!(control(&rig, "folder_move.discard", &job).await["discarded"], json!(true));
        let gone = next(&mut rig.rx, |e| e["state"] == json!(DISCARDED)).await;
        assert_eq!(gone["active"], json!(false));
        assert!(read_journal(&rig.s.app_dir, &job).is_none());
        assert_eq!(ok(call(&rig.s, "folder_move.status", json!({})).await), json!({"jobs": []}));
        assert_eq!(subjects(&rig.dst, "Archive/Clients"), ["one"], "what was copied stays");
        assert_eq!(subjects(&rig.src, "Clients"), ["one", "two"]);
        assert!(call(&rig.s, "folder_move.resume", json!({"jobId": job})).await.error.unwrap().message.starts_with(E_FOLDER_MOVE_NOT_FOUND));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn same_account_top_level_move_is_one_rename_no_append() {
        let src = source().mailbox(Mailbox::new("Work"));
        let mut rig = rig(src, dest());
        let root = crate::handlers::common::vault_root(&rig.s).unwrap();
        std::fs::create_dir_all(mailvault_core::message_store::mailbox_dir(&root, "src", "Clients/2025").join("cur")).unwrap();
        start(&rig, json!({"sourceAccountId": "src", "sourcePath": "Clients", "destAccountId": "src", "destPath": "Work"})).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!(last["state"], json!(DONE), "{last}");
        assert_eq!((rig.src.count_commands("APPEND"), rig.src.count_commands("RENAME")), (0, 1));
        assert_eq!(subjects(&rig.src, "Work/Clients"), ["one", "two"]);
        assert_eq!(subjects(&rig.src, "Work/Clients/2025"), ["three"]);
        assert!(!has(&rig.src, "Clients"));
        assert!(mailvault_core::message_store::mailbox_dir(&root, "src", "Work/Clients/2025").join("cur").exists(), "the vault follows, subfolders too");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn one_job_per_account_second_start_is_running() {
        let mut rig = rig(source().mailbox(folder("Other", &[raw("o1", "o")])), dest());
        let gate = rig.dst.pause_command("APPEND");
        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)));
        let second = json!({"sourceAccountId": "src", "sourcePath": "Other", "destAccountId": "src", "destPath": null});
        let err = call(&rig.s, "folder_move.start", second).await.error.expect("refused").message;
        assert_eq!(err, format!("{E_FOLDER_MOVE_RUNNING}: {job}"));
        control(&rig, "folder_move.cancel", &job).await;
        drop(gate);
        until_done(&mut rig.rx).await;
    }

    /// The job holds both accounts open: neither can be closed while it
    /// writes, and both can once it ended.
    #[tokio::test(flavor = "multi_thread")]
    async fn lifecycle_owner_blocks_account_close_until_job_ends() {
        let mut rig = rig(source(), dest());
        let gate = rig.dst.pause_command("APPEND");
        start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)));
        for id in ["src", "dst"] {
            let lease = crate::account_workflows::AccountLease::detached_for_test(crate::account_workflows::AccountWriteScope {
                ids: [id.to_owned()].into(),
                ..Default::default()
            });
            let close = rig.s.account_lifecycle.try_close(lease, id);
            assert!(matches!(close, Err(crate::account_lifecycle::LifecycleError::Busy)), "{id} closed under a running move");
        }
        drop(gate);
        until_done(&mut rig.rx).await;
        wait_for("the job let go", || rig.s.folder_moves.lock().is_empty()).await;
        for id in ["src", "dst"] {
            let mut close = None;
            for _ in 0..200 {
                let lease = crate::account_workflows::AccountLease::detached_for_test(crate::account_workflows::AccountWriteScope {
                    ids: [id.to_owned()].into(),
                    ..Default::default()
                });
                if let Ok(claim) = rig.s.account_lifecycle.try_close(lease, id) {
                    close = Some(claim);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(close.is_some(), "{id} still held after the job");
        }
    }

    /// Per-message events are throttled; a change of state always goes out,
    /// and the last one is inactive.
    #[tokio::test(flavor = "multi_thread")]
    async fn progress_events_are_throttled_and_end_with_active_false() {
        let six: Vec<String> = (1..=6).map(|i| raw(&format!("m{i}"), &format!("m{i}"))).collect();
        let src = Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Clients", &six));
        let mut rig = rig_with(src, dest(), Tuning { progress_every: Duration::from_secs(60), checkpoint_every: 25 });
        start(&rig, move_params("dst", None)).await;
        let events = until_done(&mut rig.rx).await;

        let mid = events.iter().filter(|e| e["state"] == json!(RUNNING) && (1..6).contains(&e["copied"].as_u64().unwrap_or(0))).count();
        assert_eq!(mid, 0, "no per-message event inside the throttle window: {events:?}");
        assert!(events.iter().any(|e| e["state"] == json!(VERIFYING)) && events.iter().any(|e| e["state"] == json!(RETIRING)));
        let last = events.last().unwrap();
        assert_eq!((last["active"].clone(), last["state"].clone(), last["copied"].clone()), (json!(false), json!(DONE), json!(6)));
        assert!(events[..events.len() - 1].iter().all(|e| e["active"] == json!(true)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn worker_waits_for_foreground_quiet_before_each_message() {
        let mut rig = rig(source(), dest());
        start(&rig, move_params("dst", Some("Archive"))).await;
        until_done(&mut rig.rx).await;
        let calls = rig.s.search_index.foreground_quiet_calls.load(Ordering::SeqCst);
        assert!(calls >= 3, "one wait per message, three messages: {calls}");
    }

    /// The job runs on its own `folder-move` thread: with an APPEND held on
    /// the server, every folder_move RPC still answers at once.
    #[tokio::test(flavor = "multi_thread")]
    async fn job_runs_on_its_own_thread_and_rpc_answers_while_append_is_paused() {
        let mut rig = rig(source(), dest());
        let gate = rig.dst.pause_command("APPEND");
        let job = start(&rig, move_params("dst", Some("Archive"))).await;
        assert!(gate.entered(Duration::from_secs(10)));
        let asked = Instant::now();
        let listed = tokio::time::timeout(Duration::from_secs(2), call(&rig.s, "folder_move.status", json!({}))).await.expect("status answered");
        let planned = tokio::time::timeout(Duration::from_secs(2), call(&rig.s, "folder_move.plan", move_params("dst", Some("Archive")))).await.expect("plan answered");
        assert!(asked.elapsed() < Duration::from_secs(1), "{:?}", asked.elapsed());
        assert_eq!(ok(listed)["jobs"][0]["live"], json!(true));
        assert!(planned.error.is_none());
        assert_eq!(lock(&the_run(&rig, &job).thread).as_deref(), Some("folder-move"));
        control(&rig, "folder_move.cancel", &job).await;
        drop(gate);
        until_done(&mut rig.rx).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_pause_all_and_wait_holds_at_next_message() {
        let five: Vec<String> = (1..=5).map(|i| raw(&format!("q{i}"), &format!("q{i}"))).collect();
        let src = Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Clients", &five));
        let mut rig = rig(src, dest().fault(Trigger::on("APPEND"), Action::Delay(Duration::from_millis(150))));
        let job = start(&rig, move_params("dst", None)).await;
        next(&mut rig.rx, |e| e["copied"].as_u64().unwrap_or(0) >= 1).await;
        let (s, asked) = (Arc::clone(&rig.s), Instant::now());
        let settled = tokio::task::spawn_blocking(move || pause_all_and_wait(&s, Duration::from_millis(1200))).await.unwrap();
        assert_eq!(settled, 1);
        assert!(asked.elapsed() < Duration::from_millis(1200));
        let journal = read_journal(&rig.s.app_dir, &job).unwrap();
        let copied = journal.journal.folders[0].copied as usize;
        assert_eq!((journal.state.as_str(), rig.dst.count_commands("APPEND")), (PAUSED, copied), "nothing in flight");

        control(&rig, "folder_move.resume", &job).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        assert_eq!((last["state"].clone(), last["copied"].clone()), (json!(DONE), json!(5)));
    }

    /// Two source messages share a Message-ID with different content: the
    /// destination is compared with what it held before the copy, so the
    /// second is copied too.
    #[tokio::test(flavor = "multi_thread")]
    async fn same_message_id_different_content_is_still_copied() {
        let src = Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Clients", &[raw("same", "first"), raw("same", "second")]));
        let mut rig = rig(src, dest());
        start(&rig, move_params("dst", None)).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!(subjects(&rig.dst, "Clients"), ["first", "second"]);
        assert_eq!(last["state"], json!(DONE), "{last}");
    }

    /// An IMAP folder named in modified UTF-7 lands on a JMAP server under
    /// its real name, imported.
    #[tokio::test(flavor = "multi_thread")]
    async fn imap_to_jmap_move_decodes_names_and_imports() {
        let src = Scenario::new()
            .mailbox(folder("INBOX", &[]))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
            .mailbox(folder("Kunden&AOQ-", &[raw("k1", "kunde")]));
        let mut rig = rig(src, dest());
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        rig.s.raw_messages.accounts.lock().unwrap().insert("dst".into(), support::config(&m, port));

        start(&rig, json!({"sourceAccountId": "src", "sourcePath": "Kunden&AOQ-", "destAccountId": "dst", "destPath": "Work"})).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!(last["state"], json!(DONE), "{last}");
        let made = support::mailbox_named(&m, Some("Work"), "Kunden\u{e4}").expect("Work/Kundenä on the server");
        let moved = support::emails_in(&m, &made);
        assert_eq!(moved.len(), 1);
        assert!(moved[0].raw.contains("<k1@x>"));
        assert!(has(&rig.src, "Trash/Kunden&AOQ-"));
    }

    /// A JMAP source is retired by reparenting its mailbox under Trash.
    #[tokio::test(flavor = "multi_thread")]
    async fn jmap_source_retire_reparents_under_trash() {
        let mut rig = rig(source(), dest());
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (_trap, port) = support::imap_trap();
        rig.s.raw_messages.accounts.lock().unwrap().insert("src".into(), support::config(&m, port));

        start(&rig, json!({"sourceAccountId": "src", "sourcePath": "Work", "destAccountId": "dst", "destPath": "Archive"})).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();

        assert_eq!((last["state"].clone(), last["retiredTo"].clone()), (json!(DONE), json!("Trash/Work")), "{last}");
        assert_eq!(subjects(&rig.dst, "Archive/Work"), ["one"]);
        assert_eq!(support::mailbox_named(&m, Some("Trash"), "Work"), Some("mb-work".to_string()), "the same mailbox, under Trash");
    }

    // ---- Graph ----

    fn graph_folder(id: &str, name: &str) -> Value {
        json!({"id": id, "displayName": name, "totalItemCount": 1, "unreadItemCount": 0, "childFolderCount": 0})
    }

    fn graph_listing(ids: &[(&str, &str)]) -> String {
        let value: Vec<Value> = ids
            .iter()
            .map(|(id, mid)| {
                json!({"id": id, "subject": "graph one", "from": null, "toRecipients": null, "ccRecipients": null, "bccRecipients": null,
                       "receivedDateTime": "2026-01-01T12:00:00Z", "sentDateTime": null, "isRead": true, "hasAttachments": false,
                       "internetMessageId": mid, "body": null, "internetMessageHeaders": null})
            })
            .collect();
        json!({"value": value}).to_string()
    }

    /// A Graph source (two folders named Clients; the app picked fld-b) moved
    /// into an IMAP Archive: every Graph answer in the order the job asks.
    async fn graph_move(rig: &mut Rig) -> (Value, Vec<String>, Vec<String>) {
        let folders = json!({"value": [graph_folder("fld-inbox", "Posteingang"), graph_folder("fld-del", "Geloescht"), graph_folder("fld-b", "Clients")]});
        let batch = json!({"responses": [{"id": "inbox", "status": 200, "body": {"id": "fld-inbox"}}, {"id": "deleteditems", "status": 200, "body": {"id": "fld-del"}}]});
        let listing = graph_listing(&[("m1", "<g1@x>")]);
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![
            (200, folders.to_string()),
            (200, batch.to_string()),
            (200, listing.clone()),
            (200, raw("g1", "graph one")),
            (200, listing),
            (200, graph_folder("fld-b", "Clients").to_string()),
        ]);
        let graph: ImapConfig = serde_json::from_value(json!({"email": "src@example.com", "imapHost": "outlook.office365.com", "oauth2AccessToken": "tok", "oauth2Transport": "graph"})).unwrap();
        rig.s.raw_messages.accounts.lock().unwrap().insert("src".into(), graph);
        start(rig, json!({"sourceAccountId": "src", "sourcePath": "Clients", "sourceFolderId": "fld-b", "destAccountId": "dst", "destPath": "Archive"})).await;
        let last = until_done(&mut rig.rx).await.pop().unwrap();
        let seen = crate::handlers::graph::test_graph_requests();
        let lines = seen.iter().map(|r| format!("{} {}", r.method, r.path.split('?').next().unwrap_or_default())).collect();
        (last, lines, seen.iter().map(|r| r.body.clone()).collect())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn graph_source_lists_by_folder_id_not_display_name() {
        let mut rig = rig(source(), dest());
        let (last, lines, _) = graph_move(&mut rig).await;

        assert_eq!(last["state"], json!(DONE), "{last} {lines:?}");
        assert_eq!(subjects(&rig.dst, "Archive/Clients"), ["graph one"]);
        assert_eq!(lines.iter().filter(|l| l.as_str() == "GET /me/mailFolders/fld-b/messages").count(), 2, "listed by id, then listed again before the retire: {lines:?}");
        assert_eq!(lines.iter().filter(|l| l.as_str() == "GET /me/mailFolders").count(), 1, "no display-name lookup: {lines:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn graph_retire_moves_folder_to_deleteditems_without_vault_rename() {
        let mut rig = rig(source(), dest());
        let root = crate::handlers::common::vault_root(&rig.s).unwrap();
        let dir = mailvault_core::message_store::mailbox_dir(&root, "src", "Clients");
        std::fs::create_dir_all(dir.join("cur")).unwrap();
        let (last, lines, bodies) = graph_move(&mut rig).await;

        assert_eq!((last["state"].clone(), last["retired"].clone()), (json!(DONE), json!(true)), "{last} {lines:?}");
        assert_eq!(lines.last().map(String::as_str), Some("POST /me/mailFolders/fld-b/move"), "{lines:?}");
        let moved: Value = serde_json::from_str(bodies.last().unwrap()).unwrap();
        assert_eq!(moved["destinationId"], json!("deleteditems"));
        assert!(dir.join("cur").exists(), "a Graph folder keeps its name, so its vault folder stays");
    }
}
