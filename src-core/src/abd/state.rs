//! Persistent job state: the types in `<app_dir>/abd/<account_id>/job.json`
//! and the helpers that read and write them.
//!
//! Rules: every write is atomic (`fsx::write_atomic`, temp name starts with
//! `.`), the loader opens exact names only, and "unknown is not empty": a file
//! that fails to parse is an error the caller reports, never a fresh job.

use super::plan::{AllMailMap, FolderPlan};
use super::uidset::UidSet;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const JOB_VERSION: u32 = 1;
pub const JOB_FILE: &str = "job.json";
pub const ALLMAIL_FILE: &str = "allmail.json";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    ArchiveBackupDelete,
    ArchiveDelete,
}
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Timing {
    AfterAll,
    AsSaved,
}
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum DeleteMode {
    MoveToTrash,
    MoveToTrashAndEmpty,
}
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Imap,
    Gmail,
    Graph,
}
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum FolderRole {
    #[default]
    Normal,
    AllMail,
    Spam,
    Trash,
}

/// One calendar year in the USER's zone, computed by the app. `[start, end)`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YearBounds {
    pub year: i32,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DateScope {
    All,
    /// "This year" = {since: start of this year}; "Older than 2 years" = {before: Jan 1 of year-2}.
    Range { since_ms: Option<i64>, before_ms: Option<i64> },
    /// "Last year" = [year-1]; "Choose years" = the picked list.
    Years { years: Vec<i32> },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// Ticked server paths / Graph storage keys.
    pub folders: Vec<String>,
    pub dates: DateScope,
    /// "all"|"this_year"|"last_year"|"older_than_2"|"years" (UI echo).
    pub date_choice: String,
    /// Covers every year the listing holds.
    pub year_bounds: Vec<YearBounds>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Download,
    Delete,
    Empty,
}
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason {
    DailyLimit,
    ProviderLimit,
    Throttled,
    Offline,
    Keychain,
}
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    User,
    SignInNeeded,
    DriveUnavailable,
    VaultUnavailable,
    AccountMissing,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum JobStatus {
    Planning,
    Running { phase: Phase },
    /// Resumes by itself at `until_ms` (or on a wake).
    Waiting { reason: WaitReason, until_ms: Option<i64> },
    /// Resumes on the user's Resume, or when the missing thing arrives.
    Paused { reason: PauseReason },
    Cancelled,
    Completed,
    Failed { error: String },
}

