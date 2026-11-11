//! `delete_one` and its policy, against the mock IMAP server. The wire-level
//! matrix per provider is `message_delete_characterization_tests`.

use super::*;
use crate::handlers::common::with_mailbox_write;
use crate::handlers::deleted::{self, Source};
use crate::message_delete_characterization_tests::{bin_rows, break_the_bin, plain_state, seed_accounts, RAW};
use crate::test_support::handle_request_for_test;
use mailvault_core::custody::cache;
use mailvault_core::vault_files;
use mock_imap::state::{GmailMsg, Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::json;

// ── policy ────────────────────────────────────────────────────────────────

#[test]
fn capture_policy_truth_table() {
    use CapturePolicy::*;
    for (mode, bin, want) in [
        (Mode::Trash, false, Skip),
        (Mode::Trash, true, BestEffort),
        (Mode::Permanent, false, Skip),
        (Mode::Permanent, true, Required),
        // Unresolved `Auto` may be permanent: the safe side.
        (Mode::Auto, false, Skip),
        (Mode::Auto, true, Required),
    ] {
        assert_eq!(capture_policy(mode, bin), want, "{mode:?} bin={bin}");
    }
}

/// Core's delete rule (owner decision 1): outside Trash a move, inside
/// Trash permanent. An account with no Trash keeps desktop's old rule
/// (ruling P6): INBOX moves, any other folder is permanent.
#[test]
fn auto_follows_the_core_delete_rule() {
    use TrashPlace::*;
    for folder in ["INBOX", "Inbox", "Sent", "Archive", "Spam", "[Gmail]/All Mail", "Clients/Acme"] {
        assert_eq!(Mode::Auto.by_rule(folder, Elsewhere), Mode::Trash, "{folder} outside Trash is a move");
    }
    assert_eq!(Mode::Auto.by_rule("Trash", ThisFolder), Mode::Permanent, "in Trash, permanent");
    assert_eq!(Mode::Auto.by_rule("INBOX", Missing), Mode::Trash, "P6: INBOX still moves");
    assert_eq!(Mode::Auto.by_rule("Inbox", Missing), Mode::Trash, "INBOX is case-insensitive (RFC 3501)");
    assert_eq!(Mode::Auto.by_rule("Sent", Missing), Mode::Permanent, "P6: no Trash, permanent as before");
    assert_eq!(Mode::Auto.by_rule("Archive", Missing), Mode::Permanent);
    // Only Auto resolves.
    assert_eq!(Mode::Trash.by_rule("Trash", ThisFolder), Mode::Trash);
    assert_eq!(Mode::Permanent.by_rule("INBOX", Elsewhere), Mode::Permanent);
}

#[test]
fn mode_reads_the_mode_param_and_nothing_else() {
    let read = |v: Value| Mode::from_params(&v);
    assert_eq!(read(json!({"mode": "auto"})), Ok(Mode::Auto));
    assert_eq!(read(json!({"mode": "trash"})), Ok(Mode::Trash));
    assert_eq!(read(json!({"mode": "permanent"})), Ok(Mode::Permanent));
    // No stated intent never destroys mail: absent is a move to Trash, in
    // every folder.
    assert_eq!(read(json!({})), Ok(Mode::Trash), "absent is a move to Trash");
    assert_eq!(read(json!({"mode": null})), Ok(Mode::Trash));
    // The legacy `permanent` flag is gone: the app sends intent, not policy.
    assert_eq!(read(json!({"permanent": true})), Ok(Mode::Trash), "a legacy flag is not read");
    assert_eq!(read(json!({"permanent": false})), Ok(Mode::Trash));
    assert_eq!(read(json!({"mode": "trash", "permanent": true})), Ok(Mode::Trash));
    assert!(read(json!({"mode": "shred"})).is_err());
    assert!(read(json!({"mode": true})).is_err());
}

/// The JMAP body-fetch timeout is read back by its text: the helper that
/// builds it is the one `CaptureFailure::read` recognises, and the uid and
/// folder stay in the detail for the log.
#[test]
fn the_body_fetch_timeout_text_reads_back_as_a_timeout() {
    let text = crate::handlers::imap::body_fetch_timed_out(3, "INBOX");
    let e = CaptureFailure::read(text);
    assert_eq!(e.reason(), "timeout");
    assert!(e.detail().contains("UID 3 from INBOX"), "{}", e.detail());
    assert!(e.wire().starts_with("E_BIN_CAPTURE:timeout: "), "{}", e.wire());
    // The ceiling text with no message named (the capture's own fetch, a bin
    // recover's read) is the one other builder, read back the same way.
    let bare = CaptureFailure::read(crate::handlers::imap::body_fetch_ceiling_text());
    assert_eq!(bare.reason(), "timeout");
    assert_eq!(crate::handlers::imap::body_fetch_ceiling_text(), "timed out after 45s");
    assert_eq!(CaptureFailure::Timeout(None).detail(), "timed out after 45s");
}

// ── delete_one over IMAP ───────────────────────────────────────────────────

struct Fixture {
    srv: MockImap,
    s: Arc<DaemonState>,
    config: ImapConfig,
    account: Value,
}

impl Fixture {
    fn in_inbox(&self) -> bool {
        self.srv.state().find("INBOX").is_some_and(|m| m.by_uid(1).is_some())
    }
    fn in_trash(&self) -> bool {
        self.srv.state().find("Trash").is_some_and(|m| !m.messages.is_empty())
    }
    async fn delete(&self, mode: Mode, bin: bool) -> Result<Outcome, Refusal> {
        delete_one(&self.s, Provider::Imap(&self.config), "acc1", "INBOX", 1, mode, bin).await
    }
}

/// INBOX holds uid 1 (no local bytes), Trash is empty, and the header cache
/// has the row a sync leaves (its Message-ID is what a byte-less capture keeps).
fn fixture(faults: Vec<(Trigger, Action)>) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let mut scenario = Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"]));
    for (trigger, action) in faults {
        scenario = scenario.fault(trigger, action);
    }
    let srv = MockImap::start(scenario);
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-core-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    let config: ImapConfig = serde_json::from_value(account.clone()).unwrap();
    s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config.clone());
    let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
    crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
    Fixture { srv, s, config, account }
}

