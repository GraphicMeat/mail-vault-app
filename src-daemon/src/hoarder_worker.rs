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
//! Woken after launch, by `storage.fetch_mode_changed`, by a sync that saw
//! real arrivals (`handle_sync_now`) and every `PASS_EVERY`. IDLE arrivals
//! are not a wake: `cache_arrivals` already stores those bodies under Hoarder.
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
use crate::handlers::imap::{auto_cache, email_date_ms, fetch_policy, now_ms, BODY_FETCH_TIMEOUT};
use crate::imap::{self, has_attr, ImapConfig, MailboxInfo};
use crate::server::DaemonState;
use futures::FutureExt;
use mailvault_core::custody::cache;
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::transfer_limits;
use mailvault_core::vault_files;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

// ponytail: fixed pacing, sized for Gmail, the strictest provider we know:
// 2500 MB/day of IMAP download per account across EVERY client (phone,
// webmail export, a second install, backup), and a suspension of up to 24h
// that locks the user out when it is crossed; 15 connections per account.
// Hence: one message in flight (one background connection), BATCH messages,
// then BATCH_PAUSE; at most DAILY_BYTES per account per wall-clock day (40%
// of Gmail's cap, the rest left to the user's other clients), persisted in
// `BUDGET_FILE` so a restart grants nothing, and spent in full the moment a
// provider says its bandwidth limit is hit. Listings count against it too
// (estimated, `LISTING_BYTES_PER_UID`). A 10 GB mailbox takes ~10 days;
// per-provider budgets if non-Gmail users find that slow.
// The user's own daily download limit (Settings > Data usage, "Pause
// background downloads at daily limit") replaces DAILY_BYTES while it is ON:
// the account's allowance for the day is then what is left of that limit
// (`transfer_limits::background_allowance_at`, every byte on the wire counted,
// Hoarder's own included), and a pass skips the account while it is 0. With
// the limit OFF nothing changes: DAILY_BYTES per account.
// Gmail labels are folders: when a folder carries `\All` (All Mail), the
// `\Flagged` (Starred) and `\Important` folders, strict subsets of it, are
// skipped, and All Mail goes last so INBOX and the user's labels come first.
// Other labels still download their messages a second time; a Message-ID
// dedup across folders is the upgrade.
const BATCH: usize = 25;
const BATCH_PAUSE: Duration = if cfg!(test) { Duration::from_millis(50) } else { Duration::from_secs(5) };
const DAILY_BYTES: u64 = 1000 * 1024 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// One `* n FETCH (UID n FLAGS (..))` line of a uid listing, roughly: 4 MB
/// for a 100k-message All Mail.
const LISTING_BYTES_PER_UID: u64 = 48;
/// `<app_dir>/hoarder-budget.json`: `{ account: { sinceMs, used } }`.
const BUDGET_FILE: &str = "hoarder-budget.json";
/// A folder whose fetches keep failing (server refusing, socket dead, vault
/// write failing) stops for this pass; the next wake tries again.
const MAX_FAILURES_IN_A_ROW: usize = 3;
/// The first pass lets the launch sync and the user's first clicks go first;
/// wakes before it are folded into it.
const FIRST_PASS_DELAY: Duration = Duration::from_secs(2 * 60);
const PASS_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// After a pass that went to the server, the next one waits at least this
/// long whatever wakes it: every pass sends a STATUS per folder, and arrival
/// wakes can come every few minutes.
const MIN_GAP: Duration = Duration::from_secs(15 * 60);
/// A folder left complete gets a full `1:*` listing at least this often;
/// in between only `UIDNEXT:*` of a folder whose UIDNEXT moved is listed.
/// A cache copy cleared by hand, or a uid a short range reply left out,
/// comes back within a day.
const RELIST_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Ceiling on one LIST, STATUS sweep or folder uid listing, connect and permit wait included.
const LISTING_TIMEOUT: Duration = Duration::from_secs(120);

/// Set by the e2e harness (`wdio.conf.js`) for its long-lived daemons: a
/// mock server's folders must not fill the vault mid-suite, and the extra
/// LIST / `UID FETCH` must not show up in specs that count commands.
const DISABLE_ENV: &str = "MAILVAULT_DISABLE_HOARDER";

