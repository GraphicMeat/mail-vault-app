//! Session lifecycle: greeting, auth, COMPRESS negotiation, and pooling.
//!
//! The pooling tests are the important ones. A command that fails mid-parse
//! leaves unread bytes in the socket; re-pooling that session makes the *next*
//! command read the *previous* command's reply. In production that showed up as
//! a reconcile seeing EXISTS=0 and pruning 505 cached headers off disk (06a31c2).

mod common;

use common::{config_for, eml, pool, session};
use mailvault_core::imap::*;
use mock_imap::state::{synthetic_mailbox, Mailbox};
use mock_imap::{Action, MockImap, Scenario, Trigger};

#[async_std::test]
async fn reads_the_greeting_before_authenticating() {
    let server = MockImap::start(
        Scenario::new()
            .greeting("* OK [CAPABILITY IMAP4rev1] Purelymail ready, chatty greeting")
            .mailbox(synthetic_mailbox("INBOX", 1)),
    );
    let mut sess = session(&server).await;
    assert_eq!(list_mailboxes(&mut sess).await.unwrap().len(), 1);
}

#[async_std::test]
async fn authenticates_with_xoauth2_when_configured() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));

    let config: ImapConfig = serde_json::from_value(serde_json::json!({
        "email": "user@example.com",
        "imapHost": server.host(),
        "imapPort": server.port(),
        "authType": "oauth2",
        "oauth2AccessToken": "ya29.fake-token",
    }))
    .unwrap();
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");

    let mut sess = create_imap_session(&config, &pool()).await.expect("xoauth2 session");
    assert_eq!(list_mailboxes(&mut sess).await.unwrap().len(), 1);

    let sent = server.commands().join("\n");
    assert!(sent.contains("AUTHENTICATE XOAUTH2"), "expected XOAUTH2, sent:\n{sent}");
    assert!(!sent.contains("LOGIN"), "must not fall back to LOGIN");
}

/// A server that advertises COMPRESS=DEFLATE and then refuses it must not kill
/// the session — the client reconnects uncompressed.
#[async_std::test]
async fn falls_back_to_an_uncompressed_session_when_compress_is_refused() {
    let server = MockImap::start(
        Scenario::new()
            .capabilities(&["IMAP4rev1", "COMPRESS=DEFLATE", "UIDPLUS", "MOVE"])
            .mailbox(synthetic_mailbox("INBOX", 4)),
    );
    let mut sess = session(&server).await;

    // The reconnect is the point: two TCP connections, one working session.
    assert!(
        server.connection_count() >= 2,
        "expected a reconnect after COMPRESS was refused"
    );
    let uids = search_all_uids(&mut sess, "INBOX", false).await.expect("usable session");
    assert_eq!(uids.len(), 4);
}

#[async_std::test]
async fn test_connection_succeeds_and_logs_out() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    test_connection(&config_for(&server)).await.expect("connection test");
    assert!(
        server.commands().iter().any(|c| c.to_uppercase().contains("LOGOUT")),
        "test_connection must not leave the session open for the server to time out"
    );
}

/// A LIST on a socket that dies mid-response must be an error. It used to
/// `filter_map(Result::ok)` the stream, so a broken pipe became `Ok(vec![])` —
/// indistinguishable from a server that genuinely has no folders. The frontend
/// believed it, raised "Server returned empty folder list unexpectedly", and
/// kept showing cached folders (prod log 2026-08-17: `LIST returned 0 raw
/// mailbox names`, then 116ms later `Pooled IMAP session stale: Broken pipe`).
#[async_std::test]
async fn a_dropped_list_is_an_error_not_an_empty_folder_list() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::on("LIST"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = list_mailboxes(&mut sess)
        .await
        .expect_err("a LIST on a dead socket must not report zero mailboxes");
    assert!(!err.is_empty());
}

