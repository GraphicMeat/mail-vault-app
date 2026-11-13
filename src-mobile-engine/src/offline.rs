//! Full offline: every message inside an account's offline window is on the phone, headers and
//! bodies, in every selectable folder, plus its attachments up to [`ATTACHMENT_PREFETCH_MAX`] each.
//!
//! The window (`acct.<accountId>.offlineWindow` in `settings`, one of [`WINDOWS`], missing `3m`) is
//! the account's choice, made in Settings > Offline (`mobile.offline.set`) or carried over by an
//! import from the computer. `all` needs Premium: without it the window behaves as `3m` at run
//! time, but the stored value is left alone. Two bounds come out of it ([`bounds`]):
//! - `fetch_from`: what sync lists and downloads (the effective window);
//! - `keep_from`: what sync keeps (the stored window: `all` keeps everything). A Premium lapse
//!   therefore never deletes what is on the phone; the user shrinking the window does.
//!
//! Network gating: the shell reports the OS's view ([`Engine::set_network`], `mobile.network.state`).
//! A constrained network (iOS Low Data Mode, Android data saver on a metered network) stops every
//! download. Headers and bodies go over any other network; attachments only over an unmetered one.
//! Until the shell has said anything, headers and bodies go and attachments wait.
//!
//! Downloads run on the sync worker as download passes (`sync.rs` `download_pass`): a background
//! run's (`background.rs`), and while the app is in front, the foreground downloader's
//! ([`Downloader`]): a thread that queues one short pass per account at a time while work is left,
//! and gives way at once to any pass the page asks for (the pass stops at its next chunk or body
//! when one is waiting).

use crate::db::{lock, Engine, EngineError, Shared};
use crate::rpc::{parse, RpcError};
use crate::sync::{Ended, Worker};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const DAY_MS: i64 = 86_400_000;
/// The window of an account that has none stored.
pub(crate) const DEFAULT_WINDOW: &str = "3m";
/// Every window the setting takes; `all` is Premium's.
pub(crate) const WINDOWS: [&str; 5] = ["1m", "3m", "6m", "12m", "all"];
/// Attachments up to this size are downloaded ahead of a tap (inside the window, unmetered).
pub(crate) const ATTACHMENT_PREFETCH_MAX: u64 = 10 * 1024 * 1024;
/// How long one foreground download pass runs before it hands the worker back.
const FRONT_SLICE: Duration = Duration::from_secs(20);
/// How long the foreground downloader sleeps when a round made no progress (the network is
/// failing, every message left is waiting for a retry).
const STALLED_WAIT: Duration = Duration::from_secs(60);
/// How long it sleeps with nothing to do before it looks again (new mail the page did not see).
const IDLE_WAIT: Duration = Duration::from_secs(5 * 60);
/// The first wait before a body that could not be kept is asked for again; it doubles per
/// attempt up to [`RETRY_MAX_MS`].
pub(crate) const RETRY_BASE_MS: i64 = 15 * 60 * 1000;
pub(crate) const RETRY_MAX_MS: i64 = DAY_MS;

/// The settings key of `account`'s window.
pub(crate) fn window_key(account: &str) -> String {
    format!("acct.{account}.offlineWindow")
}

fn days_of(window: &str) -> Option<i64> {
    match window {
        "1m" => Some(30),
        "3m" => Some(90),
        "6m" => Some(180),
        "12m" => Some(365),
        _ => None,
    }
}

/// The stored window of `account`; anything that is not one of [`WINDOWS`] reads as the default.
pub(crate) fn stored_window(c: &Connection, account: &str) -> rusqlite::Result<String> {
    let v: Option<Option<String>> = c.query_row("SELECT value FROM settings WHERE key = ?1", [window_key(account)], |r| r.get(0)).optional()?;
    Ok(v.flatten().filter(|w| WINDOWS.contains(&w.as_str())).unwrap_or_else(|| DEFAULT_WINDOW.to_string()))
}

/// The first instant of the day `days` days before the day `now` falls on (UTC).
pub(crate) fn day_start(now: i64, days: i64) -> i64 {
    (now.div_euclid(DAY_MS) - days) * DAY_MS
}

/// What sync lists and downloads (`fetch_from`) and what it keeps (`keep_from`), epoch ms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Bounds {
    pub(crate) fetch_from: i64,
    pub(crate) keep_from: i64,
}

