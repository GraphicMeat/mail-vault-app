//! One read-state change, landed on every durable copy the vault keeps of a
//! message. Root-based half of `src-tauri/src/vault_flags.rs` (plan Task 2.4
//! Step 3): the app keeps the three Tauri commands plus a thin
//! `apply_everywhere` shim that supplies a custody-patch closure; everything
//! that does not need an `AppHandle` lives here so a future daemon router
//! (Task 2.9a) can call it directly.
//!
//! Read state lived in six places and had one writer each, or none. The server
//! got the STORE, memory and the custody entry got the flip, and the Maildir
//! file name — which restore, the external mirror and every `.eml` read treat
//! as the message's flags — kept whatever it was stored with, which was always
//! "seen". So a restore uploaded every vault message as read, a vault row
//! rebuilt from its file rendered unread whatever had been done to it, and the
//! mirror never learned about a change at all.
//!
//! `apply_files` is the one writer for the files: the name (app dir and mirror)
//! and the cached header (in `custody.db`, through the caller's closure).
//! `apply_everywhere`
//! is that call plus the custody entry's flags, both under `WRITER` — the
//! app's mark read/unread and the backup run's reconcile both go through it.

use std::fs;
use std::path::{Path, PathBuf};

use crate::graph_ledger;
use crate::maildir::mirror_file_map;
use crate::vault_eml::parse_flags_from_filename;
use crate::vault_files::{build_maildir_filename, cur_path};
use crate::vault_registry::VaultRegistry;
use crate::header_cache;
use serde::{Deserialize, Serialize};
use tracing::warn;

/// One message's flags as the server names them: `\Seen`, `\Flagged`,
/// `\Answered`. The full list, not a delta — what the message has now.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlagChange {
    pub uid: u32,
    pub flags: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Applied {
    pub renamed: usize,
    pub mirrored: usize,
    pub index_patched: usize,
    pub sidecars_patched: usize,
}

impl Applied {
    pub fn total(&self) -> usize {
        self.renamed + self.mirrored + self.index_patched + self.sidecars_patched
    }
}

/// Maildir flags for a fresh vault copy of a server message: archived, plus
/// whatever the server says. `seen` used to be hardcoded here, which is where
/// every downstream lie about a vault message's read state began.
pub fn store_flags(imap: &[String]) -> Vec<String> {
    merge_flags(&["archived".to_string()], imap)
}

/// Maildir flags after `imap` is applied over `current`: the local-only words
/// (archived, draft, trashed) survive from `current`, seen/flagged/replied
/// follow the server. `archived` is also ADDED when the change asks for it,
/// which is how the backup vouches for a copy it counted as backed up; the
/// app's own callers pass a row's IMAP flag list, and a row only says
/// `archived` when its file already has `A`.
pub fn merge_flags(current: &[String], imap: &[String]) -> Vec<String> {
    let mut out: Vec<String> = current
        .iter()
        .map(|f| f.to_lowercase())
        .filter(|f| matches!(f.as_str(), "archived" | "draft" | "trashed"))
        .collect();
    let has = |name: &str| imap.iter().any(|f| f.eq_ignore_ascii_case(name));
    if has("archived") {
        out.push("archived".into());
    }
    if has("\\Seen") {
        out.push("seen".into());
    }
    if has("\\Flagged") {
        out.push("flagged".into());
    }
    if has("\\Answered") {
        out.push("replied".into());
    }
    out.sort();
    out.dedup();
    out
}

/// Where one mailbox keeps its copies.
pub struct Dirs {
    /// `Maildir/<account>/<mailbox>/cur/`
    pub cur: PathBuf,
    /// `<backup root>/<email>/<mailbox>/cur/`, when an external location is
    /// configured and reachable.
    pub mirror_cur: Option<PathBuf>,
    /// `email_cache/<account>_<mailbox>/` — the directory a mailbox rename
    /// still has to carry, because the Outlook uid ledger lives in it.
    pub sidecar_dir: PathBuf,
    /// The vault root, for `header_cache`'s tree lock: a `clear` must not run
    /// while this module is moving a sidecar directory. Private — a caller
    /// only ever gets a `Dirs` back from `dirs_for`.
    root: PathBuf,
    /// Whose `cur` this is, for the vault registry's rows.
    account_id: String,
    mailbox: String,
}

pub fn dirs_for(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    mirror_root: Option<&str>,
) -> Dirs {
    let cur = cur_path(root, account_id, mailbox);
    let mirror_cur = match (mirror_root, account_email) {
        (Some(mirror_root), Some(email)) => Some(PathBuf::from(mirror_root).join(email).join(mailbox).join("cur")),
        _ => None,
    };
    Dirs {
        cur,
        mirror_cur,
        sidecar_dir: header_cache::sidecar_dir(root, account_id, mailbox),
        root: root.to_path_buf(),
        account_id: account_id.to_string(),
        mailbox: mailbox.to_string(),
    }
}

/// One writer at a time per process: two callers renaming the same folder's
/// files at once would race on the names. `apply_everywhere` holds it across
/// the custody patch too, so the file name and the custody entry can never be
/// left disagreeing by two callers applying opposite flags to the same uid.
///
/// Non-reentrant: `apply_everywhere` calls `apply_files`, never the locking
/// `apply_in` (test-only).
///
/// ponytail: the lock now spans a custody write as well as the renames. Both
/// callers already run this off the main thread, and the write is one
/// transaction over the uids in hand.
static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The test seam for the locked file half: `apply_files` under `WRITER`, which
/// is what `apply_everywhere` does before it also patches custody.
#[cfg(test)]
pub fn apply_in(reg: &VaultRegistry, dirs: &Dirs, changes: &[FlagChange]) -> Applied {
    let _one_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    apply_files(reg, dirs, changes)
}

