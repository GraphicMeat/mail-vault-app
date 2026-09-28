//! A message's raw bytes for every reader that needs the whole file (Track H,
//! task H3c): attachments, inline `cid:` images, View Source, `.eml` export,
//! attachment export. With download modes a listed message can have no vault
//! `.eml` (On Demand, evicted, never cached), so the vault is only the first
//! place to look.
//!
//! `raw_message` is the one path: the vault file when there is one; else the
//! in-memory copy On Demand keeps (`RawLru`); else the server, on the priority
//! lane (a user action). Bytes from memory or the server are used only when
//! their Message-ID agrees with the header cache's row, and a downloaded
//! message is kept the way an open keeps a body (`imap::auto_cache`, opened:
//! written in every mode but On Demand, never `A`); one the vault did not
//! keep goes to memory. Any server failure (offline, refused, timed out,
//! gone) answers the vault's own "not found" error, unchanged, which is what
//! the app matches on.
//!
//! Timing: one download per message at a time (a per-message lock; other
//! messages never wait on it), the whole fallback bounded by
//! `FALLBACK_BOUND` (under the app's 75 s reply budget for these routes), and
//! a failure remembered for `FAILURE_MEMO` so the reads queued behind it, and
//! the app's own retries, fail at once instead of dialling again.
//!
//! `local_message` is the no-network half (vault, then memory), for the
//! attachment bar's mount-time "already cached?" probe.
//!
//! Graph accounts: the daemon holds no Graph token, so it cannot fetch one
//! here. What `graph_cache_mime` fetched for an open and did not keep is in
//! the in-memory copy; past that, the vault's error stands.
use crate::handlers::common::{blocking, vault_root, with_vault_write};
use crate::imap::{self, ImapConfig};
use crate::server::DaemonState;
use mailvault_core::fetch_mode::{same_message, RawLru};
use mailvault_core::vault_files;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Bodies On Demand keeps in memory. A message is kept whole, so the byte
/// cap is what bounds the daemon's memory, the count what bounds the scan.
// ponytail: fixed caps; a setting if someone reads 20+ large messages at once.
const LRU_MESSAGES: usize = 20;
const LRU_BYTES: usize = 100 * 1024 * 1024;

/// The whole server fallback of one read: waiting for this message's lock,
/// the keychain read, connect, the body fetch (itself capped at 45 s) and
/// the cache write. The app's reply budget for the routes that may download
/// is 75 s (`reply_timeout` in `src-tauri/src/main.rs`): a hung server
/// answers the vault's error before the app gives up on the daemon.
const FALLBACK_BOUND: Duration = Duration::from_secs(60);

/// How long a failed download answers "not found" without dialling again.
const FAILURE_MEMO: Duration = Duration::from_secs(30);

/// Folders that exist only on this computer: never asked of the server.
const LOCAL_ONLY_MAILBOXES: &[&str] = &[crate::handlers::scheduled::MAILBOX];

type Key = (String, String, u32);

pub(crate) struct RawMessages {
    lru: Mutex<RawLru>,
    /// One download per message: an attachment bar asks for the inline
    /// images and every attachment at once, and the second read of the same
    /// message waits, then finds the first's copy. Entries are dropped once
    /// nobody holds them.
    fetching: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<()>>>>,
    /// Downloads that failed, and when.
    failed: Mutex<HashMap<Key, Instant>>,
    /// Tests only: the credentials `raw_message` resolves. The keychain is
    /// never read under `cfg(test)`; a missing account is "no server".
    #[cfg(test)]
    pub(crate) accounts: Mutex<HashMap<String, ImapConfig>>,
    /// Tests only: `FALLBACK_BOUND`, shortened.
    #[cfg(test)]
    pub(crate) bound: Mutex<Duration>,
}