/// The bounds of `window` with Premium on or off, on the day of `now`.
pub(crate) fn bounds_for(window: &str, premium: bool, now: i64) -> Bounds {
    match days_of(window) {
        Some(d) => {
            let s = day_start(now, d);
            Bounds { fetch_from: s, keep_from: s }
        }
        // `all`: everything with Premium; without it, 3 months fetched and everything kept.
        None if window == "all" => Bounds { fetch_from: if premium { 0 } else { day_start(now, 90) }, keep_from: 0 },
        None => {
            let s = crate::sync::window_start_ms(now);
            Bounds { fetch_from: s, keep_from: s }
        }
    }
}

/// `account`'s bounds now. A read failure counts as the default window.
pub(crate) fn bounds(shared: &Shared, account: &str, now: i64) -> Bounds {
    let w = shared.read(|c| stored_window(c, account)).unwrap_or_else(|_| DEFAULT_WINDOW.to_string());
    bounds_for(&w, crate::premium::active(shared), now)
}

// ── Engine state ────────────────────────────────────────────────────────────

/// The offline state in [`Shared`]: the network as the shell last reported it, where offline
/// attachments live, and the foreground downloader's wake-up.
pub(crate) struct State {
    constrained: AtomicBool,
    /// Metered (cellular, a hotspot) or not known yet: attachments wait.
    metered: AtomicBool,
    data_dir: OnceLock<PathBuf>,
    /// Page passes (not downloads) waiting on the sync worker: a download pass in front gives way.
    pub(crate) page_waiting: AtomicUsize,
    wake: Mutex<u64>,
    cv: Condvar,
    /// Attachments a download could not fetch: `(account, folder, uid, section)` -> when to try
    /// again. In memory: a failed attachment costs a try per engine at worst.
    att_retry: Mutex<std::collections::HashMap<(String, String, u32, String), (u32, Instant)>>,
    /// Tests: the foreground downloader stays idle (suites that count a page's commands).
    front_off: AtomicBool,
}

impl Default for State {
    fn default() -> Self {
        State {
            constrained: AtomicBool::new(false),
            metered: AtomicBool::new(true),
            data_dir: OnceLock::new(),
            page_waiting: AtomicUsize::new(0),
            wake: Mutex::new(0),
            cv: Condvar::new(),
            att_retry: Mutex::new(Default::default()),
            front_off: AtomicBool::new(false),
        }
    }
}

impl State {
    pub(crate) fn set_data_dir(&self, dir: &Path) {
        let _ = self.data_dir.set(dir.to_path_buf());
    }
}

/// Headers and bodies may download: the network is not constrained.
pub(crate) fn downloads_allowed(shared: &Shared) -> bool {
    !shared.offline.constrained.load(Ordering::SeqCst)
}

/// Attachments may download: not constrained and not metered.
pub(crate) fn attachments_allowed(shared: &Shared) -> bool {
    downloads_allowed(shared) && !shared.offline.metered.load(Ordering::SeqCst)
}

/// Wakes the foreground downloader (it looks for work at once).
pub(crate) fn wake(shared: &Shared) {
    let mut g = lock(&shared.offline.wake);
    *g = g.wrapping_add(1);
    shared.offline.cv.notify_all();
}

/// Where `account`'s offline attachments live: `<data_dir>/offline/att/<account hash>`. Outside
/// the OS cache dir (never purged), and excluded from the iOS backup by the shell.
pub(crate) fn attachments_dir(shared: &Shared, account: &str) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    let base = shared.offline.data_dir.get()?;
    let hash: String = Sha256::digest(account.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    Some(base.join("offline").join("att").join(hash))
}

/// Drops `account`'s offline files (the account is being removed).
pub(crate) fn forget_account(shared: &Shared, account: &str) {
    if let Some(dir) = attachments_dir(shared, account) {
        let _ = std::fs::remove_dir_all(dir);
    }
    lock(&shared.offline.att_retry).retain(|k, _| k.0 != account);
}

/// An attachment a download should not ask for yet.
pub(crate) fn attachment_waits(shared: &Shared, key: &(String, String, u32, String)) -> bool {
    lock(&shared.offline.att_retry).get(key).is_some_and(|(_, at)| *at > Instant::now())
}

/// An attachment download failed: wait before the next try, longer each time.
pub(crate) fn attachment_failed(shared: &Shared, key: (String, String, u32, String)) {
    let mut m = lock(&shared.offline.att_retry);
    let attempts = m.get(&key).map_or(0, |(a, _)| *a);
    let wait = retry_wait_ms(attempts);
    m.insert(key, (attempts + 1, Instant::now() + Duration::from_millis(wait as u64)));
}

/// The wait after `attempts` earlier failures.
pub(crate) fn retry_wait_ms(attempts: u32) -> i64 {
    RETRY_BASE_MS.saturating_mul(1i64 << attempts.min(20)).min(RETRY_MAX_MS)
}

