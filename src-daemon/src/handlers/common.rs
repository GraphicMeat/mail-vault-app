//! Shared plumbing for every Phase 2 router (`vault_files`, `cache`, `journal`,
//! `custody`, `vault_flags`, Tasks 2.6-2.9a): the blocking-task helper (moved
//! here from `handlers/search_index.rs`, which now imports it back), the
//! vault-unavailable gate, and small arg extractors.
//!
//! Task 4.7 adds the run-token registry (`RunGuard`, `cancel_kind`,
//! `pause_kind`), generalized from Task 3.4's archive/bulk_delete-only
//! `CancelGuard` (`handlers::archive`, which now delegates here too) so
//! migration and restore share the same registry rather than running a
//! second, parallel one (decision 7).

use crate::ipc::{self, RpcResponse};
use crate::server::{DaemonState, RunTokens};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Run `f` on a blocking-pool thread. Every Phase 2 handler touches disk, or a
/// mutex that guards disk work, so it never runs on a tokio worker.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Task join error: {e}"))
}

/// One list row, as the app already holds it. Every per-message store here is
/// keyed by `app_db::identity::msg_key`, and that key is derived in one place:
/// the app sends what its rows carry and never computes it itself.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageRef {
    pub account_id: String,
    #[serde(default)]
    pub mailbox: String,
    #[serde(default)]
    pub uid: u32,
    #[serde(default)]
    pub message_id: Option<String>,
}

impl MessageRef {
    pub fn msg_key(&self) -> String {
        let vault_dir = mailvault_core::search_index::text::vault_dir_name(&self.mailbox);
        mailvault_core::app_db::identity::msg_key(self.message_id.as_deref(), &vault_dir, self.uid)
    }

    pub fn target(&self) -> mailvault_core::app_db::tags::Target {
        mailvault_core::app_db::tags::Target { account_id: self.account_id.clone(), msg_key: self.msg_key() }
    }
}

