//! Daemon routes of the Archive (& back up) & delete job (design section 6.6).
//!
//! The RPCs only validate, register and signal: the job itself runs on the
//! `abd-worker` thread (`crate::abd_worker`), never on the IPC runtime. The
//! app is a shell: it asks for a dry run (`abd.preview` + `abd.summarize`),
//! starts a job, and renders the `abd-progress` frames the worker sends.
//!
//! Errors the app maps to catalog strings start with a stable `E_ABD_*:` code:
//! `E_ABD_JOB_EXISTS`, `E_ABD_PREVIEW_EXPIRED`, `E_ABD_NOT_CONFIRMED`,
//! `E_ABD_NO_BACKUP_DRIVE`, `E_ABD_CANNOT_DELETE`, and, beyond the catalog,
//! `E_ABD_JOB_UNFINISHED` (dismiss of a job that is still going) and
//! `E_ABD_NO_JOB` (pause, resume or cancel with no job).
//!
//! Premium is checked in the app only. A lapse never stops a running job.
//! The access token of `abd.set_token` is kept in memory and is never echoed,
//! logged or persisted.

use crate::abd_worker::{
    all_frames, lock, CachedCounts, JobHandle, Parked, PreviewEntry, WorkerCmd, PROGRESS_EVENT,
};
use crate::handlers::common;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::abd::graph_ops::TokenLease;
use mailvault_core::abd::state as jobfile;
use mailvault_core::abd::{
    summarize, DateScope, DeleteMode, JobFile, LocalCounts, Mode, NewJob, Provider, Scope, Selection, Timing, YearBounds,
};
use mailvault_core::{maildir, transfer_limits, vault_files};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) const E_JOB_EXISTS: &str = "E_ABD_JOB_EXISTS: A job is already running for this account.";
pub(crate) const E_PREVIEW_EXPIRED: &str = "E_ABD_PREVIEW_EXPIRED: The summary is out of date. Review it again.";
pub(crate) const E_NOT_CONFIRMED: &str = "E_ABD_NOT_CONFIRMED: Tick the box to confirm first.";
pub(crate) const E_NO_BACKUP_DRIVE: &str = "E_ABD_NO_BACKUP_DRIVE: The backup drive is not available.";
pub(crate) const E_CANNOT_DELETE: &str = "E_ABD_CANNOT_DELETE: This server cannot remove emails safely.";
pub(crate) const E_JOB_UNFINISHED: &str = "E_ABD_JOB_UNFINISHED: The job is still going. Stop it first.";
pub(crate) const E_NO_JOB: &str = "E_ABD_NO_JOB: There is no job for this account.";

/// The drive and vault counts behind a summary are reused for this long.
const COUNTS_TTL: Duration = Duration::from_secs(60);

// ── Params ──────────────────────────────────────────────────────────────────

fn text(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Missing {key}"))
}

fn opt_text(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn parsed<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T, String> {
    let v = params.get(key).cloned().ok_or_else(|| format!("Missing {key}"))?;
    serde_json::from_value(v).map_err(|e| format!("Invalid {key}: {e}"))
}

fn parsed_or<T: DeserializeOwned>(params: &Value, key: &str, default: T) -> Result<T, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| format!("Invalid {key}: {e}")),
    }
}

/// `accountId`, checked as safe for a path part (it names the job directory).
fn account_arg(state: &Arc<DaemonState>, params: &Value) -> Result<String, String> {
    let account = text(params, "accountId")?;
    jobfile::job_dir(&state.app_dir, &account)?;
    Ok(account)
}

fn selection(params: &Value) -> Result<Selection, String> {
    Ok(Selection {
        folders: parsed_or(params, "folders", Vec::<String>::new())?,
        dates: parsed_or(params, "dates", DateScope::All)?,
        year_bounds: parsed_or(params, "yearBounds", Vec::<YearBounds>::new())?,
        mode: parsed(params, "mode")?,
        delete_mode: parsed_or(params, "deleteMode", DeleteMode::MoveToTrash)?,
    })
}

