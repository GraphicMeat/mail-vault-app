//! Local search: glue between `mobile.db` and core's search index, which lives in its own
//! `<data_dir>/search.db` (`search_index::db::open_at`). Core owns the FTS schema, the writer and
//! the query parser; this file builds index docs from `mobile.db` rows, keeps the index in step
//! with the rows, backfills rows the index has not seen, and answers `mobile.search.local`.
//!
//! `search.db` has exactly one connection (core opens it EXCLUSIVE with no busy wait), held in
//! [`Search::conn`]; every user goes through `search_index::lock`. It is never ATTACHed to a
//! `mobile.db` connection (both have a `messages` table), so the two files never commit together:
//! a row commits in `mobile.db` first and the index follows right after, and a hit is shown only
//! if its `(account, folder, uid)` row still exists with `local_deleted` NULL (the join-back in
//! [`local`]). The `mobile.db` writer is never taken while the search lock is held.
//!
//! An index write that fails is logged as `[search] ...` (no subject, address or query text) and
//! never fails the sync pass, action or body open that triggered it. A tap (an action applied from
//! the UI, a body opened) never waits on the search lock: when the backfill holds it, the work goes
//! to the index worker, which re-reads the rows when it runs.

use crate::db::{lock, Engine, EngineError, Shared};
use crate::rpc::{parse, RpcError};
use mailvault_core::search_index::{self, db as sdb, query, reconcile::IndexDoc, text, writer, SharedConn};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::ThreadId;

pub(crate) const DB_FILE: &str = "search.db";
/// Most rows one index transaction (and one backfill chunk) writes.
const CHUNK: usize = 200;
/// Index hits per `mobile.search.local` page.
const PAGE: usize = 50;
/// `search.db` `meta` key prefix of a folder's backfill mark: the highest uid of the folder the
/// backfill has looked at, `<prefix><account>\n<folder>` -> uid.
const MARK: &str = "mobile.backfill:";

/// What the backfill worker has done since the engine opened. Tests read it
/// ([`Engine::search_backfill`]); nothing else does.
#[doc(hidden)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackfillStats {
    /// Chunks that indexed at least one row.
    pub chunks: u64,
    /// The most rows one chunk indexed.
    pub max_rows: usize,
    /// Rows indexed in all.
    pub rows: u64,
    /// The thread the chunks ran on.
    pub thread: Option<ThreadId>,
    /// Every folder has been looked at.
    pub done: bool,
}

/// Index work handed to the worker because the search lock was busy.
enum Job {
    /// (Re)index these rows from `mobile.db`.
    Index { account: String, folder: String, uids: Vec<u32> },
    /// Copy these rows' effective flags into the index.
    Reflag { account: String, folder: String, uids: Vec<u32> },
}

#[derive(Default)]
struct Work {
    started: bool,
    stop: bool,
    jobs: VecDeque<Job>,
    /// A job is running on the worker.
    busy: bool,
}