pub(crate) fn done(id: Value, r: Result<Value, String>) -> RpcResponse {
    match r {
        Ok(v) => RpcResponse::success(id, v),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

/// The exact message text every `E_VAULT_UNAVAILABLE:` gate answers with —
/// callers (JS and Rust) match on this prefix verbatim (Global constraints:
/// "Same JSON in/out" / error texts callers match on).
fn gate_message(reason: &str) -> String {
    format!("E_VAULT_UNAVAILABLE: Mail storage folder unavailable: {reason}")
}

/// The gate every vault-rooted Phase 2 route calls before touching disk (spec
/// deviation 7). Never falls back to `state.app_dir`: a vault-rooted route
/// that did would silently start a second, divergent archive there when the
/// configured folder is unreachable.
pub(crate) fn vault_root(state: &Arc<DaemonState>) -> Result<PathBuf, String> {
    if !state.mail_dir_ok {
        return Err(gate_message("the folder is not reachable"));
    }
    if state.vault_closed.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(gate_message("the vault is being moved"));
    }
    Ok(state.data_dir.clone())
}

/// I3 fix (Task 2.5 fix round 1): `vault_root` alone is check-then-act — a
/// route that reads the root and only then writes can still be running when
/// `vault_close` returns, so a move can copy a store the daemon is still
/// writing into. Every Phase 2 write route (Tasks 2.6-2.9a) must go through
/// this instead of a bare `vault_root` call: it takes `vault_gate`'s read
/// side (shared across concurrent writers), re-checks `vault_root` under the
/// lock, then runs `f` with the root — `vault_close` takes the gate's write
/// side to wait out every writer already inside `f` before it closes the
/// index. MUST run on a blocking thread (`handlers::common::blocking` /
/// `spawn_blocking`): `vault_gate` is a `std::sync::RwLock` and must never be
/// held across a tokio `.await`. A job spanning many files/mailboxes calls
/// this once per file or per mailbox batch, re-checking each time, rather
/// than once around the whole job — otherwise a move would wait out the
/// entire job instead of just the current batch.
pub(crate) fn with_vault_write<T>(state: &Arc<DaemonState>, f: impl FnOnce(&std::path::Path) -> Result<T, String>) -> Result<T, String> {
    let _gate = state.vault_gate.read().unwrap_or_else(|p| p.into_inner());
    let root = vault_root(state)?;
    f(&root)
}

/// `with_vault_write` for a writer of one mailbox's files, under the vault
/// registry's per-mailbox lock, taken first (lock order: per-mailbox lock,
/// vault gate, custody, registry connection). Two writers of one mailbox then
/// never interleave a file op with the other's registry update: a delete that
/// unlinks and then tombstones cannot land its tombstone over a re-store that
/// ran in between. `f` must not call a verifying registry read (`uid_sets`,
/// `light_rows`, `resolve`): that lock is not reentrant. `known` is fine.
pub(crate) fn with_mailbox_write<T>(
    state: &Arc<DaemonState>,
    account_id: &str,
    mailbox: &str,
    f: impl FnOnce(&std::path::Path) -> Result<T, String>,
) -> Result<T, String> {
    state.vault_registry.serialized(account_id, mailbox, || with_vault_write(state, f))
}

/// A required string param. `Err` names the missing key, as `INVALID_PARAMS`.
pub(crate) fn str_arg(id: &Value, params: &Value, key: &str) -> Result<String, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// An optional string param — absent or non-string both read as `None`.
pub(crate) fn opt_str_arg(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// An optional f64 param (`list_cached_uids`'s `sinceMs`) — absent or
/// non-numeric both read as `None`.
pub(crate) fn opt_f64_arg(params: &Value, key: &str) -> Option<f64> {
    params.get(key).and_then(Value::as_f64)
}

/// A required u32 param (JSON numbers arrive as u64; every uid fits u32).
pub(crate) fn u32_arg(id: &Value, params: &Value, key: &str) -> Result<u32, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// An optional u32 param (`imap_get_emails`'s `page`/`limit`) — absent or
/// non-numeric both read as `None`, same shape as `opt_f64_arg`.
pub(crate) fn opt_u32_arg(params: &Value, key: &str) -> Option<u32> {
    params.get(key).and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok())
}

/// A required u64 param (`imap_fetch_changed_flags`'s `sinceModseq`, which can
/// exceed u32 on a long-lived mailbox).
pub(crate) fn u64_arg(id: &Value, params: &Value, key: &str) -> Result<u64, RpcResponse> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// A required array param, deserialized element-wise (uid lists, change lists).
pub(crate) fn vec_arg<T: serde::de::DeserializeOwned>(id: &Value, params: &Value, key: &str) -> Result<Vec<T>, RpcResponse> {
    params
        .get(key)
        .and_then(|v| serde_json::from_value::<Vec<T>>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, format!("Missing {key}")))
}

/// A mailbox name made safe for use as a directory component. Task 4.5
/// promoted this here so `mbox` could reuse it instead of holding its own
/// copy; `backup_zip` and `insights` each still carried a private copy of the
/// exact same function until now, folded into this one.
pub(crate) fn sanitize_mailbox_name(mailbox: &str) -> String {
    let safe: String = mailbox.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    #[cfg(windows)]
    let safe = mailvault_core::search_index::text::avoid_reserved(&safe);
    safe
}

// ── Run-token registry (Task 3.4, generalized by Task 4.7 decision 7) ───────

/// RAII registration: pushes a fresh `RunTokens` under `kind` into
/// `DaemonState.run_tokens` and removes exactly that entry (by pointer
/// identity, never by value, so a sibling run's token of the same kind is
/// never touched) on every exit path -- success, error, cancellation, or a
/// panic inside the run. A `Vec` per kind (not one slot) is what lets two
/// concurrent runs of the same kind each stay individually cancellable
/// (Task 3.4's N4 fix). Construct it before the run starts and let it fall
/// out of scope (or be dropped explicitly) on every exit path.
pub(crate) struct RunGuard {
    state: Arc<DaemonState>,
    kind: &'static str,
    tokens: Arc<RunTokens>,
}

impl RunGuard {
    /// Cancel-only registration: archive, bulk_delete, restore.
    pub(crate) fn register(state: &Arc<DaemonState>, kind: &'static str) -> Self {
        Self::register_tokens(state, kind, None, None)
    }

