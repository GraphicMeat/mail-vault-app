//! Stable per-message identity for app-owned metadata (tags, custom field
//! values, saved-view membership).
//!
//! The app's own `emailKey` and the retired `localMailLabelKey` are
//! `[account, mailbox, uid]`, which does not survive a move (an IMAP uid is
//! per-mailbox) or a Graph resync (those vault files are named by listing
//! position). Metadata keyed that way reattaches to the wrong message.
//!
//! So: the Message-ID when the message has one, and only then the mailbox
//! plus uid. Two copies of one message in two folders share a key, which is
//! what "a tag is independent of the folder" means.

/// The key app-owned metadata is stored under.
pub fn msg_key(message_id: Option<&str>, vault_dir: &str, uid: u32) -> String {
    let id = bare_id(message_id);
    if id.is_empty() {
        return format!("u:{vault_dir}:{uid}");
    }
    id.to_string()
}

/// The Message-ID as the key holds it: trimmed, without its angle brackets.
fn bare_id(message_id: Option<&str>) -> &str {
    let id = message_id.unwrap_or("").trim();
    let id = id.strip_prefix('<').unwrap_or(id);
    id.strip_suffix('>').unwrap_or(id).trim()
}

/// [`msg_key`] for a store whose uids are not the server's (the phone's Graph and JMAP accounts:
/// local uids handed out per remote id, mobile engine `remote_ids.rs`). The Message-ID when the
/// message has one; else, when the server names it by an opaque id, `r:<remote_id>`, which a
/// resync keeps (a uid there is only the phone's); else the mailbox plus uid, as [`msg_key`]
/// spells it, so an IMAP message without a Message-ID keys as it does on desktop.
pub fn msg_key_or_remote(message_id: Option<&str>, vault_dir: &str, uid: u32, remote_id: Option<&str>) -> String {
    match remote_id.map(str::trim).filter(|r| !r.is_empty()) {
        Some(remote) if bare_id(message_id).is_empty() => format!("r:{remote}"),
        _ => msg_key(message_id, vault_dir, uid),
    }
}

/// Whether `key` is [`msg_key`]'s mailbox-plus-uid fallback: meaningful only where uids are the
/// server's (an IMAP account), never across stores that number messages their own way.
pub fn is_uid_fallback(key: &str) -> bool {
    key.starts_with("u:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_id_is_the_key_without_its_angle_brackets() {
        assert_eq!(msg_key(Some("<abc@example.com>"), "INBOX", 7), "abc@example.com");
    }

    #[test]
    fn surrounding_whitespace_never_forks_the_key() {
        assert_eq!(msg_key(Some("  <abc@example.com>\r\n"), "INBOX", 7), "abc@example.com");
    }

    #[test]
    fn the_same_message_in_two_folders_shares_one_key() {
        assert_eq!(
            msg_key(Some("<abc@example.com>"), "INBOX", 7),
            msg_key(Some("<abc@example.com>"), "Archive", 91)
        );
    }

    #[test]
    fn a_message_without_a_message_id_falls_back_to_its_mailbox_and_uid() {
        assert_eq!(msg_key(None, "INBOX", 7), "u:INBOX:7");
    }

    #[test]
    fn an_empty_message_id_is_not_an_identity() {
        assert_eq!(msg_key(Some("   "), "INBOX", 7), "u:INBOX:7");
        assert_eq!(msg_key(Some("<>"), "INBOX", 7), "u:INBOX:7");
    }

    #[test]
    fn a_remote_id_stands_in_only_for_a_missing_message_id() {
        assert_eq!(msg_key_or_remote(Some("<abc@example.com>"), "INBOX", 7, Some("AAMk1")), "abc@example.com");
        assert_eq!(msg_key_or_remote(None, "INBOX", 7, Some("AAMk1")), "r:AAMk1");
        assert_eq!(msg_key_or_remote(Some("<>"), "INBOX", 7, Some(" AAMk1 ")), "r:AAMk1");
    }

    #[test]
    fn without_a_remote_id_the_key_is_the_desktop_one() {
        assert_eq!(msg_key_or_remote(None, "INBOX", 7, None), msg_key(None, "INBOX", 7));
        assert_eq!(msg_key_or_remote(None, "INBOX", 7, Some("  ")), "u:INBOX:7");
        assert!(is_uid_fallback(&msg_key_or_remote(None, "INBOX", 7, None)));
        assert!(!is_uid_fallback(&msg_key_or_remote(None, "INBOX", 7, Some("x"))));
    }

    #[test]
    fn the_fallback_keeps_two_mailboxes_apart() {
        assert_ne!(msg_key(None, "INBOX", 7), msg_key(None, "Archive", 7));
    }
}
