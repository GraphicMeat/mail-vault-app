//! What counts as an answer to a sent message, and when a server's refusal
//! is only a reason to try again. (Named `matcher`: `match` is a keyword.)

use crate::{custody::cache as sql_cache, maildir, notes_to_self};
use serde_json::{json, Value};

/// A NO or BAD the server marks temporary: core's one transient-refusal
/// check (`imap::refusal::is_transient_refusal`: RFC 5530 codes and a too-many-
/// connections `[ALERT]`), plus what a reply search also reads as temporary,
/// `[EXPUNGEISSUED]` and Exchange's "server unavailable". A try to repeat,
/// never a refusal that the cache's answer can settle.
pub fn temporary_refusal(why: &str) -> bool {
    if crate::imap::refusal::is_transient_refusal(why) {
        return true;
    }
    let why = why.to_ascii_lowercase();
    why.contains("[expungeissued]") || why.contains("server unavailable")
}

/// Is `address` one of `own`, folded like the app's `normalizeEmailIdentity`
/// (a Gmail login is one inbox however its address is spelled)?
pub fn is_own_address(own: &[String], address: &str) -> bool {
    let address = notes_to_self::normalize_identity(address);
    own.iter().any(|a| notes_to_self::normalize_identity(a) == address)
}

/// Is any of the `from` addresses someone other than the sender (`own`)?
pub fn any_from_someone_else<'a>(from: impl IntoIterator<Item = &'a str>, own: &[String]) -> bool {
    from.into_iter().any(|address| !is_own_address(own, address))
}

/// Is `email` (a JMAP email read with the reply properties: `from`,
/// `subject`, `keywords`, `inReplyTo`, `references` and the `Auto-Submitted`,
/// `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress` headers) an
/// answer to `term` (a bare Message-ID) from someone else? It names the
/// message in In-Reply-To or References (exactly, any case: the `header`
/// filter matched a substring), is no draft, is not from one of `own`, and is
/// neither marked nor titled like an automatic reply.
pub fn jmap_reply_from_someone_else(email: &Value, term: &str, own: &[String]) -> bool {
    let names_it = |prop: &str| {
        email[prop]
            .as_array()
            .is_some_and(|ids| ids.iter().filter_map(Value::as_str).any(|m| maildir::normalize_message_id(m).eq_ignore_ascii_case(term)))
    };
    let draft = email["keywords"]
        .as_object()
        .is_some_and(|k| k.iter().any(|(name, on)| name.eq_ignore_ascii_case("$draft") && on.as_bool() == Some(true)));
    let automatic = email["header:Auto-Submitted:asText"].as_str().is_some_and(|v| !v.trim().eq_ignore_ascii_case("no"))
        || ["header:X-Autoreply:asText", "header:X-Autorespond:asText", "header:X-Auto-Response-Suppress:asText"]
            .iter()
            .any(|prop| !email[*prop].is_null())
        || sql_cache::is_auto_reply_subject(email["subject"].as_str().unwrap_or_default());
    let from = email["from"].as_array().and_then(|a| a.first()).and_then(|f| f["email"].as_str()).unwrap_or_default();
    (names_it("inReplyTo") || names_it("references")) && !draft && !automatic && !is_own_address(own, from)
}

/// The header properties a JMAP reply is read back with: the automatic-reply
/// markers the IMAP search leaves out (`imap::reply_search_criteria`).
pub const JMAP_REPLY_PROPS: [&str; 10] = [
    "id",
    "from",
    "subject",
    "keywords",
    "inReplyTo",
    "references",
    "header:Auto-Submitted:asText",
    "header:X-Autoreply:asText",
    "header:X-Autorespond:asText",
    "header:X-Auto-Response-Suppress:asText",
];

