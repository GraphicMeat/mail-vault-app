//! The Graph (Outlook) implementation of `ServerOps`.
//!
//! - The daemon cannot refresh an OAuth token, so the access token is a lease
//!   the app pushes into memory (`TokenLease` behind a `LeaseStore`). It is
//!   checked before every request, never written to disk, never in a `Debug`
//!   line and scrubbed out of every error text.
//! - Every request is bounded by a timeout (`GraphClient` has none of its own).
//! - Errors go through `throttle::classify_graph` (`OpsError::from_graph`).
//! - Graph has no UIDs. Listing rows carry `uid: 0` and the Graph id; the plan
//!   freeze gives them ledger uids. `GraphOps` keeps a (folder, uid) -> Graph id
//!   map so the uid-only calls (`present`, `expunge_exact`) can find a message.
//!   Fetch and move fill it as they go, but that is NOT enough: a message
//!   archived before this run is never fetched again, and after a restart
//!   nothing was fetched at all. The caller MUST seed it with `remember_plan`
//!   for every folder plan before every `run` (fresh start, resume, recovery).
//! - Moving a message to Deleted Items gives it a NEW id. The move answer carries
//!   `graph_new_ids` but no Trash uids; emptying goes through `find_in_trash`
//!   (by Message-ID), which hands out synthetic Trash uids from the top of the
//!   u32 range, so they can never collide with a ledger uid. That path needs
//!   nothing remembered across a restart.

use super::ops::{Caps, FolderInfo, Fetched, ListPage, ListedMsg, MoveResult, OpsError, ServerOps};
use super::plan::FolderPlan;
use super::state::{FolderRole, Provider};
use crate::graph::GraphClient;
use crate::net_activity::Tracked;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// A lease is unusable this long before it expires, so a request never leaves
/// with a token that dies in flight.
pub const LEASE_MARGIN_MS: i64 = 60_000;
/// The bound on one Graph request.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// The slowest link a message download is expected to survive.
const FLOOR_BYTES_PER_SEC: u64 = 32 * 1024;
/// Extra time for a download whose size Graph did not report.
const UNKNOWN_SIZE_EXTRA: Duration = Duration::from_secs(300);
/// First synthetic Trash uid; they count down from here.
const SYNTHETIC_TOP: u32 = u32::MAX;

/// A Graph access token and when it expires. Memory only.
#[derive(Clone)]
pub struct TokenLease {
    pub token: String,
    pub expires_at_ms: i64,
}

impl fmt::Debug for TokenLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenLease")
            .field("token", &"<redacted>")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// Where the current lease lives. The daemon backs it with its `abd.set_token`
/// map; `Mutex<Option<TokenLease>>` is the simple in-process store.
pub trait LeaseStore: Send + Sync {
    fn current(&self) -> Option<TokenLease>;
    /// The server refused the token (401): forget it, so nothing reuses it.
    fn drop_lease(&self);
}

