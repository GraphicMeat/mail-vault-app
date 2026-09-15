//! The app's one long-lived daemon connection (spec 2026-09-14 §3.2): daemon
//! events become Tauri events, app notifications go the other way. Reconnects
//! with 250 ms to 5 s backoff and respawns the daemon through ensure_daemon_running.
use mailvault_core::daemon_ipc::{next_backoff, parse_event};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;
use tracing::{debug, error, info, warn};

static TX: OnceLock<UnboundedSender<String>> = OnceLock::new();
static CONNECTED: AtomicBool = AtomicBool::new(false);
static STOPPING: AtomicBool = AtomicBool::new(false);

pub fn start(app: &tauri::AppHandle) {
    let (tx, rx) = unbounded_channel();
    if TX.set(tx).is_err() {
        return; // already running
    }
    tauri::async_runtime::spawn(run(app.clone(), rx));
}

/// Never blocks, never waits for the daemon. Lost while disconnected: the
/// reconnect's catch-up (Phase 1: `search_index.sweep_soon`) covers it.
pub fn notify(method: &str, params: Value) {
    if !CONNECTED.load(SeqCst) {
        return;
    }
    if let Some(tx) = TX.get() {
        let _ = tx.send(json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string());
    }
}

/// App exit: stop reconnecting, or the loop would respawn the daemon being killed.
pub fn stop() {
    STOPPING.store(true, SeqCst);
    CONNECTED.store(false, SeqCst);
}

/// Whether the long-lived channel is connected right now. `daemon_rpc`'s fast
/// path (C7) reads this to decide whether a live, already-handshaken daemon
/// is worth skipping `ensure_daemon_running` for — never blocks, never touches
/// the daemon itself.
pub(crate) fn is_connected() -> bool {
    CONNECTED.load(SeqCst)
}

/// A connection has to survive at least this long before a later drop resets
/// backoff back to 250 ms. Without this, a daemon that accepts `channel.open`
/// and then dies immediately (a stale/crash-looping sidecar) would reconnect
/// every 250 ms forever instead of backing off.
const MIN_LIVE_TO_RESET_BACKOFF: std::time::Duration = std::time::Duration::from_secs(5);

async fn run(app: tauri::AppHandle, mut rx: UnboundedReceiver<String>) {
    let mut backoff = None;
    let mut warned = false;
    while !STOPPING.load(SeqCst) {
        match connect(&app).await {
            Ok((lines, writer)) => {
                while rx.try_recv().is_ok() {} // queued for a connection that is gone
                // connect() can block for seconds inside ensure_daemon_running
                // (e.g. behind a vault-switch daemon restart); re-check here,
                // right before flipping CONNECTED and telling the frontend,
                // so an app already exiting never surfaces a phantom reconnect.
                if STOPPING.load(SeqCst) {
                    return;
                }
                CONNECTED.store(true, SeqCst);
                warned = false;
                info!("daemon channel connected");
                let _ = app.emit("daemon-reconnected", json!({}));
                let connected_at = std::time::Instant::now();

                // Reader (pump) and writer run as two independent tasks so a
                // blocked write (the daemon isn't reading, e.g. it's stuck
                // writing its own burst of events) never stalls the read
                // side — with both directions sharing one task and one
                // select!, a blocked write used to stop us from draining the
                // daemon's outgoing buffer, which could in turn block the
                // daemon's own write, wedging both ends forever once each
                // side's ~8 KB socket buffer filled. `dead` (a watch, not a
                // Notify: its `changed()` is stateful, so a side that sends
                // `true` before the other side starts watching is still
                // observed — no lost-wakeup race) lets whichever side ends
                // first wake the other so the connection tears down as a unit.
                let (dead_tx, dead_rx) = watch::channel(false);
                let write_task = tokio::spawn(write_loop(writer, rx, dead_tx.clone(), dead_rx.clone()));
                pump(&app, lines, dead_tx, dead_rx).await;
                rx = match write_task.await {
                    Ok(returned_rx) => returned_rx,
                    Err(e) => {
                        // The writer task never panics in normal operation
                        // (every fallible op is matched, not unwrapped); if
                        // it ever does, the receiver it owned is gone with
                        // it. Fall back to a fresh one so this loop keeps
                        // reconnecting — notify() will silently no-op (TX's
                        // sender now has no matching receiver) until restart.
                        error!("daemon channel: writer task failed: {e}");
                        unbounded_channel().1
                    }
                };
                CONNECTED.store(false, SeqCst);
                info!("daemon channel closed");
                if connected_at.elapsed() >= MIN_LIVE_TO_RESET_BACKOFF {
                    backoff = None;
                }
            }
            Err(e) if !warned => {
                warn!("daemon channel: {e}");
                warned = true;
            }
            Err(e) => debug!("daemon channel: {e}"),
        }
        let wait = next_backoff(backoff);
        backoff = Some(wait);
        tokio::time::sleep(wait).await;
    }
}

