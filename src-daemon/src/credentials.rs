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

// ── Portable: the sealed store on the drive ─────────────────────────────────
//
// A portable copy (`paths::portable_root`) never touches the host keychain:
// every read and write below goes to `<root>/data/credentials.sealed`
// instead. It starts locked each launch; `portable.unlock` holds the
// passphrase and the opened secrets in memory until the daemon exits or
// `portable.lock`.

pub(crate) const E_PORTABLE_LOCKED: &str = "E_PORTABLE_LOCKED";

pub(crate) fn sealed_store_path(root: Option<&std::path::Path>) -> Option<PathBuf> {
    root.map(|r| mailvault_core::paths::portable_data_dir(r).join(mailvault_core::portable::SEALED_FILE))
}

/// This copy's sealed store, `None` in an installed one.
pub(crate) fn sealed() -> Option<&'static SealedStore> {
    static STORE: std::sync::OnceLock<Option<SealedStore>> = std::sync::OnceLock::new();
    STORE
        .get_or_init(|| {
            sealed_store_path(mailvault_core::paths::portable_root())
                .map(|p| SealedStore::new(p, mailvault_core::transfer::crypto::EXPORT_PARAMS))
        })
        .as_ref()
}

type Opened = (zeroize::Zeroizing<String>, mailvault_core::portable::Secrets);

pub(crate) struct SealedStore {
    path: PathBuf,
    params: mailvault_core::transfer::crypto::Params,
    open: std::sync::Mutex<Option<Opened>>,
}

impl SealedStore {
    pub(crate) fn new(path: PathBuf, params: mailvault_core::transfer::crypto::Params) -> Self {
        Self { path, params, open: std::sync::Mutex::new(None) }
    }

    fn opened(&self) -> std::sync::MutexGuard<'_, Option<Opened>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn is_locked(&self) -> bool {
        self.opened().is_none()
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// A drive with no store yet (never set up, or the file was deleted)
    /// starts an empty one under the first passphrase it is given.
    pub(crate) fn unlock(&self, passphrase: &str) -> Result<(), String> {
        use mailvault_core::portable::{read_sealed, write_sealed, Secrets};
        let secrets = if self.path.exists() {
            read_sealed(&self.path, passphrase)?
        } else {
            write_sealed(&self.path, passphrase, &Secrets::default(), self.params)?;
            Secrets::default()
        };
        *self.opened() = Some((zeroize::Zeroizing::new(passphrase.to_string()), secrets));
        Ok(())
    }

    pub(crate) fn lock(&self) {
        *self.opened() = None;
    }

    pub(crate) fn secrets(&self) -> Result<mailvault_core::portable::Secrets, String> {
        self.opened().as_ref().map(|(_, s)| s.clone()).ok_or_else(|| E_PORTABLE_LOCKED.to_string())
    }

    /// Locked refuses: the caller's copy may be the empty one it got while
    /// locked, and sealing that would drop every other account.
    fn update(&self, f: impl FnOnce(&mut mailvault_core::portable::Secrets)) -> Result<(), String> {
        let mut guard = self.opened();
        let Some((passphrase, current)) = guard.as_mut() else { return Err(E_PORTABLE_LOCKED.to_string()) };
        let mut next = current.clone();
        f(&mut next);
        mailvault_core::portable::write_sealed(&self.path, passphrase, &next, self.params)?;
        *current = next;
        Ok(())
    }

    pub(crate) fn set_credentials(&self, blob: HashMap<String, String>) -> Result<(), String> {
        self.update(|s| s.credentials = blob)
    }

    pub(crate) fn set_ai_key(&self, key: Option<String>) -> Result<(), String> {
        self.update(|s| s.ai_endpoint_key = key)
    }

    /// Reads with `old` (so a wrong one changes nothing), reseals with `new`,
    /// and leaves the store unlocked under `new`.
    pub(crate) fn change_passphrase(&self, old: &str, new: &str) -> Result<(), String> {
        let secrets = mailvault_core::portable::read_sealed(&self.path, old)?;
        mailvault_core::portable::write_sealed(&self.path, new, &secrets, self.params)?;
        *self.opened() = Some((zeroize::Zeroizing::new(new.to_string()), secrets));
        Ok(())
    }
}

/// Load the full credentials blob: `{ accountId: JSON-string-of-account }`,
/// same shape `store_credentials`/`get_credentials` read and write.
///
/// `interactive`: whether macOS may show its prompt for this read (see
/// `with_interaction`).
fn load_credentials_blob(interactive: bool) -> Result<HashMap<String, String>, String> {
    if let Some(store) = sealed() {
        return store.secrets().map(|s| s.credentials);
    }
    if let Some(path) = test_credentials_path() {
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read test credentials {:?}: {}", path, e))?;
        return serde_json::from_str(&json)
            .map_err(|e| format!("failed to parse test credentials: {}", e));
    }

    keychain_blob(interactive)?.ok_or_else(|| format!("failed to read keychain: {}", keyring::Error::NoEntry))
}