/// The move to Trash refused, both ways `imap::delete_email` tries it, with
/// nothing run on the server.
fn refuse_the_move() -> Vec<(Trigger, Action)> {
    vec![
        (Trigger::on("MOVE"), Action::RefuseWith("NO".into(), "move refused".into())),
        (Trigger::on("COPY"), Action::RefuseWith("NO".into(), "copy refused".into())),
    ]
}

#[tokio::test]
async fn a_capture_that_fails_under_required_refuses_the_delete() {
    let f = fixture(vec![(Trigger::with("FETCH", "BODY.PEEK[]"), Action::RefuseWith("NO".into(), "fetch refused".into()))]);
    let r = f.delete(Mode::Permanent, true).await;
    assert!(matches!(&r, Err(Refusal::BinCapture(CaptureFailure::Fetch(_)))), "{r:?}");
    assert!(f.in_inbox() && !f.in_trash(), "nothing was removed");
    assert!(bin_rows(&f.s).is_empty());
}

#[tokio::test]
async fn auto_in_inbox_is_a_move_and_needs_no_fetch() {
    // Auto in INBOX is a move to Trash: the failing full fetch is never asked.
    let f = fixture(vec![(Trigger::with("FETCH", "BODY.PEEK[]"), Action::RefuseWith("NO".into(), "fetch refused".into()))]);
    let r = delete_one(&f.s, Provider::Imap(&f.config), "acc1", "INBOX", 1, Mode::Auto, true).await;
    assert!(r.is_ok(), "Auto in INBOX is a move to Trash, no fetch needed: {r:?}");
}

