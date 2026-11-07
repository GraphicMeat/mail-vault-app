//! BODYSTRUCTURE part listing and single-part fetch (`imap::parts`).

mod common;

use common::session;
use mailvault_core::imap::{fetch_parts, fetch_section, fetch_section_range, parts_of, PartInfo};
use mock_imap::state::Mailbox;
use mock_imap::{Action, MockImap, Scenario, Trigger};

fn bodystructure_of(line: &str) -> imap_proto::BodyStructure<'static> {
    let (_, resp) = imap_proto::parser::parse_response(line.as_bytes()).expect("parses");
    match resp {
        imap_proto::Response::Fetch(_, attrs) => attrs
            .into_iter()
            .find_map(|a| match a {
                imap_proto::AttributeValue::BodyStructure(bs) => Some(bs.into_owned()),
                _ => None,
            })
            .expect("a BODYSTRUCTURE"),
        other => panic!("not a FETCH: {other:?}"),
    }
}

#[test]
fn parts_of_multipart_alternative_with_attachment() {
    let bs = bodystructure_of(
        "* 1 FETCH (UID 7 BODYSTRUCTURE (((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"QUOTED-PRINTABLE\" 120 4 NIL NIL NIL)\
         (\"TEXT\" \"HTML\" (\"CHARSET\" \"iso-8859-1\") NIL NIL \"BASE64\" 900 12 NIL NIL NIL) \"ALTERNATIVE\" (\"BOUNDARY\" \"b2\") NIL NIL)\
         (\"APPLICATION\" \"PDF\" (\"NAME\" \"report.pdf\") \"<pdf1@x>\" NIL \"BASE64\" 5242880 NIL (\"ATTACHMENT\" (\"FILENAME\" \"Report Q3.pdf\")) NIL) \
         \"MIXED\" (\"BOUNDARY\" \"b1\") NIL NIL))\r\n",
    );
    let parts = parts_of(&bs);
    let sections: Vec<&str> = parts.iter().map(|p| p.section.as_str()).collect();
    assert_eq!(sections, ["1.1", "1.2", "2"]);
    assert_eq!(parts[0].mime, "text/plain");
    assert_eq!(parts[0].encoding, "quoted-printable");
    assert_eq!(parts[0].charset.as_deref(), Some("UTF-8"));
    assert_eq!(parts[1].mime, "text/html");
    assert_eq!(parts[1].encoding, "base64");
    assert_eq!(
        parts[2],
        PartInfo {
            section: "2".into(),
            mime: "application/pdf".into(),
            filename: Some("Report Q3.pdf".into()),
            size: 5_242_880,
            encoding: "base64".into(),
            charset: None,
            content_id: Some("pdf1@x".into()),
            disposition: Some("attachment".into()),
        }
    );
}

#[test]
fn a_single_part_message_is_section_1() {
    let bs = bodystructure_of("* 1 FETCH (BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"us-ascii\") NIL NIL \"7BIT\" 12 1 NIL NIL NIL))\r\n");
    let parts = parts_of(&bs);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].section, "1");
    assert_eq!(parts[0].filename, None);
}

const CRAFTED: &str = "From: Ana <ana@example.com>\r\n\
To: user@example.com\r\n\
Subject: Encoded parts\r\n\
Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
Message-ID: <parts@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/alternative; boundary=\"alt\"\r\n\
\r\n\
--alt\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
Gr=C3=BC=C3=9Fe aus =\r\n\
Vilnius\r\n\
--alt\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
PHA+R3LDvMOfZTwvcD4=\r\n\
--alt--\r\n";

#[async_std::test]
async fn fetch_section_decodes_base64_and_qp() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)));
    let mut sess = session(&server).await;

    let (parts, validity) = fetch_parts(&mut sess, "INBOX", 1).await.unwrap();
    assert!(validity.is_some());
    let parts = parts.expect("uid 1 is there");
    let sections: Vec<&str> = parts.iter().map(|p| p.section.as_str()).collect();
    assert_eq!(sections, ["1", "2"]);

    let text = fetch_section(&mut sess, "INBOX", 1, "1").await.unwrap().expect("text part");
    assert_eq!(String::from_utf8(text).unwrap().trim_end(), "Grüße aus Vilnius");
    let html = fetch_section(&mut sess, "INBOX", 1, "2").await.unwrap().expect("html part");
    assert_eq!(String::from_utf8(html).unwrap(), "<p>Grüße</p>");

    let fetches: Vec<String> = server.commands().into_iter().filter(|c| c.to_ascii_uppercase().contains("FETCH")).collect();
    assert!(fetches.iter().any(|c| c.contains("BODY.PEEK[1]")), "{fetches:?}");
    assert!(fetches.iter().any(|c| c.contains("BODY.PEEK[2]")), "{fetches:?}");
    assert!(!fetches.iter().any(|c| c.contains("BODY.PEEK[]") || c.contains("BODY[]")), "{fetches:?}");
}

