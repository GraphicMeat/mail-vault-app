//! Phase 5 (D7): per account, the messages the app has listed or cached whose
//! full copy the vault does not hold, and "Save them now".
//!
//! `vault_gap_count {accountId}` answers
//! `{count, vaultReachable, reason?, partial, byMailbox: [{mailbox, count, partial}]}`:
//! every header-cache folder's uids minus the uids its vault folder holds,
//! leaving out what the download mode leaves on the server
//! (`FetchPolicy::promises_copy`, dates read as the download gate reads them),
//! import-range uids, and the `\Flagged` / `\Important` folders the hoarder
//! skips beside an `\All` one. `byMailbox` lists only folders with a gap or a
//! `partial` answer. `partial`: a folder whose cache holds fewer rows than the
//! server's count the daemon's sync recorded (`folder_listing`'s rule), or
//! whose state cannot be known: two cached folders filed under one vault
//! folder, a vault folder that cannot be listed, or a folder the account's
//! cached folder list no longer has (deleted or renamed on the server): the
//! count is then a floor, never "all saved". `count: null` when the header
//! cache cannot be read; `reason` then, and whenever the vault is unreachable,
//! is `E_VAULT_UNAVAILABLE` (vault unreachable or being moved) or
//! `E_HEADER_CACHE_UNAVAILABLE` (vault there, cache not). The header cache
//! lives in the vault (`custody.db`), so a vault unreachable since startup has
//! no count: only one lost while the store is still open, or closed for a
//! move, still counts.
//!
//! Recomputed on every request, never cached, and one walk per account at a
//! time: a request while one runs gets its answer. The walk runs on a thread
//! of its own at background QoS. The cache is read one index seek, one page of
//! `CACHE_CHUNK` uids or one small listing per custody unit, never a whole
//! folder under the lock every foreground header read waits on. A vault
//! folder's uids come from one names-only listing of its `cur/` that takes no
//! lock at all (`vault_gap::held_uids`; never the registry, whose listing
//! holds the locks a message open waits on), and the difference is a merge
//! over the two sorted lists (`vault_gap::Gap`). It writes nothing. It does
//! not run the generation repair (a write): a folder whose UIDVALIDITY changed
//! and was not repaired yet can count copies the save then renames into
//! place instead of fetching.
//!
//! `vault_gap_save {accountId, accountJson}` answers `{runId, started: true}`
//! at once. The run repairs each folder's generation first
//! (`repair_generation_for`), plans the folders with a gap, and right before
//! each folder recomputes its gap and fetches exactly those uids with the
//! backup's per-message step (`archive::run_with_backup`, archived copies, the
//! background lane). One message goes first: a folder the server refuses to
//! SELECT is given up after that one attempt, never one login per uid. The
//! backup's `backup-progress` frames report it (one as each folder starts,
//! then one terminal frame) and `backup_cancel` stops it. A backup or save
//! already running for the account is joined, never doubled:
//! `{runId, started: false, running: true}`; a backup that takes the account
//! over stops the save within `WATCH_EVERY`. `accountJson` is the account
//! `backup_run_account` takes, from the app (fresh token): the per-message
//! step parses exactly that string. An Outlook account is refused
//! (`E_VAULT_GAP_GRAPH`): the daemon holds no Graph token and no per-uid
//! Graph save exists; its backup saves them.
//!
//! Both answer `INVALID_PARAMS` without `accountId` and `E_ACCOUNT_NOT_FOUND`
//! for an account the header cache has never heard of.

use crate::handlers::common::{self, blocking, str_arg};
use crate::handlers::imap::{download_policy, email_date_ms, now_ms};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use futures::future::{BoxFuture, FutureExt, Shared};
use mailvault_core::archive::{self, ArchiveCtx};
use mailvault_core::backup::BackupProgress;
use mailvault_core::custody::cache;
use mailvault_core::fetch_mode::{FetchMode, FetchPolicy};
use mailvault_core::imap::{ImapConfig, MailboxInfo};
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::vault_files;
use mailvault_core::vault_gap::{self as core_gap, Gap};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;
use tracing::warn;

pub(crate) const E_ACCOUNT_NOT_FOUND: &str = "E_ACCOUNT_NOT_FOUND";
/// The code every vault-rooted route's gate already answers with
/// (`handlers::common::vault_root`), catalog key `errors.E_VAULT_UNAVAILABLE`.
pub(crate) const E_VAULT_UNAVAILABLE: &str = "E_VAULT_UNAVAILABLE";
pub(crate) const E_HEADER_CACHE_UNAVAILABLE: &str = "E_HEADER_CACHE_UNAVAILABLE";
pub(crate) const E_VAULT_GAP_GRAPH: &str = "E_VAULT_GAP_GRAPH";

/// Header-cache uids per custody unit. A Keep Recent page parses each row's
/// JSON for its dates inside SQLite, so a page stays small.
const CACHE_CHUNK: usize = 1000;

/// How often a running save checks that it still owns the account's run.
const WATCH_EVERY: Duration = if cfg!(test) { Duration::from_millis(50) } else { Duration::from_secs(1) };

#[derive(Debug)]
struct Folder {
    mailbox: String,
    /// Ascending.
    missing: Vec<u32>,
    partial: bool,
}

#[derive(Debug)]
enum Unknown {
    /// The header cache holds no row, meta or folder list for the account.
    Account,
    /// The header cache could not be read.
    Cache(String),
}

