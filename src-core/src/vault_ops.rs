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

pub fn count_messages(dir: &Path) -> usize {
    fn walk(dir: &Path, count: &mut usize) {
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count);
            } else if crate::maildir::has_info(&entry.file_name().to_string_lossy()) {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(&dir.join("Maildir"), &mut count);
    count
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

/// Copy `src` into `dst` recursively. Returns (files, bytes) actually written.
/// Existing destination files with the same size are left alone so an
/// interrupted offload can be resumed by running it again.
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
        if to.metadata().map(|m| m.len()).ok() == Some(src_len) {
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

/// Verify every file in `src` exists in `dst` with the same size.
/// Returns the first mismatch found.
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

    #[test]
    fn copy_then_verify_detects_a_truncated_file() {
        let base = tmp("verify");
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("Maildir/acc/INBOX/cur")).unwrap();
        fs::write(src.join("Maildir/acc/INBOX/cur/1:2,S.eml"), b"hello world").unwrap();

        let (mut n, mut b) = (0usize, 0u64);
        copy_tree(&src, &dst, &mut n, &mut b).unwrap();
        assert_eq!(n, 1);
        assert_eq!(b, 11);
        verify_tree(&src, &dst).unwrap();

        fs::write(dst.join("Maildir/acc/INBOX/cur/1:2,S.eml"), b"hel").unwrap();
        assert!(verify_tree(&src, &dst).is_err());

        fs::remove_file(dst.join("Maildir/acc/INBOX/cur/1:2,S.eml")).unwrap();
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
