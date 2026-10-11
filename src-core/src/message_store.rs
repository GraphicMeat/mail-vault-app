//! The one seam between the vault's message files and everything that reads
//! or writes them (Plan B, JMAP storage format). A caller asks here for a
//! uid's message, its flags or the mailbox's uid space, and never builds a
//! `cur/` path or parses a vault filename itself; `tests/message_store_guard.rs`
//! holds the rest of the tree to that.
//!
//! Disk only: nothing here touches the vault registry, so every function is
//! safe inside the daemon's `with_mailbox_write`. Registry bookkeeping stays
//! with the caller (`vault_files`, which uses the crate-private path-level
//! helpers `leaf_names`, `put`, `unlink_stale`, `rename_onto`, `unlink` and
//! `read_at` so its verified-mailbox fast paths keep their exact behaviour).
//!
//! Task 1: one format, Maildir (`cur/<uid>:2,<FLAGS>.eml`). `vault_format`
//! always answers `Maildir`, and `write` and `write_replacing` are the same.
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tracing::warn;

use crate::maildir;
use crate::vault_eml::parse_flags_from_filename;
use crate::vault_files;

/// One stored message as the store sees it. `name` is the on-disk leaf
/// (`4182:2,AS.eml` or `4182.json`), kept for registry/search change detection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub uid: u32,
    pub flags: Vec<String>,
    pub size: u64,
    pub mtime_ns: i128,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Maildir,
    Jmap,
}

/// The vault's storage format. Task 1: always `Maildir`; Task 7 reads the
/// `storageFormat` marker.
pub fn vault_format(_root: &Path) -> Format {
    Format::Maildir
}

/// The mailbox directory (holds cur/, jmap/, .uidvalidity, orphaned/, .decrypted/ ...). Dir-level callers
/// (rename, adopt, pgp copies, rehome ledger) use this, never `cur/` directly.
pub fn mailbox_dir(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    vault_files::account_dir(&root.join("Maildir"), account_id).join(crate::search_index::text::vault_dir_name(mailbox))
}

/// The mailbox's Maildir message directory. Private: callers ask by uid.
fn messages_dir(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    messages_in(&mailbox_dir(root, account_id, mailbox))
}

/// The Maildir message directory inside the mailbox directory `mailbox_dir`.
/// The one place the store names it.
fn messages_in(mailbox_dir: &Path) -> PathBuf {
    mailbox_dir.join("cur")
}

fn mtime_ns(meta: &fs::Metadata) -> i128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128)
}

/// The entry for the leaf `name` of `uid`. `meta` is its stat; a failed stat
/// counts as size and mtime 0, as `vault_files::list_on_disk` always did.
fn entry_of(uid: u32, name: String, meta: Option<fs::Metadata>) -> Entry {
    let (size, mtime_ns) = meta.map_or((0, 0), |m| (m.len(), mtime_ns(&m)));
    Entry { uid, flags: parse_flags_from_filename(&name), size, mtime_ns, name }
}

/// The file holding `uid` in the message directory `dir`, by `find_by_uid`'s
/// prefix rule.
fn path_of(dir: &Path, uid: u32) -> Option<PathBuf> {
    maildir::find_by_uid(dir, uid)
}

