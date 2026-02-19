use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::{ImapConfig, create_imap_session};

pub type ImapSession = async_imap::Session<async_native_tls::TlsStream<async_std::net::TcpStream>>;

/// Connection key: "email@host"
fn conn_key(config: &ImapConfig) -> String {
    format!("{}-{}", config.email, config.host)
}

/// Two-pool IMAP connection manager.
/// - Background pool: for pagination / header loading / caching
/// - Priority pool: for user-initiated single-email fetches
#[derive(Clone)]
pub struct ImapPool {
    background: Arc<Mutex<HashMap<String, ImapSession>>>,
    priority: Arc<Mutex<HashMap<String, ImapSession>>>,
}

impl ImapPool {
    pub fn new() -> Self {
        Self {
            background: Arc::new(Mutex::new(HashMap::new())),
            priority: Arc::new(Mutex::new(HashMap::new())),
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

    /// Disconnect a specific account from both pools
    pub async fn disconnect(&self, config: &ImapConfig) {
        let key = conn_key(config);
        for pool in [&self.background, &self.priority] {
            if let Some(mut session) = pool.lock().await.remove(&key) {
                let _ = session.logout().await;
            }
        }
        info!("Disconnected IMAP for {}", config.email);
    }

    /// Disconnect all connections (for app shutdown)
    pub async fn disconnect_all(&self) {
        for pool in [&self.background, &self.priority] {
            let mut guard = pool.lock().await;
            for (key, mut session) in guard.drain() {
                info!("Closing IMAP connection: {}", key);
                let _ = session.logout().await;
            }
        }
    }

    async fn get_from_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, ImapSession>>>,
        config: &ImapConfig,
    ) -> Result<ImapSession, String> {
        let key = conn_key(config);

        // Try to reuse existing connection
        if let Some(mut session) = pool.lock().await.remove(&key) {
            // Verify the session is still alive with a NOOP
            match session.noop().await {
                Ok(_) => return Ok(session),
                Err(e) => {
                    warn!("Pooled IMAP session stale for {}: {}, creating new", config.email, e);
                    let _ = session.logout().await;
                }
            }
        }

        // Create new connection
        info!("Creating new IMAP connection for {}", config.email);
        let session = create_imap_session(config).await.map_err(|e| {
            warn!("IMAP connection failed for {}: {}", config.email, e);
            e
        })?;
        Ok(session)
    }

    async fn return_to_pool(
        &self,
        pool: &Arc<Mutex<HashMap<String, ImapSession>>>,
        config: &ImapConfig,
        session: ImapSession,
    ) {
        let key = conn_key(config);
        // Logout the old session if one exists (prevents connection leak)
        if let Some(mut old) = pool.lock().await.insert(key, session) {
            let _ = old.logout().await;
        }
    }
}

impl Default for ImapPool {
    fn default() -> Self {
        Self::new()
    }
}
