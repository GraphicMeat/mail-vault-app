//! The Outlook (Microsoft Graph) uid ledger, and the only code that writes it.
//!
//! A Graph message has no uid. MailVault mints one per mailbox the first time
//! it sees a Graph id and keeps it for good, in `graph_id_map.json` beside the
//! mailbox's header sidecars: `{"<uid>":"<graph id>"}`. The vault names files
//! by that uid, so everything that files a Graph message (the app's listing
//! path through `graph_allocate_uids`, and the backup) takes its number from
//! `allocate` here. Two writers each holding their own copy of the file is how
//! one uid came to name two messages.
//!
//! What a new id gets, in order of preference:
//! - the uid of a vault file with its Message-ID that no ledger entry owns, so
//!   mail an earlier backup already stored is not fetched again;
//! - otherwise one more than every uid in the ledger AND every uid a file name
//!   carries in the vault's `cur/` or `orphaned/` — never the external backup
//!   mirror, which this floor never sees — so a copy filed under some older
//!   numbering can never block the message the ledger hands that number to.
//!   A backup restores mirror-only files into the vault (its pre-sync) before
//!   it allocates, so it sees them there; an app listing that allocates
//!   before any backup has run can hand out a uid only the mirror holds.

use crate::fsx;
use crate::maildir::{mirror_filename_uid, normalize_message_id, read_message_id, vault_filename_uid, ORPHAN_DIR};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tracing::warn;

pub const LEDGER_FILE: &str = "graph_id_map.json";

/// uid -> Graph message id.
pub type Ledger = BTreeMap<u32, String>;

/// Held for a whole load-allocate-persist, so the app's listings and the backup
/// never allocate from the same stale read. The value is a memo of the
/// Message-IDs read from vault files, per `cur/` dir and uid: the app seeds a
/// folder 200 ids at a time, and reading every file again per page is quadratic.
// ponytail: one lock for every mailbox, not one per ledger path: two processes
// on one vault (two Macs on a NAS vault) can still race, add a file lock on
// the ledger if that is supported. It also means a first call over a large
// rebuilt folder on a slow drive, which reads every unowned file while
// holding this lock, blocks every OTHER Outlook mailbox's listing and backup
// too, not just its own; split to one lock per ledger path if that
// contention matters.
// The memo trusts a uid's file never to change content, true for Graph
// mailboxes today; re-read when a file's length changes if that stops holding.
static STATE: LazyLock<Mutex<HashMap<PathBuf, HashMap<u32, String>>>> =
    LazyLock::new(Default::default);

/// The ledger on disk. No file is an empty ledger; a file that cannot be read
/// or parsed is an error, never empty: reading it as empty would hand uid 1 to
/// today's newest message and file it over whatever already owns 1.
pub fn load(path: &Path) -> Result<Ledger, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Outlook uid ledger {} is unreadable: {}", path.display(), e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::new()),
        Err(e) => Err(format!("Outlook uid ledger {} could not be read: {}", path.display(), e)),
    }
}

struct DiskView {
    /// The highest uid any file name in `cur/` or `orphaned/` parses to, by the
    /// loosest rule any reader uses (legacy `12.eml`, `.regen` leftovers, set-aside files).
    highest: u32,
    /// Canonical `<uid>:` files in `cur/`: the ones a reader finds by uid.
    canonical: HashMap<u32, PathBuf>,
}

