//! Auto-cleanup rules, run by the daemon: once a day on its own, or when the
//! app asks (`cleanup.run_now`). The rules stay where the Storage settings
//! form writes them (`mailvault-settings.state.cleanupRules`); this module
//! only reads them. Which server copies a rule names is
//! `mailvault_core::cleanup_rules` (the old `cleanupEngine.js`, pinned by its
//! fixture). Whether each one may really go, and the delete itself, is the
//! Archive & delete engine (`mailvault_core::abd`): no second delete path.
//!
//! One run, per account with candidates:
//! - candidates come from the account's header cache (as in the JS), never
//!   from custody or vault entries, so mail that lives only in the vault is
//!   never a candidate;
//! - left out: copies composed here (`local_sent`, `local_draft`), copies
//!   custody already marks gone from the server (`serverDeleted`,
//!   `serverAbsent`), and any uid with an operation still in the op journal
//!   (an undo or a replay may still need it);
//! - an account with an Archive & delete job still going is not touched;
//! - with a backup drive configured, the drive must be the one handed to
//!   this run (Run All Now goes through the shell's `cleanup_run_now`, which
//!   resolves the bookmark) and is only read: a copy not already there stays
//!   on the server. The daemon cannot resolve the bookmark itself, so a daily
//!   run with a drive configured deletes nothing;
//! - the server is listed for the named folders only, and the listing is
//!   cut down to the candidates; a folder whose UIDVALIDITY is not the one the
//!   cache was written under is skipped, and a candidate whose Message-ID on
//!   the server is not the cached one is kept;
//! - each rule is one or two engine jobs: one that moves to Trash, one that
//!   empties the Trash folder itself (the JS deleted permanently only there);
//! - "delete" rules run with `keep_unarchived` (nothing is downloaded: only
//!   what the vault already holds goes), "archive-then-delete" rules archive
//!   first; both re-verify every copy before the delete (engine I3).
//!
//! A run never waits: a job that would sleep (daily limit, throttle back-off)
//! or pause (sign-in, drive, vault) is stopped where it stands and the rest
//! stays on the server for the next run. Runs never overlap (`running`).
//! Thread model: one `cleanup-worker` OS thread at background QoS with its
//! own current-thread runtime, like `abd-worker`; the engine yields to the UI
//! before every server command. Nothing here logs a rule, a folder, an
//! address or a token.

use crate::abd_local::DaemonLocal;
use crate::abd_worker::{self, JobOps, Kind};
use crate::handlers::common;
use crate::imap::ImapConfig;
use crate::server::DaemonState;
use mailvault_core::abd::imap_ops::build_preview_of;
use mailvault_core::abd::state as jobfile;
use mailvault_core::abd::{
    plan_job, run, AllMailMap, Control, DateScope, DeleteMode, Env, FolderPlan, JobFile, KeptReason, ListedMsg, Mode,
    NewJob, PauseReason, PlanStore, PreviewListing, RunExit, Scope, Timing,
};
use mailvault_core::cleanup_rules::{self, Account, Action, Candidate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};

pub(crate) const RUN_EVENT: &str = "cleanup-run";
const LAST_RUN_FILE: &str = "last_run.json";
/// The first daily check waits for the launch sync to settle.
const STARTUP_DELAY: Duration = Duration::from_secs(5 * 60);
/// Then it looks again this often.
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// A wait the engine asks for longer than this ends the job instead.
const MAX_WAIT_MS: i64 = 2 * 60 * 1000;

/// What the last run did, as the Storage settings line shows it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub archived: u64,
    pub deleted: u64,
    pub skipped: u64,
    pub at: i64,
}

pub(crate) enum Cmd {
    Run { mirror_root: Option<String> },
}

#[derive(Default)]
pub struct CleanupState {
    /// A run is going (manual or daily). Set before the worker hears of it.
    pub(crate) running: AtomicBool,
    pub(crate) tx: OnceLock<UnboundedSender<Cmd>>,
    /// Serialises the last-run file.
    pub(crate) file: Mutex<()>,
    /// The account a run is working on now. `abd.start` refuses it.
    pub(crate) account: Mutex<Option<String>>,
}

