//! One read-state change, landed on every durable copy the vault keeps of a
//! message.
//!
//! Read state lived in six places and had one writer each, or none. The server
//! got the STORE, memory and local-index.json got the flip, and the Maildir
//! file name — which restore, the external mirror and every `.eml` read treat
//! as the message's flags — kept whatever it was stored with, which was always
//! "seen". So a restore uploaded every vault message as read, a vault row
//! rebuilt from its file rendered unread whatever had been done to it, and the
//! mirror never learned about a change at all.
//!
//! `apply_in` is the one writer now: the file name (app dir and mirror), the
//! index entry, the header sidecar and archived_headers.json. The app's mark
//! read/unread and the backup run's reconcile both go through it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
/// (archived, draft, trashed) survive, seen/flagged/replied follow the server.
pub fn merge_flags(current: &[String], imap: &[String]) -> Vec<String> {
    let mut out: Vec<String> = current
        .iter()
        .map(|f| f.to_lowercase())
        .filter(|f| matches!(f.as_str(), "archived" | "draft" | "trashed"))
        .collect();
    let has = |name: &str| imap.iter().any(|f| f.eq_ignore_ascii_case(name));
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
    /// `maildir/<account>/<mailbox>/local-index.json`
    pub index: PathBuf,
    /// `email_cache/<account>_<mailbox>/`
    pub sidecar_dir: PathBuf,
    /// `Maildir/<account>/<mailbox>/archived_headers.json`
    pub archived_cache: PathBuf,
}

pub(crate) fn dirs_for(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    backup_root: Option<&str>,
) -> Result<Dirs, String> {
    let cur = crate::maildir_cur_path(app_handle, account_id, mailbox)?;
    let archived_cache = cur
        .parent()
        .map(|p| p.join("archived_headers.json"))
        .ok_or_else(|| "Maildir path has no parent".to_string())?;
    let mirror_cur = match (backup_root, account_email) {
        (Some(root), Some(email)) => Some(PathBuf::from(root).join(email).join(mailbox).join("cur")),
        _ => None,
    };
    Ok(Dirs {
        cur,
        mirror_cur,
        index: crate::local_index_path(app_handle, account_id, mailbox)?,
        sidecar_dir: crate::vault::root(app_handle)?
            .join("email_cache")
            .join(crate::cache_base_name(account_id, mailbox)),
        archived_cache,
    })
}