/// The search half of [`Shared`].
#[derive(Default)]
pub(crate) struct Search {
    /// `None` when `search.db` could not be opened (search answers `SEARCH_UNAVAILABLE`) and after
    /// the engine is dropped.
    conn: SharedConn,
    work: Mutex<Work>,
    cv: Condvar,
    stats: Mutex<BackfillStats>,
    /// The index worker, joined when the engine is dropped.
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

fn log_err(shared: &Shared, what: &str, e: impl std::fmt::Display) {
    shared.log(&format!("[search] {what}: {e}"));
}

// ── Open, worker, close ─────────────────────────────────────────────────────

/// Opens `<data_dir>/search.db` into the shared slot. A file core calls rebuildable (corrupt, a
/// newer index schema) is deleted and created again; the backfill then fills it. Any other failure
/// leaves the slot empty: search is unavailable, the rest of the engine runs.
pub(crate) fn open(shared: &Shared, data_dir: &Path) {
    let path = data_dir.join(DB_FILE);
    let conn = match sdb::open_at(&path) {
        Ok(c) => Some(c),
        Err(sdb::OpenError::Rebuildable(why)) => {
            log_err(shared, "rebuilding search.db", why);
            match crate::db::remove_db_files(&path) {
                Ok(()) => sdb::open_at(&path).map_err(|e| log_err(shared, "search.db after a rebuild", e)).ok(),
                Err(e) => {
                    log_err(shared, "removing search.db", e);
                    None
                }
            }
        }
        Err(e) => {
            log_err(shared, "opening search.db", e);
            None
        }
    };
    *search_index::lock(&shared.search.conn) = conn;
}

/// Starts the index worker (once): it runs queued jobs, then backfills, then sleeps until woken.
pub(crate) fn start(shared: &Arc<Shared>) {
    {
        let mut w = lock(&shared.search.work);
        if w.started || w.stop {
            return;
        }
        w.started = true;
    }
    let s = Arc::clone(shared);
    let spawned = std::thread::Builder::new().name("mv-search-index".into()).spawn(move || run(&s));
    match spawned {
        Ok(h) => *lock(&shared.search.handle) = Some(h),
        Err(e) => {
            lock(&shared.search.work).started = false;
            log_err(shared, "starting the index worker", e);
        }
    }
}

/// The engine is going away: the worker stops after its current job or chunk and is joined, and
/// `search.db` closes now. Joined, because the worker's `Arc<Shared>` would otherwise keep both
/// files open past the drop: `search.db` is locked EXCLUSIVE (the next engine on this directory
/// could not open it) and `mobile.db` would miss its closing checkpoint.
pub(crate) fn close(shared: &Shared) {
    lock(&shared.search.work).stop = true;
    shared.search.cv.notify_all();
    let handle = lock(&shared.search.handle).take();
    if let Some(h) = handle {
        if h.thread().id() != std::thread::current().id() {
            let _ = h.join();
        }
    }
    *search_index::lock(&shared.search.conn) = None;
}

fn run(shared: &Arc<Shared>) {
    crate::sync::background_qos();
    lock(&shared.search.stats).thread = Some(std::thread::current().id());
    let mut backfill = Backfill::default();
    loop {
        let job = {
            let mut w = lock(&shared.search.work);
            w.busy = false;
            if w.stop || shared.is_closing() {
                return;
            }
            let next = w.jobs.pop_front();
            match next {
                Some(j) => {
                    w.busy = true;
                    Some(j)
                }
                None if backfill.done => {
                    let _w = shared.search.cv.wait(w).unwrap_or_else(|p| p.into_inner());
                    continue;
                }
                None => None,
            }
        };
        match job {
            Some(Job::Index { account, folder, uids }) => index_uids(shared, &account, &folder, &uids),
            Some(Job::Reflag { account, folder, uids }) => reflag(shared, &account, &folder, &uids),
            None => {
                if let Err(e) = backfill.chunk(shared) {
                    log_err(shared, "backfill", e);
                    backfill.done = true;
                }
                if backfill.done {
                    lock(&shared.search.stats).done = true;
                }
            }
        }
    }
}

fn enqueue(shared: &Shared, job: Job) {
    lock(&shared.search.work).jobs.push_back(job);
    shared.search.cv.notify_all();
}

// ── Building docs ───────────────────────────────────────────────────────────

/// A `mobile.db` message row as the index needs it; `seen`/`flagged` are the effective values (a
/// local override, else the server's).
#[derive(Clone, Debug, Default)]
pub(crate) struct MessageRow {
    pub(crate) uid: u32,
    pub(crate) subject: String,
    pub(crate) from_name: String,
    pub(crate) from_address: String,
    pub(crate) date_ms: i64,
    pub(crate) message_id: String,
    pub(crate) to_json: String,
    pub(crate) has_attachments: bool,
    pub(crate) seen: bool,
    pub(crate) flagged: bool,
}

/// An address as core's index spells it: `Name <addr>`, or the bare address.
fn addr_text(v: &Value) -> String {
    let address = v.get("address").and_then(Value::as_str).unwrap_or("");
    match v.get("name").and_then(Value::as_str) {
        Some(name) if !name.is_empty() => format!("{name} <{address}>"),
        _ => address.to_string(),
    }
}

fn addr_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(l)) => l.iter().map(addr_text).filter(|a| !a.is_empty()).collect(),
        Some(one @ Value::Object(_)) => Some(addr_text(one)).filter(|a| !a.is_empty()).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// The index doc of one row: subject, sender, recipients (`to_json` plus `thread_json.cc`), the
