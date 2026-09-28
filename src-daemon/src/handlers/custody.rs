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
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, u32_arg, vault_root, with_mailbox_write, with_vault_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::custody::{cache, entries};
use mailvault_core::{import_rehome, maildir, vault_files};
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
                    // The registry drops the removed uids, and its change hook
                    // nudges the index when anything went.
                    let removed = with_mailbox_write(&state, &account_id, &mailbox, |root| {
                        Ok(vault_files::delete_maildir_files(&state.vault_registry, root, &account_id, &mailbox, &uid_set))
                    })?;
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
        // An undone delete comes back out of Trash under a NEW uid: its vault
        // copy and custody entry are re-filed under it (`maildir::rebind_uids`,
        // `entries::remap`). Same locks and invalidation as the generation
        // repair below, which re-keys files the same way.
        "vault_rebind_uids" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let pairs = req!(crate::handlers::common::vec_arg::<(u32, u32)>(&id, params, "pairs"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let rebound = with_mailbox_write(&state, &account_id, &mailbox, |root| {
                        let rebound = maildir::rebind_uids(&vault_files::cur_path(root, &account_id, &mailbox), &pairs);
                        if !rebound.is_empty() {
                            state.vault_registry.invalidate(&account_id, &mailbox);
                            if let Err(e) = daemon_custody::with_conn(&state, |c| entries::remap(c, &account_id, &mailbox, &rebound, &[])) {
                                warn!("vault_rebind_uids: custody remap failed: {}", e);
                            }
                        }
                        Ok(rebound)
                    })?;
                    Ok(serde_json::json!({ "rebound": rebound }))
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
                    let report = repair_generation_for(&state, &account_id, &mailbox)?;
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
                        // Only `orphaned/` is touched, never `cur/`: nothing the
                        // vault registry holds changes, so it is not told.
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

/// Re-keys the mailbox's vault files onto the server's current UIDVALIDITY
/// when the stored generation disagrees (`maildir::repair_generation`), and
/// remaps custody to match. Runs under the registry's per-mailbox lock (so a
/// verify never lists the folder mid-repair) and the vault gate. The caller
/// must not hold either, and must call any verifying registry read after
/// this returns, never inside it. A repair that moved anything, or hit any
/// error (a failed second-phase rename leaves a file under its temp name),
/// invalidates the mailbox, so the next read relists it.
pub(crate) fn repair_generation_for(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Result<maildir::GenerationRepair, String> {
    with_mailbox_write(state, account_id, mailbox, |root| -> Result<maildir::GenerationRepair, String> {
        let (cached_uv, cached_total) =
            daemon_custody::with_conn(state, |c| cache::sync_meta(c, account_id, mailbox))
                .unwrap_or((None, None));
        let Some(uid_validity) = cached_uv else {
            return Ok(maildir::GenerationRepair::default());
        };
        let mailbox_dir = vault_files::cur_path(root, account_id, mailbox)
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "Maildir path has no parent".to_string())?;
        if maildir::read_generation(&mailbox_dir) == Some(uid_validity) {
            return Ok(maildir::GenerationRepair { generation: uid_validity, ..Default::default() });
        }
        let (id_to_uid, cached) =
            daemon_custody::with_conn(state, |c| cache::message_id_map(c, account_id, mailbox))
                .unwrap_or_default();
        let total = cached_total.unwrap_or(0);
        if total == 0 || cached < total {
            info!(
                "maildir_repair_generation: {}/{} — cache covers {}/{}, waiting for a fuller sync",
                account_id, mailbox, cached, total,
            );
            return Ok(maildir::GenerationRepair::default());
        }
        let protected = match daemon_custody::with_conn(state, |c| entries::local_uids(c, account_id, mailbox)) {
            Ok(uids) => uids,
            Err(e) => {
                warn!("maildir_repair_generation: {}/{} skipped, {}", account_id, mailbox, e);
                return Ok(maildir::GenerationRepair::default());
            }
        };
        let report = maildir::repair_generation(&mailbox_dir, uid_validity, &id_to_uid, &protected);
        // Files were renamed or set aside wholesale, or a rename failed
        // part way: the next read relists the folder. The change hook
        // nudges the index.
        if !report.rebound.is_empty() || !report.orphaned.is_empty() || !report.recovered.is_empty() || report.errors > 0 {
            state.vault_registry.invalidate(account_id, mailbox);
        }
        if !report.rebound.is_empty() || !report.orphaned.is_empty() {
            if let Err(e) = daemon_custody::with_conn(state, |c| entries::remap(c, account_id, mailbox, &report.rebound, &report.orphaned)) {
                warn!("maildir_repair_generation: custody remap failed: {}", e);
            }
        }
        Ok(report)
    })
}

/// `rehome_imports_for` on a thread of its own, one pass per folder at a
/// time, never waited for: a folder open must not stand behind a pass's
/// header reads. A folder already done (its stamp) costs one stat and spawns
/// nothing.
pub(crate) fn rehome_imports_soon(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) {
    let Ok(root) = vault_root(state) else { return };
    let Some(mailbox_dir) = mailbox_dir(&root, account_id, mailbox) else { return };
    if mailbox_dir.join(import_rehome::DONE_FILE).exists() {
        return;
    }
    let key = (account_id.to_string(), mailbox.to_string());
    if !state.import_rehome_running.lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone()) {
        return;
    }
    // Leaves the in-flight set however the pass ends, a panic included.
    struct Running(Arc<DaemonState>, (String, String));
    impl Drop for Running {
        fn drop(&mut self) {
            self.0.import_rehome_running.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.1);
        }
    }
    let running = Running(Arc::clone(state), key);
    std::thread::spawn(move || {
        let (account_id, mailbox) = &running.1;
        if let Err(e) = rehome_imports_for(&running.0, account_id, mailbox) {
            warn!("import rehome {account_id}/{mailbox}: {e}");
        }
    });
}

