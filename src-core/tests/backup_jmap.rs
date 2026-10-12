//! `backup::run_jmap_account` and the JMAP backup status (Task 9b) against
//! the mock JMAP server: every mailbox's emails land in the vault and the
//! mirror in the existing layout (`<mirror>/<email>/<path>/cur`), under the
//! uids the mailbox's JMAP ledger gives them, oldest first.
//!
//! Fixture (`common_jmap::scenario`): Inbox (e1 seen, e2 flagged), Work,
//! Work/Sub (e3), Trash; e1 is also in Work.

mod common_jmap;

use common_jmap::{E1_RAW, E2_RAW};
use mailvault_core::archive::{ArchiveCtx, ArchiveSinks};
use mailvault_core::backup::{self, BackupProgress, BackupRunContext};
use mailvault_core::graph_ledger;
use mailvault_core::header_cache::sidecar_dir;
use mailvault_core::imap::{ImapConfig, ImapPool};
use mailvault_core::maildir::INFO_PREFIX;
use mailvault_core::vault_flags::Applied;
use mailvault_core::vault_registry::VaultRegistry;
use mock_jmap::MockJmap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const ACCOUNT: &str = "acct";
const EMAIL: &str = "alice@example.test";

struct Run {
    _vault: tempfile::TempDir,
    _app: tempfile::TempDir,
    _mirror: tempfile::TempDir,
    root: PathBuf,
    mirror: PathBuf,
    frames: Arc<Mutex<Vec<BackupProgress>>>,
}

impl Run {
    fn new() -> Run {
        let (vault, mirror) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (root, mirror_path) = (vault.path().to_path_buf(), mirror.path().to_path_buf());
        Run { _vault: vault, _app: tempfile::tempdir().unwrap(), _mirror: mirror, root, mirror: mirror_path, frames: Arc::default() }
    }

    fn ctx(&self, account: serde_json::Value) -> BackupRunContext {
        let frames = Arc::clone(&self.frames);
        BackupRunContext {
            account_id: ACCOUNT.to_string(),
            account_json: account.to_string(),
            account: serde_json::from_value(account).unwrap(),
            app_dir: self._app.path().to_path_buf(),
            mirror_root: Some(self.mirror.to_string_lossy().into_owned()),
            cancel: Arc::default(),
            skip_folders: 0,
            mailbox_concurrency: 1,
            archive_ctx: Arc::new(ArchiveCtx {
                root: self.root.clone(),
                pool: Arc::new(ImapPool::new()),
                gate: Arc::new(|work| work()),
                sinks: ArchiveSinks { emit: Arc::new(|_, _| {}), custody_append: Arc::new(|_, _, _| Ok(0)) },
                registry: Arc::new(VaultRegistry::open(self._app.path(), &self.root)),
            }),
            on_progress: Arc::new(move |p: BackupProgress| frames.lock().unwrap().push(p)),
            apply_flags: Arc::new(|_, _| Ok(Applied::default())),
            limit: None,
        }
    }

    fn mirror_cur(&self, mailbox: &str) -> PathBuf {
        mailbox.split('/').fold(self.mirror.join(EMAIL), |dir, part| dir.join(part)).join("cur")
    }

    /// The uid the mailbox's JMAP ledger gave `id`.
    fn uid(&self, mailbox: &str, id: &str) -> u32 {
        let ledger = graph_ledger::load(&graph_ledger::ledger_path(&sidecar_dir(&self.root, ACCOUNT, mailbox), true)).unwrap();
        ledger.into_iter().find(|(_, v)| v == id).map(|(uid, _)| uid).unwrap_or_else(|| panic!("no ledger row for {id} in {mailbox}"))
    }
}