    /// Cancel + pause + notify registration: migration.
    pub(crate) fn register_with_pause(state: &Arc<DaemonState>, kind: &'static str) -> Self {
        Self::register_tokens(
            state,
            kind,
            Some(Arc::new(AtomicBool::new(false))),
            Some(Arc::new(tokio::sync::Notify::new())),
        )
    }

    fn register_tokens(
        state: &Arc<DaemonState>,
        kind: &'static str,
        pause: Option<Arc<AtomicBool>>,
        notify: Option<Arc<tokio::sync::Notify>>,
    ) -> Self {
        let tokens = Arc::new(RunTokens { cancel: Arc::new(AtomicBool::new(false)), pause, notify });
        state
            .run_tokens
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(kind)
            .or_default()
            .push(Arc::clone(&tokens));
        Self { state: Arc::clone(state), kind, tokens }
    }

    pub(crate) fn cancel(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.tokens.cancel)
    }

    /// Panics if this guard was registered cancel-only -- a programming
    /// error (a route asking for a pause token a kind was never given),
    /// never a runtime condition.
    pub(crate) fn pause(&self) -> Arc<AtomicBool> {
        self.tokens.pause.clone().expect("pause token requested on a cancel-only RunGuard")
    }

    pub(crate) fn notify(&self) -> Arc<tokio::sync::Notify> {
        self.tokens.notify.clone().expect("notify requested on a cancel-only RunGuard")
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut map = self.state.run_tokens.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tokens) = map.get_mut(self.kind) {
            tokens.retain(|t| !Arc::ptr_eq(t, &self.tokens));
            if tokens.is_empty() {
                // A present-but-empty Vec is still a leak an "is the map
                // empty" test would miss: drop the whole entry.
                map.remove(self.kind);
            }
        }
    }
}

/// Sets the cancel flag on every currently-registered token under `kind` and
/// wakes any waiter (migration's pause loop blocks on `notify`; a kind with
/// no notify token simply has nothing to wake). Returns how many runs were
/// hit.
pub(crate) fn cancel_kind(state: &Arc<DaemonState>, kind: &'static str) -> usize {
    let map = state.run_tokens.lock().unwrap_or_else(|p| p.into_inner());
    match map.get(kind) {
        Some(tokens) => {
            for t in tokens {
                t.cancel.store(true, Ordering::Relaxed);
                if let Some(n) = &t.notify {
                    n.notify_waiters();
                }
            }
            tokens.len()
        }
        None => 0,
    }
}

