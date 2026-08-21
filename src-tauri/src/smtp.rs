use base64::Engine;
use lettre::message::header::MessageId;
use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;
use std::time::Duration;
use tracing::info;

use crate::imap::ImapConfig;

#[derive(Debug, Deserialize)]
pub struct OutgoingAttachment {
    pub filename: String,
    /// Base64-encoded file content.
    pub content: String,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    /// Bare Content-ID for an inline image the HTML references as `cid:<value>`.
    /// Absent (or blank) means a regular attachment.
    #[serde(default)]
    pub cid: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OutgoingEmail {
    pub to: String,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub cc: Option<String>,
    pub bcc: Option<String>,
    #[serde(rename = "inReplyTo")]
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<OutgoingAttachment>>,
}

/// Send result with message ID and raw RFC2822 bytes for Sent folder append.
pub struct SendResult {
    pub message_id: String,
    pub raw_rfc2822: Vec<u8>,
}

/// Built but not-yet-sent MIME — lets callers stage the raw bytes in Drafts
/// before handing the Message to `send_built`.
pub struct BuiltMime {
    pub message: lettre::Message,
    pub raw_rfc2822: Vec<u8>,
}

/// Parse a comma-separated recipient string into a list of mailboxes.
/// Empty entries (e.g. trailing commas, "a, ,b") are skipped so a stray
/// comma doesn't cause a send failure.
fn parse_address_list(raw: &str) -> Result<Vec<Mailbox>, String> {
    let mut out = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mb: Mailbox = trimmed
            .parse()
            .map_err(|e| format!("{} ({})", e, trimmed))?;
        out.push(mb);
    }
    Ok(out)
}

