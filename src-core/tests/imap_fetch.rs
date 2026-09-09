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
    let (emails, total, _more, _sizes) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[])
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

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[]).await.unwrap();
    assert_eq!(emails[0].subject, "Ärende påminnelse");
    assert_eq!(emails[0].from.name.as_deref(), Some("Ana"));
}

#[async_std::test]
async fn strips_quoted_string_escapes_from_envelope_fields() {
    // A partially RFC 2047 encoded subject stays ASCII on the wire, so the
    // server sends it as an IMAP quoted-string and escapes the inner quotes.
    // Same for the display name. Neither backslash belongs to the value.
    let raw = "From: \"Jonas \\\"JJ\\\" Jonaitis\" <jj@example.com>\r\n\
               To: user@example.com\r\n\
               Subject: =?UTF-8?Q?Prat=C4=99skite_=C5=BEurnalo?= \"Iliustruotoji istorija\" =?UTF-8?Q?prenumerat=C4=85?=\r\n\
               Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
               Message-ID: <quoted@example.com>\r\n\
               \r\n\
               body\r\n";
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(raw)));
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[]).await.unwrap();
    assert_eq!(
        emails[0].subject,
        "Pratęskite žurnalo \"Iliustruotoji istorija\" prenumeratą"
    );
    assert_eq!(
        emails[0].from.name.as_deref(),
        Some("Jonas \"JJ\" Jonaitis")
    );
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

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[]).await.unwrap();
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

    let (page1, total, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 50, &[]).await.unwrap();
    let (page2, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 2, 50, &[]).await.unwrap();

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

    let (page, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[]).await.expect("page");
    let invoice = page.iter().find(|e| e.uid == 1).expect("invoice row");
    let plain = page.iter().find(|e| e.uid == 2).expect("plain row");
    assert!(invoice.has_attachments, "the paperclip must come from the list fetch, not from opening");
    assert!(!plain.has_attachments);
    assert_eq!(invoice.size, Some(WITH_PDF.len() as u32));

    let (by_uid, _) = fetch_headers_by_uids(&mut sess, "INBOX", &[1], &[]).await.expect("by uid");
    assert!(by_uid[0].has_attachments, "the daemon's cold sync and backfill use this path");
    assert_eq!(by_uid[0].size, Some(WITH_PDF.len() as u32));
}

// ── B4: a poisoned FETCH stream ────────────────────────────────────────────
//
// async-imap's decoder stops advancing after a line it cannot parse, so one
// bad item costs every item behind it and the page comes back SHORT — the same
// shape as a mailbox that really holds that many. The lenient collector logged
// the shortfall and returned what it had; a listing path must fail instead, and
// let the caller's retry decide.

#[async_std::test]
async fn a_poisoned_item_fails_the_page_instead_of_shortening_it() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::on("FETCH"), Action::CorruptFetchItem(2)),
    );
    let mut sess = session(&server).await;

    let err = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[])
        .await
        .expect_err("a page missing items it never saw is not a page");
    assert!(err.contains("unparseable"), "unhelpful error: {err}");
    assert!(err.contains("fetch_emails_page"), "the error must name the path: {err}");
}

#[async_std::test]
async fn a_poisoned_item_fails_a_uid_header_fetch_too() {
    // The daemon's cold sync and every backfill run through this one.
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::on("FETCH"), Action::CorruptFetchItem(2)),
    );
    let mut sess = session(&server).await;

    let err = fetch_headers_by_uids(&mut sess, "INBOX", &[1, 2, 3], &[])
        .await
        .expect_err("a short UID fetch must not read as the whole answer");
    assert!(err.contains("unparseable"), "unhelpful error: {err}");
}

#[async_std::test]
async fn search_still_returns_what_parsed() {
    // Search stays lenient on purpose: its rows are a filtered view the user
    // asked for, not an enumeration anything downstream reconciles against, so
    // half the hits beats an error with no hits at all.
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::on("FETCH"), Action::CorruptFetchItem(2)),
    );
    let mut sess = session(&server).await;

    let (rows, total) = search_emails(&mut sess, "INBOX", Some("Message"), None, None, None, None)
        .await
        .expect("search must not fail over a poisoned item");
    assert_eq!(total, 3, "the SEARCH itself matched all three");
    assert!(!rows.is_empty(), "the rows that parsed must survive");
    assert!(rows.len() < 3, "the fault must actually poison an item: {rows:?}");
}