/// Bytes downloaded for one account in the current day, which starts at the
/// first spend after the last one ended (wall clock, epoch ms).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayBudget {
    since_ms: i64,
    used: u64,
    /// The provider itself said its bandwidth limit is hit today (`exhaust`).
    /// Rests the account for the day even when the user's own limit would
    /// still leave room. Absent in files written before it existed.
    #[serde(default)]
    provider_stopped: bool,
}

impl DayBudget {
    /// Start a new day once a whole day has passed. A clock set back never
    /// starts one early.
    fn roll(&mut self, now_ms: i64) {
        if now_ms.saturating_sub(self.since_ms) >= DAY_MS {
            *self = Self { since_ms: now_ms, used: 0, provider_stopped: false };
        }
    }
}

fn load_budgets(app_dir: &Path) -> HashMap<String, DayBudget> {
    let path = app_dir.join(BUDGET_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            warn!("[hoard] {BUDGET_FILE} unreadable, starting it over: {e}");
            HashMap::new()
        }),
        Err(_) => HashMap::new(),
    }
}

fn save_budgets(app_dir: &Path, budgets: &HashMap<String, DayBudget>) {
    let written = serde_json::to_vec(budgets)
        .map_err(|e| e.to_string())
        .and_then(|bytes| mailvault_core::fsx::write_atomic(&app_dir.join(BUDGET_FILE), &bytes).map_err(|e| e.to_string()));
    if let Err(e) = written {
        warn!("[hoard] {BUDGET_FILE} not saved: {e}");
    }
}

/// A folder's STATUS as the memo compares it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FolderStatus {
    uid_validity: Option<u32>,
    uid_next: Option<u32>,
}

/// A folder a pass left with no gap: its STATUS then, and when it last had
/// a full `1:*` listing.
#[derive(Clone, Copy, Debug)]
struct Complete {
    status: FolderStatus,
    listed_at: Instant,
}

/// How much of a folder this pass lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Listing {
    /// Nothing can have arrived since it was left complete.
    Skip,
    /// Only uids from here up can be new (`UIDNEXT` when it was complete).
    From(u32),
    Full,
}

fn listing_for(done: Option<Complete>, status: Option<FolderStatus>, now: Instant) -> Listing {
    let (Some(done), Some(status)) = (done, status) else { return Listing::Full };
    if status.uid_validity.is_none()
        || status.uid_validity != done.status.uid_validity
        || now.saturating_duration_since(done.listed_at) >= RELIST_EVERY
    {
        return Listing::Full;
    }
    match (done.status.uid_next, status.uid_next) {
        (Some(was), Some(is)) if was == is => Listing::Skip,
        (Some(was), Some(_)) => Listing::From(was),
        _ => Listing::Full,
    }
}

#[derive(Clone)]
pub struct HoarderWorkerState {
    pub notify: Arc<tokio::sync::Notify>,
    /// Read from `BUDGET_FILE` on first use (`None` until then), written on
    /// every change.
    budgets: Arc<Mutex<Option<HashMap<String, DayBudget>>>>,
    /// (account, folder) -> `Complete`. A memo of the level, not a queue:
    /// losing it (a restart) only costs one full listing per folder.
    complete: Arc<Mutex<HashMap<(String, String), Complete>>>,
}

impl Default for HoarderWorkerState {
    fn default() -> Self {
        Self { notify: Arc::new(tokio::sync::Notify::new()), budgets: Arc::default(), complete: Arc::default() }
    }
}

impl HoarderWorkerState {
    /// `storage.fetch_mode_changed`, or a sync that saw arrivals.
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// `f` over the account's budget for today, persisted when it changed.
    /// ponytail: blocking file I/O under a std mutex, fine for a few hundred
    /// bytes written once per message; `blocking` if it ever shows in a trace.
    fn with_budget<T>(&self, app_dir: &Path, account_id: &str, now_ms: i64, f: impl FnOnce(&mut DayBudget) -> T) -> T {
        let mut guard = self.budgets.lock().unwrap_or_else(|e| e.into_inner());
        let budgets = guard.get_or_insert_with(|| load_budgets(app_dir));
        let budget = budgets.entry(account_id.to_string()).or_default();
        let before = *budget;
        budget.roll(now_ms);
        let out = f(budget);
        if *budget != before {
            save_budgets(app_dir, budgets);
        }
        out
    }