// ── Routes ──────────────────────────────────────────────────────────────────

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let result = match method {
        "abd.preview" => preview(state, params),
        "abd.summarize" => summarize_rpc(state, params).await,
        "abd.start" => start(state, params).await,
        "abd.status" => status(state, params).await,
        "abd.pause" => control(state, params, Control::Pause),
        "abd.resume" => control(state, params, Control::Resume),
        "abd.cancel" => control(state, params, Control::Cancel),
        "abd.set_token" => set_token(state, params),
        // `abd.attach` is the same call under the short name.
        "abd.attach_mirror" | "abd.attach" => attach_mirror(state, params).await,
        "abd.dismiss" => dismiss(state, params).await,
        _ => return None,
    };
    Some(common::done(id, result))
}

/// Ask the worker to list the account (folders and every message's date and
/// size). Answers at once; `abd-preview` events report the progress.
fn preview(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account_id = account_arg(state, params)?;
    let preview_id = text(params, "previewId")?;
    state.abd.send(WorkerCmd::Preview { account_id, preview_id: preview_id.clone() })?;
    Ok(json!({ "previewId": preview_id }))
}

/// What the vault and the drive already hold, per folder of the listing. Read
/// once per minute per listing: a summary is asked for on every tick of the
/// setup screen and a directory read of a large folder is not free.
fn local_counts(
    state: &Arc<DaemonState>,
    account: &str,
    entry: &PreviewEntry,
    mirror: Option<&str>,
    backup: bool,
) -> Result<LocalCounts, String> {
    if let Some(c) = lock(&entry.counts).as_ref() {
        if c.at.elapsed() < COUNTS_TTL && c.backup == backup && c.mirror.as_deref() == mirror {
            return Ok(c.counts.clone());
        }
    }
    let root = common::vault_root(state)?;
    let mirror_root = mirror.filter(|m| backup && Path::new(m).is_dir());
    let mut counts = LocalCounts::default();
    let mut on_drive: Option<HashMap<String, HashSet<u32>>> = mirror_root.map(|_| HashMap::new());
    let listing = &entry.listing;
    let mut paths: Vec<&str> = listing.folders.iter().map(|f| f.0.path.as_str()).collect();
    if let Some((info, _, _)) = &listing.all_mail {
        paths.push(info.path.as_str());
    }
    for path in paths {
        let cur = vault_files::cur_path(&root, account, path);
        counts.archived.insert(path.to_string(), maildir::archived_file_map(&cur).into_keys().collect());
        if let (Some(map), Some(m)) = (on_drive.as_mut(), mirror_root) {
            let dir = Path::new(m).join(&entry.email).join(path).join("cur");
            map.insert(path.to_string(), maildir::mirror_file_map(&dir).into_keys().collect());
        }
    }
    counts.on_drive = on_drive;
    *lock(&entry.counts) = Some(CachedCounts {
        at: Instant::now(),
        mirror: mirror.map(str::to_string),
        backup,
        counts: counts.clone(),
    });
    Ok(counts)
}

/// The dry run for a selection, recomputed from the stored listing: the server
/// is not asked again.
async fn summarize_rpc(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account = account_arg(state, params)?;
    let preview_id = text(params, "previewId")?;
    let entry = state.abd.preview(&account, &preview_id).ok_or_else(|| E_PREVIEW_EXPIRED.to_string())?;
    let sel = selection(params)?;
    let mirror = opt_text(params, "mirrorRoot");
    let st = Arc::clone(state);
    common::blocking(move || -> Result<Value, String> {
        let backup = sel.mode == Mode::ArchiveBackupDelete;
        let counts = local_counts(&st, &account, &entry, mirror.as_deref(), backup)?;
        let now = st.clock.now_ms();
        let left = transfer_limits::background_allowance_at(&st.app_dir, &account, &entry.host, now);
        let limit = mailvault_core::abd::plan::daily_limit(&st.app_dir, &account, &entry.host);
        serde_json::to_value(summarize(&entry.listing, &sel, &counts, left, limit)).map_err(|e| e.to_string())
    })
    .await?
}

/// Whether the server can delete at all, and empty Trash after (the same rule
/// the summary reports).
fn capabilities(p: &mailvault_core::abd::PreviewListing) -> (bool, bool) {
    let graph = p.provider == Provider::Graph;
    (p.trash.is_some() && (graph || p.caps.move_cmd || p.caps.uidplus), graph || p.caps.uidplus)
}

