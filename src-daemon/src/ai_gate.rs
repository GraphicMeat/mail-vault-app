//! The one rule that keeps Gmail mail off third-party AI: mail from a Google
//! account is only ever processed by on-device AI (Apple's model, the
//! downloaded GGUF, or an endpoint on loopback). Google's OAuth verification
//! asks for exactly this.
//!
//! Every path that hands mail to a model asks `check` first. It fails closed:
//! a cloud provider needs the request to NAME the accounts its mail came from,
//! and every one of them must resolve to a non-Google account. A request that
//! does not say whose mail it carries, or names an account the daemon cannot
//! resolve, is refused.
use crate::llm::Provider;
use mailvault_core::ai::{is_google_account, GOOGLE_MAIL_ON_DEVICE_ONLY};
use serde_json::Value;
use std::path::Path;

/// What the app shows (via its catalog key for the leading `E_` code) and what
/// the log carries.
pub(crate) fn refusal() -> String {
    format!(
        "{GOOGLE_MAIL_ON_DEVICE_ONLY}: Gmail messages are only processed by on-device AI. Choose Apple Intelligence, the downloaded model, or a local Ollama in Settings."
    )
}

/// `accounts.json`'s entry for `account_id`. A missing or unreadable file reads
/// as "not listed": the caller then falls through to the keychain record, and
/// from there to "unknown" (treated as Google).
fn listed_record(app_dir: &Path, account_id: &str) -> Option<Value> {
    let data = std::fs::read_to_string(app_dir.join("accounts.json")).ok()?;
    let list: Vec<Value> = serde_json::from_str(&data).ok()?;
    list.into_iter().find(|a| a.get("id").and_then(Value::as_str) == Some(account_id))
}

/// Whether `account_id` is a Google account, or cannot be told apart from one.
pub(crate) async fn is_google_or_unknown(app_dir: &Path, account_id: &str) -> bool {
    let dir = app_dir.to_path_buf();
    let id = account_id.to_string();
    let listed = tokio::task::spawn_blocking(move || listed_record(&dir, &id)).await.ok().flatten();
    let record = match listed {
        Some(r) => Some(r),
        None => crate::credentials::resolve_account_record_quiet(account_id).await.ok(),
    };
    record.map_or(true, |r| is_google_account(&r))
}

/// `Ok` when `provider` may be given mail from `account_ids`; `Err` carries
/// the refusal message. `account_ids` is what the request declared: `None` or
/// empty means it did not say.
pub(crate) async fn check(app_dir: &Path, provider: &Provider, account_ids: Option<&[String]>) -> Result<(), String> {
    if provider.on_device() {
        return Ok(());
    }
    let ids = match account_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => return Err(refusal()),
    };
    for id in ids {
        if id.is_empty() || is_google_or_unknown(app_dir, id).await {
            return Err(refusal());
        }
    }
    Ok(())
}

/// The `accountIds` an RPC declared: `None` when absent or not an array of
/// strings (a malformed declaration is no declaration).
pub(crate) fn declared_account_ids(params: &Value) -> Option<Vec<String>> {
    let arr = params.get("accountIds")?.as_array()?;
    arr.iter().map(|v| v.as_str().map(str::to_string)).collect()
}

