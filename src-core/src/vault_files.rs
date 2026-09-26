//! Root-based bodies of the maildir / attachment-cache / repair-input Tauri
//! commands (spec 2026-09-14 §3, plan Task 2.2). Moved verbatim from
//! `src-tauri/src/main.rs` apart from two authorized behaviour changes:
//! `store` writes the new name with `fsx::write_atomic` before removing a
//! differently-named old file (was: remove-then-plain-write), and every
//! uid-from-filename parse that fed a listing or a bulk delete now uses
//! `maildir::vault_filename_uid` instead of `split(':').next().parse()`
//! (oddity 5) — `find_by_uid`'s own prefix rule is unchanged, since `store`
//! still has to find a legacy-named straggler to replace.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::fsx::{mark_from_internet, write_atomic};
use crate::maildir::{self, find_by_uid, vault_filename_uid};
use crate::vault_registry::VaultRegistry;
use crate::vault_eml::{
    collect_attachment_parts, is_real_attachment, parse_eml_bytes, parse_eml_bytes_light,
    parse_flags_from_filename, part_filename, read_light_at, walk_mime_parts_light, LightEmail,
    ParsedEmail,
};

/// The write gate a whole-vault walker takes around each individual file's
/// write or delete, so the walk never holds the daemon's vault gate for its
/// whole duration. The ONLY production implementation is the daemon's
/// `handlers::common::with_vault_write` (wrapped per file at the call site in
/// `src-daemon/src/handlers/vault_files.rs`); everything else is a test
/// closure. Named so that a future caller cannot pass a silent no-op —
/// `|work| work()` compiles and would quietly un-gate a vault-wide walk
/// (Task 2.8 review M4).
pub type VaultGate<'a> = &'a dyn Fn(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>;

// ── Paths and filenames ──────────────────────────────────────────────────────

/// `{root}/Maildir/{account_id}/{vault_dir_name(mailbox)}/cur`.
///
/// `account_id` is NOT sanitized here (unlike `mailbox`): a legacy,
/// pre-migration account directory is keyed by the raw email address
/// (`migrate_email_dirs` reads `maildir_base.join(email)` literally, `@` and
/// all), so sanitizing it in this shared builder would silently point reads
/// and writes at the wrong directory for any account not yet migrated to its
/// UUID dir. Callers that accept `account_id` from an untrusted surface must
/// sanitize it themselves before calling in (see `backup_zip::import` and
/// `mbox::import_mbox`).
pub fn cur_path(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    let safe_mailbox = crate::search_index::text::vault_dir_name(mailbox);
    root.join("Maildir").join(account_id).join(&safe_mailbox).join("cur")
}

/// Build a vault filename from UID and flags: `{uid}:2,{letters}.eml` (`;2,`
/// on Windows, see `maildir::INFO_SEP`), letters sorted and deduped (A D F R S T).
pub fn build_maildir_filename(uid: u32, flags: &[String]) -> String {
    let mut flag_chars: Vec<char> = Vec::new();
    for f in flags {
        match f.to_lowercase().as_str() {
            "archived" | "a" => flag_chars.push('A'),
            "draft" | "d" => flag_chars.push('D'),
            "flagged" | "f" => flag_chars.push('F'),
            "replied" | "r" => flag_chars.push('R'),
            "seen" | "s" => flag_chars.push('S'),
            "trashed" | "t" => flag_chars.push('T'),
            _ => {}
        }
    }
    flag_chars.sort();
    flag_chars.dedup();
    let flag_str: String = flag_chars.into_iter().collect();
    format!("{}{}{}.eml", uid, crate::maildir::INFO_PREFIX, flag_str)
}

/// Delete every vault file of the mailbox whose uid is in `uids`. One
/// directory pass — the per-uid `find_by_uid` rescans the whole directory
/// each call, which is quadratic over a bulk selection. The registry drops
/// the uids whose files went; a failed removal leaves the disk uncertain, so
/// the mailbox is invalidated instead.
pub fn delete_maildir_files(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uids: &HashSet<u32>) -> usize {
    let cur_dir = cur_path(root, account_id, mailbox);
    let mut removed = 0usize;
    let mut gone: Vec<u32> = Vec::new();
    let mut failed = false;
    if let Ok(entries) = fs::read_dir(&cur_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(uid) = vault_filename_uid(&name) else { continue };
            if !uids.contains(&uid) {
                continue;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => {
                    crate::pgp::remove_copy(&cur_dir, uid);
                    removed += 1;
                    gone.push(uid);
                }
                Err(e) => {
                    failed = true;
                    warn!("maildir purge: failed to remove {:?}: {}", entry.path(), e);
                }
            }
        }
    }
    gone.sort_unstable();
    gone.dedup();
    reg.remove(account_id, mailbox, &gone);
    if failed {
        reg.invalidate(account_id, mailbox);
    }
    removed
}

// ── Store / read / list / delete / set_flags ─────────────────────────────────

/// Decode a `maildir_store` `rawSourceBase64` payload. Lives here (not the
/// daemon crate, which does not depend on `base64`) so the daemon's
/// `maildir_store` route can classify a bad payload as `INVALID_PARAMS`
/// before calling `store`, rather than as a generic write failure.
pub fn decode_raw_source(raw_source_base64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(raw_source_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))
}

/// Store `raw` under `uid`. `overwrite` selects `maildir_store`'s semantics
/// (always replace) vs `maildir_store_raw`'s (skip if a file for this uid
/// already exists). Returns whether a write happened.
///
/// The new name is written first with `write_atomic`, then every OTHER file
/// for the same uid is removed — not just the one `find_by_uid` would have
/// returned, so a crash-left duplicate from an earlier interrupted store does
/// not survive the next one (M4). A failed or killed write leaves every
/// existing copy intact (oddity 1; was remove-then-plain-write).
///
/// On a mailbox the registry has verified, the registry answers "does uid
/// already exist" and there is no directory sweep: a verified miss is
/// authoritative, and the one stale file is the row's own name. An
/// unverified mailbox keeps the sweep.
///
/// Every writer here updates `reg` right after its fs op. The caller holds
/// the mailbox's `VaultRegistry::serialized` lock around the call (the
/// daemon's `with_mailbox_write`), so two writers of one mailbox never
/// interleave a file op with the other's registry update.
pub fn store(
    reg: &VaultRegistry,
    root: &Path,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    raw: &[u8],
    flags: &[String],
    overwrite: bool,
) -> Result<bool, String> {
    let dir = cur_path(root, account_id, mailbox);
    let known = reg.known(account_id, mailbox, uid);
    if !overwrite && matches!(known, Some(Some(_))) {
        return Ok(false);
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Maildir directory: {}", e))?;

    let filename = build_maildir_filename(uid, flags);
    let new_path = dir.join(&filename);

    // One pass over the directory both answers "does uid already exist" and
    // collects every stale file the write below must clean up.
    let stale: Vec<PathBuf> = match known {
        Some(row) => row.into_iter().map(|name| dir.join(name)).collect(),
        None => fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| vault_filename_uid(&e.file_name().to_string_lossy()) == Some(uid))
            .map(|e| e.path())
            .collect(),
    };

    if !overwrite && !stale.is_empty() {
        return Ok(false);
    }

    write_atomic(&new_path, raw).map_err(|e| format!("Failed to write .eml file: {}", e))?;
    reg.upsert(account_id, mailbox, uid, &new_path);

    for old in stale {
        if old != new_path {
            match fs::remove_file(&old) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                // A second file for the uid is still there: let the next read relist.
                Err(_) => reg.invalidate(account_id, mailbox),
            }
        }
    }

    info!("Stored email UID {} to {:?} ({} bytes)", uid, new_path, raw.len());
    Ok(true)
}