fn account(m: &MockJmap) -> serde_json::Value {
    serde_json::json!({
        "email": EMAIL,
        "imapHost": "127.0.0.1",
        "password": "pw",
        "jmapSessionUrl": m.session_url(),
        "jmapAuth": "basic",
    })
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).map(|e| e.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

fn file(uid: u32, flags: &str) -> String {
    format!("{uid}{INFO_PREFIX}{flags}.eml")
}

fn downloads(m: &MockJmap) -> usize {
    m.requests().iter().filter(|r| r.path.contains("/jmap/download/")).count()
}

#[tokio::test(flavor = "multi_thread")]
async fn backup_jmap_account_copies_every_message_into_the_mirror_layout() {
    let m = MockJmap::start(common_jmap::scenario());
    let run = Run::new();

    let result = backup::run_jmap_account(run.ctx(account(&m))).await.unwrap();

    assert_eq!((result.emails_backed_up, result.errors, result.success), (4, 0, true));
    let (e1, e2) = (run.uid("INBOX", "e1"), run.uid("INBOX", "e2"));
    assert_eq!((e1, e2), (1, 2), "oldest first, as the sync numbers them");
    let inbox = run.mirror_cur("INBOX");
    assert_eq!(names(&inbox), [file(e1, "AS"), file(e2, "AF")]);
    assert_eq!(std::fs::read(inbox.join(file(e1, "AS"))).unwrap(), E1_RAW.as_bytes());
    assert_eq!(std::fs::read(inbox.join(file(e2, "AF"))).unwrap(), E2_RAW.as_bytes());
    assert_eq!(names(&run.mirror_cur("Work")), [file(run.uid("Work", "e1"), "AS")], "e1's Work label is its own copy");
    assert_eq!(names(&run.mirror_cur("Work/Sub")), [file(run.uid("Work/Sub", "e3"), "A")]);
    assert!(names(&run.mirror_cur("Trash")).is_empty(), "an empty mailbox writes nothing");
    let vault_inbox = mailvault_core::vault_files::cur_path(&run.root, ACCOUNT, "INBOX");
    assert_eq!(names(&vault_inbox), names(&inbox), "the vault holds the same copies");
    let frames = run.frames.lock().unwrap().clone();
    let last = frames.last().expect("a terminal frame");
    assert!(!last.active && last.success && !last.cancelled);
    assert_eq!((last.completed_emails, last.completed_folders, last.total_folders), (4, 4, 4));
}

/// Plan A Task 14: backed up into a JMAP-format vault, each message is a
/// record carrying the server's ids, and nothing is written as a Maildir file.
#[tokio::test(flavor = "multi_thread")]
async fn backup_jmap_into_a_jmap_vault_records_the_server_ids() {
    use mailvault_core::message_store::{self, Format};
    let m = MockJmap::start(common_jmap::scenario());
    let run = Run::new();
    message_store::set_vault_format(&run.root, Format::Jmap).unwrap();

    let result = backup::run_jmap_account(run.ctx(account(&m))).await.unwrap();

    assert_eq!((result.emails_backed_up, result.errors), (4, 0));
    for (mailbox, id) in [("INBOX", "e1"), ("INBOX", "e2"), ("Work", "e1"), ("Work/Sub", "e3")] {
        let uid = run.uid(mailbox, id);
        let record = message_store::mailbox_dir(&run.root, ACCOUNT, mailbox).join("jmap").join(format!("{uid}.json"));
        let rec: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        let blob = m.read(|s| s.email("acc1", id).map(|e| e.blob_id.clone())).unwrap();
        assert_eq!(rec["server"], serde_json::json!({"emailId": id, "blobId": blob, "threadId": format!("T{id}")}), "{mailbox} {id}");
        assert_eq!((rec["email"]["id"].as_str(), rec["email"]["threadId"].as_str()), (Some(id), Some(format!("T{id}").as_str())));
    }
    assert!(names(&mailvault_core::vault_files::cur_path(&run.root, ACCOUNT, "INBOX")).is_empty(), "no Maildir file in a JMAP vault");
}

#[tokio::test(flavor = "multi_thread")]
async fn backup_jmap_second_run_fetches_only_what_arrived() {
    let m = MockJmap::start(common_jmap::scenario());
    let run = Run::new();
    backup::run_jmap_account(run.ctx(account(&m))).await.unwrap();
    let fetched = downloads(&m);
    assert_eq!(fetched, 4);

    let again = backup::run_jmap_account(run.ctx(account(&m))).await.unwrap();
    assert_eq!((again.emails_backed_up, downloads(&m)), (0, fetched), "nothing fetched twice");

    m.mutate(|s| s.add_email("acc1", "mb-inbox", common_jmap::email("e4", "four", "2026-10-04T10:00:00Z")));
    let third = backup::run_jmap_account(run.ctx(account(&m))).await.unwrap();

    assert_eq!((third.emails_backed_up, downloads(&m)), (1, fetched + 1));
    assert_eq!(run.uid("INBOX", "e4"), 3, "the next uid");
    assert!(names(&run.mirror_cur("INBOX")).contains(&file(3, "A")));
}

#[tokio::test(flavor = "multi_thread")]
async fn backup_jmap_status_counts_server_vault_and_mirror() {
    let m = MockJmap::start(common_jmap::scenario());
    let run = Run::new();
    backup::run_jmap_account(run.ctx(account(&m))).await.unwrap();
    let config: ImapConfig = serde_json::from_value(account(&m)).unwrap();

    let status = backup::get_backup_status(&ImapPool::new(), ACCOUNT, &config, &run.root, Some(&run.mirror), None, None).await.unwrap();

    assert_eq!((status.total_server, status.total_app, status.total_external), (4, 4, 4));
    let rows: Vec<(&str, usize, usize, usize)> =
        status.folders.iter().map(|f| (f.path.as_str(), f.server_count, f.app_count, f.external_count)).collect();
    assert_eq!(rows, [("INBOX", 2, 2, 2), ("Work", 1, 1, 1), ("Work/Sub", 1, 1, 1)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn backup_jmap_account_without_credentials_fails_before_any_request() {
    let m = MockJmap::start(common_jmap::scenario());
    let run = Run::new();
    let mut no_password = account(&m);
    no_password.as_object_mut().unwrap().remove("password");

    let err = backup::run_jmap_account(run.ctx(no_password)).await.err().expect("refused");

    assert!(err.starts_with("E_JMAP_AUTH"), "{err}");
    assert!(m.requests().is_empty(), "nothing leaves the machine without credentials");
}
