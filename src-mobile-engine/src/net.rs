//! The engine's network side: the one place it drives mailvault-core's futures.
//!
//! Core's IMAP code runs on async-std (sockets, timers through async-io), but some of its
//! timeouts are tokio timers and its pool may spawn on the current tokio handle. So every core
//! future runs on the calling thread under async-std's `block_on`, inside the context of one
//! process-wide tokio runtime whose worker keeps that runtime's timer driver turning.

use mailvault_core::imap::{self, ImapConfig, ImapPool};
use std::future::Future;
use std::sync::OnceLock;

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("mv-engine-tokio")
            .enable_all()
            .build()
            .expect("mobile engine: tokio runtime")
    })
}

/// Runs `f` to completion on the calling thread. Never call it from inside an async context.
/// The tokio context covers polling only: a tokio timer must be created inside `f` (an `async`
/// block or `async fn`), not built eagerly as the argument.
pub(crate) fn block_on<F: Future>(f: F) -> F::Output {
    let _ctx = runtime().enter();
    async_std::task::block_on(f)
}

/// Core's connection settings for a password account. `security` is `ssl`, `starttls` or `none`.
/// The error names the problem, never the password.
pub(crate) fn imap_config(host: &str, port: u16, user: &str, password: &str, security: &str) -> Result<ImapConfig, String> {
    serde_json::from_value(serde_json::json!({
        "email": user,
        "password": password,
        "imapHost": host,
        "imapPort": port,
        "imapSecurity": security,
    }))
    .map_err(|_| "imap settings do not read".to_string())
}

/// Signs in to `host:port` with a password and returns INBOX's message count. `security` is
/// `ssl`, `starttls` or `none` (core's `imapSecurity`). The one connect path for the engine's login
/// tests (`mobile.accounts.*`, `tests/net.rs`); the secret never leaves this call, and the errors
/// are core's strings, which carry the account address but never the password.
#[doc(hidden)]
pub fn test_login(host: &str, port: u16, user: &str, password: &str, security: &str) -> Result<u32, String> {
    let config = imap_config(host, port, user, password, security)?;
    block_on(async {
        let pool = ImapPool::new();
        let mut session = imap::create_imap_session(&config, &pool).await?;
        let mailbox = imap::select_mailbox(&mut session, "INBOX").await;
        let _ = session.logout().await;
        Ok(mailbox?.exists)
    })
}

/// What `mobile.debug.probe` found: did the name resolve, did a TLS handshake through core's
/// TLS seam (native-tls on iOS, rustls with the platform verifier on Android) succeed.
#[cfg(feature = "perf-gate")]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Probe {
    pub dns: bool,
    pub tls: bool,
    pub error: Option<String>,
}

#[cfg(feature = "perf-gate")]
async fn step<T, E: std::fmt::Display>(
    what: &str,
    limit: std::time::Duration,
    fut: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match async_std::future::timeout(limit, fut).await {
        Ok(r) => r.map_err(|e| format!("{what}: {e}")),
        Err(_) => Err(format!("{what}: timed out after {}s", limit.as_secs())),
    }
}

/// DNS, TCP and a full certificate-validating TLS handshake to `host:port`; no IMAP traffic.
#[cfg(feature = "perf-gate")]
pub(crate) fn probe(host: &str, port: u16) -> Probe {
    use async_std::net::{TcpStream, ToSocketAddrs};
    block_on(async {
        let mut out = Probe { dns: false, tls: false, error: None };
        let addrs: Vec<_> = match step("dns", imap::DNS_TIMEOUT, (host, port).to_socket_addrs()).await {
            Ok(a) => a.collect(),
            Err(e) => {
                out.error = Some(e);
                return out;
            }
        };
        out.dns = !addrs.is_empty();
        if !out.dns {
            out.error = Some(format!("dns: no address for {host}"));
            return out;
        }
        let result = async {
            let tcp = step("tcp", imap::TCP_CONNECT_TIMEOUT, TcpStream::connect(&addrs[..])).await?;
            step("tls", imap::TLS_TIMEOUT, imap::tls::connect(host, tcp, false)).await
        }
        .await;
        match result {
            Ok(_) => out.tls = true,
            Err(e) => out.error = Some(e),
        }
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_on_drives_tokio_timers() {
        let t0 = std::time::Instant::now();
        // Built inside the future: `tokio::time::sleep` registers its timer when called, so it
        // must run within the context `block_on` enters.
        block_on(async { tokio::time::sleep(std::time::Duration::from_millis(10)).await });
        assert!(t0.elapsed() >= std::time::Duration::from_millis(10));
    }
}
