//! Frozen user bulk intent and its single app.db pending record.
//!
//! This module performs no mail IO. A pending record is evidence, never
//! permission to replay a destructive phase. Callers serialize mutations with
//! the daemon journal mutex; the existing op_journal accessors own storage.
use crate::op_journal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::collections::{HashMap, HashSet};

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
            return Some((account.into(), mailbox.into(), numeric_uid(&raw[last + 1..])?));
        }
    }
    if scope.spans {
        return None;
    }
    let account = scope.account_id.as_ref().filter(|a| !a.is_empty())?;
    let mailbox = scope.mailbox.as_ref().filter(|m| !m.is_empty() && m.as_str() != "UNIFIED")?;
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
    let mut grouped = Grouped { groups: Vec::new(), refused: Vec::new() };
    let mut groups_by_mailbox = HashMap::new();
    let mut seen = HashSet::new();
    for key in &scope.keys {
        let Some((account_id, mailbox, uid)) = target(key, scope) else {
            grouped.refused.push(key.clone());
            continue;
        };
        let index = *groups_by_mailbox.entry((account_id.clone(), mailbox.clone())).or_insert_with(|| {
            let index = grouped.groups.len();
            grouped.groups.push(Group { account_id, mailbox, uids: Vec::new() });
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
        let mut intent = Self { operation, scope, groups: Vec::new(), refused: Vec::new(), skipped_local: 0 };
        // Purge needs provider/provenance resolution, rather than IMAP-only
        // grouping. Preserve every exact key until that separate proof step.
        if operation == Action::DeleteEverywhere {
            return intent;
        }
        let grouped = group_targets(&intent.scope);
        intent.refused = grouped.refused;
        for group in grouped.groups {
            if !accounts.contains(&group.account_id) {
                intent.refused.extend(group.uids.iter().map(|uid| group.key(*uid)));
            } else if local.iter().any(|m| m.account_id == group.account_id && m.mailbox == group.mailbox) {
                intent.skipped_local += group.uids.len();
            } else {
                intent.groups.push(group);
            }
        }
        intent
    }
    pub fn target_keys(&self) -> Vec<Value> {
        if self.operation == Action::DeleteEverywhere {
            self.scope.keys.clone()
        } else {
            self.groups.iter().flat_map(|g| g.uids.iter().map(|uid| g.key(*uid))).collect()
        }
    }
    pub fn skipped(&self) -> usize { self.refused.len() }
    pub fn skipped_local(&self) -> usize { self.skipped_local }
}

#[derive(Clone)]
struct Pending {
    raw: Value,
    id: String,
    operation: Action,
    keys: Vec<Value>,
    completed: Vec<Value>,
    terminal: bool,
}
impl Pending {
    fn parse(raw: Value) -> Result<Self, String> {
        let invalid = || "errors.bulkPendingInvalid".to_string();
        let id = raw["id"].as_str().filter(|s| !s.is_empty()).ok_or_else(invalid)?.to_owned();
        let operation: Action = serde_json::from_value(raw["type"].clone()).map_err(|_| invalid())?;
        let keys = raw["totalUids"].as_array().ok_or_else(invalid)?.clone();
        let completed = raw["completedUids"].as_array().ok_or_else(invalid)?.clone();
        let status = raw["status"].as_str().ok_or_else(invalid)?;
        let terminal = matches!(status, "complete" | "cancelled");
        if let Some(version) = raw.get("schemaVersion") {
            if version.as_u64() != Some(1) {
                return Err("errors.bulkPendingVersion".into());
            }
            let intent: FrozenIntent = serde_json::from_value(raw["intent"].clone()).map_err(|_| invalid())?;
            if intent.operation != operation || intent.target_keys() != keys {
                return Err(invalid());
            }
        }
        Ok(Self { raw, id, operation, keys, completed, terminal })
    }
    fn remaining(&self) -> Vec<Value> {
        let completed: HashSet<_> = self.completed.iter().collect();
        self.keys.iter().filter(|key| !completed.contains(key)).cloned().collect()
    }
    fn snapshot(&self, status: &str) -> Value {
        let remaining = self.remaining().len();
        json!({
            "id":self.id, "type":self.operation, "status":status,
            "currentPhase":self.raw.get("currentPhase").cloned().unwrap_or_else(|| json!(self.operation.initial_phase())),
            "total":self.keys.len(), "completed":self.keys.len() - remaining,
            "remaining":remaining, "errors":self.raw.get("errors").cloned().unwrap_or(json!(0)),
            "skipped":self.raw.get("skipped").cloned().unwrap_or(json!(0)),
            "skippedLocal":self.raw.get("skippedLocal").cloned().unwrap_or(json!(0)),
            "result":self.raw.get("result").cloned().unwrap_or(Value::Null),
            "lastError":self.raw.get("lastError").cloned().unwrap_or(Value::Null)
        })
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
    intent: FrozenIntent,
    snapshot: Value,
}

pub struct Coordinator {
    active: Option<Active>,
    pending: Result<Option<Pending>, String>,
}
impl Coordinator {
    /// Startup only reads app.db; it never launches a worker or touches mail.
    pub fn load(data_dir: &Path) -> Self {
        Self { active: None, pending: Self::read(data_dir) }
    }
    fn read(data_dir: &Path) -> Result<Option<Pending>, String> {
        op_journal::pending_operation_read(data_dir).map_err(|_| "errors.bulkPendingRead".to_string())?.map(Pending::parse).transpose()
    }
    fn refresh(&mut self, data_dir: &Path) -> Result<(), String> {
        // The old facade still writes legacy records during migration. Disk
        // remains authoritative; this decoded view is not another journal.
        self.pending = Self::read(data_dir);
        self.pending.as_ref().map(|_| ()).map_err(Clone::clone)
    }
    fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref().ok().and_then(Option::as_ref)
    }
    pub fn status(&mut self, data_dir: &Path) -> Result<Value, String> {
        self.refresh(data_dir)?;
        let active = self.active.as_ref().map(|a| a.snapshot.clone());
        let pending = if active.is_some() { None } else {
            self.pending().filter(|p| !p.terminal).map(|p| p.snapshot("awaitingResume"))
        };
        Ok(json!({"active":active, "pending":pending}))
    }
    /// Internal worker kickoff seam. No RPC may call this until its worker
    /// exists. The intent reaches durable storage before ownership is returned.
    pub fn claim(&mut self, data_dir: &Path, id: &str, intent: FrozenIntent) -> Result<Value, String> {
        self.refresh(data_dir)?;
        if let Some(active) = &self.active {
            return if active.id == id && active.intent == intent {
                Ok(active.snapshot.clone())
            } else { Err("errors.operationRunning".into()) };
        }
        if self.pending().is_some_and(|p| !p.terminal) {
            return Err("errors.bulkPendingChoice".into());
        }
        if id.is_empty() { return Err("errors.bulkMissingId".into()); }
        let raw = json!({
            "schemaVersion":1, "id":id, "type":intent.operation,
            "accountId":intent.scope.account_id, "mailbox":intent.scope.mailbox,
            "intent":intent, "totalUids":intent.target_keys(), "completedUids":[],
            "currentPhase":intent.operation.initial_phase(), "status":"starting",
            "skipped":intent.skipped(), "skippedLocal":intent.skipped_local(),
            "createdAt":chrono::Utc::now().to_rfc3339()
        });
        let record = Pending::parse(raw.clone())?;
        op_journal::pending_operation_save(data_dir, &raw).map_err(|_| "errors.bulkPendingWrite".to_string())?;
        let snapshot = record.snapshot("starting");
        self.pending = Ok(Some(record));
        self.active = Some(Active { id:id.into(), intent, snapshot:snapshot.clone() });
        Ok(snapshot)
    }
    pub fn resume_plan(&mut self, data_dir: &Path, id: &str) -> Result<ResumePlan, String> {
        self.refresh(data_dir)?;
        if self.active.is_some() { return Err("errors.operationRunning".into()); }
        let pending = self.matching(id)?;
        let keys = pending.remaining();
        let mut scope = if pending.raw.get("schemaVersion").is_some() {
            serde_json::from_value::<FrozenIntent>(pending.raw["intent"].clone()).map_err(|_| "errors.bulkPendingInvalid".to_string())?.scope
        } else {
            Scope { account_id:pending.raw["accountId"].as_str().map(str::to_owned), mailbox:pending.raw["mailbox"].as_str().map(str::to_owned), spans:false, keys:Vec::new() }
        };
        scope.keys = keys.clone();
        Ok(ResumePlan { operation:pending.operation, scope, keys, requires_fresh_identity:true })
    }
    fn matching(&self, id: &str) -> Result<&Pending, String> {
        self.pending().filter(|p| p.id == id && !p.terminal)
            .ok_or_else(|| "errors.bulkStale".into())
    }
    pub fn discard(&mut self, data_dir: &Path, id: &str) -> Result<(), String> {
        self.refresh(data_dir)?;
        if self.active.is_some() { return Err("errors.operationRunning".into()); }
        self.matching(id)?;
        op_journal::pending_operation_clear(data_dir).map_err(|_| "errors.bulkPendingWrite".to_string())?;
        self.pending = Ok(None);
        Ok(())
    }
    /// Compatibility writes may still update unversioned records, but cannot
    /// bypass the new owner or erase unreadable/future-version evidence.
    pub fn allow_legacy_write(&self, data_dir: &Path) -> Result<(), String> {
        let raw = op_journal::pending_operation_read(data_dir).map_err(|_| "errors.bulkPendingRead".to_string())?;
        if self.active.is_some() || raw.as_ref().is_some_and(|v| v.get("schemaVersion").is_some()) {
            return Err("errors.bulkOwned".into());
        }
        Ok(())
    }
}