/// Sets the pause flag on every currently-registered token under `kind` that
/// has one, and wakes any waiter. Only "migration" is ever registered with a
/// pause token; a kind without one (archive, bulk_delete, restore) simply has
/// nothing to set. Returns how many runs actually had a pause token flipped.
pub(crate) fn pause_kind(state: &Arc<DaemonState>, kind: &'static str) -> usize {
    let map = state.run_tokens.lock().unwrap_or_else(|p| p.into_inner());
    match map.get(kind) {
        Some(tokens) => {
            let mut hit = 0;
            for t in tokens {
                if let Some(p) = &t.pause {
                    p.store(true, Ordering::Relaxed);
                    hit += 1;
                }
                if let Some(n) = &t.notify {
                    n.notify_waiters();
                }
            }
            hit
        }
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(mail_dir_ok: bool) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-common-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, mail_dir_ok)
    }

    #[test]
    fn vault_root_refuses_an_unreachable_folder() {
        let st = state(false);
        let err = vault_root(&st).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("not reachable"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn vault_root_refuses_while_the_vault_is_closed_for_a_move() {
        let st = state(true);
        st.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = vault_root(&st).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn vault_root_succeeds_when_ok_and_not_closed() {
        let st = state(true);
        assert_eq!(vault_root(&st).unwrap(), st.data_dir);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// Task 2.7 (2.3 review F1): cache handlers must pass the IDENTICAL
    /// `PathBuf` `sync_engine` writes into — the header-cache lock registry
    /// (`mailvault_core::header_cache::lock_tree`/`lock_mailbox`) keys on the
    /// raw path, so two spellings of the same root (e.g. one with a trailing
    /// component resolved differently) would silently give a cache handler
    /// and a sync write two different locks over one directory.
    ///
    /// Task 2.8 carry-in (2.7 review I2): the original version of this test
    /// used `state(true)`, whose helper wires one tempdir as both `mail_dir`
    /// and `app_dir` — so `vault_root` and `sync_engine.data_dir()` compared
    /// equal whether `vault_root` correctly returned `data_dir` OR incorrectly
    /// returned `app_dir`. Two distinct real tempdirs here so the assertion
    /// can actually fail on that bug.
    #[test]
    fn vault_root_and_sync_engines_root_are_the_same_path() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let st = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        assert_eq!(vault_root(&st).unwrap(), st.sync_engine.data_dir());
        assert_eq!(vault_root(&st).unwrap(), vault.path());
    }

    #[test]
    fn str_arg_names_the_missing_key() {
        let err = str_arg(&json!(1), &json!({}), "accountId").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("accountId"), "{}", error.message);
    }

    #[test]
    fn str_arg_reads_a_present_value() {
        assert_eq!(str_arg(&json!(1), &json!({"accountId": "a1"}), "accountId").unwrap(), "a1");
    }

    #[test]
    fn opt_str_arg_is_none_when_absent() {
        assert_eq!(opt_str_arg(&json!({}), "mailbox"), None);
        assert_eq!(opt_str_arg(&json!({"mailbox": "INBOX"}), "mailbox"), Some("INBOX".to_string()));
    }

    #[test]
    fn u32_arg_names_the_missing_key() {
        let err = u32_arg(&json!(1), &json!({}), "uid").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("uid"), "{}", error.message);
        assert_eq!(u32_arg(&json!(1), &json!({"uid": 7}), "uid").unwrap(), 7);
    }

    #[test]
    fn opt_u32_arg_is_none_when_absent() {
        assert_eq!(opt_u32_arg(&json!({}), "page"), None);
        assert_eq!(opt_u32_arg(&json!({"page": 3}), "page"), Some(3));
    }

    #[test]
    fn u64_arg_names_the_missing_key() {
        let err = u64_arg(&json!(1), &json!({}), "sinceModseq").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("sinceModseq"), "{}", error.message);
        assert_eq!(u64_arg(&json!(1), &json!({"sinceModseq": 40}), "sinceModseq").unwrap(), 40);
    }

    #[test]
    fn vec_arg_names_the_missing_key() {
        let err = vec_arg::<u32>(&json!(1), &json!({}), "uids").unwrap_err();
        let error = err.error.unwrap();
        assert_eq!(error.code, ipc::INVALID_PARAMS);
        assert!(error.message.contains("uids"), "{}", error.message);
        assert_eq!(vec_arg::<u32>(&json!(1), &json!({"uids": [1, 2]}), "uids").unwrap(), vec![1, 2]);
    }

    // -----------------------------------------------------------------------
    // Task 2.5 fix round 1 (I3): with_vault_write
    // -----------------------------------------------------------------------

    #[test]
    fn with_vault_write_runs_the_closure_with_the_vault_root() {
        let st = state(true);
        let root = with_vault_write(&st, |root| Ok(root.to_path_buf())).unwrap();
        assert_eq!(root, st.data_dir);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn with_vault_write_refuses_while_the_vault_is_closed_for_a_move() {
        let st = state(true);
        st.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = with_vault_write(&st, |_root| Ok(())).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(err.contains("being moved"), "{err}");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// The other half of the drain lives in `handlers::search_index`'s
    /// `vault_close` route, tested end-to-end there against a real writer
    /// blocked inside `with_vault_write`; this only proves the primitive
    /// itself blocks a concurrent write side.
    #[test]
    fn with_vault_write_holds_the_gate_for_the_closures_duration() {
        let st = state(true);
        let order = Arc::new(std::sync::Mutex::new(Vec::<&str>::new()));
        let order2 = Arc::clone(&order);
        let st2 = Arc::clone(&st);
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn(move || {
            with_vault_write(&st2, |_root| {
                order2.lock().unwrap().push("writer-in");
                release_rx.recv().ok();
                order2.lock().unwrap().push("writer-out");
                Ok::<(), String>(())
            })
        });
        // Give the writer a chance to actually enter the closure first.
        while order.lock().unwrap().is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let drain_order = Arc::clone(&order);
        let st3 = Arc::clone(&st);
        let drainer = std::thread::spawn(move || {
            let _write_guard = st3.vault_gate.write().unwrap_or_else(|p| p.into_inner());
            drain_order.lock().unwrap().push("drain-acquired");
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(*order.lock().unwrap(), vec!["writer-in"], "the drain must not proceed while the writer is inside with_vault_write");
        release_tx.send(()).unwrap();
        writer.join().unwrap().unwrap();
        drainer.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["writer-in", "writer-out", "drain-acquired"]);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    // -----------------------------------------------------------------------
    // Task 4.7: the run-token registry (generalized from Task 3.4's
    // archive/bulk_delete-only CancelGuard, decision 7)
    // -----------------------------------------------------------------------

    fn run_tokens_snapshot(s: &Arc<DaemonState>) -> std::collections::HashMap<&'static str, usize> {
        s.run_tokens.lock().unwrap().iter().map(|(k, v)| (*k, v.len())).collect()
    }

    #[test]
    fn register_adds_one_entry_under_its_kind_and_drop_removes_it() {
        let st = state(true);
        {
            let _guard = RunGuard::register(&st, "restore");
            assert_eq!(run_tokens_snapshot(&st).get("restore"), Some(&1));
        }
        assert_eq!(run_tokens_snapshot(&st).get("restore"), None, "the map must not keep a present-but-empty entry");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// The N4 regression this registry exists to prevent: today's design
    /// (before Task 3.4) shared one `Arc` per kind, so starting a second run
    /// silently replaced the first's token, orphaning it uncancellably.
    /// Mirrors Task 3.4's own Step 1 test, now proven for a kind ("migration")
    /// that also carries pause/notify companions.
    #[test]
    fn a_second_run_of_the_same_kind_does_not_orphan_the_first() {
        let st = state(true);
        let g1 = RunGuard::register_with_pause(&st, "migration");
        let t1 = g1.cancel();
        let _g2 = RunGuard::register_with_pause(&st, "migration");
        let hit = cancel_kind(&st, "migration");
        assert_eq!(hit, 2, "both concurrent migration runs are individually tracked");
        assert!(t1.load(Ordering::Relaxed), "the first run must still be cancellable after a second one starts");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn cancel_kind_never_touches_a_different_kinds_tokens() {
        let st = state(true);
        let restore_guard = RunGuard::register(&st, "restore");
        let hit = cancel_kind(&st, "migration");
        assert_eq!(hit, 0, "no migration token is registered");
        assert!(!restore_guard.cancel().load(Ordering::Relaxed), "cancel_migration-equivalent must not cancel a live restore");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    #[test]
    fn cancel_only_registration_has_no_pause_or_notify_token() {
        let st = state(true);
        let guard = RunGuard::register(&st, "restore");
        assert!(guard.tokens.pause.is_none());
        assert!(guard.tokens.notify.is_none());
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// `notify_waiters()` only wakes a task already parked on `.notified()`
    /// at the moment it is called -- a bare `.notified().await` issued
    /// afterward would hang forever. Parks a waiter first, then proves
    /// `pause_kind` both flips the flag and actually wakes it.
    #[tokio::test]
    async fn pause_kind_sets_the_flag_and_wakes_a_waiting_notified() {
        let st = state(true);
        let guard = RunGuard::register_with_pause(&st, "migration");
        let pause = guard.pause();
        let notify = guard.notify();
        assert!(!pause.load(Ordering::Relaxed));

        let waiter = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), notify.notified())
                .await
                .expect("pause_kind must wake a task already parked on notified()")
        });
        // Give the spawned task a chance to actually park on notified()
        // before pause_kind fires the wake.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let hit = pause_kind(&st, "migration");
        assert_eq!(hit, 1);
        assert!(pause.load(Ordering::Relaxed));

        waiter.await.expect("waiter task panicked");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// A kind registered cancel-only (restore) has nothing for `pause_kind`
    /// to set: it must be a safe no-op, not a panic.
    #[test]
    fn pause_kind_on_a_cancel_only_kind_is_a_harmless_no_op() {
        let st = state(true);
        let _guard = RunGuard::register(&st, "restore");
        let hit = pause_kind(&st, "restore");
        assert_eq!(hit, 0);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }
}