/// `cur_dir` (and its sibling `orphaned/`) missing is an empty view: a mailbox
/// never backed up has no `cur/` yet. Any other failure to list either
/// directory, including a single unreadable entry partway through, is an
/// error: reading it as empty would hand out a uid a file on disk already
/// carries, the same reason `load` refuses unreadable input.
fn scan(cur_dir: &Path) -> Result<DiskView, String> {
    let mut view = DiskView { highest: 0, canonical: HashMap::new() };
    let orphaned = cur_dir.parent().map(|mailbox| mailbox.join(ORPHAN_DIR));
    for (dir, is_cur) in [(Some(cur_dir.to_path_buf()), true), (orphaned, false)] {
        let Some(dir) = dir else { continue };
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Outlook uid allocation could not list {}: {}", dir.display(), e)),
        };
        for entry in entries {
            let entry = entry
                .map_err(|e| format!("Outlook uid allocation could not list {}: {}", dir.display(), e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(uid) = mirror_filename_uid(&name) {
                view.highest = view.highest.max(uid);
            }
            if is_cur {
                if let Some(uid) = vault_filename_uid(&name) {
                    view.canonical.entry(uid).or_insert_with(|| entry.path());
                }
            }
        }
    }
    Ok(view)
}

fn persist(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let saved = |e: &dyn std::fmt::Display| format!("Outlook uid ledger {} could not be saved: {}", path.display(), e);
    let bytes = serde_json::to_vec(ledger).map_err(|e| saved(&e))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| saved(&e))?;
    }
    fsx::write_atomic(path, &bytes).map_err(|e| saved(&e))
}

/// One uid per `listed` entry, in order. `listed` pairs each Graph id with its
/// internetMessageId as Graph returns it. Every new number is on disk before
/// this returns; on any error no uid is returned and the ledger is unchanged.
pub fn allocate(ledger_path: &Path, cur_dir: &Path, listed: &[(String, Option<String>)]) -> Result<Vec<u32>, String> {
    let mut memo = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ledger = load(ledger_path)?;

    // BTreeMap iterates uids ascending, so an id the file maps twice resolves
    // to its lower uid.
    let mut uid_of: HashMap<String, u32> = HashMap::new();
    for (uid, id) in &ledger {
        uid_of.entry(id.clone()).or_insert(*uid);
    }

    let mut unseen: Vec<(&str, Option<&str>)> = Vec::new();
    let mut queued: HashSet<&str> = HashSet::new();
    for (id, message_id) in listed {
        if !uid_of.contains_key(id.as_str()) && queued.insert(id.as_str()) {
            unseen.push((id.as_str(), message_id.as_deref()));
        }
    }

    if !unseen.is_empty() {
        let disk = scan(cur_dir)?;

        // Normalized Message-ID -> the lowest uid of a file the ledger does not own.
        let mut adoptable: HashMap<String, u32> = HashMap::new();
        if unseen.iter().any(|(_, message_id)| message_id.is_some()) {
            let read = memo.entry(cur_dir.to_path_buf()).or_default();
            read.retain(|uid, _| disk.canonical.contains_key(uid));
            let mut unowned: Vec<(u32, &PathBuf)> = disk
                .canonical
                .iter()
                .filter(|(uid, _)| !ledger.contains_key(uid))
                .map(|(uid, path)| (*uid, path))
                .collect();
            unowned.sort_unstable_by_key(|(uid, _)| *uid);
            for (uid, path) in unowned {
                // Only a successful read is memoized: a transient open/read
                // failure returns None exactly like "no Message-ID header"
                // does, and caching that would pin the file unowned for the
                // rest of the process instead of retrying it on a later call.
                let message_id = match read.get(&uid) {
                    Some(id) => Some(id.clone()),
                    None => read_message_id(path),
                };
                if let Some(message_id) = message_id {
                    read.entry(uid).or_insert_with(|| message_id.clone());
                    adoptable.entry(message_id).or_insert(uid);
                }
            }
        }

        let mut next = ledger.keys().next_back().copied().unwrap_or(0).max(disk.highest);
        for (id, message_id) in unseen {
            let adopted = message_id.map(normalize_message_id).and_then(|m| adoptable.remove(&m));
            let uid = match adopted {
                Some(uid) => uid,
                // checked, not `+= 1`: a legacy or set-aside file can name any
                // u32, so the floor can already sit at u32::MAX. Wrapping
                // would hand out a uid a file on disk carries; panicking
                // would take the whole process down for one mailbox.
                None => {
                    next = next.checked_add(1).ok_or_else(|| {
                        format!("Outlook uid ledger {} has no uids left to allocate", ledger_path.display())
                    })?;
                    next
                }
            };
            // Guards the one invariant the two paths above exist to keep: an
            // adopted uid is never still owned (it came from `adoptable`,
            // built from uids `ledger` does not contain) and a fresh uid is
            // never below `next`'s floor, so this should never fire. If it
            // ever does, failing loudly beats silently overwriting whichever
            // message already owned that uid.
            if ledger.insert(uid, id.to_string()).is_some() {
                return Err(format!(
                    "Outlook uid ledger {} already had a message filed under uid {}",
                    ledger_path.display(),
                    uid
                ));
            }
            uid_of.insert(id.to_string(), uid);
        }

        persist(ledger_path, &ledger)?;

        // Nothing left in this folder to adopt: the memo would only take memory.
        if disk.canonical.keys().all(|uid| ledger.contains_key(uid)) {
            memo.remove(cur_dir);
        }
    }

    Ok(listed.iter().map(|(id, _)| uid_of[id.as_str()]).collect())
}

