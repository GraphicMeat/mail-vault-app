//! The delete queue against the mock IMAP server, plus a scripted send
//! (`script`) for refusals no mock fault can produce.

use super::*;
use crate::message_delete::Refusal;
use crate::message_delete_characterization_tests::{plain_state, seed_accounts, RAW};
use mailvault_core::custody::cache;
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

// ── the scripted send ───────────────────────────────────────────────────────

/// What a send answers instead of the server, or `None` to send for real.
type Script = Arc<dyn Fn(&DaemonState, u32) -> Option<Result<Outcome, Refusal>> + Send + Sync>;

fn scripts() -> &'static Mutex<HashMap<PathBuf, Script>> {
    static SCRIPTS: OnceLock<Mutex<HashMap<PathBuf, Script>>> = OnceLock::new();
    SCRIPTS.get_or_init(Default::default)
}

pub(crate) fn scripted_send(state: &DaemonState, uid: u32) -> Option<Result<Outcome, Refusal>> {
    let script = scripts().lock().unwrap().get(&state.app_dir).cloned()?;
    script(state, uid)
}

/// Runs between a submit's journal write and its claim.
type Hook = Arc<dyn Fn(&DaemonState) + Send + Sync>;

fn hooks() -> &'static Mutex<HashMap<PathBuf, Hook>> {
    static HOOKS: OnceLock<Mutex<HashMap<PathBuf, Hook>>> = OnceLock::new();
    HOOKS.get_or_init(Default::default)
}

pub(crate) fn after_journal(state: &DaemonState) {
    let hook = hooks().lock().unwrap().get(&state.app_dir).cloned();
    if let Some(hook) = hook {
        hook(state);
    }
}

pub(super) fn script(state: &DaemonState, f: impl Fn(&DaemonState, u32) -> Option<Result<Outcome, Refusal>> + Send + Sync + 'static) {
    scripts().lock().unwrap().insert(state.app_dir.clone(), Arc::new(f));
}

// ── fixture ─────────────────────────────────────────────────────────────────

pub(super) struct Fixture {
    pub(super) srv: MockImap,
    pub(super) s: Arc<DaemonState>,
}

impl Fixture {
    pub(super) fn in_inbox(&self, uid: u32) -> bool {
        self.srv.state().find("INBOX").is_some_and(|m| m.by_uid(uid).is_some())
    }
    pub(super) fn in_trash(&self) -> bool {
        self.srv.state().find("Trash").is_some_and(|m| !m.messages.is_empty())
    }
    pub(super) fn journal(&self) -> Vec<OpEntry> {
        op_journal::read(&self.s.app_dir)
    }
    pub(super) fn moves(&self) -> usize {
        self.srv.count_commands("UID MOVE")
    }
}

/// INBOX holds uid 1 (no local bytes), Trash is empty, account `acc1` is
/// configured, and the header cache has the row a sync leaves.
pub(super) fn fixture(faults: Vec<(Trigger, Action)>) -> Fixture {
    fixture_with(faults, r#"[{"id":"acc1"},{"id":"ms","oauth2Transport":"graph"}]"#, vec![])
}

/// `fixture`, with `accounts` as accounts.json and `extra` mailboxes on the server.
pub(super) fn fixture_with(faults: Vec<(Trigger, Action)>, accounts: &str, extra: Vec<Mailbox>) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let mut scenario = Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"]));
    for mailbox in extra {
        scenario = scenario.mailbox(mailbox);
    }
    for (trigger, action) in faults {
        scenario = scenario.fault(trigger, action);
    }
    let srv = MockImap::start(scenario);
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-queue-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, accounts);
    let config: crate::imap::ImapConfig = serde_json::from_value(account).unwrap();
    s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config);
    let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
    crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
    Fixture { srv, s }
}

fn ask(uids: &[u32], mode: Mode) -> Submit {
    Submit { account_id: "acc1".into(), mailbox: "INBOX".into(), uids: uids.to_vec(), mode, bin: true, arg: json!({}) }
}

/// The move to Trash refused both ways `imap::delete_email` tries it, with
/// nothing run on the server.
pub(super) fn refuse_the_move() -> Vec<(Trigger, Action)> {
    vec![
        (Trigger::on("MOVE"), Action::RefuseWith("NO".into(), "move refused".into())),
        (Trigger::on("COPY"), Action::RefuseWith("NO".into(), "copy refused".into())),
    ]
}

