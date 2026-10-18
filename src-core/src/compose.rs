//! The local copy a compose send leaves in the vault before it goes out, and
//! the list row that copy is indexed under. The daemon's `compose.stage` and
//! `compose.send` (`src-daemon/src/handlers/compose.rs`) write both; nothing
//! here touches the disk.
//!
//! The row is the one the app's compose closure used to build itself
//! (`composeSend.js`, before the send moved to the daemon), field for field:
//! a staged copy reads the same in the Sent list whichever side wrote it.

use crate::imap::ImapConfig;
use crate::smtp::{split_address_line, OutgoingEmail};
use serde_json::{json, Value};

/// The flags of a copy that has not gone out yet.
pub const STAGED_FLAGS: [&str; 2] = ["draft", "seen"];
/// The flags of a copy that went out.
pub const SENT_FLAGS: [&str; 2] = ["archived", "seen"];

/// What the list row says about a message that the bytes do not: the plain
/// text of what was written (without the quoted original) and whether the
/// user attached anything (an inline picture is not an attachment). Absent,
/// the row falls back to the text part and the MIME attachment list.
#[derive(Debug, Default, Clone)]
pub struct RowHints {
    pub snippet: Option<String>,
    pub has_attachments: Option<bool>,
}

/// The first 200 characters, as the row's preview.
pub fn snippet_of(text: &str) -> String {
    text.chars().take(200).collect()
}

/// `<id>` for an id with or without its brackets, or `None` for a blank one.
pub fn normalize_message_id(id: &str) -> Option<String> {
    let bare = id.trim().trim_start_matches('<').trim_end_matches('>').trim();
    (!bare.is_empty()).then(|| format!("<{bare}>"))
}

