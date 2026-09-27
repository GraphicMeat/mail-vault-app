//! Fetch policy + eviction selection (Track H, task H1).
//!
//! Pure decision logic for "download modes": how much mail a mode keeps on
//! disk, and which cached copies a mode is allowed to delete. No I/O here —
//! the daemon eviction worker (H3) reads a mailbox's cache files and the
//! search index, builds a `FetchPolicy`, and calls into this module to
//! decide what to touch.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchMode {
    OnDemand,
    KeepRecent,
    IndexOnly,
    Hoarder,
}

/// Default mode/window when settings carry neither a `fetchMode` string a
/// caller recognizes nor a legacy signal to fall back on.
const DEFAULT_MODE: FetchMode = FetchMode::KeepRecent;
const DEFAULT_WINDOW_MONTHS: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchPolicy {
    pub mode: FetchMode,
    /// 0 = no cutoff (never evict on age). A value large enough to overflow
    /// the calendar (see `cutoff_ms`) is likewise treated as no cutoff,
    /// never as an error.
    pub window_months: u32,
    /// Mirrors the frontend's persisted `fetchModePremium` (kept in sync
    /// with `hasPremiumAccess(billingProfile)`). The daemon has no
    /// entitlement check of its own; it trusts this flag.
    pub hoarder_premium: bool,
}

impl FetchPolicy {
    /// Builds a policy for one account from the *`mailvault-settings.state`*
    /// object — i.e. `parsed_frontend_settings["mailvault-settings"]["state"]`,
    /// not the full `frontend-settings.json` root (see `local_copy_months` in
    /// `src-daemon/src/handlers/imap.rs` for the shape this is read from).
    ///
    /// Resolution order: a hidden account short-circuits to `None` (no
    /// download at all, matching today's behavior). Otherwise the mode comes
    /// from `state.fetchModes[account_id]` (per-account override) if it
    /// parses as a `FetchMode`, else `state.fetchMode` if that parses, else a
    /// legacy fallback: `localCacheDurationMonths == 0` means `Hoarder`,
    /// anything else means `KeepRecent`. `window_months` is
    /// `localCacheDurationMonths` verbatim when it fits in a `u32`
    /// (`u32::try_from`), else the default of 3 — a value that doesn't fit
    /// falls back to the default rather than silently wrapping. Any other
    /// malformed value (wrong type, unrecognized string) is treated the same
    /// as "missing".
    pub fn from_settings(state: &serde_json::Value, account_id: &str) -> Option<FetchPolicy> {
        let hidden = state
            .get("hiddenAccounts")
            .and_then(|h| h.get(account_id))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if hidden {
            return None;
        }

        let window_months = state
            .get("localCacheDurationMonths")
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok());

        let mode = state
            .get("fetchModes")
            .and_then(|m| m.get(account_id))
            .and_then(|v| serde_json::from_value::<FetchMode>(v.clone()).ok())
            .or_else(|| {
                state
                    .get("fetchMode")
                    .and_then(|v| serde_json::from_value::<FetchMode>(v.clone()).ok())
            })
            .unwrap_or_else(|| match window_months {
                Some(0) => FetchMode::Hoarder,
                _ => DEFAULT_MODE,
            });