/// Build the MIME message without sending. Lets callers stage raw bytes in
/// Drafts via IMAP APPEND before the SMTP submission.
pub fn build_mime(account: &ImapConfig, email: &OutgoingEmail) -> Result<BuiltMime, String> {
    // Identity, not credentials: `from_address()` honours the per-account
    // send-as override. Authentication still uses `account.email`.
    let from_address = account.from_address();
    let from_mailbox: Mailbox = {
        let addr: lettre::Address = from_address.parse()
            .map_err(|e| format!("Invalid from email: {}", e))?;
        match account.name.as_deref() {
            Some(name) if !name.is_empty() => Mailbox::new(Some(name.to_string()), addr),
            _ => Mailbox::new(None, addr),
        }
    };

    let to_mailboxes = parse_address_list(&email.to)
        .map_err(|e| format!("Invalid to address: {}", e))?;
    if to_mailboxes.is_empty() {
        return Err("Invalid to address: no recipients".to_string());
    }

    // Generate a stable Message-ID header. lettre does NOT auto-add one; without
    // it, recipient servers may flag the mail, and we cannot dedupe the
    // optimistic local Sent entry against the server copy by Message-ID header.
    // Message-ID domain follows the From address, not the login — receivers'
    // DMARC/spam heuristics read the From domain.
    //
    // The angle brackets are ours to add: `Message::builder().message_id(Some(v))`
    // is a raw passthrough (lettre only wraps on the `None` branch, where it
    // generates its own id), and RFC 5322 §3.6.4 requires `msg-id = "<" ... ">"`.
    let domain = from_address.splitn(2, '@').nth(1).unwrap_or("mailvault.local");
    let msg_id_value = format!(
        "<{}.{}@{}>",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        rand::random::<u32>(),
        domain
    );

    let mut builder = Message::builder()
        .from(from_mailbox)
        .subject(&email.subject)
        .message_id(Some(msg_id_value.clone()));
    for mb in to_mailboxes {
        builder = builder.to(mb);
    }
    // Silence unused-import warning for MessageId — we depend on it only to
    // prove at compile time that the header type exists in the current lettre.
    let _phantom_header: Option<MessageId> = None;

    if let Some(ref cc) = email.cc {
        if let Ok(list) = parse_address_list(cc) {
            for mb in list {
                builder = builder.cc(mb);
            }
        }
    }

    if let Some(ref bcc) = email.bcc {
        if let Ok(list) = parse_address_list(bcc) {
            for mb in list {
                builder = builder.bcc(mb);
            }
        }
    }

    if let Some(ref reply_to) = email.in_reply_to {
        if !reply_to.is_empty() {
            builder = builder.in_reply_to(reply_to.clone());
        }
    }

    if let Some(ref refs) = email.references {
        if !refs.is_empty() {
            builder = builder.references(refs.clone());
        }
    }

    // Inline images (cid set) nest with the body inside multipart/related;
    // everything else hangs off multipart/mixed. A blank cid is a regular
    // attachment — the HTML has nothing to reference it by.
    let all_attachments: &[OutgoingAttachment] = email.attachments.as_deref().unwrap_or(&[]);
    let (inline, regular): (Vec<&OutgoingAttachment>, Vec<&OutgoingAttachment>) = all_attachments
        .iter()
        .partition(|a| a.cid.as_deref().map_or(false, |c| !c.trim().is_empty()));

    let decoded = |att: &OutgoingAttachment| -> Result<(Vec<u8>, ContentType), String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(att.content.as_bytes())
            .map_err(|e| format!("Invalid base64 for attachment '{}': {}", att.filename, e))?;
        let ct = att
            .content_type
            .as_deref()
            .and_then(|s| ContentType::parse(s).ok())
            .unwrap_or_else(|| ContentType::parse("application/octet-stream").unwrap());
        Ok((bytes, ct))
    };

    // Helper: assemble the body-only section (what the reader sees as the message).
    let body_multipart = if email.html.is_some() && email.text.is_some() {
        Some(
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(email.text.clone().unwrap_or_default()),
                )
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(email.html.clone().unwrap_or_default()),
                ),
        )
    } else {
        None
    };

    // The body as it gets wrapped: related() and mixed() need `.multipart()` for
    // one and `.singlepart()` for the other.
    enum Body {
        Single(SinglePart),
        Multi(MultiPart),
    }

    let message = if inline.is_empty() && regular.is_empty() {
        // No attachments: unchanged top-level shape.
        if let Some(body) = body_multipart {
            builder
                .multipart(body)
                .map_err(|e| format!("Failed to build multipart message: {}", e))?
        } else if let Some(ref html) = email.html {
            builder
                .header(ContentType::TEXT_HTML)
                .body(html.clone())
                .map_err(|e| format!("Failed to build HTML message: {}", e))?
        } else {
            builder
                .header(ContentType::TEXT_PLAIN)
                .body(email.text.clone().unwrap_or_default())
                .map_err(|e| format!("Failed to build text message: {}", e))?
        }
    } else {
        let mut body = match body_multipart {
            Some(m) => Body::Multi(m),
            None => Body::Single(match email.html {
                Some(ref html) => SinglePart::builder()
                    .header(ContentType::TEXT_HTML)
                    .body(html.clone()),
                None => SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(email.text.clone().unwrap_or_default()),
            }),
        };

        if !inline.is_empty() {
            // multipart/related: body + each inline image, so the HTML's
            // `cid:` references resolve against siblings, not attachments.
            let mut related = MultiPart::related().build();
            related = match body {
                Body::Multi(m) => related.multipart(m),
                Body::Single(s) => related.singlepart(s),
            };
            for att in &inline {
                let (bytes, ct) = decoded(att)?;
                let cid = att.cid.as_deref().unwrap_or_default().trim().to_string();
                related = related.singlepart(
                    Attachment::new_inline_with_name(cid, att.filename.clone()).body(bytes, ct),
                );
            }
            body = Body::Multi(related);
        }

        if !regular.is_empty() {
            // multipart/mixed: body (possibly the related part) + each attachment.
            let mut mixed = MultiPart::mixed().build();
            mixed = match body {
                Body::Multi(m) => mixed.multipart(m),
                Body::Single(s) => mixed.singlepart(s),
            };
            for att in &regular {
                let (bytes, ct) = decoded(att)?;
                mixed = mixed.singlepart(Attachment::new(att.filename.clone()).body(bytes, ct));
            }
            body = Body::Multi(mixed);
        }

        match body {
            Body::Multi(m) => builder
                .multipart(m)
                .map_err(|e| format!("Failed to build multipart message: {}", e))?,
            // Unreachable — one of the two lists is non-empty in this branch.
            Body::Single(s) => builder
                .singlepart(s)
                .map_err(|e| format!("Failed to build message: {}", e))?,
        }
    };

    let raw_rfc2822 = message.formatted();
    Ok(BuiltMime { message, raw_rfc2822 })
}

