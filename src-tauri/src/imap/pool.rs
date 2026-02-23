use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use tokio::sync::Mutex;
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
}

impl ImapPool {
    pub fn new() -> Self {
        Self {
            background: Arc::new(Mutex::new(HashMap::new())),
            priority: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get or create a background connection.
    /// Returns (session, last_selected_mailbox) so callers can skip redundant SELECT.
    pub async fn get_background(&self, config: &ImapConfig) -> Result<(ImapSession, Option<String>), String> {
        self.get_from_pool(&self.background, config).await
    }

    /// Get or create a priority connection.
    /// Returns (session, last_selected_mailbox) so callers can skip redundant SELECT.
    pub async fn get_priority(&self, config: &ImapConfig) -> Result<(ImapSession, Option<String>), String> {
        self.get_from_pool(&self.priority, config).await
    }

    /// Return a session to the background pool for reuse.
    /// `last_selected` records which mailbox was last SELECTed on this session.
    pub async fn return_background(&self, config: &ImapConfig, session: ImapSession, last_selected: Option<String>) {
        self.return_to_pool(&self.background, config, session, last_selected).await;
    }

    /// Return a session to the priority pool for reuse.
    pub async fn return_priority(&self, config: &ImapConfig, session: ImapSession, last_selected: Option<String>) {
        self.return_to_pool(&self.priority, config, session, last_selected).await;
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
