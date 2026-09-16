//! Daemon routes for archive, bulk delete and verify (Task 3.4), calling into
//! `mailvault_core::archive` (Task 3.2) with the daemon's own sinks: the bus
//! for `emit`, an in-process custody upsert for `custody_append`, and
//! `search_index::nudge`. `bulk_delete_emails` is intentionally ungated (it
//! touches only the IMAP server, no vault file, inventory-archive-bulk §3.2);
//! `archive_emails` and `verify_archived_emails` go through
//! `common::vault_root` / `common::with_vault_write` like every other Phase 2
//! vault route.
//!
//! Cancel tokens are per-operation-kind daemon state (`DaemonState.cancels`).
//! This fixes a pre-existing bug (inventory-archive-bulk N4): the app's
//! single global `ArchiveCancelToken` was shared by `archive_emails` and
//! `bulk_delete_emails`, each replacing the same `Arc` on entry, so
//! `cancel_archive` could stop a bulk delete, and starting a second run
//! orphaned the first uncancellably. `CancelGuard` below registers one fresh
//! token per run under its kind and removes it again through `Drop` on every
//! exit path: success, error, cancellation, or a panic inside the run.
//!
//! ponytail: two live `ImapPool`s per account until Phase 5 unifies IMAP
//! connection handling: a migrated archive uses this daemon's pool
//! (`server.rs`'s `imap_pool`) while the app's own pool still serves
//! interactive IMAP. Documented, accepted ceiling (plan decision 6), not
//! something to fix here.

use crate::handlers::common::{self, blocking, done, str_arg, vec_arg, with_vault_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::archive::{self, ArchiveCtx, ArchiveGate, ArchiveSinks};
use mailvault_core::custody::entries;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::warn;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

// ── Cancel registry (Step 2: fixes inventory N4) ────────────────────────────

/// Registers one fresh cancel token under `kind` ("archive" | "bulk_delete")
/// for the run's whole lifetime and removes exactly that token, by pointer
/// identity, never by value, so a sibling run's token of the same kind is
/// never touched, on drop. Construct it before the run starts and let it
/// fall out of scope (or be dropped explicitly) on every exit path; a `Vec`
/// per kind (not one slot) is what lets two concurrent runs of the same kind
/// each stay individually cancellable.
pub(crate) struct CancelGuard {
    state: Arc<DaemonState>,
    kind: &'static str,
    token: Arc<AtomicBool>,
}

impl CancelGuard {
    pub(crate) fn register(state: &Arc<DaemonState>, kind: &'static str) -> Self {
        let token = Arc::new(AtomicBool::new(false));
        state
            .cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(kind)
            .or_default()
            .push(Arc::clone(&token));
        Self { state: Arc::clone(state), kind, token }
    }

    pub(crate) fn token(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.token)
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut map = self.state.cancels.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tokens) = map.get_mut(self.kind) {
            tokens.retain(|t| !Arc::ptr_eq(t, &self.token));
            if tokens.is_empty() {
                // A present-but-empty Vec is still a leak an "is the map
                // empty" test would miss: drop the whole entry.
                map.remove(self.kind);
            }
        }
    }
}

/// Sets every currently-registered token under `kind` and returns how many.
/// `cancel_archive` calls this with `"archive"`, the new `cancel_bulk_delete`
/// with `"bulk_delete"`; each reaches only its own kind's runs.
fn cancel_kind(state: &Arc<DaemonState>, kind: &'static str) -> usize {
    let map = state.cancels.lock().unwrap_or_else(|p| p.into_inner());
    match map.get(kind) {
        Some(tokens) => {
            for t in tokens {
                t.store(true, Ordering::Relaxed);
            }
            tokens.len()
        }
        None => 0,
    }
}

// ── Context builder ──────────────────────────────────────────────────────

