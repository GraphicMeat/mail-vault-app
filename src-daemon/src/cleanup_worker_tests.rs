//! Auto-cleanup runs through the daemon: the mock IMAP server, a real vault,
//! custody and settings document over scratch dirs. What the rules SELECT is
//! pinned in `mailvault_core::cleanup_rules` (the JS fixture); here, what a run
//! DOES with a selection, mirroring the old `tests/unit/cleanupEngine.test.js`
//! and `tests/e2e/connected-cleanup-rules.test.js`.

use super::*;
use crate::server::handle_request_for_test;
use mailvault_core::abd::Provider;
use mailvault_core::custody::entries;
use mailvault_core::vault_files;
use mock_imap::state::{Mailbox, Message};
use mock_imap::{MockImap, Scenario};
use std::time::Instant;

const ACCT: &str = "acc1";
const EMAIL: &str = "user@example.com";
/// 2020-01-01T12:00:00Z: past any rule's threshold.
const OLD_MS: i64 = 1_577_880_000_000;
const OLD_DATE: &str = "Wed, 01 Jan 2020 12:00:00 +0000";

fn raw(id: &str) -> String {
    format!("From: a@example.com\r\nTo: b@example.com\r\nSubject: {id}\r\nMessage-ID: <{id}@t.test>\r\nDate: {OLD_DATE}\r\n\r\nbody of {id}\r\n")
}

fn old_box(name: &str, uids: &[u32], attrs: &[&str]) -> Mailbox {
    let mut mb = Mailbox::new(name).with_attrs(attrs);
    for &u in uids {
        mb.add(Message::new(u, raw(&format!("{name}-m{u}"))).with_internal_ms(OLD_MS + u as i64));
    }
    mb
}

