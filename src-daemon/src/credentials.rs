// Account credential reads and per-record mutations. The app adapters still
// use their existing shell path; these native routes are a staged capability.
// AI/PGP, gate and watcher behavior stays shared with the existing readers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use keyring::Entry;
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::events::EventBus;
use crate::imap::ImapConfig;
use crate::server::DaemonState;

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

/// Internal provenance captured before reading storage, never persisted or
/// carried in a public RPC record.
#[derive(Clone)]
pub(crate) struct RecordSnapshot {
    pub record: Value,
    pub generation: u64,
}

/// `resolve_account_credentials_guarded` plus the account's whole stored
/// record, from the same read: the OAuth2 fields `ImapConfig` drops (refresh
/// token, expiry, provider, client) for a caller that refreshes a token
/// itself. The record holds secrets too: never log it.
pub(crate) async fn resolve_account_with_record_guarded(account_id: &str) -> Result<(ImapConfig, RecordSnapshot), String> {
    let generation = BLOB_READ.generation();
    let blob = guarded(CREDENTIALS_KEY, blob_read(may_prompt()), AI_KEY_TIMEOUT).await?;
    let account = account_from_blob(&blob, account_id)?;
    let record = blob.get(account_id).and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
    #[cfg(test)]
    crate::oauth_tokens::record_read_finished_for_test(account_id);
    Ok((account, RecordSnapshot { record, generation }))
}

/// `resolve_account_with_record_guarded` that never raises the keychain prompt
/// (see `resolve_account_credentials_quiet`). The record holds secrets: never
/// log it.
pub(crate) async fn resolve_account_with_record_quiet(account_id: &str) -> Result<(ImapConfig, RecordSnapshot), String> {
    let generation = BLOB_READ.generation();
    let blob = guarded(CREDENTIALS_KEY, blob_read(false), AI_KEY_TIMEOUT).await?;
    let account = account_from_blob(&blob, account_id)?;
    let record = blob.get(account_id).and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
    #[cfg(test)]
    crate::oauth_tokens::record_read_finished_for_test(account_id);
    Ok((account, RecordSnapshot { record, generation }))
}

/// `resolve_account_credentials_guarded` for background work that must never
/// be what raises the keychain prompt (the eviction worker's daily pass):
/// the read runs with interaction off, so a locked keychain answers an error
/// (and blocks the gate, as any quiet probe does) instead of a dialog. It
/// joins a read already out, interactive or not.
pub async fn resolve_account_credentials_quiet(account_id: &str) -> Result<ImapConfig, String> {
    let blob = guarded(CREDENTIALS_KEY, blob_read(false), AI_KEY_TIMEOUT).await?;
    account_from_blob(&blob, account_id)
}

/// One account's raw record (the JSON the app stored, auth type and host
/// included, secrets too: never log it) read without ever raising a keychain
/// prompt. `ai_gate` uses it to decide whether an account is a Google one when
/// `accounts.json` does not list it.
pub async fn resolve_account_record_quiet(account_id: &str) -> Result<serde_json::Value, String> {
    let blob = guarded(CREDENTIALS_KEY, blob_read(false), AI_KEY_TIMEOUT).await?;
    let raw = blob.get(account_id).ok_or_else(|| format!("no credentials found for account {account_id}"))?;
    serde_json::from_str(raw).map_err(|e| format!("failed to parse credentials for account {account_id}: {e}"))
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

#[cfg(test)]
pub(crate) struct TestSharedBlobRead {
    pub path: PathBuf,
    pub gate: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    pub captured: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
    pub finished: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
    pub joined: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
    pub starts: std::sync::atomic::AtomicUsize,
    pub active: std::sync::atomic::AtomicUsize,
    pub max_active: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl TestSharedBlobRead {
    fn load(&self) -> Result<Option<HashMap<String, String>>, String> {
        use std::sync::atomic::Ordering::SeqCst;
        self.starts.fetch_add(1, SeqCst);
        let active = self.active.fetch_add(1, SeqCst) + 1;
        self.max_active.fetch_max(active, SeqCst);
        struct Finish<'a>(&'a std::sync::atomic::AtomicUsize, Option<std::sync::mpsc::Sender<()>>);
        impl Drop for Finish<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, SeqCst);
                if let Some(done) = self.1.take() { let _ = done.send(()); }
            }
        }
        let gate = self.gate.lock().unwrap_or_else(|e| e.into_inner()).take();
        let done = if gate.is_some() { self.finished.lock().unwrap_or_else(|e| e.into_inner()).take() } else { None };
        let _finish = Finish(&self.active, done);
        // The path is captured at fixture installation. Never consult env or
        // fall through to Entry, even if a caller unwinds while this is parked.
        let result = match std::fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|_| "invalid synthetic credential blob".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("synthetic credential read failed".to_string()),
        };
        if let Some(gate) = gate {
            if let Some(captured) = self.captured.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = captured.send(()); }
            let _ = gate.recv();
        }
        result
    }
}