/// Land `changes` on every copy under `dirs`. Silent about a message the vault
/// does not hold — there is nothing to rename or patch, and the counts say so.
/// No lock of its own: the caller holds `WRITER`.
///
/// Every app-side rename renames the registry row too, never an invalidate:
/// every star and read toggle comes through here, and an invalidate would
/// relist the folder on the next read.
fn apply_files(reg: &VaultRegistry, dirs: &Dirs, changes: &[FlagChange]) -> Applied {
    let mut out = Applied::default();
    if changes.is_empty() {
        return out;
    }

    // One listing per directory: the per-uid finders rescan on every call, and
    // a backup reconcile hands this every message the folder holds.
    // Every shape the vault and the mirror have written starts with the uid:
    // `<uid>:2,<flags>[.eml]`, `<uid>.eml`, `<uid>_<flags>.eml`.
    let app_files = mirror_file_map(&dirs.cur);
    let mirror_files = dirs.mirror_cur.as_deref().map(mirror_file_map);

    for change in changes {
        let imap = &change.flags;

        if let Some(path) = app_files.get(&change.uid) {
            match rename_for(path, change.uid, imap) {
                Ok(Some(new_name)) => {
                    reg.rename(&dirs.account_id, &dirs.mailbox, change.uid, &new_name);
                    out.renamed += 1;
                }
                Ok(None) => {}
                Err(e) => warn!("vault_flags: rename uid {} failed: {}", change.uid, e),
            }
        }

        if let Some(files) = &mirror_files {
            if let Some(path) = files.get(&change.uid) {
                match rename_for(path, change.uid, imap) {
                    Ok(Some(_)) => out.mirrored += 1,
                    Ok(None) => {}
                    Err(e) => warn!("vault_flags: mirror rename uid {} failed: {}", change.uid, e),
                }
            }
        }

    }

    out
}

/// `apply_files` plus the custody entry's flags: the one call the app's mark
/// read/unread and the backup's catch-up both make. `patch_custody` receives
/// `(uid, flags)` pairs for every change and returns `(custody entries,
/// cached headers)` touched — whether it patches the header cache at all is
/// the caller's call: the app's mark read/unread wants it (the next repaint
/// reads from there, and a server-only message has no other copy), the backup
/// reconcile does not. It is called under `WRITER`,
/// so a caller building it from an `AppHandle` (the app's own shim) or a
/// daemon connection (Task 2.9a) never sees the lock released between the
/// file rename and the custody write.
///
/// Both halves run under one `WRITER` acquisition. The name and the custody
/// entry are two records of the same fact, and the app's mark read/unread and
/// the backup's catch-up are exactly the pair that can apply opposite flags to
/// one uid at the same moment: patching custody after the lock was released
/// let the name say read while the entry said unread.
pub fn apply_everywhere(
    reg: &VaultRegistry,
    dirs: &Dirs,
    changes: &[FlagChange],
    patch_custody: impl FnOnce(&[(u32, Vec<String>)]) -> Result<(usize, usize), String>,
) -> Applied {
    if changes.is_empty() {
        return Applied::default();
    }
    let _one_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let mut applied = apply_files(reg, dirs, changes);
    let patch: Vec<(u32, Vec<String>)> = changes.iter().map(|c| (c.uid, c.flags.clone())).collect();
    match patch_custody(&patch) {
        Ok((entries, headers)) => {
            applied.index_patched = entries;
            applied.sidecars_patched = headers;
        }
        Err(e) => warn!("vault_flags: custody patch failed: {}", e),
    }
    applied
}

/// Rename `path` so its flag letters carry `imap`. `Some(new name)` when the
/// name changed, `None` when it already said this.
fn rename_for(path: &Path, uid: u32, imap: &[String]) -> Result<Option<String>, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let current = parse_flags_from_filename(&name);
    let new_name = build_maildir_filename(uid, &merge_flags(&current, imap));
    if new_name == name {
        return Ok(None);
    }
    fs::rename(path, path.with_file_name(&new_name)).map_err(|e| e.to_string())?;
    Ok(Some(new_name))
}

/// One mailbox path change. The JS sends one pair per renamed folder AND one
/// per descendant, because a server's RENAME moves the whole subtree in a
/// single command while the vault keeps a directory per full mailbox path.
#[derive(Debug, Serialize, Deserialize)]
pub struct RenamePair {
    pub from: String,
    pub to: String,
}

