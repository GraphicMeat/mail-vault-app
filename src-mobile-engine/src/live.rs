//! New mail while the app is open (plan Ruling 8): one `mv-engine-live` thread listens on the
//! foreground account's INBOX, and a change queues the normal INBOX pass on the sync worker, so
//! every write stays in `sync.rs`. IMAP idles (IDLE issued again every 25 min; a server without
//! IDLE gets a STATUS poll every 60 s), JMAP reads its EventSource (`Email,Mailbox`, ping 60),
//! Graph asks for its newest message every 60 s and syncs only when that differs
//! ([`crate::backend::Backend::wait_for_change`]).
//!
//! The page drives it with `mobile.app.state {foreground, accountId?}`: foreground on an account
//! starts its thread (a repeat for the account already listening changes nothing), background or
//! another account stops it. Stopping sets the thread's [`StopFlag`] and returns at once; the
//! thread notices within a second, ends its IDLE with DONE (or drops its stream) and exits, well
//! inside 2 s unless a connect or sign-in is already on the wire (core's own timeouts bound that
//! one). The RPC never waits for the thread, and the thread holds no lock across the network: the
//! engine's other workers and foreground reads never wait on it.
//!
//! A connect that fails waits before the next (5 s doubling to 300 s, as replay does), whatever
//! the cause: a refused sign-in never turns into a fast reconnect loop. An account that waits for a
//! new sign-in (`needs_auth = 1`) ends the thread for good; the page's next foreground starts it
//! again. After a connect the thread queues one INBOX pass: what arrived while nobody listened
//! raises no push on the new connection.

use crate::accounts::Code;
use crate::backend::{self, Change, FolderRow, StopFlag, Watch};
use crate::db::{lock, Engine, Shared};
use crate::rpc::{parse, RpcError};
use crate::sync::{self, Fail, Worker};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Between two cheap checks of a server that cannot push.
const POLL: Duration = Duration::from_secs(60);
/// The longest one IMAP IDLE runs (RFC 2177 asks for less than 29 minutes).
const REISSUE: Duration = Duration::from_secs(25 * 60);
/// First wait after a failed connect; doubles per failure up to [`BACKOFF_CAP`].
const BACKOFF_BASE: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Timing {
    poll: Duration,
    reissue: Duration,
    backoff_base: Duration,
    backoff_cap: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { poll: POLL, reissue: REISSUE, backoff_base: BACKOFF_BASE, backoff_cap: BACKOFF_CAP }
    }
}

/// The thread listening now.
struct Current {
    account: String,
    stop: Arc<StopFlag>,
    /// Set by the thread as it exits (a parked or removed account ends it on its own).
    done: Arc<AtomicBool>,
}

/// The engine's live listener: at most one current thread.
#[derive(Default)]
pub(crate) struct Live {
    current: Mutex<Option<Current>>,
    timing: Mutex<Timing>,
    /// Live threads not yet exited, a stopping one included.
    alive: Arc<AtomicUsize>,
}

impl Live {
    /// Listens on `account`'s INBOX: nothing to do when its thread is already running; otherwise
    /// stops the current thread (without waiting for it) and starts one for `account`.
    fn foreground(&self, shared: &Arc<Shared>, sync: &Worker, account: &str) -> Result<(), String> {
        let mut current = lock(&self.current);
        if let Some(c) = current.as_ref() {
            if c.account == account && !c.done.load(Ordering::SeqCst) {
                return Ok(());
            }
            c.stop.stop();
        }
        *current = None;
        let timing = *lock(&self.timing);
        let stop = Arc::new(StopFlag::default());
        let done = Arc::new(AtomicBool::new(false));
        let watch = Watch { stop: Arc::clone(&stop), shared: Arc::clone(shared), poll: timing.poll, reissue: timing.reissue };
        let (shared, sync, id, exited, alive) =
            (Arc::clone(shared), sync.clone(), account.to_string(), Arc::clone(&done), Arc::clone(&self.alive));
        alive.fetch_add(1, Ordering::SeqCst);
        let spawned = std::thread::Builder::new().name("mv-engine-live".into()).spawn(move || {
            sync::background_qos();
            run(&shared, &sync, &id, &watch, timing);
            exited.store(true, Ordering::SeqCst);
            alive.fetch_sub(1, Ordering::SeqCst);
        });
        if let Err(e) = spawned {
            self.alive.fetch_sub(1, Ordering::SeqCst);
            return Err(format!("live thread: {e}"));
        }
        *current = Some(Current { account: account.to_string(), stop, done });
        Ok(())
    }

    /// Stops the current thread when it listens on `account` (being removed); returns at once.
    pub(crate) fn stop_account(&self, account: &str) {
        let mut current = lock(&self.current);
        if current.as_ref().is_some_and(|c| c.account == account) {
            if let Some(c) = current.take() {
                c.stop.stop();
            }
        }
    }

