//! The job engine: plan freezing and the run loop, generic over the server, the
//! local store and the environment.
//!
//! Rules it keeps (design section 2.5):
//! - every wait goes through `Env::sleep_until`, every server command and store
//!   is preceded by `Env::yield_to_foreground`, and a failed `Env::save` stops
//!   the run before anything else is sent;
//! - persist order in a batch: store, verify, mirror, then `deleting` (intent),
//!   then the server command, then `deleted` / `trash_pending`, then `emptied`;
//! - nothing unverified is deleted (I1), nothing verified is downloaded twice
//!   (I2), every delete batch re-verifies each file by exact path (I3), a
//!   persisted intent is reconciled with the server before anything is sent
//!   again (R4), a changed UIDVALIDITY stops deletes in that folder (I5), only
//!   the exact Trash uids a job moved are expunged (I6), and backup mode never
//!   deletes without a verified mirror copy (I7).

use super::ops::{Control, Env, Fetched, FolderInfo, ListedMsg, LocalError, LocalStore, OpsError, ServerOps, StoreOutcome};
use super::plan::{estimate_days, scoped_folders, AllMailMap, FolderPlan, GmIndex, PlanStore, PreviewListing, Selection};
use super::state::*;
use super::uidset::UidSet;
use crate::transfer_limits::{day_key, next_utc_midnight_ms};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

/// Messages per download batch (the hoarder's batch), then the state is saved.
pub const BATCH: usize = 25;
/// Uids per `UID MOVE`.
pub const DELETE_BATCH: usize = 200;
/// Rest between two download batches.
pub const PACE_MS: i64 = 2_000;
pub const PROVIDER_LIMIT_WAIT_MS: i64 = 60 * 60 * 1000;
pub const MIDNIGHT_SLACK_MS: i64 = 60_000;
pub const BACKOFF_BASE_MS: i64 = 30_000;
pub const BACKOFF_MAX_MS: i64 = 15 * 60_000;
pub const TOO_MANY_BASE_MS: i64 = 2 * 60_000;
pub const OFFLINE_POLL_MS: i64 = 60_000;
/// A connection is given back before any wait longer than this.
pub const RELEASE_AFTER_MS: i64 = 30_000;
/// Failures (not throttling) before a message is left on the server.
pub const MAX_FAILURES: u8 = 3;
/// Message-IDs asked for per command at plan freeze.
pub const ID_CHUNK: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunExit {
    Completed,
    Cancelled,
    Paused(PauseReason),
    Failed(String),
}

struct Stop {
    exit: RunExit,
    /// Write the resulting status. False for a failed save: writing again
    /// would fail the same way, and the last good state is what resumes.
    persist: bool,
}
type Flow<T> = Result<T, Stop>;

fn stop(exit: RunExit) -> Stop {
    Stop { exit, persist: true }
}
fn unsaved(msg: String) -> Stop {
    Stop { exit: RunExit::Failed(msg), persist: false }
}
fn paused(r: PauseReason) -> Stop {
    stop(RunExit::Paused(r))
}

enum React {
    Retry,
    Gone,
    Other(String),
}

/// What the server says about a folder's generation against the one the plan
/// was made under (I5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Validity {
    Same,
    Changed,
    /// Could not be read (an error, no UIDVALIDITY in the reply, or a folder
    /// planned without one). Never "unchanged": nothing is deleted on it.
    Unknown,
}

/// Reads of an unreadable UIDVALIDITY before a delete step gives up on it.
const VALIDITY_TRIES: u32 = 3;

/// Numbers the frame needs that the job file does not hold.
#[derive(Default, Clone, Debug)]
pub struct FrameInfo {
    pub provider_limit_since_ms: Option<i64>,
    pub daily_limit: Option<u64>,
    pub allowance_left: Option<u64>,
    pub remaining_bytes: Option<u64>,
    pub current_folder: Option<String>,
}

fn reason_name(r: KeptReason) -> String {
    serde_json::to_value(r).ok().and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default()
}

/// The `abd-progress` frame (design 6.6). Built in one place so the shape is
/// tested once; the daemon only emits it.
pub fn progress_frame(job: &JobFile, info: &FrameInfo) -> Value {
    let (mut scoped, mut scoped_bytes, mut stored, mut vault, mut drive) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut deleted, mut emptied, mut kept, mut downloaded) = (0u64, 0u64, 0u64, 0u64);
    let mut by_reason: BTreeMap<String, u64> = BTreeMap::new();
    let mut stale: Vec<String> = Vec::new();
    for f in &job.folders {
        scoped += f.scoped;
        scoped_bytes += f.scoped_bytes;
        stored += f.stored.len();
        vault += f.vault_ok.len();
        drive += f.mirror_ok.len();
        deleted += f.deleted.len();
        emptied += f.emptied.len();
        downloaded += f.downloaded_bytes;
        for (r, s) in &f.kept {
            kept += s.len();
            *by_reason.entry(reason_name(*r)).or_insert(0) += s.len();
        }
        if f.stale {
            stale.push(f.path.clone());
        }
    }
    let remaining = info.remaining_bytes.unwrap_or_else(|| scoped_bytes.saturating_sub(downloaded));
    let days = estimate_days(remaining, info.allowance_left, info.daily_limit);
    let finished = job.status.is_finished();
    let outcome = match &job.status {
        JobStatus::Completed => Value::String("completed".to_string()),
        JobStatus::Cancelled => Value::String("cancelled".to_string()),
        JobStatus::Failed { .. } => Value::String("failed".to_string()),
        _ => Value::Null,
    };
    let error = match &job.status {
        JobStatus::Failed { error } => Value::String(error.clone()),
        _ => Value::Null,
    };
    json!({
        "jobId": job.job_id,
        "accountId": job.account_id,
        "accountEmail": job.account_email,
        "mode": job.mode,
        "timing": job.timing,
        "deleteMode": job.delete_mode,
        "provider": job.provider,
        "status": job.status,
        "counts": {
            "scoped": scoped,
            "scopedBytes": scoped_bytes,
            "stored": stored,
            "vaultVerified": vault,
            "onDrive": drive,
            "deleted": deleted,
            "emptied": emptied,
            "kept": kept,
            "keptByReason": by_reason,
        },
        "downloadedBytes": downloaded,
        "remainingBytes": remaining,
        "daysLeft": days,
        "dailyLimitBytes": info.daily_limit,
        "currentFolder": info.current_folder,
        "staleFolders": stale,
        "providerLimitSinceMs": info.provider_limit_since_ms,
        "finished": finished,
        "outcome": outcome,
        "error": error,
        "updatedMs": job.updated_ms,
    })
}

/// One deletion: the message the command names, and every scoped copy that
/// goes with it (Gmail: each ticked label folder holding it).
struct Unit {
    via_uid: u32,
    msg: ListedMsg,
    copies: Vec<(usize, u32)>,
}

fn expected_ids(plan: &FolderPlan, uids: &[u32]) -> HashMap<u32, String> {
    let mut m = HashMap::new();
    for &u in uids {
        if let Some(k) = plan.index_of(u) {
            if let Some(id) = &plan.message_ids[k] {
                m.insert(u, id.clone());
            }
        }
    }
    m
}

/// Whether the plan knows the message's Message-ID (the proof a vault file
/// is checked against).
fn has_planned_id(plan: &FolderPlan, uid: u32) -> bool {
    plan.index_of(uid).map_or(false, |k| plan.message_ids[k].is_some())
}

fn kept_reason(fs: &FolderState, uid: u32) -> Option<KeptReason> {
    fs.kept.iter().find(|(_, s)| s.contains(uid)).map(|(r, _)| *r)
}

fn backoff_ms(base: i64, n: u32) -> i64 {
    base.saturating_mul(1i64 << n.min(20)).min(BACKOFF_MAX_MS)
}

/// A server call that waits out throttling, offline and provider limits and
/// retries; `Err(None)` is "gone", `Err(Some(text))` is an ordinary failure.
macro_rules! server_call {
    ($s:expr, $call:expr) => {{
        loop {
            $s.prelude().await?;
            match $call {
                Ok(v) => {
                    $s.ok();
                    break Ok(v);
                }
                Err(e) => match $s.react(e).await? {
                    React::Retry => continue,
                    React::Gone => break Err(None),
                    React::Other(t) => break Err(Some(t)),
                },
            }
        }
    }};
}

struct Engine<'a, S: ServerOps, L: LocalStore, E: Env> {
    job: &'a mut JobFile,
    plans: &'a PlanStore,
    ops: &'a mut S,
    local: &'a L,
    env: &'a E,
    ctl: &'a Control,
    /// Per-folder archived listing, read once per run (I3: no directory read
    /// per batch). The engine adds every path it stores.
    listings: HashMap<usize, HashMap<u32, PathBuf>>,
    gm: GmIndex,
    allmail_rev: HashMap<u32, u64>,
    trash_pairs: HashMap<(usize, u32), u32>,
    backoff_n: u32,
    provider_limit_since: Option<i64>,
    remaining_bytes: u64,
    phase: Phase,
    current_folder: Option<String>,
    trash_info: Option<FolderInfo>,
    planned: Vec<(String, FolderPlan)>,
    planned_allmail: Option<AllMailMap>,
    /// Vault files this run wrote, or found byte for byte what the server
    /// sent: the only proof a message without a Message-ID has (E1).
    proven: HashSet<(usize, u32)>,
    /// Per folder, this run: whether the vault's recorded generation is the
    /// plan's UIDVALIDITY, so a file already on disk may be adopted by uid.
    gen_ok: HashMap<usize, bool>,
}