        let hoarder_premium = state
            .get("fetchModePremium")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        Some(FetchPolicy {
            mode,
            window_months: window_months.unwrap_or(DEFAULT_WINDOW_MONTHS),
            hoarder_premium,
        })
    }

    /// Whether a body dated `date_ms` may be written to (or kept in) the
    /// vault. `OnDemand` never keeps a body on disk; `Hoarder` always does;
    /// `KeepRecent`/`IndexOnly` keep it while it is inside `window_months`.
    /// A window of 0, or a window too large for `cutoff_ms` to represent as
    /// a calendar date, both mean "no cutoff": always `true`.
    pub fn keeps_body(&self, date_ms: i64, now_ms: i64) -> bool {
        match self.mode {
            FetchMode::OnDemand => false,
            FetchMode::Hoarder => true,
            FetchMode::KeepRecent | FetchMode::IndexOnly => {
                if self.window_months == 0 {
                    return true;
                }
                match cutoff_ms(now_ms, self.window_months) {
                    Some(cutoff) => date_ms >= cutoff,
                    // Window months too large to land on a representable
                    // calendar date (e.g. anywhere near u32::MAX months):
                    // never delete on an ambiguous value, so keep.
                    None => true,
                }
            }
        }
    }

    /// `keeps_body` for a message whose date may be unknown: the download
    /// gate's question. An unknown date is kept by every mode that keeps
    /// anything (never judged old on an ambiguous value); `OnDemand` keeps
    /// nothing whatever the date.
    pub fn keeps_body_dated(&self, date_ms: Option<i64>, now_ms: i64) -> bool {
        match date_ms {
            Some(d) => self.keeps_body(d, now_ms),
            None => self.mode != FetchMode::OnDemand,
        }
    }

    /// Whether a body just fetched is written to the vault. A message the
    /// user OPENED (or exported) is kept in every mode except On Demand,
    /// whatever its date: a window decides what is downloaded ahead and what
    /// the eviction worker later removes, never whether the message on
    /// screen reads offline and has its attachments. A body fetched ahead
    /// (backfill, IDLE arrivals) follows `keeps_body_dated`.
    pub fn caches_fetched(&self, opened: bool, date_ms: Option<i64>, now_ms: i64) -> bool {
        if opened {
            self.mode != FetchMode::OnDemand
        } else {
            self.keeps_body_dated(date_ms, now_ms)
        }
    }

    /// Whether the daemon's proactive all-folders Hoarder worker should run
    /// for this account. Premium gates only this worker (ruling 09-27): a
    /// missing or lapsed Premium never deletes anything, it just leaves a
    /// `Hoarder` account behaving like today's free "keep all".
    pub fn runs_hoarder_worker(&self) -> bool {
        self.mode == FetchMode::Hoarder && self.hoarder_premium
    }
}

/// `now_ms` minus `months` calendar months, in UTC. Uses `chrono`'s
/// `checked_sub_months`, which clamps the day-of-month to the target
/// month's last day when it doesn't exist there (e.g. Jan 31 minus 1 month
/// lands on Dec 31) and preserves the time-of-day.
///
/// Returns `None` when `now_ms` itself isn't a representable instant, or
/// when subtracting `months` would land outside chrono's representable
/// date range (roughly the tens of thousands of years either side of now,
/// or `months` alone exceeding `i32::MAX`) — callers treat `None` as "no
/// cutoff" rather than an error.
///
/// This is UTC calendar-month arithmetic, not a port of the frontend's
/// `Date.setMonth` cutoff (`src/services/EmailPipelineManager.js`
/// `_getUncachedUids`), which runs in the local timezone and rolls overflow
/// into the following month instead of clamping to the last day of the
/// target month. A JS port of this function must do UTC arithmetic with an
/// explicit end-of-month clamp (not reuse `setMonth`) to agree with this
/// one.
fn cutoff_ms(now_ms: i64, months: u32) -> Option<i64> {
    use chrono::{DateTime, Months, Utc};

    let now = DateTime::<Utc>::from_timestamp_millis(now_ms)?;
    now.checked_sub_months(Months::new(months)).map(|d| d.timestamp_millis())
}

/// A cached (Maildir) copy of a message, as far as eviction cares.
#[derive(Clone, Debug)]
pub struct CacheFile {
    pub uid: u32,
    /// Whether this copy carries the `A` (archived) maildir flag —
    /// backup/manual archive/restore/drafts (`vault_flags::store_flags`).
    /// The caller parses this out of the maildir filename's flags, not a
    /// raw flag string, so a future flag encoding change can't silently
    /// make archived copies look evictable.
    pub archived: bool,
    /// The message's date, when known. `None` (date unparseable/missing)
    /// means "unknown age": never evicted by an age rule (`KeepRecent`),
    /// though `OnDemand`/`IndexOnly` still apply their own non-age rules to
    /// it.
    pub date_ms: Option<i64>,
}

