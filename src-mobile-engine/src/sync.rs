//! The sync worker: one background thread per engine that pulls an account's folder list and a
//! folder's last 90 days of headers into `mobile.db`, plus the RPCs around it
//! (`mobile.sync.refresh`, `mobile.folders.list`).
//!
//! The worker never degrades the UI: it runs at background QoS, does its network work outside any
//! write transaction, writes at most 200 message rows per transaction, and a page read goes
//! through the reader pool, which never waits on the writer. Events go out after the commit with
//! no engine lock held.
//!
//! Message identity is `(account_id, folder, uid)`, valid inside the folder's `uid_validity` (on
//! the folder row). A UIDVALIDITY change wipes the folder's rows and resyncs it.

use crate::accounts::{map_error, Code};
use crate::backend::{self, has_flag, Backend, FolderInfo, FolderRow, Header};
use crate::db::{lock, Engine, EngineError, Shared};
use crate::events::{FOLDERS_CHANGED, FOLDER_CHANGED, SYNC_STATE};
use crate::rpc::{parse, RpcError};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Header window per folder.
const WINDOW_DAYS: i64 = 90;
/// Most message rows one write transaction touches.
const BATCH: usize = 200;
const DAY_MS: i64 = 86_400_000;

// ── The worker and its queue ────────────────────────────────────────────────

/// One sync pass to run: the account's folder list and INBOX (`folder: None`), or one folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Job {
    account: String,
    folder: Option<String>,
}

impl Job {
    /// Running `self` also does everything `other` asks for.
    fn covers(&self, other: &Job) -> bool {
        self.account == other.account
            && (self.folder == other.folder || (self.folder.is_none() && other.folder.as_deref().is_some_and(is_inbox)))
    }
}

pub(crate) fn is_inbox(path: &str) -> bool {
    path.eq_ignore_ascii_case("INBOX")
}

#[derive(Default)]
struct QueueState {
    /// Jobs not yet started. A job that is running is not here, so a refresh that arrives
    /// during it queues a follow-up pass (mail that landed after its SEARCH is not lost).
    pending: VecDeque<Job>,
    started: bool,
    stop: bool,
}

#[derive(Default)]
struct Queue {
    state: Mutex<QueueState>,
    cv: Condvar,
}

/// The engine's sync worker. The thread starts with the first job.
#[derive(Default)]
pub(crate) struct Worker {
    queue: Arc<Queue>,
}

impl Worker {
    /// Queues `job` unless a queued job already covers it; returns at once.
    fn enqueue(&self, shared: &Arc<Shared>, job: Job) -> Result<(), String> {
        let mut st = lock(&self.queue.state);
        if st.stop {
            return Err("the engine is closing".into());
        }
        if !st.started {
            let (queue, shared) = (Arc::clone(&self.queue), Arc::clone(shared));
            std::thread::Builder::new()
                .name("mv-engine-sync".into())
                .spawn(move || run(queue, shared))
                .map_err(|e| format!("sync worker: {e}"))?;
            st.started = true;
        }
        if st.pending.iter().any(|q| q.covers(&job)) {
            return Ok(());
        }
        st.pending.retain(|q| !job.covers(q));
        st.pending.push_back(job);
        self.queue.cv.notify_one();
        Ok(())
    }

    /// Asks the thread to exit after the pass it is in. Does not wait for it.
    pub(crate) fn stop(&self) {
        lock(&self.queue.state).stop = true;
        self.queue.cv.notify_all();
    }
}

fn run(queue: Arc<Queue>, shared: Arc<Shared>) {
    background_qos();
    loop {
        let job = {
            let mut st = lock(&queue.state);
            loop {
                if st.stop {
                    return;
                }
                if let Some(job) = st.pending.pop_front() {
                    break job;
                }
                st = queue.cv.wait(st).unwrap_or_else(|p| p.into_inner());
            }
        };
        run_job(&shared, &job);
    }
}

/// Lowers the worker thread's priority: QoS utility on iOS, `nice` on Android, nothing elsewhere.
pub(crate) fn background_qos() {
    #[cfg(target_os = "ios")]
    {
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        /// `QOS_CLASS_UTILITY` from `<sys/qos.h>`.
        const QOS_CLASS_UTILITY: u32 = 0x11;
        // SAFETY: plain libc call on the current thread with valid arguments.
        unsafe {
            pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
        }
    }
    #[cfg(target_os = "android")]
    {
        extern "C" {
            fn nice(inc: i32) -> i32;
        }
        // SAFETY: plain libc call; on Linux it renices the calling thread only.
        unsafe {
            nice(10);
        }
    }
}

