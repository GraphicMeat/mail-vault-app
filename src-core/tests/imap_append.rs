//! Which uid did the server give an appended message?
//!
//! RFC 4315 answers it in the tagged OK (`[APPENDUID validity uid]`) on a server
//! with UIDPLUS. Without it the answer is a search for the Message-ID, and a
//! message without one has no answer at all. Mode 1 of the mbox import files the
//! vault copy under that uid, so a wrong one is a message filed under another
//! message's name.

mod common;

use common::{eml, session};
use mailvault_core::imap::*;
use mock_imap::state::Mailbox;
use mock_imap::{Action, Message, MockImap, Scenario, Trigger};

/// INBOX with validity 77 and uids 1 to 4, UIDNEXT 5. Uid 2 is `eml("Twin")`, so
/// appending another `eml("Twin")` leaves two copies of one Message-ID. Neither
/// the validity nor the new uid is the mock's default of 1, so a parse that
/// invents them cannot pass.
fn server(uidplus: bool) -> MockImap {
    let mut inbox = Mailbox::new("INBOX").with_uid_validity(77);
    for (uid, subject) in [(1, "One"), (2, "Twin"), (3, "Three"), (4, "Four")] {
        inbox.add(Message::new(uid, eml(subject, "a@example.com", "body")));
    }
    let scenario = Scenario::new().mailbox(inbox);
    MockImap::start(if uidplus { scenario } else { scenario.without_cap("UIDPLUS") })
}

/// The commands the client sent after its APPEND.
fn after_append(server: &MockImap) -> Vec<String> {
    let all = server.commands();
    let at = all.iter().position(|c| c.contains("APPEND")).expect("an APPEND");
    all[at + 1..].to_vec()
}

/// The Subject of the newest message in INBOX.
fn newest_subject(server: &MockImap) -> String {
    let state = server.state();
    let raw = String::from_utf8_lossy(&state.find("INBOX").unwrap().messages.last().unwrap().raw).into_owned();
    raw.lines().find_map(|l| l.strip_prefix("Subject: ")).unwrap_or_default().to_string()
}

#[async_std::test]
async fn append_reports_the_validity_and_uid_the_server_sent() {
    let server = server(true);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let got = append_email(&mut sess, "INBOX", raw.as_bytes(), "", None).await.expect("append");

    assert_eq!(got, Some((77, 5)));
    assert_eq!(newest_subject(&server), "Fresh");
}

#[async_std::test]
async fn append_without_uidplus_reports_none_and_still_stores_the_message() {
    let server = server(false);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let got = append_email(&mut sess, "INBOX", raw.as_bytes(), "", None).await.expect("append");

    assert_eq!(got, None, "no UIDPLUS, no APPENDUID: nothing to report");
    assert_eq!(server.state().find("INBOX").unwrap().messages.len(), 5);
}

/// Mode 1 creates a missing folder and retries (D3), and it recognises the
/// refusal by the same text check as every other missing-mailbox error.
#[async_std::test]
async fn a_refused_append_to_a_missing_folder_reads_as_a_missing_mailbox() {
    let server = server(true);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let err = append_email(&mut sess, "NoSuchFolder", raw.as_bytes(), "", None)
        .await
        .expect_err("no such folder");

    assert!(is_missing_mailbox(&err), "{err}");
    assert!(err.contains("APPEND to 'NoSuchFolder'"), "{err}");
}

#[async_std::test]
async fn the_uid_helper_takes_appenduid_and_asks_the_server_nothing_more() {
    let server = server(true);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let uid = append_email_uid(&mut sess, "INBOX", raw.as_bytes(), "", None, Some("<fresh@example.com>"))
        .await
        .expect("append");

    assert_eq!(uid, Some(5));
    let later = after_append(&server);
    assert!(later.is_empty(), "APPENDUID answered it, yet the client kept talking: {later:?}");
}

#[async_std::test]
async fn the_uid_helper_finds_the_message_by_message_id_without_uidplus() {
    let server = server(false);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    // The id as it sits in the header, brackets and all: a caller has it that way.
    let uid = append_email_uid(&mut sess, "INBOX", raw.as_bytes(), "", None, Some("<fresh@example.com>"))
        .await
        .expect("append");

    assert_eq!(uid, Some(5));
    let later = after_append(&server);
    assert!(later.iter().any(|c| c.contains("SEARCH")), "the fallback must search: {later:?}");
}

#[async_std::test]
async fn the_fallback_takes_the_newest_copy_when_an_older_one_shares_the_id() {
    let server = server(false);
    let mut sess = session(&server).await;
    let raw = eml("Twin", "a@example.com", "body");

    let uid = append_email_uid(&mut sess, "INBOX", raw.as_bytes(), "", None, Some("twin@example.com"))
        .await
        .expect("append");

    assert_eq!(uid, Some(5), "uid 2 is the older twin, not the message just appended");
}