impl JobStatus {
    pub fn is_finished(&self) -> bool {
        matches!(self, JobStatus::Cancelled | JobStatus::Completed | JobStatus::Failed { .. })
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "snake_case")]
pub enum KeptReason {
    /// 3 non-throttle failures.
    DownloadFailed,
    /// An archived copy at this uid holds another Message-ID.
    VaultMismatch,
    /// Re-verify before delete found no archived copy.
    VaultMissing,
    MirrorMismatch,
    MirrorMissing,
    /// UIDVALIDITY changed, or the message moved away.
    ServerChanged,
    /// Gmail: no All Mail copy found for this message.
    NoAllMailCopy,
    /// Trash folder in scope with "Move to Trash".
    AlreadyInTrash,
    /// Moved to Trash but could not be expunged exactly.
    NotEmptied,
    /// Server has neither MOVE nor UIDPLUS (or the move keeps failing).
    CannotDelete,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBatch {
    /// Source-folder uids this batch deletes.
    pub uids: UidSet,
    /// Folder the command runs in (same folder, or Gmail All Mail).
    pub via: String,
    /// Uids in `via` (== uids unless Gmail).
    pub via_uids: UidSet,
    pub started_ms: i64,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatch {
    /// Source uids (for the per-folder counters).
    pub src: UidSet,
    /// COPYUID destination set; None = unknown.
    pub trash_uids: Option<UidSet>,
    pub trash_validity: Option<u32>,
    /// Graph: ids the move returned.
    pub graph_trash_ids: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    pub path: String,
    pub role: FolderRole,
    /// "plan-003.json"
    pub plan_file: String,
    pub uid_validity: Option<u32>,
    pub scoped: u64,
    pub scoped_bytes: u64,
    /// An archived vault copy exists (written or found).
    pub stored: UidSet,
    /// Verified: A flag + Message-ID.
    pub vault_ok: UidSet,
    /// Verified on the drive (backup mode only).
    pub mirror_ok: UidSet,
    /// Intent, persisted BEFORE the server command.
    pub deleting: Option<DeleteBatch>,
    /// Confirmed gone from this folder.
    pub deleted: UidSet,
    pub trash_pending: Vec<TrashBatch>,
    pub emptied: UidSet,
    pub kept: BTreeMap<KeptReason, UidSet>,
    /// Only uids currently failing.
    pub failures: BTreeMap<u32, u8>,
    /// UIDVALIDITY changed: this folder deletes nothing.
    pub stale: bool,
    pub downloaded_bytes: u64,
}

impl FolderState {
    pub fn is_kept(&self, uid: u32) -> bool {
        self.kept.values().any(|s| s.contains(uid))
    }
    pub fn kept_count(&self) -> u64 {
        self.kept.values().map(|s| s.len()).sum()
    }
    pub fn keep(&mut self, uid: u32, why: KeptReason) {
        if !self.is_kept(uid) {
            self.kept.entry(why).or_default().insert(uid);
        }
        self.failures.remove(&uid);
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerCaps {
    pub uidplus: bool,
    pub move_cmd: bool,
    pub gmail_ext: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashInfo {
    pub path: String,
    pub uid_validity: Option<u32>,
    pub graph_id: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GmailInfo {
    pub all_mail: String,
    pub all_mail_validity: u32,
    pub all_mail_ticked: bool,
    /// All Mail uids moved to Trash.
    pub gm_deleted: UidSet,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayTally {
    /// UTC YYYY-MM-DD
    pub day: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobFile {
    pub version: u32,
    /// "abd-<account>-<created_ms>"
    pub job_id: String,
    pub account_id: String,
    pub account_email: String,
    pub host: String,
    pub provider: Provider,
    pub mode: Mode,
    pub timing: Timing,
    pub delete_mode: DeleteMode,
    pub scope: Scope,
    pub status: JobStatus,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub finished_ms: Option<i64>,
    pub caps: ServerCaps,
    pub trash: Option<TrashInfo>,
    pub gmail: Option<GmailInfo>,
    /// Processing order.
    pub folders: Vec<FolderState>,
    /// Graph only (bytes are not wire-counted).
    pub graph_tally: Option<DayTally>,
    /// Last mirrorRoot the shell handed over; a hint, never trusted for a delete.
    pub mirror_hint: Option<String>,
    /// Last per-message error text, redacted.
    pub last_error: Option<String>,
}

/// What a caller supplies to start a job; `JobFile::create` fills the rest.
pub struct NewJob {
    pub account_id: String,
    pub account_email: String,
    pub host: String,
    pub provider: Provider,
    pub mode: Mode,
    pub timing: Timing,
    pub delete_mode: DeleteMode,
    pub scope: Scope,
    pub now_ms: i64,
}

impl JobFile {
    /// A job in `Planning`, before `engine::plan_job` freezes its plan.
    pub fn create(n: NewJob) -> JobFile {
        JobFile {
            version: JOB_VERSION,
            job_id: format!("abd-{}-{}", n.account_id, n.now_ms),
            account_id: n.account_id,
            account_email: n.account_email,
            host: n.host,
            provider: n.provider,
            mode: n.mode,
            timing: n.timing,
            delete_mode: n.delete_mode,
            scope: n.scope,
            status: JobStatus::Planning,
            created_ms: n.now_ms,
            updated_ms: n.now_ms,
            finished_ms: None,
            caps: ServerCaps { uidplus: false, move_cmd: false, gmail_ext: false },
            trash: None,
            gmail: None,
            folders: Vec::new(),
            graph_tally: None,
            mirror_hint: None,
            last_error: None,
        }
    }
}

// ── Files ───────────────────────────────────────────────────────────────────

/// `<app_dir>/abd/<account_id>`, after checking the id is safe as a path part.
pub fn job_dir(app_dir: &Path, account_id: &str) -> Result<PathBuf, String> {
    let ok = !account_id.is_empty()
        && account_id.len() <= 80
        && account_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !ok {
        return Err(format!("invalid account id '{account_id}'"));
    }
    Ok(app_dir.join("abd").join(account_id))
}

/// `Ok(None)` when there is no `job.json`. A file that exists but cannot be
/// read or parsed is an `Err` and stays on disk: it never becomes a fresh job.
pub fn load_job(dir: &Path) -> Result<Option<JobFile>, String> {
    let path = dir.join(JOB_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("unreadable job file: {e}")),
    };
    let job: JobFile = serde_json::from_slice(&bytes).map_err(|e| format!("unreadable job file: {e}"))?;
    if job.version > JOB_VERSION {
        return Err(format!("unreadable job file: version {} is newer than this app", job.version));
    }
    Ok(Some(job))
}

pub fn save_job(dir: &Path, job: &JobFile) -> Result<(), String> {
    write_json(dir, JOB_FILE, job)
}

pub fn remove_job(dir: &Path) -> Result<bool, String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("could not remove the job files: {e}")),
    }
}

/// "plan-003.json"
pub fn plan_file_name(index: usize) -> String {
    format!("plan-{index:03}.json")
}

/// Exactly `plan-NNN.json` (three digits). A leftover temp file starts with a
/// dot and can never match.
pub fn is_plan_file_name(name: &str) -> bool {
    name.len() == 13
        && name.starts_with("plan-")
        && name.ends_with(".json")
        && name.as_bytes()[5..8].iter().all(|b| b.is_ascii_digit())
}

fn write_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| format!("could not encode {name}: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    crate::fsx::write_atomic(&dir.join(name), &bytes).map_err(|e| format!("could not write {name}: {e}"))
}

pub fn save_plan(dir: &Path, name: &str, plan: &FolderPlan) -> Result<(), String> {
    if !is_plan_file_name(name) {
        return Err(format!("bad plan file name '{name}'"));
    }
    plan.check()?;
    write_json(dir, name, plan)
}

/// Every `plan-NNN.json` in `dir`, by name. Columns of unequal length are an
/// error (a torn or hand-edited plan must not drive a delete).
pub fn load_plans(dir: &Path) -> Result<BTreeMap<String, FolderPlan>, String> {
    let mut out = BTreeMap::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };
    for entry in rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_plan_file_name(&name) {
            continue;
        }
        let bytes = std::fs::read(entry.path()).map_err(|e| format!("could not read {name}: {e}"))?;
        let plan: FolderPlan = serde_json::from_slice(&bytes).map_err(|e| format!("unreadable {name}: {e}"))?;
        plan.check().map_err(|e| format!("{name}: {e}"))?;
        out.insert(name, plan);
    }
    Ok(out)
}

pub fn save_allmail(dir: &Path, map: &AllMailMap) -> Result<(), String> {
    map.check()?;
    write_json(dir, ALLMAIL_FILE, map)
}

pub fn load_allmail(dir: &Path) -> Result<Option<AllMailMap>, String> {
    let bytes = match std::fs::read(dir.join(ALLMAIL_FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {ALLMAIL_FILE}: {e}")),
    };
    let m: AllMailMap = serde_json::from_slice(&bytes).map_err(|e| format!("unreadable {ALLMAIL_FILE}: {e}"))?;
    m.check()?;
    Ok(Some(m))
}
