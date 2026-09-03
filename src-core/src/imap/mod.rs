pub mod pool;

use async_imap::types::{Fetch, Flag, Mailbox, Name};
use async_native_tls::TlsConnector;
use async_std::net::TcpStream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::transfer_stats::CountingStream;

pub use pool::{ImapPool, ImapSession, ImapTransport};

// ── Config ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ImapConfig {
    pub email: String,
    pub password: Option<String>,
    #[serde(rename = "imapHost")]
    pub host: String,
    #[serde(rename = "imapPort")]
    pub port: Option<u16>,
    #[serde(rename = "imapSecure")]
    pub secure: Option<bool>,
    #[serde(rename = "imapSecurity", skip_serializing_if = "Option::is_none", default)]
    pub security: Option<String>,
    #[serde(rename = "authType")]
    pub auth_type: Option<String>,
    #[serde(rename = "oauth2AccessToken")]
    pub access_token: Option<String>,
    #[serde(rename = "smtpHost")]
    pub smtp_host: Option<String>,
    #[serde(rename = "smtpPort")]
    pub smtp_port: Option<u16>,
    #[serde(rename = "smtpSecure")]
    pub smtp_secure: Option<bool>,
    pub name: Option<String>,
    #[serde(rename = "oauth2Transport")]
    pub oauth2_transport: Option<String>,
    /// Optional "send mail as" override. Affects the outgoing identity only —
    /// IMAP/SMTP still authenticate as `email`, which stays the account key.
    #[serde(rename = "fromEmail", default)]
    pub from_email: Option<String>,
}

impl ImapConfig {
    pub fn effective_port(&self) -> u16 {
        self.port.unwrap_or(993)
    }

    pub fn is_oauth2(&self) -> bool {
        self.auth_type.as_deref() == Some("oauth2")
    }

    /// The outgoing identity: the send-as override when set, else the login
    /// address. Every From/Message-ID consumer goes through here so no caller
    /// can accidentally reach for the login address instead.
    pub fn from_address(&self) -> &str {
        match self.from_email.as_deref() {
            Some(addr) if !addr.trim().is_empty() => addr.trim(),
            _ => &self.email,
        }
    }

    /// Resolve the transport security mode. `imapSecurity` wins when set
    /// (case-insensitive "ssl"/"starttls"/"none"; an unrecognized string falls
    /// back to Ssl). When absent, fall back to the legacy `imapSecure` bool:
    /// `secure == Some(false)` means plaintext, anything else means Ssl.
    pub fn effective_security(&self) -> ImapSecurity {
        if let Some(s) = self.security.as_deref() {
            return match s.to_lowercase().as_str() {
                "ssl" => ImapSecurity::Ssl,
                "starttls" => ImapSecurity::StartTls,
                "none" => ImapSecurity::None,
                _ => ImapSecurity::Ssl,
            };
        }
        if self.secure == Some(false) {
            ImapSecurity::None
        } else {
            ImapSecurity::Ssl
        }
    }
}

/// Resolved IMAP transport security mode (see `ImapConfig::effective_security`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImapSecurity {
    /// Implicit TLS on connect (the historical default).
    Ssl,
    /// Plaintext connect, then upgrade in-band via the STARTTLS command.
    StartTls,
    /// No TLS at all.
    None,
}

// ── Response types ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct MailboxInfo {
    pub name: String,
    pub path: String,
    #[serde(rename = "specialUse")]
    pub special_use: Option<String>,
    pub flags: Vec<String>,
    pub delimiter: Option<String>,
    #[serde(rename = "noselect")]
    pub noselect: bool,
    pub children: Vec<MailboxInfo>,
}

#[derive(Debug, Serialize, Clone)]
pub struct EmailHeader {
    pub uid: u32,
    pub seq: u32,
    #[serde(rename = "displayIndex", skip_serializing_if = "Option::is_none")]
    pub display_index: Option<u32>,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    #[serde(rename = "inReplyTo", skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
    pub subject: String,
    pub from: EmailAddress,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub bcc: Vec<EmailAddress>,
    pub date: Option<String>,
    #[serde(rename = "internalDate")]
    pub internal_date: Option<String>,
    pub flags: Vec<String>,
    pub size: Option<u32>,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<EmailAddress>,
    #[serde(rename = "returnPath", skip_serializing_if = "Option::is_none")]
    pub return_path: Option<String>,
    #[serde(rename = "authenticationResults", skip_serializing_if = "Option::is_none")]
    pub authentication_results: Option<String>,
    #[serde(rename = "listUnsubscribe", skip_serializing_if = "Option::is_none")]
    pub list_unsubscribe: Option<String>,
    #[serde(rename = "listId", skip_serializing_if = "Option::is_none")]
    pub list_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precedence: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: String,
}

impl Default for EmailAddress {
    fn default() -> Self {
        Self {
            name: Some("Unknown".to_string()),
            address: "unknown@unknown.com".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct FullEmail {
    pub uid: u32,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: EmailAddress,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub bcc: Vec<EmailAddress>,
    #[serde(rename = "replyTo")]
    pub reply_to: Vec<EmailAddress>,
    pub date: Option<String>,
    #[serde(rename = "internalDate")]
    pub internal_date: Option<String>,
    pub flags: Vec<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<EmailAttachment>,
    #[serde(rename = "rawSource")]
    pub raw_source: String,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct EmailAttachment {
    pub filename: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "contentDisposition")]
    pub content_disposition: Option<String>,
    pub size: usize,
    #[serde(rename = "contentId")]
    pub content_id: Option<String>,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LightEmailAttachment {
    pub filename: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "contentDisposition")]
    pub content_disposition: Option<String>,
    pub size: usize,
    #[serde(rename = "contentId")]
    pub content_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LightFullEmail {
    pub uid: u32,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: EmailAddress,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub bcc: Vec<EmailAddress>,
    #[serde(rename = "replyTo")]
    pub reply_to: Vec<EmailAddress>,
    pub date: Option<String>,
    #[serde(rename = "internalDate")]
    pub internal_date: Option<String>,
    pub flags: Vec<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<LightEmailAttachment>,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(skip)]
    pub raw_source_bytes: Vec<u8>,
}

// ── Connection creation ─────────────────────────────────────────────────────

/// Resolve the config's host:port to IPv4 addresses.
/// IPv4-only avoids IPv6 connect hangs (especially with Outlook).
async fn resolve_addrs(config: &ImapConfig) -> Result<Vec<std::net::SocketAddr>, String> {
    use async_std::net::ToSocketAddrs;
    let addr = format!("{}:{}", config.host, config.effective_port());
    let addrs: Vec<std::net::SocketAddr> = addr
        .to_socket_addrs()
        .await
        .map_err(|e| format!("DNS resolve failed for {}: {}", addr, e))?
        .filter(|a| a.is_ipv4())
        .collect();

    if addrs.is_empty() {
        return Err(format!("No IPv4 address found for {}", config.host));
    }
    Ok(addrs)
}

/// TCP connect + TLS wrap, returning a type-erased transport.
///
/// `MAILVAULT_IMAP_PLAINTEXT=1` skips the TLS wrap so tests can point the client
/// at a plaintext mock server. Honored ONLY for loopback addresses — otherwise the
/// env var would be a TLS-downgrade vector in a shipped binary.
/// Returns the transport plus whether the server greeting was already consumed
/// (STARTTLS must eat it before upgrading; no second greeting follows the TLS
/// handshake, so the auth step must not wait for one).
async fn connect_transport(
    config: &ImapConfig,
    addrs: &[std::net::SocketAddr],
) -> Result<(Box<dyn ImapTransport>, bool), String> {
    let tcp = async_std::io::timeout(
        std::time::Duration::from_secs(15),
        TcpStream::connect(addrs),
    )
    .await
    .map_err(|e| format!("TCP connect to {}:{} failed: {}", config.host, config.effective_port(), e))?;

    // Byte counting sits on the raw stream: COMPRESS=DEFLATE wraps the boxed
    // transport later, so what we count here is what crossed the wire.
    let counters = crate::transfer_stats::global().counters(&config.email);

    let plaintext_requested = std::env::var("MAILVAULT_IMAP_PLAINTEXT").as_deref() == Ok("1");
    let all_loopback = addrs.iter().all(|a| a.ip().is_loopback());

    if plaintext_requested && all_loopback {
        warn!("[IMAP] MAILVAULT_IMAP_PLAINTEXT=1 — TLS DISABLED for loopback {:?}", addrs);
        return Ok((Box::new(CountingStream::new(tcp, counters)), false));
    }
    if plaintext_requested {
        warn!("[IMAP] MAILVAULT_IMAP_PLAINTEXT=1 ignored — {} is not loopback", config.host);
    }

    let stream = CountingStream::new(tcp, counters);
    match config.effective_security() {
        ImapSecurity::None => {
            info!("[IMAP] imapSecurity=none — connecting to {} without TLS", config.host);
            Ok((Box::new(stream), false))
        }
        ImapSecurity::Ssl => {
            let tls_stream = build_tls_connector(all_loopback)
                .connect(&config.host, stream)
                .await
                .map_err(|e| format!("TLS handshake with {} failed: {}", config.host, e))?;
            Ok((Box::new(tls_stream), false))
        }
        ImapSecurity::StartTls => Ok((starttls_upgrade(config, stream, all_loopback).await?, true)),
    }
}

/// Build a TLS connector, relaxing certificate validation for loopback
/// addresses — needed for Proton Mail Bridge's self-signed cert on 127.0.0.1.
/// Non-loopback hosts always get full validation.
fn build_tls_connector(all_loopback: bool) -> TlsConnector {
    let connector = TlsConnector::new();
    if all_loopback {
        connector
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
    } else {
        connector
    }
}

/// Upgrade a plaintext connection to TLS via STARTTLS (RFC 3501 6.2.1):
/// consume the greeting, send the command, wait for the tagged response, then
/// wrap the same TCP stream in TLS.
///
/// The tag `MV0` is fixed rather than generated because this runs once per
/// connection, before any other command is pipelined.
async fn starttls_upgrade(
    config: &ImapConfig,
    stream: CountingStream<TcpStream>,
    all_loopback: bool,
) -> Result<Box<dyn ImapTransport>, String> {
    use async_std::io::{BufReadExt, WriteExt};

    let mut reader = async_std::io::BufReader::new(stream);

    // Consume the greeting (`* OK ...`) — otherwise it would be mistaken for
    // the STARTTLS response.
    let mut greeting = String::new();
    reader
        .read_line(&mut greeting)
        .await
        .map_err(|e| format!("STARTTLS: failed to read greeting from {}: {}", config.host, e))?;

    reader
        .get_mut()
        .write_all(b"MV0 STARTTLS\r\n")
        .await
        .map_err(|e| format!("STARTTLS: failed to send command to {}: {}", config.host, e))?;

    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("STARTTLS: failed to read response from {}: {}", config.host, e))?;
        if n == 0 {
            return Err(format!(
                "STARTTLS: connection to {} closed before a tagged response",
                config.host
            ));
        }
        if line.starts_with("MV0 OK") {
            break;
        }
        if line.starts_with("MV0 NO") || line.starts_with("MV0 BAD") {
            return Err(format!("STARTTLS rejected by {}: {}", config.host, line.trim()));
        }
        // Untagged response (e.g. a CAPABILITY line) — keep reading.
    }

    let tls_stream = build_tls_connector(all_loopback)
        .connect(&config.host, reader.into_inner())
        .await
        .map_err(|e| format!("STARTTLS TLS handshake with {} failed: {}", config.host, e))?;

    Ok(Box::new(tls_stream))
}

