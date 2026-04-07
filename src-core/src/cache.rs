//! Email cache operations — header storage, partial loading, metadata.
//!
//! Cache files are stored as JSON at:
//! {data_dir}/cache/{account_id}/{mailbox}/headers.json

use crate::types::EmailHeader;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Cache metadata for delta-sync decisions.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid_validity: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid_next: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highest_modseq: Option<u64>,
    pub total_cached: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_emails: Option<usize>,
}

/// Full cache entry with headers + metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub headers: Vec<EmailHeader>,
    #[serde(flatten)]
    pub meta: CacheMeta,
}

fn cache_dir(data_dir: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    data_dir.join("cache").join(account_id).join(mailbox)
}

fn cache_path(data_dir: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    cache_dir(data_dir, account_id, mailbox).join("headers.json")
}

/// Save email headers to the cache.
pub fn save_headers(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
    headers: &[EmailHeader],
    meta: CacheMeta,
) -> Result<(), String> {
    let dir = cache_dir(data_dir, account_id, mailbox);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;

    let entry = CacheEntry {
        headers: headers.to_vec(),
        meta: CacheMeta {
            total_cached: headers.len(),
            ..meta
        },
    };

    let json = serde_json::to_string(&entry)
        .map_err(|e| format!("Failed to serialize cache: {}", e))?;

    let path = cache_path(data_dir, account_id, mailbox);
    fs::write(&path, json).map_err(|e| format!("Failed to write cache: {}", e))?;

    info!("Cached {} headers for {}/{}", headers.len(), account_id, mailbox);
    Ok(())
}

/// Load cache metadata only (for delta-sync decisions).
pub fn load_meta(data_dir: &Path, account_id: &str, mailbox: &str) -> Option<CacheMeta> {
    let path = cache_path(data_dir, account_id, mailbox);
    let json = fs::read_to_string(&path).ok()?;

    // Parse just the metadata fields without loading all headers
    serde_json::from_str::<CacheMeta>(&json).ok()
}

/// Load the most recent N cached headers.
pub fn load_partial(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
    limit: usize,
) -> Option<CacheEntry> {
    let path = cache_path(data_dir, account_id, mailbox);
    let json = fs::read_to_string(&path).ok()?;

    let mut entry: CacheEntry = serde_json::from_str(&json).ok()?;

    // Return only the most recent N headers
    if entry.headers.len() > limit {
        let start = entry.headers.len() - limit;
        entry.headers = entry.headers[start..].to_vec();
    }

    Some(entry)
}

