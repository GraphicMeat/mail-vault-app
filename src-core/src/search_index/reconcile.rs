//! Reconcile vault .eml files into the index. Spec §6.3.
//!
//! Lock discipline: files are listed and parsed WITHOUT the `SharedConn`
//! guard. The guard is held only to read one mailbox's rows, to apply its
//! removals and renames, and to commit each batch. `keep_going` and
//! `progress` are always called with no guard held: the app's callbacks lock
//! the same mutex.

use super::db::{meta_get, meta_set};
use super::text::{cap_chars, cjk_units};
use super::{lock, SharedConn};
use crate::maildir::vault_filename_uid;
use crate::search_index::query::MSG_KEY_SQL;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub const BATCH: usize = 500;
pub const MAX_BODY_CHARS: usize = 1_000_000;

#[derive(Debug, Clone, Default)]
pub struct IndexDoc {
    pub message_id: Option<String>,
    pub date_utc: Option<i64>,
    pub from_addr: String,
    pub from_name: String,
    /// Every address line (from, to, cc, bcc, reply-to) as "Name <addr>".
    pub addrs: Vec<String>,
    /// The recipients alone (To, Cc, Bcc). `addrs` carries the sender too, so
    /// "addressed to me" cannot be answered from it without also matching the
    /// mail this account sent.
    pub to_addrs: Vec<String>,
    pub subject: String,
    /// Plain text; the adapter picks text/plain or runs html_to_text.
    pub body_text: String,
    pub has_attachments: bool,
    /// The list row JSON with text/html cleared and no flags (flags come from the filename).
    pub row_json: String,
    /// Attachment-shaped MIME parts, metadata only — no bytes. One `pending`
    /// row is written per candidate; extraction (Task 5) fills in the rest.
    pub attachment_candidates: Vec<AttachmentMeta>,
}

#[derive(Debug, Clone)]
pub struct AttachmentMeta {
    pub filename: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexConfig {
    pub bodies: bool,
    pub attachments: bool,
    pub image_text: bool,
}

/// (raw bytes, uid, filename) -> parsed doc, or None when the file is not mail.
pub type ParseFn<'a> = &'a (dyn Fn(&[u8], u32, &str) -> Option<IndexDoc> + Sync);

/// What the server listing (the header cache, as last synced) says about the
/// uids of one folder whose files are gone: uid -> the Message-ID it lists
/// (`None` when it has none), for each uid it still lists. A uid absent from
/// the map is not on the server. `Err` = unknown this pass: nothing is removed.
/// Called with no index guard held, at most once per folder per pass, and only
/// when a file is missing.
pub type ServerListing<'a> = &'a dyn Fn(&[u32]) -> Result<HashMap<u32, Option<String>>, String>;

/// A server listing that holds nothing: every missing file's row is removed,
/// which is all reconcile did before eviction existed.
pub fn nothing_listed(_: &[u32]) -> Result<HashMap<u32, Option<String>>, String> {
    Ok(HashMap::new())
}

/// The attachment state of a kept row's parts that were still waiting for
/// extraction: there is no file to read them from. Out of the `pending` queue,
/// so they never hold back the parts of messages that are on disk; a restored
/// file is re-parsed, which writes them `pending` again.
pub const ATTACHMENT_EVICTED: &str = "evicted";

/// `parsed` and `failed` are disjoint: `failed` counts files that were
/// unparseable or a directory-shaped path (both recorded), or gone since the
/// listing or unreadable for any other reason (left for the next sweep).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileStats {
    pub parsed: usize,
    pub renamed: usize,
    pub removed: usize,
    /// The identities (`app_db::identity::msg_key`) of the rows removed in this
    /// pass. A message whose last copy is gone has tags and custom field values
    /// still sitting in `app.db`; the caller is what prunes them, because only
    /// it may open that store, and only after checking no other folder still
    /// holds the same message.
    pub removed_keys: Vec<String>,
    /// Rows whose file is gone but whose message the server still lists
    /// (evicted from the working cache): kept searchable, never in `removed_keys`.
    pub kept: usize,
    pub unchanged: usize,
    pub failed: usize,
    pub interrupted: bool,
}

pub const BODY_PENDING: i64 = 0;
pub const BODY_INDEXED: i64 = 1;
pub const BODY_DISABLED: i64 = 2;
pub const BODY_UNPARSEABLE: i64 = 3;

/// How much of the body the list's preview line keeps (`messages.snippet`):
/// three lines of a wide list, not more.
pub const SNIPPET_CHARS: usize = 200;

/// The preview line of a body: its first `SNIPPET_CHARS` characters with every
/// run of whitespace (line breaks, indentation, blank lines) folded to one
/// space. Reads only the head of the body, however long it is.
pub fn snippet_of(body: &str) -> String {
    let head: String = body.chars().take(SNIPPET_CHARS * 4).collect();
    head.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(SNIPPET_CHARS).collect()
}

fn closed() -> String {
    "search index closed".into()
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

pub(crate) struct DiskFile {
    pub(crate) uid: u32,
    pub(crate) filename: String,
    pub(crate) size: i64,
    pub(crate) mtime_ns: i64,
}

struct Row {
    id: i64,
    filename: String,
    size: i64,
    mtime_ns: i64,
    body_state: i64,
    /// The message has attachment-shaped MIME parts but no rows in
    /// `attachments` yet: either never reconciled since the attachments
    /// feature shipped, or reconciled while the setting was off.
    needs_attachment_backfill: bool,
    /// `snippet IS NULL`: no preview line computed for it yet.
    snippet_missing: bool,
    message_id: Option<String>,
}

/// What `apply_ops` does to one row.
enum Op<'a> {
    Remove,
    Rename(&'a str),
    /// The file is gone and the server still lists the message: keep the row
    /// and its FTS terms, force a re-read when a file comes back, and take its
    /// body and attachments out of the queues that need the file. Carries the
    /// row's name without the archived flag: the local archived copy is gone.
    Keep(String),
}

/// `mtime_ns` of a row whose file must be read again whatever its size and
/// mtime are then (`forget_file`). No file has it.
const REREAD: i64 = -1;

/// `mtime_ns` of a row kept with no file (`Op::Keep`, a header-only row): its
/// file, should one come back, is read like `REREAD`. Distinct from it, so a
/// file evicted after a `forget_file` is still marked evicted.
const EVICTED: i64 = -2;

/// `filename` without the archived flag letter, the rest untouched (the
/// extension after the flags is lowercase).
fn without_archived(filename: &str) -> String {
    match crate::maildir::info_flags(filename) {
        Some(rest) => format!("{}{}", &filename[..filename.len() - rest.len()], rest.replace('A', "")),
        None => filename.to_string(),
    }
}

/// The listing's uid is this message unless both sides carry a Message-ID and
/// they differ: uids restart after a UIDVALIDITY change, so the uid alone can
/// name another message.
fn same_message(ours: Option<&str>, listed: Option<&str>) -> bool {
    let norm = |id: Option<&str>| id.map(crate::maildir::normalize_message_id).filter(|id| !id.is_empty());
    match (norm(ours), norm(listed)) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

/// `(account_id, vault_dir)` for every `Maildir/<account>/<dir>` holding a
/// `cur` directory. Depth one only: the nested `maildir/…` custody dirs have
/// no `cur`. No `Maildir` yet is an empty vault; any other read error is `Err`,
/// never a shorter list: pruning against one would drop folders still on disk.
pub fn list_vault_dirs(maildir_root: &Path) -> Result<Vec<(String, String)>, String> {
    let accounts = match subdirs(maildir_root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        other => other.map_err(|e| format!("list {}: {e}", maildir_root.display()))?,
    };
    let mut out = Vec::new();
    for account in accounts {
        let account_path = maildir_root.join(&account);
        for dir in subdirs(&account_path).map_err(|e| format!("list {}: {e}", account_path.display()))? {
            if account_path.join(&dir).join("cur").is_dir() {
                out.push((account.clone(), dir));
            }
        }
    }
    Ok(out)
}

fn subdirs(path: &Path) -> std::io::Result<Vec<String>> {
    Ok(std::fs::read_dir(path)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect())
}

/// `<uid>:` files in `cur`, first entry per uid wins, plus the uids whose
/// `metadata()` failed. `None` when `cur` cannot be read at all, missing
/// included: the caller never mistakes that for "every message deleted" (a
/// folder that is gone is `prune_missing_dirs`'s job).
fn list_cur(cur: &Path) -> Option<(HashMap<u32, DiskFile>, HashSet<u32>)> {
    read_cur(cur).ok()
}

/// `list_cur` with the `read_dir` error kept, for the vault registry: there a
/// missing `cur` is a verified-empty folder, and only other errors are unknown.
pub(crate) fn read_cur(cur: &Path) -> std::io::Result<(HashMap<u32, DiskFile>, HashSet<u32>)> {
    let entries = std::fs::read_dir(cur)?;
    let mut files = HashMap::new();
    let mut unstatted = HashSet::new();
    // An error mid-iteration ends the listing (the Unix `ReadDir` stops after
    // one), so it is the whole listing's error, never a shorter folder:
    // `flatten()` here once turned a truncated listing into verified truth
    // that pruned every row after the break. Re-kinded to `Other`, because
    // the registry reads `NotFound` as "no cur, an empty folder", which is
    // only true of the `read_dir` open above. Not injectable in a test (no
    // way to fail `readdir` part-way on a real directory), hence this note.
    for entry in entries {
        let entry = entry.map_err(std::io::Error::other)?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        let Some(uid) = vault_filename_uid(&filename) else { continue };
        let Ok(meta) = entry.metadata() else {
            // Typically a flag rename between read_dir and stat: the message
            // is still there under another name, so its row must not be removed.
            unstatted.insert(uid);
            continue;
        };
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos() as i64);
        let size = i64::try_from(meta.len()).unwrap_or(i64::MAX);
        files.entry(uid).or_insert(DiskFile { uid, filename, size, mtime_ns });
    }
    Ok((files, unstatted))
}

/// The connection at a later lock point, only if it is still the database
/// this sweep read its rows from (`path` recorded at the first lock point).
/// A vault switch can close and reopen the index while a batch is parsed
/// without the lock; `None` or another database is "closed", never a write.
fn same_conn<'a>(slot: &'a mut Option<Connection>, path: &Option<String>) -> Result<&'a mut Connection, String> {
    match slot {
        Some(conn) if conn.path() == path.as_deref() => Ok(conn),
        _ => Err(closed()),
    }
}

/// `reconcile_mailbox_guarded` with no server listing: a missing file's row is removed.
pub fn reconcile_mailbox(
    db: &SharedConn,
    maildir_root: &Path,
    account_id: &str,
    vault_dir: &str,
    config: IndexConfig,
    parse: ParseFn,
    keep_going: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(usize),
) -> Result<ReconcileStats, String> {
    reconcile_mailbox_guarded(db, maildir_root, account_id, vault_dir, config, parse, &nothing_listed, keep_going, &|| true, progress)
}