/// Uids whose non-archived cache copy `policy` allows deleting right now.
///
/// Never evicted: an `archived` file (backup/manual archive/restore/drafts),
/// a uid not present in `on_server` (no fresh proof the server still has
/// it), `Hoarder` mode, or `KeepRecent` with `window_months == 0` ("never
/// evict" is treated as never evict, not evict-everything-not-yet-reached).
///
/// Otherwise, per mode: `OnDemand` evicts every remaining file. `KeepRecent`
/// evicts files whose body is older than the window, never a file with an
/// unknown (`None`) date. `IndexOnly` ignores the window for eviction
/// entirely — it evicts any remaining file whose uid is in `indexed` (the
/// search index already holds it, so the body is no longer needed),
/// regardless of age.
pub fn eviction_candidates(
    files: &[CacheFile],
    policy: &FetchPolicy,
    now_ms: i64,
    on_server: &HashSet<u32>,
    indexed: &HashSet<u32>,
) -> Vec<u32> {
    if policy.mode == FetchMode::Hoarder {
        return Vec::new();
    }
    if policy.mode == FetchMode::KeepRecent && policy.window_months == 0 {
        return Vec::new();
    }

    files
        .iter()
        .filter(|f| !f.archived)
        .filter(|f| on_server.contains(&f.uid))
        .filter(|f| match policy.mode {
            FetchMode::OnDemand => true,
            FetchMode::KeepRecent => match f.date_ms {
                Some(d) => !policy.keeps_body(d, now_ms),
                None => false, // unknown age: never evict on an ambiguous value
            },
            FetchMode::IndexOnly => indexed.contains(&f.uid),
            FetchMode::Hoarder => false, // unreachable: short-circuited above
        })
        .map(|f| f.uid)
        .collect()
}

/// A cache file as the eviction worker read it: its `CacheFile` facts plus
/// the Message-ID its own header carries (`None`: no header, or an archived
/// copy the worker never reads).
#[derive(Clone, Debug)]
pub struct CachedCopy {
    pub file: CacheFile,
    pub message_id: Option<String>,
}

/// What the eviction worker may delete from one mailbox. A uid counts as
/// still on the server only when BOTH:
/// - the fresh server listing taken in this pass has it (`server`), and
/// - the header cache lists it (`listed`, `custody::cache::listed_message_ids`)
///   with a Message-ID equal, normalized, to the file's own.
///
/// A missing id on either side is no proof and keeps the file: after a
/// UIDVALIDITY change the same uid can name another message, and the search
/// index keeps an evicted message's row only while the header cache lists it
/// (H2), so a uid it does not list must stay on disk. The survivors then go
/// through `eviction_candidates` (archived, mode, window, index).
pub fn eviction_plan(
    copies: &[CachedCopy],
    policy: &FetchPolicy,
    now_ms: i64,
    server: &HashSet<u32>,
    listed: &HashMap<u32, Option<String>>,
    indexed: &HashSet<u32>,
) -> Vec<u32> {
    let proven: HashSet<u32> = copies
        .iter()
        .filter(|c| server.contains(&c.file.uid))
        .filter(|c| {
            let file_id = c.message_id.as_deref().map(crate::maildir::normalize_message_id).filter(|id| !id.is_empty());
            let listed_id = listed
                .get(&c.file.uid)
                .and_then(|id| id.as_deref())
                .map(crate::maildir::normalize_message_id)
                .filter(|id| !id.is_empty());
            matches!((file_id, listed_id), (Some(a), Some(b)) if a == b)
        })
        .map(|c| c.file.uid)
        .collect();
    let files: Vec<CacheFile> = copies.iter().map(|c| c.file.clone()).collect();
    eviction_candidates(&files, policy, now_ms, &proven, indexed)
}