impl Default for RawMessages {
    fn default() -> Self {
        RawMessages {
            lru: Mutex::new(RawLru::new(LRU_MESSAGES, LRU_BYTES)),
            fetching: Mutex::new(HashMap::new()),
            failed: Mutex::new(HashMap::new()),
            #[cfg(test)]
            accounts: Mutex::new(HashMap::new()),
            #[cfg(test)]
            bound: Mutex::new(FALLBACK_BOUND),
        }
    }
}

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl RawMessages {
    /// A body the user opened that the vault did not keep (On Demand, a
    /// hidden account, a failed write): the reads that follow the open (its
    /// inline images, its attachments) are served from memory.
    pub(crate) fn remember(&self, account_id: &str, mailbox: &str, uid: u32, raw: impl Into<Arc<[u8]>>) {
        locked(&self.lru).put(account_id, mailbox, uid, raw);
    }

    fn recall(&self, account_id: &str, mailbox: &str, uid: u32) -> Option<Arc<[u8]>> {
        locked(&self.lru).get(account_id, mailbox, uid)
    }

    fn holds(&self, account_id: &str, mailbox: &str, uid: u32) -> bool {
        locked(&self.lru).contains(account_id, mailbox, uid)
    }

    fn lock_for(&self, key: &Key) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(locked(&self.fetching).entry(key.clone()).or_default())
    }

    /// Drop `key`'s lock once no read holds it.
    fn tidy(&self, key: &Key) {
        let mut map = locked(&self.fetching);
        if map.get(key).is_some_and(|lock| Arc::strong_count(lock) == 1) {
            map.remove(key);
        }
    }

    fn failed_recently(&self, key: &Key) -> bool {
        locked(&self.failed).get(key).is_some_and(|at| at.elapsed() < FAILURE_MEMO)
    }

    fn note_failure(&self, key: &Key) {
        let mut failed = locked(&self.failed);
        failed.retain(|_, at| at.elapsed() < FAILURE_MEMO);
        failed.insert(key.clone(), Instant::now());
    }

    fn bound(&self) -> Duration {
        #[cfg(test)]
        return *locked(&self.bound);
        #[cfg(not(test))]
        FALLBACK_BOUND
    }
}

/// The message's bytes: `readable` for everything parsed out of it
/// (attachments, parts: an OpenPGP message decrypted), else the original
/// (View Source, `.eml` export).
pub(crate) async fn raw_message(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, readable: bool) -> Result<Arc<[u8]>, String> {
    if let Some(raw) = local_message(state, account_id, mailbox, uid, readable).await? {
        return Ok(raw);
    }
    if LOCAL_ONLY_MAILBOXES.contains(&mailbox) {
        return Err(missing(uid));
    }
    let key: Key = (account_id.to_string(), mailbox.to_string(), uid);
    let lock = state.raw_messages.lock_for(&key);
    let outcome = tokio::time::timeout(state.raw_messages.bound(), fallback(state, &key, lock, readable)).await;
    state.raw_messages.tidy(&key);
    outcome.unwrap_or_else(|_| {
        warn!("[raw] {account_id}/{mailbox} uid {uid}: server fallback gave up after {:?}", state.raw_messages.bound());
        state.raw_messages.note_failure(&key);
        Err(missing(uid))
    })
}

/// The no-network half of `raw_message`: the vault file, else the in-memory
/// copy (checked against the header cache). `Ok(None)`: neither holds it.
pub(crate) async fn local_message(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, readable: bool) -> Result<Option<Arc<[u8]>>, String> {
    if let Some(raw) = from_vault(state, account_id, mailbox, uid, readable).await? {
        return Ok(Some(raw.into()));
    }
    let Some(raw) = state.raw_messages.recall(account_id, mailbox, uid) else { return Ok(None) };
    verify(state, account_id, mailbox, uid, &raw).await?;
    readable_bytes(state, account_id, mailbox, uid, raw, false, readable).await.map(Some)
}

fn missing(uid: u32) -> String {
    format!("Email UID {} not found", uid)
}

