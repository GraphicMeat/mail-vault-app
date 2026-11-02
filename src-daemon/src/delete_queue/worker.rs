//! The delete queue's replay worker: sends what the journal still owes, from
//! the daemon, with or without a window open.
//!
//! A pass runs `TIMING.launch` (20 s) after the daemon starts, 2 s after the
//! connectivity gate (`NetGate`) reopens, `TIMING.every` (5 min) after the
//! last pass, and on RPC `delete_queue.run {reason}`. One pass at a time
//! (`QueueState.pass`): a trigger that comes while one runs waits for it, and
//! every gate flip during a pass adds one more pass, not one each (the
//! transition receiver keeps only "changed since you looked").
//!
//! A pass reads the delete entries once, then per entry:
//! - an account the accounts listing no longer has, or a Graph account, is
//!   dropped (`errors.bulkAccountUnavailable` / `errors.bulkGraphDeleteUnsupported`,
//!   as the app's old replay cleared them); a listing that will not read ends
//!   the pass with everything kept;
//! - a vault-only folder is dropped (`errors.bulkUnsupported`); a folder marker
//!   that will not read keeps the entry;
//! - an account being closed or changed (`account_lifecycle`), or whose
//!   credentials will not read quietly, ends that account's pass with its
//!   entries untouched (no round counted, no reason written);
//! - a shut gate ends the pass;
//! - otherwise `send_owed` with `REPLAY`: the submit's claim, settle and
//!   classify code, one send round, the background lane, `Read::Quiet`
//!   credentials, and a wait for a quiet UI before each uid. A uid a submit
//!   holds is left to it.
//!
//! The entry's `arg` says how it is sent (`replay_intent`). The journal lock
//! is taken per read or write, never across a send. Every pass but a manual
//! one ends with `delete-queue-status {kept, online}`.
//!
//! Backoff: an entry whose last refusal is a bin capture the delete needed
//! (`E_BIN_CAPTURE:`, say a Gmail body fetch that times out every time) is
//! sent on the first `BACKOFF_AFTER` (3) passes that are refused it, then at
//! most hourly, then daily once `DAILY_AFTER` (12) passes refused it
//! (`backed_off`, from the entry's durable `Failure.passes` and `at`, on
//! `state.clock`). A timer pass skips it meanwhile (counted `skipped`, no
//! round, no reason written); `delete_queue.run` (Settings' Retry now)
//! sends it anyway. Any other refusal is retried every pass.

use super::*;
use std::time::Duration;

/// The reason Settings' retry sends: it answers there, so no status event.
pub(crate) const MANUAL: &str = "manual";

/// When the worker runs a pass on its own (the seam the trigger tests drive).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Timing {
    /// After the daemon starts: the first paint has the machine first.
    pub launch: Duration,
    /// After the last pass ended.
    pub every: Duration,
    /// After the gate reopens, for a link that flaps on the way up.
    pub debounce: Duration,
}

pub(crate) const TIMING: Timing = Timing { launch: Duration::from_secs(20), every: Duration::from_secs(5 * 60), debounce: Duration::from_secs(2) };

/// Replay passes refused a bin capture before an entry waits an hour between
/// tries, and before it waits a day.
pub(crate) const BACKOFF_AFTER: u32 = 3;
pub(crate) const DAILY_AFTER: u32 = 12;
const HOUR_MS: u64 = 60 * 60 * 1000;
const DAY_MS: u64 = 24 * HOUR_MS;
/// What a refused bin capture's wire string starts with (`CaptureFailure::wire`).
const CAPTURE_REFUSED: &str = "E_BIN_CAPTURE:";

