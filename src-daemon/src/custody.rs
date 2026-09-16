//! The custody store, daemon side (Task 2.9a). Same core (`db`, `entries`,
//! `import`) and the same open discipline as `src-tauri/src/custody.rs`
//! (busy_timeout 0, EXCLUSIVE + WAL, never deletes a file it cannot read).
//!
//! Two differences from that app version, both because this state lives
//! alongside the search index rather than behind an `AppHandle`:
//! - open/close/reopen go through `mailvault_core::search_index::slot`
//!   (`SwitchGuard`/`install_if_current`), the same close-vs-in-flight-open
//!   mechanism `crate::search_index` already uses, instead of a bare
//!   "drop the old connection" — a `close` racing an in-flight `open_into`
//!   (two RPC calls landing close together) can no longer install a
//!   connection opened on a root this custody store has already left.
//! - `status_json`/`emit` take the `EventBus` on `DaemonState` instead of
//!   `AppHandle::emit`.
//!
//! Opened once at daemon startup, before `server::run` binds the socket
//! (Task 2.9b), and again by `vault_reopen` after a vault switch. Nothing in
//! the app opens `custody.db` any more: the file is EXCLUSIVE, so a second
//! opener would only ever fail BUSY.

use crate::server::DaemonState;
use mailvault_core::custody::{db, import, lock, Connection, SharedConn};
use mailvault_core::search_index::slot::{install_if_current, SwitchGuard};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tracing::{error, info, warn};

pub struct CustodyState {
    pub db: SharedConn,
    pub root: Mutex<Option<PathBuf>>,
    /// Why the store is closed, when an open failed. Cleared by a successful open.
    pub error: Mutex<Option<String>>,
    switch: SwitchGuard,
}

impl Default for CustodyState {
    fn default() -> Self {
        Self { db: Mutex::new(None), root: Mutex::new(None), error: Mutex::new(None), switch: SwitchGuard::default() }
    }
}

fn g<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Open the store for the current vault root and import any legacy records —
/// synchronous, so a route that reads custody right after this returns never
/// races the import. Gated on `mail_dir_ok` only (never `state.app_dir`: an
/// ungated open there would create a second, divergent custody store —
/// inventory-custody-plumbing headline 4).
pub fn open_into(state: &DaemonState) -> Result<(), String> {
    let st = &state.custody;
    if !state.mail_dir_ok {
        *lock(&st.db) = None;
        *g(&st.root) = None;
        let why = "no vault root: the folder is not reachable".to_string();
        *g(&st.error) = Some(why.clone());
        emit(state);
        return Err(why);
    }
    let root = state.data_dir.clone();
    let gen = st.switch.current();
    *lock(&st.db) = None; // one connection per file: a stale one would make this open BUSY
    // Root BEFORE the open, as the app's own `open_into` did (2.9a review C1):
    // the banner and `connected-custody-corrupt` both name the file that would
    // not open, and a store that failed to open still has a path.
    *g(&st.root) = Some(root.clone());
    let outcome = match db::open(&root) {
        Ok(conn) => {
            let report = import::import_legacy(&conn, &root);
            if report.files > 0 || report.renamed_caches > 0 || !report.errors.is_empty() {
                info!("custody import: {report:?}");
            }
            for (path, why) in &report.errors {
                warn!("custody import: {} left in place: {why}", path.display());
            }
            if !install_if_current(&st.db, &st.switch, gen, conn) {
                // A close() started while this opened: the connection is
                // dropped, and `close` already cleared root/error.
                return Ok(());
            }
            *g(&st.error) = None;
            Ok(())
        }
        Err(e) => {
            error!("custody store unavailable at {}: {e}", db::db_path(&root).display());
            *g(&st.error) = Some(e.to_string());
            Err(e.to_string())
        }
    };
    emit(state);
    outcome
}

/// Before a vault operation: release the file. Drop = checkpoint, so the
/// `-wal` is gone and a copy of `custody.db` alone is complete.
pub fn close(state: &DaemonState) {
    let st = &state.custody;
    st.switch.begin_switch(&st.db);
    *g(&st.root) = None;
    *g(&st.error) = None; // closed is closed; a stale error belongs to a root no longer current
}

/// After a vault operation, success or not: synchronous, unlike the search
/// index's `reopen`.
///
/// Returns the open failure (2.9a review I1) so `vault_reopen` can answer
/// `Err`: a custody store that will not reopen is otherwise permanent for the
/// daemon's life, and the app's own lifecycle error path — stop the daemon so
/// the channel respawns it against whatever root is current — never fires.
///
/// `handlers::search_index::vault_reopen` clears `vault_closed`
/// unconditionally once this call returns, `Err` included (task-2.9b review
/// M2): on the `Err` path the gate opens deliberately with custody still
/// closed, rather than leaving every route stuck on "the vault is being
/// moved" for callers that never learn of the failure. The app's own
/// lifecycle handler treats that same `Err` as fatal and stops the daemon
/// (`main.rs`'s `daemon_vault_lifecycle_call`), so the respawn — not this
/// gate — is what recovers a custody store that would not reopen.
pub fn reopen(state: &DaemonState) -> Result<(), String> {
    state.custody.switch.end_switch();
    open_into(state)
}

/// Identical shape to `src-tauri/src/custody.rs:82-86`.
pub fn status_json(state: &DaemonState) -> Value {
    let st = &state.custody;
    let available = lock(&st.db).is_some();
    let path = g(&st.root).as_ref().map(|r| db::db_path(r).display().to_string());
    json!({ "available": available, "error": *g(&st.error), "path": path })
}