/// Every event `rx` holds now, as `(name, payload)`.
pub(super) fn events(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Ok(line) = rx.try_recv() {
        let v: Value = serde_json::from_str(&line).unwrap();
        out.push((v["params"]["name"].as_str().unwrap_or_default().to_string(), v["params"]["payload"].clone()));
    }
    out
}

// ── policy ─────────────────────────────────────────────────────────────────

#[test]
fn the_retry_schedule_is_one_two_four_eight_sixteen_seconds_and_nothing_under_test() {
    assert_eq!(DELETE_RETRY_SCHEDULE_MS, [1000, 2000, 4000, 8000, 16000]);
    assert_eq!(DELETE_RETRY_MS, [0; 5], "tests do not wait");
}

#[test]
fn classify_reads_each_outcome_once() {
    use crate::handlers::deleted::CaptureFailure;
    let deleted = Outcome { trash: Some("Trash".into()), trash_uid: Some(9), bin_id: Some("b1".into()), gone: false };
    assert_eq!(
        classify(1, &Ok(deleted)),
        Verdict::Landed(Landed::Deleted { uid: 1, trash: Some("Trash".into()), trash_uid: Some(9), bin_id: Some("b1".into()) })
    );
    assert_eq!(classify(2, &Ok(Outcome { gone: true, ..Default::default() })), Verdict::Landed(Landed::Gone { uid: 2 }));
    assert_eq!(
        classify(3, &Err(Refusal::Server("errors.bulkIdentityChanged".into()))),
        Verdict::Drop("errors.bulkIdentityChanged".into()),
        "an identity change is the only final refusal"
    );
    match classify(4, &Err(Refusal::BinCapture(CaptureFailure::Fetch("NO fetch failed".into())))) {
        Verdict::Retry(reason) => assert!(reason.starts_with("E_BIN_CAPTURE:fetch"), "{reason}"),
        other => panic!("a required capture that failed is retried, not {other:?}"),
    }
    assert_eq!(classify(5, &Err(Refusal::BinCapture(CaptureFailure::Busy))), Verdict::Retry(CaptureFailure::Busy.wire()));
    assert_eq!(classify(6, &Err(Refusal::Server("errors.keychainBusy".into()))), Verdict::Retry("errors.keychainBusy".into()));
    assert_eq!(classify(7, &Err(Refusal::Server("connection lost".into()))), Verdict::Retry("connection lost".into()));
}

#[test]
fn the_landed_event_names_each_kind() {
    let landed = vec![
        Landed::Deleted { uid: 1, trash: Some("Trash".into()), trash_uid: Some(4), bin_id: None },
        Landed::Gone { uid: 2 },
    ];
    assert_eq!(
        serde_json::to_value(&landed).unwrap(),
        json!([{"kind": "deleted", "uid": 1, "trash": "Trash", "trashUid": 4, "binId": null}, {"kind": "gone", "uid": 2}])
    );
}

// ── submit ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_journal_holds_the_delete_before_the_first_send() {
    let f = fixture(vec![]);
    let seen: Arc<Mutex<Vec<Vec<u32>>>> = Arc::default();
    let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
    {
        let (seen, first) = (Arc::clone(&seen), Arc::clone(&first));
        script(&f.s, move |state, _uid| {
            seen.lock().unwrap().push(op_journal::read(&state.app_dir).iter().flat_map(|e| e.uids.clone()).collect());
            // The first send fails; the retry goes to the server.
            first.swap(false, std::sync::atomic::Ordering::SeqCst).then(|| Err(Refusal::Server("connection lost".into())))
        });
    }
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(seen.lock().unwrap()[0], vec![1], "the uid was owed before anything was sent");
    assert!(matches!(reply.landed.as_slice(), [Landed::Deleted { uid: 1, .. }]), "{reply:?}");
    assert!(f.journal().is_empty());
}