#[async_std::test]
async fn a_gone_uid_is_none() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)));
    let mut sess = session(&server).await;
    let (parts, _) = fetch_parts(&mut sess, "INBOX", 99).await.unwrap();
    assert_eq!(parts, None);
    assert_eq!(fetch_section(&mut sess, "INBOX", 99, "1").await.unwrap(), None);
    assert!(fetch_section(&mut sess, "INBOX", 1, "HEADER").await.is_err());
}

/// Another client marks the message read while we fetch: the server slips an unsolicited
/// `FETCH (UID 1 FLAGS (\Seen))` in front of the data. The data reply is the one read.
#[async_std::test]
async fn an_unsolicited_flags_fetch_does_not_stand_in_for_the_data() {
    let flags = || Action::InjectUntagged("* 1 FETCH (UID 1 FLAGS (\\Seen))".into());
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(CRAFTED))
            .fault(Trigger::with("FETCH", "(UID BODYSTRUCTURE)"), flags())
            .fault(Trigger::with("FETCH", "BODY.PEEK[2]"), flags()),
    );
    let mut sess = session(&server).await;
    let (parts, _) = fetch_parts(&mut sess, "INBOX", 1).await.unwrap();
    assert_eq!(parts.expect("uid 1 is there").len(), 2);
    let html = fetch_section(&mut sess, "INBOX", 1, "2").await.unwrap().expect("html part");
    assert_eq!(String::from_utf8(html).unwrap(), "<p>Grüße</p>");
}

/// A reply that carries the part but no BODYSTRUCTURE leaves its encoding unknown: an error,
/// never the raw base64 handed back as if it were the text.
#[async_std::test]
async fn an_unknown_encoding_is_an_error() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)).fault(
            Trigger::with("FETCH", "BODY.PEEK[2]"),
            Action::RespondRaw("* 1 FETCH (UID 1 BODY[2] {20}\r\nPHA+R3LDvMOfZTwvcD4=)\r\n{tag} OK FETCH completed\r\n".into()),
        ),
    );
    let mut sess = session(&server).await;
    let err = fetch_section(&mut sess, "INBOX", 1, "2").await.unwrap_err();
    assert!(err.contains("BODYSTRUCTURE"), "{err}");
}

/// CRAFTED's BODYSTRUCTURE, for replies written by hand.
const CRAFTED_BS: &str = "((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 0 0 NIL NIL NIL)\
    (\"TEXT\" \"HTML\" (\"CHARSET\" \"utf-8\") NIL NIL \"BASE64\" 0 0 NIL NIL NIL) \"ALTERNATIVE\" (\"BOUNDARY\" \"alt\") NIL NIL)";

async fn section_with_reply(raw: String) -> Result<Option<Vec<u8>>, String> {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(CRAFTED))
            .fault(Trigger::with("FETCH", "BODY.PEEK[2]"), Action::RespondRaw(raw)),
    );
    let mut sess = session(&server).await;
    fetch_section(&mut sess, "INBOX", 1, "2").await
}

/// An empty part may come as `""` or as NIL: both are no bytes, not an error.
#[async_std::test]
async fn an_empty_part_is_no_bytes() {
    for item in ["\"\"", "NIL"] {
        let got = section_with_reply(format!("* 1 FETCH (UID 1 BODYSTRUCTURE {CRAFTED_BS} BODY[2] {item})\r\n{{tag}} OK FETCH completed\r\n")).await;
        assert_eq!(got, Ok(Some(Vec::new())), "BODY[2] {item}");
    }
}

/// The BODYSTRUCTURE and the section may arrive on two FETCH lines for the uid.
#[async_std::test]
async fn items_split_over_two_fetch_lines_are_joined() {
    let got = section_with_reply(format!(
        "* 1 FETCH (UID 1 BODYSTRUCTURE {CRAFTED_BS})\r\n* 1 FETCH (UID 1 BODY[2] {{20}}\r\nPHA+R3LDvMOfZTwvcD4=)\r\n{{tag}} OK FETCH completed\r\n"
    ))
    .await;
    assert_eq!(got.unwrap().map(String::from_utf8).unwrap().unwrap(), "<p>Grüße</p>");
}

/// A reply with no BODY[section] item at all is an error, not an empty part.
#[async_std::test]
async fn a_reply_without_the_section_item_is_an_error() {
    let got = section_with_reply(format!("* 1 FETCH (UID 1 BODYSTRUCTURE {CRAFTED_BS})\r\n{{tag}} OK FETCH completed\r\n")).await;
    assert!(got.unwrap_err().contains("no BODY[2]"));
}

