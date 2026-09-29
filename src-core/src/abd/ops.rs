//! The three seams the engine is generic over.
//!
//! Native `async fn` in traits (no `async-trait`). Engine functions are generic
//! over these traits, never `dyn`, and the daemon runs jobs on a `LocalSet`, so
//! no `Send` bound is needed on the futures.

use super::plan::{AllMailMap, FolderPlan};
use super::state::{FolderRole, JobFile};
use super::throttle::{classify_graph, classify_imap, Signal};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug)]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
    pub role: FolderRole,
    pub graph_id: Option<String>,
    pub selectable: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ListedMsg {
    pub uid: u32,
    pub internal_ms: i64,
    pub size: u32,
    pub gm_msgid: Option<u64>,
    /// Gmail All Mail only: X-GM-LABELS minus \Important and \Starred is empty.
    pub unlabelled: Option<bool>,
    pub graph_id: Option<String>,
    /// Graph lists it; IMAP fills it at plan freeze.
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ListPage {
    pub uid_validity: Option<u32>,
    pub items: Vec<ListedMsg>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Fetched {
    pub raw: Vec<u8>,
    pub flags: Vec<String>,
    pub internal_ms: Option<i64>,
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct MoveResult {
    /// Uids (in the folder the command ran in) that are gone from it.
    pub moved: Vec<u32>,
    /// COPYUID destination, positionally matching `moved` when the lengths agree.
    pub trash_uids: Option<Vec<u32>>,
    pub trash_validity: Option<u32>,
    pub graph_new_ids: Option<Vec<(u32, String)>>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Caps {
    pub uidplus: bool,
    pub move_cmd: bool,
    pub gmail_ext: bool,
}

#[derive(Debug, Clone)]
pub enum OpsError {
    /// Gmail bandwidth / OVERQUOTA.
    ProviderLimit(String),
    /// [THROTTLED], Graph 429, 503, a timeout or a lost connection.
    Throttled { retry_after_secs: Option<u64>, text: String },
    /// [ALERT] Too many simultaneous connections.
    TooManyConnections(String),
    /// Login refused, Graph 401, token missing/expired.
    SignIn(String),
    /// Connect failed, DNS, net gate closed.
    Offline(String),
    /// The uid/id no longer exists on the server.
    Gone,
    Other(String),
}

impl OpsError {
    pub fn text(&self) -> String {
        match self {
            OpsError::ProviderLimit(t) | OpsError::TooManyConnections(t) | OpsError::SignIn(t) => t.clone(),
            OpsError::Offline(t) | OpsError::Other(t) => t.clone(),
            OpsError::Throttled { text, .. } => text.clone(),
            OpsError::Gone => "gone".to_string(),
        }
    }

    fn from_signal(sig: Signal, retry_after_secs: Option<u64>, err: &str) -> OpsError {
        let text = err.to_string();
        match sig {
            Signal::ProviderLimit => OpsError::ProviderLimit(text),
            Signal::Throttled | Signal::Timeout | Signal::ConnectionLost => {
                OpsError::Throttled { retry_after_secs, text }
            }
            Signal::TooManyConnections => OpsError::TooManyConnections(text),
            Signal::SignIn => OpsError::SignIn(text),
            Signal::Gone => OpsError::Gone,
            Signal::Other => OpsError::Other(text),
        }
    }

    /// An IMAP error string as the engine should react to it.
    pub fn from_imap(err: &str) -> OpsError {
        OpsError::from_signal(classify_imap(err), None, err)
    }

    /// A Graph error string, with its `retry_after` if it carried one.
    pub fn from_graph(err: &str) -> OpsError {
        let (sig, retry) = classify_graph(err);
        OpsError::from_signal(sig, retry, err)
    }
}

#[allow(async_fn_in_trait)]
pub trait ServerOps {
    fn provider(&self) -> super::state::Provider;
    async fn caps(&mut self) -> Result<Caps, OpsError>;
    async fn folders(&mut self) -> Result<Vec<FolderInfo>, OpsError>;
    /// Existing Trash only; never CREATEs. `None` = no Trash, deletes refused.
    async fn trash(&mut self) -> Result<Option<FolderInfo>, OpsError>;
    /// A bounded page of the folder's listing. `cursor` None = start.
    async fn list_page(&mut self, folder: &FolderInfo, cursor: Option<String>) -> Result<ListPage, OpsError>;
    /// Message-IDs for up to 500 uids (IMAP: BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]).
    async fn message_ids(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<(u32, Option<String>)>, OpsError>;
    /// The folder's current UIDVALIDITY (Graph: `None`). Added to the contract:
    /// the engine needs it before a fetch pass, before each delete batch and in
    /// recovery (invariant I5).
    async fn uid_validity(&mut self, folder: &FolderInfo) -> Result<Option<u32>, OpsError>;
    async fn fetch(&mut self, folder: &FolderInfo, msg: &ListedMsg) -> Result<Fetched, OpsError>;
    /// Which of `uids` the folder still holds (tag-checked; IMAP UID SEARCH UID set).
    async fn present(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<u32>, OpsError>;
    async fn move_to_trash(
        &mut self,
        folder: &FolderInfo,
        msgs: &[ListedMsg],
        trash: &FolderInfo,
    ) -> Result<MoveResult, OpsError>;
    /// Re-read Message-IDs of `trash_uids`, keep those matching `expect`, then
    /// STORE \Deleted + UID EXPUNGE exactly those. Returns the expunged uids.
    /// Err if the server lacks UIDPLUS. Graph: permanentDelete per id.
    async fn expunge_exact(
        &mut self,
        trash: &FolderInfo,
        trash_uids: &[u32],
        expect: &[(u32, String)],
    ) -> Result<Vec<u32>, OpsError>;
    /// (message id, trash uid) for each id found in Trash.
    async fn find_in_trash(&mut self, trash: &FolderInfo, message_ids: &[String]) -> Result<Vec<(String, u32)>, OpsError>;
    /// Give back the held connection (called before any wait > 30 s).
    async fn release(&mut self);
    /// Bytes this op set moved that the wire counter did NOT see (Graph: body
    /// bytes). Reading it resets it.
    fn uncounted_bytes(&mut self) -> u64;
}

pub struct Verify {
    pub ok: Vec<u32>,
    pub missing: Vec<u32>,
    pub mismatched: Vec<u32>,
}

#[derive(Debug)]
pub enum LocalError {
    VaultUnavailable(String),
    DriveUnavailable(String),
    Io(String),
}

#[allow(async_fn_in_trait)]
pub trait LocalStore {
    /// `maildir::archived_file_map` of the folder's cur/ (one read_dir).
    async fn archived_listing(&self, folder: &str) -> Result<HashMap<u32, PathBuf>, LocalError>;
    /// `archive::store_archived`: vault_files::store with flags store_flags(imap)
    /// (always `archived`), overwrite only a non-archived copy, custody entry.
    async fn store_archived(&self, folder: &str, uid: u32, f: Fetched) -> Result<PathBuf, LocalError>;
    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, LocalError>;
    /// A per-file check against current disk (A flag on the current name and
    /// the Message-ID), using `listing` only to find each uid's path.
    async fn verify_vault(
        &self,
        folder: &str,
        listing: &HashMap<u32, PathBuf>,
        uids: &[u32],
        expected: &HashMap<u32, String>,
    ) -> Result<Verify, LocalError>;
    /// Part B copy_uids_to_mirror (copy absent, verify all by Message-ID),
    /// against a per-pass mirror listing held by the impl.
    /// Err(DriveUnavailable) when the mirror root is missing/unwritable.
    async fn mirror_copy_verify(&self, folder: &str, uids: &[u32]) -> Result<Verify, LocalError>;
    /// The before-delete re-check: open the mirror file for each (uid, vault
    /// file name) and compare Message-IDs. No read_dir unless a name misses.
    async fn mirror_verify_paths(
        &self,
        folder: &str,
        files: &[(u32, String)],
        expected: &HashMap<u32, String>,
    ) -> Result<Verify, LocalError>;
    /// Graph: ledger uids for listed (graph id, internetMessageId), under the gate.
    async fn graph_uids(&self, folder: &str, listed: &[(String, Option<String>)]) -> Result<Vec<u32>, LocalError>;
    /// Called after each confirmed delete batch so the daemon can drop the
    /// deleted uids from the header cache. Added to the contract; default no-op.
    async fn deleted_from_server(&self, _folder: &str, _uids: &[u32]) {}
}

#[allow(async_fn_in_trait)]
pub trait Env {
    fn now_ms(&self) -> i64;
    /// Sleep until `until_ms` (or a wake/cancel); returns early on ctl.wake.
    async fn sleep_until(&self, until_ms: i64, ctl: &Control);
    /// Part A background_allowance (+ Graph job tally subtracted by the engine). None = unlimited.
    fn allowance_left(&self) -> Option<u64>;
    /// Configured daily limit (Part A read_limits/default_limits); None = none.
    fn daily_limit(&self) -> Option<u64>;
    /// Wait until the UI has been quiet 400 ms (max 2 s per call).
    async fn yield_to_foreground(&self);
    fn save(&self, job: &JobFile) -> Result<(), String>;
    /// Persist one frozen plan file. Called before the first `save` that names it.
    fn save_plan(&self, name: &str, plan: &FolderPlan) -> Result<(), String>;
    fn save_allmail(&self, map: &AllMailMap) -> Result<(), String>;
    fn emit(&self, frame: &serde_json::Value);
    /// Is there a usable token/credential right now? (Graph + XOAUTH2 lease check.)
    fn has_credentials(&self) -> bool;
}

/// Cancel and pause flags for one job, and the wake-up both use.
pub struct Control {
    pub cancel: AtomicBool,
    pub pause: AtomicBool,
    pub wake: tokio::sync::Notify,
}

impl Control {
    pub fn new() -> Control {
        Control {
            cancel: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
        }
    }
}

impl Default for Control {
    fn default() -> Self {
        Control::new()
    }
}