// ── A bounded fetch ────────────────────────────────────────────────────────
//
// A backup that fetches thousands of messages holds one session per worker. If
// the disk stalls a worker long enough for the server (or a NAT) to drop that
// socket, the next FETCH on it never answers and `join_next()` waits for ever:
// the whole backup locks up with nothing logged. `bounded` is the ceiling.
//
// Both run under tokio, not async-std: `bounded` is `tokio::time::timeout` and
// panics without a tokio reactor (see `append_verified_survives_a_slow_server`
// in imap_write.rs). That matches production — daemon and Tauri are both tokio.

#[tokio::test]
async fn a_fetch_the_server_never_answers_gives_up_instead_of_hanging() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("FETCH"), Action::Delay(std::time::Duration::from_secs(5))),
    );
    let mut sess = session(&server).await;

    let started = std::time::Instant::now();
    let err = bounded("UID FETCH 1", 1, fetch_email_by_uid(&mut sess, "INBOX", 1))
        .await
        .expect_err("a fetch that never answers must not be awaited for ever");

    assert!(err.contains("timed out"), "unhelpful error: {err}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "the bound must fire, not the server: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_healthy_fetch_is_untouched_by_the_bound() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let mut sess = session(&server).await;

    let email = bounded("UID FETCH 1", 10, fetch_email_by_uid(&mut sess, "INBOX", 1))
        .await
        .expect("a server that answers must pass straight through");
    assert!(email.is_some(), "the message is right there");
}

// ── Shapes imap-proto used to refuse ───────────────────────────────────────
//
// The vendored parser (vendor/imap-proto) carries two MailVault patches. Both
// exist because one unreadable FETCH line takes the whole connection with it:
// async-imap marks the session dead and yields a single Err, so the user gets
// "Server error" and no mail at all rather than one odd row.

#[async_std::test]
async fn parses_an_icloud_message_id_with_unescaped_quotes() {
    // imap.mail.me.com serves message-ids with raw inner quotes inside the
    // ENVELOPE quoted-string (Apple developer forum thread 724704).
    const REPLY: &str = concat!(
        r#"* 1 FETCH (UID 1 FLAGS (\Seen) "#,
        r#"ENVELOPE ("Thu, 01 Jan 2026 12:00:00 +0000" "iCloud" "#,
        r#"(("Ana" NIL "ana" "example.com")) (("Ana" NIL "ana" "example.com")) "#,
        r#"(("Ana" NIL "ana" "example.com")) (("You" NIL "user" "example.com")) NIL NIL NIL "#,
        r#""<"392889836.11.1529401004417.JavaMail.tomcat"@host>") "#,
        r#"INTERNALDATE "01-Jan-2026 12:00:00 +0000" RFC822.SIZE 120 "#,
        r#"BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL) "#,
        r#"BODY[HEADER.FIELDS (References Authentication-Results Return-Path Reply-To "#,
        r#"List-Unsubscribe List-Id Precedence)] {2}\r\n"#,
        r#"\r\n)\r\n"#,
        r#"{tag} OK FETCH completed\r\n"#,
    );

    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("FETCH"), Action::RespondRaw(REPLY.into())),
    );
    let mut sess = session(&server).await;

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[])
        .await
        .expect("an unescaped inner quote must not fail the page");
    assert_eq!(emails.len(), 1);
    let id = emails[0].message_id.as_deref().unwrap_or_default();
    assert!(id.contains("392889836.11"), "message-id lost: {id:?}");
}

#[async_std::test]
async fn parses_a_latin1_filename_in_bodystructure() {
    // Raw 0xE9 in a BODYSTRUCTURE param — not UTF-8, and not something a
    // quoted-string is allowed to hold either. Mojibake beats no mailbox.
    let mut reply: Vec<u8> = Vec::new();
    reply.extend_from_slice(
        b"* 1 FETCH (UID 1 FLAGS () \
          ENVELOPE (\"Thu, 01 Jan 2026 12:00:00 +0000\" \"Resume\" \
          ((\"Ana\" NIL \"ana\" \"example.com\")) ((\"Ana\" NIL \"ana\" \"example.com\")) \
          ((\"Ana\" NIL \"ana\" \"example.com\")) ((\"You\" NIL \"user\" \"example.com\")) NIL NIL NIL \
          \"<latin1@example.com>\") \
          INTERNALDATE \"01-Jan-2026 12:00:00 +0000\" RFC822.SIZE 200 \
          BODYSTRUCTURE (\"APPLICATION\" \"PDF\" (\"NAME\" \"R\xe9sum\xe9.pdf\") NIL NIL \"BASE64\" 100 \
          NIL (\"attachment\" (\"FILENAME\" \"R\xe9sum\xe9.pdf\")) NIL NIL))\r\n",
    );
    reply.extend_from_slice(b"{tag} OK FETCH completed\r\n");

    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("FETCH"), Action::RespondRawBytes(reply)),
    );
    let mut sess = session(&server).await;

    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[])
        .await
        .expect("one non-UTF-8 byte in a filename must not fail the page");
    assert_eq!(emails.len(), 1);
    assert!(emails[0].has_attachments, "the PDF is still an attachment");
}

