//! Contacts index — daemon-owned sender address book.
//!
//! Observes every email header the sync engine writes to cache, extracts
//! from/to/cc/bcc/reply-to addresses, maintains a per-account in-memory map of
//! `address → {name, count, last_seen, folders}`, and persists to
//! `{data_dir}/contacts_index/{account_id}.json` on a debounced schedule.
//!
//! The app queries this index via the `contacts_index.get` RPC instead of
//! walking cached maildir sidecars at compose-open time.

use crate::imap::{EmailAddress, EmailHeader};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

/// A single contact record persisted per account.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContactEntry {
    pub address: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub count: u64,
    #[serde(rename = "lastSeen", default)]
    pub last_seen: i64,
    #[serde(default)]
    pub folders: Vec<String>,
}

/// Deserialization-only subset of the sidecar cache header used by cold-build.
/// Matches the JSON shape `sync_engine::write_tauri_cache` emits (serde rename
/// rules track `imap::EmailHeader`'s Serialize output).
#[derive(Debug, Deserialize, Default)]
struct CachedHeader {
    #[serde(default)]
    from: Option<CachedAddress>,
    #[serde(default)]
    to: Vec<CachedAddress>,
    #[serde(default)]
    cc: Vec<CachedAddress>,
    #[serde(default)]
    bcc: Vec<CachedAddress>,
    #[serde(default, rename = "replyTo")]
    reply_to: Option<CachedAddress>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default, rename = "internalDate")]
    internal_date: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct CachedAddress {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    address: String,
}

impl From<&CachedAddress> for EmailAddress {
    fn from(c: &CachedAddress) -> Self {
        EmailAddress {
            name: c.name.clone(),
            address: c.address.clone(),
        }
    }
}

struct InnerState {
    per_account: HashMap<String, HashMap<String, ContactEntry>>,
    dirty: HashSet<String>,
    loaded_accounts: HashSet<String>,
    cold_built_accounts: HashSet<String>,
}

pub struct ContactsState {
    inner: Mutex<InnerState>,
    data_dir: PathBuf,
}

