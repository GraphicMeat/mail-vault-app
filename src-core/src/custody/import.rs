//! One-time move of the legacy per-mailbox JSON records into the store.
//! `local-index.json` is custody: imported, then the file is renamed
//! `.pre-db-<unix seconds>` so no build reads it again (never deleted).
//! `archived_headers.json` is a cache of parsed `.eml` rows: renamed the same
//! way, not imported (the search index serves those rows now).
//!
//! Idempotent by construction: a uid that already has a row is left alone
//! (the row was written by the newer app), a file that is not there is not
//! looked for, and a crash between the commit and the rename is repaired by
//! the next run.
//!
//! Split into units (`legacy_units` + `import_unit`) so the daemon can scan
//! the vault without the custody lock and then take it once per mailbox,
//! never once around the whole import. The header sidecars are *snapshotted*,
//! not retired — their JSON is still a live mirror — so a `meta` marker row
//! per imported mailbox is what stops start 2..N from re-walking them.

use super::entries::uid_of;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const LEGACY_INDEX: &str = "local-index.json";
pub const LEGACY_CACHE: &str = "archived_headers.json";
/// Directories whose contents are messages, never index files. On macOS
/// `maildir/` and `Maildir/` are one directory, so without this the walk
/// would descend into every `cur/` of the vault.
const MESSAGE_DIRS: [&str; 4] = ["cur", "new", "tmp", crate::maildir::ORPHAN_DIR];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    /// Index files found.
    pub files: usize,
    /// Entries written (uids the store did not have).
    pub imported: usize,
    /// Entries the store already had (the store wins).
    pub kept_existing: usize,
    pub skipped_no_uid: usize,
    pub renamed_caches: usize,
    pub imported_header_rows: usize,
    pub imported_mailbox_caches: usize,
    /// Mailboxes a previous run already imported (marker row present).
    pub skipped_imported: usize,
    /// Files left in place, with why: unparseable, wrong shape, or unrenamable.
    pub errors: Vec<(PathBuf, String)>,
}

/// One lockable piece of the import. Built by `legacy_units` from the
/// filesystem alone, so the scan needs no connection.
#[derive(Debug, PartialEq, Eq)]
pub enum ImportUnit {
    /// A `maildir/<account>/<mailbox>/local-index.json` (custody entries).
    /// An empty `mailbox` means the path had none: reported, not imported.
    Index { account: String, mailbox: String, path: PathBuf },
    /// A `Maildir/<account>/<mailbox>/archived_headers.json`: renamed only.
    RetireCache { path: PathBuf },
    /// A `mailboxes/<account>/mailboxes.json` folder-tree cache.
    MailboxList { account: String, path: PathBuf },
    /// One mailbox's header cache: its sidecar dir and its monolithic file.
    Headers { account: String, mailbox: String },
}