#[tokio::test]
async fn a_capture_that_fails_under_best_effort_goes_ahead() {
    let f = fixture(vec![]);
    // Bytes are local, so the capture writes a file, and the bin cannot be written.
    with_mailbox_write(&f.s, "acc1", "INBOX", |root| vault_files::store(&f.s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
    break_the_bin(&f.s.app_dir);
    let out = f.delete(Mode::Trash, true).await.expect("a move to Trash goes ahead without its bin copy");
    assert_eq!(out.trash.as_deref(), Some("Trash"));
    assert_eq!(out.bin_id, None);
    assert!(!f.in_inbox() && f.in_trash());
}

#[tokio::test]
async fn a_failed_remove_forgets_the_capture_this_call_made() {
    // Control: the same delete, its move succeeding, leaves one bin row, so an
    // empty bin below means a capture was made and then dropped, not that
    // none was ever made.
    let kept = fixture(vec![]);
    kept.delete(Mode::Trash, true).await.expect("deleted");
    assert_eq!(bin_rows(&kept.s).len(), 1, "a delete that happens keeps its capture");
    let f = fixture(refuse_the_move());
    let r = f.delete(Mode::Trash, true).await;
    assert!(matches!(&r, Err(Refusal::Server(_))), "{r:?}");
    assert!(f.in_inbox(), "the message stays");
    assert!(bin_rows(&f.s).is_empty(), "the capture of a delete that did not happen is dropped");
}

#[tokio::test]
async fn a_failed_remove_keeps_a_capture_an_earlier_attempt_made() {
    let f = fixture(refuse_the_move());
    let stamp = f.s.account_lifecycle.capture("acc1").unwrap();
    let (earlier, created) = deleted::capture_stamped(&f.s, stamp, "acc1", "INBOX", 1, Source::Imap { config: &f.config, permanent: false, priority: true, generation: None })
        .await
        .expect("captured")
        .expect("a row");
    assert!(created);
    let r = f.delete(Mode::Trash, true).await;
    assert!(matches!(&r, Err(Refusal::Server(_))), "{r:?}");
    let rows = bin_rows(&f.s);
    assert_eq!(rows.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec![earlier.as_str()], "the earlier attempt's row stays");
}

/// A permanent delete keeps its capture when the remove fails: its EXPUNGE may
/// have landed with the reply lost, and the retry finds nothing to capture.
#[tokio::test]
async fn a_failed_permanent_remove_keeps_its_capture() {
    let f = fixture(vec![(Trigger::on("STORE"), Action::RefuseWith("NO".into(), "store refused".into()))]);
    let r = f.delete(Mode::Permanent, true).await;
    assert!(matches!(&r, Err(Refusal::Server(_))), "{r:?}");
    let rows = bin_rows(&f.s);
    assert_eq!(rows.len(), 1, "kept for the retry");
    assert!(rows[0].has_eml);
}

#[tokio::test]
async fn a_landed_delete_names_its_bin_copy_and_where_it_went() {
    let f = fixture(vec![]);
    let out = f.delete(Mode::Trash, true).await.expect("deleted");
    assert_eq!(out.trash.as_deref(), Some("Trash"));
    let rows = bin_rows(&f.s);
    assert_eq!(rows.len(), 1);
    assert_eq!(out.bin_id.as_deref(), Some(rows[0].id.as_str()));
    assert_eq!(rows[0].trash.as_deref(), Some("Trash"), "landed recorded the Trash folder");
}

// ── the wire ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn imap_delete_email_ignores_a_legacy_permanent_flag() {
    let f = fixture(vec![]);
    let r = handle_request_for_test(&f.s, "imap_delete_email", json!({"account": f.account, "uid": 1, "mailbox": "INBOX", "mode": "trash", "permanent": true})).await;
    let v = r.result.unwrap_or_else(|| panic!("{:?}", r.error.map(|e| e.message)));
    assert_eq!(v["trash"], json!("Trash"), "mode trash wins over permanent: {v}");
    assert!(f.in_trash());
}

/// No `mode`, a stale `permanent: true`, from a folder outside INBOX: still
/// a move to Trash. A caller that has not caught up
/// cannot destroy mail.
#[tokio::test]
async fn imap_delete_email_without_a_mode_is_a_move_to_trash_whatever_a_stale_flag_says() {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mut work = Mailbox::new("Work");
    work.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let srv = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(work).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])));
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-core-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    let r = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": 1, "mailbox": "Work", "permanent": true, "bin": false})).await;
    let v = r.result.unwrap_or_else(|| panic!("{:?}", r.error.map(|e| e.message)));
    assert_eq!(v["trash"], json!("Trash"), "{v}");
    assert!(srv.state().find("Work").unwrap().messages.is_empty(), "left Work");
    assert!(!srv.state().find("Trash").unwrap().messages.is_empty(), "landed in Trash");
    // Only `mode: permanent` deletes for good outside Trash.
    let mut work = Mailbox::new("Work");
    work.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let srv = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(work).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])));
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let r = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": 1, "mailbox": "Work", "mode": "permanent", "bin": false})).await;
    let v = r.result.unwrap_or_else(|| panic!("{:?}", r.error.map(|e| e.message)));
    assert_eq!(v["trash"], json!(null), "permanent from Work: {v}");
    assert!(srv.state().find("Trash").unwrap().messages.is_empty(), "nothing in Trash");
}