/// The keychain's blob; `None` when nothing was ever stored.
fn keychain_blob(interactive: bool) -> Result<Option<HashMap<String, String>>, String> {
    let entry = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY)
        .map_err(|e| format!("failed to create keyring entry: {}", e))?;
    let Some(json) = read_entry(&entry, CREDENTIALS_KEY, interactive)
        .map_err(|e| format!("failed to read keychain: {}", e))?
    else {
        return Ok(None);
    };
    // Parts of a split blob (Windows) are plain reads: only the primary item
    // feeds the gate.
    let json = mailvault_core::keychain::join_secret(CREDENTIALS_KEY, &json, &mut |name| {
        match Entry::new(KEYRING_SERVICE, name).and_then(|e| e.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .map_err(|e| format!("failed to read keychain: {}", e))?;
    serde_json::from_str(&json).map(Some).map_err(|e| format!("failed to parse credentials: {}", e))
}

/// Every secret this host holds for MailVault, for a portable copy's sealed
/// store. Nothing stored is an empty set; any other failure fails the whole
/// read, because sealing part of the accounts would lose the rest.
pub(crate) async fn read_host_secrets() -> Result<mailvault_core::portable::Secrets, String> {
    let credentials = guarded(
        CREDENTIALS_KEY,
        unshared(|| match test_credentials_path() {
            Some(path) => match std::fs::read_to_string(&path) {
                Ok(json) => serde_json::from_str(&json).map_err(|e| format!("failed to parse test credentials: {e}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
                Err(e) => Err(format!("failed to read test credentials {path:?}: {e}")),
            },
            None => keychain_blob(true).map(Option::unwrap_or_default),
        }),
        RETRY_TIMEOUT,
    )
    .await?;
    let ai_endpoint_key = resolve_ai_endpoint_key_guarded().await?;
    Ok(mailvault_core::portable::Secrets { credentials, ai_endpoint_key })
}

/// `delete_host_secrets` off the async workers, never prompting, under a
/// clock: a keychain that wants a password here must not hang the offload
/// after a copy that already succeeded.
pub(crate) async fn delete_host_secrets_guarded() -> Result<(), String> {
    let delete = tokio::task::spawn_blocking(|| with_interaction(false, delete_host_secrets));
    match tokio::time::timeout(AI_KEY_TIMEOUT, delete).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("the keychain delete panicked: {e}")),
        Err(_) => Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string()),
    }
}

/// After a verified portable copy, when the user asked: the host keeps no
/// MailVault secret. The blob's parts (Windows) go before its primary, so a
/// failure half way leaves a primary that still names what is left.
fn delete_host_secrets() -> Result<(), String> {
    let gone = |r: std::io::Result<()>| match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    };
    if let Some(path) = test_credentials_path() {
        gone(std::fs::remove_file(path))?;
        if let Some(p) = test_pgp_keys_path() {
            gone(std::fs::remove_file(p))?;
        }
        return test_ai_key_path().map_or(Ok(()), |p| gone(std::fs::remove_file(p)));
    }
    let delete = |name: &str| match Entry::new(KEYRING_SERVICE, name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove {name} from the keychain: {e}")),
    };
    let primary = Entry::new(KEYRING_SERVICE, CREDENTIALS_KEY).and_then(|e| e.get_password()).ok();
    let nothing = mailvault_core::keychain::SplitSecret { primary: String::new(), parts: Vec::new() };
    for part in mailvault_core::keychain::stale_parts(CREDENTIALS_KEY, primary.as_deref(), &nothing) {
        delete(&part)?;
    }
    delete(CREDENTIALS_KEY)?;
    let pgp_primary = Entry::new(KEYRING_SERVICE, PGP_KEYS_ENTRY).and_then(|e| e.get_password()).ok();
    for part in mailvault_core::keychain::stale_parts(PGP_KEYS_ENTRY, pgp_primary.as_deref(), &nothing) {
        delete(&part)?;
    }
    delete(PGP_KEYS_ENTRY)?;
    delete(AI_ENDPOINT_KEY_ENTRY)
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
    account_from_blob(&load_credentials_blob(true)?, account_id)
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
    let blob = guarded(CREDENTIALS_KEY, blob_read(may_prompt()), AI_KEY_TIMEOUT).await?;
    account_from_blob(&blob, account_id)
}

/// macOS's password prompt shows once per blocked episode: only a read that
/// finds the gate clear (the one that discovers the problem) may raise it,
/// plus `keychain.retry`, which the user asked for. Every other read while
/// blocked fails fast instead of stacking prompts in the background.
fn may_prompt() -> bool {
    GATE.may_prompt()
}

/// A shared item read under `limit`. Giving up blocks that item as "timeout";
/// the read itself keeps going and settles the item when it returns.
async fn guarded<T>(key: &'static str, read: impl std::future::Future<Output = Result<T, String>>, limit: Duration) -> Result<T, String> {
    tokio::time::timeout(limit, read).await.unwrap_or_else(|_| {
        GATE.block(key, "timeout");
        Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string())
    })
}

