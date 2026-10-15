//! Supervises the Blitz render worker (`mailvault-daemon --render-worker`).
//!
//! WORKERS (two) workers, each spawned lazily by the first `render.open` that
//! lands on it and killed after IDLE_EXIT with no open docs. `RenderPool` pins a
//! doc to a worker by id (`worker_for`), so every later op on it goes to the
//! worker that holds it, and the supervision below is per worker (`RenderHost`):
//! a hung or crashed worker takes only its own docs with it. A timeout alone never kills it (busy is not
//! hung): the kill needs a timed-out call AND WATCHDOG of silence from the
//! worker while it owes an answer (`Silence`). EOF, a failed stdin write and
//! the reaper end it too; every waiter then fails with `render_unavailable`
//! (the body shows its failure view) and the next call spawns a fresh one.
//! Rendering never runs in this process.
//!
//! At most MAX_OPEN_DOCS documents stay open per worker: an `open` past that closes the
//! least recently used others, and an evicted doc answers `render_unknown_doc`
//! like a closed one (the body reopens it quietly).
//!
//! The worker survives a panic in one document: each operation runs under
//! `catch_unwind`, which needs panic=unwind. The `[profile.release]
//! panic = "abort"` in this crate's manifest is ignored (cargo ignores a
//! workspace member's profile tables and the root sets none), so the build
//! unwinds; a build that really aborted would turn such a panic into a worker
//! exit, which this host handles like any crash. After a caught panic the worker exits once its last
//! document closes, so the next call gets a clean process.
//!
//! The worker has no network. Its `fetch` lines are fetched here through
//! `blitz::fetch::fetch_render_image` (SSRF guard, https, image/* incl. SVG, capped,
//! Network Activity "email images"), at most FETCH_PARALLEL at once.
pub mod fetch;
pub mod fonts;
mod inflight;
pub mod routes;

use crate::events::EventBus;
use inflight::{FetchGuard, InFlight};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Semaphore};
use tracing::{debug, info};

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(8);
pub const TILE_TIMEOUT: Duration = Duration::from_secs(4);
pub const HIT_TIMEOUT: Duration = Duration::from_secs(1);
pub const TEXT_RUNS_TIMEOUT: Duration = Duration::from_secs(4);
pub const SERIALIZE_TIMEOUT: Duration = Duration::from_secs(2);
pub const FOLD_TIMEOUT: Duration = Duration::from_secs(4);
/// render.inspect walks every marked element; it is harness-only traffic. Kept
/// below the shell's 6 s reply timeout so the daemon answers first.
pub(crate) const INSPECT_TIMEOUT: Duration = Duration::from_secs(4);
/// How long `image` waits for the doc's remote images to land before painting what it has.
const IMAGE_SETTLE: Duration = Duration::from_secs(5);
/// The worker's paint of a whole document. The shell allows 30 s (blitz_tiles::reply_timeout).
const IMAGE_TIMEOUT: Duration = Duration::from_secs(20);
pub const IDLE_EXIT: Duration = Duration::from_secs(120);
/// Kill only when a call timed out AND the worker has been silent this long.
pub const WATCHDOG: Duration = Duration::from_secs(6);
const FETCH_PARALLEL: usize = 6;
/// Open documents per worker. A document can peak at hundreds of MiB, so a long
/// thread or chat must not hold an unbounded number on one worker. Past this,
/// an `open` closes the least recently used other docs (`evict_for`).
pub const MAX_OPEN_DOCS: usize = 32;
/// Render workers. Two, so a long thread's tiles and a chat's do not queue behind
/// one single-threaded Blitz. Docs are pinned by `worker_for(doc, WORKERS)`.
pub const WORKERS: usize = 2;
pub const UNAVAILABLE: &str = "render_unavailable";
pub const RENDER_UPDATED: &str = "render-updated";

/// Debug-build test hooks: the worker entry in main.rs hangs or aborts on
/// these exact bodies so the host's timeout and crash paths are testable.
#[cfg(debug_assertions)]
pub const HANG_SENTINEL: &str = "<!--mailvault-render-test-hang-->";
#[cfg(debug_assertions)]
pub const PANIC_SENTINEL: &str = "<!--mailvault-render-test-panic-->";

/// Doc ids are unique within a process, but the shell caches tiles by
/// `docId/rev/index` as `immutable` for the life of the webview, and a respawned
/// daemon would otherwise hand out 1, 2, 3 again: a new mail would show an old
/// mail's cached pixels. So each RenderHost starts at its own 2^20-wide slot of
/// the id space. The largest start is (2^32 - 1) << 20 plus 1, below 2^52, so an
/// id stays a safe JS integer even after a million opens.
fn doc_id_seed(slot: u32) -> u64 {
    ((slot as u64) << 20) + 1
}

/// A random per-process base plus a per-host counter: two hosts in one process
/// never share a slot (the counter), two daemon boots almost never do (the base).
fn next_doc_id_seed() -> u64 {
    static BASE: OnceLock<u32> = OnceLock::new();
    static HOSTS: AtomicU32 = AtomicU32::new(0);
    let base = *BASE.get_or_init(rand::random::<u32>);
    doc_id_seed(base.wrapping_add(HOSTS.fetch_add(1, Ordering::Relaxed)))
}

/// The watchdog measures silence from the moment the worker became busy. A
/// request that arrives while it owes no answer finds an idle worker, so its
/// last output says nothing about how long it has been unresponsive.
fn silence_clock(since: Instant, now: Instant, owed: usize) -> Instant {
    if owed == 0 { now } else { since }
}

/// What the watchdog knows about one worker. `owed` counts the requests written
/// to it that it has not answered yet. A caller that timed out gives up its
/// waiter, but the worker still owes the reply, so a hung worker stays "busy"
/// however many calls come and go; only the worker's own output moves the clock.
struct Silence {
    /// Start of the current silence: the last worker output, or the moment it
    /// went from owing nothing to owing something.
    since: Instant,
    owed: usize,
    /// `req`s of the `image` frames still owed. A whole-document paint writes
    /// nothing until it ends, so while one is outstanding the worker may be
    /// silent for as long as IMAGE_TIMEOUT before it counts as hung.
    images: HashSet<u64>,
}

impl Silence {
    fn new(now: Instant) -> Self {
        Self { since: now, owed: 0, images: HashSet::new() }
    }

    /// A request is about to be written.
    fn request(&mut self, now: Instant) {
        self.since = silence_clock(self.since, now, self.owed);
        self.owed += 1;
    }

    /// `request` for frame `req`; `image` marks a whole-document paint.
    fn request_op(&mut self, now: Instant, req: u64, image: bool) {
        self.request(now);
        if image {
            self.images.insert(req);
        }
    }

    /// `reply` to frame `req`.
    fn reply_to(&mut self, now: Instant, req: u64) {
        self.images.remove(&req);
        self.reply(now);
    }

    /// How long the worker may stay silent while it owes an answer before it is hung.
    fn watchdog(&self) -> Duration {
        if self.images.is_empty() { WATCHDOG } else { IMAGE_TIMEOUT }
    }

    /// The worker wrote a line that answers nothing (fetch, updated).
    fn line(&mut self, now: Instant) {
        self.since = now;
    }

    /// The worker answered one request, whether or not anyone still waits for it.
    fn reply(&mut self, now: Instant) {
        self.since = now;
        self.owed = self.owed.saturating_sub(1);
    }

    fn silent_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.since)
    }
}

/// RPCs a person waits on. `render.hit` and `render.inspect` are deliberately
/// absent: hover and harness traffic must not pause the search index.
pub fn is_foreground(method: &str) -> bool {
    matches!(method, "render.open" | "render.tile" | "render.textRuns")
}

