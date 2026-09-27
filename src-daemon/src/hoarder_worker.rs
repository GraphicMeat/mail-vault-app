//! Hoarder worker (Track H, task H4, Premium): downloads every folder's full
//! history into the vault in the background, for accounts whose download mode
//! is Hoarder AND whose persisted `fetchModePremium` flag is true
//! (`FetchPolicy::runs_hoarder_worker`). Without Premium a Hoarder account
//! keeps today's free "keep all" (arrival + backfill, no cutoff); a lapse
//! only stops this worker, it never deletes anything.
//!
//! Level-triggered like `eviction_worker.rs`: every pass re-derives the gap
//! (server uids minus vault uids, per folder) from a fresh listing and the
//! vault; nothing is queued, so a crash or restart resumes by construction.
//! Woken after launch, by `storage.fetch_mode_changed`, by a sync that found
//! new mail (`handle_sync_now`) and every `PASS_EVERY`. IDLE arrivals are not
//! a wake: `cache_arrivals` already stores those bodies under Hoarder.
//!
//! Bodies go through `auto_cache(.., opened = false)`, the same write the
//! backfill uses: a cache copy, never `A`, never over an existing file. Only
//! the BACKGROUND lane (`run_read(config, false, ..)`), one message in flight,
//! one folder and one account at a time, so the per-account connection budget
//! (A6) is never pressed by this worker. The policy is re-read before every
//! folder and every batch: a mode change or a Premium lapse stops the account
//! after the batch in flight. Credentials are read quietly: a background pass
//! never raises the keychain prompt.

use crate::credentials;
use crate::handlers::common::{blocking, with_mailbox_write};
use crate::handlers::imap::{auto_cache, email_date_ms, fetch_policy, BODY_FETCH_TIMEOUT};
use crate::imap::{self, ImapConfig};
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::vault_files;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

// ponytail: fixed pacing, sized for Gmail, the strictest provider we know:
// 2500 MB/day of IMAP download per account across EVERY client (phone,
// webmail export, a second install, backup), and a suspension of up to 24h
// that locks the user out when it is crossed; 15 connections per account.
// Gmail labels are folders and `[Gmail]/All Mail` holds everything, so
// "every folder" downloads a message once per label plus once for All Mail.
// Hence: one message in flight (one background connection), BATCH messages,
// then BATCH_PAUSE; at most DAILY_BYTES per account per rolling day (40% of
// Gmail's cap, the rest left to the user's other clients). A 10 GB mailbox
// takes ~10 days. Per-provider budgets if non-Gmail users find that slow.
// Listings are not in the budget: a folder's `UID FETCH 1:*` is ~40 bytes a
// message (4 MB for a 100k All Mail), so a folder is re-listed only when its
// STATUS changed since it was last left with no gap, or a day after that.
const BATCH: usize = 25;
const BATCH_PAUSE: Duration = Duration::from_secs(5);
const DAILY_BYTES: u64 = 1000 * 1024 * 1024;
const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// A folder whose fetches keep failing (server refusing, socket dead, vault
/// write failing) stops for this pass; the next wake tries again.
const MAX_FAILURES_IN_A_ROW: usize = 3;
/// The first pass lets the launch sync and the user's first clicks go first.
const FIRST_PASS_DELAY: Duration = Duration::from_secs(2 * 60);
const PASS_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// After a pass that went to the server, the next one waits at least this
/// long whatever wakes it: every pass re-lists every folder, and new-mail
/// wakes can come every few minutes.
const MIN_GAP: Duration = Duration::from_secs(15 * 60);
/// A folder left complete is re-listed at least this often even when its
/// STATUS never moves: a cache copy cleared by hand comes back within a day.
const RELIST_EVERY: Duration = DAY;
/// Ceiling on one LIST, STATUS sweep or folder uid listing, connect and permit wait included.
const LISTING_TIMEOUT: Duration = Duration::from_secs(120);

/// Set by the e2e harness (`wdio.conf.js`) for its long-lived daemons: a
/// mock server's folders must not fill the vault mid-suite, and the extra
/// LIST / `UID FETCH` must not show up in specs that count commands.
const DISABLE_ENV: &str = "MAILVAULT_DISABLE_HOARDER";

