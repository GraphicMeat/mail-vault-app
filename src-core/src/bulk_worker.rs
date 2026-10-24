//! The four ordinary user-bulk mail flows. Provider IO stays in daemon ports;
//! this coordinator keeps the original selection and bounded durable outcomes.
use crate::bulk::{Action, FrozenIntent, Group};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum Identity {
    Imap {
        validity: u32,
        message_ids: HashMap<u32, String>,
    },
    Jmap {
        mailbox_id: String,
        ids: HashMap<u32, String>,
    },
    Graph,
}
impl Identity {
    pub fn matches(&self, now: &Self, uids: &[u32]) -> bool {
        match (self, now) {
            (
                Self::Imap {
                    validity: a,
                    message_ids: old,
                },
                Self::Imap {
                    validity: b,
                    message_ids: new,
                },
            ) => {
                a == b
                    && uids
                        .iter()
                        .all(|u| old.get(u).is_none_or(|id| new.get(u) == Some(id)))
            }
            (
                Self::Jmap {
                    mailbox_id: a,
                    ids: old,
                },
                Self::Jmap {
                    mailbox_id: b,
                    ids: new,
                },
            ) => {
                a == b
                    && uids
                        .iter()
                        .all(|u| old.get(u).is_some_and(|id| new.get(u) == Some(id)))
            }
            (Self::Graph, Self::Graph) => true,
            _ => false,
        }
    }
}
#[derive(Debug, Clone, Default)]
pub struct CopyProof {
    pub verified: Vec<u32>,
    pub missing: Vec<u32>,
    pub mismatched: Vec<u32>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultCounts {
    pub removed: usize,
    pub kept_not_archived: usize,
    pub kept_backup_unreachable: usize,
    pub kept_copy_mismatch: usize,
    pub kept_delete_failed: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupState {
    pub group: Group,
    pub identity: Option<Identity>,
    pub verified: Vec<u32>,
    pub eligible: Vec<u32>,
    /// Recorded BEFORE dispatch. An attempted target lacking a durable outcome
    /// is uncertain after a crash and never enters a later delete again.
    pub attempted: Vec<u32>,
    pub deleted: Vec<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub groups: Vec<GroupState>,
    pub phase: String,
    pub status: String,
    pub result: ResultCounts,
    pub last_error: Option<String>,
    pub intent: FrozenIntent,
}
impl Workflow {
    pub fn new(intent: FrozenIntent) -> Self {
        Self {
            groups: intent
                .groups()
                .iter()
                .cloned()
                .map(|group| GroupState {
                    group,
                    identity: None,
                    verified: vec![],
                    eligible: vec![],
                    attempted: vec![],
                    deleted: vec![],
                })
                .collect(),
            phase: "identify".into(),
            status: "starting".into(),
            result: ResultCounts::default(),
            last_error: None,
            intent,
        }
    }
    pub fn completed_keys(&self) -> Vec<serde_json::Value> {
        self.groups
            .iter()
            .flat_map(|g| {
                let uids = if self.intent.action() == Action::Archive {
                    &g.verified
                } else {
                    &g.deleted
                };
                uids.iter().map(|u| {
                    serde_json::json!(format!("{}:{}:{}", g.group.account_id, g.group.mailbox, u))
                })
            })
            .collect()
    }
}
/// Narrow mail operations, deliberately specific to these four bulk modes.
#[allow(async_fn_in_trait)]
pub trait Ports {
    async fn checkpoint(&mut self, work: &Workflow) -> Result<(), String>;
    async fn identity(&mut self, group: &Group) -> Result<Identity, String>;
    async fn archive(&mut self, group: &Group, cancel: Arc<AtomicBool>) -> Result<(), String>;
    async fn verify(&mut self, group: &Group, identity: &Identity) -> Result<Vec<u32>, String>;
    async fn copy(&mut self, group: &Group, uids: &[u32]) -> Result<CopyProof, String>;
    async fn delete(
        &mut self,
        group: &Group,
        uids: &[u32],
        identity: &Identity,
        bin: bool,
        cancel: Arc<AtomicBool>,
    ) -> Result<Vec<u32>, String>;
}
fn exact(asked: &[u32], proof: &[u32]) -> Vec<u32> {
    let proved: HashSet<_> = proof.iter().copied().collect();
    asked
        .iter()
        .copied()
        .filter(|u| proved.contains(u))
        .collect()
}
fn remaining(g: &GroupState) -> Group {
    let done: HashSet<_> = g.attempted.iter().chain(&g.deleted).copied().collect();
    Group {
        uids: g
            .group
            .uids
            .iter()
            .copied()
            .filter(|u| !done.contains(u))
            .collect(),
        ..g.group.clone()
    }
}
async fn phase(
    p: &mut impl Ports,
    w: &mut Workflow,
    phase: &str,
    status: &str,
) -> Result<(), String> {
    w.phase = phase.into();
    w.status = status.into();
    p.checkpoint(w).await
}
async fn cancelled(p: &mut impl Ports, w: &mut Workflow, c: &AtomicBool) -> Result<bool, String> {
    if !c.load(Ordering::SeqCst) {
        return Ok(false);
    }
    w.status = "cancelled".into();
    p.checkpoint(w).await?;
    Ok(true)
}
pub async fn run(
    p: &mut impl Ports,
    w: &mut Workflow,
    cancel: Arc<AtomicBool>,
    resume: bool,
) -> Result<(), String> {
    let action = w.intent.action();
    if action == Action::DeleteEverywhere {
        return Err("errors.bulkUnsupported".into());
    }
    w.result = ResultCounts::default();
    w.last_error = None;
    for g in &w.groups {
        w.result.removed += g.deleted.len();
        w.result.kept_delete_failed += g
            .attempted
            .iter()
            .filter(|u| !g.deleted.contains(u))
            .count();
    }
    phase(p, w, "identify", "starting").await?;
    for i in 0..w.groups.len() {
        if cancelled(p, w, &cancel).await? {
            return Ok(());
        }
        let g = remaining(&w.groups[i]);
        if g.uids.is_empty() {
            continue;
        }
        if resume && action != Action::Archive && w.groups[i].identity.is_none() {
            return Err("errors.bulkIdentityUncertain".into());
        }
        let identity = p.identity(&g).await?;
        if w.groups[i]
            .identity
            .as_ref()
            .is_some_and(|old| !old.matches(&identity, &g.uids))
        {
            return Err("errors.bulkIdentityChanged".into());
        }
        // Keep original evidence on resume, including identities of completed
        // targets, rather than replacing it with a partial current listing.
        if w.groups[i].identity.is_none() {
            w.groups[i].identity = Some(identity)
        }
        w.groups[i].verified.clear();
        w.groups[i].eligible.clear();
        p.checkpoint(w).await?;
    }
    if action != Action::Delete {
        phase(p, w, "archive", "archiving").await?;
        for i in 0..w.groups.len() {
            if cancelled(p, w, &cancel).await? {
                return Ok(());
            }
            let g = remaining(&w.groups[i]);
            if g.uids.is_empty() {
                continue;
            }
            p.archive(&g, cancel.clone()).await?;
            p.checkpoint(w).await?;
        }
        if cancelled(p, w, &cancel).await? {
            return Ok(());
        }
        phase(p, w, "verify", "verifying").await?;
        for i in 0..w.groups.len() {
            let g = remaining(&w.groups[i]);
            if g.uids.is_empty() {
                continue;
            }
            let proved = p
                .verify(
                    &g,
                    w.groups[i]
                        .identity
                        .as_ref()
                        .ok_or("errors.bulkIdentityUncertain")?,
                )
                .await?;
            w.groups[i].verified = exact(&g.uids, &proved);
            w.result.kept_not_archived += g.uids.len() - w.groups[i].verified.len();
            p.checkpoint(w).await?;
            if cancelled(p, w, &cancel).await? {
                return Ok(());
            }
        }
    }
    if action == Action::Archive {
        w.status = "complete".into();
        return p.checkpoint(w).await;
    }
    if action == Action::ArchiveBackupDelete {
        phase(p, w, "copy", "backingUp").await?;
        let mut drive_gone = false;
        for i in 0..w.groups.len() {
            let asked = w.groups[i].verified.clone();
            for batch in asked.chunks(100) {
                if cancelled(p, w, &cancel).await? {
                    return Ok(());
                }
                if drive_gone {
                    w.result.kept_backup_unreachable += batch.len();
                    p.checkpoint(w).await?;
                    continue;
                }
                // Persist the copy intent as a bounded unit before external IO.
                p.checkpoint(w).await?;
                match p.copy(&w.groups[i].group, batch).await {
                    Err(_) => {
                        drive_gone = true;
                        w.result.kept_backup_unreachable += batch.len()
                    }
                    Ok(proof) => {
                        if cancelled(p, w, &cancel).await? {
                            return Ok(());
                        }
                        let proved = exact(batch, &proof.verified);
                        let set: HashSet<_> = proved.iter().copied().collect();
                        for uid in batch.iter().filter(|u| !set.contains(u)) {
                            if proof.mismatched.contains(uid) {
                                w.result.kept_copy_mismatch += 1
                            } else if proof.missing.contains(uid) {
                                w.result.kept_not_archived += 1
                            } else {
                                w.result.kept_backup_unreachable += 1
                            }
                        }
                        w.groups[i].eligible.extend(proved);
                    }
                }
                p.checkpoint(w).await?;
            }
        }
    } else {
        for g in &mut w.groups {
            g.eligible = if action == Action::Delete {
                remaining(g).uids
            } else {
                g.verified.clone()
            };
        }
    }
    if cancelled(p, w, &cancel).await? {
        return Ok(());
    }
    phase(p, w, "delete", "deleting").await?;
    for i in 0..w.groups.len() {
        let uids = w.groups[i].eligible.clone();
        for batch in uids.chunks(5) {
            if cancelled(p, w, &cancel).await? {
                return Ok(());
            }
            w.groups[i].attempted.extend_from_slice(batch);
            p.checkpoint(w).await?;
            let deleted = p
                .delete(
                    &w.groups[i].group,
                    batch,
                    w.groups[i]
                        .identity
                        .as_ref()
                        .ok_or("errors.bulkIdentityUncertain")?,
                    action == Action::Delete,
                    cancel.clone(),
                )
                .await?;
            let exact = exact(batch, &deleted);
            w.result.removed += exact.len();
            w.result.kept_delete_failed += batch.len() - exact.len();
            w.groups[i].deleted.extend(exact);
            p.checkpoint(w).await?;
        }
    }
    if !cancelled(p, w, &cancel).await? {
        w.status = "complete".into();
        p.checkpoint(w).await?
    }
    Ok(())
}