impl LeaseStore for Mutex<Option<TokenLease>> {
    fn current(&self) -> Option<TokenLease> {
        self.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    fn drop_lease(&self) {
        *self.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct GraphOps {
    email: String,
    leases: Arc<dyn LeaseStore>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    timeout: Duration,
    http: Tracked,
    folders: Option<Vec<FolderInfo>>,
    /// folder path -> uid -> Graph message id.
    ids: HashMap<String, HashMap<u32, String>>,
    /// (folder path, Graph id) -> the synthetic uid already handed out for it.
    synthetic: HashMap<(String, String), u32>,
    next_synthetic: u32,
    counted: u64,
}

impl GraphOps {
    pub fn new(email: &str, leases: Arc<dyn LeaseStore>) -> GraphOps {
        GraphOps {
            email: email.to_string(),
            leases,
            clock: Arc::new(system_now_ms),
            timeout: CALL_TIMEOUT,
            // The same label and account scope the Graph backup uses.
            http: GraphClient::for_purpose("", "backup").for_account(email).client,
            folders: None,
            ids: HashMap::new(),
            synthetic: HashMap::new(),
            next_synthetic: SYNTHETIC_TOP,
            counted: 0,
        }
    }

    /// A shorter (test) bound on one request.
    pub fn with_timeout(mut self, timeout: Duration) -> GraphOps {
        self.timeout = timeout;
        self
    }

    /// A pinned clock for the lease expiry check.
    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> GraphOps {
        self.clock = clock;
        self
    }

    /// The account this instance talks for.
    pub fn email(&self) -> &str {
        &self.email
    }

    /// Teach the uid -> Graph id map from a frozen plan (`uids` zipped with
    /// `graph_ids`, under `plan.path`). Required before every run: `present`
    /// and `expunge_exact` only get uids, and an unknown uid is assumed still
    /// on the server (present) or skipped (expunge), i.e. kept.
    pub fn remember_plan(&mut self, plan: &FolderPlan) {
        if let Some(ids) = &plan.graph_ids {
            self.remember(&plan.path, plan.uids.iter().copied().zip(ids.iter().cloned()));
        }
    }

    /// Teach the uid -> Graph id map a batch of (uid, Graph id) pairs.
    pub fn remember(&mut self, folder_path: &str, entries: impl IntoIterator<Item = (u32, String)>) {
        self.ids.entry(folder_path.to_string()).or_default().extend(entries);
    }

    fn id_of(&self, folder_path: &str, uid: u32) -> Option<String> {
        self.ids.get(folder_path).and_then(|m| m.get(&uid)).cloned()
    }

    fn synthetic_uid(&mut self, folder_path: &str, graph_id: &str) -> u32 {
        let key = (folder_path.to_string(), graph_id.to_string());
        if let Some(u) = self.synthetic.get(&key) {
            return *u;
        }
        let uid = self.next_synthetic;
        self.next_synthetic = self.next_synthetic.saturating_sub(1);
        self.synthetic.insert(key, uid);
        self.ids.entry(folder_path.to_string()).or_default().insert(uid, graph_id.to_string());
        uid
    }

    /// One bounded Graph call under the current lease.
    async fn run<T, F, Fut>(&mut self, op: &str, f: F) -> Result<T, OpsError>
    where
        F: FnOnce(GraphClient) -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let bound = self.timeout;
        self.run_for(op, bound, f).await
    }

    async fn run_for<T, F, Fut>(&mut self, op: &str, bound: Duration, f: F) -> Result<T, OpsError>
    where
        F: FnOnce(GraphClient) -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let lease = match self.leases.current() {
            Some(l) if l.expires_at_ms - LEASE_MARGIN_MS >= (self.clock)() => l,
            _ => return Err(OpsError::SignIn("the Graph access token is missing or about to expire".to_string())),
        };
        let client = GraphClient { client: self.http.clone(), access_token: lease.token.clone() };
        match tokio::time::timeout(bound, f(client)).await {
            Err(_) => Err(OpsError::from_graph(&format!(
                "Graph {} timed out after {}s",
                op,
                bound.as_secs().max(1)
            ))),
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => {
                let err = OpsError::from_graph(&scrub(&e, &lease.token));
                if matches!(err, OpsError::SignIn(_)) {
                    self.leases.drop_lease();
                }
                Err(err)
            }
        }
    }

    fn graph_id_of(folder: &FolderInfo) -> Result<String, OpsError> {
        folder
            .graph_id
            .clone()
            .ok_or_else(|| OpsError::Other(format!("folder {} has no Graph id", folder.path)))
    }
}

static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
static JWT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"eyJ[A-Za-z0-9._-]{10,}").unwrap());

/// An error text made safe to keep and show: the token (and anything shaped
/// like one) removed, then every address masked by the log redaction.
fn scrub(text: &str, token: &str) -> String {
    let mut s = text.to_string();
    if !token.is_empty() {
        s = s.replace(token, "<token>");
    }
    let s = BEARER.replace_all(&s, "Bearer <token>").into_owned();
    let s = JWT.replace_all(&s, "<token>").into_owned();
    crate::log_redact::redact(&s, b"abd-graph-ops")
}

/// Equal after dropping the angle brackets. Case matters: this gates an
/// irreversible delete, and both sides come from Graph's own `internetMessageId`.
fn same_message_id(a: &str, b: &str) -> bool {
    crate::maildir::normalize_message_id(a) == crate::maildir::normalize_message_id(b)
}

impl ServerOps for GraphOps {
    fn provider(&self) -> Provider {
        Provider::Graph
    }

    async fn caps(&mut self) -> Result<Caps, OpsError> {
        // Graph moves and deletes exact messages by id, so both delete gates
        // are open. There is no Gmail extension.
        Ok(Caps { uidplus: true, move_cmd: true, gmail_ext: false })
    }