#[async_std::test]
async fn a_dropped_connection_surfaces_as_an_error_not_a_hang() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 5))
            .fault(Trigger::on("FETCH"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = search_all_uids(&mut sess, "INBOX", false)
        .await
        .expect_err("a closed socket must be an error");
    assert!(!err.is_empty());
}

/// A healthy session is reused: no new TCP connection on the second checkout.
#[async_std::test]
async fn a_healthy_session_is_returned_to_the_pool_and_reused() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
    let config = config_for(&server);
    let pool = pool();

    let guard = pool.get_background(&config).await.expect("first checkout");
    let after_first = server.connection_count();
    pool.return_background(&config, guard).await;

    let guard = pool.get_background(&config).await.expect("second checkout");
    assert_eq!(
        server.connection_count(),
        after_first,
        "a healthy session must be reused, not reconnected"
    );
    pool.return_background(&config, guard).await;
}

/// The regression: a session whose command failed must be discarded, not
/// re-pooled. `discard()` logs out and frees the slot, so the next checkout is a
/// fresh TCP connection with an empty read buffer.
#[async_std::test]
async fn a_poisoned_session_is_discarded_rather_than_reused() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 40))
            // Corrupt the first FETCH only; the replacement session works.
            .fault(
                Trigger::nth("FETCH", 1),
                Action::InjectMidLine("* OK Still here\r\n".into()),
            ),
    );
    let config = config_for(&server);
    let pool = pool();

    let guard = pool.get_background(&config).await.expect("checkout");
    let mailvault_core::imap::pool::PooledSessionGuard { mut session, last_selected, _permit } =
        guard;
    let failed = search_all_uids(&mut session, "INBOX", false).await;
    let guard = mailvault_core::imap::pool::PooledSessionGuard { session, last_selected, _permit };

    assert!(failed.is_err(), "the injected splice should break this fetch");
    let before_discard = server.connection_count();
    pool.discard(&config, guard).await;

    // A fresh checkout must open a NEW connection — the poisoned one is gone.
    let guard = pool.get_background(&config).await.expect("fresh checkout");
    assert_eq!(
        server.connection_count(),
        before_discard + 1,
        "discard() must not leave the poisoned session in the pool"
    );

    // And the replacement session is clean: it reads its own reply, not the last one.
    let mailvault_core::imap::pool::PooledSessionGuard { mut session, .. } = guard;
    let uids = search_all_uids(&mut session, "INBOX", false)
        .await
        .expect("replacement session must be clean");
    assert_eq!(uids.len(), 40);
}

/// Concurrent workers must not open unbounded connections.
#[async_std::test]
async fn the_pool_caps_concurrent_sessions_per_account() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
    let config = config_for(&server);
    let pool = pool();

    let mut guards = Vec::new();
    for _ in 0..3 {
        guards.push(pool.get_background(&config).await.expect("checkout"));
    }
    assert_eq!(
        server.connection_count(),
        3,
        "three concurrent checkouts, three connections"
    );

    for g in guards {
        pool.return_background(&config, g).await;
    }
    let g = pool.get_background(&config).await.expect("checkout after return");
    assert_eq!(
        server.connection_count(),
        3,
        "returned sessions must be reused rather than reconnected"
    );
    pool.return_background(&config, g).await;
}

/// A pooled socket the peer closed while it sat idle answers the first command
/// with nothing and dies. The user saw that as "Couldn't load this message" and
/// a Try again button that worked on the first press — because the second press
/// got a new connection. `run_read` presses it for them.
#[async_std::test]
async fn a_read_whose_socket_dies_retries_once_on_a_new_connection() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            // Only the first body fetch dies; the replacement connection works.
            .fault(Trigger::nth("FETCH", 1), Action::DropConnection),
    );
    let config = config_for(&server);
    let pool = pool();

    let email = pool
        .run_read(&config, true, |mut session| async move {
            let r = fetch_email_by_uid_light(&mut session, "INBOX", 1).await?;
            Ok((r, session, Some("INBOX".to_string())))
        })
        .await
        .expect("the retry must deliver the message the first attempt lost");

    assert!(email.is_some(), "uid 1 is in this mailbox");
    assert_eq!(
        server.connection_count(),
        2,
        "the retry must open a NEW connection, not reuse the dead one"
    );
}