impl<'a, S: ServerOps, L: LocalStore, E: Env> Engine<'a, S, L, E> {
    fn new(
        job: &'a mut JobFile,
        plans: &'a PlanStore,
        ops: &'a mut S,
        local: &'a L,
        env: &'a E,
        ctl: &'a Control,
    ) -> Self {
        Engine {
            job,
            plans,
            ops,
            local,
            env,
            ctl,
            listings: HashMap::new(),
            gm: GmIndex::default(),
            allmail_rev: HashMap::new(),
            trash_pairs: HashMap::new(),
            backoff_n: 0,
            provider_limit_since: None,
            remaining_bytes: 0,
            phase: Phase::Download,
            current_folder: None,
            trash_info: None,
            planned: Vec::new(),
            planned_allmail: None,
            proven: HashSet::new(),
            gen_ok: HashMap::new(),
        }
    }

    // ── plumbing ────────────────────────────────────────────────────────────

    fn plan_ref(&self, i: usize) -> Option<&'a FolderPlan> {
        let plans: &'a PlanStore = self.plans;
        plans.get(&self.job.folders[i].plan_file)
    }

    fn plan(&self, i: usize) -> Flow<&'a FolderPlan> {
        self.plan_ref(i).ok_or_else(|| {
            stop(RunExit::Failed(format!("plan file {} is missing", self.job.folders[i].plan_file)))
        })
    }

    fn note_error(&mut self, text: &str) {
        self.job.last_error = Some(text.chars().take(300).collect());
    }

    fn frame_info(&self) -> FrameInfo {
        FrameInfo {
            provider_limit_since_ms: self.provider_limit_since,
            daily_limit: self.env.daily_limit(),
            allowance_left: self.allowance_now(),
            remaining_bytes: Some(self.remaining_bytes),
            current_folder: self.current_folder.clone(),
        }
    }

    fn emit(&self) {
        let info = self.frame_info();
        self.env.emit(&progress_frame(&*self.job, &info));
    }

    /// Save the job (a failed save stops the run) and tell the app.
    fn checkpoint(&mut self) -> Flow<()> {
        self.job.updated_ms = self.env.now_ms();
        self.env.save(&*self.job).map_err(|e| unsaved(format!("could not save the job: {e}")))?;
        self.emit();
        Ok(())
    }

    fn set_running(&mut self, phase: Phase) {
        self.phase = phase;
        self.job.status = JobStatus::Running { phase };
    }

    /// A step went well: forget the backoff and the provider-limit mark.
    fn ok(&mut self) {
        self.backoff_n = 0;
        self.provider_limit_since = None;
    }

    /// Cancel, pause and credentials, checked before every unit of work. A
    /// user pause waits here (same task) until resumed or cancelled.
    async fn gate(&mut self) -> Flow<()> {
        loop {
            if self.ctl.cancel.load(Ordering::SeqCst) {
                return Err(stop(RunExit::Cancelled));
            }
            if self.ctl.pause.load(Ordering::SeqCst) {
                self.ops.release().await;
                self.job.status = JobStatus::Paused { reason: PauseReason::User };
                self.checkpoint()?;
                self.ctl.wake.notified().await;
                continue;
            }
            break;
        }
        if matches!(self.job.status, JobStatus::Paused { .. } | JobStatus::Waiting { .. }) {
            self.job.status = JobStatus::Running { phase: self.phase };
        }
        if !self.env.has_credentials() {
            return Err(paused(PauseReason::SignInNeeded));
        }
        Ok(())
    }

    /// Everything that touches the server or stores a file starts here.
    async fn prelude(&mut self) -> Flow<()> {
        self.gate().await?;
        self.env.yield_to_foreground().await;
        Ok(())
    }

    async fn wait(&mut self, reason: WaitReason, until_ms: i64) -> Flow<()> {
        let now = self.env.now_ms();
        if until_ms - now > RELEASE_AFTER_MS {
            self.ops.release().await;
        }
        self.job.status = JobStatus::Waiting { reason, until_ms: Some(until_ms) };
        self.checkpoint()?;
        self.env.sleep_until(until_ms, self.ctl).await;
        self.job.status = JobStatus::Running { phase: self.phase };
        Ok(())
    }

    async fn pace(&mut self) {
        let until = self.env.now_ms() + PACE_MS;
        self.env.sleep_until(until, self.ctl).await;
    }

    async fn react(&mut self, e: OpsError) -> Flow<React> {
        let now = self.env.now_ms();
        match e {
            OpsError::ProviderLimit(t) => {
                self.note_error(&t);
                if self.provider_limit_since.is_none() {
                    self.provider_limit_since = Some(now);
                }
                self.wait(WaitReason::ProviderLimit, now + PROVIDER_LIMIT_WAIT_MS).await?;
                Ok(React::Retry)
            }
            OpsError::Throttled { retry_after_secs, text } => {
                self.note_error(&text);
                let mut d = backoff_ms(BACKOFF_BASE_MS, self.backoff_n);
                if let Some(s) = retry_after_secs {
                    d = d.max((s as i64).saturating_mul(1000));
                }
                self.backoff_n = self.backoff_n.saturating_add(1);
                self.wait(WaitReason::Throttled, now + d).await?;
                Ok(React::Retry)
            }
            OpsError::TooManyConnections(t) => {
                self.note_error(&t);
                let d = backoff_ms(TOO_MANY_BASE_MS, self.backoff_n);
                self.backoff_n = self.backoff_n.saturating_add(1);
                self.wait(WaitReason::Throttled, now + d).await?;
                Ok(React::Retry)
            }
            OpsError::Offline(t) => {
                self.note_error(&t);
                self.wait(WaitReason::Offline, now + OFFLINE_POLL_MS).await?;
                Ok(React::Retry)
            }
            OpsError::SignIn(t) => {
                self.note_error(&t);
                Err(paused(PauseReason::SignInNeeded))
            }
            OpsError::Gone => Ok(React::Gone),
            OpsError::Other(t) | OpsError::ValidityChanged(t) => {
                self.note_error(&t);
                Ok(React::Other(t))
            }
        }
    }

    fn map_local<T>(&mut self, r: Result<T, LocalError>) -> Flow<Result<T, String>> {
        match r {
            Ok(v) => Ok(Ok(v)),
            Err(LocalError::VaultUnavailable(t)) => {
                self.note_error(&t);
                Err(paused(PauseReason::VaultUnavailable))
            }
            Err(LocalError::DriveUnavailable(t)) => {
                self.note_error(&t);
                Err(paused(PauseReason::DriveUnavailable))
            }
            Err(LocalError::Io(t)) => Ok(Err(t)),
        }
    }

    // ── the daily allowance ─────────────────────────────────────────────────

    /// Bytes left today. Graph bodies are not wire-counted, so the job's own
    /// per-UTC-day tally is subtracted.
    fn allowance_now(&self) -> Option<u64> {
        let left = self.env.allowance_left()?;
        let today = day_key(self.env.now_ms());
        let used = self.job.graph_tally.as_ref().filter(|t| t.day == today).map(|t| t.bytes).unwrap_or(0);
        Some(left.saturating_sub(used))
    }

    async fn wait_for_allowance(&mut self, size: u32) -> Flow<()> {
        loop {
            let left = match self.allowance_now() {
                Some(l) => l,
                None => return Ok(()),
            };
            let mut need = (size as u64).max(1);
            if let Some(limit) = self.env.daily_limit() {
                if limit > 0 {
                    // A message bigger than the whole day still goes on a fresh day.
                    need = need.min(limit);
                }
            }
            if left >= need {
                return Ok(());
            }
            let until = next_utc_midnight_ms(self.env.now_ms()) + MIDNIGHT_SLACK_MS;
            self.wait(WaitReason::DailyLimit, until).await?;
            self.gate().await?;
        }
    }

    fn count_bytes(&mut self, i: usize, n: u64) {
        self.job.folders[i].downloaded_bytes += n;
        let extra = self.ops.uncounted_bytes();
        if extra > 0 {
            let today = day_key(self.env.now_ms());
            let t = self.job.graph_tally.get_or_insert_with(DayTally::default);
            if t.day != today {
                t.day = today;
                t.bytes = 0;
            }
            t.bytes += extra;
        }
    }

    // ── per-uid bookkeeping ─────────────────────────────────────────────────

    fn size_of(&self, i: usize, uid: u32) -> u64 {
        match self.plan_ref(i) {
            Some(p) => p.index_of(uid).map(|k| p.sizes[k] as u64).unwrap_or(0),
            None => 0,
        }
    }

    fn mark_vault_ok(&mut self, i: usize, uid: u32) {
        if !self.job.folders[i].vault_ok.contains(uid) {
            self.remaining_bytes = self.remaining_bytes.saturating_sub(self.size_of(i, uid));
            self.job.folders[i].vault_ok.insert(uid);
        }
        self.job.folders[i].failures.remove(&uid);
    }

    fn keep_uid(&mut self, i: usize, uid: u32, why: KeptReason) {
        if self.job.folders[i].is_kept(uid) {
            return;
        }
        if !self.job.folders[i].vault_ok.contains(uid) {
            self.remaining_bytes = self.remaining_bytes.saturating_sub(self.size_of(i, uid));
        }
        self.job.folders[i].keep(uid, why);
    }

    /// One failure for `uid`; at `MAX_FAILURES` it is left on the server.
    fn fail(&mut self, i: usize, uid: u32, reason: KeptReason) {
        let n = {
            let e = self.job.folders[i].failures.entry(uid).or_insert(0);
            *e = e.saturating_add(1);
            *e
        };
        if n >= MAX_FAILURES {
            self.keep_uid(i, uid, reason);
        }
    }

    fn copy_ready(&self, i: usize, u: u32) -> bool {
        let fs = &self.job.folders[i];
        let backup = self.job.mode == Mode::ArchiveBackupDelete;
        !fs.deleted.contains(u) && !fs.is_kept(u) && fs.vault_ok.contains(u) && (!backup || fs.mirror_ok.contains(u))
    }

    fn can_delete(&self) -> bool {
        self.trash_info.is_some()
            && (self.job.caps.move_cmd || self.job.caps.uidplus || self.job.provider == Provider::Graph)
    }

    fn can_empty(&self) -> bool {
        self.job.caps.uidplus || self.job.provider == Provider::Graph
    }

    fn is_gmail_route(&self, i: usize) -> bool {
        self.job.provider == Provider::Gmail
            && self.job.gmail.is_some()
            && matches!(self.job.folders[i].role, FolderRole::Normal | FolderRole::AllMail)
    }

    fn folder_info(&self, i: usize) -> Flow<FolderInfo> {
        let plan = self.plan(i)?;
        let fs = &self.job.folders[i];
        Ok(FolderInfo {
            path: fs.path.clone(),
            name: fs.path.clone(),
            role: fs.role,
            graph_id: plan.graph_folder_id.clone(),
            selectable: true,
        })
    }

    fn all_mail_info(&self) -> Option<FolderInfo> {
        self.job.gmail.as_ref().map(|g| FolderInfo {
            path: g.all_mail.clone(),
            name: g.all_mail.clone(),
            role: FolderRole::AllMail,
            graph_id: None,
            selectable: true,
        })
    }

    fn trash_folder(&self) -> Flow<FolderInfo> {
        self.trash_info.clone().ok_or_else(|| stop(RunExit::Failed("the account has no Trash folder".to_string())))
    }

    fn build_indexes(&mut self) -> Flow<()> {
        let mut refs: Vec<&FolderPlan> = Vec::new();
        for i in 0..self.job.folders.len() {
            refs.push(self.plan(i)?);
        }
        self.gm = GmIndex::build(&refs);
        if let Some(m) = self.plans.allmail() {
            self.allmail_rev = m.uids.iter().copied().zip(m.gm_msgids.iter().copied()).collect();
        }
        self.trash_info = self.job.trash.as_ref().map(|t| FolderInfo {
            path: t.path.clone(),
            name: t.path.clone(),
            role: FolderRole::Trash,
            graph_id: t.graph_id.clone(),
            selectable: true,
        });
        let mut remaining = 0u64;
        for (i, p) in refs.iter().enumerate() {
            let fs = &self.job.folders[i];
            for (k, &u) in p.uids.iter().enumerate() {
                if !fs.vault_ok.contains(u) && !fs.is_kept(u) {
                    remaining += p.sizes[k] as u64;
                }
            }
        }
        self.remaining_bytes = remaining;
        Ok(())
    }

    // ── local listings and verification ─────────────────────────────────────

    async fn ensure_listing(&mut self, i: usize) -> Flow<()> {
        if self.listings.contains_key(&i) {
            return Ok(());
        }
        self.gate().await?;
        let path = self.job.folders[i].path.clone();
        let r = self.local.archived_listing(&path).await;
        match self.map_local(r)? {
            Ok(l) => {
                self.listings.insert(i, l);
                Ok(())
            }
            Err(t) => {
                self.note_error(&t);
                Err(paused(PauseReason::VaultUnavailable))
            }
        }
    }

    async fn verify_vault_batch(&mut self, i: usize, plan: &'a FolderPlan, uids: &[u32]) -> Flow<()> {
        self.ensure_listing(i).await?;
        self.prelude().await?;
        let path = self.job.folders[i].path.clone();
        let expected = expected_ids(plan, uids);
        let r = self.local.verify_vault(&path, &self.listings[&i], uids, &expected).await;
        let v = match self.map_local(r)? {
            Ok(v) => v,
            Err(t) => {
                self.note_error(&t);
                return Err(paused(PauseReason::VaultUnavailable));
            }
        };
        let okset: HashSet<u32> = v.ok.iter().copied().collect();
        let badset: HashSet<u32> = v.mismatched.iter().copied().collect();
        for &u in uids {
            if okset.contains(&u) {
                // Without a Message-ID, presence proves nothing: only a file
                // this run wrote (or found byte for byte) counts.
                if has_planned_id(plan, u) || self.proven.contains(&(i, u)) {
                    self.mark_vault_ok(i, u);
                } else {
                    self.keep_uid(i, u, KeptReason::VaultMismatch);
                }
            } else if badset.contains(&u) {
                self.keep_uid(i, u, KeptReason::VaultMismatch);
            } else {
                self.job.folders[i].stored.remove(u);
                self.fail(i, u, KeptReason::VaultMissing);
            }
        }
        Ok(())
    }

    async fn mirror_batch(&mut self, i: usize, uids: &[u32]) -> Flow<()> {
        self.ensure_listing(i).await?;
        self.prelude().await?;
        let path = self.job.folders[i].path.clone();
        let r = self.local.mirror_copy_verify(&path, &self.listings[&i], uids).await;
        let v = match r {
            Ok(v) => v,
            Err(LocalError::VaultUnavailable(t)) => {
                self.note_error(&t);
                return Err(paused(PauseReason::VaultUnavailable));
            }
            // A mirror error never becomes a vault-only delete (I7).
            Err(LocalError::DriveUnavailable(t)) | Err(LocalError::Io(t)) => {
                self.note_error(&t);
                return Err(paused(PauseReason::DriveUnavailable));
            }
        };
        let okset: HashSet<u32> = v.ok.iter().copied().collect();
        let badset: HashSet<u32> = v.mismatched.iter().copied().collect();
        for &u in uids {
            if okset.contains(&u) {
                self.job.folders[i].mirror_ok.insert(u);
                self.job.folders[i].failures.remove(&u);
            } else if badset.contains(&u) {
                self.keep_uid(i, u, KeptReason::MirrorMismatch);
            } else {
                self.fail(i, u, KeptReason::MirrorMissing);
            }
        }
        Ok(())
    }

    /// I3: re-check each named copy against current disk (vault, and the
    /// drive in backup mode) right before a delete batch. Returns the copies
    /// that failed; those are already `kept`.
    async fn reverify(&mut self, checks: &[(usize, u32)]) -> Flow<HashSet<(usize, u32)>> {
        let mut failed: HashSet<(usize, u32)> = HashSet::new();
        let backup = self.job.mode == Mode::ArchiveBackupDelete;
        let mut by_folder: BTreeMap<usize, Vec<u32>> = BTreeMap::new();
        for &(j, u) in checks {
            by_folder.entry(j).or_default().push(u);
        }
        for (j, uids) in by_folder {
            let plan = self.plan(j)?;
            self.ensure_listing(j).await?;
            self.prelude().await?;
            let path = self.job.folders[j].path.clone();
            let expected = expected_ids(plan, &uids);
            let r = self.local.verify_vault(&path, &self.listings[&j], &uids, &expected).await;
            let v = match self.map_local(r)? {
                Ok(v) => v,
                Err(t) => {
                    self.note_error(&t);
                    return Err(paused(PauseReason::VaultUnavailable));
                }
            };
            let okset: HashSet<u32> = v.ok.iter().copied().collect();
            let badset: HashSet<u32> = v.mismatched.iter().copied().collect();
            let mut passed: Vec<u32> = Vec::new();
            for &u in &uids {
                if okset.contains(&u) {
                    passed.push(u);
                } else if badset.contains(&u) {
                    self.keep_uid(j, u, KeptReason::VaultMismatch);
                    failed.insert((j, u));
                } else {
                    self.keep_uid(j, u, KeptReason::VaultMissing);
                    failed.insert((j, u));
                }
            }
            if backup && !passed.is_empty() {
                let mut files: Vec<(u32, String)> = Vec::new();
                for &u in &passed {
                    let name = self.listings[&j]
                        .get(&u)
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string());
                    match name {
                        Some(n) => files.push((u, n)),
                        None => {
                            self.keep_uid(j, u, KeptReason::VaultMissing);
                            failed.insert((j, u));
                        }
                    }
                }
                self.prelude().await?;
                let r = self.local.mirror_verify_paths(&path, &files, &expected).await;
                let m = match r {
                    Ok(m) => m,
                    Err(LocalError::VaultUnavailable(t)) => {
                        self.note_error(&t);
                        return Err(paused(PauseReason::VaultUnavailable));
                    }
                    Err(LocalError::DriveUnavailable(t)) | Err(LocalError::Io(t)) => {
                        self.note_error(&t);
                        return Err(paused(PauseReason::DriveUnavailable));
                    }
                };
                let okm: HashSet<u32> = m.ok.iter().copied().collect();
                let badm: HashSet<u32> = m.mismatched.iter().copied().collect();
                for (u, _) in &files {
                    if okm.contains(u) {
                        continue;
                    }
                    if badm.contains(u) {
                        self.keep_uid(j, *u, KeptReason::MirrorMismatch);
                    } else {
                        self.keep_uid(j, *u, KeptReason::MirrorMissing);
                    }
                    failed.insert((j, *u));
                }
            }
        }
        Ok(failed)
    }

    // ── UIDVALIDITY (I5) ────────────────────────────────────────────────────

    /// The folder's generation now, against `recorded`. Graph has none and is
    /// always `Same`; an IMAP folder planned without one is `Unknown`. An
    /// error, "gone" and a reply without UIDVALIDITY are `Unknown`, never
    /// "unchanged".
    async fn read_validity(&mut self, folder: &FolderInfo, recorded: Option<u32>) -> Flow<Validity> {
        if self.job.provider == Provider::Graph {
            return Ok(Validity::Same);
        }
        let Some(recorded) = recorded else { return Ok(Validity::Unknown) };
        let r: Result<Option<u32>, Option<String>> = server_call!(self, self.ops.uid_validity(folder).await);
        Ok(match r {
            Ok(Some(cur)) if cur == recorded => Validity::Same,
            Ok(Some(_)) => Validity::Changed,
            _ => Validity::Unknown,
        })
    }

    /// `read_validity` before a destructive step: an unreadable answer is
    /// asked again, with a wait, before the step gives up on the folder.
    async fn validity_for_delete(&mut self, folder: &FolderInfo, recorded: Option<u32>) -> Flow<Validity> {
        let mut n = 0u32;
        loop {
            let v = self.read_validity(folder, recorded).await?;
            n += 1;
            if v != Validity::Unknown || recorded.is_none() || n >= VALIDITY_TRIES {
                return Ok(v);
            }
            let until = self.env.now_ms() + backoff_ms(BACKOFF_BASE_MS, n - 1);
            self.wait(WaitReason::Throttled, until).await?;
            self.gate().await?;
        }
    }

    /// The UIDVALIDITY a command in `via` must find, or `None` for Graph.
    fn expected_validity(&self, i: usize, via_path: &str) -> Option<u32> {
        if self.job.provider == Provider::Graph {
            return None;
        }
        match self.job.gmail.as_ref() {
            Some(g) if g.all_mail == via_path => Some(g.all_mail_validity),
            _ => self.job.folders[i].uid_validity,
        }
    }

    /// The folder stops deleting: every uid not yet deleted is left on the server.
    fn mark_stale(&mut self, i: usize) {
        let plan = match self.plan_ref(i) {
            Some(p) => p,
            None => return,
        };
        self.job.folders[i].stale = true;
        self.job.folders[i].deleting = None;
        for &u in &plan.uids {
            if !self.job.folders[i].deleted.contains(u) {
                self.keep_uid(i, u, KeptReason::ServerChanged);
            }
        }
    }

    /// Every folder whose deletes go through All Mail stops deleting.
    fn mark_gmail_stale(&mut self) {
        for idx in 0..self.job.folders.len() {
            if self.is_gmail_route(idx) {
                self.mark_stale(idx);
            }
        }
    }

    /// Before a download pass: false (and the folder is left alone) only when
    /// the server says the folder was reissued. An unreadable answer does not
    /// stop the download; it stops the delete (`delete_validity`).
    async fn check_validity(&mut self, i: usize) -> Flow<bool> {
        if self.job.folders[i].stale {
            return Ok(false);
        }
        if self.job.provider == Provider::Graph || self.job.folders[i].uid_validity.is_none() {
            return Ok(true);
        }
        let folder = self.folder_info(i)?;
        let recorded = self.job.folders[i].uid_validity;
        if self.read_validity(&folder, recorded).await? == Validity::Changed {
            self.mark_stale(i);
            self.checkpoint()?;
            return Ok(false);
        }
        Ok(true)
    }

    /// Before a delete in folder `i`: true only when the folder is provably
    /// the one the plan was made from. A change, or a generation that cannot
    /// be read after `VALIDITY_TRIES`, stops deletes in the folder (I5).
    async fn delete_validity(&mut self, i: usize) -> Flow<bool> {
        if self.job.folders[i].stale {
            return Ok(false);
        }
        let folder = self.folder_info(i)?;
        let recorded = self.job.folders[i].uid_validity;
        match self.validity_for_delete(&folder, recorded).await? {
            Validity::Same => Ok(true),
            Validity::Changed | Validity::Unknown => {
                self.mark_stale(i);
                self.checkpoint()?;
                Ok(false)
            }
        }
    }

    async fn all_mail_delete_validity(&mut self) -> Flow<bool> {
        let (info, recorded) = match (self.all_mail_info(), self.job.gmail.as_ref()) {
            (Some(info), Some(g)) => (info, g.all_mail_validity),
            _ => return Ok(true),
        };
        match self.validity_for_delete(&info, Some(recorded)).await? {
            Validity::Same => Ok(true),
            Validity::Changed | Validity::Unknown => {
                self.mark_gmail_stale();
                self.checkpoint()?;
                Ok(false)
            }
        }
    }

    /// Whether a vault file already on disk may stand for the planned message
    /// by its uid: the vault folder's recorded generation is the plan's
    /// UIDVALIDITY. Graph uids come from the job's own ledger (by Graph id),
    /// so they need no generation. Read once per folder per run.
    async fn vault_gen_ok(&mut self, i: usize) -> Flow<bool> {
        if let Some(b) = self.gen_ok.get(&i) {
            return Ok(*b);
        }
        let ok = if self.job.provider == Provider::Graph {
            true
        } else {
            match self.job.folders[i].uid_validity {
                None => false,
                Some(v) => {
                    self.gate().await?;
                    let path = self.job.folders[i].path.clone();
                    let r = self.local.vault_generation(&path).await;
                    match self.map_local(r)? {
                        Ok(g) => g == Some(v),
                        Err(t) => {
                            self.note_error(&t);
                            false
                        }
                    }
                }
            }
        };
        self.gen_ok.insert(i, ok);
        Ok(ok)
    }

    // ── downloading ─────────────────────────────────────────────────────────

    fn next_batch(&self, i: usize, plan: &FolderPlan, cursor: &mut usize) -> Vec<u32> {
        let fs = &self.job.folders[i];
        let backup = self.job.mode == Mode::ArchiveBackupDelete;
        let mut out: Vec<u32> = Vec::new();
        while *cursor < plan.uids.len() && out.len() < BATCH {
            let u = plan.uids[*cursor];
            *cursor += 1;
            if fs.deleted.contains(u) || fs.is_kept(u) {
                continue;
            }
            if fs.vault_ok.contains(u) && (!backup || fs.mirror_ok.contains(u)) {
                continue;
            }
            out.push(u);
        }
        out
    }

    async fn get_message(&mut self, i: usize, plan: &'a FolderPlan, k: usize, folder: &FolderInfo) -> Flow<Option<Fetched>> {
        let msg = plan.listed(k);
        loop {
            self.wait_for_allowance(msg.size).await?;
            self.prelude().await?;
            match self.ops.fetch(folder, &msg).await {
                Ok(f) => {
                    self.ok();
                    self.count_bytes(i, f.raw.len() as u64);
                    return Ok(Some(f));
                }
                Err(e) => match self.react(e).await? {
                    React::Retry => continue,
                    React::Gone => {
                        self.keep_uid(i, msg.uid, KeptReason::ServerChanged);
                        return Ok(None);
                    }
                    React::Other(_) => {
                        self.fail(i, msg.uid, KeptReason::DownloadFailed);
                        return Ok(None);
                    }
                },
            }
        }
    }

    /// A Gmail message already saved from another label folder is copied
    /// locally instead of downloaded again; verification still checks the
    /// planned Message-ID, so a wrong sibling cannot pass.
    async fn try_sibling(&mut self, i: usize, plan: &'a FolderPlan, k: usize) -> Flow<Option<Fetched>> {
        if self.job.provider != Provider::Gmail {
            return Ok(None);
        }
        let gm = match plan.gm_msgids.as_ref().map(|g| g[k]) {
            Some(g) => g,
            None => return Ok(None),
        };
        let size = plan.sizes[k];
        let mut found: Option<(usize, u32)> = None;
        for &(j, u) in self.gm.copies(gm) {
            if j == i || !self.job.folders[j].vault_ok.contains(u) {
                continue;
            }
            let pj = match self.plan_ref(j) {
                Some(p) => p,
                None => continue,
            };
            if pj.index_of(u).map(|kk| pj.sizes[kk]) != Some(size) {
                continue;
            }
            found = Some((j, u));
            break;
        }
        let (j, u) = match found {
            Some(x) => x,
            None => return Ok(None),
        };
        self.ensure_listing(j).await?;
        let path = match self.listings[&j].get(&u) {
            Some(p) => p.clone(),
            None => return Ok(None),
        };
        self.prelude().await?;
        let r = self.local.read_file(&path).await;
        match self.map_local(r)? {
            Ok(raw) => Ok(Some(Fetched {
                raw,
                flags: Vec::new(),
                internal_ms: Some(plan.internal_ms[k]),
                message_id: plan.message_ids[k].clone(),
            })),
            Err(_) => Ok(None),
        }
    }

    async fn download_one(&mut self, i: usize, plan: &'a FolderPlan, k: usize, folder: &FolderInfo) -> Flow<()> {
        let uid = plan.uids[k];
        let fetched = match self.try_sibling(i, plan, k).await? {
            Some(f) => f,
            None => match self.get_message(i, plan, k, folder).await? {
                Some(f) => f,
                None => return Ok(()),
            },
        };
        self.prelude().await?;
        let r = self.local.store_archived(&folder.path, uid, fetched).await;
        match self.map_local(r)? {
            Ok(st) => {
                let accept = match st.outcome {
                    StoreOutcome::Wrote | StoreOutcome::FoundSame => {
                        self.proven.insert((i, uid));
                        true
                    }
                    // Another file already holds the uid. Only its Message-ID,
                    // under the plan's own generation, can say it is this message.
                    StoreOutcome::FoundDifferent => has_planned_id(plan, uid) && self.vault_gen_ok(i).await?,
                };
                if accept {
                    self.listings.entry(i).or_default().insert(uid, st.path);
                    self.job.folders[i].stored.insert(uid);
                } else {
                    self.keep_uid(i, uid, KeptReason::VaultMismatch);
                }
            }
            Err(t) => {
                self.note_error(&t);
                self.fail(i, uid, KeptReason::DownloadFailed);
            }
        }
        Ok(())
    }

    async fn process_batch(&mut self, i: usize, plan: &'a FolderPlan, batch: &[u32]) -> Flow<()> {
        let folder = self.folder_info(i)?;
        let backup = self.job.mode == Mode::ArchiveBackupDelete;
        self.ensure_listing(i).await?;
        for &uid in batch {
            self.gate().await?;
            let with_id = has_planned_id(plan, uid);
            let skip = {
                let fs = &self.job.folders[i];
                // A message without a Message-ID stored by an earlier run is
                // stored again: only this run's own write proves its file.
                fs.is_kept(uid)
                    || fs.vault_ok.contains(uid)
                    || (fs.stored.contains(uid) && (with_id || self.proven.contains(&(i, uid))))
            };
            if skip {
                continue;
            }
            // An archived copy already on disk (a kill between the store and
            // the save) is verified, not downloaded again (I2): only with a
            // Message-ID to check it against, and only under the plan's own
            // generation, since a uid of another generation names other mail.
            let on_disk = self.listings.get(&i).map_or(false, |l| l.contains_key(&uid));
            if on_disk && with_id && self.vault_gen_ok(i).await? {
                self.job.folders[i].stored.insert(uid);
                continue;
            }
            if let Some(k) = plan.index_of(uid) {
                self.download_one(i, plan, k, &folder).await?;
            }
        }
        let to_verify: Vec<u32> = {
            let fs = &self.job.folders[i];
            batch.iter().copied().filter(|&u| fs.stored.contains(u) && !fs.vault_ok.contains(u) && !fs.is_kept(u)).collect()
        };
        if !to_verify.is_empty() {
            self.verify_vault_batch(i, plan, &to_verify).await?;
        }
        if backup {
            let to_mirror: Vec<u32> = {
                let fs = &self.job.folders[i];
                batch.iter().copied().filter(|&u| fs.vault_ok.contains(u) && !fs.mirror_ok.contains(u) && !fs.is_kept(u)).collect()
            };
            if !to_mirror.is_empty() {
                self.mirror_batch(i, &to_mirror).await?;
            }
        }
        self.checkpoint()
    }

    async fn folder_pass(&mut self, i: usize) -> Flow<()> {
        if self.job.folders[i].stale {
            return Ok(());
        }
        self.current_folder = Some(self.job.folders[i].path.clone());
        if !self.check_validity(i).await? {
            return Ok(());
        }
        let plan = self.plan(i)?;
        let mut sweeps = 0;
        loop {
            sweeps += 1;
            let mut cursor = 0usize;
            let mut progressed = false;
            loop {
                let batch = self.next_batch(i, plan, &mut cursor);
                if batch.is_empty() {
                    break;
                }
                progressed = true;
                self.process_batch(i, plan, &batch).await?;
                if self.job.timing == Timing::AsSaved && !self.job.folders[i].stale {
                    self.delete_eligible(i, &batch).await?;
                    self.set_running(Phase::Download);
                }
                if cursor < plan.uids.len() {
                    self.pace().await;
                }
            }
            if !progressed || sweeps >= 6 {
                break;
            }
        }
        Ok(())
    }

    // ── deleting ────────────────────────────────────────────────────────────

    /// Delete what is ready among `candidates` of folder `i`, in batches, each
    /// re-verified first.
    async fn delete_eligible(&mut self, i: usize, candidates: &[u32]) -> Flow<()> {
        if self.job.folders[i].stale {
            return Ok(());
        }
        let ready: Vec<u32> = candidates.iter().copied().filter(|&u| self.copy_ready(i, u)).collect();
        if ready.is_empty() {
            return Ok(());
        }
        let empty_mode = self.job.delete_mode == DeleteMode::MoveToTrashAndEmpty;
        if !self.can_delete() {
            for u in ready {
                self.keep_uid(i, u, KeptReason::CannotDelete);
            }
            return self.checkpoint();
        }
        if self.job.folders[i].role == FolderRole::Trash {
            if !empty_mode {
                for u in ready {
                    self.keep_uid(i, u, KeptReason::AlreadyInTrash);
                }
                return self.checkpoint();
            }
            return self.empty_trash_folder(i, ready).await;
        }
        self.set_running(Phase::Delete);
        let gmail = self.is_gmail_route(i);
        let mut deferred: HashSet<u32> = HashSet::new();
        loop {
            if self.job.folders[i].stale {
                break;
            }
            let pending: Vec<u32> =
                ready.iter().copied().filter(|&u| self.copy_ready(i, u) && !deferred.contains(&u)).collect();
            if pending.is_empty() {
                break;
            }
            if gmail {
                let (units, def) = self.gmail_units(i, &pending, DELETE_BATCH)?;
                deferred.extend(def);
                if units.is_empty() {
                    continue;
                }
                let via = match self.all_mail_info() {
                    Some(v) => v,
                    None => return Err(stop(RunExit::Failed("Gmail job without an All Mail folder".to_string()))),
                };
                self.delete_units(i, via, units).await?;
            } else {
                let plan = self.plan(i)?;
                let mut units: Vec<Unit> = Vec::new();
                for &u in pending.iter().take(DELETE_BATCH) {
                    if let Some(k) = plan.index_of(u) {
                        units.push(Unit { via_uid: u, msg: plan.listed(k), copies: vec![(i, u)] });
                    }
                }
                let via = self.folder_info(i)?;
                self.delete_units(i, via, units).await?;
            }
        }
        if empty_mode {
            self.empty_pending(i).await?;
        }
        Ok(())
    }

    /// Group Gmail label-folder messages by `X-GM-MSGID`. A message is a unit
    /// only when every scoped copy is ready; a copy that is kept blocks the
    /// rest (they are kept for the same reason); otherwise it waits.
    fn gmail_units(&mut self, i: usize, pending: &[u32], limit: usize) -> Flow<(Vec<Unit>, Vec<u32>)> {
        let plan = self.plan(i)?;
        let mut units: Vec<Unit> = Vec::new();
        let mut deferred: Vec<u32> = Vec::new();
        let mut seen: HashSet<u64> = HashSet::new();
        for &u in pending {
            if units.len() >= limit {
                break;
            }
            let k = match plan.index_of(u) {
                Some(k) => k,
                None => {
                    deferred.push(u);
                    continue;
                }
            };
            let gm = match plan.gm_msgids.as_ref().map(|g| g[k]) {
                Some(g) => g,
                None => {
                    self.keep_uid(i, u, KeptReason::NoAllMailCopy);
                    continue;
                }
            };
            if seen.contains(&gm) {
                continue;
            }
            let copies: Vec<(usize, u32)> = self.gm.copies(gm).to_vec();
            let via_uid = match self.plans.allmail().and_then(|m| m.uid_for(gm)) {
                Some(v) => v,
                None => {
                    for (j, uu) in copies {
                        self.keep_uid(j, uu, KeptReason::NoAllMailCopy);
                    }
                    continue;
                }
            };
            let mut blocked: Option<KeptReason> = None;
            let mut not_ready = false;
            for &(j, uu) in &copies {
                let fs = &self.job.folders[j];
                if fs.deleted.contains(uu) {
                    continue;
                }
                if let Some(r) = kept_reason(fs, uu) {
                    if blocked.is_none() {
                        blocked = Some(r);
                    }
                } else if !self.copy_ready(j, uu) {
                    not_ready = true;
                }
            }
            if let Some(r) = blocked {
                for &(j, uu) in &copies {
                    if !self.job.folders[j].deleted.contains(uu) {
                        self.keep_uid(j, uu, r);
                    }
                }
                continue;
            }
            if not_ready {
                deferred.push(u);
                continue;
            }
            seen.insert(gm);
            let mut msg = plan.listed(k);
            msg.uid = via_uid;
            units.push(Unit { via_uid, msg, copies });
        }
        Ok((units, deferred))
    }

    /// Re-verify, persist the intent, send one MOVE, record the outcome.
    async fn delete_units(&mut self, i: usize, via: FolderInfo, units: Vec<Unit>) -> Flow<()> {
        // An intent nobody reconciled yet is never overwritten by a new one.
        if self.job.folders[i].deleting.is_some() {
            self.recover(i).await?;
            if self.job.folders[i].deleting.is_some() {
                return Ok(());
            }
        }
        if !self.delete_validity(i).await? {
            return Ok(());
        }
        if self.is_gmail_route(i) && !self.all_mail_delete_validity().await? {
            return Ok(());
        }
        let mut checks: Vec<(usize, u32)> = Vec::new();
        for u in &units {
            for c in &u.copies {
                if !checks.contains(c) {
                    checks.push(*c);
                }
            }
        }
        let failed = self.reverify(&checks).await?;
        let units: Vec<Unit> =
            units.into_iter().filter(|u| !u.copies.iter().any(|c| failed.contains(c))).collect();
        if units.is_empty() {
            return self.checkpoint();
        }
        let trash = self.trash_folder()?;
        let mut intent = DeleteBatch {
            uids: UidSet::new(),
            via: via.path.clone(),
            via_uids: UidSet::new(),
            started_ms: self.env.now_ms(),
        };
        for u in &units {
            intent.via_uids.insert(u.via_uid);
            for &(j, uu) in &u.copies {
                if j == i {
                    intent.uids.insert(uu);
                }
            }
        }
        // The intent is durable before the command leaves (I4).
        self.job.folders[i].deleting = Some(intent);
        self.set_running(Phase::Delete);
        self.checkpoint()?;
        let msgs: Vec<ListedMsg> = units.iter().map(|u| u.msg.clone()).collect();
        // Checked again by the MOVE's own SELECT: a reissue between the check
        // above and the command refuses it before anything is sent (I5).
        let validity = self.expected_validity(i, &via.path);
        self.prelude().await?;
        match self.ops.move_to_trash(&via, &msgs, &trash, validity).await {
            Ok(mr) => {
                self.ok();
                let moved: HashSet<u32> = mr.moved.iter().copied().collect();
                let mut pairs: HashMap<u32, u32> = HashMap::new();
                if let Some(t) = &mr.trash_uids {
                    if t.len() == mr.moved.len() {
                        for (a, b) in mr.moved.iter().zip(t.iter()) {
                            pairs.insert(*a, *b);
                        }
                    }
                }
                let mut items: Vec<(u32, Vec<(usize, u32)>)> = Vec::new();
                let mut not_moved: Vec<u32> = Vec::new();
                for u in &units {
                    if moved.contains(&u.via_uid) {
                        items.push((u.via_uid, u.copies.clone()));
                    } else {
                        for &(j, uu) in &u.copies {
                            if j == i {
                                not_moved.push(uu);
                            }
                        }
                    }
                }
                for uu in not_moved {
                    self.fail(i, uu, KeptReason::CannotDelete);
                }
                let graph_ids: Option<Vec<String>> =
                    mr.graph_new_ids.as_ref().map(|v| v.iter().map(|(_, id)| id.clone()).collect());
                let touched = self.apply_deleted(i, &items, &pairs, mr.trash_validity, graph_ids, &via.path);
                self.checkpoint()?;
                for (path, uids) in touched {
                    self.local.deleted_from_server(&path, &uids).await;
                }
                Ok(())
            }
            Err(OpsError::ValidityChanged(t)) => {
                // Refused before anything was sent: no intent to reconcile.
                self.note_error(&t);
                if via.path == self.job.folders[i].path {
                    self.mark_stale(i);
                } else {
                    self.mark_gmail_stale();
                }
                self.job.folders[i].deleting = None;
                self.checkpoint()
            }
            Err(e) => match self.react(e).await? {
                React::Retry => self.recover(i).await,
                React::Gone | React::Other(_) => {
                    let mine: Vec<u32> = units
                        .iter()
                        .flat_map(|u| u.copies.iter().filter(|c| c.0 == i).map(|c| c.1).collect::<Vec<u32>>())
                        .collect();
                    for uu in mine {
                        self.fail(i, uu, KeptReason::CannotDelete);
                    }
                    self.recover(i).await
                }
            },
        }
    }

    /// Record uids confirmed gone from the server. Returns (folder path, uids)
    /// for the header-cache hook.
    fn apply_deleted(
        &mut self,
        i: usize,
        items: &[(u32, Vec<(usize, u32)>)],
        pairs: &HashMap<u32, u32>,
        trash_validity: Option<u32>,
        graph_ids: Option<Vec<String>>,
        via_path: &str,
    ) -> Vec<(String, Vec<u32>)> {
        let empty_mode = self.job.delete_mode == DeleteMode::MoveToTrashAndEmpty;
        let mut touched: BTreeMap<usize, Vec<u32>> = BTreeMap::new();
        let mut src = UidSet::new();
        let mut trash_set = UidSet::new();
        let mut all_known = true;
        let mut via_deleted: Vec<u32> = Vec::new();
        for (via_uid, copies) in items {
            via_deleted.push(*via_uid);
            for &(j, u) in copies {
                self.job.folders[j].deleted.insert(u);
                self.job.folders[j].failures.remove(&u);
                touched.entry(j).or_default().push(u);
                if j == i {
                    src.insert(u);
                    match pairs.get(via_uid) {
                        Some(t) => {
                            self.trash_pairs.insert((i, u), *t);
                            trash_set.insert(*t);
                        }
                        None => all_known = false,
                    }
                }
            }
        }
        let via_is_all_mail = self.job.gmail.as_ref().map_or(false, |g| g.all_mail == via_path);
        if via_is_all_mail {
            if let Some(g) = self.job.gmail.as_mut() {
                for v in &via_deleted {
                    g.gm_deleted.insert(*v);
                }
            }
        }
        self.job.folders[i].deleting = None;
        if empty_mode && !src.is_empty() {
            self.job.folders[i].trash_pending.push(TrashBatch {
                src,
                trash_uids: if all_known && !trash_set.is_empty() { Some(trash_set) } else { None },
                trash_validity,
                graph_trash_ids: graph_ids,
            });
        }
        let mut out: Vec<(String, Vec<u32>)> = Vec::new();
        let mut paths: HashSet<String> = HashSet::new();
        for (j, uids) in touched {
            let p = self.job.folders[j].path.clone();
            paths.insert(p.clone());
            out.push((p, uids));
        }
        if via_is_all_mail && !paths.contains(via_path) && !via_deleted.is_empty() {
            out.push((via_path.to_string(), via_deleted));
        }
        out
    }

    fn copies_of_via(&self, i: usize, via_path: &str, via_uid: u32) -> Vec<(usize, u32)> {
        let via_is_all_mail = self.job.gmail.as_ref().map_or(false, |g| g.all_mail == via_path);
        if via_is_all_mail && self.job.provider == Provider::Gmail {
            match self.allmail_rev.get(&via_uid) {
                Some(gm) => self.gm.copies(*gm).to_vec(),
                None => Vec::new(),
            }
        } else {
            vec![(i, via_uid)]
        }
    }

    /// R4: a persisted intent means the command may or may not have run.
    /// Ask the server what is still there before anything is sent again.
    async fn recover(&mut self, i: usize) -> Flow<()> {
        let batch = match self.job.folders[i].deleting.clone() {
            Some(b) => b,
            None => return Ok(()),
        };
        let own_path = self.job.folders[i].path.clone();
        // `present` in another generation answers about other messages, and a
        // uid read as gone would be recorded deleted (and, emptying, looked
        // for in Trash by Message-ID). A folder whose generation is changed or
        // unreadable stops deleting instead; nothing is recorded (I5, I6).
        let via = if batch.via == own_path {
            if !self.delete_validity(i).await? {
                self.job.folders[i].deleting = None;
                return self.checkpoint();
            }
            self.folder_info(i)?
        } else {
            if !self.all_mail_delete_validity().await? {
                self.job.folders[i].deleting = None;
                return self.checkpoint();
            }
            match self.all_mail_info() {
                Some(v) => v,
                None => {
                    self.job.folders[i].deleting = None;
                    return self.checkpoint();
                }
            }
        };
        let via_uids: Vec<u32> = batch.via_uids.iter().collect();
        let r: Result<Vec<u32>, Option<String>> = server_call!(self, self.ops.present(&via, &via_uids).await);
        // If the server cannot say, assume everything is still there: the
        // next MOVE of an already-moved uid fails harmlessly.
        let present: HashSet<u32> = match r {
            Ok(p) => p.into_iter().collect(),
            Err(_) => via_uids.iter().copied().collect(),
        };
        let mut items: Vec<(u32, Vec<(usize, u32)>)> = Vec::new();
        for v in via_uids {
            if !present.contains(&v) {
                items.push((v, self.copies_of_via(i, &batch.via, v)));
            }
        }
        let touched = self.apply_deleted(i, &items, &HashMap::new(), None, None, &batch.via);
        self.checkpoint()?;
        for (path, uids) in touched {
            self.local.deleted_from_server(&path, &uids).await;
        }
        Ok(())
    }

    // ── emptying the Trash (exact uids only, I6) ────────────────────────────

    fn mark_emptied(&mut self, i: usize, u: u32) {
        self.job.folders[i].emptied.insert(u);
        self.job.folders[i].deleted.insert(u);
        if !self.is_gmail_route(i) {
            return;
        }
        let gm = self.plan_ref(i).and_then(|p| p.index_of(u).and_then(|k| p.gm_msgids.as_ref().map(|g| g[k])));
        if let Some(gm) = gm {
            for (j, uu) in self.gm.copies(gm).to_vec() {
                if j != i {
                    self.job.folders[j].emptied.insert(uu);
                }
            }
        }
    }

    async fn empty_trash_folder(&mut self, i: usize, ready: Vec<u32>) -> Flow<()> {
        if !self.delete_validity(i).await? {
            return Ok(());
        }
        let checks: Vec<(usize, u32)> = ready.iter().map(|&u| (i, u)).collect();
        let failed = self.reverify(&checks).await?;
        let ok: Vec<u32> = ready.into_iter().filter(|u| !failed.contains(&(i, *u))).collect();
        if ok.is_empty() {
            return self.checkpoint();
        }
        for chunk in ok.chunks(DELETE_BATCH) {
            let mut src = UidSet::new();
            src.extend(chunk.iter().copied());
            for &u in chunk {
                self.trash_pairs.insert((i, u), u);
            }
            // The uids are the Trash folder's own, under the plan's generation.
            let trash_validity = self.job.folders[i].uid_validity;
            self.job.folders[i].trash_pending.push(TrashBatch {
                src: src.clone(),
                trash_uids: Some(src),
                trash_validity,
                graph_trash_ids: None,
            });
        }
        self.checkpoint()?;
        self.empty_pending(i).await
    }

    async fn empty_pending(&mut self, i: usize) -> Flow<()> {
        let batches = self.job.folders[i].trash_pending.clone();
        for tb in batches {
            self.empty_batch(i, &tb).await?;
            if !self.job.folders[i].trash_pending.is_empty() {
                self.job.folders[i].trash_pending.remove(0);
            }
            self.checkpoint()?;
        }
        Ok(())
    }

    async fn empty_batch(&mut self, i: usize, tb: &TrashBatch) -> Flow<()> {
        let plan = self.plan(i)?;
        let src: Vec<u32> = tb.src.iter().collect();
        if !self.can_empty() || self.trash_info.is_none() {
            for u in src {
                self.keep_uid(i, u, KeptReason::NotEmptied);
            }
            return Ok(());
        }
        let trash = self.trash_folder()?;
        self.set_running(Phase::Empty);
        // The Trash generation every uid below is read in, and the one the
        // expunge's own SELECT must find. Unreadable, or not the one the move
        // recorded: nothing is emptied (I5, I6).
        let trash_validity: Option<u32> = if self.job.provider == Provider::Graph {
            None
        } else {
            let mut cur: Option<u32> = None;
            for n in 0..VALIDITY_TRIES {
                if n > 0 {
                    let until = self.env.now_ms() + backoff_ms(BACKOFF_BASE_MS, n - 1);
                    self.wait(WaitReason::Throttled, until).await?;
                    self.gate().await?;
                }
                let r: Result<Option<u32>, Option<String>> = server_call!(self, self.ops.uid_validity(&trash).await);
                if let Ok(Some(v)) = r {
                    cur = Some(v);
                    break;
                }
            }
            let usable = match (cur, tb.trash_validity) {
                (None, _) => false,
                (Some(c), Some(recorded)) => c == recorded,
                (Some(_), None) => true,
            };
            if !usable {
                for u in src {
                    self.keep_uid(i, u, KeptReason::NotEmptied);
                }
                return Ok(());
            }
            cur
        };
        // Pair each source uid with its Trash uid: exact pairs from this run,
        // else the sorted COPYUID pairing (plain folders), else look it up.
        let sorted_trash: Option<Vec<u32>> = if self.is_gmail_route(i) {
            None
        } else {
            tb.trash_uids.as_ref().filter(|t| t.len() == tb.src.len()).map(|t| t.iter().collect())
        };
        let mut known: Vec<(u32, u32)> = Vec::new();
        let mut unknown: Vec<u32> = Vec::new();
        for (n, &u) in src.iter().enumerate() {
            if let Some(t) = self.trash_pairs.get(&(i, u)) {
                known.push((u, *t));
            } else if let Some(st) = &sorted_trash {
                known.push((u, st[n]));
            } else {
                unknown.push(u);
            }
        }
        let id_of = |u: u32| -> Option<String> {
            plan.index_of(u).and_then(|k| plan.message_ids[k].clone())
        };
        if !unknown.is_empty() {
            let mut ids: Vec<String> = Vec::new();
            let mut pairs_id: Vec<(u32, String)> = Vec::new();
            for &u in &unknown {
                match id_of(u) {
                    Some(id) => {
                        if !ids.contains(&id) {
                            ids.push(id.clone());
                        }
                        pairs_id.push((u, id));
                    }
                    None => self.keep_uid(i, u, KeptReason::NotEmptied),
                }
            }
            if !ids.is_empty() {
                let r: Result<Vec<(String, u32)>, Option<String>> =
                    server_call!(self, self.ops.find_in_trash(&trash, &ids).await);
                match r {
                    Ok(found) => {
                        let mut by_id: HashMap<String, Vec<u32>> = HashMap::new();
                        for (id, tu) in found {
                            by_id.entry(id).or_default().push(tu);
                        }
                        for (u, id) in pairs_id {
                            match by_id.get(&id).map(|v| v.as_slice()) {
                                Some([t]) => known.push((u, *t)),
                                // Ambiguous: an older Trash copy shares the id.
                                Some(_) => self.keep_uid(i, u, KeptReason::NotEmptied),
                                // Not in Trash any more: nothing left to empty.
                                None => self.mark_emptied(i, u),
                            }
                        }
                    }
                    Err(_) => {
                        for (u, _) in pairs_id {
                            self.keep_uid(i, u, KeptReason::NotEmptied);
                        }
                    }
                }
            }
        }
        if known.is_empty() {
            return Ok(());
        }
        let mut tuids: Vec<u32> = known.iter().map(|k| k.1).collect();
        tuids.sort_unstable();
        tuids.dedup();
        let r: Result<Vec<u32>, Option<String>> = server_call!(self, self.ops.present(&trash, &tuids).await);
        let present: HashSet<u32> = match r {
            Ok(p) => p.into_iter().collect(),
            Err(_) => tuids.iter().copied().collect(),
        };
        let mut still: Vec<(u32, u32)> = Vec::new();
        for (u, t) in known {
            if present.contains(&t) {
                still.push((u, t));
            } else {
                self.mark_emptied(i, u);
            }
        }
        if still.is_empty() {
            return Ok(());
        }
        let mut expect: Vec<(u32, String)> = Vec::new();
        let mut with_id: Vec<(u32, u32)> = Vec::new();
        for (u, t) in still {
            match id_of(u) {
                Some(id) => {
                    if !expect.iter().any(|e| e.0 == t) {
                        expect.push((t, id));
                    }
                    with_id.push((u, t));
                }
                None => self.keep_uid(i, u, KeptReason::NotEmptied),
            }
        }
        if with_id.is_empty() {
            return Ok(());
        }
        let exp_uids: Vec<u32> = expect.iter().map(|e| e.0).collect();
        let r: Result<Vec<u32>, Option<String>> =
            server_call!(self, self.ops.expunge_exact(&trash, &exp_uids, &expect, trash_validity).await);
        match r {
            Ok(done) => {
                let done: HashSet<u32> = done.into_iter().collect();
                for (u, t) in with_id {
                    if done.contains(&t) {
                        self.mark_emptied(i, u);
                    } else {
                        self.keep_uid(i, u, KeptReason::NotEmptied);
                    }
                }
            }
            Err(_) => {
                for (u, _) in with_id {
                    self.keep_uid(i, u, KeptReason::NotEmptied);
                }
            }
        }
        Ok(())
    }

    // ── the run ─────────────────────────────────────────────────────────────

    async fn drive(&mut self) -> Flow<()> {
        self.build_indexes()?;
        self.set_running(Phase::Download);
        self.checkpoint()?;
        let n = self.job.folders.len();
        for i in 0..n {
            if self.job.folders[i].deleting.is_some() {
                self.recover(i).await?;
            }
        }
        for i in 0..n {
            if !self.job.folders[i].trash_pending.is_empty() {
                self.empty_pending(i).await?;
            }
        }
        for i in 0..n {
            self.folder_pass(i).await?;
        }
        self.set_running(Phase::Delete);
        for i in 0..n {
            let all: Vec<u32> = self.plan(i)?.uids.clone();
            self.delete_eligible(i, &all).await?;
        }
        for i in 0..n {
            self.empty_pending(i).await?;
        }
        Ok(())
    }

    /// Turn a stop into a persisted status and the exit the caller sees.
    fn settle(&mut self, s: Stop) -> RunExit {
        if s.persist {
            let now = self.env.now_ms();
            match &s.exit {
                RunExit::Cancelled => {
                    self.job.status = JobStatus::Cancelled;
                    self.job.finished_ms = Some(now);
                }
                RunExit::Failed(e) => {
                    self.job.status = JobStatus::Failed { error: e.clone() };
                    self.job.finished_ms = Some(now);
                }
                RunExit::Paused(r) => {
                    self.job.status = JobStatus::Paused { reason: *r };
                }
                RunExit::Completed => {}
            }
            self.job.updated_ms = now;
            let _ = self.env.save(&*self.job);
            self.emit();
        }
        s.exit
    }

    fn finish_ok(&mut self) -> RunExit {
        let now = self.env.now_ms();
        self.job.status = JobStatus::Completed;
        self.job.finished_ms = Some(now);
        self.job.updated_ms = now;
        match self.env.save(&*self.job) {
            Ok(()) => {
                self.emit();
                RunExit::Completed
            }
            Err(e) => RunExit::Failed(format!("could not save the job: {e}")),
        }
    }

    // ── planning ────────────────────────────────────────────────────────────

    async fn plan_inner(&mut self, preview: &PreviewListing) -> Flow<()> {
        self.gate().await?;
        self.job.provider = preview.provider;
        self.job.caps = ServerCaps {
            uidplus: preview.caps.uidplus,
            move_cmd: preview.caps.move_cmd,
            gmail_ext: preview.caps.gmail_ext,
        };
        self.job.trash = preview.trash.as_ref().map(|t| TrashInfo {
            path: t.path.clone(),
            uid_validity: None,
            graph_id: t.graph_id.clone(),
        });
        let sel = Selection {
            folders: self.job.scope.folders.clone(),
            dates: self.job.scope.dates.clone(),
            year_bounds: self.job.scope.year_bounds.clone(),
            mode: self.job.mode,
            delete_mode: self.job.delete_mode,
        };
        let scoped = scoped_folders(preview, &sel);
        let all_mail_ticked = scoped.iter().any(|f| f.is_all_mail);
        let gmail = preview.provider == Provider::Gmail && preview.all_mail.is_some();
        self.job.gmail = if gmail {
            preview.all_mail.as_ref().map(|(info, v, _)| GmailInfo {
                all_mail: info.path.clone(),
                all_mail_validity: *v,
                all_mail_ticked,
                gm_deleted: UidSet::new(),
            })
        } else {
            None
        };

        let mut states: Vec<FolderState> = Vec::new();
        let mut plan_out: Vec<(String, FolderPlan)> = Vec::new();
        let mut wanted_gm: HashSet<u64> = HashSet::new();

        for (idx, sf) in scoped.iter().enumerate() {
            self.gate().await?;
            let info: FolderInfo = sf.info.clone();
            let mut rows: Vec<ListedMsg> = sf.msgs.iter().map(|m| (*m).clone()).collect();

            if preview.provider == Provider::Graph {
                let listed: Vec<(String, Option<String>)> =
                    rows.iter().map(|m| (m.graph_id.clone().unwrap_or_default(), m.message_id.clone())).collect();
                let r = self.local.graph_uids(&info.path, &listed).await;
                match self.map_local(r)? {
                    Ok(uids) if uids.len() == rows.len() => {
                        for (m, u) in rows.iter_mut().zip(uids) {
                            m.uid = u;
                        }
                    }
                    Ok(_) => {
                        return Err(stop(RunExit::Failed("the uid ledger returned the wrong number of uids".to_string())))
                    }
                    Err(t) => {
                        self.note_error(&t);
                        return Err(paused(PauseReason::VaultUnavailable));
                    }
                }
            }
            rows.sort_by_key(|m| m.uid);
            if rows.windows(2).any(|w| w[0].uid == w[1].uid) {
                return Err(stop(RunExit::Failed(format!("duplicate uids in {}", info.path))));
            }

            if preview.provider != Provider::Graph {
                let need: Vec<u32> = rows.iter().filter(|m| m.message_id.is_none()).map(|m| m.uid).collect();
                let mut got: HashMap<u32, Option<String>> = HashMap::new();
                for chunk in need.chunks(ID_CHUNK) {
                    // The listing costs allowance like any other download.
                    self.wait_for_allowance(1).await?;
                    let r: Result<Vec<(u32, Option<String>)>, Option<String>> =
                        server_call!(self, self.ops.message_ids(&info, chunk).await);
                    match r {
                        Ok(v) => {
                            for (u, id) in v {
                                got.insert(u, id);
                            }
                        }
                        Err(_) => {
                            return Err(stop(RunExit::Failed(format!(
                                "could not read the Message-IDs of {}",
                                info.path
                            ))))
                        }
                    }
                }
                // A uid the server did not answer never becomes "has no
                // Message-ID": ask once more, then drop the ones that are gone
                // from the folder (nothing to archive or delete) and fail the
                // plan on any that are still there.
                let mut unanswered: Vec<u32> = need.iter().copied().filter(|u| !got.contains_key(u)).collect();
                if !unanswered.is_empty() {
                    let r: Result<Vec<(u32, Option<String>)>, Option<String>> =
                        server_call!(self, self.ops.message_ids(&info, &unanswered).await);
                    if let Ok(v) = r {
                        for (u, id) in v {
                            got.insert(u, id);
                        }
                    }
                    unanswered.retain(|u| !got.contains_key(u));
                }
                if !unanswered.is_empty() {
                    let r: Result<Vec<u32>, Option<String>> =
                        server_call!(self, self.ops.present(&info, &unanswered).await);
                    let still: HashSet<u32> = match r {
                        Ok(p) => p.into_iter().collect(),
                        Err(_) => unanswered.iter().copied().collect(),
                    };
                    if !still.is_empty() {
                        return Err(stop(RunExit::Failed(format!(
                            "could not read the Message-IDs of {}: the server did not answer for {} messages. Start the job again.",
                            info.path,
                            still.len()
                        ))));
                    }
                    let gone: HashSet<u32> = unanswered.iter().copied().collect();
                    rows.retain(|m| !gone.contains(&m.uid));
                }
                for m in rows.iter_mut() {
                    if m.message_id.is_none() {
                        m.message_id = got.get(&m.uid).cloned().flatten();
                    }
                }
            }
            for m in rows.iter_mut() {
                m.message_id = m
                    .message_id
                    .take()
                    .map(|s| crate::maildir::normalize_message_id(&s))
                    .filter(|s| !s.is_empty());
            }

            let mut gm_col: Vec<u64> = Vec::new();
            if gmail {
                for m in &rows {
                    match m.gm_msgid {
                        Some(g) => {
                            gm_col.push(g);
                            wanted_gm.insert(g);
                        }
                        None => {
                            return Err(stop(RunExit::Failed(format!(
                                "a Gmail message in {} has no X-GM-MSGID",
                                info.path
                            ))))
                        }
                    }
                }
            }
            let plan = FolderPlan {
                version: 1,
                path: info.path.clone(),
                graph_folder_id: info.graph_id.clone(),
                uid_validity: sf.uid_validity,
                uids: rows.iter().map(|m| m.uid).collect(),
                internal_ms: rows.iter().map(|m| m.internal_ms).collect(),
                sizes: rows.iter().map(|m| m.size).collect(),
                message_ids: rows.iter().map(|m| m.message_id.clone()).collect(),
                gm_msgids: if gmail { Some(gm_col) } else { None },
                graph_ids: if preview.provider == Provider::Graph {
                    Some(rows.iter().map(|m| m.graph_id.clone().unwrap_or_default()).collect())
                } else {
                    None
                },
            };
            plan.check().map_err(|e| stop(RunExit::Failed(e)))?;
            let mut fs = FolderState {
                path: info.path.clone(),
                role: if sf.is_all_mail { FolderRole::AllMail } else { info.role },
                plan_file: plan_file_name(idx),
                uid_validity: sf.uid_validity,
                scoped: rows.len() as u64,
                scoped_bytes: rows.iter().map(|m| m.size as u64).sum(),
                ..Default::default()
            };

            // I2: an archived copy already in the vault with the right
            // Message-ID counts as saved without a download: only when the
            // vault folder is keyed under this plan's generation (a uid of
            // another generation names other mail) and only against a
            // Message-ID (a file is no proof of a message that has none).
            self.gate().await?;
            let r = self.local.archived_listing(&info.path).await;
            let listing = match self.map_local(r)? {
                Ok(l) => l,
                Err(t) => {
                    self.note_error(&t);
                    return Err(paused(PauseReason::VaultUnavailable));
                }
            };
            let gen_ok = if preview.provider == Provider::Graph {
                true
            } else if let Some(v) = sf.uid_validity {
                let r = self.local.vault_generation(&info.path).await;
                match self.map_local(r)? {
                    Ok(g) => g == Some(v),
                    Err(t) => {
                        self.note_error(&t);
                        false
                    }
                }
            } else {
                false
            };
            let cand: Vec<u32> = if gen_ok {
                plan.uids.iter().copied().filter(|u| listing.contains_key(u) && has_planned_id(&plan, *u)).collect()
            } else {
                Vec::new()
            };
            if !cand.is_empty() {
                let expected = expected_ids(&plan, &cand);
                let r = self.local.verify_vault(&info.path, &listing, &cand, &expected).await;
                let v = match self.map_local(r)? {
                    Ok(v) => v,
                    Err(t) => {
                        self.note_error(&t);
                        return Err(paused(PauseReason::VaultUnavailable));
                    }
                };
                for u in v.ok {
                    fs.stored.insert(u);
                    fs.vault_ok.insert(u);
                }
                for u in v.mismatched {
                    fs.keep(u, KeptReason::VaultMismatch);
                }
            }
            states.push(fs);
            plan_out.push((plan_file_name(idx), plan));
        }

        let allmail = if gmail {
            preview.all_mail.as_ref().map(|(info, v, msgs)| {
                let pairs: Vec<(u64, u32)> = msgs
                    .iter()
                    .filter_map(|m| m.gm_msgid.filter(|g| wanted_gm.contains(g)).map(|g| (g, m.uid)))
                    .collect();
                AllMailMap::from_pairs(&info.path, *v, pairs)
            })
        } else {
            None
        };

        // Plan files first: no job.json may name a file that is not on disk.
        for (name, plan) in &plan_out {
            self.env.save_plan(name, plan).map_err(|e| unsaved(format!("could not save the plan: {e}")))?;
        }
        if let Some(m) = &allmail {
            self.env.save_allmail(m).map_err(|e| unsaved(format!("could not save the plan: {e}")))?;
        }
        self.job.folders = states;
        self.set_running(Phase::Download);
        self.checkpoint()?;
        self.planned = plan_out;
        self.planned_allmail = allmail;
        Ok(())
    }
}

