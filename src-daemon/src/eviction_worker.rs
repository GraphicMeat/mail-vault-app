//! Eviction worker (Track H, task H3): deletes working-cache copies of mail
//! the account's download mode no longer keeps on this computer (On Demand:
//! all of them; Keep Recent: older than the window; Index Only: once the
//! search index holds the body). Level-triggered like `auto_tag_worker.rs`:
//! every pass re-derives what to delete from the vault, a FRESH server
//! listing and the header cache; nothing is queued. Woken daily and by the
//! `storage.fetch_mode_changed` RPC; never on the click path.
//!
//! A non-archived cache copy can be the LAST copy of a message: a server
//! expunge prunes the header cache, never the `.eml`. So a copy is deleted
//! only when all of these hold, else it stays:
//! - the uid is in a server listing taken in this pass, on the background
//!   lane, under the same UIDVALIDITY the header cache records;
//! - the header cache lists the uid with the file's own Message-ID (the
//!   search index keeps an evicted message's row only while it does);
//! - the copy's CURRENT name carries neither `A` nor `D` (re-read at delete
//!   time by `vault_files::evict_files`), and it is in `cur/`, not `orphaned/`.
//!
//! Any error (settings unreadable, listing failed, header cache unreadable,
//! vault unlistable) evicts nothing in that scope and logs once. Hoarder,
//! Keep Recent with window 0 and hidden accounts evict nothing. Graph
//! accounts are skipped: the daemon cannot list a Graph folder on its own
//! (it never refreshes an OAuth token), so their copies stay.

use crate::credentials;
use crate::handlers::common::{blocking, with_mailbox_write};
use crate::imap::{self, ImapConfig};
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use mailvault_core::fetch_mode::{eviction_plan, FetchMode, FetchPolicy};
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::vault_files;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

/// The first pass waits out the launch (sync, backfill, the user's first
/// clicks); a mode change wakes it at once.
const FIRST_PASS_DELAY: Duration = Duration::from_secs(10 * 60);
const PASS_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Files judged and deleted per `with_mailbox_write`: the mailbox lock and
/// the vault gate are held for one chunk, never a whole large folder, so a
/// click's auto-cache in the same folder waits for at most one chunk.
const CHUNK: usize = 256;
/// Ceiling on one folder's uid listing, connect and permit wait included.
const LISTING_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct EvictionWorkerState {
    pub notify: Arc<tokio::sync::Notify>,
}

impl Default for EvictionWorkerState {
    fn default() -> Self {
        Self { notify: Arc::new(tokio::sync::Notify::new()) }
    }
}

