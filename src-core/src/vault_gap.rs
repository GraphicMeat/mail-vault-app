//! Phase 5: which messages the header cache lists that the vault holds no
//! full copy of. Pure: the daemon (`src-daemon/src/vault_gap.rs`) reads the
//! header cache a page at a time (`custody::cache::uid_dates_after`) and the
//! vault's uids from the registry, and hands both here.

use crate::maildir::IMPORT_UID_BASE;

/// The date a header-cache row was stored under (`sort_ms`: INTERNALDATE,
/// else the Date header), or `None` for the sentinel `save_headers_at` writes
/// when neither parses (`i64::MIN + uid`).
pub fn stored_date(sort_ms: i64) -> Option<i64> {
    (sort_ms > i64::MIN + i64::from(u32::MAX)).then_some(sort_ms)
}

/// One folder's cached uids minus the uids its vault folder holds, fed one
/// ascending page of `(uid, sort_ms)` at a time. A merge over two sorted
/// lists: a folder of a million messages costs one pass over each and not
/// one read of a message.
pub struct Gap<'a> {
    held: &'a [u32],
    at: usize,
    /// Ascending.
    pub missing: Vec<u32>,
}

impl<'a> Gap<'a> {
    /// `held`: the vault folder's uids, ascending (`VaultRegistry::uid_sets`).
    pub fn new(held: &'a [u32]) -> Self {
        Gap { held, at: 0, missing: Vec::new() }
    }

    /// `page` continues the ascending uid order of the pages before it. A uid
    /// in the import range (`IMPORT_UID_BASE` and up: mail an mbox import
    /// wrote, never a server's), or one `promised` says the download mode
    /// leaves on the server, is never missing.
    pub fn feed(&mut self, page: &[(u32, i64)], promised: impl Fn(Option<i64>) -> bool) {
        for &(uid, sort_ms) in page {
            if uid >= IMPORT_UID_BASE || !promised(stored_date(sort_ms)) {
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

    fn walk(cached: &[(u32, i64)], held: &[u32], page: usize, promised: impl Fn(Option<i64>) -> bool + Copy) -> Vec<u32> {
        let mut gap = Gap::new(held);
        for chunk in cached.chunks(page) {
            gap.feed(chunk, promised);
        }
        gap.missing
    }

    fn all(_: Option<i64>) -> bool {
        true
    }

    #[test]
    fn the_unknown_date_sentinel_reads_as_no_date() {
        assert_eq!(stored_date(i64::MIN + 5), None);
        assert_eq!(stored_date(i64::MIN + i64::from(u32::MAX)), None);
        assert_eq!(stored_date(0), Some(0));
        assert_eq!(stored_date(-86_400_000), Some(-86_400_000), "a 1969 date is a date");
        assert_eq!(stored_date(1_768_435_200_000), Some(1_768_435_200_000));
    }

    /// The vault holds uids the cache does not list (9) and the cache lists
    /// uids the vault lacks: only the second kind is missing.
    #[test]
    fn missing_is_what_the_cache_lists_and_the_vault_lacks() {
        let cached: Vec<(u32, i64)> = (1..=6).map(|u| (u, 0)).collect();
        assert_eq!(walk(&cached, &[2, 4, 6, 9], 100, all), vec![1, 3, 5]);
        assert_eq!(walk(&cached, &[], 100, all), vec![1, 2, 3, 4, 5, 6]);
        assert!(walk(&cached, &[1, 2, 3, 4, 5, 6], 100, all).is_empty());
    }

    /// Import-range uids are mbox mail the vault itself numbered: never a
    /// server message the vault is short of, even with no file for them.
    #[test]
    fn an_import_range_uid_is_never_missing() {
        let cached = [(1, 0), (IMPORT_UID_BASE - 1, 0), (IMPORT_UID_BASE, 0), (IMPORT_UID_BASE + 7, 0), (u32::MAX, 0)];
        assert_eq!(walk(&cached, &[], 2, all), vec![1, IMPORT_UID_BASE - 1]);
    }

    /// `promised` sees the stored date, `None` for the sentinel, and what it
    /// refuses is never missing.
    #[test]
    fn what_the_mode_leaves_on_the_server_is_never_missing() {
        let cached = [(1, 100), (2, 5), (3, i64::MIN + 3), (4, 200)];
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
        let cached: Vec<(u32, i64)> = (0..100_000u32).map(|i| (i * 3 + 1, i64::from(i))).collect();
        // Every 7th cached uid, plus uids the cache never lists (0, 2, ...).
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
}