/// A gone uid stays gone when an unsolicited FLAGS FETCH for it slips into the reply.
#[async_std::test]
async fn a_gone_uid_with_a_flags_fetch_is_none() {
    let flags = || Action::InjectUntagged("* 1 FETCH (UID 99 FLAGS ())".into());
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(CRAFTED))
            .fault(Trigger::with("FETCH", "(UID BODYSTRUCTURE)"), flags())
            .fault(Trigger::with("FETCH", "BODY.PEEK[1]"), flags()),
    );
    let mut sess = session(&server).await;
    assert_eq!(fetch_parts(&mut sess, "INBOX", 99).await.unwrap().0, None);
    assert_eq!(fetch_section(&mut sess, "INBOX", 99, "1").await.unwrap(), None);
}

/// A partial fetch hands back exactly the asked slice of the part, still transfer-encoded; the
/// last slice is short, a slice past the end is empty, and a gone uid is `None`.
#[async_std::test]
async fn range_fetch_returns_the_slice() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)));
    let mut sess = session(&server).await;
    // Part 2's encoded body is `PHA+R3LDvMOfZTwvcD4=` plus the CRLF before the boundary.
    let got = fetch_section_range(&mut sess, "INBOX", 1, "2", 4, 8).await.unwrap().expect("uid 1 is there");
    assert_eq!(got, b"R3LDvMOf");
    let tail = fetch_section_range(&mut sess, "INBOX", 1, "2", 16, 8).await.unwrap().unwrap();
    assert!(tail.starts_with(b"cD4=") && tail.len() < 8, "{:?}", String::from_utf8_lossy(&tail));
    assert_eq!(fetch_section_range(&mut sess, "INBOX", 1, "2", 4096, 8).await.unwrap(), Some(Vec::new()));
    assert_eq!(fetch_section_range(&mut sess, "INBOX", 99, "2", 0, 8).await.unwrap(), None);
    assert!(fetch_section_range(&mut sess, "INBOX", 1, "2 BODY[]", 0, 8).await.is_err());

    // Slices joined end to end are the whole encoded part.
    let mut joined = Vec::new();
    let mut offset = 0u64;
    loop {
        let s = fetch_section_range(&mut sess, "INBOX", 1, "2", offset, 3).await.unwrap().unwrap();
        joined.extend_from_slice(&s);
        offset += s.len() as u64;
        if s.len() < 3 {
            break;
        }
    }
    assert_eq!(mailvault_core::imap::parts::decode_transfer(&joined, "base64"), "<p>Grüße</p>".as_bytes());

    let fetches: Vec<String> = server.commands().into_iter().filter(|c| c.to_ascii_uppercase().contains("FETCH")).collect();
    assert!(fetches.iter().any(|c| c.contains("BODY.PEEK[2]<4.8>")), "{fetches:?}");
    assert!(!fetches.iter().any(|c| c.contains("BODY[") || c.contains("BODY.PEEK[]")), "{fetches:?}");
}

/// A reply labelled with another origin than the one asked for is an error, never data placed
/// at the wrong offset.
#[async_std::test]
async fn range_fetch_refuses_another_origin() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)).fault(
            Trigger::with("FETCH", "BODY.PEEK[2]<8.4>"),
            Action::RespondRaw("* 1 FETCH (UID 1 BODY[2]<0> {4}\r\nPHA+)\r\n{tag} OK FETCH completed\r\n".into()),
        ),
    );
    let mut sess = session(&server).await;
    let err = fetch_section_range(&mut sess, "INBOX", 1, "2", 8, 4).await.unwrap_err();
    assert!(err.contains("<0>"), "{err}");
}

/// A server that ignores the range answers `BODY[2]` with no origin and the whole part: refused
/// at every offset, never sliced or handed back whole.
#[async_std::test]
async fn range_fetch_refuses_a_reply_without_origin() {
    for (offset, needle) in [(0u64, "BODY.PEEK[2]<0.4>"), (8, "BODY.PEEK[2]<8.4>")] {
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)).fault(
            Trigger::with("FETCH", needle),
            Action::RespondRaw("* 1 FETCH (UID 1 BODY[2] {20}\r\nPHA+R3LDvMOfZTwvcD4=)\r\n{tag} OK FETCH completed\r\n".into()),
        ));
        let mut sess = session(&server).await;
        let err = fetch_section_range(&mut sess, "INBOX", 1, "2", offset, 4).await.unwrap_err();
        assert!(err.contains("origin"), "offset {offset}: {err}");
    }
}

/// Past the end, a server may answer NIL or `""` and drop the origin: that is the end (no bytes),
/// not an error.
#[async_std::test]
async fn range_fetch_past_the_end_without_origin_is_empty() {
    for item in ["NIL", "\"\""] {
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push(CRAFTED)).fault(
            Trigger::with("FETCH", "BODY.PEEK[2]<4096.4>"),
            Action::RespondRaw(format!("* 1 FETCH (UID 1 BODY[2] {item})\r\n{{tag}} OK FETCH completed\r\n")),
        ));
        let mut sess = session(&server).await;
        assert_eq!(fetch_section_range(&mut sess, "INBOX", 1, "2", 4096, 4).await.unwrap(), Some(Vec::new()), "{item}");
    }
}