/// A body a download could not keep: it waits before it is asked for again (`body_retry`).
pub(crate) fn body_failed(c: &Connection, account: &str, folder: &str, uid: u32, now: i64) -> rusqlite::Result<()> {
    let attempts: u32 = c
        .query_row("SELECT attempts FROM body_retry WHERE account_id = ?1 AND folder = ?2 AND uid = ?3", (account, folder, uid as i64), |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    c.execute(
        "INSERT INTO body_retry (account_id, folder, uid, attempts, next_ms) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (account_id, folder, uid) DO UPDATE SET attempts = excluded.attempts, next_ms = excluded.next_ms",
        (account, folder, uid as i64, attempts + 1, now + retry_wait_ms(attempts)),
    )?;
    Ok(())
}

// ── What is left ────────────────────────────────────────────────────────────

/// What a download still has to do for one account.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Left {
    /// Selectable folders whose full pass does not cover the window.
    pub(crate) folders: u64,
    /// Messages in the window without a body (not counting those waiting for a retry).
    pub(crate) bodies: u64,
}

impl Left {
    pub(crate) fn total(&self) -> u64 {
        self.folders + self.bodies
    }
}

/// SQL: a selectable folder of `?1` that needs its full pass for a window starting at `?2`.
pub(crate) const NEEDS_FULL: &str = "noselect = 0 AND (synced_ms IS NULL OR full_from_ms IS NULL OR full_from_ms > ?2)";

pub(crate) fn left(shared: &Shared, account: &str, now: i64) -> Result<Left, EngineError> {
    let b = bounds(shared, account, now);
    shared.read(|c| {
        let folders: i64 = c.query_row(&format!("SELECT count(*) FROM folders WHERE account_id = ?1 AND {NEEDS_FULL}"), (account, b.fetch_from), |r| r.get(0))?;
        let bodies: i64 = c.query_row(
            "SELECT count(*) FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
             WHERE m.account_id = ?1 AND m.date_ms >= ?2 AND m.out_of_window_ms IS NULL AND m.local_deleted IS NULL AND f.noselect = 0
               AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.account_id = m.account_id AND b.folder = m.folder AND b.uid = m.uid)
               AND NOT EXISTS (SELECT 1 FROM body_retry r WHERE r.account_id = m.account_id AND r.folder = m.folder AND r.uid = m.uid AND r.next_ms > ?3)",
            (account, b.fetch_from, now),
            |r| r.get(0),
        )?;
        Ok(Left { folders: folders.max(0) as u64, bodies: bodies.max(0) as u64 })
    })
}

