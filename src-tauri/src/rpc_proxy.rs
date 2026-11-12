//! The `daemon_rpc` bridge from the webview to the daemon socket.

use super::*;

/// Marker string `daemon_rpc` returns for every failure before a response
/// line is read (spawn, build check, token, connect, auth, write, EOF). The
/// frontend's `daemonClient.js` classifier is text-matched, so this must stay
/// a literal `errors.` catalog key — the real reason goes to `warn!` instead.
pub(crate) const DAEMON_UNAVAILABLE: &str = "errors.daemonUnavailable";

/// Returned instead of the daemon's own message when a JSON-RPC error is
/// METHOD_NOT_FOUND (C5): a `BuildCheck::Accept`'d daemon (still on the old
/// build after our one restart) is missing this RPC entirely. A catalog key,
/// same contract as `DAEMON_UNAVAILABLE` — the frontend text-matches it.
pub(crate) const DAEMON_OUTDATED: &str = "errors.daemonOutdated";

/// JSON-RPC 2.0 reserved code for "the method does not exist / is not available".
pub(crate) const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;

/// Per-method reply budget for `daemon_rpc` (C8). When `Some`, `rpc_attempt`
/// wraps the *whole* attempt in it — connect, auth write, auth read, request
/// write and response read together, not only the final response read. `None`
/// (every legacy dotted method, unchanged) means no timeout at all.
///
/// Task 2.5 Step 4: every Phase 2 daemon-owned name is added here now, ahead
/// of its route landing (Tasks 2.6-2.9a), so a later task cannot forget the
/// budget. `search_index_destroy` gets the longest of the pre-existing family
/// because the daemon itself waits up to 120s for the index worker to finish
/// before replying; the 600s family covers vault-wide scans/migrations and
/// the mirror-spanning flag-rename forwarders (Task 2.9b); the 120s family
/// is one big read or write; everything else is a single-row/one-mailbox op.
pub(crate) fn reply_timeout(method: &str) -> Option<std::time::Duration> {
    #[cfg(feature = "blitz-render")]
    if let Some(t) = blitz_tiles::reply_timeout(method) {
        return Some(t);
    }
    use std::time::Duration;
    match method {
        "sync.probe" | "counts.unread" => Some(Duration::from_secs(30)),
        "sync.refresh" | "sync.refresh_status" | "sync.context" => Some(Duration::from_secs(30)),
        "pipeline.focus" | "pipeline.status" => Some(Duration::from_secs(30)),
        "folders.status" => Some(Duration::from_secs(125)),
        // Full draft MIME/attachment preparation may outlast a short UI read.
        // Expiry is unknown completion, never cancellation of native work.
        "accounts.list" | "accounts.get" => Some(Duration::from_secs(30)),
        "accounts.save" => Some(Duration::from_secs(95)),
        "accounts.add" | "accounts.update" => Some(Duration::from_secs(305)),
        "accounts.remove_local" => Some(Duration::from_secs(185)),
        "accounts.put" | "accounts.reorder" | "accounts.replace_all" => {
            Some(Duration::from_secs(50))
        }
        "drafts.save" => Some(Duration::from_secs(600)),
        "compose.reply_context" | "compose.check" => Some(Duration::from_secs(30)),
        // list can recover one selected body; discard validates exact local IO.
        "drafts.list" | "drafts.discard" => Some(Duration::from_secs(120)),
        "bulk.start" | "bulk.resume" | "bulk.status" | "bulk.cancel" | "bulk.discard" => {
            Some(Duration::from_secs(30))
        }
        "search_index_destroy" => Some(Duration::from_secs(150)),

        // The helper card's own probe (`isDaemonAvailable` -> `ping`).
        // Unbounded, a daemon that accepts the socket but never answers left
        // Settings on "Checking..." forever; a bounded failure at least says
        // "Helper Not Running" honestly. The dotted lifecycle methods stay
        // unbounded, like every other legacy dotted name.
        "ping" => Some(Duration::from_secs(10)),

        // Native changes bound admission at 5s, read at 20s and write at
        // 20s. Leave time for the daemon to report failure/uncertainty.
        "credentials.get" | "credentials.save" | "credentials.update" | "credentials.delete" => {
            Some(Duration::from_secs(50))
        }

        "vault_search"
        | "vault_rows"
        | "search_index_status"
        | "search_index_configure"
        | "search_index_rebuild"
        | "maildir_read"
        | "maildir_read_light"
        | "maildir_exists"
        | "maildir_store"
        | "maildir_delete"
        | "maildir_delete_many"
        | "maildir_set_flags"
        | "cached_attachment_path"
        | "save_email_cache"
        | "load_email_cache_partial"
        | "load_email_cache_window"
        | "load_email_cache_meta"
        | "load_email_cache_by_uids"
        | "list_cached_uids"
        | "header_cache_month_histogram"
        | "save_mailbox_cache"
        | "load_mailbox_cache"
        | "delete_mailbox_cache"
        | "load_graph_id_map"
        | "op_journal_queue"
        | "op_journal_clear"
        | "op_journal_read"
        | "read_pending_operation"
        | "save_pending_operation"
        | "clear_pending_operation"
        | "local_index_read"
        | "local_index_append"
        | "local_index_remove"
        | "custody_status"
        | "maildir_repair_generation"
        | "maildir_orphan_stats"
        | "mail_search_start"
        | "mail_search_cancel"
        | "vault_rebind_uids" => Some(Duration::from_secs(30)),

        // A message is framed only once its body scan answers: unbounded, a
        // hung daemon left every reader blank. Bounded, the app frames the
        // body unscanned, with remote images refused (services/bodyScan.js).
        "body.scan" | "body.verdicts" | "body.classify_links" | "body.info" => {
            Some(Duration::from_secs(30))
        }

        // H3c: a message the vault has no copy of is downloaded by these
        // (`raw_message`). The daemon bounds its whole fallback at 60s
        // (`FALLBACK_BOUND`: this message's lock, keychain, connect, the 45s
        // body fetch, the cache write) and then answers the vault's error;
        // 75s leaves room for the parse after a download that just made it.
        // A vault hit answers in milliseconds, so the width is only ever
        // spent on a real download. `cached_attachment_path` never
        // downloads and stays in the 30s family above.
        "maildir_read_attachment"
        | "maildir_read_attachments"
        | "maildir_read_raw_source"
        | "cache_attachment" => Some(Duration::from_secs(75)),

        // I3 (2.6 review): `maildir_read_light_batch` and `maildir_list` can
        // be sent for a whole mailbox's uids in one call (`getLocalEmails`,
        // `src/services/db/emails.js`) — a full MIME parse per file, with no
        // chunking on this path (unlike `getArchivedEmails`, which chunks at
        // 200). The old Tauri commands they replace had no budget at all, so
        // 30s (bounding what used to be unbounded) can time out a large
        // archive on a slow drive that used to just run slow and succeed.
        // `vault_uid_sets` replaces `maildir_list` and lists a mailbox once
        // per session; `vault_light_rows` parses every never-parsed file of
        // a mailbox on its first call.
        "load_email_cache"
        | "graph_allocate_uids"
        | "maildir_storage_stats"
        | "clear_email_cache"
        | "maildir_read_light_batch"
        | "maildir_list"
        | "vault_uid_sets"
        | "vault_light_rows" => Some(Duration::from_secs(120)),

        // Final fix wave I-2: a `vault_close` can outlast 120s when the
        // search index worker is mid-batch/compaction — the app's budget
        // must be strictly larger than the daemon's own wait
        // (`si::close`/`custody::close` inside `handlers/search_index.rs`),
        // or the app SIGTERMs the daemon mid-write just before the vault
        // move starts copying. Not consulted by `daemon_vault_lifecycle_call`
        // (it passes its own explicit `Duration`, same as `vault_reopen`
        // below) — kept here so the budget is documented in one table and
        // pinned by a test, matching every call site.
        "vault_close" => Some(Duration::from_secs(300)),

        "maildir_clear_cache"
        | "maildir_migrate_json_to_eml"
        | "maildir_migrate_email_dirs"
        | "maildir_purge_orphans"
        | "prefetch_attachments"
        | "vault_apply_flags"
        | "vault_rename_mailbox"
        | "vault_adopt_mailbox_dirs" => Some(Duration::from_secs(600)),

        // Task 3.5 decision 3: no budget. A 40k-uid archive or a large bulk
        // delete runs far past every other family's budget in this table:
        // the JS awaits the reply directly, and the way out of a long run is
        // the daemon's own cancel_archive/cancel_bulk_delete, not a timeout
        // that turns a slow success into a failure (Phase 2's 2.6 I3
        // lesson). Written as an explicit arm rather than left to the
        // `_ => None` catch-all below, so a later change to that default
        // cannot silently take the budget away from these two, and so the
        // test pinning this has something concrete to assert against.
        "archive_emails" | "bulk_delete_emails" => None,

        // The daemon's delete queue (src-daemon/src/delete_queue.rs). A
        // submit answers only after its whole retry schedule: six send
        // rounds, each uid's capture allowed 45s, plus 31s of waits, so a
        // budget would turn a slow delete into a failure the daemon is still
        // finishing. Same explicit-None arm as archive. A run is one replay
        // pass over every entry (one round each, uids in turn), so it is
        // unbounded too. List and cancel are one journal read or write, the
        // op_journal_* tier.
        "delete_queue.submit" | "delete_queue.run" => None,
        "delete_queue.list" | "delete_queue.cancel" => Some(Duration::from_secs(30)),

        // The undo of a delete (src-daemon/src/handlers/deleted.rs): a SEARCH
        // and a MOVE per group, an APPEND per bin fallback, all inside the
        // daemon's own 120s `RESTORE_BUDGET`, which answers first. Past this,
        // the app hides the rows again and reloads to see what came back.
        "messages.restore" => Some(Duration::from_secs(150)),

        // One read_dir plus comparisons, same tier as the other Phase 2
        // single-pass readers.
        "verify_archived_emails" => Some(Duration::from_secs(120)),

        // Ungated, no vault access, one atomic store per registered token.
        "cancel_archive" | "cancel_bulk_delete" => Some(Duration::from_secs(30)),

        // Task 3.7, same decision 3 reasoning as archive: the inventory walk
        // behind a begin_snapshot reads every cached header of every account
        // in scope (50k in the e2e's LARGE mode) before it answers, and the
        // JS awaits that reply. Written as its own arm rather than left to
        // the `_ => None` catch-all so a later edit to that default cannot
        // silently hand this one a budget.
        "insights_begin_snapshot" => None,

        // One bounded page, same tier as the other single-pass readers.
        "insights_read_page" => Some(Duration::from_secs(120)),

        // Drops one snapshot out of a map.
        "insights_release_snapshot" => Some(Duration::from_secs(30)),

        // Task 4.2: its own internal reqwest timeout is 10s plus redirect
        // overhead (up to 3 hops); 30s is a safety margin around that, not a
        // new cap this budget could bind against in practice.
        "fetch_remote_asset" => Some(Duration::from_secs(30)),

        // The settings document (`handlers/settings.rs`): one small file read,
        // or one write and fsync. Every window hydrates through `settings.get`,
        // so a daemon that accepts and never answers must not hang the UI.
        "settings.get"
        | "settings.patch"
        | "settings.replace"
        | "backup.schedule.get"
        | "backup.schedule.set"
        | "backup.run_now"
        | "backup.cancel"
        | "backup.stop"
        | "backup.schedule.status"
        | "backup.context"
        | "backup.attach_access"
        | "backup.access_status"
        | "notify.decide"
        | "notify.arrival" => Some(Duration::from_secs(30)),

        // Task 4.4 / decision 8: inline-blocking, same reasoning as
        // archive_emails/bulk_delete_emails above, the whole ZIP
        // read-or-write pass happens within this RPC call and the JS
        // awaits the return value directly. Written as its own arm so a
        // later edit to the `_ => None` default cannot silently take or
        // grant a budget here by accident.
        "export_backup" | "import_backup" => None,

        // Task 4.6, same reasoning as export_backup/import_backup above: the
        // whole mbox read-or-write pass happens within this RPC call and the
        // JS awaits the return value directly. Its own arm so a later edit
        // to the `_ => None` default cannot silently take or grant a budget.
        "export_mbox_all" | "import_mbox" => None,

        // MBOX import options: each answers from a bounded amount of work.
        // `mbox_probe` reads a capped sample of the file's start and the
        // cached folder list; `list_local_folders` one directory listing;
        // the upload job's routes read or steer a job that runs on its own
        // thread (a resume's keychain read is bounded at 20s by the daemon);
        // `vault_gap_save` starts its run and answers at once.
        "mbox_probe"
        | "list_local_folders"
        | "mbox_upload_status"
        | "mbox_upload_pause"
        | "mbox_upload_resume"
        | "mbox_upload_cancel"
        | "mbox_upload_discard"
        | "vault_gap_save" => Some(Duration::from_secs(30)),

        // Reads every cached header row of the account against the vault
        // before it answers: the first count of a very large folder is slow.
        "vault_gap_count" => Some(Duration::from_secs(120)),

        // Same reasoning as archive_emails/bulk_delete_emails: every message
        // of the folder is copied into the deleted-mail bin inline, within
        // this call, and there is no cancel route; a budget would turn a
        // slow success on a big import into a reported failure while the
        // daemon goes on deleting. Its own arm so the default cannot hand
        // it one.
        "delete_local_folder" => None,

        // Task 4.8 / decision 8: each of these ten either kicks off a
        // tokio::spawn and returns almost immediately (progress flows over
        // channel.open, not this reply) or is a fast local read/flag flip.
        // Written as its own arm, not left to the `_ => None` catch-all, so
        // a later edit to that default cannot silently take a budget these
        // never had a reason to lose.
        "start_migration"
        | "resume_migration"
        | "count_migration_folders"
        | "start_restore"
        | "cancel_migration"
        | "pause_migration"
        | "cancel_restore"
        | "clear_migration_state_cmd"
        | "get_migration_state"
        | "count_local_folder" => Some(Duration::from_secs(30)),

        // Task 4.8 / decision 8: a live IMAP LIST plus, when either side is
        // Graph, an HTTP list_folders call, bounded but genuinely
        // network-bound, matching Phase 2's precedent for similar calls.
        "get_folder_mappings" => Some(Duration::from_secs(120)),

        _ => None,
    }
}