#[async_std::test]
async fn no_uidplus_and_no_message_id_is_none_and_searches_nothing() {
    for message_id in [None, Some("")] {
        let server = server(false);
        let mut sess = session(&server).await;
        let raw = eml("Fresh", "a@example.com", "body");

        let uid = append_email_uid(&mut sess, "INBOX", raw.as_bytes(), "", None, message_id)
            .await
            .expect("the message was stored, so this is not an error");

        assert_eq!(uid, None, "message_id {message_id:?}");
        assert!(after_append(&server).is_empty(), "nothing to search for");
        assert_eq!(server.state().find("INBOX").unwrap().messages.len(), 5);
    }
}

#[async_std::test]
async fn a_message_id_the_server_cannot_find_is_none_not_an_error() {
    let server = server(false);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let uid = append_email_uid(&mut sess, "INBOX", raw.as_bytes(), "", None, Some("someone-else@example.com"))
        .await
        .expect("the message was stored, so this is not an error");

    assert_eq!(uid, None);
}

/// The message is on the server by then. An `Err` here reads as "not uploaded",
/// and the caller would upload it again.
#[async_std::test]
async fn a_lookup_that_fails_after_the_append_is_none_not_an_error() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX"))
            .without_cap("UIDPLUS")
            .fault(Trigger::on("SELECT"), Action::DropConnection),
    );
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let uid = append_email_uid(&mut sess, "INBOX", raw.as_bytes(), "", None, Some("<fresh@example.com>"))
        .await
        .expect("the message was stored, so this is not an error");

    assert_eq!(uid, None);
    assert!(server.commands().iter().any(|c| c.contains("SELECT")), "the lookup never ran, so nothing failed");
    assert_eq!(server.state().find("INBOX").unwrap().messages.len(), 1, "the APPEND itself went through");
}

#[async_std::test]
async fn flags_and_internaldate_reach_the_server_with_and_without_uidplus() {
    for uidplus in [true, false] {
        let server = server(uidplus);
        let mut sess = session(&server).await;
        let raw = eml("Fresh", "a@example.com", "body");

        let uid = append_email_uid(
            &mut sess,
            "INBOX",
            raw.as_bytes(),
            "\\Seen \\Flagged",
            Some("05-Mar-2019 08:15:00 +0000"),
            Some("<fresh@example.com>"),
        )
        .await
        .expect("append");

        assert_eq!(uid, Some(5), "uidplus {uidplus}");
        let state = server.state();
        let msg = state.find("INBOX").unwrap().by_uid(5).expect("stored at the reported uid");
        assert!(msg.has_flag("\\Seen") && msg.has_flag("\\Flagged"), "flags dropped: {:?}", msg.flags);
        assert_eq!(msg.internal_date, "05-Mar-2019 08:15:00 +0000");
    }
}

// ── internaldate_of ────────────────────────────────────────────────────────

#[test]
fn internaldate_of_renders_the_date_header_as_an_imap_date_time() {
    assert_eq!(
        internaldate_of(b"Subject: x\r\nDate: Tue, 05 Mar 2019 08:15:00 +0000\r\n\r\n").as_deref(),
        Some("05-Mar-2019 08:15:00 +0000")
    );
}

/// The instant is kept and rendered in UTC, the way `internal_date_from_raw`
/// always has: a Date west of Greenwich late in the day lands on the next day.
#[test]
fn internaldate_of_converts_the_offset_to_utc() {
    assert_eq!(
        internaldate_of(b"Date: Tue, 05 Mar 2019 08:15:00 +0100\r\n\r\n").as_deref(),
        Some("05-Mar-2019 07:15:00 +0000")
    );
    assert_eq!(
        internaldate_of(b"Date: Mon, 31 Dec 2018 23:30:00 -0500\r\n\r\n").as_deref(),
        Some("01-Jan-2019 04:30:00 +0000")
    );
}

#[test]
fn internaldate_of_reads_an_mbox_head_with_bare_newlines_and_a_folded_date() {
    assert_eq!(
        internaldate_of(b"Subject: x\nDate: Tue, 05 Mar 2019\n 08:15:00 +0000\n\nbody").as_deref(),
        Some("05-Mar-2019 08:15:00 +0000")
    );
}