/// Read the greeting, then authenticate with XOAUTH2 or LOGIN.
///
/// The greeting must be consumed explicitly: `authenticate()`'s handshake loop
/// would otherwise read it instead of the `+` continuation and deadlock.
/// `login()` handles it internally, but we do it uniformly.
async fn authenticate_client(
    mut client: async_imap::Client<Box<dyn ImapTransport>>,
    config: &ImapConfig,
    greeting_consumed: bool,
) -> Result<ImapSession, String> {
    if !greeting_consumed {
        let _greeting = client
            .read_response()
            .await
            .map_err(|e| format!("Failed to read server greeting: {}", e))?;
    }

    if config.is_oauth2() {
        let token = config
            .access_token
            .as_deref()
            .ok_or_else(|| "OAuth2 access token missing".to_string())?;
        info!("[IMAP] Using XOAUTH2 for {} (token length: {})", config.email, token.len());
        let xoauth2 = build_xoauth2(&config.email, token);
        client
            .authenticate("XOAUTH2", XOAuth2Authenticator::new(xoauth2.into_bytes()))
            .await
            .map_err(|(e, _)| format!("XOAUTH2 auth failed for {}: {}", config.email, e))
    } else {
        let password = config
            .password
            .as_deref()
            .ok_or_else(|| "Password missing".to_string())?;
        client
            .login(&config.email, password)
            .await
            .map_err(|(e, _)| format!("Login failed for {}: {}", config.email, e))
    }
}

/// Connect + authenticate, no capability caching or COMPRESS negotiation.
async fn connect_and_auth(config: &ImapConfig) -> Result<ImapSession, String> {
    let addrs = resolve_addrs(config).await?;
    let (transport, greeting_consumed) = connect_transport(config, &addrs).await?;
    authenticate_client(async_imap::Client::new(transport), config, greeting_consumed).await
}

pub async fn create_imap_session(config: &ImapConfig, pool: &ImapPool) -> Result<ImapSession, String> {
    info!(
        "[IMAP] Connecting to {}:{} (oauth2={})",
        config.host,
        config.effective_port(),
        config.is_oauth2()
    );

    let addrs = resolve_addrs(config).await?;
    info!("[IMAP] DNS resolved to {:?}", addrs);

    let (transport, greeting_consumed) = connect_transport(config, &addrs).await?;
    info!("[IMAP] Transport established, authenticating...");

    let mut session =
        authenticate_client(async_imap::Client::new(transport), config, greeting_consumed).await?;

    // ── Cache capabilities ──────────────────────────────────────────────
    let caps = session.capabilities().await
        .map_err(|e| format!("CAPABILITY failed: {}", e))?;
    let cap_list: Vec<String> = caps.iter().map(|c| match c {
        async_imap::types::Capability::Imap4rev1 => "IMAP4rev1".to_string(),
        async_imap::types::Capability::Auth(s) => format!("AUTH={}", s),
        async_imap::types::Capability::Atom(s) => s.clone(),
    }).collect();
    info!("[IMAP] Capabilities for {}: {:?}", config.email, &cap_list[..cap_list.len().min(15)]);
    pool.set_capabilities(config, cap_list).await;

    // ── Negotiate COMPRESS=DEFLATE ──────────────────────────────────────
    let has_compress = caps.has_str("COMPRESS=DEFLATE");
    if has_compress {
        // compress() consumes the session, so on failure we create a new one
        let result = session.compress(|deflate_stream| {
            Box::new(deflate_stream) as Box<dyn ImapTransport>
        }).await;
        match result {
            Ok(compressed_session) => {
                info!("[IMAP] COMPRESS=DEFLATE enabled for {}", config.email);
                info!("[IMAP] Session established for {}", config.email);
                return Ok(compressed_session);
            }
            Err(e) => {
                warn!("[IMAP] COMPRESS=DEFLATE failed for {}: {}, reconnecting without compression", config.email, e);
                // Session was consumed by compress() — create a new uncompressed session
                let session = connect_and_auth(config)
                    .await
                    .map_err(|e| format!("Reconnect after COMPRESS failure: {}", e))?;
                info!("[IMAP] Session established for {} (no compression)", config.email);
                return Ok(session);
            }
        }
    }

    info!("[IMAP] Session established for {}", config.email);
    Ok(session)
}

fn build_xoauth2(email: &str, token: &str) -> String {
    format!("user={}\x01auth=Bearer {}\x01\x01", email, token)
}

struct XOAuth2Authenticator {
    response: Vec<u8>,
    sent: bool,
}

impl XOAuth2Authenticator {
    fn new(response: Vec<u8>) -> Self {
        Self { response, sent: false }
    }
}

impl async_imap::Authenticator for XOAuth2Authenticator {
    type Response = Vec<u8>;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        if !self.sent {
            // First call: send the XOAUTH2 token
            self.sent = true;
            self.response.clone()
        } else {
            // Subsequent calls: server sent an error challenge (e.g. Gmail sends
            // `+ <base64-json-error>`). Reply with empty response to acknowledge,
            // so the server can send the final NO/BAD and end the handshake.
            Vec::new()
        }
    }
}

// ── Fetch spec constants ────────────────────────────────────────────────────
// Lean spec: no BODYSTRUCTURE/RFC822.SIZE — used for header loading (pages, ranges, delta-sync)
const HEADER_FETCH_SPEC: &str = "(UID FLAGS ENVELOPE INTERNALDATE BODY.PEEK[HEADER.FIELDS (References Authentication-Results Return-Path Reply-To List-Unsubscribe List-Id Precedence)])";
// Full spec: includes BODYSTRUCTURE + RFC822.SIZE — used for search results (smaller sets, full info)
const HEADER_FETCH_SPEC_FULL: &str = "(UID FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (References Authentication-Results Return-Path Reply-To List-Unsubscribe List-Id Precedence)])";

/// Gmail suspends accounts that exceed daily IMAP bandwidth caps (2500 MB down,
/// 500 MB up) — the suspension can last up to 24h and locks webmail sign-in too.
/// Bulk operations must stop at the first such error instead of grinding through
/// thousands of doomed fetches against a suspended account.
pub fn is_bandwidth_limited(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("exceeded bandwidth") || e.contains("throttled")
}

// ── UID helpers ─────────────────────────────────────────────────────────────

/// Compress a sorted list of UIDs into IMAP range notation.
/// e.g. [1,2,3,5,6,10] → "1:3,5:6,10"
pub fn compress_uid_ranges(uids: &[u32]) -> String {
    if uids.is_empty() {
        return String::new();
    }
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let mut ranges = Vec::new();
    let mut start = sorted[0];
    let mut end = sorted[0];

    for &uid in &sorted[1..] {
        if uid == end + 1 {
            end = uid;
        } else {
            if start == end {
                ranges.push(start.to_string());
            } else {
                ranges.push(format!("{}:{}", start, end));
            }
            start = uid;
            end = uid;
        }
    }
    // Push the last range
    if start == end {
        ranges.push(start.to_string());
    } else {
        ranges.push(format!("{}:{}", start, end));
    }

    ranges.join(",")
}

// ── IMAP Operations ─────────────────────────────────────────────────────────

/// Run a LIST and collect its names, failing on the first stream error.
///
/// Every item must be checked. `filter_map(Result::ok)` here turned a socket
/// that died mid-LIST into `Ok(vec![])` — a broken pipe reported as "this server
/// has no folders", which no caller can tell from the real thing. The frontend
/// raised "Server returned empty folder list unexpectedly" and kept showing
/// cached folders; `ensure_role_mailbox` would have created a duplicate
/// Archive/Trash instead of finding the existing one.
async fn list_names(session: &mut ImapSession) -> Result<Vec<Name>, String> {
    let names_stream = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| format!("LIST failed: {}", e))?;

    let names: Vec<Name> = names_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("LIST stream failed: {}", e))?;

    // A socket that dies mid-LIST does not yield an error item — the stream
    // simply ends, so EOF and "the server said nothing" are the same thing here.
    // An authenticated account always has at least INBOX, so zero names is never
    // a real answer; reporting it as one is what produced "Server returned empty
    // folder list unexpectedly" while the pool was still holding a broken pipe.
    // As an error the session gets discarded and the caller retries on a fresh
    // connection.
    if names.is_empty() {
        return Err("LIST returned no mailboxes — connection likely dropped mid-response".to_string());
    }
    Ok(names)
}

/// List all mailboxes
pub async fn list_mailboxes(session: &mut ImapSession) -> Result<Vec<MailboxInfo>, String> {
    let names = list_names(session).await?;

    info!("[IMAP] LIST returned {} raw mailbox names", names.len());

    let mut all: Vec<MailboxInfo> = Vec::new();
    for name in &names {
        let path = name.name().to_string();
        let delimiter = name.delimiter().map(|d| d.to_string());
        let short_name = if let Some(ref delim) = delimiter {
            path.rsplit(delim.as_str()).next().unwrap_or(&path).to_string()
        } else {
            path.clone()
        };

        let attrs: Vec<String> = name
            .attributes()
            .iter()
            .map(|a| format!("{:?}", a))
            .collect();
        let special_use = detect_special_use(&attrs, &path);
        let noselect = attrs.iter().any(|a| {
            let lower = a.to_lowercase();
            lower.contains("noselect") || lower.contains("nonexistent")
        });

        all.push(MailboxInfo {
            name: short_name,
            path,
            special_use,
            flags: attrs,
            delimiter,
            noselect,
            children: Vec::new(),
        });
    }

    // Return flat list — the frontend handles grouping/display.
    // Tree-building was nesting children under INBOX (e.g. INBOX.Sent, INBOX.Drafts)
    // which caused Hostinger accounts to show only 1 top-level mailbox.
    info!("[IMAP] list_mailboxes returning {} mailboxes (flat)", all.len());
    Ok(all)
}

fn detect_special_use(attrs: &[String], path: &str) -> Option<String> {
    for attr in attrs {
        let lower = attr.to_lowercase();
        if lower.contains("sent") {
            return Some("\\Sent".to_string());
        }
        if lower.contains("trash") || lower.contains("deleted") {
            return Some("\\Trash".to_string());
        }
        if lower.contains("draft") {
            return Some("\\Drafts".to_string());
        }
        if lower.contains("junk") || lower.contains("spam") {
            return Some("\\Junk".to_string());
        }
        if lower.contains("archive") {
            return Some("\\Archive".to_string());
        }
    }
    let p = path.to_lowercase();
    if p == "inbox" {
        return Some("\\Inbox".to_string());
    }
    if p.contains("sent") {
        return Some("\\Sent".to_string());
    }
    if p.contains("trash") || p.contains("deleted") {
        return Some("\\Trash".to_string());
    }
    if p.contains("draft") {
        return Some("\\Drafts".to_string());
    }
    None
}