async fn write_line(w: &mut OwnedWriteHalf, v: &Value) -> Result<(), String> {
    let mut buf = v.to_string().into_bytes();
    buf.push(b'\n');
    w.write_all(&buf).await.map_err(|e| e.to_string())
}

async fn read_line(lines: &mut Lines<BufReader<OwnedReadHalf>>) -> Result<Value, String> {
    let line = lines.next_line().await.map_err(|e| e.to_string())?.ok_or("daemon closed the connection")?;
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

/// How long the auth + `channel.open` handshake gets once the socket accepts
/// the connection, before it counts as a failed attempt and backs off. A
/// daemon that accepts the connection but never answers (wedged, or an old
/// build that hangs instead of erroring) must not stall the reconnect loop
/// forever.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

async fn connect(app: &tauri::AppHandle) -> Result<(Lines<BufReader<OwnedReadHalf>>, OwnedWriteHalf), String> {
    let (socket, token_path) = crate::daemon_ipc_paths()?;
    // Both ensure_daemon_running (blocking: socket check, heartbeat, possible
    // restart) and the token file read are blocking I/O — neither belongs on
    // a tokio worker, so both run inside the one spawn_blocking closure.
    let token = {
        let app = app.clone();
        let socket = socket.clone();
        tokio::task::spawn_blocking(move || {
            crate::ensure_daemon_running(&app, &socket)?;
            std::fs::read_to_string(&token_path).map_err(|e| format!("token: {e}"))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    if STOPPING.load(SeqCst) {
        return Err("app is exiting".into());
    }
    let (r, mut w) = tokio::net::UnixStream::connect(&socket).await.map_err(|e| e.to_string())?.into_split();
    let mut lines = BufReader::new(r).lines();
    let handshake = async {
        write_line(&mut w, &json!({"token": token.trim()})).await?;
        if read_line(&mut lines).await?.get("error").is_some() {
            return Err("daemon rejected the token".to_string());
        }
        write_line(&mut w, &json!({"jsonrpc": "2.0", "method": "channel.open", "params": {}, "id": 1})).await?;
        let opened = read_line(&mut lines).await?;
        if let Some(err) = opened.get("error") {
            return Err(format!("channel.open refused (daemon too old?): {err}"));
        }
        Ok::<(), String>(())
    };
    tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
        .await
        .map_err(|_| "channel handshake timed out".to_string())??;
    Ok((lines, w))
}

/// Reads daemon events and re-emits them to the frontend. Never writes —
/// see `write_loop` for why the two are split across tasks.
async fn pump(app: &tauri::AppHandle, mut lines: Lines<BufReader<OwnedReadHalf>>, dead_tx: watch::Sender<bool>, mut dead_rx: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some((name, payload)) = parse_event(&l) {
                        if app.emit(&name, payload).is_err() {
                            debug!("daemon channel: failed to emit {name} to the frontend");
                        }
                    }
                }
                _ => { let _ = dead_tx.send(true); return; }
            },
            _ = dead_rx.changed() => return,
        }
    }
}

/// Drains the outgoing mpsc into the write half, one write per message (line
/// + newline in the same buffer). Returns the receiver so the next
/// connection attempt can reuse it — `rx` outlives any single connection,
/// since `TX`'s sender (used by `notify()`) is set once for the app's life.
async fn write_loop(mut w: OwnedWriteHalf, mut rx: UnboundedReceiver<String>, dead_tx: watch::Sender<bool>, mut dead_rx: watch::Receiver<bool>) -> UnboundedReceiver<String> {
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(msg) => {
                    let mut buf = msg.into_bytes();
                    buf.push(b'\n');
                    if w.write_all(&buf).await.is_err() {
                        let _ = dead_tx.send(true);
                        return rx;
                    }
                }
                None => { let _ = dead_tx.send(true); return rx; } // TX's sender dropped — does not happen while the app runs.
            },
            _ = dead_rx.changed() => return rx,
        }
    }
}