fn blob_read(interactive: bool) -> BoxFuture<'static, Result<HashMap<String, String>, String>> {
    // The debug file bypass cannot hang on a prompt, and tests point it at
    // different files: its read is never shared with anyone else's.
    if test_credentials_path().is_some() {
        return unshared(move || load_credentials_blob(interactive)).boxed();
    }
    BLOB_READ.read(interactive, load_credentials_blob).boxed()
}

fn ai_key_read(interactive: bool) -> BoxFuture<'static, Result<Option<String>, String>> {
    if test_ai_key_path().is_some() {
        return unshared(move || resolve_ai_endpoint_key(interactive)).boxed();
    }
    AI_KEY_READ.read(interactive, resolve_ai_endpoint_key).boxed()
}

// ── Single-flight item reads ────────────────────────────────────────────────

use futures::future::BoxFuture;
use futures::FutureExt;

type SharedRead<T> = futures::future::Shared<BoxFuture<'static, Result<T, String>>>;

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
    /// The read out, and whether it may prompt.
    out: std::sync::Mutex<Option<(bool, SharedRead<T>)>>,
}

impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    pub(crate) const fn new() -> Self {
        Self { out: std::sync::Mutex::new(None) }
    }

    /// Join the read out for this item, or start one. A non-interactive caller
    /// joins whatever is out. An interactive one joins only an interactive
    /// read: behind a non-interactive one (which fails fast) it waits, then
    /// starts its own, so a retry the user asked for always gets its prompt.
    pub(crate) async fn read(
        &'static self,
        interactive: bool,
        read: impl FnOnce(bool) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let mut read = Some(read);
        loop {
            let (answers, shared) = {
                let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
                match &*out {
                    Some((out_interactive, shared)) => (*out_interactive || !interactive, shared.clone()),
                    None => {
                        // Taken once: a caller that starts a read returns its result.
                        let read = read.take().expect("a read is started at most once");
                        let shared = unshared(move || {
                            let result = read(interactive);
                            // Released when the read really returns, never when
                            // a caller gives up on it. Waits for the caller to
                            // finish storing it below.
                            *self.out.lock().unwrap_or_else(|e| e.into_inner()) = None;
                            result
                        });
                        *out = Some((interactive, shared.clone()));
                        (true, shared)
                    }
                }
            };
            let result = shared.await;
            if answers {
                return result;
            }
        }
    }
}

fn unshared<T: Clone + Send + Sync + 'static>(read: impl FnOnce() -> Result<T, String> + Send + 'static) -> SharedRead<T> {
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
    /// Signalled on every newly blocked item, so the watcher sleeps while the
    /// gate is clear. `notify_one` keeps a permit, so a block that lands
    /// before the watcher waits is not missed.
    newly_blocked: tokio::sync::Notify,
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
            newly_blocked: tokio::sync::Notify::const_new(),
            events: std::sync::OnceLock::new(),
            last_banner: std::sync::Mutex::new(None),
        }
    }

    /// The first reason an item blocked with sticks until that item clears.
    pub(crate) fn block(&self, item: &'static str, reason: &'static str) {
        self.block_with_status(item, reason, None);
    }

    /// `block`, with the OSStatus macOS answered, for the log line.
    fn block_with_status(&self, item: &'static str, reason: &'static str, os_status: Option<i32>) {
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
            self.newly_blocked.notify_one();
            if blocked.len() > 1 {
                return;
            }
        }
        let status = os_status.map(|c| format!(", OSStatus {c}")).unwrap_or_default();
        warn!("[keychain] blocked ({item}: {reason}{status}); sync and scheduled sends wait for an unlock");
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

    fn may_prompt(&self) -> bool {
        !self.is_blocked()
    }

    fn blocked_items(&self) -> Vec<&'static str> {
        self.blocked.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|b| b.item).collect()
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
/// `Ok(None)` is `NoEntry`. A non-interactive read of an item that needs a
/// prompt fails with errSecInteractionNotAllowed, which leaves an already
/// blocked item blocked with its first reason.
fn read_entry(entry: &Entry, item: &'static str, interactive: bool) -> keyring::Result<Option<String>> {
    match with_interaction(interactive, || entry.get_password()) {
        Ok(pw) => {
            GATE.clear(item);
            Ok(Some(pw))
        }
        Err(keyring::Error::NoEntry) => {
            GATE.clear(item);
            Ok(None)
        }
        Err(e) => {
            let code = os_status(&e);
            if interactive {
                // Quiet probes fail every 5 s while blocked; only a read that
                // could prompt is worth a line.
                warn!("[keychain] {item} read failed: {e} (OSStatus {code:?})");
            }
            if let Some(reason) = mailvault_core::keychain::keychain_block_reason(code, false) {
                GATE.block_with_status(item, reason, code);
            }
            Err(e)
        }
    }
}