/// Decide implicit-TLS (wrapper, typically port 465) vs STARTTLS (587).
/// Explicit `smtp_secure` wins; when absent, infer from the port so a config
/// missing the flag still picks the right handshake.
fn use_implicit_tls(smtp_secure: Option<bool>, smtp_port: u16) -> bool {
    match smtp_secure {
        Some(v) => v,
        None => smtp_port == 465,
    }
}

/// True if `host` is a loopback literal (127.0.0.1/::1/localhost). Used to allow
/// self-signed TLS certs for local bridges (e.g. Proton Mail Bridge on
/// 127.0.0.1:1025) without weakening TLS validation for real remote hosts.
/// Literal check only — no DNS resolution.
fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// True when the server refused the *sender* identity rather than the login or
/// the recipient. Providers word this differently (Postfix "Sender address
/// rejected", Fastmail "not owned by", Microsoft "SendAsDenied", Gmail "not
/// allowed to send as"), so match on the phrases rather than the status code —
/// bare 550 is also "recipient mailbox unavailable" and must not be caught.
fn is_send_as_rejection(lower: &str) -> bool {
    const MARKERS: [&str; 7] = [
        "sender address rejected",
        "not owned by",
        "sendasdenied",
        "not allowed to send as",
        "sender not allowed",
        "sender address is not",
        "553",
    ];
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Map a raw lettre SMTP error string to a human-readable message. Kept pure
/// (takes the stringified error) so the classification is unit-testable.
/// `from_addr` is the identity we tried to send as — the send-as branch names
/// it, because "which address was refused" is the whole question there.
fn friendly_smtp_error(host: &str, port: u16, from_addr: &str, err_str: &str) -> String {
    let lower = err_str.to_lowercase();
    // Ordered before the auth branch: a send-as refusal often carries "5.7.1
    // ... authorized", which would otherwise read as a password problem.
    if is_send_as_rejection(&lower) {
        format!(
            "{} refused to send as {} — the address must be an alias this login is authorized to send from.",
            host, from_addr
        )
    } else if lower.contains("auth") || lower.contains("535") || lower.contains("credential") {
        format!(
            "Authentication failed for {}:{} — check your email and password.",
            host, port
        )
    } else if lower.contains("timed out") || lower.contains("timeout") {
        format!("Connection to {}:{} timed out.", host, port)
    } else if lower.contains("dns") || lower.contains("resolve") || lower.contains("lookup") {
        format!("Could not resolve SMTP host {}.", host)
    } else {
        format!("SMTP connection to {}:{} failed: {}", host, port, err_str)
    }
}

/// Build the lettre async SMTP transport (TLS mode by flag/port + credentials).
/// Shared by send and the connectivity test so the two never drift.
fn build_transport(
    account: &ImapConfig,
    io_timeout: Duration,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);

    let mut tls_builder = TlsParameters::builder(smtp_host.to_string());
    if is_loopback_host(smtp_host) {
        // ponytail: local bridges (Proton Mail Bridge) use self-signed certs; loopback-only.
        tls_builder = tls_builder.dangerous_accept_invalid_certs(true);
    }
    let tls_params = tls_builder
        .build_rustls()
        .map_err(|e| format!("TLS params error: {}", e))?;

    let transport = if use_implicit_tls(account.smtp_secure, smtp_port) {
        AsyncSmtpTransport::<Tokio1Executor>::relay(smtp_host)
            .map_err(|e| format!("SMTP relay error: {}", e))?
            .port(smtp_port)
            .tls(Tls::Wrapper(tls_params))
            .timeout(Some(io_timeout))
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host)
            .map_err(|e| format!("SMTP STARTTLS relay error: {}", e))?
            .port(smtp_port)
            .tls(Tls::Required(tls_params))
            .timeout(Some(io_timeout))
    };

    let transport = if account.is_oauth2() {
        let token = account
            .access_token
            .as_deref()
            .ok_or_else(|| "OAuth2 access token missing for SMTP".to_string())?;
        // Login address, deliberately NOT from_address() — a send-as override
        // changes the identity on the envelope, never who we authenticate as.
        transport
            .credentials(Credentials::new(account.email.clone(), token.to_string()))
            .authentication(vec![Mechanism::Xoauth2])
            .build()
    } else {
        let password = account
            .password
            .as_deref()
            .ok_or_else(|| "Password missing for SMTP".to_string())?;
        // Login address, deliberately NOT from_address() — see above.
        transport
            .credentials(Credentials::new(account.email.clone(), password.to_string()))
            .build()
    };

    Ok(transport)
}