/// Whether `raw` (a message fetched from the server, or held in memory) is
/// the message the header cache lists under its uid, whose Message-ID is
/// `listed`. Compared with every space and bracket removed, the rule the app's
/// raw-source check uses (`readRawMessageId`): IMAP ENVELOPE and a header parse
/// fold the same id differently. A missing id on either side proves nothing
/// and is let through, the contract of the app's `bodyMatchesHeader`. Only
/// the header block is read: a quoted reply carries its parent's id below it.
pub fn same_message(listed: Option<&str>, raw: &[u8]) -> bool {
    let canon = |id: &str| id.chars().filter(|c| !c.is_whitespace() && *c != '<' && *c != '>').collect::<String>();
    let listed = listed.map(canon).filter(|id| !id.is_empty());
    let own = crate::maildir::message_id_in(raw).map(|id| canon(&id)).filter(|id| !id.is_empty());
    match (listed, own) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

/// One message's bytes in `RawLru`.
#[derive(Debug)]
struct RawEntry {
    account: String,
    mailbox: String,
    uid: u32,
    raw: Vec<u8>,
}

/// On Demand keeps no body on disk, so a message it fetched lives here, in
/// memory, for the attachment, inline-image and source reads that follow the
/// open. Capped by count and by bytes; the least recently used goes first. A
/// message larger than the whole byte cap is never kept.
// ponytail: a linear scan over at most `max_count` entries; a map plus a
// list if the cap ever grows past a few dozen.
#[derive(Debug)]
pub struct RawLru {
    /// Oldest first.
    entries: std::collections::VecDeque<RawEntry>,
    max_count: usize,
    max_bytes: usize,
    bytes: usize,
}

impl RawLru {
    pub fn new(max_count: usize, max_bytes: usize) -> Self {
        RawLru { entries: Default::default(), max_count, max_bytes, bytes: 0 }
    }

    fn take(&mut self, account: &str, mailbox: &str, uid: u32) -> Option<RawEntry> {
        let at = self.entries.iter().position(|e| e.uid == uid && e.account == account && e.mailbox == mailbox)?;
        let entry = self.entries.remove(at)?;
        self.bytes -= entry.raw.len();
        Some(entry)
    }

    /// The message's bytes, now the most recently used.
    pub fn get(&mut self, account: &str, mailbox: &str, uid: u32) -> Option<Vec<u8>> {
        let entry = self.take(account, mailbox, uid)?;
        let raw = entry.raw.clone();
        self.bytes += entry.raw.len();
        self.entries.push_back(entry);
        Some(raw)
    }

    /// Keep `raw` as the most recently used, replacing what the key held.
    pub fn put(&mut self, account: &str, mailbox: &str, uid: u32, raw: Vec<u8>) {
        self.take(account, mailbox, uid);
        if raw.len() > self.max_bytes || self.max_count == 0 {
            return;
        }
        while self.entries.len() >= self.max_count || self.bytes + raw.len() > self.max_bytes {
            let Some(old) = self.entries.pop_front() else { break };
            self.bytes -= old.raw.len();
        }
        self.bytes += raw.len();
        self.entries.push_back(RawEntry { account: account.to_string(), mailbox: mailbox.to_string(), uid, raw });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../tests/fixtures/fetch-policy-cases.json");

    #[derive(Deserialize)]
    struct Fixture {
        #[serde(rename = "fromSettingsCases")]
        from_settings_cases: Vec<FromSettingsCase>,
        #[serde(rename = "keepsBodyCases")]
        keeps_body_cases: Vec<KeepsBodyCase>,
    }

    #[derive(Deserialize)]
    struct FromSettingsCase {
        name: String,
        state: serde_json::Value,
        #[serde(rename = "accountId")]
        account_id: String,
        expected: Option<ExpectedPolicy>,
    }

    #[derive(Deserialize)]
    struct ExpectedPolicy {
        mode: FetchMode,
        #[serde(rename = "windowMonths")]
        window_months: u32,
        #[serde(rename = "hoarderPremium")]
        hoarder_premium: bool,
    }

    #[derive(Deserialize)]
    struct KeepsBodyCase {
        name: String,
        policy: ExpectedPolicy,
        #[serde(rename = "dateMs")]
        date_ms: i64,
        #[serde(rename = "nowMs")]
        now_ms: i64,
        expected: bool,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("fixture is valid JSON matching the Fixture shape")
    }

    #[test]
    fn from_settings_matches_the_shared_fixture() {
        for case in fixture().from_settings_cases {
            let actual = FetchPolicy::from_settings(&case.state, &case.account_id);
            match case.expected {
                None => assert!(actual.is_none(), "case `{}`: expected None, got {:?}", case.name, actual),
                Some(expected) => {
                    let actual = actual.unwrap_or_else(|| panic!("case `{}`: expected Some(..), got None", case.name));
                    assert_eq!(actual.mode, expected.mode, "case `{}`: mode", case.name);
                    assert_eq!(actual.window_months, expected.window_months, "case `{}`: window_months", case.name);
                    assert_eq!(actual.hoarder_premium, expected.hoarder_premium, "case `{}`: hoarder_premium", case.name);
                }
            }
        }
    }

    #[test]
    fn keeps_body_matches_the_shared_fixture() {
        for case in fixture().keeps_body_cases {
            let policy = FetchPolicy {
                mode: case.policy.mode,
                window_months: case.policy.window_months,
                hoarder_premium: case.policy.hoarder_premium,
            };
            assert_eq!(
                policy.keeps_body(case.date_ms, case.now_ms),
                case.expected,
                "case `{}`",
                case.name
            );
        }
    }

    #[test]
    fn runs_hoarder_worker_is_true_only_for_hoarder_with_premium() {
        let hoarder_premium = FetchPolicy { mode: FetchMode::Hoarder, window_months: 0, hoarder_premium: true };
        let hoarder_free = FetchPolicy { mode: FetchMode::Hoarder, window_months: 0, hoarder_premium: false };
        let keep_recent_premium = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: true };

        assert!(hoarder_premium.runs_hoarder_worker());
        assert!(!hoarder_free.runs_hoarder_worker());
        assert!(!keep_recent_premium.runs_hoarder_worker());
    }

    fn file(uid: u32, archived: bool, date_ms: i64) -> CacheFile {
        CacheFile { uid, archived, date_ms: Some(date_ms) }
    }

    fn undated_file(uid: u32, archived: bool) -> CacheFile {
        CacheFile { uid, archived, date_ms: None }
    }

    // A realistic "now" and a clearly-stale date: without the filter each
    // test is checking, every mode (including KeepRecent) would evict this
    // file, so these tests actually exercise the filter.
    const NOW_MS: i64 = 1_768_435_200_000; // 2026-01-15T00:00:00Z
    const STALE_DATE_MS: i64 = 1_420_070_400_000; // 2015-01-01T00:00:00Z

    #[test]
    fn an_archived_file_is_never_a_candidate_in_any_mode() {
        let files = vec![file(1, true, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = [1].into_iter().collect();
        for mode in [FetchMode::OnDemand, FetchMode::KeepRecent, FetchMode::IndexOnly, FetchMode::Hoarder] {
            let policy = FetchPolicy { mode, window_months: 3, hoarder_premium: false };
            assert!(
                eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty(),
                "mode {:?} evicted an archived file",
                mode
            );
        }
    }

    #[test]
    fn a_draft_carries_the_archived_flag_and_is_never_a_candidate() {
        // Drafts always carry `A` (`vault_flags::DRAFT_FLAGS`), so the
        // caller reports them as `archived: true` like any other archived
        // copy; there is no separate "is a draft" check.
        let files = vec![file(1, true, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::OnDemand, window_months: 0, hoarder_premium: false };
        assert!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty());
    }

    #[test]
    fn a_file_missing_from_a_fresh_server_listing_is_never_a_candidate() {
        let files = vec![file(1, false, STALE_DATE_MS)];
        let on_server: HashSet<u32> = HashSet::new(); // server listing doesn't have uid 1
        let indexed: HashSet<u32> = [1].into_iter().collect();
        for mode in [FetchMode::OnDemand, FetchMode::KeepRecent, FetchMode::IndexOnly] {
            let policy = FetchPolicy { mode, window_months: 3, hoarder_premium: false };
            assert!(
                eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty(),
                "mode {:?} evicted a file absent from on_server",
                mode
            );
        }
    }

    #[test]
    fn hoarder_never_evicts_anything() {
        let files = vec![file(1, false, STALE_DATE_MS), file(2, false, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = [1, 2].into_iter().collect();
        let policy = FetchPolicy { mode: FetchMode::Hoarder, window_months: 3, hoarder_premium: true };
        assert!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty());
    }

    #[test]
    fn keep_recent_with_window_zero_never_evicts() {
        let files = vec![file(1, false, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 0, hoarder_premium: false };
        assert!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty());
    }

    #[test]
    fn keep_recent_with_a_window_too_large_to_represent_never_evicts() {
        let files = vec![file(1, false, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::KeepRecent, window_months: u32::MAX, hoarder_premium: false };
        assert!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty());
    }

    #[test]
    fn keep_recent_never_evicts_an_undated_file() {
        let files = vec![undated_file(1, false)];
        let on_server: HashSet<u32> = [1].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: false };
        assert!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed).is_empty());
    }

    #[test]
    fn keep_recent_evicts_only_files_older_than_the_window() {
        let fresh = file(1, false, 1_768_348_800_000); // 2026-01-14, inside a 3-month window
        let stale = file(2, false, STALE_DATE_MS); // 2015-01-01, well outside
        let files = vec![fresh, stale];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: false };
        assert_eq!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed), vec![2]);
    }

    #[test]
    fn on_demand_evicts_every_non_archived_on_server_file_including_trashed() {
        // "T" (trashed) is not "A" (archived): a trashed-but-not-archived
        // copy is a candidate like any other non-archived copy.
        let files = vec![file(1, false, STALE_DATE_MS), file(2, false, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = HashSet::new();
        let policy = FetchPolicy { mode: FetchMode::OnDemand, window_months: 0, hoarder_premium: false };
        let mut evicted = eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed);
        evicted.sort();
        assert_eq!(evicted, vec![1, 2]);
    }

    #[test]
    fn index_only_evicts_only_files_the_index_already_holds() {
        let files = vec![file(1, false, STALE_DATE_MS), file(2, false, STALE_DATE_MS)];
        let on_server: HashSet<u32> = [1, 2].into_iter().collect();
        let indexed: HashSet<u32> = [1].into_iter().collect(); // 2 not indexed yet
        let policy = FetchPolicy { mode: FetchMode::IndexOnly, window_months: 3, hoarder_premium: false };
        assert_eq!(eviction_candidates(&files, &policy, NOW_MS, &on_server, &indexed), vec![1]);
    }

    // ── H3: eviction_plan (server listing AND header cache with matching id) ──

    fn copy(uid: u32, archived: bool, id: Option<&str>) -> CachedCopy {
        CachedCopy { file: file(uid, archived, STALE_DATE_MS), message_id: id.map(str::to_string) }
    }

    fn on_demand() -> FetchPolicy {
        FetchPolicy { mode: FetchMode::OnDemand, window_months: 3, hoarder_premium: false }
    }

    #[test]
    fn eviction_plan_evicts_a_uid_the_server_lists_and_the_header_cache_names_with_the_same_id() {
        let copies = vec![copy(1, false, Some("<a@x>"))];
        let server: HashSet<u32> = [1].into_iter().collect();
        // Brackets and space normalize away on both sides.
        let listed: HashMap<u32, Option<String>> = [(1, Some(" a@x ".to_string()))].into_iter().collect();
        assert_eq!(eviction_plan(&copies, &on_demand(), NOW_MS, &server, &listed, &HashSet::new()), vec![1]);
    }

    #[test]
    fn eviction_plan_keeps_a_uid_missing_from_the_fresh_server_listing() {
        let copies = vec![copy(1, false, Some("<a@x>"))];
        let listed: HashMap<u32, Option<String>> = [(1, Some("<a@x>".to_string()))].into_iter().collect();
        assert!(eviction_plan(&copies, &on_demand(), NOW_MS, &HashSet::new(), &listed, &HashSet::new()).is_empty());
    }

    #[test]
    fn eviction_plan_keeps_a_uid_the_header_cache_does_not_list() {
        let copies = vec![copy(1, false, Some("<a@x>"))];
        let server: HashSet<u32> = [1].into_iter().collect();
        assert!(eviction_plan(&copies, &on_demand(), NOW_MS, &server, &HashMap::new(), &HashSet::new()).is_empty());
    }

    #[test]
    fn eviction_plan_keeps_a_uid_whose_listed_message_id_is_another_message() {
        let copies = vec![copy(1, false, Some("<a@x>"))];
        let server: HashSet<u32> = [1].into_iter().collect();
        let listed: HashMap<u32, Option<String>> = [(1, Some("<b@x>".to_string()))].into_iter().collect();
        assert!(eviction_plan(&copies, &on_demand(), NOW_MS, &server, &listed, &HashSet::new()).is_empty());
    }

    #[test]
    fn eviction_plan_keeps_a_uid_when_either_side_has_no_message_id() {
        let server: HashSet<u32> = [1, 2].into_iter().collect();
        let copies = vec![copy(1, false, None), copy(2, false, Some("<b@x>"))];
        let listed: HashMap<u32, Option<String>> =
            [(1, Some("<a@x>".to_string())), (2, None)].into_iter().collect();
        assert!(eviction_plan(&copies, &on_demand(), NOW_MS, &server, &listed, &HashSet::new()).is_empty());
        let blank = vec![copy(1, false, Some("<>"))];
        let listed_blank: HashMap<u32, Option<String>> = [(1, Some("<>".to_string()))].into_iter().collect();
        assert!(
            eviction_plan(&blank, &on_demand(), NOW_MS, &server, &listed_blank, &HashSet::new()).is_empty(),
            "two empty ids are not a match"
        );
    }

    #[test]
    fn eviction_plan_never_evicts_an_archived_copy_even_when_proven_on_the_server() {
        let copies = vec![copy(1, true, Some("<a@x>"))];
        let server: HashSet<u32> = [1].into_iter().collect();
        let listed: HashMap<u32, Option<String>> = [(1, Some("<a@x>".to_string()))].into_iter().collect();
        assert!(eviction_plan(&copies, &on_demand(), NOW_MS, &server, &listed, &HashSet::new()).is_empty());
    }

    #[test]
    fn keeps_body_dated_keeps_an_unknown_date_except_on_demand() {
        for (mode, expected) in
            [(FetchMode::OnDemand, false), (FetchMode::KeepRecent, true), (FetchMode::IndexOnly, true), (FetchMode::Hoarder, true)]
        {
            let policy = FetchPolicy { mode, window_months: 3, hoarder_premium: false };
            assert_eq!(policy.keeps_body_dated(None, NOW_MS), expected, "{mode:?}");
        }
        let keep_recent = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: false };
        assert!(!keep_recent.keeps_body_dated(Some(STALE_DATE_MS), NOW_MS));
        assert!(keep_recent.keeps_body_dated(Some(NOW_MS), NOW_MS));
    }

    #[test]
    fn an_opened_message_is_cached_in_every_mode_but_on_demand_whatever_its_date() {
        for (mode, opened_cached) in
            [(FetchMode::OnDemand, false), (FetchMode::KeepRecent, true), (FetchMode::IndexOnly, true), (FetchMode::Hoarder, true)]
        {
            let policy = FetchPolicy { mode, window_months: 3, hoarder_premium: false };
            assert_eq!(policy.caches_fetched(true, Some(STALE_DATE_MS), NOW_MS), opened_cached, "{mode:?} opened");
            assert_eq!(policy.caches_fetched(true, None, NOW_MS), opened_cached, "{mode:?} opened, undated");
        }
        // Fetched ahead: the window decides.
        let keep_recent = FetchPolicy { mode: FetchMode::KeepRecent, window_months: 3, hoarder_premium: false };
        assert!(!keep_recent.caches_fetched(false, Some(STALE_DATE_MS), NOW_MS));
        assert!(keep_recent.caches_fetched(false, Some(NOW_MS), NOW_MS));
    }

    // ── H3c: raw bytes of a message the vault does not hold ──

    fn lru_keys(lru: &RawLru) -> Vec<u32> {
        lru.entries.iter().map(|e| e.uid).collect()
    }

    #[test]
    fn the_raw_lru_keeps_at_most_its_count_and_drops_the_oldest() {
        let mut lru = RawLru::new(2, 1_000);
        for uid in 1..=3 {
            lru.put("a", "INBOX", uid, vec![0; 10]);
        }
        assert_eq!(lru.get("a", "INBOX", 1), None, "the oldest went first");
        assert_eq!(lru.get("a", "INBOX", 3), Some(vec![0; 10]));
        assert_eq!(lru.entries.len(), 2);
    }

    #[test]
    fn the_raw_lru_drops_the_oldest_past_its_byte_cap_and_never_keeps_an_oversize_message() {
        let mut lru = RawLru::new(10, 100);
        lru.put("a", "INBOX", 1, vec![1; 60]);
        lru.put("a", "INBOX", 2, vec![2; 60]);
        assert_eq!(lru_keys(&lru), vec![2], "120 bytes is over the cap: uid 1 goes");
        lru.put("a", "INBOX", 3, vec![3; 101]);
        assert_eq!(lru.get("a", "INBOX", 3), None, "larger than the whole cap: not kept");
        assert_eq!(lru_keys(&lru), vec![2], "and it evicts nothing on the way");
        assert_eq!(lru.bytes, 60);
    }

    #[test]
    fn a_raw_lru_hit_is_the_most_recent_and_a_put_replaces_the_same_key() {
        let mut lru = RawLru::new(2, 1_000);
        lru.put("a", "INBOX", 1, vec![1]);
        lru.put("a", "INBOX", 2, vec![2]);
        assert!(lru.get("a", "INBOX", 1).is_some());
        lru.put("a", "INBOX", 3, vec![3]);
        assert_eq!(lru_keys(&lru), vec![1, 3], "uid 1 was read last, so uid 2 went");
        lru.put("a", "INBOX", 3, vec![9, 9]);
        assert_eq!(lru.get("a", "INBOX", 3), Some(vec![9, 9]));
        assert_eq!((lru.entries.len(), lru.bytes), (2, 3));
        // Same uid, another mailbox or account: another message.
        assert_eq!(lru.get("a", "Sent", 3), None);
        assert_eq!(lru.get("b", "INBOX", 3), None);
    }

    fn with_id(header: &str) -> Vec<u8> {
        format!("From: a@example.com\r\n{header}Subject: s\r\n\r\nMessage-ID: <quoted@elsewhere>\r\n").into_bytes()
    }

    #[test]
    fn same_message_ignores_brackets_and_folding() {
        let raw = with_id("Message-ID:\r\n <abc@example.com>\r\n");
        assert!(same_message(Some("<abc@example.com>"), &raw));
        assert!(same_message(Some("abc@example.com"), &raw));
        assert!(same_message(Some(" <abc@example.com >"), &raw));
    }

    #[test]
    fn same_message_refuses_another_id_and_reads_only_the_header() {
        assert!(!same_message(Some("<other@example.com>"), &with_id("Message-ID: <abc@example.com>\r\n")));
        // The body quotes a Message-ID: it is not this message's.
        assert!(!same_message(Some("<quoted@elsewhere>"), &with_id("Message-ID: <abc@example.com>\r\n")));
    }

    #[test]
    fn same_message_lets_a_missing_id_on_either_side_through() {
        assert!(same_message(None, &with_id("Message-ID: <abc@example.com>\r\n")));
        assert!(same_message(Some(""), &with_id("Message-ID: <abc@example.com>\r\n")));
        assert!(same_message(Some("<abc@example.com>"), &with_id("")));
    }
}
