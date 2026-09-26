use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, TryAcquireError};
use tokio::time::Instant;
use tracing::{info, warn};

use super::{create_imap_session, ImapConfig};

/// Trait alias for any stream type that can back an IMAP session.
/// Using a trait object allows the pool to store both plain TLS and
/// COMPRESS=DEFLATE sessions under the same `ImapSession` type.
pub trait ImapTransport:
    async_std::io::Read + async_std::io::Write + Unpin + fmt::Debug + Send {}

impl<T: async_std::io::Read + async_std::io::Write + Unpin + fmt::Debug + Send> ImapTransport
    for T
{
}

pub type ImapSession = async_imap::Session<Box<dyn ImapTransport>>;

/// Wrapper that tracks per-session metadata (last used time, selected mailbox).
pub struct PooledSession {
    pub session: ImapSession,
    pub last_used: Instant,
    pub last_selected: Option<String>,
}

/// Per-stage cost of one `run_read_timed` attempt (Task A1), logged whole by
/// `imap_get_email_light` so a slow Gmail body fetch (Track A, 2026-09-26)
/// shows which stage actually stalled instead of just a total.
///
/// `checkout` fills `permit_wait_ms`/`connect_ms`/`reused`/
/// `idle_secs_since_last_use`/`noop_ms`/`attempt`; a caller whose `f` does a
/// SELECT and a FETCH (`fetch_email_by_uid_light_timed`) fills `select_ms`/
/// `fetch_ms`/`bytes` through the same lock. `connect_ms` is 0 when `reused`
/// is true — no connect happened — and `idle_secs_since_last_use` is 0 when
/// `reused` is false, for the same reason.
///
/// `noop_ms` (Fix round 1, review of this task): the pool's own health check
/// on a session older than `NOOP_SKIP_SECS` — up to `NOOP_TIMEOUT` (15s since
/// A0) when the peer is slow rather than dead. That wait used to be invisible:
/// it happens inside `get_from_pool` and, on the common case where the slow
/// session turns out to still be alive, ends with `reused = true` and
/// `connect_ms = 0`, so none of the other fields ever charged for it. It is
/// exactly the stage the A0 daemon-log evidence blames for the 09-26 Gmail
/// stalls. 0 when the check was skipped (reused within `NOOP_SKIP_SECS`, or a
/// fresh connection was made instead of a pooled one). When the NOOP fails or
/// times out and a new connection follows, `connect_ms` counts only the new
/// connection — `noop_ms` is subtracted out — so the two fields never overlap.
#[derive(Debug, Default, Clone, Copy)]
pub struct ReadTimings {
    pub permit_wait_ms: u64,
    pub connect_ms: u64,
    pub reused: bool,
    pub idle_secs_since_last_use: u64,
    pub noop_ms: u64,
    pub select_ms: u64,
    pub fetch_ms: u64,
    pub bytes: u64,
    pub attempt: u32,
}

/// Maximum number of pooled sessions per account per pool type.
const MAX_POOL_SIZE: usize = 5;

/// Most connections this install keeps open to one account at once: pooled
/// (checked out or idle), the IDLE watcher, and every one-off session. Gmail
/// allows 15 per account across all clients; two installs on one account (a
/// backup copy, the portable build) used to go past that, and Google then
/// throttled the account to ~10s per command for hours. Two installs at 7
/// leave one for a phone.
pub const MAX_CONNECTIONS_PER_ACCOUNT: usize = 7;

/// How often a caller waiting on a full budget looks again.
const SLOT_POLL: Duration = Duration::from_millis(100);

/// Cap on the LOGOUT of an idle session closed to make room: the caller is
/// waiting on it, and a dead socket would otherwise hold it for `CMD_STALL`.
const EVICT_LOGOUT_TIMEOUT: Duration = Duration::from_secs(2);

/// Sessions used within this window skip the NOOP health check.
const NOOP_SKIP_SECS: u64 = 60;

/// Cap on the pooled-session health check. A socket the peer dropped silently
/// (laptop sleep, NAT timeout, server restart) accepts the NOOP write and then
/// never answers, so an unbounded `noop().await` stalls the caller until the
/// OS gives up on the TCP retransmits — minutes. Past this, treat the session
/// as dead and connect fresh.
///
/// 5s used to cut off a session that was merely slow: a throttled Gmail
/// account answered NOOP in ~10s, so every reuse past NOOP_SKIP_SECS dropped
/// a live session and paid a ~30s re-login instead (Track A, 2026-09-26). 15s
/// still catches a genuinely dead socket — those never answer at all — while
/// giving a throttled-but-live one room to reply.
const NOOP_TIMEOUT: Duration = Duration::from_secs(15);

/// Breather before the single connect retry — long enough to outlive a Wi-Fi
/// hiccup, short enough that a sync tick still finishes.
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Connection key: "email-host:port".
///
/// The port matters: two configs differing only by port are two different
/// servers, and pooling them together hands a session for one to the other.
fn conn_key(config: &ImapConfig) -> String {
    format!("{}-{}:{}", config.email, config.host, config.effective_port())
}

