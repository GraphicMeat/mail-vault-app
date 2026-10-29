//! Pure new-mail presentation and banner exclusion. Source proof, admission,
//! provider reads and OS delivery stay with the daemon and UI owners.

use serde_json::{json, Map, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub uid: u32,
    pub sender: Option<String>,
    pub from_address: String,
    pub subject: Option<String>,
    pub snippet: Option<String>,
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// Only an exact cached arrival row may supply a preview or click target.
pub fn preview(header: &Value) -> Option<Preview> {
    let uid = header.get("uid")?.as_u64().and_then(|uid| u32::try_from(uid).ok())?;
    if uid == 0 { return None; }
    let from = header.get("from");
    let address = if from.is_some_and(Value::is_string) {
        nonempty(from).unwrap_or_default()
    } else {
        nonempty(from.and_then(|from| from.get("address"))).unwrap_or_default()
    };
    let sender = if from.is_some_and(Value::is_string) {
        nonempty(from)
    } else {
        nonempty(from.and_then(|from| from.get("name")))
            .or_else(|| nonempty(from.and_then(|from| from.get("address"))))
            .or_else(|| nonempty(header.get("sender")))
    };
    Some(Preview {
        uid, sender, from_address: if address.contains('@') { address } else { String::new() },
        subject: nonempty(header.get("subject")),
        snippet: nonempty(header.get("snippet")),
    })
}

pub fn normalized_sound(raw: Option<&str>) -> &'static str {
    match raw {
        Some("Glass") => "Glass", Some("Ping") => "Ping", Some("Pop") => "Pop",
        Some("Purr") => "Purr", Some("Tink") => "Tink", _ => "none",
    }
}

/// The UI renders this key's registered title/body templates. Missing sender
/// and subject are explicit absent fields, rendered with catalog fallback keys.
pub fn presentation(count: usize, account_email: &str, show_preview: bool,
    newest: Option<&Preview>, code: Option<&str>) -> Value {
    let named = show_preview && newest.is_some();
    let single = count == 1;
    let (kind, key) = match (single, named, code.is_some()) {
        (true, true, true) => ("singlePreview", "notify.arrival.singlePreviewCode"),
        (true, true, false) => ("singlePreview", "notify.arrival.singlePreview"),
        (false, true, _) => ("batchPreview", "notify.arrival.batchPreview"),
        (true, false, _) => ("singlePrivate", "notify.arrival.singlePrivate"),
        (false, false, _) => ("batchPrivate", "notify.arrival.batchPrivate"),
    };
    let mut data = Map::new();
    data.insert("count".into(), json!(count));
    data.insert("accountEmail".into(), json!(account_email));
    if named {
        if let Some(sender) = newest.and_then(|row| row.sender.as_ref()) {
            data.insert("sender".into(), json!(sender));
        }
        if let Some(subject) = newest.and_then(|row| row.subject.as_ref()) {
            data.insert("subject".into(), json!(subject));
        }
        if single {
            if let Some(code) = code.filter(|code| !code.is_empty()) {
                data.insert("code".into(), json!(code));
            }
        }
    }
    json!({"kind":kind,"key":key,"data":data})
}

fn outgoing_leaf(mailbox: &str) -> bool {
    let leaf = mailbox.rsplit(['/', '.']).next().unwrap_or("").trim().to_lowercase();
    matches!(leaf.as_str(),
        "sent" | "sent items" | "sent mail" | "sent messages" | "outbox" |
        "gesendet" | "gesendete elemente" | "gesendete objekte" |
        "envoyés" | "envoyes" | "messages envoyés" | "messages envoyes" |
        "enviados" | "elementos enviados" | "correo enviado" |
        "inviati" | "posta inviata" | "verzonden" | "verzonden items" |
        "skickat" | "skickade objekt" | "sendt" | "sendte elementer" |
        "lähetetyt" | "lahetetyt" | "wyslane" | "wysłane" |
        "отправленные" | "已发送" | "已寄出" | "送信済み" | "보낸 편지함")
}

