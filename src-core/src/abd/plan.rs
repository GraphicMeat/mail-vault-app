//! Pure planning: scope, per-folder and per-year counts, the Gmail mapping, the
//! dry-run summary and the day estimate. Nothing here touches a server or a
//! disk except `daily_limit`, which reads Part A's settings.

use super::ops::{Caps, FolderInfo, ListedMsg};
use super::state::{DateScope, DeleteMode, FolderRole, Mode, Provider, YearBounds};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// Gmail cuts an account off near 2500 MB down a day whatever the user typed.
pub const GMAIL_DAILY_CAP_BYTES: u64 = 2500 * crate::transfer_limits::MB;

// ── Plan files ──────────────────────────────────────────────────────────────

/// One per scoped folder, written once when planning finishes. Columns have
/// equal length and hold ONLY scoped messages, ascending by uid.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderPlan {
    /// 1
    pub version: u32,
    /// IMAP path, or Graph storage key.
    pub path: String,
    pub graph_folder_id: Option<String>,
    /// IMAP; None for Graph.
    pub uid_validity: Option<u32>,
    pub uids: Vec<u32>,
    /// INTERNALDATE / receivedDateTime, UTC ms.
    pub internal_ms: Vec<i64>,
    /// RFC822.SIZE; Graph: PR_MESSAGE_SIZE or 0.
    pub sizes: Vec<u32>,
    /// Normalized (`maildir::normalize_message_id`).
    pub message_ids: Vec<Option<String>>,
    /// Gmail only.
    pub gm_msgids: Option<Vec<u64>>,
    /// Graph only.
    pub graph_ids: Option<Vec<String>>,
}

impl FolderPlan {
    pub fn len(&self) -> usize {
        self.uids.len()
    }

    /// Columns of equal length, uids strictly ascending.
    pub fn check(&self) -> Result<(), String> {
        let n = self.uids.len();
        let mut ok = self.internal_ms.len() == n && self.sizes.len() == n && self.message_ids.len() == n;
        if let Some(g) = &self.gm_msgids {
            ok &= g.len() == n;
        }
        if let Some(g) = &self.graph_ids {
            ok &= g.len() == n;
        }
        if !ok {
            return Err("plan columns have different lengths".to_string());
        }
        if self.uids.windows(2).any(|w| w[0] >= w[1]) {
            return Err("plan uids are not strictly ascending".to_string());
        }
        Ok(())
    }

    pub fn index_of(&self, uid: u32) -> Option<usize> {
        self.uids.binary_search(&uid).ok()
    }

    /// The listing row for the message at `k`.
    pub fn listed(&self, k: usize) -> ListedMsg {
        ListedMsg {
            uid: self.uids[k],
            internal_ms: self.internal_ms[k],
            size: self.sizes[k],
            gm_msgid: self.gm_msgids.as_ref().map(|g| g[k]),
            unlabelled: None,
            graph_id: self.graph_ids.as_ref().map(|g| g[k].clone()),
            message_id: self.message_ids[k].clone(),
        }
    }
}

/// Gmail only: `X-GM-MSGID` to All Mail uid for scoped messages.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllMailMap {
    pub version: u32,
    pub path: String,
    pub uid_validity: u32,
    /// Sorted ascending.
    pub gm_msgids: Vec<u64>,
    pub uids: Vec<u32>,
}

impl AllMailMap {
    pub fn check(&self) -> Result<(), String> {
        if self.gm_msgids.len() != self.uids.len() {
            return Err("all mail map columns have different lengths".to_string());
        }
        if self.gm_msgids.windows(2).any(|w| w[0] >= w[1]) {
            return Err("all mail map ids are not strictly ascending".to_string());
        }
        Ok(())
    }

    pub fn uid_for(&self, gm_msgid: u64) -> Option<u32> {
        self.gm_msgids.binary_search(&gm_msgid).ok().map(|k| self.uids[k])
    }

    pub fn gm_for_uid(&self, uid: u32) -> Option<u64> {
        self.uids.iter().position(|&u| u == uid).map(|k| self.gm_msgids[k])
    }

    /// Build from unsorted pairs.
    pub fn from_pairs(path: &str, uid_validity: u32, mut pairs: Vec<(u64, u32)>) -> AllMailMap {
        pairs.sort_unstable();
        pairs.dedup_by_key(|p| p.0);
        AllMailMap {
            version: 1,
            path: path.to_string(),
            uid_validity,
            gm_msgids: pairs.iter().map(|p| p.0).collect(),
            uids: pairs.iter().map(|p| p.1).collect(),
        }
    }
}

