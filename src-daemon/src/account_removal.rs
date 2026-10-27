//! One finite, claim-owned account retirement. Started children finish under
//! the claim even if the RPC waiter disappears.
use crate::account_lifecycle::{LifecycleError, PersistenceAuthority, RemovalClaim};
use crate::account_workflows::{AccountLease, AccountWriteScope};
use crate::credentials::{self, CredChange};
use crate::handlers::common::{vault_root, with_vault_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::accounts_doc::{self, Listing, LiveScrub};
use mailvault_core::app_db::{self, compose_receipts, follow_up};
use mailvault_core::custody::cache as sql_cache;
use mailvault_core::json_doc::Change;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

const OVERALL: Duration = Duration::from_secs(180);
const DRAIN: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage { Pre, Expired, Receipt, Document, Credentials, Local, Bookkeeping }
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Pre | Self::Expired | Self::Receipt => "receipt",
            Self::Document => "document",
            Self::Credentials => "credentials",
            Self::Local => "local",
            Self::Bookkeeping => "bookkeeping",
        }
    }
}
struct Control { stage: Stage, waiter_alive: bool }
type Progress = Arc<Mutex<Control>>;
struct Waiter(Progress);
impl Drop for Waiter {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).waiter_alive = false;
    }
}

#[cfg(test)]
struct Gate {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
    done: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
fn receipt_gates() -> &'static Mutex<HashMap<PathBuf, Gate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<PathBuf, Gate>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn document_gates() -> &'static Mutex<HashMap<PathBuf, Gate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<PathBuf, Gate>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn local_gates() -> &'static Mutex<HashMap<PathBuf, Gate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<PathBuf, Gate>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn exclusion_gates() -> &'static Mutex<HashMap<PathBuf, Gate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<PathBuf, Gate>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn unlink_gates() -> &'static Mutex<HashMap<PathBuf, Gate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<PathBuf, Gate>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn owned_done() -> &'static Mutex<HashMap<PathBuf, std::sync::mpsc::Sender<()>>> {
    static G: std::sync::OnceLock<Mutex<HashMap<PathBuf, std::sync::mpsc::Sender<()>>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn fail_after_tree() -> &'static Mutex<BTreeSet<PathBuf>> {
    static G: std::sync::OnceLock<Mutex<BTreeSet<PathBuf>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn pause_gate(gates: &Mutex<HashMap<PathBuf, Gate>>, path: &Path) -> Option<credentials::TestTaskDone> {
    gates.lock().unwrap_or_else(|e| e.into_inner()).remove(path).map(|gate| {
        let _ = gate.entered.send(());
        let _ = gate.release.recv();
        credentials::TestTaskDone(gate.done)
    })
}
#[cfg(test)]
fn pause_receipt(path: &Path) -> Option<credentials::TestTaskDone> {
    pause_gate(receipt_gates(), path)
}
#[cfg(test)]
fn pause_document(path: &Path) -> Option<credentials::TestTaskDone> {
    pause_gate(document_gates(), path)
}
#[cfg(test)]
fn pause_local(path: &Path) -> Option<credentials::TestTaskDone> {
    pause_gate(local_gates(), path)
}
#[cfg(test)]
fn pause_exclusion(path: &Path) -> Option<credentials::TestTaskDone> {
    pause_gate(exclusion_gates(), path)
}
#[cfg(test)]
fn pause_unlink(path: &Path) -> Option<credentials::TestTaskDone> {
    pause_gate(unlink_gates(), path)
}

fn valid_id(id: &str) -> bool {
    if id.is_empty() || id == "." || id == ".." || id.ends_with('.') || id.ends_with(' ')
        || id.chars().any(|c| c.is_control() || "/\\:<>\"|?*".contains(c)) {
        return false;
    }
    let stem = id.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
}

fn busy(id: &str) -> Value { json!({"outcome":"busy","accountId":id,"effects":"none"}) }
fn incomplete(id: &str, stage: Stage, completion: &str, retry: &str, residuals: &[&str]) -> Value {
    json!({"outcome":"incomplete","accountId":id,"stage":stage.name(),
        "completion":completion,"retry":retry,"residuals":residuals})
}
fn uncertain(id: &str, stage: Stage) -> Value {
    incomplete(id, stage, "unknown", "afterSettlement",
        &["accountTree", "headerCache", "mailboxCache", "custody", "followUps"])
}
fn failed(id: &str, stage: Stage, residuals: &[&str]) -> Value {
    incomplete(id, stage, "failed", "explicit", residuals)
}

#[derive(Clone)]
struct RootProof {
    configured: PathBuf,
    canonical: PathBuf,
    identity: FsIdentity,
}
impl RootProof {
    fn read(state: &Arc<DaemonState>) -> Result<Self, String> {
        let configured = vault_root(state)?;
        let canonical = fs::canonicalize(&configured).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        let metadata = fs::metadata(&configured).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        if !metadata.is_dir() { return Err("errors.vaultUnavailable".into()); }
        let identity = fs_identity(&canonical)?.ok_or("errors.vaultUnavailable")?;
        Ok(Self { configured, canonical, identity })
    }
    fn check(&self, state: &Arc<DaemonState>, root: &Path) -> Result<(), String> {
        if root != self.configured || vault_root(state)? != self.configured
            || fs::canonicalize(root).ok().as_deref() != Some(self.canonical.as_path()) {
            return Err("errors.vaultUnavailable".into());
        }
        let metadata = fs::metadata(root).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        if !metadata.is_dir() || fs_identity(&self.canonical)? != Some(self.identity) {
            return Err("errors.vaultUnavailable".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FsIdentity {
    #[cfg(unix)]
    Unix(u64, u64),
    #[cfg(windows)]
    Windows(u64, [u8; 16]),
}

fn fs_identity(path: &Path) -> Result<Option<FsIdentity>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("errors.vaultUnavailable".into()),
    };
    if metadata.file_type().is_symlink() { return Err("errors.vaultUnavailable".into()); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(FsIdentity::Unix(metadata.dev(), metadata.ino())))
    }
    #[cfg(windows)]
    {
        windows_file_identity(path).map(Some)
    }
}

#[cfg(windows)]
fn windows_file_identity(path: &Path) -> Result<FsIdentity, String> {
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    // FILE_ID_INFO / FileIdInfo from Win32 FileSystem. The volume serial is
    // part of the identity: a directory on a replacement volume may have the
    // same pathname and file index as the original.
    #[repr(C)]
    struct FileIdInfo { volume_serial: u64, file_id: [u8; 16] }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(handle: *mut c_void, class: i32,
            information: *mut c_void, size: u32) -> i32;
    }
    const FILE_ID_INFO_CLASS: i32 = 18;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let file = fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path).map_err(|_| "errors.vaultUnavailable".to_owned())?;
    let mut info = MaybeUninit::<FileIdInfo>::uninit();
    let ok = unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), FILE_ID_INFO_CLASS,
        info.as_mut_ptr().cast(), size_of::<FileIdInfo>() as u32) };
    if ok == 0 { return Err("errors.vaultUnavailable".into()); }
    let info = unsafe { info.assume_init() };
    if info.file_id == [0; 16] { return Err("errors.vaultUnavailable".into()); }
    Ok(FsIdentity::Windows(info.volume_serial, info.file_id))
}

fn no_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("errors.vaultUnavailable".into()),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("errors.vaultUnavailable".into()),
    }
}
fn paths(root: &Path, id: &str) -> Result<(), String> {
    for path in [root.join("Maildir"), root.join("Maildir").join(id),
        root.join("email_cache"), root.join("mailboxes"), root.join("mailboxes").join(id)] {
        no_symlink(&path)?;
    }
    for path in [root.join("Maildir"), root.join("email_cache"), root.join("mailboxes")] {
        if path.exists() && !path.is_dir() { return Err("errors.vaultUnavailable".into()); }
    }
    Ok(())
}

