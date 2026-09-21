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
    pub unchanged: usize,
    pub failed: usize,
    pub interrupted: bool,
}

pub const BODY_PENDING: i64 = 0;
pub const BODY_INDEXED: i64 = 1;
pub const BODY_DISABLED: i64 = 2;
pub const BODY_UNPARSEABLE: i64 = 3;

fn closed() -> String {
    "search index closed".into()
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

struct DiskFile {
    uid: u32,
    filename: String,
    size: i64,
    mtime_ns: i64,
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
    let entries = std::fs::read_dir(cur).ok()?;
    let mut files = HashMap::new();
    let mut unstatted = HashSet::new();
    for entry in entries.flatten() {
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
    Some((files, unstatted))
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
    reconcile_mailbox_guarded(db, maildir_root, account_id, vault_dir, config, parse, keep_going, &|| true, progress)
}

/// Like `reconcile_mailbox`, with a second fence checked at each DB mutation
/// boundary, including again after acquiring the mutex. `commit_allowed` may
/// run while the DB guard is held and therefore must inspect no DB-locked state.
pub fn reconcile_mailbox_guarded(
    db: &SharedConn,
    maildir_root: &Path,
    account_id: &str,
    vault_dir: &str,
    config: IndexConfig,
    parse: ParseFn,
    keep_going: &dyn Fn() -> bool,
    commit_allowed: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(usize),
) -> Result<ReconcileStats, String> {
    let mut stats = ReconcileStats::default();
    // account_id is NOT sanitized: a legacy, pre-migration account directory
    // is keyed by the raw email address (see vault_files::cur_path's doc).
    let cur = maildir_root.join(account_id).join(vault_dir).join("cur");
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
    let removals: Vec<i64> = rows
        .iter()
        .filter(|(uid, _)| !files.contains_key(uid) && !unstatted.contains(uid))
        .map(|(_, r)| r.id)
        .collect();

    // `None` = remove the row, `Some(name)` = rename it. One transaction per
    // chunk, so a folder emptied of 20k files never holds the lock for all of them.
    let ops: Vec<(i64, Option<&str>)> =
        removals.iter().map(|&id| (id, None)).chain(renames.iter().map(|&(id, name)| (id, Some(name)))).collect();
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
        let mut gone = apply_removals_and_renames(conn, chunk).map_err(db_err)?;
        stats.removed_keys.append(&mut gone);
        let removed = chunk.iter().filter(|(_, name)| name.is_none()).count();
        stats.removed += removed;
        stats.renamed += chunk.len() - removed;
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
            let raw = match std::fs::read(cur.join(&file.filename)) {
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
                Err(e) if matches!(e.kind(), std::io::ErrorKind::IsADirectory | std::io::ErrorKind::NotADirectory) => {
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
                m.has_attachments AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_row = m.id)
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
            },
        ))
    })?;
    rows.collect()
}

/// Returns the identities of the rows it removed.
fn apply_removals_and_renames(conn: &mut Connection, ops: &[(i64, Option<&str>)]) -> rusqlite::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let mut removed_keys = Vec::new();
    for &(id, rename) in ops {
        match rename {
            None => {
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
            Some(filename) => {
                // The flags ride the name, so a rename is how a star, a read
                // receipt or an archive reaches the index at all.
                tx.prepare_cached("UPDATE messages SET filename = ?1, flags = ?2 WHERE id = ?3")?
                    .execute(params![filename, flags_of(filename), id])?;
            }
        }
    }
    tx.commit()?;
    Ok(removed_keys)
}

