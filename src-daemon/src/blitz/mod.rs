//! Supervises the Blitz render worker (`mailvault-daemon --render-worker`).
//!
//! One worker, spawned lazily on the first `render.open`, killed after
//! IDLE_EXIT with no open docs. Any timeout or EOF kills it, fails every
//! waiter with `render_unavailable` (the body shows its failure view) and
//! the next call spawns a fresh one. Rendering never runs in this process:
//! the release profile is panic=abort.
//!
//! The worker has no network. Its `fetch` lines are fetched here through
//! `blitz::fetch::fetch_render_image` (SSRF guard, https, image/*, capped,
//! Network Activity "email images"), at most FETCH_PARALLEL at once.
pub mod fetch;
pub mod routes;

use crate::events::EventBus;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Semaphore};
use tracing::info;

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(8);
pub const TILE_TIMEOUT: Duration = Duration::from_secs(4);
pub const HIT_TIMEOUT: Duration = Duration::from_secs(1);
pub const IDLE_EXIT: Duration = Duration::from_secs(120);
/// Kill only when a call timed out AND the worker has been silent this long.
pub const WATCHDOG: Duration = Duration::from_secs(6);
const FETCH_PARALLEL: usize = 6;
pub const UNAVAILABLE: &str = "render_unavailable";
pub const RENDER_UPDATED: &str = "render-updated";

/// Debug-build test hooks: the worker entry in main.rs hangs or aborts on
/// these exact bodies so the host's timeout and crash paths are testable.
#[cfg(debug_assertions)]
pub const HANG_SENTINEL: &str = "<!--mailvault-render-test-hang-->";
#[cfg(debug_assertions)]
pub const PANIC_SENTINEL: &str = "<!--mailvault-render-test-panic-->";

/// RPCs a person waits on. `render.hit` is deliberately absent: hover traffic
/// must not pause the search index.
pub fn is_foreground(method: &str) -> bool {
    matches!(method, "render.open" | "render.tile" | "render.textRuns")
}

/// Ticks every 30 s and kills a worker that has been idle with no open docs.
pub fn spawn_reaper(host: Arc<RenderHost>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            host.reap_idle().await;
        }
    });
}

#[derive(Clone)]
pub struct WorkerCommand(Arc<dyn Fn() -> Command + Send + Sync>);

impl WorkerCommand {
    pub fn exe(path: impl Into<std::path::PathBuf>) -> Self {
        let path = path.into();
        Self(Arc::new(move || {
            let mut c = Command::new(&path);
            c.arg("--render-worker")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            c
        }))
    }
    pub fn current_exe() -> std::io::Result<Self> {
        Ok(Self::exe(std::env::current_exe()?))
    }
}

type Waiters = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Worker {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    waiters: Waiters,
    /// Set by the stdout reader on EOF: the worker is gone even if the OS has
    /// not reported its exit to `try_wait` yet.
    dead: Arc<AtomicBool>,
}

pub struct RenderHost {
    events: EventBus,
    cmd: WorkerCommand,
    worker: Mutex<Option<Worker>>,
    epoch: AtomicU64,
    next_req: AtomicU64,
    next_doc: AtomicU64,
    open_docs: StdMutex<HashSet<u64>>,
    last_used: StdMutex<Instant>,
    /// Bumped by the stdout reader on every line; the watchdog reads it.
    last_output: Arc<StdMutex<Instant>>,
    fetch_slots: Arc<Semaphore>,
}

impl RenderHost {
    pub fn new(events: EventBus, cmd: WorkerCommand) -> Self {
        Self {
            events,
            cmd,
            worker: Mutex::new(None),
            epoch: AtomicU64::new(0),
            next_req: AtomicU64::new(1),
            next_doc: AtomicU64::new(1),
            open_docs: StdMutex::default(),
            last_used: StdMutex::new(Instant::now()),
            last_output: Arc::new(StdMutex::new(Instant::now())),
            fetch_slots: Arc::new(Semaphore::new(FETCH_PARALLEL)),
        }
    }

    pub async fn open(&self, p: Value) -> Result<Value, String> {
        let doc = self.next_doc.fetch_add(1, Ordering::Relaxed);
        let mut frame = json!({"op": "open", "doc": doc});
        for k in ["html", "cssWidth", "scale", "allowRemote", "theme"] {
            frame[k] = p.get(k).cloned().unwrap_or(Value::Null);
        }
        let ok = match self.call(frame, OPEN_TIMEOUT).await {
            Ok(ok) => ok,
            Err(e) => {
                // A busy (not hung) worker may still finish this open after we
                // gave up. The frontend never learns the id, so drop the doc.
                // Closing an unknown doc is a no-op in the worker.
                let _ = self.send(json!({"op": "close", "doc": doc})).await;
                return Err(e);
            }
        };
        self.open_docs.lock().unwrap().insert(doc);
        Ok(json!({"docId": doc, "rev": ok["rev"], "meta": ok["meta"]}))
    }