/// body text when one is cached (else empty: header terms only). `row_json` is `"{}"` (results
/// are read back from `mobile.db`) and no attachment candidates (the phone does not extract).
pub(crate) fn doc_of(row: &MessageRow, thread: &Value, body_text: &str) -> IndexDoc {
    let to: Value = serde_json::from_str(&row.to_json).unwrap_or(Value::Null);
    let mut to_addrs = addr_list(Some(&to));
    to_addrs.extend(addr_list(thread.get("cc")));
    let from = json!({ "name": row.from_name, "address": row.from_address });
    let mut addrs: Vec<String> = Some(addr_text(&from)).filter(|a| !a.is_empty()).into_iter().collect();
    addrs.extend(to_addrs.iter().cloned());
    addrs.extend(addr_list(thread.get("replyTo")));
    IndexDoc {
        message_id: Some(row.message_id.clone()).filter(|m| !m.is_empty()),
        // Unix seconds; a row with no date is dated by the writer (now), never 1970.
        date_utc: (row.date_ms > 0).then(|| row.date_ms.div_euclid(1000)),
        from_addr: row.from_address.clone(),
        from_name: row.from_name.clone(),
        addrs,
        to_addrs,
        subject: row.subject.clone(),
        body_text: body_text.to_string(),
        has_attachments: row.has_attachments,
        row_json: "{}".into(),
        attachment_candidates: Vec::new(),
    }
}

/// Index flags from the effective read and starred state.
pub(crate) fn flag_letters(seen: bool, flagged: bool) -> Vec<String> {
    let mut out = Vec::new();
    if seen {
        out.push("S".to_string());
    }
    if flagged {
        out.push("F".to_string());
    }
    out
}

/// The text the index reads of a cached body: the text part, else the html's text.
fn body_text(html: Option<&str>, text_part: Option<&str>) -> String {
    match text_part.filter(|t| !t.trim().is_empty()) {
        Some(t) => t.to_string(),
        None => html.map(text::html_to_text).unwrap_or_default(),
    }
}

struct Doc {
    uid: u32,
    doc: IndexDoc,
    flags: Vec<String>,
}

