//! One header cache — sidecars, `_meta.json`, mailbox cache — shared by the
//! app's cache commands and the daemon's sync engine (plan Task 2.3,
//! `inventory-cache.md` §1 rows 3-9, 13-15). Bodies ported verbatim from
//! `src-tauri/src/main.rs` (root parameter replacing `vault::root(app)?`)
//! apart from: every write now goes through `fsx::write_atomic` (was plain
//! `fs::write`, oddity: torn reads on a concurrent writer); the account-clear
//! prefix match requires a `_` separator so clearing `acc1` cannot also delete
//! `acc10`'s cache (oddity 1); and every uid-from-filename parse goes through
//! `is_header_file`, which fixes the daemon's old counter treating
//! `graph_id_map.json` as a message (oddity 3).
//!
//! Locking: one `RwLock` per vault root and one `Mutex` per (root, mailbox
//! base name), both lazily created in a process-wide registry. `save` and
//! `patch_flags` — and the daemon's `write_headers` / `write_cache_meta*` /
//! `patch_sidecar_flags` / `prune_sidecars` — take the root's tree lock for
//! `read` (so writers to different mailboxes never block each other) plus
//! their own mailbox lock; `clear` takes the tree lock for `write`, which
//! blocks every mailbox writer until it finishes. Order is always tree before
//! mailbox, and neither is ever held across an `.await` or network I/O — a
//! caller that has to fetch first (the sync engine) does that, then calls in
//! here to write.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use tracing::info;

use crate::fsx::write_atomic;
use crate::graph_ledger::LEDGER_FILE as GRAPH_ID_MAP_FILE;

// ── Naming ────────────────────────────────────────────────────────────────

/// Sanitized `<account>_<mailbox>` cache directory name. The one copy: the
/// app (`main.rs`), the daemon (`sync_engine.rs`) and the repair inputs
/// (`vault_files.rs`) each carried their own identical copy before this task.
pub fn cache_base_name(account_id: &str, mailbox: &str) -> String {
    format!(
        "{}_{}",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
        mailbox.replace(|c: char| !c.is_alphanumeric(), "_"),
    )
}

/// `{root}/email_cache/{cache_base_name(account, mailbox)}`.
pub fn sidecar_dir(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    root.join("email_cache").join(cache_base_name(account_id, mailbox))
}

/// `name` is a header sidecar (`<uid>.json`, uid fitting a `u32`) iff this
/// returns its uid. Neither `_meta.json` nor `graph_id_map.json` parses, so
/// every counter and lister built on this excludes both without a
/// name-literal special case.
pub fn is_header_file(name: &str) -> Option<u32> {
    name.strip_suffix(".json")?.parse::<u32>().ok()
}

// ── Locks ─────────────────────────────────────────────────────────────────