/// What a count walks: the mode, when it keeps any copy at all, and the
/// cached folders in name order, each walked (`true`) or unknown (`false`).
struct Plan {
    policy: Option<FetchPolicy>,
    folders: Vec<(String, bool)>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The account's cached folder list (`custody::cache::load_mailboxes`, the
/// shape `takeout::folder_refs_from_listing` reads): every selectable path,
/// and the paths the hoarder would fill (`hoarder_worker::folders_to_hoard`:
/// without the `\Flagged` / `\Important` subsets of an `\All` folder). `None`
/// when there is no usable list: every cached folder then counts, as before.
fn listed_folders(state: &DaemonState, account_id: &str) -> Result<Option<(HashSet<String>, HashSet<String>)>, Unknown> {
    let Some(raw) = crate::custody::with_conn(state, |c| cache::load_mailboxes(c, account_id)).map_err(Unknown::Cache)? else {
        return Ok(None);
    };
    let Ok(listing) = serde_json::from_str::<Value>(&raw) else { return Ok(None) };
    let list = if listing.is_array() {
        Some(&listing)
    } else {
        listing
            .get("mailboxes")
            .filter(|a| a.as_array().is_some_and(|a| !a.is_empty()))
            .or_else(|| listing.get("lastKnownGoodMailboxes"))
    };
    fn boxes_of(list: &Value, out: &mut Vec<MailboxInfo>) {
        for m in list.as_array().into_iter().flatten() {
            if let Some(path) = m["path"].as_str().filter(|p| !p.is_empty()) {
                out.push(MailboxInfo {
                    name: m["name"].as_str().unwrap_or(path).to_string(),
                    path: path.to_string(),
                    special_use: m["specialUse"].as_str().map(str::to_string),
                    special_use_guessed: false,
                    flags: m["flags"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(str::to_string)).collect(),
                    delimiter: None,
                    noselect: m["noselect"].as_bool() == Some(true),
                    children: Vec::new(),
                });
            }
            boxes_of(&m["children"], out);
        }
    }
    let mut boxes = Vec::new();
    if let Some(list) = list {
        boxes_of(list, &mut boxes);
    }
    if boxes.is_empty() {
        return Ok(None);
    }
    let selectable = boxes.iter().filter(|m| !m.noselect).map(|m| m.path.clone()).collect();
    let hoarded = crate::hoarder_worker::folders_to_hoard(boxes).into_iter().collect();
    Ok(Some((selectable, hoarded)))
}

/// Which cached folders of `account_id` a count walks. Folders come from the
/// header rows (one seek each) and the folder meta rows (a folder the sync
/// counted whose rows are gone). Never under a custody lock while it reads
/// the settings.
fn plan(state: &DaemonState, account_id: &str, now_ms: i64) -> Result<Plan, Unknown> {
    let mut mailboxes: BTreeSet<String> =
        crate::custody::with_conn(state, |c| cache::mailboxes_with_meta(c, account_id)).map_err(Unknown::Cache)?.into_iter().collect();
    let mut after: Option<String> = None;
    while let Some(mailbox) =
        crate::custody::with_conn(state, |c| cache::next_mailbox_with_headers(c, account_id, after.as_deref())).map_err(Unknown::Cache)?
    {
        after = Some(mailbox.clone());
        mailboxes.insert(mailbox);
    }
    if mailboxes.is_empty() && !crate::custody::with_conn(state, |c| cache::knows_account(c, account_id)).map_err(Unknown::Cache)? {
        return Err(Unknown::Account);
    }
    // An undated message is promised by every mode that keeps anything at
    // all (`keeps_body_dated`), so this asks whether the mode keeps any copy:
    // a hidden, On Demand or Index Only account is missing nothing, and none
    // of its folders is walked.
    let Some(policy) = download_policy(&state.app_dir, account_id).filter(|p| p.promises_copy(None, now_ms)) else {
        return Ok(Plan { policy: None, folders: Vec::new() });
    };
    let listed = listed_folders(state, account_id)?;
    let mut per_dir: HashMap<String, usize> = HashMap::new();
    for mailbox in &mailboxes {
        *per_dir.entry(vault_dir_name(mailbox)).or_default() += 1;
    }
    let mut folders = Vec::with_capacity(mailboxes.len());
    for mailbox in mailboxes {
        let walked = match &listed {
            // A `\Flagged` / `\Important` subset of `\All`: its mail is
            // counted, and saved, once, in `\All`.
            Some((selectable, hoarded)) if selectable.contains(&mailbox) && !hoarded.contains(&mailbox) => continue,
            // Not on the server's list any more (deleted or renamed there):
            // its rows cannot be fetched, so it is never walked or saved.
            Some((selectable, _)) if !selectable.contains(&mailbox) => false,
            // Two cached folders filed under one vault folder: a vault uid
            // does not say whose message it is (the hoarder skips these too).
            _ => per_dir[&vault_dir_name(&mailbox)] == 1,
        };
        folders.push((mailbox, walked));
    }
    Ok(Plan { policy: Some(policy), folders })
}

/// One folder's gap: its cached uids, `chunk` per custody unit, minus the
/// uids its vault folder's `cur/` holds. A vault folder that cannot be listed
/// is `partial` with nothing counted.
fn folder_gap(state: &DaemonState, account_id: &str, mailbox: &str, policy: &FetchPolicy, chunk: usize, now_ms: i64) -> Result<Folder, Unknown> {
    let chunk = chunk.max(1);
    let root = &state.data_dir;
    let Some(held) = core_gap::held_uids(root, &vault_files::cur_path(root, account_id, mailbox)) else {
        return Ok(Folder { mailbox: mailbox.to_string(), missing: Vec::new(), partial: true });
    };
    let (server, uid_next) = crate::custody::with_conn(state, |c| cache::recorded_count(c, account_id, mailbox)).map_err(Unknown::Cache)?;
    // Only Keep Recent judges by date: read the dates the download gate
    // reads (the Date header, else INTERNALDATE), never the list's sort key.
    let dated = policy.mode == FetchMode::KeepRecent;
    let mut walk = Gap::new(&held);
    let (mut rows, mut below_next) = (0i64, 0i64);
    let mut after = None;
    loop {
        let page: Vec<(u32, Option<i64>)> = if dated {
            crate::custody::with_conn(state, |c| core_gap::dated_page(c, account_id, mailbox, after, chunk))
                .map_err(Unknown::Cache)?
                .into_iter()
                .map(|(uid, date, internal)| (uid, email_date_ms(date.as_deref(), internal.as_deref())))
                .collect()
        } else {
            crate::custody::with_conn(state, |c| cache::uid_dates_after(c, account_id, mailbox, after, chunk))
                .map_err(Unknown::Cache)?
                .into_iter()
                .map(|(uid, _)| (uid, None))
                .collect()
        };
        rows += page.len() as i64;
        below_next += page.iter().filter(|(uid, _)| uid_next.is_some_and(|next| i64::from(*uid) < next)).count() as i64;
        walk.feed(&page, |date| policy.promises_copy(date, now_ms));
        match page.last() {
            Some(&(last, _)) if page.len() == chunk => after = Some(last),
            _ => break,
        }
    }
    // `folder_listing`'s rule: only rows below the recorded UIDNEXT are
    // judged against the recorded count; with no count, the rows are the
    // listing.
    let judged = if server.is_some() && uid_next.is_some() { below_next } else { rows };
    let partial = server.is_some_and(|total| judged < total);
    Ok(Folder { mailbox: mailbox.to_string(), missing: walk.missing, partial })
}

/// Every cached folder of `account_id` with the uids its vault folder is
/// missing, reading the cache `chunk` uids per custody unit.
fn gap(state: &DaemonState, account_id: &str, chunk: usize, now_ms: i64) -> Result<Vec<Folder>, Unknown> {
    let plan = plan(state, account_id, now_ms)?;
    let Some(policy) = plan.policy else { return Ok(Vec::new()) };
    let mut folders = Vec::with_capacity(plan.folders.len());
    for (mailbox, walked) in plan.folders {
        folders.push(match walked {
            true => folder_gap(state, account_id, &mailbox, &policy, chunk, now_ms)?,
            false => Folder { mailbox, missing: Vec::new(), partial: true },
        });
    }
    Ok(folders)
}

/// `f` on a thread of its own at background QoS. Never a pooled blocking
/// thread: a QoS lowered there would stay with the foreground work it runs
/// next.
async fn in_background<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("vault-gap".into())
        .spawn(move || {
            crate::mbox_upload_job::background_qos();
            let _ = tx.send(f());
        })
        .map_err(|e| format!("the count could not start: {e}"))?;
    rx.await.map_err(|_| "the count stopped before it answered".to_string())
}

type Walked = Arc<Result<Result<Vec<Folder>, Unknown>, String>>;

/// The count walk in flight per (daemon state, account), with the id that
/// tells a finished walk's entry from a newer one's.
static WALKS: LazyLock<Mutex<HashMap<(usize, String), (u64, Shared<BoxFuture<'static, Walked>>)>>> = LazyLock::new(Default::default);
static WALK_IDS: AtomicU64 = AtomicU64::new(0);

/// The account's gap, from a walk of its own or from the one already running
/// for it (`true`: this call started the walk). Several panels, windows or
/// remounts asking at once cost one walk.
async fn gap_once(state: &Arc<DaemonState>, account_id: &str) -> (Walked, bool) {
    let key = (Arc::as_ptr(state) as usize, account_id.to_string());
    let (id, walk, started) = {
        let mut walks = lock(&WALKS);
        match walks.get(&key) {
            Some((id, walk)) => (*id, walk.clone(), false),
            None => {
                let (st, acct) = (Arc::clone(state), account_id.to_string());
                let walk = async move { Arc::new(in_background(move || gap(&st, &acct, CACHE_CHUNK, now_ms())).await) }.boxed().shared();
                let id = WALK_IDS.fetch_add(1, Ordering::Relaxed);
                walks.insert(key.clone(), (id, walk.clone()));
                (id, walk, true)
            }
        }
    };
    let walked = walk.await;
    let mut walks = lock(&WALKS);
    if walks.get(&key).is_some_and(|(held, _)| *held == id) {
        walks.remove(&key);
    }
    (walked, started)
}

pub(crate) async fn count(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    // `mail_dir_ok` is decided at startup: a drive lost since is caught by
    // the root no longer being there.
    let reachable = common::vault_root(state).is_ok_and(|root| root.is_dir());
    let (walked, _) = gap_once(state, &account_id).await;
    let folders = match walked.as_ref() {
        Ok(Ok(folders)) => folders,
        Ok(Err(Unknown::Account)) => {
            return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_ACCOUNT_NOT_FOUND}: {account_id}"));
        }
        Ok(Err(Unknown::Cache(e))) => {
            warn!("[vault_gap] {account_id}: header cache unreadable, count unknown: {e}");
            let reason = if reachable { E_HEADER_CACHE_UNAVAILABLE } else { E_VAULT_UNAVAILABLE };
            return RpcResponse::success(
                id,
                json!({"count": null, "vaultReachable": reachable, "reason": reason, "partial": true, "byMailbox": []}),
            );
        }
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e.clone()),
    };
    let count: usize = folders.iter().map(|f| f.missing.len()).sum();
    let by_mailbox: Vec<Value> = folders
        .iter()
        .filter(|f| f.partial || !f.missing.is_empty())
        .map(|f| json!({"mailbox": f.mailbox, "count": f.missing.len(), "partial": f.partial}))
        .collect();
    let mut reply = json!({
        "count": count,
        "vaultReachable": reachable,
        "partial": folders.iter().any(|f| f.partial),
        "byMailbox": by_mailbox,
    });
    if !reachable {
        reply["reason"] = json!(E_VAULT_UNAVAILABLE);
    }
    RpcResponse::success(id, reply)
}

