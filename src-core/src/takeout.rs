//! Google Takeout label handling for MBOX import: read a message's
//! `X-Gmail-Labels`, turn it into flags, and pick the one folder it belongs
//! in. Pure functions; the caller supplies the folder list and does all I/O.

use crate::mime::decode_rfc2047;

/// What a folder is for. `AllMail` is Gmail's `\All`, `Archive` the plain
/// archive folder of every other provider; both serve as the fallback home.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Inbox,
    Sent,
    Drafts,
    Spam,
    Trash,
    AllMail,
    Archive,
    Other,
}

/// A destination folder as the import sees it. `path` is the server name a
/// label is matched against; `dir` is the vault directory the caller must
/// write to (for IMAP `sanitize(path)`, for Graph the storage key). The caller
/// fills `dir`; this module never derives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderRef {
    pub path: String,
    pub dir: String,
    pub role: Role,
    pub delim: char,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MsgAttrs {
    pub flagged: bool,
    pub unread: bool,
}

/// Where a message goes. `Fallback` means the caller applies the dialog's
/// fallback folder; `Create` carries the label with its `/` hierarchy, the
/// caller converts it to the server delimiter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Home {
    Folder(FolderRef),
    Create(String),
    Fallback,
}

/// System labels, in home-folder priority order.
const SYSTEM: [(&str, Role); 5] = [
    ("inbox", Role::Inbox),
    ("sent", Role::Sent),
    ("drafts", Role::Drafts),
    ("spam", Role::Spam),
    ("trash", Role::Trash),
];

/// Labels that never name a folder besides the system ones (lowercase); `Category ...` is checked apart.
const NOT_CUSTOM: [&str; 6] = ["starred", "important", "opened", "unread", "chat", "archived"];

/// The labels of one message, from its raw header block (CRLF or LF).
pub fn labels_of(head: &[u8]) -> Vec<String> {
    let mut value: Option<Vec<u8>> = None;
    for line in head.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        match value.as_mut() {
            // Unfolding drops the line break only; the whitespace at the fold stays.
            Some(v) if matches!(line.first(), Some(b' ' | b'\t')) => v.extend_from_slice(line),
            Some(_) => break,
            None if line.is_empty() => break, // end of the header block
            None => {
                if let Some(i) = line.iter().position(|&b| b == b':') {
                    if line[..i].eq_ignore_ascii_case(b"X-Gmail-Labels") {
                        value = Some(line[i + 1..].to_vec());
                    }
                }
            }
        }
    }
    let Some(value) = value else { return Vec::new() };

    // Decode first: Takeout may encode the whole value, commas included.
    let text = decode_rfc2047(&value);
    let (mut out, mut cur, mut quoted) = (Vec::new(), String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
}

pub fn attrs_of(labels: &[String]) -> MsgAttrs {
    let has = |name: &str| labels.iter().any(|l| l.eq_ignore_ascii_case(name));
    // `Unread` wins over `Opened`; neither label means read.
    MsgAttrs { flagged: has("Starred"), unread: has("Unread") }
}

/// The one folder a message belongs in. `create_missing` (mode 1): the first
/// custom label is the home, `Create` when it has no folder yet. Without it
/// (mode 2): the first custom label that already has a folder, else `Fallback`.
pub fn home_folder(labels: &[String], folders: &[FolderRef], create_missing: bool) -> Home {
    for (name, role) in SYSTEM {
        if labels.iter().any(|l| l.eq_ignore_ascii_case(name)) {
            if let Some(f) = folders.iter().find(|f| f.role == role) {
                return Home::Folder(f.clone());
            }
        }
    }
    let customs = labels.iter().filter(|l| {
        let low = l.to_lowercase();
        !low.is_empty()
            && !SYSTEM.iter().any(|(n, _)| low == *n)
            && !NOT_CUSTOM.contains(&low.as_str())
            && !low.starts_with("category ")
            && !low.starts_with("category_")
    });
    for label in customs {
        let want = label.to_lowercase();
        // A label is `/`-separated whatever the server's delimiter is.
        match folders.iter().find(|f| f.path.replace(f.delim, "/").to_lowercase() == want) {
            Some(f) => return Home::Folder(f.clone()),
            None if create_missing => return Home::Create(label.clone()),
            None => {}
        }
    }
    Home::Fallback
}

