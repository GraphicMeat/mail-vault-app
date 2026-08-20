//! Maildir operations — store, read, list, delete .eml files.
//!
//! All functions take an explicit `data_dir` path (no Tauri dependency).
//! Layout: {data_dir}/Maildir/{account_id}/{mailbox}/cur/{uid}:{flags}:{timestamp}.eml

use crate::types::{EmailHeader, EmailAddress, ParsedEmail, Attachment};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Get the Maildir/cur path for an account + mailbox.
pub fn cur_path(data_dir: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    data_dir.join("Maildir").join(account_id).join(mailbox).join("cur")
}

/// Build a Maildir filename from UID and flags.
///
/// Filename format: `{uid}:{flags}:{timestamp}.eml`. The `.eml` suffix makes
/// the file double-clickable in the user's OS and keeps the zip export usable
/// without a rename step.
pub fn build_filename(uid: u32, flags: &[String]) -> String {
    let ts = chrono::Utc::now().timestamp();
    let flags_str = if flags.is_empty() {
        String::new()
    } else {
        flags.iter()
            .map(|f| f.trim_start_matches('\\').to_lowercase())
            .collect::<Vec<_>>()
            .join(",")
    };
    format!("{}:{}:{}.eml", uid, flags_str, ts)
}

/// Find a file by UID in a Maildir/cur directory.
pub fn find_by_uid(cur_dir: &Path, uid: u32) -> Option<PathBuf> {
    let prefix = format!("{}:", uid);
    if let Ok(entries) = fs::read_dir(cur_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                return Some(entry.path());
            }
        }
    }
    None
}

/// List all UIDs in a Maildir/cur directory.
pub fn list_uids(data_dir: &Path, account_id: &str, mailbox: &str) -> Vec<u32> {
    let dir = cur_path(data_dir, account_id, mailbox);
    if !dir.exists() {
        return vec![];
    }

    let mut uids = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(uid_str) = name.split(':').next() {
                if let Ok(uid) = uid_str.parse::<u32>() {
                    uids.push(uid);
                }
            }
        }
    }
    uids.sort();
    uids
}

/// Store a raw email (bytes) to Maildir.
pub fn store(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    raw_bytes: &[u8],
    flags: &[String],
) -> Result<PathBuf, String> {
    let dir = cur_path(data_dir, account_id, mailbox);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Maildir: {}", e))?;

    // Skip if already exists
    if find_by_uid(&dir, uid).is_some() {
        return Ok(dir.join(build_filename(uid, flags)));
    }

    let filename = build_filename(uid, flags);
    let path = dir.join(&filename);
    fs::write(&path, raw_bytes).map_err(|e| format!("Failed to write .eml: {}", e))?;

    info!("Stored UID {} ({} bytes) → {:?}", uid, raw_bytes.len(), path);
    Ok(path)
}

