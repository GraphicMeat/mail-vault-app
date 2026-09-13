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
//!   on disk carries, so a copy filed under some older numbering can never block
//!   the message the ledger hands that number to.

use crate::fsx;
use crate::maildir::{mirror_filename_uid, normalize_message_id, read_message_id, vault_filename_uid, ORPHAN_DIR};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub const LEDGER_FILE: &str = "graph_id_map.json";

/// uid -> Graph message id.
pub type Ledger = BTreeMap<u32, String>;

/// Held for a whole load-allocate-persist, so the app's listings and the backup
/// never allocate from the same stale read. The value is a memo of the
/// Message-IDs read from vault files, per `cur/` dir and uid: the app seeds a
/// folder 200 ids at a time, and reading every file again per page is quadratic.
// ponytail: process-wide lock; two processes on one vault (two Macs on a NAS
// vault) can still race, add a file lock on the ledger if that is supported.
// The memo trusts a uid's file never to change content, true for Graph
// mailboxes today; re-read when a file's length changes if that stops holding.
static STATE: LazyLock<Mutex<HashMap<PathBuf, HashMap<u32, Option<String>>>>> =
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

fn scan(cur_dir: &Path) -> DiskView {
    let mut view = DiskView { highest: 0, canonical: HashMap::new() };
    let orphaned = cur_dir.parent().map(|mailbox| mailbox.join(ORPHAN_DIR));
    for (dir, is_cur) in [(Some(cur_dir.to_path_buf()), true), (orphaned, false)] {
        let Some(dir) = dir else { continue };
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
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
    view
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
        let disk = scan(cur_dir);

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
                if let Some(message_id) = read.entry(uid).or_insert_with(|| read_message_id(path)) {
                    adoptable.entry(message_id.clone()).or_insert(uid);
                }
            }
        }

        let mut next = ledger.keys().next_back().copied().unwrap_or(0).max(disk.highest);
        for (id, message_id) in unseen {
            let adopted = message_id.map(normalize_message_id).and_then(|m| adoptable.remove(&m));
            let uid = adopted.unwrap_or_else(|| {
                next += 1;
                next
            });
            ledger.insert(uid, id.to_string());
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
    fn set_read_only(dir: &Path, read_only: bool) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(if read_only { 0o555 } else { 0o755 })).unwrap();
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
        set_read_only(&dir, true);
        let result = allocate(&m.ledger, &m.cur, &listed(&["a", "new"]));
        set_read_only(&dir, false);
        assert!(result.is_err());
        assert_eq!(fs::read(&m.ledger).unwrap(), before);
    }

    #[test]
    #[cfg(unix)]
    fn writes_nothing_when_every_listed_id_is_known() {
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b")]);
        let dir = m.ledger.parent().unwrap().to_path_buf();
        set_read_only(&dir, true); // any write attempt would fail
        let result = allocate(&m.ledger, &m.cur, &listed(&["b", "a"]));
        set_read_only(&dir, false);
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
        // Clearing the email cache deletes the ledger. The files stay, and a
        // rebuilt ledger must give them back their numbers.
        let m = mailbox();
        seed(&m, &[(1, "a"), (2, "b"), (3, "c")]);
        for (uid, n) in [(1, "a"), (2, "b"), (3, "c")] { file(&m, uid, n); }
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["z", "a", "b", "c"])).unwrap(), vec![4, 1, 2, 3]);
        fs::remove_file(&m.ledger).unwrap();
        assert_eq!(allocate(&m.ledger, &m.cur, &listed(&["z", "a", "b", "c"])).unwrap(), vec![4, 1, 2, 3]);
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
}
