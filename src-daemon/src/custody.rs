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
//!
//! The legacy JSON import is NOT part of that open any more
//! (`run_legacy_import`, 2026-09-20): it ran inside `open_into`, awaited
//! before the socket existed, and on a vault whose header sidecars are still
//! on disk it took 416 s — no mail, and "Helper Not Running" in settings, for
//! seven minutes. It now runs on its own thread once the socket is up, taking
//! the custody lock one mailbox at a time.

use crate::server::DaemonState;
use mailvault_core::custody::{db, import, lock, Connection, SharedConn};
use mailvault_core::search_index::slot::{install_if_current, SwitchGuard};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

pub struct CustodyState {
    pub db: Arc<SharedConn>,
    pub root: Mutex<Option<PathBuf>>,
    /// Why the store is closed, when an open failed. Cleared by a successful open.
    pub error: Mutex<Option<String>>,
    switch: SwitchGuard,
    /// Task 3.6 Step 4: monotonic, bumped by `with_conn` only when a write
    /// actually changed a row (`Connection::total_changes()` delta before vs
    /// after the closure runs), never by a WAL checkpoint, which touches
    /// `custody.db-wal`'s mtime with no row changed. `insights.rs` captures
    /// this at inventory time instead of stamping `custody.db`/`-wal` as
    /// ordinary files, so a checkpoint-only touch no longer invalidates an
    /// open snapshot mid-page.
    ///
    /// Fix F2: also bumped by `open_into` on a successful open and by
    /// `close`. `import_legacy` and `migrate`'s meta insert write on the raw
    /// connection before it is installed behind `with_conn`, so those writes
    /// would otherwise be invisible to the counter; bumping on open/close
    /// covers them, plus custody.db being replaced wholesale on disk under
    /// the same vault root.
    pub gen: AtomicU64,
}

impl Default for CustodyState {
    fn default() -> Self {
        Self {
            db: Arc::new(Mutex::new(None)),
            root: Mutex::new(None),
            error: Mutex::new(None),
            switch: SwitchGuard::default(),
            gen: AtomicU64::new(0),
        }
    }
}

fn g<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Open the store for the current vault root. The legacy import is a
/// separate, backgrounded pass (`run_legacy_import`). Gated on `mail_dir_ok` only (never `state.app_dir`: an
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
            if !install_if_current(&st.db, &st.switch, gen, conn) {
                // A close() started while this opened: the connection is
                // dropped, and `close` already cleared root/error.
                return Ok(());
            }
            // Fix F2: `migrate`'s meta insert (inside `db::open`) writes to
            // custody.db on the raw connection, before it is ever installed
            // behind `with_conn`, and does not bump the counter on its own.
            // A successful open bumps
            // it here instead, which also covers custody.db being replaced
            // wholesale on disk while the vault root stays the same: only a
            // fresh open can see that, and now it does.
            st.gen.fetch_add(1, Ordering::Relaxed);
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

/// The one-time move of legacy JSON records into the store, one custody lock
/// per unit. The scan is filesystem-only and runs before the first lock, then
/// each mailbox is imported under its own `with_conn` — the same
/// per-mailbox-batch rule `handlers::common::with_vault_write` documents, so
/// a `load_email_cache` landing mid-import waits for one mailbox, never for
/// the whole vault. Stops early when the store closes under it (a vault move).
pub fn run_legacy_import(state: &DaemonState) {
    if !state.mail_dir_ok {
        return;
    }
    let root = state.data_dir.clone();
    let units = import::legacy_units(&root);
    if units.is_empty() {
        return;
    }
    let started = std::time::Instant::now();
    let stamp = import::stamp_now();
    let mut report = import::ImportReport::default();
    for unit in &units {
        let mut one = import::ImportReport::default();
        if let Err(e) = with_conn(state, |c| {
            import::import_unit(c, &root, unit, stamp, &mut one);
            Ok(())
        }) {
            warn!("custody import: stopped after {:?} — {e}", started.elapsed());
            return;
        }
        merge(&mut report, one);
    }
    for (path, why) in &report.errors {
        warn!("custody import: {} left in place: {why}", path.display());
    }
    if report.files > 0
        || report.renamed_caches > 0
        || report.imported_header_rows > 0
        || report.imported_mailbox_caches > 0
        || !report.errors.is_empty()
    {
        info!("custody import: {report:?} in {:?}", started.elapsed());
    }
}

fn merge(into: &mut import::ImportReport, from: import::ImportReport) {
    into.files += from.files;
    into.imported += from.imported;
    into.kept_existing += from.kept_existing;
    into.skipped_no_uid += from.skipped_no_uid;
    into.renamed_caches += from.renamed_caches;
    into.imported_header_rows += from.imported_header_rows;
    into.imported_mailbox_caches += from.imported_mailbox_caches;
    into.skipped_imported += from.skipped_imported;
    into.errors.extend(from.errors);
}