impl ContactsState {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(InnerState {
                per_account: HashMap::new(),
                dirty: HashSet::new(),
                loaded_accounts: HashSet::new(),
                cold_built_accounts: HashSet::new(),
            }),
            data_dir,
        })
    }

    fn contacts_dir(&self) -> PathBuf {
        self.data_dir.join("contacts_index")
    }

    fn path_for(&self, account_id: &str) -> PathBuf {
        let safe = sanitize(account_id);
        self.contacts_dir().join(format!("{}.json", safe))
    }

    /// Load the persisted index for one account into memory. Idempotent.
    pub fn load_account(&self, account_id: &str) {
        {
            let g = self.inner.lock().unwrap();
            if g.loaded_accounts.contains(account_id) {
                return;
            }
        }

        let path = self.path_for(account_id);
        let mut entries: HashMap<String, ContactEntry> = HashMap::new();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(json) => match serde_json::from_str::<Vec<ContactEntry>>(&json) {
                    Ok(list) => {
                        for e in list {
                            entries.insert(e.address.clone(), e);
                        }
                    }
                    Err(e) => warn!("[contacts_index] parse {}: {}", account_id, e),
                },
                Err(e) => warn!("[contacts_index] read {}: {}", account_id, e),
            }
        }

        let mut g = self.inner.lock().unwrap();
        g.per_account.insert(account_id.to_string(), entries);
        g.loaded_accounts.insert(account_id.to_string());
    }

    /// Update the in-memory index with a batch of new email headers. System
    /// folders (Trash/Junk/Drafts/Archive) are skipped.
    pub fn observe_headers(&self, account_id: &str, mailbox: &str, headers: &[EmailHeader]) {
        if is_excluded_mailbox(mailbox) {
            return;
        }
        if headers.is_empty() {
            return;
        }

        self.load_account(account_id);

        let mut g = self.inner.lock().unwrap();
        let map = g.per_account.entry(account_id.to_string()).or_default();
        for h in headers {
            let date_ms = parse_date_ms(h.date.as_deref().or(h.internal_date.as_deref()));
            ingest_address(map, &h.from, date_ms, mailbox);
            for a in &h.to {
                ingest_address(map, a, date_ms, mailbox);
            }
            for a in &h.cc {
                ingest_address(map, a, date_ms, mailbox);
            }
            for a in &h.bcc {
                ingest_address(map, a, date_ms, mailbox);
            }
            if let Some(rt) = &h.reply_to {
                ingest_address(map, rt, date_ms, mailbox);
            }
        }
        g.dirty.insert(account_id.to_string());
    }

    /// Returns `{account_id → Vec<ContactEntry>}` for the requested accounts.
    pub fn get_snapshot(&self, account_ids: &[String]) -> HashMap<String, Vec<ContactEntry>> {
        // Load + cold-build on first request per account (lazy).
        for aid in account_ids {
            self.load_account(aid);
            let needs_cold_build = {
                let g = self.inner.lock().unwrap();
                let empty = g
                    .per_account
                    .get(aid)
                    .map(|m| m.is_empty())
                    .unwrap_or(true);
                let not_yet = !g.cold_built_accounts.contains(aid);
                empty && not_yet
            };
            if needs_cold_build {
                self.cold_build_account(aid);
            }
        }

        let g = self.inner.lock().unwrap();
        let mut out = HashMap::new();
        for aid in account_ids {
            let entries = g
                .per_account
                .get(aid)
                .map(|m| m.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            out.insert(aid.clone(), entries);
        }
        out
    }

    /// Write every dirty account's index to disk. Called periodically by a
    /// background task.
    pub fn flush_dirty(&self) {
        let to_write: Vec<(String, Vec<ContactEntry>)> = {
            let mut g = self.inner.lock().unwrap();
            if g.dirty.is_empty() {
                return;
            }
            let accounts: Vec<String> = g.dirty.drain().collect();
            accounts
                .into_iter()
                .filter_map(|aid| {
                    g.per_account
                        .get(&aid)
                        .map(|m| (aid, m.values().cloned().collect()))
                })
                .collect()
        };

        if to_write.is_empty() {
            return;
        }
        if let Err(e) = fs::create_dir_all(self.contacts_dir()) {
            warn!("[contacts_index] create dir: {}", e);
            return;
        }
        for (account_id, entries) in to_write {
            let path = self.path_for(&account_id);
            match serde_json::to_string(&entries) {
                Ok(json) => {
                    if let Err(e) = fs::write(&path, json) {
                        warn!("[contacts_index] write {}: {}", path.display(), e);
                    }
                }
                Err(e) => warn!("[contacts_index] serialize {}: {}", account_id, e),
            }
        }
    }

    /// Scan `email_cache/{account_id_sanitized}_*` directories, parse every
    /// `{uid}.json`, and feed through `observe_headers` to seed the index.
    /// Runs once per account lifetime — gated by `cold_built_accounts`.
    pub fn cold_build_account(&self, account_id: &str) {
        {
            let mut g = self.inner.lock().unwrap();
            if g.cold_built_accounts.contains(account_id) {
                return;
            }
            g.cold_built_accounts.insert(account_id.to_string());
        }

        let cache_root = self.data_dir.join("email_cache");
        let read_dir = match fs::read_dir(&cache_root) {
            Ok(r) => r,
            Err(_) => return,
        };

        let prefix = format!("{}_", sanitize(account_id));
        let mut total = 0usize;

        for entry in read_dir.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if !dir_name.starts_with(&prefix) {
                continue;
            }
            let mailbox_part = &dir_name[prefix.len()..];
            let dir_path = entry.path();
            if !dir_path.is_dir() {
                continue;
            }

            let files = match fs::read_dir(&dir_path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let mut batch: Vec<CachedHeader> = Vec::new();
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if name == "_meta.json" || !name.ends_with(".json") {
                    continue;
                }
                match fs::read_to_string(f.path()) {
                    Ok(json) => match serde_json::from_str::<CachedHeader>(&json) {
                        Ok(h) => batch.push(h),
                        Err(_) => continue,
                    },
                    Err(_) => continue,
                }
                if batch.len() >= 200 {
                    self.observe_cached_headers(account_id, mailbox_part, &batch);
                    total += batch.len();
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                total += batch.len();
                self.observe_cached_headers(account_id, mailbox_part, &batch);
            }
        }

        info!(
            "[contacts_index] cold-build complete for {} ({} headers scanned)",
            account_id, total
        );
    }

    fn observe_cached_headers(&self, account_id: &str, mailbox: &str, headers: &[CachedHeader]) {
        if is_excluded_mailbox(mailbox) || headers.is_empty() {
            return;
        }
        self.load_account(account_id);
        let mut g = self.inner.lock().unwrap();
        let map = g.per_account.entry(account_id.to_string()).or_default();
        for h in headers {
            let date_ms = parse_date_ms(h.date.as_deref().or(h.internal_date.as_deref()));
            if let Some(f) = &h.from {
                ingest_address(map, &EmailAddress::from(f), date_ms, mailbox);
            }
            for a in &h.to {
                ingest_address(map, &EmailAddress::from(a), date_ms, mailbox);
            }
            for a in &h.cc {
                ingest_address(map, &EmailAddress::from(a), date_ms, mailbox);
            }
            for a in &h.bcc {
                ingest_address(map, &EmailAddress::from(a), date_ms, mailbox);
            }
            if let Some(rt) = &h.reply_to {
                ingest_address(map, &EmailAddress::from(rt), date_ms, mailbox);
            }
        }
        g.dirty.insert(account_id.to_string());
    }
}