/// The Message-IDs of a References / In-Reply-To value, in order, each once.
pub fn reference_list(raw: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for token in raw.split_whitespace() {
        if let Some(id) = normalize_message_id(token) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// The list row of the copy staged under `uid`, without `flags` or `source`
/// (`with_flags` adds them for the copy's state). `account` is the account
/// as sent: its `name` the display name, its send-as override the From.
/// `date` is when the row was written (`now_iso`).
pub fn staged_row(
    account: &ImapConfig,
    email: &OutgoingEmail,
    uid: u32,
    message_id: Option<&str>,
    hints: &RowHints,
    date: &str,
) -> Value {
    let to: Vec<Value> = split_address_line(&email.to)
        .into_iter()
        .map(|address| json!({"address": address, "name": ""}))
        .collect();
    let references = reference_list(email.references.as_deref().unwrap_or(""));
    let snippet = match &hints.snippet {
        Some(s) => s.clone(),
        None => snippet_of(email.text.as_deref().unwrap_or("")),
    };
    let has_attachments = hints
        .has_attachments
        .unwrap_or_else(|| email.attachments.as_ref().is_some_and(|list| !list.is_empty()));
    let name = account.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| account.email.clone());
    json!({
        "uid": uid,
        "from": {"address": account.from_address(), "name": name},
        "to": to,
        "subject": email.subject,
        "date": date,
        "has_attachments": has_attachments,
        "message_id": message_id,
        "in_reply_to": email.in_reply_to.as_deref().filter(|v| !v.is_empty()),
        "references": if references.is_empty() { Value::Null } else { json!(references) },
        "snippet": snippet,
    })
}

/// `row` as the index stores it for a copy that is staged (`sent: false`,
/// source `local_draft`) or went out (`sent: true`, source `local_sent`).
pub fn with_flags(row: &Value, sent: bool) -> Value {
    let mut row = row.clone();
    let (flags, source) = if sent { (SENT_FLAGS, "local_sent") } else { (STAGED_FLAGS, "local_draft") };
    if let Some(map) = row.as_object_mut() {
        map.insert("flags".into(), json!(flags));
        map.insert("source".into(), json!(source));
    }
    row
}

/// Now, the way the row's `date` is written: RFC 3339, milliseconds, UTC.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Every address the message went out as the user's: the ones given, with
/// the From it went out under first when they do not name it. A message from
/// any of them is the user's own, never the reply a reminder waits for.
pub fn own_addresses_with_from(given: &[String], from: &str) -> Vec<String> {
    let mut own = given.to_vec();
    let from = from.trim();
    if !from.is_empty() && !own.iter().any(|a| a.eq_ignore_ascii_case(from)) {
        own.insert(0, from.to_string());
    }
    own
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> ImapConfig {
        serde_json::from_value(json!({
            "email": "me@example.test", "imapHost": "imap.example.test", "imapPort": 993,
            "name": "Alias name", "fromEmail": "alias@example.test",
        }))
        .unwrap()
    }

    fn email(extra: Value) -> OutgoingEmail {
        let mut base = json!({
            "to": "recipient@example.test, \"Doe, Jane\" <jane@example.test>",
            "subject": "A subject",
            "text": "Hello\n\n-------- Original Message --------\nPrior",
            "inReplyTo": "<parent@example.test>",
            "references": "<root@example.test> parent@example.test <root@example.test>",
        });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    /// The row compose wrote for its staged copy: From the send-as address
    /// under the display name, each recipient as written with no name, the
    /// references once each with brackets, and the hints for what the bytes
    /// cannot say.
    #[test]
    fn the_staged_row_is_the_one_compose_wrote() {
        let hints = RowHints { snippet: Some("Hello".into()), has_attachments: Some(true) };
        let row = staged_row(&account(), &email(json!({})), 1_700_000_000, Some("<one@example.test>"), &hints, "2026-10-18T09:00:00.000Z");
        assert_eq!(
            row,
            json!({
                "uid": 1_700_000_000u32,
                "from": {"address": "alias@example.test", "name": "Alias name"},
                "to": [
                    {"address": "recipient@example.test", "name": ""},
                    {"address": "\"Doe, Jane\" <jane@example.test>", "name": ""},
                ],
                "subject": "A subject",
                "date": "2026-10-18T09:00:00.000Z",
                "has_attachments": true,
                "message_id": "<one@example.test>",
                "in_reply_to": "<parent@example.test>",
                "references": ["<root@example.test>", "<parent@example.test>"],
                "snippet": "Hello",
            })
        );
    }

    #[test]
    fn a_row_without_hints_reads_the_text_part_and_the_attachment_list() {
        let plain = email(json!({"inReplyTo": "", "references": null, "text": "x".repeat(300)}));
        let row = staged_row(&account(), &plain, 7, None, &RowHints::default(), "d");
        assert_eq!(row["snippet"], json!("x".repeat(200)));
        assert_eq!(row["has_attachments"], json!(false));
        assert_eq!(row["message_id"], Value::Null);
        assert_eq!(row["in_reply_to"], Value::Null, "an empty In-Reply-To is none");
        assert_eq!(row["references"], Value::Null, "no references is null, not an empty list");

        let attached = email(json!({"attachments": [{"filename": "a.txt", "content": "aGk=", "contentType": "text/plain"}]}));
        assert_eq!(staged_row(&account(), &attached, 7, None, &RowHints::default(), "d")["has_attachments"], json!(true));
    }

    #[test]
    fn the_display_name_falls_back_to_the_login() {
        let mut acct = account();
        acct.name = None;
        acct.from_email = None;
        let row = staged_row(&acct, &email(json!({})), 1, None, &RowHints::default(), "d");
        assert_eq!(row["from"], json!({"address": "me@example.test", "name": "me@example.test"}));
    }

    #[test]
    fn flags_and_source_follow_the_copy() {
        let row = json!({"uid": 1});
        assert_eq!(with_flags(&row, false), json!({"uid": 1, "flags": ["draft", "seen"], "source": "local_draft"}));
        assert_eq!(with_flags(&row, true), json!({"uid": 1, "flags": ["archived", "seen"], "source": "local_sent"}));
    }

    #[test]
    fn the_row_date_is_milliseconds_in_utc() {
        let now = now_iso();
        assert!(now.ends_with('Z') && now.len() == "2026-10-18T09:00:00.000Z".len(), "{now}");
    }

    #[test]
    fn the_from_joins_the_own_addresses_once() {
        let given = vec!["me@example.test".to_string()];
        assert_eq!(own_addresses_with_from(&given, "alias@example.test"), vec!["alias@example.test", "me@example.test"]);
        assert_eq!(own_addresses_with_from(&given, "ME@example.test"), vec!["me@example.test"]);
        assert_eq!(own_addresses_with_from(&[], ""), Vec::<String>::new());
    }
}
