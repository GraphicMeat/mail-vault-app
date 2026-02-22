use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use tokio::sync::Mutex;
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

/// Maximum number of pooled sessions per account per pool type.
const MAX_POOL_SIZE: usize = 3;

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
/// Also caches per-connection server capabilities and last-selected mailbox.
#[derive(Clone)]
pub struct ImapPool {
    background: Arc<Mutex<HashMap<String, Vec<ImapSession>>>>,
    priority: Arc<Mutex<HashMap<String, Vec<ImapSession>>>>,
    /// Cached server capabilities per connection key (e.g. CONDSTORE, ESEARCH)
    capabilities: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// Last-selected mailbox per connection key — used to skip redundant SELECT
    last_selected: Arc<Mutex<HashMap<String, String>>>,
}

impl ImapPool {
    pub fn new() -> Self {
        Self {
            background: Arc::new(Mutex::new(HashMap::new())),
            priority: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            last_selected: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get or create a background connection
    pub async fn get_background(&self, config: &ImapConfig) -> Result<ImapSession, String> {
        self.get_from_pool(&self.background, config).await
    }

    /// Get or create a priority connection
    pub async fn get_priority(&self, config: &ImapConfig) -> Result<ImapSession, String> {
        self.get_from_pool(&self.priority, config).await
    }

    /// Return a session to the background pool for reuse
    pub async fn return_background(&self, config: &ImapConfig, session: ImapSession) {
        self.return_to_pool(&self.background, config, session).await;
    }

    /// Return a session to the priority pool for reuse
    pub async fn return_priority(&self, config: &ImapConfig, session: ImapSession) {
        self.return_to_pool(&self.priority, config, session).await;
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

    /// Get the last-selected mailbox for a connection key.
    pub async fn get_last_selected(&self, config: &ImapConfig) -> Option<String> {
        let key = conn_key(config);
        self.last_selected.lock().await.get(&key).cloned()
    }

    /// Record which mailbox was last SELECTed for a connection key.
    pub async fn set_last_selected(&self, config: &ImapConfig, mailbox: &str) {
        let key = conn_key(config);
        self.last_selected.lock().await.insert(key, mailbox.to_string());
    }

    /// Clear last-selected tracking for a connection key (on stale session).
    pub async fn clear_last_selected(&self, config: &ImapConfig) {
        let key = conn_key(config);
        self.last_selected.lock().await.remove(&key);
    }

    /// Disconnect a specific account from both pools
    pub async fn disconnect(&self, config: &ImapConfig) {
        let key = conn_key(config);
        // Collect sessions to logout OUTSIDE the lock
        let mut to_logout = Vec::new();
        for pool in [&self.background, &self.priority] {
            if let Some(sessions) = pool.lock().await.remove(&key) {
                to_logout.extend(sessions);
            }
        }
        self.capabilities.lock().await.remove(&key);
        self.last_selected.lock().await.remove(&key);

        // Logout outside any lock — network I/O can be slow
        logout_sessions(to_logout).await;
        info!("Disconnected IMAP for {}", config.email);
    }

    /// Disconnect all connections (for app shutdown)
    pub async fn disconnect_all(&self) {
        // Drain all sessions from both pools under the lock, then logout outside
        let mut to_logout = Vec::new();
        for pool in [&self.background, &self.priority] {
            let mut guard = pool.lock().await;
            for (key, sessions) in guard.drain() {
                info!("Closing {} IMAP connection(s): {}", sessions.len(), key);
                to_logout.extend(sessions);
            }
        }
        self.capabilities.lock().await.clear();
        self.last_selected.lock().await.clear();

        // Logout outside any lock
        logout_sessions(to_logout).await;
    }

    async fn get_from_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, Vec<ImapSession>>>>,
        config: &ImapConfig,
    ) -> Result<ImapSession, String> {
        let key = conn_key(config);

        // Try to reuse existing connection from the Vec
        if let Some(mut session) = {
            let mut map = pool.lock().await;
            map.get_mut(&key).and_then(|v| v.pop())
        } {
            // Verify the session is still alive with a NOOP (outside lock)
            match session.noop().await {
                Ok(_) => return Ok(session),
                Err(e) => {
                    warn!("Pooled IMAP session stale for {}: {}, creating new", config.email, e);
                    let _ = session.logout().await;
                    // Clear cached state for stale connection
                    self.last_selected.lock().await.remove(&key);
                }
            }
        }

        // Create new connection (capabilities cached inside create_imap_session)
        info!("Creating new IMAP connection for {}", config.email);
        let session = create_imap_session(config, self).await.map_err(|e| {
            warn!("IMAP connection failed for {}: {}", config.email, e);
            e
        })?;
        Ok(session)
    }

    async fn return_to_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, Vec<ImapSession>>>>,
        config: &ImapConfig,
        session: ImapSession,
    ) {
        let key = conn_key(config);

        // Check pool capacity and either store or mark for logout — all under lock
        let excess = {
            let mut map = pool.lock().await;
            let vec = map.entry(key).or_default();
            if vec.len() < MAX_POOL_SIZE {
                vec.push(session);
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