impl CleanupState {
    /// Claim the one run slot. `false` when a run is already going.
    pub(crate) fn claim(&self) -> bool {
        self.running.compare_exchange(false, true, SeqCst, SeqCst).is_ok()
    }

    pub(crate) fn release(&self) {
        self.running.store(false, SeqCst);
    }

    /// Take `account` for this run's engine jobs.
    pub(crate) fn hold_account(&self, account: &str) {
        *self.account.lock().unwrap_or_else(|p| p.into_inner()) = Some(account.to_string());
    }

    pub(crate) fn release_account(&self) {
        *self.account.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// A run is working on `account` now.
    pub(crate) fn holds(&self, account: &str) -> bool {
        self.account.lock().unwrap_or_else(|p| p.into_inner()).as_deref() == Some(account)
    }

    pub(crate) fn send(&self, cmd: Cmd) -> Result<(), String> {
        let tx = self.tx.get().ok_or_else(|| "errors.cleanupUnavailable".to_string())?;
        tx.send(cmd).map_err(|_| "errors.cleanupUnavailable".to_string())
    }
}

fn dir(app_dir: &Path) -> PathBuf {
    app_dir.join("cleanup")
}

/// The last run: the daemon's own file, else (the first time after the move)
/// what the app stored as `cleanupLastRun`, so an upgrade does not run again
/// straight away.
pub(crate) fn last_run(state: &DaemonState) -> Option<RunResult> {
    let _g = state.cleanup.file.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(bytes) = std::fs::read(dir(&state.app_dir).join(LAST_RUN_FILE)) {
        if let Ok(r) = serde_json::from_slice::<RunResult>(&bytes) {
            return Some(r);
        }
    }
    let settings = settings_state(state);
    let stored = settings.get("cleanupLastRun")?;
    stored.get("at").and_then(Value::as_i64)?;
    serde_json::from_value(stored.clone()).ok()
}

fn save_last_run(state: &DaemonState, r: &RunResult) {
    let _g = state.cleanup.file.lock().unwrap_or_else(|p| p.into_inner());
    let d = dir(&state.app_dir);
    let write = std::fs::create_dir_all(&d)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::to_vec(r).map_err(|e| e.to_string()))
        .and_then(|b| mailvault_core::fsx::write_atomic(&d.join(LAST_RUN_FILE), &b).map_err(|e| e.to_string()));
    if let Err(e) = write {
        warn!("cleanup: could not record the run: {e}");
    }
}

/// `mailvault-settings.state`, or `{}`.
pub(crate) fn settings_state(state: &DaemonState) -> Value {
    mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir)
        .read()
        .ok()
        .and_then(|doc| doc.get("mailvault-settings").and_then(|s| s.get("state")).cloned())
        .unwrap_or_else(|| json!({}))
}

/// The app's account list (`accounts.json`, which the app writes): id and email.
pub(crate) fn read_accounts(app_dir: &Path) -> Vec<Account> {
    let Ok(text) = std::fs::read_to_string(app_dir.join("accounts.json")) else { return Vec::new() };
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
    list.iter()
        .filter_map(|a| {
            Some(Account { id: a.get("id")?.as_str()?.to_string(), email: a.get("email")?.as_str()?.to_string() })
        })
        .collect()
}

/// A backup drive is configured in the app (`externalBackupLocation`).
fn mirror_configured(settings: &Value) -> bool {
    match settings.get("externalBackupLocation") {
        None | Some(Value::Null) => false,
        Some(v) => v.get("status").and_then(Value::as_str) != Some("not_configured"),
    }
}

// ── Selection, from the caches ─────────────────────────────────────────────

/// What a run would take, read from the caches only.
pub(crate) struct Picked {
    pub selection: cleanup_rules::Selection,
    /// (account, folder) -> the UIDVALIDITY the header cache was written under.
    pub validity: HashMap<(String, String), Option<u32>>,
}

/// Why `pick` has no selection.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum NoPick {
    /// The JS's "nothing runs" (no premium, no enabled rule).
    NoRun(cleanup_rules::NoRun),
    /// The vault or a cache could not be read: that is not "no mail", so
    /// nothing is decided and nothing is recorded (the next check retries).
    Unavailable,
}

