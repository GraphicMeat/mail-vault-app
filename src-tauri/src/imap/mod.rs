pub mod pool;

use async_imap::types::{Fetch, Flag, Mailbox, Name, NameAttribute};
use async_native_tls::TlsConnector;
use async_std::net::TcpStream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

pub use pool::{ImapPool, ImapSession};

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
}

impl ImapConfig {
    pub fn effective_port(&self) -> u16 {
        self.port.unwrap_or(993)
    }

    pub fn is_oauth2(&self) -> bool {
        self.auth_type.as_deref() == Some("oauth2")
    }
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

pub async fn create_imap_session(config: &ImapConfig) -> Result<ImapSession, String> {
    let port = config.effective_port();
    let addr = format!("{}:{}", config.host, port);

    info!("[IMAP] Connecting to {} (oauth2={})", addr, config.is_oauth2());

    // Resolve to IPv4 only — avoids IPv6 hangs (especially with Outlook)
    use async_std::net::ToSocketAddrs;
    let addrs: Vec<std::net::SocketAddr> = addr
        .to_socket_addrs()
        .await
        .map_err(|e| format!("DNS resolve failed for {}: {}", addr, e))?
        .filter(|a| a.is_ipv4())
        .collect();

    if addrs.is_empty() {
        return Err(format!("No IPv4 address found for {}", config.host));
    }

    info!("[IMAP] DNS resolved to {:?}", addrs);

    let tcp = async_std::io::timeout(
        std::time::Duration::from_secs(15),
        TcpStream::connect(&addrs[..]),
    )
    .await
    .map_err(|e| format!("TCP connect to {} failed: {}", addr, e))?;

    info!("[IMAP] TCP connected, starting TLS handshake...");

    let tls = TlsConnector::new();
    let tls_stream = tls
        .connect(&config.host, tcp)
        .await
        .map_err(|e| format!("TLS handshake with {} failed: {}", config.host, e))?;

    info!("[IMAP] TLS established, authenticating...");

    let mut client = async_imap::Client::new(tls_stream);

    // Consume the server greeting (e.g. "* OK Gimap ready") before auth.
    // Without this, authenticate() reads the greeting instead of the "+"
    // continuation, causing a deadlock. login() handles it internally but
    // authenticate()'s handshake loop does not.
    let _greeting = client.read_response().await
        .map_err(|e| format!("Failed to read server greeting: {}", e))?;

    let session = if config.is_oauth2() {
        let token = config
            .access_token
            .as_deref()
            .ok_or_else(|| "OAuth2 access token missing".to_string())?;
        info!("[IMAP] Using XOAUTH2 for {} (token length: {})", config.email, token.len());
        let xoauth2 = build_xoauth2(&config.email, token);
        client
            .authenticate("XOAUTH2", XOAuth2Authenticator::new(xoauth2.into_bytes()))
            .await
            .map_err(|(e, _)| format!("XOAUTH2 auth failed for {}: {}", config.email, e))?
    } else {
        let password = config
            .password
            .as_deref()
            .ok_or_else(|| "Password missing".to_string())?;
        client
            .login(&config.email, password)
            .await
            .map_err(|(e, _)| format!("Login failed for {}: {}", config.email, e))?
    };

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

// ── IMAP Operations ─────────────────────────────────────────────────────────

/// List all mailboxes
pub async fn list_mailboxes(session: &mut ImapSession) -> Result<Vec<MailboxInfo>, String> {
    let names_stream = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| format!("LIST failed: {}", e))?;

    let names: Vec<Name> = names_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

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

    // Build tree: attach children to parents
    let mut result: Vec<MailboxInfo> = Vec::new();
    let paths: Vec<String> = all.iter().map(|m| m.path.clone()).collect();

    for mbox in all {
        let is_child = if let Some(ref delim) = mbox.delimiter {
            if let Some(idx) = mbox.path.rfind(delim.as_str()) {
                let parent = &mbox.path[..idx];
                paths.iter().any(|p| p == parent)
            } else {
                false
            }
        } else {
            false
        };

        if is_child {
            // Find parent in result and attach
            let delim = mbox.delimiter.as_deref().unwrap_or("/");
            let parent_path = mbox.path.rsplitn(2, delim).nth(1).unwrap_or("");
            let mut attached = false;
            for root in &mut result {
                if root.path == parent_path {
                    root.children.push(mbox.clone());
                    attached = true;
                    break;
                }
            }
            if !attached {
                result.push(mbox);
            }
        } else {
            result.push(mbox);
        }
    }

    Ok(result)
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
    session
        .select(mailbox)
        .await
        .map_err(|e| format!("SELECT {} failed: {}", mailbox, e))
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
        .fetch(&range, "(UID FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE)")
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
        .fetch(&range, "(UID FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE)")
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

/// Check mailbox status — returns exists, uid_validity, uid_next
/// Used for delta-sync: detect changes without fetching any messages.
pub async fn check_mailbox_status(
    session: &mut ImapSession,
    mailbox: &str,
) -> Result<(u32, Option<u32>, Option<u32>), String> {
    let mbox = select_mailbox(session, mailbox).await?;
    Ok((mbox.exists, mbox.uid_validity, mbox.uid_next))
}

/// UID SEARCH ALL — returns every UID in the mailbox (ascending order).
/// Used for delta-sync: diff against cached UID set to find additions/deletions.
pub async fn search_all_uids(
    session: &mut ImapSession,
    mailbox: &str,
) -> Result<Vec<u32>, String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    let uids = session
        .uid_search("ALL")
        .await
        .map_err(|e| format!("UID SEARCH ALL failed: {}", e))?;

    let mut result: Vec<u32> = uids.into_iter().collect();
    result.sort();
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

    let uid_set = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let fetch_stream = session
        .uid_fetch(&uid_set, "(UID FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE)")
        .await
        .map_err(|e| format!("UID FETCH {} failed: {}", uid_set, e))?;

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut emails = Vec::new();
    for fetch in &fetches {
        match parse_header_from_fetch(fetch) {
            Ok(header) => emails.push(header),
            Err(e) => {
                warn!("Failed to parse UID-fetched message uid={:?}: {}", fetch.uid, e);
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

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let fetch = match fetches.first() {
        Some(f) => f,
        None => return Ok(None),
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

    let subject = get_header("Subject").unwrap_or_else(|| "(No Subject)".to_string());
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

    let _: Vec<_> = session
        .uid_store(uid.to_string(), &store_cmd)
        .await
        .map_err(|e| format!("STORE flags failed: {}", e))?
        .collect::<Vec<_>>()
        .await;

    Ok(())
}

/// Delete an email by UID
pub async fn delete_email(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
    permanent: bool,
) -> Result<(), String> {
    let _mbox = select_mailbox(session, mailbox).await?;

    if permanent {
        let _: Vec<_> = session
            .uid_store(uid.to_string(), "+FLAGS (\\Deleted)")
            .await
            .map_err(|e| format!("STORE \\Deleted failed: {}", e))?
            .collect::<Vec<_>>()
            .await;
        // Use UID EXPUNGE to only expunge this specific UID (RFC 4315 UIDPLUS)
        let _: Vec<_> = session
            .uid_expunge(uid.to_string())
            .await
            .map_err(|e| format!("UID EXPUNGE failed: {}", e))?
            .collect::<Vec<_>>()
            .await;
    } else {
        let trash_folders = ["Trash", "[Gmail]/Trash", "Deleted Items", "Deleted"];
        let mut moved = false;

        for folder in &trash_folders {
            match session.uid_mv(uid.to_string(), folder).await {
                Ok(_) => {
                    moved = true;
                    break;
                }
                Err(_) => continue,
            }
        }

        if !moved {
            let _: Vec<_> = session
                .uid_store(uid.to_string(), "+FLAGS (\\Deleted)")
                .await
                .map_err(|e| format!("STORE \\Deleted fallback failed: {}", e))?
                .collect::<Vec<_>>()
                .await;
        }
    }

    Ok(())
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

    let uid_range = limited
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let fetch_stream = session
        .uid_fetch(&uid_range, "(UID FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE)")
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

/// Test IMAP connection
pub async fn test_connection(config: &ImapConfig) -> Result<(), String> {
    let mut session = create_imap_session(config).await
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
    })
}

/// Decode RFC 2047 encoded-words (e.g. `=?windows-1257?Q?Ona_...?=`) in raw
/// IMAP envelope bytes.  Falls back to lossy UTF-8 if parsing fails.
fn decode_rfc2047(raw: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(raw);
    // Fast path: no encoded-word marker present
    if !lossy.contains("=?") {
        return lossy.into_owned();
    }
    // Build a synthetic header so mailparse can decode it
    let fake_header = format!("X: {}", lossy);
    match mailparse::parse_header(fake_header.as_bytes()) {
        Ok((hdr, _)) => hdr.get_value(),
        Err(_) => lossy.into_owned(),
    }
}

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
            _ => format!("{:?}", f),
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

    let fetches: Vec<Fetch> = fetch_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let fetch = match fetches.first() {
        Some(f) => f,
        None => return Ok(None),
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

    let subject = get_header("Subject").unwrap_or_else(|| "(No Subject)".to_string());
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
