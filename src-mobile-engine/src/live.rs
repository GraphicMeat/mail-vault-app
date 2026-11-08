//! New mail while the app is open (plan Ruling 8): one `mv-engine-live` thread listens on the
//! foreground account's INBOX, and a change queues the normal INBOX pass on the sync worker, so
//! every write stays in `sync.rs`. IMAP idles (IDLE issued again every 10 min, so a socket a
//! carrier NAT dropped silently is found; a server without IDLE gets a STATUS poll every 60 s),
//! JMAP reads its EventSource (`Email,Mailbox`, ping 60), Graph asks for its newest message every
//! 60 s and syncs only when that differs ([`crate::backend::Backend::wait_for_change`]).
//!
//! The page drives it with `mobile.app.state {foreground, accountId?, resumed?}`: foreground on an
//! account starts its thread (a repeat for the account already listening changes nothing, but
//! `resumed`, sent when the app comes back to the front, replaces it, since its connection may
//! have died while the app was away), background or another account stops it. The shell sends the
//! same on the OS's suspend and resume, for a WebView that never reports `hidden`. Stopping sets
//! the thread's [`StopFlag`] and returns at once; the thread notices within a second, ends its
//! IDLE with DONE (or drops its stream) and exits, well inside 2 s unless a connect or sign-in is
//! already on the wire (core's own timeouts bound that one). The RPC never waits for the thread,
//! and the thread holds no lock across the network: the engine's other workers and foreground
//! reads never wait on it.
//!
//! A connect that fails waits before the next (5 s doubling to 300 s, as replay does): a failure
//! never turns into a fast reconnect loop. A refused sign-in of a password (or app password, or
//! JMAP token) account ends the thread until the next foreground, resume or account switch: those
//! servers often ban an address after a few failed logins. An OAuth account keeps its refresh and
//! parking path: parked (`needs_auth = 1`), whether found at a connect or by another worker while
//! the thread listens (seen within a second), the thread ends until the next foreground. After a
//! connect the thread queues one INBOX pass: what arrived while nobody listened raises no push on
//! the new connection.

use crate::accounts::Code;
use crate::backend::{self, Change, FolderRow, StopFlag, Watch};
use crate::db::{lock, Engine, Shared};
use crate::rpc::{parse, RpcError};
use crate::sync::{self, Fail, Worker};
use mailvault_core::backoff::RetryPolicy;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Between two cheap checks of a server that cannot push.
const POLL: Duration = Duration::from_secs(60);
/// The longest one IMAP IDLE runs. RFC 2177 allows up to 29 minutes, but carrier NATs drop an
/// idle mapping well before that, and a dead IDLE socket shows nothing until it is used.
const REISSUE: Duration = Duration::from_secs(10 * 60);
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
    started: Instant,
}

/// A resume within this long of the thread's start keeps it: the page's `visibilitychange` and
/// the shell's OS resume both report one return to the front.
const RESUME_SETTLE: Duration = Duration::from_secs(1);

/// The engine's live listener: at most one current thread.
#[derive(Default)]
pub(crate) struct Live {
    current: Mutex<Option<Current>>,
    /// The account the last foreground named: what a resume without one (the shell's) resumes.
    last: Mutex<Option<String>>,
    /// Serializes `mobile.app.state`; holds the highest shell `seq` applied.
    order: Mutex<u64>,
    timing: Mutex<Timing>,
    /// Live threads not yet exited, a stopping one included.
    alive: Arc<AtomicUsize>,
    /// The accounts put in front since the app last left it: their INBOX watermarks move past what
    /// the list showed when it leaves (`background::seen_in_front`).
    shown: Mutex<Vec<String>>,
}

impl Live {
    /// Listens on `account`'s INBOX: nothing to do when its thread is already running, unless
    /// `resumed` (the app came back to the front: its connection may have died silently while it
    /// was away, so it is replaced); otherwise stops the current thread (without waiting for it)
    /// and starts one for `account`.
    fn foreground(&self, shared: &Arc<Shared>, sync: &Worker, account: &str, resumed: bool) -> Result<(), String> {
        let mut current = lock(&self.current);
        if let Some(c) = current.as_ref() {
            let fresh = !resumed || c.started.elapsed() < RESUME_SETTLE;
            if c.account == account && !c.done.load(Ordering::SeqCst) && fresh {
                return Ok(());
            }
            c.stop.stop();
        }
        *current = None;
        let timing = *lock(&self.timing);
        let stop = Arc::new(StopFlag::default());
        let done = Arc::new(AtomicBool::new(false));
        let watch = Watch {
            stop: Arc::clone(&stop),
            shared: Arc::clone(shared),
            account: account.to_string(),
            parks_seen: AtomicU64::new(shared.parks.load(Ordering::SeqCst)),
            parked: AtomicBool::new(false),
            poll: timing.poll,
            reissue: timing.reissue,
        };
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
        *current = Some(Current { account: account.to_string(), stop, done, started: Instant::now() });
        *lock(&self.last) = Some(account.to_string());
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
        let mut last = lock(&self.last);
        if last.as_deref() == Some(account) {
            *last = None;
        }
    }

