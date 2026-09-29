//! A vault-only folder (MBOX import "as a separate folder", `local_folder`) in
//! an account backup run: no server lists it, so the run mirrors it on its
//! own, before the server folders, vault to backup only. Driven through the
//! public runners, against the mock IMAP server for the IMAP account.

mod common;

use common::{config_for, pool};
use mailvault_core::archive::{ArchiveCtx, ArchiveSinks};
use mailvault_core::backup::{self, BackupProgress, BackupRunContext};
use mailvault_core::local_folder;
use mailvault_core::maildir::{IMPORT_UID_BASE, INFO_PREFIX};
use mailvault_core::vault_flags::Applied;
use mailvault_core::vault_registry::VaultRegistry;
use mock_imap::state::synthetic_mailbox;
use mock_imap::{MockImap, Scenario};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const ACCOUNT: &str = "acct";
const EMAIL: &str = "user@example.com";
const DAY: &str = "2026-09-29";
const NAME: &str = "MBOX import 2026-09-29";
const DIR: &str = "MBOX_import_2026-09-29";
const B: u32 = IMPORT_UID_BASE;

struct Run {
    _vault: tempfile::TempDir,
    _app: tempfile::TempDir,
    root: PathBuf,
    mirror: PathBuf,
    frames: Arc<Mutex<Vec<BackupProgress>>>,
    cancel: Arc<AtomicBool>,
    /// Cancel the run the moment a frame names the local folder: before the
    /// pass asks about its first file.
    cancel_at_local: Arc<AtomicBool>,
}

impl Run {
    fn new(mirror: PathBuf) -> Run {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().to_path_buf();
        Run {
            _vault: vault,
            _app: tempfile::tempdir().unwrap(),
            root,
            mirror,
            frames: Arc::default(),
            cancel: Arc::default(),
            cancel_at_local: Arc::default(),
        }
    }

    fn account_dir(&self) -> PathBuf {
        self.root.join("Maildir").join(ACCOUNT)
    }

    /// The next marked folder of the day the way an import leaves it, with
    /// `uids` in its `cur/` (each body names its uid and `tag`). None: no
    /// `cur/` at all. Returns its dir and its `cur/`.
    fn local_folder(&self, created: u64, uids: Option<&[u32]>, tag: &str) -> (String, PathBuf) {
        let (_, dir) = local_folder::create_import_folder(&self.account_dir(), DAY, "takeout.mbox", created).unwrap();
        let cur = self.account_dir().join(&dir).join("cur");
        if let Some(uids) = uids {
            std::fs::create_dir_all(&cur).unwrap();
            for uid in uids {
                std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}A.eml")), body(*uid, tag)).unwrap();
            }
        }
        (dir, cur)
    }

    fn ctx(&self, account: serde_json::Value) -> BackupRunContext {
        let registry = Arc::new(VaultRegistry::open(self._app.path(), &self.root));
        let frames = Arc::clone(&self.frames);
        let (cancel, cancel_on, cancel_at_local) = (Arc::clone(&self.cancel), Arc::clone(&self.cancel), Arc::clone(&self.cancel_at_local));
        BackupRunContext {
            account_id: ACCOUNT.to_string(),
            account_json: account.to_string(),
            account: serde_json::from_value(account).unwrap(),
            app_dir: self._app.path().to_path_buf(),
            mirror_root: Some(self.mirror.to_string_lossy().into_owned()),
            cancel,
            skip_folders: 0,
            mailbox_concurrency: 1,
            archive_ctx: Arc::new(ArchiveCtx {
                root: self.root.clone(),
                pool: Arc::new(pool()),
                gate: Arc::new(|work| work()),
                sinks: ArchiveSinks { emit: Arc::new(|_, _| {}), custody_append: Arc::new(|_, _, _| Ok(0)) },
                registry,
            }),
            on_progress: Arc::new(move |p: BackupProgress| {
                if cancel_at_local.load(Ordering::SeqCst) && p.folder == NAME {
                    cancel_on.store(true, Ordering::SeqCst);
                }
                frames.lock().unwrap().push(p);
            }),
            apply_flags: Arc::new(|_, _| Ok(Applied::default())),
            limit: None,
        }
    }

    fn frames(&self) -> Vec<BackupProgress> {
        self.frames.lock().unwrap().clone()
    }
}

fn body(uid: u32, tag: &str) -> String {
    format!("From: takeout@gmail.test\r\nSubject: Import {uid}\r\nMessage-ID: <{tag}-{uid}@gmail.test>\r\n\r\n{tag} body {uid}\r\n")
}