/// Pure decision (C7): may `daemon_rpc` skip `ensure_daemon_running` and its
/// `spawn_blocking` entirely? Only when the long-lived channel is already
/// connected to a live daemon, that daemon's socket inode already passed the
/// build check (`verified_ino != 0`), and a token was cached from an earlier
/// slow-path run. Any one of those missing forces the slow path — this never
/// does I/O itself, just the decision.
///
/// ponytail: known ceiling — `connected`/`verified_ino` are read here, not
/// re-stat'd, so a daemon started outside this app (a second app instance,
/// or one run by hand) that replaces ours in the few ms between the old
/// socket's EOF reaching `daemon_channel::pump` and `CONNECTED` flipping to
/// false can receive one fast-path request never build-checked. Upgrade path
/// if that ever matters: compare a live `stat` of the socket inode here too,
/// which costs the `spawn_blocking` hop C7 exists to avoid — not worth it for
/// a multi-millisecond window.
pub(crate) fn rpc_fast_path(connected: bool, verified_ino: u64, token: Option<&str>) -> Option<String> {
    if connected && verified_ino != 0 {
        token.map(str::to_owned)
    } else {
        None
    }
}

/// Maps a JSON-RPC error object to what `daemon_rpc` returns to the frontend.
/// METHOD_NOT_FOUND becomes the `errors.daemonOutdated` catalog key (C5,
/// logged with the method); every other code keeps the daemon's own message,
/// unchanged from before this task.
pub(crate) fn map_rpc_error(error: &serde_json::Value, method: &str) -> String {
    if error.get("code").and_then(|c| c.as_i64()) == Some(JSONRPC_METHOD_NOT_FOUND) {
        warn!("daemon_rpc {method}: daemon replied METHOD_NOT_FOUND (stale/accepted build)");
        return DAEMON_OUTDATED.to_string();
    }
    error.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown daemon error").to_string()
}