#[tokio::test]
async fn the_entry_is_written_while_the_server_has_not_answered_yet() {
    let f = fixture(vec![(Trigger::on("SELECT"), Action::Delay(Duration::from_millis(800)))]);
    let s = Arc::clone(&f.s);
    let running = tokio::spawn(async move { submit(&s, ask(&[1], Mode::Trash)).await });
    let mut owed = Vec::new();
    for _ in 0..50 {
        owed = f.journal();
        if !owed.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(owed.len(), 1, "journalled first");
    assert_eq!(owed[0].uids, vec![1]);
    assert_eq!(owed[0].arg, json!({"mode": "trash", "bin": true}), "the delete's intent is kept for a replay");
    assert_eq!(f.moves(), 0, "nothing reached the server yet");
    let reply = running.await.unwrap().unwrap();
    assert_eq!(reply.queued, Vec::<u32>::new());
    assert!(f.journal().is_empty());
}

/// Review Focus 7: the daemon dies between the journal write and the send.
/// Dropping `run` mid-send stands in for the kill: the entry and its uid
/// survive for the next launch's replay, and the claim is released.
#[tokio::test]
async fn a_daemon_killed_before_the_send_landed_leaves_the_entry_owed() {
    let f = fixture(vec![(Trigger::on("SELECT"), Action::Delay(Duration::from_secs(2)))]);
    let killed = tokio::time::timeout(Duration::from_millis(400), run(&f.s, ask(&[1], Mode::Trash))).await;
    assert!(killed.is_err(), "still waiting on the server when it was stopped");
    let owed = f.journal();
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].uids, vec![1]);
    assert_eq!(owed[0].attempts, 1, "the round it died in is counted");
    assert_eq!(f.s.delete_queue.held(), 0, "the claim went with the task");
    assert!(f.in_inbox(1));
}

#[tokio::test]
async fn a_send_refused_through_every_round_stays_queued_with_its_reason() {
    let f = fixture(refuse_the_move());
    let mut rx = f.s.events.subscribe();
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    let [(1, why)] = reply.refused.as_slice() else { panic!("the refusal is named: {reply:?}") };
    assert!(why.contains("refused"), "{why}");
    assert_eq!(reply, SubmitReply { landed: vec![], queued: vec![1], refused: vec![(1, why.clone())], dropped: vec![] });
    assert_eq!(f.moves(), 6, "one send and five retries");
    let owed = f.journal();
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].uids, vec![1]);
    assert_eq!(owed[0].attempts, 6);
    let reason = &owed[0].failures[&1].message;
    assert!(reason.contains("refused"), "{reason}");
    assert!(f.in_inbox(1));
    let names: Vec<String> = events(&mut rx).into_iter().map(|(n, _)| n).collect();
    assert!(names.iter().any(|n| n == "delete-queue-changed"), "{names:?}");
    assert!(!names.iter().any(|n| n == "delete-queue-landed"), "{names:?}");

    // `delete_queue.list` answers what the queue learned.
    let listed = route(&f.s, "delete_queue.list", &json!({}), json!(1)).await.unwrap().result.unwrap();
    assert_eq!(listed[0]["attempts"], 6);
    assert!(listed[0]["failures"]["1"]["message"].as_str().unwrap().contains("refused"));
}

#[tokio::test]
async fn a_send_that_lands_clears_the_uid_and_names_where_it_went() {
    let f = fixture(vec![]);
    let mut rx = f.s.events.subscribe();
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    let [Landed::Deleted { uid: 1, trash, trash_uid, bin_id }] = reply.landed.as_slice() else { panic!("{reply:?}") };
    assert_eq!(trash.as_deref(), Some("Trash"));
    assert!(trash_uid.is_some(), "the mock reports COPYUID");
    assert!(bin_id.is_some(), "a move to Trash keeps a byte-less bin row");
    assert!(reply.queued.is_empty() && reply.dropped.is_empty());
    assert!(f.journal().is_empty(), "answered");
    assert!(!f.in_inbox(1) && f.in_trash());
    // The local bookkeeping ran: the header cache no longer lists it.
    let cached = crate::custody::with_conn(&f.s, |c| cache::load_by_uids(c, "acc1", "INBOX", &[1])).unwrap();
    assert!(cached.is_empty(), "{cached:?}");
    let seen = events(&mut rx);
    let at = seen.iter().position(|(n, _)| n == "delete-queue-landed").expect("landed");
    assert!(seen[at + 1..].iter().any(|(n, _)| n == "delete-queue-changed"), "a landing changes the queue too: {seen:?}");
    let landed: Vec<Value> = seen.into_iter().filter(|(n, _)| n == "delete-queue-landed").map(|(_, p)| p).collect();
    assert_eq!(landed.len(), 1);
    assert_eq!(landed[0]["accountId"], "acc1");
    assert_eq!(landed[0]["mailbox"], "INBOX");
    assert_eq!(landed[0]["landed"][0]["kind"], "deleted");
    assert_eq!(landed[0]["landed"][0]["trash"], "Trash");
}