fn imap_account(server: &MockImap) -> serde_json::Value {
    let cfg = config_for(server);
    serde_json::json!({"email": cfg.email, "password": cfg.password, "imapHost": cfg.host, "imapPort": cfg.port, "imapSecure": cfg.secure})
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

/// The mirror folder of the local folder `dir` created at `created`.
fn mirrored(mirror: &Path, dir: &str, created: u64) -> PathBuf {
    mirror.join(EMAIL).join(format!("{dir} ({created})")).join("cur")
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

/// The run copies the folder's files into its own mirror folder, keeping
/// each name, and says so in a progress frame named by the display name
/// before any server folder. The server folders are still backed up and are
/// the only ones the checkpoint counts. An unmarked directory no server lists
/// is not a local folder and is left alone.
#[tokio::test(flavor = "multi_thread")]
async fn an_imap_backup_mirrors_a_local_folder_into_a_folder_of_its_own() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let mirror = tempfile::tempdir().unwrap();
    let run = Run::new(mirror.path().to_path_buf());
    let (dir, cur) = run.local_folder(1_790_000_000_000, Some(&[B, B + 1]), "takeout");
    assert_eq!(dir, DIR);
    std::fs::rename(cur.join(file(B + 1, "A")), cur.join(file(B + 1, "AS"))).unwrap();
    let stray = run.account_dir().join("Stray").join("cur");
    std::fs::create_dir_all(&stray).unwrap();
    std::fs::write(stray.join(file(5, "A")), body(5, "stray")).unwrap();

    let result = backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap();

    assert!(result.success && !result.cancelled, "{:?}", result.error_message);
    let copy = mirrored(mirror.path(), DIR, 1_790_000_000_000);
    assert_eq!(names(&copy), vec![file(B, "A"), file(B + 1, "AS")], "every file, under its own name");
    assert_eq!(std::fs::read_to_string(copy.join(file(B, "A"))).unwrap(), body(B, "takeout"));
    assert_eq!(names(&cur), vec![file(B, "A"), file(B + 1, "AS")], "the vault is only read");
    assert!(!mirror.path().join(EMAIL).join("Stray").exists(), "an unmarked dir is not a local folder");
    assert_eq!(names(&mirror.path().join(EMAIL).join("INBOX/cur")).len(), 1, "the server folder is backed up as before");

    let frames = run.frames();
    let local = frames.iter().position(|f| f.folder == NAME && f.active).expect("a frame names the local folder");
    let inbox = frames.iter().position(|f| f.folder == "INBOX").expect("a frame names INBOX");
    assert!(local < inbox, "the local folder goes first");
    let last = frames.last().unwrap();
    assert!(!last.active && !last.cancelled);
    assert_eq!((last.completed_folders, last.total_folders), (1, 1), "the checkpoint counts server folders only");
}

/// Every delete in a local folder is local: no server holds the message and
/// nothing purges the mirror. Mirrored one way, the message the user deleted
/// stays deleted on the next run, and the mirror keeps its copy, as it keeps
/// every copy it was given.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_deleted_from_a_local_folder_stays_deleted_after_the_next_backup() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let mirror = tempfile::tempdir().unwrap();
    let run = Run::new(mirror.path().to_path_buf());
    let (_, cur) = run.local_folder(7, Some(&[B, B + 1, B + 2]), "takeout");

    let first = backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap();
    assert!(first.success);
    assert_eq!(names(&mirrored(mirror.path(), DIR, 7)).len(), 3);

    std::fs::remove_file(cur.join(file(B + 1, "A"))).unwrap();
    let second = backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap();

    assert!(second.success);
    assert_eq!(names(&cur), vec![file(B, "A"), file(B + 2, "A")], "the deleted message did not come back");
    assert_eq!(names(&mirrored(mirror.path(), DIR, 7)).len(), 3, "the mirror keeps its copy");
}