/// `read` with macOS's keychain prompts allowed or not. The switch
/// (`SecKeychainSetUserInteractionAllowed`) is process-wide, so one lock spans
/// switch, read and restore: a probe never silences an interactive read, and an
/// interactive read never runs while a probe has prompts off. Single-flight
/// keeps it to one waiting thread per item while a prompt is up.
#[cfg(target_os = "macos")]
fn with_interaction<R>(interactive: bool, read: impl FnOnce() -> R) -> R {
    static SWITCH: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _held = SWITCH.lock().unwrap_or_else(|e| e.into_inner());
    // Restores prompts on drop, before the lock is released.
    let _quiet = (!interactive).then(security_framework::os::macos::keychain::SecKeychain::disable_user_interaction);
    read()
}

#[cfg(not(target_os = "macos"))]
fn with_interaction<R>(_interactive: bool, read: impl FnOnce() -> R) -> R {
    read()
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

// ── Watcher ─────────────────────────────────────────────────────────────────

/// How often a blocked item is read again while the user may be unlocking the
/// keychain some other way (Keychain Access, the app's own prompt).
const PROBE_EVERY: Duration = Duration::from_secs(5);

/// The daemon's own look at keychain access, so the gate does not depend on
/// something happening to ask for credentials: the blob is read once at
/// start, and blocked items are read again every `PROBE_EVERY` until they
/// answer. Every read goes through the single-flight guarded path, so a probe
/// joins a read still parked on a prompt instead of starting another thread.
/// `on_clear` runs when the gate empties (the scheduled worker's wake).
pub(crate) fn start_watcher(on_clear: impl Fn() + Send + 'static) {
    tokio::spawn(async move {
        // The read that discovers a problem: the one allowed to prompt.
        probe(CREDENTIALS_KEY, may_prompt()).await;
        watch(&GATE, probe, PROBE_EVERY, on_clear).await;
    });
}

async fn probe(item: &'static str, interactive: bool) {
    // The result does not matter here: the read settles its own item.
    let _ = match item {
        CREDENTIALS_KEY => guarded(item, blob_read(interactive), AI_KEY_TIMEOUT).await.map(|_| ()),
        _ => guarded(item, ai_key_read(interactive), AI_KEY_TIMEOUT).await.map(|_| ()),
    };
}

/// Sleeps while the gate is clear (no polling), and while it is blocked reads
/// every blocked item once per `every`, never interactively: the one prompt of
/// this episode is already up or already answered, and a probe that finds its
/// read still out joins it.
async fn watch<F, Fut>(gate: &KeychainGate, probe: F, every: Duration, on_clear: impl Fn())
where
    F: Fn(&'static str, bool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        let items = gate.blocked_items();
        if items.is_empty() {
            gate.newly_blocked.notified().await;
            continue;
        }
        tokio::time::sleep(every).await;
        for item in items {
            probe(item, false).await;
        }
        if !gate.is_blocked() {
            on_clear();
        }
    }
}

/// `keychain.retry`: both items the daemon reads, under a clock long enough
/// for the user to answer macOS's prompt. The one kind of read besides the
/// first that may raise that prompt, because the user asked. An interactive
/// read still out (parked on the prompt the user is looking at) is joined,
/// not started again; a quiet probe's read is waited out first. `ok`
/// once no item is blocked: each read settles its own item, and a failure
/// unlocking cannot fix (a corrupt blob, nothing stored) is not the gate's.
///
/// First it unlocks the default keychain itself, with macOS's unlock dialog:
/// after the user cancels a prompt, macOS does not prompt that process again
/// for the item reads, so without this an Unlock could never bring one back.
pub(crate) async fn retry() -> Value {
    let unlock = tokio::time::timeout(RETRY_TIMEOUT, UNLOCK.read(true, |_| unlock_default_keychain()));
    let reads = async {
        let _ = tokio::join!(
            guarded(CREDENTIALS_KEY, blob_read(true), RETRY_TIMEOUT),
            guarded(AI_ENDPOINT_KEY_ENTRY, ai_key_read(true), RETRY_TIMEOUT),
        );
    };
    retry_with(&GATE, async { unlock.await.unwrap_or_else(|_| Err("timeout".to_string())) }, reads).await
}

/// The unlock dialog, one at a time however often Unlock is pressed.
static UNLOCK: SingleFlight<()> = SingleFlight::new();

/// `retry` with the unlock and the reads passed in, so the order is testable
/// without a keychain. `unlock` answers `Err(reason)` when the user cancelled
/// or it failed; the reads never start then.
async fn retry_with(
    gate: &KeychainGate,
    unlock: impl std::future::Future<Output = Result<(), String>>,
    reads: impl std::future::Future<Output = ()>,
) -> Value {
    if let Err(reason) = unlock.await {
        return json!({"ok": false, "reason": reason});
    }
    reads.await;
    let status = gate.status();
    if status["blocked"] == true {
        warn!("[keychain] retry: still blocked ({})", status["reason"]);
        json!({"ok": false, "reason": status["reason"]})
    } else {
        json!({"ok": true})
    }
}

