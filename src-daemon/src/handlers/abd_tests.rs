//! The Archive (& back up) & delete job through the daemon: the RPCs of
//! design 6.6, the `abd-worker` thread, resume on start, and the rules that
//! keep a running job from getting in the user's way. The engine's own state
//! machine is tested against fakes in `src-core/tests/abd_engine.rs`; here the
//! server is the mock IMAP server and the vault, the drive and the job files
//! are real directories.

use super::*;
use crate::abd_local::DaemonLocal;
use crate::abd_worker;
use crate::server::handle_request_for_test;
use mailvault_core::abd::graph_ops::TokenLease as Lease;
use mailvault_core::abd::{FolderPlan, FolderRole, FolderState, JobStatus, LocalStore, Phase, ServerCaps, TrashInfo};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, GmailMsg, MockImap, Scenario, Trigger};
use std::path::PathBuf;

const ACCT: &str = "acc1";
const EMAIL: &str = "user@example.com";

// ── helpers ─────────────────────────────────────────────────────────────────

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mv-abd-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// UTC epoch ms.
fn ms(y: i32, mo: u32, d: u32, h: u32) -> i64 {
    chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc().timestamp_millis()
}

fn year_bounds() -> Value {
    Value::Array(
        (2015..=2035)
            .map(|y| json!({"year": y, "startMs": ms(y, 1, 1, 0), "endMs": ms(y + 1, 1, 1, 0)}))
            .collect(),
    )
}

fn raw(id: &str) -> String {
    format!("From: a@example.com\r\nTo: b@example.com\r\nSubject: {id}\r\nMessage-ID: <{id}@t.test>\r\n\r\nbody of {id}\r\n")
}

/// INBOX with uids 1..=n, received in June 2025.
fn inbox(n: u32) -> Mailbox {
    let mut mb = Mailbox::new("INBOX");
    for i in 1..=n {
        mb.add(Message::new(i, raw(&format!("m{i}"))).with_internal_ms(ms(2025, 6, 1, 12) + i as i64 * 1000));
    }
    mb
}

fn trash() -> Mailbox {
    Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"])
}

fn scenario(n: u32) -> Scenario {
    Scenario::new().mailbox(inbox(n)).mailbox(trash())
}

fn slow_fetches(n: u32, delay_ms: u64) -> Scenario {
    scenario(n).fault(Trigger::with("FETCH", "BODY.PEEK[]"), Action::Delay(Duration::from_millis(delay_ms)))
}

fn account_json(mock: &MockImap) -> Value {
    json!({
        "id": ACCT, "email": EMAIL, "password": "hunter2",
        "imapHost": mock.host(), "imapPort": mock.port(), "imapSecure": true,
    })
}