/// Move the three locations `from` has to `to`: the Maildir mailbox DIRECTORY
/// (parent of `cur/`, so `.uidvalidity` travels with it), the sidecar cache,
/// the mirror. Missing sources are skipped; returns how many moved and which
/// ones ERRORED. Nothing is ever deleted here.
///
/// The two are not the same answer: a source that was never there is a
/// non-event, a source that failed to move leaves the vault half-renamed and
/// the user has to be told. A count alone cannot tell them apart, which is
/// how a failed rename used to end up as a `warn!` nobody reads.
///
/// Two of the three are flat: `cur_path` and `cache_base_name` sanitize the
/// WHOLE mailbox path into one directory name, so `Projects` and
/// `Projects/Alpha` are siblings and their pairs never interact. The mirror
/// uses the raw path, so it nests, and renaming `Projects` there carries
/// `Projects/Alpha` along with it. That is harmless as long as the parent pair
/// runs first, which is why `vault_rename_mailbox` sorts shallowest-first: the
/// descendant's pair then finds its source already gone and skips.
pub fn rename_dirs(reg: &VaultRegistry, from: &Dirs, to: &Dirs) -> (usize, Vec<String>) {
    fn up(p: &Path) -> Option<PathBuf> {
        p.parent().map(|q| q.to_path_buf())
    }
    fn do_move(src: &Path, dst: &Path, moved: &mut usize, failed: &mut Vec<String>) {
        if !src.exists() || dst.exists() {
            return; // ponytail: an existing destination is left alone; merge if it ever matters
        }
        if let Some(p) = dst.parent() {
            let _ = fs::create_dir_all(p);
        }
        match fs::rename(src, dst) {
            Ok(()) => *moved += 1,
            Err(e) => {
                warn!("vault_rename: {:?} -> {:?}: {}", src, dst, e);
                failed.push(format!("{} ({})", src.display(), e));
            }
        }
    }

    let mut moved = 0;
    let mut failed = Vec::new();

    if let (Some(a), Some(b)) = (up(&from.cur), up(&to.cur)) {
        do_move(&a, &b, &mut moved, &mut failed);
        // A mailbox directory that moved, or failed part-way, changed both
        // sides: each lists again on its next read.
        if moved + failed.len() > 0 {
            reg.invalidate(&from.account_id, &from.mailbox);
            reg.invalidate(&to.account_id, &to.mailbox);
        }
    }

    // M-3 (final fix wave): the sidecar dir MOVE also needs the header-cache
    // tree lock, not just the ledger lock — `header_cache::clear` is the
    // other holder of it, and both it and `rename_dirs` are `vault_gate(read)`
    // holders that can otherwise run in parallel over the same directory.
    // Tree lock taken WRITE and OUTSIDE
    // (before) the ledger lock, keeping the same `L3a < L5a` order every read
    // path already uses (`with_ledger_lock` inside `lock_tree`, never the
    // reverse — that ordering is what keeps the whole lock graph acyclic).
    let tree = header_cache::lock_tree(&from.root);
    let _tree_write = tree.write().unwrap_or_else(|e| e.into_inner());

    // The sidecar dir carries `graph_id_map.json`: hold the vault-wide ledger
    // lock across this one move so an in-flight `allocate` for the OLD name
    // (Task 2.9a: from another process) can never persist the ledger back
    // into the directory this just moved out from under it (2.4 review
    // forward constraint F2). Same three-tier lock `allocate` itself takes —
    // a vault too unwritable to take the lock is also too unwritable to move
    // anything into, so a lock failure here is reported like any other.
    match from.sidecar_dir.parent() {
        Some(email_cache_dir) => {
            let (mut m, mut f) = (0, Vec::new());
            match graph_ledger::with_ledger_lock(email_cache_dir, || do_move(&from.sidecar_dir, &to.sidecar_dir, &mut m, &mut f)) {
                Ok(()) => {
                    moved += m;
                    failed.extend(f);
                }
                Err(e) => {
                    warn!("vault_rename: could not take the ledger lock for {}: {}", email_cache_dir.display(), e);
                    failed.push(format!("{} (ledger lock: {})", from.sidecar_dir.display(), e));
                }
            }
        }
        None => do_move(&from.sidecar_dir, &to.sidecar_dir, &mut moved, &mut failed),
    }

    if let (Some(a), Some(b)) = (
        from.mirror_cur.as_deref().and_then(up),
        to.mirror_cur.as_deref().and_then(up),
    ) {
        do_move(&a, &b, &mut moved, &mut failed);
    }

    (moved, failed)
}

/// What one `adopt_dirs` call did. `moved` and `blocked` count locations,
/// `blocked_by` names the destinations that already existed — a blocked adoption
/// leaves a legacy directory on disk and this is the only trace a support log
/// will have of it — and `failed` carries renames the filesystem refused.
#[derive(Debug, Default)]
pub struct Adopted {
    pub moved: usize,
    /// How many of `moved` were app-side locations. The custody rows follow the
    /// app's files, not the mirror, so the caller renames them on this and not
    /// on `moved`.
    pub app_moved: usize,
    pub blocked: usize,
    pub blocked_by: Vec<String>,
    pub failed: Vec<String>,
}