/// The docs of `uids` (rows that exist), read fresh from `mobile.db` with their cached body.
fn read_docs(shared: &Shared, account: &str, folder: &str, uids: &[u32]) -> Result<Vec<Doc>, EngineError> {
    let mut out = Vec::with_capacity(uids.len());
    for chunk in uids.chunks(CHUNK) {
        let list = crate::sync::uid_list(chunk);
        let rows = shared.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT m.uid, m.subject, m.from_name, m.from_address, m.date_ms, m.message_id, m.to_json, m.thread_json,
                        m.has_attachments, COALESCE(m.local_seen, m.seen), COALESCE(m.local_flagged, m.flagged), b.html, b.text
                 FROM messages m LEFT JOIN bodies b ON b.account_id = m.account_id AND b.folder = m.folder AND b.uid = m.uid
                 WHERE m.account_id = ?1 AND m.folder = ?2 AND m.uid IN ({list})"
            ))?;
            let rows = st
                .query_map((account, folder), |r| {
                    Ok((
                        MessageRow {
                            uid: r.get::<_, i64>(0)? as u32,
                            subject: r.get(1)?,
                            from_name: r.get(2)?,
                            from_address: r.get(3)?,
                            date_ms: r.get(4)?,
                            message_id: r.get(5)?,
                            to_json: r.get(6)?,
                            has_attachments: r.get::<_, i64>(8)? != 0,
                            seen: r.get::<_, i64>(9)? != 0,
                            flagged: r.get::<_, i64>(10)? != 0,
                        },
                        r.get::<_, String>(7)?,
                        r.get::<_, Option<String>>(11)?,
                        r.get::<_, Option<String>>(12)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (row, thread, html, text_part) in rows {
            let thread: Value = serde_json::from_str(&thread).unwrap_or(Value::Null);
            let body = body_text(html.as_deref(), text_part.as_deref());
            out.push(Doc { uid: row.uid, flags: flag_letters(row.seen, row.flagged), doc: doc_of(&row, &thread, &body) });
        }
    }
    Ok(out)
}

/// Writes `docs` in transactions of at most [`CHUNK`] rows. With `only_missing`, a uid the index
/// already holds is left as it is (the backfill never replaces a fuller doc). `mark` is a `meta`
/// key and value written in the last transaction (the backfill's progress). Returns how many rows
/// were written.
fn write_docs(c: &Connection, account: &str, folder: &str, docs: &[Doc], only_missing: bool, mark: Option<(&str, &str)>) -> Result<usize, String> {
    let vault_dir = text::vault_dir_name(folder);
    let mut n = 0;
    let chunks: Vec<&[Doc]> = if docs.is_empty() { vec![docs] } else { docs.chunks(CHUNK).collect() };
    let last = chunks.len() - 1;
    for (i, chunk) in chunks.into_iter().enumerate() {
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        for d in chunk {
            if only_missing {
                let held = tx
                    .prepare_cached("SELECT 1 FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3")
                    .and_then(|mut st| st.query_row((account, &vault_dir, d.uid), |_| Ok(())).optional())
                    .map_err(|e| e.to_string())?;
                if held.is_some() {
                    continue;
                }
            }
            writer::index_doc(&tx, account, folder, d.uid, &d.doc, &d.flags)?;
            n += 1;
        }
        if let (true, Some((key, value))) = (i == last, mark) {
            sdb::meta_set(&tx, key, value)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(n)
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/// (Re)indexes the rows of `uids` as `mobile.db` now holds them, cached body included, so a
/// header write never wipes body terms. Waits for the search lock: for the sync worker, the
/// replay worker and the index worker, never a tap.
pub(crate) fn index_uids(shared: &Shared, account: &str, folder: &str, uids: &[u32]) {
    if uids.is_empty() {
        return;
    }
    let docs = match read_docs(shared, account, folder, uids) {
        Ok(d) => d,
        Err(e) => return log_err(shared, "reading rows to index", e),
    };
    let guard = search_index::lock(&shared.search.conn);
    if let Some(c) = guard.as_ref() {
        if let Err(e) = write_docs(c, account, folder, &docs, false, None) {
            log_err(shared, "indexing rows", e);
        }
    }
}

/// [`index_uids`] for a tap (a body just opened): when the lock is busy the worker does it.
pub(crate) fn index_uids_soon(shared: &Shared, account: &str, folder: &str, uids: &[u32]) {
    let docs = match read_docs(shared, account, folder, uids) {
        Ok(d) => d,
        Err(e) => return log_err(shared, "reading rows to index", e),
    };
    match shared.search.conn.try_lock() {
        Ok(guard) => write_now(shared, guard.as_ref(), account, folder, &docs),
        Err(std::sync::TryLockError::Poisoned(p)) => write_now(shared, p.into_inner().as_ref(), account, folder, &docs),
        Err(std::sync::TryLockError::WouldBlock) => {
            enqueue(shared, Job::Index { account: account.into(), folder: folder.into(), uids: uids.to_vec() })
        }
    }
}

fn write_now(shared: &Shared, c: Option<&Connection>, account: &str, folder: &str, docs: &[Doc]) {
    if let Some(c) = c {
        if let Err(e) = write_docs(c, account, folder, docs, false, None) {
            log_err(shared, "indexing rows", e);
        }
    }
}

/// The effective flags of `uids` as `mobile.db` now holds them (rows that exist).
fn read_flags(shared: &Shared, account: &str, folder: &str, uids: &[u32]) -> Result<Vec<(u32, Vec<String>)>, EngineError> {
    let mut out = Vec::with_capacity(uids.len());
    for chunk in uids.chunks(CHUNK) {
        let list = crate::sync::uid_list(chunk);
        let rows = shared.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT uid, COALESCE(local_seen, seen), COALESCE(local_flagged, flagged)
                 FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid IN ({list})"
            ))?;
            let rows = st
                .query_map((account, folder), |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? != 0, r.get::<_, i64>(2)? != 0)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        out.extend(rows.into_iter().map(|(uid, seen, flagged)| (uid, flag_letters(seen, flagged))));
    }
    Ok(out)
}

fn write_flags(c: &Connection, account: &str, folder: &str, flags: &[(u32, Vec<String>)]) -> Result<(), String> {
    for chunk in flags.chunks(CHUNK) {
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        for (uid, f) in chunk {
            writer::set_flags(&tx, account, folder, *uid, f)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copies the effective flags of `uids` into the index, keeping every search term (never
/// `index_doc`, which would drop the body's). Waits for the search lock.
pub(crate) fn reflag(shared: &Shared, account: &str, folder: &str, uids: &[u32]) {
    if uids.is_empty() {
        return;
    }
    let flags = match read_flags(shared, account, folder, uids) {
        Ok(f) => f,
        Err(e) => return log_err(shared, "reading flags", e),
    };
    if let Some(c) = search_index::lock(&shared.search.conn).as_ref() {
        if let Err(e) = write_flags(c, account, folder, &flags) {
            log_err(shared, "writing flags", e);
        }
    }
}

/// [`reflag`] for a tap: when the lock is busy the worker does it.
pub(crate) fn reflag_soon(shared: &Shared, account: &str, folder: &str, uids: &[u32]) {
    if uids.is_empty() {
        return;
    }
    let flags = match read_flags(shared, account, folder, uids) {
        Ok(f) => f,
        Err(e) => return log_err(shared, "reading flags", e),
    };
    let guard = match shared.search.conn.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            return enqueue(shared, Job::Reflag { account: account.into(), folder: folder.into(), uids: uids.to_vec() })
        }
    };
    if let Some(c) = guard.as_ref() {
        if let Err(e) = write_flags(c, account, folder, &flags) {
            log_err(shared, "writing flags", e);
        }
    }
}

/// Removes from the index those of `uids` whose `mobile.db` row is gone (a delete that kept a row
/// some journaled action names leaves it indexed).
pub(crate) fn forget_gone(shared: &Shared, account: &str, folder: &str, uids: &[u32]) {
    if uids.is_empty() {
        return;
    }
    let held = match read_flags(shared, account, folder, uids) {
        Ok(f) => f.into_iter().map(|(u, _)| u).collect::<std::collections::HashSet<u32>>(),
        Err(e) => return log_err(shared, "reading removed rows", e),
    };
    let gone: Vec<u32> = uids.iter().copied().filter(|u| !held.contains(u)).collect();
    if let Some(c) = search_index::lock(&shared.search.conn).as_ref() {
        for chunk in gone.chunks(CHUNK) {
            let out = c.unchecked_transaction().map_err(|e| e.to_string()).and_then(|tx| {
                for uid in chunk {
                    writer::forget(&tx, account, folder, *uid)?;
                }
                tx.commit().map_err(|e| e.to_string())
            });
            if let Err(e) = out {
                return log_err(shared, "forgetting rows", e);
            }
        }
    }
}

fn mark_key(account: &str, folder: &str) -> String {
    format!("{MARK}{account}\n{folder}")
}

/// Removes a folder's messages from the index (its rows were wiped: UIDVALIDITY reset, folder
/// gone) and its backfill mark.
pub(crate) fn forget_folder(shared: &Shared, account: &str, folder: &str) {
    if let Some(c) = search_index::lock(&shared.search.conn).as_ref() {
        let out = writer::forget_folder(c, account, folder).and_then(|()| {
            c.execute("DELETE FROM meta WHERE key = ?1", [mark_key(account, folder)]).map(|_| ()).map_err(|e| e.to_string())
        });
        if let Err(e) = out {
            log_err(shared, "forgetting a folder", e);
        }
    }
}

/// Removes every message of an account from the index, and its backfill marks. Run after its
/// rows left `mobile.db`. Goes by the folders the index itself holds, so a folder only the index
/// still knows goes too.
pub(crate) fn forget_account(shared: &Shared, account: &str) {
    if let Some(c) = search_index::lock(&shared.search.conn).as_ref() {
        let out = (|| -> Result<(), String> {
            let dirs: Vec<String> = {
                let mut st = c.prepare("SELECT DISTINCT vault_dir FROM messages WHERE account_id = ?1").map_err(|e| e.to_string())?;
                let rows = st.query_map([account], |r| r.get(0)).map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
            };
            for dir in dirs {
                // `vault_dir_name` of a sanitized name is the name itself.
                writer::forget_folder(c, account, &dir)?;
            }
            c.execute("DELETE FROM meta WHERE substr(key, 1, length(?1)) = ?1", [format!("{MARK}{account}\n")])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = out {
            log_err(shared, "forgetting an account", e);
        }
    }
}

// ── Backfill ────────────────────────────────────────────────────────────────

/// Indexes rows `mobile.db` holds and the index does not (rows synced before `search.db` existed,
/// or before a rebuild), folder by folder in uid order, [`CHUNK`] rows at a time. Each folder's
/// progress is a mark in `search.db` `meta`, so a run cut short resumes where it stopped.
#[derive(Default)]
struct Backfill {
    /// Folders still to look at; `None` until the first chunk lists them.
    folders: Option<VecDeque<(String, String)>>,
    done: bool,
}

impl Backfill {
    /// One chunk of the current folder (the search lock is held for the write only).
    fn chunk(&mut self, shared: &Shared) -> Result<(), String> {
        if self.folders.is_none() {
            let list: Vec<(String, String)> = shared
                .read(|c| {
                    let mut st = c.prepare("SELECT DISTINCT account_id, folder FROM messages ORDER BY account_id, folder")?;
                    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
                    Ok(rows)
                })
                .map_err(|e| e.to_string())?;
            self.folders = Some(list.into());
        }
        let Some((account, folder)) = self.folders.as_ref().and_then(|f| f.front().cloned()) else {
            self.done = true;
            return Ok(());
        };
        let key = mark_key(&account, &folder);
        let mark: Option<i64> = {
            let guard = search_index::lock(&shared.search.conn);
            let Some(c) = guard.as_ref() else {
                self.done = true;
                return Ok(());
            };
            sdb::meta_get_checked(c, &key)?.and_then(|v| v.parse().ok())
        };
        let uids: Vec<u32> = shared
            .read(|c| {
                let mut st = c.prepare_cached(
                    "SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid > ?3 ORDER BY uid LIMIT ?4",
                )?;
                let rows = st
                    .query_map((&account, &folder, mark.unwrap_or(-1), CHUNK as i64), |r| r.get::<_, i64>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows.into_iter().map(|u| u as u32).collect())
            })
            .map_err(|e| e.to_string())?;
        if uids.len() < CHUNK {
            if let Some(f) = self.folders.as_mut() {
                f.pop_front();
            }
        }
        let Some(top) = uids.last().copied() else {
            return Ok(());
        };
        let docs = read_docs(shared, &account, &folder, &uids).map_err(|e| e.to_string())?;
        let written = {
            let guard = search_index::lock(&shared.search.conn);
            let Some(c) = guard.as_ref() else {
                self.done = true;
                return Ok(());
            };
            write_docs(c, &account, &folder, &docs, true, Some((&key, &top.to_string())))?
        };
        if written > 0 {
            let mut st = lock(&shared.search.stats);
            st.chunks += 1;
            st.max_rows = st.max_rows.max(written);
            st.rows += written as u64;
        }
        Ok(())
    }
}

// ── mobile.search.local ─────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalParams {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    query: String,
    /// Index hits already read (the previous page's `cursor`).
    #[serde(default)]
    cursor: Option<u64>,
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// `mobile.search.local {accountId?, folder?, query, cursor?}` -> `{rows, cursor}`: list rows (plus
/// `accountId` and `folder`) whose message matches `query` as desktop matches it (core's query
/// parser and index), newest first, across every account unless one is named. `cursor` is null
/// at the end. A page reads [`PAGE`] index hits; a hit whose row is gone or deleted locally is
/// dropped, so a page can hold fewer rows than that with more to come.
pub(crate) fn local(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: LocalParams = parse(params)?;
    let shared = engine.shared();
    let offset = p.cursor.unwrap_or(0) as usize;
    if p.query.trim().is_empty() {
        return Ok(json!({ "rows": [], "cursor": null }));
    }
    // Every account's folder paths, to map an index folder name back to the folder.
    let folders: Vec<(String, String)> = engine
        .read(|c| {
            let mut st = c.prepare_cached("SELECT a.id, f.path FROM accounts a JOIN folders f ON f.account_id = a.id ORDER BY a.id, f.path")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;
    let accounts: Vec<String> = match &p.account_id {
        Some(a) => vec![a.clone()],
        None => {
            let mut all: Vec<String> = folders.iter().map(|(a, _)| a.clone()).collect();
            all.dedup();
            all
        }
    };
    if accounts.is_empty() {
        return Ok(json!({ "rows": [], "cursor": null }));
    }
    let req = query::SearchRequest {
        account_id: accounts[0].clone(),
        account_ids: if accounts.len() > 1 { accounts.clone() } else { Vec::new() },
        query: p.query.clone(),
        mailboxes: p.folder.clone().map(|f| vec![f]),
        limit: Some(PAGE),
        offset,
        ..Default::default()
    };
    let page = {
        let guard = search_index::lock(&shared.search.conn);
        let Some(c) = guard.as_ref() else {
            return Err(RpcError::SearchUnavailable);
        };
        query::search(c, &req).map_err(internal)?
    };
    // Index folder names are sanitized (`vault_dir_name`) and many-to-one: every folder of the
    // account with that name is a candidate, and the Message-ID decides between them.
    let mut by_dir: HashMap<(&str, String), Vec<&str>> = HashMap::new();
    for (a, path) in &folders {
        by_dir.entry((a.as_str(), text::vault_dir_name(path))).or_default().push(path.as_str());
    }
    let cols = crate::rpc::ROW_COLUMNS;
    let rows: Vec<Value> = engine
        .read(|c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {cols}, message_id FROM messages
                 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3 AND COALESCE(local_deleted, 0) = 0"
            ))?;
            let mut out = Vec::with_capacity(page.hits.len());
            for hit in &page.hits {
                let Some(paths) = by_dir.get(&(hit.account_id.as_str(), hit.vault_dir.clone())) else { continue };
                for path in paths {
                    let found = st
                        .query_row((&hit.account_id, path, hit.uid as i64), |r| Ok((crate::rpc::row_json(r)?, r.get::<_, String>(10)?)))
                        .optional()?;
                    let Some((mut row, message_id)) = found else { continue };
                    if !same_message(hit.message_id.as_deref(), &message_id) {
                        continue;
                    }
                    row["accountId"] = json!(hit.account_id);
                    row["folder"] = json!(path);
                    out.push(row);
                    break;
                }
            }
            Ok(out)
        })
        .map_err(internal)?;
    let next = offset + page.hits.len();
    let cursor = if page.hits.is_empty() || next as u64 >= page.total { Value::Null } else { json!(next) };
    Ok(json!({ "rows": rows, "cursor": cursor }))
}

/// Whether an index hit's Message-ID and a row's can name the same message (a side with none
/// cannot contradict the other).
fn same_message(indexed: Option<&str>, row: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches(|c| c == '<' || c == '>').trim().to_ascii_lowercase();
    match indexed.map(norm).filter(|s| !s.is_empty()) {
        Some(i) => {
            let r = norm(row);
            r.is_empty() || r == i
        }
        None => true,
    }
}

// ── Test seams ──────────────────────────────────────────────────────────────

impl Engine {
    /// Tests: what the index worker's backfill has done.
    #[doc(hidden)]
    pub fn search_backfill(&self) -> BackfillStats {
        lock(&self.shared().search.stats).clone()
    }

    /// Tests: the backfill is done and no index job is queued or running.
    #[doc(hidden)]
    pub fn search_idle(&self) -> bool {
        let w = lock(&self.shared().search.work);
        w.jobs.is_empty() && !w.busy && lock(&self.shared().search.stats).done
    }

    /// Tests: `(uid, flag letters)` of every message the index holds for the folder, by uid.
    /// Empty when search is unavailable.
    #[doc(hidden)]
    pub fn search_index_rows(&self, account: &str, folder: &str) -> Vec<(u32, String)> {
        let guard = search_index::lock(&self.shared().search.conn);
        let Some(c) = guard.as_ref() else { return Vec::new() };
        let read = || -> rusqlite::Result<Vec<(u32, String)>> {
            let mut st = c.prepare("SELECT uid, flags FROM messages WHERE account_id = ?1 AND vault_dir = ?2 ORDER BY uid")?;
            let rows = st.query_map((account, text::vault_dir_name(folder)), |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect()
        };
        read().unwrap_or_default()
    }

    /// Tests: whether `search.db` is open.
    #[doc(hidden)]
    pub fn search_available(&self) -> bool {
        search_index::lock(&self.shared().search.conn).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_of_spells_addresses_like_core() {
        let row = MessageRow {
            uid: 4,
            subject: "Hello".into(),
            from_name: "Ada".into(),
            from_address: "ada@example.test".into(),
            date_ms: 1_700_000_000_123,
            message_id: "<m@x>".into(),
            to_json: r#"[{"name":"","address":"bob@example.test"}]"#.into(),
            has_attachments: true,
            seen: true,
            flagged: false,
        };
        let thread = json!({ "cc": [{ "name": "Cy", "address": "cy@example.test" }], "replyTo": [{ "name": "", "address": "r@example.test" }] });
        let d = doc_of(&row, &thread, "body words");
        assert_eq!(d.addrs, vec!["Ada <ada@example.test>", "bob@example.test", "Cy <cy@example.test>", "r@example.test"]);
        assert_eq!(d.to_addrs, vec!["bob@example.test", "Cy <cy@example.test>"]);
        assert_eq!(d.date_utc, Some(1_700_000_000));
        assert_eq!(d.message_id.as_deref(), Some("<m@x>"));
        assert_eq!(d.row_json, "{}");
        assert!(d.attachment_candidates.is_empty());
        assert_eq!(doc_of(&MessageRow::default(), &Value::Null, "").date_utc, None);
        assert_eq!(flag_letters(true, true), vec!["S", "F"]);
        assert!(flag_letters(false, false).is_empty());
    }

    #[test]
    fn message_ids_compare_without_brackets() {
        assert!(same_message(Some("<A@x>"), "a@x"));
        assert!(same_message(None, "<b@x>"));
        assert!(same_message(Some("<a@x>"), ""));
        assert!(!same_message(Some("<a@x>"), "<b@x>"));
    }
}