/// A daemon state over scratch dirs, a mock server and a credentials file for
/// the account. The credentials path is a process-wide env var, so a rig holds
/// the crate's env lock for the whole test.
struct Rig {
    dir: PathBuf,
    state: Arc<DaemonState>,
    mock: MockImap,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Rig {
    fn build(mock: MockImap, account: Value) -> Rig {
        let lock = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let dir = temp_dir("rig");
        let creds = dir.join("credentials.json");
        std::fs::write(&creds, json!({ ACCT: account.to_string() }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        Rig { dir, state, mock, _lock: lock }
    }

    /// The worker is not started: a test that seeds job files first starts it itself.
    fn idle(sc: Scenario) -> Rig {
        let mock = MockImap::start(sc);
        let account = account_json(&mock);
        Rig::build(mock, account)
    }

    fn ready(sc: Scenario) -> Rig {
        let rig = Rig::idle(sc);
        abd_worker::start(Arc::clone(&rig.state));
        rig
    }

    fn start_worker(&self) {
        abd_worker::start(Arc::clone(&self.state));
    }

    /// Kill the worker where it stands (nothing settles, nothing is saved) and
    /// bring up a new daemon on the same directories, as a restart would.
    async fn restart(&mut self) {
        self.state.abd.stop_worker_for_test();
        tokio::time::sleep(Duration::from_millis(700)).await;
        self.state = DaemonState::for_test(self.dir.clone(), self.dir.clone(), true);
        abd_worker::start(Arc::clone(&self.state));
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        rpc(&self.state, method, params).await
    }

    async fn preview(&self) {
        self.rpc("abd.preview", json!({"accountId": ACCT, "previewId": "p1"})).await.unwrap();
        let state = Arc::clone(&self.state);
        wait_for("the listing", 30, move || state.abd.preview(ACCT, "p1")).await;
    }

    async fn start(&self, params: Value) -> Result<Value, String> {
        self.rpc("abd.start", params).await
    }

    fn frame(&self) -> Option<Value> {
        self.state.abd.handle(ACCT).map(|h| h.frame())
    }

    async fn finished(&self) -> Value {
        let state = Arc::clone(&self.state);
        wait_for("the job to finish", 90, move || {
            let f = state.abd.handle(ACCT)?.frame();
            (f["finished"] == json!(true)).then_some(f)
        })
        .await
    }

    async fn status_is(&self, state_name: &str, reason: &str) -> Value {
        let (s, name, why) = (Arc::clone(&self.state), state_name.to_string(), reason.to_string());
        wait_for(&format!("status {state_name}/{reason}"), 60, move || {
            let f = s.abd.handle(ACCT)?.frame();
            let st = &f["status"];
            (st["state"] == json!(name) && (why.is_empty() || st["reason"] == json!(why))).then_some(f)
        })
        .await
    }

    fn inbox_uids(&self) -> Vec<u32> {
        self.mock.state().find("INBOX").unwrap().messages.iter().map(|m| m.uid).collect()
    }

    fn trash_ids(&self) -> Vec<String> {
        let st = self.mock.state();
        let mut ids: Vec<String> =
            st.find("Trash").unwrap().messages.iter().filter_map(|m| maildir::message_id_in(&m.raw)).collect();
        ids.sort();
        ids
    }

    fn vault_uids(&self, mailbox: &str) -> Vec<u32> {
        let mut v: Vec<u32> =
            maildir::archived_file_map(&vault_files::cur_path(&self.dir, ACCT, mailbox)).into_keys().collect();
        v.sort_unstable();
        v
    }

    fn fetched(&self) -> usize {
        self.mock.count_commands("BODY.PEEK[]")
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.state.abd.stop_worker_for_test();
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
}

async fn rpc(s: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
    let r = handle_request_for_test(s, method, params).await;
    match r.error {
        Some(e) => Err(e.message),
        None => Ok(r.result.unwrap_or(Value::Null)),
    }
}

async fn wait_for<T>(what: &str, secs: u64, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn start_params(mode: &str, delete: &str, timing: &str, folders: &[&str], mirror: Option<&Path>) -> Value {
    let mut p = json!({
        "accountId": ACCT, "previewId": "p1", "mode": mode, "timing": timing, "deleteMode": delete,
        "folders": folders, "dates": {"kind": "all"}, "dateChoice": "all", "yearBounds": year_bounds(),
        "confirmed": true,
    });
    if let Some(m) = mirror {
        p["mirrorRoot"] = json!(m.to_string_lossy());
    }
    p
}

fn archive_params() -> Value {
    start_params("archive_delete", "move_to_trash", "after_all", &["INBOX"], None)
}

/// A clock that runs fast, so a 30 s backoff or the 2 s pace between batches
/// does not cost real time. It pins the clock the moment it first ticks.
fn spawn_ticker(s: &Arc<DaemonState>) -> tokio::task::JoinHandle<()> {
    let s = Arc::clone(s);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(10)).await;
            s.clock.advance(2_000);
        }
    })
}

/// Uids named by the `UID FETCH n (... BODY.PEEK[])` commands in `commands`.
fn fetched_uids(commands: &[String]) -> Vec<u32> {
    commands
        .iter()
        .filter(|c| c.contains("BODY.PEEK[])"))
        .filter_map(|c| {
            let mut words = c.split_whitespace();
            words.find(|w| w.eq_ignore_ascii_case("FETCH"))?;
            words.next()?.parse().ok()
        })
        .collect()
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Ok(line) = rx.try_recv() {
        if let Some(ev) = mailvault_core::daemon_ipc::parse_event(&line) {
            out.push(ev);
        }
    }
    out
}

// ── log capture (the token must never reach a log) ──────────────────────────

struct LogWriter(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Everything logged at INFO and above from now on, if this process has no
/// subscriber of its own yet (the check is then a smaller one, never a wrong one).
fn captured_logs() -> Arc<std::sync::Mutex<Vec<u8>>> {
    static LOGS: std::sync::OnceLock<Arc<std::sync::Mutex<Vec<u8>>>> = std::sync::OnceLock::new();
    Arc::clone(LOGS.get_or_init(|| {
        let buf = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = Arc::clone(&buf);
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .with_writer(move || LogWriter(Arc::clone(&writer)))
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
        buf
    }))
}

// ── the dry run ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn preview_reports_counts_per_folder_and_year_and_summarize_does_not_list_again() {
    let mut mb = Mailbox::new("INBOX");
    for (i, (y, mo)) in [(2022, 3), (2022, 9), (2023, 1), (2024, 5), (2024, 6), (2025, 2)].iter().enumerate() {
        mb.add(Message::new(i as u32 + 1, raw(&format!("m{}", i + 1))).with_internal_ms(ms(*y, *mo, 10, 12)));
    }
    let rig = Rig::ready(Scenario::new().mailbox(mb).mailbox(trash()));
    rig.preview().await;
    let after_preview = rig.mock.commands().len();

    let params = json!({
        "accountId": ACCT, "previewId": "p1", "mode": "archive_delete", "folders": [],
        "dates": {"kind": "all"}, "dateChoice": "all", "yearBounds": year_bounds(), "deleteMode": "move_to_trash",
    });
    let first = rig.rpc("abd.summarize", params.clone()).await.unwrap();
    let rows = first["folders"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "a row for every folder of the preview, ticked or not: {first}");
    assert_eq!(first["canDelete"], json!(true));

    let mut ticked = params.clone();
    ticked["folders"] = json!(["INBOX"]);
    let second = rig.rpc("abd.summarize", ticked).await.unwrap();
    assert_eq!(second["total"]["count"], json!(6));
    let inbox_row = second["folders"].as_array().unwrap().iter().find(|r| r["path"] == json!("INBOX")).unwrap();
    let by_year: Vec<(i64, i64)> = inbox_row["byYear"]
        .as_array()
        .unwrap()
        .iter()
        .map(|y| (y["year"].as_i64().unwrap(), y["count"].as_i64().unwrap()))
        .collect();
    assert_eq!(by_year, vec![(2022, 2), (2023, 1), (2024, 2), (2025, 1)]);
    assert_eq!(rig.mock.commands().len(), after_preview, "a summary is worked out from the stored listing");
}

#[tokio::test]
async fn a_summary_of_an_unknown_or_expired_listing_says_so() {
    let rig = Rig::ready(scenario(2));
    let err = rig
        .rpc("abd.summarize", json!({"accountId": ACCT, "previewId": "nope", "mode": "archive_delete", "folders": []}))
        .await
        .unwrap_err();
    assert!(err.starts_with("E_ABD_PREVIEW_EXPIRED:"), "{err}");
}

// ── start refusals ──────────────────────────────────────────────────────────

#[tokio::test]
async fn start_refuses_without_confirmation() {
    let rig = Rig::ready(scenario(2));
    rig.preview().await;
    let mut p = archive_params();
    p["confirmed"] = json!(false);
    let err = rig.start(p).await.unwrap_err();
    assert!(err.starts_with("E_ABD_NOT_CONFIRMED:"), "{err}");
    assert!(rig.frame().is_none(), "nothing was registered");
    assert_eq!(rig.inbox_uids(), vec![1, 2]);
}

#[tokio::test]
async fn start_refuses_an_unknown_listing() {
    let rig = Rig::ready(scenario(2));
    rig.preview().await;
    let mut p = archive_params();
    p["previewId"] = json!("not-the-one");
    let err = rig.start(p).await.unwrap_err();
    assert!(err.starts_with("E_ABD_PREVIEW_EXPIRED:"), "{err}");
}

#[tokio::test]
async fn start_refuses_backup_mode_without_a_mirror() {
    let rig = Rig::ready(scenario(2));
    rig.preview().await;
    let none = start_params("archive_backup_delete", "move_to_trash", "after_all", &["INBOX"], None);
    let err = rig.start(none).await.unwrap_err();
    assert!(err.starts_with("E_ABD_NO_BACKUP_DRIVE:"), "{err}");
    let gone = temp_dir("gone");
    std::fs::remove_dir_all(&gone).unwrap();
    let missing = start_params("archive_backup_delete", "move_to_trash", "after_all", &["INBOX"], Some(&gone));
    let err = rig.start(missing).await.unwrap_err();
    assert!(err.starts_with("E_ABD_NO_BACKUP_DRIVE:"), "{err}");
    assert!(rig.frame().is_none());
}

#[tokio::test]
async fn start_refuses_a_server_that_can_neither_move_nor_expunge_exactly() {
    let rig = Rig::ready(scenario(2).without_cap("MOVE").without_cap("UIDPLUS"));
    rig.preview().await;
    let err = rig.start(archive_params()).await.unwrap_err();
    assert!(err.starts_with("E_ABD_CANNOT_DELETE:"), "{err}");
    assert_eq!(rig.mock.count_commands("MOVE"), 0);
}

#[tokio::test]
async fn start_refuses_a_second_job_for_the_same_account() {
    let rig = Rig::ready(slow_fetches(6, 300));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    let err = rig.start(archive_params()).await.unwrap_err();
    assert!(err.starts_with("E_ABD_JOB_EXISTS:"), "{err}");

    // An unfinished job cannot be dismissed either.
    let err = rig.rpc("abd.dismiss", json!({"accountId": ACCT})).await.unwrap_err();
    assert!(err.starts_with("E_ABD_JOB_UNFINISHED:"), "{err}");

    rig.rpc("abd.cancel", json!({"accountId": ACCT})).await.unwrap();
    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("cancelled"));
}

