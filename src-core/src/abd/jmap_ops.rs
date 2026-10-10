//! The JMAP implementation of `ServerOps` (RFC 8620 core, RFC 8621 mail).
//!
//! - JMAP has no uids. As for Graph, listing rows carry `uid: 0` and the
//!   email id in `graph_id`, and a folder's `graph_id` is its JMAP mailbox id.
//!   The plan freeze gives the rows their uids through
//!   `LocalStore::graph_uids`, which the daemon runs under its vault gate over
//!   the mailbox's `jmap_id_map.json`: the ledger the bridge and the sync use,
//!   so a uid names the same email everywhere. Ledger rows are never removed.
//! - `JmapOps` keeps a (folder, uid) -> email id map for the uid-only calls
//!   (`present`, `message_ids`, `expunge_exact`). Fetch and move fill it as
//!   they go, but the caller MUST seed it with `remember_plan` for every
//!   folder plan before every `run`, exactly as for `GraphOps`.
//! - Every delete follows the label semantics rule (`jmap::ops::remove_from`).
//!   An email another mailbox also holds only loses this folder's label and
//!   never reaches Trash; `move_to_trash` still reports it moved, since this
//!   folder no longer holds it. An email keeps its id in Trash, but emptying
//!   finds it by Message-ID (`find_in_trash`, synthetic uids from the top of
//!   the u32 range), so nothing has to be remembered across a restart.
//!   `expunge_exact` destroys only an email whose one mailbox is Trash and
//!   takes the Trash label off any other.
//! - No `ifInState` guard on the read-then-set (ruling R9).
//! - The client is this job's own: connected on first use from the account's
//!   config, dropped when that config's credentials change (`set_config`) or
//!   the server answers 401, so the next run signs in afresh. Its requests are
//!   tracked under the "backup" purpose, the label the Graph job uses.

use super::ops::{Caps, FolderInfo, Fetched, ListPage, ListedMsg, MoveResult, OpsError, ServerOps};
use super::plan::FolderPlan;
use super::state::{FolderRole, Provider};
use crate::imap::ImapConfig;
use crate::jmap::headers::keywords_to_flags;
use crate::jmap::mailbox_map::mailbox_tree;
use crate::jmap::{remove_from, JmapClient, JmapError, RemoveOutcome};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Email ids per `list_page`.
pub const PAGE: usize = 500;
/// First synthetic Trash uid; they count down from here.
const SYNTHETIC_TOP: u32 = u32::MAX;
/// At most this many Trash hits are looked at per Message-ID.
const FIND_LIMIT: usize = 50;

pub struct JmapOps {
    cfg: ImapConfig,
    client: Option<Arc<JmapClient>>,
    page: usize,
    folders: Option<Vec<FolderInfo>>,
    /// folder path -> uid -> JMAP email id.
    ids: HashMap<String, HashMap<u32, String>>,
    /// folder path -> email ids the listing under way has already returned.
    listed: HashMap<String, HashSet<String>>,
    /// (folder path, email id) -> the synthetic uid already handed out for it.
    synthetic: HashMap<(String, String), u32>,
    next_synthetic: u32,
    counted: u64,
}

impl JmapOps {
    /// Ops for the JMAP account `cfg` (`uses_jmap()`). Nothing is sent until
    /// the first call.
    pub fn new(cfg: ImapConfig) -> JmapOps {
        JmapOps {
            cfg,
            client: None,
            page: PAGE,
            folders: None,
            ids: HashMap::new(),
            listed: HashMap::new(),
            synthetic: HashMap::new(),
            next_synthetic: SYNTHETIC_TOP,
            counted: 0,
        }
    }

    /// A smaller (test) listing page.
    pub fn with_page_size(mut self, n: usize) -> JmapOps {
        self.page = n.max(1);
        self
    }

    /// The account this instance talks for.
    pub fn email(&self) -> &str {
        &self.cfg.email
    }

    /// The account's config for the next requests (the keychain's latest,
    /// before every run). A changed address, session URL or credential drops
    /// the connected client.
    pub fn set_config(&mut self, cfg: ImapConfig) {
        let same = cfg.email == self.cfg.email
            && cfg.jmap_session_url == self.cfg.jmap_session_url
            && cfg.jmap_auth() == self.cfg.jmap_auth();
        if !same {
            self.client = None;
        }
        self.cfg = cfg;
    }

