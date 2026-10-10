//! JMAP Email properties as the app's `EmailHeader`, and keywords as IMAP flags.

use crate::imap::{EmailAddress, EmailHeader};
use serde_json::Value;

/// What a header fetch asks `Email/get` for. The `header:` entries use the raw
/// form, which RFC 8621 §4.1.2.1 allows for every field (`asText` is refused
/// for RFC 5322 and RFC 2369 fields such as Return-Path and List-Unsubscribe,
/// and a refused property fails the whole call); `to_header` unfolds them.
pub const HEADER_PROPS: &[&str] = &[
    "id",
    "blobId",
    "threadId",
    "mailboxIds",
    "keywords",
    "size",
    "receivedAt",
    "messageId",
    "inReplyTo",
    "references",
    "from",
    "to",
    "cc",
    "bcc",
    "replyTo",
    "subject",
    "sentAt",
    "hasAttachment",
    "preview",
    "header:List-Unsubscribe",
    "header:List-Unsubscribe-Post",
    "header:List-Id",
    "header:Precedence",
    "header:Authentication-Results",
    "header:Return-Path",
    "header:Auto-Submitted",
    "header:X-Autoreply",
    "header:X-Autorespond",
    "header:X-Auto-Response-Suppress",
];

/// JMAP system keywords and the IMAP flags they stand for, in the order
/// `keywords_to_flags` lists them.
const SYSTEM_KEYWORDS: [(&str, &str); 4] =
    [("$seen", "\\Seen"), ("$answered", "\\Answered"), ("$flagged", "\\Flagged"), ("$draft", "\\Draft")];

/// The keywords set to `true`, as IMAP flags: system flags first (Seen,
/// Answered, Flagged, Draft), then every other keyword verbatim in key order.
pub fn keywords_to_flags(k: &Value) -> Vec<String> {
    let Some(map) = k.as_object() else { return Vec::new() };
    let on: Vec<&String> = map.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k).collect();
    let mut flags = Vec::with_capacity(on.len());
    for (keyword, flag) in SYSTEM_KEYWORDS {
        if on.iter().any(|k| k.eq_ignore_ascii_case(keyword)) {
            flags.push(flag.to_string());
        }
    }
    for k in on {
        if !SYSTEM_KEYWORDS.iter().any(|(keyword, _)| k.eq_ignore_ascii_case(keyword)) {
            flags.push(k.clone());
        }
    }
    flags
}

/// The inverse of `keywords_to_flags`: `\Seen` -> `$seen` (any case), other
/// flags verbatim.
pub fn flag_to_keyword(flag: &str) -> String {
    SYSTEM_KEYWORDS
        .iter()
        .find(|(_, f)| f.eq_ignore_ascii_case(flag))
        .map(|(keyword, _)| keyword.to_string())
        .unwrap_or_else(|| flag.to_string())
}

/// IMAP flags as the keywords an `Email/import` may carry: system flags as
/// `$seen` and the like (`flag_to_keyword`), other keywords verbatim, and
/// anything RFC 8621 §4.1.1 refuses dropped (`\Deleted`, `\Recent`, a
/// backslash, a bracket, a space), since one bad keyword fails the import.
pub fn flags_to_keywords<'a>(flags: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let allowed = |k: &str| {
        !k.is_empty() && k.len() <= 255 && k.bytes().all(|b| (0x21..=0x7e).contains(&b) && !b"(){]%*\"\\".contains(&b))
    };
    let mut out: Vec<String> = Vec::new();
    for keyword in flags.into_iter().map(flag_to_keyword) {
        if allowed(&keyword) && !out.iter().any(|k| k.eq_ignore_ascii_case(&keyword)) {
            out.push(keyword);
        }
    }
    out
}

/// A raw header value unfolded the way `imap::parse_single_header` does: each
/// line trimmed, joined by one space. `None` when absent or blank.
fn raw_header(email: &Value, prop: &str) -> Option<String> {
    let raw = email[prop].as_str()?;
    let value = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

/// JMAP message ids come without angle brackets; the app keeps them with.
fn bracketed(email: &Value, prop: &str) -> Option<Vec<String>> {
    let ids: Vec<String> = email[prop]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(|id| format!("<{}>", id.trim().trim_start_matches('<').trim_end_matches('>')))
        .collect();
    (!ids.is_empty()).then_some(ids)
}

fn address(v: &Value) -> EmailAddress {
    EmailAddress {
        name: v["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string),
        address: v["email"].as_str().unwrap_or_default().to_string(),
    }
}

fn addresses(email: &Value, prop: &str) -> Vec<EmailAddress> {
    email[prop].as_array().map(|a| a.iter().map(address).collect()).unwrap_or_default()
}

/// What `imap::auto_reply_marker` reports: `Auto-Submitted` lowercased
/// unless "no", else the lowercased name of the first X-Auto* field present.
fn auto_reply(email: &Value) -> Option<String> {
    if let Some(value) = raw_header(email, "header:Auto-Submitted") {
        let value = value.to_lowercase();
        if value != "no" {
            return Some(value);
        }
    }
    ["X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress"]
        .into_iter()
        .find(|field| email[format!("header:{field}")].is_string())
        .map(str::to_ascii_lowercase)
}

/// An `Email/get` object (fetched with `HEADER_PROPS`) as the app's header
/// row. `uid` is the ledger's uid for this email in this mailbox. Dates follow
/// Graph's mapping: `date` and `internalDate` are `receivedAt`, `messageDate`
/// is `sentAt`.
pub fn to_header(email: &Value, uid: u32) -> EmailHeader {
    let text = |prop: &str| email[prop].as_str().map(str::to_string);
    let received_at = text("receivedAt");
    let sent_at = text("sentAt");
    EmailHeader {
        uid,
        seq: uid,
        display_index: None,
        message_id: bracketed(email, "messageId").and_then(|ids| ids.into_iter().next()),
        in_reply_to: bracketed(email, "inReplyTo").map(|ids| ids.join(" ")),
        references: bracketed(email, "references"),
        subject: text("subject").unwrap_or_else(|| "(No Subject)".to_string()),
        from: email["from"].as_array().and_then(|a| a.first()).map(address).unwrap_or_default(),
        to: addresses(email, "to"),
        cc: addresses(email, "cc"),
        bcc: addresses(email, "bcc"),
        message_date: sent_at.clone(),
        received_at: received_at.clone(),
        sent_at,
        date: received_at.clone(),
        internal_date: received_at,
        flags: keywords_to_flags(&email["keywords"]),
        size: email["size"].as_u64().and_then(|s| u32::try_from(s).ok()),
        has_attachments: email["hasAttachment"].as_bool().unwrap_or(false),
        source: Some("jmap".to_string()),
        reply_to: email["replyTo"].as_array().and_then(|a| a.first()).map(address),
        return_path: raw_header(email, "header:Return-Path"),
        authentication_results: raw_header(email, "header:Authentication-Results"),
        list_unsubscribe: raw_header(email, "header:List-Unsubscribe"),
        list_unsubscribe_post: raw_header(email, "header:List-Unsubscribe-Post"),
        list_id: raw_header(email, "header:List-Id"),
        precedence: raw_header(email, "header:Precedence"),
        auto_reply: auto_reply(email),
    }
}
