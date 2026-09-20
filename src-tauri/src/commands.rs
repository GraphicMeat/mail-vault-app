use tauri::Manager;

use crate::backup;

// `with_background`, `with_priority` and `conn_lost_message` moved to the
// daemon (Task 5.4a's `imap_get_email`/`imap_get_email_light`, Task 5.4b's
// remaining eight `imap_*` write/lifecycle commands — `src-daemon/src/
// handlers/imap.rs`), their only callers in this file. `PooledSessionGuard`/
// `ImapPool`/`ImapSession` are no longer imported here for the same reason.

// ── Test connection ─────────────────────────────────────────────────────────
//
// `imap_test_connection` moved to the daemon (Task 5.4b,
// `src-daemon/src/handlers/imap.rs`), same request/response JSON, same 20s
// timeout and timeout message text.

// `smtp_test_connection`, `smtp_build_mime`, `smtp_build_draft_mime` and
// `smtp_send_email` all moved to the daemon (Task 5.5, `src-daemon/src/
// handlers/smtp.rs`), same request/response JSON, routed via `transport.js`'s
// `DAEMON_OWNED` under their existing flat names — this was this file's last
// IMAP caller (`smtp_send_email`'s background Sent-folder APPEND used a
// dedicated `imap::create_imap_session_no_compress` session, never the app's
// pool) and last SMTP caller, so `use crate::imap::{self, ImapConfig}` and
// `use crate::smtp` are both gone from this file along with them.
// `smtp_send_email`'s `send-server-append-complete` event now goes through
// the daemon's own `EventBus` (`state.events.emit(...)`) instead of
// `app_handle.emit(...)` — `src-tauri/src/daemon_channel.rs` already
// re-emits any named daemon event to the frontend unchanged, so `Emitter` is
// no longer imported here either.

// ── List mailboxes ──────────────────────────────────────────────────────────

// `imap_get_mailboxes`, `imap_get_emails`, `imap_check_mailbox_status`,
// `imap_folder_status`, `imap_search_all_uids`, `imap_fetch_headers_by_uids`,
// `imap_fetch_changed_flags`, `imap_get_email` and `imap_get_email_light` all
// moved to the daemon (Task 5.4a, `src-daemon/src/handlers/imap.rs`), same
// request/response JSON, routed via `transport.js`'s `DAEMON_OWNED` under
// their existing names. `imap_get_email_light`'s auto-cache-to-vault side
// effect moved with it (now writing the already-in-memory bytes directly,
// no base64 round trip). `BODY_FETCH_TIMEOUT` moved with it too.

// `imap_set_flags`, `imap_delete_email`, `imap_ensure_sent_mailbox`,
// `imap_create_mailbox`, `imap_rename_mailbox` and `imap_delete_mailbox` all
// moved to the daemon (Task 5.4b, `src-daemon/src/handlers/imap.rs`), same
// request/response JSON, routed via `transport.js`'s `DAEMON_OWNED` under
// their existing names. `imap_ensure_sent_mailbox` still returns a bare
// string, not an object — matches its old `Result<String, String>`.

// `imap_search_emails` + its local `SearchFilters` moved to the daemon (Task
// 5.4a, `src-daemon/src/handlers/imap.rs`), same request/response JSON.

// `imap_find_message_id` and `imap_disconnect` moved to the daemon (Task
// 5.4b, `src-daemon/src/handlers/imap.rs`), same request/response JSON —
// `imap_find_message_id`'s reply is still the bare serialized probe struct,
// not wrapped in an object.

// `oauth2_auth_url`, `oauth2_exchange` and `oauth2_refresh` moved to the
// daemon (Task 5.7, `src-daemon/src/handlers/oauth2.rs`), same request/
// response JSON, routed via `transport.js`'s `DAEMON_OWNED` under their
// existing flat names. `OAuth2Manager` now lives ONCE in `DaemonState`
// (`state.oauth2`) instead of the app's `.manage(OAuth2Manager::new())` —
// its loopback callback listener (`127.0.0.1:19876`) now binds from inside
// the daemon process, not the app's (see the ledger for the unverified
// sandboxed-bind assumption this creates).

// `graph_list_folders`, `graph_list_messages`, `graph_get_message`,
// `graph_cache_mime`, `graph_set_read`, `graph_set_flagged`,
// `graph_delete_message`, `graph_move_emails`, `graph_create_folder`,
// `graph_rename_folder`, `graph_move_folder` and `graph_delete_folder` all
// moved to the daemon (Task 5.6, `src-daemon/src/handlers/graph.rs`), same
// request/response JSON, routed via `transport.js`'s `DAEMON_OWNED` under
// their existing flat names — `mailvault_core::graph::GraphClient` was
// already daemon-reachable (`backup.rs`, `src-daemon/src/migration.rs` both
// already construct it in-process), so this is the same stateless
// `GraphClient::new(&access_token)`-per-call pattern, just which process
// runs it. `graph_cache_mime`'s raw `std::fs::write` to the maildir `cur`
// path (bypassing `mailvault_core::vault_files::store`) moved with it
// unchanged — still the documented exception in architecture.md.
//
// `graph_get_mime` was NOT ported: 0 callers anywhere in `src/` (confirmed by
// grep before deleting), so it and its `generate_handler!` entry are deleted
// outright.