fn mailbox_dir(root: &std::path::Path, account_id: &str, mailbox: &str) -> Option<std::path::PathBuf> {
    vault_files::cur_path(root, account_id, mailbox).parent().map(|p| p.to_path_buf())
}

/// Moves the folder's old mbox imports out of the server's uid range
/// (`import_rehome`), once: the stamp is written after a pass that saw the
/// whole folder's headers and hit no error, and a stamped folder is never
/// read again. Waits, without a stamp, for what `repair_generation_for` waits
/// for: files keyed by the server's current UIDVALIDITY and a header cache
/// that covers the folder. The plan is made outside every lock; only the
/// renames run under the mailbox lock. `None`: nothing ran.
pub(crate) fn rehome_imports_for(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Result<Option<import_rehome::Report>, String> {
    let root = vault_root(state)?;
    let dir = mailbox_dir(&root, account_id, mailbox).ok_or("Maildir path has no parent")?;
    if dir.join(import_rehome::DONE_FILE).exists() {
        return Ok(None);
    }
    let (cached_uv, cached_total) = daemon_custody::with_conn(state, |c| cache::sync_meta(c, account_id, mailbox)).unwrap_or((None, None));
    let Some(uid_validity) = cached_uv else { return Ok(None) };
    if maildir::read_generation(&dir) != Some(uid_validity) {
        return Ok(None);
    }
    let cached = daemon_custody::with_conn(state, |c| cache::count(c, account_id, mailbox))? as u64;
    let total = cached_total.unwrap_or(0);
    if total == 0 || cached < total {
        return Ok(None);
    }
    let rows = daemon_custody::with_conn(state, |c| cache::all_headers(c, account_id, mailbox))?;
    let protected = daemon_custody::with_conn(state, |c| entries::local_uids(c, account_id, mailbox))?;
    // The daemon holds no account list, and resolving the account's
    // credentials could raise the keychain prompt on a folder open: a Graph
    // folder is told by its header rows, the three marks
    // `insights::is_graph_header` reads.
    let is_graph = rows.iter().any(|r| {
        ["source", "provider"].iter().any(|k| r.get(*k).and_then(Value::as_str) == Some("graph"))
            || r.get("_graphId").and_then(Value::as_str).is_some_and(|id| !id.trim().is_empty())
    });
    let plan = import_rehome::plan(&dir, &import_rehome::ServerView::from_headers(&rows), is_graph, &protected);
    if plan.suspicious {
        warn!(
            "import rehome {}/{}: left alone, none of {} archived files at server uids matched the server's Message-IDs",
            account_id, mailbox, plan.compared,
        );
        return Ok(None);
    }
    let report = with_mailbox_write(state, account_id, mailbox, |root| {
        let dir = mailbox_dir(root, account_id, mailbox).ok_or("Maildir path has no parent")?;
        let report = import_rehome::apply(&dir, &plan)?;
        let touched: Vec<u32> = report.moved.iter().map(|(from, _)| *from).chain(report.set_aside.iter().copied()).collect();
        if !touched.is_empty() || report.errors > 0 {
            state.vault_registry.invalidate(account_id, mailbox);
        }
        // An attachment saved from the import under U would open for the
        // server's own message U.
        if !touched.is_empty() {
            let prefixes: Vec<String> =
                touched.iter().map(|u| format!("{}_{}_{}_", vault_files::fs_safe(account_id), vault_files::fs_safe(mailbox), u)).collect();
            for entry in std::fs::read_dir(root.join("attachment_cache")).into_iter().flatten().flatten() {
                if prefixes.iter().any(|p| entry.file_name().to_string_lossy().starts_with(p.as_str())) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        if report.errors == 0 && report.skipped == 0 {
            std::fs::write(dir.join(import_rehome::DONE_FILE), b"").map_err(|e| format!("Failed to write {}: {}", import_rehome::DONE_FILE, e))?;
        }
        Ok(report)
    })?;
    if !report.moved.is_empty() || !report.set_aside.is_empty() {
        crate::search_index::sweep_soon(&state.search_index);
    }
    info!(
        "import rehome {}/{}: {} compared, {} moved into the import range, {} set aside, {} skipped, {} errors",
        account_id, mailbox, plan.compared, report.moved.len(), report.set_aside.len(), report.skipped, report.errors,
    );
    Ok(Some(report))
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
        let (_v, s) = st(true);
        daemon_custody::close(&s); // as a vault move does, mid-run
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

    /// An undone delete comes back under a new uid: the vault copy, its
    /// custody entry and the registry's answer all move to it.
    #[tokio::test]
    async fn vault_rebind_uids_refiles_the_copy_and_its_custody_entry() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        seed_file(v.path(), "acc", "INBOX", 7);
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acc", "INBOX", &[json!({"uid": 7, "flags": ["archived"]})])).unwrap();
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![7], vec![])));

        let r = call(&s, "vault_rebind_uids", json!({"accountId": "acc", "mailbox": "INBOX", "pairs": [[7, 12], [8, 13]]})).await;
        // 8 has no vault copy: nothing to re-file.
        assert_eq!(r.result.unwrap(), json!({"rebound": [[7, 12]]}));

        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![12], vec![])));
        let text = daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "INBOX")).unwrap().unwrap();
        let rows: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(rows.iter().map(|r| r["uid"].clone()).collect::<Vec<_>>(), vec![json!(12)]);
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

    /// A repair that re-keys files changes the folder wholesale: it must
    /// invalidate the registry, so the next answer is a fresh listing that
    /// shows the rebound uid, never the pre-repair row.
    #[tokio::test]
    async fn a_repair_that_rebinds_invalidates_the_vault_registry() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        let cur = vault_files::cur_path(v.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("1{}.eml", maildir::INFO_PREFIX)), b"From: a@b.test\r\nSubject: s\r\nMessage-ID: <m@x.test>\r\n\r\nbody").unwrap();
        maildir::write_generation(cur.parent().unwrap(), 1).unwrap();
        let headers = json!({"uidValidity": 2, "totalEmails": 1, "emails": [{"uid": 5, "messageId": "<m@x.test>"}]});
        daemon_custody::with_conn(&s, |c| cache::save_headers(c, "acc", "INBOX", &headers.to_string())).unwrap();

        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![1], vec![])));
        assert_eq!(reg.listing_count(), 1);

        let r = call(&s, "maildir_repair_generation", json!({"accountId": "acc", "mailbox": "INBOX"})).await;
        assert_eq!(r.result.unwrap()["rebound"], json!([[1, 5]]));

        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![5], vec![])));
        assert_eq!(reg.listing_count(), 2, "the repair invalidated, so the folder was listed again");
    }

    /// A repair that only errored still invalidates: its failures (here the
    /// generation stamp, a directory where the file should be; in the field a
    /// failed second-phase rename) can leave the folder unlike its rows.
    #[tokio::test]
    async fn a_repair_that_only_errors_still_invalidates_the_vault_registry() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        let cur = vault_files::cur_path(v.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("1{}.eml", maildir::INFO_PREFIX)), b"From: a@b.test\r\nSubject: s\r\nMessage-ID: <m@x.test>\r\n\r\nbody").unwrap();
        fs::create_dir_all(cur.parent().unwrap().join(maildir::GENERATION_FILE)).unwrap();
        let headers = json!({"uidValidity": 2, "totalEmails": 1, "emails": [{"uid": 5, "messageId": "<other@x.test>"}]});
        daemon_custody::with_conn(&s, |c| cache::save_headers(c, "acc", "INBOX", &headers.to_string())).unwrap();

        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![1], vec![])));
        assert_eq!(reg.listing_count(), 1);

        let r = call(&s, "maildir_repair_generation", json!({"accountId": "acc", "mailbox": "INBOX"})).await.result.unwrap();
        assert_eq!(r["errors"], 1, "{r}");
        assert_eq!(r["kept"], 1, "{r}");
        assert_eq!((&r["rebound"], &r["orphaned"], &r["recovered"]), (&json!([]), &json!([]), &json!([])), "{r}");

        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![1], vec![])));
        assert_eq!(reg.listing_count(), 2, "the errored repair invalidated, so the folder was listed again");
    }

    /// An mbox import from before the import range, at uid 5, where the
    /// server lists another message. Returns the mailbox dir.
    fn seed_old_import(s: &Arc<DaemonState>, root: &std::path::Path, total: u64) -> std::path::PathBuf {
        let cur = vault_files::cur_path(root, "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join(format!("5{}A.eml", maildir::INFO_PREFIX)), b"Message-ID: <import@x.test>\r\nSubject: old\r\n\r\nbody").unwrap();
        maildir::write_generation(cur.parent().unwrap(), 2).unwrap();
        let headers = json!({"uidValidity": 2, "totalEmails": total, "emails": [{"uid": 5, "messageId": "<real@x.test>"}]});
        daemon_custody::with_conn(s, |c| cache::save_headers(c, "acc", "INBOX", &headers.to_string())).unwrap();
        cur.parent().unwrap().to_path_buf()
    }

    #[tokio::test]
    async fn a_clean_rehome_pass_stamps_the_folder_and_the_next_call_does_nothing() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        let dir = seed_old_import(&s, v.path(), 1);

        let report = rehome_imports_for(&s, "acc", "INBOX").unwrap().expect("a pass ran");
        assert_eq!(report.moved, vec![(5, maildir::IMPORT_UID_BASE)]);
        assert!(dir.join(import_rehome::DONE_FILE).exists());

        // Planted after the stamp: a finished folder is never read again.
        fs::write(dir.join("cur").join(format!("5{}A.eml", maildir::INFO_PREFIX)), b"Message-ID: <another@x.test>\r\n\r\nb").unwrap();
        assert!(rehome_imports_for(&s, "acc", "INBOX").unwrap().is_none());
        assert!(dir.join("cur").join(format!("5{}A.eml", maildir::INFO_PREFIX)).exists());
    }

    #[tokio::test]
    async fn no_rehome_and_no_stamp_while_the_header_cache_is_partial() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        let dir = seed_old_import(&s, v.path(), 2);

        assert!(rehome_imports_for(&s, "acc", "INBOX").unwrap().is_none());
        assert!(!dir.join(import_rehome::DONE_FILE).exists());
        assert!(dir.join("cur").join(format!("5{}A.eml", maildir::INFO_PREFIX)).exists());
    }

    /// A Graph folder leaves a copy of server mail where it is, whichever
    /// mark its rows carry: here `provider`, with `source` saying "server".
    #[tokio::test]
    async fn a_graph_folder_keeps_an_import_of_mail_the_server_lists_elsewhere() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        let cur = vault_files::cur_path(v.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        let date = "Mon, 1 Jan 2024 10:00:00 +0000";
        let name = format!("5{}A.eml", maildir::INFO_PREFIX);
        fs::write(cur.join(&name), format!("Message-ID: <dup@x.test>\r\nSubject: hi\r\nDate: {date}\r\n\r\nbody")).unwrap();
        maildir::write_generation(cur.parent().unwrap(), 2).unwrap();
        let row = |uid: u32, id: &str, subject: &str| json!({"uid": uid, "messageId": id, "subject": subject, "messageDate": date, "source": "server", "provider": "graph"});
        let headers = json!({"uidValidity": 2, "totalEmails": 2, "emails": [row(5, "<other@x.test>", "other"), row(9, "<dup@x.test>", "hi")]});
        daemon_custody::with_conn(&s, |c| cache::save_headers(c, "acc", "INBOX", &headers.to_string())).unwrap();

        let report = rehome_imports_for(&s, "acc", "INBOX").unwrap().expect("a pass ran");
        assert!(report.set_aside.is_empty() && report.moved.is_empty(), "{report:?}");
        assert!(cur.join(&name).exists());
    }

    #[tokio::test]
    async fn a_rehome_drops_the_old_uids_attachments_and_relists_the_folder() {
        let (v, s) = st(true);
        let _ = daemon_custody::open_into(&s);
        seed_old_import(&s, v.path(), 1);
        let cache_dir = v.path().join("attachment_cache");
        fs::create_dir_all(&cache_dir).unwrap();
        fs::write(cache_dir.join("acc_INBOX_5_0_old.pdf"), b"import's").unwrap();
        fs::write(cache_dir.join("acc_INBOX_50_0_other.pdf"), b"uid 50's").unwrap();
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![5], vec![5])));

        rehome_imports_for(&s, "acc", "INBOX").unwrap().expect("a pass ran");

        assert!(!cache_dir.join("acc_INBOX_5_0_old.pdf").exists());
        assert!(cache_dir.join("acc_INBOX_50_0_other.pdf").exists());
        let b = maildir::IMPORT_UID_BASE;
        assert_eq!(reg.uid_sets(v.path(), "acc", "INBOX"), Some((vec![b], vec![b])));
        assert_eq!(reg.listing_count(), 2, "the rehome invalidated, so the folder was listed again");
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