    /// Stops the current thread, if any; returns at once.
    pub(crate) fn stop(&self) {
        if let Some(c) = lock(&self.current).take() {
            c.stop.stop();
        }
    }
}

fn next_delay(d: Duration, cap: Duration) -> Duration {
    (d * 2).min(cap)
}

fn parked(shared: &Shared, account: &str) -> bool {
    shared
        .read(|c| c.query_row("SELECT needs_auth FROM accounts WHERE id = ?1", [account], |r| r.get::<_, i64>(0)).optional())
        .ok()
        .flatten()
        .is_some_and(|n| n != 0)
}

/// The thread: connect, catch up, wait for changes; on a failure wait the backoff and connect
/// again; return when stopped, closing, or the account is gone or parked.
fn run(shared: &Arc<Shared>, sync: &Worker, account: &str, watch: &Watch, timing: Timing) {
    let mut backoff = timing.backoff_base;
    // The last connect failed with a sign-in refusal: its catch-up pass would fail the same way.
    let mut refused = false;
    let inbox = FolderRow::new("INBOX", None);
    loop {
        if watch.stopped() || parked(shared, account) {
            return;
        }
        let failure = match backend::open(shared, account) {
            Ok(mut backend) => {
                if !refused {
                    let _ = sync.enqueue_inbox(shared, account);
                }
                let failure = loop {
                    match backend.wait_for_change(&inbox, watch) {
                        Ok(Change::Changed) => {
                            backoff = timing.backoff_base;
                            if let Err(e) = sync.enqueue_inbox(shared, account) {
                                shared.log(&format!("[live] {account}: {e}"));
                                return;
                            }
                        }
                        Ok(Change::Quiet) => {
                            if watch.stopped() {
                                return;
                            }
                            backoff = timing.backoff_base;
                        }
                        Err(f) => break f,
                    }
                };
                // Signs out (an IMAP session that is still whole logs out).
                drop(backend);
                failure
            }
            Err(f) => f,
        };
        match failure {
            Fail::Gone | Fail::Closing | Fail::Code(Code::NeedsAuth, _) => return,
            Fail::Code(code, why) => {
                if watch.stopped() {
                    return;
                }
                refused = code == Code::AuthFailed;
                shared.log(&format!("[live] {account}: {} {why}; again in {:?}", code.as_str(), backoff));
            }
        }
        if !watch.nap(backoff) {
            return;
        }
        backoff = next_delay(backoff, timing.backoff_cap);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppStateParams {
    foreground: bool,
    #[serde(default)]
    account_id: Option<String>,
}

/// `mobile.app.state {foreground, accountId?}` -> `{live}`: the page went to the foreground (on
/// `accountId`) or the background. Starts or stops the live thread and returns at once; `live`
/// says whether a thread now listens.
pub(crate) fn app_state(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: AppStateParams = parse(params)?;
    let account = match (p.foreground, p.account_id) {
        (true, Some(a)) => a,
        _ => {
            engine.live().stop();
            return Ok(json!({ "live": false }));
        }
    };
    let known = engine
        .read(|c| c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [&account], |_| Ok(())).optional())
        .map_err(|e| RpcError::Internal(e.to_string()))?
        .is_some();
    if !known {
        engine.live().stop();
        return Err(RpcError::Invalid("unknown account".into()));
    }
    engine.live().foreground(engine.shared(), engine.sync_worker(), &account).map_err(RpcError::Internal)?;
    Ok(json!({ "live": true }))
}

impl Engine {
    /// Tests: shortens the live thread's poll interval, IDLE re-issue and reconnect backoff (for
    /// threads started after the call).
    #[doc(hidden)]
    pub fn set_live_timing(&self, poll: Duration, reissue: Duration, backoff_base: Duration, backoff_cap: Duration) {
        *lock(&self.live().timing) = Timing { poll, reissue, backoff_base, backoff_cap };
    }

    /// Tests: whether any live thread is still running (a stopping one too).
    #[doc(hidden)]
    pub fn live_running(&self) -> bool {
        self.live().alive.load(Ordering::SeqCst) > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_timing_is_a_minute_poll_and_a_25_minute_idle() {
        let t = Timing::default();
        assert_eq!(t.poll, Duration::from_secs(60));
        assert_eq!(t.reissue, Duration::from_secs(25 * 60));
        assert_eq!((t.backoff_base, t.backoff_cap), (Duration::from_secs(5), Duration::from_secs(300)));
    }

    #[test]
    fn backoff_doubles_to_the_cap() {
        let mut d = BACKOFF_BASE;
        let mut seen = Vec::new();
        for _ in 0..9 {
            seen.push(d.as_secs());
            d = next_delay(d, BACKOFF_CAP);
        }
        assert_eq!(seen, vec![5, 10, 20, 40, 80, 160, 300, 300, 300]);
    }
}
