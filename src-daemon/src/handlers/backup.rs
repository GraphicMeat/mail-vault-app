//! Daemon route for the account backup run (Phase 3 remainder, Task 1),
//! calling into `mailvault_core::backup::run_imap_account` with the same
//! `ArchiveCtx` a manual archive run would build (`handlers::archive::archive_ctx`,
//! widened to `pub(crate)` for this reuse — same pool, vault root, write
//! gate and in-process custody/nudge sinks a manual archive run gets, an
//! improvement over the app-side runner this replaces, which had no gate at
//! all) plus two daemon-specific sinks: `backup-progress` events on the
//! shared bus, and the flag catch-up wired straight to
//! `handlers::vault_flags::apply_flags` in-process (no more
//! `daemon_call_blocking("vault_apply_flags", ...)` RPC bridge against
//! itself, `backup.rs:850-886`).
//!
//! Fire-and-forget, same shape `handlers/migration.rs`'s `spawn_migration`
//! uses: `backup_run_account` returns `{"runId": accountId}` immediately —
//! the run itself reports progress over `channel.open` ("backup-progress"
//! events), not over this RPC's reply. No cutover in this task: nothing
//! calls this route yet (mirrors `handlers/migration.rs`'s own posture).
//!
//! Cancellation is `DaemonState.backup_runs`, keyed by `account_id` (see its
//! doc comment in `server.rs` for why this is not another `run_tokens`
//! kind) — no `cancel_backup` route in this task.
//!
//! Task 2 adds the Graph dispatch below (`is_graph` check, same test
//! `src-tauri/src/backup.rs`'s `run_account_backup` makes at ~line 618-621):
//! `backup_run_account` builds one `BackupRunContext` and hands it to
//! whichever runner the account's `oauth2_transport` calls for. The Graph
//! runner reuses the same `archive_ctx` (root, pool, gate) and the same
//! `on_progress`/`apply_flags` closures — it just never calls `apply_flags`,
//! matching `run_graph_backup`'s own behavior today (no read-state catch-up
//! on the Graph path).

use crate::handlers::common;
use crate::handlers::vault_flags as vault_flags_handler;
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::backup::{self, BackupProgress, BackupRunContext};
use mailvault_core::vault_flags::{Applied, FlagChange};
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tracing::warn;

/// Builds the run context and spawns the run; returns immediately with
/// `{"runId": accountId}`. Callable directly (as this module's own tests do)
/// as well as through `route`, same split `handlers::vault_flags::apply_flags`
/// uses.
pub(crate) async fn backup_run_account(state: &Arc<DaemonState>, params: Value) -> Result<Value, String> {
    let account_id = params.get("accountId").and_then(Value::as_str).ok_or("Missing accountId")?.to_string();
    let account_json = params.get("accountJson").and_then(Value::as_str).ok_or("Missing accountJson")?.to_string();
    let mirror_root = params.get("mirrorRoot").and_then(Value::as_str).map(str::to_string);
    let skip_folders = params.get("skipFolders").and_then(Value::as_u64).unwrap_or(0) as usize;

    let account: mailvault_core::imap::ImapConfig =
        serde_json::from_str(&account_json).map_err(|e| format!("Bad account JSON: {}", e))?;

    let root = common::vault_root(state)?;
    let archive_ctx = crate::handlers::archive::archive_ctx(state, root);

    let cancel = Arc::new(AtomicBool::new(false));
    state.backup_runs.lock().unwrap_or_else(|p| p.into_inner()).insert(account_id.clone(), Arc::clone(&cancel));

    let on_progress: Arc<dyn Fn(BackupProgress) + Send + Sync> = {
        let bus = state.events.clone();
        Arc::new(move |progress: BackupProgress| {
            if let Ok(v) = serde_json::to_value(&progress) {
                bus.emit("backup-progress", v);
            }
        })
    };

    // Mailbox + changes only — account id/email, mirror root and
    // `sidecars: false` are all fixed for the whole run, so the closure
    // closes over them instead of the caller threading five args through
    // every catch-up call site.
    let apply_flags: Arc<dyn Fn(&str, &[FlagChange]) -> Result<Applied, String> + Send + Sync> = {
        let state = Arc::clone(state);
        let account_id = account_id.clone();
        let account_email = account.email.clone();
        let mirror_root = mirror_root.clone();
        Arc::new(move |mailbox: &str, changes: &[FlagChange]| {
            vault_flags_handler::apply_flags(&state, &account_id, mailbox, Some(&account_email), mirror_root.as_deref(), changes, false)
        })
    };

    let ctx = BackupRunContext {
        account_id: account_id.clone(),
        account_json,
        account,
        app_dir: state.app_dir.clone(),
        mirror_root,
        cancel: Arc::clone(&cancel),
        skip_folders,
        archive_ctx,
        on_progress,
        apply_flags,
    };

    // Same dispatch `src-tauri/src/backup.rs`'s `run_account_backup`
    // (~line 618-621) does today, checked before the context is moved into
    // whichever runner gets it.
    let is_graph = ctx.account.oauth2_transport.as_deref() == Some("graph");

    let state2 = Arc::clone(state);
    let run_account_id = account_id.clone();
    let run_cancel = Arc::clone(&cancel);
    tokio::spawn(async move {
        let result = if is_graph { backup::run_graph_account(ctx).await } else { backup::run_imap_account(ctx).await };

        // Remove this run's own token — never a newer run's for the same
        // account (ptr_eq, not by key alone): a fresh run for this account
        // may already have replaced this entry in `backup_runs` by the time
        // this one finishes.
        {
            let mut runs = state2.backup_runs.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(existing) = runs.get(&run_account_id) {
                if Arc::ptr_eq(existing, &run_cancel) {
                    runs.remove(&run_account_id);
                }
            }
        }

        // `run_imap_account` emits its own terminal `backup-progress` frame
        // (`active: false`) on every path that reaches the end of its folder
        // loop. It only does NOT reach that when it `?`-returns early (LIST
        // or UID FETCH failing outright) — that's the one case this task
        // must still tell JS about, and the only one: emitting here
        // unconditionally would give JS two `active:false` frames per run.
        if let Err(e) = result {
            warn!("backup_run_account: {} failed before its own terminal event: {}", run_account_id, e);
            let progress = BackupProgress {
                account_id: run_account_id.clone(),
                folder: "Error".to_string(),
                total_folders: 0,
                completed_folders: 0,
                total_emails: 0,
                completed_emails: 0,
                errors: 0,
                active: false,
                last_error: Some(e),
                missing_in_folder: 0,
            };
            if let Ok(v) = serde_json::to_value(&progress) {
                state2.events.emit("backup-progress", v);
            }
        }
    });

    Ok(serde_json::json!({"runId": account_id}))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "backup_run_account" => match backup_run_account(state, params.clone()).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        _ => return None,
    })
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