/// Shared by the handler tests that prove a refused request never reaches the
/// network.
#[cfg(test)]
pub(crate) mod test_support {
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{IpAddr, TcpListener, UdpSocket};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A canned `/chat/completions` server that counts every connection it
    /// accepts. It binds this machine's own LAN address, not loopback, because
    /// a loopback URL counts as on-device and so would never exercise the cloud
    /// branch. `None` on a machine with no such address: a test that needs a
    /// reachable cloud endpoint then skips (the refusals do not need one).
    pub(crate) fn lan_mock(reply: &str) -> Option<(String, Arc<AtomicUsize>)> {
        let probe = UdpSocket::bind("0.0.0.0:0").ok()?;
        probe.connect("192.0.2.1:80").ok()?; // no packet is sent: this only picks a route
        let ip = probe.local_addr().ok()?.ip();
        if ip.is_loopback() || ip.is_unspecified() || matches!(ip, IpAddr::V6(_)) {
            return None;
        }
        let listener = TcpListener::bind((ip, 0)).ok()?;
        let url = format!("http://{ip}:{}", listener.local_addr().ok()?.port());
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&hits);
        let reply = reply.to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let body = json!({"choices": [{"message": {"content": reply}}]}).to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        Some((url, hits))
    }

    /// `lan_mock`, or a failure that says why: a test that needs a reachable
    /// cloud-looking endpoint must not quietly pass without one.
    pub(crate) fn require_lan_mock(reply: &str) -> (String, Arc<AtomicUsize>) {
        lan_mock(reply).expect("this test needs a non-loopback address on this machine to host a cloud-looking mock endpoint")
    }

    /// Accounts for the tests: two Google ones (OAuth, and IMAP on Gmail's
    /// host) and two that are not.
    pub(crate) fn seed_accounts(app_dir: &std::path::Path) {
        let accounts = json!([
            {"id": "g-oauth", "email": "a@gmail.com", "authType": "oauth2", "oauth2Provider": "google", "imapHost": "imap.gmail.com"},
            {"id": "g-imap", "email": "b@gmail.com", "authType": "password", "imapHost": "IMAP.Gmail.com"},
            {"id": "ms", "email": "c@outlook.com", "authType": "oauth2", "oauth2Provider": "microsoft", "imapHost": "outlook.office365.com"},
            {"id": "plain", "email": "d@fastmail.com", "authType": "password", "imapHost": "imap.fastmail.com"},
        ]);
        std::fs::write(app_dir.join("accounts.json"), accounts.to_string()).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::seed_accounts;
    use super::*;

    fn cloud() -> Provider {
        Provider::Endpoint { url: "https://api.openai.com/v1".into(), model: "m".into() }
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn on_device_providers_pass_without_naming_any_account() {
        let dir = tempfile::tempdir().unwrap();
        for provider in [
            Provider::LocalGguf,
            Provider::AppleFm,
            Provider::Endpoint { url: "http://localhost:11434/v1".into(), model: "m".into() },
            Provider::Endpoint { url: "http://[::1]:11434/v1".into(), model: "m".into() },
        ] {
            assert!(check(dir.path(), &provider, None).await.is_ok(), "{provider:?}");
            assert!(check(dir.path(), &provider, Some(&ids(&["g-oauth"]))).await.is_ok(), "{provider:?}");
        }
    }

    #[tokio::test]
    async fn a_cloud_provider_needs_named_accounts_and_none_of_them_google() {
        let dir = tempfile::tempdir().unwrap();
        seed_accounts(dir.path());
        assert!(check(dir.path(), &cloud(), Some(&ids(&["plain"]))).await.is_ok());
        assert!(check(dir.path(), &cloud(), Some(&ids(&["plain", "ms"]))).await.is_ok());
        for refused in [
            check(dir.path(), &cloud(), None).await,
            check(dir.path(), &cloud(), Some(&[])).await,
            check(dir.path(), &cloud(), Some(&ids(&["g-oauth"]))).await,
            check(dir.path(), &cloud(), Some(&ids(&["plain", "g-imap"]))).await,
            check(dir.path(), &cloud(), Some(&ids(&[""]))).await,
        ] {
            assert!(refused.unwrap_err().starts_with("E_GOOGLE_MAIL_ON_DEVICE_ONLY"));
        }
    }

    #[tokio::test]
    async fn a_corrupt_accounts_file_lists_nobody_so_every_account_is_unknown() {
        let _guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let creds = tempfile::tempdir().unwrap();
        let path = creds.path().join("credentials.json");
        std::fs::write(&path, "{}").unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("accounts.json"), "not json").unwrap();
        assert!(check(dir.path(), &cloud(), Some(&ids(&["plain"]))).await.is_err());

        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }

    #[test]
    fn a_malformed_declaration_is_no_declaration() {
        use serde_json::json;
        assert_eq!(declared_account_ids(&json!({"accountIds": ["a", "b"]})), Some(ids(&["a", "b"])));
        assert_eq!(declared_account_ids(&json!({"accountIds": []})), Some(vec![]));
        assert_eq!(declared_account_ids(&json!({"accountIds": "a"})), None);
        assert_eq!(declared_account_ids(&json!({"accountIds": ["a", 1]})), None);
        assert_eq!(declared_account_ids(&json!({})), None);
    }
}