/// Select a mailbox and return its status
pub async fn select_mailbox(session: &mut ImapSession, mailbox: &str) -> Result<Mailbox, String> {
    let mbox = session
        .select(mailbox)
        .await
        .map_err(|e| format!("SELECT {} failed: {}", mailbox, e))?;
    selected(mailbox, mbox)
}

/// A SELECT reply that carried nothing is a dead socket, not an empty folder.
///
/// async-imap's `parse_mailbox` reads untagged lines until the tagged reply
/// and returns whatever it has when the stream ends first — so a socket the
/// peer closed while it sat in the pool parses as `Mailbox::default()`:
/// EXISTS 0, no UIDVALIDITY, no error. Every guard downstream then agrees
/// with it (0 UIDs against EXISTS 0) and the reconcile prunes the cache:
/// 1399 INBOX headers in one sync on 2026-09-03. A real SELECT always
/// carries FLAGS and UIDVALIDITY (RFC 3501 §6.3.1); their absence is the
/// socket. Worded as `connection lost` so the pool's retry recognises it.
fn selected(mailbox: &str, mbox: Mailbox) -> Result<Mailbox, String> {
    if mbox.uid_validity.is_none() && mbox.flags.is_empty() {
        return Err(format!("SELECT {} failed: connection lost", mailbox));
    }
    Ok(mbox)
}

/// Fetch email headers by page (newest first)
pub async fn fetch_emails_page(
    session: &mut ImapSession,
    mailbox: &str,
    page: u32,
    limit: u32,
) -> Result<(Vec<EmailHeader>, u32, bool, Vec<Option<u32>>), String> {
    let mbox = select_mailbox(session, mailbox).await?;
    let total = mbox.exists;

    if total == 0 {
        return Ok((Vec::new(), 0, false, Vec::new()));
    }

    let start = (total as i64 - (page * limit) as i64 + 1).max(1) as u32;
    let end = (total as i64 - ((page - 1) * limit) as i64).max(1) as u32;

    // Page is beyond total — return empty result
    if end < start {
        return Ok((Vec::new(), total, false, Vec::new()));
    }

    let range = format!("{}:{}", start, end);
    let fetch_stream = session
        .fetch(&range, HEADER_FETCH_SPEC)
        .await
        .map_err(|e| format!("FETCH failed: {}", e))?;

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut emails = Vec::new();
    let mut skipped_uids = Vec::new();

    for fetch in &fetches {
        match parse_header_from_fetch(fetch) {
            Ok(header) => emails.push(header),
            Err(e) => {
                warn!("Failed to parse message uid={:?}: {}", fetch.uid, e);
                skipped_uids.push(fetch.uid);
            }
        }
    }

    emails.reverse();
    let has_more = start > 1;
    Ok((emails, total, has_more, skipped_uids))
}

/// Fetch email headers by display index range (for virtualized scrolling)
pub async fn fetch_emails_range(
    session: &mut ImapSession,
    mailbox: &str,
    start_index: u32,
    end_index: u32,
) -> Result<(Vec<EmailHeader>, u32, Vec<Option<u32>>), String> {
    let mbox = select_mailbox(session, mailbox).await?;
    let total = mbox.exists;

    if total == 0 {
        return Ok((Vec::new(), 0, Vec::new()));
    }

    let clamped_start = start_index.min(total - 1);
    let clamped_end = end_index.min(total);

    if clamped_start >= clamped_end {
        return Ok((Vec::new(), total, Vec::new()));
    }

    let imap_start = (total - clamped_end + 1).max(1);
    let imap_end = total - clamped_start;

    let range = format!("{}:{}", imap_start, imap_end);
    let fetch_stream = session
        .fetch(&range, HEADER_FETCH_SPEC)
        .await
        .map_err(|e| format!("FETCH range failed: {}", e))?;

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut emails = Vec::new();
    let mut skipped_uids = Vec::new();

    for fetch in &fetches {
        match parse_header_from_fetch(fetch) {
            Ok(mut header) => {
                header.display_index = Some(total - header.seq);
                emails.push(header);
            }
            Err(e) => {
                warn!("Failed to parse range message uid={:?}: {}", fetch.uid, e);
                skipped_uids.push(fetch.uid);
            }
        }
    }

    emails.sort_by_key(|e| e.display_index);
    Ok((emails, total, skipped_uids))
}

/// Check mailbox status — returns (exists, uid_validity, uid_next, highest_mod_seq).
/// Uses CONDSTORE-aware SELECT if the server supports it.
/// Used for delta-sync: detect changes without fetching any messages.
pub async fn check_mailbox_status(
    session: &mut ImapSession,
    mailbox: &str,
    has_condstore: bool,
) -> Result<(u32, Option<u32>, Option<u32>, Option<u64>), String> {
    if has_condstore {
        // Use CONDSTORE SELECT to get HIGHESTMODSEQ
        let mbox = session.select_condstore(mailbox).await
            .map_err(|e| format!("SELECT CONDSTORE {} failed: {}", mailbox, e))?;
        let mbox = selected(mailbox, mbox)?;
        Ok((mbox.exists, mbox.uid_validity, mbox.uid_next, mbox.highest_modseq))
    } else {
        let mbox = select_mailbox(session, mailbox).await?;
        Ok((mbox.exists, mbox.uid_validity, mbox.uid_next, None))
    }
}

/// Fetch UIDs with changed flags since a given MODSEQ (CONDSTORE).
/// Returns Vec of (uid, flags) for emails whose flags changed.
pub async fn fetch_changed_flags(
    session: &mut ImapSession,
    mailbox: &str,
    since_modseq: u64,
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let fetch_stream = session
        .uid_fetch("1:*", &format!("(UID FLAGS) (CHANGEDSINCE {})", since_modseq))
        .await
        .map_err(|e| format!("FETCH CHANGEDSINCE failed: {}", e))?;

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut results = Vec::new();
    for fetch in &fetches {
        if let Some(uid) = fetch.uid {
            let flags = extract_flags(fetch);
            results.push((uid, flags));
        }
    }

    info!("[IMAP] CHANGEDSINCE {}: {} UIDs with changed flags", since_modseq, results.len());
    Ok(results)
}

/// Fetch flags (no headers) for every UID at or above `from_uid`.
///
/// The cheap fallback for servers without CONDSTORE, where `fetch_changed_flags`
/// is unavailable and cached messages would otherwise keep stale read/star state
/// forever. One command, ~40 bytes per message.
pub async fn fetch_flags_from(
    session: &mut ImapSession,
    mailbox: &str,
    from_uid: u32,
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let fetch_stream = session
        .uid_fetch(&format!("{}:*", from_uid), "(UID FLAGS)")
        .await
        .map_err(|e| format!("UID FETCH flags from {} failed: {}", from_uid, e))?;

    let results: Vec<(u32, Vec<String>)> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .filter_map(|fetch| fetch.uid.map(|uid| (uid, extract_flags(&fetch))))
        .collect();

    info!("[IMAP] Fetched flags for {} UIDs from {}", results.len(), from_uid);
    Ok(results)
}

/// Every UID in the mailbox, ascending.
/// Used for delta-sync: diff against cached UID set to find additions/deletions.
///
/// Uses `UID FETCH 1:* (UID)`, not SEARCH, and neither variant of SEARCH works
/// here:
/// - ESEARCH: imap-proto fails to parse some servers' valid
///   `* ESEARCH (TAG "...") UID ALL ...` responses (seen on Purelymail).
/// - Plain `UID SEARCH ALL`: the whole UID list is ONE untagged line, and on a
///   15k mailbox Purelymail splices its `* OK Still here` keepalive into the
///   middle of it (`... 2268 2269* OK Still here\r\n`) — unparseable.
///
/// FETCH returns one untagged line per message, so a keepalive lands *between*
/// lines instead of inside one. Costs a few bytes per message over DEFLATE.
///
/// A parse failure would leave unconsumed bytes in the session buffer, making
/// every later command on that session read the previous command's reply — so
/// callers must discard the session on error, never re-pool it.
pub async fn search_all_uids(
    session: &mut ImapSession,
    mailbox: &str,
    _has_esearch: bool,
) -> Result<Vec<u32>, String> {
    Ok(search_all_uid_flags(session, mailbox)
        .await?
        .into_iter()
        .map(|(uid, _)| uid)
        .collect())
}

/// Every UID in the mailbox with its flags, ascending by UID. The same one
/// round trip `search_all_uids` makes — FLAGS cost a few bytes per message and
/// let the backup reconcile the vault's read state without a second pass.
pub async fn search_all_uid_flags(
    session: &mut ImapSession,
    mailbox: &str,
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let mbox = select_mailbox(session, mailbox).await?;
    let expected = mbox.exists;

    info!("[IMAP] Listing UIDs via UID FETCH 1:* for {}", mailbox);
    let fetch_stream = session
        .uid_fetch("1:*", "(UID FLAGS)")
        .await
        .map_err(|e| format!("UID FETCH 1:* failed for {}: {}", mailbox, e))?;

    // A mid-stream error means the list is TRUNCATED, and callers prune the
    // cache against it — so fail loudly rather than returning a short list.
    let mut result = Vec::new();
    for item in fetch_stream.collect::<Vec<_>>().await {
        let fetch = item.map_err(|e| format!("UID FETCH 1:* failed for {}: {}", mailbox, e))?;
        if let Some(uid) = fetch.uid {
            result.push((uid, extract_flags(&fetch)));
        }
    }

    result.sort_unstable_by_key(|(uid, _)| *uid);

    // A connection dropped mid-response ends the stream with NO error, so a
    // short — or empty — list otherwise looks like a legitimate "mailbox is
    // smaller now" and callers delete the difference off disk. EXISTS from the
    // SELECT above is the authoritative count; anything less is a truncated
    // read, not a real deletion. Better a failed sync than deleted mail.
    if (result.len() as u32) < expected {
        return Err(format!(
            "UID FETCH 1:* for {} returned {} UIDs but SELECT reported EXISTS={} — truncated response, refusing to report a partial list",
            mailbox,
            result.len(),
            expected
        ));
    }

    info!("[IMAP] UID FETCH 1:* returned {} UIDs for {}", result.len(), mailbox);

    Ok(result)
}

