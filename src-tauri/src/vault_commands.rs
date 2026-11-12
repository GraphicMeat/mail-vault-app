//! Mail storage location commands (forwards to the daemon, resolves the bookmark).

use super::*;

// ==========================================
// Maildir .eml storage commands (remaining app-side writers)
//
// The read family and the attachment cache (maildir_read, maildir_read_light,
// maildir_read_light_batch, maildir_read_raw_source, maildir_read_attachment(s),
// maildir_exists, maildir_list, maildir_storage_stats, maildir_orphan_stats,
// cache_attachment, cached_attachment_path, prefetch_attachments) moved to
// the daemon (Task 2.6, `handlers::vault_files`), and the six simple writers
// (maildir_store, maildir_delete, maildir_set_flags, maildir_clear_cache,
// maildir_migrate_json_to_eml, maildir_migrate_email_dirs) moved with them
// (Task 2.8) — DAEMON_OWNED in transport.js, no Tauri command left for any of
// them. The custody-backed trio (maildir_delete_many,
// maildir_repair_generation, maildir_purge_orphans) followed in Task 2.9b,
// once custody.db itself opened in the daemon. `maildir_store_raw` (its only
// caller, `commands.rs`'s `imap_get_email_light`) moved to the daemon in
// Task 5.4a too — `handlers::imap` writes the already-in-memory bytes
// directly via `vault_files`'s store fn (called with overwrite: false),
// no base64 round trip, no app-side function left to call. What is left here
// is the three vault_flags forwarders in `vault_flags.rs`, which exist only
// to resolve the backup mirror's security-scoped bookmark for the daemon.
// ==========================================

// ── Mail storage location ───────────────────────────────────────────────────

