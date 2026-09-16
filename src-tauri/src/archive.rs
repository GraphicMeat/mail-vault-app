use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::{Emitter, Manager};

use mailvault_core::archive::{ArchiveCtx, ArchiveSinks};
use mailvault_core::imap::ImapPool;

// The runner itself (`ArchiveProgress`, `DrivePace`, `run`/`run_with_backup`'s
// body, `fetch_and_store`, `bulk_delete`, `delete_single_email`) moved to
// `mailvault_core::archive` (Task 3.2). Re-exported so `main.rs`'s command
// signatures and `backup.rs:797`'s field reads need no changes.
pub use mailvault_core::archive::ArchiveProgress;

// ── Cancellation token (shared app state) ─────────────────────────────────────
//
// Stays in the app for now (dies in Task 3.5, when `archive_emails` and
// `bulk_delete_emails` themselves move to the daemon and cancellation becomes
// daemon state).

pub struct ArchiveCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);

impl Default for ArchiveCancelToken {
    fn default() -> Self {
        ArchiveCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

// ── App shim: builds the core runner's context from an AppHandle ─────────────

/// The app's vault gate: a named no-op, not `|work| work()` inline. The app
/// cannot take the daemon's `vault_gate` `RwLock` across the process boundary
/// (attachments-bridge B.5): this is the sanctioned, deliberate absence of
/// gating for the app-side path, not an oversight. `archive.rs` stays on the
/// Phase 2 "ungated app writer" list for exactly this reason (inventory N7;
/// Task 3.9 records it in `architecture.md`).
fn app_has_no_vault_gate(work: &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> {
    work()
}

fn build_ctx(app_handle: &tauri::AppHandle) -> Result<Arc<ArchiveCtx>, String> {
    let root = crate::vault::root(app_handle)?;
    let pool = Arc::new(app_handle.state::<ImapPool>().inner().clone());

    let emit_handle = app_handle.clone();
    let emit: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync> =
        Arc::new(move |name: &str, payload: serde_json::Value| {
            let _ = emit_handle.emit(name, payload);
        });

    let custody_handle = app_handle.clone();
    let custody_append: Arc<dyn Fn(&str, &str, String) -> Result<usize, String> + Send + Sync> =
        Arc::new(move |account_id: &str, mailbox: &str, entries_json: String| {
            // Same bridge Task 2.9b already put here: custody.db is the
            // daemon's file, so this goes over RPC until the daemon has its
            // own archive route (Task 3.4) with an in-process append. The
            // reply's count is not read: the caller logs how many entries
            // it handed over, not how many the daemon actually upserted
            // (task-2.11 carry-in M7a), so `Ok(0)` here changes nothing a
            // caller reads.
            crate::daemon_call_blocking(
                &custody_handle,
                "local_index_append",
                serde_json::json!({"accountId": account_id, "mailbox": mailbox, "entriesJson": entries_json}),
                std::time::Duration::from_secs(30),
            )
            .map(|_| 0usize)
        });

    let nudge: Arc<dyn Fn(&str, &str) + Send + Sync> =
        Arc::new(|account_id: &str, mailbox: &str| crate::nudge_index(account_id, mailbox));

    Ok(Arc::new(ArchiveCtx {
        root,
        pool,
        gate: Arc::new(app_has_no_vault_gate),
        sinks: ArchiveSinks { emit, custody_append, nudge },
    }))
}

// ── Entry points backup.rs and the (still-Tauri) commands call ───────────────

pub async fn run(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
) -> Result<ArchiveProgress, String> {
    run_with_backup(app_handle, account_id, account_json, mailbox, uids, cancel, None, None, true, "archive").await
}

pub async fn run_with_backup(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
    backup_path: Option<String>,
    account_email: Option<String>,
    // A backup run only ever fetches uids the local scan just proved absent, so
    // the per-message read_dir looking for a stale copy is pure disk cost on the
    // one path that can least afford it. The plain archive path passes true:
    // there a uid the user re-archives can well be on disk already.
    remove_existing: bool,
    // "archive" from the still-Tauri archive_emails command (via `run`
    // above), "backup" from backup.rs's own call (Task 3.3, R3.2).
    operation: &'static str,
) -> Result<ArchiveProgress, String> {
    let ctx = build_ctx(&app_handle)?;
    mailvault_core::archive::run_with_backup(
        ctx, account_id, account_json, mailbox, uids, cancel, backup_path, account_email, remove_existing, operation,
    ).await
}

pub async fn bulk_delete(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    mailbox: String,
    uids: Vec<u32>,
    cancel: Arc<AtomicBool>,
) -> Result<ArchiveProgress, String> {
    let ctx = build_ctx(&app_handle)?;
    mailvault_core::archive::bulk_delete(ctx, account_id, account_json, mailbox, uids, cancel).await
}
