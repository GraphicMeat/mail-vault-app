//! Task 3.2 Step 4: core-only tests for `mailvault_core::archive`. The app
//! crate never had these: it never called the gate at all (inventory N7:
//! `archive.rs` was one of the five ungated app writers), and a synthetic
//! custody-sink failure needed a live daemon round trip to reproduce. Now
//! that both are injected, the runner itself can be driven directly against
//! the mock IMAP server already used by the other `src-core/tests` files.

mod common;

use common::{config_for, eml, pool};
use mailvault_core::archive::{self, ArchiveCtx, ArchiveGate, ArchiveSinks};
use mailvault_core::maildir::INFO_PREFIX;
use mailvault_core::vault_registry::VaultRegistry;
use mock_imap::state::Mailbox;
use mock_imap::{MockImap, Scenario};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

fn inbox_with_one(uid: u32) -> Mailbox {
    let mut mb = Mailbox::new("INBOX");
    mb.add(mock_imap::Message::new(uid, eml("Subject", "sender@example.com", "body")));
    mb
}

/// `config_for` returns an `ImapConfig` (`Deserialize` only, no `Serialize`
/// impl, nothing else needed one), so the account JSON `run`/`bulk_delete`
/// want is rebuilt from its public fields rather than round-tripped through
/// the struct itself. Same shape `common::config_for` builds.
fn account_json(server: &MockImap) -> String {
    let cfg = config_for(server);
    serde_json::json!({
        "email": cfg.email,
        "password": cfg.password,
        "imapHost": cfg.host,
        "imapPort": cfg.port,
        "imapSecure": cfg.secure,
    })
    .to_string()
}

fn noop_sinks() -> ArchiveSinks {
    ArchiveSinks {
        emit: Arc::new(|_, _| {}),
        custody_append: Arc::new(|_, _, _| Ok(0)),
    }
}

/// A registry for `root`, its file in a tempdir of its own.
fn registry_for(root: &std::path::Path) -> (tempfile::TempDir, Arc<VaultRegistry>) {
    let app = tempfile::tempdir().expect("tempdir");
    let reg = Arc::new(VaultRegistry::open(app.path(), root));
    (app, reg)
}

fn always_open_gate() -> ArchiveGate {
    Arc::new(|work| work())
}

fn cur_dir(root: &std::path::Path, account_id: &str, mailbox: &str) -> std::path::PathBuf {
    mailvault_core::vault_files::cur_path(root, account_id, mailbox)
}

fn file_names(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// ── (a) a custody_append failure does not fail the run ──────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_custody_append_failure_does_not_fail_the_run() {
    let server = MockImap::start(Scenario::new().mailbox(inbox_with_one(1)));
    let root = tempfile::tempdir().expect("tempdir");
    let (_app, registry) = registry_for(root.path());

    let mut sinks = noop_sinks();
    // The daemon's real sink can fail (custody.db locked, disk full, etc.); the
    // run must still report the write as completed: a failed custody append
    // is logged and swallowed, not propagated (same continue-on-failure arms
    // `daemon_call_blocking`'s three-way match had before the move).
    sinks.custody_append = Arc::new(|_account, _mailbox, _entries_json| {
        Err("custody store unavailable: test".to_string())
    });

    let ctx = Arc::new(ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(pool()),
        gate: always_open_gate(),
        sinks,
        registry: Arc::clone(&registry),
    });

    let result = archive::run(
        ctx,
        "acct".to_string(),
        account_json(&server),
        "INBOX".to_string(),
        vec![1],
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .expect("run itself does not error");

    assert_eq!(result.completed, 1, "the vault write succeeded independently of custody");
    assert_eq!(result.errors, 0, "a custody sink failure is not a per-uid error");

    let written = file_names(&cur_dir(root.path(), "acct", "INBOX"));
    assert_eq!(written.len(), 1, "the .eml still landed on disk: {written:?}");
}

// ── (b) the gate holds across the write, it is not a check-then-write ───────