/// Move a mailbox written under a legacy localized name (`from`) under its
/// storage key (`to`), the one-time adoption for Graph accounts.
///
/// The two app-side locations (the Maildir mailbox dir and the sidecar dir with
/// the uid ledger) move as a UNIT, and only when neither destination exists:
/// moving one without the other would pair one ledger with another numbering's
/// vault files. There is no third: the local index and the archived-headers
/// cache are not locations any more, their contents live in the custody store,
/// and the caller renames those rows when `app_moved` says the app side moved.
/// The mirror moves on its own, when its source exists and its destination does
/// not. `fs::rename` only; nothing is deleted, an existing destination is left
/// alone and counted as blocked.
pub fn adopt_dirs(reg: &VaultRegistry, from: &Dirs, to: &Dirs) -> Adopted {
    fn up(p: &Path) -> Option<PathBuf> {
        p.parent().map(|q| q.to_path_buf())
    }
    fn mv(src: &Path, dst: &Path, moved: &mut usize, failed: &mut Vec<String>) {
        if let Some(p) = dst.parent() {
            let _ = fs::create_dir_all(p);
        }
        match fs::rename(src, dst) {
            Ok(()) => *moved += 1,
            Err(e) => {
                warn!("vault_adopt: {:?} -> {:?}: {}", src, dst, e);
                failed.push(format!("{} ({})", src.display(), e));
            }
        }
    }

    let mut out = Adopted::default();
    let app_side: Vec<(PathBuf, PathBuf)> = [
        (up(&from.cur), up(&to.cur)),
        (Some(from.sidecar_dir.clone()), Some(to.sidecar_dir.clone())),
    ]
    .into_iter()
    .filter_map(|(a, b)| Some((a?, b?)))
    .collect();

    if app_side.iter().any(|(src, _)| src.exists()) {
        let existing: Vec<String> = app_side
            .iter()
            .filter(|(_, dst)| dst.exists())
            .map(|(_, dst)| dst.display().to_string())
            .collect();
        if !existing.is_empty() {
            out.blocked += 1;
            out.blocked_by.extend(existing);
        } else {
            for (src, dst) in &app_side {
                if !src.exists() {
                    continue;
                }
                // The sidecar dir carries `graph_id_map.json`: hold the
                // vault-wide ledger lock across this one move, same as
                // `rename_dirs` (2.4 review forward constraint F2). M-3
                // (final fix wave): the header-cache tree lock too, taken
                // WRITE and OUTSIDE the ledger lock — same reasoning and
                // same `L3a < L5a` order as `rename_dirs` above.
                if *src == from.sidecar_dir {
                    let tree = header_cache::lock_tree(&from.root);
                    let _tree_write = tree.write().unwrap_or_else(|e| e.into_inner());
                    match from.sidecar_dir.parent() {
                        Some(email_cache_dir) => {
                            let (mut m, mut f) = (0, Vec::new());
                            match graph_ledger::with_ledger_lock(email_cache_dir, || mv(src, dst, &mut m, &mut f)) {
                                Ok(()) => {
                                    out.moved += m;
                                    out.failed.extend(f);
                                }
                                Err(e) => {
                                    warn!(
                                        "vault_adopt: could not take the ledger lock for {}: {}",
                                        email_cache_dir.display(),
                                        e
                                    );
                                    out.failed.push(format!("{} (ledger lock: {})", src.display(), e));
                                }
                            }
                        }
                        None => mv(src, dst, &mut out.moved, &mut out.failed),
                    }
                } else {
                    mv(src, dst, &mut out.moved, &mut out.failed);
                    // The Maildir mailbox directory moved (or failed
                    // part-way): both sides list again on their next read.
                    reg.invalidate(&from.account_id, &from.mailbox);
                    reg.invalidate(&to.account_id, &to.mailbox);
                }
            }
        }
    }
    // The mirror has not run yet, so everything counted so far is app-side.
    out.app_moved = out.moved;

    if let (Some(src), Some(dst)) = (
        from.mirror_cur.as_deref().and_then(up),
        to.mirror_cur.as_deref().and_then(up),
    ) {
        if src.exists() {
            if dst.exists() {
                out.blocked += 1;
                out.blocked_by.push(dst.display().to_string());
            } else {
                mv(&src, &dst, &mut out.moved, &mut out.failed);
            }
        }
    }
    out
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdoptReport {
    pub adopted: Vec<String>,
    pub skipped_both_exist: Vec<String>,
    pub failed: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_fresh_vault_copy_carries_the_servers_read_state_not_a_hardcoded_seen() {
        assert_eq!(store_flags(&s(&[])), s(&["archived"]));
        assert_eq!(store_flags(&s(&["\\Seen"])), s(&["archived", "seen"]));
        assert_eq!(store_flags(&s(&["\\Flagged", "\\Seen"])), s(&["archived", "flagged", "seen"]));
        assert_eq!(store_flags(&s(&["\\Answered"])), s(&["archived", "replied"]));
    }

    #[test]
    fn merging_keeps_the_local_words_and_lets_the_server_own_the_rest() {
        // Read on the server: seen appears, archived stays.
        assert_eq!(merge_flags(&s(&["archived"]), &s(&["\\Seen"])), s(&["archived", "seen"]));
        // Unread again: seen goes, archived stays.
        assert_eq!(merge_flags(&s(&["archived", "seen"]), &s(&[])), s(&["archived"]));
        // A draft's D and a trashed T are not the server's to clear.
        assert_eq!(merge_flags(&s(&["draft", "seen", "trashed"]), &s(&[])), s(&["draft", "trashed"]));
        // The IMAP names a .eml read now reports alongside the words are not
        // re-read as words — only the words decide what survives.
        assert_eq!(merge_flags(&s(&["archived", "seen", "\\Seen"]), &s(&[])), s(&["archived"]));
    }

    /// `archived` is the one local word a change may ADD: it is how the backup
    /// vouches for a copy it counted, so an auto-cached flagless file gains `A`.
    /// Never on its own — only when the change asks for it.
    #[test]
    fn a_change_that_asks_for_archived_adds_it_and_nothing_else_does() {
        assert_eq!(merge_flags(&s(&[]), &s(&["\\Seen", "archived"])), s(&["archived", "seen"]));
        assert_eq!(merge_flags(&s(&["seen"]), &s(&["archived"])), s(&["archived"]));
        assert_eq!(merge_flags(&s(&[]), &s(&["\\Seen"])), s(&["seen"]));
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        dirs: Dirs,
        reg: VaultRegistry,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let cur = base.join("Maildir").join("acct").join("INBOX").join("cur");
        let mirror = base.join("mirror").join("me@mock.test").join("INBOX").join("cur");
        let sidecar_dir = base.join("email_cache").join("acct_INBOX");
        let app = base.join("app");
        for d in [&cur, &mirror, &sidecar_dir, &app] {
            fs::create_dir_all(d).unwrap();
        }
        Fixture {
            dirs: Dirs {
                cur,
                mirror_cur: Some(mirror),
                sidecar_dir,
                root: base.to_path_buf(),
                account_id: "acct".into(),
                mailbox: "INBOX".into(),
            },
            reg: VaultRegistry::open(&app, base),
            _tmp: tmp,
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }


    fn change(uid: u32, flags: &[&str]) -> FlagChange {
        FlagChange { uid, flags: s(flags) }
    }

    /// The lock is taken exactly once on the way in. Not a race detector: a
    /// second acquisition on either path would hang this test rather than fail
    /// it, which is the failure the `apply_in`/`apply_files` split has to avoid
    /// now that `apply_everywhere` takes `WRITER` itself.
    #[test]
    fn two_callers_of_apply_in_both_complete_under_the_one_writer_lock() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("1{INFO_PREFIX}.eml")), b"body").unwrap();
        fs::write(d.cur.join(format!("2{INFO_PREFIX}.eml")), b"body").unwrap();

        let (first, second) = std::thread::scope(|scope| {
            let a = scope.spawn(|| apply_in(&f.reg, d, &[change(1, &["\\Seen"])]));
            let b = scope.spawn(|| apply_in(&f.reg, d, &[change(2, &["\\Seen"])]));
            (a.join().unwrap(), b.join().unwrap())
        });

        assert_eq!(first.renamed, 1);
        assert_eq!(second.renamed, 1);
        assert_eq!(names(&d.cur), vec![format!("1{INFO_PREFIX}S.eml"), format!("2{INFO_PREFIX}S.eml")]);
    }

    #[test]
    fn marking_read_renames_the_file_and_its_mirror_copy() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("7{INFO_PREFIX}A")), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join(format!("7{INFO_PREFIX}A.eml")), b"body").unwrap();

        let applied = apply_in(&f.reg, d, &[change(7, &["\\Seen"])]);

        // The cached header is the caller's closure now (custody.db), so
        // `apply_files` itself only ever touches the two file copies.
        assert_eq!(applied, Applied { renamed: 1, mirrored: 1, index_patched: 0, sidecars_patched: 0 });
        // The legacy extension-less name converges on the current one.
        assert_eq!(names(&d.cur), vec![format!("7{INFO_PREFIX}AS.eml")]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec![format!("7{INFO_PREFIX}AS.eml")]);
    }

    /// The backup's catch-up over a copy the app auto-cached when the message
    /// was opened: flagless in the vault, legacy-named on the mirror. The run
    /// counted it as backed up, so both copies come out carrying `A`.
    #[test]
    fn a_change_asking_for_archived_puts_the_letter_on_the_vault_and_mirror_copies() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("9{INFO_PREFIX}.eml")), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join("9.eml"), b"body").unwrap();

        let applied = apply_in(&f.reg, d, &[change(9, &["\\Seen", "archived"])]);

        assert_eq!(applied.renamed, 1);
        assert_eq!(applied.mirrored, 1);
        assert_eq!(names(&d.cur), vec![format!("9{INFO_PREFIX}AS.eml")]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec![format!("9{INFO_PREFIX}AS.eml")]);
    }

    #[test]
    fn marking_unread_takes_the_letter_off_again_and_leaves_the_rest_alone() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("7{INFO_PREFIX}AS.eml")), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join(format!("7{INFO_PREFIX}AS.eml")), b"body").unwrap();

        let applied = apply_in(&f.reg, d, &[change(7, &[])]);

        assert_eq!(applied, Applied { renamed: 1, mirrored: 1, index_patched: 0, sidecars_patched: 0 });
        // The .eml suffix the file had is kept.
        assert_eq!(names(&d.cur), vec![format!("7{INFO_PREFIX}A.eml")]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec![format!("7{INFO_PREFIX}A.eml")]);
    }

    #[test]
    fn a_change_the_copies_already_carry_is_a_no_op() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("7{INFO_PREFIX}AS.eml")), b"body").unwrap();

        let applied = apply_in(&f.reg, d, &[change(7, &["\\Seen"])]);

        assert_eq!(applied, Applied::default());
        assert_eq!(names(&d.cur), vec![format!("7{INFO_PREFIX}AS.eml")]);
    }

    #[test]
    fn a_message_the_vault_does_not_hold_changes_nothing_and_says_so() {
        let f = fixture();
        let d = &f.dirs;

        let applied = apply_in(&f.reg, d, &[change(9, &["\\Seen"]), change(10, &["\\Seen"])]);

        assert_eq!(applied, Applied::default());
    }

    #[test]
    fn a_legacy_mirror_name_is_brought_up_to_the_flagged_shape() {
        let f = fixture();
        let d = &f.dirs;
        let mirror = d.mirror_cur.as_ref().unwrap();
        fs::write(mirror.join("7.eml"), b"body").unwrap();

        let applied = apply_in(&f.reg, d, &[change(7, &["\\Seen"])]);

        assert_eq!(applied.mirrored, 1);
        assert_eq!(names(mirror), vec![format!("7{INFO_PREFIX}S.eml")]);
    }

    #[test]
    fn a_backup_reconcile_touches_only_the_copies_that_disagree() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("1{INFO_PREFIX}A.eml")), b"a").unwrap();
        fs::write(d.cur.join(format!("2{INFO_PREFIX}AS.eml")), b"b").unwrap();
        fs::write(d.cur.join(format!("3{INFO_PREFIX}AS.eml")), b"c").unwrap();

        // The server: 1 was read elsewhere, 2 is as stored, 3 was marked unread.
        let applied = apply_in(&f.reg, d, &[change(1, &["\\Seen"]), change(2, &["\\Seen"]), change(3, &[])]);

        assert_eq!(applied, Applied { renamed: 2, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
        assert_eq!(names(&d.cur), vec![format!("1{INFO_PREFIX}AS.eml"), format!("2{INFO_PREFIX}AS.eml"), format!("3{INFO_PREFIX}A.eml")]);
    }

    /// `apply_everywhere` holds `WRITER` for one call spanning both halves: a
    /// second caller's callback must not START until the first's callback has
    /// RETURNED. An ordering probe, not a total-wall-time guess (2.4 review
    /// I1: the old version asserted `elapsed >= SLOW_MS`, which held even
    /// with `WRITER.lock()` deleted, because `start` was taken before either
    /// thread spawned and the two callbacks' sleeps summed past `SLOW_MS`
    /// regardless of ordering).
    ///
    /// `state` goes 0 -> 1 (A entered its callback) -> 2 (A's callback
    /// returned). B polls for `1` before calling `apply_everywhere` at all —
    /// a bounded handshake, not a fixed sleep guessing when A's thread has
    /// been scheduled (the same flake class M1 removes from the ledger-lock
    /// subprocess test) — so B is provably already trying to enter its own
    /// callback while A is inside its callback. If `WRITER` did not span the
    /// callback, B's callback could run while `state` is still `1`.
    #[test]
    fn writer_spans_the_custody_callback_not_just_the_file_rename() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join(format!("1{INFO_PREFIX}.eml")), b"body").unwrap();
        fs::write(d.cur.join(format!("2{INFO_PREFIX}.eml")), b"body").unwrap();
        const SLOW_MS: u64 = 150;

        let state = std::sync::atomic::AtomicU8::new(0);
        let state = &state;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                apply_everywhere(&f.reg, d, &[change(1, &["\\Seen"])], |_patch| {
                    state.store(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(SLOW_MS));
                    state.store(2, std::sync::atomic::Ordering::SeqCst);
                    Ok((1, 0))
                })
            });

            // Wait until A is provably inside its callback (bounded, not a
            // fixed guess) before B even calls apply_everywhere.
            let poll_start = std::time::Instant::now();
            while state.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                assert!(poll_start.elapsed() < std::time::Duration::from_secs(10), "A never entered its callback");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }

            scope.spawn(|| {
                apply_everywhere(&f.reg, d, &[change(2, &["\\Seen"])], |_patch| {
                    assert_eq!(
                        state.load(std::sync::atomic::Ordering::SeqCst),
                        2,
                        "B's callback must not start until A's callback has returned"
                    );
                    Ok((1, 0))
                })
            });
        });
    }

    /// Every star or read toggle comes through here: the registry row follows
    /// the rename in place, with no relisting and no reparse.
    #[test]
    fn apply_everywhere_renames_the_registry_rows_without_a_relisting_or_a_reparse() {
        let f = fixture();
        let d = &f.dirs;
        let root = f._tmp.path();
        fs::write(d.cur.join(format!("7{INFO_PREFIX}A.eml")), b"From: a@x.test\r\nSubject: seven\r\n\r\nbody\r\n").unwrap();
        let rows = f.reg.light_rows(root, "acct", "INBOX", None).unwrap();
        assert_eq!(rows[0]["flags"], serde_json::json!(["archived"]));
        assert_eq!((f.reg.listing_count(), f.reg.parse_count()), (1, 1));

        let applied = apply_everywhere(&f.reg, d, &[change(7, &["\\Seen", "\\Flagged"])], |_patch| Ok((0, 0)));
        assert_eq!(applied.renamed, 1);

        assert_eq!(f.reg.resolve(root, "acct", "INBOX", 7), Some(Some(d.cur.join(format!("7{INFO_PREFIX}AFS.eml")))));
        let rows = f.reg.light_rows(root, "acct", "INBOX", Some(&[7])).unwrap();
        assert_eq!(rows[0]["subject"], "seven", "the light row survives the rename");
        assert_eq!(rows[0]["flags"], serde_json::json!(["archived", "flagged", "seen", "\\Seen", "\\Flagged"]));
        assert_eq!((f.reg.listing_count(), f.reg.parse_count()), (1, 1), "no relisting, no reparse");
    }

    /// A `Dirs` pair for one mailbox rename, laid out the way `dirs_for` builds
    /// it: a sanitized Maildir/sidecar name, a raw path for the mirror.
    fn rename_fixture(base: &Path, mailbox: &str, sidecar: &str) -> Dirs {
        Dirs {
            cur: base.join("Maildir").join("a").join(mailbox).join("cur"),
            mirror_cur: Some(base.join("mirror").join("me@x").join(mailbox).join("cur")),
            sidecar_dir: base.join("email_cache").join(sidecar),
            root: base.to_path_buf(),
            account_id: "a".into(),
            mailbox: mailbox.into(),
        }
    }

    /// A registry for `base`, its file in a tempdir of its own so the
    /// "nothing deleted" file counts under `base` never see it.
    fn registry_at(base: &Path) -> (tempfile::TempDir, VaultRegistry) {
        let app = tempfile::tempdir().unwrap();
        let reg = VaultRegistry::open(app.path(), base);
        (app, reg)
    }

    /// A file beside `cur/`, as `.uidvalidity` sits: it travels only if the
    /// whole mailbox DIRECTORY moved, not just `cur/`.
    fn sibling(d: &Dirs) -> PathBuf {
        d.cur.parent().unwrap().join(".uidvalidity")
    }

    #[test]
    fn rename_dirs_moves_every_existing_location_and_skips_missing_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let base = tmp.path();
        let from = rename_fixture(base, "Projects", "a_Projects");
        let to = rename_fixture(base, "Work", "a_Work");

        // Only two of the three locations exist — no external mirror is configured.
        fs::create_dir_all(&from.cur).unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.cur.join(format!("7{INFO_PREFIX}AS")), b"body").unwrap();
        fs::write(sibling(&from), b"1").unwrap();
        fs::write(from.sidecar_dir.join("7.json"), b"{}").unwrap();

        assert_eq!(rename_dirs(&reg, &from, &to), (2, vec![]));

        assert!(to.cur.join(format!("7{INFO_PREFIX}AS")).exists());
        // The whole mailbox directory moved, so its sibling files came along.
        assert!(sibling(&to).exists(), ".uidvalidity stayed behind");
        assert!(to.sidecar_dir.join("7.json").exists());
        // A mirror that was never there is not invented.
        assert!(!base.join("mirror").exists());
        // Nothing is left at the old paths, and nothing was deleted.
        assert!(!base.join("Maildir").join("a").join("Projects").exists());
        assert!(!from.sidecar_dir.exists());

        // Idempotent: the sources are gone, so a repeat moves nothing.
        assert_eq!(rename_dirs(&reg, &from, &to), (0, vec![]));
    }

    /// 2.4 review forward constraint F2: `rename_dirs` must not move the
    /// sidecar dir (which carries `graph_id_map.json`) while another holder
    /// of the vault-wide ledger lock — a concurrent `graph_ledger::allocate`
    /// in the real system — is still using it. An ordering probe like
    /// `writer_spans_the_custody_callback_not_just_the_file_rename`: the
    /// "allocation" thread flips `state` to 1 on entry and 2 on exit; the
    /// rename thread only starts once it sees `1`, and its own assertion
    /// (made from inside the locked move) must see `2`.
    #[test]
    fn rename_dirs_waits_for_an_in_flight_ledger_holder_before_moving_the_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let base = tmp.path();
        let from = rename_fixture(base, "Projects", "a_Projects");
        let to = rename_fixture(base, "Work", "a_Work");
        fs::create_dir_all(&from.cur).unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.sidecar_dir.join("graph_id_map.json"), br#"{"1":"g-a"}"#).unwrap();
        let email_cache_dir = from.sidecar_dir.parent().unwrap().to_path_buf();

        let state = std::sync::atomic::AtomicU8::new(0);
        let state = &state;
        std::thread::scope(|scope| {
            // Simulates an in-flight `graph_ledger::allocate`: same lock,
            // held for a while.
            scope.spawn(|| {
                graph_ledger::with_ledger_lock(&email_cache_dir, || {
                    state.store(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    state.store(2, std::sync::atomic::Ordering::SeqCst);
                })
                .unwrap();
            });

            // Wait until the "allocation" is provably holding the lock
            // before even calling rename_dirs.
            let poll_start = std::time::Instant::now();
            while state.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                assert!(poll_start.elapsed() < std::time::Duration::from_secs(10), "holder never took the lock");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }

            scope.spawn(|| {
                let (moved, failed) = rename_dirs(&reg, &from, &to);
                assert_eq!(failed, Vec::<String>::new(), "{failed:?}");
                assert!(moved >= 1);
                assert_eq!(
                    state.load(std::sync::atomic::Ordering::SeqCst),
                    2,
                    "the sidecar move must not run until the lock holder released it"
                );
            });
        });

        assert!(to.sidecar_dir.join("graph_id_map.json").exists());
        assert!(!from.sidecar_dir.exists(), "the ledger must not be left behind in the old dir");
    }

    /// M-3 (final fix wave): `rename_dirs` must also not move the sidecar dir
    /// while a concurrent `header_cache::save`/`clear`/`patch_flags` for this
    /// root — which takes the tree lock's READ side — is still using it (the
    /// whole-branch review's finding: the rename path was the one writer of
    /// this tree outside the lock registry Task 2.3 created, so `save` could
    /// recreate the just-moved-away directory via its own `create_dir_all`).
    /// Same ordering-probe shape as the ledger-holder test above: `state`
    /// only reaches 2 once the reader's guard has dropped, and the assertion
    /// runs from inside the thread that made the (now write-locked) call, so
    /// it fails on the pre-fix code (which never touched this lock at all)
    /// rather than merely usually passing.
    #[test]
    fn rename_dirs_waits_for_an_in_flight_tree_reader_before_moving_the_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let base = tmp.path();
        let from = rename_fixture(base, "Projects", "a_Projects");
        let to = rename_fixture(base, "Work", "a_Work");
        fs::create_dir_all(&from.cur).unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.sidecar_dir.join("1.json"), b"{}").unwrap();

        let state = std::sync::atomic::AtomicU8::new(0);
        let state = &state;
        std::thread::scope(|scope| {
            // Simulates an in-flight `header_cache::save` for this root
            // (takes the tree lock's read side): held for a while.
            scope.spawn(|| {
                let tree = header_cache::lock_tree(&from.root);
                let _read = tree.read().unwrap_or_else(|e| e.into_inner());
                state.store(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(150));
                state.store(2, std::sync::atomic::Ordering::SeqCst);
            });

            // Wait until the "save" is provably holding the read lock before
            // even calling rename_dirs.
            let poll_start = std::time::Instant::now();
            while state.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                assert!(poll_start.elapsed() < std::time::Duration::from_secs(10), "reader never took the lock");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }

            scope.spawn(|| {
                let (moved, failed) = rename_dirs(&reg, &from, &to);
                assert_eq!(failed, Vec::<String>::new(), "{failed:?}");
                assert!(moved >= 1);
                assert_eq!(
                    state.load(std::sync::atomic::Ordering::SeqCst),
                    2,
                    "the sidecar move must not run until the tree reader released it"
                );
            });
        });

        assert!(to.sidecar_dir.join("1.json").exists());
        assert!(!from.sidecar_dir.exists(), "the sidecar dir must not be left behind (or recreated) at the old path");
    }

    /// A source that WOULD NOT move is not the same answer as a source that was
    /// never there: only the first one leaves the vault half-renamed, and the
    /// count alone cannot tell the caller which it got.
    #[test]
    fn a_rename_that_errors_is_reported_by_path_not_swallowed_into_the_count() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let base = tmp.path();
        let from = rename_fixture(base, "Projects", "a_Projects");
        let to = rename_fixture(base, "Work", "a_Work");

        fs::create_dir_all(&from.cur).unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.sidecar_dir.join("7.json"), b"{}").unwrap();

        // The sidecar cache's parent is a FILE, so neither create_dir_all nor
        // the rename beneath it can succeed. The Maildir move still can.
        fs::write(base.join("email_cache_blocked"), b"not a directory").unwrap();
        let blocked = Dirs {
            sidecar_dir: base.join("email_cache_blocked").join("a_Work"),
            ..rename_fixture(base, "Work", "a_Work")
        };

        let (moved, failed) = rename_dirs(&reg, &from, &blocked);
        assert_eq!(moved, 1, "the Maildir directory still moved");
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(failed[0].contains("a_Projects"), "names the source it could not move: {failed:?}");
        // Untouched: nothing is deleted when a move fails.
        assert!(from.sidecar_dir.join("7.json").exists());
        assert!(to.cur.exists());
    }

    /// Every regular file under `base`, so "nothing was deleted" is a count.
    /// Excludes `graph_ledger::LEDGER_LOCK_FILE`: taking the vault-wide
    /// ledger lock around the sidecar move (F2) now creates that file as a
    /// side effect, which is not the kind of "something got deleted" bug
    /// these counts exist to catch.
    fn file_count(base: &Path) -> usize {
        fn walk(p: &Path, n: &mut usize) {
            if let Ok(rd) = fs::read_dir(p) {
                for e in rd.flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        walk(&path, n)
                    } else if path.file_name().and_then(|n| n.to_str()) != Some(graph_ledger::LEDGER_LOCK_FILE) {
                        *n += 1
                    }
                }
            }
        }
        let mut n = 0;
        walk(base, &mut n);
        n
    }

    fn seed_app_side(from: &Dirs) {
        fs::create_dir_all(&from.cur).unwrap();
        fs::write(from.cur.join(format!("1{INFO_PREFIX}S.eml")), b"body").unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.sidecar_dir.join("graph_id_map.json"), b"{\"1\":\"msg-1\"}").unwrap();
        fs::write(from.sidecar_dir.join("1.json"), b"{\"uid\":1}").unwrap();
    }

    #[test]
    fn adopt_dirs_is_a_no_op_when_nothing_exists_on_the_from_side() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        let out = adopt_dirs(&reg, &from, &to);
        assert_eq!((out.moved, out.blocked), (0, 0));
        assert!(out.failed.is_empty());
        assert!(!to.cur.exists());
    }

    #[test]
    fn adopt_dirs_moves_both_app_dirs_and_the_ledger_when_every_destination_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        seed_app_side(&from);
        let before = file_count(tmp.path());

        let out = adopt_dirs(&reg, &from, &to);

        assert_eq!(out.moved, 2, "vault dir, sidecar dir");
        assert_eq!(out.app_moved, 2, "both of them app-side");
        assert_eq!(out.blocked, 0);
        assert!(out.failed.is_empty());
        assert!(to.cur.join(format!("1{INFO_PREFIX}S.eml")).exists());
        assert!(to.sidecar_dir.join("graph_id_map.json").exists(), "the ledger travels with the sidecar dir");
        assert!(!from.cur.parent().unwrap().exists());
        assert!(!from.sidecar_dir.exists());
        assert_eq!(file_count(tmp.path()), before, "nothing deleted");
    }

    #[test]
    fn adopt_dirs_moves_nothing_on_the_app_side_when_one_destination_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let from = rename_fixture(tmp.path(), "Papierkorb", "a_Papierkorb");
        let to = rename_fixture(tmp.path(), "Trash", "a_Trash");
        seed_app_side(&from);
        // Only the vault dir exists on the English side (a backup wrote it).
        fs::create_dir_all(&to.cur).unwrap();
        let before = file_count(tmp.path());

        let out = adopt_dirs(&reg, &from, &to);

        assert_eq!(out.moved, 0, "a partial move would pair one ledger with another numbering's files");
        assert_eq!(out.app_moved, 0, "so the caller leaves the custody rows where they are");
        assert_eq!(out.blocked, 1);
        // The log is the only trace of the legacy dir left behind, so it names
        // the destination that blocked the move, not just the pair.
        assert_eq!(
            out.blocked_by,
            vec![to.cur.parent().unwrap().display().to_string()],
            "names the vault dir that already existed"
        );
        assert!(from.cur.join(format!("1{INFO_PREFIX}S.eml")).exists());
        assert!(from.sidecar_dir.join("graph_id_map.json").exists());
        assert!(!to.sidecar_dir.exists());
        assert_eq!(file_count(tmp.path()), before);
    }

    #[test]
    fn adopt_dirs_moves_the_mirror_on_its_own_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let from = rename_fixture(tmp.path(), "Papierkorb", "a_Papierkorb");
        let to = rename_fixture(tmp.path(), "Trash", "a_Trash");
        seed_app_side(&from);
        fs::create_dir_all(&to.cur).unwrap(); // app side blocked
        let from_mirror = from.mirror_cur.clone().unwrap();
        fs::create_dir_all(&from_mirror).unwrap();
        fs::write(from_mirror.join(format!("1{INFO_PREFIX}S.eml")), b"mirror").unwrap();
        let before = file_count(tmp.path());

        let out = adopt_dirs(&reg, &from, &to);

        assert_eq!(out.moved, 1, "the mirror moved");
        assert_eq!(out.app_moved, 0, "the mirror is not the app side: the custody rows stay put");
        assert_eq!(out.blocked, 1, "the app side did not");
        assert!(to.mirror_cur.clone().unwrap().join(format!("1{INFO_PREFIX}S.eml")).exists());
        assert!(!from_mirror.exists());
        assert!(from.cur.join(format!("1{INFO_PREFIX}S.eml")).exists());
        assert_eq!(file_count(tmp.path()), before);

        // A mirror whose destination now exists stays put.
        fs::create_dir_all(&from_mirror).unwrap();
        fs::write(from_mirror.join(format!("2{INFO_PREFIX}S.eml")), b"second").unwrap();
        let before2 = file_count(tmp.path());
        let out2 = adopt_dirs(&reg, &from, &to);
        assert_eq!(out2.moved, 0);
        assert_eq!(out2.blocked, 2, "app side and mirror both blocked");
        assert!(
            out2.blocked_by.contains(&to.mirror_cur.clone().unwrap().parent().unwrap().display().to_string()),
            "the mirror destination is named too: {:?}",
            out2.blocked_by
        );
        assert!(from_mirror.join(format!("2{INFO_PREFIX}S.eml")).exists());
        assert_eq!(file_count(tmp.path()), before2);
    }

    #[test]
    fn adopt_dirs_without_a_mirror_configured_only_touches_the_app_side() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let mut from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let mut to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        from.mirror_cur = None;
        to.mirror_cur = None;
        seed_app_side(&from);
        let out = adopt_dirs(&reg, &from, &to);
        assert_eq!((out.moved, out.blocked), (2, 0));
        assert!(out.failed.is_empty());
    }

    #[test]
    fn rename_dirs_makes_both_mailboxes_list_again() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let (_app, reg) = registry_at(base);
        let from = rename_fixture(base, "Projects", "a_Projects");
        let to = rename_fixture(base, "Work", "a_Work");
        fs::create_dir_all(&from.cur).unwrap();
        fs::write(from.cur.join(format!("7{INFO_PREFIX}AS.eml")), b"body").unwrap();
        let saved = |mailbox: &str| reg.uid_sets(base, "a", mailbox).unwrap().0;
        assert_eq!(saved("Projects"), vec![7]);
        assert_eq!(saved("Work"), Vec::<u32>::new());

        assert_eq!(rename_dirs(&reg, &from, &to).0, 1);
        assert_eq!(saved("Projects"), Vec::<u32>::new());
        assert_eq!(saved("Work"), vec![7]);
        assert_eq!(reg.listing_count(), 4, "each side relisted once");

        // A repeat finds no source: nothing moved, nothing invalidated.
        assert_eq!(rename_dirs(&reg, &from, &to), (0, vec![]));
        assert_eq!(saved("Work"), vec![7]);
        assert_eq!(reg.listing_count(), 4);
    }

    #[test]
    fn adopt_dirs_makes_both_mailboxes_list_again_and_a_mirror_only_move_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry_at(tmp.path());
        let from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        seed_app_side(&from);
        let saved = |mailbox: &str| reg.uid_sets(tmp.path(), "a", mailbox).unwrap().0;
        assert_eq!(saved("Gesendet"), vec![1]);
        assert_eq!(saved("Sent"), Vec::<u32>::new());

        assert_eq!(adopt_dirs(&reg, &from, &to).app_moved, 2);
        assert_eq!(saved("Gesendet"), Vec::<u32>::new());
        assert_eq!(saved("Sent"), vec![1]);
        assert_eq!(reg.listing_count(), 4, "each side relisted once");

        // The mirror is not the vault: moving it alone invalidates nothing.
        let from_mirror = from.mirror_cur.clone().unwrap();
        fs::create_dir_all(&from_mirror).unwrap();
        fs::write(from_mirror.join(format!("2{INFO_PREFIX}S.eml")), b"mirror").unwrap();
        let out = adopt_dirs(&reg, &from, &to);
        assert_eq!((out.moved, out.app_moved), (1, 0));
        assert_eq!(saved("Sent"), vec![1]);
        assert_eq!(reg.listing_count(), 4);
    }
}