/// Blocking. A mailbox list or header cache that does not exist is "nothing
/// cached" (the JS skipped such an account or folder); one that cannot be
/// READ fails the whole pick.
pub(crate) fn pick(state: &Arc<DaemonState>, settings: &Value, now_ms: i64) -> Result<Picked, NoPick> {
    let accounts = read_accounts(&state.app_dir);
    let mut validity = HashMap::new();
    let failed = std::cell::Cell::new(false);
    let selection = cleanup_rules::select(
        settings,
        &accounts,
        now_ms,
        |account| match crate::handlers::cache::load_mailbox_listing(state, account) {
            Ok(text) => text.and_then(|t| serde_json::from_str(&t).ok()),
            Err(_) => {
                failed.set(true);
                None
            }
        },
        |account, folder| {
            let read = common::vault_root(state).and_then(|root| {
                let order = crate::handlers::cache::header_order(&root, account, folder);
                crate::custody::with_conn(state, |c| {
                    mailvault_core::custody::cache::load_headers(c, account, folder, None, order)
                })
            });
            let text = match read {
                Ok(t) => t,
                Err(_) => {
                    failed.set(true);
                    return Vec::new();
                }
            };
            let parsed: Value = text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
            let v = parsed.get("uidValidity").and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok());
            validity.insert((account.to_string(), folder.to_string()), v);
            parsed.get("emails").and_then(Value::as_array).cloned().unwrap_or_default()
        },
    )
    .map_err(NoPick::NoRun)?;
    if failed.get() {
        return Err(NoPick::Unavailable);
    }
    Ok(Picked { selection, validity })
}

/// Uids of one folder a rule must never act on: composed here, already
/// marked gone from the server, or named by an operation still queued.
/// `None` when custody cannot be read: then nothing in the folder is.
fn protected_uids(
    state: &Arc<DaemonState>,
    journal: &[mailvault_core::op_journal::OpEntry],
    account: &str,
    folder: &str,
) -> Option<HashSet<u32>> {
    let mut out: HashSet<u32> = journal
        .iter()
        .filter(|e| e.account_id == account && e.mailbox == folder)
        .flat_map(|e| e.uids.iter().copied())
        .collect();
    let rows = crate::custody::with_conn(state, |c| mailvault_core::custody::entries::read(c, account, folder));
    match rows {
        Ok(Some(text)) => {
            let rows: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
            for e in rows {
                let local = matches!(e.get("source").and_then(Value::as_str), Some("local_sent" | "local_draft"));
                let gone = e.get("serverDeleted") == Some(&Value::Bool(true)) || e.get("serverAbsent") == Some(&Value::Bool(true));
                if local || gone {
                    if let Some(u) = mailvault_core::custody::entries::uid_of(&e) {
                        out.insert(u);
                    }
                }
            }
        }
        Ok(None) => {}
        Err(_) => return None,
    }
    Some(out)
}

/// One folder's candidates of one rule, and whether that folder is emptied.
pub(crate) type Folders = BTreeMap<String, (bool, Vec<Candidate>)>;

/// One rule's share of an account.
pub(crate) struct RuleWork {
    pub rule: usize,
    pub action: Action,
    pub folders: Folders,
}

/// One account's share of a run, grouped the way it is executed.
pub(crate) struct AccountWork {
    pub account_id: String,
    /// In rule order.
    pub rules: Vec<RuleWork>,
    /// Candidates left out before the server is asked.
    pub protected: u64,
}

impl AccountWork {
    /// Every copy the account's rules name, each once.
    pub(crate) fn unique(&self) -> HashSet<(String, u32)> {
        self.rules
            .iter()
            .flat_map(|r| r.folders.iter())
            .flat_map(|(f, (_, c))| c.iter().map(move |c| (f.clone(), c.uid)))
            .collect()
    }
}