#[cfg(test)]
pub(crate) static TEST_SHARED_BLOB_READ: std::sync::Mutex<Option<Arc<TestSharedBlobRead>>> = std::sync::Mutex::new(None);

#[cfg(test)]
fn test_shared_blob_read() -> Option<Arc<TestSharedBlobRead>> {
    let path = test_credentials_path()?;
    TEST_SHARED_BLOB_READ.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|test| test.path == path).cloned()
}

#[cfg(test)]
fn test_blob_join(flight: usize) {
    if flight != &BLOB_READ as *const _ as usize { return; }
    if let Some(test) = TEST_SHARED_BLOB_READ.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if let Some(joined) = test.joined.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = joined.send(()); }
    }
}

#[cfg(test)]
pub(crate) struct TestTaskDrain(pub std::sync::mpsc::Receiver<()>);
#[cfg(test)]
impl Drop for TestTaskDrain {
    fn drop(&mut self) {
        if self.0.recv_timeout(Duration::from_secs(5)).is_err() {
            eprintln!("credential reader did not drain; refusing fixture teardown");
            std::process::abort();
        }
    }
}

#[cfg(test)]
pub(crate) struct TestTaskDone(pub std::sync::mpsc::Sender<()>);

#[cfg(test)]
impl Drop for TestTaskDone {
    fn drop(&mut self) { let _ = self.0.send(()); }
}

fn blob_read(interactive: bool) -> BoxFuture<'static, Result<HashMap<String, String>, String>> {
    let since = BLOB_READ.generation();
    // The debug file bypass cannot hang on a prompt, and tests point it at
    // different files: its read is never shared with anyone else's.
    #[cfg(test)]
    let shared_test = test_shared_blob_read();
    let unshared_debug = test_credentials_path().is_some();
    #[cfg(test)]
    let unshared_debug = unshared_debug && shared_test.is_none();
    if unshared_debug {
        return unshared(move || load_credentials_blob(interactive)).boxed();
    }
    BLOB_READ
        .read_since(since, interactive, move |interactive| {
            #[cfg(test)]
            if let Some(test) = shared_test { return test.load(); }
            load_blob_raw(interactive)
        })
        .map(|r| {
            r.and_then(|blob| {
                blob.ok_or_else(|| format!("failed to read keychain: {}", keyring::Error::NoEntry))
            })
        })
        .boxed()
}

/// The blob as stored, `None` when nothing ever was: sealed store, then the
/// debug file bypass, then the keychain, the precedence `store_credentials`
/// keeps. Every other failure is an `Err`, never an empty blob, because the
/// writers below start from what this answers.
fn load_blob_raw(interactive: bool) -> Result<Option<HashMap<String, String>>, String> {
    if let Some(store) = sealed() {
        return store.secrets().map(|s| Some(s.credentials));
    }
    if let Some(path) = test_credentials_path() {
        return match std::fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|_| "failed to parse test credentials".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("failed to read test credentials: {}", e.kind())),
        };
    }
    keychain_blob(interactive)
}

/// The blob was written outside `change_credentials` (the shell's own
/// `store_credentials`, announced by `oauth2.credentials_changed`): a read
/// already out may predate that write, so the next writer must not join it.
pub(crate) fn blob_written_elsewhere() {
    BLOB_READ.bump();
}

/// `load_blob_raw` started no earlier than write generation `since` (see
/// `SingleFlight::read_since`).
fn raw_read(
    interactive: bool,
    since: u64,
) -> BoxFuture<'static, Result<Option<HashMap<String, String>>, String>> {
    if test_credentials_path().is_some() {
        return unshared(move || load_blob_raw(interactive)).boxed();
    }
    BLOB_READ
        .read_since(since, interactive, load_blob_raw)
        .boxed()
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

static BLOB_READ: SingleFlight<Option<HashMap<String, String>>> = SingleFlight::new();
static AI_KEY_READ: SingleFlight<Option<String>> = SingleFlight::new();