/// Like `reconcile_mailbox`, with a second fence checked at each DB mutation
/// boundary, including again after acquiring the mutex. `commit_allowed` may
/// run while the DB guard is held and therefore must inspect no DB-locked state.
///
/// A row whose file is gone is removed only when `server` does not list its
/// uid (or lists another message under it); one the server still lists was
/// evicted from the working cache and stays searchable (`ServerListing`).
pub fn reconcile_mailbox_guarded(
    db: &SharedConn,
    maildir_root: &Path,
    account_id: &str,
    vault_dir: &str,
    config: IndexConfig,
    parse: ParseFn,
    server: ServerListing,
    keep_going: &dyn Fn() -> bool,
    commit_allowed: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(usize),
) -> Result<ReconcileStats, String> {
    let mut stats = ReconcileStats::default();
    let cur = crate::vault_files::account_dir(maildir_root, account_id).join(vault_dir).join("cur");
    // Missing or unreadable folder: touch nothing.
    let Some((files, unstatted)) = list_cur(&cur) else { return Ok(stats) };

    let (rows, db_path) = {
        let guard = lock(db);
        let conn = guard.as_ref().ok_or_else(closed)?;
        // The listing's size is the folder's share of `counts().total`, recorded
        // at the moment of the listing: a nudge after a delete keeps the total
        // honest without a full pass, and files not indexed yet are counted.
        conn.prepare_cached("INSERT OR REPLACE INTO mailbox_scan (account_id, vault_dir, scanned_at, file_count) VALUES (?1, ?2, unixepoch(), ?3)")
            .and_then(|mut st| st.execute(params![account_id, vault_dir, files.len() as i64]))
            .map_err(db_err)?;
        (load_rows(conn, account_id, vault_dir).map_err(db_err)?, conn.path().map(str::to_owned))
    };

    let mut to_parse: Vec<&DiskFile> = Vec::new();
    let mut renames: Vec<(i64, &str)> = Vec::new();
    for file in files.values() {
        match rows.get(&file.uid) {
            Some(row)
                if row.size == file.size
                    && row.mtime_ns == file.mtime_ns
                    && !(row.body_state == BODY_PENDING && config.bodies)
                    // Indexed before the preview line existed: read once more.
                    && !(row.body_state == BODY_INDEXED && row.snippet_missing && config.bodies)
                    && !(row.needs_attachment_backfill && config.attachments) =>
            {
                if row.filename == file.filename {
                    stats.unchanged += 1;
                } else {
                    renames.push((row.id, file.filename.as_str()));
                }
            }
            _ => to_parse.push(file),
        }
    }
    let gone: Vec<(&u32, &Row)> = rows.iter().filter(|(uid, _)| !files.contains_key(uid) && !unstatted.contains(uid)).collect();
    let mut ops: Vec<(i64, Op)> = Vec::new();
    if !gone.is_empty() {
        let uids: Vec<u32> = gone.iter().map(|(uid, _)| **uid).collect();
        // No guard is held: the daemon's listing locks another store. A
        // listing that could not be read removes nothing: the next pass decides.
        if let Ok(listed) = server(&uids) {
            for (uid, row) in gone {
                let kept = listed.get(uid).is_some_and(|id| same_message(row.message_id.as_deref(), id.as_deref()));
                if !kept {
                    ops.push((row.id, Op::Remove));
                    continue;
                }
                stats.kept += 1;
                // Marked once; again only when a bodies-on toggle made it pending.
                if row.mtime_ns != EVICTED || row.body_state == BODY_PENDING {
                    ops.push((row.id, Op::Keep(without_archived(&row.filename))));
                }
            }
        }
    }
    ops.extend(renames.iter().map(|&(id, name)| (id, Op::Rename(name))));

    // One transaction per chunk, so a folder emptied of 20k files never holds
    // the lock for all of them.
    for chunk in ops.chunks(BATCH) {
        if !keep_going() {
            stats.interrupted = true;
            return Ok(stats);
        }
        let mut guard = lock(db);
        if !commit_allowed() {
            stats.interrupted = true;
            return Ok(stats);
        }
        let conn = same_conn(&mut guard, &db_path)?;
        let mut gone = apply_ops(conn, chunk).map_err(db_err)?;
        stats.removed_keys.append(&mut gone);
        stats.removed += chunk.iter().filter(|(_, op)| matches!(op, Op::Remove)).count();
        stats.renamed += chunk.iter().filter(|(_, op)| matches!(op, Op::Rename(_))).count();
    }

    // Highest uids first: the newest mail becomes searchable soonest.
    to_parse.sort_unstable_by(|a, b| b.uid.cmp(&a.uid));
    for batch in to_parse.chunks(BATCH) {
        if !keep_going() {
            stats.interrupted = true;
            break;
        }
        let mut docs = Vec::with_capacity(batch.len());
        for &file in batch {
            let path = cur.join(&file.filename);
            let raw = match std::fs::read(&path) {
                Ok(raw) => raw,
                // Renamed (a flag change) or deleted since the listing: recording it
                // under the old name and stat would pin an empty body on a message
                // whose size and mtime never change again. The next sweep lists it.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    stats.failed += 1;
                    continue;
                }
                // Never readable at this path (a directory, or a path through a file):
                // recorded as unparseable, so it counts as indexed and is not re-read.
                // `IsADirectory`/`NotADirectory` is unix's EISDIR/ENOTDIR, reliably
                // mapped by std; Windows opening a directory with plain `File::open`
                // does not reliably land on either kind (observed: the read fails,
                // but not with a kind this match caught, so the entry fell through to
                // the catch-all below and was silently dropped forever instead of
                // being recorded as unparseable-and-not-retried). `path.is_dir()` is
                // the one check that is unambiguous on every platform regardless of
                // which OS error a failed read happened to surface.
                Err(e) if matches!(e.kind(), std::io::ErrorKind::IsADirectory | std::io::ErrorKind::NotADirectory) || path.is_dir() => {
                    stats.failed += 1;
                    docs.push((file, None));
                    continue;
                }
                // Anything else may pass (permissions fixed, a flaky drive, too many open
                // files): no row, so it is not counted as indexed and the next pass retries.
                Err(_) => {
                    stats.failed += 1;
                    continue;
                }
            };
            // An encrypted message is indexed from its decrypted copy, so it is searchable.
            let raw = crate::pgp::readable(&cur, file.uid, raw);
            let doc = parse(&raw, file.uid, &file.filename).map(|mut d| {
                // Cap before taking the lock: less memory per batch, shorter commits.
                d.body_text = if config.bodies { cap_chars(d.body_text, MAX_BODY_CHARS) } else { String::new() };
                d
            });
            if doc.is_some() { stats.parsed += 1 } else { stats.failed += 1 }
            docs.push((file, doc));
        }
        // Parsing can take long enough for a disable/rebuild/vault switch to
        // arrive. Do not commit the batch that was read before that request.
        if !keep_going() {
            stats.interrupted = true;
            break;
        }
        if !commit_allowed() {
            stats.interrupted = true;
            break;
        }
        {
            let mut guard = lock(db);
            if !commit_allowed() {
                stats.interrupted = true;
                break;
            }
            let conn = same_conn(&mut guard, &db_path)?;
            commit_batch(conn, account_id, vault_dir, config, docs).map_err(db_err)?;
        } // guard dropped before progress: the callback locks the same mutex
        progress(stats.parsed + stats.failed);
    }
    Ok(stats)
}

fn load_rows(conn: &Connection, account_id: &str, vault_dir: &str) -> rusqlite::Result<HashMap<u32, Row>> {
    let mut st = conn.prepare_cached(
        "SELECT m.id, m.uid, m.filename, m.size, m.mtime_ns, m.body_state,
                m.has_attachments AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_row = m.id),
                m.snippet IS NULL, m.message_id
         FROM messages m WHERE m.account_id = ?1 AND m.vault_dir = ?2",
    )?;
    let rows = st.query_map(params![account_id, vault_dir], |r| {
        Ok((
            r.get::<_, u32>(1)?,
            Row {
                id: r.get(0)?,
                filename: r.get(2)?,
                size: r.get(3)?,
                mtime_ns: r.get(4)?,
                body_state: r.get(5)?,
                needs_attachment_backfill: r.get(6)?,
                snippet_missing: r.get(7)?,
                message_id: r.get(8)?,
            },
        ))
    })?;
    rows.collect()
}

/// Returns the identities of the rows it removed.
fn apply_ops(conn: &mut Connection, ops: &[(i64, Op)]) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let mut removed_keys = Vec::new();
    for (id, op) in ops {
        let id = *id;
        match op {
            Op::Remove => {
                // Read the identity before the row carrying it is gone.
                let key: Option<String> = tx
                    .prepare_cached(&format!("SELECT {MSG_KEY_SQL} FROM messages m WHERE m.id = ?1"))?
                    .query_row([id], |r| r.get(0))
                    .optional()?;
                if let Some(key) = key {
                    removed_keys.push(key);
                }
                delete_fts(&tx, id)?;
                tx.prepare_cached("DELETE FROM messages WHERE id = ?1")?.execute([id])?;
            }
            Op::Rename(filename) => {
                // The flags ride the name, so a rename is how a star, a read
                // receipt or an archive reaches the index at all.
                tx.prepare_cached("UPDATE messages SET filename = ?1, flags = ?2 WHERE id = ?3")?
                    .execute(params![filename, flags_of(filename), id])?;
            }
            Op::Keep(filename) => {
                // A body still pending can never be read without the file:
                // recorded as unreadable, so the index can report complete.
                tx.prepare_cached(
                    "UPDATE messages SET mtime_ns = ?1, filename = ?2, flags = ?3,
                            body_state = CASE WHEN body_state = ?4 THEN ?5 ELSE body_state END WHERE id = ?6",
                )?
                .execute(params![EVICTED, filename, flags_of(filename), BODY_PENDING, BODY_UNPARSEABLE, id])?;
                tx.prepare_cached("UPDATE attachments SET state = ?1 WHERE message_row = ?2 AND state = 'pending'")?
                    .execute(params![ATTACHMENT_EVICTED, id])?;
            }
        }
    }
    tx.commit()?;
    Ok(removed_keys)
}

const UPSERT: &str = "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
    from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags, to_lc, snippet)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
  ON CONFLICT(account_id, vault_dir, uid) DO UPDATE SET filename=excluded.filename, size=excluded.size,
    mtime_ns=excluded.mtime_ns, message_id=excluded.message_id, date_utc=excluded.date_utc,
    from_addr_lc=excluded.from_addr_lc, from_name_lc=excluded.from_name_lc, subject_lc=excluded.subject_lc,
    addrs_lc=excluded.addrs_lc, has_attachments=excluded.has_attachments, body_state=excluded.body_state,
    row_json=excluded.row_json, flags=excluded.flags, to_lc=excluded.to_lc, snippet=excluded.snippet
  RETURNING id";

/// The Maildir flag letters a vault file name carries, as stored: the part
/// after `:2,` with the extension off. Kept here rather than derived from the
/// parsed message, because a flag change is a RENAME and the name is the truth
/// — an unparseable message still has flags.
pub fn flags_of(filename: &str) -> String {
    let Some(rest) = crate::maildir::info_flags(filename) else { return String::new() };
    rest.trim_end_matches(".eml").to_string()
}

/// One transaction per batch. `docs` bodies are already capped (or emptied
/// when bodies are off) by the caller.
fn commit_batch(
    conn: &mut Connection,
    account_id: &str,
    vault_dir: &str,
    config: IndexConfig,
    docs: Vec<(&DiskFile, Option<IndexDoc>)>,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare_cached(UPSERT)?;
        let mut clear_attachments = tx.prepare_cached("DELETE FROM attachments WHERE message_row = ?1")?;
        let mut insert_attachment = tx.prepare_cached(
            "INSERT INTO attachments (message_row, part_index, filename, mime, size, state) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
        )?;
        for (file, doc) in docs {
            let body_state = match (&doc, config.bodies) {
                (None, _) => BODY_UNPARSEABLE,
                (Some(_), true) => BODY_INDEXED,
                (Some(_), false) => BODY_DISABLED,
            };
            let candidates = doc.as_ref().map(|d| d.attachment_candidates.clone()).unwrap_or_default();
            // No body read (bodies off) = not computed; unparseable = nothing to show.
            let snippet = match body_state {
                BODY_INDEXED => doc.as_ref().map(|d| snippet_of(&d.body_text)),
                BODY_UNPARSEABLE => Some(String::new()),
                _ => None,
            };
            let d = doc.unwrap_or_else(|| IndexDoc { row_json: "{}".into(), ..IndexDoc::default() });
            let addrs = d.addrs.join("\n");
            let id: i64 = upsert.query_row(
                params![
                    account_id,
                    vault_dir,
                    file.uid,
                    file.filename,
                    file.size,
                    file.mtime_ns,
                    d.message_id,
                    d.date_utc.unwrap_or(file.mtime_ns / 1_000_000_000),
                    d.from_addr.to_lowercase(),
                    d.from_name.to_lowercase(),
                    d.subject.to_lowercase(),
                    addrs.to_lowercase(),
                    d.has_attachments,
                    body_state,
                    d.row_json,
                    flags_of(&file.filename),
                    d.to_addrs.join("\n").to_lowercase(),
                    snippet,
                ],
                |r| r.get(0),
            )?;
            delete_fts(&tx, id)?;
            if body_state != BODY_UNPARSEABLE {
                insert_fts(&tx, id, &d.subject, &addrs, &d.body_text, "")?;
            }
            clear_attachments.execute([id])?;
            if config.attachments {
                for (i, part) in candidates.iter().enumerate() {
                    insert_attachment.execute(params![id, i as i64, part.filename, part.mime, part.size as i64])?;
                }
            }
        }
    }
    tx.commit()
}

fn delete_fts(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM msg_fts WHERE rowid = ?1")?.execute([id])?;
    conn.prepare_cached("DELETE FROM msg_cjk WHERE rowid = ?1")?.execute([id])?;
    Ok(())
}

fn insert_fts(conn: &Connection, id: i64, subject: &str, addrs: &str, body: &str, attach: &str) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (?1, ?2, ?3, ?4, ?5)")?
        .execute(params![id, subject, addrs, body, attach])?;
    let (s, a, b, x) = (cjk_units(subject), cjk_units(addrs), cjk_units(body), cjk_units(attach));
    if !(s.is_empty() && a.is_empty() && b.is_empty() && x.is_empty()) {
        conn.prepare_cached("INSERT INTO msg_cjk(rowid, subject, addrs, body, attach) VALUES (?1, ?2, ?3, ?4, ?5)")?
            .execute(params![id, s, a, b, x])?;
    }
    Ok(())
}

pub const EXTRACT_BATCH: usize = 50;

