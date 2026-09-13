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

use super::entries::uid_of;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const LEGACY_INDEX: &str = "local-index.json";
pub const LEGACY_CACHE: &str = "archived_headers.json";
/// Directories whose contents are messages, never index files. On macOS
/// `maildir/` and `Maildir/` are one directory, so without this the walk
/// would descend into every `cur/` of the vault.
const MESSAGE_DIRS: [&str; 4] = ["cur", "new", "tmp", "orphaned"];

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
    /// Files left in place, with why: unparseable, wrong shape, or unrenamable.
    pub errors: Vec<(PathBuf, String)>,
}

pub fn import_legacy(conn: &Connection, vault_root: &Path) -> ImportReport {
    let mut report = ImportReport::default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for (account, account_dir) in account_dirs(&vault_root.join("maildir")) {
        let mut files = Vec::new();
        collect_index_files(&account_dir, &mut files);
        for path in files {
            report.files += 1;
            let Some(mailbox) = mailbox_path_of(&account_dir, &path) else {
                report.errors.push((path, "no mailbox path".into()));
                continue;
            };
            match import_file(conn, &account, &mailbox, &path) {
                Ok((new, existing, no_uid)) => {
                    report.imported += new;
                    report.kept_existing += existing;
                    report.skipped_no_uid += no_uid;
                    if let Err(e) = retire(&path, stamp) {
                        report.errors.push((path, format!("rename: {e}")));
                    }
                }
                Err(e) => report.errors.push((path, e)),
            }
        }
    }
    for (_, account_dir) in account_dirs(&vault_root.join("Maildir")) {
        let Ok(dirs) = std::fs::read_dir(&account_dir) else { continue };
        for entry in dirs.flatten() {
            let cache = entry.path().join(LEGACY_CACHE);
            if cache.is_file() {
                match retire(&cache, stamp) {
                    Ok(()) => report.renamed_caches += 1,
                    Err(e) => report.errors.push((cache, format!("rename: {e}"))),
                }
            }
        }
    }
    report
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
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    out.sort();
    out
}

fn collect_index_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if path.is_dir() {
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
fn retire(path: &Path, stamp: u64) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("no file name")?;
    let mut target = path.with_file_name(format!("{name}.pre-db-{stamp}"));
    let mut n = 1;
    while target.exists() {
        target = path.with_file_name(format!("{name}.pre-db-{stamp}-{n}"));
        n += 1;
    }
    std::fs::rename(path, &target).map_err(|e| e.to_string())
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
}