pub fn stamp_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Every legacy file worth a look, in the order they must be imported (a
/// mailbox list names the mailboxes whose headers follow it). Filesystem
/// only: no database, no lock, safe to run before the socket is up.
pub fn legacy_units(vault_root: &Path) -> Vec<ImportUnit> {
    let mut units = Vec::new();
    for (account, account_dir) in account_dirs(&vault_root.join("maildir")) {
        let mut files = Vec::new();
        collect_index_files(&account_dir, &mut files);
        for path in files {
            let mailbox = mailbox_path_of(&account_dir, &path).unwrap_or_default();
            units.push(ImportUnit::Index { account: account.clone(), mailbox, path });
        }
    }
    for (_, account_dir) in account_dirs(&vault_root.join("Maildir")) {
        let Ok(dirs) = std::fs::read_dir(&account_dir) else { continue };
        let mut caches: Vec<PathBuf> = dirs.flatten().map(|e| e.path().join(LEGACY_CACHE)).filter(|p| p.is_file()).collect();
        caches.sort();
        units.extend(caches.into_iter().map(|path| ImportUnit::RetireCache { path }));
    }
    for (account, account_dir) in account_dirs(&vault_root.join("mailboxes")) {
        let path = account_dir.join("mailboxes.json");
        if !path.is_file() {
            continue;
        }
        units.push(ImportUnit::MailboxList { account: account.clone(), path: path.clone() });
        // Unreadable or unparseable is reported when the unit runs; here it
        // only means there are no mailbox names to queue headers for.
        let Some(value) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let mut paths = Vec::new();
        mailbox_paths(&value, &mut paths);
        units.extend(paths.into_iter().map(|mailbox| ImportUnit::Headers { account: account.clone(), mailbox }));
    }
    units
}

/// Import one unit. Takes the connection for the length of this unit only.
pub fn import_unit(conn: &Connection, vault_root: &Path, unit: &ImportUnit, stamp: u64, report: &mut ImportReport) {
    match unit {
        ImportUnit::Index { account, mailbox, path } => {
            report.files += 1;
            if mailbox.is_empty() {
                report.errors.push((path.clone(), "no mailbox path".into()));
                return;
            }
            match import_file(conn, account, mailbox, path) {
                Ok((new, existing, no_uid)) => {
                    report.imported += new;
                    report.kept_existing += existing;
                    report.skipped_no_uid += no_uid;
                    if let Err(e) = retire(path, stamp) {
                        report.errors.push((path.clone(), format!("rename: {e}")));
                    }
                }
                Err(e) => report.errors.push((path.clone(), e)),
            }
        }
        ImportUnit::RetireCache { path } => match retire(path, stamp) {
            Ok(()) => report.renamed_caches += 1,
            Err(e) => report.errors.push((path.clone(), format!("rename: {e}"))),
        },
        ImportUnit::MailboxList { account, path } => import_mailbox_list(conn, account, path, stamp, report),
        ImportUnit::Headers { account, mailbox } => import_headers(conn, vault_root, account, mailbox, stamp, report),
    }
}

pub fn import_legacy(conn: &Connection, vault_root: &Path) -> ImportReport {
    let mut report = ImportReport::default();
    let stamp = stamp_now();
    for unit in legacy_units(vault_root) {
        import_unit(conn, vault_root, &unit, stamp, &mut report);
    }
    report
}

fn mailbox_paths(value: &Value, out: &mut Vec<String>) {
    let rows = value.get("mailboxes").and_then(Value::as_array).or_else(|| value.as_array());
    let Some(rows) = rows else { return };
    fn walk(rows: &[Value], out: &mut Vec<String>) {
        for row in rows {
            if let Some(path) = row.get("path").and_then(Value::as_str) { out.push(path.to_string()); }
            if let Some(children) = row.get("children").and_then(Value::as_array) { walk(children, out); }
        }
    }
    walk(rows, out);
}

fn import_mailbox_list(conn: &Connection, account: &str, file: &Path, stamp: u64, report: &mut ImportReport) {
    let text = match std::fs::read_to_string(file) {
        Ok(v) => v,
        Err(e) => { report.errors.push((file.to_path_buf(), format!("read: {e}"))); return; }
    };
    if let Err(e) = serde_json::from_str::<Value>(&text) {
        report.errors.push((file.to_path_buf(), format!("not JSON: {e}")));
        return;
    }
    match conn.execute("INSERT OR IGNORE INTO mailbox_cache(account_id,cache_json) VALUES (?1,?2)", params![account, text]) {
        Ok(n) => report.imported_mailbox_caches += n,
        Err(e) => { report.errors.push((file.to_path_buf(), e.to_string())); return; }
    }
    if let Some(parent) = file.parent() {
        if let Err(e) = snapshot_legacy(file, stamp, &snapshotted_bases(parent)) {
            report.errors.push((file.to_path_buf(), format!("snapshot: {e}")));
        }
    }
}

/// `meta` key marking one mailbox's header cache as imported. Written in the
/// same transaction as its rows, so a crash mid-import re-runs it.
fn headers_marker(account: &str, mailbox: &str) -> String {
    format!("imported_headers:{account}\u{1f}{mailbox}")
}

/// One mailbox's header cache — the sidecar directory and the monolithic
/// file — in a single transaction, then one snapshot per file. A marker row
/// makes every later start skip this mailbox without reading a byte: the
/// legacy JSON stays on disk as the live mirror `header_cache::save` keeps
/// writing, so "the files are still there" can never mean "not imported yet".
fn import_headers(conn: &Connection, root: &Path, account: &str, mailbox: &str, stamp: u64, report: &mut ImportReport) {
    let marker = headers_marker(account, mailbox);
    if super::db::meta_get(conn, &marker).is_some() {
        report.skipped_imported += 1;
        return;
    }
    let dir = crate::header_cache::sidecar_dir(root, account, mailbox);
    let monolith = root.join("email_cache").join(format!("{}.json", crate::header_cache::cache_base_name(account, mailbox)));
    if !dir.is_dir() && !monolith.is_file() {
        return; // nothing legacy here: no marker, so a later move-in still imports
    }
    let tx = match conn.unchecked_transaction() {
        Ok(v) => v,
        Err(e) => { report.errors.push((dir, e.to_string())); return; }
    };
    // (path, its directory's snapshot set) collected inside the transaction,
    // copied after it commits: file copies are not database work.
    let mut snapshots: Vec<PathBuf> = Vec::new();
    let mut rows = 0usize;
    let mut errors: Vec<(PathBuf, String)> = Vec::new();
    if dir.is_dir() {
        rows += import_header_dir(&tx, &dir, account, mailbox, &mut snapshots, &mut errors);
    }
    if monolith.is_file() {
        rows += import_monolithic_header_cache(&tx, &monolith, account, mailbox, &mut snapshots, &mut errors);
    }
    // Only a clean pass is marked done. A file that would not read or parse
    // stays reportable on every later start, the same retry semantics the
    // `local-index.json` path has ("still reported next time: nobody can miss
    // it in the log") — a marker over a partial import would seal the missing
    // rows out forever, with one warn line as the only trace.
    if errors.is_empty() {
        if let Err(e) = super::db::meta_set(&tx, &marker, "1") {
            errors.push((dir.clone(), format!("marker: {e}")));
        }
    }
    match tx.commit() {
        Ok(()) => {
            report.imported_header_rows += rows;
            report.errors.append(&mut errors);
            // At most two directories (the sidecar dir and `email_cache`),
            // each listed once however many files came from it.
            let mut bases: std::collections::HashMap<PathBuf, HashSet<String>> = std::collections::HashMap::new();
            for path in snapshots {
                let Some(parent) = path.parent().map(Path::to_path_buf) else { continue };
                let already = bases.entry(parent.clone()).or_insert_with(|| snapshotted_bases(&parent));
                if let Err(e) = snapshot_legacy(&path, stamp, already) {
                    report.errors.push((path, format!("snapshot: {e}")));
                }
            }
        }
        Err(e) => report.errors.push((dir, e.to_string())),
    }
}

fn sort_key(row: &Value, uid: u32) -> i64 {
    ["internalDate", "date"]
        .iter()
        .filter_map(|k| row.get(*k).and_then(Value::as_str))
        .find_map(|s| chrono::DateTime::parse_from_rfc3339(s).or_else(|_| chrono::DateTime::parse_from_rfc2822(s)).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(i64::MIN + i64::from(uid))
}

fn import_monolithic_header_cache(
    tx: &Connection,
    path: &Path,
    account: &str,
    mailbox: &str,
    snapshots: &mut Vec<PathBuf>,
    errors: &mut Vec<(PathBuf, String)>,
) -> usize {
    let text = match std::fs::read_to_string(path) {
        Ok(v) => v,
        Err(e) => { errors.push((path.to_path_buf(), e.to_string())); return 0; }
    };
    let value: Value = match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => v,
        Ok(_) => { errors.push((path.to_path_buf(), "cache JSON is not an object".into())); return 0; }
        Err(e) => { errors.push((path.to_path_buf(), e.to_string())); return 0; }
    };
    let mut meta = value.clone();
    if let Some(map) = meta.as_object_mut() {
        map.remove("emails");
        map.remove("removedUids");
    }
    let result = (|| -> Result<usize, String> {
        tx.execute(
            "INSERT OR IGNORE INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES (?1,?2,?3)",
            params![account, mailbox, serde_json::to_string(&meta).map_err(|e| e.to_string())?],
        ).map_err(|e| e.to_string())?;
        let mut imported = 0;
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,0,?5)"
        ).map_err(|e| e.to_string())?;
        for row in value.get("emails").and_then(Value::as_array).into_iter().flatten() {
            let Some(uid) = row.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
            imported += stmt.execute(params![account, mailbox, uid, sort_key(row, uid), serde_json::to_string(row).map_err(|e| e.to_string())?])
                .map_err(|e| e.to_string())?;
        }
        Ok(imported)
    })();
    match result {
        Ok(n) => {
            snapshots.push(path.to_path_buf());
            n
        }
        Err(e) => { errors.push((path.to_path_buf(), e)); 0 }
    }
}

