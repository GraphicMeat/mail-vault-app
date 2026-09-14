//! One read-state change, landed on every durable copy the vault keeps of a
//! message.
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
//! and the header sidecar. `apply_everywhere` is that call plus the custody
//! entry's flags, both under `WRITER` — the app's mark read/unread and the
//! backup run's reconcile both go through it.

use std::fs;
use std::path::{Path, PathBuf};

use mailvault_core::maildir::mirror_file_map;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// One message's flags as the server names them: `\Seen`, `\Flagged`,
/// `\Answered`. The full list, not a delta — what the message has now.
#[derive(Debug, Clone, Deserialize)]
pub struct FlagChange {
    pub uid: u32,
    pub flags: Vec<String>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
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
    /// `email_cache/<account>_<mailbox>/`
    pub sidecar_dir: PathBuf,
}

pub(crate) fn dirs_for(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    backup_root: Option<&str>,
) -> Result<Dirs, String> {
    let cur = crate::maildir_cur_path(app_handle, account_id, mailbox)?;
    let mirror_cur = match (backup_root, account_email) {
        (Some(root), Some(email)) => Some(PathBuf::from(root).join(email).join(mailbox).join("cur")),
        _ => None,
    };
    Ok(Dirs {
        cur,
        mirror_cur,
        sidecar_dir: crate::vault::root(app_handle)?
            .join("email_cache")
            .join(crate::cache_base_name(account_id, mailbox)),
    })
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
pub fn apply_in(dirs: &Dirs, changes: &[FlagChange], sidecars: bool) -> Applied {
    let _one_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    apply_files(dirs, changes, sidecars)
}

/// Land `changes` on every copy under `dirs`. Silent about a message the vault
/// does not hold — there is nothing to rename or patch, and the counts say so.
/// No lock of its own: the caller holds `WRITER`.
///
/// `sidecars`: also patch the header cache. The app's own mark read/unread
/// wants that (the next repaint from cache reads it, and a server-only message
/// has no other copy). The backup reconcile does not: the sync engine owns
/// those files, and a 14k-message folder would open 14k of them to change
/// nothing.
fn apply_files(dirs: &Dirs, changes: &[FlagChange], sidecars: bool) -> Applied {
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
                Ok(Some(_)) => out.renamed += 1,
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

        if sidecars && patch_flags_field(&dirs.sidecar_dir.join(format!("{}.json", change.uid)), imap) {
            out.sidecars_patched += 1;
        }
    }

    out
}

/// `apply_files` plus the custody entry's flags: the one call the app's mark
/// read/unread and the backup's catch-up both make. `sidecars` as for
/// `apply_files`.
///
/// Both halves run under one `WRITER` acquisition. The name and the custody
/// entry are two records of the same fact, and the app's mark read/unread and
/// the backup's catch-up are exactly the pair that can apply opposite flags to
/// one uid at the same moment: patching custody after the lock was released
/// let the name say read while the entry said unread.
pub fn apply_everywhere(
    app: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
    dirs: &Dirs,
    changes: &[FlagChange],
    sidecars: bool,
) -> Applied {
    if changes.is_empty() {
        return Applied::default();
    }
    let _one_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let mut applied = apply_files(dirs, changes, sidecars);
    let patch: Vec<(u32, Vec<String>)> = changes.iter().map(|c| (c.uid, c.flags.clone())).collect();
    match crate::custody::with_conn(app, |c| mailvault_core::custody::entries::patch_flags_many(c, account_id, mailbox, &patch)) {
        Ok(n) => applied.index_patched = n,
        Err(e) => warn!("vault_flags: custody patch failed for {}/{}: {}", account_id, mailbox, e),
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
    let current = crate::parse_flags_from_filename(&name);
    let new_name = crate::build_maildir_filename(uid, &merge_flags(&current, imap));
    if new_name == name {
        return Ok(None);
    }
    fs::rename(path, path.with_file_name(&new_name)).map_err(|e| e.to_string())?;
    Ok(Some(new_name))
}

/// Set `flags` on the JSON object at `path`. False when there is no such file
/// or it already says this.
fn patch_flags_field(path: &Path, flags: &[String]) -> bool {
    let Ok(data) = fs::read_to_string(path) else { return false };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&data) else { return false };
    if !set_flags(&mut value, flags) {
        return false;
    }
    match serde_json::to_string(&value) {
        Ok(json) => fs::write(path, json).is_ok(),
        Err(_) => false,
    }
}