    pub async fn tile(&self, doc: u64, index: u32) -> Result<Vec<u8>, String> {
        let ok = self.call(json!({"op": "tile", "doc": doc, "index": index}), TILE_TIMEOUT).await?;
        base64::engine::general_purpose::STANDARD.decode(ok["png"].as_str().unwrap_or_default()).map_err(|_| UNAVAILABLE.to_string())
    }

    /// A slow hit (queued behind tiles) is "no link", never an error.
    pub async fn hit(&self, doc: u64, x: f32, y: f32) -> Result<Value, String> {
        match self.call(json!({"op": "hit", "doc": doc, "x": x, "y": y}), HIT_TIMEOUT).await {
            Err(e) if e == UNAVAILABLE => Ok(json!({"link": null})),
            other => other,
        }
    }

    /// For tests: how many workers have been started.
    pub fn spawned(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    pub async fn close(&self, doc: u64) {
        self.open_docs.lock().unwrap().remove(&doc);
        let _ = self.send(json!({"op": "close", "doc": doc})).await;
    }

    /// Called by the reaper ticker every 30 s. Kills an idle worker.
    pub async fn reap_idle(&self) {
        let idle = self.last_used.lock().unwrap().elapsed() > IDLE_EXIT && self.open_docs.lock().unwrap().is_empty();
        if idle {
            self.kill().await;
        }
    }

    async fn call(&self, mut frame: Value, timeout: Duration) -> Result<Value, String> {
        *self.last_used.lock().unwrap() = Instant::now();
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        frame["req"] = json!(req);
        let (tx, rx) = oneshot::channel();
        let waiters;
        {
            let mut guard = self.worker.lock().await;
            // A worker that crashed (EOF already failed its waiters) must not
            // stay in the slot, or the next, renderable message fails too.
            if let Some(w) = guard.as_mut() {
                if w.dead.load(Ordering::Relaxed) || matches!(w.child.try_wait(), Ok(Some(_))) {
                    *guard = None;
                    self.open_docs.lock().unwrap().clear();
                }
            }
            if guard.is_none() {
                *guard = Some(self.spawn().map_err(|_| UNAVAILABLE.to_string())?);
            }
            let w = guard.as_ref().unwrap();
            waiters = w.waiters.clone();
            w.waiters.lock().unwrap().insert(req, tx);
            let mut stdin = w.stdin.lock().await;
            if stdin.write_all(format!("{frame}\n").as_bytes()).await.is_err() {
                drop(stdin);
                drop(guard);
                self.kill().await;
                return Err(UNAVAILABLE.into());
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(UNAVAILABLE.into()), // worker died; reader already failed us
            Err(_) => {
                // Timed out. Forget this waiter (a late reply is dropped), and
                // kill only if the worker has gone silent: busy is not hung.
                waiters.lock().unwrap().remove(&req);
                if self.last_output.lock().unwrap().elapsed() >= WATCHDOG {
                    self.kill().await;
                }
                Err(UNAVAILABLE.into())
            }
        }
    }

    async fn send(&self, frame: Value) -> std::io::Result<()> {
        let guard = self.worker.lock().await;
        if let Some(w) = guard.as_ref() {
            w.stdin.lock().await.write_all(format!("{frame}\n").as_bytes()).await?;
        }
        Ok(())
    }

    async fn kill(&self) {
        if let Some(mut w) = self.worker.lock().await.take() {
            let _ = w.child.start_kill();
            for (_, tx) in w.waiters.lock().unwrap().drain() {
                let _ = tx.send(Err(UNAVAILABLE.into()));
            }
        }
        // Every doc died with the worker. The frontend re-opens on
        // render_unknown_doc and shows its failure view.
        self.open_docs.lock().unwrap().clear();
    }

    fn spawn(&self) -> std::io::Result<Worker> {
        let mut child = (self.cmd.0)().spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let waiters: Waiters = Arc::default();
        let epoch = self.epoch.fetch_add(1, Ordering::Relaxed) + 1;
        info!("render worker #{epoch} started");
        let (events, slots, w2, s2) = (self.events.clone(), self.fetch_slots.clone(), waiters.clone(), stdin.clone());
        let last_output = self.last_output.clone();
        let dead = Arc::new(AtomicBool::new(false));
        let dead_on_eof = dead.clone();
        *last_output.lock().unwrap() = Instant::now();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                *last_output.lock().unwrap() = Instant::now();
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                match v["kind"].as_str() {
                    Some("reply") | Some("error") => {
                        let req = v["req"].as_u64().unwrap_or(0);
                        if let Some(tx) = w2.lock().unwrap().remove(&req) {
                            let _ = tx.send(if v["kind"] == "reply" {
                                Ok(v["ok"].clone())
                            } else {
                                Err(v["code"].as_str().unwrap_or(UNAVAILABLE).to_string())
                            });
                        }
                    }
                    Some("fetch") => {
                        let (doc, fetch, url) = (v["doc"].clone(), v["fetch"].clone(), v["url"].as_str().unwrap_or_default().to_string());
                        let (slots, stdin) = (slots.clone(), s2.clone());
                        tokio::spawn(async move {
                            let _permit = slots.acquire_owned().await;
                            let bytes = crate::blitz::fetch::fetch_render_image(&url)
                                .await
                                .ok()
                                .map(|b| base64::engine::general_purpose::STANDARD.encode(b));
                            let frame = json!({"op": "fetched", "doc": doc, "fetch": fetch, "bytes": bytes});
                            let _ = stdin.lock().await.write_all(format!("{frame}\n").as_bytes()).await;
                        });
                    }
                    Some("updated") => {
                        events.emit(RENDER_UPDATED, json!({"docId": v["doc"], "rev": v["rev"], "meta": v["meta"]}));
                    }
                    _ => {}
                }
            }
            // EOF: the worker died. Mark it, then fail whoever still waits.
            dead_on_eof.store(true, Ordering::Relaxed);
            for (_, tx) in w2.lock().unwrap().drain() {
                let _ = tx.send(Err(UNAVAILABLE.into()));
            }
        });
        Ok(Worker { child, stdin, waiters, dead })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `CARGO_BIN_EXE_*` exists only for integration tests, not for a bin's own
    /// unit tests, so find the daemon binary Cargo built beside the test
    /// harness (`target/<profile>/deps/<test>` -> `target/<profile>/mailvault-daemon`).
    /// `src-daemon/tests/` has an integration test, so a plain
    /// `cargo test -p mailvault-daemon` always builds it.
    fn daemon_exe() -> std::path::PathBuf {
        let mut dir = std::env::current_exe().expect("current_exe");
        dir.pop();
        if dir.ends_with("deps") {
            dir.pop();
        }
        let exe = dir.join(format!("mailvault-daemon{}", std::env::consts::EXE_SUFFIX));
        assert!(exe.exists(), "daemon binary not built at {}: run `cargo test -p mailvault-daemon` without --bin", exe.display());
        exe
    }