// ponytail: neither registry ever evicts an entry — a process opens a bounded
// number of distinct (root, mailbox) pairs in its lifetime (thousands at
// most), so this costs a Arc<Lock<()>> per mailbox ever touched, not per
// call. Add eviction if a long-lived daemon ever visits enough distinct vault
// roots for that to matter.
static TREE_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<RwLock<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MAILBOX_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One `RwLock` per vault root. A mailbox writer takes it for `read` (so
/// writers to different mailboxes never block each other); `clear` takes it
/// for `write` to have the whole `email_cache` tree to itself.
pub fn lock_tree(root: &Path) -> Arc<RwLock<()>> {
    TREE_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}

/// One `Mutex` per (root, mailbox base name): serializes writers to a single
/// mailbox's sidecars. Callers take the root's tree lock (`read`) first.
pub fn lock_mailbox(root: &Path, base: &str) -> Arc<Mutex<()>> {
    let key = root.join(base);
    MAILBOX_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// ── Save / load headers ──────────────────────────────────────────────────

/// Save a batch of headers plus meta, as the app's `save_email_cache` command
/// receives it: `data` is `{ emails: [...], totalEmails, uidValidity, uidNext,
/// highestModseq, lastSynced, removedUids: [...] }`. A meta key the caller
/// doesn't send (or sends `null`) is left as it was on disk — most callers
/// pass only `(emails, totalEmails)`, and writing their missing
/// `uidNext`/`uidValidity` as null would wipe the sync metadata the delta-sync
/// path depends on.
pub fn save(root: &Path, account_id: &str, mailbox: &str, data: &str) -> Result<(), String> {
    let base_name = cache_base_name(account_id, mailbox);
    let dir = sidecar_dir(root, account_id, mailbox);

    let parsed: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("Failed to parse cache JSON: {}", e))?;

    // `create_dir_all` has to be inside the lock, not before it: a `clear`
    // between this creating the directory and the write below would remove
    // it out from under an in-flight save (this raced in testing before the
    // fix — the ENOENT it produced is the RED this test proves is fixed).
    let tree = lock_tree(root);
    let _tree_read = tree.read().unwrap_or_else(|e| e.into_inner());
    let mbox = lock_mailbox(root, &base_name);
    let _mbox_lock = mbox.lock().unwrap_or_else(|e| e.into_inner());

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sidecar directory: {}", e))?;

    let meta_path = dir.join("_meta.json");
    let mut meta = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = meta.as_object_mut() {
        for key in ["totalEmails", "uidValidity", "uidNext", "highestModseq", "lastSynced"] {
            match parsed.get(key) {
                Some(v) if !v.is_null() => {
                    obj.insert(key.to_string(), v.clone());
                }
                _ => {}
            }
        }
    }
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| format!("save_email_cache: failed to serialize _meta.json: {}", e))?;
    write_atomic(&meta_path, meta_json.as_bytes())
        .map_err(|e| format!("save_email_cache: failed to write _meta.json: {}", e))?;

    if let Some(emails) = parsed.get("emails").and_then(|e| e.as_array()) {
        let mut written = 0usize;
        for email in emails {
            if let Some(uid) = email.get("uid").and_then(|u| u.as_u64()) {
                let email_json = serde_json::to_string(email)
                    .map_err(|e| format!("save_email_cache: failed to serialize email {}: {}", uid, e))?;
                write_atomic(&dir.join(format!("{}.json", uid)), email_json.as_bytes())
                    .map_err(|e| format!("save_email_cache: failed to write email {}: {}", uid, e))?;
                written += 1;
            }
        }
        info!("Email cache saved: {} files in {}", written, base_name);
    }

    // Remove only UIDs the caller explicitly says are gone (not every sidecar
    // absent from `emails` — the store holds ~500 headers while the cache
    // holds the whole mailbox).
    if let Some(removed) = parsed.get("removedUids").and_then(|v| v.as_array()) {
        let mut deleted = 0usize;
        for uid in removed.iter().filter_map(|v| v.as_u64()) {
            if fs::remove_file(dir.join(format!("{}.json", uid))).is_ok() {
                deleted += 1;
            }
        }
        if deleted > 0 {
            info!("Email cache: removed {} expunged sidecars in {}", deleted, base_name);
        }
    }

    let old_monolithic = root.join("email_cache").join(format!("{}.json", base_name));
    if old_monolithic.exists() {
        let _ = fs::remove_file(&old_monolithic);
        info!("Removed old monolithic cache file: {:?}", old_monolithic);
    }

    Ok(())
}

/// Read and parse the named sidecars, skipping any that are missing or corrupt.
fn read_sidecars(dir: &Path, uids: &[u64]) -> Vec<serde_json::Value> {
    let mut emails = Vec::with_capacity(uids.len());
    for uid in uids {
        let path = dir.join(format!("{}.json", uid));
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(email) = serde_json::from_str(&data) {
                emails.push(email);
            }
        }
    }
    emails
}

/// A cached header's received time in epoch milliseconds, or `i64::MIN` when
/// it carries no date we can parse. Undated rows sort last: a header we can't
/// place in time must never displace one we can.
fn header_date_ms(email: &serde_json::Value) -> i64 {
    ["internalDate", "date"]
        .iter()
        .filter_map(|key| email.get(*key).and_then(|v| v.as_str()))
        .find_map(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .or_else(|_| chrono::DateTime::parse_from_rfc2822(s))
                .map(|d| d.timestamp_millis())
                .ok()
        })
        .unwrap_or(i64::MIN)
}