/// Whether the save whose token is `cancel` still owns the account's entry
/// in `backup_runs`.
fn owns_run(state: &DaemonState, account_id: &str, cancel: &Arc<AtomicBool>) -> bool {
    lock(&state.backup_runs).get(account_id).is_some_and(|token| Arc::ptr_eq(token, cancel))
}

/// This run's `backup-progress` frames, while it still owns the account's
/// entry in `backup_runs`. `backup_run_account` replaces a running entry (the
/// app's stall-watchdog retry relies on that), and the app settles a
/// scheduled backup on the first `active: false` frame for its account: a
/// frame from a save it displaced would end that backup early. So a
/// displaced save stops (its own cancel flag) and emits nothing more; the run
/// that took the entry owns the account's frames.
fn frames_while_owned(state: &Arc<DaemonState>, account_id: &str, cancel: Arc<AtomicBool>) -> Arc<dyn Fn(BackupProgress) + Send + Sync> {
    let (state, account_id) = (Arc::clone(state), account_id.to_string());
    Arc::new(move |frame: BackupProgress| {
        if !owns_run(&state, &account_id, &cancel) {
            cancel.store(true, Ordering::SeqCst);
            return;
        }
        if let Ok(v) = serde_json::to_value(&frame) {
            state.events.emit("backup-progress", v);
        }
    })
}

/// What a save has done so far.
#[derive(Default)]
struct Tally {
    saved: usize,
    errors: usize,
    /// The server's words for the last message that could not be fetched.
    last_error: Option<String>,
    /// A provider's bandwidth stop, in the backup's own words.
    bandwidth_stop: Option<String>,
}

impl Tally {
    fn add(&mut self, run: archive::ArchiveProgress) {
        self.saved += run.completed;
        self.errors += run.errors;
        if run.bandwidth_limited {
            self.bandwidth_stop = run.last_error;
        } else if run.errors > 0 {
            self.last_error = run.last_error;
        }
    }

    /// Same frame and words as the account backup's terminal one
    /// (`backup::terminal_backup_progress`, `partial_error_message`): no
    /// mirror is written, so no external-copy failure is ever reported.
    fn terminal(&self, account_id: &str, cancelled: bool, total_folders: usize, completed_folders: usize) -> BackupProgress {
        let partial = (self.errors > 0).then(|| {
            let attempted = self.saved + self.errors;
            let head = format!("{} of {} message{} could not be fetched", self.errors, attempted, if attempted == 1 { "" } else { "s" });
            match self.last_error.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
                Some(e) => format!("{head}. Last error: {e}"),
                None => format!("{head}."),
            }
        });
        BackupProgress {
            account_id: account_id.to_string(),
            folder: if cancelled { "Cancelled" } else { "Complete" }.to_string(),
            total_folders,
            completed_folders,
            total_emails: self.saved + self.errors,
            completed_emails: self.saved,
            errors: self.errors,
            active: false,
            last_error: self.bandwidth_stop.clone().or(partial),
            missing_in_folder: 0,
            cancelled,
            success: !cancelled,
            external_copy_ok: true,
            external_copy_error: None,
            external_copy_failed_count: 0,
        }
    }
}

/// Whether `error` is the server refusing to SELECT `mailbox` (a tagged NO
/// or BAD): the folder is not there to fetch from, so trying its other uids
/// would only log in again for each. A SELECT on a connection that died is
/// not this.
fn select_refused(error: &str, mailbox: &str) -> bool {
    let head = format!("SELECT {mailbox} failed: ");
    error.find(&head).is_some_and(|at| {
        let rest = &error[at + head.len()..];
        rest.starts_with("no response") || rest.starts_with("bad response")
    })
}

/// Everything one save needs for its fetches.
struct Save {
    state: Arc<DaemonState>,
    archive_ctx: Arc<ArchiveCtx>,
    account_id: String,
    account_json: String,
    cancel: Arc<AtomicBool>,
    on_progress: Arc<dyn Fn(BackupProgress) + Send + Sync>,
}

impl Save {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    async fn fetch(&self, mailbox: &str, uids: Vec<u32>) -> Result<archive::ArchiveProgress, String> {
        archive::run_with_backup(
            Arc::clone(&self.archive_ctx), self.account_id.clone(), self.account_json.clone(), mailbox.to_string(), uids,
            Arc::clone(&self.cancel), None, None, false, "backup", true,
        )
        .await
    }

    /// One folder's `missing` uids: the first alone, then the rest. A folder
    /// the server refuses to SELECT stops after that first attempt with all
    /// of them counted as not fetched; a first message that failed another
    /// way is tried again with the rest.
    async fn folder(&self, mailbox: &str, missing: Vec<u32>, tally: &mut Tally) -> Result<(), String> {
        let Some((&first, rest)) = missing.split_first() else { return Ok(()) };
        let mut rest = rest.to_vec();
        let probe = self.fetch(mailbox, vec![first]).await?;
        if probe.errors > 0 && !probe.bandwidth_limited {
            if probe.last_error.as_deref().is_some_and(|e| select_refused(e, mailbox)) {
                warn!("[vault_gap] {}: {mailbox} refused, {} messages left for a later save", self.account_id, missing.len());
                tally.errors += missing.len();
                tally.last_error = probe.last_error;
                return Ok(());
            }
            rest.insert(0, first);
        } else {
            tally.add(probe);
        }
        if rest.is_empty() || self.cancelled() {
            return Ok(());
        }
        tally.add(self.fetch(mailbox, rest).await?);
        Ok(())
    }

    /// The whole save: generation repair and a plan on the background thread,
    /// then per folder a fresh gap (a copy the hoarder, a backfill or IDLE
    /// landed since the plan is not fetched twice) and its fetch.
    async fn run(&self) -> Result<(), String> {
        let now = now_ms();
        let (st, acct) = (Arc::clone(&self.state), self.account_id.clone());
        let planned = in_background(move || -> Result<Option<(FetchPolicy, Vec<String>)>, Unknown> {
            let plan = plan(&st, &acct, now)?;
            let Some(policy) = plan.policy else { return Ok(None) };
            let mut planned = Vec::new();
            for (mailbox, _) in plan.folders.into_iter().filter(|(_, walked)| *walked) {
                // What `vault_uid_sets` runs first: renames copies filed under
                // an earlier UIDVALIDITY, so they are not fetched again.
                if let Err(e) = crate::handlers::custody::repair_generation_for(&st, &acct, &mailbox) {
                    warn!("[vault_gap] {acct}: {mailbox} generation not repaired: {e}");
                }
                if !folder_gap(&st, &acct, &mailbox, &policy, CACHE_CHUNK, now)?.missing.is_empty() {
                    planned.push(mailbox);
                }
            }
            Ok(Some((policy, planned)))
        })
        .await?;
        let (policy, planned) = match planned {
            Ok(Some(planned)) => planned,
            // The mode keeps no copy: nothing is missing.
            Ok(None) => {
                (self.on_progress)(Tally::default().terminal(&self.account_id, false, 0, 0));
                return Ok(());
            }
            Err(Unknown::Account) => return Err(format!("{E_ACCOUNT_NOT_FOUND}: {}", self.account_id)),
            Err(Unknown::Cache(e)) => return Err(format!("{E_HEADER_CACHE_UNAVAILABLE}: {e}")),
        };
        let total_folders = planned.len();
        let (mut tally, mut completed_folders, mut cancelled) = (Tally::default(), 0, false);
        for mailbox in planned {
            if self.cancelled() {
                cancelled = true;
                break;
            }
            let policy = policy.clone();
            let (st, acct, mbox) = (Arc::clone(&self.state), self.account_id.clone(), mailbox.clone());
            let missing = match in_background(move || folder_gap(&st, &acct, &mbox, &policy, CACHE_CHUNK, now_ms())).await? {
                Ok(folder) => folder.missing,
                Err(Unknown::Account) => return Err(format!("{E_ACCOUNT_NOT_FOUND}: {}", self.account_id)),
                Err(Unknown::Cache(e)) => return Err(format!("{E_HEADER_CACHE_UNAVAILABLE}: {e}")),
            };
            if !missing.is_empty() {
                (self.on_progress)(BackupProgress {
                    account_id: self.account_id.clone(), folder: mailbox.clone(), total_folders, completed_folders,
                    total_emails: tally.saved + tally.errors, completed_emails: tally.saved, errors: tally.errors, active: true,
                    last_error: None, missing_in_folder: missing.len(), cancelled: false, success: true, external_copy_ok: true,
                    external_copy_error: None, external_copy_failed_count: 0,
                });
                self.folder(&mailbox, missing, &mut tally).await?;
            }
            // A cancel, a provider's bandwidth stop (it sets the flag) or a
            // backup that took the account over.
            if self.cancelled() {
                cancelled = true;
                break;
            }
            completed_folders += 1;
        }
        (self.on_progress)(tally.terminal(&self.account_id, cancelled, total_folders, completed_folders));
        Ok(())
    }
}

