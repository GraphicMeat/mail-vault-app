//! The app side of the offline search index: one connection in managed state,
//! one background worker, the configure/status/rebuild commands, and closing
//! the index around vault switches. The logic lives in
//! `mailvault_core::search_index`. Spec: docs/superpowers/specs/2026-09-13-offline-search-index-design.md §6.
//!
//! Lock order: `db` may be held while `root` or `phase` is taken (status_json
//! only); never take `root` or `phase` and then `db`.

use mailvault_core::search_index::{self as core, db, lock, reconcile::{self, IndexConfig, IndexDoc}, SharedConn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{mpsc, Mutex};
use tauri::{Emitter, Manager};
use tracing::{info, warn};

const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(15 * 60);

pub enum Signal {
    Sweep,
    Nudge { account_id: String, vault_dir: String },
    Rebuild,
    Configure(IndexConfig),
}

#[derive(Default)]
pub struct SearchIndexState {
    pub db: SharedConn,
    root: Mutex<Option<PathBuf>>,
    config: Mutex<Option<IndexConfig>>,
    signals: Mutex<Option<mpsc::Sender<Signal>>>,
    phase: Mutex<&'static str>, // "idle" | "indexing" | "unavailable"
    /// Set by configure, rebuild and close so a running sweep stops at its next batch boundary.
    interrupt: AtomicBool,
}

fn g<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// `ParseFn` for core: the list-row parser, so rows and the index agree on one parser.
pub fn index_doc_from_light(raw: &[u8], uid: u32, filename: &str) -> Option<IndexDoc> {
    let email = crate::parse_eml_bytes_light(raw, uid, crate::parse_flags_from_filename(filename)).ok()?;
    let mut row = serde_json::to_value(&email).ok()?;
    let obj = row.as_object_mut()?;
    let body_text = match (obj.get("text").and_then(|v| v.as_str()), obj.get("html").and_then(|v| v.as_str())) {
        (Some(t), _) if !t.trim().is_empty() => t.to_string(),
        (_, Some(h)) => core::text::html_to_text(h),
        _ => String::new(),
    };
    for k in ["text", "html", "flags"] {
        obj.remove(k);
    }
    let addr = |v: &serde_json::Value| -> String {
        let a = v.get("address").and_then(|x| x.as_str()).unwrap_or("");
        match v.get("name").and_then(|x| x.as_str()) {
            Some(n) if !n.is_empty() => format!("{n} <{a}>"),
            _ => a.to_string(),
        }
    };
    let from = obj.get("from").cloned().unwrap_or(serde_json::Value::Null);
    let mut addrs = vec![addr(&from)];
    for key in ["to", "cc", "bcc", "replyTo"] {
        if let Some(list) = obj.get(key).and_then(|v| v.as_array()) {
            addrs.extend(list.iter().map(addr));
        }
    }
    Some(IndexDoc {
        message_id: obj.get("messageId").and_then(|v| v.as_str()).map(String::from),
        date_utc: obj.get("date").and_then(|v| v.as_str()).and_then(|d| mailparse::dateparse(d).ok()),
        from_addr: from.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        from_name: from.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        addrs: addrs.into_iter().filter(|a| !a.is_empty()).collect(),
        subject: obj.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        body_text,
        has_attachments: obj.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false),
        row_json: serde_json::to_string(&row).ok()?,
    })
}

fn open_into(app: &tauri::AppHandle, st: &SearchIndexState) {
    let root = match crate::vault::root(app) {
        Ok(r) => r,
        Err(e) => {
            warn!("search index: no vault root: {e}");
            *g(&st.root) = None; // root None = closed: the worker skips its pass
            *g(&st.phase) = "unavailable";
            return;
        }
    };
    // One connection per file: the exclusive lock of a stale one would make this open BUSY.
    *lock(&st.db) = None;
    match db::open(&root) {
        Ok(conn) => {
            // root and phase first, so a status read never sees an open DB with a stale phase.
            *g(&st.root) = Some(root);
            *g(&st.phase) = "idle";
            *lock(&st.db) = Some(conn);
        }
        Err(e) => {
            warn!("search index unavailable: {e}");
            *g(&st.root) = None;
            *g(&st.phase) = "unavailable";
        }
    }
}

/// Before a vault operation: stop the sweep and release the files.
pub fn close(app: &tauri::AppHandle) {
    let st = app.state::<SearchIndexState>();
    st.interrupt.store(true, SeqCst); // a running sweep stops at its next check
    *lock(&st.db) = None; // drop = checkpoint + remove -wal
    *g(&st.root) = None;
}

