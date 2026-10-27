use mailvault_core::{
    drafts::{self, Save},
    imap::ImapConfig,
    smtp, vault_eml,
};
use serde_json::{json, Value};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/local-draft-cases.json")).unwrap()
}
fn case(name: &str) -> Value {
    corpus()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
        .clone()
}
fn request(name: &str) -> Value {
    let c = case(name);
    json!({"draftId":"parity","revision":1,"accountId":"one","fromAddress":c["input"]["fromAddress"],"displayName":c["input"]["displayName"],"snapshot":c["input"]["payload"],"snippet":c["input"]["snippet"]})
}
#[test]
fn drafts_rows_and_mailbox_resolution_match_frozen_js() {
    for name in ["complete-alias-threaded-attachment", "no-recipients"] {
        let c = case(name);
        let r = Save::parse(request(name)).unwrap();
        assert_eq!(
            r.row(42, "<fixed@example.test>", "2026-10-25T00:00:00.000Z"),
            c["output"]["entry"]
        );
    }
    for name in [
        "active-nested-role-before-name",
        "cached-role",
        "case-insensitive-name",
        "literal-fallback",
    ] {
        let c = case(name);
        let boxes = c["input"]
            .get("list")
            .or(c["input"].get("cached"))
            .cloned()
            .unwrap_or(json!([]));
        assert_eq!(json!(drafts::drafts_mailbox(&boxes)), c["output"]);
    }
}
#[test]
fn drafts_complete_fields_clearing_and_bytes_are_content() {
    let empty = request("no-recipients");
    assert!(Save::parse(empty.clone()).is_ok());
    for key in [
        "to",
        "cc",
        "bcc",
        "subject",
        "html",
        "text",
        "inReplyTo",
        "references",
        "attachments",
    ] {
        let mut v = empty.clone();
        v["snapshot"].as_object_mut().unwrap().remove(key);
        assert!(Save::parse(v).unwrap_err().contains(key));
    }
    let mut v = request("complete-alias-threaded-attachment");
    let a = Save::parse(v.clone()).unwrap();
    v["snapshot"]["attachments"][0]["content"] = json!("AwIB");
    let b = Save::parse(v).unwrap();
    assert_ne!(a.content_hash(), b.content_hash());
    let mut v = empty;
    v["snapshot"]["attachments"] =
        json!([{"filename":"empty","contentType":"application/octet-stream","content":""}]);
    assert!(Save::parse(v).is_ok());
}
#[test]
fn drafts_mime_roundtrip_retains_envelope_threading_and_bytes() {
    let r = Save::parse(request("complete-alias-threaded-attachment")).unwrap();
    let account:ImapConfig=serde_json::from_value(json!({"email":"one@example.test","imapHost":"offline.invalid","name":"Alias","fromEmail":"alias@example.test"})).unwrap();
    let outgoing = r.outgoing().unwrap();
    let shared = smtp::build_draft_mime(&account, &outgoing)
        .unwrap()
        .raw_rfc2822;
    assert!(
        vault_eml::parse_eml_bytes(&shared, 42, vec![])
            .unwrap()
            .bcc
            .is_empty(),
        "scheduled/shared builder remains Bcc-free"
    );
    let raw = smtp::build_local_draft_mime(&account, &outgoing).unwrap();
    let parsed = vault_eml::parse_eml_bytes(&raw, 42, vec![]).unwrap();
    let mime = mailparse::parse_mail(&raw).unwrap();
    use mailparse::MailHeaderMap;
    let header = mime.headers.get_first_header("To").unwrap();
    let to = header.get_value();
    let original = case("complete-alias-threaded-attachment")["input"]["payload"].clone();
    let direct: smtp::OutgoingEmail = serde_json::from_value(original).unwrap();
    assert_eq!(r.snapshot.to, r.outgoing().unwrap().to);
    assert_eq!(r.snapshot.to, direct.to);
    let direct_raw = smtp::build_draft_mime(&account, &direct)
        .unwrap()
        .raw_rfc2822;
    let direct_mail = mailparse::parse_mail(&direct_raw).unwrap();
    println!(
        "ROW12_FIXED_DIRECT_TO raw={:?} decoded={:?}",
        direct_mail
            .headers
            .get_first_header("To")
            .unwrap()
            .get_value_raw(),
        direct_mail.headers.get_first_value("To")
    );
    println!(
        "ROW12_FIXED_HEADER raw={:?} header_aware={:?}",
        header.get_value_raw(),
        mailparse::addrparse_header(header)
    );
    println!(
        "ROW12_FIXED_RECIPIENT_DIAGNOSTIC outgoing={} to_header={:?} addrparse={:?} parsed={:?}",
        r.snapshot.to,
        to,
        mailparse::addrparse(&to),
        parsed.to
    );

    assert_eq!(parsed.from.address, "alias@example.test");
    assert_eq!(
        parsed
            .to
            .iter()
            .map(|a| a.address.as_str())
            .collect::<Vec<_>>(),
        vec!["jane@example.test", "next@example.test"]
    );
    assert_eq!(parsed.cc[0].address, "copy@example.test");
    assert_eq!(
        parsed
            .bcc
            .iter()
            .map(|a| a.address.as_str())
            .collect::<Vec<_>>(),
        vec!["blind@example.test"]
    );
    assert!(parsed.html.unwrap().contains("Words"));
    assert_eq!(parsed.attachments[0].content, "AAEC");
    let headers = String::from_utf8_lossy(&raw);
    assert!(headers.contains("In-Reply-To: <parent@example.test>"));
    assert!(headers.contains("<root@example.test>"));
}
#[test]
fn local_editable_draft_attachments_preserve_empty_tiny_trailing_crlf_and_cid_bytes() {
    let account: ImapConfig =
        serde_json::from_value(json!({"email":"one@example.test","imapHost":"offline.invalid"}))
            .unwrap();
    for (content, cid) in [
        ("", None),
        ("AAEC", None),
        ("QQ0K", None),
        ("AAEC", Some("logo")),
    ] {
        let mut value = request("no-recipients");
        value["snapshot"]["html"] = json!("<p><img src=\"cid:logo\"></p>");
        value["snapshot"]["attachments"] =
            json!([{"filename":"bytes.png","contentType":"image/png","content":content,"cid":cid}]);
        let request = Save::parse(value).unwrap();
        let raw = smtp::build_local_draft_mime(&account, &request.outgoing().unwrap()).unwrap();
        let parsed = vault_eml::parse_eml_bytes(&raw, 1, vec![]).unwrap();
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].content, content);
        assert_eq!(
            mailvault_core::vault_files::attachments_of(&raw, &[0]).unwrap(),
            vec![Some(content.into())]
        );
        if cid.is_some() {
            assert_eq!(parsed.attachments[0].content_id.as_deref(), Some("<logo>"));
        }
    }
}