/// One attempt at the auth handshake + JSON-RPC round trip over a fresh
/// connection, given an already-known token (fast or slow path — this
/// function doesn't care which).
#[derive(Debug)]
pub(crate) enum RpcOutcome {
    /// A successful RPC result.
    Ok(serde_json::Value),
    /// A real response from the daemon that isn't a plain success: an
    /// RPC-level error (already mapped by `map_rpc_error`) or an unparseable
    /// response line. Returned to the caller exactly as before this task —
    /// never wrapped in `DAEMON_UNAVAILABLE`, never retried (the request line
    /// was already written and answered).
    Direct(String),
    /// A transport/auth-level failure. `retryable` is true only when it
    /// happened strictly before the RPC request line was written — safe to
    /// retry on a fresh connection with a fresh token. Once that write
    /// succeeds, every later failure (response read, timeout, EOF) is
    /// `retryable: false`: retrying would send the request twice. When the
    /// method has a reply budget (C8), that budget wraps the whole attempt
    /// above (connect through response read), not only the response read —
    /// a hang anywhere in the handshake ends up here too, not just a slow reply.
    Unavailable { message: String, retryable: bool },
}

/// C8 / M3 (controller ruling): when `timeout` is `Some`, it bounds the
/// *whole* attempt — connect, auth write, auth read, request write and
/// response read together — not just the final read. A daemon that accepts
/// the connection and then never answers auth would otherwise hang
/// `vault_search`/`search_index_destroy` forever despite their 30s/150s
/// budgets. Expiry always returns `retryable: false` (never retried,
/// regardless of how far the inner attempt got — a connect that is merely
/// slow and a request already on the wire are indistinguishable from out
/// here, and retrying a possibly-already-sent mutating RPC is the unsafe
/// default). Legacy methods (`timeout: None`) are unbounded, unchanged.
pub(crate) async fn rpc_attempt(
    socket_path: &Path,
    token: &str,
    method: &str,
    params: &serde_json::Value,
    timeout: Option<std::time::Duration>,
) -> RpcOutcome {
    let attempt = rpc_attempt_inner(socket_path, token, method, params);
    match timeout {
        Some(t) => tokio::time::timeout(t, attempt).await.unwrap_or_else(|_| RpcOutcome::Unavailable {
            message: format!("no reply in {}s", t.as_secs()),
            retryable: false,
        }),
        None => attempt.await,
    }
}