fn sanitize(s: &str) -> String {
    s.replace(|c: char| !c.is_alphanumeric(), "_")
}

fn is_excluded_mailbox(mailbox: &str) -> bool {
    let lower = mailbox.to_lowercase();
    matches!(
        lower.as_str(),
        "trash"
            | "deleted"
            | "deleted items"
            | "deleted messages"
            | "junk"
            | "junk e-mail"
            | "junk email"
            | "spam"
            | "bulk"
            | "drafts"
            | "draft"
            | "archive"
            | "outbox"
            | "templates"
    ) || lower.starts_with("[gmail]/trash")
        || lower.starts_with("[gmail]/spam")
        || lower.starts_with("[gmail]/drafts")
        || lower.starts_with("[gmail]/important")
        || lower.starts_with("[gmail]/all mail")
}

fn ingest_address(
    map: &mut HashMap<String, ContactEntry>,
    addr: &EmailAddress,
    date_ms: i64,
    mailbox: &str,
) {
    let address = addr.address.trim().to_lowercase();
    if address.is_empty() || !address.contains('@') {
        return;
    }
    let name = addr.name.as_deref().unwrap_or("").trim().to_string();
    let entry = map.entry(address.clone()).or_insert_with(|| ContactEntry {
        address: address.clone(),
        ..Default::default()
    });
    entry.count += 1;
    if date_ms > entry.last_seen {
        entry.last_seen = date_ms;
    }
    if !name.is_empty() && entry.name.is_empty() {
        entry.name = name;
    }
    if !entry.folders.iter().any(|m| m == mailbox) {
        entry.folders.push(mailbox.to_string());
    }
}

fn parse_date_ms(date: Option<&str>) -> i64 {
    let s = match date {
        Some(s) if !s.is_empty() => s,
        _ => return 0,
    };
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return t.timestamp_millis();
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc2822(s) {
        return t.timestamp_millis();
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(name: &str, address: &str) -> EmailAddress {
        EmailAddress {
            name: if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            },
            address: address.to_string(),
        }
    }

    fn header(uid: u32, from: EmailAddress, to: Vec<EmailAddress>) -> EmailHeader {
        EmailHeader {
            uid,
            seq: uid,
            display_index: None,
            message_id: Some(format!("<{}@test>", uid)),
            in_reply_to: None,
            references: None,
            subject: "s".into(),
            from,
            to,
            cc: vec![],
            bcc: vec![],
            date: Some("2026-04-21T12:00:00Z".into()),
            internal_date: None,
            flags: vec![],
            size: None,
            has_attachments: false,
            source: None,
            reply_to: None,
            return_path: None,
            authentication_results: None,
            list_unsubscribe: None,
            list_id: None,
            precedence: None,
        }
    }

    #[test]
    fn observe_skips_excluded_mailboxes() {
        let tmp = tempdir();
        let state = ContactsState::new(tmp.clone());
        let h = header(1, addr("Alice", "alice@ex.com"), vec![]);
        state.observe_headers("acc1", "Trash", &[h]);
        let snap = state.get_snapshot(&["acc1".to_string()]);
        assert!(snap["acc1"].is_empty());
    }

    #[test]
    fn observe_collects_and_dedupes() {
        let tmp = tempdir();
        let state = ContactsState::new(tmp.clone());
        let h1 = header(1, addr("Alice", "alice@ex.com"), vec![addr("", "bob@ex.com")]);
        let h2 = header(2, addr("Alice", "ALICE@ex.com"), vec![]);
        state.observe_headers("acc1", "Butcher", &[h1, h2]);
        let snap = state.get_snapshot(&["acc1".to_string()]);
        let entries = &snap["acc1"];
        assert_eq!(entries.len(), 2);
        let alice = entries.iter().find(|e| e.address == "alice@ex.com").unwrap();
        assert_eq!(alice.count, 2);
        assert_eq!(alice.name, "Alice");
        assert_eq!(alice.folders, vec!["Butcher".to_string()]);
    }

    #[test]
    fn flush_and_reload_roundtrip() {
        let tmp = tempdir();
        {
            let state = ContactsState::new(tmp.clone());
            let h = header(1, addr("Alice", "alice@ex.com"), vec![]);
            state.observe_headers("acc1", "INBOX", &[h]);
            state.flush_dirty();
        }
        let state2 = ContactsState::new(tmp.clone());
        state2.load_account("acc1");
        let snap = state2.get_snapshot(&["acc1".to_string()]);
        assert_eq!(snap["acc1"].len(), 1);
        assert_eq!(snap["acc1"][0].address, "alice@ex.com");
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-contacts-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
