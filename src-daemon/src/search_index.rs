//! The search index in the daemon (spec 2026-09-14 §5.3): a port of the app's
//! `src-tauri/src/search_index.rs` with `AppHandle` replaced by this state, which
//! owns the vault root (the daemon restarts on a vault switch) and the event bus.
//! Only the `search-index` thread opens the index (it runs quick_check).
//!
//! Lock order: `db` may be held while `root` or `phase` is taken; never take
//! `root`, `phase`, `enabled` or `config` and then `db`.

use crate::events::EventBus;
use mailvault_core::search_index::plan::{bodies_action, collect_burst, needs_full, plan, BodiesAction, Plan, Signal, COALESCE, SWEEP_EVERY};
use mailvault_core::search_index::reconcile::{self, AttachmentMeta, IndexConfig, IndexDoc};
use mailvault_core::search_index::slot::{install_if_current, SwitchGuard};
use mailvault_core::search_index::{self as core, db, lock, SharedConn};
use mailvault_core::maildir::vault_filename_uid;
use mailvault_core::vault_eml::{collect_attachment_parts, find_file_by_uid, parse_eml_bytes_light, parse_flags_from_filename, part_filename};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

pub struct SearchIndexState {
    pub db: SharedConn,
    pub(crate) root: Mutex<Option<PathBuf>>,
    pub(crate) vault_root: PathBuf,
    pub(crate) mail_dir_ok: bool,
    pub(crate) bus: EventBus,
    pub(crate) config: Mutex<Option<IndexConfig>>,
    /// None until the first configure; Some(false) = destroyed or switched off.
    pub(crate) enabled: Mutex<Option<bool>>,
    pub(crate) signals: Mutex<Option<mpsc::Sender<Signal>>>,
    pub(crate) phase: Mutex<&'static str>, // "idle" | "indexing" | "unavailable" | "off"
    pub(crate) interrupt: AtomicBool,
    pub(crate) switch: SwitchGuard,
    pub(crate) destroy_reply: Mutex<Vec<mpsc::Sender<Result<(), &'static str>>>>,
    /// Test-only: counts actual `read_dir` calls `prescan_folder_counts` makes
    /// (never a folder it already knows), per-state so parallel tests never
    /// interfere with each other's count.
    #[cfg(test)]
    pub(crate) prescan_reads: AtomicUsize,
}

impl SearchIndexState {
    pub fn new(vault_root: PathBuf, mail_dir_ok: bool, bus: EventBus) -> Arc<Self> {
        Arc::new(Self {
            db: Mutex::new(None),
            root: Mutex::new(None),
            vault_root,
            mail_dir_ok,
            bus,
            config: Mutex::new(None),
            enabled: Mutex::new(None),
            signals: Mutex::new(None),
            phase: Mutex::new("unavailable"),
            interrupt: AtomicBool::new(false),
            switch: SwitchGuard::default(),
            destroy_reply: Mutex::new(Vec::new()),
            #[cfg(test)]
            prescan_reads: AtomicUsize::new(0),
        })
    }
}

pub(crate) fn g<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
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

/// Upper bound on a MIME part's decoded body size, without decoding it: a
/// part's raw bytes (its own headers + still-encoded body) are always >= the
/// decoded body, since base64/quoted-printable only ever grow bytes. Lets
/// callers reject an oversized attachment before `get_body_raw()` allocates
/// the full decode.
fn encoded_part_size(part: &mailparse::ParsedMail) -> u64 {
    part.raw_bytes.len() as u64
}

/// `ParseFn` for core: the list-row parser, so rows and the index agree on one parser.
pub fn index_doc_from_light(raw: &[u8], uid: u32, filename: &str) -> Option<IndexDoc> {
    let email = parse_eml_bytes_light(raw, uid, parse_flags_from_filename(filename)).ok()?;
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
    // Attachment candidates need the real MIME tree; the light parse above
    // only surfaces text/html + headers. A full re-parse failure here just
    // means no candidates get listed (an unparseable message already fails
    // the light parse above and returns None before this point).
    let attachment_candidates = mailparse::parse_mail(raw)
        .map(|parsed| {
            let mut parts = Vec::new();
            collect_attachment_parts(&parsed, &mut parts);
            parts
                .into_iter()
                .map(|part| AttachmentMeta {
                    filename: part_filename(part),
                    mime: part.ctype.mimetype.clone(),
                    size: encoded_part_size(part),
                })
                .collect()
        })
        .unwrap_or_default();
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
        attachment_candidates,
    })
}

/// Read one attachment part's raw bytes off disk and re-parse the message it
/// lives in, for `reconcile::run_pending_extractions`'s `read_part` callback.
/// Looks the message up by uid (not by the `filename` recorded at the last
/// reconcile) so a flag rename since then does not miss it; `part_index` is
/// still keyed off `collect_attachment_parts`'s order, which is stable for a
/// given message body.
pub(crate) fn read_attachment_part(
    maildir_root: &Path,
    account_id: &str,
    vault_dir: &str,
    uid: u32,
    _filename: &str,
    part_index: usize,
) -> Option<(mailvault_core::search_index::attachments::AttachmentInput, IndexDoc)> {
    // account_id is NOT sanitized: a legacy, pre-migration account directory
    // is keyed by the raw email address (see vault_files::cur_path's doc).
    let cur = maildir_root.join(account_id).join(vault_dir).join("cur");
    let path = find_file_by_uid(&cur, uid)?;
    let raw = std::fs::read(&path).ok()?;
    let current_filename = path.file_name()?.to_string_lossy().into_owned();
    let parsed = mailparse::parse_mail(&raw).ok()?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let part = parts.get(part_index)?;
    let mime = part.ctype.mimetype.clone();
    let filename = part_filename(part);
    let doc = index_doc_from_light(&raw, uid, &current_filename)?;
    // Size-check the ENCODED bytes before ever decoding: get_body_raw() fully
    // base64-decodes the part into RAM, so a hostile multi-hundred-MB
    // attachment must be rejected before that allocation, not after. `extract()`
    // checks `input.size` against MAX_PART_BYTES before touching `input.bytes`
    // for anything but the actual text/office/pdf/image extraction branches,
    // so an empty placeholder here is safe and correctly classifies as too_large.
    let encoded_size = encoded_part_size(part);
    if encoded_size > mailvault_core::search_index::attachments::MAX_PART_BYTES {
        return Some((
            mailvault_core::search_index::attachments::AttachmentInput {
                filename,
                mime,
                size: encoded_size,
                bytes: Vec::new(),
            },
            doc,
        ));
    }
    let bytes = part.get_body_raw().ok()?;
    Some((
        mailvault_core::search_index::attachments::AttachmentInput {
            filename,
            mime,
            size: bytes.len() as u64,
            bytes,
        },
        doc,
    ))
}

/// One row per hit from the stored header cache. Current filename flags remain
/// authoritative; the reader revalidates the message when a result is opened.
pub fn assemble_rows(page: &core::query::SearchPage) -> Vec<serde_json::Value> {
    page.hits
        .iter()
        .filter_map(|h| {
            let mut row: serde_json::Value = serde_json::from_str(&h.row_json).ok()?;
            let subject = row.get("subject").and_then(Value::as_str).unwrap_or("");
            let from = addr_text(&row["from"]);
            let to = ["to", "cc", "bcc"]
                .iter()
                .filter_map(|key| row.get(*key)?.as_array())
                .flatten()
                .map(addr_text)
                .collect::<Vec<_>>()
                .join(" ");
            let mut matched_in = Vec::new();
            for (label, text) in [("subject", subject), ("from", from.as_str()), ("to", to.as_str())] {
                if page.needles.iter().any(|needle| core::text::contains_folded(text, needle)) {
                    matched_in.push(label);
                }
            }
            if h.body_matched {
                matched_in.push("body");
            }
            let flags = parse_flags_from_filename(&h.filename);
            let obj = row.as_object_mut()?;
            obj.insert("uid".into(), h.uid.into());
            obj.insert("vaultDir".into(), h.vault_dir.clone().into());
            obj.insert("flags".into(), serde_json::json!(flags));
            obj.insert("isArchived".into(), flags.iter().any(|f| f == "archived").into());
            obj.insert("matchedIn".into(), serde_json::json!(matched_in));
            Some(row)
        })
        .collect()
}