/// True when the error text says the *connection* died rather than the server
/// answering. A pooled socket the peer closed while it sat idle produces this
/// on first use and nothing else, so it is the one failure worth trying again;
/// a tagged `NO`/`BAD` is the server's answer and repeating it changes nothing.
pub fn is_connection_lost(err: &str) -> bool {
    const NEEDLES: [&str; 10] = [
        "connection lost", // async_imap::error::Error::ConnectionLost
        "connection reset",
        "connection aborted",
        // Windows' WSAECONNABORTED renders as "An established connection was
        // aborted by the software in your host machine" — the same failure
        // unix surfaces as ECONNRESET/"connection reset", but worded with an
        // extra "was" that the needle above does not catch.
        "connection was aborted",
        // Windows renders io::Error text in the system language, so the
        // English needles miss on a German or Lithuanian install; the
        // "(os error N)" suffix is the same everywhere. 10053 is
        // WSAECONNABORTED, 10054 WSAECONNRESET ("An existing connection was
        // forcibly closed by the remote host", which no needle above matches
        // even in English). No unix errno is that large.
        "os error 10053",
        "os error 10054",
        "connection closed", // the TLS layer: "closed via error" / "closed gracefully"
        "broken pipe",
        "unexpected end of file",
        "not connected",
    ];
    let lowered = err.to_ascii_lowercase();
    NEEDLES.iter().any(|n| lowered.contains(n))
}

/// A session checked out from the pool, guarded by a semaphore permit.
/// The permit is released when this guard is dropped (after return_to_pool stores
/// the session or the guard is dropped on error). This prevents connection
/// proliferation: at most MAX_POOL_SIZE concurrent sessions per account per pool type.
pub struct PooledSessionGuard {
    pub session: ImapSession,
    pub last_selected: Option<String>,
    // pub (not pub(crate)) so both binaries can destructure/rebuild the guard
    // to run IMAP ops on the session while holding the pool permit.
    pub _permit: OwnedSemaphorePermit,
}

/// Get or create a semaphore of `permits` for the given connection key.
async fn get_or_create_sem(
    sem_map: &Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    key: &str,
    permits: usize,
) -> Arc<Semaphore> {
    let mut map = sem_map.lock().await;
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(permits)))
        .clone()
}

/// Logout sessions without holding any lock.
/// Fire-and-forget: errors are silently ignored since we're just cleaning up.
async fn logout_sessions(sessions: Vec<ImapSession>) {
    for mut session in sessions {
        let _ = session.logout().await;
    }
}

