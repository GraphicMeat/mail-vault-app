//! `LocalStore` for the Archive & delete job: the vault and the backup drive,
//! reached through the daemon's own gate and registry.
//!
//! - Vault writes go through `archive::store_archived` (mailbox lock + the
//!   daemon's write gate, registry upsert) and then a custody append.
//! - The engine lists a folder's archived files once; every batch is verified
//!   against that listing with `message_store::verify_archived_strict`
//!   (`maildir::verify_listed_strict`'s per-file
//!   check on current disk: an expected Message-ID must be read and equal), so
//!   no directory is read per batch.
//! - The mirror is copied with `backup::copy_uids_to_mirror_from` against one
//!   `MirrorListing` per folder and the engine's own vault listing. The
//!   before-delete re-check opens the mirror file by its predictable name;
//!   only a name that misses reads the folder, once per copy pass (the drive's
//!   `read_dir` is the slowest disk access the app makes).
//! - Nothing here holds a lock across an `.await`. Disk work runs on the
//!   runtime's blocking pool.

use crate::account_lifecycle::{AccountStamp, OperationPermit};
use crate::handlers::archive::{archive_ctx, archive_ctx_owned};
use crate::handlers::common;
use crate::server::DaemonState;
use mailvault_core::abd::{Fetched, LocalError, LocalStore, StoreOutcome, Stored, Verify};
use mailvault_core::backup::{copy_uids_to_mirror_from, MirrorListing};
use mailvault_core::{archive, graph_ledger, header_cache, maildir, message_store};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::warn;

/// A hung external drive must not park the job forever.
const MIRROR_BUDGET: Duration = Duration::from_secs(300);

#[cfg(test)]
pub(crate) struct MirrorPause {
    pub entered: std::sync::mpsc::Sender<()>,
    pub release: std::sync::mpsc::Receiver<()>,
    pub done: std::sync::mpsc::Sender<()>,
}

#[cfg(test)]
pub(crate) fn mirror_pauses() -> &'static Mutex<HashMap<PathBuf, MirrorPause>> {
    static PAUSES: std::sync::OnceLock<Mutex<HashMap<PathBuf, MirrorPause>>> = std::sync::OnceLock::new();
    PAUSES.get_or_init(Default::default)
}

#[cfg(test)]
pub(crate) fn mirror_budgets() -> &'static Mutex<HashMap<PathBuf, Duration>> {
    static BUDGETS: std::sync::OnceLock<Mutex<HashMap<PathBuf, Duration>>> = std::sync::OnceLock::new();
    BUDGETS.get_or_init(Default::default)
}

fn mirror_budget(app_dir: &Path) -> Duration {
    #[cfg(test)]
    if let Some(budget) = lock(mirror_budgets()).remove(app_dir) { return budget; }
    #[cfg(not(test))]
    let _ = app_dir;
    MIRROR_BUDGET
}

#[cfg(test)]
fn pause_mirror_copy(app_dir: &Path) -> Option<impl Drop> {
    struct Done(std::sync::mpsc::Sender<()>);
    impl Drop for Done {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    let pause = lock(mirror_pauses()).remove(app_dir)?;
    let done = Done(pause.done);
    let _ = pause.entered.send(());
    let _ = pause.release.recv();
    Some(done)
}

#[cfg(test)]
pub(crate) struct BookkeepingPause {
    pub entered: std::sync::mpsc::Sender<()>,
    pub release: std::sync::mpsc::Receiver<()>,
    pub done: std::sync::mpsc::Sender<()>,
    pub panic_after: bool,
}

#[cfg(test)]
pub(crate) fn bookkeeping_pauses() -> &'static Mutex<HashMap<PathBuf, BookkeepingPause>> {
    static PAUSES: std::sync::OnceLock<Mutex<HashMap<PathBuf, BookkeepingPause>>> = std::sync::OnceLock::new();
    PAUSES.get_or_init(Default::default)
}

