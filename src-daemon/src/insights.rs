//! Read-only, local header snapshots (Task 3.6: moved from
//! `src-tauri/src/insights.rs` into the daemon). Cached headers and the vault
//! Maildir are the source of truth for the files; custody comes from the
//! store (`<vault>/custody/custody.db`), read in-process now via
//! `crate::custody::with_conn` instead of the Task 2.9b RPC bridge
//! (`custody_entries_for_account`, deleted in Task 3.7 with its last
//! caller).
//!
//! Task 3.7 also deleted the app's copy of this file and its three Tauri
//! commands (`insights_begin_snapshot`/`insights_read_page`/
//! `insights_release_snapshot`), so this is the only implementation left
//! and `handlers::insights` is the only way in.
use crate::handlers::common;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

const PAGE_SIZE: usize = 1000;
const HEADER_LIMIT: u64 = 1024 * 1024;
const EXPIRY: Duration = Duration::from_secs(300);
type ResultValue = Result<Value, Value>;

pub(crate) fn error(code: &str) -> Value {
    json!({"code":code,"message":code})
}

// Unknown JSON fields are skipped by serde while streaming. Cached body and
// attachment properties are never allocated into an Insights header record.
#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct CachedAddress {
    address: String,
    name: Option<String>,
}
#[derive(Default, Serialize)]
struct OriginalDate {
    present: bool,
    value: Option<String>,
}
impl OriginalDate {
    fn absent(&self) -> bool {
        !self.present
    }
}
fn original_date<'de, D: serde::Deserializer<'de>>(d: D) -> Result<OriginalDate, D::Error> {
    Ok(OriginalDate {
        present: true,
        value: Option::<String>::deserialize(d)?,
    })
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct CachedHeader {
    uid: u32,
    #[serde(alias = "message_id")]
    message_id: Option<String>,
    subject: String,
    from: CachedAddress,
    to: Vec<CachedAddress>,
    cc: Vec<CachedAddress>,
    bcc: Vec<CachedAddress>,
    date: Option<String>,
    internal_date: Option<String>,
    received_at: Option<String>,
    sent_at: Option<String>,
    #[serde(
        deserialize_with = "original_date",
        skip_serializing_if = "OriginalDate::absent"
    )]
    message_date: OriginalDate,
    flags: Vec<String>,
    source: Option<String>,
    provider: Option<String>,
    origin: Option<String>,
    #[serde(rename = "_origin")]
    original_source: Option<String>,
    #[serde(rename = "_graphId")]
    graph_id: Option<String>,
    list_id: Option<String>,
    list_unsubscribe: Option<String>,
    precedence: Option<String>,
    server_deleted: bool,
    server_absent: bool,
}
impl CachedHeader {
    fn value(self) -> Value {
        let original = self.message_date.value.clone();
        let present = self.message_date.present;
        let mut v = serde_json::to_value(self).expect("header fields are serializable");
        if present {
            v["messageDate"] = json!(original);
        }
        v
    }
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LegacyCache {
    emails: Vec<CachedHeader>,
    total_emails: Option<u64>,
    uid_validity: Option<u32>,
    last_synced: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    directory: bool,
    /// Unix only. On Windows a stamp is len + mtime alone, which cannot tell a
    /// replaced file from an edited one within the mtime's resolution — the
    /// strong identity needs an open handle per file and the scan does not
    /// open them.
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
fn stamp(path: &Path) -> Result<Option<Stamp>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("unreadableLocation".into()),
    };
    if meta.file_type().is_symlink() {
        return Err("symlinkSkipped".into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(Some(Stamp {
        len: meta.len(),
        modified: meta.modified().ok(),
        directory: meta.is_dir(),
        #[cfg(unix)]
        identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
    }))
}

enum Watch {
    // Headers, indexes, and explicit metadata (including a missing generation
    // marker) must retain their exact identity and contents throughout paging.
    File(Option<Stamp>),
    // The inventory fixes which paths are included. New children belong to the
    // next snapshot; only replacement/removal of an existing directory is stale.
    Directory(Option<Stamp>),
}
impl Watch {
    fn unchanged(&self, current: Option<Stamp>) -> bool {
        match self {
            Self::File(expected) => expected == &current,
            Self::Directory(None) => current.as_ref().is_none_or(|s| s.directory),
            Self::Directory(Some(expected)) => {
                let Some(current) = current else {
                    return false;
                };
                if !expected.directory || !current.directory {
                    return false;
                }
                #[cfg(unix)]
                {
                    (expected.identity.0, expected.identity.1)
                        == (current.identity.0, current.identity.1)
                }
                // Without a stable filesystem identity, remain conservative.
                #[cfg(not(unix))]
                {
                    expected == &current
                }
            }
        }
    }
}

#[derive(Clone)]
struct Location {
    account: String,
    mailbox: String,
    local_mailbox: Option<String>,
    limitation: Option<String>,
    uid_validity: Option<u32>,
    special_use: Option<String>,
}
impl Location {
    fn key(&self) -> (String, String) {
        (self.account.clone(), self.mailbox.clone())
    }
}
#[derive(Default)]
struct Folder {
    cached: usize,
    vault: usize,
    known: Option<u64>,
    synced: Option<String>,
    problem: bool,
}
#[derive(Clone)]
enum Record {
    Stored(Value),
    Eml { uid: u32, index: Option<Value> },
}
#[derive(Clone)]
struct Item {
    path: PathBuf,
    location: Location,
    record: Record,
    source: &'static str,
}
struct Snapshot {
    root: PathBuf,
    accounts: Vec<String>,
    items: Vec<Item>,
    stamps: BTreeMap<PathBuf, Watch>,
    folders: BTreeMap<(String, String), Folder>,
    errors: Vec<Value>,
    warnings: [u64; 4],
    offset: usize,
    cursor: Option<String>,
    finished: bool,
    last_access: Instant,
    updated_at: String,
    /// Task 3.6 Step 4: `custody.db`/`-wal` used to be watched like any other
    /// file (`Watch::File`), which a WAL checkpoint with no real data change
    /// also touches (inventory-backup-insights fact 11), a false staleness
    /// that would restart a 50-RPC LARGE paging sequence for no reason.
    /// In-process in the daemon, `custody::with_conn` bumps a monotonic
    /// counter only when a write actually changed a row
    /// (`Connection::total_changes()` delta); this captures that counter at
    /// inventory time, and `unchanged()` compares it against the live value
    /// on every check.
    custody_gen: u64,
}
impl Snapshot {
    fn new(root: PathBuf, accounts: Vec<String>, custody_gen: u64) -> Self {
        Self {
            root,
            accounts,
            items: vec![],
            stamps: BTreeMap::new(),
            folders: BTreeMap::new(),
            errors: vec![],
            warnings: [0; 4],
            offset: 0,
            cursor: None,
            finished: false,
            last_access: Instant::now(),
            updated_at: Utc::now().to_rfc3339(),
            custody_gen,
        }
    }
    fn problem(&mut self, code: &str, account: &str, mailbox: Option<&str>) {
        if let Some(m) = mailbox {
            self.folders
                .entry((account.into(), m.into()))
                .or_default()
                .problem = true;
        }
        if self.errors.len() < 100 {
            self.errors
                .push(json!({"code":code,"accountId":account,"mailbox":mailbox}));
        }
        if matches!(
            code,
            "unreadableHeader"
                | "unreadableLocation"
                | "invalidMetadata"
                | "headerLimitExceeded"
                | "unterminatedHeaders"
                | "symlinkSkipped"
        ) {
            self.warnings[3] += 1;
        }
    }
    fn watch(&mut self, path: &Path, account: &str) -> bool {
        self.watch_as(path, account, false)
    }
    fn watch_directory(&mut self, path: &Path, account: &str) -> bool {
        self.watch_as(path, account, true)
    }
    fn watch_as(&mut self, path: &Path, account: &str, directory: bool) -> bool {
        for p in path.ancestors().take_while(|p| p.starts_with(&self.root)) {
            let is_directory = directory || p != path;
            if let Some(expected) = self.stamps.get_mut(p) {
                // Explicit file metadata always keeps the stricter guard.
                if !is_directory {
                    if let Watch::Directory(s) = expected {
                        *expected = Watch::File(s.clone());
                    }
                }
                continue;
            }
            match stamp(p) {
                Ok(s) => {
                    self.stamps.insert(
                        p.to_path_buf(),
                        if is_directory {
                            Watch::Directory(s)
                        } else {
                            Watch::File(s)
                        },
                    );
                }
                Err(code) => {
                    self.problem(&code, account, None);
                    return false;
                }
            }
        }
        true
    }
    fn children(&mut self, path: &Path, account: &str) -> Vec<PathBuf> {
        if !self.watch_directory(path, account) || !path.exists() {
            return vec![];
        }
        let entries = match fs::read_dir(path) {
            Ok(e) => e,
            Err(_) => {
                self.problem("unreadableLocation", account, None);
                return vec![];
            }
        };
        let mut paths = vec![];
        for entry in entries {
            match entry {
                Ok(e) => {
                    let p = e.path();
                    // Reject symlinks before traversal. Only source files that
                    // are actually consumed get strict file watches; temporary
                    // downloads and unrelated files cannot stale the snapshot.
                    match stamp(&p) {
                        Ok(Some(s)) => {
                            if !s.directory || self.watch_directory(&p, account) {
                                paths.push(p);
                            }
                        }
                        Ok(None) => {}
                        Err(code) => self.problem(&code, account, None),
                    }
                }
                Err(_) => self.problem("unreadableLocation", account, None),
            }
        }
        paths.sort();
        paths
    }
    fn walk(&mut self, root: &Path, account: &str) -> Vec<PathBuf> {
        let mut files = vec![];
        let mut dirs = vec![root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for p in self.children(&dir, account) {
                if p.is_dir() {
                    let name = p.file_name().and_then(|n| n.to_str());
                    // Repair-generation quarantines cannot be opened through
                    // the active-mailbox reader, so disclose them explicitly.
                    if name == Some("orphaned") {
                        self.problem("orphanedGeneration", account, None);
                    } else if name == Some("tmp") {
                        // In-progress IMAP downloads live here; per
                        // `children`'s own comment, temporary files must
                        // never stale the snapshot. Never calling
                        // `watch_directory` on `tmp/` itself is what makes
                        // that true on every platform: relying on a child
                        // add/remove leaving the directory's own identity
                        // unchanged is a unix inode accident (`Stamp`'s own
                        // doc comment), not a guarantee Windows shares —
                        // there `Watch::Directory::unchanged` falls back to
                        // comparing the whole stamp (len + mtime), and a
                        // directory's mtime does change under a child
                        // add/remove, which flagged the snapshot stale over
                        // activity nothing here ever reads.
                    } else {
                        dirs.push(p);
                    }
                } else {
                    files.push(p);
                }
            }
        }
        files
    }
    fn add(&mut self, item: Item) {
        if !self.watch(&item.path, &item.location.account) {
            return;
        }
        let folder = self.folders.entry(item.location.key()).or_default();
        if item.source == "server-cache" {
            folder.cached += 1;
        } else {
            folder.vault += 1;
        }
        if item.location.limitation.is_some() {
            folder.problem = true;
        }
        self.items.push(item);
    }
    fn coverage(&self, status: Option<&str>) -> Value {
        let folders:Vec<Value>=self.folders.iter().map(|((a,m),f)| {
            let missing=f.known.map(|n|n.saturating_sub(f.cached as u64));
            json!({"accountId":a,"mailbox":m,"cachedHeaders":f.cached,"vaultHeaders":f.vault,"knownServerMessages":f.known,
                "missingHeaders":missing,"lastSyncedAt":f.synced,"status":if f.problem || f.known.is_none() || missing.unwrap_or(0)>0 {"partial"} else {"ready"}})
        }).collect();
        let partial = !self.errors.is_empty() || folders.iter().any(|f| f["status"] == "partial");
        json!({"status":status.unwrap_or(if !self.finished {"reading"} else if partial {"partial"} else {"ready"}),
            "updatedAt":self.updated_at,"folders":folders,"errors":self.errors,
            "warnings":{"unknownDates":self.warnings[0],"fallbackDates":self.warnings[1],"uncertainIdentity":self.warnings[2],"unreadableFiles":self.warnings[3]}})
    }
    fn unchanged(&self, custody_gen: u64) -> bool {
        self.custody_gen == custody_gen
            && self
                .stamps
                .iter()
                .all(|(p, expected)| stamp(p).is_ok_and(|current| expected.unchanged(current)))
    }
}

#[derive(Default, Clone)]
pub struct InsightsSnapshots {
    inner: Arc<Mutex<HashMap<String, Snapshot>>>,
}
impl InsightsSnapshots {
    fn expire(&self, now: Instant) {
        if let Ok(mut snapshots) = self.inner.lock() {
            snapshots.retain(|_, s| now.saturating_duration_since(s.last_access) < EXPIRY);
        }
    }
    /// 30 s sweeper (Task 3.6 Step 2): spawned once from `daemon_main`, not
    /// per-state. Same `EXPIRY` (300s) and the same `Weak`-reference exit
    /// condition as the app's version: the task drops itself once nothing
    /// else holds this `InsightsSnapshots`'s inner map, rather than outliving
    /// it as a leaked background task.
    pub(crate) fn start_cleanup(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                if let Ok(mut snapshots) = inner.lock() {
                    snapshots.retain(|_, s| s.last_access.elapsed() < EXPIRY);
                };
            }
        });
    }
    pub(crate) fn begin_at(
        &self,
        root: &Path,
        custody_rows: CustodyRows<'_>,
        cached_headers: CachedHeaders<'_>,
        configured: &[String],
        account_ids: &[String],
        custody_gen: CustodyGen<'_>,
    ) -> ResultValue {
        self.expire(Instant::now());
        if account_ids.iter().any(|a| {
            !configured.contains(a)
                || a.is_empty()
                || a == "."
                || a == ".."
                || a.contains(['/', '\\'])
        }) {
            return Err(error("invalidAccountScope"));
        }
        let root = fs::canonicalize(root).map_err(|_| error("vaultUnavailable"))?;
        if !root.is_dir() {
            return Err(error("vaultUnavailable"));
        }
        let mut accounts = account_ids.to_vec();
        accounts.sort();
        accounts.dedup();
        // Captured before the walk starts; compared against a FRESH read
        // after it finishes. Reusing the same captured value for both would
        // make this comparison vacuous (it would always equal itself) and
        // miss a write landing mid-walk.
        let before = custody_gen();
        let mut snapshot = inventory(root, custody_rows, cached_headers, configured, accounts, before)?;
        if !snapshot.unchanged(custody_gen()) {
            return Err(
                json!({"code":"snapshotStale","coverage":snapshot.coverage(Some("stale"))}),
            );
        }
        // Even an empty inventory has one final page, so source warnings are
        // handled through the same consumer lifecycle.
        snapshot.last_access = Instant::now();
        let id = uuid::Uuid::new_v4().to_string();
        let result = json!({"snapshotId":id,"inventoryCount":snapshot.items.len(),"coverage":snapshot.coverage(None)});
        self.inner
            .lock()
            .map_err(|_| error("snapshotUnavailable"))?
            .insert(id, snapshot);
        Ok(result)
    }
    pub(crate) fn read(&self, id: &str, cursor: Option<&str>, custody_gen: CustodyGen<'_>) -> ResultValue {
        self.expire(Instant::now());
        let mut snapshots = self
            .inner
            .lock()
            .map_err(|_| error("snapshotUnavailable"))?;
        let snapshot = snapshots
            .get_mut(id)
            .ok_or_else(|| error("snapshotExpired"))?;
        if snapshot.finished || snapshot.cursor.as_deref() != cursor {
            return Err(error("invalidCursor"));
        }
        if !snapshot.unchanged(custody_gen()) {
            let e = json!({"code":"snapshotStale","coverage":snapshot.coverage(Some("stale"))});
            snapshots.remove(id);
            return Err(e);
        }
        let end = (snapshot.offset + PAGE_SIZE).min(snapshot.items.len());
        let mut rows = vec![];
        for index in snapshot.offset..end {
            let item = snapshot.items[index].clone();
            match read_item(&item) {
                Ok((value, mismatch)) => {
                    if mismatch {
                        snapshot.problem(
                            "indexIdentityMismatch",
                            &item.location.account,
                            Some(&item.location.mailbox),
                        );
                    }
                    let row = header_copy(&value, &item.location, item.source);
                    if row["receivedAt"].is_null() && row["sentAt"].is_null() {
                        snapshot.warnings[0] += 1;
                    }
                    if ["received", "sent"].iter().any(|key| {
                        row["dateEvidence"][key]
                            .as_str()
                            .unwrap_or("")
                            .ends_with("fallback")
                    }) {
                        snapshot.warnings[1] += 1;
                    }
                    if row["messageId"].is_null() {
                        snapshot.warnings[2] += 1;
                    }
                    rows.push(row);
                }
                Err(code) => {
                    snapshot.problem(&code, &item.location.account, Some(&item.location.mailbox));
                    let folder = snapshot.folders.get_mut(&item.location.key()).unwrap();
                    if item.source == "server-cache" {
                        folder.cached = folder.cached.saturating_sub(1);
                    } else {
                        folder.vault = folder.vault.saturating_sub(1);
                    }
                }
            }
        }
        // Check after reads as well, against a FRESH generation read (not the
        // value captured above): don't return a mixed page if a writer
        // replaces a file, or lands a custody write, while it is being
        // parsed.
        if !snapshot.unchanged(custody_gen()) {
            let e = json!({"code":"snapshotStale","coverage":snapshot.coverage(Some("stale"))});
            snapshots.remove(id);
            return Err(e);
        }
        snapshot.offset = end;
        snapshot.finished = end == snapshot.items.len();
        snapshot.last_access = Instant::now();
        snapshot.cursor = if snapshot.finished {
            None
        } else {
            Some(uuid::Uuid::new_v4().to_string())
        };
        Ok(json!({"rows":rows,"nextCursor":snapshot.cursor,"coverage":snapshot.coverage(None)}))
    }
    pub(crate) fn release(&self, id: &str) {
        if let Ok(mut snapshots) = self.inner.lock() {
            snapshots.remove(id);
        }
    }
    pub(crate) fn validate_context(&self, id: &str, root: &Path, configured: &[String]) -> Result<(), Value> {
        let snapshots = self
            .inner
            .lock()
            .map_err(|_| error("snapshotUnavailable"))?;
        let snapshot = snapshots.get(id).ok_or_else(|| error("snapshotExpired"))?;
        if fs::canonicalize(root).ok().as_ref() != Some(&snapshot.root)
            || snapshot.accounts.iter().any(|a| !configured.contains(a))
        {
            return Err(error("snapshotStale"));
        }
        Ok(())
    }
}

