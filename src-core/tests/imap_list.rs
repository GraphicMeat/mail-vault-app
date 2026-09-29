//! LIST -> MailboxInfo: names as the server means them, and roles the server
//! declared kept apart from roles read off a name.
mod common;
use common::session;
use mailvault_core::imap::*;
use mock_imap::state::{synthetic_mailbox, Mailbox};
use mock_imap::{MockImap, Scenario};

fn find<'a>(boxes: &'a [MailboxInfo], path: &str) -> &'a MailboxInfo {
    boxes
        .iter()
        .find(|m| m.path == path)
        .unwrap_or_else(|| panic!("{path:?} not listed; got {:?}", boxes.iter().map(|m| &m.path).collect::<Vec<_>>()))
}

fn role(boxes: &[MailboxInfo], path: &str) -> (Option<String>, bool) {
    let m = find(boxes, path);
    (m.special_use.clone(), m.special_use_guessed)
}

#[async_std::test]
async fn a_quoted_escaped_name_lists_unescaped_and_selects_back_to_its_messages() {
    // The mock LISTs `\Trash` as `"\\Trash"`. Kept escaped, async-imap escapes
    // it again on SELECT (`"\\\\Trash"`): a mailbox that does not exist, so the
    // folder showed 0 emails.
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("\\Trash", 2))
            .mailbox(synthetic_mailbox("Say \"hi\"", 1)),
    );
    let mut sess = session(&server).await;

    let boxes = list_mailboxes(&mut sess).await.expect("list");
    assert_eq!(find(&boxes, "\\Trash").name, "\\Trash");
    assert_eq!(find(&boxes, "Say \"hi\"").name, "Say \"hi\"");

    assert_eq!(select_mailbox(&mut sess, "\\Trash").await.expect("select").exists, 2);
    let (emails, total, _, _) = fetch_emails_page(&mut sess, "\\Trash", 1, 10).await.expect("fetch");
    assert_eq!((total, emails.len()), (2, 2));
    assert_eq!(select_mailbox(&mut sess, "Say \"hi\"").await.expect("select").exists, 1);
}

#[async_std::test]
async fn a_backslash_delimiter_is_unescaped_too() {
    let mut scenario = Scenario::new().mailbox(Mailbox::new("Work\\Clients"));
    scenario.state.delimiter = "\\".to_string();
    let server = MockImap::start(scenario);
    let mut sess = session(&server).await;

    let boxes = list_mailboxes(&mut sess).await.expect("list");
    let m = find(&boxes, "Work\\Clients");
    assert_eq!(m.delimiter.as_deref(), Some("\\"));
    assert_eq!(m.name, "Clients");
}

/// Gmail LISTs in byte order, so user labels starting with a capital come
/// before `[Gmail]`: a "first \Trash" lookup meets `Deleted Messages` first.
fn gmail() -> Scenario {
    Scenario::new().mailboxes(vec![
        Mailbox::new("INBOX"),
        // User labels carry no attributes at all.
        Mailbox::new("Deleted Messages").with_attrs(&[]),
        Mailbox::new("Drafts").with_attrs(&[]),
        Mailbox::new("[Gmail]").with_attrs(&["\\HasChildren", "\\Noselect"]),
        Mailbox::new("[Gmail]/Bin").with_attrs(&["\\HasNoChildren", "\\Trash"]),
        Mailbox::new("[Gmail]/Drafts").with_attrs(&["\\HasNoChildren", "\\Drafts"]),
        Mailbox::new("[Gmail]/Sent Mail").with_attrs(&["\\HasNoChildren", "\\Sent"]),
        Mailbox::new("[Imap]/Archive").with_attrs(&[]),
        Mailbox::new("[Imap]/Trash").with_attrs(&[]),
    ])
}

#[async_std::test]
async fn gmail_labels_named_like_a_role_do_not_compete_with_the_declared_one() {
    let server = MockImap::start(gmail());
    let mut sess = session(&server).await;
    let boxes = list_mailboxes(&mut sess).await.expect("list");

    let paths: Vec<&str> = boxes.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "INBOX", "Deleted Messages", "Drafts", "[Gmail]", "[Gmail]/Bin", "[Gmail]/Drafts",
            "[Gmail]/Sent Mail", "[Imap]/Archive", "[Imap]/Trash",
        ]
    );
    assert_eq!(find(&boxes, "[Imap]/Trash").name, "Trash");
    assert!(find(&boxes, "[Gmail]").noselect);

    assert_eq!(role(&boxes, "INBOX"), (Some("\\Inbox".into()), false));
    assert_eq!(role(&boxes, "[Gmail]"), (None, false));
    assert_eq!(role(&boxes, "[Gmail]/Bin"), (Some("\\Trash".into()), false));
    assert_eq!(role(&boxes, "[Gmail]/Sent Mail"), (Some("\\Sent".into()), false));
    assert_eq!(role(&boxes, "[Gmail]/Drafts"), (Some("\\Drafts".into()), false));
    assert_eq!(role(&boxes, "[Imap]/Archive"), (None, false));
    // The server named its Trash, Drafts: a label that merely sounds like one is
    // a label. Left as a second \Trash, every "first \Trash" resolver (delete,
    // migration, unified Trash) could pick the label.
    assert_eq!(role(&boxes, "[Imap]/Trash"), (None, false));
    assert_eq!(role(&boxes, "Drafts"), (None, false));
    assert_eq!(role(&boxes, "Deleted Messages"), (None, false));

    // The resolver the daemon asks for "Trash" / "Drafts" by role.
    assert_eq!(resolve_mailbox_path("Trash", &boxes).as_deref(), Some("[Gmail]/Bin"));
    assert_eq!(resolve_mailbox_path("Deleted Items", &boxes).as_deref(), Some("[Gmail]/Bin"));
}