/// The frozen plan, held in memory for a run. Persistence is the `Env`'s job
/// (`save_plan`, `save_allmail`), so the engine never touches a disk.
#[derive(Default, Clone, Debug)]
pub struct PlanStore {
    plans: BTreeMap<String, FolderPlan>,
    allmail: Option<AllMailMap>,
}

impl PlanStore {
    pub fn new() -> PlanStore {
        PlanStore::default()
    }
    pub fn from_parts(plans: BTreeMap<String, FolderPlan>, allmail: Option<AllMailMap>) -> PlanStore {
        PlanStore { plans, allmail }
    }
    pub fn insert(&mut self, name: &str, plan: FolderPlan) {
        self.plans.insert(name.to_string(), plan);
    }
    pub fn get(&self, name: &str) -> Option<&FolderPlan> {
        self.plans.get(name)
    }
    pub fn set_allmail(&mut self, map: Option<AllMailMap>) {
        self.allmail = map;
    }
    pub fn allmail(&self) -> Option<&AllMailMap> {
        self.allmail.as_ref()
    }
    pub fn names(&self) -> Vec<String> {
        self.plans.keys().cloned().collect()
    }
}

/// Every scoped copy of a Gmail message: `X-GM-MSGID` to `(folder index, uid)`.
#[derive(Default, Debug)]
pub struct GmIndex(HashMap<u64, Vec<(usize, u32)>>);

impl GmIndex {
    pub fn build(plan_files: &[&FolderPlan]) -> GmIndex {
        let mut m: HashMap<u64, Vec<(usize, u32)>> = HashMap::new();
        for (i, p) in plan_files.iter().enumerate() {
            if let Some(g) = &p.gm_msgids {
                for (k, gm) in g.iter().enumerate() {
                    m.entry(*gm).or_default().push((i, p.uids[k]));
                }
            }
        }
        GmIndex(m)
    }
    pub fn copies(&self, gm_msgid: u64) -> &[(usize, u32)] {
        self.0.get(&gm_msgid).map(|v| v.as_slice()).unwrap_or(&[])
    }
}

// ── The preview listing ─────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct PreviewListing {
    pub preview_id: String,
    pub provider: Provider,
    pub caps: Caps,
    pub trash: Option<FolderInfo>,
    /// (folder, uidvalidity, its messages), in LIST order.
    pub folders: Vec<(FolderInfo, Option<u32>, Vec<ListedMsg>)>,
    /// Gmail: All Mail, always listed, ticked or not.
    pub all_mail: Option<(FolderInfo, u32, Vec<ListedMsg>)>,
    pub listed_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct Selection {
    pub folders: Vec<String>,
    pub dates: DateScope,
    pub year_bounds: Vec<YearBounds>,
    pub mode: Mode,
    pub delete_mode: DeleteMode,
}

#[derive(Clone, Debug, Default)]
pub struct LocalCounts {
    pub archived: HashMap<String, HashSet<u32>>,
    pub on_drive: Option<HashMap<String, HashSet<u32>>>,
}

/// `Part A` adapter: the daily download limit that governs background jobs.
pub fn daily_limit(app_dir: &Path, account_id: &str, host: &str) -> Option<u64> {
    crate::transfer_limits::background_down_limit(
        crate::transfer_limits::read_limits(app_dir, account_id).as_ref(),
        host,
    )
}

// ── Dates ───────────────────────────────────────────────────────────────────

/// The calendar year (in the user's zone) `ms` falls in, by the app's bounds.
pub fn year_of(ms: i64, bounds: &[YearBounds]) -> Option<i32> {
    bounds.iter().find(|b| ms >= b.start_ms && ms < b.end_ms).map(|b| b.year)
}

pub fn in_scope(ms: i64, dates: &DateScope, bounds: &[YearBounds]) -> bool {
    match dates {
        DateScope::All => true,
        DateScope::Range { since_ms, before_ms } => {
            since_ms.map_or(true, |s| ms >= s) && before_ms.map_or(true, |b| ms < b)
        }
        DateScope::Years { years } => year_of(ms, bounds).map_or(false, |y| years.contains(&y)),
    }
}

/// Gmail's All Mail row counts only mail that carries no other label.
pub fn gmail_scope(msg: &ListedMsg, all_mail_ticked: bool) -> bool {
    all_mail_ticked && msg.unlabelled == Some(true)
}

// ── Scope ───────────────────────────────────────────────────────────────────

fn role_rank(role: FolderRole) -> u8 {
    match role {
        FolderRole::Normal => 0,
        FolderRole::AllMail => 1,
        FolderRole::Spam => 2,
        FolderRole::Trash => 3,
    }
}

pub struct ScopedFolder<'a> {
    pub info: &'a FolderInfo,
    pub uid_validity: Option<u32>,
    pub is_all_mail: bool,
    /// Ascending by uid.
    pub msgs: Vec<&'a ListedMsg>,
}