impl EvictionWorkerState {
    /// `storage.fetch_mode_changed`: the app saved a new mode or window.
    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

pub(crate) fn start(state: Arc<DaemonState>) {
    tokio::spawn(async move { run(state).await });
}

async fn run(state: Arc<DaemonState>) {
    info!("[evict] worker started");
    let mut wait = FIRST_PASS_DELAY;
    loop {
        // `Notify` keeps one permit, so a wake during a pass runs one more.
        tokio::select! {
            _ = state.eviction_worker.notify.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
        wait = PASS_EVERY;
        // A daily background job must not be what raises the keychain
        // prompt, and offline every listing would fail anyway.
        if !state.net.is_online() || credentials::GATE.is_blocked() {
            info!("[evict] pass skipped: offline or keychain locked");
            continue;
        }
        sweep(&state).await;
    }
}

/// One pass over every account the header cache knows.
pub(crate) async fn sweep(state: &Arc<DaemonState>) {
    let app_dir = state.app_dir.clone();
    let settings = match blocking(move || crate::handlers::imap::read_settings_state(&app_dir)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) | Err(e) => {
            warn!("[evict] nothing evicted this pass: {e}");
            return;
        }
    };
    let st = Arc::clone(state);
    let rows = match blocking(move || crate::custody::with_conn(&st, |c| cache::mailboxes_with_headers(c, None))).await {
        Ok(Ok(rows)) => rows,
        Ok(Err(e)) | Err(e) => {
            warn!("[evict] nothing evicted this pass: header cache unreadable: {e}");
            return;
        }
    };
    let mut accounts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (account_id, mailbox) in rows {
        accounts.entry(account_id).or_default().push(mailbox);
    }
    let now = crate::handlers::imap::now_ms();
    for (account_id, mailboxes) in accounts {
        // Hidden: no policy at all.
        let Some(policy) = FetchPolicy::from_settings(&settings, &account_id) else { continue };
        if policy.mode == FetchMode::Hoarder || (policy.mode == FetchMode::KeepRecent && policy.window_months == 0) {
            continue;
        }
        // Index Only with no body index evicts nothing: said once per
        // account, before any folder is looked at.
        if policy.mode == FetchMode::IndexOnly {
            if let Err(e) = crate::search_index::indexes_bodies(&state.search_index) {
                info!("[evict] {account_id}: evicted=0 skipped_reason=index_unavailable: {e}");
                continue;
            }
        }
        let config = match credentials::resolve_account_credentials_guarded(&account_id).await {
            Ok(c) => c,
            Err(e) => {
                warn!("[evict] {account_id}: nothing evicted, credentials unavailable: {e}");
                continue;
            }
        };
        if config.oauth2_transport.as_deref() == Some("graph") {
            info!("[evict] {account_id}: skipped_reason=graph_account");
            continue;
        }
        // Two server folders filed under one vault folder: a uid would not
        // say which folder's message it is. Keep both.
        let mut per_dir: HashMap<String, usize> = HashMap::new();
        for mailbox in &mailboxes {
            *per_dir.entry(vault_dir_name(mailbox)).or_default() += 1;
        }
        for mailbox in &mailboxes {
            if per_dir[&vault_dir_name(mailbox)] > 1 {
                info!("[evict] {account_id} {mailbox}: evicted=0 skipped_reason=shared_vault_folder");
                continue;
            }
            evict_mailbox(state, &config, &account_id, mailbox, &policy, now).await;
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub evicted: usize,
    pub kept: usize,
    pub skipped: Option<String>,
}

/// One mailbox. Logs one `info!` line with what it did and returns it.
pub(crate) async fn evict_mailbox(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    policy: &FetchPolicy,
    now_ms: i64,
) -> Outcome {
    let outcome = evict_mailbox_inner(state, config, account_id, mailbox, policy, now_ms).await;
    info!(
        "[evict] {account_id} {mailbox}: evicted={} kept={} skipped_reason={}",
        outcome.evicted,
        outcome.kept,
        outcome.skipped.as_deref().unwrap_or("none")
    );
    outcome
}

async fn evict_mailbox_inner(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    policy: &FetchPolicy,
    now_ms: i64,
) -> Outcome {
    let skip = |kept: usize, reason: String| Outcome { evicted: 0, kept, skipped: Some(reason) };

    // Cheap first look (names only): no cache copy, no network.
    let (st, acct, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    let listed = blocking(move || with_mailbox_write(&st, &acct, &mb, |root| vault_files::list_on_disk(root, &acct, &mb, None))).await;
    let cache_uids: Vec<u32> = match listed {
        Ok(Ok(rows)) => rows
            .into_iter()
            .filter(|r| !r.flags.iter().any(|f| f == "archived" || f == "draft"))
            .map(|r| r.uid)
            .collect(),
        Ok(Err(e)) | Err(e) => return skip(0, format!("vault_unreadable: {e}")),
    };
    if cache_uids.is_empty() {
        return skip(0, "no_cache_copies".into());
    }
    let total = cache_uids.len();

    // Index Only evicts only what the index already holds the body of.
    let indexed = if policy.mode == FetchMode::IndexOnly {
        match crate::search_index::body_indexed_uids(&state.search_index, account_id, mailbox) {
            Ok(uids) => uids,
            Err(e) => return skip(total, format!("index_unavailable: {e}")),
        }
    } else {
        HashSet::new()
    };

    // The fresh listing, on the background lane, with its UIDVALIDITY.
    let mb = mailbox.to_string();
    let fetch = state.imap_pool.run_read(config, false, |mut session| {
        let mb = mb.clone();
        async move {
            let listing = imap::search_all_uid_flags_in_generation(&mut session, &mb).await?;
            Ok((listing, session, Some(mb)))
        }
    });
    let (server_validity, server) = match tokio::time::timeout(LISTING_TIMEOUT, fetch).await {
        Ok(Ok((validity, rows))) => (validity, rows.into_iter().map(|(uid, _)| uid).collect::<HashSet<u32>>()),
        Ok(Err(e)) => return skip(total, format!("server_listing_failed: {e}")),
        Err(_) => return skip(total, "server_listing_timed_out".into()),
    };

    // The header cache's uids must belong to the generation just listed.
    let (st, acct, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    let cached_validity = match blocking(move || crate::custody::with_conn(&st, |c| cache::sync_meta(c, &acct, &mb))).await {
        Ok(Ok((validity, _))) => validity,
        Ok(Err(e)) | Err(e) => return skip(total, format!("header_cache_unreadable: {e}")),
    };
    if server_validity.is_none() || server_validity != cached_validity {
        return skip(total, format!("uidvalidity server={server_validity:?} header_cache={cached_validity:?}"));
    }

    let on_server: Vec<u32> = cache_uids.into_iter().filter(|uid| server.contains(uid)).collect();
    let mut evicted = 0usize;
    let server = Arc::new(server);
    let indexed = Arc::new(indexed);
    for chunk in on_server.chunks(CHUNK) {
        let chunk: Vec<u32> = chunk.to_vec();
        let (st, acct, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
        let (server, indexed, policy) = (Arc::clone(&server), Arc::clone(&indexed), policy.clone());
        let pass = blocking(move || {
            with_mailbox_write(&st, &acct, &mb, |root| {
                let uids: HashSet<u32> = chunk.iter().copied().collect();
                let copies = vault_files::cache_copies(root, &acct, &mb, &uids)?;
                let vault_dir = vault_dir_name(&mb);
                let listed = crate::custody::with_conn(&st, |c| cache::listed_message_ids(c, &acct, &vault_dir, &chunk))?;
                let plan: HashSet<u32> = eviction_plan(&copies, &policy, now_ms, &server, &listed, &indexed).into_iter().collect();
                if plan.is_empty() {
                    return Ok(0);
                }
                vault_files::evict_files(&st.vault_registry, root, &acct, &mb, &plan).map(|gone| gone.len())
            })
        })
        .await;
        match pass {
            Ok(Ok(n)) => evicted += n,
            Ok(Err(e)) | Err(e) => {
                return Outcome { evicted, kept: total.saturating_sub(evicted), skipped: Some(format!("stopped: {e}")) };
            }
        }
    }
    Outcome { evicted, kept: total.saturating_sub(evicted), skipped: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::maildir::INFO_PREFIX;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{Action, MockImap, Scenario, Trigger};
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    const ACCT: &str = "acc1";

    fn raw(uid: u32) -> String {
        format!(
            "From: a@example.com\r\nSubject: Msg {uid}\r\nDate: Thu, 01 Jan 2015 00:00:00 +0000\r\nMessage-ID: <m{uid}@example.com>\r\n\r\nBody {uid}\r\n"
        )
    }

    /// A server INBOX holding `uids`, under UIDVALIDITY `validity`.
    fn server(uids: &[u32], validity: u32) -> Scenario {
        let mut inbox = Mailbox::new("INBOX").with_uid_validity(validity);
        for &uid in uids {
            inbox.add(Message::new(uid, raw(uid)));
        }
        Scenario::new().mailbox(inbox)
    }

    fn config(server: &MockImap) -> ImapConfig {
        serde_json::from_value(json!({
            "email": "user@example.com", "password": "hunter2",
            "imapHost": server.host(), "imapPort": server.port(),
        }))
        .unwrap()
    }

    /// A daemon with custody open, the vault holding cache copies of uids 1
    /// and 2 and an archived copy of uid 3, and a header cache listing
    /// `listed` under UIDVALIDITY 1.
    fn state(listed: &[u32]) -> (PathBuf, Arc<DaemonState>) {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let dir = std::env::temp_dir().join(format!("mv-evict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir.clone(), true);
        crate::custody::open_into(&s).unwrap();
        let cur = cur(&dir);
        std::fs::create_dir_all(&cur).unwrap();
        for (uid, flags) in [(1, "S"), (2, "S"), (3, "AS")] {
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}{flags}.eml")), raw(uid)).unwrap();
        }
        let emails: Vec<Value> = listed.iter().map(|uid| json!({"uid": uid, "messageId": format!("<m{uid}@example.com>")})).collect();
        let data = json!({"emails": emails, "uidValidity": 1, "totalEmails": listed.len()}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, ACCT, "INBOX", &data)).unwrap();
        (dir, s)
    }

    fn cur(dir: &Path) -> PathBuf {
        vault_files::cur_path(dir, ACCT, "INBOX")
    }

    /// The uids whose file is still in `cur/`.
    fn on_disk(dir: &Path) -> Vec<u32> {
        let mut uids: Vec<u32> = std::fs::read_dir(cur(dir))
            .unwrap()
            .flatten()
            .filter_map(|e| mailvault_core::maildir::vault_filename_uid(&e.file_name().to_string_lossy()))
            .collect();
        uids.sort_unstable();
        uids
    }

    fn policy(mode: FetchMode, window_months: u32) -> FetchPolicy {
        FetchPolicy { mode, window_months, hoarder_premium: false }
    }

    fn now() -> i64 {
        crate::handlers::imap::now_ms()
    }

    #[tokio::test]
    async fn on_demand_evicts_the_cache_copies_the_server_still_has_and_never_the_archived_one() {
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::OnDemand, 3), now()).await;
        assert_eq!(out, Outcome { evicted: 2, kept: 0, skipped: None });
        assert_eq!(on_disk(&dir), vec![3], "the A copy stays");
    }

    /// The last-copy guard: uid 2 is gone from the server but the header
    /// cache has not been pruned yet. Its file may be the only copy left.
    #[tokio::test]
    async fn a_copy_the_fresh_server_listing_lacks_is_never_evicted() {
        let mock = MockImap::start(server(&[1, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::OnDemand, 3), now()).await;
        assert_eq!(out.evicted, 1);
        assert_eq!(on_disk(&dir), vec![2, 3]);
    }

    /// Search keeps an evicted message only while the header cache lists it
    /// (H2): a uid the header cache does not list stays on disk.
    #[tokio::test]
    async fn a_copy_the_header_cache_does_not_list_is_never_evicted() {
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 3]);
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::OnDemand, 3), now()).await;
        assert_eq!(out.evicted, 1);
        assert_eq!(on_disk(&dir), vec![2, 3]);
    }

    #[tokio::test]
    async fn a_failed_server_listing_evicts_nothing() {
        let mock = MockImap::start(
            server(&[1, 2, 3], 1).fault(Trigger::with("FETCH", "1:*"), Action::Respond("NO".into(), "not today".into())),
        );
        let (dir, s) = state(&[1, 2, 3]);
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::OnDemand, 3), now()).await;
        assert_eq!(out.evicted, 0);
        assert!(out.skipped.as_deref().is_some_and(|r| r.starts_with("server_listing_failed")), "{out:?}");
        assert_eq!(on_disk(&dir), vec![1, 2, 3]);
    }