// ── One pass ────────────────────────────────────────────────────────────────

/// Why a pass (or a body fetch) stopped early.
pub(crate) enum Fail {
    /// The account was removed while the pass ran: stop quietly.
    Gone,
    /// The engine was dropped: stop before the next network call or write.
    Closing,
    /// A typed failure; the text is for the log only and never reaches an event.
    Code(Code, String),
}

impl From<String> for Fail {
    fn from(msg: String) -> Self {
        Fail::Code(map_error(&msg), msg)
    }
}

impl From<EngineError> for Fail {
    fn from(e: EngineError) -> Self {
        Fail::Code(Code::Invalid, e.to_string())
    }
}

impl Fail {
    /// What a backend answers for an operation it does not have (yet).
    pub(crate) fn unsupported(what: &str) -> Fail {
        Fail::Code(Code::Invalid, format!("{what} is not supported for this account"))
    }
}

fn run_job(shared: &Shared, job: &Job) {
    shared.emit(SYNC_STATE, json!({ "accountId": job.account, "state": "syncing" }));
    let end = match sync_job(shared, job) {
        Ok(()) | Err(Fail::Gone) | Err(Fail::Closing) => json!({ "accountId": job.account, "state": "idle" }),
        Err(Fail::Code(code, why)) => {
            shared.log(&format!("[sync] {} {:?}: {} {}", job.account, job.folder, code.as_str(), why));
            json!({ "accountId": job.account, "state": "error", "code": code.as_str() })
        }
    };
    shared.emit(SYNC_STATE, end);
}

fn sync_job(shared: &Shared, job: &Job) -> Result<(), Fail> {
    let mut backend = backend::open(shared, &job.account)?;
    let out = sync_session(shared, backend.as_mut(), job);
    // Signs out.
    drop(backend);
    out
}

/// Unit tests: runs one sync pass on the calling thread and panics unless it ends cleanly.
#[cfg(test)]
pub(crate) fn sync_now_for_test(shared: &Shared, account: &str, folder: Option<&str>) {
    let job = Job { account: account.into(), folder: folder.map(String::from) };
    match sync_job(shared, &job) {
        Ok(()) => {}
        Err(Fail::Code(code, why)) => panic!("sync failed: {} {why}", code.as_str()),
        Err(_) => panic!("sync stopped early"),
    }
}

fn sync_session(shared: &Shared, backend: &mut dyn Backend, job: &Job) -> Result<(), Fail> {
    let folder = match &job.folder {
        None => {
            sync_folder_list(shared, backend, &job.account)?;
            match folder_path(shared, &job.account, "INBOX")? {
                Some(p) => p,
                None => return Ok(()),
            }
        }
        Some(f) => match folder_path(shared, &job.account, f)? {
            Some(p) => p,
            None => {
                // A folder the list has not seen yet: list first.
                sync_folder_list(shared, backend, &job.account)?;
                folder_path(shared, &job.account, f)?.ok_or_else(|| Fail::Code(Code::Invalid, format!("no folder {f}")))?
            }
        },
    };
    sync_folder(shared, backend, &job.account, &folder)
}

/// The stored path of `folder` (INBOX matched case-insensitively, as RFC 3501 says).
pub(crate) fn folder_path(shared: &Shared, account: &str, folder: &str) -> Result<Option<String>, EngineError> {
    shared.read(|c| {
        let sql = if is_inbox(folder) {
            "SELECT path FROM folders WHERE account_id = ?1 AND path = ?2 COLLATE NOCASE"
        } else {
            "SELECT path FROM folders WHERE account_id = ?1 AND path = ?2"
        };
        c.query_row(sql, (account, folder), |r| r.get(0)).optional()
    })
}

/// Runs `f` in one write transaction if the account still exists; `Fail::Gone` if it does not.
pub(crate) fn write_for<T>(shared: &Shared, account: &str, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, Fail> {
    not_closing(shared)?;
    let out = shared.write(|c| {
        let exists = c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [account], |_| Ok(())).optional()?.is_some();
        if !exists {
            return Ok(None);
        }
        f(c).map(Some)
    })?;
    out.ok_or(Fail::Gone)
}

/// `Fail::Closing` once the engine has been dropped. Checked before every write and every batch
/// fetch, so a pass outliving its engine stops within one batch.
pub(crate) fn not_closing(shared: &Shared) -> Result<(), Fail> {
    if shared.is_closing() {
        Err(Fail::Closing)
    } else {
        Ok(())
    }
}

