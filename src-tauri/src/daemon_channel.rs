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
use tracing::{debug, info, warn};

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

async fn run(app: tauri::AppHandle, mut rx: UnboundedReceiver<String>) {
    let mut backoff = None;
    let mut warned = false;
    while !STOPPING.load(SeqCst) {
        match connect(&app).await {
            Ok((lines, writer)) => {
                while rx.try_recv().is_ok() {} // queued for a connection that is gone
                CONNECTED.store(true, SeqCst);
                backoff = None;
                warned = false;
                info!("daemon channel connected");
                let _ = app.emit("daemon-reconnected", json!({}));
                pump(&app, lines, writer, &mut rx).await;
                CONNECTED.store(false, SeqCst);
                info!("daemon channel closed");
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

async fn connect(app: &tauri::AppHandle) -> Result<(Lines<BufReader<OwnedReadHalf>>, OwnedWriteHalf), String> {
    let (socket, token_path) = crate::daemon_ipc_paths()?;
    {
        let app = app.clone();
        let socket = socket.clone();
        tokio::task::spawn_blocking(move || crate::ensure_daemon_running(&app, &socket))
            .await
            .map_err(|e| e.to_string())??;
    }
    if STOPPING.load(SeqCst) {
        return Err("app is exiting".into());
    }
    let token = std::fs::read_to_string(&token_path).map_err(|e| format!("token: {e}"))?;
    let (r, mut w) = tokio::net::UnixStream::connect(&socket).await.map_err(|e| e.to_string())?.into_split();
    let mut lines = BufReader::new(r).lines();
    write_line(&mut w, &json!({"token": token.trim()})).await?;
    if read_line(&mut lines).await?.get("error").is_some() {
        return Err("daemon rejected the token".into());
    }
    write_line(&mut w, &json!({"jsonrpc": "2.0", "method": "channel.open", "params": {}, "id": 1})).await?;
    let opened = read_line(&mut lines).await?;
    if let Some(err) = opened.get("error") {
        return Err(format!("channel.open refused (daemon too old?): {err}"));
    }
    Ok((lines, w))
}

async fn pump(app: &tauri::AppHandle, mut lines: Lines<BufReader<OwnedReadHalf>>, mut w: OwnedWriteHalf, rx: &mut UnboundedReceiver<String>) {
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some((name, payload)) = parse_event(&l) {
                        let _ = app.emit(&name, payload);
                    }
                }
                _ => return,
            },
            out = rx.recv() => match out {
                Some(msg) => {
                    if w.write_all(msg.as_bytes()).await.is_err() || w.write_all(b"\n").await.is_err() {
                        return;
                    }
                }
                None => return,
            },
        }
    }
}