fn rule(over: Value) -> Value {
    let mut r = json!({"id": "r1", "account": "all", "folder": "INBOX", "age": 30, "unit": "days", "action": "delete", "enabled": true});
    for (k, v) in over.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

struct Rig {
    dir: PathBuf,
    state: Arc<DaemonState>,
    mock: MockImap,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Rig {
    /// INBOX 1..=3 (3 is fresh) and an empty Trash, the account known to the
    /// app and the caches, premium on, `rules` stored.
    fn new(sc: Scenario, rules: Value) -> Rig {
        let lock = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let dir = std::env::temp_dir().join(format!("mv-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mock = MockImap::start(sc);
        let account = json!({"id": ACCT, "email": EMAIL, "password": "hunter2", "imapHost": mock.host(), "imapPort": mock.port(), "imapSecure": true});
        let creds = dir.join("credentials.json");
        std::fs::write(&creds, json!({ ACCT: account.to_string() }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        std::fs::write(dir.join("accounts.json"), json!([{"id": ACCT, "email": EMAIL}]).to_string()).unwrap();
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let rig = Rig { dir, state, mock, _lock: lock };
        rig.settings(json!({
            "billingProfile": {"hasSubscription": true, "status": "active", "premiumAccess": true},
            "cleanupRules": rules,
        }));
        rig.mailboxes(json!([
            {"path": "INBOX", "name": "INBOX"},
            {"path": "Trash", "name": "Trash", "specialUse": "\\Trash"},
        ]));
        rig
    }

    fn settings(&self, s: Value) {
        mailvault_core::settings_doc::SettingsDoc::shared(&self.state.app_dir)
            .replace(&json!({"mailvault-settings": {"state": s, "version": 0}}), None)
            .unwrap();
    }

    fn mailboxes(&self, list: Value) {
        crate::custody::with_conn(&self.state, |c| {
            mailvault_core::custody::cache::save_mailboxes(c, ACCT, &json!({"mailboxes": list}).to_string())
        })
        .unwrap();
    }

    /// Header rows for `uids` of `folder`: old ones, uid 3 of INBOX fresh.
    fn headers(&self, folder: &str, uids: &[u32]) {
        let now = chrono::Utc::now().to_rfc2822();
        let emails: Vec<Value> = uids
            .iter()
            .map(|u| {
                let date = if folder == "INBOX" && *u == 3 { now.clone() } else { OLD_DATE.to_string() };
                json!({"uid": u, "date": date, "messageId": format!("<{folder}-m{u}@t.test>"), "subject": format!("m{u}")})
            })
            .collect();
        crate::custody::with_conn(&self.state, |c| {
            mailvault_core::custody::cache::save_headers(c, ACCT, folder, &json!({"emails": emails, "totalEmails": uids.len()}).to_string())
        })
        .unwrap();
    }

    /// An archived vault copy of `folder`'s uid, as `archive_emails` leaves it
    /// (no generation stamp), with its custody entry.
    fn archived(&self, folder: &str, uid: u32) {
        let cur = vault_files::cur_path(&self.dir, ACCT, folder);
        std::fs::create_dir_all(&cur).unwrap();
        let name = vault_files::build_maildir_filename(uid, &["archived".to_string()]);
        std::fs::write(cur.join(name), raw(&format!("{folder}-m{uid}"))).unwrap();
        crate::custody::with_conn(&self.state, |c| entries::upsert(c, ACCT, folder, &[json!({"uid": uid, "source": "local"})])).unwrap();
    }

    fn uids(&self, folder: &str) -> Vec<u32> {
        self.mock.state().find(folder).unwrap().messages.iter().map(|m| m.uid).collect()
    }

    fn trash_ids(&self) -> Vec<String> {
        let st = self.mock.state();
        let mut ids: Vec<String> = st
            .find("Trash")
            .unwrap()
            .messages
            .iter()
            .filter(|m| !m.has_flag("\\Deleted"))
            .filter_map(|m| mailvault_core::maildir::message_id_in(&m.raw))
            .collect();
        ids.sort();
        ids
    }

    fn entry(&self, folder: &str, uid: u32) -> Value {
        let rows: Vec<Value> =
            serde_json::from_str(&crate::custody::with_conn(&self.state, |c| entries::read(c, ACCT, folder)).unwrap().unwrap_or_else(|| "[]".into()))
                .unwrap();
        rows.into_iter().find(|e| e["uid"] == json!(uid)).unwrap_or(Value::Null)
    }

    async fn run(&self) -> Option<RunResult> {
        run_once(&self.state, None).await
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
}

fn inbox_and_trash() -> Scenario {
    Scenario::new()
        .mailbox(old_box("INBOX", &[1, 2, 3], &["\\HasNoChildren"]))
        .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]))
}

fn counts(r: &RunResult) -> (u64, u64, u64) {
    (r.deleted, r.archived, r.skipped)
}

/// The e2e's question: the copy the vault holds goes to Trash (moved, not
/// expunged), the one it does not hold stays, the fresh one is not a
/// candidate, nothing is downloaded, and the vault row says "only copy".
#[tokio::test(flavor = "multi_thread")]
async fn a_delete_rule_takes_only_what_the_vault_holds() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);

    let r = rig.run().await.expect("a run");

    assert_eq!(counts(&r), (1, 0, 1), "1 deleted, 0 archived, 1 skipped");
    assert_eq!(rig.uids("INBOX"), vec![2, 3]);
    assert_eq!(rig.trash_ids(), vec!["INBOX-m1@t.test".to_string()]);
    assert_eq!(rig.mock.count_commands("BODY.PEEK[]"), 0, "a delete rule downloads nothing");
    assert!(vault_files::cur_path(&rig.dir, ACCT, "INBOX").read_dir().unwrap().count() == 1, "the vault copy stays");
    assert_eq!(rig.entry("INBOX", 1)["serverDeleted"], json!(true));
    assert_eq!(last_run(&rig.state), Some(r), "the run is recorded where the next start reads it");
}

/// Run twice: the second run finds nothing new to take.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_run_takes_nothing_more() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    rig.run().await.unwrap();
    let again = rig.run().await.unwrap();
    assert_eq!(again.deleted, 0);
    assert_eq!(rig.uids("INBOX"), vec![2, 3]);
    assert_eq!(rig.trash_ids().len(), 1);
}

/// Archive-then-delete archives the missing copy first, then deletes both.
#[tokio::test(flavor = "multi_thread")]
async fn archive_then_delete_saves_first_then_deletes() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({"action": "archive-then-delete"}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);

    let r = rig.run().await.unwrap();

    assert_eq!(counts(&r), (2, 2, 0));
    assert_eq!(rig.uids("INBOX"), vec![3]);
    let mut kept: Vec<u32> = mailvault_core::maildir::archived_file_map(&vault_files::cur_path(&rig.dir, ACCT, "INBOX")).into_keys().collect();
    kept.sort_unstable();
    assert_eq!(kept, vec![1, 2], "both are in the vault");
}