#[test]
fn editable_draft_purpose_requires_provenance_and_archived_draft_not_seen_state() {
    assert!(drafts::editable(
        &json!({"source":"local_draft","flags":["archived","draft"]})
    ));
    assert!(!drafts::editable(
        &json!({"source":"local_draft","flags":["seen","draft"]})
    ));
    for source in ["local_sent", "server"] {
        assert!(!drafts::editable(
            &json!({"source":source,"flags":["archived","seen","draft"]})
        ));
    }
}

fn account() -> ImapConfig {
    serde_json::from_value(json!({"email":"one@example.test","imapHost":"offline.invalid"})).unwrap()
}
fn outgoing(to: &str, cc: &str, bcc: &str) -> smtp::OutgoingEmail {
    let mut value = request("no-recipients");
    value["snapshot"]["to"] = json!(to);
    value["snapshot"]["cc"] = json!(cc);
    value["snapshot"]["bcc"] = json!(bcc);
    value["snapshot"]["text"] = json!("body");
    Save::parse(value).unwrap().outgoing().unwrap()
}

/// Bytes the local draft save writes for this recipient text, the plain parse
/// of them, and the `eml` the draft is reopened from (`drafts::reopened_eml`,
/// which both `drafts.list` paths return).
fn reopened(to: &str, cc: &str, bcc: &str) -> (Vec<u8>, vault_eml::ParsedEmail, Value) {
    let raw = smtp::build_local_draft_mime(&account(), &outgoing(to, cc, bcc))
        .unwrap_or_else(|e| panic!("local draft save must not fail on recipient text {to:?} / {cc:?} / {bcc:?}: {e}"));
    let parsed = vault_eml::parse_eml_bytes(&raw, 1, vec![]).unwrap();
    let eml = drafts::reopened_eml(&raw, 1).unwrap();
    (raw, parsed, eml)
}
/// The text Compose shows for a field when the draft carries its typed text
/// (`_recipientText` in localDrafts.js prefers it over the parsed list).
fn typed<'a>(eml: &'a Value, field: &str) -> Option<&'a str> {
    eml["draftRecipients"][field].as_str()
}