/// Whether a timer pass leaves `entry` for later at `now_ms`: its latest
/// refusal (of a uid it still owes) is a bin capture, refused on at least
/// `BACKOFF_AFTER` replay passes, and the wait that count earns (an hour, a
/// day from `DAILY_AFTER`) since that refusal is not over. A clock set back
/// never waits longer than the wait itself.
pub(crate) fn backed_off(entry: &OpEntry, now_ms: u64) -> bool {
    let Some(last) = entry.failures.iter().filter(|(uid, _)| entry.uids.contains(uid)).map(|(_, f)| f).max_by_key(|f| f.at) else {
        return false;
    };
    if !last.message.starts_with(CAPTURE_REFUSED) {
        return false;
    }
    let wait = match last.passes {
        p if p >= DAILY_AFTER => DAY_MS,
        p if p >= BACKOFF_AFTER => HOUR_MS,
        _ => return false,
    };
    let since = now_ms.saturating_sub(last.at);
    since < wait && last.at <= now_ms.saturating_add(wait)
}

/// What one pass did, by uid.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub(crate) struct PassCounts {
    /// Taken up this pass: `done + failed + dropped`.
    pub attempted: u32,
    /// Deleted on the server, or already gone. Out of the journal.
    pub done: u32,
    /// Sent and refused (or a capture the delete needs failed). Kept.
    pub failed: u32,
    /// Cleared for good: no account to send with, a vault-only folder, an
    /// identity change.
    pub dropped: u32,
    /// Not sent this pass: a submit holds it, offline, the account closing
    /// or its credentials locked, an intent this build does not know. Kept.
    pub skipped: u32,
    /// What the delete entries still owe once the pass is over.
    pub kept: u32,
}

pub(crate) fn spawn_worker(state: &Arc<DaemonState>) {
    spawn_worker_with(state, TIMING);
}

pub(crate) fn spawn_worker_with(state: &Arc<DaemonState>, timing: Timing) {
    let weak = Arc::downgrade(state);
    let mut online = state.net.subscribe_transitions();
    tokio::spawn(async move {
        let mut wait = timing.launch;
        let mut reason = "launch";
        loop {
            match next_trigger(&mut online, wait, timing.debounce).await {
                Some(trigger) => {
                    if trigger != Trigger::Tick {
                        reason = "online";
                    }
                }
                None => return,
            }
            let Some(state) = weak.upgrade() else { return };
            // Flips from here on are after this pass's start: one more pass.
            let _ = online.borrow_and_update();
            // On its own task: a pass that panics is logged, and the next
            // trigger still runs one (`run_now` does the same).
            let st = Arc::clone(&state);
            if let Err(e) = tokio::spawn(async move { pass(&st, reason).await }).await {
                warn!("[delete-queue] {reason} pass failed, replay goes on: {e}");
            }
            drop(state);
            wait = timing.every;
            reason = "retry";
        }
    });
}

#[derive(Debug, PartialEq)]
enum Trigger {
    Tick,
    Online,
}

/// Wait for the tick (`wait`) or for the gate to reopen and stay open for
/// `debounce`. `None`: the gate is gone with the daemon.
async fn next_trigger(online: &mut tokio::sync::watch::Receiver<bool>, wait: Duration, debounce: Duration) -> Option<Trigger> {
    let tick = tokio::time::sleep(wait);
    tokio::pin!(tick);
    let mut settle: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    loop {
        tokio::select! {
            _ = &mut tick => return Some(Trigger::Tick),
            changed = online.changed() => {
                changed.ok()?;
                // Back online: (re)start the debounce. Gone offline: drop it.
                settle = (*online.borrow_and_update()).then(|| Box::pin(tokio::time::sleep(debounce)));
            }
            _ = async { match settle.as_mut() { Some(s) => s.await, None => std::future::pending().await } } => {
                return Some(Trigger::Online);
            }
        }
    }
}

/// `delete_queue.run`: a pass on its own task (a caller that stops waiting
/// does not stop it halfway), answered with its counts. Asked for, so it
/// ignores the backoff.
pub(crate) async fn run_now(state: &Arc<DaemonState>, reason: String) -> Result<PassCounts, String> {
    let st = Arc::clone(state);
    tokio::spawn(async move { pass_with(&st, &reason, false).await }).await.map_err(|e| format!("delete queue pass failed: {e}"))
}