// ── whole runs ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_full_backup_mode_run_empties_the_scope_and_fills_vault_and_mirror() {
    let rig = Rig::ready(scenario(30));
    let mirror = temp_dir("mirror");
    let mut rx = rig.state.events.subscribe();
    rig.preview().await;
    let p = start_params("archive_backup_delete", "move_to_trash", "after_all", &["INBOX"], Some(&mirror));
    let started = rig.start(p).await.unwrap();
    assert!(started["jobId"].as_str().unwrap().starts_with("abd-acc1-"));

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert_eq!(done["counts"]["deleted"], json!(30));
    assert_eq!(done["counts"]["onDrive"], json!(30));
    assert_eq!(done["counts"]["vaultVerified"], json!(30));
    assert_eq!(done["counts"]["kept"], json!(0));
    assert!(rig.inbox_uids().is_empty(), "the scoped mail left the server");
    let mut want: Vec<String> = (1..=30).map(|i| format!("m{i}@t.test")).collect();
    want.sort();
    assert_eq!(rig.trash_ids(), want, "moved to Trash, not deleted");
    assert_eq!(rig.vault_uids("INBOX"), (1..=30).collect::<Vec<u32>>());
    let on_drive = maildir::mirror_file_map(&mirror.join(EMAIL).join("INBOX").join("cur"));
    assert_eq!(on_drive.len(), 30, "backup mode mirrored every message first");

    // The end is announced once.
    let frames: Vec<Value> = drain(&mut rx).into_iter().filter(|(n, _)| n == "abd-progress").map(|(_, p)| p).collect();
    assert_eq!(frames.iter().filter(|f| f["finished"] == json!(true)).count(), 1, "one finished frame per job end");
    assert!(frames.last().unwrap()["finished"] == json!(true));

    // It never went through the deleted-mail bin.
    let bin = rig.rpc("deleted.list", json!({})).await.unwrap().to_string();
    assert!(!bin.contains("m1@t.test"), "{bin}");
}

#[tokio::test]
async fn a_full_archive_mode_run_never_touches_the_mirror() {
    let rig = Rig::ready(scenario(8));
    let mirror = temp_dir("mirror");
    rig.preview().await;
    // A mirror root sent along with the wrong mode is ignored.
    let mut p = archive_params();
    p["mirrorRoot"] = json!(mirror.to_string_lossy());
    rig.start(p).await.unwrap();

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert_eq!(done["counts"]["onDrive"], json!(0));
    assert!(rig.inbox_uids().is_empty());
    assert_eq!(rig.vault_uids("INBOX").len(), 8);
    assert_eq!(std::fs::read_dir(&mirror).unwrap().count(), 0, "not a file, not a folder on the drive");
}