/// `root` is resolved once by the caller (`common::vault_root` for the gated
/// routes, an unused empty path for the ungated `bulk_delete_emails`, which
/// never reads `ctx.root`). The gate wraps `common::with_vault_write` so a
/// vault move started mid-run refuses the per-file write instead of landing
/// it in a stale root. Safe to take the vault-gate read lock here even
/// though `with_vault_write`'s own doc says "blocking thread only": the core
/// runner only ever calls `ctx.gate` from inside its own `spawn_blocking`
/// (`src-core/src/archive.rs:510-571`), never across a tokio `.await`.
fn archive_ctx(state: &Arc<DaemonState>, root: std::path::PathBuf) -> Arc<ArchiveCtx> {
    let bus = state.events.clone();
    let emit: Arc<dyn Fn(&str, Value) + Send + Sync> = Arc::new(move |name: &str, payload: Value| {
        bus.emit(name, payload);
    });

    let custody_state = Arc::clone(state);
    let custody_append: Arc<dyn Fn(&str, &str, String) -> Result<usize, String> + Send + Sync> =
        Arc::new(move |account_id: &str, mailbox: &str, entries_json: String| {
            let new_entries: Vec<Value> = serde_json::from_str(&entries_json).map_err(|e| e.to_string())?;
            // The same shared function `local_index_append` routes to
            // (`handlers::custody`), no second SQL implementation.
            crate::custody::with_conn(&custody_state, |c| {
                let (written, skipped) = entries::upsert(c, account_id, mailbox, &new_entries)?;
                if skipped > 0 {
                    warn!("archive: {account_id}/{mailbox}: {skipped} entries without a uid skipped");
                }
                Ok(written)
            })
        });

    let nudge_state = Arc::clone(state);
    let nudge: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(move |account_id: &str, mailbox: &str| {
        crate::search_index::nudge(&nudge_state.search_index, account_id, mailbox);
    });

    let gate_state = Arc::clone(state);
    let gate: ArchiveGate = Arc::new(move |work: &mut dyn FnMut() -> Result<(), String>| {
        with_vault_write(&gate_state, |_root| work())
    });

    Arc::new(ArchiveCtx {
        root,
        pool: Arc::clone(&state.imap_pool),
        gate,
        sinks: ArchiveSinks { emit, custody_append, nudge },
    })
}

