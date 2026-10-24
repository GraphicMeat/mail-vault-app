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

/// Fingerprint only the provider origin. Refreshing secrets keeps this stable;
/// changing the address, endpoint, transport or JMAP login invalidates a job.
pub fn origin_hash(config: &crate::imap::ImapConfig) -> String {
    use sha2::{Digest, Sha256};
    let origin = serde_json::json!([
        config.email,
        config.host.to_ascii_lowercase(),
        config.effective_port(),
        config.secure,
        config.security,
        config.oauth2_transport,
        config
            .jmap_session_url
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .map(|mut value| {
                let _ = value.set_username("");
                let _ = value.set_password(None);
                value.set_fragment(None);
                value.to_string()
            }),
        config.jmap_username,
        config.jmap_auth
    ]);
    format!("{:x}", Sha256::digest(origin.to_string().as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum Identity {
    Imap {
        validity: u32,
        #[serde(deserialize_with = "uid_map")]
        message_ids: HashMap<u32, String>,
    },
    Jmap {
        mailbox_id: String,
        #[serde(deserialize_with = "uid_map")]
        ids: HashMap<u32, String>,
    },
    Graph {
        #[serde(deserialize_with = "uid_map")]
        ids: HashMap<u32, String>,
    },
}
fn uid_map<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<u32, String>, D::Error> {
    let values = HashMap::<String, String>::deserialize(deserializer)?;
    values
        .into_iter()
        .map(|(key, value)| {
            let uid = key.parse::<u32>().map_err(serde::de::Error::custom)?;
            if uid.to_string() != key {
                return Err(serde::de::Error::custom("noncanonical UID key"));
            }
            Ok((uid, value))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProof {
    pub uid: u32,
    pub name: String,
    pub sha256: String,
}
pub fn bytes_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

impl Identity {
    pub fn matches_transport(&self, config: &crate::imap::ImapConfig) -> bool {
        if config.uses_jmap() {
            matches!(self, Self::Jmap { .. })
        } else if config.uses_graph() {
            matches!(self, Self::Graph { .. })
        } else {
            matches!(self, Self::Imap { .. })
        }
    }
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
            (Self::Graph { ids: old }, Self::Graph { ids: new }) => uids
                .iter()
                .all(|u| old.get(u).is_some_and(|id| new.get(u) == Some(id))),
            _ => false,
        }
    }
}
#[derive(Debug, Clone, Default)]
pub struct ArchiveOutcome {
    pub stored: Vec<StoredProof>,
    pub errors: usize,
    pub last_error: Option<String>,
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
/// Native cache/ledger snapshot taken when the request freezes its selection,
/// before a delayed worker can observe a newer cached mailbox generation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selected {
    pub validity: Option<u32>,
    pub cached_uids: Vec<u32>,
    pub message_ids: HashMap<u32, String>,
    pub jmap_ids: HashMap<u32, String>,
    #[serde(default)]
    pub graph_ids: HashMap<u32, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupState {
    pub group: Group,
    #[serde(default)]
    pub selected: Option<Selected>,
    pub identity: Option<Identity>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub stored: Vec<StoredProof>,
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
    #[serde(default)]
    pub errors: usize,
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
                    selected: None,
                    identity: None,
                    origin: None,
                    stored: vec![],
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
            errors: 0,
            intent,
        }
    }
    pub fn valid_for(&self, intent: &FrozenIntent) -> bool {
        self.intent == *intent
            && matches!(
                self.status.as_str(),
                "starting"
                    | "archiving"
                    | "verifying"
                    | "backingUp"
                    | "deleting"
                    | "complete"
                    | "cancelled"
                    | "error"
            )
            && matches!(
                self.phase.as_str(),
                "identify" | "archive" | "verify" | "copy" | "delete"
            )
            && self
                .groups
                .iter()
                .map(|g| &g.group)
                .eq(intent.groups().iter())
            && self.groups.iter().all(|group| {
                let requested: HashSet<_> = group.group.uids.iter().copied().collect();
                let attempted: HashSet<_> = group.attempted.iter().copied().collect();
                let proved: HashSet<_> = group.stored.iter().map(|proof| proof.uid).collect();
                if proved.len() != group.stored.len()
                    || !proved.is_subset(&requested)
                    || group.stored.iter().any(|proof| {
                        proof.sha256.len() != 64
                            || !proof.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                            || proof.name.is_empty()
                            || proof.name.contains(['/', '\\', '\0'])
                    })
                {
                    return false;
                }
                if intent.action() != Action::Delete
                    && !group.verified.iter().all(|uid| proved.contains(uid))
                {
                    return false;
                }

                [
                    &group.verified,
                    &group.eligible,
                    &group.attempted,
                    &group.deleted,
                ]
                .iter()
                .all(|uids| {
                    let set: HashSet<_> = uids.iter().copied().collect();
                    set.len() == uids.len() && set.is_subset(&requested)
                }) && group.deleted.iter().all(|uid| attempted.contains(uid))
            })
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
                let done: HashSet<_> = uids.iter().copied().collect();
                g.group
                    .uids
                    .iter()
                    .filter(move |uid| done.contains(uid))
                    .map(|u| {
                        serde_json::json!(format!(
                            "{}:{}:{}",
                            g.group.account_id, g.group.mailbox, u
                        ))
                    })
            })
            .collect()
    }
}
/// Narrow mail operations, deliberately specific to these four bulk modes.
#[allow(async_fn_in_trait)]
pub trait Ports {
    async fn checkpoint(&mut self, work: &Workflow) -> Result<(), String>;
    async fn identity(&mut self, group: &Group) -> Result<(Identity, String), String>;
    async fn archive(
        &mut self,
        group: &Group,
        cancel: Arc<AtomicBool>,
        identity: &Identity,
    ) -> Result<ArchiveOutcome, String>;
    async fn verify(
        &mut self,
        group: &Group,
        identity: &Identity,
        stored: &[StoredProof],
    ) -> Result<Vec<u32>, String>;
    async fn copy(
        &mut self,
        group: &Group,
        uids: &[u32],
        stored: &[StoredProof],
    ) -> Result<CopyProof, String>;
    async fn delete(
        &mut self,
        group: &Group,
        uids: &[u32],
        identity: &Identity,
        bin: bool,
        cancel: Arc<AtomicBool>,
        stored: &[StoredProof],
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
fn remaining(g: &GroupState, action: Action) -> Group {
    let mut done: HashSet<_> = g.attempted.iter().chain(&g.deleted).copied().collect();
    if action == Action::Archive {
        done.extend(g.verified.iter().copied());
    }
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
    if phase == "copy" || phase == "delete" {
        w.errors = 0;
    }
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
    w.errors = 0;
    for g in &w.groups {
        w.result.removed += g.deleted.len();
        let deleted: HashSet<_> = g.deleted.iter().copied().collect();
        w.result.kept_delete_failed += g.attempted.iter().filter(|u| !deleted.contains(u)).count();
    }
    for group in &mut w.groups {
        group.eligible.clear();
        if action != Action::Archive {
            group.verified.clear();
            group.stored.clear();
        } else {
            group
                .stored
                .retain(|proof| group.verified.contains(&proof.uid));
        }
    }
    phase(p, w, "identify", "starting").await?;
    for i in 0..w.groups.len() {
        if cancelled(p, w, &cancel).await? {
            return Ok(());
        }
        let g = remaining(&w.groups[i], action);
        if g.uids.is_empty() {
            continue;
        }
        if resume && (w.groups[i].identity.is_none() || w.groups[i].origin.is_none()) {
            return Err("errors.bulkIdentityUncertain".into());
        }
        let (identity, origin) = p.identity(&g).await?;
        if w.groups[i]
            .origin
            .as_ref()
            .is_some_and(|old| old != &origin)
        {
            return Err("errors.bulkIdentityChanged".into());
        }
        w.groups[i].origin = Some(origin);
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
        if action != Action::Archive {
            w.groups[i].verified.clear();
        }
        w.groups[i].eligible.clear();
        p.checkpoint(w).await?;
    }
    if action != Action::Delete {
        phase(p, w, "archive", "archiving").await?;
        for i in 0..w.groups.len() {
            if cancelled(p, w, &cancel).await? {
                return Ok(());
            }
            let g = remaining(&w.groups[i], action);
            if g.uids.is_empty() {
                continue;
            }
            let outcome = p
                .archive(
                    &g,
                    cancel.clone(),
                    w.groups[i]
                        .identity
                        .as_ref()
                        .ok_or("errors.bulkIdentityUncertain")?,
                )
                .await?;
            let asked: HashSet<_> = g.uids.iter().copied().collect();
            let mut seen = HashSet::new();
            w.groups[i].stored.extend(
                outcome
                    .stored
                    .into_iter()
                    .filter(|proof| asked.contains(&proof.uid) && seen.insert(proof.uid)),
            );
            w.errors += outcome.errors;
            if outcome.last_error.is_some() {
                w.last_error = outcome.last_error;
            }

            p.checkpoint(w).await?;
        }
        if cancelled(p, w, &cancel).await? {
            return Ok(());
        }
        phase(p, w, "verify", "verifying").await?;
        for i in 0..w.groups.len() {
            let g = remaining(&w.groups[i], action);
            if g.uids.is_empty() {
                continue;
            }
            let stored = &w.groups[i].stored;
            let admitted: HashSet<_> = stored.iter().map(|proof| proof.uid).collect();
            let requested = g.uids.len();
            let mut g = g;
            g.uids.retain(|uid| admitted.contains(uid));
            w.result.kept_not_archived += requested - g.uids.len();
            let proved = if g.uids.is_empty() {
                vec![]
            } else {
                p.verify(
                    &g,
                    w.groups[i]
                        .identity
                        .as_ref()
                        .ok_or("errors.bulkIdentityUncertain")?,
                    stored,
                )
                .await?
            };
            let verified = exact(&g.uids, &proved);
            w.result.kept_not_archived += g.uids.len() - verified.len();
            if action == Action::Archive {
                w.groups[i].verified.extend(verified);
            } else {
                w.groups[i].verified = verified;
            }
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
            let proofs: HashMap<_, _> = w.groups[i]
                .stored
                .iter()
                .map(|proof| (proof.uid, proof.clone()))
                .collect();
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
                let batch_proofs: Vec<_> = batch
                    .iter()
                    .filter_map(|uid| proofs.get(uid).cloned())
                    .collect();
                match p.copy(&w.groups[i].group, batch, &batch_proofs).await {
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
                remaining(g, action).uids
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
        let proofs: HashMap<_, _> = w.groups[i]
            .stored
            .iter()
            .map(|proof| (proof.uid, proof.clone()))
            .collect();
        for batch in uids.chunks(5) {
            if cancelled(p, w, &cancel).await? {
                return Ok(());
            }
            w.groups[i].attempted.extend_from_slice(batch);
            p.checkpoint(w).await?;
            let batch_proofs: Vec<_> = batch
                .iter()
                .filter_map(|uid| proofs.get(uid).cloned())
                .collect();
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
                    &batch_proofs,
                )
                .await?;
            let exact = exact(batch, &deleted);
            w.result.removed += exact.len();
            w.result.kept_delete_failed += batch.len() - exact.len();
            w.errors += batch.len() - exact.len();
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