fn mailbox_tree(value: &Value, account: &str, result: &mut BTreeMap<String, Location>) {
    if let Some(list) = value.as_array() {
        for item in list {
            if let Some(path) = item.get("path").and_then(Value::as_str) {
                result.insert(
                    path.into(),
                    Location {
                        account: account.into(),
                        mailbox: path.into(),
                        local_mailbox: None,
                        limitation: None,
                        uid_validity: None,
                        special_use: item
                            .get("specialUse")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                );
            }
            if let Some(children) = item.get("children") {
                mailbox_tree(children, account, result);
            }
        }
    }
}
fn file_uid(path: &Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    // `mailvault_core::maildir::is_info_sep` accepts BOTH `:` and `;` on every
    // platform (the writer's separator is the platform-conditional one — `;`
    // on Windows, since a colon is illegal in a Win32 filename — but every
    // reader must take either spelling, since a vault written on one OS is
    // routinely read on another). A plain `split(':')` returns the whole
    // filename for a `;`-named file and every uid parse fails silently.
    let head = name.split(mailvault_core::maildir::is_info_sep).next()?;
    head.strip_suffix(".eml").unwrap_or(head).parse().ok()
}
fn metadata(snapshot: &mut Snapshot, location: &mut Location, raw: &Value) {
    location.uid_validity = raw
        .get("uidValidity")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let folder = snapshot.folders.entry(location.key()).or_default();
    folder.known = raw.get("totalEmails").and_then(Value::as_u64);
    folder.synced = raw.get("lastSynced").and_then(date_value);
}
fn date_value(value: &Value) -> Option<String> {
    if let Some(ms) = value.as_i64() {
        return DateTime::<Utc>::from_timestamp_millis(ms)
            .map(|d| d.to_rfc3339_opts(SecondsFormat::Secs, true));
    }
    value.as_str().and_then(normalize_date)
}
/// One account's custody rows, however the caller gets them. Task 3.6: the
/// daemon reads them in-process via `crate::custody::with_conn` +
/// `mailvault_core::custody::entries::entries_for_account`, the same
/// function the Task 2.9b `custody_entries_for_account` bridge route used
/// to call before Task 3.7 deleted it: no second SQL implementation, no
/// RPC bridge.
/// `insights_tests.rs` passes an in-memory stand-in over its own `SharedConn`.
/// An `Err` means "could not read", which is what `unreadableLocation`
/// reports, it is never flattened into "no rows".
pub(crate) type CustodyRows<'a> = &'a dyn Fn(&str) -> Result<Vec<(String, Value)>, String>;

/// The header cache, per account: the stored folder list (`None` when the
/// account has none) plus `(mailbox, {meta..., emails: [...]})` for every
/// mailbox with rows — what `custody::cache::load_mailboxes`/`load_headers`
/// return. Threaded like `CustodyRows` so this file never opens the store
/// itself. It was `mailboxes/<account>/mailboxes.json` plus the
/// `email_cache/<account>_<mailbox>/` directories (`_meta.json` and one
/// `<uid>.json` per message).
pub(crate) type CachedHeaders<'a> =
    &'a dyn Fn(&str) -> Result<(Option<Value>, Vec<(String, Value)>), String>;

/// The daemon's live custody write counter (`crate::custody::generation`),
/// threaded the same way `CustodyRows` is so this file never touches
/// `DaemonState` directly. Called fresh at each freshness checkpoint rather
/// than handed a single frozen value: `begin_at` and `read` each call this
/// twice (before/after a walk or a parse), and a write landing between those
/// two calls must show up as a changed return value, not the same value
/// compared against itself.
pub(crate) type CustodyGen<'a> = &'a dyn Fn() -> u64;

fn inventory(
    root: PathBuf,
    custody_rows_for: CustodyRows<'_>,
    cached_headers_for: CachedHeaders<'_>,
    configured: &[String],
    accounts: Vec<String>,
    custody_gen: u64,
) -> Result<Snapshot, Value> {
    let mut snapshot = Snapshot::new(root.clone(), accounts.clone(), custody_gen);
    snapshot.watch_directory(&root, "");
    // Task 3.6 Step 4: `custody.db`/`-wal` freshness is tracked by
    // `custody_gen` (captured on `Snapshot` above), not by stamping these two
    // files as ordinary watched files: see the `Snapshot::custody_gen` doc.
    let custody_path = root
        .join(mailvault_core::custody::db::DB_DIR)
        .join(mailvault_core::custody::db::DB_FILE);
    // One short read per account, before any walk: stamp-before-read still
    // applies conceptually here: `custody_gen` is captured by the caller
    // (`begin_at`/`read`) before this call runs, so a write landing between
    // that capture and this read is caught on the next freshness check, the
    // same ordering the file-stamp mechanism uses for every other watched
    // path.
    let mut custody_rows: BTreeMap<String, Vec<(String, Value)>> = BTreeMap::new();
    for account in &accounts {
        match custody_rows_for(account) {
            Ok(rows) => {
                custody_rows.insert(account.clone(), rows);
            }
            Err(_) => snapshot.problem("unreadableLocation", account, None),
        }
    }
    let cache_paths = snapshot.children(&root.join("email_cache"), "");
    for account in accounts {
        let mut locations = BTreeMap::new();
        let cached = cached_headers_for(&account);
        let mailbox_list = match &cached {
            Ok((list, _)) => list.clone(),
            Err(_) => None,
        };
        if let Some(v) = mailbox_list {
            let tree = if v.is_array() {
                v.clone()
            } else {
                v.get("mailboxes")
                    .filter(|a| a.as_array().is_some_and(|a| !a.is_empty()))
                    .or_else(|| v.get("lastKnownGoodMailboxes"))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            mailbox_tree(&tree, &account, &mut locations);
            if !tree.is_array() {
                snapshot.problem("invalidMetadata", &account, None);
            }
        } else {
            snapshot.problem("mailboxInventoryUnavailable", &account, None);
        }
        let mut indexes: Vec<(String, PathBuf, Value)> = vec![];
        for (mailbox, row) in custody_rows.remove(&account).unwrap_or_default() {
            locations
                .entry(mailbox.clone())
                .or_insert_with(|| Location {
                    account: account.clone(),
                    mailbox: mailbox.clone(),
                    local_mailbox: None,
                    limitation: None,
                    uid_validity: None,
                    special_use: None,
                });
            match serde_json::from_value::<CachedHeader>(row) {
                Ok(header) => indexes.push((mailbox, custody_path.clone(), header.value())),
                Err(_) => snapshot.problem("invalidMetadata", &account, Some(&mailbox)),
            }
        }
        for location in locations.values() {
            snapshot.folders.entry(location.key()).or_default();
        }
        let prefix = format!("{}_", account.replace(|c: char| !c.is_alphanumeric(), "_"));
        for path in cache_paths.iter().filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
        }) {
            let name = path.file_name().unwrap().to_string_lossy();
            if !path.is_dir() && path.extension().and_then(|n| n.to_str()) != Some("json") {
                continue;
            }
            let base = if path.is_dir() {
                name.to_string()
            } else {
                name.trim_end_matches(".json").to_string()
            };
            if base == mailvault_core::header_cache::cache_base_name(&account, "UNIFIED") {
                continue;
            }
            if !path.is_dir() && root.join("email_cache").join(&base).is_dir() {
                continue;
            }
            let owners = configured
                .iter()
                .filter(|a| {
                    format!("{}_", a.replace(|c: char| !c.is_alphanumeric(), "_")) == prefix
                })
                .count();
            if owners != 1 {
                snapshot.problem("ambiguousAccountLocation", &account, None);
                continue;
            }
            let candidates: Vec<_> = locations
                .values()
                .filter(|l| mailvault_core::header_cache::cache_base_name(&account, &l.mailbox) == base)
                .cloned()
                .collect();
            let mut location = if candidates.len() == 1 {
                candidates[0].clone()
            } else {
                Location {
                    account: account.clone(),
                    mailbox: base.strip_prefix(&prefix).unwrap_or(&base).into(),
                    local_mailbox: None,
                    limitation: Some("server-mailbox-unresolved".into()),
                    uid_validity: None,
                    special_use: None,
                }
            };
            if path.is_dir() {
                // The headers moved into `custody.db` (handled below, per
                // mailbox); all this directory still holds is the Outlook uid
                // ledger, and the walk above already reports anything wrong
                // with reaching it.
                let _ = &mut location;
            } else {
                if !snapshot.watch(path, &account) {
                    continue;
                }
                let parsed = fs::File::open(path)
                    .map_err(|_| "unreadableLocation")
                    .and_then(|f| {
                        serde_json::from_reader::<_, LegacyCache>(BufReader::new(f))
                            .map_err(|_| "invalidMetadata")
                    });
                match parsed {
                    Ok(cache) => {
                        metadata(
                            &mut snapshot,
                            &mut location,
                            &json!({"uidValidity":cache.uid_validity,"totalEmails":cache.total_emails,"lastSynced":cache.last_synced}),
                        );
                        for row in cache.emails {
                            snapshot.add(Item {
                                path: path.clone(),
                                location: location.clone(),
                                record: Record::Stored(row.value()),
                                source: "server-cache",
                            });
                        }
                    }
                    Err(code) => snapshot.problem(code, &account, Some(&location.mailbox)),
                }
            }
        }
        // The header cache itself, from the store. One entry per mailbox that
        // has rows — including mailboxes whose `email_cache/` directory was
        // cleared away, which the directory walk above could never see.
        match cached {
            Ok((_, rows)) => {
                for (mailbox, blob) in rows {
                    // The legacy client-side "all mailboxes" view: its rows
                    // are copies of other mailboxes' and belong to none.
                    if mailbox == "UNIFIED" {
                        continue;
                    }
                    let mut location = locations.get(&mailbox).cloned().unwrap_or(Location {
                        account: account.clone(),
                        mailbox: mailbox.clone(),
                        local_mailbox: None,
                        limitation: Some("server-mailbox-unresolved".into()),
                        uid_validity: None,
                        special_use: None,
                    });
                    metadata(&mut snapshot, &mut location, &blob);
                    let emails = blob.get("emails").and_then(Value::as_array).cloned().unwrap_or_default();
                    for row in emails {
                        match serde_json::from_value::<CachedHeader>(row) {
                            Ok(header) => snapshot.add(Item {
                                path: custody_path.clone(),
                                location: location.clone(),
                                record: Record::Stored(header.value()),
                                source: "server-cache",
                            }),
                            Err(_) => snapshot.problem("invalidMetadata", &account, Some(&mailbox)),
                        }
                    }
                }
            }
            Err(_) => snapshot.problem("unreadableLocation", &account, None),
        }
        let vault_root = root.join("Maildir").join(&account);
        let vault_files = snapshot.walk(&vault_root, &account);
        let mut physical = HashSet::new();
        for path in vault_files.iter().filter(|p| {
            p.parent()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str())
                == Some("cur")
        }) {
            let Some(uid) = file_uid(path) else {
                continue;
            };
            let folder = path.parent().unwrap().parent().unwrap();
            let local = folder
                .strip_prefix(&vault_root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            physical.insert((local.clone(), uid));
            let candidates: Vec<_> = locations
                .values()
                .filter(|l| common::sanitize_mailbox_name(&l.mailbox) == local)
                .cloned()
                .collect();
            let mut location = if candidates.len() == 1 {
                candidates[0].clone()
            } else {
                Location {
                    account: account.clone(),
                    mailbox: local.clone(),
                    local_mailbox: None,
                    limitation: Some("server-mailbox-unresolved".into()),
                    uid_validity: None,
                    special_use: None,
                }
            };
            location.local_mailbox = Some(local.clone());
            let generation = folder.join(mailvault_core::maildir::GENERATION_FILE);
            location.uid_validity = if snapshot.watch(&generation, &account) {
                fs::read_to_string(&generation)
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
            } else {
                None
            };
            let matching: Vec<_> = indexes
                .iter()
                .filter(|(m, _, v)| {
                    common::sanitize_mailbox_name(m) == local
                        && v["uid"].as_u64() == Some(uid as u64)
                })
                .collect();
            let index = if matching.len() == 1 {
                Some(matching[0].2.clone())
            } else {
                None
            };
            snapshot.add(Item {
                path: path.clone(),
                location,
                record: Record::Eml { uid, index },
                source: "vault",
            });
        }
        for (mailbox, path, row) in indexes {
            let Some(uid) = row["uid"].as_u64().and_then(|n| u32::try_from(n).ok()) else {
                snapshot.problem("unreadableHeader", &account, Some(&mailbox));
                continue;
            };
            if physical.contains(&(common::sanitize_mailbox_name(&mailbox), uid)) {
                continue;
            }
            let mut location = locations.get(&mailbox).unwrap().clone();
            location.limitation = Some("vault-file-missing".into());
            snapshot.problem("vaultFileMissing", &account, Some(&mailbox));
            snapshot.add(Item {
                path,
                location,
                record: Record::Stored(row),
                source: "vault",
            });
        }
    }
    Ok(snapshot)
}