/// Two-pool IMAP connection manager.
/// - Background pool: for pagination / header loading / caching
/// - Priority pool: for user-initiated single-email fetches
///
/// Each pool stores up to MAX_POOL_SIZE sessions per account to support
/// concurrent workers without constant connection create/destroy overhead.
///
/// IMPORTANT: All session logout() calls MUST happen outside the mutex lock
/// to prevent deadlocks when the IMAP server is slow/unreachable.
///
/// Also caches per-connection server capabilities and per-session last-selected mailbox.
#[derive(Clone)]
pub struct ImapPool {
    background: Arc<Mutex<HashMap<String, Vec<PooledSession>>>>,
    priority: Arc<Mutex<HashMap<String, Vec<PooledSession>>>>,
    /// Cached server capabilities per connection key (e.g. CONDSTORE, ESEARCH)
    capabilities: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// Per-account semaphores for background pool — prevents connection proliferation
    background_sem: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    /// Per-account semaphores for priority pool — separate from background to avoid blocking
    priority_sem: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    /// Per-account connection budget (`MAX_CONNECTIONS_PER_ACCOUNT`), one
    /// permit per open socket, pooled or not. See `connection_slot`.
    budget: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

impl ImapPool {
    pub fn new() -> Self {
        Self {
            background: Arc::new(Mutex::new(HashMap::new())),
            priority: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            background_sem: Arc::new(Mutex::new(HashMap::new())),
            priority_sem: Arc::new(Mutex::new(HashMap::new())),
            budget: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// One of the account's `MAX_CONNECTIONS_PER_ACCOUNT` connection slots,
    /// for a socket about to be opened. `connect_transport` takes it and the
    /// socket holds it until it closes, so every connection pays, pooled or
    /// not (IDLE, QRESYNC, the Sent-copy APPEND, the connection test).
    ///
    /// On a full budget an idle pooled session is closed to make room,
    /// background before priority: idle sessions hold slots too, and nothing
    /// else would ever close them, so a click (or a send) would otherwise wait
    /// for ever behind sessions nobody is using. With none idle, every slot is
    /// in use by live work and one frees when it ends.
    ///
    /// ponytail: polls instead of queueing on the semaphore. A queued waiter
    /// would not wake when a session goes idle instead of closing, and tokio
    /// hands a freed permit to the queue before the caller that freed it. The
    /// cost is up to `SLOT_POLL` of extra wait on a full budget; a Notify on
    /// return_to_pool is the upgrade if that ever shows up.
    pub async fn connection_slot(&self, config: &ImapConfig) -> Result<OwnedSemaphorePermit, String> {
        let budget = get_or_create_sem(&self.budget, &conn_key(config), MAX_CONNECTIONS_PER_ACCOUNT).await;
        let mut logged = false;
        loop {
            match Arc::clone(&budget).try_acquire_owned() {
                Ok(slot) => return Ok(slot),
                Err(TryAcquireError::Closed) => return Err("IMAP connection budget closed".to_string()),
                Err(TryAcquireError::NoPermits) => {}
            }
            if self.close_one_idle(config).await {
                continue;
            }
            if !logged {
                info!(
                    "[IMAP pool] {} has {} connections open, waiting for one to close",
                    config.email, MAX_CONNECTIONS_PER_ACCOUNT
                );
                logged = true;
            }
            async_io::Timer::after(SLOT_POLL).await;
        }
    }

    /// Log out the oldest idle pooled session for `config`'s account,
    /// background first. False when neither pool holds one.
    async fn close_one_idle(&self, config: &ImapConfig) -> bool {
        let key = conn_key(config);
        for pool in [&self.background, &self.priority] {
            let oldest = {
                let mut map = pool.lock().await;
                map.get_mut(&key).filter(|v| !v.is_empty()).map(|v| v.remove(0))
            };
            if let Some(mut idle) = oldest {
                info!("[IMAP pool] Closing an idle session for {} to stay within the connection budget", config.email);
                let _ = async_std::future::timeout(EVICT_LOGOUT_TIMEOUT, idle.session.logout()).await;
                return true;
            }
        }
        false
    }

    /// Get or create a background connection, guarded by a per-account semaphore.
    /// At most MAX_POOL_SIZE concurrent background sessions per account — excess callers queue.
    pub async fn get_background(&self, config: &ImapConfig) -> Result<PooledSessionGuard, String> {
        self.checkout(config, false, false, None).await
    }

    /// Get or create a priority connection, guarded by a per-account semaphore.
    /// At most MAX_POOL_SIZE concurrent priority sessions per account — excess callers queue.
    pub async fn get_priority(&self, config: &ImapConfig) -> Result<PooledSessionGuard, String> {
        self.checkout(config, true, false, None).await
    }

    /// A brand-new background connection, never a pooled one: the second
    /// attempt of `retry_once_on_dead_socket` for callers that drive the
    /// session themselves rather than through `run_read`. See `checkout`.
    pub async fn get_background_fresh(&self, config: &ImapConfig) -> Result<PooledSessionGuard, String> {
        self.checkout(config, false, true, None).await
    }

    /// Check out a session, optionally skipping the pool entirely.
    ///
    /// `fresh` is for the retry after a pooled socket turned out to be dead:
    /// popping another pooled session would likely hand back one killed by the
    /// same event (laptop sleep, NAT timeout, server restart), and its NOOP
    /// check is skipped for the first NOOP_SKIP_SECS of its life.
    ///
    /// `timings`, when given, gets `permit_wait_ms`/`connect_ms`/`reused`/
    /// `idle_secs_since_last_use`/`attempt` overwritten wholesale — this is
    /// the start of an attempt, so any `select_ms`/`fetch_ms`/`bytes` a
    /// previous attempt wrote no longer apply (Task A1).
    async fn checkout(
        &self,
        config: &ImapConfig,
        priority: bool,
        fresh: bool,
        timings: Option<&std::sync::Mutex<ReadTimings>>,
    ) -> Result<PooledSessionGuard, String> {
        let key = conn_key(config);
        let sem_map = if priority { &self.priority_sem } else { &self.background_sem };
        let sem = get_or_create_sem(sem_map, &key, MAX_POOL_SIZE).await;
        let wait_start = Instant::now();
        let permit = sem.acquire_owned().await
            .map_err(|_| "IMAP pool semaphore closed".to_string())?;
        let permit_wait_ms = wait_start.elapsed().as_millis() as u64;

        let connect_start = Instant::now();
        let (session, last_selected, reused, idle_secs_since_last_use, noop_ms) = if fresh {
            info!("Creating new IMAP connection for {} (retry)", config.email);
            (create_imap_session(config, self).await?, None, false, 0, 0)
        } else {
            let pool = if priority { &self.priority } else { &self.background };
            self.get_from_pool(pool, config).await?
        };
        // `connect_start` also spans a failed/timed-out NOOP when the pooled
        // session turned out to be dead (get_from_pool falls through to a new
        // connection in that branch) — subtract it out so `connect_ms` is
        // only the new connection, not the wasted health check too.
        let connect_ms = if reused {
            0
        } else {
            (connect_start.elapsed().as_millis() as u64).saturating_sub(noop_ms)
        };

        if let Some(t) = timings {
            *t.lock().expect("timings mutex poisoned") = ReadTimings {
                permit_wait_ms,
                connect_ms,
                reused,
                idle_secs_since_last_use,
                noop_ms,
                attempt: if fresh { 2 } else { 1 },
                select_ms: 0,
                fetch_ms: 0,
                bytes: 0,
            };
        }

        Ok(PooledSessionGuard { session, last_selected, _permit: permit })
    }

    /// Run a **read-only** IMAP operation on a pooled session, once more on a
    /// brand-new connection if the first attempt died with the socket.
    ///
    /// A pooled connection the peer closed while it sat idle accepts nothing
    /// and answers the first command with `connection lost`. No health check
    /// closes that window — the socket can die between the NOOP and the FETCH —
    /// so the only real fix is to ask again on a connection known to be new.
    /// The user used to see the raw failure and a Try again button; this is that
    /// button, pressed before they ever see it.
    ///
    /// Read-only callers ONLY. The retry re-sends the command, which is free for
    /// FETCH/SEARCH/LIST and wrong for APPEND/STORE/COPY: a mutation whose reply
    /// was lost may well have been applied, and sending it twice applies it twice.
    pub async fn run_read<F, Fut, T>(
        &self,
        config: &ImapConfig,
        priority: bool,
        f: F,
    ) -> Result<T, String>
    where
        F: Fn(ImapSession) -> Fut,
        Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
    {
        self.run_retrying(config, priority, f, None).await
    }

    /// Same as `run_read`, but writes each stage's cost into `timings` as it
    /// happens instead of only on success.
    ///
    /// A plain `Ok`/`Err` return from `run_read` cannot carry timings on the
    /// timeout path: the daemon wraps the call in `tokio::time::timeout`,
    /// which drops this future without polling it to completion, so nothing
    /// it would have *returned* ever reaches the caller. `timings` sidesteps
    /// that by being written through as each stage finishes — `checkout`
    /// fills `permit_wait_ms`/`connect_ms`/`reused`/`idle_secs_since_last_use`/
    /// `attempt` here, and the caller's own `f` (e.g.
    /// `fetch_email_by_uid_light_timed`) fills `select_ms`/`fetch_ms`/`bytes`
    /// through the same lock — so the caller can read whatever got as far as
    /// completing even after a drop. Only `imap_get_email_light`'s stall
    /// diagnostics (Task A1) need this; every other `run_read` caller keeps
    /// using the plain entry point above.
    pub async fn run_read_timed<F, Fut, T>(
        &self,
        config: &ImapConfig,
        priority: bool,
        f: F,
        timings: Option<&std::sync::Mutex<ReadTimings>>,
    ) -> Result<T, String>
    where
        F: Fn(ImapSession) -> Fut,
        Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
    {
        self.run_retrying(config, priority, f, timings).await
    }

    /// Run a **UID-addressed delete** on a pooled session, once more on a
    /// brand-new connection if the first attempt died with the socket.
    ///
    /// Same failure as `run_read` — a peer that closed the connection while it
    /// sat idle in the pool — and the user-visible shape was worse than a
    /// spinner: the row vanishes optimistically, the dead socket answers
    /// `connection lost` before the SELECT is even through, the frontend puts
    /// the row back, and a delete that was never attempted looks like a
    /// message that resurrected itself. Deleting again worked, because the
    /// failed session is discarded rather than re-pooled.
    ///
    /// `run_read`'s doc rules mutations out of that retry, and rightly: a
    /// STORE/APPEND/COPY whose reply was lost may already have been applied,
    /// and sending it twice applies it twice. A delete addressed BY UID is the
    /// exception the rule already makes elsewhere — `op_journal`'s replay
    /// re-issues exactly these commands at the next launch precisely because
    /// re-deleting a uid the server no longer has is a no-op, not a second
    /// deletion. Nothing else may use this.
    pub async fn run_uid_delete<F, Fut, T>(
        &self,
        config: &ImapConfig,
        priority: bool,
        f: F,
    ) -> Result<T, String>
    where
        F: Fn(ImapSession) -> Fut,
        Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
    {
        self.run_retrying(config, priority, f, None).await
    }

    async fn run_retrying<F, Fut, T>(
        &self,
        config: &ImapConfig,
        priority: bool,
        f: F,
        timings: Option<&std::sync::Mutex<ReadTimings>>,
    ) -> Result<T, String>
    where
        F: Fn(ImapSession) -> Fut,
        Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
    {
        retry_once_on_dead_socket(|fresh| self.attempt(config, priority, fresh, &f, timings)).await
    }

    /// One `run_read` attempt: check out, run, pool the session on success.
    /// On failure the guard is dropped — never re-pooled, see `discard`.
    async fn attempt<F, Fut, T>(
        &self,
        config: &ImapConfig,
        priority: bool,
        fresh: bool,
        f: &F,
        timings: Option<&std::sync::Mutex<ReadTimings>>,
    ) -> Result<T, String>
    where
        F: Fn(ImapSession) -> Fut,
        Fut: std::future::Future<Output = Result<(T, ImapSession, Option<String>), String>>,
    {
        let PooledSessionGuard { session, last_selected: _, _permit } =
            self.checkout(config, priority, fresh, timings).await?;
        let (result, session, selected) = f(session).await?;
        let guard = PooledSessionGuard { session, last_selected: selected, _permit };
        if priority {
            self.return_priority(config, guard).await;
        } else {
            self.return_background(config, guard).await;
        }
        Ok(result)
    }

    /// Return a background session to the pool. The semaphore permit is released
    /// after the session is stored (or discarded if pool is full).
    pub async fn return_background(&self, config: &ImapConfig, guard: PooledSessionGuard) {
        let PooledSessionGuard { session, last_selected, _permit } = guard;
        self.return_to_pool(&self.background, config, session, last_selected).await;
        // _permit drops here — semaphore released AFTER session is pooled
    }

    /// Return a priority session to the pool.
    pub async fn return_priority(&self, config: &ImapConfig, guard: PooledSessionGuard) {
        let PooledSessionGuard { session, last_selected, _permit } = guard;
        self.return_to_pool(&self.priority, config, session, last_selected).await;
    }

    /// Log a session out instead of pooling it — for sessions whose last command
    /// failed. A parse failure leaves unconsumed bytes in the read buffer, so
    /// every later command on that session reads the *previous* command's reply:
    /// a reused session once answered a UID SEARCH with 0 UIDs and the caller
    /// pruned the whole mailbox cache. Never re-pool after an error.
    pub async fn discard(&self, config: &ImapConfig, guard: PooledSessionGuard) {
        let PooledSessionGuard { mut session, .. } = guard;
        warn!("[IMAP pool] Discarding session for {} after a failed command", config.email);
        let _ = session.logout().await;
        // _permit drops here — the slot frees for a fresh connection
    }

    /// Clear all background sessions for an account (force re-auth on next use).
    /// Used during long backups to prevent OAuth2 token expiry.
    pub async fn clear_background(&self, config: &ImapConfig) {
        let key = conn_key(config);
        let mut pool = self.background.lock().await;
        if let Some(sessions) = pool.remove(&key) {
            info!("[IMAP pool] Cleared {} background sessions for {}", sessions.len(), key);
            for mut s in sessions {
                let _ = s.session.logout().await;
            }
        }
    }

    /// Check if the server supports a specific capability (case-insensitive).
    pub async fn has_capability(&self, config: &ImapConfig, cap: &str) -> bool {
        let key = conn_key(config);
        let guard = self.capabilities.lock().await;
        guard.get(&key).map_or(false, |caps| {
            caps.iter().any(|c| c.eq_ignore_ascii_case(cap))
        })
    }

    /// Cache capabilities for a connection key.
    pub async fn set_capabilities(&self, config: &ImapConfig, caps: Vec<String>) {
        let key = conn_key(config);
        info!("[IMAP pool] Caching {} capabilities for {}", caps.len(), key);
        self.capabilities.lock().await.insert(key, caps);
    }

    /// Disconnect a specific account from both pools
    pub async fn disconnect(&self, config: &ImapConfig) {
        let key = conn_key(config);
        // Collect sessions to logout OUTSIDE the lock
        let mut to_logout = Vec::new();
        for pool in [&self.background, &self.priority] {
            if let Some(pooled_sessions) = pool.lock().await.remove(&key) {
                to_logout.extend(pooled_sessions.into_iter().map(|ps| ps.session));
            }
        }
        self.capabilities.lock().await.remove(&key);
        self.background_sem.lock().await.remove(&key);
        self.priority_sem.lock().await.remove(&key);
        // Not the budget: sessions still checked out hold its permits, and a
        // fresh semaphore would let seven more connections open beside them.

        // Logout outside any lock — network I/O can be slow
        logout_sessions(to_logout).await;
        info!("Disconnected IMAP for {}", config.email);
    }

    /// Log out every pooled session across all accounts. Called on app quit and
    /// daemon shutdown so servers see a clean LOGOUT instead of holding the
    /// connection open until their idle timeout fires.
    pub async fn shutdown(&self) {
        let mut to_logout = Vec::new();
        for pool in [&self.background, &self.priority] {
            for (_, sessions) in pool.lock().await.drain() {
                to_logout.extend(sessions.into_iter().map(|ps| ps.session));
            }
        }
        self.capabilities.lock().await.clear();

        if to_logout.is_empty() {
            return;
        }
        info!("[IMAP pool] Logging out {} pooled sessions on shutdown", to_logout.len());
        logout_sessions(to_logout).await;
    }

    /// `bool`/`u64`/`u64` in the return: whether the session came from the
    /// pool, how many seconds it sat there, and how long the NOOP health
    /// check took (0 if skipped) — Task A1's `reused` / `idle_secs_since_last_use`
    /// / `noop_ms`, read by `checkout` and otherwise unused here.
    async fn get_from_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, Vec<PooledSession>>>>,
        config: &ImapConfig,
    ) -> Result<(ImapSession, Option<String>, bool, u64, u64), String> {
        let key = conn_key(config);
        // Set only when the branch below actually runs the NOOP — carried
        // forward to the fallthrough "create new connection" case too, so a
        // NOOP that timed out or came back stale still reports its cost even
        // though the session it checked is not the one returned.
        let mut noop_ms = 0u64;

        // Try to reuse existing connection from the Vec
        if let Some(pooled) = {
            let mut map = pool.lock().await;
            map.get_mut(&key).and_then(|v| v.pop())
        } {
            let mut session = pooled.session;
            let last_sel = pooled.last_selected;
            let idle_secs = pooled.last_used.elapsed().as_secs();

            // Skip NOOP if session was used recently (within NOOP_SKIP_SECS)
            if idle_secs < NOOP_SKIP_SECS {
                return Ok((session, last_sel, true, idle_secs, 0));
            }

            // Verify the session is still alive with a NOOP (outside lock).
            // Both the NOOP and the follow-up logout are bounded: a half-open
            // socket answers neither. Timed regardless of outcome (Fix round
            // 1): a slow-but-alive reply can take up to NOOP_TIMEOUT, and that
            // wait is exactly what A0 raised the timeout to tolerate — it must
            // show up in `noop_ms` even when the session is kept and reused.
            let noop_start = Instant::now();
            let noop_result = tokio::time::timeout(NOOP_TIMEOUT, session.noop()).await;
            noop_ms = noop_start.elapsed().as_millis() as u64;
            match noop_result {
                Ok(Ok(_)) => return Ok((session, last_sel, true, idle_secs, noop_ms)),
                Ok(Err(e)) => {
                    warn!("Pooled IMAP session stale for {}: {}, creating new", config.email, e);
                    let _ = tokio::time::timeout(NOOP_TIMEOUT, session.logout()).await;
                }
                Err(_) => {
                    warn!(
                        "Pooled IMAP session for {} did not answer NOOP within {}s — dropping it",
                        config.email,
                        NOOP_TIMEOUT.as_secs()
                    );
                    // No logout: the same dead socket would swallow that too.
                    drop(session);
                }
            }
        }

        // Create new connection (capabilities cached inside create_imap_session).
        // One retry: a handshake torn down by a network blip fails the whole
        // sync cycle otherwise, and every account on the machine hits it at once.
        info!("Creating new IMAP connection for {}", config.email);
        let session = retry_once_on_transient(CONNECT_RETRY_DELAY, || {
            create_imap_session(config, self)
        })
        .await
        .map_err(|e| {
            warn!("IMAP connection failed for {}: {}", config.email, e);
            e
        })?;
        Ok((session, None, false, 0, noop_ms))
    }

    async fn return_to_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, Vec<PooledSession>>>>,
        config: &ImapConfig,
        session: ImapSession,
        last_selected: Option<String>,
    ) {
        let key = conn_key(config);

        // Check pool capacity and either store or mark for logout — all under lock
        let excess = {
            let mut map = pool.lock().await;
            let vec = map.entry(key).or_default();
            if vec.len() < MAX_POOL_SIZE {
                vec.push(PooledSession {
                    session,
                    last_used: Instant::now(),
                    last_selected,
                });
                None
            } else {
                Some(session)
            }
        };
        // Lock is dropped here ↑

        // Logout excess session OUTSIDE the lock — network I/O can be slow/hang
        if let Some(mut s) = excess {
            let _ = s.logout().await;
        }
    }
}

impl Default for ImapPool {
    fn default() -> Self {
        Self::new()
    }
}

/// True when a *fresh connect* failed for a transport reason worth one retry —
/// TLS handshake torn down mid-negotiation, TCP/DNS blip, socket already dead.
/// A rejected credential is the server's answer: repeating it only burns
/// login attempts, so auth failures are never retryable.
pub fn is_retryable_connect_error(err: &str) -> bool {
    const NEEDLES: [&str; 4] = [
        "tls handshake",       // both the direct-TLS and the STARTTLS wrap
        "tcp connect",
        "dns resolve failed",
        "user canceled",       // Security.framework's word for a torn-down handshake
    ];
    let lowered = err.to_ascii_lowercase();
    is_connection_lost(err) || NEEDLES.iter().any(|n| lowered.contains(n))
}

/// Run `attempt(false)` on a pooled session and, if it died with the socket,
/// `attempt(true)` once more — the flag tells the caller to check out a
/// brand-new connection (`get_background_fresh`) rather than another pooled
/// one killed by the same event. Anything else returns its first error.
///
/// For read-only work: the second attempt re-sends every command.
pub async fn retry_once_on_dead_socket<T, F, Fut>(attempt: F) -> Result<T, String>
where
    F: Fn(bool) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match attempt(false).await {
        Err(e) if is_connection_lost(&e) => {
            warn!("[IMAP pool] {} — retrying once on a new connection", e);
            attempt(true).await
        }
        other => other,
    }
}