#[cfg(test)]
fn pause_bookkeeping(app_dir: &Path) -> Option<impl Drop> {
    struct Done(std::sync::mpsc::Sender<()>);
    impl Drop for Done { fn drop(&mut self) { let _ = self.0.send(()); } }
    let pause = lock(bookkeeping_pauses()).remove(app_dir)?;
    let done = Done(pause.done);
    let _ = pause.entered.send(());
    let _ = pause.release.recv();
    if pause.panic_after { panic!("p5 injected bookkeeping child unwind"); }
    Some(done)
}

pub(crate) struct DaemonLocal {
    state: Arc<DaemonState>,
    account_id: String,
    email: String,
    original: Option<AccountStamp>,
    owner: Option<OperationPermit>,
    /// A JMAP account: `graph_uids` allocates from the mailbox's JMAP ledger.
    jmap: bool,
    /// A backup folder fixed for this store (auto-cleanup), instead of the
    /// one the shell attached to the account's abd job.
    mirror_override: Option<PathBuf>,
    /// One listing per mirror folder, held across batches (Part B's contract).
    mirror_listings: Mutex<HashMap<String, MirrorListing>>,
    /// The fallback listing for a folder whose mirror name missed. Dropped by
    /// every copy pass (a file copied since is not in it), and read again
    /// once when an entry it holds is gone (renamed since).
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
            original: None,
            owner: None,
            jmap: false,
            mirror_override: None,
            mirror_listings: Mutex::new(HashMap::new()),
            mirror_maps: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn with_owner(mut self, original: AccountStamp, owner: OperationPermit) -> DaemonLocal {
        self.original = Some(original);
        self.owner = Some(owner);
        self
    }

    /// The local store of a JMAP account (`true`): its uids come from the
    /// JMAP ledger the bridge and the sync allocate from.
    pub(crate) fn with_jmap(mut self, jmap: bool) -> DaemonLocal {
        self.jmap = jmap;
        self
    }

    /// Read the drive at `root` instead of the account's attached mirror.
    pub(crate) fn with_mirror(mut self, root: Option<PathBuf>) -> DaemonLocal {
        self.mirror_override = root;
        self
    }

    /// The vault root, or "the vault is not available" (a move in progress, an
    /// unreachable folder): the job pauses for it instead of writing elsewhere.
    fn vault(&self) -> Result<PathBuf, LocalError> {
        common::vault_root(&self.state).map_err(LocalError::VaultUnavailable)
    }

    /// The backup folder the shell attached, if it is there.
    fn mirror_root(&self) -> Result<PathBuf, LocalError> {
        let path = match &self.mirror_override {
            Some(p) => p.clone(),
            None => self
                .state
                .abd
                .mirror(&self.account_id)
                .map(PathBuf::from)
                .ok_or_else(|| LocalError::DriveUnavailable("no backup folder is attached".to_string()))?,
        };
        if !path.is_dir() {
            return Err(LocalError::DriveUnavailable("the backup folder is not available".to_string()));
        }
        Ok(path)
    }

    fn mirror_cur(&self, root: &Path, folder: &str) -> Result<PathBuf, LocalError> {
        maildir::mirror_cur(root, &self.email, folder).map_err(LocalError::DriveUnavailable)
    }
}

impl LocalStore for DaemonLocal {
    async fn archived_listing(&self, folder: &str) -> Result<HashMap<u32, PathBuf>, LocalError> {
        let root = self.vault()?;
        let (account, mailbox) = (self.account_id.clone(), folder.to_string());
        common::blocking(move || message_store::archived_paths(&root, &account, &mailbox)).await.map_err(LocalError::Io)
    }