    /// Teach the uid -> email id map from a frozen plan (`uids` zipped with
    /// `graph_ids`, under `plan.path`). Required before every run: `present`
    /// and `expunge_exact` only get uids, and an unknown uid is assumed still
    /// on the server (present) or skipped (expunge), i.e. kept.
    pub fn remember_plan(&mut self, plan: &FolderPlan) {
        if let Some(ids) = &plan.graph_ids {
            self.remember(&plan.path, plan.uids.iter().copied().zip(ids.iter().cloned()));
        }
    }

    /// Teach the uid -> email id map a batch of (uid, email id) pairs.
    pub fn remember(&mut self, folder_path: &str, entries: impl IntoIterator<Item = (u32, String)>) {
        self.ids.entry(folder_path.to_string()).or_default().extend(entries);
    }

    fn id_of(&self, folder_path: &str, uid: u32) -> Option<String> {
        self.ids.get(folder_path).and_then(|m| m.get(&uid)).cloned()
    }

    fn synthetic_uid(&mut self, folder_path: &str, email_id: &str) -> u32 {
        let key = (folder_path.to_string(), email_id.to_string());
        if let Some(u) = self.synthetic.get(&key) {
            return *u;
        }
        let uid = self.next_synthetic;
        self.next_synthetic = self.next_synthetic.saturating_sub(1);
        self.synthetic.insert(key, uid);
        self.ids.entry(folder_path.to_string()).or_default().insert(uid, email_id.to_string());
        uid
    }

    /// The connected client, connecting first if there is none. An account
    /// with no usable credentials is a sign-in before any request leaves.
    async fn client(&mut self) -> Result<Arc<JmapClient>, OpsError> {
        if let Some(c) = &self.client {
            return Ok(Arc::clone(c));
        }
        let auth = self.cfg.jmap_auth().ok_or_else(|| OpsError::from_jmap(&JmapError::Unauthorized))?;
        let url = self.cfg.jmap_session_url.clone().unwrap_or_default();
        let email = self.cfg.email.clone();
        let connected =
            crate::net_activity::with_purpose("backup", JmapClient::connect(url.trim(), auth, &email)).await;
        let c = Arc::new(connected.map_err(|e| self.fail(e))?);
        self.client = Some(Arc::clone(&c));
        Ok(c)
    }

    /// The engine's reading of `e`. A 401 also drops the client.
    fn fail(&mut self, e: JmapError) -> OpsError {
        if e == JmapError::Unauthorized {
            self.client = None;
        }
        OpsError::from_jmap(&e)
    }

    fn mailbox_id(folder: &FolderInfo) -> Result<String, OpsError> {
        folder
            .graph_id
            .clone()
            .ok_or_else(|| OpsError::Other(format!("folder {} has no JMAP mailbox id", folder.path)))
    }
}

/// The first Message-ID JMAP parsed from the header (no angle brackets).
fn first_message_id(email: &Value) -> Option<String> {
    email["messageId"].as_array()?.first()?.as_str().map(str::to_string)
}

/// Equal after dropping the angle brackets. Case matters: this gates an
/// irreversible delete.
fn same_message_id(a: &str, b: &str) -> bool {
    crate::maildir::normalize_message_id(a) == crate::maildir::normalize_message_id(b)
}

fn in_mailbox(email: &Value, mailbox_id: &str) -> bool {
    email["mailboxIds"][mailbox_id].as_bool() == Some(true)
}