fn import_header_dir(
    tx: &Connection,
    dir: &Path,
    account: &str,
    mailbox: &str,
    snapshots: &mut Vec<PathBuf>,
    errors: &mut Vec<(PathBuf, String)>,
) -> usize {
    let meta = dir.join("_meta.json");
    if meta.is_file() {
        match std::fs::read_to_string(&meta).and_then(|s| {
            serde_json::from_str::<Value>(&s).map_err(std::io::Error::other)?;
            tx.execute("INSERT OR IGNORE INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES (?1,?2,?3)", params![account,mailbox,s])
                .map_err(std::io::Error::other)?;
            Ok(())
        }) {
            Ok(()) => snapshots.push(meta),
            Err(e) => errors.push((meta, e.to_string())),
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut imported = 0;
    let mut stmt = match tx.prepare_cached(
        "INSERT OR IGNORE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES (?1,?2,?3,?4,?5,?6)"
    ) {
        Ok(v) => v,
        Err(e) => { errors.push((dir.to_path_buf(), e.to_string())); return 0; }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(uid) = crate::header_cache::is_header_file(&name) else { continue };
        let text = match std::fs::read_to_string(&path) { Ok(v) => v, Err(e) => { errors.push((path, e.to_string())); continue; } };
        let row: Value = match serde_json::from_str(&text) { Ok(v) => v, Err(e) => { errors.push((path, e.to_string())); continue; } };
        match stmt.execute(params![account, mailbox, uid, sort_key(&row, uid), 0, text]) {
            Ok(n) => { imported += n; snapshots.push(path); }
            Err(e) => errors.push((path, e.to_string())),
        }
    }
    imported
}

/// Parse one bare-array file and upsert its entries, keeping any row the
/// store already has. Commits; does not rename (`import_legacy` does).
pub fn import_file(conn: &Connection, account_id: &str, mailbox: &str, path: &Path) -> Result<(usize, usize, usize), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    let entries: Vec<Value> = serde_json::from_str(&text).map_err(|e| format!("not a JSON array: {e}"))?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (mut new, mut existing, mut no_uid) = (0, 0, 0);
    {
        let mut stmt = tx
            .prepare_cached("INSERT OR IGNORE INTO vault_entries(account_id, mailbox_path, uid, entry_json) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;
        for entry in &entries {
            let Some(uid) = uid_of(entry) else {
                no_uid += 1;
                continue;
            };
            let json = serde_json::to_string(entry).map_err(|e| e.to_string())?;
            match stmt.execute(params![account_id, mailbox, uid, json]).map_err(|e| e.to_string())? {
                0 => existing += 1,
                _ => new += 1,
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((new, existing, no_uid))
}

/// `<account dir>/<raw mailbox path>/local-index.json` → the raw path with
/// `/` between components, whatever the platform's separator.
pub fn mailbox_path_of(account_dir: &Path, index_file: &Path) -> Option<String> {
    let rel = index_file.parent()?.strip_prefix(account_dir).ok()?;
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// `(name, path)` of every directory directly under `root`; nothing when
/// `root` is not there.
fn account_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    // `file_type()` does not follow the link: a symlinked account directory is
    // not ours to walk, and one pointing at an ancestor would never end.
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    out.sort();
    out
}

/// A symlink is never followed, neither as a directory nor as an index file:
/// one pointing at an ancestor would walk until the stack goes, and this runs
/// at startup where `panic = "abort"` makes that unrecoverable. The type comes
/// from the directory entry, which does not follow the link the way
/// `Path::is_dir` does.
fn collect_index_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<(PathBuf, bool)> = entries
        .flatten()
        .filter_map(|e| e.file_type().ok().filter(|t| !t.is_symlink()).map(|t| (e.path(), t.is_dir())))
        .collect();
    paths.sort();
    for (path, is_dir) in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if is_dir {
            if !MESSAGE_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                collect_index_files(&path, out);
            }
        } else if name == LEGACY_INDEX {
            out.push(path);
        }
    }
}

/// `<name>` → `<name>.pre-db-<stamp>` (a suffix, so nothing ever reads it as
/// the record again); `-<n>` appended if that name is somehow taken.
///
/// `rename` replaces its destination without a word, and this is the one path
/// here that could destroy a retired file, so the name has to be free by
/// `symlink_metadata` (`exists()` says false for a broken symlink and for
/// anything it cannot stat).
fn retire(path: &Path, stamp: u64) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("no file name")?;
    let mut target = path.with_file_name(format!("{name}.pre-db-{stamp}"));
    let mut n = 1;
    while target.symlink_metadata().is_ok() {
        target = path.with_file_name(format!("{name}.pre-db-{stamp}-{n}"));
        n += 1;
    }
    std::fs::rename(path, &target).map_err(|e| e.to_string())
}

/// Base names in `dir` that already have a `<base>.pre-db-*` copy. Listed
/// once per directory: the per-file listing this replaces made a 30k-entry
/// sidecar directory O(n^2) and was half of the 416 s startup import.
fn snapshotted_bases(dir: &Path) -> HashSet<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return HashSet::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.find(".pre-db-").map(|at| name[..at].to_string())
        })
        .collect()
}