// `imap_move_emails` moved to the daemon (Task 5.4b,
// `src-daemon/src/handlers/imap.rs`), same request/response JSON.

// `resolve_email_settings` and `dns_mail_health` moved to the daemon (Task
// 5.8, `src-daemon/src/handlers/dns.rs`), same request/response JSON, routed
// via `transport.js`'s `DAEMON_OWNED` under their existing flat names.
// `mail_dns_health` (was `crate::dns::mail_dns_health`, only in src-tauri)
// moved into `mailvault_core::dns` with it — `src-tauri/src/dns.rs` had
// nothing app-local left afterward, so it's deleted outright rather than
// kept as a thin re-export. `src-tauri/src/smtp.rs` was kept as a re-export
// past Task 5.3/5.5 for the same reason dns.rs briefly was here (this file
// still called into it at the time) — once Task 5.5 removed that last
// caller it became equally dead weight, and Task 5.9's cleanup pass deleted
// it outright.

// ── Backup: Run account backup ───────────────────────────────────────────
//
// Both commands are forwarders now (Phase 3 remainder, Task 5): the runners,
// the status comparison and every vault/mirror write moved to the daemon
// (`src-daemon/src/handlers/backup.rs` over `mailvault_core::backup`). All
// that is left on this side is the backup mirror's security-scoped bookmark,
// which a daemon cannot resolve for itself — see `backup.rs`'s module doc for
// the two release shapes.

/// Starts the run and returns the daemon's `{"runId": accountId}` ACK — the
/// outcome arrives as `backup-progress` events, not as this reply.
#[tauri::command]
pub async fn backup_run_account(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    backup_path: Option<String>,
    skip_folders: Option<usize>,
    mailbox_concurrency: Option<usize>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        backup::run_account(
            &app_handle,
            account_id,
            account_json,
            backup_path,
            skip_folders.unwrap_or(0),
            mailbox_concurrency.unwrap_or(1),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn backup_status(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_json: String,
    backup_path: Option<String>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        backup::forward(&app_handle, "backup_status", backup_path, |resolved| {
            // The daemon has no bookmark API, so how the resolution went is
            // this side's to report — it passes these two straight through
            // onto the reply, exactly as the old app-side wrapper enriched
            // its own otherwise-`None` fields after the fact.
            let (status, error) = backup::external_status_fields(&app_handle, resolved);
            serde_json::json!({
                "accountId": account_id,
                "accountJson": account_json,
                "externalStatus": status,
                "externalError": error,
            })
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ── External backup location ─────────────────────────────────────────────

#[tauri::command]
pub async fn backup_save_external_location(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<crate::external_location::ExternalLocation, String> {
    // MAS builds gate external backups behind a non-consumable IAP. Non-MAS
    // builds always pass this check (stub returns true).
    if !crate::iap::is_entitled("com.mailvault.app.backups") {
        return Err("Cloud Backups requires a one-time in-app purchase. Open Settings → Backups to unlock.".to_string());
    }
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::save_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP, &path)
}

#[tauri::command]
pub async fn backup_get_external_location(
    app_handle: tauri::AppHandle,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::external_location::get_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP))
}

#[tauri::command]
pub async fn backup_validate_external_location(
    app_handle: tauri::AppHandle,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::validate_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP)
}

#[tauri::command]
pub async fn backup_clear_external_location(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::clear_external_location(&data_dir, crate::external_location::SLOT_EXTERNAL_BACKUP)
}

// ── In-app purchase (StoreKit on MAS, no-op stub elsewhere) ──────────────

/// Whether the given product is entitled. Non-MAS builds always return true.
#[tauri::command]
pub fn iap_is_entitled(product_id: String) -> bool {
    crate::iap::is_entitled(&product_id)
}

/// Start a StoreKit purchase. Resolves once the transaction completes.
/// On non-MAS builds this succeeds immediately (no paywall).
#[tauri::command]
pub async fn iap_purchase(product_id: String) -> Result<(), String> {
    crate::iap::purchase(&product_id).await
}

/// Restore prior non-consumable purchases for the signed-in Apple ID.
#[tauri::command]
pub async fn iap_restore() -> Result<(), String> {
    crate::iap::restore().await
}

#[tauri::command]
pub async fn backup_migrate_legacy_path(
    app_handle: tauri::AppHandle,
    legacy_path: String,
) -> Result<crate::external_location::ExternalLocation, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::external_location::migrate_legacy_path(&data_dir, &legacy_path)
}

// ── Transfer stats ──────────────────────────────────────────────────────────

/// Per-account wire bytes: the app's and the daemon's own stat files merged,
/// plus this process's not-yet-flushed counters. Optional `accountId` narrows
/// the result to one account.
#[tauri::command]
pub fn get_transfer_stats(
    app_handle: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;

    let mut accounts = mailvault_core::transfer_stats::read_all(&app_dir);
    if let Some(id) = account_id {
        accounts.retain(|k, _| *k == id);
    }
    serde_json::to_value(serde_json::json!({ "accounts": accounts }))
        .map_err(|e| format!("Serialization error: {}", e))
}
