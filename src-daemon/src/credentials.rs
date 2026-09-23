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
use std::time::Duration;

use keyring::Entry;
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::events::EventBus;
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
    let json = read_entry(&entry, CREDENTIALS_KEY)
        .map_err(|e| format!("failed to read keychain: {}", e))?
        .ok_or_else(|| format!("failed to read keychain: {}", keyring::Error::NoEntry))?;
    serde_json::from_str(&json).map_err(|e| format!("failed to parse credentials: {}", e))
}

/// Resolve one account's `ImapConfig` (password / oauth2AccessToken included)
/// from the shared keychain entry, or the `MAILVAULT_TEST_CREDENTIALS` file
/// bypass in debug builds.
/// Test-only: every real caller is async and goes through
/// `resolve_account_credentials_guarded`, because calling this inline would
/// park a runtime worker on a keychain that is locked or prompting — the exact
/// hang the guard exists to prevent.
#[cfg(test)]
fn resolve_account_credentials(account_id: &str) -> Result<ImapConfig, String> {
    account_from_blob(&load_credentials_blob()?, account_id)
}

fn account_from_blob(credentials: &HashMap<String, String>, account_id: &str) -> Result<ImapConfig, String> {
    let raw = credentials
        .get(account_id)
        .ok_or_else(|| format!("no credentials found for account {account_id}"))?;
    serde_json::from_str::<ImapConfig>(raw)
        .map_err(|e| format!("failed to parse credentials for account {account_id}: {e}"))
}

/// `resolve_account_credentials` off the caller's async thread and under a
/// clock. Every async caller must use this one.
///
/// The read is blocking, so inline in an `async fn` it parks a runtime worker
/// rather than a task — and `sync.watch` is called once per account on every
/// reconnect, so a slow keychain parks several at once and RPC handling
/// wedges, not just sync. Worse, a keychain item whose ACL decides to prompt
/// blocks until somebody answers the dialog; with the daemon started at login
/// nobody is there to, and the wait has no end. A timeout turns that into an
/// error the caller can report instead of a daemon that stopped answering.
///
/// The blob is one keychain item, read by at most one thread at a time (see
/// `SingleFlight`): every account's caller shares that read.
pub async fn resolve_account_credentials_guarded(account_id: &str) -> Result<ImapConfig, String> {
    let blob = guarded(CREDENTIALS_KEY, blob_read(), AI_KEY_TIMEOUT).await?;
    account_from_blob(&blob, account_id)
}

/// A shared item read under `limit`. Giving up blocks that item as "timeout";
/// the read itself keeps going and settles the item when it returns.
async fn guarded<T: Clone>(key: &'static str, read: SharedRead<T>, limit: Duration) -> Result<T, String> {
    tokio::time::timeout(limit, read).await.unwrap_or_else(|_| {
        GATE.block(key, "timeout");
        Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string())
    })
}

fn blob_read() -> SharedRead<HashMap<String, String>> {
    // The debug file bypass cannot hang on a prompt, and tests point it at
    // different files: its read is never shared with anyone else's.
    if test_credentials_path().is_some() {
        return unshared(load_credentials_blob);
    }
    BLOB_READ.run(load_credentials_blob)
}

fn ai_key_read() -> SharedRead<Option<String>> {
    if test_ai_key_path().is_some() {
        return unshared(resolve_ai_endpoint_key);
    }
    AI_KEY_READ.run(resolve_ai_endpoint_key)
}

// ── Single-flight item reads ────────────────────────────────────────────────

type SharedRead<T> = futures::future::Shared<futures::future::BoxFuture<'static, Result<T, String>>>;

static BLOB_READ: SingleFlight<HashMap<String, String>> = SingleFlight::new();
static AI_KEY_READ: SingleFlight<Option<String>> = SingleFlight::new();

/// At most one blocking read per keychain item. A read parked on a prompt
/// nobody answers does not come back, and a caller's timeout cannot cancel a
/// blocking thread; with a new thread per attempt the scheduled worker's
/// five-minute retries would drain tokio's blocking pool over a weekend. A
/// caller that finds a read already out waits on that one, so concurrent
/// callers (`sync.watch` for every account on reconnect) share one read, and
/// `keychain.retry` joins a read still waiting on the prompt the user can see.
pub(crate) struct SingleFlight<T> {
    out: std::sync::Mutex<Option<SharedRead<T>>>,
}

impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    pub(crate) const fn new() -> Self {
        Self { out: std::sync::Mutex::new(None) }
    }

    pub(crate) fn run(&'static self, read: impl FnOnce() -> Result<T, String> + Send + 'static) -> SharedRead<T> {
        let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(read) = &*out {
            return read.clone();
        }
        let shared = unshared(move || {
            let result = read();
            // Released when the read really returns, never when a caller gives
            // up on it. Waits for `run` to finish storing it below.
            *self.out.lock().unwrap_or_else(|e| e.into_inner()) = None;
            result
        });
        *out = Some(shared.clone());
        shared
    }
}

fn unshared<T: Clone + Send + Sync + 'static>(read: impl FnOnce() -> Result<T, String> + Send + 'static) -> SharedRead<T> {
    use futures::FutureExt;
    tokio::task::spawn_blocking(read)
        .map(|joined| joined.unwrap_or_else(|e| Err(format!("the keychain read panicked: {e}"))))
        .boxed()
        .shared()
}

// ── Keychain gate ───────────────────────────────────────────────────────────
//
// Per item: a read the user can fix by unlocking the keychain (locked, a
// refused or unanswered prompt) blocks that item; the next read of the same
// item that answers clears it. The gate is blocked while any item is, because
// a refusal is per item (the app's blob can prompt while the daemon's own AI
// key reads fine). Only blocked/clear flips are events, one `keychain-status`
// each, which the app turns into its unlock dialog. With no app listening,
// the daemon posts a banner itself so somebody learns sync and scheduled
// sends are paused.

/// How long a keychain read gets when the user asked for it (`keychain.retry`)
/// and may be typing a password into a macOS prompt.
const RETRY_TIMEOUT: Duration = Duration::from_secs(120);
/// At most one daemon-posted banner per this long, however often the gate flaps.
const BANNER_EVERY: Duration = Duration::from_secs(30 * 60);

struct Blocked {
    item: &'static str,
    reason: &'static str,
    since_ms: i64,
}

pub(crate) struct KeychainGate {
    /// Blocked items, earliest first.
    blocked: std::sync::Mutex<Vec<Blocked>>,
    events: std::sync::OnceLock<EventBus>,
    last_banner: std::sync::Mutex<Option<std::time::Instant>>,
}

pub(crate) static GATE: KeychainGate = KeychainGate::new();

/// Called once from main, so the four credential callers keep their signatures.
pub fn install_events(bus: EventBus) {
    let _ = GATE.events.set(bus);
}

impl KeychainGate {
    const fn new() -> Self {
        Self {
            blocked: std::sync::Mutex::new(Vec::new()),
            events: std::sync::OnceLock::new(),
            last_banner: std::sync::Mutex::new(None),
        }
    }

    /// The first reason an item blocked with sticks until that item clears.
    pub(crate) fn block(&self, item: &'static str, reason: &'static str) {
        {
            let mut blocked = self.blocked.lock().unwrap_or_else(|e| e.into_inner());
            if blocked.iter().any(|b| b.item == item) {
                return;
            }
            let since_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            blocked.push(Blocked { item, reason, since_ms });
            if blocked.len() > 1 {
                return;
            }
        }
        warn!("[keychain] blocked ({item}: {reason}); sync and scheduled sends wait for an unlock");
        let Some(bus) = self.events.get() else { return };
        if !bus.emit("keychain-status", json!({"blocked": true, "reason": reason})) {
            self.banner();
        }
    }

    pub(crate) fn clear(&self, item: &'static str) {
        {
            let mut blocked = self.blocked.lock().unwrap_or_else(|e| e.into_inner());
            let before = blocked.len();
            blocked.retain(|b| b.item != item);
            if before == 0 || !blocked.is_empty() {
                return;
            }
        }
        info!("[keychain] readable again");
        if let Some(bus) = self.events.get() {
            bus.emit("keychain-status", json!({"blocked": false}));
        }
    }

    pub(crate) fn is_blocked(&self) -> bool {
        !self.blocked.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }

