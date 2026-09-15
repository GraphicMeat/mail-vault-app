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

use crate::fsx::write_atomic;
use crate::maildir::{self, find_by_uid, vault_filename_uid};
use crate::vault_eml::{
    collect_attachment_parts, is_real_attachment, parse_eml_bytes, parse_eml_bytes_light,
    parse_flags_from_filename, part_filename, read_light_at, walk_mime_parts_light, LightEmail,
    ParsedEmail,
};

// ── Paths and filenames ──────────────────────────────────────────────────────

/// `{root}/Maildir/{account_id}/{vault_dir_name(mailbox)}/cur`.
pub fn cur_path(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    let safe_mailbox = crate::search_index::text::vault_dir_name(mailbox);
    root.join("Maildir").join(account_id).join(&safe_mailbox).join("cur")
}

/// Build a vault filename from UID and flags: `{uid}:2,{letters}.eml`, letters
/// sorted and deduped (A D F R S T).
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
    format!("{}:2,{}.eml", uid, flag_str)
}

/// Delete every vault file in `cur_dir` whose uid is in `uids`. One directory
/// pass — the per-uid `find_by_uid` rescans the whole directory each call,
/// which is quadratic over a bulk selection.
pub fn delete_maildir_files(cur_dir: &Path, uids: &HashSet<u32>) -> usize {
    let mut removed = 0usize;
    if let Ok(entries) = fs::read_dir(cur_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(uid) = vault_filename_uid(&name) else { continue };
            if !uids.contains(&uid) {
                continue;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(e) => warn!("maildir purge: failed to remove {:?}: {}", entry.path(), e),
            }
        }
    }
    removed
}

// ── Store / read / list / delete / set_flags ─────────────────────────────────

/// Store `raw` under `uid`. `overwrite` selects `maildir_store`'s semantics
/// (always replace) vs `maildir_store_raw`'s (skip if a file for this uid
/// already exists). Returns whether a write happened.
///
/// The new name is written first with `write_atomic`, then a differently
/// named old file for the same uid is removed — a failed or killed write
/// leaves the previous copy intact (oddity 1; was remove-then-plain-write).
pub fn store(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    raw: &[u8],
    flags: &[String],
    overwrite: bool,
) -> Result<bool, String> {
    let dir = cur_path(root, account_id, mailbox);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Maildir directory: {}", e))?;

    let existing = find_by_uid(&dir, uid);
    if !overwrite && existing.is_some() {
        return Ok(false);
    }

    let filename = build_maildir_filename(uid, flags);
    let new_path = dir.join(&filename);

    write_atomic(&new_path, raw).map_err(|e| format!("Failed to write .eml file: {}", e))?;

    if let Some(old) = existing {
        if old != new_path {
            let _ = fs::remove_file(&old);
        }
    }

    info!("Stored email UID {} to {:?} ({} bytes)", uid, new_path, raw.len());
    Ok(true)
}

pub fn read(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<ParsedEmail>, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    let file_path = match find_by_uid(&cur_dir, uid) {
        Some(p) => p,
        None => return Ok(None),
    };
    let filename = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let flags = parse_flags_from_filename(&filename);
    let raw = fs::read(&file_path).map_err(|e| format!("Failed to read .eml file: {}", e))?;
    let email = parse_eml_bytes(&raw, uid, flags)?;
    Ok(Some(email))
}

pub fn read_light(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<LightEmail>, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    let file_path = match find_by_uid(&cur_dir, uid) {
        Some(p) => p,
        None => return Ok(None),
    };
    let filename = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let flags = parse_flags_from_filename(&filename);
    let raw = fs::read(&file_path).map_err(|e| format!("Failed to read .eml file: {}", e))?;
    let email = parse_eml_bytes_light(&raw, uid, flags)?;
    Ok(Some(email))
}