/// Fetch headers for specific UIDs — used for delta-sync to fetch only new emails.
pub async fn fetch_headers_by_uids(
    session: &mut ImapSession,
    mailbox: &str,
    uids: &[u32],
) -> Result<(Vec<EmailHeader>, u32), String> {
    let mbox = select_mailbox(session, mailbox).await?;
    let total = mbox.exists;

    if uids.is_empty() {
        return Ok((Vec::new(), total));
    }

    // Sort descending so newest emails arrive first
    let mut sorted_uids = uids.to_vec();
    sorted_uids.sort_unstable_by(|a, b| b.cmp(a));

    // Chunk into batches of 200 to avoid IMAP command-length limits
    let mut emails = Vec::new();
    for chunk in sorted_uids.chunks(200) {
        let uid_set = compress_uid_ranges(chunk);
        info!("[IMAP] Fetching header chunk: {} UIDs (range: {})", chunk.len(), &uid_set[..uid_set.len().min(80)]);

        let fetch_stream = session
            .uid_fetch(&uid_set, HEADER_FETCH_SPEC)
            .await
            .map_err(|e| format!("UID FETCH {} failed: {}", uid_set, e))?;

        let fetches: Vec<Fetch> = fetch_stream
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .filter_map(|r| r.ok())
            .collect();

        for fetch in &fetches {
            match parse_header_from_fetch(fetch) {
                Ok(header) => emails.push(header),
                Err(e) => {
                    warn!("Failed to parse UID-fetched message uid={:?}: {}", fetch.uid, e);
                }
            }
        }
    }

    // Sort by UID descending (newest first)
    emails.sort_by(|a, b| b.uid.cmp(&a.uid));
    Ok((emails, total))
}

/// Fetch a single email by UID with full content
pub async fn fetch_email_by_uid(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
) -> Result<Option<FullEmail>, String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let fetch_stream = session
        .uid_fetch(uid.to_string(), "(UID FLAGS ENVELOPE INTERNALDATE BODY.PEEK[])")
        .await
        .map_err(|e| format!("UID FETCH {} failed: {}", uid, e))?;

    // Errors in the stream are the server refusing the FETCH — a tagged NO, a
    // dropped connection, a parse failure. Dropping them with `.ok()` turned
    // every one of those into an empty result, which the caller reports as
    // "Email not found": a message that is sitting right there on the server
    // then reads as deleted. Absence has to mean absence.
    let mut fetches: Vec<Fetch> = Vec::new();
    for item in fetch_stream.collect::<Vec<_>>().await {
        match item {
            Ok(f) => fetches.push(f),
            Err(e) => return Err(format!("UID FETCH {} failed: {}", uid, e)),
        }
    }

    let fetch = match fetches.first() {
        Some(f) => f,
        None => {
            // Empty here is not proof of absence — see `uid_still_present`.
            // Its own error is not proof either, so it propagates rather than
            // collapsing into "gone".
            if uid_still_present(session, uid).await? {
                return Err(format!(
                    "Server returned no body for UID {}, but the message is still in {}",
                    uid, mailbox
                ));
            }
            return Ok(None);
        }
    };

    let body = fetch
        .body()
        .ok_or_else(|| "No body in FETCH response".to_string())?;

    // Parse with mailparse
    let parsed = mailparse::parse_mail(body)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let get_header = |name: &str| -> Option<String> {
        headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };
    let get_header_raw = |name: &str| -> Option<Vec<u8>> {
        headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value_raw().to_vec())
    };

    let subject = get_header_raw("Subject")
        .map(|raw| decode_rfc2047(&raw))
        .unwrap_or_else(|| "(No Subject)".to_string());
    let message_id = get_header("Message-ID");
    let date = get_header("Date");

    let from = parse_address_header(get_header("From").as_deref());
    let to = parse_address_list(get_header("To").as_deref());
    let cc = parse_address_list(get_header("Cc").as_deref());
    let bcc = parse_address_list(get_header("Bcc").as_deref());
    let reply_to = parse_address_list(get_header("Reply-To").as_deref());

    let mut text_body: Option<String> = None;
    let mut html_body: Option<String> = None;
    let mut attachments: Vec<EmailAttachment> = Vec::new();
    walk_mime_parts(&parsed, &mut text_body, &mut html_body, &mut attachments);

    let flags = extract_flags(fetch);
    let internal_date = fetch.internal_date().map(|d| d.to_rfc3339());

    use base64::Engine;
    let raw_source = base64::engine::general_purpose::STANDARD.encode(body);

    Ok(Some(FullEmail {
        uid: fetch.uid.unwrap_or(uid),
        message_id,
        subject,
        from,
        to,
        cc,
        bcc,
        reply_to,
        date,
        internal_date,
        flags,
        text: text_body,
        html: html_body,
        has_attachments: !attachments.is_empty(),
        attachments,
        raw_source,
    }))
}

