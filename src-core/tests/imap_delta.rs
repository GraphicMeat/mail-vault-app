//! Delta sync: CONDSTORE, flag drift, UIDVALIDITY, and expunge detection.

mod common;

use common::{eml, session};
use mailvault_core::imap::*;
use mock_imap::state::{synthetic_mailbox, Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};

fn mailbox_with_modseqs() -> Mailbox {
    let mut mb = Mailbox::new("INBOX");
    for (uid, modseq) in [(1u32, 10u64), (2, 20), (3, 30), (4, 40)] {
        mb.add(
            Message::new(uid, eml(&format!("Msg {uid}"), "a@example.com", "body"))
                .with_modseq(modseq),
        );
    }
    mb.highest_modseq = 40;
    mb
}

#[async_std::test]
async fn condstore_select_reports_highestmodseq() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox_with_modseqs()));
    let mut sess = session(&server).await;

    let (exists, validity, uid_next, modseq) = check_mailbox_status(&mut sess, "INBOX", true)
        .await
        .expect("status");

    assert_eq!(exists, 4);
    assert_eq!(validity, Some(1));
    assert_eq!(uid_next, Some(5));
    assert_eq!(modseq, Some(40), "CONDSTORE SELECT must surface HIGHESTMODSEQ");
}

#[async_std::test]
async fn status_without_condstore_reports_no_modseq() {
    let server = MockImap::start(
        Scenario::new().without_cap("CONDSTORE").mailbox(mailbox_with_modseqs()),
    );
    let mut sess = session(&server).await;

    let (_, _, _, modseq) = check_mailbox_status(&mut sess, "INBOX", false).await.unwrap();
    assert_eq!(modseq, None);
}

#[async_std::test]
async fn changedsince_returns_only_the_newly_changed_uids() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox_with_modseqs()));
    let mut sess = session(&server).await;

    let changed = fetch_changed_flags(&mut sess, "INBOX", 20).await.expect("changed");
    let uids: Vec<u32> = changed.iter().map(|(u, _)| *u).collect();
    assert_eq!(uids, vec![3, 4], "MODSEQ <= since must be filtered out");
}

/// CONDSTORE reports *flag* changes. It never reports vanished UIDs, so a delta
/// sync that trusts it alone silently keeps deleted mail forever. Detection has
/// to come from enumerating UIDs, not from CHANGEDSINCE.
#[async_std::test]
async fn changedsince_alone_cannot_detect_server_side_deletions() {
    let mut mb = mailbox_with_modseqs();
    mb.messages.retain(|m| m.uid != 2); // deleted on the server
    mb.highest_modseq = 50;

    let server = MockImap::start(
        Scenario::new()
            .mailbox(mb)
            .fault(Trigger::on("FETCH"), Action::OmitExpunged),
    );
    let mut sess = session(&server).await;

    let changed = fetch_changed_flags(&mut sess, "INBOX", 5).await.expect("changed");
    let changed_uids: Vec<u32> = changed.iter().map(|(u, _)| *u).collect();
    assert!(
        !changed_uids.contains(&2),
        "CONDSTORE must not be expected to announce the expunge"
    );

    // Enumeration is what actually finds it.
    let all = search_all_uids(&mut sess, "INBOX", false).await.expect("enumerate");
    assert_eq!(all, vec![1, 3, 4]);
    assert!(!all.contains(&2), "enumeration is the only source of truth for deletions");
}

/// Servers without CONDSTORE: the `from_uid:*` flag sweep must still pick up
/// read/star drift, otherwise cached messages keep stale state forever.
#[async_std::test]
async fn flag_sweep_works_without_condstore() {
    let mut mb = synthetic_mailbox("INBOX", 5);
    mb.by_uid_mut(4).unwrap().flags.push("\\Seen".into());
    mb.by_uid_mut(5).unwrap().flags.push("\\Flagged".into());

    let server = MockImap::start(Scenario::new().without_cap("CONDSTORE").mailbox(mb));
    let mut sess = session(&server).await;

    let flags = fetch_flags_from(&mut sess, "INBOX", 3).await.expect("flag sweep");
    let by_uid: std::collections::HashMap<u32, Vec<String>> = flags.into_iter().collect();

    assert_eq!(by_uid.len(), 3, "should cover uids 3..=5 only");
    assert!(by_uid[&4].iter().any(|f| f == "\\Seen"));
    assert!(by_uid[&5].iter().any(|f| f == "\\Flagged"));
    assert!(by_uid[&3].is_empty());
}

/// A changed UIDVALIDITY invalidates every cached UID. The client must at least
/// be able to see the change — silently reusing stale UIDs corrupts the cache.
#[async_std::test]
async fn uidvalidity_change_is_visible_to_the_caller() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::nth("SELECT", 2), Action::BumpUidValidity),
    );
    let mut sess = session(&server).await;

    let (_, first, _, _) = check_mailbox_status(&mut sess, "INBOX", false).await.unwrap();
    let (_, second, _, _) = check_mailbox_status(&mut sess, "INBOX", false).await.unwrap();

    assert_ne!(first, second, "a UIDVALIDITY bump must reach the caller");
}

/// A server that lies about UIDNEXT must not cause enumeration to invent or
/// drop UIDs — the UID list is authoritative, UIDNEXT is a hint.
#[async_std::test]
async fn a_wrong_uidnext_does_not_corrupt_enumeration() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 10))
            .fault(Trigger::on("SELECT"), Action::LieUidNext(9999)),
    );
    let mut sess = session(&server).await;

    let uids = search_all_uids(&mut sess, "INBOX", false).await.expect("enumerate");
    assert_eq!(uids, (1..=10).collect::<Vec<u32>>());
}

/// Header fetch for a specific UID set — the delta-sync path for new mail.
#[async_std::test]
async fn fetch_headers_by_uids_returns_only_what_was_asked_for() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 30)));
    let mut sess = session(&server).await;

    let (emails, total) = fetch_headers_by_uids(&mut sess, "INBOX", &[3, 17, 29])
        .await
        .expect("fetch by uids");

    assert_eq!(total, 30);
    let mut uids: Vec<u32> = emails.iter().map(|e| e.uid).collect();
    uids.sort_unstable();
    assert_eq!(uids, vec![3, 17, 29]);
}

/// TCP fragmentation is invisible on a healthy connection and brutal on a bad
/// one. A response split across many small writes must parse identically.
#[async_std::test]
async fn a_response_split_across_tcp_writes_still_parses() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 20))
            .fault(Trigger::on("FETCH"), Action::SplitWrites(7)),
    );
    let mut sess = session(&server).await;

    let uids = search_all_uids(&mut sess, "INBOX", false).await.expect("enumerate");
    assert_eq!(uids.len(), 20);
}