/// Read a raw .eml file by UID.
pub fn read_raw(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<Vec<u8>, String> {
    let dir = cur_path(data_dir, account_id, mailbox);
    let path = find_by_uid(&dir, uid)
        .ok_or_else(|| format!("Email UID {} not found in {}/{}", uid, account_id, mailbox))?;
    fs::read(&path).map_err(|e| format!("Failed to read .eml: {}", e))
}

/// Parse an .eml file into a lightweight header (no body/attachments).
pub fn parse_header(raw: &[u8]) -> Result<EmailHeader, String> {
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;

    let message_id = get_header(headers, "Message-ID");
    let subject = get_header(headers, "Subject").unwrap_or_default();
    let from = get_header(headers, "From").map(|s| parse_address(&s));
    let to = get_header(headers, "To")
        .map(|s| parse_address_list(&s))
        .unwrap_or_default();
    let date = get_header(headers, "Date").unwrap_or_default();
    let in_reply_to = get_header(headers, "In-Reply-To");
    let references = get_header(headers, "References")
        .map(|s| s.split_whitespace().map(String::from).collect());

    Ok(EmailHeader {
        uid: 0, // Caller must set
        message_id,
        subject,
        from,
        to,
        date,
        flags: vec![],
        size: raw.len() as u64,
        in_reply_to,
        references,
        snippet: extract_snippet(&parsed),
    })
}

/// Delete an email from Maildir by UID.
pub fn delete(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<(), String> {
    let dir = cur_path(data_dir, account_id, mailbox);
    match find_by_uid(&dir, uid) {
        Some(path) => {
            fs::remove_file(&path).map_err(|e| format!("Failed to delete: {}", e))?;
            info!("Deleted UID {} from {}/{}", uid, account_id, mailbox);
            Ok(())
        }
        None => Ok(()), // Already deleted
    }
}

/// Get storage stats for an account.
pub fn storage_stats(data_dir: &Path, account_id: &str) -> StorageStats {
    let root = data_dir.join("Maildir").join(account_id);
    let mut total_size: u64 = 0;
    let mut total_emails: u64 = 0;
    let mut mailbox_count: u64 = 0;

    if root.exists() {
        for entry in walkdir::WalkDir::new(&root).min_depth(1).max_depth(1) {
            if let Ok(entry) = entry {
                if entry.file_type().is_dir() {
                    mailbox_count += 1;
                    let cur = entry.path().join("cur");
                    if cur.exists() {
                        if let Ok(files) = fs::read_dir(&cur) {
                            for file in files.flatten() {
                                total_emails += 1;
                                total_size += file.metadata().map(|m| m.len()).unwrap_or(0);
                            }
                        }
                    }
                }
            }
        }
    }

    StorageStats { total_size, total_emails, mailbox_count }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StorageStats {
    pub total_size: u64,
    pub total_emails: u64,
    pub mailbox_count: u64,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct EmlMigrationStats {
    pub renamed: u64,
    pub already_ok: u64,
    pub skipped_non_message: u64,
    pub errors: u64,
}

const MAILDIR_VERSION_FILE: &str = ".maildir_version";
const MAILDIR_CURRENT_VERSION: u32 = 2;

/// One-time migration: append `.eml` to every Maildir message file that lacks
/// the extension. Idempotent — guarded by `{data_dir}/Maildir/.maildir_version`.
///
/// Walks `{data_dir}/Maildir/*/*/{cur,new,tmp}/` and renames files whose name
/// looks like a Maildir message (`{uid}:...`) but does not already end in
/// `.eml`. Files that don't match the pattern (e.g. `local-index.json`) are
/// left alone.
pub fn migrate_add_eml_extension(data_dir: &Path) -> EmlMigrationStats {
    let mut stats = EmlMigrationStats::default();
    let maildir_root = data_dir.join("Maildir");
    if !maildir_root.exists() {
        return stats;
    }

    let version_path = maildir_root.join(MAILDIR_VERSION_FILE);
    if let Ok(s) = fs::read_to_string(&version_path) {
        if s.trim().parse::<u32>().unwrap_or(0) >= MAILDIR_CURRENT_VERSION {
            return stats;
        }
    }

    let account_dirs = match fs::read_dir(&maildir_root) {
        Ok(d) => d,
        Err(e) => {
            warn!("migrate_add_eml_extension: read Maildir root failed: {}", e);
            return stats;
        }
    };

    for account_entry in account_dirs.flatten() {
        if !account_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mailbox_dirs = match fs::read_dir(account_entry.path()) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for mailbox_entry in mailbox_dirs.flatten() {
            if !mailbox_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            for sub in ["cur", "new", "tmp"] {
                let dir = mailbox_entry.path().join(sub);
                if !dir.exists() {
                    continue;
                }
                rename_dir_add_eml(&dir, &mut stats);
            }
        }
    }

    if let Err(e) = fs::write(&version_path, MAILDIR_CURRENT_VERSION.to_string()) {
        warn!("migrate_add_eml_extension: write version file failed: {}", e);
    }

    info!(
        "migrate_add_eml_extension: renamed={} already_ok={} skipped={} errors={}",
        stats.renamed, stats.already_ok, stats.skipped_non_message, stats.errors
    );
    stats
}

fn rename_dir_add_eml(dir: &Path, stats: &mut EmlMigrationStats) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();

        // Heuristic: Maildir message filenames start with `{uid}:`.
        // Anything else (local-index.json, hidden files, etc.) is left alone.
        let looks_like_message = name
            .split(':')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .is_some();
        if !looks_like_message {
            stats.skipped_non_message += 1;
            continue;
        }

        if name.ends_with(".eml") {
            stats.already_ok += 1;
            continue;
        }

        let src = entry.path();
        let dst = dir.join(format!("{}.eml", name));
        if dst.exists() {
            // Collision: a sibling already has the `.eml` variant. Leave the
            // extension-less file in place — readers match by `{uid}:` prefix,
            // so the first hit still resolves. Don't silently overwrite.
            warn!("migrate_add_eml_extension: collision, skipping: {:?}", src);
            stats.errors += 1;
            continue;
        }
        match fs::rename(&src, &dst) {
            Ok(()) => stats.renamed += 1,
            Err(e) => {
                warn!("migrate_add_eml_extension: rename {:?} failed: {}", src, e);
                stats.errors += 1;
            }
        }
    }
}

/// Check if a UID exists in the Maildir.
pub fn email_exists(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> bool {
    let dir = cur_path(data_dir, account_id, mailbox);
    find_by_uid(&dir, uid).is_some()
}

/// Parse a full email (headers + body + attachments) from raw bytes.
pub fn parse_full(raw: &[u8], uid: u32) -> Result<ParsedEmail, String> {
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let message_id = get_header(headers, "Message-ID");
    let subject = get_header(headers, "Subject").unwrap_or_default();
    let from = get_header(headers, "From").map(|s| parse_address(&s));
    let to = get_header(headers, "To").map(|s| parse_address_list(&s)).unwrap_or_default();
    let cc = get_header(headers, "Cc").map(|s| parse_address_list(&s)).unwrap_or_default();
    let date = get_header(headers, "Date").unwrap_or_default();
    let in_reply_to = get_header(headers, "In-Reply-To");
    let references = get_header(headers, "References")
        .map(|s| s.split_whitespace().map(String::from).collect());

    let (text, html, attachments) = extract_body_and_attachments(&parsed);

    Ok(ParsedEmail {
        uid,
        message_id,
        subject,
        from,
        to,
        cc,
        date,
        flags: vec![],
        text,
        html,
        attachments,
        in_reply_to,
        references,
    })
}

/// Read and parse a full email by UID.
pub fn read_full(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<ParsedEmail, String> {
    let raw = read_raw(data_dir, account_id, mailbox, uid)?;
    let mut email = parse_full(&raw, uid)?;

    // Extract flags from filename
    let dir = cur_path(data_dir, account_id, mailbox);
    if let Some(path) = find_by_uid(&dir, uid) {
        let fname = path.file_name().unwrap_or_default().to_string_lossy();
        email.flags = extract_flags_from_filename(&fname);
    }
    Ok(email)
}

/// Read and parse a light email (header only) by UID.
pub fn read_light(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32) -> Result<EmailHeader, String> {
    let raw = read_raw(data_dir, account_id, mailbox, uid)?;
    let mut header = parse_header(&raw)?;
    header.uid = uid;

    let dir = cur_path(data_dir, account_id, mailbox);
    if let Some(path) = find_by_uid(&dir, uid) {
        let fname = path.file_name().unwrap_or_default().to_string_lossy();
        header.flags = extract_flags_from_filename(&fname);
    }
    Ok(header)
}

/// Batch read light headers for multiple UIDs.
pub fn read_light_batch(data_dir: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<EmailHeader> {
    uids.iter().filter_map(|&uid| {
        read_light(data_dir, account_id, mailbox, uid).ok()
    }).collect()
}

/// Update flags for an email (renames the file).
pub fn set_flags(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32, flags: &[String]) -> Result<(), String> {
    let dir = cur_path(data_dir, account_id, mailbox);
    let old_path = find_by_uid(&dir, uid)
        .ok_or_else(|| format!("Email UID {} not found", uid))?;

    let new_filename = build_filename(uid, flags);
    let new_path = dir.join(&new_filename);

    if old_path != new_path {
        fs::rename(&old_path, &new_path)
            .map_err(|e| format!("Failed to rename for flag update: {}", e))?;
    }
    Ok(())
}

/// Read a single attachment by index from an email.
pub fn read_attachment(data_dir: &Path, account_id: &str, mailbox: &str, uid: u32, index: usize) -> Result<(String, String, Vec<u8>), String> {
    let raw = read_raw(data_dir, account_id, mailbox, uid)?;
    let parsed = mailparse::parse_mail(&raw)
        .map_err(|e| format!("Failed to parse: {}", e))?;

    let mut att_index = 0;
    for part in parsed.subparts.iter() {
        let disposition = get_header(&part.headers, "Content-Disposition").unwrap_or_default();
        if disposition.starts_with("attachment") || disposition.starts_with("inline") {
            if att_index == index {
                let filename = extract_attachment_filename(part);
                let content_type = get_header(&part.headers, "Content-Type").unwrap_or_else(|| "application/octet-stream".into());
                let body = part.get_body_raw().map_err(|e| format!("Failed to read attachment body: {}", e))?;
                return Ok((filename, content_type, body));
            }
            att_index += 1;
        }
    }
    Err(format!("Attachment index {} not found", index))
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn extract_flags_from_filename(fname: &str) -> Vec<String> {
    let parts: Vec<&str> = fname.splitn(3, ':').collect();
    parts.get(1)
        .map(|f| f.split(',').filter(|s| !s.is_empty()).map(|s| {
            let mut flag = String::from("\\");
            let mut chars = s.chars();
            if let Some(first) = chars.next() {
                flag.push(first.to_uppercase().next().unwrap_or(first));
                flag.extend(chars);
            }
            flag
        }).collect())
        .unwrap_or_default()
}

fn extract_body_and_attachments(parsed: &mailparse::ParsedMail) -> (Option<String>, Option<String>, Vec<Attachment>) {
    let mut text = None;
    let mut html = None;
    let mut attachments = Vec::new();

    if parsed.subparts.is_empty() {
        // Single-part message
        let ct = get_header(&parsed.headers, "Content-Type").unwrap_or_default();
        if let Ok(body) = parsed.get_body() {
            if ct.starts_with("text/html") {
                html = Some(body);
            } else {
                text = Some(body);
            }
        }
    } else {
        for part in &parsed.subparts {
            let ct = get_header(&part.headers, "Content-Type").unwrap_or_default();
            let disposition = get_header(&part.headers, "Content-Disposition").unwrap_or_default();

            if disposition.starts_with("attachment") {
                let filename = extract_attachment_filename(part);
                let size = part.get_body_raw().map(|b| b.len() as u64).unwrap_or(0);
                attachments.push(Attachment {
                    filename,
                    content_type: ct.split(';').next().unwrap_or("application/octet-stream").trim().to_string(),
                    size,
                    content_id: get_header(&part.headers, "Content-ID"),
                });
            } else if ct.starts_with("text/html") && html.is_none() {
                html = part.get_body().ok();
            } else if ct.starts_with("text/plain") && text.is_none() {
                text = part.get_body().ok();
            } else if ct.starts_with("multipart/") {
                // Recurse into nested multipart
                let (t, h, a) = extract_body_and_attachments(part);
                if text.is_none() { text = t; }
                if html.is_none() { html = h; }
                attachments.extend(a);
            }
        }
    }

    (text, html, attachments)
}

fn extract_attachment_filename(part: &mailparse::ParsedMail) -> String {
    // Try Content-Disposition filename
    if let Some(disp) = get_header(&part.headers, "Content-Disposition") {
        if let Some(idx) = disp.find("filename=") {
            let rest = &disp[idx + 9..];
            let name = rest.trim_start_matches('"').split('"').next()
                .or_else(|| rest.split(';').next())
                .unwrap_or("attachment")
                .trim();
            if !name.is_empty() { return name.to_string(); }
        }
    }
    // Try Content-Type name
    if let Some(ct) = get_header(&part.headers, "Content-Type") {
        if let Some(idx) = ct.find("name=") {
            let rest = &ct[idx + 5..];
            let name = rest.trim_start_matches('"').split('"').next()
                .or_else(|| rest.split(';').next())
                .unwrap_or("attachment")
                .trim();
            if !name.is_empty() { return name.to_string(); }
        }
    }
    "attachment".to_string()
}

fn get_header(headers: &[mailparse::MailHeader], name: &str) -> Option<String> {
    headers.iter()
        .find(|h| h.get_key().eq_ignore_ascii_case(name))
        .map(|h| h.get_value().trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_address(s: &str) -> EmailAddress {
    // Simple parse: "Name <email>" or just "email"
    if let Some(start) = s.find('<') {
        if let Some(end) = s.find('>') {
            let addr = s[start + 1..end].trim().to_string();
            let name = s[..start].trim().trim_matches('"').to_string();
            return EmailAddress {
                address: addr,
                name: if name.is_empty() { None } else { Some(name) },
            };
        }
    }
    EmailAddress { address: s.trim().to_string(), name: None }
}

fn parse_address_list(s: &str) -> Vec<EmailAddress> {
    s.split(',').map(|part| parse_address(part.trim())).collect()
}

fn extract_snippet(parsed: &mailparse::ParsedMail) -> Option<String> {
    // Try text body first
    if let Ok(body) = parsed.get_body() {
        let clean: String = body.chars().take(200).collect();
        let trimmed = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    // Try subparts
    for part in &parsed.subparts {
        if let Some(ct) = part.headers.iter().find(|h| h.get_key().eq_ignore_ascii_case("Content-Type")) {
            let val = ct.get_value();
            {
                if val.starts_with("text/plain") {
                    if let Ok(body) = part.get_body() {
                        let clean: String = body.chars().take(200).collect();
                        let trimmed = clean.split_whitespace().collect::<Vec<_>>().join(" ");
                        if !trimmed.is_empty() {
                            return Some(trimmed);
                        }
                    }
                }
            }
        }
    }
    None
}

// ── Vault generation (UIDVALIDITY) ──────────────────────────────────────────
//
// The vault is keyed (account_id, mailbox, uid) and, until this file existed,
// recorded nothing about *which* UID space that uid came from. A mailbox's UID
// space is only meaningful within one UIDVALIDITY generation: when the server
// reissues it — a change-server migration, or a reissue the server does on its
// own — every uid the vault holds names a different message, or no message at
// all. The read still lands on a real file, so nothing errors: `find_by_uid`
// hands back a message that was archived under that number by the *previous*
// server, and every caller that asks "is uid N archived?" gets a yes about
// some other message.
//
// `.uidvalidity` (a sibling of `cur/`, alongside `local-index.json`) records
// the generation the files in `cur/` are keyed under. When it disagrees with
// the server's current UIDVALIDITY, `repair_generation` re-binds what it can
// by Message-ID and moves the rest out of the uid namespace into `orphaned/`.
//
// Nothing here deletes mail. A message that isn't on the new server is exactly
// the message the vault is *for*; it moves to `orphaned/` (still on disk,
// still exportable) rather than being destroyed to reclaim space.

use std::collections::{HashMap, HashSet};
use std::io::Read;

pub const GENERATION_FILE: &str = ".uidvalidity";
pub const ORPHAN_DIR: &str = "orphaned";

/// Two-phase rename marker. A rebind can target a uid that an as-yet-unvisited
/// file still occupies, so every rebind lands on `{final}.regen` first and the
/// whole set is un-suffixed once `cur/` holds no old-generation names.
const REGEN_SUFFIX: &str = ".regen";

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRepair {
    /// False when the stamp already matched — the hot path, one small file read.
    pub ran: bool,
    /// Files re-keyed to the uid the current generation gives their Message-ID.
    pub rebound: Vec<(u32, u32)>,
    /// Old uids moved to `orphaned/` — no Message-ID, or none the server has.
    pub orphaned: Vec<u32>,
    /// Files an earlier repair set aside that this one could bind after all.
    pub recovered: Vec<u32>,
    /// Files whose Message-ID still resolves to the uid they already had, plus
    /// the locally-created ones that were never the server's to renumber.
    pub kept: u32,
    pub errors: u32,
    /// The generation now recorded for this mailbox.
    pub generation: u32,
}

/// Strip the angle brackets and surrounding space so both sides of the join
/// agree. `parse_header` keeps `<...>`; a sidecar written by the frontend may
/// not, and neither side is worth rewriting for this.
pub fn normalize_message_id(raw: &str) -> String {
    raw.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string()
}

/// The header section of an RFC 5322 message — everything before the first
/// blank line, or the whole slice when there isn't one.
fn header_section(bytes: &[u8]) -> &[u8] {
    let end = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 2)
        .or_else(|| bytes.windows(2).position(|w| w == b"\n\n").map(|i| i + 1))
        .unwrap_or(bytes.len());
    &bytes[..end]
}

/// Read just the Message-ID of an `.eml`, without parsing the message.
///
/// Reads at most 128 KiB: this runs once per vault file during a repair, and a
/// full `parse_header` (addresses, snippet extraction, MIME walk) over a
/// 14k-message mailbox is minutes of work to answer one question.
pub fn read_message_id(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    fs::File::open(path).ok()?.take(128 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(header_section(&buf));

    let mut value: Option<String> = None;
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if value.is_some() {
            // Folded continuation — a header line that starts with WSP.
            if line.starts_with(' ') || line.starts_with('\t') {
                value.as_mut().unwrap().push_str(line.trim());
                continue;
            }
            break;
        }
        const KEY: &str = "message-id:";
        // `get`, not a slice: a header line can start mid-way through a
        // multi-byte character once the bytes go through `from_utf8_lossy`, and
        // slicing off a non-boundary panics.
        if matches!(line.get(..KEY.len()), Some(head) if head.eq_ignore_ascii_case(KEY)) {
            value = Some(line[KEY.len()..].trim().to_string());
        }
    }

    let v = value?;
    let inner = match (v.find('<'), v.rfind('>')) {
        (Some(a), Some(b)) if b > a => &v[a + 1..b],
        _ => v.trim(),
    };
    let id = normalize_message_id(inner);
    if id.is_empty() { None } else { Some(id) }
}

/// The generation the files in this mailbox's `cur/` are keyed under, if it was
/// ever recorded. `None` means a vault written before this stamp existed — the
/// caller must verify rather than assume, since that is exactly the vault a
/// reissue may already have silently invalidated.
pub fn read_generation(mailbox_dir: &Path) -> Option<u32> {
    fs::read_to_string(mailbox_dir.join(GENERATION_FILE))
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub fn write_generation(mailbox_dir: &Path, uid_validity: u32) -> Result<(), String> {
    fs::create_dir_all(mailbox_dir).map_err(|e| format!("Failed to create mailbox dir: {}", e))?;
    fs::write(mailbox_dir.join(GENERATION_FILE), uid_validity.to_string())
        .map_err(|e| format!("Failed to write {}: {}", GENERATION_FILE, e))
}

/// Swap the uid on a Maildir filename, leaving the rest — flags, timestamp,
/// `.eml` — exactly as it was. Both shipped filename formats (`{uid}:2,{flags}`
/// and `{uid}:{flags}:{ts}`) put the uid first and a `:` right after it.
fn with_uid(name: &str, new_uid: u32) -> String {
    match name.find(':') {
        Some(i) => format!("{}{}", new_uid, &name[i..]),
        None => new_uid.to_string(),
    }
}

/// Undo `free_orphan_path`'s dedupe suffix, so a recovered file goes back with
/// the `.eml` extension the OS and the zip export need.
fn strip_orphan_suffix(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head.to_string(),
        _ => name.to_string(),
    }
}

/// A free name in `orphaned/` — repeated repairs can orphan the same uid twice.
fn free_orphan_path(orphan_dir: &Path, name: &str) -> PathBuf {
    let direct = orphan_dir.join(name);
    if !direct.exists() {
        return direct;
    }
    for n in 1..1000 {
        let candidate = orphan_dir.join(format!("{}.{}", name, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    orphan_dir.join(format!("{}.dup", name))
}

/// Re-key a mailbox's vault files onto the current UID generation.
///
/// `id_to_uid` maps normalized Message-ID → the uid the *current* generation
/// gives it. It must cover the whole mailbox: a hit is proof a file belongs at
/// that uid, but a miss is only proof of absence if the map was complete to
/// begin with. The caller owns that check — pass a partial map and every
/// unlisted message reads as gone from the server.
///
/// `protected` holds uids the server never issued: messages composed here that
/// live only in the vault. A UID reissue says nothing about them, so they keep
/// their uid and are never moved aside for missing from a server they were
/// never on.
///
/// No-ops when the recorded generation already matches, so this is cheap to
/// call on every mailbox load.
pub fn repair_generation(
    mailbox_dir: &Path,
    current_uid_validity: u32,
    id_to_uid: &HashMap<String, u32>,
    protected: &HashSet<u32>,
) -> GenerationRepair {
    let mut report = GenerationRepair { generation: current_uid_validity, ..Default::default() };

    if read_generation(mailbox_dir) == Some(current_uid_validity) {
        return report;
    }
    report.ran = true;

    let cur = mailbox_dir.join("cur");
    if !cur.exists() {
        if let Err(e) = write_generation(mailbox_dir, current_uid_validity) {
            warn!("repair_generation: {}", e);
            report.errors += 1;
        }
        return report;
    }

    // ── Plan ──
    // A uid is claimed by the first file that resolves to it. Two vault files
    // can carry the same Message-ID (a duplicate archive); only one of them can
    // hold the uid, and the loser is orphaned rather than silently overwriting.
    // Locally-created uids are reserved before anything else can claim them:
    // their files stay where they are, so a rebind must not be handed the same
    // number.
    let mut claimed: HashSet<u32> = protected.clone();
    let mut plan: Vec<(PathBuf, String, u32, Option<u32>)> = Vec::new();

    let entries = match fs::read_dir(&cur) {
        Ok(e) => e,
        Err(e) => {
            warn!("repair_generation: read {:?} failed: {}", cur, e);
            report.errors += 1;
            return report;
        }
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Same heuristic the `.eml` migration uses: a message filename starts
        // with `{uid}:`. Anything else in here is not ours to move.
        let old_uid: u32 = match name.split(':').next().and_then(|s| s.parse().ok()) {
            Some(u) => u,
            None => continue,
        };
        if protected.contains(&old_uid) {
            report.kept += 1;
            continue;
        }
        let new_uid = read_message_id(&entry.path())
            .and_then(|id| id_to_uid.get(&id).copied())
            .filter(|u| claimed.insert(*u));
        plan.push((entry.path(), name, old_uid, new_uid));
    }

    // ── Plan: files an earlier repair set aside get another chance ──
    //
    // "The server does not have this" is only ever as good as the cache that
    // said so. A later generation, read against a fuller cache, can find the
    // message after all — so `orphaned/` is a holding area the repair reads
    // back, not a one-way door. Without this, one repair run against a cache
    // that was complete-looking but stale would set a message aside for good.
    let orphan_dir = mailbox_dir.join(ORPHAN_DIR);
    let mut recover: Vec<(PathBuf, String, u32)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&orphan_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = strip_orphan_suffix(&entry.file_name().to_string_lossy());
            if name.split(':').next().and_then(|s| s.parse::<u32>().ok()).is_none() {
                continue;
            }
            if let Some(nu) = read_message_id(&entry.path())
                .and_then(|id| id_to_uid.get(&id).copied())
                .filter(|u| claimed.insert(*u))
            {
                recover.push((entry.path(), name, nu));
            }
        }
    }

    // ── Apply, phase 1: every file leaves its old-generation name ──
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (path, name, new_uid) in recover {
        let final_name = with_uid(&name, new_uid);
        let tmp = cur.join(format!("{}{}", final_name, REGEN_SUFFIX));
        match fs::rename(&path, &tmp) {
            Ok(()) => {
                staged.push((tmp, cur.join(final_name)));
                report.recovered.push(new_uid);
            }
            Err(e) => {
                warn!("repair_generation: recover {:?} failed: {}", path, e);
                report.errors += 1;
            }
        }
    }
    for (path, name, old_uid, new_uid) in plan {
        match new_uid {
            Some(nu) => {
                let final_name = with_uid(&name, nu);
                let tmp = cur.join(format!("{}{}", final_name, REGEN_SUFFIX));
                match fs::rename(&path, &tmp) {
                    Ok(()) => {
                        staged.push((tmp, cur.join(final_name)));
                        if nu == old_uid {
                            report.kept += 1;
                        } else {
                            report.rebound.push((old_uid, nu));
                        }
                    }
                    Err(e) => {
                        warn!("repair_generation: rebind {:?} failed: {}", path, e);
                        report.errors += 1;
                    }
                }
            }
            None => {
                if let Err(e) = fs::create_dir_all(&orphan_dir) {
                    warn!("repair_generation: mkdir {:?} failed: {}", orphan_dir, e);
                    report.errors += 1;
                    continue;
                }
                let dst = free_orphan_path(&orphan_dir, &name);
                match fs::rename(&path, &dst) {
                    Ok(()) => report.orphaned.push(old_uid),
                    Err(e) => {
                        warn!("repair_generation: orphan {:?} failed: {}", path, e);
                        report.errors += 1;
                    }
                }
            }
        }
    }

    // ── Apply, phase 2: `cur/` holds no old-generation names, so the final
    // names are free ──
    for (tmp, final_path) in staged {
        if let Err(e) = fs::rename(&tmp, &final_path) {
            warn!("repair_generation: unstage {:?} failed: {}", tmp, e);
            report.errors += 1;
        }
    }

    if let Err(e) = write_generation(mailbox_dir, current_uid_validity) {
        warn!("repair_generation: {}", e);
        report.errors += 1;
    }

    info!(
        "repair_generation: {:?} → UIDVALIDITY {} — {} rebound, {} recovered, {} kept, {} orphaned, {} errors",
        mailbox_dir, current_uid_validity, report.rebound.len(), report.recovered.len(),
        report.kept, report.orphaned.len(), report.errors,
    );
    report
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanStats {
    pub count: u64,
    pub bytes: u64,
}

/// Count what a mailbox's repair moved out of the uid namespace.
pub fn orphan_stats(mailbox_dir: &Path) -> OrphanStats {
    let mut stats = OrphanStats::default();
    if let Ok(entries) = fs::read_dir(mailbox_dir.join(ORPHAN_DIR)) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                stats.count += 1;
                stats.bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    stats
}

/// Delete a mailbox's orphan folder. Only ever called for a user who asked —
/// these are messages the current server does not have, so this is the one
/// place in the vault where deleting can lose the last copy.
pub fn purge_orphans(mailbox_dir: &Path) -> Result<u64, String> {
    let dir = mailbox_dir.join(ORPHAN_DIR);
    if !dir.exists() {
        return Ok(0);
    }
    let removed = orphan_stats(mailbox_dir).count;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove {:?}: {}", dir, e))?;
    info!("purge_orphans: removed {} files from {:?}", removed, dir);
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_filename() {
        let name = build_filename(12345, &["\\Seen".into(), "\\Flagged".into()]);
        assert!(name.starts_with("12345:"));
        assert!(name.contains("seen"));
        assert!(name.contains("flagged"));
    }

    #[test]
    fn test_list_uids_empty() {
        let dir = std::env::temp_dir().join("mailvault-test-core-list");
        let uids = list_uids(&dir, "nonexistent", "INBOX");
        assert!(uids.is_empty());
    }

    #[test]
    fn test_store_and_read() {
        let dir = std::env::temp_dir().join("mailvault-test-core-store");
        let _ = fs::remove_dir_all(&dir);

        let raw = b"From: test@example.com\r\nSubject: Hello\r\n\r\nBody text";
        store(&dir, "acc1", "INBOX", 42, raw, &["\\Seen".into()]).unwrap();

        let uids = list_uids(&dir, "acc1", "INBOX");
        assert_eq!(uids, vec![42]);

        let read_back = read_raw(&dir, "acc1", "INBOX", 42).unwrap();
        assert_eq!(read_back, raw);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_header() {
        let raw = b"From: Alice <alice@example.com>\r\nTo: Bob <bob@test.com>\r\nSubject: Hello World\r\nDate: Mon, 1 Apr 2026 10:00:00 +0000\r\nMessage-ID: <msg1@example.com>\r\n\r\nBody here";
        let header = parse_header(raw).unwrap();
        assert_eq!(header.subject, "Hello World");
        assert_eq!(header.from.as_ref().unwrap().address, "alice@example.com");
        assert_eq!(header.message_id, Some("<msg1@example.com>".into()));
    }

    #[test]
    fn test_delete() {
        let dir = std::env::temp_dir().join("mailvault-test-core-delete");
        let _ = fs::remove_dir_all(&dir);

        let raw = b"Subject: Delete me\r\n\r\n";
        store(&dir, "acc1", "INBOX", 99, raw, &[]).unwrap();
        assert_eq!(list_uids(&dir, "acc1", "INBOX").len(), 1);

        delete(&dir, "acc1", "INBOX", 99).unwrap();
        assert!(list_uids(&dir, "acc1", "INBOX").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_build_filename_has_eml_extension() {
        let name = build_filename(7, &["\\Seen".into()]);
        assert!(name.ends_with(".eml"), "got {}", name);
    }

    #[test]
    fn test_migrate_add_eml_extension_renames_and_is_idempotent() {
        let dir = std::env::temp_dir().join("mailvault-test-migrate-eml");
        let _ = fs::remove_dir_all(&dir);

        let cur = dir.join("Maildir").join("acc1").join("INBOX").join("cur");
        fs::create_dir_all(&cur).unwrap();
        // Pre-migration files (no `.eml`) in both filename formats we ship.
        fs::write(cur.join("101:2,S"), b"A").unwrap();
        fs::write(cur.join("102:seen:1700000000"), b"B").unwrap();
        // Already-migrated sibling — must be left alone.
        fs::write(cur.join("103:2,S.eml"), b"C").unwrap();
        // Non-message file — must be left alone.
        fs::write(cur.join("local-index.json"), b"{}").unwrap();

        let s1 = migrate_add_eml_extension(&dir);
        assert_eq!(s1.renamed, 2);
        assert_eq!(s1.already_ok, 1);
        assert_eq!(s1.skipped_non_message, 1);
        assert_eq!(s1.errors, 0);
        assert!(cur.join("101:2,S.eml").exists());
        assert!(cur.join("102:seen:1700000000.eml").exists());
        assert!(cur.join("103:2,S.eml").exists());
        assert!(cur.join("local-index.json").exists());

        // Second run — version marker must short-circuit it.
        let s2 = migrate_add_eml_extension(&dir);
        assert_eq!(s2.renamed, 0);
        assert_eq!(s2.already_ok, 0);

        // Readers still resolve by UID prefix after migration.
        assert!(find_by_uid(&cur, 101).is_some());
        assert!(find_by_uid(&cur, 102).is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_address() {
        let addr = parse_address("Alice Smith <alice@example.com>");
        assert_eq!(addr.address, "alice@example.com");
        assert_eq!(addr.name, Some("Alice Smith".into()));

        let addr2 = parse_address("bob@test.com");
        assert_eq!(addr2.address, "bob@test.com");
        assert!(addr2.name.is_none());
    }

    // ── Vault generation (UIDVALIDITY) ──────────────────────────────────────

    fn eml(message_id: &str, body: &str) -> Vec<u8> {
        format!(
            "From: a@b.test\r\nTo: c@d.test\r\nSubject: s\r\nMessage-ID: <{}>\r\nDate: Mon, 1 Apr 2026 10:00:00 +0000\r\n\r\n{}",
            message_id, body
        ).into_bytes()
    }

    #[test]
    fn test_read_message_id() {
        let dir = std::env::temp_dir().join("mailvault-test-read-msgid");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("plain.eml"), eml("m1@host.test", "body")).unwrap();
        assert_eq!(read_message_id(&dir.join("plain.eml")), Some("m1@host.test".into()));

        // Folded across two lines, and the header name in a casing no server uses.
        fs::write(
            dir.join("folded.eml"),
            b"Subject: s\r\nMESSAGE-id:\r\n <folded@host.test>\r\n\r\nbody".to_vec(),
        ).unwrap();
        assert_eq!(read_message_id(&dir.join("folded.eml")), Some("folded@host.test".into()));

        // LF-only line endings — plenty of .eml files on disk have them.
        fs::write(dir.join("lf.eml"), b"Message-ID: <lf@host.test>\n\nbody".to_vec()).unwrap();
        assert_eq!(read_message_id(&dir.join("lf.eml")), Some("lf@host.test".into()));

        // A Message-ID-less message is the case the read-time guard cannot
        // catch, so it must come back None and be treated as unbindable.
        fs::write(dir.join("none.eml"), b"Subject: s\r\n\r\nbody".to_vec()).unwrap();
        assert_eq!(read_message_id(&dir.join("none.eml")), None);

        // A header line whose first bytes are multi-byte UTF-8. Slicing the
        // prefix off this panics; `get` returns None and moves on.
        fs::write(
            dir.join("utf8.eml"),
            "Subject: \u{4f60}\u{597d}\u{4e16}\u{754c}\r\nMessage-ID: <utf8@host.test>\r\n\r\nbody".as_bytes().to_vec(),
        ).unwrap();
        assert_eq!(read_message_id(&dir.join("utf8.eml")), Some("utf8@host.test".into()));

        // The body must not be searched — a quoted reply carries the parent's
        // Message-ID and would bind the file to the wrong message.
        fs::write(
            dir.join("bodyid.eml"),
            b"Subject: s\r\n\r\nOn Mon someone wrote:\r\nMessage-ID: <quoted@host.test>\r\n".to_vec(),
        ).unwrap();
        assert_eq!(read_message_id(&dir.join("bodyid.eml")), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_rebinds_orphans_and_stamps() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-gen");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // uid 1 and uid 5 both need to move, and 1's new uid is 5 — the
        // collision the two-phase rename exists for.
        fs::write(cur.join("1:2,S.eml"), eml("moved@host.test", "one")).unwrap();
        fs::write(cur.join("5:seen:1700000000.eml"), eml("stays@host.test", "five")).unwrap();
        fs::write(cur.join("9:2,.eml"), eml("gone@host.test", "nine")).unwrap();
        fs::write(cur.join("12:2,.eml"), b"Subject: no id\r\n\r\nbody".to_vec()).unwrap();
        // Not a message — must be left exactly where it is.
        fs::write(cur.join("notes.txt"), b"keep me").unwrap();

        let id_to_uid: HashMap<String, u32> = [
            ("moved@host.test".to_string(), 5u32),
            ("stays@host.test".to_string(), 7u32),
        ].into_iter().collect();

        let r = repair_generation(&mailbox, 605297894, &id_to_uid, &HashSet::new());
        assert!(r.ran);
        assert_eq!(r.errors, 0);
        assert_eq!(r.generation, 605297894);
        assert_eq!(r.rebound.len(), 2);
        assert!(r.rebound.contains(&(1, 5)));
        assert!(r.rebound.contains(&(5, 7)));
        // No Message-ID and no match both mean "cannot prove this is that uid".
        assert_eq!(r.orphaned.len(), 2);
        assert!(r.orphaned.contains(&9));
        assert!(r.orphaned.contains(&12));

        // Flags and timestamp survive the re-key; only the uid changes.
        assert!(cur.join("5:2,S.eml").exists());
        assert!(cur.join("7:seen:1700000000.eml").exists());
        assert!(!cur.join("1:2,S.eml").exists());
        assert!(cur.join("notes.txt").exists());
        // No half-renamed leftovers.
        assert!(fs::read_dir(&cur).unwrap().flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(REGEN_SUFFIX)));

        // The re-keyed file is the one that moved, not the one that was already there.
        assert_eq!(read_message_id(&cur.join("5:2,S.eml")), Some("moved@host.test".into()));

        assert_eq!(orphan_stats(&mailbox).count, 2);
        assert_eq!(read_generation(&mailbox), Some(605297894));

        // Second call with the same generation must not touch the mailbox again.
        let r2 = repair_generation(&mailbox, 605297894, &id_to_uid, &HashSet::new());
        assert!(!r2.ran);
        assert!(r2.rebound.is_empty());

        assert_eq!(purge_orphans(&mailbox).unwrap(), 2);
        assert_eq!(orphan_stats(&mailbox).count, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_duplicate_message_id_keeps_one() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-dupe");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        fs::write(cur.join("1:2,.eml"), eml("dupe@host.test", "first")).unwrap();
        fs::write(cur.join("2:2,.eml"), eml("dupe@host.test", "second")).unwrap();

        let id_to_uid: HashMap<String, u32> =
            [("dupe@host.test".to_string(), 4u32)].into_iter().collect();

        let r = repair_generation(&mailbox, 2, &id_to_uid, &HashSet::new());
        // One uid, one file. The loser is kept, not overwritten.
        assert_eq!(r.rebound.len(), 1);
        assert_eq!(r.orphaned.len(), 1);
        assert_eq!(r.errors, 0);
        assert!(cur.join("4:2,.eml").exists());
        assert_eq!(orphan_stats(&mailbox).count, 1);

        let _ = fs::remove_dir_all(&dir);
    }



    #[test]
    fn test_repair_generation_recovers_an_orphan_a_later_cache_can_place() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-recover");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        fs::write(cur.join("1:2,S.eml"), eml("later@host.test", "one")).unwrap();

        // Generation 2, read against a cache that did not know this message.
        let r1 = repair_generation(&mailbox, 2, &HashMap::new(), &HashSet::new());
        assert_eq!(r1.orphaned, vec![1]);
        assert_eq!(orphan_stats(&mailbox).count, 1);

        // Generation 3, read against a cache that does. "Not on the server" was
        // only ever as good as the cache that said it, so `orphaned/` has to be
        // a holding area the repair reads back.
        let id_to_uid: HashMap<String, u32> =
            [("later@host.test".to_string(), 11u32)].into_iter().collect();
        let r2 = repair_generation(&mailbox, 3, &id_to_uid, &HashSet::new());
        assert_eq!(r2.recovered, vec![11]);
        assert_eq!(r2.errors, 0);
        assert!(cur.join("11:2,S.eml").exists(), "recovered file keeps its .eml name");
        assert_eq!(orphan_stats(&mailbox).count, 0);
        assert_eq!(read_message_id(&cur.join("11:2,S.eml")), Some("later@host.test".into()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_never_orphans_a_locally_created_message() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-protected");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("Sent");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // A message composed here and never accepted by a server. It is in no
        // sidecar and never will be, so the Message-ID join can only miss it.
        fs::write(cur.join("900:2,S.eml"), eml("composed-here@mailvault", "draft")).unwrap();
        fs::write(cur.join("3:2,.eml"), eml("fromserver@host.test", "archived")).unwrap();

        let id_to_uid: HashMap<String, u32> =
            [("fromserver@host.test".to_string(), 900u32)].into_iter().collect();
        let protected: HashSet<u32> = [900u32].into_iter().collect();

        let r = repair_generation(&mailbox, 8, &id_to_uid, &protected);

        // The composed message keeps its uid and its place in the mailbox.
        assert!(cur.join("900:2,S.eml").exists());
        assert_eq!(read_message_id(&cur.join("900:2,S.eml")), Some("composed-here@mailvault".into()));
        assert!(!r.orphaned.contains(&900));

        // Its uid was reserved, so the server message that wanted 900 could not
        // take it — and rather than overwrite, that file is set aside intact.
        assert!(r.rebound.is_empty());
        assert_eq!(r.orphaned, vec![3]);
        assert_eq!(r.errors, 0);
        assert_eq!(orphan_stats(&mailbox).count, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_stamps_an_empty_mailbox_without_scanning() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-empty");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        fs::create_dir_all(&mailbox).unwrap();

        let r = repair_generation(&mailbox, 42, &HashMap::new(), &HashSet::new());
        assert!(r.ran);
        assert_eq!(r.errors, 0);
        assert_eq!(read_generation(&mailbox), Some(42));

        let _ = fs::remove_dir_all(&dir);
    }
}