/// Bytes downloaded for one account in the current rolling day.
/// ponytail: in memory, so a daemon restart resets it; persist it in app.db
/// if restarts ever show up as a Gmail suspension.
#[derive(Clone, Copy, Debug)]
struct DayBudget {
    since: Instant,
    used: u64,
}

impl DayBudget {
    fn new(now: Instant) -> Self {
        Self { since: now, used: 0 }
    }

    /// Bytes still allowed; a day after `since` the budget starts over.
    fn left(&mut self, now: Instant) -> u64 {
        if now.saturating_duration_since(self.since) >= DAY {
            *self = Self::new(now);
        }
        DAILY_BYTES.saturating_sub(self.used)
    }
}

/// A folder's STATUS: MESSAGES, UIDNEXT, UIDVALIDITY.
type FolderStatus = (u32, Option<u32>, Option<u32>);

#[derive(Clone)]
pub struct HoarderWorkerState {
    pub notify: Arc<tokio::sync::Notify>,
    budgets: Arc<Mutex<HashMap<String, DayBudget>>>,
    /// (account, folder) -> its STATUS when a pass last left it with no gap,
    /// and when. A memo of the level, not a queue: losing it (a restart)
    /// only costs one listing per folder.
    complete: Arc<Mutex<HashMap<(String, String), (FolderStatus, Instant)>>>,
}

impl Default for HoarderWorkerState {
    fn default() -> Self {
        Self { notify: Arc::new(tokio::sync::Notify::new()), budgets: Arc::default(), complete: Arc::default() }
    }
}

impl HoarderWorkerState {
    /// `storage.fetch_mode_changed`, or a sync that found new mail.
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    fn budget_left(&self, account_id: &str, now: Instant) -> u64 {
        let mut budgets = self.budgets.lock().unwrap_or_else(|e| e.into_inner());
        budgets.entry(account_id.to_string()).or_insert_with(|| DayBudget::new(now)).left(now)
    }

    fn spend(&self, account_id: &str, bytes: u64, now: Instant) {
        let mut budgets = self.budgets.lock().unwrap_or_else(|e| e.into_inner());
        let budget = budgets.entry(account_id.to_string()).or_insert_with(|| DayBudget::new(now));
        budget.used = budget.used.saturating_add(bytes);
    }

    /// Whether the folder was left with no gap under this very STATUS, less
    /// than `RELIST_EVERY` ago: nothing can have arrived since, so no listing.
    fn still_complete(&self, account_id: &str, mailbox: &str, status: FolderStatus, now: Instant) -> bool {
        let complete = self.complete.lock().unwrap_or_else(|e| e.into_inner());
        complete
            .get(&(account_id.to_string(), mailbox.to_string()))
            .is_some_and(|(was, at)| *was == status && now.saturating_duration_since(*at) < RELIST_EVERY)
    }

    fn mark_complete(&self, account_id: &str, mailbox: &str, status: FolderStatus, now: Instant) {
        let mut complete = self.complete.lock().unwrap_or_else(|e| e.into_inner());
        complete.insert((account_id.to_string(), mailbox.to_string()), (status, now));
    }
}

pub(crate) fn start(state: Arc<DaemonState>) {
    if std::env::var(DISABLE_ENV).as_deref() == Ok("1") {
        info!("[hoard] worker not started: {DISABLE_ENV}=1");
        return;
    }
    tokio::spawn(async move { run(state).await });
}