/// `uid`'s file opened for reading. A flag change renames the file between
/// the scan and the open, so a vanished name gets one rescan.
fn open_by_uid(dir: &Path, uid: u32) -> io::Result<Option<fs::File>> {
    for _ in 0..2 {
        let Some(path) = path_of(dir, uid) else { return Ok(None) };
        match fs::File::open(&path) {
            Ok(file) => return Ok(Some(file)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// Disk only; never touches the registry (safe inside with_mailbox_write). NotFound dir = Ok(empty).
/// One entry per vault file (`maildir::vault_filename_uid`'s rule), by uid then
/// name. An entry that will not stat counts as size and mtime 0.
pub fn list(root: &Path, account_id: &str, mailbox: &str) -> io::Result<Vec<Entry>> {
    let entries = match fs::read_dir(messages_dir(root, account_id, mailbox)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(uid) = maildir::vault_filename_uid(&name) else { continue };
        out.push(entry_of(uid, name, entry.metadata().ok()));
    }
    out.sort_by(|a, b| (a.uid, &a.name).cmp(&(b.uid, &b.name)));
    Ok(out)
}

/// Disk only. The entry for `uid`, or `None` when the mailbox holds no file for it.
pub fn find(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<Entry> {
    let path = path_of(&messages_dir(root, account_id, mailbox), uid)?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(entry_of(uid, name, fs::metadata(&path).ok()))
}

/// Every file of the mailbox that names a uid: `(in orphaned/, uid, path)`,
/// its message directory first, then `orphaned/`, each by uid then path. The
/// uid is read by the loosest rule any reader uses (`maildir::mirror_filename_uid`:
/// legacy `12.eml`, `.regen` leftovers, `orphaned/`'s `.1` dedupe suffixes),
/// exactly as `graph_ledger`'s allocator has always counted a uid as taken.
/// A missing directory is empty; any other listing failure, including one
/// unreadable entry, is an error: reading it as empty would hand out a uid a
/// file on disk already carries.
fn taken_files(root: &Path, account_id: &str, mailbox: &str) -> io::Result<Vec<(bool, u32, PathBuf)>> {
    let dirs = [
        (false, messages_dir(root, account_id, mailbox)),
        (true, mailbox_dir(root, account_id, mailbox).join(maildir::ORPHAN_DIR)),
    ];
    let mut out = Vec::new();
    for (orphaned, dir) in dirs {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for entry in entries {
            let entry = entry?;
            if let Some(uid) = maildir::mirror_filename_uid(&entry.file_name().to_string_lossy()) {
                out.push((orphaned, uid, entry.path()));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Every uid this mailbox holds or held: cur/ + jmap/ + orphaned/. The ONLY source for "which uids are taken".
/// Task 1: the message directory plus `orphaned/` (no `jmap/` yet), by the
/// loose rule `taken_files` documents. Includes the mbox import range
/// (`maildir::IMPORT_UID_BASE` and up); a caller that allocates server-range
/// uids takes `range(..IMPORT_UID_BASE)` of this set.
pub fn uids(root: &Path, account_id: &str, mailbox: &str) -> io::Result<BTreeSet<u32>> {
    Ok(taken_files(root, account_id, mailbox)?.into_iter().map(|(_, uid, _)| uid).collect())
}

/// The highest uid `uids` holds, 0 when empty. Not filtered by range: after
/// an mbox import this is an import-range uid.
pub fn highest_uid(root: &Path, account_id: &str, mailbox: &str) -> io::Result<u32> {
    Ok(uids(root, account_id, mailbox)?.last().copied().unwrap_or(0))
}

/// The uids of the messages `mailbox` holds, ascending: one names-only
/// listing of its message directory that takes no lock. (The vault
/// registry's listing stats every file and holds its locks for the whole
/// folder, and opening a message waits on those.) A regular file named
/// `<uid>:2,...` is a copy; a symlink, a directory, a dot-prefixed temp name
/// (`maildir::vault_filename_uid` refuses it) or any other name is not, and
/// `orphaned/` is never read: a set-aside copy is not held. No message
/// directory under a vault `root` that is there is an empty folder; a root
/// that is gone, or a listing that fails at any point, is `None`: unknown,
/// never empty. The vault gap walks this (`vault_gap::Gap`).
pub fn held_uids(root: &Path, account_id: &str, mailbox: &str) -> Option<Vec<u32>> {
    let entries = match fs::read_dir(messages_dir(root, account_id, mailbox)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound && root.is_dir() => return Some(Vec::new()),
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
        if let Some(uid) = maildir::vault_filename_uid(&entry.file_name().to_string_lossy()) {
            uids.push(uid);
        }
    }
    uids.sort_unstable();
    uids.dedup();
    Some(uids)
}

/// Whether `uid` is in the mbox import range (`maildir::IMPORT_UID_BASE` and
/// up): a number the vault gave an imported message, never a server's.
pub fn is_import_uid(uid: u32) -> bool {
    uid >= maildir::IMPORT_UID_BASE
}

/// (uid, normalized Message-ID) for cur/ + jmap/ (+ orphaned/): graph_ledger adoption, mbox dedupe.
/// One pair per file `uids` counts, message directory first, then
/// `orphaned/`, each by uid; a uid can appear twice (a held copy and a
/// set-aside one). `None` when the header carries no Message-ID or the file
/// will not read. An `orphaned/` pair only says the uid is taken: a caller
/// adopting a uid for a server message checks it is held (`find`).
pub fn uid_message_ids(root: &Path, account_id: &str, mailbox: &str) -> io::Result<Vec<(u32, Option<String>)>> {
    Ok(taken_files(root, account_id, mailbox)?
        .into_iter()
        .map(|(_, uid, path)| (uid, maildir::read_message_id(&path)))
        .collect())
}

/// `uid`'s raw RFC 5322 bytes, `None` when the mailbox holds no file for it.
pub fn read_raw(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> io::Result<Option<Vec<u8>>> {
    let Some(mut file) = open_by_uid(&messages_dir(root, account_id, mailbox), uid)? else { return Ok(None) };
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)?;
    Ok(Some(raw))
}

/// The header section of `uid`'s first `max` bytes: everything before the
/// first blank line, or all `max` bytes when there is none in them.
pub fn read_header_section(root: &Path, account_id: &str, mailbox: &str, uid: u32, max: usize) -> io::Result<Option<Vec<u8>>> {
    let Some(file) = open_by_uid(&messages_dir(root, account_id, mailbox), uid)? else { return Ok(None) };
    let mut buf = Vec::new();
    file.take(max as u64).read_to_end(&mut buf)?;
    Ok(Some(maildir::header_section(&buf).to_vec()))
}

/// Writes in the vault's format. Never removes the other format's file for this uid.
/// Task 1 (Maildir): the new name goes in atomically, then every other file of
/// this uid in the same format (an older flags name, a crash-left duplicate)
/// is removed; one that will not go is logged and left.
pub fn write(root: &Path, account_id: &str, mailbox: &str, uid: u32, raw: &[u8], flags: &[String]) -> Result<Entry, String> {
    let dir = messages_dir(root, account_id, mailbox);
    let stale = leaf_names(&dir, uid);
    let entry = put(&dir, uid, raw, flags)?;
    if unlink_stale(&dir, &entry.name, &stale) {
        warn!("message_store: an older copy of uid {uid} could not be removed");
    }
    Ok(entry)
}

/// write() + verify the new copy by re-reading it + remove the other format's file. For ordinary writers.
/// Task 1: identical to `write`, since only one format exists.
pub fn write_replacing(root: &Path, account_id: &str, mailbox: &str, uid: u32, raw: &[u8], flags: &[String]) -> Result<Entry, String> {
    write(root, account_id, mailbox, uid, raw, flags)
}

/// Re-file `uid` under the flags `flags` names. `Ok(None)`: the mailbox holds
/// no file for `uid`. The entry is the file after the change (unchanged when
/// the name already matched).
pub fn set_flags(root: &Path, account_id: &str, mailbox: &str, uid: u32, flags: &[String]) -> Result<Option<Entry>, String> {
    let Some(old) = path_of(&messages_dir(root, account_id, mailbox), uid) else { return Ok(None) };
    rename_onto(&old, uid, flags).map(Some)
}

/// Removes every file of `uid` (both formats; never deletes blobs), and its
/// decrypted copy. Returns whether one was removed.
pub fn remove(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<bool, String> {
    let dir = messages_dir(root, account_id, mailbox);
    let mut removed = false;
    for leaf in leaf_names(&dir, uid) {
        match unlink(&dir.join(&leaf), uid) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to delete .eml file: {}", e)),
        }
    }
    Ok(removed)
}

/// The file a zero-copy copier (mirror, zip) reads `uid` from: a blob path in
/// JMAP format. `None` when the mailbox holds no file for it.
pub fn raw_path(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<PathBuf> {
    path_of(&messages_dir(root, account_id, mailbox), uid)
}

// ── Mailbox-directory level, for the derived stores ──────────────────────────
//
// The search index and the vault registry key a mailbox by the directory's
// name on disk (`vault_dir`), read back from `read_dir` or from their own
// rows. That name need not survive `vault_dir_name` unchanged (an NFD name
// read back from an HFS+ or SMB volume has combining marks it would rewrite),
// so these take the mailbox directory itself instead of a mailbox name.

/// `<maildir_root>/<account dir>/<vault_dir>`: the mailbox directory named by
/// its on-disk name, which is used as is.
pub fn mailbox_dir_at(maildir_root: &Path, account_id: &str, vault_dir: &str) -> PathBuf {
    vault_files::account_dir(maildir_root, account_id).join(vault_dir)
}

/// Whether the mailbox directory holds a message directory: `Ok(true)` for a
/// directory, `Ok(false)` for anything else at that name, and the stat's error
/// otherwise (`NotFound`: the mailbox holds no messages and never did).
pub fn has_message_dir(mailbox_dir: &Path) -> io::Result<bool> {
    fs::metadata(messages_in(mailbox_dir)).map(|meta| meta.is_dir())
}

/// One strict listing of a mailbox's messages, for a store that reconciles its
/// rows against it (the search index, the vault registry).
#[derive(Debug, Default)]
pub struct Scan {
    /// One entry per uid, by uid: the first file `read_dir` returned for it
    /// that would stat.
    pub entries: Vec<Entry>,
    /// The uids of files whose stat failed (typically a flag rename between
    /// `read_dir` and the stat): still held under another name, so their rows
    /// must not be removed.
    pub unstatted: BTreeSet<u32>,
}

/// Disk only. Lists the mailbox directory `mailbox_dir` by the strict reader
/// rule (`maildir::vault_filename_uid`).
///
/// Unlike `list`, nothing is papered over:
/// - The message directory's own `read_dir` error is returned with its kind, so
///   a caller tells `NotFound` (no messages yet) from an unreadable folder.
/// - An error mid-iteration ends the listing (the Unix `ReadDir` stops after
///   one), so it is the whole listing's error, never a shorter folder:
///   `flatten()` here once turned a truncated listing into verified truth that
///   pruned every row after the break. It is re-kinded to `Other`, because a
///   caller reads `NotFound` as "no messages", which is only true of the
///   `read_dir` open. (Not injectable in a test: there is no way to fail
///   `readdir` part-way on a real directory.)
/// - A file that will not stat is in `unstatted`, not an entry of size 0.
pub fn scan_dir(mailbox_dir: &Path) -> io::Result<Scan> {
    let listing = fs::read_dir(messages_in(mailbox_dir))?;
    let mut held: std::collections::HashMap<u32, Entry> = std::collections::HashMap::new();
    let mut unstatted = BTreeSet::new();
    for item in listing {
        let item = item.map_err(io::Error::other)?;
        let name = item.file_name().to_string_lossy().into_owned();
        let Some(uid) = maildir::vault_filename_uid(&name) else { continue };
        let Ok(meta) = item.metadata() else {
            unstatted.insert(uid);
            continue;
        };
        held.entry(uid).or_insert_with(|| entry_of(uid, name, Some(meta)));
    }
    let mut entries: Vec<Entry> = held.into_values().collect();
    entries.sort_by_key(|e| e.uid);
    Ok(Scan { entries, unstatted })
}

/// How many files of the mailbox directory carry a uid, counted from
/// `read_dir` alone: no stat, no dedupe, entries that fail to read skipped. A
/// cheap upper bound on what `scan_dir` will find, for a progress total.
pub fn count_files(mailbox_dir: &Path) -> io::Result<usize> {
    Ok(fs::read_dir(messages_in(mailbox_dir))?
        .flatten()
        .filter(|e| maildir::vault_filename_uid(&e.file_name().to_string_lossy()).is_some())
        .count())
}

/// Disk only. The entry for `uid` in the mailbox directory `mailbox_dir`, or
/// `None` when it holds no file for it (`find`'s rule).
pub fn find_at(mailbox_dir: &Path, uid: u32) -> Option<Entry> {
    let path = path_of(&messages_in(mailbox_dir), uid)?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(entry_of(uid, name, fs::metadata(&path).ok()))
}

/// The readable bytes of the entry `name` (of `uid`) that a `scan_dir` or
/// `find_at` of `mailbox_dir` returned: its decrypted copy when there is one
/// (`pgp::readable`), so an encrypted message is indexed and shown in clear.
/// No rescan: a name gone since the listing (a flag rename) is `NotFound`.
/// A name that can never be read as a file is `IsADirectory` or
/// `NotADirectory`. On Windows, opening a directory with `File::open` fails
/// with neither kind, so a failed read whose path is a directory is re-kinded
/// to `IsADirectory`. Any other error may pass (permissions, a flaky drive).
pub fn read_listed(mailbox_dir: &Path, uid: u32, name: &str) -> io::Result<Vec<u8>> {
    let dir = messages_in(mailbox_dir);
    let path = dir.join(name);
    match fs::read(&path) {
        Ok(raw) => Ok(crate::pgp::readable(&dir, uid, raw)),
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory) => Err(e),
        Err(e) if path.is_dir() => Err(io::Error::new(io::ErrorKind::IsADirectory, e)),
        Err(e) => Err(e),
    }
}

/// The flags `Entry.flags` holds for an entry named `name`. For a derived
/// store that kept only `Entry.name` (a search index row) and must answer
/// with the flags it was listed under.
pub fn flags_in_name(name: &str) -> Vec<String> {
    parse_flags_from_filename(name)
}

/// The flag letters (`ADFRST`) `flags` names, in `flags`' order, as the search
/// index stores them. Takes what `Entry.flags` holds and what a writer passes
/// (`seen` or `s`, any case); a flag no letter carries (`\Seen`) adds none.
pub fn flag_letters(flags: &[String]) -> String {
    flags.iter().filter_map(|f| vault_files::flag_letter(f)).collect()
}

/// The `Entry.name` a Maildir entry of `uid` under `flags` carries, for a
/// derived store's row of a message no file holds yet (a header-only row).
pub fn entry_name(uid: u32, flags: &[String]) -> String {
    vault_files::build_maildir_filename(uid, flags)
}

// ── Path-level helpers for `vault_files` ─────────────────────────────────────
//
// `vault_files` resolves the file itself (registry row first, then a scan)
// and does the registry bookkeeping around these; the uid-level functions
// above resolve by scanning.

/// Every leaf name in the message directory `dir` that carries `uid`
/// (`maildir::vault_filename_uid`'s rule). A directory that will not list is
/// empty, as `vault_files::store`'s sweep always read it.
pub(crate) fn leaf_names(dir: &Path, uid: u32) -> Vec<String> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| maildir::vault_filename_uid(name) == Some(uid))
        .collect()
}

/// Write `raw` atomically into `dir` under the name `flags` builds for `uid`,
/// creating `dir` first. Removes nothing.
pub(crate) fn put(dir: &Path, uid: u32, raw: &[u8], flags: &[String]) -> Result<Entry, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create Maildir directory: {}", e))?;
    let name = vault_files::build_maildir_filename(uid, flags);
    let path = dir.join(&name);
    crate::fsx::write_atomic(&path, raw).map_err(|e| format!("Failed to write .eml file: {}", e))?;
    let meta = fs::metadata(&path).ok();
    Ok(entry_of(uid, name, meta))
}

/// Remove every leaf of `stale` from `dir` except `keep`. A leaf already gone
/// counts as removed. Returns whether one is still there.
pub(crate) fn unlink_stale(dir: &Path, keep: &str, stale: &[String]) -> bool {
    let mut left = false;
    for old in stale {
        if old.as_str() == keep {
            continue;
        }
        match fs::remove_file(dir.join(old)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => left = true,
        }
    }
    left
}

/// Rename the file `old` (of `uid`) onto the name `flags` builds, in the same
/// directory. No rename when the name already matches. Returns the entry
/// after the change.
pub(crate) fn rename_onto(old: &Path, uid: u32, flags: &[String]) -> Result<Entry, String> {
    let name = vault_files::build_maildir_filename(uid, flags);
    let new = old.with_file_name(&name);
    if new != old {
        fs::rename(old, &new).map_err(|e| format!("Failed to rename file: {}", e))?;
    }
    let meta = fs::metadata(&new).ok();
    Ok(entry_of(uid, name, meta))
}

/// Remove the file `path` (of `uid`), then its decrypted copy beside the
/// directory: plaintext must not outlive the original.
pub(crate) fn unlink(path: &Path, uid: u32) -> io::Result<()> {
    fs::remove_file(path)?;
    if let Some(dir) = path.parent() {
        crate::pgp::remove_copy(dir, uid);
    }
    Ok(())
}

/// The bytes of a file a caller already resolved for one uid (the vault
/// registry's row).
pub(crate) fn read_at(path: &Path) -> io::Result<Vec<u8>> {
    fs::read(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;

    const ACCT: &str = "acct";
    const MBOX: &str = "INBOX";

    fn flags(f: &[&str]) -> Vec<String> {
        f.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn write_then_find_then_read_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(vault_format(root), Format::Maildir);
        assert_eq!(serde_json::to_string(&Format::Jmap).unwrap(), "\"jmap\"");
        assert_eq!(serde_json::from_str::<Format>("\"maildir\"").unwrap(), Format::Maildir);

        let raw = b"Message-ID: <seven@x.test>\r\nSubject: seven\r\n\r\nbody".to_vec();
        // `build_maildir_filename` takes `seen`/`archived` (or the letters);
        // a `\\Seen` system flag names no letter.
        let written = write(root, ACCT, MBOX, 7, &raw, &flags(&["seen", "archived"])).unwrap();
        assert_eq!(written.name, format!("7{INFO_PREFIX}AS.eml"));

        let found = find(root, ACCT, MBOX, 7).expect("uid 7 is held");
        assert_eq!(found, written);
        assert_eq!(found.uid, 7);
        assert_eq!(found.flags, flags(&["archived", "seen", "\\Seen"]));
        assert_eq!(found.size, raw.len() as u64);
        assert!(found.mtime_ns > 0, "a written file has an mtime");
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(raw.clone()));
        assert_eq!(raw_path(root, ACCT, MBOX, 7), Some(messages_dir(root, ACCT, MBOX).join(&found.name)));
        assert_eq!(messages_dir(root, ACCT, MBOX), mailbox_dir(root, ACCT, MBOX).join("cur"));

        assert_eq!(find(root, ACCT, MBOX, 8), None);
        assert_eq!(read_raw(root, ACCT, MBOX, 8).unwrap(), None);
        assert_eq!(raw_path(root, ACCT, MBOX, 8), None);

        // A second write of the uid under other flags replaces the first copy.
        let again = write_replacing(root, ACCT, MBOX, 7, b"new", &flags(&["seen"])).unwrap();
        assert_eq!(again.name, format!("7{INFO_PREFIX}S.eml"));
        assert_eq!(list(root, ACCT, MBOX).unwrap(), vec![again]);
        assert_eq!(read_raw(root, ACCT, MBOX, 7).unwrap(), Some(b"new".to_vec()));
    }

    #[test]
    fn set_flags_renames_and_list_reports_new_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, b"three", &flags(&["seen"])).unwrap();
        write(root, ACCT, MBOX, 4, b"four", &[]).unwrap();

        let renamed = set_flags(root, ACCT, MBOX, 3, &flags(&["seen", "flagged"])).unwrap().expect("uid 3 is held");
        assert_eq!(renamed.name, format!("3{INFO_PREFIX}FS.eml"));
        assert_eq!(renamed.flags, flags(&["flagged", "seen", "\\Seen", "\\Flagged"]));
        assert!(!messages_dir(root, ACCT, MBOX).join(format!("3{INFO_PREFIX}S.eml")).exists(), "the old name is gone");

        let listed = list(root, ACCT, MBOX).unwrap();
        assert_eq!(listed.iter().map(|e| (e.uid, e.name.clone())).collect::<Vec<_>>(), vec![
            (3, format!("3{INFO_PREFIX}FS.eml")),
            (4, format!("4{INFO_PREFIX}.eml")),
        ]);
        assert_eq!(listed[0], renamed);
        assert_eq!(read_raw(root, ACCT, MBOX, 3).unwrap(), Some(b"three".to_vec()), "a flag change keeps the bytes");

        // The same flags again: nothing to rename, the same entry back.
        assert_eq!(set_flags(root, ACCT, MBOX, 3, &flags(&["flagged", "seen"])).unwrap(), Some(renamed));
        assert_eq!(set_flags(root, ACCT, MBOX, 9, &flags(&["seen"])).unwrap(), None, "a uid not held");
    }

    #[test]
    fn remove_deletes_and_find_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = messages_dir(root, ACCT, MBOX);
        write(root, ACCT, MBOX, 5, b"five", &flags(&["seen"])).unwrap();
        // A crash-left second copy of uid 5 under other flags, and its decrypted copy.
        fs::write(dir.join(format!("5{INFO_PREFIX}.eml")), b"five").unwrap();
        crate::pgp::write_copy(&dir, 5, b"plain").unwrap();
        assert!(crate::pgp::copy_path(&dir, 5).exists());
        write(root, ACCT, MBOX, 6, b"six", &[]).unwrap();

        assert!(remove(root, ACCT, MBOX, 5).unwrap());
        assert_eq!(find(root, ACCT, MBOX, 5), None);
        assert!(!crate::pgp::copy_path(&dir, 5).exists(), "the decrypted copy goes with the original");
        assert_eq!(list(root, ACCT, MBOX).unwrap().iter().map(|e| e.uid).collect::<Vec<_>>(), vec![6]);
        assert!(!remove(root, ACCT, MBOX, 5).unwrap(), "nothing left to remove");
        assert!(find(root, ACCT, MBOX, 6).is_some(), "another uid is untouched");
    }

    #[test]
    fn list_of_missing_mailbox_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert_eq!(list(root, ACCT, "Nope").unwrap(), Vec::<Entry>::new());
        assert_eq!(uids(root, ACCT, "Nope").unwrap(), BTreeSet::new());
        assert_eq!(highest_uid(root, ACCT, "Nope").unwrap(), 0);
        assert_eq!(uid_message_ids(root, ACCT, "Nope").unwrap(), Vec::new());
        assert_eq!(find(root, ACCT, "Nope", 1), None);
        assert_eq!(read_raw(root, ACCT, "Nope", 1).unwrap(), None);
        assert_eq!(read_header_section(root, ACCT, "Nope", 1, 64).unwrap(), None);
        assert_eq!(set_flags(root, ACCT, "Nope", 1, &flags(&["seen"])).unwrap(), None);
        assert!(!remove(root, ACCT, "Nope", 1).unwrap());
        assert_eq!(raw_path(root, ACCT, "Nope", 1), None);

        // A message directory that exists but cannot be listed is an error, not empty.
        #[cfg(unix)]
        {
            let mbox = mailbox_dir(root, ACCT, "Broken");
            fs::create_dir_all(&mbox).unwrap();
            fs::write(mbox.join("cur"), b"not a directory").unwrap();
            assert!(list(root, ACCT, "Broken").is_err());
            assert!(uids(root, ACCT, "Broken").is_err());
        }
    }

    #[test]
    fn uids_and_highest_include_orphaned() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, ACCT, MBOX, 3, b"Message-ID: <three@x.test>\r\n\r\nthree", &flags(&["seen"])).unwrap();
        write(root, ACCT, MBOX, 5, b"Subject: no id\r\n\r\nfive", &[]).unwrap();
        // Strays that name no uid: a write_atomic temp and a text file.
        let dir = messages_dir(root, ACCT, MBOX);
        fs::write(dir.join(format!(".8{INFO_PREFIX}S.eml.tmp-1-2")), b"temp").unwrap();
        fs::write(dir.join("notes.txt"), b"stray").unwrap();
        // orphaned/: a set-aside uid 9, and a second set-aside copy of 3 under a dedupe suffix.
        let orphaned = mailbox_dir(root, ACCT, MBOX).join(maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphaned).unwrap();
        fs::write(orphaned.join(format!("9{INFO_PREFIX}S.eml")), b"Message-ID: <nine@x.test>\r\n\r\nnine").unwrap();
        fs::write(orphaned.join(format!("3{INFO_PREFIX}S.eml.1")), b"Message-ID: <old-three@x.test>\r\n\r\nold").unwrap();

        assert_eq!(uids(root, ACCT, MBOX).unwrap(), BTreeSet::from([3, 5, 9]));
        assert_eq!(highest_uid(root, ACCT, MBOX).unwrap(), 9);
        assert_eq!(uid_message_ids(root, ACCT, MBOX).unwrap(), vec![
            (3, Some("three@x.test".to_string())),
            (5, None),
            (3, Some("old-three@x.test".to_string())),
            (9, Some("nine@x.test".to_string())),
        ]);
        // `list` is the held messages only: no orphaned/, no strays.
        assert_eq!(list(root, ACCT, MBOX).unwrap().iter().map(|e| e.uid).collect::<Vec<_>>(), vec![3, 5]);
    }

    #[test]
    fn read_header_section_stops_at_blank_line_or_max() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, ACCT, MBOX, 4, b"From: a@x\r\nSubject: hi\r\n\r\nbody text\r\n", &[]).unwrap();
        write(root, ACCT, MBOX, 5, b"A: 1\nB: 2\n\nbody", &[]).unwrap();

        assert_eq!(read_header_section(root, ACCT, MBOX, 4, 1024).unwrap(), Some(b"From: a@x\r\nSubject: hi\r\n".to_vec()));
        assert_eq!(read_header_section(root, ACCT, MBOX, 5, 1024).unwrap(), Some(b"A: 1\nB: 2\n".to_vec()));
        // No blank line within `max` bytes: all of them.
        assert_eq!(read_header_section(root, ACCT, MBOX, 4, 9).unwrap(), Some(b"From: a@x".to_vec()));
        assert_eq!(read_header_section(root, ACCT, MBOX, 6, 1024).unwrap(), None);
    }

    /// Only regular files named for a uid are copies: not a temp name, a
    /// non-canonical or legacy name, junk, a directory or a symlink. An
    /// import-range file is a vault copy like any other.
    #[test]
    fn held_uids_are_the_uid_files_and_nothing_else() {
        use crate::maildir::IMPORT_UID_BASE;
        let root = tempfile::tempdir().unwrap();
        let cur = messages_dir(root.path(), "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let sep = INFO_PREFIX;
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

        assert_eq!(held_uids(root.path(), "acc", "INBOX"), Some(vec![3, 7, IMPORT_UID_BASE]));
    }

    /// No message directory under a vault that is there: an empty folder.
    /// The vault gone: unknown, never empty.
    #[test]
    fn a_missing_folder_is_empty_and_a_missing_vault_is_unknown() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(held_uids(root.path(), "acc", "Never"), Some(Vec::new()));
        let gone = root.path().join("unplugged");
        assert_eq!(held_uids(&gone, "acc", "INBOX"), None);
    }

    #[test]
    fn mirror_cur_joins_the_raw_mailbox_name() {
        let mirror = Path::new("mirror-root");
        assert_eq!(
            maildir::mirror_cur(mirror, "me@x.test", "Work/Clients"),
            mirror.join("me@x.test").join("Work/Clients").join("cur")
        );
    }

    #[test]
    fn mailbox_dir_level_reads_keep_what_derived_stores_need() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mbox = mailbox_dir_at(&root.join("Maildir"), ACCT, MBOX);
        assert_eq!(mbox, mailbox_dir(root, ACCT, MBOX));
        // No message directory yet: NotFound is kept, never an empty listing.
        assert_eq!(scan_dir(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(count_files(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(has_message_dir(&mbox).unwrap_err().kind(), io::ErrorKind::NotFound);

        write(root, ACCT, MBOX, 3, b"three", &flags(&["seen", "flagged"])).unwrap();
        write(root, ACCT, MBOX, 4, b"four", &[]).unwrap();
        let dir = messages_dir(root, ACCT, MBOX);
        fs::write(dir.join("notes.txt"), b"stray").unwrap();
        // A second name for uid 4 that is a directory: listed, never readable.
        let odd = format!("4{INFO_PREFIX}T.eml");
        fs::create_dir(dir.join(&odd)).unwrap();
        assert!(has_message_dir(&mbox).unwrap());
        assert_eq!(count_files(&mbox).unwrap(), 3, "every uid-named entry, the directory too");

        let scan = scan_dir(&mbox).unwrap();
        assert!(scan.unstatted.is_empty());
        assert_eq!(scan.entries.iter().map(|e| e.uid).collect::<Vec<_>>(), vec![3, 4], "one entry per uid");
        let three = find(root, ACCT, MBOX, 3).unwrap();
        assert_eq!((scan.entries[0].uid, &scan.entries[0].name, &scan.entries[0].flags), (3, &three.name, &three.flags));
        assert_eq!(scan.entries[0].size, 5);
        assert_eq!(find_at(&mbox, 3), Some(three));
        assert_eq!(find_at(&mbox, 9), None);

        assert_eq!(read_listed(&mbox, 3, &scan.entries[0].name).unwrap(), b"three".to_vec());
        assert_eq!(read_listed(&mbox, 3, &format!("3{INFO_PREFIX}.eml")).unwrap_err().kind(), io::ErrorKind::NotFound);
        let dir_err = read_listed(&mbox, 4, &odd).unwrap_err().kind();
        assert!(matches!(dir_err, io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory), "{dir_err:?}");

        // The flags of a stored name, and the letters the index keeps for them.
        let name = format!("7{INFO_PREFIX}FS.eml");
        assert_eq!(flags_in_name(&name), flags(&["flagged", "seen", "\\Seen", "\\Flagged"]));
        assert_eq!(flag_letters(&flags_in_name(&name)), "FS");
        assert_eq!(flag_letters(&flags(&["Seen", "a", "\\Answered", "replied"])), "SAR", "in order, case-blind, letters too");
        assert_eq!(entry_name(7, &flags(&["seen", "flagged"])), name);
        assert_eq!(flag_letters(&flags_in_name(&entry_name(7, &flags(&["replied", "draft"])))), "DR");
    }
}
