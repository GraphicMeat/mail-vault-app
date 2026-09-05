//! Flag, delete, move, append and role-mailbox resolution.
//!
//! Trash/Sent resolution is the source of two shipped bugs: hardcoded folder
//! names missed namespaced servers (Dovecot/Hostinger `INBOX.Trash`), leaving
//! mail flagged `\Deleted` but still visible, and Sent detection fell back to
//! the wrong folder. See 8eae2ba and the Thunderbird-parity work.

mod common;

use common::{eml, session};
use mailvault_core::imap::*;
use mock_imap::state::Mailbox;
use mock_imap::{Action, MockImap, Scenario, Trigger};
use std::time::Duration;

fn inbox_with(n: u32) -> Mailbox {
    let mut mb = Mailbox::new("INBOX");
    for i in 1..=n {
        mb.add(mock_imap::Message::new(
            i,
            eml(&format!("Subject {i}"), "sender@example.com", "body"),
        ));
    }
    mb
}

#[async_std::test]
async fn set_flags_adds_and_removes() {
    let server = MockImap::start(Scenario::new().mailbox(inbox_with(2)));
    let mut sess = session(&server).await;

    set_flags(&mut sess, "INBOX", 1, &["\\Seen".into()], "add")
        .await
        .expect("add flag");
    assert!(server.state().find("INBOX").unwrap().by_uid(1).unwrap().has_flag("\\Seen"));

    set_flags(&mut sess, "INBOX", 1, &["\\Seen".into()], "remove")
        .await
        .expect("remove flag");
    assert!(!server.state().find("INBOX").unwrap().by_uid(1).unwrap().has_flag("\\Seen"));
}

/// Namespaced Trash — the Dovecot/Hostinger layout that hardcoded names missed.
#[async_std::test]
async fn delete_resolves_a_namespaced_trash_folder() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(inbox_with(3))
            .mailbox(Mailbox::new("INBOX.Trash").with_attrs(&["\\HasNoChildren", "\\Trash"])),
    );
    let mut sess = session(&server).await;

    delete_email(&mut sess, "INBOX", 2, false).await.expect("delete");

    let state = server.state();
    assert!(state.find("INBOX").unwrap().by_uid(2).is_none(), "message left in INBOX");
    assert_eq!(
        state.find("INBOX.Trash").unwrap().messages.len(),
        1,
        "message never reached Trash — the exact shape of the silent-no-op bug"
    );
}

/// `Deleted Items` (Exchange-style) must also resolve, without SPECIAL-USE.
#[async_std::test]
async fn delete_falls_back_to_a_named_trash_without_special_use() {
    let server = MockImap::start(
        Scenario::new()
            .without_cap("SPECIAL-USE")
            .mailbox(inbox_with(2))
            .mailbox(Mailbox::new("Deleted Items")),
    );
    let mut sess = session(&server).await;

    delete_email(&mut sess, "INBOX", 1, false).await.expect("delete");
    assert_eq!(server.state().find("Deleted Items").unwrap().messages.len(), 1);
}

/// No MOVE capability: COPY + `\Deleted` + UID EXPUNGE must produce the same
/// end state, not leave a duplicate behind.
#[async_std::test]
async fn delete_falls_back_to_copy_expunge_without_move() {
    let server = MockImap::start(
        Scenario::new()
            .without_cap("MOVE")
            .mailbox(inbox_with(2))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"]))
            // Even advertised, refuse MOVE — servers lie about capabilities.
            .fault(Trigger::on("MOVE"), Action::Respond("NO".into(), "MOVE unsupported".into())),
    );
    let mut sess = session(&server).await;

    delete_email(&mut sess, "INBOX", 1, false).await.expect("delete");

    let state = server.state();
    assert!(state.find("INBOX").unwrap().by_uid(1).is_none(), "source copy not expunged");
    assert_eq!(state.find("Trash").unwrap().messages.len(), 1);
}

/// Permanent delete must scope UID EXPUNGE to the target and leave other
/// `\Deleted`-flagged messages alone.
#[async_std::test]
async fn permanent_delete_expunges_only_the_target_uid() {
    let mut mb = inbox_with(3);
    mb.by_uid_mut(3).unwrap().flags.push("\\Deleted".into());
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut sess = session(&server).await;

    delete_email(&mut sess, "INBOX", 1, true).await.expect("permanent delete");

    let inbox = server.state().find("INBOX").unwrap().clone();
    assert!(inbox.by_uid(1).is_none(), "uid 1 should be gone");
    assert!(
        inbox.by_uid(3).is_some(),
        "an unrelated \\Deleted message must survive a scoped UID EXPUNGE"
    );
}