/// Only the Trash folder itself is emptied, and only what the vault holds.
#[tokio::test(flavor = "multi_thread")]
async fn a_trash_rule_expunges_the_trash_copies_the_vault_holds() {
    let sc = Scenario::new()
        .mailbox(old_box("INBOX", &[], &["\\HasNoChildren"]))
        .mailbox(old_box("Trash", &[5, 6], &["\\HasNoChildren", "\\Trash"]));
    let rig = Rig::new(sc, json!([rule(json!({"folder": "Trash"}))]));
    rig.headers("Trash", &[5, 6]);
    rig.archived("Trash", 5);

    let r = rig.run().await.unwrap();

    assert_eq!(counts(&r), (1, 0, 1));
    assert_eq!(rig.trash_ids(), vec!["Trash-m6@t.test".to_string()]);
}

/// A copy the op journal still names (an undo may need it), one composed
/// here, and one custody says is gone from the server are never candidates.
#[tokio::test(flavor = "multi_thread")]
async fn protected_copies_stay() {
    let sc = Scenario::new()
        .mailbox(old_box("INBOX", &[1, 2, 4], &["\\HasNoChildren"]))
        .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"]));
    let rig = Rig::new(sc, json!([rule(json!({}))]));
    rig.headers("INBOX", &[1, 2, 4]);
    for u in [1, 2, 4] {
        rig.archived("INBOX", u);
    }
    mailvault_core::op_journal::queue(
        &rig.state.app_dir,
        mailvault_core::op_journal::OpEntry { id: 0, op: "delete".into(), account_id: ACCT.into(), mailbox: "INBOX".into(), uids: vec![1], arg: json!({}), at: 1 },
    )
    .unwrap();
    crate::custody::with_conn(&rig.state, |c| entries::upsert(c, ACCT, "INBOX", &[json!({"uid": 2, "source": "local_sent"})])).unwrap();

    let r = rig.run().await.unwrap();

    assert_eq!(counts(&r), (1, 0, 2));
    assert_eq!(rig.uids("INBOX"), vec![1, 2]);
}

/// With a backup drive configured and none handed to the run, nothing goes:
/// an unplugged drive is not an empty one.
#[tokio::test(flavor = "multi_thread")]
async fn a_configured_drive_this_run_cannot_read_deletes_nothing() {
    let rig = Rig::new(inbox_and_trash(), json!([]));
    rig.settings(json!({
        "billingProfile": {"hasSubscription": true, "status": "active"},
        "cleanupRules": [rule(json!({}))],
        "externalBackupLocation": {"status": "ready", "displayPath": "/Volumes/Backup"},
    }));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);

    let r = rig.run().await.unwrap();

    assert_eq!(counts(&r), (0, 0, 2));
    assert_eq!(rig.uids("INBOX"), vec![1, 2, 3]);
    assert_eq!(rig.mock.count_commands("SELECT"), 0, "the server is not even asked");
}

/// With the drive handed over, only copies already on it go; the drive is
/// never written.
#[tokio::test(flavor = "multi_thread")]
async fn the_drive_is_read_never_written() {
    let rig = Rig::new(inbox_and_trash(), json!([]));
    rig.settings(json!({
        "billingProfile": {"hasSubscription": true, "status": "active"},
        "cleanupRules": [rule(json!({}))],
        "externalBackupLocation": {"status": "ready"},
    }));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    rig.archived("INBOX", 2);
    let drive = rig.dir.join("drive");
    let mirror_cur = mailvault_core::maildir::mirror_cur(&drive, EMAIL, "INBOX");
    std::fs::create_dir_all(&mirror_cur).unwrap();
    let name = vault_files::build_maildir_filename(1, &["archived".to_string()]);
    std::fs::write(mirror_cur.join(&name), raw("INBOX-m1")).unwrap();

    let r = run_once(&rig.state, Some(drive.to_string_lossy().to_string())).await.unwrap();

    assert_eq!(counts(&r), (1, 0, 1));
    assert_eq!(rig.uids("INBOX"), vec![2, 3]);
    assert_eq!(mirror_cur.read_dir().unwrap().count(), 1, "nothing was copied to the drive");
}