#[tokio::test(flavor = "multi_thread")]
async fn the_gate_wraps_the_write_entry_and_exit_bracket_it() {
    let server = MockImap::start(Scenario::new().mailbox(inbox_with_one(1)));
    let root = tempfile::tempdir().expect("tempdir");
    let (_app, registry) = registry_for(root.path());

    let order: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let order_for_gate = Arc::clone(&order);
    let gate: ArchiveGate = Arc::new(move |work| {
        order_for_gate.lock().unwrap().push("gate-enter");
        let r = work();
        order_for_gate.lock().unwrap().push("gate-exit");
        r
    });

    let ctx = Arc::new(ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(pool()),
        gate,
        sinks: noop_sinks(),
        registry: Arc::clone(&registry),
    });

    let result = archive::run(
        ctx,
        "acct".to_string(),
        account_json(&server),
        "INBOX".to_string(),
        vec![1],
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .expect("run does not error");

    assert_eq!(result.completed, 1);
    // The write is the closure `work()` itself: by the time `gate-exit` is
    // recorded, `work()` (and therefore the write) has already returned, so
    // the file was necessarily created while the gate was held, not before
    // or after it.
    assert_eq!(*order.lock().unwrap(), vec!["gate-enter", "gate-exit"]);
    assert_eq!(file_names(&cur_dir(root.path(), "acct", "INBOX")).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gate_that_refuses_leaves_no_file_on_disk() {
    // The negative control for the test above: if the write ever ran outside
    // the gate's control (a "checked once, then wrote regardless" bug), this
    // gate's refusal would not stop it and a file would still appear.
    let server = MockImap::start(Scenario::new().mailbox(inbox_with_one(1)));
    let root = tempfile::tempdir().expect("tempdir");
    let (_app, registry) = registry_for(root.path());

    let gate: ArchiveGate = Arc::new(|_work| Err("E_VAULT_UNAVAILABLE: closed for a move".to_string()));

    let ctx = Arc::new(ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(pool()),
        gate,
        sinks: noop_sinks(),
        registry: Arc::clone(&registry),
    });

    let result = archive::run(
        ctx,
        "acct".to_string(),
        account_json(&server),
        "INBOX".to_string(),
        vec![1],
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .expect("run does not error: the per-uid task reports the gate's refusal as a normal fetch error");

    assert_eq!(result.completed, 0);
    assert_eq!(result.errors, 1);
    assert!(
        file_names(&cur_dir(root.path(), "acct", "INBOX")).is_empty(),
        "a refusing gate must leave the write undone"
    );
}

// ── (c) remove_existing = false skips the per-message listing lookup ────────

#[tokio::test(flavor = "multi_thread")]
async fn remove_existing_false_leaves_a_stale_legacy_file_in_place() {
    let server = MockImap::start(Scenario::new().mailbox(inbox_with_one(1)));
    let root = tempfile::tempdir().expect("tempdir");
    let (_app, registry) = registry_for(root.path());
    let dir = cur_dir(root.path(), "acct", "INBOX");
    std::fs::create_dir_all(&dir).unwrap();
    // A pre-existing vault file for uid 1 under a different flag letter than
    // the freshly fetched (unflagged) message will get, so the fresh write's
    // filename cannot collide with it.
    std::fs::write(dir.join(&format!("1{INFO_PREFIX}S.eml")), b"stale").unwrap();

    let ctx = Arc::new(ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(pool()),
        gate: always_open_gate(),
        sinks: noop_sinks(),
        registry: Arc::clone(&registry),
    });

    let result = archive::run_with_backup(
        ctx,
        "acct".to_string(),
        account_json(&server),
        "INBOX".to_string(),
        vec![1],
        Arc::new(AtomicBool::new(false)),
        None,
        None,
        false, // remove_existing
        "archive",
    )
    .await
    .expect("run does not error");

    assert_eq!(result.completed, 1);
    let names = file_names(&dir);
    assert!(
        names.contains(&format!("1{INFO_PREFIX}S.eml")),
        "remove_existing=false must never look the uid up to remove it: {names:?}"
    );
    assert_eq!(names.len(), 2, "the stale file and the fresh write both survive: {names:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn remove_existing_true_removes_the_stale_legacy_file() {
    // Contrast for the test above, so it is not vacuously true regardless of
    // the flag: the plain archive path (remove_existing=true) does look the
    // uid up and replaces what it finds.
    let server = MockImap::start(Scenario::new().mailbox(inbox_with_one(1)));
    let root = tempfile::tempdir().expect("tempdir");
    let (_app, registry) = registry_for(root.path());
    let dir = cur_dir(root.path(), "acct", "INBOX");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&format!("1{INFO_PREFIX}S.eml")), b"stale").unwrap();

    let ctx = Arc::new(ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(pool()),
        gate: always_open_gate(),
        sinks: noop_sinks(),
        registry: Arc::clone(&registry),
    });

    let result = archive::run(
        ctx,
        "acct".to_string(),
        account_json(&server),
        "INBOX".to_string(),
        vec![1],
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .expect("run does not error");

    assert_eq!(result.completed, 1);
    let names = file_names(&dir);
    assert!(
        !names.contains(&format!("1{INFO_PREFIX}S.eml")),
        "remove_existing=true replaces the stale file it finds: {names:?}"
    );
    assert_eq!(names.len(), 1, "only the fresh write remains: {names:?}");
}

// ── (d) the vault registry holds every stored uid without a relisting ───────

#[tokio::test(flavor = "multi_thread")]
async fn a_run_leaves_its_rows_in_a_verified_registry_without_a_relisting() {
    let mut mb = Mailbox::new("INBOX");
    for uid in [1, 2] {
        mb.add(mock_imap::Message::new(uid, eml("Subject", "sender@example.com", "body")));
    }
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let root = tempfile::tempdir().expect("tempdir");
    let (_app, registry) = registry_for(root.path());
    // Verified before the run: an empty tempdir root lists as an empty folder.
    assert_eq!(registry.uid_sets(root.path(), "acct", "INBOX"), Some((vec![], vec![])));
    assert_eq!(registry.listing_count(), 1);

    let ctx = Arc::new(ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(pool()),
        gate: always_open_gate(),
        sinks: noop_sinks(),
        registry: Arc::clone(&registry),
    });
    let result = archive::run(
        ctx,
        "acct".to_string(),
        account_json(&server),
        "INBOX".to_string(),
        vec![1, 2],
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .expect("run does not error");
    assert_eq!(result.completed, 2);

    // `store_flags` always adds `archived`, so both are saved and archived.
    assert_eq!(registry.uid_sets(root.path(), "acct", "INBOX"), Some((vec![1, 2], vec![1, 2])));
    assert_eq!(registry.listing_count(), 1, "every row came from the run's own upserts");
    let names = file_names(&cur_dir(root.path(), "acct", "INBOX"));
    let held = registry.resolve(root.path(), "acct", "INBOX", 1).unwrap().unwrap();
    assert!(names.contains(&held.file_name().unwrap().to_string_lossy().into_owned()), "{held:?} vs {names:?}");
}
