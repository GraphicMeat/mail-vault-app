//! Header/body fetch correctness against the mock server.

mod common;

use common::{config_for, eml, pool, session};
use mailvault_core::imap::*;
use mock_imap::state::{synthetic_mailbox, Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};

#[async_std::test]
async fn connects_lists_and_fetches_a_small_inbox() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
    let mut sess = session(&server).await;

    let mailboxes = list_mailboxes(&mut sess).await.expect("list");
    assert_eq!(mailboxes.len(), 1);
    assert_eq!(mailboxes[0].name, "INBOX");

    select_mailbox(&mut sess, "INBOX").await.expect("select");
    let (emails, total, _more, _sizes) = fetch_emails_page(&mut sess, "INBOX", 1, 10)
        .await
        .expect("fetch page");

    assert_eq!(total, 3);
    assert_eq!(emails.len(), 3);
    let subjects: Vec<&str> = emails.iter().map(|e| e.subject.as_str()).collect();
    assert!(subjects.contains(&"Message 1"), "got {:?}", subjects);
    assert!(subjects.contains(&"Message 3"), "got {:?}", subjects);
    assert_eq!(emails[0].from.address, "sender3@example.com");
}

#[async_std::test]
async fn decodes_rfc2047_subjects_and_utf8_bodies() {
    // Encoded-words arrive raw from the server; decoding is the client's job.
    let raw = "From: Ana <ana@example.com>\r\n\
               To: user@example.com\r\n\
               Subject: =?UTF-8?B?w4RyZW5kZSBww6VtaW5uZWxzZQ==?=\r\n\
               Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
               Message-ID: <utf8@example.com>\r\n\
               Content-Type: text/plain; charset=UTF-8\r\n\
               \r\n\
               Grüße\r\n";
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push(raw)),
    );
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10).await.unwrap();
    assert_eq!(emails[0].subject, "Ärende påminnelse");
    assert_eq!(emails[0].from.name.as_deref(), Some("Ana"));
}

#[async_std::test]
async fn survives_a_message_with_no_subject_and_no_references() {
    let raw = "From: bare@example.com\r\n\
               To: user@example.com\r\n\
               Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
               Message-ID: <bare@example.com>\r\n\
               \r\n\
               no headers to speak of\r\n";
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(raw)));
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10).await.unwrap();
    assert_eq!(emails.len(), 1);
    assert!(emails[0].references.as_ref().map_or(true, |r| r.is_empty()));
}

#[async_std::test]
async fn detects_attachments_from_bodystructure() {
    let with_pdf = "From: a@example.com\r\n\
        To: user@example.com\r\n\
        Subject: Invoice\r\n\
        Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
        Message-ID: <att@example.com>\r\n\
        Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\
        \r\n\
        --BOUND\r\n\
        Content-Type: text/plain; charset=UTF-8\r\n\
        \r\n\
        See attached.\r\n\
        --BOUND\r\n\
        Content-Type: application/pdf; name=\"invoice.pdf\"\r\n\
        Content-Disposition: attachment; filename=\"invoice.pdf\"\r\n\
        Content-Transfer-Encoding: base64\r\n\
        \r\n\
        JVBERi0xLjQK\r\n\
        --BOUND--\r\n";

    // Inline image with a Content-ID is embedded, not an attachment.
    let with_cid = "From: b@example.com\r\n\
        To: user@example.com\r\n\
        Subject: Newsletter\r\n\
        Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
        Message-ID: <cid@example.com>\r\n\
        Content-Type: multipart/related; boundary=\"BOUND\"\r\n\
        \r\n\
        --BOUND\r\n\
        Content-Type: text/html; charset=UTF-8\r\n\
        \r\n\
        <img src=\"cid:logo\">\r\n\
        --BOUND\r\n\
        Content-Type: image/png\r\n\
        Content-ID: <logo>\r\n\
        Content-Disposition: inline\r\n\
        Content-Transfer-Encoding: base64\r\n\
        \r\n\
        iVBORw0KGgo=\r\n\
        --BOUND--\r\n";

    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push(with_pdf).push(with_cid)),
    );
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    // search_emails uses the BODYSTRUCTURE-carrying fetch spec.
    let (emails, _) = search_emails(&mut sess, "INBOX", None, None, Some("e"), None, None)
        .await
        .expect("search");

    let invoice = emails.iter().find(|e| e.subject == "Invoice").expect("invoice");
    let newsletter = emails.iter().find(|e| e.subject == "Newsletter").expect("newsletter");
    assert!(invoice.has_attachments, "pdf attachment should be detected");
    assert!(
        !newsletter.has_attachments,
        "cid-referenced inline image is not an attachment"
    );
}

