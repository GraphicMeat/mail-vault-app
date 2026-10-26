//! Account persistence only. Credential IO stays in the common credential
//! engine; document IO owns its lease through actual blocking completion.
use crate::credentials::{self, CredChange, CredError};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::accounts_doc::{self, Listing};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::time::Instant;

#[derive(Clone, Default)]
pub(crate) struct AccountWriteScope {
    pub ids: BTreeSet<String>,
    pub keys: BTreeSet<String>,
    pub whole_store: bool,
}
impl AccountWriteScope {
    pub fn record(&mut self, id: &str, value: &Value) {
        self.ids.insert(id.to_owned());
        self.keys.insert(accounts_doc::logical_key(value));
    }
    fn conflicts(&self, other: &Self) -> bool {
        self.whole_store
            || other.whole_store
            || !self.ids.is_disjoint(&other.ids)
            || !self.keys.is_disjoint(&other.keys)
    }
}
#[derive(Default)]
pub(crate) struct AccountAdmission(Mutex<Vec<Weak<AccountWriteScope>>>);
#[derive(Clone)]
pub(crate) struct AccountLease(Arc<AccountWriteScope>);
impl AccountLease {
    pub fn covers(&self, scope: &AccountWriteScope) -> bool {
        self.0.whole_store
            || (!scope.whole_store
                && scope.ids.is_subset(&self.0.ids)
                && scope.keys.is_subset(&self.0.keys))
    }
}
impl AccountAdmission {
    pub fn known_conflict(&self, ids: &BTreeSet<String>) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(Weak::upgrade)
            .any(|s| s.whole_store || !s.ids.is_disjoint(ids))
    }
    pub fn try_reserve(&self, scope: AccountWriteScope) -> Result<AccountLease, CredError> {
        let mut active = self.0.lock().unwrap_or_else(|e| e.into_inner());
        active.retain(|s| s.strong_count() > 0);
        if active
            .iter()
            .filter_map(Weak::upgrade)
            .any(|s| s.conflicts(&scope))
        {
            return Err(CredError::Busy);
        }
        let lease = AccountLease(Arc::new(scope));
        active.push(Arc::downgrade(&lease.0));
        Ok(lease)
    }
}

const CONTEXT: [&str; 17] = [
    "email",
    "authType",
    "imapHost",
    "imapPort",
    "imapSecure",
    "imapSecurity",
    "smtpHost",
    "smtpPort",
    "smtpSecure",
    "jmapSessionUrl",
    "jmapAuth",
    "jmapUsername",
    "oauth2Provider",
    "oauth2ClientId",
    "oauth2CustomClientId",
    "oauth2TenantId",
    "oauth2Transport",
];
const UNSET: [&str; 2] = ["oauth2ClientId", "jmapUsername"];
pub(crate) enum AccountSaveError {
    Invalid,
    Conflict,
    WriteFailed,
}
impl AccountSaveError {
    pub fn catalog_key(&self) -> &'static str {
        match self {
            Self::Invalid => "errors.accountsInvalid",
            Self::Conflict => "errors.accountsConflict",
            Self::WriteFailed => "errors.accountsWriteFailed",
        }
    }
}
pub(crate) enum MutationFailure {
    Credential(CredError),
    Account(AccountSaveError),
}
impl From<CredError> for MutationFailure {
    fn from(e: CredError) -> Self {
        Self::Credential(e)
    }
}
impl From<AccountSaveError> for MutationFailure {
    fn from(e: AccountSaveError) -> Self {
        Self::Account(e)
    }
}
impl MutationFailure {
    pub fn catalog_key(&self) -> &'static str {
        match self {
            Self::Credential(e) => e.catalog_key(),
            Self::Account(e) => e.catalog_key(),
        }
    }
    pub fn credential(self) -> CredError {
        match self {
            Self::Credential(e) => e,
            Self::Account(_) => CredError::Invalid,
        }
    }
}
struct Expected {
    fields: Map<String, Value>,
    absent: Vec<String>,
    credential_present: bool,
}
enum Request {
    Patch {
        id: String,
        fields: Map<String, Value>,
        unset: Vec<String>,
        expected: Option<Expected>,
    },
    Create {
        entries: Vec<Value>,
        if_absent: bool,
    },
}
pub(crate) struct AccountSaveInput {
    request: Request,
    pub proof: Listing,
    deadline: Instant,
}
pub(crate) enum CredentialOp {
    Change(CredChange),
    AccountSave(AccountSaveInput),
}
pub(crate) struct PreparedAccountSave {
    pub rows: Vec<Value>,
    pub accepted: Vec<String>,
    pub skipped: BTreeMap<String, String>,
    pub host_changed: bool,
}
pub(crate) struct AppliedCredentials {
    pub ids: Vec<String>,
    pub prepared: Option<PreparedAccountSave>,
}
pub(crate) struct CredentialCompletion {
    pub applied: AppliedCredentials,
    pub version: u64,
}
pub(crate) type LeaseOwner = Arc<Mutex<Option<AccountLease>>>;

pub(crate) fn check_deadline(deadline: Option<Instant>) -> Result<(), MutationFailure> {
    if deadline.is_some_and(|d| Instant::now() >= d) {
        return Err(AccountSaveError::WriteFailed.into());
    }
    Ok(())
}