/// Phase 6: the disk check (does the configured path still look like our
/// vault) now runs in the daemon (`handlers::vault::route`'s
/// `vault_get_status`, backed by fields the daemon computed once at its own
/// startup). This is a forward, not a cache read any more — see the phase 6
/// plan doc's accepted staleness trade-off (a poll racing an adopt/move's
/// restart window can be briefly stale; the `vault-status` event, emitted
/// straight after that restart, is what the frontend actually reconciles
/// against — `VaultAlertBanner.jsx` already swallows this call's rejection).
#[tauri::command]
pub(crate) async fn vault_get_status(app_handle: tauri::AppHandle) -> Result<vault::VaultStatus, String> {
    tokio::task::spawn_blocking(move || {
        let value = daemon_call_blocking(&app_handle, "vault_get_status", serde_json::json!({}), std::time::Duration::from_secs(30))?;
        serde_json::from_value(value).map_err(|e| format!("vault_get_status: unreadable reply: {e}"))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub(crate) fn vault_inspect_folder(path: String) -> Result<vault::FolderInspection, String> {
    vault::inspect_folder(&path)
}

/// Point the app at a folder that already holds the mail (drive reconnected at
/// a new path, or the folder was moved by hand). The classification and
/// marker work now run in the daemon (`handlers::vault::route`'s
/// `vault_adopt`); this command still owns the bookmark (spec §3.4) and the
/// close/restart choreography around it.
///
/// Async + blocking thread: closing the search index waits on its mutex.
#[tauri::command]
pub(crate) async fn vault_adopt(app_handle: tauri::AppHandle, path: String) -> Result<vault::VaultStatus, String> {
    tokio::task::spawn_blocking(move || {
        let suspended = suspend_daemon();
        daemon_vault_lifecycle_call(&app_handle, "vault_close", std::time::Duration::from_secs(300));
        let result = daemon_call_blocking(&app_handle, "vault_adopt", serde_json::json!({"path": path.clone()}), std::time::Duration::from_secs(600))
            .and_then(|_| {
                let data_dir = mailvault_core::paths::app_data_dir().map_err(|e| e.to_string())?;
                external_location::save_external_location(&data_dir, external_location::SLOT_VAULT, &path)
            })
            .map(|_| vault::resolve(&app_handle));
        let status = match result {
            Ok(s) => s,
            Err(e) => {
                drop(suspended);
                daemon_vault_lifecycle_call(&app_handle, "vault_reopen", std::time::Duration::from_secs(60));
                return Err(e);
            }
        };
        // The daemon reads the storage location once at startup: the channel
        // respawns it on the new root only once `suspended` clears below.
        stop_daemon();
        drop(suspended);
        let _ = app_handle.emit("vault-status", status.clone());
        Ok(status)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Copy the mail data to `path` (daemon `vault_move_to`), then either commit
/// (bookmark saved and it resolves as ready: delete the originals, switch
/// over) or abort (leave the source and the stray destination copy in
/// place) via `vault_move_finalize` — see the phase 6 plan doc's
/// "Restart-ordering fix" for why the delete can't happen in the same round
/// trip as the copy.
#[tauri::command]
pub(crate) async fn vault_move_to(app_handle: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        vault_move_finish(&handle, "vault_move_to", serde_json::json!({"path": path.clone()}), Some(&path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;
    // Pre-Phase-1 behaviour: emitted on success AND failure, so the UI always
    // learns the vault's current status even when the move fell back to the
    // app data dir.
    let _ = app_handle.emit("vault-status", vault::status(&app_handle));
    result
}

/// Bring the mail back into the app data dir, then stop using the custom folder.
#[tauri::command]
pub(crate) async fn vault_move_to_default(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || vault_move_finish(&handle, "vault_move_to_default", serde_json::json!({}), None))
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    let _ = app_handle.emit("vault-status", vault::status(&app_handle));
    result
}

/// Shared body for `vault_move_to`/`vault_move_to_default`: run the daemon's
/// copy step, then the app-only bookmark step, then finalize (commit or
/// abort) based on whether the new bookmark actually resolves. `new_path` is
/// `Some` for `vault_move_to` (save a bookmark to it), `None` for
/// `vault_move_to_default` (clear the bookmark instead).
pub(crate) fn vault_move_finish(
    app_handle: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    new_path: Option<&str>,
) -> Result<serde_json::Value, String> {
    let suspended = suspend_daemon();
    daemon_vault_lifecycle_call(app_handle, "vault_close", std::time::Duration::from_secs(300));

    // Unlike `reply_timeout`'s `None` (consulted only by the generic async
    // `daemon_rpc` passthrough), `daemon_call_blocking` always needs a finite
    // socket timeout. A vault can be very large on a slow external drive —
    // generous rather than unbounded, same reasoning `vault_close`'s 300s
    // already uses one call up.
    let copy_reply = daemon_call_blocking(app_handle, method, params, std::time::Duration::from_secs(6 * 3600));
    let copy_reply = match copy_reply {
        Ok(v) => v,
        Err(e) => {
            drop(suspended);
            daemon_vault_lifecycle_call(app_handle, "vault_reopen", std::time::Duration::from_secs(60));
            return Err(e);
        }
    };
    let move_id = copy_reply.get("moveId").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    let data_dir = mailvault_core::paths::app_data_dir().map_err(|e| e.to_string());
    let bookmark_result = data_dir.and_then(|data_dir| match new_path {
        Some(p) => external_location::save_external_location(&data_dir, external_location::SLOT_VAULT, p).map(|_| ()),
        None => external_location::clear_external_location(&data_dir, external_location::SLOT_VAULT),
    });
    // Precise per-mode, not "ready or default": a `vault_move_to` whose
    // bookmark save silently no-opped must never read as success just
    // because `resolve()` still reports "default" — that would commit
    // (delete the source) while the app keeps reading the OLD root, losing
    // the just-copied data's only live copy.
    let expected_status = if new_path.is_some() { "ready" } else { "default" };
    let new_status = bookmark_result.map(|_| vault::resolve(app_handle));
    let commit = matches!(&new_status, Ok(s) if s.status == expected_status);

    let finalize_reply = daemon_call_blocking(
        app_handle,
        "vault_move_finalize",
        serde_json::json!({"moveId": move_id, "commit": commit}),
        std::time::Duration::from_secs(120),
    );

    if commit {
        // The data move itself already succeeded and verified (the daemon
        // reply we're merging into is the proof) and the bookmark already
        // points at the new location — a failed finalize here only means the
        // old copy wasn't cleaned up, not that mail was lost. Report it as
        // `sourceRemoved: false` rather than failing the whole move: telling
        // the user the move failed when their mail is safely at the new
        // location would be worse than a stray leftover copy.
        let mut merged = copy_reply;
        match &finalize_reply {
            Ok(reply) => {
                if let Some(removed) = reply.get("sourceRemoved") {
                    merged["sourceRemoved"] = removed.clone();
                }
            }
            Err(e) => {
                tracing::warn!("vault_move_finalize failed after a successful copy+switch: {e}");
                merged["sourceRemoved"] = serde_json::json!(false);
            }
        }
        stop_daemon();
        drop(suspended);
        Ok(merged)
    } else {
        drop(suspended);
        daemon_vault_lifecycle_call(app_handle, "vault_reopen", std::time::Duration::from_secs(60));
        match new_status {
            Err(e) => Err(e),
            Ok(s) => Err(s.last_error.unwrap_or_else(|| "New mail storage folder could not be opened".into())),
        }
    }
}

/// Go back to storing mail in the app data dir. Does not move anything.
/// Async + blocking thread: closing the search index waits on its mutex.
#[tauri::command]
pub(crate) async fn vault_reset(app_handle: tauri::AppHandle) -> Result<vault::VaultStatus, String> {
    tokio::task::spawn_blocking(move || {
        let suspended = suspend_daemon();
        daemon_vault_lifecycle_call(&app_handle, "vault_close", std::time::Duration::from_secs(300));
        let result = vault::reset(&app_handle);
        let status = match result {
            Ok(s) => s,
            Err(e) => {
                drop(suspended);
                daemon_vault_lifecycle_call(&app_handle, "vault_reopen", std::time::Duration::from_secs(60));
                return Err(e);
            }
        };
        stop_daemon();
        drop(suspended);
        let _ = app_handle.emit("vault-status", status.clone());
        Ok(status)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// `maildir_cur_path` (the app's `vault::root` + `vault_files::cur_path`
// wrapper) and `find_msg_file_by_uid` (its test-only per-uid mirror lookup)
// are gone with the backup runners too (Phase 3 remainder, Task 5) —
// `backup.rs` was the only caller of either, and the daemon builds the same
// paths from its own root.

// `maildir_store` moved to the daemon (Task 2.8, `handlers::vault_files`).
// `maildir_store_raw` (this file's own single-UID, non-overwriting writer,
// `imap_get_email_light`'s auto-cache side effect) moved to the daemon too in
// Task 5.4a (`src-daemon/src/handlers/imap.rs`) — its only caller went with
// it, so nothing here calls `mailvault_core::vault_files::store` anymore.

// ── Vault generation (UIDVALIDITY) ──────────────────────────────────────────
//
// `maildir_repair_generation` and `maildir_purge_orphans` moved to the daemon
// (Task 2.9b, `handlers::custody`) — they read and rewrite custody rows, and
// custody.db now opens in the daemon. `maildir_mailbox_path` went with them:
// the daemon derives the mailbox directory from its own root.

// `archive_emails`, `cancel_archive`, `bulk_delete_emails` and
// `verify_archived_emails` moved to the daemon (Task 3.5,
// `src-daemon/src/handlers/archive.rs`, Task 3.4): cancel tokens are now
// per-operation-kind daemon state instead of the app's single shared
// `ArchiveCancelToken` (inventory-archive-bulk N4, fixed at the same time).
// `src-tauri/src/archive.rs`, which kept the `run_with_backup` shim for
// `backup.rs` after that, is deleted too (Phase 3 remainder, Task 5) — the
// backup runners moved to the daemon and took its only caller with them.

// `maildir_delete` and `maildir_delete_many` both live in the daemon now
// (Tasks 2.8 and 2.9b).

// `maildir_set_flags`, `maildir_clear_cache`, `maildir_migrate_json_to_eml`
// and `maildir_migrate_email_dirs` all moved to the daemon (Task 2.8,
// `handlers::vault_files`), each now gated on `common::with_vault_write`
// (single-file writers) or a per-file/per-mailbox `gate` closure (the three
// whole-vault walkers), with the in-process nudge/sweep signal replacing
// `nudge_index`/`sweep_index_soon`.

// `export_backup` and `import_backup` moved to the daemon (Task 4.3/4.4,
// `src-daemon/src/backup_zip.rs`, `handlers::backup_zip`). `accounts.json`
// stays app-only (decision 2): the daemon route only reads it and hands
// back new-account descriptors; the app merges them itself via
// `src/services/db/accounts.js`'s `ensureAccountsInFile`, the same helper
// `init()` already calls for this file. `BackupManifest`/`BackupAccount`/
// `ExportResult`/`ImportResult`/`AccountsJsonEntry` and
// `read_accounts_json`/`write_accounts_json` moved with them (the daemon
// copy owns them now); nothing else in this file referenced them.
//
// `export_mbox_all`/`import_mbox` moved to the daemon too (Task 4.5/4.6,
// `src-daemon/src/mbox.rs`, `handlers::mbox`; import_mbox now also seeds the
// `archived` flag, decision 3). `sanitize_mailbox_name`,
// `mbox_escape_from`/`mbox_unescape_from`/`mbox_from_line`/`split_mbox` and
// `MboxExportResult`/`MboxImportResult` moved with them (the daemon copy
// owns them now, `sanitize_mailbox_name` promoted into
// `handlers::common` in Task 4.5), grep-confirmed nothing else in this
// file called any of them. The dead single-mailbox export variant was
// deleted outright in Task 4.5 (zero callers), not ported.