    fn host() -> RenderHost {
        RenderHost::new(crate::events::EventBus::new(16), WorkerCommand::exe(daemon_exe()))
    }

    #[tokio::test]
    async fn open_tile_hit_close() {
        let h = host();
        let opened = h.open(json!({"html": "<body style=\"margin:0\"><a href=\"https://x.test/\" style=\"display:block;height:40px\">x</a>", "cssWidth": 300, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        assert_eq!(opened["meta"]["tileCount"], 1);
        let tile = h.tile(doc, 0).await.unwrap();
        assert!(tile.len() > 8 && &tile[1..4] == b"PNG");
        let hit = h.hit(doc, 5.0, 5.0).await.unwrap();
        assert_eq!(hit["link"]["href"], "https://x.test/");
        h.close(doc).await;
        assert_eq!(h.tile(doc, 0).await.unwrap_err(), "render_unknown_doc");
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn timeout_kills_worker_and_next_call_respawns() {
        let h = host();
        // Debug builds only: the worker sleeps forever on this exact HTML. It
        // writes nothing, so at the 8 s open timeout the 6 s watchdog fires.
        let err = h.open(json!({"html": HANG_SENTINEL, "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap_err();
        assert_eq!(err, "render_unavailable");
        let ok = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await;
        assert!(ok.is_ok(), "fresh worker after the kill");
        assert_eq!(h.spawned(), 2);
    }

    #[tokio::test]
    async fn burst_of_tiles_and_a_hit_never_kills_the_worker() {
        let h = Arc::new(host());
        let html = format!("<body style=\"margin:0\">{}</body>", "<p style=\"height:500px;background:linear-gradient(#fff,#09f)\">x</p>".repeat(40));
        // Debug-build Blitz is slow: keep the burst inside the 4 s tile budget
        // (8 small tiles) so the test pins "no kill", not raster speed.
        let opened = h.open(json!({"html": html, "cssWidth": 400, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let tiles: Vec<_> = (0..8).map(|i| { let h = h.clone(); tokio::spawn(async move { h.tile(doc, i).await }) }).collect();
        let hit = h.hit(doc, 5.0, 5.0).await;
        assert!(hit.is_ok(), "a slow hit is no link, not an error");
        for t in tiles {
            assert!(t.await.unwrap().is_ok(), "every queued tile resolves");
        }
        assert_eq!(h.spawned(), 1, "busy is not hung: no kill, no respawn");
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn worker_crash_fails_waiters_not_daemon() {
        let h = host();
        let err = h.open(json!({"html": PANIC_SENTINEL, "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap_err();
        assert_eq!(err, "render_unavailable");
        assert!(h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.is_ok(),
            "a crashed worker is reaped and the next open spawns a fresh one");
        assert_eq!(h.spawned(), 2);
    }

    #[test]
    fn only_open_tile_and_text_runs_are_foreground() {
        assert!(is_foreground("render.open"));
        assert!(is_foreground("render.tile"));
        assert!(is_foreground("render.textRuns"));
        assert!(!is_foreground("render.hit"), "hover traffic must not pause the index");
    }
}