fn set_flags(obj: &mut serde_json::Value, flags: &[String]) -> bool {
    let new_flags = serde_json::json!(flags);
    if obj.get("flags") == Some(&new_flags) {
        return false;
    }
    match obj.as_object_mut() {
        Some(map) => {
            map.insert("flags".to_string(), new_flags);
            true
        }
        None => false,
    }
}

/// The app's half: one or more messages whose read state just changed here.
/// `account_email` names the mirror directory; without it, or without a
/// configured external location, the mirror is simply not touched.
#[tauri::command]
pub async fn vault_apply_flags(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    account_email: Option<String>,
    changes: Vec<FlagChange>,
) -> Result<Applied, String> {
    tokio::task::spawn_blocking(move || {
        let (root, needs_release) = crate::backup::resolve_backup_path(&app_handle, None);
        let result = dirs_for(&app_handle, &account_id, &mailbox, account_email.as_deref(), root.as_deref())
            .map(|dirs| apply_everywhere(&app_handle, &account_id, &mailbox, &dirs, &changes, true));
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let applied = result?;
        if applied.renamed > 0 {
            crate::search_index::nudge(&app_handle, &account_id, &mailbox); // filename-only updates
        }
        if applied.total() > 0 {
            info!(
                "vault_flags: {}/{} — {} renamed, {} mirrored, {} index, {} sidecars",
                account_id, mailbox, applied.renamed, applied.mirrored, applied.index_patched, applied.sidecars_patched
            );
        }
        Ok(applied)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// One mailbox path change. The JS sends one pair per renamed folder AND one
/// per descendant, because a server's RENAME moves the whole subtree in a
/// single command while the vault keeps a directory per full mailbox path.
#[derive(Debug, Deserialize)]
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
/// Two of the three are flat: `maildir_cur_path` and `cache_base_name` sanitize
/// the WHOLE mailbox path into one directory name, so `Projects` and
/// `Projects/Alpha` are siblings and their pairs never interact. The mirror
/// uses the raw path, so it nests, and renaming `Projects` there carries
/// `Projects/Alpha` along with it. That is harmless as long as the parent pair
/// runs first, which is why `vault_rename_mailbox` sorts shallowest-first: the
/// descendant's pair then finds its source already gone and skips.
pub fn rename_dirs(from: &Dirs, to: &Dirs) -> (usize, Vec<String>) {
    fn up(p: &Path) -> Option<PathBuf> {
        p.parent().map(|q| q.to_path_buf())
    }
    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    if let (Some(a), Some(b)) = (up(&from.cur), up(&to.cur)) {
        pairs.push((a, b));
    }
    pairs.push((from.sidecar_dir.clone(), to.sidecar_dir.clone()));
    if let (Some(a), Some(b)) = (
        from.mirror_cur.as_deref().and_then(up),
        to.mirror_cur.as_deref().and_then(up),
    ) {
        pairs.push((a, b));
    }

    let mut moved = 0;
    let mut failed = Vec::new();
    for (src, dst) in pairs {
        if !src.exists() || dst.exists() {
            continue; // ponytail: an existing destination is left alone; merge if it ever matters
        }
        if let Some(p) = dst.parent() {
            let _ = fs::create_dir_all(p);
        }
        match fs::rename(&src, &dst) {
            Ok(()) => moved += 1,
            Err(e) => {
                warn!("vault_rename: {:?} -> {:?}: {}", src, dst, e);
                failed.push(format!("{} ({})", src.display(), e));
            }
        }
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
pub fn adopt_dirs(from: &Dirs, to: &Dirs) -> Adopted {
    fn up(p: &Path) -> Option<PathBuf> {
        p.parent().map(|q| q.to_path_buf())
    }
    fn mv(src: &Path, dst: &Path, out: &mut Adopted) {
        if let Some(p) = dst.parent() {
            let _ = fs::create_dir_all(p);
        }
        match fs::rename(src, dst) {
            Ok(()) => out.moved += 1,
            Err(e) => {
                warn!("vault_adopt: {:?} -> {:?}: {}", src, dst, e);
                out.failed.push(format!("{} ({})", src.display(), e));
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
                if src.exists() {
                    mv(src, dst, &mut out);
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
                mv(&src, &dst, &mut out);
            }
        }
    }
    out
}

#[derive(Debug, Default, Serialize)]
pub struct AdoptReport {
    pub adopted: Vec<String>,
    pub skipped_both_exist: Vec<String>,
    pub failed: Vec<String>,
}

/// The one-time adoption of Graph folders written under localized names.
/// Every pair is attempted; the command fails only after all of them ran.
#[tauri::command]
pub async fn vault_adopt_mailbox_dirs(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_email: Option<String>,
    pairs: Vec<RenamePair>,
) -> Result<AdoptReport, String> {
    tokio::task::spawn_blocking(move || {
        // Shallowest first, as `vault_rename_mailbox` does: a no-op for the flat
        // storage keys sent today, and the order the nesting mirror needs the
        // day a localized folder with children is adopted.
        //
        // A user who switched UI language more than once has two legacy
        // directories for one folder ("Gesendet" and "Enviados", both -> "Sent"):
        // the first pair in this order wins and the other stays where it is,
        // because only a merge could do better and this command never merges.
        let mut pairs = pairs;
        pairs.sort_by_key(|p| p.from.len());
        let (root, needs_release) = crate::backup::resolve_backup_path(&app_handle, None);
        // Outside the closure: a pair that fails `dirs_for` returns early, and the
        // pairs that already moved still need the sweep.
        let mut any_moved = false;
        let result = (|| -> Result<AdoptReport, String> {
            let mut report = AdoptReport::default();
            for p in &pairs {
                let from = dirs_for(&app_handle, &account_id, &p.from, account_email.as_deref(), root.as_deref())?;
                let to = dirs_for(&app_handle, &account_id, &p.to, account_email.as_deref(), root.as_deref())?;
                let out = adopt_dirs(&from, &to);
                any_moved |= out.moved > 0;
                let label = format!("{} -> {}", p.from, p.to);
                // The custody store holds what the retired local index and
                // archived-headers cache used to, so its rows follow the app-side
                // directories: a blocked pair or a mirror-only move renames
                // nothing, the rows stay with the directory that stayed.
                //
                // A failure here lands in `failed`, so the command returns Err, the
                // JS flag stays unset and the next launch retries the pair — by
                // then the directories are already moved, so only this rename is
                // redone. `UPDATE ... WHERE mailbox_path = from` matches nothing the
                // second time, which is the idempotence that retry needs.
                if out.app_moved > 0 {
                    match crate::custody::with_conn(&app_handle, |c| mailvault_core::custody::entries::rename_mailbox(c, &account_id, &p.from, &p.to)) {
                        Ok(_) => {}
                        Err(e) => report.failed.push(format!("custody {} -> {} ({})", p.from, p.to, e)),
                    }
                }
                if !out.failed.is_empty() {
                    report.failed.push(format!("{}: {}", label, out.failed.join("; ")));
                } else if out.moved > 0 {
                    report.adopted.push(label);
                } else if out.blocked > 0 {
                    report
                        .skipped_both_exist
                        .push(format!("{} (exists: {})", label, out.blocked_by.join(", ")));
                }
            }
            Ok(report)
        })();
        if any_moved {
            crate::search_index::sweep_soon(&app_handle); // the old folders' rows go, the new ones' come
        }
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let report = result?;
        let line = format!(
            "vault_adopt_mailbox_dirs: {} — adopted {:?}, left in place {:?}, failed {}",
            account_id, report.adopted, report.skipped_both_exist, report.failed.len()
        );
        // A left-behind legacy directory is the one outcome nobody will look for
        // until a mailbox reads short, so it logs at warn.
        if report.skipped_both_exist.is_empty() {
            info!("{}", line);
        } else {
            warn!("{}", line);
        }
        if !report.failed.is_empty() {
            return Err(format!("vault adopt incomplete: {}", report.failed.join("; ")));
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// The local half of a folder rename: the server already moved the subtree,
/// this moves the directories that hold its copies.
#[tauri::command]
pub async fn vault_rename_mailbox(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_email: Option<String>,
    pairs: Vec<RenamePair>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let (root, needs_release) = crate::backup::resolve_backup_path(&app_handle, None);
        // Shallowest first — see `rename_dirs`: the mirror nests, so a
        // parent's move has to happen before its descendants' pairs.
        let mut pairs = pairs;
        pairs.sort_by_key(|p| p.from.len());
        let mut moved = 0;
        // EVERY pair is attempted before the first failure is reported: the
        // server has already renamed the whole subtree, so stopping halfway
        // would strand directories that could still have been moved.
        let mut failed: Vec<String> = Vec::new();
        let result = (|| -> Result<usize, String> {
            for p in &pairs {
                let from = dirs_for(&app_handle, &account_id, &p.from, account_email.as_deref(), root.as_deref())?;
                let to = dirs_for(&app_handle, &account_id, &p.to, account_email.as_deref(), root.as_deref())?;
                let (n, mut bad) = rename_dirs(&from, &to);
                moved += n;
                failed.append(&mut bad);
                match crate::custody::with_conn(&app_handle, |c| mailvault_core::custody::entries::rename_mailbox(c, &account_id, &p.from, &p.to)) {
                    Ok(rows) => moved += usize::from(rows > 0),
                    Err(e) => failed.push(format!("custody {} -> {} ({})", p.from, p.to, e)),
                }
            }
            if !failed.is_empty() {
                return Err(format!("vault rename incomplete: {}", failed.join("; ")));
            }
            Ok(moved)
        })();
        if moved > 0 {
            crate::search_index::sweep_soon(&app_handle); // the old folders' rows go, the new ones' come
        }
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let moved = result?;
        info!(
            "vault_rename_mailbox: {} — {} location(s) moved for {} pair(s)",
            account_id,
            moved,
            pairs.len()
        );
        Ok(moved)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let cur = base.join("Maildir").join("acct").join("INBOX").join("cur");
        let mirror = base.join("mirror").join("me@mock.test").join("INBOX").join("cur");
        let sidecar_dir = base.join("email_cache").join("acct_INBOX");
        for d in [&cur, &mirror, &sidecar_dir] {
            fs::create_dir_all(d).unwrap();
        }
        Fixture {
            dirs: Dirs { cur, mirror_cur: Some(mirror), sidecar_dir },
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

    /// `flags` of `uid` in a header sidecar: ONE object, because a sidecar
    /// holds a single message.
    fn flags_of(path: &Path, uid: u32) -> Option<Vec<String>> {
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        let entries = match &v {
            serde_json::Value::Array(a) => a.clone(),
            other if other.get("uid").is_some() => vec![other.clone()],
            other => other.get("emails")?.as_array()?.clone(),
        };
        entries
            .iter()
            .find(|e| e.get("uid").and_then(|u| u.as_u64()) == Some(uid as u64))
            .and_then(|e| serde_json::from_value(e.get("flags")?.clone()).ok())
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
        fs::write(d.cur.join("1:2,.eml"), b"body").unwrap();
        fs::write(d.cur.join("2:2,.eml"), b"body").unwrap();

        let (first, second) = std::thread::scope(|scope| {
            let a = scope.spawn(|| apply_in(d, &[change(1, &["\\Seen"])], false));
            let b = scope.spawn(|| apply_in(d, &[change(2, &["\\Seen"])], false));
            (a.join().unwrap(), b.join().unwrap())
        });

        assert_eq!(first.renamed, 1);
        assert_eq!(second.renamed, 1);
        assert_eq!(names(&d.cur), vec!["1:2,S.eml", "2:2,S.eml"]);
    }

    #[test]
    fn marking_read_renames_the_file_its_mirror_copy_and_patches_every_record() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("7:2,A"), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join("7:2,A.eml"), b"body").unwrap();
        fs::write(d.sidecar_dir.join("7.json"), r#"{"uid":7,"flags":[],"subject":"s"}"#).unwrap();

        let applied = apply_in(d, &[change(7, &["\\Seen"])], true);

        assert_eq!(applied, Applied { renamed: 1, mirrored: 1, index_patched: 0, sidecars_patched: 1 });
        // The legacy extension-less name converges on the current one.
        assert_eq!(names(&d.cur), vec!["7:2,AS.eml"]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec!["7:2,AS.eml"]);
        assert_eq!(flags_of(&d.sidecar_dir.join("7.json"), 7), Some(s(&["\\Seen"])));
    }

    /// The backup's catch-up over a copy the app auto-cached when the message
    /// was opened: flagless in the vault, legacy-named on the mirror. The run
    /// counted it as backed up, so both copies come out carrying `A`.
    #[test]
    fn a_change_asking_for_archived_puts_the_letter_on_the_vault_and_mirror_copies() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("9:2,.eml"), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join("9.eml"), b"body").unwrap();

        let applied = apply_in(d, &[change(9, &["\\Seen", "archived"])], false);

        assert_eq!(applied.renamed, 1);
        assert_eq!(applied.mirrored, 1);
        assert_eq!(names(&d.cur), vec!["9:2,AS.eml"]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec!["9:2,AS.eml"]);
    }

    #[test]
    fn marking_unread_takes_the_letter_off_again_and_leaves_the_rest_alone() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("7:2,AS.eml"), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join("7:2,AS.eml"), b"body").unwrap();

        let applied = apply_in(d, &[change(7, &[])], true);

        assert_eq!(applied, Applied { renamed: 1, mirrored: 1, index_patched: 0, sidecars_patched: 0 });
        // The .eml suffix the file had is kept.
        assert_eq!(names(&d.cur), vec!["7:2,A.eml"]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec!["7:2,A.eml"]);
    }

    #[test]
    fn a_change_the_copies_already_carry_is_a_no_op() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("7:2,AS.eml"), b"body").unwrap();

        let applied = apply_in(d, &[change(7, &["\\Seen"])], true);

        assert_eq!(applied, Applied::default());
        assert_eq!(names(&d.cur), vec!["7:2,AS.eml"]);
    }

    #[test]
    fn a_message_the_vault_does_not_hold_changes_nothing_and_says_so() {
        let f = fixture();
        let d = &f.dirs;
        // A sidecar exists for every synced message; only that gets patched.
        fs::write(d.sidecar_dir.join("9.json"), r#"{"uid":9,"flags":[]}"#).unwrap();

        let applied = apply_in(d, &[change(9, &["\\Seen"]), change(10, &["\\Seen"])], true);

        assert_eq!(applied, Applied { renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 1 });
    }

    #[test]
    fn a_legacy_mirror_name_is_brought_up_to_the_flagged_shape() {
        let f = fixture();
        let d = &f.dirs;
        let mirror = d.mirror_cur.as_ref().unwrap();
        fs::write(mirror.join("7.eml"), b"body").unwrap();

        let applied = apply_in(d, &[change(7, &["\\Seen"])], true);

        assert_eq!(applied.mirrored, 1);
        assert_eq!(names(mirror), vec!["7:2,S.eml"]);
    }

    #[test]
    fn a_backup_reconcile_touches_only_the_copies_that_disagree() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("1:2,A.eml"), b"a").unwrap();
        fs::write(d.cur.join("2:2,AS.eml"), b"b").unwrap();
        fs::write(d.cur.join("3:2,AS.eml"), b"c").unwrap();

        // A sidecar the reconcile must leave to the sync engine.
        fs::write(d.sidecar_dir.join("1.json"), r#"{"uid":1,"flags":[]}"#).unwrap();

        // The server: 1 was read elsewhere, 2 is as stored, 3 was marked unread.
        let applied = apply_in(d, &[change(1, &["\\Seen"]), change(2, &["\\Seen"]), change(3, &[])], false);

        assert_eq!(applied, Applied { renamed: 2, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
        assert_eq!(flags_of(&d.sidecar_dir.join("1.json"), 1), Some(s(&[])));
        assert_eq!(names(&d.cur), vec!["1:2,AS.eml", "2:2,AS.eml", "3:2,A.eml"]);
    }

    /// A `Dirs` pair for one mailbox rename, laid out the way `dirs_for` builds
    /// it: a sanitized Maildir/sidecar name, a raw path for the mirror.
    fn rename_fixture(base: &Path, mailbox: &str, sidecar: &str) -> Dirs {
        Dirs {
            cur: base.join("Maildir").join("a").join(mailbox).join("cur"),
            mirror_cur: Some(base.join("mirror").join("me@x").join(mailbox).join("cur")),
            sidecar_dir: base.join("email_cache").join(sidecar),
        }
    }

    /// A file beside `cur/`, as `.uidvalidity` sits: it travels only if the
    /// whole mailbox DIRECTORY moved, not just `cur/`.
    fn sibling(d: &Dirs) -> PathBuf {
        d.cur.parent().unwrap().join(".uidvalidity")
    }

    #[test]
    fn rename_dirs_moves_every_existing_location_and_skips_missing_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let from = rename_fixture(base, "Projects", "a_Projects");
        let to = rename_fixture(base, "Work", "a_Work");

        // Only two of the three locations exist — no external mirror is configured.
        fs::create_dir_all(&from.cur).unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.cur.join("7:2,AS"), b"body").unwrap();
        fs::write(sibling(&from), b"1").unwrap();
        fs::write(from.sidecar_dir.join("7.json"), b"{}").unwrap();

        assert_eq!(rename_dirs(&from, &to), (2, vec![]));

        assert!(to.cur.join("7:2,AS").exists());
        // The whole mailbox directory moved, so its sibling files came along.
        assert!(sibling(&to).exists(), ".uidvalidity stayed behind");
        assert!(to.sidecar_dir.join("7.json").exists());
        // A mirror that was never there is not invented.
        assert!(!base.join("mirror").exists());
        // Nothing is left at the old paths, and nothing was deleted.
        assert!(!base.join("Maildir").join("a").join("Projects").exists());
        assert!(!from.sidecar_dir.exists());

        // Idempotent: the sources are gone, so a repeat moves nothing.
        assert_eq!(rename_dirs(&from, &to), (0, vec![]));
    }

    /// A source that WOULD NOT move is not the same answer as a source that was
    /// never there: only the first one leaves the vault half-renamed, and the
    /// count alone cannot tell the caller which it got.
    #[test]
    fn a_rename_that_errors_is_reported_by_path_not_swallowed_into_the_count() {
        let tmp = tempfile::tempdir().unwrap();
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

        let (moved, failed) = rename_dirs(&from, &blocked);
        assert_eq!(moved, 1, "the Maildir directory still moved");
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(failed[0].contains("a_Projects"), "names the source it could not move: {failed:?}");
        // Untouched: nothing is deleted when a move fails.
        assert!(from.sidecar_dir.join("7.json").exists());
        assert!(to.cur.exists());
    }

    /// Every regular file under `base`, so "nothing was deleted" is a count.
    fn file_count(base: &Path) -> usize {
        fn walk(p: &Path, n: &mut usize) {
            if let Ok(rd) = fs::read_dir(p) {
                for e in rd.flatten() {
                    let path = e.path();
                    if path.is_dir() { walk(&path, n) } else { *n += 1 }
                }
            }
        }
        let mut n = 0;
        walk(base, &mut n);
        n
    }

    fn seed_app_side(from: &Dirs) {
        fs::create_dir_all(&from.cur).unwrap();
        fs::write(from.cur.join("1:2,S.eml"), b"body").unwrap();
        fs::create_dir_all(&from.sidecar_dir).unwrap();
        fs::write(from.sidecar_dir.join("graph_id_map.json"), b"{\"1\":\"msg-1\"}").unwrap();
        fs::write(from.sidecar_dir.join("1.json"), b"{\"uid\":1}").unwrap();
    }

    #[test]
    fn adopt_dirs_is_a_no_op_when_nothing_exists_on_the_from_side() {
        let tmp = tempfile::tempdir().unwrap();
        let from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        let out = adopt_dirs(&from, &to);
        assert_eq!((out.moved, out.blocked), (0, 0));
        assert!(out.failed.is_empty());
        assert!(!to.cur.exists());
    }

    #[test]
    fn adopt_dirs_moves_both_app_dirs_and_the_ledger_when_every_destination_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        seed_app_side(&from);
        let before = file_count(tmp.path());

        let out = adopt_dirs(&from, &to);

        assert_eq!(out.moved, 2, "vault dir, sidecar dir");
        assert_eq!(out.app_moved, 2, "both of them app-side");
        assert_eq!(out.blocked, 0);
        assert!(out.failed.is_empty());
        assert!(to.cur.join("1:2,S.eml").exists());
        assert!(to.sidecar_dir.join("graph_id_map.json").exists(), "the ledger travels with the sidecar dir");
        assert!(!from.cur.parent().unwrap().exists());
        assert!(!from.sidecar_dir.exists());
        assert_eq!(file_count(tmp.path()), before, "nothing deleted");
    }

    #[test]
    fn adopt_dirs_moves_nothing_on_the_app_side_when_one_destination_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let from = rename_fixture(tmp.path(), "Papierkorb", "a_Papierkorb");
        let to = rename_fixture(tmp.path(), "Trash", "a_Trash");
        seed_app_side(&from);
        // Only the vault dir exists on the English side (a backup wrote it).
        fs::create_dir_all(&to.cur).unwrap();
        let before = file_count(tmp.path());

        let out = adopt_dirs(&from, &to);

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
        assert!(from.cur.join("1:2,S.eml").exists());
        assert!(from.sidecar_dir.join("graph_id_map.json").exists());
        assert!(!to.sidecar_dir.exists());
        assert_eq!(file_count(tmp.path()), before);
    }

    #[test]
    fn adopt_dirs_moves_the_mirror_on_its_own_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let from = rename_fixture(tmp.path(), "Papierkorb", "a_Papierkorb");
        let to = rename_fixture(tmp.path(), "Trash", "a_Trash");
        seed_app_side(&from);
        fs::create_dir_all(&to.cur).unwrap(); // app side blocked
        let from_mirror = from.mirror_cur.clone().unwrap();
        fs::create_dir_all(&from_mirror).unwrap();
        fs::write(from_mirror.join("1:2,S.eml"), b"mirror").unwrap();
        let before = file_count(tmp.path());

        let out = adopt_dirs(&from, &to);

        assert_eq!(out.moved, 1, "the mirror moved");
        assert_eq!(out.app_moved, 0, "the mirror is not the app side: the custody rows stay put");
        assert_eq!(out.blocked, 1, "the app side did not");
        assert!(to.mirror_cur.clone().unwrap().join("1:2,S.eml").exists());
        assert!(!from_mirror.exists());
        assert!(from.cur.join("1:2,S.eml").exists());
        assert_eq!(file_count(tmp.path()), before);

        // A mirror whose destination now exists stays put.
        fs::create_dir_all(&from_mirror).unwrap();
        fs::write(from_mirror.join("2:2,S.eml"), b"second").unwrap();
        let before2 = file_count(tmp.path());
        let out2 = adopt_dirs(&from, &to);
        assert_eq!(out2.moved, 0);
        assert_eq!(out2.blocked, 2, "app side and mirror both blocked");
        assert!(
            out2.blocked_by.contains(&to.mirror_cur.clone().unwrap().parent().unwrap().display().to_string()),
            "the mirror destination is named too: {:?}",
            out2.blocked_by
        );
        assert!(from_mirror.join("2:2,S.eml").exists());
        assert_eq!(file_count(tmp.path()), before2);
    }

    #[test]
    fn adopt_dirs_without_a_mirror_configured_only_touches_the_app_side() {
        let tmp = tempfile::tempdir().unwrap();
        let mut from = rename_fixture(tmp.path(), "Gesendet", "a_Gesendet");
        let mut to = rename_fixture(tmp.path(), "Sent", "a_Sent");
        from.mirror_cur = None;
        to.mirror_cur = None;
        seed_app_side(&from);
        let out = adopt_dirs(&from, &to);
        assert_eq!((out.moved, out.blocked), (2, 0));
        assert!(out.failed.is_empty());
    }
}
