//! The delete rule, one place for both apps (owner decision 1).
//!
//! Deleting outside Trash moves the message to Trash; only deleting inside
//! Trash removes it for good. The desktop daemon (`message_delete`, mode
//! `auto`) and the mobile engine (every backend's `Kind::Delete`) ask
//! `delete_disposition` and nothing else.
//!
//! "Inside Trash" is a backend question, answered by one function per kind:
//! - IMAP: `imap_trash_place`, against the folder `imap::resolve_trash_path`
//!   names (SPECIAL-USE, then by name: `imap::find_role_mailbox`), which is
//!   the folder a move to Trash lands in. Never the stored special-use guess,
//!   which also matches "Trash-old": asking anything else either expunges
//!   outside Trash or moves a message onto itself.
//! - JMAP: `jmap_trash_place`, against the mailbox whose role is `trash`.
//! - Graph: `graph_trash_place`, from the well-known name `deleteditems`
//!   (stored as the special-use `\Trash`): a folder merely named like it is
//!   not Deleted Items. Every Graph mailbox has one.
//!
//! An account with no Trash at all (ruling P6) keeps each app's behaviour
//! from before the rule: INBOX still moves (IMAP creates Trash, JMAP refuses
//! for want of one); any other folder is a permanent delete on desktop, which
//! keeps a deleted-mail bin copy first, and a move on the phone, which has no
//! bin to keep one in (`WithoutTrash`).

/// What a folder is for. Only INBOX changes the answer (an account with no
/// Trash); the rest are named so the table can be read and tested whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Junk,
    Trash,
    /// Gmail's `[Gmail]/All Mail`, IMAP `\All`.
    All,
    /// A folder the user made, or one with no declared role.
    Custom,
}

impl FolderRole {
    /// From a folder path and its special-use attribute (`\Sent`, `\Trash`,
    /// ...; a JMAP role or a Graph well-known name read the same way, case
    /// insensitive). INBOX is matched by path, case-insensitive (RFC 3501).
    pub fn of(path: &str, special_use: Option<&str>) -> FolderRole {
        if path.eq_ignore_ascii_case("INBOX") {
            return FolderRole::Inbox;
        }
        let Some(role) = special_use else { return FolderRole::Custom };
        match role.trim_start_matches('\\').to_ascii_lowercase().as_str() {
            "inbox" => FolderRole::Inbox,
            "sent" | "sentitems" => FolderRole::Sent,
            "drafts" => FolderRole::Drafts,
            "archive" => FolderRole::Archive,
            "junk" | "spam" | "junkemail" => FolderRole::Junk,
            "trash" | "deleteditems" => FolderRole::Trash,
            "all" => FolderRole::All,
            _ => FolderRole::Custom,
        }
    }
}

/// Where the account's Trash is, seen from the folder a delete is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrashPlace {
    /// This folder is the account's Trash.
    ThisFolder,
    /// The account has a Trash, and it is another folder.
    Elsewhere,
    /// The account has no Trash the backend can resolve.
    Missing,
}

/// What an app does outside Trash in an account with no Trash (ruling P6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WithoutTrash {
    /// Desktop: removed for good, after its deleted-mail bin copy.
    Permanent,
    /// Mobile: a move anyway (IMAP creates Trash, JMAP refuses), as before.
    MoveToTrash,
}

/// What a delete does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteDisposition {
    MoveToTrash,
    Permanent,
}

/// The delete rule: in Trash, permanent; anywhere else, a move to Trash. An
/// account with no Trash moves INBOX and does `without_trash` elsewhere.
pub fn delete_disposition(role: FolderRole, trash: TrashPlace, without_trash: WithoutTrash) -> DeleteDisposition {
    match trash {
        TrashPlace::ThisFolder => DeleteDisposition::Permanent,
        TrashPlace::Elsewhere => DeleteDisposition::MoveToTrash,
        TrashPlace::Missing if role == FolderRole::Inbox => DeleteDisposition::MoveToTrash,
        TrashPlace::Missing => match without_trash {
            WithoutTrash::Permanent => DeleteDisposition::Permanent,
            WithoutTrash::MoveToTrash => DeleteDisposition::MoveToTrash,
        },
    }
}

fn place(folder: &str, trash: Option<&str>) -> TrashPlace {
    match trash {
        None => TrashPlace::Missing,
        Some(t) if t == folder => TrashPlace::ThisFolder,
        Some(_) => TrashPlace::Elsewhere,
    }
}

/// IMAP: `folder` against `trash`, the path `imap::resolve_trash_path`
/// answered (`None`: no Trash it would move to). Paths compare exactly, as
/// the server names them.
pub fn imap_trash_place(folder: &str, trash: Option<&str>) -> TrashPlace {
    place(folder, trash)
}

/// JMAP: the mailbox `mailbox_id` against `trash_id`, the id of the mailbox
/// whose role is `trash` (`None`: the account has none).
pub fn jmap_trash_place(mailbox_id: &str, trash_id: Option<&str>) -> TrashPlace {
    place(mailbox_id, trash_id)
}