fn exact_entry(parent: &Path, name: &str) -> Result<bool, String> {
    let entries = fs::read_dir(parent).map_err(|_| "errors.vaultUnavailable".to_owned())?;
    for entry in entries {
        if entry.map_err(|_| "errors.vaultUnavailable".to_owned())?.file_name() == name {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Clone)]
struct PathProof {
    path: PathBuf,
    identity: Option<FsIdentity>,
    directory: bool,
    exact_name: Option<String>,
}
impl PathProof {
    fn capture(path: PathBuf, directory: bool, exact_name: Option<&str>) -> Result<Self, String> {
        let identity = fs_identity(&path)?;
        if identity.is_some() {
            if directory && !fs::metadata(&path).map_err(|_| "errors.vaultUnavailable".to_owned())?.is_dir() {
                return Err("errors.vaultUnavailable".into());
            }
            if let Some(name) = exact_name {
                let parent = path.parent().ok_or("errors.vaultUnavailable")?;
                if !exact_entry(parent, name)? { return Err("errors.vaultUnavailable".into()); }
            }
        }
        Ok(Self { path, identity, directory, exact_name: exact_name.map(str::to_owned) })
    }
    fn check(&self) -> Result<(), String> {
        let current = Self::capture(self.path.clone(), self.directory, self.exact_name.as_deref())?;
        if current.identity != self.identity { return Err("errors.vaultUnavailable".into()); }
        Ok(())
    }
}

fn sanitize(id: &str) -> String { id.replace(|c: char| !c.is_alphanumeric(), "_") }
fn cache_candidate(name: &str, id: &str) -> bool {
    let sanitized = sanitize(id);
    name == sanitized || name.starts_with(&format!("{sanitized}_"))
}
fn child_names(parent: &Path) -> Result<BTreeSet<String>, String> {
    if !parent.exists() { return Ok(BTreeSet::new()); }
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(parent).map_err(|_| "errors.vaultUnavailable".to_owned())? {
        let entry = entry.map_err(|_| "errors.vaultUnavailable".to_owned())?;
        let name = entry.file_name().into_string().map_err(|_| "errors.vaultUnavailable".to_owned())?;
        names.insert(name);
    }
    Ok(names)
}
fn check_shared_child(parent: &Path, selected: Option<FsIdentity>, others: &BTreeSet<String>) -> Result<(), String> {
    let Some(selected) = selected else { return Ok(()); };
    for other in others {
        if !valid_id(other) || fs_identity(&parent.join(other))? == Some(selected) {
            return Err("errors.vaultUnavailable".into());
        }
    }
    Ok(())
}

fn account_bound_cache_projection(state: &Arc<DaemonState>, id: &str)
    -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    crate::custody::with_conn(state, |conn| {
        let mut projected = BTreeSet::new();
        let mut paths = conn.prepare_cached(
            "SELECT mailbox_path FROM header_cache WHERE account_id=?1
             UNION SELECT mailbox_path FROM header_cache_meta WHERE account_id=?1"
        ).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        let rows = paths.query_map([id], |row| row.get::<_, String>(0))
            .map_err(|_| "errors.vaultUnavailable".to_owned())?;
        for row in rows {
            let mailbox = row.map_err(|_| "errors.vaultUnavailable".to_owned())?;
            projected.insert(mailvault_core::header_cache::cache_base_name(id, &mailbox));
        }
        let mut account_ids = BTreeSet::new();
        let mut ids = conn.prepare_cached(
            "SELECT account_id FROM header_cache UNION SELECT account_id FROM header_cache_meta
             UNION SELECT account_id FROM mailbox_cache UNION SELECT account_id FROM vault_entries"
        ).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        let rows = ids.query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "errors.vaultUnavailable".to_owned())?;
        for row in rows {
            account_ids.insert(row.map_err(|_| "errors.vaultUnavailable".to_owned())?);
        }
        Ok((projected, account_ids))
    }).map_err(|_| "errors.vaultUnavailable".to_owned())
}

struct FreshLocalProof {
    ids: BTreeSet<String>,
    projected: BTreeSet<String>,
    credential_generation: u64,
    custody_generation: u64,
}
fn fresh_local_proof(state: &Arc<DaemonState>, id: &str, deadline: Instant)
    -> Result<FreshLocalProof, String> {
    let listed = accounts_doc::list(&accounts_doc::shared(&state.app_dir))
        .map_err(|_| "errors.accountsWriteFailed".to_owned())?;
    if listed.recovered.is_some() { return Err("errors.accountsWriteFailed".into()); }
    let snapshot = tokio::runtime::Handle::current()
        .block_on(credentials::read_account_removal_snapshot_quiet(deadline))
        .map_err(|_| "errors.keychainUnavailable".to_owned())?;
    let before = state.custody.gen.load(std::sync::atomic::Ordering::Acquire);
    let (projected, custody_ids) = account_bound_cache_projection(state, id)?;
    let custody_generation = state.custody.gen.load(std::sync::atomic::Ordering::Acquire);
    if before != custody_generation || snapshot.generation != credentials::write_generation() {
        return Err("errors.vaultUnavailable".into());
    }
    let mut ids: BTreeSet<String> = listed.accounts.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str)).map(str::to_owned).collect();
    ids.extend(snapshot.records.keys().cloned());
    ids.extend(custody_ids);
    ids.remove(id);
    Ok(FreshLocalProof { ids, projected, credential_generation: snapshot.generation,
        custody_generation })
}

fn cache_names(dir: &Path, id: &str, projected: &BTreeSet<String>) -> Result<BTreeSet<String>, String> {
    let names: BTreeSet<String> = child_names(dir)?.into_iter()
        .filter(|name| cache_candidate(name, id)).collect();
    // A projected child that resolves through a differently spelled entry is
    // an alias, not an exact cache child owned by this account.
    for name in projected {
        if fs_identity(&dir.join(name))?.is_some() && !names.contains(name) {
            return Err("errors.vaultUnavailable".into());
        }
    }
    Ok(names)
}

fn cache_shared(dir: &Path, name: &str, identity: FsIdentity,
    others: &BTreeSet<String>) -> Result<(bool, bool), String> {
    let mut named_sibling = false;
    for other in others {
        if !valid_id(other) { return Err("errors.vaultUnavailable".into()); }
        let sanitized = sanitize(other);
        named_sibling |= name == sanitized || name.starts_with(&format!("{sanitized}_"));
        // Any underscore can separate the other ID from its mailbox. This
        // catches case aliases even when the IDs have different lengths.
        for (index, byte) in name.bytes().enumerate().filter(|(_, byte)| *byte == b'_') {
            let alternate = format!("{sanitized}_{}", &name[index + 1..]);
            if alternate != name && fs_identity(&dir.join(alternate))? == Some(identity) {
                return Ok((named_sibling, true));
            }
        }
    }
    Ok((named_sibling, false))
}

#[derive(Clone)]
struct SidecarProof { name: String, path: PathProof, owned: bool }
#[derive(Clone)]
struct LocalProof {
    maildir: PathProof,
    tree: PathProof,
    cache: PathProof,
    sidecars: Vec<SidecarProof>,
    mailboxes: PathProof,
    mailbox: PathProof,
    projected: BTreeSet<String>,
    other_ids: BTreeSet<String>,
}
impl LocalProof {
    fn known_ids(&self, id: &str, fresh: &BTreeSet<String>) -> Result<BTreeSet<String>, String> {
        let mut known = self.other_ids.clone();
        known.extend(fresh.iter().cloned());
        known.extend(child_names(&self.maildir.path)?);
        known.extend(child_names(&self.mailboxes.path)?);
        known.remove(id);
        Ok(known)
    }
    fn capture(root: &Path, id: &str, mut other_ids: BTreeSet<String>,
        projected: BTreeSet<String>) -> Result<Self, String> {
        paths(root, id)?;
        let maildir = PathProof::capture(root.join("Maildir"), true, Some("Maildir"))?;
        let tree = PathProof::capture(maildir.path.join(id), true, Some(id))?;
        let cache = PathProof::capture(root.join("email_cache"), true, Some("email_cache"))?;
        let mailboxes = PathProof::capture(root.join("mailboxes"), true, Some("mailboxes"))?;
        let mailbox = PathProof::capture(mailboxes.path.join(id), true, Some(id))?;
        other_ids.extend(child_names(&maildir.path)?);
        other_ids.extend(child_names(&mailboxes.path)?);
        other_ids.remove(id);
        check_shared_child(&maildir.path, tree.identity, &other_ids)?;
        check_shared_child(&mailboxes.path, mailbox.identity, &other_ids)?;
        let lock = mailvault_core::header_cache::lock_tree(root);
        let _held = lock.read().unwrap_or_else(|error| error.into_inner());
        let mut sidecars = Vec::new();
        for name in cache_names(&cache.path, id, &projected)? {
            let path = PathProof::capture(cache.path.join(&name), false, Some(&name))?;
            let identity = path.identity.ok_or("errors.vaultUnavailable")?;
            let (named_sibling, physical_alias) = cache_shared(&cache.path, &name, identity, &other_ids)?;
            if physical_alias { return Err("errors.vaultUnavailable".into()); }
            let owned = projected.contains(&name) && !named_sibling;
            sidecars.push(SidecarProof { name, path, owned });
        }
        Ok(Self { maildir, tree, cache, sidecars, mailboxes, mailbox, projected, other_ids })
    }
    fn check_sidecars_locked(&self, id: &str, known: &BTreeSet<String>) -> Result<(), String> {
        self.cache.check()?;
        let names = cache_names(&self.cache.path, id, &self.projected)?;
        if names != self.sidecars.iter().map(|sidecar| sidecar.name.clone()).collect() {
            return Err("errors.vaultUnavailable".into());
        }
        for sidecar in &self.sidecars {
            sidecar.path.check()?;
            let (named_sibling, physical_alias) = cache_shared(&self.cache.path, &sidecar.name,
                sidecar.path.identity.ok_or("errors.vaultUnavailable")?, known)?;
            if physical_alias || (sidecar.owned && named_sibling) {
                return Err("errors.vaultUnavailable".into());
            }
        }
        Ok(())
    }
    fn check(&self, root: &Path, id: &str, fresh: &FreshLocalProof) -> Result<(), String> {
        self.maildir.check()?;
        self.tree.check()?;
        self.mailboxes.check()?;
        self.mailbox.check()?;
        let known = self.known_ids(id, &fresh.ids)?;
        check_shared_child(&self.maildir.path, self.tree.identity, &known)?;
        check_shared_child(&self.mailboxes.path, self.mailbox.identity, &known)?;
        if self.sidecars.iter().any(|sidecar| sidecar.owned && !fresh.projected.contains(&sidecar.name)) {
            return Err("errors.vaultUnavailable".into());
        }
        let lock = mailvault_core::header_cache::lock_tree(root);
        let _held = lock.read().unwrap_or_else(|error| error.into_inner());
        self.check_sidecars_locked(id, &known)
    }
}