/// Run `attempt`, and on a transient transport failure run it once more after
/// `delay`. Anything else (auth, a tagged NO) returns its first error.
pub async fn retry_once_on_transient<T, F, Fut>(
    delay: Duration,
    mut attempt: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match attempt().await {
        Err(e) if is_retryable_connect_error(&e) => {
            warn!("[IMAP pool] {} — retrying once in {:?}", e, delay);
            tokio::time::sleep(delay).await;
            attempt().await
        }
        other => other,
    }
}

#[cfg(test)]
mod connect_retry_tests {
    use super::*;
    use std::cell::Cell;

    const TLS_CLOSED: &str = "TLS handshake with imap.gmail.com failed: connection closed via error";
    const TLS_CANCELED: &str = "TLS handshake with imap.purelymail.com failed: user canceled";
    const AUTH: &str = "Login failed for butcher@graphicmeat.com: NO [AUTHENTICATIONFAILED] Invalid credentials";
    const OAUTH: &str = "XOAUTH2 auth failed for thecoldzero@gmail.com: NO Invalid credentials (Failure)";

    #[test]
    fn a_torn_down_tls_handshake_is_retryable() {
        assert!(is_retryable_connect_error(TLS_CLOSED));
        assert!(is_retryable_connect_error(TLS_CANCELED));
    }