/// The JMAP `Email/query` filter for mail whose In-Reply-To or References
/// names `term` (a bare Message-ID), outside the `skip` mailbox ids (Sent and
/// Drafts). The hits are read back with `JMAP_REPLY_PROPS` and judged by
/// `jmap_reply_from_someone_else`.
pub fn jmap_reply_filter(term: &str, skip: &[String]) -> Value {
    let names_it = json!({"operator": "OR", "conditions": [{"header": ["In-Reply-To", term]}, {"header": ["References", term]}]});
    if skip.is_empty() {
        names_it
    } else {
        json!({"operator": "AND", "conditions": [{"inMailboxOtherThan": skip}, names_it]})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn own() -> Vec<String> {
        vec!["me@example.com".into(), "John.Doe@gmail.com".into()]
    }

    fn reply(extra: Value) -> Value {
        let mut e = json!({"from":[{"email":"bob@example.test"}],"subject":"Re: Quote","keywords":{},"inReplyTo":["<sent1@x>"],"references":["<sent1@x>"]});
        for (k, v) in extra.as_object().unwrap() {
            e[k] = v.clone();
        }
        e
    }

    #[test]
    fn a_temporary_refusal_is_told_by_its_response_code_or_wording() {
        assert!(temporary_refusal("NO [UNAVAILABLE] Backend down"));
        assert!(temporary_refusal("[inuse] busy"));
        assert!(temporary_refusal("Server Unavailable"));
        assert!(!temporary_refusal("NO [NONEXISTENT] Unknown mailbox"));
        assert!(!temporary_refusal(""));
        // The shared check's cases count too.
        assert!(temporary_refusal("NO [LIMIT] Too many connections"));
        assert!(temporary_refusal("NO [EXPUNGEISSUED] Some of the requested messages no longer exist"));
    }

    #[test]
    fn own_addresses_fold_like_the_app_does() {
        assert!(is_own_address(&own(), "ME@example.com"));
        assert!(is_own_address(&own(), "johndoe+x@gmail.com"));
        assert!(!is_own_address(&own(), "bob@example.test"));
        assert!(any_from_someone_else(["me@example.com", "bob@example.test"], &own()));
        assert!(!any_from_someone_else(["me@example.com", "john.doe@gmail.com"], &own()));
        assert!(!any_from_someone_else([], &own()));
    }

    #[test]
    fn a_jmap_reply_from_someone_else_counts() {
        assert!(jmap_reply_from_someone_else(&reply(json!({})), "sent1@x", &own()));
        // Any case, and either header.
        assert!(jmap_reply_from_someone_else(&reply(json!({"inReplyTo":null,"references":["<SENT1@X>"]})), "sent1@x", &own()));
    }

    #[test]
    fn a_jmap_draft_own_mail_or_unrelated_mail_is_no_reply() {
        assert!(!jmap_reply_from_someone_else(&reply(json!({"keywords":{"$draft":true}})), "sent1@x", &own()));
        assert!(jmap_reply_from_someone_else(&reply(json!({"keywords":{"$draft":false}})), "sent1@x", &own()));
        assert!(!jmap_reply_from_someone_else(&reply(json!({"from":[{"email":"john.doe@gmail.com"}]})), "sent1@x", &own()));
        assert!(!jmap_reply_from_someone_else(&reply(json!({})), "other@x", &own()));
    }

    #[test]
    fn the_jmap_reply_filter_names_the_message_outside_the_skipped_mailboxes() {
        let names = json!({"operator": "OR", "conditions": [{"header": ["In-Reply-To", "q@me"]}, {"header": ["References", "q@me"]}]});
        assert_eq!(jmap_reply_filter("q@me", &[]), names);
        assert_eq!(
            jmap_reply_filter("q@me", &["mb-sent".into(), "mb-drafts".into()]),
            json!({"operator": "AND", "conditions": [{"inMailboxOtherThan": ["mb-sent", "mb-drafts"]}, names]})
        );
        assert!(JMAP_REPLY_PROPS.contains(&"header:Auto-Submitted:asText"));
    }

    #[test]
    fn a_jmap_automatic_reply_is_no_reply() {
        assert!(!jmap_reply_from_someone_else(&reply(json!({"header:Auto-Submitted:asText":" auto-replied"})), "sent1@x", &own()));
        assert!(jmap_reply_from_someone_else(&reply(json!({"header:Auto-Submitted:asText":"no"})), "sent1@x", &own()));
        assert!(!jmap_reply_from_someone_else(&reply(json!({"header:X-Autoreply:asText":"yes"})), "sent1@x", &own()));
        assert!(!jmap_reply_from_someone_else(&reply(json!({"subject":"Automatic reply: Quote"})), "sent1@x", &own()));
    }
}