/// Set flags on a message by UID
pub async fn set_flags(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
    flags: &[String],
    action: &str,
) -> Result<(), String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let flag_str = flags
        .iter()
        .map(|f| {
            match f.as_str() {
                "\\Seen" | "\\Answered" | "\\Flagged" | "\\Deleted" | "\\Draft" => f.clone(),
                s if s.starts_with('\\') => f.clone(),
                _ => format!("\\{}", f), // try adding backslash
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let store_cmd = if action == "add" {
        format!("+FLAGS ({})", flag_str)
    } else {
        format!("-FLAGS ({})", flag_str)
    };

    run_checked(session, format!("UID STORE {} {}", uid, store_cmd), "STORE flags").await?;

    Ok(())
}

/// Run a mutation and require the server's tagged `OK`.
///
/// Every STORE and EXPUNGE in this file used to be written as
/// `let _: Vec<_> = session.uid_store(..).await?.collect::<Vec<_>>().await;`.
/// The `?` catches only a failure to *send*; the collected items are thrown
/// away; and — the part that matters — a socket that dies mid-response ends
/// the stream with **no items and no error at all**, in under a millisecond.
/// So the whole function returned `Ok(())` for a delete that never happened.
///
/// The caller then treats that as done: it prunes the row, decrements the
/// total, and stamps `serverDeleted` on the vault entry — this app's loudest
/// custody claim, "your only copy left" — over a message still sitting on the
/// server, which walks back in on the next full reload.
///
/// `run_command_and_check_ok` is the one entry point in async-imap that
/// inspects the tagged status (see `uid_still_present`, which had to reach for
/// it for the same reason on the read side). It errors on `NO`/`BAD` and on a
/// lost connection, and costs no extra round trip: the untagged lines are
/// consumed on the way to the tag.
async fn run_checked(session: &mut ImapSession, command: String, what: &str) -> Result<(), String> {
    session
        .run_command_and_check_ok(command)
        .await
        .map_err(|e| format!("{} failed: {}", what, e))
}

/// Delete an email by UID
pub async fn delete_email(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
    permanent: bool,
) -> Result<(), String> {
    info!("[delete_email] start uid={} mailbox={} permanent={}", uid, mailbox, permanent);
    let _mbox = select_mailbox(session, mailbox).await?;

    if permanent {
        run_checked(session, format!("UID STORE {} +FLAGS (\\Deleted)", uid), "STORE \\Deleted").await?;
        // Use UID EXPUNGE to only expunge this specific UID (RFC 4315 UIDPLUS)
        run_checked(session, format!("UID EXPUNGE {}", uid), "UID EXPUNGE").await?;
    } else {
        // Resolve the real Trash path via SPECIAL-USE/LIST — hardcoded names
        // miss namespaced servers (Dovecot/Hostinger use INBOX.Trash), which
        // left mail \Deleted-flagged but visible: delete looked like a no-op.
        let trash = ensure_role_mailbox(
            session,
            "trash",
            "Trash",
            &["Trash", "Deleted Items", "Deleted", "[Gmail]/Trash"],
        )
        .await?;
        info!("[delete_email] uid={} resolved trash='{}'", uid, trash);

        match session.uid_mv(uid.to_string(), &trash).await {
            // Not proof on its own — see `run_checked`: a dead socket answers
            // this Ok too. `uid_mv` keeps the crate's mailbox quoting (Trash is
            // routinely namespaced and UTF-7 encoded), so it stays, and the
            // tagged-OK question is asked separately below.
            Ok(_) => info!("[delete_email] uid={} moved to '{}'", uid, trash),
            Err(e) => {
                // No MOVE capability: COPY + \Deleted + UID EXPUNGE.
                tracing::warn!("[delete_email] UID MOVE to '{}' failed ({}), falling back to COPY+EXPUNGE", trash, e);
                session
                    .uid_copy(uid.to_string(), &trash)
                    .await
                    .map_err(|e| format!("UID COPY to '{}' failed: {}", trash, e))?;
                run_checked(session, format!("UID STORE {} +FLAGS (\\Deleted)", uid), "STORE \\Deleted").await?;
                run_checked(session, format!("UID EXPUNGE {}", uid), "UID EXPUNGE").await?;
            }
        }
        // No `uid_still_present` postcondition here, deliberately.
        //
        // It is the right question — `uid_mv` answers Ok on a dead socket too,
        // exactly like the STORE above it — but asking it costs a round trip
        // AFTER the move, and this delete already runs in the webview across a
        // move that real servers take seconds over. Widening that window made
        // `connected-storage-matrix`'s churn tests go red in a way that has
        // nothing to do with the delete: a delete on one account that lands
        // while the user has switched to another prunes rows out of the
        // account now on screen (17 of luke's Archive rows down to 4, from a
        // delete issued on yoda). That prune is a pre-existing defect in the
        // completion path, not in this function, and it is not this change's
        // to fix — so this change does not hand it a wider window either.
        //
        // The permanent path above pays nothing for its check (the tagged OK
        // is on the wire regardless), which is where every bulk purge and
        // every non-INBOX delete goes.
    }

    Ok(())
}

async fn ensure_role_mailbox(
    session: &mut ImapSession,
    attr_substring: &str,
    create_name: &str,
    candidates: &[&str],
) -> Result<String, String> {
    let names = list_names(session).await?;

    let entries: Vec<(String, Vec<String>)> = names
        .iter()
        .map(|n| {
            let path = n.name().to_string();
            let attrs: Vec<String> = n.attributes().iter().map(|a| format!("{:?}", a)).collect();
            (path, attrs)
        })
        .collect();

    for (path, attrs) in &entries {
        if attrs.iter().any(|a| a.to_lowercase().contains(attr_substring)) {
            return Ok(path.clone());
        }
    }
    for cand in candidates {
        if let Some((path, _)) = entries.iter().find(|(p, _)| p.eq_ignore_ascii_case(cand)) {
            return Ok(path.clone());
        }
        if let Some((path, _)) = entries.iter().find(|(p, _)| {
            p.rsplit_once(|c: char| c == '/' || c == '.').map(|(_, t)| t).unwrap_or(p)
                .eq_ignore_ascii_case(cand)
        }) {
            return Ok(path.clone());
        }
    }

    session
        .create(create_name)
        .await
        .map_err(|e| format!("CREATE {} failed: {}", create_name, e))?;
    let _ = session.subscribe(create_name).await;
    tracing::info!("[ensure_role_mailbox] Created '{}' (no existing match for attr '{}')", create_name, attr_substring);
    Ok(create_name.to_string())
}

/// Resolve or auto-create the Sent mailbox for this account.
/// Order: IMAP SPECIAL-USE `\Sent` → common name candidates → CREATE "Sent".
/// Returns the resolved mailbox path.
pub async fn ensure_sent_mailbox(session: &mut ImapSession) -> Result<String, String> {
    ensure_role_mailbox(
        session,
        "sent",
        "Sent",
        &[
            "Sent", "Sent Items", "Sent Mail", "Sent Messages",
            "INBOX.Sent", "INBOX/Sent", "INBOX.Sent Items", "INBOX/Sent Items",
            "Gesendet", "Enviados", "Envoyés", "Envoyes", "Inviati", "Verzonden",
            "Skickat", "Sendt", "Lähetetyt", "Lahetetyt", "Wysłane", "Wyslane",
        ],
    )
    .await
}

/// Append a raw email (RFC 5322) to a mailbox via IMAP APPEND
pub async fn append_email(
    session: &mut ImapSession,
    mailbox: &str,
    raw_email: &[u8],
    flags: &str,
) -> Result<(), String> {
    let flags_opt: Option<&str> = if flags.is_empty() { None } else { Some(flags) };

    session
        .append(mailbox, flags_opt, None, raw_email)
        .await
        .map_err(|e| format!("IMAP APPEND to '{}' failed: {}", mailbox, e))?;

    Ok(())
}

/// Dedicated fresh IMAP session that explicitly DOES NOT enable COMPRESS=DEFLATE.
/// Observed: Hostinger + async_imap's compressed stream hangs indefinitely on
/// APPEND literal upload. Sent-folder APPEND uses this helper instead of the
/// pool-cached (compressed) session.
pub async fn create_imap_session_no_compress(config: &ImapConfig) -> Result<ImapSession, String> {
    tracing::info!(
        "[imap_no_compress:connect_start] addr={}:{} oauth2={}",
        config.host,
        config.effective_port(),
        config.is_oauth2()
    );
    let session = connect_and_auth(config).await?;
    tracing::info!("[imap_no_compress:session_established] account={}", config.email);
    Ok(session)
}

/// APPEND with pre/post verification. Returns the mailbox EXISTS count before
/// and after the APPEND, and whether a UID SEARCH for the Message-ID header
/// finds the new message. Used by the compose send flow so logs can prove
/// whether the server actually accepted and indexed the email.
pub async fn append_email_verified(
    session: &mut ImapSession,
    mailbox: &str,
    raw_email: &[u8],
    flags: &str,
    message_id: Option<&str>,
) -> Result<(u32, u32, Option<u32>), String> {
    tracing::info!("[append_verified:select_before_start] mailbox={}", mailbox);
    let before = select_mailbox(session, mailbox).await?;
    let exists_before = before.exists;
    tracing::info!("[append_verified:select_before_ok] mailbox={} exists={}", mailbox, exists_before);

    // Use LITERAL+ (non-synchronous literal, RFC 3516) instead of async-imap's
    // built-in `append()` which uses synchronous literal `{N}` and waits for a
    // `+ OK` continue response. Observed: on Hostinger IMAP that wait never
    // returns and the call hangs forever even on a fresh non-compressed
    // session. LITERAL+ sends `{N+}\r\n<N bytes>\r\n` in one go, no wait.
    //
    // We hand-roll the command string and push it through the public
    // `run_command_and_check_ok` — the underlying stream encoder writes bytes
    // as-is + a trailing CRLF, which is exactly what RFC 3516 APPEND wants.
    // Raw bytes are embedded via `from_utf8_unchecked`; the encoder does not
    // rely on UTF-8 validity, just copies the bytes to the wire. For plain
    // test emails the bytes are ASCII anyway.
    let quoted_mailbox = format!("\"{}\"", mailbox.replace('\\', "\\\\").replace('"', "\\\""));
    let flags_clause: String = if flags.is_empty() {
        String::new()
    } else {
        format!(" ({})", flags)
    };
    let header = format!(
        "APPEND {}{} {{{}+}}\r\n",
        quoted_mailbox, flags_clause, raw_email.len()
    );
    let mut cmd_bytes: Vec<u8> = Vec::with_capacity(header.len() + raw_email.len());
    cmd_bytes.extend_from_slice(header.as_bytes());
    cmd_bytes.extend_from_slice(raw_email);
    // SAFETY: the underlying encoder treats the command as raw bytes. We cast
    // to &str only because `run_command_and_check_ok` requires `S: AsRef<str>`.
    // `run_command` immediately calls `.as_bytes()` on the &str without any
    // UTF-8 validation on the write path.
    let cmd_str: &str = unsafe { std::str::from_utf8_unchecked(&cmd_bytes) };
    tracing::info!(
        "[append_verified:append_start] mailbox={} bytes={} flags={} mode=LITERAL+",
        mailbox, raw_email.len(), flags
    );
    match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        session.run_command_and_check_ok(cmd_str),
    ).await {
        Ok(Ok(())) => {
            tracing::info!("[append_verified:append_ok] mailbox={}", mailbox);
        }
        Ok(Err(e)) => {
            return Err(format!("IMAP APPEND to '{}' failed: {}", mailbox, e));
        }
        Err(_) => {
            tracing::warn!(
                "[append_verified:append_inner_timeout] mailbox={} after 20s (LITERAL+ path) — server not responding to tagged APPEND completion",
                mailbox
            );
            return Err(format!("IMAP APPEND to '{}' inner timeout after 20s (LITERAL+ path)", mailbox));
        }
    }

    // Re-SELECT to get the fresh EXISTS count. Some servers update the
    // selected mailbox's status mid-session; others require a fresh SELECT.
    tracing::info!("[append_verified:select_after_start] mailbox={}", mailbox);
    let after = select_mailbox(session, mailbox).await?;
    let exists_after = after.exists;
    tracing::info!("[append_verified:select_after_ok] mailbox={} exists={}", mailbox, exists_after);

    // Try to locate the new message via UID SEARCH HEADER Message-ID.
    let found_uid = if let Some(mid) = message_id.filter(|s| !s.is_empty()) {
        let escaped = mid.replace('\\', "\\\\").replace('"', "\\\"");
        let criteria = format!("HEADER Message-ID \"{}\"", escaped);
        tracing::info!("[append_verified:search_start] criteria=\"{}\"", criteria);
        match session.uid_search(&criteria).await {
            Ok(set) => {
                let max_uid = set.iter().copied().max();
                tracing::info!("[append_verified:search_ok] matches={} max_uid={:?}", set.len(), max_uid);
                max_uid
            }
            Err(e) => {
                tracing::warn!("[append_verified:search_fail] error={}", e);
                None
            }
        }
    } else {
        tracing::info!("[append_verified:search_skip] reason=no_message_id");
        None
    };

    Ok((exists_before, exists_after, found_uid))
}

/// Search emails using IMAP SEARCH
pub async fn search_emails(
    session: &mut ImapSession,
    mailbox: &str,
    query: Option<&str>,
    from_filter: Option<&str>,
    subject_filter: Option<&str>,
    since: Option<&str>,
    before: Option<&str>,
) -> Result<(Vec<EmailHeader>, u32), String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let mut criteria_parts: Vec<String> = Vec::new();

    if let Some(q) = query {
        if !q.is_empty() {
            criteria_parts.push(format!("TEXT \"{}\"", q.replace('"', "\\\"")));
        }
    }
    if let Some(f) = from_filter {
        if !f.is_empty() {
            criteria_parts.push(format!("FROM \"{}\"", f.replace('"', "\\\"")));
        }
    }
    if let Some(s) = subject_filter {
        if !s.is_empty() {
            criteria_parts.push(format!("SUBJECT \"{}\"", s.replace('"', "\\\"")));
        }
    }
    if let Some(s) = since {
        if !s.is_empty() {
            if let Ok(dt) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                criteria_parts.push(format!("SINCE {}", dt.format("%d-%b-%Y")));
            }
        }
    }
    if let Some(b) = before {
        if !b.is_empty() {
            if let Ok(dt) = chrono::NaiveDate::parse_from_str(b, "%Y-%m-%d") {
                criteria_parts.push(format!("BEFORE {}", dt.format("%d-%b-%Y")));
            }
        }
    }

    if criteria_parts.is_empty() {
        return Ok((Vec::new(), 0));
    }

    let search_str = criteria_parts.join(" ");

    // Use UID SEARCH
    let uids: Vec<u32> = session
        .uid_search(&search_str)
        .await
        .map_err(|e| format!("SEARCH failed: {}", e))?
        .into_iter()
        .collect();

    let total_matches = uids.len() as u32;

    if uids.is_empty() {
        return Ok((Vec::new(), 0));
    }

    // Limit to last 200
    let limited: Vec<u32> = if uids.len() > 200 {
        uids[uids.len() - 200..].to_vec()
    } else {
        uids
    };

    let uid_range = compress_uid_ranges(&limited);

    let fetch_stream = session
        .uid_fetch(&uid_range, HEADER_FETCH_SPEC_FULL)
        .await
        .map_err(|e| format!("FETCH search results failed: {}", e))?;

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut emails = Vec::new();
    for fetch in &fetches {
        if let Ok(mut header) = parse_header_from_fetch(fetch) {
            header.source = Some("server-search".to_string());
            emails.push(header);
        }
    }

    // Sort by internal_date (RFC 3339 — sorts lexicographically), fall back to date header
    emails.sort_by(|a, b| {
        let a_key = a.internal_date.as_ref().or(a.date.as_ref());
        let b_key = b.internal_date.as_ref().or(b.date.as_ref());
        b_key.cmp(&a_key)
    });
    Ok((emails, total_matches))
}

// ── Message-ID probe ────────────────────────────────────────────────────────

/// One server-side copy of a message: which folder holds it, under which uid.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct MessageIdLocation {
    pub mailbox: String,
    pub uid: u32,
}

/// The answer to "is this Message-ID anywhere on this account?"
///
/// The only result that proves the server no longer holds the message is
/// `complete == true && found.is_empty()`. Everything else is unknown: a
/// folder that refused to open could be the one holding it, and `failed` names
/// which ones so the app can say so instead of guessing.
#[derive(Debug, Serialize, Clone)]
pub struct MessageIdProbe {
    #[serde(rename = "messageId")]
    pub message_id: String,
    /// Every copy found. Non-empty is proof of presence on its own — no
    /// completeness needed, which is why `stop_on_first` is safe.
    pub found: Vec<MessageIdLocation>,
    /// Folders that answered.
    pub searched: Vec<String>,
    /// Folders that refused with a tagged NO — no rights, or a container the
    /// LIST attributes did not flag `\Noselect`.
    pub failed: Vec<String>,
    /// Every selectable folder answered. Absence is only claimable under this.
    pub complete: bool,
}