#[tokio::test]
async fn folder_and_date_scope_select_exactly_the_expected_uids() {
    let mut mb = Mailbox::new("INBOX");
    for (i, y) in [2022, 2022, 2023, 2023, 2024, 2024, 2025, 2025].iter().enumerate() {
        mb.add(Message::new(i as u32 + 1, raw(&format!("m{}", i + 1))).with_internal_ms(ms(*y, 5, 5, 12)));
    }
    let rig = Rig::ready(Scenario::new().mailbox(mb).mailbox(trash()));
    rig.preview().await;
    let mut p = archive_params();
    p["dates"] = json!({"kind": "years", "years": [2023]});
    p["dateChoice"] = json!("years");
    rig.start(p).await.unwrap();

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert_eq!(rig.vault_uids("INBOX"), vec![3, 4]);
    assert_eq!(rig.inbox_uids(), vec![1, 2, 5, 6, 7, 8], "only the chosen year left the server");
    assert_eq!(rig.trash_ids(), vec!["m3@t.test".to_string(), "m4@t.test".to_string()]);
}

#[tokio::test]
async fn empty_mode_expunges_exactly_the_moved_uids_and_leaves_other_trash_mail() {
    let mut t = trash();
    t.add(Message::new(1, raw("old")).with_flags(&["\\Deleted"]));
    t.add(Message::new(2, raw("keep")));
    let rig = Rig::ready(Scenario::new().mailbox(inbox(10)).mailbox(t));
    rig.preview().await;
    let mut p = archive_params();
    p["deleteMode"] = json!("move_to_trash_and_empty");
    rig.start(p).await.unwrap();

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert_eq!(done["counts"]["emptied"], json!(10));
    assert!(rig.inbox_uids().is_empty());
    assert_eq!(rig.trash_ids(), vec!["keep@t.test".to_string(), "old@t.test".to_string()]);
    assert!(
        rig.mock.state().find("Trash").unwrap().by_uid(1).unwrap().has_flag("\\Deleted"),
        "the message someone else flagged is still there, still flagged"
    );
    assert_eq!(rig.mock.count_commands("EXPUNGE"), rig.mock.count_commands("UID EXPUNGE"), "never a plain EXPUNGE");
    assert_eq!(rig.vault_uids("INBOX").len(), 10);
}

#[tokio::test]
async fn after_all_sends_no_move_until_every_message_is_verified() {
    let rig = Rig::ready(slow_fetches(6, 250));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();

    // While the downloads are still coming in, nothing has left the server.
    let mut saw_partial = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    while rig.frame().map_or(true, |f| f["finished"] != json!(true)) {
        assert!(Instant::now() < deadline, "the job never finished");
        if rig.fetched() < 6 {
            saw_partial = true;
            assert_eq!(rig.mock.count_commands("MOVE"), 0, "no move before the last download");
            assert_eq!(rig.inbox_uids().len(), 6);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(saw_partial);
    assert!(rig.inbox_uids().is_empty());
}

#[tokio::test]
async fn a_delete_batch_removes_its_header_rows() {
    let rig = Rig::ready(scenario(5));
    let data = json!({
        "emails": (1..=5).map(|u| json!({"uid": u, "messageId": format!("<m{u}@t.test>")})).collect::<Vec<_>>(),
        "uidValidity": 1, "totalEmails": 5,
    })
    .to_string();
    crate::custody::with_conn(&rig.state, |c| mailvault_core::custody::cache::save_headers(c, ACCT, "INBOX", &data)).unwrap();
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    rig.finished().await;

    let left = crate::custody::with_conn(&rig.state, |c| mailvault_core::custody::cache::count(c, ACCT, "INBOX")).unwrap();
    assert_eq!(left, 0, "the open list stops showing rows the job deleted");
}

#[tokio::test]
async fn gmail_label_scope_moves_the_all_mail_copy_to_trash() {
    let sc = Scenario::gmail()
        .gmail_message(GmailMsg::new(raw("one")).labels(&["\\Inbox", "Work"]).gm_msgid(111))
        .gmail_message(GmailMsg::new(raw("two")).labels(&["Work"]).gm_msgid(222))
        .gmail_message(GmailMsg::new(raw("three")).gm_msgid(333));
    let rig = Rig::ready(sc);
    // The mock listens on 127.0.0.1: say it is Gmail.
    *lock(&rig.state.abd.test.gmail_host) = Some(true);
    rig.preview().await;
    let p = start_params("archive_delete", "move_to_trash", "after_all", &["Work"], None);
    rig.start(p).await.unwrap();

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert_eq!(done["provider"], json!("gmail"));
    let st = rig.mock.state();
    let ids = |name: &str| -> Vec<u64> {
        let mut v: Vec<u64> = st.find(name).unwrap().messages.iter().map(|m| m.gm_msgid.unwrap()).collect();
        v.sort_unstable();
        v
    };
    assert_eq!(ids("[Gmail]/All Mail"), vec![333], "the All Mail copy went, and with it every label");
    assert!(ids("Work").is_empty());
    assert!(ids("INBOX").is_empty(), "the other label of a scoped message goes too");
    assert_eq!(ids("[Gmail]/Trash"), vec![111, 222]);
    assert_eq!(rig.vault_uids("Work").len(), 2);
}

// ── limits, throttling ──────────────────────────────────────────────────────

#[tokio::test]
async fn the_allowance_waits_and_continues_after_the_clock_moves() {
    const MIB: u64 = 1024 * 1024;
    let noon = ms(2026, 3, 10, 12);
    let rig = Rig::ready(scenario(3));
    rig.preview().await;
    rig.state.clock.set(noon);
    std::fs::write(
        rig.dir.join("frontend-settings.json"),
        json!({"mailvault-settings": {"state": {"transferLimits": {ACCT: {"capEnabled": true, "dailyDownLimitBytes": MIB}}}}}).to_string(),
    )
    .unwrap();
    // The whole limit is spent on the UTC day the clock is stopped at.
    mailvault_core::app_db::with(&rig.dir, |c| mailvault_core::app_db::stats::add(c, ACCT, "2026-03-10", "daemon", MIB, 0))
        .unwrap();
    rig.start(archive_params()).await.unwrap();

    let waiting = rig.status_is("waiting", "daily_limit").await;
    let until = transfer_limits::next_utc_midnight_ms(noon) + 60_000;
    assert_eq!(waiting["status"]["untilMs"], json!(until), "the next UTC midnight, plus a minute");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(rig.fetched(), 0, "a spent day downloads nothing");
    assert_eq!(rig.inbox_uids().len(), 3);

    rig.state.clock.set(until);
    let ticker = spawn_ticker(&rig.state);
    let done = rig.finished().await;
    ticker.abort();
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert_eq!(rig.vault_uids("INBOX").len(), 3);
    assert!(rig.inbox_uids().is_empty());
}

#[tokio::test]
async fn a_throttled_fetch_backs_off_and_the_job_finishes() {
    let rig = Rig::ready(scenario(3).fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 2), Action::throttled()));
    rig.preview().await;
    let ticker = spawn_ticker(&rig.state);
    rig.start(archive_params()).await.unwrap();

    let done = rig.finished().await;
    ticker.abort();
    assert_eq!(done["outcome"], json!("completed"), "throttling never fails a job: {done}");
    assert_eq!(done["counts"]["kept"], json!(0));
    assert_eq!(rig.vault_uids("INBOX").len(), 3);
    assert_eq!(rig.fetched(), 4, "the refused fetch was asked again");
}