async fn actual<T: Send + 'static>(deadline: Instant,
    mut child: tokio::task::JoinHandle<Result<T, String>>) -> Result<T, &'static str> {
    match tokio::time::timeout_at(deadline, &mut child).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(_))) => Err("failed"),
        Ok(Err(_)) => Err("unknown"),
        Err(_) => { let _ = child.await; Err("unknown") }
    }
}
fn stage_failure(id: &str, stage: Stage, kind: &str, residuals: &[&str]) -> Value {
    if kind == "unknown" { uncertain(id, stage) } else { failed(id, stage, residuals) }
}
fn advance(progress: &Progress, stage: Stage, deadline: Instant) -> bool {
    let mut current = progress.lock().unwrap_or_else(|e| e.into_inner());
    if !current.waiter_alive || current.stage == Stage::Expired || Instant::now() >= deadline { return false; }
    current.stage = stage;
    true
}
fn may_start(progress: &Progress, deadline: Instant) -> bool {
    let current = progress.lock().unwrap_or_else(|e| e.into_inner());
    current.waiter_alive && current.stage != Stage::Expired && Instant::now() < deadline
}

pub(crate) async fn route(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let Some(account_id) = params.as_object().filter(|p| p.len() == 1)
        .and_then(|p| p.get("accountId")).and_then(Value::as_str)
        .filter(|id| valid_id(id)) else {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
    };
    let account_id = account_id.to_owned();
    let deadline = Instant::now() + OVERALL;
    let progress = Arc::new(Mutex::new(Control { stage: Stage::Pre, waiter_alive: true }));
    let _waiter = Waiter(Arc::clone(&progress));
    let mut task = tokio::spawn(remove_owned(Arc::clone(state), account_id.clone(), deadline, Arc::clone(&progress)));
    match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(Ok(Ok(result))) => RpcResponse::success(id, result),
        Ok(Ok(Err(error))) => RpcResponse::error(id, ipc::INTERNAL_ERROR, error),
        Ok(Err(_)) => RpcResponse::success(id, uncertain(&account_id, progress.lock().unwrap_or_else(|e| e.into_inner()).stage)),
        Err(_) => {
            let mut current = progress.lock().unwrap_or_else(|e| e.into_inner());
            let result = if current.stage == Stage::Pre {
                current.stage = Stage::Expired;
                busy(&account_id)
            } else { uncertain(&account_id, current.stage) };
            RpcResponse::success(id, result)
        }
    }
}

async fn remove_owned(state: Arc<DaemonState>, id: String, deadline: Instant,
    progress: Progress) -> Result<Value, String> {
    #[cfg(test)]
    let _done = owned_done().lock().unwrap_or_else(|e| e.into_inner())
        .remove(&state.app_dir).map(credentials::TestTaskDone);
    let root = RootProof::read(&state)?;
    paths(&root.configured, &id)?;
    let doc = accounts_doc::shared(&state.app_dir);
    let read = Arc::clone(&doc);
    let listed = tokio::task::spawn_blocking(move || accounts_doc::list(&read))
        .await.map_err(|_| "errors.accountsWriteFailed".to_owned())?
        .map_err(|e| e.catalog_key().to_owned())?;
    if listed.recovered.is_some() { return Err("errors.accountsWriteFailed".into()); }
    if listed.accounts.iter().filter(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str())).count() > 1 {
        return Err("errors.accountsInvalid".into());
    }
    let snapshot = tokio::time::timeout_at(deadline, credentials::read_account_save_snapshot())
        .await.map_err(|_| "errors.keychainUnavailable".to_owned())?
        .map_err(|e| e.catalog_key().to_owned())?;
    let (projected, custody_ids) = account_bound_cache_projection(&state, &id)?;
    let mut other_ids: BTreeSet<String> = listed.accounts.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str)).map(str::to_owned).collect();
    other_ids.extend(snapshot.records.keys().cloned());
    other_ids.extend(custody_ids);
    other_ids.remove(&id);
    let local_proof = with_vault_write(&state, |current| {
        root.check(&state, current)?;
        LocalProof::capture(current, &id, other_ids, projected)
    })?;
    let mut scope = AccountWriteScope::default();
    scope.ids.insert(id.clone());
    let legacy = accounts_doc::legacy_secrets(&listed.accounts);
    let legacy_ids: BTreeSet<&str> = legacy.iter().map(|(legacy_id, _)| legacy_id.as_str()).collect();
    for row in &listed.accounts {
        if let Some(row_id) = row.get("id").and_then(Value::as_str) {
            if row_id == id || legacy_ids.contains(row_id) {
                scope.record(row_id, row);
            }
        }
    }
    for (record_id, raw) in &snapshot.records {
        if record_id == &id || legacy_ids.contains(record_id.as_str()) {
            let value: Value = serde_json::from_str(raw).map_err(|_| "errors.credentialsInvalid".to_owned())?;
            if !value.is_object() { return Err("errors.credentialsInvalid".into()); }
            scope.record(record_id, &value);
        }
    }
    for (record_id, raw) in &legacy {
        if record_id != &id {
            let value: Value = serde_json::from_str(raw).map_err(|_| "errors.credentialsInvalid".to_owned())?;
            scope.record(record_id, &value);
        }
    }
    let lease = match state.account_admission.try_reserve(scope) {
        Ok(lease) => lease,
        Err(_) => {
            tracing::info!("S24_REMOVE_BUSY stage=admission");
            return Ok(busy(&id));
        }
    };
    let reread = Arc::clone(&doc);
    let fresh = tokio::task::spawn_blocking(move || accounts_doc::list(&reread)).await;
    if !matches!(fresh, Ok(Ok(ref current)) if current == &listed && current.recovered.is_none()) {
        tracing::info!("S24_REMOVE_BUSY stage=fresh_proof");
        return Ok(busy(&id));
    }
    let mut claim = match state.account_lifecycle.try_close(lease.clone(), &id) {
        Ok(claim) => claim,
        Err(LifecycleError::Unknown) => match state.account_lifecycle.try_close_absent(lease.clone(), &id, &listed) {
            Ok(claim) => claim,
            Err(_) => {
                tracing::info!("S24_REMOVE_BUSY stage=absent_claim");
                return Ok(busy(&id));
            }
        },
        Err(_) => {
            tracing::info!("S24_REMOVE_BUSY stage=lifecycle_claim");
            return Ok(busy(&id));
        }
    };
    let drained = match claim.wait_local_until(std::cmp::min(Instant::now() + DRAIN, deadline)).await {
        Ok(drained) => drained,
        Err(_) => {
            tracing::info!("S24_REMOVE_BUSY stage=local_drain");
            return Ok(busy(&id));
        }
    };
    {
        let mut stage = progress.lock().unwrap_or_else(|e| e.into_inner());
        if !stage.waiter_alive || stage.stage == Stage::Expired || Instant::now() >= deadline {
            tracing::info!("S24_REMOVE_BUSY stage=pre_effect_waiter_or_deadline");
            return Ok(busy(&id));
        }
        if claim.mark_effects_started(drained).is_err() {
            tracing::info!("S24_REMOVE_BUSY stage=pre_effect_claim");
            return Ok(busy(&id));
        }
        stage.stage = Stage::Receipt;
    }
    let claim = Arc::new(claim);
    let app_dir = state.app_dir.clone();
    let receipt_id = id.clone();
    let receipt_claim = Arc::clone(&claim);
    let receipt = tokio::task::spawn_blocking(move || {
        let _claim = receipt_claim;
        #[cfg(test)]
        let _gate = pause_receipt(&app_dir);
        app_db::with(&app_dir, |conn| compose_receipts::remove_account(conn, &receipt_id))
    });
    if let Err(kind) = actual(deadline, receipt).await {
        return Ok(stage_failure(&id, Stage::Receipt, kind,
            &["accountTree", "headerCache", "mailboxCache", "custody", "followUps"]));
    }
    if !advance(&progress, Stage::Document, deadline) {
        return Ok(failed(&id, Stage::Document, &["accountTree", "custody", "followUps"]));
    }
    let document_change = match remove_document(&state, &doc, &listed, &lease, &claim, &id, deadline, &progress).await {
        Ok(change) => change,
        Err(kind) => return Ok(stage_failure(&id, Stage::Document, kind,
            &["accountTree", "headerCache", "mailboxCache", "custody", "followUps"])),
    };
    if !advance(&progress, Stage::Credentials, deadline) {
        return Ok(failed(&id, Stage::Credentials, &["accountTree", "custody", "followUps"]));
    }
    let target = AccountWriteScope { ids: [id.clone()].into(), ..Default::default() };
    let authority = match claim.cleanup_authority() { Ok(a) => a, Err(_) => return Ok(failed(&id, Stage::Credentials, &["accountTree"])) };
    let owner = match state.account_lifecycle.try_persistence(lease.clone(), &target, authority) {
        Ok(owner) => owner,
        Err(_) => return Ok(failed(&id, Stage::Credentials, &["accountTree"]))
    };
    let credential = credentials::change_credentials_admitted_owned_wait_actual(
        &state, CredChange::Delete(vec![id.clone()]), owner, Arc::clone(&claim), deadline).await;
    if let Err(error) = credential {
        let residuals = &["accountTree", "headerCache", "mailboxCache", "custody", "followUps"];
        return Ok(match error {
            credentials::RemovalCredError::Unknown =>
                incomplete(&id, Stage::Credentials, "unknown", "explicit", residuals),
            credentials::RemovalCredError::Failed => failed(&id, Stage::Credentials, residuals),
        });
    }
    if !advance(&progress, Stage::Local, deadline) {
        return Ok(failed(&id, Stage::Local, &["accountTree", "custody", "followUps"]));
    }
    let local_state = Arc::clone(&state);
    let local_id = id.clone();
    let local_root = root.clone();
    let local_paths = local_proof;
    let local_lease = lease.clone();
    let local_progress = Arc::clone(&progress);
    let local_claim = Arc::clone(&claim);
    let local = tokio::task::spawn_blocking(move || {
        let _claim = local_claim;
        cleanup_local(&local_state, &local_root, &local_paths, &local_lease,
            &local_progress, &local_id, deadline)
    });
    let residuals = match actual(deadline, local).await {
        Ok(residuals) => residuals,
        Err(kind) => return Ok(stage_failure(&id, Stage::Local, kind,
            &["accountTree", "headerCache", "mailboxCache", "custody", "followUps"])),
    };
    if !residuals.is_empty() { return Ok(incomplete(&id, Stage::Local, "failed", "explicit", &residuals)); }
    if !advance(&progress, Stage::Bookkeeping, deadline) {
        return Ok(failed(&id, Stage::Bookkeeping, &["followUps"]));
    }
    let idle = Arc::clone(&state);
    let watched = id.clone();
    let watched_claim = Arc::clone(&claim);
    let unwatch = tokio::spawn(async move {
        let _claim = watched_claim;
        idle.idle.unwatch(&watched).await;
        Ok::<_, String>(())
    });
    if let Err(kind) = actual(deadline, unwatch).await {
        return Ok(stage_failure(&id, Stage::Bookkeeping, kind, &["followUps"]));
    }
    let Ok(claim) = Arc::try_unwrap(claim) else {
        return Ok(failed(&id, Stage::Bookkeeping, &["custody"]));
    };
    match claim.finish_retired() {
        Ok(()) => {
            let event = document_change.map(|change| (change.changed, change.version))
                .or_else(|| accounts_doc::list(&doc).ok().map(|listed| (vec![id.clone()], listed.version)));
            if let Some((changed, version)) = event {
                state.events.emit(crate::handlers::accounts::CHANGED_EVENT,
                    json!({"ids":changed,"version":version}));
            }
            Ok(json!({"outcome":"complete","accountId":id}))
        }
        Err(_) => Ok(failed(&id, Stage::Bookkeeping, &["followUps"])),
    }
}