// ── the delete rule on the wire (owner decision 1, ruling P6) ──────────────

/// One message (uid 1) in `folder`, beside INBOX, and a `\Trash` folder
/// named `trash` when there is one. The mock advertises no other folder.
fn rule_scenario(folder: &str, trash: Option<&str>) -> Scenario {
    let mut source = Mailbox::new(folder);
    if Some(folder) == trash {
        source = source.with_attrs(&["\\Trash"]);
    }
    source.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let mut scenario = Scenario::new().mailbox(source);
    if folder != "INBOX" {
        scenario = scenario.mailbox(Mailbox::new("INBOX"));
    }
    if let Some(t) = trash.filter(|t| *t != folder) {
        scenario = scenario.mailbox(Mailbox::new(t).with_attrs(&["\\Trash"]));
    }
    scenario
}

/// A daemon with account `acc1` on `srv`, and the list row a sync leaves for
/// uid 1 of `folder`.
fn rule_state(srv: &MockImap, folder: &str) -> (Arc<DaemonState>, ImapConfig) {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-rule-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    let config: ImapConfig = serde_json::from_value(account).unwrap();
    s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config.clone());
    let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
    crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", folder, &headers)).unwrap();
    (s, config)
}

fn rule_server(folder: &str, trash: Option<&str>) -> (MockImap, Arc<DaemonState>, ImapConfig) {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let srv = MockImap::start(rule_scenario(folder, trash));
    let (s, config) = rule_state(&srv, folder);
    (srv, s, config)
}

#[tokio::test]
async fn a_dropped_trash_lookup_is_retried_and_the_delete_lands() {
    let srv = MockImap::start(
        rule_scenario("Sent", Some("Trash"))
            .fault(Trigger::nth("LIST", 1), Action::DropConnection),
    );
    let (s, config) = rule_state(&srv, "Sent");
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "Sent", 1, Mode::Auto, true)
        .await
        .expect("the delete retries after a dropped Trash lookup");
    assert_eq!(out.trash.as_deref(), Some("Trash"));
    assert!(srv.state().find("Sent").unwrap().messages.is_empty());
    assert_eq!(srv.state().find("Trash").unwrap().messages.len(), 1);
    assert_eq!(bin_rows(&s).len(), 1);
}

#[tokio::test]
async fn a_dropped_list_inside_the_move_is_retried_and_the_delete_lands() {
    let srv = MockImap::start(
        rule_scenario("INBOX", Some("Trash"))
            .fault(Trigger::nth("LIST", 1), Action::DropConnection),
    );
    let (s, config) = rule_state(&srv, "INBOX");
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "INBOX", 1, Mode::Trash, false)
        .await
        .expect("the move retries after LIST drops");
    assert_eq!(out.trash.as_deref(), Some("Trash"));
    assert!(srv.state().find("INBOX").unwrap().messages.is_empty());
    assert_eq!(srv.state().find("Trash").unwrap().messages.len(), 1);
}

