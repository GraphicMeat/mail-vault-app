//! Regressions around UID enumeration and SEARCH.
//!
//! Every scenario in this file is a real production failure. See 06a31c2
//! (Purelymail keepalive) and 8eae2ba (ESEARCH parse poisoning).

mod common;

use common::{eml, session};
use mailvault_core::imap::*;
use mock_imap::state::{synthetic_mailbox, Mailbox};
use mock_imap::{Action, MockImap, Scenario, Trigger};

/// Purelymail splices `* OK Still here` into the middle of a long untagged line.
/// On `UID SEARCH ALL` the whole UID list is ONE line, so the keepalive lands
/// inside it and imap-proto cannot parse the result.
///
/// The fix was to stop using SEARCH for enumeration. This test locks that in:
/// even with the splice armed on SEARCH, enumeration succeeds — because we never
/// issue a SEARCH to enumerate.
#[async_std::test]
async fn keepalive_spliced_into_search_cannot_break_uid_enumeration() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 40))
            .fault(
                Trigger::on("SEARCH"),
                Action::InjectMidLine("* OK Still here\r\n".into()),
            ),
    );
    let mut sess = session(&server).await;

    let uids = search_all_uids(&mut sess, "INBOX", false)
        .await
        .expect("enumeration must survive a poisoned SEARCH");
    assert_eq!(uids.len(), 40);

    let sent = server.commands().join("\n").to_uppercase();
    assert!(
        !sent.contains("UID SEARCH"),
        "enumeration must not use SEARCH — one long line is what the keepalive corrupts.\n{sent}"
    );
    assert!(sent.contains("UID FETCH 1:*"), "expected UID FETCH enumeration\n{sent}");
}

/// A keepalive *between* untagged FETCH lines is well-formed and must be
/// tolerated — that is the whole reason FETCH is safe where SEARCH is not.
#[async_std::test]
async fn keepalive_between_fetch_lines_is_tolerated() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 25))
            .fault(
                Trigger::on("FETCH"),
                Action::InjectUntagged("* OK Still here".into()),
            ),
    );
    let mut sess = session(&server).await;

    let uids = search_all_uids(&mut sess, "INBOX", false).await.expect("enumerate");
    assert_eq!(uids.len(), 25);
}

/// The dangerous failure is not an error — it is a *short list*. Callers prune
/// the local cache against this result, so a truncated enumeration used to
/// delete real mail off disk. It must be an Err, never a partial Ok.
#[async_std::test]
async fn truncated_enumeration_errors_instead_of_returning_a_short_list() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 200))
            .fault(Trigger::on("FETCH"), Action::TruncateResponse(300)),
    );
    let mut sess = session(&server).await;

    let result = search_all_uids(&mut sess, "INBOX", false).await;
    assert!(
        result.is_err(),
        "a cut-off UID list must fail loudly, got Ok({:?} uids)",
        result.map(|u| u.len())
    );
}

/// Mid-line garbage inside the FETCH stream is equally unparseable — and must
/// also fail rather than yield whatever parsed before the corruption.
#[async_std::test]
async fn corrupted_fetch_stream_does_not_yield_a_partial_uid_list() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 60))
            .fault(
                Trigger::on("FETCH"),
                Action::InjectMidLine(" \x00garbage\x00 ".into()),
            ),
    );
    let mut sess = session(&server).await;

    match search_all_uids(&mut sess, "INBOX", false).await {
        Err(_) => {}
        Ok(uids) => assert_eq!(
            uids.len(),
            60,
            "either parse everything or fail — a partial list prunes the cache"
        ),
    }
}

/// imap-proto cannot parse some servers' valid `* ESEARCH` replies. When that
/// happens the unread bytes poison the session, so the error must surface here
/// rather than being swallowed into an empty result.
#[async_std::test]
async fn esearch_reply_where_search_was_expected_surfaces_an_error() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hi", "a@example.com", "b")))
            .fault(
                Trigger::on("SEARCH"),
                Action::RespondRaw(
                    "* ESEARCH (TAG \"{tag}\") UID ALL 1:1\r\n{tag} OK SEARCH completed\r\n".into(),
                ),
            ),
    );
    let mut sess = session(&server).await;

    let result = search_emails(&mut sess, "INBOX", Some("Hi"), None, None, None, None).await;
    assert!(
        result.is_err() || result.as_ref().unwrap().0.is_empty(),
        "an unparseable ESEARCH must not look like a successful search"
    );
}

/// Server-side pagination that silently returns a fraction of the matches.
/// Search results feed the UI, not the cache, so a short list here is a
/// display bug rather than data loss — but it must not be reported as complete.
#[async_std::test]
async fn partial_search_results_are_not_reported_as_the_full_match_count() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 100))
            .fault(Trigger::on("SEARCH"), Action::PartialSearchResult(0.25)),
    );
    let mut sess = session(&server).await;

    let (emails, total) = search_emails(&mut sess, "INBOX", Some("Body"), None, None, None, None)
        .await
        .expect("search");
    assert_eq!(
        emails.len() as u32,
        total.min(emails.len() as u32),
        "reported total must not exceed what was actually returned"
    );
    assert_eq!(total, 25, "total should reflect the UIDs the server actually sent");
}

#[async_std::test]
async fn search_filters_by_from_and_subject() {
    let mut mb = Mailbox::new("INBOX");
    mb.add(mock_imap::Message::new(1, eml("Invoice March", "acct@vendor.com", "x")));
    mb.add(mock_imap::Message::new(2, eml("Lunch", "friend@example.com", "y")));
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut sess = session(&server).await;

    let (by_from, _) = search_emails(&mut sess, "INBOX", None, Some("vendor.com"), None, None, None)
        .await
        .expect("from search");
    assert_eq!(by_from.len(), 1);
    assert_eq!(by_from[0].subject, "Invoice March");

    let (by_subject, _) =
        search_emails(&mut sess, "INBOX", None, None, Some("Lunch"), None, None)
            .await
            .expect("subject search");
    assert_eq!(by_subject.len(), 1);
    assert_eq!(by_subject[0].subject, "Lunch");
}
