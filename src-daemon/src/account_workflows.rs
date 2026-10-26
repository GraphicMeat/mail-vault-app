//! Native account workflows and persistence. Credential IO stays in the common credential
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
    Duplicate,
    Missing,
}
impl AccountSaveError {
    pub fn catalog_key(&self) -> &'static str {
        match self {
            Self::Invalid => "errors.accountsInvalid",
            Self::Conflict => "errors.accountsConflict",
            Self::WriteFailed => "errors.accountsWriteFailed",
            Self::Duplicate => "errors.duplicateAccount",
            Self::Missing => "errors.accountNotFound",
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
// Native-only source observations. Never serialize or debug this preimage.
struct OriginalSource {
    id: String,
    row: Value,
    credential_present: bool,
    metadata_present: bool,
}
enum AccountSourceProof {
    Exact(OriginalSource),
    StoredOAuth(crate::oauth_tokens::ProbeSource),
}
pub(crate) fn same_auth_context(a: &Value, b: &Value) -> bool {
    CONTEXT.iter().all(|k| a.get(*k) == b.get(*k))
}
fn same_source(a: &Value, b: &Value) -> bool {
    same_auth_context(a, b)
        && [
            "password",
            "oauth2AccessToken",
            "oauth2RefreshToken",
            "oauth2ExpiresAt",
        ]
        .iter()
        .all(|k| a.get(*k) == b.get(*k))
}
fn check_source(
    blob: &HashMap<String, String>,
    input: &AccountSaveInput,
    state: &DaemonState,
    generation: u64,
) -> Result<(), MutationFailure> {
    let Some(source) = &input.source else {
        return Ok(());
    };
    let Request::Patch { id, .. } = &input.request else {
        return Err(AccountSaveError::Conflict.into());
    };
    let rows = current(blob, &input.proof)?;
    let row = rows.get(id).ok_or(AccountSaveError::Conflict)?;
    let valid = match source {
        AccountSourceProof::Exact(original) => {
            original.id == *id
                && original.credential_present == blob.contains_key(id)
                && original.metadata_present
                    == input
                        .proof
                        .accounts
                        .iter()
                        .any(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
                && (same_source(&original.row, row)
                    || state
                        .tokens
                        .permits_explicit_rotation(id, &original.row, row, generation))
        }
        AccountSourceProof::StoredOAuth(proof) => proof.matches(
            state,
            id,
            row,
            generation,
            (
                blob.contains_key(id),
                input
                    .proof
                    .accounts
                    .iter()
                    .any(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str())),
            ),
        ),
    };
    if valid {
        Ok(())
    } else {
        Err(AccountSaveError::Conflict.into())
    }
}
pub(crate) struct AccountSaveInput {
    source: Option<AccountSourceProof>,
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
    generation: u64,
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
    if let CredentialOp::AccountSave(input) = op {
        check_source(blob, input, state, generation)?;
    }
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
        let result = save_owned(&state, request, deadline, &tx, None).await;
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
    source: Option<AccountSourceProof>,
) -> Result<Value, MutationFailure> {
    let snapshot = tokio::time::timeout_at(deadline, credentials::read_account_save_snapshot())
        .await
        .map_err(|_| AccountSaveError::WriteFailed)??;
    let doc = accounts_doc::shared(&state.app_dir);
    let read = Arc::clone(&doc);
    check_deadline(Some(deadline))?;
    #[cfg(test)]
    let save_read_path = state.app_dir.clone();
    let proof = tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        let _pause = save_read_pause(&save_read_path);
        check_deadline(Some(deadline))?;
        accounts_doc::list(&read)
            .map_err(|_| MutationFailure::Account(AccountSaveError::WriteFailed))
    })
    .await
    .map_err(|_| AccountSaveError::WriteFailed)?
    .map_err(|_| AccountSaveError::WriteFailed)?;
    let _discovery_generation = snapshot.generation;
    let input = AccountSaveInput {
        source,
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
struct SaveReadGate {
    entered: tokio::sync::oneshot::Sender<()>,
    gate: std::sync::mpsc::Receiver<()>,
    done: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
fn save_read_gates() -> &'static Mutex<HashMap<std::path::PathBuf, SaveReadGate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<std::path::PathBuf, SaveReadGate>>> =
        std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
fn save_read_pause(path: &std::path::Path) -> Option<credentials::TestTaskDone> {
    let gate = save_read_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(path);
    gate.map(|g| {
        let _ = g.entered.send(());
        let _ = g.gate.recv_timeout(Duration::from_secs(5));
        credentials::TestTaskDone(g.done)
    })
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

fn workflow_failure(code: Option<&str>, host: Option<&str>, port: Option<u16>) -> Value {
    json!({"ok":false,"stage":"probe","error":"errors.conn.couldReachMailServerCheck","errorCode":code,"host":host,"port":port})
}
#[cfg(test)]
static TEST_NOW_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
fn iso_now() -> Value {
    #[cfg(test)]
    {
        let ms = TEST_NOW_MS.load(std::sync::atomic::Ordering::SeqCst);
        if ms != 0 {
            return json!(chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }
    json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn normalize_candidate(
    candidate: &mut Value,
) -> Result<mailvault_core::imap::ImapConfig, MutationFailure> {
    let object = candidate.as_object_mut().ok_or(AccountSaveError::Invalid)?;
    if object
        .get("email")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(AccountSaveError::Invalid.into());
    }
    let graph = object.get("oauth2Transport").and_then(Value::as_str) == Some("graph");
    let jmap = object
        .get("jmapSessionUrl")
        .and_then(Value::as_str)
        .is_some_and(|u| !u.trim().is_empty());
    if graph && jmap {
        return Err(AccountSaveError::Invalid.into());
    }
    if jmap {
        let raw = object["jmapSessionUrl"].as_str().unwrap().trim().to_owned();
        let url = url::Url::parse(&raw).map_err(|_| AccountSaveError::Invalid)?;
        if !mailvault_core::jmap::base::url_allowed(&url)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.host_str().is_none()
        {
            return Err(AccountSaveError::Invalid.into());
        }
        object.insert("jmapSessionUrl".into(), json!(raw));
        object.insert(
            "imapHost".into(),
            json!(url.host_str().unwrap().to_ascii_lowercase()),
        );
    }
    let mut config_value = candidate.clone();
    config_value
        .as_object_mut()
        .unwrap()
        .entry("imapHost")
        .or_insert(json!(""));
    let config: mailvault_core::imap::ImapConfig =
        serde_json::from_value(config_value).map_err(|_| AccountSaveError::Invalid)?;
    if graph && !config.is_oauth2()
        || jmap && config.is_oauth2()
        || !graph && config.host.is_empty()
    {
        return Err(AccountSaveError::Invalid.into());
    }
    if jmap && config.jmap_auth().is_none()
        || !jmap && !config.is_oauth2() && config.password.as_deref().is_none_or(str::is_empty)
    {
        return Err(AccountSaveError::Invalid.into());
    }
    Ok(config)
}
fn connection_summary(
    host: Option<&str>,
    message_count: Option<u32>,
    from_address: Option<&str>,
) -> Option<Value> {
    host.filter(|h|!h.is_empty()).map(|host|json!({"host":host,"messageCount":message_count,"fromAddress":from_address.filter(|a|!a.is_empty())}))
}
async fn probe_candidate(
    state: &Arc<DaemonState>,
    config: &mailvault_core::imap::ImapConfig,
) -> Result<Option<Value>, Value> {
    use mailvault_core::{graph::GraphClient, net::classify_connection_error};
    if config.uses_jmap() {
        let url = url::Url::parse(config.jmap_session_url.as_deref().unwrap()).unwrap();
        let port = url.port_or_known_default().unwrap_or(443);
        return match crate::handlers::jmap_bridge::probe_connection(config).await {
            Ok(count) => Ok(connection_summary(
                Some(&config.host),
                count,
                Some(config.from_address()),
            )),
            Err(error) => Err(workflow_failure(
                Some(error.code()),
                Some(&config.host),
                Some(port),
            )),
        };
    }
    if config.uses_graph() {
        return GraphClient::for_purpose(
            config.access_token.as_deref().unwrap_or_default(),
            "account setup",
        )
        .for_account(&config.email)
        .list_folders()
        .await
        .map(|_| None)
        .map_err(|error| {
            workflow_failure(Some(classify_connection_error(&error).code()), None, None)
        });
    }
    match mailvault_core::imap::test_connection(config, &state.imap_pool).await {
        Ok(count) => Ok(connection_summary(
            Some(&config.host),
            count,
            Some(config.from_address()),
        )),
        Err(error) => Err(workflow_failure(
            Some(classify_connection_error(&error).code()),
            Some(&config.host),
            Some(config.effective_port()),
        )),
    }
}
fn workflow_request(params: &Value, add: bool) -> Result<(Request, String), MutationFailure> {
    Ok(if add {
        let object = params.as_object().ok_or(AccountSaveError::Invalid)?;
        if object.len() != 1 {
            return Err(AccountSaveError::Invalid.into());
        }
        let mut account = object
            .get("account")
            .cloned()
            .ok_or(AccountSaveError::Invalid)?;
        let target = id(&account)?.to_owned();
        let fields = account.as_object_mut().ok_or(AccountSaveError::Invalid)?;
        let security = fields.get("imapSecurity");
        if security
            .is_none_or(|v| v.is_null() || v == &json!(false) || v == &json!(0) || v == &json!(""))
        {
            fields.insert("imapSecurity".into(), json!("ssl"));
        }
        fields.insert("createdAt".into(), iso_now());
        (
            parse(&json!({"entries":[account],"ifAbsent":false}))?,
            target,
        )
    } else {
        if params.get("expected").is_none() {
            return Err(AccountSaveError::Invalid.into());
        }
        let mut request = parse(&json!({"patch":params}))?;
        let Request::Patch { id, fields, .. } = &mut request else {
            unreachable!()
        };
        fields.insert("updatedAt".into(), iso_now());
        let target = id.clone();
        (request, target)
    })
}
async fn run_account_workflow(
    state: &Arc<DaemonState>,
    params: &Value,
    add: bool,
    overall: Instant,
) -> Result<Value, MutationFailure> {
    let source_deadline = (Instant::now() + Duration::from_secs(75)).min(overall);
    let (mut request, target) = workflow_request(params, add)?;
    let snapshot =
        tokio::time::timeout_at(source_deadline, credentials::read_account_save_snapshot())
            .await
            .map_err(|_| AccountSaveError::WriteFailed)??;
    let doc = accounts_doc::shared(&state.app_dir);
    let listing = tokio::time::timeout_at(
        source_deadline,
        tokio::task::spawn_blocking(move || accounts_doc::list(&doc)),
    )
    .await
    .map_err(|_| AccountSaveError::WriteFailed)?
    .map_err(|_| AccountSaveError::WriteFailed)?
    .map_err(|_| AccountSaveError::WriteFailed)?;
    let rows = current(&snapshot.records, &listing)?;
    let mut candidate;
    let mut source = None;
    match &mut request {
        Request::Create { entries, .. } => {
            candidate = entries[0].clone();
            if rows.contains_key(&target) {
                return Err(AccountSaveError::Duplicate.into());
            }
        }
        Request::Patch {
            id,
            fields,
            unset,
            expected,
        } => {
            let original = rows.get(id).ok_or(AccountSaveError::Missing)?;
            if let Some(expected) = expected {
                check_expected(expected, original, snapshot.records.contains_key(id))?;
            }
            candidate = original.clone();
            candidate.as_object_mut().unwrap().extend(fields.clone());
            for key in unset.iter() {
                candidate.as_object_mut().unwrap().remove(key);
            }
            source = Some(AccountSourceProof::Exact(OriginalSource {
                id: id.clone(),
                row: original.clone(),
                credential_present: snapshot.records.contains_key(id),
                metadata_present: listing
                    .accounts
                    .iter()
                    .any(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str())),
            }));
        }
    }
    // Normalize once before origin comparison and provider selection.
    let mut config = normalize_candidate(&mut candidate)?;
    if rows.iter().any(|(id, row)| {
        (add || id != &target)
            && accounts_doc::logical_key(row) == accounts_doc::logical_key(&candidate)
    }) {
        return Err(AccountSaveError::Duplicate.into());
    }
    if let Request::Patch { id, fields, .. } = &mut request {
        let original = &rows[id];
        let explicit = if config.is_oauth2() {
            fields.contains_key("oauth2AccessToken") || fields.contains_key("oauth2RefreshToken")
        } else {
            fields.contains_key("password")
        };
        if explicit
            && config.is_oauth2()
            && fields
                .get("oauth2AccessToken")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Err(AccountSaveError::Invalid.into());
        }
        if !explicit {
            if !same_auth_context(original, &candidate) {
                return Err(AccountSaveError::Conflict.into());
            }
            // A metadata edit never writes a stale UI expiry back over native tokens.
            fields.remove("oauth2ExpiresAt");
            if config.is_oauth2() && crate::oauth_tokens::managed_probe_record(original) {
                let record = credentials::RecordSnapshot {
                    record: original.clone(),
                    generation: snapshot.generation,
                };
                match crate::oauth_tokens::resolve_probe(
                    state,
                    id,
                    record,
                    source_deadline,
                    (
                        snapshot.records.contains_key(id),
                        listing
                            .accounts
                            .iter()
                            .any(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str())),
                    ),
                )
                .await
                {
                    Ok((resolved, proof)) => {
                        config = resolved;
                        source = Some(AccountSourceProof::StoredOAuth(proof));
                    }
                    Err(error) if error.message == "errors.keychainBusy" => {
                        return Err(CredError::Busy.into())
                    }
                    Err(error) if error.kind == crate::oauth_tokens::FailKind::Unreadable => {
                        return Err(AccountSaveError::Conflict.into())
                    }
                    Err(error) => {
                        return Ok(workflow_failure(
                            Some(
                                mailvault_core::net::classify_connection_error(&error.message)
                                    .code(),
                            ),
                            Some(&config.host),
                            Some(config.effective_port()),
                        ))
                    }
                }
            }
        }
        if config.uses_jmap() {
            for key in ["imapHost", "jmapSessionUrl"] {
                fields.insert(key.into(), candidate[key].clone());
            }
        }
    } else if let Request::Create { entries, .. } = &mut request {
        entries[0] = candidate;
    }
    if config.is_oauth2() && config.access_token.as_deref().is_none_or(str::is_empty) {
        return Err(AccountSaveError::Invalid.into());
    }
    if Instant::now() >= source_deadline {
        return Err(AccountSaveError::WriteFailed.into());
    }
    let probe_deadline =
        (Instant::now() + Duration::from_secs(120)).min(overall - Duration::from_secs(90));
    if Instant::now() >= probe_deadline {
        return Err(AccountSaveError::WriteFailed.into());
    }
    let connection = match tokio::time::timeout_at(
        probe_deadline,
        mailvault_core::net_activity::with_purpose(
            "account setup",
            probe_candidate(state, &config),
        ),
    )
    .await
    {
        Ok(Ok(connection)) => connection,
        Ok(Err(failure)) => return Ok(failure),
        Err(_) => {
            let (host, port) = if config.uses_graph() {
                (None, None)
            } else {
                let port = if config.uses_jmap() {
                    url::Url::parse(config.jmap_session_url.as_deref().unwrap())
                        .unwrap()
                        .port_or_known_default()
                        .unwrap_or(443)
                } else {
                    config.effective_port()
                };
                (Some(config.host.as_str()), Some(port))
            };
            return Ok(workflow_failure(Some("blocked_or_timeout"), host, port));
        }
    };
    #[cfg(test)]
    let _stage = probe_pause(&state.app_dir).await;
    if Instant::now() + Duration::from_secs(90) > overall {
        return Err(AccountSaveError::WriteFailed.into());
    }
    let save_deadline = (Instant::now() + Duration::from_secs(90)).min(overall);
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let reply = tokio::time::timeout_at(
        save_deadline,
        save_owned(state, request, save_deadline, &tx, source),
    )
    .await
    .map_err(|_| AccountSaveError::WriteFailed)??;
    let account = reply["accounts"]
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or(AccountSaveError::WriteFailed)?;
    Ok(
        json!({"ok":true,"account":account,"connectionCheck":if add{connection}else{None},"hostChanged":reply["hostChanged"],"version":reply["version"],"credentialVersion":reply["credentialVersion"]}),
    )
}
pub(crate) async fn account_workflow(
    state: &Arc<DaemonState>,
    params: &Value,
    id: Value,
    add: bool,
) -> RpcResponse {
    let overall = Instant::now() + Duration::from_secs(300);
    match tokio::time::timeout_at(overall, run_account_workflow(state, params, add, overall)).await
    {
        Ok(Ok(reply)) => RpcResponse::success(id, reply),
        Ok(Err(error)) => rpc_error(id, error),
        Err(_) => rpc_error(id, AccountSaveError::WriteFailed.into()),
    }
}
#[cfg(test)]
struct ProbeGate {
    entered: tokio::sync::oneshot::Sender<()>,
    gate: tokio::sync::oneshot::Receiver<()>,
}
#[cfg(test)]
fn probe_gates() -> &'static Mutex<HashMap<std::path::PathBuf, ProbeGate>> {
    static G: std::sync::OnceLock<Mutex<HashMap<std::path::PathBuf, ProbeGate>>> =
        std::sync::OnceLock::new();
    G.get_or_init(Default::default)
}
#[cfg(test)]
async fn probe_pause(path: &std::path::Path) {
    let gate = probe_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(path);
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        let _ = gate.gate.await;
    }
}

#[cfg(test)]
pub(crate) async fn save_probe_for_test(
    state: &Arc<DaemonState>,
    id: &str,
    proof: crate::oauth_tokens::ProbeSource,
    fields: Value,
) -> bool {
    let request = parse(&json!({"patch":{"id":id,"fields":fields}}))
        .ok()
        .unwrap();
    let (tx, _rx) = tokio::sync::oneshot::channel();
    save_owned(
        state,
        request,
        Instant::now() + Duration::from_secs(90),
        &tx,
        Some(AccountSourceProof::StoredOAuth(proof)),
    )
    .await
    .is_ok()
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
            crate::oauth_tokens::drain_probe_resolvers();
            probe_gates()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.state.app_dir);
            self.state.tokens.drain_rechecks();
            TEST_REPLY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
            TEST_NOW_MS.store(0, std::sync::atomic::Ordering::SeqCst);
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
    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fix1_expired_post_interaction_entry_starts_no_keychain_write() {
        let a = row("a", "a@example.test", "h");
        let rig = Rig::new(vec![a.clone()], vec![clean(a)]);
        let (backend, _sealed) = backend(&rig, "keychain");
        let backend = backend.unwrap();
        let (done, finished) = std::sync::mpsc::channel();
        credentials::test_owned_completions()
            .lock()
            .unwrap()
            .insert(rig.state.app_dir.clone(), done);
        let drain = credentials::TestTaskDrain(finished);
        let mut pause = credentials::TestKeychainEntryPause::arm();
        TEST_REPLY_MS.store(300, std::sync::atomic::Ordering::SeqCst);
        let state = Arc::clone(&rig.state);
        let task = tokio::spawn(async move {
            save(
                &state,
                &json!({"patch":{"id":"a","fields":{"name":"must-not-write"}}}),
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
        pause.release();
        drop(drain);
        let writes = backend
            .0
            .modes
            .lock()
            .unwrap()
            .iter()
            .filter(|(kind, _)| *kind == "write")
            .count();
        assert_eq!(
            writes, 0,
            "expired post-interaction entry must not invoke actual synthetic backend write"
        );
        assert!(rig.stored("a").get("name").is_none());
        assert!(rig.meta()[0].get("name").is_none());
        assert!(rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", "h"))
            .is_ok());
        assert!(
            credentials::change_credentials_quiet(
                &rig.state,
                credentials::CredChange::Delete(vec!["missing".to_string()])
            )
            .await
            .is_ok(),
            "serializer released after owned finalization"
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_changed_source_refuses_before_metadata_or_legacy_effects() {
        for kind in ["debug", "keychain", "sealed"] {
            let a = row("a", "a@example.test", "h");
            let rig = Rig::new(vec![a.clone()], vec![clean(a.clone())]);
            let (_keychain, _sealed) = backend(&rig, kind);
            let source = AccountSourceProof::Exact(OriginalSource {
                id: "a".into(),
                row: a.clone(),
                credential_present: true,
                metadata_present: true,
            });
            let changed = credentials::change_credentials(
                &rig.state,
                CredChange::Update {
                    id: "a".into(),
                    fields: json!({"password":"synthetic-new-password"})
                        .as_object()
                        .unwrap()
                        .clone(),
                    chain: None,
                },
            )
            .await;
            assert!(changed.is_ok());
            let request =
                parse(&json!({"patch":{"id":"a","fields":{"displayName":"stale-probe"}}}))
                    .ok()
                    .unwrap();
            let (tx, _rx) = tokio::sync::oneshot::channel();
            let result = save_owned(
                &rig.state,
                request,
                Instant::now() + Duration::from_secs(90),
                &tx,
                Some(source),
            )
            .await;
            assert!(result.is_err(), "a successful stale probe must not save metadata after its credential source changed ({kind})");
            assert!(rig.meta()[0].get("displayName").is_none());
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_native_imap_add_update_and_origin_refusal() {
        let rig = Rig::new(vec![], vec![]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let account = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"password":"synthetic-password","createdAt":"caller"});
        let added = rig
            .call("accounts.add", json!({"account":account}))
            .await
            .unwrap();
        assert_eq!(added["ok"], true);
        assert_eq!(added["account"]["imapSecurity"], "ssl");
        assert_ne!(added["account"]["createdAt"], "caller");
        assert!(added["account"].get("password").is_none());
        assert!(added["connectionCheck"].is_object());
        assert!(rig.meta()[0].get("connectionCheck").is_none());
        let connections = server.connection_count();
        assert!(rig.call("accounts.add",json!({"account":{"id":"a","email":"other@example.test","imapHost":server.host(),"imapPort":server.port(),"password":"synthetic-password"}})).await.is_err());
        assert_eq!(server.connection_count(), connections);
        let elsewhere = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let error=rig.call("accounts.update",json!({"id":"a","fields":{"imapPort":elsewhere.port()},"expected":{"fields":{},"absent":[]}})).await;
        assert!(error.is_err());
        assert_eq!(elsewhere.connection_count(), 0);
        let updated=rig.call("accounts.update",json!({"id":"a","fields":{"displayName":"native"},"expected":{"fields":{},"absent":[]}})).await.unwrap();
        assert_eq!(updated["account"]["displayName"], "native");
        assert!(updated["connectionCheck"].is_null());
        assert_eq!(rig.stored("a")["password"], "synthetic-password");
        assert!(rig
            .call(
                "accounts.update",
                json!({"id":"missing","fields":{},"expected":{"fields":{},"absent":[]}})
            )
            .await
            .is_err());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_native_jmap_is_fresh_and_preserves_safe_failure_classification() {
        let rig = Rig::new(vec![], vec![]);
        let mut scenario = crate::jmap_test_support::scenario();
        scenario.accounts[0].username = "distinct-login".into();
        let server = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = crate::jmap_test_support::imap_trap();
        let mut account = crate::jmap_test_support::account_json(&server, port);
        account["id"] = json!("j");
        account["jmapUsername"] = json!("distinct-login");
        let added = rig
            .call("accounts.add", json!({"account":account}))
            .await
            .unwrap();
        assert_eq!(added["ok"], true);
        assert_eq!(added["connectionCheck"]["messageCount"], 2);
        assert!(trap.accept().is_err());
        let failed=rig.call("accounts.update",json!({"id":"j","fields":{"password":"synthetic-wrong"},"expected":{"fields":{},"absent":[]}})).await.unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["stage"], "probe");
        assert_eq!(failed["errorCode"], "E_JMAP_AUTH");
        assert_eq!(failed["error"], "errors.conn.couldReachMailServerCheck");
        assert!(!failed.to_string().contains("synthetic-wrong"));
        assert_eq!(rig.stored("j")["password"], "pw");

        server.mutate(|state| {
            state.api_url_override = Some(format!("http://localhost:{}/jmap/api", server.port()))
        });
        let bearer=rig.call("accounts.update",json!({"id":"j","fields":{"password":"tok","jmapAuth":"bearer"},"unset":["jmapUsername"],"expected":{"fields":{},"absent":[]}})).await.unwrap();
        assert_eq!(bearer["ok"], true);
        assert!(rig.stored("j").get("jmapUsername").is_none());
        assert!(trap.accept().is_err());
        server.mutate(|state| {
            state.api_url_override = Some("https://api.other.example.test/jmap/api".into())
        });
        let allowed = mailvault_core::jmap::JmapClient::connect(
            &server.session_url(),
            mailvault_core::jmap::JmapAuth::Bearer("tok".into()),
            "alice@example.test",
        )
        .await;
        assert!(
            allowed.is_ok(),
            "a session may advertise an authenticated endpoint on another HTTPS host"
        );

        let mut without_inbox = crate::jmap_test_support::scenario();
        for mailbox in &mut without_inbox.accounts[0].mailboxes {
            mailbox.role = None;
        }
        let no_inbox = mock_jmap::MockJmap::start(without_inbox);
        let config = crate::jmap_test_support::config(&no_inbox, 1);
        assert!(matches!(
            crate::handlers::jmap_bridge::probe_connection(&config).await,
            Ok(None)
        ));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_explicit_oauth_replacement_does_not_touch_the_old_flight_or_higher_expiry() {
        use mock_imap::oauth::{GrantSpec, MockOAuth, TokenAuthority};
        let authority = TokenAuthority::new();
        let signed = authority.sign_in(GrantSpec {
            client_id: mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID.into(),
            scope: "https://mail.google.com/".into(),
            expires_in: 3600,
            rotate: true,
        });
        let server = mock_imap::MockImap::start_checked(
            mock_imap::Scenario::new(),
            Arc::new(authority.clone()),
        );
        let original = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"authType":"oauth2","oauth2Provider":"google","oauth2ClientId":mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID,"oauth2AccessToken":"synthetic-old-unissued","oauth2RefreshToken":"synthetic-old-rt","oauth2ExpiresAt":i64::MAX});
        let rig = Rig::new(vec![original.clone()], vec![clean(original)]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let oauth = MockOAuth::start(authority.clone());
        rig.state
            .oauth2
            .set_token_endpoint_for_tests(Some(oauth.origin()));
        // Holding the old account flight proves explicit replacement never needs it.
        let flight = rig.state.tokens.test_hold_flight("a").await;
        let reply=tokio::time::timeout(Duration::from_secs(5),rig.call("accounts.update",json!({"id":"a","fields":{"oauth2AccessToken":signed.access_token,"oauth2RefreshToken":signed.refresh_token,"oauth2ExpiresAt":signed.expires_at},"expected":{"fields":{},"absent":[]}}))).await.unwrap().unwrap();
        drop(flight);
        assert_eq!(reply["ok"], true);
        assert_eq!(rig.stored("a")["oauth2AccessToken"], signed.access_token);
        assert!(authority.posts().is_empty());
        assert!(authority.auth_log().iter().all(|a| a.accepted));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_irrelevant_token_cannot_redirect_a_stored_password() {
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let elsewhere = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let original = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"authType":"password","password":"synthetic-old-password"});
        let rig = Rig::new(vec![original.clone()], vec![clean(original)]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let result=rig.call("accounts.update",json!({"id":"a","fields":{"imapPort":elsewhere.port(),"oauth2AccessToken":"synthetic-irrelevant-token"},"expected":{"fields":{},"absent":[]}})).await;
        assert!(result.is_err(),"an irrelevant submitted OAuth token cannot authorize sending the stored password to another origin");
        assert_eq!(elsewhere.connection_count(), 0);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_normalized_jmap_duplicate_refuses_before_authentication() {
        let rig = Rig::new(vec![], vec![]);
        let server = mock_jmap::MockJmap::start(crate::jmap_test_support::scenario());
        let mut account = crate::jmap_test_support::account_json(&server, 1);
        account["id"] = json!("a");
        assert_eq!(
            rig.call("accounts.add", json!({"account":account.clone()}))
                .await
                .unwrap()["ok"],
            true
        );
        let before = server.requests().len();
        account["id"] = json!("b");
        account["imapHost"] = json!("caller.example.test");
        assert!(rig
            .call("accounts.add", json!({"account":account}))
            .await
            .is_err());
        assert_eq!(server.requests().len(),before,"logical duplicate admission must use the normalized JMAP host before any provider authentication");
    }
    fn arm_probe(
        rig: &Rig,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (entered, notice) = tokio::sync::oneshot::channel();
        let (release, gate) = tokio::sync::oneshot::channel();
        probe_gates()
            .lock()
            .unwrap()
            .insert(rig.state.app_dir.clone(), ProbeGate { entered, gate });
        (notice, release)
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_real_workflow_releases_owners_while_worker_saves_r1_then_r2() {
        use mock_imap::oauth::{GrantSpec, MockOAuth, TokenAuthority};
        let auth = TokenAuthority::new();
        let signed = auth.sign_in(GrantSpec {
            client_id: mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID.into(),
            scope: "https://mail.google.com/".into(),
            expires_in: 3600,
            rotate: true,
        });
        let server =
            mock_imap::MockImap::start_checked(mock_imap::Scenario::new(), Arc::new(auth.clone()));
        let original = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"authType":"oauth2","oauth2Provider":"google","oauth2ClientId":mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID,"oauth2AccessToken":signed.access_token,"oauth2RefreshToken":signed.refresh_token,"oauth2ExpiresAt":1});
        let rig = Rig::new(vec![original.clone()], vec![clean(original)]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let oauth = MockOAuth::start(auth.clone());
        rig.state
            .oauth2
            .set_token_endpoint_for_tests(Some(oauth.origin()));
        let (entered, release) = arm_probe(&rig);
        let params = json!({"id":"a","fields":{"displayName":"after-probe"},"expected":{"fields":{},"absent":[]}});
        let workflow = account_workflow(&rig.state, &params, json!(1), false);
        tokio::pin!(workflow);
        tokio::select! {notice=entered=>notice.unwrap(),_=&mut workflow=>panic!("workflow completed before the real probe barrier")};
        let lease = rig
            .state
            .account_admission
            .try_reserve(scope("a", "a@example.test", &server.host()))
            .ok()
            .unwrap();
        drop(lease);
        let worker = crate::oauth_tokens::TestPersistenceWorker::start(&rig.state);
        worker.turn_after(0).await;
        let r1 = rig.stored("a");
        assert_ne!(r1["oauth2RefreshToken"], json!(signed.refresh_token));
        auth.advance(Duration::from_secs(3600));
        rig.state
            .tokens
            .advance_clock_for_tests(Duration::from_secs(3600));
        assert!(crate::oauth_tokens::access_token(
            &rig.state,
            "a",
            crate::oauth_tokens::Read::Quiet
        )
        .await
        .is_ok());
        worker.turn_after(1).await;
        worker.stop().await;
        let r2 = rig.stored("a");
        assert_ne!(r2["oauth2RefreshToken"], r1["oauth2RefreshToken"]);
        release.send(()).unwrap();
        let result = workflow.await;
        assert!(result.error.is_none());
        assert_eq!(result.result.unwrap()["ok"], true);
        let saved = rig.stored("a");
        assert!(
            saved["oauth2RefreshToken"] == r2["oauth2RefreshToken"]
                && saved["oauth2AccessToken"] == r2["oauth2AccessToken"]
        );
        assert_eq!(saved["displayName"], "after-probe");
        assert_eq!(auth.posts().len(), 2);
        assert!(auth.auth_log().iter().all(|a| a.accepted));
    }
    #[tokio::test]
    async fn s23_full_save_reserve_is_required_after_a_successful_probe() {
        let rig = Rig::new(vec![], vec![]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let (entered, release) = arm_probe(&rig);
        let params = json!({"account":{"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"password":"synthetic-password"}});
        let workflow = account_workflow(&rig.state, &params, json!(1), true);
        tokio::pin!(workflow);
        tokio::select! {notice=entered=>notice.unwrap(),_=&mut workflow=>panic!("probe did not reach its successful barrier")};
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(211)).await;
        release.send(()).unwrap();
        let result = workflow.await;
        tokio::time::resume();
        assert_eq!(result.error.unwrap().message, "errors.accountsWriteFailed");
        assert!(rig.blob().is_empty());
        assert_eq!(rig.meta(), json!([]));
    }
    #[tokio::test]
    async fn s23_unanswered_graph_is_cancelled_at_aggregate_cutoff_with_its_actual_location() {
        let rig = Rig::new(vec![], vec![]);
        let mut mock = crate::handlers::graph::test_graph_paused();
        let params = json!({"account":{"id":"g","email":"g@example.test","imapHost":"unrelated-imap.example.test","authType":"oauth2","oauth2Transport":"graph","oauth2AccessToken":"synthetic-graph-at","oauth2RefreshToken":"synthetic-graph-rt"}});
        let workflow = account_workflow(&rig.state, &params, json!(1), true);
        tokio::pin!(workflow);
        tokio::select! {notice=&mut mock.entered=>notice.unwrap(),_=&mut workflow=>panic!("Graph request was not held unanswered")};
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(120)).await;
        let result = workflow.await;
        tokio::time::resume();
        let reply = result.result.unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["errorCode"], "blocked_or_timeout");
        assert!(
            reply["host"].is_null() && reply["port"].is_null(),
            "an unanswered Graph request cannot be described as an IMAP destination"
        );
        assert!(rig.blob().is_empty());
        assert_eq!(rig.meta(), json!([]));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_graph_probe_preserves_list_batch_and_one_bounded_throttle_retry() {
        let rig = Rig::new(vec![], vec![]);
        let mail_before = mail_tree(&rig.dir.path().join("mail"));
        let responses = [
            "inbox",
            "sentitems",
            "drafts",
            "deleteditems",
            "junkemail",
            "archive",
        ]
        .iter()
        .map(|id| json!({"id":id,"status":200,"body":{"id":id}}))
        .collect::<Vec<_>>();
        let _mock=crate::handlers::graph::test_graph_mock_with(vec![(200,json!({"value":[{"id":"inbox","displayName":"Inbox","totalItemCount":0,"unreadItemCount":0}]}).to_string()),(429,"{}".into()),(200,json!({"responses":responses}).to_string())]);
        let reply=rig.call("accounts.add",json!({"account":{"id":"g","email":"g@example.test","authType":"oauth2","oauth2Transport":"graph","oauth2AccessToken":"synthetic-submitted-graph","oauth2RefreshToken":"synthetic-graph-rt"}})).await.unwrap();
        assert_eq!(reply["ok"], true);
        assert!(reply["connectionCheck"].is_null());
        assert!(reply["account"].get("oauth2AccessToken").is_none());
        let requests = crate::handlers::graph::test_graph_requests();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].path.contains("mailFolders"));
        assert_eq!(requests[1].path, "/$batch");
        assert_eq!(requests[2].path, "/$batch");
        assert!(requests.iter().all(|r| r
            .headers
            .get("authorization")
            .is_some_and(|h| h == "Bearer synthetic-submitted-graph")));
        assert_eq!(
            mail_tree(&rig.dir.path().join("mail")),
            mail_before,
            "probe must not adopt folder directories"
        );
    }
    #[test]
    fn s23_jmap_normalization_preserves_the_real_form_url_policy() {
        let mut candidate = json!({"id":"j","email":"a@example.test","jmapSessionUrl":"  https://JMAP.Example.test/session  ","jmapAuth":"basic","password":"synthetic-password","imapHost":"caller"});
        assert!(normalize_candidate(&mut candidate).is_ok());
        assert_eq!(candidate["imapHost"], "jmap.example.test");
        assert_eq!(
            candidate["jmapSessionUrl"],
            "https://JMAP.Example.test/session"
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_private_exact_proof_checks_presence_context_and_adds_no_backend_read() {
        let original = row("a", "a@example.test", "h");
        let rig = Rig::new(vec![original.clone()], vec![clean(original.clone())]);
        let guard =
            credentials::TestKeychainGuard::install(rig.dir.path().join("credentials.json"));
        let source = AccountSourceProof::Exact(OriginalSource {
            id: "a".into(),
            row: original.clone(),
            credential_present: true,
            metadata_present: true,
        });
        let request = parse(&json!({"patch":{"id":"a","fields":{"displayName":"source-checked"}}}))
            .ok()
            .unwrap();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        let before = guard
            .0
            .modes
            .lock()
            .unwrap()
            .iter()
            .filter(|(op, _)| *op == "read")
            .count();
        assert!(save_owned(
            &rig.state,
            request,
            Instant::now() + Duration::from_secs(90),
            &tx,
            Some(source)
        )
        .await
        .is_ok());
        let reads = guard
            .0
            .modes
            .lock()
            .unwrap()
            .iter()
            .filter(|(op, _)| *op == "read")
            .count()
            - before;
        assert_eq!(
            reads, 2,
            "only existing discovery and fresh mutation reads are permitted"
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_metadata_deletion_after_probe_cannot_resurrect_the_target() {
        let original = row("a", "a@example.test", "h");
        let rig = Rig::new(vec![original.clone()], vec![clean(original.clone())]);
        let source = AccountSourceProof::Exact(OriginalSource {
            id: "a".into(),
            row: original,
            credential_present: true,
            metadata_present: true,
        });
        assert!(rig
            .call("accounts.remove", json!({"ids":["a"]}))
            .await
            .is_ok());
        let request =
            parse(&json!({"patch":{"id":"a","fields":{"displayName":"must-not-resurrect"}}}))
                .ok()
                .unwrap();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        assert!(save_owned(
            &rig.state,
            request,
            Instant::now() + Duration::from_secs(90),
            &tx,
            Some(source)
        )
        .await
        .is_err());
        assert_eq!(rig.meta(), json!([]));
        assert!(rig.stored("a").get("displayName").is_none());
    }
    struct SaveReadPause {
        path: std::path::PathBuf,
        entered: tokio::sync::oneshot::Receiver<()>,
        release: Option<std::sync::mpsc::Sender<()>>,
        done: Option<std::sync::mpsc::Receiver<()>>,
    }
    impl SaveReadPause {
        fn arm(rig: &Rig) -> Self {
            let (entered, notice) = tokio::sync::oneshot::channel();
            let (release, gate) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            save_read_gates().lock().unwrap().insert(
                rig.state.app_dir.clone(),
                SaveReadGate {
                    entered,
                    gate,
                    done,
                },
            );
            Self {
                path: rig.state.app_dir.clone(),
                entered: notice,
                release: Some(release),
                done: Some(finished),
            }
        }
        fn finish(&mut self) {
            let unused = save_read_gates()
                .lock()
                .unwrap()
                .remove(&self.path)
                .is_some();
            self.release.take();
            if !unused {
                self.done
                    .take()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        }
    }
    impl Drop for SaveReadPause {
        fn drop(&mut self) {
            if self.done.is_some() {
                self.finish();
            }
        }
    }
    #[tokio::test]
    async fn s23_save_discovery_waiter_respects_its_own_ninety_second_stage() {
        use futures::FutureExt;
        let rig = Rig::new(vec![], vec![]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let mut paused = SaveReadPause::arm(&rig);
        let params = json!({"account":{"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"password":"synthetic-password"}});
        let workflow = account_workflow(&rig.state, &params, json!(1), true);
        tokio::pin!(workflow);
        tokio::select! {notice=&mut paused.entered=>notice.unwrap(),_=&mut workflow=>panic!("save discovery was not reached")};
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(91)).await;
        let result = workflow.as_mut().now_or_never();
        tokio::time::resume();
        paused.finish();
        assert!(
            result.is_some(),
            "save90 must bound discovery waiting independently of the native300 reply clock"
        );
        assert_eq!(
            result.unwrap().error.unwrap().message,
            "errors.accountsWriteFailed"
        );
        assert!(rig.blob().is_empty());
        assert_eq!(rig.meta(), json!([]));
    }

    fn mail_tree(root: &std::path::Path) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
        let mut result = BTreeMap::new();
        if !root.exists() {
            return result;
        }
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                result.insert(path.clone(), vec![]);
                result.extend(mail_tree(&path));
            } else {
                result.insert(path, std::fs::read(entry.path()).unwrap());
            }
        }
        result
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_frozen_js_corpus_drives_native_policy_and_preservation() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../src-core/tests/fixtures/account-add-update-cases.json"
        ))
        .unwrap();
        let mapping: Value = serde_json::from_str(include_str!(
            "../../src-core/tests/fixtures/account-add-update-native-map.json"
        ))
        .unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 27);
        assert_eq!(mapping.as_object().unwrap().len(), 27);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let profile = mapping[name]["native"]
                .as_str()
                .expect("every frozen case has an explicit native mapping");
            let mut initial = case["initial"].as_array().unwrap().clone();
            let mut submitted = case["input"].clone();
            let add = case["kind"] == "add";
            let routed = matches!(
                profile,
                "early-duplicate"
                    | "early-missing"
                    | "early-origin"
                    | "probe-refusal"
                    | "save-failure"
            );
            let mut scenario =
                mock_imap::Scenario::new().mailbox(mock_imap::state::synthetic_mailbox("INBOX", 2));
            if profile == "probe-refusal" {
                scenario = scenario.fault(
                    mock_imap::Trigger::on("LOGIN"),
                    mock_imap::Action::RefuseWith(
                        "NO".into(),
                        "[AUTHENTICATIONFAILED] synthetic refusal".into(),
                    ),
                );
            }
            let server = mock_imap::MockImap::start(scenario);
            if routed {
                for row in initial.iter_mut().chain(std::iter::once(&mut submitted)) {
                    if let Some(host) = row.get("imapHost").and_then(Value::as_str) {
                        row["imapHost"] = json!(if host.eq_ignore_ascii_case("other") {
                            "localhost"
                        } else {
                            "127.0.0.1"
                        });
                    }
                    if add || row.get("id").is_some() {
                        row["imapPort"] = json!(server.port());
                        row["imapSecure"] = json!(false);
                    }
                }
            }
            let rig = Rig::new(
                initial.clone(),
                initial.iter().cloned().map(clean).collect(),
            );
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
            TEST_NOW_MS.store(
                chrono::DateTime::parse_from_rfc3339("2026-10-26T00:00:00.000Z")
                    .unwrap()
                    .timestamp_millis(),
                std::sync::atomic::Ordering::SeqCst,
            );
            let params = if add {
                json!({"account":submitted})
            } else {
                json!({"id":"a","fields":submitted,"expected":{"fields":{},"absent":[]}})
            };
            if routed {
                let before = rig.meta();
                let backend = if profile == "save-failure" {
                    let guard = credentials::TestKeychainGuard::install(
                        rig.dir.path().join("credentials.json"),
                    );
                    guard
                        .0
                        .fail_write
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    Some(guard)
                } else {
                    None
                };
                let reply = account_workflow(&rig.state, &params, json!(1), add).await;
                match profile {
                    "probe-refusal" => {
                        let result = reply.result.unwrap();
                        assert_eq!(result["ok"], false);
                        assert_eq!(result["errorCode"], "auth");
                        assert_eq!(server.connection_count(), 1);
                    }
                    "save-failure" => {
                        assert_eq!(reply.error.unwrap().message, "errors.keychainWriteFailed")
                    }
                    "early-duplicate" => {
                        assert_eq!(reply.error.unwrap().message, "errors.duplicateAccount")
                    }
                    "early-missing" => {
                        assert_eq!(reply.error.unwrap().message, "errors.accountNotFound")
                    }
                    "early-origin" => {
                        assert_eq!(reply.error.unwrap().message, "errors.accountsConflict")
                    }
                    _ => unreachable!(),
                }
                if profile.starts_with("early-") {
                    assert_eq!(server.connection_count(), 0);
                }
                assert_eq!(
                    rig.meta(),
                    before,
                    "{name}: refused workflow must preserve metadata"
                );
                drop(backend);
                continue;
            }
            let (mut request, _) = workflow_request(&params, add).ok().unwrap();
            let mut candidate = match &request {
                Request::Create { entries, .. } => entries[0].clone(),
                Request::Patch { id, fields, .. } => {
                    let mut value = initial.iter().find(|a| a["id"] == *id).unwrap().clone();
                    value.as_object_mut().unwrap().extend(fields.clone());
                    value
                }
            };
            let config = normalize_candidate(&mut candidate);
            if profile == "contradictory-auth" {
                assert!(config.is_err(),"{name}: historical Graph/password fixture is a deliberate native safety refusal");
                continue;
            }
            assert_eq!(profile, "kernel");
            let config = config.ok().unwrap();
            if let Request::Create { entries, .. } = &mut request {
                entries[0] = candidate;
            }
            let input = AccountSaveInput {
                request,
                proof: Listing {
                    accounts: initial.iter().cloned().map(clean).collect(),
                    version: 1,
                    recovered: None,
                },
                deadline: Instant::now() + Duration::from_secs(90),
                source: None,
            };
            let before_blob = rig.blob();
            let (next, applied, _) = prepare(&before_blob, &input).ok().unwrap();
            let prepared = applied.prepared.unwrap();
            let target = prepared.rows[0]["id"].as_str().unwrap();
            for (id, raw) in &before_blob {
                if id != target {
                    assert_eq!(
                        next.get(id),
                        Some(raw),
                        "{name}: unrelated credential bytes must remain exact"
                    );
                }
            }
            let mut expected = case["persisted"][0].clone();
            for key in ["password", "oauth2AccessToken", "oauth2RefreshToken"] {
                expected.as_object_mut().unwrap().remove(key);
            }
            if config.uses_jmap() {
                expected["imapHost"] = json!("jmap.example.test");
            }
            assert_eq!(
                prepared.rows[0], expected,
                "{name}: native fresh persistence projection must preserve the captured policy"
            );
            if add {
                let response = &case["response"];
                let actual = if config.uses_graph() {
                    None
                } else {
                    connection_summary(
                        response["host"].as_str(),
                        response["messageCount"]
                            .as_u64()
                            .and_then(|n| u32::try_from(n).ok()),
                        response["fromAddress"].as_str(),
                    )
                };
                assert_eq!(
                    actual.unwrap_or(Value::Null),
                    case["result"]["connectionCheck"],
                    "{name}: typed native summary policy must match the captured answer"
                );
            }
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_explicit_missing_credential_uses_exact_absence_and_refuses_a_new_owner() {
        for competing in [false, true] {
            let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
            let metadata = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"authType":"password"});
            let rig = Rig::new(vec![], vec![metadata.clone()]);
            std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
            let (entered, release) = arm_probe(&rig);
            let params = json!({"id":"a","fields":{"password":"synthetic-new-password","displayName":"workflow"},"expected":{"fields":{},"absent":[]}});
            let workflow = account_workflow(&rig.state, &params, json!(1), false);
            tokio::pin!(workflow);
            tokio::select! {notice=entered=>notice.unwrap(),_=&mut workflow=>panic!("explicit absence path did not reach its probe")};
            if competing {
                let mut other = metadata;
                other["password"] = json!("synthetic-new-password");
                other["displayName"] = json!("new-owner");
                assert!(credentials::change_credentials(
                    &rig.state,
                    CredChange::Save([("a".into(), other.to_string())].into_iter().collect())
                )
                .await
                .is_ok());
            }
            release.send(()).unwrap();
            let result = workflow.await;
            if competing {
                assert_eq!(result.error.unwrap().message, "errors.accountsConflict");
                assert_eq!(rig.stored("a")["displayName"], "new-owner");
                assert!(rig.meta()[0].get("displayName").is_none());
            } else {
                assert_eq!(result.result.unwrap()["ok"], true);
                assert_eq!(rig.stored("a")["password"], "synthetic-new-password");
            }
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_failed_native_read_cannot_fall_back_to_a_valid_cached_token() {
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let original = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"authType":"oauth2","oauth2Provider":"google","oauth2ClientId":mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID,"oauth2AccessToken":"synthetic-cached-at","oauth2RefreshToken":"synthetic-cached-rt","oauth2ExpiresAt":i64::MAX});
        let rig = Rig::new(vec![original.clone()], vec![clean(original)]);
        let backend =
            credentials::TestKeychainGuard::install(rig.dir.path().join("credentials.json"));
        assert!(crate::oauth_tokens::access_token(
            &rig.state,
            "a",
            crate::oauth_tokens::Read::Quiet
        )
        .await
        .is_ok());
        assert!(rig.state.tokens.has_trusted_token_for_test("a"));
        backend
            .0
            .denied
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let result=rig.call("accounts.update",json!({"id":"a","fields":{"displayName":"must-not-probe"},"expected":{"fields":{},"absent":[]}})).await;
        backend
            .0
            .denied
            .store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(credentials::read_account_save_snapshot().await.is_ok());
        assert_eq!(result.unwrap_err(), "errors.keychainUnavailable");
        assert_eq!(server.connection_count(), 0);
        assert!(rig.meta()[0].get("displayName").is_none());
    }
    #[tokio::test]
    async fn s23_cancelled_imap_probe_releases_the_actual_authentication_slot() {
        struct HeldAuth {
            entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl mock_imap::oauth::TokenCheck for HeldAuth {
            fn check(&self, _: &str, _: &str, _: &str) -> bool {
                if let Some(tx) = self.entered.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                let _ = self
                    .release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5));
                true
            }
        }
        let rig = Rig::new(vec![], vec![]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let (entered, notice) = tokio::sync::oneshot::channel();
        let (release, gate) = std::sync::mpsc::channel();
        let server = mock_imap::MockImap::start_checked(
            mock_imap::Scenario::new(),
            Arc::new(HeldAuth {
                entered: Mutex::new(Some(entered)),
                release: Mutex::new(gate),
            }),
        );
        let candidate = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"authType":"oauth2","oauth2AccessToken":"synthetic-submitted-at"});
        let config: mailvault_core::imap::ImapConfig =
            serde_json::from_value(candidate.clone()).unwrap();
        let mut held = Vec::new();
        for _ in 1..mailvault_core::imap::pool::MAX_CONNECTIONS_PER_ACCOUNT {
            held.push(rig.state.imap_pool.connection_slot(&config).await.unwrap());
        }
        let params = json!({"account":candidate});
        let workflow = account_workflow(&rig.state, &params, json!(1), true);
        tokio::pin!(workflow);
        tokio::select! {value=notice=>value.unwrap(),_=&mut workflow=>panic!("actual IMAP AUTH was not reached")};
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(120)).await;
        let result = workflow.await;
        tokio::time::resume();
        drop(release);
        assert_eq!(result.result.unwrap()["errorCode"], "blocked_or_timeout");
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                rig.state.imap_pool.connection_slot(&config)
            )
            .await
            .unwrap()
            .is_ok(),
            "cancelled probe must release the seventh actual connection slot"
        );
        assert!(rig.blob().is_empty());
        assert_eq!(rig.meta(), json!([]));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_fresh_jmap_refuses_foreign_discovery_redirect_before_sending_credentials() {
        use std::io::{Read, Write};
        mailvault_core::jmap::base::allow_loopback_for_tests();
        let rig = Rig::new(vec![], vec![]);
        let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        foreign.set_nonblocking(true).unwrap();
        let source = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        source.set_nonblocking(true).unwrap();
        let source_port = source.local_addr().unwrap().port();
        let target = foreign.local_addr().unwrap().port();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let task = std::thread::spawn(move || {
            let mut stream = loop {
                match source.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop.load(std::sync::atomic::Ordering::SeqCst) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => request.extend_from_slice(&buffer[..n]),
                }
            }
            let _=write!(stream,"HTTP/1.1 302 Found\r\nLocation: http://localhost:{target}/session\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        struct Stop(
            Arc<std::sync::atomic::AtomicBool>,
            Option<std::thread::JoinHandle<()>>,
        );
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
                if let Some(task) = self.1.take() {
                    let _ = task.join();
                }
            }
        }
        let _stop = Stop(stopped, Some(task));
        let result=rig.call("accounts.add",json!({"account":{"id":"j","email":"a@example.test","jmapSessionUrl":format!("http://127.0.0.1:{source_port}/session"),"jmapAuth":"basic","password":"synthetic-password"}})).await.unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["errorCode"], "E_JMAP_FOREIGN_HOST");
        assert!(foreign.accept().is_err());
        assert!(rig.blob().is_empty());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_every_captured_auth_or_secret_field_fences_a_stale_probe() {
        for key in [
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
            "password",
            "oauth2AccessToken",
            "oauth2RefreshToken",
            "oauth2ExpiresAt",
        ] {
            let original = row("a", "a@example.test", "h");
            let rig = Rig::new(vec![original.clone()], vec![clean(original.clone())]);
            let source = AccountSourceProof::Exact(OriginalSource {
                id: "a".into(),
                row: original,
                credential_present: true,
                metadata_present: true,
            });
            assert!(credentials::change_credentials(
                &rig.state,
                CredChange::Update {
                    id: "a".into(),
                    fields: [(key.into(), json!("synthetic-context-change"))]
                        .into_iter()
                        .collect(),
                    chain: None
                }
            )
            .await
            .is_ok());
            let before = rig.blob();
            let request = parse(&json!({"patch":{"id":"a","fields":{"displayName":"stale"}}}))
                .ok()
                .unwrap();
            let (tx, _rx) = tokio::sync::oneshot::channel();
            assert!(
                save_owned(
                    &rig.state,
                    request,
                    Instant::now() + Duration::from_secs(90),
                    &tx,
                    Some(source)
                )
                .await
                .is_err(),
                "{key} must remain bound to the captured native source"
            );
            assert_eq!(rig.blob(), before);
            assert!(rig.meta()[0].get("displayName").is_none());
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn s23_competing_identity_during_add_probe_wins_final_admission() {
        let rig = Rig::new(vec![], vec![]);
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new());
        let account = json!({"id":"a","email":"a@example.test","imapHost":server.host(),"imapPort":server.port(),"imapSecure":false,"password":"synthetic-first"});
        let (entered, release) = arm_probe(&rig);
        let params = json!({"account":account.clone()});
        let workflow = account_workflow(&rig.state, &params, json!(1), true);
        tokio::pin!(workflow);
        tokio::select! {notice=entered=>notice.unwrap(),_=&mut workflow=>panic!("probe did not reach final-admission barrier")};
        let mut other = account;
        other["id"] = json!("b");
        other["password"] = json!("synthetic-competing");
        assert!(rig
            .save(json!({"entries":[other],"ifAbsent":false}))
            .await
            .is_ok());
        release.send(()).unwrap();
        assert_eq!(
            workflow.await.error.unwrap().message,
            "errors.accountsConflict"
        );
        assert!(!rig.blob().contains_key("a"));
        assert_eq!(rig.stored("b")["password"], "synthetic-competing");
        assert_eq!(rig.meta().as_array().unwrap().len(), 1);
    }
}