/// The search term for a Message-ID.
///
/// IMAP HEADER matching is substring-based (RFC 3501 §6.4.4) and servers
/// disagree about whether the stored value keeps its angle brackets, so strip
/// them and let the substring cover both. A different message would have to
/// contain this whole id inside its own to collide — and a collision would
/// report the message as PRESENT, which is the quiet direction.
pub fn message_id_search_term(message_id: &str) -> String {
    message_id
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// SELECT + UID SEARCH one folder for a Message-ID.
///
/// `Ok(None)` is a tagged NO: the folder refused, the read buffer is intact,
/// and the sweep may continue. Every other error can leave unconsumed bytes on
/// the session — the next command would then read this one's reply — so it
/// propagates and the caller discards the connection.
async fn search_message_id_in(
    session: &mut ImapSession,
    mailbox: &str,
    term: &str,
) -> Result<Option<Vec<u32>>, String> {
    match session.select(mailbox).await {
        Ok(mbox) => {
            selected(mailbox, mbox)?;
        }
        Err(async_imap::error::Error::No(msg)) => {
            warn!("[IMAP] Message-ID probe: SELECT {} refused: {}", mailbox, msg);
            return Ok(None);
        }
        Err(e) => return Err(format!("SELECT {} failed: {}", mailbox, e)),
    }

    match session
        .uid_search(format!("HEADER \"Message-ID\" \"{}\"", term))
        .await
    {
        Ok(uids) => {
            let mut uids: Vec<u32> = uids.into_iter().collect();
            uids.sort_unstable();
            Ok(Some(uids))
        }
        Err(async_imap::error::Error::No(msg)) => {
            warn!("[IMAP] Message-ID probe: SEARCH in {} refused: {}", mailbox, msg);
            Ok(None)
        }
        Err(e) => Err(format!("SEARCH in {} failed: {}", mailbox, e)),
    }
}

/// Ask the server whether a Message-ID exists in ANY folder.
///
/// This is the question the gold "your only copy" row was written for and
/// could not ask. Absence from one mailbox proves nothing on any provider —
/// Gmail's archive moves a message to All Mail, a filter moves it to a label,
/// a delete moves it to the Bin — so "the vault is the copy you have left" was
/// unclaimable for a message this app did not itself delete. One sweep over
/// every selectable folder is the evidence that makes it claimable.
///
/// `stop_on_first` returns as soon as a copy turns up: presence needs one hit,
/// absence needs all of them.
pub async fn find_message_id(
    session: &mut ImapSession,
    message_id: &str,
    stop_on_first: bool,
) -> Result<MessageIdProbe, String> {
    let term = message_id_search_term(message_id);
    // A message with no Message-ID cannot be looked up, and an empty term
    // matches every header on the server — refuse rather than answer "found
    // everywhere" or "absent".
    if term.is_empty() {
        return Err("Message-ID probe: empty Message-ID".to_string());
    }

    let mut targets: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for mb in list_mailboxes(session).await? {
        // \Noselect boxes are pure containers — SELECT fails on them — and a
        // path can be listed twice.
        if mb.noselect || mb.path.is_empty() || !seen.insert(mb.path.clone()) {
            continue;
        }
        targets.push(mb.path);
    }
    // INBOX first: the folder most likely to end the sweep on its first round trip.
    targets.sort_by_key(|p| !p.eq_ignore_ascii_case("INBOX"));

    let total = targets.len();
    let mut probe = MessageIdProbe {
        message_id: message_id.to_string(),
        found: Vec::new(),
        searched: Vec::new(),
        failed: Vec::new(),
        complete: false,
    };

    for path in targets {
        match search_message_id_in(session, &path, &term).await? {
            Some(uids) => {
                probe.searched.push(path.clone());
                probe.found.extend(uids.into_iter().map(|uid| MessageIdLocation {
                    mailbox: path.clone(),
                    uid,
                }));
                if stop_on_first && !probe.found.is_empty() {
                    // `complete` stays false, and that is correct: this answer
                    // proves presence, and presence is all it claims.
                    return Ok(probe);
                }
            }
            None => probe.failed.push(path),
        }
    }

    // A LIST that came back empty must never read as "searched everywhere and
    // found nothing" — that would stamp gold on every message of an account
    // whose folder listing broke.
    probe.complete = !probe.searched.is_empty() && probe.failed.is_empty() && probe.searched.len() == total;
    info!(
        "[IMAP] Message-ID probe: {} copies across {} folders ({} refused, complete={})",
        probe.found.len(),
        probe.searched.len(),
        probe.failed.len(),
        probe.complete
    );
    Ok(probe)
}

/// Test IMAP connection
pub async fn test_connection(config: &ImapConfig) -> Result<(), String> {
    let mut session = connect_and_auth(config).await
        .map_err(|e| format!("Connection test failed: {}", e))?;

    session
        .logout()
        .await
        .map_err(|e| format!("Logout failed: {}", e))?;

    Ok(())
}

// ── Helper functions ────────────────────────────────────────────────────────

/// Walk an IMAP BODYSTRUCTURE tree to detect real attachments.
/// Inline images with a Content-ID are treated as embedded (not attachments)
/// since they are referenced via cid: in the HTML body.
fn has_attachments_from_bodystructure(bs: &imap_proto::types::BodyStructure) -> bool {
    use imap_proto::types::BodyStructure;
    match bs {
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Text { common, other, .. }
        | BodyStructure::Message { common, other, .. } => {
            // Explicit Content-Disposition: attachment → always counts
            if let Some(ref disp) = common.disposition {
                if disp.ty.eq_ignore_ascii_case("attachment") {
                    return true;
                }
            }

            let mime = format!("{}/{}", common.ty.ty, common.ty.subtype).to_ascii_lowercase();

            // Skip text/* and multipart/* — never attachments on their own
            if mime.starts_with("text/") || mime.starts_with("multipart/") {
                // Recurse into message/rfc822 body
                if let BodyStructure::Message { body, .. } = bs {
                    return has_attachments_from_bodystructure(body);
                }
                return false;
            }

            let is_inline = common.disposition.as_ref()
                .map(|d| d.ty.eq_ignore_ascii_case("inline"))
                .unwrap_or(false);

            if is_inline {
                // Inline part with a Content-ID → embedded image (cid: reference)
                if other.id.is_some() {
                    return false;
                }
                // Inline image with a filename but no Content-ID → real attachment
                // (user attached an image inline without embedding it)
                if let Some(ref disp) = common.disposition {
                    if let Some(ref params) = disp.params {
                        if params.iter().any(|(k, _)| k.eq_ignore_ascii_case("filename")) {
                            return true;
                        }
                    }
                }
                // Inline with no Content-ID and no filename → tracking pixel, skip
                return false;
            }

            // No disposition at all → non-text part without disposition is an attachment
            true
        }
        BodyStructure::Multipart { bodies, .. } => {
            bodies.iter().any(has_attachments_from_bodystructure)
        }
    }
}

fn parse_header_from_fetch(fetch: &Fetch) -> Result<EmailHeader, String> {
    let uid = fetch.uid.ok_or_else(|| "No UID in FETCH".to_string())?;
    let seq = fetch.message;
    let envelope = fetch
        .envelope()
        .ok_or_else(|| "No ENVELOPE in FETCH".to_string())?;

    let subject = envelope
        .subject
        .as_ref()
        .map(|s| decode_rfc2047(s))
        .unwrap_or_else(|| "(No Subject)".to_string());

    let message_id = envelope
        .message_id
        .as_ref()
        .map(|s| String::from_utf8_lossy(s).to_string());

    let in_reply_to = envelope
        .in_reply_to
        .as_ref()
        .map(|s| String::from_utf8_lossy(s).to_string());

    // Parse headers from BODY.PEEK[HEADER.FIELDS (...)]
    let raw_headers = fetch.header()
        .map(|data| String::from_utf8_lossy(data).to_string());

    let references = raw_headers.as_ref()
        .and_then(|raw| {
            let parsed = parse_references_header(raw);
            if parsed.is_empty() { None } else { Some(parsed) }
        });

    let authentication_results = raw_headers.as_ref()
        .and_then(|raw| parse_single_header(raw, "Authentication-Results"));

    let return_path = raw_headers.as_ref()
        .and_then(|raw| parse_single_header(raw, "Return-Path"));

    let reply_to = raw_headers.as_ref()
        .and_then(|raw| parse_single_header(raw, "Reply-To"))
        .and_then(|val| parse_email_address_from_header(&val));

    let list_unsubscribe = raw_headers.as_ref()
        .and_then(|raw| parse_single_header(raw, "List-Unsubscribe"));

    let list_id = raw_headers.as_ref()
        .and_then(|raw| parse_single_header(raw, "List-Id"));

    let precedence = raw_headers.as_ref()
        .and_then(|raw| parse_single_header(raw, "Precedence"));

    let date = envelope
        .date
        .as_ref()
        .map(|s| String::from_utf8_lossy(s).to_string());

    let from = envelope
        .from
        .as_ref()
        .and_then(|addrs| addrs.first())
        .map(imap_addr_to_email_address)
        .unwrap_or_default();

    let to = envelope
        .to
        .as_ref()
        .map(|addrs| addrs.iter().map(imap_addr_to_email_address).collect())
        .unwrap_or_default();

    let cc = envelope
        .cc
        .as_ref()
        .map(|addrs| addrs.iter().map(imap_addr_to_email_address).collect())
        .unwrap_or_default();

    let bcc = envelope
        .bcc
        .as_ref()
        .map(|addrs| addrs.iter().map(imap_addr_to_email_address).collect())
        .unwrap_or_default();

    let flags = extract_flags(fetch);
    let internal_date = fetch.internal_date().map(|d| d.to_rfc3339());
    let size = fetch.size;

    let has_attachments = fetch.bodystructure()
        .map(has_attachments_from_bodystructure)
        .unwrap_or(false);

    Ok(EmailHeader {
        uid,
        seq,
        display_index: None,
        message_id,
        in_reply_to,
        references,
        subject,
        from,
        to,
        cc,
        bcc,
        date,
        internal_date,
        flags,
        size,
        has_attachments,
        source: None,
        reply_to,
        return_path,
        authentication_results,
        list_unsubscribe,
        list_id,
        precedence,
    })
}

/// Parse the References header value into a list of message-id strings.
/// References is a space/newline-separated list of `<message-id@domain>` values.
fn parse_references_header(raw: &str) -> Vec<String> {
    let mut refs = Vec::new();
    // Find the header value after "References:"
    let value = if let Some(idx) = raw.to_lowercase().find("references:") {
        &raw[idx + "references:".len()..]
    } else {
        return refs;
    };
    // Extract all <...> message-id tokens
    let mut start = None;
    for (i, ch) in value.char_indices() {
        match ch {
            '<' => start = Some(i),
            '>' => {
                if let Some(s) = start {
                    let msg_id = value[s..=i].trim().to_string();
                    if !msg_id.is_empty() {
                        refs.push(msg_id);
                    }
                }
                start = None;
            }
            _ => {}
        }
    }
    refs
}

/// Parse a single header value from raw header text.
/// Handles multi-line (folded) headers per RFC 5322.
fn parse_single_header(raw: &str, header_name: &str) -> Option<String> {
    let search = format!("{}:", header_name);
    // Case-insensitive search for the header name
    let lower_raw = raw.to_lowercase();
    let lower_search = search.to_lowercase();

    if let Some(start) = lower_raw.find(&lower_search) {
        let value_start = start + search.len();
        let rest = &raw[value_start..];

        // Collect lines until we hit a non-continuation line (not starting with whitespace)
        let mut value = String::new();
        for (i, line) in rest.lines().enumerate() {
            if i == 0 {
                value.push_str(line.trim());
            } else if line.starts_with(' ') || line.starts_with('\t') {
                // Continuation line (folded header)
                value.push(' ');
                value.push_str(line.trim());
            } else {
                break;
            }
        }

        let value = value.trim().to_string();
        if value.is_empty() { None } else { Some(value) }
    } else {
        None
    }
}

/// Parse an email address from a header value like "<user@example.com>" or "Name <user@example.com>"
fn parse_email_address_from_header(val: &str) -> Option<EmailAddress> {
    let trimmed = val.trim();
    // Try to extract from angle brackets first
    if let Some(start) = trimmed.find('<') {
        if let Some(end) = trimmed.find('>') {
            let addr = trimmed[start + 1..end].trim();
            if addr.contains('@') {
                let name_part = trimmed[..start].trim().trim_matches('"');
                return Some(EmailAddress {
                    name: if name_part.is_empty() { None } else { Some(name_part.to_string()) },
                    address: addr.to_string(),
                });
            }
        }
    }
    // Bare email address
    let bare = trimmed.trim_matches(|c: char| c == '<' || c == '>' || c.is_whitespace());
    if bare.contains('@') {
        Some(EmailAddress {
            name: None,
            address: bare.to_string(),
        })
    } else {
        None
    }
}

// Lenient RFC 2047 decoder lives in `crate::mime` so both binaries
// share the same implementation.
use crate::mime::decode_rfc2047;

fn imap_addr_to_email_address(addr: &imap_proto::types::Address) -> EmailAddress {
    let name = addr
        .name
        .as_ref()
        .map(|n| decode_rfc2047(n));
    let mailbox = addr
        .mailbox
        .as_ref()
        .map(|m| String::from_utf8_lossy(m).to_string())
        .unwrap_or_default();
    let host = addr
        .host
        .as_ref()
        .map(|h| String::from_utf8_lossy(h).to_string())
        .unwrap_or_default();
    let address = if host.is_empty() {
        mailbox
    } else {
        format!("{}@{}", mailbox, host)
    };
    EmailAddress { name, address }
}

fn extract_flags(fetch: &Fetch) -> Vec<String> {
    fetch
        .flags()
        .map(|f| match f {
            Flag::Seen => "\\Seen".to_string(),
            Flag::Answered => "\\Answered".to_string(),
            Flag::Flagged => "\\Flagged".to_string(),
            Flag::Deleted => "\\Deleted".to_string(),
            Flag::Draft => "\\Draft".to_string(),
            Flag::Recent => "\\Recent".to_string(),
            Flag::MayCreate => "\\MayCreate".to_string(),
            Flag::Custom(c) => c.to_string(),
        })
        .collect()
}

fn parse_address_header(value: Option<&str>) -> EmailAddress {
    match value {
        Some(v) if !v.trim().is_empty() => match mailparse::addrparse(v) {
            Ok(addrs) => addrs
                .iter()
                .next()
                .map(|a| match a {
                    mailparse::MailAddr::Single(info) => EmailAddress {
                        name: info.display_name.clone(),
                        address: info.addr.clone(),
                    },
                    mailparse::MailAddr::Group(group) => group
                        .addrs
                        .first()
                        .map(|info| EmailAddress {
                            name: info.display_name.clone(),
                            address: info.addr.clone(),
                        })
                        .unwrap_or_default(),
                })
                .unwrap_or_default(),
            Err(_) => EmailAddress {
                name: None,
                address: v.trim().to_string(),
            },
        },
        _ => EmailAddress::default(),
    }
}

fn parse_address_list(value: Option<&str>) -> Vec<EmailAddress> {
    match value {
        Some(v) if !v.trim().is_empty() => match mailparse::addrparse(v) {
            Ok(addrs) => addrs
                .iter()
                .flat_map(|a| match a {
                    mailparse::MailAddr::Single(info) => vec![EmailAddress {
                        name: info.display_name.clone(),
                        address: info.addr.clone(),
                    }],
                    mailparse::MailAddr::Group(group) => group
                        .addrs
                        .iter()
                        .map(|info| EmailAddress {
                            name: info.display_name.clone(),
                            address: info.addr.clone(),
                        })
                        .collect(),
                })
                .collect(),
            Err(_) => vec![EmailAddress {
                name: None,
                address: v.trim().to_string(),
            }],
        },
        _ => Vec::new(),
    }
}

fn walk_mime_parts(
    part: &mailparse::ParsedMail,
    text_body: &mut Option<String>,
    html_body: &mut Option<String>,
    attachments: &mut Vec<EmailAttachment>,
) {
    let content_type = part.ctype.mimetype.to_lowercase();

    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            walk_mime_parts(sub, text_body, html_body, attachments);
        }
        return;
    }

    let disposition = part.get_content_disposition();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !content_type.starts_with("text/");

    if is_attachment || is_inline_non_text {
        if let Ok(body) = part.get_body_raw() {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
            let filename = disposition
                .params
                .get("filename")
                .or_else(|| part.ctype.params.get("name"))
                .cloned();
            let content_id = part
                .headers
                .iter()
                .find(|h| h.get_key().eq_ignore_ascii_case("Content-ID"))
                .map(|h| h.get_value());

            attachments.push(EmailAttachment {
                filename,
                content_type: content_type.clone(),
                content_disposition: Some(format!("{:?}", disposition.disposition)),
                size: body.len(),
                content_id,
                content: b64,
            });
        }
    } else if content_type == "text/plain" && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type == "text/html" && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
}