/// One pass over up to `EXTRACT_BATCH` pending attachment parts: pulls
/// candidates via `read_part`, extracts text through `extractor`, writes the
/// result back to the `attachments` row and rewrites the message's FTS row so
/// the new attachment text becomes searchable immediately. `read_part` returns
/// `None` when the message's file is gone (left `pending`; a future full
/// reconcile will notice the file is gone and either remove the message row,
/// which cascades to its attachment rows via `ON DELETE CASCADE`, or, while
/// the server still lists it, keep the row and move these parts to
/// `ATTACHMENT_EVICTED`, out of this queue). A `Transient`
/// extraction error (surfaced by `extract` as state `"pending"`) also leaves
/// the row untouched for the next sweep to retry. Returns how many rows
/// changed state, so the caller can decide whether a progress signal is
/// worth emitting.
pub fn run_pending_extractions(
    db: &SharedConn,
    premium: bool,
    image_text_enabled: bool,
    bodies: bool,
    extractor: &dyn super::attachments::TextExtractor,
    read_part: impl Fn(&str, &str, u32, &str, usize) -> Option<(super::attachments::AttachmentInput, IndexDoc)>,
    keep_going: &dyn Fn() -> bool,
) -> Result<usize, String> {
    use super::attachments::extract;

    // Collect one bounded batch, then release the sole SQLite connection
    // before reading message files or invoking an extractor.
    let pending = {
        let guard = lock(db);
        let conn = guard.as_ref().ok_or_else(closed)?;
        let mut stmt = conn.prepare(
            "SELECT a.message_row, a.part_index, m.uid, m.account_id, m.vault_dir, m.filename \
             FROM attachments a JOIN messages m ON m.id = a.message_row \
             WHERE a.state = 'pending' LIMIT ?1",
        ).map_err(db_err)?;
        let rows = stmt.query_map(params![EXTRACT_BATCH as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)? as u32,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        }).map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
    };

    let mut changed = 0usize;
    for (message_row, part_index, uid, account_id, vault_dir, filename) in pending {
        // Checked per part, not just once per batch: a configure/rebuild/vault
        // switch must not wait out the rest of a 50-part batch, whose Vision
        // calls and subprocess timeouts can each take tens of seconds.
        if !keep_going() {
            break;
        }
        let Some((input, doc)) = read_part(&account_id, &vault_dir, uid, &filename, part_index as usize) else { continue };
        // Images only extract when the OCR toggle is on; every other
        // attachment-shaped part extracts once attachments are on at all
        // (the caller already gates that by not calling this function when
        // `config.attachments` is false).
        let enabled = if input.mime.to_lowercase().starts_with("image/") { image_text_enabled } else { true };
        let (state, text) = extract(&input, premium, enabled, extractor);
        if matches!(state, "pending" | "disabled" | "not_premium") {
            // Transient or setting-gated: leave it pending so a later toggle
            // (image text, premium) or retry picks it up, instead of burning
            // a terminal state on a condition that can still change.
            continue;
        }
        if !keep_going() {
            break;
        }
        let mut guard = lock(db);
        // The generation may have changed between the pre-lock check and
        // acquiring the connection. Daemon callbacks only inspect operation
        // state here, so this final fence is safe while holding the DB guard.
        if !keep_going() {
            break;
        }
        let conn = guard.as_mut().ok_or_else(closed)?;
        let current: Option<(u32, String, String, String)> = conn
            .query_row(
                "SELECT uid, account_id, vault_dir, filename FROM messages WHERE id = ?1",
                [message_row],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(db_err)?;
        if !matches!(current, Some((current_uid, current_account, current_dir, current_filename))
            if current_uid == uid && current_account == account_id && current_dir == vault_dir && current_filename == filename)
        {
            continue;
        }
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute(
            "UPDATE attachments SET state = ?1, text = ?2 WHERE message_row = ?3 AND part_index = ?4",
            params![state, text, message_row, part_index],
        ).map_err(db_err)?;
        let attach_text: String = tx
            .query_row(
                "SELECT group_concat(text, char(10)) FROM attachments WHERE message_row = ?1 AND state = 'ok'",
                [message_row],
                |r| r.get::<_, Option<String>>(0),
            )
            .map_err(db_err)?
            .unwrap_or_default();
        let addrs = doc.addrs.join("\n");
        // Same bodies-toggle normalization commit_batch applies: an
        // extraction sweep must not smuggle the raw, uncapped body back into
        // the FTS row when the user has bodies indexing turned off.
        let body_text = if bodies { cap_chars(doc.body_text.clone(), MAX_BODY_CHARS) } else { String::new() };
        delete_fts(&tx, message_row).map_err(db_err)?;
        if !doc.subject.is_empty() || !addrs.is_empty() || !body_text.is_empty() || !attach_text.is_empty() {
            insert_fts(&tx, message_row, &doc.subject, &addrs, &body_text, &attach_text).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        changed += 1;
    }
    Ok(changed)
}

/// Drop every folder whose `(account_id, vault_dir)` is not in `present`.
/// Returns the number of folders removed.
pub fn prune_missing_dirs(db: &SharedConn, present: &[(String, String)]) -> Result<usize, String> {
    prune_missing_dirs_guarded(db, present, &|| true)?.ok_or_else(|| "search index closed".to_string())
}

/// Same as `prune_missing_dirs`, but rolls its transaction back if `keep_going`
/// turns false before the commit. The callback runs while the DB guard is held
/// and must inspect only atomic/independent operation state.
pub fn prune_missing_dirs_guarded(
    db: &SharedConn,
    present: &[(String, String)],
    keep_going: &dyn Fn() -> bool,
) -> Result<Option<usize>, String> {
    let mut guard = lock(db);
    let conn = guard.as_mut().ok_or_else(closed)?;
    prune(conn, present, keep_going).map_err(db_err)
}

fn prune(conn: &mut Connection, present: &[(String, String)], keep_going: &dyn Fn() -> bool) -> rusqlite::Result<Option<usize>> {
    let tx = conn.transaction()?;
    // Scan rows too: a folder listed but never indexed still adds to `counts().total`.
    let indexed: Vec<(String, String)> = tx
        .prepare("SELECT account_id, vault_dir FROM messages UNION SELECT account_id, vault_dir FROM mailbox_scan")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // ponytail: O(folders²) membership test; fine for hundreds of folders, HashSet if vaults reach thousands.
    let missing: Vec<(String, String)> = indexed.into_iter().filter(|pair| !present.contains(pair)).collect();
    for (account_id, vault_dir) in &missing {
        if !keep_going() {
            return Ok(None); // dropping the transaction rolls back all deletes
        }
        let scope = params![account_id, vault_dir];
        tx.execute("DELETE FROM msg_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)", scope)?;
        tx.execute("DELETE FROM msg_cjk WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)", scope)?;
        tx.execute("DELETE FROM messages WHERE account_id = ?1 AND vault_dir = ?2", scope)?;
        tx.execute("DELETE FROM mailbox_scan WHERE account_id = ?1 AND vault_dir = ?2", scope)?;
    }
    if !keep_going() {
        return Ok(None);
    }
    tx.commit()?;
    Ok(Some(missing.len()))
}

/// Off: every indexed row's FTS entry is rewritten without its body (subject
/// and addresses from `messages`) and `vacuum_pending` is set, all in one
/// transaction; the file is compacted later by `compact_if_pending`. On:
/// disabled rows become pending and the next sweep re-parses them.
/// Make the next sweep of the folder re-read `uid`'s file although its size
/// and mtime did not change: its decrypted copy was just written beside it.
/// A closed index is a no-op; the next full sweep indexes the copy anyway.
pub fn forget_file(db: &SharedConn, account_id: &str, vault_dir: &str, uid: u32) -> Result<(), String> {
    let guard = lock(db);
    let Some(conn) = guard.as_ref() else { return Ok(()) };
    conn.execute(
        "UPDATE messages SET mtime_ns = ?4 WHERE account_id = ?1 AND vault_dir = ?2 AND uid = ?3",
        params![account_id, vault_dir, uid, REREAD],
    )
    .map(|_| ())
    .map_err(db_err)
}

/// A list-row address as `Name <address>`, or the bare address (the daemon's
/// adapter spells index addresses the same way).
fn addr_text(v: &serde_json::Value) -> String {
    let address = v.get("address").and_then(|x| x.as_str()).unwrap_or("");
    match v.get("name").and_then(|x| x.as_str()) {
        Some(name) if !name.is_empty() => format!("{name} <{address}>"),
        _ => address.to_string(),
    }
}

/// A header-only row for a message the header cache lists and no file holds.
fn listed_row(uid: u32, header: &serde_json::Value) -> (IndexDoc, String) {
    let text = |key: &str| header.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    // An address field is a list, or one address (Reply-To): either is read.
    let list = |key: &str| match header.get(key) {
        Some(serde_json::Value::Array(l)) => l.iter().map(addr_text).collect::<Vec<_>>(),
        Some(one @ serde_json::Value::Object(_)) => vec![addr_text(one)],
        _ => Vec::new(),
    };
    let from = header.get("from").cloned().unwrap_or(serde_json::Value::Null);
    let to_addrs: Vec<String> = ["to", "cc", "bcc"].into_iter().flat_map(|k| list(k)).filter(|a| !a.is_empty()).collect();
    let mut addrs = vec![addr_text(&from)];
    addrs.extend(to_addrs.iter().cloned());
    addrs.extend(list("replyTo"));
    // The Date header, then the arrival time, then now: never 1970.
    let parse = crate::maildir::header_date_secs;
    let date_utc = parse(&text("date")).or_else(|| parse(&text("internalDate"))).or_else(|| Some(chrono::Utc::now().timestamp()));
    // The server's flags, never archived: no local archived copy exists.
    let imap: Vec<String> = header
        .get("flags")
        .and_then(|v| v.as_array())
        .map(|l| l.iter().filter_map(|f| f.as_str()).filter(|f| !f.eq_ignore_ascii_case("archived")).map(str::to_owned).collect())
        .unwrap_or_default();
    let filename = crate::vault_files::build_maildir_filename(uid, &crate::vault_flags::merge_flags(&[], &imap));
    let mut row = header.clone();
    if let Some(obj) = row.as_object_mut() {
        for key in ["text", "html", "flags"] {
            obj.remove(key);
        }
    }
    let doc = IndexDoc {
        message_id: header.get("messageId").or_else(|| header.get("message_id")).and_then(|v| v.as_str()).map(str::to_owned),
        date_utc,
        from_addr: from.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        from_name: from.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        addrs: addrs.into_iter().filter(|a| !a.is_empty()).collect(),
        to_addrs,
        subject: text("subject"),
        has_attachments: header.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false),
        row_json: row.to_string(),
        ..IndexDoc::default()
    };
    (doc, filename)
}

/// After a fresh index is built from `cur/` (a rebuild, corruption recovery,
/// a first build): a header-only row for each message `listed` (the header
/// cache's rows for this folder) names that no file holds, so mail evicted
/// from the working cache stays findable by subject, sender and recipients.
/// No body terms, no preview line, never archived; kept (`EVICTED`) while the
/// server lists it, like any evicted row, and re-read into the same row if a
/// file comes back. A uid already in the index or on disk is left alone.
/// Returns how many rows it added. `keep_going` is checked before each batch
/// and again under the lock, like reconcile's `commit_allowed`. A closed (or
/// swapped) index, or a stop part way, is an error.
pub fn add_listed_rows(
    db: &SharedConn,
    maildir_root: &Path,
    account_id: &str,
    vault_dir: &str,
    listed: &[serde_json::Value],
    keep_going: &dyn Fn() -> bool,
) -> Result<usize, String> {
    let cur = crate::vault_files::account_dir(maildir_root, account_id).join(vault_dir).join("cur");
    // Unreadable or missing: nothing to compare against, and reconcile leaves
    // such a folder alone too. Not an error, so it never pins the fresh-index
    // mark (and a whole-cache re-read on every pass) for good.
    let Some((files, unstatted)) = list_cur(&cur) else { return Ok(0) };
    let rows: Vec<(u32, IndexDoc, String)> = listed
        .iter()
        .filter_map(|h| {
            let uid = h.get("uid").and_then(|v| v.as_u64()).and_then(|u| u32::try_from(u).ok())?;
            (!files.contains_key(&uid) && !unstatted.contains(&uid)).then(|| {
                let (doc, filename) = listed_row(uid, h);
                (uid, doc, filename)
            })
        })
        .collect();
    if rows.is_empty() {
        return Ok(0);
    }
    // One message, one row: the folder may already hold it under another uid
    // (an archived copy kept its old uid across a UIDVALIDITY change), and two
    // mailboxes behind one folder can list it twice. No id: cannot tell, kept.
    let (db_path, mut known) = {
        let guard = lock(db);
        let conn = guard.as_ref().ok_or_else(closed)?;
        let mut stmt = conn
            .prepare_cached("SELECT message_id FROM messages WHERE account_id = ?1 AND vault_dir = ?2 AND message_id IS NOT NULL")
            .map_err(db_err)?;
        let known: HashSet<String> = stmt
            .query_map(params![account_id, vault_dir], |r| r.get::<_, String>(0))
            .map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)?
            .iter()
            .map(|id| crate::maildir::normalize_message_id(id))
            .collect();
        (conn.path().map(str::to_owned), known)
    };
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|(_, d, _)| match d.message_id.as_deref().map(crate::maildir::normalize_message_id).filter(|id| !id.is_empty()) {
            Some(id) => known.insert(id),
            None => true,
        })
        .collect();
    let mut added = 0;
    // Stopped part way is an error, never a filled folder: the caller records
    // a folder as filled on `Ok` only.
    let stopped = || "header-only rows interrupted".to_string();
    for batch in rows.chunks(BATCH) {
        if !keep_going() {
            return Err(stopped());
        }
        let mut guard = lock(db);
        if !keep_going() {
            return Err(stopped());
        }
        let conn = same_conn(&mut guard, &db_path)?;
        let tx = conn.transaction().map_err(db_err)?;
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
                        from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags, to_lc, snippet)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL)
                     ON CONFLICT(account_id, vault_dir, uid) DO NOTHING RETURNING id",
                )
                .map_err(db_err)?;
            for (uid, d, filename) in batch {
                let addrs = d.addrs.join("\n");
                let id: Option<i64> = insert
                    .query_row(
                        params![
                            account_id,
                            vault_dir,
                            uid,
                            filename,
                            EVICTED,
                            d.message_id,
                            d.date_utc,
                            d.from_addr.to_lowercase(),
                            d.from_name.to_lowercase(),
                            d.subject.to_lowercase(),
                            addrs.to_lowercase(),
                            d.has_attachments,
                            BODY_UNPARSEABLE,
                            d.row_json,
                            flags_of(filename),
                            d.to_addrs.join("\n").to_lowercase(),
                        ],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db_err)?;
                if let Some(id) = id {
                    insert_fts(&tx, id, &d.subject, &addrs, "", "").map_err(db_err)?;
                    added += 1;
                }
            }
        }
        tx.commit().map_err(db_err)?;
    }
    Ok(added)
}

pub fn set_bodies_enabled(db: &SharedConn, enabled: bool) -> Result<(), String> {
    let mut guard = lock(db);
    let conn = guard.as_mut().ok_or_else(closed)?;
    let tx = conn.transaction().map_err(db_err)?;
    // Flags in the same transaction as the rows: the worker compares bodies_enabled to decide whether to toggle.
    if enabled {
        tx.execute("UPDATE messages SET body_state = ?1 WHERE body_state = ?2", [BODY_PENDING, BODY_DISABLED])
            .map_err(db_err)?;
        meta_set(&tx, "bodies_enabled", "1")?;
    } else {
        strip_bodies(&tx).map_err(db_err)?;
        meta_set(&tx, "bodies_enabled", "0")?;
        meta_set(&tx, "vacuum_pending", "1")?;
    }
    tx.commit().map_err(db_err)
}