/// The auth handshake + one JSON-RPC round trip, with no time budget of its
/// own — `rpc_attempt` above applies the whole-call timeout when the method
/// has one.
pub(crate) async fn rpc_attempt_inner(socket_path: &Path, token: &str, method: &str, params: &serde_json::Value) -> RpcOutcome {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // Same split as daemon_channel::connect: `tokio::io::split` works for
    // both stream types, so only the connect call differs per platform. A
    // pipe client losing the race for a free instance (ERROR_PIPE_BUSY) is
    // "try again", not "no daemon" — surfaced as an ordinary connect error,
    // same as the unix arm's connection-refused.
    #[cfg(unix)]
    let (reader, mut writer) = {
        let stream = match tokio::net::UnixStream::connect(socket_path).await {
            Ok(s) => s,
            Err(e) => return RpcOutcome::Unavailable { message: format!("cannot connect to daemon: {e}"), retryable: true },
        };
        tokio::io::split(stream)
    };
    #[cfg(windows)]
    let (reader, mut writer) = {
        let stream = match tokio::net::windows::named_pipe::ClientOptions::new().open(socket_path) {
            Ok(s) => s,
            Err(e) => return RpcOutcome::Unavailable { message: format!("cannot connect to daemon: {e}"), retryable: true },
        };
        tokio::io::split(stream)
    };
    let mut lines = BufReader::new(reader).lines();

    // Auth handshake
    let auth_msg = serde_json::json!({"token": token.trim()});
    let mut buf = serde_json::to_vec(&auth_msg).unwrap();
    buf.push(b'\n');
    if let Err(e) = writer.write_all(&buf).await {
        return RpcOutcome::Unavailable { message: e.to_string(), retryable: true };
    }

    let auth_resp = match lines.next_line().await {
        Ok(Some(l)) => l,
        Ok(None) => return RpcOutcome::Unavailable { message: "daemon closed connection during auth".to_string(), retryable: true },
        Err(e) => return RpcOutcome::Unavailable { message: e.to_string(), retryable: true },
    };
    let auth_result: serde_json::Value = match serde_json::from_str(&auth_resp) {
        Ok(v) => v,
        Err(e) => return RpcOutcome::Unavailable { message: format!("invalid auth response: {e}"), retryable: true },
    };
    if auth_result.get("error").is_some() {
        return RpcOutcome::Unavailable { message: "daemon authentication failed".to_string(), retryable: true };
    }

    // JSON-RPC request
    static RPC_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = RPC_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let rpc_req = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": id,
    });
    let mut buf = serde_json::to_vec(&rpc_req).unwrap();
    buf.push(b'\n');
    if let Err(e) = writer.write_all(&buf).await {
        // write_all failing partway through leaves no guarantee the daemon
        // saw a coherent request line, so still safe to retry.
        return RpcOutcome::Unavailable { message: e.to_string(), retryable: true };
    }

    // From here on, the request is on the wire: never retryable.
    let resp_line = match lines.next_line().await {
        Ok(Some(l)) => l,
        Ok(None) => return RpcOutcome::Unavailable { message: "daemon closed connection before responding".to_string(), retryable: false },
        Err(e) => return RpcOutcome::Unavailable { message: e.to_string(), retryable: false },
    };

    let mut resp: serde_json::Value = match serde_json::from_str(&resp_line) {
        Ok(v) => v,
        Err(e) => return RpcOutcome::Direct(format!("Invalid RPC response: {e}")),
    };

    if let Some(error) = resp.get("error") {
        return RpcOutcome::Direct(map_rpc_error(error, method));
    }

    // Take the result out of the parsed reply instead of deep-copying it; a
    // missing result (or a non-object reply) still reads as Null.
    RpcOutcome::Ok(resp.get_mut("result").map(serde_json::Value::take).unwrap_or(serde_json::Value::Null))
}

