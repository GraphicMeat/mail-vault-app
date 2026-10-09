//! JMAP value types: credentials, errors, the Session object and the results
//! `JmapClient` hands back.

use base64::Engine;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// RFC 8620 core capability.
pub const CORE: &str = "urn:ietf:params:jmap:core";
/// RFC 8621 mail capability.
pub const MAIL: &str = "urn:ietf:params:jmap:mail";
/// RFC 8621 submission capability (Identity, EmailSubmission).
pub const SUBMISSION: &str = "urn:ietf:params:jmap:submission";

/// What every authenticated request carries.
#[derive(Clone, PartialEq)]
pub enum JmapAuth {
    /// Username and app password, sent as HTTP Basic.
    Basic { username: String, password: String },
    /// An API token, sent as `Bearer`.
    Bearer(String),
}

impl JmapAuth {
    /// The `Authorization` header value: "Basic <base64>" or "Bearer <token>".
    pub fn header(&self) -> String {
        match self {
            JmapAuth::Basic { username, password } => {
                let pair = format!("{username}:{password}");
                format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair))
            }
            JmapAuth::Bearer(token) => format!("Bearer {token}"),
        }
    }
}

/// Never prints the secret.
impl std::fmt::Debug for JmapAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JmapAuth::Basic { username, .. } => f.debug_struct("Basic").field("username", username).finish_non_exhaustive(),
            JmapAuth::Bearer(_) => f.write_str("Bearer(..)"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum JmapError {
    /// HTTP 401 or 403 (`errors.jmapAuthFailed`).
    Unauthorized,
    /// HTTP 429 or 503, with `Retry-After` in seconds when the server sent it.
    RateLimited { retry_after: Option<u64> },
    /// `*/changes` cannot bridge the state: rebuild the header cache and the
    /// ledger mapping, never delete vault files.
    CannotCalculateChanges,
    /// A method-level error type ("invalidArguments", a SetError type) or a
    /// request-level problem type ("urn:ietf:params:jmap:error:limit").
    Method { kind: String, description: Option<String> },
    /// A redirect left the host the user saw.
    ForeignHost { host: String },
    /// A malformed session or response, or a URL that may not carry credentials.
    Protocol(String),
    /// DNS, TLS, timeout or connection failure.
    Transport(String),
}

impl JmapError {
    pub fn code(&self) -> &'static str {
        match self {
            JmapError::Unauthorized => "E_JMAP_AUTH",
            JmapError::RateLimited { .. } => "E_JMAP_RATE",
            JmapError::CannotCalculateChanges => "E_JMAP_CHANGES",
            JmapError::Method { .. } => "E_JMAP_METHOD",
            JmapError::ForeignHost { .. } => "E_JMAP_FOREIGN_HOST",
            JmapError::Protocol(_) => "E_JMAP_PROTOCOL",
            JmapError::Transport(_) => "E_JMAP_TRANSPORT",
        }
    }
}

impl std::fmt::Display for JmapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = self.code();
        match self {
            JmapError::Unauthorized => write!(f, "{code}: authentication failed"),
            JmapError::RateLimited { retry_after: Some(s) } => write!(f, "{code}: rate limited, retry after {s}s"),
            JmapError::RateLimited { retry_after: None } => write!(f, "{code}: rate limited"),
            JmapError::CannotCalculateChanges => write!(f, "{code}: cannot calculate changes"),
            JmapError::Method { kind, description: Some(d) } => write!(f, "{code}: {kind}: {d}"),
            JmapError::Method { kind, description: None } => write!(f, "{code}: {kind}"),
            JmapError::ForeignHost { host } => write!(f, "{code}: {host}"),
            JmapError::Protocol(m) | JmapError::Transport(m) => write!(f, "{code}: {m}"),
        }
    }
}

impl std::error::Error for JmapError {}

/// The RFC 8620 §2 Session object, as far as the client reads it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub capabilities: Map<String, Value>,
    #[serde(default)]
    pub primary_accounts: HashMap<String, String>,
    #[serde(default)]
    pub username: String,
    pub api_url: String,
    pub download_url: String,
    pub upload_url: String,
    #[serde(default)]
    pub event_source_url: Option<String>,
    #[serde(default)]
    pub state: String,
}

/// `urn:ietf:params:jmap:core` limits the client honours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreLimits {
    pub max_objects_in_get: usize,
    pub max_objects_in_set: usize,
    pub max_calls_in_request: usize,
    pub max_size_upload: u64,
}

impl Default for CoreLimits {
    fn default() -> Self {
        CoreLimits { max_objects_in_get: 500, max_objects_in_set: 500, max_calls_in_request: 16, max_size_upload: 50_000_000 }
    }
}

impl CoreLimits {
    /// Read from the core capability object, each missing or zero value at its default.
    pub fn from_capability(core: Option<&Value>) -> CoreLimits {
        let d = CoreLimits::default();
        let read = |key: &str| core.and_then(|c| c[key].as_u64()).filter(|n| *n > 0);
        CoreLimits {
            max_objects_in_get: read("maxObjectsInGet").map_or(d.max_objects_in_get, |n| n as usize),
            max_objects_in_set: read("maxObjectsInSet").map_or(d.max_objects_in_set, |n| n as usize),
            max_calls_in_request: read("maxCallsInRequest").map_or(d.max_calls_in_request, |n| n as usize),
            max_size_upload: read("maxSizeUpload").unwrap_or(d.max_size_upload),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct JMailbox {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub role: Option<String>,
    pub total_emails: u32,
    pub unread_emails: u32,
    pub sort_order: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub id: String,
    pub email: String,
    pub name: String,
    pub may_delete: bool,
}

/// `Email/changes` folded over every page from `old_state` to `new_state`.
/// An id created and destroyed inside the window is in none of the lists.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EmailChanges {
    pub old_state: String,
    pub new_state: String,
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub destroyed: Vec<String>,
}

/// `Email/get` over every chunk. `not_found` ids no longer exist: the sync
/// treats them as destroyed. `state` is the first chunk's, so a later
/// `Email/changes` from it replays anything that moved during the fetch.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EmailsGot {
    pub list: Vec<Value>,
    pub not_found: Vec<String>,
    pub state: String,
}

/// An `Email/set` update or destroy: the ids it applied to, and each refused
/// id with its SetError type ("notFound", "invalidProperties", ...).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SetOutcome {
    pub ok: Vec<String>,
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    pub id: String,
    pub blob_id: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImportResult {
    Created(Imported),
    /// The server already holds this message: a dedupe, not a failure.
    AlreadyExists { existing_id: String },
}