// ── drive ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_missing_drive_pauses_and_deletes_nothing_then_attach_mirror_resumes_the_job() {
    let rig = Rig::ready(slow_fetches(5, 250));
    let mirror = temp_dir("mirror");
    rig.preview().await;
    let p = start_params("archive_backup_delete", "move_to_trash", "after_all", &["INBOX"], Some(&mirror));
    rig.start(p).await.unwrap();
    // The drive is unplugged before the first batch is copied.
    std::fs::remove_dir_all(&mirror).unwrap();

    rig.status_is("paused", "drive_unavailable").await;
    assert_eq!(rig.inbox_uids().len(), 5, "nothing was deleted");
    assert!(rig.trash_ids().is_empty());
    assert_eq!(rig.mock.count_commands("MOVE"), 0);

    // A path that is not there is not an attachment.
    let no = rig.rpc("abd.attach_mirror", json!({"accountId": ACCT, "mirrorRoot": mirror.to_string_lossy()})).await.unwrap();
    assert_eq!(no["attached"], json!(false));
    // No job for another account: nothing to attach to.
    let other = rig.rpc("abd.attach_mirror", json!({"accountId": "other", "mirrorRoot": temp_dir("m2").to_string_lossy()})).await.unwrap();
    assert_eq!(other["attached"], json!(false));

    std::fs::create_dir_all(&mirror).unwrap();
    let yes = rig.rpc("abd.attach_mirror", json!({"accountId": ACCT, "mirrorRoot": mirror.to_string_lossy()})).await.unwrap();
    assert_eq!(yes["attached"], json!(true));

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert!(rig.inbox_uids().is_empty());
    assert_eq!(maildir::mirror_file_map(&mirror.join(EMAIL).join("INBOX").join("cur")).len(), 5);
}

#[tokio::test]
async fn attach_mirror_is_false_for_an_archive_mode_job() {
    let rig = Rig::ready(slow_fetches(4, 300));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    let r = rig.rpc("abd.attach_mirror", json!({"accountId": ACCT, "mirrorRoot": temp_dir("m").to_string_lossy()})).await.unwrap();
    assert_eq!(r["attached"], json!(false), "only a backup-mode job takes a drive");
    rig.rpc("abd.cancel", json!({"accountId": ACCT})).await.unwrap();
    rig.finished().await;
}

// ── pause, resume, cancel ───────────────────────────────────────────────────

#[tokio::test]
async fn pause_then_resume_continues_the_same_run() {
    let rig = Rig::ready(slow_fetches(30, 200));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    let before = rig.state.abd.handle(ACCT).unwrap();
    let mock_fetches = |r: &Rig| r.fetched();
    let watcher = Arc::clone(&rig.state);
    wait_for("a few downloads", 30, || (mock_fetches(&rig) >= 3).then_some(())).await;

    let paused = rig.rpc("abd.pause", json!({"accountId": ACCT})).await.unwrap();
    assert_eq!(paused["status"], json!({"state": "paused", "reason": "user"}));
    rig.status_is("paused", "user").await;
    let held = rig.fetched();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(rig.fetched() <= held + 1, "a paused job fetches nothing more ({} then {})", held, rig.fetched());

    let resumed = rig.rpc("abd.resume", json!({"accountId": ACCT})).await.unwrap();
    assert_eq!(resumed["status"]["state"], json!("running"));
    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    assert!(Arc::ptr_eq(&before, &watcher.abd.handle(ACCT).unwrap()), "one job handle, no second run");
    assert_eq!(rig.fetched(), 30, "every message was downloaded exactly once");
    assert_eq!(rig.vault_uids("INBOX").len(), 30);
}