async fn remove_document(state: &Arc<DaemonState>, doc: &Arc<mailvault_core::json_doc::JsonDoc>,
    listed: &Listing, lease: &AccountLease, claim: &Arc<RemovalClaim>, id: &str,
    deadline: Instant, progress: &Progress) -> Result<Option<Change>, &'static str> {
    let representable = accounts_doc::legacy_secrets_representable(&listed.accounts);
    if representable {
        let records: HashMap<String, String> = accounts_doc::legacy_secrets(&listed.accounts)
            .into_iter().filter(|(legacy, _)| legacy != id).collect();
        if !records.is_empty() {
            if !may_start(progress, deadline) { return Err("unknown"); }
            let scope = AccountWriteScope { ids: records.keys().cloned().collect(), ..Default::default() };
            let owner = state.account_lifecycle.try_persistence(lease.clone(), &scope, PersistenceAuthority::Ordinary)
                .map_err(|_| "failed")?;
            credentials::change_credentials_admitted_owned_wait_actual(
                state, CredChange::SaveIfAbsent(records), owner, Arc::clone(claim), deadline).await
                .map_err(|error| match error {
                    credentials::RemovalCredError::Unknown => "unknown",
                    credentials::RemovalCredError::Failed => "failed",
                })?;
        }
    }
    if !may_start(progress, deadline) { return Err("unknown"); }
    let target = AccountWriteScope { ids: [id.to_owned()].into(), ..Default::default() };
    let authority = claim.cleanup_authority().map_err(|_| "failed")?;
    let owner = state.account_lifecycle.try_persistence(lease.clone(), &target, authority)
        .map_err(|_| "failed")?;
    let doc = Arc::clone(doc);
    let proof = listed.clone();
    let target_id = id.to_owned();
    let state = Arc::clone(state);
    let document_claim = Arc::clone(claim);
    let job = tokio::task::spawn_blocking(move || {
        let _claim = document_claim;
        #[cfg(test)]
        let _gate = pause_document(&state.app_dir);
        let policy = if representable { LiveScrub::Preserved(&proof) } else { LiveScrub::Fenced(&proof) };
        let result = accounts_doc::run(&doc, "accounts.remove", &json!({"id":target_id}), policy)
            .map_err(|e| e.catalog_key().to_owned())?;
        state.account_lifecycle.apply_committed_membership(Some(&owner), &result.membership);
        Ok::<_, String>(result.changed)
    });
    actual(deadline, job).await
}

