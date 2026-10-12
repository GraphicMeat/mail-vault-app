//! Vault-location file work (Phase 6): folder classification, the offload
//! copy/verify/cleanup pipeline. Ported verbatim from the app's `vault.rs`
//! (Phase 0-5 kept this here because it needed `tauri::AppHandle` only for
//! the bookmark it read the path through — the algorithms themselves were
//! always `&Path`-pure). The daemon calls these directly; the app no longer
//! does any of this work itself.

use crate::custody::db::{DB_DIR as CUSTODY_DIR, DB_FILE as CUSTODY_FILE};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Outcome of inspecting a folder the user just picked, or the destination of
/// a move, before doing anything destructive with it.
#[derive(Debug, Serialize)]
pub struct FolderInspection {
    /// "our_vault" | "other_vault" | "unmarked_mail" | "empty" | "occupied"
    pub kind: String,
    #[serde(rename = "vaultId", skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    pub writable: bool,
    #[serde(rename = "emailCount")]
    pub email_count: usize,
}

/// The messages under the folder's `Maildir/`, in either storage format, by
/// name alone (`message_store::count_under`): a uid with a Maildir file and a
/// record (a conversion in progress) is one message.
pub fn count_messages(dir: &Path) -> usize {
    crate::message_store::count_under(&dir.join("Maildir"))
}

/// Classify `dir` against `expected_vault_id` (the id recorded at the app's
/// own data dir, if any — `None` when this app has never adopted a vault).
pub fn classify_folder(dir: &Path, expected_vault_id: Option<&str>) -> Result<FolderInspection, String> {
    if !dir.is_dir() {
        return Err("That path is not a folder".to_string());
    }

    let probe = dir.join(".mailvault-write-test");
    let writable = std::fs::write(&probe, b"test").is_ok();
    let _ = std::fs::remove_file(&probe);

    let marker = crate::vault_layout::read_marker(dir);
    let kind = match (&marker, crate::vault_layout::looks_like_vault(dir)) {
        (Some(m), _) => {
            if expected_vault_id == Some(m.vault_id.as_str()) { "our_vault" } else { "other_vault" }
        }
        (None, true) => "unmarked_mail",
        (None, false) => {
            let empty = std::fs::read_dir(dir).map(|mut e| e.next().is_none()).unwrap_or(false);
            if empty { "empty" } else { "occupied" }
        }
    };

    Ok(FolderInspection {
        kind: kind.to_string(),
        vault_id: marker.map(|m| m.vault_id),
        writable,
        email_count: count_messages(dir),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveProgress {
    pub phase: String, // "copying" | "verifying" | "cleaning" | "done"
    pub copied: usize,
    pub total: usize,
    #[serde(rename = "currentDir")]
    pub current_dir: String,
}

pub fn count_files(dir: &Path) -> usize {
    let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return 0 };
    entries.flatten().map(|e| {
        let p = e.path();
        if p.is_dir() { count_files(&p) } else { 1 }
    }).sum()
}

/// The blob id a path names, when it is `message_blobs/<h0h1>/<hex>.eml`
/// (`jmap_store::blobs::blob_path`): a blob's name is the sha256 of its bytes.
fn blob_id_named_by(path: &Path) -> Option<String> {
    let hex = path.file_name()?.to_str()?.strip_suffix(".eml")?;
    let id = format!("sha256-{hex}");
    let shard = path.parent()?;
    let named = crate::jmap_store::blobs::is_valid_id(&id)
        && shard.file_name()?.to_str() == hex.get(0..2)
        && shard.parent()?.file_name()?.to_str()? == crate::jmap_store::blobs::BLOB_DIR;
    named.then_some(id)
}

/// Whether the file at `to` hashes to the blob id `id`. A file that will not
/// read is not intact.
fn blob_is_intact(to: &Path, id: &str) -> bool {
    std::fs::read(to).is_ok_and(|bytes| crate::jmap_store::blobs::blob_id(&bytes) == id)
}

/// Copy `src` into `dst` recursively. Returns (files, bytes) actually written.
/// Existing destination files with the same size are left alone so an
/// interrupted offload can be resumed by running it again; a message blob is
/// kept only when its bytes hash to its name (a power loss can leave one at
/// full length with zeroed data, and the verify that follows deletes the
/// source's good copy).
pub fn copy_tree(src: &Path, dst: &Path, copied: &mut usize, bytes: &mut u64) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {}", dst.display(), e))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("read {}: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to, copied, bytes)?;
            continue;
        }
        let src_len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        // A JMAP record is rewritten in place under its one name (a flag
        // change, the blob of an overwritten draft), often at the same
        // length: one left by an interrupted run is never taken as copied.
        let same_len = to.metadata().map(|m| m.len()).ok() == Some(src_len);
        let kept = same_len
            && !crate::message_store::is_record_path(&from)
            && blob_id_named_by(&from).is_none_or(|id| blob_is_intact(&to, &id));
        if kept {
            *copied += 1;
            *bytes += src_len;
            continue;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {}", from.display(), e))?;
        *copied += 1;
        *bytes += src_len;
    }
    Ok(())
}