    #[test]
    fn tcp_and_dns_blips_are_retryable() {
        assert!(is_retryable_connect_error(
            "TCP connect to imap.zoho.com:993 failed: future timed out"
        ));
        assert!(is_retryable_connect_error(
            "DNS resolve failed for imap.zoho.com:993: nodename nor servname provided"
        ));
    }

    #[test]
    fn a_dead_socket_is_retryable() {
        assert!(is_retryable_connect_error("SELECT INBOX failed: io: Broken pipe (os error 32)"));
        assert!(is_connection_lost("SELECT INBOX failed: io: Broken pipe (os error 32)"));
        assert!(is_connection_lost("SELECT CONDSTORE INBOX failed: io: connection closed gracefully"));
        assert!(is_connection_lost("SELECT INBOX failed: connection lost"));
    }

    #[test]
    fn a_windows_localized_connection_error_is_still_a_dead_socket() {
        // WSAECONNRESET, rendered in German — the English needles above
        // ("connection reset"/"connection aborted") match nothing here; only
        // the locale-independent "(os error 10054)" suffix does.
        assert!(is_connection_lost(
            "SELECT INBOX failed: io: Eine vorhandene Verbindung wurde vom Remotehost geschlossen. (os error 10054)"
        ));
        // WSAECONNRESET in English.
        assert!(is_connection_lost(
            "SELECT INBOX failed: io: An existing connection was forcibly closed by the remote host. (os error 10054)"
        ));
        // WSAECONNABORTED in English.
        assert!(is_connection_lost(
            "SELECT INBOX failed: io: An established connection was aborted by the software in your host machine. (os error 10053)"
        ));
        // A tagged server answer is not a dead socket, in any language.
        assert!(!is_connection_lost(
            "Login failed for butcher@graphicmeat.com: NO [AUTHENTICATIONFAILED] Invalid credentials"
        ));
    }