/// Unlocks the default (login) keychain with macOS's own dialog, only when it
/// is locked: `SecKeychainGetStatus` says so first, so an unlocked keychain
/// never shows a dialog. `Err` is the reason for the card ("denied" on a
/// cancel). Under the same lock as the reads, so a quiet probe cannot have
/// prompts switched off while the dialog is meant to show.
#[cfg(target_os = "macos")]
fn unlock_default_keychain() -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        // NULL keychain = the default keychain, for both.
        fn SecKeychainGetStatus(keychain: *const c_void, status: *mut u32) -> i32;
        fn SecKeychainUnlock(keychain: *const c_void, password_length: u32, password: *const c_void, use_password: u8) -> i32;
    }
    const UNLOCKED: u32 = 1; // kSecUnlockStateStatus

    with_interaction(true, || {
        let mut state = 0u32;
        // SAFETY: plain out-parameter call on the default keychain.
        let code = unsafe { SecKeychainGetStatus(std::ptr::null(), &mut state) };
        if code == 0 && state & UNLOCKED != 0 {
            return Ok(());
        }
        // SAFETY: usePassword false, so no password pointer is read; macOS
        // shows its own unlock dialog.
        let code = unsafe { SecKeychainUnlock(std::ptr::null(), 0, std::ptr::null(), 0) };
        if code == 0 {
            return Ok(());
        }
        let reason = mailvault_core::keychain::keychain_block_reason(Some(code), false).unwrap_or("error");
        warn!("[keychain] retry: unlocking the default keychain failed ({reason}, OSStatus {code})");
        Err(reason.to_string())
    })
}

#[cfg(not(target_os = "macos"))]
fn unlock_default_keychain() -> Result<(), String> {
    Ok(())
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
    if let Some(store) = sealed() {
        return store.set_ai_key(Some(key.to_string()));
    }
    if let Some(path) = test_ai_key_path() {
        return std::fs::write(&path, key).map_err(|e| format!("failed to write test ai key file: {e}"));
    }
    let entry = Entry::new(KEYRING_SERVICE, AI_ENDPOINT_KEY_ENTRY).map_err(|e| format!("failed to create keyring entry: {e}"))?;
    entry.set_password(key).map_err(|e| format!("failed to write keychain: {e}"))
}

/// `Ok(None)` (not an error) means nothing has been stored yet — the normal
/// state for an endpoint (e.g. Ollama) that needs no key at all.
fn resolve_ai_endpoint_key(interactive: bool) -> Result<Option<String>, String> {
    if let Some(store) = sealed() {
        return store.secrets().map(|s| s.ai_endpoint_key);
    }
    if let Some(path) = test_ai_key_path() {
        return match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("failed to read test ai key file: {e}")),
        };
    }
    let entry = Entry::new(KEYRING_SERVICE, AI_ENDPOINT_KEY_ENTRY).map_err(|e| format!("failed to create keyring entry: {e}"))?;
    read_entry(&entry, AI_ENDPOINT_KEY_ENTRY, interactive).map_err(|e| format!("failed to read keychain: {e}"))
}

/// A keychain ACL can prompt the user and then block the reader until
/// somebody answers — an API key this binary was never approved for is
/// exactly that case. Never call `resolve_ai_endpoint_key`/
/// `store_ai_endpoint_key` inline in an async fn; go through these guarded
/// wrappers instead, which mirror `scheduled_send_worker::resolve_credentials`'s
/// spawn_blocking + timeout shape.
pub async fn resolve_ai_endpoint_key_guarded() -> Result<Option<String>, String> {
    guarded(AI_ENDPOINT_KEY_ENTRY, ai_key_read(may_prompt()), AI_KEY_TIMEOUT).await
}

pub async fn store_ai_endpoint_key_guarded(key: String) -> Result<(), String> {
    let write = tokio::task::spawn_blocking(move || store_ai_endpoint_key(&key));
    match tokio::time::timeout(AI_KEY_TIMEOUT, write).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("the keychain write panicked: {e}")),
        Err(_) => Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string()),
    }
}

// ── OpenPGP secret keys ─────────────────────────────────────────────────────
//
// Every imported key in one entry, a JSON list of `mailvault_core::pgp::StoredKey`
// (armored key + passphrase, kept so decryption runs unattended). An armored
// key outgrows Windows' secret limit on its own, so the entry is split the
// way the account blob is. Not in a portable copy's sealed store: a portable
// copy reads no OpenPGP key, refuses an import, and the offload that empties
// the host keychain removes this entry too.

const PGP_KEYS_ENTRY: &str = "pgp_secret_keys";

