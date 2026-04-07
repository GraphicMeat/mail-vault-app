//! Shared email types used across daemon and Tauri app.

use serde::{Deserialize, Serialize};

/// Lightweight email header — the minimum data needed for list rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailHeader {
    pub uid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: Option<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub date: String,
    pub flags: Vec<String>,
    #[serde(default)]
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// Email address with optional display name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailAddress {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Full parsed email with body and attachments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedEmail {
    pub uid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: Option<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub date: String,
    pub flags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    pub attachments: Vec<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
}

/// Email attachment metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
}

/// Mailbox status from IMAP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxStatus {
    pub exists: u32,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub highest_modseq: Option<u64>,
}