#[test]
fn a_half_typed_recipient_is_saved_and_reopens_exactly_as_typed() {
    for text in ["prime", "prime@", "prime@gr.", "a@x.com, prime@", "a@x.com, prime@gr., b@y.org"] {
        let (_, _, eml) = reopened(text, "", "");
        assert_eq!(typed(&eml, "to"), Some(text), "To {text:?} reopens as typed");
    }
    let (_, _, eml) = reopened("a@x.com, prime@", "c@x.com, bad", "hidden@x.com, prime@gr.");
    assert_eq!(typed(&eml, "to"), Some("a@x.com, prime@"));
    assert_eq!(typed(&eml, "cc"), Some("c@x.com, bad"));
    assert_eq!(typed(&eml, "bcc"), Some("hidden@x.com, prime@gr."));
    // A trailing comma is kept: parsing the Cc header alone would drop it.
    let (_, parsed, eml) = reopened("a@x.com, prime@", "bad,", "");
    assert_eq!(typed(&eml, "cc"), Some("bad,"));
    assert_eq!(parsed.cc.len(), 1, "the parse alone still drops it");
}

#[test]
fn a_field_left_empty_writes_no_typed_header() {
    let (raw, _, eml) = reopened("a@x.com", "", "  ");
    assert_eq!(typed(&eml, "to"), Some("a@x.com"));
    assert!(typed(&eml, "cc").is_none() && typed(&eml, "bcc").is_none());
    let text = String::from_utf8_lossy(&raw).to_lowercase();
    assert!(text.contains("x-mailvault-draft-to:"));
    assert!(!text.contains("x-mailvault-draft-cc:") && !text.contains("x-mailvault-draft-bcc:"));
    let (_, _, eml) = reopened("", "", "");
    assert!(eml.get("draftRecipients").is_none(), "no recipients: nothing typed to give back");
}

#[test]
fn a_valid_non_ascii_display_name_next_to_a_half_typed_one_survives_reopening() {
    let to = "Jos\u{e9} M\u{fc}ller <jose@x.com>, prime@";
    let cc = "\"Doe, Zo\u{eb}\" <zoe@x.com>, bad@";
    let (raw, parsed, eml) = reopened(to, cc, "");
    assert_eq!(parsed.to[0].name.as_deref(), Some("Jos\u{e9} M\u{fc}ller"));
    assert_eq!(parsed.to[0].address, "jose@x.com");
    assert_eq!(parsed.to[1].address, "prime@");
    assert_eq!(parsed.cc[0].name.as_deref(), Some("Doe, Zo\u{eb}"));
    assert_eq!(parsed.cc[0].address, "zoe@x.com");
    assert_eq!(parsed.cc[1].address, "bad@");
    assert_eq!(typed(&eml, "to"), Some(to));
    assert_eq!(typed(&eml, "cc"), Some(cc));
    // The names travel as RFC 2047 encoded words: the header block stays ASCII.
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    assert!(raw[..end].is_ascii(), "{}", String::from_utf8_lossy(&raw[..end]));
}

#[test]
fn a_non_ascii_unparseable_token_is_encoded_and_reopens_exactly_as_typed() {
    let text = "a@x.com, Zo\u{eb} <zoe@x";
    let (raw, _, eml) = reopened(text, "", "");
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    assert!(raw[..end].is_ascii(), "{}", String::from_utf8_lossy(&raw[..end]));
    use mailparse::MailHeaderMap;
    let mail = mailparse::parse_mail(&raw).unwrap();
    assert_eq!(mail.headers.get_first_value("To").as_deref(), Some(text));
    assert_eq!(typed(&eml, "to"), Some(text));
}

#[test]
fn an_entry_without_an_at_sign_beside_a_named_address_still_reopens_exactly_as_typed() {
    // mailparse fails the whole header when one entry has no `@`, so the
    // parsed list is one pseudo-address; the typed text is what comes back.
    let text = "\"Doe, Zo\u{eb}\" <zoe@x.com>, bad";
    for (to, cc, bcc) in [(text, "", ""), ("", text, ""), ("", "", text)] {
        let (_, parsed, eml) = reopened(to, cc, bcc);
        assert_eq!(parsed.to.len() + parsed.cc.len() + parsed.bcc.len(), 1, "the parse alone cannot split it");
        for (field, want) in [("to", to), ("cc", cc), ("bcc", bcc)] {
            assert_eq!(typed(&eml, field), (!want.is_empty()).then_some(want), "{field}");
        }
    }
}