/// `run_legacy_import` on its own thread: the daemon must answer RPCs while
/// it runs. Named, like the search index worker, so a sample names it.
pub fn spawn_legacy_import(state: Arc<DaemonState>) {
    if let Err(e) = std::thread::Builder::new()
        .name("custody-import".into())
        .spawn(move || run_legacy_import(&state))
    {
        warn!("custody import: thread did not start: {e}");
    }
}

/// Before a vault operation: release the file. Drop = checkpoint, so the
/// `-wal` is gone and a copy of `custody.db` alone is complete.
pub fn close(state: &DaemonState) {
    let st = &state.custody;
    st.switch.begin_switch(&st.db);
    *g(&st.root) = None;
    *g(&st.error) = None; // closed is closed; a stale error belongs to a root no longer current
    st.gen.fetch_add(1, Ordering::Relaxed); // Fix F2: a closed store is a changed store too
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

/// `with_conn` logs a lock wait or hold at or past these.
const SLOW_LOCK_WAIT: Duration = Duration::from_millis(100);
const SLOW_LOCK_HOLD: Duration = Duration::from_millis(250);

/// Run `f` on the open store. `Err` with the open failure while it is closed:
/// a caller never mistakes a store it could not read for "no entries".
///
/// Task 3.6 Step 4: also bumps `gen` when `f` actually changed a row.
/// `Connection::total_changes()` is SQLite's own monotonic per-connection
/// counter of rows changed by completed INSERT/UPDATE/DELETE statements: a
/// plain `SELECT` (every read call site) never moves it, and a bump only
/// fires on the delta across THIS call, so a read landing after some
/// earlier write never misreads that write's stale nonzero count as its
/// own. This is the one chokepoint every custody write already goes
/// through (`handlers::archive`, `handlers::custody`, `handlers::vault_flags`
/// all call `with_conn`), so the counter needs no changes anywhere else.
///
/// Every custody.db reader and writer (header cache, sync, archive) shares
/// this one lock, so a slow wait or a long hold is logged with the calling
/// site (`#[track_caller]`: no signature change at the call sites). Under
/// the thresholds the cost is three clock reads.
#[track_caller]
pub fn with_conn<T>(state: &DaemonState, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let st = &state.custody;
    let caller = std::panic::Location::caller();
    let asked = Instant::now();
    let guard = lock(&st.db);
    let acquired = Instant::now();
    let result = match guard.as_ref() {
        Some(conn) => {
            let before = conn.total_changes();
            let result = f(conn);
            if conn.total_changes() != before {
                st.gen.fetch_add(1, Ordering::Relaxed);
            }
            result
        }
        None => Err(format!("custody store unavailable: {}", g(&st.error).clone().unwrap_or_else(|| "closed".into()))),
    };
    drop(guard);
    note_lock_timing(caller, asked, acquired);
    result
}

/// The slow-lock log line, shared with the two holders that lock the same
/// connection directly instead of through `with_conn` (sync's `CacheCtx`,
/// the contacts index). Call after the guard is dropped.
pub fn note_lock_timing(caller: &std::panic::Location<'_>, asked: Instant, acquired: Instant) {
    let (wait, hold) = (acquired - asked, acquired.elapsed());
    if wait >= SLOW_LOCK_WAIT || hold >= SLOW_LOCK_HOLD {
        warn!("[custody] lock slow at {caller}: waited {} ms, held {} ms", wait.as_millis(), hold.as_millis());
    }
}

/// The live write counter (Task 3.6 Step 4). `insights.rs` reads this fresh
/// at `begin`/`read` time instead of stamping `custody.db`/`-wal` as files.
pub fn generation(state: &DaemonState) -> u64 {
    state.custody.gen.load(Ordering::Relaxed)
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

    /// 2026-09-20: the import used to run inside `open_into`, which the
    /// daemon awaited before binding its socket — 416 s of no mail and no
    /// helper on a real vault. The open must be fast and legacy-free; the
    /// rows arrive from the backgrounded pass.
    #[test]
    fn the_open_imports_nothing_and_the_background_pass_does() {
        let (vault, _app, s) = state(true);
        let root = vault.path();
        std::fs::create_dir_all(root.join("mailboxes/acct")).unwrap();
        std::fs::write(
            root.join("mailboxes/acct/mailboxes.json"),
            serde_json::json!({"mailboxes": [{"path": "INBOX"}]}).to_string(),
        )
        .unwrap();
        let sidecar = mailvault_core::header_cache::sidecar_dir(root, "acct", "INBOX");
        std::fs::create_dir_all(&sidecar).unwrap();
        std::fs::write(sidecar.join("1.json"), serde_json::json!({"uid": 1, "subject": "one"}).to_string()).unwrap();

        open_into(&s).unwrap();
        let before = with_conn(&s, |c| mailvault_core::custody::cache::load_by_uids(c, "acct", "INBOX", &[1])).unwrap();
        assert!(before.is_empty(), "the open must not import");

        run_legacy_import(&s);
        let after = with_conn(&s, |c| mailvault_core::custody::cache::load_by_uids(c, "acct", "INBOX", &[1])).unwrap();
        assert_eq!(after.len(), 1, "the background pass imports the legacy rows");

        // And a second pass reads nothing: the marker row, not the files.
        run_legacy_import(&s);
        let again = with_conn(&s, |c| mailvault_core::custody::cache::load_by_uids(c, "acct", "INBOX", &[1])).unwrap();
        assert_eq!(again.len(), 1);
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
        // `DaemonState::for_test` opens custody the way startup does; drop
        // that connection before replacing the file underneath it.
        *lock(&s.custody.db) = None;
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
        // The state under test is the one before startup's open lands.
        *lock(&s.custody.db) = None;
        *g(&s.custody.root) = None;
        let status = status_json(&s);
        assert_eq!((status["available"].as_bool(), status["error"].is_null(), status["path"].is_null()), (Some(false), true, true));
        let err = with_conn(&s, |c| entries::read(c, "acct", "INBOX")).unwrap_err();
        assert_eq!(err, "custody store unavailable: closed");
    }

    /// Inventory-custody-plumbing headline 3 / plan Step 1 said a read must
    /// never answer before the legacy `local-index.json` import has run. That
    /// invariant cost 416 s of blocked socket on a real vault (2026-09-20)
    /// and is deliberately gone: the import is a background pass, and a
    /// mailbox it has not reached yet reads as empty, never as wrong.
    #[test]
    fn the_legacy_index_import_runs_in_the_background_pass() {
        let (vault, _app, s) = state(true);
        let index_dir = vault.path().join("maildir").join("acct").join("INBOX");
        std::fs::create_dir_all(&index_dir).unwrap();
        std::fs::write(
            index_dir.join("local-index.json"),
            r#"[{"uid":7,"source":"local_draft","flags":["draft"]}]"#,
        )
        .unwrap();

        let _ = open_into(&s);
        assert!(with_conn(&s, |c| entries::read(c, "acct", "INBOX")).unwrap().is_none(), "the open imports nothing");
        assert!(index_dir.join("local-index.json").exists(), "and retires nothing");

        run_legacy_import(&s);

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

    /// Task 3.6 Step 4: the counter `insights.rs` now compares against
    /// instead of stamping `custody.db`/`-wal` as ordinary files. Baselined
    /// right after `open_into` (Fix F2 bumps the counter on a successful
    /// open, covered separately below), so this test's own assertions stay
    /// about `with_conn`'s behavior only.
    #[test]
    fn with_conn_bumps_the_generation_only_when_a_write_actually_changes_a_row() {
        let (_vault, _app, s) = state(true);
        let _ = open_into(&s);
        let base = generation(&s);

        // A read must not bump it.
        let _ = with_conn(&s, |c| entries::read(c, "acc", "INBOX"));
        assert_eq!(generation(&s), base, "a read must not bump the write counter");

        // A real write bumps it.
        with_conn(&s, |c| entries::upsert(c, "acc", "INBOX", &[json!({"uid": 1, "flags": []})]).map(|_| ())).unwrap();
        assert_eq!(generation(&s), base + 1);

        // Deleting a uid that was never there executes a statement that
        // changes no row: this is the "checkpoint-only touch" case, the
        // counter must not move for a no-op write attempt either.
        with_conn(&s, |c| entries::remove(c, "acc", "INBOX", &[999]).map(|_| ())).unwrap();
        assert_eq!(generation(&s), base + 1, "a no-op delete must not bump the write counter");

        // Removing the uid that IS there is a second real write.
        with_conn(&s, |c| entries::remove(c, "acc", "INBOX", &[1]).map(|_| ())).unwrap();
        assert_eq!(generation(&s), base + 2);
    }

    /// Fix F2 (review follow-up on Task 3.6 Step 4): `import_legacy` and
    /// `migrate`'s meta insert write to custody.db directly on the raw
    /// connection inside `db::open`, before it is ever installed behind
    /// `with_conn`, and those writes bump nothing on their own. `open_into` and
    /// `close` must bump the generation themselves so a fresh open
    /// (including one that would replace custody.db wholesale on disk) is
    /// visible to a snapshot that captured the counter beforehand, even with
    /// no `with_conn` write in between.
    #[test]
    fn open_into_bumps_the_generation_even_with_no_with_conn_write() {
        let (_vault, _app, s) = state(true);
        assert_eq!(generation(&s), 0);
        let _ = open_into(&s);
        assert_eq!(generation(&s), 1, "a successful open must bump the generation");

        close(&s);
        assert_eq!(generation(&s), 2, "close must bump the generation too");

        let _ = reopen(&s);
        assert_eq!(generation(&s), 3, "reopen bumps again, on top of close's bump");
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
