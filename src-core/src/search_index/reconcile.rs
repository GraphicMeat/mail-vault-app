//! Reconcile vault .eml files into the index. Spec §6.3.
//!
//! Lock discipline: files are listed and parsed WITHOUT the `SharedConn`
//! guard. The guard is held only to read one mailbox's rows, to apply its
//! removals and renames, and to commit each batch. `keep_going` and
//! `progress` are always called with no guard held: the app's callbacks lock
//! the same mutex.

use super::db::meta_set;
use super::text::{cap_chars, cjk_units};
use super::{lock, SharedConn};
use crate::maildir::{uid_file_map, vault_filename_uid};
use rusqlite::{params, Connection};
use std::collections::HashMap;
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
/// unparseable (recorded) or unreadable (left for the next sweep).
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
/// no `cur`.
pub fn list_vault_dirs(maildir_root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for account in subdirs(maildir_root) {
        let account_path = maildir_root.join(&account);
        for dir in subdirs(&account_path) {
            if account_path.join(&dir).join("cur").is_dir() {
                out.push((account.clone(), dir));
            }
        }
    }
    out
}

fn subdirs(path: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(path) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// Vault rows on disk, one per uid per folder (same rule as the listing).
pub fn count_disk_files(maildir_root: &Path) -> u64 {
    list_vault_dirs(maildir_root)
        .iter()
        .map(|(a, d)| uid_file_map(&maildir_root.join(a).join(d).join("cur")).len() as u64)
        .sum()
}

/// `<uid>:` files in `cur`, first entry per uid wins. A missing directory is
/// empty; `None` when it exists but cannot be read, so the caller never
/// mistakes an unreadable folder for "every message deleted".
fn list_cur(cur: &Path) -> Option<HashMap<u32, DiskFile>> {
    let entries = match std::fs::read_dir(cur) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(HashMap::new()),
        Err(_) => return None,
    };
    let mut files = HashMap::new();
    for entry in entries.flatten() {
        let filename = entry.file_name().to_string_lossy().into_owned();
        let Some(uid) = vault_filename_uid(&filename) else { continue };
        // ponytail: a file renamed away between read_dir and stat drops out; its row is removed and re-added next sweep.
        let Ok(meta) = entry.metadata() else { continue };
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos() as i64);
        let size = i64::try_from(meta.len()).unwrap_or(i64::MAX);
        files.entry(uid).or_insert(DiskFile { uid, filename, size, mtime_ns });
    }
    Some(files)
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
    // Unreadable folder: leave its rows alone, the next sweep retries.
    let Some(files) = list_cur(&cur) else { return Ok(stats) };

    let rows = {
        let guard = lock(db);
        let conn = guard.as_ref().ok_or_else(closed)?;
        load_rows(conn, account_id, vault_dir).map_err(db_err)?
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
    let removals: Vec<i64> = rows.iter().filter(|(uid, _)| !files.contains_key(uid)).map(|(_, r)| r.id).collect();

    if !removals.is_empty() || !renames.is_empty() {
        let mut guard = lock(db);
        let conn = guard.as_mut().ok_or_else(closed)?;
        apply_removals_and_renames(conn, &removals, &renames).map_err(db_err)?;
    }
    stats.removed = removals.len();
    stats.renamed = renames.len();

    // Highest uids first: the newest mail becomes searchable soonest.
    to_parse.sort_unstable_by(|a, b| b.uid.cmp(&a.uid));
    for batch in to_parse.chunks(BATCH) {
        if !keep_going() {
            stats.interrupted = true;
            break;
        }
        let mut docs = Vec::with_capacity(batch.len());
        for &file in batch {
            // ponytail: unreadable now (renamed or deleted since the listing) = left for the next sweep, never recorded.
            let Ok(raw) = std::fs::read(cur.join(&file.filename)) else {
                stats.failed += 1;
                continue;
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
            let conn = guard.as_mut().ok_or_else(closed)?;
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

fn apply_removals_and_renames(conn: &mut Connection, removals: &[i64], renames: &[(i64, &str)]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for &id in removals {
        delete_fts(&tx, id)?;
        tx.prepare_cached("DELETE FROM messages WHERE id = ?1")?.execute([id])?;
    }
    for &(id, filename) in renames {
        tx.prepare_cached("UPDATE messages SET filename = ?1 WHERE id = ?2")?.execute(params![filename, id])?;
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
    tx.prepare_cached("INSERT OR REPLACE INTO mailbox_scan VALUES (?1, ?2, unixepoch())")?
        .execute(params![account_id, vault_dir])?;
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
    let indexed: Vec<(String, String)> = tx
        .prepare("SELECT DISTINCT account_id, vault_dir FROM messages")?
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
/// and addresses from `messages`), then the index file is compacted so the
/// body tokens leave the disk. On: disabled rows become pending and the next
/// sweep re-parses them.
pub fn set_bodies_enabled(db: &SharedConn, enabled: bool) -> Result<(), String> {
    let mut guard = lock(db);
    let conn = guard.as_mut().ok_or_else(closed)?;
    let tx = conn.transaction().map_err(db_err)?;
    if enabled {
        tx.execute("UPDATE messages SET body_state = ?1 WHERE body_state = ?2", [BODY_PENDING, BODY_DISABLED])
            .map_err(db_err)?;
    } else {
        strip_bodies(&tx).map_err(db_err)?;
    }
    // Same transaction as the rows: the worker compares this flag to decide whether to toggle.
    meta_set(&tx, "bodies_enabled", if enabled { "1" } else { "0" })?;
    tx.commit().map_err(db_err)?;
    if !enabled {
        conn.execute_batch(
            "INSERT INTO msg_fts(msg_fts) VALUES('optimize'); INSERT INTO msg_cjk(msg_cjk) VALUES('optimize'); VACUUM;",
        )
        .map_err(db_err)?;
    }
    Ok(())
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
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("Old subject", "old words"));
        put(&v, "a1", "INBOX", "2:2,.eml", &eml("Goner", "vanishing"));
        let n = AtomicUsize::new(0);
        run(&v, "a1", "INBOX", ON, &n);
        put(&v, "a1", "INBOX", "1:2,.eml", &eml("New subject", "brand new longer words here"));
        std::fs::remove_file(v.root.join("Maildir/a1/INBOX/cur/2:2,.eml")).unwrap();
        let s = run(&v, "a1", "INBOX", ON, &n);
        assert_eq!((s.parsed, s.removed), (1, 1));
        assert!(fts_hits(&v, "\"old words\"").is_empty());
        assert_eq!(fts_hits(&v, "\"brand new\"").len(), 1);
        assert!(fts_hits(&v, "\"vanishing\"").is_empty());
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
        for (a, d) in list_vault_dirs(&v.root.join("Maildir")) { run(&v, &a, &d, ON, &n); }
        let mut dirs = list_vault_dirs(&v.root.join("Maildir"));
        dirs.sort();
        assert_eq!(dirs, vec![("a1".into(), "INBOX".into()), ("a2".into(), "INBOX".into()), ("a2".into(), "Projects_2026".into())]);
        assert_eq!(count_disk_files(&v.root.join("Maildir")), 3);
        std::fs::remove_dir_all(v.root.join("Maildir/a2/Projects_2026")).unwrap();
        let removed = prune_missing_dirs(&v.db, &list_vault_dirs(&v.root.join("Maildir"))).unwrap();
        assert_eq!(removed, 1);
        assert!(fts_hits(&v, "\"gamma\"").is_empty());
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
}