async fn start(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account = account_arg(state, params)?;
    let preview_id = text(params, "previewId")?;
    if params.get("confirmed").and_then(Value::as_bool) != Some(true) {
        return Err(E_NOT_CONFIRMED.to_string());
    }
    let mode: Mode = parsed(params, "mode")?;
    let timing: Timing = parsed(params, "timing")?;
    let delete_mode: DeleteMode = parsed(params, "deleteMode")?;
    let sel = selection(params)?;
    let date_choice = opt_text(params, "dateChoice").unwrap_or_else(|| "all".to_string());
    let mirror = opt_text(params, "mirrorRoot");

    // One job per account. A finished one is replaced; one whose file cannot be
    // read is not (the user dismisses it first).
    if state.abd.handle(&account).map_or(false, |h| !h.is_over()) {
        return Err(E_JOB_EXISTS.to_string());
    }
    let dir = jobfile::job_dir(&state.app_dir, &account)?;
    let on_disk = {
        let dir = dir.clone();
        common::blocking(move || jobfile::load_job(&dir)).await?
    };
    match on_disk {
        Err(_) => return Err(E_JOB_EXISTS.to_string()),
        Ok(Some(j)) if !j.status.is_finished() => return Err(E_JOB_EXISTS.to_string()),
        _ => {}
    }

    let entry = state.abd.preview(&account, &preview_id).ok_or_else(|| E_PREVIEW_EXPIRED.to_string())?;
    if mode == Mode::ArchiveBackupDelete {
        let usable = match &mirror {
            Some(m) => {
                let m = m.clone();
                common::blocking(move || Path::new(&m).is_dir()).await?
            }
            None => false,
        };
        if !usable {
            return Err(E_NO_BACKUP_DRIVE.to_string());
        }
    }
    let (can_delete, can_empty) = capabilities(&entry.listing);
    if !can_delete || (delete_mode == DeleteMode::MoveToTrashAndEmpty && !can_empty) {
        return Err(E_CANNOT_DELETE.to_string());
    }

    let mut job = JobFile::create(NewJob {
        account_id: account.clone(),
        account_email: entry.email.clone(),
        host: entry.host.clone(),
        provider: entry.listing.provider,
        mode,
        timing,
        delete_mode,
        scope: Scope { folders: sel.folders.clone(), dates: sel.dates.clone(), date_choice, year_bounds: sel.year_bounds.clone() },
        now_ms: state.clock.now_ms(),
    });
    job.mirror_hint = if mode == Mode::ArchiveBackupDelete { mirror.clone() } else { None };
    let handle = JobHandle::new(&job);
    {
        let mut jobs = lock(&state.abd.jobs);
        if jobs.get(&account).map_or(false, |h| !h.is_over()) {
            return Err(E_JOB_EXISTS.to_string());
        }
        jobs.insert(account.clone(), Arc::clone(&handle));
    }
    let undo = |state: &Arc<DaemonState>, handle: &Arc<JobHandle>| {
        let mut jobs = lock(&state.abd.jobs);
        if jobs.get(&handle.account_id).map_or(false, |h| Arc::ptr_eq(h, handle)) {
            jobs.remove(&handle.account_id);
        }
    };

    // The job exists on disk before the worker hears of it: a crash between the
    // two leaves a file the next start reads, not a job nobody knows about.
    let saved = {
        let (dir, first) = (dir.clone(), job.clone());
        common::blocking(move || -> Result<(), String> {
            jobfile::remove_job(&dir)?;
            jobfile::save_job(&dir, &first)
        })
        .await
    };
    if let Ok(Err(e)) | Err(e) = saved {
        undo(state, &handle);
        return Err(format!("Could not start the job: {e}"));
    }
    match &mirror {
        Some(m) if mode == Mode::ArchiveBackupDelete => {
            lock(&state.abd.mirrors).insert(account.clone(), m.clone());
        }
        _ => {
            lock(&state.abd.mirrors).remove(&account);
        }
    }
    let job_id = handle.job_id.clone();
    state.events.emit(PROGRESS_EVENT, handle.frame());
    if let Err(e) = state.abd.send(WorkerCmd::Start { job: Box::new(job), preview: Arc::clone(&entry.listing), handle: Arc::clone(&handle) }) {
        undo(state, &handle);
        let dir = dir.clone();
        let _ = common::blocking(move || jobfile::remove_job(&dir)).await;
        return Err(e);
    }
    // The listing has done its work; do not hold it for the rest of its life.
    {
        let mut previews = lock(&state.abd.previews);
        if previews.get(&account).map_or(false, |p| p.preview_id == preview_id) {
            previews.remove(&account);
        }
    }
    Ok(json!({ "jobId": job_id }))
}

