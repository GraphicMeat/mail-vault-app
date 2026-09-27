//! A message's raw bytes for every reader that needs the whole file (Track H,
//! task H3c): attachments, inline `cid:` images, View Source, `.eml` export,
//! attachment export. With download modes a listed message can have no vault
//! `.eml` (On Demand, evicted, never cached), so the vault is only the first
//! place to look.
//!
//! `raw_message` is the one path: the vault file when there is one; else the
//! in-memory copy On Demand keeps (`RawLru`); else the server, on the priority
//! lane (a user action), checked against the header cache's Message-ID before
//! it is used or kept, then kept the way an open keeps a body
//! (`imap::auto_cache`, opened: written in every mode but On Demand, never
//! `A`). A body the vault did not keep goes to the in-memory copy instead.
//! Any server failure (offline, refused, timed out, gone) answers the vault's
//! own "not found" error, unchanged, which is what the app matches on.
//!
//! Graph accounts: the daemon holds no Graph token, so it cannot fetch one
//! here. What `graph_cache_mime` fetched for an open and did not keep is in
//! the in-memory copy; past that, the vault's error stands.
use crate::handlers::common::{blocking, vault_root};
use crate::imap::{self, ImapConfig};
use crate::server::DaemonState;
use mailvault_core::fetch_mode::{same_message, RawLru};
use mailvault_core::vault_files;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

/// Bodies On Demand keeps in memory. A message is kept whole, so the byte
/// cap is what bounds the daemon's memory, the count what bounds the scan.
// ponytail: fixed caps; a setting if someone reads 20+ large messages at once.
const LRU_MESSAGES: usize = 20;
const LRU_BYTES: usize = 100 * 1024 * 1024;

pub(crate) struct RawMessages {
    lru: Mutex<RawLru>,
    /// One server fallback at a time. A message's attachment bar asks for
    /// every attachment's cached path and its inline images at once; without
    /// this each would download the same message. The second waits, then
    /// finds the first's copy in the vault or in memory.
    // ponytail: one lock for every message; per-message locks if unrelated
    // fallbacks queueing behind a slow server ever shows.
    fetching: tokio::sync::Mutex<()>,
    /// Tests only: the credentials `raw_message` resolves. The keychain is
    /// never read under `cfg(test)`; a missing account is "no server".
    #[cfg(test)]
    pub(crate) accounts: Mutex<std::collections::HashMap<String, ImapConfig>>,
}

impl Default for RawMessages {
    fn default() -> Self {
        RawMessages {
            lru: Mutex::new(RawLru::new(LRU_MESSAGES, LRU_BYTES)),
            fetching: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            accounts: Mutex::new(Default::default()),
        }
    }
}

impl RawMessages {
    /// A body the user opened that the vault did not keep (On Demand, a
    /// hidden account, a failed write): the reads that follow the open (its
    /// inline images, its attachments) are served from memory.
    pub(crate) fn remember(&self, account_id: &str, mailbox: &str, uid: u32, raw: Vec<u8>) {
        self.lru.lock().unwrap_or_else(|p| p.into_inner()).put(account_id, mailbox, uid, raw);
    }

    fn recall(&self, account_id: &str, mailbox: &str, uid: u32) -> Option<Vec<u8>> {
        self.lru.lock().unwrap_or_else(|p| p.into_inner()).get(account_id, mailbox, uid)
    }
}

/// The message's bytes: `readable` for everything parsed out of it
/// (attachments, parts: an OpenPGP message decrypted), else the original
/// (View Source, `.eml` export).
pub(crate) async fn raw_message(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, readable: bool) -> Result<Vec<u8>, String> {
    if let Some(raw) = from_vault(state, account_id, mailbox, uid, readable).await? {
        return Ok(raw);
    }
    let _one = state.raw_messages.fetching.lock().await;
    // The fallback that held the lock may just have written it.
    if let Some(raw) = from_vault(state, account_id, mailbox, uid, readable).await? {
        return Ok(raw);
    }
    let missing = || format!("Email UID {} not found", uid);
    let (raw, fetched) = match state.raw_messages.recall(account_id, mailbox, uid) {
        Some(raw) => (raw, false),
        None => match from_server(state, account_id, mailbox, uid).await {
            Ok(Some(raw)) => (raw, true),
            Ok(None) => return Err(missing()),
            Err(e) => {
                info!("[raw] {account_id}/{mailbox} uid {uid}: no vault copy, server fallback failed: {e}");
                return Err(missing());
            }
        },
    };
    let listed = listed_message_id(state, account_id, mailbox, uid).await;
    if !same_message(listed.as_deref(), &raw) {
        warn!("[raw] {account_id}/{mailbox} uid {uid}: the server's message is not the one the header cache lists; refused");
        return Err(format!("Message UID {uid} in {mailbox} is now a different message on the server; refresh the folder"));
    }
    let cached = fetched
        && crate::handlers::imap::auto_cache(state, account_id.to_string(), mailbox.to_string(), uid, raw.clone(), None, true).await;
    if fetched && !cached {
        state.raw_messages.remember(account_id, mailbox, uid, raw.clone());
    }
    if !readable {
        return Ok(raw);
    }
    let state2 = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    // `render` blocks on the keychain for an encrypted message: off the runtime.
    blocking(move || crate::handlers::pgp::render(&state2, &account_id, &mailbox, uid, raw, cached).0).await
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

/// The Message-ID the header cache lists for `uid`; `None` when it lists no
/// row, the row carries no id, or the store is closed (no proof either way).
async fn listed_message_id(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Option<String> {
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    let rows = blocking(move || {
        crate::custody::with_conn(&state, |c| mailvault_core::custody::cache::load_by_uids(c, &account_id, &mailbox, &[uid]))
    })
    .await
    .ok()?
    .ok()?;
    let row = rows.into_iter().next()?;
    row.get("messageId").or_else(|| row.get("message_id")).and_then(Value::as_str).map(str::to_string)
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

#[cfg(not(test))]
async fn account_config(_state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
    crate::credentials::resolve_account_credentials_guarded(account_id).await
}

#[cfg(test)]
async fn account_config(state: &DaemonState, account_id: &str) -> Result<ImapConfig, String> {
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
        let flags = files[0].split(":2,").nth(1).unwrap_or("");
        assert!(!flags.contains('A'), "a cache copy is never marked archived: {}", files[0]);
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
        let r = call(
            &s,
            "export_attachments",
            json!({"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "indices": [0], "destDir": dest.to_string_lossy()}),
        )
        .await;
        r.result.expect("exported");
        assert_eq!(std::fs::read(dest.join("report.pdf")).unwrap(), PDF);

        let bulk = dir.join("out").join("Bulk");
        let r = call(
            &s,
            "views.export_attachments",
            json!({"destDir": bulk.to_string_lossy(), "messages": [{"accountId": "acc1", "mailbox": "INBOX", "uid": 1}]}),
        )
        .await;
        let out = r.result.expect("bulk export");
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
}