#[tokio::test]
async fn a_note_in_inbox_and_sent_deleted_at_once_both_land_in_trash() {
    let srv = MockImap::start(rule_scenario("Sent", Some("Trash")));
    srv.mutate(|state| { state.find_mut("INBOX").unwrap().add(Message::new(1, RAW)); });
    let (s, config) = rule_state(&srv, "Sent");
    let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me"}]}).to_string();
    crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();

    let (inbox, sent) = tokio::join!(
        delete_one(&s, Provider::Imap(&config), "acc1", "INBOX", 1, Mode::Auto, true),
        delete_one(&s, Provider::Imap(&config), "acc1", "Sent", 1, Mode::Auto, true),
    );
    assert!(inbox.is_ok(), "INBOX: {inbox:?}");
    assert!(sent.is_ok(), "Sent: {sent:?}");
    assert!(srv.state().find("INBOX").unwrap().messages.is_empty());
    assert!(srv.state().find("Sent").unwrap().messages.is_empty());
    assert_eq!(srv.state().find("Trash").unwrap().messages.len(), 2);
}

#[tokio::test]
async fn a_gmail_note_deleted_from_every_label_at_once_ends_in_trash_once() {
    let srv = MockImap::start(
        Scenario::gmail().gmail_message(GmailMsg::new(RAW).labels(&["\\Inbox", "\\Sent"])),
    );
    let (s, config) = rule_state(&srv, "INBOX");
    let folders = ["INBOX", "[Gmail]/Sent Mail", "[Gmail]/All Mail"];
    let uids: Vec<u32> = folders.iter().map(|folder| srv.state().find(folder).unwrap().messages[0].uid).collect();
    for (&folder, &uid) in folders.iter().zip(&uids).skip(1) {
        let headers = json!({"emails": [{"uid": uid, "messageId": "<keep1@example.com>", "subject": "Keep me"}]}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", folder, &headers)).unwrap();
    }

    let (inbox, sent, all_mail) = tokio::join!(
        delete_one(&s, Provider::Imap(&config), "acc1", folders[0], uids[0], Mode::Auto, false),
        delete_one(&s, Provider::Imap(&config), "acc1", folders[1], uids[1], Mode::Auto, false),
        delete_one(&s, Provider::Imap(&config), "acc1", folders[2], uids[2], Mode::Auto, false),
    );
    for result in [inbox, sent, all_mail] {
        assert!(result.is_ok(), "every copy delete is accepted: {result:?}");
    }
    let state = srv.state();
    assert_eq!(state.find("[Gmail]/Trash").unwrap().messages.len(), 1);
    for folder in folders {
        assert!(state.find(folder).unwrap().messages.is_empty(), "{folder} is empty");
    }
}

/// Sent, Archive, Spam and a custom folder: `auto` moves to Trash, with an
/// undo handle (the Trash uid) and the bin row that says where it went. No
/// full fetch: a move keeps a byte-less bin row.
#[tokio::test]
async fn auto_outside_trash_moves_to_trash_from_every_folder() {
    for folder in ["Sent", "Archive", "Spam", "Clients/Acme"] {
        let (srv, s, config) = rule_server(folder, Some("Trash"));
        let out = delete_one(&s, Provider::Imap(&config), "acc1", folder, 1, Mode::Auto, true).await.unwrap_or_else(|e| panic!("{folder}: {e:?}"));
        assert_eq!(out.trash.as_deref(), Some("Trash"), "{folder}: moved to Trash");
        assert!(out.trash_uid.is_some(), "{folder}: the undo's handle");
        assert!(srv.state().find(folder).unwrap().messages.is_empty(), "{folder}: left the folder");
        assert_eq!(srv.state().find("Trash").unwrap().messages.len(), 1, "{folder}: landed in Trash");
        assert_eq!(srv.count_commands("BODY.PEEK[]"), 0, "{folder}: a move downloads nothing");
        let rows = bin_rows(&s);
        assert_eq!(rows.len(), 1, "{folder}: one bin row");
        assert_eq!(rows[0].trash.as_deref(), Some("Trash"), "{folder}: the bin row knows where it went");
    }
}

/// Inside Trash `auto` is permanent: the bin copy is required first (the
/// full fetch), nothing is left on the server, nothing to move back.
#[tokio::test]
async fn auto_inside_trash_is_permanent() {
    let (srv, s, config) = rule_server("Trash", Some("Trash"));
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "Trash", 1, Mode::Auto, true).await.expect("deleted");
    assert_eq!((out.trash.as_deref(), out.trash_uid), (None, None), "permanent: nothing to move back");
    assert!(out.bin_id.is_some(), "the bin holds the only copy");
    assert!(srv.state().find("Trash").unwrap().messages.is_empty(), "gone from Trash");
    assert_eq!(srv.count_commands("BODY.PEEK[]"), 1, "the required capture downloaded it");
}

