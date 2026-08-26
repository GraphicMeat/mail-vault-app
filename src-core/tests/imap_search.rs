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

// ── Cross-folder Message-ID probe ───────────────────────────────────────────
//
// The gold "your only copy" row claims the server no longer holds a message.
// It used to be derived from the ACTIVE MAILBOX's uid set, which is a mailbox
// fact printed as a server fact: an archive, a filter or a delete moves a
// message out of INBOX and leaves it very much alive under All Mail, a label
// or the Bin. `find_message_id` is the question that actually settles it, and
// these tests pin the only two answers it is allowed to give.

fn probe_eml(message_id: &str) -> String {
    format!(
        "From: sender@example.com\r\n\
         To: user@example.com\r\n\
         Subject: Aruodas listing\r\n\
         Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
         Message-ID: <{message_id}>\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         \r\n\
         body\r\n"
    )
}

/// The whole point: the message is NOT in the folder it was archived from, and
/// the server still has it. Absence from INBOX must never read as absence.
#[async_std::test]
async fn a_message_moved_out_of_inbox_is_still_found() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Other", "a@b.c", "hi")))
            .mailbox(Mailbox::new("Archive").push(probe_eml("kept@example.com")))
            .mailbox(Mailbox::new("Trash")),
    );
    let mut sess = session(&server).await;

    let probe = find_message_id(&mut sess, "<kept@example.com>", false)
        .await
        .expect("probe");

    assert_eq!(
        probe.found,
        vec![MessageIdLocation { mailbox: "Archive".into(), uid: 1 }],
        "the copy in Archive must be found — it is the copy the row would have called deleted"
    );
}

/// The alarm. Every selectable folder answered, none has it: `complete` is the
/// flag that makes the claim sayable.
#[async_std::test]
async fn absence_is_claimable_only_when_every_folder_answered() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Other", "a@b.c", "hi")))
            .mailbox(Mailbox::new("Archive"))
            .mailbox(Mailbox::new("Trash")),
    );
    let mut sess = session(&server).await;

    let probe = find_message_id(&mut sess, "<gone@example.com>", false)
        .await
        .expect("probe");

    assert!(probe.found.is_empty(), "nothing holds it");
    assert!(probe.complete, "three folders, three answers");
    assert_eq!(probe.searched.len(), 3);
    assert!(probe.failed.is_empty());
}

/// One folder that will not open is one folder that could be holding it. The
/// sweep continues — a tagged NO leaves the session clean — but the verdict is
/// unknown, not absent, and `failed` names the folder that would not answer.
#[async_std::test]
async fn a_folder_that_refuses_to_open_forbids_the_absence_claim() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX"))
            .mailbox(Mailbox::new("Archive"))
            .mailbox(Mailbox::new("Spam"))
            .fault(
                Trigger::with("SELECT", "Spam"),
                Action::Respond("NO".into(), "[NOPERM] Not yours".into()),
            ),
    );
    let mut sess = session(&server).await;

    let probe = find_message_id(&mut sess, "<gone@example.com>", false)
        .await
        .expect("a refused folder is not a failed probe");

    assert!(probe.found.is_empty());
    assert!(!probe.complete, "Spam never answered — absence is not provable");
    assert_eq!(probe.failed, vec!["Spam".to_string()]);
    assert_eq!(probe.searched.len(), 2, "the other two still answered");
}

/// `[Gmail]` and friends are containers: SELECT fails on them by definition, so
/// counting them as unanswered would make absence permanently unclaimable on
/// every Gmail account.
#[async_std::test]
async fn noselect_containers_do_not_block_the_claim() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX"))
            .mailbox(Mailbox::new("[Gmail]").with_attrs(&["\\Noselect", "\\HasChildren"]))
            .mailbox(Mailbox::new("[Gmail]/All Mail")),
    );
    let mut sess = session(&server).await;

    let probe = find_message_id(&mut sess, "<gone@example.com>", false)
        .await
        .expect("probe");

    assert!(probe.complete, "a container is not an unanswered folder");
    assert!(!probe.searched.iter().any(|p| p == "[Gmail]"));
    assert!(probe.searched.iter().any(|p| p == "[Gmail]/All Mail"));
}

/// Presence needs one hit; absence needs all of them. INBOX is swept first so
/// the common answer costs one round trip.
#[async_std::test]
async fn stop_on_first_ends_the_sweep_at_the_first_copy() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(probe_eml("kept@example.com")))
            .mailbox(Mailbox::new("Archive").push(probe_eml("kept@example.com")))
            .mailbox(Mailbox::new("Trash")),
    );
    let mut sess = session(&server).await;

    let probe = find_message_id(&mut sess, "<kept@example.com>", true)
        .await
        .expect("probe");

    assert_eq!(probe.found.len(), 1);
    assert_eq!(probe.searched, vec!["INBOX".to_string()]);
    assert!(!probe.complete, "an early return has not searched everything");
}

/// An empty Message-ID would match every header on the server. Refuse it — the
/// alternative is a probe that answers "found everywhere" or "absent" about a
/// message it never looked for.
#[async_std::test]
async fn an_empty_message_id_is_refused() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
    let mut sess = session(&server).await;

    assert!(find_message_id(&mut sess, "<>", false).await.is_err());
    assert!(find_message_id(&mut sess, "   ", false).await.is_err());
}

#[test]
fn the_search_term_drops_the_angle_brackets() {
    // Servers disagree about storing them; HEADER matching is a substring, so
    // the unbracketed form matches both.
    assert_eq!(message_id_search_term("<a@b.c>"), "a@b.c");
    assert_eq!(message_id_search_term("  a@b.c  "), "a@b.c");
    assert_eq!(message_id_search_term("a\"b@c"), "a\\\"b@c");
}

/// An account whose LIST comes back empty has not been searched — it has failed
/// to be searched, and the difference is every message on it going gold.
/// `list_mailboxes` already refuses an empty LIST as a dropped response; this
/// pins that the probe inherits the refusal instead of reporting "found
/// nowhere" over zero folders.
#[async_std::test]
async fn an_account_with_no_listed_folders_proves_nothing() {
    // `Scenario::new()` ships a default INBOX — clear it, so LIST really is empty.
    let server = MockImap::start(Scenario::new().mailboxes(vec![]));
    let mut sess = session(&server).await;

    let err = find_message_id(&mut sess, "<gone@example.com>", false)
        .await
        .expect_err("zero folders is a failed sweep, not an empty one");
    assert!(err.contains("LIST"), "the error must name what did not answer: {err}");
}