/// After a vault operation, success or not: open whatever root is current now.
pub fn reopen(app: &tauri::AppHandle) {
    let st = app.state::<SearchIndexState>();
    open_into(app, &st);
    send(&st, Signal::Sweep);
}

fn send(st: &SearchIndexState, s: Signal) {
    if let Some(tx) = g(&st.signals).as_ref() {
        let _ = tx.send(s);
    }
}

/// A vault writer changed `mailbox`: reconcile that folder soon.
#[allow(dead_code)] // callers land with the vault writers (Task 7)
pub fn nudge(app: &tauri::AppHandle, account_id: &str, mailbox: &str) {
    if let Some(st) = app.try_state::<SearchIndexState>() {
        send(&st, Signal::Nudge { account_id: account_id.into(), vault_dir: core::text::vault_dir_name(mailbox) });
    }
}

fn status_json(st: &SearchIndexState) -> serde_json::Value {
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else {
        return serde_json::json!({ "available": false, "state": "unavailable", "indexed": 0, "total": 0, "sizeBytes": 0, "complete": false });
    };
    let c = db::counts(conn);
    let size = g(&st.root).as_ref().map(|r| db::db_size_bytes(r)).unwrap_or(0);
    // counts() yields 0/0 on error: never "complete".
    serde_json::json!({ "available": true, "state": *g(&st.phase), "indexed": c.indexed, "total": c.total, "sizeBytes": size, "complete": c.total > 0 && c.indexed >= c.total })
}

fn emit(app: &tauri::AppHandle, st: &SearchIndexState) {
    let _ = app.emit("search-index-progress", status_json(st));
}

/// Open the index and spawn the worker. Called from `setup` after `vault::resolve`.
pub fn start(app: &tauri::AppHandle) {
    let st = app.state::<SearchIndexState>();
    open_into(app, &st);
    let (tx, rx) = mpsc::channel::<Signal>();
    *g(&st.signals) = Some(tx);
    let app = app.clone();
    std::thread::Builder::new()
        .name("search-index".into())
        .spawn(move || {
            #[cfg(target_os = "macos")]
            unsafe {
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
            }
            worker(app, rx);
        })
        .map(|_| ())
        .unwrap_or_else(|e| warn!("search index worker did not start: {e}"));
}

/// What one drained burst of signals asks the worker to do.
#[derive(Debug, PartialEq)]
pub(crate) struct Plan {
    pub rebuild: bool,
    /// The latest configure in the burst.
    pub configure: Option<IndexConfig>,
    /// `Some` only when every signal was a nudge for this one folder; otherwise a full sweep.
    pub only: Option<(String, String)>,
}

pub(crate) fn plan(queue: Vec<Signal>) -> Plan {
    let mut p = Plan { rebuild: false, configure: None, only: None };
    let mut full = false;
    let mut nudges: Vec<(String, String)> = Vec::new();
    for s in queue {
        match s {
            Signal::Configure(c) => {
                p.configure = Some(c);
                full = true;
            }
            Signal::Rebuild => {
                p.rebuild = true;
                full = true;
            }
            Signal::Sweep => full = true,
            Signal::Nudge { account_id, vault_dir } => nudges.push((account_id, vault_dir)),
        }
    }
    nudges.sort();
    nudges.dedup();
    if !full && nudges.len() == 1 {
        p.only = nudges.pop();
    }
    p
}