fn progress_reply(id: Value, result: Result<mailvault_core::archive::ArchiveProgress, String>) -> RpcResponse {
    match result {
        Ok(progress) => match serde_json::to_value(&progress) {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()),
        },
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

// ── Routes ───────────────────────────────────────────────────────────────

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "archive_emails" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account_json = req!(str_arg(&id, params, "accountJson"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let state = Arc::clone(state);
            let root = match common::vault_root(&state) {
                Ok(r) => r,
                Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
            };
            let ctx = archive_ctx(&state, root);
            let guard = CancelGuard::register(&state, "archive");
            let cancel = guard.token();
            let result = archive::run(ctx, account_id, account_json, mailbox, uids, cancel).await;
            drop(guard);
            progress_reply(id, result)
        }
        // Ungated by design (inventory-archive-bulk §3.2): a bulk delete
        // never touches the vault, custody or the search index, only the
        // IMAP server. `root` stays an unused empty path rather than
        // resolving `vault_root` (which would gate a route that has nothing
        // to gate) or falling back to `state.app_dir`.
        "bulk_delete_emails" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account_json = req!(str_arg(&id, params, "accountJson"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let state = Arc::clone(state);
            let ctx = archive_ctx(&state, std::path::PathBuf::new());
            let guard = CancelGuard::register(&state, "bulk_delete");
            let cancel = guard.token();
            let result = archive::bulk_delete(ctx, account_id, account_json, mailbox, uids, cancel).await;
            drop(guard);
            progress_reply(id, result)
        }
        "verify_archived_emails" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            // `null` (api.js's default when the caller omits it) and an
            // absent key both read as "no expected ids", not a parse error.
            let expected_ids: Option<std::collections::HashMap<u32, String>> = match params.get("expectedIds") {
                None | Some(Value::Null) => None,
                Some(v) => match serde_json::from_value(v.clone()) {
                    Ok(m) => Some(m),
                    Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Invalid expectedIds: {e}"))),
                },
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = common::vault_root(&state)?;
                    let cur_dir = mailvault_core::vault_files::cur_path(&root, &account_id, &mailbox);
                    let (verified, missing, mismatched) =
                        mailvault_core::maildir::verify_copies(&cur_dir, &uids, expected_ids.as_ref());
                    Ok(serde_json::json!({
                        "verified": verified,
                        "missing": missing,
                        "mismatched": mismatched,
                    }))
                })
                .await
                .and_then(|r| r),
            )
        }
        // Ungated, no vault: same shape as the app's `cancel_archive` (one
        // atomic store), except it reaches every run currently registered
        // under its own kind instead of a single shared token.
        "cancel_archive" => RpcResponse::success(id, serde_json::json!({"cancelled": cancel_kind(state, "archive")})),
        "cancel_bulk_delete" => RpcResponse::success(id, serde_json::json!({"cancelled": cancel_kind(state, "bulk_delete")})),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mailvault_core::daemon_ipc::parse_event;
    use serde_json::json;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, mail_dir_ok);
        (vault, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn cancels_snapshot(s: &Arc<DaemonState>) -> std::collections::HashMap<&'static str, usize> {
        s.cancels
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (*k, v.len()))
            .collect()
    }

    // ── Registry: routing isolation (the N4 fix, at the real registry) ──────

    #[tokio::test]
    async fn cancel_archive_does_not_touch_a_live_bulk_delete_token() {
        let (_v, s) = st(true);
        let bulk_guard = CancelGuard::register(&s, "bulk_delete");
        let n = cancel_kind(&s, "archive");
        assert_eq!(n, 0, "no archive token is registered");
        assert!(!bulk_guard.token().load(Ordering::Relaxed), "cancel_archive must not cancel a live bulk delete");
    }

    #[tokio::test]
    async fn cancel_bulk_delete_does_not_touch_a_live_archive_token() {
        let (_v, s) = st(true);
        let archive_guard = CancelGuard::register(&s, "archive");
        let n = cancel_kind(&s, "bulk_delete");
        assert_eq!(n, 0);
        assert!(!archive_guard.token().load(Ordering::Relaxed), "cancel_bulk_delete must not cancel a live archive");
    }

    #[tokio::test]
    async fn a_second_archive_run_does_not_orphan_the_first() {
        // The other half of N4: today's single-slot design replaces the Arc
        // on the second run, silently orphaning the first (uncancellable).
        let (_v, s) = st(true);
        let g1 = CancelGuard::register(&s, "archive");
        let t1 = g1.token();
        let _g2 = CancelGuard::register(&s, "archive");
        let n = cancel_kind(&s, "archive");
        assert_eq!(n, 2, "both concurrent archive runs are individually tracked");
        assert!(t1.load(Ordering::Relaxed), "the first run must still be cancellable after a second one starts");
    }

    // ── RAII: every exit path removes exactly its own token ─────────────────

    #[tokio::test]
    async fn guard_drops_on_normal_completion() {
        let (_v, s) = st(true);
        {
            let _guard = CancelGuard::register(&s, "archive");
            assert_eq!(cancels_snapshot(&s).get("archive"), Some(&1));
        }
        assert_eq!(cancels_snapshot(&s).get("archive"), None, "the map must not keep a present-but-empty entry");
    }

    #[tokio::test]
    async fn guard_drops_when_the_run_returns_an_error() {
        let (_v, s) = st(true);
        async fn run_that_fails(state: &Arc<DaemonState>) -> Result<(), String> {
            let _guard = CancelGuard::register(state, "archive");
            Err("boom".to_string())
        }
        let _ = run_that_fails(&s).await;
        assert_eq!(cancels_snapshot(&s).get("archive"), None);
    }

    #[tokio::test]
    async fn guard_drops_when_the_run_is_cancelled() {
        let (_v, s) = st(true);
        {
            let guard = CancelGuard::register(&s, "archive");
            guard.token().store(true, Ordering::Relaxed);
            // the run notices cancellation and returns early here; the guard
            // still drops on the way out, same as any other exit.
        }
        assert_eq!(cancels_snapshot(&s).get("archive"), None);
    }

    #[tokio::test]
    async fn guard_drops_when_the_task_holding_it_panics() {
        let (_v, s) = st(true);
        let s2 = Arc::clone(&s);
        let handle = tokio::spawn(async move {
            let _guard = CancelGuard::register(&s2, "archive");
            panic!("deliberate registry-holder panic");
        });
        let joined = handle.await;
        assert!(joined.is_err(), "the spawned task must have panicked");
        assert_eq!(cancels_snapshot(&s).get("archive"), None, "a panicking run must not leak its cancel token");
    }

    /// The panic path through the real sink, not just a bare `CancelGuard`:
    /// `archive::run`'s very first act is `(sinks.emit)(...)`: a sink that
    /// panics there must still leave the registry clean once the panic
    /// unwinds through the guard's `Drop`. `panic = "abort"` in this crate's
    /// Cargo.toml is scoped to `[profile.release]` only; the test profile
    /// unwinds, so `Drop` runs and `tokio::spawn`'s `JoinHandle` observes an
    /// `Err` instead of the process aborting.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_panicking_sink_still_frees_the_runs_cancel_token() {
        let (_v, s) = st(true);
        let panicking_emit: Arc<dyn Fn(&str, Value) + Send + Sync> = Arc::new(|_, _| panic!("deliberate sink panic"));
        let ctx = Arc::new(ArchiveCtx {
            root: std::env::temp_dir(),
            pool: Arc::clone(&s.imap_pool),
            gate: Arc::new(|work: &mut dyn FnMut() -> Result<(), String>| work()),
            sinks: ArchiveSinks {
                emit: panicking_emit,
                custody_append: Arc::new(|_, _, _| Ok(0)),
                nudge: Arc::new(|_, _| {}),
            },
        });
        let s2 = Arc::clone(&s);
        let handle = tokio::spawn(async move {
            let guard = CancelGuard::register(&s2, "archive");
            let cancel = guard.token();
            let _ = archive::run(ctx, "acct".into(), "{\"email\":\"a\",\"imapHost\":\"h\"}".into(), "INBOX".into(), vec![1], cancel).await;
        });
        let joined = handle.await;
        assert!(joined.is_err(), "the sink's panic must have propagated out of the run");
        assert_eq!(cancels_snapshot(&s).get("archive"), None, "cancel token leaked after the sink panicked");
    }

    // ── Routes: gating ───────────────────────────────────────────────────

    #[tokio::test]
    async fn archive_emails_is_gated_while_the_vault_is_being_moved() {
        let (_v, s) = st(true);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let r = call(&s, "archive_emails", json!({"accountId": "acc", "accountJson": "{}", "mailbox": "INBOX", "uids": [1]})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
        // No token was leaked by a route that returned before ever
        // registering one.
        assert_eq!(cancels_snapshot(&s).get("archive"), None);
    }

    #[tokio::test]
    async fn verify_archived_emails_is_gated_while_the_vault_is_being_moved() {
        let (_v, s) = st(true);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let r = call(&s, "verify_archived_emails", json!({"accountId": "acc", "mailbox": "INBOX", "uids": [1]})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
    }

    #[tokio::test]
    async fn bulk_delete_emails_succeeds_while_the_vault_is_being_moved() {
        // The mirror image of the two tests above: an ungated route must NOT
        // be refused by the vault gate at all. The IMAP delete itself fails
        // fast (no server at this address), which is fine: the assertion is
        // about the RPC layer, not about the delete outcome.
        let (_v, s) = st(true);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let r = call(
            &s,
            "bulk_delete_emails",
            json!({"accountId": "acc", "accountJson": "{\"email\":\"a\",\"imapHost\":\"127.0.0.1\",\"imapPort\":1}", "mailbox": "INBOX", "uids": [1]}),
        )
        .await;
        assert!(r.error.is_none(), "bulk_delete_emails must not be gated by vault_closed: {:?}", r.error);
    }

    #[tokio::test]
    async fn cancel_archive_and_cancel_bulk_delete_are_ungated() {
        let (_v, s) = st(true);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(call(&s, "cancel_archive", json!({})).await.result.unwrap(), json!({"cancelled": 0}));
        assert_eq!(call(&s, "cancel_bulk_delete", json!({})).await.result.unwrap(), json!({"cancelled": 0}));
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    // ── Routes: reach the router through handle_request ──────────────────

    #[tokio::test]
    async fn archive_emails_reaches_this_router_through_handle_request() {
        let (_v, s) = st(true);
        // Bad JSON: proves the request reached mailvault_core::archive's own
        // parse error rather than falling through to "unknown method" (which
        // would mean the wiring in server.rs never reached this router).
        let resp = handle_request_for_test(&s, "archive_emails", json!({"accountId": "acc", "accountJson": "not json", "mailbox": "INBOX", "uids": []})).await;
        let err = resp.error.expect("must be an error");
        assert_ne!(err.code, ipc::METHOD_NOT_FOUND, "archive_emails did not reach handlers::archive::route");
        assert!(err.message.contains("Bad account JSON"), "{}", err.message);
    }

    // ── verify_archived_emails: shape parity with the old app command ────

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str]) {
        seed_file_with_body(root, account, mailbox, uid, flags, b"body");
    }

    fn seed_file_with_body(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str], body: &[u8]) {
        let flags: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
        let cur = mailvault_core::vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(mailvault_core::vault_files::build_maildir_filename(uid, &flags)), body).unwrap();
    }

    #[tokio::test]
    async fn verify_archived_emails_matches_verified_missing_mismatched_shape() {
        let (v, s) = st(true);
        seed_file(v.path(), "acc", "INBOX", 1, &[]);
        let r = call(&s, "verify_archived_emails", json!({"accountId": "acc", "mailbox": "INBOX", "uids": [1, 2]})).await;
        assert_eq!(r.result.unwrap(), json!({"verified": [1], "missing": [2], "mismatched": []}));
    }

    #[tokio::test]
    async fn verify_archived_emails_expected_ids_mismatch_case() {
        let (v, s) = st(true);
        // A real Message-ID on disk, deliberately different from the one the
        // caller expects: present-but-different is `mismatched`, not
        // `verified` (a fixture with no Message-ID at all would fall through
        // to `verified` instead, per `maildir::verify_listed`).
        seed_file_with_body(v.path(), "acc", "INBOX", 1, &[], b"Message-ID: <on-disk@example.com>\r\n\r\nbody\r\n");
        let r = call(
            &s,
            "verify_archived_emails",
            json!({"accountId": "acc", "mailbox": "INBOX", "uids": [1], "expectedIds": {"1": "<some-other-id@example.com>"}}),
        )
        .await;
        assert_eq!(r.result.unwrap(), json!({"verified": [], "missing": [], "mismatched": [1]}));
    }

    #[tokio::test]
    async fn verify_archived_emails_null_expected_ids_is_not_a_parse_error() {
        let (v, s) = st(true);
        seed_file(v.path(), "acc", "INBOX", 1, &[]);
        let r = call(&s, "verify_archived_emails", json!({"accountId": "acc", "mailbox": "INBOX", "uids": [1], "expectedIds": null})).await;
        assert_eq!(r.result.unwrap(), json!({"verified": [1], "missing": [], "mismatched": []}));
    }

    // ── bulk_delete_emails: never touches the vault ───────────────────────

    #[tokio::test]
    async fn bulk_delete_emails_never_touches_the_vault() {
        let (v, s) = st(true);
        seed_file(v.path(), "acc", "INBOX", 1, &[]);
        let before = std::fs::read_dir(mailvault_core::vault_files::cur_path(v.path(), "acc", "INBOX"))
            .unwrap()
            .count();

        let _ = call(
            &s,
            "bulk_delete_emails",
            json!({"accountId": "acc", "accountJson": "{\"email\":\"a\",\"imapHost\":\"127.0.0.1\",\"imapPort\":1}", "mailbox": "INBOX", "uids": [1]}),
        )
        .await;

        let after = std::fs::read_dir(mailvault_core::vault_files::cur_path(v.path(), "acc", "INBOX"))
            .unwrap()
            .count();
        assert_eq!(before, after, "bulk_delete_emails must not change a single vault file");
    }

    // ── Archive against a live mock IMAP server ───────────────────────────
    //
    // Reuses the pattern `sync_engine.rs`'s own tests already use
    // (`mock_imap::{MockImap, Scenario}`, a synthetic mailbox) rather than
    // building a second harness.

    fn account_json_for(server: &mock_imap::MockImap) -> String {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::json!({
            "email": "user@example.com",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
        })
        .to_string()
    }

    fn inbox_with_one(uid: u32) -> mock_imap::state::Mailbox {
        let mut mb = mock_imap::state::Mailbox::new("INBOX");
        mb.add(mock_imap::Message::new(
            uid,
            "From: sender@example.com\r\nTo: user@example.com\r\nSubject: hi\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMessage-ID: <m1@example.com>\r\n\r\nbody\r\n".to_string(),
        ));
        mb
    }

    fn manual_nudge_channel(st: &Arc<crate::search_index::SearchIndexState>) -> std::sync::mpsc::Receiver<mailvault_core::search_index::plan::Signal> {
        // Same seam `search_index.rs`'s own tests use: install a manual
        // channel so `nudge`'s `send` has somewhere to land without needing
        // the real background worker running.
        let (tx, rx) = std::sync::mpsc::channel();
        *st.signals.lock().unwrap() = Some(tx);
        rx
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn archive_emails_writes_under_the_gate_and_nudges_in_process() {
        let (v, s) = st(true);
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(inbox_with_one(7)));
        let rx = manual_nudge_channel(&s.search_index);

        let r = call(
            &s,
            "archive_emails",
            json!({"accountId": "acc", "accountJson": account_json_for(&server), "mailbox": "INBOX", "uids": [7]}),
        )
        .await;

        let result = r.result.expect("archive_emails must succeed");
        assert_eq!(result["completed"], json!(1));
        assert_eq!(result["errors"], json!(0));

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acc", "INBOX");
        let written: Vec<_> = std::fs::read_dir(&cur).unwrap().collect();
        assert_eq!(written.len(), 1, "the .eml landed under the vault root the gate was given");

        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(mailvault_core::search_index::plan::Signal::Nudge { account_id, .. }) => {
                assert_eq!(account_id, "acc");
            }
            other => panic!("archive_emails must nudge the search index in-process: {other:?}"),
        }
    }

    #[tokio::test]
    async fn archive_emails_is_refused_mid_write_when_the_vault_closes_under_it() {
        // Pins the "held across the write, not merely checked" property from
        // the daemon side: a move that starts after the route already read
        // `vault_root` but before the gate's write must still be refused.
        let (_v, s) = st(true);
        let ctx = archive_ctx(&s, s.data_dir.clone());
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let mut wrote = false;
        let err = (ctx.gate)(&mut || {
            wrote = true;
            Ok(())
        })
        .unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
        assert!(!wrote, "the gate must refuse before running the write closure");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn archive_progress_reaches_a_channel_subscriber_with_operation_and_camel_case() {
        let (_v, s) = st(true);
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(inbox_with_one(9)));
        let mut sub = s.events.subscribe();

        let _ = call(
            &s,
            "archive_emails",
            json!({"accountId": "acc", "accountJson": account_json_for(&server), "mailbox": "INBOX", "uids": [9]}),
        )
        .await;

        let mut saw_final = false;
        while let Ok(line) = tokio::time::timeout(std::time::Duration::from_secs(2), sub.recv()).await {
            let Ok(line) = line else { break };
            let Some((name, payload)) = parse_event(&line) else { continue };
            if name != "archive-progress" {
                continue;
            }
            assert_eq!(payload["operation"], json!("archive"));
            assert_eq!(payload["accountId"], json!("acc"));
            assert_eq!(payload["mailbox"], json!("INBOX"));
            // camelCase key present (this field has no skip_serializing_if,
            // so it is always on the wire) and the pre-3.3 snake_case
            // spelling never is.
            assert!(payload.get("bandwidthLimited").is_some(), "{payload}");
            assert!(payload.get("bandwidth_limited").is_none(), "{payload}");
            assert!(payload.get("last_error").is_none());
            if payload["active"] == json!(false) {
                saw_final = true;
                break;
            }
        }
        assert!(saw_final, "never observed the final archive-progress frame");
    }
}