/// The role an IMAP special-use attribute (`\Sent`, ...) stands for.
pub fn role_of_special_use(su: &str) -> Role {
    match su.to_ascii_lowercase().as_str() {
        "\\inbox" => Role::Inbox,
        "\\sent" => Role::Sent,
        "\\drafts" => Role::Drafts,
        "\\junk" => Role::Spam,
        "\\trash" => Role::Trash,
        "\\archive" => Role::Archive,
        "\\all" => Role::AllMail,
        _ => Role::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fr(path: &str, role: Role, delim: char) -> FolderRef {
        FolderRef { path: path.into(), dir: path.replace(' ', "_"), role, delim }
    }

    /// A Gmail-shaped folder list (`/` delimiter) plus custom folders.
    fn gmail() -> Vec<FolderRef> {
        vec![
            fr("INBOX", Role::Inbox, '/'),
            fr("[Gmail]/Sent Mail", Role::Sent, '/'),
            fr("[Gmail]/Drafts", Role::Drafts, '/'),
            fr("[Gmail]/Spam", Role::Spam, '/'),
            fr("[Gmail]/Trash", Role::Trash, '/'),
            fr("[Gmail]/All Mail", Role::AllMail, '/'),
            fr("Work", Role::Other, '/'),
            fr("Work/Clients", Role::Other, '/'),
            fr("Receipts", Role::Other, '/'),
        ]
    }

    fn folder<'a>(folders: &'a [FolderRef], path: &str) -> &'a FolderRef {
        folders.iter().find(|f| f.path == path).unwrap()
    }

    fn labs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// A header block the way Takeout writes it, with the given labels line.
    fn head(labels_line: &str) -> Vec<u8> {
        format!(
            "From 1712345678901234567@xxx Mon Jan 01 00:00:00 +0000 2018\r\n\
             X-GM-THRID: 1712345678901234567\r\n\
             {labels_line}\r\n\
             Delivered-To: me@example.com\r\n\
             Subject: Quarterly report\r\n\
             \r\n"
        )
        .into_bytes()
    }

    // ---- labels_of ----

    #[test]
    fn labels_of_reads_a_takeout_header_and_keeps_hierarchy_and_case() {
        let h = head("X-Gmail-Labels: Inbox,Important,Opened,Category Promotions,Work/Clients/ACME");
        assert_eq!(
            labels_of(&h),
            labs(&["Inbox", "Important", "Opened", "Category Promotions", "Work/Clients/ACME"])
        );
    }

    #[test]
    fn labels_of_accepts_bare_lf_and_any_header_case() {
        let h = b"Subject: x\nx-gmail-labels: Sent,Starred\nDate: Mon, 1 Jan 2018 00:00:00 +0000\n\n";
        assert_eq!(labels_of(h), labs(&["Sent", "Starred"]));
    }

    #[test]
    fn labels_of_is_empty_without_the_header_or_with_an_empty_value() {
        assert!(labels_of(b"Subject: x\r\nFrom: a@example.com\r\n\r\n").is_empty());
        assert!(labels_of(&head("X-Gmail-Labels:")).is_empty());
        assert!(labels_of(&head("X-Gmail-Labels:   ")).is_empty());
        assert!(labels_of(b"").is_empty());
    }

    #[test]
    fn labels_of_ignores_a_similarly_named_header_and_the_body() {
        let h = b"X-Gmail-Labels-Extra: Bogus\r\nSubject: x\r\n\r\nX-Gmail-Labels: FromBody\r\n";
        assert!(labels_of(h).is_empty());
    }

    #[test]
    fn labels_of_does_not_split_a_comma_inside_quotes() {
        let h = head(r#"X-Gmail-Labels: Inbox,"Work, Clients",Opened"#);
        assert_eq!(labels_of(&h), labs(&["Inbox", "Work, Clients", "Opened"]));
    }

    #[test]
    fn labels_of_unescapes_a_quote_inside_a_quoted_label() {
        let h = head(r#"X-Gmail-Labels: "Say \"hi\", ok",Inbox"#);
        assert_eq!(labels_of(&h), labs(&["Say \"hi\", ok", "Inbox"]));
    }

    #[test]
    fn labels_of_trims_and_drops_empty_entries() {
        let h = head("X-Gmail-Labels:  Inbox , ,Opened,");
        assert_eq!(labels_of(&h), labs(&["Inbox", "Opened"]));
    }

    #[test]
    fn labels_of_unfolds_a_folded_header_without_losing_the_space_at_the_fold() {
        let h = b"X-Gmail-Labels: Inbox,Important,Category\r\n Promotions,\r\n\tWork/Clients\r\nSubject: x\r\n\r\n";
        assert_eq!(
            labels_of(h),
            labs(&["Inbox", "Important", "Category Promotions", "Work/Clients"])
        );
    }

    #[test]
    fn labels_of_decodes_q_and_b_encoded_labels() {
        let q = head("X-Gmail-Labels: Inbox,=?UTF-8?Q?Kunden/=C3=9Cbung?=,Opened");
        assert_eq!(labels_of(&q), labs(&["Inbox", "Kunden/Übung", "Opened"]));
        let b = head("X-Gmail-Labels: =?UTF-8?B?w5xiZXIgdW5z?=,Sent");
        assert_eq!(labels_of(&b), labs(&["Über uns", "Sent"]));
    }

    #[test]
    fn labels_of_splits_a_whole_value_encoded_word_after_decoding_it() {
        // "Inbox,Café,Work/Kunden" as one base64 encoded word.
        let h = head("X-Gmail-Labels: =?UTF-8?B?SW5ib3gsQ2Fmw6ksV29yay9LdW5kZW4=?=");
        assert_eq!(labels_of(&h), labs(&["Inbox", "Café", "Work/Kunden"]));
    }

    #[test]
    fn labels_of_drops_the_whitespace_between_adjacent_encoded_words_even_when_folded() {
        let h = b"X-Gmail-Labels: Inbox,=?UTF-8?Q?Caf=C3=A9?=\r\n =?UTF-8?Q?_Bar?=,Opened\r\n\r\n";
        assert_eq!(labels_of(h), labs(&["Inbox", "Café Bar", "Opened"]));
    }

    // ---- attrs_of ----

    #[test]
    fn starred_means_flagged() {
        assert!(attrs_of(&labs(&["Inbox", "Starred"])).flagged);
        assert!(attrs_of(&labs(&["starred"])).flagged);
        assert!(!attrs_of(&labs(&["Inbox", "Important"])).flagged);
        assert!(!attrs_of(&[]).flagged);
    }

    #[test]
    fn read_state_matrix() {
        let unread = |l: &[&str]| attrs_of(&labs(l)).unread;
        assert!(unread(&["Inbox", "Unread"]));
        assert!(!unread(&["Inbox", "Opened"]));
        assert!(!unread(&["Inbox"]));
        assert!(!unread(&[]));
        // Both present: unread wins.
        assert!(unread(&["Opened", "Unread"]));
        assert!(unread(&["Unread", "Opened"]));
        assert!(unread(&["unread"]));
    }

    // ---- home_folder ----

    #[test]
    fn each_system_label_lands_in_the_folder_with_that_role() {
        let f = gmail();
        for (label, path) in [
            ("Inbox", "INBOX"),
            ("Sent", "[Gmail]/Sent Mail"),
            ("Drafts", "[Gmail]/Drafts"),
            ("Spam", "[Gmail]/Spam"),
            ("Trash", "[Gmail]/Trash"),
        ] {
            assert_eq!(
                home_folder(&labs(&[label]), &f, false),
                Home::Folder(folder(&f, path).clone()),
                "{label}"
            );
        }
    }

    #[test]
    fn system_labels_match_case_insensitively() {
        let f = gmail();
        assert_eq!(home_folder(&labs(&["INBOX"]), &f, false), Home::Folder(folder(&f, "INBOX").clone()));
        assert_eq!(home_folder(&labs(&["sent"]), &f, true), Home::Folder(folder(&f, "[Gmail]/Sent Mail").clone()));
    }

    #[test]
    fn system_labels_win_in_order_inbox_sent_drafts_spam_trash_then_custom() {
        let f = gmail();
        let order = ["Inbox", "Sent", "Drafts", "Spam", "Trash", "Work/Clients"];
        for (i, winner) in order.iter().enumerate() {
            for loser in &order[i + 1..] {
                // The loser comes first in label order; the winner still wins.
                let got = home_folder(&labs(&[loser, winner]), &f, false);
                let want = home_folder(&labs(&[winner]), &f, false);
                assert_eq!(got, want, "{winner} beats {loser}");
                assert_ne!(got, Home::Fallback);
            }
        }
    }

    #[test]
    fn a_system_label_without_a_folder_is_skipped_and_the_next_step_runs() {
        let no_sent: Vec<FolderRef> = gmail().into_iter().filter(|f| f.role != Role::Sent).collect();
        assert_eq!(
            home_folder(&labs(&["Sent", "Drafts"]), &no_sent, false),
            Home::Folder(folder(&no_sent, "[Gmail]/Drafts").clone())
        );
        let no_trash: Vec<FolderRef> = gmail().into_iter().filter(|f| f.role != Role::Trash).collect();
        for create in [false, true] {
            // Skipped, not created: a system label is never a custom folder name.
            assert_eq!(
                home_folder(&labs(&["Trash", "Work/Clients"]), &no_trash, create),
                Home::Folder(folder(&no_trash, "Work/Clients").clone())
            );
            assert_eq!(home_folder(&labs(&["Trash"]), &no_trash, create), Home::Fallback);
        }
    }

    #[test]
    fn a_custom_label_matches_its_folder_and_keeps_the_folders_dir() {
        let f = gmail();
        let got = home_folder(&labs(&["Category Personal", "Work/Clients"]), &f, false);
        assert_eq!(got, Home::Folder(folder(&f, "Work/Clients").clone()));
        let spaced = vec![fr("Old Projects", Role::Other, '/')];
        match home_folder(&labs(&["old projects"]), &spaced, false) {
            Home::Folder(r) => {
                assert_eq!(r.path, "Old Projects");
                assert_eq!(r.dir, "Old_Projects");
            }
            other => panic!("expected the folder, got {other:?}"),
        }
    }

    #[test]
    fn a_dot_delimiter_server_matches_a_slash_label() {
        let f = vec![
            fr("INBOX", Role::Inbox, '.'),
            fr("Work", Role::Other, '.'),
            fr("Work.Clients", Role::Other, '.'),
        ];
        assert_eq!(home_folder(&labs(&["Work/Clients"]), &f, false), Home::Folder(f[2].clone()));
        assert_eq!(home_folder(&labs(&["work/clients"]), &f, true), Home::Folder(f[2].clone()));
        // The deeper label is not swallowed by its parent.
        assert_eq!(home_folder(&labs(&["Work"]), &f, false), Home::Folder(f[1].clone()));
    }

    #[test]
    fn ignored_labels_never_become_a_home_even_when_a_folder_bears_the_name() {
        let mut f = gmail();
        for name in ["Starred", "Important", "Opened", "Unread", "Chat", "Archived", "Category Promotions", "Category_Updates"] {
            f.push(fr(name, Role::Other, '/'));
        }
        let l = labs(&[
            "Starred", "Important", "Opened", "Unread", "Chat", "Archived", "archived", "Category Promotions",
            "Category_Updates", "category social",
        ]);
        assert_eq!(home_folder(&l, &f, false), Home::Fallback);
        assert_eq!(home_folder(&l, &f, true), Home::Fallback);
        // A real custom label after them still wins.
        let mut with_custom = l.clone();
        with_custom.push("Receipts".into());
        assert_eq!(home_folder(&with_custom, &f, true), Home::Folder(folder(&f, "Receipts").clone()));
    }

    #[test]
    fn every_system_label_without_a_folder_is_skipped_never_created() {
        let f = gmail();
        // (label, role that is missing, next system label, the folder it reaches)
        for (label, role, next, next_path) in [
            ("Inbox", Role::Inbox, "Sent", "[Gmail]/Sent Mail"),
            ("Sent", Role::Sent, "Drafts", "[Gmail]/Drafts"),
            ("Drafts", Role::Drafts, "Spam", "[Gmail]/Spam"),
            ("Spam", Role::Spam, "Trash", "[Gmail]/Trash"),
            ("Trash", Role::Trash, "Inbox", "INBOX"),
        ] {
            let without: Vec<FolderRef> = f.iter().filter(|x| x.role != role).cloned().collect();
            for create in [false, true] {
                // Alone: nothing to land in, and a system label is never a folder to create.
                assert_eq!(home_folder(&labs(&[label]), &without, create), Home::Fallback, "{label} alone");
                // The next priority step still runs, whatever the label order.
                assert_eq!(
                    home_folder(&labs(&[label, next]), &without, create),
                    Home::Folder(folder(&without, next_path).clone()),
                    "{label} then {next}"
                );
                // With a custom label after it, the custom folder is used.
                assert_eq!(
                    home_folder(&labs(&[label, "Work/Clients"]), &without, create),
                    Home::Folder(folder(&without, "Work/Clients").clone()),
                    "{label} then a custom label"
                );
            }
        }
    }

    #[test]
    fn a_takeout_message_with_only_important_and_a_category_falls_back() {
        let labels = labels_of(&head("X-Gmail-Labels: Important,Category Promotions"));
        assert_eq!(labels, labs(&["Important", "Category Promotions"]));
        assert_eq!(home_folder(&labels, &gmail(), false), Home::Fallback);
        assert_eq!(home_folder(&labels, &gmail(), true), Home::Fallback);
        assert_eq!(home_folder(&[], &gmail(), true), Home::Fallback);
    }

    #[test]
    fn archived_is_ignored_and_never_creates_a_folder() {
        // Takeout's pseudo-label for mail that only lives in All Mail.
        let labels = labels_of(&head("X-Gmail-Labels: Archived,Opened"));
        assert_eq!(labels, labs(&["Archived", "Opened"]));
        assert_eq!(home_folder(&labels, &gmail(), true), Home::Fallback);
        assert_eq!(home_folder(&labels, &gmail(), false), Home::Fallback);
        // A real custom label after it is still the home, created in mode 1.
        let with_custom = labs(&["Archived", "Ghost"]);
        assert_eq!(home_folder(&with_custom, &gmail(), true), Home::Create("Ghost".into()));
    }

    #[test]
    fn create_missing_decides_between_a_fallback_and_a_new_folder() {
        let f = gmail();
        let ghost = labs(&["Ghost/Sub Folder"]);
        assert_eq!(home_folder(&ghost, &f, false), Home::Fallback);
        // Label case and `/` hierarchy survive into the folder to create.
        assert_eq!(home_folder(&ghost, &f, true), Home::Create("Ghost/Sub Folder".into()));
    }

    #[test]
    fn mode_two_takes_the_first_existing_custom_label_mode_one_the_first_custom_label() {
        let f = gmail();
        let l = labs(&["Newsletters", "Work/Clients"]);
        // Mode 2 (no create): Newsletters has no folder, so the next label that has one.
        assert_eq!(home_folder(&l, &f, false), Home::Folder(folder(&f, "Work/Clients").clone()));
        // Mode 1 (create): the first custom label is the home, created if missing.
        assert_eq!(home_folder(&l, &f, true), Home::Create("Newsletters".into()));
        // First label exists: both modes agree.
        let l2 = labs(&["Work/Clients", "Newsletters"]);
        assert_eq!(home_folder(&l2, &f, false), Home::Folder(folder(&f, "Work/Clients").clone()));
        assert_eq!(home_folder(&l2, &f, true), Home::Folder(folder(&f, "Work/Clients").clone()));
    }

    #[test]
    fn an_empty_label_is_never_created() {
        assert_eq!(home_folder(&labs(&[""]), &gmail(), true), Home::Fallback);
    }

    #[test]
    fn a_real_takeout_header_routes_end_to_end() {
        let f = gmail();
        let h = head("X-Gmail-Labels: Important,Opened,Category Promotions,Work/Clients,Starred");
        let labels = labels_of(&h);
        assert_eq!(home_folder(&labels, &f, false), Home::Folder(folder(&f, "Work/Clients").clone()));
        assert_eq!(attrs_of(&labels), MsgAttrs { flagged: true, unread: false });
    }

    // ---- role_of_special_use ----

    #[test]
    fn special_use_attributes_map_to_roles() {
        for (su, role) in [
            ("\\Inbox", Role::Inbox),
            ("\\Sent", Role::Sent),
            ("\\Drafts", Role::Drafts),
            ("\\Junk", Role::Spam),
            ("\\Trash", Role::Trash),
            ("\\Archive", Role::Archive),
            ("\\All", Role::AllMail),
            ("\\Flagged", Role::Other),
            ("", Role::Other),
            ("Sent", Role::Other),
        ] {
            assert_eq!(role_of_special_use(su), role, "{su:?}");
        }
        assert_eq!(role_of_special_use("\\SENT"), Role::Sent);
    }
}
