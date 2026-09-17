// Credential-resolution seam: the ONE call site in the daemon that reads the
// keychain entry the app writes (`store_credentials`/`get_credentials` in
// src-tauri/src/main.rs). Used by sync.now/sync.watch (Task 5.2) so those RPCs
// stop trusting IMAP passwords/OAuth tokens carried in the request payload.
//
// Every other daemon command keeps accepting credentials as RPC params,
// unchanged — this seam is scoped to the one place the spec wants credentials
// out of the JS payload.

use std::collections::HashMap;
use std::path::PathBuf;

use keyring::Entry;

use crate::imap::ImapConfig;

// Same service/key the app writes to (src-tauri/src/main.rs KEYRING_SERVICE /
// CREDENTIALS_KEY) — must match exactly, it's the same OS keychain entry.
const KEYRING_SERVICE: &str = "com.mailvault.app";
const CREDENTIALS_KEY: &str = "credentials";

/// Same debug-only file bypass as the app's `test_credentials_path()`
/// (src-tauri/src/main.rs) — `MAILVAULT_TEST_CREDENTIALS=<path>` reads the
/// credential blob from that file instead of the OS keychain, so the mini's
/// test harness works without a real keychain populated per-account. A
/// shipped (release) binary ignores it.
#[cfg(debug_assertions)]
fn test_credentials_path() -> Option<PathBuf> {
    std::env::var_os("MAILVAULT_TEST_CREDENTIALS").map(PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn test_credentials_path() -> Option<PathBuf> {
    None
}

/// Load the full credentials blob: `{ accountId: JSON-string-of-account }`,
/// same shape `store_credentials`/`get_credentials` read and write.
fn load_credentials_blob() -> Result<HashMap<String, String>, String> {
    if let Some(path) = test_credentials_path() {
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read test credentials {:?}: {}", path, e))?;
        return serde_json::from_str(&json)
            .map_err(|e| format!("failed to parse test credentials: {}", e));
    }

    let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
        .map_err(|e| format!("failed to create keyring entry: {}", e))?;
    let json = entry
        .get_password()
        .map_err(|e| format!("failed to read keychain: {}", e))?;
    serde_json::from_str(&json).map_err(|e| format!("failed to parse credentials: {}", e))
}

/// Resolve one account's `ImapConfig` (password / oauth2AccessToken included)
/// from the shared keychain entry, or the `MAILVAULT_TEST_CREDENTIALS` file
/// bypass in debug builds.
pub fn resolve_account_credentials(account_id: &str) -> Result<ImapConfig, String> {
    let credentials = load_credentials_blob()?;
    let raw = credentials
        .get(account_id)
        .ok_or_else(|| format!("no credentials found for account {account_id}"))?;
    serde_json::from_str::<ImapConfig>(raw)
        .map_err(|e| format!("failed to parse credentials for account {account_id}: {e}"))
}

/// Guards every test (in this module or elsewhere in the crate, e.g.
/// `server.rs`'s RPC-level sync.now test) that sets the process-global
/// `MAILVAULT_TEST_CREDENTIALS` env var. Cargo runs a crate's tests on
/// parallel threads by default; two tests setting this var to two different
/// paths at once would race (one test's `resolve_account_credentials` could
/// read the other's file). Take this lock for the env var's entire
/// set-use-remove span.
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Mirrors the shape the app (`store_credentials`) and the e2e harness
    /// (`tests/e2e/mockImap.js` `mockAccount()`/`seedAccounts()`) actually
    /// write: `{ accountId: JSON.stringify(account) }`, where the account
    /// object's own field names are already `ImapConfig`'s renamed fields
    /// (imapHost/imapPort/imapSecure/...), not a wrapped `imapConfig` object.
    fn sample_account_json() -> String {
        serde_json::json!({
            "id": "acct-1",
            "email": "user@example.com",
            "password": "hunter2",
            "imapHost": "imap.example.com",
            "imapPort": 993,
            "imapSecure": true,
            "authType": "password",
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .to_string()
    }

    /// Both cases share one test (rather than one `#[test]` each) — simpler
    /// than taking `test_env_lock()` twice for two tiny cases. The lock itself
    /// (see `test_env_lock` above) exists because `MAILVAULT_TEST_CREDENTIALS`
    /// is a process-global env var and cargo runs a crate's tests on parallel
    /// threads: without it, this test and `server.rs`'s RPC-level
    /// `sync_now_authenticates_via_resolved_credentials_not_the_payload` test
    /// (Task 5.2) — which also sets this var, to a different path — could race.
    #[test]
    fn resolve_account_credentials_uses_the_test_file_bypass() {
        let _guard = test_env_lock().lock().unwrap_or_else(|e| e.into_inner());

        let mut blob = HashMap::new();
        blob.insert("acct-1".to_string(), sample_account_json());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(serde_json::to_string(&blob).unwrap().as_bytes())
            .unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);

        let config = resolve_account_credentials("acct-1").expect("should resolve");
        assert_eq!(config.email, "user@example.com");
        assert_eq!(config.password.as_deref(), Some("hunter2"));
        assert_eq!(config.host, "imap.example.com");

        let err = resolve_account_credentials("acct-does-not-exist")
            .expect_err("should error for missing account");
        assert!(err.contains("acct-does-not-exist"));

        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
}
