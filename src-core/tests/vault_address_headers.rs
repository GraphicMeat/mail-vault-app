use mailvault_core::vault_eml::{parse_address_str, parse_eml_bytes, parse_eml_bytes_light};
#[test]
fn encoded_comma_header_keeps_address_structure_in_full_and_light_readers() {
    let value = "=?utf-8?b?RG9lLCBKYW5l?= <jane@example.test>, next@example.test";
    for header in ["From", "To", "Cc", "Bcc", "Reply-To"] {
        let raw = format!(
            "{header}: {value}\r\n{header}: ignored@example.test\r\nSubject: address\r\n\r\nbody"
        );
        let full = parse_eml_bytes(raw.as_bytes(), 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(raw.as_bytes(), 1, vec![]).unwrap();
        let (a, b) = match header {
            "From" => (vec![full.from], vec![light.from]),
            "To" => (full.to, light.to),
            "Cc" => (full.cc, light.cc),
            "Bcc" => (full.bcc, light.bcc),
            _ => (full.reply_to, light.reply_to),
        };
        let expected = if header == "From" {
            vec!["jane@example.test"]
        } else {
            vec!["jane@example.test", "next@example.test"]
        };
        assert_eq!(
            a.iter().map(|a| a.address.as_str()).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            b.iter().map(|a| a.address.as_str()).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(a[0].name.as_deref(), Some("Doe, Jane"));
    }
}
#[test]
fn ordinary_unicode_folded_and_group_headers_keep_order() {
    for (value, expected) in [
        (
            "\"Doe, Jane\" <jane@example.test>, next@example.test",
            vec!["jane@example.test", "next@example.test"],
        ),
        (
            "=?utf-8?b?Sm9zw6k=?= <jose@example.test>",
            vec!["jose@example.test"],
        ),
        (
            "first@example.test,\r\n second@example.test",
            vec!["first@example.test", "second@example.test"],
        ),
        (
            "Team: a@example.test, b@example.test;",
            vec!["a@example.test", "b@example.test"],
        ),
    ] {
        let raw = format!("To: {value}\r\n\r\nbody");
        for list in [
            parse_eml_bytes(raw.as_bytes(), 1, vec![]).unwrap().to,
            parse_eml_bytes_light(raw.as_bytes(), 1, vec![]).unwrap().to,
        ] {
            assert_eq!(
                list.iter().map(|a| a.address.as_str()).collect::<Vec<_>>(),
                expected
            );
        }
    }
}
#[test]
fn missing_and_malformed_headers_keep_compatibility_fallback() {
    let empty = parse_eml_bytes(b"Subject: x\r\n\r\nbody", 1, vec![]).unwrap();
    assert!(empty.to.is_empty());
    assert_eq!(empty.from.address, "unknown@unknown.com");
    let bad = "not an address";
    let raw = format!("To: {bad}\r\n\r\nbody");
    let expected = parse_address_str(bad);
    for actual in [
        parse_eml_bytes(raw.as_bytes(), 1, vec![]).unwrap().to,
        parse_eml_bytes_light(raw.as_bytes(), 1, vec![]).unwrap().to,
    ] {
        assert_eq!(actual[0].address, expected[0].address);
    }
}