pub fn status_json(st: &SearchIndexState) -> Value {
    // `enabled` is read and released before `db` is locked (lock order).
    let enabled = *g(&st.enabled);
    if enabled == Some(false) {
        return serde_json::json!({ "available": false, "state": "off", "indexed": 0, "total": 0, "sizeBytes": 0, "complete": false, "firstPassDone": false });
    }
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else {
        return serde_json::json!({ "available": false, "state": "unavailable", "indexed": 0, "total": 0, "sizeBytes": 0, "complete": false, "firstPassDone": false });
    };
    let c = db::counts(conn);
    let size = g(&st.root).as_ref().map(|r| db::db_size_bytes(r)).unwrap_or(0);
    // counts() yields 0/0 on error: never "complete". Available whenever open, so
    // Settings shows a first build's progress; only vault_search waits for first_pass_done.
    serde_json::json!({
        "available": true,
        "state": *g(&st.phase),
        "indexed": c.indexed,
        "total": c.total,
        "sizeBytes": size,
        "complete": c.total > 0 && c.indexed >= c.total,
        "firstPassDone": db::first_pass_done(conn),
    })
}

pub(crate) fn emit(st: &SearchIndexState) {
    st.bus.emit("search-index-progress", status_json(st));
}

/// Returns explicit availability reasons so the daemon coordinator can decide
/// whether the local lane needs to read files.
pub fn search_reply(st: &SearchIndexState, request: &core::query::SearchRequest) -> Result<serde_json::Value, String> {
    // `enabled` is read and released before `db` is locked (lock order).
    if *g(&st.enabled) == Some(false) {
        return Ok(serde_json::json!({ "available": false, "reason": "off" }));
    }
    let (page, coverage, counts) = {
        let guard = lock(&st.db);
        let Some(conn) = guard.as_ref() else {
            return Ok(serde_json::json!({ "available": false, "reason": "unavailable" }));
        };
        // A first build (or a rebuild) still misses mail the scan finds.
        if !db::first_pass_done(conn) {
            return Ok(serde_json::json!({ "available": false, "reason": "building" }));
        }
        (
            core::query::search(conn, request)?,
            db::scope_coverage(conn, &request.account_id, request.mailboxes.as_deref())?,
            db::counts(conn),
        )
    };
    let rows = assemble_rows(&page);
    let uncovered_vault_dirs = coverage.uncovered_vault_dirs.clone();
    Ok(serde_json::json!({
        "available": true,
        "mode": "index",
        "rows": rows,
        "total": page.total,
        "coverage": coverage,
        "uncoveredVaultDirs": uncovered_vault_dirs,
        "indexed": counts.indexed,
        "totalMessages": counts.total,
        "complete": counts.total > 0 && counts.indexed >= counts.total,
    }))
}

/// The index's list rows for `uids` of one folder: `row_json` (headers,
/// attachments list, no body) with `flags` and `isArchived` read off the
/// CURRENT filename, so a flag rename since the last sweep is not stale here.
/// Only uids the index holds, in request order; the caller reads the rest
/// from their files. Empty while the index is closed. Replaces the
/// archived-headers cache file, which was these rows with a second copy of
/// the body text.
pub fn rows_reply(st: &SearchIndexState, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<serde_json::Value> {
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let vault_dir = core::text::vault_dir_name(mailbox);
    let mut stmt = match conn.prepare_cached("SELECT filename, row_json FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3") {
        Ok(s) => s,
        Err(e) => {
            warn!("vault_rows: {e}");
            return Vec::new();
        }
    };
    uids.iter()
        .filter_map(|uid| {
            let (filename, row_json): (String, String) = stmt
                .query_row((account_id, vault_dir.as_str(), *uid), |r| Ok((r.get(0)?, r.get(1)?)))
                .ok()?;
            let mut row: serde_json::Value = serde_json::from_str(&row_json).ok()?;
            let flags = parse_flags_from_filename(&filename);
            let obj = row.as_object_mut()?;
            obj.insert("uid".into(), (*uid).into());
            obj.insert("isArchived".into(), flags.iter().any(|f| f == "archived").into());
            obj.insert("flags".into(), serde_json::json!(flags));
            Some(row)
        })
        .collect()
}

fn yes() -> bool {
    true
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigArgs {
    #[serde(default = "yes")]
    pub enabled: bool,
    pub bodies: bool,
    #[serde(default)]
    pub attachments: bool,
    #[serde(default)]
    pub image_text: bool,
}

pub(crate) struct SweepOutcome {
    pub parsed: usize,
    pub completed: bool,
}

fn send(st: &SearchIndexState, s: Signal) {
    if let Some(tx) = g(&st.signals).as_ref() {
        let _ = tx.send(s);
    }
}

/// The vault's files are moving; its reopen() queues the open for afterwards.
/// Before the root is resolved and quick_check runs: a close() from here on
/// makes this open stale. Never opens while unconfigured or off (spec §5.5).
pub(crate) fn open_into(st: &SearchIndexState) {
    if st.switch.is_switching() {
        *g(&st.phase) = "unavailable";
        return;
    }
    if *g(&st.enabled) != Some(true) {
        return; // unconfigured or off: never create the file
    }
    if !st.mail_dir_ok {
        *g(&st.root) = None;
        *g(&st.phase) = "unavailable";
        return;
    }
    let gen = st.switch.current();
    *lock(&st.db) = None; // one connection per file: a stale exclusive lock would make this open BUSY
    match db::open(&st.vault_root) {
        Ok(conn) => {
            if !install_if_current(&st.db, &st.switch, gen, conn) {
                return; // a switch started while this opened: the connection is dropped
            }
            *g(&st.root) = Some(st.vault_root.clone());
            *g(&st.phase) = "idle";
            // A close() that landed between the install and here cleared root before this set it.
            if st.switch.current() != gen {
                *g(&st.root) = None;
                *g(&st.phase) = "unavailable";
            }
        }
        Err(e) => {
            warn!("search index unavailable: {e:?}");
            *g(&st.root) = None;
            *g(&st.phase) = "unavailable";
        }
    }
}

/// Before a vault operation: stop the sweep and release the files. Waits on
/// the DB mutex, so callers run it on a blocking thread. Until `reopen`, no
/// open in flight installs its connection and the worker neither sweeps nor deletes.
pub fn close(st: &SearchIndexState) {
    st.interrupt.store(true, SeqCst); // a running sweep stops at its next check
    st.switch.begin_switch(&st.db); // drop = checkpoint + remove -wal
    *g(&st.root) = None;
}

/// After a vault operation, success or not: the worker opens whatever root is
/// current then. Status reports `available: false` until it has.
pub fn reopen(st: &SearchIndexState) {
    st.switch.end_switch();
    send(st, Signal::Reopen);
}

/// A vault writer changed `mailbox`: reconcile that folder soon. A channel
/// send, so a writer never waits on the index.
pub fn nudge(st: &SearchIndexState, account_id: &str, mailbox: &str) {
    send(st, Signal::Nudge { account_id: account_id.into(), vault_dir: core::text::vault_dir_name(mailbox) });
}

/// A change wider than one folder (a mailbox rename moves whole directories): a full pass soon.
pub fn sweep_soon(st: &SearchIndexState) {
    send(st, Signal::Sweep);
}

pub fn configure(st: &SearchIndexState, args: ConfigArgs) {
    *g(&st.config) = Some(IndexConfig { bodies: args.bodies, attachments: args.attachments, image_text: args.image_text });
    *g(&st.enabled) = Some(args.enabled);
    st.interrupt.store(true, SeqCst); // stop a running sweep at its next batch
    let closed = lock(&st.db).is_none();
    if args.enabled && closed {
        send(st, Signal::Reopen);
    }
    send(st, Signal::Configure);
}

pub fn rebuild(st: &SearchIndexState) {
    st.interrupt.store(true, SeqCst);
    send(st, Signal::Rebuild);
}

/// Blocking (waits for the worker): call from spawn_blocking.
pub fn destroy(st: &SearchIndexState, timeout: Duration) -> Value {
    if st.switch.is_switching() {
        return serde_json::json!({"ok": false, "error": "searchIndex.busy"});
    }
    let before = std::mem::replace(&mut *g(&st.enabled), Some(false));
    let (tx, rx) = mpsc::channel();
    g(&st.destroy_reply).push(tx);
    st.interrupt.store(true, SeqCst);
    send(st, Signal::Destroy);
    match rx.recv_timeout(timeout) {
        Ok(Ok(())) => serde_json::json!({"ok": true}),
        Ok(Err(key)) => {
            if key == "searchIndex.busy" {
                // A switch began after the check above: nothing was deleted, so nothing is off.
                let mut enabled = g(&st.enabled);
                if *enabled == Some(false) {
                    *enabled = before;
                }
            }
            serde_json::json!({"ok": false, "error": key})
        }
        Err(_) => serde_json::json!({"ok": false, "error": "searchIndex.destroyFailed"}),
    }
}

/// Runs on the worker only, so no second thread touches the files.
fn destroy_index(st: &SearchIndexState) -> Result<(), &'static str> {
    // Review I1: while the vault is unreachable, `st.vault_root` is the
    // app-data FALLBACK root `resolve_mail_dir` hands back, never the real
    // vault. Unlinking there and reporting success would "delete" nothing
    // that matters while the real index survives untouched — worse than an
    // honest failure. `rebuild_index` is already safe here (it reads `root`,
    // which is `None` while unreachable, and returns early); this mirrors it.
    if !st.mail_dir_ok {
        return Err("searchIndex.destroyFailed");
    }
    if st.switch.is_switching() {
        return Err("searchIndex.busy");
    }
    let gen = st.switch.current();
    *lock(&st.db) = None; // drop = checkpoint; then the files can go
    *g(&st.root) = None;
    let dir = st.vault_root.join(db::DB_DIR);
    let mut stuck = false;
    // Reverse order (journal, shm, wal, then the database file itself): an
    // abort mid-delete (a switch starting between two unlinks) never leaves a
    // -wal without the index.db it belongs to.
    for suffix in ["-journal", "-shm", "-wal", ""] {
        // A vault operation may start between the check above and this unlink.
        if st.switch.is_switching() || st.switch.current() != gen {
            return Err("searchIndex.busy");
        }
        let path = dir.join(format!("{}{suffix}", db::DB_FILE));
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("search index destroy: cannot remove {}: {e}", path.display());
                stuck = true;
            }
        }
    }
    *g(&st.phase) = if stuck { "unavailable" } else { "off" };
    emit(st);
    if stuck {
        Err("searchIndex.destroyFailed")
    } else {
        Ok(())
    }
}

