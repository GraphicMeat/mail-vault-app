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
}
