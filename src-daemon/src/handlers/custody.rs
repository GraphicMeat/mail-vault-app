//! Custody RPCs (Task 2.9a): the four commands `src-tauri/src/custody.rs` had
//! (`local_index_read/append/remove`, `custody_status`), plus the three
//! vault writers that could not move before custody did
//! (`maildir_delete_many`, `maildir_repair_generation`, `maildir_purge_orphans`
//! see inventory-maildir §1 rows 13, 19, 21). The Task 2.9b bridge method
//! `custody_entries_for_account` lived here too until Task 3.7 moved
//! insights into the daemon and left it with no caller at all.
//!
//! `local_index_read/append/remove` are gated only by the custody store's own
//! open/closed state (`crate::custody::with_conn`'s `custody store
//! unavailable: <reason>`, unchanged from the app version) — they touch no
//! vault file, so `common::vault_root` does not apply to them.
//! `custody_status` is fully ungated: it must answer even while the vault is
//! unreachable, same as `search_index_status`.
//!
//! `maildir_delete_many`/`repair_generation`/`purge_orphans` touch BOTH a
//! vault file and custody. `maildir_delete_many` takes the two sequentially
//! (file half under `common::with_vault_write`, then the custody prune on its
//! own). `maildir_repair_generation` DOES nest — its `local_uids`/`remap`
//! calls run inside the `with_vault_write` closure, because the repair has to
//! read what is composed-here and rewrite those rows against the same vault
//! state it just renamed files in. That nesting order (vault gate outer,
//! custody inner) is the same one `handlers::vault_flags`'s `apply_everywhere`
//! uses, and no route anywhere takes custody first and the vault gate second,
//! which is what would deadlock (2.9a review M2).
//! `maildir_purge_orphans` can be a whole-vault walk when `accountId` is
//! omitted, so — like Task 2.8's `maildir_clear_cache` — it re-checks the
//! gate once per mailbox directory rather than once for the whole call.
use crate::custody as daemon_custody;
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, u32_arg, with_vault_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::custody::{cache, entries};
use mailvault_core::{maildir, vault_files};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use tracing::{info, warn};

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "local_index_read" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let text = daemon_custody::with_conn(&state, |c| entries::read(c, &account_id, &mailbox))?;
                    Ok(text.map(Value::String).unwrap_or(Value::Null))
                })
                .await
                .and_then(|r| r),
            )
        }
        // `entriesJson` is parsed BEFORE the blocking task, same as the app
        // command: a bad payload answers `Failed to parse entries: ...`
        // without ever touching the custody connection.
        "local_index_append" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let entries_json = req!(str_arg(&id, params, "entriesJson"));
            let new_entries: Vec<Value> = match serde_json::from_str(&entries_json) {
                Ok(v) => v,
                Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Failed to parse entries: {}", e))),
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    daemon_custody::with_conn(&state, |c| {
                        let (_, skipped) = entries::upsert(c, &account_id, &mailbox, &new_entries)?;
                        if skipped > 0 {
                            warn!("local_index_append {account_id}/{mailbox}: {skipped} entries without a uid skipped");
                        }
                        Ok(Value::Null)
                    })
                })
                .await
                .and_then(|r| r),
            )
        }
        "local_index_remove" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    daemon_custody::with_conn(&state, |c| entries::remove(c, &account_id, &mailbox, &[uid]).map(|_| Value::Null))
                })
                .await
                .and_then(|r| r),
            )
        }
        // Ungated, like `search_index_status`: it must answer with
        // `available: false` while the vault is unreachable or mid-move, not
        // refuse to answer at all.
        "custody_status" => {
            let state = Arc::clone(state);
            done(id, blocking(move || Ok(daemon_custody::status_json(&state))).await.and_then(|r| r))
        }
        "maildir_delete_many" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(crate::handlers::common::vec_arg::<u32>(&id, params, "uids"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let uid_set: HashSet<u32> = uids.into_iter().collect();
                    let removed = with_vault_write(&state, |root| {
                        let cur = vault_files::cur_path(root, &account_id, &mailbox);
                        Ok(vault_files::delete_maildir_files(&cur, &uid_set))
                    })?;
                    if removed > 0 {
                        crate::search_index::nudge(&state.search_index, &account_id, &mailbox);
                    }
                    // Every requested uid is pruned from custody, not only the
                    // ones a file existed for (inventory-maildir row 13).
                    let all_uids: Vec<u32> = uid_set.into_iter().collect();
                    if let Err(e) = daemon_custody::with_conn(&state, |c| entries::remove(c, &account_id, &mailbox, &all_uids)) {
                        warn!("maildir_delete_many: custody prune failed: {}", e);
                    }
                    info!("maildir_delete_many: removed {} files from {}/{}", removed, account_id, mailbox);
                    Ok(serde_json::json!({ "removed": removed }))
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_repair_generation" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let report = with_vault_write(&state, |root| -> Result<maildir::GenerationRepair, String> {
                        let (cached_uv, cached_total) =
                            daemon_custody::with_conn(&state, |c| cache::sync_meta(c, &account_id, &mailbox))
                                .unwrap_or((None, None));
                        let Some(uid_validity) = cached_uv else {
                            return Ok(maildir::GenerationRepair::default());
                        };
                        let mailbox_dir = vault_files::cur_path(root, &account_id, &mailbox)
                            .parent()
                            .map(|p| p.to_path_buf())
                            .ok_or_else(|| "Maildir path has no parent".to_string())?;
                        if maildir::read_generation(&mailbox_dir) == Some(uid_validity) {
                            return Ok(maildir::GenerationRepair { generation: uid_validity, ..Default::default() });
                        }
                        let (id_to_uid, cached) =
                            daemon_custody::with_conn(&state, |c| cache::message_id_map(c, &account_id, &mailbox))
                                .unwrap_or_default();
                        let total = cached_total.unwrap_or(0);
                        if total == 0 || cached < total {
                            info!(
                                "maildir_repair_generation: {}/{} — cache covers {}/{}, waiting for a fuller sync",
                                account_id, mailbox, cached, total,
                            );
                            return Ok(maildir::GenerationRepair::default());
                        }
                        let protected = match daemon_custody::with_conn(&state, |c| entries::local_uids(c, &account_id, &mailbox)) {
                            Ok(uids) => uids,
                            Err(e) => {
                                warn!("maildir_repair_generation: {}/{} skipped, {}", account_id, mailbox, e);
                                return Ok(maildir::GenerationRepair::default());
                            }
                        };
                        let report = maildir::repair_generation(&mailbox_dir, uid_validity, &id_to_uid, &protected);
                        if !report.rebound.is_empty() || !report.orphaned.is_empty() {
                            if let Err(e) = daemon_custody::with_conn(&state, |c| entries::remap(c, &account_id, &mailbox, &report.rebound, &report.orphaned)) {
                                warn!("maildir_repair_generation: custody remap failed: {}", e);
                            }
                        }
                        Ok(report)
                    })?;
                    if !report.rebound.is_empty() || !report.orphaned.is_empty() || !report.recovered.is_empty() {
                        crate::search_index::nudge(&state.search_index, &account_id, &mailbox);
                    }
                    serde_json::to_value(report).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        // A whole-account (or whole-vault, `accountId` omitted) walk: gated
        // once per mailbox directory, never once for the whole call — same
        // reasoning as Task 2.8's `maildir_clear_cache`. A vault-unavailable
        // error stops the walk immediately (nothing after a move started is
        // safe to touch); a plain filesystem error for one mailbox is warned
        // and the walk continues, same as the app command's original
        // per-directory `match`.
        "maildir_purge_orphans" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let base = crate::handlers::common::vault_root(&state)?.join("Maildir");
                    let mut removed = 0u64;
                    for mailbox_dir in vault_files::orphan_mailbox_dirs(&base, account_id.as_deref()) {
                        match with_vault_write(&state, |_| maildir::purge_orphans(&mailbox_dir)) {
                            Ok(n) => removed += n,
                            Err(e) if e.starts_with("E_VAULT_UNAVAILABLE:") => return Err(e),
                            Err(e) => warn!("maildir_purge_orphans: {}", e),
                        }
                    }
                    info!("maildir_purge_orphans: removed {} files", removed);
                    Ok(serde_json::json!(removed))
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
    use serde_json::json;
    use std::fs;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, mail_dir_ok);
        (vault, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    #[tokio::test]
    async fn local_index_read_append_remove_round_trip() {
        let (_v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        assert_eq!(call(&s, "local_index_read", json!({"accountId": "acc", "mailbox": "INBOX"})).await.result, Some(Value::Null));

        let entries_json = serde_json::to_string(&[json!({"uid": 7, "flags": ["draft"]})]).unwrap();
        let r = call(&s, "local_index_append", json!({"accountId": "acc", "mailbox": "INBOX", "entriesJson": entries_json})).await;
        assert_eq!(r.result, Some(Value::Null));

        let r = call(&s, "local_index_read", json!({"accountId": "acc", "mailbox": "INBOX"})).await;
        let text = r.result.unwrap();
        let parsed: Vec<Value> = serde_json::from_str(text.as_str().unwrap()).unwrap();
        assert_eq!(parsed[0]["uid"], 7);

        let r = call(&s, "local_index_remove", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        assert_eq!(r.result, Some(Value::Null));
        assert_eq!(call(&s, "local_index_read", json!({"accountId": "acc", "mailbox": "INBOX"})).await.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn local_index_append_a_bad_json_string_is_a_parse_error_before_touching_custody() {
        let (_v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        let r = call(&s, "local_index_append", json!({"accountId": "acc", "mailbox": "INBOX", "entriesJson": "not json"})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("Failed to parse entries:"), "{}", err.message);
    }

    #[tokio::test]
    async fn local_index_read_while_closed_answers_the_verbatim_custody_error() {
        let (_v, s) = st(true); // never opened
        let r = call(&s, "local_index_read", json!({"accountId": "acc", "mailbox": "INBOX"})).await;
        assert_eq!(r.error.unwrap().message, "custody store unavailable: closed");
    }

    #[tokio::test]
    async fn custody_status_reports_available_then_closed_and_never_refuses() {
        let (_v, s) = st(false); // mail_dir_ok = false: custody_status must still answer
        let r = call(&s, "custody_status", json!({})).await.result.unwrap();
        assert_eq!(r, json!({"available": false, "error": null, "path": null}));

        let (v2, s2) = st(true);
        let _ = daemon_custody::open_into(&s2);
        let r = call(&s2, "custody_status", json!({})).await.result.unwrap();
        assert_eq!(r["available"], true);
        assert_eq!(r["path"], mailvault_core::custody::db::db_path(v2.path()).display().to_string());
    }

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32) {
        let cur = vault_files::cur_path(root, account, mailbox);
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(vault_files::build_maildir_filename(uid, &[])), b"body").unwrap();
    }

    #[tokio::test]
    async fn maildir_delete_many_removes_files_and_prunes_every_requested_uid_from_custody() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        seed_file(v.path(), "acc", "INBOX", 1);
        // uid 2 has a custody row but no file: `entries::remove` for ALL
        // requested uids (inventory-maildir row 13) must prune it too.
        daemon_custody::with_conn(&s, |c| {
            entries::upsert(c, "acc", "INBOX", &[json!({"uid": 1, "flags": []}), json!({"uid": 2, "flags": []})])
        })
        .unwrap();

        let r = call(&s, "maildir_delete_many", json!({"accountId": "acc", "mailbox": "INBOX", "uids": [1, 2]})).await;
        assert_eq!(r.result.unwrap(), json!({"removed": 1}));

        let cur = vault_files::cur_path(v.path(), "acc", "INBOX");
        assert_eq!(fs::read_dir(&cur).unwrap().count(), 0);
        assert_eq!(daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "INBOX")).unwrap(), None);
    }

    #[tokio::test]
    async fn maildir_delete_many_is_gated_while_the_vault_is_being_moved() {
        let (_v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let r = call(&s, "maildir_delete_many", json!({"accountId": "acc", "mailbox": "INBOX", "uids": [1]})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
    }

    /// Task 3.7: the Task 2.9b bridge route is gone with its only caller.
    /// `entries_for_account` itself is still live, read in-process by
    /// `crate::insights`, so this pins the route's absence rather than the
    /// function's.
    #[tokio::test]
    async fn the_custody_entries_bridge_route_no_longer_exists() {
        let (_v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        assert!(route(&s, "custody_entries_for_account", &json!({"accountId": "acc"}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }
}