fn read_header_block<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut bounded = reader.take(HEADER_LIMIT + 1);
    let mut headers = Vec::new();
    loop {
        let before = headers.len();
        let n = bounded
            .read_until(b'\n', &mut headers)
            .map_err(|_| "unreadableHeader")?;
        if headers.len() as u64 > HEADER_LIMIT {
            return Err("headerLimitExceeded".into());
        }
        if n == 0 {
            return Err("unterminatedHeaders".into());
        }
        if matches!(&headers[before..], b"\n" | b"\r\n") {
            return Ok(headers);
        }
    }
}
fn read_eml(path: &Path, uid: u32) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|_| "unreadableHeader")?;
    let raw = read_header_block(&mut BufReader::new(file))?;
    let (headers, _) = mailparse::parse_headers(&raw).map_err(|_| "unreadableHeader")?;
    let get = |name: &str| {
        headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };
    let addresses = |name: &str| {
        serde_json::to_value(mailvault_core::vault_eml::parse_address_str(&get(name).unwrap_or_default())).unwrap()
    };
    let from = addresses("From")
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(json!({"address":"","name":null}));
    let flags =
        mailvault_core::vault_eml::parse_flags_from_filename(path.file_name().unwrap().to_str().unwrap_or_default());
    let mut value = json!({"uid":uid,"messageId":get("Message-ID"),"subject":get("Subject").unwrap_or_default(),"from":from,
        "to":addresses("To"),"cc":addresses("Cc"),"bcc":addresses("Bcc"),"date":get("Date"),"messageDate":get("Date"),
        "flags":flags,"listId":get("List-Id"),"listUnsubscribe":get("List-Unsubscribe"),"precedence":get("Precedence")});
    if value["messageDate"].is_null() {
        value.as_object_mut().unwrap().remove("messageDate");
    }
    Ok(value)
}
fn read_item(item: &Item) -> Result<(Value, bool), String> {
    match &item.record {
        Record::Stored(value) => Ok((value.clone(), false)),
        Record::Eml { uid, index } => {
            let mut value = read_eml(&item.path, *uid)?;
            if let Some(index) = index {
                if !compatible_header_identity(&value, index) {
                    return Ok((value, true));
                }
                for (key, v) in index.as_object().unwrap() {
                    if key == "flags" {
                        continue;
                    }
                    let old = value.get(key);
                    if old.is_none_or(|v| {
                        v.is_null()
                            || v.as_array().is_some_and(Vec::is_empty)
                            || v.as_str() == Some("")
                    }) {
                        value[key] = v.clone();
                    }
                }
            }
            Ok((value, false))
        }
    }
}
fn normalize_date(raw: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(raw)
        .or_else(|_| DateTime::parse_from_rfc2822(raw))
        .ok()
        .map(|date| {
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        })
}
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}
fn address(value: &Value) -> Value {
    json!({"address":value.get("address").and_then(Value::as_str).unwrap_or(""),"name":value.get("name").and_then(Value::as_str)})
}
fn is_graph_header(raw: &Value) -> bool {
    text(raw, "source").as_deref() == Some("graph")
        || text(raw, "provider").as_deref() == Some("graph")
        || text(raw, "_graphId").is_some()
}
fn normalized_original_date(raw: &Value) -> Option<String> {
    let original = if raw.get("messageDate").is_some() {
        text(raw, "messageDate")
    } else if !is_graph_header(raw) {
        text(raw, "date")
    } else {
        None
    };
    original.as_deref().and_then(normalize_date)
}
fn compatible_header_identity(left: &Value, right: &Value) -> bool {
    let identity = |row: &Value| {
        [
            text(row, "messageId").map(|s| s.trim().to_owned()),
            text(&row["from"], "address").map(|s| s.trim().to_lowercase()),
            normalized_original_date(row),
            text(row, "subject").map(|s| s.trim().to_owned()),
        ]
    };
    identity(left)
        .iter()
        .zip(identity(right))
        .all(|(a, b)| a.as_ref().zip(b.as_ref()).is_none_or(|(a, b)| a == b))
}
fn header_copy(raw: &Value, location: &Location, source: &str) -> Value {
    let graph = is_graph_header(raw);
    let message_date = normalized_original_date(raw);
    let receive = text(raw, "receivedAt")
        .or_else(|| text(raw, "internalDate"))
        .as_deref()
        .and_then(normalize_date);
    let send = text(raw, "sentAt").as_deref().and_then(normalize_date);
    let received = receive.clone().or_else(|| message_date.clone());
    let sent = send
        .clone()
        .or_else(|| message_date.clone())
        .or_else(|| receive.clone());
    let received_evidence = if receive.is_some() {
        if graph {
            "graph-received"
        } else {
            "imap-internaldate"
        }
    } else if message_date.is_some() {
        "rfc-date-fallback"
    } else {
        "unknown"
    };
    let sent_evidence = if send.is_some() && graph {
        "graph-sent"
    } else if message_date.is_some() {
        "rfc-date"
    } else if send.is_some() {
        "provider-sent"
    } else if receive.is_some() {
        "receive-time-fallback"
    } else {
        "unknown"
    };
    let addrs = |name: &str| {
        raw.get(name)
            .and_then(Value::as_array)
            .map(|a| a.iter().map(address).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let origin = text(raw, "origin")
        .or_else(|| text(raw, "_origin"))
        .or_else(|| text(raw, "source").filter(|s| s.starts_with("local")));
    json!({"accountId":location.account,"mailbox":location.mailbox,"uid":raw["uid"],"uidValidity":location.uid_validity,
        "source":source,"origin":origin,"messageId":text(raw,"messageId"),"from":address(&raw["from"]),"to":addrs("to"),"cc":addrs("cc"),"bcc":addrs("bcc"),
        "subject":text(raw,"subject").unwrap_or_default(),"messageDate":message_date,"receivedAt":received,"sentAt":sent,
        "dateEvidence":{"received":received_evidence,"sent":sent_evidence},"flags":raw.get("flags").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default(),
        "specialUse":location.special_use,"listId":text(raw,"listId"),"listUnsubscribe":text(raw,"listUnsubscribe"),"precedence":text(raw,"precedence"),
        "serverDeleted":raw["serverDeleted"].as_bool().unwrap_or(false),"serverAbsent":raw["serverAbsent"].as_bool().unwrap_or(false),
        "localMailbox":location.local_mailbox,"serverMailbox":if location.limitation.is_none() {Some(&location.mailbox)} else {None},"locationLimitation":location.limitation})
}

#[cfg(test)]
#[path = "insights_tests.rs"]
mod tests;
