//! Phase 5 (D7): per account, the messages the app has listed or cached whose
//! full copy the vault does not hold, and "Save them now".
//!
//! `vault_gap_count {accountId}` answers
//! `{count, vaultReachable, reason?, partial, byMailbox: [{mailbox, count, partial}]}`:
//! every header-cache folder's uids minus the uids its vault folder holds,
//! leaving out what the download mode leaves on the server
//! (`FetchPolicy::promises_copy`) and import-range uids. `byMailbox` lists
//! only folders with a gap or a `partial` answer. `partial`: a folder whose
//! cache holds fewer rows than the server's count the daemon's sync recorded
//! (`folder_listing`'s rule), or whose vault holdings cannot be known (two
//! cached folders filed under one vault folder, or a vault folder the
//! registry cannot list): the count is then a floor, never "all saved".
//! `count: null` when the header cache cannot be read; `reason` then, and
//! whenever the vault is unreachable, is `E_VAULT_UNAVAILABLE` (vault
//! unreachable or being moved) or `E_HEADER_CACHE_UNAVAILABLE` (vault there,
//! cache not). The header cache lives in the vault (`custody.db`), so a vault
//! unreachable since startup has no count: only one lost while the store is
//! still open, or closed for a move, still counts.
//!
//! Recomputed on every request, never cached: nothing to invalidate, and the
//! cost is bounded instead. It runs on a thread of its own at background
//! QoS. The cache is read one index seek or one page of `CACHE_CHUNK` uids
//! per custody unit, never a whole folder under the lock every foreground
//! header read waits on. The vault side is the registry's uid list (one `cur/`
//! listing per folder per daemon session, names and stats only), and the
//! difference is a merge over the two sorted lists (`vault_gap::Gap`). It
//! writes nothing: not the vault, not the cache (the registry keeps its own
//! derived rows in `app_dir`, as on every read).
//!
//! `vault_gap_save {accountId, accountJson}` answers `{runId, started: true}`
//! at once and runs the existing backup step for exactly those uids
//! (`backup::run_imap_uids`, archived copies on the background lane), with
//! the backup's `backup-progress` frames and `backup_cancel`. A backup or
//! save already running for the account is joined, never doubled:
//! `{runId, started: false, running: true}`. `accountJson` is the account
//! `backup_run_account` takes, from the app (fresh token): the per-message
//! step parses exactly that string. An Outlook account is refused
//! (`E_VAULT_GAP_GRAPH`): the daemon holds no Graph token and no per-uid
//! Graph save exists; its backup saves them.
//!
//! Both answer `INVALID_PARAMS` without `accountId` and `E_ACCOUNT_NOT_FOUND`
//! for an account the header cache has never heard of.

use crate::handlers::common::{self, blocking, str_arg};
use crate::handlers::imap::{download_policy, now_ms};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::backup::{self, BackupProgress, BackupRunContext};
use mailvault_core::custody::cache;
use mailvault_core::imap::ImapConfig;
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::vault_flags::{Applied, FlagChange};
use mailvault_core::vault_gap::Gap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::warn;

pub(crate) const E_ACCOUNT_NOT_FOUND: &str = "E_ACCOUNT_NOT_FOUND";
/// The code every vault-rooted route's gate already answers with
/// (`handlers::common::vault_root`), catalog key `errors.E_VAULT_UNAVAILABLE`.
pub(crate) const E_VAULT_UNAVAILABLE: &str = "E_VAULT_UNAVAILABLE";
pub(crate) const E_HEADER_CACHE_UNAVAILABLE: &str = "E_HEADER_CACHE_UNAVAILABLE";
pub(crate) const E_VAULT_GAP_GRAPH: &str = "E_VAULT_GAP_GRAPH";

/// Header-cache uids per custody unit.
const CACHE_CHUNK: usize = 2000;

#[derive(Debug)]
struct Folder {
    mailbox: String,
    /// Ascending.
    missing: Vec<u32>,
    partial: bool,
}

#[derive(Debug)]
enum Unknown {
    /// The header cache holds no row, meta or folder list for the account.
    Account,
    /// The header cache could not be read.
    Cache(String),
}

