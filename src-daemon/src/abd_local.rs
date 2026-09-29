//! `LocalStore` for the Archive & delete job: the vault and the backup drive,
//! reached through the daemon's own gate and registry.
//!
//! - Vault writes go through `archive::store_archived` (mailbox lock + the
//!   daemon's write gate, registry upsert) and then a custody append.
//! - The engine lists a folder's archived files once; every batch is verified
//!   against that listing with `maildir::verify_listed` (a per-file check on
//!   current disk), so no directory is read per batch.
//! - The mirror is copied with `backup::copy_uids_to_mirror_listed` against one
//!   `MirrorListing` per folder. The before-delete re-check opens the mirror
//!   file by its predictable name; only a name that misses reads the folder,
//!   once (the drive's `read_dir` is the slowest disk access the app makes).
//! - Nothing here holds a lock across an `.await`. Disk work runs on the
//!   runtime's blocking pool.

use crate::handlers::archive::archive_ctx;
use crate::handlers::common;
use crate::server::DaemonState;
use mailvault_core::abd::{Fetched, LocalError, LocalStore, Verify};
use mailvault_core::backup::{copy_uids_to_mirror_listed, MirrorListing};
use mailvault_core::{archive, graph_ledger, header_cache, maildir, vault_files};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::warn;

/// A hung external drive must not park the job forever.
const MIRROR_BUDGET: Duration = Duration::from_secs(300);

pub(crate) struct DaemonLocal {
    state: Arc<DaemonState>,
    account_id: String,
    email: String,
    /// One listing per mirror folder, held across batches (Part B's contract).
    mirror_listings: Mutex<HashMap<String, MirrorListing>>,
    /// The fallback listing for a folder whose mirror name missed, read once.
    mirror_maps: Mutex<HashMap<String, HashMap<u32, PathBuf>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn vault_error(e: String) -> LocalError {
    if e.contains("E_VAULT_UNAVAILABLE") {
        LocalError::VaultUnavailable(e)
    } else {
        LocalError::Io(e)
    }
}

impl DaemonLocal {
    pub(crate) fn new(state: Arc<DaemonState>, account_id: &str, email: &str) -> DaemonLocal {
        DaemonLocal {
            state,
            account_id: account_id.to_string(),
            email: email.to_string(),
            mirror_listings: Mutex::new(HashMap::new()),
            mirror_maps: Mutex::new(HashMap::new()),
        }
    }

    /// The vault root, or "the vault is not available" (a move in progress, an
    /// unreachable folder): the job pauses for it instead of writing elsewhere.
    fn vault(&self) -> Result<PathBuf, LocalError> {
        common::vault_root(&self.state).map_err(LocalError::VaultUnavailable)
    }

    /// The backup folder the shell attached, if it is there.
    fn mirror_root(&self) -> Result<PathBuf, LocalError> {
        let root = self
            .state
            .abd
            .mirror(&self.account_id)
            .ok_or_else(|| LocalError::DriveUnavailable("no backup folder is attached".to_string()))?;
        let path = PathBuf::from(root);
        if !path.is_dir() {
            return Err(LocalError::DriveUnavailable("the backup folder is not available".to_string()));
        }
        Ok(path)
    }

    fn mirror_cur(&self, root: &Path, folder: &str) -> PathBuf {
        root.join(&self.email).join(folder).join("cur")
    }
}

impl LocalStore for DaemonLocal {
    async fn archived_listing(&self, folder: &str) -> Result<HashMap<u32, PathBuf>, LocalError> {
        let root = self.vault()?;
        let cur = vault_files::cur_path(&root, &self.account_id, folder);
        common::blocking(move || maildir::archived_file_map(&cur)).await.map_err(LocalError::Io)
    }

    async fn store_archived(&self, folder: &str, uid: u32, f: Fetched) -> Result<PathBuf, LocalError> {
        let root = self.vault()?;
        let ctx = archive_ctx(&self.state, root);
        let (path, entry) = archive::store_archived(&ctx, &self.account_id, folder, uid, f.raw, &f.flags, false)
            .await
            .map_err(vault_error)?;
        // The custody row of an archived copy. The file is already stored and
        // registered: a custody failure is logged, never a reason to store
        // (or download) the message again.
        let append = Arc::clone(&ctx.sinks.custody_append);
        let (account, mailbox) = (self.account_id.clone(), folder.to_string());
        let json = serde_json::to_string(&vec![entry]).unwrap_or_else(|_| "[]".to_string());
        match common::blocking(move || append(&account, &mailbox, json)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) | Err(e) => warn!("abd: custody row for UID {uid} not written: {e}"),
        }
        Ok(path)
    }

    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, LocalError> {
        let p = path.to_path_buf();
        common::blocking(move || std::fs::read(&p))
            .await
            .map_err(LocalError::Io)?
            .map_err(|e| LocalError::Io(format!("could not read {}: {e}", path.display())))
    }

    async fn verify_vault(
        &self,
        folder: &str,
        listing: &HashMap<u32, PathBuf>,
        uids: &[u32],
        expected: &HashMap<u32, String>,
    ) -> Result<Verify, LocalError> {
        let root = self.vault()?;
        let cur = vault_files::cur_path(&root, &self.account_id, folder);
        // Only the batch's own entries cross to the blocking thread.
        let sub: HashMap<u32, PathBuf> = uids.iter().filter_map(|u| listing.get(u).map(|p| (*u, p.clone()))).collect();
        let (uids, expected) = (uids.to_vec(), expected.clone());
        common::blocking(move || {
            let (ok, missing, mismatched) = maildir::verify_listed(&cur, &sub, &uids, Some(&expected));
            Verify { ok, missing, mismatched }
        })
        .await
        .map_err(LocalError::Io)
    }