#[tokio::test]
async fn a_message_already_gone_lands_as_gone() {
    let f = fixture(vec![]);
    // uid 5 is not on the server: the permanent delete's capture asks and finds nothing.
    let reply = submit(&f.s, ask(&[5], Mode::Permanent)).await.unwrap();
    assert_eq!(reply, SubmitReply { landed: vec![Landed::Gone { uid: 5 }], ..Default::default() });
    assert!(f.journal().is_empty());
    assert!(f.in_inbox(1), "nothing else touched");
}

#[tokio::test]
async fn offline_nothing_is_sent_and_everything_is_queued() {
    let f = fixture(vec![]);
    f.s.net.test_set_online(false);
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(reply, SubmitReply { queued: vec![1], ..Default::default() }, "offline: owed, nothing refused");
    assert_eq!(f.srv.count_commands("SELECT"), 0, "no send");
    let owed = f.journal();
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].attempts, 0, "no round was sent");
    assert!(f.in_inbox(1));
}

/// Review Focus 8: two submits of one uid at once send it once.
#[tokio::test]
async fn two_submits_of_one_uid_at_once_send_it_once() {
    let f = fixture(vec![(Trigger::on("SELECT"), Action::Delay(Duration::from_millis(300)))]);
    let (a, b) = tokio::join!(submit(&f.s, ask(&[1], Mode::Trash)), submit(&f.s, ask(&[1], Mode::Trash)));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(f.moves(), 1, "one send");
    let landed = a.landed.len() + b.landed.len();
    let queued = a.queued.len() + b.queued.len();
    assert_eq!((landed, queued), (1, 1), "one sent it, the other left it to the first: {a:?} {b:?}");
    assert!(f.journal().is_empty(), "no second entry is left to replay");
}

#[tokio::test]
async fn a_second_submit_of_an_owed_uid_writes_no_second_entry() {
    let f = fixture(vec![]);
    f.s.net.test_set_online(false);
    submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(f.journal().len(), 1);
}

#[tokio::test]
async fn an_identity_change_is_dropped_and_its_uid_cleared() {
    let f = fixture(vec![]);
    let sends = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let sends = Arc::clone(&sends);
        script(&f.s, move |_, _| {
            sends.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(Err(Refusal::Server("errors.bulkIdentityChanged".into())))
        });
    }
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(reply, SubmitReply { dropped: vec![(1, "errors.bulkIdentityChanged".into())], ..Default::default() });
    assert_eq!(sends.load(std::sync::atomic::Ordering::SeqCst), 1, "never retried");
    assert!(f.journal().is_empty());
}

#[tokio::test]
async fn a_required_capture_that_fails_stays_queued_not_dropped() {
    let f = fixture(vec![(Trigger::with("FETCH", "BODY.PEEK[]"), Action::RefuseWith("NO".into(), "fetch failed".into()))]);
    let reply = submit(&f.s, ask(&[1], Mode::Permanent)).await.unwrap();
    let owed = f.journal();
    assert_eq!(reply, SubmitReply { queued: vec![1], refused: vec![(1, owed[0].failures[&1].message.clone())], ..Default::default() });
    assert_eq!(owed[0].attempts, 6);
    assert!(owed[0].failures[&1].message.starts_with("E_BIN_CAPTURE:fetch"), "{}", owed[0].failures[&1].message);
    assert!(f.in_inbox(1), "no copy, no delete");
    assert_eq!(f.srv.count_commands("STORE"), 0);
}

#[tokio::test]
async fn credentials_that_cannot_be_read_keep_the_entry() {
    let f = fixture(vec![]);
    f.s.raw_messages.accounts.lock().unwrap().clear();
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(reply.queued, vec![1]);
    let owed = f.journal();
    assert_eq!(owed[0].attempts, 6);
    assert!(!owed[0].failures[&1].message.is_empty());
}

#[tokio::test]
async fn a_cancel_while_the_entry_is_retried_stops_its_sends() {
    let f = fixture(vec![]);
    let sends = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let sends = Arc::clone(&sends);
        script(&f.s, move |state, uid| {
            sends.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // The user cancels in Settings while this send is on the wire.
            let id = op_journal::read(&state.app_dir)[0].id;
            assert!(cancel(state, id, &[uid]).unwrap());
            Some(Err(Refusal::Server("connection lost".into())))
        });
    }
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(sends.load(std::sync::atomic::Ordering::SeqCst), 1, "not retried once cancelled");
    assert_eq!(reply, SubmitReply { dropped: vec![(1, "cancelled".into())], ..Default::default() });
    assert!(f.journal().is_empty(), "the failure did not bring it back");
    assert_eq!(f.s.delete_queue.held(), 0);
    assert!(f.s.delete_queue.lock().cancelled.is_empty(), "the cancel mark went with the claim");
}

