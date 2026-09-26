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
use rusqlite::OptionalExtension;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

const RETRY_DELAYS: [Duration; 3] = [Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(30)];

pub struct SearchIndexState {
    pub db: SharedConn,
    pub(crate) root: Mutex<Option<PathBuf>>,
    pub(crate) vault_root: PathBuf,
    /// Where `app.db` lives. A sweep that removes a message has to forget the
    /// tags and field values keyed to it, and that store is not this one.
    pub(crate) app_dir: PathBuf,
    pub(crate) mail_dir_ok: bool,
    pub(crate) bus: EventBus,
    pub(crate) config: Mutex<Option<IndexConfig>>,
    /// None until the first configure; Some(false) = destroyed or switched off.
    pub(crate) enabled: Mutex<Option<bool>>,
    pub(crate) signals: Mutex<Option<mpsc::Sender<Signal>>>,
    pub(crate) phase: Mutex<&'static str>, // starting | recovering | indexing | idle | error | off
    pub(crate) error_detail: Mutex<Option<String>>,
    pub(crate) recovery_queued: AtomicBool,
    pub(crate) operation_generation: AtomicU64,
    pub(crate) destroy_generation: AtomicU64,
    pub(crate) rebuild_pending: AtomicBool,
    pub(crate) interrupt: AtomicBool,
    pub(crate) switch: SwitchGuard,
    pub(crate) destroy_reply: Mutex<Vec<mpsc::Sender<Result<(), &'static str>>>>,
    /// Test-only: counts actual `read_dir` calls `prescan_folder_counts` makes
    /// (never a folder it already knows), per-state so parallel tests never
    /// interfere with each other's count.
    #[cfg(test)]
    pub(crate) prescan_reads: AtomicUsize,
    /// Per-state log of real account SQL scopes, used to prove mailbox chunking without global fault hooks.
    #[cfg(test)]
    pub(crate) search_scopes: Mutex<Vec<Option<Vec<String>>>>,
    #[cfg(test)]
    pub(crate) search_batch_hook: Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) open_before_install_hook: Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) worker_passes: AtomicUsize,
}

