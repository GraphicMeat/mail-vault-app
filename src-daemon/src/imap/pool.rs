use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tracing::{info, warn};

use super::{ImapConfig, create_imap_session};

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

/// Maximum number of pooled sessions per account per pool type.
const MAX_POOL_SIZE: usize = 3;

/// Sessions used within this window skip the NOOP health check.
const NOOP_SKIP_SECS: u64 = 60;

/// Connection key: "email@host"
fn conn_key(config: &ImapConfig) -> String {
    format!("{}-{}", config.email, config.host)
}

/// A session checked out from the pool, guarded by a semaphore permit.
/// The permit is released when this guard is dropped (after return_to_pool stores
/// the session or the guard is dropped on error). This prevents connection
/// proliferation: at most MAX_POOL_SIZE concurrent sessions per account per pool type.
pub struct PooledSessionGuard {
    pub session: ImapSession,
    pub last_selected: Option<String>,
    pub(crate) _permit: OwnedSemaphorePermit,
}

/// Get or create a semaphore for the given connection key.
async fn get_or_create_sem(
    sem_map: &Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    key: &str,
) -> Arc<Semaphore> {
    let mut map = sem_map.lock().await;
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_POOL_SIZE)))
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
}

impl ImapPool {
    pub fn new() -> Self {
        Self {
            background: Arc::new(Mutex::new(HashMap::new())),
            priority: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            background_sem: Arc::new(Mutex::new(HashMap::new())),
            priority_sem: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get or create a background connection, guarded by a per-account semaphore.
    /// At most MAX_POOL_SIZE concurrent background sessions per account — excess callers queue.
    pub async fn get_background(&self, config: &ImapConfig) -> Result<PooledSessionGuard, String> {
        let key = conn_key(config);
        let sem = get_or_create_sem(&self.background_sem, &key).await;
        let permit = sem.acquire_owned().await
            .map_err(|_| "IMAP background pool semaphore closed".to_string())?;
        let (session, last_selected) = self.get_from_pool(&self.background, config).await?;
        Ok(PooledSessionGuard { session, last_selected, _permit: permit })
    }

    /// Get or create a priority connection, guarded by a per-account semaphore.
    /// At most MAX_POOL_SIZE concurrent priority sessions per account — excess callers queue.
    pub async fn get_priority(&self, config: &ImapConfig) -> Result<PooledSessionGuard, String> {
        let key = conn_key(config);
        let sem = get_or_create_sem(&self.priority_sem, &key).await;
        let permit = sem.acquire_owned().await
            .map_err(|_| "IMAP priority pool semaphore closed".to_string())?;
        let (session, last_selected) = self.get_from_pool(&self.priority, config).await?;
        Ok(PooledSessionGuard { session, last_selected, _permit: permit })
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

        // Logout outside any lock — network I/O can be slow
        logout_sessions(to_logout).await;
        info!("Disconnected IMAP for {}", config.email);
    }

    /// Disconnect all connections (for app shutdown)
    #[allow(dead_code)]
    pub async fn disconnect_all(&self) {
        // Drain all sessions from both pools under the lock, then logout outside
        let mut to_logout = Vec::new();
        for pool in [&self.background, &self.priority] {
            let mut guard = pool.lock().await;
            for (key, pooled_sessions) in guard.drain() {
                info!("Closing {} IMAP connection(s): {}", pooled_sessions.len(), key);
                to_logout.extend(pooled_sessions.into_iter().map(|ps| ps.session));
            }
        }
        self.capabilities.lock().await.clear();
        self.background_sem.lock().await.clear();
        self.priority_sem.lock().await.clear();

        // Logout outside any lock
        logout_sessions(to_logout).await;
    }

    async fn get_from_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, Vec<PooledSession>>>>,
        config: &ImapConfig,
    ) -> Result<(ImapSession, Option<String>), String> {
        let key = conn_key(config);

        // Try to reuse existing connection from the Vec
        if let Some(pooled) = {
            let mut map = pool.lock().await;
            map.get_mut(&key).and_then(|v| v.pop())
        } {
            let mut session = pooled.session;
            let last_sel = pooled.last_selected;

            // Skip NOOP if session was used recently (within NOOP_SKIP_SECS)
            if pooled.last_used.elapsed().as_secs() < NOOP_SKIP_SECS {
                return Ok((session, last_sel));
            }

            // Verify the session is still alive with a NOOP (outside lock)
            match session.noop().await {
                Ok(_) => return Ok((session, last_sel)),
                Err(e) => {
                    warn!("Pooled IMAP session stale for {}: {}, creating new", config.email, e);
                    let _ = session.logout().await;
                }
            }
        }

        // Create new connection (capabilities cached inside create_imap_session)
        info!("Creating new IMAP connection for {}", config.email);
        let session = create_imap_session(config, self).await.map_err(|e| {
            warn!("IMAP connection failed for {}: {}", config.email, e);
            e
        })?;
        Ok((session, None))
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