/// Review fix 2: B adopts a uid A's entry owes, A lands and clears it before
/// B claims it. B must not call that a refusal: the message is gone from the
/// server, and `dropped` would have the app put its row back.
#[tokio::test]
async fn a_uid_another_submit_answered_is_never_reported_dropped() {
    let f = fixture(vec![]);
    let a = op_journal::queue_delete(&f.s.app_dir, "acc1", "INBOX", &[1], &json!({"mode": "trash", "bin": true})).unwrap().id.unwrap();
    hooks().lock().unwrap().insert(
        f.s.app_dir.clone(),
        Arc::new(move |state: &DaemonState| {
            // A lands uid 1 and clears it, between B's journal write and B's claim.
            op_journal::clear_by_id(&state.app_dir, a, &[1]).unwrap();
        }),
    );
    let reply = submit(&f.s, ask(&[1], Mode::Trash)).await.unwrap();
    assert_eq!(reply, SubmitReply { queued: vec![1], ..Default::default() }, "left to the submit that answered it, never refused");
    assert_eq!(f.moves(), 0, "not sent again");
    assert!(f.in_inbox(1), "nothing touched (A's landing is simulated)");
}

/// Review fix 1: a round of N refused uids writes the journal once per
/// entry (one attempt, one batch of reasons), not once per uid.
#[tokio::test]
async fn a_round_of_many_refusals_writes_the_journal_once_per_entry() {
    let f = fixture(vec![]);
    script(&f.s, |_, uid| Some(Err(Refusal::Server(format!("refused {uid}")))));
    let uids: Vec<u32> = (1..=20).collect();
    let reply = submit(&f.s, ask(&uids, Mode::Trash)).await.unwrap();
    assert_eq!(reply.queued.len(), 20);
    let writes = f.s.delete_queue.journal_writes.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(writes, 6 * 2, "per round: one attempt and one batch of reasons for the one entry");
    let owed = f.journal();
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].attempts, 6);
    assert_eq!(owed[0].failures.len(), 20);
    assert_eq!(owed[0].failures[&13].message, "refused 13");
}

#[tokio::test]
async fn a_folder_whose_local_marker_will_not_read_is_refused() {
    let f = fixture(vec![]);
    let root = crate::handlers::common::vault_root(&f.s).unwrap();
    let account_dir = mailvault_core::vault_files::account_dir(&root.join("Maildir"), &crate::handlers::common::sanitize_mailbox_name("acc1"));
    std::fs::create_dir_all(&account_dir).unwrap();
    // A regular file where the folder's directory belongs: unreadable as a folder.
    std::fs::write(account_dir.join(mailvault_core::search_index::text::vault_dir_name("Broken")), b"x").unwrap();
    let broken = Submit { mailbox: "Broken".into(), ..ask(&[1], Mode::Trash) };
    assert_eq!(submit(&f.s, broken).await, Err("errors.bulkLocalFoldersRead".to_string()));
    assert!(f.journal().is_empty());
    assert_eq!(f.srv.count_commands("SELECT"), 0);
}