/// Only the head is read: a "Date:" line in the body is not the message's date,
/// and a body the size of an attachment is never parsed.
#[test]
fn internaldate_of_ignores_the_body() {
    let mut raw = b"Subject: x\r\nDate: Tue, 05 Mar 2019 08:15:00 +0000\r\n\r\nDate: Wed, 01 Jan 2020 00:00:00 +0000\r\n".to_vec();
    assert_eq!(internaldate_of(&raw).as_deref(), Some("05-Mar-2019 08:15:00 +0000"));
    raw = b"Subject: x\r\n\r\nDate: Wed, 01 Jan 2020 00:00:00 +0000\r\n".to_vec();
    assert_eq!(internaldate_of(&raw), None, "the body's Date: line is not a header");
}

#[test]
fn internaldate_of_an_unparseable_or_missing_date_is_none() {
    assert_eq!(internaldate_of(b"Date: sometime last week\r\n\r\n"), None);
    assert_eq!(internaldate_of(b"Date: \r\n\r\n"), None);
    assert_eq!(internaldate_of(b"Subject: no date\r\n\r\n"), None);
    assert_eq!(internaldate_of(b""), None);
}

/// A spam Date far in the future renders a signed five-digit year no server
/// parses; the APPEND goes without a date rather than draw a BAD.
#[test]
fn internaldate_of_a_year_past_9999_is_none() {
    assert_eq!(internaldate_of(b"Date: Mon, 1 Jan 20250 00:00:00 +0000\r\n\r\n"), None);
    assert_eq!(
        internaldate_of(b"Date: Fri, 31 Dec 9999 12:00:00 +0000\r\n\r\n").as_deref(),
        Some("31-Dec-9999 12:00:00 +0000")
    );
}

// ── LITERAL+ ───────────────────────────────────────────────────────────────

/// A LITERAL+ server takes the message right behind the command: the client
/// never waits for a `+` (the mock sends none for `{n+}`, so a client that
/// waited would stall here), and the reply still carries the uid.
#[async_std::test]
async fn a_literal_plus_append_sends_the_message_without_waiting_for_a_go_ahead() {
    let mut inbox = Mailbox::new("INBOX").with_uid_validity(77);
    inbox.add(Message::new(4, eml("Four", "a@example.com", "body")));
    let server = MockImap::start(Scenario::new().mailbox(inbox).with_cap("LITERAL+"));
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    let got = append_email_with(&mut sess, "INBOX", raw.as_bytes(), "\\Seen", None, true).await.expect("append");

    assert_eq!(got, Some((77, 5)));
    assert_eq!(newest_subject(&server), "Fresh");
    let line = server.commands().into_iter().find(|c| c.contains("APPEND")).expect("an APPEND");
    assert!(line.ends_with(&format!("{{{}+}}", raw.len())), "{line}");
    // The session is in step afterwards: the next command reads its own reply.
    assert_eq!(select_mailbox(&mut sess, "INBOX").await.expect("select").exists, 2);
}

#[async_std::test]
async fn without_literal_plus_the_literal_is_synchronous() {
    let server = server(true);
    let mut sess = session(&server).await;
    let raw = eml("Fresh", "a@example.com", "body");

    append_email_with(&mut sess, "INBOX", raw.as_bytes(), "", None, false).await.expect("append");

    let line = server.commands().into_iter().find(|c| c.contains("APPEND")).expect("an APPEND");
    assert!(line.ends_with(&format!("{{{}}}", raw.len())), "{line}");
}

// ── message_id_uids ────────────────────────────────────────────────────────

#[async_std::test]
async fn message_id_uids_lists_every_copy_in_the_selected_mailbox() {
    let server = server(true);
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.expect("select");
    append_email(&mut sess, "INBOX", eml("Twin", "a@example.com", "again").as_bytes(), "", None).await.expect("append");

    assert_eq!(message_id_uids(&mut sess, "<twin@example.com>").await.expect("search"), vec![2, 5]);
    assert_eq!(message_id_uids(&mut sess, "nobody@example.com").await.expect("search"), Vec::<u32>::new());
}

/// A CR inside an id would end the SEARCH command early and send the rest as
/// a command of its own; an empty id would match every message.
#[async_std::test]
async fn message_id_uids_refuses_an_id_it_cannot_quote_and_sends_nothing() {
    let server = server(true);
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.expect("select");

    for id in ["twin@example.com\r\nA1 DELETE INBOX", "a\u{0}b@example.com", "<>", "  "] {
        assert!(message_id_uids(&mut sess, id).await.is_err(), "{id:?} must be refused");
    }
    assert_eq!(server.count_commands("SEARCH"), 0);
    assert!(server.state().find("INBOX").is_some());
}

/// A socket that dies before the tagged reply is an error: "no copy" would
/// have the caller upload the message again.
#[async_std::test]
async fn message_id_uids_on_a_dropped_connection_is_an_error_not_none() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX"))
            .fault(Trigger::on("SEARCH"), Action::DropConnection),
    );
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.expect("select");

    assert!(message_id_uids(&mut sess, "<a@example.com>").await.is_err());
}