/// The listed messages a backup still has to fetch: (index into `listed`, the
/// uid to file it under), leaving out every uid `local` already holds, each uid
/// once. Allocates, and persists, first.
pub fn plan_fetch(
    ledger_path: &Path,
    cur_dir: &Path,
    listed: &[(String, Option<String>)],
    local: &HashSet<u32>,
) -> Result<Vec<(usize, u32)>, String> {
    let uids = allocate(ledger_path, cur_dir, listed)?;
    let mut planned = HashSet::new();
    Ok(uids
        .into_iter()
        .enumerate()
        .filter(|(_, uid)| !local.contains(uid) && planned.insert(*uid))
        .collect())
}

/// Empty the header cache at `cache_dir` (`<vault>/email_cache`) but keep every
/// mailbox's uid ledger. The vault's files and the app's in-memory map go on
/// using the ledger's numbers after "Clear cached emails", and a ledger rebuilt
/// from the files that survive it would hand one of those numbers to a new
/// message. Best effort, like the delete it replaces: a failure is logged and
/// the rest is still cleared.
pub fn clear_cache_keeping_ledgers(cache_dir: &Path) {
    let entries = match std::fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            warn!("[email_cache] could not list {}: {}", cache_dir.display(), e);
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // file_type does not follow symlinks: a link is removed, never its target.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            logged(&path, std::fs::remove_file(&path));
            continue;
        }
        let children = match std::fs::read_dir(&path) {
            Ok(children) => children,
            Err(e) => {
                warn!("[email_cache] could not list {}, left as is: {}", path.display(), e);
                continue;
            }
        };
        let mut kept = false;
        for child in children.flatten() {
            let child_path = child.path();
            match child.file_type() {
                Ok(t) if t.is_file() && child.file_name() == LEDGER_FILE => kept = true,
                Ok(t) if t.is_dir() => logged(&child_path, std::fs::remove_dir_all(&child_path)),
                _ => logged(&child_path, std::fs::remove_file(&child_path)),
            }
        }
        if !kept {
            logged(&path, std::fs::remove_dir(&path));
        }
    }
}