/// Every cached folder of `account_id` with the uids its vault folder is
/// missing, reading the cache `chunk` uids per custody unit. Never under a
/// custody lock while it asks the registry (lock order: mailbox lock, gate,
/// custody, registry).
fn gap(state: &DaemonState, account_id: &str, chunk: usize, now_ms: i64) -> Result<Vec<Folder>, Unknown> {
    let chunk = chunk.max(1);
    let mut mailboxes: Vec<String> = Vec::new();
    loop {
        let after = mailboxes.last().map(String::as_str);
        match crate::custody::with_conn(state, |c| cache::next_mailbox_with_headers(c, account_id, after)).map_err(Unknown::Cache)? {
            Some(mailbox) => mailboxes.push(mailbox),
            None => break,
        }
    }
    if mailboxes.is_empty() && !crate::custody::with_conn(state, |c| cache::knows_account(c, account_id)).map_err(Unknown::Cache)? {
        return Err(Unknown::Account);
    }
    // An undated message is promised by every mode that keeps anything at
    // all (`keeps_body_dated`), so this asks whether the mode keeps any copy:
    // a hidden, On Demand or Index Only account is missing nothing, and its
    // folders are not even listed.
    let Some(policy) = download_policy(&state.app_dir, account_id).filter(|p| p.promises_copy(None, now_ms)) else {
        return Ok(Vec::new());
    };
    let mut per_dir: HashMap<String, usize> = HashMap::new();
    for mailbox in &mailboxes {
        *per_dir.entry(vault_dir_name(mailbox)).or_default() += 1;
    }
    let mut folders = Vec::with_capacity(mailboxes.len());
    for mailbox in mailboxes {
        // Two cached folders filed under one vault folder: a vault uid does
        // not say whose message it is (the hoarder skips these too).
        let held = match per_dir[&vault_dir_name(&mailbox)] {
            1 => state.vault_registry.uid_sets(&state.data_dir, account_id, &mailbox).map(|(saved, _)| saved),
            _ => None,
        };
        let Some(held) = held else {
            folders.push(Folder { mailbox, missing: Vec::new(), partial: true });
            continue;
        };
        let (server, uid_next) = crate::custody::with_conn(state, |c| cache::recorded_count(c, account_id, &mailbox)).map_err(Unknown::Cache)?;
        let mut walk = Gap::new(&held);
        let (mut rows, mut below_next) = (0i64, 0i64);
        let mut after = None;
        loop {
            let page = crate::custody::with_conn(state, |c| cache::uid_dates_after(c, account_id, &mailbox, after, chunk)).map_err(Unknown::Cache)?;
            rows += page.len() as i64;
            below_next += page.iter().filter(|(uid, _)| uid_next.is_some_and(|next| i64::from(*uid) < next)).count() as i64;
            walk.feed(&page, |date| policy.promises_copy(date, now_ms));
            match page.last() {
                Some(&(last, _)) if page.len() == chunk => after = Some(last),
                _ => break,
            }
        }
        // `folder_listing`'s rule: only rows below the recorded UIDNEXT are
        // judged against the recorded count; with no count, the rows are the
        // listing.
        let judged = if server.is_some() && uid_next.is_some() { below_next } else { rows };
        let partial = server.is_some_and(|total| judged < total);
        folders.push(Folder { mailbox, missing: walk.missing, partial });
    }
    Ok(folders)
}

/// `f` on a thread of its own at background QoS. Never a pooled blocking
/// thread: a QoS lowered there would stay with the foreground work it runs
/// next.
async fn in_background<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("vault-gap".into())
        .spawn(move || {
            crate::mbox_upload_job::background_qos();
            let _ = tx.send(f());
        })
        .map_err(|e| format!("the count could not start: {e}"))?;
    rx.await.map_err(|_| "the count stopped before it answered".to_string())
}

pub(crate) async fn count(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    // `mail_dir_ok` is decided at startup: a drive lost since is caught by
    // the root no longer being there.
    let reachable = common::vault_root(state).is_ok_and(|root| root.is_dir());
    let (st, acct) = (Arc::clone(state), account_id.clone());
    let folders = match in_background(move || gap(&st, &acct, CACHE_CHUNK, now_ms())).await {
        Ok(Ok(folders)) => folders,
        Ok(Err(Unknown::Account)) => {
            return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_ACCOUNT_NOT_FOUND}: {account_id}"));
        }
        Ok(Err(Unknown::Cache(e))) => {
            warn!("[vault_gap] {account_id}: header cache unreadable, count unknown: {e}");
            let reason = if reachable { E_HEADER_CACHE_UNAVAILABLE } else { E_VAULT_UNAVAILABLE };
            return RpcResponse::success(
                id,
                json!({"count": null, "vaultReachable": reachable, "reason": reason, "partial": true, "byMailbox": []}),
            );
        }
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    };
    let count: usize = folders.iter().map(|f| f.missing.len()).sum();
    let by_mailbox: Vec<Value> = folders
        .iter()
        .filter(|f| f.partial || !f.missing.is_empty())
        .map(|f| json!({"mailbox": f.mailbox, "count": f.missing.len(), "partial": f.partial}))
        .collect();
    let mut reply = json!({
        "count": count,
        "vaultReachable": reachable,
        "partial": folders.iter().any(|f| f.partial),
        "byMailbox": by_mailbox,
    });
    if !reachable {
        reply["reason"] = json!(E_VAULT_UNAVAILABLE);
    }
    RpcResponse::success(id, reply)
}

