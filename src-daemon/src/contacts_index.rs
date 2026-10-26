//! Contacts index — daemon-owned sender address book.
//!
//! Observes every email header the sync engine writes to cache, extracts
//! from/to/cc/bcc/reply-to addresses, maintains a per-account in-memory map of
//! `address → {name, count, last_seen, folders}`, and persists to the
//! `contacts` table of the vault's `custody.db` on a debounced schedule (it
//! was `{vault}/contacts_index/{account_id}.json`).
//!
//! The store is the daemon's own custody connection, handed over with
//! `attach_db` — `custody.db` is opened EXCLUSIVE, so a second opener in this
//! process would only ever fail BUSY. With no connection attached (the vault
//! is unreachable, or custody would not open) the index still works in
//! memory; it just does not survive the process.
//!
//! The app queries this index via the `contacts_index.get` RPC instead of
//! walking cached maildir sidecars at compose-open time.

use crate::imap::{EmailAddress, EmailHeader};
use mailvault_core::custody::contacts as contacts_db;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use crate::account_lifecycle::{AccountLifecycle, AccountStamp, LocalCommitPermit};
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

fn from_row(row: contacts_db::Row) -> ContactEntry {
    ContactEntry {
        address: row.address,
        name: row.name,
        count: row.count,
        last_seen: row.last_seen,
        folders: serde_json::from_str(&row.folders_json).unwrap_or_default(),
    }
}

fn to_row(entry: &ContactEntry) -> contacts_db::Row {
    contacts_db::Row {
        address: entry.address.clone(),
        name: entry.name.clone(),
        count: entry.count,
        last_seen: entry.last_seen,
        folders_json: serde_json::to_string(&entry.folders).unwrap_or_else(|_| "[]".into()),
    }
}

struct InnerState {
    per_account: HashMap<String, HashMap<String, ContactEntry>>,
    dirty: HashMap<String, AccountStamp>,
    loaded_accounts: HashSet<String>,
    cold_built_accounts: HashSet<String>,
    /// Accounts whose map covers their whole header cache: the store held
    /// their contacts, or the seed read it. Only these are persisted.
    seeded: HashSet<String>,
}

pub struct ContactsState {
    lifecycle: AccountLifecycle,
    inner: Mutex<InnerState>,
    data_dir: PathBuf,
    db: Mutex<Option<Arc<mailvault_core::custody::SharedConn>>>,
}

