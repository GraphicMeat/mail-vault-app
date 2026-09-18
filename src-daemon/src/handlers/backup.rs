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
//! kind). Task 4 adds `backup_cancel` (looks the account up, sets its flag,
//! tolerant of a missing/already-finished account like the app-side
//! `backup_cancel` it replaces) and makes the map's entry-removal
//! panic-safe: `BackupRunGuard` below, moved into the spawned task and
//! dropped at the end of its body on every exit path — success, error, or a
//! panic — same shape `handlers::common::RunGuard` uses for `run_tokens`,
//! sized to this map's single-`Arc`-per-key shape instead of that one's
//! `Vec`-per-kind shape.
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
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::warn;

/// RAII guard for one entry in `DaemonState.backup_runs`. Constructed right
/// after the entry is inserted and moved into the spawned run's async block,
/// so it is held across that task's whole body and its `Drop` removes the
/// entry on every exit path — normal completion, an early `?`-return inside
/// the run, or a panic unwinding through the block (`panic = "abort"` in
/// this crate's `[profile.release]` only; the test/dev profile unwinds, so
/// `Drop` runs there too, same posture `handlers::archive`'s `RunGuard`
/// panic tests document). Removes by `Arc::ptr_eq`, never by key alone, so a
/// guard from a finished run can never evict a newer run's token for the
/// same account (`backup_runs`'s doc comment in `server.rs`).
struct BackupRunGuard {
    state: Arc<DaemonState>,
    account_id: String,
    cancel: Arc<AtomicBool>,
}

impl Drop for BackupRunGuard {
    fn drop(&mut self) {
        let mut runs = self.state.backup_runs.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = runs.get(&self.account_id) {
            if Arc::ptr_eq(existing, &self.cancel) {
                runs.remove(&self.account_id);
            }
        }
    }
}

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
    let guard = BackupRunGuard { state: Arc::clone(state), account_id: account_id.clone(), cancel: Arc::clone(&cancel) };

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
    tokio::spawn(async move {
        // Held for this whole block: dropped at the end, on every exit path
        // (normal return, `result` holding an `Err`, or a panic unwinding
        // through this async block), which removes this run's own
        // `backup_runs` entry — never a newer run's for the same account,
        // since `BackupRunGuard::drop` only removes by `Arc::ptr_eq`.
        let _guard = guard;

        let result = if is_graph { backup::run_graph_account(ctx).await } else { backup::run_imap_account(ctx).await };

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
                // An early `?`-return isn't a user cancel, and it means the
                // run never got far enough to know its own external-copy
                // outcome — `false` is the conservative default so nothing
                // downstream mistakes "unknown" for "succeeded".
                cancelled: false,
                // The one frame that is neither a completion nor a cancel.
                // Explicit, because JS reads `success !== false` and would
                // otherwise file this dead run as a clean backup of zero
                // messages — see `BackupProgress::success` (Task 7b).
                success: false,
                external_copy_ok: false,
                external_copy_error: None,
                external_copy_failed_count: 0,
            };
            if let Ok(v) = serde_json::to_value(&progress) {
                state2.events.emit("backup-progress", v);
            }
        }
    });

    Ok(serde_json::json!({"runId": account_id}))
}