#[test]
fn recipient_text_cannot_inject_a_header_into_a_local_draft() {
    use mailparse::MailHeaderMap;
    let evil = "a@x.com\r\nBcc: evil@x.com\r\nX-Injected: 1";
    let flat = "a@x.com  Bcc: evil@x.com  X-Injected: 1";
    for (to, cc, bcc) in [(evil, "", ""), ("", evil, ""), ("", "", evil)] {
        let (raw, _, eml) = reopened(to, cc, bcc);
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(mail.headers.get_first_value("X-Injected").is_none(), "{to:?} {cc:?} {bcc:?}");
        let bccs = mail.headers.get_all_values("Bcc");
        assert!(bccs.iter().all(|v| !v.contains("evil@x.com") || bcc == evil), "{bccs:?}");
        assert!(bccs.len() <= 1);
        assert_eq!(mail.subparts[0].get_body().unwrap().trim(), "body", "the injected lines did not swallow the body");
        // The typed text comes back with each CR and LF turned into a space.
        for (field, want) in [("to", to), ("cc", cc), ("bcc", bcc)] {
            assert_eq!(typed(&eml, field), (!want.is_empty()).then_some(flat), "{field}");
        }
        let names: Vec<_> = mail.headers.iter().map(|h| h.get_key()).collect();
        assert!(names.iter().all(|n| !n.starts_with("X-Inj")), "{names:?}");
    }
}

#[test]
fn non_ascii_names_and_a_long_list_reopen_exactly_as_typed() {
    let to = (0..30).map(|i| format!("Zo\u{eb} \u{c5}ngstr\u{f6}m {i} <z{i}@example.com>")).collect::<Vec<_>>().join(", ") + ", prime@";
    let cc = "\u{65e5}\u{672c}\u{8a9e} <jp@x.com>, \u{c9}mile";
    let (raw, _, eml) = reopened(&to, cc, "");
    assert_eq!(typed(&eml, "to"), Some(to.as_str()));
    assert_eq!(typed(&eml, "cc"), Some(cc));
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = std::str::from_utf8(&raw[..end]).unwrap();
    assert!(head.is_ascii());
    assert!(head.split("\r\n").all(|l| l.len() <= 78), "{head}");
}

#[test]
fn a_draft_saved_before_the_typed_headers_reopens_from_its_parsed_headers() {
    let old = b"From: me@x.com\r\nTo: a@x.com, b@x.com\r\nCc: c@x.com\r\nSubject: old\r\nContent-Type: text/plain\r\n\r\nbody";
    let eml = drafts::reopened_eml(old, 7).unwrap();
    assert!(eml.get("draftRecipients").is_none());
    let addresses = |field: &str| eml[field].as_array().unwrap().iter().map(|a| a["address"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(addresses("to"), ["a@x.com", "b@x.com"]);
    assert_eq!(addresses("cc"), ["c@x.com"]);
    assert!(addresses("bcc").is_empty());
}

#[test]
fn only_the_local_draft_save_accepts_unparseable_recipients() {
    let outgoing = outgoing("a@x.com, prime@", "", "");
    let account = account();
    // What sends (build_mime), what scheduled sends freeze (build_draft_mime)
    // and the smtp_build_draft_mime RPC keep refusing it.
    assert!(smtp::build_mime(&account, &outgoing).err().expect("build_mime refuses").contains("Invalid to address"));
    assert!(smtp::build_draft_mime(&account, &outgoing).err().expect("build_draft_mime refuses").contains("Invalid to address"));
    assert!(smtp::build_local_draft_mime(&account, &outgoing).is_ok());
}

#[test]
fn the_typed_headers_never_reach_a_sent_or_scheduled_message() {
    let account = account();
    let to = "\"Doe, Zo\u{eb}\" <zoe@x.com>, a@x.com";
    let (local, _, eml) = reopened(to, "c@x.com", "d@x.com");
    let has = |raw: &[u8]| String::from_utf8_lossy(raw).to_lowercase().contains("x-mailvault-draft");
    assert!(has(&local));
    // Reopen, then send what the window holds: the strings, never the headers.
    let sent = outgoing(typed(&eml, "to").unwrap(), typed(&eml, "cc").unwrap(), typed(&eml, "bcc").unwrap());
    assert!(!has(&smtp::build_mime(&account, &sent).unwrap().raw_rfc2822));
    assert!(!has(&smtp::build_draft_mime(&account, &sent).unwrap().raw_rfc2822));
}
