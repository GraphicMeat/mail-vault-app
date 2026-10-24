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
use mailvault_core::{graph_ledger, header_cache};
use mailvault_core::custody::cache as sql_cache;
use serde_json::Value;
use std::sync::Arc;

/// The order the SQLite header cache hands rows back in, taken from the same
/// marker the sidecar tree uses (`header_cache::uid_tracks_arrival`): uid for
/// IMAP, header date for Graph. `9e783f50` moved these reads to SQLite and
/// ordered every one of them by date, which put a freshly arrived message
/// with an old INTERNALDATE below months-old mail.
pub(crate) fn header_order(root: &std::path::Path, account_id: &str, mailbox: &str) -> sql_cache::HeaderOrder {
    if header_cache::uid_tracks_arrival(root, account_id, mailbox) {
        sql_cache::HeaderOrder::Arrival
    } else {
        sql_cache::HeaderOrder::Date
    }
}

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// The list's first page (`load_email_cache_partial`, a JSON text) with each
/// row's preview line from the search index (`search_index::attach_snippets`).
/// Text that does not parse goes back untouched.
fn with_snippets(state: &DaemonState, account_id: &str, mailbox: &str, text: String) -> String {
    let Ok(mut entry) = serde_json::from_str::<Value>(&text) else { return text };
    let Some(rows) = entry.get_mut("emails").and_then(Value::as_array_mut) else { return text };
    crate::search_index::attach_snippets(&state.search_index, account_id, mailbox, rows);
    serde_json::to_string(&entry).unwrap_or(text)
}

/// The rows the app writes back carry the `previewText` a read stamped on
/// them. It belongs to the search index, never to the header cache: kept
/// here, it would outlive the index row it came from.
fn without_preview_text(data: String) -> String {
    if !data.contains("\"previewText\"") {
        return data;
    }
    let Ok(mut entry) = serde_json::from_str::<Value>(&data) else { return data };
    for row in entry.get_mut("emails").and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(obj) = row.as_object_mut() {
            obj.remove("previewText");
        }
    }
    serde_json::to_string(&entry).unwrap_or(data)
}

/// The payload's header rows whose uid is in `uids`.
fn rows_with_uids(data: &str, uids: &[u32]) -> Vec<Value> {
    let Ok(Value::Object(mut v)) = serde_json::from_str::<Value>(data) else { return Vec::new() };
    let Some(Value::Array(rows)) = v.remove("emails") else { return Vec::new() };
    let uids: std::collections::HashSet<u64> = uids.iter().map(|u| u64::from(*u)).collect();
    rows.into_iter().filter(|r| r.get("uid").and_then(Value::as_u64).is_some_and(|u| uids.contains(&u))).collect()
}