#[async_std::test]
async fn ensure_sent_mailbox_prefers_the_special_use_flag() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(inbox_with(1))
            .mailbox(Mailbox::new("Sent Items").with_attrs(&["\\HasNoChildren", "\\Sent"]))
            // A decoy that name-based heuristics would grab first.
            .mailbox(Mailbox::new("Sent")),
    );
    let mut sess = session(&server).await;

    let sent = ensure_sent_mailbox(&mut sess).await.expect("resolve Sent");
    assert_eq!(sent, "Sent Items", "\\Sent flag must beat the name heuristic");
}

#[async_std::test]
async fn ensure_sent_mailbox_creates_one_when_the_server_has_none() {
    let server = MockImap::start(
        Scenario::new().without_cap("SPECIAL-USE").mailbox(inbox_with(1)),
    );
    let mut sess = session(&server).await;

    let sent = ensure_sent_mailbox(&mut sess).await.expect("create Sent");
    assert!(
        server.state().find(&sent).is_some(),
        "resolved '{sent}' but the server has no such mailbox"
    );
}

#[async_std::test]
async fn append_stores_the_message_and_reports_the_new_uid() {
    let server = MockImap::start(
        Scenario::new().mailbox(inbox_with(1)).mailbox(Mailbox::new("Sent").with_attrs(&["\\Sent"])),
    );
    let mut sess = session(&server).await;

    let raw = eml("Sent from MailVault", "user@example.com", "hello").into_bytes();
    append_email(&mut sess, "Sent", &raw, "\\Seen", None).await.expect("append");

    let sent = server.state().find("Sent").unwrap().clone();
    assert_eq!(sent.messages.len(), 1);
    assert!(String::from_utf8_lossy(&sent.messages[0].raw).contains("Sent from MailVault"));
}

/// Hostinger went silent for 15+ seconds after an SMTP send before answering
/// APPEND. The verified path must ride that out, not give up.
///
/// Runs under tokio, not async-std: `append_email_verified` wraps its APPEND in
/// `tokio::time::timeout`, so it panics without a tokio reactor. That matches
/// production (daemon and Tauri are both tokio) but it is a real coupling.
#[tokio::test]
async fn append_verified_survives_a_slow_server() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("Sent").with_attrs(&["\\Sent"]))
            .fault(Trigger::on("APPEND"), Action::Delay(Duration::from_millis(1200))),
    );
    let mut sess = session(&server).await;

    let raw = eml("Delayed", "user@example.com", "hello").into_bytes();
    let (before, after, found) =
        append_email_verified(&mut sess, "Sent", &raw, "\\Seen", Some("<delayed@example.com>"), None)
            .await
            .expect("append should survive a slow server");

    assert_eq!(before, 0);
    assert_eq!(after, 1);
    assert_eq!(found, Some(1), "the appended message must be findable by Message-ID");
}

#[async_std::test]
async fn append_to_a_missing_mailbox_reports_the_failure() {
    let server = MockImap::start(Scenario::new().mailbox(inbox_with(1)));
    let mut sess = session(&server).await;

    let raw = eml("Nowhere", "user@example.com", "hello").into_bytes();
    let err = append_email(&mut sess, "NoSuchFolder", &raw, "", None)
        .await
        .expect_err("append to a missing mailbox must fail");
    assert!(err.to_lowercase().contains("append"), "unhelpful error: {err}");
}

// ── move_uids ──────────────────────────────────────────────────────────────
// The shipped move fallback (src-tauri/move_emails.rs, deleted with this)
// collected and discarded the STORE and EXPUNGE streams, so a socket that died
// after COPY reported a successful move and the message stayed in both folders.

fn inbox_and_archive(n: u32) -> Scenario {
    Scenario::new().mailbox(inbox_with(n)).mailbox(Mailbox::new("Archive"))
}

#[async_std::test]
async fn move_uids_uses_uid_move_when_the_server_has_it() {
    let server = MockImap::start(inbox_and_archive(2));
    let mut sess = session(&server).await;

    let moved = move_uids(&mut sess, "INBOX", "Archive", &[1], true, true).await.expect("move");

    assert_eq!(moved, 1);
    let state = server.state();
    assert!(state.find("INBOX").unwrap().by_uid(1).is_none(), "source still holds uid 1");
    assert_eq!(state.find("Archive").unwrap().messages.len(), 1);
    assert_eq!(server.count_commands("UID MOVE"), 1);
    assert_eq!(server.count_commands("UID COPY"), 0);
}

