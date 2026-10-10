//! `JmapClient::import_raw` and its helpers (Task 9b) against the mock JMAP
//! server: the Message-ID dedupe before an import (exact, never a
//! substring), a repaired import, a server-side dedupe, paging every id of a
//! mailbox, the import date, and the keywords a flag list may carry.
//!
//! Fixture (`common_jmap::scenario`): Inbox (e1, e2), Work, Work/Sub (e3),
//! Trash; e1 is also in Work.

mod common_jmap;

use mailvault_core::jmap::client::received_at_of;
use mailvault_core::jmap::headers::flags_to_keywords;
use mailvault_core::jmap::{ImportResult, JmapAuth, JmapClient};
use mock_jmap::{Fault, MockJmap};
use std::collections::BTreeSet;

/// Dated 2019-03-05T08:15:00Z.
const NEW: &str = "Message-ID: <new@x>\r\nSubject: new\r\nDate: Tue, 05 Mar 2019 09:15:00 +0100\r\n\r\nnew body\r\n";

async fn client(m: &MockJmap) -> JmapClient {
    let auth = JmapAuth::Basic { username: "alice@example.test".into(), password: "pw".into() };
    JmapClient::connect(&m.session_url(), auth, "alice@example.test").await.expect("connect")
}

fn set(keywords: &[&str]) -> BTreeSet<String> {
    keywords.iter().map(|k| k.to_string()).collect()
}

fn uploads(m: &MockJmap) -> usize {
    m.requests().iter().filter(|r| r.path.starts_with("/jmap/upload")).count()
}

#[tokio::test]
async fn jmap_import_raw_creates_the_email_with_its_keywords_and_date() {
    let m = MockJmap::start(common_jmap::scenario());
    let c = client(&m).await;
    let keywords = vec!["$seen".to_string(), "$flagged".to_string()];

    let got = c.import_raw(NEW.as_bytes(), "mb-work", &keywords, Some("2019-03-05T08:15:00Z")).await.unwrap();

    let ImportResult::Created(imported) = got else { panic!("expected a new email, got {got:?}") };
    let email = m.read(|s| s.email("acc1", &imported.id).cloned()).expect("on the server");
    assert_eq!(email.mailbox_ids, set(&["mb-work"]));
    assert_eq!(email.keywords, set(&["$flagged", "$seen"]));
    assert_eq!(email.received_at, "2019-03-05T08:15:00Z");
    assert_eq!(m.read(|s| s.blobs.get(&email.blob_id).cloned()).unwrap(), NEW.as_bytes());
    assert_eq!((m.count_calls("Email/query"), uploads(&m), m.count_calls("Email/import")), (1, 1, 1));
}

#[tokio::test]
async fn jmap_import_raw_skips_a_message_id_the_mailbox_already_holds() {
    let m = MockJmap::start(common_jmap::scenario());
    let c = client(&m).await;

    let got = c.import_raw(common_jmap::E1_RAW.as_bytes(), "mb-inbox", &[], None).await.unwrap();

    assert_eq!(got, ImportResult::AlreadyExists { existing_id: "e1".into() });
    assert_eq!((uploads(&m), m.count_calls("Email/import")), (0, 0), "nothing sent");
}

#[tokio::test]
async fn jmap_import_raw_ignores_a_lookalike_message_id() {
    let mut scenario = common_jmap::scenario();
    // "<pre-new@x>" contains "new@x": the header filter's substring hit must
    // not stand in for "<new@x>".
    scenario.accounts[0].mailboxes[0]
        .emails
        .push(common_jmap::email("pre-new", "lookalike", "2026-10-04T10:00:00Z"));
    let m = MockJmap::start(scenario);
    let c = client(&m).await;

    let got = c.import_raw(NEW.as_bytes(), "mb-inbox", &[], None).await.unwrap();

    assert!(matches!(got, ImportResult::Created(_)), "{got:?}");
    assert_eq!(m.count_calls("Email/import"), 1);
}

#[tokio::test]
async fn jmap_import_raw_counts_a_repaired_import_as_created_and_finds_it_next_time() {
    let mut scenario = common_jmap::scenario();
    scenario.faults.push(Fault::ImportRepairs);
    let m = MockJmap::start(scenario);
    let c = client(&m).await;

    let first = c.import_raw(NEW.as_bytes(), "mb-inbox", &[], None).await.unwrap();
    let ImportResult::Created(imported) = first else { panic!("a repaired import is an import, got {first:?}") };
    assert_ne!(imported.size, NEW.len() as u64, "the server stored other bytes");

    let second = c.import_raw(NEW.as_bytes(), "mb-inbox", &[], None).await.unwrap();

    assert_eq!(second, ImportResult::AlreadyExists { existing_id: imported.id });
    assert_eq!(m.count_calls("Email/import"), 1, "found by Message-ID, never imported twice");
}

#[tokio::test]
async fn jmap_import_raw_reports_a_server_dedupe_as_already_exists() {
    let mut scenario = common_jmap::scenario();
    scenario.faults.push(Fault::ImportAlreadyExists);
    let m = MockJmap::start(scenario);
    let c = client(&m).await;

    // e1 is in Inbox and Work, not in Work/Sub: the lookup there misses and
    // the server's own dedupe answers.
    let got = c.import_raw(common_jmap::E1_RAW.as_bytes(), "mb-sub", &[], None).await.unwrap();

    assert_eq!(got, ImportResult::AlreadyExists { existing_id: "e1".into() });
    assert_eq!(m.count_calls("Email/import"), 1);
}

#[tokio::test]
async fn jmap_all_email_ids_pages_past_a_server_cap() {
    let mut scenario = common_jmap::scenario();
    scenario.limits.max_query_limit = 2;
    for n in 4..=9 {
        scenario.accounts[0].mailboxes[0]
            .emails
            .push(common_jmap::email(&format!("e{n}"), "more", &format!("2026-10-0{n}T10:00:00Z")));
    }
    let m = MockJmap::start(scenario);
    let c = client(&m).await;

    let ids = c.all_email_ids("mb-inbox").await.unwrap();

    assert_eq!(ids, ["e9", "e8", "e7", "e6", "e5", "e4", "e2", "e1"], "every id once, newest first");
}

#[test]
fn jmap_received_at_is_a_utc_date_with_a_z() {
    assert_eq!(received_at_of(NEW.as_bytes()).as_deref(), Some("2019-03-05T08:15:00Z"));
    assert_eq!(received_at_of(b"Subject: undated\r\n\r\nbody"), None);
}

#[test]
fn jmap_flags_to_keywords_drop_what_a_keyword_cannot_carry() {
    let flags = ["\\Seen", "\\Flagged", "\\Deleted", "\\Recent", "$Forwarded", "bad word", "\\seen"];
    assert_eq!(flags_to_keywords(flags), ["$seen", "$flagged", "$Forwarded"]);
}