/// Load full cache (all headers).
pub fn load_full(data_dir: &Path, account_id: &str, mailbox: &str) -> Option<CacheEntry> {
    let path = cache_path(data_dir, account_id, mailbox);
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

/// Load specific UIDs from cache.
pub fn load_by_uids(data_dir: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<EmailHeader> {
    let entry = match load_full(data_dir, account_id, mailbox) {
        Some(e) => e,
        None => return vec![],
    };
    let uid_set: std::collections::HashSet<u32> = uids.iter().copied().collect();
    entry.headers.into_iter().filter(|h| uid_set.contains(&h.uid)).collect()
}

/// Clear the cache for a specific account/mailbox.
pub fn clear(data_dir: &Path, account_id: &str, mailbox: &str) -> Result<(), String> {
    let path = cache_path(data_dir, account_id, mailbox);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to clear cache: {}", e))?;
    }
    Ok(())
}

// ── Mailbox cache (separate from email header cache) ─────────────────────

fn mailbox_cache_path(data_dir: &Path, account_id: &str) -> PathBuf {
    data_dir.join("cache").join(account_id).join("mailboxes.json")
}

/// Save mailbox list to cache.
pub fn save_mailboxes(data_dir: &Path, account_id: &str, mailboxes: &serde_json::Value) -> Result<(), String> {
    let path = mailbox_cache_path(data_dir, account_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }
    let json = serde_json::to_string(mailboxes).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {}", e))
}

/// Load mailbox list from cache.
pub fn load_mailboxes(data_dir: &Path, account_id: &str) -> Option<serde_json::Value> {
    let path = mailbox_cache_path(data_dir, account_id);
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

/// Delete mailbox cache.
pub fn delete_mailbox_cache(data_dir: &Path, account_id: &str) -> Result<(), String> {
    let path = mailbox_cache_path(data_dir, account_id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete: {}", e))?;
    }
    Ok(())
}

// ── Local index (JSON manifest of locally archived emails) ───────────────

fn local_index_path(data_dir: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    data_dir.join("Maildir").join(account_id).join(mailbox).join("local-index.json")
}

/// Read the local email index.
pub fn read_local_index(data_dir: &Path, account_id: &str, mailbox: &str) -> Option<serde_json::Value> {
    let path = local_index_path(data_dir, account_id, mailbox);
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

/// Append entries to the local index.
pub fn append_local_index(data_dir: &Path, account_id: &str, mailbox: &str, entries: &serde_json::Value) -> Result<(), String> {
    let path = local_index_path(data_dir, account_id, mailbox);
    let mut existing: Vec<serde_json::Value> = if path.exists() {
        let json = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        vec![]
    };

    if let Some(arr) = entries.as_array() {
        existing.extend(arr.iter().cloned());
    } else {
        existing.push(entries.clone());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let json = serde_json::to_string(&existing).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {}", e))
}

/// Remove entries from the local index by UID.
pub fn remove_from_local_index(data_dir: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Result<(), String> {
    let path = local_index_path(data_dir, account_id, mailbox);
    if !path.exists() { return Ok(()); }

    let json = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let entries: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap_or_default();

    let uid_set: std::collections::HashSet<u32> = uids.iter().copied().collect();
    let filtered: Vec<_> = entries.into_iter().filter(|e| {
        e.get("uid").and_then(|u| u.as_u64()).map(|u| !uid_set.contains(&(u as u32))).unwrap_or(true)
    }).collect();

    let json = serde_json::to_string(&filtered).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {}", e))
}

// ── Graph ID map cache ───────────────────────────────────────────────────

fn graph_id_map_path(data_dir: &Path, account_id: &str) -> PathBuf {
    data_dir.join("cache").join(account_id).join("graph-id-map.json")
}

/// Save Graph message ID → UID map.
pub fn save_graph_id_map(data_dir: &Path, account_id: &str, map: &serde_json::Value) -> Result<(), String> {
    let path = graph_id_map_path(data_dir, account_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let json = serde_json::to_string(map).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {}", e))
}

/// Load Graph message ID → UID map.
pub fn load_graph_id_map(data_dir: &Path, account_id: &str) -> Option<serde_json::Value> {
    let path = graph_id_map_path(data_dir, account_id);
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::EmailAddress;

    fn sample_headers() -> Vec<EmailHeader> {
        vec![
            EmailHeader {
                uid: 1, message_id: Some("<m1@t>".into()), subject: "Hello".into(),
                from: Some(EmailAddress { address: "a@t.com".into(), name: Some("Alice".into()) }),
                to: vec![], date: "2026-04-01".into(), flags: vec!["\\Seen".into()],
                size: 1024, in_reply_to: None, references: None, snippet: Some("Hi".into()),
            },
            EmailHeader {
                uid: 2, message_id: Some("<m2@t>".into()), subject: "World".into(),
                from: Some(EmailAddress { address: "b@t.com".into(), name: None }),
                to: vec![], date: "2026-04-02".into(), flags: vec![],
                size: 2048, in_reply_to: None, references: None, snippet: None,
            },
        ]
    }

    #[test]
    fn test_save_and_load_partial() {
        let dir = std::env::temp_dir().join("mailvault-test-cache-partial");
        let _ = fs::remove_dir_all(&dir);

        let meta = CacheMeta { uid_validity: Some(1), uid_next: Some(3), highest_modseq: None, total_cached: 0, total_emails: Some(100) };
        save_headers(&dir, "acc1", "INBOX", &sample_headers(), meta).unwrap();

        let entry = load_partial(&dir, "acc1", "INBOX", 1).unwrap();
        assert_eq!(entry.headers.len(), 1);
        assert_eq!(entry.headers[0].uid, 2); // Most recent

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_meta() {
        let dir = std::env::temp_dir().join("mailvault-test-cache-meta");
        let _ = fs::remove_dir_all(&dir);

        let meta = CacheMeta { uid_validity: Some(42), uid_next: Some(100), highest_modseq: Some(999), total_cached: 0, total_emails: Some(50) };
        save_headers(&dir, "acc1", "INBOX", &sample_headers(), meta).unwrap();

        let loaded = load_meta(&dir, "acc1", "INBOX").unwrap();
        assert_eq!(loaded.uid_validity, Some(42));
        assert_eq!(loaded.uid_next, Some(100));
        assert_eq!(loaded.total_cached, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_clear_cache() {
        let dir = std::env::temp_dir().join("mailvault-test-cache-clear");
        let _ = fs::remove_dir_all(&dir);

        save_headers(&dir, "acc1", "INBOX", &sample_headers(), CacheMeta::default()).unwrap();
        assert!(load_meta(&dir, "acc1", "INBOX").is_some());

        clear(&dir, "acc1", "INBOX").unwrap();
        assert!(load_meta(&dir, "acc1", "INBOX").is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