#[tokio::test]
async fn cancel_keeps_what_was_not_deleted_on_the_server() {
    let rig = Rig::ready(slow_fetches(30, 150));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    wait_for("a few downloads", 30, || (rig.fetched() >= 3).then_some(())).await;

    let reply = rig.rpc("abd.cancel", json!({"accountId": ACCT})).await.unwrap();
    assert_eq!(reply["status"]["state"], json!("cancelled"));
    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("cancelled"), "{done}");
    assert_eq!(rig.inbox_uids().len(), 30, "with everything to be downloaded first, nothing left the server");
    assert!(rig.trash_ids().is_empty());
    assert!(!rig.vault_uids("INBOX").is_empty(), "what was saved stays saved");
    // The finished job can be dismissed, and its files go.
    let gone = rig.rpc("abd.dismiss", json!({"accountId": ACCT})).await.unwrap();
    assert_eq!(gone["removed"], json!(true));
    assert!(!rig.dir.join("abd").join(ACCT).exists());
    let listed = rig.rpc("abd.status", json!({})).await.unwrap();
    assert_eq!(listed["jobs"], json!([]));
}

// ── restart ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_job_resumes_after_a_daemon_restart_mid_batch() {
    let mut rig = Rig::ready(slow_fetches(40, 150));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    wait_for("28 downloads", 60, || (rig.fetched() >= 28).then_some(())).await;

    rig.restart().await;
    let cut = rig.mock.commands().len();
    // The listing is gone with the old daemon; the job comes back from its files.
    let listed = rig.rpc("abd.status", json!({})).await.unwrap();
    assert_eq!(listed["jobs"].as_array().unwrap().len(), 1, "{listed}");

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
    let again = fetched_uids(&rig.mock.commands()[cut..]);
    assert!(
        again.iter().all(|u| *u > 25),
        "nothing saved before the kill is downloaded again, got {again:?}"
    );
    assert!(rig.inbox_uids().is_empty());
    assert_eq!(rig.vault_uids("INBOX"), (1..=40).collect::<Vec<u32>>());
    let mut want: Vec<String> = (1..=40).map(|i| format!("m{i}@t.test")).collect();
    want.sort();
    assert_eq!(rig.trash_ids(), want);
}

#[tokio::test]
async fn status_lists_jobs_after_a_restart() {
    let mut rig = Rig::ready(scenario(3));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    rig.finished().await;

    rig.restart().await;
    let listed = rig.rpc("abd.status", json!({})).await.unwrap();
    let jobs = listed["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["finished"], json!(true));
    assert_eq!(jobs[0]["outcome"], json!("completed"));
    assert_eq!(jobs[0]["counts"]["deleted"], json!(3));
    let one = rig.rpc("abd.status", json!({"accountId": ACCT})).await.unwrap();
    assert_eq!(one["jobs"].as_array().unwrap().len(), 1);
    let other = rig.rpc("abd.status", json!({"accountId": "nobody"})).await.unwrap();
    assert_eq!(other["jobs"], json!([]));
}

#[tokio::test]
async fn a_job_file_that_cannot_be_read_is_reported_and_left_alone_until_dismissed() {
    let rig = Rig::idle(scenario(2));
    let dir = rig.dir.join("abd").join(ACCT);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("job.json"), "{ not json").unwrap();
    rig.start_worker();

    let f = wait_for("the failed job", 10, || {
        let h = rig.state.abd.handle(ACCT)?;
        Some(h.frame())
    })
    .await;
    assert_eq!(f["status"]["state"], json!("failed"));
    assert_eq!(f["finished"], json!(true));
    assert_eq!(std::fs::read_to_string(dir.join("job.json")).unwrap(), "{ not json", "left on disk");

    rig.preview().await;
    let err = rig.start(archive_params()).await.unwrap_err();
    assert!(err.starts_with("E_ABD_JOB_EXISTS:"), "never replaced by a fresh job: {err}");

    let gone = rig.rpc("abd.dismiss", json!({"accountId": ACCT})).await.unwrap();
    assert_eq!(gone["removed"], json!(true));
    assert!(!dir.exists());
}

// ── the token ───────────────────────────────────────────────────────────────

fn seed_graph_job(dir: &Path) -> JobFile {
    let job_dir = jobfile::job_dir(dir, ACCT).unwrap();
    let mut job = JobFile::create(NewJob {
        account_id: ACCT.to_string(),
        account_email: EMAIL.to_string(),
        host: "outlook.office365.com".to_string(),
        provider: Provider::Graph,
        mode: Mode::ArchiveDelete,
        timing: Timing::AfterAll,
        delete_mode: DeleteMode::MoveToTrash,
        scope: Scope { folders: vec!["Inbox".to_string()], dates: DateScope::All, date_choice: "all".to_string(), year_bounds: vec![] },
        now_ms: ms(2026, 3, 10, 12),
    });
    job.status = JobStatus::Running { phase: Phase::Download };
    job.caps = ServerCaps { uidplus: true, move_cmd: true, gmail_ext: false };
    job.trash = Some(TrashInfo { path: "Deleted Items".to_string(), uid_validity: None, graph_id: Some("deleteditems".to_string()) });
    job.folders = vec![FolderState {
        path: "Inbox".to_string(),
        role: FolderRole::Normal,
        plan_file: "plan-000.json".to_string(),
        scoped: 1,
        scoped_bytes: 100,
        ..Default::default()
    }];
    let plan = FolderPlan {
        version: 1,
        path: "Inbox".to_string(),
        graph_folder_id: Some("gid-inbox".to_string()),
        uid_validity: None,
        uids: vec![1],
        internal_ms: vec![ms(2025, 6, 1, 12)],
        sizes: vec![100],
        message_ids: vec![Some("g1@t.test".to_string())],
        gm_msgids: None,
        graph_ids: Some(vec!["gid1".to_string()]),
    };
    jobfile::save_plan(&job_dir, "plan-000.json", &plan).unwrap();
    jobfile::save_job(&job_dir, &job).unwrap();
    job
}