#[async_std::test]
async fn fetches_a_full_message_body_by_uid() {
    let server = MockImap::start(Scenario::new().mailbox(
        Mailbox::new("INBOX").push(eml("Hello", "Sam <sam@example.com>", "Body text here")),
    ));
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    let email = fetch_email_by_uid(&mut sess, "INBOX", 1)
        .await
        .expect("fetch uid 1")
        .expect("uid 1 exists");
    assert_eq!(email.subject, "Hello");
    assert!(email.text.unwrap_or_default().contains("Body text here"));
}

#[async_std::test]
async fn paginates_a_large_mailbox_newest_first() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 250)));
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    let (page1, total, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 50).await.unwrap();
    let (page2, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 2, 50).await.unwrap();

    assert_eq!(total, 250);
    assert_eq!(page1.len(), 50);
    assert_eq!(page2.len(), 50);
    assert_eq!(page1[0].uid, 250, "page 1 starts at the newest UID");
    assert_eq!(page2[0].uid, 200, "page 2 continues below page 1");

    let overlap = page1.iter().any(|a| page2.iter().any(|b| a.uid == b.uid));
    assert!(!overlap, "pages must not overlap");
}

#[async_std::test]
async fn search_all_uids_returns_every_uid() {
    let mut mb = Mailbox::new("INBOX");
    // Sparse, non-contiguous UIDs — the realistic case after expunges.
    for uid in [3u32, 9, 10, 11, 40] {
        mb.add(Message::new(uid, eml(&format!("S{uid}"), "x@example.com", "b")));
    }
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    let uids = search_all_uids(&mut sess, "INBOX", false).await.expect("all uids");
    assert_eq!(uids, vec![3, 9, 10, 11, 40]);
}

#[test]
fn compresses_uid_ranges_for_the_wire() {
    assert_eq!(compress_uid_ranges(&[1, 2, 3, 7, 9, 10]), "1:3,7,9:10");
    assert_eq!(compress_uid_ranges(&[5]), "5");
    assert_eq!(compress_uid_ranges(&[]), "");
}

#[async_std::test]
async fn reports_a_useful_error_when_login_is_rejected() {
    let mut scenario = Scenario::new();
    scenario.state.expect_login = Some(("someone@else.com".into(), "nope".into()));
    let server = MockImap::start(scenario);

    let err = create_imap_session(&config_for(&server), &pool())
        .await
        .expect_err("login must fail");
    assert!(err.contains("Login failed"), "got: {err}");
}

// ── An empty FETCH result is not a missing message ──────────────────────────
//
// `filter_sync` in async-imap drops the tagged response without reading its
// status, so every one of the refusals below reaches the client as a stream
// that ends with no rows and no error — the same observation a genuinely
// deleted uid produces. The reading pane turned that into "Email not found"
// for mail sitting right there in the list. Each test here pins one refusal
// shape to an error; the last one pins the honest absence, so a fix that just
// stops saying "gone" cannot pass.

/// The body FETCH is refused, a plain `(UID)` fetch is not: the cheap probe
/// finds the uid and the caller says the message is still on the server.
#[async_std::test]
async fn a_refused_body_fetch_says_the_message_is_still_there() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(
                Trigger::with("FETCH", "BODY.PEEK[]"),
                Action::Respond("NO".into(), "Server cannot read that message".into()),
            ),
    );
    let mut sess = session(&server).await;

    let err = fetch_email_by_uid_light(&mut sess, "INBOX", 1)
        .await
        .expect_err("a refused body must not read as a deleted message");
    assert!(err.contains("still in INBOX"), "got: {err}");
}

