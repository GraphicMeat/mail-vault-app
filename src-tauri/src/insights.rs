//! Read-only, local header snapshots. Tauri's sidecars and Maildir are the source
//! of truth here; the daemon uses a different Maildir format.
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

fn error(code: &str) -> Value {
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
    Sidecar(u32),
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
}
impl Snapshot {
    fn new(root: PathBuf, accounts: Vec<String>) -> Self {
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
                    // Repair-generation quarantines cannot be opened through
                    // the active-mailbox reader, so disclose them explicitly.
                    if p.file_name().and_then(|n| n.to_str()) == Some("orphaned") {
                        self.problem("orphanedGeneration", account, None);
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
    fn unchanged(&self) -> bool {
        self.stamps
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
    pub fn start_cleanup(&self) {
        let weak = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
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
    fn begin_at(&self, root: &Path, configured: &[String], account_ids: &[String]) -> ResultValue {
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
        let mut snapshot = inventory(root, configured, accounts)?;
        if !snapshot.unchanged() {
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
    fn read(&self, id: &str, cursor: Option<&str>) -> ResultValue {
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
        if !snapshot.unchanged() {
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
        // Check after reads as well: don't return a mixed page if a writer
        // replaces a file while it is being parsed.
        if !snapshot.unchanged() {
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
    fn release(&self, id: &str) {
        if let Ok(mut snapshots) = self.inner.lock() {
            snapshots.remove(id);
        }
    }
    fn validate_context(&self, id: &str, root: &Path, configured: &[String]) -> Result<(), Value> {
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
    name.split(':')
        .next()?
        .strip_suffix(".eml")
        .unwrap_or(name.split(':').next()?)
        .parse()
        .ok()
}
fn json_file(path: &Path) -> Result<Value, String> {
    serde_json::from_reader(BufReader::new(
        fs::File::open(path).map_err(|_| "unreadableLocation")?,
    ))
    .map_err(|_| "invalidMetadata".into())
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
fn inventory(
    root: PathBuf,
    configured: &[String],
    accounts: Vec<String>,
) -> Result<Snapshot, Value> {
    let mut snapshot = Snapshot::new(root.clone(), accounts.clone());
    snapshot.watch_directory(&root, "");
    let cache_paths = snapshot.children(&root.join("email_cache"), "");
    for account in accounts {
        let mut locations = BTreeMap::new();
        let mailbox_file = root.join("mailboxes").join(&account).join("mailboxes.json");
        if snapshot.watch(&mailbox_file, &account) && mailbox_file.exists() {
            match json_file(&mailbox_file) {
                Ok(v) => {
                    let tree = if v.is_array() {
                        &v
                    } else {
                        v.get("mailboxes")
                            .filter(|a| a.as_array().is_some_and(|a| !a.is_empty()))
                            .or_else(|| v.get("lastKnownGoodMailboxes"))
                            .unwrap_or(&Value::Null)
                    };
                    mailbox_tree(tree, &account, &mut locations);
                    if !tree.is_array() {
                        snapshot.problem("invalidMetadata", &account, None);
                    }
                }
                Err(code) => snapshot.problem(&code, &account, None),
            }
        } else {
            snapshot.problem("mailboxInventoryUnavailable", &account, None);
        }
        let index_root = root.join("maildir").join(&account);
        let index_files = snapshot.walk(&index_root, &account);
        let mut indexes: Vec<(String, PathBuf, Value)> = vec![];
        for path in index_files
            .iter()
            .filter(|p| p.file_name().and_then(|n| n.to_str()) == Some("local-index.json"))
        {
            if !snapshot.watch(path, &account) {
                continue;
            }
            let mailbox = path
                .parent()
                .unwrap()
                .strip_prefix(&index_root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
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
            let parsed = fs::File::open(path)
                .map_err(|_| "unreadableLocation")
                .and_then(|file| {
                    serde_json::from_reader::<_, Vec<CachedHeader>>(BufReader::new(file))
                        .map_err(|_| "invalidMetadata")
                });
            match parsed {
                Ok(rows) => {
                    for row in rows {
                        indexes.push((mailbox.clone(), path.clone(), row.value()));
                    }
                }
                Err(code) => snapshot.problem(code, &account, Some(&mailbox)),
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
                .filter(|l| crate::cache_base_name(&account, &l.mailbox) == base)
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
                let meta_path = path.join("_meta.json");
                let meta = if snapshot.watch(&meta_path, &account) {
                    json_file(&meta_path)
                } else {
                    Err("symlinkSkipped".into())
                };
                match meta {
                    Ok(meta) => {
                        if location.limitation.is_some()
                            && meta.get("accountId").and_then(Value::as_str) == Some(&account)
                        {
                            if let Some(mailbox) = meta
                                .get("mailbox")
                                .and_then(Value::as_str)
                                .filter(|m| crate::cache_base_name(&account, m) == base)
                            {
                                location.mailbox = mailbox.into();
                                location.limitation = None;
                            }
                        }
                        metadata(&mut snapshot, &mut location, &meta);
                    }
                    Err(code) => snapshot.problem(&code, &account, Some(&location.mailbox)),
                }
                for file in snapshot.children(path, &account) {
                    let Some(uid) = file
                        .file_stem()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.parse::<u32>().ok())
                    else {
                        continue;
                    };
                    if file.extension().and_then(|s| s.to_str()) == Some("json") && file.is_file() {
                        snapshot.add(Item {
                            path: file,
                            location: location.clone(),
                            record: Record::Sidecar(uid),
                            source: "server-cache",
                        });
                    }
                }
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
                .filter(|l| crate::sanitize_mailbox_name(&l.mailbox) == local)
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
                    crate::sanitize_mailbox_name(m) == local
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
            if physical.contains(&(crate::sanitize_mailbox_name(&mailbox), uid)) {
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

fn read_header_files(dir: &Path, uids: &[u32]) -> Result<Vec<Value>, String> {
    if uids.len() > PAGE_SIZE {
        return Err("pageTooLarge".into());
    }
    uids.iter()
        .map(|uid| {
            let file =
                fs::File::open(dir.join(format!("{uid}.json"))).map_err(|_| "unreadableHeader")?;
            let row: CachedHeader =
                serde_json::from_reader(BufReader::new(file)).map_err(|_| "unreadableHeader")?;
            if row.uid != *uid {
                return Err("unreadableHeader".into());
            }
            Ok(row.value())
        })
        .collect()
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
        serde_json::to_value(crate::parse_address_str(&get(name).unwrap_or_default())).unwrap()
    };
    let from = addresses("From")
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(json!({"address":"","name":null}));
    let flags =
        crate::parse_flags_from_filename(path.file_name().unwrap().to_str().unwrap_or_default());
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
        Record::Sidecar(uid) => Ok((
            read_header_files(item.path.parent().unwrap(), &[*uid])?.remove(0),
            false,
        )),
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

#[tauri::command]
pub async fn insights_begin_snapshot(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, InsightsSnapshots>,
    account_ids: Vec<String>,
) -> ResultValue {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let configured = crate::read_accounts_json(&app_handle)
            .map_err(|_| error("accountConfigurationUnavailable"))?
            .into_iter()
            .map(|a| a.id)
            .collect::<Vec<_>>();
        // Scope validation occurs before any caller-derived file resolution.
        if account_ids.iter().any(|a| !configured.contains(a)) {
            return Err(error("invalidAccountScope"));
        }
        let root = crate::vault::root(&app_handle).map_err(|_| error("vaultUnavailable"))?;
        state.begin_at(&root, &configured, &account_ids)
    })
    .await
    .map_err(|_| error("snapshotUnavailable"))?
}
#[tauri::command]
pub async fn insights_read_page(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, InsightsSnapshots>,
    snapshot_id: String,
    cursor: Option<String>,
) -> ResultValue {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let configured = crate::read_accounts_json(&app_handle)
            .map_err(|_| error("accountConfigurationUnavailable"))?
            .into_iter()
            .map(|a| a.id)
            .collect::<Vec<_>>();
        let root = crate::vault::root(&app_handle).map_err(|_| error("vaultUnavailable"))?;
        if let Err(e) = state.validate_context(&snapshot_id, &root, &configured) {
            state.release(&snapshot_id);
            return Err(e);
        }
        state.read(&snapshot_id, cursor.as_deref())
    })
    .await
    .map_err(|_| error("snapshotUnavailable"))?
}
#[tauri::command]
pub async fn insights_release_snapshot(
    state: tauri::State<'_, InsightsSnapshots>,
    snapshot_id: String,
) -> Result<(), Value> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || state.release(&snapshot_id))
        .await
        .map_err(|_| error("snapshotUnavailable"))
}
#[cfg(test)]
#[path = "insights_tests.rs"]
mod tests;
