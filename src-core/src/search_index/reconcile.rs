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
use rusqlite::{params, Connection};
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
    pub subject: String,
    /// Plain text; the adapter picks text/plain or runs html_to_text.
    pub body_text: String,
    pub has_attachments: bool,
    /// The list row JSON with text/html cleared and no flags (flags come from the filename).
    pub row_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexConfig {
    pub bodies: bool,
}

/// (raw bytes, uid, filename) -> parsed doc, or None when the file is not mail.
pub type ParseFn<'a> = &'a (dyn Fn(&[u8], u32, &str) -> Option<IndexDoc> + Sync);

/// `parsed` and `failed` are disjoint: `failed` counts files that were
/// unparseable or unreadable (both recorded) or gone since the listing (left
/// for the next sweep).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileStats {
    pub parsed: usize,
    pub renamed: usize,
    pub removed: usize,
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
    let mut stats = ReconcileStats::default();
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
                    && !(row.body_state == BODY_PENDING && config.bodies) =>
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
        let conn = same_conn(&mut guard, &db_path)?;
        apply_removals_and_renames(conn, chunk).map_err(db_err)?;
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
                // Unreadable where it stands (permissions, a directory, I/O): recorded
                // as unparseable, so it counts as indexed and is retried only when
                // its size or mtime change.
                Err(_) => {
                    stats.failed += 1;
                    docs.push((file, None));
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
        {
            let mut guard = lock(db);
            let conn = same_conn(&mut guard, &db_path)?;
            commit_batch(conn, account_id, vault_dir, config, docs).map_err(db_err)?;
        } // guard dropped before progress: the callback locks the same mutex
        progress(stats.parsed + stats.failed);
    }
    Ok(stats)
}

fn load_rows(conn: &Connection, account_id: &str, vault_dir: &str) -> rusqlite::Result<HashMap<u32, Row>> {
    let mut st = conn.prepare_cached(
        "SELECT id, uid, filename, size, mtime_ns, body_state FROM messages WHERE account_id = ?1 AND vault_dir = ?2",
    )?;
    let rows = st.query_map(params![account_id, vault_dir], |r| {
        Ok((
            r.get::<_, u32>(1)?,
            Row { id: r.get(0)?, filename: r.get(2)?, size: r.get(3)?, mtime_ns: r.get(4)?, body_state: r.get(5)? },
        ))
    })?;
    rows.collect()
}

fn apply_removals_and_renames(conn: &mut Connection, ops: &[(i64, Option<&str>)]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for &(id, rename) in ops {
        match rename {
            None => {
                delete_fts(&tx, id)?;
                tx.prepare_cached("DELETE FROM messages WHERE id = ?1")?.execute([id])?;
            }
            Some(filename) => {
                tx.prepare_cached("UPDATE messages SET filename = ?1 WHERE id = ?2")?.execute(params![filename, id])?;
            }
        }
    }
    tx.commit()
}

const UPSERT: &str = "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
    from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
  ON CONFLICT(account_id, vault_dir, uid) DO UPDATE SET filename=excluded.filename, size=excluded.size,
    mtime_ns=excluded.mtime_ns, message_id=excluded.message_id, date_utc=excluded.date_utc,
    from_addr_lc=excluded.from_addr_lc, from_name_lc=excluded.from_name_lc, subject_lc=excluded.subject_lc,
    addrs_lc=excluded.addrs_lc, has_attachments=excluded.has_attachments, body_state=excluded.body_state,
    row_json=excluded.row_json
  RETURNING id";

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
        for (file, doc) in docs {
            let body_state = match (&doc, config.bodies) {
                (None, _) => BODY_UNPARSEABLE,
                (Some(_), true) => BODY_INDEXED,
                (Some(_), false) => BODY_DISABLED,
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
                ],
                |r| r.get(0),
            )?;
            delete_fts(&tx, id)?;
            if body_state != BODY_UNPARSEABLE {
                insert_fts(&tx, id, &d.subject, &addrs, &d.body_text)?;
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

fn insert_fts(conn: &Connection, id: i64, subject: &str, addrs: &str, body: &str) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (?1, ?2, ?3, ?4, '')")?
        .execute(params![id, subject, addrs, body])?;
    let (s, a, b) = (cjk_units(subject), cjk_units(addrs), cjk_units(body));
    if !(s.is_empty() && a.is_empty() && b.is_empty()) {
        conn.prepare_cached("INSERT INTO msg_cjk(rowid, subject, addrs, body, attach) VALUES (?1, ?2, ?3, ?4, '')")?
            .execute(params![id, s, a, b])?;
    }
    Ok(())
}

/// Drop every folder whose `(account_id, vault_dir)` is not in `present`.
/// Returns the number of folders removed.
pub fn prune_missing_dirs(db: &SharedConn, present: &[(String, String)]) -> Result<usize, String> {
    let mut guard = lock(db);
    let conn = guard.as_mut().ok_or_else(closed)?;
    prune(conn, present).map_err(db_err)
}

fn prune(conn: &mut Connection, present: &[(String, String)]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    // Scan rows too: a folder listed but never indexed still adds to `counts().total`.
    let indexed: Vec<(String, String)> = tx
        .prepare("SELECT account_id, vault_dir FROM messages UNION SELECT account_id, vault_dir FROM mailbox_scan")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // ponytail: O(folders²) membership test; fine for hundreds of folders, HashSet if vaults reach thousands.
    let missing: Vec<(String, String)> = indexed.into_iter().filter(|pair| !present.contains(pair)).collect();
    for (account_id, vault_dir) in &missing {
        let scope = params![account_id, vault_dir];
        tx.execute("DELETE FROM msg_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)", scope)?;
        tx.execute("DELETE FROM msg_cjk WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?1 AND vault_dir = ?2)", scope)?;
        tx.execute("DELETE FROM messages WHERE account_id = ?1 AND vault_dir = ?2", scope)?;
        tx.execute("DELETE FROM mailbox_scan WHERE account_id = ?1 AND vault_dir = ?2", scope)?;
    }
    tx.commit()?;
    Ok(missing.len())
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
        insert_fts(conn, id, &subject, &addrs, "")?;
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
    use std::sync::atomic::{AtomicUsize, Ordering};
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
            subject,
            body_text: parsed.get_body().unwrap_or_default(),
            has_attachments: false,
            row_json: "{}".into(),
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

    const ON: IndexConfig = IndexConfig { bodies: true };
    const OFF: IndexConfig = IndexConfig { bodies: false };

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
        let name: String = g.as_ref().unwrap().query_row("SELECT filename FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "1:2,S.eml");
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
        let calls = AtomicUsize::new(0);
        let parse = |raw: &[u8], uid: u32, name: &str| fake_parse(raw, uid, name);
        let stop_after_first = || calls.fetch_add(1, Ordering::SeqCst) == 0;
        let s = reconcile_mailbox(&v.db, &v.root.join("Maildir"), "a1", "INBOX", ON, &parse, &stop_after_first, &mut |_| {}).unwrap();
        assert!(s.interrupted);
        assert_eq!(s.parsed, BATCH);
        let n = AtomicUsize::new(0);
        let s2 = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!(s2.parsed, 20);
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
}