/// Holds `key`'s lock for the whole download, so a read of the same message
/// queued behind it finds the copy it leaves (or its failure) instead of
/// downloading again.
async fn fallback(state: &Arc<DaemonState>, key: &Key, lock: Arc<tokio::sync::Mutex<()>>, readable: bool) -> Result<Arc<[u8]>, String> {
    let (account_id, mailbox, uid) = (key.0.as_str(), key.1.as_str(), key.2);
    let _one = lock.lock().await;
    if let Some(raw) = local_message(state, account_id, mailbox, uid, readable).await? {
        return Ok(raw);
    }
    if state.raw_messages.failed_recently(key) {
        return Err(missing(uid));
    }
    let raw = match from_server(state, account_id, mailbox, uid).await {
        Ok(Some(raw)) => raw,
        Ok(None) => {
            state.raw_messages.note_failure(key);
            return Err(missing(uid));
        }
        Err(e) => {
            info!("[raw] {account_id}/{mailbox} uid {uid}: no vault copy, server fallback failed: {e}");
            state.raw_messages.note_failure(key);
            return Err(missing(uid));
        }
    };
    verify(state, account_id, mailbox, uid, &raw).await?;
    let cached = crate::handlers::imap::auto_cache(state, account_id.to_string(), mailbox.to_string(), uid, raw.clone(), None, true).await;
    let raw: Arc<[u8]> = raw.into();
    if !cached {
        state.raw_messages.remember(account_id, mailbox, uid, Arc::clone(&raw));
    }
    readable_bytes(state, account_id, mailbox, uid, raw, cached, readable).await
}

/// `raw` must be the message the header cache lists under `uid`. A header
/// cache that cannot be read is no proof either way: refused, so nothing
/// unverified is shown or written.
async fn verify(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, raw: &[u8]) -> Result<(), String> {
    let listed = listed_message_id(state, account_id, mailbox, uid).await?;
    if same_message(listed.as_deref(), raw) {
        return Ok(());
    }
    warn!("[raw] {account_id}/{mailbox} uid {uid}: the server's message is not the one the header cache lists; refused");
    Err(format!("Message UID {uid} in {mailbox} is now a different message on the server; refresh the folder"))
}

/// An OpenPGP message decrypted for a `readable` read (`render` blocks on
/// the keychain: off the runtime); anything else as it is.
async fn readable_bytes(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, raw: Arc<[u8]>, in_vault: bool, readable: bool) -> Result<Arc<[u8]>, String> {
    if !readable || !mailvault_core::pgp::is_encrypted(&raw) {
        return Ok(raw);
    }
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    blocking(move || crate::handlers::pgp::render(&state, &account_id, &mailbox, uid, raw.to_vec(), in_vault).0.into()).await
}

/// `Ok(None)`: the vault verifiably does not hold the uid. An unreachable
/// vault or an unlistable folder is an `Err` and never reaches the server.
async fn from_vault(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, readable: bool) -> Result<Option<Vec<u8>>, String> {
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    blocking(move || {
        let root = vault_root(&state)?;
        vault_files::read_message(&state.vault_registry, &root, &account_id, &mailbox, uid, readable)
    })
    .await
    .and_then(|r| r)
}

/// The Message-ID the header cache lists for `uid`. `Ok(None)`: it lists no
/// row, or the row carries no id (no proof either way: let through). `Err`:
/// the store could not be read.
async fn listed_message_id(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<String>, String> {
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    let rows = blocking(move || {
        crate::custody::with_conn(&state, |c| mailvault_core::custody::cache::load_by_uids(c, &account_id, &mailbox, &[uid]))
    })
    .await
    .and_then(|r| r)
    .map_err(|e| format!("Message UID {uid} could not be checked against the folder's listing: {e}"))?;
    Ok(rows
        .into_iter()
        .next()
        .and_then(|row| row.get("messageId").or_else(|| row.get("message_id")).and_then(Value::as_str).map(str::to_string)))
}

/// The whole message from the server. `Ok(None)`: the server proved the uid
/// is gone (or answered for another uid).
async fn from_server(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<Vec<u8>>, String> {
    let config = account_config(state, account_id).await?;
    if config.oauth2_transport.as_deref() == Some("graph") {
        return Err("a Graph account's message is fetched through the app's Graph token, which the daemon does not hold".to_string());
    }
    let mb = mailbox.to_string();
    let fetch = state.imap_pool.run_read(&config, true, |mut session| {
        let mb = mb.clone();
        async move {
            let email = imap::fetch_email_by_uid_light(&mut session, &mb, uid).await?;
            Ok((email, session, Some(mb)))
        }
    });
    match tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, fetch).await {
        Ok(Ok(Some(email))) if email.uid == uid => Ok(Some(email.raw_source_bytes)),
        Ok(Ok(_)) => Ok(None),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("timed out after {}s", crate::handlers::imap::BODY_FETCH_TIMEOUT.as_secs())),
    }
}