    pub(crate) fn status(&self) -> Value {
        match self.blocked.lock().unwrap_or_else(|e| e.into_inner()).first() {
            Some(b) => json!({"blocked": true, "reason": b.reason, "since": b.since_ms}),
            None => json!({"blocked": false}),
        }
    }

    fn banner(&self) {
        {
            let mut last = self.last_banner.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|t| t.elapsed() < BANNER_EVERY) {
                return;
            }
            *last = Some(std::time::Instant::now());
        }
        // Its own thread: an Objective-C call that stalls must not park a
        // runtime worker or the blocking pool.
        std::thread::spawn(banner::post);
    }
}

/// `get_password` with the gate kept in step for `item`: a read that answers,
/// even with "nothing stored", clears it; one unlocking would fix blocks it.
/// `Ok(None)` is `NoEntry`.
fn read_entry(entry: &Entry, item: &'static str) -> keyring::Result<Option<String>> {
    match entry.get_password() {
        Ok(pw) => {
            GATE.clear(item);
            Ok(Some(pw))
        }
        Err(keyring::Error::NoEntry) => {
            GATE.clear(item);
            Ok(None)
        }
        Err(e) => {
            if let Some(reason) = mailvault_core::keychain::keychain_block_reason(os_status(&e), false) {
                GATE.block(item, reason);
            }
            Err(e)
        }
    }
}

