//! The daemon's one gate on the backup drive (Premium in the direct build; see
//! `mailvault_core::external_backup`). A drive root reaches the daemon two
//! ways and both pass through here before any code can write to it:
//!
//! - RPC params (`mirrorRoot`, resolved by the shell): `gate_params`, called by
//!   the dispatcher (`server::route_request`) for every method. Only the drive
//!   WRITERS (`external_backup::DRIVE_WRITERS`) lose the root; readers keep it,
//!   so a free user still sees what is on the drive. A transport switch is
//!   refused outright (`external_backup::refused_without_drive`).
//! - The native scheduler's attached access (`backup_access::root`): the
//!   worker asks `allowed_by` with the settings it already read, and skips the
//!   access dance entirely when the drive is not allowed.
//!
//! Archive, Back up & Delete (`abd.*`) is left out on purpose: it is its own
//! Premium feature, checked when a job starts, and a lapse never stops a
//! running job (architecture.md, "Archive & delete jobs"). Its drive is the
//! one that job was started with.

use crate::state::DaemonState;
use mailvault_core::external_backup as gate;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Settings reads per app dir, for tests that pin how often the gate parses.
#[cfg(test)]
static SETTINGS_READS: std::sync::Mutex<Vec<(std::path::PathBuf, u64)>> = std::sync::Mutex::new(Vec::new());
#[cfg(test)]
pub(crate) fn settings_reads_for_test(app_dir: &std::path::Path) -> u64 {
    SETTINGS_READS.lock().unwrap().iter().find(|(p, _)| p == app_dir).map_or(0, |(_, n)| *n)
}
#[cfg(test)]
fn note_settings_read(app_dir: &std::path::Path) {
    let mut reads = SETTINGS_READS.lock().unwrap();
    match reads.iter_mut().find(|(p, _)| p == app_dir) {
        Some((_, n)) => *n += 1,
        None => reads.push((app_dir.to_path_buf(), 1)),
    }
}

/// The persisted settings state, or `None` when it cannot be read. A document
/// recovered from a backup is not trusted, the same rule the backup worker's
/// `loaded_settings` applies.
fn settings_state(state: &DaemonState) -> Option<Value> {
    #[cfg(test)]
    note_settings_read(&state.app_dir);
    let snapshot = mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).get(None).ok()?;
    if snapshot.recovered.is_some() {
        return None;
    }
    snapshot.app_state().filter(|v| v.is_object()).cloned()
}

/// What identifies one version of the settings file without reading it: a
/// write replaces the file (new inode on unix) and moves its mtime and length.
#[derive(Clone, PartialEq)]
struct Stamp(std::time::SystemTime, u64, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(&meta);
    #[cfg(not(unix))]
    let ino = 0;
    Some(Stamp(meta.modified().ok()?, meta.len(), ino))
}

/// One cached decision per app dir: valid while the settings file is the same
/// one and the clock has not passed the moment the plan ends on its own.
struct Cached {
    stamp: Stamp,
    allowed: bool,
    until: Option<i64>,
}

static CACHE: Mutex<Option<HashMap<PathBuf, Cached>>> = Mutex::new(None);

/// May the daemon use the backup drive now? A stat per call; the settings
/// document is read and parsed only when it changed or a paid period ended,
/// so a flag click pays no parse.
pub(crate) fn allowed(state: &DaemonState) -> bool {
    if gate::store_build() {
        return true;
    }
    let now = state.clock.now_ms();
    let path = mailvault_core::settings_doc::SettingsDoc::shared(&state.app_dir).path();
    let before = stamp(&path);
    if let Some(current) = &before {
        let cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = cache.as_ref().and_then(|m| m.get(&state.app_dir)) {
            if &c.stamp == current && c.until.is_none_or(|until| now < until) {
                return c.allowed;
            }
        }
    }
    let settings = settings_state(state);
    let allowed = gate::drive_allowed(settings.as_ref(), now, false);
    // A file that changed while it was read is cached under the old stamp, so
    // the next call sees the new stamp and reads again.
    if let Some(stamp) = before {
        let until = settings.as_ref().and_then(|s| mailvault_core::cleanup_rules::premium_changes_at(s, now));
        CACHE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert_with(HashMap::new)
            .insert(state.app_dir.clone(), Cached { stamp, allowed, until });
    }
    allowed
}

/// The same decision over settings the caller already holds.
pub(crate) fn allowed_by(state: &DaemonState, settings: &Value) -> bool {
    gate::drive_allowed(Some(settings), state.clock.now_ms(), gate::store_build())
}

/// Dispatcher hook: takes a drive root the plan may not use out of a drive
/// WRITER's `params`, or refuses the call (`Err(catalog key)`) when it cannot
/// run without the drive. Readers and `abd.*` pass untouched.
pub(crate) async fn gate_params(state: &Arc<DaemonState>, method: &str, params: &mut Value) -> Result<(), String> {
    if !gate::writes_drive(method) || !gate::carries_drive(params) {
        return Ok(());
    }
    let st = Arc::clone(state);
    let ok = crate::handlers::common::blocking(move || allowed(&st)).await.unwrap_or(false);
    if ok {
        return Ok(());
    }
    if let Some(key) = gate::refused_without_drive(method) {
        return Err(key.to_string());
    }
    gate::withhold_drive(params);
    Ok(())
}