/// A Trash found only by name (no SPECIAL-USE) is still Trash: the folder a
/// move lands in, nothing else.
#[tokio::test]
async fn auto_inside_a_name_only_trash_is_permanent() {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mut trash = Mailbox::new("Trash");
    trash.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let srv = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(trash));
    let (s, config) = rule_state(&srv, "Trash");
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "Trash", 1, Mode::Auto, false).await.expect("deleted");
    assert_eq!(out.trash, None, "permanent");
    assert!(srv.state().find("Trash").unwrap().messages.is_empty());
}

/// Ruling P6: an account with no Trash keeps desktop's old rule. Outside
/// INBOX the delete is permanent (bin copy first) and creates no folder.
#[tokio::test]
async fn auto_with_no_trash_outside_inbox_is_permanent() {
    let (srv, s, config) = rule_server("Sent", None);
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "Sent", 1, Mode::Auto, true).await.expect("deleted");
    assert_eq!(out.trash, None, "permanent");
    assert!(out.bin_id.is_some(), "kept in the bin first");
    assert!(srv.state().find("Sent").unwrap().messages.is_empty(), "gone");
    assert!(srv.state().find("Trash").is_none(), "no Trash was made");
    assert_eq!(srv.count_commands("CREATE"), 0);
}

/// Ruling P6, INBOX: still a move, Trash made for it as before.
#[tokio::test]
async fn auto_with_no_trash_in_inbox_still_moves() {
    let (srv, s, config) = rule_server("INBOX", None);
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "INBOX", 1, Mode::Auto, true).await.expect("deleted");
    assert_eq!(out.trash.as_deref(), Some("Trash"), "moved into the Trash it made");
    assert!(srv.state().find("Trash").is_some_and(|m| m.messages.len() == 1));
}

/// INBOX never asks where Trash is before the delete: the same LISTs as an
/// explicit move to Trash.
#[tokio::test]
async fn auto_in_inbox_asks_nothing_first() {
    let (auto, s, config) = rule_server("INBOX", Some("Trash"));
    delete_one(&s, Provider::Imap(&config), "acc1", "INBOX", 1, Mode::Auto, false).await.expect("deleted");
    let (trash, s, config) = rule_server("INBOX", Some("Trash"));
    delete_one(&s, Provider::Imap(&config), "acc1", "INBOX", 1, Mode::Trash, false).await.expect("deleted");
    assert_eq!(auto.count_commands("LIST"), trash.count_commands("LIST"), "no lookup of its own");
}

/// Outside INBOX the rule's Trash lookup is the only LIST: the move goes to
/// the path that lookup found, so a click costs no second round trip (the
/// same LISTs as a move out of INBOX).
#[tokio::test]
async fn auto_outside_inbox_lists_once() {
    let (sent, s, config) = rule_server("Sent", Some("Trash"));
    let out = delete_one(&s, Provider::Imap(&config), "acc1", "Sent", 1, Mode::Auto, false).await.expect("deleted");
    assert_eq!(out.trash.as_deref(), Some("Trash"));
    let (inbox, s, config) = rule_server("INBOX", Some("Trash"));
    delete_one(&s, Provider::Imap(&config), "acc1", "INBOX", 1, Mode::Trash, false).await.expect("deleted");
    assert_eq!(sent.count_commands("LIST"), inbox.count_commands("LIST"), "one lookup, not two");
}