/// `uid`'s file name and bytes, found through the registry: a verified
/// mailbox answers from its rows with no directory scan, and a stored name
/// that no longer opens relists the mailbox once (`with_resolved`).
/// `Ok(None)`: the verified mailbox does not hold `uid`. `Err`: the mailbox
/// could not be verified (unknown, never absent), or the file will not read.
pub fn read_resolved(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<(String, Vec<u8>)>, String> {
    match read_resolved_file(reg, root, account_id, mailbox, uid)? {
        Some((name, Ok(raw))) => Ok(Some((name, raw))),
        Some((_, Err(e))) => Err(format!("Failed to read .eml file: {}", e)),
        None => Ok(None),
    }
}

/// `read_resolved` with the file's own read error kept apart from the
/// folder's: `Err` only when the mailbox is unknown.
fn read_resolved_file(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<(String, std::io::Result<Vec<u8>>)>, String> {
    use std::io::ErrorKind;
    // Only NotFound goes back to `with_resolved` (it means "relist and
    // retry"); any other read error is the file's own and stays inside.
    let read = reg.with_resolved(root, account_id, mailbox, uid, |path| {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match fs::read(path) {
            Err(e) if e.kind() == ErrorKind::NotFound => Err(e),
            other => Ok((name, other)),
        }
    });
    match read {
        Ok(found) => Ok(Some(found)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// `read_resolved` for readers that answer a missing message with an error.
pub fn read_eml(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Vec<u8>, String> {
    read_resolved(reg, root, account_id, mailbox, uid)?
        .map(|(_, raw)| raw)
        .ok_or_else(|| format!("Email UID {} not found", uid))
}

/// `read_eml` as a reader renders it: an OpenPGP-encrypted message's
/// decrypted copy when there is one (`pgp::readable`). Every body, part and
/// attachment index comes from these bytes; only the raw source view and the
/// .eml export keep the original.
pub fn read_body_eml(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Vec<u8>, String> {
    let raw = read_eml(reg, root, account_id, mailbox, uid)?;
    Ok(crate::pgp::readable(&cur_path(root, account_id, mailbox), uid, raw))
}

pub fn read(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<ParsedEmail>, String> {
    let Some((name, raw)) = read_resolved(reg, root, account_id, mailbox, uid)? else { return Ok(None) };
    let raw = crate::pgp::readable(&cur_path(root, account_id, mailbox), uid, raw);
    parse_eml_bytes(&raw, uid, parse_flags_from_filename(&name)).map(Some)
}

pub fn read_light(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<LightEmail>, String> {
    let Some((name, raw)) = read_resolved(reg, root, account_id, mailbox, uid)? else { return Ok(None) };
    let raw = crate::pgp::readable(&cur_path(root, account_id, mailbox), uid, raw);
    parse_eml_bytes_light(&raw, uid, parse_flags_from_filename(&name)).map(Some)
}

/// One slot per requested uid, in request order: `None` when the vault does
/// not hold the uid (a verified miss), or its file will not read or parse as
/// mail (that file's failure, not the folder's). `Err` when the mailbox cannot
/// be verified or relisted: unknown, never a row of empty slots.
pub fn read_light_batch(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Result<Vec<Option<LightEmail>>, String> {
    let held: HashSet<u32> = reg
        .files(root, account_id, mailbox)
        .ok_or_else(|| "vault folder could not be listed or read".to_string())?
        .into_iter()
        .map(|(uid, _, _)| uid)
        .collect();
    uids.iter()
        .map(|&uid| {
            if !held.contains(&uid) {
                return Ok(None);
            }
            let Some((name, raw)) = read_resolved_file(reg, root, account_id, mailbox, uid)? else { return Ok(None) };
            let Ok(raw) = raw else { return Ok(None) };
            let raw = crate::pgp::readable(&cur_path(root, account_id, mailbox), uid, raw);
            Ok(parse_eml_bytes_light(&raw, uid, parse_flags_from_filename(&name)).ok())
        })
        .collect()
}

/// The folder listed once from disk, for callers that hold the vault gate
/// and so may not take the registry's per-mailbox lock (the lock order puts
/// it first): `mail_search`'s no-index scan.
pub fn read_light_batch_on_disk(root: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<Option<LightEmail>> {
    let cur_dir = cur_path(root, account_id, mailbox);
    let files = maildir::uid_file_map(&cur_dir);
    read_light_listed(&cur_dir, &files, uids)
}

/// `read_light_batch_on_disk` against a listing taken earlier. A uid the listing
/// lacks must never reach `read_light_at`: passing it a hint of `None` would
/// make it fall back to `find_file_by_uid`, one full directory rescan per
/// missing uid — exactly the quadratic cost the listing exists to remove.
fn read_light_listed(cur_dir: &Path, files: &HashMap<u32, PathBuf>, uids: &[u32]) -> Vec<Option<LightEmail>> {
    uids.iter()
        .map(|uid| read_light_at(cur_dir, *uid, Some(files.get(uid)?.as_path())))
        .collect()
}

pub fn read_attachment(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32, attachment_index: usize) -> Result<String, String> {
    use base64::Engine;
    let raw = read_body_eml(reg, root, account_id, mailbox, uid)?;
    let parsed = mailparse::parse_mail(&raw).map_err(|e| format!("Failed to parse email: {}", e))?;

    let mut attach_parts: Vec<&mailparse::ParsedMail> = Vec::new();
    collect_attachment_parts(&parsed, &mut attach_parts);

    let part = attach_parts.get(attachment_index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", attachment_index, attach_parts.len()))?;

    let body = part.get_body_raw().map_err(|e| format!("Failed to get attachment body: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&body))
}

/// `read_attachment` for several parts of one message: the file is found and
/// parsed once. One slot per requested index, in request order, `None` where
/// that one part could not be read (out of range, undecodable body); a
/// message that cannot be found, read or parsed is an `Err` for the call.
pub fn read_attachments(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32, indices: &[usize]) -> Result<Vec<Option<String>>, String> {
    use base64::Engine;
    let raw = read_body_eml(reg, root, account_id, mailbox, uid)?;
    let parsed = mailparse::parse_mail(&raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    Ok(indices.iter()
        .map(|i| parts.get(*i)?.get_body_raw().ok().map(|body| base64::engine::general_purpose::STANDARD.encode(body)))
        .collect())
}

pub fn read_raw_source(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<String, String> {
    use base64::Engine;
    let raw = read_eml(reg, root, account_id, mailbox, uid)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&raw))
}

/// One directory scan. Only for a writer already holding the mailbox's lock
/// (`scheduled`'s uid allocation), which may not verify; routes ask the
/// registry.
pub fn exists(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> bool {
    let cur_dir = cur_path(root, account_id, mailbox);
    find_by_uid(&cur_dir, uid).is_some()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MaildirEmailSummary {
    pub uid: u32,
    pub flags: Vec<String>,
    #[serde(rename = "isArchived")]
    pub is_archived: bool,
    pub size: u64,
}

fn summary(uid: u32, name: &str, size: u64, require_flag: Option<&str>) -> Option<MaildirEmailSummary> {
    let flags = parse_flags_from_filename(name);
    if let Some(required) = require_flag {
        if !flags.iter().any(|f| f == required) {
            return None;
        }
    }
    let is_archived = flags.iter().any(|f| f == "archived");
    Some(MaildirEmailSummary { uid, flags, is_archived, size })
}

/// The mailbox's messages from the registry, by uid: listed from disk once
/// per session. `Err` when the mailbox cannot be verified (unknown, never
/// empty); a missing `cur` is an empty folder.
pub fn list(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, require_flag: Option<&str>) -> Result<Vec<MaildirEmailSummary>, String> {
    let files = reg
        .files(root, account_id, mailbox)
        .ok_or_else(|| "Failed to read Maildir: vault folder could not be listed or read".to_string())?;
    Ok(files.iter().filter_map(|(uid, name, size)| summary(*uid, name, *size, require_flag)).collect())
}

/// `list` from one directory pass, for callers that hold the vault gate and
/// so may not take the registry's per-mailbox lock (`mail_search`'s scan).
pub fn list_on_disk(root: &Path, account_id: &str, mailbox: &str, require_flag: Option<&str>) -> Result<Vec<MaildirEmailSummary>, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    if !cur_dir.exists() {
        info!("maildir_list: cur_dir does not exist: {:?} (require_flag={:?})", cur_dir, require_flag);
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&cur_dir).map_err(|e| format!("Failed to read Maildir: {}", e))?;

    let mut results = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(uid) = vault_filename_uid(&name) else { continue };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        results.extend(summary(uid, &name, size, require_flag));
    }

    if require_flag.is_some() {
        info!("maildir_list: require_flag={:?}, found {} results", require_flag, results.len());
    }
    Ok(results)
}

/// Removes the vault file for `uid`, if there is one. Returns whether a file
/// was removed (the caller nudges the index only then).
/// The file for `uid` as a writer holding the mailbox's lock sees it: the
/// registry's row on a verified mailbox (no scan, and a verified miss is
/// absent), else one directory scan. A row whose file is gone invalidates the
/// mailbox and falls back to the scan. Never a verifying read: the caller
/// holds the lock a verify would take.
fn locate(reg: &VaultRegistry, cur_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> Option<PathBuf> {
    match reg.known(account_id, mailbox, uid) {
        Some(Some(name)) => {
            let path = cur_dir.join(name);
            if path.exists() {
                return Some(path);
            }
            reg.invalidate(account_id, mailbox);
            find_by_uid(cur_dir, uid)
        }
        Some(None) => None,
        None => find_by_uid(cur_dir, uid),
    }
}

pub fn delete(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<bool, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    if let Some(path) = locate(reg, &cur_dir, account_id, mailbox, uid) {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete .eml file: {}", e))?;
        crate::pgp::remove_copy(&cur_dir, uid);
        reg.remove(account_id, mailbox, &[uid]);
        info!("Deleted email UID {} from {:?}", uid, path);
        return Ok(true);
    }
    Ok(false)
}

/// Rename the vault file for `uid` onto the filename `flags` builds. Returns
/// whether a rename happened (the old and new names can already agree).
pub fn set_flags(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32, flags: &[String]) -> Result<bool, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    let old_path = match locate(reg, &cur_dir, account_id, mailbox, uid) {
        Some(p) => p,
        None => return Err(format!("E_UID_NOT_IN_MAILDIR: Email UID {} not found in Maildir", uid)),
    };

    let new_filename = build_maildir_filename(uid, flags);
    let new_path = cur_dir.join(&new_filename);

    if old_path != new_path {
        fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename file: {}", e))?;
        reg.rename(account_id, mailbox, uid, &new_filename);
        info!("Updated flags for UID {}: {:?} -> {:?}", uid, old_path.file_name(), new_path.file_name());
        return Ok(true);
    }
    Ok(false)
}

// ── Storage stats / clear cache / migrations ─────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct MaildirStorageStats {
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "totalMB")]
    pub total_mb: f64,
    #[serde(rename = "emailCount")]
    pub email_count: u32,
}

pub fn storage_stats(root: &Path, account_id: Option<&str>) -> MaildirStorageStats {
    let base = root.join("Maildir");
    let scan_dir = match account_id {
        Some(id) => base.join(id),
        None => base,
    };

    if !scan_dir.exists() {
        return MaildirStorageStats { total_bytes: 0, total_mb: 0.0, email_count: 0 };
    }

    let mut total_bytes: u64 = 0;
    let mut email_count: u32 = 0;

    for entry in walkdir::WalkDir::new(&scan_dir).into_iter().flatten() {
        if entry.file_type().is_file() {
            let name = entry.file_name().to_string_lossy();
            if crate::maildir::has_info(&name) {
                if let Ok(meta) = entry.metadata() {
                    total_bytes += meta.len();
                    email_count += 1;
                }
            }
        }
    }

    MaildirStorageStats {
        total_bytes,
        total_mb: total_bytes as f64 / (1024.0 * 1024.0),
        email_count,
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MaildirClearCacheResult {
    #[serde(rename = "deletedCount")]
    pub deleted_count: u32,
    #[serde(rename = "skippedArchived")]
    pub skipped_archived: u32,
}

/// Deletes every non-archived vault file. Skips `orphaned/` (messages the
/// current server does not have — this copy may be the only one). Any mailbox
/// may have lost files, so a walk that removed anything ends with one
/// `invalidate_all` (whose hook sweeps the index), on a refused gate too:
/// files already removed stay removed.
///
/// `gate` wraps each file's own delete, the same shape
/// `prefetch_attachments_in` uses: a vault-wide walk can cover thousands of
/// messages, so the daemon must never hold `vault_gate`'s read side for the
/// whole sweep, only for one file's removal at a time (Global constraint:
/// "per batch/mailbox for the long ones... never around a whole vault walk").
/// A gate error (vault closed for a move) stops the sweep where it is; files
/// already removed stay removed.
pub fn clear_cache(
    reg: &VaultRegistry,
    root: &Path,
    gate: VaultGate<'_>,
) -> Result<MaildirClearCacheResult, String> {
    let base = root.join("Maildir");
    if !base.exists() {
        return Ok(MaildirClearCacheResult { deleted_count: 0, skipped_archived: 0 });
    }

    let mut deleted_count: u32 = 0;
    let mut skipped_archived: u32 = 0;

    let walked = (|| -> Result<(), String> {
        for entry in walkdir::WalkDir::new(&base).into_iter().flatten() {
            if entry.path().components().any(|c| c.as_os_str() == maildir::ORPHAN_DIR) {
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !crate::maildir::has_info(&name) {
                continue;
            }
            let flags = parse_flags_from_filename(&name);
            if flags.iter().any(|f| f == "archived") {
                skipped_archived += 1;
                continue;
            }
            gate(&mut || {
                match fs::remove_file(entry.path()) {
                    Ok(()) => {
                        deleted_count += 1;
                        if let (Some(cur), Some(uid)) = (entry.path().parent(), vault_filename_uid(&name)) {
                            crate::pgp::remove_copy(cur, uid);
                        }
                    }
                    Err(e) => warn!("Failed to delete cached email {:?}: {}", entry.path(), e),
                }
                Ok(())
            })?;
        }
        Ok(())
    })();
    if deleted_count > 0 {
        reg.invalidate_all();
    }
    walked?;

    info!("Cleared email cache: deleted {} files, skipped {} archived", deleted_count, skipped_archived);
    Ok(MaildirClearCacheResult { deleted_count, skipped_archived })
}

/// One-time migration of pre-.eml JSON sidecars (`<uid>.json` with a
/// `rawSource` field) into `<uid>:2,AS.eml` files. Legacy-only path. A walk
/// that wrote any `.eml` ends with one `invalidate_all` (a refused gate too),
/// whose hook also sweeps the index: the "never nudges" gap of inventory §4
/// closes as a side effect.
///
/// `gate` wraps each file's write (or remove, for a sidecar with no
/// `rawSource`) — same reasoning as `clear_cache`: a whole-vault walk must not
/// hold the vault gate for its entire duration.
pub fn migrate_json_to_eml(
    reg: &VaultRegistry,
    root: &Path,
    gate: VaultGate<'_>,
) -> Result<String, String> {
    use base64::Engine;
    let base = root.join("Maildir");

    if !base.exists() {
        return Ok("No Maildir directory found, nothing to migrate.".to_string());
    }

    let mut migrated = 0u32;
    let mut skipped = 0u32;
    let mut errors = 0u32;

    let walked = (|| -> Result<(), String> {
        for entry in walkdir::WalkDir::new(&base).into_iter().flatten() {
            if !entry.file_type().is_file() { continue; }
            let path = entry.path().to_path_buf();
            let ext = path.extension().and_then(|e| e.to_str());
            if ext != Some("json") { continue; }

            let json_str = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    warn!("Could not read {:?}: {}", path, e);
                    errors += 1;
                    continue;
                }
            };

            let json_val: serde_json::Value = match serde_json::from_str(&json_str) {
                Ok(v) => v,
                Err(e) => {
                    warn!("Could not parse JSON {:?}: {}", path, e);
                    errors += 1;
                    continue;
                }
            };

            let uid: u32 = match path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse().ok()) {
                Some(u) => u,
                None => {
                    warn!("Could not extract UID from {:?}", path);
                    errors += 1;
                    continue;
                }
            };

            if let Some(raw_b64) = json_val.get("rawSource").and_then(|v| v.as_str()) {
                let raw_bytes = match base64::engine::general_purpose::STANDARD.decode(raw_b64) {
                    Ok(b) => b,
                    Err(e) => {
                        warn!("Could not decode rawSource for {:?}: {}", path, e);
                        errors += 1;
                        continue;
                    }
                };

                let cur_dir = match path.parent() {
                    Some(d) => d,
                    None => {
                        warn!("migrate_json_to_eml: path {:?} has no parent dir", path);
                        errors += 1;
                        continue;
                    }
                };
                let eml_filename = build_maildir_filename(uid, &["archived".to_string(), "seen".to_string()]);
                let eml_path = cur_dir.join(&eml_filename);

                gate(&mut || {
                    match write_atomic(&eml_path, &raw_bytes) {
                        Ok(_) => {
                            let _ = fs::remove_file(&path);
                            migrated += 1;
                            info!("Migrated {:?} -> {:?}", path, eml_path);
                        }
                        Err(e) => {
                            warn!("Failed to write .eml for {:?}: {}", path, e);
                            errors += 1;
                        }
                    }
                    Ok(())
                })?;
            } else {
                gate(&mut || {
                    warn!("No rawSource in {:?}, cannot migrate to .eml — removing", path);
                    let _ = fs::remove_file(&path);
                    skipped += 1;
                    Ok(())
                })?;
            }
        }
        Ok(())
    })();
    if migrated > 0 {
        reg.invalidate_all();
    }
    walked?;

    let result = format!(
        "Migration complete. Migrated: {}, Skipped (no rawSource): {}, Errors: {}",
        migrated, skipped, errors
    );
    info!("{}", result);
    Ok(result)
}

/// Moves account-email-keyed mailbox dirs onto their account-uuid dir.
/// Returns the number of files moved. Every existing source account dir is
/// deleted at the end even when a file was skipped (its destination existed),
/// so any source seen at all ends the walk with one `invalidate_all` (a
/// refused gate too), whose hook sweeps the index.
///
/// `gate` wraps one mailbox's whole move (create dest, rename every file in
/// it) at a time, and separately wraps the final `remove_dir_all` per
/// account — "per batch/mailbox for the long ones", never one gate call
/// around the whole migration.
pub fn migrate_email_dirs(
    reg: &VaultRegistry,
    root: &Path,
    account_map: &HashMap<String, String>,
    gate: VaultGate<'_>,
) -> Result<usize, String> {
    let maildir_base = root.join("Maildir");
    if !maildir_base.exists() {
        return Ok(0);
    }

    let mut migrated = 0usize;
    let mut touched = false;

    let walked = (|| -> Result<(), String> {
        for (email, uuid) in account_map {
            let email_dir = maildir_base.join(email);
            let uuid_dir = maildir_base.join(uuid);

            if !email_dir.exists() || email_dir == uuid_dir {
                continue;
            }
            touched = true;

            if let Ok(mailbox_entries) = fs::read_dir(&email_dir) {
                for mb_entry in mailbox_entries.flatten() {
                    if !mb_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }
                    let mb_name = mb_entry.file_name();
                    let src_cur = mb_entry.path().join("cur");
                    if !src_cur.exists() { continue; }

                    let dst_cur = uuid_dir.join(&mb_name).join("cur");
                    gate(&mut || {
                        if let Err(e) = fs::create_dir_all(&dst_cur) {
                            warn!("Migration: failed to create {:?}: {}", dst_cur, e);
                            return Ok(());
                        }
                        if let Ok(files) = fs::read_dir(&src_cur) {
                            for file in files.flatten() {
                                let fname = file.file_name();
                                let dst_path = dst_cur.join(&fname);
                                if !dst_path.exists() {
                                    if let Err(e) = fs::rename(file.path(), &dst_path) {
                                        warn!("Migration: failed to move {:?}: {}", fname, e);
                                    } else {
                                        migrated += 1;
                                    }
                                }
                            }
                        }
                        Ok(())
                    })?;
                }
            }

            gate(&mut || {
                let _ = fs::remove_dir_all(&email_dir);
                Ok(())
            })?;
        }
        Ok(())
    })();
    if touched {
        reg.invalidate_all();
    }
    walked?;

    info!("Maildir migration: moved {} files from email-address dirs to UUID dirs", migrated);
    Ok(migrated)
}

// ── Attachment cache ──────────────────────────────────────────────────────────
// One file per (account, mailbox, uid, part) under <root>/attachment_cache,
// named so a click, the prefetch and the "already downloaded" check all land
// on the same path without a registry.

pub fn fs_safe(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// The one component of a sender-supplied filename that may name a file.
///
/// A MIME `filename` is attacker-controlled: `../../x` or an absolute path
/// would escape the directory it is being written into. Only the last
/// component survives, and a component that names a directory instead of a
/// file (empty, `.`, `..`) falls back.
pub fn safe_leaf(filename: &str) -> String {
    let leaf = Path::new(filename)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .filter(|f| !f.is_empty() && f != "." && f != "..")
        .unwrap_or_else(|| "attachment".to_string());
    // Unix keeps its names byte for byte: cached attachments are found again
    // by this name, so changing it there would orphan every cached file.
    #[cfg(windows)]
    let leaf = win32_safe(&leaf);
    leaf
}

/// `: < > " | ? *` and control characters become `_`. Win32 rejects them in
/// a file name, except `:`, which is worse: `a.pdf:x.exe` addresses an NTFS
/// alternate data stream of `a.pdf`, where no Mark-of-the-Web can follow.
/// `Re: invoice.pdf` is a real name this makes writable. Then reserved device
/// names and a trailing dot or space go through `avoid_reserved`, the rule
/// vault directories use: `CON.txt` -> `CON_.txt`.
///
/// Platform-independent so it is tested everywhere; only called on Windows.
/// Mirrored by `safeLeaf` in src/services/attachmentUtils.js.
pub fn win32_safe(leaf: &str) -> String {
    let chars: String = leaf.chars()
        .map(|c| if matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    crate::search_index::text::avoid_reserved(&chars)
}

pub fn attachment_cache_path(cache_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize, filename: &str) -> PathBuf {
    let leaf = safe_leaf(filename);
    cache_dir.join(format!("{}_{}_{}_{}_{}", fs_safe(account_id), fs_safe(mailbox), uid, index, leaf))
}

fn write_part_to_cache(cache_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize, part: &mailparse::ParsedMail) -> Result<PathBuf, String> {
    let dest = attachment_cache_path(cache_dir, account_id, mailbox, uid, index, &part_filename(part));
    if dest.exists() {
        return Ok(dest);
    }
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create attachment cache dir: {}", e))?;
    let body = part.get_body_raw().map_err(|e| format!("Failed to get attachment body: {}", e))?;
    write_atomic(&dest, &body).map_err(|e| format!("Failed to write file: {}", e))?;
    mark_from_internet(&dest);
    Ok(dest)
}

/// Write one attachment part of `raw` (the message's bytes) to the cache (a
/// no-op when it is there already) and return its path.
fn cache_attachment_in(cache_dir: &Path, raw: &[u8], account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<PathBuf, String> {
    let parsed = mailparse::parse_mail(raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let part = parts.get(index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", index, parts.len()))?;
    write_part_to_cache(cache_dir, account_id, mailbox, uid, index, part)
}

/// The cached path of one attachment part, if the file exists.
// ponytail: parses the .eml for the part's filename on every mount check;
// pass the name from the viewer if that ever shows up in a profile.
fn cached_attachment_in(cache_dir: &Path, raw: &[u8], account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<Option<PathBuf>, String> {
    let parsed = mailparse::parse_mail(raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let part = parts.get(index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", index, parts.len()))?;
    let dest = attachment_cache_path(cache_dir, account_id, mailbox, uid, index, &part_filename(part));
    Ok(dest.exists().then_some(dest))
}

/// Write one attachment part to the cache and return its absolute path.
/// `raw` is the message, read by the caller (`read_eml`) before it takes the
/// vault gate: the lock order puts the registry's mailbox lock first.
pub fn cache_attachment(root: &Path, raw: &[u8], account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<String, String> {
    let cache_dir = root.join("attachment_cache");
    let path = cache_attachment_in(&cache_dir, raw, account_id, mailbox, uid, index)?;
    Ok(path.to_string_lossy().to_string())
}

/// The cached path of one attachment part, if the file exists.
pub fn cached_attachment_path(reg: &VaultRegistry, root: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<Option<String>, String> {
    let cache_dir = root.join("attachment_cache");
    let raw = read_body_eml(reg, root, account_id, mailbox, uid)?;
    Ok(cached_attachment_in(&cache_dir, &raw, account_id, mailbox, uid, index)?
        .map(|p| p.to_string_lossy().to_string()))
}

/// What `export_attachments` wrote: the folder it created, and the file names
/// inside it (already de-duplicated, so they are what is on disk).
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedAttachments {
    pub dir: String,
    pub files: Vec<String>,
}

/// The first free name at `path`, adding ` (1)`, ` (2)`, ... before the
/// extension — the same rule a browser download uses. Nothing here overwrites
/// anything: an unrelated `invoice.pdf` in the export folder is not ours to
/// destroy, and two `image.png` on one forwarded message are both wanted.
fn next_free(path: &Path) -> PathBuf {
    // `symlink_metadata`, not `exists`: a DANGLING symlink at this name reads
    // as "does not exist", and then `create_dir_all`/`write_atomic` fails on
    // it and takes the whole export down instead of stepping to `(1)`.
    let taken = |p: &Path| fs::symlink_metadata(p).is_ok();
    if !taken(path) {
        return path.to_path_buf();
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    // `.gitignore` is a name, not an extension: a leading dot never splits.
    let dot = name.rfind('.').filter(|&i| i > 0);
    let (base, ext) = match dot {
        Some(i) => (&name[..i], &name[i..]),
        None => (name.as_str(), ""),
    };
    // ponytail: a linear probe, capped — the same shape as the Downloads
    // probe in the viewer, and the cap keeps a pathological folder finite.
    for n in 1..1000 {
        let candidate = path.with_file_name(format!("{} ({}){}", base, n, ext));
        if !taken(&candidate) {
            return candidate;
        }
    }
    path.with_file_name(format!("{} ({}){}", base, std::process::id(), ext))
}

/// Write a message's attachments into a folder of their own.
///
/// `indices` are positions in `collect_attachment_parts` order — the same
/// index `read_attachment` and `cache_attachment` take, which is what the
/// viewer's `_originalIndex` carries — so the export holds exactly the files
/// the viewer listed, never the inline images it filtered out.
///
/// `dest_dir` is where the app wants the folder; an existing folder of that
/// name is never written into, a `(n)` sibling is created instead, so two
/// exports of two messages never merge.
pub fn export_attachments(
    reg: &VaultRegistry,
    root: &Path,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    indices: &[usize],
    dest_dir: &Path,
) -> Result<ExportedAttachments, String> {
    if indices.is_empty() {
        return Err("No attachments to export".to_string());
    }
    let raw = read_body_eml(reg, root, account_id, mailbox, uid)?;
    export_attachments_in(&raw, uid, indices, dest_dir)
}

fn export_attachments_in(
    raw: &[u8],
    uid: u32,
    indices: &[usize],
    dest_dir: &Path,
) -> Result<ExportedAttachments, String> {
    if indices.is_empty() {
        return Err("No attachments to export".to_string());
    }
    let parsed = mailparse::parse_mail(raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);

    let dir = next_free(dest_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create export folder: {}", e))?;

    let mut files = Vec::new();
    for &index in indices {
        let part = parts.get(index)
            .ok_or_else(|| format!("Attachment index {} out of range (total: {})", index, parts.len()))?;
        let body = part.get_body_raw().map_err(|e| format!("Failed to read attachment body: {}", e))?;
        let dest = next_free(&dir.join(safe_leaf(&part_filename(part))));
        write_atomic(&dest, &body).map_err(|e| format!("Failed to write {}: {}", dest.display(), e))?;
        mark_from_internet(&dest);
        files.push(dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    }

    info!("Exported {} attachment(s) of uid {} to {}", files.len(), uid, dir.display());
    Ok(ExportedAttachments { dir: dir.to_string_lossy().to_string(), files })
}

/// What a bulk export wrote: the folder, how many files landed in it, and how
/// many messages could not be read (not in the vault, or unparseable).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkExport {
    pub dir: String,
    pub files: usize,
    pub skipped: usize,
}

/// Every real attachment of many messages — `(account, mailbox, uid)` — flat
/// in one new folder. "Real" is the viewer's rule (`is_real_attachment`): the
/// signature logos and tracking pixels it hides are not downloaded either.
/// One unreadable message is counted and skipped, never the whole export.
pub fn export_many_attachments(
    reg: &VaultRegistry,
    root: &Path,
    messages: &[(String, String, u32)],
    dest_dir: &Path,
) -> Result<BulkExport, String> {
    let dir = next_free(dest_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create export folder: {}", e))?;
    let (mut files, mut skipped) = (0, 0);
    for (account_id, mailbox, uid) in messages {
        match read_body_eml(reg, root, account_id, mailbox, *uid).and_then(|raw| write_real_attachments(&raw, &dir)) {
            Ok(written) => files += written,
            Err(e) => {
                warn!("Bulk export skipped uid {} in {}: {}", uid, mailbox, e);
                skipped += 1;
            }
        }
    }
    // An empty folder in Downloads says nothing the reply does not.
    if files == 0 {
        let _ = fs::remove_dir(&dir);
    }
    info!("Bulk-exported {} attachment(s) from {} message(s) to {}", files, messages.len(), dir.display());
    Ok(BulkExport { dir: dir.to_string_lossy().to_string(), files, skipped })
}

fn write_real_attachments(raw: &[u8], dir: &Path) -> Result<usize, String> {
    let parsed = mailparse::parse_mail(raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let (mut text, mut html, mut metas) = (None, None, Vec::new());
    walk_mime_parts_light(&parsed, &mut text, &mut html, &mut metas);
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let mut written = 0;
    for (part, meta) in parts.iter().zip(&metas) {
        if !is_real_attachment(&meta.content_type, &meta.content_id, &meta.filename, meta.size, html.as_deref()) {
            continue;
        }
        let body = part.get_body_raw().map_err(|e| format!("Failed to read attachment body: {}", e))?;
        let dest = next_free(&dir.join(safe_leaf(&part_filename(part))));
        write_atomic(&dest, &body).map_err(|e| format!("Failed to write {}: {}", dest.display(), e))?;
        mark_from_internet(&dest);
        written += 1;
    }
    Ok(written)
}

/// Sweep a mailbox's cached .eml files newest-first (uid order) and write
/// every real attachment above `above_uid` to the cache. Returns the paths it
/// wrote, in sweep order, and the highest uid it saw.
///
/// `gate` runs the given file's *entire* read+parse+write inside itself: the
/// daemon passes a closure wrapping `handlers::common::with_vault_write`
/// (Task 2.6 fix round 1, I1) around `work`, so a fresh `vault_gate`
/// read-side guard is held for exactly this one file's disk work, not the
/// whole sweep — a mailbox can hold thousands of messages, and
/// `vault_close`'s writer-drain (`with_vault_write`'s write-side barrier)
/// must not be blocked out for the full sweep's duration. Passing the work
/// *into* the gate (rather than checking the gate and then doing the work
/// unguarded) closes the check-then-act window a bare pre-check would leave:
/// `vault_close` can only observe this file's write as complete or not yet
/// started, never half-written. A `gate` error (vault closed for a move
/// mid-sweep) stops the sweep before that file's work runs; whatever was
/// already written by earlier files stays (already-cached files are still
/// valid).
fn prefetch_attachments_in(
    cache_dir: &Path,
    cur_dir: &Path,
    account_id: &str,
    mailbox: &str,
    above_uid: u32,
    gate: VaultGate<'_>,
) -> Result<(Vec<PathBuf>, u32), String> {
    let entries = fs::read_dir(cur_dir).map_err(|e| format!("Failed to read Maildir: {}", e))?;
    let mut files: Vec<(u32, PathBuf)> = entries.flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let uid = vault_filename_uid(&name)?;
            Some((uid, entry.path()))
        })
        .collect();
    files.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let max_uid = files.first().map(|f| f.0).unwrap_or(0);

    let mut written = Vec::new();
    for (uid, path) in files {
        if uid <= above_uid { break; }
        gate(&mut || {
            let Ok(raw) = fs::read(&path) else { return Ok(()) };
            let raw = crate::pgp::readable(cur_dir, uid, raw);
            // A message with no Content-Disposition header has no attachment part.
            if !raw.windows(19).any(|w| w.eq_ignore_ascii_case(b"content-disposition")) { return Ok(()); }
            let Ok(parsed) = mailparse::parse_mail(&raw) else { return Ok(()) };
            let (mut text, mut html, mut metas) = (None, None, Vec::new());
            walk_mime_parts_light(&parsed, &mut text, &mut html, &mut metas);
            let mut parts = Vec::new();
            collect_attachment_parts(&parsed, &mut parts);
            for (index, (part, meta)) in parts.iter().zip(&metas).enumerate() {
                if !is_real_attachment(&meta.content_type, &meta.content_id, &meta.filename, meta.size, html.as_deref()) { continue; }
                if attachment_cache_path(cache_dir, account_id, mailbox, uid, index, &part_filename(part)).exists() { continue; }
                match write_part_to_cache(cache_dir, account_id, mailbox, uid, index, part) {
                    Ok(dest) => written.push(dest),
                    Err(e) => warn!("Attachment prefetch skipped uid {} part {}: {}", uid, index, e),
                }
            }
            Ok(())
        })?;
    }
    Ok((written, max_uid))
}

/// One sweep at a time is the caller's job (a lock around this call); the
/// high-water mark is passed in so the caller (the daemon, Task 2.6) owns
/// its own — it resets whenever the process holding it restarts.
///
/// `gate`: see `prefetch_attachments_in` — wraps one file's work at a time,
/// never the whole sweep.
pub fn prefetch_attachments(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    high_water: &std::sync::Mutex<Vec<(String, u32)>>,
    gate: VaultGate<'_>,
) -> Result<usize, String> {
    let cache_dir = root.join("attachment_cache");
    let cur_dir = cur_path(root, account_id, mailbox);
    let key = format!("{}/{}", account_id, mailbox);
    let above = high_water.lock().unwrap_or_else(|p| p.into_inner())
        .iter().find(|(k, _)| *k == key).map(|(_, uid)| *uid).unwrap_or(0);
    let (written, max_uid) = prefetch_attachments_in(&cache_dir, &cur_dir, account_id, mailbox, above, gate)?;
    let mut marks = high_water.lock().unwrap_or_else(|p| p.into_inner());
    match marks.iter_mut().find(|(k, _)| *k == key) {
        Some(entry) => entry.1 = max_uid,
        None => marks.push((key, max_uid)),
    }
    info!("Attachment prefetch {}/{}: {} written above uid {}", account_id, mailbox, written.len(), above);
    Ok(written.len())
}

/// Every `Maildir/{account}/{mailbox}` directory, scoped to one account when
/// asked. Two levels, not a full walk — the vault below these is large.
pub fn orphan_mailbox_dirs(base: &Path, account_id: Option<&str>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let accounts: Vec<PathBuf> = match account_id {
        Some(id) => vec![base.join(id)],
        None => fs::read_dir(base)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect(),
    };
    for account_dir in accounts {
        if let Ok(entries) = fs::read_dir(&account_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    dirs.push(entry.path());
                }
            }
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;

    /// A registry of its own per test, in a tempdir beside the vault.
    fn registry(root: &Path) -> (tempfile::TempDir, VaultRegistry) {
        let app = tempfile::tempdir().unwrap();
        let reg = VaultRegistry::open(app.path(), root);
        (app, reg)
    }

    #[test]
    fn a_vault_file_name_round_trips_through_the_builder() {
        assert_eq!(
            build_maildir_filename(12, &parse_flags_from_filename(&format!("12{INFO_PREFIX}AS.eml"))),
            format!("12{INFO_PREFIX}AS.eml")
        );
    }

    #[test]
    fn win32_safe_leaves_no_stream_or_invalid_character() {
        assert_eq!(win32_safe("a.pdf:x.exe"), "a.pdf_x.exe");
        assert_eq!(win32_safe("Re: invoice.pdf"), "Re_ invoice.pdf");
        assert_eq!(win32_safe("<a>|\"b\"?*\u{1}.txt"), "_a___b____.txt");
        assert_eq!(win32_safe("Rechnung März.pdf"), "Rechnung März.pdf");
        assert_eq!(win32_safe("CON.txt"), "CON_.txt");
        assert_eq!(win32_safe("invoice.pdf."), "invoice.pdf._");
    }

    #[test]
    fn a_built_name_round_trips_through_the_readers() {
        let name = build_maildir_filename(12, &["seen".into(), "archived".into()]);
        assert!(name.starts_with("12"), "{name}");
        assert!(name.ends_with("2,AS.eml"), "{name}");
        assert_eq!(crate::maildir::vault_filename_uid(&name), Some(12));
        // parse_flags_from_filename also appends the IMAP alias for `seen`
        // (`\Seen`) — pre-existing behavior this task's separator refactor
        // does not touch; see the brief-defect note in the task report.
        assert_eq!(
            parse_flags_from_filename(&name),
            vec!["archived".to_string(), "seen".to_string(), "\\Seen".to_string()]
        );
    }

    #[test]
    fn flags_parse_under_both_separators() {
        let expected = vec!["archived".to_string(), "seen".to_string(), "\\Seen".to_string()];
        assert_eq!(parse_flags_from_filename("12:2,AS.eml"), expected);
        assert_eq!(parse_flags_from_filename("12;2,AS.eml"), expected);
    }

    #[test]
    fn deletes_only_requested_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let (_app, reg) = registry(tmp.path());
        let cur = &cur_path(tmp.path(), "acct", "INBOX");
        fs::create_dir_all(cur).unwrap();
        fs::write(cur.join(format!("101{INFO_PREFIX}S")), b"x").unwrap();
        fs::write(cur.join(format!("102{INFO_PREFIX}")), b"x").unwrap();
        fs::write(cur.join(format!("103{INFO_PREFIX}S")), b"x").unwrap();
        // A uid that is a prefix of another must not be swept up.
        fs::write(cur.join(format!("1010{INFO_PREFIX}S")), b"x").unwrap();

        let mut uids = HashSet::new();
        uids.insert(101u32);
        uids.insert(103u32);

        let removed = delete_maildir_files(&reg, tmp.path(), "acct", "INBOX", &uids);

        assert_eq!(removed, 2);
        assert!(!cur.join(format!("101{INFO_PREFIX}S")).exists());
        assert!(!cur.join(format!("103{INFO_PREFIX}S")).exists());
        assert!(cur.join(format!("102{INFO_PREFIX}")).exists());
        assert!(cur.join(format!("1010{INFO_PREFIX}S")).exists(), "1010 must survive a purge of 101");
    }

    #[test]
    fn store_writes_atomically_then_removes_the_old_differently_named_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        assert!(store(&reg, root, "acct", "INBOX", 7, b"one", &["seen".to_string()], true).unwrap());
        let cur = cur_path(root, "acct", "INBOX");
        assert!(cur.join(format!("7{INFO_PREFIX}S.eml")).exists());

        // Overwrite with new flags: exactly one file survives.
        assert!(store(&reg, root, "acct", "INBOX", 7, b"two", &["flagged".to_string(), "seen".to_string()], true).unwrap());
        let names: Vec<String> = fs::read_dir(&cur).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec![format!("7{INFO_PREFIX}FS.eml")]);
        assert_eq!(fs::read(cur.join(format!("7{INFO_PREFIX}FS.eml"))).unwrap(), b"two");

        // Storing the same flags again (same target filename) still leaves
        // exactly one file, holding the latest content.
        assert!(store(&reg, root, "acct", "INBOX", 7, b"three", &["flagged".to_string(), "seen".to_string()], true).unwrap());
        let names: Vec<String> = fs::read_dir(&cur).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec![format!("7{INFO_PREFIX}FS.eml")]);
        assert_eq!(fs::read(cur.join(format!("7{INFO_PREFIX}FS.eml"))).unwrap(), b"three");
    }

    #[test]
    fn store_removes_every_stale_file_for_the_uid_not_just_the_first() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        // Two files left behind for uid 7 by an earlier interrupted store.
        fs::write(cur.join(format!("7{INFO_PREFIX}S.eml")), b"old-a").unwrap();
        fs::write(cur.join(format!("7{INFO_PREFIX}AS.eml")), b"old-b").unwrap();

        assert!(store(&reg, root, "acct", "INBOX", 7, b"new", &["flagged".to_string()], true).unwrap());

        let names: Vec<String> = fs::read_dir(&cur).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec![format!("7{INFO_PREFIX}F.eml")], "both stale files must be swept, not just one");
        assert_eq!(fs::read(cur.join(format!("7{INFO_PREFIX}F.eml"))).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn store_into_a_read_only_dir_fails_and_keeps_the_old_file() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        assert!(store(&reg, root, "acct", "INBOX", 7, b"one", &["seen".to_string()], true).unwrap());
        let cur = cur_path(root, "acct", "INBOX");

        let writable = fs::metadata(&cur).unwrap().permissions();
        let mut readonly = writable.clone();
        readonly.set_mode(0o555);
        fs::set_permissions(&cur, readonly).unwrap();

        let result = store(&reg, root, "acct", "INBOX", 7, b"two", &["flagged".to_string(), "seen".to_string()], true);

        // Restore before any assertion can short-circuit, so tempdir cleanup
        // (which needs to delete files inside `cur`) never fails.
        fs::set_permissions(&cur, writable).unwrap();

        if result.is_ok() {
            return; // running as root: permissions aren't enforced, nothing to prove
        }
        assert!(result.is_err());
        assert_eq!(fs::read(cur.join(format!("7{INFO_PREFIX}S.eml"))).unwrap(), b"one", "the old file must survive a failed write");
    }

    #[test]
    fn list_and_delete_ignore_non_canonical_uid_prefixes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("07{INFO_PREFIX}S.eml")), b"x").unwrap();
        fs::write(cur.join(format!("+7{INFO_PREFIX}S.eml")), b"x").unwrap();
        fs::write(cur.join(format!("7{INFO_PREFIX}S.eml")), b"x").unwrap();

        let (_app, reg) = registry(root);
        let listed = list(&reg, root, "acct", "INBOX", None).unwrap();
        assert_eq!(listed.len(), 1, "only the canonical name is a vault row");
        assert_eq!(listed[0].uid, 7);
        let on_disk = list_on_disk(root, "acct", "INBOX", None).unwrap();
        assert_eq!(on_disk.len(), 1, "only the canonical name is a vault row");

        let mut uids = HashSet::new();
        uids.insert(7u32);
        let removed = delete_maildir_files(&reg, root, "acct", "INBOX", &uids);
        assert_eq!(removed, 1);
        assert!(!cur.join(format!("7{INFO_PREFIX}S.eml")).exists());
        assert!(cur.join(format!("07{INFO_PREFIX}S.eml")).exists(), "leading zero must not be swept as uid 7");
        assert!(cur.join(format!("+7{INFO_PREFIX}S.eml")).exists(), "leading + must not be swept as uid 7");
    }

    #[test]
    fn store_without_overwrite_skips_an_existing_uid() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        assert!(store(&reg, root, "acct", "INBOX", 7, b"one", &[], false).unwrap());
        assert!(!store(&reg, root, "acct", "INBOX", 7, b"two", &[], false).unwrap(), "must skip, not overwrite");
        let cur = cur_path(root, "acct", "INBOX");
        assert_eq!(fs::read(find_by_uid(&cur, 7).unwrap()).unwrap(), b"one");
    }

    // -- the writers keep the vault registry current --

    fn sets(reg: &VaultRegistry, root: &Path) -> (Vec<u32>, Vec<u32>) {
        reg.uid_sets(root, "acct", "INBOX").unwrap()
    }

    #[test]
    fn a_store_on_a_verified_mailbox_answers_from_the_registry_not_a_sweep() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        assert!(store(&reg, root, "acct", "INBOX", 1, b"one", &[], false).unwrap());
        assert_eq!(sets(&reg, root), (vec![1], vec![]));
        assert_eq!(reg.listing_count(), 1);

        // Planted behind the registry's back. A sweep would find it and skip;
        // on a verified mailbox the miss is authoritative and the store writes.
        let cur = cur_path(root, "acct", "INBOX");
        fs::write(cur.join(format!("5{INFO_PREFIX}S.eml")), b"planted").unwrap();
        assert!(store(&reg, root, "acct", "INBOX", 5, b"five", &[], false).unwrap(), "no directory sweep on a verified mailbox");
        assert!(!store(&reg, root, "acct", "INBOX", 1, b"again", &[], false).unwrap(), "a live row skips with no fs access");
        assert_eq!(fs::read(cur.join(format!("1{INFO_PREFIX}.eml"))).unwrap(), b"one");

        // Overwrite under new flags: the row's old name goes, the row follows.
        assert!(store(&reg, root, "acct", "INBOX", 1, b"two", &["archived".to_string()], true).unwrap());
        assert!(!cur.join(format!("1{INFO_PREFIX}.eml")).exists());
        assert_eq!(fs::read(cur.join(format!("1{INFO_PREFIX}A.eml"))).unwrap(), b"two");

        assert_eq!(sets(&reg, root), (vec![1, 5], vec![1]));
        assert_eq!(reg.listing_count(), 1, "every answer came from the registry");
    }

    #[test]
    fn set_flags_and_delete_keep_a_verified_mailbox_current() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        assert!(store(&reg, root, "acct", "INBOX", 7, b"seven", &[], true).unwrap());
        assert_eq!(sets(&reg, root), (vec![7], vec![]));

        assert!(set_flags(&reg, root, "acct", "INBOX", 7, &["archived".to_string(), "seen".to_string()]).unwrap());
        assert_eq!(sets(&reg, root), (vec![7], vec![7]));
        assert_eq!(reg.resolve(root, "acct", "INBOX", 7), Some(Some(cur_path(root, "acct", "INBOX").join(format!("7{INFO_PREFIX}AS.eml")))));

        assert!(delete(&reg, root, "acct", "INBOX", 7).unwrap());
        assert_eq!(sets(&reg, root), (vec![], vec![]));
        assert_eq!(reg.listing_count(), 1);
    }

    #[test]
    fn delete_maildir_files_drops_only_the_removed_uids_from_a_verified_mailbox() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        for uid in [1, 2, 3] {
            assert!(store(&reg, root, "acct", "INBOX", uid, b"x", &[], true).unwrap());
        }
        assert_eq!(sets(&reg, root).0, vec![1, 2, 3]);

        let uids: HashSet<u32> = [1, 3, 99].into_iter().collect();
        assert_eq!(delete_maildir_files(&reg, root, "acct", "INBOX", &uids), 2);
        assert_eq!(sets(&reg, root).0, vec![2]);
        assert_eq!(reg.listing_count(), 1);
    }

    // -- read_light_batch (moved from src-tauri/src/light_batch_tests.rs) --

    #[test]
    fn a_uid_missing_from_the_listing_is_never_looked_up_again() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();

        // The listing is taken before this file exists.
        let files = maildir::uid_file_map(&cur);
        fs::write(cur.join(format!("7{INFO_PREFIX}S.eml")), light_batch_eml("seven")).unwrap();

        let out = read_light_listed(&cur, &files, &[7]);
        assert!(
            out[0].is_none(),
            "a uid absent from the listing must not be looked up again, even though a file for it exists now"
        );
    }

    fn light_batch_eml(subject: &str) -> Vec<u8> {
        format!("From: A <a@x.test>\r\nTo: b@x.test\r\nSubject: {subject}\r\nMessage-ID: <{subject}@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nbody of {subject}\r\n").into_bytes()
    }

    #[test]
    fn batch_keeps_one_slot_per_requested_uid_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("5{INFO_PREFIX}S.eml")), light_batch_eml("five")).unwrap();
        fs::write(cur.join(format!("9{INFO_PREFIX}AF.eml")), light_batch_eml("nine")).unwrap();
        fs::write(cur.join("12.eml"), light_batch_eml("legacy")).unwrap(); // no colon: not a vault row
        fs::write(cur.join(format!("14{INFO_PREFIX}.eml")), b"\xff\xfe not mime at all").unwrap();

        let (_app, reg) = registry(root);
        let out = read_light_batch(&reg, root, "acct", "INBOX", &[9, 404, 5, 12, 14]).unwrap();
        let on_disk = read_light_batch_on_disk(root, "acct", "INBOX", &[9, 404, 5, 12, 14]);
        assert_eq!(serde_json::to_value(&out).unwrap(), serde_json::to_value(&on_disk).unwrap());
        assert_eq!(out.len(), 5);
        let nine = out[0].as_ref().expect("uid 9");
        assert_eq!(nine.uid, 9);
        assert_eq!(nine.subject, "nine");
        assert!(nine.flags.iter().any(|f| f == "archived"));
        assert!(nine.flags.iter().any(|f| f == "\\Flagged"));
        assert!(out[1].is_none(), "missing uid");
        assert_eq!(out[2].as_ref().expect("uid 5").text.as_deref().map(str::trim), Some("body of five"));
        assert!(out[3].is_none(), "legacy name without colon stays invisible, as before");
    }

    /// A held file that will not read is that file's empty slot, not the
    /// folder's failure; the rest of the batch still answers.
    #[cfg(unix)]
    #[test]
    fn a_held_file_that_will_not_read_empties_only_its_own_slot() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("5{INFO_PREFIX}S.eml")), light_batch_eml("five")).unwrap();
        let locked = cur.join(format!("7{INFO_PREFIX}S.eml"));
        fs::write(&locked, light_batch_eml("seven")).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let (_app, reg) = registry(root);
        let out = read_light_batch(&reg, root, "acct", "INBOX", &[5, 7, 9]);
        let as_root = fs::read(&locked).is_ok();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        if as_root {
            return; // permissions aren't enforced, nothing to prove
        }
        let out = out.expect("one unreadable file does not fail the batch");
        assert!(out[0].is_some() && out[1].is_none() && out[2].is_none());
        let out = read_light_batch(&reg, root, "acct", "INBOX", &[5, 7, 9]).unwrap();
        assert!(out[0].is_some() && out[1].is_some());
        assert!(out[2].is_none(), "a verified miss is an empty slot");
    }

    #[test]
    fn batch_matches_the_per_uid_lookup_it_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        for uid in 1..=40u32 {
            fs::write(cur.join(format!("{uid}{INFO_PREFIX}S.eml")), light_batch_eml(&format!("m{uid}"))).unwrap();
        }
        let uids: Vec<u32> = (0..=41).rev().collect();
        let (_app, reg) = registry(root);
        let batch = read_light_batch(&reg, root, "acct", "INBOX", &uids).unwrap();
        for (i, uid) in uids.iter().enumerate() {
            let single = find_by_uid(&cur, *uid).and_then(|p| {
                let name = p.file_name()?.to_string_lossy().to_string();
                parse_eml_bytes_light(&fs::read(&p).ok()?, *uid, parse_flags_from_filename(&name)).ok()
            });
            assert_eq!(
                serde_json::to_value(&batch[i]).unwrap(),
                serde_json::to_value(&single).unwrap(),
                "uid {uid}"
            );
        }
    }

    // -- Attachment cache --

    const PLAIN_EMAIL: &[u8] = b"From: alice@example.com\r\n\
Subject: Hello\r\n\
Date: Wed, 19 Feb 2026 10:00:00 +0000\r\n\
Content-Type: text/plain\r\n\
\r\n\
Hello, World!";

    fn multipart_with_attachment() -> Vec<u8> {
        b"From: bob@example.com\r\n\
Subject: With attachment\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"BOUNDARY\"\r\n\
\r\n\
--BOUNDARY\r\n\
Content-Type: text/plain\r\n\
\r\n\
Body text\r\n\
--BOUNDARY\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--BOUNDARY--\r\n".to_vec()
    }

    fn photo_with_inline_and_pixel() -> Vec<u8> {
        b"From: dave@example.com\r\n\
Subject: Photo\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"MIX\"\r\n\
\r\n\
--MIX\r\n\
Content-Type: text/html\r\n\
\r\n\
<html><body><img src=\"cid:logo123\"></body></html>\r\n\
--MIX\r\n\
Content-Type: image/png; name=\"photo.png\"\r\n\
Content-Disposition: attachment; filename=\"photo.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--MIX\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo123>\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--MIX\r\n\
Content-Type: image/gif\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
R0lGODlhAQABAAAAACw=\r\n\
--MIX--\r\n".to_vec()
    }

    fn maildir_with(files: &[(u32, &[u8])]) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let cur = dir.path().join("cur");
        fs::create_dir_all(&cur).unwrap();
        for (uid, raw) in files {
            fs::write(cur.join(format!("{}{INFO_PREFIX}S", uid)), raw).unwrap();
        }
        (dir, cur, dir_path_cache())
    }

    fn eml_at(cur: &Path, uid: u32) -> Vec<u8> {
        fs::read(find_by_uid(cur, uid).unwrap()).unwrap()
    }

    fn dir_path_cache() -> PathBuf {
        tempfile::tempdir().unwrap().keep().join("attachment_cache")
    }

    fn leaf(p: &Path) -> String {
        p.file_name().unwrap().to_string_lossy().to_string()
    }

    #[test]
    fn cache_attachment_writes_the_part_once() {
        let (_d, cur, cache) = maildir_with(&[(7, &multipart_with_attachment())]);
        let path = cache_attachment_in(&cache, &eml_at(&cur, 7), "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(leaf(&path), "acct_INBOX_7_0_report.pdf");
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-1.4\n");

        let again = cache_attachment_in(&cache, &eml_at(&cur, 7), "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(again, path);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
    }

    #[test]
    fn cache_attachment_keeps_a_hostile_filename_inside_the_cache() {
        let raw = String::from_utf8(multipart_with_attachment()).unwrap()
            .replace("filename=\"report.pdf\"", "filename=\"../../escape.pdf\"");
        let (_d, cur, cache) = maildir_with(&[(7, raw.as_bytes())]);
        let path = cache_attachment_in(&cache, &eml_at(&cur, 7), "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(path.parent().unwrap(), cache);
        assert_eq!(leaf(&path), "acct_INBOX_7_0_escape.pdf");
    }

    #[test]
    fn cached_attachment_in_reports_only_what_exists() {
        let (_d, cur, cache) = maildir_with(&[(7, &multipart_with_attachment())]);
        assert_eq!(cached_attachment_in(&cache, &eml_at(&cur, 7), "acct", "INBOX", 7, 0).unwrap(), None);
        let path = cache_attachment_in(&cache, &eml_at(&cur, 7), "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(cached_attachment_in(&cache, &eml_at(&cur, 7), "acct", "INBOX", 7, 0).unwrap(), Some(path));
    }

    #[test]
    fn read_attachments_matches_the_single_read_per_slot_and_nulls_a_bad_index() {
        let root = tempfile::tempdir().unwrap();
        let cur = cur_path(root.path(), "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(build_maildir_filename(9, &[])), photo_with_inline_and_pixel()).unwrap();

        // Parts: 0 photo, 1 inline logo, 2 tracking pixel. Request order, a
        // repeat and an out-of-range index all keep their own slot.
        let (_app, reg) = registry(root.path());
        let got = read_attachments(&reg, root.path(), "acct", "INBOX", 9, &[2, 1, 7, 1]).unwrap();

        let one = |i| read_attachment(&reg, root.path(), "acct", "INBOX", 9, i).unwrap();
        assert_eq!(got, vec![Some(one(2)), Some(one(1)), None, Some(one(1))]);
        assert_eq!(got[1].as_deref(), Some("iVBORw0KGgo="));
        assert!(read_attachment(&reg, root.path(), "acct", "INBOX", 9, 7).is_err());

        let missing = read_attachments(&reg, root.path(), "acct", "INBOX", 8, &[0]).unwrap_err();
        assert_eq!(missing, "Email UID 8 not found");
    }

    #[test]
    fn export_writes_the_listed_parts_into_a_folder_of_their_own() {
        let (_d, cur, _c) = maildir_with(&[(9, &photo_with_inline_and_pixel())]);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Photo attachments");

        // Index 0 is the photo; 1 and 2 are the inline logo and the tracking
        // pixel the viewer filters out and therefore never asks for.
        let r = export_attachments_in(&eml_at(&cur, 9), 9, &[0], &dest).unwrap();

        assert_eq!(r.files, vec!["photo.png".to_string()]);
        assert_eq!(Path::new(&r.dir), dest);
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
        assert_eq!(fs::read(dest.join("photo.png")).unwrap(), b"\x89PNG\r\n\x1a\n".to_vec());
    }

    #[test]
    fn a_bulk_export_writes_only_real_attachments_and_skips_what_it_cannot_read() {
        let root = tempfile::tempdir().unwrap();
        let cur = cur_path(root.path(), "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(build_maildir_filename(9, &[])), photo_with_inline_and_pixel()).unwrap();
        fs::write(cur.join(build_maildir_filename(7, &[])), multipart_with_attachment()).unwrap();
        let (_app, reg) = registry(root.path());
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Invoices - Attachments");
        let messages = [9, 7, 8].map(|uid| ("acct".to_string(), "INBOX".to_string(), uid));

        let r = export_many_attachments(&reg, root.path(), &messages, &dest).unwrap();

        // The photo and the PDF; not the inline logo, not the pixel, and uid 8
        // is not in the vault at all.
        assert_eq!((r.files, r.skipped), (2, 1));
        let mut names: Vec<_> = fs::read_dir(&dest).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, vec!["photo.png".to_string(), "report.pdf".to_string()]);
    }

    #[test]
    fn a_bulk_export_that_found_nothing_leaves_no_folder() {
        let root = tempfile::tempdir().unwrap();
        let (_app, reg) = registry(root.path());
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Empty");
        let r = export_many_attachments(&reg, root.path(), &[("acct".into(), "INBOX".into(), 1)], &dest).unwrap();
        assert_eq!((r.files, r.skipped), (0, 1));
        assert!(!dest.exists());
    }

    #[test]
    fn a_second_export_never_writes_into_the_first_ones_folder() {
        let (_d, cur, _c) = maildir_with(&[(7, &multipart_with_attachment())]);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Attachments");

        let first = export_attachments_in(&eml_at(&cur, 7), 7, &[0], &dest).unwrap();
        let second = export_attachments_in(&eml_at(&cur, 7), 7, &[0], &dest).unwrap();

        assert_eq!(Path::new(&first.dir), dest);
        assert_eq!(leaf(Path::new(&second.dir)), "Attachments (1)");
        assert!(dest.join("report.pdf").exists());
        assert!(Path::new(&second.dir).join("report.pdf").exists());
    }

    #[test]
    fn two_parts_sharing_one_name_both_survive() {
        let raw = String::from_utf8(photo_with_inline_and_pixel()).unwrap()
            .replace("Content-ID: <logo123>\r\nContent-Disposition: inline",
                     "Content-Disposition: attachment; filename=\"photo.png\"");
        let (_d, cur, _c) = maildir_with(&[(9, raw.as_bytes())]);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Photo");

        let r = export_attachments_in(&eml_at(&cur, 9), 9, &[0, 1], &dest).unwrap();

        assert_eq!(r.files, vec!["photo.png".to_string(), "photo (1).png".to_string()]);
    }

    #[test]
    fn a_hostile_filename_cannot_escape_the_export_folder() {
        let raw = String::from_utf8(multipart_with_attachment()).unwrap()
            .replace("filename=\"report.pdf\"", "filename=\"../../escape.pdf\"");
        let (_d, cur, _c) = maildir_with(&[(7, raw.as_bytes())]);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Attachments");

        let r = export_attachments_in(&eml_at(&cur, 7), 7, &[0], &dest).unwrap();

        assert_eq!(r.files, vec!["escape.pdf".to_string()]);
        assert!(dest.join("escape.pdf").exists());
        assert!(!out.path().parent().unwrap().join("escape.pdf").exists());
    }

    #[test]
    fn export_refuses_an_index_the_message_does_not_have() {
        let (_d, cur, _c) = maildir_with(&[(7, &multipart_with_attachment())]);
        let out = tempfile::tempdir().unwrap();
        let err = export_attachments_in(&eml_at(&cur, 7), 7, &[5], &out.path().join("A")).unwrap_err();
        assert!(err.contains("out of range"), "{err}");
    }

    #[test]
    fn prefetch_walks_newest_first_and_skips_what_is_not_an_attachment() {
        let (_d, cur, cache) = maildir_with(&[
            (5, &multipart_with_attachment()),
            (9, &photo_with_inline_and_pixel()),
            (3, PLAIN_EMAIL),
        ]);
        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let (written, max_uid) = prefetch_attachments_in(&cache, &cur, "acct", "INBOX", 0, &noop_gate).unwrap();
        let names: Vec<String> = written.iter().map(|p| leaf(p)).collect();
        // The photo only: the cid: logo is part of the HTML and the unnamed
        // 1x1 gif is a tracking pixel — neither is something the user attached.
        assert_eq!(names, vec!["acct_INBOX_9_0_photo.png", "acct_INBOX_5_0_report.pdf"]);
        assert_eq!(max_uid, 9);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 2);

        let (again, _) = prefetch_attachments_in(&cache, &cur, "acct", "INBOX", 0, &noop_gate).unwrap();
        assert!(again.is_empty());
    }

    #[test]
    fn prefetch_sweeps_only_above_the_uid_it_already_saw() {
        let (_d, cur, cache) = maildir_with(&[
            (5, &multipart_with_attachment()),
            (9, &photo_with_inline_and_pixel()),
        ]);
        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let (written, _) = prefetch_attachments_in(&cache, &cur, "acct", "INBOX", 5, &noop_gate).unwrap();
        assert_eq!(written.iter().map(|p| leaf(p)).collect::<Vec<_>>(), vec!["acct_INBOX_9_0_photo.png"]);
    }

    // Task 2.6 fix round 1, I1: the per-file gate must hold each file's
    // *entire* read+parse+write, not just check-then-let-it-run unguarded.
    // Order probe (not timing): the fake gate flips "closed" only after the
    // first file's `work` has fully returned, simulating `vault_close`'s
    // flag landing between files, never mid-write. If `work` ran outside the
    // gate (the pre-fix shape), this test could not tell the difference —
    // the fix is what makes "closed flips right after work() returns, and
    // the next file's gate call sees it before its own work runs" observable
    // at all, since the signature no longer allows a bare pre-check.
    #[test]
    fn a_gate_error_between_files_stops_the_sweep_and_leaves_the_high_water_mark_untouched() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("5{INFO_PREFIX}S")), multipart_with_attachment()).unwrap();
        fs::write(cur.join(format!("9{INFO_PREFIX}S")), photo_with_inline_and_pixel()).unwrap();

        let closed = std::sync::atomic::AtomicBool::new(false);
        let gate = |work: &mut dyn FnMut() -> Result<(), String>| -> Result<(), String> {
            if closed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved".to_string());
            }
            let r = work();
            // Flip only after `work` (this file's whole read+parse+write)
            // has returned — never mid-write.
            closed.store(true, std::sync::atomic::Ordering::SeqCst);
            r
        };
        let high_water = std::sync::Mutex::new(Vec::new());
        let err = prefetch_attachments(root, "acct", "INBOX", &high_water, &gate).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");

        // Only uid 9 (processed first, newest-first) was cached; uid 5's
        // gate call never ran, so no attachment_cache write happened after
        // the flag flipped.
        let cache = root.join("attachment_cache");
        let mut entries: Vec<String> = fs::read_dir(&cache).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        entries.sort();
        assert_eq!(entries, vec!["acct_INBOX_9_0_photo.png"]);

        // The high-water mark is not advanced on error — same contract as
        // before this fix, the next sweep starts from scratch.
        assert!(high_water.lock().unwrap().is_empty());
    }

    // ── Task 2.8: clear_cache / migrate_json_to_eml / migrate_email_dirs,
    // each per-file/per-mailbox gated (never one gate call around the whole
    // walk) ──────────────────────────────────────────────────────────────

    #[test]
    fn clear_cache_deletes_non_archived_skips_archived_and_orphaned() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("1{INFO_PREFIX}S.eml")), b"a").unwrap();
        fs::write(cur.join(format!("2{INFO_PREFIX}AS.eml")), b"b").unwrap(); // archived: kept
        let orphan_dir = cur.parent().unwrap().join(maildir::ORPHAN_DIR);
        fs::create_dir_all(&orphan_dir).unwrap();
        fs::write(orphan_dir.join(format!("3{INFO_PREFIX}S.eml")), b"c").unwrap(); // orphaned: kept

        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let result = clear_cache(&reg, root, &noop_gate).unwrap();
        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.skipped_archived, 1);
        assert!(!cur.join(format!("1{INFO_PREFIX}S.eml")).exists());
        assert!(cur.join(format!("2{INFO_PREFIX}AS.eml")).exists());
        assert!(orphan_dir.join(format!("3{INFO_PREFIX}S.eml")).exists());
    }

    /// Same order-probe shape as prefetch's I1 test: the gate must wrap each
    /// file's own delete, not the whole walk, so a vault-close between files
    /// stops the sweep leaving earlier deletes done and later ones untouched.
    #[test]
    fn clear_cache_gate_error_between_files_stops_the_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("1{INFO_PREFIX}S.eml")), b"a").unwrap();
        fs::write(cur.join(format!("2{INFO_PREFIX}S.eml")), b"b").unwrap();

        let calls = std::sync::atomic::AtomicUsize::new(0);
        let gate = |work: &mut dyn FnMut() -> Result<(), String>| -> Result<(), String> {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                return Err("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved".to_string());
            }
            work()
        };
        let err = clear_cache(&reg, root, &gate).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        let remaining: Vec<String> = fs::read_dir(&cur).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(remaining.len(), 1, "exactly one file must survive the interrupted walk: {:?}", remaining);
    }

    #[test]
    fn migrate_json_to_eml_writes_the_eml_and_removes_the_sidecar() {
        use base64::Engine;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        let raw_b64 = base64::engine::general_purpose::STANDARD.encode(b"From: a@b.com\r\n\r\nbody");
        fs::write(cur.join("7.json"), serde_json::json!({"rawSource": raw_b64}).to_string()).unwrap();
        // A sidecar with no rawSource is removed, not migrated.
        fs::write(cur.join("8.json"), serde_json::json!({}).to_string()).unwrap();

        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let summary = migrate_json_to_eml(&reg, root, &noop_gate).unwrap();
        assert!(summary.contains("Migrated: 1"), "{summary}");
        assert!(summary.contains("Skipped (no rawSource): 1"), "{summary}");
        assert!(cur.join(format!("7{INFO_PREFIX}AS.eml")).exists());
        assert!(!cur.join("7.json").exists());
        assert!(!cur.join("8.json").exists());
    }

    #[test]
    fn migrate_email_dirs_moves_files_onto_the_uuid_dir_and_removes_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let src_cur = cur_path(root, "user@example.com", "INBOX");
        fs::create_dir_all(&src_cur).unwrap();
        fs::write(src_cur.join(format!("1{INFO_PREFIX}S.eml")), b"a").unwrap();

        let mut map = HashMap::new();
        map.insert("user@example.com".to_string(), "uuid-123".to_string());
        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let migrated = migrate_email_dirs(&reg, root, &map, &noop_gate).unwrap();
        assert_eq!(migrated, 1);
        let dst_cur = cur_path(root, "uuid-123", "INBOX");
        assert!(dst_cur.join(format!("1{INFO_PREFIX}S.eml")).exists());
        assert!(!root.join("Maildir").join("user@example.com").exists());
    }

    /// The mailbox move and the final `remove_dir_all` are separate gate
    /// calls: a vault-close after the mailbox move but before the cleanup
    /// leaves the files moved and the (now empty) source dir behind, rather
    /// than losing the move or forcing the whole account through one gate.
    #[test]
    fn migrate_email_dirs_gate_error_after_the_move_leaves_the_source_dir_but_not_the_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let src_cur = cur_path(root, "user@example.com", "INBOX");
        fs::create_dir_all(&src_cur).unwrap();
        fs::write(src_cur.join(format!("1{INFO_PREFIX}S.eml")), b"a").unwrap();

        let calls = std::sync::atomic::AtomicUsize::new(0);
        let gate = |work: &mut dyn FnMut() -> Result<(), String>| -> Result<(), String> {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                return Err("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved".to_string());
            }
            work()
        };
        let mut map = HashMap::new();
        map.insert("user@example.com".to_string(), "uuid-123".to_string());
        let err = migrate_email_dirs(&reg, root, &map, &gate).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        let dst_cur = cur_path(root, "uuid-123", "INBOX");
        assert!(dst_cur.join(format!("1{INFO_PREFIX}S.eml")).exists(), "the mailbox move itself already committed");
        assert!(root.join("Maildir").join("user@example.com").exists(), "the source dir cleanup never ran");
    }

    // ── The vault registry after the whole-vault walkers: each leaves a
    // verified mailbox unverified, so the next read lists it again and
    // answers the disk's truth.

    fn refuse_after_first() -> impl Fn(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String> {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        move |work| {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                return Err("E_VAULT_UNAVAILABLE: closed for a move".to_string());
            }
            work()
        }
    }

    #[test]
    fn clear_cache_makes_a_verified_mailbox_list_again_even_when_the_gate_stops_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        for uid in [1, 2] {
            store(&reg, root, "acct", "INBOX", uid, b"x", &[], true).unwrap();
        }
        store(&reg, root, "acct", "INBOX", 3, b"x", &["archived".to_string()], true).unwrap();
        assert_eq!(sets(&reg, root), (vec![1, 2, 3], vec![3]));
        assert_eq!(reg.listing_count(), 1);

        // One file goes, then the vault closes: the walk still invalidates.
        let gate = refuse_after_first();
        clear_cache(&reg, root, &gate).unwrap_err();
        let (saved, archived) = sets(&reg, root);
        assert_eq!(reg.listing_count(), 2, "the next read relisted");
        assert_eq!(saved.len(), 2, "one of uids 1/2 is gone, the archived 3 stays: {saved:?}");
        assert_eq!(archived, vec![3]);

        clear_cache(&reg, root, &|work| work()).unwrap();
        assert_eq!(sets(&reg, root), (vec![3], vec![3]));
        assert_eq!(reg.listing_count(), 3);
    }

    #[test]
    fn a_clear_cache_that_deletes_nothing_keeps_the_mailbox_verified() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        store(&reg, root, "acct", "INBOX", 3, b"x", &["archived".to_string()], true).unwrap();
        assert_eq!(sets(&reg, root), (vec![3], vec![3]));
        clear_cache(&reg, root, &|work| work()).unwrap();
        assert_eq!(sets(&reg, root), (vec![3], vec![3]));
        assert_eq!(reg.listing_count(), 1);
    }

    #[test]
    fn migrate_json_to_eml_makes_a_verified_mailbox_list_again() {
        use base64::Engine;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        let raw_b64 = base64::engine::general_purpose::STANDARD.encode(b"From: a@b.com\r\n\r\nbody");
        fs::write(cur.join("7.json"), serde_json::json!({"rawSource": raw_b64}).to_string()).unwrap();
        assert_eq!(sets(&reg, root), (vec![], vec![]), "a sidecar is not a vault message");

        migrate_json_to_eml(&reg, root, &|work| work()).unwrap();
        assert_eq!(sets(&reg, root), (vec![7], vec![7]));
        assert_eq!(reg.listing_count(), 2);
    }

    #[test]
    fn migrate_email_dirs_makes_both_accounts_mailboxes_list_again() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_app, reg) = registry(root);
        let src_cur = cur_path(root, "user@example.com", "INBOX");
        fs::create_dir_all(&src_cur).unwrap();
        fs::write(src_cur.join(format!("1{INFO_PREFIX}S.eml")), b"a").unwrap();
        let uid_sets = |account: &str| reg.uid_sets(root, account, "INBOX").unwrap().0;
        assert_eq!(uid_sets("user@example.com"), vec![1]);
        assert_eq!(uid_sets("uuid-123"), Vec::<u32>::new());
        assert_eq!(reg.listing_count(), 2);

        let map = HashMap::from([("user@example.com".to_string(), "uuid-123".to_string())]);
        migrate_email_dirs(&reg, root, &map, &|work| work()).unwrap();
        assert_eq!(uid_sets("user@example.com"), Vec::<u32>::new());
        assert_eq!(uid_sets("uuid-123"), vec![1]);
        assert_eq!(reg.listing_count(), 4);
    }
}