/// The font families the worker has been sent, kept whole so a respawned
/// worker gets them again. The worker marks a family known on first sight and
/// ignores later faces of it, so a family must only ever travel complete (all
/// its installed faces in one frame) and at most once per worker.
///
/// A family that panics the worker while it registers it, or that killed a
/// worker, is refused: dropped from what is kept and never sent again, so one
/// bad family cannot crash every worker until the daemon restarts. The worker
/// acknowledges each family it has dealt with (`ack`). A worker that dies with
/// replayed families still unacknowledged died on the first of them (`died`):
/// the replay is the first thing a new worker reads and it takes the families
/// in the order sent. A family sent to a live worker is not blamed for its
/// death (that frame may have waited behind other work, and the worker may have
/// died of something else): it is refused on an `ok:false` ack, or blamed on
/// the next spawn's replay if it really kills.
#[derive(Default)]
struct FontFrames {
    kept: Vec<Value>,
    refused: Vec<String>,
    /// The worker spawn `unacked` belongs to.
    epoch: u64,
    /// The replay frame of that spawn, minus what the worker has acknowledged, in the order sent.
    unacked: Vec<String>,
}

impl FontFrames {
    /// Keeps the families not kept (or refused) yet and returns exactly those, as first given.
    fn claim(&mut self, families: Vec<Value>) -> Vec<Value> {
        let mut fresh = Vec::new();
        for f in families {
            if !self.has(f["family"].as_str().unwrap_or_default()) {
                self.kept.push(f.clone());
                fresh.push(f);
            }
        }
        fresh
    }

    /// Kept, or refused: either way nothing more is to be sent for it.
    fn has(&self, family: &str) -> bool {
        self.kept.iter().any(|k| k["family"] == family) || self.refused.iter().any(|r| r == family)
    }

    /// One frame with every kept family, or none when nothing is kept.
    fn replay(&self) -> Option<Value> {
        (!self.kept.is_empty()).then(|| json!({"op": "fonts", "families": self.kept}))
    }

    /// A worker (spawn `epoch`) is about to be sent every kept family: the
    /// replay, which is what a death is blamed on.
    fn begin(&mut self, epoch: u64) {
        self.epoch = epoch;
        self.unacked = self.kept.iter().map(|k| k["family"].as_str().unwrap_or_default().to_string()).collect();
    }

    /// The worker of spawn `epoch` is done with `family`; `ok` false means its registration panicked.
    fn ack(&mut self, epoch: u64, family: &str, ok: bool) {
        if epoch != self.epoch {
            return; // a worker that is already replaced
        }
        if let Some(at) = self.unacked.iter().position(|u| u == family) {
            self.unacked.remove(at);
        }
        if !ok {
            self.refuse(family);
        }
    }

    /// The worker of spawn `epoch` is gone. If it still owed acks, it died on the first.
    fn died(&mut self, epoch: u64) {
        if epoch != self.epoch || self.unacked.is_empty() {
            return;
        }
        let offender = self.unacked.remove(0);
        self.unacked.clear();
        self.refuse(&offender);
    }

    fn refuse(&mut self, family: &str) {
        self.kept.retain(|k| k["family"] != family);
        if !self.refused.iter().any(|r| r == family) {
            self.refused.push(family.to_string());
        }
    }
}

/// The worker a doc lives on. Ids are handed out one by one, so consecutive docs
/// alternate between workers.
pub fn worker_for(doc: u64, workers: usize) -> usize {
    (doc % workers.max(1) as u64) as usize
}

/// The workers and the doc id counter. A doc id is allocated here, once, and its
/// remainder picks the worker for the doc's whole life.
pub struct RenderPool {
    pub(crate) hosts: Vec<Arc<RenderHost>>,
    /// Starts at a per-boot seed (`next_doc_id_seed`), never at 1: the shell caches
    /// tiles by docId as immutable, so ids must not repeat across daemon boots.
    next_doc: AtomicU64,
}

impl RenderPool {
    pub fn new(make: impl Fn() -> RenderHost) -> Self {
        Self { hosts: (0..WORKERS).map(|_| Arc::new(make())).collect(), next_doc: AtomicU64::new(next_doc_id_seed()) }
    }

    pub async fn open(&self, p: Value) -> Result<Value, String> {
        let doc = self.next_doc.fetch_add(1, Ordering::Relaxed);
        self.for_doc(doc).open_as(doc, p).await
    }

    /// The worker that holds `doc` (or would, were it open).
    pub fn for_doc(&self, doc: u64) -> &Arc<RenderHost> {
        &self.hosts[worker_for(doc, self.hosts.len())]
    }

    /// Each worker has its own font registry, so a family goes to every one.
    pub async fn register_fonts(&self, families: Vec<Value>) {
        for h in &self.hosts {
            h.register_fonts(families.clone()).await;
        }
    }

    /// Every worker has the family (they are always registered together).
    pub fn has_font(&self, family: &str) -> bool {
        self.hosts.iter().all(|h| h.has_font(family))
    }

    pub async fn reap_idle(&self) {
        for h in &self.hosts {
            h.reap_idle().await;
        }
    }
}

/// Ticks every 30 s and kills each worker that has been idle with no open docs.
pub fn spawn_reaper(pool: Arc<RenderPool>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            pool.reap_idle().await;
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
    /// Which spawn this is (RenderHost::epoch at the time). A kill names the
    /// epoch its caller saw, so a late timeout cannot kill a newer worker.
    epoch: u64,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    waiters: Waiters,
    /// Set by the stdout reader on EOF: the worker is gone even if the OS has
    /// not reported its exit to `try_wait` yet.
    dead: Arc<AtomicBool>,
    /// Fed by this worker's stdout reader and by `call`; read by the watchdog.
    /// Per spawn, so a dying worker's last lines cannot move a new one's clock.
    silence: Arc<StdMutex<Silence>>,
}

pub struct RenderHost {
    events: EventBus,
    cmd: WorkerCommand,
    worker: Mutex<Option<Worker>>,
    epoch: AtomicU64,
    next_req: AtomicU64,
    next_doc: AtomicU64,
    /// Open docs and when each was last used (`touch`). Eviction reads the stamps.
    open_docs: StdMutex<HashMap<u64, Instant>>,
    last_used: StdMutex<Instant>,
    fetch_slots: Arc<Semaphore>,
    /// Fetches still running per doc, for `image` to wait on.
    inflight: Arc<InFlight>,
    font_frames: Arc<StdMutex<FontFrames>>,
}

impl RenderHost {
    pub fn new(events: EventBus, cmd: WorkerCommand) -> Self {
        Self {
            events,
            cmd,
            worker: Mutex::new(None),
            epoch: AtomicU64::new(0),
            next_req: AtomicU64::new(1),
            next_doc: AtomicU64::new(next_doc_id_seed()),
            open_docs: StdMutex::default(),
            last_used: StdMutex::new(Instant::now()),
            fetch_slots: Arc::new(Semaphore::new(FETCH_PARALLEL)),
            inflight: Arc::default(),
            font_frames: Arc::default(),
        }
    }

    /// Opens a doc under this host's own id counter (a lone host; a pool allocates ids itself).
    pub async fn open(self: &Arc<Self>, p: Value) -> Result<Value, String> {
        let doc = self.next_doc.fetch_add(1, Ordering::Relaxed);
        self.open_as(doc, p).await
    }

    /// Opens a doc under the id the caller chose.
    pub async fn open_as(self: &Arc<Self>, doc: u64, p: Value) -> Result<Value, String> {
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
        // The new doc is the newest stamp, so it is never its own victim. Victims
        // leave `open_docs` here, so ops on them answer render_unknown_doc at once
        // (`doc_call`); their close frames go out on a task, in order, and this
        // open does not wait for them or see their errors.
        let victims = {
            let mut docs = self.open_docs.lock().unwrap();
            docs.insert(doc, Instant::now());
            Self::lru_victims(&mut docs, doc)
        };
        if !victims.is_empty() {
            let host = Arc::clone(self);
            tokio::spawn(async move {
                for victim in victims {
                    debug!("render doc {victim} evicted: over {MAX_OPEN_DOCS} open");
                    let _ = host.send(json!({"op": "close", "doc": victim})).await;
                }
            });
        }
        Ok(json!({"docId": doc, "rev": ok["rev"], "meta": ok["meta"]}))
    }