// ── Naming and skipping a poisoned message ─────────────────────────────────

/// The header fetch is the one the poison rides on; the `(UID)` pass the skip
/// path makes must stay clean, which is what `Trigger::with` scopes here.
fn poisoned_inbox(uid: u32) -> Scenario {
    Scenario::new()
        .mailbox(synthetic_mailbox("INBOX", 3))
        .fault(
            Trigger::with("FETCH", "BODYSTRUCTURE"),
            Action::PoisonFetchUid(uid),
        )
}

#[async_std::test]
async fn a_poisoned_item_names_its_seq_and_uid() {
    let server = MockImap::start(poisoned_inbox(2));
    let mut sess = session(&server).await;

    let err = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[])
        .await
        .expect_err("a page missing items it never saw is not a page");

    assert!(err.contains("unparseable"), "unhelpful error: {err}");
    assert!(err.contains("page incomplete"), "unhelpful error: {err}");
    assert!(err.contains("[poison seq=2 uid=2]"), "the error must name the message: {err}");
    assert_eq!(poison_in(&err), Some(Poison { seq: 2, uid: Some(2) }));
    assert!(
        err.len() < 600,
        "the decoder's dump of the whole buffer must not reach the log ({} bytes)",
        err.len()
    );
}

#[async_std::test]
async fn a_skip_list_fetches_the_page_around_the_poison() {
    let server = MockImap::start(poisoned_inbox(2));

    let mut sess = session(&server).await;
    let (page, total, _more, skipped) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[2])
        .await
        .expect("the other two messages are perfectly readable");
    assert_eq!(total, 3, "the mailbox still holds three");
    let mut uids: Vec<u32> = page.iter().map(|e| e.uid).collect();
    uids.sort_unstable();
    assert_eq!(uids, vec![1, 3]);
    assert!(skipped.contains(&Some(2)), "the caller must learn what was left out: {skipped:?}");

    let mut sess = session(&server).await;
    let (rows, total, skipped) = fetch_emails_range(&mut sess, "INBOX", 0, 3, &[2])
        .await
        .expect("same for the virtualized-scroll path");
    assert_eq!(total, 3);
    let mut uids: Vec<u32> = rows.iter().map(|e| e.uid).collect();
    uids.sort_unstable();
    assert_eq!(uids, vec![1, 3]);
    assert!(skipped.contains(&Some(2)), "{skipped:?}");

    let mut sess = session(&server).await;
    let (rows, _total) = fetch_headers_by_uids(&mut sess, "INBOX", &[1, 2, 3], &[2])
        .await
        .expect("and for the daemon's cold sync / backfill path");
    let mut uids: Vec<u32> = rows.iter().map(|e| e.uid).collect();
    uids.sort_unstable();
    assert_eq!(uids, vec![1, 3]);
}

#[async_std::test]
async fn insights_imap_dates_preserve_rfc_date_and_receive_time() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(Message::new(1, eml("dates", "ana@example.test", "body")).with_internal_date("09-Sep-2026 00:30:00 +0000"))));
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "INBOX").await.unwrap();
    let (emails, _, _, _) = fetch_emails_page(&mut sess, "INBOX", 1, 10, &[]).await.unwrap();
    let row = serde_json::to_value(&emails[0]).unwrap();
    assert_eq!(row["date"], "Thu, 01 Jan 2026 12:00:00 +0000");
    assert_eq!(row["messageDate"], "Thu, 01 Jan 2026 12:00:00 +0000");
    assert_eq!(row["sentAt"], "Thu, 01 Jan 2026 12:00:00 +0000");
    assert_eq!(row["receivedAt"], "2026-09-09T00:30:00+00:00");
    assert_eq!(row["receivedAt"], row["internalDate"]);
}