/// Removes attachment-cache files written before `older_than` whose message
/// has neither a vault `.eml` (a verified miss) nor an in-memory copy. Parts
/// of a vault-held message stay (the eviction worker removes those with the
/// `.eml`); these are On Demand's, which no eviction ever reaches. Any doubt
/// (vault unreachable, header cache unreadable, folder unverified) keeps the
/// file. Returns how many it removed.
pub(crate) async fn prune_attachment_cache(state: &Arc<DaemonState>, older_than: std::time::SystemTime) -> usize {
    let state = Arc::clone(state);
    blocking(move || {
        let Ok(root) = vault_root(&state) else { return 0 };
        let mailboxes = match crate::custody::with_conn(&state, |c| mailvault_core::custody::cache::mailboxes_with_headers(c, None)) {
            Ok(m) => m,
            Err(e) => {
                warn!("[raw] attachment cache not pruned: header cache unreadable: {e}");
                return 0;
            }
        };
        let stale = vault_files::stale_attachment_cache_files(&root.join("attachment_cache"), &mailboxes, older_than, &mut |a, m, uid| {
            state.raw_messages.holds(a, m, uid) || state.vault_registry.resolve(&root, a, m, uid) != Some(None)
        });
        let removed = stale
            .iter()
            .filter(|path| with_vault_write(&state, |_| std::fs::remove_file(path).map_err(|e| e.to_string())).is_ok())
            .count();
        if removed > 0 {
            info!("[raw] removed {removed} attachment cache file(s) of messages kept nowhere on this computer");
        }
        removed
    })
    .await
    .unwrap_or(0)
}

#[cfg(not(test))]
pub(crate) async fn account_config(_state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    crate::credentials::resolve_account_credentials_guarded(account_id).await
}