fn header_uid(email: &serde_json::Value) -> u64 {
    email.get("uid").and_then(|u| u.as_u64()).unwrap_or(0)
}

/// Read `limit` sidecars' worth of the newest cached headers, or all of them
/// when `limit` is `None`.
///
/// "Newest" is the N highest UIDs for IMAP, where the server issues UIDs in
/// arrival order. Graph offers no such guarantee (its listing runs newest
/// first but the seed hands out uids in an order that doesn't track age), so
/// those mailboxes sort by header date instead; `graph_id_map.json`'s
/// presence is the marker; it's written by the same allocator that hands out
/// those uids.
fn load_from_sidecars(dir: &Path, meta_file: &Path, limit: Option<usize>) -> Result<Option<String>, String> {
    let meta_data =
        fs::read_to_string(meta_file).map_err(|e| format!("Failed to read _meta.json: {}", e))?;
    let meta: serde_json::Value =
        serde_json::from_str(&meta_data).map_err(|e| format!("Failed to parse _meta.json: {}", e))?;

    let mut uids: Vec<u64> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(uid) = is_header_file(&name) {
                uids.push(uid as u64);
            }
        }
    }

    let total_cached = uids.len();
    let uid_tracks_arrival = !dir.join(GRAPH_ID_MAP_FILE).exists();

    let emails: Vec<serde_json::Value> = if uid_tracks_arrival {
        uids.sort_unstable_by(|a, b| b.cmp(a));
        if let Some(limit) = limit {
            uids.truncate(limit);
        }
        read_sidecars(dir, &uids)
    } else {
        // ponytail: every sidecar in the mailbox is read to sort by date; the
        // upgrade path is indexing uid -> date in `_meta.json` so this can sort
        // without opening a file per message.
        let mut all = read_sidecars(dir, &uids);
        all.sort_by(|a, b| {
            header_date_ms(b)
                .cmp(&header_date_ms(a))
                .then_with(|| header_uid(b).cmp(&header_uid(a)))
        });
        if let Some(limit) = limit {
            all.truncate(limit);
        }
        all
    };

    info!(
        "Sidecar cache loaded: {} of {} emails (limit: {:?}, order: {})",
        emails.len(),
        total_cached,
        limit,
        if uid_tracks_arrival { "uid" } else { "date" }
    );

    let result = serde_json::json!({
        "emails": emails,
        "totalEmails": meta.get("totalEmails"),
        "totalCached": total_cached,
        "uidValidity": meta.get("uidValidity"),
        "uidNext": meta.get("uidNext"),
        "highestModseq": meta.get("highestModseq"),
        "lastSynced": meta.get("lastSynced")
    });

    serde_json::to_string(&result)
        .map(Some)
        .map_err(|e| format!("Failed to serialize sidecar cache: {}", e))
}

pub fn load(root: &Path, account_id: &str, mailbox: &str) -> Result<Option<String>, String> {
    let base_dir = root.join("email_cache");
    let base_name = cache_base_name(account_id, mailbox);
    let dir = base_dir.join(&base_name);
    let meta_file = dir.join("_meta.json");

    if meta_file.exists() {
        return load_from_sidecars(&dir, &meta_file, None);
    }

    let old_file = base_dir.join(format!("{}.json", base_name));
    if old_file.exists() {
        info!("Loading from old monolithic cache: {:?}", old_file);
        let data =
            fs::read_to_string(&old_file).map_err(|e| format!("Failed to read cache file: {}", e))?;
        return Ok(Some(data));
    }

    Ok(None)
}