fn emit(state: &DaemonState) {
    state.events.emit("custody-status", status_json(state));
}

/// Run `f` on the open store. `Err` with the open failure while it is closed:
/// a caller never mistakes a store it could not read for "no entries".
pub fn with_conn<T>(state: &DaemonState, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let st = &state.custody;
    let guard = lock(&st.db);
    match guard.as_ref() {
        Some(conn) => f(conn),
        None => Err(format!("custody store unavailable: {}", g(&st.error).clone().unwrap_or_else(|| "closed".into()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::custody::entries;

    /// Two distinct real tempdirs, same reasoning as `handlers::common`'s I2
    /// fix: a shared vault/app_dir tempdir can't fail on "touched app_dir
    /// instead of the vault root".
    fn state(mail_dir_ok: bool) -> (tempfile::TempDir, tempfile::TempDir, std::sync::Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), mail_dir_ok);
        (vault, app_dir, s)
    }

    #[test]
    fn open_into_opens_and_reports_available_when_the_folder_is_ok() {
        let (vault, _app, s) = state(true);
        let _ = open_into(&s);
        let status = status_json(&s);
        assert_eq!(status["available"], true);
        assert_eq!(status["path"], db::db_path(vault.path()).display().to_string());
        assert!(status["error"].is_null());
        assert!(db::db_path(vault.path()).exists());
    }

    #[test]
    fn open_into_refuses_and_touches_nothing_under_app_dir_when_the_folder_is_not_ok() {
        let (_vault, app, s) = state(false);
        let _ = open_into(&s);
        let status = status_json(&s);
        assert_eq!(status["available"], false);
        assert_eq!(status["error"], "no vault root: the folder is not reachable");
        assert!(status["path"].is_null());
        assert!(!app.path().join("custody").exists(), "no custody dir must appear under app_dir");
    }

    /// 2.9a review C1: the banner (`VaultAlertBanner.jsx`) and
    /// `connected-custody-corrupt.test.js` both name the file that would not
    /// open, so a failed open still reports its path — only "no vault root"
    /// has nothing to name. `open_into` returns the failure (I1) as well.
    #[test]
    fn a_store_that_will_not_open_still_reports_the_file_it_could_not_open() {
        let (vault, _app, s) = state(true);
        let file = db::db_path(vault.path());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"this is not a database").unwrap();

        let err = open_into(&s).unwrap_err();
        assert!(!err.is_empty());
        let status = status_json(&s);
        assert_eq!(status["available"], false);
        assert_eq!(status["path"], file.display().to_string(), "the banner names the file");
        assert!(!status["error"].is_null());
    }

    #[test]
    fn closed_store_with_conn_reports_the_open_error_text() {
        let (_vault, _app, s) = state(false);
        let _ = open_into(&s); // fails: mail_dir_ok is false
        let err = with_conn(&s, |c| entries::read(c, "acct", "INBOX")).unwrap_err();
        assert_eq!(err, "custody store unavailable: no vault root: the folder is not reachable");
    }

    #[test]
    fn a_default_state_before_any_open_reports_closed_with_no_error() {
        let (_vault, _app, s) = state(true);
        let status = status_json(&s);
        assert_eq!((status["available"].as_bool(), status["error"].is_null(), status["path"].is_null()), (Some(false), true, true));
        let err = with_conn(&s, |c| entries::read(c, "acct", "INBOX")).unwrap_err();
        assert_eq!(err, "custody store unavailable: closed");
    }

    /// Inventory-custody-plumbing headline 3 / plan Step 1: a read must never
    /// answer before the legacy `local-index.json` import has run.
    #[test]
    fn legacy_import_runs_before_the_first_read() {
        let (vault, _app, s) = state(true);
        let index_dir = vault.path().join("maildir").join("acct").join("INBOX");
        std::fs::create_dir_all(&index_dir).unwrap();
        std::fs::write(
            index_dir.join("local-index.json"),
            r#"[{"uid":7,"source":"local_draft","flags":["draft"]}]"#,
        )
        .unwrap();

        let _ = open_into(&s);

        let text = with_conn(&s, |c| entries::read(c, "acct", "INBOX")).unwrap().expect("imported row");
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed[0]["uid"], 7);
        assert!(!index_dir.join("local-index.json").exists(), "the legacy file is retired after import");
    }

    #[test]
    fn append_read_remove_round_trip() {
        let (_vault, _app, s) = state(true);
        let _ = open_into(&s);
        let entry = json!({"uid": 3, "source": "local_sent", "flags": ["seen"]});
        with_conn(&s, |c| entries::upsert(c, "acct", "Sent", &[entry.clone()]).map(|_| ())).unwrap();
        let text = with_conn(&s, |c| entries::read(c, "acct", "Sent")).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Vec<Value>>(&text).unwrap(), vec![entry]);
        with_conn(&s, |c| entries::remove(c, "acct", "Sent", &[3]).map(|_| ())).unwrap();
        assert_eq!(with_conn(&s, |c| entries::read(c, "acct", "Sent")).unwrap(), None);
    }

    #[test]
    fn close_then_reopen_reinstalls_a_working_connection() {
        let (_vault, _app, s) = state(true);
        let _ = open_into(&s);
        assert_eq!(status_json(&s)["available"], true);
        close(&s);
        let status = status_json(&s);
        assert_eq!((status["available"].as_bool(), status["error"].is_null(), status["path"].is_null()), (Some(false), true, true));
        let _ = reopen(&s);
        assert_eq!(status_json(&s)["available"], true);
    }
}