/// No premium: nothing runs and nothing is recorded (the JS did the same).
#[tokio::test(flavor = "multi_thread")]
async fn without_premium_nothing_runs_or_is_recorded() {
    let rig = Rig::new(inbox_and_trash(), json!([]));
    rig.settings(json!({"billingProfile": {"hasSubscription": false}, "cleanupRules": [rule(json!({}))]}));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    assert_eq!(rig.run().await, None);
    assert_eq!(rig.uids("INBOX"), vec![1, 2, 3]);
    assert_eq!(last_run(&rig.state), None);
}

/// A cached Message-ID that is not the server's for that uid: not the
/// message the rule matched.
#[tokio::test(flavor = "multi_thread")]
async fn a_uid_that_names_another_message_now_stays() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({}))]));
    crate::custody::with_conn(&rig.state, |c| {
        mailvault_core::custody::cache::save_headers(
            c,
            ACCT,
            "INBOX",
            &json!({"emails": [{"uid": 1, "date": OLD_DATE, "messageId": "<another@t.test>"}]}).to_string(),
        )
    })
    .unwrap();
    rig.archived("INBOX", 1);
    let r = rig.run().await.unwrap();
    assert_eq!(counts(&r), (0, 0, 1));
    assert_eq!(rig.uids("INBOX"), vec![1, 2, 3]);
}

/// The user's own Archive & delete job on the account comes first.
#[tokio::test(flavor = "multi_thread")]
async fn an_account_with_a_running_abd_job_is_left_alone() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    let job = mailvault_core::abd::JobFile::create(mailvault_core::abd::NewJob {
        account_id: ACCT.into(),
        account_email: EMAIL.into(),
        host: "h".into(),
        provider: Provider::Imap,
        mode: Mode::ArchiveDelete,
        timing: Timing::AfterAll,
        delete_mode: DeleteMode::MoveToTrash,
        scope: Scope { folders: vec![], dates: DateScope::All, date_choice: "all".into(), year_bounds: vec![] },
        now_ms: 0,
    });
    rig.state.abd.jobs.lock().unwrap().insert(ACCT.into(), crate::abd_worker::JobHandle::new(&job));
    let r = rig.run().await.unwrap();
    assert_eq!(counts(&r), (0, 0, 2));
    assert_eq!(rig.uids("INBOX"), vec![1, 2, 3]);
}

/// Rule 1 deletes what the vault holds and must keep the rest; rule 2,
/// archive-then-delete over a longer age, archives and deletes that rest, as
/// the JS did. Rule 1 naming a message first must not hide it from rule 2.
#[tokio::test(flavor = "multi_thread")]
async fn a_later_archive_rule_takes_what_an_earlier_delete_rule_had_to_keep() {
    let rules = json!([
        rule(json!({})),
        rule(json!({"id": "r2", "folder": "all", "age": 90, "action": "archive-then-delete"})),
    ]);
    let rig = Rig::new(inbox_and_trash(), rules);
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 2);

    let r = rig.run().await.unwrap();

    assert_eq!(rig.uids("INBOX"), vec![3], "uid 2 by rule 1, uid 1 archived and deleted by rule 2");
    assert_eq!(counts(&r), (2, 1, 0), "each message counted once");
}

/// Control: two delete rules naming the same message act on it once, and a
/// message neither can take is skipped once.
#[tokio::test(flavor = "multi_thread")]
async fn two_delete_rules_act_on_a_message_once() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({})), rule(json!({"id": "r2", "folder": "all"}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    let r = rig.run().await.unwrap();
    assert_eq!(counts(&r), (1, 0, 1));
    assert_eq!(rig.uids("INBOX"), vec![2, 3]);
}

/// A vault that cannot be reached is not "no mail": nothing is recorded, so
/// the next hourly check tries again instead of waiting a day.
#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_vault_records_no_run() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    let gated = DaemonState::for_test(rig.dir.clone(), rig.dir.clone(), false);

    assert_eq!(run_once(&gated, None).await, None);
    assert_eq!(last_run(&gated), None);
    assert_eq!(rig.uids("INBOX"), vec![1, 2, 3]);
    let p = handle_request_for_test(&gated, "cleanup.preview", json!({})).await;
    assert_eq!(p.error.map(|e| e.message), Some("errors.cleanupUnavailable".to_string()));
}

