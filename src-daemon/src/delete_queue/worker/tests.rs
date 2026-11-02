//! The replay worker: what one pass does with each entry (against the mock
//! IMAP and JMAP servers, or the scripted send), and when passes run (the
//! worker's triggers, on a paused clock with an empty journal: no real I/O).

use super::*;
use crate::delete_queue::tests::{events, fixture, fixture_with, refuse_the_move, script, Fixture};
use crate::message_delete::Refusal;
use crate::message_delete_characterization_tests::RAW;
use crate::oauth_tokens::Read;
use mailvault_core::op_journal::{self, OpEntry};
use mock_imap::state::{Mailbox, Message};
use serde_json::json;
use std::sync::atomic::Ordering::SeqCst;

fn queue(f: &Fixture, account: &str, mailbox: &str, uids: &[u32], arg: Value) -> u64 {
    op_journal::queue_delete(&f.s.app_dir, account, mailbox, uids, &arg).unwrap().id.unwrap()
}

fn sends(f: &Fixture) -> Vec<(u32, bool)> {
    f.s.delete_queue.sends.lock().unwrap().clone()
}

fn entry(f: &Fixture, id: u64) -> Option<OpEntry> {
    op_journal::get(&f.s.app_dir, id).unwrap()
}

fn passes(s: &DaemonState) -> usize {
    s.delete_queue.passes.load(SeqCst)
}

fn lease(id: &str) -> crate::account_workflows::AccountLease {
    crate::account_workflows::AccountLease::detached_for_test(crate::account_workflows::AccountWriteScope { ids: [id.to_owned()].into(), ..Default::default() })
}

// ── policy ─────────────────────────────────────────────────────────────────

#[test]
fn a_pass_runs_twenty_seconds_after_launch_every_five_minutes_and_two_seconds_after_the_link_returns() {
    assert_eq!(TIMING, Timing { launch: Duration::from_secs(20), every: Duration::from_secs(300), debounce: Duration::from_secs(2) });
}

/// The entry's own intent when it has one; an entry the app's old journal
/// wrote (no `mode`) replays as the app's old replay sent it: by the folder
/// (`api.deleteEmail`'s `permanent = mailbox !== 'INBOX'`), with a bin copy.
/// A mode this build does not know is never guessed at.
#[test]
fn a_replay_sends_the_entrys_own_intent_and_a_legacy_entry_by_its_folder() {
    assert_eq!(replay_intent(&json!({})), Some((Mode::Auto, true)), "legacy app entry");
    assert_eq!(replay_intent(&json!({"total": 2, "messages": []})), Some((Mode::Auto, true)), "legacy app entry with Settings' list");
    assert_eq!(replay_intent(&Value::Null), Some((Mode::Auto, true)));
    assert_eq!(replay_intent(&json!({"mode": "trash", "bin": true})), Some((Mode::Trash, true)));
    assert_eq!(replay_intent(&json!({"mode": "permanent", "bin": false})), Some((Mode::Permanent, false)));
    assert_eq!(replay_intent(&json!({"mode": "auto"})), Some((Mode::Auto, true)));
    assert_eq!(replay_intent(&json!({"mode": "shred", "bin": true})), None, "unknown: kept, never sent");
    assert_eq!(replay_intent(&json!({"mode": 3})), None);
}

// ── one pass ───────────────────────────────────────────────────────────────

