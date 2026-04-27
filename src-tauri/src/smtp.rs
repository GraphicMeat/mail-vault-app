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
    let from_mailbox: Mailbox = {
        let addr: lettre::Address = account.email.parse()
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
    let domain = account.email.splitn(2, '@').nth(1).unwrap_or("mailvault.local");
    let msg_id_value = format!(
        "{}.{}@{}",
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

    // Build body multipart (alternative: text + html) or singlepart.
    let has_attachments = email.attachments.as_ref().map_or(false, |a| !a.is_empty());

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

    let message = if has_attachments {
        // multipart/mixed: body + each attachment.
        let mut mixed = MultiPart::mixed().build();
        if let Some(body) = body_multipart {
            mixed = mixed.multipart(body);
        } else if let Some(ref html) = email.html {
            mixed = mixed.singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_HTML)
                    .body(html.clone()),
            );
        } else {
            mixed = mixed.singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(email.text.clone().unwrap_or_default()),
            );
        }

        for att in email.attachments.as_ref().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(att.content.as_bytes())
                .map_err(|e| format!("Invalid base64 for attachment '{}': {}", att.filename, e))?;
            let ct = att
                .content_type
                .as_deref()
                .and_then(|s| ContentType::parse(s).ok())
                .unwrap_or_else(|| ContentType::parse("application/octet-stream").unwrap());
            mixed = mixed.singlepart(Attachment::new(att.filename.clone()).body(bytes, ct));
        }

        builder
            .multipart(mixed)
            .map_err(|e| format!("Failed to build multipart message: {}", e))?
    } else if let Some(body) = body_multipart {
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
    };

    let raw_rfc2822 = message.formatted();
    Ok(BuiltMime { message, raw_rfc2822 })
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

    let tls_params = TlsParameters::builder(smtp_host.to_string())
        .build_rustls()
        .map_err(|e| format!("TLS params error: {}", e))?;

    let attachment_bytes: usize = email
        .attachments
        .as_ref()
        .map(|v| v.iter().map(|a| a.content.len()).sum())
        .unwrap_or(0);
    let io_timeout = Duration::from_secs(60 + (attachment_bytes / 50_000) as u64).min(Duration::from_secs(600));

    let transport = if account.smtp_secure.unwrap_or(false) {
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
        transport
            .credentials(Credentials::new(account.email.clone(), token.to_string()))
            .authentication(vec![Mechanism::Xoauth2])
            .build()
    } else {
        let password = account
            .password
            .as_deref()
            .ok_or_else(|| "Password missing for SMTP".to_string())?;
        transport
            .credentials(Credentials::new(
                account.email.clone(),
                password.to_string(),
            ))
            .build()
    };

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
        .map_err(|e| format!("SMTP send failed ({}:{}): {}", smtp_host, smtp_port, e))?;

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