/// One timer pass over every delete entry, after the running one (if any)
/// ends, honouring the backoff.
pub(crate) async fn pass(state: &Arc<DaemonState>, reason: &str) -> PassCounts {
    pass_with(state, reason, true).await
}

/// One pass; `backoff`: leave a backed-off entry for later (`backed_off`).
async fn pass_with(state: &Arc<DaemonState>, reason: &str, backoff: bool) -> PassCounts {
    let _one = state.delete_queue.pass.lock().await;
    #[cfg(test)]
    let _running = Running::start(state);
    #[cfg(test)]
    if state.delete_queue.panic_next_pass.swap(false, std::sync::atomic::Ordering::SeqCst) {
        panic!("a replay pass panicked (test)");
    }
    let counts = replay_all(state, backoff).await;
    info!(
        "[delete-queue] {reason} pass: {} done, {} failed, {} dropped, {} skipped, {} still owed",
        counts.done, counts.failed, counts.dropped, counts.skipped, counts.kept
    );
    if reason != MANUAL {
        state.events.emit("delete-queue-status", json!({ "kept": counts.kept, "online": state.net.is_online() }));
    }
    counts
}

#[cfg(test)]
struct Running(Arc<DaemonState>);

#[cfg(test)]
impl Running {
    fn start(state: &Arc<DaemonState>) -> Running {
        use std::sync::atomic::Ordering::SeqCst;
        let q = &state.delete_queue;
        q.passes.fetch_add(1, SeqCst);
        let now = q.running.fetch_add(1, SeqCst) + 1;
        q.most_running.fetch_max(now, SeqCst);
        Running(Arc::clone(state))
    }
}

#[cfg(test)]
impl Drop for Running {
    fn drop(&mut self) {
        self.0.delete_queue.running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// How an entry is sent: its own `mode` and `bin` (every entry `submit`
/// wrote has them). An entry the app's own journal wrote has neither, and is
/// sent the way the app's replay sent it: `api.deleteEmail(account, uid,
/// mailbox)`, whose `permanent = mailbox !== 'INBOX'` is `Mode::Auto`, with
/// a bin copy. A `mode` this build does not know: `None`, never guessed.
pub(crate) fn replay_intent(arg: &Value) -> Option<(Mode, bool)> {
    let mode = match arg.get("mode") {
        None | Some(Value::Null) => Mode::Auto,
        Some(Value::String(m)) => match m.as_str() {
            "auto" => Mode::Auto,
            "trash" => Mode::Trash,
            "permanent" => Mode::Permanent,
            _ => return None,
        },
        Some(_) => return None,
    };
    Some((mode, arg.get("bin").and_then(Value::as_bool).unwrap_or(true)))
}

fn n(uids: usize) -> u32 {
    u32::try_from(uids).unwrap_or(u32::MAX)
}

async fn replay_all(state: &Arc<DaemonState>, backoff: bool) -> PassCounts {
    let mut c = PassCounts::default();
    let entries = match delete_entries(state).await {
        Ok(entries) => entries,
        Err(e) => {
            warn!("[delete-queue] journal unreadable, nothing replayed: {e}");
            return c;
        }
    };
    if entries.iter().all(|e| e.uids.is_empty()) {
        return c;
    }
    let listing = {
        let st = Arc::clone(state);
        blocking(move || mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&st.app_dir)).map_err(|e| format!("{e:?}"))).await.and_then(|r| r)
    };
    let listing = match listing {
        Ok(listing) => listing,
        Err(e) => {
            // Unreadable is not "removed": keep everything for a later pass.
            warn!("[delete-queue] accounts unreadable, everything stays queued: {e}");
            c.skipped = n(entries.iter().map(|e| e.uids.len()).sum());
            c.kept = c.skipped;
            return c;
        }
    };