    async fn mirror_copy_verify(&self, folder: &str, uids: &[u32]) -> Result<Verify, LocalError> {
        let vault = self.vault()?;
        let mirror = self.mirror_root()?;
        let mut listing = lock(&self.mirror_listings).remove(folder).unwrap_or_default();
        let (account, email, mailbox, wanted) =
            (self.account_id.clone(), self.email.clone(), folder.to_string(), uids.to_vec());
        let mirror_for_job = mirror.clone();
        let job = common::blocking(move || {
            let r = copy_uids_to_mirror_listed(&vault, &mirror_for_job, &account, &email, &mailbox, &wanted, &mut listing);
            (r, listing)
        });
        let (result, listing) = match tokio::time::timeout(MIRROR_BUDGET, job).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(LocalError::Io(e)),
            // The listing stays with the stuck thread; the next call reads afresh.
            Err(_) => return Err(LocalError::DriveUnavailable("the backup folder did not answer in time".to_string())),
        };
        lock(&self.mirror_listings).insert(folder.to_string(), listing);
        let out = result.map_err(LocalError::DriveUnavailable)?;
        let mut missing = out.missing;
        if !out.failed.is_empty() {
            // Nothing worked, or the folder went away under us: the drive.
            // Otherwise a copy that would not land is kept off the delete list
            // exactly like one that is missing.
            let nothing_worked = out.verified.is_empty() && out.mismatched.is_empty() && missing.is_empty();
            if nothing_worked || !mirror.is_dir() {
                return Err(LocalError::DriveUnavailable("could not write to the backup folder".to_string()));
            }
            missing.extend(out.failed);
        }
        Ok(Verify { ok: out.verified, missing, mismatched: out.mismatched })
    }

    async fn mirror_verify_paths(
        &self,
        folder: &str,
        files: &[(u32, String)],
        expected: &HashMap<u32, String>,
    ) -> Result<Verify, LocalError> {
        let vault = self.vault()?;
        let mirror = self.mirror_root()?;
        let cur = self.mirror_cur(&mirror, folder);
        let vault_cur = vault_files::cur_path(&vault, &self.account_id, folder);
        let cached = lock(&self.mirror_maps).remove(folder);
        let (files, expected) = (files.to_vec(), expected.clone());
        #[cfg(test)]
        let counter = Arc::clone(&self.state);
        let job = common::blocking(move || {
            let mut map = cached;
            let mut v = Verify { ok: Vec::new(), missing: Vec::new(), mismatched: Vec::new() };
            for (uid, name) in &files {
                let name_eml = if name.ends_with(".eml") { name.clone() } else { format!("{name}.eml") };
                let mut path = cur.join(&name_eml);
                if !path.is_file() {
                    // A flag rename on the drive side: one listing of the folder, kept for the pass.
                    if map.is_none() {
                        #[cfg(test)]
                        counter.abd.test.fallback_scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        map = Some(maildir::mirror_file_map(&cur));
                    }
                    match map.as_ref().and_then(|m| m.get(uid)).filter(|p| p.is_file()) {
                        Some(p) => path = p.clone(),
                        None => {
                            v.missing.push(*uid);
                            continue;
                        }
                    }
                }
                match expected.get(uid) {
                    Some(want) => match maildir::read_message_id(&path) {
                        Some(got) if &got == want => v.ok.push(*uid),
                        _ => v.mismatched.push(*uid),
                    },
                    // No Message-ID to compare: the same length as the vault copy.
                    None => {
                        let mine = std::fs::metadata(&path).map(|m| m.len()).ok();
                        let theirs = std::fs::metadata(vault_cur.join(&name_eml)).map(|m| m.len()).ok();
                        match (mine, theirs) {
                            (Some(a), Some(b)) if a == b => v.ok.push(*uid),
                            (Some(a), None) if a > 0 => v.ok.push(*uid),
                            _ => v.mismatched.push(*uid),
                        }
                    }
                }
            }
            (v, map)
        });
        let (verify, map) = match tokio::time::timeout(MIRROR_BUDGET, job).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(LocalError::Io(e)),
            Err(_) => return Err(LocalError::DriveUnavailable("the backup folder did not answer in time".to_string())),
        };
        if let Some(m) = map {
            lock(&self.mirror_maps).insert(folder.to_string(), m);
        }
        Ok(verify)
    }

    async fn graph_uids(&self, folder: &str, listed: &[(String, Option<String>)]) -> Result<Vec<u32>, LocalError> {
        let root = self.vault()?;
        let ledger = root
            .join("email_cache")
            .join(header_cache::cache_base_name(&self.account_id, folder))
            .join(graph_ledger::LEDGER_FILE);
        let cur = vault_files::cur_path(&root, &self.account_id, folder);
        let (state, listed) = (Arc::clone(&self.state), listed.to_vec());
        common::blocking(move || {
            common::with_vault_write(&state, |_root| graph_ledger::allocate(&ledger, &cur, &listed))
        })
        .await
        .map_err(LocalError::Io)?
        .map_err(vault_error)
    }

    async fn deleted_from_server(&self, folder: &str, uids: &[u32]) {
        if uids.is_empty() {
            return;
        }
        let (state, account, mailbox, uids) =
            (Arc::clone(&self.state), self.account_id.clone(), folder.to_string(), uids.to_vec());
        let r = common::blocking(move || {
            crate::custody::with_conn(&state, |c| {
                mailvault_core::custody::cache::remove_headers(c, &account, &mailbox, &uids)
            })
        })
        .await;
        match r {
            Ok(Ok(_)) => {}
            Ok(Err(e)) | Err(e) => warn!("abd: header rows of deleted mail not dropped: {e}"),
        }
    }
}