/// Deletes `account`'s rows older than the window it keeps (a window the user shrank), with their
/// bodies and attachments; a row a journaled action names stays, as does one a server search
/// stored or the user opened in the last 30 days. Returns how many went.
pub(crate) fn prune_aged(shared: &Shared, account: &str, now: i64) -> Result<usize, crate::sync::Fail> {
    let b = bounds(shared, account, now);
    if b.keep_from <= 0 {
        return Ok(0);
    }
    let rows: Vec<(String, u32)> = shared.read(|c| {
        let mut st = c.prepare(
            "SELECT folder, uid FROM messages WHERE account_id = ?1 AND date_ms < ?2
               AND NOT (out_of_window_ms IS NOT NULL AND ?3 - out_of_window_ms <= ?4)",
        )?;
        let rows = st
            .query_map((account, b.keep_from, now, crate::sync::OUT_OF_WINDOW_KEEP_MS), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut by_folder: std::collections::BTreeMap<String, Vec<u32>> = Default::default();
    for (f, u) in rows {
        by_folder.entry(f).or_default().push(u);
    }
    let mut removed = 0;
    for (folder, uids) in by_folder {
        let n = crate::sync::delete_uids(shared, account, &folder, &uids, true)?;
        if n > 0 {
            removed += n;
            let gen = shared.list_gen(account, &folder)? + 1;
            let gen = shared.publish_list_gen(account, &folder, gen);
            shared.emit(
                crate::events::FOLDER_CHANGED,
                json!({ "accountId": account, "folder": folder, "added": 0, "removed": n, "updated": 0, "listGen": gen }),
            );
        }
    }
    Ok(removed)
}

// ── The foreground downloader ───────────────────────────────────────────────

/// The thread that downloads while the app is in front. Started by the first [`Engine::offline_wake`].
#[derive(Default)]
pub(crate) struct Downloader {
    started: AtomicBool,
}

impl Engine {
    /// Wakes the foreground downloader, starting its thread the first time.
    pub(crate) fn offline_wake(&self) {
        if !self.offline_downloader().started.swap(true, Ordering::SeqCst) {
            let (shared, worker) = (Arc::clone(self.shared()), self.sync_worker().clone());
            let spawned = std::thread::Builder::new().name("mv-engine-offline".into()).spawn(move || front_loop(shared, worker));
            if let Err(e) = spawned {
                self.shared().log(&format!("[offline] downloader thread: {e}"));
                self.offline_downloader().started.store(false, Ordering::SeqCst);
            }
        }
        wake(self.shared());
    }

    /// The network as the OS sees it: `constrained` (iOS Low Data Mode, Android data saver on a
    /// metered network) stops every download; `expensive` (cellular, a hotspot) holds back
    /// attachments only. Called by the shell on every change.
    pub fn set_network(&self, constrained: bool, expensive: bool) {
        let st = &self.shared().offline;
        let was = downloads_allowed(self.shared());
        st.constrained.store(constrained, Ordering::SeqCst);
        st.metered.store(expensive, Ordering::SeqCst);
        if !was && downloads_allowed(self.shared()) || !expensive {
            self.offline_wake();
        }
    }

    /// Tests: `false` keeps the foreground downloader idle, for suites that count what the page's
    /// own passes send.
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn set_front_downloads_for_tests(&self, on: bool) {
        self.shared().offline.front_off.store(!on, Ordering::SeqCst);
    }

    /// Some account has offline work left (folders to list, bodies to download): the shell asks
    /// the OS for runs as often as it allows while this holds.
    pub fn offline_pending(&self) -> bool {
        let now = crate::compose::now_ms();
        accounts(self.shared()).unwrap_or_default().iter().any(|a| left(self.shared(), a, now).is_ok_and(|l| l.total() > 0))
    }
}

/// The accounts a download may dial: not parked, no refused password.
fn accounts(shared: &Shared) -> Result<Vec<String>, EngineError> {
    shared.read(|c| {
        let mut st = c.prepare(&format!(
            "SELECT a.id FROM accounts a WHERE a.needs_auth = 0 AND {} ORDER BY a.created_ms, a.id",
            crate::hold::NOT_HELD_SQL.replace("{account}", "a.id")
        ))?;
        let rows = st.query_map([], |r| r.get(0))?.collect();
        rows
    })
}

fn in_front(shared: &Shared) -> bool {
    crate::background::is_in_front(shared)
}

/// Waits until woken or `max` passed; false when the engine is closing.
fn sleep(shared: &Shared, seen: &mut u64, max: Duration) -> bool {
    let until = Instant::now() + max;
    let mut g = lock(&shared.offline.wake);
    while *g == *seen && !shared.is_closing() {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        g = shared.offline.cv.wait_timeout(g, left).unwrap_or_else(|p| p.into_inner()).0;
    }
    *seen = *g;
    !shared.is_closing()
}

fn front_loop(shared: Arc<Shared>, worker: Worker) {
    crate::sync::background_qos();
    let mut seen = *lock(&shared.offline.wake);
    // Woken right after the spawn: look at once.
    seen = seen.wrapping_sub(1);
    let mut wait = Duration::ZERO;
    loop {
        if !sleep(&shared, &mut seen, wait) {
            return;
        }
        wait = IDLE_WAIT;
        if !in_front(&shared) || !downloads_allowed(&shared) || shared.offline.front_off.load(Ordering::SeqCst) {
            continue;
        }
        match front_round(&shared, &worker) {
            Round::Done => {}
            // Woken by nothing new, a round that moved nothing waits before it tries again.
            Round::Stalled => wait = STALLED_WAIT,
            Round::More => wait = Duration::ZERO,
            Round::Closing => return,
        }
    }
}

enum Round {
    Done,
    More,
    Stalled,
    Closing,
}

/// One pass per account with work left, each a short slice on the sync worker.
fn front_round(shared: &Arc<Shared>, worker: &Worker) -> Round {
    let Ok(list) = accounts(shared) else { return Round::Stalled };
    let (mut left_any, mut moved) = (false, false);
    for account in list {
        if shared.is_closing() {
            return Round::Closing;
        }
        if !in_front(shared) || !downloads_allowed(shared) {
            return Round::Done;
        }
        let now = crate::compose::now_ms();
        let before = left(shared, &account, now).unwrap_or_default();
        if before.total() == 0 && !attachments_allowed(shared) {
            continue;
        }
        let until = Instant::now() + FRONT_SLICE;
        let ticket = match worker.enqueue_front_download(shared, &account, until) {
            Ok(t) => t,
            Err(_) => return Round::Closing,
        };
        let ended = ticket.wait_until(until + Duration::from_secs(5));
        let after = left(shared, &account, crate::compose::now_ms()).unwrap_or_default();
        if after.total() < before.total() {
            moved = true;
        }
        if after.total() > 0 {
            left_any = true;
        }
        if let Some(Ended::Failed(code)) = ended {
            shared.log(&format!("[offline] {account}: download ended {code}"));
        }
    }
    match (left_any, moved) {
        (false, _) => Round::Done,
        (true, true) => Round::More,
        (true, false) => Round::Stalled,
    }
}

/// Whether a download pass stops now. A background run's stops at its deadline, when the app
/// comes to the front or the platform ends the task; the foreground downloader's when the app
/// leaves the front, at its slice's end, or as soon as a page pass waits behind it. Both stop on a
/// constrained network and when the engine closes.
pub(crate) fn stop_download(shared: &Shared, deadline: Option<Instant>, front: bool) -> bool {
    if !downloads_allowed(shared) {
        return true;
    }
    if front {
        deadline.is_some_and(|d| Instant::now() >= d)
            || !in_front(shared)
            || shared.offline.page_waiting.load(Ordering::SeqCst) > 0
            || shared.is_closing()
    } else {
        crate::background::stop_downloading(shared, deadline)
    }
}

// ── Storage ─────────────────────────────────────────────────────────────────

fn dir_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

fn account_json(engine: &Engine, account: &str) -> Result<Value, RpcError> {
    let shared = engine.shared();
    let now = crate::compose::now_ms();
    let window = shared.read(|c| stored_window(c, account)).map_err(internal)?;
    let premium = crate::premium::active(shared);
    let b = bounds_for(&window, premium, now);
    let (bodies_bytes, total, offline): (i64, i64, i64) = shared
        .read(|c| {
            let bytes: i64 = c.query_row("SELECT COALESCE(sum(bytes), 0) FROM bodies WHERE account_id = ?1", [account], |r| r.get(0))?;
            let (total, offline) = c.query_row(
                "SELECT count(*), COALESCE(sum(EXISTS (SELECT 1 FROM bodies b WHERE b.account_id = m.account_id AND b.folder = m.folder AND b.uid = m.uid)), 0)
                 FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                 WHERE m.account_id = ?1 AND m.date_ms >= ?2 AND m.out_of_window_ms IS NULL AND m.local_deleted IS NULL AND f.noselect = 0",
                (account, b.fetch_from),
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok((bytes, total, offline))
        })
        .map_err(internal)?;
    let att = attachments_dir(shared, account).map_or(0, |d| dir_bytes(&d));
    let l = left(shared, account, now).map_err(internal)?;
    Ok(json!({
        "accountId": account,
        "window": window,
        "effectiveWindow": if window == "all" && !premium { DEFAULT_WINDOW } else { window.as_str() },
        "bodiesBytes": bodies_bytes,
        "attachmentsBytes": att,
        "messages": total,
        "offline": offline,
        "foldersLeft": l.folders,
    }))
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// `mobile.offline.get {}` -> `{premium, network: {constrained, expensive}, accounts: [{accountId,
/// window, effectiveWindow, bodiesBytes, attachmentsBytes, messages, offline, foldersLeft}]}`.
/// `messages` counts the messages in the effective window the list holds, `offline` those whose
/// body is on the phone.
pub(crate) fn get(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let ids: Vec<String> = engine
        .read(|c| {
            let mut st = c.prepare("SELECT id FROM accounts ORDER BY sort_order IS NULL, sort_order, created_ms, id")?;
            let rows = st.query_map([], |r| r.get(0))?.collect();
            rows
        })
        .map_err(internal)?;
    let accounts = ids.iter().map(|a| account_json(engine, a)).collect::<Result<Vec<_>, _>>()?;
    let st = &engine.shared().offline;
    Ok(json!({
        "premium": crate::premium::active(engine.shared()),
        "network": { "constrained": st.constrained.load(Ordering::SeqCst), "expensive": st.metered.load(Ordering::SeqCst) },
        "accounts": accounts,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    account_id: String,
    window: String,
}

/// `mobile.offline.set {accountId, window}` -> the account's entry as `get` lists it. `INVALID`
/// for a window that is not one of [`WINDOWS`] or an unknown account; `PREMIUM_REQUIRED` for
/// `all` without Premium. A narrower window deletes the mail beyond it on the phone on the next
/// download; a wider one downloads the rest.
pub(crate) fn set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SetParams = parse(params)?;
    if !WINDOWS.contains(&p.window.as_str()) {
        return Err(RpcError::Invalid("window is 1m, 3m, 6m, 12m or all".into()));
    }
    if p.window == "all" && !crate::premium::active(engine.shared()) {
        return Err(RpcError::Premium("PREMIUM_REQUIRED"));
    }
    let known = engine
        .read(|c| c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [&p.account_id], |_| Ok(())).optional())
        .map_err(internal)?
        .is_some();
    if !known {
        return Err(RpcError::Invalid("unknown account".into()));
    }
    engine
        .write(|c| crate::settings::put_in(c, &window_key(&p.account_id), &p.window))
        .map_err(internal)?;
    engine.offline_wake();
    account_json(engine, &p.account_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NowParams {
    #[serde(default)]
    account_id: Option<String>,
}

/// `mobile.offline.downloadNow {accountId?}` -> `{queued: true}`: bodies waiting for a retry are
/// asked for again at once, and the foreground downloader looks for work now.
pub(crate) fn download_now(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: NowParams = parse(params)?;
    engine
        .write(|c| match &p.account_id {
            Some(a) => c.execute("UPDATE body_retry SET next_ms = 0 WHERE account_id = ?1", [a]),
            None => c.execute("UPDATE body_retry SET next_ms = 0", []),
        })
        .map_err(internal)?;
    lock(&engine.shared().offline.att_retry).retain(|k, _| p.account_id.as_ref().is_some_and(|a| *a != k.0));
    engine.offline_wake();
    Ok(json!({ "queued": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetParams {
    constrained: bool,
    expensive: bool,
}

/// `mobile.network.state {constrained, expensive}` -> `{}`: the page's view of the network, for a
/// shell that reports it through the page ([`Engine::set_network`] otherwise).
pub(crate) fn network(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: NetParams = parse(params)?;
    engine.set_network(p.constrained, p.expensive);
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_map_to_days_and_all_follows_premium() {
        let now = 1_000 * DAY_MS + 5;
        assert_eq!(bounds_for("1m", false, now), Bounds { fetch_from: 970 * DAY_MS, keep_from: 970 * DAY_MS });
        assert_eq!(bounds_for("3m", true, now).fetch_from, 910 * DAY_MS);
        assert_eq!(bounds_for("6m", false, now).fetch_from, 820 * DAY_MS);
        assert_eq!(bounds_for("12m", false, now).keep_from, 635 * DAY_MS);
        assert_eq!(bounds_for("all", true, now), Bounds { fetch_from: 0, keep_from: 0 });
        // A lapse: 3 months fetched, nothing deleted by age.
        assert_eq!(bounds_for("all", false, now), Bounds { fetch_from: 910 * DAY_MS, keep_from: 0 });
        // Garbage reads as the default.
        assert_eq!(bounds_for("2y", false, now), bounds_for("3m", false, now));
    }

    #[test]
    fn retry_waits_double_up_to_a_day() {
        assert_eq!(retry_wait_ms(0), RETRY_BASE_MS);
        assert_eq!(retry_wait_ms(1), 2 * RETRY_BASE_MS);
        assert_eq!(retry_wait_ms(3), 8 * RETRY_BASE_MS);
        assert_eq!(retry_wait_ms(30), RETRY_MAX_MS);
    }

    // ── Against the mock server ─────────────────────────────────────────────

    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{MockImap, Scenario};

    fn now() -> i64 {
        crate::compose::now_ms()
    }

    /// A plain message that arrived `days_ago` days ago.
    fn mail(uid: u32, days_ago: i64) -> Message {
        Message::new(
            uid,
            format!(
                "From: A <a@example.com>\r\nTo: u@example.test\r\nSubject: s{uid}\r\nMessage-ID: <off-{uid}-{days_ago}@x>\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\r\nBody {uid}.\r\n"
            ),
        )
        .with_internal_ms(now() - days_ago * DAY_MS + uid as i64 * 1000)
    }

    /// multipart/related html showing an inline PNG by `cid:`, plus a file attachment.
    fn with_parts(uid: u32) -> Message {
        // A 1x1 PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        Message::new(
            uid,
            format!(
                "From: A <a@example.com>\r\nTo: u@example.test\r\nSubject: parts {uid}\r\nMessage-ID: <parts-{uid}@x>\r\nMIME-Version: 1.0\r\n\
                 Content-Type: multipart/mixed; boundary=\"mix\"\r\n\r\n\
                 --mix\r\nContent-Type: multipart/related; boundary=\"rel\"\r\n\r\n\
                 --rel\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Logo <img src=\"cid:logo@x\"></p>\r\n\
                 --rel\r\nContent-Type: image/png; name=\"logo.png\"\r\nContent-ID: <logo@x>\r\nContent-Disposition: inline; filename=\"logo.png\"\r\n\
                 Content-Transfer-Encoding: base64\r\n\r\n{png}\r\n--rel--\r\n\
                 --mix\r\nContent-Type: application/octet-stream; name=\"data.bin\"\r\nContent-Disposition: attachment; filename=\"data.bin\"\r\n\
                 Content-Transfer-Encoding: base64\r\n\r\nAAECAwQFBgcICQ==\r\n--mix--\r\n"
            ),
        )
        .with_internal_ms(now() - DAY_MS + uid as i64)
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        e: Engine,
        account: String,
    }

    fn fx(server: &MockImap) -> Fx {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        e.set_front_downloads_for_tests(false);
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "u@example.test", "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();
        Fx { _tmp: tmp, e, account }
    }

    impl Fx {
        fn uids(&self, folder: &str) -> Vec<i64> {
            self.e
                .read(|c| {
                    let mut st = c.prepare("SELECT uid FROM messages WHERE folder = ?1 ORDER BY uid")?;
                    let rows = st.query_map([folder], |r| r.get(0))?.collect();
                    rows
                })
                .unwrap()
        }

        fn count(&self, sql: &str) -> i64 {
            self.e.read(|c| c.query_row(sql, [], |r| r.get(0))).unwrap()
        }

        fn set(&self, window: &str) -> Result<Value, RpcError> {
            self.e.rpc("mobile.offline.set", json!({ "accountId": self.account, "window": window }))
        }

        fn download(&self) {
            match crate::sync::download_now_for_test(self.e.shared(), &self.account, false) {
                Ok(()) => {}
                Err(crate::sync::Fail::Code(code, why)) => panic!("download failed: {} {why}", code.as_str()),
                Err(_) => panic!("download stopped early"),
            }
        }
    }

    /// The window replaces the fixed 90 days: a wider one lists older mail, `all` (Premium) lists
    /// everything, a Premium lapse lists 3 months again but deletes nothing, and the user shrinking
    /// the window deletes what is beyond it.
    #[test]
    fn the_window_decides_what_is_listed_a_lapse_keeps_and_a_shrink_deletes() {
        let mut mb = Mailbox::new("INBOX");
        for (uid, days) in [(1, 10), (2, 200), (3, 500)] {
            mb.add(mail(uid, days));
        }
        let server = MockImap::start(Scenario::new().mailbox(mb));
        let f = fx(&server);
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        assert_eq!(f.uids("INBOX"), [1], "the default window is 3 months");

        assert_eq!(f.set("12m").unwrap()["window"], "12m");
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        assert_eq!(f.uids("INBOX"), [1, 2]);

        assert_eq!(f.set("all").unwrap_err().code(), "PREMIUM_REQUIRED");
        crate::premium::set_active_for_test(f.e.shared(), true);
        f.set("all").unwrap();
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        assert_eq!(f.uids("INBOX"), [1, 2, 3], "all mail");

        // Premium lapses: 3 months listed, nothing deleted, the stored choice kept.
        crate::premium::set_active_for_test(f.e.shared(), false);
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        f.download();
        assert_eq!(f.uids("INBOX"), [1, 2, 3], "a lapse deleted mail");
        let got = f.e.rpc("mobile.offline.get", json!({})).unwrap();
        assert_eq!(got["accounts"][0]["window"], "all");
        assert_eq!(got["accounts"][0]["effectiveWindow"], "3m");
        // Expunged on the server inside the 3 months: still removed.
        server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[1], false));
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        assert_eq!(f.uids("INBOX"), [2, 3]);

        // The user shrinks it: the next download deletes beyond it.
        f.set("6m").unwrap();
        f.download();
        assert!(f.uids("INBOX").is_empty(), "{:?}", f.uids("INBOX"));
        f.set("12m").unwrap();
        f.download();
        assert_eq!(f.uids("INBOX"), [2], "a wider window takes the folder's full pass again");
    }

    /// A download covers every selectable folder (never opened ones too, more than 20 of them)
    /// and every body of the window, older than two weeks and more than 50.
    #[test]
    fn a_download_lists_every_folder_and_fetches_every_body_in_the_window() {
        let mut boxes = vec![{
            let mut mb = Mailbox::new("INBOX");
            mb.add(mail(1, 1));
            mb.add(mail(2, 60));
            mb
        }];
        for i in 0..24 {
            let mut mb = Mailbox::new(&format!("F{i:02}"));
            mb.add(mail(1, 20));
            boxes.push(mb);
        }
        let mut archive = Mailbox::new("Archive");
        for uid in 1..=60 {
            archive.add(mail(uid, 40));
        }
        boxes.push(archive);
        boxes.push(Mailbox::new("Parent").with_attrs(&["\\Noselect"]));
        let server = MockImap::start(Scenario::new().mailboxes(boxes));
        let f = fx(&server);
        f.download();
        assert_eq!(f.count("SELECT count(*) FROM folders WHERE noselect = 0 AND (synced_ms IS NULL OR full_from_ms IS NULL)"), 0);
        assert_eq!(f.count("SELECT count(*) FROM messages"), 2 + 24 + 60);
        assert_eq!(f.count("SELECT count(*) FROM bodies"), 2 + 24 + 60);
        assert_eq!(left(f.e.shared(), &f.account, now()).unwrap(), Left::default());
        // Nothing left: the next download fetches no body.
        let before = server.count_commands("BODY.PEEK[");
        f.download();
        assert_eq!(server.count_commands("BODY.PEEK["), before);
    }

    /// Low Data Mode stops every download; a metered network takes headers and bodies but no
    /// attachments; an unmetered one takes the attachments too (up to 10 MB each), into the
    /// offline directory, where `local` and the viewer's inline images find them.
    #[test]
    fn the_network_gates_downloads_and_attachments_go_on_wifi_only() {
        let mut mb = Mailbox::new("INBOX");
        mb.add(with_parts(1));
        mb.add(with_parts(2));
        let server = MockImap::start(Scenario::new().mailbox(mb));
        let f = fx(&server);
        f.e.set_network(true, true);
        f.download();
        assert_eq!(f.count("SELECT count(*) FROM messages"), 0, "a constrained network downloaded");
        assert_eq!(server.count_commands("SEARCH"), 0);

        f.e.set_network(false, true);
        f.download();
        assert_eq!(f.count("SELECT count(*) FROM bodies"), 2);
        let dir = attachments_dir(f.e.shared(), &f.account).unwrap();
        let files = || std::fs::read_dir(&dir).map(|d| d.filter_map(|e| e.ok()).filter(|e| e.file_name().len() == 64).count()).unwrap_or(0);
        assert_eq!(files(), 0, "attachments on a metered network");
        let inline = f.e.rpc("mobile.message.inlineImages", json!({ "accountId": f.account, "folder": "INBOX", "uid": 1 })).unwrap();
        assert_eq!(inline["images"], json!({}));
        assert_eq!(inline["missing"].as_array().unwrap().len(), 1, "{inline}");

        // Message 2's file is over the cap (as its size says).
        f.e.write(|c| c.execute("UPDATE attachments SET size = ?1 WHERE uid = 2 AND filename = 'data.bin'", [ATTACHMENT_PREFETCH_MAX as i64 + 1]))
            .unwrap();
        f.e.set_network(false, false);
        f.download();
        assert_eq!(files(), 3, "two inline images and one file, not the one over 10 MB");
        let section: String = f.e.read(|c| c.query_row("SELECT section FROM attachments WHERE uid = 1 AND filename = 'data.bin'", [], |r| r.get(0))).unwrap();
        let local = f.e.rpc("mobile.attachment.local", json!({ "accountId": f.account, "folder": "INBOX", "uid": 1, "section": section })).unwrap();
        let path = local["path"].as_str().unwrap();
        assert!(path.starts_with(dir.to_str().unwrap()), "{path}");
        assert_eq!(std::fs::read(path).unwrap(), (0u8..10).collect::<Vec<_>>());
        let inline = f.e.rpc("mobile.message.inlineImages", json!({ "accountId": f.account, "folder": "INBOX", "uid": 1 })).unwrap();
        assert!(inline["images"]["logo@x"].as_str().unwrap().starts_with("data:image/png;base64,iVBORw0KGgo"), "{inline}");
        assert_eq!(inline["missing"], json!([]));
        let got = f.e.rpc("mobile.offline.get", json!({})).unwrap();
        assert!(got["accounts"][0]["attachmentsBytes"].as_u64().unwrap() > 0, "{got}");
        assert_eq!(got["accounts"][0]["offline"], 2);
        assert_eq!(got["accounts"][0]["messages"], 2);
        // Removing the account takes its offline files.
        f.e.rpc("mobile.accounts.remove", json!({ "accountId": f.account })).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn set_refuses_what_is_not_a_window() {
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
        let f = fx(&server);
        assert_eq!(f.set("2y").unwrap_err().code(), "INVALID");
        assert_eq!(f.e.rpc("mobile.offline.set", json!({ "accountId": "nobody", "window": "1m" })).unwrap_err().code(), "INVALID");
        assert_eq!(f.set("1m").unwrap()["window"], "1m");
        assert_eq!(f.e.setting(&window_key(&f.account)).unwrap().as_deref(), Some("1m"));
    }
}