/// `uid IN (...)` for a chunk of uids (integers only, so the text is safe to inline).
pub(crate) fn uid_list(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

/// Deletes the message rows of `uids` and every body and attachment row they own. Dependents
/// first (a crash then leaves a message without its cached body, never an orphan body), each
/// table in transactions of at most [`BATCH`] rows however many attachments a message has.
/// With `keep_pending`, a uid some journaled action names is kept, checked inside each transaction
/// (an action applied mid-pass is seen). Returns the number of message rows removed.
pub(crate) fn delete_uids(shared: &Shared, account: &str, folder: &str, uids: &[u32], keep_pending: bool) -> Result<usize, Fail> {
    let mut removed = 0;
    let guard = if keep_pending { format!(" AND uid NOT IN ({})", crate::actions::PENDING_UIDS) } else { String::new() };
    for chunk in uids.chunks(BATCH) {
        let list = uid_list(chunk);
        for (table, key, cols, counts) in [
            ("attachments", "(uid, section)", "uid, section", false),
            ("bodies", "uid", "uid", false),
            ("messages", "uid", "uid", true),
        ] {
            let sql = format!(
                "DELETE FROM {table} WHERE account_id = ?1 AND folder = ?2 AND {key} IN
                   (SELECT {cols} FROM {table} WHERE account_id = ?1 AND folder = ?2 AND uid IN ({list}){guard} LIMIT {BATCH})"
            );
            loop {
                let n = write_for(shared, account, |c| c.execute(&sql, (account, folder)))?;
                if counts {
                    removed += n;
                }
                if n == 0 {
                    break;
                }
            }
        }
    }
    Ok(removed)
}

// ── Folder list ─────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Eq)]
struct StoredFolder {
    name: String,
    special_use: Option<String>,
    delimiter: Option<String>,
    noselect: bool,
    unseen: i64,
    total: i64,
}

fn sync_folder_list(shared: &Shared, backend: &mut dyn Backend, account: &str) -> Result<(), Fail> {
    let infos: Vec<FolderInfo> = backend.folders()?;

    let existing: HashMap<String, StoredFolder> = shared.read(|c| {
        let mut st = c.prepare_cached(
            "SELECT path, name, special_use, delimiter, noselect, unseen, total FROM folders WHERE account_id = ?1",
        )?;
        let rows = st
            .query_map([account], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    StoredFolder {
                        name: r.get(1)?,
                        special_use: r.get(2)?,
                        delimiter: r.get(3)?,
                        noselect: r.get::<_, i64>(4)? != 0,
                        unseen: r.get(5)?,
                        total: r.get(6)?,
                    },
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        Ok(rows)
    })?;

    let mut upserts: Vec<(String, StoredFolder)> = Vec::new();
    for m in &infos {
        let old = existing.get(&m.path);
        // A folder STATUS skipped (\Noselect) or refused keeps the counts it had.
        let (unseen, total) = m.counts.or_else(|| old.map(|o| (o.unseen, o.total))).unwrap_or((0, 0));
        let row = StoredFolder {
            name: m.name.clone(),
            special_use: m.special_use.clone(),
            delimiter: m.delimiter.clone(),
            noselect: m.noselect,
            unseen,
            total,
        };
        if old != Some(&row) {
            upserts.push((m.path.clone(), row));
        }
    }
    let listed: HashSet<&str> = infos.iter().map(|m| m.path.as_str()).collect();
    // Every server lists INBOX. A reply without it is short (a dropped or truncated LIST), not a
    // mailbox whose folders were all deleted: keep what is stored rather than wipe it.
    let mut gone: Vec<&String> = if infos.iter().any(|m| is_inbox(&m.path)) {
        existing.keys().filter(|p| !listed.contains(p.as_str())).collect()
    } else {
        if !existing.is_empty() {
            shared.log(&format!("[sync] {account}: LIST without INBOX ({} names); no folder removed", infos.len()));
        }
        Vec::new()
    };
    gone.sort();

    for chunk in upserts.chunks(BATCH) {
        write_for(shared, account, |c| {
            let mut st = c.prepare_cached(
                "INSERT INTO folders (account_id, path, name, special_use, delimiter, noselect, unseen, total)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (account_id, path) DO UPDATE SET
                   name = excluded.name, special_use = excluded.special_use, delimiter = excluded.delimiter,
                   noselect = excluded.noselect, unseen = excluded.unseen, total = excluded.total",
            )?;
            for (path, f) in chunk {
                st.execute((account, path, &f.name, &f.special_use, &f.delimiter, f.noselect as i64, f.unseen, f.total))?;
            }
            Ok(())
        })?;
    }
    for path in &gone {
        // Its journaled actions can never replay; they drop before the rows go.
        crate::actions::drop_folder_actions(shared, account, path, None, crate::actions::Reason::FolderGone)?;
        delete_folder_rows(shared, account, path)?;
        write_for(shared, account, |c| c.execute("DELETE FROM folders WHERE account_id = ?1 AND path = ?2", (account, path)))?;
    }
    if !upserts.is_empty() || !gone.is_empty() {
        shared.emit(FOLDERS_CHANGED, json!({ "accountId": account }));
    }
    Ok(())
}

/// Deletes every message, body and attachment row of a folder, at most [`BATCH`] rows per
/// transaction. Returns the number of message rows removed.
fn delete_folder_rows(shared: &Shared, account: &str, folder: &str) -> Result<usize, Fail> {
    let mut removed = 0;
    for (sql, counts) in [
        (
            "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid IN
               (SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2 LIMIT 200)",
            true,
        ),
        (
            "DELETE FROM bodies WHERE account_id = ?1 AND folder = ?2 AND uid IN
               (SELECT uid FROM bodies WHERE account_id = ?1 AND folder = ?2 LIMIT 200)",
            false,
        ),
        (
            "DELETE FROM attachments WHERE account_id = ?1 AND folder = ?2 AND (uid, section) IN
               (SELECT uid, section FROM attachments WHERE account_id = ?1 AND folder = ?2 LIMIT 200)",
            false,
        ),
    ] {
        loop {
            let n = write_for(shared, account, |c| c.execute(sql, (account, folder)))?;
            if counts {
                removed += n;
            }
            if n == 0 {
                break;
            }
        }
    }
    Ok(removed)
}

// ── Folder headers ──────────────────────────────────────────────────────────

/// What one folder pass changed; published as one `mobile.folder.changed`.
struct Pass {
    added: usize,
    removed: usize,
    updated: usize,
    /// The generation this pass stamps on the rows it writes.
    gen: i64,
}

impl Pass {
    fn changed(&self) -> bool {
        self.added + self.removed + self.updated > 0
    }
}

fn sync_folder(shared: &Shared, backend: &mut dyn Backend, account: &str, folder: &str) -> Result<(), Fail> {
    let stored = shared.read(|c| {
        c.query_row(
            "SELECT uid_validity, noselect, unseen, total FROM folders WHERE account_id = ?1 AND path = ?2",
            (account, folder),
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)? != 0, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
        )
        .optional()
    })?;
    let Some((stored_validity, noselect, old_unseen, old_total)) = stored else {
        return Err(Fail::Gone);
    };
    if noselect {
        return Ok(());
    }
    let mut pass = Pass { added: 0, removed: 0, updated: 0, gen: shared.list_gen(account, folder)? + 1 };
    let out = sync_folder_pass(shared, backend, account, folder, stored_validity, &mut pass);
    // Published even when the pass failed part-way: what it committed is in the table.
    if pass.changed() {
        let gen = shared.publish_list_gen(account, folder, pass.gen);
        shared.emit(
            FOLDER_CHANGED,
            json!({
                "accountId": account, "folder": folder,
                "added": pass.added, "removed": pass.removed, "updated": pass.updated, "listGen": gen,
            }),
        );
    }
    let (unseen, total) = out?;
    if (unseen, total) != (old_unseen, old_total) {
        shared.emit(FOLDERS_CHANGED, json!({ "accountId": account }));
    }
    Ok(())
}

/// The pass itself; returns the folder's `(unseen, total)` as the server counts them.
fn sync_folder_pass(
    shared: &Shared,
    backend: &mut dyn Backend,
    account: &str,
    folder: &str,
    stored_validity: Option<i64>,
    pass: &mut Pass,
) -> Result<(i64, i64), Fail> {
    let mbox = backend.select(folder)?;
    let validity = mbox.uid_validity;
    if stored_validity != Some(validity) {
        // The folder's uids now name other messages: a journaled action applied under another
        // generation drops with GONE (it would hit someone else's message), then every row goes.
        crate::actions::drop_folder_actions(shared, account, folder, Some(validity), crate::actions::Reason::Gone)?;
        pass.removed += delete_folder_rows(shared, account, folder)?;
        write_for(shared, account, |c| {
            c.execute(
                "UPDATE folders SET uid_validity = ?3, uid_next = NULL WHERE account_id = ?1 AND path = ?2",
                (account, folder, validity),
            )
        })?;
    }

    let here = FolderRow::new(folder, Some(validity));
    let backend::Window { uids: window, unseen } = backend.window(folder, window_start_ms(now_ms()))?;
    let in_window: HashSet<u32> = window.iter().copied().collect();
    // Read before the flag FETCH: whether this pass may clear a disagreeing override (see
    // `write_flags`) is judged against it.
    let at = shared.settles(account, folder);
    let existing: HashMap<u32, Held> = shared.read(|c| {
        let mut st = c.prepare_cached(
            "SELECT uid, seen, flagged, local_seen IS NOT NULL OR local_flagged IS NOT NULL OR local_deleted IS NOT NULL
             FROM messages WHERE account_id = ?1 AND folder = ?2",
        )?;
        let rows = st
            .query_map((account, folder), |r| {
                Ok((
                    r.get::<_, i64>(0)? as u32,
                    Held { seen: r.get::<_, i64>(1)? != 0, flagged: r.get::<_, i64>(2)? != 0, overridden: r.get(3)? },
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        Ok(rows)
    })?;

    // Flags of the rows already held in the window. None held (a new or emptied folder): no read,
    // since `UID FETCH n:*` on an empty mailbox is an error on some servers. A row is written when
    // the server's flags changed or it carries a local override that may now clear.
    let held: Vec<u32> = window.iter().copied().filter(|u| existing.contains_key(u)).collect();
    let changes: Vec<(u32, bool, bool)> = backend
        .flags(&here, &held)?
        .iter()
        .filter(|(uid, _)| in_window.contains(uid))
        .filter_map(|(uid, fl)| {
            let held = existing.get(uid)?;
            let (seen, flagged) = (fl.seen, fl.flagged);
            (seen != held.seen || flagged != held.flagged || held.overridden).then_some((*uid, seen, flagged))
        })
        .collect();
    for chunk in changes.chunks(BATCH) {
        pass.updated += write_for(shared, account, |c| write_flags(shared, c, account, folder, chunk, pass.gen, at))?;
    }

    // Rows no longer in the window: expunged, moved away, or aged out of the 90 days. A row a
    // journaled action names stays until that action settles: replay decides (GONE removes it).
    let mut gone: Vec<u32> = existing.keys().copied().filter(|u| !in_window.contains(u)).collect();
    gone.sort_unstable();
    pass.removed += delete_uids(shared, account, folder, &gone, true)?;

    // New rows, newest uid first so the top of the list fills first. The fetch runs outside any
    // transaction; each batch then commits on its own.
    let mut new: Vec<u32> = window.iter().copied().filter(|u| !existing.contains_key(u)).collect();
    new.sort_unstable_by(|a, b| b.cmp(a));
    for chunk in new.chunks(BATCH) {
        not_closing(shared)?;
        let headers = backend.headers(&here, chunk)?;
        let n = write_for(shared, account, |c| insert_headers(c, account, folder, &headers, pass.gen))?;
        pass.added += n;
    }

    let total = mbox.total;
    write_for(shared, account, |c| {
        c.execute(
            "UPDATE folders SET uid_next = ?3, unseen = ?4, total = ?5, synced_ms = ?6 WHERE account_id = ?1 AND path = ?2",
            (account, folder, mbox.uid_next, unseen, total, now_ms()),
        )
    })?;
    shared.pass_completed(account, folder, at);
    Ok((unseen, total))
}

/// A held row as a pass starts: the server's flags and whether any `local_*` override is set.
struct Held {
    seen: bool,
    flagged: bool,
    overridden: bool,
}

/// Writes the server's flags of `chunk` (one write transaction) and settles local overrides: an
/// override a journaled action still names is never touched; otherwise it clears when the server
/// agrees with it. One the server disagrees with clears only on the second consecutive pass that
/// started after the folder's last settled action, with none settling during it
/// (`Shared::may_clear_disagreeing`): a server whose replicas lag may report the old flags for a
/// pass or so after it accepted the change. Returns how many rows now list differently.
fn write_flags(
    shared: &Shared,
    c: &Connection,
    account: &str,
    folder: &str,
    chunk: &[(u32, bool, bool)],
    gen: i64,
    at: crate::db::Settles,
) -> rusqlite::Result<usize> {
    let pending: HashSet<u32> = {
        let mut st = c.prepare_cached(crate::actions::PENDING_UIDS)?;
        let rows = st.query_map((account, folder), |r| r.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|u| u as u32).collect()
    };
    let settled = shared.may_clear_disagreeing(account, folder, at);
    let mut listed = c.prepare_cached(
        "SELECT COALESCE(local_seen, seen), COALESCE(local_flagged, flagged), COALESCE(local_deleted, 0)
         FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    let mut update = c.prepare_cached(
        "UPDATE messages SET seen = ?4, flagged = ?5, list_gen = ?6,
           local_seen = CASE WHEN ?7 THEN local_seen WHEN local_seen = ?4 OR ?8 THEN NULL ELSE local_seen END,
           local_flagged = CASE WHEN ?7 THEN local_flagged WHEN local_flagged = ?5 OR ?8 THEN NULL ELSE local_flagged END,
           local_deleted = CASE WHEN ?7 OR NOT ?8 THEN local_deleted ELSE NULL END
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    let mut n = 0;
    for (uid, seen, flagged) in chunk {
        let read = |st: &mut rusqlite::CachedStatement<'_>| {
            st.query_row((account, folder, *uid as i64), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
                .optional()
        };
        let Some(before) = read(&mut listed)? else { continue };
        update.execute((account, folder, *uid as i64, *seen as i64, *flagged as i64, gen, pending.contains(uid), settled))?;
        if read(&mut listed)? != Some(before) {
            n += 1;
        }
    }
    Ok(n)
}

fn insert_headers(c: &Connection, account: &str, folder: &str, headers: &[Header], gen: i64) -> rusqlite::Result<usize> {
    let mut st = c.prepare_cached(
        "INSERT INTO messages
           (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged,
            has_attachments, message_id, to_json, size, list_gen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (account_id, folder, uid) DO UPDATE SET
           subject = excluded.subject, from_name = excluded.from_name, from_address = excluded.from_address,
           date_ms = excluded.date_ms, seen = excluded.seen, flagged = excluded.flagged,
           has_attachments = excluded.has_attachments, message_id = excluded.message_id,
           to_json = excluded.to_json, size = excluded.size, list_gen = excluded.list_gen",
    )?;
    let mut n = 0;
    for h in headers {
        let to: Vec<Value> = h.to.iter().map(|a| json!({ "name": a.name, "address": a.address })).collect();
        n += st.execute((
            account,
            folder,
            h.uid as i64,
            &h.subject,
            h.from.name.as_deref().unwrap_or(""),
            &h.from.address,
            header_date_ms(h),
            has_flag(&h.flags, "\\Seen") as i64,
            has_flag(&h.flags, "\\Flagged") as i64,
            h.has_attachments as i64,
            h.message_id.as_deref().unwrap_or(""),
            Value::Array(to).to_string(),
            h.size.unwrap_or(0) as i64,
            gen,
        ))?;
    }
    Ok(n)
}

/// When the message arrived (INTERNALDATE, which the window is judged by too), else its `Date:`.
fn header_date_ms(h: &Header) -> i64 {
    h.internal_date
        .as_deref()
        .and_then(rfc3339_ms)
        .or_else(|| h.date.as_deref().and_then(mailvault_core::maildir::header_date_secs).map(|s| s * 1000))
        .unwrap_or(0)
}

// ── Dates without a date crate ──────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `(year, month 1-12, day 1-31)` of a day count since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

/// The first instant of the sync window's first day (UTC): [`WINDOW_DAYS`] days before today.
fn window_start_ms(now_ms: i64) -> i64 {
    (now_ms.div_euclid(DAY_MS) - WINDOW_DAYS) * DAY_MS
}

/// `SINCE dd-Mon-yyyy` for the day `start_ms` falls on (IMAP dates are whole days).
pub(crate) fn since_criteria(start_ms: i64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (y, m, d) = civil_from_days(start_ms.div_euclid(DAY_MS));
    format!("SINCE {d:02}-{}-{y}", MONTHS[(m - 1) as usize])
}

/// Epoch ms of the RFC 3339 form core writes an INTERNALDATE in (`2026-01-01T12:00:00+02:00`,
/// optional fraction, `Z` accepted).
fn rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if !s.is_ascii() {
        return None;
    }
    let num = |a: usize, b: usize| -> Option<i64> {
        let t = s.get(a..b)?;
        t.bytes().all(|c| c.is_ascii_digit()).then(|| t.parse().ok()).flatten()
    };
    if s.len() < 20 || &s[4..5] != "-" || &s[7..8] != "-" || !matches!(&s[10..11], "T" | "t" | " ") || &s[13..14] != ":" || &s[16..17] != ":" {
        return None;
    }
    let (y, mo, d, h, mi, sec) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut frac_ms = 0;
    if let Some(r) = rest.strip_prefix('.') {
        let digits = r.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let ms_text: String = r[..digits].chars().chain("000".chars()).take(3).collect();
        frac_ms = ms_text.parse::<i64>().ok()?;
        rest = &r[digits..];
    }
    let offset_min = match rest {
        "Z" | "z" => 0,
        o if o.len() == 6 && (o.starts_with('+') || o.starts_with('-')) && &o[3..4] == ":" => {
            let hh: i64 = o[1..3].parse().ok()?;
            let mm: i64 = o[4..6].parse().ok()?;
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (hh * 60 + mm)
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + frac_ms)
}

// ── RPCs ────────────────────────────────────────────────────────────────────

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn account_exists(engine: &Engine, account: &str) -> Result<bool, RpcError> {
    engine
        .read(|c| c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [account], |_| Ok(())).optional().map(|o| o.is_some()))
        .map_err(internal)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshParams {
    account_id: String,
    #[serde(default)]
    folder: Option<String>,
}

/// `mobile.sync.refresh {accountId, folder?}` -> `{queued: true}`. Queues the pass and returns;
/// the worker thread does the network work and reports through events.
pub(crate) fn refresh(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RefreshParams = parse(params)?;
    if !account_exists(engine, &p.account_id)? {
        return Err(RpcError::Invalid("unknown account".into()));
    }
    // A refresh is the user asking for the server now: queued actions go too, backoff forgiven.
    if crate::actions::has_pending(engine.shared(), Some(&p.account_id)) {
        engine.replay().wake(engine.shared(), Some(&p.account_id));
    }
    engine
        .sync_worker()
        .enqueue(engine.shared(), Job { account: p.account_id, folder: p.folder })
        .map_err(RpcError::Internal)?;
    Ok(json!({ "queued": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoldersParams {
    account_id: String,
}

struct ListedFolder {
    path: String,
    name: String,
    special_use: Option<String>,
    delimiter: Option<String>,
    noselect: bool,
    unseen: i64,
    total: i64,
}

/// Sort rank among siblings: Inbox, Drafts, Sent, Archive, Junk, Trash, then the rest.
fn rank(f: &ListedFolder) -> u8 {
    if is_inbox(&f.path) {
        return 0;
    }
    match f.special_use.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("\\inbox") => 0,
        Some("\\drafts") => 1,
        Some("\\sent") => 2,
        Some("\\archive") => 3,
        Some("\\junk") => 4,
        Some("\\trash") => 5,
        _ => 6,
    }
}

/// `mobile.folders.list {accountId}` -> `{folders: [{path, name, specialUse, unseen, total, depth,
/// noselect}]}`: the folder tree flattened depth first, each level sorted by [`rank`] and then by
/// name. A folder sits under its parent when the parent is listed; a special-use folder is never
/// hoisted out of its parent.
pub(crate) fn folders_list(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: FoldersParams = parse(params)?;
    let folders: Vec<ListedFolder> = engine
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT path, name, special_use, delimiter, noselect, unseen, total FROM folders WHERE account_id = ?1",
            )?;
            let rows = st
                .query_map([&p.account_id], |r| {
                    Ok(ListedFolder {
                        path: r.get(0)?,
                        name: r.get(1)?,
                        special_use: r.get(2)?,
                        delimiter: r.get(3)?,
                        noselect: r.get::<_, i64>(4)? != 0,
                        unseen: r.get(5)?,
                        total: r.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;

    let index: HashMap<&str, usize> = folders.iter().enumerate().map(|(i, f)| (f.path.as_str(), i)).collect();
    let parent_of = |f: &ListedFolder| -> Option<usize> {
        let d = f.delimiter.as_deref().filter(|d| !d.is_empty())?;
        let (parent, _) = f.path.rsplit_once(d)?;
        index.get(parent).copied()
    };
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); folders.len()];
    let mut roots: Vec<usize> = Vec::new();
    for (i, f) in folders.iter().enumerate() {
        match parent_of(f) {
            Some(pi) if pi != i => children[pi].push(i),
            _ => roots.push(i),
        }
    }
    let order = |v: &mut Vec<usize>| {
        v.sort_by(|&a, &b| {
            let (fa, fb) = (&folders[a], &folders[b]);
            (rank(fa), fa.name.to_lowercase(), &fa.path).cmp(&(rank(fb), fb.name.to_lowercase(), &fb.path))
        })
    };
    order(&mut roots);
    for c in children.iter_mut() {
        order(c);
    }
    let mut out = Vec::with_capacity(folders.len());
    let mut stack: Vec<(usize, usize)> = roots.iter().rev().map(|&i| (i, 0)).collect();
    while let Some((i, depth)) = stack.pop() {
        let f = &folders[i];
        out.push(json!({
            "path": f.path, "name": f.name, "specialUse": f.special_use,
            "unseen": f.unseen, "total": f.total, "depth": depth, "noselect": f.noselect,
        }));
        stack.extend(children[i].iter().rev().map(|&c| (c, depth + 1)));
    }
    Ok(json!({ "folders": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for z in [-800_000, -1, 0, 1, 365, 19_000, 20_454, 2_932_896] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    }

    #[test]
    fn since_is_90_days_back() {
        // 2026-11-06T10:00:00Z -> 2026-08-08.
        let now = days_from_civil(2026, 11, 6) * DAY_MS + 10 * 3_600_000;
        assert_eq!(since_criteria(window_start_ms(now)), "SINCE 08-Aug-2026");
    }

    #[test]
    fn rfc3339_reads_core_internaldate() {
        let base = days_from_civil(2026, 1, 1) * 86_400_000 + 12 * 3_600_000;
        assert_eq!(rfc3339_ms("2026-01-01T12:00:00+00:00"), Some(base));
        assert_eq!(rfc3339_ms("2026-01-01T14:00:00+02:00"), Some(base));
        assert_eq!(rfc3339_ms("2026-01-01T12:00:00.250Z"), Some(base + 250));
        assert_eq!(rfc3339_ms("Thu, 01 Jan 2026 12:00:00 +0000"), None);
        assert_eq!(rfc3339_ms(""), None);
    }

    fn count(e: &Engine, table: &str) -> i64 {
        e.read(|c| c.query_row(&format!("SELECT count(*) FROM {table} WHERE folder = 'INBOX'"), [], |r| r.get(0))).unwrap()
    }

    fn sync_ok(e: &Engine, account: &str, folder: Option<&str>) {
        let job = Job { account: account.into(), folder: folder.map(String::from) };
        match sync_job(e.shared(), &job) {
            Ok(()) => {}
            Err(Fail::Code(code, why)) => panic!("sync failed: {} {why}", code.as_str()),
            Err(_) => panic!("sync stopped early"),
        }
    }

    /// Removing a window whose messages own more than 200 body and attachment rows stays inside
    /// 200 rows per write transaction, and leaves nothing behind.
    #[test]
    fn removal_with_many_dependents_keeps_transactions_small() {
        use mock_imap::state::{Mailbox, Message};
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let recent = now_ms() - 2 * DAY_MS;
        let mut mb = Mailbox::new("INBOX");
        for uid in 1..=250u32 {
            mb.add(
                Message::new(uid, format!("From: a{uid} <a{uid}@example.com>\nSubject: s{uid}\nMessage-ID: <r{uid}@x>\n\nbody\n"))
                    .with_internal_ms(recent + uid as i64),
            );
        }
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(mb));
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "u@example.test", "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();

        e.shared().max_txn_rows(true);
        sync_ok(&e, &account, None);
        assert_eq!(count(&e, "messages"), 250);
        let first = e.shared().max_txn_rows(false);
        assert!(first <= 200, "the first sync wrote {first} rows in one transaction");

        // A cached body and three attachments for every message: 1000 dependent rows.
        e.write(|c| {
            for uid in 1..=250i64 {
                c.execute("INSERT INTO bodies (account_id, folder, uid, text) VALUES (?1, 'INBOX', ?2, 'b')", (&account, uid))?;
                for section in ["2", "3", "4"] {
                    c.execute(
                        "INSERT INTO attachments (account_id, folder, uid, section, filename, mime) VALUES (?1, 'INBOX', ?2, ?3, 'f', 'x/y')",
                        (&account, uid, section),
                    )?;
                }
            }
            Ok(())
        })
        .unwrap();
        server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&(1..=250).collect::<Vec<_>>(), false));

        e.shared().max_txn_rows(true);
        sync_ok(&e, &account, Some("INBOX"));
        let max = e.shared().max_txn_rows(false);
        assert!(max > 0 && max <= 200, "a removal transaction changed {max} rows");
        for t in ["messages", "bodies", "attachments"] {
            assert_eq!(count(&e, t), 0, "{t}");
        }
    }

    #[test]
    fn coalescing() {
        let a = |f: Option<&str>| Job { account: "a".into(), folder: f.map(String::from) };
        assert!(a(None).covers(&a(Some("INBOX"))));
        assert!(a(None).covers(&a(Some("inbox"))));
        assert!(!a(None).covers(&a(Some("Sent"))));
        assert!(!a(Some("INBOX")).covers(&a(None)));
        assert!(a(Some("Sent")).covers(&a(Some("Sent"))));
        assert!(!a(None).covers(&Job { account: "b".into(), folder: None }));
    }
}