/// Verify every file in `src` exists in `dst` with the same size, and every
/// JMAP record with the same bytes (`copy_tree`: its size proves nothing),
/// and every message blob hashing to its name. Returns the first mismatch found.
pub fn verify_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("read {}: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            verify_tree(&from, &to)?;
            continue;
        }
        let src_len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match to.metadata() {
            Ok(m) if m.len() == src_len => {}
            Ok(m) => return Err(format!("{} copied as {} bytes, expected {}", to.display(), m.len(), src_len)),
            Err(e) => return Err(format!("{} is missing from the new location: {}", to.display(), e)),
        }
        if crate::message_store::is_record_path(&from) {
            let want = std::fs::read(&from).map_err(|e| format!("read {}: {}", from.display(), e))?;
            let got = std::fs::read(&to).map_err(|e| format!("read {}: {}", to.display(), e))?;
            if want != got {
                return Err(format!("{} did not arrive intact", to.display()));
            }
        }
        if let Some(id) = blob_id_named_by(&from) {
            if !blob_is_intact(&to, &id) {
                return Err(format!("{} did not arrive intact", to.display()));
            }
        }
    }
    Ok(())
}

/// A free `<name>.pre-move-<stamp>` beside `path`, `-<n>` while taken.
fn set_aside_name(path: &Path, stamp: u64) -> Result<PathBuf, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    for n in 0..100 {
        let suffix = if n == 0 { String::new() } else { format!("-{n}") };
        let candidate = path.with_file_name(format!("{name}.pre-move-{stamp}{suffix}"));
        if candidate.symlink_metadata().is_err() {
            return Ok(candidate);
        }
    }
    Err(format!("Cannot set aside {}: every .pre-move name is taken", path.display()))
}

/// Move the destination's custody files out of the way so `copy_tree` copies
/// the source's unconditionally.
///
/// The index gets deleted here for the same reason (`copy_tree`'s size-equal
/// resume skip would keep a stale file), but custody is never derived and never
/// deleted, so it is renamed aside instead. `custody.db` is rewritten in place
/// — `json_set` on a row, then a checkpoint back into the same pages — so a
/// stale copy at the destination is the same length as the live one far more
/// often than not, and "same size" means nothing about its content.
///
/// ponytail: repeated interrupted retries leave one `.pre-move-*` set per
/// attempt. Bounded by the number of retries, and never deleting them is the point.
fn set_aside_custody(src_root: &Path, dst_root: &Path) -> Result<(), String> {
    // Only when the source brings its own: otherwise the destination would be
    // left with no live store at all, for nothing.
    if !src_root.join(CUSTODY_DIR).exists() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = dst_root.join(CUSTODY_DIR).join(format!("{CUSTODY_FILE}{suffix}"));
        if path.symlink_metadata().is_err() {
            continue;
        }
        let aside = set_aside_name(&path, stamp)?;
        std::fs::rename(&path, &aside)
            .map_err(|e| format!("Cannot set aside the old custody store at {}: {}", path.display(), e))?;
    }
    Ok(())
}

/// The custody store arrived byte for byte. `verify_tree` compares sizes, which
/// is the right proof for an immutable `.eml`; custody is the vault's only
/// mutated-in-place, non-derivable file, so it gets the stronger check before
/// anything is removed from the source.
///
/// ponytail: reads both files whole. One small file; switch to a streaming
/// compare if a vault ever carries a custody store worth chunking.
fn verify_custody(src_root: &Path, dst_root: &Path) -> Result<(), String> {
    let src = src_root.join(CUSTODY_DIR).join(CUSTODY_FILE);
    if src.symlink_metadata().is_err() {
        return Ok(());
    }
    let dst = dst_root.join(CUSTODY_DIR).join(CUSTODY_FILE);
    let from = std::fs::read(&src).map_err(|e| format!("read {}: {}", src.display(), e))?;
    let to = std::fs::read(&dst)
        .map_err(|e| format!("{} is missing from the new location: {}", dst.display(), e))?;
    if from != to {
        return Err(format!(
            "The custody records did not arrive intact at {}. Nothing has been removed.",
            dst.display()
        ));
    }
    Ok(())
}