/// Load only the N most recent emails from sidecar cache (fast initial display).
pub fn load_partial(
    root: &Path,
    account_id: &str,
    mailbox: &str,
    limit: usize,
) -> Result<Option<String>, String> {
    let base_dir = root.join("email_cache");
    let base_name = cache_base_name(account_id, mailbox);
    let dir = base_dir.join(&base_name);
    let meta_file = dir.join("_meta.json");

    if meta_file.exists() {
        return load_from_sidecars(&dir, &meta_file, Some(limit));
    }

    let old_file = base_dir.join(format!("{}.json", base_name));
    if old_file.exists() {
        info!("Partial load falling back to monolithic: {:?}", old_file);
        let data =
            fs::read_to_string(&old_file).map_err(|e| format!("Failed to read cache file: {}", e))?;
        let mut parsed: serde_json::Value =
            serde_json::from_str(&data).map_err(|e| format!("Failed to parse cache JSON: {}", e))?;

        let total_cached = parsed
            .get("emails")
            .and_then(|e| e.as_array())
            .map(|a| a.len())
            .unwrap_or(0);

        if let Some(emails) = parsed.get_mut("emails").and_then(|e| e.as_array_mut()) {
            if emails.len() > limit {
                emails.truncate(limit);
            }
        }
        parsed
            .as_object_mut()
            .map(|o| o.insert("totalCached".to_string(), serde_json::json!(total_cached)));

        let result = serde_json::to_string(&parsed).map_err(|e| format!("Failed to serialize: {}", e))?;
        return Ok(Some(result));
    }

    Ok(None)
}

/// Load only cache metadata (no emails) — fast, for delta-sync parameters.
pub fn load_meta(root: &Path, account_id: &str, mailbox: &str) -> Result<Option<String>, String> {
    let base_dir = root.join("email_cache");
    let base_name = cache_base_name(account_id, mailbox);
    let dir = base_dir.join(&base_name);
    let meta_file = dir.join("_meta.json");

    if meta_file.exists() {
        let meta_data =
            fs::read_to_string(&meta_file).map_err(|e| format!("Failed to read _meta.json: {}", e))?;
        let mut meta: serde_json::Value =
            serde_json::from_str(&meta_data).map_err(|e| format!("Failed to parse _meta.json: {}", e))?;

        // Count message sidecars only — `_meta.json` and `graph_id_map.json`
        // sit in the same directory and are not messages.
        let total_cached = fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| is_header_file(&e.file_name().to_string_lossy()).is_some())
                    .count()
            })
            .unwrap_or(0);

        meta.as_object_mut()
            .map(|o| o.insert("totalCached".to_string(), serde_json::json!(total_cached)));

        return serde_json::to_string(&meta)
            .map(Some)
            .map_err(|e| format!("Failed to serialize: {}", e));
    }

    let old_file = base_dir.join(format!("{}.json", base_name));
    if old_file.exists() {
        let data =
            fs::read_to_string(&old_file).map_err(|e| format!("Failed to read cache file: {}", e))?;
        let parsed: serde_json::Value =
            serde_json::from_str(&data).map_err(|e| format!("Failed to parse cache JSON: {}", e))?;
        let total_cached = parsed
            .get("emails")
            .and_then(|e| e.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let meta = serde_json::json!({
            "totalEmails": parsed.get("totalEmails"),
            "uidValidity": parsed.get("uidValidity"),
            "uidNext": parsed.get("uidNext"),
            "highestModseq": parsed.get("highestModseq"),
            "lastSynced": parsed.get("lastSynced"),
            "totalCached": total_cached
        });
        return serde_json::to_string(&meta)
            .map(Some)
            .map_err(|e| format!("Failed to serialize: {}", e));
    }

    Ok(None)
}

/// Load email headers from sidecar cache for specific UIDs only.
pub fn load_by_uids(root: &Path, account_id: &str, mailbox: &str, uids: &[u32]) -> Vec<serde_json::Value> {
    let dir = sidecar_dir(root, account_id, mailbox);
    if !dir.exists() {
        info!("load_email_cache_by_uids: sidecar dir does not exist: {}", dir.display());
        return Vec::new();
    }

    let mut emails: Vec<serde_json::Value> = Vec::with_capacity(uids.len());
    for uid in uids {
        let path = dir.join(format!("{}.json", uid));
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(email) = serde_json::from_str(&data) {
                emails.push(email);
            }
        }
    }
    info!("load_email_cache_by_uids: found {}/{} UIDs in sidecar cache", emails.len(), uids.len());
    emails
}