/// Group candidates per account and rule, minus the protected ones. A copy
/// an earlier rule already names is left to that rule (the JS deleted such a
/// copy twice; once is all there is), except that a later archive-then-delete
/// rule also gets a copy an earlier delete rule names: the delete rule can
/// only take it when the vault already holds it, and when it cannot, the
/// archive rule must still archive and take it, as in the JS. A copy the
/// earlier job did take is dropped from the later one when it runs
/// (`run_account`), and each copy is counted once.
pub(crate) fn group(state: &Arc<DaemonState>, candidates: Vec<Candidate>) -> Vec<AccountWork> {
    let journal = mailvault_core::op_journal::read(&state.app_dir);
    let mut out: Vec<AccountWork> = Vec::new();
    let mut seen: HashMap<(String, String, u32), Action> = HashMap::new();
    let mut protected: HashMap<(String, String), Option<HashSet<u32>>> = HashMap::new();
    for c in candidates {
        let key = (c.account_id.clone(), c.folder.clone(), c.uid);
        match seen.get(&key) {
            None => {}
            Some(Action::Delete) if c.action == Action::ArchiveThenDelete => {}
            Some(_) => continue,
        }
        let first = seen.insert(key, c.action).is_none();
        let key = (c.account_id.clone(), c.folder.clone());
        let prot = protected.entry(key).or_insert_with(|| protected_uids(state, &journal, &c.account_id, &c.folder));
        let at = match out.iter().position(|w| w.account_id == c.account_id) {
            Some(i) => i,
            None => {
                out.push(AccountWork { account_id: c.account_id.clone(), rules: Vec::new(), protected: 0 });
                out.len() - 1
            }
        };
        let work = &mut out[at];
        if prot.as_ref().map_or(true, |p| p.contains(&c.uid)) {
            if first {
                work.protected += 1;
            }
            continue;
        }
        // Candidates arrive in rule order, so a new rule is always the last.
        if work.rules.last().map_or(true, |r| r.rule != c.rule) {
            work.rules.push(RuleWork { rule: c.rule, action: c.action, folders: BTreeMap::new() });
        }
        let r = work.rules.last_mut().expect("just pushed");
        r.folders.entry(c.folder.clone()).or_insert_with(|| (c.permanent, Vec::new())).1.push(c);
    }
    out
}

// ── The engine's Env for a cleanup job ─────────────────────────────────────

struct CleanupEnv {
    state: Arc<DaemonState>,
    account_id: String,
    host: String,
    graph: bool,
    dir: PathBuf,
}

impl Env for CleanupEnv {
    fn now_ms(&self) -> i64 {
        self.state.clock.now_ms()
    }

    /// Never a long wait: what does not fit stays for the next run.
    async fn sleep_until(&self, until_ms: i64, ctl: &Control) {
        if until_ms - self.now_ms() > MAX_WAIT_MS {
            ctl.cancel.store(true, SeqCst);
            return;
        }
        loop {
            let now = self.now_ms();
            if now >= until_ms || ctl.cancel.load(SeqCst) {
                return;
            }
            let slice = Duration::from_millis((until_ms - now) as u64).min(Duration::from_millis(250));
            tokio::time::sleep(slice).await;
        }
    }

    fn allowance_left(&self) -> Option<u64> {
        let limits = mailvault_core::transfer_limits::read_limits(&self.state.app_dir, &self.account_id);
        let limit = mailvault_core::transfer_limits::background_down_limit(limits.as_ref(), &self.host)?;
        let day = mailvault_core::transfer_limits::day_key(self.now_ms());
        let used = mailvault_core::transfer_stats::usage_on(&self.state.app_dir, &self.account_id, &day).down;
        Some(limit.saturating_sub(used))
    }

    fn daily_limit(&self) -> Option<u64> {
        let limits = mailvault_core::transfer_limits::read_limits(&self.state.app_dir, &self.account_id);
        mailvault_core::transfer_limits::background_down_limit(limits.as_ref(), &self.host)
    }

    async fn yield_to_foreground(&self) {
        crate::search_index::wait_foreground_quiet(&self.state.search_index).await;
    }

    fn save(&self, job: &JobFile) -> Result<(), String> {
        jobfile::save_job(&self.dir, job)
    }

    fn save_plan(&self, name: &str, plan: &FolderPlan) -> Result<(), String> {
        jobfile::save_plan(&self.dir, name, plan)
    }

    fn save_allmail(&self, map: &AllMailMap) -> Result<(), String> {
        jobfile::save_allmail(&self.dir, map)
    }

    /// A cleanup job's frames are not an Archive & delete job's: none go out.
    fn emit(&self, _frame: &Value) {}

    fn has_credentials(&self) -> bool {
        !self.graph || self.state.abd.tokens.fresh(&self.account_id, self.now_ms()).is_some()
    }
}

