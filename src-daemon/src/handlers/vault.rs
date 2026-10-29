//! Vault-location daemon routes (Phase 6): `vault_get_status`, `vault_adopt`,
//! `vault_move_to`, `vault_move_to_default`, and the internal
//! `vault_move_finalize`. Bodies are `mailvault_core::vault_ops`/
//! `vault_layout` (Task 6.1), ported unchanged from the app's old `vault.rs`.
//!
//! What stays app-side (spec §3.4, unchanged): resolving/creating/clearing
//! the security-scoped bookmark (`external_location.rs`) and
//! `vault_inspect_folder` (a one-shot pick preview using access the app
//! already holds from the picker — moving it needs fd-passing, not built
//! this phase). `main.rs`'s five commands still do that bookmark work and
//! the `vault_close`/`vault_reopen`/`stop_daemon` choreography; only the
//! real file work below moved here.
//!
//! Two-phase move (see the phase 6 plan doc, "Restart-ordering fix"): the
//! app cannot delete the source until it has confirmed the bookmark it saves
//! for the new path actually resolves — a check only the app can make. So
//! `vault_move_to`/`vault_move_to_default` copy and verify but never delete;
//! `vault_move_finalize` commits (deletes source) or aborts (leaves the
//! stray copy at the destination, exactly as the original single-process
//! code already did on this failure branch). `moveId` guards against a
//! stale or mismatched finalize ever committing a move it wasn't answering.

use crate::format_migration_job;
use crate::handlers::common::{blocking, done, str_arg};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::{vault_layout, vault_ops};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// Remembered between a `vault_move_to`/`vault_move_to_default` call and the
/// `vault_move_finalize` that follows it.
pub struct PendingMove {
    pub move_id: String,
    pub src_root: PathBuf,
    /// Where the copy went, spelled as the daemon that opens it will spell
    /// its root.
    pub dst_root: PathBuf,
    pub present: Vec<&'static str>,
}

