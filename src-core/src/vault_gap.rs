//! Phase 5: which messages the header cache lists that the vault holds no
//! full copy of. The daemon (`src-daemon/src/vault_gap.rs`) reads the header
//! cache a page at a time (`custody::cache::uid_dates_after`, `dated_page`)
//! and a vault folder's uids from its directory (`held_uids`), and walks the
//! two here (`Gap`).

use crate::custody::Connection;
use crate::maildir::{vault_filename_uid, IMPORT_UID_BASE};
use rusqlite::params;
use std::path::Path;

/// The uids a vault folder's `cur/` holds, ascending: one names-only listing
/// that takes no lock. (The vault registry's listing stats every file and
/// holds its locks for the whole folder, and opening a message waits on
/// those.) A regular file named `<uid>:2,...` is a copy; a symlink, a
/// directory, a dot-prefixed temp name (`vault_filename_uid` refuses it) or
/// any other name is not. No `cur/` under a vault root that is there is an
/// empty folder; a root that is gone, or a listing that fails at any point,
/// is `None`: unknown, never empty.
pub fn held_uids(root: &Path, cur: &Path) -> Option<Vec<u32>> {
    let entries = match std::fs::read_dir(cur) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && root.is_dir() => return Some(Vec::new()),
        Err(_) => return None,
    };
    let mut uids = Vec::new();
    for entry in entries {
        // An error part way ends the listing: a shorter folder it is not.
        let entry = entry.ok()?;
        // The type comes with the listing on most file systems. Where it
        // needs a stat and that fails (a flag rename in between), the name
        // still says a copy was there.
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(true) {
            continue;
        }
        if let Some(uid) = vault_filename_uid(&entry.file_name().to_string_lossy()) {
            uids.push(uid);
        }
    }
    uids.sort_unstable();
    uids.dedup();
    Some(uids)
}