/// This run's `backup-progress` frames, while it still owns the account's
/// entry in `backup_runs`. `backup_run_account` replaces a running entry (the
/// app's stall-watchdog retry relies on that), and the app settles a
/// scheduled backup on the first `active: false` frame for its account: a
/// frame from a save it displaced would end that backup early. So a
/// displaced save stops (its own cancel flag) and emits nothing more; the run
/// that took the entry owns the account's frames.
fn frames_while_owned(state: &Arc<DaemonState>, account_id: &str, cancel: Arc<AtomicBool>) -> Arc<dyn Fn(BackupProgress) + Send + Sync> {
    let (state, account_id) = (Arc::clone(state), account_id.to_string());
    Arc::new(move |frame: BackupProgress| {
        let owned = state
            .backup_runs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&account_id)
            .is_some_and(|token| Arc::ptr_eq(token, &cancel));
        if !owned {
            cancel.store(true, Ordering::SeqCst);
            return;
        }
        if let Ok(v) = serde_json::to_value(&frame) {
            state.events.emit("backup-progress", v);
        }
    })
}

pub(crate) async fn save(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let account_json = match str_arg(&id, params, "accountJson") {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let account: ImapConfig = match serde_json::from_str(&account_json) {
        Ok(a) => a,
        Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Bad account JSON: {e}")),
    };
    if account.oauth2_transport.as_deref() == Some("graph") {
        return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_VAULT_GAP_GRAPH}: an Outlook account's missing messages are saved by its backup"));
    }
    // A drive lost since startup passes `vault_root` (its checks are made at
    // startup and by a move); writing there would build the vault's folders
    // on the boot volume instead.
    let root = match common::vault_root(state) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, common::gate_message("the folder is not reachable")),
        Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    };
    let (st, acct) = (Arc::clone(state), account_id.clone());
    match blocking(move || crate::custody::with_conn(&st, |c| cache::knows_account(c, &acct))).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_ACCOUNT_NOT_FOUND}: {account_id}")),
        Ok(Err(e)) | Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("{E_HEADER_CACHE_UNAVAILABLE}: {e}")),
    }
    let Some(run) = crate::handlers::backup::claim_run(state, &account_id) else {
        return RpcResponse::success(id, json!({"runId": account_id, "started": false, "running": true}));
    };
    let on_progress = frames_while_owned(state, &account_id, run.cancel());
    let apply_flags: Arc<dyn Fn(&str, &[FlagChange]) -> Result<Applied, String> + Send + Sync> =
        Arc::new(|_: &str, _: &[FlagChange]| Ok(Applied::default()));
    let ctx = BackupRunContext {
        account_id: account_id.clone(),
        account_json,
        account,
        app_dir: state.app_dir.clone(),
        mirror_root: None,
        cancel: run.cancel(),
        skip_folders: 0,
        mailbox_concurrency: 1,
        archive_ctx: crate::handlers::archive::archive_ctx(state, root),
        on_progress: Arc::clone(&on_progress),
        apply_flags,
    };
    let (st, run_account) = (Arc::clone(state), account_id.clone());
    tokio::spawn(async move {
        // Held to the end: its drop takes this run's own entry out of
        // `backup_runs`, never a newer run's.
        let _run = run;
        let acct = run_account.clone();
        let result = match in_background(move || gap(&st, &acct, CACHE_CHUNK, now_ms())).await {
            Ok(Ok(folders)) => {
                let plan = folders.into_iter().filter(|f| !f.missing.is_empty()).map(|f| (f.mailbox, f.missing)).collect();
                backup::run_imap_uids(ctx, plan).await.map(|_| ())
            }
            Ok(Err(Unknown::Account)) => Err(format!("{E_ACCOUNT_NOT_FOUND}: {run_account}")),
            Ok(Err(Unknown::Cache(e))) => Err(format!("{E_HEADER_CACHE_UNAVAILABLE}: {e}")),
            Err(e) => Err(e),
        };
        if let Err(e) = result {
            warn!("[vault_gap] {run_account}: the save stopped before its terminal frame: {e}");
            on_progress(crate::handlers::backup::failed_frame(&run_account, e));
        }
    });
    RpcResponse::success(id, json!({"runId": account_id, "started": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mailvault_core::maildir::{vault_filename_uid, IMPORT_UID_BASE, INFO_PREFIX};
    use mailvault_core::vault_files;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{Action, MockImap, Scenario, Trigger};
    use std::time::{Duration, Instant};
    use tokio::sync::broadcast;

    const ACCT: &str = "acc1";

    struct Rig {
        _vault: tempfile::TempDir,
        _app: tempfile::TempDir,
        s: Arc<DaemonState>,
    }

    /// A daemon with the header cache open and a Hoarder account: every
    /// cached message is one the vault should hold.
    fn rig() -> Rig {
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let s = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), true);
        mode(&s, json!({"fetchMode": "hoarder"}));
        Rig { _vault: vault, _app: app, s }
    }

    fn mode(s: &DaemonState, settings: Value) {
        std::fs::write(s.app_dir.join("frontend-settings.json"), json!({"mailvault-settings": {"state": settings}}).to_string()).unwrap();
    }

    /// Header rows of `mailbox`, each with an RFC 3339 INTERNALDATE or none
    /// (the unknown-date sentinel), plus `meta`'s keys as the folder's meta.
    fn cache_rows(s: &DaemonState, mailbox: &str, rows: &[(u32, Option<&str>)], meta: Value) {
        let emails: Vec<Value> = rows
            .iter()
            .map(|(uid, date)| match date {
                Some(d) => json!({"uid": uid, "internalDate": d}),
                None => json!({"uid": uid}),
            })
            .collect();
        let mut data = meta;
        data["emails"] = json!(emails);
        crate::custody::with_conn(s, |c| cache::save_headers(c, ACCT, mailbox, &data.to_string())).unwrap();
    }

    fn cached(s: &DaemonState, mailbox: &str, uids: impl IntoIterator<Item = u32>) {
        let rows: Vec<(u32, Option<&str>)> = uids.into_iter().map(|u| (u, None)).collect();
        cache_rows(s, mailbox, &rows, json!({}));
    }

    fn raw(uid: u32) -> String {
        format!("From: a@example.com\r\nSubject: Msg {uid}\r\nDate: Thu, 01 Jan 2015 00:00:00 +0000\r\nMessage-ID: <m{uid}@example.com>\r\n\r\nBody {uid}\r\n")
    }

    /// Vault copies of `uids` in `mailbox`, and the registry told so.
    fn in_vault(s: &DaemonState, mailbox: &str, uids: &[u32]) {
        let cur = vault_files::cur_path(&s.data_dir, ACCT, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        for uid in uids {
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}S.eml")), raw(*uid)).unwrap();
        }
        s.vault_registry.invalidate(ACCT, mailbox);
    }

    /// uid -> the flag letters of its file name, for `mailbox`'s `cur/`.
    fn on_disk(s: &DaemonState, mailbox: &str) -> std::collections::BTreeMap<u32, String> {
        let cur = vault_files::cur_path(&s.data_dir, ACCT, mailbox);
        let Ok(entries) = std::fs::read_dir(cur) else { return Default::default() };
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let uid = vault_filename_uid(&name)?;
                Some((uid, name.split(INFO_PREFIX).nth(1).unwrap_or("").trim_end_matches(".eml").to_string()))
            })
            .collect()
    }

    fn ok(resp: RpcResponse) -> Value {
        match (resp.result, resp.error) {
            (Some(v), None) => v,
            (_, e) => panic!("refused: {e:?}"),
        }
    }

    fn refused(resp: RpcResponse) -> ipc::RpcError {
        resp.error.expect("must be refused")
    }

    async fn count_of(s: &Arc<DaemonState>) -> Value {
        ok(handle_request_for_test(s, "vault_gap_count", json!({"accountId": ACCT})).await)
    }

    fn by_mailbox(reply: &Value) -> Vec<(String, u64, bool)> {
        reply["byMailbox"]
            .as_array()
            .expect("byMailbox")
            .iter()
            .map(|f| (f["mailbox"].as_str().unwrap().to_string(), f["count"].as_u64().unwrap(), f["partial"].as_bool().unwrap()))
            .collect()
    }

    // ── the count ──────────────────────────────────────────────────────────

    /// Per folder: the cached uids minus the vault's. A vault copy the cache
    /// no longer lists (9) takes nothing off; a folder with no vault dir
    /// misses all it lists. By construction it is cheap and read-only: one
    /// `cur/` listing per folder (none on a second count), no message read,
    /// no header-cache write, no vault file touched.
    #[tokio::test]
    async fn the_count_is_the_cached_messages_the_vault_does_not_hold() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=5);
        cached(&r.s, "Work", [10, 11]);
        in_vault(&r.s, "INBOX", &[2, 4, 9]);
        let listings = r.s.vault_registry.listing_count();
        let written = r.s.custody.gen.load(Ordering::SeqCst);

        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(5), "{got}");
        assert_eq!(got["vaultReachable"], json!(true));
        assert!(got.get("reason").is_none(), "{got}");
        assert_eq!(got["partial"], json!(false));
        assert_eq!(by_mailbox(&got), vec![("INBOX".to_string(), 3, false), ("Work".to_string(), 2, false)]);

        assert_eq!(r.s.vault_registry.listing_count() - listings, 2, "one cur/ listing per folder");
        assert_eq!(r.s.vault_registry.parse_count(), 0, "no message is read");
        assert_eq!(r.s.custody.gen.load(Ordering::SeqCst), written, "the header cache is not written");
        assert_eq!(on_disk(&r.s, "INBOX").into_keys().collect::<Vec<_>>(), vec![2, 4, 9], "nor the vault");

        assert_eq!(count_of(&r.s).await["count"], json!(5));
        assert_eq!(r.s.vault_registry.listing_count() - listings, 2, "a second count lists nothing again");
    }

    /// What each download mode leaves on the server is never missing:
    /// fresh (inside a 3-month window), stale (2015) and undated messages.
    /// On Demand, Index Only and a hidden account keep no copy; Keep Recent
    /// keeps its window and the undated; Hoarder and window 0 keep all;
    /// unreadable settings keep all, as the download gates do.
    #[tokio::test]
    async fn each_download_mode_leaves_out_what_it_leaves_on_the_server() {
        let r = rig();
        let fresh = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        cache_rows(&r.s, "INBOX", &[(1, Some(&fresh)), (2, Some("2015-01-01T00:00:00+00:00")), (3, None)], json!({}));
        let cases = [
            (json!({"fetchMode": "hoarder"}), 3),
            (json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 3}), 2),
            (json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 0}), 3),
            (json!({"fetchMode": "indexOnly", "localCacheDurationMonths": 3}), 0),
            (json!({"fetchMode": "onDemand"}), 0),
            (json!({"fetchMode": "hoarder", "fetchModes": {"acc1": "onDemand"}}), 0),
            (json!({"fetchMode": "hoarder", "hiddenAccounts": {"acc1": true}}), 0),
        ];
        for (settings, want) in cases {
            mode(&r.s, settings.clone());
            let got = count_of(&r.s).await;
            assert_eq!(got["count"], json!(want), "{settings}: {got}");
            assert_eq!(got["partial"], json!(false), "{settings}");
        }
        std::fs::remove_file(r.s.app_dir.join("frontend-settings.json")).unwrap();
        assert_eq!(count_of(&r.s).await["count"], json!(3), "unreadable settings keep every body");
    }

    /// Import-range uids are mail an mbox import numbered in the vault
    /// itself, never a server message the vault is short of.
    #[tokio::test]
    async fn an_import_range_uid_is_never_counted() {
        let r = rig();
        cached(&r.s, "INBOX", [1, IMPORT_UID_BASE, IMPORT_UID_BASE + 7]);
        assert_eq!(count_of(&r.s).await["count"], json!(1));
    }

    /// A folder whose cache holds fewer rows than the server's count the sync
    /// recorded is `partial`: its gap is a floor. Rows at or past the
    /// recorded UIDNEXT (arrivals) do not stand in for old rows a backfill
    /// has not reached. A folder with no recorded count, or all its rows, is
    /// complete.
    #[tokio::test]
    async fn a_header_cache_short_of_the_server_count_is_partial() {
        let r = rig();
        let undated = |uids: &[u32]| uids.iter().map(|u| (*u, None)).collect::<Vec<(u32, Option<&str>)>>();
        cache_rows(&r.s, "INBOX", &undated(&[1, 2, 3]), json!({"syncTotalEmails": 10, "syncUidNext": 11}));
        cache_rows(&r.s, "Late", &undated(&[1, 2, 9]), json!({"syncTotalEmails": 3, "syncUidNext": 4}));
        cache_rows(&r.s, "Sent", &undated(&[1, 2]), json!({"syncTotalEmails": 2, "syncUidNext": 3}));
        cached(&r.s, "Work", [5]);
        in_vault(&r.s, "INBOX", &[1]);
        in_vault(&r.s, "Late", &[1, 2, 9]);
        in_vault(&r.s, "Sent", &[1, 2]);

        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(3), "{got}");
        assert_eq!(got["partial"], json!(true));
        assert_eq!(
            by_mailbox(&got),
            vec![("INBOX".to_string(), 2, true), ("Late".to_string(), 0, true), ("Work".to_string(), 1, false)]
        );
    }

    /// Two cached folders filed under one vault folder (`A/B`, `A_B`): a
    /// vault uid does not say whose message it is, so neither is counted and
    /// both are `partial`, never "all saved".
    #[tokio::test]
    async fn folders_sharing_one_vault_folder_are_unknown_not_counted() {
        let r = rig();
        cached(&r.s, "A/B", [1, 2]);
        cached(&r.s, "A_B", [3]);
        cached(&r.s, "INBOX", [1]);
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(1), "{got}");
        assert_eq!(got["partial"], json!(true));
        assert_eq!(by_mailbox(&got), vec![("A/B".to_string(), 0, true), ("A_B".to_string(), 0, true), ("INBOX".to_string(), 1, false)]);
    }

    /// The vault closed for a move (the store still open): the count still
    /// comes from the header cache, with the reason.
    #[tokio::test]
    async fn an_unreachable_vault_still_counts_from_the_header_cache_and_says_why() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=3);
        in_vault(&r.s, "INBOX", &[2]);
        r.s.vault_closed.store(true, Ordering::SeqCst);
        let got = count_of(&r.s).await;
        assert_eq!(got["count"], json!(2), "{got}");
        assert_eq!(got["vaultReachable"], json!(false));
        assert_eq!(got["reason"], json!(E_VAULT_UNAVAILABLE));
        assert_eq!(got["partial"], json!(false));
    }

    /// No header cache to count from: the vault unreachable since startup
    /// (its `custody.db` with it), or the store closed on a reachable vault.
    /// The count is `null` with a reason, never 0.
    #[tokio::test]
    async fn with_no_header_cache_the_count_is_unknown_and_says_why() {
        let (vault, app) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let gone = DaemonState::for_test(vault.path().to_path_buf(), app.path().to_path_buf(), false);
        let got = count_of(&gone).await;
        assert_eq!(
            got,
            json!({"count": null, "vaultReachable": false, "reason": E_VAULT_UNAVAILABLE, "partial": true, "byMailbox": []})
        );

        let r = rig();
        cached(&r.s, "INBOX", [1]);
        crate::custody::close(&r.s);
        let got = count_of(&r.s).await;
        assert_eq!(
            got,
            json!({"count": null, "vaultReachable": true, "reason": E_HEADER_CACHE_UNAVAILABLE, "partial": true, "byMailbox": []})
        );
    }

    /// Both routes refuse a request without an account as INVALID_PARAMS, and
    /// an account the header cache has never heard of as not found. An
    /// account known only by its folder list is known: it is missing nothing.
    #[tokio::test]
    async fn no_account_id_is_invalid_params_and_an_unknown_account_is_not_found() {
        let r = rig();
        for method in ["vault_gap_count", "vault_gap_save"] {
            let e = refused(handle_request_for_test(&r.s, method, json!({})).await);
            assert_eq!(e.code, ipc::INVALID_PARAMS, "{method}");
            assert!(e.message.contains("accountId"), "{method}: {}", e.message);
        }
        let e = refused(handle_request_for_test(&r.s, "vault_gap_count", json!({"accountId": "ghost"})).await);
        assert_eq!(e.code, ipc::INTERNAL_ERROR);
        assert!(e.message.starts_with(&format!("{E_ACCOUNT_NOT_FOUND}:")), "{}", e.message);
        let account_json = json!({"email": "ghost@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": "ghost", "accountJson": account_json})).await);
        assert!(e.message.starts_with(&format!("{E_ACCOUNT_NOT_FOUND}:")), "{}", e.message);
        assert!(r.s.backup_runs.lock().unwrap().is_empty(), "nothing started");

        cached(&r.s, "INBOX", [1]);
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT})).await);
        assert_eq!(e.code, ipc::INVALID_PARAMS);
        assert!(e.message.contains("accountJson"), "{}", e.message);
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": "not json"})).await);
        assert_eq!(e.code, ipc::INVALID_PARAMS);
        assert!(e.message.contains("Bad account JSON"), "{}", e.message);

        crate::custody::with_conn(&r.s, |c| cache::save_mailboxes(c, "listed", r#"{"mailboxes": []}"#)).unwrap();
        let got = ok(handle_request_for_test(&r.s, "vault_gap_count", json!({"accountId": "listed"})).await);
        assert_eq!(got["count"], json!(0));
        assert_eq!(got["partial"], json!(false));
    }

    /// A large folder read in pages of every size, edges included (a last
    /// page exactly full, then an empty one), gives the same gap: what a set
    /// difference gives, in order.
    #[tokio::test]
    async fn a_large_folder_counts_the_same_across_page_boundaries() {
        let r = rig();
        cached(&r.s, "INBOX", 1..=5000);
        let held: Vec<u32> = (1..=5000).filter(|u| u % 7 == 0).collect();
        in_vault(&r.s, "INBOX", &held);
        let expected: Vec<u32> = (1..=5000).filter(|u| u % 7 != 0).collect();
        for chunk in [1, 3, 999, 1000, 4999, 5000, 5001, CACHE_CHUNK] {
            let folders = gap(&r.s, ACCT, chunk, now_ms()).expect("the cache reads");
            assert_eq!(folders.len(), 1, "chunk {chunk}");
            assert_eq!(folders[0].missing, expected, "chunk {chunk}");
            assert!(!folders[0].partial, "chunk {chunk}");
        }
        assert_eq!(count_of(&r.s).await["count"], json!(expected.len()));
    }

    // ── "Save them now" ────────────────────────────────────────────────────

    fn folder(name: &str, uids: std::ops::RangeInclusive<u32>) -> Mailbox {
        let mut mb = Mailbox::new(name);
        for uid in uids {
            mb.add(Message::new(uid, raw(uid)));
        }
        mb
    }

    fn account_json(server: &MockImap) -> String {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        json!({"email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()}).to_string()
    }

    async fn save_now(s: &Arc<DaemonState>, server: &MockImap) -> RpcResponse {
        handle_request_for_test(s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": account_json(server)})).await
    }

    /// The uids the server was asked for a whole message, sorted: every
    /// `UID FETCH <uid> (... BODY.PEEK[])` the backup step sends.
    fn fetched(server: &MockImap) -> Vec<u32> {
        let mut uids: Vec<u32> = server
            .commands()
            .iter()
            .filter(|c| c.to_uppercase().contains("BODY.PEEK[]"))
            .filter_map(|c| {
                let words: Vec<&str> = c.split_whitespace().collect();
                let is_uid_fetch = words.get(1)?.eq_ignore_ascii_case("UID") && words.get(2)?.eq_ignore_ascii_case("FETCH");
                if is_uid_fetch { words.get(3)?.parse().ok() } else { None }
            })
            .collect();
        uids.sort_unstable();
        uids
    }

    /// The account's terminal `backup-progress` frame.
    async fn terminal(rx: &mut broadcast::Receiver<Arc<str>>) -> Value {
        let wait = async {
            loop {
                match rx.recv().await {
                    Ok(line) => {
                        let v: Value = serde_json::from_str(&line).unwrap();
                        let payload = &v["params"]["payload"];
                        if v["params"]["name"] == "backup-progress" && payload["account_id"] == ACCT && payload["active"] == json!(false) {
                            return payload.clone();
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(e) => panic!("event bus: {e}"),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait).await.expect("the save never sent its terminal frame")
    }

    /// The run lets go of its `backup_runs` entry right after its last frame.
    async fn released(s: &DaemonState) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while s.backup_runs.lock().unwrap().contains_key(ACCT) {
            assert!(Instant::now() < deadline, "the save never let go of its run");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The save fetches exactly the uids the count named, from both folders,
    /// as archived vault copies, and the count drops to 0. Run again, it
    /// fetches nothing: it recomputes the gap and finds none.
    #[tokio::test(flavor = "multi_thread")]
    async fn save_fetches_exactly_the_missing_uids_and_a_second_save_fetches_nothing() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=5)).mailbox(folder("Work", 10..=12)));
        let r = rig();
        cached(&r.s, "INBOX", 1..=5);
        cached(&r.s, "Work", 10..=12);
        in_vault(&r.s, "INBOX", &[2, 4]);
        assert_eq!(count_of(&r.s).await["count"], json!(6));
        let mut rx = r.s.events.subscribe();

        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": true}));
        let done = terminal(&mut rx).await;
        assert_eq!(done["completed_emails"], json!(6), "{done}");
        assert_eq!(done["errors"], json!(0), "{done}");
        assert_eq!(done["success"], json!(true));
        assert_eq!(done["cancelled"], json!(false));
        assert_eq!((done["completed_folders"].clone(), done["total_folders"].clone()), (json!(2), json!(2)));
        assert_eq!(fetched(&server), vec![1, 3, 5, 10, 11, 12]);
        let inbox = on_disk(&r.s, "INBOX");
        assert_eq!(inbox.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        for uid in [1, 3, 5] {
            assert!(inbox[&uid].contains('A'), "a saved copy is archived: uid {uid} {:?}", inbox[&uid]);
        }
        assert_eq!(on_disk(&r.s, "Work").into_keys().collect::<Vec<_>>(), vec![10, 11, 12]);
        released(&r.s).await;
        let after = count_of(&r.s).await;
        assert_eq!((after["count"].clone(), after["partial"].clone()), (json!(0), json!(false)), "{after}");

        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": true}));
        let again = terminal(&mut rx).await;
        assert_eq!(again["completed_emails"], json!(0), "{again}");
        assert_eq!(again["total_folders"], json!(0), "{again}");
        assert_eq!(fetched(&server), vec![1, 3, 5, 10, 11, 12], "nothing fetched the second time");
        released(&r.s).await;
    }

    /// The save never fetches what the download mode leaves on the server:
    /// Keep Recent (3 months) saves the fresh message, not the 2015 one.
    #[tokio::test(flavor = "multi_thread")]
    async fn save_leaves_what_the_download_mode_leaves_on_the_server() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=2)));
        let r = rig();
        mode(&r.s, json!({"fetchMode": "keepRecent", "localCacheDurationMonths": 3}));
        let fresh = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        cache_rows(&r.s, "INBOX", &[(1, Some(&fresh)), (2, Some("2015-01-01T00:00:00+00:00"))], json!({}));
        let mut rx = r.s.events.subscribe();

        ok(save_now(&r.s, &server).await);
        let done = terminal(&mut rx).await;
        assert_eq!(done["completed_emails"], json!(1), "{done}");
        assert_eq!(fetched(&server), vec![1]);
        released(&r.s).await;
        assert_eq!(count_of(&r.s).await["count"], json!(0));
    }

    /// One run per account. A second save while the first is still fetching
    /// (the first body fetch stalls 3 s) joins it and starts nothing; the
    /// existing `backup_cancel` stops the running one before its next folder.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_save_joins_the_running_one_and_backup_cancel_stops_it() {
        let server = MockImap::start(
            Scenario::new()
                .mailbox(folder("INBOX", 1..=3))
                .mailbox(folder("Work", 10..=12))
                .fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 1), Action::Delay(Duration::from_secs(3))),
        );
        let r = rig();
        cached(&r.s, "INBOX", 1..=3);
        cached(&r.s, "Work", 10..=12);
        let mut rx = r.s.events.subscribe();

        assert_eq!(ok(save_now(&r.s, &server).await)["started"], json!(true));
        let first = Arc::clone(r.s.backup_runs.lock().unwrap().get(ACCT).expect("registered before the reply"));
        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": false, "running": true}));
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &first), "the running save keeps its entry");

        let deadline = Instant::now() + Duration::from_secs(20);
        while server.count_commands("BODY.PEEK[]") == 0 {
            assert!(Instant::now() < deadline, "the first body fetch never came");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ok(handle_request_for_test(&r.s, "backup_cancel", json!({"accountId": ACCT})).await);
        let done = terminal(&mut rx).await;
        assert_eq!(done["cancelled"], json!(true), "{done}");
        assert_eq!(done["success"], json!(false), "{done}");
        assert!(fetched(&server).iter().all(|uid| *uid < 10), "Work never started: {:?}", fetched(&server));
        released(&r.s).await;
    }

    /// A backup already running for the account (the scheduler's) is joined:
    /// no connection, no fetch, and its entry is left exactly as it was.
    #[tokio::test]
    async fn a_save_while_a_backup_runs_for_the_account_starts_nothing() {
        let server = MockImap::start(Scenario::new().mailbox(folder("INBOX", 1..=2)));
        let r = rig();
        cached(&r.s, "INBOX", 1..=2);
        let backup = Arc::new(AtomicBool::new(false));
        r.s.backup_runs.lock().unwrap().insert(ACCT.to_string(), Arc::clone(&backup));

        assert_eq!(ok(save_now(&r.s, &server).await), json!({"runId": ACCT, "started": false, "running": true}));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(server.commands().is_empty(), "{:?}", server.commands());
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &backup));
        assert!(!backup.load(Ordering::SeqCst), "and it is not cancelled");
    }

    /// A save a scheduled backup displaced (`backup_run_account` put its own
    /// entry over the save's) emits no further frame, whose `active: false`
    /// would settle that backup early in the app, and stops. Its guard then
    /// leaves the backup's entry alone.
    #[tokio::test]
    async fn a_displaced_save_emits_nothing_more_and_stops() {
        let r = rig();
        let mut rx = r.s.events.subscribe();
        let run = crate::handlers::backup::claim_run(&r.s, ACCT).expect("no run yet");
        let frames = frames_while_owned(&r.s, ACCT, run.cancel());

        frames(crate::handlers::backup::failed_frame(ACCT, "while owned".into()));
        let line = rx.try_recv().expect("a frame while the run owns the account");
        assert!(line.contains("backup-progress") && line.contains("while owned"), "{line}");

        let backup = Arc::new(AtomicBool::new(false));
        r.s.backup_runs.lock().unwrap().insert(ACCT.to_string(), Arc::clone(&backup));
        frames(crate::handlers::backup::failed_frame(ACCT, "displaced".into()));
        assert!(matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Empty)), "no frame once displaced");
        assert!(run.cancel().load(Ordering::SeqCst), "the displaced save stops");
        assert!(!backup.load(Ordering::SeqCst), "the backup that took over is not stopped");

        drop(run);
        assert!(Arc::ptr_eq(r.s.backup_runs.lock().unwrap().get(ACCT).unwrap(), &backup));
    }

    /// An Outlook account is refused with its own code (the daemon holds no
    /// Graph token to fetch with), and so is a vault being moved: neither
    /// registers a run.
    #[tokio::test]
    async fn save_refuses_an_outlook_account_and_an_unavailable_vault() {
        let r = rig();
        cached(&r.s, "INBOX", [1]);
        let graph = json!({"email": "user@outlook.com", "imapHost": "outlook.office365.com", "oauth2Transport": "graph"}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": graph})).await);
        assert!(e.message.starts_with(&format!("{E_VAULT_GAP_GRAPH}:")), "{}", e.message);

        r.s.vault_closed.store(true, Ordering::SeqCst);
        let imap = json!({"email": "user@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": imap})).await);
        assert!(e.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", e.message);
        assert!(r.s.backup_runs.lock().unwrap().is_empty());
    }

    /// A drive unplugged after startup still passes the startup checks
    /// (`mail_dir_ok`, not closed): the missing root is what says so. The
    /// count reports it (with whatever the still-open store answers), and a
    /// save refuses rather than build the vault's folders on the boot volume.
    #[tokio::test]
    async fn a_vault_lost_since_startup_is_unreachable_and_a_save_refuses_it() {
        let r = rig();
        cached(&r.s, "INBOX", [1]);
        std::fs::remove_dir_all(&r.s.data_dir).unwrap();

        let got = count_of(&r.s).await;
        assert_eq!(got["vaultReachable"], json!(false), "{got}");
        assert_eq!(got["reason"], json!(E_VAULT_UNAVAILABLE), "{got}");

        let imap = json!({"email": "user@example.com", "imapHost": "127.0.0.1", "imapPort": 1}).to_string();
        let e = refused(handle_request_for_test(&r.s, "vault_gap_save", json!({"accountId": ACCT, "accountJson": imap})).await);
        assert!(e.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", e.message);
        assert!(r.s.backup_runs.lock().unwrap().is_empty());
        assert!(!r.s.data_dir.exists(), "nothing was created where the vault was");
    }
}