#[tokio::test]
async fn an_unreachable_vault_does_not_hold_up_a_server_delete() {
    let dir = std::env::temp_dir().join(format!("mv-delete-queue-novault-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let s = DaemonState::for_test(dir.join("vault"), dir.clone(), false);
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    assert_eq!(refuse_unqueued(&s, "acc1", "INBOX").await, Ok(()));
}

#[test]
fn an_accounts_list_that_will_not_read_answers_a_catalog_key() {
    let unreadable = Err(mailvault_core::accounts_doc::AccountsError::Io("disk on fire".into()));
    assert_eq!(admit(unreadable, "acc1"), Err("errors.bulkAccountUnavailable".to_string()));
}

#[tokio::test]
async fn cancel_clears_by_id_and_says_so() {
    let f = fixture(vec![]);
    f.s.net.test_set_online(false);
    submit(&f.s, ask(&[1, 2], Mode::Trash)).await.unwrap();
    let id = f.journal()[0].id;
    let mut rx = f.s.events.subscribe();
    let r = route(&f.s, "delete_queue.cancel", &json!({"id": id, "uids": [1]}), json!(1)).await.unwrap();
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(f.journal()[0].uids, vec![2]);
    assert!(events(&mut rx).iter().any(|(n, _)| n == "delete-queue-changed"));
    route(&f.s, "delete_queue.cancel", &json!({"id": id, "uids": [2]}), json!(1)).await.unwrap();
    assert!(f.journal().is_empty());
    // An entry already gone is not an error.
    let again = route(&f.s, "delete_queue.cancel", &json!({"id": id, "uids": [2]}), json!(1)).await.unwrap();
    assert!(again.error.is_none());
}

#[tokio::test]
async fn graph_unknown_accounts_and_local_folders_are_never_journalled() {
    let f = fixture(vec![]);
    let graph = Submit { account_id: "ms".into(), ..ask(&[1], Mode::Trash) };
    assert_eq!(submit(&f.s, graph).await, Err("errors.bulkGraphDeleteUnsupported".to_string()));
    let unknown = Submit { account_id: "nobody".into(), ..ask(&[1], Mode::Trash) };
    assert_eq!(submit(&f.s, unknown).await, Err("errors.bulkAccountUnavailable".to_string()));

    let root = crate::handlers::common::vault_root(&f.s).unwrap();
    let account_dir = mailvault_core::vault_files::account_dir(&root.join("Maildir"), &crate::handlers::common::sanitize_mailbox_name("acc1"));
    let (marker, _dir) = mailvault_core::local_folder::create_import_folder(&account_dir, "2026-01-01", "old.mbox", 1).unwrap();
    let local = Submit { mailbox: marker.name, ..ask(&[1], Mode::Trash) };
    assert_eq!(submit(&f.s, local).await, Err("errors.bulkUnsupported".to_string()));

    assert!(f.journal().is_empty(), "nothing journalled");
    assert_eq!(f.srv.count_commands("SELECT"), 0, "nothing sent");
}

#[tokio::test]
async fn the_submit_rpc_reads_its_params_and_answers_the_reply() {
    let f = fixture(vec![]);
    let r = route(&f.s, "delete_queue.submit", &json!({"accountId": "acc1", "mailbox": "INBOX", "uids": [1], "mode": "auto", "arg": {"total": 1}}), json!(1))
        .await
        .unwrap();
    let out = r.result.expect("answered");
    assert_eq!(out["landed"][0]["kind"], "deleted");
    assert_eq!(out["landed"][0]["uid"], 1);
    assert_eq!(out["queued"], json!([]));
    assert_eq!(out["refused"], json!([]));
    assert_eq!(out["dropped"], json!([]));
    let bad = route(&f.s, "delete_queue.submit", &json!({"accountId": "acc1", "mailbox": "INBOX", "uids": [1], "mode": "shred"}), json!(1)).await.unwrap();
    assert_eq!(bad.error.unwrap().code, ipc::INVALID_PARAMS);
}

/// Final review, Important 1: a uid refused through every round is answered
/// `queued` AND named in `refused` with its last reason, so the app can say
/// why the row went away while it is still owed. Offline (nothing was sent)
/// names nothing.
#[tokio::test]
async fn a_refused_submit_names_each_still_owed_uid_with_its_last_reason() {
    let f = fixture(vec![(Trigger::with("FETCH", "BODY.PEEK[]"), Action::RefuseWith("NO".into(), "fetch failed".into()))]);
    let r = route(&f.s, "delete_queue.submit", &json!({"accountId": "acc1", "mailbox": "INBOX", "uids": [1], "mode": "permanent"}), json!(1)).await.unwrap();
    let out = r.result.expect("answered");
    assert_eq!(out["queued"], json!([1]), "still owed, as before");
    let refused = out["refused"].as_array().unwrap_or_else(|| panic!("no refused field: {out}"));
    assert_eq!(refused.len(), 1, "{out}");
    assert_eq!(refused[0]["uid"], 1);
    let reason = refused[0]["reason"].as_str().unwrap();
    assert!(reason.starts_with("E_BIN_CAPTURE:fetch: "), "{reason}");
    assert_eq!(f.journal()[0].failures[&1].message, reason, "the same reason the entry keeps");

    let off = fixture(vec![]);
    off.s.net.test_set_online(false);
    let r = route(&off.s, "delete_queue.submit", &json!({"accountId": "acc1", "mailbox": "INBOX", "uids": [1], "mode": "trash"}), json!(1)).await.unwrap();
    let out = r.result.expect("answered");
    assert_eq!(out["queued"], json!([1]));
    assert_eq!(out["refused"], json!([]), "offline nothing was refused");
}
