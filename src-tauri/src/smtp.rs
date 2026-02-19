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

pub async fn send_email(account: &ImapConfig, email: &OutgoingEmail) -> Result<String, String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);

    let from_name = account.name.as_deref().unwrap_or(&account.email);
    let from_mailbox: Mailbox = format!("{} <{}>", from_name, account.email)
        .parse()
        .map_err(|e| format!("Invalid from address: {}", e))?;

    let to_mailbox: Mailbox = email
        .to
        .parse()
        .map_err(|e| format!("Invalid to address: {}", e))?;

    let mut builder = Message::builder()
        .from(from_mailbox)
        .to(to_mailbox)
        .subject(&email.subject);

    if let Some(ref cc) = email.cc {
        if !cc.is_empty() {
            if let Ok(cc_mbox) = cc.parse::<Mailbox>() {
                builder = builder.cc(cc_mbox);
            }
        }
    }

    if let Some(ref bcc) = email.bcc {
        if !bcc.is_empty() {
            if let Ok(bcc_mbox) = bcc.parse::<Mailbox>() {
                builder = builder.bcc(bcc_mbox);
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

    let response = transport
        .send(message)
        .await
        .map_err(|e| format!("SMTP send failed: {}", e))?;

    let message_id = response
        .message()
        .collect::<Vec<_>>()
        .join("");

    info!("Email sent via SMTP to {}: {}", email.to, message_id);
    Ok(message_id)
}