/// An IMAP entry and a JMAP entry land, an unknown account and a Graph
/// account are dropped: every send on the background lane, every credential
/// read quiet, and the status event says nothing is left.
#[tokio::test]
async fn a_pass_lands_imap_and_jmap_entries_and_drops_entries_no_account_can_send() {
    use crate::jmap_test_support as support;
    let f = fixture_with(vec![], r#"[{"id":"acc1"},{"id":"acct1"},{"id":"ms","oauth2Transport":"graph"}]"#, vec![]);
    let m = mock_jmap::MockJmap::start(support::scenario());
    let (_trap, port) = support::imap_trap();
    f.s.raw_messages.accounts.lock().unwrap().insert("acct1".into(), support::config(&m, port));
    // A listing first: the JMAP ledger issues the uid a delete addresses.
    let listing = crate::server::handle_request_for_test(&f.s, "imap_get_emails", json!({"account": support::account_json(&m, port), "mailbox": "INBOX", "page": 1, "limit": 50}))
        .await
        .result
        .expect("listed");
    let jmap_uid = listing["emails"].as_array().unwrap().iter().find(|e| e["messageId"] == "<e2@x>").unwrap()["uid"].as_u64().unwrap() as u32;

    let imap = queue(&f, "acc1", "INBOX", &[1], json!({})); // the app's old journal: no mode
    let jmap = queue(&f, "acct1", "INBOX", &[jmap_uid], json!({"mode": "auto", "bin": true}));
    let ghost = queue(&f, "ghost", "INBOX", &[7, 8], json!({"mode": "trash", "bin": true}));
    let graph = queue(&f, "ms", "Inbox", &[9], json!({}));
    let mut rx = f.s.events.subscribe();

    let counts = pass(&f.s, "launch").await;

    assert_eq!(counts, PassCounts { attempted: 5, done: 2, failed: 0, dropped: 3, skipped: 0, kept: 0 });
    for id in [imap, jmap, ghost, graph] {
        assert!(entry(&f, id).is_none(), "entry {id} answered");
    }
    assert!(!f.in_inbox(1) && f.in_trash(), "the legacy INBOX entry went to Trash");
    let labels = m.read(|st| st.email("acc1", "e2").map(|e| e.mailbox_ids.clone())).unwrap();
    assert!(labels.contains("mb-trash") && !labels.contains("mb-inbox"), "{labels:?}");
    assert_eq!(sends(&f), vec![(1, false), (jmap_uid, false)], "both on the background lane; nothing sent for ghost or ms");
    assert!(f.s.delete_queue.reads.lock().unwrap().iter().all(|r| *r == Read::Quiet), "never a keychain prompt");

    let seen = events(&mut rx);
    let landed: Vec<&Value> = seen.iter().filter(|(n, _)| n == "delete-queue-landed").map(|(_, p)| p).collect();
    assert_eq!(landed.len(), 2, "{seen:?}");
    assert!(seen.iter().any(|(n, _)| n == "delete-queue-changed"));
    let status: Vec<&Value> = seen.iter().filter(|(n, _)| n == "delete-queue-status").map(|(_, p)| p).collect();
    assert_eq!(status, vec![&json!({"kept": 0, "online": true})]);
    assert_eq!(seen.last().unwrap().0, "delete-queue-status", "after the pass");
}

/// A legacy entry outside INBOX is a permanent delete, as the old replay
/// sent it, with its bin copy kept first.
#[tokio::test]
async fn a_legacy_entry_outside_the_inbox_replays_as_a_permanent_delete() {
    let mut work = Mailbox::new("Work");
    work.add(Message::new(1, RAW));
    let f = fixture_with(vec![], r#"[{"id":"acc1"}]"#, vec![work]);
    let id = queue(&f, "acc1", "Work", &[1], json!({"total": 1}));
    let counts = pass(&f.s, "launch").await;
    assert_eq!((counts.done, counts.kept), (1, 0), "{counts:?}");
    assert!(entry(&f, id).is_none());
    assert!(f.srv.state().find("Work").unwrap().messages.is_empty(), "removed");
    assert!(!f.in_trash(), "not moved: permanent");
    assert_eq!(f.srv.count_commands("BODY.PEEK[]"), 1, "the bin copy was fetched first");
}

#[tokio::test]
async fn an_entry_with_a_mode_this_build_does_not_know_is_kept_unsent() {
    let f = fixture(vec![]);
    let id = queue(&f, "acc1", "INBOX", &[1], json!({"mode": "shred", "bin": true}));
    let counts = pass(&f.s, "retry").await;
    assert_eq!(counts, PassCounts { attempted: 0, done: 0, failed: 0, dropped: 0, skipped: 1, kept: 1 });
    assert_eq!(entry(&f, id).unwrap().attempts, 0);
    assert!(sends(&f).is_empty() && f.in_inbox(1));
}

/// Credentials that will not read quietly (a locked keychain) are no answer:
/// the entry keeps its uid with no round counted and no reason written, and
/// the account's other entries are not tried this pass.
#[tokio::test]
async fn credentials_a_pass_cannot_read_keep_the_entry_unanswered() {
    let f = fixture(vec![]);
    f.s.raw_messages.accounts.lock().unwrap().clear();
    let a = queue(&f, "acc1", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    let b = queue(&f, "acc1", "Work", &[2], json!({"mode": "trash", "bin": true}));
    let counts = pass(&f.s, "launch").await;
    assert_eq!(counts, PassCounts { attempted: 0, done: 0, failed: 0, dropped: 0, skipped: 2, kept: 2 });
    for id in [a, b] {
        let e = entry(&f, id).unwrap();
        assert_eq!(e.attempts, 0, "not an answered attempt");
        assert!(e.failures.is_empty(), "no reason kept");
    }
    assert_eq!(*f.s.delete_queue.reads.lock().unwrap(), vec![Read::Quiet], "one quiet read ended the account's pass");
    assert!(sends(&f).is_empty());
}

/// One round per entry per pass: the worker's next trigger is the retry.
#[tokio::test]
async fn a_refused_replay_counts_one_round_per_pass_and_keeps_its_reason() {
    let f = fixture(refuse_the_move());
    let id = queue(&f, "acc1", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    let counts = pass(&f.s, "retry").await;
    assert_eq!(counts, PassCounts { attempted: 1, done: 0, failed: 1, dropped: 0, skipped: 0, kept: 1 });
    assert_eq!(f.moves(), 1);
    let e = entry(&f, id).unwrap();
    assert_eq!(e.attempts, 1);
    assert!(e.failures[&1].message.contains("refused"), "{}", e.failures[&1].message);
    pass(&f.s, "retry").await;
    assert_eq!((f.moves(), entry(&f, id).unwrap().attempts), (2, 2));
    assert!(f.in_inbox(1));
}

/// Review: a uid a foreground submit is sending right now is left to it.
#[tokio::test]
async fn a_pass_skips_a_uid_a_submit_holds() {
    let f = fixture(vec![]);
    let id = queue(&f, "acc1", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    let (held, ..) = crate::delete_queue::claim(&f.s, "acc1", "INBOX", &[1]);
    let counts = pass(&f.s, "retry").await;
    assert_eq!(counts, PassCounts { attempted: 0, done: 0, failed: 0, dropped: 0, skipped: 1, kept: 1 });
    assert!(sends(&f).is_empty(), "not sent twice at once");
    assert_eq!(entry(&f, id).unwrap().attempts, 0);
    drop(held);
    assert_eq!(pass(&f.s, "retry").await.done, 1, "sent once the submit let go");
}

/// The unit of work is one uid: the UI is waited for before each send, and
/// the journal lock is free while a send is on the wire.
#[tokio::test]
async fn a_pass_yields_to_the_foreground_before_each_uid_and_sends_with_the_journal_unlocked() {
    let f = fixture(vec![]);
    script(&f.s, |state, uid| {
        assert!(state.journal.try_lock().is_ok(), "journal lock held across a send");
        Some(Err(Refusal::Server(format!("refused {uid}"))))
    });
    queue(&f, "acc1", "INBOX", &[1, 2, 3], json!({"mode": "trash", "bin": true}));
    let before = f.s.search_index.foreground_quiet_calls.load(SeqCst);
    let counts = pass(&f.s, "retry").await;
    assert_eq!(counts.failed, 3);
    assert_eq!(f.s.search_index.foreground_quiet_calls.load(SeqCst) - before, 3);
    assert!(sends(&f).iter().all(|(_, priority)| !priority));
}

/// An account being closed (removal, a credential change) ends that
/// account's pass with its entries kept; other accounts go on.
#[tokio::test]
async fn a_closed_account_ends_its_pass_and_keeps_its_entries() {
    let f = fixture_with(vec![], r#"[{"id":"acc1"},{"id":"acc2"}]"#, vec![]);
    let config = f.s.raw_messages.accounts.lock().unwrap()["acc1"].clone();
    f.s.raw_messages.accounts.lock().unwrap().insert("acc2".into(), config);
    script(&f.s, |_, _| Some(Err(Refusal::Server("refused".into()))));
    let closed = queue(&f, "acc1", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    let open = queue(&f, "acc2", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    let _closing = f.s.account_lifecycle.try_close(lease("acc1"), "acc1").unwrap();
    let counts = pass(&f.s, "retry").await;
    assert_eq!(counts, PassCounts { attempted: 1, done: 0, failed: 1, dropped: 0, skipped: 1, kept: 2 });
    assert_eq!(entry(&f, closed).unwrap().attempts, 0, "the closing account was not tried");
    assert_eq!(entry(&f, open).unwrap().attempts, 1);
}

#[tokio::test]
async fn offline_a_pass_sends_nothing_and_the_status_says_so() {
    let f = fixture(vec![]);
    f.s.net.test_set_online(false);
    let id = queue(&f, "acc1", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    let mut rx = f.s.events.subscribe();
    let counts = pass(&f.s, "retry").await;
    assert_eq!(counts, PassCounts { attempted: 0, done: 0, failed: 0, dropped: 0, skipped: 1, kept: 1 });
    assert_eq!(entry(&f, id).unwrap().attempts, 0);
    assert_eq!(f.srv.count_commands("SELECT"), 0);
    let status: Vec<Value> = events(&mut rx).into_iter().filter(|(n, _)| n == "delete-queue-status").map(|(_, p)| p).collect();
    assert_eq!(status, vec![json!({"kept": 1, "online": false})]);
}

#[tokio::test]
async fn the_run_rpc_answers_the_counts_and_a_manual_run_emits_no_status() {
    let f = fixture(vec![]);
    queue(&f, "acc1", "INBOX", &[1], json!({"mode": "trash", "bin": true}));
    queue(&f, "ghost", "INBOX", &[4], json!({}));
    let mut rx = f.s.events.subscribe();
    let r = route(&f.s, "delete_queue.run", &json!({"reason": "manual"}), json!(1)).await.unwrap();
    assert_eq!(r.result.expect("answered"), json!({"attempted": 2, "done": 1, "failed": 0, "dropped": 1, "skipped": 0, "kept": 0}));
    assert!(!events(&mut rx).iter().any(|(n, _)| n == "delete-queue-status"), "the Settings list answers a manual run itself");

    // No reason is a manual run; any other reason reports.
    let r = route(&f.s, "delete_queue.run", &json!({}), json!(2)).await.unwrap();
    assert_eq!(r.result.unwrap()["kept"], 0);
    assert!(!events(&mut rx).iter().any(|(n, _)| n == "delete-queue-status"));
    route(&f.s, "delete_queue.run", &json!({"reason": "launch"}), json!(3)).await.unwrap();
    assert!(events(&mut rx).iter().any(|(n, p)| n == "delete-queue-status" && *p == json!({"kept": 0, "online": true})));
}

// ── triggers ───────────────────────────────────────────────────────────────

fn empty_state() -> Arc<DaemonState> {
    let dir = std::env::temp_dir().join(format!("mv-delete-worker-{}", uuid::Uuid::new_v4()));
    crate::message_delete_characterization_tests::plain_state(&dir)
}

/// Let the worker run up to now on the paused clock: small steps, so a
/// pass's blocking journal read never lets the clock jump far.
async fn wait(d: Duration) {
    let step = Duration::from_millis(100);
    let mut left = d;
    while left > Duration::ZERO {
        let now = left.min(step);
        tokio::time::sleep(now).await;
        left -= now;
    }
}

#[tokio::test(start_paused = true)]
async fn the_worker_passes_after_the_launch_delay_and_then_on_its_tick() {
    let s = empty_state();
    spawn_worker_with(&s, TIMING);
    wait(Duration::from_millis(19_500)).await;
    assert_eq!(passes(&s), 0, "the first paint has the machine to itself");
    wait(Duration::from_secs(1)).await;
    assert_eq!(passes(&s), 1, "20 s after launch");
    wait(Duration::from_secs(298)).await;
    assert_eq!(passes(&s), 1);
    wait(Duration::from_secs(3)).await;
    assert_eq!(passes(&s), 2, "five minutes after the last pass");
}

#[tokio::test(start_paused = true)]
async fn the_link_coming_back_runs_exactly_one_pass_after_the_debounce() {
    let s = empty_state();
    spawn_worker_with(&s, Timing { launch: Duration::from_secs(1), every: Duration::from_secs(3600), debounce: Duration::from_secs(2) });
    wait(Duration::from_secs(2)).await;
    assert_eq!(passes(&s), 1, "launch");
    // A link that drops is not a trigger.
    s.net.test_set_online(false);
    wait(Duration::from_secs(5)).await;
    assert_eq!(passes(&s), 1);
    // It comes back and flaps inside the debounce: one pass, 2 s after the last flip.
    s.net.test_set_online(true);
    wait(Duration::from_millis(500)).await;
    s.net.test_set_online(false);
    s.net.test_set_online(true);
    wait(Duration::from_millis(1_500)).await;
    assert_eq!(passes(&s), 1, "still settling");
    wait(Duration::from_secs(1)).await;
    assert_eq!(passes(&s), 2, "one pass for the transition");
    wait(Duration::from_secs(30)).await;
    assert_eq!(passes(&s), 2, "and only one");
}

/// One pass at a time, whatever starts it; transitions that arrive while a
/// pass runs (or waits for the running one) add one more pass, not one each.
#[tokio::test(start_paused = true)]
async fn passes_never_overlap_and_triggers_during_one_coalesce() {
    let s = empty_state();
    spawn_worker_with(&s, Timing { launch: Duration::from_secs(3600), every: Duration::from_secs(3600), debounce: Duration::from_millis(10) });
    // A pass is running: the test holds its lock.
    let running = s.delete_queue.pass.lock().await;
    s.net.test_set_online(false);
    s.net.test_set_online(true);
    wait(Duration::from_millis(200)).await; // the worker is now waiting for the running pass
    for _ in 0..3 {
        s.net.test_set_online(false);
        s.net.test_set_online(true);
    }
    let manual = {
        let s = Arc::clone(&s);
        tokio::spawn(async move { run_now(&s, MANUAL.to_string()).await })
    };
    wait(Duration::from_millis(200)).await;
    assert_eq!(passes(&s), 0, "nothing starts while a pass runs");
    drop(running);
    wait(Duration::from_secs(1)).await;
    assert!(manual.await.unwrap().is_ok());
    assert_eq!(passes(&s), 3, "the waiting trigger, the manual run, and one for every flip since");
    assert_eq!(s.delete_queue.most_running.load(SeqCst), 1);
    wait(Duration::from_secs(10)).await;
    assert_eq!(passes(&s), 3);
}