    /// The server's uids belong to another generation than the header
    /// cache's: uid 1 on the server may be a different message now.
    #[tokio::test]
    async fn a_uidvalidity_the_header_cache_does_not_share_evicts_nothing() {
        let mock = MockImap::start(server(&[1, 2, 3], 7));
        let (dir, s) = state(&[1, 2, 3]);
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::OnDemand, 3), now()).await;
        assert_eq!(out.evicted, 0);
        assert!(out.skipped.as_deref().is_some_and(|r| r.starts_with("uidvalidity")), "{out:?}");
        assert_eq!(on_disk(&dir), vec![1, 2, 3]);
    }

    /// The header cache cannot be read (custody closed: startup, a vault
    /// switch): no proof, so nothing goes, even with the server listing in.
    #[tokio::test]
    async fn an_unreadable_header_cache_evicts_nothing() {
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        *mailvault_core::custody::lock(&s.custody.db) = None;
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::OnDemand, 3), now()).await;
        assert_eq!(out.evicted, 0);
        assert!(out.skipped.as_deref().is_some_and(|r| r.starts_with("header_cache_unreadable")), "{out:?}");
        assert_eq!(on_disk(&dir), vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn hoarder_and_keep_recent_window_zero_evict_nothing() {
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        for p in [policy(FetchMode::Hoarder, 3), policy(FetchMode::KeepRecent, 0)] {
            let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &p, now()).await;
            assert_eq!(out.evicted, 0, "{p:?}");
        }
        assert_eq!(on_disk(&dir), vec![1, 2, 3]);
    }

    /// The copies are dated 2015: Keep Recent evicts them by age.
    #[tokio::test]
    async fn keep_recent_evicts_copies_older_than_the_window() {
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        let out = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::KeepRecent, 3), now()).await;
        assert_eq!(out.evicted, 2);
        assert_eq!(on_disk(&dir), vec![3]);
    }

    /// Index Only evicts only the bodies the index holds; with body
    /// indexing off it evicts nothing.
    #[tokio::test]
    async fn index_only_evicts_only_what_the_index_holds_the_body_of() {
        use mailvault_core::search_index::{db, lock, reconcile::IndexConfig};
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        let si = &s.search_index;
        *lock(&si.db) = Some(db::open(&dir).unwrap());
        for (uid, body_state) in [(1, 1), (2, 0)] {
            lock(&si.db)
                .as_ref()
                .unwrap()
                .execute(
                    "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state) VALUES (?1, 'INBOX', ?2, ?3, 1, 1, 1, ?4)",
                    rusqlite::params![ACCT, uid, format!("{uid}{INFO_PREFIX}S.eml"), body_state],
                )
                .unwrap();
        }
        *si.enabled.lock().unwrap() = Some(true);
        *si.config.lock().unwrap() = Some(IndexConfig { bodies: false, attachments: false, image_text: false });
        let off = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::IndexOnly, 3), now()).await;
        assert_eq!(off.evicted, 0);
        assert!(off.skipped.as_deref().is_some_and(|r| r.starts_with("index_unavailable")), "{off:?}");
        assert_eq!(on_disk(&dir), vec![1, 2, 3]);

        *si.config.lock().unwrap() = Some(IndexConfig { bodies: true, attachments: false, image_text: false });
        let on = evict_mailbox(&s, &config(&mock), ACCT, "INBOX", &policy(FetchMode::IndexOnly, 3), now()).await;
        assert_eq!(on.evicted, 1);
        assert_eq!(on_disk(&dir), vec![2, 3], "uid 2's body is not indexed yet");
    }

    fn write_settings(dir: &Path, state: Value) {
        std::fs::write(dir.join("frontend-settings.json"), json!({"mailvault-settings": {"state": state}}).to_string()).unwrap();
    }

    fn write_credentials(dir: &Path, mock: &MockImap) {
        let account = json!({
            "id": ACCT, "email": "user@example.com", "password": "hunter2",
            "imapHost": mock.host(), "imapPort": mock.port(),
        })
        .to_string();
        let creds = dir.join("credentials.json");
        std::fs::write(&creds, json!({ ACCT: account }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
    }

    /// The whole pass: settings that cannot be read, or say nothing about
    /// the state, evict nothing (never the defaults, which evict); a hidden
    /// account evicts nothing; readable On Demand settings then do evict.
    #[tokio::test]
    async fn a_sweep_evicts_nothing_on_unreadable_settings_or_a_hidden_account() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mock = MockImap::start(server(&[1, 2, 3], 1));
        let (dir, s) = state(&[1, 2, 3]);
        write_credentials(&dir, &mock);

        sweep(&s).await;
        assert_eq!(on_disk(&dir), vec![1, 2, 3], "no settings file");
        std::fs::write(dir.join("frontend-settings.json"), "{\"mailvault-settings\": {\"sta").unwrap();
        sweep(&s).await;
        assert_eq!(on_disk(&dir), vec![1, 2, 3], "a settings file caught mid-write");
        std::fs::write(dir.join("frontend-settings.json"), "{}").unwrap();
        sweep(&s).await;
        assert_eq!(on_disk(&dir), vec![1, 2, 3], "no state object is not an empty (evicting) state");
        write_settings(&dir, json!({"fetchMode": "onDemand", "hiddenAccounts": {ACCT: true}}));
        sweep(&s).await;
        assert_eq!(on_disk(&dir), vec![1, 2, 3], "a hidden account");
        write_settings(&dir, json!({"fetchMode": "hoarder", "localCacheDurationMonths": 0}));
        sweep(&s).await;
        assert_eq!(on_disk(&dir), vec![1, 2, 3], "Hoarder");

        write_settings(&dir, json!({"fetchMode": "onDemand"}));
        sweep(&s).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        assert_eq!(on_disk(&dir), vec![3], "On Demand, readable: the cache copies go, the archived copy stays");
    }

    #[tokio::test]
    async fn fetch_mode_changed_wakes_the_worker() {
        let (_dir, s) = state(&[]);
        let resp = crate::server::handle_request_for_test(&s, "storage.fetch_mode_changed", json!({})).await;
        assert_eq!(resp.result, Some(json!({"ok": true})));
        tokio::time::timeout(Duration::from_secs(1), s.eviction_worker.notify.notified())
            .await
            .expect("the RPC leaves a wake permit for the worker");
    }
}
