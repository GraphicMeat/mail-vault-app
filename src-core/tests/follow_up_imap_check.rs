//! `follow_up::imap_check::check` against the mock server: the IMAP half of
//! a follow-up check both apps run. The daemon's own mock tests
//! (`follow_up_worker.rs`) cover it through the daemon's pool too.

mod common;

mod follow_up {
    use super::common::session;
    use mailvault_core::app_db::follow_up::{FollowUp, Outcome};
    use mailvault_core::follow_up::imap_check::check;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    fn own() -> Vec<String> {
        vec!["me@example.com".to_string(), "alias@example.com".to_string()]
    }

    fn row(message_id: &str, sent_mailbox: &str) -> FollowUp {
        FollowUp {
            id: "f1".into(),
            account_id: "acct".into(),
            message_id: message_id.into(),
            subject: "Quote".into(),
            recipients: "ana@example.com".into(),
            sent_at: 1_000,
            remind_at: 1_000,
            created_at: 1_000,
            state: "waiting".into(),
            sent_mailbox: sent_mailbox.into(),
            sent_uid: None,
            own_addresses: own(),
            seen: false,
            announced: false,
            attempts: 0,
            retry_at: 0,
            last_error: String::new(),
        }
    }

    fn eml(message_id: &str, from: &str, extra: &str) -> String {
        format!(
            "Message-ID: {message_id}\r\nFrom: {from}\r\nTo: x@example.com\r\nSubject: Re: Quote\r\n{extra}Date: Fri, 02 Oct 2026 10:00:00 +0000\r\n\r\nbody\r\n"
        )
    }

    fn sent_with(message_id: &str) -> Mailbox {
        Mailbox::new("Sent")
            .with_attrs(&["\\HasNoChildren", "\\Sent"])
            .push_msg(Message::new(0, eml(message_id, "me@example.com", "")).with_flags(&["\\Seen"]))
    }

    #[async_std::test]
    async fn follow_up_a_reply_from_someone_else_counts_and_an_own_nudge_does_not() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(
                    Mailbox::new("INBOX")
                        .push_msg(Message::new(0, eml("<r1@ana>", "ana@example.com", "In-Reply-To: <answered@me>\r\n")))
                        .push_msg(Message::new(0, eml("<mine@me>", "Me <alias@example.com>", "In-Reply-To: <silent@me>\r\n"))),
                )
                .mailbox(sent_with("<silent@me>")),
        );
        let mut s = session(&server).await;
        let (answered, _) = check(&mut s, &row("<answered@me>", ""), &own(), false).await.unwrap();
        assert_eq!(answered, Outcome::Replied);
        let (silent, last) = check(&mut s, &row("<silent@me>", ""), &own(), false).await.unwrap();
        let uid = server.state().find("Sent").unwrap().messages[0].uid;
        assert_eq!(silent, Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: uid });
        assert_eq!(last.as_deref(), Some("Sent"), "the last selected mailbox comes back");
        let (gone, _) = check(&mut s, &row("<gone@me>", ""), &own(), false).await.unwrap();
        assert_eq!(gone, Outcome::SentCopyGone);
        assert_eq!(server.count_commands("STORE") + server.count_commands("MOVE") + server.count_commands("APPEND"), 0);
    }

    #[async_std::test]
    async fn follow_up_all_mail_archive_and_trash_are_searched_and_auto_replies_skipped() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(
                    Mailbox::new("INBOX")
                        .push_msg(Message::new(0, eml("<v@ana>", "ana@example.com", "In-Reply-To: <auto@me>\r\nAuto-Submitted: auto-replied\r\n"))),
                )
                .mailbox(
                    Mailbox::new("[Gmail]/All Mail")
                        .with_attrs(&["\\HasNoChildren", "\\All"])
                        .push_msg(Message::new(0, eml("<r@ana>", "ana@example.com", "References: <root@x> <all@me>\r\n"))),
                )
                .mailbox(
                    Mailbox::new("Bin")
                        .with_attrs(&["\\HasNoChildren", "\\Trash"])
                        .push_msg(Message::new(0, eml("<r2@ana>", "ana@example.com", "References: <bin@me>\r\n"))),
                )
                .mailbox(sent_with("<auto@me>")),
        );
        let mut s = session(&server).await;
        assert_eq!(check(&mut s, &row("<all@me>", ""), &own(), false).await.unwrap().0, Outcome::Replied);
        assert_eq!(check(&mut s, &row("<bin@me>", ""), &own(), false).await.unwrap().0, Outcome::Replied);
        let (auto, _) = check(&mut s, &row("<auto@me>", ""), &own(), false).await.unwrap();
        assert!(matches!(auto, Outcome::NoReply { .. }), "an automatic reply counted: {auto:?}");
    }

    #[async_std::test]
    async fn follow_up_a_refused_inbox_or_temporary_refusal_is_an_error() {
        let refused = MockImap::start(
            Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(sent_with("<f@me>"))
                .fault(Trigger::with("SELECT", "INBOX"), Action::RefuseWith("NO".into(), "[NONEXISTENT] Not here".into())),
        );
        let mut s = session(&refused).await;
        assert!(check(&mut s, &row("<f@me>", ""), &own(), true).await.is_err());
        let temporary = MockImap::start(
            Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(sent_with("<t@me>"))
                .fault(Trigger::with("SEARCH", "In-Reply-To"), Action::RefuseWith("NO".into(), "[UNAVAILABLE] Backend down".into())),
        );
        let mut s = session(&temporary).await;
        assert!(check(&mut s, &row("<t@me>", ""), &own(), true).await.is_err());
    }

    /// Every reply search refused: only a local read that found nothing
    /// (`cache_miss`) settles the row; without one it is a try to repeat.
    #[async_std::test]
    async fn follow_up_every_search_refused_needs_a_cache_miss() {
        let refusing = || {
            MockImap::start(
                Scenario::new()
                    .mailbox(Mailbox::new("INBOX"))
                    .mailbox(sent_with("<s@me>"))
                    .fault(Trigger::with("SEARCH", "In-Reply-To"), Action::RefuseWith("BAD".into(), "Unsupported search criteria".into())),
            )
        };
        let server = refusing();
        let mut s = session(&server).await;
        assert!(check(&mut s, &row("<s@me>", ""), &own(), false).await.is_err());
        let server = refusing();
        let mut s = session(&server).await;
        let (outcome, _) = check(&mut s, &row("<s@me>", ""), &own(), true).await.unwrap();
        assert!(matches!(outcome, Outcome::NoReply { .. }), "{outcome:?}");
    }

    #[async_std::test]
    async fn follow_up_a_stored_sent_without_the_copy_gives_way_to_the_special_use_one() {
        let server = MockImap::start(
            Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Old Sent")).mailbox(sent_with("<o@me>")),
        );
        let mut s = session(&server).await;
        let (outcome, _) = check(&mut s, &row("<o@me>", "Old Sent"), &own(), false).await.unwrap();
        let uid = server.state().find("Sent").unwrap().messages[0].uid;
        assert_eq!(outcome, Outcome::NoReply { sent_mailbox: "Sent".into(), sent_uid: uid });
    }
}