/// The two engines never work one account at once: while a cleanup run holds
/// it, `abd.start` is refused like a second job.
#[tokio::test(flavor = "multi_thread")]
async fn abd_start_refuses_an_account_a_cleanup_run_holds() {
    let rig = Rig::new(inbox_and_trash(), json!([]));
    let start = json!({
        "accountId": ACCT, "previewId": "p1", "confirmed": true,
        "mode": "archive_delete", "timing": "after_all", "deleteMode": "move_to_trash",
    });
    rig.state.cleanup.hold_account(ACCT);
    let held = handle_request_for_test(&rig.state, "abd.start", start.clone()).await;
    assert!(held.error.as_ref().is_some_and(|e| e.message.starts_with("E_ABD_JOB_EXISTS")), "{:?}", held.error.map(|e| e.message));
    rig.state.cleanup.release_account();
    let free = handle_request_for_test(&rig.state, "abd.start", start).await;
    assert!(free.error.as_ref().is_some_and(|e| e.message.starts_with("E_ABD_PREVIEW_EXPIRED")), "control: it gets past the check");
}

/// Two runs never overlap: the slot is taken, `cleanup.run_now` says so.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_cannot_overlap_itself() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({}))]));
    start(Arc::clone(&rig.state));
    assert!(rig.state.cleanup.claim());
    let busy = handle_request_for_test(&rig.state, "cleanup.run_now", json!({})).await.result.unwrap();
    assert_eq!(busy, json!({"started": false, "running": true}));
    rig.state.cleanup.release();

    rig.headers("INBOX", &[1, 2, 3]);
    rig.archived("INBOX", 1);
    let mut rx = rig.state.events.subscribe();
    let started = handle_request_for_test(&rig.state, "cleanup.run_now", json!({})).await.result.unwrap();
    assert_eq!(started, json!({"started": true}));
    let deadline = Instant::now() + Duration::from_secs(60);
    let done = loop {
        assert!(Instant::now() < deadline, "the run never ended");
        match rx.try_recv() {
            Ok(line) => {
                let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
                if name == RUN_EVENT && payload["state"] == json!("done") {
                    break payload;
                }
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    };
    assert_eq!(done["lastRun"]["deleted"], json!(1));
    let status = handle_request_for_test(&rig.state, "cleanup.status", json!({})).await.result.unwrap();
    assert_eq!(status["running"], json!(false));
    assert_eq!(status["lastRun"]["deleted"], json!(1));
}

/// The dry run counts what a run would try, from the caches only.
#[tokio::test(flavor = "multi_thread")]
async fn the_preview_counts_without_asking_the_server() {
    let rig = Rig::new(inbox_and_trash(), json!([rule(json!({})), rule(json!({"id": "r2", "folder": "Drafts"}))]));
    rig.headers("INBOX", &[1, 2, 3]);
    let p = handle_request_for_test(&rig.state, "cleanup.preview", json!({})).await.result.unwrap();
    assert_eq!(p["deleted"], json!(2));
    assert_eq!(p["rules"], json!([{"id": "r1", "matched": 2}, {"id": "r2", "matched": 0}]));
    assert_eq!(rig.mock.count_commands("SELECT"), 0);
    let rules = handle_request_for_test(&rig.state, "cleanup.rules.get", json!({})).await.result.unwrap();
    assert_eq!(rules["rules"][0]["runs"], json!(true));
    assert_eq!(rules["rules"][1]["refused"], json!("errors.cleanupRuleProtectedFolder"));
}

/// The first status after the move reads the run the app recorded.
#[tokio::test(flavor = "multi_thread")]
async fn the_apps_last_run_arms_the_daily_guard_until_the_daemon_records_one() {
    let rig = Rig::new(inbox_and_trash(), json!([]));
    rig.settings(json!({"cleanupLastRun": {"at": 123, "archived": 0, "deleted": 4, "skipped": 1}}));
    assert_eq!(last_run(&rig.state), Some(RunResult { archived: 0, deleted: 4, skipped: 1, at: 123 }));
}

/// Nothing a run logs carries a rule, a folder or an address.
#[test]
fn the_worker_logs_no_values() {
    let src = include_str!("cleanup_worker.rs");
    let code = &src[..src.find("#[cfg(test)]").unwrap()];
    for line in code.lines().filter(|l| l.contains("info!(") || l.contains("warn!(")) {
        for bad in ["{account", "{email", "{folder", "{path", "{rule", "{token", "{cfg", "{settings", ":?}", ".text()", "{exit"] {
            assert!(!line.contains(bad), "{line}");
        }
    }
}