/// Outside INBOX the rule costs one LIST before the delete, and a lookup that
/// fails refuses the delete with nothing sent and nothing captured.
#[tokio::test]
async fn a_trash_lookup_that_fails_sends_nothing() {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let srv = MockImap::start(rule_scenario("Sent", Some("Trash")).fault(Trigger::on("LIST"), Action::RefuseWith("NO".into(), "list refused".into())));
    let (s, config) = rule_state(&srv, "Sent");
    let r = delete_one(&s, Provider::Imap(&config), "acc1", "Sent", 1, Mode::Auto, true).await;
    assert!(matches!(&r, Err(Refusal::Server(e)) if e.contains("Trash")), "{r:?}");
    assert_eq!(srv.state().find("Sent").unwrap().messages.len(), 1, "untouched");
    assert!(bin_rows(&s).is_empty(), "no capture before the rule is known");
}


#[tokio::test]
async fn imap_delete_email_refuses_an_unknown_mode() {
    let f = fixture(vec![]);
    let r = handle_request_for_test(&f.s, "imap_delete_email", json!({"account": f.account, "uid": 1, "mailbox": "INBOX", "mode": "shred"})).await;
    let e = r.error.expect("refused");
    assert_eq!(e.code, crate::ipc::INVALID_PARAMS, "{}", e.message);
    assert!(f.in_inbox(), "nothing was deleted");
}

// ── a move to Trash that cannot tell "already gone" (final review, Important 3) ──

/// The MOVE (and its COPY fallback) is refused for a uid the folder no
/// longer holds: one presence check (`UID SEARCH UID`) says it is gone, and
/// the delete answers `gone` instead of an error the queue would retry
/// forever. `Auto` in INBOX resolves to the same move.
#[tokio::test]
async fn a_refused_move_of_a_uid_the_folder_no_longer_holds_is_gone() {
    for mode in [Mode::Trash, Mode::Auto] {
        let f = fixture(refuse_the_move());
        let r = delete_one(&f.s, Provider::Imap(&f.config), "acc1", "INBOX", 5, mode, true).await;
        let out = r.unwrap_or_else(|e| panic!("{mode:?}: an absent uid is gone, not {e:?}"));
        assert!(out.gone, "{mode:?}: {out:?}");
        assert_eq!((out.trash, out.trash_uid, out.bin_id), (None, None, None), "{mode:?}: nothing to undo");
        assert!(bin_rows(&f.s).is_empty(), "{mode:?}: the capture of a delete that did nothing is dropped");
        assert!(f.in_inbox(), "{mode:?}: uid 1 untouched");
        assert!(f.srv.count_commands("SEARCH") >= 1, "{mode:?}: asked the folder");
    }
}

/// The uid is still there: the refusal stands.
#[tokio::test]
async fn a_refused_move_of_a_uid_still_there_stays_an_error() {
    let f = fixture(refuse_the_move());
    let r = f.delete(Mode::Trash, true).await;
    match &r {
        Err(Refusal::Server(e)) => assert!(e.contains("refused"), "the original refusal: {e}"),
        other => panic!("still there: {other:?}"),
    }
    assert!(f.in_inbox());
}

/// The presence check itself fails: nothing is taken as gone, and the
/// original error is kept.
#[tokio::test]
async fn a_presence_check_that_fails_keeps_the_original_error() {
    let mut faults = refuse_the_move();
    faults.push((Trigger::on("SEARCH"), Action::RefuseWith("NO".into(), "search refused".into())));
    let f = fixture(faults);
    let r = delete_one(&f.s, Provider::Imap(&f.config), "acc1", "INBOX", 5, Mode::Trash, true).await;
    match &r {
        Err(Refusal::Server(e)) => {
            assert!(e.contains("refused") && !e.contains("search refused"), "the delete's own error, not the check's: {e}");
        }
        other => panic!("an unanswered check is not gone: {other:?}"),
    }
}