#[async_std::test]
async fn move_uids_falls_back_to_copy_delete_expunge_without_move() {
    let server = MockImap::start(inbox_and_archive(2).without_cap("MOVE"));
    let mut sess = session(&server).await;

    let moved = move_uids(&mut sess, "INBOX", "Archive", &[1, 2], false, true).await.expect("move");

    assert_eq!(moved, 2);
    let state = server.state();
    assert!(state.find("INBOX").unwrap().messages.is_empty(), "source still holds the messages");
    assert_eq!(state.find("Archive").unwrap().messages.len(), 2);
    assert_eq!(server.count_commands("UID COPY"), 1);
    assert_eq!(server.count_commands("UID EXPUNGE"), 1);
}

/// Without UIDPLUS there is no `UID EXPUNGE`; a plain `EXPUNGE` takes every
/// `\Deleted` message in the mailbox and leaves the rest — what Thunderbird
/// does on the same servers.
#[async_std::test]
async fn move_uids_without_uidplus_expunges_the_mailbox() {
    let server = MockImap::start(inbox_and_archive(2).without_cap("MOVE").without_cap("UIDPLUS"));
    let mut sess = session(&server).await;

    move_uids(&mut sess, "INBOX", "Archive", &[2], false, false).await.expect("move");

    assert_eq!(server.count_commands("UID EXPUNGE"), 0, "UID EXPUNGE needs UIDPLUS");
    assert_eq!(server.count_commands("EXPUNGE"), 1);
    let state = server.state();
    assert!(state.find("INBOX").unwrap().by_uid(2).is_none());
    assert!(state.find("INBOX").unwrap().by_uid(1).is_some(), "an unflagged message must survive a plain EXPUNGE");
    assert_eq!(state.find("Archive").unwrap().messages.len(), 1);
}

/// Negative control for the bug itself: with every STORE dying, the move
/// cannot succeed — an `Ok` here is the shipped defect.
#[async_std::test]
async fn a_move_whose_socket_dies_after_copy_is_an_error_not_a_success() {
    let server = MockImap::start(
        inbox_and_archive(1)
            .without_cap("MOVE")
            .fault(Trigger::on("STORE"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = move_uids(&mut sess, "INBOX", "Archive", &[1], false, true)
        .await
        .expect_err("a dead socket after COPY must not report a move");

    assert!(pool::is_connection_lost(&err), "must read as a lost connection: {err}");
    assert!(server.state().find("INBOX").unwrap().by_uid(1).is_some(), "the source copy is still there");
}

// ── APPEND date ────────────────────────────────────────────────────────────
// Both APPEND paths sent no INTERNALDATE, so every migrated or restored
// message arrived dated "now" on the server.

#[async_std::test]
async fn append_carries_the_internal_date() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
    let mut sess = session(&server).await;
    let raw = eml("Old news", "a@example.com", "body");

    append_email(&mut sess, "INBOX", raw.as_bytes(), "\\Seen", Some("05-Mar-2019 08:15:00 +0100"))
        .await
        .expect("append");

    let state = server.state();
    let msg = state.find("INBOX").unwrap().messages.last().expect("appended");
    assert_eq!(msg.internal_date, "05-Mar-2019 08:15:00 +0100");
    // RFC 3501: `APPEND mailbox [(flags)] ["date-time"] literal`. An unparenthesized
    // flag list puts the date in a position no server parses.
    assert!(
        server
            .commands()
            .iter()
            .any(|c| c.contains("APPEND") && c.contains("(\\Seen) \"05-Mar-2019 08:15:00 +0100\"")),
        "the flag list must be parenthesized and the date-time quoted: {:?}",
        server.commands()
    );
}

/// Runs under tokio, not async-std: `append_email_verified` wraps its APPEND in
/// `tokio::time::timeout` (see `append_verified_survives_a_slow_server`).
#[tokio::test]
async fn verified_append_carries_the_internal_date_too() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
    let config = common::config_for(&server);
    let mut sess = create_imap_session_no_compress(&config).await.expect("session");
    let raw = eml("Old news", "a@example.com", "body");

    append_email_verified(&mut sess, "INBOX", raw.as_bytes(), "", None, Some("05-Mar-2019 08:15:00 +0100"))
        .await
        .expect("verified append");

    let state = server.state();
    assert_eq!(state.find("INBOX").unwrap().messages.last().unwrap().internal_date, "05-Mar-2019 08:15:00 +0100");
}

#[test]
fn internal_date_comes_from_the_date_header() {
    // eml() writes `Date: Thu, 01 Jan 2026 12:00:00 +0000`.
    let raw = eml("Old news", "a@example.com", "body");
    assert_eq!(internal_date_from_raw(raw.as_bytes()).as_deref(), Some("01-Jan-2026 12:00:00 +0000"));
    assert_eq!(internal_date_from_raw(b"Subject: no date\r\n\r\nx"), None);
}
