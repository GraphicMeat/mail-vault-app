//! The app side of the custody store: one connection in managed state, opened
//! in `setup` (the import of the legacy JSON records runs there, before any
//! command is served) and closed around vault switches. The logic lives in
//! `mailvault_core::custody`. Unlike the search index there is no worker, no
//! rebuild and no delete: a store that will not open is reported
//! (`custody-status`, `custody_status`) and left as it is.

use mailvault_core::custody::{db, entries, import, lock, Connection, SharedConn};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager};
use tracing::{error, info, warn};

#[derive(Default)]
pub struct CustodyState {
    pub db: SharedConn,
    pub root: Mutex<Option<PathBuf>>,
    /// Why the store is closed, when an open failed. Cleared by a successful open.
    pub error: Mutex<Option<String>>,
}

fn g<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Open the store for the current vault root and import any legacy records.
/// Synchronous on purpose: a command that reads custody must never run
/// before this has, and the store is small (no quick_check, see core).
pub fn open_into(app: &tauri::AppHandle) {
    let st = app.state::<CustodyState>();
    *lock(&st.db) = None; // one connection per file: a stale one would make this open BUSY
    let root = match crate::vault::root(app) {
        Ok(r) => r,
        Err(e) => {
            warn!("custody store: no vault root: {e}");
            *g(&st.root) = None;
            *g(&st.error) = Some(format!("no vault root: {e}"));
            emit(app, &st);
            return;
        }
    };
    *g(&st.root) = Some(root.clone());
    match db::open(&root) {
        Ok(conn) => {
            let report = import::import_legacy(&conn, &root);
            if report.files > 0 || report.renamed_caches > 0 || !report.errors.is_empty() {
                info!("custody import: {report:?}");
            }
            for (path, why) in &report.errors {
                warn!("custody import: {} left in place: {why}", path.display());
            }
            *lock(&st.db) = Some(conn);
            *g(&st.error) = None;
        }
        Err(e) => {
            error!("custody store unavailable at {}: {e}", db::db_path(&root).display());
            *g(&st.error) = Some(e.to_string());
        }
    }
    emit(app, &st);
}

/// Before a vault operation: release the file. Drop = checkpoint, and the
/// -wal is gone, so a copy of `custody.db` alone is complete.
pub fn close(app: &tauri::AppHandle) {
    close_state(&app.state::<CustodyState>());
}

/// What `close` does to the state, without the handle: closed is closed, and
/// the last open's error belongs to a root that is no longer current.
pub(crate) fn close_state(st: &CustodyState) {
    *lock(&st.db) = None;
    *g(&st.root) = None;
    *g(&st.error) = None;
}

/// After a vault operation, success or not: open whatever root is current.
pub fn reopen(app: &tauri::AppHandle) {
    open_into(app)
}

pub(crate) fn status_json(st: &CustodyState) -> serde_json::Value {
    let available = lock(&st.db).is_some();
    let path = g(&st.root).as_ref().map(|r| db::db_path(r).display().to_string());
    serde_json::json!({ "available": available, "error": *g(&st.error), "path": path })
}

fn emit(app: &tauri::AppHandle, st: &CustodyState) {
    let _ = app.emit("custody-status", status_json(st));
}

/// Run `f` on the open store. `Err` with the open failure while it is
/// closed: a caller never mistakes a store it could not read for "no entries".
pub fn with_conn<T>(app: &tauri::AppHandle, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let st = app.state::<CustodyState>();
    let guard = lock(&st.db);
    match guard.as_ref() {
        Some(conn) => f(conn),
        None => Err(format!("custody store unavailable: {}", g(&st.error).clone().unwrap_or_else(|| "closed".into()))),
    }
}

/// Tauri 2 runs sync commands on the main thread; every command here runs off it.
async fn off_main<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || f(&app)).await.map_err(|e| format!("Task join error: {e}"))?
}

/// The mailbox's entries as one JSON array string, or `None` when it has none.
#[tauri::command]
pub async fn local_index_read(app: tauri::AppHandle, account_id: String, mailbox: String) -> Result<Option<String>, String> {
    off_main(app, move |app| with_conn(app, |c| entries::read(c, &account_id, &mailbox))).await
}

/// Upsert by uid. `entries_json` is a JSON array of entry objects.
#[tauri::command]
pub async fn local_index_append(app: tauri::AppHandle, account_id: String, mailbox: String, entries_json: String) -> Result<(), String> {
    let new_entries: Vec<serde_json::Value> =
        serde_json::from_str(&entries_json).map_err(|e| format!("Failed to parse entries: {}", e))?;
    off_main(app, move |app| {
        with_conn(app, |c| {
            let (_, skipped) = entries::upsert(c, &account_id, &mailbox, &new_entries)?;
            if skipped > 0 {
                warn!("local_index_append {account_id}/{mailbox}: {skipped} entries without a uid skipped");
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn local_index_remove(app: tauri::AppHandle, account_id: String, mailbox: String, uid: u32) -> Result<(), String> {
    off_main(app, move |app| with_conn(app, |c| entries::remove(c, &account_id, &mailbox, &[uid]).map(|_| ()))).await
}

#[tauri::command]
pub async fn custody_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    off_main(app, |app| Ok(status_json(&app.state::<CustodyState>()))).await
}