fn names(value: Option<&Value>) -> Result<Vec<String>, AccountSaveError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let a = value.as_array().ok_or(AccountSaveError::Invalid)?;
    let mut seen = BTreeSet::new();
    a.iter()
        .map(|v| {
            let s = v.as_str().ok_or(AccountSaveError::Invalid)?.to_owned();
            if !seen.insert(s.clone()) {
                return Err(AccountSaveError::Invalid);
            }
            Ok(s)
        })
        .collect()
}
fn id(value: &Value) -> Result<&str, AccountSaveError> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(AccountSaveError::Invalid)
}
fn expected(value: &Value) -> Result<Expected, AccountSaveError> {
    let o = value.as_object().ok_or(AccountSaveError::Invalid)?;
    if o.keys()
        .any(|k| !matches!(k.as_str(), "fields" | "absent" | "credentialPresent"))
    {
        return Err(AccountSaveError::Invalid);
    }
    let fields = match o.get("fields") {
        Some(v) => v.as_object().ok_or(AccountSaveError::Invalid)?.clone(),
        None => Map::new(),
    };
    let absent = names(o.get("absent"))?;
    if fields.keys().any(|k| !CONTEXT.contains(&k.as_str()))
        || absent
            .iter()
            .any(|k| !CONTEXT.contains(&k.as_str()) || fields.contains_key(k))
    {
        return Err(AccountSaveError::Invalid);
    }
    let credential_present = match o.get("credentialPresent") {
        None => false,
        Some(Value::Bool(true)) => true,
        _ => return Err(AccountSaveError::Invalid),
    };
    Ok(Expected {
        fields,
        absent,
        credential_present,
    })
}
fn parse(params: &Value) -> Result<Request, AccountSaveError> {
    let o = params.as_object().ok_or(AccountSaveError::Invalid)?;
    if let Some(patch) = o.get("patch") {
        if o.len() != 1 {
            return Err(AccountSaveError::Invalid);
        }
        let p = patch.as_object().ok_or(AccountSaveError::Invalid)?;
        if p.keys()
            .any(|k| !matches!(k.as_str(), "id" | "fields" | "unset" | "expected"))
        {
            return Err(AccountSaveError::Invalid);
        }
        let fields = p
            .get("fields")
            .and_then(Value::as_object)
            .ok_or(AccountSaveError::Invalid)?
            .clone();
        let unset = names(p.get("unset"))?;
        if fields.contains_key("id")
            || unset
                .iter()
                .any(|k| !UNSET.contains(&k.as_str()) || fields.contains_key(k))
        {
            return Err(AccountSaveError::Invalid);
        }
        return Ok(Request::Patch {
            id: id(patch)?.to_owned(),
            fields,
            unset,
            expected: p.get("expected").map(expected).transpose()?,
        });
    }
    if o.keys()
        .any(|k| !matches!(k.as_str(), "entries" | "ifAbsent"))
    {
        return Err(AccountSaveError::Invalid);
    }
    let entries = o
        .get("entries")
        .and_then(Value::as_array)
        .ok_or(AccountSaveError::Invalid)?
        .clone();
    let if_absent = o
        .get("ifAbsent")
        .and_then(Value::as_bool)
        .ok_or(AccountSaveError::Invalid)?;
    let mut ids = BTreeSet::new();
    for entry in &entries {
        if !entry.is_object()
            || entry
                .get("email")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            || !ids.insert(id(entry)?.to_owned())
        {
            return Err(AccountSaveError::Invalid);
        }
    }
    Ok(Request::Create { entries, if_absent })
}
fn record(raw: &str) -> Result<Value, CredError> {
    let v: Value = serde_json::from_str(raw).map_err(|_| CredError::Unavailable)?;
    if !v.is_object() {
        return Err(CredError::Unavailable);
    }
    Ok(v)
}
fn current(
    blob: &HashMap<String, String>,
    proof: &Listing,
) -> Result<BTreeMap<String, Value>, MutationFailure> {
    let mut rows = BTreeMap::new();
    for value in &proof.accounts {
        if let Ok(id) = id(value) {
            if rows.insert(id.to_owned(), value.clone()).is_some() {
                return Err(AccountSaveError::Conflict.into());
            }
        }
    }
    for (key, raw) in blob {
        let value = record(raw)?;
        if value.get("id").is_some_and(|v| v.as_str() != Some(key)) {
            return Err(AccountSaveError::Invalid.into());
        }
        let row = rows.entry(key.clone()).or_insert_with(|| json!({"id":key}));
        let target = row.as_object_mut().ok_or(AccountSaveError::Invalid)?;
        for field in CONTEXT.iter().copied().chain([
            "password",
            "oauth2AccessToken",
            "oauth2RefreshToken",
            "oauth2ExpiresAt",
            "fromEmail",
        ]) {
            target.remove(field);
        }
        target.extend(value.as_object().unwrap().clone());
    }
    Ok(rows)
}
fn clean(mut row: Value) -> Value {
    let m = row.as_object_mut().unwrap();
    for k in accounts_doc::SECRET_FIELDS {
        m.remove(k);
    }
    m.remove("connectionCheck");
    row
}
fn submitted(mut row: Value) -> Value {
    let m = row.as_object_mut().unwrap();
    for k in ["previousImapHost", "hostChangedAt", "connectionCheck"] {
        m.remove(k);
    }
    row
}
fn check_expected(e: &Expected, row: &Value, present: bool) -> Result<(), AccountSaveError> {
    if e.credential_present && !present
        || e.fields.iter().any(|(k, v)| row.get(k) != Some(v))
        || e.absent.iter().any(|k| row.get(k).is_some())
    {
        return Err(AccountSaveError::Conflict);
    }
    Ok(())
}
fn prepare(
    blob: &HashMap<String, String>,
    input: &AccountSaveInput,
) -> Result<
    (
        HashMap<String, String>,
        AppliedCredentials,
        AccountWriteScope,
    ),
    MutationFailure,
