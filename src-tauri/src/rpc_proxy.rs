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
/// wraps the *whole* attempt in it: connect, auth write, auth read, request
/// write and response read together, not only the final response read.
/// `None` means no timeout at all.
///
/// The budget is part of the daemon's method table: every row of
/// `src-daemon/methods.json` states its `replySecs` (`null` for none), and
/// the reason for each value sits beside its row in
/// `src-daemon/src/rpc_registry.rs`, so a new method cannot reach the app
/// without one. A name the table does not list (a retired or unknown method)
/// gets none. The render family exists only with `blitz-render`.
pub(crate) fn reply_timeout(method: &str) -> Option<std::time::Duration> {
    if !cfg!(feature = "blitz-render") && method.starts_with("render.") {
        return None;
    }
    static BUDGETS: std::sync::OnceLock<std::collections::HashMap<String, Option<std::time::Duration>>> =
        std::sync::OnceLock::new();
    BUDGETS
        .get_or_init(|| {
            parse_reply_budgets(include_str!("../../src-daemon/methods.json"))
                .expect("src-daemon/methods.json states a budget for every method")
        })
        .get(method)
        .copied()
        .flatten()
}

/// `methods.json` rows to budgets. A row without `replySecs` is an error,
/// never a silent "no budget".
pub(crate) fn parse_reply_budgets(
    json: &str,
) -> Result<std::collections::HashMap<String, Option<std::time::Duration>>, String> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    rows.iter()
        .map(|row| {
            let name = row["name"].as_str().ok_or_else(|| format!("row without a name: {row}"))?;
            let budget = match row.get("replySecs") {
                None => return Err(format!("{name}: no replySecs")),
                Some(serde_json::Value::Null) => None,
                Some(v) => Some(std::time::Duration::from_secs(
                    v.as_u64().ok_or_else(|| format!("{name}: replySecs is not whole seconds"))?,
                )),
            };
            Ok((name.to_owned(), budget))
        })
        .collect()
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