    let mut halted: HashSet<String> = HashSet::new();
    for entry in entries {
        let owed = n(entry.uids.len());
        if owed == 0 {
            continue;
        }
        if !state.net.is_online() || halted.contains(&entry.account_id) {
            c.skipped += owed;
            continue;
        }
        if let Err(reason) = admit_listed(&listing, &entry.account_id) {
            drop_entry(state, &entry, &reason).await;
            c.dropped += owed;
            continue;
        }
        match vault_only(state, &entry).await {
            Ok(false) => {}
            Ok(true) => {
                drop_entry(state, &entry, LOCAL_FOLDER).await;
                c.dropped += owed;
                continue;
            }
            Err(e) => {
                warn!("[delete-queue] {}/{}: folder marker unreadable, kept: {e}", entry.account_id, entry.mailbox);
                c.skipped += owed;
                continue;
            }
        }
        if let Err(e) = state.account_lifecycle.capture(&entry.account_id) {
            info!("[delete-queue] {}: account busy ({e:?}), its entries wait", entry.account_id);
            halted.insert(entry.account_id.clone());
            c.skipped += owed;
            continue;
        }
        let Some((mode, bin)) = replay_intent(&entry.arg) else {
            warn!("[delete-queue] entry {} has a mode this build does not know, kept: {}", entry.id, entry.arg);
            c.skipped += owed;
            continue;
        };
        if backoff && backed_off(&entry, u64::try_from(state.clock.now_ms()).unwrap_or(0)) {
            info!("[delete-queue] entry {}: its bin copy was refused again and again, waiting before the next try", entry.id);
            c.skipped += owed;
            continue;
        }

        let owners: Vec<(u32, u64)> = entry.uids.iter().map(|uid| (*uid, entry.id)).collect();
        let s = Submit { account_id: entry.account_id.clone(), mailbox: entry.mailbox.clone(), uids: entry.uids.clone(), mode, bin, arg: entry.arg.clone() };
        let sent = send_owed(state, &s, &owners, REPLAY).await;
        let refused = n(sent.reply.refused.len());
        c.done += n(sent.reply.landed.len());
        c.dropped += n(sent.reply.dropped.len());
        c.failed += refused;
        c.skipped += n(sent.reply.queued.len()).saturating_sub(refused);
        if sent.halt == Some(Halt::Account) {
            halted.insert(entry.account_id.clone());
        }
    }
    c.attempted = c.done + c.failed + c.dropped;
    c.kept = match delete_entries(state).await {
        Ok(entries) => n(entries.iter().map(|e| e.uids.len()).sum()),
        Err(e) => {
            warn!("[delete-queue] journal unreadable after the pass: {e}");
            c.failed + c.skipped
        }
    };
    c
}

/// The delete entries, in one locked read.
async fn delete_entries(state: &Arc<DaemonState>) -> Result<Vec<OpEntry>, String> {
    let st = Arc::clone(state);
    blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        op_journal::read(&st.app_dir).into_iter().filter(|e| e.op == "delete").collect::<Vec<_>>()
    })
    .await
}

/// Whether the entry's folder is a vault-only one (`vault_only_folder`, the
/// rule `submit` refuses by).
async fn vault_only(state: &Arc<DaemonState>, entry: &OpEntry) -> Result<bool, String> {
    let (st, account_id, mailbox) = (Arc::clone(state), entry.account_id.clone(), entry.mailbox.clone());
    blocking(move || vault_only_folder(&st, account_id, mailbox)).await?
}

/// Nothing can ever send this entry: clear it, say why in the log, and
/// announce the change (the app lifts the rows' tombstones from the list).
async fn drop_entry(state: &Arc<DaemonState>, entry: &OpEntry, reason: &str) {
    warn!("[delete-queue] {}/{}: {} uid(s) of entry {} dropped: {reason}", entry.account_id, entry.mailbox, entry.uids.len(), entry.id);
    let (st, id, uids) = (Arc::clone(state), entry.id, entry.uids.clone());
    let cleared = blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        st.delete_queue.wrote(1);
        op_journal::clear_by_id(&st.app_dir, id, &uids)
    })
    .await
    .and_then(|r| r);
    match cleared {
        Ok(()) => changed(state),
        Err(e) => warn!("[delete-queue] could not clear entry {}: {e}", entry.id),
    }
}

#[cfg(test)]
mod tests;