struct Row<'a> {
    info: &'a FolderInfo,
    validity: Option<u32>,
    msgs: &'a [ListedMsg],
    is_all_mail: bool,
}

/// Every listed folder in processing order: normal folders in LIST order,
/// Gmail All Mail, Spam, Trash.
fn rows(p: &PreviewListing) -> Vec<Row<'_>> {
    let mut out: Vec<Row<'_>> = p
        .folders
        .iter()
        .map(|(info, v, msgs)| Row { info, validity: *v, msgs: msgs.as_slice(), is_all_mail: false })
        .collect();
    if let Some((info, v, msgs)) = &p.all_mail {
        out.push(Row { info, validity: Some(*v), msgs: msgs.as_slice(), is_all_mail: true });
    }
    // Stable: LIST order is kept inside a rank.
    out.sort_by_key(|r| if r.is_all_mail { 1 } else { role_rank(r.info.role) });
    out
}

fn row_scoped<'a>(r: &Row<'a>, sel: &Selection) -> Vec<&'a ListedMsg> {
    let mut v: Vec<&ListedMsg> = r
        .msgs
        .iter()
        .filter(|m| in_scope(m.internal_ms, &sel.dates, &sel.year_bounds))
        .filter(|m| !r.is_all_mail || gmail_scope(m, true))
        .collect();
    v.sort_by_key(|m| m.uid);
    v
}

/// The ticked folders with their in-scope messages, in processing order.
pub fn scoped_folders<'a>(p: &'a PreviewListing, sel: &Selection) -> Vec<ScopedFolder<'a>> {
    rows(p)
        .into_iter()
        .filter(|r| sel.folders.iter().any(|f| f == &r.info.path))
        .map(|r| ScopedFolder {
            info: r.info,
            uid_validity: r.validity,
            is_all_mail: r.is_all_mail,
            msgs: row_scoped(&r, sel),
        })
        .collect()
}

