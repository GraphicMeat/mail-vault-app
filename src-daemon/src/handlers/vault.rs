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

                    let events = state.events.clone();
                    let (present, copied, bytes) = vault_ops::copy_and_verify(&src_root, &dst_root, &|p| {
                        events.emit("vault-move-progress", serde_json::to_value(&p).unwrap_or_default());
                    })?;

                    let marker = vault_layout::read_marker(&dst_root).unwrap_or(vault_layout::VaultMarker {
                        app: "mailvault".into(),
                        vault_id: vault_layout::new_vault_id(),
                        created_at: vault_layout::now_millis(),
                    });
                    vault_layout::write_marker(&dst_root, &marker)?;

                    let move_id = uuid::Uuid::new_v4().to_string();
                    *state.pending_move.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(PendingMove { move_id: move_id.clone(), src_root, present });

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

    #[tokio::test]
    async fn an_unknown_method_is_not_this_routers() {
        let dir = scratch("other");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        assert!(route(&state, "sync.now", &json!({}), json!(1)).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
