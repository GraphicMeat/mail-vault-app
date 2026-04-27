use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;
use tracing::info;

use crate::imap::ImapConfig;

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

pub async fn send_email(account: &ImapConfig, email: &OutgoingEmail) -> Result<String, String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);

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

    let mut builder = Message::builder()
        .from(from_mailbox)
        .subject(&email.subject);
    for mb in to_mailboxes {
        builder = builder.to(mb);
    }

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

    // Build message body
    let message = if email.html.is_some() && email.text.is_some() {
        builder
            .multipart(
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

    // Build SMTP transport
    let tls_params = TlsParameters::builder(smtp_host.to_string())
        .build_rustls()
        .map_err(|e| format!("TLS params error: {}", e))?;

    let transport = if account.smtp_secure.unwrap_or(false) {
        // Port 465: implicit TLS
        AsyncSmtpTransport::<Tokio1Executor>::relay(smtp_host)
            .map_err(|e| format!("SMTP relay error: {}", e))?
            .port(smtp_port)
            .tls(Tls::Wrapper(tls_params))
    } else {
        // Port 587: STARTTLS
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host)
            .map_err(|e| format!("SMTP STARTTLS relay error: {}", e))?
            .port(smtp_port)
            .tls(Tls::Required(tls_params))
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

    let response = transport
        .send(message)
        .await
        .map_err(|e| format!("SMTP send failed ({}:{}): {}", smtp_host, smtp_port, e))?;

    let message_id = response
        .message()
        .collect::<Vec<_>>()
        .join("");

    info!("Email sent via SMTP to {}: {}", email.to, message_id);
    Ok(message_id)
}
