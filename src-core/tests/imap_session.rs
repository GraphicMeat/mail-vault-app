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
use std::time::Duration;

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
    test_connection(&config_for(&server), &pool()).await.expect("connection test");
    assert!(
        server.commands().iter().any(|c| c.to_uppercase().contains("LOGOUT")),
        "test_connection must not leave the session open for the server to time out"
    );
}

/// LOGOUT is fire-and-forget: AUTH already succeeded, so a server that goes
/// silent on LOGOUT must not make the test report failure, or wait for it.
#[async_std::test]
async fn test_connection_ignores_a_slow_logout() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("LOGOUT"), Action::Delay(Duration::from_secs(30))),
    );

    let started = std::time::Instant::now();
    test_connection(&config_for(&server), &pool()).await.expect("connection test");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "a stalled LOGOUT must not be waited out, took {:?}",
        started.elapsed()
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

/// async-imap's `parse_mailbox` returns whatever it collected when the stream
/// ends before the tagged reply — on a dead socket that is `Mailbox::default()`,
/// EXISTS 0 and no error, which the daemon's reconcile once pruned 1399 cached
/// headers against. The pool's retry keys on the wording.
#[async_std::test]
async fn a_select_on_a_dropped_socket_is_an_error_not_an_empty_mailbox() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::on("SELECT"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = select_mailbox(&mut sess, "INBOX")
        .await
        .expect_err("a SELECT on a dead socket must not report an empty mailbox");
    assert!(pool::is_connection_lost(&err), "must read as a lost connection: {err}");
}

/// Same hole on the CONDSTORE flavour the daemon's delta sync actually uses.
#[async_std::test]
async fn a_condstore_select_on_a_dropped_socket_is_an_error_too() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::on("SELECT"), Action::DropConnection),
    );
    let mut sess = session(&server).await;

    let err = check_mailbox_status(&mut sess, "INBOX", true)
        .await
        .expect_err("EXISTS 0 from a dead socket is not a mailbox status");
    assert!(pool::is_connection_lost(&err), "must read as a lost connection: {err}");
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

    let (send, receive) = async_std::channel::unbounded();
    let mut workers = Vec::new();
    for _ in 0..6 {
        let pool = pool.clone();
        let config = config.clone();
        let send = send.clone();
        workers.push(async_std::task::spawn(async move {
            let guard = pool.get_background(&config).await.expect("checkout");
            assert!(send.send(guard).await.is_ok(), "receiver remains open");
        }));
    }
    drop(send);

    let mut guards = Vec::new();
    for _ in 0..5 {
        match async_std::future::timeout(Duration::from_secs(2), receive.recv()).await {
            Ok(Ok(guard)) => guards.push(guard),
            _ => break,
        }
    }
    if guards.len() != 5 {
        let acquired = guards.len();
        for guard in guards.drain(..) {
            pool.return_background(&config, guard).await;
        }
        for worker in workers {
            worker.await;
        }
        while let Ok(guard) = receive.try_recv() {
            pool.return_background(&config, guard).await;
        }
        panic!("expected five simultaneous checkouts, got {acquired}");
    }
    assert_eq!(
        server.connection_count(),
        5,
        "five concurrent checkouts, five connections"
    );

    assert!(
        async_std::future::timeout(Duration::from_millis(50), receive.recv())
            .await
            .is_err(),
        "the sixth checkout must queue while five permits are held"
    );
    for guard in guards {
        pool.return_background(&config, guard).await;
    }
    let sixth = async_std::future::timeout(Duration::from_secs(2), receive.recv())
        .await
        .expect("sixth checkout should start when a permit returns")
        .expect("sixth checkout must succeed");
    pool.return_background(&config, sixth).await;
    for worker in workers {
        worker.await;
    }
    assert_eq!(
        server.connection_count(),
        5,
        "returned sessions must be reused rather than reconnected"
    );
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

/// Track A (2026-09-26): a half-open pooled socket takes the SELECT and never
/// answers. It used to hang the body fetch to the daemon's 45s timeout, and the
/// dead-socket retry above never ran because nothing failed. `CMD_STALL` of
/// silence now reads as a dead socket, and the retry delivers the message.
#[async_std::test]
async fn a_read_whose_select_goes_silent_retries_on_a_fresh_connection() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(Trigger::nth("SELECT", 1), Action::Delay(Duration::from_secs(40))),
    );
    let config = config_for(&server);
    let pool = pool();

    let started = std::time::Instant::now();
    let email = async_std::future::timeout(
        CMD_STALL + Duration::from_secs(2),
        pool.run_read(&config, true, |mut session| async move {
            let r = fetch_email_by_uid_light(&mut session, "INBOX", 1).await?;
            Ok((r, session, Some("INBOX".to_string())))
        }),
    )
    .await
    .expect("a silent socket must be given up on after CMD_STALL, not waited out")
    .expect("the retry must deliver the message");

    assert!(email.is_some(), "uid 1 is in this mailbox");
    assert!(started.elapsed() >= CMD_STALL, "a live server is not cut off early: {:?}", started.elapsed());
    assert_eq!(server.connection_count(), 2, "the retry must open a NEW connection");
}