#[tokio::test]
async fn a_graph_job_without_a_token_pauses_and_set_token_resumes_it_and_the_token_goes_nowhere() {
    // A closed local port: whatever the job does with the token, it goes nowhere.
    std::env::set_var("MAILVAULT_GRAPH_BASE", "http://127.0.0.1:1");
    let logs = captured_logs();
    let mock = MockImap::start(Scenario::new());
    let rig = Rig::build(
        mock,
        json!({"id": ACCT, "email": EMAIL, "imapHost": "outlook.office365.com", "authType": "oauth2", "oauth2Transport": "graph"}),
    );
    seed_graph_job(&rig.dir);
    let mut rx = rig.state.events.subscribe();
    rig.start_worker();

    // No token was ever pushed: the job asks for one and waits.
    let paused = rig.status_is("paused", "sign_in_needed").await;
    assert_eq!(paused["provider"], json!("graph"));
    let mut events = drain(&mut rx);
    let asked = |evs: &[(String, Value)]| evs.iter().filter(|(n, _)| n == "abd-token-needed").count();
    wait_for("the token request", 10, || {
        events.extend(drain(&mut rx));
        (asked(&events) >= 1).then_some(())
    })
    .await;
    let first = events.iter().find(|(n, _)| n == "abd-token-needed").unwrap().1.clone();
    assert_eq!(first["accountId"], json!(ACCT));
    assert_eq!(first["provider"], json!("graph"));
    assert!(first["jobId"].as_str().unwrap().starts_with("abd-acc1-"));
    let asked_before = asked(&events);

    let token = "tok-SECRET-abc123XYZ";
    let reply = rig
        .rpc("abd.set_token", json!({"accountId": ACCT, "accessToken": token, "expiresAtMs": rig.state.clock.now_ms() + 3_600_000}))
        .await
        .unwrap();
    assert_eq!(reply, json!({}));

    // The job left the sign-in pause: it went on (and whatever the closed port
    // said, it said so with the token), or it asked once more.
    wait_for("the job to react to the token", 30, || {
        events.extend(drain(&mut rx));
        let f = rig.frame()?;
        let moved_on = !(f["status"]["state"] == json!("paused") && f["status"]["reason"] == json!("sign_in_needed"));
        (moved_on || asked(&events) > asked_before).then_some(())
    })
    .await;

    // The token is in memory only.
    let status = rig.rpc("abd.status", json!({})).await.unwrap().to_string();
    events.extend(drain(&mut rx));
    let job_dir = rig.dir.join("abd").join(ACCT);
    let mut files = String::new();
    for entry in std::fs::read_dir(&job_dir).unwrap().flatten() {
        files.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
    }
    let wire: String = events.iter().map(|(n, p)| format!("{n} {p}")).collect();
    let logged = String::from_utf8_lossy(&logs.lock().unwrap_or_else(|p| p.into_inner())).to_string();
    for (what, text) in [("status", &status), ("job files", &files), ("events", &wire), ("logs", &logged), ("reply", &reply.to_string())] {
        assert!(!text.contains(token), "the token leaked into the {what}");
    }
    assert!(!files.is_empty());

    rig.rpc("abd.cancel", json!({"accountId": ACCT})).await.unwrap();
    rig.finished().await;
}

#[test]
fn tokens_are_per_account_bump_a_generation_and_expire() {
    let t = abd_worker::Tokens::default();
    assert_eq!(t.seq("a"), 0);
    assert!(t.get("a").is_none());
    assert_eq!(t.set("a", Lease { token: "x".into(), expires_at_ms: 10_000_000 }), 1);
    assert_eq!(t.set("a", Lease { token: "y".into(), expires_at_ms: 10_000_000 }), 2);
    assert_eq!(t.seq("b"), 0, "generations are per account");
    assert_eq!(t.get("a").unwrap().token, "y");
    assert!(t.fresh("a", 9_000_000).is_some());
    assert!(t.fresh("a", 9_950_000).is_none(), "a lease that dies within the margin is not fresh");
    t.drop_lease("a");
    assert!(t.get("a").is_none());
    assert_eq!(t.seq("a"), 2, "a dropped lease keeps its generation");
    assert!(format!("{:?}", Lease { token: "secret".into(), expires_at_ms: 1 }).find("secret").is_none());
}

// ── the thread and the UI ───────────────────────────────────────────────────

#[tokio::test]
async fn the_job_runs_on_its_own_thread_not_the_ipc_runtime() {
    let rig = Rig::ready(scenario(3));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    rig.finished().await;

    let names = lock(&rig.state.abd.test.emit_threads).clone();
    assert!(!names.is_empty());
    assert!(names.iter().all(|n| n == "abd-worker"), "every frame was built on the abd-worker thread: {names:?}");
}

