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
    let id = message_id.unwrap_or("").trim();
    let id = id.strip_prefix('<').unwrap_or(id);
    let id = id.strip_suffix('>').unwrap_or(id).trim();
    if id.is_empty() {
        return format!("u:{vault_dir}:{uid}");
    }
    id.to_string()
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
    fn the_fallback_keeps_two_mailboxes_apart() {
        assert_ne!(msg_key(None, "INBOX", 7), msg_key(None, "Archive", 7));
    }
}