/// The same dead socket, but it died halfway through the body: some bytes
/// arrived, then nothing. The deadline resets on bytes, so it still fires
/// `CMD_STALL` after the last one.
#[async_std::test]
async fn a_body_fetch_that_stalls_mid_reply_retries_on_a_fresh_connection() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "Body")))
            .fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 1), Action::StallMidResponse(40)),
    );
    let config = config_for(&server);
    let pool = pool();

    let email = async_std::future::timeout(
        CMD_STALL + Duration::from_secs(2),
        pool.run_read(&config, true, |mut session| async move {
            let r = fetch_email_by_uid_light(&mut session, "INBOX", 1).await?;
            Ok((r, session, Some("INBOX".to_string())))
        }),
    )
    .await
    .expect("a reply that stops mid-way must be given up on after CMD_STALL")
    .expect("the retry must deliver the message");

    assert!(email.is_some(), "uid 1 is in this mailbox");
    assert_eq!(server.connection_count(), 2, "the retry must open a NEW connection");
}

/// A server that accepts the socket and never greets. Only TCP had a timeout,
/// so this held the caller for as long as the server liked.
#[async_std::test]
async fn a_server_that_never_greets_fails_the_connect_after_the_greeting_timeout() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::OnConnect, Action::Delay(Duration::from_secs(40))),
    );
    let config = config_for(&server);
    let pool = pool();

    let err = async_std::future::timeout(
        GREETING_TIMEOUT + Duration::from_secs(2),
        create_imap_session(&config, &pool),
    )
    .await
    .expect("a missing greeting must be given up on after GREETING_TIMEOUT")
    .err()
    .expect("a server that never greets cannot give a session");

    assert!(err.contains("greeting"), "error should name the step: {err}");
}

/// A LOGIN the server never answers fails on `CMD_STALL` as a lost
/// connection. Worded as "Login failed", the app told the user to check a
/// password that was never rejected.
#[async_std::test]
async fn a_login_the_server_never_answers_is_not_reported_as_a_bad_password() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("LOGIN"), Action::Delay(Duration::from_secs(40))),
    );
    let config = config_for(&server);
    let pool = pool();

    let err = async_std::future::timeout(CMD_STALL + Duration::from_secs(2), create_imap_session(&config, &pool))
        .await
        .expect("a silent LOGIN is given up on after CMD_STALL")
        .err()
        .expect("a server that never answers LOGIN cannot give a session");

    assert!(err.starts_with("connection lost while signing in to "), "got: {err}");
    assert!(pool::is_connection_lost(&err), "must stay a dead socket for the retry: {err}");
    let lowered = err.to_ascii_lowercase();
    for credential_needle in ["login failed", "auth failed", "authentication", "password", "credentials", "oauth"] {
        assert!(!lowered.contains(credential_needle), "reads as a credential error ({credential_needle}): {err}");
    }
}

/// Task A1: `run_read_timed` writes each stage into the `ReadTimings` it is
/// given, so `imap_get_email_light`'s stall log has real numbers to show —
/// which stage of the 09-26 Gmail body-fetch regression actually stalled.
/// `attempt`/`reused`/`connect_ms` come from `checkout`; `select_ms`/
/// `fetch_ms`/`bytes` come from `fetch_email_by_uid_light_timed` through the
/// same lock.
#[async_std::test]
async fn run_read_timed_reports_stage_costs_and_reuse() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push(eml("Hello", "sam@example.com", "A body"))),
    );
    let config = config_for(&server);
    let pool = pool();

    let first = std::sync::Mutex::new(mailvault_core::imap::pool::ReadTimings::default());
    pool.run_read_timed(
        &config,
        true,
        |mut session| {
            let timings = &first;
            async move {
                let r = fetch_email_by_uid_light_timed(&mut session, "INBOX", 1, timings).await?;
                Ok((r, session, Some("INBOX".to_string())))
            }
        },
        Some(&first),
    )
    .await
    .expect("first fetch");

    let t = *first.lock().unwrap();
    assert!(!t.reused, "the first checkout is a brand-new connection");
    assert_eq!(t.attempt, 1);
    assert_eq!(t.idle_secs_since_last_use, 0, "nothing to be idle since on a new connection");
    assert_eq!(t.noop_ms, 0, "a brand-new connection never runs the NOOP health check");
    assert!(t.bytes > 0, "a real message body must be counted");

    // Second call: the session the first call returned is reused.
    let second = std::sync::Mutex::new(mailvault_core::imap::pool::ReadTimings::default());
    pool.run_read_timed(
        &config,
        true,
        |mut session| {
            let timings = &second;
            async move {
                let r = fetch_email_by_uid_light_timed(&mut session, "INBOX", 1, timings).await?;
                Ok((r, session, Some("INBOX".to_string())))
            }
        },
        Some(&second),
    )
    .await
    .expect("second fetch");

    let t = *second.lock().unwrap();
    assert!(t.reused, "the second checkout must reuse the pooled session");
    assert_eq!(t.connect_ms, 0, "no connect happened on a reused session");
    assert_eq!(t.attempt, 1, "the session answered fine, no retry needed");
    assert_eq!(t.noop_ms, 0, "well within NOOP_SKIP_SECS, so the health check itself is skipped");
    assert!(t.bytes > 0);
    assert_eq!(server.connection_count(), 1, "only one TCP connection for both fetches");
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
/// same property `op_journal`'s next-launch replay has always relied on.
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
        delete_email(&mut session, "INBOX", 1, true, true).await?;
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
            delete_email(&mut session, "INBOX", 1, true, true).await?;
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