    /// Removes and returns the least recently used docs (oldest first, ties by id)
    /// other than `keep` until at most MAX_OPEN_DOCS remain. The caller closes them.
    fn lru_victims(docs: &mut HashMap<u64, Instant>, keep: u64) -> Vec<u64> {
        let mut victims = Vec::new();
        while docs.len() > MAX_OPEN_DOCS {
            let oldest = docs.iter().filter(|(d, _)| **d != keep).min_by_key(|(d, t)| (**t, **d));
            let Some((&victim, _)) = oldest else { break };
            docs.remove(&victim);
            victims.push(victim);
        }
        victims
    }

    /// `call` for an op on an open doc: counts as use for the LRU. A doc that is
    /// not open here (closed, evicted, lost with a worker) is unknown without
    /// asking the worker, which may not have read its close frame yet.
    async fn doc_call(&self, doc: u64, frame: Value, timeout: Duration) -> Result<Value, String> {
        match self.open_docs.lock().unwrap().get_mut(&doc) {
            Some(t) => *t = Instant::now(),
            None => return Err("render_unknown_doc".to_string()),
        }
        self.call(frame, timeout).await
    }

    pub async fn tile(&self, doc: u64, index: u32) -> Result<Vec<u8>, String> {
        let ok = self.doc_call(doc, json!({"op": "tile", "doc": doc, "index": index}), TILE_TIMEOUT).await?;
        base64::engine::general_purpose::STANDARD.decode(ok["png"].as_str().unwrap_or_default()).map_err(|_| UNAVAILABLE.to_string())
    }

    /// A slow hit (queued behind tiles) is "no link" and no fold, never an
    /// error. A reply is passed on whole: `{link, fold}`.
    pub async fn hit(&self, doc: u64, x: f32, y: f32) -> Result<Value, String> {
        match self.doc_call(doc, json!({"op": "hit", "doc": doc, "x": x, "y": y}), HIT_TIMEOUT).await {
            Err(e) if e == UNAVAILABLE => Ok(json!({"link": null, "fold": null})),
            other => other,
        }
    }

    pub async fn text_runs(&self, doc: u64, index: u32) -> Result<Value, String> {
        self.doc_call(doc, json!({"op": "textRuns", "doc": doc, "index": index}), TEXT_RUNS_TIMEOUT).await
    }

    pub async fn serialize(&self, doc: u64, start: Value, end: Value) -> Result<Value, String> {
        self.doc_call(doc, json!({"op": "serialize", "doc": doc, "start": start, "end": end}), SERIALIZE_TIMEOUT).await
    }

    /// Opens or closes one fold. The new layout reaches the frontend through
    /// the `render-updated` event the worker also sends; fold state lives in
    /// the document and dies with the worker (`render_unknown_doc`).
    pub async fn fold(&self, doc: u64, id: &str, open: bool) -> Result<Value, String> {
        self.doc_call(doc, json!({"op": "fold", "doc": doc, "id": id, "open": open}), FOLD_TIMEOUT).await
    }

    /// Sends the families the worker does not have yet and keeps them: a
    /// respawned worker (idle exit, crash) is sent every kept family, whole,
    /// before its first request. Callers pass each family with all its faces.
    pub async fn register_fonts(&self, families: Vec<Value>) {
        let fresh = self.font_frames.lock().unwrap().claim(families);
        if fresh.is_empty() {
            return;
        }
        // No worker: the families are only kept, and replayed at the next spawn.
        let guard = self.worker.lock().await;
        if let Some(w) = guard.as_ref() {
            let _ = w.stdin.lock().await.write_all(format!("{}\n", json!({"op": "fonts", "families": fresh})).as_bytes()).await;
        }
    }

    pub fn has_font(&self, family: &str) -> bool {
        self.font_frames.lock().unwrap().has(family)
    }

    /// The whole document as a PNG, once its remote images have landed (5 s
    /// cap). A doc that is not open answers at once, without waiting.
    pub async fn image(&self, doc: u64) -> Result<Value, String> {
        // Touched now, not only when the frame is sent: opens during the settle
        // wait must not evict the doc being exported.
        match self.open_docs.lock().unwrap().get_mut(&doc) {
            Some(t) => *t = Instant::now(),
            None => return Err("render_unknown_doc".to_string()),
        }
        let _ = self.inflight.settled(doc, IMAGE_SETTLE).await;
        self.doc_call(doc, json!({"op": "image", "doc": doc}), IMAGE_TIMEOUT).await
    }

    /// `render.image` with `settleOnly`: waits for the doc's fetches as `image` does (5 s cap), has the worker apply
    /// what landed, and answers `{settled, rev, meta}` with the doc's CURRENT meta, painting nothing. The export of a
    /// document past the image area cap draws its tiles at full scale instead of a shrunk PNG, and sizes them from this
    /// meta: `open`'s predates the images, which relayout the doc.
    pub async fn settle(&self, doc: u64) -> Result<Value, String> {
        match self.open_docs.lock().unwrap().get_mut(&doc) {
            Some(t) => *t = Instant::now(),
            None => return Err("render_unknown_doc".to_string()),
        }
        let settled = self.inflight.settled(doc, IMAGE_SETTLE).await;
        let mut reply = self.doc_call(doc, json!({"op": "image", "doc": doc, "settleOnly": true}), IMAGE_TIMEOUT).await?;
        reply["settled"] = json!(settled);
        Ok(reply)
    }

    /// Per-element measurements for the parity harness. Not foreground traffic.
    pub async fn inspect(&self, doc: u64) -> Result<Value, String> {
        self.doc_call(doc, json!({"op": "inspect", "doc": doc}), INSPECT_TIMEOUT).await
    }