pub(crate) async fn save(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let account_json = match str_arg(&id, params, "accountJson") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let account: ImapConfig = match serde_json::from_str(&account_json) {
        Ok(a) => a,
        Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Bad account JSON: {e}")),
    };
    if account.oauth2_transport.as_deref() == Some("graph") {
        return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_VAULT_GAP_GRAPH}: an Outlook account's missing messages are saved by its backup"));
    }
    // A drive lost since startup passes `vault_root` (its checks are made at
    // startup and by a move); writing there would build the vault's folders
    // on the boot volume instead.
    let root = match common::vault_root(state) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, common::gate_message("the folder is not reachable")),
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    };
    let (st, acct) = (Arc::clone(state), account_id.clone());
    match blocking(move || crate::custody::with_conn(&st, |c| cache::knows_account(c, &acct))).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_ACCOUNT_NOT_FOUND}: {account_id}")),
        Ok(Err(e)) | Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_HEADER_CACHE_UNAVAILABLE}: {e}")),
    }
    let Some(run) = crate::handlers::backup::claim_run(state, &account_id) else {
        return RpcResponse::success(id, json!({"runId": account_id, "started": false, "running": true}));
    };
    let save = Save {
        state: Arc::clone(state),
        archive_ctx: crate::handlers::archive::archive_ctx(state, root),
        account_id: account_id.clone(),
        account_json,
        cancel: run.cancel(),
        on_progress: frames_while_owned(state, &account_id, run.cancel()),
    };
    tokio::spawn(async move {
        // Held to the end: its drop takes this run's own entry out of
        // `backup_runs`, never a newer run's.
        let _run = run;
        // A backup that takes the account over (`backup_run_account`
        // replaces the entry) stops the save between two fetches, not at the
        // next folder: the two would download the same messages.
        let watch = async {
            loop {
                tokio::time::sleep(WATCH_EVERY).await;
                if !owns_run(&save.state, &save.account_id, &save.cancel) {
                    save.cancel.store(true, Ordering::SeqCst);
                }
            }
        };
        let result = tokio::select! {
            result = save.run() => result,
            _ = watch => Ok(()),
        };
        if let Err(e) = result {
            warn!("[vault_gap] {}: the save stopped before its terminal frame: {e}", save.account_id);
            (save.on_progress)(crate::handlers::backup::failed_frame(&save.account_id, e));
        }
    });
    RpcResponse::success(id, json!({"runId": account_id, "started": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mailvault_core::maildir::{vault_filename_uid, IMPORT_UID_BASE, INFO_PREFIX};
    use mailvault_core::vault_files;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{Action, MockImap, Scenario, Trigger};
    use std::time::{Duration, Instant};
    use tokio::sync::broadcast;

    const ACCT: &str = "acc1";

    struct Rig {
        _vault: tempfile::TempDir,
        _app: tempfile::TempDir,
        s: Arc<DaemonState>,
    }

    /// A daemon with the header cache open and a Hoarder account: every
    /// cached message is one the vault should hold.
    fn rig() -> Rig {
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let s = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), true);
        mode(&s, json!({"fetchMode": "hoarder"}));
        Rig { _vault: vault, _app: app, s }
    }

    fn mode(s: &DaemonState, settings: Value) {
        std::fs::write(s.app_dir.join("frontend-settings.json"), json!({"mailvault-settings": {"state": settings}}).to_string()).unwrap();
    }

    /// Header rows of `mailbox`, each with an RFC 3339 INTERNALDATE or none
    /// (the unknown-date sentinel), plus `meta`'s keys as the folder's meta.
    fn cache_rows(s: &DaemonState, mailbox: &str, rows: &[(u32, Option<&str>)], meta: Value) {
        let emails: Vec<Value> = rows
            .iter()
            .map(|(uid, date)| match date {
                Some(d) => json!({"uid": uid, "internalDate": d}),
                None => json!({"uid": uid}),
            })
            .collect();
        let mut data = meta;
        data["emails"] = json!(emails);
        crate::custody::with_conn(s, |c| cache::save_headers(c, ACCT, mailbox, &data.to_string())).unwrap();
    }

    fn cached(s: &DaemonState, mailbox: &str, uids: impl IntoIterator<Item = u32>) {
        let rows: Vec<(u32, Option<&str>)> = uids.into_iter().map(|u| (u, None)).collect();
        cache_rows(s, mailbox, &rows, json!({}));
    }

    fn raw(uid: u32) -> String {
        format!("From: a@example.com\r\nSubject: Msg {uid}\r\nDate: Thu, 01 Jan 2015 00:00:00 +0000\r\nMessage-ID: <m{uid}@example.com>\r\n\r\nBody {uid}\r\n")
    }

    /// Vault copies of `uids` in `mailbox`, and the registry told so.
    fn in_vault(s: &DaemonState, mailbox: &str, uids: &[u32]) {
        let cur = vault_files::cur_path(&s.data_dir, ACCT, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        for uid in uids {
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}S.eml")), raw(*uid)).unwrap();
        }
        s.vault_registry.invalidate(ACCT, mailbox);
    }

    /// uid -> the flag letters of its file name, for `mailbox`'s `cur/`.
    fn on_disk(s: &DaemonState, mailbox: &str) -> std::collections::BTreeMap<u32, String> {
        let cur = vault_files::cur_path(&s.data_dir, ACCT, mailbox);
        let Ok(entries) = std::fs::read_dir(cur) else { return Default::default() };
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let uid = vault_filename_uid(&name)?;
                Some((uid, name.split(INFO_PREFIX).nth(1).unwrap_or("").trim_end_matches(".eml").to_string()))
            })
            .collect()
    }

    fn ok(resp: RpcResponse) -> Value {
        match (resp.result, resp.error) {
            (Some(v), None) => v,
            (_, e) => panic!("refused: {e:?}"),
        }
    }

    fn refused(resp: RpcResponse) -> ipc::RpcError {
        resp.error.expect("must be refused")
    }

    async fn count_of(s: &Arc<DaemonState>) -> Value {
        ok(handle_request_for_test(s, "vault_gap_count", json!({"accountId": ACCT})).await)
    }

    fn by_mailbox(reply: &Value) -> Vec<(String, u64, bool)> {
        reply["byMailbox"]
            .as_array()
            .expect("byMailbox")
            .iter()
            .map(|f| (f["mailbox"].as_str().unwrap().to_string(), f["count"].as_u64().unwrap(), f["partial"].as_bool().unwrap()))
            .collect()
    }

    // ── the count ──────────────────────────────────────────────────────────

    /// Per folder: the cached uids minus the vault's. A vault copy the cache
    /// no longer lists (9) takes nothing off; a folder with no vault dir
    /// misses all it lists. By construction it is cheap and read-only: no
    /// registry listing at all, no message read, no header-cache write, no
    /// vault file touched.
    #[tokio::test]
    async fn the_count_is_the_cached_messages_the_vault_does_not_hold() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=5);
        cached(&r.s, "Work", [10, 11]);
        in_vault(&r.s, "INBOX", &[2, 4, 9]);
        let listings = r.s.vault_registry.listing_count();
        let written = r.s.custody.gen.load(Ordering::SeqCst);

        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(5), "{got}");
        assert_eq!(got["vaultReachable"], json!(true));
        assert!(got.get("reason").is_none(), "{got}");
        assert_eq!(got["partial"], json!(false));
        assert_eq!(by_mailbox(&got), vec![("INBOX".to_string(), 3, false), ("Work".to_string(), 2, false)]);

        assert_eq!(r.s.vault_registry.listing_count(), listings, "the registry lists nothing");
        assert_eq!(r.s.vault_registry.parse_count(), 0, "no message is read");
        assert_eq!(r.s.custody.gen.load(Ordering::SeqCst), written, "the header cache is not written");
        assert_eq!(on_disk(&r.s, "INBOX").into_keys().collect::<Vec<_>>(), vec![2, 4, 9], "nor the vault");

        // The disk is read again on every count: a copy landed since counts.
        std::fs::write(vault_files::cur_path(&r.s.data_dir, ACCT, "INBOX").join(format!("1{INFO_PREFIX}S.eml")), raw(1)).unwrap();
        assert_eq!(count_of(&r.s).await["count"], json!(4));
    }

    /// The count takes no registry lock: with the folder's registry lock held
    /// (a first registry read of an unverified folder lists it under that
    /// lock, and the message a user opens waits on it), the walk still ends,
    /// and the registry has listed nothing.
    #[tokio::test]
    async fn the_count_never_waits_on_the_vault_registry() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=3);
        in_vault(&r.s, "INBOX", &[2]);
        let listings = r.s.vault_registry.listing_count();
        let st = Arc::clone(&r.s);
        let walked = r.s.vault_registry.serialized(ACCT, "INBOX", move || {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(gap(&st, ACCT, CACHE_CHUNK, now_ms()));
            });
            rx.recv_timeout(Duration::from_secs(10)).expect("the count waited on the registry's folder lock")
        });
        let folders = walked.expect("the cache reads");
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].missing, vec![1, 3]);
        assert_eq!(r.s.vault_registry.listing_count(), listings);
    }

    /// The account's folder list, as the app caches it: `(path, flags)`.
    fn folder_list(s: &DaemonState, folders: &[(&str, &[&str])]) {
        let list: Vec<Value> = folders
            .iter()
            .map(|(path, flags)| json!({"name": path, "path": path, "specialUse": null, "flags": flags, "delimiter": "/", "noselect": false, "children": []}))
            .collect();
        let data = json!({"mailboxes": list}).to_string();
        crate::custody::with_conn(s, |c| cache::save_mailboxes(c, ACCT, &data)).unwrap();
    }

    /// Header rows given whole.
    fn rows(s: &DaemonState, mailbox: &str, emails: Vec<Value>) {
        let data = json!({"emails": emails}).to_string();
        crate::custody::with_conn(s, |c| cache::save_headers(c, ACCT, mailbox, &data)).unwrap();
    }

    /// Beside an `\All` folder, the `\Flagged` and `\Important` ones are
    /// its subsets: the hoarder never fills them, so they are not counted
    /// (nor partial). Without an `\All` folder they count like any other.
    #[tokio::test]
    async fn the_hoarders_subset_folders_are_left_out_beside_all_mail() {
        let r = rig();
        let important = "Extension(\"\\\\Important\")";
        folder_list(
            &r.s,
            &[("INBOX", &[]), ("[Gmail]/All Mail", &["All"]), ("[Gmail]/Starred", &["Flagged"]), ("[Gmail]/Important", &[important])],
        );
        for mailbox in ["INBOX", "[Gmail]/All Mail", "[Gmail]/Starred", "[Gmail]/Important"] {
            cached(&r.s, mailbox, [1, 2]);
        }
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(4), "{got}");
        assert_eq!(got["partial"], json!(false));
        assert_eq!(by_mailbox(&got), vec![("INBOX".to_string(), 2, false), ("[Gmail]/All Mail".to_string(), 2, false)]);

        folder_list(&r.s, &[("INBOX", &[]), ("[Gmail]/All Mail", &[]), ("[Gmail]/Starred", &["Flagged"]), ("[Gmail]/Important", &[important])]);
        assert_eq!(count_of(&r.s).await["count"], json!(8));
    }

    /// Keep Recent judges a message by the date the download gate reads
    /// (`email_date_ms`: the Date header, else INTERNALDATE), not the list's
    /// sort key (INTERNALDATE first): migrated mail, recently appended with
    /// an old Date, is left on the server, as the gate and eviction leave it.
    #[tokio::test]
    async fn keep_recent_judges_by_the_date_the_download_gate_reads() {
        let r = rig();
        mode(&r.s, json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 3}));
        let recent = chrono::Utc::now() - chrono::Duration::days(1);
        let old = "Thu, 01 Jan 2015 00:00:00 +0000";
        rows(
            &r.s,
            "INBOX",
            vec![
                json!({"uid": 1, "date": old, "internalDate": recent.to_rfc3339()}),
                json!({"uid": 2, "date": recent.to_rfc2822(), "internalDate": "2015-01-01T00:00:00Z"}),
                json!({"uid": 3, "internalDate": recent.to_rfc3339()}),
                json!({"uid": 4, "messageDate": old, "date": recent.to_rfc3339()}),
            ],
        );
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(2), "uids 2 and 3 only: {got}");
    }

    /// A folder the account's cached folder list no longer has (deleted or
    /// renamed on the server) is unknown: `partial`, nothing counted, never
    /// fetched. With no folder list at all every cached folder counts.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_gone_from_the_folder_list_is_unknown_and_never_saved() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=2)).mailbox(folder("Old", 1..=3)));
        let r = rig();
        cached(&r.s, "INBOX", 1..=2);
        cached(&r.s, "Old", 1..=3);
        assert_eq!(count_of(&r.s).await["count"], json!(5), "no folder list: as before");

        folder_list(&r.s, &[("INBOX", &[])]);
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(2), "{got}");
        assert_eq!(got["partial"], json!(true));
        assert_eq!(by_mailbox(&got), vec![("INBOX".to_string(), 2, false), ("Old".to_string(), 0, true)]);

        let mut rx = r.s.events.subscribe();
        ok(save_now(&r.s, &server).await);
        let done = terminal(&mut rx).await;
        assert_eq!((done["completed_emails"].clone(), done["total_folders"].clone()), (json!(2), json!(1)), "{done}");
        assert_eq!(fetched(&server), vec![1, 2]);
        assert!(server.commands().iter().all(|c| !c.contains("Old")), "Old is never selected: {:?}", server.commands());
        released(&r.s).await;
    }

    /// A folder the server refuses to SELECT is given up after one try: one
    /// SELECT, one login for it, all its messages reported as not fetched,
    /// and the next folder still saved. Without the first-message probe every
    /// uid would SELECT, fail, drop its connection and log in again.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_the_server_refuses_is_given_up_after_one_try() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=2)));
        let r = rig();
        cached(&r.s, "Gone", 1..=5);
        cached(&r.s, "INBOX", 1..=2);
        let mut rx = r.s.events.subscribe();

        ok(save_now(&r.s, &server).await);
        let done = terminal(&mut rx).await;
        assert_eq!(done["completed_emails"], json!(2), "{done}");
        assert_eq!(done["errors"], json!(5), "{done}");
        assert_eq!(done["cancelled"], json!(false));
        assert!(done["last_error"].as_str().is_some_and(|e| e.contains("SELECT Gone failed")), "{done}");
        let selects_of_gone = server.commands().iter().filter(|c| c.to_uppercase().contains("SELECT") && c.contains("Gone")).count();
        assert_eq!(selects_of_gone, 1, "{:?}", server.commands());
        assert!(server.count_commands("LOGIN") <= 3, "{:?}", server.commands());
        assert_eq!(fetched(&server), vec![1, 2]);
        released(&r.s).await;
    }

    /// What each download mode leaves on the server is never missing:
    /// fresh (inside a 3-month window), stale (2015) and undated messages.
    /// On Demand, Index Only and a hidden account keep no copy; Keep Recent
    /// keeps its window and the undated; Hoarder and window 0 keep all;
    /// unreadable settings keep all, as the download gates do.
    #[tokio::test]
    async fn each_download_mode_leaves_out_what_it_leaves_on_the_server() {
        let r = rig();
        let fresh = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        cache_rows(&r.s, "INBOX", &[(1, Some(&fresh)), (2, Some("2015-01-01T00:00:00+00:00")), (3, None)], json!({}));
        let cases = [
            (json!({"fetchMode": "hoarder"}), 3),
            (json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 3}), 2),
            (json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 0}), 3),
            (json!({"fetchMode": "indexOnly", "localCacheDurationMonths": 3}), 0),
            (json!({"fetchMode": "onDemand"}), 0),
            (json!({"fetchMode": "hoarder", "fetchModes": {"acc1": "onDemand"}}), 0),
            (json!({"fetchMode": "hoarder", "hiddenAccounts": {"acc1": true}}), 0),
        ];
        for (settings, want) in cases {
            mode(&r.s, settings.clone());
            let got = count_of(&r.s).await;
            assert_eq!(got["count"], json!(want), "{settings}: {got}");
            assert_eq!(got["partial"], json!(false), "{settings}");
        }
        std::fs::remove_file(r.s.app_dir.join("frontend-settings.json")).unwrap();
        assert_eq!(count_of(&r.s).await["count"], json!(3), "unreadable settings keep every body");
    }

    /// Import-range uids are mail an mbox import numbered in the vault
    /// itself, never a server message the vault is short of.
    #[tokio::test]
    async fn an_import_range_uid_is_never_counted() {
        let r = rig();
        cached(&r.s, "INBOX", [1, IMPORT_UID_BASE, IMPORT_UID_BASE + 7]);
        assert_eq!(count_of(&r.s).await["count"], json!(1));
    }

    /// A folder whose cache holds fewer rows than the server's count the sync
    /// recorded is `partial`: its gap is a floor. Rows at or past the
    /// recorded UIDNEXT (arrivals) do not stand in for old rows a backfill
    /// has not reached. A folder with no recorded count, or all its rows, is
    /// complete.
    #[tokio::test]
    async fn a_header_cache_short_of_the_server_count_is_partial() {
        let r = rig();
        let undated = |uids: &[u32]| uids.iter().map(|u| (*u, None)).collect::<Vec<(u32, Option<&str>)>>();
        cache_rows(&r.s, "INBOX", &undated(&[1, 2, 3]), json!({"syncTotalEmails": 10, "syncUidNext": 11}));
        cache_rows(&r.s, "Late", &undated(&[1, 2, 9]), json!({"syncTotalEmails": 3, "syncUidNext": 4}));
        cache_rows(&r.s, "Sent", &undated(&[1, 2]), json!({"syncTotalEmails": 2, "syncUidNext": 3}));
        // Counted by the sync, every row since gone (a wipe, a refill part way).
        cache_rows(&r.s, "Trash", &[], json!({"syncTotalEmails": 5, "syncUidNext": 6}));
        cached(&r.s, "Work", [5]);
        in_vault(&r.s, "INBOX", &[1]);
        in_vault(&r.s, "Late", &[1, 2, 9]);
        in_vault(&r.s, "Sent", &[1, 2]);

        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(3), "{got}");
        assert_eq!(got["partial"], json!(true));
        assert_eq!(
            by_mailbox(&got),
            vec![
                ("INBOX".to_string(), 2, true),
                ("Late".to_string(), 0, true),
                ("Trash".to_string(), 0, true),
                ("Work".to_string(), 1, false),
            ]
        );
    }

    /// Two cached folders filed under one vault folder (`A/B`, `A_B`): a
    /// vault uid does not say whose message it is, so neither is counted and
    /// both are `partial`, never "all saved".
    #[tokio::test]
    async fn folders_sharing_one_vault_folder_are_unknown_not_counted() {
        let r = rig();
        cached(&r.s, "A/B", [1, 2]);
        cached(&r.s, "A_B", [3]);
        cached(&r.s, "INBOX", [1]);
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(1), "{got}");
        assert_eq!(got["partial"], json!(true));
        assert_eq!(by_mailbox(&got), vec![("A/B".to_string(), 0, true), ("A_B".to_string(), 0, true), ("INBOX".to_string(), 1, false)]);
    }

    /// The vault closed for a move (the store still open): the count still
    /// comes from the header cache, with the reason.
    #[tokio::test]
    async fn an_unreachable_vault_still_counts_from_the_header_cache_and_says_why() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=3);
        in_vault(&r.s, "INBOX", &[2]);
        r.s.vault_closed.store(true, Ordering::SeqCst);
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(2), "{got}");
        assert_eq!(got["vaultReachable"], json!(false));
        assert_eq!(got["reason"], json!(E_VAULT_UNAVAILABLE));
        assert_eq!(got["partial"], json!(false));
    }

    /// No header cache to count from: the vault unreachable since startup
    /// (its `custody.db` with it), or the store closed on a reachable vault.
    /// The count is `null` with a reason, never 0.
    #[tokio::test]
    async fn with_no_header_cache_the_count_is_unknown_and_says_why() {
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let gone = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), false);
        let got = count_of(&gone).await;
        assert_eq!(
            got,
            json!({"count": null, "vaultReachable": false, "reason": E_VAULT_UNAVAILABLE, "partial": true, "byMailbox": []})
        );

        let r = rig();
        cached(&r.s, "INBOX", [1]);
        crate::custody::close(&r.s);
        let got = count_of(&r.s).await;
        assert_eq!(
            got,
            json!({"count": null, "vaultReachable": true, "reason": E_HEADER_CACHE_UNAVAILABLE, "partial": true, "byMailbox": []})
        );
    }

    /// Both routes refuse a request without an account as INVALID_PARAMS, and
    /// an account the header cache has never heard of as not found. An
    /// account known only by its folder list is known: it is missing nothing.
    #[tokio::test]
    async fn no_account_id_is_invalid_params_and_an_unknown_account_is_not_found() {
        let r = rig();
        for method in ["vault_gap_count", "vault_gap_save"] {
            let e = refused(handle_request_for_test(&r.s, method, json!({})).await);
            assert_eq!(e.code, ipc::INVALID_PARAMS, "{method}");
            assert!(e.message.contains("accountId"), "{method}: {}", e.message);
        }
        let e = refused(handle_request_for_test(&r.s, "vault_gap_count", json!({"accountId": "ghost"})).await);
        assert_eq!(e.code, ipc::INTERNAL_ERROR);
        assert!(e.message.starts_with(&format!("{E_ACCOUNT_NOT_FOUND}:")), "{}", e.message);
        let account_json = json!({"email": "ghost@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": "ghost", "accountJson": account_json})).await);
        assert!(e.message.starts_with(&format!("{E_ACCOUNT_NOT_FOUND}:")), "{}", e.message);
        assert!(r.s.backup_runs.lock().unwrap().is_empty(), "nothing started");

        cached(&r.s, "INBOX", [1]);
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT})).await);
        assert_eq!(e.code, ipc::INVALID_PARAMS);
        assert!(e.message.contains("accountJson"), "{}", e.message);
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": "not json"})).await);
        assert_eq!(e.code, ipc::INVALID_PARAMS);
        assert!(e.message.contains("Bad account JSON"), "{}", e.message);

        crate::custody::with_conn(&r.s, |c| cache::save_mailboxes(c, "listed", r#"{"mailboxes": []}"#)).unwrap();
        let got = ok(handle_request_for_test(&r.s, "vault_gap_count", json!({"accountId": "listed"})).await);
        assert_eq!(got["count"], json!(0));
        assert_eq!(got["partial"], json!(false));
    }

    /// A large folder read in pages of every size, edges included (a last
    /// page exactly full, then an empty one), gives the same gap: what a set
    /// difference gives, in order.
    #[tokio::test]
    async fn a_large_folder_counts_the_same_across_page_boundaries() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=5000);
        let held: Vec<u32> = (1..=5000).filter(|u| u % 7 == 0).collect();
        in_vault(&r.s, "INBOX", &held);
        let expected: Vec<u32> = (1..=5000).filter(|u| u % 7 != 0).collect();
        for chunk in [1, 3, 999, 1000, 4999, 5000, 5001, CACHE_CHUNK] {
            let folders = gap(&r.s, ACCT, chunk, now_ms()).expect("the cache reads");
            assert_eq!(folders.len(), 1, "chunk {chunk}");
            assert_eq!(folders[0].missing, expected, "chunk {chunk}");
            assert!(!folders[0].partial, "chunk {chunk}");
        }
        assert_eq!(count_of(&r.s).await["count"], json!(expected.len()));
    }

    // ── "Save them now" ────────────────────────────────────────────────────

    fn folder(name: &str, uids: std::ops::RangeInclusive<u32>) -> Mailbox {
        let mut mb = Mailbox::new(name);
        for uid in uids {
            mb.add(Message::new(uid, raw(uid)));
        }
        mb
    }

    fn account_json(server: &MockImap) -> String {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        json!({"email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()}).to_string()
    }

    async fn save_now(s: &Arc<DaemonState>, server: &MockImap) -> RpcResponse {
        handle_request_for_test(s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": account_json(server)})).await
    }

    /// The uids the server was asked for a whole message, sorted: every
    /// `UID FETCH <uid> (... BODY.PEEK[])` the backup step sends.
    fn fetched(server: &MockImap) -> Vec<u32> {
        let mut uids: Vec<u32> = server
            .commands()
            .iter()
            .filter(|c| c.to_uppercase().contains("BODY.PEEK[]"))
            .filter_map(|c| {
                let words: Vec<&str> = c.split_whitespace().collect();
                let is_uid_fetch = words.get(1)?.eq_ignore_ascii_case("UID") && words.get(2)?.eq_ignore_ascii_case("FETCH");
                if is_uid_fetch { words.get(3)?.parse().ok() } else { None }
            })
            .collect();
        uids.sort_unstable();
        uids
    }

    /// The account's terminal `backup-progress` frame.
    async fn terminal(rx: &mut broadcast::Receiver<Arc<str>>) -> Value {
        let wait = async {
            loop {
                match rx.recv().await {
                    Ok(line) => {
                        let v: Value = serde_json::from_str(&line).unwrap();
                        let payload = &v["params"]["payload"];
                        if v["params"]["name"] == "backup-progress" && payload["account_id"] == ACCT && payload["active"] == json!(false) {
                            return payload.clone();
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(e) => panic!("event bus: {e}"),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait).await.expect("the save never sent its terminal frame")
    }

    /// The run lets go of its `backup_runs` entry right after its last frame.
    async fn released(s: &DaemonState) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while s.backup_runs.lock().unwrap().contains_key(ACCT) {
            assert!(Instant::now() < deadline, "the save never let go of its run");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The save fetches exactly the uids the count named, from both folders,
    /// as archived vault copies, and the count drops to 0. Run again, it
    /// fetches nothing: it recomputes the gap and finds none.
    #[tokio::test(flavor = "multi_thread")]
    async fn save_fetches_exactly_the_missing_uids_and_a_second_save_fetches_nothing() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=5)).mailbox(folder("Work", 10..=12)));
        let r = rig();
        cached(&r.s, "INBOX", 1..=5);
        cached(&r.s, "Work", 10..=12);
        in_vault(&r.s, "INBOX", &[2, 4]);
        assert_eq!(count_of(&r.s).await["count"], json!(6));
        let mut rx = r.s.events.subscribe();

        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": true}));
        let done = terminal(&mut rx).await;
        assert_eq!(done["completed_emails"], json!(6), "{done}");
        assert_eq!(done["errors"], json!(0), "{done}");
        assert_eq!(done["success"], json!(true));
        assert_eq!(done["cancelled"], json!(false));
        assert_eq!((done["completed_folders"].clone(), done["total_folders"].clone()), (json!(2), json!(2)));
        assert_eq!(fetched(&server), vec![1, 3, 5, 10, 11, 12]);
        let inbox = on_disk(&r.s, "INBOX");
        assert_eq!(inbox.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        for uid in [1, 3, 5] {
            assert!(inbox[&uid].contains('A'), "a saved copy is archived: uid {uid} {:?}", inbox[&uid]);
        }
        assert_eq!(on_disk(&r.s, "Work").into_keys().collect::<Vec<_>>(), vec![10, 11, 12]);
        released(&r.s).await;
        let after = count_of(&r.s).await;
        assert_eq!((after["count"].clone(), after["partial"].clone()), (json!(0), json!(false)), "{after}");

        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": true}));
        let again = terminal(&mut rx).await;
        assert_eq!(again["completed_emails"], json!(0), "{again}");
        assert_eq!(again["total_folders"], json!(0), "{again}");
        assert_eq!(fetched(&server), vec![1, 3, 5, 10, 11, 12], "nothing fetched the second time");
        released(&r.s).await;
    }

    /// The save never fetches what the download mode leaves on the server:
    /// Keep Recent (3 months) saves the fresh message, not the 2015 one.
    #[tokio::test(flavor = "multi_thread")]
    async fn save_leaves_what_the_download_mode_leaves_on_the_server() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=2)));
        let r = rig();
        mode(&r.s, json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 3}));
        let fresh = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        cache_rows(&r.s, "INBOX", &[(1, Some(&fresh)), (2, Some("2015-01-01T00:00:00+00:00"))], json!({}));
        let mut rx = r.s.events.subscribe();

        ok(save_now(&r.s, &server).await);
        let done = terminal(&mut rx).await;
        assert_eq!(done["completed_emails"], json!(1), "{done}");
        assert_eq!(fetched(&server), vec![1]);
        released(&r.s).await;
        assert_eq!(count_of(&r.s).await["count"], json!(0));
    }

    /// One run per account. A second save while the first is still fetching
    /// (the first body fetch stalls 3 s) joins it and starts nothing; the
    /// existing `backup_cancel` stops the running one before its next folder.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_save_joins_the_running_one_and_backup_cancel_stops_it() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(folder("INBOX", 1..=3))
                .mailbox(folder("Work", 10..=12))
                .fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 1), Action::Delay(Duration::from_secs(3))),
        );
        let r = rig();
        cached(&r.s, "INBOX", 1..=3);
        cached(&r.s, "Work", 10..=12);
        let mut rx = r.s.events.subscribe();

        assert_eq!(ok(save_now(&r.s, &server).await)["started"], json!(true));
        let first = Arc::clone(r.s.backup_runs.lock().unwrap().get(ACCT).expect("registered before the reply"));
        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": false, "running": true}));
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &first), "the running save keeps its entry");

        let deadline = Instant::now() + Duration::from_secs(20);
        while server.count_commands("BODY.PEEK[]") == 0 {
            assert!(Instant::now() < deadline, "the first body fetch never came");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ok(handle_request_for_test(&r.s, "backup_cancel", json!({"accountId": ACCT})).await);
        let done = terminal(&mut rx).await;
        assert_eq!(done["cancelled"], json!(true), "{done}");
        assert_eq!(done["success"], json!(false), "{done}");
        assert!(fetched(&server).iter().all(|uid| *uid < 10), "Work never started: {:?}", fetched(&server));
        released(&r.s).await;
    }

    /// A backup already running for the account (the scheduler's) is joined:
    /// no connection, no fetch, and its entry is left exactly as it was.
    #[tokio::test]
    async fn a_save_while_a_backup_runs_for_the_account_starts_nothing() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=2)));
        let r = rig();
        cached(&r.s, "INBOX", 1..=2);
        let backup = Arc::new(AtomicBool::new(false));
        r.s.backup_runs.lock().unwrap().insert(ACCT.to_string(), Arc::clone(&backup));

        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": false, "running": true}));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(server.commands().is_empty(), "{:?}", server.commands());
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &backup));
        assert!(!backup.load(Ordering::SeqCst), "and it is not cancelled");
    }

    /// A save a scheduled backup displaced (`backup_run_account` put its own
    /// entry over the save's) emits no further frame, whose `active: false`
    /// would settle that backup early in the app, and stops. Its guard then
    /// leaves the backup's entry alone.
    #[tokio::test]
    async fn a_displaced_save_emits_nothing_more_and_stops() {
        let r = rig();
        let mut rx = r.s.events.subscribe();
        let run = crate::handlers::backup::claim_run(&r.s, ACCT).expect("no run yet");
        let frames = frames_while_owned(&r.s, ACCT, run.cancel());

        frames(crate::handlers::backup::failed_frame(ACCT, "while owned".into()));
        let line = rx.try_recv().expect("a frame while the run owns the account");
        assert!(line.contains("backup-progress") && line.contains("while owned"), "{line}");

        let backup = Arc::new(AtomicBool::new(false));
        r.s.backup_runs.lock().unwrap().insert(ACCT.to_string(), Arc::clone(&backup));
        frames(crate::handlers::backup::failed_frame(ACCT, "displaced".into()));
        assert!(matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Empty)), "no frame once displaced");
        assert!(run.cancel().load(Ordering::SeqCst), "the displaced save stops");
        assert!(!backup.load(Ordering::SeqCst), "the backup that took over is not stopped");

        drop(run);
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &backup));
    }

    /// An Outlook account is refused with its own code (the daemon holds no
    /// Graph token to fetch with), and so is a vault being moved: neither
    /// registers a run.
    #[tokio::test]
    async fn save_refuses_an_outlook_account_and_an_unavailable_vault() {
        let r = rig();
        cached(&r.s, "INBOX", [1]);
        let graph = json!({"email": "user@outlook.com", "imapHost": "outlook.office365.com", "oauth2Transport": "graph"}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": graph})).await);
        assert!(e.message.starts_with(&format!("{E_VAULT_GAP_GRAPH}:")), "{}", e.message);

        r.s.vault_closed.store(true, Ordering::SeqCst);
        let imap = json!({"email": "user@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": imap})).await);
        assert!(e.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", e.message);
        assert!(r.s.backup_runs.lock().unwrap().is_empty());
    }

    /// A drive unplugged after startup still passes the startup checks
    /// (`mail_dir_ok`, not closed): the missing root is what says so. The
    /// count reports it (with whatever the still-open store answers), and a
    /// save refuses rather than build the vault's folders on the boot volume.
    #[tokio::test]
    async fn a_vault_lost_since_startup_is_unreachable_and_a_save_refuses_it() {
        let r = rig();
        cached(&r.s, "INBOX", [1]);
        std::fs::remove_dir_all(&r.s.data_dir).unwrap();

        let got = count_of(&r.s).await;
        assert_eq!(got["vaultReachable"], json!(false), "{got}");
        assert_eq!(got["reason"], json!(E_VAULT_UNAVAILABLE), "{got}");

        let imap = json!({"email": "user@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": imap})).await);
        assert!(e.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", e.message);
        assert!(r.s.backup_runs.lock().unwrap().is_empty());
        assert!(!r.s.data_dir.exists(), "nothing was created where the vault was");
    }

    /// A save a backup takes over (`backup_run_account` puts its own entry
    /// over the save's) stops between fetches, not at the next folder: at
    /// most the fetches already past their cancel check finish. Without the
    /// watcher the rest of the folder (30 uids, 300 ms each) would download
    /// beside the backup.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_save_a_backup_takes_over_stops_between_fetches() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(folder("INBOX", 1..=30))
                .fault(Trigger::with("FETCH", "BODY.PEEK[]"), Action::Delay(Duration::from_millis(300))),
        );
        let r = rig();
        cached(&r.s, "INBOX", 1..=30);
        assert_eq!(ok(save_now(&r.s, &server).await)["started"], json!(true));
        // Past the folder's first message: the rest is being fetched.
        let deadline = Instant::now() + Duration::from_secs(30);
        while server.count_commands("BODY.PEEK[]") < 3 {
            assert!(Instant::now() < deadline, "the save never got going");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let backup = Arc::new(AtomicBool::new(false));
        r.s.backup_runs.lock().unwrap().insert(ACCT.to_string(), Arc::clone(&backup));
        let at = server.count_commands("BODY.PEEK[]");

        // Settled: no new body fetch for a whole second.
        let mut last = at;
        loop {
            assert!(Instant::now() < deadline, "the save kept fetching: {last} of 30");
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = server.count_commands("BODY.PEEK[]");
            if now == last {
                break;
            }
            last = now;
        }
        assert!(last <= at + 6, "{} fetches after the takeover", last - at);
        assert!(last < 30, "the whole folder was fetched");
        assert!(!backup.load(Ordering::SeqCst), "the backup that took over is not stopped");
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &backup), "and keeps its entry");
    }

    /// Each folder's missing uids are taken again right before it is fetched:
    /// a copy that landed while an earlier folder was fetching (the hoarder,
    /// a backfill, IDLE) is not fetched a second time beside it.
    #[tokio::test(flavor = "multi_thread")]
    async fn each_folder_is_recomputed_right_before_it_is_fetched() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(folder("INBOX", 1..=1))
                .mailbox(folder("Work", 10..=12))
                .fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 1), Action::Delay(Duration::from_secs(2))),
        );
        let r = rig();
        cached(&r.s, "INBOX", [1]);
        cached(&r.s, "Work", 10..=12);
        let mut rx = r.s.events.subscribe();

        ok(save_now(&r.s, &server).await);
        let deadline = Instant::now() + Duration::from_secs(20);
        while server.count_commands("BODY.PEEK[]") == 0 {
            assert!(Instant::now() < deadline, "the first body fetch never came");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // INBOX is still fetching (2 s): a copy of Work 11 lands meanwhile.
        in_vault(&r.s, "Work", &[11]);

        let done = terminal(&mut rx).await;
        assert_eq!(done["completed_emails"], json!(3), "{done}");
        assert_eq!(fetched(&server), vec![1, 10, 12]);
        let work = on_disk(&r.s, "Work");
        assert_eq!(work.keys().copied().collect::<Vec<_>>(), vec![10, 11, 12]);
        assert_eq!(work[&11], "S", "one copy of 11, the one that landed");
        released(&r.s).await;
    }

    /// The save repairs a folder's generation first, as `vault_uid_sets`
    /// does: a copy filed under the uid an earlier UIDVALIDITY gave it is
    /// renamed into place, not fetched again beside it. The count does not
    /// repair (a write) and counts it until then.
    #[tokio::test(flavor = "multi_thread")]
    async fn save_repairs_a_folders_generation_before_it_fetches() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=1)));
        let r = rig();
        rows(&r.s, "INBOX", vec![json!({"uid": 1, "messageId": "<m1@example.com>"})]);
        crate::custody::with_conn(&r.s, |c| cache::save_headers(c, ACCT, "INBOX", r#"{"uidValidity": 2, "totalEmails": 1}"#)).unwrap();
        let cur = vault_files::cur_path(&r.s.data_dir, ACCT, "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("5{INFO_PREFIX}S.eml")), raw(1)).unwrap();
        mailvault_core::maildir::write_generation(cur.parent().unwrap(), 1).unwrap();
        assert_eq!(count_of(&r.s).await["count"], json!(1), "uid 1 is filed as 5 until a repair");
        let mut rx = r.s.events.subscribe();

        ok(save_now(&r.s, &server).await);
        let done = terminal(&mut rx).await;
        assert_eq!((done["completed_emails"].clone(), done["total_folders"].clone()), (json!(0), json!(0)), "{done}");
        assert!(fetched(&server).is_empty(), "{:?}", server.commands());
        assert_eq!(on_disk(&r.s, "INBOX").into_keys().collect::<Vec<_>>(), vec![1]);
        released(&r.s).await;
        assert_eq!(count_of(&r.s).await["count"], json!(0));
    }

    /// Two counts of one account at once run one walk and get its one answer;
    /// a later count walks again (nothing is cached). The first walk is held
    /// on the header cache's lock until the second request has joined it.
    #[tokio::test(flavor = "multi_thread")]
    async fn two_counts_at_once_walk_once() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=3);
        let key = (Arc::as_ptr(&r.s) as usize, ACCT.to_string());
        let spawn = |s: &Arc<DaemonState>| {
            let s = Arc::clone(s);
            tokio::spawn(async move { gap_once(&s, ACCT).await })
        };
        let held = mailvault_core::custody::lock(&r.s.custody.db);
        let first = spawn(&r.s);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !lock(&WALKS).contains_key(&key) {
            assert!(Instant::now() < deadline, "the first count never started its walk");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let second = spawn(&r.s);
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(held);
        let ((a, a_started), (b, b_started)) = (first.await.unwrap(), second.await.unwrap());
        assert!(a_started && !b_started, "the second joined the first");
        assert!(Arc::ptr_eq(&a, &b), "one answer for both");
        assert!(matches!(a.as_ref(), Ok(Ok(folders)) if folders[0].missing == vec![1, 2, 3]));
        assert!(!lock(&WALKS).contains_key(&key), "a finished walk leaves no entry");
        assert!(gap_once(&r.s, ACCT).await.1, "a later count walks again");
    }
}