/// Cancels one account's in-flight backup run by setting its `AtomicBool` in
/// `state.backup_runs`. Tolerant like the app-side `backup_cancel` it
/// replaces (`src-tauri/src/commands.rs`): that command always stores `true`
/// on whatever `BackupCancelToken` currently holds, never erroring whether a
/// run is active or not. Here, an unknown or already-finished `accountId`
/// (no entry in the map) is just a no-op — not an error — and the entry is
/// left in place either way; the run itself (or `BackupRunGuard`, on exit)
/// owns removing it, never this route.
pub(crate) async fn backup_cancel(state: &Arc<DaemonState>, params: Value) -> Result<Value, String> {
    let account_id = params.get("accountId").and_then(Value::as_str).ok_or("Missing accountId")?.to_string();
    if let Some(cancel) = state.backup_runs.lock().unwrap_or_else(|p| p.into_inner()).get(&account_id) {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(serde_json::json!({}))
}

// ── Status / purge / scan (Task 3) ───────────────────────────────────────────
//
// Unlike `backup_run_account` above, none of these three is long-running —
// each is a bounded IMAP/Graph round trip or a couple of `read_dir`s, so
// they run as ordinary blocking-style async handlers with no
// `tokio::spawn`/fire-and-forget and no cancel-token bookkeeping.
//
// All three take an already-resolved `mirrorRoot` (and, where the app-side
// behavior needs it, `externalStatus`/`externalError`) exactly like
// `backup_run_account`'s own `mirrorRoot` param: resolving a security-scoped
// bookmark stays a Tauri-shell concern (`external_location.rs`) the daemon
// has no API for — see `mailvault_core::backup`'s module doc.

/// Compare server email counts vs the vault/mirror backup counts for one
/// account. Calls into `mailvault_core::backup::get_backup_status`, reusing
/// this daemon's own `imap_pool` (no second pool, unlike the app-side
/// original's process-global `pool()` singleton — that duplication doesn't
/// exist here).
pub(crate) async fn backup_status(state: &Arc<DaemonState>, params: Value) -> Result<Value, String> {
    let account_id = params.get("accountId").and_then(Value::as_str).ok_or("Missing accountId")?.to_string();
    let account_json = params.get("accountJson").and_then(Value::as_str).ok_or("Missing accountJson")?.to_string();
    let mirror_root = params.get("mirrorRoot").and_then(Value::as_str).map(str::to_string);
    let external_status = params.get("externalStatus").and_then(Value::as_str).map(str::to_string);
    let external_error = params.get("externalError").and_then(Value::as_str).map(str::to_string);

    let account: mailvault_core::imap::ImapConfig =
        serde_json::from_str(&account_json).map_err(|e| format!("Bad account JSON: {}", e))?;

    let root = common::vault_root(state)?;
    let mirror_path = mirror_root.as_deref().map(Path::new);

    let status =
        backup::get_backup_status(&state.imap_pool, &account_id, &account, &root, mirror_path, external_status, external_error)
            .await?;

    serde_json::to_value(status).map_err(|e| format!("serialize backup status: {}", e))
}

/// Delete (or queue, if the mirror is unreachable) a set of uids from the
/// external backup mirror. Calls into `mailvault_core::backup::purge_uids`.
pub(crate) async fn backup_purge_uids(state: &Arc<DaemonState>, params: Value) -> Result<Value, String> {
    let email = params.get("email").and_then(Value::as_str).ok_or("Missing email")?.to_string();
    let mailbox = params.get("mailbox").and_then(Value::as_str).ok_or("Missing mailbox")?.to_string();
    let uids: Vec<u32> = params
        .get("uids")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or("Missing or invalid uids")?;
    let mirror_root = params.get("mirrorRoot").and_then(Value::as_str).map(str::to_string);
    let external_status = params.get("externalStatus").and_then(Value::as_str).map(str::to_string);

    let mirror_path = mirror_root.as_deref().map(Path::new);
    let outcome = backup::purge_uids(&state.app_dir, mirror_path, external_status.as_deref(), &email, &mailbox, &uids)?;

    serde_json::to_value(outcome).map_err(|e| format!("serialize purge outcome: {}", e))
}

/// Which uids of `<email>/<mailbox>` are present in the external mirror, or
/// `null` if that can't be determined (no mirror resolved). Calls into
/// `mailvault_core::backup::scan_uids` — see that function's doc comment for
/// the `None`/`Some(vec![])` distinction this route must not blur: `null` vs
/// `[]` on the wire.
pub(crate) async fn backup_scan_uids(_state: &Arc<DaemonState>, params: Value) -> Result<Value, String> {
    let email = params.get("email").and_then(Value::as_str).ok_or("Missing email")?.to_string();
    let mailbox = params.get("mailbox").and_then(Value::as_str).ok_or("Missing mailbox")?.to_string();
    let mirror_root = params.get("mirrorRoot").and_then(Value::as_str).map(str::to_string);

    let mirror_path = mirror_root.as_deref().map(Path::new);
    let uids = backup::scan_uids(mirror_path, &email, &mailbox);

    serde_json::to_value(uids).map_err(|e| format!("serialize scan result: {}", e))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "backup_run_account" => match backup_run_account(state, params.clone()).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        "backup_cancel" => match backup_cancel(state, params.clone()).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        "backup_status" => match backup_status(state, params.clone()).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        "backup_purge_uids" => match backup_purge_uids(state, params.clone()).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        "backup_scan_uids" => match backup_scan_uids(state, params.clone()).await {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        _ => return None,
    })
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