// ── Summary ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct YearCount {
    pub year: i32,
    pub count: u64,
    pub bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderSummary {
    pub path: String,
    pub name: String,
    pub role: FolderRole,
    pub count: u64,
    pub bytes: u64,
    pub already_archived: u64,
    pub already_on_drive: u64,
    pub by_year: Vec<YearCount>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Total {
    pub count: u64,
    pub bytes: u64,
    pub unique_messages: u64,
    pub to_download_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub daily_limit_bytes: Option<u64>,
    pub allowance_left_bytes: Option<u64>,
    pub days: Option<u32>,
    pub gmail_cap: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub preview_id: String,
    pub provider: Provider,
    pub can_delete: bool,
    pub can_empty: bool,
    pub folders: Vec<FolderSummary>,
    pub years: Vec<YearCount>,
    pub total: Total,
    pub estimate: Estimate,
    pub warnings: Vec<String>,
}

fn by_year(msgs: &[&ListedMsg], bounds: &[YearBounds]) -> Vec<YearCount> {
    let mut m: BTreeMap<i32, (u64, u64)> = BTreeMap::new();
    for msg in msgs {
        if let Some(y) = year_of(msg.internal_ms, bounds) {
            let e = m.entry(y).or_insert((0, 0));
            e.0 += 1;
            e.1 += msg.size as u64;
        }
    }
    m.into_iter().map(|(year, (count, bytes))| YearCount { year, count, bytes }).collect()
}

/// Days a job needs. `None` when there is no daily limit. `left` is what is
/// left today (defaults to the whole day). 1 if it fits today, else 1 plus the
/// whole days for the rest.
pub fn estimate_days(to_download: u64, allowance_left: Option<u64>, daily_limit: Option<u64>) -> Option<u32> {
    let daily = daily_limit.filter(|d| *d > 0)?;
    let left = allowance_left.unwrap_or(daily);
    if to_download <= left {
        return Some(1);
    }
    let rest = to_download - left;
    let extra = (rest + daily - 1) / daily;
    Some(1u32.saturating_add(extra.min(u32::MAX as u64 - 1) as u32))
}

/// Recompute everything the setup screen shows from the preview, without the
/// server.
pub fn summarize(
    p: &PreviewListing,
    sel: &Selection,
    local: &LocalCounts,
    allowance_left: Option<u64>,
    daily_limit: Option<u64>,
) -> Summary {
    let all_rows = rows(p);
    let backup = sel.mode == Mode::ArchiveBackupDelete;
    let empty_set: HashSet<u32> = HashSet::new();

    let mut folders: Vec<FolderSummary> = Vec::new();
    let mut years: BTreeMap<i32, (u64, u64)> = BTreeMap::new();
    let mut total_count = 0u64;
    let mut total_bytes = 0u64;
    let mut unique_ids: HashSet<u64> = HashSet::new();
    let mut unique_plain = 0u64;
    let mut to_download = 0u64;
    let mut seen_download: HashSet<u64> = HashSet::new();
    let mut trash_in_scope = false;

    for r in &all_rows {
        let ticked = sel.folders.iter().any(|f| f == &r.info.path);
        let scoped = row_scoped(r, sel);
        // The per-year list ignores the date choice but keeps the All Mail row
        // to its own definition (no other label).
        let year_pool: Vec<&ListedMsg> = r.msgs.iter().filter(|m| !r.is_all_mail || gmail_scope(m, true)).collect();
        let archived = local.archived.get(&r.info.path).unwrap_or(&empty_set);
        let on_drive = if backup {
            local.on_drive.as_ref().and_then(|m| m.get(&r.info.path)).unwrap_or(&empty_set)
        } else {
            &empty_set
        };
        let count = scoped.len() as u64;
        let bytes: u64 = scoped.iter().map(|m| m.size as u64).sum();
        folders.push(FolderSummary {
            path: r.info.path.clone(),
            name: r.info.name.clone(),
            role: r.info.role,
            count,
            bytes,
            already_archived: scoped.iter().filter(|m| archived.contains(&m.uid)).count() as u64,
            already_on_drive: scoped.iter().filter(|m| on_drive.contains(&m.uid)).count() as u64,
            by_year: by_year(&year_pool, &sel.year_bounds),
        });
        if !ticked {
            continue;
        }
        if r.info.role == FolderRole::Trash {
            trash_in_scope = true;
        }
        for yc in by_year(&year_pool, &sel.year_bounds) {
            let e = years.entry(yc.year).or_insert((0, 0));
            e.0 += yc.count;
            e.1 += yc.bytes;
        }
        total_count += count;
        total_bytes += bytes;
        for m in &scoped {
            match m.gm_msgid {
                Some(g) => {
                    unique_ids.insert(g);
                }
                None => unique_plain += 1,
            }
            if archived.contains(&m.uid) {
                continue;
            }
            match m.gm_msgid {
                Some(g) => {
                    if seen_download.insert(g) {
                        to_download += m.size as u64;
                    }
                }
                None => to_download += m.size as u64,
            }
        }
    }

    // A scoped Gmail message that also lives in a second label folder.
    let mut multi_label = false;
    if p.provider == Provider::Gmail {
        let mut label_count: HashMap<u64, u32> = HashMap::new();
        for r in all_rows.iter().filter(|r| !r.is_all_mail) {
            for m in r.msgs {
                if let Some(g) = m.gm_msgid {
                    *label_count.entry(g).or_insert(0) += 1;
                }
            }
        }
        for r in all_rows.iter().filter(|r| !r.is_all_mail) {
            if !sel.folders.iter().any(|f| f == &r.info.path) {
                continue;
            }
            for m in row_scoped(r, sel) {
                if m.gm_msgid.map_or(false, |g| label_count.get(&g).copied().unwrap_or(0) > 1) {
                    multi_label = true;
                }
            }
        }
    }

    let can_delete = p.trash.is_some() && (p.provider == Provider::Graph || p.caps.move_cmd || p.caps.uidplus);
    let can_empty = p.provider == Provider::Graph || p.caps.uidplus;

    let mut warnings: Vec<String> = Vec::new();
    if multi_label {
        warnings.push("multi_label".to_string());
    }
    if trash_in_scope {
        warnings.push("trash_in_scope".to_string());
    }
    if sel.delete_mode == DeleteMode::MoveToTrashAndEmpty && !can_empty {
        warnings.push("cannot_empty".to_string());
    }
    if !can_delete {
        warnings.push("cannot_delete".to_string());
    }

    // Gmail stops at its own cap even with the user's cap off.
    let (limit, left, gmail_cap) = match daily_limit {
        Some(l) => (Some(l), Some(allowance_left.unwrap_or(l)), false),
        None if p.provider == Provider::Gmail => (Some(GMAIL_DAILY_CAP_BYTES), Some(GMAIL_DAILY_CAP_BYTES), true),
        None => (None, None, false),
    };
    let days = estimate_days(to_download, left, limit);

    Summary {
        preview_id: p.preview_id.clone(),
        provider: p.provider,
        can_delete,
        can_empty,
        folders,
        years: years.into_iter().map(|(year, (count, bytes))| YearCount { year, count, bytes }).collect(),
        total: Total {
            count: total_count,
            bytes: total_bytes,
            unique_messages: unique_ids.len() as u64 + unique_plain,
            to_download_bytes: to_download,
        },
        estimate: Estimate { daily_limit_bytes: limit, allowance_left_bytes: left, days, gmail_cap },
        warnings,
    }
}
