//! Frozen user bulk intent and its single app.db pending record.
//!
//! This module performs no mail IO. A pending record is evidence, never
//! permission to replay a destructive phase. Callers serialize mutations with
//! the daemon journal mutex; the existing op_journal accessors own storage.
use crate::op_journal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Archive,
    Delete,
    ArchiveAndDelete,
    ArchiveBackupDelete,
    DeleteEverywhere,
}
impl Action {
    fn initial_phase(self) -> &'static str {
        match self {
            Self::Delete | Self::DeleteEverywhere => "delete",
            _ => "archive",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub account_id: Option<String>,
    pub mailbox: Option<String>,
    #[serde(default)]
    pub spans: bool,
    pub keys: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mailbox {
    pub account_id: String,
    pub mailbox: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub account_id: String,
    pub mailbox: String,
    pub uids: Vec<u32>,
}
impl Group {
    fn key(&self, uid: u32) -> Value {
        json!(format!("{}:{}:{}", self.account_id, self.mailbox, uid))
    }
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Grouped {
    pub groups: Vec<Group>,
    pub refused: Vec<Value>,
}

fn numeric_uid(raw: &str) -> Option<u32> {
    if raw.is_empty() || !raw.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

fn target(key: &Value, scope: &Scope) -> Option<(String, String, u32)> {
    if let Some(raw) = key.as_str() {
        if let Some(first) = raw.find(':').filter(|i| *i > 0) {
            let last = raw.rfind(':')?;
            if last == first {
                return None;
            }
            let account = &raw[..first];
            let mailbox = &raw[first + 1..last];
            if mailbox.is_empty() || mailbox == "UNIFIED" {
                return None;
            }
            return Some((
                account.into(),
                mailbox.into(),
                numeric_uid(&raw[last + 1..])?,
            ));
        }
    }
    if scope.spans {
        return None;
    }
    let account = scope.account_id.as_ref().filter(|a| !a.is_empty())?;
    let mailbox = scope
        .mailbox
        .as_ref()
        .filter(|m| !m.is_empty() && m.as_str() != "UNIFIED")?;
    // The old JS helper accepted out-of-range integers, but its u32 RPC
    // decoder refused them. Never cast them into a different server UID.
    let uid = match key {
        Value::String(raw) => numeric_uid(raw)?,
        Value::Number(n) => u32::try_from(n.as_u64()?).ok()?,
        _ => return None,
    };
    Some((account.clone(), mailbox.clone(), uid))
}

pub fn group_targets(scope: &Scope) -> Grouped {
    let mut grouped = Grouped {
        groups: Vec::new(),
        refused: Vec::new(),
    };
    let mut groups_by_mailbox = HashMap::new();
    let mut seen = HashSet::new();
    for key in &scope.keys {
        let Some((account_id, mailbox, uid)) = target(key, scope) else {
            grouped.refused.push(key.clone());
            continue;
        };
        let index = *groups_by_mailbox
            .entry((account_id.clone(), mailbox.clone()))
            .or_insert_with(|| {
                let index = grouped.groups.len();
                grouped.groups.push(Group {
                    account_id,
                    mailbox,
                    uids: Vec::new(),
                });
                index
            });
        if seen.insert((index, uid)) {
            grouped.groups[index].uids.push(uid);
        }
    }
    grouped
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenIntent {
    operation: Action,
    scope: Scope,
    groups: Vec<Group>,
    refused: Vec<Value>,
    skipped_local: usize,
}
impl FrozenIntent {
    /// Account ids and local folders come from daemon-owned current storage,
    /// never serialized account objects or client claims of local provenance.
    pub fn freeze(operation: Action, scope: Scope, accounts: &[String], local: &[Mailbox]) -> Self {
        let mut intent = Self {
            operation,
            scope,
            groups: Vec::new(),
            refused: Vec::new(),
            skipped_local: 0,
        };
        // Purge needs provider/provenance resolution, rather than IMAP-only
        // grouping. Preserve every exact key until that separate proof step.
        if operation == Action::DeleteEverywhere {
            return intent;
        }
        let grouped = group_targets(&intent.scope);
        intent.refused = grouped.refused;
        for group in grouped.groups {
            if !accounts.contains(&group.account_id) {
                intent
                    .refused
                    .extend(group.uids.iter().map(|uid| group.key(*uid)));
            } else if local
                .iter()
                .any(|m| m.account_id == group.account_id && m.mailbox == group.mailbox)
            {
                intent.skipped_local += group.uids.len();
            } else {
                intent.groups.push(group);
            }
        }
        intent
    }
    pub fn action(&self) -> Action {
        self.operation
    }
    pub fn groups(&self) -> &[Group] {
        &self.groups
    }
    pub fn target_keys(&self) -> Vec<Value> {
        if self.operation == Action::DeleteEverywhere {
            self.scope.keys.clone()
        } else {
            self.groups
                .iter()
                .flat_map(|g| g.uids.iter().map(|uid| g.key(*uid)))
                .collect()
        }
    }
    pub fn skipped(&self) -> usize {
        self.refused.len()
    }
    pub fn skipped_local(&self) -> usize {
        self.skipped_local
    }
}

#[derive(Clone)]
struct Pending {
    raw: Value,
    id: String,
    operation: Action,
    keys: Vec<Value>,
    completed: Vec<Value>,
    terminal: bool,
    intent: Option<Arc<FrozenIntent>>,
}
impl Pending {
    fn parse(raw: Value) -> Result<Self, String> {
        let invalid = || "errors.bulkPendingInvalid".to_string();
        let id = raw["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(invalid)?
            .to_owned();
        let operation: Action =
            serde_json::from_value(raw["type"].clone()).map_err(|_| invalid())?;
        let keys = raw["totalUids"].as_array().ok_or_else(invalid)?.clone();
        let completed = raw["completedUids"].as_array().ok_or_else(invalid)?.clone();
        let status = raw["status"].as_str().ok_or_else(invalid)?;
        let terminal = matches!(status, "complete" | "cancelled");
        if raw
            .get("attemptId")
            .is_some_and(|attempt| attempt.as_str().is_none_or(|attempt| attempt.is_empty()))
        {
            return Err(invalid());
        }

        let mut frozen = None;
        if let Some(version) = raw.get("schemaVersion") {
            if version.as_u64() != Some(1) {
                return Err("errors.bulkPendingVersion".into());
            }
            let intent: FrozenIntent =
                serde_json::from_value(raw["intent"].clone()).map_err(|_| invalid())?;
            if intent.operation != operation || intent.target_keys() != keys {
                return Err(invalid());
            }
            if let Some(worker) = raw.get("worker") {
                let work: crate::bulk_worker::Workflow =
                    serde_json::from_value(worker.clone()).map_err(|_| invalid())?;
                if !work.valid_for(&intent) {
                    return Err(invalid());
                }
            }
            frozen = Some(Arc::new(intent));
        }
        Ok(Self {
            raw,
            id,
            operation,
            keys,
            completed,
            terminal,
            intent: frozen,
        })
    }
    fn remaining(&self) -> Vec<Value> {
        let completed: HashSet<_> = self.completed.iter().collect();
        self.keys
            .iter()
            .filter(|key| !completed.contains(key))
            .cloned()
            .collect()
    }
    fn snapshot(&self, status: &str) -> Value {
        let remaining = self.remaining().len();
        let mut snapshot = json!({
           "id":self.id, "type":self.operation, "status":status,
           "currentPhase":self.raw.get("currentPhase").cloned().unwrap_or_else(|| json!(self.operation.initial_phase())),
           "total":self.keys.len(), "completed":self.keys.len() - remaining,
           "remaining":remaining, "errors":self.raw.get("errors").cloned().unwrap_or(json!(0)),
           "skipped":self.raw.get("skipped").cloned().unwrap_or(json!(0)),
           "skippedLocal":self.raw.get("skippedLocal").cloned().unwrap_or(json!(0)),
           "result":self.raw.get("result").cloned().unwrap_or(Value::Null),
           "lastError":self.raw.get("lastError").cloned().unwrap_or(Value::Null)
        });
        if let Some(attempt) = self.raw.get("attemptId") {
            snapshot["attemptId"] = attempt.clone();
        }
        snapshot
    }
}

/// A selection to re-resolve, NOT a deletion authorization. Even a versioned
/// pending record requires new provider identity and copy verification.
pub struct ResumePlan {
    pub operation: Action,
    pub scope: Scope,
    pub keys: Vec<Value>,
    pub requires_fresh_identity: bool,
}
struct Active {
    id: String,
    attempt_id: String,
    intent: FrozenIntent,
    snapshot: Value,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AdmissionState {
    Freezing,
    Running,
    Done,
    Fenced,
    Rejected,
}
struct Admission {
    operation_id: String,
    state: AdmissionState,
    owner_attempt: Option<String>,
}

pub struct CheckpointSeed {
    base: Arc<Pending>,
    id: String,
    attempt: String,
}
pub struct PreparedCheckpoint {
    base: Arc<Pending>,
    pending: Arc<Pending>,
    id: String,
    attempt: String,
    encoded: String,
    snapshot: Value,
}
impl CheckpointSeed {
    /// All selection-sized cloning, validation and JSON encoding happens here,
    /// outside coordinator, journal and app.db locks.
    pub fn prepare(
        self,
        work: &crate::bulk_worker::Workflow,
    ) -> Result<PreparedCheckpoint, String> {
        if self.base.intent.as_deref() != Some(&work.intent) {
            return Err("errors.bulkStale".into());
        }
        let mut raw = self.base.raw.clone();
        raw["attemptId"] = json!(self.attempt);
        raw["worker"] =
            serde_json::to_value(work).map_err(|_| "errors.bulkPendingWrite".to_string())?;
        raw["completedUids"] = json!(work.completed_keys());
        raw["currentPhase"] = json!(work.phase);
        raw["status"] = json!(work.status);
        raw["result"] = json!(work.result);
        raw["lastError"] = json!(work.last_error);
        raw["errors"] = json!(work.errors);
        let encoded = raw.to_string();
        let pending = Arc::new(Pending::parse(raw)?);
        let snapshot = pending.snapshot(&work.status);
        Ok(PreparedCheckpoint {
            base: self.base,
            pending,
            id: self.id,
            attempt: self.attempt,
            encoded,
            snapshot,
        })
    }
}
impl PreparedCheckpoint {
    /// Must follow validate_checkpoint under the daemon journal fence. Keep
    /// that fence through publish_checkpoint; no bulk lock is needed for IO.
    pub fn persist(&self, data_dir: &Path) -> Result<(), String> {
        op_journal::pending_operation_save_encoded(data_dir, &self.encoded)
            .map_err(|_| "errors.bulkPendingWrite".into())
    }
}

pub struct Coordinator {
    active: Option<Active>,
    admissions: HashMap<String, Admission>,
    pending: Result<Option<Arc<Pending>>, String>,
}
impl Coordinator {
    /// Startup only reads app.db; it never launches a worker or touches mail.
    pub fn load(data_dir: &Path) -> Self {
        Self {
            active: None,
            admissions: HashMap::new(),
            pending: Self::read(data_dir),
        }
    }
    fn read(data_dir: &Path) -> Result<Option<Arc<Pending>>, String> {
        op_journal::pending_operation_read(data_dir)
            .map_err(|_| "errors.bulkPendingRead".to_string())?
            .map(|raw| Pending::parse(raw).map(Arc::new))
            .transpose()
    }
    fn refresh(&mut self, data_dir: &Path) -> Result<(), String> {
        // The old facade still writes legacy records during migration. Disk
        // remains authoritative; this decoded view is not another journal.
        self.pending = Self::read(data_dir);
        self.pending.as_ref().map(|_| ()).map_err(Clone::clone)
    }
    fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref().ok().and_then(Option::as_deref)
    }
    pub fn active_status(&self) -> Option<Value> {
        self.active
            .as_ref()
            .map(|active| json!({"active":active.snapshot,"pending":null}))
    }
    pub fn duplicate_start(
        &self,
        id: &str,
        action: Action,
        scope: &Scope,
    ) -> Result<Option<Value>, String> {
        if let Some(active) = &self.active {
            return if active.id == id
                && active.intent.operation == action
                && active.intent.scope == *scope
            {
                Ok(Some(active.snapshot.clone()))
            } else {
                Err("errors.operationRunning".into())
            };
        }
        if let Some(pending) = self
            .pending()
            .filter(|pending| pending.id == id && pending.terminal)
        {
            return match pending.intent.as_deref() {
                Some(intent) if intent.operation == action && intent.scope == *scope => Ok(Some(
                    pending.snapshot(pending.raw["status"].as_str().unwrap_or("complete")),
                )),
                _ => Err("errors.bulkStale".into()),
            };
        }
        Ok(None)
    }
    pub fn status(&mut self, data_dir: &Path) -> Result<Value, String> {
        if let Some(status) = self.active_status() {
            return Ok(status);
        }
        self.refresh(data_dir)?;
        let active = self.active.as_ref().map(|a| a.snapshot.clone());
        let pending = if active.is_some() {
            None
        } else {
            self.pending()
                .filter(|p| !p.terminal)
                .map(|p| p.snapshot("awaitingResume"))
        };
        Ok(json!({"active":active, "pending":pending}))
    }
    /// Internal worker kickoff seam. No RPC may call this until its worker
    /// exists. The intent reaches durable storage before ownership is returned.
    pub fn claim(
        &mut self,
        data_dir: &Path,
        id: &str,
        intent: FrozenIntent,
    ) -> Result<Value, String> {
        self.claim_attempt(data_dir, id, id, intent)
    }
    pub fn claim_attempt(
        &mut self,
        data_dir: &Path,
        id: &str,
        attempt: &str,
        intent: FrozenIntent,
    ) -> Result<Value, String> {
        self.require_unfenced(id, attempt)?;
        self.refresh(data_dir)?;
        if let Some(active) = &self.active {
            if active.id == id && active.intent == intent {
                let snapshot = active.snapshot.clone();
                let owner = active.attempt_id.clone();
                self.running_admission(id, attempt, &owner);
                return Ok(snapshot);
            }
            return Err("errors.operationRunning".into());
        }
        if let Some(pending) = self.pending().filter(|p| p.terminal && p.id == id) {
            let previous: FrozenIntent = serde_json::from_value(pending.raw["intent"].clone())
                .map_err(|_| "errors.bulkStale".to_string())?;
            return if previous == intent {
                Ok(pending.snapshot(pending.raw["status"].as_str().unwrap_or("complete")))
            } else {
                Err("errors.bulkStale".into())
            };
        }
        if self.pending().is_some_and(|p| !p.terminal) {
            return Err("errors.bulkPendingChoice".into());
        }
        if id.is_empty() {
            return Err("errors.bulkMissingId".into());
        }
        let raw = json!({
            "schemaVersion":1, "id":id,"attemptId":attempt, "type":intent.operation,
            "accountId":intent.scope.account_id, "mailbox":intent.scope.mailbox,
            "intent":intent, "totalUids":intent.target_keys(), "completedUids":[],
            "currentPhase":intent.operation.initial_phase(), "status":"starting",
            "skipped":intent.skipped(), "skippedLocal":intent.skipped_local(),
            "createdAt":chrono::Utc::now().to_rfc3339()
        });
        let record = Pending::parse(raw.clone())?;
        op_journal::pending_operation_save(data_dir, &raw)
            .map_err(|_| "errors.bulkPendingWrite".to_string())?;
        let snapshot = record.snapshot("starting");
        self.pending = Ok(Some(Arc::new(record)));
        self.active = Some(Active {
            id: id.into(),
            attempt_id: attempt.into(),
            intent,
            snapshot: snapshot.clone(),
            cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        self.running_admission(id, attempt, attempt);
        Ok(snapshot)
    }
    /// Live provider counts are presentation only, never completion proof.
    pub fn progress(&mut self, id: &str, completed: usize, errors: usize) -> Option<Value> {
        let active = self.active.as_mut().filter(|a| a.id == id)?;
        active.snapshot["completed"] = json!(completed);
        active.snapshot["errors"] = json!(errors);
        Some(active.snapshot.clone())
    }
    pub fn active_id(&self) -> Option<&str> {
        self.active.as_ref().map(|a| a.id.as_str())
    }
    pub fn cancel_token(
        &self,
        id: &str,
    ) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, String> {
        self.active
            .as_ref()
            .filter(|a| a.id == id)
            .map(|a| a.cancel.clone())
            .ok_or_else(|| "errors.bulkStale".into())
    }
    pub fn resume_worker(
        &mut self,
        data_dir: &Path,
        id: &str,
    ) -> Result<crate::bulk_worker::Workflow, String> {
        self.resume_worker_attempt(data_dir, id, id)
    }
    pub fn resume_worker_attempt(
        &mut self,
        data_dir: &Path,
        id: &str,
        attempt: &str,
    ) -> Result<crate::bulk_worker::Workflow, String> {
        self.require_unfenced(id, attempt)?;
        self.refresh(data_dir)?;
        if self.active.is_some() {
            return Err("errors.operationRunning".into());
        }
        let pending = self.matching(id)?;
        let work: crate::bulk_worker::Workflow =
            serde_json::from_value(pending.raw["worker"].clone())
                .map_err(|_| "errors.bulkIdentityUncertain".to_string())?;
        let intent: FrozenIntent = serde_json::from_value(pending.raw["intent"].clone())
            .map_err(|_| "errors.bulkPendingInvalid".to_string())?;
        let valid = work.valid_for(&intent);
        if !valid {
            return Err("errors.bulkPendingInvalid".into());
        }
        if intent.operation == Action::DeleteEverywhere {
            return Err("errors.bulkUnsupported".into());
        }
        let mut raw = pending.raw.clone();
        raw["attemptId"] = json!(attempt);
        raw["status"] = json!("starting");
        op_journal::pending_operation_save(data_dir, &raw)
            .map_err(|_| "errors.bulkPendingWrite".to_string())?;
        let pending = Pending::parse(raw)?;
        let snapshot = pending.snapshot("starting");
        self.pending = Ok(Some(Arc::new(pending)));
        self.active = Some(Active {
            id: id.into(),
            attempt_id: attempt.into(),
            intent,
            snapshot,
            cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        self.running_admission(id, attempt, attempt);
        Ok(work)
    }
    /// O(1) immutable reference to this exact attempt and committed revision.
    /// Preparing it grants no authority; validate again under the journal
    /// fence before persistence, and retain that fence through publication.
    pub fn checkpoint_seed(&self, id: &str, attempt: &str) -> Result<CheckpointSeed, String> {
        if !self
            .active
            .as_ref()
            .is_some_and(|active| active.id == id && active.attempt_id == attempt)
        {
            return Err("errors.bulkStale".into());
        }
        let pending = self
            .pending
            .as_ref()
            .map_err(Clone::clone)?
            .as_ref()
            .ok_or("errors.bulkStale")?;
        Ok(CheckpointSeed {
            base: pending.clone(),
            id: id.into(),
            attempt: attempt.into(),
        })
    }
    pub fn validate_checkpoint(&self, prepared: &PreparedCheckpoint) -> Result<(), String> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.id == prepared.id && active.attempt_id == prepared.attempt)
            && self
                .pending
                .as_ref()
                .ok()
                .and_then(Option::as_ref)
                .is_some_and(|pending| Arc::ptr_eq(pending, &prepared.base))
        {
            Ok(())
        } else {
            Err("errors.bulkStale".into())
        }
    }
    /// Caller retains the journal fence from validation through this publish.
    /// Borrow the prepared owner so its retired large base drops outside locks.
    pub fn publish_checkpoint(&mut self, prepared: &PreparedCheckpoint) -> Result<Value, String> {
        self.validate_checkpoint(prepared)?;
        self.pending = Ok(Some(prepared.pending.clone()));
        self.active.as_mut().unwrap().snapshot = prepared.snapshot.clone();
        Ok(prepared.snapshot.clone())
    }
    /// Synchronous compatibility seam for callers already owning this value.
    /// Daemon workers use seed/prepare/validate/persist/publish off bulk locks.
    pub fn checkpoint(
        &mut self,
        data_dir: &Path,
        id: &str,
        work: &crate::bulk_worker::Workflow,
    ) -> Result<Value, String> {
        let attempt = self
            .active
            .as_ref()
            .filter(|active| active.id == id)
            .ok_or("errors.bulkStale")?
            .attempt_id
            .clone();
        let prepared = self.checkpoint_seed(id, &attempt)?.prepare(work)?;
        self.validate_checkpoint(&prepared)?;
        prepared.persist(data_dir)?;
        self.publish_checkpoint(&prepared)
    }
    /// Called only after all provider and blocking work has returned.
    pub fn drained(&mut self, id: &str) -> Result<Value, String> {
        let attempt = self
            .active
            .as_ref()
            .filter(|active| active.id == id)
            .ok_or("errors.bulkStale")?
            .attempt_id
            .clone();
        self.drained_attempt(id, &attempt)
    }
    pub fn drained_attempt(&mut self, id: &str, attempt: &str) -> Result<Value, String> {
        if !self
            .active
            .as_ref()
            .is_some_and(|active| active.id == id && active.attempt_id == attempt)
        {
            return Err("errors.bulkStale".into());
        }
        let active = self.active.take().unwrap();
        for admission in self.admissions.values_mut() {
            if admission.operation_id == id && admission.owner_attempt.as_deref() == Some(attempt) {
                admission.state = AdmissionState::Done;
            }
        }
        Ok(active.snapshot)
    }
    /// Admission evidence is in-memory only. A fence prevents even a request
    /// dispatched after this status call from claiming the same attempt.
    pub fn begin_admission(&mut self, id: &str, attempt: &str) -> Result<Option<Value>, String> {
        if let Some(admission) = self.admissions.get(attempt) {
            if admission.operation_id != id
                || matches!(
                    admission.state,
                    AdmissionState::Fenced | AdmissionState::Rejected | AdmissionState::Done
                )
            {
                return Err("errors.bulkStale".into());
            }
            return self
                .active
                .as_ref()
                .filter(|active| active.id == id)
                .map(|active| Some(active.snapshot.clone()))
                .ok_or_else(|| "errors.operationRunning".into());
        }
        self.admissions.insert(
            attempt.into(),
            Admission {
                operation_id: id.into(),
                state: AdmissionState::Freezing,
                owner_attempt: None,
            },
        );
        Ok(None)
    }
    fn require_unfenced(&self, id: &str, attempt: &str) -> Result<(), String> {
        if self.admissions.get(attempt).is_some_and(|admission| {
            admission.operation_id != id || admission.state == AdmissionState::Fenced
        }) {
            return Err("errors.bulkStale".into());
        }
        Ok(())
    }
    fn running_admission(&mut self, id: &str, attempt: &str, owner: &str) {
        self.admissions.insert(
            attempt.into(),
            Admission {
                operation_id: id.into(),
                state: AdmissionState::Running,
                owner_attempt: Some(owner.into()),
            },
        );
    }
    pub fn finish_admission(&mut self, id: &str, attempt: &str, result: &Result<Value, String>) {
        if let Some(admission) = self.admissions.get_mut(attempt).filter(|admission| {
            admission.operation_id == id && admission.state == AdmissionState::Freezing
        }) {
            admission.state = if result.is_err() {
                AdmissionState::Rejected
            } else {
                AdmissionState::Done
            };
        }
    }
    pub fn fence_admission(&mut self, id: &str, attempt: &str) -> Result<(), String> {
        self.require_unfenced(id, attempt).or_else(|error| {
            if self.admissions.get(attempt).is_some_and(|admission| {
                admission.operation_id == id && admission.state == AdmissionState::Fenced
            }) {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        let admission = self.admissions.entry(attempt.into()).or_insert(Admission {
            operation_id: id.into(),
            state: AdmissionState::Fenced,
            owner_attempt: None,
        });
        if admission.state == AdmissionState::Freezing {
            admission.state = AdmissionState::Fenced;
        }
        Ok(())
    }
    pub fn admission_receipt(&self, id: &str, attempt: &str) -> Value {
        self.admissions.get(attempt).filter(|admission|admission.operation_id==id).map(|admission|json!({"operationId":id,"attemptId":attempt,"state":match admission.state{AdmissionState::Freezing=>"freezing",AdmissionState::Running=>"running",AdmissionState::Done=>"done",AdmissionState::Fenced=>"fenced",AdmissionState::Rejected=>"rejected"},"ownerAttemptId":admission.owner_attempt})).unwrap_or(Value::Null)
    }
    pub fn resume_plan(&mut self, data_dir: &Path, id: &str) -> Result<ResumePlan, String> {
        self.refresh(data_dir)?;
        if self.active.is_some() {
            return Err("errors.operationRunning".into());
        }
        let pending = self.matching(id)?;
        let keys = pending.remaining();
        let mut scope = if pending.raw.get("schemaVersion").is_some() {
            serde_json::from_value::<FrozenIntent>(pending.raw["intent"].clone())
                .map_err(|_| "errors.bulkPendingInvalid".to_string())?
                .scope
        } else {
            Scope {
                account_id: pending.raw["accountId"].as_str().map(str::to_owned),
                mailbox: pending.raw["mailbox"].as_str().map(str::to_owned),
                spans: false,
                keys: Vec::new(),
            }
        };
        scope.keys = keys.clone();
        Ok(ResumePlan {
            operation: pending.operation,
            scope,
            keys,
            requires_fresh_identity: true,
        })
    }
    fn matching(&self, id: &str) -> Result<&Pending, String> {
        self.pending()
            .filter(|p| p.id == id && !p.terminal)
            .ok_or_else(|| "errors.bulkStale".into())
    }
    pub fn discard(&mut self, data_dir: &Path, id: &str) -> Result<(), String> {
        self.refresh(data_dir)?;
        if self.active.is_some() {
            return Err("errors.operationRunning".into());
        }
        self.matching(id)?;
        op_journal::pending_operation_clear(data_dir)
            .map_err(|_| "errors.bulkPendingWrite".to_string())?;
        self.pending = Ok(None);
        Ok(())
    }
    /// Compatibility writes may still update unversioned records, but cannot
    /// bypass the new owner or erase unreadable/future-version evidence.
    pub fn allow_legacy_write(&self, data_dir: &Path) -> Result<(), String> {
        if self.active.is_some() {
            return Err("errors.bulkOwned".into());
        }
        let raw = op_journal::pending_operation_read(data_dir)
            .map_err(|_| "errors.bulkPendingRead".to_string())?;
        if self.active.is_some()
            || raw
                .as_ref()
                .is_some_and(|v| v.get("schemaVersion").is_some())
        {
            return Err("errors.bulkOwned".into());
        }
        Ok(())
    }
}