/// Freeze the plan from a preview listing: Message-IDs, the Gmail All Mail
/// map, plan files, folder rows, already-archived detection (I2). Plan files
/// are saved through the `Env` before the job file names them. Returns
/// `Completed` when the plan is frozen and stored in `plans`.
pub async fn plan_job<S: ServerOps, L: LocalStore, E: Env>(
    job: &mut JobFile,
    preview: &PreviewListing,
    plans: &mut PlanStore,
    ops: &mut S,
    local: &L,
    env: &E,
    ctl: &Control,
) -> RunExit {
    let empty = PlanStore::new();
    let (exit, planned, allmail) = {
        let mut eng = Engine::new(job, &empty, ops, local, env, ctl);
        let res = eng.plan_inner(preview).await;
        let out = match res {
            Ok(()) => (RunExit::Completed, std::mem::take(&mut eng.planned), eng.planned_allmail.take()),
            Err(s) => (eng.settle(s), Vec::new(), None),
        };
        out
    };
    if exit == RunExit::Completed {
        for (name, plan) in planned {
            plans.insert(&name, plan);
        }
        plans.set_allmail(allmail);
    }
    exit
}

/// Drive the job to an exit. Waits (limits, throttle, offline) and a user
/// pause happen INSIDE and do not return; pauses that need something from
/// outside (a token, the drive, the vault) return so the worker can wait for
/// it and call `run` again.
pub async fn run<S: ServerOps, L: LocalStore, E: Env>(
    job: &mut JobFile,
    plans: &PlanStore,
    ops: &mut S,
    local: &L,
    env: &E,
    ctl: &Control,
) -> RunExit {
    match &job.status {
        JobStatus::Completed => return RunExit::Completed,
        JobStatus::Cancelled => return RunExit::Cancelled,
        JobStatus::Failed { error } => return RunExit::Failed(error.clone()),
        JobStatus::Planning if job.folders.is_empty() => {
            return RunExit::Failed("the job has not been planned".to_string())
        }
        _ => {}
    }
    let mut eng = Engine::new(job, plans, ops, local, env, ctl);
    match eng.drive().await {
        Ok(()) => eng.finish_ok(),
        Err(s) => eng.settle(s),
    }
}