pub fn start(st: Arc<SearchIndexState>) {
    let (tx, rx) = mpsc::channel::<Signal>();
    *g(&st.signals) = Some(tx);
    let spawned = std::thread::Builder::new().name("search-index".into()).spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
        }
        info!("search index worker started");
        worker(&st, rx);
    });
    if let Err(e) = spawned {
        warn!("search index worker did not start: {e}");
    }
}

fn worker(st: &SearchIndexState, rx: mpsc::Receiver<Signal>) {
    open_into(st); // here, not in setup: open runs quick_check
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
        // A burst of two or more nudges waits up to COALESCE for the nudges behind it; a lone nudge runs now.
        let Plan { reopen, rebuild, destroy, only } = plan(collect_burst(first, &rx, COALESCE));
        if destroy {
            let outcome = destroy_index(st);
            let waiting = std::mem::take(&mut *g(&st.destroy_reply));
            for tx in waiting {
                let _ = tx.send(outcome);
            }
            if *g(&st.enabled) != Some(true) {
                continue;
            }
            // A configure {enabled:true} landed behind the destroy: plan() dropped its Reopen.
        }
        let full = needs_full(last_full.elapsed(), only.is_none());
        run_pass(st, reopen || destroy, rebuild, if full { None } else { only });
        // Not cut short = complete. A pass skipped because the index is unconfigured
        // or closed counts too: the configure or reopen that changes that forces its
        // own full pass. Resetting here is also what keeps a zero timeout from spinning.
        if full && !st.interrupt.load(SeqCst) {
            last_full = Instant::now();
        }
    }
}

