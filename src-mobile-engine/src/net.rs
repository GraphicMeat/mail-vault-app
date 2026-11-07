//! The engine's network side: the one place it drives mailvault-core's futures.
//!
//! Core's IMAP code runs on async-std (sockets, timers through async-io), but some of its
//! timeouts are tokio timers and its pool may spawn on the current tokio handle. So every core
//! future runs on the calling thread under async-std's `block_on`, inside the context of one
//! process-wide tokio runtime whose worker keeps that runtime's timer driver turning.

use crate::accounts::AccountRow;
use crate::secrets::Credential;
use mailvault_core::imap::{self, ImapConfig, ImapPool};
use serde_json::{json, Value};
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

/// Core's connection settings (`ImapConfig`'s JSON) for `account` signed in with `cred`: the
/// password, or for `auth = oauth2` the access token (`authType`/`oauth2AccessToken`), plus the
/// SMTP fields when the row has an SMTP host. Core reads `smtpSecure` as implicit TLS, so only
/// `smtp_security = ssl` sets it.
pub(crate) fn imap_config(account: &AccountRow, cred: &Credential) -> Value {
    let mut v = json!({
        "email": account.email,
        "imapHost": account.imap_host,
        "imapPort": account.imap_port,
        "imapSecurity": account.security,
    });
    if account.auth == "oauth2" {
        v["authType"] = json!("oauth2");
        v["oauth2AccessToken"] = json!(cred.access);
    } else {
        v["password"] = json!(cred.password);
    }
    if let Some(host) = &account.smtp_host {
        v["smtpHost"] = json!(host);
        v["smtpPort"] = json!(account.smtp_port);
        v["smtpSecure"] = json!(account.smtp_security.as_deref() == Some("ssl"));
    }
    v
}

/// [`imap_config`] as core's type. The error names the problem, never a secret (serde's own
/// messages can quote a value, so they are dropped).
pub(crate) fn core_config(account: &AccountRow, cred: &Credential) -> Result<ImapConfig, String> {
    serde_json::from_value(imap_config(account, cred)).map_err(|_| "imap settings do not read".to_string())
}

/// Signs in to `account` with `cred` and returns INBOX's message count. The one connect path for
/// the engine's login tests (`mobile.accounts.*`, `tests/net.rs`); the secret never leaves this
/// call, and the errors are core's strings, which carry the account address but never the secret.
pub(crate) fn login(account: &AccountRow, cred: &Credential) -> Result<u32, String> {
    let config = core_config(account, cred)?;
    block_on(async {
        let pool = ImapPool::new();
        let mut session = imap::create_imap_session(&config, &pool).await?;
        let mailbox = imap::select_mailbox(&mut session, "INBOX").await;
        let _ = session.logout().await;
        Ok(mailbox?.exists)
    })
}

/// Signs in to `account`'s SMTP server (connect, TLS, AUTH; no mail sent) through core's probe.
/// `smtp_security = ssl` is core's implicit TLS (`smtpSecure`); `starttls` upgrades in the
/// session, and core also takes port 465 as implicit TLS whatever the flag says.
pub(crate) fn test_smtp(account: &AccountRow, cred: &Credential) -> Result<(), String> {
    let config = core_config(account, cred)?;
    block_on(mailvault_core::smtp::test_connection(&config))
}

/// [`login`] for a password account given by its fields. `security` is `ssl`, `starttls` or
/// `none` (core's `imapSecurity`).
#[doc(hidden)]
pub fn test_login(host: &str, port: u16, user: &str, password: &str, security: &str) -> Result<u32, String> {
    login(&AccountRow::password(user, host, port, security), &Credential::from_password(password))
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

    fn row(auth: &str) -> AccountRow {
        AccountRow { auth: auth.into(), ..AccountRow::password("u@example.test", "imap.example.test", 993, "ssl") }
    }

    #[test]
    fn a_password_account_sends_the_password_and_no_smtp() {
        let v = imap_config(&row("password"), &Credential::from_password("pw"));
        assert_eq!(
            v,
            json!({ "email": "u@example.test", "imapHost": "imap.example.test", "imapPort": 993, "imapSecurity": "ssl", "password": "pw" })
        );
        let c = core_config(&row("password"), &Credential::from_password("pw")).unwrap();
        assert_eq!((c.password.as_deref(), c.port, c.auth_type), (Some("pw"), Some(993), None));
    }

    #[test]
    fn an_oauth2_account_sends_the_access_token_and_never_the_refresh_token() {
        let mut a = row("oauth2");
        a.smtp_host = Some("smtp.example.test".into());
        a.smtp_port = Some(465);
        a.smtp_security = Some("ssl".into());
        let v = imap_config(&a, &Credential::from_tokens("refresh-tok", "access-tok", 1));
        assert_eq!(v["authType"], "oauth2");
        assert_eq!(v["oauth2AccessToken"], "access-tok");
        assert!(v.get("password").is_none(), "{v}");
        assert!(!v.to_string().contains("refresh-tok"), "{v}");
        assert_eq!((v["smtpHost"].clone(), v["smtpPort"].clone(), v["smtpSecure"].clone()), (json!("smtp.example.test"), json!(465), json!(true)));
        let c = core_config(&a, &Credential::from_tokens("refresh-tok", "access-tok", 1)).unwrap();
        assert!(c.is_oauth2());
        assert_eq!((c.access_token.as_deref(), c.smtp_secure), (Some("access-tok"), Some(true)));
        a.smtp_security = Some("starttls".into());
        assert_eq!(imap_config(&a, &Credential::default())["smtpSecure"], false);
    }
}