/// When bodies were turned off: purge the deleted body tokens from the FTS
/// segments, rewrite the file and truncate the WAL so no body page stays on
/// disk. Holds the lock throughout, so the worker calls it only when idle.
/// `Ok(false)` when nothing was pending.
pub fn compact_if_pending(db: &SharedConn) -> Result<bool, String> {
    let guard = lock(db);
    let conn = guard.as_ref().ok_or_else(closed)?;
    if meta_get(conn, "vacuum_pending").as_deref() != Some("1") {
        return Ok(false);
    }
    conn.execute_batch("INSERT INTO msg_fts(msg_fts) VALUES('optimize'); INSERT INTO msg_cjk(msg_cjk) VALUES('optimize'); VACUUM;")
        .map_err(db_err)?;
    // Cleared before the checkpoint so this write is truncated away with the rest.
    // ponytail: a failed checkpoint after this leaves the flag clear; the exclusive connection has no reader to make it busy.
    meta_set(conn, "vacuum_pending", "0")?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(db_err)?;
    Ok(true)
}

fn strip_bodies(conn: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(i64, String, String)> = conn
        .prepare("SELECT id, subject_lc, addrs_lc FROM messages WHERE body_state = ?1")?
        .query_map([BODY_INDEXED], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, subject, addrs) in rows {
        delete_fts(conn, id)?;
        insert_fts(conn, id, &subject, &addrs, "", "")?;
    }
    conn.execute(
        "UPDATE messages SET body_state = ?1, snippet = NULL WHERE body_state IN (?2, ?3)",
        [BODY_DISABLED, BODY_PENDING, BODY_INDEXED],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;
    use crate::search_index::db;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn fake_parse(raw: &[u8], _uid: u32, _name: &str) -> Option<IndexDoc> {
        let parsed = mailparse::parse_mail(raw).ok()?;
        let h = |k: &str| parsed.headers.iter().find(|x| x.get_key().eq_ignore_ascii_case(k)).map(|x| x.get_value());
        let subject = h("Subject")?;
        let from = h("From").unwrap_or_default();
        Some(IndexDoc {
            message_id: h("Message-ID"),
            date_utc: h("Date").and_then(|d| mailparse::dateparse(&d).ok()),
            from_addr: from.clone(),
            from_name: String::new(),
            addrs: vec![from, h("To").unwrap_or_default()],
            to_addrs: h("To").into_iter().collect(),
            subject,
            body_text: parsed.get_body().unwrap_or_default(),
            has_attachments: false,
            row_json: "{}".into(),
            attachment_candidates: Vec::new(),
        })
    }

    fn eml(subject: &str, body: &str) -> String {
        format!("From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: {subject}\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\n{body}\r\n")
    }

    struct Vault { _tmp: tempfile::TempDir, root: std::path::PathBuf, db: SharedConn }

    fn vault() -> Vault {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let conn = db::open(&root).unwrap();
        Vault { _tmp: tmp, root, db: Mutex::new(Some(conn)) }
    }

    fn put(v: &Vault, account: &str, dir: &str, name: &str, content: &str) {
        let cur = v.root.join("Maildir").join(account).join(dir).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(name), content).unwrap();
    }

    fn run(v: &Vault, account: &str, dir: &str, cfg: IndexConfig, counter: &AtomicUsize) -> ReconcileStats {
        let parse = |raw: &[u8], uid: u32, name: &str| { counter.fetch_add(1, Ordering::SeqCst); fake_parse(raw, uid, name) };
        reconcile_mailbox(&v.db, &v.root.join("Maildir"), account, dir, cfg, &parse, &|| true, &mut |_| {}).unwrap()
    }

    fn fts_hits(v: &Vault, q: &str) -> Vec<i64> {
        let g = crate::search_index::lock(&v.db);
        let conn = g.as_ref().unwrap();
        let mut st = conn.prepare("SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?1 ORDER BY rowid").unwrap();
        st.query_map([q], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    /// `eml` with a UTF-8 charset, so a CJK body survives mailparse's us-ascii default.
    fn eml_utf8(subject: &str, body: &str) -> String {
        eml(subject, body).replacen("\r\n\r\n", "\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n", 1)
    }

    fn cjk_hits(v: &Vault, q: &str) -> i64 {
        let g = crate::search_index::lock(&v.db);
        g.as_ref().unwrap().query_row("SELECT count(*) FROM msg_cjk WHERE msg_cjk MATCH ?1", [q], |r| r.get(0)).unwrap()
    }

    fn row_count(db: &SharedConn) -> i64 {
        crate::search_index::lock(db).as_ref().unwrap().query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap()
    }

    fn put_many(v: &Vault, n: u32) {
        for uid in 1..=n {
            put(v, "a1", "INBOX", &format!("{uid}{INFO_PREFIX}.eml"), &eml(&format!("m{uid}"), "x"));
        }
    }

    const ON: IndexConfig = IndexConfig { bodies: true, attachments: false, image_text: false };
    const OFF: IndexConfig = IndexConfig { bodies: false, attachments: false, image_text: false };

    #[test]
    fn an_encrypted_message_is_indexed_from_its_decrypted_copy_once_forgotten() {
        let v = vault();
        let raw = eml("Sealed", "-----BEGIN PGP MESSAGE-----\r\nhQEMA\r\n-----END PGP MESSAGE-----");
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}S.eml"), &raw);
        let n = AtomicUsize::new(0);
        assert_eq!(run(&v, "a1", "INBOX", ON, &n).parsed, 1);
        assert!(fts_hits(&v, "\"zebra\"").is_empty());
        let cur = v.root.join("Maildir/a1/INBOX/cur");
        let copy = format!("X-MailVault-Source: {}\r\n{}", crate::pgp::source_tag(raw.as_bytes()), eml("Sealed", "zebra crossing"));
        crate::pgp::write_copy(&cur, 1, copy.as_bytes()).unwrap();
        assert_eq!(run(&v, "a1", "INBOX", ON, &n).parsed, 0, "size and mtime alone never notice the copy");
        forget_file(&v.db, "a1", "INBOX", 1).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s.parsed, s.removed), (1, 0));
        assert_eq!(fts_hits(&v, "\"zebra\"").len(), 1);
        assert_eq!(run(&v, "a1", "INBOX", ON, &n).parsed, 0, "indexed once, then unchanged again");
    }

    #[test]
    fn indexes_new_files_and_skips_unchanged_ones() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}S.eml"), &eml("Quarterly invoice", "the attached statement"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Lunch", "see you at noon"));
        put(&v, "a1", "INBOX", "legacy.eml", &eml("ignored", "not a vault row"));
        let n = AtomicUsize::new(0);
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s.parsed, s.failed), (2, 0));
        assert_eq!(fts_hits(&v, "\"statement\"").len(), 1);
        assert_eq!(fts_hits(&v, "\"invoice\"").len(), 1);
        let again = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((again.parsed, again.unchanged), (0, 2));
        assert_eq!(n.load(Ordering::SeqCst), 2, "unchanged files are never re-parsed");
    }

    #[test]
    fn flag_rename_updates_filename_without_parsing() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Hello", "body"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        let cur = v.root.join("Maildir/a1/INBOX/cur");
        std::fs::rename(cur.join(format!("1{INFO_PREFIX}.eml")), cur.join(format!("1{INFO_PREFIX}S.eml"))).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s.renamed, s.parsed), (1, 0));
        assert_eq!(n.load(Ordering::SeqCst), 1);
        let g = crate::search_index::lock(&v.db);
        let (name, flags): (String, String) = g
            .as_ref()
            .unwrap()
            .query_row("SELECT filename, flags FROM messages WHERE uid = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(name, format!("1{INFO_PREFIX}S.eml"));
        // A star or a read receipt IS a rename, and a saved view filtering on
        // Starred reads this column. Leaving it at the parse-time value would
        // make every flag change invisible until the file was rewritten.
        assert_eq!(flags, "S");
    }

    fn snippets(v: &Vault, uids: &[u32]) -> HashMap<u32, String> {
        let g = crate::search_index::lock(&v.db);
        db::snippets(g.as_ref().unwrap(), "a1", "INBOX", uids).unwrap()
    }

    /// The list's preview line comes from the sweep that already reads every
    /// body, so mail that was in the vault long before is covered, not only
    /// new arrivals.
    #[test]
    fn indexing_stores_a_folded_preview_line_per_message() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}S.eml"), &eml("Old", "Hi Ann,\r\n\r\n   the  invoice\r\nis attached."));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Empty", ""));
        run(&v, "a1", "INBOX", ON, &AtomicUsize::new(0));
        let got = snippets(&v, &[1, 2, 3]);
        assert_eq!(got.get(&1).map(String::as_str), Some("Hi Ann, the invoice is attached."));
        assert!(!got.contains_key(&2), "no text, no preview line");
        assert!(!got.contains_key(&3));
    }

    #[test]
    fn a_long_body_keeps_only_the_head_of_its_preview_line() {
        assert_eq!(snippet_of(&"word ".repeat(500)).chars().count(), SNIPPET_CHARS);
    }

    /// A star or a read receipt renames the file; the row keeps its preview.
    #[test]
    fn a_flag_rename_keeps_the_preview_line() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Hello", "keep me"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        let cur = v.root.join("Maildir/a1/INBOX/cur");
        std::fs::rename(cur.join(format!("1{INFO_PREFIX}.eml")), cur.join(format!("1{INFO_PREFIX}FS.eml"))).unwrap();
        run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(n.load(Ordering::SeqCst), 1, "a rename is not a re-read");
        assert_eq!(snippets(&v, &[1]).get(&1).map(String::as_str), Some("keep me"));
    }

    /// An index built before the column existed gains the preview line on its
    /// next sweep, without its rows ever reading as unindexed (which would
    /// report search unavailable while it catches up).
    #[test]
    fn a_row_indexed_before_the_preview_line_gains_it_on_the_next_sweep() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Hello", "from before"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        crate::search_index::lock(&v.db).as_ref().unwrap().execute("UPDATE messages SET snippet = NULL", []).unwrap();
        assert!(snippets(&v, &[1]).is_empty());

        run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(snippets(&v, &[1]).get(&1).map(String::as_str), Some("from before"));
        run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(n.load(Ordering::SeqCst), 2, "read once more, then never again");
        let state: i64 = crate::search_index::lock(&v.db)
            .as_ref()
            .unwrap()
            .query_row("SELECT body_state FROM messages WHERE uid = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, BODY_INDEXED);
    }

    #[test]
    fn a_removed_message_reports_the_identity_its_metadata_is_keyed_by() {
        let v = vault();
        let identified = "From: A <a@x.test>\r\nSubject: Gone soon\r\nMessage-ID: <gone@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbody\r\n";
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), identified);
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Stays", "body"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        std::fs::remove_file(v.root.join(format!("Maildir/a1/INBOX/cur/1{INFO_PREFIX}.eml"))).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s.removed, 1);
        assert_eq!(s.removed_keys.len(), 1);
        assert_eq!(s.removed_keys, vec!["gone@x.test".to_string()], "the Message-ID, not a uid");
    }

    #[test]
    fn a_message_with_no_message_id_still_reports_a_key_when_it_goes() {
        let v = vault();
        let raw = "From: A <a@x.test>\r\nSubject: No identity\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbody\r\n";
        put(&v, "a1", "INBOX", &format!("5{INFO_PREFIX}.eml"), raw);
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        std::fs::remove_file(v.root.join(format!("Maildir/a1/INBOX/cur/5{INFO_PREFIX}.eml"))).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s.removed_keys, vec!["u:INBOX:5".to_string()]);
    }

    #[test]
    fn an_indexed_message_carries_the_flags_its_file_name_spells() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}FS.eml"), &eml("Starred", "body"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Plain", "body"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        let g = crate::search_index::lock(&v.db);
        let flags = |uid: u32| -> String {
            g.as_ref().unwrap().query_row("SELECT flags FROM messages WHERE uid = ?1", [uid], |r| r.get(0)).unwrap()
        };
        assert_eq!(flags(1), "FS");
        assert_eq!(flags(2), "");
    }

    #[test]
    fn rewritten_file_is_reparsed_and_deleted_file_is_removed() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Old subject 古い", "old words"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Goner 消える", "vanishing"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((cjk_hits(&v, "\"古 い\""), cjk_hits(&v, "\"消 え る\"")), (1, 1));
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("New subject 新しい", "brand new longer words here"));
        std::fs::remove_file(v.root.join(format!("Maildir/a1/INBOX/cur/2{INFO_PREFIX}.eml"))).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s.parsed, s.removed), (1, 1));
        assert!(fts_hits(&v, "\"old words\"").is_empty());
        assert_eq!(fts_hits(&v, "\"brand new\"").len(), 1);
        assert!(fts_hits(&v, "\"vanishing\"").is_empty());
        assert_eq!(
            (cjk_hits(&v, "\"古 い\""), cjk_hits(&v, "\"消 え る\""), cjk_hits(&v, "\"新 し い\"")),
            (0, 0, 1),
            "msg_cjk drops the rewritten and the removed text too"
        );
    }

    #[test]
    fn unparseable_file_is_recorded_once_and_not_retried() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), "no headers at all, no subject");
        let n = AtomicUsize::new(0);
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s.failed, 1);
        let s2 = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s2.failed, s2.unchanged), (0, 1));
        assert_eq!(n.load(Ordering::SeqCst), 1);
    }

    fn counts(v: &Vault) -> db::IndexCounts {
        db::counts(crate::search_index::lock(&v.db).as_ref().unwrap())
    }

    #[test]
    fn unreadable_file_is_recorded_and_not_reread_but_a_vanished_one_is_left() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Alpha", "one"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Beta", "two"));
        let cur = v.root.join("Maildir/a1/INBOX/cur");
        std::fs::create_dir(cur.join(format!("9{INFO_PREFIX}.eml"))).unwrap(); // listed, never readable
        // Highest uid first: uid 2's parse deletes uid 1 after the listing saw it.
        let parse = |raw: &[u8], uid: u32, name: &str| {
            if uid == 2 {
                let _ = std::fs::remove_file(cur.join(format!("1{INFO_PREFIX}.eml")));
            }
            fake_parse(raw, uid, name)
        };
        let s = reconcile_mailbox(&v.db, &v.root.join("Maildir"), "a1", "INBOX", ON, &parse, &|| true, &mut |_| {}).unwrap();
        assert_eq!((s.parsed, s.failed), (1, 2));
        let state = |uid: u32| -> Option<i64> {
            let g = crate::search_index::lock(&v.db);
            g.as_ref().unwrap().query_row("SELECT body_state FROM messages WHERE uid = ?1", [uid], |r| r.get(0)).ok()
        };
        assert_eq!(state(9), Some(BODY_UNPARSEABLE), "an unreadable file counts as indexed");
        assert_eq!(state(1), None, "a file gone since the listing is the next sweep's, not a row");
        let n = AtomicUsize::new(0);
        let again = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((again.failed, again.unchanged), (0, 2), "the unreadable file is not read again");
        assert_eq!(counts(&v), db::IndexCounts { indexed: 2, total: 2 });
    }

    #[test]
    #[cfg(unix)]
    fn a_transient_read_error_is_retried_not_pinned() {
        use std::os::unix::fs::PermissionsExt;
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Alpha", "readable"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Beta", "padlocked"));
        let locked = v.root.join(format!("Maildir/a1/INBOX/cur/2{INFO_PREFIX}.eml"));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let n = AtomicUsize::new(0);
        let s = run(&v, "a1", "INBOX", ON, &n);
        let has_row = |uid: u32| {
            let g = crate::search_index::lock(&v.db);
            g.as_ref().unwrap().query_row("SELECT 1 FROM messages WHERE uid = ?1", [uid], |_| Ok(())).is_ok()
        };
        let first = ((s.parsed, s.failed), has_row(1), has_row(2), counts(&v));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            first,
            ((1, 1), true, false, db::IndexCounts { indexed: 1, total: 2 }),
            "a permission error leaves no row, so the message is not counted as indexed"
        );
        let again = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((again.parsed, again.unchanged), (1, 1), "the next pass reads it once it is readable");
        assert_eq!(fts_hits(&v, "\"padlocked\"").len(), 1);
        assert_eq!(counts(&v), db::IndexCounts { indexed: 2, total: 2 });
    }

    #[test]
    fn total_is_the_files_listed_per_folder_even_before_they_are_indexed() {
        let v = vault();
        for uid in 1..=3 { put(&v, "a1", "INBOX", &format!("{uid}{INFO_PREFIX}.eml"), &eml("In", "x")); }
        for uid in 1..=2 { put(&v, "a1", "Archive", &format!("{uid}{INFO_PREFIX}.eml"), &eml("Arc", "x")); }
        put(&v, "a1", "Gone", &format!("1{INFO_PREFIX}.eml"), &eml("Gone", "x"));
        for dir in ["INBOX", "Archive", "Gone"] {
            let s = reconcile_mailbox(&v.db, &v.root.join("Maildir"), "a1", dir, ON, &fake_parse, &|| false, &mut |_| {}).unwrap();
            assert!(s.interrupted);
        }
        assert_eq!(counts(&v), db::IndexCounts { indexed: 0, total: 6 }, "listed, not yet indexed");
        std::fs::remove_dir_all(v.root.join("Maildir/a1/Gone")).unwrap();
        prune_missing_dirs(&v.db, &list_vault_dirs(&v.root.join("Maildir")).unwrap()).unwrap();
        assert_eq!(counts(&v).total, 5, "prune drops a folder that was listed but never got a row");
        let n = AtomicUsize::new(0);
        for dir in ["INBOX", "Archive"] { run(&v, "a1", dir, ON, &n); }
        assert_eq!(counts(&v), db::IndexCounts { indexed: 5, total: 5 });
    }

    #[test]
    fn a_delete_reconciled_in_its_folder_alone_keeps_the_index_complete() {
        let v = vault();
        for dir in ["INBOX", "Archive"] {
            for uid in 1..=2 { put(&v, "a1", dir, &format!("{uid}{INFO_PREFIX}.eml"), &eml(dir, "x")); }
        }
        let n = AtomicUsize::new(0);
        for dir in ["INBOX", "Archive"] { run(&v, "a1", dir, ON, &n); }
        assert_eq!(counts(&v), db::IndexCounts { indexed: 4, total: 4 });
        std::fs::remove_file(v.root.join(format!("Maildir/a1/INBOX/cur/2{INFO_PREFIX}.eml"))).unwrap();
        run(&v, "a1", "INBOX", ON, &n); // a nudge: this folder only, no full pass
        assert_eq!(counts(&v), db::IndexCounts { indexed: 3, total: 3 });
    }

    #[test]
    fn bodies_off_indexes_headers_only_and_toggling_on_reparses() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Weekly report", "confidential numbers"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", OFF, &n);
        assert!(fts_hits(&v, "\"confidential\"").is_empty());
        assert_eq!(fts_hits(&v, "\"weekly\"").len(), 1);

        set_bodies_enabled(&v.db, true).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s.parsed, 1);
        assert_eq!(fts_hits(&v, "\"confidential\"").len(), 1);

        set_bodies_enabled(&v.db, false).unwrap();
        assert!(fts_hits(&v, "\"confidential\"").is_empty(), "turning bodies off removes body text immediately");
        assert_eq!(fts_hits(&v, "\"weekly\"").len(), 1, "headers stay searchable");
    }

    #[test]
    fn accounts_and_dirs_are_isolated_and_missing_dirs_pruned() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Alpha", "one"));
        put(&v, "a2", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Beta", "two"));
        put(&v, "a2", "Projects_2026", &format!("1{INFO_PREFIX}.eml"), &eml("Gamma", "three"));
        let n = AtomicUsize::new(0);
        for (a, d) in list_vault_dirs(&v.root.join("Maildir")).unwrap() { run(&v, &a, &d, ON, &n); }
        let mut dirs = list_vault_dirs(&v.root.join("Maildir")).unwrap();
        dirs.sort();
        assert_eq!(dirs, vec![("a1".into(), "INBOX".into()), ("a2".into(), "INBOX".into()), ("a2".into(), "Projects_2026".into())]);
        std::fs::remove_dir_all(v.root.join("Maildir/a2/Projects_2026")).unwrap();
        let removed = prune_missing_dirs(&v.db, &list_vault_dirs(&v.root.join("Maildir")).unwrap()).unwrap();
        assert_eq!(removed, 1);
        assert!(fts_hits(&v, "\"gamma\"").is_empty());
        assert_eq!(
            (fts_hits(&v, "\"alpha\"").len(), fts_hits(&v, "\"beta\"").len()),
            (1, 1),
            "prune keeps the folders still on disk"
        );
    }

    #[test]
    #[cfg(unix)]
    fn an_unreadable_account_dir_is_an_error_not_an_empty_account() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let maildir = tmp.path().join("Maildir");
        assert_eq!(list_vault_dirs(&maildir), Ok(vec![]), "no Maildir yet: nothing to list");
        std::fs::create_dir_all(maildir.join("a1/INBOX/cur")).unwrap();
        std::fs::create_dir_all(maildir.join("a2/INBOX/cur")).unwrap();
        let locked = maildir.join("a2");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let res = list_vault_dirs(&maildir);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(res.is_err(), "pruning on this listing would drop every a2 folder: {res:?}");
        let mut dirs = list_vault_dirs(&maildir).unwrap();
        dirs.sort();
        assert_eq!(dirs, vec![("a1".into(), "INBOX".into()), ("a2".into(), "INBOX".into())]);
    }

    #[test]
    fn keep_going_false_stops_between_batches_and_resumes() {
        let v = vault();
        for uid in 1..=(BATCH as u32 + 20) { put(&v, "a1", "INBOX", &format!("{uid}{INFO_PREFIX}.eml"), &eml(&format!("m{uid}"), "x")); }
        let keep_running = AtomicBool::new(true);
        let parse = |raw: &[u8], uid: u32, name: &str| fake_parse(raw, uid, name);
        let stop_after_first_committed_batch = || keep_running.load(Ordering::SeqCst);
        let mut stop_after_commit = |done: usize| {
            if done >= BATCH {
                keep_running.store(false, Ordering::SeqCst);
            }
        };
        let s = reconcile_mailbox(&v.db, &v.root.join("Maildir"), "a1", "INBOX", ON, &parse, &stop_after_first_committed_batch, &mut stop_after_commit).unwrap();
        assert!(s.interrupted);
        assert_eq!(s.parsed, BATCH);
        assert_eq!(row_count(&v.db), BATCH as i64, "the first batch is committed before progress requests cancellation");
        let n = AtomicUsize::new(0);
        let s2 = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s2.parsed, 20);
    }

    #[test]
    fn invalidated_generation_while_waiting_for_commit_lock_skips_the_batch() {
        use std::sync::mpsc;
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("new", "body"));
        let Vault { _tmp, root, db } = v;
        let shared = std::sync::Arc::new(db);
        let maildir = root.join("Maildir");
        let (parsed_tx, parsed_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let continue_rx = std::sync::Mutex::new(continue_rx);
        let parse = move |raw: &[u8], uid: u32, filename: &str| {
            parsed_tx.send(()).unwrap();
            continue_rx.lock().unwrap().recv().unwrap();
            fake_parse(raw, uid, filename)
        };
        let current_generation = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let commit_checks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let thread_db = shared.clone();
        let thread_root = maildir.clone();
        let thread_generation = current_generation.clone();
        let thread_checks = commit_checks.clone();
        let join = std::thread::spawn(move || {
            let commit_allowed = || {
                if thread_checks.fetch_add(1, Ordering::SeqCst) == 0 {
                    true // the batch passes its pre-lock check, then waits on the held DB mutex
                } else {
                    thread_generation.load(Ordering::SeqCst)
                }
            };
            reconcile_mailbox_guarded(
                &thread_db,
                &thread_root,
                "a1",
                "INBOX",
                ON,
                &parse,
                &nothing_listed,
                &|| true,
                &commit_allowed,
                &mut |_| {},
            )
        });

        parsed_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("parser did not reach the deterministic pause");
        let guard = lock(&shared);
        continue_tx.send(()).unwrap();
        while commit_checks.load(Ordering::SeqCst) == 0 {
            std::thread::yield_now();
        }
        current_generation.store(false, Ordering::SeqCst);
        drop(guard);

        let stats = join.join().unwrap().unwrap();
        assert!(stats.interrupted, "generation change while the batch waited for the mutex must cancel it");
        assert_eq!(row_count(&shared), 0, "a stale parsed batch must not write into the database");
    }

    #[test]
    fn removals_commit_in_chunks_and_an_interrupt_leaves_the_rest() {
        let emptied = || {
            let v = vault();
            put_many(&v, BATCH as u32 + 10);
            run(&v, "a1", "INBOX", ON, &AtomicUsize::new(0));
            for e in std::fs::read_dir(v.root.join("Maildir/a1/INBOX/cur")).unwrap() {
                std::fs::remove_file(e.unwrap().path()).unwrap();
            }
            v
        };
        let reconcile = |v: &Vault, keep_going: &dyn Fn() -> bool| {
            reconcile_mailbox(&v.db, &v.root.join("Maildir"), "a1", "INBOX", ON, &fake_parse, keep_going, &mut |_| {}).unwrap()
        };

        let v = emptied();
        let calls = AtomicUsize::new(0);
        let s = reconcile(&v, &|| { calls.fetch_add(1, Ordering::SeqCst); true });
        assert_eq!((s.removed, s.interrupted), (BATCH + 10, false));
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one keep_going check per chunk");
        assert_eq!(row_count(&v.db), 0);

        let v = emptied();
        let calls = AtomicUsize::new(0);
        let s = reconcile(&v, &|| calls.fetch_add(1, Ordering::SeqCst) == 0);
        assert!(s.interrupted);
        assert_eq!(s.removed, BATCH, "the first chunk is committed on its own");
        assert_eq!(row_count(&v.db), 10);
        let s = reconcile(&v, &|| true);
        assert_eq!((s.removed, s.interrupted), (10, false));
        assert_eq!(row_count(&v.db), 0);
    }

    #[test]
    fn cjk_table_gets_character_tokens() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("明日の会議について", "資料を添付します"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        let g = crate::search_index::lock(&v.db);
        let hit: i64 = g.as_ref().unwrap()
            .query_row("SELECT count(*) FROM msg_cjk WHERE msg_cjk MATCH '\"会 議\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(hit, 1);
    }

    #[test]
    fn sweep_stops_when_the_connection_is_swapped() {
        let a = vault();
        let b = vault();
        put_many(&a, BATCH as u32 + 5);
        // parse runs without the lock: a vault switch (close + reopen elsewhere) lands here.
        let parse = |raw: &[u8], uid: u32, name: &str| {
            let other = crate::search_index::lock(&b.db).take();
            if other.is_some() {
                *crate::search_index::lock(&a.db) = other;
            }
            fake_parse(raw, uid, name)
        };
        let res = reconcile_mailbox(&a.db, &a.root.join("Maildir"), "a1", "INBOX", ON, &parse, &|| true, &mut |_| {});
        assert!(res.as_ref().is_err_and(|e| e.contains("closed")), "{res:?}");
        assert_eq!(row_count(&a.db), 0, "vault B's index got none of vault A's rows");
    }

    #[test]
    fn missing_cur_removes_nothing() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml("Alpha", "one"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml("Beta", "two"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        std::fs::remove_dir_all(v.root.join("Maildir/a1/INBOX/cur")).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s, ReconcileStats::default());
        assert_eq!(row_count(&v.db), 2);
        assert_eq!((fts_hits(&v, "\"alpha\"").len(), fts_hits(&v, "\"beta\"").len()), (1, 1));
        assert_eq!(prune_missing_dirs(&v.db, &list_vault_dirs(&v.root.join("Maildir")).unwrap()).unwrap(), 1);
        assert_eq!(row_count(&v.db), 0);
        assert_eq!((fts_hits(&v, "\"alpha\"").len(), fts_hits(&v, "\"beta\"").len()), (0, 0));
    }

    #[test]
    fn callbacks_that_lock_the_same_mutex_do_not_deadlock() {
        let v = vault();
        put_many(&v, BATCH as u32 + 1);
        let Vault { _tmp, root, db } = v;
        let db = std::sync::Arc::new(db);
        let shared = db.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        // On a thread with a timeout, so a deadlock fails the test instead of hanging the run.
        std::thread::spawn(move || {
            let keep_going = || row_count(&shared) >= 0;
            let mut seen = Vec::new();
            let res = reconcile_mailbox(&shared, &root.join("Maildir"), "a1", "INBOX", ON, &fake_parse, &keep_going, &mut |n| {
                seen.push((n, row_count(&shared)))
            });
            let _ = tx.send((res, seen));
        });
        let (res, seen) = rx.recv_timeout(std::time::Duration::from_secs(60)).expect("deadlock: a callback locked the held mutex");
        assert_eq!(res.unwrap().parsed, BATCH + 1);
        assert_eq!(seen, vec![(BATCH, BATCH as i64), (BATCH + 1, BATCH as i64 + 1)], "each batch is committed before its progress call");
        assert_eq!(row_count(&db), BATCH as i64 + 1);
    }

    #[test]
    fn closing_mid_sweep_returns_closed() {
        let v = vault();
        put_many(&v, BATCH as u32 + 1);
        let calls = AtomicUsize::new(0);
        let keep_going = || {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                *crate::search_index::lock(&v.db) = None;
            }
            true
        };
        let res = reconcile_mailbox(&v.db, &v.root.join("Maildir"), "a1", "INBOX", ON, &fake_parse, &keep_going, &mut |_| {});
        assert!(res.as_ref().is_err_and(|e| e.contains("closed")), "{res:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn bodies_off_defers_compaction_until_asked() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_utf8("Weekly report", "confidential 機密 numbers"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((fts_hits(&v, "\"confidential\"").len(), cjk_hits(&v, "\"機 密\"")), (1, 1));

        set_bodies_enabled(&v.db, false).unwrap();
        assert_eq!((fts_hits(&v, "\"confidential\"").len(), cjk_hits(&v, "\"機 密\"")), (0, 0), "body words leave both tables");
        assert_eq!(fts_hits(&v, "\"weekly\"").len(), 1);
        let meta = |k: &str| db::meta_get(crate::search_index::lock(&v.db).as_ref().unwrap(), k);
        assert_eq!(meta("bodies_enabled").as_deref(), Some("0"));
        assert_eq!(meta("vacuum_pending").as_deref(), Some("1"));
        let wal_len = || std::fs::metadata(v.root.join("search_index/index.db-wal")).map_or(0, |m| m.len());
        assert!(wal_len() > 0, "precondition: the toggle's pages sit in the WAL");

        assert_eq!(compact_if_pending(&v.db), Ok(true));
        assert_eq!(meta("vacuum_pending").as_deref(), Some("0"));
        assert_eq!(wal_len(), 0, "the checkpoint truncates the WAL, so no body pages linger in it");
        assert_eq!(compact_if_pending(&v.db), Ok(false));
    }

    /// cargo test -p mailvault-core --release --lib bench_index_50k -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_index_50k() {
        use std::time::Instant;
        let v = vault();
        let words = ["invoice", "meeting", "budget", "shipment", "contract", "会議", "資料", "Réunion", "delivery", "quarterly"];
        let n = 50_000u32;
        for i in 1..=n {
            let dir = ["INBOX", "Archive", "Sent"][(i % 3) as usize];
            let w = words[(i as usize) % words.len()];
            let body: String = (0..300).map(|k| words[(k * 7 + i as usize) % words.len()]).collect::<Vec<_>>().join(" ");
            put(&v, "bench", dir, &format!("{i}{INFO_PREFIX}S.eml"), &eml_utf8(&format!("{w} update {i}"), &body));
        }
        let t = Instant::now();
        let parse = |raw: &[u8], uid: u32, name: &str| fake_parse(raw, uid, name);
        for (a, d) in list_vault_dirs(&v.root.join("Maildir")).unwrap() {
            reconcile_mailbox(&v.db, &v.root.join("Maildir"), &a, &d, ON, &parse, &|| true, &mut |_| {}).unwrap();
        }
        println!("index_build n={n} elapsed={:?} db_bytes={}", t.elapsed(), db::db_size_bytes(&v.root));
        let g = crate::search_index::lock(&v.db);
        let conn = g.as_ref().unwrap();
        for q in ["invoice", "update 4999", "budget meeting", "会議", "voic", "nothingmatcheszzz"] {
            let t = Instant::now();
            let page = crate::search_index::query::search(conn, &crate::search_index::query::SearchRequest { account_id: "bench".into(), query: q.into(), ..Default::default() }).unwrap();
            println!("query {q:?} total={} elapsed={:?}", page.total, t.elapsed());
        }
    }

    #[test]
    fn index_config_carries_attachment_flags() {
        let cfg = IndexConfig { bodies: true, attachments: true, image_text: false };
        assert!(cfg.attachments);
        assert!(!cfg.image_text);
    }

    #[test]
    fn commit_batch_writes_pending_attachment_rows_for_each_candidate() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc {
            subject: "Invoice".into(),
            has_attachments: true,
            attachment_candidates: vec![
                AttachmentMeta { filename: "invoice.pdf".into(), mime: "application/pdf".into(), size: 5000 },
                AttachmentMeta { filename: "photo.png".into(), mime: "image/png".into(), size: 200_000 },
            ],
            ..IndexDoc::default()
        };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let message_id: i64 = conn.query_row("SELECT id FROM messages", [], |r| r.get(0)).unwrap();
        let mut stmt = conn.prepare("SELECT part_index, filename, mime, size, state FROM attachments WHERE message_row = ?1 ORDER BY part_index").unwrap();
        let rows: Vec<(i64, String, String, i64, String)> = stmt
            .query_map([message_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], (0, "invoice.pdf".into(), "application/pdf".into(), 5000, "pending".into()));
        assert_eq!(rows[1], (1, "photo.png".into(), "image/png".into(), 200_000, "pending".into()));
    }

    #[test]
    fn commit_batch_writes_no_attachment_rows_when_attachments_are_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc {
            attachment_candidates: vec![AttachmentMeta { filename: "a.pdf".into(), mime: "application/pdf".into(), size: 1 }],
            ..IndexDoc::default()
        };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: false, image_text: false }, vec![(&file, Some(doc))]).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "no candidate rows are written while the attachments toggle is off");
    }

    #[test]
    fn reparsing_a_changed_message_replaces_its_attachment_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc1 = IndexDoc { attachment_candidates: vec![AttachmentMeta { filename: "old.pdf".into(), mime: "application/pdf".into(), size: 1 }], ..IndexDoc::default() };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc1))]).unwrap();
        let doc2 = IndexDoc { attachment_candidates: vec![AttachmentMeta { filename: "new.pdf".into(), mime: "application/pdf".into(), size: 2 }], ..IndexDoc::default() };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc2))]).unwrap();
        let names: Vec<String> = conn.prepare("SELECT filename FROM attachments").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(names, vec!["new.pdf".to_string()], "the old part's row must not linger once the message is reparsed with a different attachment set");
    }

    #[test]
    fn run_pending_extractions_fills_in_ok_text_and_rewrites_fts() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc {
            subject: "Invoice".into(),
            attachment_candidates: vec![AttachmentMeta { filename: "notes.txt".into(), mime: "text/plain".into(), size: 11 }],
            ..IndexDoc::default()
        };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let shared = Mutex::new(Some(conn));

        let changed = super::run_pending_extractions(&shared, true, true, true, &crate::search_index::attachments::NoOcrExtractor, |_acct, _dir, _uid, _filename, _part_index| {
            Some((
                crate::search_index::attachments::AttachmentInput { filename: "notes.txt".into(), mime: "text/plain".into(), size: 11, bytes: b"hello world".to_vec() },
                IndexDoc { subject: "Invoice".into(), ..IndexDoc::default() },
            ))
        }, &|| true);
        assert_eq!(changed.unwrap(), 1);

        let guard = crate::search_index::lock(&shared);
        let conn = guard.as_ref().unwrap();
        let (state, text): (String, Option<String>) = conn.query_row("SELECT state, text FROM attachments", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(state, "ok");
        assert_eq!(text.as_deref(), Some("hello world"));

        let hit: i64 = conn.query_row("SELECT rowid FROM msg_fts WHERE msg_fts MATCH '\"orld\"'", [], |r| r.get(0)).unwrap();
        assert!(hit > 0, "the FTS row must be rewritten with the attachment text in the attach column");
    }

    #[test]
    fn run_pending_extractions_with_bodies_off_drops_body_text_from_fts() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc {
            subject: "Invoice".into(),
            body_text: "a very secret body about quokkas".into(),
            attachment_candidates: vec![AttachmentMeta { filename: "notes.txt".into(), mime: "text/plain".into(), size: 11 }],
            ..IndexDoc::default()
        };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let shared = Mutex::new(Some(conn));

        // bodies: false — the extraction rewrite must not smuggle the raw
        // body text back into the FTS row even though the read_part callback
        // hands back a doc with body_text set.
        let changed = super::run_pending_extractions(&shared, true, true, false, &crate::search_index::attachments::NoOcrExtractor, |_acct, _dir, _uid, _filename, _part_index| {
            Some((
                crate::search_index::attachments::AttachmentInput { filename: "notes.txt".into(), mime: "text/plain".into(), size: 11, bytes: b"hello world".to_vec() },
                IndexDoc { subject: "Invoice".into(), body_text: "a very secret body about quokkas".into(), ..IndexDoc::default() },
            ))
        }, &|| true);
        assert_eq!(changed.unwrap(), 1);

        let guard = crate::search_index::lock(&shared);
        let conn = guard.as_ref().unwrap();
        let body_hits: i64 = conn.query_row("SELECT count(*) FROM msg_fts WHERE msg_fts MATCH '\"quokkas\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(body_hits, 0, "bodies:false must keep the raw body text out of the FTS row");

        let attach_hit: i64 = conn.query_row("SELECT rowid FROM msg_fts WHERE msg_fts MATCH '\"orld\"'", [], |r| r.get(0)).unwrap();
        assert!(attach_hit > 0, "the attachment text must still be searchable regardless of the bodies toggle");
    }

    #[test]
    fn a_transient_extraction_error_leaves_the_row_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc {
            attachment_candidates: vec![AttachmentMeta { filename: "a.pdf".into(), mime: "application/pdf".into(), size: 5000 }],
            ..IndexDoc::default()
        };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let shared = Mutex::new(Some(conn));

        struct AlwaysTransient;
        impl crate::search_index::attachments::TextExtractor for AlwaysTransient {
            fn pdf_text_layer(&self, _b: &[u8]) -> Result<(String, usize), crate::search_index::attachments::ExtractError> {
                Err(crate::search_index::attachments::ExtractError::Transient("timeout".into()))
            }
            fn pdf_ocr(&self, _b: &[u8], _m: usize) -> Result<String, crate::search_index::attachments::ExtractError> {
                Err(crate::search_index::attachments::ExtractError::Transient("timeout".into()))
            }
            fn image_ocr(&self, _b: &[u8], _m: &str) -> Result<String, crate::search_index::attachments::ExtractError> {
                Err(crate::search_index::attachments::ExtractError::Transient("timeout".into()))
            }
        }
        let changed = super::run_pending_extractions(&shared, true, true, true, &AlwaysTransient, |_a, _d, _u, _f, _p| {
            Some((
                crate::search_index::attachments::AttachmentInput { filename: "a.pdf".into(), mime: "application/pdf".into(), size: 5000, bytes: vec![] },
                IndexDoc::default(),
            ))
        }, &|| true);
        assert_eq!(changed.unwrap(), 0, "a transient error changes nothing observable");
        let guard = crate::search_index::lock(&shared);
        let conn = guard.as_ref().unwrap();
        let state: String = conn.query_row("SELECT state FROM attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "pending", "must still be pending so the next sweep retries it");
    }

    /// The index worker runs this between sweeps, so one Vision call that
    /// never returned stopped all indexing: new mail never reached a view or
    /// a search. Behind `BoundedExtractor` the batch finishes; the stuck part
    /// fails and the rest wait for a later pass.
    #[test]
    fn a_native_call_that_never_returns_does_not_hold_the_batch() {
        use crate::search_index::attachments::{tests::Hangs, AttachmentInput, BoundedExtractor};
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let image = |name: &str| AttachmentMeta { filename: name.into(), mime: "image/png".into(), size: 20_000 };
        let doc = IndexDoc { attachment_candidates: vec![image("a.png"), image("b.png")], ..IndexDoc::default() };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let shared = std::sync::Arc::new(Mutex::new(Some(conn)));

        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let (_release, rx) = std::sync::mpsc::channel::<()>();
        let hangs = Hangs { calls: calls.clone(), release: Mutex::new(rx) };
        let extractor = BoundedExtractor::new(hangs, std::time::Duration::from_millis(200));
        let (tx, done) = std::sync::mpsc::channel();
        let db = shared.clone();
        std::thread::spawn(move || {
            let changed = super::run_pending_extractions(&db, true, true, true, &extractor, |_a, _d, _u, _f, part| {
                Some((
                    AttachmentInput { filename: format!("{part}.png"), mime: "image/png".into(), size: 20_000, bytes: vec![0; 16] },
                    IndexDoc::default(),
                ))
            }, &|| true);
            let _ = tx.send(changed);
        });
        let changed = done.recv_timeout(std::time::Duration::from_secs(5)).expect("a stuck native call held the index worker");
        assert_eq!(changed.unwrap(), 1);

        let guard = crate::search_index::lock(&shared);
        let conn = guard.as_ref().unwrap();
        let states: Vec<String> = conn
            .prepare("SELECT state FROM attachments ORDER BY state").unwrap()
            .query_map([], |r| r.get(0)).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(states, vec!["failed", "pending"]);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "no second native call while the first is stuck");
    }

    #[test]
    fn a_missing_file_leaves_the_row_pending_without_looping_forever_in_one_call() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc {
            attachment_candidates: vec![AttachmentMeta { filename: "a.pdf".into(), mime: "application/pdf".into(), size: 5000 }],
            ..IndexDoc::default()
        };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let shared = Mutex::new(Some(conn));
        let changed = super::run_pending_extractions(&shared, true, true, true, &crate::search_index::attachments::NoOcrExtractor, |_a, _d, _u, _f, _p| None, &|| true);
        assert_eq!(changed.unwrap(), 0);
        let guard = crate::search_index::lock(&shared);
        let conn = guard.as_ref().unwrap();
        let state: String = conn.query_row("SELECT state FROM attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "pending");
    }

    // ---- Eviction (Track H2): a missing file the server still lists keeps its row ----

    const ATT: IndexConfig = IndexConfig { bodies: true, attachments: true, image_text: false };

    fn eml_id(message_id: &str, subject: &str, body: &str) -> String {
        eml(subject, body).replacen("\r\n\r\n", &format!("\r\nMessage-ID: {message_id}\r\n\r\n"), 1)
    }

    /// `fake_parse` plus one attachment-shaped part per message.
    fn parse_with_part(raw: &[u8], uid: u32, name: &str) -> Option<IndexDoc> {
        fake_parse(raw, uid, name).map(|mut d| {
            d.has_attachments = true;
            d.attachment_candidates = vec![AttachmentMeta { filename: format!("part{uid}.pdf"), mime: "application/pdf".into(), size: 10 }];
            d
        })
    }

    fn run_listed(v: &Vault, cfg: IndexConfig, parse: ParseFn, listing: ServerListing) -> ReconcileStats {
        reconcile_mailbox_guarded(&v.db, &v.root.join("Maildir"), "a1", "INBOX", cfg, parse, listing, &|| true, &|| true, &mut |_| {}).unwrap()
    }

    fn listing_of(entries: &[(u32, Option<&str>)]) -> impl Fn(&[u32]) -> Result<HashMap<u32, Option<String>>, String> {
        let map: HashMap<u32, Option<String>> = entries.iter().map(|&(uid, id)| (uid, id.map(str::to_owned))).collect();
        move |uids: &[u32]| Ok(uids.iter().filter_map(|u| map.get(u).map(|id| (*u, id.clone()))).collect())
    }

    fn no_listing(_: &[u32]) -> Result<HashMap<u32, Option<String>>, String> {
        Ok(HashMap::new())
    }

    fn cur_file(v: &Vault, uid: u32) -> std::path::PathBuf {
        v.root.join(format!("Maildir/a1/INBOX/cur/{uid}{INFO_PREFIX}.eml"))
    }

    fn row_id(v: &Vault, uid: u32) -> Option<i64> {
        let g = crate::search_index::lock(&v.db);
        g.as_ref().unwrap().query_row("SELECT id FROM messages WHERE uid = ?1", [uid], |r| r.get(0)).optional().unwrap()
    }

    fn attachment_states(v: &Vault, uid: u32) -> Vec<String> {
        let g = crate::search_index::lock(&v.db);
        let conn = g.as_ref().unwrap();
        let mut st = conn
            .prepare("SELECT a.state FROM attachments a JOIN messages m ON m.id = a.message_row WHERE m.uid = ?1 ORDER BY a.part_index")
            .unwrap();
        st.query_map([uid], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn attachment_count(v: &Vault) -> i64 {
        crate::search_index::lock(&v.db).as_ref().unwrap().query_row("SELECT count(*) FROM attachments", [], |r| r.get(0)).unwrap()
    }

    /// The brief's case: three indexed messages, two files evicted, the server
    /// still lists one of them. That one keeps its row, its body terms, its
    /// preview line and its attachment rows; the other goes as it always did.
    #[test]
    fn an_evicted_message_the_server_still_lists_stays_searchable() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<one@x.test>", "Kept", "aardvark report"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml_id("<two@x.test>", "Gone", "bumblebee report"));
        put(&v, "a1", "INBOX", &format!("3{INFO_PREFIX}.eml"), &eml_id("<three@x.test>", "Stays", "chameleon report"));
        let parses = AtomicUsize::new(0);
        let parse = |raw: &[u8], uid: u32, name: &str| { parses.fetch_add(1, Ordering::SeqCst); parse_with_part(raw, uid, name) };
        assert_eq!(run_listed(&v, ATT, &parse, &no_listing).parsed, 3);
        assert_eq!(attachment_count(&v), 3);

        std::fs::remove_file(cur_file(&v, 1)).unwrap();
        std::fs::remove_file(cur_file(&v, 2)).unwrap();
        let asked = Mutex::new(Vec::new());
        let server = listing_of(&[(1, Some("<one@x.test>")), (3, Some("<three@x.test>"))]);
        let listing = |uids: &[u32]| { asked.lock().unwrap().extend_from_slice(uids); server(uids) };
        let s = run_listed(&v, ATT, &parse, &listing);

        let mut asked = asked.into_inner().unwrap();
        asked.sort_unstable();
        assert_eq!(asked, vec![1, 2], "only the uids whose files are gone are looked up");
        assert_eq!((s.removed, s.kept, s.parsed), (1, 1, 0));
        assert_eq!(s.removed_keys, vec!["two@x.test".to_string()], "a kept row is not reported as gone, so its tags stay");
        assert_eq!(fts_hits(&v, "\"aardvark\"").len(), 1, "the evicted body is still searchable");
        assert!(fts_hits(&v, "\"bumblebee\"").is_empty());
        assert_eq!(snippets(&v, &[1]).get(&1).map(String::as_str), Some("aardvark report"));
        assert_eq!(attachment_states(&v, 1), vec!["evicted".to_string()], "kept, and out of the extraction queue");
        assert_eq!(attachment_count(&v), 2, "the removed message's attachment rows went with it");
        assert_eq!(attachment_states(&v, 3), vec!["pending".to_string()], "a message still on disk is untouched");

        let again = run_listed(&v, ATT, &parse, &listing_of(&[(1, Some("<one@x.test>"))]));
        assert_eq!((again.removed, again.kept, again.parsed), (0, 1, 0), "a later pass keeps it without re-reading anything");
        assert_eq!(parses.load(Ordering::SeqCst), 3);
        assert_eq!(fts_hits(&v, "\"aardvark\"").len(), 1);
    }

    /// Once the file is back (a re-download, a restore), it is read into the
    /// row it had, even when the restored file matches the old size and mtime.
    #[test]
    fn a_restored_evicted_file_is_reparsed_into_its_own_row() {
        let v = vault();
        let raw = eml_id("<one@x.test>", "Kept", "aardvark report");
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &raw);
        let parses = AtomicUsize::new(0);
        let parse = |raw: &[u8], uid: u32, name: &str| { parses.fetch_add(1, Ordering::SeqCst); parse_with_part(raw, uid, name) };
        run_listed(&v, ATT, &parse, &no_listing);
        let id = row_id(&v, 1).unwrap();
        let mtime = std::fs::metadata(cur_file(&v, 1)).unwrap().modified().unwrap();

        std::fs::remove_file(cur_file(&v, 1)).unwrap();
        assert_eq!(run_listed(&v, ATT, &parse, &listing_of(&[(1, Some("<one@x.test>"))])).kept, 1);

        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &raw);
        std::fs::File::options().write(true).open(cur_file(&v, 1)).unwrap().set_modified(mtime).unwrap();
        let s = run_listed(&v, ATT, &parse, &listing_of(&[(1, Some("<one@x.test>"))]));
        assert_eq!((s.parsed, s.kept, s.removed), (1, 0, 0));
        assert_eq!(parses.load(Ordering::SeqCst), 2, "read again although size and mtime match the old file");
        assert_eq!(row_count(&v.db), 1, "no duplicate row");
        assert_eq!(row_id(&v, 1), Some(id), "the same row, updated in place");
        assert_eq!(attachment_states(&v, 1), vec!["pending".to_string()], "back in the extraction queue");
        assert_eq!(fts_hits(&v, "\"aardvark\"").len(), 1);
        assert_eq!(run_listed(&v, ATT, &parse, &no_listing).unchanged, 1, "then unchanged again");
    }

    /// Regression guard: with a server listing that names nothing, every
    /// missing file is removed exactly as before eviction existed.
    #[test]
    fn a_missing_file_the_server_does_not_list_is_removed_as_before() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<one@x.test>", "Gone", "aardvark report"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml_id("<two@x.test>", "Stays", "bumblebee report"));
        run_listed(&v, ATT, &parse_with_part, &no_listing);
        std::fs::remove_file(cur_file(&v, 1)).unwrap();
        let s = run_listed(&v, ATT, &parse_with_part, &no_listing);
        assert_eq!((s.removed, s.kept), (1, 0));
        assert_eq!(s.removed_keys, vec!["one@x.test".to_string()]);
        assert_eq!(row_id(&v, 1), None);
        assert!(fts_hits(&v, "\"aardvark\"").is_empty());
        assert_eq!(attachment_count(&v), 1);
    }

    /// The header cache could not be read: nothing is removed this pass (a
    /// failed read never deletes), and nothing is marked either.
    #[test]
    fn an_unreadable_server_listing_removes_nothing_this_pass() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<one@x.test>", "Gone", "aardvark report"));
        run_listed(&v, ATT, &parse_with_part, &no_listing);
        std::fs::remove_file(cur_file(&v, 1)).unwrap();
        let broken = |_: &[u32]| -> Result<HashMap<u32, Option<String>>, String> { Err("custody store is not open".into()) };
        let s = run_listed(&v, ATT, &parse_with_part, &broken);
        assert_eq!((s.removed, s.kept), (0, 0));
        assert!(s.removed_keys.is_empty());
        assert_eq!(fts_hits(&v, "\"aardvark\"").len(), 1);
        assert_eq!(attachment_states(&v, 1), vec!["pending".to_string()]);

        let s = run_listed(&v, ATT, &parse_with_part, &no_listing);
        assert_eq!((s.removed, s.removed_keys.len()), (1, 1), "the next readable listing decides");
    }

    /// Uids restart after a UIDVALIDITY change: the listing's uid 2 can be a
    /// different message than the vault's uid 2. A Message-ID that disagrees
    /// is not the server holding this message. Without one on either side,
    /// the uid is all there is to go on.
    #[test]
    fn a_listed_uid_that_names_another_message_does_not_keep_the_row() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<one@x.test>", "Same", "aardvark"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml_id("<two@x.test>", "Other", "bumblebee"));
        put(&v, "a1", "INBOX", &format!("3{INFO_PREFIX}.eml"), &eml("No id", "chameleon"));
        put(&v, "a1", "INBOX", &format!("4{INFO_PREFIX}.eml"), &eml_id("<four@x.test>", "Unlisted id", "dromedary"));
        run_listed(&v, ON, &fake_parse, &no_listing);
        for uid in 1..=4 {
            std::fs::remove_file(cur_file(&v, uid)).unwrap();
        }
        let listing = listing_of(&[(1, Some(" <one@x.test> ")), (2, Some("<new-two@x.test>")), (3, Some("<three@x.test>")), (4, None)]);
        let s = run_listed(&v, ON, &fake_parse, &listing);
        assert_eq!((s.kept, s.removed), (3, 1));
        assert_eq!(s.removed_keys, vec!["two@x.test".to_string()]);
        assert_eq!((row_id(&v, 1).is_some(), row_id(&v, 2).is_some(), row_id(&v, 3).is_some(), row_id(&v, 4).is_some()), (true, false, true, true));
    }

    /// A kept row whose body was never read (bodies were off at eviction, then
    /// turned on) has no file to read it from: it must not hold the index at
    /// "not complete" forever.
    #[test]
    fn an_evicted_row_waiting_for_its_body_does_not_keep_the_index_incomplete() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<one@x.test>", "Headers only", "aardvark"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}.eml"), &eml_id("<two@x.test>", "On disk", "bumblebee"));
        run_listed(&v, OFF, &fake_parse, &no_listing);
        std::fs::remove_file(cur_file(&v, 1)).unwrap();
        let server = listing_of(&[(1, Some("<one@x.test>"))]);
        run_listed(&v, OFF, &fake_parse, &server);
        set_bodies_enabled(&v.db, true).unwrap();
        let s = run_listed(&v, ON, &fake_parse, &server);
        assert_eq!((s.kept, s.parsed), (1, 1));
        assert_eq!(counts(&v), db::IndexCounts { indexed: 2, total: 2 });
        assert_eq!(fts_hits(&v, "\"headers\"").len(), 1, "its headers stay searchable");
    }

    #[test]
    fn attachment_read_part_runs_without_holding_the_shared_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: format!("1{INFO_PREFIX}"), size: 10, mtime_ns: 0 };
        let doc = IndexDoc { attachment_candidates: vec![AttachmentMeta { filename: "a.pdf".into(), mime: "application/pdf".into(), size: 5000 }], ..IndexDoc::default() };
        commit_batch(&mut conn, "acct", "INBOX", IndexConfig { bodies: true, attachments: true, image_text: true }, vec![(&file, Some(doc))]).unwrap();
        let shared = Mutex::new(Some(conn));
        let observed_unlocked = std::sync::atomic::AtomicBool::new(false);
        let _ = super::run_pending_extractions(&shared, true, false, true, &crate::search_index::attachments::NoOcrExtractor, |_a, _d, _u, _f, _p| {
            observed_unlocked.store(shared.try_lock().is_ok(), Ordering::SeqCst);
            None
        }, &|| true);
        assert!(observed_unlocked.load(Ordering::SeqCst), "message and attachment reading must happen outside the DB mutex");
    }

    fn mtime_of(v: &Vault, uid: u32) -> i64 {
        crate::search_index::lock(&v.db).as_ref().unwrap().query_row("SELECT mtime_ns FROM messages WHERE uid = ?1", [uid], |r| r.get(0)).unwrap()
    }

    fn name_and_flags(v: &Vault, uid: u32) -> (String, String) {
        crate::search_index::lock(&v.db)
            .as_ref()
            .unwrap()
            .query_row("SELECT filename, flags FROM messages WHERE uid = ?1", [uid], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
    }

    /// H3b (c): `forget_file` (a pgp copy written beside the file) marks the
    /// row for a re-read. When the file is evicted before the next sweep, the
    /// row must still be kept as evicted: its parts leave the extraction
    /// queue, and its mark is not the re-read one.
    #[test]
    fn a_file_evicted_after_a_reread_mark_is_still_kept_and_leaves_the_extraction_queue() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<one@x.test>", "Sealed", "aardvark report"));
        let parses = AtomicUsize::new(0);
        let parse = |raw: &[u8], uid: u32, name: &str| { parses.fetch_add(1, Ordering::SeqCst); parse_with_part(raw, uid, name) };
        run_listed(&v, ATT, &parse, &no_listing);
        assert_eq!(attachment_states(&v, 1), vec!["pending".to_string()]);

        forget_file(&v.db, "a1", "INBOX", 1).unwrap();
        std::fs::remove_file(cur_file(&v, 1)).unwrap();
        let server = listing_of(&[(1, Some("<one@x.test>"))]);
        let s = run_listed(&v, ATT, &parse, &server);
        assert_eq!((s.kept, s.removed, s.parsed), (1, 0, 0));
        assert_eq!(attachment_states(&v, 1), vec![ATTACHMENT_EVICTED.to_string()], "out of the extraction queue");
        assert_eq!(mtime_of(&v, 1), EVICTED);
        assert_ne!(EVICTED, REREAD, "an evicted row is told apart from one waiting for a re-read");

        let again = run_listed(&v, ATT, &parse, &server);
        assert_eq!((again.kept, again.parsed), (1, 0));
        assert_eq!(parses.load(Ordering::SeqCst), 1);
        assert_eq!(fts_hits(&v, "\"aardvark\"").len(), 1);
    }

    /// H3b (d): the local archived copy is gone once the file is, so a kept
    /// row stops saying archived, in its flags and in the name the search
    /// results read `isArchived` from. Its other flags stay.
    #[test]
    fn keeping_an_evicted_row_drops_its_archived_flag() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}AS.eml"), &eml_id("<one@x.test>", "Archived", "aardvark"));
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}F.eml"), &eml_id("<two@x.test>", "Flagged", "bumblebee"));
        run_listed(&v, ON, &fake_parse, &no_listing);
        assert_eq!(name_and_flags(&v, 1).1, "AS");
        std::fs::remove_file(v.root.join(format!("Maildir/a1/INBOX/cur/1{INFO_PREFIX}AS.eml"))).unwrap();
        std::fs::remove_file(v.root.join(format!("Maildir/a1/INBOX/cur/2{INFO_PREFIX}F.eml"))).unwrap();
        let s = run_listed(&v, ON, &fake_parse, &listing_of(&[(1, Some("<one@x.test>")), (2, Some("<two@x.test>"))]));
        assert_eq!(s.kept, 2);
        assert_eq!(name_and_flags(&v, 1), (format!("1{INFO_PREFIX}S.eml"), "S".to_string()));
        assert_eq!(name_and_flags(&v, 2), (format!("2{INFO_PREFIX}F.eml"), "F".to_string()));
        assert_eq!(fts_hits(&v, "\"aardvark\"").len(), 1);
    }

    fn header(uid: u32, subject: &str, from: &str, flags: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "uid": uid,
            "messageId": format!("<m{uid}@x.test>"),
            "subject": subject,
            "from": {"name": "Carol Jones", "address": from},
            "to": [{"name": "", "address": "bob@x.test"}],
            "cc": [{"name": "Dan", "address": "dan@x.test"}],
            "date": "Sat, 12 Sep 2026 10:00:00 +0000",
            "flags": flags,
            "hasAttachments": true,
            "text": "never indexed from the header cache",
        })
    }

    /// H3b (b): after a rebuild from `cur/`, a message the header cache lists
    /// for the folder but no file holds (evicted) gets a header-only row:
    /// found by subject and sender, never by body, no preview line, no
    /// archived flag. A uid on disk and a row already there are left alone.
    #[test]
    fn listed_mail_missing_from_cur_gets_a_header_only_row() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("1{INFO_PREFIX}.eml"), &eml_id("<m1@x.test>", "On disk", "aardvark"));
        run_listed(&v, ON, &fake_parse, &no_listing);
        let listed = vec![
            header(1, "Header of the file", "ann@x.test", &[]),
            header(2, "Quarterly budget", "carol@x.test", &["\\Seen", "archived", "\\Flagged"]),
            header(3, "Unread note", "erin@x.test", &[]),
        ];
        assert_eq!(add_listed_rows(&v.db, &v.root.join("Maildir"), "a1", "INBOX", &listed, &|| true).unwrap(), 2);

        let g = crate::search_index::lock(&v.db);
        let conn = g.as_ref().unwrap();
        let (subject, from, to, date, flags, name, snippet, body_state, message_id, row_json, mtime): (String, String, String, i64, String, String, Option<String>, i64, Option<String>, String, i64) = conn
            .query_row(
                "SELECT subject_lc, from_addr_lc, to_lc, date_utc, flags, filename, snippet, body_state, message_id, row_json, mtime_ns FROM messages WHERE uid = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
            )
            .unwrap();
        assert_eq!((subject.as_str(), from.as_str()), ("quarterly budget", "carol@x.test"));
        assert!(to.contains("bob@x.test") && to.contains("dan <dan@x.test>"), "{to}");
        assert_eq!(date, mailparse::dateparse("Sat, 12 Sep 2026 10:00:00 +0000").unwrap());
        assert_eq!(flags, "FS", "the server's flags, never archived");
        assert_eq!(name, format!("2{INFO_PREFIX}FS.eml"));
        assert_eq!(snippet, None, "no body was ever read");
        assert_eq!(body_state, BODY_UNPARSEABLE, "no body to wait for");
        assert_eq!(message_id.as_deref(), Some("<m2@x.test>"));
        assert_eq!(mtime, EVICTED);
        let row: serde_json::Value = serde_json::from_str(&row_json).unwrap();
        assert_eq!(row["subject"], "Quarterly budget");
        assert!(row.get("flags").is_none() && row.get("text").is_none(), "{row}");
        let subject_on_disk: String = conn.query_row("SELECT subject_lc FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(subject_on_disk, "on disk", "the file's own row is not overwritten");
        drop(g);

        assert_eq!(fts_hits(&v, "\"budget\"").len(), 1, "found by subject");
        assert_eq!(fts_hits(&v, "\"carol@x.test\"").len(), 1, "found by sender");
        assert!(fts_hits(&v, "\"never indexed\"").is_empty(), "no body terms");
        assert!(snippets(&v, &[2, 3]).is_empty());
        assert_eq!(add_listed_rows(&v.db, &v.root.join("Maildir"), "a1", "INBOX", &listed, &|| true).unwrap(), 0, "once");

        // Later passes keep them while the server lists them, without reading anything.
        let server = listing_of(&[(2, Some("<m2@x.test>")), (3, Some("<m3@x.test>"))]);
        let s = run_listed(&v, ON, &fake_parse, &server);
        assert_eq!((s.kept, s.removed, s.parsed, s.unchanged), (2, 0, 0, 1));
        assert_eq!(counts(&v), db::IndexCounts { indexed: 3, total: 3 });

        // The body coming back is read into the same row.
        let id = row_id(&v, 2).unwrap();
        put(&v, "a1", "INBOX", &format!("2{INFO_PREFIX}FS.eml"), &eml_id("<m2@x.test>", "Quarterly budget", "chameleon figures"));
        let s = run_listed(&v, ON, &fake_parse, &server);
        assert_eq!((s.parsed, s.kept), (1, 1));
        assert_eq!(row_id(&v, 2), Some(id));
        assert_eq!(fts_hits(&v, "\"chameleon\"").len(), 1);
    }

    /// H3b fix 4: after a UIDVALIDITY change the archived copy keeps its old
    /// uid while the header cache lists the message under a new one. The
    /// same message is not added twice, nor twice from two mailboxes behind
    /// one folder; a header with no Message-ID cannot be matched, so it goes in.
    #[test]
    fn a_header_only_row_is_not_added_for_a_message_the_folder_already_holds() {
        let v = vault();
        put(&v, "a1", "INBOX", &format!("5{INFO_PREFIX}AS.eml"), &eml_id("<dup@x.test>", "Kept copy", "aardvark"));
        run_listed(&v, ON, &fake_parse, &no_listing);
        let mut again = header(1, "Kept copy", "ann@x.test", &[]);
        again["messageId"] = serde_json::json!(" dup@x.test ");
        let mut twin = header(8, "Twin", "ann@x.test", &[]);
        twin["messageId"] = serde_json::json!("<m7@x.test>");
        let mut no_id = header(9, "No id", "ann@x.test", &[]);
        no_id.as_object_mut().unwrap().remove("messageId");
        let listed = vec![again, header(7, "Twin", "ann@x.test", &[]), twin, no_id];
        assert_eq!(add_listed_rows(&v.db, &v.root.join("Maildir"), "a1", "INBOX", &listed, &|| true).unwrap(), 2);
        assert_eq!((row_id(&v, 1), row_id(&v, 7).is_some(), row_id(&v, 8), row_id(&v, 9).is_some()), (None, true, None, true));
    }

    /// H3b fix 5: a header with no readable Date is dated by its arrival
    /// (`internalDate`), and with neither by now, never 1970.
    #[test]
    fn an_undated_header_only_row_takes_its_internal_date_then_now() {
        let v = vault();
        std::fs::create_dir_all(v.root.join("Maildir/a1/INBOX/cur")).unwrap();
        let mut arrived = header(1, "Arrived", "ann@x.test", &[]);
        arrived["date"] = serde_json::json!("sometime");
        arrived["internalDate"] = serde_json::json!("2026-09-01T08:00:00+00:00");
        let mut undated = header(2, "Undated", "ann@x.test", &[]);
        undated.as_object_mut().unwrap().remove("date");
        let before = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        assert_eq!(add_listed_rows(&v.db, &v.root.join("Maildir"), "a1", "INBOX", &[arrived, undated], &|| true).unwrap(), 2);
        let date = |uid: u32| -> i64 {
            crate::search_index::lock(&v.db).as_ref().unwrap().query_row("SELECT date_utc FROM messages WHERE uid = ?1", [uid], |r| r.get(0)).unwrap()
        };
        assert_eq!(date(1), chrono::DateTime::parse_from_rfc3339("2026-09-01T08:00:00+00:00").unwrap().timestamp());
        assert!((before..before + 60).contains(&date(2)), "{}", date(2));
    }

    /// H3b fix 6: Reply-To is one address (an object), or a list: either is indexed.
    #[test]
    fn a_header_only_row_indexes_its_reply_to_address() {
        let v = vault();
        std::fs::create_dir_all(v.root.join("Maildir/a1/INBOX/cur")).unwrap();
        let mut one = header(1, "One", "ann@x.test", &[]);
        one["replyTo"] = serde_json::json!({"name": "Desk", "address": "helpdesk@x.test"});
        let mut many = header(2, "Many", "ann@x.test", &[]);
        many["replyTo"] = serde_json::json!([{"address": "orders@x.test"}]);
        add_listed_rows(&v.db, &v.root.join("Maildir"), "a1", "INBOX", &[one, many], &|| true).unwrap();
        assert_eq!(fts_hits(&v, "\"helpdesk@x.test\"").len(), 1);
        assert_eq!(fts_hits(&v, "\"orders@x.test\"").len(), 1);
    }

    /// Only a fresh index (created, rebuilt, recovered, re-enabled after a
    /// destroy) asks for header-only rows; the daemon clears the mark.
    #[test]
    fn a_fresh_index_asks_for_listed_rows() {
        let v = vault();
        let g = crate::search_index::lock(&v.db);
        assert_eq!(meta_get(g.as_ref().unwrap(), db::LISTED_ROWS_PENDING).as_deref(), Some("1"));
        meta_set(g.as_ref().unwrap(), db::LISTED_ROWS_PENDING, "0").unwrap();
        drop(g);
        *crate::search_index::lock(&v.db) = None; // exclusive locking: one connection at a time
        let reopened = db::open(&v.root).unwrap();
        assert_eq!(meta_get(&reopened, db::LISTED_ROWS_PENDING).as_deref(), Some("0"), "an existing index is not asked again");
    }
}