    /// Stops the current thread, if any; returns at once.
    pub(crate) fn stop(&self) {
        if let Some(c) = lock(&self.current).take() {
            c.stop.stop();
        }
    }
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
    // Only an OAuth account has a refresh and parking path for a refused sign-in. A refused
    // password (or app password, or JMAP token) is not retried while the app stays in front:
    // repeated LOGIN failures get the phone's address banned (fail2ban-style rules).
    let oauth = shared
        .read(|c| c.query_row("SELECT auth FROM accounts WHERE id = ?1", [account], |r| r.get::<_, String>(0)).optional())
        .ok()
        .flatten()
        .is_some_and(|a| a == "oauth2");
    let policy = RetryPolicy::new(timing.backoff_base, timing.backoff_cap, None);
    // The failure the next wait answers: 1 after a healthy stretch.
    let mut failures = 1u32;
    // The last connect failed with a sign-in refusal: its catch-up pass would fail the same way.
    let mut refused = false;
    let inbox = FolderRow::new("INBOX", None);
    loop {
        if watch.stopped() || parked(shared, account) {
            return;
        }
        let failure = match backend::open(shared, account) {
            Ok(mut backend) => {
                // Stopped while the sign-in was on the wire: queue nothing, listen to nothing.
                if watch.stopped() {
                    return;
                }
                if !refused {
                    let _ = sync.enqueue_inbox(shared, account);
                }
                let failure = loop {
                    let change = backend.wait_for_change(&inbox, watch);
                    // Parked by another worker while this connection still works: stop at the
                    // next wake (a change, a re-issue, a poll), never listen on for a sync that
                    // can only report NEEDS_AUTH.
                    if change.is_ok() && parked(shared, account) {
                        return;
                    }
                    match change {
                        Ok(Change::Changed) => {
                            failures = 1;
                            if let Err(e) = sync.enqueue_inbox(shared, account) {
                                shared.log(&format!("[live] {account}: {e}"));
                                return;
                            }
                        }
                        Ok(Change::Quiet) => {
                            if watch.stopped() {
                                return;
                            }
                            failures = 1;
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
                if refused && !oauth {
                    shared.log(&format!("[live] {account}: {} {why}; not again until the next foreground", code.as_str()));
                    return;
                }
                shared.log(&format!("[live] {account}: {} {why}; again in {:?}", code.as_str(), policy.next_delay(failures)));
            }
        }
        if !watch.nap(policy.next_delay(failures)) {
            return;
        }
        failures = failures.saturating_add(1);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppStateParams {
    foreground: bool,
    #[serde(default)]
    account_id: Option<String>,
    /// The app came back to the front (not a repeat while it stayed there).
    #[serde(default)]
    resumed: bool,
    /// The shell's OS lifecycle events number themselves in the order the OS sent them; each is
    /// delivered on its own thread, so a suspend can arrive after the resume that followed it. A
    /// numbered call at or below the highest one applied is stale and ignored. The page's calls
    /// carry none.
    #[serde(default)]
    seq: Option<u64>,
}

/// `mobile.app.state {foreground, accountId?, resumed?, seq?}` -> `{live}`: the page went to the
/// foreground (on `accountId`) or the background. `resumed`: the app came back to the front, so a
/// thread already listening on the account is replaced (its socket may be dead), and with no
/// `accountId` (the shell's OS resume) the account last put in front is resumed. Starts or stops
/// the live thread and returns at once; `live` says whether a thread was asked to listen.
pub(crate) fn app_state(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: AppStateParams = parse(params)?;
    // One call at a time, check and action together: a stale call can neither pass the check
    // nor act after a newer one (each call only flips flags and spawns, so the hold is short).
    let mut applied = lock(&engine.live().order);
    if let Some(seq) = p.seq {
        if seq <= *applied {
            return Ok(json!({ "live": false, "stale": true }));
        }
        *applied = seq;
    }
    let account = match (p.foreground, p.account_id) {
        (true, Some(a)) => {
            let mut shown = lock(&engine.live().shown);
            if !shown.contains(&a) {
                shown.push(a.clone());
            }
            a
        }
        // The shell's OS resume: the account the page last put in front.
        (true, None) if p.resumed => match lock(&engine.live().last).clone() {
            Some(a) => a,
            None => return Ok(json!({ "live": false })),
        },
        _ => {
            engine.live().stop();
            if !p.foreground {
                // The user saw these accounts' lists: what they showed is no news for a later
                // background run. The account in front stays shown until the app comes back.
                let mut shown: Vec<String> = std::mem::take(&mut *lock(&engine.live().shown));
                if let Some(last) = lock(&engine.live().last).clone() {
                    if !shown.contains(&last) {
                        shown.push(last.clone());
                    }
                    lock(&engine.live().shown).push(last);
                }
                crate::background::seen_in_front(engine.shared(), &shown);
            }
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
    engine.live().foreground(engine.shared(), engine.sync_worker(), &account, p.resumed).map_err(RpcError::Internal)?;
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
    fn the_app_timing_is_a_minute_poll_and_a_10_minute_idle() {
        let t = Timing::default();
        assert_eq!(t.poll, Duration::from_secs(60));
        assert_eq!(t.reissue, Duration::from_secs(10 * 60));
        assert_eq!((t.backoff_base, t.backoff_cap), (Duration::from_secs(5), Duration::from_secs(300)));
    }

    #[test]
    fn backoff_doubles_to_the_cap() {
        let p = RetryPolicy::new(BACKOFF_BASE, BACKOFF_CAP, None);
        let seen: Vec<u64> = (1..=9).map(|n| p.next_delay(n).as_secs()).collect();
        assert_eq!(seen, vec![5, 10, 20, 40, 80, 160, 300, 300, 300]);
    }
}