async fn run(state: Arc<DaemonState>) {
    info!("[hoard] worker started");
    let mut wait = FIRST_PASS_DELAY;
    loop {
        // `Notify` keeps one permit, so a wake during a pass runs one more.
        tokio::select! {
            _ = state.hoarder_worker.notify.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
        wait = PASS_EVERY;
        if !state.net.is_online() || credentials::GATE.is_blocked() {
            info!("[hoard] pass skipped: offline or keychain locked");
            continue;
        }
        if sweep(&state).await {
            tokio::time::sleep(MIN_GAP).await;
        }
    }
}

/// Whether `account_id` is to be hoarded right now, read fresh from the
/// settings file. Unreadable settings, a hidden account, another mode or no
/// Premium: no.
async fn hoarding(state: &Arc<DaemonState>, account_id: &str) -> bool {
    let (app_dir, acct) = (state.app_dir.clone(), account_id.to_string());
    matches!(blocking(move || fetch_policy(&app_dir, &acct)).await, Ok(Ok(Some(p))) if p.runs_hoarder_worker())
}

/// One pass over every account the header cache knows. `true`: at least one
/// account went to the server.
pub(crate) async fn sweep(state: &Arc<DaemonState>) -> bool {
    let st = Arc::clone(state);
    let rows = match blocking(move || crate::custody::with_conn(&st, |c| cache::mailboxes_with_headers(c, None))).await {
        Ok(Ok(rows)) => rows,
        Ok(Err(e)) | Err(e) => {
            warn!("[hoard] nothing fetched this pass: header cache unreadable: {e}");
            return false;
        }
    };
    let accounts: BTreeSet<String> = rows.into_iter().map(|(account_id, _)| account_id).collect();
    let mut worked = false;
    for account_id in accounts {
        if !hoarding(state, &account_id).await {
            continue;
        }
        let config = match credentials::resolve_account_credentials_quiet(&account_id).await {
            Ok(c) => c,
            Err(e) => {
                warn!("[hoard] {account_id}: nothing fetched, credentials unavailable: {e}");
                continue;
            }
        };
        // The daemon never refreshes a Graph token, so it cannot list a
        // Graph folder on its own.
        if config.oauth2_transport.as_deref() == Some("graph") {
            info!("[hoard] {account_id}: skipped_reason=graph_account");
            continue;
        }
        hoard_account(state, &config, &account_id).await;
        worked = true;
    }
    worked
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub fetched: usize,
    pub failed: usize,
    pub stopped: Option<String>,
}

/// Every selectable folder of one account, one at a time. Logs one `info!`
/// line with what it did and returns it.
pub(crate) async fn hoard_account(state: &Arc<DaemonState>, config: &ImapConfig, account_id: &str) -> Outcome {
    let mut out = Outcome::default();
    if let Err(reason) = hoard_account_inner(state, config, account_id, &mut out).await {
        out.stopped = Some(reason);
    }
    info!(
        "[hoard] {account_id}: fetched={} failed={} stopped={}",
        out.fetched,
        out.failed,
        out.stopped.as_deref().unwrap_or("none")
    );
    out
}

async fn hoard_account_inner(state: &Arc<DaemonState>, config: &ImapConfig, account_id: &str, out: &mut Outcome) -> Result<(), String> {
    if !hoarding(state, account_id).await {
        return Err("policy_off".into());
    }
    if state.hoarder_worker.budget_left(account_id, Instant::now()) == 0 {
        return Err("daily_budget_spent".into());
    }
    let list = state.imap_pool.run_read(config, false, |mut session| async move {
        let boxes = imap::list_mailboxes(&mut session).await?;
        Ok((boxes, session, None))
    });
    let folders: Vec<String> = match tokio::time::timeout(LISTING_TIMEOUT, list).await {
        Ok(Ok(boxes)) => boxes.into_iter().filter(|m| !m.noselect).map(|m| m.path).collect(),
        Ok(Err(e)) => return Err(format!("folder_list_failed: {e}")),
        Err(_) => return Err("folder_list_timed_out".into()),
    };
    // Two server folders filed under one vault folder: a vault uid would not
    // say which folder's message it is, so neither's gap can be trusted.
    let mut per_dir: HashMap<String, usize> = HashMap::new();
    for mailbox in &folders {
        *per_dir.entry(vault_dir_name(mailbox)).or_default() += 1;
    }
    // One STATUS per folder, to leave alone every folder nothing reached
    // since it was last complete. A failed sweep just lists every folder.
    let status = state.imap_pool.run_read(config, false, |mut session| {
        let folders = folders.clone();
        async move {
            let statuses = imap::mailbox_statuses(&mut session, &folders).await?;
            Ok((statuses, session, None))
        }
    });
    let statuses: HashMap<String, FolderStatus> = match tokio::time::timeout(LISTING_TIMEOUT, status).await {
        Ok(Ok(rows)) => rows.into_iter().map(|s| (s.path, (s.messages, s.uid_next, s.uid_validity))).collect(),
        Ok(Err(e)) => {
            warn!("[hoard] {account_id}: folder STATUS failed, listing every folder: {e}");
            HashMap::new()
        }
        Err(_) => HashMap::new(),
    };
    for mailbox in &folders {
        if per_dir[&vault_dir_name(mailbox)] > 1 {
            info!("[hoard] {account_id} {mailbox}: skipped_reason=shared_vault_folder");
            continue;
        }
        let status = statuses.get(mailbox).copied();
        if status.is_some_and(|s| state.hoarder_worker.still_complete(account_id, mailbox, s, Instant::now())) {
            continue;
        }
        if !hoarding(state, account_id).await {
            return Err("policy_changed".into());
        }
        if state.hoarder_worker.budget_left(account_id, Instant::now()) == 0 {
            return Err("daily_budget_spent".into());
        }
        if hoard_mailbox(state, config, account_id, mailbox, out).await? {
            if let Some(s) = status {
                state.hoarder_worker.mark_complete(account_id, mailbox, s, Instant::now());
            }
        }
    }
    Ok(())
}

/// One folder's gap, newest first, in batches. `Ok(true)`: the folder is
/// left with no gap. `Ok(false)`: a folder that could not be listed, read or
/// fully fetched ends here; the next wake recomputes its gap. `Err`: stop the
/// whole account (policy changed, daily budget spent, provider bandwidth limit).
async fn hoard_mailbox(state: &Arc<DaemonState>, config: &ImapConfig, account_id: &str, mailbox: &str, out: &mut Outcome) -> Result<bool, String> {
    let mb = mailbox.to_string();
    let listing = state.imap_pool.run_read(config, false, |mut session| {
        let mb = mb.clone();
        async move {
            let uids = imap::search_all_uids(&mut session, &mb, false).await?;
            Ok((uids, session, Some(mb)))
        }
    });
    let server = match tokio::time::timeout(LISTING_TIMEOUT, listing).await {
        Ok(Ok(uids)) => uids,
        Ok(Err(e)) if imap::is_bandwidth_limited(&e) => return Err(format!("bandwidth_limited: {e}")),
        Ok(Err(e)) => {
            warn!("[hoard] {account_id} {mailbox}: skipped_reason=listing_failed: {e}");
            return Ok(false);
        }
        Err(_) => {
            warn!("[hoard] {account_id} {mailbox}: skipped_reason=listing_timed_out");
            return Ok(false);
        }
    };

    // Any copy counts, cache or archived: never fetch what the vault holds.
    let (st, acct, mbx) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    let local: HashSet<u32> = match blocking(move || with_mailbox_write(&st, &acct, &mbx, |root| vault_files::list_on_disk(root, &acct, &mbx, None))).await {
        Ok(Ok(rows)) => rows.into_iter().map(|r| r.uid).collect(),
        Ok(Err(e)) | Err(e) => {
            warn!("[hoard] {account_id} {mailbox}: skipped_reason=vault_unreadable: {e}");
            return Ok(false);
        }
    };
    // Newest first: recent mail is what a search is likeliest to want.
    let gap: Vec<u32> = server.into_iter().rev().filter(|uid| !local.contains(uid)).collect();
    if gap.is_empty() {
        return Ok(true);
    }
    info!("[hoard] {account_id} {mailbox}: to_fetch={}", gap.len());

    let mut failures_in_a_row = 0usize;
    let mut failed_any = false;
    for (i, batch) in gap.chunks(BATCH).enumerate() {
        if i > 0 {
            tokio::time::sleep(BATCH_PAUSE).await;
        }
        if !hoarding(state, account_id).await {
            return Err("policy_changed".into());
        }
        for &uid in batch {
            if state.hoarder_worker.budget_left(account_id, Instant::now()) == 0 {
                return Err("daily_budget_spent".into());
            }
            let fetch = state.imap_pool.run_read(config, false, |mut session| {
                let mb = mailbox.to_string();
                async move {
                    let email = imap::fetch_email_by_uid_light(&mut session, &mb, uid).await?;
                    Ok((email, session, Some(mb)))
                }
            });
            let stored = match tokio::time::timeout(BODY_FETCH_TIMEOUT, fetch).await {
                Ok(Ok(Some(email))) if email.uid == uid => {
                    state.hoarder_worker.spend(account_id, email.raw_source_bytes.len() as u64, Instant::now());
                    let dated = email_date_ms(email.date.as_deref(), email.internal_date.as_deref());
                    auto_cache(state, account_id.to_string(), mailbox.to_string(), uid, email.raw_source_bytes, dated, false).await
                }
                // Expunged since the listing: nothing to keep.
                Ok(Ok(_)) => {
                    failures_in_a_row = 0;
                    continue;
                }
                Ok(Err(e)) if imap::is_bandwidth_limited(&e) => return Err(format!("bandwidth_limited: {e}")),
                Ok(Err(e)) => {
                    warn!("[hoard] {account_id} {mailbox}: uid {uid} not fetched: {e}");
                    false
                }
                Err(_) => {
                    warn!("[hoard] {account_id} {mailbox}: uid {uid} timed out");
                    false
                }
            };
            if stored {
                out.fetched += 1;
                failures_in_a_row = 0;
            } else {
                out.failed += 1;
                failed_any = true;
                failures_in_a_row += 1;
                if failures_in_a_row >= MAX_FAILURES_IN_A_ROW {
                    warn!("[hoard] {account_id} {mailbox}: skipped_reason={failures_in_a_row}_failures_in_a_row");
                    return Ok(false);
                }
            }
        }
    }
    Ok(!failed_any)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::maildir::{vault_filename_uid, INFO_PREFIX};
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

    fn folder(name: &str, uids: std::ops::RangeInclusive<u32>) -> Mailbox {
        let mut mb = Mailbox::new(name);
        for uid in uids {
            mb.add(Message::new(uid, raw(uid)));
        }
        mb
    }

    fn config(server: &MockImap) -> ImapConfig {
        serde_json::from_value(json!({
            "email": "user@example.com", "password": "hunter2",
            "imapHost": server.host(), "imapPort": server.port(),
        }))
        .unwrap()
    }

    fn write_settings(dir: &Path, state: Value) {
        std::fs::write(dir.join("frontend-settings.json"), json!({"mailvault-settings": {"state": state}}).to_string()).unwrap();
    }

    fn hoarder(dir: &Path, premium: bool) {
        write_settings(dir, json!({"fetchMode": "hoarder", "localCacheDurationMonths": 12, "fetchModePremium": premium}));
    }

    /// A daemon with custody open, the vault holding a cache copy of INBOX
    /// uid 1 and an archived copy of INBOX uid 2, a header cache that knows
    /// the account, and Hoarder + Premium settings.
    fn state() -> (PathBuf, Arc<DaemonState>) {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let dir = std::env::temp_dir().join(format!("mv-hoard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir.clone(), true);
        crate::custody::open_into(&s).unwrap();
        let cur = vault_files::cur_path(&dir, ACCT, "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        for (uid, flags) in [(1, "S"), (2, "AS")] {
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}{flags}.eml")), raw(uid)).unwrap();
        }
        let data = json!({"emails": [{"uid": 1, "messageId": "<m1@example.com>"}], "uidValidity": 1, "totalEmails": 1}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, ACCT, "INBOX", &data)).unwrap();
        hoarder(&dir, true);
        (dir, s)
    }

    /// uid -> the flag letters of its file name, for every file in `mailbox`'s `cur/`.
    fn on_disk(dir: &Path, mailbox: &str) -> HashMap<u32, String> {
        let cur = vault_files::cur_path(dir, ACCT, mailbox);
        let Ok(entries) = std::fs::read_dir(cur) else { return HashMap::new() };
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let uid = vault_filename_uid(&name)?;
                let flags = name.split(INFO_PREFIX).nth(1).unwrap_or("").trim_end_matches(".eml").to_string();
                Some((uid, flags))
            })
            .collect()
    }

    fn uids(dir: &Path, mailbox: &str) -> Vec<u32> {
        let mut uids: Vec<u32> = on_disk(dir, mailbox).into_keys().collect();
        uids.sort_unstable();
        uids
    }

    #[tokio::test]
    async fn hoards_every_folder_without_refetching_what_the_vault_holds_and_writes_no_archived_flag() {
        let mock = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=5)).mailbox(folder("Archive", 1..=5)));
        let (dir, s) = state();
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(out, Outcome { fetched: 8, failed: 0, stopped: None });
        assert_eq!(uids(&dir, "INBOX"), vec![1, 2, 3, 4, 5]);
        assert_eq!(uids(&dir, "Archive"), vec![1, 2, 3, 4, 5]);
        assert_eq!(mock.count_commands("BODY.PEEK[]"), 8, "the two INBOX copies already held are not fetched again");
        for mailbox in ["INBOX", "Archive"] {
            for (uid, flags) in on_disk(&dir, mailbox) {
                if !(mailbox == "INBOX" && uid == 2) {
                    assert!(!flags.contains('A'), "{mailbox} uid {uid} carries A: {flags:?}");
                }
            }
        }
        // A second pass: STATUS shows nothing arrived, so no folder is even
        // listed again, let alone fetched from.
        let listings = mock.count_commands("1:*");
        let again = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(again.fetched, 0);
        assert_eq!(mock.count_commands("BODY.PEEK[]"), 8);
        assert_eq!(mock.count_commands("1:*"), listings, "an unchanged complete folder is not re-listed");

        // New mail in Archive: only Archive is listed again, and its new uid fetched.
        mock.mutate(|st| {
            st.mailboxes.iter_mut().find(|m| m.name == "Archive").unwrap().add(Message::new(6, raw(6)));
        });
        let third = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(third.fetched, 1);
        assert_eq!(mock.count_commands("1:*"), listings + 1);
        assert_eq!(uids(&dir, "Archive"), vec![1, 2, 3, 4, 5, 6]);
    }

    #[tokio::test]
    async fn without_premium_nothing_is_fetched() {
        let mock = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=5)));
        let (dir, s) = state();
        hoarder(&dir, false);
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(out.fetched, 0);
        assert_eq!(mock.count_commands("BODY.PEEK[]"), 0);
        assert_eq!(uids(&dir, "INBOX"), vec![1, 2]);

        // Another mode, Premium or not: nothing either.
        write_settings(&dir, json!({"fetchMode": "keepRecent", "fetchModePremium": true}));
        assert_eq!(hoard_account(&s, &config(&mock), ACCT).await.fetched, 0);
        assert_eq!(mock.count_commands("BODY.PEEK[]"), 0);
    }

    /// Premium lapses while the first batch's first fetch is stalled on the
    /// server. The mode stays Hoarder, so `auto_cache` still writes what the
    /// batch fetches; the worker stops at the batch boundary. Nothing that
    /// was written is removed.
    #[tokio::test]
    async fn a_premium_lapse_mid_run_stops_after_the_current_batch() {
        let total = (BATCH * 2 + 5) as u32;
        let mock = MockImap::start(
            Scenario::new()
                .mailbox(folder("Archive", 1..=total))
                .fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 1), Action::Delay(Duration::from_secs(2))),
        );
        let (dir, s) = state();
        let run = tokio::spawn({
            let (s, config) = (Arc::clone(&s), config(&mock));
            async move { hoard_account(&s, &config, ACCT).await }
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        while mock.count_commands("BODY.PEEK[]") == 0 {
            assert!(Instant::now() < deadline, "the first body fetch never arrived");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        hoarder(&dir, false);
        let out = run.await.unwrap();
        assert_eq!(out.stopped.as_deref(), Some("policy_changed"), "{out:?}");
        assert_eq!(out.fetched, BATCH);
        assert_eq!(uids(&dir, "Archive").len(), BATCH);
        assert_eq!(mock.count_commands("BODY.PEEK[]"), BATCH);
    }

    #[tokio::test]
    async fn a_failed_uid_is_skipped_and_fetched_on_the_next_wake() {
        let mock = MockImap::start(
            Scenario::new()
                .mailbox(folder("Archive", 1..=5))
                .fault(Trigger::nth_with("FETCH", "3 (UID FLAGS ENVELOPE", 1), Action::Respond("NO".into(), "try later".into())),
        );
        let (dir, s) = state();
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(out, Outcome { fetched: 4, failed: 1, stopped: None });
        assert_eq!(uids(&dir, "Archive"), vec![1, 2, 4, 5], "the folder went on past the failed uid");

        let next = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(next, Outcome { fetched: 1, failed: 0, stopped: None });
        assert_eq!(uids(&dir, "Archive"), vec![1, 2, 3, 4, 5]);
    }

    /// The whole pass: the account comes from the header cache and its
    /// credentials from the quiet read; a hidden account is left alone.
    #[tokio::test]
    async fn a_sweep_hoards_a_premium_account_and_leaves_a_hidden_one() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mock = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=3)));
        let (dir, s) = state();
        let account = json!({
            "id": ACCT, "email": "user@example.com", "password": "hunter2",
            "imapHost": mock.host(), "imapPort": mock.port(),
        })
        .to_string();
        let creds = dir.join("credentials.json");
        std::fs::write(&creds, json!({ ACCT: account }).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);

        write_settings(&dir, json!({"fetchMode": "hoarder", "fetchModePremium": true, "hiddenAccounts": {ACCT: true}}));
        let hidden = sweep(&s).await;
        hoarder(&dir, true);
        let worked = sweep(&s).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert!(!hidden, "a hidden account is not hoarded");
        assert!(worked);
        assert_eq!(uids(&dir, "INBOX"), vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn fetch_mode_changed_wakes_the_hoarder_worker() {
        let (_dir, s) = state();
        let resp = crate::server::handle_request_for_test(&s, "storage.fetch_mode_changed", json!({})).await;
        assert_eq!(resp.result, Some(json!({"ok": true})));
        tokio::time::timeout(Duration::from_secs(1), s.hoarder_worker.notify.notified())
            .await
            .expect("the RPC leaves a wake permit for the hoarder worker");
    }

    #[test]
    fn the_daily_budget_runs_out_and_starts_over_a_day_later() {
        let t0 = Instant::now();
        let w = HoarderWorkerState::default();
        assert_eq!(w.budget_left(ACCT, t0), DAILY_BYTES);
        w.spend(ACCT, DAILY_BYTES - 10, t0);
        assert_eq!(w.budget_left(ACCT, t0 + Duration::from_secs(60)), 10);
        w.spend(ACCT, 50, t0);
        assert_eq!(w.budget_left(ACCT, t0 + Duration::from_secs(60)), 0);
        assert_eq!(w.budget_left("other", t0), DAILY_BYTES, "budgets are per account");
        assert_eq!(w.budget_left(ACCT, t0 + DAY), DAILY_BYTES);
    }

    #[test]
    fn a_complete_folder_counts_only_under_the_same_status_and_for_a_day() {
        let t0 = Instant::now();
        let w = HoarderWorkerState::default();
        let status = (5, Some(6), Some(1));
        assert!(!w.still_complete(ACCT, "INBOX", status, t0));
        w.mark_complete(ACCT, "INBOX", status, t0);
        assert!(w.still_complete(ACCT, "INBOX", status, t0 + Duration::from_secs(60)));
        assert!(!w.still_complete(ACCT, "INBOX", (6, Some(7), Some(1)), t0), "new mail");
        assert!(!w.still_complete(ACCT, "INBOX", (5, Some(6), Some(2)), t0), "a new UIDVALIDITY");
        assert!(!w.still_complete(ACCT, "Archive", status, t0), "per folder");
        assert!(!w.still_complete(ACCT, "INBOX", status, t0 + RELIST_EVERY), "re-listed a day later");
    }
}