/// Up to `limit` of `mailbox`'s cached uids after `after`, ascending, each
/// with the two dates the download gate judges a message by
/// (`handlers::imap::email_date_ms`): its Date header (`messageDate`, else
/// `date`: a Graph row's `date` is when it arrived, its `messageDate` what the
/// sender wrote) and its INTERNALDATE. Each row's JSON is read inside SQLite,
/// one page per unit of the caller's lock.
pub fn dated_page(
    conn: &Connection,
    account: &str,
    mailbox: &str,
    after: Option<u32>,
    limit: usize,
) -> Result<Vec<(u32, Option<String>, Option<String>)>, String> {
    let text = |v: rusqlite::types::Value| match v {
        rusqlite::types::Value::Text(s) => Some(s),
        _ => None,
    };
    let mut stmt = conn
        .prepare_cached(
            "SELECT uid,
                    CASE WHEN json_valid(header_json)
                         THEN coalesce(json_extract(header_json, '$.messageDate'), json_extract(header_json, '$.date')) END,
                    CASE WHEN json_valid(header_json) THEN json_extract(header_json, '$.internalDate') END
             FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid > ?3 ORDER BY uid LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account, mailbox, after.map_or(-1, i64::from), limit as i64], |r| {
            Ok((r.get::<_, u32>(0)?, text(r.get(1)?), text(r.get(2)?)))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

/// One folder's cached uids minus the uids its vault folder holds, fed one
/// ascending page of `(uid, date_ms)` at a time. A merge over two sorted
/// lists: a folder of a million messages costs one pass over each and not
/// one read of a message.
pub struct Gap<'a> {
    held: &'a [u32],
    at: usize,
    /// Ascending.
    pub missing: Vec<u32>,
}

impl<'a> Gap<'a> {
    /// `held`: the vault folder's uids, ascending (`held_uids`).
    pub fn new(held: &'a [u32]) -> Self {
        Gap { held, at: 0, missing: Vec::new() }
    }

    /// `page` continues the ascending uid order of the pages before it. A uid
    /// in the import range (`IMPORT_UID_BASE` and up: mail an mbox import
    /// wrote, never a server's), or one `promised` says the download mode
    /// leaves on the server, is never missing.
    pub fn feed(&mut self, page: &[(u32, Option<i64>)], promised: impl Fn(Option<i64>) -> bool) {
        for &(uid, date_ms) in page {
            if uid >= IMPORT_UID_BASE || !promised(date_ms) {
                continue;
            }
            while self.held.get(self.at).is_some_and(|&h| h < uid) {
                self.at += 1;
            }
            if self.held.get(self.at) != Some(&uid) {
                self.missing.push(uid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn walk(cached: &[(u32, Option<i64>)], held: &[u32], page: usize, promised: impl Fn(Option<i64>) -> bool + Copy) -> Vec<u32> {
        let mut gap = Gap::new(held);
        for chunk in cached.chunks(page) {
            gap.feed(chunk, promised);
        }
        gap.missing
    }

    fn all(_: Option<i64>) -> bool {
        true
    }

    fn undated(uids: impl IntoIterator<Item = u32>) -> Vec<(u32, Option<i64>)> {
        uids.into_iter().map(|u| (u, None)).collect()
    }

    /// The vault holds uids the cache does not list (9) and the cache lists
    /// uids the vault lacks: only the second kind is missing.
    #[test]
    fn missing_is_what_the_cache_lists_and_the_vault_lacks() {
        let cached = undated(1..=6);
        assert_eq!(walk(&cached, &[2, 4, 6, 9], 100, all), vec![1, 3, 5]);
        assert_eq!(walk(&cached, &[], 100, all), vec![1, 2, 3, 4, 5, 6]);
        assert!(walk(&cached, &[1, 2, 3, 4, 5, 6], 100, all).is_empty());
    }

    /// Import-range uids are mbox mail the vault itself numbered: never a
    /// server message the vault is short of, even with no file for them.
    #[test]
    fn an_import_range_uid_is_never_missing() {
        let cached = undated([1, IMPORT_UID_BASE - 1, IMPORT_UID_BASE, IMPORT_UID_BASE + 7, u32::MAX]);
        assert_eq!(walk(&cached, &[], 2, all), vec![1, IMPORT_UID_BASE - 1]);
    }

    /// `promised` sees each row's date, `None` when it has none, and what it
    /// refuses is never missing.
    #[test]
    fn what_the_mode_leaves_on_the_server_is_never_missing() {
        let cached = [(1, Some(100)), (2, Some(5)), (3, None), (4, Some(200))];
        let after_50 = |d: Option<i64>| d.is_none_or(|d| d >= 50);
        assert_eq!(walk(&cached, &[4], 1, after_50), vec![1, 3]);
        assert!(walk(&cached, &[], 1, |_| false).is_empty());
    }

    /// A large sparse folder read in pages of every size, the last page full
    /// or short, gives exactly what a set difference gives, in order. A walk
    /// that restarted its cursor per page, or dropped the row at a page edge,
    /// would differ at some size here.
    #[test]
    fn the_answer_is_the_same_for_every_page_size() {
        let cached = undated((0..100_000u32).map(|i| i * 3 + 1));
        // Every 7th cached uid, plus uids the cache never lists (0, 6, ...).
        let mut held: Vec<u32> = cached.iter().step_by(7).map(|&(u, _)| u).collect();
        held.extend((0..50_000u32).map(|i| i * 6));
        held.sort_unstable();
        held.dedup();
        let held_set: HashSet<u32> = held.iter().copied().collect();
        let expected: Vec<u32> = cached.iter().map(|&(u, _)| u).filter(|u| !held_set.contains(u)).collect();
        assert!(expected.len() > 50_000, "a real gap: {}", expected.len());
        for page in [1, 2, 7, 1000, 99_999, 100_000, 100_001] {
            assert_eq!(walk(&cached, &held, page, all), expected, "page {page}");
        }
    }

    /// Only regular files named for a uid are copies: not a temp name, a
    /// non-canonical or legacy name, junk, a directory or a symlink. An
    /// import-range file is a vault copy like any other.
    #[test]
    fn held_uids_are_the_uid_files_and_nothing_else() {
        let root = tempfile::tempdir().unwrap();
        let cur = root.path().join("Maildir").join("acc").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        let sep = crate::maildir::INFO_PREFIX;
        for name in [
            format!("7{sep}S.eml"),
            format!("3{sep}AS.eml"),
            format!("{IMPORT_UID_BASE}{sep}A.eml"),
            format!(".9{sep}S.eml.tmp-1234"),
            format!("012{sep}S.eml"),
            "12.eml".to_string(),
            "notes.txt".to_string(),
        ] {
            std::fs::write(cur.join(name), b"x").unwrap();
        }
        std::fs::create_dir(cur.join(format!("5{sep}S.eml"))).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(cur.join(format!("7{sep}S.eml")), cur.join(format!("8{sep}S.eml"))).unwrap();

        assert_eq!(held_uids(root.path(), &cur), Some(vec![3, 7, IMPORT_UID_BASE]));
    }

    /// No `cur/` under a vault that is there: an empty folder. The vault gone:
    /// unknown, never empty.
    #[test]
    fn a_missing_folder_is_empty_and_a_missing_vault_is_unknown() {
        let root = tempfile::tempdir().unwrap();
        let cur = root.path().join("Maildir").join("acc").join("Never").join("cur");
        assert_eq!(held_uids(root.path(), &cur), Some(Vec::new()));
        let gone = root.path().join("unplugged");
        assert_eq!(held_uids(&gone, &gone.join("Maildir").join("acc").join("INBOX").join("cur")), None);
    }

    /// The Date header wins over the arrival for a Graph row (`messageDate`
    /// over `date`), an IMAP row without one gives its `date`, INTERNALDATE
    /// rides along, and a row that is not JSON or has no dates gives none.
    #[test]
    fn dated_page_reads_the_dates_the_download_gate_reads() {
        let (_t, conn) = {
            let t = tempfile::tempdir().unwrap();
            let c = crate::custody::db::open(t.path()).unwrap();
            (t, c)
        };
        let put = |uid: u32, row: &str| {
            conn.execute(
                "INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','INBOX',?1,0,0,?2)",
                params![uid, row],
            )
            .unwrap();
        };
        put(1, r#"{"uid":1,"messageDate":"Thu, 01 Jan 2015 00:00:00 +0000","date":"2026-09-01T00:00:00Z","internalDate":"2026-09-01T00:00:00Z"}"#);
        put(2, r#"{"uid":2,"date":"Fri, 02 Jan 2015 00:00:00 +0000"}"#);
        put(3, r#"{"uid":3,"internalDate":"2026-09-02T00:00:00Z"}"#);
        put(4, "not json");
        put(5, r#"{"uid":5,"date":7}"#);
        let s = |v: &str| Some(v.to_string());
        assert_eq!(
            dated_page(&conn, "a", "INBOX", None, 10).unwrap(),
            vec![
                (1, s("Thu, 01 Jan 2015 00:00:00 +0000"), s("2026-09-01T00:00:00Z")),
                (2, s("Fri, 02 Jan 2015 00:00:00 +0000"), None),
                (3, None, s("2026-09-02T00:00:00Z")),
                (4, None, None),
                (5, None, None),
            ]
        );
        assert_eq!(dated_page(&conn, "a", "INBOX", Some(3), 1).unwrap().iter().map(|r| r.0).collect::<Vec<_>>(), vec![4]);
    }
}