    /// For tests: how many workers have been started.
    pub fn spawned(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    pub async fn close(&self, doc: u64) {
        self.open_docs.lock().unwrap().remove(&doc);
        let _ = self.send(json!({"op": "close", "doc": doc})).await;
    }

    /// Called by the reaper ticker every 30 s. Kills an idle worker. Idleness
    /// is re-checked under the slot lock, so a call that arrives between the
    /// check and the kill is never failed by it.
    pub async fn reap_idle(&self) {
        let mut guard = self.worker.lock().await;
        let idle = self.last_used.lock().unwrap().elapsed() > IDLE_EXIT
            && self.open_docs.lock().unwrap().is_empty()
            && guard.as_ref().is_some_and(|w| w.waiters.lock().unwrap().is_empty());
        if idle {
            if let Some(w) = guard.take() {
                Self::terminate(w);
            }
        }
    }

    async fn call(&self, mut frame: Value, timeout: Duration) -> Result<Value, String> {
        *self.last_used.lock().unwrap() = Instant::now();
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        frame["req"] = json!(req);
        let (tx, rx) = oneshot::channel();
        let waiters;
        let silence;
        let epoch;
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
                let w = self.spawn().map_err(|_| UNAVAILABLE.to_string())?;
                // Written here, before the caller's own frame (same stdin, same
                // guard), so the first request already sees every font.
                let replay = {
                    let mut frames = self.font_frames.lock().unwrap();
                    frames.begin(w.epoch);
                    frames.replay()
                };
                if let Some(frame) = replay {
                    let _ = w.stdin.lock().await.write_all(format!("{frame}\n").as_bytes()).await;
                }
                *guard = Some(w);
            }
            let w = guard.as_ref().unwrap();
            epoch = w.epoch;
            waiters = w.waiters.clone();
            silence = w.silence.clone();
            {
                let mut pending = w.waiters.lock().unwrap();
                silence.lock().unwrap().request_op(Instant::now(), req, frame["op"] == "image");
                pending.insert(req, tx);
            }
            let mut stdin = w.stdin.lock().await;
            if stdin.write_all(format!("{frame}\n").as_bytes()).await.is_err() {
                drop(stdin);
                drop(guard);
                self.kill_epoch(epoch).await;
                return Err(UNAVAILABLE.into());
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(UNAVAILABLE.into()), // worker died; reader already failed us
            Err(_) => {
                // Timed out. Forget this waiter (a late reply is dropped), and
                // kill only if the worker has gone silent: busy is not hung. The
                // forgotten request is still owed, so this does not restart the clock.
                waiters.lock().unwrap().remove(&req);
                let hung = {
                    let s = silence.lock().unwrap();
                    s.silent_for(Instant::now()) >= s.watchdog()
                };
                if hung {
                    self.kill_epoch(epoch).await;
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

    /// Kill the worker of spawn `epoch`, if it is still the one in the slot.
    async fn kill_epoch(&self, epoch: u64) {
        let mut guard = self.worker.lock().await;
        if guard.as_ref().is_some_and(|w| w.epoch == epoch) {
            if let Some(w) = guard.take() {
                Self::terminate(w);
            }
            // Every doc died with the worker. A tile asked for one of them
            // answers render_unknown_doc and the body shows its failure view.
            self.open_docs.lock().unwrap().clear();
        }
    }

    fn terminate(mut w: Worker) {
        let _ = w.child.start_kill();
        for (_, tx) in w.waiters.lock().unwrap().drain() {
            let _ = tx.send(Err(UNAVAILABLE.into()));
        }
    }

    fn spawn(&self) -> std::io::Result<Worker> {
        let mut child = (self.cmd.0)().spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let waiters: Waiters = Arc::default();
        let epoch = self.epoch.fetch_add(1, Ordering::Relaxed) + 1;
        info!("render worker #{epoch} started");
        let (events, slots, w2, s2) = (self.events.clone(), self.fetch_slots.clone(), waiters.clone(), stdin.clone());
        let inflight = self.inflight.clone();
        let silence = Arc::new(StdMutex::new(Silence::new(Instant::now())));
        let heard = silence.clone();
        let dead = Arc::new(AtomicBool::new(false));
        let dead_on_eof = dead.clone();
        let frames = self.font_frames.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    heard.lock().unwrap().line(Instant::now());
                    continue;
                };
                let kind = v["kind"].as_str();
                if matches!(kind, Some("reply") | Some("error")) {
                    heard.lock().unwrap().reply_to(Instant::now(), v["req"].as_u64().unwrap_or(0));
                } else {
                    heard.lock().unwrap().line(Instant::now());
                }
                match kind {
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
                        // Counted from here, not from when a slot frees up, so `image`
                        // also waits for fetches still queued behind FETCH_PARALLEL.
                        let doc_id = doc.as_u64().unwrap_or(0);
                        inflight.begin(doc_id);
                        let guard = FetchGuard(inflight.clone(), doc_id);
                        tokio::spawn(async move {
                            let _guard = guard;
                            let _permit = slots.acquire_owned().await;
                            let bytes = crate::blitz::fetch::fetch_render_image(&url)
                                .await
                                .ok()
                                .map(|b| base64::engine::general_purpose::STANDARD.encode(b));
                            let frame = json!({"op": "fetched", "doc": doc, "fetch": fetch, "bytes": bytes});
                            let _ = stdin.lock().await.write_all(format!("{frame}\n").as_bytes()).await;
                        });
                    }
                    Some("font") => {
                        if let Some(family) = v["family"].as_str() {
                            frames.lock().unwrap().ack(epoch, family, v["ok"].as_bool().unwrap_or(false));
                        }
                    }
                    Some("updated") => {
                        events.emit(RENDER_UPDATED, json!({"docId": v["doc"], "rev": v["rev"], "meta": v["meta"]}));
                    }
                    _ => {}
                }
            }
            // EOF: the worker died. Mark it, then fail whoever still waits. A
            // family it owed an ack for is blamed first, so the next spawn (the
            // very next call) no longer replays it.
            frames.lock().unwrap().died(epoch);
            dead_on_eof.store(true, Ordering::Relaxed);
            for (_, tx) in w2.lock().unwrap().drain() {
                let _ = tx.send(Err(UNAVAILABLE.into()));
            }
        });
        Ok(Worker { epoch, child, stdin, waiters, dead, silence })
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
    pub(super) fn daemon_exe() -> std::path::PathBuf {
        let mut dir = std::env::current_exe().expect("current_exe");
        dir.pop();
        if dir.ends_with("deps") {
            dir.pop();
        }
        let exe = dir.join(format!("mailvault-daemon{}", std::env::consts::EXE_SUFFIX));
        assert!(exe.exists(), "daemon binary not built at {}: run `cargo test -p mailvault-daemon` without --bin", exe.display());
        exe
    }