/// Copy every vault dir present in `src_root` into `dst_root` and check it all
/// arrived. Nothing is deleted from the source here — the caller switches over
/// first. Only the derived index files at the destination are cleared.
/// Returns (dirs copied, files copied, bytes copied).
pub fn copy_and_verify<F: Fn(MoveProgress)>(
    src_root: &Path,
    dst_root: &Path,
    on_progress: &F,
) -> Result<(Vec<&'static str>, usize, u64), String> {
    // A leftover index at the destination is derived data. Left in place, copy_tree's
    // size-equal skip could keep its file, or pair a fresh index with a stale -wal.
    // Only our file names: the folder is the user's pick, and anything else in a
    // `search_index` directory there is not ours to delete.
    use crate::search_index::db::{DB_DIR, DB_FILE};
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = dst_root.join(DB_DIR).join(format!("{DB_FILE}{suffix}"));
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("Cannot clear the old search index at {}: {}", path.display(), e));
            }
            _ => {}
        }
    }
    set_aside_custody(src_root, dst_root)?;
    let present: Vec<&'static str> = crate::vault_layout::VAULT_DIRS.iter().copied().filter(|d| src_root.join(d).exists()).collect();
    let total: usize = present.iter().map(|d| count_files(&src_root.join(d))).sum();

    let mut copied = 0usize;
    let mut bytes = 0u64;
    for dir in &present {
        on_progress(MoveProgress { phase: "copying".into(), copied, total, current_dir: dir.to_string() });
        copy_tree(&src_root.join(dir), &dst_root.join(dir), &mut copied, &mut bytes)?;
    }

    on_progress(MoveProgress { phase: "verifying".into(), copied, total, current_dir: String::new() });
    for dir in &present {
        verify_tree(&src_root.join(dir), &dst_root.join(dir))?;
    }
    verify_custody(src_root, dst_root)?;

    Ok((present, copied, bytes))
}

/// The marker step of a vault move (`vault_move_to`), once the copy verified:
/// the destination keeps the identity rows it has (an interrupted move run
/// again), else gets new ones, then takes the source's storage format
/// (`carry_format`).
pub fn carry_marker(src_root: &Path, dst_root: &Path) -> Result<(), String> {
    let marker = crate::vault_layout::read_marker(dst_root).unwrap_or(crate::vault_layout::VaultMarker {
        app: "mailvault".into(),
        vault_id: crate::vault_layout::new_vault_id(),
        created_at: crate::vault_layout::now_millis(),
    });
    crate::vault_layout::write_marker(dst_root, &marker)?;
    carry_format(src_root, dst_root)
}

/// A marker that will not read or write while its storage format is carried
/// (`carry_format`). The text after the code names the cause.
pub const E_FORMAT_MARKER: &str = "E_FORMAT_MARKER";

/// The marker rows that say how copied mail is stored, from the vault at
/// `src_root` to its copy at `dst_root` (a vault move, a portable copy):
/// - `storageFormat` as the source has it, and `maildir` when it has none:
///   the destination's marker may be an older vault's, with a `jmap` row of
///   its own (the app data dir keeps its marker when the vault moves out).
/// - `storageMigration` empty: no conversion runs at the copy (a move is
///   refused while one is in progress, and a stopped one is no job).
///
/// A source marker that will not read fails the carry
/// (`E_FORMAT_MARKER: ...`), never reads as `maildir`: writers would then
/// write Maildir files into a JMAP vault. Then the format this process
/// cached for `dst_root` is dropped (`invalidate_vault_format`), keyed by
/// the root as the caller spells it, the spelling its `vault_format` calls use.
pub fn carry_format(src_root: &Path, dst_root: &Path) -> Result<(), String> {
    let marker = |e: String| format!("{E_FORMAT_MARKER}: {e}");
    let format = crate::vault_layout::read_marker_row(src_root, crate::message_store::FORMAT_KEY).map_err(marker)?;
    crate::vault_layout::write_marker_value(dst_root, crate::message_store::FORMAT_KEY, format.as_deref().unwrap_or("maildir")).map_err(marker)?;
    crate::vault_layout::write_marker_value(dst_root, crate::message_store::MIGRATION_KEY, "").map_err(marker)?;
    crate::message_store::invalidate_vault_format(dst_root);
    Ok(())
}