// ── Running ────────────────────────────────────────────────────────────────

#[derive(Default, Debug, Clone, Copy, PartialEq)]
pub(crate) struct Tally {
    pub archived: u64,
    pub deleted: u64,
    pub skipped: u64,
}

impl Tally {
    fn add(&mut self, o: Tally) {
        self.archived += o.archived;
        self.deleted += o.deleted;
        self.skipped += o.skipped;
    }
}

/// The listing for one job: only `folders`, each cut down to its candidates
/// (All Mail keeps every row for the Gmail map; only candidates count as its
/// own scope). Folders the server does not list, or lists under a
/// UIDVALIDITY the cache was not written under, are left out.
fn job_listing(
    full: &PreviewListing,
    folders: &Folders,
    validity: &HashMap<(String, String), Option<u32>>,
    account: &str,
) -> PreviewListing {
    let wanted = |path: &str, v: Option<u32>, id_based: bool| -> Option<HashSet<u32>> {
        let (_, cands) = folders.get(path)?;
        let cached = validity.get(&(account.to_string(), path.to_string())).copied().flatten();
        if !id_based {
            if let (Some(c), Some(s)) = (cached, v) {
                if c != s {
                    return None;
                }
            }
        }
        Some(cands.iter().map(|c| c.uid).collect())
    };
    let id_based = full.provider.is_id_based();
    let mut out = full.clone();
    out.folders = full
        .folders
        .iter()
        .filter_map(|(info, v, msgs)| {
            let keep = wanted(&info.path, *v, id_based)?;
            let rows: Vec<ListedMsg> = msgs.iter().filter(|m| m.uid != 0 && keep.contains(&m.uid)).cloned().collect();
            Some((info.clone(), *v, rows))
        })
        .collect();
    if let Some((info, v, msgs)) = &full.all_mail {
        let keep = wanted(&info.path, Some(*v), id_based);
        let rows = msgs
            .iter()
            .map(|m| {
                let mut m = m.clone();
                if keep.as_ref().map_or(true, |k| !k.contains(&m.uid)) {
                    // Still in the map, never in All Mail's own scope.
                    m.unlabelled = Some(false);
                }
                m
            })
            .collect();
        out.all_mail = Some((info.clone(), *v, rows));
    }
    out
}

/// After planning: a candidate whose Message-ID on the server is not the one
/// the cache holds for that uid is not the message the rule matched.
fn keep_changed(job: &mut JobFile, plans: &PlanStore, folders: &Folders) {
    for fs in job.folders.iter_mut() {
        let (Some(plan), Some((_, cands))) = (plans.get(&fs.plan_file), folders.get(&fs.path)) else { continue };
        for c in cands {
            let Some(cached) = c.message_id.as_deref().map(mailvault_core::maildir::normalize_message_id) else { continue };
            let Some(k) = plan.index_of(c.uid) else { continue };
            if let Some(server) = &plan.message_ids[k] {
                if !cached.is_empty() && *server != cached {
                    fs.keep(c.uid, KeptReason::ServerChanged);
                }
            }
        }
    }
}

/// What one finished job did: copies archived (archive-then-delete only) and
/// the (folder, uid) copies confirmed gone from the server.
#[derive(Default)]
struct JobDone {
    archived: u64,
    deleted: HashSet<(String, u32)>,
}

fn job_done(job: &JobFile, action: Action) -> JobDone {
    let mut d = JobDone::default();
    for fs in &job.folders {
        d.deleted.extend(fs.deleted.iter().map(|u| (fs.path.clone(), u)));
        if action == Action::ArchiveThenDelete {
            d.archived += fs.vault_ok.len();
        }
    }
    d
}

struct AccountRun<'a> {
    state: &'a Arc<DaemonState>,
    account_id: String,
    cfg: ImapConfig,
    kind: Kind,
    mirror: Option<PathBuf>,
    validity: &'a HashMap<(String, String), Option<u32>>,
}