/// One writer at a time per process. Every call rewrites a whole index file;
/// two at once would each read the same array, patch their own uid and put the
/// file back, and the loser's flag would vanish. The frontend batches a
/// selection into one call, and this keeps two callers honest anyway.
static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Land `changes` on every copy under `dirs`. Silent about a message the vault
/// does not hold — there is nothing to rename or patch, and the counts say so.
///
/// `sidecars`: also patch the header cache. The app's own mark read/unread
/// wants that (the next repaint from cache reads it, and a server-only message
/// has no other copy). The backup reconcile does not: the sync engine owns
/// those files, and a 14k-message folder would open 14k of them to change
/// nothing.
pub fn apply_in(dirs: &Dirs, changes: &[FlagChange], sidecars: bool) -> Applied {
    let mut out = Applied::default();
    if changes.is_empty() {
        return out;
    }
    let _one_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());

    // One listing per directory: the per-uid finders rescan on every call, and
    // a backup reconcile hands this every message the folder holds.
    let app_files = files_by_uid(&dirs.cur);
    let mirror_files = dirs.mirror_cur.as_deref().map(files_by_uid);

    let mut index = JsonFile::load(&dirs.index, None);
    let mut cache = JsonFile::load(&dirs.archived_cache, Some("emails"));

    for change in changes {
        let imap = &change.flags;

        if let Some(path) = app_files.get(&change.uid) {
            match rename_for(path, change.uid, imap) {
                Ok(Some(new_name)) => {
                    out.renamed += 1;
                    // The header cache stores what a fresh `.eml` read would
                    // report, so hand it exactly that.
                    let light = crate::parse_flags_from_filename(&new_name);
                    cache.patch(change.uid, &light);
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

        if index.patch(change.uid, imap) {
            out.index_patched += 1;
        }

        if sidecars && patch_flags_field(&dirs.sidecar_dir.join(format!("{}.json", change.uid)), imap) {
            out.sidecars_patched += 1;
        }
    }

    index.save();
    cache.save();
    out
}

/// Rename `path` so its flag letters carry `imap`. `Some(new name)` when the
/// name changed, `None` when it already said this.
fn rename_for(path: &Path, uid: u32, imap: &[String]) -> Result<Option<String>, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let current = crate::parse_flags_from_filename(&name);
    let mut new_name = crate::build_maildir_filename(uid, &merge_flags(&current, imap));
    if name.ends_with(".eml") {
        new_name.push_str(".eml");
    }
    if new_name == name {
        return Ok(None);
    }
    fs::rename(path, path.with_file_name(&new_name)).map_err(|e| e.to_string())?;
    Ok(Some(new_name))
}

/// uid → path for every message file in `dir`. Every shape the vault and the
/// mirror have ever written starts with the uid: `<uid>:2,<flags>[.eml]`,
/// `<uid>.eml`, `<uid>_<flags>.eml`.
fn files_by_uid(dir: &Path) -> HashMap<u32, PathBuf> {
    let mut map = HashMap::new();
    let Ok(entries) = fs::read_dir(dir) else { return map };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let head = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or("");
        if let Ok(uid) = head.parse::<u32>() {
            map.entry(uid).or_insert_with(|| entry.path());
        }
    }
    map
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

/// A JSON file holding one array of `{uid, flags, ...}` entries — bare
/// (local-index.json) or under `key` (archived_headers.json's `emails`). Read
/// once, positions indexed once, written back once and only if something
/// changed.
struct JsonFile {
    path: PathBuf,
    key: Option<&'static str>,
    value: Option<serde_json::Value>,
    /// uid → positions in the array. A folder's index can hold 14k entries
    /// and a backup reconcile patches every one of them; a scan per patch
    /// would be 14k × 14k.
    positions: HashMap<u64, Vec<usize>>,
    dirty: bool,
}

impl JsonFile {
    fn load(path: &Path, key: Option<&'static str>) -> Self {
        let value: Option<serde_json::Value> = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let mut positions: HashMap<u64, Vec<usize>> = HashMap::new();
        if let Some(entries) = value.as_ref().and_then(|v| Self::array_in(v, key)) {
            for (i, entry) in entries.iter().enumerate() {
                if let Some(uid) = entry.get("uid").and_then(|u| u.as_u64()) {
                    positions.entry(uid).or_default().push(i);
                }
            }
        }
        JsonFile { path: path.to_path_buf(), key, value, positions, dirty: false }
    }

    fn array_in<'a>(v: &'a serde_json::Value, key: Option<&str>) -> Option<&'a Vec<serde_json::Value>> {
        match key {
            None => v.as_array(),
            Some(k) => v.get(k)?.as_array(),
        }
    }

    fn patch(&mut self, uid: u32, flags: &[String]) -> bool {
        let Some(at) = self.positions.get(&(uid as u64)) else { return false };
        let key = self.key;
        let Some(entries) = self.value.as_mut().and_then(|v| match key {
            None => v.as_array_mut(),
            Some(k) => v.get_mut(k)?.as_array_mut(),
        }) else {
            return false;
        };
        let mut changed = false;
        for &i in at {
            if let Some(entry) = entries.get_mut(i) {
                changed |= set_flags(entry, flags);
            }
        }
        self.dirty |= changed;
        changed
    }

    fn save(&self) {
        if !self.dirty {
            return;
        }
        let Some(value) = &self.value else { return };
        let Ok(json) = serde_json::to_string(value) else { return };
        // Tmp-then-rename, as local_index_append does, so a reader never sees
        // a half-written file — under a name of our own, so two writers can
        // never be filling the same tmp file at once.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tmp = self.path.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &self.path).is_err() {
            warn!("vault_flags: could not replace {:?}", self.path);
            let _ = fs::remove_file(&tmp);
        }
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
            .map(|dirs| apply_in(&dirs, &changes, true));
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let applied = result?;
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

    struct Fixture {
        _tmp: tempfile::TempDir,
        dirs: Dirs,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let cur = base.join("Maildir").join("acct").join("INBOX").join("cur");
        let mirror = base.join("mirror").join("me@mock.test").join("INBOX").join("cur");
        let index_dir = base.join("maildir").join("acct").join("INBOX");
        let sidecar_dir = base.join("email_cache").join("acct_INBOX");
        for d in [&cur, &mirror, &index_dir, &sidecar_dir] {
            fs::create_dir_all(d).unwrap();
        }
        Fixture {
            dirs: Dirs {
                archived_cache: cur.parent().unwrap().join("archived_headers.json"),
                cur,
                mirror_cur: Some(mirror),
                index: index_dir.join("local-index.json"),
                sidecar_dir,
            },
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

    /// `flags` of `uid` in any of the three shapes: a bare array
    /// (local-index.json), `{emails: [...]}` (archived_headers.json), or ONE
    /// object (a header sidecar is a single message).
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

    #[test]
    fn marking_read_renames_the_file_its_mirror_copy_and_patches_every_record() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("7:2,A"), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join("7:2,A.eml"), b"body").unwrap();
        fs::write(&d.index, r#"[{"uid":7,"subject":"s","flags":[]},{"uid":8,"flags":["\\Seen"]}]"#).unwrap();
        fs::write(d.sidecar_dir.join("7.json"), r#"{"uid":7,"flags":[],"subject":"s"}"#).unwrap();
        fs::write(&d.archived_cache, r#"{"uid_count":1,"emails":[{"uid":7,"flags":["archived"]}]}"#).unwrap();

        let applied = apply_in(d, &[change(7, &["\\Seen"])], true);

        assert_eq!(applied, Applied { renamed: 1, mirrored: 1, index_patched: 1, sidecars_patched: 1 });
        assert_eq!(names(&d.cur), vec!["7:2,AS"]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec!["7:2,AS.eml"]);
        assert_eq!(flags_of(&d.index, 7), Some(s(&["\\Seen"])));
        // The neighbour entry is untouched.
        assert_eq!(flags_of(&d.index, 8), Some(s(&["\\Seen"])));
        assert_eq!(flags_of(&d.sidecar_dir.join("7.json"), 7), Some(s(&["\\Seen"])));
        // What a fresh .eml read of the renamed file would report.
        assert_eq!(flags_of(&d.archived_cache, 7), Some(s(&["archived", "seen", "\\Seen"])));
    }

    #[test]
    fn marking_unread_takes_the_letter_off_again_and_leaves_the_rest_alone() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("7:2,AS.eml"), b"body").unwrap();
        fs::write(d.mirror_cur.as_ref().unwrap().join("7:2,AS.eml"), b"body").unwrap();
        fs::write(&d.index, r#"[{"uid":7,"flags":["\\Seen"]}]"#).unwrap();

        let applied = apply_in(d, &[change(7, &[])], true);

        assert_eq!(applied, Applied { renamed: 1, mirrored: 1, index_patched: 1, sidecars_patched: 0 });
        // The .eml suffix the file had is kept.
        assert_eq!(names(&d.cur), vec!["7:2,A.eml"]);
        assert_eq!(names(d.mirror_cur.as_ref().unwrap()), vec!["7:2,A.eml"]);
        assert_eq!(flags_of(&d.index, 7), Some(s(&[])));
    }

    #[test]
    fn a_change_the_copies_already_carry_is_a_no_op() {
        let f = fixture();
        let d = &f.dirs;
        fs::write(d.cur.join("7:2,AS"), b"body").unwrap();
        fs::write(&d.index, r#"[{"uid":7,"flags":["\\Seen"]}]"#).unwrap();
        let before = fs::metadata(&d.index).unwrap().modified().unwrap();

        let applied = apply_in(d, &[change(7, &["\\Seen"])], true);

        assert_eq!(applied, Applied::default());
        assert_eq!(names(&d.cur), vec!["7:2,AS"]);
        assert_eq!(fs::metadata(&d.index).unwrap().modified().unwrap(), before, "index rewritten for nothing");
    }

    #[test]
    fn a_message_the_vault_does_not_hold_changes_nothing_and_says_so() {
        let f = fixture();
        let d = &f.dirs;
        // A sidecar exists for every synced message; only that gets patched.
        fs::write(d.sidecar_dir.join("9.json"), r#"{"uid":9,"flags":[]}"#).unwrap();

        let applied = apply_in(d, &[change(9, &["\\Seen"]), change(10, &["\\Seen"])], true);

        assert_eq!(applied, Applied { renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 1 });
        assert!(!d.index.exists(), "an index was invented for a folder that had none");
    }

    #[test]
    fn an_index_with_many_entries_is_patched_by_position_not_by_scan() {
        let f = fixture();
        let d = &f.dirs;
        let entries: Vec<String> = (1..=500)
            .map(|uid| format!(r#"{{"uid":{},"flags":{}}}"#, uid, if uid % 2 == 0 { r#"["\\Seen"]"# } else { "[]" }))
            .collect();
        fs::write(&d.index, format!("[{}]", entries.join(","))).unwrap();
        // The server: everything read.
        let changes: Vec<FlagChange> = (1..=500).map(|uid| change(uid, &["\\Seen"])).collect();

        let applied = apply_in(d, &changes, false);

        assert_eq!(applied.index_patched, 250);
        assert_eq!(flags_of(&d.index, 1), Some(s(&["\\Seen"])));
        assert_eq!(flags_of(&d.index, 499), Some(s(&["\\Seen"])));
        assert_eq!(flags_of(&d.index, 500), Some(s(&["\\Seen"])));
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
        fs::write(d.cur.join("1:2,A"), b"a").unwrap();
        fs::write(d.cur.join("2:2,AS"), b"b").unwrap();
        fs::write(d.cur.join("3:2,AS"), b"c").unwrap();
        fs::write(&d.index, r#"[{"uid":1,"flags":[]},{"uid":2,"flags":["\\Seen"]},{"uid":3,"flags":["\\Seen"]}]"#).unwrap();

        // A sidecar the reconcile must leave to the sync engine.
        fs::write(d.sidecar_dir.join("1.json"), r#"{"uid":1,"flags":[]}"#).unwrap();

        // The server: 1 was read elsewhere, 2 is as stored, 3 was marked unread.
        let applied = apply_in(d, &[change(1, &["\\Seen"]), change(2, &["\\Seen"]), change(3, &[])], false);

        assert_eq!(applied, Applied { renamed: 2, mirrored: 0, index_patched: 2, sidecars_patched: 0 });
        assert_eq!(flags_of(&d.sidecar_dir.join("1.json"), 1), Some(s(&[])));
        assert_eq!(names(&d.cur), vec!["1:2,AS", "2:2,AS", "3:2,A"]);
        assert_eq!(flags_of(&d.index, 1), Some(s(&["\\Seen"])));
        assert_eq!(flags_of(&d.index, 3), Some(s(&[])));
    }
}
