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

/// Decide implicit-TLS (wrapper, typically port 465) vs STARTTLS (587).
/// Explicit `smtp_secure` wins; when absent, infer from the port so a config
/// missing the flag still picks the right handshake.
fn use_implicit_tls(smtp_secure: Option<bool>, smtp_port: u16) -> bool {
    match smtp_secure {
        Some(v) => v,
        None => smtp_port == 465,
    }
}

/// Map a raw lettre SMTP error string to a human-readable message. Kept pure
/// (takes the stringified error) so the classification is unit-testable.
fn friendly_smtp_error(host: &str, port: u16, err_str: &str) -> String {
    let lower = err_str.to_lowercase();
    if lower.contains("auth") || lower.contains("535") || lower.contains("credential") {
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

    let tls_params = TlsParameters::builder(smtp_host.to_string())
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
        Err(e) => Err(friendly_smtp_error(&smtp_host, smtp_port, &e.to_string())),
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
    fn error_mapping_classifies_auth_timeout_dns() {
        assert!(friendly_smtp_error("smtp.x.com", 587, "535 Authentication failed")
            .contains("Authentication failed"));
        assert!(friendly_smtp_error("smtp.x.com", 587, "operation timed out")
            .contains("timed out"));
        assert!(friendly_smtp_error("smtp.x.com", 587, "failed to lookup address")
            .contains("resolve"));
    }

    #[test]
    fn error_mapping_falls_back_to_raw() {
        let msg = friendly_smtp_error("smtp.x.com", 465, "some weird io error");
        assert!(msg.contains("smtp.x.com:465"));
        assert!(msg.contains("some weird io error"));
    }
}