impl AccountRun<'_> {
    /// One engine job over `folders`. Nothing it cannot finish now is waited for.
    async fn job<S: JobOps>(
        &self,
        ops: &mut S,
        full: &PreviewListing,
        action: Action,
        delete_mode: DeleteMode,
        folders: &Folders,
        taken: &HashSet<(String, u32)>,
    ) -> JobDone {
        // What an earlier job of this run already took is not asked again.
        let folders: Folders = folders
            .iter()
            .map(|(f, (p, c))| (f.clone(), (*p, c.iter().filter(|c| !taken.contains(&(f.clone(), c.uid))).cloned().collect::<Vec<_>>())))
            .filter(|(_, (_, c))| !c.is_empty())
            .collect();
        if folders.is_empty() {
            return JobDone::default();
        }
        let folders = &folders;
        let account_id = self.account_id.clone();
        let listing = job_listing(full, folders, self.validity, &account_id);
        let dir = dir(&self.state.app_dir).join("jobs").join(&account_id);
        let _ = jobfile::remove_job(&dir);
        let now = self.state.clock.now_ms();
        let mut job = JobFile::create(NewJob {
            account_id: account_id.clone(),
            account_email: self.cfg.email.clone(),
            host: self.cfg.host.clone(),
            provider: listing.provider,
            mode: if self.mirror.is_some() { Mode::ArchiveBackupDelete } else { Mode::ArchiveDelete },
            timing: Timing::AsSaved,
            delete_mode,
            scope: Scope {
                folders: listing
                    .folders
                    .iter()
                    .map(|f| &f.0.path)
                    .chain(listing.all_mail.iter().map(|a| &a.0.path).filter(|p| folders.contains_key(p.as_str())))
                    .cloned()
                    .collect(),
                dates: DateScope::All,
                date_choice: "all".to_string(),
                year_bounds: Vec::new(),
            },
            now_ms: now,
        });
        job.job_id = format!("cleanup-{account_id}-{now}");
        job.keep_unarchived = action == Action::Delete;
        job.mirror_read_only = self.mirror.is_some();
        if job.scope.folders.is_empty() {
            return JobDone::default();
        }
        let env = CleanupEnv {
            state: Arc::clone(self.state),
            account_id: account_id.clone(),
            host: self.cfg.host.clone(),
            graph: self.kind == Kind::Graph,
            dir: dir.clone(),
        };
        let local = DaemonLocal::new(Arc::clone(self.state), &account_id, &self.cfg.email)
            .with_jmap(self.kind == Kind::Jmap)
            .with_mirror(self.mirror.clone());
        let ctl = Control::new();
        let mut plans = PlanStore::new();
        let effective = abd_worker::with_lease(self.state, self.cfg.clone(), &account_id).0;
        ops.prepare(&plans, &effective);
        let planned = plan_job(&mut job, &listing, &mut plans, ops, &local, &env, &ctl).await;
        if planned != RunExit::Completed {
            warn!("cleanup: an account's job could not be planned; its mail stays on the server");
            return JobDone::default();
        }
        keep_changed(&mut job, &plans, folders);
        ops.prepare(&plans, &effective);
        let mut exit = run(&mut job, &plans, ops, &local, &env, &ctl).await;
        if exit == RunExit::Paused(PauseReason::SignInNeeded) && matches!(self.kind, Kind::Graph | Kind::ImapOauth) {
            // Once: the daemon renews the token itself, then the job goes on.
            if abd_worker::lease_daemon_token(self.state, &account_id, None).await {
                let cfg = abd_worker::with_lease(self.state, self.cfg.clone(), &account_id).0;
                ops.prepare(&plans, &cfg);
                exit = run(&mut job, &plans, ops, &local, &env, &ctl).await;
            }
        }
        ops.release().await;
        if !matches!(exit, RunExit::Completed) {
            // The kind only: a failure's text can name a folder.
            let kind = match exit {
                RunExit::Cancelled => "cancelled",
                RunExit::Paused(_) => "paused",
                RunExit::Failed(_) => "failed",
                RunExit::Completed => "completed",
            };
            info!("cleanup: a job stopped before the end ({kind}); the rest stays on the server");
        }
        job_done(&job, action)
    }
}