> {
    if !accounts_doc::legacy_secrets_representable(&input.proof.accounts) {
        return Err(AccountSaveError::Conflict.into());
    }
    let mut rows = current(blob, &input.proof)?;
    let mut scope = AccountWriteScope::default();
    let mut prepared = PreparedAccountSave {
        rows: Vec::new(),
        accepted: Vec::new(),
        skipped: BTreeMap::new(),
        host_changed: false,
    };
    let mut target = Vec::new();
    // Guards inspect the original fresh map, before legacy preservation.
    match &input.request {
        Request::Patch {
            id,
            fields,
            unset,
            expected,
        } => {
            let old = rows.get(id).ok_or(AccountSaveError::Conflict)?;
            if let Some(e) = expected {
                check_expected(e, old, blob.contains_key(id))?;
            }
            let mut next = old.clone();
            for (k, v) in fields {
                if !matches!(
                    k.as_str(),
                    "previousImapHost" | "hostChangedAt" | "connectionCheck"
                ) {
                    next.as_object_mut().unwrap().insert(k.clone(), v.clone());
                }
            }
            for k in unset {
                next.as_object_mut().unwrap().remove(k);
            }
            next.as_object_mut().unwrap().remove("connectionCheck");
            let old_host = old
                .get("imapHost")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let new_host = next
                .get("imapHost")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if old_host.is_some() && new_host.is_some() && old_host != new_host {
                next["previousImapHost"] = json!(old_host.unwrap());
                next["hostChangedAt"] = json!(std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64);
                prepared.host_changed = true;
            }
            let key = accounts_doc::logical_key(&next);
            if rows
                .iter()
                .any(|(other, v)| other != id && accounts_doc::logical_key(v) == key)
            {
                return Err(AccountSaveError::Conflict.into());
            }
            scope.record(id, old);
            for metadata in input
                .proof
                .accounts
                .iter()
                .filter(|v| v.get("id").and_then(Value::as_str) == Some(id))
            {
                scope.record(id, metadata);
            }
            scope.record(id, &next);
            target.push((
                id.clone(),
                next,
                fields
                    .keys()
                    .any(|k| accounts_doc::SECRET_FIELDS.contains(&k.as_str())),
            ));
        }
        Request::Create { entries, if_absent } => {
            for entry in entries {
                let entry = submitted(entry.clone());
                let id = id(&entry)?.to_owned();
                let key = accounts_doc::logical_key(&entry);
                scope.record(&id, &entry);
                if let Some(old) = rows.get(&id) {
                    scope.record(&id, old);
                    if !if_absent || accounts_doc::logical_key(old) != key {
                        return Err(AccountSaveError::Conflict.into());
                    }
                }
                if let Some((existing, old)) = rows
                    .iter()
                    .find(|(_, v)| accounts_doc::logical_key(v) == key)
                {
                    if !if_absent {
                        return Err(AccountSaveError::Conflict.into());
                    }
                    scope.record(existing, old);
                    prepared.skipped.insert(id, existing.clone());
                    continue;
                }
                rows.insert(id.clone(), entry.clone());
                target.push((id, entry, true));
            }
        }
    }
    let mut next = blob.clone();
    for (id, raw) in accounts_doc::legacy_secrets(&input.proof.accounts) {
        scope.record(&id, &record(&raw)?);
        if let Some(raw) = blob.get(&id) {
            scope.record(&id, &record(raw)?);
        }
        next.entry(id).or_insert(raw);
    }
    for (id, row, explicit_secret) in target {
        if next.contains_key(&id) || explicit_secret {
            // Preserve a semantically unchanged credential record verbatim;
            // JSON property order alone is not a new credential mutation.
            if next
                .get(&id)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .as_ref()
                != Some(&row)
            {
                next.insert(id.clone(), row.to_string());
            }
        }
        prepared.accepted.push(id);
        prepared.rows.push(clean(row));
    }
    let mut ids: Vec<_> = next
        .iter()
        .filter(|(id, raw)| blob.get(*id) != Some(*raw))
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    Ok((
        next,
        AppliedCredentials {
            ids,
            prepared: Some(prepared),
        },
        scope,
    ))
}
impl CredentialOp {
    pub fn deadline(&self) -> Option<Instant> {
        match self {
            Self::AccountSave(input) => Some(input.deadline),
            Self::Change(_) => None,
        }
    }
    pub fn ids(&self) -> BTreeSet<String> {
        match self {
            Self::Change(CredChange::Save(r) | CredChange::SaveIfAbsent(r)) => {
                r.keys().cloned().collect()
            }
            Self::Change(CredChange::Update { id, .. }) => [id.clone()].into_iter().collect(),
            Self::Change(CredChange::Refreshed(p)) => [p.account_id.clone()].into_iter().collect(),
            Self::Change(CredChange::Delete(ids)) => ids.iter().cloned().collect(),
            Self::AccountSave(input) => match &input.request {
                Request::Patch { id, .. } => [id.clone()].into_iter().collect(),
                Request::Create { entries, .. } => entries
                    .iter()
                    .filter_map(|e| id(e).ok().map(str::to_owned))
                    .collect(),
            },
        }
    }
}
fn primitive_scope(
    blob: &HashMap<String, String>,
    change: &CredChange,
) -> Result<AccountWriteScope, CredError> {
    let ids = match change {
        CredChange::Save(r) | CredChange::SaveIfAbsent(r) => r.keys().cloned().collect(),
        CredChange::Update { id, .. } => [id.clone()].into_iter().collect(),
        CredChange::Refreshed(p) => [p.account_id.clone()].into_iter().collect(),
        CredChange::Delete(ids) => ids.iter().cloned().collect(),
    };
    let mut scope = AccountWriteScope {
        ids,
        ..Default::default()
    };
    for id in scope.ids.clone() {
        if let Some(raw) = blob.get(&id) {
            let old = record(raw)?;
            scope.record(&id, &old);
            if let CredChange::Update { fields, .. } = change {
                let mut next = old;
                next.as_object_mut().unwrap().extend(fields.clone());
                scope.record(&id, &next);
            }
        }
    }
    if let CredChange::Save(r) | CredChange::SaveIfAbsent(r) = change {
        for (id, raw) in r {
            let v = record(raw).map_err(|_| CredError::Invalid)?;
            if !matches!(change, CredChange::SaveIfAbsent(_)) || !blob.contains_key(id) {
                scope.record(id, &v);
            }
        }
    }
    Ok(scope)
}
pub(crate) fn apply_operation(
    blob: &mut HashMap<String, String>,
    op: &CredentialOp,
    state: &Arc<DaemonState>,
    supplied: Option<&AccountLease>,
    owner: &LeaseOwner,
) -> Result<AppliedCredentials, MutationFailure> {
    #[cfg(test)]
    let _stage = operation_pause(&state.app_dir);
    check_deadline(op.deadline())?;
    let (mut next, applied, scope) = match op {
        CredentialOp::AccountSave(input) => {
            let (next, applied, scope) = prepare(blob, input)?;
            (next, Some(applied), scope)
        }
        CredentialOp::Change(change) => (
            blob.clone(),
            None,
            primitive_scope(blob, change).map_err(|e| {
                if supplied.is_some() && e == CredError::Unavailable {
                    CredError::Busy
                } else {
                    e
                }
            })?,
        ),
    };
    let lease = match supplied {
        Some(l) if l.covers(&scope) => l.clone(),
        Some(_) => return Err(CredError::Busy.into()),
        None => state.account_admission.try_reserve(scope)?,
    };
    *owner.lock().unwrap_or_else(|e| e.into_inner()) = Some(lease);
    let applied = match (applied, op) {
        (Some(a), _) => a,
        (None, CredentialOp::Change(change)) => AppliedCredentials {
            ids: credentials::apply_change(&mut next, change)?,
            prepared: None,
        },
        _ => unreachable!(),
    };
    check_deadline(op.deadline())?;
    *blob = next;
    Ok(applied)
}