fn logged(path: &Path, result: std::io::Result<()>) {
    if let Err(e) = result {
        warn!("[email_cache] could not remove {}: {}", path.display(), e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;

    struct Mailbox {
        _tmp: tempfile::TempDir,
        ledger: PathBuf,
        cur: PathBuf,
    }

    fn mailbox() -> Mailbox {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = tmp.path().join("email_cache").join("acct_INBOX").join(LEDGER_FILE);
        let cur = tmp.path().join("Maildir").join("acct").join("INBOX").join("cur");
        fs::create_dir_all(&cur).unwrap();
        Mailbox { _tmp: tmp, ledger, cur }
    }

    fn eml(message_id: &str) -> String {
        format!("From: a@b.test\r\nSubject: s\r\nMessage-ID: <{}>\r\n\r\nbody\r\n", message_id)
    }

    /// A vault file under `uid` holding the message named `name`.
    fn file(m: &Mailbox, uid: u32, name: &str) {
        fs::write(m.cur.join(format!("{}:2,.eml", uid)), eml(&format!("{}@outlook.test", name))).unwrap();
    }

    fn seed(m: &Mailbox, pairs: &[(u32, &str)]) {
        fs::create_dir_all(m.ledger.parent().unwrap()).unwrap();
        let map: Ledger = pairs.iter().map(|(u, n)| (*u, format!("g-{}", n))).collect();
        fs::write(&m.ledger, serde_json::to_vec(&map).unwrap()).unwrap();
    }

    /// Listing entries as Graph returns them: id `g-<name>`, Message-ID `<<name>@outlook.test>`.
    fn listed(names: &[&str]) -> Vec<(String, Option<String>)> {
        names.iter().map(|n| (format!("g-{}", n), Some(format!("<{}@outlook.test>", n)))).collect()
    }

    fn on_disk(m: &Mailbox) -> Ledger {
        load(&m.ledger).unwrap()
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn numbers_a_new_mailbox_in_listing_order_in_the_apps_file_shape() {
        let m = mailbox();
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["a", "b", "c"])).unwrap(), vec![1, 2, 3]);
        assert_eq!(fs::read_to_string(&m.ledger).unwrap(), r#"{"1":"g-a","2":"g-b","3":"g-c"}"#);
    }

    #[test]
    fn an_empty_listing_allocates_nothing_and_writes_nothing() {
        let m = mailbox();
        assert_eq!(allocate(&m.ledger, &m.cur, &[]).unwrap(), Vec::<u32>::new());
        assert!(!m.ledger.exists());
    }

    #[test]
    fn an_arrival_takes_the_next_uid_and_every_known_message_keeps_its_own() {
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b"), (3, "c")]);
        for (uid, n) in [(1, "a"), (2, "b"), (3, "c")] { file(&m, uid, n); }
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["z", "a", "b", "c"])).unwrap(), vec![4, 1, 2, 3]);
        assert_eq!(on_disk(&m).get(&4).map(String::as_str), Some("g-z"));
    }

    #[test]
    fn never_reissues_the_uid_of_a_message_that_left_the_listing() {
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b")]);
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["a"])).unwrap(), vec![1]);
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["new", "a"])).unwrap(), vec![3, 1]);
        assert_eq!(on_disk(&m).get(&2).map(String::as_str), Some("g-b"));
    }

    #[test]
    fn reads_the_ledger_from_disk_on_every_call() {
        let m = mailbox();
        allocate(&m.ledger, &m.cur, &listed(&["a", "b"])).unwrap();
        // Another writer grew the file since.
        seed(&m, &[(1, "a"), (2, "b"), (5, "x")]);
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["y"])).unwrap(), vec![6]);
    }

    #[test]
    fn a_ledger_that_cannot_be_parsed_is_an_error_and_is_left_as_it_was() {
        let m = mailbox();
        fs::create_dir_all(m.ledger.parent().unwrap()).unwrap();
        fs::write(&m.ledger, r#"{"1":"g-a","#).unwrap();
        let err = allocate(&m.ledger, &m.cur, &listed(&["a", "new"])).unwrap_err();
        assert!(err.contains("ledger"), "{err}");
        assert!(err.contains(&m.ledger.display().to_string()), "{err}");
        assert_eq!(fs::read_to_string(&m.ledger).unwrap(), r#"{"1":"g-a","#);
    }

    #[test]
    fn a_ledger_that_cannot_be_read_is_an_error() {
        let m = mailbox();
        fs::create_dir_all(&m.ledger).unwrap(); // a directory where the file should be
        assert!(allocate(&m.ledger, &m.cur, &listed(&["a"])).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn a_failed_write_returns_no_uids_and_leaves_the_ledger_as_it_was() {
        let m = mailbox();
        seed(&m, &[(1, "a")]);
        let before = fs::read(&m.ledger).unwrap();
        let dir = m.ledger.parent().unwrap().to_path_buf();
        set_mode(&dir, 0o555);
        let result = allocate(&m.ledger, &m.cur, &listed(&["a", "new"]));
        set_mode(&dir, 0o755);
        assert!(result.is_err());
        assert_eq!(fs::read(&m.ledger).unwrap(), before);
    }

    #[test]
    #[cfg(unix)]
    fn writes_nothing_when_every_listed_id_is_known() {
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b")]);
        let dir = m.ledger.parent().unwrap().to_path_buf();
        set_mode(&dir, 0o555); // any write attempt would fail
        let result = allocate(&m.ledger, &m.cur, &listed(&["b", "a"]));
        set_mode(&dir, 0o755);
        assert_eq!(result.unwrap(), vec![2, 1]);
    }

    #[test]
    fn a_new_uid_never_lands_on_a_file_the_ledger_did_not_issue() {
        // The shape found on a real account: ledger 1-6, and a seventh file
        // holding a second copy of uid 6's message.
        let m = mailbox();
        let names = ["m6", "m5", "m4", "m3", "m2", "m1"];
        seed(&m, &names.iter().enumerate().map(|(i, n)| (i as u32 + 1, *n)).collect::<Vec<_>>());
        for (i, n) in names.iter().enumerate() { file(&m, i as u32 + 1, n); }
        file(&m, 7, "m1");
        let seventh = fs::read(m.cur.join("7:2,.eml")).unwrap();
        let uids = allocate(&m.ledger, &m.cur, &listed(&["new", "m6", "m5", "m4", "m3", "m2", "m1"])).unwrap();
        assert_eq!(uids, vec![8, 1, 2, 3, 4, 5, 6]);
        assert_eq!(fs::read(m.cur.join("7:2,.eml")).unwrap(), seventh);
    }

    #[test]
    fn the_floor_counts_legacy_names_and_set_aside_files() {
        let m = mailbox();
        fs::write(m.cur.join("12.eml"), eml("legacy@outlook.test")).unwrap();
        let orphaned = m.cur.parent().unwrap().join(crate::maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphaned).unwrap();
        fs::write(orphaned.join("20:2,.eml"), eml("set-aside@outlook.test")).unwrap();
        let uids = allocate(&m.ledger, &m.cur, &[("g-n".to_string(), None)]).unwrap();
        assert_eq!(uids, vec![21]);
    }

    #[test]
    fn a_folder_the_old_backup_filed_keeps_its_files_by_message_id() {
        // Positions 1-3 from a listing taken before "new" arrived.
        let m = mailbox();
        file(&m, 1, "p3");
        file(&m, 2, "p2");
        file(&m, 3, "p1");
        let uids = allocate(&m.ledger, &m.cur, &listed(&["new", "p3", "p2", "p1"])).unwrap();
        assert_eq!(uids, vec![4, 1, 2, 3]);
    }

    #[test]
    fn plan_fetch_after_an_arrival_fetches_only_the_new_message_under_its_ledger_uid() {
        // Position numbering would plan the OLDEST message (index 3) as uid 4.
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b"), (3, "c")]);
        for (uid, n) in [(1, "a"), (2, "b"), (3, "c")] { file(&m, uid, n); }
        let local: HashSet<u32> = [1, 2, 3].into_iter().collect();
        assert_eq!(plan_fetch(&m.ledger, &m.cur, &listed(&["z", "a", "b", "c"]), &local).unwrap(), vec![(0, 4)]);
    }

    #[test]
    fn plan_fetch_plans_each_uid_once() {
        let m = mailbox();
        let entries = vec![
            ("g-a".to_string(), Some("<a@outlook.test>".to_string())),
            ("g-a".to_string(), Some("<a@outlook.test>".to_string())),
        ];
        assert_eq!(plan_fetch(&m.ledger, &m.cur, &entries, &HashSet::new()).unwrap(), vec![(0, 1)]);
    }

    #[test]
    fn adoption_never_takes_a_uid_the_ledger_already_gave_away() {
        let m = mailbox();
        seed(&m, &[(1, "a")]);
        file(&m, 1, "a");
        let uids = allocate(&m.ledger, &m.cur, &[("g-copy".to_string(), Some("<a@outlook.test>".to_string()))]).unwrap();
        assert_eq!(uids, vec![2]);
    }

    #[test]
    fn two_files_with_one_message_id_adopt_the_lower_uid() {
        let m = mailbox();
        file(&m, 6, "m");
        file(&m, 7, "m");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m"])).unwrap(), vec![6]);
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["new"])).unwrap(), vec![8]);
    }

    #[test]
    fn one_id_listed_twice_gets_one_uid() {
        let m = mailbox();
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["a", "a", "b"])).unwrap(), vec![1, 1, 2]);
        assert_eq!(on_disk(&m).len(), 2);
    }

    #[test]
    fn a_duplicated_id_in_the_file_resolves_to_its_lower_uid() {
        let m = mailbox();
        seed(&m, &[(2, "a"), (5, "a")]);
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["a"])).unwrap(), vec![2]);
    }

    #[test]
    fn two_new_ids_sharing_a_message_id_get_the_file_and_a_fresh_uid() {
        let m = mailbox();
        file(&m, 1, "m");
        let entries = vec![
            ("g-x".to_string(), Some("<m@outlook.test>".to_string())),
            ("g-y".to_string(), Some("<m@outlook.test>".to_string())),
        ];
        assert_eq!(allocate(&m.ledger, &m.cur, &entries).unwrap(), vec![1, 2]);
    }

    #[test]
    fn a_message_without_a_message_id_takes_a_fresh_uid() {
        let m = mailbox();
        file(&m, 1, "m");
        assert_eq!(allocate(&m.ledger, &m.cur, &[("g-x".to_string(), None)]).unwrap(), vec![2]);
    }

    #[test]
    fn message_ids_match_with_or_without_angle_brackets() {
        let m = mailbox();
        file(&m, 1, "m");
        let entries = vec![("g-x".to_string(), Some("m@outlook.test".to_string()))];
        assert_eq!(allocate(&m.ledger, &m.cur, &entries).unwrap(), vec![1]);
    }

    #[test]
    fn a_file_deleted_since_it_was_read_is_not_adopted() {
        let m = mailbox();
        file(&m, 1, "m1");
        file(&m, 5, "m2");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m1"])).unwrap(), vec![1]);
        fs::remove_file(m.cur.join("5:2,.eml")).unwrap();
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m2"])).unwrap(), vec![2]);
    }

    #[test]
    fn a_uid_another_writer_took_is_not_adopted() {
        let m = mailbox();
        file(&m, 1, "m1");
        file(&m, 2, "m2");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m1"])).unwrap(), vec![1]);
        seed(&m, &[(1, "m1"), (2, "other")]);
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m2"])).unwrap(), vec![3]);
    }

    #[test]
    fn a_deleted_ledger_is_rebuilt_with_the_vaults_numbering() {
        // A ledger can still go missing on its own: deleted by hand, or a
        // vault moved or restored without its email_cache. The files stay,
        // and a rebuilt ledger must give them back their numbers.
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b"), (3, "c")]);
        for (uid, n) in [(1, "a"), (2, "b"), (3, "c")] { file(&m, uid, n); }
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["z", "a", "b", "c"])).unwrap(), vec![4, 1, 2, 3]);
        fs::remove_file(&m.ledger).unwrap();
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["z", "a", "b", "c"])).unwrap(), vec![4, 1, 2, 3]);
    }

    #[test]
    fn clearing_the_cache_keeps_every_ledger_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("email_cache");
        let inbox = cache.join("acct_INBOX"); // an Outlook mailbox: has a ledger
        let sent = cache.join("acct_Sent"); // an IMAP mailbox: no ledger
        fs::create_dir_all(inbox.join("nested")).unwrap();
        fs::create_dir_all(&sent).unwrap();
        let ledger = br#"{"1":"g-a","2":"g-b"}"#;
        fs::write(inbox.join(LEDGER_FILE), ledger).unwrap();
        fs::write(inbox.join("_meta.json"), b"{}").unwrap();
        fs::write(inbox.join("1.json"), b"{}").unwrap();
        fs::write(inbox.join("nested").join(LEDGER_FILE), ledger).unwrap(); // only a mailbox's own ledger is kept
        fs::write(sent.join("_meta.json"), b"{}").unwrap();
        fs::write(cache.join("acct_Old.json"), b"[]").unwrap(); // a legacy monolithic cache file

        clear_cache_keeping_ledgers(&cache);

        assert_eq!(fs::read(inbox.join(LEDGER_FILE)).unwrap(), ledger);
        let left: Vec<_> = fs::read_dir(&inbox).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from(LEDGER_FILE)]);
        assert!(!sent.exists(), "a mailbox cache without a ledger is removed whole");
        assert!(!cache.join("acct_Old.json").exists());
    }

    #[test]
    fn clearing_a_cache_that_does_not_exist_does_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        clear_cache_keeping_ledgers(&tmp.path().join("email_cache"));
        assert!(!tmp.path().join("email_cache").exists());
    }

    #[test]
    fn numbering_carries_on_after_the_cache_and_the_cached_bodies_are_cleared() {
        // "Clear cached emails" deletes every body the app cached and then the
        // email cache. Memory still files a..e under 1..5 and only two files
        // survive: the next new message must get 6, not 3.
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b"), (3, "c"), (4, "d"), (5, "e")]);
        file(&m, 1, "a");
        file(&m, 2, "b");
        clear_cache_keeping_ledgers(m.ledger.parent().unwrap().parent().unwrap());
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["new"])).unwrap(), vec![6]);
    }

    #[test]
    fn concurrent_allocations_never_share_a_uid() {
        let m = mailbox();
        let (ledger, cur) = (m.ledger.clone(), m.cur.clone());
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let (ledger, cur) = (ledger.clone(), cur.clone());
                std::thread::spawn(move || {
                    let entries: Vec<(String, Option<String>)> =
                        (0..10).map(|j| (format!("t{}-{}", t, j), None)).collect();
                    let uids = allocate(&ledger, &cur, &entries).unwrap();
                    entries.into_iter().map(|(id, _)| id).zip(uids).collect::<Vec<_>>()
                })
            })
            .collect();
        let pairs: Vec<(String, u32)> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
        let distinct: HashSet<u32> = pairs.iter().map(|(_, u)| *u).collect();
        assert_eq!(distinct.len(), 80);
        let disk = on_disk(&m);
        for (id, uid) in pairs {
            assert_eq!(disk.get(&uid), Some(&id));
        }
    }

    // --- fix round 1 ---

    #[cfg(unix)]
    #[test]
    fn a_vault_folder_that_cannot_be_listed_is_an_error_and_writes_nothing() {
        let m = mailbox();
        seed(&m, &[(1, "a")]);
        file(&m, 2, "b");
        let before = fs::read(&m.ledger).unwrap();
        set_mode(&m.cur, 0o000);
        let result = allocate(&m.ledger, &m.cur, &listed(&["new"]));
        set_mode(&m.cur, 0o755);
        assert!(result.is_err(), "{result:?}");
        assert_eq!(fs::read(&m.ledger).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn a_transient_message_id_read_error_is_retried_not_pinned_as_no_message_id() {
        let m = mailbox();
        file(&m, 1, "m1"); // unowned; ledger is empty
        set_mode(&m.cur.join("1:2,.eml"), 0o000);
        // The scan runs (the listed id carries a Message-ID) but uid 1 can't be
        // read; a fresh uid is issued instead of adopting it.
        let uids = allocate(&m.ledger, &m.cur, &listed(&["a"])).unwrap();
        assert_eq!(uids, vec![2]);
        set_mode(&m.cur.join("1:2,.eml"), 0o644);
        // Now readable: a later id sharing uid 1's Message-ID must still adopt
        // it, proving the earlier failed read was not cached as "no id".
        let entries = vec![("g-b".to_string(), Some("<m1@outlook.test>".to_string()))];
        assert_eq!(allocate(&m.ledger, &m.cur, &entries).unwrap(), vec![1]);
    }

    #[test]
    fn uid_space_exhausted_is_an_error_and_writes_nothing() {
        let m = mailbox();
        fs::write(m.cur.join("4294967295.eml"), eml("legacy@outlook.test")).unwrap();
        assert!(allocate(&m.ledger, &m.cur, &[("g-n".to_string(), None)]).is_err());
        assert!(!m.ledger.exists());
    }

    /// Rule 6: the floor is the higher of a legacy `cur/` name and an
    /// orphaned/set-aside one, in either direction (the earlier test only
    /// covered the orphaned file winning).
    #[test]
    fn the_floor_takes_the_higher_of_a_legacy_name_and_a_set_aside_file() {
        let m = mailbox();
        fs::write(m.cur.join("30.eml"), eml("legacy@outlook.test")).unwrap();
        let orphaned = m.cur.parent().unwrap().join(crate::maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphaned).unwrap();
        fs::write(orphaned.join("20:2,.eml"), eml("set-aside@outlook.test")).unwrap();
        let uids = allocate(&m.ledger, &m.cur, &[("g-n".to_string(), None)]).unwrap();
        assert_eq!(uids, vec![31]);
    }

    /// Rule 10, memo hit: a Message-ID read once for an unowned uid is not
    /// read again on a later call, even once the file becomes unreadable.
    #[cfg(unix)]
    #[test]
    fn a_memoized_message_id_is_reused_without_rereading_a_file_that_turned_unreadable() {
        let m = mailbox();
        file(&m, 1, "m1");
        file(&m, 2, "m2");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m1"])).unwrap(), vec![1]);
        set_mode(&m.cur.join("2:2,.eml"), 0o000);
        let result = allocate(&m.ledger, &m.cur, &listed(&["m2"]));
        set_mode(&m.cur.join("2:2,.eml"), 0o644);
        assert_eq!(result.unwrap(), vec![2]);
    }

    /// Rule 10, retain: a memo entry for a uid whose file left `cur/` is
    /// dropped, so a later file recreated at that uid is read fresh rather
    /// than adopted under the vanished file's stale Message-ID.
    #[test]
    fn a_stale_memo_entry_for_a_deleted_file_is_not_reused_when_its_uid_is_recreated() {
        let m = mailbox();
        file(&m, 1, "m1");
        file(&m, 5, "m2");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m1"])).unwrap(), vec![1]);
        fs::remove_file(m.cur.join("5:2,.eml")).unwrap();
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["other"])).unwrap(), vec![2]);
        file(&m, 5, "m3");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m3"])).unwrap(), vec![5]);
    }

    /// Same shape, but with a third file (uid 9) that is never listed, so it
    /// stays unowned for the whole test and the directory's memo is never
    /// fully dropped (rule 10's "nothing left to adopt" drop needs every
    /// canonical uid owned). That isolates the per-uid `retain`: without it,
    /// this would still fail even though the test above, where the memo gets
    /// dropped wholesale between the second and third call anyway, would not.
    #[test]
    fn retain_alone_drops_a_stale_entry_when_the_directory_memo_survives() {
        let m = mailbox();
        file(&m, 1, "m1");
        file(&m, 5, "m2");
        file(&m, 9, "keep");
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["m1"])).unwrap(), vec![1]);
        fs::remove_file(m.cur.join("5:2,.eml")).unwrap();
        allocate(&m.ledger, &m.cur, &listed(&["other"])).unwrap();
        file(&m, 5, "m3");
        let entries = vec![("g-m3".to_string(), Some("<m3@outlook.test>".to_string()))];
        assert_eq!(allocate(&m.ledger, &m.cur, &entries).unwrap(), vec![5]);
    }

    /// Rule 8: nothing unseen means `allocate` never scans `cur/` at all, not
    /// just that it skips the write — an unlistable `cur/` must not surface as
    /// an error when there was nothing to look up in it.
    #[cfg(unix)]
    #[test]
    fn nothing_unseen_never_scans_the_directory() {
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b")]);
        set_mode(&m.cur, 0o000);
        let result = allocate(&m.ledger, &m.cur, &listed(&["b", "a"]));
        set_mode(&m.cur, 0o755);
        assert_eq!(result.unwrap(), vec![2, 1]);
    }
}