/// List the UIDs a mailbox has sidecars for, plus which of them were written
/// after `since_ms`. Readdir only — no file is opened and nothing is parsed.
pub fn list_uids(root: &Path, account_id: &str, mailbox: &str, since_ms: Option<f64>) -> serde_json::Value {
    let dir = sidecar_dir(root, account_id, mailbox);
    if !dir.exists() {
        return serde_json::json!({ "uids": [], "changed": [] });
    }

    let mut uids: Vec<u32> = Vec::new();
    let mut changed: Vec<u32> = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(uid) = is_header_file(&name) else { continue };
            uids.push(uid);

            if let Some(since) = since_ms {
                let mtime_ms = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64);
                // Unreadable mtime counts as changed — an extra read is always
                // safer than serving a header we can't vouch for.
                if mtime_ms.map_or(true, |m| m > since) {
                    changed.push(uid);
                }
            }
        }
    }

    info!("list_cached_uids: {} sidecars, {} changed since {:?}", uids.len(), changed.len(), since_ms);
    serde_json::json!({ "uids": uids, "changed": changed })
}

/// Delete cached headers. `(Some(account), Some(mailbox))` clears one
/// mailbox; `(Some(account), None)` clears every entry belonging to that
/// account (exact sanitized-id match or `<id>_` prefix — never a bare prefix,
/// so clearing `acc1` cannot also delete `acc10`'s cache); `(None, None)`
/// clears everything except the Outlook uid ledgers (the vault and the app's
/// memory still use those numbers).
pub fn clear(root: &Path, account_id: Option<&str>, mailbox: Option<&str>) -> Result<(), String> {
    let cache_dir = root.join("email_cache");
    if !cache_dir.exists() {
        return Ok(());
    }

    let tree = lock_tree(root);
    let _tree_write = tree.write().unwrap_or_else(|e| e.into_inner());

    if let (Some(account_id), Some(mailbox)) = (account_id, mailbox) {
        let dir = cache_dir.join(cache_base_name(account_id, mailbox));
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("Failed to clear mailbox cache: {}", e))?;
            info!("Cleared cache for {}/{}", account_id, mailbox);
        }
        return Ok(());
    }

    if let Some(account_id) = account_id {
        let sanitized = account_id.replace(|c: char| !c.is_alphanumeric(), "_");
        let prefix = format!("{}_", sanitized);
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == sanitized || name.starts_with(&prefix) {
                    let path = entry.path();
                    if path.is_dir() {
                        let _ = fs::remove_dir_all(&path);
                    } else {
                        let _ = fs::remove_file(&path);
                    }
                    info!("Removed cache entry: {:?}", path);
                }
            }
        }
    } else {
        crate::graph_ledger::clear_cache_keeping_ledgers(&cache_dir);
        info!("Cleared all email cache (Outlook uid ledgers kept)");
    }

    Ok(())
}

// ── Mailbox cache (instant folder loading) ──────────────────────────────

pub fn save_mailbox_cache(root: &Path, account_id: &str, data: &str) -> Result<(), String> {
    let dir = root.join("mailboxes").join(account_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create mailbox cache directory: {}", e))?;
    write_atomic(&dir.join("mailboxes.json"), data.as_bytes())
        .map_err(|e| format!("Failed to write mailboxes.json: {}", e))
}

pub fn load_mailbox_cache(root: &Path, account_id: &str) -> Result<Option<String>, String> {
    let file = root.join("mailboxes").join(account_id).join("mailboxes.json");
    if !file.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&file).map_err(|e| format!("Failed to read mailboxes.json: {}", e))?;
    Ok(Some(data))
}