    async fn folders(&mut self) -> Result<Vec<FolderInfo>, OpsError> {
        let listed = self.run("list_folders", |c| async move { c.list_folders().await }).await?;
        let infos: Vec<FolderInfo> = listed
            .into_iter()
            .map(|f| FolderInfo {
                role: match f.well_known_name.as_deref() {
                    Some("deleteditems") => FolderRole::Trash,
                    Some("junkemail") => FolderRole::Spam,
                    _ => FolderRole::Normal,
                },
                path: f.storage_key,
                name: f.display_name,
                graph_id: Some(f.id),
                selectable: true,
            })
            .collect();
        self.folders = Some(infos.clone());
        Ok(infos)
    }

    async fn trash(&mut self) -> Result<Option<FolderInfo>, OpsError> {
        let folders = match &self.folders {
            Some(f) => f.clone(),
            None => self.folders().await?,
        };
        Ok(folders.into_iter().find(|f| f.role == FolderRole::Trash))
    }

    async fn list_page(&mut self, folder: &FolderInfo, cursor: Option<String>) -> Result<ListPage, OpsError> {
        let fid = Self::graph_id_of(folder)?;
        let (rows, next) =
            self.run("list_page", |c| async move { c.list_page(&fid, cursor.as_deref()).await }).await?;
        let items = rows
            .into_iter()
            .map(|r| ListedMsg {
                // The ledger gives the uid at plan freeze.
                uid: 0,
                internal_ms: r.received_ms,
                // 0 = Graph did not say (PR_MESSAGE_SIZE is unverified).
                size: r.size.unwrap_or(0),
                graph_id: Some(r.id),
                message_id: r.internet_message_id,
                ..Default::default()
            })
            .collect();
        Ok(ListPage { uid_validity: None, items, next })
    }

    async fn message_ids(&mut self, _folder: &FolderInfo, uids: &[u32]) -> Result<Vec<(u32, Option<String>)>, OpsError> {
        // The listing already carries every Message-ID; the engine never asks.
        Ok(uids.iter().map(|u| (*u, None)).collect())
    }

    async fn uid_validity(&mut self, _folder: &FolderInfo) -> Result<Option<u32>, OpsError> {
        Ok(None)
    }

    async fn fetch(&mut self, folder: &FolderInfo, msg: &ListedMsg) -> Result<Fetched, OpsError> {
        let gid = msg
            .graph_id
            .clone()
            .ok_or_else(|| OpsError::Other("the message has no Graph id".to_string()))?;
        self.ids.entry(folder.path.clone()).or_default().insert(msg.uid, gid.clone());
        // A body download is bounded by the request bound PLUS the time its size
        // needs at a floor rate: a flat bound would time out a big message on a
        // slow link every time, and the engine retries a timeout forever.
        let extra = if msg.size == 0 {
            UNKNOWN_SIZE_EXTRA
        } else {
            Duration::from_secs(msg.size as u64 / FLOOR_BYTES_PER_SEC)
        };
        let bound = self.timeout + extra;
        let raw = self.run_for("get_mime_content", bound, |c| async move { c.get_mime_content(&gid).await }).await?;
        self.counted += raw.len() as u64;
        Ok(Fetched {
            raw,
            // "archived" is added by the store; Graph's MIME carries no flags.
            flags: Vec::new(),
            internal_ms: Some(msg.internal_ms),
            message_id: msg.message_id.clone(),
        })
    }