fn rpc_error(id: Value, error: MutationFailure) -> RpcResponse {
    let invalid = matches!(
        &error,
        MutationFailure::Account(AccountSaveError::Invalid)
            | MutationFailure::Credential(CredError::Invalid)
    );
    RpcResponse::error(
        id,
        if invalid {
            ipc::INVALID_PARAMS
        } else {
            ipc::INTERNAL_ERROR
        },
        error.catalog_key(),
    )
}
fn budget() -> Duration {
    #[cfg(test)]
    {
        let ms = TEST_REPLY_MS.load(std::sync::atomic::Ordering::SeqCst);
        if ms > 0 {
            return Duration::from_millis(ms);
        }
    }
    Duration::from_secs(90)
}
#[cfg(test)]
static TEST_REPLY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) async fn save(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let request = match parse(params) {
        Ok(r) => r,
        Err(e) => return rpc_error(id, e.into()),
    };
    let state = Arc::clone(state);
    let deadline = Instant::now() + budget();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        #[cfg(test)]
        let _done = workflow_completions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&state.app_dir)
            .map(credentials::TestTaskDone);
        let result = save_owned(&state, request, deadline, &tx).await;
        let _ = tx.send(result);
    });
    match tokio::time::timeout_at(deadline, rx).await {
        Ok(Ok(Ok(reply))) => RpcResponse::success(id, reply),
        Ok(Ok(Err(e))) => rpc_error(id, e),
        _ => rpc_error(id, AccountSaveError::WriteFailed.into()),
    }
}
async fn save_owned(
    state: &Arc<DaemonState>,
    request: Request,
    deadline: Instant,
    reply: &tokio::sync::oneshot::Sender<Result<Value, MutationFailure>>,
) -> Result<Value, MutationFailure> {
    let snapshot = tokio::time::timeout_at(deadline, credentials::read_account_save_snapshot())
        .await
        .map_err(|_| AccountSaveError::WriteFailed)??;
    let doc = accounts_doc::shared(&state.app_dir);
    let read = Arc::clone(&doc);
    check_deadline(Some(deadline))?;
    let proof = tokio::task::spawn_blocking(move || {
        check_deadline(Some(deadline))?;
        accounts_doc::list(&read)
            .map_err(|_| MutationFailure::Account(AccountSaveError::WriteFailed))
    })
    .await
    .map_err(|_| AccountSaveError::WriteFailed)?
    .map_err(|_| AccountSaveError::WriteFailed)?;
    let _discovery_generation = snapshot.generation;
    let input = AccountSaveInput {
        request,
        proof,
        deadline,
    };
    let (_, _, scope) = prepare(&snapshot.records, &input)?;
    let lease = state.account_admission.try_reserve(scope)?;
    let proof = input.proof.clone();
    if Instant::now() >= deadline || reply.is_closed() {
        return Err(AccountSaveError::WriteFailed.into());
    }
    let completion = tokio::time::timeout_at(
        deadline,
        credentials::save_account_credentials(state, input, lease.clone()),
    )
    .await
    .map_err(|_| AccountSaveError::WriteFailed)??;
    let prepared = completion
        .applied
        .prepared
        .ok_or(AccountSaveError::WriteFailed)?;
    if Instant::now() >= deadline || reply.is_closed() {
        return Err(AccountSaveError::WriteFailed.into());
    }
    // The document job and its normal event own a lease independently of the RPC.
    let state = Arc::clone(state);
    let credential_version = completion.version;
    let result = tokio::task::spawn_blocking(move || {
        check_deadline(Some(deadline))?;
        #[cfg(test)]
        let _done = document_pause(&state.app_dir);
        let _lease = lease;
        let outcome = accounts_doc::commit_prepared(&doc, &proof, &prepared.rows);
        match outcome {
            Ok(out) => {
                if let Some(c) = out.changed {
                    state.events.emit(
                        crate::handlers::accounts::CHANGED_EVENT,
                        json!({"ids":c.changed,"version":c.version}),
                    );
                }
                Ok(
                    json!({"accounts":prepared.rows,"accepted":prepared.accepted,"skipped":prepared.skipped,"version":out.reply["version"],"credentialVersion":credential_version,"hostChanged":prepared.host_changed}),
                )
            }
            Err(_) => Err(AccountSaveError::WriteFailed.into()),
        }
    });
    tokio::time::timeout_at(deadline, result)
        .await
        .map_err(|_| AccountSaveError::WriteFailed)?
        .map_err(|_| AccountSaveError::WriteFailed)?
}

#[cfg(test)]
fn workflow_completions() -> &'static Mutex<HashMap<std::path::PathBuf, std::sync::mpsc::Sender<()>>>
{
    static G: std::sync::OnceLock<Mutex<HashMap<std::path::PathBuf, std::sync::mpsc::Sender<()>>>> =
        std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}