/// A folder deleted and imported again the same day has the same name and
/// restarts at the same uids. It gets a mirror folder of its own: its
/// messages are copied although the old folder's mirror holds those uids, and
/// none of the old folder's messages lands in it.
#[tokio::test(flavor = "multi_thread")]
async fn a_folder_imported_again_under_a_freed_name_gets_a_mirror_of_its_own() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let mirror = tempfile::tempdir().unwrap();
    let run = Run::new(mirror.path().to_path_buf());
    run.local_folder(1_000, Some(&[B, B + 1]), "first");
    assert!(backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap().success);
    std::fs::remove_dir_all(run.account_dir().join(DIR)).unwrap();

    let (dir, cur) = run.local_folder(2_000, Some(&[B]), "second");
    assert_eq!(dir, DIR, "the name is free again");
    assert!(backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap().success);

    assert_eq!(names(&cur), vec![file(B, "A")], "nothing of the deleted folder came in");
    assert_eq!(std::fs::read_to_string(mirrored(mirror.path(), DIR, 2_000).join(file(B, "A"))).unwrap(), body(B, "second"));
    assert_eq!(names(&mirrored(mirror.path(), DIR, 2_000)), vec![file(B, "A")]);
    assert_eq!(names(&mirrored(mirror.path(), DIR, 1_000)), vec![file(B, "A"), file(B + 1, "A")], "the old mirror is kept as it was");
    assert_eq!(std::fs::read_to_string(mirrored(mirror.path(), DIR, 1_000).join(file(B, "A"))).unwrap(), body(B, "first"));
}

/// A folder the import made but filled with nothing (no `cur/`), and one
/// emptied (an empty `cur/`): the run succeeds, copies nothing, and gives the
/// vault no directory it did not have.
#[tokio::test(flavor = "multi_thread")]
async fn a_local_folder_with_no_mail_is_fine() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let mirror = tempfile::tempdir().unwrap();
    let run = Run::new(mirror.path().to_path_buf());
    let (no_cur_dir, no_cur) = run.local_folder(1, None, "none");
    let (empty_dir, empty) = run.local_folder(2, Some(&[]), "none");

    let result = backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap();

    assert!(result.success && !result.cancelled, "{:?}", result.error_message);
    assert!(!no_cur.exists(), "the vault got no cur/ it did not have");
    assert!(empty.is_dir() && names(&empty).is_empty());
    assert!(names(&mirrored(mirror.path(), &no_cur_dir, 1)).is_empty());
    assert!(names(&mirrored(mirror.path(), &empty_dir, 2)).is_empty());
}

/// A backup location that cannot be written (here a path through a file, as
/// a drive gone mid-run answers): the local pass skips it quietly and the run
/// goes on, the vault untouched.
#[tokio::test(flavor = "multi_thread")]
async fn a_backup_location_that_is_gone_skips_the_local_pass_and_the_run_goes_on() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let blocker = tempfile::tempdir().unwrap();
    std::fs::write(blocker.path().join("unplugged"), b"a file, not a drive").unwrap();
    let run = Run::new(blocker.path().join("unplugged").join("mirror"));
    let (_, cur) = run.local_folder(3, Some(&[B]), "takeout");

    let result = backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap();

    assert!(result.success, "{:?}", result.error_message);
    assert_eq!(names(&cur), vec![file(B, "A")]);
}

/// A cancel reaches the local pass between files: here it lands as the
/// folder starts, so nothing of it is copied, and the run ends cancelled.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_stops_the_local_pass_between_files() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
    let mirror = tempfile::tempdir().unwrap();
    let run = Run::new(mirror.path().to_path_buf());
    let (_, cur) = run.local_folder(4, Some(&[B, B + 1]), "takeout");
    run.cancel_at_local.store(true, Ordering::SeqCst);

    let result = backup::run_imap_account(run.ctx(imap_account(&server))).await.unwrap();

    assert!(result.cancelled, "the run saw the cancel");
    assert!(names(&mirrored(mirror.path(), DIR, 4)).is_empty(), "no file copied after the cancel");
    assert_eq!(names(&cur).len(), 2);
    assert!(run.cancel.load(Ordering::SeqCst));
}

// ── Graph ─────────────────────────────────────────────────────────────────────

/// A Graph account's local folders sit in the same account dir and are
/// mirrored the same way. The pass runs before the run needs the server, so
/// a run that cannot start (no token here) still leaves them on the drive.
#[tokio::test(flavor = "multi_thread")]
async fn a_graph_accounts_local_folder_is_mirrored_even_when_the_run_cannot_start() {
    let mirror = tempfile::tempdir().unwrap();
    let run = Run::new(mirror.path().to_path_buf());
    run.local_folder(5, Some(&[B, B + 1]), "takeout");
    let account = serde_json::json!({"email": EMAIL, "imapHost": "outlook.office365.com", "oauth2Transport": "graph"});

    let result = backup::run_graph_account(run.ctx(account)).await;

    assert!(result.is_err_and(|e| e.contains("access token")));
    assert_eq!(names(&mirrored(mirror.path(), DIR, 5)), vec![file(B, "A"), file(B + 1, "A")]);
    assert!(run.frames().iter().any(|f| f.folder == NAME && f.active));
}