pub fn delete_mailbox_cache(root: &Path, account_id: &str) -> Result<(), String> {
    let dir = root.join("mailboxes").join(account_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove mailbox cache: {}", e))?;
    }
    Ok(())
}

// ── Flag patch ───────────────────────────────────────────────────────────

/// Set `flags` on one cached header. `false` when there is no such sidecar or
/// it already says this. `vault_flags::apply_files` calls this — the atomic,
/// locked replacement for the old plain, unlocked `fs::write` in the deleted
/// `vault_flags::patch_flags_field`.
pub fn patch_flags(root: &Path, account_id: &str, mailbox: &str, uid: u32, flags: &[String]) -> bool {
    let base_name = cache_base_name(account_id, mailbox);
    let path = sidecar_dir(root, account_id, mailbox).join(format!("{}.json", uid));

    let tree = lock_tree(root);
    let _tree_read = tree.read().unwrap_or_else(|e| e.into_inner());
    let mbox = lock_mailbox(root, &base_name);
    let _mbox_lock = mbox.lock().unwrap_or_else(|e| e.into_inner());

    let Ok(data) = fs::read_to_string(&path) else { return false };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&data) else { return false };
    let new_flags = serde_json::json!(flags);
    if value.get("flags") == Some(&new_flags) {
        return false;
    }
    let Some(map) = value.as_object_mut() else { return false };
    map.insert("flags".to_string(), new_flags);
    match serde_json::to_string(&value) {
        Ok(json) => write_atomic(&path, json.as_bytes()).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv_header_cache_{}_{}", name, uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn save_data(uid: u64, total: u64) -> String {
        serde_json::json!({
            "emails": [{"uid": uid, "subject": "x"}],
            "totalEmails": total,
        })
        .to_string()
    }

    #[test]
    fn save_preserves_meta_keys_the_caller_did_not_send() {
        let root = scratch("meta_merge");
        save(&root, "acc1", "INBOX", &serde_json::json!({
            "emails": [],
            "totalEmails": 10,
            "uidValidity": 7,
            "uidNext": 101,
            "highestModseq": 999,
        }).to_string()).unwrap();

        // A caller sending only totalEmails must not null out the others.
        save(&root, "acc1", "INBOX", &serde_json::json!({
            "emails": [],
            "totalEmails": 11,
        }).to_string()).unwrap();

        let meta_path = sidecar_dir(&root, "acc1", "INBOX").join("_meta.json");
        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        assert_eq!(meta["totalEmails"], 11);
        assert_eq!(meta["uidValidity"], 7);
        assert_eq!(meta["uidNext"], 101);
        assert_eq!(meta["highestModseq"], 999);

        let _ = fs::remove_dir_all(&root);
    }

    /// `save`'s merge only ever touches five named keys (see above); `lastReconcile`
    /// (set by the daemon's cold path, Task 2.3) and any future key are not among
    /// them, so they must survive untouched — passes by construction today, which
    /// is exactly why a later typed-meta refactor could break it unnoticed.
    #[test]
    fn save_preserves_last_reconcile_and_unknown_meta_keys_the_caller_never_sends() {
        let root = scratch("meta_merge_unknown");
        let dir = sidecar_dir(&root, "acc1", "INBOX");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("_meta.json"),
            serde_json::json!({
                "totalEmails": 5,
                "lastReconcile": 1_700_000_000_000u64,
                "someFutureKey": "kept",
            })
            .to_string(),
        )
        .unwrap();

        save(&root, "acc1", "INBOX", &serde_json::json!({
            "emails": [],
            "totalEmails": 6,
        }).to_string()).unwrap();

        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("_meta.json")).unwrap()).unwrap();
        assert_eq!(meta["totalEmails"], 6, "the caller's own key still updates");
        assert_eq!(meta["lastReconcile"], 1_700_000_000_000u64, "save never touches lastReconcile");
        assert_eq!(meta["someFutureKey"], "kept", "an unknown key on disk is never dropped");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_one_account_keeps_a_sibling_whose_id_is_a_prefix() {
        let root = scratch("clear_prefix");
        save(&root, "acc1", "INBOX", &save_data(1, 1)).unwrap();
        save(&root, "acc10", "INBOX", &save_data(2, 1)).unwrap();

        clear(&root, Some("acc1"), None).unwrap();

        assert!(!sidecar_dir(&root, "acc1", "INBOX").exists(), "acc1 must be cleared");
        assert!(sidecar_dir(&root, "acc10", "INBOX").exists(), "acc10 must survive clearing acc1");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_clear_racing_saves_never_leaves_a_half_written_mailbox() {
        let root = scratch("clear_race");
        for round in 0..20u64 {
            save(&root, "acc1", "INBOX", &save_data(round, round)).unwrap();

            let barrier = Arc::new(std::sync::Barrier::new(9));
            let mut handles = Vec::new();
            for i in 0..8u64 {
                let root = root.clone();
                let barrier = barrier.clone();
                handles.push(std::thread::spawn(move || {
                    barrier.wait();
                    save(&root, "acc1", "INBOX", &save_data(round * 100 + i, i)).unwrap();
                }));
            }
            {
                let root = root.clone();
                let barrier = barrier.clone();
                handles.push(std::thread::spawn(move || {
                    barrier.wait();
                    if round % 2 == 0 {
                        clear(&root, None, None).unwrap();
                    } else {
                        // The single-mailbox branch's own `remove_dir_all` walk,
                        // unwrapped: an ENOTEMPTY/ENOENT here would mean a `save`
                        // slipped in mid-walk, so this actually exercises the
                        // tree-write lock rather than only the logged-and-ignored
                        // `(None, None)` path above.
                        clear(&root, Some("acc1"), Some("INBOX")).unwrap();
                    }
                }));
            }
            for h in handles {
                h.join().unwrap();
            }

            // Whatever state it ended in, it must be internally consistent:
            // either the mailbox is gone, or its meta file parses and every
            // sidecar in it parses too — never a directory with some files
            // torn by an overlapping clear.
            let dir = sidecar_dir(&root, "acc1", "INBOX");
            if dir.exists() {
                let meta_path = dir.join("_meta.json");
                if meta_path.exists() {
                    let raw = fs::read_to_string(&meta_path).unwrap();
                    serde_json::from_str::<serde_json::Value>(&raw)
                        .unwrap_or_else(|e| panic!("round {round}: torn _meta.json: {e}"));
                }
                for entry in fs::read_dir(&dir).unwrap().flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if is_header_file(&name).is_none() {
                        continue;
                    }
                    let raw = fs::read_to_string(entry.path()).unwrap();
                    serde_json::from_str::<serde_json::Value>(&raw)
                        .unwrap_or_else(|e| panic!("round {round}: torn sidecar {name}: {e}"));
                }
            }
        }

        // Save after clear recreates the dir.
        save(&root, "acc1", "INBOX", &save_data(1, 1)).unwrap();
        assert!(sidecar_dir(&root, "acc1", "INBOX").join("_meta.json").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_flags_changes_only_the_flags_field() {
        let root = scratch("patch_flags");
        let dir = sidecar_dir(&root, "acc1", "INBOX");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("7.json"), r#"{"uid":7,"flags":[],"subject":"s"}"#).unwrap();

        assert!(patch_flags(&root, "acc1", "INBOX", 7, &["\\Seen".to_string()]));
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("7.json")).unwrap()).unwrap();
        assert_eq!(v["flags"], serde_json::json!(["\\Seen"]));
        assert_eq!(v["subject"], "s");

        // Already-correct flags report no change.
        assert!(!patch_flags(&root, "acc1", "INBOX", 7, &["\\Seen".to_string()]));
        // A missing sidecar reports no change.
        assert!(!patch_flags(&root, "acc1", "INBOX", 999, &["\\Seen".to_string()]));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_header_file_excludes_meta_and_the_graph_ledger() {
        assert_eq!(is_header_file("42.json"), Some(42));
        assert_eq!(is_header_file("_meta.json"), None);
        assert_eq!(is_header_file(GRAPH_ID_MAP_FILE), None);
        assert_eq!(is_header_file("not_a_number.json"), None);
    }
}