#[cfg(test)]
struct DocumentGate {
    entered: std::sync::mpsc::Sender<()>,
    gate: std::sync::mpsc::Receiver<()>,
    done: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
fn document_gates() -> &'static Mutex<HashMap<std::path::PathBuf, DocumentGate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<std::path::PathBuf, DocumentGate>>> =
        std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn document_pause(path: &std::path::Path) -> Option<credentials::TestTaskDone> {
    let gate = document_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(path);
    gate.map(|g| {
        let _ = g.entered.send(());
        let _ = g.gate.recv();
        credentials::TestTaskDone(g.done)
    })
}

#[cfg(test)]
fn operation_gates() -> &'static Mutex<HashMap<std::path::PathBuf, DocumentGate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<std::path::PathBuf, DocumentGate>>> =
        std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn operation_pause(path: &std::path::Path) -> Option<credentials::TestTaskDone> {
    let gate = operation_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(path);
    gate.map(|g| {
        let _ = g.entered.send(());
        let _ = g.gate.recv();
        credentials::TestTaskDone(g.done)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Rig {
        state: Arc<DaemonState>,
        dir: tempfile::TempDir,
        _restore: credentials::TestEnvRestore,
        _env: std::sync::MutexGuard<'static, ()>,
    }
    impl Rig {
        fn new(records: Vec<Value>, metadata: Vec<Value>) -> Self {
            let env = credentials::test_env_lock()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let restore = credentials::TestEnvRestore::capture();
            let dir = tempfile::tempdir().unwrap();
            let blob: HashMap<_, _> = records
                .into_iter()
                .map(|v| (v["id"].as_str().unwrap().to_owned(), v.to_string()))
                .collect();
            std::fs::write(
                dir.path().join("credentials.json"),
                serde_json::to_vec(&blob).unwrap(),
            )
            .unwrap();
            std::fs::write(
                dir.path().join("accounts.json"),
                serde_json::to_vec(&metadata).unwrap(),
            )
            .unwrap();
            std::env::set_var(
                "MAILVAULT_TEST_CREDENTIALS",
                dir.path().join("credentials.json"),
            );
            let state =
                DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
            Self {
                state,
                dir,
                _restore: restore,
                _env: env,
            }
        }
        fn blob(&self) -> HashMap<String, String> {
            serde_json::from_slice(
                &std::fs::read(self.dir.path().join("credentials.json")).unwrap(),
            )
            .unwrap()
        }
        fn stored(&self, id: &str) -> Value {
            serde_json::from_str(&self.blob()[id]).unwrap()
        }
        fn meta(&self) -> Value {
            serde_json::from_slice(&std::fs::read(self.dir.path().join("accounts.json")).unwrap())
                .unwrap()
        }
        async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            let r = crate::server::handle_request_for_test(&self.state, method, params).await;
            if let Some(e) = r.error {
                Err(e.message)
            } else {
                Ok(r.result.unwrap())
            }
        }
        async fn save(&self, params: Value) -> Result<Value, String> {
            self.call("accounts.save", params).await
        }
    }
    impl Drop for Rig {
        fn drop(&mut self) {
            self.state.tokens.drain_rechecks();
            TEST_REPLY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        }
    }
    fn row(id: &str, email: &str, host: &str) -> Value {
        json!({"id":id,"email":email,"imapHost":host,"authType":"password","password":"synthetic-password"})
    }
    fn scope(id: &str, email: &str, host: &str) -> AccountWriteScope {
        let mut s = AccountWriteScope::default();
        s.record(id, &row(id, email, host));
        s
    }

    fn backend(
        rig: &Rig,
        kind: &str,
    ) -> (
        Option<credentials::TestKeychainGuard>,
        Option<credentials::TestSealedGuard>,
    ) {
        if kind == "keychain" {
            return (
                Some(credentials::TestKeychainGuard::install(
                    rig.dir.path().join("credentials.json"),
                )),
                None,
            );
        }
        if kind == "sealed" {
            let guard =
                credentials::TestSealedGuard::install(rig.dir.path().join("credentials.sealed"));
            guard.0.unlock("synthetic-passphrase").unwrap();
            guard.0.set_credentials(rig.blob()).unwrap();
            return (None, Some(guard));
        }
        (None, None)
    }
    struct DocumentPause {
        release: Option<std::sync::mpsc::Sender<()>>,
        entered: std::sync::mpsc::Receiver<()>,
        done: Option<std::sync::mpsc::Receiver<()>>,
    }
    impl DocumentPause {
        fn arm(rig: &Rig) -> Self {
            let (release, gate) = std::sync::mpsc::channel();
            let (entered, notice) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            document_gates().lock().unwrap().insert(
                rig.state.app_dir.clone(),
                DocumentGate {
                    entered,
                    gate,
                    done,
                },
            );
            Self {
                release: Some(release),
                entered: notice,
                done: Some(finished),
            }
        }
        fn entered(&self) {
            self.entered
                .recv_timeout(Duration::from_secs(5))
                .expect("actual blocking document job entered");
        }
        fn finish(&mut self) {
            self.release.take();
            self.done
                .take()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .expect("document event and lease release completed");
        }
    }
    impl Drop for DocumentPause {
        fn drop(&mut self) {
            self.release.take();
            if let Some(done) = self.done.take() {
                if done.recv_timeout(Duration::from_secs(5)).is_err() {
                    std::process::abort();
                }
            }
        }
    }
    fn workflow_done(rig: &Rig) -> std::sync::mpsc::Receiver<()> {
        let (done, recv) = std::sync::mpsc::channel();
        workflow_completions()
            .lock()
            .unwrap()
            .insert(rig.state.app_dir.clone(), done);
        recv
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fresh_patch_preserves_pair_explicit_values_and_unsets_both_stores() {
        let mut a = row("a", "a@example.test", "old");
        a["oauth2AccessToken"] = json!("synthetic-new-at");
        a["oauth2RefreshToken"] = json!("synthetic-new-rt");
        a["oauth2ExpiresAt"] = json!(99);
        a["oauth2ClientId"] = json!("old-client");
        a["jmapUsername"] = json!("old-login");
        let rig = Rig::new(vec![a.clone()], vec![clean(a.clone())]);
        let mut events = rig.state.events.subscribe();
        let out=rig.save(json!({"patch":{"id":"a","fields":{"sentFolderOverride":null,"enabled":false,"counter":0},"unset":["oauth2ClientId","jmapUsername"]}})).await.unwrap();
        let saved = rig.stored("a");
        assert!(
            saved["oauth2AccessToken"] == "synthetic-new-at"
                && saved["oauth2RefreshToken"] == "synthetic-new-rt"
        );
        assert_eq!(saved["oauth2ExpiresAt"], 99);
        assert_eq!(saved["sentFolderOverride"], Value::Null);
        assert_eq!(saved["enabled"], false);
        assert_eq!(saved["counter"], 0);
        assert!(saved.get("oauth2ClientId").is_none() && saved.get("jmapUsername").is_none());
        assert!(
            rig.meta()[0].get("oauth2ClientId").is_none()
                && rig.meta()[0].get("jmapUsername").is_none()
        );
        let public = out.to_string()
            + &std::fs::read_to_string(rig.dir.path().join("accounts.json.bak1")).unwrap();
        assert!(!public.contains("synthetic-"));
        while let Ok(line) = events.try_recv() {
            assert!(!line.contains("synthetic-"));
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_op_credentials_still_prepare_and_complete_metadata() {
        for kind in ["debug", "keychain", "sealed"] {
            let mut a = row("a", "a@example.test", "h");
            a["sentFolderOverride"] = json!("Sent");
            let mut meta = clean(a.clone());
            meta["sentFolderOverride"] = Value::Null;
            let rig = Rig::new(vec![a.clone()], vec![meta]);
            let original_raw = serde_json::to_string_pretty(&a).unwrap();
            std::fs::write(
                rig.dir.path().join("credentials.json"),
                json!({"a":original_raw}).to_string(),
            )
            .unwrap();
            let _backend = backend(&rig, kind);
            let version = credentials::write_generation();
            let out = rig
                .save(json!({"patch":{"id":"a","fields":{"sentFolderOverride":"Sent"}}}))
                .await
                .unwrap();
            assert_eq!(out["credentialVersion"], version);
            assert_eq!(out["accepted"], json!(["a"]));
            assert_eq!(rig.meta()[0]["sentFolderOverride"], "Sent");
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn expected_absence_and_repair_presence_precede_legacy_preservation() {
        let mut a = row("a", "a@outlook.test", "h");
        a["authType"] = json!("oauth2");
        a["oauth2Transport"] = json!("imap");
        let rig = Rig::new(vec![], vec![a.clone()]);
        let before = rig.blob();
        let refused=rig.save(json!({"patch":{"id":"a","fields":{"oauth2Transport":"graph"},"expected":{"fields":{"email":"a@outlook.test","authType":"oauth2","oauth2Transport":"imap"},"credentialPresent":true}}})).await;
        assert_eq!(refused, Err("errors.accountsConflict".into()));
        assert_eq!(rig.blob(), before);
        assert_eq!(rig.meta()[0], a);
        let out=rig.save(json!({"patch":{"id":"a","fields":{"enabled":false},"expected":{"absent":["oauth2ClientId"]}}})).await.unwrap();
        assert_eq!(out["accepted"], json!(["a"]));
        let refused=rig.save(json!({"patch":{"id":"a","fields":{"enabled":true},"expected":{"fields":{"oauth2ClientId":null}}}})).await;
        assert_eq!(refused, Err("errors.accountsConflict".into()));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_import_mapping_is_atomic_and_not_preservation_changed_ids() {
        let legacy = row("legacy", "legacy@example.test", "h");
        let rig = Rig::new(
            vec![row("existing", "dup@example.test", "h")],
            vec![clean(row("existing", "dup@example.test", "h")), legacy],
        );
        let out=rig.save(json!({"entries":[row("skip","DUP@example.test","H"),row("new","new@example.test","h"),row("dup-input","NEW@example.test","h")],"ifAbsent":true})).await.unwrap();
        assert_eq!(out["accepted"], json!(["new"]));
        assert_eq!(out["skipped"], json!({"skip":"existing","dup-input":"new"}));
        assert!(rig.blob().contains_key("legacy"));
        assert!(!rig.blob().contains_key("skip"));
        let before = rig.blob();
        assert_eq!(rig.save(json!({"entries":[row("existing","other@example.test","different"),row("untouched","u@example.test","h")],"ifAbsent":true})).await,Err("errors.accountsConflict".into()));
        assert_eq!(rig.blob(), before);
        assert_eq!(
            rig.save(json!({"entries":[row("duplicate","dup@example.test","h")],"ifAbsent":false}))
                .await,
            Err("errors.accountsConflict".into())
        );
        let distinct=rig.save(json!({"entries":[row("different-server","dup@example.test","elsewhere")],"ifAbsent":false})).await.unwrap();
        assert_eq!(distinct["accepted"], json!(["different-server"]));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn source_guard_host_stamp_missing_target_and_validation_refuse_truthfully() {
        let a = row("a", "a@example.test", "old");
        let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
        let out=rig.save(json!({"patch":{"id":"a","fields":{"imapHost":"new","previousImapHost":"forged","hostChangedAt":1},"expected":{"fields":{"imapHost":"old"}}}})).await.unwrap();
        assert_eq!(out["hostChanged"], true);
        assert_eq!(rig.stored("a")["previousImapHost"], "old");
        assert_ne!(rig.stored("a")["hostChangedAt"], 1);
        let before = rig.blob();
        for p in [
            json!({"patch":{"id":"missing","fields":{"name":"x"}}}),
            json!({"patch":{"id":"a","fields":{"name":"x"},"expected":{"fields":{"imapHost":"old"}}}}),
        ] {
            assert_eq!(rig.save(p).await, Err("errors.accountsConflict".into()));
        }
        assert_eq!(rig.blob(), before);
        for p in [
            json!({"patch":{"id":"a","fields":{"id":"b"}}}),
            json!({"patch":{"id":"a","fields":{"oauth2ClientId":"x"},"unset":["oauth2ClientId"]}}),
            json!({"patch":{"id":"a","fields":{},"expected":{"absent":["password"]}}}),
            json!({"entries":[row("x","x@example.test","h"),row("x","y@example.test","h")],"ifAbsent":true}),
        ] {
            assert_eq!(rig.save(p).await, Err("errors.accountsInvalid".into()));
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn known_conflicts_read_nothing_logical_conflicts_use_one_fresh_read() {
        let rig = Rig::new(
            vec![
                row("a", "a@example.test", "h"),
                row("b", "b@example.test", "other"),
            ],
            vec![],
        );
        let backend =
            credentials::TestKeychainGuard::install(rig.dir.path().join("credentials.json"));
        let lease = rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", "h"))
            .unwrap();
        assert_eq!(
            rig.call(
                "credentials.update",
                json!({"id":"a","fields":{"name":"blocked"}})
            )
            .await,
            Err("errors.keychainBusy".into())
        );
        assert!(backend.0.modes.lock().unwrap().is_empty());
        let unrelated = rig
            .call(
                "credentials.update",
                json!({"id":"b","fields":{"name":"allowed"}}),
            )
            .await
            .unwrap();
        assert_eq!(unrelated["updated"], true);
        drop(lease);
        backend.0.modes.lock().unwrap().clear();
        let mut key_only = scope("other-id", "a@example.test", "h");
        key_only.ids.clear();
        let lease = rig.state.account_admission.try_reserve(key_only).unwrap();
        let result =
            credentials::change_credentials_quiet(&rig.state, CredChange::Delete(vec!["a".into()]))
                .await;
        assert!(matches!(result, Err(CredError::Busy)));
        assert_eq!(*backend.0.modes.lock().unwrap(), vec![("read", false)]);
        drop(lease);
        let lease = rig
            .state
            .account_admission
            .try_reserve(AccountWriteScope {
                ids: ["a".into()].into_iter().collect(),
                ..Default::default()
            })
            .unwrap();
        assert!(matches!(
            credentials::change_credentials_admitted(
                &rig.state,
                CredChange::Delete(vec!["a".into()]),
                lease
            )
            .await,
            Err(CredError::Busy)
        ));
        assert!(rig.blob().contains_key("a"));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exclusive_and_batch_admission_refuse_without_partial_acquisition() {
        let rig = Rig::new(vec![row("a", "a@example.test", "h")], vec![]);
        let lease = rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", "h"))
            .unwrap();
        assert_eq!(
            rig.call("accounts.reorder", json!({"ids":[]})).await,
            Err("errors.keychainBusy".into())
        );
        assert_eq!(
            rig.call("accounts.replace_all", json!({"entries":[]}))
                .await,
            Err("errors.keychainBusy".into())
        );
        let mut union = scope("b", "b@example.test", "other");
        union.ids.insert("a".into());
        assert!(rig.state.account_admission.try_reserve(union).is_err());
        assert!(rig
            .state
            .account_admission
            .try_reserve(scope("b", "b@example.test", "other"))
            .is_ok());
        drop(lease);
        let global = rig
            .state
            .account_admission
            .try_reserve(AccountWriteScope {
                whole_store: true,
                ..Default::default()
            })
            .unwrap();
        assert!(rig
            .state
            .account_admission
            .try_reserve(scope("b", "b@example.test", "other"))
            .is_err());
        drop(global);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_backend_success_and_failure_keep_lease_until_finalizer_on_every_backend() {
        for kind in ["debug", "keychain", "sealed"] {
            for fail in [false, true] {
                let a = row("a", "a@example.test", "h");
                let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
                let (keychain, sealed) = backend(&rig, kind);
                let mut events = rig.state.events.subscribe();
                let mut pause = credentials::TestWritePause::arm_with_timeout(10);
                let state = Arc::clone(&rig.state);
                let task = tokio::spawn(async move {
                    save(
                        &state,
                        &json!({"patch":{"id":"a","fields":{"name":"late"}}}),
                        json!(1),
                    )
                    .await
                });
                pause.wait_until_entered();
                let response = task.await.unwrap();
                assert_eq!(
                    response.error.unwrap().message,
                    "errors.keychainWriteFailed"
                );
                assert!(rig
                    .state
                    .account_admission
                    .try_reserve(scope("a", "a@example.test", "h"))
                    .is_err());
                assert!(rig
                    .state
                    .account_admission
                    .try_reserve(scope("b", "b@example.test", "other"))
                    .is_ok());
                assert!(rig.meta()[0].get("name").is_none());
                if fail {
                    if let Some(k) = &keychain {
                        k.0.fail_write
                            .store(true, std::sync::atomic::Ordering::SeqCst)
                    } else {
                        let path = if sealed.is_some() {
                            rig.dir.path().join("credentials.sealed")
                        } else {
                            rig.dir.path().join("credentials.json")
                        };
                        std::fs::remove_file(&path).unwrap();
                        std::fs::create_dir(&path).unwrap();
                    }
                }
                pause.finish();
                assert!(rig
                    .state
                    .account_admission
                    .try_reserve(scope("a", "a@example.test", "h"))
                    .is_ok());
                assert!(rig.meta()[0].get("name").is_none());
                let mut changes = 0;
                while let Ok(line) = events.try_recv() {
                    let (name, _) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
                    if name == crate::handlers::credentials::CHANGED_EVENT {
                        changes += 1;
                    }
                    assert_ne!(name, crate::handlers::accounts::CHANGED_EVENT);
                    assert!(!line.contains("synthetic-"));
                }
                assert_eq!(changes, usize::from(!fail));
            }
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn outer_deadline_and_caller_loss_do_not_continue_late_prepared_metadata() {
        for cancel in [false, true] {
            let a = row("a", "a@example.test", "h");
            let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
            let done = workflow_done(&rig);
            let _drain = credentials::TestTaskDrain(done);
            let mut pause = credentials::TestWritePause::arm_with_timeout(1000);
            if !cancel {
                TEST_REPLY_MS.store(300, std::sync::atomic::Ordering::SeqCst);
            }
            let state = Arc::clone(&rig.state);
            let task = tokio::spawn(async move {
                save(
                    &state,
                    &json!({"patch":{"id":"a","fields":{"name":"late"}}}),
                    json!(1),
                )
                .await
            });
            pause.wait_until_entered();
            if cancel {
                task.abort();
                let _ = task.await;
            } else {
                assert_eq!(
                    task.await.unwrap().error.unwrap().message,
                    "errors.accountsWriteFailed"
                );
            }
            assert!(rig
                .state
                .account_admission
                .try_reserve(scope("a", "a@example.test", "h"))
                .is_err());
            pause.finish();
            // Independent workflow drain runs before the fixture/environment.
            drop(_drain);
            assert!(rig
                .state
                .account_admission
                .try_reserve(scope("a", "a@example.test", "h"))
                .is_ok());
            assert!(rig.meta()[0].get("name").is_none());
            assert_eq!(rig.stored("a")["name"], "late");
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn running_document_job_retains_lease_after_reply_timeout_and_emits_once() {
        let a = row("a", "a@example.test", "h");
        let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
        let mut pause = DocumentPause::arm(&rig);
        let mut events = rig.state.events.subscribe();
        TEST_REPLY_MS.store(300, std::sync::atomic::Ordering::SeqCst);
        let state = Arc::clone(&rig.state);
        let task = tokio::spawn(async move {
            save(
                &state,
                &json!({"patch":{"id":"a","fields":{"name":"document"}}}),
                json!(1),
            )
            .await
        });
        pause.entered();
        assert_eq!(
            task.await.unwrap().error.unwrap().message,
            "errors.accountsWriteFailed"
        );
        assert!(rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", "h"))
            .is_err());
        assert!(rig.call("accounts.list", json!({})).await.is_ok());
        assert!(rig.meta()[0].get("name").is_none());
        pause.finish();
        assert!(rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", "h"))
            .is_ok());
        assert_eq!(rig.meta()[0]["name"], "document");
        let mut changes = 0;
        while let Ok(line) = events.try_recv() {
            let (name, _) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if name == crate::handlers::accounts::CHANGED_EVENT {
                changes += 1;
            }
        }
        assert_eq!(changes, 1);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn document_conflict_after_credentials_success_reports_incomplete_without_rollback() {
        let a = row("a", "a@example.test", "h");
        let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
        let mut events = rig.state.events.subscribe();
        let mut pause = DocumentPause::arm(&rig);
        let state = Arc::clone(&rig.state);
        let task = tokio::spawn(async move {
            save(
                &state,
                &json!({"patch":{"id":"a","fields":{"name":"credential-committed"}}}),
                json!(1),
            )
            .await
        });
        pause.entered();
        let external = json!([{"id":"a","email":"changed@example.test","imapHost":"external"}]);
        std::fs::write(rig.dir.path().join("accounts.json"), external.to_string()).unwrap();
        pause.finish();
        assert_eq!(
            task.await.unwrap().error.unwrap().message,
            "errors.accountsWriteFailed"
        );
        assert_eq!(rig.stored("a")["name"], "credential-committed");
        assert_eq!(rig.meta(), external);
        assert!(rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", "h"))
            .is_ok());
        let mut credentials_changed = 0;
        while let Ok(line) = events.try_recv() {
            let (name, _) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if name == crate::handlers::credentials::CHANGED_EVENT {
                credentials_changed += 1;
            }
            assert_ne!(name, crate::handlers::accounts::CHANGED_EVENT);
        }
        assert_eq!(credentials_changed, 1);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn qualified_fresh_authority_does_not_revive_absent_credentials_from_metadata() {
        let mut a = row("a", "a@example.test", "h");
        a.as_object_mut().unwrap().remove("password");
        a["authType"] = json!("oauth2");
        a["oauth2Provider"] = json!("google");
        a["oauth2AccessToken"] = json!("synthetic-current-at");
        a["oauth2RefreshToken"] = json!("synthetic-current-rt");
        a["oauth2ExpiresAt"] = json!(99);
        let mut meta = clean(a.clone());
        meta["password"] = json!("synthetic-obsolete-password");
        meta["oauth2ClientId"] = json!("obsolete-client");
        meta["imapPort"] = json!(143);
        meta["fromEmail"] = json!("obsolete-alias@example.test");
        meta["customDisplayHint"] = json!("keep richer presentation");
        let rig = Rig::new(vec![a], vec![meta]);
        rig.save(json!({"patch":{"id":"a","fields":{"sentFolderOverride":"Sent fresh"}}}))
            .await
            .unwrap();
        let saved = rig.stored("a");
        assert!(
            ["password", "oauth2ClientId", "imapPort", "fromEmail"]
                .iter()
                .all(|k| saved.get(k).is_none()),
            "metadata must not manufacture absent credential-owned fields"
        );
        assert_eq!(saved["customDisplayHint"], "keep richer presentation");
        assert_eq!(
            rig.meta()[0]["customDisplayHint"],
            "keep richer presentation"
        );
        assert!(
            saved["oauth2AccessToken"] == "synthetic-current-at"
                && saved["oauth2RefreshToken"] == "synthetic-current-rt"
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn qualified_expired_handoff_starts_no_new_backend_stage() {
        for kind in ["debug", "keychain", "sealed"] {
            let a = row("a", "a@example.test", "h");
            let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
            let _backend = backend(&rig, kind);
            let (release, gate) = std::sync::mpsc::channel();
            let (entered, notice) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            operation_gates().lock().unwrap().insert(
                rig.state.app_dir.clone(),
                DocumentGate {
                    entered,
                    gate,
                    done,
                },
            );
            let (owned_done, owned_finished) = std::sync::mpsc::channel();
            credentials::test_owned_completions()
                .lock()
                .unwrap()
                .insert(rig.state.app_dir.clone(), owned_done);
            let _drain = credentials::TestTaskDrain(owned_finished);
            let mut pause = DocumentPause {
                release: Some(release),
                entered: notice,
                done: Some(finished),
            };
            TEST_REPLY_MS.store(300, std::sync::atomic::Ordering::SeqCst);
            let state = Arc::clone(&rig.state);
            let task = tokio::spawn(async move {
                save(
                    &state,
                    &json!({"patch":{"id":"a","fields":{"name":"must-not-start"}}}),
                    json!(1),
                )
                .await
            });
            pause.entered();
            assert_eq!(
                task.await.unwrap().error.unwrap().message,
                "errors.accountsWriteFailed"
            );
            pause.finish();
            drop(_drain);
            let stored = if let Some(store) = credentials::sealed() {
                let secrets = store.secrets().unwrap();
                serde_json::from_str::<Value>(&secrets.credentials["a"]).unwrap()
            } else {
                rig.stored("a")
            };
            assert!(
                stored.get("name").is_none(),
                "expired handoff must not start a credential backend write"
            );
            assert!(rig.meta()[0].get("name").is_none());
            assert!(rig
                .state
                .account_admission
                .try_reserve(scope("a", "a@example.test", "h"))
                .is_ok());
        }
    }
}