/// Every job's last frame (or one account's). Jobs the worker has not adopted
/// yet are read from their files.
async fn status(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let only = opt_text(params, "accountId");
    let st = Arc::clone(state);
    let frames = common::blocking(move || all_frames(&st, only.as_deref())).await?;
    Ok(json!({ "jobs": frames }))
}

enum Control {
    Pause,
    Resume,
    Cancel,
}

/// Pause, resume and cancel set the job's flags and wake it. The same task
/// carries on, so there is never a second run. The reply is the status the
/// job is moving to; the next frame confirms it.
fn control(state: &Arc<DaemonState>, params: &Value, what: Control) -> Result<Value, String> {
    let account = account_arg(state, params)?;
    let handle = state.abd.handle(&account).ok_or_else(|| E_NO_JOB.to_string())?;
    if handle.is_over() {
        return Ok(json!({ "status": handle.status() }));
    }
    let status = match what {
        Control::Pause => {
            handle.ctl.pause.store(true, std::sync::atomic::Ordering::SeqCst);
            json!({"state": "paused", "reason": "user"})
        }
        Control::Resume => {
            handle.ctl.pause.store(false, std::sync::atomic::Ordering::SeqCst);
            let now = handle.status();
            let user_paused = now.get("state").and_then(Value::as_str) == Some("paused")
                && now.get("reason").and_then(Value::as_str) == Some("user");
            if user_paused {
                json!({"state": "running", "phase": "download"})
            } else {
                now
            }
        }
        Control::Cancel => {
            handle.ctl.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            handle.ctl.pause.store(false, std::sync::atomic::Ordering::SeqCst);
            json!({"state": "cancelled"})
        }
    };
    handle.wake();
    Ok(json!({ "status": status }))
}

/// Keep the access token the app pushed, in memory, for the account. It may
/// arrive before any job exists (the setup screen lists with it). Nothing of it
/// is logged, echoed or written.
fn set_token(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account = account_arg(state, params)?;
    let token = text(params, "accessToken")?;
    let expires = params
        .get("expiresAtMs")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .ok_or_else(|| "Missing expiresAtMs".to_string())?;
    state.abd.tokens.set(&account, TokenLease { token, expires_at_ms: expires });
    if let Some(h) = state.abd.handle(&account) {
        h.wake_if_parked(Parked::Token);
    }
    Ok(json!({}))
}

/// The shell resolved the backup drive again and hands the daemon its path.
/// `attached: true` when a live or drive-paused backup-mode job took it.
async fn attach_mirror(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account = account_arg(state, params)?;
    let Some(root) = opt_text(params, "mirrorRoot") else { return Ok(json!({ "attached": false })) };
    let Some(handle) = state.abd.handle(&account) else { return Ok(json!({ "attached": false })) };
    if handle.is_over() || handle.mode != Some(Mode::ArchiveBackupDelete) {
        return Ok(json!({ "attached": false }));
    }
    let probe = root.clone();
    if !common::blocking(move || Path::new(&probe).is_dir()).await? {
        return Ok(json!({ "attached": false }));
    }
    state.abd.attach(&account, &root);
    handle.wake_if_parked(Parked::Drive);
    Ok(json!({ "attached": true }))
}

/// Remove a finished (or unreadable) job's files. An unfinished job is refused.
async fn dismiss(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account = account_arg(state, params)?;
    if state.abd.handle(&account).map_or(false, |h| !h.is_over()) {
        return Err(E_JOB_UNFINISHED.to_string());
    }
    let dir = jobfile::job_dir(&state.app_dir, &account)?;
    let removed = common::blocking(move || -> Result<bool, String> {
        if let Ok(Some(j)) = jobfile::load_job(&dir) {
            if !j.status.is_finished() {
                return Err(E_JOB_UNFINISHED.to_string());
            }
        }
        jobfile::remove_job(&dir)
    })
    .await??;
    lock(&state.abd.jobs).remove(&account);
    Ok(json!({ "removed": removed }))
}

#[cfg(test)]
#[path = "abd_tests.rs"]
mod tests;
