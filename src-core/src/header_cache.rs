//! What is left of the header cache on disk.
//!
//! The headers themselves live in `custody.db`'s `header_cache` table now, and
//! so does the per-account folder list. This module keeps the parts that are
//! still about the `email_cache/<account>_<mailbox>/` **directory**, because
//! the Outlook uid ledger (`graph_id_map.json`) still lives in it and is not
//! derived from anything: the directory naming (`cache_base_name`,
//! `sidecar_dir`), the sidecar-name parser every walker over a legacy vault
//! still needs (`is_header_file`), and `clear`, which empties those
//! directories while keeping the ledgers **by name**.
//!
//! Locking: one `RwLock` per vault root and one `Mutex` per (root, mailbox
//! base name), lazily created in a process-wide registry. `clear` takes the
//! tree lock for `write`; order is always tree before mailbox, and neither is
//! ever held across an `.await` or network I/O.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use tracing::info;


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
            // The uid ledger shares this directory and is not derived from
            // anything: dropping it hands a live uid to a second message.
            crate::graph_ledger::clear_mailbox_keeping_ledger(&dir);
            info!("Cleared cache for {}/{} (Outlook uid ledger kept)", account_id, mailbox);
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
//
// The rows live in `custody.db`'s `mailbox_cache` now. All that is left here
// is the one-time move of the file they were in.

/// `<root>/mailboxes/<account>/mailboxes.json` — the pre-SQL folder list.
pub fn legacy_mailbox_cache(root: &Path, account_id: &str) -> PathBuf {
    root.join("mailboxes").join(account_id).join("mailboxes.json")
}

/// Read the pre-SQL folder list and retire it, so the next call finds nothing.
/// `None` when there is none, which is the normal case after the first start.
pub fn take_legacy_mailbox_cache(root: &Path, account_id: &str) -> Option<String> {
    let file = legacy_mailbox_cache(root, account_id);
    let data = fs::read_to_string(&file).ok()?;
    let _ = crate::fsx::retire(&file, crate::fsx::retire_stamp());
    Some(data)
}

/// Drop everything the pre-SQL folder list left behind for one account.
pub fn delete_legacy_mailbox_cache(root: &Path, account_id: &str) -> Result<(), String> {
    let dir = root.join("mailboxes").join(account_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove mailbox cache: {}", e))?;
    }
    Ok(())
}

// ── Flag patch ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_ledger::LEDGER_FILE as GRAPH_ID_MAP_FILE;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-header-cache-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed(root: &Path, account: &str, mailbox: &str) -> PathBuf {
        let dir = sidecar_dir(root, account, mailbox);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(GRAPH_ID_MAP_FILE), br#"{"1":"AAA"}"#).unwrap();
        fs::write(dir.join("7.json"), br#"{"uid":7}"#).unwrap();
        dir
    }

    #[test]
    fn is_header_file_excludes_meta_and_the_graph_ledger() {
        assert_eq!(is_header_file("42.json"), Some(42));
        assert_eq!(is_header_file("_meta.json"), None);
        assert_eq!(is_header_file(GRAPH_ID_MAP_FILE), None);
        assert_eq!(is_header_file("not_a_number.json"), None);
        assert_eq!(is_header_file("4294967296.json"), None, "a uid past u32 is not one of ours");
    }

    #[test]
    fn cache_base_name_sanitizes_both_halves() {
        assert_eq!(cache_base_name("acc-1", "[Gmail]/Sent Mail"), "acc_1__Gmail__Sent_Mail");
    }

    #[test]
    fn clearing_one_mailbox_keeps_its_uid_ledger() {
        // The ledger is not derived from anything: dropping it hands a live
        // uid to a second message.
        let root = scratch("clear-one");
        let dir = seed(&root, "acc1", "INBOX");
        clear(&root, Some("acc1"), Some("INBOX")).unwrap();
        assert!(dir.join(GRAPH_ID_MAP_FILE).exists(), "the ledger survives a per-mailbox clear");
        assert!(!dir.join("7.json").exists(), "everything else in the directory goes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_ledgerless_mailbox_removes_the_directory() {
        let root = scratch("clear-empty");
        let dir = sidecar_dir(&root, "acc1", "INBOX");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("7.json"), b"{}").unwrap();
        clear(&root, Some("acc1"), Some("INBOX")).unwrap();
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_one_account_keeps_a_sibling_whose_id_is_a_prefix() {
        let root = scratch("clear-prefix");
        seed(&root, "acc1", "INBOX");
        seed(&root, "acc10", "INBOX");
        clear(&root, Some("acc1"), None).unwrap();
        assert!(!sidecar_dir(&root, "acc1", "INBOX").exists(), "acc1 must be cleared");
        assert!(sidecar_dir(&root, "acc10", "INBOX").exists(), "acc10 must survive clearing acc1");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_everything_keeps_every_ledger() {
        let root = scratch("clear-all");
        let a = seed(&root, "acc1", "INBOX");
        let b = seed(&root, "acc2", "Sent");
        clear(&root, None, None).unwrap();
        assert!(a.join(GRAPH_ID_MAP_FILE).exists());
        assert!(b.join(GRAPH_ID_MAP_FILE).exists());
        assert!(!a.join("7.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_root_with_no_cache_is_not_an_error() {
        let root = scratch("clear-none");
        clear(&root, None, None).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pre_sql_mailbox_list_is_read_once_then_retired() {
        let root = scratch("legacy-mailboxes");
        let file = legacy_mailbox_cache(&root, "acc1");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, br#"[{"path":"INBOX"}]"#).unwrap();

        assert_eq!(take_legacy_mailbox_cache(&root, "acc1").as_deref(), Some(r#"[{"path":"INBOX"}]"#));
        assert!(!file.exists(), "retired, never deleted");
        assert!(fs::read_dir(file.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("mailboxes.json.pre-db-")));
        assert_eq!(take_legacy_mailbox_cache(&root, "acc1"), None, "the second read finds nothing");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_the_legacy_mailbox_list_is_idempotent() {
        let root = scratch("legacy-delete");
        delete_legacy_mailbox_cache(&root, "acc1").unwrap();
        let file = legacy_mailbox_cache(&root, "acc1");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"[]").unwrap();
        delete_legacy_mailbox_cache(&root, "acc1").unwrap();
        assert!(!file.parent().unwrap().exists());
        let _ = fs::remove_dir_all(&root);
    }
}