    async fn store_archived(&self, folder: &str, uid: u32, f: Fetched) -> Result<Stored, LocalError> {
        let root = self.vault()?;
        let ctx = match &self.owner {
            Some(owner) => archive_ctx_owned(&self.state, root, owner.clone()),
            None => archive_ctx(&self.state, root),
        };
        let (path, entry, outcome) = archive::store_archived(&ctx, &self.account_id, folder, uid, f.raw, &f.flags, false)
            .await
            .map_err(vault_error)?;
        if outcome == StoreOutcome::FoundDifferent {
            // The file under the uid holds other bytes: a custody row naming
            // the fetched message would describe a file that is not it.
            return Ok(Stored { path, outcome });
        }
        // The custody row of an archived copy. The file is already stored and
        // registered: a custody failure is logged, never a reason to store
        // (or download) the message again.
        let append = Arc::clone(&ctx.sinks.custody_append);
        let (account, mailbox) = (self.account_id.clone(), folder.to_string());
        let json = serde_json::to_string(&vec![entry]).unwrap_or_else(|_| "[]".to_string());
        #[cfg(test)]
        let app_dir = self.state.app_dir.clone();
        match common::blocking(move || {
            #[cfg(test)]
            let _done = pause_bookkeeping(&app_dir);
            append(&account, &mailbox, json)
        }).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) | Err(e) => warn!("abd: custody row for UID {uid} not written: {e}"),
        }
        Ok(Stored { path, outcome })
    }

    async fn vault_generation(&self, folder: &str) -> Result<Option<u32>, LocalError> {
        let root = self.vault()?;
        let mailbox_dir = message_store::mailbox_dir(&root, &self.account_id, folder);
        common::blocking(move || maildir::read_generation(&mailbox_dir)).await.map_err(LocalError::Io)
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
        let (account, mailbox) = (self.account_id.clone(), folder.to_string());
        // Only the batch's own entries cross to the blocking thread.
        let sub: HashMap<u32, PathBuf> = uids.iter().filter_map(|u| listing.get(u).map(|p| (*u, p.clone()))).collect();
        let (uids, expected) = (uids.to_vec(), expected.clone());
        common::blocking(move || {
            let (ok, missing, mismatched) = message_store::verify_archived_strict(&root, &account, &mailbox, &sub, &uids, &expected);
            Verify { ok, missing, mismatched }
        })
        .await
        .map_err(LocalError::Io)
    }

    async fn mirror_copy_verify(
        &self,
        folder: &str,
        vault_listing: &HashMap<u32, PathBuf>,
        uids: &[u32],
    ) -> Result<Verify, LocalError> {
        self.mirror_cur(Path::new("."), folder)?;
        let vault = self.vault()?;
        let mirror = self.mirror_root()?;
        // Files land on the drive now: a fallback map read before is stale.
        lock(&self.mirror_maps).remove(folder);
        let mut listing = lock(&self.mirror_listings).remove(folder).unwrap_or_default();
        // Only the batch's own entries cross to the blocking thread.
        let sources: HashMap<u32, PathBuf> =
            uids.iter().filter_map(|u| vault_listing.get(u).map(|p| (*u, p.clone()))).collect();
        let (account, email, mailbox, wanted) =
            (self.account_id.clone(), self.email.clone(), folder.to_string(), uids.to_vec());
        let mirror_for_job = mirror.clone();
        let owner = self.owner.clone();
        #[cfg(test)]
        let app_dir = self.state.app_dir.clone();
        let job = common::blocking(move || {
            let _owner = owner;
            #[cfg(test)]
            let _done = pause_mirror_copy(&app_dir);
            let r = copy_uids_to_mirror_from(&vault, &mirror_for_job, &account, &email, &mailbox, &wanted, &mut listing, &sources);
            (r, listing)
        });
        let (result, listing) = match tokio::time::timeout(mirror_budget(&self.state.app_dir), job).await {
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
        self.mirror_cur(Path::new("."), folder)?;
        let vault = self.vault()?;
        let mirror = self.mirror_root()?;
        let cur = self.mirror_cur(&mirror, folder)?;
        let (account, mailbox) = (self.account_id.clone(), folder.to_string());
        let cached = lock(&self.mirror_maps).remove(folder);
        let (files, expected) = (files.to_vec(), expected.clone());
        #[cfg(test)]
        let counter = Arc::clone(&self.state);
        #[cfg(test)]
        let app_dir = self.state.app_dir.clone();
        let owner = self.owner.clone();
        let job = common::blocking(move || {
            let _owner = owner;
            #[cfg(test)]
            let _done = pause_mirror_copy(&app_dir);
            let mut map = cached;
            // Whether `map` was read in this call: a map from an earlier call
            // whose entry is gone (renamed since) is read once more.
            let mut fresh = false;
            let mut v = Verify { ok: Vec::new(), missing: Vec::new(), mismatched: Vec::new() };
            for (uid, name) in &files {
                let name_eml = if name.ends_with(".eml") { name.clone() } else { format!("{name}.eml") };
                let mut path = cur.join(&name_eml);
                if !path.is_file() {
                    // A flag rename on the drive side: one listing of the folder, kept for the pass.
                    let stale_entry = map.as_ref().is_some_and(|m| m.get(uid).is_some_and(|p| !p.is_file()));
                    if map.is_none() || (stale_entry && !fresh) {
                        #[cfg(test)]
                        counter.abd.test.fallback_scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        map = Some(maildir::mirror_file_map(&cur));
                        fresh = true;
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
                    // No Message-ID to compare: byte for byte against the
                    // vault copy, found by uid (a flag change may have renamed
                    // it). No vault copy to compare with is not proof.
                    None => match message_store::raw_path_listed(&vault, &account, &mailbox, *uid, &message_store::entry_path(&vault, &account, &mailbox, name)) {
                        None => v.missing.push(*uid),
                        Some(src) => match (std::fs::read(&path), std::fs::read(&src)) {
                            (Ok(a), Ok(b)) if !a.is_empty() && a == b => v.ok.push(*uid),
                            (Ok(_), Ok(_)) => v.mismatched.push(*uid),
                            _ => v.missing.push(*uid),
                        },
                    },
                }
            }
            (v, map)
        });
        let (verify, map) = match tokio::time::timeout(mirror_budget(&self.state.app_dir), job).await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(LocalError::Io(e)),
            Err(_) => return Err(LocalError::DriveUnavailable("the backup folder did not answer in time".to_string())),
        };
        if let Some(m) = map {
            lock(&self.mirror_maps).insert(folder.to_string(), m);
        }
        Ok(verify)
    }

    /// The plan freeze's uids: Outlook from `graph_id_map.json`, JMAP from
    /// `jmap_id_map.json` (`jmap_sessions::jmap_ledger_path`, the ledger the
    /// bridge and the sync use). JMAP passes no Message-IDs, as
    /// `AccountJmap::ids_to_uids` does: adoption could issue a uid below the
    /// uidNext the app last saw.
    async fn graph_uids(&self, folder: &str, listed: &[(String, Option<String>)]) -> Result<Vec<u32>, LocalError> {
        let root = self.vault()?;
        let ledger = graph_ledger::ledger_path(&header_cache::sidecar_dir(&root, &self.account_id, folder), self.jmap);
        let (account, mailbox) = (self.account_id.clone(), folder.to_string());
        let listed: Vec<(String, Option<String>)> = if self.jmap {
            listed.iter().map(|(id, _)| (id.clone(), None)).collect()
        } else {
            listed.to_vec()
        };
        let state = Arc::clone(&self.state);
        let original = self.original.clone();
        let owner = self.owner.clone();
        common::blocking(move || {
            let _owner = owner;
            #[cfg(test)]
            let _done = pause_bookkeeping(&state.app_dir);
            let _commit = match original {
                Some(stamp) => Some(state.account_lifecycle.try_commit(&[stamp]).map_err(|e| format!("{e:?}"))?),
                None => None,
            };
            common::with_vault_write(&state, |_root| graph_ledger::allocate_in(&ledger, &root, &account, &mailbox, &listed))
        })
        .await
        .map_err(LocalError::Io)?
        .map_err(vault_error)
    }

    async fn deleted_from_server(&self, folder: &str, uids: &[u32]) {
        if uids.is_empty() {
            return;
        }
        let (state, account, mailbox, gone) =
            (Arc::clone(&self.state), self.account_id.clone(), folder.to_string(), uids.to_vec());
        let owner = self.owner.clone();
        let r = common::blocking(move || {
            let _owner = owner;
            #[cfg(test)]
            let _done = pause_bookkeeping(&state.app_dir);
            crate::classification::forget_at(&state.app_dir, &account, &mailbox, &gone);
            crate::custody::with_conn(&state, |c| {
                mailvault_core::custody::cache::remove_headers(c, &account, &mailbox, &gone)?;
                // The vault copy is now the only one, as after any other
                // delete this app makes (`bulk_delete_emails`).
                crate::handlers::archive::stamp_server_deleted(c, &account, &mailbox, &gone)
            })
        })
        .await;
        match r {
            Ok(Ok(_)) => {}
            Ok(Err(e)) | Err(e) => warn!("abd: header rows of deleted mail not dropped or stamped: {e}"),
        }
        // A reminder on a copy that left the server ends with it.
        match &self.owner {
            Some(owner) => crate::handlers::archive::end_follow_ups_at_owned(&self.state, &self.account_id, folder, uids, owner).await,
            None => crate::handlers::archive::end_follow_ups_at(&self.state, &self.account_id, folder, uids).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn p5_archive_custody_child_outlives_destroyed_parent() {
        struct Drain { release: Option<std::sync::mpsc::Sender<()>>, done: Option<std::sync::mpsc::Receiver<()>> }
        impl Drain {
            fn finish(&mut self) {
                let _ = self.release.take().unwrap().send(());
                if self.done.take().unwrap().recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
            }
        }
        impl Drop for Drain {
            fn drop(&mut self) {
                if let Some(release) = self.release.take() { let _ = release.send(()); }
                if let Some(done) = self.done.take() {
                    if done.recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
                }
            }
        }
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        std::fs::write(app_dir.path().join("accounts.json"), r#"[{"id":"a","email":"a@test.com"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(app_dir.path())).unwrap());
        let original = state.account_lifecycle.capture("a").unwrap();
        let owner = state.account_lifecycle.try_operation(&[original.clone()]).unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        lock(bookkeeping_pauses()).insert(app_dir.path().to_path_buf(), BookkeepingPause { entered: entered_tx, release: release_rx, done: done_tx, panic_after: false });
        let mut drain = Drain { release: Some(release_tx), done: Some(done_rx) };
        let local = DaemonLocal::new(Arc::clone(&state), "a", "a@test.com").with_owner(original, owner);
        let task = tokio::spawn(async move {
            local.store_archived("INBOX", 7, Fetched { raw: b"Message-ID: <p5@t.test>\r\n\r\nbody".to_vec(), ..Default::default() }).await
        });
        assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "actual custody append child did not start");
        assert!(maildir::archived_file_map(&mailvault_core::vault_files::cur_path(vault.path(), "a", "INBOX")).contains_key(&7),
            "real archive file must precede custody child");
        task.abort();
        assert!(task.await.err().is_some_and(|e| e.is_cancelled()), "parent future must be destroyed");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        assert!(matches!(state.account_lifecycle.try_close(lease, "a"), Err(crate::account_lifecycle::LifecycleError::Busy)),
            "custody child must retain A after parent destruction");
        drain.finish();
        let rows = crate::custody::with_conn(&state, |c| mailvault_core::custody::entries::read(c, "a", "INBOX")).unwrap().unwrap_or_default();
        assert!(rows.contains("\"uid\":7"), "actual custody SQL must write after parent destruction: {rows}");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let lease = crate::account_workflows::AccountLease::detached_for_test(
                    crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
                );
                if let Ok(claim) = state.account_lifecycle.try_close(lease, "a") { drop(claim); break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("custody child owner did not drain");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn p5_ledger_and_delete_bookkeeping_children_keep_owner() {
        struct Drain { release: Option<std::sync::mpsc::Sender<()>>, done: Option<std::sync::mpsc::Receiver<()>> }
        impl Drain {
            fn finish(&mut self) {
                let _ = self.release.take().unwrap().send(());
                if self.done.take().unwrap().recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
            }
        }
        impl Drop for Drain {
            fn drop(&mut self) {
                if let Some(release) = self.release.take() { let _ = release.send(()); }
                if let Some(done) = self.done.take() {
                    if done.recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
                }
            }
        }
        for jmap in [false, true] {
            let vault = tempfile::tempdir().unwrap();
            let app_dir = tempfile::tempdir().unwrap();
            let state = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
            std::fs::write(app_dir.path().join("accounts.json"), r#"[{"id":"a","email":"a@test.com"}]"#).unwrap();
            state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(app_dir.path())).unwrap());
            let cur = mailvault_core::vault_files::cur_path(vault.path(), "a", "INBOX");
            std::fs::create_dir_all(&cur).unwrap();
            std::fs::write(cur.join(mailvault_core::vault_files::build_maildir_filename(42, &[])), b"Message-ID: <adopt@t.test>\r\n\r\nbody").unwrap();
            let original = state.account_lifecycle.capture("a").unwrap();
            let owner = state.account_lifecycle.try_operation(&[original.clone()]).unwrap();
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            lock(bookkeeping_pauses()).insert(app_dir.path().to_path_buf(), BookkeepingPause { entered: entered_tx, release: release_rx, done: done_tx, panic_after: false });
            let mut drain = Drain { release: Some(release_tx), done: Some(done_rx) };
            let local = DaemonLocal::new(Arc::clone(&state), "a", "a@test.com").with_owner(original, owner).with_jmap(jmap);
            let id = if jmap { "jid" } else { "gid" };
            let listed = vec![(id.to_string(), Some("<adopt@t.test>".to_string()))];
            let task = tokio::spawn(async move { local.graph_uids("INBOX", &listed).await });
            assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "actual ledger child did not start");
            task.abort();
            assert!(task.await.err().is_some_and(|e| e.is_cancelled()));
            let lease = crate::account_workflows::AccountLease::detached_for_test(
                crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
            );
            assert!(matches!(state.account_lifecycle.try_close(lease, "a"), Err(crate::account_lifecycle::LifecycleError::Busy)),
                "ledger child must own A after parent drop");
            drain.finish();
            let path = graph_ledger::ledger_path(&header_cache::sidecar_dir(vault.path(), "a", "INBOX"), jmap);
            let ledger = graph_ledger::load(&path).unwrap();
            let assigned = ledger.iter().find_map(|(uid, value)| (value == id).then_some(*uid));
            assert_eq!(assigned, Some(if jmap { 43 } else { 42 }), "Graph adopts Message-ID; JMAP does not");
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let lease = crate::account_workflows::AccountLease::detached_for_test(
                        crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
                    );
                    if let Ok(claim) = state.account_lifecycle.try_close(lease, "a") { drop(claim); break; }
                    tokio::task::yield_now().await;
                }
            }).await.expect("ledger child owner did not drain");
        }

        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        std::fs::write(app_dir.path().join("accounts.json"), r#"[{"id":"a","email":"a@test.com"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(app_dir.path())).unwrap());
        crate::classification::seed_for_test(&state.app_dir, "a", &[("<5>", "INBOX", 5)]);
        crate::custody::with_conn(&state, |c| mailvault_core::custody::entries::upsert(c, "a", "INBOX", &[serde_json::json!({"uid": 5, "source": "local"})])).unwrap();
        mailvault_core::app_db::with(&state.app_dir, |c| {
            mailvault_core::app_db::follow_up::insert(c, "p5", "a", "<5>", "", "", "INBOX", &[], 1, 2)?;
            mailvault_core::app_db::follow_up::record_outcome(c, "p5", &mailvault_core::app_db::follow_up::Outcome::NoReply { sent_mailbox: "INBOX".into(), sent_uid: 5 }, 3)?;
            Ok(())
        }).unwrap();
        let original = state.account_lifecycle.capture("a").unwrap();
        let owner = state.account_lifecycle.try_operation(&[original.clone()]).unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        lock(bookkeeping_pauses()).insert(app_dir.path().to_path_buf(), BookkeepingPause { entered: entered_tx, release: release_rx, done: done_tx, panic_after: false });
        let mut drain = Drain { release: Some(release_tx), done: Some(done_rx) };
        let local = DaemonLocal::new(Arc::clone(&state), "a", "a@test.com").with_owner(original, owner);
        let task = tokio::spawn(async move { local.deleted_from_server("INBOX", &[5]).await });
        assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "actual delete SQL child did not start");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        assert!(matches!(state.account_lifecycle.try_close(lease, "a"), Err(crate::account_lifecycle::LifecycleError::Busy)));
        drain.finish();
        task.await.unwrap();
        assert!(crate::classification::keys_for_test(&state.app_dir, "a").is_empty());
        let rows = crate::custody::with_conn(&state, |c| mailvault_core::custody::entries::read(c, "a", "INBOX")).unwrap().unwrap_or_default();
        assert!(rows.contains("\"serverDeleted\":true"), "actual custody stamp missing: {rows}");
        let follow = mailvault_core::app_db::with(&state.app_dir, |c| mailvault_core::app_db::follow_up::get(c, "p5")).unwrap().unwrap();
        assert_eq!(follow.state, "dismissed", "owned follow-up child must complete");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        assert!(state.account_lifecycle.try_close(lease, "a").is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn p5_mirror_timeout_child_outlives_terminal_frame() {
        struct Drain {
            release: Option<std::sync::mpsc::Sender<()>>,
            done: Option<std::sync::mpsc::Receiver<()>>,
        }
        impl Drain {
            fn finish(&mut self) {
                let _ = self.release.take().unwrap().send(());
                if self.done.take().unwrap().recv_timeout(Duration::from_secs(5)).is_err() {
                    std::process::abort();
                }
            }
        }
        impl Drop for Drain {
            fn drop(&mut self) {
                if let Some(release) = self.release.take() { let _ = release.send(()); }
                if let Some(done) = self.done.take() {
                    if done.recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
                }
            }
        }
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        std::fs::write(app_dir.path().join("accounts.json"), r#"[{"id":"a","email":"a@test.com"},{"id":"b","email":"b@test.com"}]"#).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(app_dir.path())).unwrap());
        let original = state.account_lifecycle.capture("a").unwrap();
        let owner = state.account_lifecycle.try_operation(&[original.clone()]).unwrap();
        let cur = mailvault_core::vault_files::cur_path(vault.path(), "a", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let source = cur.join(mailvault_core::vault_files::build_maildir_filename(7, &[]));
        let bytes = b"Message-ID: <p5@t.test>\r\n\r\nbody";
        std::fs::write(&source, bytes).unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        lock(mirror_pauses()).insert(app_dir.path().to_path_buf(), MirrorPause { entered: entered_tx, release: release_rx, done: done_tx });
        let mut drain = Drain { release: Some(release_tx), done: Some(done_rx) };
        let local = DaemonLocal::new(Arc::clone(&state), "a", "a@test.com")
            .with_owner(original, owner)
            .with_mirror(Some(mirror.path().to_path_buf()));
        let task = tokio::spawn(async move {
            let listing = HashMap::from([(7, source)]);
            local.mirror_copy_verify("INBOX", &listing, &[7]).await
        });
        assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "real mirror child did not start");
        task.abort();
        assert!(task.await.err().is_some_and(|e| e.is_cancelled()), "parent future must be destroyed");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        let close = state.account_lifecycle.try_close(lease, "a");
        let busy = matches!(&close, Err(crate::account_lifecycle::LifecycleError::Busy));
        if let Ok(mut claim) = close {
            let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
            claim.mark_effects_started(drained).unwrap();
            claim.finish_retired().unwrap();
        }
        drain.finish();
        let destination = maildir::mirror_cur(mirror.path(), "a@test.com", "INBOX").unwrap();
        let copies = maildir::mirror_file_map(&destination);
        assert_eq!(std::fs::read(copies.get(&7).expect("real mirror copy after parent destruction")).unwrap(), bytes);
        assert!(busy, "mirror child wrote real bytes after A retired");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        assert!(state.account_lifecycle.try_close(lease, "a").is_ok());
        assert!(state.account_lifecycle.try_operation(&[state.account_lifecycle.capture("b").unwrap()]).is_ok());

        let copied = copies.get(&7).unwrap().clone();
        let expected_name = copied.file_name().unwrap().to_string_lossy().to_string();
        let renamed = destination.join(mailvault_core::vault_files::build_maildir_filename(7, &["seen".to_string()]));
        std::fs::rename(&copied, &renamed).unwrap();
        let original = state.account_lifecycle.capture("a").unwrap();
        let owner = state.account_lifecycle.try_operation(&[original.clone()]).unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        lock(mirror_pauses()).insert(app_dir.path().to_path_buf(), MirrorPause { entered: entered_tx, release: release_rx, done: done_tx });
        let mut drain = Drain { release: Some(release_tx), done: Some(done_rx) };
        let local = DaemonLocal::new(Arc::clone(&state), "a", "a@test.com")
            .with_owner(original, owner)
            .with_mirror(Some(mirror.path().to_path_buf()));
        let task = tokio::spawn(async move {
            local.mirror_verify_paths("INBOX", &[(7, expected_name)], &HashMap::from([(7, "<p5@t.test>".to_string())])).await
        });
        assert!(entered_rx.recv_timeout(Duration::from_secs(5)).is_ok(), "real mirror verify child did not start");
        task.abort();
        assert!(task.await.err().is_some_and(|e| e.is_cancelled()));
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
        );
        assert!(matches!(state.account_lifecycle.try_close(lease, "a"), Err(crate::account_lifecycle::LifecycleError::Busy)),
            "mirror verify child must retain A after parent destruction");
        drain.finish();
        assert_eq!(state.abd.test.fallback_scans.load(std::sync::atomic::Ordering::SeqCst), 1,
            "real verify child must inspect the renamed mirror file");
        assert_eq!(std::fs::read(renamed).unwrap(), bytes, "verification never modifies mirror bytes");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let lease = crate::account_workflows::AccountLease::detached_for_test(
                    crate::account_workflows::AccountWriteScope { ids: ["a".to_owned()].into(), ..Default::default() },
                );
                if let Ok(claim) = state.account_lifecycle.try_close(lease, "a") { drop(claim); break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("mirror verify child owner did not drain");
    }

    /// An archive-and-delete job's delete step: the vault copy stays, the
    /// server copy is gone, so Email Cleanup stops listing it.
    #[tokio::test]
    async fn mail_deleted_from_the_server_leaves_email_cleanup() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        crate::classification::seed_for_test(&state.app_dir, "acc", &[("<5>", "INBOX", 5), ("<6>", "INBOX", 6)]);

        DaemonLocal::new(Arc::clone(&state), "acc", "a@b.test").deleted_from_server("INBOX", &[5]).await;

        assert_eq!(crate::classification::keys_for_test(&state.app_dir, "acc"), vec!["<6>".to_string()]);
    }

    /// The vault copy of what the job took from the server is stamped
    /// `serverDeleted`, like after `bulk_delete_emails`; a uid it did not
    /// take is not.
    #[tokio::test]
    async fn mail_deleted_from_the_server_is_stamped_as_the_only_copy() {
        use mailvault_core::custody::entries;
        use serde_json::{json, Value};
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        crate::custody::with_conn(&state, |c| {
            entries::upsert(c, "acc", "INBOX", &[json!({"uid": 5, "source": "local"}), json!({"uid": 6, "source": "local"})])
        })
        .unwrap();

        DaemonLocal::new(Arc::clone(&state), "acc", "a@b.test").deleted_from_server("INBOX", &[5]).await;

        let rows: Vec<Value> =
            serde_json::from_str(&crate::custody::with_conn(&state, |c| entries::read(c, "acc", "INBOX")).unwrap().unwrap()).unwrap();
        let of = |uid: u64| rows.iter().find(|e| e["uid"] == json!(uid)).unwrap().clone();
        assert_eq!(of(5)["serverDeleted"], json!(true));
        assert!(of(6).get("serverDeleted").is_none());
    }
}
