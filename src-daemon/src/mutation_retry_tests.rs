//! A flag change or a move whose pooled socket died retries once on a new
//! connection, through the real RPC.
//!
//! Reported 2026-11-23: Settings, Unfinished server actions, listed a flag
//! change failing with `Failed to update flags: SELECT INBOX failed:
//! connection lost`. The pooled connection the peer had closed answered the
//! SELECT with nothing; reads and UID deletes already ask again on a fresh
//! connection (`ImapPool::run_read`, `run_uid_delete`), flags and moves did
//! not, so the change sat in the queue as a failure.

use crate::message_delete_characterization_tests::{plain_state, seed_accounts, RAW};
use crate::test_support::handle_request_for_test;
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::sync::Arc;

fn start(scenario: Scenario) -> (MockImap, Value, Arc<crate::state::DaemonState>) {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(Message::new(1, RAW));
    let srv = MockImap::start(scenario.mailbox(inbox).mailbox(Mailbox::new("Archive")));
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-mutation-retry-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    (srv, account, s)
}

fn flagged(srv: &MockImap) -> bool {
    srv.state().find("INBOX").unwrap().by_uid(1).unwrap().has_flag("\\Flagged")
}

async fn set_flagged(s: &Arc<crate::state::DaemonState>, account: &Value) -> crate::ipc::RpcResponse {
    handle_request_for_test(s, "imap_set_flags", json!({"account": account, "uid": 1, "mailbox": "INBOX", "flags": ["\\Flagged"], "action": "add"})).await
}

async fn move_to_archive(s: &Arc<crate::state::DaemonState>, account: &Value) -> crate::ipc::RpcResponse {
    handle_request_for_test(s, "imap_move_emails", json!({"account": account, "uids": [1], "sourceMailbox": "INBOX", "targetMailbox": "Archive"})).await
}

fn error_text(resp: &crate::ipc::RpcResponse) -> String {
    resp.error.as_ref().map(|e| e.message.clone()).unwrap_or_default()
}

#[tokio::test]
async fn a_flag_change_whose_select_loses_the_socket_retries_on_a_new_connection() {
    let (srv, account, s) = start(Scenario::new().fault(Trigger::nth("SELECT", 1), Action::DropConnection));
    let resp = set_flagged(&s, &account).await;
    assert!(resp.error.is_none(), "the retry must land the flag: {}", error_text(&resp));
    assert!(flagged(&srv), "the flag never reached the server");
    assert_eq!(srv.connection_count(), 2, "the retry must open a NEW connection");
}

/// A STORE whose reply was lost may have been applied; sending `+FLAGS`
/// again leaves the same flags, so it is retried too.
#[tokio::test]
async fn a_flag_change_whose_store_loses_the_socket_retries_on_a_new_connection() {
    let (srv, account, s) = start(Scenario::new().fault(Trigger::nth("STORE", 1), Action::DropConnection));
    let resp = set_flagged(&s, &account).await;
    assert!(resp.error.is_none(), "the retry must land the flag: {}", error_text(&resp));
    assert!(flagged(&srv), "the flag never reached the server");
    assert_eq!(srv.connection_count(), 2);
}

/// Negative control: every SELECT dies, so the green above is the retry, and
/// it happens once.
#[tokio::test]
async fn a_flag_change_that_keeps_losing_the_socket_fails_after_one_retry() {
    let (srv, account, s) = start(Scenario::new().fault(Trigger::on("SELECT"), Action::DropConnection));
    let resp = set_flagged(&s, &account).await;
    let err = error_text(&resp);
    assert!(mailvault_core::imap::pool::is_connection_lost(&err), "got: {err}");
    assert!(!flagged(&srv));
    assert_eq!(srv.connection_count(), 2, "one attempt, one retry, no loop");
}

/// The batched flag change rides the same retry: a dead pooled socket at the
/// SELECT is asked again once, on a new connection.
#[tokio::test]
async fn a_batched_flag_change_whose_select_loses_the_socket_retries_on_a_new_connection() {
    let (srv, account, s) = start(Scenario::new().fault(Trigger::nth("SELECT", 1), Action::DropConnection));
    let resp = handle_request_for_test(
        &s,
        "imap_set_flags_batch",
        json!({"account": account, "uids": [1], "mailbox": "INBOX", "flags": ["\\Flagged"], "action": "add"}),
    )
    .await;
    assert!(resp.error.is_none(), "the retry must land the flag: {}", error_text(&resp));
    assert_eq!(resp.result.unwrap()["done"], json!([1]));
    assert!(flagged(&srv), "the flag never reached the server");
    assert_eq!(srv.connection_count(), 2, "the retry must open a NEW connection");
}

#[tokio::test]
async fn a_move_whose_select_loses_the_socket_retries_on_a_new_connection() {
    let (srv, account, s) = start(Scenario::new().fault(Trigger::nth("SELECT", 1), Action::DropConnection));
    let resp = move_to_archive(&s, &account).await;
    assert!(resp.error.is_none(), "the retry must land the move: {}", error_text(&resp));
    let state = srv.state();
    assert!(state.find("INBOX").unwrap().by_uid(1).is_none(), "still in INBOX");
    assert_eq!(state.find("Archive").unwrap().messages.len(), 1, "exactly one copy in Archive");
    assert_eq!(srv.connection_count(), 2);
}

/// Without MOVE the move is COPY + delete. A COPY whose reply was lost may
/// have landed, and sending it again would leave two copies: once the socket
/// dies past the SELECT, the error surfaces and the queue decides.
#[tokio::test]
async fn a_copy_fallback_move_that_loses_the_socket_after_select_is_not_resent() {
    let (srv, account, s) = start(Scenario::new().without_cap("MOVE").fault(Trigger::nth("COPY", 1), Action::DropConnection));
    let resp = move_to_archive(&s, &account).await;
    let err = error_text(&resp);
    assert!(mailvault_core::imap::pool::is_connection_lost(&err), "got: {err}");
    assert_eq!(srv.connection_count(), 1, "a COPY must never be re-sent on its own");
}