/// The refusal covers the uid, not just its body — Gmail did exactly this in
/// production (2026-08-24, uid 31056, eight attempts, `found=false` every
/// time). The old probe re-asked with a second `UID FETCH`, which is the same
/// blind question, so both came back empty and the app reported the message
/// as gone. Only a tagged `OK` may prove absence.
#[async_std::test]
async fn a_uid_the_server_refuses_outright_is_an_error_not_an_absence() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(
                Trigger::on("FETCH"),
                Action::Respond("NO".into(), "Bandwidth limit exceeded".into()),
            ),
    );
    let mut sess = session(&server).await;

    let err = fetch_email_by_uid_light(&mut sess, "INBOX", 1)
        .await
        .expect_err("a server that refuses every FETCH has not said the message is gone");
    assert!(
        err.to_lowercase().contains("refused") || err.contains("Bandwidth limit exceeded"),
        "the reason must carry the server's own answer, got: {err}",
    );
}

/// A pooled session whose socket has died answers a fetch in under a
/// millisecond with nothing at all — no rows, no error. Production log,
/// 06:02:28: `imap_get_email_light: uid=31045 found=false in 0ms`.
#[async_std::test]
async fn a_dead_socket_is_an_error_not_an_absence() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(Trigger::on("FETCH"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = fetch_email_by_uid_light(&mut sess, "INBOX", 1)
        .await
        .expect_err("a closed socket must not read as a deleted message");
    assert!(!err.is_empty());
}

/// The other half of the contract: when the server answers normally and has no
/// such uid, absence is the honest report and must still be reachable.
#[async_std::test]
async fn a_uid_the_server_really_does_not_have_is_reported_absent() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body"))),
    );
    let mut sess = session(&server).await;

    let missing = fetch_email_by_uid_light(&mut sess, "INBOX", 4242)
        .await
        .expect("an honest empty answer is not an error");
    assert!(missing.is_none(), "uid 4242 was never in this mailbox");
}

/// A list page must say what the row will show — size and paperclip — without
/// the message being opened. The lean spec used to omit both, so every row off
/// the search path said "no attachments" until it was clicked.
const WITH_PDF: &str = "From: billing@example.com\r\n\
To: user@example.com\r\n\
Subject: Invoice\r\n\
Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
Message-ID: <invoice@example.com>\r\n\
Content-Type: multipart/mixed; boundary=\"B\"\r\n\
\r\n\
--B\r\n\
Content-Type: text/plain; charset=UTF-8\r\n\
\r\n\
See attached.\r\n\
--B\r\n\
Content-Type: application/pdf; name=\"invoice.pdf\"\r\n\
Content-Disposition: attachment; filename=\"invoice.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--B--\r\n";

#[async_std::test]
async fn list_pages_carry_size_and_attachment_presence() {
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(Message::new(1, WITH_PDF));
    inbox.add(Message::new(2, eml("Plain", "a@example.com", "hello")));
    let server = MockImap::start(Scenario::new().mailbox(inbox));
    let mut sess = session(&server).await;

    let (page, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10).await.expect("page");
    let invoice = page.iter().find(|e| e.uid == 1).expect("invoice row");
    let plain = page.iter().find(|e| e.uid == 2).expect("plain row");
    assert!(invoice.has_attachments, "the paperclip must come from the list fetch, not from opening");
    assert!(!plain.has_attachments);
    assert_eq!(invoice.size, Some(WITH_PDF.len() as u32));

    let (by_uid, _) = fetch_headers_by_uids(&mut sess, "INBOX", &[1]).await.expect("by uid");
    assert!(by_uid[0].has_attachments, "the daemon's cold sync and backfill use this path");
    assert_eq!(by_uid[0].size, Some(WITH_PDF.len() as u32));
}
