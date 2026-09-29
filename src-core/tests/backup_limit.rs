//! The daily download limit against `backup::run_imap_account`: a backup is
//! background work, so it stops the moment the day's allowance is spent, says
//! so on its terminal frame (`stop_reason: "limit_reached"`, the limit and the
//! next UTC midnight), and carries on once the clock has crossed midnight.
//!
//! The allowance is scripted (a closure over an injected `Clock`), not read
//! from a settings file: which bytes the wire counted is `transfer_limits`'
//! own unit tests' business. What is proved here is what the RUN does with it.

mod common;

use common::{config_for, pool};
use mailvault_core::archive::{ArchiveCtx, ArchiveGate, ArchiveSinks};
use mailvault_core::backup::{self, BackupProgress, BackupResult, BackupRunContext, STOP_LIMIT_REACHED};
use mailvault_core::transfer_limits::{next_utc_midnight_ms, Allowance, BackgroundLimit, Clock};
use mailvault_core::vault_registry::VaultRegistry;
use mock_imap::state::synthetic_mailbox;
use mock_imap::{MockImap, Scenario};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const NOON: i64 = 1_773_144_000_000; // 2026-03-10T12:00:00Z

fn stored(root: &Path) -> usize {
    let cur = mailvault_core::vault_files::cur_path(root, "acct", "INBOX");
    std::fs::read_dir(cur).map(|d| d.flatten().count()).unwrap_or(0)
}

/// One backup run over `server`'s INBOX into `root`, returning the result and
/// every `backup-progress` frame it emitted.
async fn run(
    server: &MockImap,
    root: &Path,
    limit: Option<BackgroundLimit>,
    skip_folders: usize,
) -> (BackupResult, Vec<BackupProgress>) {
    let config = config_for(server);
    let account_json = serde_json::json!({
        "email": config.email,
        "password": config.password,
        "imapHost": config.host,
        "imapPort": config.port,
        "imapSecure": config.secure,
    })
    .to_string();
    let app = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(VaultRegistry::open(app.path(), root));
    let gate: ArchiveGate = Arc::new(|work| work());
    let archive_ctx = Arc::new(ArchiveCtx {
        root: root.to_path_buf(),
        pool: Arc::new(pool()),
        gate,
        sinks: ArchiveSinks { emit: Arc::new(|_, _| {}), custody_append: Arc::new(|_, _, _| Ok(0)) },
        registry,
    });
    let frames: Arc<Mutex<Vec<BackupProgress>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&frames);
    let ctx = BackupRunContext {
        account_id: "acct".to_string(),
        account_json,
        account: config,
        app_dir: app.path().to_path_buf(),
        mirror_root: None,
        cancel: Arc::new(AtomicBool::new(false)),
        skip_folders,
        mailbox_concurrency: 1,
        archive_ctx,
        on_progress: Arc::new(move |p| sink.lock().unwrap().push(p)),
        apply_flags: Arc::new(|_, _| Ok(Default::default())),
        limit,
    };
    let result = backup::run_imap_account(ctx).await.expect("the run itself does not error");
    let frames = frames.lock().unwrap().clone();
    (result, frames)
}

fn terminal(frames: &[BackupProgress]) -> &BackupProgress {
    let last = frames.last().expect("a run always emits a terminal frame");
    assert!(!last.active, "the last frame must be the terminal one");
    assert_eq!(frames.iter().filter(|f| !f.active).count(), 1, "exactly one terminal frame per run");
    last
}