#[cfg(debug_assertions)]
fn test_pgp_keys_path() -> Option<PathBuf> {
    std::env::var_os("MAILVAULT_TEST_PGP_KEYS").map(PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn test_pgp_keys_path() -> Option<PathBuf> {
    None
}

/// Nothing stored is an empty list; any other failure is an `Err`, never an
/// empty list, because an import rewrites the whole entry from what it read.
fn read_pgp_keys(interactive: bool) -> Result<Vec<mailvault_core::pgp::StoredKey>, String> {
    if sealed().is_some() {
        return Ok(Vec::new());
    }
    let json = match test_pgp_keys_path() {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(json) => json,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("failed to read test pgp keys: {e}")),
        },
        None => {
            let entry = Entry::new(KEYRING_SERVICE, PGP_KEYS_ENTRY).map_err(|e| format!("failed to create keyring entry: {e}"))?;
            let Some(primary) = read_entry(&entry, PGP_KEYS_ENTRY, interactive).map_err(|e| format!("failed to read keychain: {e}"))? else {
                return Ok(Vec::new());
            };
            mailvault_core::keychain::join_secret(PGP_KEYS_ENTRY, &primary, &mut |name| {
                match Entry::new(KEYRING_SERVICE, name).and_then(|e| e.get_password()) {
                    Ok(value) => Ok(Some(value)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(e) => Err(e.to_string()),
                }
            })
            .map_err(|e| format!("failed to read keychain: {e}"))?
        }
    };
    serde_json::from_str(&json).map_err(|e| format!("failed to parse the OpenPGP keys: {e}"))
}

/// Parts first, then the primary, then the previous generation's parts, the
/// order `store_credentials` keeps: a reader always finds a complete set.
fn write_pgp_keys(keys: &[mailvault_core::pgp::StoredKey]) -> Result<(), String> {
    use mailvault_core::keychain::{secret_limit, split_secret, stale_parts};
    if sealed().is_some() {
        return Err("OpenPGP keys cannot be imported into a portable copy".to_string());
    }
    let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
    if let Some(path) = test_pgp_keys_path() {
        return std::fs::write(&path, json).map_err(|e| format!("failed to write test pgp keys: {e}"));
    }
    let entry = |name: &str| Entry::new(KEYRING_SERVICE, name).map_err(|e| format!("failed to create keyring entry: {e}"));
    let primary = entry(PGP_KEYS_ENTRY)?;
    let old = primary.get_password().ok();
    let generation = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
    let split = split_secret(PGP_KEYS_ENTRY, &json, secret_limit(), &generation);
    for (name, value) in &split.parts {
        entry(name)?.set_password(value).map_err(|e| format!("failed to write keychain: {e}"))?;
    }
    primary.set_password(&split.primary).map_err(|e| format!("failed to write keychain: {e}"))?;
    for name in stale_parts(PGP_KEYS_ENTRY, old.as_deref(), &split) {
        if let Err(e) = entry(&name).and_then(|e| e.delete_credential().map_err(|e| e.to_string())) {
            warn!("[pgp] could not remove stale keychain part {name}: {e}");
        }
    }
    Ok(())
}

static PGP_KEYS_READ: SingleFlight<Vec<mailvault_core::pgp::StoredKey>> = SingleFlight::new();

fn pgp_keys_read(interactive: bool) -> BoxFuture<'static, Result<Vec<mailvault_core::pgp::StoredKey>, String>> {
    if test_pgp_keys_path().is_some() {
        return unshared(move || read_pgp_keys(interactive)).boxed();
    }
    PGP_KEYS_READ.read(interactive, read_pgp_keys).boxed()
}

/// The imported OpenPGP keys, off the async workers and under a clock.
pub async fn resolve_pgp_keys_guarded() -> Result<Vec<mailvault_core::pgp::StoredKey>, String> {
    guarded(PGP_KEYS_ENTRY, pgp_keys_read(may_prompt()), AI_KEY_TIMEOUT).await
}

