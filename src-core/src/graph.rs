use base64::Engine;
use crate::net_activity::{http_client, http_client_with, Tracked};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::imap::{EmailAddress, EmailHeader};

// ---------------------------------------------------------------------------
// Domain detection
// ---------------------------------------------------------------------------

/// Personal Microsoft domains that should use Graph API instead of IMAP.
/// These accounts are affected by a Microsoft server-side IMAP OAuth regression
/// (since Dec 2024) that causes "User is authenticated but not connected" errors.
const PERSONAL_MS_DOMAINS: &[&str] = &[
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "outlook.co.uk",
    "hotmail.co.uk",
    "live.co.uk",
    "outlook.fr",
    "hotmail.fr",
    "live.fr",
    "outlook.de",
    "hotmail.de",
    "live.de",
    "outlook.jp",
    "hotmail.co.jp",
    "live.jp",
];

pub fn is_personal_microsoft(email: &str) -> bool {
    email
        .split('@')
        .nth(1)
        .map(|domain| {
            PERSONAL_MS_DOMAINS
                .iter()
                .any(|d| domain.eq_ignore_ascii_case(d))
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Graph API data structures (serde deserialization from Graph JSON)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMailFolder {
    pub id: String,
    pub display_name: String,
    pub total_item_count: i64,
    pub unread_item_count: i64,
    #[serde(default)]
    pub child_folder_count: i64,
    /// Graph's own name for a default folder ("inbox", "sentitems", "drafts",
    /// "deleteditems", "junkemail", "archive"); None for a user folder. Filled
    /// by `list_folders` from a `$batch` of well-known lookups. Graph v1.0's
    /// listing has no such property, and `displayName` follows the MAILBOX's
    /// language ("Gesendete Elemente"), so it cannot be the key.
    #[serde(default)]
    pub well_known_name: Option<String>,
    /// The locale-independent name every store keys this folder by: the vault
    /// directory, the sidecar dir with its uid ledger, the local index, the
    /// mirror. Computed here, never read from Graph. When the well-known
    /// lookup fails the whole listing fails, so this is never a display name
    /// standing in for a key the lookup could not resolve.
    #[serde(default, skip_deserializing)]
    pub storage_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMessage {
    pub id: String,
    pub subject: Option<String>,
    pub from: Option<GraphEmailAddress>,
    pub to_recipients: Option<Vec<GraphEmailAddress>>,
    pub cc_recipients: Option<Vec<GraphEmailAddress>>,
    pub bcc_recipients: Option<Vec<GraphEmailAddress>>,
    pub received_date_time: Option<String>,
    pub sent_date_time: Option<String>,
    pub is_read: Option<bool>,
    pub has_attachments: Option<bool>,
    pub internet_message_id: Option<String>,
    pub body: Option<GraphBody>,
    pub internet_message_headers: Option<Vec<GraphHeader>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEmailAddress {
    pub email_address: GraphEmail,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphEmail {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBody {
    pub content_type: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct GraphListResponse<T> {
    pub value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    pub next_link: Option<String>,
}

// ---------------------------------------------------------------------------
// GraphMessage → EmailHeader conversion
// ---------------------------------------------------------------------------

impl GraphMessage {
    /// Convert a Graph API message into the app's standard `EmailHeader`.
    /// `uid` is a synthetic UID assigned by the caller (Graph messages use
    /// opaque string IDs, so callers map them to sequential u32 UIDs).
    pub fn to_email_header(&self, uid: u32) -> EmailHeader {
        let from = self
            .from
            .as_ref()
            .map(|f| EmailAddress {
                name: f.email_address.name.clone(),
                address: f
                    .email_address
                    .address
                    .clone()
                    .unwrap_or_default(),
            })
            .unwrap_or_default();

        let to: Vec<EmailAddress> = self
            .to_recipients
            .as_ref()
            .map(|list| {
                list.iter()
                    .map(|r| EmailAddress {
                        name: r.email_address.name.clone(),
                        address: r.email_address.address.clone().unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let cc: Vec<EmailAddress> = self
            .cc_recipients
            .as_ref()
            .map(|list| {
                list.iter()
                    .map(|r| EmailAddress {
                        name: r.email_address.name.clone(),
                        address: r.email_address.address.clone().unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut flags = Vec::new();
        if self.is_read == Some(true) {
            flags.push("\\Seen".to_string());
        }

        // Extract threading headers from internetMessageHeaders
        let in_reply_to = self.get_header("In-Reply-To");
        let references = self.get_header("References").map(|refs_str| {
            refs_str
                .split_whitespace()
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        });

        EmailHeader {
            uid,
            seq: uid,
            display_index: None,
            message_id: self.internet_message_id.clone(),
            in_reply_to,
            references,
            subject: self.subject.clone().unwrap_or_default(),
            from,
            to,
            cc,
            bcc: self.bcc_recipients.as_ref().map(|list| list.iter().map(|r| EmailAddress {
                name: r.email_address.name.clone(), address: r.email_address.address.clone().unwrap_or_default(),
            }).collect()).unwrap_or_default(),
            message_date: self.get_header("Date"),
            received_at: self.received_date_time.clone(),
            sent_at: self.sent_date_time.clone(),
            date: self.received_date_time.clone(),
            internal_date: self.received_date_time.clone(),
            flags,
            size: None,
            has_attachments: self.has_attachments.unwrap_or(false),
            source: Some("graph".to_string()),
            reply_to: None,
            return_path: None,
            authentication_results: self.get_header("Authentication-Results"),
            list_unsubscribe: self.get_header("List-Unsubscribe"),
            list_unsubscribe_post: self.get_header("List-Unsubscribe-Post"),
            list_id: self.get_header("List-Id"),
            precedence: self.get_header("Precedence"),
        }
    }

    /// Look up a header by name from `internetMessageHeaders`.
    fn get_header(&self, name: &str) -> Option<String> {
        self.internet_message_headers.as_ref().and_then(|headers| {
            headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value.clone())
        })
    }
}

// ---------------------------------------------------------------------------
// Scope listing rows (abd)
// ---------------------------------------------------------------------------

/// One row of `GraphClient::list_page`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphListed {
    pub id: String,
    /// `receivedDateTime`, UTC milliseconds.
    pub received_ms: i64,
    /// As Graph stores it, angle brackets included.
    pub internet_message_id: Option<String>,
    /// `PR_MESSAGE_SIZE`; `None` when the property did not come back.
    pub size: Option<u32>,
}

/// The MAPI property `PR_MESSAGE_SIZE` (Integer 0x0E08), read as an extended
/// property because `message` has no size field.
const SIZE_PROPERTY_ID: &str = "Integer 0x0E08";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawListed {
    id: String,
    received_date_time: Option<String>,
    internet_message_id: Option<String>,
    single_value_extended_properties: Option<Vec<RawProperty>>,
}

#[derive(Deserialize)]
struct RawProperty {
    id: String,
    value: Option<serde_json::Value>,
}

impl RawListed {
    fn into_listed(self) -> Option<GraphListed> {
        let received_ms = chrono::DateTime::parse_from_rfc3339(self.received_date_time.as_deref()?)
            .ok()?
            .timestamp_millis();
        let size = self
            .single_value_extended_properties
            .unwrap_or_default()
            .iter()
            .find(|p| is_size_property(&p.id))
            .and_then(|p| match p.value.as_ref()? {
                serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
                serde_json::Value::Number(n) => n.as_u64(),
                _ => None,
            })
            .and_then(|n| u32::try_from(n).ok());
        Some(GraphListed { id: self.id, received_ms, internet_message_id: self.internet_message_id, size })
    }
}

/// Graph may echo the property id as `Integer 0xe08`; only the hex matters.
fn is_size_property(id: &str) -> bool {
    let id = id.to_ascii_lowercase().replace(' ', "");
    id == "integer0x0e08" || id == "integer0xe08"
}

/// RFC 3986 percent-encoding of one URL component (unreserved characters pass).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Is `link` under the Graph base (so it is safe to send the token to it)?
fn is_graph_link(link: &str) -> bool {
    link.strip_prefix(graph_base()).is_some_and(|rest| rest.starts_with('/') || rest.starts_with('?'))
}

// ---------------------------------------------------------------------------
// Graph API client
// ---------------------------------------------------------------------------

const GRAPH_BASE_DEFAULT: &str = "https://graph.microsoft.com/v1.0";

/// Where every Graph request goes: Microsoft, unless an e2e run points the
/// client at a mock on this machine with `MAILVAULT_GRAPH_BASE`. The override is
/// honoured only for a plain-http loopback URL with no userinfo, because every
/// request carries the user's bearer token and a base anywhere else would hand
/// it over. The loopback rule is the one `MAILVAULT_IMAP_PLAINTEXT` applies on
/// the IMAP side; unlike that hatch, this one is only ever read in debug
/// builds (`graph_base_env`).
fn resolve_graph_base(env: Option<&str>) -> String {
    let Some(raw) = env.map(str::trim).filter(|s| !s.is_empty()) else {
        return GRAPH_BASE_DEFAULT.to_string();
    };
    let loopback = reqwest::Url::parse(raw).ok().is_some_and(|url| {
        url.scheme() == "http"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            })
    });
    if loopback {
        warn!("[Graph] MAILVAULT_GRAPH_BASE={} — requests go to a loopback mock", raw);
        raw.trim_end_matches('/').to_string()
    } else {
        warn!("[Graph] MAILVAULT_GRAPH_BASE={} ignored — not a loopback http URL", raw);
        GRAPH_BASE_DEFAULT.to_string()
    }
}

fn graph_base() -> &'static str {
    static BASE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BASE.get_or_init(|| resolve_graph_base(graph_base_env().as_deref()))
}

/// The e2e override, read in debug builds only (like `MAILVAULT_TEST_CREDENTIALS`):
/// a shipped binary ignores it, so whoever launches MailVault cannot point the
/// user's Outlook token at a listener of their own, loopback or not.
#[cfg(debug_assertions)]
fn graph_base_env() -> Option<String> {
    std::env::var("MAILVAULT_GRAPH_BASE").ok()
}

#[cfg(not(debug_assertions))]
fn graph_base_env() -> Option<String> {
    None
}

/// Well-known folder name -> the storage key every store uses for it.
pub const WELL_KNOWN: [(&str, &str); 6] = [
    ("inbox", "INBOX"),
    ("sentitems", "Sent"),
    ("drafts", "Drafts"),
    ("deleteditems", "Trash"),
    ("junkemail", "Junk"),
    ("archive", "Archive"),
];

/// Why a `$batch` could not resolve the well-known folders. Throttling is the
/// one failure that clears on its own in seconds, so it is a variant of its own
/// and not a string the caller would have to grep.
#[derive(Debug, PartialEq)]
pub enum BatchError {
    /// A sub-request was throttled; `retry_after` is what Graph said, in
    /// seconds, uncapped — the log reports the server's number, the sleep clamps
    /// it.
    Throttled { id: String, retry_after: u64 },
    /// Anything else: a 5xx sub-response, a missing status.
    Broken(String),
}

impl BatchError {
    pub fn message(&self) -> String {
        match self {
            BatchError::Throttled { id, retry_after } => format!(
                "Graph $batch sub-request {} answered (429:retry_after={})",
                id, retry_after
            ),
            BatchError::Broken(m) => m.clone(),
        }
    }
}

/// `{"responses":[{"id":"sentitems","status":200,"body":{"id":"AAMk…"}}, …]}`
/// -> `[("sentitems", "AAMk…")]`. A 404 is a mailbox without that folder (no
/// Archive), and a 200 without a body id has nothing to tag: both are skipped.
///
/// Every other sub-status FAILS the listing. Graph answers the `$batch` POST
/// 200 and throttles or errors the sub-requests INDIVIDUALLY, so a 429 in here
/// is the same outage as a 429 on the POST — and dropping it would tag nothing
/// and key every folder by display name, the degradation this resolution
/// exists to remove. A throttled sub-request is the common case and reads back
/// as `Throttled`, which `resolve_well_known_ids` retries once.
pub fn parse_well_known_batch(
    json: &serde_json::Value,
) -> Result<Vec<(String, String)>, BatchError> {
    let mut out = Vec::new();
    for r in json["responses"].as_array().into_iter().flatten() {
        let id = r["id"].as_str().unwrap_or("?");
        match r["status"].as_u64() {
            Some(200) => {
                if let Some(folder_id) = r["body"]["id"].as_str() {
                    out.push((id.to_string(), folder_id.to_string()));
                }
            }
            Some(404) => {}
            Some(429) => {
                // Carried uncapped, so the log says what Graph said; the caller
                // clamps it the way `retry_after_secs` clamps the POST's.
                let retry_after = r["headers"]["Retry-After"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(1);
                return Err(BatchError::Throttled { id: id.to_string(), retry_after });
            }
            Some(status) => {
                return Err(BatchError::Broken(format!(
                    "Graph $batch sub-request {} answered {}",
                    id, status
                )))
            }
            None => {
                return Err(BatchError::Broken(format!(
                    "Graph $batch sub-request {} answered no status",
                    id
                )))
            }
        }
    }
    Ok(out)
}

/// Stamp `well_known_name` on every folder whose id the batch resolved.
pub fn tag_well_known(folders: &mut [GraphMailFolder], resolved: &[(String, String)]) -> usize {
    let mut tagged = 0;
    for f in folders.iter_mut() {
        if let Some((name, _)) = resolved.iter().find(|(_, id)| *id == f.id) {
            f.well_known_name = Some(name.clone());
            tagged += 1;
        }
    }
    tagged
}

/// The key `$batch` earned this folder, or its display name. There is no
/// display-name table: guessing "Sent Items" -> Sent gets an English mailbox
/// right and every other one wrong, which is the bug. A listing whose
/// well-known lookup failed is an error, not a listing keyed by language.
pub fn storage_key_for(folder: &GraphMailFolder) -> String {
    folder
        .well_known_name
        .as_deref()
        .and_then(|n| WELL_KNOWN.iter().find(|(name, _)| *name == n))
        .map(|(_, key)| key.to_string())
        // A user folder literally named "Sent Items" beside a tagged Sent keys
        // as "Sent Items": the display name, never the well-known word.
        .unwrap_or_else(|| folder.display_name.clone())
}

pub fn assign_storage_keys(folders: &mut [GraphMailFolder]) {
    for f in folders.iter_mut() {
        f.storage_key = storage_key_for(f);
    }
}

/// Graph refuses a request body over 4 MB. A `sendMail` MIME body goes
/// base64-encoded, so this caps the encoded bytes (about 3 MB of message).
pub const SEND_MAIL_LIMIT_BYTES: usize = 4 * 1024 * 1024;

/// Why `GraphClient::send_mime` did not send. The words the user reads are
/// `smtp`'s to choose: this says only what happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendMailError {
    /// Over `SEND_MAIL_LIMIT_BYTES` once encoded: refused before any request.
    TooLarge { encoded_bytes: usize },
    /// The request got no answer (connect, TLS, timeout, a dropped
    /// connection). `maybe_sent` is false only for what reqwest reports as a
    /// failed connect, so Graph cannot have the message; anything else may
    /// have reached it. A connect that hangs fails as a connect too, after
    /// `SEND_CONNECT_TIMEOUT` (`GraphClient::for_send`), since nothing was
    /// written yet; a client without that timeout would report it as the
    /// request's own timeout, so as maybe sent. `detail` is the error with its
    /// causes, the URL left out.
    Transport { timed_out: bool, maybe_sent: bool, detail: String },
    /// Graph answered, and not with a 2xx. `code` and `message` are the error
    /// body's `error.code` / `error.message` when it had them.
    Refused { status: u16, code: Option<String>, message: Option<String>, retry_after: Option<u64> },
}

/// A reqwest error and its causes on one line, the URL left out.
fn error_chain(e: reqwest::Error) -> String {
    crate::net_activity::error_chain(&e.without_url())
}

/// How long a send waits for its connection to open, TCP and TLS, before it
/// gives up. Without it a connect that never answers (a captive portal, a
/// firewall that drops the packets) ran into the request's own timeout,
/// which reads as a send Microsoft may have taken. This way it fails as a
/// connect, before any byte of the request was written. Well under the
/// send's own timeout (a minute at least, `smtp::send_via_graph`).
const SEND_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The send's HTTP client: purpose "send", and a connect that gives up
/// after `connect_timeout`.
fn send_client(connect_timeout: std::time::Duration) -> Tracked {
    http_client_with("send", reqwest::Client::builder().connect_timeout(connect_timeout))
}

/// A send request that got no answer. Only a failed connect wrote nothing,
/// so anything else may have reached Graph (`SendMailError::Transport`).
fn transport_error(e: reqwest::Error) -> SendMailError {
    SendMailError::Transport { timed_out: e.is_timeout(), maybe_sent: !e.is_connect(), detail: error_chain(e) }
}

/// `retry-after` in whole seconds, for the one `$batch` retry. Clamped to
/// 1..=5: capped so a throttled listing cannot hold a caller for the minutes
/// Graph sometimes asks for, floored so `retry-after: 0` is a retry rather than
/// an immediate second hammer. 1 when the header is missing or is an HTTP date.
fn retry_after_secs(headers: &reqwest::header::HeaderMap) -> u64 {
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1)
        .clamp(1, 5)
}

pub struct GraphClient {
    // pub (not pub(crate)) so the daemon's migration.rs can issue custom
    // authenticated Graph requests not covered by GraphClient's own methods.
    pub client: Tracked,
    pub access_token: String,
}

impl GraphClient {
    pub fn new(access_token: &str) -> Self {
        Self::for_purpose(access_token, "sync")
    }

    /// A client whose requests show under `purpose` in Network Activity.
    pub fn for_purpose(access_token: &str, purpose: &str) -> Self {
        Self {
            client: http_client(purpose, None),
            access_token: access_token.to_string(),
        }
    }

    /// A client for `send_mime`, purpose "send", whose connection gives up
    /// after `SEND_CONNECT_TIMEOUT`: a send that never left then reports a
    /// failed connect, never one that may have gone out.
    pub fn for_send(access_token: &str) -> Self {
        Self { client: send_client(SEND_CONNECT_TIMEOUT), access_token: access_token.to_string() }
    }

    /// Its requests shown as `email`'s (`Tracked::for_account`).
    pub fn for_account(mut self, email: &str) -> Self {
        self.client = self.client.for_account(email);
        self
    }

    /// List all mail folders for the authenticated user, each stamped with
    /// its well-known name (when it has one) and its storage key.
    pub async fn list_folders(&self) -> Result<Vec<GraphMailFolder>, String> {
        let url = format!("{}/me/mailFolders?$top=100", graph_base());
        let resp = self
            .client
            .send(self.client
                .get(&url)
                .bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph list_folders request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph list_folders failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph list_folders failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let list: GraphListResponse<GraphMailFolder> = resp
            .json()
            .await
            .map_err(|e| format!("Graph list_folders parse error: {}", e))?;

        let mut folders = list.value;
        // Fail closed: a listing whose keys could not be resolved is an error.
        // Keying by display name instead would re-split the store for exactly
        // the non-English mailboxes this resolution exists for, and the caller
        // already retries a failed listing (10-minute folder cache, scheduler).
        let resolved = self.resolve_well_known_ids().await?;
        // Inbox exists in every mailbox, so zero tags is a broken lookup, not a
        // mailbox without default folders.
        if tag_well_known(&mut folders, &resolved) == 0 {
            return Err("Graph well-known lookup resolved no folder (inbox always exists)".into());
        }
        assign_storage_keys(&mut folders);
        Ok(folders)
    }

    /// One `$batch` of `GET /me/mailFolders/{well-known}?$select=id` for the
    /// six default folders. Well-known names resolve whatever the mailbox's
    /// language calls the folder; the listing's displayName does not.
    ///
    /// A 429 is retried once after `retry-after`, because throttling is the one
    /// failure that clears on its own in seconds. It counts whether Graph
    /// answered the POST 429 or answered 200 and threw the 429 in a
    /// SUB-response, which is the common shape: one retry budget covers both.
    /// Anything else — a second 429 included — is an `Err` the caller retries on
    /// its own schedule.
    async fn resolve_well_known_ids(&self) -> Result<Vec<(String, String)>, String> {
        let requests: Vec<serde_json::Value> = WELL_KNOWN
            .iter()
            .map(|(name, _)| serde_json::json!({
                "id": name,
                "method": "GET",
                "url": format!("/me/mailFolders/{}?$select=id", name),
            }))
            .collect();
        let body = serde_json::json!({ "requests": requests });
        let mut retried = false;
        loop {
            let resp = self
                .client
                .send(self.client
                    .post(format!("{}/$batch", graph_base()))
                    .bearer_auth(&self.access_token)
                    .json(&body))
                .await
                .map_err(|e| format!("Graph $batch request failed: {}", e))?;
            let status = resp.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS && !retried {
                let wait = retry_after_secs(resp.headers());
                warn!("[Graph] $batch throttled, one retry in {}s", wait);
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                retried = true;
                continue;
            }
            if !status.is_success() {
                // A second 429 keeps the marker the file's other 429 sites use.
                let throttle = (status == reqwest::StatusCode::TOO_MANY_REQUESTS)
                    .then(|| format!("429:retry_after={}", retry_after_secs(resp.headers())));
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "Graph $batch failed ({}) {}",
                    throttle.unwrap_or_else(|| status.as_u16().to_string()),
                    body
                ));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Graph $batch parse error: {}", e))?;
            match parse_well_known_batch(&json) {
                Err(BatchError::Throttled { id, retry_after }) if !retried => {
                    let wait = retry_after.clamp(1, 5);
                    warn!("[Graph] $batch sub-request {} throttled, one retry in {}s", id, wait);
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    retried = true;
                }
                other => return other.map_err(|e| e.message()),
            }
        }
    }

    /// List messages in a folder with pagination.
    /// Returns the messages and an optional next-link URL for the next page.
    pub async fn list_messages(
        &self,
        folder_id: &str,
        top: u32,
        skip: u32,
    ) -> Result<(Vec<GraphMessage>, Option<String>), String> {
        let url = format!(
            "{}/me/mailFolders/{}/messages?$top={}&$skip={}&$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,internetMessageId&$orderby=receivedDateTime desc",
            graph_base(), folder_id, top, skip
        );

        let resp = self
            .client
            .send(self.client
                .get(&url)
                .bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph list_messages request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph list_messages failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph list_messages failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let list: GraphListResponse<GraphMessage> = resp
            .json()
            .await
            .map_err(|e| format!("Graph list_messages parse error: {}", e))?;

        Ok((list.value, list.next_link))
    }

    /// Get a single message with full body and internet headers.
    pub async fn get_message(&self, message_id: &str) -> Result<GraphMessage, String> {
        let url = format!(
            "{}/me/messages/{}?$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,internetMessageId,body,internetMessageHeaders",
            graph_base(), message_id
        );

        let resp = self
            .client
            .send(self.client
                .get(&url)
                .bearer_auth(&self.access_token)
                .header("Prefer", "outlook.body-content-type=\"html\""))
            .await
            .map_err(|e| format!("Graph get_message request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph get_message failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph get_message failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        resp.json()
            .await
            .map_err(|e| format!("Graph get_message parse error: {}", e))
    }

    /// Mark a message as read or unread.
    pub async fn set_read_status(
        &self,
        message_id: &str,
        is_read: bool,
    ) -> Result<(), String> {
        let url = format!("{}/me/messages/{}", graph_base(), message_id);

        let resp = self
            .client
            .send(self.client
                .patch(&url)
                .bearer_auth(&self.access_token)
                .json(&serde_json::json!({ "isRead": is_read })))
            .await
            .map_err(|e| format!("Graph set_read_status request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph set_read_status failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph set_read_status failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        Ok(())
    }

    /// Outlook's flag is MailVault's star: `flag.flagStatus` flagged / notFlagged.
    ///
    /// Graph has exactly two of our flags — `isRead` above and this one.
    /// \Answered and keywords have no equivalent and never reach here.
    pub async fn set_flag_status(&self, message_id: &str, flagged: bool) -> Result<(), String> {
        let url = format!("{}/me/messages/{}", graph_base(), message_id);

        let resp = self
            .client
            .send(self.client
                .patch(&url)
                .bearer_auth(&self.access_token)
                .json(&serde_json::json!({
                    "flag": { "flagStatus": if flagged { "flagged" } else { "notFlagged" } }
                })))
            .await
            .map_err(|e| format!("Graph set_flag_status request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph set_flag_status failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph set_flag_status failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        Ok(())
    }

    /// Delete a message (moves to Deleted Items by default in Graph API).
    pub async fn delete_message(&self, message_id: &str) -> Result<(), String> {
        let url = format!("{}/me/messages/{}", graph_base(), message_id);

        let resp = self
            .client
            .send(self.client
                .delete(&url)
                .bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph delete_message request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph delete_message failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph delete_message failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        Ok(())
    }

    /// Move a message to a different folder. Returns the new message ID.
    pub async fn move_message(
        &self,
        message_id: &str,
        destination_folder_id: &str,
    ) -> Result<String, String> {
        let url = format!("{}/me/messages/{}/move", graph_base(), message_id);

        let resp = self
            .client
            .send(self.client
                .post(&url)
                .bearer_auth(&self.access_token)
                .json(&serde_json::json!({ "destinationId": destination_folder_id })))
            .await
            .map_err(|e| format!("Graph move_message request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph move_message failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph move_message failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let moved: GraphMessage = resp
            .json()
            .await
            .map_err(|e| format!("Graph move_message parse error: {}", e))?;

        Ok(moved.id)
    }

    /// Download the raw MIME (.eml) content of a message.
    pub async fn get_mime_content(&self, message_id: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/me/messages/{}/$value", graph_base(), message_id);

        let resp = self
            .client
            .send(self.client
                .get(&url)
                .bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph get_mime_content request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph get_mime_content failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph get_mime_content failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("Graph get_mime_content read error: {}", e))
    }

    // -----------------------------------------------------------------------
    // Migration helpers: MIME upload + folder creation
    // -----------------------------------------------------------------------

    /// Upload a raw MIME message to the drafts folder, returning the new message ID.
    /// Graph API requires the MIME content to be base64-encoded with Content-Type: text/plain.
    pub async fn create_message_from_mime(&self, mime_bytes: &[u8]) -> Result<String, String> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(mime_bytes);
        let url = format!("{}/me/messages", graph_base());

        let resp = self
            .client
            .send(self.client
                .post(&url)
                .bearer_auth(&self.access_token)
                .header("Content-Type", "text/plain")
                .body(encoded))
            .await
            .map_err(|e| format!("Graph create_message_from_mime request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph create_message_from_mime failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph create_message_from_mime failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let msg: GraphMessage = resp
            .json()
            .await
            .map_err(|e| format!("Graph create_message_from_mime parse error: {}", e))?;

        Ok(msg.id)
    }

    /// Send a complete MIME message as it is (`POST /me/sendMail`, the bytes
    /// base64-encoded, `Content-Type: text/plain`). Graph answers 202 and
    /// files the copy in Sent Items itself. Recipients come off the MIME's
    /// To/Cc/Bcc headers: there is no envelope.
    ///
    /// Never retried here: a request that timed out after Graph took it has
    /// already sent the mail, and a second try would send it twice.
    pub async fn send_mime(&self, mime: &[u8], timeout: std::time::Duration) -> Result<(), SendMailError> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(mime);
        if encoded.len() > SEND_MAIL_LIMIT_BYTES {
            return Err(SendMailError::TooLarge { encoded_bytes: encoded.len() });
        }
        let url = format!("{}/me/sendMail", graph_base());
        let resp = self
            .client
            .send(self.client
                .post(&url)
                .bearer_auth(&self.access_token)
                .header("Content-Type", "text/plain")
                .timeout(timeout)
                .body(encoded))
            .await
            .map_err(transport_error)?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let body = resp.text().await.unwrap_or_default();
        let error: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let field = |k: &str| error["error"][k].as_str().map(str::to_string).filter(|s| !s.is_empty());
        Err(SendMailError::Refused { status: status.as_u16(), code: field("code"), message: field("message"), retry_after })
    }

    /// Create a mail folder. If `parent_folder_id` is provided, creates a child folder.
    /// Handles 409 Conflict (folder already exists) by listing folders and returning the match.
    pub async fn create_folder(
        &self,
        display_name: &str,
        parent_folder_id: Option<&str>,
    ) -> Result<GraphMailFolder, String> {
        let url = match parent_folder_id {
            Some(parent_id) => format!(
                "{}/me/mailFolders/{}/childFolders",
                graph_base(), parent_id
            ),
            None => format!("{}/me/mailFolders", graph_base()),
        };

        let resp = self
            .client
            .send(self.client
                .post(&url)
                .bearer_auth(&self.access_token)
                .json(&serde_json::json!({ "displayName": display_name })))
            .await
            .map_err(|e| format!("Graph create_folder request failed: {}", e))?;

        let status = resp.status();

        // 409 Conflict = folder already exists — find and return it
        if status.as_u16() == 409 {
            let folders = self.list_folders().await?;
            return folders
                .into_iter()
                .find(|f| f.display_name.eq_ignore_ascii_case(display_name))
                .ok_or_else(|| {
                    format!(
                        "Graph create_folder: 409 Conflict but could not find folder '{}'",
                        display_name
                    )
                });
        }

        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30);
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Graph create_folder failed (429:retry_after={}) {}", retry_after, body));
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph create_folder failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        resp.json()
            .await
            .map_err(|e| format!("Graph create_folder parse error: {}", e))
    }

    /// Rename a folder. Graph names folders, it does not path them, so this is
    /// the whole of a rename — the subtree comes along untouched.
    pub async fn rename_folder(&self, folder_id: &str, display_name: &str) -> Result<(), String> {
        let url = format!("{}/me/mailFolders/{}", graph_base(), folder_id);

        let resp = self
            .client
            .send(self.client
                .patch(&url)
                .bearer_auth(&self.access_token)
                .json(&serde_json::json!({ "displayName": display_name })))
            .await
            .map_err(|e| format!("Graph rename_folder request failed: {}", e))?;

        Self::folder_op_status(resp, "rename_folder").await
    }

    /// Move a folder under another one. `destination_id` takes a well-known
    /// name as well as an id, which is what makes "deleteditems" the delete.
    pub async fn move_folder(&self, folder_id: &str, destination_id: &str) -> Result<(), String> {
        let url = format!("{}/me/mailFolders/{}/move", graph_base(), folder_id);

        let resp = self
            .client
            .send(self.client
                .post(&url)
                .bearer_auth(&self.access_token)
                .json(&serde_json::json!({ "destinationId": destination_id })))
            .await
            .map_err(|e| format!("Graph move_folder request failed: {}", e))?;

        Self::folder_op_status(resp, "move_folder").await
    }

    /// Delete a folder for good. Graph's DELETE on a folder outside Deleted
    /// Items moves it there instead, so the caller only reaches this for one
    /// that is already in the bin.
    pub async fn delete_folder(&self, folder_id: &str) -> Result<(), String> {
        let url = format!("{}/me/mailFolders/{}", graph_base(), folder_id);

        let resp = self
            .client
            .send(self.client
                .delete(&url)
                .bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph delete_folder request failed: {}", e))?;

        Self::folder_op_status(resp, "delete_folder").await
    }

    /// The response check the three folder operations share, including the 429
    /// branch every other Graph call carries.
    async fn folder_op_status(resp: reqwest::Response, what: &str) -> Result<(), String> {
        if resp.status().is_success() {
            return Ok(());
        }
        Err(Self::failure_text(resp, what).await)
    }

    /// The error text of a non-success answer: `Graph <what> failed (<status>)
    /// <body>`, and for a 429 `(429:retry_after=N)` (30 when the header is
    /// missing), which `abd::throttle::classify_graph` and
    /// `retry_after_from_error` read back.
    async fn failure_text(resp: reqwest::Response, what: &str) -> String {
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(30);
            let body = resp.text().await.unwrap_or_default();
            return format!("Graph {} failed (429:retry_after={}) {}", what, retry_after, body);
        }
        let body = resp.text().await.unwrap_or_default();
        format!("Graph {} failed ({}) {}", what, status.as_u16(), body)
    }

    // -----------------------------------------------------------------------
    // Archive, back up & delete (abd::graph_ops)
    // -----------------------------------------------------------------------

    /// One page of a folder's messages with what a scope listing needs: the
    /// received time, the Message-ID and the size (`PR_MESSAGE_SIZE`, an
    /// extended property, so `None` when Graph does not return it).
    /// `next` is the previous page's link (`None` = first page). The link is
    /// only followed when it points at the Graph base, because every request
    /// carries the bearer token. A message with no usable `receivedDateTime` is
    /// left out: filing it under 1970 would put it in an "older than" scope.
    pub async fn list_page(
        &self,
        folder_id: &str,
        next: Option<&str>,
    ) -> Result<(Vec<GraphListed>, Option<String>), String> {
        let url = match next {
            Some(link) => {
                if !is_graph_link(link) {
                    return Err("Graph list_page refused a nextLink outside the Graph base".to_string());
                }
                link.to_string()
            }
            None => format!(
                "{}/me/mailFolders/{}/messages?$top=1000&$select=id,receivedDateTime,internetMessageId&$expand={}",
                graph_base(),
                percent_encode(folder_id),
                percent_encode(&format!("singleValueExtendedProperties($filter=id eq '{}')", SIZE_PROPERTY_ID)),
            ),
        };
        let resp = self
            .client
            .send(self.client.get(&url).bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph list_page request failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(Self::failure_text(resp, "list_page").await);
        }
        let list: GraphListResponse<RawListed> = resp
            .json()
            .await
            .map_err(|e| format!("Graph list_page parse error: {}", e))?;
        let total = list.value.len();
        let rows: Vec<GraphListed> = list.value.into_iter().filter_map(RawListed::into_listed).collect();
        if rows.len() < total {
            warn!("[Graph] list_page left out {} message(s) without a received time", total - rows.len());
        }
        Ok((rows, list.next_link))
    }

    /// Does the message still exist (under this id)? A moved message gets a new
    /// id, so the old one answers 404.
    pub async fn message_exists(&self, id: &str) -> Result<bool, String> {
        let url = format!("{}/me/messages/{}?$select=id", graph_base(), percent_encode(id));
        let resp = self
            .client
            .send(self.client.get(&url).bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph message_exists request failed: {}", e))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        Self::folder_op_status(resp, "message_exists").await?;
        Ok(true)
    }

    /// The message's `internetMessageId` as Graph stores it (bracketed), or
    /// `None` when it has none. 404 is `Err` (`Graph message_internet_id failed (404)`).
    pub async fn message_internet_id(&self, id: &str) -> Result<Option<String>, String> {
        let url = format!("{}/me/messages/{}?$select=id,internetMessageId", graph_base(), percent_encode(id));
        let resp = self
            .client
            .send(self.client.get(&url).bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph message_internet_id request failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(Self::failure_text(resp, "message_internet_id").await);
        }
        let m: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Graph message_internet_id parse error: {}", e))?;
        Ok(m.get("internetMessageId").and_then(|v| v.as_str()).map(str::to_string))
    }

    /// Delete the message for good, skipping the Deleted Items soft delete that
    /// a plain `DELETE` does (`POST .../permanentDelete`, 204).
    pub async fn permanent_delete(&self, id: &str) -> Result<(), String> {
        let url = format!("{}/me/messages/{}/permanentDelete", graph_base(), percent_encode(id));
        let resp = self
            .client
            .send(self.client.post(&url).bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph permanent_delete request failed: {}", e))?;
        Self::folder_op_status(resp, "permanent_delete").await
    }

    /// Every message id in the folder whose `internetMessageId` is `imid`
    /// (exactly as Graph stores it, angle brackets included). All hits are
    /// returned, up to 10, so a caller can tell a duplicate from a single match.
    pub async fn find_by_internet_message_id(&self, folder_id: &str, imid: &str) -> Result<Vec<String>, String> {
        let filter = format!("internetMessageId eq '{}'", imid.replace('\'', "''"));
        let url = format!(
            "{}/me/mailFolders/{}/messages?$filter={}&$select=id&$top=10",
            graph_base(),
            percent_encode(folder_id),
            percent_encode(&filter),
        );
        let resp = self
            .client
            .send(self.client.get(&url).bearer_auth(&self.access_token))
            .await
            .map_err(|e| format!("Graph find_by_internet_message_id request failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(Self::failure_text(resp, "find_by_internet_message_id").await);
        }
        #[derive(Deserialize)]
        struct IdOnly {
            id: String,
        }
        let list: GraphListResponse<IdOnly> = resp
            .json()
            .await
            .map_err(|e| format!("Graph find_by_internet_message_id parse error: {}", e))?;
        Ok(list.value.into_iter().map(|m| m.id).collect())
    }

    // -----------------------------------------------------------------------
    // Error classification helpers
    // -----------------------------------------------------------------------

    pub fn is_token_expired(error: &str) -> bool {
        error.contains("(401)")
    }

    /// A 429. Every call formats it `(429:retry_after=N)`, so matching `(429)`
    /// alone (as this once did) never fired.
    pub fn is_rate_limited(error: &str) -> bool {
        error.contains("(429)") || error.contains("(429:")
    }

    /// The `N` of a `(429:retry_after=N)` error, in seconds.
    pub fn retry_after_from_error(error: &str) -> Option<u64> {
        const MARKER: &str = "(429:retry_after=";
        let rest = &error[error.find(MARKER)? + MARKER.len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Domain detection ---------------------------------------------------

    #[test]
    fn insights_graph_dates_keep_receive_send_and_original_separate() {
        let msg: GraphMessage = serde_json::from_value(serde_json::json!({
            "id":"m1", "receivedDateTime":"2026-09-09T00:30:00Z",
            "sentDateTime":"2026-09-08T23:30:00Z",
            "bccRecipients":[{"emailAddress":{"address":"hidden@example.test","name":"Hidden"}}],
            "internetMessageHeaders":[{"name":"Date","value":"Tue, 08 Sep 2026 23:00:00 +0000"}]
        })).unwrap();
        let row = serde_json::to_value(msg.to_email_header(17)).unwrap();
        assert_eq!(row["date"], "2026-09-09T00:30:00Z");
        assert_eq!(row["bcc"][0]["address"], "hidden@example.test");
        assert_eq!(row["receivedAt"], "2026-09-09T00:30:00Z");
        assert_eq!(row["sentAt"], "2026-09-08T23:30:00Z");
        assert_eq!(row["messageDate"], "Tue, 08 Sep 2026 23:00:00 +0000");
    }

    #[test]
    fn test_personal_microsoft_detection() {
        assert!(is_personal_microsoft("user@outlook.com"));
        assert!(is_personal_microsoft("user@Outlook.COM"));
        assert!(is_personal_microsoft("user@hotmail.com"));
        assert!(is_personal_microsoft("user@live.com"));
        assert!(is_personal_microsoft("user@msn.com"));
        assert!(is_personal_microsoft("user@outlook.co.uk"));
        assert!(is_personal_microsoft("user@hotmail.de"));
        assert!(is_personal_microsoft("user@live.fr"));
        assert!(is_personal_microsoft("user@outlook.jp"));
        assert!(is_personal_microsoft("user@hotmail.co.jp"));

        assert!(!is_personal_microsoft("user@gmail.com"));
        assert!(!is_personal_microsoft("user@company.onmicrosoft.com"));
        assert!(!is_personal_microsoft("user@custom-domain.com"));
        assert!(!is_personal_microsoft("noatsign"));
        assert!(!is_personal_microsoft(""));
    }

    // -- JSON parsing -------------------------------------------------------

    #[test]
    fn test_parse_graph_folder_response() {
        let json = r#"{
            "value": [
                {
                    "id": "inbox-id-123",
                    "displayName": "Inbox",
                    "totalItemCount": 42,
                    "unreadItemCount": 5,
                    "childFolderCount": 2
                },
                {
                    "id": "sent-id-456",
                    "displayName": "Sent Items",
                    "totalItemCount": 100,
                    "unreadItemCount": 0
                }
            ]
        }"#;

        let resp: GraphListResponse<GraphMailFolder> = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value.len(), 2);
        assert_eq!(resp.value[0].display_name, "Inbox");
        assert_eq!(resp.value[0].total_item_count, 42);
        assert_eq!(resp.value[0].unread_item_count, 5);
        assert_eq!(resp.value[0].child_folder_count, 2);
        assert_eq!(resp.value[1].display_name, "Sent Items");
        // childFolderCount defaults to 0 when missing
        assert_eq!(resp.value[1].child_folder_count, 0);
        assert!(resp.next_link.is_none());
    }

    #[test]
    fn test_parse_graph_message_response() {
        let json = r#"{
            "value": [
                {
                    "id": "msg-id-abc",
                    "subject": "Hello World",
                    "from": {
                        "emailAddress": {
                            "name": "Alice",
                            "address": "alice@outlook.com"
                        }
                    },
                    "toRecipients": [
                        {
                            "emailAddress": {
                                "name": "Bob",
                                "address": "bob@example.com"
                            }
                        }
                    ],
                    "ccRecipients": [],
                    "receivedDateTime": "2025-01-15T10:30:00Z",
                    "isRead": true,
                    "hasAttachments": false,
                    "internetMessageId": "<msg123@outlook.com>"
                }
            ]
        }"#;

        let resp: GraphListResponse<GraphMessage> = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value.len(), 1);

        let msg = &resp.value[0];
        assert_eq!(msg.id, "msg-id-abc");
        assert_eq!(msg.subject.as_deref(), Some("Hello World"));
        assert_eq!(
            msg.from.as_ref().unwrap().email_address.address.as_deref(),
            Some("alice@outlook.com")
        );
        assert_eq!(msg.is_read, Some(true));
        assert_eq!(msg.has_attachments, Some(false));
        assert_eq!(
            msg.internet_message_id.as_deref(),
            Some("<msg123@outlook.com>")
        );
    }

    #[test]
    fn test_graph_message_to_email_header() {
        let msg = GraphMessage {
            id: "msg-id-1".to_string(),
            subject: Some("Test Subject".to_string()),
            from: Some(GraphEmailAddress {
                email_address: GraphEmail {
                    name: Some("Sender Name".to_string()),
                    address: Some("sender@outlook.com".to_string()),
                },
            }),
            to_recipients: Some(vec![GraphEmailAddress {
                email_address: GraphEmail {
                    name: Some("Recipient".to_string()),
                    address: Some("recipient@example.com".to_string()),
                },
            }]),
            bcc_recipients: None,
            cc_recipients: Some(vec![GraphEmailAddress {
                email_address: GraphEmail {
                    name: None,
                    address: Some("cc@example.com".to_string()),
                },
            }]),
            sent_date_time: None,
            received_date_time: Some("2025-01-15T10:30:00Z".to_string()),
            is_read: Some(true),
            has_attachments: Some(true),
            internet_message_id: Some("<test-123@outlook.com>".to_string()),
            body: None,
            internet_message_headers: None,
        };

        let header = msg.to_email_header(42);

        assert_eq!(header.uid, 42);
        assert_eq!(header.seq, 42);
        assert_eq!(header.subject, "Test Subject");
        assert_eq!(header.from.name.as_deref(), Some("Sender Name"));
        assert_eq!(header.from.address, "sender@outlook.com");
        assert_eq!(header.to.len(), 1);
        assert_eq!(header.to[0].address, "recipient@example.com");
        assert_eq!(header.cc.len(), 1);
        assert_eq!(header.cc[0].address, "cc@example.com");
        assert!(header.bcc.is_empty());
        assert_eq!(header.date.as_deref(), Some("2025-01-15T10:30:00Z"));
        assert!(header.flags.contains(&"\\Seen".to_string()));
        assert!(header.has_attachments);
        assert_eq!(
            header.message_id.as_deref(),
            Some("<test-123@outlook.com>")
        );
        assert_eq!(header.source.as_deref(), Some("graph"));
        assert!(header.in_reply_to.is_none());
        assert!(header.references.is_none());
    }

    #[test]
    fn test_pagination_next_link() {
        let json = r#"{
            "value": [],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50"
        }"#;

        let resp: GraphListResponse<GraphMessage> = serde_json::from_str(json).unwrap();
        assert!(resp.value.is_empty());
        assert_eq!(
            resp.next_link.as_deref(),
            Some("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50")
        );
    }

    // -- Error classification -----------------------------------------------

    #[test]
    fn test_error_classification() {
        assert!(GraphClient::is_token_expired(
            "Graph get_message failed (401) Unauthorized"
        ));
        assert!(!GraphClient::is_token_expired(
            "Graph get_message failed (403) Forbidden"
        ));
        assert!(GraphClient::is_rate_limited(
            "Graph list_messages failed (429) Too Many Requests"
        ));
        assert!(!GraphClient::is_rate_limited(
            "Graph list_messages failed (500) Server Error"
        ));
    }

    #[test]
    fn a_retry_after_429_is_rate_limited_and_its_seconds_are_readable() {
        // Every call formats a 429 this way; matching "(429)" alone never fired.
        let e = "Graph move_message failed (429:retry_after=12) {\"error\":{}}";
        assert!(GraphClient::is_rate_limited(e));
        assert_eq!(GraphClient::retry_after_from_error(e), Some(12));
        assert_eq!(GraphClient::retry_after_from_error("Graph x failed (429) slow down"), None);
        assert_eq!(GraphClient::retry_after_from_error("Graph x failed (500) (429:retry_after=oops)"), None);
        assert!(!GraphClient::is_rate_limited("Graph x failed (4290) nope"));
    }

    #[test]
    fn percent_encode_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(percent_encode("AaZz09-._~"), "AaZz09-._~");
        assert_eq!(percent_encode("a b+c&d='e'<x@y>"), "a%20b%2Bc%26d%3D%27e%27%3Cx%40y%3E");
        assert_eq!(percent_encode("\u{e4}"), "%C3%A4");
    }

    #[test]
    fn the_size_property_is_read_case_insensitively_and_absent_means_none() {
        let listed = |props: serde_json::Value| -> Option<GraphListed> {
            serde_json::from_value::<RawListed>(serde_json::json!({
                "id": "m", "receivedDateTime": "2024-03-01T10:00:00Z", "singleValueExtendedProperties": props
            }))
            .unwrap()
            .into_listed()
        };
        assert_eq!(listed(serde_json::json!([{"id": "Integer 0x0E08", "value": "2048"}])).unwrap().size, Some(2048));
        assert_eq!(listed(serde_json::json!([{"id": "integer 0xe08", "value": 12}])).unwrap().size, Some(12));
        assert_eq!(listed(serde_json::json!([{"id": "Integer 0x0E08", "value": "-5"}])).unwrap().size, None);
        assert_eq!(listed(serde_json::json!([{"id": "Integer 0x0E08", "value": "99999999999"}])).unwrap().size, None);
        assert_eq!(listed(serde_json::json!([{"id": "String 0x0037", "value": "3"}])).unwrap().size, None);
        assert_eq!(listed(serde_json::Value::Null).unwrap().size, None);
        let undated: RawListed = serde_json::from_value(serde_json::json!({"id": "m"})).unwrap();
        assert!(undated.into_listed().is_none());
        let bad: RawListed = serde_json::from_value(serde_json::json!({"id": "m", "receivedDateTime": "soon"})).unwrap();
        assert!(bad.into_listed().is_none());
    }

    #[test]
    fn only_a_link_under_the_graph_base_is_followed() {
        let base = graph_base().to_string();
        assert!(is_graph_link(&format!("{base}/me/mailFolders/x/messages?$skiptoken=1")));
        assert!(!is_graph_link(&format!("{base}.evil.example/me")));
        assert!(!is_graph_link("https://evil.example/v1.0/me"));
        assert!(!is_graph_link(&format!("{base}9/me")));
    }

    // -- Edge cases ---------------------------------------------------------

    #[test]
    fn test_message_with_no_from() {
        let msg = GraphMessage {
            id: "msg-no-from".to_string(),
            subject: None,
            from: None,
            to_recipients: None,
            bcc_recipients: None,
            cc_recipients: None,
            sent_date_time: None,
            received_date_time: None,
            is_read: None,
            has_attachments: None,
            internet_message_id: None,
            body: None,
            internet_message_headers: None,
        };

        let header = msg.to_email_header(1);

        // from falls back to default EmailAddress
        assert_eq!(header.from.address, "unknown@unknown.com");
        assert_eq!(header.from.name.as_deref(), Some("Unknown"));
        assert_eq!(header.subject, "");
        assert!(header.to.is_empty());
        assert!(header.cc.is_empty());
        assert!(header.flags.is_empty()); // is_read is None
        assert!(!header.has_attachments);
        assert!(header.date.is_none());
        assert!(header.message_id.is_none());
    }

    #[test]
    fn test_message_with_headers_for_threading() {
        let msg = GraphMessage {
            id: "msg-threaded".to_string(),
            subject: Some("Re: Discussion".to_string()),
            from: Some(GraphEmailAddress {
                email_address: GraphEmail {
                    name: Some("Alice".to_string()),
                    address: Some("alice@outlook.com".to_string()),
                },
            }),
            to_recipients: None,
            bcc_recipients: None,
            cc_recipients: None,
            sent_date_time: None,
            received_date_time: Some("2025-02-01T12:00:00Z".to_string()),
            is_read: Some(false),
            has_attachments: Some(false),
            internet_message_id: Some("<reply-456@outlook.com>".to_string()),
            body: None,
            internet_message_headers: Some(vec![
                GraphHeader {
                    name: "In-Reply-To".to_string(),
                    value: "<original-123@outlook.com>".to_string(),
                },
                GraphHeader {
                    name: "References".to_string(),
                    value: "<root-000@outlook.com> <original-123@outlook.com>".to_string(),
                },
            ]),
        };

        let header = msg.to_email_header(99);

        assert_eq!(
            header.in_reply_to.as_deref(),
            Some("<original-123@outlook.com>")
        );
        let refs = header.references.unwrap();
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0], "<root-000@outlook.com>");
        assert_eq!(refs[1], "<original-123@outlook.com>");

        // is_read false → no \\Seen flag
        assert!(header.flags.is_empty());
    }

    // -- Base URL override ---------------------------------------------------

    #[test]
    fn graph_base_defaults_to_microsoft() {
        assert_eq!(resolve_graph_base(None), "https://graph.microsoft.com/v1.0");
        assert_eq!(resolve_graph_base(Some("")), "https://graph.microsoft.com/v1.0");
    }

    #[test]
    fn graph_base_override_is_honoured_for_loopback_http_only() {
        assert_eq!(resolve_graph_base(Some("http://127.0.0.1:43123/v1.0")), "http://127.0.0.1:43123/v1.0");
        assert_eq!(resolve_graph_base(Some("http://localhost:43123/v1.0/")), "http://localhost:43123/v1.0");
        assert_eq!(resolve_graph_base(Some("http://[::1]:43123/v1.0")), "http://[::1]:43123/v1.0");
        // Every request carries the user's bearer token: anywhere but this
        // machine, and the override would hand it over.
        for hostile in [
            "https://graph.example.com/v1.0",
            "http://graph.example.com/v1.0",
            "http://127.0.0.1.example.com/v1.0",
            "http://127.0.0.1:80@example.com/v1.0",
            "http://localhost@example.com/v1.0",
            "ftp://127.0.0.1/v1.0",
            "not a url",
        ] {
            assert_eq!(resolve_graph_base(Some(hostile)), "https://graph.microsoft.com/v1.0", "{hostile}");
        }
    }
    // -- Storage keys ---------------------------------------------------------

    fn folder(id: &str, display: &str) -> GraphMailFolder {
        serde_json::from_value(serde_json::json!({
            "id": id, "displayName": display, "totalItemCount": 1, "unreadItemCount": 0
        })).unwrap()
    }

    #[test]
    fn parse_well_known_batch_keeps_200s_and_skips_the_rest() {
        let json = serde_json::json!({ "responses": [
            { "id": "inbox", "status": 200, "body": { "id": "fld-inbox" } },
            { "id": "sentitems", "status": 200, "body": { "id": "fld-sent" } },
            { "id": "archive", "status": 404, "body": { "error": { "code": "ErrorItemNotFound" } } },
            { "id": "drafts", "status": 200 }
        ]});
        assert_eq!(
            parse_well_known_batch(&json).unwrap(),
            vec![("inbox".to_string(), "fld-inbox".to_string()), ("sentitems".to_string(), "fld-sent".to_string())]
        );
        assert!(parse_well_known_batch(&serde_json::json!({})).unwrap().is_empty());
    }

    #[test]
    fn parse_well_known_batch_fails_on_a_throttled_or_broken_sub_request() {
        // Graph answers the POST 200 and throttles the sub-requests one by one.
        // Dropping those silently tags nothing, and every folder then keys by
        // display name: the degradation this resolution exists to remove.
        let throttled = serde_json::json!({ "responses": [
            { "id": "inbox", "status": 200, "body": { "id": "fld-inbox" } },
            { "id": "sentitems", "status": 429, "headers": { "Retry-After": "7" } }
        ]});
        // Throttle and breakage are separate variants, because the caller retries
        // the first once and gives up on the second.
        let err = parse_well_known_batch(&throttled).unwrap_err();
        assert_eq!(err, BatchError::Throttled { id: "sentitems".to_string(), retry_after: 7 });
        assert!(
            err.message().contains("(429:retry_after=7)"),
            "carries the throttle marker: {}",
            err.message()
        );

        let broken = serde_json::json!({ "responses": [
            { "id": "inbox", "status": 500, "body": { "error": { "code": "InternalServerError" } } }
        ]});
        match parse_well_known_batch(&broken).unwrap_err() {
            BatchError::Broken(msg) => assert!(msg.contains("inbox") && msg.contains("500"), "{msg}"),
            e => panic!("a 5xx sub-response is not a throttle: {e:?}"),
        }

        // A 429 with no Retry-After still names a wait, so the marker is uniform
        // and the retry has a floor.
        let bare = serde_json::json!({ "responses": [{ "id": "archive", "status": 429 }] });
        assert_eq!(
            parse_well_known_batch(&bare).unwrap_err(),
            BatchError::Throttled { id: "archive".to_string(), retry_after: 1 }
        );

        // A 404 is a mailbox without that folder (no Archive), not a failure.
        let missing = serde_json::json!({ "responses": [
            { "id": "archive", "status": 404 },
            { "id": "inbox", "status": 200, "body": { "id": "fld-inbox" } }
        ]});
        assert_eq!(
            parse_well_known_batch(&missing).unwrap(),
            vec![("inbox".to_string(), "fld-inbox".to_string())]
        );
    }

    #[test]
    fn tag_well_known_matches_by_id_and_counts() {
        let mut folders = vec![folder("fld-sent", "Gesendete Elemente"), folder("fld-proj", "Projekte")];
        let resolved = vec![("sentitems".to_string(), "fld-sent".to_string()), ("archive".to_string(), "fld-none".to_string())];
        assert_eq!(tag_well_known(&mut folders, &resolved), 1);
        assert_eq!(folders[0].well_known_name.as_deref(), Some("sentitems"));
        assert_eq!(folders[1].well_known_name, None);
    }

    #[test]
    fn storage_key_comes_from_the_well_known_name_first() {
        let mut f = folder("fld-sent", "Gesendete Elemente");
        f.well_known_name = Some("sentitems".to_string());
        assert_eq!(storage_key_for(&f), "Sent");
        let mut i = folder("fld-inbox", "Posteingang");
        i.well_known_name = Some("inbox".to_string());
        assert_eq!(storage_key_for(&i), "INBOX");
        for (name, key) in WELL_KNOWN {
            let mut g = folder("x", "anything");
            g.well_known_name = Some(name.to_string());
            assert_eq!(storage_key_for(&g), key);
        }
    }

    #[test]
    fn storage_key_is_the_display_name_for_an_untagged_folder_even_when_it_looks_well_known() {
        // Only the $batch decides which folder is the real Sent. A folder the
        // batch did not name keys as whatever it is called, English or not.
        assert_eq!(storage_key_for(&folder("x", "Sent Items")), "Sent Items");
        assert_eq!(storage_key_for(&folder("y", "deleted items")), "deleted items");
        assert_eq!(storage_key_for(&folder("z", "Projekte")), "Projekte");
    }

    #[test]
    fn retry_after_defaults_to_one_second_and_caps_at_five() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        assert_eq!(retry_after_secs(&h), 1, "no header at all");
        h.insert("retry-after", HeaderValue::from_static("3"));
        assert_eq!(retry_after_secs(&h), 3);
        h.insert("retry-after", HeaderValue::from_static("120"));
        assert_eq!(retry_after_secs(&h), 5, "a long backoff must not stall the listing");
        h.insert("retry-after", HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"));
        assert_eq!(retry_after_secs(&h), 1, "the HTTP-date form is not seconds");
        h.insert("retry-after", HeaderValue::from_static("0"));
        assert_eq!(retry_after_secs(&h), 1, "a zero wait is not a retry, it is a hammer");
    }

    #[test]
    fn assign_storage_keys_fills_every_folder() {
        let mut folders = vec![folder("fld-sent", "Gesendete Elemente"), folder("fld-proj", "Projekte")];
        folders[0].well_known_name = Some("sentitems".to_string());
        assign_storage_keys(&mut folders);
        assert_eq!(folders[0].storage_key, "Sent");
        assert_eq!(folders[1].storage_key, "Projekte");
    }

    #[test]
    fn folder_serializes_the_new_fields_in_camel_case() {
        let mut f = folder("fld-sent", "Gesendete Elemente");
        f.well_known_name = Some("sentitems".to_string());
        f.storage_key = "Sent".to_string();
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["wellKnownName"], "sentitems");
        assert_eq!(v["storageKey"], "Sent");
        // A listing parsed from Graph never carries storageKey; it defaults.
        let parsed: GraphMailFolder = serde_json::from_value(serde_json::json!({
            "id": "a", "displayName": "b", "totalItemCount": 0, "unreadItemCount": 0, "storageKey": "IGNORED"
        })).unwrap();
        assert_eq!(parsed.storage_key, "");
        assert_eq!(parsed.well_known_name, None);
    }

    // -- A send whose connection never opens ---------------------------------

    /// A loopback port whose accept queue is full: nothing accepts, so the
    /// kernel drops the next SYN and a connect to it hangs. `None` where the
    /// system refuses instead (Windows answers a full queue with a reset).
    /// The listener and the connections that fill it must outlive the test.
    async fn hanging_port() -> Option<(std::net::SocketAddr, tokio::net::TcpListener, Vec<std::net::TcpStream>)> {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(1).unwrap();
        let addr = listener.local_addr().unwrap();
        let mut held = Vec::new();
        for _ in 0..64 {
            match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)) {
                Ok(stream) => held.push(stream),
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => return Some((addr, listener, held)),
                Err(_) => return None,
            }
        }
        None
    }

    /// A captive portal or a firewall that drops the packets: the connect to
    /// Graph never opens and nothing is written, so the send could not reach
    /// Microsoft, which may be tried again. The send client's connect timeout
    /// fires first and says so. Without one (the control, the client sends
    /// used before) the request's own timeout fired first, and reqwest called
    /// that a timeout, not a connect: "may have gone out", the end of a
    /// scheduled send. The timeouts are shortened here because macOS gives up
    /// a dropped loopback SYN by itself after about 8 seconds; the real ones
    /// are 20 seconds for the connect and a minute or more for the send.
    #[tokio::test]
    async fn a_send_whose_connection_never_opens_was_not_sent() {
        let Some((addr, _listener, _held)) = hanging_port().await else {
            assert!(!cfg!(target_os = "macos"), "a connect to a full accept queue must hang on macOS");
            eprintln!("skipped: this system refuses a connect to a full accept queue instead of leaving it hanging");
            return;
        };
        let url = format!("http://{addr}/me/sendMail");
        let request_timeout = std::time::Duration::from_secs(5);
        assert!(SEND_CONNECT_TIMEOUT < std::time::Duration::from_secs(60), "the connect must give up before the send does");

        let send = send_client(std::time::Duration::from_millis(1500));
        let err = send.send(send.post(&url).timeout(request_timeout).body("mime")).await.expect_err("nothing accepts");
        let SendMailError::Transport { maybe_sent, detail, .. } = transport_error(err) else { panic!("a transport error") };
        assert!(!maybe_sent, "nothing was written: {detail}");
        assert!(crate::net::looks_like_network_down(&detail), "{detail}");

        let plain = http_client("send", None);
        let err = plain.send(plain.post(&url).timeout(request_timeout).body("mime")).await.expect_err("nothing accepts");
        let control = transport_error(err);
        assert!(matches!(control, SendMailError::Transport { maybe_sent: true, timed_out: true, .. }), "control: {control:?}");
    }
}
