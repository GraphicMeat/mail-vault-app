//! STATUS: counts for a folder that is not open.

mod common;

use common::{eml, session};
use mailvault_core::imap::*;
use mock_imap::state::Mailbox;
use mock_imap::{Action, Message, MockImap, Scenario, Trigger};

fn archive() -> Mailbox {
    let mut mb = Mailbox::new("Archive");
    mb.add(Message::new(1, eml("Unread", "x@example.com", "b")));
    mb.add(Message::new(2, eml("Read", "x@example.com", "b")).with_flags(&["\\Seen"]));
    mb
}

#[async_std::test]
async fn status_reports_counts_without_selecting_the_folder() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(archive()));
    let mut sess = session(&server).await;

    let st = mailbox_status(&mut sess, "Archive").await.expect("status");

    assert_eq!(st.path, "Archive");
    assert_eq!(st.messages, 2);
    assert_eq!(st.unseen, Some(1));
    assert!(st.uid_validity.is_some());
    assert_eq!(server.count_commands("SELECT"), 0, "STATUS must not open the folder");
}

#[async_std::test]
async fn status_of_a_missing_folder_is_an_error() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
    let mut sess = session(&server).await;
    let err = mailbox_status(&mut sess, "Nope").await.expect_err("a missing folder is an error");
    assert!(!pool::is_connection_lost(&err), "a refused folder must not read as a dead socket: {err}");
}

/// Same rule as SELECT: a reply with nothing in it is a dead socket, not an
/// empty folder. UIDVALIDITY is requested, so its absence is the socket.
#[async_std::test]
async fn status_on_a_dropped_socket_is_an_error_not_zero_messages() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX"))
            .mailbox(archive())
            .fault(Trigger::on("STATUS"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = mailbox_status(&mut sess, "Archive").await.expect_err("no reply is not zero messages");
    assert!(pool::is_connection_lost(&err), "must read as a lost connection: {err}");
}

/// A refused folder is skipped, not fatal — the sweep answers for the rest.
#[async_std::test]
async fn a_refused_folder_is_skipped_by_the_sweep() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(archive()));
    let mut sess = session(&server).await;

    let rows = mailbox_statuses(&mut sess, &["Nope".to_string(), "Archive".to_string()])
        .await
        .expect("a refused folder must not fail the sweep");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].path, "Archive");
    assert_eq!(rows[0].messages, 2);
}

/// A dead socket ends the sweep: no partial answer built on a connection that
/// is gone, and an error the pool's retry recognises.
#[async_std::test]
async fn a_dead_socket_ends_the_sweep_with_an_error() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX"))
            .mailbox(archive())
            .fault(Trigger::nth("STATUS", 2), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = mailbox_statuses(&mut sess, &["Archive".to_string(), "INBOX".to_string()])
        .await
        .expect_err("the second STATUS dies; the sweep must not answer");
    assert!(pool::is_connection_lost(&err), "must read as a lost connection: {err}");
}