    fn host() -> Arc<RenderHost> {
        Arc::new(RenderHost::new(crate::events::EventBus::new(16), WorkerCommand::exe(daemon_exe())))
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
        let h = host();
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
    fn doc_ids_stay_js_safe_and_differ_between_hosts() {
        let first = |h: &RenderHost| h.next_doc.load(Ordering::Relaxed);
        let (a, b) = (host(), host());
        assert_ne!(first(&a), first(&b), "two hosts must not hand out the same first doc id");
        // The widest slot plus a million opens is still below 2^53.
        assert!(doc_id_seed(u32::MAX) + (1 << 20) < (1u64 << 53));
        assert_eq!(doc_id_seed(0), 1, "slot 0 starts at 1, never 0");
    }

    #[test]
    fn silence_is_measured_from_when_the_worker_became_busy() {
        let old = Instant::now() - Duration::from_secs(60);
        let now = Instant::now();
        assert_eq!(silence_clock(old, now, 0), now, "idle worker: its last line is not silence");
        assert_eq!(silence_clock(old, now, 1), old, "already busy: keep counting from the last line");
        assert_eq!(silence_clock(old, now, 5), old);
    }

    #[test]
    fn a_timed_out_call_does_not_restart_the_silence_clock() {
        let t0 = Instant::now();
        let mut s = Silence::new(t0);
        s.request(t0); // a tile the spinning worker never answers
        // It times out at TILE_TIMEOUT and its waiter is forgotten: the clock hears
        // nothing about that. The next tile then arrives while the first is still owed.
        s.request(t0 + TILE_TIMEOUT);
        let later = t0 + 2 * TILE_TIMEOUT;
        assert_eq!(s.silent_for(later), 2 * TILE_TIMEOUT, "silent since the first request, not the second");
        assert!(s.silent_for(later) >= WATCHDOG, "so the second timeout kills the hung worker");
    }

    #[test]
    fn a_reply_restarts_the_clock_and_an_answered_worker_is_idle_again() {
        let t0 = Instant::now();
        let secs = Duration::from_secs;
        let mut s = Silence::new(t0);
        s.request(t0);
        s.request(t0 + secs(1));
        s.reply(t0 + secs(2));
        assert_eq!(s.silent_for(t0 + secs(3)), secs(1), "a reply is output: the count starts again");
        s.reply(t0 + secs(3));
        // Everything is answered: the next request finds an idle worker, whose age proves nothing.
        s.request(t0 + secs(60));
        assert_eq!(s.silent_for(t0 + secs(61)), secs(1));
    }

    #[test]
    fn other_output_proves_life_but_does_not_clear_what_is_owed() {
        let t0 = Instant::now();
        let secs = Duration::from_secs;
        let mut s = Silence::new(t0);
        s.request(t0);
        s.line(t0 + secs(5)); // e.g. a fetch or updated line
        assert_eq!(s.silent_for(t0 + secs(6)), secs(1));
        s.request(t0 + secs(7)); // still owed: no restart
        assert_eq!(s.silent_for(t0 + secs(8)), secs(3));
        s.reply(t0 + secs(8));
        s.reply(t0 + secs(8));
        s.reply(t0 + secs(8)); // a reply too many (never sent by the worker) cannot underflow
        s.request(t0 + secs(9));
        assert_eq!(s.silent_for(t0 + secs(10)), secs(1));
    }

    #[tokio::test]
    async fn a_late_kill_for_another_workers_epoch_spares_the_live_one() {
        let h = host();
        let opened = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let live = h.spawned();
        h.kill_epoch(live + 7).await; // a timeout that belongs to some earlier, dead worker
        assert!(h.tile(doc, 0).await.is_ok(), "the live worker and its doc survive");
        assert_eq!(h.spawned(), 1);
        h.kill_epoch(live).await;
        assert_eq!(h.tile(doc, 0).await.unwrap_err(), "render_unknown_doc", "killing the right epoch does kill it");
    }

    #[test]
    fn an_outstanding_image_stretches_the_watchdog_until_it_is_answered() {
        let t0 = Instant::now();
        let mut s = Silence::new(t0);
        assert_eq!(s.watchdog(), WATCHDOG);
        s.request_op(t0, 1, true);
        s.request_op(t0, 2, false);
        assert_eq!(s.watchdog(), IMAGE_TIMEOUT, "a paint writes nothing until it ends");
        s.reply_to(t0, 2);
        assert_eq!(s.watchdog(), IMAGE_TIMEOUT, "answering another request does not end the paint");
        s.reply_to(t0, 1);
        assert_eq!(s.watchdog(), WATCHDOG);
        assert_eq!(s.owed, 0);
    }

    /// A fake worker that answers `image` after 7 s (longer than WATCHDOG) and never answers `hit`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_long_image_paint_is_not_a_hung_worker_when_another_call_times_out() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("slow-image-worker.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             while IFS= read -r l; do\n\
             r=${l#*'\"req\":'}; r=${r%%[,\\}]*}\n\
             case \"$l\" in\n\
             *'\"op\":\"image\"'*) ( sleep 7; printf '{\"kind\":\"reply\",\"req\":%s,\"ok\":{\"png\":\"AA==\"}}\\n' \"$r\" ) &;;\n\
             *'\"op\":\"hit\"'*) ;;\n\
             *) printf '{\"kind\":\"reply\",\"req\":%s,\"ok\":{}}\\n' \"$r\";;\n\
             esac\n\
             done\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let h = Arc::new(RenderHost::new(crate::events::EventBus::new(16), WorkerCommand::exe(&script)));
        h.open_docs.lock().unwrap().insert(7, Instant::now());
        h.open_docs.lock().unwrap().insert(8, Instant::now());
        let painter = {
            let h = h.clone();
            tokio::spawn(async move { h.image(7).await })
        };
        // Past WATCHDOG of silence since the paint began, then a call that times out.
        tokio::time::sleep(WATCHDOG - Duration::from_millis(500)).await;
        let hit = h.call(json!({"op": "hit", "doc": 8, "x": 0, "y": 0}), Duration::from_secs(1)).await;
        assert_eq!(hit.unwrap_err(), UNAVAILABLE, "the hit itself times out");
        assert_eq!(h.spawned(), 1, "same worker");
        assert!(h.open_docs.lock().unwrap().contains_key(&8), "other docs are still open");
        let png = painter.await.unwrap().expect("the paint succeeds");
        assert_eq!(png["png"], "AA==");
        assert_eq!(h.spawned(), 1);
    }

    #[test]
    fn only_open_tile_and_text_runs_are_foreground() {
        assert!(is_foreground("render.open"));
        assert!(is_foreground("render.tile"));
        assert!(is_foreground("render.textRuns"));
        assert!(!is_foreground("render.hit"), "hover traffic must not pause the index");
    }

    #[test]
    fn foreground_list() {
        assert!(is_foreground("render.textRuns"));
        assert!(!is_foreground("render.serialize"));
        assert!(!is_foreground("render.fold"));
        assert!(!is_foreground("render.fonts"));
    }

    const FOLD_HTML: &str = "<body style=\"margin:0\"><p>Hello world</p><div data-mv-fold-toggle=\"q0\" data-mv-noselect data-mv-label-open=\"open\" data-mv-label-closed=\"closed\" style=\"display:inline-block\">closed</div><blockquote data-mv-fold=\"q0\" data-mv-fold-kind=\"quote\" data-mv-fold-open=\"false\" style=\"display:none\">Q</blockquote>";

    #[tokio::test]
    async fn text_runs_serialize_fold_round_trip() {
        let h = host();
        let opened = h.open(json!({"html": FOLD_HTML, "cssWidth": 300, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let runs = h.text_runs(doc, 0).await.unwrap();
        let r0 = &runs["runs"][0];
        assert_eq!(r0["text"], "Hello world");
        let s = json!({"node": r0["node"], "offset": 6});
        let e = json!({"node": r0["node"], "offset": 11});
        assert_eq!(h.serialize(doc, s, e).await.unwrap()["text"], "world");
        let f = h.fold(doc, "q0", true).await.unwrap();
        assert_eq!(f["meta"]["folds"][0]["open"], true);
    }

    #[tokio::test]
    async fn a_hit_reply_carries_the_fold_through_unchanged() {
        let h = host();
        let html = "<body style=\"margin:0\"><p style=\"margin:0;height:40px\">top</p><div data-mv-fold-toggle=\"q0\" data-mv-noselect data-mv-label-open=\"open\" data-mv-label-closed=\"closed\" style=\"display:inline-block;height:20px;width:60px\">closed</div><blockquote data-mv-fold=\"q0\" data-mv-fold-kind=\"quote\" data-mv-fold-open=\"false\" style=\"display:none\">Q</blockquote>";
        let opened = h.open(json!({"html": html, "cssWidth": 300, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let on = h.hit(doc, 10.0, 50.0).await.unwrap();
        assert_eq!(on["fold"], "q0", "fold id passes through hit");
        let off = h.hit(doc, 10.0, 10.0).await.unwrap();
        assert!(off["fold"].is_null() && off["link"].is_null());
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn fonts_are_replayed_into_a_respawned_worker() {
        let h = host();
        let face = base64::engine::general_purpose::STANDARD.encode(std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/assets/fonts/ibm-plex-mono-latin-400.woff2")).unwrap());
        h.register_fonts(vec![json!({"family": "MV Mono", "faces": [{"data": face, "weight": 400, "style": "normal"}]})]).await;
        // Crash the worker (debug sentinel), then open a doc in the font on the fresh one.
        let _ = h.open(json!({"html": PANIC_SENTINEL, "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await;
        let o = h.open(json!({"html": "<body style=\"margin:0\"><p style=\"margin:0;font:20px/30px 'MV Mono'\">abcdefghij</p>", "cssWidth": 300, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let runs = h.text_runs(o["docId"].as_u64().unwrap(), 0).await.unwrap();
        assert!((runs["runs"][0]["w"].as_f64().unwrap() - 120.0).abs() < 0.5, "replayed font in use");
        assert_eq!(h.spawned(), 2);
    }

    fn family(name: &str, faces: usize) -> Value {
        json!({"family": name, "faces": (0..faces).map(|i| json!({"data": format!("{name}{i}"), "weight": 400 + 100 * i, "style": "normal"})).collect::<Vec<_>>()})
    }

    #[test]
    fn overlapping_font_calls_send_each_family_once_and_whole() {
        let mut kept = FontFrames::default();
        let first = kept.claim(vec![family("A", 3), family("B", 2)]);
        assert_eq!(first.len(), 2);
        // The second call names B again (with a partial set of faces) and a new C.
        let second = kept.claim(vec![family("B", 1), family("C", 4), family("C", 1)]);
        assert_eq!(second, vec![family("C", 4)], "B is known, so its later faces never reach the worker; C once");
        assert!(kept.has("B") && !kept.has("D"));
        // Replay is one frame holding every family exactly as first sent.
        let replay = kept.replay().expect("replay frame");
        assert_eq!(replay["op"], "fonts");
        assert_eq!(replay["families"], json!([family("A", 3), family("B", 2), family("C", 4)]));
        assert!(FontFrames::default().replay().is_none());
    }

    #[test]
    fn a_family_the_worker_died_on_or_panicked_on_is_dropped_and_never_sent_again() {
        let mut kept = FontFrames::default();
        kept.claim(vec![family("A", 1), family("BAD", 1), family("C", 1)]);
        kept.begin(1);
        kept.ack(1, "A", true);
        // The worker died before it acknowledged BAD: it took them in order, so BAD is the one.
        kept.died(1);
        assert_eq!(kept.replay().unwrap()["families"], json!([family("A", 1), family("C", 1)]), "only the first owed ack is blamed");
        assert!(kept.has("BAD"), "refused counts as handled: nothing re-sends it");
        assert!(kept.claim(vec![family("BAD", 1)]).is_empty());

        // A caught panic is reported by its ack, and blames only that family.
        let mut kept = FontFrames::default();
        kept.claim(vec![family("A", 1), family("P", 1)]);
        kept.begin(3);
        kept.ack(3, "A", true);
        kept.ack(3, "P", false);
        assert_eq!(kept.replay().unwrap()["families"], json!([family("A", 1)]));
        kept.died(3);
        assert_eq!(kept.replay().unwrap()["families"], json!([family("A", 1)]), "everything was acknowledged, so a later death blames nobody");

        // A worker that is already replaced neither acknowledges nor dies for the new one.
        kept.begin(4);
        kept.ack(3, "A", false);
        kept.died(3);
        assert_eq!(kept.replay().unwrap()["families"], json!([family("A", 1)]));
    }

    #[test]
    fn a_death_is_blamed_on_the_replay_never_on_a_family_sent_to_the_live_worker() {
        let mut kept = FontFrames::default();
        kept.claim(vec![family("A", 1)]);
        kept.begin(1);
        kept.ack(1, "A", true);
        // B goes to the live worker, which dies of something else before it reads B.
        assert_eq!(kept.claim(vec![family("B", 1)]).len(), 1);
        kept.died(1);
        assert_eq!(kept.replay().unwrap()["families"], json!([family("A", 1), family("B", 1)]), "B is replayed to the next worker");
        assert!(!kept.refused.iter().any(|r| r == "B"));
        // A live family whose registration panics is refused by its own ack.
        kept.begin(2);
        kept.ack(2, "A", true);
        kept.ack(2, "B", false);
        assert_eq!(kept.replay().unwrap()["families"], json!([family("A", 1)]));
        assert!(kept.has("B"));
    }

    #[cfg(debug_assertions)]
    fn mono_face() -> Value {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/assets/fonts/ibm-plex-mono-latin-400.woff2")).unwrap();
        json!({"data": base64::engine::general_purpose::STANDARD.encode(bytes), "weight": 400, "style": "normal"})
    }

    #[cfg(any(debug_assertions, unix))]
    async fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..200 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("never: {what}");
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_family_that_kills_the_worker_during_replay_is_not_replayed_into_the_next_one() {
        use mailvault_render::fonts::ABORT_FAMILY;
        let h = host();
        let fam = |name: &str| json!({"family": name, "faces": [mono_face()]});
        h.register_fonts(vec![fam("MV Mono"), fam(ABORT_FAMILY), fam("MV Other")]).await;
        // The first worker aborts while it registers the bad family from the replay.
        let err = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap_err();
        assert_eq!(err, "render_unavailable");
        // The next one is replayed what is left, and lives.
        let ok = h.open(json!({"html": "<body style=\"margin:0\"><p style=\"margin:0;font:20px/30px 'MV Mono'\">abcdefghij</p>", "cssWidth": 300, "scale": 1.0, "allowRemote": false})).await.unwrap();
        assert_eq!(h.spawned(), 2, "one crash, not a crash per spawn");
        let runs = h.text_runs(ok["docId"].as_u64().unwrap(), 0).await.unwrap();
        assert!((runs["runs"][0]["w"].as_f64().unwrap() - 120.0).abs() < 0.5, "the family before the bad one is in use");
        let kept = h.font_frames.lock().unwrap().replay().unwrap();
        let names: Vec<&str> = kept["families"].as_array().unwrap().iter().filter_map(|f| f["family"].as_str()).collect();
        assert_eq!(names, ["MV Mono", "MV Other"], "only the bad family is dropped");
        assert!(h.has_font(ABORT_FAMILY), "and it is not asked for again");
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_family_that_panics_the_live_worker_is_skipped_and_dropped_without_a_respawn() {
        use mailvault_render::fonts::PANIC_FAMILY;
        let h = host();
        let opened = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let fam = |name: &str| json!({"family": name, "faces": [mono_face()]});
        h.register_fonts(vec![fam(PANIC_FAMILY), fam("MV Mono")]).await;
        wait_until("the bad family is dropped", || {
            let kept = h.font_frames.lock().unwrap().replay().unwrap();
            kept["families"].as_array().unwrap().len() == 1
        })
        .await;
        assert!(h.tile(doc, 0).await.is_ok(), "the worker and its doc are untouched");
        assert_eq!(h.spawned(), 1);
    }

    /// A shell stand-in for the render worker, on the real wire protocol: it logs
    /// every line it reads, answers each request with an empty ok, and, like the
    /// real worker, acknowledges each family of a `fonts` frame in the order given
    /// (`{"kind":"font","family","ok":true}`). `dies_on` names a family it exits on
    /// when it reaches it, before acknowledging it. Returns the host and the log.
    #[cfg(unix)]
    fn fake_worker(dir: &std::path::Path, dies_on: &str) -> (Arc<RenderHost>, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("frames.log");
        let script = dir.join("fake-worker.sh");
        std::fs::write(&script, format!(
            "#!/bin/sh\n\
             while IFS= read -r l; do\n\
             printf '%s\\n' \"$l\" >> '{log}'\n\
             case \"$l\" in\n\
             *'\"op\":\"fonts\"'*)\n\
             for f in $(printf '%s\\n' \"$l\" | grep -o '\"family\":\"[^\"]*\"' | sed 's/\"family\"://'); do\n\
             [ \"$f\" = '\"{dies_on}\"' ] && exit 0\n\
             printf '{{\"kind\":\"font\",\"family\":%s,\"ok\":true}}\\n' \"$f\"\n\
             done;;\n\
             *'\"req\":'*) r=${{l#*'\"req\":'}}; r=${{r%%[,\\}}]*}}; printf '{{\"kind\":\"reply\",\"req\":%s,\"ok\":{{}}}}\\n' \"$r\";;\n\
             esac\n\
             done\n",
            log = log.display(),
        )).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (Arc::new(RenderHost::new(crate::events::EventBus::new(16), WorkerCommand::exe(&script))), log)
    }

    /// The frames the fake worker has read so far.
    #[cfg(unix)]
    fn frames_read(log: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(log).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    #[cfg(unix)]
    async fn wait_for_frames(log: &std::path::Path, n: usize) {
        for _ in 0..200 {
            if frames_read(log).len() >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("only {} of {n} frames: {:?}", frames_read(log).len(), frames_read(log));
    }

    /// A worker is a process: on a loaded box (the whole daemon suite runs beside
    /// this) its start can take seconds, and a call's own deadline (4 s for a
    /// fold) would then fail it with `render_unavailable` before the worker has
    /// read a line. These tests are about the frames, not the deadlines, so
    /// their calls wait as long as the box needs.
    #[cfg(unix)]
    async fn call_patiently(h: &RenderHost, frame: Value) -> Result<Value, String> {
        h.call(frame, Duration::from_secs(120)).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn font_frames_reach_the_wire_whole_and_replay_after_a_respawn() {
        let dir = tempfile::tempdir().unwrap();
        let (h, log) = fake_worker(dir.path(), "");
        let fold = |open: bool| call_patiently(&h, json!({"op": "fold", "doc": 7, "id": "q0", "open": open}));

        // No worker yet: nothing is written, the families are only kept.
        h.register_fonts(vec![family("A", 3), family("B", 2)]).await;
        assert!(frames_read(&log).is_empty());
        // The first call spawns the worker, which reads the replay before the call's own frame.
        fold(true).await.unwrap();
        wait_for_frames(&log, 2).await;
        let f = frames_read(&log);
        assert_eq!(f[0]["op"], "fonts");
        assert_eq!(f[0]["families"], json!([family("A", 3), family("B", 2)]), "complete families in one frame");
        assert_eq!(f[1]["op"], "fold");

        // A later call overlapping B only sends the family that is new.
        h.register_fonts(vec![family("B", 1), family("C", 4)]).await;
        wait_for_frames(&log, 3).await;
        assert_eq!(frames_read(&log)[2]["families"], json!([family("C", 4)]));

        // The worker acknowledged every family it was given, so nobody is to blame
        // when it goes: the respawned one is sent all three, whole, before its first request.
        wait_until("the live worker acknowledged the replay", || h.font_frames.lock().unwrap().unacked.is_empty()).await;
        h.kill_epoch(h.spawned()).await;
        fold(false).await.unwrap();
        wait_for_frames(&log, 5).await;
        let f = frames_read(&log);
        assert_eq!(f[3]["families"], json!([family("A", 3), family("B", 2), family("C", 4)]));
        assert_eq!(f[4]["op"], "fold");
        assert_eq!(h.spawned(), 2);
        assert!(h.font_frames.lock().unwrap().refused.is_empty(), "no family was refused");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_worker_that_dies_before_acknowledging_a_replayed_family_is_blamed_for_that_family() {
        let dir = tempfile::tempdir().unwrap();
        let (h, log) = fake_worker(dir.path(), "BAD");
        h.register_fonts(vec![family("A", 1), family("BAD", 1), family("C", 1)]).await;

        // The worker acknowledges A, then exits on BAD without acknowledging it.
        let err = call_patiently(&h, json!({"op": "fold", "doc": 7, "id": "q0", "open": true})).await.unwrap_err();
        assert_eq!(err, "render_unavailable");
        // The death is blamed when the host reads the worker's EOF; a call that fails
        // on the closed pipe can come first, so wait for the verdict before the next spawn.
        wait_until("BAD is refused", || h.font_frames.lock().unwrap().refused == ["BAD"]).await;

        // The next worker is replayed what is left and lives; BAD is never sent again.
        call_patiently(&h, json!({"op": "fold", "doc": 7, "id": "q0", "open": false})).await.unwrap();
        wait_for_frames(&log, 3).await;
        let f = frames_read(&log);
        assert_eq!(f[0]["families"], json!([family("A", 1), family("BAD", 1), family("C", 1)]), "the first worker got all three");
        assert_eq!(f[1]["families"], json!([family("A", 1), family("C", 1)]), "the second only what is not refused");
        assert_eq!(f[2]["op"], "fold");
        assert_eq!(h.spawned(), 2, "one death, not one per spawn");
        assert!(h.has_font("BAD") && h.font_frames.lock().unwrap().claim(vec![family("BAD", 1)]).is_empty(), "and it is not asked for again");
    }

    #[test]
    fn inspect_is_not_foreground_and_has_its_own_timeout() {
        assert!(!is_foreground("render.inspect"), "harness traffic must not pause the search index");
        assert!(is_foreground("render.open"));
        assert_eq!(INSPECT_TIMEOUT, Duration::from_secs(4));
        // The shell gives render.inspect 6 s (blitz_tiles::reply_timeout): the daemon must answer first.
        assert!(INSPECT_TIMEOUT < Duration::from_secs(6));
    }

    #[tokio::test]
    async fn inspect_reports_marked_elements_and_unknown_docs() {
        let h = host();
        let html = "<body style=\"margin:0\"><p data-mv-id=\"a\" style=\"margin:0;height:20px\">x</p></body>";
        let opened = h.open(json!({"html": html, "cssWidth": 300, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let got = h.inspect(doc).await.unwrap();
        let els = got["elements"].as_array().expect("elements array");
        assert!(els.iter().any(|e| e["mvId"] == "a" && e["tag"] == "p"), "{got}");
        h.close(doc).await;
        assert_eq!(h.inspect(doc).await.unwrap_err(), "render_unknown_doc");
    }

    #[test]
    fn image_is_not_foreground_and_the_daemon_answers_before_the_shell() {
        assert!(!is_foreground("render.image"));
        // The shell gives render.image 30 s (blitz_tiles::reply_timeout).
        assert!(IMAGE_SETTLE + IMAGE_TIMEOUT < Duration::from_secs(30));
    }

    #[tokio::test]
    async fn image_is_a_png_of_the_whole_doc_and_unknown_docs_are_refused() {
        let h = host();
        let opened = h.open(json!({"html": "<body style=\"margin:0\"><div style=\"height:700px;background:#f00\"></div></body>", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        let got = h.image(doc).await.unwrap();
        let png = base64::engine::general_purpose::STANDARD.decode(got["png"].as_str().unwrap()).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 100);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 700);
        h.close(doc).await;
        assert_eq!(h.image(doc).await.unwrap_err(), "render_unknown_doc");
    }

    #[tokio::test]
    async fn image_waits_for_the_docs_fetches_but_not_for_other_docs() {
        let h = host();
        let opened = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        h.inflight.begin(doc + 1000); // another doc: ignored
        h.inflight.begin(doc);
        let (inflight, t0) = (h.inflight.clone(), Instant::now());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            inflight.end(doc);
        });
        assert!(h.image(doc).await.is_ok());
        assert!(t0.elapsed() >= Duration::from_millis(280), "waited for the fetch: {:?}", t0.elapsed());
        assert!(t0.elapsed() < IMAGE_SETTLE, "but not for doc {}'s fetch or the cap: {:?}", doc + 1000, t0.elapsed());
    }

    #[tokio::test]
    async fn settle_waits_for_the_docs_fetches_and_paints_nothing() {
        let h = host();
        let opened = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap();
        let doc = opened["docId"].as_u64().unwrap();
        h.inflight.begin(doc);
        let (inflight, t0) = (h.inflight.clone(), Instant::now());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            inflight.end(doc);
        });
        let got = h.settle(doc).await.unwrap();
        assert_eq!(got["settled"], json!(true));
        assert!(got["meta"]["cssHeight"].is_number() && got["rev"].is_number(), "the doc's current meta: {got}");
        assert!(got.get("png").is_none());
        assert!(t0.elapsed() >= Duration::from_millis(280), "waited for the fetch: {:?}", t0.elapsed());
        h.close(doc).await;
        assert_eq!(h.settle(doc).await.unwrap_err(), "render_unknown_doc");
    }

    #[tokio::test]
    async fn an_evicted_doc_answers_unknown_without_waiting_for_its_fetches() {
        let h = host();
        let ids = open_n(&h, MAX_OPEN_DOCS + 1).await;
        h.inflight.begin(ids[0]);
        let t0 = Instant::now();
        assert_eq!(h.image(ids[0]).await.unwrap_err(), "render_unknown_doc");
        assert!(t0.elapsed() < IMAGE_SETTLE, "{:?}", t0.elapsed());
        h.inflight.end(ids[0]);
    }

    /// Opens `n` tiny docs, returns their ids in open order.
    async fn open_n(h: &Arc<RenderHost>, n: usize) -> Vec<u64> {
        let mut ids = Vec::new();
        for _ in 0..n {
            let r = h.open(json!({"html": "<p>x", "cssWidth": 100, "scale": 1.0, "allowRemote": false})).await.unwrap();
            ids.push(r["docId"].as_u64().unwrap());
        }
        ids
    }

    #[tokio::test]
    async fn the_open_past_the_cap_evicts_the_least_recently_used_doc() {
        let h = host();
        let ids = open_n(&h, MAX_OPEN_DOCS + 1).await;
        assert_eq!(h.open_docs.lock().unwrap().len(), MAX_OPEN_DOCS);
        assert_eq!(h.tile(ids[0], 0).await.unwrap_err(), "render_unknown_doc", "the first-opened, never-touched doc is the victim");
        assert!(h.tile(ids[1], 0).await.is_ok(), "the rest are untouched");
        assert!(h.tile(ids[MAX_OPEN_DOCS], 0).await.is_ok());
    }

    #[tokio::test]
    async fn touching_a_doc_spares_it_and_the_next_oldest_goes() {
        let h = host();
        let ids = open_n(&h, MAX_OPEN_DOCS).await;
        assert!(h.tile(ids[0], 0).await.is_ok());
        let extra = open_n(&h, 1).await;
        assert_eq!(h.open_docs.lock().unwrap().len(), MAX_OPEN_DOCS);
        assert!(h.tile(ids[0], 0).await.is_ok(), "doc 0 was touched, so it stays");
        assert_eq!(h.tile(ids[1], 0).await.unwrap_err(), "render_unknown_doc", "doc 1 is now the oldest");
        assert!(h.tile(extra[0], 0).await.is_ok(), "the open that evicted returns its own doc normally");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn every_op_on_a_doc_touches_it_and_eviction_sends_one_close_per_victim() {
        let dir = tempfile::tempdir().unwrap();
        let (h, log) = fake_worker(dir.path(), "");
        let ids = open_n(&h, MAX_OPEN_DOCS).await;
        // Touch the oldest docs, one op each; the fake worker answers every request with an empty ok.
        h.tile(ids[0], 0).await.unwrap();
        h.hit(ids[1], 0.0, 0.0).await.unwrap();
        h.text_runs(ids[2], 0).await.unwrap();
        h.serialize(ids[3], json!({}), json!({})).await.unwrap();
        h.fold(ids[4], "q0", true).await.unwrap();
        h.inspect(ids[5]).await.unwrap();
        let extra = open_n(&h, 6).await;
        assert_eq!(h.open_docs.lock().unwrap().len(), MAX_OPEN_DOCS);
        let docs: Vec<u64> = h.open_docs.lock().unwrap().keys().copied().collect();
        for id in &ids[..6] { assert!(docs.contains(id), "doc {id} was touched"); }
        for id in &ids[6..12] { assert!(!docs.contains(id), "doc {id} was the oldest untouched"); }
        for id in &extra { assert!(docs.contains(id)); }
        // 32 + 6 opens, 6 touches, 6 closes.
        wait_for_frames(&log, MAX_OPEN_DOCS + 6 + 6 + 6).await;
        let closed: Vec<u64> = frames_read(&log).iter().filter(|f| f["op"] == "close").map(|f| f["doc"].as_u64().unwrap()).collect();
        assert_eq!(closed, ids[6..12].to_vec(), "one close frame per victim, oldest first");
    }

    #[test]
    fn victims_are_the_oldest_stamps_ties_by_id_and_never_the_kept_doc() {
        let t0 = Instant::now();
        let mut docs: HashMap<u64, Instant> = (1..=MAX_OPEN_DOCS as u64 + 2).map(|d| (d, t0)).collect();
        // The kept doc is the oldest stamp of all; it must still survive.
        docs.insert(1, t0 - Duration::from_secs(5));
        assert_eq!(RenderHost::lru_victims(&mut docs, 1), vec![2, 3], "equal stamps go by id");
        assert_eq!(docs.len(), MAX_OPEN_DOCS);
        assert!(docs.contains_key(&1));
        assert!(RenderHost::lru_victims(&mut docs, 1).is_empty(), "at the cap nothing goes");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_reaper_leaves_a_worker_with_open_docs_and_ends_an_idle_one() {
        let dir = tempfile::tempdir().unwrap();
        let (h, _log) = fake_worker(dir.path(), "");
        let doc = open_n(&h, 1).await[0];
        let long_ago = || Instant::now() - IDLE_EXIT - Duration::from_secs(1);
        *h.last_used.lock().unwrap() = long_ago();
        h.reap_idle().await;
        assert!(h.worker.lock().await.is_some(), "an open doc keeps the worker");
        h.close(doc).await;
        *h.last_used.lock().unwrap() = long_ago();
        h.reap_idle().await;
        assert!(h.worker.lock().await.is_none(), "no open docs and idle: reaped");
    }
}

#[cfg(test)]
mod pool_tests {
    use super::tests::daemon_exe;
    use super::*;
    use serde_json::json;

    fn pool() -> RenderPool {
        RenderPool::new(|| RenderHost::new(crate::events::EventBus::new(16), WorkerCommand::exe(daemon_exe())))
    }

    fn open_p(html: &str) -> Value {
        json!({"html": html, "cssWidth": 200, "scale": 1.0, "allowRemote": false})
    }

    const P: &str = "<body style=\"margin:0\"><p>x</p></body>";

    async fn open_doc(pool: &RenderPool, html: &str) -> u64 {
        pool.open(open_p(html)).await.unwrap()["docId"].as_u64().unwrap()
    }

    #[test]
    fn docs_pin_to_one_worker_by_id() {
        assert_eq!(WORKERS, 2);
        assert_eq!((worker_for(1, 2), worker_for(2, 2), worker_for(3, 2)), (1, 0, 1));
        for doc in 0..50u64 {
            assert_eq!(worker_for(doc, 1), 0);
        }
        assert_eq!(worker_for(7, 0), 0, "zero workers never divides by zero");
    }

    #[tokio::test]
    async fn every_op_for_a_doc_goes_to_the_worker_that_opened_it() {
        let pool = pool();
        let a = open_doc(&pool, P).await;
        let b = open_doc(&pool, P).await;
        assert_ne!(worker_for(a, WORKERS), worker_for(b, WORKERS), "consecutive docs land on different workers");
        assert!(pool.for_doc(a).tile(a, 0).await.is_ok());
        assert!(pool.for_doc(b).tile(b, 0).await.is_ok());
        // The other worker never saw doc a.
        let other = &pool.hosts[1 - worker_for(a, WORKERS)];
        assert_eq!(other.tile(a, 0).await.unwrap_err(), "render_unknown_doc");
        assert_eq!(pool.hosts.iter().map(|h| h.spawned()).sum::<u64>(), 2, "one process per worker");
        pool.for_doc(a).close(a).await;
        assert_eq!(pool.for_doc(a).tile(a, 0).await.unwrap_err(), "render_unknown_doc");
        assert!(pool.for_doc(b).tile(b, 0).await.is_ok(), "closing a leaves b");
    }

    #[tokio::test]
    async fn doc_ids_start_at_a_boot_seed_never_at_one() {
        // The webview caches tiles by docId for its whole life: a daemon boot must not reuse small ids.
        let (p, q) = (pool(), pool());
        let (a, b) = (p.next_doc.load(Ordering::Relaxed), q.next_doc.load(Ordering::Relaxed));
        assert_ne!(a, b, "two pools do not share a first id");
        assert!(a > 1 << 20 || b > 1 << 20, "the seed is a random slot of the id space, not 1");
        assert!(a < 1u64 << 53 && b < 1u64 << 53);
    }

    #[tokio::test]
    async fn the_doc_cap_is_per_worker_not_per_pool() {
        let pool = pool();
        let n = MAX_OPEN_DOCS + 8; // more than one worker may hold, within what two may
        let mut ids = Vec::new();
        for _ in 0..n {
            ids.push(open_doc(&pool, "<p>x").await);
        }
        for h in &pool.hosts {
            assert!(h.open_docs.lock().unwrap().len() <= MAX_OPEN_DOCS);
        }
        for id in ids {
            assert!(pool.for_doc(id).tile(id, 0).await.is_ok(), "doc {id} was not evicted: each worker holds {} of {n}", n / WORKERS);
        }
    }

    #[tokio::test]
    async fn fonts_register_on_every_worker() {
        let pool = pool();
        let fam = json!({"family": "Lora", "faces": []});
        pool.register_fonts(vec![fam]).await;
        assert!(pool.hosts.iter().all(|h| h.has_font("Lora")), "each worker keeps its own registry");
        assert!(pool.has_font("Lora"));
        assert!(!pool.has_font("Roboto"));
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_crash_in_one_worker_leaves_the_other_docs_alive() {
        let pool = pool();
        let a = open_doc(&pool, P).await;
        // The next id lands on the other worker; it panics (debug sentinel) and dies alone.
        let err = pool.open(open_p(PANIC_SENTINEL)).await.unwrap_err();
        assert_eq!(err, "render_unavailable");
        assert!(pool.for_doc(a).tile(a, 0).await.is_ok(), "doc a lives on the healthy worker");
        assert_eq!(pool.for_doc(a).spawned(), 1, "the healthy worker was not respawned");
    }

    #[tokio::test]
    async fn reap_idle_ends_every_idle_worker() {
        let pool = pool();
        let a = open_doc(&pool, P).await;
        let b = open_doc(&pool, P).await;
        pool.for_doc(a).close(a).await;
        pool.for_doc(b).close(b).await;
        let long_ago = Instant::now() - IDLE_EXIT - Duration::from_secs(1);
        for h in &pool.hosts {
            *h.last_used.lock().unwrap() = long_ago;
        }
        pool.reap_idle().await;
        for h in &pool.hosts {
            assert!(h.worker.lock().await.is_none(), "both workers are reaped");
        }
    }
}
