//! A full account backup must not consume the reader's priority permits.
mod common;
use common::{config_for, pool};
use mailvault_core::{
    archive::{ArchiveCtx, ArchiveSinks},
    backup::{run_imap_account, BackupRunContext},
    vault_registry::VaultRegistry,
};
use mock_imap::{state::synthetic_mailbox, MockImap, Scenario};
use std::{
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};

#[tokio::test]
async fn full_backup_fetches_on_background_with_all_priority_leases_held() {
    let mailbox = synthetic_mailbox("INBOX", 1);
    let expected = mailbox.messages[0].raw.clone();
    let server = MockImap::start(Scenario::new().mailbox(mailbox));
    let account = config_for(&server);
    let pool = Arc::new(pool());
    let mut readers = Vec::new();
    for _ in 0..5 {
        readers.push(pool.get_priority(&account).await.unwrap());
    }
    assert_eq!(
        server.connection_count(),
        5,
        "five actual priority leases must be held"
    );
    let vault = tempfile::tempdir().unwrap();
    let app = tempfile::tempdir().unwrap();
    let frames = Arc::new(Mutex::new(Vec::new()));
    let sink = frames.clone();
    let ctx = BackupRunContext {
        account_id: "acct".into(),
        account_json: String::new(),
        account: account.clone(),
        app_dir: app.path().into(),
        mirror_root: None,
        cancel: Arc::new(AtomicBool::new(false)),
        skip_folders: 0,
        mailbox_concurrency: 1,
        limit: None,
        on_progress: Arc::new(move |p| sink.lock().unwrap().push(p)),
        apply_flags: Arc::new(|_, _| Ok(Default::default())),
        archive_ctx: Arc::new(ArchiveCtx {
            root: vault.path().into(),
            pool: pool.clone(),
            gate: Arc::new(|work| work()),
            registry: Arc::new(VaultRegistry::open(app.path(), vault.path())),
            sinks: ArchiveSinks {
                emit: Arc::new(|_, _| {}),
                custody_append: Arc::new(|_, _, _| Ok(0)),
            },
        }),
    };
    let mut running = tokio::spawn(run_imap_account(ctx));
    // Borrow the task handle: a failed observation cannot abort its provider
    // or blocking writes. Release every reader and actually join on both paths.
    let before_release = tokio::time::timeout(Duration::from_secs(1), &mut running).await;
    let completed_while_held = before_release.is_ok();
    let observed_fetch = server
        .commands()
        .iter()
        .any(|c| c.to_ascii_uppercase().contains("BODY.PEEK[]"));
    for reader in readers {
        pool.return_priority(&account, reader).await;
    }
    let outcome = match before_release {
        Ok(joined) => joined.unwrap(),
        Err(_) => tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .unwrap()
            .unwrap(),
    }
    .unwrap();
    assert_eq!(outcome.emails_backed_up, 1);
    assert!(outcome.success);
    let frames = frames.lock().unwrap();
    assert_eq!(frames.iter().filter(|p| !p.active).count(), 1);
    let cur = mailvault_core::vault_files::cur_path(vault.path(), "acct", "INBOX");
    let files = std::fs::read_dir(cur)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    assert_eq!(std::fs::read(&files[0]).unwrap(), expected);
    assert!(
        completed_while_held && observed_fetch,
        "backup body waited on exhausted priority permits while background capacity was free"
    );
}