/// Verify SMTP connectivity + auth handshake without sending mail. Uses
/// lettre's `test_connection` (EHLO + handshake) on the built transport.
pub async fn test_connection(account: &ImapConfig) -> Result<(), String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?
        .to_string();
    let smtp_port = account.smtp_port.unwrap_or(587);

    let transport = build_transport(account, Duration::from_secs(15))?;

    match transport.test_connection().await {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!(
            "SMTP server {}:{} did not accept the connection.",
            smtp_host, smtp_port
        )),
        Err(e) => Err(friendly_smtp_error(&smtp_host, smtp_port, account.from_address(), &e.to_string())),
    }
}

/// Send a pre-built MIME message via SMTP. Returns the server response line as
/// `message_id` (existing behavior preserved) and echoes the raw bytes so the
/// caller can APPEND to Sent post-success.
pub async fn send_built(
    account: &ImapConfig,
    email: &OutgoingEmail,
    built: BuiltMime,
) -> Result<SendResult, String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);

    let attachment_bytes: usize = email
        .attachments
        .as_ref()
        .map(|v| v.iter().map(|a| a.content.len()).sum())
        .unwrap_or(0);
    let io_timeout = Duration::from_secs(60 + (attachment_bytes / 50_000) as u64).min(Duration::from_secs(600));

    let transport = build_transport(account, io_timeout)?;

    info!(
        "[smtp] Sending to {} via {}:{} (tls={}, oauth2={})",
        email.to,
        smtp_host,
        smtp_port,
        account.smtp_secure.unwrap_or(false),
        account.is_oauth2()
    );

    let BuiltMime { message, raw_rfc2822 } = built;

    let response = transport
        .send(message)
        .await
        .map_err(|e| friendly_smtp_error(smtp_host, smtp_port, account.from_address(), &e.to_string()))?;

    let message_id = response
        .message()
        .collect::<Vec<_>>()
        .join("");

    info!("Email sent via SMTP to {}: {}", email.to, message_id);
    Ok(SendResult { message_id, raw_rfc2822 })
}