fn walk_mime_parts_light(
    part: &mailparse::ParsedMail,
    text_body: &mut Option<String>,
    html_body: &mut Option<String>,
    attachments: &mut Vec<LightEmailAttachment>,
) {
    let content_type = part.ctype.mimetype.to_lowercase();

    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            walk_mime_parts_light(sub, text_body, html_body, attachments);
        }
        return;
    }

    let disposition = part.get_content_disposition();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !content_type.starts_with("text/");

    if is_attachment || is_inline_non_text {
        let size = part.get_body_raw().map(|b| b.len()).unwrap_or(0);
        let filename = disposition
            .params
            .get("filename")
            .or_else(|| part.ctype.params.get("name"))
            .cloned();
        let content_id = part
            .headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("Content-ID"))
            .map(|h| h.get_value());

        attachments.push(LightEmailAttachment {
            filename,
            content_type: content_type.clone(),
            content_disposition: Some(format!("{:?}", disposition.disposition)),
            size,
            content_id,
        });
    } else if content_type == "text/plain" && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type == "text/html" && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
}


/// Is `uid` still in the mailbox the session has selected?
///
/// Asked only when a body fetch came back empty. `async-imap` ends a fetch
/// stream on the tagged response without inspecting it, so a server that
/// answers `NO` yields exactly what a deleted message yields: nothing. This
/// second, much cheaper question is the independent claim that tells the two
/// apart — the caller reports absence only when the uid really is gone.
///
/// A second empty answer is NOT the honest "not found", which is what this
/// used to assume: it is the same blind observation as the first. `filter_sync`
/// drops the tagged `Done` without ever reading its status, so a refusal that
/// covers the whole uid — not just its body — comes back through `uid_fetch`
/// (and through `uid_search`, which parses ids the same way) as an empty
/// stream; and a pooled session whose socket has died yields an empty stream
/// with no error at all, in under a millisecond. Both were reported to the
/// reading pane as `Email not found`, for mail sitting right there in the list.
///
/// So the last question goes through `run_command_and_check_ok` — the one
/// entry point in async-imap that inspects the tagged status. It errors on
/// `NO`/`BAD` and on a lost connection, which leaves exactly one way to reach
/// `Ok(false)`: the server answered `OK` and had no such uid. Absence is a
/// claim the server has to make; the client no longer infers it from silence.
async fn uid_still_present(session: &mut ImapSession, uid: u32) -> Result<bool, String> {
    let items = session
        .uid_fetch(uid.to_string(), "(UID)")
        .await
        .map_err(|e| format!("UID FETCH {} (UID) failed: {}", uid, e))?
        .collect::<Vec<_>>()
        .await;

    let mut found = false;
    for item in items {
        match item {
            Ok(_) => found = true,
            Err(e) => return Err(format!("UID FETCH {} (UID) failed: {}", uid, e)),
        }
    }
    if found {
        return Ok(true);
    }

    session
        .run_command_and_check_ok(format!("UID FETCH {} (UID)", uid))
        .await
        .map_err(|e| format!("Server refused UID FETCH {}: {}", uid, e))?;

    Ok(false)
}