/// A batch may contain other people's mail even when its newest sender is us.
pub fn banner_allowed(count: usize, mailbox: &str, sent_override: Option<&str>,
    special_use_sent: bool, from_address: &str, own_addresses: &[String]) -> bool {
    if count == 0 || outgoing_leaf(mailbox) || special_use_sent
        || sent_override.is_some_and(|sent| sent == mailbox) { return false; }
    if count != 1 { return true; }
    let sender = crate::aliases::mailbox_identity(from_address);
    sender.is_empty() || !own_addresses.iter()
        .any(|own| crate::aliases::mailbox_identity(own) == sender)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_uid_sound_and_private_batch_boundaries() {
        for uid in [json!(0), json!("7"), json!(4_294_967_296_u64), json!(1.5)] {
            assert!(preview(&json!({"uid":uid,"from":"sender@test"})).is_none(),
                "a nonpositive or unsafe UID cannot become a preview target: {uid:?}");
        }
        let row = preview(&json!({"uid":7,"from":{"address":"sender@test"},
            "subject":"","snippet":""})).unwrap();
        assert_eq!(row.sender.as_deref(), Some("sender@test"));
        assert_eq!(row.subject, None);
        for sound in ["Glass", "Ping", "Pop", "Purr", "Tink"] {
            assert_eq!(normalized_sound(Some(sound)), sound);
        }
        assert_eq!(normalized_sound(None), "none");
        assert_eq!(normalized_sound(Some("custom")), "none");
        let single = presentation(1, "a@test", true, Some(&row), Some("364758"));
        assert_eq!(single["kind"], "singlePreview");
        assert_eq!(single["key"], "notify.arrival.singlePreviewCode");
        assert_eq!(single["data"]["code"], "364758");
        assert!(single["data"].get("subject").is_none(),
            "the renderer must use the shared missing-subject fallback");
        let batch = presentation(2, "a@test", true, Some(&row), Some("364758"));
        assert_eq!(batch["kind"], "batchPreview");
        assert!(batch["data"].get("code").is_none(),
            "a batch banner never carries its newest message's code");
        let private = presentation(2, "a@test", false, Some(&row), Some("364758"));
        assert_eq!(private["kind"], "batchPrivate");
        assert!(private["data"].get("sender").is_none()
            && private["data"].get("subject").is_none()
            && private["data"].get("code").is_none());
    }

    #[test]
    fn string_sender_is_both_label_and_policy_address() {
        let row = preview(&json!({"uid":42,"from":"sender@outside.test","subject":"Hello"})).unwrap();
        assert_eq!(row.sender.as_deref(), Some("sender@outside.test"));
        assert_eq!(row.from_address, "sender@outside.test");
        assert_eq!(presentation(1, "me@test", true, Some(&row), None)["data"]["sender"],
            json!("sender@outside.test"));
    }

    #[test]
    fn sent_and_lone_own_are_silent_but_batch_is_not_inferred_from_newest() {
        let own = vec!["j.doe+work@gmail.com".to_owned()];
        assert!(!banner_allowed(1, "INBOX", None, false, "jdoe@gmail.com", &own));
        assert!(banner_allowed(2, "INBOX", None, false, "jdoe@gmail.com", &own));
        assert!(!banner_allowed(2, "[Gmail]/Sent Mail", None, false, "other@test", &own));
        assert!(!banner_allowed(1, "Custom", Some("Custom"), false, "other@test", &own));
        assert!(!banner_allowed(1, "Other", None, true, "other@test", &own));
        assert!(banner_allowed(1, "Sentinel", None, false, "other@test", &own));
    }

    #[test]
    fn missing_preview_or_disabled_preview_has_no_message_fields() {
        let row = preview(&json!({"uid":7,"from":{"name":"Sender","address":"s@test"},"subject":"Secret"})).unwrap();
        let missing = presentation(1, "a@test", true, None, Some("123456"));
        let private = presentation(1, "a@test", false, Some(&row), Some("123456"));
        assert_eq!(missing["kind"], "singlePrivate");
        assert_eq!(private["kind"], "singlePrivate");
        assert!(missing["data"].get("sender").is_none());
        assert!(private["data"].get("code").is_none());
        assert_eq!(normalized_sound(Some("Bad sound")), "none");
    }
}