    fn budget_left(&self, app_dir: &Path, account_id: &str, now_ms: i64) -> u64 {
        self.with_budget(app_dir, account_id, now_ms, |b| DAILY_BYTES.saturating_sub(b.used))
    }

    fn spend(&self, app_dir: &Path, account_id: &str, bytes: u64, now_ms: i64) {
        self.with_budget(app_dir, account_id, now_ms, |b| b.used = b.used.saturating_add(bytes));
    }

    /// The provider said its bandwidth limit is hit: rest until the day rolls over.
    fn exhaust(&self, app_dir: &Path, account_id: &str, now_ms: i64) {
        self.with_budget(app_dir, account_id, now_ms, |b| {
            b.used = b.used.max(DAILY_BYTES);
            b.provider_stopped = true;
        });
    }

    /// The provider stopped this account today (see `exhaust`).
    fn provider_stopped(&self, app_dir: &Path, account_id: &str, now_ms: i64) -> bool {
        self.with_budget(app_dir, account_id, now_ms, |b| b.provider_stopped)
    }

    fn complete(&self, account_id: &str, mailbox: &str) -> Option<Complete> {
        let complete = self.complete.lock().unwrap_or_else(|e| e.into_inner());
        complete.get(&(account_id.to_string(), mailbox.to_string())).copied()
    }

    fn mark_complete(&self, account_id: &str, mailbox: &str, done: Complete) {
        let mut complete = self.complete.lock().unwrap_or_else(|e| e.into_inner());
        complete.insert((account_id.to_string(), mailbox.to_string()), done);
    }
}

/// What one account may still download today, and whether the user's own daily
/// limit (rather than Hoarder's built-in `DAILY_BYTES`) is what says so.
///
/// Limit ON: what is left of it (0 once spent). Limit OFF: `DAILY_BYTES` less
/// what Hoarder has spent. Either way a provider-side bandwidth stop rests the
/// account for the day. `host` is the IMAP host, which decides Gmail's default
/// limit; before the credentials are read it is `""`, and only a limit the
/// user typed applies. Reads the settings and stats files, so it runs on a
/// blocking thread.
async fn allowance_left(state: &Arc<DaemonState>, account_id: &str, host: &str) -> (u64, bool) {
    let (st, acct, host) = (Arc::clone(state), account_id.to_string(), host.to_string());
    blocking(move || {
        if st.hoarder_worker.provider_stopped(&st.app_dir, &acct, now_ms()) {
            return (0, false);
        }
        match transfer_limits::background_allowance_at(&st.app_dir, &acct, &host, st.clock.now_ms()) {
            Some(left) => (left, true),
            None => (st.hoarder_worker.budget_left(&st.app_dir, &acct, now_ms()), false),
        }
    })
    .await
    // A blocking thread that never answered is not a licence to download.
    .unwrap_or((0, false))
}