/// Every rule of one account, through the engine.
async fn run_account<S: JobOps>(ar: &AccountRun<'_>, ops: &mut S, work: &AccountWork) -> Tally {
    let mut tally = Tally { skipped: work.protected, ..Tally::default() };
    let unique = work.unique();
    let all = unique.len() as u64;
    let names: HashSet<String> = work.rules.iter().flat_map(|r| r.folders.keys().cloned()).collect();
    let now = ar.state.clock.now_ms();
    let listing = {
        let mut progress = |_: &str, _: usize| {};
        build_preview_of(ops, "cleanup", now, &|f| names.contains(&f.path), &mut progress).await
    };
    let full = match listing {
        Ok(l) => l,
        Err(_) => {
            // No detail: the server's text can name a folder or an address.
            warn!("cleanup: the server could not be listed; the account's mail stays on the server");
            ops.release().await;
            tally.skipped += all;
            return tally;
        }
    };
    let full = if full.provider.is_id_based() {
        match abd_worker::fill_graph_uids(ar.state, &ar.account_id, full, ar.kind == Kind::Jmap).await {
            Ok(l) => l,
            Err(_) => {
                tally.skipped += all;
                return tally;
            }
        }
    } else {
        full
    };
    // Copies gone from the server so far this run, by any job.
    let mut taken: HashSet<(String, u32)> = HashSet::new();
    for r in &work.rules {
        let (permanent, moved): (Folders, Folders) =
            r.folders.iter().map(|(k, v)| (k.clone(), v.clone())).partition(|(_, (p, _))| *p);
        for (mode, folders) in [(DeleteMode::MoveToTrash, moved), (DeleteMode::MoveToTrashAndEmpty, permanent)] {
            if folders.is_empty() {
                continue;
            }
            let done = ar.job(ops, &full, r.action, mode, &folders, &taken).await;
            tally.archived += done.archived;
            taken.extend(done.deleted);
        }
    }
    // Each named copy once: deleted by some job, or skipped.
    let deleted = unique.iter().filter(|k| taken.contains(*k)).count() as u64;
    tally.deleted += deleted;
    tally.skipped += all - deleted;
    tally
}

/// One account's share of a run, with the account already held.
async fn account_pass(
    state: &Arc<DaemonState>,
    w: &AccountWork,
    n: u64,
    mirror: &Option<PathBuf>,
    mirror_wanted: bool,
    validity: &HashMap<(String, String), Option<u32>>,
) -> Tally {
    let all_skipped = Tally { skipped: n + w.protected, ..Tally::default() };
    // The user's own Archive & delete job has the account.
    if state.abd.handle(&w.account_id).is_some_and(|h| !h.is_over()) {
        return all_skipped;
    }
    if mirror_wanted && mirror.is_none() {
        // A drive is configured and this run cannot read it: an unplugged
        // drive is not an empty one.
        return all_skipped;
    }
    let cfg = match crate::oauth_tokens::resolve(state, &w.account_id, crate::oauth_tokens::Read::Quiet).await {
        Ok(c) => c,
        Err(_) => return all_skipped,
    };
    let kind = abd_worker::kind_of(&cfg);
    if matches!(kind, Kind::Graph | Kind::ImapOauth) {
        abd_worker::lease_daemon_token(state, &w.account_id, None).await;
    }
    let ar = AccountRun { state, account_id: w.account_id.clone(), cfg: cfg.clone(), kind, mirror: mirror.clone(), validity };
    let email = cfg.email.clone();
    mailvault_core::net_activity::with_account(email, async {
        match kind {
            Kind::Graph => {
                let mut ops = abd_worker::new_graph_ops(state, &cfg.email, &w.account_id);
                run_account(&ar, &mut ops, w).await
            }
            Kind::Jmap => {
                let mut ops = abd_worker::new_jmap_ops(&cfg);
                run_account(&ar, &mut ops, w).await
            }
            _ => {
                let (effective, _) = abd_worker::with_lease(state, cfg.clone(), &w.account_id);
                let mut ops = abd_worker::new_imap_ops(state, effective);
                run_account(&ar, &mut ops, w).await
            }
        }
    })
    .await
}