/// The uids a `save_email_cache` payload takes off the list.
fn removed_uids(data: &str) -> Vec<u32> {
    if !data.contains("\"removedUids\"") {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Vec::new() };
    v.get("removedUids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_u64().or_else(|| u.as_str()?.parse().ok()).and_then(|u| u32::try_from(u).ok()))
        .collect()
}

/// The account's cached folder list as `load_mailbox_cache` answers it, for
/// that route and the mbox import: the custody row, else the pre-SQL
/// `mailboxes.json` moved in once. `None` when neither exists. Blocking.
pub(crate) fn load_mailbox_listing(state: &Arc<DaemonState>, account_id: &str) -> Result<Option<String>, String> {
    let root = vault_root(state)?;
    if let Some(data) = daemon_custody::with_conn(state, |c| sql_cache::load_mailboxes(c, account_id))? {
        return Ok(Some(data));
    }
    let Some(data) = header_cache::take_legacy_mailbox_cache(&root, account_id) else {
        return Ok(None);
    };
    daemon_custody::with_conn(state, |c| sql_cache::save_mailboxes(c, account_id, &data))?;
    Ok(Some(data))
}

/// Snapshot the existing batch identity before network IO. `None` means the
/// expectation could not be read; `Some(Null)` is an observed legacy/empty cache.
pub(crate) async fn native_header_seed(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> Option<Value> {
    if account_id.is_empty() { return None; }
    let (state, account_id, mailbox) = (state.clone(), account_id.to_owned(), mailbox.to_owned());
    blocking(move || daemon_custody::with_conn(&state, |c| {
        let meta = sql_cache::load_meta(c, &account_id, &mailbox)?;
        let Some(meta) = meta else { return Ok(Value::Null) };
        let meta: Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
        match meta.get("nativeIdentity").filter(|p| !p.is_null()) {
            Some(identity) => {
                let identity: mailvault_core::imap::NativeHeaderIdentity = serde_json::from_value(identity.clone()).map_err(|e| e.to_string())?;
                serde_json::to_value(identity).map_err(|e| e.to_string())
            }
            None => Ok(Value::Null),
        }
    })).await.ok()?.ok()
}

pub(crate) fn with_native_expectation(mut batch: Value, expected: Option<Value>) -> Value {
    if let Some(expected) = expected { batch["nativeExpectedIdentity"] = expected; }
    batch
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "save_email_cache" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let data = req!(str_arg(&id, params, "data"));
            if let Ok(batch) = serde_json::from_str::<Value>(&data) {
                if let Some(proof) = batch.get("nativeIdentity").filter(|p| !p.is_null()) {
                    if batch.get("emails").and_then(Value::as_array).is_some_and(|rows| rows.iter().any(|row| row.get("_nativeIdentity") != Some(proof))) {
                        return Some(RpcResponse::error(id, crate::ipc::INVALID_PARAMS, "errors.bulkIdentityUncertain"));
                    }
                    let current = crate::credentials::resolve_account_credentials_quiet(&account_id).await;
                    match current {
                        Ok(config) if proof["originHash"].as_str() == Some(mailvault_core::bulk_worker::origin_hash(&config).as_str()) => {},
                        Ok(_) => return Some(RpcResponse::error(id, crate::ipc::INTERNAL_ERROR, "errors.bulkIdentityChanged")),
                        Err(_) => return Some(RpcResponse::error(id, crate::ipc::INTERNAL_ERROR, "errors.bulkIdentityUncertain")),
                    }
                }
            }
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let data = without_preview_text(data);
                    let now = mailvault_core::people::model::now_ms();
                    let added = with_vault_write(&state, |_root| {
                        daemon_custody::with_conn(&state, |c| sql_cache::save_headers_reporting_new(c, &account_id, &mailbox, &data, now))
                    })?;
                    // Mail the app fetched itself reaches the contacts index
                    // once, the first time it is cached, as the sync's does.
                    if !added.is_empty() {
                        state.contacts.observe_saved_rows(&account_id, &mailbox, &rows_with_uids(&data, &added));
                    }
                    // The search index keeps an evicted message's row while
                    // this list holds its uid: reconcile the folder once it does not.
                    // The app's delete, move or re-key took them off the server
                    // folder, so Cleanup stops listing them too.
                    let removed = removed_uids(&data);
                    if !removed.is_empty() {
                        crate::search_index::nudge(&state.search_index, &account_id, &mailbox);
                        crate::classification::forget_at(&state.app_dir, &account_id, &mailbox, &removed);
                    }
                    Ok(Value::Null)
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
                    let order = header_order(&vault_root(&state)?, &account_id, &mailbox);
                    daemon_custody::with_conn(&state, |c| sql_cache::load_headers(c, &account_id, &mailbox, None, order))
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
                    let order = header_order(&vault_root(&state)?, &account_id, &mailbox);
                    let text = daemon_custody::with_conn(&state, |c| sql_cache::load_headers(c, &account_id, &mailbox, Some(limit), order))?;
                    Ok(text.map_or(Value::Null, |t| Value::String(with_snippets(&state, &account_id, &mailbox, t))))
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
            let envelope = params["envelope"].as_bool().unwrap_or(false);
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    let (mut rows, meta) = daemon_custody::with_conn(&state, |c| {
                        let rows = sql_cache::load_by_uids(c, &account_id, &mailbox, &uids)?;
                        let meta = if envelope { sql_cache::load_meta(c, &account_id, &mailbox)? } else { None };
                        Ok((rows, meta))
                    })?;
                    crate::search_index::attach_snippets(&state.search_index, &account_id, &mailbox, &mut rows);
                    if !envelope { return Ok(Value::Array(rows)); }
                    let mut batch = meta.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| serde_json::json!({}));
                    batch["emails"] = Value::Array(rows);
                    Ok(batch)
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
        "header_cache_month_histogram" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    vault_root(&state)?;
                    daemon_custody::with_conn(&state, |c| sql_cache::month_histogram(c, &account_id, &mailbox))
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
                    Ok(load_mailbox_listing(&state, &account_id)?.map_or(Value::Null, Value::String))
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
        // close. `ledger` mirrors main.rs:1040-1051 verbatim; the uid space is
        // the same mailbox's, read through the store (`allocate_in`).
        "graph_allocate_uids" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let entries = req!(vec_arg::<(String, Option<String>)>(&id, params, "entries"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let uids = with_vault_write(&state, |root| {
                        // Graph-only: the app's Outlook listing RPC; the frontend treats JMAP as IMAP.
                        let ledger = root
                            .join("email_cache")
                            .join(header_cache::cache_base_name(&account_id, &mailbox))
                            .join(graph_ledger::LEDGER_FILE);
                        graph_ledger::allocate_in(&ledger, root, &account_id, &mailbox, &entries)
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
                    // Graph-only: the app's Outlook listing RPC; the frontend treats JMAP as IMAP.
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

    /// Track H2: the index keeps a row whose file is gone while the header
    /// cache lists its uid. A save that takes uids off the list is when that
    /// stops being true, so the folder is reconciled then, whichever of the
    /// file and the header went first.
    #[tokio::test]
    async fn saving_headers_that_remove_uids_nudges_the_search_index_for_that_folder() {
        let (_t, s) = st(true);
        let (tx, rx) = std::sync::mpsc::channel();
        *s.search_index.signals.lock().unwrap() = Some(tx);
        let data = json!({"emails": [{"uid": 1}, {"uid": 2}]}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "Projects/2026", "data": data})).await;
        assert!(rx.try_recv().is_err(), "a save that removes nothing does not nudge");
        let data = json!({"emails": [], "removedUids": [2]}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "Projects/2026", "data": data})).await;
        assert_eq!(
            rx.try_recv().unwrap(),
            mailvault_core::search_index::plan::Signal::Nudge { account_id: "a".into(), vault_dir: "Projects_2026".into() }
        );
    }

    /// The app's own delete, move or re-key writes `removedUids`: those
    /// messages left this server folder, so Cleanup stops listing them.
    #[tokio::test]
    async fn saving_headers_that_remove_uids_forgets_their_classifications() {
        let (_t, s) = st(true);
        crate::classification::seed_for_test(&s.app_dir, "a", &[("<1>", "Projects/2026", 1), ("<2>", "Projects/2026", 2), ("<3>", "INBOX", 3)]);
        let data = json!({"emails": [{"uid": 1}, {"uid": 2}]}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "Projects/2026", "data": data})).await;
        assert_eq!(crate::classification::keys_for_test(&s.app_dir, "a").len(), 3, "a save that removes nothing forgets nothing");
        let data = json!({"emails": [], "removedUids": [2, "3"]}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "Projects/2026", "data": data})).await;
        assert_eq!(crate::classification::keys_for_test(&s.app_dir, "a"), vec!["<1>".to_string(), "<3>".to_string()]);
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
    async fn native_batch_by_uid_envelope_is_coherent_and_additive() {
        let (_t, s) = st(true);
        let proof = json!({"accountId": "a", "mailbox": "INBOX", "uidValidity": 7, "originHash": "original"});
        crate::custody::with_conn(&s, |c| sql_cache::save_headers(c, "a", "INBOX", &json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": [{"uid": 7}]}).to_string())).unwrap();
        let envelope = call(&s, "load_email_cache_by_uids", json!({"accountId": "a", "mailbox": "INBOX", "uids": [7], "envelope": true})).await.result.unwrap();
        assert_eq!(envelope["nativeIdentity"], proof);
        assert_eq!(envelope["emails"][0]["uid"], 7);
        let old = call(&s, "load_email_cache_by_uids", json!({"accountId": "a", "mailbox": "INBOX", "uids": [7]})).await.result.unwrap();
        assert!(old.is_array());
    }

    #[tokio::test]
    async fn native_batch_rpc_rejects_endpoint_edits_but_allows_secret_refresh() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (_t, s) = st(true);
        let path = s.app_dir.join("native-batch-credentials.json");
        let mut record = json!({"id": "a", "email": "me@example.test", "imapHost": "host.example.test", "imapPort": 993, "password": "first"});
        let store = |record: &Value| std::fs::write(&path, json!({"a": record.to_string()}).to_string()).unwrap();
        store(&record);
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);
        let config = serde_json::from_value(record.clone()).unwrap();
        let proof = json!(mailvault_core::imap::NativeHeaderIdentity::new(&config, "a", "INBOX", Some(7)));
        let payload = |uid| json!({"nativeIdentity": proof, "nativeExpectedIdentity": null, "emails": [{"uid": uid, "_nativeIdentity": proof}]}).to_string();
        let first = call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": payload(7)})).await;
        record["password"] = json!("refreshed");
        store(&record);
        let secret = call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": payload(8)})).await;
        record["imapPort"] = json!(1993);
        store(&record);
        let edited = call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": payload(9)})).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert!(first.error.is_none(), "{first:?}");
        assert!(secret.error.is_none(), "{secret:?}");
        assert!(edited.error.is_some());
        let rows = crate::custody::with_conn(&s, |c| sql_cache::uid_set(c, "a", "INBOX")).unwrap();
        assert_eq!(rows, std::collections::HashSet::from([7, 8]));
    }

    /// The list's preview line rides on the rows the list reads, from the
    /// search index and not from the header cache, so a header rewrite (a
    /// flag delta, a reconcile) cannot lose it.
    #[tokio::test]
    async fn list_reads_carry_the_indexed_preview_line_through_a_header_rewrite() {
        let (_t, s) = st(true);
        let index_dir = tempfile::tempdir().unwrap();
        let conn = mailvault_core::search_index::db::open(index_dir.path()).unwrap();
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, snippet) VALUES ('a', 'INBOX', 7, '7:2,.eml', 1, 1, 1, 'Hi Ann, the invoice is attached.')",
            [],
        )
        .unwrap();
        *mailvault_core::search_index::lock(&s.search_index.db) = Some(conn);

        let save = |flags: Value| {
            let data = json!({"emails": [{"uid": 7, "flags": flags}, {"uid": 8, "flags": []}], "totalEmails": 2}).to_string();
            call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data}))
        };
        save(json!([])).await;
        save(json!(["\\Seen"])).await; // the header rewrite

        let page = call(&s, "load_email_cache_partial", json!({"accountId": "a", "mailbox": "INBOX", "limit": 50})).await.result.unwrap();
        let page: Value = serde_json::from_str(page.as_str().expect("still a JSON string")).unwrap();
        let by_uid = |rows: &Value, uid: u64| rows.as_array().unwrap().iter().find(|r| r["uid"] == uid).cloned().unwrap();
        assert_eq!(by_uid(&page["emails"], 7)["previewText"], "Hi Ann, the invoice is attached.");
        assert_eq!(by_uid(&page["emails"], 7)["flags"], json!(["\\Seen"]));
        assert!(by_uid(&page["emails"], 8).get("previewText").is_none(), "no indexed body, no preview line");

        let rows = call(&s, "load_email_cache_by_uids", json!({"accountId": "a", "mailbox": "INBOX", "uids": [7, 8]})).await.result.unwrap();
        assert_eq!(by_uid(&rows, 7)["previewText"], "Hi Ann, the invoice is attached.");
        assert!(by_uid(&rows, 8).get("previewText").is_none());
    }

    /// A row the app saves back still carries the preview a read stamped on
    /// it; the header cache must not keep it, or it would outlive its index
    /// row (body indexing turned off, the index rebuilt).
    #[tokio::test]
    async fn a_saved_row_never_carries_its_preview_into_the_header_cache() {
        let (_t, s) = st(true);
        let data = json!({"emails": [{"uid": 7, "subject": "hi", "previewText": "stale preview"}], "totalEmails": 1}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data})).await;
        let rows = call(&s, "load_email_cache_by_uids", json!({"accountId": "a", "mailbox": "INBOX", "uids": [7]})).await.result.unwrap();
        assert_eq!(rows[0]["subject"], "hi");
        assert!(rows[0].get("previewText").is_none(), "no index row, so no preview: {}", rows[0]);
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
    async fn header_cache_month_histogram_groups_by_utc_month_newest_first() {
        let (_t, s) = st(true);
        let data = json!({"emails": [
            {"uid": 1, "internalDate": "2021-03-01T00:00:00Z"},
            {"uid": 2, "internalDate": "2021-03-15T00:00:00Z"},
            {"uid": 3, "internalDate": "2021-01-05T00:00:00Z"},
        ], "totalEmails": 3}).to_string();
        call(&s, "save_email_cache", json!({"accountId": "a", "mailbox": "INBOX", "data": data})).await;
        let r = call(&s, "header_cache_month_histogram", json!({"accountId": "a", "mailbox": "INBOX"})).await.result.unwrap();
        assert_eq!(r, json!([{"ym": "2021-03", "count": 2}, {"ym": "2021-01", "count": 1}]));
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