/// Why a pass stopped an account for the day: `by_limit` is the user's limit.
fn spent_reason(by_limit: bool) -> &'static str {
    if by_limit { "daily_limit_reached" } else { "daily_budget_spent" }
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
    tokio::time::sleep(FIRST_PASS_DELAY).await;
    loop {
        // A wake that came before this pass is covered by it; one that comes
        // during it leaves `Notify`'s permit and runs one more.
        let _ = state.hoarder_worker.notify.notified().now_or_never();
        if !state.net.is_online() || credentials::GATE.is_blocked() {
            info!("[hoard] pass skipped: offline or keychain locked");
        } else if sweep(&state).await {
            tokio::time::sleep(MIN_GAP).await;
        }
        tokio::select! {
            _ = state.hoarder_worker.notify.notified() => {}
            _ = tokio::time::sleep(PASS_EVERY) => {}
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
        // Before the credentials are read (so a spent day never touches the
        // keychain), on what is known without the host: the rested-for-the-day
        // mark, Hoarder's own budget, a limit the user typed. Gmail's default
        // limit needs the host and is checked inside `hoard_account`.
        let (left, by_limit) = allowance_left(state, &account_id, "").await;
        if left == 0 {
            info!("[hoard] {account_id}: skipped_reason={}", spent_reason(by_limit));
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

/// The folders to hoard, in order: every selectable one, except that with
/// an `\All` folder present the `\Flagged` / `\Important` ones (strict
/// subsets of it) are left out, and `\All` itself goes last. The vault-gap
/// count leaves out the same folders (`vault_gap::listed_folders`).
pub(crate) fn folders_to_hoard(boxes: Vec<MailboxInfo>) -> Vec<String> {
    let has_all = boxes.iter().any(|m| !m.noselect && has_attr(&m.flags, "All"));
    let mut keep: Vec<MailboxInfo> = boxes
        .into_iter()
        .filter(|m| !m.noselect)
        .filter(|m| has_attr(&m.flags, "All") || !(has_all && (has_attr(&m.flags, "Flagged") || has_attr(&m.flags, "Important"))))
        .collect();
    keep.sort_by_key(|m| has_attr(&m.flags, "All"));
    keep.into_iter().map(|m| m.path).collect()
}

/// The words `imap::sign_in_error` and the missing-secret checks before it
/// use. The daemon never refreshes a token or asks for a password, so every
/// later folder would fail the same way. The mbox upload job reads a refused
/// sign-in the same way (`mbox_upload::kind_of`).
pub(crate) fn is_sign_in_failure(e: &str) -> bool {
    ["Login failed for", "XOAUTH2 auth failed for", "OAuth2 access token missing", "Password missing"]
        .iter()
        .any(|needle| e.contains(needle))
}

/// `Some(reason)` for an error that ends the whole account's pass, not just
/// one folder or message. A bandwidth limit also spends the day's budget.
fn account_stop(state: &Arc<DaemonState>, account_id: &str, e: &str) -> Option<String> {
    if imap::is_bandwidth_limited(e) {
        state.hoarder_worker.exhaust(&state.app_dir, account_id, now_ms());
        return Some(format!("bandwidth_limited: {e}"));
    }
    is_sign_in_failure(e).then(|| format!("sign_in_failed: {e}"))
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
    let (left, by_limit) = allowance_left(state, account_id, &config.host).await;
    if left == 0 {
        return Err(spent_reason(by_limit).into());
    }
    let list = state.imap_pool.run_read(config, false, |mut session| async move {
        let boxes = imap::list_mailboxes(&mut session).await?;
        Ok((boxes, session, None))
    });
    let folders = match tokio::time::timeout(LISTING_TIMEOUT, list).await {
        Ok(Ok(boxes)) => folders_to_hoard(boxes),
        Ok(Err(e)) => return Err(account_stop(state, account_id, &e).unwrap_or_else(|| format!("folder_list_failed: {e}"))),
        Err(_) => return Err("folder_list_timed_out".into()),
    };
    // Two server folders filed under one vault folder: a vault uid would not
    // say which folder's message it is, so neither's gap can be trusted.
    let mut per_dir: HashMap<String, usize> = HashMap::new();
    for mailbox in &folders {
        *per_dir.entry(vault_dir_name(mailbox)).or_default() += 1;
    }
    // One STATUS per folder decides how much of it to list. A failed sweep
    // just lists every folder in full.
    let status = state.imap_pool.run_read(config, false, |mut session| {
        let folders = folders.clone();
        async move {
            let statuses = imap::mailbox_statuses(&mut session, &folders).await?;
            Ok((statuses, session, None))
        }
    });
    let statuses: HashMap<String, FolderStatus> = match tokio::time::timeout(LISTING_TIMEOUT, status).await {
        Ok(Ok(rows)) => rows.into_iter().map(|s| (s.path, FolderStatus { uid_validity: s.uid_validity, uid_next: s.uid_next })).collect(),
        Ok(Err(e)) => {
            if let Some(reason) = account_stop(state, account_id, &e) {
                return Err(reason);
            }
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
        let done = state.hoarder_worker.complete(account_id, mailbox);
        let now = Instant::now();
        let listing = listing_for(done, status, now);
        if listing == Listing::Skip {
            continue;
        }
        if !hoarding(state, account_id).await {
            return Err("policy_changed".into());
        }
        let (left, by_limit) = allowance_left(state, account_id, &config.host).await;
        if left == 0 {
            return Err(spent_reason(by_limit).into());
        }
        if hoard_mailbox(state, config, account_id, mailbox, listing, status, out).await? {
            if let Some(status) = status {
                // A range listing keeps the last FULL listing's time.
                let listed_at = match (listing, done) {
                    (Listing::From(_), Some(done)) => done.listed_at,
                    _ => now,
                };
                state.hoarder_worker.mark_complete(account_id, mailbox, Complete { status, listed_at });
            }
        }
    }
    Ok(())
}

/// One folder's gap, newest first, in batches. `Ok(true)`: the folder is
/// left with no gap. `Ok(false)`: a folder that could not be listed, read or
/// fully fetched ends here; the next wake recomputes its gap. `Err`: stop the
/// whole account (policy changed, daily budget spent, provider bandwidth
/// limit, sign-in refused).
async fn hoard_mailbox(
    state: &Arc<DaemonState>,
    config: &ImapConfig,
    account_id: &str,
    mailbox: &str,
    listing: Listing,
    status: Option<FolderStatus>,
    out: &mut Outcome,
) -> Result<bool, String> {
    let from = match listing {
        Listing::From(n) => Some(n),
        _ => None,
    };
    let mb = mailbox.to_string();
    let listed = state.imap_pool.run_read(config, false, |mut session| {
        let mb = mb.clone();
        async move {
            let listed = match from {
                Some(n) => imap::uid_flags_from_in_generation(&mut session, &mb, n).await?,
                None => imap::search_all_uid_flags_in_generation(&mut session, &mb).await?,
            };
            Ok((listed, session, Some(mb)))
        }
    });
    let (validity, server) = match tokio::time::timeout(LISTING_TIMEOUT, listed).await {
        Ok(Ok(listed)) => listed,
        Ok(Err(e)) => {
            if let Some(reason) = account_stop(state, account_id, &e) {
                return Err(reason);
            }
            warn!("[hoard] {account_id} {mailbox}: skipped_reason=listing_failed: {e}");
            return Ok(false);
        }
        Err(_) => {
            warn!("[hoard] {account_id} {mailbox}: skipped_reason=listing_timed_out");
            return Ok(false);
        }
    };
    state.hoarder_worker.spend(&state.app_dir, account_id, server.len() as u64 * LISTING_BYTES_PER_UID, now_ms());
    // The generation changed between the STATUS and the listing: the memo
    // would record the wrong one. The next pass lists it in full.
    if let Some(status) = status {
        if validity != status.uid_validity {
            info!("[hoard] {account_id} {mailbox}: skipped_reason=uidvalidity status={:?} listing={validity:?}", status.uid_validity);
            return Ok(false);
        }
    }

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
    let gap: Vec<u32> = server.into_iter().rev().map(|(uid, _)| uid).filter(|uid| !local.contains(uid)).collect();
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
            let (left, by_limit) = allowance_left(state, account_id, &config.host).await;
            if left == 0 {
                return Err(spent_reason(by_limit).into());
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
                    state.hoarder_worker.spend(&state.app_dir, account_id, email.raw_source_bytes.len() as u64, now_ms());
                    let dated = email_date_ms(email.date.as_deref(), email.internal_date.as_deref());
                    auto_cache(state, account_id.to_string(), mailbox.to_string(), uid, email.raw_source_bytes, dated, false).await
                }
                // Expunged since the listing: nothing to keep.
                Ok(Ok(_)) => {
                    failures_in_a_row = 0;
                    continue;
                }
                Ok(Err(e)) => {
                    if let Some(reason) = account_stop(state, account_id, &e) {
                        return Err(reason);
                    }
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
        let full = mock.count_commands("1:*");
        let again = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(again.fetched, 0);
        assert_eq!(mock.count_commands("BODY.PEEK[]"), 8);
        assert_eq!(mock.count_commands(":*"), full, "an unchanged complete folder is not listed");

        // One arrival in Archive: only Archive is listed, only from its old
        // UIDNEXT up, and the new uid is fetched.
        mock.mutate(|st| {
            st.mailboxes.iter_mut().find(|m| m.name == "Archive").unwrap().add(Message::new(6, raw(6)));
        });
        let third = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(third.fetched, 1);
        assert_eq!(mock.count_commands("6:*"), 1, "a range listing");
        assert_eq!(mock.count_commands("1:*"), full, "no full listing");
        assert_eq!(uids(&dir, "Archive"), vec![1, 2, 3, 4, 5, 6]);

        // A new UIDVALIDITY: the old UIDNEXT means nothing, so a full listing.
        mock.mutate(|st| st.mailboxes.iter_mut().find(|m| m.name == "Archive").unwrap().uid_validity = 2);
        let fourth = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(fourth.stopped, None);
        assert_eq!(mock.count_commands("1:*"), full + 1);
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
                // The mock trims a command's arguments, so the needle cannot be
                // anchored with a leading space; the folder holds uids 1..=5
                // only, so no other uid's FETCH ends in "3 (UID FLAGS ENVELOPE".
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

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-hoard-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_daily_budget_runs_out_and_starts_over_a_day_later() {
        let dir = temp_dir();
        let t0: i64 = 1_800_000_000_000;
        let w = HoarderWorkerState::default();
        assert_eq!(w.budget_left(&dir, ACCT, t0), DAILY_BYTES);
        w.spend(&dir, ACCT, DAILY_BYTES - 10, t0);
        assert_eq!(w.budget_left(&dir, ACCT, t0 + 60_000), 10);
        w.spend(&dir, ACCT, 50, t0 + 60_000);
        assert_eq!(w.budget_left(&dir, ACCT, t0 + 60_000), 0);
        assert_eq!(w.budget_left(&dir, "other", t0), DAILY_BYTES, "budgets are per account");
        assert_eq!(w.budget_left(&dir, ACCT, t0 - DAY_MS), 0, "a clock set back starts no new day");
        assert_eq!(w.budget_left(&dir, ACCT, t0 + DAY_MS), DAILY_BYTES);
    }

    /// A restart (a fresh worker state over the same app dir) grants nothing.
    #[test]
    fn the_daily_budget_survives_a_restart_and_a_bandwidth_limit_spends_it() {
        let dir = temp_dir();
        let t0: i64 = 1_800_000_000_000;
        let before = HoarderWorkerState::default();
        before.spend(&dir, ACCT, 700, t0);
        let after = HoarderWorkerState::default();
        assert_eq!(after.budget_left(&dir, ACCT, t0 + 1), DAILY_BYTES - 700);

        after.exhaust(&dir, ACCT, t0 + 2);
        let again = HoarderWorkerState::default();
        assert_eq!(again.budget_left(&dir, ACCT, t0 + 3), 0);
        assert_eq!(again.budget_left(&dir, ACCT, t0 + DAY_MS), DAILY_BYTES, "rests until the day rolls over");
    }

    #[test]
    fn a_folder_is_listed_in_full_by_range_or_not_at_all() {
        let t0 = Instant::now();
        let st = |validity: u32, next: u32| Some(FolderStatus { uid_validity: Some(validity), uid_next: Some(next) });
        let done = Complete { status: st(1, 6).unwrap(), listed_at: t0 };
        assert_eq!(listing_for(None, st(1, 6), t0), Listing::Full, "never complete");
        assert_eq!(listing_for(Some(done), None, t0), Listing::Full, "no STATUS");
        assert_eq!(listing_for(Some(done), st(1, 6), t0), Listing::Skip);
        assert_eq!(listing_for(Some(done), st(1, 9), t0), Listing::From(6), "arrivals: from the old UIDNEXT");
        assert_eq!(listing_for(Some(done), st(2, 6), t0), Listing::Full, "a new UIDVALIDITY");
        assert_eq!(listing_for(Some(done), st(1, 6), t0 + RELIST_EVERY), Listing::Full, "a day later");
    }

    #[tokio::test]
    async fn a_bandwidth_limit_rests_the_account_without_another_server_command() {
        let mock = MockImap::start(
            Scenario::new()
                .mailbox(folder("Archive", 1..=5))
                .fault(Trigger::on("SELECT"), Action::Respond("NO".into(), "[OVERQUOTA] Account exceeded bandwidth limits. (Failure)".into())),
        );
        let (dir, s) = state();
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert!(out.stopped.as_deref().is_some_and(|r| r.starts_with("bandwidth_limited")), "{out:?}");
        let sent = mock.commands().len();

        let next = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(next.stopped.as_deref(), Some("daily_budget_spent"));
        assert_eq!(mock.commands().len(), sent, "no server contact until the day rolls over");
        assert!(!sweep(&s).await, "a sweep leaves it alone too");
        assert_eq!(uids(&dir, "Archive"), Vec::<u32>::new());
    }

    /// The first folder's SELECT finds the socket dead; the pool's retry
    /// signs in again and is refused. The pass ends there: the next folder
    /// is never tried (it would sign in a third time).
    #[tokio::test]
    async fn a_refused_sign_in_ends_the_account_pass() {
        let mock = MockImap::start(
            Scenario::new()
                .mailbox(folder("Archive", 1..=5))
                .fault(Trigger::nth("SELECT", 1), Action::DropConnection)
                .fault(Trigger::nth("LOGIN", 2), Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())),
        );
        let (dir, s) = state();
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert!(out.stopped.as_deref().is_some_and(|r| r.starts_with("sign_in_failed")), "{out:?}");
        assert_eq!(mock.count_commands("LOGIN"), 2);
        assert_eq!(mock.count_commands("SELECT"), 1, "Archive was never tried");
        assert_eq!(uids(&dir, "Archive"), Vec::<u32>::new());
    }

    /// STATUS says one generation, the listing's SELECT another: the folder
    /// is skipped (nothing fetched, nothing marked complete).
    #[tokio::test]
    async fn a_listing_under_another_uidvalidity_than_the_status_skips_the_folder() {
        let mock = MockImap::start(
            Scenario::new().mailbox(folder("Archive", 1..=5)).fault(
                Trigger::with("STATUS", "ARCHIVE"),
                Action::RespondRaw("* STATUS \"Archive\" (MESSAGES 5 UIDNEXT 6 UIDVALIDITY 99)\r\n{tag} OK STATUS completed\r\n".into()),
            ),
        );
        let (dir, s) = state();
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(out, Outcome { fetched: 0, failed: 0, stopped: None });
        assert_eq!(mock.count_commands("BODY.PEEK[]"), 0);
        assert_eq!(uids(&dir, "Archive"), Vec::<u32>::new());
    }

    /// Gmail: Starred (`\Flagged`) and Important are subsets of All Mail
    /// (`\All`) and are skipped; All Mail is hoarded, last.
    #[tokio::test]
    async fn gmail_subset_folders_are_skipped_and_all_mail_goes_last() {
        let mut all = folder("[Gmail]/All Mail", 1..=3);
        all.attrs = vec!["\\HasNoChildren".into(), "\\All".into()];
        let mut starred = folder("[Gmail]/Starred", 1..=2);
        starred.attrs = vec!["\\HasNoChildren".into(), "\\Flagged".into()];
        let mut important = folder("[Gmail]/Important", 1..=2);
        important.attrs = vec!["\\HasNoChildren".into(), "\\Important".into()];
        let mock = MockImap::start(Scenario::new().mailbox(all).mailbox(starred).mailbox(important).mailbox(folder("Work", 1..=2)));
        let (dir, s) = state();
        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(out, Outcome { fetched: 5, failed: 0, stopped: None });
        assert_eq!(uids(&dir, "[Gmail]/All Mail"), vec![1, 2, 3]);
        assert_eq!(uids(&dir, "Work"), vec![1, 2]);
        assert_eq!(mock.count_commands("Starred"), 0);
        assert_eq!(mock.count_commands("Important"), 0);
        let selects: Vec<String> = mock.commands().into_iter().filter(|c| c.to_uppercase().contains(" SELECT ")).collect();
        assert!(selects.last().is_some_and(|c| c.contains("All Mail")), "{selects:?}");
    }

    // ── The user's daily download limit ─────────────────────────────────────

    const MIB: u64 = 1024 * 1024;

    /// Hoarder settings (Premium) with the account's `transferLimits` entry.
    fn hoarder_with_limit(dir: &Path, cap_enabled: bool, limit_bytes: Option<u64>) {
        let mut entry = json!({"capEnabled": cap_enabled});
        if let Some(bytes) = limit_bytes {
            entry["dailyDownLimitBytes"] = json!(bytes);
        }
        write_settings(
            dir,
            json!({"fetchMode": "hoarder", "localCacheDurationMonths": 12, "fetchModePremium": true, "transferLimits": {ACCT: entry}}),
        );
    }

    fn spend_today(dir: &Path, bytes: u64) {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        mailvault_core::app_db::with(dir, |c| mailvault_core::app_db::stats::add(c, ACCT, &today, "daemon", bytes, 0)).unwrap();
    }

    /// Limit ON: the day's allowance is what is left of the user's limit, not
    /// Hoarder's own 1,000 MiB. Limit OFF: the built-in budget, as before.
    #[tokio::test]
    async fn the_allowance_follows_the_users_limit_while_it_is_on_and_the_built_in_budget_while_it_is_off() {
        let (dir, s) = state();

        hoarder_with_limit(&dir, false, Some(5 * MIB));
        assert_eq!(allowance_left(&s, ACCT, "imap.example.com").await, (DAILY_BYTES, false), "cap off: 1,000 MiB");

        hoarder_with_limit(&dir, true, Some(5 * MIB));
        spend_today(&dir, 3 * MIB);
        assert_eq!(allowance_left(&s, ACCT, "imap.example.com").await, (2 * MIB, true), "cap on: 5 MiB less the 3 MiB spent");

        // A limit above the built-in budget lifts it (2 x DAILY_BYTES here).
        hoarder_with_limit(&dir, true, Some(2 * DAILY_BYTES + 3 * MIB));
        assert_eq!(allowance_left(&s, ACCT, "imap.example.com").await, (2 * DAILY_BYTES, true));

        // Cap on, field empty: Gmail's default (2,000 MB), nothing off Gmail.
        hoarder_with_limit(&dir, true, None);
        assert_eq!(allowance_left(&s, ACCT, "imap.gmail.com").await, (2000 * MIB - 3 * MIB, true));
        assert_eq!(allowance_left(&s, ACCT, "imap.example.com").await, (DAILY_BYTES, false), "no limit applies: the built-in budget");

        // The provider's own bandwidth stop rests the account whatever the cap says.
        s.hoarder_worker.exhaust(&dir, ACCT, now_ms());
        assert_eq!(allowance_left(&s, ACCT, "imap.gmail.com").await, (0, false));
    }

    /// The pass skips the account while the allowance is 0, without a single
    /// server command, and carries on once the clock is past UTC midnight.
    #[tokio::test]
    async fn a_pass_skips_an_account_whose_limit_is_spent_and_resumes_after_midnight() {
        let mock = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=5)));
        let (dir, s) = state();
        hoarder_with_limit(&dir, true, Some(MIB));
        spend_today(&dir, MIB);

        let out = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(out.stopped.as_deref(), Some("daily_limit_reached"), "{out:?}");
        assert_eq!(out.fetched, 0);
        assert_eq!(mock.commands().len(), 0, "a spent day sends the server nothing");
        assert!(!sweep(&s).await, "and a sweep leaves the account alone");

        s.clock.advance(24 * 60 * 60 * 1000);
        let next = hoard_account(&s, &config(&mock), ACCT).await;
        assert_eq!(next, Outcome { fetched: 3, failed: 0, stopped: None }, "the new UTC day starts with the whole limit");
        assert_eq!(uids(&dir, "INBOX"), vec![1, 2, 3, 4, 5]);
    }

    /// The bytes Hoarder itself downloads count against the limit: a folder
    /// bigger than what is left stops part way, for the limit's reason.
    #[tokio::test]
    async fn a_limit_that_runs_out_mid_folder_ends_the_pass_for_the_day() {
        let email = format!("hoard-limit-{}@example.com", uuid::Uuid::new_v4().simple());
        let mock = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=60)));
        let (dir, s) = state();
        // Wire bytes are counted per email and filed under the account id the
        // app's accounts.json gives that email; this email is this test's own.
        std::fs::write(dir.join("accounts.json"), json!([{"id": ACCT, "email": email}]).to_string()).unwrap();
        hoarder_with_limit(&dir, true, Some(12_000));
        let config: ImapConfig = serde_json::from_value(json!({
            "email": email, "password": "hunter2", "imapHost": mock.host(), "imapPort": mock.port(),
        }))
        .unwrap();

        let out = hoard_account(&s, &config, ACCT).await;

        assert_eq!(out.stopped.as_deref(), Some("daily_limit_reached"), "{out:?}");
        assert!(out.fetched >= 1 && out.fetched < 58, "some of the folder came down before the limit: {out:?}");
        assert_eq!(uids(&dir, "INBOX").len(), 2 + out.fetched, "what was fetched is kept (two copies were already there)");
    }
}