#[cfg(test)]
pub(crate) async fn account_config(state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    state.raw_messages.accounts.lock().unwrap().get(account_id).cloned().ok_or_else(|| "no credentials in this test".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::RpcResponse;
    use crate::server::handle_request_for_test;
    use base64::Engine;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{MockImap, Scenario};
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    const PDF: &[u8] = b"%PDF-1.4 server copy";

    fn raw_with_attachment(message_id: &str) -> String {
        let pdf = base64::engine::general_purpose::STANDARD.encode(PDF);
        format!(
            "From: a@example.com\r\nTo: user@example.com\r\nSubject: Report\r\nDate: Thu, 01 Jan 2015 00:00:00 +0000\r\n\
             Message-ID: {message_id}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n\
             --b1\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n\
             --b1\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\n{pdf}\r\n--b1--\r\n"
        )
    }

    fn server_with(uid: u32, raw: &str) -> MockImap {
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(uid, raw.to_string()));
        MockImap::start(Scenario::new().mailbox(inbox))
    }

    fn config(host: &str, port: u16) -> ImapConfig {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        serde_json::from_value(json!({"email": "user@example.com", "password": "hunter2", "imapHost": host, "imapPort": port})).unwrap()
    }

    /// A vault in `mode`, with `server` as account `acc1`'s credentials and a
    /// header row for uid 1 carrying `listed` as its Message-ID.
    fn state(mode: &str, server: Option<&MockImap>, listed: &str) -> (PathBuf, Arc<DaemonState>) {
        let dir = std::env::temp_dir().join(format!("mv-raw-message-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir.clone(), true);
        std::fs::write(
            dir.join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"fetchMode": mode, "localCacheDurationMonths": 3}}}).to_string(),
        )
        .unwrap();
        if let Some(server) = server {
            s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config(&server.host(), server.port()));
        }
        let headers = json!({"emails": [{"uid": 1, "messageId": listed, "subject": "Report"}]}).to_string();
        crate::custody::with_conn(&s, |c| mailvault_core::custody::cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
        (dir, s)
    }

    fn vault_files_of(dir: &Path) -> Vec<String> {
        let cur = dir.join("Maildir").join("acc1").join("INBOX").join("cur");
        let mut names: Vec<String> = std::fs::read_dir(&cur)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    fn fetches(server: &MockImap) -> usize {
        server.count_commands("BODY.PEEK[]")
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        handle_request_for_test(s, method, params).await
    }

    fn attachment(uid: u32) -> Value {
        json!({"accountId": "acc1", "mailbox": "INBOX", "uid": uid, "attachmentIndex": 0})
    }

    fn b64(bytes: &[u8]) -> Value {
        json!(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// Keep Recent: the message the user asked for is kept the way an open
    /// keeps it, a cache copy with no `A` (only a backup vouches for one).
    #[tokio::test]
    async fn an_attachment_with_no_vault_file_comes_from_the_server_and_keep_recent_keeps_a_copy_without_a() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("keepRecent", Some(&server), "<r1@example.com>");

        let r = call(&s, "maildir_read_attachment", attachment(1)).await;

        assert_eq!(r.result, Some(b64(PDF)), "{:?}", r.error);
        let files = vault_files_of(&dir);
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(mailvault_core::maildir::info_flags(&files[0]).is_some(), "a maildir name: {}", files[0]);
        let flags = mailvault_core::vault_eml::parse_flags_from_filename(&files[0]);
        assert!(!flags.iter().any(|f| f == "archived"), "a cache copy is never marked archived: {}", files[0]);
        // The next read is the vault's.
        call(&s, "maildir_read_attachment", attachment(1)).await.result.expect("second read");
        assert_eq!(fetches(&server), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On Demand: nothing lands on disk, and the second read is memory's.
    #[tokio::test]
    async fn on_demand_keeps_no_file_and_a_second_read_hits_memory() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");

        for _ in 0..2 {
            let r = call(&s, "maildir_read_attachments", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "attachmentIndices": [0]})).await;
            assert_eq!(r.result, Some(json!([b64(PDF)])), "{:?}", r.error);
        }

        assert!(vault_files_of(&dir).is_empty(), "On Demand writes no body");
        assert_eq!(fetches(&server), 1, "the second read must not go back to the server");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// View Source and the `.eml` export both read `maildir_read_raw_source`:
    /// the server's bytes, verbatim.
    #[tokio::test]
    async fn raw_source_with_no_vault_file_is_the_servers_message_verbatim() {
        let raw = raw_with_attachment("<r1@example.com>");
        let server = server_with(1, &raw);
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");

        let r = call(&s, "maildir_read_raw_source", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1})).await;

        assert_eq!(r.result, Some(b64(raw.as_bytes())), "{:?}", r.error);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A uid the server reissued names another message: refused, and nothing
    /// is written or kept.
    #[tokio::test]
    async fn a_message_id_that_contradicts_the_header_is_an_error_and_writes_nothing() {
        let server = server_with(1, &raw_with_attachment("<someone-else@example.com>"));
        let (dir, s) = state("keepRecent", Some(&server), "<r1@example.com>");

        let r = call(&s, "maildir_read_attachment", attachment(1)).await;

        let err = r.error.expect("refused").message;
        assert!(!err.contains("not found"), "a mismatch is not a miss the app retries: {err}");
        assert!(vault_files_of(&dir).is_empty(), "nothing written");
        call(&s, "maildir_read_attachment", attachment(1)).await.error.expect("still refused");
        assert_eq!(fetches(&server), 2, "and nothing kept in memory either");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Offline: the vault's own error, word for word.
    #[tokio::test]
    async fn offline_with_no_vault_file_keeps_the_existing_error() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let (dir, s) = state("keepRecent", None, "<r1@example.com>");
        s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config("127.0.0.1", port));

        for method in ["maildir_read_attachment", "maildir_read_raw_source"] {
            let r = call(&s, method, attachment(1)).await;
            assert_eq!(r.error.expect("no copy anywhere").message, "Email UID 1 not found", "{method}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression guard: a message the vault holds never costs a server call.
    #[tokio::test]
    async fn a_vault_file_is_read_without_asking_the_server() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("keepRecent", Some(&server), "<r1@example.com>");
        let vault_copy = raw_with_attachment("<r1@example.com>").replace("See attached.", "Vault copy.");
        let raw_b64 = base64::engine::general_purpose::STANDARD.encode(&vault_copy);
        call(&s, "maildir_store", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "rawSourceBase64": raw_b64, "flags": []}))
            .await
            .result
            .expect("stored");

        let r = call(&s, "maildir_read_raw_source", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1})).await;
        assert_eq!(r.result, Some(b64(vault_copy.as_bytes())));
        call(&s, "maildir_read_attachment", attachment(1)).await.result.expect("attachment");

        assert_eq!(server.connection_count(), 0, "the server was never dialled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `localOnly` (the Notes to Self photo preview): a message the vault does
    /// not hold is not found, and the server is never dialled for it; one the
    /// vault holds reads as usual.
    #[tokio::test]
    async fn a_local_only_attachment_read_never_dials_the_server() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        // Keep Recent: a server read here would leave a vault file behind.
        let (dir, s) = state("keepRecent", Some(&server), "<r1@example.com>");
        let mut params = attachment(1);
        params["localOnly"] = json!(true);

        let r = call(&s, "maildir_read_attachment", params.clone()).await;
        assert_eq!(r.error.expect("no local copy").message, "Email UID 1 not found");
        assert_eq!(server.connection_count(), 0, "the server was never dialled");
        assert!(vault_files_of(&dir).is_empty(), "nothing was downloaded into the vault");

        let raw_b64 = base64::engine::general_purpose::STANDARD.encode(raw_with_attachment("<r1@example.com>"));
        call(&s, "maildir_store", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "rawSourceBase64": raw_b64, "flags": []}))
            .await
            .result
            .expect("stored");
        let r = call(&s, "maildir_read_attachment", params).await;
        assert_eq!(r.result, Some(b64(PDF)), "{:?}", r.error);
        assert_eq!(server.connection_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An attachment bar asks for every attachment's path and the inline
    /// images at once: one download serves them all.
    #[tokio::test]
    async fn concurrent_reads_of_one_uncached_message_download_it_once() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");

        let (a, b, c) = tokio::join!(
            call(&s, "maildir_read_attachment", attachment(1)),
            call(&s, "cached_attachment_path", attachment(1)),
            call(&s, "maildir_read_raw_source", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1})),
        );

        assert!(a.error.is_none() && b.error.is_none() && c.error.is_none(), "{:?} {:?} {:?}", a.error, b.error, c.error);
        assert_eq!(fetches(&server), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Open With / drag-out / Download All: the attachment cache and the
    /// export folder are filled from the server's copy.
    #[tokio::test]
    async fn cache_and_export_of_an_uncached_message_use_the_servers_copy() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");

        let path = call(&s, "cache_attachment", attachment(1)).await.result.expect("cached");
        assert_eq!(std::fs::read(path.as_str().unwrap()).unwrap(), PDF);
        let looked_up = call(&s, "cached_attachment_path", attachment(1)).await.result.expect("looked up");
        assert_eq!(looked_up, path);

        let dest = dir.join("out").join("Report attachments");
        let mut events = s.events.subscribe();
        let r = call(
            &s,
            "export_attachments",
            json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "indices": [0], "destDir": dest.to_string_lossy(), "jobId": "r-1"}),
        )
        .await;
        r.result.expect("export started");
        let (_, last) = crate::handlers::vault_files::finished_export(&mut events, "r-1").await;
        assert!(last.get("error").is_none(), "{last}");
        assert_eq!(std::fs::read(dest.join("report.pdf")).unwrap(), PDF);

        let bulk = dir.join("out").join("Bulk");
        let r = call(
            &s,
            "views.export_attachments",
            json!({"destDir": bulk.to_string_lossy(), "messages": [{"accountId": "acc1", "mailbox": "INBOX", "uid": 1}], "jobId": "r-2"}),
        )
        .await;
        r.result.expect("bulk export started");
        let (_, last) = crate::handlers::vault_files::finished_export(&mut events, "r-2").await;
        let out = last["result"].clone();
        assert_eq!((out["files"].clone(), out["skipped"].clone()), (json!(1), json!(0)), "{out}");
        assert_eq!(std::fs::read(bulk.join("report.pdf")).unwrap(), PDF);

        assert!(vault_files_of(&dir).is_empty(), "On Demand writes no body");
        assert_eq!(fetches(&server), 1, "one download served every export");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On Demand: the open itself (`imap_get_email_light`) keeps the body in
    /// memory, so the inline images and attachments that follow need no
    /// second download.
    #[tokio::test]
    async fn an_on_demand_open_serves_the_reads_that_follow_it() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");
        let account = json!({"email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()});

        let open = call(&s, "imap_get_email_light", json!({"account": account, "uid": 1, "mailbox": "INBOX", "accountId": "acc1"})).await;
        assert_eq!(open.result.expect("opened")["cached"], json!(false));
        let r = call(&s, "maildir_read_attachments", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "attachmentIndices": [0]})).await;

        assert_eq!(r.result, Some(json!([b64(PDF)])), "{:?}", r.error);
        assert_eq!(fetches(&server), 1, "the open's download is the only one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Graph: the daemon has no token, so it must never try the account's
    /// config over IMAP. The vault's error stands.
    #[tokio::test]
    async fn a_graph_account_is_never_tried_over_imap() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", None, "<r1@example.com>");
        let mut graph = config(&server.host(), server.port());
        graph.oauth2_transport = Some("graph".into());
        s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), graph);

        let r = call(&s, "maildir_read_attachment", attachment(1)).await;

        assert_eq!(r.error.expect("no copy").message, "Email UID 1 not found");
        assert_eq!(server.connection_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── fix round 1 ──

    fn stalling(scenario: Scenario, needle: &str) -> Scenario {
        scenario.fault(mock_imap::scenario::Trigger::with("FETCH", needle), mock_imap::scenario::Action::StallMidResponse(0))
    }

    /// A read the vault or memory can answer never waits on another
    /// message's download, however long that one takes.
    #[tokio::test]
    async fn a_memory_hit_never_waits_behind_another_messages_download() {
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, raw_with_attachment("<r1@example.com>")));
        let server = MockImap::start(stalling(Scenario::new().mailbox(inbox), "1 (UID"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");
        s.raw_messages.remember("acc1", "INBOX", 2, raw_with_attachment("<r2@example.com>").into_bytes());

        let blocked = {
            let s = Arc::clone(&s);
            tokio::spawn(async move { call(&s, "maildir_read_attachment", attachment(1)).await })
        };
        // Let the download of uid 1 take its lock and stall on the FETCH.
        for _ in 0..100 {
            if fetches(&server) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fetches(&server), 1, "uid 1's download is in flight");

        let hit = tokio::time::timeout(Duration::from_secs(5), call(&s, "maildir_read_attachment", attachment(2))).await;

        assert_eq!(hit.expect("uid 2 must not wait on uid 1").result, Some(b64(PDF)));
        assert!(!blocked.is_finished(), "uid 1 is still stalled: the hit really overlapped it");
        blocked.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The mount-time "already cached?" probe never dials the server (nor
    /// reads the keychain): no local copy is simply "not cached".
    #[tokio::test]
    async fn cached_attachment_path_with_no_local_copy_never_dials_the_server() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");

        let r = call(&s, "cached_attachment_path", attachment(1)).await;

        assert_eq!(r.result, Some(Value::Null), "{:?}", r.error);
        assert_eq!(server.connection_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A download that just failed is not retried by the reads queued behind
    /// it, nor by the app's own retries a moment later.
    #[tokio::test]
    async fn a_read_after_a_failed_download_fails_without_dialling_again() {
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, raw_with_attachment("<r1@example.com>")));
        let scenario = Scenario::new()
            .mailbox(inbox)
            .fault(mock_imap::scenario::Trigger::with("FETCH", "BODY.PEEK[]"), mock_imap::scenario::Action::Respond("NO".into(), "try later".into()));
        let server = MockImap::start(scenario);
        let (dir, s) = state("keepRecent", Some(&server), "<r1@example.com>");

        let (a, b) = tokio::join!(call(&s, "maildir_read_attachment", attachment(1)), call(&s, "maildir_read_attachment", attachment(1)));
        let (fetched, dialled) = (fetches(&server), server.connection_count());
        let c = call(&s, "maildir_read_raw_source", attachment(1)).await;

        for r in [a, b, c] {
            assert_eq!(r.error.expect("no copy").message, "Email UID 1 not found");
        }
        assert!(fetched >= 1, "the first read did ask the server");
        assert_eq!((fetches(&server), server.connection_count()), (fetched, dialled), "the later reads did not");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A server that accepts the FETCH and goes quiet answers the existing
    /// error within the daemon's own bound, not the app's reply budget.
    #[tokio::test]
    async fn a_stalled_server_answers_the_existing_error_within_the_daemons_bound() {
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, raw_with_attachment("<r1@example.com>")));
        let server = MockImap::start(stalling(Scenario::new().mailbox(inbox), "BODY.PEEK[]"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");
        *s.raw_messages.bound.lock().unwrap() = Duration::from_millis(500);

        let started = Instant::now();
        let r = tokio::time::timeout(Duration::from_secs(10), call(&s, "maildir_read_attachment", attachment(1)))
            .await
            .expect("bounded by the daemon");

        assert_eq!(r.error.expect("no copy").message, "Email UID 1 not found");
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A header cache that cannot be read proves nothing: the bytes are
    /// neither shown nor written.
    #[tokio::test]
    async fn an_unreadable_header_cache_refuses_the_servers_copy_and_writes_nothing() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("keepRecent", Some(&server), "<r1@example.com>");
        *mailvault_core::custody::lock(&s.custody.db) = None;

        let r = call(&s, "maildir_read_attachment", attachment(1)).await;

        let err = r.error.expect("refused").message;
        assert!(err.contains("could not be checked"), "{err}");
        assert!(vault_files_of(&dir).is_empty(), "nothing unverified is written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A folder that exists only on this computer is never asked of the server.
    #[tokio::test]
    async fn a_local_only_mailbox_never_falls_back_to_the_server() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");

        let r = call(&s, "maildir_read_raw_source", json!({"accountId": "acc1", "mailbox": "Scheduled", "uid": 1})).await;

        assert_eq!(r.error.expect("no copy").message, "Email UID 1 not found");
        assert_eq!(server.connection_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Parts extracted for a message kept nowhere on this computer are
    /// removed; those of a vault-held or in-memory message stay.
    #[tokio::test]
    async fn the_attachment_cache_prune_removes_only_parts_of_messages_kept_nowhere() {
        let server = server_with(1, &raw_with_attachment("<r1@example.com>"));
        let (dir, s) = state("onDemand", Some(&server), "<r1@example.com>");
        // uid 1: extracted from the server's copy, which memory now holds.
        let in_memory = call(&s, "cache_attachment", attachment(1)).await.result.expect("cached");
        // uid 7: a vault message's part.
        let raw_b64 = base64::engine::general_purpose::STANDARD.encode(raw_with_attachment("<r7@example.com>"));
        call(&s, "maildir_store", json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 7, "rawSourceBase64": raw_b64, "flags": []}))
            .await
            .result
            .expect("stored");
        let cache = dir.join("attachment_cache");
        let (vault_part, orphan) = (cache.join("acc1_INBOX_7_0_kept.pdf"), cache.join("acc1_INBOX_5_0_gone.pdf"));
        std::fs::write(&vault_part, PDF).unwrap();
        std::fs::write(&orphan, PDF).unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(60);

        assert_eq!(prune_attachment_cache(&s, std::time::UNIX_EPOCH).await, 0, "nothing is a day old yet");
        let removed = prune_attachment_cache(&s, later).await;

        assert_eq!(removed, 1);
        assert!(!orphan.exists(), "uid 5 is kept nowhere");
        assert!(vault_part.exists(), "uid 7 is in the vault");
        assert!(Path::new(in_memory.as_str().unwrap()).exists(), "uid 1 is in memory");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