/// Convenience: build + send in one call. Preserved for callers that don't
/// need Drafts staging.
pub async fn send_email(account: &ImapConfig, email: &OutgoingEmail) -> Result<SendResult, String> {
    let built = build_mime(account, email)?;
    send_built(account, email, built).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn implicit_tls_explicit_flag_wins() {
        assert!(use_implicit_tls(Some(true), 587)); // explicit true overrides port
        assert!(!use_implicit_tls(Some(false), 465)); // explicit false overrides port
    }

    #[test]
    fn implicit_tls_inferred_from_port_when_unset() {
        assert!(use_implicit_tls(None, 465)); // 465 = implicit TLS
        assert!(!use_implicit_tls(None, 587)); // 587 = STARTTLS
        assert!(!use_implicit_tls(None, 25));
    }

    #[test]
    fn loopback_host_detection() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LOCALHOST"));
        assert!(!is_loopback_host("smtp.gmail.com"));
    }

    #[test]
    fn error_mapping_classifies_auth_timeout_dns() {
        assert!(friendly_smtp_error("smtp.x.com", 587, "me@x.com", "535 Authentication failed")
            .contains("Authentication failed"));
        assert!(friendly_smtp_error("smtp.x.com", 587, "me@x.com", "operation timed out")
            .contains("timed out"));
        assert!(friendly_smtp_error("smtp.x.com", 587, "me@x.com", "failed to lookup address")
            .contains("resolve"));
    }

    #[test]
    fn error_mapping_falls_back_to_raw() {
        let msg = friendly_smtp_error("smtp.x.com", 465, "me@x.com", "some weird io error");
        assert!(msg.contains("smtp.x.com:465"));
        assert!(msg.contains("some weird io error"));
    }

    // ── send-as identity ─────────────────────────────────────────────────

    fn account(email: &str, from_email: Option<&str>) -> ImapConfig {
        ImapConfig {
            email: email.to_string(),
            password: Some("pw".to_string()),
            host: "imap.fastmail.com".to_string(),
            port: None,
            secure: None,
            security: None,
            auth_type: None,
            access_token: None,
            smtp_host: Some("smtp.fastmail.com".to_string()),
            smtp_port: Some(587),
            smtp_secure: Some(false),
            name: Some("Test User".to_string()),
            oauth2_transport: None,
            from_email: from_email.map(String::from),
        }
    }

    fn outgoing() -> OutgoingEmail {
        OutgoingEmail {
            to: "someone@example.com".to_string(),
            subject: "Hi".to_string(),
            text: Some("body".to_string()),
            html: None,
            cc: None,
            bcc: None,
            in_reply_to: None,
            references: None,
            attachments: None,
        }
    }

    fn headers_of(cfg: &ImapConfig) -> String {
        let built = build_mime(cfg, &outgoing()).expect("build_mime");
        String::from_utf8_lossy(&built.raw_rfc2822).to_string()
    }

    fn from_line(raw: &str) -> String {
        raw.lines()
            .find(|l| l.starts_with("From:"))
            .unwrap_or_else(|| panic!("no From header in: {}", raw))
            .to_string()
    }

    #[test]
    fn from_header_uses_send_as_override() {
        let raw = headers_of(&account("ABC@fastmail.fm", Some("DEF@fastmail.fm")));
        let from = from_line(&raw);
        assert!(from.contains("<DEF@fastmail.fm>"), "From was: {}", from);
        assert!(from.contains("Test User"), "From was: {}", from);
        assert!(!raw.contains("ABC@fastmail.fm"), "login leaked into headers: {}", raw);
        // The reporter explicitly does not want a Reply-To — we must not add one.
        assert!(!raw.to_lowercase().contains("reply-to:"));
    }

    #[test]
    fn from_header_falls_back_to_login() {
        for override_value in [None, Some(""), Some("   ")] {
            let raw = headers_of(&account("ABC@fastmail.fm", override_value));
            assert!(
                from_line(&raw).contains("<ABC@fastmail.fm>"),
                "override {:?} produced: {}", override_value, raw
            );
        }
    }

    fn message_id_line(raw: &str) -> String {
        raw.lines()
            .find(|l| l.to_lowercase().starts_with("message-id:"))
            .unwrap_or_else(|| panic!("no Message-ID header in: {}", raw))
            .to_string()
    }

    #[test]
    fn message_id_domain_follows_from_address() {
        let raw = headers_of(&account("ABC@fastmail.fm", Some("hello@graphicmeat.com")));
        let msg_id = message_id_line(&raw);
        assert!(msg_id.contains("@graphicmeat.com"), "message-id was: {}", msg_id);
        assert!(!msg_id.contains("@fastmail.fm"), "message-id was: {}", msg_id);
    }

    #[test]
    fn message_id_is_bracketed() {
        // RFC 5322 §3.6.4: `msg-id = "<" id-left "@" id-right ">"`. lettre's
        // `.message_id(Some(v))` passes the value through verbatim, so an
        // unbracketed `v` ships an unbracketed — malformed — header.
        let raw = headers_of(&account("ABC@fastmail.fm", Some("hello@graphicmeat.com")));
        let value = message_id_line(&raw)
            .splitn(2, ':')
            .nth(1)
            .expect("message-id value")
            .trim()
            .to_string();
        assert!(value.starts_with('<'), "message-id was: {}", value);
        assert!(value.ends_with('>'), "message-id was: {}", value);
        // Brackets must wrap the whole addr-spec, not just decorate one end.
        let inner = &value[1..value.len() - 1];
        assert!(!inner.contains('<') && !inner.contains('>'), "message-id was: {}", value);
        assert!(inner.contains('@'), "message-id was: {}", value);
    }

    #[test]
    fn from_address_helper_prefers_override() {
        assert_eq!(account("a@x.com", Some("b@x.com")).from_address(), "b@x.com");
        assert_eq!(account("a@x.com", None).from_address(), "a@x.com");
        assert_eq!(account("a@x.com", Some("  ")).from_address(), "a@x.com");
        assert_eq!(account("a@x.com", Some(" b@x.com ")).from_address(), "b@x.com");
    }

    #[test]
    fn error_mapping_flags_send_as_rejection() {
        let cases = [
            "550 5.7.1 Sender address rejected: not owned by user ABC@fastmail.fm",
            "553 5.7.1 <DEF@fastmail.fm>: Sender address rejected",
            "SendAsDenied; DEF@contoso.com not allowed to send as",
        ];
        for raw in cases {
            let msg = friendly_smtp_error("smtp.x.com", 587, "DEF@fastmail.fm", raw);
            assert!(msg.contains("refused to send as DEF@fastmail.fm"), "{} → {}", raw, msg);
        }
    }

    // ── inline images (cid:) ─────────────────────────────────────────────

    fn attachment(filename: &str, content_type: &str, cid: Option<&str>) -> OutgoingAttachment {
        OutgoingAttachment {
            filename: filename.to_string(),
            // Valid base64; the bytes themselves don't matter here.
            content: "iVBORw0KGgo=".to_string(),
            content_type: Some(content_type.to_string()),
            cid: cid.map(String::from),
        }
    }

    fn raw_with(html: Option<&str>, attachments: Vec<OutgoingAttachment>) -> String {
        let mut email = outgoing();
        email.html = html.map(String::from);
        email.attachments = Some(attachments);
        let built = build_mime(&account("me@x.com", None), &email).expect("build_mime");
        String::from_utf8_lossy(&built.raw_rfc2822).to_string()
    }

    #[test]
    fn inline_attachment_builds_multipart_related() {
        let raw = raw_with(
            Some("<p>hi</p><img src=\"cid:logo1\">"),
            vec![attachment("logo.png", "image/png", Some("logo1"))],
        );
        assert!(raw.contains("multipart/related"), "{}", raw);
        assert!(raw.contains("Content-ID: <logo1>"), "{}", raw);
        assert!(raw.contains("Content-Disposition: inline"), "{}", raw);
        // The HTML must survive verbatim or the cid reference dangles.
        assert!(raw.contains("cid:logo1"), "{}", raw);
        // No regular attachments — nothing to wrap in mixed.
        assert!(!raw.contains("multipart/mixed"), "{}", raw);
    }

    #[test]
    fn inline_and_regular_attachments_nest_related_inside_mixed() {
        let raw = raw_with(
            Some("<p>hi</p><img src=\"cid:logo1\">"),
            vec![
                attachment("logo.png", "image/png", Some("logo1")),
                attachment("notes.pdf", "application/pdf", None),
            ],
        );
        let mixed = raw.find("multipart/mixed").expect("multipart/mixed missing");
        let related = raw.find("multipart/related").expect("multipart/related missing");
        assert!(mixed < related, "related must nest inside mixed: {}", raw);
        assert!(
            raw.contains("Content-Disposition: attachment; filename=\"notes.pdf\""),
            "{}",
            raw
        );
    }

    #[test]
    fn regular_attachment_without_cid_keeps_mixed_shape() {
        let raw = raw_with(None, vec![attachment("notes.pdf", "application/pdf", None)]);
        assert!(raw.contains("multipart/mixed"), "{}", raw);
        assert!(!raw.contains("multipart/related"), "{}", raw);
    }

    #[test]
    fn blank_cid_is_a_regular_attachment() {
        let raw = raw_with(None, vec![attachment("notes.pdf", "application/pdf", Some("  "))]);
        assert!(!raw.contains("multipart/related"), "{}", raw);
        assert!(raw.contains("Content-Disposition: attachment"), "{}", raw);
    }

    #[test]
    fn error_mapping_does_not_flag_recipient_550() {
        // Bare 550 is also "recipient mailbox unavailable" — must not be
        // reported as a sender-identity problem.
        let msg = friendly_smtp_error("smtp.x.com", 587, "DEF@fastmail.fm",
            "550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown");
        assert!(!msg.contains("refused to send as"), "{}", msg);
    }
}