/// One slot per requested uid, in request order: `None` when the vault has no
/// `<uid>:` file or it does not parse. The folder is listed once
/// (`uid_file_map`); resolving each uid with `find_by_uid` rescanned the whole
/// directory per uid, quadratic over a folder.
pub fn read_light_batch(root: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<Option<LightEmail>> {
    let cur_dir = cur_path(root, account_id, mailbox);
    let files = maildir::uid_file_map(&cur_dir);
    uids.iter()
        .map(|uid| read_light_at(&cur_dir, *uid, files.get(uid).map(|p| p.as_path())))
        .collect()
}

pub fn read_attachment(root: &Path, account_id: &str, mailbox: &str, uid: u32, attachment_index: usize) -> Result<String, String> {
    use base64::Engine;
    let cur_dir = cur_path(root, account_id, mailbox);
    let file_path = find_by_uid(&cur_dir, uid).ok_or_else(|| format!("Email UID {} not found", uid))?;
    let raw = fs::read(&file_path).map_err(|e| format!("Failed to read .eml file: {}", e))?;
    let parsed = mailparse::parse_mail(&raw).map_err(|e| format!("Failed to parse email: {}", e))?;

    let mut attach_parts: Vec<&mailparse::ParsedMail> = Vec::new();
    collect_attachment_parts(&parsed, &mut attach_parts);

    let part = attach_parts.get(attachment_index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", attachment_index, attach_parts.len()))?;

    let body = part.get_body_raw().map_err(|e| format!("Failed to get attachment body: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&body))
}

pub fn read_raw_source(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<String, String> {
    use base64::Engine;
    let cur_dir = cur_path(root, account_id, mailbox);
    let file_path = find_by_uid(&cur_dir, uid).ok_or_else(|| format!("Email UID {} not found", uid))?;
    let raw = fs::read(&file_path).map_err(|e| format!("Failed to read .eml file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&raw))
}

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

pub fn list(root: &Path, account_id: &str, mailbox: &str, require_flag: Option<&str>) -> Result<Vec<MaildirEmailSummary>, String> {
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

        let flags = parse_flags_from_filename(&name);
        let is_archived = flags.iter().any(|f| f == "archived");

        if let Some(required) = require_flag {
            if !flags.iter().any(|f| f == required) {
                continue;
            }
        }

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        results.push(MaildirEmailSummary { uid, flags, is_archived, size });
    }

    if require_flag.is_some() {
        info!("maildir_list: require_flag={:?}, found {} results", require_flag, results.len());
    }
    Ok(results)
}

/// Removes the vault file for `uid`, if there is one. Returns whether a file
/// was removed (the caller nudges the index only then).
pub fn delete(root: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<bool, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    if let Some(path) = find_by_uid(&cur_dir, uid) {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete .eml file: {}", e))?;
        info!("Deleted email UID {} from {:?}", uid, path);
        return Ok(true);
    }
    Ok(false)
}

/// Rename the vault file for `uid` onto the filename `flags` builds. Returns
/// whether a rename happened (the old and new names can already agree).
pub fn set_flags(root: &Path, account_id: &str, mailbox: &str, uid: u32, flags: &[String]) -> Result<bool, String> {
    let cur_dir = cur_path(root, account_id, mailbox);
    let old_path = match find_by_uid(&cur_dir, uid) {
        Some(p) => p,
        None => return Err(format!("E_UID_NOT_IN_MAILDIR: Email UID {} not found in Maildir", uid)),
    };

    let new_filename = build_maildir_filename(uid, flags);
    let new_path = cur_dir.join(&new_filename);

    if old_path != new_path {
        fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename file: {}", e))?;
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
            if name.contains(":2,") {
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
/// current server does not have — this copy may be the only one). The caller
/// sweeps the index soon when `deleted_count > 0`.
pub fn clear_cache(root: &Path) -> MaildirClearCacheResult {
    let base = root.join("Maildir");
    if !base.exists() {
        return MaildirClearCacheResult { deleted_count: 0, skipped_archived: 0 };
    }

    let mut deleted_count: u32 = 0;
    let mut skipped_archived: u32 = 0;

    for entry in walkdir::WalkDir::new(&base).into_iter().flatten() {
        if entry.path().components().any(|c| c.as_os_str() == maildir::ORPHAN_DIR) {
            continue;
        }
        if entry.file_type().is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(":2,") {
                let flags = parse_flags_from_filename(&name);
                if flags.iter().any(|f| f == "archived") {
                    skipped_archived += 1;
                } else if let Err(e) = fs::remove_file(entry.path()) {
                    warn!("Failed to delete cached email {:?}: {}", entry.path(), e);
                } else {
                    deleted_count += 1;
                }
            }
        }
    }

    info!("Cleared email cache: deleted {} files, skipped {} archived", deleted_count, skipped_archived);
    MaildirClearCacheResult { deleted_count, skipped_archived }
}

/// One-time migration of pre-.eml JSON sidecars (`<uid>.json` with a
/// `rawSource` field) into `<uid>:2,AS.eml` files. Legacy-only path; never
/// nudges the index (suspected gap, inventory §4 — kept unchanged).
pub fn migrate_json_to_eml(root: &Path) -> String {
    use base64::Engine;
    let base = root.join("Maildir");

    if !base.exists() {
        return "No Maildir directory found, nothing to migrate.".to_string();
    }

    let mut migrated = 0u32;
    let mut skipped = 0u32;
    let mut errors = 0u32;

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

            match fs::write(&eml_path, &raw_bytes) {
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
        } else {
            warn!("No rawSource in {:?}, cannot migrate to .eml — removing", path);
            let _ = fs::remove_file(&path);
            skipped += 1;
        }
    }

    let result = format!(
        "Migration complete. Migrated: {}, Skipped (no rawSource): {}, Errors: {}",
        migrated, skipped, errors
    );
    info!("{}", result);
    result
}

/// Moves account-email-keyed mailbox dirs onto their account-uuid dir.
/// Returns the number of files moved; the caller sweeps the index soon when
/// it is non-zero.
pub fn migrate_email_dirs(root: &Path, account_map: &HashMap<String, String>) -> usize {
    let maildir_base = root.join("Maildir");
    if !maildir_base.exists() {
        return 0;
    }

    let mut migrated = 0usize;

    for (email, uuid) in account_map {
        let email_dir = maildir_base.join(email);
        let uuid_dir = maildir_base.join(uuid);

        if !email_dir.exists() || email_dir == uuid_dir {
            continue;
        }

        if let Ok(mailbox_entries) = fs::read_dir(&email_dir) {
            for mb_entry in mailbox_entries.flatten() {
                if !mb_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let mb_name = mb_entry.file_name();
                let src_cur = mb_entry.path().join("cur");
                if !src_cur.exists() { continue; }

                let dst_cur = uuid_dir.join(&mb_name).join("cur");
                if let Err(e) = fs::create_dir_all(&dst_cur) {
                    warn!("Migration: failed to create {:?}: {}", dst_cur, e);
                    continue;
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
            }
        }

        let _ = fs::remove_dir_all(&email_dir);
    }

    info!("Maildir migration: moved {} files from email-address dirs to UUID dirs", migrated);
    migrated
}

// ── Attachment cache ──────────────────────────────────────────────────────────
// One file per (account, mailbox, uid, part) under <root>/attachment_cache,
// named so a click, the prefetch and the "already downloaded" check all land
// on the same path without a registry.

pub fn fs_safe(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

pub fn attachment_cache_path(cache_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize, filename: &str) -> PathBuf {
    // A sender picks the filename; only its last component may name a file here.
    let leaf = Path::new(filename)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .filter(|f| !f.is_empty() && f != "." && f != "..")
        .unwrap_or_else(|| "attachment".to_string());
    cache_dir.join(format!("{}_{}_{}_{}_{}", fs_safe(account_id), fs_safe(mailbox), uid, index, leaf))
}

fn write_part_to_cache(cache_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize, part: &mailparse::ParsedMail) -> Result<PathBuf, String> {
    let dest = attachment_cache_path(cache_dir, account_id, mailbox, uid, index, &part_filename(part));
    if dest.exists() {
        return Ok(dest);
    }
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create attachment cache dir: {}", e))?;
    let body = part.get_body_raw().map_err(|e| format!("Failed to get attachment body: {}", e))?;
    fs::write(&dest, &body).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(dest)
}

fn read_eml(cur_dir: &Path, uid: u32) -> Result<Vec<u8>, String> {
    let file_path = find_by_uid(cur_dir, uid).ok_or_else(|| format!("Email UID {} not found", uid))?;
    fs::read(&file_path).map_err(|e| format!("Failed to read .eml file: {}", e))
}

/// Write one attachment part to the cache (a no-op when it is there already)
/// and return its path.
fn cache_attachment_in(cache_dir: &Path, cur_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<PathBuf, String> {
    let raw = read_eml(cur_dir, uid)?;
    let parsed = mailparse::parse_mail(&raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let part = parts.get(index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", index, parts.len()))?;
    write_part_to_cache(cache_dir, account_id, mailbox, uid, index, part)
}

/// The cached path of one attachment part, if the file exists.
// ponytail: parses the .eml for the part's filename on every mount check;
// pass the name from the viewer if that ever shows up in a profile.
fn cached_attachment_in(cache_dir: &Path, cur_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<Option<PathBuf>, String> {
    let raw = read_eml(cur_dir, uid)?;
    let parsed = mailparse::parse_mail(&raw).map_err(|e| format!("Failed to parse email: {}", e))?;
    let mut parts = Vec::new();
    collect_attachment_parts(&parsed, &mut parts);
    let part = parts.get(index)
        .ok_or_else(|| format!("Attachment index {} out of range (total: {})", index, parts.len()))?;
    let dest = attachment_cache_path(cache_dir, account_id, mailbox, uid, index, &part_filename(part));
    Ok(dest.exists().then_some(dest))
}

/// Write one attachment part to the cache and return its absolute path.
pub fn cache_attachment(root: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<String, String> {
    let cache_dir = root.join("attachment_cache");
    let cur_dir = cur_path(root, account_id, mailbox);
    let path = cache_attachment_in(&cache_dir, &cur_dir, account_id, mailbox, uid, index)?;
    Ok(path.to_string_lossy().to_string())
}

/// The cached path of one attachment part, if the file exists.
pub fn cached_attachment_path(root: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<Option<String>, String> {
    let cache_dir = root.join("attachment_cache");
    let cur_dir = cur_path(root, account_id, mailbox);
    Ok(cached_attachment_in(&cache_dir, &cur_dir, account_id, mailbox, uid, index)?
        .map(|p| p.to_string_lossy().to_string()))
}

/// Sweep a mailbox's cached .eml files newest-first (uid order) and write
/// every real attachment above `above_uid` to the cache. Returns the paths it
/// wrote, in sweep order, and the highest uid it saw.
fn prefetch_attachments_in(cache_dir: &Path, cur_dir: &Path, account_id: &str, mailbox: &str, above_uid: u32) -> Result<(Vec<PathBuf>, u32), String> {
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
        let Ok(raw) = fs::read(&path) else { continue };
        // A message with no Content-Disposition header has no attachment part.
        if !raw.windows(19).any(|w| w.eq_ignore_ascii_case(b"content-disposition")) { continue; }
        let Ok(parsed) = mailparse::parse_mail(&raw) else { continue };
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
    }
    Ok((written, max_uid))
}

/// One sweep at a time is the caller's job (a lock around this call); the
/// high-water mark is passed in so each caller (the app today, the daemon
/// later) owns its own — it resets whenever the process holding it restarts.
pub fn prefetch_attachments(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    high_water: &std::sync::Mutex<Vec<(String, u32)>>,
) -> Result<usize, String> {
    let cache_dir = root.join("attachment_cache");
    let cur_dir = cur_path(root, account_id, mailbox);
    let key = format!("{}/{}", account_id, mailbox);
    let above = high_water.lock().unwrap_or_else(|p| p.into_inner())
        .iter().find(|(k, _)| *k == key).map(|(_, uid)| *uid).unwrap_or(0);
    let (written, max_uid) = prefetch_attachments_in(&cache_dir, &cur_dir, account_id, mailbox, above)?;
    let mut marks = high_water.lock().unwrap_or_else(|p| p.into_inner());
    match marks.iter_mut().find(|(k, _)| *k == key) {
        Some(entry) => entry.1 = max_uid,
        None => marks.push((key, max_uid)),
    }
    info!("Attachment prefetch {}/{}: {} written above uid {}", account_id, mailbox, written.len(), above);
    Ok(written.len())
}

// ── Repair inputs ─────────────────────────────────────────────────────────────
// The repair logic itself (`maildir::repair_generation`, `orphan_stats`,
// `purge_orphans`) is already core; these feed it from the on-disk sidecars.

/// Sanitized `<account>_<mailbox>` cache directory name. Duplicated from
/// `src-tauri/src/main.rs::cache_base_name` because `cache_base_name` itself
/// does not move to core until Task 2.3 (header cache); that task deletes
/// this copy and points these two functions at the shared one.
fn cache_base_name(account_id: &str, mailbox: &str) -> String {
    format!("{}_{}",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_"))
}

/// Message-ID → uid for the mailbox's *current* generation, read from the
/// sidecar cache the sync engine already maintains.
pub fn sidecar_message_id_map(root: &Path, account_id: &str, mailbox: &str) -> (HashMap<String, u32>, u64) {
    let mut map = HashMap::new();
    let mut sidecars = 0u64;
    let dir = root.join("email_cache").join(cache_base_name(account_id, mailbox));
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return (map, 0),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // `_meta.json` and anything else that isn't `{uid}.json`.
        let uid: u32 = match name.strip_suffix(".json").and_then(|s| s.parse().ok()) {
            Some(u) => u,
            None => continue,
        };
        sidecars += 1;
        let value: serde_json::Value = match fs::read_to_string(entry.path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(v) => v,
            None => continue,
        };
        // Sidecars written by the frontend carry `messageId`; ones serialized
        // from `EmailHeader` carry `message_id`.
        let raw = value.get("messageId").or_else(|| value.get("message_id")).and_then(|v| v.as_str());
        if let Some(raw) = raw {
            let id = maildir::normalize_message_id(raw);
            if !id.is_empty() {
                map.insert(id, uid);
            }
        }
    }
    (map, sidecars)
}

/// What the sync engine last recorded for this mailbox: the UIDVALIDITY its
/// UIDs belong to, and how many messages the server said it holds.
pub fn cached_sync_meta(root: &Path, account_id: &str, mailbox: &str) -> (Option<u32>, Option<u64>) {
    let read = || -> Option<serde_json::Value> {
        let path = root.join("email_cache").join(cache_base_name(account_id, mailbox)).join("_meta.json");
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    };
    match read() {
        Some(meta) => (
            meta.get("uidValidity").and_then(|v| v.as_u64()).map(|v| v as u32),
            meta.get("totalEmails").and_then(|v| v.as_u64()),
        ),
        None => (None, None),
    }
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

    #[test]
    fn a_vault_file_name_round_trips_through_the_builder() {
        assert_eq!(
            build_maildir_filename(12, &parse_flags_from_filename("12:2,AS.eml")),
            "12:2,AS.eml"
        );
    }

    #[test]
    fn deletes_only_requested_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        fs::write(cur.join("101:2,S"), b"x").unwrap();
        fs::write(cur.join("102:2,"), b"x").unwrap();
        fs::write(cur.join("103:2,S"), b"x").unwrap();
        // A uid that is a prefix of another must not be swept up.
        fs::write(cur.join("1010:2,S"), b"x").unwrap();

        let mut uids = HashSet::new();
        uids.insert(101u32);
        uids.insert(103u32);

        let removed = delete_maildir_files(cur, &uids);

        assert_eq!(removed, 2);
        assert!(!cur.join("101:2,S").exists());
        assert!(!cur.join("103:2,S").exists());
        assert!(cur.join("102:2,").exists());
        assert!(cur.join("1010:2,S").exists(), "1010 must survive a purge of 101");
    }

    #[test]
    fn store_writes_atomically_then_removes_the_old_differently_named_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(store(root, "acct", "INBOX", 7, b"one", &["seen".to_string()], true).unwrap());
        let cur = cur_path(root, "acct", "INBOX");
        assert!(cur.join("7:2,S.eml").exists());

        // Overwrite with new flags: exactly one file survives.
        assert!(store(root, "acct", "INBOX", 7, b"two", &["flagged".to_string(), "seen".to_string()], true).unwrap());
        let names: Vec<String> = fs::read_dir(&cur).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["7:2,FS.eml"]);
        assert_eq!(fs::read(cur.join("7:2,FS.eml")).unwrap(), b"two");
    }

    #[test]
    fn store_without_overwrite_skips_an_existing_uid() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(store(root, "acct", "INBOX", 7, b"one", &[], false).unwrap());
        assert!(!store(root, "acct", "INBOX", 7, b"two", &[], false).unwrap(), "must skip, not overwrite");
        let cur = cur_path(root, "acct", "INBOX");
        assert_eq!(fs::read(find_by_uid(&cur, 7).unwrap()).unwrap(), b"one");
    }

    // -- read_light_batch (moved from src-tauri/src/light_batch_tests.rs) --

    fn light_batch_eml(subject: &str) -> Vec<u8> {
        format!("From: A <a@x.test>\r\nTo: b@x.test\r\nSubject: {subject}\r\nMessage-ID: <{subject}@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nbody of {subject}\r\n").into_bytes()
    }

    #[test]
    fn batch_keeps_one_slot_per_requested_uid_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join("5:2,S.eml"), light_batch_eml("five")).unwrap();
        fs::write(cur.join("9:2,AF.eml"), light_batch_eml("nine")).unwrap();
        fs::write(cur.join("12.eml"), light_batch_eml("legacy")).unwrap(); // no colon: not a vault row
        fs::write(cur.join("14:2,.eml"), b"\xff\xfe not mime at all").unwrap();

        let out = read_light_batch(root, "acct", "INBOX", &[9, 404, 5, 12, 14]);
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

    #[test]
    fn batch_matches_the_per_uid_lookup_it_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = cur_path(root, "acct", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        for uid in 1..=40u32 {
            fs::write(cur.join(format!("{uid}:2,S.eml")), light_batch_eml(&format!("m{uid}"))).unwrap();
        }
        let uids: Vec<u32> = (0..=41).rev().collect();
        let batch = read_light_batch(root, "acct", "INBOX", &uids);
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
            fs::write(cur.join(format!("{}:2,S", uid)), raw).unwrap();
        }
        (dir, cur, dir_path_cache())
    }

    fn dir_path_cache() -> PathBuf {
        tempfile::tempdir().unwrap().into_path().join("attachment_cache")
    }

    fn leaf(p: &Path) -> String {
        p.file_name().unwrap().to_string_lossy().to_string()
    }

    #[test]
    fn cache_attachment_writes_the_part_once() {
        let (_d, cur, cache) = maildir_with(&[(7, &multipart_with_attachment())]);
        let path = cache_attachment_in(&cache, &cur, "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(leaf(&path), "acct_INBOX_7_0_report.pdf");
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-1.4\n");

        let again = cache_attachment_in(&cache, &cur, "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(again, path);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
    }

    #[test]
    fn cache_attachment_keeps_a_hostile_filename_inside_the_cache() {
        let raw = String::from_utf8(multipart_with_attachment()).unwrap()
            .replace("filename=\"report.pdf\"", "filename=\"../../escape.pdf\"");
        let (_d, cur, cache) = maildir_with(&[(7, raw.as_bytes())]);
        let path = cache_attachment_in(&cache, &cur, "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(path.parent().unwrap(), cache);
        assert_eq!(leaf(&path), "acct_INBOX_7_0_escape.pdf");
    }

    #[test]
    fn cached_attachment_in_reports_only_what_exists() {
        let (_d, cur, cache) = maildir_with(&[(7, &multipart_with_attachment())]);
        assert_eq!(cached_attachment_in(&cache, &cur, "acct", "INBOX", 7, 0).unwrap(), None);
        let path = cache_attachment_in(&cache, &cur, "acct", "INBOX", 7, 0).unwrap();
        assert_eq!(cached_attachment_in(&cache, &cur, "acct", "INBOX", 7, 0).unwrap(), Some(path));
    }

    #[test]
    fn prefetch_walks_newest_first_and_skips_what_is_not_an_attachment() {
        let (_d, cur, cache) = maildir_with(&[
            (5, &multipart_with_attachment()),
            (9, &photo_with_inline_and_pixel()),
            (3, PLAIN_EMAIL),
        ]);
        let (written, max_uid) = prefetch_attachments_in(&cache, &cur, "acct", "INBOX", 0).unwrap();
        let names: Vec<String> = written.iter().map(|p| leaf(p)).collect();
        // The photo only: the cid: logo is part of the HTML and the unnamed
        // 1x1 gif is a tracking pixel — neither is something the user attached.
        assert_eq!(names, vec!["acct_INBOX_9_0_photo.png", "acct_INBOX_5_0_report.pdf"]);
        assert_eq!(max_uid, 9);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 2);

        let (again, _) = prefetch_attachments_in(&cache, &cur, "acct", "INBOX", 0).unwrap();
        assert!(again.is_empty());
    }

    #[test]
    fn prefetch_sweeps_only_above_the_uid_it_already_saw() {
        let (_d, cur, cache) = maildir_with(&[
            (5, &multipart_with_attachment()),
            (9, &photo_with_inline_and_pixel()),
        ]);
        let (written, _) = prefetch_attachments_in(&cache, &cur, "acct", "INBOX", 5).unwrap();
        assert_eq!(written.iter().map(|p| leaf(p)).collect::<Vec<_>>(), vec!["acct_INBOX_9_0_photo.png"]);
    }
}