    #[test]
    fn a_rejected_credential_is_never_retryable() {
        assert!(!is_retryable_connect_error(AUTH));
        assert!(!is_retryable_connect_error(OAUTH));
        assert!(!is_retryable_connect_error("Password missing"));
        assert!(!is_retryable_connect_error("OAuth2 access token missing"));
    }

    #[tokio::test]
    async fn a_transient_failure_is_tried_once_more() {
        let calls = Cell::new(0);
        let out: Result<&str, String> = retry_once_on_transient(Duration::ZERO, || {
            calls.set(calls.get() + 1);
            let first = calls.get() == 1;
            async move {
                if first { Err(TLS_CLOSED.to_string()) } else { Ok("session") }
            }
        })
        .await;

        assert_eq!(out, Ok("session"));
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn two_transient_failures_return_the_second_error() {
        let calls = Cell::new(0);
        let out: Result<&str, String> = retry_once_on_transient(Duration::ZERO, || {
            calls.set(calls.get() + 1);
            async move { Err(TLS_CANCELED.to_string()) }
        })
        .await;

        assert_eq!(out, Err(TLS_CANCELED.to_string()));
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn a_rejected_credential_is_not_tried_again() {
        let calls = Cell::new(0);
        let out: Result<&str, String> = retry_once_on_transient(Duration::ZERO, || {
            calls.set(calls.get() + 1);
            async move { Err(AUTH.to_string()) }
        })
        .await;

        assert_eq!(out, Err(AUTH.to_string()));
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn a_first_try_that_works_is_not_repeated() {
        let calls = Cell::new(0);
        let out: Result<&str, String> = retry_once_on_transient(Duration::ZERO, || {
            calls.set(calls.get() + 1);
            async move { Ok("session") }
        })
        .await;

        assert_eq!(out, Ok("session"));
        assert_eq!(calls.get(), 1);
    }
}

#[cfg(test)]
mod read_retry_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn permanent_no_is_not_retried() {
        let calls = AtomicUsize::new(0);
        let result = retry_once_on_dead_socket(|_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>("NO no such mailbox".into())
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dead_socket_is_retried_exactly_once() {
        let calls = AtomicUsize::new(0);
        let result = retry_once_on_dead_socket(|fresh| {
            let calls = &calls;
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                if fresh {
                    Ok("new session")
                } else {
                    Err("connection lost".into())
                }
            }
        })
        .await;
        assert_eq!(result, Ok("new session"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

/// The NOOP health-check timeout, exercised against a real (mock) server —
/// `#[tokio::test]` because the NOOP branch is the only pool path that awaits
/// `tokio::time::timeout`, and a plain `#[async_std::test]` has no tokio
/// runtime under it for that call to find.
///
/// Lives inside `pool.rs` rather than `src-core/tests/` so it can backdate a
/// pooled session's `last_used` directly — `#[cfg(test)]` items here are
/// invisible to the separate integration-test binaries.
#[cfg(test)]
mod noop_timeout_tests {
    use super::*;
    use mock_imap::state::synthetic_mailbox;
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    pub(super) fn config_for(server: &MockImap) -> ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(serde_json::json!({
            // Not `user@example.com`: the transfer-stats tests in this binary
            // read that account's bytes from the process-global counters,
            // which every connection here feeds.
            "email": "noop-pool@example.com",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
            "imapSecure": true,
        }))
        .expect("build ImapConfig")
    }

    /// Backdate every pooled background session for `config` so the next
    /// checkout's reuse check sees it as older than `age` — past
    /// NOOP_SKIP_SECS, that forces the NOOP health check to run instead of
    /// being skipped.
    async fn age_pooled_sessions(pool: &ImapPool, config: &ImapConfig, age: Duration) {
        let key = conn_key(config);
        let mut map = pool.background.lock().await;
        if let Some(sessions) = map.get_mut(&key) {
            for s in sessions.iter_mut() {
                s.last_used = Instant::now() - age;
            }
        }
    }

    /// A live Gmail session under throttle answers NOOP in ~10s (Track A,
    /// 2026-09-26 daemon log). At the old 5s timeout that read as dead: the
    /// session was dropped and the next checkout paid a fresh login, a second
    /// TCP connection. At 15s the slow-but-live NOOP is given time to answer,
    /// so the session is reused and the checkout costs zero connections.
    #[tokio::test]
    async fn a_slow_but_live_noop_keeps_the_pooled_session() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .fault(Trigger::on("NOOP"), Action::Delay(Duration::from_secs(6))),
        );
        let config = config_for(&server);
        let pool = ImapPool::new();

        let guard = pool.get_background(&config).await.expect("first checkout");
        let after_first = server.connection_count();
        pool.return_background(&config, guard).await;

        age_pooled_sessions(&pool, &config, Duration::from_secs(NOOP_SKIP_SECS + 1)).await;

        let guard = pool
            .get_background(&config)
            .await
            .expect("second checkout must survive a slow-but-live NOOP");
        pool.return_background(&config, guard).await;

        assert_eq!(
            server.connection_count(),
            after_first,
            "a slow but live NOOP must not force a relogin"
        );
    }

    /// A pooled socket that died in the pool answers neither NOOP nor LOGOUT.
    /// `CMD_STALL` fails the NOOP as a lost connection at about the same
    /// moment `NOOP_TIMEOUT` would, and the stale-session branch then logs
    /// out. That LOGOUT must not wait out a second `CMD_STALL` (it does not:
    /// async-imap stops reading a stream after its first read error), so a
    /// dead reused session costs one wait, then a fresh connection.
    #[tokio::test]
    async fn a_dead_pooled_session_costs_one_noop_wait_not_two() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .fault(Trigger::on("NOOP"), Action::Delay(Duration::from_secs(40))),
        );
        let config = config_for(&server);
        let pool = ImapPool::new();

        let guard = pool.get_background(&config).await.expect("first checkout");
        pool.return_background(&config, guard).await;
        age_pooled_sessions(&pool, &config, Duration::from_secs(NOOP_SKIP_SECS + 1)).await;

        let guard = tokio::time::timeout(NOOP_TIMEOUT + Duration::from_secs(3), pool.get_background(&config))
            .await
            .expect("a dead pooled session must cost one NOOP wait, not a LOGOUT wait on top")
            .expect("a fresh connection replaces it");
        pool.return_background(&config, guard).await;
        assert_eq!(server.connection_count(), 2, "the dead session was replaced");
    }

    /// Fix round 1 (review of this task): the NOOP wait used to vanish —
    /// `reused = true` and `connect_ms = 0` charged it to nothing. It is
    /// exactly the stage the A0 evidence blames for the Gmail stalls, so it
    /// needs its own field rather than silently undercounting the total.
    #[tokio::test]
    async fn a_slow_but_live_noop_reports_its_cost_as_noop_ms() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .fault(Trigger::on("NOOP"), Action::Delay(Duration::from_secs(6))),
        );
        let config = config_for(&server);
        let pool = ImapPool::new();

        let guard = pool.get_background(&config).await.expect("first checkout");
        pool.return_background(&config, guard).await;
        age_pooled_sessions(&pool, &config, Duration::from_secs(NOOP_SKIP_SECS + 1)).await;

        let timings = std::sync::Mutex::new(ReadTimings::default());
        let guard = pool
            .checkout(&config, false, false, Some(&timings))
            .await
            .expect("second checkout must survive the slow NOOP");
        pool.return_background(&config, guard).await;

        let t = *timings.lock().unwrap();
        assert!(t.reused, "the slow-but-live session must still be the one reused");
        assert_eq!(t.connect_ms, 0, "no connect happened on a reused session");
        assert!(
            t.noop_ms >= 5_000,
            "the 6s NOOP delay must show up in noop_ms, not vanish into connect_ms=0: got {}",
            t.noop_ms
        );
    }
}