fn cleanup_local(state: &Arc<DaemonState>, proof: &RootProof, local: &LocalProof,
    lease: &AccountLease, progress: &Progress, id: &str, deadline: Instant)
    -> Result<Vec<&'static str>, String> {
    #[cfg(test)]
    let _gate = pause_local(&state.app_dir);
    let selected = local.tree.identity.is_some() || local.mailbox.identity.is_some()
        || local.sidecars.iter().any(|sidecar| sidecar.owned);
    let exclusion = if selected {
        Some(state.account_admission.try_exclude_for_removal(lease)
            .map_err(|_| "local deletion proof busy".to_owned())?)
    } else { None };
    let fresh = if selected { fresh_local_proof(state, id, deadline)? } else {
        FreshLocalProof { ids: BTreeSet::new(), projected: local.projected.clone(),
            credential_generation: credentials::write_generation(),
            custody_generation: state.custody.gen.load(std::sync::atomic::Ordering::Acquire) }
    };
    #[cfg(test)]
    let _exclusion_gate = pause_exclusion(&state.app_dir);
    let residuals = with_vault_write(state, |root| {
        if !may_start(progress, deadline) { return Err("local unlink caller or deadline expired".into()); }
        if selected && (fresh.credential_generation != credentials::write_generation()
            || fresh.custody_generation != state.custody.gen.load(std::sync::atomic::Ordering::Acquire)) {
            return Err("errors.vaultUnavailable".into());
        }
        proof.check(state, root)?;
        local.check(root, id, &fresh)?;
        if !may_start(progress, deadline) { return Err("local unlink caller or deadline expired".into()); }
        let tree = root.join("Maildir").join(id);
        if tree.exists() { fs::remove_dir_all(&tree).map_err(|_| "account tree unlink failed".to_owned())?; }
        if tree.exists() { return Err("account tree remains".into()); }
        #[cfg(test)]
        if fail_after_tree().lock().unwrap_or_else(|e| e.into_inner()).remove(&state.app_dir) {
            return Err("synthetic stop after actual tree unlink".into());
        }
        #[cfg(test)]
        let _unlink_gate = pause_unlink(&state.app_dir);
        let mut residuals = Vec::new();
        proof.check(state, root)?;
        if selected && (fresh.credential_generation != credentials::write_generation()
            || fresh.custody_generation != state.custody.gen.load(std::sync::atomic::Ordering::Acquire)) {
            return Err("errors.vaultUnavailable".into());
        }
        if cleanup_sidecars(root, id, local, &fresh).is_err() { residuals.push("headerCache"); }
        proof.check(state, root)?;
        if selected && (fresh.credential_generation != credentials::write_generation()
            || fresh.custody_generation != state.custody.gen.load(std::sync::atomic::Ordering::Acquire)) {
            return Err("errors.vaultUnavailable".into());
        }
        local.mailboxes.check()?;
        local.mailbox.check()?;
        check_shared_child(&local.mailboxes.path, local.mailbox.identity,
            &local.known_ids(id, &fresh.ids)?)?;
        if mailvault_core::header_cache::delete_legacy_mailbox_cache(root, id).is_err()
            || mailvault_core::header_cache::legacy_mailbox_cache(root, id).exists() {
            residuals.push("mailboxCache");
        }
        Ok(residuals)
    })?;
    drop(exclusion);
    crate::custody::with_conn(state, |conn| {
            sql_cache::clear_headers(conn, Some(id), None)?;
            sql_cache::delete_mailboxes(conn, id)?;
            conn.execute("DELETE FROM vault_entries WHERE account_id = ?1", [id]).map_err(|e| e.to_string())?;
            let remaining_entries: i64 = conn.query_row(
                "SELECT COUNT(*) FROM vault_entries WHERE account_id = ?1", [id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if sql_cache::knows_account(conn, id)? || sql_cache::load_mailboxes(conn, id)?.is_some()
                || remaining_entries != 0 {
                return Err("custody rows remain".into());
            }
            Ok(())
    }).map_err(|_| "custody cleanup failed".to_owned())?;
    state.vault_registry.forget_account(id).map_err(|_| "registry cleanup failed".to_owned())?;
    crate::search_index::forget_account(&state.search_index, id)
        .map_err(|_| "search index cleanup failed".to_owned())?;
    app_db::with(&state.app_dir, |conn| follow_up::dismiss_account(conn, id))
        .map_err(|_| "follow-up cleanup failed".to_owned())?;
    Ok(residuals)
}

fn cleanup_sidecars(root: &Path, id: &str, local: &LocalProof,
    fresh: &FreshLocalProof) -> Result<(), String> {
    let lock = mailvault_core::header_cache::lock_tree(root);
    let _held = lock.write().unwrap_or_else(|e| e.into_inner());
    let known = local.known_ids(id, &fresh.ids)?;
    local.check_sidecars_locked(id, &known)?;
    let mut ambiguous = false;
    for sidecar in &local.sidecars {
        if !sidecar.owned || !fresh.projected.contains(&sidecar.name) {
            ambiguous = true;
            continue;
        }
        sidecar.path.check()?;
        let path = &sidecar.path.path;
        if fs::metadata(path).map_err(|e| e.to_string())?.is_dir() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        } else { fs::remove_file(path).map_err(|e| e.to_string())?; }
        if path.exists() { return Err("header cache remains".into()); }
    }
    if ambiguous { Err("ambiguous header cache remains".into()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::app_db::compose_receipts as receipts;

    async fn received(rx: std::sync::mpsc::Receiver<()>) {
        tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
            .await.unwrap().unwrap();
    }
    fn arm(gates: &Mutex<HashMap<PathBuf, Gate>>, path: PathBuf)
        -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let (done, done_rx) = std::sync::mpsc::channel();
        gates.lock().unwrap_or_else(|e| e.into_inner()).insert(path,
            Gate { entered, release: release_rx, done });
        (entered_rx, release, done_rx)
    }

    struct Rig {
        dir: tempfile::TempDir,
        state: Arc<DaemonState>,
        _restore: credentials::TestEnvRestore,
        _env: std::sync::MutexGuard<'static, ()>,
    }
    impl Rig {
        fn new(ids: &[&str]) -> Self {
            let env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
            let restore = credentials::TestEnvRestore::capture();
            let dir = tempfile::tempdir().unwrap();
            let mail = dir.path().join("configured");
            let app = dir.path().join("app");
            fs::create_dir_all(mail.join("Maildir")).unwrap();
            fs::create_dir_all(&app).unwrap();
            let rows: Vec<Value> = ids.iter().map(|id| json!({"id":id,
                "email":format!("{id}@example.test"),"imapHost":"h","authType":"password"})).collect();
            let blob: HashMap<String, String> = rows.iter().map(|row|
                (row["id"].as_str().unwrap().to_owned(), json!({"id":row["id"],
                    "email":row["email"],"imapHost":"h","password":"synthetic"}).to_string())).collect();
            fs::write(app.join("accounts.json"), json!(rows).to_string()).unwrap();
            fs::write(app.join("credentials.json"), json!(blob).to_string()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", app.join("credentials.json"));
            let state = DaemonState::for_test(mail, app.clone(), true);
            state.account_lifecycle.seed(&accounts_doc::list(&accounts_doc::shared(&app)).unwrap());
            Self { dir, state, _restore: restore, _env: env }
        }
        fn app(&self) -> PathBuf { self.dir.path().join("app") }
        fn mail(&self) -> PathBuf { self.dir.path().join("configured") }
        fn rows(&self) -> Value {
            serde_json::from_slice(&fs::read(self.app().join("accounts.json")).unwrap()).unwrap()
        }
        fn blob(&self) -> HashMap<String, String> {
            serde_json::from_slice(&fs::read(self.app().join("credentials.json")).unwrap()).unwrap()
        }
        async fn remove(&self, id: &str) -> Value {
            let reply = route(&self.state, &json!({"accountId":id}), json!(1)).await;
            if let Some(error) = reply.error { panic!("removal RPC error: {}", error.message); }
            reply.result.unwrap()
        }
        fn receipt(&self, id: &str) -> receipts::Scope {
            let scope = receipts::Scope::new(id, "Sent", 42, "native@example.test").unwrap();
            let receipt = receipts::Receipt::present(receipts::Identity::from_bytes(scope.clone(),
                b"Message-ID: <native@example.test>\r\n\r\nbody").unwrap());
            app_db::with(&self.app(), |conn| receipts::save(conn, &receipt)).unwrap();
            scope
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_receipt_first_and_complete_exact_configured_cleanup() {
        let rig = Rig::new(&["a", "b"]);
        let a = rig.mail().join("Maildir/a");
        let b = rig.mail().join("Maildir/b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("one.eml"), b"A").unwrap();
        fs::write(b.join("one.eml"), b"B").unwrap();
        let default = rig.dir.path().join("default/Maildir/a");
        fs::create_dir_all(&default).unwrap();
        fs::write(default.join("keep.eml"), b"default").unwrap();
        let shared = rig.mail().join("message_blobs/shared");
        fs::create_dir_all(shared.parent().unwrap()).unwrap();
        fs::write(&shared, b"shared").unwrap();
        let receipt_scope = rig.receipt("a");
        app_db::with(&rig.app(), |conn| {
            follow_up::insert(conn, "follow-a", "a", "<a@example.test>", "synthetic", "b@example.test",
                "Sent", &[], 1, 2)?;
            follow_up::insert(conn, "follow-b", "b", "<b@example.test>", "synthetic", "a@example.test",
                "Sent", &[], 1, 2)?;
            follow_up::insert(conn, "follow-failed", "a", "<failed@example.test>", "synthetic",
                "b@example.test", "Sent", &[], 1, 2)?;
            follow_up::insert(conn, "follow-history", "a", "<history@example.test>", "synthetic",
                "b@example.test", "Sent", &[], 1, 2)?;
            conn.execute("UPDATE follow_ups SET state = 'failed' WHERE id = 'follow-failed'", [])
                .map_err(|e| e.to_string())?;
            conn.execute("UPDATE follow_ups SET state = 'replied' WHERE id = 'follow-history'", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        }).unwrap();
        crate::custody::with_conn(&rig.state, |conn| {
            sql_cache::save_mailboxes(conn, "a", "[]")?;
            sql_cache::save_mailboxes(conn, "b", "[]")?;
            Ok(())
        }).unwrap();
        let result = rig.remove("a").await;
        let receipt_absent = app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap().is_empty();
        let follow_a = app_db::with(&rig.app(), |conn| follow_up::get(conn, "follow-a")).unwrap().unwrap();
        let follow_b = app_db::with(&rig.app(), |conn| follow_up::get(conn, "follow-b")).unwrap().unwrap();
        let follow_failed = app_db::with(&rig.app(), |conn| follow_up::get(conn, "follow-failed"))
            .unwrap().unwrap();
        let follow_history = app_db::with(&rig.app(), |conn| follow_up::get(conn, "follow-history"))
            .unwrap().unwrap();
        let custody_exact = crate::custody::with_conn(&rig.state, |conn| Ok(
            !sql_cache::knows_account(conn, "a")? && sql_cache::knows_account(conn, "b")?
        )).unwrap();
        assert_eq!(result, json!({"outcome":"complete","accountId":"a"}),
            "S24_PIPELINE_COMPLETE: {result}");
        assert_eq!(follow_failed.state, "dismissed",
            "S24_FAILED_FOLLOWUP_ACTUAL: result={result}, failed_state={}, a_state={}, b_state={}",
            follow_failed.state, follow_a.state, follow_b.state);
        assert!(receipt_absent && custody_exact && follow_a.state == "dismissed"
            && follow_b.state == "waiting"
            && follow_history.state == "replied"
            && !a.exists() && b.join("one.eml").is_file()
            && default.join("keep.eml").is_file() && shared.is_file()
            && rig.rows().as_array().unwrap().iter().all(|row| row["id"] != "a")
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "b")
            && !rig.blob().contains_key("a") && rig.blob().contains_key("b")
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::RetiredIds(_)))
            && rig.state.account_lifecycle.capture("b").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_real_receipt_failure_stops_document_credentials_and_local() {
        let rig = Rig::new(&["a", "b"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("keep.eml"), b"A").unwrap();
        let receipt_scope = rig.receipt("a");
        app_db::with(&rig.app(), |conn| conn.execute_batch(
            "CREATE TRIGGER s24_abort_receipt BEFORE DELETE ON meta
             WHEN old.key LIKE 'compose_receipt:%'
             BEGIN SELECT RAISE(ABORT, 'synthetic receipt storage failure'); END;"
        ).map_err(|e| e.to_string())).unwrap();
        let before_receipt = app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap();
        let rows = rig.rows();
        let blob = rig.blob();
        let outcome = rig.remove("a").await;
        assert_eq!(outcome["outcome"], "incomplete", "S24_RECEIPT_FIRST: {outcome}");
        assert_eq!(outcome["stage"], "receipt");
        assert_eq!(outcome["completion"], "failed");
        let after_receipt = app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap();
        assert!(before_receipt == after_receipt && tree.join("keep.eml").is_file()
            && rig.rows() == rows && rig.blob() == blob
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_ambiguous_legacy_cache_keeps_sibling_and_reports_residual() {
        let rig = Rig::new(&["a-b", "a_b"]);
        let a = rig.mail().join("Maildir/a-b");
        let b = rig.mail().join("Maildir/a_b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("one.eml"), b"A").unwrap();
        fs::write(b.join("one.eml"), b"B").unwrap();
        let ambiguous = rig.mail().join("email_cache/a_b_INBOX");
        fs::create_dir_all(&ambiguous).unwrap();
        fs::write(ambiguous.join("header.json"), b"keep").unwrap();
        let result = rig.remove("a-b").await;
        assert_eq!(result["outcome"], "incomplete", "S24_CACHE_COLLISION: {result}");
        assert_eq!(result["stage"], "local");
        assert!(result["residuals"].as_array().unwrap().contains(&json!("headerCache"))
            && ambiguous.join("header.json").is_file() && !a.exists() && b.join("one.eml").is_file()
            && !rig.blob().contains_key("a-b") && rig.blob().contains_key("a_b"));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_case_alias_absent_id_refuses_before_any_effect() {
        let rig = Rig::new(&["A"]);
        let owner = rig.mail().join("Maildir/A");
        fs::create_dir_all(&owner).unwrap();
        fs::write(owner.join("keep.eml"), b"owner").unwrap();
        let alias = rig.mail().join("Maildir/a");
        assert!(alias.join("keep.eml").is_file(),
            "S24_CASE_ALIAS_FIXTURE: this supported-volume fixture must actually resolve a to A");
        assert!(!fs::read_dir(rig.mail().join("Maildir")).unwrap().any(|entry|
            entry.unwrap().file_name() == "a"),
            "S24_CASE_ALIAS_FIXTURE: only A may own the directory entry");
        let absent_receipt = rig.receipt("a");
        let owner_receipt = rig.receipt("A");
        let rows = rig.rows();
        let blob = rig.blob();
        let response = route(&rig.state, &json!({"accountId":"a"}), json!(1)).await;
        let absent_retained = app_db::with(&rig.app(), |conn| receipts::load(conn, &absent_receipt)).unwrap().len() == 1;
        let owner_retained = app_db::with(&rig.app(), |conn| receipts::load(conn, &owner_receipt)).unwrap().len() == 1;
        assert!(response.error.is_some() && absent_retained && owner_retained
            && rig.rows() == rows && rig.blob() == blob && owner.join("keep.eml").is_file()
            && rig.state.account_lifecycle.capture("A").is_ok(),
            "S24_CASE_ALIAS_ABSENT: error={:?}, result={:?}, absent_retained={absent_retained}, owner_retained={owner_retained}, tree_exists={}",
            response.error, response.result, owner.join("keep.eml").is_file());
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_case_alias_two_authoritative_ids_refuses_before_any_effect() {
        let rig = Rig::new(&["A", "a"]);
        let owner = rig.mail().join("Maildir/a");
        fs::create_dir_all(&owner).unwrap();
        fs::write(owner.join("keep.eml"), b"owner").unwrap();
        assert!(rig.mail().join("Maildir/A/keep.eml").is_file(),
            "S24_CASE_ALIAS_FIXTURE: two authoritative IDs must resolve to the same child");
        let target_receipt = rig.receipt("a");
        let owner_receipt = rig.receipt("A");
        let rows = rig.rows();
        let blob = rig.blob();
        let response = route(&rig.state, &json!({"accountId":"a"}), json!(1)).await;
        let target_retained = app_db::with(&rig.app(), |conn| receipts::load(conn, &target_receipt)).unwrap().len() == 1;
        let owner_retained = app_db::with(&rig.app(), |conn| receipts::load(conn, &owner_receipt)).unwrap().len() == 1;
        assert!(response.error.is_some() && target_retained && owner_retained
            && rig.rows() == rows && rig.blob() == blob && owner.join("keep.eml").is_file()
            && rig.state.account_lifecycle.capture("A").is_ok(),
            "S24_CASE_ALIAS_TWO_IDS: error={:?}, result={:?}, target_retained={target_retained}, owner_retained={owner_retained}, tree_exists={}",
            response.error, response.result, owner.join("keep.eml").is_file());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_orphan_and_sanitized_equal_sidecars_preserve_siblings() {
        let mut all_preserved = true;
        let mut observations = Vec::new();
        for (target, orphan) in [("a", "a_x"), ("a-b", "a_b")] {
            let rig = Rig::new(&[target]);
            let target_tree = rig.mail().join("Maildir").join(target);
            let orphan_tree = rig.mail().join("Maildir").join(orphan);
            fs::create_dir_all(&target_tree).unwrap();
            fs::create_dir_all(&orphan_tree).unwrap();
            fs::write(target_tree.join("target.eml"), b"target").unwrap();
            fs::write(orphan_tree.join("orphan.eml"), b"orphan").unwrap();
            let mut blob = rig.blob();
            blob.insert(orphan.to_owned(), json!({"id":orphan,"password":"orphan"}).to_string());
            fs::write(rig.app().join("credentials.json"), json!(blob).to_string()).unwrap();
            let sidecar = mailvault_core::header_cache::sidecar_dir(&rig.mail(), orphan, "INBOX");
            fs::create_dir_all(&sidecar).unwrap();
            fs::write(sidecar.join("keep.json"), b"orphan cache").unwrap();
            let outcome = rig.remove(target).await;
            let residual = outcome["residuals"].as_array().is_some_and(|items|
                items.contains(&json!("headerCache")));
            let sidecar_retained = sidecar.join("keep.json").is_file();
            let orphan_retained = orphan_tree.join("orphan.eml").is_file()
                && rig.blob().contains_key(orphan);
            all_preserved &= outcome["outcome"] == "incomplete" && outcome["stage"] == "local"
                && residual && sidecar_retained && orphan_retained;
            observations.push(format!("target={target}, orphan={orphan}, outcome={outcome}, residual={residual}, sidecar_retained={sidecar_retained}, orphan_retained={orphan_retained}"));
        }
        assert!(all_preserved, "S24_ORPHAN_SIDECAR: {}", observations.join("; "));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_late_admitted_sibling_keeps_preexisting_colliding_sidecar() {
        let mut all_preserved = true;
        let mut observations = Vec::new();
        for (target, sibling, mailbox) in [("a", "a_x", "x_INBOX"), ("a-b", "a_b", "INBOX")] {
            let rig = Rig::new(&[target]);
            let target_tree = rig.mail().join("Maildir").join(target);
            fs::create_dir_all(&target_tree).unwrap();
            fs::write(target_tree.join("target.eml"), b"target").unwrap();
            let sidecar = mailvault_core::header_cache::sidecar_dir(&rig.mail(), target, mailbox);
            assert_eq!(sidecar, mailvault_core::header_cache::sidecar_dir(&rig.mail(), sibling, "INBOX"));
            fs::create_dir_all(&sidecar).unwrap();
            fs::write(sidecar.join("keep.json"), b"preexisting shared sidecar").unwrap();
            crate::custody::with_conn(&rig.state, |conn| {
                conn.execute("INSERT INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES (?1,?2,'{}')",
                    [target, mailbox]).map_err(|error| error.to_string())?;
                Ok(())
            }).unwrap();
            let (entered, release, done) = arm(local_gates(), rig.app());
            let state = Arc::clone(&rig.state);
            let requested = target.to_owned();
            let pending = tokio::spawn(async move {
                route(&state, &json!({"accountId":requested}), json!(1)).await
            });
            received(entered).await;
            let put = crate::handlers::accounts::route(&rig.state, "accounts.put",
                &json!({"entry":{"id":sibling,"email":format!("{sibling}@fresh.test"),
                    "imapHost":"fresh-host","authType":"password"}}), json!(2)).await.unwrap();
            let published = put.error.is_none()
                && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == sibling);
            release.send(()).unwrap();
            received(done).await;
            let removal = pending.await.unwrap();
            let outcome = removal.result.unwrap_or(Value::Null);
            let residual = outcome["residuals"].as_array().is_some_and(|items|
                items.contains(&json!("headerCache")));
            let retained = sidecar.join("keep.json").is_file();
            all_preserved &= published && outcome["outcome"] == "incomplete"
                && outcome["stage"] == "local" && residual && retained;
            observations.push(format!("target={target}, sibling={sibling}, put_error={:?}, published={published}, outcome={outcome}, residual={residual}, sidecar_retained={retained}", put.error));
        }
        assert!(all_preserved, "S24_LATE_SIBLING: {}", observations.join("; "));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_late_case_alias_publication_keeps_shared_tree() {
        let rig = Rig::new(&["a"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("keep.eml"), b"shared tree").unwrap();
        assert!(rig.mail().join("Maildir/A/keep.eml").is_file(),
            "S24_CASE_ALIAS_FIXTURE: A must actually resolve to the target child");
        let (entered, release, done) = arm(local_gates(), rig.app());
        let state = Arc::clone(&rig.state);
        let pending = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        received(entered).await;
        let put = crate::handlers::accounts::route(&rig.state, "accounts.put",
            &json!({"entry":{"id":"A","email":"capital@fresh.test",
                "imapHost":"fresh-host","authType":"password"}}), json!(2)).await.unwrap();
        let published = put.error.is_none()
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "A");
        release.send(()).unwrap();
        received(done).await;
        let removal = pending.await.unwrap();
        let outcome = removal.result.unwrap_or(Value::Null);
        assert!(published && outcome["outcome"] == "incomplete" && outcome["stage"] == "local"
            && tree.join("keep.eml").is_file()
            && rig.state.account_lifecycle.capture("A").is_ok(),
            "S24_LATE_CASE_ALIAS: put_error={:?}, published={published}, outcome={outcome}, tree_retained={}",
            put.error, tree.join("keep.eml").is_file());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_other_live_lease_refuses_local_unlink_until_explicit_retry() {
        let rig = Rig::new(&["a", "b"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("keep.eml"), b"target").unwrap();
        let other = rig.state.account_admission.try_reserve(AccountWriteScope {
            ids: ["b".to_owned()].into(), ..Default::default()
        }).unwrap();
        let first = rig.remove("a").await;
        let retained = tree.join("keep.eml").is_file();
        drop(other);
        let retried = rig.remove("a").await;
        assert!(first["outcome"] == "incomplete" && first["stage"] == "local"
            && retained && retried == json!({"outcome":"complete","accountId":"a"})
            && !tree.exists() && rig.state.account_lifecycle.capture("b").is_ok(),
            "S24_OTHER_LEASE_LOCAL: first={first}, retained={retained}, retried={retried}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_guard_blocks_native_publication_until_actual_child_finishes_after_waiter_loss() {
        let rig = Rig::new(&["a"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("target.eml"), b"target").unwrap();
        let (entered, release, gate_done) = arm(unlink_gates(), rig.app());
        let (finished, owned_finished) = std::sync::mpsc::channel();
        owned_done().lock().unwrap().insert(rig.app(), finished);
        let state = Arc::clone(&rig.state);
        let waiter = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        received(entered).await;
        let entry = json!({"entry":{"id":"b","email":"b@fresh.test",
            "imapHost":"fresh-host","authType":"password"}});
        let blocked = crate::handlers::accounts::route(&rig.state, "accounts.put", &entry,
            json!(2)).await.unwrap();
        let absent_while_guarded = blocked.error.as_ref().is_some_and(|error| error.message == "errors.keychainBusy")
            && rig.rows().as_array().unwrap().iter().all(|row| row["id"] != "b");
        waiter.abort();
        let _ = waiter.await;
        release.send(()).unwrap();
        received(gate_done).await;
        received(owned_finished).await;
        let admitted = crate::handlers::accounts::route(&rig.state, "accounts.put", &entry,
            json!(3)).await.unwrap();
        let published_after = admitted.error.is_none()
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "b");
        let closing_after_loss = matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy));
        let retried = rig.remove("a").await;
        assert!(absent_while_guarded && published_after && !tree.exists()
            && closing_after_loss && retried == json!({"outcome":"complete","accountId":"a"})
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::RetiredIds(_))),
            "S24_GUARD_CHILD: blocked_error={:?}, absent_while_guarded={absent_while_guarded}, admitted_error={:?}, published_after={published_after}, closing_after_loss={closing_after_loss}, retried={retried}, tree_exists={}",
            blocked.error, admitted.error, tree.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_waiter_loss_after_quiet_proof_stops_unstarted_unlink() {
        let rig = Rig::new(&["a"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("keep.eml"), b"target").unwrap();
        let (entered, release, gate_done) = arm(exclusion_gates(), rig.app());
        let (finished, owned_finished) = std::sync::mpsc::channel();
        owned_done().lock().unwrap().insert(rig.app(), finished);
        let state = Arc::clone(&rig.state);
        let waiter = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        received(entered).await;
        waiter.abort();
        let _ = waiter.await;
        release.send(()).unwrap();
        received(gate_done).await;
        received(owned_finished).await;
        let retained = tree.join("keep.eml").is_file();
        let closing = matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy));
        let retried = rig.remove("a").await;
        assert!(retained && closing && retried == json!({"outcome":"complete","accountId":"a"})
            && !tree.exists(),
            "S24_QUIET_PROOF_WAITER: retained={retained}, closing={closing}, retried={retried}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_account_bound_sidecar_projection_deletes_exact_target_only() {
        let rig = Rig::new(&["a", "b"]);
        let target = mailvault_core::header_cache::sidecar_dir(&rig.mail(), "a", "INBOX");
        let sibling = mailvault_core::header_cache::sidecar_dir(&rig.mail(), "b", "INBOX");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(target.join("target.json"), b"target").unwrap();
        fs::write(sibling.join("sibling.json"), b"sibling").unwrap();
        crate::custody::with_conn(&rig.state, |conn| {
            conn.execute("INSERT INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES ('a','INBOX','{}')", [])
                .map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        let outcome = rig.remove("a").await;
        assert_eq!(outcome, json!({"outcome":"complete","accountId":"a"}),
            "S24_BOUND_SIDECAR: {outcome}");
        assert!(!target.exists() && sibling.join("sibling.json").is_file()
            && rig.blob().contains_key("b") && rig.state.account_lifecycle.capture("b").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_unprojected_legacy_sidecar_is_residual_not_guessed_owned() {
        let rig = Rig::new(&["a"]);
        let unknown = mailvault_core::header_cache::sidecar_dir(&rig.mail(), "a", "INBOX");
        fs::create_dir_all(&unknown).unwrap();
        fs::write(unknown.join("keep.json"), b"no account-bound projection").unwrap();
        let outcome = rig.remove("a").await;
        assert!(outcome["outcome"] == "incomplete" && outcome["stage"] == "local"
            && outcome["residuals"].as_array().is_some_and(|items| items.contains(&json!("headerCache")))
            && unknown.join("keep.json").is_file(),
            "S24_UNPROJECTED_SIDECAR: {outcome}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_replaced_selected_child_keeps_both_trees_after_preflight() {
        let mut observations = Vec::new();
        let mut all_preserved = true;
        for selected in ["tree", "mailbox", "cache"] {
            let rig = Rig::new(&["a"]);
            let tree = rig.mail().join("Maildir/a");
            let mailbox = rig.mail().join("mailboxes/a");
            let cache = mailvault_core::header_cache::sidecar_dir(&rig.mail(), "a", "INBOX");
            for path in [&tree, &mailbox, &cache] {
                fs::create_dir_all(path).unwrap();
                fs::write(path.join("original.keep"), b"original").unwrap();
            }
            crate::custody::with_conn(&rig.state, |conn| {
                conn.execute("INSERT INTO header_cache_meta(account_id,mailbox_path,meta_json) VALUES ('a','INBOX','{}')", [])
                    .map_err(|error| error.to_string())?;
                Ok(())
            }).unwrap();
            let (entered, release, done) = arm(receipt_gates(), rig.app());
            let state = Arc::clone(&rig.state);
            let pending = tokio::spawn(async move {
                route(&state, &json!({"accountId":"a"}), json!(1)).await
            });
            received(entered).await;
            let current = match selected { "tree" => &tree, "mailbox" => &mailbox, _ => &cache };
            let old = current.with_file_name(format!("s24-held-{selected}"));
            fs::rename(current, &old).unwrap();
            fs::create_dir_all(current).unwrap();
            fs::write(current.join("replacement.keep"), b"replacement").unwrap();
            release.send(()).unwrap();
            received(done).await;
            let response = pending.await.unwrap();
            let old_retained = old.join("original.keep").is_file();
            let new_retained = current.join("replacement.keep").is_file();
            let incomplete = response.result.as_ref().is_some_and(|result| result["outcome"] == "incomplete");
            all_preserved &= old_retained && new_retained && incomplete;
            observations.push(format!("selected={selected}, result={:?}, error={:?}, old_retained={old_retained}, new_retained={new_retained}",
                response.result, response.error));
        }
        assert!(all_preserved, "S24_CHILD_REPLACEMENT: {}", observations.join("; "));
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_windows_same_path_root_replacement_refuses_new_tree() {
        let rig = Rig::new(&["a", "b"]);
        let original = rig.mail().join("Maildir/a");
        fs::create_dir_all(&original).unwrap();
        fs::write(original.join("original.eml"), b"original").unwrap();
        let unrelated = rig.dir.path().join("unrelated/Maildir/b");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join("keep.eml"), b"unrelated").unwrap();
        let (entered, release, child_done) = arm(receipt_gates(), rig.app());
        let state = Arc::clone(&rig.state);
        let pending = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        received(entered).await;
        // Windows keeps the fixture's SQLite custody handle open under the
        // configured root. Release that test handle before modeling a root
        // replacement, then reopen against the replacement path.
        crate::custody::close(&rig.state);
        let old_root = rig.dir.path().join("configured-old");
        fs::rename(rig.mail(), &old_root).unwrap();
        let replacement = rig.mail().join("Maildir/a");
        fs::create_dir_all(&replacement).unwrap();
        fs::write(replacement.join("replacement.eml"), b"replacement").unwrap();
        crate::custody::reopen(&rig.state).unwrap();
        release.send(()).unwrap();
        received(child_done).await;
        let response = pending.await.unwrap();
        let original_retained = old_root.join("Maildir/a/original.eml").is_file();
        let replacement_retained = replacement.join("replacement.eml").is_file();
        let unrelated_retained = unrelated.join("keep.eml").is_file();
        assert!(response.result.as_ref().is_some_and(|result| result["outcome"] == "incomplete")
            && original_retained && replacement_retained && unrelated_retained,
            "S24_WINDOWS_ROOT_ID: result={:?}, error={:?}, original_retained={original_retained}, replacement_retained={replacement_retained}, unrelated_retained={unrelated_retained}",
            response.result, response.error);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_selected_sidecar_symlink_refuses_before_any_effect() {
        use std::os::unix::fs::symlink;
        let rig = Rig::new(&["a"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("keep.eml"), b"target").unwrap();
        let outside = rig.dir.path().join("outside-sidecar");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.json"), b"outside").unwrap();
        fs::create_dir_all(rig.mail().join("email_cache")).unwrap();
        symlink(&outside, rig.mail().join("email_cache/a_INBOX")).unwrap();
        let receipt = rig.receipt("a");
        let rows = rig.rows();
        let blob = rig.blob();
        let response = route(&rig.state, &json!({"accountId":"a"}), json!(1)).await;
        let receipt_retained = app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt)).unwrap().len() == 1;
        assert!(response.error.is_some() && receipt_retained && rig.rows() == rows
            && rig.blob() == blob && tree.join("keep.eml").is_file()
            && outside.join("keep.json").is_file(),
            "S24_SELECTED_SIDECAR_SYMLINK: error={:?}, result={:?}, receipt_retained={receipt_retained}, tree_exists={}",
            response.error, response.result, tree.join("keep.eml").is_file());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_actual_busy_and_invalid_path_have_no_receipt_effect() {
        let rig = Rig::new(&["a", "b"]);
        let scope = rig.receipt("a");
        let before = app_db::with(&rig.app(), |conn| receipts::load(conn, &scope)).unwrap();
        let stamp = rig.state.account_lifecycle.capture("a").unwrap();
        let operation = rig.state.account_lifecycle.try_operation(&[stamp]).unwrap();
        let busy_result = rig.remove("a").await;
        let invalid = route(&rig.state, &json!({"accountId":"../a"}), json!(2)).await;
        let after = app_db::with(&rig.app(), |conn| receipts::load(conn, &scope)).unwrap();
        assert_eq!(busy_result, json!({"outcome":"busy","accountId":"a","effects":"none"}),
            "S24_REAL_BUSY: {busy_result}");
        assert!(invalid.error.is_some() && before == after && rig.blob().contains_key("a")
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "a")
            && rig.state.account_lifecycle.capture("b").is_ok());
        drop(operation);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_real_local_drain_timeout_is_busy_and_revokes_old_stamp() {
        let rig = Rig::new(&["a", "b"]);
        let scope = rig.receipt("a");
        let original = rig.state.account_lifecycle.capture("a").unwrap();
        let local = rig.state.account_lifecycle.try_commit(&[original.clone()]).unwrap();
        let result = rig.remove("a").await;
        assert_eq!(result, json!({"outcome":"busy","accountId":"a","effects":"none"}),
            "S24_ROUTE_DRAIN: {result}");
        assert!(app_db::with(&rig.app(), |conn| receipts::load(conn, &scope)).unwrap().len() == 1
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "a")
            && rig.blob().contains_key("a") && rig.state.account_lifecycle.capture("b").is_ok());
        drop(local);
        assert!(rig.state.account_lifecycle.try_commit(&[original]).is_err(),
            "old stamp stays revoked after pre-effect drain timeout");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_unavailable_configured_root_refuses_before_receipt_effect() {
        let rig = Rig::new(&["a"]);
        let scope = rig.receipt("a");
        let unavailable = DaemonState::for_test(rig.mail(), rig.app(), false);
        unavailable.account_lifecycle.seed(&accounts_doc::list(&accounts_doc::shared(&rig.app())).unwrap());
        let response = route(&unavailable, &json!({"accountId":"a"}), json!(1)).await;
        assert!(response.error.is_some() && app_db::with(&rig.app(), |conn| receipts::load(conn, &scope)).unwrap().len() == 1
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "a")
            && rig.blob().contains_key("a"),
            "S24_UNAVAILABLE_ROOT: configured inaccessible vault must refuse before receipt");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_symlink_target_refuses_without_touching_outside_tree() {
        use std::os::unix::fs::symlink;
        let rig = Rig::new(&["a"]);
        let scope = rig.receipt("a");
        let outside = rig.dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.eml"), b"outside").unwrap();
        symlink(&outside, rig.mail().join("Maildir/a")).unwrap();
        let response = route(&rig.state, &json!({"accountId":"a"}), json!(1)).await;
        assert!(response.error.is_some() && outside.join("keep.eml").is_file()
            && app_db::with(&rig.app(), |conn| receipts::load(conn, &scope)).unwrap().len() == 1
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "a")
            && rig.blob().contains_key("a"),
            "S24_SYMLINK_REFUSAL: selected symlink cannot redirect exact cleanup");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_destroyed_waiter_keeps_actual_receipt_child_and_claim() {
        let rig = Rig::new(&["a", "b"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("one.eml"), b"A").unwrap();
        let receipt_scope = rig.receipt("a");
        let (entered, release, child_done) = arm(receipt_gates(), rig.app());
        let (done, owned_finished) = std::sync::mpsc::channel();
        owned_done().lock().unwrap().insert(rig.app(), done);
        let state = Arc::clone(&rig.state);
        let waiter = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        received(entered).await;
        assert!(matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy))
            && rig.state.account_lifecycle.capture("b").is_ok()
            && app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap().len() == 1);
        waiter.abort();
        let _ = waiter.await;
        assert!(matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy)));
        release.send(()).unwrap();
        received(child_done).await;
        received(owned_finished).await;
        let receipt_absent = app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap().is_empty();
        let document_present = rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "a");
        let credential_present = rig.blob().contains_key("a");
        let tree_present = tree.join("one.eml").is_file();
        let still_closing = matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy));
        assert!(receipt_absent && document_present && credential_present && tree_present && still_closing,
            "S24_WAITER_CUSTODY: started receipt must settle but later stages must wait for explicit retry; receipt_absent={receipt_absent}, document_present={document_present}, credential_present={credential_present}, tree_present={tree_present}, still_closing={still_closing}");
        let retried = rig.remove("a").await;
        assert_eq!(retried, json!({"outcome":"complete","accountId":"a"}));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_dropped_joinhandle_still_holds_claim_through_receipt_effect() {
        let rig = Rig::new(&["a"]);
        let receipt_scope = rig.receipt("a");
        let mut scope = AccountWriteScope::default();
        scope.ids.insert("a".into());
        let lease = rig.state.account_admission.try_reserve(scope).unwrap();
        let mut claim = rig.state.account_lifecycle.try_close(lease, "a").unwrap();
        let drained = claim.wait_local_until(Instant::now() + Duration::from_secs(2)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        let claim = Arc::new(claim);
        let (entered, release, done) = arm(receipt_gates(), rig.app());
        let app = rig.app();
        let child_claim = Arc::clone(&claim);
        let (finished, actual_finished) = std::sync::mpsc::channel();
        let child = tokio::task::spawn_blocking(move || {
            let _claim = child_claim;
            let _gate = pause_receipt(&app);
            let result = app_db::with(&app, |conn| receipts::remove_account(conn, "a"));
            drop(_gate);
            drop(_claim);
            let _ = finished.send(());
            result
        });
        received(entered).await;
        drop(child);
        assert!(Arc::strong_count(&claim) >= 2
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy)));
        release.send(()).unwrap();
        received(done).await;
        received(actual_finished).await;
        assert!(app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap().is_empty()
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy)),
            "S24_DROPPED_JOIN: detached actual child must retain claim through receipt mutation");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_document_conflict_stops_credential_and_tree_effects() {
        let rig = Rig::new(&["a", "b"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("one.eml"), b"A").unwrap();
        let receipt_scope = rig.receipt("a");
        let (entered, release, done) = arm(document_gates(), rig.app());
        let state = Arc::clone(&rig.state);
        let pending = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        received(entered).await;
        accounts_doc::run(&accounts_doc::shared(&rig.app()), "accounts.put",
            &json!({"entry":{"id":"b","name":"intervening"}}), LiveScrub::Preserve).unwrap();
        release.send(()).unwrap();
        received(done).await;
        let response = pending.await.unwrap();
        let result = response.result.unwrap();
        assert_eq!(result["outcome"], "incomplete", "S24_DOCUMENT_STOP: {result}");
        assert_eq!(result["stage"], "document");
        assert!(app_db::with(&rig.app(), |conn| receipts::load(conn, &receipt_scope)).unwrap().is_empty()
            && rig.blob().contains_key("a") && tree.join("one.eml").is_file()
            && rig.rows().as_array().unwrap().iter().any(|row| row["id"] == "a"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_timed_out_credential_child_settles_before_unknown_and_stops_local() {
        let rig = Rig::new(&["a"]);
        let tree = rig.mail().join("Maildir/a");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("one.eml"), b"A").unwrap();
        let mut paused = credentials::TestWritePause::arm_with_timeout(50);
        let state = Arc::clone(&rig.state);
        let pending = tokio::spawn(async move {
            route(&state, &json!({"accountId":"a"}), json!(1)).await
        });
        paused.wait_until_entered();
        let expired = tokio::time::timeout(Duration::from_secs(5), async {
            while !credentials::WRITE_PARKED.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        }).await.is_ok();
        assert!(expired && !pending.is_finished()
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy))
            && tree.join("one.eml").is_file());
        // Releasing the real backend child lets its finalizer settle before
        // the removal owner answers unknown and drops Closing custody.
        paused.finish();
        let reply = pending.await.unwrap();
        let result = reply.result.unwrap();
        assert_eq!(result["outcome"], "incomplete", "S24_CREDENTIAL_UNKNOWN: {result}");
        assert_eq!(result["stage"], "credentials");
        assert_eq!(result["completion"], "unknown");
        assert!(tree.join("one.eml").is_file()
            && rig.rows().as_array().unwrap().iter().all(|row| row["id"] != "a")
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s24_partial_local_effect_and_absent_restart_retry_are_truthful() {
        let rig = Rig::new(&["a", "b"]);
        let tree = rig.mail().join("Maildir/a");
        let other = rig.mail().join("Maildir/b");
        fs::create_dir_all(&tree).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(tree.join("one.eml"), b"A").unwrap();
        fs::write(other.join("keep.eml"), b"B").unwrap();
        let mut events = rig.state.events.subscribe();
        fail_after_tree().lock().unwrap().insert(rig.app());
        let first = rig.remove("a").await;
        assert_eq!(first["outcome"], "incomplete", "S24_PARTIAL_RETRY: {first}");
        assert_eq!(first["stage"], "local");
        assert!(!tree.exists() && !rig.blob().contains_key("a")
            && rig.rows().as_array().unwrap().iter().all(|row| row["id"] != "a")
            && matches!(rig.state.account_lifecycle.capture("a"), Err(LifecycleError::Busy)));
        while let Ok(event) = events.try_recv() {
            let (name, _) = mailvault_core::daemon_ipc::parse_event(&event).unwrap();
            assert_ne!(name, crate::handlers::accounts::CHANGED_EVENT,
                "incomplete removal cannot announce a retired account");
        }
        // custody.db is process-exclusive; a real restart drops its old
        // connection before the next daemon opens the configured vault.
        *mailvault_core::custody::lock(&rig.state.custody.db) = None;
        let restarted = DaemonState::for_test(rig.mail(), rig.app(), true);
        restarted.account_lifecycle.seed(&accounts_doc::list(&accounts_doc::shared(&rig.app())).unwrap());
        let mut settled_events = restarted.events.subscribe();
        let response = route(&restarted, &json!({"accountId":"a"}), json!(2)).await;
        let second = response.result.unwrap();
        assert_eq!(second, json!({"outcome":"complete","accountId":"a"}),
            "S24_ABSENT_RETRY: {second}");
        let mut account_events = Vec::new();
        while let Ok(event) = settled_events.try_recv() {
            let (name, payload) = mailvault_core::daemon_ipc::parse_event(&event).unwrap();
            if name == crate::handlers::accounts::CHANGED_EVENT { account_events.push(payload); }
        }
        assert_eq!(account_events.len(), 1);
        assert_eq!(account_events[0]["ids"], json!(["a"]));
        assert!(other.join("keep.eml").is_file() && rig.blob().contains_key("b"));
    }
}
