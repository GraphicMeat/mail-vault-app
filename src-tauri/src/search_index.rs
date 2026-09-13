//! The app side of the offline search index: one connection in managed state,
//! one background worker, the configure/status/rebuild commands, and closing
//! the index around vault switches. The logic lives in
//! `mailvault_core::search_index`. Spec: docs/superpowers/specs/2026-09-13-offline-search-index-design.md §6.
//!
//! Only the worker thread opens the index (it runs `quick_check`); the main
//! thread and tokio workers never open it or wait on its mutex.
//!
//! Lock order: `db` may be held while `root` or `phase` is taken (status_json,
//! vault_search); never take `root` or `phase` and then `db`.

use mailvault_core::search_index::{self as core, db, lock, reconcile::{self, IndexConfig, IndexDoc}, SharedConn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tracing::{info, warn};

/// The longest gap between full passes, however many nudges arrive in between.
pub(crate) const SWEEP_EVERY: Duration = Duration::from_secs(15 * 60);

pub enum Signal {
    Sweep,
    Nudge { account_id: String, vault_dir: String },
    Rebuild,
    /// The config itself is read from state on every pass; this only wakes the worker.
    Configure,
    /// A vault operation finished: open the current root, then a full pass.
    Reopen,
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

/// The text the index holds for a list row: the longer of its text part and its
/// HTML part as text. Newsletters often ship a one-line text stub ("View this
/// email in your browser") with the whole message only in the HTML.
fn body_of(row: &serde_json::Value) -> String {
    let text = row.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let html = row.get("html").and_then(|v| v.as_str()).map(core::text::html_to_text).unwrap_or_default();
    // Trimmed, so a whitespace-only text part never beats real HTML text.
    if html.trim().chars().count() > text.trim().chars().count() { html } else { text.to_string() }
}

/// A list-row address as `Name <address>`, or the bare address.
fn addr_text(v: &serde_json::Value) -> String {
    let a = v.get("address").and_then(|x| x.as_str()).unwrap_or("");
    match v.get("name").and_then(|x| x.as_str()) {
        Some(n) if !n.is_empty() => format!("{n} <{a}>"),
        _ => a.to_string(),
    }
}

/// `ParseFn` for core: the list-row parser, so rows and the index agree on one parser.
pub fn index_doc_from_light(raw: &[u8], uid: u32, filename: &str) -> Option<IndexDoc> {
    let email = crate::parse_eml_bytes_light(raw, uid, crate::parse_flags_from_filename(filename)).ok()?;
    let mut row = serde_json::to_value(&email).ok()?;
    let body_text = body_of(&row);
    let obj = row.as_object_mut()?;
    for k in ["text", "html", "flags"] {
        obj.remove(k);
    }
    let from = obj.get("from").cloned().unwrap_or(serde_json::Value::Null);
    let mut addrs = vec![addr_text(&from)];
    for key in ["to", "cc", "bcc", "replyTo"] {
        if let Some(list) = obj.get(key).and_then(|v| v.as_array()) {
            addrs.extend(list.iter().map(addr_text));
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

/// Before a vault operation: stop the sweep and release the files. Waits on the
/// DB mutex, so callers run it on a blocking thread.
pub fn close(app: &tauri::AppHandle) {
    let st = app.state::<SearchIndexState>();
    st.interrupt.store(true, SeqCst); // a running sweep stops at its next check
    *lock(&st.db) = None; // drop = checkpoint + remove -wal
    *g(&st.root) = None;
}

/// After a vault operation, success or not: the worker opens whatever root is
/// current then. Status reports `available: false` until it has.
pub fn reopen(app: &tauri::AppHandle) {
    send(&app.state::<SearchIndexState>(), Signal::Reopen);
}

fn send(st: &SearchIndexState, s: Signal) {
    if let Some(tx) = g(&st.signals).as_ref() {
        let _ = tx.send(s);
    }
}

/// A vault writer changed `mailbox`: reconcile that folder soon. A channel
/// send, so a writer never waits on the index.
pub fn nudge(app: &tauri::AppHandle, account_id: &str, mailbox: &str) {
    if let Some(st) = app.try_state::<SearchIndexState>() {
        send(&st, Signal::Nudge { account_id: account_id.into(), vault_dir: core::text::vault_dir_name(mailbox) });
    }
}

/// A change wider than one folder (a mailbox rename moves whole directories): a full pass soon.
pub fn sweep_soon(app: &tauri::AppHandle) {
    if let Some(st) = app.try_state::<SearchIndexState>() {
        send(&st, Signal::Sweep);
    }
}

/// One row per hit, in hit order: the list row read from the hit's own file,
/// plus `vaultDir`, `snippet` and `matchedIn`. The index knows each filename,
/// so there is no folder listing; `read_light_at` rescans once only if the file
/// was renamed since (a flag change). A hit whose file is gone, or whose uid now
/// holds a message with another Message-ID, is dropped and `total` still counts
/// it until the next sweep: transient, never a wrong row.
pub fn assemble_rows(root: &Path, account_id: &str, page: &core::query::SearchPage) -> Vec<serde_json::Value> {
    page.hits
        .iter()
        .filter_map(|h| {
            let cur = root.join("Maildir").join(account_id).join(&h.vault_dir).join("cur");
            let email = crate::read_light_at(&cur, h.uid, Some(&cur.join(&h.filename)))?;
            let mut row = serde_json::to_value(&email).ok()?;
            // A UID reissue repair since the last sweep can give this uid to another
            // message: that row is not this hit. Same parser on both sides, so exact.
            if let Some(indexed) = &h.message_id {
                if row.get("messageId").and_then(|v| v.as_str()) != Some(indexed.as_str()) {
                    return None;
                }
            }
            let body = body_of(&row);
            let subject = row.get("subject").and_then(|s| s.as_str()).unwrap_or("").to_string();
            // Names and addresses only: the JSON text around them would match `name` or `address`.
            let from = addr_text(&row["from"]);
            let to = ["to", "cc", "bcc"]
                .iter()
                .filter_map(|k| row.get(*k)?.as_array())
                .flatten()
                .map(addr_text)
                .collect::<Vec<_>>()
                .join(" ");
            let matched: Vec<&str> = [("subject", &subject), ("from", &from), ("to", &to), ("body", &body)]
                .into_iter()
                .filter(|(_, text)| page.needles.iter().any(|n| core::text::contains_folded(text, n)))
                .map(|(label, _)| label)
                .collect();
            let obj = row.as_object_mut()?;
            obj.insert("vaultDir".into(), h.vault_dir.clone().into());
            obj.insert("snippet".into(), core::text::snippet(&body, &page.needles, 160).into());
            obj.insert("matchedIn".into(), matched.into());
            Some(row)
        })
        .collect()
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

/// Spawn the worker, which opens the index before its first wait. Called from
/// `setup` after `vault::resolve`.
pub fn start(app: &tauri::AppHandle) {
    let st = app.state::<SearchIndexState>();
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
    pub reopen: bool,
    pub rebuild: bool,
    /// `Some` only when every signal was a nudge for this one folder; otherwise a full pass.
    pub only: Option<(String, String)>,
}

pub(crate) fn plan(queue: Vec<Signal>) -> Plan {
    let mut p = Plan { reopen: false, rebuild: false, only: None };
    let mut full = false;
    let mut nudges: Vec<(String, String)> = Vec::new();
    for s in queue {
        match s {
            Signal::Reopen => {
                p.reopen = true;
                full = true;
            }
            Signal::Rebuild => {
                p.rebuild = true;
                full = true;
            }
            Signal::Sweep | Signal::Configure => full = true,
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

/// A scoped pass becomes a full one once the last full pass is `SWEEP_EVERY` old.
pub(crate) fn needs_full(since_last_full: Duration, planned_full: bool) -> bool {
    planned_full || since_last_full >= SWEEP_EVERY
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BodiesAction {
    None,
    /// No flag stored (fresh index): write it, nothing to strip or re-parse.
    RecordOnly,
    Toggle,
}

/// Compare the stored `bodies_enabled` flag with the configured setting.
pub(crate) fn bodies_action(stored: Option<&str>, want: bool) -> BodiesAction {
    match stored {
        None => BodiesAction::RecordOnly,
        Some(s) if s == if want { "1" } else { "0" } => BodiesAction::None,
        Some(_) => BodiesAction::Toggle,
    }
}

fn worker(app: tauri::AppHandle, rx: mpsc::Receiver<Signal>) {
    let st = app.state::<SearchIndexState>();
    open_into(&app, &st); // here, not in setup: open runs quick_check
    let mut last_full = Instant::now();
    loop {
        // An interrupt still set here arrived after the last drain: its signal was
        // either drained already (its pass was cut short) or is queued. Go again now.
        let first = if st.interrupt.load(SeqCst) {
            Signal::Sweep
        } else {
            // Counted from the last full pass, so a stream of nudges cannot postpone it.
            match rx.recv_timeout(SWEEP_EVERY.saturating_sub(last_full.elapsed())) {
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
        let Plan { reopen, rebuild, only } = plan(queue);
        let full = needs_full(last_full.elapsed(), only.is_none());
        run_pass(&app, &st, reopen, rebuild, if full { None } else { only });
        // Not cut short = complete. A pass skipped because the index is unconfigured
        // or closed counts too: the configure or reopen that changes that forces its
        // own full pass. Resetting here is also what keeps a zero timeout from spinning.
        if full && !st.interrupt.load(SeqCst) {
            last_full = Instant::now();
        }
    }
}

fn run_pass(app: &tauri::AppHandle, st: &SearchIndexState, reopen: bool, rebuild: bool, only: Option<(String, String)>) {
    if reopen {
        open_into(app, st);
    }
    let Some(config) = *g(&st.config) else { return }; // nothing until the frontend configures
    if rebuild {
        rebuild_index(app, st);
    }
    // Read after a reopen or rebuild, which resolve the vault root afresh.
    let Some(root) = g(&st.root).clone() else { return };
    let maildir = root.join("Maildir");

    // Every pass, not only after a configure: one drained while the index was
    // closed, or a toggle that lost a race with a vault switch, lands here.
    let action = {
        let guard = lock(&st.db);
        let Some(conn) = guard.as_ref() else { return };
        let stored = match db::meta_get_checked(conn, "bodies_enabled") {
            Ok(v) => v,
            Err(e) => {
                // Read as "unset", a failed read would record over the real flag and
                // skip stripping bodies the user turned off. The next pass retries.
                warn!("search index: reading the bodies setting failed: {e}");
                return;
            }
        };
        let action = bodies_action(stored.as_deref(), config.bodies);
        if action == BodiesAction::RecordOnly {
            if let Err(e) = db::meta_set(conn, "bodies_enabled", if config.bodies { "1" } else { "0" }) {
                // Sweeping without the flag could index bodies a later "off" would never strip.
                warn!("search index: recording the bodies setting failed: {e}");
                return;
            }
        }
        action
    };
    if action == BodiesAction::Toggle {
        match reconcile::set_bodies_enabled(&st.db, config.bodies) {
            Ok(()) => {}
            Err(e) if e.contains("closed") => return, // the next pass retries
            Err(e) => warn!("search index: bodies toggle failed: {e}"),
        }
    }
    sweep(app, st, &maildir, config, only);
    // Deferred optimize + VACUUM + WAL truncate after bodies-off, only when nothing is pending.
    if !st.interrupt.load(SeqCst) {
        match reconcile::compact_if_pending(&st.db) {
            Ok(true) => emit(app, st),
            Ok(false) => {}
            Err(e) => warn!("search index compaction: {e}"),
        }
    }
}

/// Delete the index files and open a fresh index. A file that will not go is
/// never reopened: the index stays unavailable instead.
fn rebuild_index(app: &tauri::AppHandle, st: &SearchIndexState) {
    let Some(root) = g(&st.root).clone() else { return };
    *lock(&st.db) = None; // drop = checkpoint; then the files can go
    let dir = root.join(db::DB_DIR);
    let mut stuck = false;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = dir.join(format!("{}{suffix}", db::DB_FILE));
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("search index rebuild: cannot remove {}: {e}", path.display());
                stuck = true;
            }
        }
    }
    if stuck {
        *g(&st.root) = None;
        *g(&st.phase) = "unavailable";
        emit(app, st);
    } else {
        open_into(app, st);
    }
}

fn sweep(app: &tauri::AppHandle, st: &SearchIndexState, maildir: &Path, config: IndexConfig, only: Option<(String, String)>) {
    *g(&st.phase) = "indexing";
    emit(app, st);
    let keep_going = || lock(&st.db).is_some() && !st.interrupt.load(SeqCst);
    let full = only.is_none();
    let (dirs, listed) = match only {
        Some(pair) => (vec![pair], true),
        None => match reconcile::list_vault_dirs(maildir) {
            Ok(dirs) => (dirs, true),
            Err(e) => {
                warn!("search index: listing the vault failed: {e}");
                (Vec::new(), false)
            }
        },
    };
    // A listing that failed is not "these folders are gone": no prune.
    if full && listed {
        let disk_total = reconcile::count_disk_files(maildir); // walk the vault BEFORE taking the lock
        // A close during the walk: the listing is of a vault that is no longer open.
        if keep_going() {
            if let Some(conn) = lock(&st.db).as_ref() {
                let _ = db::meta_set(conn, "disk_total", &disk_total.to_string());
            }
        }
        // An unplugged or unreadable vault lists nothing; pruning then would drop the whole index.
        if maildir.is_dir() && keep_going() {
            if let Err(e) = reconcile::prune_missing_dirs(&st.db, &dirs) {
                warn!("search index prune: {e}");
            }
        }
    }
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

/// `{ available: false }` until the worker has opened the index.
#[tauri::command]
pub async fn vault_search(app: tauri::AppHandle, request: core::query::SearchRequest) -> Result<serde_json::Value, String> {
    off_main(app, move |st| {
        let (root, page, counts) = {
            let guard = lock(&st.db);
            // Root read under the db lock, so it is the root this connection was opened for.
            let (Some(conn), Some(root)) = (guard.as_ref(), g(&st.root).clone()) else {
                return Ok(serde_json::json!({ "available": false }));
            };
            (root, core::query::search(conn, &request)?, db::counts(conn))
        }; // released before any file is read
        let rows = assemble_rows(&root, &request.account_id, &page);
        Ok(serde_json::json!({
            "available": true,
            "rows": rows,
            "total": page.total,
            "indexed": counts.indexed,
            "totalMessages": counts.total,
            "complete": counts.total > 0 && counts.indexed >= counts.total,
        }))
    })
    .await?
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
        send(st, Signal::Configure);
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