pub(crate) fn webview_rpc_token(
    method: &str,
    connected: bool,
    inode: u64,
    token: Option<&str>,
) -> Result<Option<String>, String> {
    if matches!(
        method,
        "backup.attach_access" | "backup.access_status" | "channel.open"
    ) || method.starts_with("backup.owner_") || method == "backup.surface_retire"
    {
        return Err("errors.settingsInvalid".into());
    }
    Ok(rpc_fast_path(connected, inode, token))
}

#[tauri::command]
pub(crate) async fn daemon_rpc(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    method: String,
    mut params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if method == "backup.context" { params = backup::surface_params(window.label(), params)?; }
    let fast_token = webview_rpc_token(
        &method,
        daemon_channel::is_connected(),
        VERIFIED_SOCKET_INO.load(Ordering::SeqCst),
        cached_daemon_token().as_deref(),
    )?;
    // Native authorization must run before both fast and slow RPC paths.
    if matches!(method.as_str(), "bulk.start" | "bulk.resume") {
        return tauri::async_runtime::spawn_blocking(move || {
            bulk::forward(&app_handle, &method, params)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let (socket_path, token_path) = daemon_ipc_paths().map_err(|e| {
        warn!("daemon_rpc {method}: {e}");
        DAEMON_UNAVAILABLE.to_string()
    })?;
    let timeout = reply_timeout(&method);

    // Fast path (C7): a live, build-verified channel with a cached token
    // skips ensure_daemon_running (and its spawn_blocking) entirely. No
    // blocking I/O here — is_connected/the atomics/the token mutex are all
    // just reading in-memory state.
    if let Some(token) = fast_token {
        match rpc_attempt(&socket_path, &token, &method, &params, timeout).await {
            RpcOutcome::Ok(v) => return Ok(v),
            RpcOutcome::Direct(msg) => return Err(msg),
            RpcOutcome::Unavailable {
                retryable: false,
                message,
            } => {
                warn!("daemon_rpc {method}: {message}");
                return Err(DAEMON_UNAVAILABLE.to_string());
            }
            RpcOutcome::Unavailable {
                retryable: true,
                message,
            } => {
                // The daemon may have died or been replaced; drop the cached
                // verification so the slow path re-checks the socket and
                // build. (The token file persists across restarts, so auth
                // alone does not detect a replacement.)
                warn!("daemon_rpc {method}: fast path failed ({message}); retrying once through the slow path");
                set_cached_daemon_token(None);
                VERIFIED_SOCKET_INO.store(0, Ordering::SeqCst);
            }
        }
    }

    // Slow path: verify (and, if needed, spawn/restart) the daemon, then
    // read a fresh token. Blocking I/O, so it all runs inside spawn_blocking
    // (mirrors daemon_channel::connect).
    let token = {
        let app = app_handle.clone();
        let sock = socket_path.clone();
        let tok_path = token_path.clone();
        let joined = tokio::task::spawn_blocking(move || {
            ensure_daemon_running(&app, &sock)?;
            std::fs::read_to_string(&tok_path).map_err(|e| format!("daemon token not found: {e}"))
        })
        .await
        .map_err(|e| format!("task join error: {e}"));
        match joined {
            Ok(Ok(t)) => t,
            Ok(Err(e)) | Err(e) => {
                warn!("daemon_rpc {method}: {e}");
                return Err(DAEMON_UNAVAILABLE.to_string());
            }
        }
    };
    set_cached_daemon_token(Some(token.clone()));

    match rpc_attempt(&socket_path, &token, &method, &params, timeout).await {
        RpcOutcome::Ok(v) => Ok(v),
        RpcOutcome::Direct(msg) => Err(msg),
        RpcOutcome::Unavailable { message, .. } => {
            warn!("daemon_rpc {method}: {message}");
            Err(DAEMON_UNAVAILABLE.to_string())
        }
    }
}

/// The daemon bridge: send one fire-and-forget notification on the channel.
#[tauri::command]
pub(crate) fn daemon_channel_notify(window: tauri::WebviewWindow, method: String, mut params: serde_json::Value) {
    if webview_rpc_token(&method, false, 0, None).is_ok() {
        // Only the main window owns the native refresh context. A secondary
        // window may keep using other channel notifications as before.
        if method == "sync.owner" && window.label() != "main" { return; }
        if method == "backup.context" {
            let Ok(native) = backup::surface_params(window.label(), params) else { return; };
            params = native;
        }
        daemon_channel::notify(&method, params);
    }
}