/// At most one blocking read per keychain item. A read parked on a prompt
/// nobody answers does not come back, and a caller's timeout cannot cancel a
/// blocking thread; with a new thread per attempt the scheduled worker's
/// five-minute retries would drain tokio's blocking pool over a weekend. A
/// caller that finds a read already out waits on that one, so concurrent
/// callers (`sync.watch` for every account on reconnect) share one read, and
/// `keychain.retry` joins a read still waiting on the prompt the user can see.
pub(crate) struct SingleFlight<T> {
    /// The read out, whether it may prompt, and the write generation it
    /// started in.
    out: std::sync::Mutex<Option<(bool, u64, SharedRead<T>)>>,
    /// Bumped after every write this daemon makes to the item, and for the
    /// blob after every write the shell announces: a read that started
    /// before it may not have seen that write.
    generation: std::sync::atomic::AtomicU64,
}

impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    pub(crate) const fn new() -> Self {
        Self {
            out: std::sync::Mutex::new(None),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// The current write generation.
    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// A write to the item landed: reads already out are stale for a caller
    /// that asks `read_since` the new generation. Answers it.
    pub(crate) fn bump(&self) -> u64 {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
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
        self.read_since(0, interactive, read).await
    }

    /// `read`, answered only by a read that started in generation `since` or
    /// later: one already out from before a write is waited out (never a
    /// second thread beside it), then a fresh one starts. What a writer and
    /// the app's own reads use, so neither works from a blob older than the
    /// last write the daemon made.
    pub(crate) async fn read_since(
        &'static self,
        since: u64,
        interactive: bool,
        read: impl FnOnce(bool) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let mut read = Some(read);
        loop {
            let (answers, shared) = {
                let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
                match &*out {
                    Some((out_interactive, started, shared)) => {
                        #[cfg(test)]
                        test_blob_join(self as *const Self as usize);
                        ((*out_interactive || !interactive) && *started >= since, shared.clone())
                    }
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
                        *out = Some((interactive, self.generation(), shared.clone()));
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
            // A plain read, not `read_entry`: this item stays out of the gate.
            let primary = match with_interaction(interactive, || entry.get_password()) {
                Ok(primary) => primary,
                Err(keyring::Error::NoEntry) => return Ok(Vec::new()),
                Err(e) => return Err(format!("failed to read keychain: {e}")),
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

/// The imported OpenPGP keys, off the async workers and under a clock, and
/// never prompting. Outside the keychain gate on purpose: decryption is best
/// effort, and neither the watcher nor `keychain.retry` re-reads this item,
/// so a block here would hold sync and scheduled sends with nothing to clear it.
pub async fn resolve_pgp_keys_guarded() -> Result<Vec<mailvault_core::pgp::StoredKey>, String> {
    tokio::time::timeout(AI_KEY_TIMEOUT, pgp_keys_read(false)).await.unwrap_or_else(|_| {
        Err("the keychain did not answer in time (it may be locked or waiting on a prompt)".to_string())
    })
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

// ── The app's credentials, read and written here (Phase 1, step 0b) ────────
//
// Native preparation: the existing app adapters still use the shell path.
// `credentials.get` explicitly returns the blob with the existing status, and
// `credentials.save` / `.update` / `.delete` change it one account at a
// time. Each change reads the blob fresh (never a read that started before
// the last write), applies only the ids it names, and writes the whole blob
// back in the store's own order, one change at a time. A read that did not
// succeed fails the change: starting from an empty blob would drop every
// other account's secrets. Only "nothing stored yet" starts from empty.
//
// Same backends and precedence as the app's commands: a portable copy's
// sealed store, then the debug file bypass, then the keychain (service
// `com.mailvault.app`, entry `credentials`, split into parts on Windows).
// On the keychain the primary item is updated in place, never deleted and
// recreated, so on macOS it keeps the access list it was created with.
//
// Mutation replies, events and logs carry only ids, counts and catalog keys.
// The explicit credentials.get read intentionally returns stored records.

/// Why a change was refused or failed; the RPC answers the catalog key.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CredError {
    /// The blob could not be read (locked, refused, no answer, unparseable,
    /// a locked portable store): nothing was written.
    Unavailable,
    /// The write failed or outlived its reply clock. A timed-out blocking
    /// write may still complete; this does not prove storage is unchanged.
    WriteFailed,
    /// A write is parked (a keychain prompt nobody answered) or the one
    /// ahead took too long: nothing was written, try again later.
    Busy,
    /// The request is not a set of records the app writes.
    Invalid,
    /// An update for another grant than the one stored (a newer sign-in was
    /// saved since): nothing was written. An answer, not an error.
    StaleGrant,
}

impl CredError {
    pub(crate) fn catalog_key(&self) -> &'static str {
        match self {
            CredError::Unavailable => "errors.keychainUnavailable",
            CredError::WriteFailed => "errors.keychainWriteFailed",
            CredError::Busy => "errors.keychainBusy",
            CredError::Invalid | CredError::StaleGrant => "errors.credentialsInvalid",
        }
    }
}

/// One change the app asks for.
#[derive(Debug, Clone)]
pub(crate) enum CredChange {
    /// Each record replaces the one stored under its id (or is added). A
    /// record is the JSON text of an account object, stored as given.
    Save(HashMap<String, String>),
    /// `Save` for the ids the blob does not hold yet only: what the account
    /// list still carried from an older release, kept before it is scrubbed.
    SaveIfAbsent(HashMap<String, String>),
    /// These top-level fields merged into the stored record of `id`; nothing
    /// when there is no such record. With `chain` (the grant fingerprints of
    /// a refreshed pair, `oauth_tokens`), only over a stored record of that
    /// grant (else `StaleGrant`), and a refresh token only when it is a new
    /// one of the same grant.
    Update {
        id: String,
        fields: serde_json::Map<String, Value>,
        chain: Option<Vec<String>>,
    },
    Delete(Vec<String>),
}

fn valid_records(records: &HashMap<String, String>) -> Result<(), CredError> {
    for (id, record) in records {
        let parsed = serde_json::from_str::<Value>(record).map_err(|_| CredError::Invalid)?;
        if id.is_empty() || !parsed.is_object() {
            return Err(CredError::Invalid);
        }
    }
    Ok(())
}

/// The ids `change` changes in `blob`, applied.
pub(crate) fn apply_change(
    blob: &mut HashMap<String, String>,
    change: &CredChange,
) -> Result<Vec<String>, CredError> {
    let mut changed = Vec::new();
    match change {
        CredChange::Save(records) | CredChange::SaveIfAbsent(records) => {
            valid_records(records)?;
            let only_new = matches!(change, CredChange::SaveIfAbsent(_));
            let mut ids: Vec<&String> = records.keys().collect();
            ids.sort();
            for id in ids {
                let record = &records[id];
                if only_new && blob.contains_key(id) {
                    continue;
                }
                if blob.get(id) != Some(record) {
                    blob.insert(id.clone(), record.clone());
                    changed.push(id.clone());
                }
            }
        }
        CredChange::Update { id, fields, chain } => {
            let Some(raw) = blob.get(id) else {
                return Ok(changed);
            };
            let Ok(Value::Object(mut record)) = serde_json::from_str::<Value>(raw) else {
                return Err(CredError::Unavailable);
            };
            let mut fields = fields.clone();
            if let Some(chain) = chain {
                let stored = Value::Object(record.clone());
                // The grant stored now must be the pair's own.
                if !crate::oauth_tokens::record_fingerprint(&stored, None)
                    .is_some_and(|fp| chain.contains(&fp))
                {
                    return Err(CredError::StaleGrant);
                }
                let sent = fields
                    .get("oauth2RefreshToken")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(rt) = sent {
                    let same = record.get("oauth2RefreshToken").and_then(Value::as_str)
                        == Some(rt.as_str());
                    let of_chain = crate::oauth_tokens::record_fingerprint(&stored, Some(&rt))
                        .is_some_and(|fp| chain.contains(&fp));
                    if same || !of_chain {
                        fields.remove("oauth2RefreshToken");
                    }
                }
            }
            let before = record.clone();
            for (k, v) in fields {
                record.insert(k, v);
            }
            if record != before {
                blob.insert(id.clone(), Value::Object(record).to_string());
                changed.push(id.clone());
            }
        }
        CredChange::Delete(ids) => {
            for id in ids {
                if blob.remove(id).is_some() && !changed.contains(id) {
                    changed.push(id.clone());
                }
            }
        }
    }
    Ok(changed)
}

/// What the app's `get_credentials` answered, from the daemon's read:
/// `{status, credentials}` (`granted`, `empty`) or `{status, message}`
/// (`denied`, `timed_out`, `unavailable`). The message is a code or a fixed
/// sentence, never the store's own error text (a parse error quotes values).
pub(crate) async fn app_read() -> Value {
    let since = BLOB_READ.generation();
    match guarded(
        CREDENTIALS_KEY,
        raw_read(may_prompt(), since),
        AI_KEY_TIMEOUT,
    )
    .await
    {
        Ok(Some(blob)) if !blob.is_empty() => json!({"status": "granted", "credentials": blob}),
        Ok(_) => json!({"status": "empty", "credentials": {}}),
        Err(e) => {
            let (status, message) = read_failure(&e);
            json!({"status": status, "message": message})
        }
    }
}

/// The status and message for a failed read.
fn read_failure(error: &str) -> (&'static str, String) {
    if error == E_PORTABLE_LOCKED {
        return ("unavailable", E_PORTABLE_LOCKED.to_string());
    }
    if error.contains("did not answer in time") {
        return (
            "timed_out",
            "The keychain did not answer in time".to_string(),
        );
    }
    let denied = GATE.status()["reason"] == "denied";
    let fallback = if denied {
        "Keychain access was refused"
    } else {
        "The keychain could not be read"
    };
    let message =
        mailvault_core::keychain::snap_keyring_hint(std::env::var_os("SNAP").is_some(), error)
            .map(str::to_owned)
            .unwrap_or_else(|| fallback.to_string());
    (if denied { "denied" } else { "unavailable" }, message)
}

/// One change at a time, across every backend: read, apply, write.
static APP_WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// A write that outlived its clock still holds `APP_WRITE` until it returns
/// (so nothing it then lands can overwrite a newer change); every change
/// asked for meanwhile is answered `Busy` at once instead of queueing.
pub(crate) static WRITE_PARKED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// How long a change waits for the one ahead of it.
const APP_LOCK_WAIT: Duration = Duration::from_secs(5);

#[cfg(test)]
pub(crate) static TEST_WRITE_TIMEOUT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
/// Test seam: the next debug-file write parks until this is sent to.
#[cfg(test)]
pub(crate) static TEST_WRITE_GATE: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) static TEST_WRITE_ENTERED: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> = std::sync::Mutex::new(None);
#[cfg(test)]
pub(crate) static TEST_WRITE_FINISHED: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> = std::sync::Mutex::new(None);

fn write_timeout() -> Duration {
    #[cfg(test)]
    {
        let ms = TEST_WRITE_TIMEOUT_MS.load(std::sync::atomic::Ordering::SeqCst);
        if ms > 0 {
            return Duration::from_millis(ms);
        }
    }
    AI_KEY_TIMEOUT
}

/// The write generation now (the `version` the credentials RPCs answer).
pub(crate) fn write_generation() -> u64 {
    BLOB_READ.generation()
}

type Job = Box<dyn FnOnce() -> Result<Vec<String>, CredError> + Send>;

/// Finalizes the actual backend outcome while APP_WRITE still excludes the
/// next writer. A late completion has exactly the same state effects; its
/// already-timed-out RPC remains an error.
fn finish_credential_change(
    state: &Arc<DaemonState>,
    result: Result<Vec<String>, CredError>,
) -> Result<(Vec<String>, u64), CredError> {
    match result {
        Ok(ids) if ids.is_empty() => Ok((ids, BLOB_READ.generation())),
        Ok(ids) => {
            let version = BLOB_READ.bump();
            info!("[keychain] credentials changed for {} account(s)", ids.len());
            crate::handlers::oauth2::credentials_written(state);
            state.events.emit(crate::handlers::credentials::CHANGED_EVENT, json!({"ids": ids, "version": version}));
            Ok((ids, version))
        }
        Err(CredError::WriteFailed) => {
            // A failed platform write or JoinError may follow a side effect.
            // Re-read before trusting tokens, without claiming a change.
            BLOB_READ.bump();
            state.tokens.credentials_changed();
            Err(CredError::WriteFailed)
        }
        Err(error) => Err(error),
    }
}


/// Applies `change` to the stored blob. `Ok((ids, version))`: the ids it
/// changed (none: nothing was written) and the write generation after it.
/// At most `APP_LOCK_WAIT` + the read's clock + `write_timeout()` long.
pub(crate) async fn change_credentials(
    state: &Arc<DaemonState>,
    change: CredChange,
) -> Result<(Vec<String>, u64), CredError> {
    use std::sync::atomic::Ordering::SeqCst;
    if WRITE_PARKED.load(SeqCst) {
        return Err(CredError::Busy);
    }
    let Ok(held) = tokio::time::timeout(APP_LOCK_WAIT, APP_WRITE.lock()).await else {
        return Err(CredError::Busy);
    };
    if WRITE_PARKED.load(SeqCst) {
        return Err(CredError::Busy);
    }
    let job: Job = if let Some(store) = sealed() {
        Box::new(move || store.change_credentials(|blob| apply_change(blob, &change)))
    } else if let Some(path) = test_credentials_path() {
        Box::new(move || change_test_file(&path, &change))
    } else {
        // A blocked gate would only answer a quiet read's failure: fail fast,
        // and never raise a prompt from here while one episode is open.
        if GATE.is_blocked() {
            return Err(CredError::Unavailable);
        }
        let since = BLOB_READ.generation();
        let mut blob = match guarded(CREDENTIALS_KEY, raw_read(true, since), AI_KEY_TIMEOUT).await {
            Ok(blob) => blob.unwrap_or_default(),
            Err(_) => return Err(CredError::Unavailable),
        };
        let changed = apply_change(&mut blob, &change)?;
        if changed.is_empty() {
            return Ok((changed, since));
        }
        let json = serde_json::to_string(&blob).map_err(|_| CredError::WriteFailed)?;
        Box::new(move || {
            with_interaction(true, || write_keychain_blob(&json))
                .map(|()| changed)
                .map_err(|e| {
                    warn!("[keychain] the credentials write failed: {e}");
                    CredError::WriteFailed
                })
        })
    };
    let mut task = tokio::task::spawn_blocking(job);
    let finished = tokio::time::timeout(write_timeout(), &mut task).await;
    match finished {
        Ok(result) => finish_credential_change(state, result.unwrap_or(Err(CredError::WriteFailed))),
        Err(_) => {
            warn!("[keychain] the credentials write did not finish in time; changes wait until it returns");
            WRITE_PARKED.store(true, SeqCst);
            let state = Arc::clone(state);
            tokio::spawn(async move {
                let result = task.await.unwrap_or(Err(CredError::WriteFailed));
                let _ = finish_credential_change(&state, result);
                WRITE_PARKED.store(false, SeqCst);
                drop(held);
                #[cfg(test)]
                if let Some(done) = TEST_WRITE_FINISHED.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = done.send(());
                }
            });
            Err(CredError::WriteFailed)
        }
    }
}

/// The debug file bypass: the same compact `{id: record}` JSON the app's
/// `store_credentials` writes there, replaced atomically.
fn change_test_file(path: &std::path::Path, change: &CredChange) -> Result<Vec<String>, CredError> {
    let mut blob: HashMap<String, String> = match std::fs::read_to_string(path) {
        Ok(json) => serde_json::from_str(&json).map_err(|_| CredError::Unavailable)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(_) => return Err(CredError::Unavailable),
    };
    let changed = apply_change(&mut blob, change)?;
    if changed.is_empty() {
        return Ok(changed);
    }
    let json = serde_json::to_string(&blob).map_err(|_| CredError::WriteFailed)?;
    #[cfg(test)]
    {
        let gate = TEST_WRITE_GATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(gate) = gate {
            if let Some(entered) = TEST_WRITE_ENTERED.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = entered.send(());
            }
            let _ = gate.recv();
        }
    }
    mailvault_core::fsx::write_atomic(path, json.as_bytes()).map_err(|_| CredError::WriteFailed)?;
    Ok(changed)
}

/// The blob into the keychain, parts first (Windows), in the order the
/// app's `store_credentials` keeps (`mailvault_core::keychain`).
fn write_keychain_blob(json: &str) -> Result<(), String> {
    use mailvault_core::keychain::{
        secret_limit, write_split_secret, SecretStore, SplitWriteError,
    };
    struct Keyring;
    impl SecretStore for Keyring {
        fn get(&mut self, name: &str) -> Result<Option<String>, String> {
            match Entry::new(KEYRING_SERVICE, name).and_then(|e| e.get_password()) {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        fn set(&mut self, name: &str, value: &str) -> Result<(), String> {
            Entry::new(KEYRING_SERVICE, name)
                .and_then(|e| e.set_password(value))
                .map_err(|e| e.to_string())
        }
        fn delete(&mut self, name: &str) -> Result<(), String> {
            Entry::new(KEYRING_SERVICE, name)
                .and_then(|e| e.delete_credential())
                .map_err(|e| e.to_string())
        }
    }
    let generation = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let written = write_split_secret(
        &mut Keyring,
        CREDENTIALS_KEY,
        json,
        secret_limit(),
        &generation,
    )
    .map_err(|e| match e {
        SplitWriteError::Part(e) => format!("a part could not be written: {e}"),
        SplitWriteError::Primary(e) => format!("the entry could not be written: {e}"),
    })?;
    for (name, e) in written.stale_left {
        warn!("[keychain] could not remove stale credentials part {name}: {e}");
    }
    Ok(())
}

impl SealedStore {
    /// `apply` on the open store's account blob, sealed to the drive when it
    /// changed something. Locked refuses (the caller would start from the
    /// empty set it sees while locked).
    pub(crate) fn change_credentials(
        &self,
        apply: impl FnOnce(&mut HashMap<String, String>) -> Result<Vec<String>, CredError>,
    ) -> Result<Vec<String>, CredError> {
        let mut guard = self.opened();
        let Some((passphrase, current)) = guard.as_mut() else {
            return Err(CredError::Unavailable);
        };
        let mut next = current.clone();
        let changed = apply(&mut next.credentials)?;
        if changed.is_empty() {
            return Ok(changed);
        }
        mailvault_core::portable::write_sealed(&self.path, passphrase, &next, self.params)
            .map_err(|_| CredError::WriteFailed)?;
        *current = next;
        Ok(changed)
    }
}

// The runtime keeps a second worker available so Drop can release and join
// a synthetic blocking job even while an assertion unwinds this test.
#[cfg(test)]
pub(crate) struct TestWritePause {
    release: Option<std::sync::mpsc::Sender<()>>,
    entered: std::sync::mpsc::Receiver<()>,
    done: Option<std::sync::mpsc::Receiver<()>>,
}

#[cfg(test)]
impl TestWritePause {
    pub(crate) fn arm() -> Self {
        use crate::credentials::{TEST_WRITE_ENTERED, TEST_WRITE_FINISHED, TEST_WRITE_GATE, TEST_WRITE_TIMEOUT_MS};
        let (release, gate) = std::sync::mpsc::channel();
        let (started, entered) = std::sync::mpsc::channel();
        let (finished, done) = std::sync::mpsc::channel();
        *TEST_WRITE_GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(gate);
        *TEST_WRITE_ENTERED.lock().unwrap_or_else(|e| e.into_inner()) = Some(started);
        *TEST_WRITE_FINISHED.lock().unwrap_or_else(|e| e.into_inner()) = Some(finished);
        TEST_WRITE_TIMEOUT_MS.store(300, std::sync::atomic::Ordering::SeqCst);
        Self { release: Some(release), entered, done: Some(done) }
    }

    pub(crate) fn wait_until_entered(&self) {
        self.entered.recv_timeout(Duration::from_secs(5)).expect("the synthetic write entered its gate");
    }

    pub(crate) fn finish(&mut self) {
        self.release.take();
        self.done.as_ref().unwrap().recv_timeout(Duration::from_secs(5)).expect("terminal completion and exclusion release");
        self.done.take();
    }
}

#[cfg(test)]
impl Drop for TestWritePause {
    fn drop(&mut self) {
        self.release.take();
        if let Some(done) = self.done.take() {
            if done.recv_timeout(Duration::from_secs(5)).is_err() {
                eprintln!("credential test could not drain its blocking write; refusing fixture teardown");
                std::process::abort();
            }
        }
        crate::credentials::TEST_WRITE_TIMEOUT_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        crate::credentials::TEST_WRITE_GATE.lock().unwrap_or_else(|e| e.into_inner()).take();
        crate::credentials::TEST_WRITE_ENTERED.lock().unwrap_or_else(|e| e.into_inner()).take();
        crate::credentials::TEST_WRITE_FINISHED.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}


#[cfg(test)]
pub(crate) struct TestEnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

#[cfg(test)]
impl TestEnvRestore {
    pub(crate) fn capture() -> Self {
        Self(
            [
                "MAILVAULT_TEST_CREDENTIALS",
                "MAILVAULT_TEST_AI_KEY",
                "MAILVAULT_TEST_PGP_KEYS",
            ]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect(),
        )
    }
}

#[cfg(test)]
impl Drop for TestEnvRestore {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
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
        let _restore_env = TestEnvRestore::capture();

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

    /// The shell writes the blob itself (`store_credentials`) and then tells
    /// the daemon (`oauth2.credentials_changed`). A keychain read already out
    /// from before that write holds the old blob, so a daemon write that
    /// starts after the notice (`change_credentials` reads at the current
    /// generation) must wait that read out and read again; joining it would
    /// write the old blob back over the shell's change.
    #[tokio::test]
    async fn a_write_after_the_shells_notice_never_joins_a_read_from_before_it() {
        let _guard = test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _restore_env = TestEnvRestore::capture();
        let dir = std::env::temp_dir().join(format!("mv-cred-notice-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir, true);
        let blob = |v: &str| Some(HashMap::from([("acct-1".to_string(), v.to_string())]));

        let started = Started::default();
        let (release, parked) = std::sync::mpsc::channel::<()>();
        let s = started.clone();
        let stale =
            tokio::spawn(
                BLOB_READ.read_since(BLOB_READ.generation(), true, move |interactive| {
                    s.lock().unwrap().push(interactive);
                    let _ = parked.recv();
                    Ok(blob("before the shell wrote"))
                }),
            );
        until_started(&started, 1).await;

        let notice = crate::server::handle_request_for_test(
            &state,
            "oauth2.credentials_changed",
            serde_json::json!({}),
        )
        .await;
        assert!(notice.error.is_none(), "the notice is answered");

        let s = started.clone();
        let write_read =
            tokio::spawn(
                BLOB_READ.read_since(BLOB_READ.generation(), true, move |interactive| {
                    s.lock().unwrap().push(interactive);
                    Ok(blob("what the shell wrote"))
                }),
            );
        tokio::time::sleep(Duration::from_millis(50)).await;
        release.send(()).unwrap();
        assert_eq!(stale.await.unwrap(), Ok(blob("before the shell wrote")));
        assert_eq!(
            write_read.await.unwrap(),
            Ok(blob("what the shell wrote")),
            "the write reads the blob the shell wrote"
        );
        assert_eq!(
            *started.lock().unwrap(),
            vec![true, true],
            "a fresh read after the parked one, never beside it"
        );
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
        assert_eq!(
            sealed_store_path(Some(root)),
            Some(root.join("data").join("credentials.sealed"))
        );
        assert_eq!(
            sealed_store_path(None),
            None,
            "an installed copy keeps the OS keychain"
        );
    }

    #[test]
    fn save_if_absent_keeps_existing_record_bytes() {
        let old = "{ \"id\": \"a\", \"password\": \"synthetic-original\" }";
        let mut blob = HashMap::from([("a".to_string(), old.to_string())]);
        let records = HashMap::from([
            ("a".to_string(), "{}".to_string()),
            ("b".to_string(), "{}".to_string()),
        ]);
        assert_eq!(
            apply_change(&mut blob, &CredChange::SaveIfAbsent(records)).unwrap(),
            vec!["b"]
        );
        assert_eq!(blob["a"], old);
        assert_eq!(blob["b"], "{}");
    }

    #[test]
    fn sealed_per_record_changes_refuse_locked_and_keep_unrelated_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = sealed_with_one_account(dir.path());
        let before = std::fs::read(store.path()).unwrap();
        let change = CredChange::Save(HashMap::from([("acct-2".to_string(), "{}".to_string())]));
        assert_eq!(
            store.change_credentials(|blob| apply_change(blob, &change)),
            Err(CredError::Unavailable)
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), before);
        store.unlock("drive passphrase").unwrap();
        assert_eq!(
            store
                .change_credentials(|blob| apply_change(blob, &change))
                .unwrap(),
            vec!["acct-2"]
        );
        let disk = read_sealed(store.path(), "drive passphrase").unwrap();
        assert_eq!(disk.credentials["acct-1"], sample_account_json());
        assert_eq!(disk.credentials["acct-2"], "{}");
        let before = std::fs::read(store.path()).unwrap();
        assert!(store
            .change_credentials(|blob| apply_change(blob, &change))
            .unwrap()
            .is_empty());
        assert_eq!(
            std::fs::read(store.path()).unwrap(),
            before,
            "a sealed no-op does not rewrite the file"
        );
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
        let _restore_env = TestEnvRestore::capture();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai_key");
        std::env::set_var("MAILVAULT_TEST_AI_KEY", &path);

        assert_eq!(resolve_ai_endpoint_key_guarded().await.unwrap(), None, "nothing stored yet reads as None, not an error");

        store_ai_endpoint_key_guarded("sk-test-123".to_string()).await.unwrap();
        assert_eq!(resolve_ai_endpoint_key_guarded().await.unwrap().as_deref(), Some("sk-test-123"));

        std::env::remove_var("MAILVAULT_TEST_AI_KEY");
    }
}