impl SearchIndexState {
    pub fn new(vault_root: PathBuf, app_dir: PathBuf, mail_dir_ok: bool, bus: EventBus) -> Arc<Self> {
        Arc::new(Self {
            db: Mutex::new(None),
            root: Mutex::new(None),
            vault_root,
            app_dir,
            mail_dir_ok,
            bus,
            config: Mutex::new(None),
            enabled: Mutex::new(None),
            signals: Mutex::new(None),
            phase: Mutex::new("starting"),
            error_detail: Mutex::new(None),
            recovery_queued: AtomicBool::new(false),
            operation_generation: AtomicU64::new(0),
            destroy_generation: AtomicU64::new(0),
            rebuild_pending: AtomicBool::new(false),
            interrupt: AtomicBool::new(false),
            switch: SwitchGuard::default(),
            destroy_reply: Mutex::new(Vec::new()),
            #[cfg(test)]
            prescan_reads: AtomicUsize::new(0),
            #[cfg(test)]
            search_scopes: Mutex::new(Vec::new()),
            #[cfg(test)]
            search_batch_hook: Mutex::new(None),
            #[cfg(test)]
            open_before_install_hook: Mutex::new(None),
            #[cfg(test)]
            worker_passes: AtomicUsize::new(0),
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
    let mut to_addrs = Vec::new();
    for key in ["to", "cc", "bcc", "replyTo"] {
        if let Some(list) = obj.get(key).and_then(|v| v.as_array()) {
            addrs.extend(list.iter().map(addr_text));
            // Reply-To is the sender's own choice of return address, not a
            // recipient: a view for "addressed to me" must not match on it.
            if key != "replyTo" {
                to_addrs.extend(list.iter().map(addr_text));
            }
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
        to_addrs: to_addrs.into_iter().filter(|a| !a.is_empty()).collect(),
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
            // The only match the reader cannot show: the term is in a file, not
            // in the message. The row says so rather than leaving the user to
            // hunt for text that is not there.
            if h.attach_matched {
                matched_in.push("attachment");
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
        return serde_json::json!({ "available": false, "state": "off", "indexed": 0, "total": 0, "sizeBytes": 0, "complete": false, "firstPassDone": false, "errorKey": null, "errorDetail": null });
    }
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else {
        let state = *g(&st.phase);
        let detail = g(&st.error_detail).clone();
        return serde_json::json!({
            "available": false, "state": state, "indexed": 0, "total": 0, "sizeBytes": 0,
            "complete": false, "firstPassDone": false,
            "errorKey": if state == "error" { Some("searchIndex.recoveryFailed") } else { None },
            "errorDetail": detail,
        });
    };
    let (c, first_pass_done) = match db::counts_checked(conn).and_then(|counts| db::first_pass_done_checked(conn).map(|first_pass| (counts, first_pass))) {
        Ok(health) => health,
        Err(_detail) => {
            drop(guard);
            request_recovery(st);
            let state = *g(&st.phase);
            let detail = g(&st.error_detail).clone();
            return serde_json::json!({
                "available": false, "state": state, "indexed": 0, "total": 0, "sizeBytes": 0,
                "complete": false, "firstPassDone": false,
                "errorKey": if state == "error" { Some("searchIndex.recoveryFailed") } else { None },
                "errorDetail": detail,
            });
        }
    };
    let size = g(&st.root).as_ref().map(|r| db::db_size_bytes(r)).unwrap_or(0);
    let state = *g(&st.phase);
    let detail = g(&st.error_detail).clone();
    serde_json::json!({
        "available": true,
        "state": state,
        "indexed": c.indexed,
        "total": c.total,
        "sizeBytes": size,
        "complete": c.total > 0 && c.indexed >= c.total,
        "firstPassDone": first_pass_done,
        "errorKey": if state == "error" { Some("searchIndex.recoveryFailed") } else { None },
        "errorDetail": detail,
    })
}

pub(crate) fn emit(st: &SearchIndexState) {
    st.bus.emit("search-index-progress", status_json(st));
}

/// Returns explicit availability reasons so the daemon coordinator can decide
/// whether the local lane needs to read files.
pub(crate) struct SearchPageReply {
    pub page: core::query::SearchPage,
    pub coverage: db::ScopeCoverage,
}

pub(crate) fn search_page_reply(
    st: &SearchIndexState,
    request: &core::query::SearchRequest,
) -> Result<Result<SearchPageReply, &'static str>, String> {
    if *g(&st.enabled) == Some(false) {
        return Ok(Err("off"));
    }
    let result = {
        let guard = lock(&st.db);
        let Some(conn) = guard.as_ref() else {
            return Ok(Err("unavailable"));
        };
        // A first build (or a rebuild) still misses mail the scan finds.
        match db::first_pass_done_checked(conn) {
            Ok(false) => return Ok(Err("building")),
            Err(e) => Err(e),
            Ok(true) => {
                #[cfg(test)]
                g(&st.search_scopes).push(request.mailboxes.clone());
                core::query::search(conn, request).and_then(|page| {
                db::scope_coverage(conn, &request.account_id, request.mailboxes.as_deref())
                    .map(|coverage| SearchPageReply { page, coverage })
                })
            }
        }
    };
    #[cfg(test)]
    if matches!(&result, Ok(_)) {
        let hook = g(&st.search_batch_hook).clone();
        if let Some(hook) = hook {
            hook();
        }
    }
    match result {
        Ok(result) => Ok(Ok(result)),
        Err(error) => {
            request_recovery(st);
            Err(error)
        }
    }
}

pub fn search_reply(st: &SearchIndexState, request: &core::query::SearchRequest) -> Result<serde_json::Value, String> {
    let result = match search_page_reply(st, request)? {
        Ok(result) => result,
        Err(reason) => return Ok(serde_json::json!({ "available": false, "reason": reason })),
    };
    let rows = assemble_rows(&result.page);
    let counts = {
        let guard = lock(&st.db);
        let Some(conn) = guard.as_ref() else {
            return Ok(serde_json::json!({ "available": false, "reason": "unavailable" }));
        };
        db::counts_checked(conn)
    };
    let counts = match counts {
        Ok(counts) => counts,
        Err(error) => {
            request_recovery(st);
            return Err(error);
        }
    };
    let uncovered_vault_dirs = result.coverage.uncovered_vault_dirs.clone();
    Ok(serde_json::json!({
        "available": true,
        "mode": "index",
        "rows": rows,
        "total": result.page.total,
        "coverage": result.coverage,
        "uncoveredVaultDirs": uncovered_vault_dirs,
        "indexed": counts.indexed,
        "totalMessages": counts.total,
        "complete": counts.total > 0 && counts.indexed >= counts.total,
    }))
}

/// Forget the tags and custom field values of messages this account no longer
/// has anywhere.
///
/// A move is a removal plus an insertion, and the two halves can land in
/// either order, so "its row was removed" is never on its own a reason to
/// forget what a person wrote about a message. Every candidate is checked
/// against the whole account first — and that check happens here, while the
/// index lock is held, *before* `app.db` is opened, so no path in the daemon
/// ever holds both the other way round.
pub fn prune_metadata(st: &SearchIndexState, account_id: &str, removed_keys: &[String]) -> Result<usize, String> {
    if removed_keys.is_empty() {
        return Ok(0);
    }
    let gone: Vec<String> = {
        let guard = lock(&st.db);
        let Some(conn) = guard.as_ref() else { return Ok(0) };
        let mut stmt = conn
            .prepare_cached(&format!(
                "SELECT EXISTS(SELECT 1 FROM messages m WHERE m.account_id = ?1 AND {} = ?2)",
                core::query::MSG_KEY_SQL
            ))
            .map_err(|e| e.to_string())?;
        let mut gone = Vec::new();
        for key in removed_keys {
            let still_here: i64 = stmt.query_row((account_id, key), |r| r.get(0)).map_err(|e| e.to_string())?;
            if still_here == 0 {
                gone.push(key.clone());
            }
        }
        gone
    };
    mailvault_core::app_db::with(&st.app_dir, |conn| mailvault_core::app_db::metadata::prune(conn, account_id, &gone))
}

/// What the index holds for `uids` of one folder: the row's `Message-ID`, or
/// `None` for a row that has none. A uid absent from the map is one the index
/// has no row for at all — the caller must not invent a key for it.
///
/// `Err` while the index is closed, so a caller that would otherwise read
/// "nothing is indexed" as "nothing exists" stops instead.
pub fn known_message_ids(
    st: &SearchIndexState,
    account_id: &str,
    mailbox: &str,
    uids: &[u32],
) -> Result<std::collections::HashMap<u32, Option<String>>, String> {
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else { return Err("search index is not open".into()) };
    let vault_dir = core::text::vault_dir_name(mailbox);
    let mut stmt = conn
        .prepare_cached("SELECT message_id FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3")
        .map_err(|e| e.to_string())?;
    let mut out = std::collections::HashMap::new();
    for uid in uids {
        let found: Option<Option<String>> = stmt
            .query_row((account_id, vault_dir.as_str(), *uid), |r| r.get::<_, Option<String>>(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(message_id) = found {
            out.insert(*uid, message_id);
        }
    }
    Ok(out)
}

/// Whether the index holds any row at all for an account. An account it knows
/// nothing about is one whose folders have not been indexed yet, which is not
/// the same answer as "these messages are gone".
pub fn holds_account(st: &SearchIndexState, account_id: &str) -> Result<bool, String> {
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else { return Err("search index is not open".into()) };
    conn.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE account_id = ?1)", [account_id], |r| r.get::<_, i64>(0))
        .map(|n| n == 1)
        .map_err(|e| e.to_string())
}

/// The view editor's sender suggestions. None while the index is off or
/// closed: a suggestion list is a convenience, not a claim about the mail.
pub fn suggest_senders(
    st: &SearchIndexState,
    accounts: &[String],
    prefix: &str,
    limit: usize,
) -> Result<Vec<core::query::SenderSuggestion>, String> {
    if *g(&st.enabled) == Some(false) {
        return Ok(Vec::new());
    }
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else { return Ok(Vec::new()) };
    core::query::suggest_senders(conn, accounts, prefix, limit)
}

/// The view editor's query-field suggestions (words/phrases from subjects and
/// attachment names). None while the index is off or closed, same as
/// `suggest_senders`.
pub fn suggest_terms(
    st: &SearchIndexState,
    accounts: &[String],
    prefix: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<core::query::TermSuggestion>, String> {
    if *g(&st.enabled) == Some(false) {
        return Ok(Vec::new());
    }
    let guard = lock(&st.db);
    let Some(conn) = guard.as_ref() else { return Ok(Vec::new()) };
    core::query::suggest_terms(conn, accounts, prefix, offset, limit)
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
    let rows = (|| -> Result<Vec<Value>, String> {
        let mut stmt = conn.prepare_cached("SELECT filename, row_json FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3").map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        for uid in uids {
            let Some((filename, row_json)) = stmt.query_row((account_id, vault_dir.as_str(), *uid), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional().map_err(|e| e.to_string())? else { continue };
            let Ok(mut row) = serde_json::from_str::<serde_json::Value>(&row_json) else { continue };
            let flags = parse_flags_from_filename(&filename);
            let Some(obj) = row.as_object_mut() else { continue };
            obj.insert("uid".into(), (*uid).into());
            obj.insert("isArchived".into(), flags.iter().any(|f| f == "archived").into());
            obj.insert("flags".into(), serde_json::json!(flags));
            rows.push(row);
        }
        Ok(rows)
    })();
    match rows {
        Ok(rows) => rows,
        Err(e) => {
            warn!("vault_rows: {e}");
            drop(guard);
            request_recovery(st);
            Vec::new()
        }
    }
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
    pub success: bool,
    pub error: Option<String>,
}

fn send(st: &SearchIndexState, s: Signal) {
    if let Some(tx) = g(&st.signals).as_ref() {
        let _ = tx.send(s);
    }
}

fn set_error(st: &SearchIndexState, detail: impl Into<String>) {
    *g(&st.error_detail) = Some(detail.into());
    *g(&st.phase) = "error";
}

fn clear_error(st: &SearchIndexState) {
    *g(&st.error_detail) = None;
}

/// A runtime query/status failure wakes the existing worker once. The caller
/// must release the SQLite guard before calling this.
fn request_recovery(st: &SearchIndexState) {
    if *g(&st.enabled) != Some(true) {
        return;
    }
    if st.recovery_queued.swap(true, SeqCst) {
        return;
    }
    clear_error(st);
    *g(&st.phase) = "recovering";
    st.interrupt.store(true, SeqCst);
    send(st, Signal::Recover);
}

pub(crate) fn request_search_recovery(st: &SearchIndexState) {
    request_recovery(st);
}

/// The vault's files are moving; its reopen() queues the open for afterwards.
/// Before the root is resolved and quick_check runs: a close() from here on
/// makes this open stale. Never opens while unconfigured or off (spec §5.5).
pub(crate) fn open_into(st: &SearchIndexState) -> Result<(), db::OpenError> {
    if st.switch.is_switching() {
        *g(&st.phase) = "recovering";
        return Ok(());
    }
    if *g(&st.enabled) != Some(true) {
        return Ok(()); // unconfigured or off: never create the file
    }
    if !st.mail_dir_ok {
        *g(&st.root) = None;
        let error = db::OpenError::Io("mail vault is unavailable".into());
        set_error(st, error.to_string());
        return Err(error);
    }
    let switch_gen = st.switch.current();
    let operation_gen = st.operation_generation.load(SeqCst);
    *lock(&st.db) = None; // one connection per file: a stale exclusive lock would make this open BUSY
    *g(&st.phase) = "recovering";
    clear_error(st);
    match db::open(&st.vault_root) {
        Ok(conn) => {
            #[cfg(test)]
            if let Some(hook) = g(&st.open_before_install_hook).clone() {
                hook();
            }
            if st.operation_generation.load(SeqCst) != operation_gen || *g(&st.enabled) != Some(true) {
                return Ok(()); // explicit off/Delete/Rebuild arrived during open
            }
            if !install_if_current(&st.db, &st.switch, switch_gen, conn) { return Ok(()) }
            *g(&st.root) = Some(st.vault_root.clone());
            // Configure can be accepted while open runs without taking the DB
            // mutex. Recheck its generation after installation and discard the
            // connection if a newer off/Delete won.
            if st.switch.current() != switch_gen || st.operation_generation.load(SeqCst) != operation_gen || *g(&st.enabled) != Some(true) {
                *lock(&st.db) = None;
                *g(&st.root) = None;
                *g(&st.phase) = if *g(&st.enabled) == Some(false) { "off" } else { "recovering" };
            }
            Ok(())
        }
        Err(e) => {
            warn!("search index open failed: {e}");
            *g(&st.root) = None;
            set_error(st, e.to_string());
            Err(e)
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
    {
        let mut enabled = g(&st.enabled);
        let before = std::mem::replace(&mut *enabled, Some(args.enabled));
        // An already-off config is idempotent. In particular, a delayed settings
        // hook must not invalidate a destroy that has already claimed the off generation.
        if !args.enabled && before != Some(false) {
            st.operation_generation.fetch_add(1, SeqCst);
        }
    }
    st.interrupt.store(true, SeqCst); // stop a running sweep at its next batch
    send(st, Signal::Configure);
}

pub fn rebuild(st: &SearchIndexState) {
    *g(&st.enabled) = Some(true);
    if g(&st.config).is_none() {
        *g(&st.config) = Some(IndexConfig { bodies: true, attachments: false, image_text: false });
    }
    st.operation_generation.fetch_add(1, SeqCst);
    st.rebuild_pending.store(true, SeqCst);
    st.recovery_queued.store(false, SeqCst);
    clear_error(st);
    *g(&st.phase) = "recovering";
    st.interrupt.store(true, SeqCst);
    send(st, Signal::Rebuild);
}

/// Blocking (waits for the worker): call from spawn_blocking.
pub fn destroy(st: &SearchIndexState, timeout: Duration) -> Value {
    if st.switch.is_switching() {
        return serde_json::json!({"ok": false, "error": "searchIndex.busy"});
    }
    let (before, generation) = {
        let mut enabled = g(&st.enabled);
        let before = std::mem::replace(&mut *enabled, Some(false));
        let generation = st.operation_generation.fetch_add(1, SeqCst) + 1;
        st.destroy_generation.store(generation, SeqCst);
        (before, generation)
    };
    st.rebuild_pending.store(false, SeqCst);
    clear_error(st);
    let (tx, rx) = mpsc::channel();
    g(&st.destroy_reply).push(tx);
    st.interrupt.store(true, SeqCst);
    send(st, Signal::Destroy);
    match rx.recv_timeout(timeout) {
        Ok(Ok(())) => serde_json::json!({"ok": true}),
        Ok(Err(key)) => {
            if key == "searchIndex.busy" && st.operation_generation.load(SeqCst) == generation {
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
fn destroy_index(st: &SearchIndexState, operation_gen: u64) -> Result<(), &'static str> {
    // Review I1: while the vault is unreachable, `st.vault_root` is the
    // app-data FALLBACK root `resolve_mail_dir` hands back, never the real
    // vault. Unlinking there and reporting success would "delete" nothing
    // that matters while the real index survives untouched — worse than an
    // honest failure. `rebuild_index` is already safe here (it reads `root`,
    // which is `None` while unreachable, and returns early); this mirrors it.
    if !st.mail_dir_ok {
        return Err("searchIndex.destroyFailed");
    }
    let mut guard = lock(&st.db);
    let gen = st.switch.current();
    if st.switch.is_switching() || st.operation_generation.load(SeqCst) != operation_gen {
        return Err("searchIndex.busy");
    }
    *guard = None; // drop = checkpoint; keep the mutex through unlinking so a switch cannot begin mid-delete
    *g(&st.root) = None;
    let dir = st.vault_root.join(db::DB_DIR);
    // Reverse order (journal, shm, wal, then the database file itself): an
    // abort mid-delete (a switch starting between two unlinks) never leaves a
    // -wal without the index.db it belongs to.
    for suffix in ["-journal", "-shm", "-wal", ""] {
        // A vault operation may start between the check above and this unlink.
        if st.switch.is_switching() || st.switch.current() != gen || st.operation_generation.load(SeqCst) != operation_gen {
            return Err("searchIndex.busy");
        }
        let path = dir.join(format!("{}{suffix}", db::DB_FILE));
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("search index destroy: cannot remove {}: {e}", path.display());
                let detail = format!("could not remove {}: {e}", path.display());
                drop(guard);
                set_error(st, detail);
                emit(st);
                return Err("searchIndex.destroyFailed");
            }
        }
    }
    drop(guard);
    *g(&st.phase) = "off";
    clear_error(st);
    emit(st);
    Ok(())
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
    let mut last_full = Instant::now();
    let mut failed_attempts = 0usize;
    let mut next_retry: Option<Instant> = None;
    loop {
        let enabled = *g(&st.enabled);
        let retrying = enabled == Some(true) && (*g(&st.phase) == "error" || lock(&st.db).is_none());
        let retry_index = failed_attempts.saturating_sub(1).min(RETRY_DELAYS.len() - 1);
        let retry_delay = RETRY_DELAYS[retry_index];
        // An interrupt still set here arrived after the last drain: its signal was
        // either drained already (its pass was cut short) or is queued. Go again now.
        let first = if st.interrupt.load(SeqCst) {
            Signal::Sweep
        } else {
            // Counted from the last full pass, so a stream of nudges cannot postpone it.
            let wait = if retrying {
                next_retry.map_or(retry_delay, |deadline| deadline.saturating_duration_since(Instant::now()))
            } else {
                SWEEP_EVERY.saturating_sub(last_full.elapsed())
            };
            match rx.recv_timeout(wait) {
                Ok(s) => s,
                Err(mpsc::RecvTimeoutError::Timeout) => if retrying { Signal::Recover } else { Signal::Sweep },
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        };
        // Cleared before the drain: a configure/rebuild that lands after this either
        // is drained now or leaves `interrupt` set and a queued signal.
        st.interrupt.store(false, SeqCst);
        // A burst of two or more nudges waits up to COALESCE for the nudges behind it; a lone nudge runs now.
        let signals = collect_burst(first, &rx, COALESCE);
        let explicit = signals.iter().any(|signal| matches!(signal, Signal::Configure | Signal::Rebuild | Signal::Destroy | Signal::Reopen));
        if retrying && next_retry.is_some_and(|deadline| Instant::now() < deadline) && !explicit {
            continue; // the bounded full retry subsumes queued nudges/sweeps/recovery wakes
        }
        // Once the bounded delay expires, any admitted automatic wake is the
        // retry: do not let a scoped nudge clear an error while failed work in
        // another mailbox remains pending.
        let retry_due = retrying && next_retry.map_or(true, |deadline| Instant::now() >= deadline);
        let Plan { reopen, rebuild, recover, destroy, only } = plan(signals);
        if rebuild {
            failed_attempts = 0;
            next_retry = None;
        }
        if destroy {
            next_retry = None;
            let outcome = destroy_index(st, st.destroy_generation.load(SeqCst));
            let waiting = std::mem::take(&mut *g(&st.destroy_reply));
            for tx in waiting {
                let _ = tx.send(outcome);
            }
            if *g(&st.enabled) != Some(true) {
                continue;
            }
            // A configure {enabled:true} landed behind the destroy: plan() dropped its Reopen.
        }
        // Keep an explicit rebuild request through a temporary vault move.
        // Its queued signal can be consumed while switching, so the operation
        // flag is the durable intent until a rebuild actually succeeds.
        let rebuild = rebuild || (!st.switch.is_switching() && st.rebuild_pending.load(SeqCst));
        let enabled = *g(&st.enabled) == Some(true);
        let closed = enabled && lock(&st.db).is_none();
        let first_pass_missing = if enabled {
            let guard = lock(&st.db);
            guard.as_ref().map_or(true, |conn| !db::first_pass_done_checked(conn).unwrap_or(false))
        } else {
            false
        };
        let full = needs_full(last_full.elapsed(), only.is_none() || reopen || destroy || rebuild || recover || retry_due || closed || first_pass_missing);
        #[cfg(test)]
        st.worker_passes.fetch_add(1, SeqCst);
        let healthy = run_pass(st, reopen || destroy || retry_due, rebuild, recover || retry_due, if full { None } else { only });
        let completed_full_pass = healthy && full && !st.interrupt.load(SeqCst) && *g(&st.phase) == "idle";
        if completed_full_pass {
            failed_attempts = 0;
            next_retry = None;
            st.recovery_queued.store(false, SeqCst);
        } else if !healthy && !st.interrupt.load(SeqCst) {
            failed_attempts = failed_attempts.saturating_add(1);
            if *g(&st.phase) == "error" || (*g(&st.enabled) == Some(true) && lock(&st.db).is_none()) {
                let delay_index = failed_attempts.saturating_sub(1).min(RETRY_DELAYS.len() - 1);
                next_retry = Some(Instant::now() + RETRY_DELAYS[delay_index]);
            }
        }
        // Not cut short = complete. A pass skipped because the index is unconfigured
        // or closed counts too: the configure or reopen that changes that forces its
        // own full pass. Resetting here is also what keeps a zero timeout from spinning.
        if full && healthy && !st.interrupt.load(SeqCst) {
            last_full = Instant::now();
        }
    }
}

fn run_pass(st: &SearchIndexState, reopen: bool, rebuild: bool, recover: bool, only: Option<Vec<(String, String)>>) -> bool {
    if st.switch.is_switching() {
        return true; // the vault operation's reopen() sends a Reopen, which is a full pass
    }
    let enabled = *g(&st.enabled);
    let closed = enabled == Some(true) && lock(&st.db).is_none();
    if *g(&st.enabled) != Some(true) {
        // Off: release a connection a configure {enabled:false} left open, once.
        if lock(&st.db).take().is_some() {
            *g(&st.root) = None;
            *g(&st.phase) = "off";
            clear_error(st);
            emit(st);
        }
        return true;
    }
    if enabled.is_none() { return true; }
    let Some(config) = *g(&st.config) else { return true }; // nothing until the frontend configures
    let operation_gen = st.operation_generation.load(SeqCst);
    let rebuild = rebuild || st.rebuild_pending.load(SeqCst);
    if rebuild {
        if let Err(error) = rebuild_index(st, operation_gen) {
            set_error(st, error);
            emit(st);
            return false;
        }
        st.rebuild_pending.store(false, SeqCst);
        if let Err(error) = open_into(st) {
            set_error(st, error.to_string());
            emit(st);
            return false;
        }
    } else if reopen || closed || recover {
        match open_into(st) {
            Ok(()) => {}
            Err(db::OpenError::Rebuildable(detail)) => {
                warn!("search index structure is not usable; rebuilding derived index: {detail}");
                if let Err(error) = rebuild_index(st, operation_gen) {
                    set_error(st, error);
                    emit(st);
                    return false;
                }
                if let Err(error) = open_into(st) {
                    set_error(st, error.to_string());
                    emit(st);
                    return false;
                }
            }
            Err(error) => {
                set_error(st, error.to_string());
                emit(st);
                return false;
            }
        }
    }
    // Read after a reopen or rebuild, which resolve the vault root afresh.
    let Some(root) = g(&st.root).clone() else { return *g(&st.phase) != "error" };
    let maildir = root.join("Maildir");

    // Every pass, not only after a configure: one drained while the index was
    // closed, or a toggle that lost a race with a vault switch, lands here.
    let action = {
        let guard = lock(&st.db);
        match guard.as_ref() {
            None => Err("search index closed".to_string()),
            Some(conn) => db::meta_get_checked(conn, "bodies_enabled").and_then(|stored| {
                let action = bodies_action(stored.as_deref(), config.bodies);
                if action == BodiesAction::RecordOnly {
                    db::meta_set(conn, "bodies_enabled", if config.bodies { "1" } else { "0" })
                        .map_err(|e| e.to_string())?;
                }
                Ok(action)
            }),
        }
    };
    let action = match action {
        Ok(action) => action,
        Err(error) => {
            set_error(st, format!("search index configuration read failed: {error}"));
            emit(st);
            return false;
        }
    };
    if action == BodiesAction::Toggle {
        match reconcile::set_bodies_enabled(&st.db, config.bodies) {
            Ok(()) => {}
            Err(e) if e.contains("closed") => return false,
            Err(e) => {
                set_error(st, format!("bodies toggle failed: {e}"));
                emit(st);
                return false;
            }
        }
    }
    let outcome = sweep(st, &maildir, config, if reopen || closed || recover || rebuild { None } else { only }, operation_gen);
    if let Some(error) = outcome.error {
        set_error(st, error);
        emit(st);
        return false;
    }
    if !outcome.success {
        return false;
    }
    // Attachment text extraction: gated on the same `attachments` toggle the
    // sweep above used to decide whether to write pending rows at all. Runs
    // under the same `conn` sweep just released, never a second connection.
    if config.attachments {
        let extractor = crate::attachment_extract::current_extractor();
        // config.attachments already reflects the JS-side premium check
        // (useSearchIndexConfig.js gates it on hasPremiumAccess); no
        // Rust-side general-premium entitlement exists to re-check here.
        let premium = true;
        let switch_gen = st.switch.current();
        match reconcile::run_pending_extractions(
                &st.db,
                premium,
                config.image_text,
                config.bodies,
                &extractor,
                |account_id, vault_dir, uid, filename, part_index| read_attachment_part(&maildir, account_id, vault_dir, uid, filename, part_index),
                &|| !st.interrupt.load(SeqCst)
                    && st.operation_generation.load(SeqCst) == operation_gen
                    && st.switch.current() == switch_gen
                    && !st.switch.is_switching(),
            ) {
            Ok(_) => {}
            Err(error) => {
                set_error(st, format!("attachment extraction failed: {error}"));
                emit(st);
                return false;
            }
        }
    }
    // Deferred optimize + VACUUM + WAL truncate after bodies-off, only when nothing is pending.
    if !st.interrupt.load(SeqCst) && st.operation_generation.load(SeqCst) == operation_gen {
        match reconcile::compact_if_pending(&st.db) {
            Ok(true) => emit(st),
            Ok(false) => {}
            Err(e) => {
                set_error(st, format!("search index compaction failed: {e}"));
                emit(st);
                return false;
            }
        }
    }
    if st.operation_generation.load(SeqCst) != operation_gen || st.interrupt.load(SeqCst) || *g(&st.enabled) != Some(true) {
        return false;
    }
    clear_error(st);
    *g(&st.phase) = "idle";
    emit(st);
    true
}

/// Delete the index files and open a fresh index. A file that will not go is
/// never reopened: the index stays unavailable instead.
fn rebuild_index(st: &SearchIndexState, operation_gen: u64) -> Result<(), String> {
    if !st.mail_dir_ok || st.switch.is_switching() {
        return Err("mail vault is unavailable or switching".into());
    }
    let gen = st.switch.current();
    let root = st.vault_root.clone();
    let mut guard = lock(&st.db);
    if st.switch.is_switching() || st.switch.current() != gen || st.operation_generation.load(SeqCst) != operation_gen || *g(&st.enabled) != Some(true) {
        return Err("search index rebuild was superseded".into());
    }
    *guard = None; // drop = checkpoint; keep the mutex through unlinking so a vault switch cannot start mid-delete
    *g(&st.root) = None;
    let dir = root.join(db::DB_DIR);
    // Reverse order, same reasoning as destroy_index.
    for suffix in ["-journal", "-shm", "-wal", ""] {
        // A vault operation may be copying these files, or `root` is no longer the vault.
        if st.switch.is_switching() || st.switch.current() != gen || st.operation_generation.load(SeqCst) != operation_gen || *g(&st.enabled) != Some(true) {
            return Err("search index rebuild was superseded".into());
        }
        let path = dir.join(format!("{}{suffix}", db::DB_FILE));
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("search index rebuild: cannot remove {}: {e}", path.display());
                drop(guard);
                set_error(st, format!("could not remove {}: {e}", path.display()));
                return Err(format!("could not remove {}: {e}", path.display()));
            }
        }
    }
    drop(guard);
    *g(&st.phase) = "recovering";
    clear_error(st);
    Ok(())
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
fn prescan_folder_counts(
    st: &SearchIndexState,
    maildir: &Path,
    dirs: &[(String, String)],
    keep_going: &dyn Fn() -> bool,
) -> Result<(), String> {
    let known: std::collections::HashSet<(String, String)> = {
        let guard = lock(&st.db);
        let conn = guard.as_ref().ok_or_else(|| "search index closed".to_string())?;
        let mut stmt = conn.prepare("SELECT account_id, vault_dir FROM mailbox_scan").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (account, dir) in dirs {
        if !keep_going() {
            return Ok(());
        }
        if known.contains(&(account.clone(), dir.clone())) {
            continue; // already has a real, authoritative count from a previous pass
        }
        let cur = maildir.join(account).join(dir).join("cur");
        let Ok(entries) = std::fs::read_dir(&cur) else { continue };
        let n = entries.flatten().filter(|e| vault_filename_uid(&e.file_name().to_string_lossy()).is_some()).count();
        #[cfg(test)]
        st.prescan_reads.fetch_add(1, SeqCst);
        let guard = lock(&st.db);
        let conn = guard.as_ref().ok_or_else(|| "search index closed".to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO mailbox_scan (account_id, vault_dir, scanned_at, file_count) VALUES (?1, ?2, unixepoch(), ?3)",
            rusqlite::params![account, dir, n as i64],
        )
        .map_err(|e| format!("prescan {account}/{dir}: {e}"))?;
    }
    Ok(())
}

pub(crate) fn sweep(
    st: &SearchIndexState,
    maildir: &Path,
    config: IndexConfig,
    only: Option<Vec<(String, String)>>,
    operation_gen: u64,
) -> SweepOutcome {
    *g(&st.phase) = "indexing";
    emit(st);
    // This callback can also be checked at a DB commit boundary. It must not
    // take the DB mutex itself.
    let keep_going = || {
        !st.interrupt.load(SeqCst)
            && st.operation_generation.load(SeqCst) == operation_gen
            && !st.switch.is_switching()
    };
    let full = only.is_none();
    let (dirs, listed) = match only {
        Some(folders) => (folders, true),
        None => match reconcile::list_vault_dirs(maildir) {
            Ok(dirs) => (dirs, true),
            Err(e) => {
                warn!("search index: listing the vault failed: {e}");
                return SweepOutcome { parsed: 0, completed: false, success: false, error: Some(e) };
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
        if let Err(e) = prescan_folder_counts(st, maildir, &dirs, &keep_going) {
            return SweepOutcome { parsed: 0, completed: false, success: false, error: Some(e) };
        }
        if !keep_going() {
            return SweepOutcome { parsed: 0, completed: false, success: false, error: None };
        }
        // Task 1.11 review M3: the phase-change emit above this block is
        // still `0 of 0` on a first pass (no rows, no mailbox_scan yet) — emit
        // again now the prescan has filled `total` in, so the pass's first
        // meaningful progress event already carries the real total.
        emit(st);
        match reconcile::prune_missing_dirs_guarded(&st.db, &dirs, &keep_going) {
            Ok(Some(_)) => {}
            Ok(None) => return SweepOutcome { parsed: 0, completed: false, success: false, error: None },
            Err(e) => return SweepOutcome { parsed: 0, completed: false, success: false, error: Some(format!("pruning missing folders failed: {e}")) },
        }
    }
    let mut completed = full && listed;
    let mut parsed = 0usize;
    for (account, dir) in dirs {
        if !keep_going() {
            completed = false;
            return SweepOutcome { parsed, completed, success: false, error: None };
        }
        let mut on_batch = |done: usize| { emit(st); e2e_pause_after(done); };
        match reconcile::reconcile_mailbox_guarded(&st.db, maildir, &account, &dir, config, &index_doc_from_light, &keep_going, &keep_going, &mut on_batch) {
            // configure/rebuild/close asked us to stop
            Ok(s) => {
                parsed += s.parsed;
                if s.interrupted {
                    completed = false;
                    break;
                }
                if !s.removed_keys.is_empty() {
                    match prune_metadata(st, &account, &s.removed_keys) {
                        Ok(0) => {}
                        Ok(dropped) => info!("search index {account}: forgot {dropped} metadata rows for deleted mail"),
                        // Metadata that outlives its message is untidy, not
                        // broken: never fail a sweep over it.
                        Err(e) => warn!("search index {account}: could not prune metadata: {e}"),
                    }
                }
                if s.parsed + s.removed + s.renamed > 0 {
                    info!("search index {account}/{dir}: {s:?}");
                } else if s.failed > 0 {
                    debug!("search index {account}/{dir}: {s:?}");
                }
            }
            Err(e) if e.contains("closed") => {
                completed = false;
                return SweepOutcome { parsed, completed, success: false, error: None };
            }
            Err(e) => {
                warn!("search index {account}/{dir}: {e}");
                return SweepOutcome {
                    parsed,
                    completed: false,
                    success: false,
                    error: Some(format!("reconciling {account}/{dir} failed: {e}")),
                };
            }
        }
    }
    if !keep_going() {
        return SweepOutcome { parsed, completed: false, success: false, error: None };
    }
    // First-pass completion is a promise that every folder was visited and all
    // corresponding SQL succeeded. Never publish it after a partial/error pass.
    if completed {
        let guard = lock(&st.db);
        let Some(conn) = guard.as_ref() else {
            return SweepOutcome { parsed, completed: false, success: false, error: None };
        };
        match db::first_pass_done_checked(conn) {
            Ok(false) => {
                if let Err(e) = db::meta_set(conn, db::FIRST_PASS_DONE, "1") {
                    return SweepOutcome { parsed, completed: false, success: false, error: Some(format!("recording first pass completion failed: {e}")) };
                }
            }
            Ok(true) => {}
            Err(e) => {
                return SweepOutcome { parsed, completed: false, success: false, error: Some(format!("checking first pass completion failed: {e}")) };
            }
        }
    }
    SweepOutcome { parsed, completed, success: true, error: None }
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
    use mailvault_core::maildir::INFO_PREFIX;

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
        let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, &format!("7{INFO_PREFIX}S.eml")).expect("parses");
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
        let doc = crate::search_index::index_doc_from_light(&eml_alternative("View this email in your browser", html), 1, &format!("1{INFO_PREFIX}.eml")).expect("parses");
        assert!(doc.body_text.contains("September statement"), "{:?}", doc.body_text);
        assert!(doc.body_text.contains("Balance due"), "{:?}", doc.body_text);
    }

    #[test]
    fn adapter_keeps_the_text_part_when_it_says_more_than_the_html() {
        let plain = "Hi Bob, the full minutes of Tuesday's meeting are below, with every action item and owner.";
        let doc = crate::search_index::index_doc_from_light(&eml_alternative(plain, "<p>See minutes</p>"), 1, &format!("1{INFO_PREFIX}.eml")).expect("parses");
        assert_eq!(doc.body_text.trim(), plain);
    }

    #[test]
    fn adapter_falls_back_to_html_when_the_text_part_is_whitespace() {
        let doc = crate::search_index::index_doc_from_light(&eml_alternative("  \r\n\t", "<p>From <b>html</b></p>"), 1, &format!("1{INFO_PREFIX}.eml")).expect("parses");
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
        let doc = crate::search_index::index_doc_from_light(&raw, 1, &format!("1{INFO_PREFIX}.eml")).expect("parses");
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
        let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, &format!("7{INFO_PREFIX}S.eml")).expect("parses");
        assert!(doc.attachment_candidates.is_empty(), "{:?}", doc.attachment_candidates);
    }

    #[test]
    fn assemble_rows_uses_row_json_without_reading_the_eml() {
        use mailvault_core::search_index::query::{SearchHit, SearchPage};
        let page = SearchPage {
            hits: vec![SearchHit {
                vault_dir: "INBOX".into(),
                uid: 7,
                filename: format!("7{INFO_PREFIX}AS.eml"),
                message_id: Some("<seven@example>".into()),
                row_json: r#"{"uid":7,"messageId":"<seven@example>","subject":"Indexed only"}"#.into(),
                body_matched: true,
                attach_matched: true,
                date_utc: 1,
                row_id: 7,
            }],
            total: 1,
            needles: vec!["indexed".into()],
        };
        let rows = crate::search_index::assemble_rows(&page);
        assert_eq!(rows[0]["subject"], "Indexed only");
        assert_eq!(rows[0]["flags"], serde_json::json!(["archived", "seen", "\\Seen"]));
        assert_eq!(rows[0]["vaultDir"], "INBOX");
        assert_eq!(rows[0]["matchedIn"], serde_json::json!(["subject", "body", "attachment"]));
    }

    #[test]
    fn assemble_rows_leaves_message_id_verification_for_open_time() {
        use mailvault_core::search_index::query::{SearchHit, SearchPage};
        let page = SearchPage {
            hits: vec![SearchHit {
                vault_dir: "INBOX".into(),
                uid: 5,
                filename: format!("5{INFO_PREFIX}.eml"),
                message_id: Some("<indexed@x.test>".into()),
                row_json: r#"{"uid":5,"messageId":"<indexed@x.test>","subject":"Indexed budget"}"#.into(),
                body_matched: false,
                attach_matched: false,
                date_utc: 1,
                row_id: 5,
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
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
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
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
        assert!(crate::search_index::rows_reply(&st, "acct", "INBOX", &[3]).is_empty(), "closed: nothing, the caller reads the files");

        *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
        {
            let guard = lock(&st.db);
            let conn = guard.as_ref().unwrap();
            // The row was parsed while the file was unread and unarchived; it has been renamed since.
            conn.execute(
                &"INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
                 VALUES ('acct', 'INBOX', 3, '3:2,AS.eml', 1, 1, 1, 1, '{\"uid\":3,\"subject\":\"Budget\",\"isArchived\":false,\"hasAttachments\":true}')".replace(":2,", INFO_PREFIX),
                [],
            ).unwrap();
            conn.execute(
                &"INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
                 VALUES ('acct', 'Projects_2026', 5, '5:2,.eml', 1, 1, 1, 1, '{\"uid\":5,\"subject\":\"Nested\"}')".replace(":2,", INFO_PREFIX),
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
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
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
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true, crate::events::EventBus::new(16));
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
            std::fs::write(cur.join(format!("{i}{INFO_PREFIX}S.eml")), eml).unwrap();
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
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}S.eml")), format!("From: a@x.test\r\nSubject: Seed {uid}\r\nMessage-ID: <{uid}@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbody {uid}\r\n")).unwrap();
        }
    }

    fn state(root: &std::path::Path) -> std::sync::Arc<crate::search_index::SearchIndexState> {
        crate::search_index::SearchIndexState::new(root.to_path_buf(), root.to_path_buf(), true, crate::events::EventBus::new(64))
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
        assert_eq!(crate::search_index::status_json(&st)["state"], "starting", "unconfigured");
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
    fn runtime_query_sql_failure_returns_an_error_then_worker_rebuilds_derived_index() {
        use mailvault_core::search_index::{db, lock, query::SearchRequest};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        let mail = tmp.path().join(format!("Maildir/acct/INBOX/cur/1{INFO_PREFIX}S.eml"));
        let mail_before = std::fs::read(&mail).unwrap();
        let sentinel = tmp.path().join("custody/search-recovery-sentinel.bin");
        std::fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        std::fs::write(&sentinel, b"custody data survives derived-index recovery").unwrap();
        let custody_before = std::fs::read(&sentinel).unwrap();
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "initial index", |s| s["firstPassDone"] == true && s["state"] == "idle");

        lock(&st.db).as_ref().unwrap().execute_batch("DROP TABLE messages").unwrap();
        let request = SearchRequest { account_id: "acct".into(), query: "body 1".into(), ..Default::default() };
        assert!(crate::search_index::search_reply(&st, &request).is_err(), "the RPC that detects a live-connection failure returns its SQL error");

        let recovered = wait_for(&st, "automatic structural recovery", |s| s["firstPassDone"] == true && s["state"] == "idle" && s["errorKey"].is_null());
        assert_eq!(recovered["available"], true);
        let reply = crate::search_index::search_reply(&st, &request).unwrap();
        assert_eq!(reply["available"], true);
        assert_eq!(reply["rows"][0]["subject"], "Seed 1");
        assert_eq!(std::fs::read(mail).unwrap(), mail_before, "recovery reads, never rewrites, mail");
        assert_eq!(std::fs::read(sentinel).unwrap(), custody_before, "recovery never opens or changes custody");
        let guard = lock(&st.db);
        assert_eq!(db::meta_get(guard.as_ref().unwrap(), db::FIRST_PASS_DONE).as_deref(), Some("1"));
    }

    #[test]
    fn enabled_startup_automatically_rebuilds_a_newer_search_schema() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        {
            let conn = db::open(tmp.path()).unwrap();
            db::meta_set(&conn, "schema_version", "99").unwrap();
        }
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        let status = wait_for(&st, "newer schema recovery", |s| s["state"] == "idle" && s["firstPassDone"] == true && s["errorKey"].is_null());
        assert_eq!(status["available"], true);
        assert_eq!(status["indexed"], 1);
        let guard = lock(&st.db);
        assert_eq!(
            db::meta_get(guard.as_ref().unwrap(), "schema_version"),
            Some(db::SCHEMA_VERSION.to_string()),
            "the rebuild writes the schema this build knows, whatever number that is"
        );
    }

    #[test]
    fn a_scoped_nudge_after_startup_lock_retries_with_a_full_first_pass() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        seed(tmp.path(), "acct", "Archive", 1);
        let holder = db::open(tmp.path()).unwrap();
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        wait_for(&st, "transient startup-lock error", |s| s["state"] == "error");
        drop(holder);

        crate::search_index::nudge(&st, "acct", "INBOX");
        let recovered = wait_for(&st, "full first pass after scoped nudge", |s| s["state"] == "idle" && s["firstPassDone"] == true);
        assert_eq!(recovered["indexed"], 2, "reopening after the failed startup must reconcile every folder");
        assert_eq!(lock(&st.db).as_ref().unwrap().query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn non_text_first_pass_metadata_rebuilds_automatically_without_touching_mail_or_custody() {
        use mailvault_core::search_index::{db, query::SearchRequest};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        let mail = tmp.path().join(format!("Maildir/acct/INBOX/cur/1{INFO_PREFIX}S.eml"));
        let mail_before = std::fs::read(&mail).unwrap();
        let sentinel = tmp.path().join("custody/search-recovery-sentinel.bin");
        std::fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        std::fs::write(&sentinel, b"custody survives malformed derived metadata").unwrap();
        let custody_before = std::fs::read(&sentinel).unwrap();
        let conn = db::open(tmp.path()).unwrap();
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('first_pass_done', X'00')", []).unwrap();
        drop(conn);
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        let status = wait_for(&st, "automatic malformed-metadata rebuild", |s| s["state"] == "idle" && s["firstPassDone"] == true && s["errorKey"].is_null());
        assert_eq!(status["available"], true);
        assert_eq!(status["indexed"], 1);

        let reply = crate::search_index::search_reply(
            &st,
            &SearchRequest { account_id: "acct".into(), query: "body 1".into(), ..Default::default() },
        ).unwrap();
        assert_eq!(reply["available"], true);
        assert_eq!(reply["rows"][0]["subject"], "Seed 1");
        assert_eq!(std::fs::read(mail).unwrap(), mail_before, "recovery reads, never rewrites, source mail");
        assert_eq!(std::fs::read(sentinel).unwrap(), custody_before, "recovery never opens or changes custody data");
    }

    #[test]
    fn first_pass_meta_write_failure_stays_in_error_and_retries_after_the_obstacle_is_removed() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        {
            let conn = db::open(tmp.path()).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER reject_first_pass BEFORE INSERT ON meta
                 WHEN NEW.key = 'first_pass_done'
                 BEGIN SELECT RAISE(FAIL, 'injected first-pass write failure'); END;",
            )
            .unwrap();
        }

        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        let failed = wait_for(&st, "first-pass meta write error", |status| status["state"] == "error");
        assert_eq!(failed["available"], true, "the SQL connection remains usable while recording first-pass completion fails");
        assert_eq!(failed["firstPassDone"], false);
        assert_eq!(failed["errorKey"], "searchIndex.recoveryFailed");

        lock(&st.db)
            .as_ref()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_first_pass")
            .unwrap();

        let recovered = wait_for(&st, "automatic first-pass retry", |status| status["state"] == "idle" && status["firstPassDone"] == true);
        assert_eq!(recovered["available"], true);
        assert_eq!(recovered["errorKey"], serde_json::Value::Null);
        assert_eq!(recovered["indexed"], 1);
    }

    #[test]
    fn transient_lock_nudges_respect_retry_deadline_then_recover_automatically() {
        use mailvault_core::search_index::{db, lock};
        let tmp = tempfile::tempdir().unwrap();
        let holder = db::open(tmp.path()).unwrap();
        db::meta_set(&holder, "transient_sentinel", "keep").unwrap();
        let st = state(tmp.path());
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        let failed = wait_for(&st, "lock error state", |s| s["state"] == "error");
        assert_eq!(failed["errorKey"], "searchIndex.recoveryFailed");
        let attempts = st.worker_passes.load(std::sync::atomic::Ordering::SeqCst);
        for _ in 0..3 {
            crate::search_index::nudge(&st, "acct", "INBOX");
            std::thread::sleep(std::time::Duration::from_millis(50));
            assert_eq!(st.worker_passes.load(std::sync::atomic::Ordering::SeqCst), attempts, "automatic folder nudges must not bypass the bounded recovery delay");
        }
        drop(holder);
        let recovered = wait_for(&st, "retry after removing lock", |s| s["state"] == "idle" && s["firstPassDone"] == true);
        assert_eq!(recovered["available"], true);
        let guard = lock(&st.db);
        assert_eq!(db::meta_get(guard.as_ref().unwrap(), "transient_sentinel").as_deref(), Some("keep"));
    }

    #[test]
    fn an_unreachable_vault_reports_a_retryable_error_and_opens_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false, crate::events::EventBus::new(8));
        crate::search_index::start(std::sync::Arc::clone(&st));
        crate::search_index::configure(&st, cfg());
        std::thread::sleep(std::time::Duration::from_millis(500));
        let status = crate::search_index::status_json(&st);
        assert_eq!(status["state"], "error");
        assert_eq!(status["errorKey"], "searchIndex.recoveryFailed");
        assert!(!index_file(tmp.path()).exists());
    }

    #[test]
    fn a_configured_closed_index_reopens_without_rebuilding() {
        use mailvault_core::search_index::{db, lock, reconcile::IndexConfig};
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "acct", "INBOX", 1);
        {
            let conn = db::open(tmp.path()).unwrap();
            db::meta_set(&conn, "recovery_sentinel", "keep").unwrap();
        }
        let st = state(tmp.path());
        *st.enabled.lock().unwrap() = Some(true);
        *st.config.lock().unwrap() = Some(IndexConfig { bodies: true, attachments: false, image_text: false });

        assert!(super::run_pass(&st, false, false, false, Some(Vec::new())));

        assert_eq!(crate::search_index::status_json(&st)["available"], true);
        let guard = lock(&st.db);
        assert_eq!(db::meta_get(guard.as_ref().unwrap(), "recovery_sentinel").as_deref(), Some("keep"), "automatic recovery must reopen, not delete, the existing index");
    }

    #[test]
    fn disabling_after_open_before_install_discards_the_connection() {
        use mailvault_core::search_index::lock;
        use std::sync::{Arc, Barrier};
        let tmp = tempfile::tempdir().unwrap();
        let st = state(tmp.path());
        *st.enabled.lock().unwrap() = Some(true);
        *st.config.lock().unwrap() = Some(mailvault_core::search_index::reconcile::IndexConfig { bodies: true, attachments: false, image_text: false });
        let opened = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let opened_hook = Arc::clone(&opened);
        let release_hook = Arc::clone(&release);
        *st.open_before_install_hook.lock().unwrap() = Some(Arc::new(move || {
            opened_hook.wait();
            release_hook.wait();
        }));

        let opening = Arc::clone(&st);
        let join = std::thread::spawn(move || crate::search_index::open_into(&opening));
        opened.wait();
        crate::search_index::configure(&st, crate::search_index::ConfigArgs { enabled: false, bodies: true, attachments: false, image_text: false });
        release.wait();

        assert!(join.join().unwrap().is_ok());
        assert!(lock(&st.db).is_none(), "a connection opened by the superseded generation must not install");
        assert!(st.root.lock().unwrap().is_none());
    }

    #[test]
    fn extraction_result_from_an_old_generation_does_not_commit_to_a_reopened_index() {
        use mailvault_core::search_index::{attachments::{AttachmentInput, ExtractError, TextExtractor}, db, lock, query::SearchRequest, reconcile::{self, IndexDoc}};
        use std::sync::{mpsc, Arc, Mutex};

        struct BlockingPdf { entered: mpsc::Sender<()>, release: Mutex<mpsc::Receiver<()>> }
        impl TextExtractor for BlockingPdf {
            fn pdf_text_layer(&self, _bytes: &[u8]) -> Result<(String, usize), ExtractError> {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                Ok(("stale extracted text should never reach the replacement index".into(), 1))
            }
            fn pdf_ocr(&self, _bytes: &[u8], _max_pages: usize) -> Result<String, ExtractError> { unreachable!() }
            fn image_ocr(&self, _bytes: &[u8], _mime: &str) -> Result<String, ExtractError> { unreachable!() }
        }
        fn with_pending_part(conn: &rusqlite::Connection) {
            conn.execute(&"INSERT INTO messages(account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, has_attachments, body_state, row_json) VALUES ('acct', 'INBOX', 1, '1:2,.eml', 1, 1, 1, 1, 1, '{}')".replace(":2,", INFO_PREFIX), []).unwrap();
            conn.execute("INSERT INTO attachments(message_row, part_index, filename, mime, size, state) VALUES (1, 0, 'report.pdf', 'application/pdf', 100, 'pending')", []).unwrap();
            conn.execute(&"INSERT INTO messages(account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, subject_lc, body_state, row_json) VALUES ('acct', 'INBOX', 2, '2:2,.eml', 1, 1, 2, 'responsive indexed row', 1, '{\"subject\":\"Responsive indexed row\",\"from\":{\"name\":\"\",\"address\":\"sender@example.test\"},\"to\":[],\"cc\":[],\"bcc\":[]}')".replace(":2,", INFO_PREFIX), []).unwrap();
            let indexed_row = conn.last_insert_rowid();
            conn.execute("INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (?1, 'Responsive indexed row', '', '', '')", [indexed_row]).unwrap();
            db::meta_set(conn, db::FIRST_PASS_DONE, "1").unwrap();
        }

        let old_root = tempfile::tempdir().unwrap();
        let new_root = tempfile::tempdir().unwrap();
        let st = state(old_root.path());
        let old = db::open(old_root.path()).unwrap();
        with_pending_part(&old);
        *lock(&st.db) = Some(old);
        *st.enabled.lock().unwrap() = Some(true);
        let generation = st.operation_generation.load(std::sync::atomic::Ordering::SeqCst);

        let new = db::open(new_root.path()).unwrap();
        with_pending_part(&new);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let extractor = Arc::new(BlockingPdf { entered: entered_tx, release: Mutex::new(release_rx) });
        let worker_state = Arc::clone(&st);
        let worker_extractor = Arc::clone(&extractor);
        let join = std::thread::spawn(move || reconcile::run_pending_extractions(
            &worker_state.db,
            true,
            false,
            true,
            worker_extractor.as_ref(),
            |_account, _dir, _uid, _filename, _part_index| Some((
                AttachmentInput { filename: "report.pdf".into(), mime: "application/pdf".into(), size: 100, bytes: vec![1] },
                IndexDoc::default(),
            )),
            &|| worker_state.operation_generation.load(std::sync::atomic::Ordering::SeqCst) == generation
                && *worker_state.enabled.lock().unwrap() == Some(true),
        ));

        entered_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("extractor did not reach the deterministic pause");

        // While extraction is paused outside the DB mutex, exercise the same
        // status, SQL search, disable, and rebuild entry points used by callers.
        // Bound the wait so a regressed lock scope fails cleanly after releasing
        // the extractor instead of hanging the test thread indefinitely.
        let (api_tx, api_rx) = mpsc::channel();
        let api_state = Arc::clone(&st);
        let api_join = std::thread::spawn(move || {
            let status = crate::search_index::status_json(&api_state);
            let reply = crate::search_index::search_reply(
                &api_state,
                &SearchRequest { account_id: "acct".into(), query: "responsive".into(), ..Default::default() },
            ).unwrap();
            crate::search_index::configure(&api_state, crate::search_index::ConfigArgs { enabled: false, bodies: true, attachments: true, image_text: true });
            crate::search_index::rebuild(&api_state);
            api_tx.send((status, reply)).unwrap();
        });
        let (status, reply) = match api_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(result) => result,
            Err(error) => {
                let _ = release_tx.send(());
                let extraction_result = join.join().unwrap();
                let _ = api_join.join();
                panic!("status/search/configure/rebuild did not respond while extraction was paused: {error}; extraction result {extraction_result:?}");
            }
        };
        api_join.join().unwrap();
        assert_eq!(status["available"], true);
        assert_eq!(reply["available"], true);
        assert_eq!(reply["rows"][0]["subject"], "Responsive indexed row");
        assert!(st.operation_generation.load(std::sync::atomic::Ordering::SeqCst) > generation);

        *lock(&st.db) = Some(new);
        release_tx.send(()).unwrap();
        assert_eq!(join.join().unwrap().unwrap(), 0);
        let guard = lock(&st.db);
        let conn = guard.as_ref().unwrap();
        let attachment_state: String = conn.query_row("SELECT state FROM attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(attachment_state, "pending", "a slow result from the old generation must not update the replacement connection");
        let fts_rows: i64 = conn.query_row("SELECT count(*) FROM msg_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts_rows, 1, "the replacement index retains its preexisting indexed row");
        let stale_hits = mailvault_core::search_index::query::search(
            conn,
            &SearchRequest { account_id: "acct".into(), query: "stale extracted text".into(), ..Default::default() },
        ).unwrap();
        assert!(stale_hits.hits.is_empty(), "the completed extractor result must never be searchable in the replacement index");
    }

    #[test]
    fn explicit_rebuild_replaces_an_unavailable_newer_schema_index() {
        use mailvault_core::search_index::{db, lock, reconcile::IndexConfig};
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = db::open(tmp.path()).unwrap();
            db::meta_set(&conn, "schema_version", "99").unwrap();
        }
        let st = state(tmp.path());
        *st.enabled.lock().unwrap() = Some(true);
        *st.config.lock().unwrap() = Some(IndexConfig { bodies: true, attachments: false, image_text: false });
        crate::search_index::open_into(&st);
        assert_eq!(crate::search_index::status_json(&st)["available"], false);
        assert!(st.root.lock().unwrap().is_none());
        {
            let conn = rusqlite::Connection::open(index_file(tmp.path())).unwrap();
            let version: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| row.get(0)).unwrap();
            assert_eq!(version, "99", "automatic open must preserve a newer-schema index");
        }

        crate::search_index::rebuild(&st);
        st.interrupt.store(false, std::sync::atomic::Ordering::SeqCst); // the worker clears this before processing the queued Rebuild signal
        assert!(super::run_pass(&st, false, false, false, None));

        let status = crate::search_index::status_json(&st);
        assert_eq!(status["available"], true);
        assert_eq!(status["state"], "idle");
        let guard = lock(&st.db);
        assert_eq!(db::meta_get(guard.as_ref().unwrap(), "schema_version"), Some(db::SCHEMA_VERSION.to_string()));
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
        super::prescan_folder_counts(&st, &tmp.path().join("Maildir"), &dirs, &keep_going).unwrap();

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

        let st = crate::search_index::SearchIndexState::new(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false, crate::events::EventBus::new(8));
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
    fn a_file_that_will_not_delete_fails_destroy_and_reports_the_cause_while_remaining_off() {
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
        assert_eq!(*st.phase.lock().unwrap(), "error");
        let detail = st.error_detail.lock().unwrap().clone().unwrap();
        assert!(detail.contains("could not remove") && detail.contains("search_index"), "the status must retain the filesystem failure cause: {detail}");
        assert_eq!(*st.enabled.lock().unwrap(), Some(false), "a failed explicit destroy still leaves indexing off");
        let status = crate::search_index::status_json(&st);
        assert_eq!(status["state"], "off", "disabled status remains off even while retaining the destroy error internally");
        assert_eq!(status["errorKey"], serde_json::Value::Null);
        assert!(index_file(tmp.path()).exists(), "failed removal leaves the index file in place");
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
        let out = crate::search_index::sweep(&st, &maildir, config, None, st.operation_generation.load(std::sync::atomic::Ordering::SeqCst));
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
    fn redundant_off_configure_does_not_cancel_a_queued_destroy() {
        use mailvault_core::search_index::db;
        let tmp = tempfile::tempdir().unwrap();
        drop(db::open(tmp.path()).unwrap());
        let st = state(tmp.path());
        *st.enabled.lock().unwrap() = Some(true);
        let rx = manual_channel(&st);
        let destroy = spawn_destroy(&st);
        wait_reply_slot(&st);
        let destroy_generation = st.destroy_generation.load(std::sync::atomic::Ordering::SeqCst);

        crate::search_index::configure(&st, crate::search_index::ConfigArgs { enabled: false, bodies: false, attachments: false, image_text: false });
        assert_eq!(
            st.operation_generation.load(std::sync::atomic::Ordering::SeqCst),
            destroy_generation,
            "a repeated off configuration must not supersede the already queued destroy",
        );
        spawn_worker(&st, rx);

        assert_eq!(destroy.join().unwrap(), serde_json::json!({"ok": true}));
        assert!(!index_file(tmp.path()).exists(), "the queued destroy must remove the index files");
        assert_eq!(*st.enabled.lock().unwrap(), Some(false));
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