const UPSERT: &str = "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
    from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags, to_lc)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
  ON CONFLICT(account_id, vault_dir, uid) DO UPDATE SET filename=excluded.filename, size=excluded.size,
    mtime_ns=excluded.mtime_ns, message_id=excluded.message_id, date_utc=excluded.date_utc,
    from_addr_lc=excluded.from_addr_lc, from_name_lc=excluded.from_name_lc, subject_lc=excluded.subject_lc,
    addrs_lc=excluded.addrs_lc, has_attachments=excluded.has_attachments, body_state=excluded.body_state,
    row_json=excluded.row_json, flags=excluded.flags, to_lc=excluded.to_lc
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
/// reconcile will notice the file is gone and remove the message row, which
/// cascades to its attachment rows via `ON DELETE CASCADE`). A `Transient`
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
        "UPDATE messages SET body_state = ?1 WHERE body_state IN (?2, ?3)",
        [BODY_DISABLED, BODY_PENDING, BODY_INDEXED],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
            put(v, "a1", "INBOX", &format!("{uid}:2,.eml"), &eml(&format!("m{uid}"), "x"));
        }
    }

    const ON: IndexConfig = IndexConfig { bodies: true, attachments: false, image_text: false };
    const OFF: IndexConfig = IndexConfig { bodies: false, attachments: false, image_text: false };

    #[test]
    fn indexes_new_files_and_skips_unchanged_ones() {
        let v = vault();
        put(&v, "a1", "INBOX", "1:2,S.eml", &eml("Quarterly invoice", "the attached statement"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Lunch", "see you at noon"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Hello", "body"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        let cur = v.root.join("Maildir/a1/INBOX/cur");
        std::fs::rename(cur.join("1:2,.eml"), cur.join("1:2,S.eml")).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s.renamed, s.parsed), (1, 0));
        assert_eq!(n.load(Ordering::SeqCst), 1);
        let g = crate::search_index::lock(&v.db);
        let (name, flags): (String, String) = g
            .as_ref()
            .unwrap()
            .query_row("SELECT filename, flags FROM messages WHERE uid = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(name, "1:2,S.eml");
        // A star or a read receipt IS a rename, and a saved view filtering on
        // Starred reads this column. Leaving it at the parse-time value would
        // make every flag change invisible until the file was rewritten.
        assert_eq!(flags, "S");
    }

    #[test]
    fn a_removed_message_reports_the_identity_its_metadata_is_keyed_by() {
        let v = vault();
        let identified = "From: A <a@x.test>\r\nSubject: Gone soon\r\nMessage-ID: <gone@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbody\r\n";
        put(&v, "a1", "INBOX", "1:2,.eml", identified);
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Stays", "body"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        std::fs::remove_file(v.root.join("Maildir/a1/INBOX/cur/1:2,.eml")).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s.removed, 1);
        assert_eq!(s.removed_keys.len(), 1);
        assert_eq!(s.removed_keys, vec!["gone@x.test".to_string()], "the Message-ID, not a uid");
    }

    #[test]
    fn a_message_with_no_message_id_still_reports_a_key_when_it_goes() {
        let v = vault();
        let raw = "From: A <a@x.test>\r\nSubject: No identity\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbody\r\n";
        put(&v, "a1", "INBOX", "5:2,.eml", raw);
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        std::fs::remove_file(v.root.join("Maildir/a1/INBOX/cur/5:2,.eml")).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s.removed_keys, vec!["u:INBOX:5".to_string()]);
    }

    #[test]
    fn an_indexed_message_carries_the_flags_its_file_name_spells() {
        let v = vault();
        put(&v, "a1", "INBOX", "1:2,FS.eml", &eml("Starred", "body"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Plain", "body"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Old subject 古い", "old words"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Goner 消える", "vanishing"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((cjk_hits(&v, "\"古 い\""), cjk_hits(&v, "\"消 え る\"")), (1, 1));
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("New subject 新しい", "brand new longer words here"));
        std::fs::remove_file(v.root.join("Maildir/a1/INBOX/cur/2:2,.eml")).unwrap();
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
        put(&v, "a1", "INBOX", "1:2,.eml", "no headers at all, no subject");
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Alpha", "one"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Beta", "two"));
        let cur = v.root.join("Maildir/a1/INBOX/cur");
        std::fs::create_dir(cur.join("9:2,.eml")).unwrap(); // listed, never readable
        // Highest uid first: uid 2's parse deletes uid 1 after the listing saw it.
        let parse = |raw: &[u8], uid: u32, name: &str| {
            if uid == 2 {
                let _ = std::fs::remove_file(cur.join("1:2,.eml"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Alpha", "readable"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Beta", "padlocked"));
        let locked = v.root.join("Maildir/a1/INBOX/cur/2:2,.eml");
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
        for uid in 1..=3 { put(&v, "a1", "INBOX", &format!("{uid}:2,.eml"), &eml("In", "x")); }
        for uid in 1..=2 { put(&v, "a1", "Archive", &format!("{uid}:2,.eml"), &eml("Arc", "x")); }
        put(&v, "a1", "Gone", "1:2,.eml", &eml("Gone", "x"));
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
            for uid in 1..=2 { put(&v, "a1", dir, &format!("{uid}:2,.eml"), &eml(dir, "x")); }
        }
        let n = AtomicUsize::new(0);
        for dir in ["INBOX", "Archive"] { run(&v, "a1", dir, ON, &n); }
        assert_eq!(counts(&v), db::IndexCounts { indexed: 4, total: 4 });
        std::fs::remove_file(v.root.join("Maildir/a1/INBOX/cur/2:2,.eml")).unwrap();
        run(&v, "a1", "INBOX", ON, &n); // a nudge: this folder only, no full pass
        assert_eq!(counts(&v), db::IndexCounts { indexed: 3, total: 3 });
    }

    #[test]
    fn bodies_off_indexes_headers_only_and_toggling_on_reparses() {
        let v = vault();
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Weekly report", "confidential numbers"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Alpha", "one"));
        put(&v, "a2", "INBOX", "1:2,.eml", &eml("Beta", "two"));
        put(&v, "a2", "Projects_2026", "1:2,.eml", &eml("Gamma", "three"));
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
        for uid in 1..=(BATCH as u32 + 20) { put(&v, "a1", "INBOX", &format!("{uid}:2,.eml"), &eml(&format!("m{uid}"), "x")); }
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("new", "body"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("明日の会議について", "資料を添付します"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Alpha", "one"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Beta", "two"));
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml_utf8("Weekly report", "confidential 機密 numbers"));
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
            put(&v, "bench", dir, &format!("{i}:2,S.eml"), &eml_utf8(&format!("{w} update {i}"), &body));
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
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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

    #[test]
    fn a_missing_file_leaves_the_row_pending_without_looping_forever_in_one_call() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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

    #[test]
    fn attachment_read_part_runs_without_holding_the_shared_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let file = DiskFile { uid: 1, filename: "1:2,".into(), size: 10, mtime_ns: 0 };
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
}