/// Cache JSON remains as a compatibility mirror for readers not moved yet.
/// Keep one byte-for-byte pre-DB snapshot, then let SQLite be authoritative.
fn snapshot_legacy(path: &Path, stamp: u64, already: &HashSet<String>) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("no file name")?;
    if already.contains(&name) {
        return Ok(());
    }
    std::fs::copy(path, path.with_file_name(format!("{name}.pre-db-{stamp}")))
        .map(|_| ()).map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::{db::open, entries};
    use serde_json::{json, Value};
    use std::fs;

    fn entry_7() -> Value {
        json!({"uid": 7, "subject": "s", "from": {"address": "a@x.test", "name": "A"}, "to": [], "date": "Tue, 08 Sep 2026 23:00:00 +0000",
               "flags": ["\\Seen"], "source": "local", "serverDeleted": true, "has_attachments": false, "message_id": "<m7@x.test>",
               "in_reply_to": null, "references": ["<r@x.test>"], "snippet": "hello", "_external_copy_failed": true})
    }
    fn entry_9() -> Value {
        json!({"uid": 9, "source": "local_sent", "serverAbsent": true, "serverAbsentAt": "2026-09-10T00:00:00Z", "flags": []})
    }
    fn entry_11() -> Value {
        json!({"uid": 11, "source": "local_draft", "flags": ["draft", "seen"], "inReplyTo": "<x@y>", "references": ["<a@b>"]})
    }

    fn write(root: &Path, rel: &str, body: &str) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, body).unwrap();
        p
    }

    /// The vault as every build before this one left it.
    fn legacy_vault() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        write(r, "maildir/acct-a/INBOX/local-index.json", &json!([entry_7(), entry_9(), entry_11()]).to_string());
        write(r, "maildir/acct-a/Projects/2026/local-index.json", &json!([{"uid": 3, "source": "local"}]).to_string());
        write(r, "maildir/acct-b/INBOX/local-index.json", &json!([{"uid": 7, "source": "local"}]).to_string());
        // Decoys: a message directory is never walked, a leftover tmp file is not an index.
        write(r, "maildir/acct-a/INBOX/cur/local-index.json", &json!([{"uid": 999, "source": "local"}]).to_string());
        write(r, "maildir/acct-a/INBOX/local-index.json.tmp", "[]");
        write(r, "Maildir/acct-a/INBOX/cur/7:2,AS.eml", "From: a@x.test\r\n\r\nbody");
        write(r, "Maildir/acct-a/INBOX/archived_headers.json", &json!({"uid_count": 1, "emails": []}).to_string());
        tmp
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    fn by_uid(conn: &Connection, account: &str, mailbox: &str) -> Vec<Value> {
        let s = entries::read(conn, account, mailbox).unwrap().unwrap_or_else(|| "[]".into());
        let mut v: Vec<Value> = serde_json::from_str(&s).unwrap();
        v.sort_by_key(|e| e["uid"].as_u64());
        v
    }

    #[test]
    fn imports_every_file_losslessly_with_raw_nested_paths() {
        let tmp = legacy_vault();
        let conn = open(tmp.path()).unwrap();
        let report = import_legacy(&conn, tmp.path());
        assert_eq!(report.errors, vec![]);
        assert_eq!((report.files, report.imported, report.kept_existing, report.skipped_no_uid, report.renamed_caches), (3, 5, 0, 0, 1));
        assert_eq!(by_uid(&conn, "acct-a", "INBOX"), vec![entry_7(), entry_9(), entry_11()]);
        assert_eq!(by_uid(&conn, "acct-a", "Projects/2026"), vec![json!({"uid": 3, "source": "local"})]);
        assert_eq!(by_uid(&conn, "acct-b", "INBOX"), vec![json!({"uid": 7, "source": "local"})]);
        assert!(by_uid(&conn, "acct-a", "INBOX").iter().all(|e| e["uid"] != 999), "cur/ was walked");
        assert_eq!(entries::read(&conn, "acct-a", "INBOX/cur").unwrap(), None);
    }

    #[test]
    fn renames_each_file_and_keeps_its_bytes() {
        let tmp = legacy_vault();
        let original = fs::read(tmp.path().join("maildir/acct-a/INBOX/local-index.json")).unwrap();
        let conn = open(tmp.path()).unwrap();
        import_legacy(&conn, tmp.path());
        let inbox = tmp.path().join("maildir/acct-a/INBOX");
        let retired: Vec<String> = names(&inbox).into_iter().filter(|n| n.starts_with("local-index.json.pre-db-")).collect();
        assert_eq!(retired.len(), 1, "{:?}", names(&inbox));
        assert!(!inbox.join("local-index.json").exists());
        assert_eq!(fs::read(inbox.join(&retired[0])).unwrap(), original);
        assert!(inbox.join("local-index.json.tmp").exists(), "not ours to touch");
        assert!(inbox.join("cur/local-index.json").exists(), "a message directory is never walked");
        let nested = tmp.path().join("maildir/acct-a/Projects/2026");
        assert!(names(&nested).iter().any(|n| n.starts_with("local-index.json.pre-db-")));
        let maildir_inbox = tmp.path().join("Maildir/acct-a/INBOX");
        assert!(!maildir_inbox.join("archived_headers.json").exists());
        assert!(names(&maildir_inbox).iter().any(|n| n.starts_with("archived_headers.json.pre-db-")));
    }

    #[test]
    fn a_second_run_is_a_no_op() {
        let tmp = legacy_vault();
        let conn = open(tmp.path()).unwrap();
        import_legacy(&conn, tmp.path());
        let before = by_uid(&conn, "acct-a", "INBOX");
        assert_eq!(import_legacy(&conn, tmp.path()), ImportReport::default());
        assert_eq!(by_uid(&conn, "acct-a", "INBOX"), before);
    }

    #[test]
    fn a_row_already_in_the_store_wins_over_the_file() {
        let tmp = legacy_vault();
        let conn = open(tmp.path()).unwrap();
        let newer = json!({"uid": 7, "source": "local", "serverDeleted": false, "probe": "written by the newer app"});
        entries::upsert(&conn, "acct-a", "INBOX", &[newer.clone()]).unwrap();
        let report = import_legacy(&conn, tmp.path());
        assert_eq!((report.imported, report.kept_existing), (4, 1));
        assert_eq!(by_uid(&conn, "acct-a", "INBOX"), vec![newer, entry_9(), entry_11()]);
    }

    #[test]
    fn a_crash_between_commit_and_rename_is_repaired_by_the_next_run() {
        let tmp = legacy_vault();
        let conn = open(tmp.path()).unwrap();
        let file = tmp.path().join("maildir/acct-a/INBOX/local-index.json");
        // The commit landed, the process died before the rename.
        assert_eq!(import_file(&conn, "acct-a", "INBOX", &file).unwrap(), (3, 0, 0));
        assert!(file.exists());
        let report = import_legacy(&conn, tmp.path());
        assert_eq!(report.errors, vec![]);
        assert_eq!(report.kept_existing, 3, "the rows were already there");
        assert!(!file.exists(), "renamed on the second run");
        assert_eq!(by_uid(&conn, "acct-a", "INBOX"), vec![entry_7(), entry_9(), entry_11()]);
    }

    #[test]
    fn an_unparseable_file_is_left_in_place_and_the_rest_continues() {
        let tmp = legacy_vault();
        let bad = write(tmp.path(), "maildir/acct-b/INBOX/local-index.json", "{not json");
        let conn = open(tmp.path()).unwrap();
        let report = import_legacy(&conn, tmp.path());
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, bad);
        assert!(bad.exists());
        assert_eq!(fs::read_to_string(&bad).unwrap(), "{not json");
        assert_eq!(by_uid(&conn, "acct-a", "INBOX").len(), 3, "the other account still imported");
        assert_eq!(entries::read(&conn, "acct-b", "INBOX").unwrap(), None);
        // Still reported next time: nobody can miss it in the log.
        assert_eq!(import_legacy(&conn, tmp.path()).errors.len(), 1);
        // A JSON object is the wrong shape too: the file is a bare array.
        fs::write(&bad, "{\"emails\":[]}").unwrap();
        assert_eq!(import_legacy(&conn, tmp.path()).errors.len(), 1);
        assert!(bad.exists());
    }

    #[test]
    fn mailbox_path_of_joins_components_with_slashes() {
        let acct = Path::new("/v/maildir/acct-a");
        assert_eq!(mailbox_path_of(acct, Path::new("/v/maildir/acct-a/Projects/2026/local-index.json")).as_deref(), Some("Projects/2026"));
        assert_eq!(mailbox_path_of(acct, Path::new("/v/maildir/acct-a/INBOX/local-index.json")).as_deref(), Some("INBOX"));
        assert_eq!(mailbox_path_of(acct, Path::new("/v/maildir/acct-a/local-index.json")), None, "no mailbox");
        assert_eq!(mailbox_path_of(acct, Path::new("/elsewhere/local-index.json")), None);
    }

    #[test]
    fn a_vault_without_legacy_files_reports_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        assert_eq!(import_legacy(&conn, tmp.path()), ImportReport::default());
    }

    #[test]
    fn imports_mailbox_and_header_caches_then_retires_only_successful_json() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "mailboxes/acct/mailboxes.json", &json!({
            "mailboxes": [{"path":"INBOX"}, {"path":"Projects","children":[{"path":"Projects/2026"}]}],
            "fetchedAt": 123
        }).to_string());
        let inbox = crate::header_cache::sidecar_dir(root, "acct", "INBOX");
        write(&inbox, "_meta.json", &json!({"totalEmails":2,"uidValidity":9}).to_string());
        write(&inbox, "1.json", &json!({"uid":1,"subject":"one","date":"2026-09-19T00:00:00Z"}).to_string());
        write(&inbox, "2.json", "{broken");

        let conn = open(root).unwrap();
        let report = import_legacy(&conn, root);
        assert_eq!(report.imported_header_rows, 1);
        assert!(super::super::cache::load_mailboxes(&conn, "acct").unwrap().unwrap().contains("INBOX"));
        let rows = super::super::cache::load_by_uids(&conn, "acct", "INBOX", &[1]).unwrap();
        assert_eq!(rows[0]["subject"], "one");
        assert!(root.join("mailboxes/acct/mailboxes.json").exists());
        assert!(inbox.join("1.json").exists());
        assert!(inbox.join("2.json").exists(), "malformed cache must remain recoverable");
    }


    /// The 2026-09-20 field report: a vault whose sidecar caches are still on
    /// disk re-walked, re-read and re-inserted all 66k of them on EVERY start
    /// (the originals are snapshotted, never retired), and the daemon awaited
    /// that before opening its socket — 416 s with no mail and no helper. One
    /// marker row per imported mailbox is what makes start 2..N free.
    #[test]
    fn a_second_run_skips_a_mailbox_it_already_imported() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "mailboxes/acct/mailboxes.json", &json!({"mailboxes": [{"path":"INBOX"}]}).to_string());
        let inbox = crate::header_cache::sidecar_dir(root, "acct", "INBOX");
        write(&inbox, "1.json", &json!({"uid":1,"subject":"one","date":"2026-09-19T00:00:00Z"}).to_string());
        let conn = open(root).unwrap();
        assert_eq!(import_legacy(&conn, root).imported_header_rows, 1);

        // A file written after the import must not make the next start walk it again.
        write(&inbox, "2.json", &json!({"uid":2,"subject":"two"}).to_string());
        let second = import_legacy(&conn, root);
        assert_eq!(second.imported_header_rows, 0, "an imported mailbox is never read again");
        assert_eq!(second.skipped_imported, 1);
        assert_eq!(second.errors, vec![]);
    }

    /// Scanning is pure filesystem work: the daemon runs it before it takes
    /// the custody lock, then locks once per unit (`handlers::common`'s
    /// per-mailbox-batch rule), so a long import never blocks a mail read.
    #[test]
    fn legacy_units_names_the_work_without_a_connection() {
        let tmp = legacy_vault();
        let root = tmp.path();
        write(root, "mailboxes/acct/mailboxes.json", &json!({"mailboxes": [{"path":"INBOX"}]}).to_string());
        let units = legacy_units(root);
        assert!(units.iter().any(|u| matches!(u, ImportUnit::Index { mailbox, .. } if mailbox == "INBOX")));
        assert!(units.iter().any(|u| matches!(u, ImportUnit::RetireCache { .. })));
        assert!(units.iter().any(|u| matches!(u, ImportUnit::MailboxList { account, .. } if account == "acct")));
        assert!(units.iter().any(|u| matches!(u, ImportUnit::Headers { account, mailbox } if account == "acct" && mailbox == "INBOX")));
        let list = units.iter().position(|u| matches!(u, ImportUnit::MailboxList { .. })).unwrap();
        let headers = units.iter().position(|u| matches!(u, ImportUnit::Headers { .. })).unwrap();
        assert!(list < headers, "the mailbox list names the mailboxes whose headers follow");
    }

    #[test]
    fn one_unit_imports_only_its_own_mailbox() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "mailboxes/acct/mailboxes.json", &json!({"mailboxes": [{"path":"INBOX"},{"path":"Sent"}]}).to_string());
        write(&crate::header_cache::sidecar_dir(root, "acct", "INBOX"), "1.json", &json!({"uid":1,"subject":"in"}).to_string());
        write(&crate::header_cache::sidecar_dir(root, "acct", "Sent"), "2.json", &json!({"uid":2,"subject":"out"}).to_string());
        let conn = open(root).unwrap();
        let mut report = ImportReport::default();
        let unit = ImportUnit::Headers { account: "acct".into(), mailbox: "INBOX".into() };
        import_unit(&conn, root, &unit, 42, &mut report);
        assert_eq!(report.imported_header_rows, 1);
        assert_eq!(super::super::cache::load_by_uids(&conn, "acct", "INBOX", &[1]).unwrap().len(), 1);
        assert!(super::super::cache::load_by_uids(&conn, "acct", "Sent", &[2]).unwrap().is_empty(), "another mailbox's unit did not run");
    }

    /// One snapshot per file, and the check for it must not re-list the
    /// directory per file: a 30k-entry sidecar dir made that O(n^2).
    #[test]
    fn a_snapshotted_header_file_is_not_copied_again_under_a_new_stamp() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "mailboxes/acct/mailboxes.json", &json!({"mailboxes": [{"path":"INBOX"}]}).to_string());
        let inbox = crate::header_cache::sidecar_dir(root, "acct", "INBOX");
        write(&inbox, "1.json", &json!({"uid":1,"subject":"one"}).to_string());
        let conn = open(root).unwrap();
        let mut report = ImportReport::default();
        let unit = ImportUnit::Headers { account: "acct".into(), mailbox: "INBOX".into() };
        import_unit(&conn, root, &unit, 42, &mut report);
        let mut second = ImportReport::default();
        import_unit(&conn, root, &unit, 43, &mut second);
        let copies = names(&inbox).into_iter().filter(|n| n.contains(".pre-db-")).count();
        assert_eq!(copies, 1, "{:?}", names(&inbox));
    }

    #[test]
    fn a_mailbox_with_an_unreadable_header_file_is_retried_next_start() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "mailboxes/acct/mailboxes.json", &json!({"mailboxes": [{"path":"INBOX"}]}).to_string());
        let inbox = crate::header_cache::sidecar_dir(root, "acct", "INBOX");
        write(&inbox, "1.json", &json!({"uid":1,"subject":"one"}).to_string());
        write(&inbox, "2.json", "{broken");
        let conn = open(root).unwrap();
        assert_eq!(import_legacy(&conn, root).errors.len(), 1);

        let second = import_legacy(&conn, root);
        assert_eq!(second.skipped_imported, 0, "a partial import is never marked done");
        assert_eq!(second.errors.len(), 1, "and its bad file is still reported");

        // Repaired: the pass is clean, so the marker lands and the next start skips it.
        write(&inbox, "2.json", &json!({"uid":2,"subject":"two"}).to_string());
        assert_eq!(import_legacy(&conn, root).imported_header_rows, 1);
        assert_eq!(import_legacy(&conn, root).skipped_imported, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_loop_under_the_account_dir_does_not_recurse() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        write(r, "maildir/acct-a/INBOX/local-index.json", &json!([entry_7()]).to_string());
        std::os::unix::fs::symlink(r.join("maildir/acct-a"), r.join("maildir/acct-a/loop")).unwrap();
        let conn = open(r).unwrap();
        let report = import_legacy(&conn, r);
        assert_eq!(report.errors, vec![]);
        assert_eq!(report.files, 1, "the walk followed the symlink");
        assert_eq!(by_uid(&conn, "acct-a", "INBOX"), vec![entry_7()]);
    }

    #[cfg(unix)]
    #[test]
    fn retire_never_replaces_an_existing_retired_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write(tmp.path(), "maildir/acct-a/INBOX/local-index.json", "[]");
        let dir = path.parent().unwrap();
        // A retired file this run must not destroy. Broken on purpose: `exists()`
        // says false for it, `symlink_metadata()` does not.
        let taken = dir.join("local-index.json.pre-db-42");
        std::os::unix::fs::symlink(dir.join("gone"), &taken).unwrap();
        retire(&path, 42).unwrap();
        assert!(taken.symlink_metadata().is_ok(), "the retired file was replaced");
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(dir.join("local-index.json.pre-db-42-1")).unwrap(), "[]");
    }
}
