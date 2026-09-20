//! Header cache, mailbox cache and the Outlook uid ledger (Task 2.7, plan
//! §"Daemon caches, op journal, pending operation, Graph ledger",
//! `inventory-cache.md` §1 rows 3-9, 13-17). Bodies are
//! `mailvault_core::header_cache`/`graph_ledger` (Task 2.3/2.4), unchanged;
//! this router only extracts JSON args, gates on `common::vault_root` (reads)
//! or `common::with_vault_write` (writes — one call per route, never spanning
//! more than one save/clear), and runs everything inside
//! `handlers::common::blocking`.
//!
//! 2.3 review F1: every route below resolves its root through
//! `common::vault_root`/`common::with_vault_write` and nothing else — never
//! `state.app_dir`, never a respelled path — because `header_cache`'s lock
//! registry keys on the raw `PathBuf`, and `sync_engine` (Task 2.7 I4) writes
//! through the identical `state.data_dir`. Two spellings of the same root
//! would silently give a handler and a sync write two different locks over
//! one directory (see `handlers::common`'s
//! `vault_root_and_sync_engines_root_are_the_same_path` test).
//!
//! 2.3 review F2: `clear_email_cache` takes the header-cache tree's WRITE
//! lock (`header_cache::clear`), which blocks every mailbox writer
//! (including `sync_engine`) until it finishes. Routing it through
//! `common::blocking` keeps that off a tokio worker; it is still one call
//! for the whole clear (never per-mailbox), matching the scope
//! `header_cache::clear` itself already has (walking every entry under one
//! root) — there is no smaller unit to gate it by.
use crate::handlers::common::{blocking, done, opt_f64_arg, opt_str_arg, str_arg, u32_arg, vault_root, vec_arg, with_vault_write};
use crate::custody as daemon_custody;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::{graph_ledger, header_cache, vault_files};
use mailvault_core::custody::cache as sql_cache;
use serde_json::Value;
use std::sync::Arc;

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
        "save_email_cache" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let data = req!(str_arg(&id, params, "data"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    with_vault_write(&state, |_root| {
                        daemon_custody::with_conn(&state, |c| sql_cache::save_headers(c, &account_id, &mailbox, &data))
                    }).map(|_| Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "load_email_cache" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    daemon_custody::with_conn(&state, |c| sql_cache::load_headers(c, &account_id, &mailbox, None))
                        .map(|v| v.map_or(Value::Null, Value::String))
                })
                .await
                .and_then(|r| r),
            )
        }
        "load_email_cache_partial" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let limit = req!(u32_arg(&id, params, "limit")) as usize;
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    daemon_custody::with_conn(&state, |c| sql_cache::load_headers(c, &account_id, &mailbox, Some(limit)))
                        .map(|v| v.map_or(Value::Null, Value::String))
                })
                .await
                .and_then(|r| r),
            )
        }
        "load_email_cache_meta" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    daemon_custody::with_conn(&state, |c| sql_cache::load_meta(c, &account_id, &mailbox))
                        .map(|v| v.map_or(Value::Null, Value::String))
                })
                .await
                .and_then(|r| r),
            )
        }
        "load_email_cache_by_uids" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    daemon_custody::with_conn(&state, |c| sql_cache::load_by_uids(c, &account_id, &mailbox, &uids)).map(Value::Array)
                })
                .await
                .and_then(|r| r),
            )
        }
        "list_cached_uids" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let since_ms = opt_f64_arg(params, "sinceMs");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    daemon_custody::with_conn(&state, |c| sql_cache::list_uids(c, &account_id, &mailbox, since_ms))
                })
                .await
                .and_then(|r| r),
            )
        }
        // F2: the tree-write lock inside `header_cache::clear` blocks every
        // mailbox writer (including sync_engine, via the same registry) for
        // its duration — one call for the whole clear, same scope the body
        // itself already has.
        "clear_email_cache" => {
            let account_id = opt_str_arg(params, "accountId");
            let mailbox = opt_str_arg(params, "mailbox");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    with_vault_write(&state, |root| {
                        daemon_custody::with_conn(&state, |c| sql_cache::clear_headers(c, account_id.as_deref(), mailbox.as_deref()))?;
                        header_cache::clear(root, account_id.as_deref(), mailbox.as_deref())
                    }).map(|_| Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "save_mailbox_cache" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let data = req!(str_arg(&id, params, "data"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    with_vault_write(&state, |_root| {
                        daemon_custody::with_conn(&state, |c| sql_cache::save_mailboxes(c, &account_id, &data))
                    }).map(|_| Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "load_mailbox_cache" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    if let Some(data) = daemon_custody::with_conn(&state, |c| sql_cache::load_mailboxes(c, &account_id))? {
                        return Ok(Value::String(data));
                    }
                    // Nothing stored: move the pre-SQL `mailboxes.json` in, once.
                    let Some(data) = header_cache::take_legacy_mailbox_cache(&root, &account_id) else {
                        return Ok(Value::Null);
                    };
                    daemon_custody::with_conn(&state, |c| sql_cache::save_mailboxes(c, &account_id, &data))?;
                    Ok(Value::String(data))
                })
                .await
                .and_then(|r| r),
            )
        }
        "delete_mailbox_cache" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    with_vault_write(&state, |root| {
                        daemon_custody::with_conn(&state, |c| sql_cache::delete_mailboxes(c, &account_id))?;
                        header_cache::delete_legacy_mailbox_cache(root, &account_id)
                    }).map(|_| Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        // The ledger + its cross-process file lock (Task 2.4, R2.2): the
        // listing path (here) and the app's own Graph backup (Phase 3, still
        // in-app) allocate from the SAME file under the SAME lock, so moving
        // only this half cannot reopen the double-uid bug the lock exists to
        // close. `ledger`/`cur` mirror main.rs:1040-1051 verbatim (deviation:
        // none — same paths, same core fn).
        "graph_allocate_uids" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let entries = req!(vec_arg::<(String, Option<String>)>(&id, params, "entries"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let uids = with_vault_write(&state, |root| {
                        let ledger = root
                            .join("email_cache")
                            .join(header_cache::cache_base_name(&account_id, &mailbox))
                            .join(graph_ledger::LEDGER_FILE);
                        let cur = vault_files::cur_path(root, &account_id, &mailbox);
                        graph_ledger::allocate(&ledger, &cur, &entries)
                    })?;
                    serde_json::to_value(uids).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "load_graph_id_map" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let file = root
                        .join("email_cache")
                        .join(header_cache::cache_base_name(&account_id, &mailbox))
                        .join(graph_ledger::LEDGER_FILE);
                    if !file.exists() {
                        return Ok(Value::Null);
                    }
                    std::fs::read_to_string(&file).map(Value::String).map_err(|e| format!("load_graph_id_map: failed to read: {e}"))
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

    // Task 2.8 carry-in (2.7 review I3): the original `st()` used one tempdir
    // for both `mail_dir` and `app_dir`, so "nothing written under the
    // fallback root" could never fail regardless of what the gate did (same
    // pattern the 2.6 review's I2 fixed in `handlers/vault_files.rs`). The
    // vault path is still returned as `t` so every existing non-gate test
    // (which reads `t.path().join("email_cache")` as the vault) is unchanged;
    // `app_dir` is a second, distinct, leaked tempdir.
    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), app_dir, mail_dir_ok);
        if mail_dir_ok { let _ = crate::custody::open_into(&s); }
        (tmp, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    #[tokio::test]
    async fn save_then_load_email_cache_round_trips_as_a_json_string() {
        let (_t, s) = st(true);
        let data = json!({"emails": [{"uid": 1}], "totalEmails": 1}).to_string();
        assert_eq!(call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data})).await.result, Some(Value::Null));
        let loaded = call(&s, "load_email_cache", json!({"accountId": "a", "mailbox": "INBOX"})).await.result.unwrap();
        assert!(loaded.is_string(), "load_email_cache must stay a JSON string, not a parsed Value");
        let parsed: Value = serde_json::from_str(loaded.as_str().unwrap()).unwrap();
        assert_eq!(parsed["totalEmails"], json!(1));
    }

    #[tokio::test]
    async fn load_email_cache_by_uids_is_an_array_not_a_string() {
        let (_t, s) = st(true);
        let data = json!({"emails": [{"uid": 7, "subject": "hi"}], "totalEmails": 1}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data})).await;
        let r = call(&s, "load_email_cache_by_uids", json!({"accountId": "a", "mailbox": "INBOX", "uids": [7]})).await.result.unwrap();
        assert!(r.is_array());
        assert_eq!(r[0]["subject"], "hi");
    }

    #[tokio::test]
    async fn list_cached_uids_answers_uids_and_changed() {
        let (_t, s) = st(true);
        let data = json!({"emails": [{"uid": 7}], "totalEmails": 1}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data})).await;
        let r = call(&s, "list_cached_uids", json!({"accountId": "a", "mailbox": "INBOX", "sinceMs": Value::Null})).await.result.unwrap();
        assert!(r.get("uids").is_some());
        assert!(r.get("changed").is_some());
    }

    #[tokio::test]
    async fn save_mailbox_cache_then_load_round_trips() {
        let (_t, s) = st(true);
        assert_eq!(call(&s, "save_mailbox_cache", json!({"accountId": "a", "data": "[]"})).await.result, Some(Value::Null));
        assert_eq!(call(&s, "load_mailbox_cache", json!({"accountId": "a"})).await.result, Some(json!("[]")));
        assert_eq!(call(&s, "delete_mailbox_cache", json!({"accountId": "a"})).await.result, Some(Value::Null));
        assert_eq!(call(&s, "load_mailbox_cache", json!({"accountId": "a"})).await.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn graph_allocate_uids_then_load_graph_id_map_agree() {
        let (_t, s) = st(true);
        let uids = call(&s, "graph_allocate_uids", json!({"accountId": "a", "mailbox": "INBOX", "entries": [["g1", "mid1"]]})).await.result.unwrap();
        assert_eq!(uids, json!([1]));
        let map = call(&s, "load_graph_id_map", json!({"accountId": "a", "mailbox": "INBOX"})).await.result.unwrap();
        let parsed: Value = serde_json::from_str(map.as_str().unwrap()).unwrap();
        // The ledger is `BTreeMap<uid, graphId>` — keyed by uid, not by graph id.
        assert_eq!(parsed.get("1"), Some(&json!("g1")));
    }

    #[tokio::test]
    async fn load_graph_id_map_is_null_when_no_ledger_exists_yet() {
        let (_t, s) = st(true);
        assert_eq!(call(&s, "load_graph_id_map", json!({"accountId": "a", "mailbox": "INBOX"})).await.result, Some(Value::Null));
    }

    #[tokio::test]
    async fn clear_email_cache_removes_a_saved_mailbox() {
        let (_t, s) = st(true);
        let data = json!({"emails": [{"uid": 1}], "totalEmails": 1}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data})).await;
        assert!(call(&s, "load_email_cache", json!({"accountId": "a", "mailbox": "INBOX"})).await.result.unwrap().is_string());
        assert_eq!(call(&s, "clear_email_cache", json!({"accountId": Value::Null, "mailbox": Value::Null})).await.result, Some(Value::Null));
        assert_eq!(call(&s, "load_email_cache", json!({"accountId": "a", "mailbox": "INBOX"})).await.result, Some(Value::Null));
    }

    // Task 2.8 carry-in (2.7 review I3): now that `st()` gives the vault and
    // app_dir distinct real directories, this actually proves a fallback
    // write never lands anywhere — before, `s.app_dir == s.data_dir`, so this
    // could only ever pass.
    #[tokio::test]
    async fn a_gated_read_route_refuses_and_writes_nothing_under_either_root() {
        let (t, s) = st(false);
        let r = call(&s, "load_email_cache", json!({"accountId": "a", "mailbox": "INBOX"})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
        assert!(!s.app_dir.join("email_cache").exists());
        assert!(!t.path().join("email_cache").exists());
    }

    #[tokio::test]
    async fn a_gated_write_route_refuses_and_writes_nothing_under_either_root() {
        let (t, s) = st(false);
        let r = call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": "{}"})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
        assert!(!s.app_dir.join("email_cache").exists());
        assert!(!t.path().join("email_cache").exists());

        let r = call(&s, "graph_allocate_uids", json!({"accountId": "a", "mailbox": "INBOX", "entries": [["g1", "mid1"]]})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
        assert!(!s.app_dir.join("email_cache").exists());
        assert!(!t.path().join("email_cache").exists());
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_t, s) = st(true);
        assert!(route(&s, "sync.now", &json!({}), json!(1)).await.is_none());
    }
}