/// Graph: a folder is Deleted Items only by its well-known name, which the
/// apps store as the special-use `\Trash` (`deleteditems` is read the same).
/// Every Graph mailbox has Deleted Items, so never `Missing`.
pub fn graph_trash_place(special_use: Option<&str>) -> TrashPlace {
    match special_use {
        Some(s) if s.eq_ignore_ascii_case("\\Trash") || s.eq_ignore_ascii_case("deleteditems") => TrashPlace::ThisFolder,
        _ => TrashPlace::Elsewhere,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use DeleteDisposition::{MoveToTrash, Permanent};

    const ROLES: [FolderRole; 8] = [
        FolderRole::Inbox,
        FolderRole::Sent,
        FolderRole::Drafts,
        FolderRole::Archive,
        FolderRole::Junk,
        FolderRole::Trash,
        FolderRole::All,
        FolderRole::Custom,
    ];

    #[test]
    fn in_trash_is_permanent_and_anywhere_else_a_move() {
        for role in ROLES {
            for without in [WithoutTrash::Permanent, WithoutTrash::MoveToTrash] {
                assert_eq!(delete_disposition(role, TrashPlace::ThisFolder, without), Permanent, "{role:?} in Trash");
                assert_eq!(delete_disposition(role, TrashPlace::Elsewhere, without), MoveToTrash, "{role:?} outside Trash");
            }
        }
    }

    #[test]
    fn an_account_without_trash_keeps_each_apps_rule() {
        for role in ROLES {
            let desktop = delete_disposition(role, TrashPlace::Missing, WithoutTrash::Permanent);
            let mobile = delete_disposition(role, TrashPlace::Missing, WithoutTrash::MoveToTrash);
            let want_desktop = if role == FolderRole::Inbox { MoveToTrash } else { Permanent };
            assert_eq!(desktop, want_desktop, "desktop {role:?} with no Trash");
            assert_eq!(mobile, MoveToTrash, "mobile {role:?} with no Trash");
        }
    }

    /// Every role on every backend: the folder that is the backend's Trash
    /// is permanent, every other a move to Trash.
    #[test]
    fn the_table_on_all_three_backends() {
        // (role, IMAP path, JMAP mailbox id, Graph special-use)
        let folders = [
            (FolderRole::Inbox, "INBOX", "mb-inbox", None),
            (FolderRole::Sent, "Sent", "mb-sent", Some("\\Sent")),
            (FolderRole::Drafts, "Drafts", "mb-drafts", Some("\\Drafts")),
            (FolderRole::Archive, "Archive", "mb-archive", Some("\\Archive")),
            (FolderRole::Junk, "Spam", "mb-junk", Some("\\Junk")),
            (FolderRole::Trash, "Trash", "mb-trash", Some("\\Trash")),
            (FolderRole::All, "[Gmail]/All Mail", "mb-all", None),
            (FolderRole::Custom, "Clients/Acme", "mb-acme", None),
        ];
        for (role, path, id, special) in folders {
            let want = if role == FolderRole::Trash { Permanent } else { MoveToTrash };
            for without in [WithoutTrash::Permanent, WithoutTrash::MoveToTrash] {
                let imap = delete_disposition(role, imap_trash_place(path, Some("Trash")), without);
                let jmap = delete_disposition(role, jmap_trash_place(id, Some("mb-trash")), without);
                let graph = delete_disposition(role, graph_trash_place(special), without);
                assert_eq!((imap, jmap, graph), (want, want, want), "{role:?}");
            }
        }
    }

    #[test]
    fn imap_trash_is_the_resolved_path_only() {
        assert_eq!(imap_trash_place("INBOX.Trash", Some("INBOX.Trash")), TrashPlace::ThisFolder);
        assert_eq!(imap_trash_place("[Gmail]/Trash", Some("[Gmail]/Bin")), TrashPlace::Elsewhere);
        // A look-alike is not the Trash a move lands in.
        assert_eq!(imap_trash_place("Trash-old", Some("Trash")), TrashPlace::Elsewhere);
        assert_eq!(imap_trash_place("Sent", None), TrashPlace::Missing);
    }

    #[test]
    fn jmap_trash_is_the_trash_role_mailbox() {
        assert_eq!(jmap_trash_place("mb-trash", Some("mb-trash")), TrashPlace::ThisFolder);
        assert_eq!(jmap_trash_place("mb-work", Some("mb-trash")), TrashPlace::Elsewhere);
        assert_eq!(jmap_trash_place("mb-work", None), TrashPlace::Missing);
    }

    #[test]
    fn graph_trash_is_deleted_items_by_its_well_known_name() {
        assert_eq!(graph_trash_place(Some("\\Trash")), TrashPlace::ThisFolder);
        assert_eq!(graph_trash_place(Some("deleteditems")), TrashPlace::ThisFolder);
        assert_eq!(graph_trash_place(Some("\\Sent")), TrashPlace::Elsewhere);
        assert_eq!(graph_trash_place(None), TrashPlace::Elsewhere, "Graph always has Deleted Items");
    }

    #[test]
    fn roles_read_from_special_use_and_inbox_by_path() {
        assert_eq!(FolderRole::of("INBOX", None), FolderRole::Inbox);
        assert_eq!(FolderRole::of("Inbox", None), FolderRole::Inbox, "INBOX is case-insensitive");
        assert_eq!(FolderRole::of("Sent", Some("\\Sent")), FolderRole::Sent);
        assert_eq!(FolderRole::of("x", Some("sentitems")), FolderRole::Sent);
        assert_eq!(FolderRole::of("x", Some("\\Junk")), FolderRole::Junk);
        assert_eq!(FolderRole::of("x", Some("junkemail")), FolderRole::Junk);
        assert_eq!(FolderRole::of("x", Some("\\Trash")), FolderRole::Trash);
        assert_eq!(FolderRole::of("x", Some("\\All")), FolderRole::All);
        assert_eq!(FolderRole::of("Work", None), FolderRole::Custom);
        assert_eq!(FolderRole::of("Work", Some("\\Flagged")), FolderRole::Custom);
    }
}