#[cfg(test)]
mod sidecar_order_tests {
    use super::*;

    fn write_meta(dir: &Path) {
        fs::write(dir.join("_meta.json"), br#"{"totalEmails":9}"#).unwrap();
    }

    /// One header sidecar, carrying only the fields the ordering reads.
    fn write_header(dir: &Path, uid: u64, internal_date: &str) {
        let body = serde_json::json!({
            "uid": uid,
            "subject": format!("msg {}", uid),
            "internalDate": internal_date,
        });
        fs::write(dir.join(format!("{}.json", uid)), body.to_string()).unwrap();
    }

    fn returned_uids(json: &str) -> Vec<u64> {
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        parsed["emails"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["uid"].as_u64().unwrap())
            .collect()
    }

    /// An IMAP mailbox: the server issued the uids in arrival order, so the
    /// highest are the newest and the cheap readdir sort is right.
    #[test]
    fn imap_mailbox_takes_the_highest_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        write_header(dir, 1, "2026-01-01T00:00:00Z");
        write_header(dir, 2, "2026-02-01T00:00:00Z");
        write_header(dir, 3, "2026-03-01T00:00:00Z");

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), Some(2))
            .unwrap()
            .unwrap();

        assert_eq!(returned_uids(&out), vec![3, 2]);
    }

    /// A Graph mailbox: uid 1 is the NEWEST message (the seed walked a
    /// `receivedDateTime desc` listing) and uid 4 is the oldest, while uid 5
    /// arrived after the seed and is newer than all of them. Sorting by uid
    /// returns the oldest cached mail — this is the bug.
    #[test]
    fn graph_mailbox_takes_the_newest_dates_not_the_highest_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        write_header(dir, 1, "2026-08-01T00:00:00Z"); // newest at seed time
        write_header(dir, 2, "2026-07-01T00:00:00Z");
        write_header(dir, 3, "2026-06-01T00:00:00Z");
        write_header(dir, 4, "2026-05-01T00:00:00Z"); // oldest at seed time
        write_header(dir, 5, "2026-08-15T00:00:00Z"); // arrived after the seed

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), Some(3))
            .unwrap()
            .unwrap();

        assert_eq!(returned_uids(&out), vec![5, 1, 2]);
    }

    /// `graph_id_map.json` is not a message: it must not be counted, read, or
    /// returned as one.
    #[test]
    fn graph_id_map_is_not_counted_as_a_message() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        write_header(dir, 1, "2026-08-01T00:00:00Z");

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), None)
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();

        assert_eq!(returned_uids(&out), vec![1]);
        assert_eq!(parsed["totalCached"].as_u64(), Some(1));
    }

    /// A header with no date can't be placed in time, so it must never take a
    /// slot from one that can.
    #[test]
    fn undated_graph_header_sorts_last() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_meta(dir);
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        fs::write(dir.join("7.json"), br#"{"uid":7,"subject":"no date"}"#).unwrap();
        write_header(dir, 1, "2026-08-01T00:00:00Z");
        write_header(dir, 2, "2026-07-01T00:00:00Z");

        let out = load_from_sidecars(dir, &dir.join("_meta.json"), Some(2))
            .unwrap()
            .unwrap();

        assert_eq!(returned_uids(&out), vec![1, 2]);
    }

    /// IMAP headers carry RFC 2822 dates; Graph carries RFC 3339. Both parse.
    #[test]
    fn header_date_ms_reads_both_date_formats() {
        let rfc3339 = serde_json::json!({ "internalDate": "2026-08-01T00:00:00Z" });
        let rfc2822 = serde_json::json!({ "date": "Sat, 1 Aug 2026 00:00:00 +0000" });
        let undated = serde_json::json!({ "subject": "x" });

        assert_eq!(header_date_ms(&rfc3339), header_date_ms(&rfc2822));
        assert_eq!(header_date_ms(&undated), i64::MIN);
    }
}