/// `Email/query` `{inMailbox, header: ["Message-ID", id]}`: the ids whose
/// Message-ID header contains `message_id` (RFC 8621 lets the server match a
/// substring; the caller keeps the exact ones).
async fn query_by_message_id(c: &JmapClient, mailbox_id: &str, message_id: &str) -> Result<Vec<String>, JmapError> {
    let args = json!({
        "accountId": c.account_id(),
        "filter": {"inMailbox": mailbox_id, "header": ["Message-ID", message_id]},
        "limit": FIND_LIMIT,
    });
    let answer = c.call(vec![json!(["Email/query", args, "q"])]).await?;
    let r = answer
        .iter()
        .find(|r| r[0] == "Email/query")
        .ok_or_else(|| JmapError::Protocol("no Email/query response".into()))?;
    Ok(r[1]["ids"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default())
}

impl ServerOps for JmapOps {
    fn provider(&self) -> Provider {
        Provider::Jmap
    }

    async fn caps(&mut self) -> Result<Caps, OpsError> {
        // JMAP moves and destroys exact emails by id, so both delete gates
        // are open. There is no Gmail extension.
        Ok(Caps { uidplus: true, move_cmd: true, gmail_ext: false })
    }

    async fn folders(&mut self) -> Result<Vec<FolderInfo>, OpsError> {
        let c = self.client().await?;
        let (list, _) = c.mailboxes().await.map_err(|e| self.fail(e))?;
        let (infos, ids) = mailbox_tree(&list);
        let role_of: HashMap<&str, String> =
            list.iter().filter_map(|m| m.role.as_deref().map(|r| (m.id.as_str(), r.to_ascii_lowercase()))).collect();
        let folders: Vec<FolderInfo> = infos
            .into_iter()
            .filter_map(|info| {
                let id = ids.get(&info.path)?.clone();
                let role = match role_of.get(id.as_str()).map(String::as_str) {
                    Some("trash") => FolderRole::Trash,
                    Some("junk") => FolderRole::Spam,
                    Some("all") => FolderRole::AllMail,
                    _ => FolderRole::Normal,
                };
                Some(FolderInfo { path: info.path, name: info.name, role, graph_id: Some(id), selectable: true })
            })
            .collect();
        self.folders = Some(folders.clone());
        Ok(folders)
    }

    async fn trash(&mut self) -> Result<Option<FolderInfo>, OpsError> {
        let folders = match &self.folders {
            Some(f) => f.clone(),
            None => self.folders().await?,
        };
        Ok(folders.into_iter().find(|f| f.role == FolderRole::Trash))
    }

    /// One page of `Email/query` (newest first) from the position `cursor`
    /// names. An email an earlier page of this listing already returned is
    /// left out: an arrival between pages shifts the window, and one id
    /// listed twice would fail the plan freeze. One that leaves between pages
    /// can be missed, which only means it is not archived or deleted.
    async fn list_page(&mut self, folder: &FolderInfo, cursor: Option<String>) -> Result<ListPage, OpsError> {
        let mid = Self::mailbox_id(folder)?;
        let position = match cursor.as_deref() {
            None => {
                self.listed.remove(&folder.path);
                0
            }
            Some(c) => c.parse::<usize>().map_err(|_| OpsError::Other(format!("bad JMAP listing cursor {c}")))?,
        };
        let c = self.client().await?;
        let (ids, total) = c.query_mailbox(&mid, position, self.page).await.map_err(|e| self.fail(e))?;
        let reached = position + ids.len();
        let next = match total {
            _ if ids.is_empty() => None,
            Some(t) if reached >= t => None,
            None if ids.len() < self.page => None,
            _ => Some(reached.to_string()),
        };
        let seen = self.listed.entry(folder.path.clone()).or_default();
        let fresh: Vec<String> = ids.into_iter().filter(|id| seen.insert(id.clone())).collect();
        if fresh.is_empty() {
            return Ok(ListPage { uid_validity: None, items: Vec::new(), next });
        }
        let got = c
            .get_emails(&fresh, &["id", "receivedAt", "size", "messageId"])
            .await
            .map_err(|e| self.fail(e))?;
        let mut by_id: HashMap<String, Value> =
            got.list.into_iter().filter_map(|e| Some((e["id"].as_str()?.to_string(), e))).collect();
        let mut items = Vec::with_capacity(fresh.len());
        for id in fresh {
            // Destroyed between the query and the get: nothing to archive.
            let Some(e) = by_id.remove(&id) else { continue };
            // No usable receivedAt: left out, never filed under 1970 (Graph's rule).
            let Some(internal_ms) = e["receivedAt"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|d| d.timestamp_millis())
            else {
                continue;
            };
            items.push(ListedMsg {
                // The ledger gives the uid at plan freeze.
                uid: 0,
                internal_ms,
                size: e["size"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32,
                message_id: first_message_id(&e),
                graph_id: Some(id),
                ..Default::default()
            });
        }
        Ok(ListPage { uid_validity: None, items, next })
    }

    async fn message_ids(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<(u32, Option<String>)>, OpsError> {
        // A uid with no known id, or an id the server no longer has, is left
        // unanswered (never "has no Message-ID").
        let known: Vec<(u32, String)> =
            uids.iter().filter_map(|u| self.id_of(&folder.path, *u).map(|id| (*u, id))).collect();
        if known.is_empty() {
            return Ok(Vec::new());
        }
        let c = self.client().await?;
        let ids: Vec<String> = known.iter().map(|(_, id)| id.clone()).collect();
        let got = c.get_emails(&ids, &["id", "messageId"]).await.map_err(|e| self.fail(e))?;
        let by_id: HashMap<&str, Option<String>> =
            got.list.iter().filter_map(|e| Some((e["id"].as_str()?, first_message_id(e)))).collect();
        Ok(known.into_iter().filter_map(|(u, id)| by_id.get(id.as_str()).map(|m| (u, m.clone()))).collect())
    }

    async fn uid_validity(&mut self, _folder: &FolderInfo) -> Result<Option<u32>, OpsError> {
        Ok(None)
    }

    async fn fetch(&mut self, folder: &FolderInfo, msg: &ListedMsg) -> Result<Fetched, OpsError> {
        let id = msg
            .graph_id
            .clone()
            .or_else(|| self.id_of(&folder.path, msg.uid))
            .ok_or_else(|| OpsError::Other("the message has no JMAP id".to_string()))?;
        self.ids.entry(folder.path.clone()).or_default().insert(msg.uid, id.clone());
        let mid = Self::mailbox_id(folder)?;
        let c = self.client().await?;
        let got = c
            .get_emails(&[id.clone()], &["id", "blobId", "keywords", "mailboxIds"])
            .await
            .map_err(|e| self.fail(e))?;
        // Gone from the server, or no longer in this folder: kept, not fetched.
        let Some(email) = got.list.into_iter().find(|e| e["id"].as_str() == Some(id.as_str())) else {
            return Err(OpsError::Gone);
        };
        if !in_mailbox(&email, &mid) {
            return Err(OpsError::Gone);
        }
        let blob = email["blobId"]
            .as_str()
            .ok_or_else(|| OpsError::Other("Email/get without blobId".to_string()))?
            .to_string();
        let raw = c.download(&blob).await.map_err(|e| self.fail(e))?;
        self.counted += raw.len() as u64;
        Ok(Fetched {
            raw,
            // The server's keywords as IMAP flags; "archived" is added by the store.
            flags: keywords_to_flags(&email["keywords"]),
            internal_ms: Some(msg.internal_ms),
            message_id: msg.message_id.clone(),
        })
    }

    async fn present(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<u32>, OpsError> {
        let mid = Self::mailbox_id(folder)?;
        let known: Vec<String> = uids.iter().filter_map(|u| self.id_of(&folder.path, *u)).collect();
        let mut here: HashSet<String> = HashSet::new();
        if !known.is_empty() {
            let c = self.client().await?;
            let got = c.get_emails(&known, &["id", "mailboxIds"]).await.map_err(|e| self.fail(e))?;
            here = got
                .list
                .iter()
                .filter(|e| in_mailbox(e, &mid))
                .filter_map(|e| e["id"].as_str().map(str::to_string))
                .collect();
        }
        Ok(uids
            .iter()
            .copied()
            .filter(|u| match self.id_of(&folder.path, *u) {
                Some(id) => here.contains(&id),
                // Unknown to this instance: assume it is still there, the
                // engine's own conservative rule (a repeat move does nothing).
                None => true,
            })
            .collect())
    }

    async fn move_to_trash(
        &mut self,
        folder: &FolderInfo,
        msgs: &[ListedMsg],
        trash: &FolderInfo,
        // JMAP has no UIDVALIDITY: its ids are the email's own.
        _validity: Option<u32>,
    ) -> Result<MoveResult, OpsError> {
        let mid = Self::mailbox_id(folder)?;
        let tid = Self::mailbox_id(trash)?;
        let c = self.client().await?;
        let mut moved = Vec::new();
        let mut in_trash = Vec::new();
        for m in msgs {
            let Some(id) = m.graph_id.clone().or_else(|| self.id_of(&folder.path, m.uid)) else { continue };
            self.ids.entry(folder.path.clone()).or_default().insert(m.uid, id.clone());
            match remove_from(&c, &id, &mid, Some(&tid), false).await {
                // Out of this folder: another mailbox still holds it.
                Ok(RemoveOutcome::LabelRemoved) => moved.push(m.uid),
                // A plain delete (`permanent` false) never destroys. If it ever
                // reported one, the invariant is broken: stop, and let the
                // engine keep the message instead of trusting the report.
                Ok(RemoveOutcome::Destroyed) => {
                    debug_assert!(false, "move_to_trash must never destroy");
                    return Err(OpsError::Other("move_to_trash must never destroy an email".to_string()));
                }
                // In Trash alone now, under the same id.
                Ok(RemoveOutcome::MovedToTrash) => {
                    moved.push(m.uid);
                    in_trash.push((m.uid, id));
                }
                // Gone, or out of this folder already: not moved by us, so it stays.
                Ok(RemoveOutcome::Gone) => {}
                // A throttle or a sign-in: the engine's recovery asks
                // `present` which of the batch is already out.
                Err(e) => return Err(self.fail(e)),
            }
        }
        Ok(MoveResult { moved, trash_uids: None, trash_validity: None, graph_new_ids: Some(in_trash) })
    }

    async fn expunge_exact(
        &mut self,
        trash: &FolderInfo,
        trash_uids: &[u32],
        expect: &[(u32, String)],
        _validity: Option<u32>,
    ) -> Result<Vec<u32>, OpsError> {
        let tid = Self::mailbox_id(trash)?;
        let mut wanted: Vec<(u32, String, String)> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        for &tu in trash_uids {
            if !seen.insert(tu) {
                continue;
            }
            let Some(want) = expect.iter().find(|e| e.0 == tu).map(|e| e.1.clone()) else { continue };
            let Some(id) = self.id_of(&trash.path, tu) else { continue };
            wanted.push((tu, id, want));
        }
        let mut done = Vec::new();
        if wanted.is_empty() {
            return Ok(done);
        }
        let c = self.client().await?;
        // Re-read the Message-IDs right before deleting: only the email we
        // meant goes.
        let ids: Vec<String> = wanted.iter().map(|w| w.1.clone()).collect();
        let got = c.get_emails(&ids, &["id", "messageId", "mailboxIds"]).await.map_err(|e| self.fail(e))?;
        let by_id: HashMap<String, Value> =
            got.list.into_iter().filter_map(|e| Some((e["id"].as_str()?.to_string(), e))).collect();
        for (tu, id, want) in wanted {
            let Some(email) = by_id.get(&id) else {
                // Already gone from the server.
                done.push(tu);
                continue;
            };
            if !in_mailbox(email, &tid) {
                // Already out of Trash: nothing left to empty.
                done.push(tu);
                continue;
            }
            match first_message_id(email) {
                Some(got) if same_message_id(&got, &want) => {}
                _ => continue,
            }
            // Destroyed when Trash is its only mailbox; otherwise only the
            // Trash label comes off and the email lives on where it is.
            match remove_from(&c, &id, &tid, Some(&tid), true).await {
                Ok(_) => done.push(tu),
                Err(e) => match self.fail(e) {
                    // A refusal a retry cannot fix: stop here and report what
                    // is already deleted, so it is not counted as kept.
                    OpsError::Other(_) => return Ok(done),
                    // A throttle propagates: the caller repeats the list, and
                    // the ones already deleted answer as gone above.
                    other => return Err(other),
                },
            }
        }
        Ok(done)
    }

    async fn find_in_trash(&mut self, trash: &FolderInfo, message_ids: &[String]) -> Result<Vec<(String, u32)>, OpsError> {
        let tid = Self::mailbox_id(trash)?;
        let c = self.client().await?;
        // JMAP keeps an email's id through a move, so what is ours in Trash is
        // an id this job listed (`remember_plan` seeds them, so a restart
        // keeps them). A label-only removal reports its message moved, but it
        // never reached Trash: an unrelated email in Trash with the same
        // Message-ID is not ours and is neither found nor destroyed.
        let ours: HashSet<String> = self.ids.values().flat_map(|m| m.values().cloned()).collect();
        let mut out = Vec::new();
        for asked in message_ids {
            let bare = crate::maildir::normalize_message_id(asked);
            if bare.is_empty() {
                continue;
            }
            let hits = query_by_message_id(&c, &tid, &bare).await.map_err(|e| self.fail(e))?;
            if hits.is_empty() {
                continue;
            }
            // The header filter may match a substring: keep exact Message-IDs
            // only, so a lookalike never makes the real copy look ambiguous.
            let got = c.get_emails(&hits, &["id", "messageId"]).await.map_err(|e| self.fail(e))?;
            for e in &got.list {
                let (Some(id), Some(m)) = (e["id"].as_str(), first_message_id(e)) else { continue };
                if same_message_id(&m, &bare) && ours.contains(id) {
                    let uid = self.synthetic_uid(&trash.path, id);
                    out.push((asked.clone(), uid));
                }
            }
        }
        Ok(out)
    }

    async fn release(&mut self) {}

    fn uncounted_bytes(&mut self) -> u64 {
        std::mem::take(&mut self.counted)
    }
}