/// The per-account connection budget (Task A6), against the mock's own count
/// of connections open at once.
#[cfg(test)]
mod connection_budget_tests {
    use super::noop_timeout_tests::config_for;
    use super::*;
    use crate::imap::{create_imap_session, select_mailbox};
    use mock_imap::state::synthetic_mailbox;
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    /// Six clicks and six background reads at once. Each lane alone caps at
    /// MAX_POOL_SIZE, so the two together used to open ten connections to
    /// one account; two installs like that went past Gmail's fifteen.
    #[tokio::test]
    async fn twelve_concurrent_reads_open_at_most_seven_connections() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(synthetic_mailbox("INBOX", 1))
                .fault(Trigger::on("SELECT"), Action::Delay(Duration::from_millis(300))),
        );
        let config = config_for(&server);
        let pool = ImapPool::new();

        let reads = (0..12).map(|i| {
            pool.run_read(&config, i % 2 == 0, |mut session| async move {
                select_mailbox(&mut session, "INBOX").await?;
                Ok(((), session, Some("INBOX".to_string())))
            })
        });
        let results = tokio::time::timeout(Duration::from_secs(30), futures::future::join_all(reads))
            .await
            .expect("every read finishes");

        assert!(results.iter().all(Result::is_ok), "all twelve complete: {results:?}");
        assert!(
            server.peak_connections() <= MAX_CONNECTIONS_PER_ACCOUNT,
            "peak {} connections, budget {}",
            server.peak_connections(),
            MAX_CONNECTIONS_PER_ACCOUNT
        );
    }

    /// A full budget of which five are idle background sessions: a click must
    /// not wait behind sessions nobody is using. One idle background session
    /// is closed to make room, and the click gets its connection at once.
    #[tokio::test]
    async fn a_click_on_a_full_budget_closes_an_idle_background_session() {
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let config = config_for(&server);
        let pool = ImapPool::new();

        let mut guards = Vec::new();
        for _ in 0..MAX_POOL_SIZE {
            guards.push(pool.get_background(&config).await.expect("background checkout"));
        }
        // Held outside both pools for the whole test, as the IDLE watcher and
        // a Sent-copy APPEND hold theirs.
        let _idle = create_imap_session(&config, &pool).await.expect("unpooled session");
        let _append = create_imap_session(&config, &pool).await.expect("unpooled session");
        for guard in guards {
            pool.return_background(&config, guard).await;
        }

        let started = Instant::now();
        let click = tokio::time::timeout(Duration::from_secs(5), pool.get_priority(&config))
            .await
            .expect("a click must not wait behind idle sessions")
            .expect("priority checkout");
        assert!(started.elapsed() < Duration::from_secs(1), "took {:?}", started.elapsed());

        let idle_background = pool.background.lock().await.get(&conn_key(&config)).map_or(0, Vec::len);
        assert_eq!(idle_background, MAX_POOL_SIZE - 1, "exactly one idle background session made room");
        assert!(server.peak_connections() <= MAX_CONNECTIONS_PER_ACCOUNT, "peak {}", server.peak_connections());
        pool.return_priority(&config, click).await;
    }
}