/// Negative control for the test above: with every fetch dying, the retry
/// cannot succeed — so the green above is the retry working, not the fault
/// failing to fire. And the retry happens once: two connections, not a loop.
#[async_std::test]
async fn a_read_that_keeps_losing_the_socket_fails_after_exactly_one_retry() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(Trigger::on("FETCH"), Action::DropConnection),
    );
    let config = config_for(&server);
    let pool = pool();

    let err = pool
        .run_read(&config, true, |mut session| async move {
            let r = fetch_email_by_uid_light(&mut session, "INBOX", 1).await?;
            Ok((r, session, Some("INBOX".to_string())))
        })
        .await
        .expect_err("a server that never answers must still surface an error");

    assert!(
        mailvault_core::imap::pool::is_connection_lost(&err),
        "the error that drives the retry must be recognisable as one: {err}"
    );
    assert_eq!(server.connection_count(), 2, "one attempt, one retry, no loop");
}

/// A `NO` is the server's answer, not a broken pipe: repeating it changes
/// nothing, so it must not cost a second connection.
#[async_std::test]
async fn a_refusal_is_not_retried() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(
                Trigger::on("FETCH"),
                Action::Respond("NO".into(), "Bandwidth limit exceeded".into()),
            ),
    );
    let config = config_for(&server);
    let pool = pool();

    let _err = pool
        .run_read(&config, true, |mut session| async move {
            let r = fetch_email_by_uid_light(&mut session, "INBOX", 1).await?;
            Ok((r, session, Some("INBOX".to_string())))
        })
        .await
        .expect_err("a refused fetch is an error");

    assert_eq!(
        server.connection_count(),
        1,
        "the server answered — asking again on a new connection is pure cost"
    );
}

/// The same dead pooled socket, on a delete.
///
/// Reported 2026-09-01: deleting a message from the reading pane put the row
/// straight back, and deleting it again worked. The row is removed
/// optimistically, the pooled connection the peer had closed answered the
/// first command with `connection lost`, and the frontend restored the row —
/// while the failed session was discarded, so the second attempt got a fresh
/// connection and went through. That second press is what `run_uid_delete`
/// does for the user.
///
/// Only for a delete addressed by UID, which is why this is not `run_read`:
/// re-issuing it against a uid the server has already expunged is a no-op, the
/// same property `pending_delete`'s next-launch replay has always relied on.
#[async_std::test]
async fn a_delete_whose_socket_dies_retries_once_on_a_new_connection() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            // Only the first STORE dies; the replacement connection works.
            .fault(Trigger::nth("STORE", 1), Action::DropConnection),
    );
    let config = config_for(&server);
    let pool = pool();

    pool.run_uid_delete(&config, true, |mut session| async move {
        delete_email(&mut session, "INBOX", 1, true).await?;
        Ok(((), session, Some("INBOX".to_string())))
    })
    .await
    .expect("the retry must land the delete the first attempt lost");

    assert!(
        server.state().find("INBOX").unwrap().by_uid(1).is_none(),
        "the message is still there — the retry never reached the server",
    );
    assert_eq!(
        server.connection_count(),
        2,
        "the retry must open a NEW connection, not reuse the dead one"
    );
}

/// Negative control for the test above: with every STORE dying, the retry
/// cannot succeed — so the green above is the retry working, not the fault
/// failing to fire. And the retry happens once: two connections, not a loop.
#[async_std::test]
async fn a_delete_that_keeps_losing_the_socket_fails_after_exactly_one_retry() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(Trigger::on("STORE"), Action::DropConnection),
    );
    let config = config_for(&server);
    let pool = pool();

    let err = pool
        .run_uid_delete(&config, true, |mut session| async move {
            delete_email(&mut session, "INBOX", 1, true).await?;
            Ok(((), session, Some("INBOX".to_string())))
        })
        .await
        .expect_err("a server that never answers must still surface an error");

    assert!(
        mailvault_core::imap::pool::is_connection_lost(&err),
        "the error that drives the retry must be recognisable as one: {err}"
    );
    assert!(
        server.state().find("INBOX").unwrap().by_uid(1).is_some(),
        "nothing was deleted, so the message must still be there",
    );
    assert_eq!(server.connection_count(), 2, "one attempt, one retry, no loop");
}