#[tokio::test]
async fn foreground_reads_stay_fast_while_a_job_runs() {
    let rig = Rig::ready(slow_fetches(30, 200));
    rig.preview().await;
    rig.start(archive_params()).await.unwrap();
    wait_for("a download", 30, || (rig.fetched() >= 1).then_some(())).await;

    let mut slowest = Duration::ZERO;
    for _ in 0..20 {
        let t = Instant::now();
        let _ = handle_request_for_test(
            &rig.state,
            "load_email_cache_partial",
            json!({"accountId": ACCT, "mailbox": "INBOX", "limit": 50}),
        )
        .await;
        slowest = slowest.max(t.elapsed());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(slowest < Duration::from_millis(500), "a click waited {slowest:?} behind a running job");

    rig.rpc("abd.cancel", json!({"accountId": ACCT})).await.unwrap();
    rig.finished().await;
}

#[tokio::test]
async fn the_job_waits_for_a_quiet_ui() {
    let rig = Rig::ready(scenario(3));
    rig.preview().await;
    let busy = {
        let s = Arc::clone(&rig.state);
        tokio::spawn(async move {
            // A click every 100 ms for a second.
            for _ in 0..10 {
                crate::search_index::note_foreground(&s.search_index);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
    };
    let began = Instant::now();
    rig.start(archive_params()).await.unwrap();
    // Well inside the busy second: no header read, no download.
    tokio::time::sleep(Duration::from_millis(700).saturating_sub(began.elapsed())).await;
    assert_eq!(rig.fetched(), 0, "no download while the user is busy");
    assert_eq!(rig.mock.count_commands("HEADER.FIELDS"), 0, "nor any other command of the job");
    busy.await.unwrap();

    let done = rig.finished().await;
    assert_eq!(done["outcome"], json!("completed"), "{done}");
}

// ── the local store ─────────────────────────────────────────────────────────

#[tokio::test]
async fn the_before_delete_check_reads_no_directory_unless_a_name_misses() {
    let dir = temp_dir("local");
    let mirror = temp_dir("mirror");
    let s = DaemonState::for_test(dir.clone(), dir.clone(), true);
    s.abd.attach(ACCT, &mirror.to_string_lossy());
    let local = DaemonLocal::new(Arc::clone(&s), ACCT, EMAIL);

    // Vault copies of uids 1 and 2; the drive holds 1 under the same name and 2
    // under another (a flag change renamed it there).
    let vault_cur = vault_files::cur_path(&dir, ACCT, "INBOX");
    let mirror_cur = mirror.join(EMAIL).join("INBOX").join("cur");
    std::fs::create_dir_all(&vault_cur).unwrap();
    std::fs::create_dir_all(&mirror_cur).unwrap();
    let name1 = vault_files::build_maildir_filename(1, &["archived".to_string()]);
    let name2 = vault_files::build_maildir_filename(2, &["archived".to_string()]);
    let renamed2 = vault_files::build_maildir_filename(2, &["archived".to_string(), "seen".to_string()]);
    for (uid, name) in [(1u32, &name1), (2, &name2)] {
        std::fs::write(vault_cur.join(name), raw(&format!("m{uid}"))).unwrap();
    }
    std::fs::write(mirror_cur.join(&name1), raw("m1")).unwrap();
    std::fs::write(mirror_cur.join(&renamed2), raw("m2")).unwrap();
    let expected: HashMap<u32, String> = HashMap::from([(1, "m1@t.test".to_string()), (2, "m2@t.test".to_string())]);

    let fast = local.mirror_verify_paths("INBOX", &[(1, name1.clone())], &expected).await.unwrap();
    assert_eq!(fast.ok, vec![1]);
    assert_eq!(s.abd.test.fallback_scans.load(std::sync::atomic::Ordering::SeqCst), 0, "opened by name: no read_dir");

    let slow = local.mirror_verify_paths("INBOX", &[(2, name2.clone())], &expected).await.unwrap();
    assert_eq!(slow.ok, vec![2], "found by uid once its name missed");
    assert_eq!(s.abd.test.fallback_scans.load(std::sync::atomic::Ordering::SeqCst), 1);
    let again = local.mirror_verify_paths("INBOX", &[(2, name2.clone()), (3, "3:2,A.eml".to_string())], &expected).await.unwrap();
    assert_eq!(again.ok, vec![2]);
    assert_eq!(again.missing, vec![3]);
    assert_eq!(s.abd.test.fallback_scans.load(std::sync::atomic::Ordering::SeqCst), 1, "the folder is listed once per pass");

    // Another message under the name is a mismatch, and an unplugged drive an error.
    std::fs::write(mirror_cur.join(&name1), raw("other")).unwrap();
    let bad = local.mirror_verify_paths("INBOX", &[(1, name1.clone())], &expected).await.unwrap();
    assert_eq!(bad.mismatched, vec![1]);
    std::fs::remove_dir_all(&mirror).unwrap();
    let gone = local.mirror_verify_paths("INBOX", &[(1, name1)], &expected).await;
    assert!(matches!(gone, Err(mailvault_core::abd::LocalError::DriveUnavailable(_))));
}

#[tokio::test]
async fn set_token_needs_an_account_a_token_and_an_expiry() {
    let dir = temp_dir("tok");
    let s = DaemonState::for_test(dir.clone(), dir, true);
    for p in [
        json!({"accessToken": "t", "expiresAtMs": 1}),
        json!({"accountId": "../etc", "accessToken": "t", "expiresAtMs": 1}),
        json!({"accountId": ACCT, "expiresAtMs": 1}),
        json!({"accountId": ACCT, "accessToken": "t"}),
    ] {
        assert!(rpc(&s, "abd.set_token", p).await.is_err());
    }
    assert!(s.abd.tokens.get(ACCT).is_none());
    rpc(&s, "abd.set_token", json!({"accountId": ACCT, "accessToken": "t", "expiresAtMs": 5.0e12})).await.unwrap();
    assert!(s.abd.tokens.get(ACCT).is_some(), "arrives before any job or listing exists");
}