/// Delete the copied-from dirs. Only ever called once the destination is live.
/// Returns `false` (with a `warn!` at the call site) when any dir could not be
/// removed — the caller reports this as `sourceRemoved: false`, not an error:
/// the destination is already live and correct.
///
/// A `NotFound` error counts as success, not failure: on a case-insensitive
/// filesystem (the macOS default), `VAULT_DIRS`' `"Maildir"` and the legacy
/// `"maildir"` entry name the same on-disk directory, so removing the first
/// makes the second vanish too — the goal ("this data is gone") is already
/// met, and treating that as a failure would misreport a clean move as
/// partial. Same idiom `copy_and_verify`'s index-cleanup loop already uses.
pub fn remove_sources(src_root: &Path, present: &[&str]) -> bool {
    let mut removed = true;
    for dir in present {
        let path = src_root.join(dir);
        // Already gone (case-insensitive-fs alias removed by an earlier
        // entry in this same loop) — the goal is met, nothing to report.
        if !path.exists() {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(&path) {
            tracing::warn!("[vault] could not remove {} after offload: {}", dir, e);
            removed = false;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-vault-ops-{name}-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    // ── Task 10: a JMAP vault moves whole ──

    fn flags(f: &[&str]) -> Vec<String> {
        f.iter().map(|x| x.to_string()).collect()
    }

    fn eml(id: &str) -> Vec<u8> {
        format!("Message-ID: <{id}@x.test>\r\nSubject: {id}\r\n\r\nbody of {id}\r\n").into_bytes()
    }

    type Held = (&'static str, &'static str, u32, Vec<u8>, Vec<String>);

    /// A JMAP vault at `root` (marked, vault id `src-id`), and what it holds:
    /// `(account, mailbox, uid, bytes, flags)`. `a2/INBOX` 9 has the bytes of
    /// `a1/INBOX` 2, so the two records share one blob.
    fn jmap_vault(root: &Path) -> Vec<Held> {
        crate::vault_layout::write_marker(
            root,
            &crate::vault_layout::VaultMarker { app: "mailvault".into(), vault_id: "src-id".into(), created_at: 1 },
        )
        .unwrap();
        crate::message_store::set_vault_format(root, crate::message_store::Format::Jmap).unwrap();
        let held: Vec<Held> = vec![
            ("a1", "INBOX", 1, eml("one"), flags(&["seen"])),
            ("a1", "INBOX", 2, eml("two"), flags(&["archived"])),
            ("a1", "Work", 3, eml("three"), flags(&[])),
            ("a2", "INBOX", 9, eml("two"), flags(&["flagged"])),
        ];
        for (account, mailbox, uid, raw, flags) in &held {
            crate::message_store::write(root, account, mailbox, *uid, raw, flags).unwrap();
        }
        held
    }

    #[test]
    fn classify_folder_counts_a_jmap_vault_once_per_message() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        jmap_vault(root);
        // uid 1 also has its Maildir file (a conversion in progress): one
        // message. Work 4 is in Maildir alone.
        crate::message_store::set_vault_format(root, crate::message_store::Format::Maildir).unwrap();
        crate::message_store::write(root, "a1", "INBOX", 1, &eml("one"), &flags(&["seen"])).unwrap();
        crate::message_store::write(root, "a1", "Work", 4, &eml("four"), &[]).unwrap();

        let found = classify_folder(root, Some("src-id")).unwrap();
        assert_eq!((found.kind.as_str(), found.email_count), ("our_vault", 5));
    }

    #[test]
    fn classify_folder_does_not_take_a_retired_folder_alone_for_a_vault() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("retired/format-20261012-101500")).unwrap();
        assert_eq!(classify_folder(dir.path(), None).unwrap().kind, "occupied");
    }

    /// The move as `vault_move_to` and `vault_move_finalize` run it: copy and
    /// verify, the marker step, then the source goes.
    #[test]
    fn a_real_move_carries_a_jmap_vault_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        let held = jmap_vault(&src);
        // Old files a conversion kept aside travel with the vault.
        let kept = src.join(format!("retired/format-20261012-101500/a1/INBOX/cur/1{}S.eml", crate::maildir::INFO_PREFIX));
        fs::create_dir_all(kept.parent().unwrap()).unwrap();
        fs::write(&kept, eml("one")).unwrap();
        // This process asked about the destination before: no marker, Maildir.
        assert_eq!(crate::message_store::vault_format(&dst), crate::message_store::Format::Maildir);
        let entry = |root: &Path, (account, mailbox, uid, _, _): &Held| crate::message_store::find(root, account, mailbox, *uid).unwrap();
        let before: Vec<_> = held.iter().map(|h| entry(&src, h)).collect();

        let (present, _, _) = copy_and_verify(&src, &dst, &|_| {}).unwrap();
        carry_marker(&src, &dst).unwrap();
        assert!(remove_sources(&src, &present));

        assert_eq!(crate::message_store::vault_format(&dst), crate::message_store::Format::Jmap, "the format came along; the cached answer went");
        for (h, was) in held.iter().zip(&before) {
            let (account, mailbox, uid, raw, _) = h;
            assert_eq!(crate::message_store::read_raw(&dst, account, mailbox, *uid).unwrap().as_ref(), Some(raw), "{account}/{mailbox}/{uid}");
            assert_eq!(entry(&dst, h).flags, was.flags, "{account}/{mailbox}/{uid}");
        }
        assert!(present.contains(&"message_blobs") && present.contains(&"retired"), "{present:?}");
        assert_eq!(fs::read(dst.join(kept.strip_prefix(&src).unwrap())).unwrap(), eml("one"));
        assert!(crate::vault_layout::read_marker(&dst).is_some(), "the destination is marked");
        assert_eq!(crate::vault_layout::read_marker_value(&dst, "storageMigration").as_deref(), Some(""), "no conversion runs there");
        for dir in ["Maildir", "message_blobs", "retired"] {
            assert!(!src.join(dir).exists(), "{dir} is gone from the source");
        }
    }

    /// The app data dir keeps its marker when the vault moves out of it, so a
    /// move back finds the rows of the vault it once held.
    #[test]
    fn a_move_writes_maildir_over_a_stale_jmap_row() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        crate::message_store::write(&src, "a1", "INBOX", 1, &eml("one"), &[]).unwrap();
        crate::vault_layout::write_marker_value(&dst, "storageFormat", "jmap").unwrap();
        crate::vault_layout::write_marker_value(&dst, "storageMigration", "3f1e0c1a-0000-4000-8000-000000000001").unwrap();

        carry_marker(&src, &dst).unwrap();
        assert_eq!(crate::vault_layout::read_marker_value(&dst, "storageFormat").as_deref(), Some("maildir"));
        assert_eq!(crate::vault_layout::read_marker_value(&dst, "storageMigration").as_deref(), Some(""));
    }

    #[test]
    fn a_move_stops_when_the_source_format_will_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join(crate::vault_layout::MARKER_FILE), vec![b'x'; 4096]).unwrap();

        let err = carry_marker(&src, &dst).unwrap_err();
        assert!(err.starts_with("E_FORMAT_MARKER: "), "{err}");
        assert_eq!(crate::vault_layout::read_marker_value(&dst, "storageFormat"), None, "never guessed");
    }

    /// An interrupted move run again: a record rewritten since, at the same
    /// length, is neither kept by the copy nor passed by the verify.
    #[test]
    fn a_resumed_move_recopies_a_record_rewritten_at_the_same_length() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        jmap_vault(&src);
        copy_and_verify(&src, &dst, &|_| {}).unwrap();

        crate::message_store::set_flags(&src, "a1", "INBOX", 2, &flags(&["trashed"])).unwrap();
        let record = |root: &Path| fs::read(crate::message_store::mailbox_dir(root, "a1", "INBOX").join("jmap/2.json")).unwrap();
        assert_eq!(record(&src).len(), record(&dst).len(), "the case this pins: one length");
        assert_ne!(record(&src), record(&dst));
        assert!(verify_tree(&src.join("Maildir"), &dst.join("Maildir")).is_err(), "a stale record does not verify");

        copy_and_verify(&src, &dst, &|_| {}).unwrap();
        assert_eq!(record(&dst), record(&src));
        let trashed = |root: &Path| crate::message_store::find(root, "a1", "INBOX", 2).unwrap().flags;
        assert_eq!(trashed(&dst), trashed(&src));
        assert!(trashed(&dst).contains(&"trashed".to_string()));
    }

    #[test]
    fn copy_then_verify_detects_a_truncated_file() {
        let base = tmp("verify");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("Maildir/acc/INBOX/cur")).unwrap();
        let name = format!("Maildir/acc/INBOX/cur/1{}S.eml", crate::maildir::INFO_PREFIX);
        fs::write(src.join(&name), b"hello world").unwrap();

        let (mut n, mut b) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n, &mut b).unwrap();
        assert_eq!(n, 1);
        assert_eq!(b, 11);
        verify_tree(&src, &dst).unwrap();

        fs::write(dst.join(&name), b"hel").unwrap();
        assert!(verify_tree(&src, &dst).is_err());

        fs::remove_file(dst.join(&name)).unwrap();
        assert!(verify_tree(&src, &dst).is_err());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_move_clears_only_the_index_files_at_the_destination() {
        let base = tmp("dest-index");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(dst.join("search_index")).unwrap();
        fs::write(dst.join("search_index/index.db"), b"stale").unwrap();
        fs::write(dst.join("search_index/index.db-wal"), b"stale wal").unwrap();
        fs::write(dst.join("search_index/keep.txt"), b"another app's file").unwrap();

        copy_and_verify(&src, &dst, &|_| {}).unwrap();

        assert!(!dst.join("search_index/index.db").exists());
        assert!(!dst.join("search_index/index.db-wal").exists());
        assert_eq!(fs::read(dst.join("search_index/keep.txt")).unwrap(), b"another app's file");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_move_carries_the_custody_store_byte_for_byte() {
        let base = tmp("custody");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("custody")).unwrap();
        fs::write(src.join("custody/custody.db"), b"custody rows the user cannot get back").unwrap();

        copy_and_verify(&src, &dst, &|_| {}).unwrap();

        assert_eq!(fs::read(dst.join("custody/custody.db")).unwrap(), b"custody rows the user cannot get back");
        assert!(crate::vault_layout::VAULT_DIRS.contains(&"custody"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_resumed_move_replaces_a_same_size_stale_custody_store() {
        let base = tmp("custody-resume");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("custody")).unwrap();
        fs::create_dir_all(dst.join("custody")).unwrap();
        let fresh = b"custody rows written after the interrupted move";
        let stale = b"custody rows from the interrupted move.........";
        assert_eq!(fresh.len(), stale.len(), "the test is only meaningful at equal length");
        fs::write(src.join("custody/custody.db"), fresh).unwrap();
        fs::write(dst.join("custody/custody.db"), stale).unwrap();

        copy_and_verify(&src, &dst, &|_| {}).unwrap();

        assert_eq!(fs::read(dst.join("custody/custody.db")).unwrap(), fresh);
        let aside: Vec<String> = fs::read_dir(dst.join("custody"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("custody.db.pre-move-"))
            .collect();
        assert_eq!(aside.len(), 1, "expected one set-aside copy, found {:?}", aside);
        assert_eq!(fs::read(dst.join("custody").join(&aside[0])).unwrap(), stale);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_move_fails_before_removal_when_the_custody_copy_differs() {
        let base = tmp("custody-verify");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("custody")).unwrap();
        fs::write(src.join("custody/custody.db"), b"the records the user cannot rebuild").unwrap();

        copy_and_verify(&src, &dst, &|_| {}).unwrap();
        verify_custody(&src, &dst).unwrap();

        fs::write(dst.join("custody/custody.db"), b"THE RECORDS THE USER CANNOT REBUILD").unwrap();
        assert!(verify_custody(&src, &dst).is_err(), "a differing custody copy must stop the move");
        verify_tree(&src, &dst).unwrap();

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_tree_resumes_without_recopying() {
        let base = tmp("resume");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.eml"), b"aaaa").unwrap();
        fs::write(src.join("b.eml"), b"bb").unwrap();

        let (mut n, mut b) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n, &mut b).unwrap();
        assert_eq!((n, b), (2, 6));

        fs::write(dst.join("a.eml"), b"x").unwrap();
        let (mut n2, mut b2) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n2, &mut b2).unwrap();
        assert_eq!((n2, b2), (2, 6));
        verify_tree(&src, &dst).unwrap();

        let _ = fs::remove_dir_all(&base);
    }

    /// A power loss mid-move can leave a destination blob at full length with
    /// zeroed data. The resumed move must not keep it (the source is deleted
    /// once the verify passes), and the verify must not pass it.
    #[test]
    fn a_resumed_move_repairs_a_same_length_corrupt_destination_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        jmap_vault(&src);
        copy_and_verify(&src, &dst, &|_| {}).unwrap();

        let blobs_in = |root: &Path| -> Vec<PathBuf> {
            walkdir::WalkDir::new(root.join("message_blobs")).into_iter().flatten().filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect()
        };
        let blob = blobs_in(&dst).pop().expect("the vault holds blobs");
        let good = fs::read(&blob).unwrap();
        fs::write(&blob, vec![0u8; good.len()]).unwrap();
        assert_eq!(fs::metadata(&blob).unwrap().len(), good.len() as u64, "the case this pins: one length");

        assert!(verify_tree(&src.join("message_blobs"), &dst.join("message_blobs")).is_err(), "a zeroed blob does not verify");
        copy_and_verify(&src, &dst, &|_| {}).unwrap();
        assert_eq!(fs::read(&blob).unwrap(), good, "the bad blob was copied again");
        verify_tree(&src.join("message_blobs"), &dst.join("message_blobs")).unwrap();
    }

    #[test]
    fn classify_folder_our_vault_vs_other_vault() {
        let dir = tmp("classify-marker");
        crate::vault_layout::write_marker(
            &dir,
            &crate::vault_layout::VaultMarker { app: "mailvault".into(), vault_id: "abc".into(), created_at: 1 },
        )
        .unwrap();

        let ours = classify_folder(&dir, Some("abc")).unwrap();
        assert_eq!(ours.kind, "our_vault");

        let theirs = classify_folder(&dir, Some("xyz")).unwrap();
        assert_eq!(theirs.kind, "other_vault");

        let unset = classify_folder(&dir, None).unwrap();
        assert_eq!(unset.kind, "other_vault");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_folder_unmarked_mail_empty_and_occupied() {
        let unmarked = tmp("classify-unmarked");
        fs::create_dir_all(unmarked.join("Maildir")).unwrap();
        assert_eq!(classify_folder(&unmarked, None).unwrap().kind, "unmarked_mail");
        let _ = fs::remove_dir_all(&unmarked);

        let empty = tmp("classify-empty");
        assert_eq!(classify_folder(&empty, None).unwrap().kind, "empty");
        let _ = fs::remove_dir_all(&empty);

        let occupied = tmp("classify-occupied");
        fs::write(occupied.join("readme.txt"), b"not ours").unwrap();
        assert_eq!(classify_folder(&occupied, None).unwrap().kind, "occupied");
        let _ = fs::remove_dir_all(&occupied);
    }

    #[test]
    fn classify_folder_rejects_a_non_directory_path() {
        let base = tmp("classify-file");
        let file = base.join("not-a-dir");
        fs::write(&file, b"x").unwrap();
        assert!(classify_folder(&file, None).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_sources_reports_true_when_every_dir_is_removed() {
        let base = tmp("remove-sources");
        fs::create_dir_all(base.join("Maildir")).unwrap();
        assert!(remove_sources(&base, &["Maildir"]));
        assert!(!base.join("Maildir").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_sources_treats_an_already_absent_dir_as_success_not_failure() {
        // The real trigger: on a case-insensitive filesystem (the macOS
        // default), VAULT_DIRS' "Maildir" and the legacy "maildir" name the
        // SAME on-disk directory, so removing the first makes the second
        // vanish too. `present` lists both (each existed at copy time), and
        // the second removal must not turn a clean move into a reported
        // partial one just because its target is already gone.
        let base = tmp("remove-sources-double");
        fs::create_dir_all(base.join("Maildir")).unwrap();
        assert!(remove_sources(&base, &["Maildir", "Maildir"]), "removing the same dir twice must not report a failure");
        assert!(!base.join("Maildir").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_sources_reports_false_when_a_present_dir_is_a_file_and_cannot_be_removed_as_a_directory() {
        // A genuine failure, portable without permission tricks:
        // `remove_dir_all` on a path that is actually a file errors with
        // something other than NotFound, which must still count as failure.
        let base = tmp("remove-sources-blocked");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("Maildir"), b"not a directory").unwrap();
        assert!(!remove_sources(&base, &["Maildir"]));
        assert!(base.join("Maildir").exists(), "a failed removal must leave the blocking file in place");
        let _ = fs::remove_dir_all(&base);
    }
}