#[cfg(test)]
fn flush_gates() -> &'static Mutex<HashMap<PathBuf, (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> {
    static GATES: std::sync::OnceLock<Mutex<HashMap<PathBuf, (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>> = std::sync::OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
fn flush_pause(path: &Path) {
    let gate = flush_gates().lock().unwrap().remove(path);
    if let Some((entered, release)) = gate {
        let _ = entered.send(());
        let _ = release.recv_timeout(std::time::Duration::from_secs(5));
    }
}

#[cfg(test)]
fn entry_gates() -> &'static Mutex<HashMap<(PathBuf, &'static str), (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> {
    static GATES: std::sync::OnceLock<Mutex<HashMap<(PathBuf, &'static str), (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>> = std::sync::OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
fn entry_pause(path: &Path, kind: &'static str) {
    let gate = entry_gates().lock().unwrap().remove(&(path.to_path_buf(), kind));
    if let Some((entered, release)) = gate {
        let _ = entered.send(());
        let _ = release.recv_timeout(std::time::Duration::from_secs(5));
    }
}

impl ContactsState {
    pub fn new(data_dir: PathBuf, lifecycle: AccountLifecycle) -> Arc<Self> {
        Arc::new(Self {
            lifecycle,
            inner: Mutex::new(InnerState {
                per_account: HashMap::new(),
                dirty: HashMap::new(),
                loaded_accounts: HashSet::new(),
                cold_built_accounts: HashSet::new(),
                seeded: HashSet::new(),
            }),
            data_dir,
            db: Mutex::new(None),
        })
    }

    /// Hand over the daemon's custody connection. Called once at startup and
    /// again after a vault switch, the same way `sync_engine` gets it.
    pub fn attach_db(&self, db: Arc<mailvault_core::custody::SharedConn>) {
        *self.db.lock().unwrap_or_else(|p| p.into_inner()) = Some(db);
    }

    /// Run `f` against the custody store, or `None` when none is attached.
    /// Times the custody lock like `custody::with_conn` does.
    #[track_caller]
    fn with_db<T>(&self, f: impl FnOnce(&mailvault_core::custody::Connection) -> T) -> Option<T> {
        let attached = self.db.lock().unwrap_or_else(|p| p.into_inner()).clone()?;
        let (caller, asked) = (std::panic::Location::caller(), std::time::Instant::now());
        let guard = attached.lock().unwrap_or_else(|p| p.into_inner());
        let acquired = std::time::Instant::now();
        let result = guard.as_ref().map(f);
        drop(guard);
        crate::custody::note_lock_timing(caller, asked, acquired);
        result
    }

    /// Load the persisted index for one account into memory. Idempotent.
    pub fn load_account(&self, account_id: &str) {
        let Ok(stamp) = self.lifecycle.capture(account_id) else { return };
        #[cfg(test)] entry_pause(&self.data_dir, "load");
        let Ok(permit) = self.lifecycle.try_commit(std::slice::from_ref(&stamp)) else { return };
        self.load_account_owned(account_id, &permit);
    }

    fn load_account_owned(&self, account_id: &str, _permit: &LocalCommitPermit) {
        {
            let g = self.inner.lock().unwrap();
            if g.loaded_accounts.contains(account_id) {
                return;
            }
        }

        let mut entries: HashMap<String, ContactEntry> = HashMap::new();
        self.with_db(|conn| {
            // The pre-SQL file is imported on the first load that finds no
            // rows; `import_legacy` retires it, so this costs one `is_file`
            // afterwards.
            let mut rows = contacts_db::load(conn, account_id);
            if rows.is_empty() {
                contacts_db::import_legacy(conn, &self.data_dir, account_id);
                rows = contacts_db::load(conn, account_id);
            }
            for row in rows {
                entries.insert(row.address.clone(), from_row(row));
            }
        });

        let mut g = self.inner.lock().unwrap();
        // Another thread may have loaded it, and observed into it, meanwhile.
        if g.loaded_accounts.insert(account_id.to_string()) {
            if !entries.is_empty() {
                g.seeded.insert(account_id.to_string());
            }
            g.per_account.insert(account_id.to_string(), entries);
        }
    }

    /// Update the in-memory index with a batch of new email headers. System
    /// folders (Trash/Junk/Drafts/Archive) are skipped.
    pub fn observe_headers(&self, account_id: &str, mailbox: &str, headers: &[EmailHeader]) {
        let Ok(stamp) = self.lifecycle.capture(account_id) else { return };
        let Ok(permit) = self.lifecycle.try_commit(std::slice::from_ref(&stamp)) else { return };
        self.observe_headers_owned(&stamp, &permit, mailbox, headers);
    }

    pub(crate) fn observe_headers_owned(&self, stamp: &AccountStamp, permit: &LocalCommitPermit, mailbox: &str, headers: &[EmailHeader]) {
        let account_id = stamp.id();
        if is_excluded_mailbox(mailbox) {
            return;
        }
        if headers.is_empty() {
            return;
        }

        self.load_account_owned(account_id, permit);

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
        g.dirty.insert(account_id.to_string(), stamp.clone());
    }

    /// Header rows the app cached itself (`save_email_cache`), each new to the
    /// header cache. Before an account is seeded the seed replaces them.
    pub fn observe_saved_rows(&self, account_id: &str, mailbox: &str, rows: &[serde_json::Value]) {
        let Ok(stamp) = self.lifecycle.capture(account_id) else { return };
        let Ok(permit) = self.lifecycle.try_commit(std::slice::from_ref(&stamp)) else { return };
        self.observe_saved_rows_owned(&stamp, &permit, mailbox, rows);
    }

    pub(crate) fn observe_saved_rows_owned(&self, stamp: &AccountStamp, permit: &LocalCommitPermit, mailbox: &str, rows: &[serde_json::Value]) {
        if is_excluded_mailbox(mailbox) || rows.is_empty() {
            return;
        }
        let headers: Vec<CachedHeader> = rows.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
        self.observe_cached_headers_owned(stamp, permit, mailbox, &headers);
    }

    /// Returns `{account_id → Vec<ContactEntry>}` for the requested accounts.
    pub fn get_snapshot(&self, account_ids: &[String]) -> HashMap<String, Vec<ContactEntry>> {
        // Load + cold-build on first request per account (lazy).
        for aid in account_ids {
            let Ok(stamp) = self.lifecycle.capture(aid) else { continue };
            #[cfg(test)] entry_pause(&self.data_dir, "snapshot");
            let Ok(permit) = self.lifecycle.try_commit(std::slice::from_ref(&stamp)) else { continue };
            self.load_account_owned(aid, &permit);
            // Rows a sync or an app save observed first do not count as a
            // seed: the rest of the header cache would never be read.
            let needs_cold_build = {
                let g = self.inner.lock().unwrap();
                !g.seeded.contains(aid) && !g.cold_built_accounts.contains(aid)
            };
            if needs_cold_build {
                self.cold_build_account_owned(&stamp, &permit);
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
        let to_write: Vec<(String, AccountStamp, Vec<ContactEntry>)> = {
            let mut guard = self.inner.lock().unwrap();
            let g = &mut *guard;
            if g.dirty.is_empty() {
                return;
            }
            // An account not seeded yet holds only what was observed so far;
            // stored, it would pass for a seed after a restart.
            let seeded = g.seeded.clone();
            let accounts: Vec<(String, AccountStamp)> = g.dirty.drain().filter(|(a, _)| seeded.contains(a)).collect();
            accounts
                .into_iter()
                .filter_map(|(aid, stamp)| {
                    g.per_account
                        .get(&aid)
                        .map(|m| (aid, stamp, m.values().cloned().collect()))
                })
                .collect()
        };

        if to_write.is_empty() {
            return;
        }
        #[cfg(test)]
        flush_pause(&self.data_dir);
        let mut had_store = false;
        for (account_id, stamp, entries) in &to_write {
            let Ok(_permit) = self.lifecycle.try_commit(std::slice::from_ref(stamp)) else { continue };
            let wrote = self.with_db(|conn| {
                let rows: Vec<contacts_db::Row> = entries.iter().map(to_row).collect();
                if let Err(e) = contacts_db::replace_account(conn, account_id, &rows) {
                    warn!("[contacts_index] write {}: {}", account_id, e);
                }
            }
            );
            had_store |= wrote.is_some();
        }
        if !had_store {
            warn!("[contacts_index] no custody store attached — {} account(s) stay in memory", to_write.len());
        }
    }

    /// Scan `email_cache/{account_id_sanitized}_*` directories, parse every
    /// `{uid}.json`, and feed through `observe_headers` to seed the index.
    /// Runs once per account lifetime — gated by `cold_built_accounts`.
    /// Seed the index from every cached header the account has, once per
    /// account lifetime — gated by `cold_built_accounts`. Reads `custody.db`;
    /// it used to walk `email_cache/<account>_*` and open every `<uid>.json`.
    pub fn cold_build_account(&self, account_id: &str) {
        let Ok(stamp) = self.lifecycle.capture(account_id) else { return };
        let Ok(permit) = self.lifecycle.try_commit(std::slice::from_ref(&stamp)) else { return };
        self.cold_build_account_owned(&stamp, &permit);
    }

    fn cold_build_account_owned(&self, stamp: &AccountStamp, permit: &LocalCommitPermit) {
        let account_id = stamp.id();
        let attached = self.db.lock().unwrap_or_else(|p| p.into_inner()).is_some();
        {
            let mut g = self.inner.lock().unwrap();
            if !g.cold_built_accounts.insert(account_id.to_string()) {
                return;
            }
            // What was observed before the seed is in the header cache the
            // seed reads. A row written between this and the read counts
            // twice, never zero times.
            if attached {
                if let Some(m) = g.per_account.get_mut(account_id) {
                    m.clear();
                }
            }
        }

        let mut total = 0usize;
        let read = self.with_db(|conn| -> Result<Vec<(String, Vec<CachedHeader>)>, String> {
            let mailboxes = mailvault_core::custody::cache::mailboxes_with_headers(conn, Some(account_id))?;
            let mut by_mailbox: Vec<(String, Vec<CachedHeader>)> = Vec::new();
            for (_, mailbox) in mailboxes {
                if is_excluded_mailbox(&mailbox) {
                    continue;
                }
                let headers = mailvault_core::custody::cache::all_headers(conn, account_id, &mailbox)?
                    .into_iter()
                    .filter_map(|v| serde_json::from_value::<CachedHeader>(v).ok())
                    .collect::<Vec<_>>();
                by_mailbox.push((mailbox, headers));
            }
            Ok(by_mailbox)
        });
        // Ingesting takes `inner`, which `with_db` must not be holding when it
        // does — the read above finishes first for that reason.
        match read {
            Some(Ok(by_mailbox)) => {
                for (mailbox, headers) in by_mailbox {
                    total += headers.len();
                    self.observe_cached_headers_owned(stamp, permit, &mailbox, &headers);
                }
                self.inner.lock().unwrap().seeded.insert(account_id.to_string());
            }
            Some(Err(e)) => warn!("[contacts_index] cold-build read failed for {}: {}", account_id, e),
            None => return,
        }

        info!(
            "[contacts_index] cold-build complete for {} ({} headers scanned)",
            account_id, total
        );
    }

    fn observe_cached_headers_owned(&self, stamp: &AccountStamp, permit: &LocalCommitPermit, mailbox: &str, headers: &[CachedHeader]) {
        let account_id = stamp.id();
        if is_excluded_mailbox(mailbox) || headers.is_empty() {
            return;
        }
        self.load_account_owned(account_id, permit);
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
        g.dirty.insert(account_id.to_string(), stamp.clone());
    }
}

#[cfg(test)]
impl ContactsState {
    /// Seed one dirty entry directly, without building a full `EmailHeader`
    /// — for tests outside this module (main.rs) that only care whether
    /// `flush_dirty` is reached, not what it collects.
    pub(crate) fn seed_dirty_for_test(&self, account_id: &str) {
        let mut g = self.inner.lock().unwrap();
        g.per_account.entry(account_id.to_string()).or_default().insert(
            "someone@example.com".to_string(),
            ContactEntry {
                address: "someone@example.com".to_string(),
                ..Default::default()
            },
        );
        if let Ok(stamp) = self.lifecycle.capture(account_id) {
            g.dirty.insert(account_id.to_string(), stamp);
        }
        g.seeded.insert(account_id.to_string());
    }
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

    fn test_state(dir: PathBuf) -> Arc<ContactsState> {
        let lifecycle = AccountLifecycle::default();
        lifecycle.seed(&mailvault_core::accounts_doc::Listing { accounts: vec![serde_json::json!({"id":"acc1"})], version: 0, recovered: None });
        ContactsState::new(dir, lifecycle)
    }

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
            jmap_id: None,
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
            message_date: None,
            received_at: None,
            sent_at: None,
            date: Some("2026-04-21T12:00:00Z".into()),
            internal_date: None,
            flags: vec![],
            size: None,
            has_attachments: false,
            source: None,
            reply_to: None,
            return_path: None,
            authentication_results: None,
            dkim_signature: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            list_id: None,
            precedence: None,
            auto_reply: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p2_delayed_flush_cannot_replace_retired_account() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::server::DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
        std::fs::write(dir.path().join("accounts.json"), r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
        state.account_lifecycle.seed(
            &mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(dir.path())).unwrap(),
        );
        state.contacts.seed_dirty_for_test("a");
        state.contacts.seed_dirty_for_test("b");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        flush_gates().lock().unwrap().insert(state.data_dir.clone(), (entered_tx, release_rx));
        let held = Arc::clone(&state);
        let task = tokio::task::spawn_blocking(move || held.contacts.flush_dirty());
        entered_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("real dirty snapshot created");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        let mut claim = state.account_lifecycle.try_close(lease, "a").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        release_tx.send(()).unwrap();
        task.await.unwrap();
        let (a_rows, b_rows) = crate::custody::with_conn(&state, |conn| Ok((contacts_db::load(conn, "a"), contacts_db::load(conn, "b")))).unwrap();
        assert!(a_rows.is_empty(), "old dirty snapshot replaced retired A contacts: {} rows; B={} rows", a_rows.len(), b_rows.len());
        assert!(!b_rows.is_empty(), "independent B dirty snapshot must persist");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p2_dirty_arriving_after_flush_snapshot_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::server::DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
        std::fs::write(dir.path().join("accounts.json"), r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(dir.path())).unwrap());
        state.contacts.seed_dirty_for_test("a");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        flush_gates().lock().unwrap().insert(state.data_dir.clone(), (entered_tx, release_rx));
        let held = Arc::clone(&state);
        let old = tokio::task::spawn_blocking(move || held.contacts.flush_dirty());
        entered_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("old A snapshot taken");
        state.contacts.seed_dirty_for_test("b");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        let mut claim = state.account_lifecycle.try_close(lease, "a").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        release_tx.send(()).unwrap();
        old.await.unwrap();
        state.contacts.flush_dirty();
        let (a, b) = crate::custody::with_conn(&state, |conn| Ok((contacts_db::load(conn, "a"), contacts_db::load(conn, "b")))).unwrap();
        assert!(a.is_empty(), "old revoked snapshot must not write A");
        assert_eq!(b.len(), 1, "B dirty after old snapshot must survive and write on the next flush");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p2_cold_build_and_legacy_load_keep_original_authority() {
        for kind in ["load", "snapshot"] {
            let dir = tempfile::tempdir().unwrap();
            let state = crate::server::DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
            std::fs::write(dir.path().join("accounts.json"), r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(dir.path())).unwrap());
            let legacy = state.data_dir.join(contacts_db::LEGACY_DIR).join("a.json");
            if kind == "load" {
                std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
                std::fs::write(&legacy, r#"[{"address":"old@example.com","name":"Old","count":1,"lastSeen":1,"folders":["INBOX"]}]"#).unwrap();
            } else {
                crate::custody::with_conn(&state, |conn| mailvault_core::custody::cache::save_headers(conn, "a", "INBOX", r#"{"emails":[{"uid":1,"from":{"address":"old@example.com"},"to":[],"cc":[],"bcc":[]}]}"#)).unwrap();
            }
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            entry_gates().lock().unwrap().insert((state.data_dir.clone(), kind), (entered_tx, release_rx));
            let held = Arc::clone(&state);
            let task = tokio::task::spawn_blocking(move || {
                if kind == "load" { held.contacts.load_account("a"); }
                else { held.contacts.get_snapshot(&["a".into()]); }
            });
            entered_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("original contact load/snapshot captured");
            let lease = crate::account_workflows::AccountLease::detached_for_test(
                crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
            );
            let mut claim = state.account_lifecycle.try_close(lease, "a").unwrap();
            let drained = claim.wait_local_until(tokio::time::Instant::now() + std::time::Duration::from_secs(5)).await.unwrap();
            claim.mark_effects_started(drained).unwrap();
            claim.finish_retired().unwrap();
            release_tx.send(()).unwrap();
            task.await.unwrap();
            let a_rows = crate::custody::with_conn(&state, |conn| Ok(contacts_db::load(conn, "a"))).unwrap();
            assert!(a_rows.is_empty(), "{kind}: retired A contact SQL must stay absent");
            assert!(state.contacts.get_snapshot(&["a".into()])["a"].is_empty(), "{kind}: old contact snapshot must not publish memory");
            if kind == "load" { assert!(legacy.exists(), "{kind}: legacy file must not be consumed"); }
            state.contacts.seed_dirty_for_test("b");
            state.contacts.flush_dirty();
            let b_rows = crate::custody::with_conn(&state, |conn| Ok(contacts_db::load(conn, "b"))).unwrap();
            assert_eq!(b_rows.len(), 1, "{kind}: independent B contact write remains available");
        }
    }

    #[test]
    fn observe_skips_excluded_mailboxes() {
        let tmp = tempdir();
        let state = test_state(tmp.clone());
        let h = header(1, addr("Alice", "alice@ex.com"), vec![]);
        state.observe_headers("acc1", "Trash", &[h]);
        let snap = state.get_snapshot(&["acc1".to_string()]);
        assert!(snap["acc1"].is_empty());
    }

    #[test]
    fn observe_collects_and_dedupes() {
        let tmp = tempdir();
        let state = test_state(tmp.clone());
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
        // The store outlives both states, the way the daemon's custody
        // connection outlives a vault switch.
        let db: Arc<mailvault_core::custody::SharedConn> = Arc::new(std::sync::Mutex::new(Some(
            mailvault_core::custody::db::open(&tmp).unwrap(),
        )));
        {
            let state = test_state(tmp.clone());
            state.attach_db(Arc::clone(&db));
            // seeded first (an empty header cache): only a seeded account is stored
            state.get_snapshot(&["acc1".to_string()]);
            let h = header(1, addr("Alice", "alice@ex.com"), vec![]);
            state.observe_headers("acc1", "INBOX", &[h]);
            state.flush_dirty();
        }
        let state2 = test_state(tmp.clone());
        state2.attach_db(db);
        state2.load_account("acc1");
        let snap = state2.get_snapshot(&["acc1".to_string()]);
        assert_eq!(snap["acc1"].len(), 1);
        assert_eq!(snap["acc1"][0].address, "alice@ex.com");
    }

    /// The seed from the header cache runs for every account the store holds
    /// no contacts for, however many rows a sync or an app save observed
    /// first: those rows are in the header cache too, and the rest of it must
    /// not be lost (a lost name is one privacy mode does not mask).
    #[test]
    fn rows_observed_before_the_first_snapshot_never_block_the_seed() {
        let tmp = tempdir();
        let db: Arc<mailvault_core::custody::SharedConn> = Arc::new(std::sync::Mutex::new(Some(
            mailvault_core::custody::db::open(&tmp).unwrap(),
        )));
        let cache = r#"{"emails":[
            {"uid":1,"date":"2026-04-20T12:00:00Z","from":{"name":"Alice","address":"alice@ex.com"},"to":[],"cc":[],"bcc":[]},
            {"uid":2,"date":"2026-04-21T12:00:00Z","from":{"name":"Bob","address":"bob@ex.com"},"to":[],"cc":[],"bcc":[]}]}"#;
        {
            let g = db.lock().unwrap();
            mailvault_core::custody::cache::save_headers(g.as_ref().unwrap(), "acc1", "INBOX", cache).unwrap();
        }
        let names = |snap: &HashMap<String, Vec<ContactEntry>>| {
            let mut v: Vec<(String, u64)> = snap["acc1"].iter().map(|e| (e.name.clone(), e.count)).collect();
            v.sort();
            v
        };
        let want = vec![("Alice".to_string(), 1), ("Bob".to_string(), 1)];
        {
            let state = test_state(tmp.clone());
            state.attach_db(Arc::clone(&db));
            // the sync observed uid 2 before anyone asked for a snapshot
            state.observe_headers("acc1", "INBOX", &[header(2, addr("Bob", "bob@ex.com"), vec![])]);
            state.flush_dirty();
            // a restart: what the store kept must not stand in for the seed
            let restarted = test_state(tmp.clone());
            restarted.attach_db(Arc::clone(&db));
            assert_eq!(names(&restarted.get_snapshot(&["acc1".to_string()])), want);
            assert_eq!(names(&state.get_snapshot(&["acc1".to_string()])), want);
        }
    }

    /// With no store attached the index still works in memory — it just does
    /// not survive the process, and says so rather than failing a flush.
    #[test]
    fn a_flush_with_no_store_attached_is_not_a_panic() {
        let tmp = tempdir();
        let state = test_state(tmp.clone());
        state.observe_headers("acc1", "INBOX", &[header(1, addr("Alice", "alice@ex.com"), vec![])]);
        state.flush_dirty();
        assert_eq!(state.get_snapshot(&["acc1".to_string()])["acc1"].len(), 1);
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-contacts-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