fn run_pass(st: &SearchIndexState, reopen: bool, rebuild: bool, only: Option<Vec<(String, String)>>) {
    if st.switch.is_switching() {
        return; // the vault operation's reopen() sends a Reopen, which is a full pass
    }
    if reopen {
        open_into(st);
    }
    if *g(&st.enabled) != Some(true) {
        // Off: release a connection a configure {enabled:false} left open, once.
        if lock(&st.db).take().is_some() {
            *g(&st.root) = None;
            *g(&st.phase) = "off";
            emit(st);
        }
        return;
    }
    let Some(config) = *g(&st.config) else { return }; // nothing until the frontend configures
    if rebuild {
        rebuild_index(st);
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
    let _ = sweep(st, &maildir, config, only);
    // Attachment text extraction: gated on the same `attachments` toggle the
    // sweep above used to decide whether to write pending rows at all. Runs
    // under the same `conn` sweep just released, never a second connection.
    if config.attachments {
        let extractor = crate::attachment_extract::current_extractor();
        // config.attachments already reflects the JS-side premium check
        // (useSearchIndexConfig.js gates it on hasPremiumAccess); no
        // Rust-side general-premium entitlement exists to re-check here.
        let premium = true;
        let mut guard = lock(&st.db);
        if let Some(conn) = guard.as_mut() {
            reconcile::run_pending_extractions(
                conn,
                premium,
                config.image_text,
                config.bodies,
                &extractor,
                |account_id, vault_dir, uid, filename, part_index| read_attachment_part(&maildir, account_id, vault_dir, uid, filename, part_index),
                &|| !st.interrupt.load(SeqCst),
            );
        }
    }
    // Deferred optimize + VACUUM + WAL truncate after bodies-off, only when nothing is pending.
    if !st.interrupt.load(SeqCst) {
        match reconcile::compact_if_pending(&st.db) {
            Ok(true) => emit(st),
            Ok(false) => {}
            Err(e) => warn!("search index compaction: {e}"),
        }
    }
}

/// Delete the index files and open a fresh index. A file that will not go is
/// never reopened: the index stays unavailable instead.
fn rebuild_index(st: &SearchIndexState) {
    if st.switch.is_switching() {
        return;
    }
    let gen = st.switch.current();
    let Some(root) = g(&st.root).clone() else { return };
    *lock(&st.db) = None; // drop = checkpoint; then the files can go
    let dir = root.join(db::DB_DIR);
    let mut stuck = false;
    // Reverse order, same reasoning as destroy_index.
    for suffix in ["-journal", "-shm", "-wal", ""] {
        // A vault operation may be copying these files, or `root` is no longer the vault.
        if st.switch.is_switching() || st.switch.current() != gen {
            return;
        }
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
        emit(st);
    } else {
        open_into(st); // installs through install_if_current
    }
}

/// Task 1.10 review I1: a count-only listing of every NOT-YET-SCANNED listed
/// folder's `cur`, run once at the start of a full sweep before any folder is
/// reconciled, so `total` (`mailvault_core::search_index::db::counts`, summed
/// over `mailbox_scan.file_count`) counts every folder from the very first
/// progress emit after this prescan — not just the folders `reconcile_mailbox`
/// has already visited this pass.
///
/// Task 1.11 review I1: reads the known `mailbox_scan` keys ONCE and skips any
/// folder already in it (this pass or an earlier one) — after the first full
/// pass every folder has a row, so `INSERT OR IGNORE` was already a no-op on
/// every later full sweep (every `SWEEP_EVERY`, every configure, reconnect and
/// `sweep_soon`), but the `read_dir` of every folder was not: this used to
/// re-walk the WHOLE vault a second time on top of `reconcile_mailbox`'s own
/// listing, every 15 minutes. `reconcile_mailbox` still overwrites a known
/// folder's row with `INSERT OR REPLACE` once it actually visits it. Also
/// checks `keep_going` before each folder, so a queued destroy, configure or
/// vault move never waits out the whole walk.
///
/// Same filename filter as `reconcile::list_cur`'s uid parse, but `list_cur`
/// dedupes by uid and drops stat failures from its count while this counts
/// directory entries — so this count is never FEWER than what that later,
/// authoritative listing finds (it can be more, corrected on the real visit).
/// An unreadable folder is skipped: `reconcile_mailbox` will report or skip it
/// too, so there is nothing here worth prefilling.
fn prescan_folder_counts(st: &SearchIndexState, maildir: &Path, dirs: &[(String, String)], keep_going: &dyn Fn() -> bool) {
    let known: std::collections::HashSet<(String, String)> = match lock(&st.db).as_ref() {
        Some(conn) => conn
            .prepare("SELECT account_id, vault_dir FROM mailbox_scan")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default(), // a failed read only costs the prefill; reconcile still visits every folder
        None => return,
    };
    for (account, dir) in dirs {
        if !keep_going() {
            return;
        }
        if known.contains(&(account.clone(), dir.clone())) {
            continue; // already has a real, authoritative count from a previous pass
        }
        let cur = maildir.join(account).join(dir).join("cur");
        let Ok(entries) = std::fs::read_dir(&cur) else { continue };
        let n = entries.flatten().filter(|e| vault_filename_uid(&e.file_name().to_string_lossy()).is_some()).count();
        #[cfg(test)]
        st.prescan_reads.fetch_add(1, SeqCst);
        if let Some(conn) = lock(&st.db).as_ref() {
            if let Err(e) = conn.execute(
                "INSERT OR IGNORE INTO mailbox_scan (account_id, vault_dir, scanned_at, file_count) VALUES (?1, ?2, unixepoch(), ?3)",
                rusqlite::params![account, dir, n as i64],
            ) {
                warn!("search index prescan {account}/{dir}: {e}");
            }
        }
    }
}

pub(crate) fn sweep(st: &SearchIndexState, maildir: &Path, config: IndexConfig, only: Option<Vec<(String, String)>>) -> SweepOutcome {
    *g(&st.phase) = "indexing";
    emit(st);
    let keep_going = || lock(&st.db).is_some() && !st.interrupt.load(SeqCst);
    let full = only.is_none();
    let (dirs, listed) = match only {
        Some(folders) => (folders, true),
        None => match reconcile::list_vault_dirs(maildir) {
            Ok(dirs) => (dirs, true),
            Err(e) => {
                warn!("search index: listing the vault failed: {e}");
                (Vec::new(), false)
            }
        },
    };
    // A listing that failed is not "these folders are gone": no prune.
    // An unplugged or unreadable vault lists nothing; pruning then would drop the whole index.
    if full && listed && maildir.is_dir() && keep_going() {
        // Task 1.10 review I1: count every not-yet-scanned folder before
        // reconciling any of them, so `total` (and so `complete`) is right
        // before any folder's own batches start landing, not just after every
        // folder has had its own turn.
        prescan_folder_counts(st, maildir, &dirs, &keep_going);
        // Task 1.11 review M3: the phase-change emit above this block is
        // still `0 of 0` on a first pass (no rows, no mailbox_scan yet) — emit
        // again now the prescan has filled `total` in, so the pass's first
        // meaningful progress event already carries the real total.
        emit(st);
        if let Err(e) = reconcile::prune_missing_dirs(&st.db, &dirs) {
            warn!("search index prune: {e}");
        }
    }
    let mut completed = full && listed;
    let mut parsed = 0usize;
    for (account, dir) in dirs {
        let mut on_batch = |done: usize| { emit(st); e2e_pause_after(done); };
        match reconcile::reconcile_mailbox(&st.db, maildir, &account, &dir, config, &index_doc_from_light, &keep_going, &mut on_batch) {
            // configure/rebuild/close asked us to stop
            Ok(s) => {
                parsed += s.parsed;
                if s.interrupted {
                    completed = false;
                    break;
                }
                if s.parsed + s.removed + s.renamed > 0 {
                    info!("search index {account}/{dir}: {s:?}");
                } else if s.failed > 0 {
                    debug!("search index {account}/{dir}: {s:?}");
                }
            }
            Err(e) if e.contains("closed") => {
                completed = false;
                break;
            }
            Err(e) => warn!("search index {account}/{dir}: {e}"), // one bad folder must not stop the sweep
        }
    }
    // Before the idle emit below, so that event already reports the index available.
    if completed && keep_going() {
        if let Some(conn) = lock(&st.db).as_ref().filter(|c| !db::first_pass_done(c)) {
            if let Err(e) = db::meta_set(conn, db::FIRST_PASS_DONE, "1") {
                warn!("search index: recording the first full pass failed: {e}");
            }
        }
    }
    let open = lock(&st.db).is_some();
    *g(&st.phase) = if open { "idle" } else { "unavailable" };
    emit(st);
    SweepOutcome { parsed, completed }
}

/// Test seam for e2e only: how long to pause after `done` files. Pure, so the
/// unit test never touches the process environment. Its only non-test caller
/// is `e2e_pause_after`'s `cfg(debug_assertions)` arm, so a release build
/// (`cargo test` off, `debug_assertions` off) never calls it — gate it the
/// same way, or a release build warns "function is never used".
#[cfg(any(debug_assertions, test))]
pub(crate) fn batch_pause(done: usize, setting: Option<&str>) -> Option<Duration> {
    if done == 0 || done % reconcile::BATCH != 0 {
        return None;
    }
    let ms: u64 = setting?.trim().parse().ok()?;
    Some(Duration::from_millis(ms.min(30_000)))
}

#[cfg(debug_assertions)]
fn e2e_pause_after(done: usize) {
    let setting = std::env::var("MAILVAULT_E2E_INDEX_BATCH_PAUSE_MS").ok();
    if let Some(d) = batch_pause(done, setting.as_deref()) {
        std::thread::sleep(d);
    }
}

#[cfg(not(debug_assertions))]
fn e2e_pause_after(_done: usize) {}

#[cfg(test)]
mod tests {
    #[test]
    fn the_e2e_batch_pause_applies_only_to_full_batches_and_a_valid_setting() {
        use crate::search_index::batch_pause;
        use std::time::Duration;
        assert_eq!(batch_pause(500, Some("4000")), Some(Duration::from_millis(4000)));
        assert_eq!(batch_pause(1000, Some("4000")), Some(Duration::from_millis(4000)));
        assert_eq!(batch_pause(40, Some("4000")), None, "a small vault never pauses");
        assert_eq!(batch_pause(0, Some("4000")), None);
        assert_eq!(batch_pause(500, None), None);
        assert_eq!(batch_pause(500, Some("soon")), None);
        assert_eq!(batch_pause(500, Some("999999")), Some(Duration::from_secs(30)), "capped");
    }

    fn eml_html() -> Vec<u8> {
        b"From: Ann Lee <ann@x.test>\r\nTo: Bob <bob@x.test>\r\nCc: carol@x.test\r\nSubject: Quarterly numbers\r\nMessage-ID: <q@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Revenue&nbsp;grew <b>12%</b></p><style>x{}</style>\r\n".to_vec()
    }

    #[test]
    fn adapter_builds_doc_from_the_app_parser() {
        let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
        assert_eq!(doc.subject, "Quarterly numbers");
        assert_eq!(doc.from_addr, "ann@x.test");
        assert_eq!(doc.from_name, "Ann Lee");
        assert!(doc.addrs.iter().any(|a| a.contains("bob@x.test")));
        assert!(doc.addrs.iter().any(|a| a.contains("carol@x.test")));
        assert_eq!(doc.body_text, "Revenue grew 12%");
        assert_eq!(doc.message_id.as_deref(), Some("<q@x.test>"));
        assert_eq!(doc.date_utc, Some(1789207200));
        let row: serde_json::Value = serde_json::from_str(&doc.row_json).unwrap();
        assert!(row.get("text").map_or(true, |v| v.is_null()), "row_json has no body");
        assert!(row.get("html").map_or(true, |v| v.is_null()));
        assert!(row.get("flags").is_none(), "flags come from the filename at read time");
        assert_eq!(row["subject"], "Quarterly numbers");
    }

    fn eml_alternative(plain: &str, html: &str) -> Vec<u8> {
        format!(
            "From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Both parts\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{plain}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n--b--\r\n"
        )
        .into_bytes()
    }

    #[test]
    fn adapter_indexes_the_html_when_the_text_part_is_a_stub() {
        let html = "<p>Your <b>September statement</b> is ready.</p><p>Balance due: 1,240.00 by October 5.</p>";
        let doc = crate::search_index::index_doc_from_light(&eml_alternative("View this email in your browser", html), 1, "1:2,.eml").expect("parses");
        assert!(doc.body_text.contains("September statement"), "{:?}", doc.body_text);
        assert!(doc.body_text.contains("Balance due"), "{:?}", doc.body_text);
    }

    #[test]
    fn adapter_keeps_the_text_part_when_it_says_more_than_the_html() {
        let plain = "Hi Bob, the full minutes of Tuesday's meeting are below, with every action item and owner.";
        let doc = crate::search_index::index_doc_from_light(&eml_alternative(plain, "<p>See minutes</p>"), 1, "1:2,.eml").expect("parses");
        assert_eq!(doc.body_text.trim(), plain);
    }

    #[test]
    fn adapter_falls_back_to_html_when_the_text_part_is_whitespace() {
        let doc = crate::search_index::index_doc_from_light(&eml_alternative("  \r\n\t", "<p>From <b>html</b></p>"), 1, "1:2,.eml").expect("parses");
        assert_eq!(doc.body_text, "From html");
    }

    fn eml_with_one_attachment() -> Vec<u8> {
        b"From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Report attached\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached.\r\n--b\r\nContent-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nhello world\r\n--b--\r\n".to_vec()
    }

    /// C1: the real `ParseFn` must populate `attachment_candidates` from the
    /// message's actual MIME parts, not hardcode an empty Vec — that hardcode is
    /// what made the whole attachment-search feature inert in production (no
    /// pending row was ever written, so extraction never ran).
    #[test]
    fn adapter_lists_a_real_attachment_as_a_candidate() {
        let raw = eml_with_one_attachment();
        let doc = crate::search_index::index_doc_from_light(&raw, 1, "1:2,.eml").expect("parses");
        assert_eq!(doc.attachment_candidates.len(), 1, "{:?}", doc.attachment_candidates);
        let candidate = &doc.attachment_candidates[0];
        assert_eq!(candidate.filename, "notes.txt");
        assert_eq!(candidate.mime, "text/plain");
        // Size is the ENCODED part size (raw bytes, headers included) as an
        // upper bound on the decoded body, not the exact decoded length (I2):
        // this part is 7-bit so encoding adds no bloat, but the value comes from
        // `encoded_part_size`, never from decoding the body.
        let part_raw = b"Content-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nhello world\r\n";
        assert_eq!(candidate.size, part_raw.len() as u64);
    }

    #[test]
    fn adapter_lists_no_candidates_for_a_message_with_no_attachments() {
        let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
        assert!(doc.attachment_candidates.is_empty(), "{:?}", doc.attachment_candidates);
    }

    #[test]
    fn assemble_rows_uses_row_json_without_reading_the_eml() {
        use mailvault_core::search_index::query::{SearchHit, SearchPage};
        let page = SearchPage {
            hits: vec![SearchHit {
                vault_dir: "INBOX".into(),
                uid: 7,
                filename: "7:2,AS.eml".into(),
                message_id: Some("<seven@example>".into()),
                row_json: r#"{"uid":7,"messageId":"<seven@example>","subject":"Indexed only"}"#.into(),
                body_matched: true,
            }],
            total: 1,
            needles: vec!["indexed".into()],
        };
        let rows = crate::search_index::assemble_rows(&page);
        assert_eq!(rows[0]["subject"], "Indexed only");
        assert_eq!(rows[0]["flags"], serde_json::json!(["archived", "seen", "\\Seen"]));
        assert_eq!(rows[0]["vaultDir"], "INBOX");
        assert_eq!(rows[0]["matchedIn"], serde_json::json!(["subject", "body"]));
    }

    #[test]
    fn assemble_rows_leaves_message_id_verification_for_open_time() {
        use mailvault_core::search_index::query::{SearchHit, SearchPage};
        let page = SearchPage {
            hits: vec![SearchHit {
                vault_dir: "INBOX".into(),
                uid: 5,
                filename: "5:2,.eml".into(),
                message_id: Some("<indexed@x.test>".into()),
                row_json: r#"{"uid":5,"messageId":"<indexed@x.test>","subject":"Indexed budget"}"#.into(),
                body_matched: false,
            }],
            total: 1,
            needles: vec!["budget".into()],
        };
        // Opening still uses the reader's existing location/Message-ID guard;
        // search assembly returns the indexed row without rereading the file.
        let rows = crate::search_index::assemble_rows(&page);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["messageId"], "<indexed@x.test>");
    }

    #[test]
    fn search_index_status_is_available_during_the_first_build_but_search_is_not() {
        use mailvault_core::search_index::{db, lock, query::SearchRequest};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        let status = || crate::search_index::status_json(&st);
        let search = || {
            let req = SearchRequest { account_id: "acct".into(), query: "budget".into(), ..Default::default() };
            crate::search_index::search_reply(&st, &req).unwrap()
        };
        assert_eq!((status()["available"].as_bool(), search()["available"].as_bool()), (Some(false), Some(false)), "closed");
        assert_eq!(search()["reason"], "unavailable");

        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
        let s = status();
        assert_eq!(s["available"], true, "open: Settings shows the first build's progress and can Rebuild");
        assert_eq!(s["indexed"], 0);
        assert_eq!(search()["available"], false, "a first build misses mail the scan finds: search keeps scanning");
        assert_eq!(search()["reason"], "building");

        db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
        let reply = search();
        assert_eq!(reply["available"], true);
        assert_eq!(reply["rows"], serde_json::json!([]));
        assert_eq!(reply["mode"], "index");
        assert_eq!(reply["coverage"]["complete"], true);
        assert_eq!(status()["available"], true);
    }

    #[test]
    fn vault_rows_reads_flags_off_the_current_filename_and_skips_unindexed_uids() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        assert!(crate::search_index::rows_reply(&st, "acct", "INBOX", &[3]).is_empty(), "closed: nothing, the caller reads the files");

        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        {
            let guard = lock(&st.db);
            let conn = guard.as_ref().unwrap();
            // The row was parsed while the file was unread and unarchived; it has been renamed since.
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
                 VALUES ('acct', 'INBOX', 3, '3:2,AS.eml', 1, 1, 1, 1, '{\"uid\":3,\"subject\":\"Budget\",\"isArchived\":false,\"hasAttachments\":true}')",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
                 VALUES ('acct', 'Projects_2026', 5, '5:2,.eml', 1, 1, 1, 1, '{\"uid\":5,\"subject\":\"Nested\"}')",
                [],
            ).unwrap();
        }
        let rows = crate::search_index::rows_reply(&st, "acct", "INBOX", &[4, 3]);
        assert_eq!(rows.len(), 1, "uid 4 is not indexed: left to the file path");
        assert_eq!(rows[0]["uid"], 3);
        assert_eq!(rows[0]["subject"], "Budget");
        assert_eq!(rows[0]["hasAttachments"], true);
        assert_eq!(rows[0]["isArchived"], true, "from the current name, not the parse-time value");
        let flags: Vec<String> = rows[0]["flags"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_string()).collect();
        assert!(flags.iter().any(|f| f == "\\Seen") && flags.iter().any(|f| f == "archived"), "{flags:?}");
        // The mailbox argument is the server path; the index keys by the sanitized dir.
        let nested = crate::search_index::rows_reply(&st, "acct", "Projects/2026", &[5]);
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["isArchived"], false);
        assert_eq!(nested[0]["flags"], serde_json::json!([]));
    }

    #[test]
    fn status_carries_first_pass_done() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        assert_eq!(crate::search_index::status_json(&st)["firstPassDone"], false, "closed");
        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
        assert_eq!(crate::search_index::status_json(&st)["firstPassDone"], false);
        db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
        assert_eq!(crate::search_index::status_json(&st)["firstPassDone"], true);
    }

    #[test]
    fn a_disabled_index_reports_off_and_search_unavailable() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        // Open, root set and first pass done: the state search actually sees right
        // after configure-off or destroy, not a closed index that already answers
        // {available:false} on its own. Discriminates the `enabled` gate in
        // `search_reply` from the "no connection" branch it would fall through to.
        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
        db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
        *st.enabled.lock().unwrap() = Some(false);
        let s = crate::search_index::status_json(&st);
        assert_eq!((s["available"].as_bool(), s["state"].as_str()), (Some(false), Some("off")));
        let req = mailvault_core::search_index::query::SearchRequest { account_id: "acct".into(), query: "x".into(), ..Default::default() };
        let reply = crate::search_index::search_reply(&st, &req).unwrap();
        assert_eq!(reply["available"], false);
        assert_eq!(reply["reason"], "off");
    }

    /// Not a gate. The app parser over 50k ~3 KB multipart files, then what
    /// `vault_search` does per query (`search`, then `assemble_rows`), on a warm
    /// page cache (the files were just written). On the mini:
    /// cargo test -p mailvault-daemon --release search_index_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn search_index_bench_50k_real_parser() {
        use mailvault_core::search_index::{db, lock, query::{search, SearchRequest}, reconcile::{self, IndexConfig}};
        use std::time::{Duration, Instant};

        // splitmix64: which messages carry a word is set by its rate alone.
        fn mix(mut x: u64) -> u64 {
            x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        }
        // No filler word contains a dictionary word, "update" or a digit.
        const FILLER: [&str; 32] = [
            "please", "review", "attached", "notes", "thanks", "regards", "schedule", "team", "project", "status",
            "follow", "question", "morning", "office", "travel", "weekend", "details", "summary", "action", "items",
            "customer", "product", "launch", "design", "draft", "final", "approve", "agenda", "call", "friday",
            "monday", "report",
        ];
        // (word, percent of messages whose body carries it)
        const DICT: [(&str, u64); 10] = [
            ("invoice", 5), ("meeting", 6), ("budget", 8), ("shipment", 3), ("contract", 4),
            ("会議", 3), ("資料", 2), ("Réunion", 1), ("delivery", 10), ("quarterly", 7),
        ];
        const N: u32 = 50_000;
        const NEWEST: i64 = 1_789_207_200; // Sat, 12 Sep 2026 10:00:00 +0000; message i is i*10 minutes older

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let t = Instant::now();
        let mut bytes = 0usize;
        for i in 1..=N {
            let seed = u64::from(i) << 20;
            let mut words: Vec<&str> = (0..200).map(|k| FILLER[(mix(seed | k) % FILLER.len() as u64) as usize]).collect();
            for (k, (w, pct)) in DICT.iter().enumerate() {
                let k = k as u64;
                if mix(seed | (1000 + k)) % 100 < *pct {
                    let at = (mix(seed | (2000 + k)) % words.len() as u64) as usize;
                    words.insert(at, *w);
                }
            }
            let text = words.chunks(20).map(|c| c.join(" ")).collect::<Vec<_>>().join("\r\n");
            let html = words.chunks(20).map(|c| format!("<p>{}</p>", c.join(" "))).collect::<String>();
            let subject = FILLER[(mix(seed | 3000) % FILLER.len() as u64) as usize];
            let date = chrono::DateTime::from_timestamp(NEWEST - i64::from(i) * 600, 0).unwrap().to_rfc2822();
            let eml = format!(
                "From: Sender {s} <sender{s}@x.test>\r\nTo: Me <me@x.test>\r\nSubject: {subject} update {i}\r\nMessage-ID: <{i}@x.test>\r\nDate: {date}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>{html}</body></html>\r\n--b--\r\n",
                s = i % 50
            );
            bytes += eml.len();
            let cur = root.join("Maildir/bench").join(["INBOX", "Archive", "Sent"][(i % 3) as usize]).join("cur");
            std::fs::create_dir_all(&cur).unwrap();
            std::fs::write(cur.join(format!("{i}:2,S.eml")), eml).unwrap();
        }
        println!("corpus n={N} avg_bytes={} write={:?}", bytes / N as usize, t.elapsed());

        let db: mailvault_core::search_index::SharedConn = std::sync::Mutex::new(Some(db::open(root).unwrap()));
        let maildir = root.join("Maildir");
        let parser_calls = std::sync::atomic::AtomicUsize::new(0);
        let parse = |raw: &[u8], uid, filename: &str| {
            parser_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::search_index::index_doc_from_light(raw, uid, filename)
        };
        let t = Instant::now();
        for (a, d) in reconcile::list_vault_dirs(&maildir).unwrap() {
            reconcile::reconcile_mailbox(&db, &maildir, &a, &d, IndexConfig { bodies: true, attachments: true, image_text: true }, &parse, &|| true, &mut |_| {}).unwrap();
        }
        assert_eq!(parser_calls.load(std::sync::atomic::Ordering::SeqCst), N as usize);
        println!("index_build n={N} elapsed={:?}", t.elapsed());
        {
            let g = lock(&db);
            let conn = g.as_ref().unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
            let t = Instant::now();
            let c = db::counts(conn);
            println!("db_bytes={} counts indexed={} total={} elapsed={:?}", db::db_size_bytes(root), c.indexed, c.total, t.elapsed());
        }

        let req = |q: &str| SearchRequest { account_id: "bench".into(), query: q.into(), ..Default::default() };
        let invoice = req("invoice");
        let warm_page = search(lock(&db).as_ref().unwrap(), &invoice).unwrap();
        let _warm_rows = crate::search_index::assemble_rows(&warm_page);
        parser_calls.store(0, std::sync::atomic::Ordering::SeqCst);
        let t = Instant::now();
        let page = search(lock(&db).as_ref().unwrap(), &invoice).unwrap();
        let rows = crate::search_index::assemble_rows(&page);
        let elapsed = t.elapsed();
        let result_parse_calls = parser_calls.load(std::sync::atomic::Ordering::SeqCst);
        println!("warm_query \"invoice\" hits={} rows={} search_plus_assembly={elapsed:?} parser_calls={result_parse_calls}", page.hits.len(), rows.len());
        assert!(elapsed < Duration::from_millis(200), "warm indexed search and row assembly took {elapsed:?}, expected < 200 ms");
        assert_eq!(result_parse_calls, 0, "indexed result assembly invoked the MIME parser");
        let week = SearchRequest { date_from: Some(NEWEST - 7 * 86_400), date_to: Some(NEWEST), ..req("") };
        for (label, r) in [("budget meeting", req("budget meeting")), ("会議", req("会議")), ("update 4999", req("update 4999")), ("<empty>, last 7 days", week)] {
            let t = Instant::now();
            let page = search(lock(&db).as_ref().unwrap(), &r).unwrap();
            let searched = t.elapsed();
            let t = Instant::now();
            let rows = crate::search_index::assemble_rows(&page);
            println!("query {label:?} total={} hits={} rows={} search={searched:?} assemble={:?}", page.total, page.hits.len(), rows.len(), t.elapsed());
        }
    }

    fn seed(root: &std::path::Path, account: &str, dir: &str, n: u32) {
        let cur = root.join("Maildir").join(account).join(dir).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        for uid in 1..=n {
            std::fs::write(cur.join(format!("{uid}:2,S.eml")), format!("From: a@x.test\r\nSubject: Seed {uid}\r\nMessage-ID: <{uid}@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbody {uid}\r\n")).unwrap();
        }
    }

    fn state(root: &std::path::Path) -> std::sync::Arc<crate::search_index::SearchIndexState> {
        crate::search_index::SearchIndexState::new(root.to_path_buf(), true, crate::events::EventBus::new(64))
    }

    fn cfg() -> crate::search_index::ConfigArgs {
        serde_json::from_value(serde_json::json!({"enabled": true, "bodies": true})).unwrap()
    }

    fn wait_for(st: &crate::search_index::SearchIndexState, what: &str, ok: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let s = crate::search_index::status_json(st);
            if ok(&s) { return s; }
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}; last status {s}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Polls a progress-bus subscriber until a `search-index-progress` payload
    /// matches `pred`, or `timeout` elapses. Task 1.11 review M5: only
    /// `TryRecvError::Empty` means "nothing yet" — `Lagged` (a skipped emit,
    /// including the one under test) or `Closed` must fail loudly, never be
    /// treated the same as empty and silently waited past.
    fn recv_progress(
        rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<str>>,
        pred: impl Fn(&serde_json::Value) -> bool,
        timeout: std::time::Duration,
    ) -> Option<serde_json::Value> {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(line) => {
                    if let Some((name, payload)) = mailvault_core::daemon_ipc::parse_event(&line) {
                        if name == "search-index-progress" && pred(&payload) {
                            return Some(payload);
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => std::thread::sleep(std::time::Duration::from_millis(20)),
                Err(e) => panic!("progress bus error while waiting for an event: {e:?}"),
            }
        }
        None
    }

    fn index_file(root: &std::path::Path) -> std::path::PathBuf {
        root.join(mailvault_core::search_index::db::DB_DIR).join(mailvault_core::search_index::db::DB_FILE)
    }

    #[test]
    fn a_worker_that_is_never_enabled_never_creates_the_index() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 3);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(crate::search_index::status_json(&st)["state"], "unavailable", "unconfigured");
        let mut off = cfg();
        off.enabled = false;
        crate::search_index::configure(&st, off);
        wait_for(&st, "off", |s| s["state"] == "off");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!index_file(tmp.path()).exists(), "configure {{enabled:false}} must never open or create index.db");
    }

    #[test]
    fn enabling_builds_the_index_and_records_the_first_pass() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 3);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        let s = wait_for(&st, "first pass", |s| s["firstPassDone"] == true && s["state"] == "idle");
        assert_eq!((s["indexed"].as_u64(), s["total"].as_u64(), s["complete"].as_bool()), (Some(3), Some(3), Some(true)));
    }

    #[test]
    fn an_unreachable_vault_reports_unavailable_and_opens_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), false, crate::events::EventBus::new(8));
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(crate::search_index::status_json(&st)["state"], "unavailable");
        assert!(!index_file(tmp.path()).exists());
    }

    /// Task 1.10 review I1: `total` must count every listed folder from the
    /// very first progress emit of a first pass, not only the folders
    /// reconciled so far — otherwise an emit right after a folder's own
    /// batch commits reads `indexed == total` (falsely "complete") until
    /// later folders are visited, and the progress UI flickers/closes early.
    #[test]
    fn a_first_pass_counts_every_folder_before_the_first_emit() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 3);
        seed(tmp.path(), "acct", "Archive", 3);
        let st = state(tmp.path());
        let mut rx = st.bus.subscribe();
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());

        // The first progress emit where anything has actually been indexed:
        // whichever folder's batch commits first, before the other is visited.
        let s = recv_progress(&mut rx, |p| p["indexed"].as_u64().unwrap_or(0) > 0, std::time::Duration::from_secs(20))
            .expect("no progress emit with indexed > 0 within 20s");
        assert_eq!(s["total"].as_u64(), Some(6), "total must count BOTH folders from the first indexed emit, not just the one folder reconciled so far: {s}");
        assert_eq!(s["complete"].as_bool(), Some(false), "6 total, 3 indexed is not complete: {s}");
    }

    /// Task 1.11 review I1: after the first full pass every folder already has
    /// a `mailbox_scan` row, so a later full sweep must not `read_dir` it
    /// again — only `reconcile_mailbox`'s own listing should walk the vault a
    /// second time. `prescan_reads` (test-only, per-state) counts actual
    /// `read_dir` calls the prescan makes; it must not grow across the second
    /// full sweep since both folders are already known.
    #[test]
    fn a_later_full_sweep_does_not_reread_a_folder_the_prescan_already_knows() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 2);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "first pass", |s| s["firstPassDone"] == true && s["state"] == "idle");
        let after_first = st.prescan_reads.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(after_first, 1, "the prescan must read_dir INBOX exactly once on the first full pass");

        let mut rx = st.bus.subscribe();
        crate::search_index::sweep_soon(&st);
        let idle = recv_progress(&mut rx, |p| p["state"] == "idle", std::time::Duration::from_secs(20));
        assert!(idle.is_some(), "the second full sweep never finished");
        assert_eq!(
            st.prescan_reads.load(std::sync::atomic::Ordering::SeqCst),
            after_first,
            "a folder the prescan already knows must not be read_dir'd again on a later full sweep"
        );
    }

    /// Task 1.11 review I1: the prescan checks `keep_going` before each
    /// folder, so an interrupt (destroy, configure, a vault move) stops it
    /// partway through instead of waiting out the whole walk. Drives
    /// `prescan_folder_counts` directly (no worker) so the interrupt can be
    /// deterministic: `keep_going` returns true once, then false.
    #[test]
    fn an_interrupt_during_prescan_stops_it() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        seed(tmp.path(), "acct", "Archive", 1);
        seed(tmp.path(), "acct", "Sent", 1);
        let st = state(tmp.path());
        let conn = mailvault_core::search_index::db::open(tmp.path()).unwrap();
        *st.db.lock().unwrap() = Some(conn);

        let dirs = vec![
            ("acct".to_string(), "INBOX".to_string()),
            ("acct".to_string(), "Archive".to_string()),
            ("acct".to_string(), "Sent".to_string()),
        ];
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let keep_going = || calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 1; // true once, then false
        super::prescan_folder_counts(&st, &tmp.path().join("Maildir"), &dirs, &keep_going);

        assert_eq!(
            st.prescan_reads.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "an interrupt after the first folder must stop the walk before the rest are read"
        );
    }

    /// Review I1 (task-1.6-review.md): while the vault is unreachable, `st.vault_root`
    /// is the app-data FALLBACK root (what `resolve_mail_dir` hands back when
    /// `mail_dir_ok` is false), never the real, unreachable vault. `destroy_index`
    /// must never unlink anything there and report success — a "Delete" the user
    /// asked for that quietly deletes nothing, while the real index.db (wherever
    /// it actually is) survives untouched, is worse than a `destroyFailed` error.
    #[test]
    fn destroy_on_an_unreachable_vault_never_touches_the_fallback_root_and_fails() {
        let tmp = tempfile::tempdir().unwrap();
        // Stands in for whatever already lives under the fallback root's
        // search_index dir — must survive a destroy attempt untouched.
        let dir = tmp.path().join(mailvault_core::search_index::db::DB_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let planted = dir.join(mailvault_core::search_index::db::DB_FILE);
        std::fs::write(&planted, b"must survive: this is not the real vault's index").unwrap();

        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), false, crate::events::EventBus::new(8));
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        std::thread::sleep(std::time::Duration::from_millis(300));

        let reply = crate::search_index::destroy(&st, std::time::Duration::from_secs(20));
        assert_eq!(reply, serde_json::json!({"ok": false, "error": "searchIndex.destroyFailed"}));
        assert!(planted.exists(), "the fallback root's file must never be touched, let alone deleted, while the vault is unreachable");
        assert_eq!(*st.enabled.lock().unwrap(), Some(false), "a failed (non-busy) destroy still leaves the index off, matching every other destroyFailed path");
    }

    #[test]
    fn destroy_deletes_every_index_file_and_reports_off() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 5);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "first pass", |s| s["firstPassDone"] == true);
        let reply = crate::search_index::destroy(&st, std::time::Duration::from_secs(20));
        assert_eq!(reply, serde_json::json!({"ok": true}));
        let dir = tmp.path().join(mailvault_core::search_index::db::DB_DIR);
        for suffix in ["", "-wal", "-shm", "-journal"] {
            assert!(!dir.join(format!("index.db{suffix}")).exists(), "index.db{suffix} survived");
        }
        assert_eq!(crate::search_index::status_json(&st)["state"], "off");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!index_file(tmp.path()).exists(), "nothing reopened it after destroy");
    }

    #[test]
    fn building_again_after_destroy_starts_a_fresh_first_pass() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 4);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "first pass", |s| s["firstPassDone"] == true);
        assert_eq!(crate::search_index::destroy(&st, std::time::Duration::from_secs(20))["ok"], true);
        crate::search_index::configure(&st, cfg());
        let s = wait_for(&st, "rebuilt", |s| s["firstPassDone"] == true && s["indexed"] == 4);
        assert_eq!(s["state"], "idle");
    }

    #[test]
    fn destroy_during_a_vault_switch_is_busy_and_keeps_the_files() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 2);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "first pass", |s| s["firstPassDone"] == true);
        crate::search_index::close(&st);
        assert_eq!(crate::search_index::destroy(&st, std::time::Duration::from_secs(5)), serde_json::json!({"ok": false, "error": "searchIndex.busy"}));
        assert!(index_file(tmp.path()).exists());
        crate::search_index::reopen(&st);
        wait_for(&st, "reopened", |s| s["available"] == true);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_will_not_delete_fails_destroy_and_leaves_the_index_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 2);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "first pass", |s| s["firstPassDone"] == true);
        let dir = tmp.path().join(mailvault_core::search_index::db::DB_DIR);
        // A directory without write permission refuses unlink of its entries.
        // Set only after the worker opened the DB; the worker drops the connection before deleting.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let reply = crate::search_index::destroy(&st, std::time::Duration::from_secs(20));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(reply, serde_json::json!({"ok": false, "error": "searchIndex.destroyFailed"}));
        assert_eq!(*st.phase.lock().unwrap(), "unavailable");
    }

    /// Spec §5.7.1. A daemon killed after its first 500-file commit: the next daemon
    /// on the same root parses only the rest, and first_pass_done appears only then.
    #[test]
    fn resume_after_an_interrupted_first_pass_parses_only_the_rest() {
        use mailvault_core::search_index::{db, lock, reconcile::{self, IndexConfig}};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1200);
        let config = IndexConfig { bodies: true, attachments: false, image_text: false };
        let maildir = tmp.path().join("Maildir");
        {
            let st = state(tmp.path());
            *st.enabled.lock().unwrap() = Some(true);
            *st.config.lock().unwrap() = Some(config);
            crate::search_index::open_into(&st);
            let batches = std::cell::Cell::new(0);
            let stats = reconcile::reconcile_mailbox(&st.db, &maildir, "acct", "INBOX", config, &crate::search_index::index_doc_from_light, &|| batches.get() < 1, &mut |_| batches.set(batches.get() + 1)).unwrap();
            assert!(stats.interrupted);
            assert_eq!(stats.parsed, reconcile::BATCH);
            let guard = lock(&st.db);
            let conn = guard.as_ref().unwrap();
            assert!(!db::first_pass_done(conn));
            assert_eq!(db::counts(conn).indexed, 500);
        } // dropped without a clean pass, as a SIGKILL after the commit would leave it
        let st = state(tmp.path());
        *st.enabled.lock().unwrap() = Some(true);
        *st.config.lock().unwrap() = Some(config);
        crate::search_index::open_into(&st);
        let out = crate::search_index::sweep(&st, &maildir, config, None);
        assert!(out.completed);
        assert_eq!(out.parsed, 700, "only the files the first daemon never committed");
        let guard = lock(&st.db);
        let conn = guard.as_ref().unwrap();
        assert!(db::first_pass_done(conn));
        assert_eq!(db::counts(conn).indexed, 1200);
    }

    fn manual_channel(st: &std::sync::Arc<crate::search_index::SearchIndexState>) -> std::sync::mpsc::Receiver<mailvault_core::search_index::plan::Signal> {
        let (tx, rx) = std::sync::mpsc::channel();
        *st.signals.lock().unwrap() = Some(tx);
        rx
    }

    fn spawn_destroy(st: &std::sync::Arc<crate::search_index::SearchIndexState>) -> std::thread::JoinHandle<serde_json::Value> {
        let st = std::sync::Arc::clone(st);
        std::thread::spawn(move || crate::search_index::destroy(&st, std::time::Duration::from_secs(10)))
    }

    fn wait_reply_slot(st: &crate::search_index::SearchIndexState) {
        while st.destroy_reply.lock().unwrap().is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        std::thread::sleep(std::time::Duration::from_millis(100)); // its Destroy signal is sent right after the slot
    }

    fn spawn_worker(st: &std::sync::Arc<crate::search_index::SearchIndexState>, rx: std::sync::mpsc::Receiver<mailvault_core::search_index::plan::Signal>) {
        let st = std::sync::Arc::clone(st);
        std::thread::spawn(move || crate::search_index::worker(&st, rx));
    }

    #[test]
    fn two_concurrent_destroys_both_get_ok() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 2);
        let st = state(tmp.path());
        let rx = manual_channel(&st);
        let a = spawn_destroy(&st);
        wait_reply_slot(&st);
        let b = spawn_destroy(&st);
        std::thread::sleep(std::time::Duration::from_millis(300));
        spawn_worker(&st, rx);
        let (ra, rb) = (a.join().unwrap(), b.join().unwrap());
        assert_eq!((ra, rb), (serde_json::json!({"ok": true}), serde_json::json!({"ok": true})), "both callers of a destroy that succeeded");
    }

    #[test]
    fn configure_on_while_a_destroy_is_queued_builds_again() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 3);
        let st = state(tmp.path());
        let rx = manual_channel(&st);
        let d = spawn_destroy(&st);
        wait_reply_slot(&st);
        crate::search_index::configure(&st, cfg()); // user turns it back on before the worker got to the destroy
        spawn_worker(&st, rx);
        assert_eq!(d.join().unwrap()["ok"], true);
        wait_for(&st, "built again after the queued destroy", |s| s["available"] == true && s["firstPassDone"] == true);
    }

    #[test]
    fn a_switch_that_begins_after_destroy_was_accepted_keeps_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 2);
        let st = state(tmp.path());
        crate::search_index::configure(&st, cfg()); // no channel yet: only sets config + enabled
        let rx = manual_channel(&st);
        let d = spawn_destroy(&st);
        wait_reply_slot(&st);
        crate::search_index::close(&st); // 1.7 vault move starts after destroy passed its switch check
        spawn_worker(&st, rx);
        assert_eq!(d.join().unwrap(), serde_json::json!({"ok": false, "error": "searchIndex.busy"}));
        assert_eq!(*st.enabled.lock().unwrap(), Some(true), "a busy destroy must not leave the index switched off");
    }

    /// Review Minor 5: every other "off" assertion is satisfied by `status_json`'s
    /// own `enabled` short-circuit before the worker does anything; this test
    /// drives the worker far enough to exercise `run_pass`'s off-branch itself
    /// (the code that releases a connection a live index left open).
    #[test]
    fn switching_off_releases_the_open_connection_but_keeps_the_file() {
        use mailvault_core::search_index::lock;
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 2);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "first pass", |s| s["firstPassDone"] == true);
        let mut off = cfg();
        off.enabled = false;
        crate::search_index::configure(&st, off);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while lock(&st.db).is_some() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for the connection to release");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(index_file(tmp.path()).exists(), "off keeps the file; only destroy deletes it");
    }
}