fn worker(app: tauri::AppHandle, rx: mpsc::Receiver<Signal>) {
    let st = app.state::<SearchIndexState>();
    loop {
        // An interrupt still set here arrived after the last drain: its signal was
        // either drained already (its pass was cut short) or is queued. Go again now.
        let first = if st.interrupt.load(SeqCst) {
            Signal::Sweep
        } else {
            match rx.recv_timeout(SWEEP_EVERY) {
                Ok(s) => s,
                Err(mpsc::RecvTimeoutError::Timeout) => Signal::Sweep,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        };
        // Cleared before the drain: a configure/rebuild that lands after this either
        // is drained now or leaves `interrupt` set and a queued signal.
        st.interrupt.store(false, SeqCst);
        let mut queue = vec![first];
        while let Ok(s) = rx.try_recv() {
            queue.push(s);
        }
        let Plan { rebuild, configure, only } = plan(queue);
        let Some(config) = *g(&st.config) else { continue }; // nothing until the frontend configures

        if rebuild {
            let current = g(&st.root).clone();
            if let Some(root) = current {
                *lock(&st.db) = None; // drop = checkpoint; then the files can go
                for suffix in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(root.join(db::DB_DIR).join(format!("{}{}", db::DB_FILE, suffix)));
                }
                open_into(&app, &st);
            }
        }
        // Read after a rebuild's reopen, which resolves the vault root afresh.
        let Some(root) = g(&st.root).clone() else { continue };
        let maildir = root.join("Maildir");

        if let Some(new) = configure {
            let current = lock(&st.db).as_ref().and_then(|c| db::meta_get(c, "bodies_enabled"));
            let want = if new.bodies { "1" } else { "0" };
            if current.as_deref() != Some(want) {
                if let Err(e) = reconcile::set_bodies_enabled(&st.db, new.bodies) {
                    warn!("search index: bodies toggle failed: {e}");
                }
            }
        }
        sweep(&app, &st, &maildir, config, only);
        // Deferred optimize + VACUUM + WAL truncate after bodies-off, only when nothing is pending.
        if !st.interrupt.load(SeqCst) {
            match reconcile::compact_if_pending(&st.db) {
                Ok(true) => emit(&app, &st),
                Ok(false) => {}
                Err(e) => warn!("search index compaction: {e}"),
            }
        }
    }
}

fn sweep(app: &tauri::AppHandle, st: &SearchIndexState, maildir: &Path, config: IndexConfig, only: Option<(String, String)>) {
    *g(&st.phase) = "indexing";
    emit(app, st);
    let full = only.is_none();
    let dirs = match only {
        Some(pair) => vec![pair],
        None => reconcile::list_vault_dirs(maildir),
    };
    if full {
        let disk_total = reconcile::count_disk_files(maildir); // walk the vault BEFORE taking the lock
        if let Some(conn) = lock(&st.db).as_ref() {
            let _ = db::meta_set(conn, "disk_total", &disk_total.to_string());
        }
        // An unplugged or unreadable vault lists nothing; pruning then would drop the whole index.
        if maildir.is_dir() {
            if let Err(e) = reconcile::prune_missing_dirs(&st.db, &dirs) {
                warn!("search index prune: {e}");
            }
        }
    }
    let keep_going = || lock(&st.db).is_some() && !st.interrupt.load(SeqCst);
    for (account, dir) in dirs {
        let mut on_batch = |_n: usize| emit(app, st);
        match reconcile::reconcile_mailbox(&st.db, maildir, &account, &dir, config, &index_doc_from_light, &keep_going, &mut on_batch) {
            Ok(s) if s.interrupted => break, // configure/rebuild/close asked us to stop
            Ok(s) if s.parsed + s.removed + s.renamed + s.failed > 0 => info!("search index {account}/{dir}: {s:?}"),
            Ok(_) => {}
            Err(e) if e.contains("closed") => break,
            Err(e) => warn!("search index {account}/{dir}: {e}"), // one bad folder must not stop the sweep
        }
    }
    let open = lock(&st.db).is_some();
    *g(&st.phase) = if open { "idle" } else { "unavailable" };
    emit(app, st);
}

/// Tauri 2 runs sync commands on the main thread, and the DB mutex can be held
/// for seconds by a sweep batch or compaction: every command runs off it.
async fn off_main<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&SearchIndexState) -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || f(&app.state::<SearchIndexState>()))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // attachments and image_text are read from phase 3 on
pub struct ConfigArgs {
    pub bodies: bool,
    #[serde(default)]
    pub attachments: bool,
    #[serde(default)]
    pub image_text: bool,
}

#[tauri::command]
pub async fn search_index_configure(app: tauri::AppHandle, config: ConfigArgs) -> Result<(), String> {
    off_main(app, move |st| {
        let cfg = IndexConfig { bodies: config.bodies };
        *g(&st.config) = Some(cfg);
        st.interrupt.store(true, SeqCst); // stop a running sweep at its next batch
        send(st, Signal::Configure(cfg));
    })
    .await
}

#[tauri::command]
pub async fn search_index_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    off_main(app, status_json).await
}

#[tauri::command]
pub async fn search_index_rebuild(app: tauri::AppHandle) -> Result<(), String> {
    off_main(app, |st| {
        st.interrupt.store(true, SeqCst);
        send(st, Signal::Rebuild);
    })
    .await
}