    async fn present(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<u32>, OpsError> {
        let mut out = Vec::new();
        for &uid in uids {
            match self.id_of(&folder.path, uid) {
                Some(gid) => {
                    if self.run("message_exists", |c| async move { c.message_exists(&gid).await }).await? {
                        out.push(uid);
                    }
                }
                // Unknown to this instance: assume it is still there, the
                // engine's own conservative rule (a repeat move fails harmlessly).
                None => out.push(uid),
            }
        }
        Ok(out)
    }

    async fn move_to_trash(
        &mut self,
        folder: &FolderInfo,
        msgs: &[ListedMsg],
        trash: &FolderInfo,
        // Graph has no UIDVALIDITY: its ids are the message's own.
        _validity: Option<u32>,
    ) -> Result<MoveResult, OpsError> {
        let dest = trash.graph_id.clone().unwrap_or_else(|| "deleteditems".to_string());
        let mut moved = Vec::new();
        let mut new_ids = Vec::new();
        for m in msgs {
            let Some(gid) = m.graph_id.clone() else { continue };
            self.ids.entry(folder.path.clone()).or_default().insert(m.uid, gid.clone());
            let d = dest.clone();
            match self.run("move_message", |c| async move { c.move_message(&gid, &d).await }).await {
                Ok(new_id) => {
                    moved.push(m.uid);
                    new_ids.push((m.uid, new_id));
                }
                // Gone or moved by someone else: not moved by us, so it stays.
                Err(OpsError::Gone) => {}
                // A throttle or a lost token: the engine's recovery asks
                // `present` which of the batch is already gone.
                Err(e) => return Err(e),
            }
        }
        Ok(MoveResult { moved, trash_uids: None, trash_validity: None, graph_new_ids: Some(new_ids) })
    }

    async fn expunge_exact(
        &mut self,
        trash: &FolderInfo,
        trash_uids: &[u32],
        expect: &[(u32, String)],
        _validity: Option<u32>,
    ) -> Result<Vec<u32>, OpsError> {
        let mut done = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        for &tu in trash_uids {
            if !seen.insert(tu) {
                continue;
            }
            let Some(want) = expect.iter().find(|e| e.0 == tu).map(|e| e.1.clone()) else { continue };
            let Some(gid) = self.id_of(&trash.path, tu) else { continue };
            // Re-read the Message-ID right before deleting: only the message we
            // meant goes. A 404 here means it is already gone.
            let g = gid.clone();
            match self.run("message_internet_id", |c| async move { c.message_internet_id(&g).await }).await {
                Err(OpsError::Gone) => {
                    done.push(tu);
                    continue;
                }
                // A refusal that a retry cannot fix (403, 405): stop here and
                // report what is already deleted, so it is not counted as kept.
                Err(OpsError::Other(_)) => return Ok(done),
                Err(e) => return Err(e),
                Ok(Some(got)) if same_message_id(&got, &want) => {}
                Ok(_) => continue,
            }
            match self.run("permanent_delete", |c| async move { c.permanent_delete(&gid).await }).await {
                Ok(()) | Err(OpsError::Gone) => done.push(tu),
                Err(OpsError::Other(_)) => return Ok(done),
                // A throttle propagates: the caller repeats the whole list and the
                // ones already deleted answer 404 above, which counts as done.
                Err(e) => return Err(e),
            }
        }
        Ok(done)
    }

    async fn find_in_trash(&mut self, trash: &FolderInfo, message_ids: &[String]) -> Result<Vec<(String, u32)>, OpsError> {
        let fid = Self::graph_id_of(trash)?;
        let mut out = Vec::new();
        for id in message_ids {
            // The engine passes bare ids; Graph stores them bracketed.
            let stored = format!("<{}>", crate::maildir::normalize_message_id(id));
            let f = fid.clone();
            let mut hits = self
                .run("find_by_internet_message_id", |c| async move { c.find_by_internet_message_id(&f, &stored).await })
                .await?;
            if hits.is_empty() {
                // Zero hits reads as "already emptied", so make sure it is not
                // just the other spelling: try the bare form once.
                let f = fid.clone();
                let bare = crate::maildir::normalize_message_id(id);
                hits = self
                    .run("find_by_internet_message_id", |c| async move { c.find_by_internet_message_id(&f, &bare).await })
                    .await?;
            }
            for gid in hits {
                let uid = self.synthetic_uid(&trash.path, &gid);
                out.push((id.clone(), uid));
            }
        }
        Ok(out)
    }

    async fn release(&mut self) {}

    fn uncounted_bytes(&mut self) -> u64 {
        std::mem::take(&mut self.counted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_the_token_bearer_headers_jwts_and_addresses() {
        let token = "tok-SECRET-abc123XYZ";
        let e = format!(
            "Graph x failed (401) {{\"m\":\"Bearer {token} eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def for user@outlook.test\"}} raw {token}"
        );
        let s = scrub(&e, token);
        assert!(!s.contains(token), "{s}");
        assert!(!s.contains("eyJhbGci"), "{s}");
        assert!(!s.contains("user@outlook.test"), "{s}");
        assert!(s.contains("(401)"), "the status must survive: {s}");
    }

    #[test]
    fn a_message_id_matches_with_or_without_brackets_and_only_in_the_same_case() {
        assert!(same_message_id("<a@x>", "a@x"));
        assert!(!same_message_id("<A@x>", "a@x"));
        assert!(!same_message_id("<a@x>", "<b@x>"));
    }
}