/// The `OSStatus` keyring boxed away, recoverable only before it is stringified.
#[cfg(target_os = "macos")]
fn os_status(e: &keyring::Error) -> Option<i32> {
    match e {
        keyring::Error::PlatformFailure(b) | keyring::Error::NoStorageAccess(b) => {
            b.downcast_ref::<security_framework::base::Error>().map(|e| e.code())
        }
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
fn os_status(_: &keyring::Error) -> Option<i32> {
    None
}

/// `keychain.retry`: both items the daemon reads, under a clock long enough
/// for the user to answer macOS's prompt. A read of an item still out (parked
/// on the prompt the user is looking at) is joined, not started again. `ok`
/// once no item is blocked: each read settles its own item, and a failure
/// unlocking cannot fix (a corrupt blob, nothing stored) is not the gate's.
pub(crate) async fn retry() -> Value {
    let _ = tokio::join!(
        guarded(CREDENTIALS_KEY, blob_read(), RETRY_TIMEOUT),
        guarded(AI_ENDPOINT_KEY_ENTRY, ai_key_read(), RETRY_TIMEOUT),
    );
    let status = GATE.status();
    if status["blocked"] == true {
        json!({"ok": false, "reason": status["reason"]})
    } else {
        json!({"ok": true})
    }
}

/// The daemon's own banner, for when the gate closes with no app open.
///
/// UNPROVEN: posting through UNUserNotificationCenter from the daemon relies on
/// `NSBundle.mainBundle` resolving to `MailVault.app` (the binary sits in its
/// `Contents/MacOS`), so the banner posts as MailVault and a click opens the
/// app, which asks `keychain.status` on start. Anything else (a bare binary in
/// dev or tests) only logs: UNUserNotificationCenter throws for a process
/// without a bundle, and under `panic = "abort"` that cannot be caught.
#[cfg(target_os = "macos")]
mod banner {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError, NSLocale, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNUserNotificationCenter,
    };
    use tracing::warn;

    pub fn post() {
        objc2::rc::autoreleasepool(|_| {
            let bundle = NSBundle::mainBundle();
            if !bundle.bundlePath().to_string().ends_with(".app") || bundle.bundleIdentifier().is_none() {
                warn!("[keychain] not inside an app bundle; no banner posted");
                return;
            }
            let lang = NSLocale::preferredLanguages().firstObject().map(|l| l.to_string()).unwrap_or_default();
            let (title, body) = mailvault_core::keychain::keychain_banner_text(&lang);
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setBody(&NSString::from_str(body));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str("mailvault-keychain-blocked"),
                &content,
                None,
            );
            let deliver = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
                if granted.as_bool() {
                    UNUserNotificationCenter::currentNotificationCenter()
                        .addNotificationRequest_withCompletionHandler(&request, None);
                } else {
                    warn!("[keychain] notifications not authorized; banner dropped");
                }
            });
            UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &deliver,
            );
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod banner {
    pub fn post() {}
}

/// Guards every test (in this module or elsewhere in the crate, e.g.
/// `server.rs`'s RPC-level sync.now test) that sets a process-global test env
/// var this file reads (`MAILVAULT_TEST_CREDENTIALS`, `MAILVAULT_TEST_AI_KEY`
/// below). Cargo runs a crate's tests on parallel threads by default; two
/// tests setting the same var to two different values at once would race.
/// Take this lock for the env var's entire set-use-remove span.
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

// ── AI endpoint API key (Phase 3b) ──────────────────────────────────────────
//
// A dedicated keychain entry, distinct from `CREDENTIALS_KEY`'s per-account
// blob above: `ai.set_endpoint_key` writes here, `Provider::Endpoint`'s
// generate call reads it. Never mixed into app.db, settings JSON, or a log
// line — Ollama's OpenAI-compatible endpoint works fine with nothing stored
// here at all (`resolve_ai_endpoint_key` reads that case as `Ok(None)`, not
// an error).

const AI_ENDPOINT_KEY_ENTRY: &str = "ai_endpoint_api_key";
/// How long any keychain read or write gets before it is abandoned: long
/// enough for a slow unlock, short enough that a prompt nobody will answer
/// cannot hold a runtime worker for the rest of the session.
const AI_KEY_TIMEOUT: Duration = Duration::from_secs(20);

/// Same debug-only file bypass as `test_credentials_path` above, so tests
/// don't have to touch a real OS keychain.
#[cfg(debug_assertions)]
fn test_ai_key_path() -> Option<PathBuf> {
    std::env::var_os("MAILVAULT_TEST_AI_KEY").map(PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn test_ai_key_path() -> Option<PathBuf> {
    None
}

fn store_ai_endpoint_key(key: &str) -> Result<(), String> {
    if let Some(path) = test_ai_key_path() {
        return std::fs::write(&path, key).map_err(|e| format!("failed to write test ai key file: {e}"));
    }
    let entry = Entry::new(KEYRING_SERVICE, AI_ENDPOINT_KEY_ENTRY).map_err(|e| format!("failed to create keyring entry: {e}"))?;
    entry.set_password(key).map_err(|e| format!("failed to write keychain: {e}"))
}

/// `Ok(None)` (not an error) means nothing has been stored yet — the normal
/// state for an endpoint (e.g. Ollama) that needs no key at all.
fn resolve_ai_endpoint_key() -> Result<Option<String>, String> {
    if let Some(path) = test_ai_key_path() {
        return match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("failed to read test ai key file: {e}")),
        };
    }
    let entry = Entry::new(KEYRING_SERVICE, AI_ENDPOINT_KEY_ENTRY).map_err(|e| format!("failed to create keyring entry: {e}"))?;
    read_entry(&entry, AI_ENDPOINT_KEY_ENTRY).map_err(|e| format!("failed to read keychain: {e}"))
}

/// A keychain ACL can prompt the user and then block the reader until
/// somebody answers — an API key this binary was never approved for is
/// exactly that case. Never call `resolve_ai_endpoint_key`/
/// `store_ai_endpoint_key` inline in an async fn; go through these guarded
/// wrappers instead, which mirror `scheduled_send_worker::resolve_credentials`'s
/// spawn_blocking + timeout shape.
pub async fn resolve_ai_endpoint_key_guarded() -> Result<Option<String>, String> {
    guarded(AI_ENDPOINT_KEY_ENTRY, ai_key_read(), AI_KEY_TIMEOUT).await
}

pub async fn store_ai_endpoint_key_guarded(key: String) -> Result<(), String> {
    let write = tokio::task::spawn_blocking(move || store_ai_endpoint_key(&key));
    match tokio::time::timeout(AI_KEY_TIMEOUT, write).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("the keychain write panicked: {e}")),
        Err(_) => Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string()),
    }
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

    fn gate_with_events() -> (KeychainGate, tokio::sync::broadcast::Receiver<std::sync::Arc<str>>) {
        let gate = KeychainGate::new();
        let bus = EventBus::new(crate::events::CAPACITY);
        let _ = gate.events.set(bus.clone());
        let rx = bus.subscribe();
        (gate, rx)
    }

    fn payloads(rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<str>>) -> Vec<Value> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|line| mailvault_core::daemon_ipc::parse_event(&line).expect("an event line").1)
            .collect()
    }

    /// One event per transition, so the app raises its dialog once, not on
    /// every failed read; the first reason sticks until the item clears.
    #[test]
    fn the_gate_emits_on_transitions_only() {
        let (gate, mut rx) = gate_with_events();

        gate.block(CREDENTIALS_KEY, "locked");
        gate.block(CREDENTIALS_KEY, "timeout");
        assert!(gate.is_blocked());
        assert_eq!(gate.status()["reason"], json!("locked"));
        gate.clear(CREDENTIALS_KEY);
        gate.clear(CREDENTIALS_KEY);

        assert_eq!(payloads(&mut rx), vec![json!({"blocked": true, "reason": "locked"}), json!({"blocked": false})]);
        assert_eq!(gate.status(), json!({"blocked": false}));
    }

    /// The app's blob can prompt while the daemon's own AI key reads fine. A
    /// gate any successful read cleared would flap on every AI read, and each
    /// re-block would bring the dialog back after "Later".
    #[test]
    fn another_item_reading_fine_does_not_clear_a_blocked_one() {
        let (gate, mut rx) = gate_with_events();

        gate.block(CREDENTIALS_KEY, "denied");
        gate.clear(AI_ENDPOINT_KEY_ENTRY);
        assert!(gate.is_blocked(), "the blob is still refused");
        assert_eq!(payloads(&mut rx), vec![json!({"blocked": true, "reason": "denied"})]);

        gate.block(AI_ENDPOINT_KEY_ENTRY, "timeout");
        assert_eq!(gate.status()["reason"], json!("denied"), "the earliest item's reason");
        gate.clear(CREDENTIALS_KEY);
        assert!(gate.is_blocked());
        assert_eq!(gate.status()["reason"], json!("timeout"));
        assert!(payloads(&mut rx).is_empty(), "no flip while any item stays blocked");

        gate.clear(AI_ENDPOINT_KEY_ENTRY);
        assert!(!gate.is_blocked());
        assert_eq!(payloads(&mut rx), vec![json!({"blocked": false})]);
    }

    /// A read parked on a prompt must not be joined by a second thread: the
    /// next caller waits on the same read and gets its result, and a fresh
    /// read starts only once that one has returned.
    #[tokio::test]
    async fn a_read_already_out_is_joined_not_started_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let flight: &'static SingleFlight<u32> = Box::leak(Box::new(SingleFlight::new()));
        let started = std::sync::Arc::new(AtomicUsize::new(0));
        let (release, parked) = std::sync::mpsc::channel::<()>();

        let s = started.clone();
        let first = flight.run(move || {
            s.fetch_add(1, Ordering::SeqCst);
            let _ = parked.recv();
            Ok(7)
        });
        let s = started.clone();
        let second = flight.run(move || {
            s.fetch_add(1, Ordering::SeqCst);
            Ok(8)
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), second.clone()).await.is_err(),
            "the second caller waits on the parked read"
        );

        release.send(()).unwrap();
        assert_eq!(first.await, Ok(7));
        assert_eq!(second.await, Ok(7), "the second caller shares the first read's result");
        assert_eq!(started.load(Ordering::SeqCst), 1, "one blocking thread, not two");

        assert_eq!(flight.run(|| Ok(9)).await, Ok(9), "once it returned, the next read is a fresh one");
    }

    #[tokio::test]
    async fn ai_endpoint_key_round_trips_through_the_test_file_bypass() {
        let _guard = test_env_lock().lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai_key");
        std::env::set_var("MAILVAULT_TEST_AI_KEY", &path);

        assert_eq!(resolve_ai_endpoint_key_guarded().await.unwrap(), None, "nothing stored yet reads as None, not an error");

        store_ai_endpoint_key_guarded("sk-test-123".to_string()).await.unwrap();
        assert_eq!(resolve_ai_endpoint_key_guarded().await.unwrap().as_deref(), Some("sk-test-123"));

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }
}