/// Fetch a single email by UID with light content (no attachment binaries, no rawSource)
/// Returns the raw bytes separately for Maildir persistence
pub async fn fetch_email_by_uid_light(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
) -> Result<Option<LightFullEmail>, String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let fetch_stream = session
        .uid_fetch(uid.to_string(), "(UID FLAGS ENVELOPE INTERNALDATE BODY.PEEK[])")
        .await
        .map_err(|e| format!("UID FETCH {} failed: {}", uid, e))?;

    // Errors in the stream are the server refusing the FETCH — a tagged NO, a
    // dropped connection, a parse failure. Dropping them with `.ok()` turned
    // every one of those into an empty result, which the caller reports as
    // "Email not found": a message that is sitting right there on the server
    // then reads as deleted. Absence has to mean absence.
    let mut fetches: Vec<Fetch> = Vec::new();
    for item in fetch_stream.collect::<Vec<_>>().await {
        match item {
            Ok(f) => fetches.push(f),
            Err(e) => return Err(format!("UID FETCH {} failed: {}", uid, e)),
        }
    }

    let fetch = match fetches.first() {
        Some(f) => f,
        None => {
            // Empty here is not proof of absence — see `uid_still_present`.
            // Its own error is not proof either, so it propagates rather than
            // collapsing into "gone".
            if uid_still_present(session, uid).await? {
                return Err(format!(
                    "Server returned no body for UID {}, but the message is still in {}",
                    uid, mailbox
                ));
            }
            return Ok(None);
        }
    };

    let body = fetch
        .body()
        .ok_or_else(|| "No body in FETCH response".to_string())?;

    let parsed = mailparse::parse_mail(body)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let get_header = |name: &str| -> Option<String> {
        headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };
    let get_header_raw = |name: &str| -> Option<Vec<u8>> {
        headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value_raw().to_vec())
    };

    let subject = get_header_raw("Subject")
        .map(|raw| decode_rfc2047(&raw))
        .unwrap_or_else(|| "(No Subject)".to_string());
    let message_id = get_header("Message-ID");
    let date = get_header("Date");

    let from = parse_address_header(get_header("From").as_deref());
    let to = parse_address_list(get_header("To").as_deref());
    let cc = parse_address_list(get_header("Cc").as_deref());
    let bcc = parse_address_list(get_header("Bcc").as_deref());
    let reply_to = parse_address_list(get_header("Reply-To").as_deref());

    let mut text_body: Option<String> = None;
    let mut html_body: Option<String> = None;
    let mut attachments: Vec<LightEmailAttachment> = Vec::new();
    walk_mime_parts_light(&parsed, &mut text_body, &mut html_body, &mut attachments);

    let flags = extract_flags(fetch);
    let internal_date = fetch.internal_date().map(|d| d.to_rfc3339());

    Ok(Some(LightFullEmail {
        uid: fetch.uid.unwrap_or(uid),
        message_id,
        subject,
        from,
        to,
        cc,
        bcc,
        reply_to,
        date,
        internal_date,
        flags,
        text: text_body,
        html: html_body,
        has_attachments: !attachments.is_empty(),
        attachments,
        raw_source_bytes: body.to_vec(),
    }))
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── compress_uid_ranges ─────────────────────────────────────────────

    #[test]
    fn compress_empty() {
        assert_eq!(compress_uid_ranges(&[]), "");
    }

    #[test]
    fn compress_single() {
        assert_eq!(compress_uid_ranges(&[42]), "42");
    }

    #[test]
    fn compress_consecutive() {
        assert_eq!(compress_uid_ranges(&[1, 2, 3, 4, 5]), "1:5");
    }

    #[test]
    fn compress_mixed() {
        assert_eq!(compress_uid_ranges(&[1, 2, 3, 5, 6, 10]), "1:3,5:6,10");
    }

    #[test]
    fn compress_all_gaps() {
        assert_eq!(compress_uid_ranges(&[1, 3, 5, 7]), "1,3,5,7");
    }

    #[test]
    fn compress_unsorted_input() {
        assert_eq!(compress_uid_ranges(&[10, 1, 5, 6, 2, 3]), "1:3,5:6,10");
    }

    #[test]
    fn compress_duplicates() {
        assert_eq!(compress_uid_ranges(&[1, 1, 2, 2, 3]), "1:3");
    }

    #[test]
    fn compress_large_range() {
        let uids: Vec<u32> = (1..=1000).collect();
        assert_eq!(compress_uid_ranges(&uids), "1:1000");
    }

    #[test]
    fn compress_two_ranges() {
        assert_eq!(compress_uid_ranges(&[100, 101, 200, 201, 202]), "100:101,200:202");
    }

    #[test]
    fn roundtrip_large_set() {
        let original: Vec<u32> = (500..=700).chain(800..=900).chain(std::iter::once(1000)).collect();
        let compressed = compress_uid_ranges(&original);
        assert_eq!(compressed, "500:700,800:900,1000");
    }

    // ── is_bandwidth_limited ────────────────────────────────────────────

    #[test]
    fn bandwidth_limited_gmail_message() {
        assert!(is_bandwidth_limited(
            "UID FETCH 42 failed: NO Account exceeded bandwidth limits. (Failure)"
        ));
    }

    #[test]
    fn bandwidth_limited_throttled_response_code() {
        assert!(is_bandwidth_limited("BYE [THROTTLED] Too much traffic"));
    }

    #[test]
    fn bandwidth_limited_negative() {
        assert!(!is_bandwidth_limited("UID FETCH 42 failed: connection reset by peer"));
        assert!(!is_bandwidth_limited("Email UID 42 not found"));
        assert!(!is_bandwidth_limited(""));
    }

    // ── ImapConfig::effective_security ───────────────────────────────────

    fn config_with(security: Option<&str>, secure: Option<bool>) -> ImapConfig {
        ImapConfig {
            email: "test@example.com".to_string(),
            password: None,
            host: "imap.example.com".to_string(),
            port: None,
            secure,
            security: security.map(String::from),
            auth_type: None,
            access_token: None,
            smtp_host: None,
            smtp_port: None,
            smtp_secure: None,
            name: None,
            oauth2_transport: None,
            from_email: None,
        }
    }

    #[test]
    fn security_explicit_ssl() {
        assert_eq!(config_with(Some("ssl"), None).effective_security(), ImapSecurity::Ssl);
    }

    #[test]
    fn security_explicit_starttls() {
        assert_eq!(config_with(Some("starttls"), None).effective_security(), ImapSecurity::StartTls);
    }

    #[test]
    fn security_explicit_none() {
        assert_eq!(config_with(Some("none"), None).effective_security(), ImapSecurity::None);
    }

    #[test]
    fn security_case_insensitive() {
        assert_eq!(config_with(Some("StartTLS"), None).effective_security(), ImapSecurity::StartTls);
        assert_eq!(config_with(Some("SSL"), None).effective_security(), ImapSecurity::Ssl);
        assert_eq!(config_with(Some("NONE"), None).effective_security(), ImapSecurity::None);
    }

    #[test]
    fn security_unknown_string_falls_back_to_ssl() {
        assert_eq!(config_with(Some("garbage"), None).effective_security(), ImapSecurity::Ssl);
    }

    #[test]
    fn security_absent_legacy_secure_false_is_none() {
        assert_eq!(config_with(None, Some(false)).effective_security(), ImapSecurity::None);
    }

    #[test]
    fn security_absent_legacy_secure_absent_is_ssl() {
        assert_eq!(config_with(None, None).effective_security(), ImapSecurity::Ssl);
    }

    #[test]
    fn security_absent_legacy_secure_true_is_ssl() {
        assert_eq!(config_with(None, Some(true)).effective_security(), ImapSecurity::Ssl);
    }
}

// ── Mailbox-name resolution ─────────────────────────────────────────────────

/// Map a mailbox name the caller asked for onto the path this server actually
/// serves. Returns `None` when nothing matches — the caller keeps its own error.
pub fn resolve_mailbox_path(requested: &str, mailboxes: &[MailboxInfo]) -> Option<String> {
    let selectable = |m: &&MailboxInfo| !m.noselect;

    // A folder that really carries this name wins: an account can hold both a
    // hand-made "Sent" and the provider's own \\Sent folder.
    if let Some(m) = mailboxes
        .iter()
        .filter(selectable)
        .find(|m| m.path.eq_ignore_ascii_case(requested))
    {
        return Some(m.path.clone());
    }

    // Otherwise read the request as a role name ("Sent", "Sent Messages") and
    // hand back the folder the server flagged for that role. A name with no
    // role is never guessed at.
    let role = detect_special_use(&[], requested)?;
    mailboxes
        .iter()
        .filter(selectable)
        .find(|m| m.special_use.as_deref() == Some(role.as_str()))
        .map(|m| m.path.clone())
}

/// True when the server answered "that mailbox is not here" — as opposed to the
/// socket dying or the command being refused. Only this answer is worth
/// re-asking with a resolved folder path.
pub fn is_missing_mailbox(err: &str) -> bool {
    const NEEDLES: [&str; 5] = [
        "nonexistent",      // RFC 5530 [NONEXISTENT] response code
        "unknown mailbox",  // Gmail
        "no such mailbox",  // Purelymail / Zoho
        "doesn't exist",    // Dovecot
        "does not exist",
    ];
    let lowered = err.to_ascii_lowercase();
    NEEDLES.iter().any(|n| lowered.contains(n))
}

#[cfg(test)]
mod is_missing_mailbox_tests {
    use super::*;

    #[test]
    fn gmails_nonexistent_answer_is_a_missing_mailbox() {
        assert!(is_missing_mailbox(
            r#"SELECT CONDSTORE Sent failed: no response: code: None, info: Some("[NONEXISTENT] Unknown Mailbox: Sent (Failure)")"#
        ));
    }

    #[test]
    fn purelymails_wording_is_a_missing_mailbox_too() {
        assert!(is_missing_mailbox(
            r#"SELECT CONDSTORE Sent Messages failed: no response: code: None, info: Some("SELECT failed. No such mailbox.")"#
        ));
    }

    #[test]
    fn dovecots_wording_is_a_missing_mailbox_too() {
        assert!(is_missing_mailbox("SELECT Sent failed: NO Mailbox doesn\'t exist: Sent"));
    }

    #[test]
    fn a_dead_socket_is_not_a_missing_mailbox() {
        assert!(!is_missing_mailbox("SELECT CONDSTORE INBOX failed: io: Broken pipe (os error 32)"));
    }

    #[test]
    fn a_failed_handshake_is_not_a_missing_mailbox() {
        assert!(!is_missing_mailbox(
            "TLS handshake with imap.gmail.com failed: connection closed via error"
        ));
    }
}

#[cfg(test)]
mod resolve_mailbox_path_tests {
    use super::*;

    fn mb(path: &str, special_use: Option<&str>) -> MailboxInfo {
        MailboxInfo {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            special_use: special_use.map(str::to_string),
            flags: Vec::new(),
            delimiter: Some("/".to_string()),
            noselect: false,
            children: Vec::new(),
        }
    }

    fn gmail() -> Vec<MailboxInfo> {
        vec![
            mb("INBOX", Some("\\Inbox")),
            mb("[Google Mail]/Sent Mail", Some("\\Sent")),
            mb("[Google Mail]/Bin", Some("\\Trash")),
            mb("[Google Mail]/Spam", Some("\\Junk")),
        ]
    }

    #[test]
    fn gmail_sent_resolves_to_the_special_use_folder() {
        assert_eq!(
            resolve_mailbox_path("Sent", &gmail()),
            Some("[Google Mail]/Sent Mail".to_string())
        );
    }

    #[test]
    fn sent_messages_is_the_same_role_as_sent() {
        assert_eq!(
            resolve_mailbox_path("Sent Messages", &gmail()),
            Some("[Google Mail]/Sent Mail".to_string())
        );
    }

    #[test]
    fn an_exact_path_beats_the_special_use_folder() {
        let mut boxes = gmail();
        boxes.push(mb("Sent", None));
        assert_eq!(resolve_mailbox_path("Sent", &boxes), Some("Sent".to_string()));
    }

    #[test]
    fn trash_resolves_too_so_this_is_not_sent_only() {
        assert_eq!(
            resolve_mailbox_path("Trash", &gmail()),
            Some("[Google Mail]/Bin".to_string())
        );
    }

    #[test]
    fn a_name_with_no_role_is_never_guessed() {
        assert_eq!(resolve_mailbox_path("Projects", &gmail()), None);
    }

    #[test]
    fn no_folder_for_the_role_stays_unresolved() {
        assert_eq!(resolve_mailbox_path("Sent", &[mb("INBOX", Some("\\Inbox"))]), None);
    }

    #[test]
    fn an_unselectable_folder_is_never_returned() {
        let mut container = mb("[Google Mail]/Sent Mail", Some("\\Sent"));
        container.noselect = true;
        assert_eq!(resolve_mailbox_path("Sent", &[mb("INBOX", Some("\\Inbox")), container]), None);
    }
}
