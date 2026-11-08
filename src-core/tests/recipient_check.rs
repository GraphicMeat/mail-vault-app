//! Recipient check parity: `compose_prep::recipient_problem` is what both apps
//! ask before a send (desktop through `compose.check`, the mobile engine
//! before it journals and again before each attempt). Every list it accepts
//! must also build (`smtp::build_mime`), so a checked send never fails on its
//! addresses after it was claimed.

use mailvault_core::compose_prep::recipient_problem;
use mailvault_core::imap::ImapConfig;
use mailvault_core::smtp::{self, OutgoingEmail};

fn account() -> ImapConfig {
    serde_json::from_value(serde_json::json!({
        "email": "luke@mock.test",
        "password": "unused",
        "imapHost": "127.0.0.1",
        "imapPort": 1,
        "smtpHost": "127.0.0.1",
        "smtpPort": 1,
    }))
    .expect("ImapConfig")
}

fn builds(to: &str) -> bool {
    let email: OutgoingEmail = serde_json::from_value(serde_json::json!({ "to": to, "subject": "s", "text": "t" })).expect("OutgoingEmail");
    smtp::build_mime(&account(), &email).is_ok()
}

#[test]
fn an_accepted_list_builds() {
    for list in [
        "a@x.test",
        "  a@x.test  ",
        "A <a@x.test>",
        "\"Last, First\" <a@x.test>",
        "a@x.test, b@y.test",
        "a@x.test,",
        "a@x.test, , b@y.test",
        "Ann <ann@x.test>, \"B, C\" <bc@y.example>",
        "first.last+tag@sub.x.test",
    ] {
        assert_eq!(recipient_problem(list, "", ""), None, "{list}");
        assert!(builds(list), "core accepts {list:?}, so it must build");
        assert_eq!(recipient_problem("a@x.test", list, list), None, "{list} as Cc and Bcc");
    }
}

#[test]
fn problems_name_their_catalog_key() {
    let none: (&str, Option<String>) = ("compose.pleaseEnterLeastOneRecipient", None);
    assert_eq!(recipient_problem("", "", ""), Some(none.clone()));
    assert_eq!(recipient_problem("   ", "a@x.test", ""), Some(none), "a Cc alone is not enough");
    for (to, cc, bcc, bad) in [
        ("not an address", "", "", "not an address"),
        ("a@localhost", "", "", "a@localhost"),
        ("a@x.test", "nobody", "", "nobody"),
        ("a@x.test", "", "b@", "b@"),
        ("a@x.test, two@@x.test", "", "", "two@@x.test"),
    ] {
        assert_eq!(recipient_problem(to, cc, bcc), Some(("compose.invalidRecipient", Some(bad.to_string()))), "{to} | {cc} | {bcc}");
    }
}