#[tokio::test(flavor = "multi_thread")]
async fn a_day_that_starts_spent_stops_the_backup_before_it_lists_anything() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 4)));
    let root = tempfile::tempdir().expect("tempdir");
    let limit = BackgroundLimit::with_allowance(
        Arc::new(|| Some(Allowance { limit_bytes: 2000, used_bytes: 2000 })),
        Clock::pinned(NOON),
    );

    let (result, frames) = run(&server, root.path(), Some(limit), 2).await;

    let last = terminal(&frames);
    assert_eq!(last.stop_reason, Some(STOP_LIMIT_REACHED));
    assert_eq!(last.limit_bytes, Some(2000));
    assert_eq!(last.resume_after_ms, Some(next_utc_midnight_ms(NOON) as u64), "resume at the next UTC midnight");
    assert!(last.cancelled, "the app's checkpoint branch keys off `cancelled`");
    assert!(!last.success);
    assert_eq!(last.completed_folders, 2, "the resume position handed in is the one handed back");
    assert!(last.last_error.is_none(), "no prose rides on the frame: the app words the stop from the limit");
    assert_eq!(stored(root.path()), 0, "nothing was downloaded");
    assert!(result.cancelled);
    assert_eq!(result.emails_backed_up, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_backup_stops_mid_folder_at_the_limit_and_finishes_after_midnight() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 6)));
    let root = tempfile::tempdir().expect("tempdir");

    // Day one lets the first four looks through (the start-of-run look, the
    // folder's own look and the first two messages); every look after is spent. From the next UTC
    // midnight on there is no limit at all.
    let clock = Clock::pinned(NOON);
    let looks = Arc::new(AtomicUsize::new(0));
    let script = {
        let (clock, looks) = (clock.clone(), Arc::clone(&looks));
        move || -> Option<Allowance> {
            if clock.now_ms() >= next_utc_midnight_ms(NOON) {
                return None;
            }
            let n = looks.fetch_add(1, Ordering::SeqCst);
            Some(Allowance { limit_bytes: 500, used_bytes: if n < 4 { 0 } else { 500 } })
        }
    };
    let limit = || BackgroundLimit::with_allowance(Arc::new(script.clone()), clock.clone()).check_every(1);

    let (first, frames) = run(&server, root.path(), Some(limit()), 0).await;
    let stop = terminal(&frames);
    assert_eq!(stop.stop_reason, Some(STOP_LIMIT_REACHED));
    assert_eq!(stop.limit_bytes, Some(500));
    assert!(stop.cancelled);
    assert_eq!(stop.completed_folders, 0, "the folder was not finished, so the resume position stays put");
    assert_eq!(stop.completed_emails, 2, "the two messages let through were backed up");
    assert_eq!(stored(root.path()), 2);
    assert_eq!(first.emails_backed_up, 2);
    assert_eq!(stop.errors, 0, "stopping at the limit is not a failed message");

    // The scheduler runs the account again after `resume_after_ms`.
    clock.set(stop.resume_after_ms.expect("a limit stop says when to come back") as i64);
    let (second, frames) = run(&server, root.path(), Some(limit()), stop.completed_folders).await;
    let done = terminal(&frames);
    assert_eq!(done.stop_reason, None, "the new day has no limit to hit");
    assert!(!done.cancelled);
    assert!(done.success);
    assert_eq!(stored(root.path()), 6, "the remaining four messages arrived");
    assert_eq!(second.emails_backed_up, 4, "the folder recomputed what was missing");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_backup_with_no_limit_never_reports_one() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
    let root = tempfile::tempdir().expect("tempdir");

    // Cap off: the allowance is `None` however often it is asked.
    let limit = BackgroundLimit::with_allowance(Arc::new(|| None), Clock::pinned(NOON)).check_every(1);
    let (result, frames) = run(&server, root.path(), Some(limit), 0).await;
    let last = terminal(&frames);
    assert_eq!(last.stop_reason, None);
    assert_eq!(last.limit_bytes, None);
    assert_eq!(last.resume_after_ms, None);
    assert!(last.success && !last.cancelled);
    assert_eq!(result.emails_backed_up, 3);

    // And a run handed no limit at all is the run it always was.
    let root2 = tempfile::tempdir().expect("tempdir");
    let (result, frames) = run(&server, root2.path(), None, 0).await;
    assert_eq!(terminal(&frames).stop_reason, None);
    assert_eq!(result.emails_backed_up, 3);
}