/// Read, change and write back the key list, one change at a time so two
/// imports never lose one key. A failed read fails the change: starting from
/// an empty list would drop every key already imported.
pub async fn update_pgp_keys(
    change: impl FnOnce(&mut Vec<mailvault_core::pgp::StoredKey>) -> Result<(), String>,
) -> Result<Vec<mailvault_core::pgp::StoredKey>, String> {
    static ONE_AT_A_TIME: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _held = ONE_AT_A_TIME.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let mut keys = resolve_pgp_keys_guarded().await?;
    change(&mut keys)?;
    let to_write = keys.clone();
    let write = tokio::task::spawn_blocking(move || write_pgp_keys(&to_write));
    match tokio::time::timeout(AI_KEY_TIMEOUT, write).await {
        Ok(Ok(result)) => result?,
        Ok(Err(e)) => return Err(format!("the keychain write panicked: {e}")),
        Err(_) => return Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string()),
    }
    Ok(keys)
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

    /// Blocked: probes on the clock, never interactively, until the reader
    /// answers, then clears and wakes. Clear: no probe at all until something
    /// blocks again.
    #[tokio::test]
    async fn the_watcher_probes_only_while_blocked_and_never_prompts() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let gate: &'static KeychainGate = Box::leak(Box::new(KeychainGate::new()));
        let probes: &'static AtomicUsize = Box::leak(Box::new(AtomicUsize::new(0)));
        let prompted: &'static AtomicUsize = Box::leak(Box::new(AtomicUsize::new(0)));
        let clears: &'static AtomicUsize = Box::leak(Box::new(AtomicUsize::new(0)));
        // The keychain answers on the third read.
        let reader = move |item: &'static str, interactive: bool| async move {
            if interactive {
                prompted.fetch_add(1, Ordering::SeqCst);
            }
            if probes.fetch_add(1, Ordering::SeqCst) + 1 >= 3 {
                gate.clear(item);
            }
        };
        let until_clear = || async {
            tokio::time::timeout(Duration::from_secs(5), async {
                while gate.is_blocked() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
        };

        gate.block("blob", "timeout");
        let watcher = tokio::spawn(watch(gate, reader, Duration::from_millis(10), move || {
            clears.fetch_add(1, Ordering::SeqCst);
        }));

        until_clear().await.expect("the watcher clears the gate once the reader answers");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(probes.load(Ordering::SeqCst), 3);
        assert_eq!(prompted.load(Ordering::SeqCst), 0, "a probe while blocked must not raise macOS's prompt");
        assert_eq!(clears.load(Ordering::SeqCst), 1, "the clear wakes the scheduled worker once");

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(probes.load(Ordering::SeqCst), 3, "no polling while the gate is clear");

        gate.block("blob", "denied");
        until_clear().await.expect("a new block wakes the watcher");
        assert_eq!(probes.load(Ordering::SeqCst), 4);
        assert_eq!(prompted.load(Ordering::SeqCst), 0);
        watcher.abort();
    }

    /// Unlock brings macOS's dialog back before any item read (a process that
    /// cancelled a prompt is not prompted again by the reads), and a cancelled
    /// dialog answers at once without reading.
    #[tokio::test]
    async fn retry_unlocks_the_keychain_before_it_reads() {
        let order = std::sync::Mutex::new(Vec::new());
        let gate = KeychainGate::new();
        let result = retry_with(
            &gate,
            async { order.lock().unwrap().push("unlock"); Ok(()) },
            async { order.lock().unwrap().push("read") },
        )
        .await;
        assert_eq!(*order.lock().unwrap(), vec!["unlock", "read"]);
        assert_eq!(result, json!({"ok": true}));

        order.lock().unwrap().clear();
        gate.block("blob", "timeout");
        let result = retry_with(
            &gate,
            async { order.lock().unwrap().push("unlock"); Err("denied".to_string()) },
            async { order.lock().unwrap().push("read") },
        )
        .await;
        assert_eq!(*order.lock().unwrap(), vec!["unlock"], "a cancelled unlock reads nothing");
        assert_eq!(result, json!({"ok": false, "reason": "denied"}));

        let result = retry_with(&gate, async { Ok(()) }, async {}).await;
        assert_eq!(result, json!({"ok": false, "reason": "timeout"}), "unlocked, but an item still refuses");
    }

    /// Only the read that finds the gate clear may prompt; once blocked,
    /// background reads fail fast (`keychain.retry` passes `true` itself).
    #[test]
    fn only_a_read_that_finds_the_gate_clear_may_prompt() {
        let gate = KeychainGate::new();
        assert!(gate.may_prompt(), "the first read discovers the problem");
        gate.block("blob", "timeout");
        assert!(!gate.may_prompt(), "later reads while blocked stay quiet");
        gate.clear("blob");
        assert!(gate.may_prompt());
    }

    type Started = std::sync::Arc<std::sync::Mutex<Vec<bool>>>;

    async fn until_started(started: &Started, n: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while started.lock().unwrap().len() < n {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the read started");
    }

    /// A read parked on a prompt must not be joined by a second thread: the
    /// next caller waits on the same read and gets its result, and a fresh
    /// read starts only once that one has returned.
    #[tokio::test]
    async fn a_read_already_out_is_joined_not_started_again() {
        let flight: &'static SingleFlight<u32> = Box::leak(Box::new(SingleFlight::new()));
        let started = Started::default();
        let (release, parked) = std::sync::mpsc::channel::<()>();

        let s = started.clone();
        let first = tokio::spawn(flight.read(true, move |interactive| {
            s.lock().unwrap().push(interactive);
            let _ = parked.recv();
            Ok(7)
        }));
        until_started(&started, 1).await;
        let s = started.clone();
        let second = tokio::spawn(flight.read(false, move |interactive| {
            s.lock().unwrap().push(interactive);
            Ok(8)
        }));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!second.is_finished(), "the probe waits on the parked read");

        release.send(()).unwrap();
        assert_eq!(first.await.unwrap(), Ok(7));
        assert_eq!(second.await.unwrap(), Ok(7), "the probe shares the first read's result");
        assert_eq!(*started.lock().unwrap(), vec![true], "one blocking thread, not two");

        assert_eq!(flight.read(false, |_| Ok(9)).await, Ok(9), "once it returned, the next read is a fresh one");
    }

    /// A retry the user asked for gets its prompt even when a background
    /// probe's quiet read is out: it waits that one out, then reads itself.
    #[tokio::test]
    async fn an_interactive_read_is_not_answered_by_a_quiet_one() {
        let flight: &'static SingleFlight<u32> = Box::leak(Box::new(SingleFlight::new()));
        let started = Started::default();
        let (release, parked) = std::sync::mpsc::channel::<()>();

        let s = started.clone();
        let probe = tokio::spawn(flight.read(false, move |interactive| {
            s.lock().unwrap().push(interactive);
            let _ = parked.recv();
            Ok(1)
        }));
        until_started(&started, 1).await;
        let s = started.clone();
        let retry = tokio::spawn(flight.read(true, move |interactive| {
            s.lock().unwrap().push(interactive);
            Ok(2)
        }));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!retry.is_finished(), "one read per item at a time, even for a retry");

        release.send(()).unwrap();
        assert_eq!(probe.await.unwrap(), Ok(1));
        assert_eq!(retry.await.unwrap(), Ok(2), "the retry's own read, not the probe's answer");
        assert_eq!(*started.lock().unwrap(), vec![false, true]);
    }

    // ── Portable: the sealed store on the drive ─────────────────────────

    use mailvault_core::portable::{read_sealed, write_sealed, Secrets};
    use mailvault_core::transfer::crypto::{Params, MIN_M_KIB};

    const CHEAP: Params = Params { m_kib: MIN_M_KIB, t: 1, p: 1 };

    fn sealed_with_one_account(dir: &std::path::Path) -> SealedStore {
        let path = dir.join("credentials.sealed");
        let mut credentials = HashMap::new();
        credentials.insert("acct-1".to_string(), sample_account_json());
        write_sealed(&path, "drive passphrase", &Secrets { credentials, ai_endpoint_key: None }, CHEAP).unwrap();
        SealedStore::new(path, CHEAP)
    }

    #[test]
    fn only_a_portable_root_gets_the_sealed_backend() {
        let root = std::path::Path::new("/Volumes/USB/MailVault Data");
        assert_eq!(sealed_store_path(Some(root)), Some(root.join("data").join("credentials.sealed")));
        assert_eq!(sealed_store_path(None), None, "an installed copy keeps the OS keychain");
    }

    #[test]
    fn a_locked_store_neither_answers_nor_takes_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = sealed_with_one_account(dir.path());
        assert!(store.is_locked());
        assert!(store.secrets().unwrap_err().starts_with(E_PORTABLE_LOCKED));
        // A write now would replace every account with whatever the caller
        // happened to hold: refused, and the file is untouched.
        let before = std::fs::read(dir.path().join("credentials.sealed")).unwrap();
        assert!(store.set_credentials(HashMap::new()).unwrap_err().starts_with(E_PORTABLE_LOCKED));
        assert_eq!(std::fs::read(dir.path().join("credentials.sealed")).unwrap(), before);
    }

    #[test]
    fn unlock_takes_the_right_passphrase_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = sealed_with_one_account(dir.path());
        let err = store.unlock("wrong passphrase").unwrap_err();
        assert!(err.starts_with(mailvault_core::portable::E_PASSPHRASE), "{err}");
        assert!(store.is_locked());

        store.unlock("drive passphrase").unwrap();
        assert!(!store.is_locked());
        let blob = store.secrets().unwrap().credentials;
        assert_eq!(account_from_blob(&blob, "acct-1").unwrap().password.as_deref(), Some("hunter2"));

        store.lock();
        assert!(store.is_locked(), "lock forgets the key");
    }

    #[test]
    fn a_write_while_unlocked_is_sealed_to_the_drive() {
        let dir = tempfile::tempdir().unwrap();
        let store = sealed_with_one_account(dir.path());
        store.unlock("drive passphrase").unwrap();
        let mut blob = store.secrets().unwrap().credentials;
        blob.insert("acct-2".to_string(), sample_account_json());
        store.set_credentials(blob).unwrap();
        store.set_ai_key(Some("sk-portable".to_string())).unwrap();

        let on_disk = read_sealed(&dir.path().join("credentials.sealed"), "drive passphrase").unwrap();
        assert_eq!(on_disk.credentials.len(), 2);
        assert_eq!(on_disk.ai_endpoint_key.as_deref(), Some("sk-portable"));
    }

    #[test]
    fn changing_the_passphrase_needs_the_old_one_and_reseals() {
        let dir = tempfile::tempdir().unwrap();
        let store = sealed_with_one_account(dir.path());
        assert!(store.change_passphrase("wrong passphrase", "new passphrase").is_err());
        store.change_passphrase("drive passphrase", "new passphrase").unwrap();

        let path = dir.path().join("credentials.sealed");
        assert!(read_sealed(&path, "drive passphrase").is_err());
        assert_eq!(read_sealed(&path, "new passphrase").unwrap().credentials.len(), 1);
    }

    #[test]
    fn unlocking_a_drive_with_no_store_yet_starts_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = SealedStore::new(dir.path().join("credentials.sealed"), CHEAP);
        store.unlock("first passphrase").unwrap();
        assert!(store.secrets().unwrap().credentials.is_empty());
        assert!(read_sealed(&dir.path().join("credentials.sealed"), "first passphrase").is_ok());
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