/// Gmail as it LISTs: All Mail is `\All` and nothing else. The import fallback
/// finds it in the raw attributes the listing already carries (`flags`, saved
/// into the cached mailbox list as is), so `special_use` stays what every
/// consumer of it has always seen: nothing.
#[async_std::test]
async fn gmail_all_mail_resolves_through_the_flags_and_keeps_no_special_use() {
    use mailvault_core::takeout::{folder_refs_from_listing, Role};

    let nc = "\\HasNoChildren";
    let server = MockImap::start(Scenario::new().mailboxes(vec![
        Mailbox::new("INBOX"),
        Mailbox::new("Work").with_attrs(&[nc]),
        Mailbox::new("[Gmail]").with_attrs(&["\\HasChildren", "\\Noselect"]),
        Mailbox::new("[Gmail]/All Mail").with_attrs(&[nc, "\\All"]),
        Mailbox::new("[Gmail]/Drafts").with_attrs(&[nc, "\\Drafts"]),
        Mailbox::new("[Gmail]/Important").with_attrs(&[nc, "\\Important"]),
        Mailbox::new("[Gmail]/Sent Mail").with_attrs(&[nc, "\\Sent"]),
        Mailbox::new("[Gmail]/Spam").with_attrs(&[nc, "\\Junk"]),
        Mailbox::new("[Gmail]/Starred").with_attrs(&[nc, "\\Flagged"]),
        Mailbox::new("[Gmail]/Trash").with_attrs(&[nc, "\\Trash"]),
    ]));
    let mut sess = session(&server).await;
    let boxes = list_mailboxes(&mut sess).await.expect("list");

    // The value every existing consumer sees is unchanged: no role, declared or guessed.
    assert_eq!(role(&boxes, "[Gmail]/All Mail"), (None, false));
    assert_eq!(role(&boxes, "[Gmail]/Starred"), (None, false));
    assert_eq!(role(&boxes, "[Gmail]/Sent Mail"), (Some("\\Sent".into()), false));

    // The cached mailbox list is the app's copy of this listing, saved as is.
    let cache = serde_json::json!({ "mailboxes": boxes, "fetchedAt": 1 }).to_string();
    let all_mail = serde_json::to_string(find(&boxes, "[Gmail]/All Mail")).unwrap();
    eprintln!("cached All Mail entry: {all_mail}");
    assert!(all_mail.contains(r#""specialUse":null"#) && all_mail.contains(r#""All""#), "{all_mail}");

    let refs = folder_refs_from_listing(&cache);
    let roles: Vec<(&str, Role)> = refs.iter().map(|f| (f.path.as_str(), f.role)).collect();
    assert_eq!(
        roles,
        [
            ("INBOX", Role::Inbox),
            ("Work", Role::Other),
            ("[Gmail]/All Mail", Role::AllMail),
            ("[Gmail]/Drafts", Role::Drafts),
            ("[Gmail]/Important", Role::Other),
            ("[Gmail]/Sent Mail", Role::Sent),
            ("[Gmail]/Spam", Role::Spam),
            ("[Gmail]/Starred", Role::Other),
            ("[Gmail]/Trash", Role::Trash),
        ],
        "the unselectable [Gmail] parent is left out"
    );
    assert!(refs.iter().all(|f| f.delim == '/'));
}

#[async_std::test]
async fn a_server_without_all_mail_lists_its_archive_as_archive_and_no_all_mail() {
    use mailvault_core::takeout::{folder_refs_from_listing, Role};

    let server = MockImap::start(Scenario::new().mailboxes(vec![
        Mailbox::new("INBOX"),
        Mailbox::new("Archive").with_attrs(&["\\HasNoChildren", "\\Archive"]),
        Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]),
    ]));
    let mut sess = session(&server).await;
    let boxes = list_mailboxes(&mut sess).await.expect("list");
    let refs = folder_refs_from_listing(&serde_json::json!({ "mailboxes": boxes }).to_string());

    let roles: Vec<(&str, Role)> = refs.iter().map(|f| (f.path.as_str(), f.role)).collect();
    assert_eq!(roles, [("INBOX", Role::Inbox), ("Archive", Role::Archive), ("Sent", Role::Sent)]);
}

#[async_std::test]
async fn without_special_use_the_name_guess_stays_and_says_it_is_a_guess() {
    let server = MockImap::start(Scenario::new().without_cap("SPECIAL-USE").mailboxes(vec![
        Mailbox::new("INBOX"),
        Mailbox::new("[Imap]/Trash").with_attrs(&[]),
        Mailbox::new("Sent").with_attrs(&["\\HasNoChildren"]),
    ]));
    let mut sess = session(&server).await;
    let boxes = list_mailboxes(&mut sess).await.expect("list");

    assert_eq!(role(&boxes, "INBOX"), (Some("\\Inbox".into()), false));
    assert_eq!(role(&boxes, "[Imap]/Trash"), (Some("\\Trash".into()), true));
    assert_eq!(role(&boxes, "Sent"), (Some("\\Sent".into()), true));
}

#[async_std::test]
async fn ensure_sent_mailbox_returns_an_escaped_name_unescaped() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("Sent \"old\"").with_attrs(&["\\HasNoChildren", "\\Sent"])),
    );
    let mut sess = session(&server).await;
    let sent = ensure_sent_mailbox(&mut sess).await.expect("resolve Sent");
    assert_eq!(sent, "Sent \"old\"");
    assert_eq!(server.count_commands("CREATE"), 0);
}
