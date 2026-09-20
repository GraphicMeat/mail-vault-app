//! The search index RPCs (spec 2026-09-14 §5.3), same names and payloads as the
//! app's former Tauri commands. Every route blocks on the index: spawn_blocking.
//!
//! `vault_close` / `vault_reopen` live here too (Task 2.5, spec deviation 8):
//! they replace the old `search_index_close` / `search_index_reopen` names.
//! Renamed, not just moved, because Task 2.9a/b makes them close/reopen
//! custody as well — "search index" stopped describing what they guard.
use crate::handlers::common::{blocking, done};
use crate::ipc::{self, RpcResponse};
use crate::search_index as si;
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tracing::info;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let st = Arc::clone(&state.search_index);
    Some(match method {
        "search_index_status" => done(id, blocking(move || si::status_json(&st)).await),
        "search_index_configure" => {
            let Some(args) = params.get("config").and_then(|c| serde_json::from_value::<si::ConfigArgs>(c.clone()).ok()) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing config"));
            };
            done(id, blocking(move || { si::configure(&st, args); Value::Null }).await)
        }
        "search_index_rebuild" => done(id, blocking(move || { si::rebuild(&st); Value::Null }).await),
        // Two minutes: the worker finishes its current batch or compaction first.
        "search_index_destroy" => done(id, blocking(move || si::destroy(&st, Duration::from_secs(120))).await),
        // Set the flag before closing: a request racing in right now must see
        // the vault as unavailable, not slip through between the two. I3 fix
        // (Task 2.5 fix round 1): the flag alone is check-then-act — a
        // writer that read the root before the flag flipped can still be
        // mid-write. Drain: take (and immediately drop) `vault_gate`'s write
        // side, which waits for every writer already inside
        // `handlers::common::with_vault_write` to finish, before closing the
        // index. M1: log lines so an e2e run can prove this reached a live
        // daemon (`vault_close: closed` on completion), not just infer it.
        "vault_close" => {
            info!("vault_close: closing the search index and custody store");
            state.vault_closed.store(true, Ordering::SeqCst);
            let gate_state = Arc::clone(state);
            let reply = done(
                id,
                blocking(move || {
                    drop(gate_state.vault_gate.write().unwrap_or_else(|p| p.into_inner()));
                    si::close(&st);
                    // Task 2.9a: custody closes in the same drained window —
                    // drop = checkpoint, so a copy of custody.db right after
                    // this is complete (no `-wal` left behind).
                    crate::custody::close(&gate_state);
                    Value::Null
                })
                .await,
            );
            info!("vault_close: closed");
            reply
        }
        // Reverse order: only clear the flag once every store this guards has
        // actually reopened. M2: for the search index, `si::reopen` only ends
        // the current switch and sends `Signal::Reopen` — the worker opens
        // the new connection later, so in practice the flag clears before the
        // index itself is open (harmless for the index, which answers
        // `available: false` until then). Task 2.9a: `crate::custody::reopen`
        // is synchronous (unlike the index's worker-thread reopen) and runs
        // BEFORE `vault_closed` clears below, so a gated custody route can
        // never pass the gate and still hit `custody store unavailable:
        // closed`.
        "vault_reopen" => {
            info!("vault_reopen: reopening the search index and custody store");
            let reopen_state = Arc::clone(state);
            let reply = done(
                id,
                blocking(move || -> Result<Value, String> {
                    si::reopen(&st);
                    // 2.9a review I1: a custody store that will not reopen is
                    // answered as a failed `vault_reopen`, so the app's own
                    // lifecycle error path stops the daemon and the channel
                    // respawns it against whatever root is current. Silently
                    // answering success left it closed for the daemon's life.
                    //
                    // The one Err that is not a failure: there is no root to
                    // open at all. A restart cannot conjure an unplugged drive,
                    // `custody_status` already reports it, and `vault_close` /
                    // `vault_reopen` are called whether or not the vault is
                    // reachable — they must not be refused for being called
                    // then.
                    match crate::custody::reopen(&reopen_state) {
                        Ok(()) => {
                            // A different vault root can carry legacy JSON of
                            // its own; the pass is a no-op (one marker read
                            // per mailbox) when it does not.
                            crate::custody::spawn_legacy_import(Arc::clone(&reopen_state));
                            Ok(Value::Null)
                        }
                        Err(_) if !reopen_state.mail_dir_ok => Ok(Value::Null),
                        Err(e) => Err(format!("custody reopen failed: {e}")),
                    }
                })
                .await
                .and_then(|r| r),
            );
            state.vault_closed.store(false, Ordering::SeqCst);
            info!("vault_reopen: reopened");
            reply
        }
        "vault_search" => {
            let Some(request) = params.get("request").and_then(|r| serde_json::from_value::<mailvault_core::search_index::query::SearchRequest>(r.clone()).ok()) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing request"));
            };
            done(id, blocking(move || si::search_reply(&st, &request)).await.and_then(|r| r))
        }
        "vault_rows" => {
            let account = params.get("accountId").and_then(Value::as_str).map(str::to_owned);
            let mailbox = params.get("mailbox").and_then(Value::as_str).map(str::to_owned);
            let uids = params.get("uids").and_then(|u| serde_json::from_value::<Vec<u32>>(u.clone()).ok());
            let (Some(account), Some(mailbox), Some(uids)) = (account, mailbox, uids) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId, mailbox or uids"));
            };
            done(id, blocking(move || Value::Array(si::rows_reply(&st, &account, &mailbox, &uids))).await)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::ipc;
    use crate::server::DaemonState;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use std::time::Duration;

    fn st() -> (tempfile::TempDir, std::sync::Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true);
        (tmp, s)
    }

    async fn call(s: &std::sync::Arc<DaemonState>, method: &str, params: serde_json::Value) -> ipc::RpcResponse {
        super::route(s, method, &params, json!(1)).await.expect("routed")
    }

    #[tokio::test]
    async fn status_before_any_configure_is_starting_with_first_pass_done_false() {
        let (_t, s) = st();
        let r = call(&s, "search_index_status", json!({})).await.result.unwrap();
        assert_eq!(r["state"], "starting");
        assert_eq!(r["firstPassDone"], false);
    }

    #[tokio::test]
    async fn configure_off_answers_null_and_status_reports_off_without_a_file() {
        let (t, s) = st();
        let r = call(&s, "search_index_configure", json!({"config": {"enabled": false, "bodies": true, "attachments": false, "imageText": false}})).await;
        assert_eq!(r.result, Some(serde_json::Value::Null));
        assert_eq!(call(&s, "search_index_status", json!({})).await.result.unwrap()["state"], "off");
        assert!(!t.path().join("search_index").join("index.db").exists());
    }

    #[tokio::test]
    async fn configure_without_config_is_invalid_params() {
        let (_t, s) = st();
        assert_eq!(call(&s, "search_index_configure", json!({})).await.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn vault_search_on_a_closed_index_is_unavailable() {
        let (_t, s) = st();
        let r = call(&s, "vault_search", json!({"request": {"accountId": "a", "query": "x"}})).await.result.unwrap();
        assert_eq!(r, json!({"available": false, "reason": "unavailable"}));
    }

    #[tokio::test]
    async fn vault_rows_needs_account_mailbox_and_uids() {
        let (_t, s) = st();
        assert_eq!(call(&s, "vault_rows", json!({"accountId": "a", "mailbox": "INBOX"})).await.error.unwrap().code, ipc::INVALID_PARAMS);
        assert_eq!(call(&s, "vault_rows", json!({"accountId": "a", "mailbox": "INBOX", "uids": [1]})).await.result.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn destroy_on_a_switching_index_is_busy() {
        let (_t, s) = st();
        assert_eq!(call(&s, "vault_close", json!({})).await.result, Some(serde_json::Value::Null));
        assert_eq!(call(&s, "search_index_destroy", json!({})).await.result.unwrap(), json!({"ok": false, "error": "searchIndex.busy"}));
        assert_eq!(call(&s, "vault_reopen", json!({})).await.result, Some(serde_json::Value::Null));
    }

    /// M3 rename (Task 2.5 fix round 1): the old name
    /// `vault_close_sets_the_flag_before_closing_and_reopen_clears_it_after`
    /// promised an order this body cannot observe (both calls already
    /// returned by the time either assertion runs) — it only checks the
    /// flag's value after each call, so it's named for that.
    #[tokio::test]
    async fn vault_close_sets_the_flag_and_vault_reopen_clears_it() {
        let (_t, s) = st();
        assert!(!s.vault_closed.load(std::sync::atomic::Ordering::SeqCst));
        call(&s, "vault_close", json!({})).await;
        assert!(s.vault_closed.load(std::sync::atomic::Ordering::SeqCst));
        call(&s, "vault_reopen", json!({})).await;
        assert!(!s.vault_closed.load(std::sync::atomic::Ordering::SeqCst));
    }

    // -------------------------------------------------------------------
    // Task 2.5 fix round 1 (I3): the writer barrier, exercised through the
    // real `vault_close` route rather than the raw `vault_gate` primitive
    // (that half is covered directly in `handlers::common`'s tests).
    // -------------------------------------------------------------------

    /// A writer holding the gate (via `with_vault_write`, as every real
    /// route will from Task 2.6 on) makes `vault_close` wait until it
    /// finishes, instead of returning while the write may still be in
    /// flight.
    #[tokio::test]
    async fn vault_close_waits_for_an_in_flight_writer_holding_the_gate() {
        let (_t, s) = st();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let s_writer = Arc::clone(&s);
        let writer = tokio::task::spawn_blocking(move || {
            crate::handlers::common::with_vault_write(&s_writer, |_root| {
                release_rx.recv().ok();
                Ok::<(), String>(())
            })
        });
        // Give the writer a real chance to acquire the gate before vault_close starts.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let s_close = Arc::clone(&s);
        let closer = tokio::spawn(async move { call(&s_close, "vault_close", json!({})).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!closer.is_finished(), "vault_close must wait for the in-flight writer to release the gate");
        release_tx.send(()).unwrap();
        writer.await.unwrap().unwrap();
        let resp = closer.await.unwrap();
        assert_eq!(resp.result, Some(Value::Null));
    }

    /// A writer that starts only after `vault_close` has already set the
    /// flag sees the moving error immediately — it never has to wait for a
    /// close that already happened.
    #[tokio::test]
    async fn a_writer_starting_after_close_sees_the_moving_error() {
        let (_t, s) = st();
        call(&s, "vault_close", json!({})).await;
        let err = crate::handlers::common::with_vault_write(&s, |_root| Ok::<(), String>(())).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
    }

    /// A route gated on `vault_root` (Task 2.6+) must see the vault as
    /// unreachable between `vault_close` and `vault_reopen`, and reachable
    /// again immediately after — this is what `common::vault_root` reads.
    #[tokio::test]
    async fn vault_root_is_gated_between_close_and_reopen_and_clear_after() {
        let (_t, s) = st();
        assert!(crate::handlers::common::vault_root(&s).is_ok());
        call(&s, "vault_close", json!({})).await;
        let err = crate::handlers::common::vault_root(&s).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
        call(&s, "vault_reopen", json!({})).await;
        assert!(crate::handlers::common::vault_root(&s).is_ok());
    }

    #[tokio::test]
    async fn rebuild_answers_null() {
        let (_t, s) = st();
        assert_eq!(call(&s, "search_index_rebuild", json!({})).await.result, Some(serde_json::Value::Null));
    }

    #[tokio::test]
    async fn search_index_methods_are_not_behind_the_mail_dir_gate() {
        let tmp = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        let resp = crate::server::handle_request_for_test(&s, "search_index_status", json!({})).await;
        assert_eq!(resp.result.unwrap()["state"], "starting");
    }

    /// `vault_close`/`vault_reopen` are the app's own move machinery, called
    /// whether or not the vault is currently reachable — they must never
    /// themselves be refused by the mail-dir gate (unlike the routes gated
    /// through `common::vault_root`, which they toggle).
    #[tokio::test]
    async fn vault_close_and_reopen_are_not_behind_the_mail_dir_gate() {
        let tmp = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        assert_eq!(crate::server::handle_request_for_test(&s, "vault_close", json!({})).await.result, Some(serde_json::Value::Null));
        assert_eq!(crate::server::handle_request_for_test(&s, "vault_reopen", json!({})).await.result, Some(serde_json::Value::Null));
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_t, s) = st();
        assert!(super::route(&s, "sync.now", &json!({}), json!(1)).await.is_none());
    }

    /// Review focus 1.6: "`vault_search` query errors surface as JSON-RPC
    /// errors". Drops the `messages` table out from under an otherwise
    /// available, first-pass-done index so `core::query::search`'s own
    /// `SELECT ... FROM messages` fails — the one way `search_reply` can
    /// return `Err` once past its `available`/`first_pass_done` guards.
    #[tokio::test]
    async fn vault_search_query_errors_surface_as_json_rpc_errors() {
        let (t, s) = st();
        {
            use mailvault_core::search_index::{db, lock};
            *lock(&s.search_index.db) = Some(db::open(t.path()).unwrap());
            *s.search_index.root.lock().unwrap() = Some(t.path().to_path_buf());
            let guard = lock(&s.search_index.db);
            let conn = guard.as_ref().unwrap();
            db::meta_set(conn, db::FIRST_PASS_DONE, "1").unwrap();
            conn.execute_batch("DROP TABLE messages;").unwrap();
        }
        let r = call(&s, "vault_search", json!({"request": {"accountId": "a", "query": "x"}})).await;
        assert_eq!(r.error.expect("a broken index must answer a JSON-RPC error, not a bare {available:false}").code, ipc::INTERNAL_ERROR);
    }
}
