//! The three read-state / mailbox-rename commands, as **forwarders** (spec
//! deviation 1). Everything they used to do — `dirs_for`, the renames in both
//! locations, the sidecar patches, the custody patch under core's `WRITER` —
//! runs in the daemon (`src-daemon/src/handlers/vault_flags.rs`, Task 2.9a).
//! What cannot move is the one thing they still do here: resolving the backup
//! mirror's security-scoped bookmark. A daemon cannot resolve a bookmark the
//! app was granted (spec §3.4), so the app resolves it, passes the resolved
//! path as `mirrorRoot`, and releases it only once the daemon has replied.
//!
//! Release discipline: the release happens on EVERY path — success, daemon
//! error, budget expiry — before the result is unwrapped, because a release
//! skipped on an error path leaks the scoped access for the process's life.
//! 2.9a's `vault_apply_flags` route finishes every mirror rename before it
//! replies, so a release right after a reply can never land mid-write. A call
//! that times out is the one case where it can: the daemon may still be
//! renaming mirror files with the bookmark already released, which is why the
//! error path says so in the log. The next backup catch-up heals it.
//!
//! No nudge or sweep of the search index here: the daemon's own routes signal
//! their index in-process, and the `info!` summary lines are logged there too.

pub use mailvault_core::vault_flags::{AdoptReport, RenamePair};
use mailvault_core::vault_flags::{Applied, FlagChange};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tracing::warn;

/// Every mirror-spanning rename shares this budget (`reply_timeout`'s 600 s
/// family): a whole-mailbox catch-up renames two files per message across two
/// filesystems, one of which can be a slow external drive.
const MIRROR_BUDGET: std::time::Duration = std::time::Duration::from_secs(600);

/// Resolve the mirror, call the daemon with `mirrorRoot`, release, then decide.
/// Blocking on purpose — every caller is already inside `spawn_blocking`.
fn forward<T: DeserializeOwned>(app: &tauri::AppHandle, method: &str, mut params: Value) -> Result<T, String> {
    let (root, needs_release) = crate::backup::resolve_backup_path(app, None);
    if let Some(obj) = params.as_object_mut() {
        obj.insert("mirrorRoot".into(), json!(root));
    }
    let result = crate::daemon_call_blocking(app, method, params, MIRROR_BUDGET);
    if needs_release {
        if let Some(ref p) = root {
            crate::backup::release_backup_path(p);
        }
    }
    let value = match result {
        Ok(v) => v,
        Err(e) => {
            if needs_release {
                // task-2.11 carry-in M6: this fires on every error with a
                // mirror in play, not only a timeout — the daemon may never
                // have touched the mirror at all (unreachable, outdated).
                // Say "if", not "a call that timed out", so an unrelated
                // failure does not read as proof the mirror was mid-rename.
                warn!(
                    "{method}: failed ({e}) — the backup mirror's access has been released; \
                     if this call timed out mid-rename, the mirror may be left partly renamed, \
                     which the next backup catch-up heals"
                );
            }
            return Err(e);
        }
    };
    serde_json::from_value(value).map_err(|e| format!("{method}: unreadable reply: {e}"))
}

/// One or more messages whose read state just changed here. `account_email`
/// names the mirror directory; without it, or without a configured external
/// location, the mirror is simply not touched (the daemon decides that).
#[tauri::command]
pub async fn vault_apply_flags(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    account_email: Option<String>,
    changes: Vec<FlagChange>,
) -> Result<Applied, String> {
    tokio::task::spawn_blocking(move || {
        forward(
            &app_handle,
            "vault_apply_flags",
            json!({"accountId": account_id, "mailbox": mailbox, "accountEmail": account_email, "changes": changes}),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// The one-time adoption of Graph folders written under localized names.
#[tauri::command]
pub async fn vault_adopt_mailbox_dirs(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_email: Option<String>,
    pairs: Vec<RenamePair>,
) -> Result<AdoptReport, String> {
    tokio::task::spawn_blocking(move || {
        forward(
            &app_handle,
            "vault_adopt_mailbox_dirs",
            json!({"accountId": account_id, "accountEmail": account_email, "pairs": pairs}),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// The local half of a folder rename: the server already moved the subtree,
/// this moves the directories that hold its copies.
#[tauri::command]
pub async fn vault_rename_mailbox(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_email: Option<String>,
    pairs: Vec<RenamePair>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        forward(
            &app_handle,
            "vault_rename_mailbox",
            json!({"accountId": account_id, "accountEmail": account_email, "pairs": pairs}),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
