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
    #[cfg(unix)]
    device_inode: (u64, u64),
}
impl RootProof {
    fn read(state: &Arc<DaemonState>) -> Result<Self, String> {
        let configured = vault_root(state)?;
        let canonical = fs::canonicalize(&configured).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        let metadata = fs::metadata(&configured).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        if !metadata.is_dir() { return Err("errors.vaultUnavailable".into()); }
        #[cfg(unix)]
        let device_inode = {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        };
        Ok(Self { configured, canonical, #[cfg(unix)] device_inode })
    }
    fn check(&self, state: &Arc<DaemonState>, root: &Path) -> Result<(), String> {
        if root != self.configured || vault_root(state)? != self.configured
            || fs::canonicalize(root).ok().as_deref() != Some(self.canonical.as_path()) {
            return Err("errors.vaultUnavailable".into());
        }
        let metadata = fs::metadata(root).map_err(|_| "errors.vaultUnavailable".to_owned())?;
        if !metadata.is_dir() { return Err("errors.vaultUnavailable".into()); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if (metadata.dev(), metadata.ino()) != self.device_inode {
                return Err("errors.vaultUnavailable".into());
            }
        }
        Ok(())
    }
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
        Err(_) => return Ok(busy(&id)),
    };
    let reread = Arc::clone(&doc);
    let fresh = tokio::task::spawn_blocking(move || accounts_doc::list(&reread)).await;
    if !matches!(fresh, Ok(Ok(ref current)) if current == &listed && current.recovered.is_none()) {
        return Ok(busy(&id));
    }
    let mut claim = match state.account_lifecycle.try_close(lease.clone(), &id) {
        Ok(claim) => claim,
        Err(LifecycleError::Unknown) => match state.account_lifecycle.try_close_absent(lease.clone(), &id, &listed) {
            Ok(claim) => claim,
            Err(_) => return Ok(busy(&id)),
        },
        Err(_) => return Ok(busy(&id)),
    };
    let drained = match claim.wait_local_until(std::cmp::min(Instant::now() + DRAIN, deadline)).await {
        Ok(drained) => drained,
        Err(_) => return Ok(busy(&id)),
    };
    {
        let mut stage = progress.lock().unwrap_or_else(|e| e.into_inner());
        if !stage.waiter_alive || stage.stage == Stage::Expired || Instant::now() >= deadline {
            return Ok(busy(&id));
        }
        if claim.mark_effects_started(drained).is_err() { return Ok(busy(&id)); }
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
    let local_claim = Arc::clone(&claim);
    let other_ids: BTreeSet<String> = listed.accounts.iter().filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|row_id| *row_id != id).map(str::to_owned).collect();
    let local = tokio::task::spawn_blocking(move || {
        let _claim = local_claim;
        cleanup_local(&local_state, &local_root, &local_id, &other_ids)
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

fn cleanup_local(state: &Arc<DaemonState>, proof: &RootProof, id: &str,
    other_ids: &BTreeSet<String>) -> Result<Vec<&'static str>, String> {
    let residuals = with_vault_write(state, |root| {
        proof.check(state, root)?;
        paths(root, id)?;
        let tree = root.join("Maildir").join(id);
        if tree.exists() { fs::remove_dir_all(&tree).map_err(|_| "account tree unlink failed".to_owned())?; }
        if tree.exists() { return Err("account tree remains".into()); }
        #[cfg(test)]
        if fail_after_tree().lock().unwrap_or_else(|e| e.into_inner()).remove(&state.app_dir) {
            return Err("synthetic stop after actual tree unlink".into());
        }
        let mut residuals = Vec::new();
        if cleanup_sidecars(root, id, other_ids).is_err() { residuals.push("headerCache"); }
        if mailvault_core::header_cache::delete_legacy_mailbox_cache(root, id).is_err()
            || mailvault_core::header_cache::legacy_mailbox_cache(root, id).exists() {
            residuals.push("mailboxCache");
        }
        Ok(residuals)
    })?;
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

fn cleanup_sidecars(root: &Path, id: &str, other_ids: &BTreeSet<String>) -> Result<(), String> {
    let dir = root.join("email_cache");
    if !dir.exists() { return Ok(()); }
    no_symlink(&dir)?;
    let sanitized = id.replace(|c: char| !c.is_alphanumeric(), "_");
    let prefix = format!("{sanitized}_");
    let others: Vec<(String, String)> = other_ids.iter().map(|other| {
        let name = other.replace(|c: char| !c.is_alphanumeric(), "_");
        let prefix = format!("{name}_");
        (name, prefix)
    }).collect();
    let lock = mailvault_core::header_cache::lock_tree(root);
    let _held = lock.write().unwrap_or_else(|e| e.into_inner());
    let mut ambiguous = false;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != sanitized && !name.starts_with(&prefix) { continue; }
        if others.iter().any(|(other, other_prefix)| name == *other || name.starts_with(other_prefix)) {
            ambiguous = true;
            continue;
        }
        let path = entry.path();
        no_symlink(&path)?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else { fs::remove_file(&path).map_err(|e| e.to_string())?; }
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