/// One whole run. `None` when nothing runs at all (no premium, no enabled
/// rule), like the JS, and when the vault or a cache cannot be read: such a
/// "run" is not recorded, so the next hourly check tries again.
pub(crate) async fn run_once(state: &Arc<DaemonState>, mirror_root: Option<String>) -> Option<RunResult> {
    let now = state.clock.now_ms();
    let st = Arc::clone(state);
    let picked = common::blocking(move || {
        let settings = settings_state(&st);
        let mirror = mirror_configured(&settings);
        pick(&st, &settings, now).map(|p| {
            let work = group(&st, p.selection.candidates);
            (work, p.validity, mirror)
        })
    })
    .await
    .ok()?;
    let (work, validity, mirror_wanted) = match picked {
        Ok(p) => p,
        Err(NoPick::Unavailable) => {
            info!("cleanup: the vault or its caches cannot be read; nothing ran, the next check tries again");
            return None;
        }
        Err(NoPick::NoRun(_)) => return None,
    };
    let mirror: Option<PathBuf> = if mirror_wanted {
        mirror_root.map(PathBuf::from).filter(|p| p.is_dir())
    } else {
        None
    };
    let mut tally = Tally::default();
    for w in &work {
        let n = w.unique().len() as u64;
        if n == 0 {
            tally.skipped += w.protected;
            continue;
        }
        // Held BEFORE the abd check: `abd.start` checks the hold after it has
        // registered its job, so of two that race, one always sees the other.
        state.cleanup.hold_account(&w.account_id);
        let t = account_pass(state, w, n, &mirror, mirror_wanted, &validity).await;
        state.cleanup.release_account();
        tally.add(t);
    }
    let result = RunResult { archived: tally.archived, deleted: tally.deleted, skipped: tally.skipped, at: state.clock.now_ms() };
    let st = Arc::clone(state);
    let saved = result.clone();
    let _ = common::blocking(move || save_last_run(&st, &saved)).await;
    info!("cleanup: run done (archived {}, deleted {}, skipped {})", result.archived, result.deleted, result.skipped);
    Some(result)
}

/// Run with the slot already claimed; release it and tell the app.
async fn run_claimed(state: Arc<DaemonState>, mirror_root: Option<String>) {
    let outcome = std::panic::AssertUnwindSafe(run_once(&state, mirror_root));
    let result = futures::FutureExt::catch_unwind(outcome).await.ok().flatten();
    // A run that panicked mid-account must not leave the account held.
    state.cleanup.release_account();
    state.cleanup.release();
    state.events.emit(RUN_EVENT, json!({"state": "done", "ran": result.is_some(), "lastRun": result}));
}

// ── The worker thread ──────────────────────────────────────────────────────

/// Start the `cleanup-worker` thread. The daily check is off in a debug build
/// with `MAILVAULT_DISABLE_CLEANUP_DAILY=1` (the e2e runs), never in release.
pub(crate) fn start(state: Arc<DaemonState>) {
    let (tx, rx) = unbounded_channel::<Cmd>();
    if state.cleanup.tx.set(tx).is_err() {
        return;
    }
    let daily = !(cfg!(debug_assertions) && std::env::var("MAILVAULT_DISABLE_CLEANUP_DAILY").as_deref() == Ok("1"));
    let spawned = std::thread::Builder::new().name("cleanup-worker".into()).spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
        }
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                warn!("cleanup worker: runtime failed to start: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let local = tokio::task::LocalSet::new();
            local.run_until(worker_loop(state, rx, daily)).await;
        });
    });
    if let Err(e) = spawned {
        warn!("cleanup worker did not start: {e}");
    }
}

async fn worker_loop(state: Arc<DaemonState>, mut rx: UnboundedReceiver<Cmd>, daily: bool) {
    let mut next = tokio::time::Instant::now() + STARTUP_DELAY;
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(Cmd::Run { mirror_root }) => run_claimed(Arc::clone(&state), mirror_root).await,
                None => return,
            },
            _ = tokio::time::sleep_until(next), if daily => {
                next = tokio::time::Instant::now() + CHECK_EVERY;
                let st = Arc::clone(&state);
                let due = common::blocking(move || cleanup_rules::due(last_run(&st).map(|r| r.at), st.clock.now_ms()))
                    .await
                    .unwrap_or(false);
                if due && state.cleanup.claim() {
                    state.events.emit(RUN_EVENT, json!({"state": "running", "manual": false}));
                    run_claimed(Arc::clone(&state), None).await;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "cleanup_worker_tests.rs"]
mod tests;