fn vault_status_json(state: &Arc<DaemonState>) -> Value {
    let display_path = state.vault_display_path.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let is_custom = *state.vault_is_custom.lock().unwrap_or_else(|p| p.into_inner());
    let last_error = state.vault_last_error.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let status = match (&last_error, is_custom) {
        (Some(_), _) => "missing",
        (None, true) => "ready",
        (None, false) => "default",
    };
    let mut obj = json!({
        "status": status,
        "displayPath": display_path,
        "isCustom": is_custom,
    });
    if let Some(err) = last_error {
        obj["lastError"] = json!(err);
    }
    obj
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "vault_get_status" => {
            let state = Arc::clone(state);
            done(id, blocking(move || Ok::<Value, String>(vault_status_json(&state))).await.and_then(|r| r))
        }

        "vault_adopt" => {
            let path = req!(str_arg(&id, params, "path"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let dir = PathBuf::from(&path);
                    mailvault_core::folder_overlap::check_vault_folder(&state.app_dir, &dir)?;
                    let expected_id = vault_layout::read_marker(&state.app_dir).map(|m| m.vault_id);
                    let inspection = vault_ops::classify_folder(&dir, expected_id.as_deref())?;
                    if !inspection.writable {
                        return Err("MailVault cannot write to that folder. Check the drive is not read-only.".to_string());
                    }
                    if inspection.kind == "empty" || inspection.kind == "occupied" {
                        return Err("That folder does not contain a MailVault store. Pick the folder your mail was moved to, or use \"Move mail here\" to set up a new one.".to_string());
                    }
                    let marker = match vault_layout::read_marker(&dir) {
                        Some(m) => m,
                        None => {
                            // Mail is there but the marker was lost — stamp it so
                            // later re-selections verify cleanly.
                            let m = vault_layout::VaultMarker {
                                app: "mailvault".into(),
                                vault_id: vault_layout::new_vault_id(),
                                created_at: vault_layout::now_millis(),
                            };
                            vault_layout::write_marker(&dir, &m)?;
                            m
                        }
                    };
                    // Remember which vault is ours, at the app dir — same as
                    // the app's old `adopt()` did.
                    let _ = vault_layout::write_marker(&state.app_dir, &marker);
                    // The folder's own marker says how its mail is stored. A
                    // format this process read for the same root before is
                    // of another file now.
                    mailvault_core::message_store::invalidate_vault_format(&dir);
                    Ok(json!({"ok": true, "kind": inspection.kind, "vaultId": marker.vault_id}))
                })
                .await
                .and_then(|r| r),
            )
        }

        "vault_move_to" | "vault_move_to_default" => {
            let to_default = method == "vault_move_to_default";
            let path = if to_default { None } else { Some(req!(str_arg(&id, params, "path"))) };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    // `state.data_dir` falls back to `app_dir` when the
                    // configured folder is unreachable (`resolve_vault_location`
                    // at startup) — copying FROM that fallback would silently
                    // move nothing real and then clear/repoint the config
                    // anyway. Matches the app's old `move_to_default`'s "there
                    // is nothing to move back" refusal for the unreachable case.
                    if !state.mail_dir_ok {
                        return Err("The current mail storage folder is unreachable — there is nothing to move from it right now.".to_string());
                    }
                    let src_root = state.data_dir.clone();
                    let dst_root = match &path {
                        Some(p) => PathBuf::from(p),
                        None => state.app_dir.clone(),
                    };
                    if dst_root == src_root {
                        return Err(if to_default {
                            "Mail is already stored in the default location".to_string()
                        } else {
                            "Mail is already stored in that folder".to_string()
                        });
                    }
                    // Before the copy: a backup in the same place is no second copy.
                    mailvault_core::folder_overlap::check_vault_folder(&state.app_dir, &dst_root)?;
                    if !to_default {
                        if dst_root.starts_with(&src_root) {
                            return Err("Choose a folder outside the current mail storage folder".to_string());
                        }
                        let expected_id = vault_layout::read_marker(&state.app_dir).map(|m| m.vault_id);
                        let inspection = vault_ops::classify_folder(&dst_root, expected_id.as_deref())?;
                        if !inspection.writable {
                            return Err("MailVault cannot write to that folder. Check the drive is not read-only.".to_string());
                        }
                        if inspection.kind == "other_vault" {
                            return Err("That folder already holds a different MailVault store. Pick an empty folder, or select it as your existing storage instead.".to_string());
                        }
                    }

                    // A conversion in progress writes the vault message by
                    // message; a stopped one is no job and follows the move.
                    if let Some(job_id) = format_migration_job::move_blocker(&state, &src_root) {
                        return Err(format!("{}: {job_id}", format_migration_job::E_FORMAT_MOVE_BLOCKED));
                    }

                    let events = state.events.clone();
                    let (present, copied, bytes) = vault_ops::copy_and_verify(&src_root, &dst_root, &|p| {
                        events.emit("vault-move-progress", serde_json::to_value(&p).unwrap_or_default());
                    })?;

                    vault_ops::carry_marker(&src_root, &dst_root)?;

                    let move_id = uuid::Uuid::new_v4().to_string();
                    *state.pending_move.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(PendingMove { move_id: move_id.clone(), src_root, dst_root: dst_root.clone(), present });

                    Ok(json!({
                        "moveId": move_id,
                        "filesCopied": copied,
                        "bytesCopied": bytes,
                        "displayPath": dst_root.to_string_lossy(),
                    }))
                })
                .await
                .and_then(|r| r),
            )
        }

        "vault_move_finalize" => {
            let move_id = req!(str_arg(&id, params, "moveId"));
            let commit = params.get("commit").and_then(Value::as_bool).unwrap_or(false);
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    // Peek before taking: a mismatched id must leave whatever
                    // move IS pending untouched, not consume and discard it —
                    // that would strand a legitimate move with no way to ever
                    // finalize it.
                    let mut guard = state.pending_move.lock().unwrap_or_else(|p| p.into_inner());
                    let matches = matches!(&*guard, Some(p) if p.move_id == move_id);
                    if !matches {
                        return Err(match &*guard {
                            Some(_) => "vault_move_finalize: moveId does not match the pending move".to_string(),
                            None => "vault_move_finalize: no move is pending".to_string(),
                        });
                    }
                    let pending = guard.take().expect("checked Some above");
                    drop(guard);
                    if !commit {
                        return Ok(json!({"sourceRemoved": false}));
                    }
                    format_migration_job::follow_move(&state.app_dir, &pending.src_root, &pending.dst_root);
                    let source_removed = vault_ops::remove_sources(&pending.src_root, &pending.present);
                    Ok(json!({"sourceRemoved": source_removed}))
                })
                .await
                .and_then(|r| r),
            )
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::DaemonState;
    use mailvault_core::maildir::INFO_PREFIX;
    use serde_json::json;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-vault-h-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn vault_get_status_reports_default_for_a_plain_dir() {
        let dir = scratch("status-default");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let resp = route(&state, "vault_get_status", &json!({}), json!(1)).await.expect("routed");
        let r = resp.result.expect("success");
        assert_eq!(r["status"], json!("default"));
        assert_eq!(r["isCustom"], json!(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn vault_get_status_reflects_custom_and_missing_from_state() {
        let dir = scratch("status-custom");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        *state.vault_is_custom.lock().unwrap() = true;
        *state.vault_display_path.lock().unwrap() = "/Volumes/Backup/mail".to_string();
        let resp = route(&state, "vault_get_status", &json!({}), json!(1)).await.unwrap();
        let r = resp.result.unwrap();
        assert_eq!(r["status"], json!("ready"));
        assert_eq!(r["displayPath"], json!("/Volumes/Backup/mail"));

        *state.vault_last_error.lock().unwrap() = Some("drive unplugged".to_string());
        let resp2 = route(&state, "vault_get_status", &json!({}), json!(2)).await.unwrap();
        let r2 = resp2.result.unwrap();
        assert_eq!(r2["status"], json!("missing"));
        assert_eq!(r2["lastError"], json!("drive unplugged"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn vault_adopt_rejects_an_empty_folder() {
        let app = scratch("adopt-app");
        let target = scratch("adopt-empty");
        let state = DaemonState::for_test(app.clone(), app.clone(), true);
        let resp = route(&state, "vault_adopt", &json!({"path": target.to_string_lossy()}), json!(1)).await.unwrap();
        assert!(resp.error.is_some(), "an empty folder must not be adoptable");
        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[tokio::test]
    async fn vault_adopt_accepts_unmarked_mail_and_stamps_a_marker() {
        let app = scratch("adopt-app2");
        let target = scratch("adopt-unmarked");
        std::fs::create_dir_all(target.join("Maildir")).unwrap();
        let state = DaemonState::for_test(app.clone(), app.clone(), true);
        let resp = route(&state, "vault_adopt", &json!({"path": target.to_string_lossy()}), json!(1)).await.unwrap();
        let r = resp.result.expect("adopt of unmarked mail must succeed");
        assert_eq!(r["kind"], json!("unmarked_mail"));
        assert!(vault_layout::read_marker(&target).is_some(), "adopt must stamp a marker when one is missing");
        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[tokio::test]
    async fn vault_move_to_copies_without_deleting_the_source() {
        let app = scratch("move-app");
        let src = scratch("move-src");
        let dst = scratch("move-dst");
        std::fs::create_dir_all(src.join("Maildir")).unwrap();
        std::fs::write(src.join(format!("Maildir/1{INFO_PREFIX}S.eml")), b"hello").unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);

        let resp = route(&state, "vault_move_to", &json!({"path": dst.to_string_lossy()}), json!(1)).await.unwrap();
        let r = resp.result.expect("move must succeed");
        assert!(r["moveId"].as_str().is_some());
        assert!(dst.join(format!("Maildir/1{INFO_PREFIX}S.eml")).exists(), "the file must have been copied");
        assert!(src.join(format!("Maildir/1{INFO_PREFIX}S.eml")).exists(), "the source must not be deleted before finalize");

        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[tokio::test]
    async fn vault_move_finalize_commit_true_deletes_the_source() {
        let app = scratch("finalize-app");
        let src = scratch("finalize-src");
        let dst = scratch("finalize-dst");
        std::fs::create_dir_all(src.join("Maildir")).unwrap();
        std::fs::write(src.join(format!("Maildir/1{INFO_PREFIX}S.eml")), b"hello").unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);

        let move_resp = route(&state, "vault_move_to", &json!({"path": dst.to_string_lossy()}), json!(1)).await.unwrap();
        let move_id = move_resp.result.unwrap()["moveId"].as_str().unwrap().to_string();

        // The real caller always closes custody before a commit finalize —
        // `vault_close` runs before `vault_move_to` even starts (architecture.md's
        // "app owns the vault_close/vault_reopen/stop_daemon restart choreography
        // around each call") — this route never manages that state itself.
        // Skipping it here left `DaemonState::for_test`'s custody connection open
        // through the delete below, which unix's unlink-while-open semantics
        // hid: `remove_dir_all` on the custody dir failed only on Windows,
        // which refuses to delete a file another handle still has open.
        crate::custody::close(&state);

        let fin = route(&state, "vault_move_finalize", &json!({"moveId": move_id, "commit": true}), json!(2)).await.unwrap();
        let r = fin.result.expect("finalize must succeed");
        assert_eq!(r["sourceRemoved"], json!(true));
        assert!(!src.join("Maildir").exists(), "commit must delete the source");

        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[tokio::test]
    async fn vault_move_finalize_commit_false_leaves_the_source_and_the_stray_copy() {
        let app = scratch("abort-app");
        let src = scratch("abort-src");
        let dst = scratch("abort-dst");
        std::fs::create_dir_all(src.join("Maildir")).unwrap();
        std::fs::write(src.join(format!("Maildir/1{INFO_PREFIX}S.eml")), b"hello").unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);

        let move_resp = route(&state, "vault_move_to", &json!({"path": dst.to_string_lossy()}), json!(1)).await.unwrap();
        let move_id = move_resp.result.unwrap()["moveId"].as_str().unwrap().to_string();

        let fin = route(&state, "vault_move_finalize", &json!({"moveId": move_id, "commit": false}), json!(2)).await.unwrap();
        let r = fin.result.expect("an abort finalize must still succeed");
        assert_eq!(r["sourceRemoved"], json!(false));
        assert!(src.join(format!("Maildir/1{INFO_PREFIX}S.eml")).exists(), "abort must leave the source intact");
        assert!(dst.join(format!("Maildir/1{INFO_PREFIX}S.eml")).exists(), "abort leaves the stray copy at dst, same as the original code");

        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[tokio::test]
    async fn vault_move_finalize_rejects_a_mismatched_move_id() {
        let app = scratch("mismatch-app");
        let src = scratch("mismatch-src");
        let dst = scratch("mismatch-dst");
        std::fs::create_dir_all(src.join("Maildir")).unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);

        route(&state, "vault_move_to", &json!({"path": dst.to_string_lossy()}), json!(1)).await.unwrap();
        let fin = route(&state, "vault_move_finalize", &json!({"moveId": "not-the-real-id", "commit": true}), json!(2)).await.unwrap();
        assert!(fin.error.is_some(), "a mismatched moveId must never commit");
        assert!(src.join("Maildir").exists(), "the source must survive a rejected finalize");

        let _ = std::fs::remove_dir_all(&app);
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[tokio::test]
    async fn vault_move_finalize_rejects_when_nothing_is_pending() {
        let app = scratch("nopending-app");
        let state = DaemonState::for_test(app.clone(), app.clone(), true);
        let fin = route(&state, "vault_move_finalize", &json!({"moveId": "x", "commit": true}), json!(1)).await.unwrap();
        assert!(fin.error.is_some());
        let _ = std::fs::remove_dir_all(&app);
    }

    // ── Task 10: the storage format and its conversion on a move ──

    use mailvault_core::message_store::{self, Format};
    use std::path::Path;

    /// A conversion journal of the vault at `root`, as `format_migration_job` writes one.
    fn journal(app: &Path, root: &Path, id: &str, state: &str) {
        let dir = app.join("format_migrations");
        std::fs::create_dir_all(&dir).unwrap();
        let j = json!({"version": 1, "jobId": id, "vault": root.to_string_lossy(), "to": "jmap", "oldFiles": "retire",
                       "stamp": "20261012-101500", "mailboxes": [], "done": 3, "total": 9, "failed": [], "state": state, "updatedAt": 1});
        std::fs::write(dir.join(format!("{id}.json")), j.to_string()).unwrap();
    }

    fn journal_vault(app: &Path, id: &str) -> Value {
        let raw = std::fs::read(app.join("format_migrations").join(format!("{id}.json"))).unwrap();
        serde_json::from_slice::<Value>(&raw).unwrap()["vault"].clone()
    }

    /// A Maildir vault of one message at `src`.
    fn one_message(src: &Path) {
        std::fs::create_dir_all(src.join("Maildir")).unwrap();
        std::fs::write(src.join(format!("Maildir/1{INFO_PREFIX}S.eml")), b"hello").unwrap();
    }

    async fn move_to(state: &Arc<DaemonState>, dst: &Path) -> RpcResponse {
        route(state, "vault_move_to", &json!({"path": dst.to_string_lossy()}), json!(1)).await.unwrap()
    }

    #[tokio::test]
    async fn vault_move_to_is_refused_while_a_conversion_is_paused_or_was_cut_off() {
        let (app, src, dst) = (scratch("held-app"), scratch("held-src"), scratch("held-dst"));
        one_message(&src);
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        let id = "3f1e0c1a-0000-4000-8000-00000000000a";
        vault_layout::write_marker_value(&src, "storageMigration", id).unwrap();
        // Paused by the user, or running when a quit or a crash cut it off.
        for held in ["paused", "running"] {
            journal(&app, &src, id, held);
            let refused = move_to(&state, &dst).await.error.expect("refused").message;
            assert_eq!(refused, format!("E_FORMAT_MOVE_BLOCKED: {id}"), "{held}");
            assert!(!dst.join("Maildir").exists(), "nothing copied ({held})");
            assert!(state.pending_move.lock().unwrap().is_none());
        }
        for dir in [app, src, dst] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn vault_move_to_waits_for_a_live_conversion_and_goes_once_it_is_cancelled() {
        let (app, src, dst) = (scratch("live-app"), scratch("live-src"), scratch("live-dst"));
        one_message(&src);
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        state.seed_accounts_for_test(&[]);
        crate::format_migration_job::faults(&state).hold = true;
        let call = |method: &'static str, params: Value| {
            let state = Arc::clone(&state);
            async move { crate::handlers::storage_format::route(&state, method, &params, json!(1)).await.unwrap() }
        };
        let started = call("storage_format_convert", json!({"to": "jmap", "oldFiles": "retire"})).await;
        let id = started.result.expect("started")["jobId"].as_str().unwrap().to_string();
        assert_eq!(move_to(&state, &dst).await.error.expect("refused").message, format!("E_FORMAT_MOVE_BLOCKED: {id}"));
        assert!(!dst.join("Maildir").exists());

        call("storage_format_cancel", json!({})).await.result.expect("cancelled");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let got = call("storage_format_get", json!({})).await.result.unwrap();
            if got["migration"]["state"] == "cancelled" {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the job never ended: {got}");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let moved = move_to(&state, &dst).await;
        assert!(moved.result.is_some(), "a cancelled conversion is no job: {:?}", moved.error.map(|e| e.message));
        assert_eq!(vault_layout::read_marker_value(&dst, "storageFormat").as_deref(), Some("jmap"), "the target format came along");
        for dir in [app, src, dst] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Another host's job on a shared vault, a reset app data dir or a marker
    /// write that failed twice leaves a job row no journal here explains.
    #[tokio::test]
    async fn vault_move_to_is_not_held_by_a_job_row_alone() {
        let (app, src, dst) = (scratch("row-app"), scratch("row-src"), scratch("row-dst"));
        one_message(&src);
        vault_layout::write_marker_value(&src, "storageMigration", "3f1e0c1a-0000-4000-8000-00000000000b").unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        let moved = move_to(&state, &dst).await;
        assert!(moved.result.is_some(), "{:?}", moved.error.map(|e| e.message));
        assert!(dst.join(format!("Maildir/1{INFO_PREFIX}S.eml")).exists());
        assert_eq!(vault_layout::read_marker_value(&dst, "storageMigration").as_deref(), Some(""), "the copy names no job");
        for dir in [app, src, dst] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn vault_move_takes_a_stopped_conversion_along_when_it_commits() {
        let (app, src, stray, dst) = (scratch("stopped-app"), scratch("stopped-src"), scratch("stopped-stray"), scratch("stopped-dst"));
        one_message(&src);
        message_store::set_vault_format(&src, Format::Jmap).unwrap();
        vault_layout::write_marker_value(&src, "storageMigration", "").unwrap();
        let id = "3f1e0c1a-0000-4000-8000-00000000000c";
        let other = "3f1e0c1a-0000-4000-8000-00000000000d";
        journal(&app, &src, id, "cancelled");
        journal(&app, Path::new("/some/other/vault"), other, "failed");
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        let finalize = |move_id: String, commit: bool| {
            let state = Arc::clone(&state);
            async move { route(&state, "vault_move_finalize", &json!({"moveId": move_id, "commit": commit}), json!(2)).await.unwrap() }
        };

        // An aborted move leaves it with the vault it stayed in.
        let move_id = move_to(&state, &stray).await.result.expect("copied")["moveId"].as_str().unwrap().to_string();
        finalize(move_id, false).await.result.expect("aborted");
        assert_eq!(journal_vault(&app, id), json!(src.to_string_lossy()));

        let move_id = move_to(&state, &dst).await.result.expect("copied")["moveId"].as_str().unwrap().to_string();
        crate::custody::close(&state);
        assert_eq!(finalize(move_id, true).await.result.expect("committed")["sourceRemoved"], json!(true));
        assert_eq!(journal_vault(&app, id), json!(dst.to_string_lossy()), "it names the new folder");
        assert_eq!(journal_vault(&app, other), json!("/some/other/vault"), "another vault's is left alone");

        // The daemon that opens the vault there offers it again.
        let next = DaemonState::for_test(dst.clone(), app.clone(), true);
        let got = crate::format_migration_job::get(&next, &dst);
        assert_eq!(got["format"], json!("jmap"));
        assert_eq!((got["migration"]["jobId"].clone(), got["migration"]["state"].clone()), (json!(id), json!("cancelled")), "{got}");
        crate::custody::close(&next);
        for dir in [app, src, stray, dst] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn vault_move_to_carries_the_storage_format_and_drops_a_cached_one() {
        let (app, src, dst) = (scratch("format-app"), scratch("format-src"), scratch("format-dst"));
        message_store::set_vault_format(&src, Format::Jmap).unwrap();
        message_store::write(&src, "acct", "INBOX", 4, b"Subject: four\r\n\r\nfour\r\n", &[]).unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        // This process asked about the destination before the move.
        assert_eq!(message_store::vault_format(&dst), Format::Maildir);

        let moved = move_to(&state, &dst).await;
        assert!(moved.result.is_some(), "{:?}", moved.error.map(|e| e.message));
        assert_eq!(message_store::vault_format(&dst), Format::Jmap);
        assert_eq!(message_store::read_raw(&dst, "acct", "INBOX", 4).unwrap().as_deref(), Some(&b"Subject: four\r\n\r\nfour\r\n"[..]));
        for dir in [app, src, dst] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The app data dir keeps its marker when the vault moves out of it.
    #[tokio::test]
    async fn vault_move_to_default_writes_maildir_over_a_stale_jmap_row() {
        let (app, src) = (scratch("back-app"), scratch("back-src"));
        one_message(&src);
        vault_layout::write_marker_value(&app, "storageFormat", "jmap").unwrap();
        vault_layout::write_marker_value(&app, "storageMigration", "3f1e0c1a-0000-4000-8000-00000000000e").unwrap();
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        let moved = route(&state, "vault_move_to_default", &json!({}), json!(1)).await.unwrap();
        assert!(moved.result.is_some(), "{:?}", moved.error.map(|e| e.message));
        assert_eq!(vault_layout::read_marker_value(&app, "storageFormat").as_deref(), Some("maildir"));
        assert_eq!(vault_layout::read_marker_value(&app, "storageMigration").as_deref(), Some(""));
        for dir in [app, src] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn vault_adopt_rereads_a_storage_format_this_process_cached() {
        let (app, target) = (scratch("adopt-format-app"), scratch("adopt-format"));
        std::fs::create_dir_all(target.join("Maildir")).unwrap();
        assert_eq!(message_store::vault_format(&target), Format::Maildir, "asked before: no marker");
        // Converted elsewhere since: the folder's marker says jmap now.
        vault_layout::write_marker_value(&target, "storageFormat", "jmap").unwrap();
        let state = DaemonState::for_test(app.clone(), app.clone(), true);
        let adopted = route(&state, "vault_adopt", &json!({"path": target.to_string_lossy()}), json!(1)).await.unwrap();
        assert!(adopted.result.is_some(), "{:?}", adopted.error.map(|e| e.message));
        assert_eq!(message_store::vault_format(&target), Format::Jmap);
        for dir in [app, target] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The backup folder, as the app saves it, in the app.db of `app`.
    fn backup_folder_at(app: &Path, backup: &Path) {
        mailvault_core::app_db::with(app, |c| {
            mailvault_core::app_db::locations::save_meta(c, "external-backup", &backup.to_string_lossy(), "native", 1, false)
        })
        .unwrap();
    }

    #[tokio::test]
    async fn vault_move_to_is_refused_before_the_copy_when_the_target_is_around_or_inside_the_backup_folder() {
        let (app, src, drive) = (scratch("bk-app"), scratch("bk-src"), scratch("bk-drive"));
        one_message(&src);
        let backup = drive.join("backup");
        std::fs::create_dir_all(&backup).unwrap();
        backup_folder_at(&app, &backup);
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        for bad in [backup.clone(), backup.join("mail"), drive.clone()] {
            let refused = move_to(&state, &bad).await.error.expect("refused").message;
            assert!(refused.starts_with("E_VAULT_OVERLAPS_BACKUP: "), "{refused}");
            assert!(!bad.join("Maildir").exists(), "nothing copied into {}", bad.display());
            assert!(state.pending_move.lock().unwrap().is_none());
        }
        let beside = drive.join("mail");
        std::fs::create_dir_all(&beside).unwrap();
        let moved = move_to(&state, &beside).await;
        assert!(moved.result.is_some(), "beside the backup is fine: {:?}", moved.error.map(|e| e.message));
        for dir in [app, src, drive] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn vault_move_to_default_is_refused_when_the_backup_folder_sits_in_the_app_data_dir() {
        let (app, src) = (scratch("bkd-app"), scratch("bkd-src"));
        one_message(&src);
        backup_folder_at(&app, &app.join("backup"));
        let state = DaemonState::for_test(src.clone(), app.clone(), true);
        let refused = route(&state, "vault_move_to_default", &json!({}), json!(1)).await.unwrap().error.expect("refused").message;
        assert!(refused.starts_with("E_VAULT_OVERLAPS_BACKUP: "), "{refused}");
        assert!(state.pending_move.lock().unwrap().is_none());
        for dir in [app, src] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn vault_adopt_is_refused_when_the_folder_is_around_or_inside_the_backup_folder() {
        let (app, drive) = (scratch("bka-app"), scratch("bka-drive"));
        let backup = drive.join("backup");
        std::fs::create_dir_all(backup.join("Maildir")).unwrap();
        backup_folder_at(&app, &backup);
        let state = DaemonState::for_test(app.clone(), app.clone(), true);
        for bad in [backup.clone(), drive.clone()] {
            let refused = route(&state, "vault_adopt", &json!({"path": bad.to_string_lossy()}), json!(1)).await.unwrap();
            let message = refused.error.expect("refused").message;
            assert!(message.starts_with("E_VAULT_OVERLAPS_BACKUP: "), "{message}");
        }
        for dir in [app, drive] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn an_unknown_method_is_not_this_routers() {
        let dir = scratch("other");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        assert!(route(&state, "sync.now", &json!({}), json!(1)).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
