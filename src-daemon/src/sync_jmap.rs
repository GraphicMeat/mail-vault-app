//! Account-level JMAP sync: `sync_jmap` (the engine's sync of a JMAP account,
//! `SyncEngine::do_sync`) and `delta_only` (the bridge's status RPCs run it
//! first, so `uidNext` and `highestModseq` are current).
//!
//! JMAP reports changes per account (`Email/changes`), not per mailbox, so
//! one run applies them to every mailbox the daemon tracks, under one lock
//! per account (`jmap\x01<account>` in the engine's `sync_locks`). The app
//! syncs INBOX and Sent at once; two runs reading one stored state would
//! apply the delta twice and announce its arrivals twice.
//!
//! - *Cached*: the mailbox has a header cache (a meta row or header rows).
//!   Header rows are written only there; a mailbox nobody opened stays cold.
//! - *Tracked*: cached, or its JMAP ledger has issued a uid. The delta issues
//!   uids for new members of a tracked mailbox and bumps its counter
//!   (`JmapMeta::bump`) on arrivals, flag changes and removals: that counter
//!   is the status RPC's `highestModseq`, which `syncProbe.js` compares first.
//! - *Cold* (no stored state, or `cannotCalculateChanges`): the requested
//!   mailbox and every cached one get their header rows rebuilt from the
//!   newest `COLD_PAGE`, and lose the rows whose email left. A cold run is a
//!   backfill and announces nothing. A requested mailbox with no header cache
//!   gets the same first fill after the delta.
//! - Never: a `cur/` file touched, a ledger row removed. The Email state
//!   lives in `JmapMeta` (custody.db meta rows) only.
//!
//! Every mailbox a run touched is published (`note_change`), the requested
//! one included: the run that applies an arrival is the only one that ever
//! sees it, and the app raises its banners from the change feed
//! (`useEmailScheduler` `onSyncChange`), never from a `sync.now` result.

use crate::handlers::common::{blocking, vault_root, with_vault_write};
use crate::imap::{EmailHeader, ImapConfig};
use crate::jmap_sessions::{in_mailbox, jmap_ledger_path, AccountJmap, JmapMeta, Mailboxes};
use crate::server::DaemonState;
use crate::sync_engine::{cache_io, SyncAccount, SyncEngine, SyncResult};
use mailvault_core::custody::{cache, Connection};
use mailvault_core::graph_ledger::{self, Ledger};
use mailvault_core::jmap::headers::{keywords_to_flags, to_header, HEADER_PROPS};
use mailvault_core::jmap::{EmailChanges, EmailsGot, JmapError};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use tracing::{info, warn};

/// The newest emails a cold run lists per mailbox (the IMAP cold page).
const COLD_PAGE: usize = 500;

/// The account-wide lock's key in the engine's `sync_locks`. Folder locks are
/// `<account>\x01<mailbox>`; the prefix keeps the two apart.
fn account_lock_key(account_id: &str) -> String {
    format!("jmap\x01{account_id}")
}

/// What one run changed in one mailbox.
#[derive(Default)]
struct Touch {
    /// Header rows written.
    written: usize,
    /// The deliveries among the new members (`is_arrival`), by uid.
    arrival_uids: Vec<u32>,
    /// Header rows whose flags were patched.
    flags: usize,
    /// Every uid the run changed here: what `JmapMeta::bump` logs.
    uids: BTreeSet<u32>,
}

struct Run {
    touched: BTreeMap<String, Touch>,
    /// The requested mailbox's path and server count, when one was asked for.
    requested: Option<(String, u32)>,
}

/// Sync a JMAP account, reported for `mailbox` (a path, or a role name such
/// as "Sent"). Runs inside `sync_account_with`, which already registered the
/// gate host, took the folder lock and set `SyncStatus::Syncing`.
///
/// `announce` is not consulted: a JMAP run always publishes what it touched
/// (module doc), so `announced` is set whenever there are arrivals and an
/// announcing caller never publishes them a second time.
pub async fn sync_jmap(engine: &SyncEngine, account: &SyncAccount, mailbox: &str, announce: bool) -> SyncResult {
    let _ = announce;
    let failed = |error: String| SyncResult {
        account_id: account.id.clone(),
        mailbox: mailbox.to_string(),
        new_emails: 0,
        arrivals: 0,
        updated_flags: 0,
        total_emails: 0,
        success: false,
        error: Some(error),
        offline: false,
        error_code: None,
        arrival_uids: Vec::new(),
        announced: false,
    };
    let Some(state) = engine.daemon_state() else {
        return failed("JMAP sync: the daemon state is not attached".to_string());
    };
    let config = &account.imap_config;
    let lock = engine.lock_for(&account_lock_key(&account.id)).await;
    let _account_guard = lock.lock().await;
    // An expired or revoked session: forget it and run once more on a fresh
    // connect, as the bridge's `answer_with_retry` does.
    let run = match run_once(&state, engine, config, &account.id, Some(mailbox)).await {
        Err(e) if is_auth_failure(&e) => {
            state.jmap.forget(config);
            run_once(&state, engine, config, &account.id, Some(mailbox)).await
        }
        other => other,
    };
    let run = match run {
        Ok(run) => run,
        Err(e) => return failed(e),
    };
    let Some((path, total)) = run.requested.clone() else {
        return failed(format!("E_JMAP_PROTOCOL: no mailbox {mailbox}"));
    };
    publish(engine, &account.id, &run);
    wake_workers(&state, &run);
    if let Err(e) = write_meta(&state, engine, config, &account.id, &path, total).await {
        return failed(e);
    }
    let mine = run.touched.get(&path);
    let arrival_uids = mine.map(|t| t.arrival_uids.clone()).unwrap_or_default();
    let result = SyncResult {
        account_id: account.id.clone(),
        mailbox: path.clone(),
        new_emails: mine.map_or(0, |t| t.written),
        arrivals: arrival_uids.len(),
        updated_flags: mine.map_or(0, |t| t.flags),
        total_emails: total,
        success: true,
        error: None,
        offline: false,
        error_code: None,
        announced: !arrival_uids.is_empty(),
        arrival_uids,
    };
    info!(
        "[sync] JMAP sync for {} ({}): {} new, {} arrivals, {} flag updates, {} mailboxes touched",
        account.email,
        path,
        result.new_emails,
        result.arrivals,
        result.updated_flags,
        run.touched.values().filter(|t| !t.uids.is_empty()).count()
    );
    result
}

/// The account's delta, for the bridge's status RPCs: afterwards the ledger
/// (`uidNext`) and the counter (`highestModseq`) of every tracked mailbox are
/// current. It publishes what it touched and writes no mailbox's cache meta,
/// so the app's probe still sees the counter move past its meta and syncs.
pub async fn delta_only(state: &Arc<DaemonState>, cfg: &ImapConfig, account_id: &str) -> Result<(), String> {
    let engine = &state.sync_engine;
    let lock = engine.lock_for(&account_lock_key(account_id)).await;
    let _account_guard = lock.lock().await;
    let run = run_once(state, engine, cfg, account_id, None).await?;
    publish(engine, account_id, &run);
    wake_workers(state, &run);
    Ok(())
}

fn is_auth_failure(e: &str) -> bool {
    e.starts_with(&format!("{}:", JmapError::Unauthorized.code()))
}

/// `note_change` for every mailbox the run changed, with its arrivals and
/// patched flags. Called after every write and the stored state, so a woken
/// app reads what changed.
fn publish(engine: &SyncEngine, account_id: &str, run: &Run) {
    for (path, touch) in run.touched.iter().filter(|(_, t)| !t.uids.is_empty()) {
        engine.note_change(account_id, path, touch.arrival_uids.len(), touch.flags);
    }
}

/// The workers a run's changes wake, for every mailbox it touched, not only
/// the requested one: one run applies the whole account's delta, and the
/// caller's own wakes (`handle_sync_now`, `jmap_push`) see only the
/// requested mailbox. Arrivals wake the hoarder; header rows written wake
/// Auto Tags (the signal `handle_sync_now` sends on `new_emails`).
fn wake_workers(state: &DaemonState, run: &Run) {
    if run.touched.values().any(|t| !t.arrival_uids.is_empty()) {
        state.hoarder_worker.wake();
    }
    if run.touched.values().any(|t| t.written > 0) {
        state.auto_tag_worker.wake();
    }
}

/// One run: the delta from the stored Email state (or the cold rebuild), the
/// counters bumped, the new state stored. Holds no lock itself: the callers
/// hold the account lock around it.
async fn run_once(
    state: &Arc<DaemonState>,
    engine: &SyncEngine,
    cfg: &ImapConfig,
    account_id: &str,
    wanted: Option<&str>,
) -> Result<Run, String> {
    let acct = state.jmap.get(cfg).await.map_err(|e| e.to_string())?;
    let boxes = acct.current().await.map_err(|e| e.to_string())?;
    let requested = match wanted {
        Some(w) => Some(resolve(&boxes, w).ok_or_else(|| format!("E_JMAP_PROTOCOL: no mailbox {w}"))?),
        None => None,
    };
    let jmap_account = acct.client.account_id().to_string();
    let cached = cached_mailboxes(state, account_id).await?;
    let mut bound = true;
    for path in &cached {
        let io = engine.cache_ctx(account_id, path);
        let config = cfg.clone();
        let seed = cache_io(&io, move |io| io.native_seed(&config)).await?;
        let identity = mailvault_core::imap::NativeHeaderIdentity::new(cfg, account_id, path, Some(1));
        if !seed.matches(&identity) { bound = false; }
    }
    let stored = {
        let (aid, ja) = (account_id.to_string(), jmap_account.clone());
        custody_read(state, move |c| Ok(JmapMeta::email_state(c, &aid, &ja))).await?
    };
    let changes = match stored.filter(|_| bound) {
        None => None,
        Some(since) => match acct.client.email_changes(&since).await {
            Ok(changes) => Some(changes),
            Err(JmapError::CannotCalculateChanges) => {
                warn!("[jmap] {}: cannot calculate changes since {}: rebuilding the header cache", account_id, since);
                None
            }
            Err(e) => return Err(e.to_string()),
        },
    };
    let mut touched: BTreeMap<String, Touch> = BTreeMap::new();
    let new_state = match changes {
        Some(changes) => {
            apply_delta(state, engine, &acct, cfg, account_id, &boxes, &cached, &changes, &mut touched).await?;
            // A requested mailbox with no header cache yet gets its first
            // fill. The account's state stays the delta's.
            if let Some((path, _)) = requested.as_ref().filter(|(p, _)| !cached.contains(p)) {
                rebuild(state, engine, &acct, cfg, account_id, &boxes, path, &mut touched).await?;
            }
            changes.new_state
        }
        None => {
            // Taken before the listings: a message that lands while they run
            // is replayed by the next delta (and found written), never lost.
            let before = acct.client.email_state().await.map_err(|e| e.to_string())?;
            let mut targets: BTreeSet<String> = cached.iter().filter(|p| boxes.ids.contains_key(*p)).cloned().collect();
            if let Some((path, _)) = &requested {
                targets.insert(path.clone());
            }
            for path in &targets {
                rebuild(state, engine, &acct, cfg, account_id, &boxes, path, &mut touched).await?;
            }
            before
        }
    };
    bump(state, account_id, &touched).await?;
    let (aid, ja) = (account_id.to_string(), jmap_account);
    custody_write(state, move |c| JmapMeta::set_email_state(c, &aid, &ja, &new_state)).await?;
    Ok(Run { touched, requested })
}

/// `wanted`'s path in this account and its server count: the path itself,
/// else the mailbox whose role it names ("Sent" is role sent), as the IMAP
/// sync resolves a generic name.
fn resolve(boxes: &Mailboxes, wanted: &str) -> Option<(String, u32)> {
    let path = if boxes.ids.contains_key(wanted) {
        wanted.to_string()
    } else {
        let role = wanted.trim();
        let id = &boxes.list.iter().find(|m| m.role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(role)))?.id;
        boxes.ids.iter().find(|(_, v)| *v == id)?.0.clone()
    };
    let id = boxes.ids.get(&path)?;
    let total = boxes.list.iter().find(|m| &m.id == id).map_or(0, |m| m.total_emails);
    Some((path, total))
}

/// `f` on the custody connection, on a blocking thread.
async fn custody_read<T: Send + 'static>(
    state: &Arc<DaemonState>,
    f: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let st = Arc::clone(state);
    blocking(move || crate::custody::with_conn(&st, f)).await?
}

/// `custody_read` for a write: under the vault gate (`with_vault_write`), so a
/// vault close drains it like every other vault write.
async fn custody_write<T: Send + 'static>(
    state: &Arc<DaemonState>,
    f: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let st = Arc::clone(state);
    blocking(move || with_vault_write(&st, |_| crate::custody::with_conn(&st, f))).await?
}

/// Every mailbox of the account with a header cache: a meta row (a synced
/// folder, even an empty one) or header rows. One index seek per mailbox.
async fn cached_mailboxes(state: &Arc<DaemonState>, account_id: &str) -> Result<HashSet<String>, String> {
    let aid = account_id.to_string();
    custody_read(state, move |c| {
        let mut out: HashSet<String> = cache::mailboxes_with_meta(c, &aid)?.into_iter().collect();
        let mut after: Option<String> = None;
        while let Some(path) = cache::next_mailbox_with_headers(c, &aid, after.as_deref())? {
            out.insert(path.clone());
            after = Some(path);
        }
        Ok(out)
    })
    .await
}

async fn load_ledger(state: &Arc<DaemonState>, account_id: &str, path: &str) -> Result<Ledger, String> {
    let file = jmap_ledger_path(&vault_root(state)?, account_id, path);
    blocking(move || graph_ledger::load(&file)).await?
}

fn email_id(email: &Value) -> String {
    email["id"].as_str().unwrap_or_default().to_string()
}

/// A delivery: new this delta (`created`), into the inbox or a user folder
/// (no role), not a draft, and not put there by this daemon (`is_own`).
fn is_arrival(email: &Value, id: &str, role: Option<&str>, created: &HashSet<&str>, own: bool) -> bool {
    let inbox_or_folder = role.is_none() || role.is_some_and(|r| r.eq_ignore_ascii_case("inbox"));
    let draft = email["keywords"]
        .as_object()
        .is_some_and(|k| k.iter().any(|(name, on)| name.eq_ignore_ascii_case("$draft") && on.as_bool() == Some(true)));
    created.contains(id) && inbox_or_folder && !draft && !own
}

/// Every mailbox as (path, id, role), the inbox first: an email that lands in
/// the inbox and a folder at once is announced once, as an inbox arrival.
fn by_priority(boxes: &Mailboxes) -> Vec<(String, String, Option<String>)> {
    let role_of: HashMap<&str, Option<String>> = boxes.list.iter().map(|m| (m.id.as_str(), m.role.clone())).collect();
    let mut out: Vec<(String, String, Option<String>)> = boxes
        .ids
        .iter()
        .map(|(path, id)| (path.clone(), id.clone(), role_of.get(id.as_str()).cloned().flatten()))
        .collect();
    out.sort_by_key(|(path, _, role)| (!role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case("inbox")), path.clone()));
    out
}

/// The delta, every tracked mailbox. `notFound` ids count as destroyed.
#[allow(clippy::too_many_arguments)]
async fn apply_delta(
    state: &Arc<DaemonState>,
    engine: &SyncEngine,
    acct: &AccountJmap,
    cfg: &ImapConfig,
    account_id: &str,
    boxes: &Mailboxes,
    cached: &HashSet<String>,
    changes: &EmailChanges,
    touched: &mut BTreeMap<String, Touch>,
) -> Result<(), String> {
    let mut seeds = HashMap::new();
    for path in cached {
        let io = engine.cache_ctx(account_id, path);
        seeds.insert(path.clone(), engine.prepare_native_seed(&io, cfg).await?);
    }
    let wanted: Vec<String> = changes.created.iter().chain(&changes.updated).cloned().collect();
    let got: EmailsGot = if wanted.is_empty() {
        EmailsGot::default()
    } else {
        acct.client.get_emails(&wanted, HEADER_PROPS).await.map_err(|e| e.to_string())?
    };
    let mut gone: HashSet<String> = changes.destroyed.iter().cloned().collect();
    gone.extend(got.not_found);
    let mut emails = got.list;
    if emails.is_empty() && gone.is_empty() {
        return Ok(());
    }
    // Oldest first: the uids one delta issues follow arrival, as a listing's do.
    emails.sort_by_key(|e| (e["receivedAt"].as_str().unwrap_or_default().to_string(), email_id(e)));
    let created: HashSet<&str> = changes.created.iter().map(String::as_str).collect();
    let mut announced: HashSet<String> = HashSet::new();
    for (path, mailbox_id, role) in by_priority(boxes) {
        let is_cached = cached.contains(&path);
        let ledger = load_ledger(state, account_id, &path).await?;
        if !is_cached && ledger.is_empty() {
            continue;
        }
        let here = Here { path: &path, mailbox_id: &mailbox_id, role: role.as_deref(), cached: is_cached };
        let touch = apply_to_mailbox(state, engine, acct, cfg, account_id, &here, ledger, &emails, &gone, &created, &mut announced, seeds.get(&path)).await?;
        let entry = touched.entry(path.clone()).or_default();
        entry.written += touch.written;
        entry.arrival_uids.extend(touch.arrival_uids);
        entry.flags += touch.flags;
        entry.uids.extend(touch.uids);
    }
    Ok(())
}

/// The mailbox `apply_to_mailbox` works on.
struct Here<'a> {
    path: &'a str,
    mailbox_id: &'a str,
    role: Option<&'a str>,
    cached: bool,
}

/// The delta in one tracked mailbox:
/// 1. A member with nothing here yet (no header row in a cached mailbox, no
///    ledger uid in one tracked by its ledger alone) gets its uid from the
///    ledger (an id seen before keeps its uid) and, when cached, a header row.
/// 2. A header row whose email is destroyed or left the mailbox is removed;
///    the ledger row stays. In a mailbox tracked by its ledger alone, a
///    destroyed email's uid moves the counter; an email that left does not
///    (the ledger cannot tell when it left, and would move it on every later
///    change to that email).
/// 3. A cached row whose flags differ from the keywords is patched. In a
///    mailbox tracked by its ledger alone, every changed member moves the
///    counter: `imap_fetch_changed_flags` answers its flags.
#[allow(clippy::too_many_arguments)]
async fn apply_to_mailbox(
    state: &Arc<DaemonState>,
    engine: &SyncEngine,
    acct: &AccountJmap,
    cfg: &ImapConfig,
    account_id: &str,
    here: &Here<'_>,
    ledger: Ledger,
    emails: &[Value],
    gone: &HashSet<String>,
    created: &HashSet<&str>,
    announced: &mut HashSet<String>,
    seed: Option<&crate::sync_engine::NativeBatchSeed>,
) -> Result<Touch, String> {
    // id -> uid as the ledger issued it before this run (the lower uid of a
    // duplicate, as `graph_ledger::allocate` resolves one).
    let mut uid_of: HashMap<String, u32> = HashMap::new();
    for (uid, id) in ledger {
        uid_of.entry(id).or_insert(uid);
    }
    let by_id: HashMap<String, &Value> = emails.iter().map(|e| (email_id(e), e)).collect();
    let named: Vec<(String, u32)> = by_id
        .keys()
        .chain(gone.iter())
        .filter_map(|id| uid_of.get(id).map(|uid| (id.clone(), *uid)))
        .collect();
    // The header rows those uids have here, with their flags.
    let rows: HashMap<u32, BTreeSet<String>> = if here.cached && !named.is_empty() {
        let (aid, mb) = (account_id.to_string(), here.path.to_string());
        let uids: Vec<u32> = named.iter().map(|(_, uid)| *uid).collect();
        custody_read(state, move |c| cache::load_by_uids(c, &aid, &mb, &uids))
            .await?
            .into_iter()
            .filter_map(|row| {
                let uid = row["uid"].as_u64().and_then(|u| u32::try_from(u).ok())?;
                let flags = row["flags"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                Some((uid, flags))
            })
            .collect()
    } else {
        HashMap::new()
    };
    let io = engine.cache_ctx(account_id, here.path).for_source(cfg, Some(1));
    let mut touch = Touch::default();

    // 1. New here.
    let fresh: Vec<&Value> = emails
        .iter()
        .filter(|e| in_mailbox(e, here.mailbox_id))
        .filter(|e| match uid_of.get(&email_id(e)) {
            None => true,
            Some(uid) => here.cached && !rows.contains_key(uid),
        })
        .collect();
    if !fresh.is_empty() {
        let ids: Vec<String> = fresh.iter().map(|e| email_id(e)).collect();
        let uids = acct.ids_to_uids(state, account_id, here.path, &ids).await?;
        let mut headers: Vec<EmailHeader> = Vec::new();
        for (email, uid) in fresh.iter().zip(uids) {
            let id = email_id(email);
            let own = state.jmap.is_own(cfg, &id);
            if is_arrival(email, &id, here.role, created, own) && announced.insert(id) {
                touch.arrival_uids.push(uid);
            }
            touch.uids.insert(uid);
            if here.cached {
                headers.push(to_header(email, uid));
            }
        }
        touch.written = headers.len();
        if !headers.is_empty() {
            let seed = seed.ok_or("errors.bulkIdentityUncertain")?.clone();
            cache_io(&io, move |io| io.write_bound_headers(&headers, &seed, Some(1))).await?;
        }
    }

    // 2 and 3. Known here.
    let mut removed: Vec<u32> = Vec::new();
    let mut patches: Vec<(u32, Vec<String>)> = Vec::new();
    for (id, uid) in &named {
        let email = by_id.get(id).copied();
        let member = email.is_some_and(|e| in_mailbox(e, here.mailbox_id));
        if !here.cached {
            if gone.contains(id) || member {
                touch.uids.insert(*uid);
            }
            continue;
        }
        if !member {
            if rows.contains_key(uid) {
                removed.push(*uid);
            }
            continue;
        }
        let (Some(email), Some(held)) = (email, rows.get(uid)) else { continue };
        let flags = keywords_to_flags(&email["keywords"]);
        if flags.iter().cloned().collect::<BTreeSet<String>>() != *held {
            patches.push((*uid, flags));
        }
    }
    if !removed.is_empty() {
        let uids = removed.clone();
        cache_io(&io, move |io| io.remove(&uids)).await?;
        touch.uids.extend(removed);
    }
    if !patches.is_empty() {
        touch.uids.extend(patches.iter().map(|(uid, _)| *uid));
        touch.flags = cache_io(&io, move |io| io.patch_flags(&patches)).await?;
    }
    Ok(touch)
}

/// A mailbox's header rows from the server's newest `COLD_PAGE`, and the
/// cached rows whose email is no longer here taken away. Uids come from the
/// ledger (an id it knows keeps its uid); `cur/` and the ledger lose nothing.
async fn rebuild(
    state: &Arc<DaemonState>,
    engine: &SyncEngine,
    acct: &AccountJmap,
    cfg: &ImapConfig,
    account_id: &str,
    boxes: &Mailboxes,
    path: &str,
    touched: &mut BTreeMap<String, Touch>,
) -> Result<(), String> {
    let io = engine.cache_ctx(account_id, path).for_source(cfg, Some(1));
    let seed = engine.prepare_native_seed(&io, cfg).await?;
    let mailbox_id = boxes.ids.get(path).cloned().ok_or_else(|| format!("E_JMAP_PROTOCOL: no mailbox {path}"))?;
    let (ids, _) = acct.client.query_mailbox(&mailbox_id, 0, COLD_PAGE).await.map_err(|e| e.to_string())?;
    // A page lists newest first; the ledger takes it oldest first, so the
    // uids one listing issues follow arrival.
    let oldest_first: Vec<String> = ids.iter().rev().cloned().collect();
    let uids = acct.ids_to_uids(state, account_id, path, &oldest_first).await?;
    let uid_of: HashMap<String, u32> = oldest_first.into_iter().zip(uids).collect();
    let got = if ids.is_empty() {
        Vec::new()
    } else {
        acct.client.get_emails(&ids, HEADER_PROPS).await.map_err(|e| e.to_string())?.list
    };
    let headers: Vec<EmailHeader> = got
        .iter()
        .filter(|e| in_mailbox(e, &mailbox_id))
        .filter_map(|e| Some(to_header(e, *uid_of.get(e["id"].as_str()?)?)))
        .collect();
    let listed: BTreeSet<u32> = headers.iter().map(|h| h.uid).collect();
    let held = cache_io(&io, |io| Ok(io.cached_uids())).await?;
    let older: Vec<u32> = held.into_iter().filter(|uid| !listed.contains(uid)).collect();
    // Rows the page does not name stay while their email is still here: one
    // `Email/get` re-checks them (`uid_to_id` with `recheck`). Never the page
    // alone: the app pages older mail into the same cache.
    let stale: Vec<u32> = if older.is_empty() {
        Vec::new()
    } else {
        acct.uid_to_id(state, account_id, path, &older, true)
            .await?
            .into_iter()
            .filter(|(_, id)| id.is_none())
            .map(|(uid, _)| uid)
            .collect()
    };
    let written = headers.len();
    cache_io(&io, move |io| io.write_bound_headers(&headers, &seed, Some(1))).await?;
    if !stale.is_empty() {
        let uids = stale.clone();
        cache_io(&io, move |io| io.remove(&uids)).await?;
    }
    let touch = touched.entry(path.to_string()).or_default();
    touch.written += written;
    touch.uids.extend(listed);
    touch.uids.extend(stale);
    Ok(())
}

/// `JmapMeta::bump` for every mailbox the run changed, in one custody step.
async fn bump(state: &Arc<DaemonState>, account_id: &str, touched: &BTreeMap<String, Touch>) -> Result<(), String> {
    let work: Vec<(String, Vec<u32>)> = touched
        .iter()
        .filter(|(_, t)| !t.uids.is_empty())
        .map(|(path, t)| (path.clone(), t.uids.iter().copied().collect()))
        .collect();
    if work.is_empty() {
        return Ok(());
    }
    let aid = account_id.to_string();
    custody_write(state, move |c| {
        for (path, uids) in &work {
            JmapMeta::bump(c, &aid, path, uids)?;
        }
        Ok(())
    })
    .await
}

/// The requested mailbox's cache meta, as the IMAP sync writes it: the server
/// count, `uidValidity` 1 (ledger uids are never renumbered), the ledger's
/// `uidNext` and the mailbox's counter, so `syncProbe.js` compares them like
/// for like with `imap_check_mailbox_status`.
async fn write_meta(state: &Arc<DaemonState>, engine: &SyncEngine, config: &ImapConfig, account_id: &str, path: &str, total: u32) -> Result<(), String> {
    let ledger = load_ledger(state, account_id, path).await?;
    let uid_next = ledger.keys().next_back().map_or(1, |uid| uid.saturating_add(1));
    let (aid, mb) = (account_id.to_string(), path.to_string());
    let modseq = custody_read(state, move |c| Ok(JmapMeta::modseq(c, &aid, &mb))).await?;
    let io = engine.cache_ctx(account_id, path).for_source(config, Some(1));
    let identity = mailvault_core::imap::NativeHeaderIdentity::new(config, account_id, path, Some(1));
    cache_io(&io, move |io| io.write_meta_for(total, Some(1), Some(uid_next), Some(modseq), None, Some(total), Some(&identity))).await
}

#[cfg(test)]
mod tests {
    use crate::handlers::common::vault_root;
    use crate::jmap_sessions::{jmap_ledger_path, JmapMeta};
    use crate::server::DaemonState;
    use crate::sync_engine::{SyncAccount, SyncResult};
    use mailvault_core::custody::cache;
    use mailvault_core::graph_ledger;
    use mailvault_core::jmap::ImportResult;
    use mock_jmap::{Fault, Limits, MockJmap, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::sync::Arc;

    // ── helpers ────────────────────────────────────────────────────────────

    /// A plain message with a Message-ID of `<{id}@x>`.
    fn email(id: &str, subject: &str, received_at: &str) -> ScenarioEmail {
        ScenarioEmail {
            id: id.into(),
            raw: format!("Message-ID: <{id}@x>\r\nSubject: {subject}\r\n\r\nbody of {subject}"),
            keywords: vec![],
            received_at: received_at.into(),
            also_in: vec![],
        }
    }

    /// One account: Inbox (e1 seen, e2), Work (e1 as a second label), Sent
    /// (role sent, empty), Trash. Also lets this process send credentials to
    /// the mock's loopback http.
    fn scenario() -> Scenario {
        mailvault_core::jmap::base::allow_loopback_for_tests();
        let mut e1 = email("e1", "one", "2026-10-01T10:00:00Z");
        e1.keywords = vec!["$seen".into()];
        e1.also_in = vec!["mb-work".into()];
        let e2 = email("e2", "two", "2026-10-02T10:00:00Z");
        let mailbox = |id: &str, name: &str, role: Option<&str>, emails: Vec<ScenarioEmail>| ScenarioMailbox {
            id: id.into(),
            name: name.into(),
            parent_id: None,
            role: role.map(str::to_string),
            emails,
        };
        Scenario {
            accounts: vec![ScenarioAccount {
                username: "alice@example.test".into(),
                password: "pw".into(),
                token: Some("tok".into()),
                identities: vec![("alice@example.test".into(), "Alice".into())],
                mailboxes: vec![
                    mailbox("mb-inbox", "Inbox", Some("inbox"), vec![e1, e2]),
                    mailbox("mb-work", "Work", None, vec![]),
                    mailbox("mb-sent", "Sent", Some("sent"), vec![]),
                    mailbox("mb-trash", "Trash", Some("trash"), vec![]),
                ],
            }],
            faults: vec![],
            limits: Limits::default(),
        }
    }

    /// The JMAP account as the app sends it (Basic: the address + "pw").
    fn account_json(m: &MockJmap) -> Value {
        json!({
            "id": "acct-1",
            "email": "alice@example.test",
            "authType": "password",
            "jmapSessionUrl": m.session_url(),
            "jmapAuth": "basic",
            "password": "pw",
            "imapHost": "127.0.0.1",
        })
    }

    fn sync_account(config: Value) -> SyncAccount {
        serde_json::from_value(json!({"id": "acct-1", "email": "alice@example.test", "imapConfig": config})).unwrap()
    }

    /// A daemon state on a scratch vault (vault root = data dir), and the mock.
    async fn setup() -> (tempfile::TempDir, Arc<DaemonState>, MockJmap, SyncAccount) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        let m = MockJmap::start(scenario());
        let account = sync_account(account_json(&m));
        (dir, state, m, account)
    }

    /// A local port that counts as an IMAP server: anything that dials
    /// `imapHost:imapPort` lands in its backlog.
    fn imap_trap() -> (std::net::TcpListener, u16) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    async fn sync(state: &Arc<DaemonState>, account: &SyncAccount, mailbox: &str) -> SyncResult {
        let r = state.sync_engine.sync_account(account, mailbox).await;
        assert!(r.success, "sync {mailbox}: {:?}", r.error);
        r
    }

    /// The mailbox's header rows, by uid.
    fn rows(state: &Arc<DaemonState>, mailbox: &str) -> BTreeMap<u32, Value> {
        crate::custody::with_conn(state, |c| cache::all_headers(c, "acct-1", mailbox))
            .unwrap()
            .into_iter()
            .map(|row| (row["uid"].as_u64().unwrap() as u32, row))
            .collect()
    }

    fn ledger(state: &Arc<DaemonState>, mailbox: &str) -> graph_ledger::Ledger {
        graph_ledger::load(&jmap_ledger_path(&vault_root(state).unwrap(), "acct-1", mailbox)).unwrap()
    }

    fn uid_of(state: &Arc<DaemonState>, mailbox: &str, id: &str) -> u32 {
        ledger(state, mailbox).into_iter().find(|(_, v)| v == id).map(|(uid, _)| uid).unwrap()
    }

    /// Write a vault copy of `uid` by hand, as an opened message leaves one.
    fn vault_file(state: &Arc<DaemonState>, mailbox: &str, uid: u32) -> std::path::PathBuf {
        let cur = mailvault_core::vault_files::cur_path(&vault_root(state).unwrap(), "acct-1", mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        let file = cur.join(format!("{uid}:2,S.eml"));
        std::fs::write(&file, b"Message-ID: <e1@x>\r\n\r\nkept").unwrap();
        file
    }

    // ── the brief's list ───────────────────────────────────────────────────

    #[tokio::test]
    async fn cold_sync_fills_only_the_requested_mailbox_without_announcing() {
        let (_dir, state, m, _) = setup().await;
        // The JMAP sync never reaches the IMAP pool: `imapHost:imapPort` is a
        // trap that must stay untouched.
        let (trap, port) = imap_trap();
        let mut config = account_json(&m);
        config["imapPort"] = json!(port);
        let account = sync_account(config);
        let gen0 = state.sync_engine.change_gen();
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!(r.arrivals, 0, "a cold fill is a backfill");
        assert_eq!(r.new_emails, 2);
        assert_eq!(r.total_emails, 2);
        assert_eq!(r.mailbox, "INBOX");
        let inbox = rows(&state, "INBOX");
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[&uid_of(&state, "INBOX", "e1")]["messageId"], json!("<e1@x>"));
        let (work_rows, work_meta, stored) = crate::custody::with_conn(&state, |c| {
            Ok((
                cache::count(c, "acct-1", "Work")?,
                cache::load_meta(c, "acct-1", "Work")?,
                JmapMeta::email_state(c, "acct-1", "acc1"),
            ))
        })
        .unwrap();
        assert_eq!((work_rows, work_meta), (0, None), "Work has no header cache");
        assert!(stored.is_some(), "the account's Email state is stored");
        let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
        assert!(records.iter().all(|r| r.new_emails == 0), "nothing announced: {records:?}");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    #[tokio::test]
    async fn delta_sync_announces_new_arrival_once() {
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        let gen0 = state.sync_engine.change_gen();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let r = sync(&state, &account, "INBOX").await;
        let e9 = uid_of(&state, "INBOX", "e9");
        assert_eq!((r.arrivals, r.new_emails, r.arrival_uids.clone()), (1, 1, vec![e9]));
        assert_eq!(rows(&state, "INBOX")[&e9]["messageId"], json!("<e9@x>"));
        let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!((records[0].mailbox.as_str(), records[0].new_emails), ("INBOX", 1));
        let again = sync(&state, &account, "INBOX").await;
        assert_eq!((again.arrivals, again.new_emails), (0, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_inbox_and_sent_syncs_apply_the_delta_once() {
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        sync(&state, &account, "Sent").await;
        let gen0 = state.sync_engine.change_gen();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let (a, b) = tokio::join!(
            state.sync_engine.sync_account(&account, "INBOX"),
            state.sync_engine.sync_account(&account, "Sent"),
        );
        assert!(a.success && b.success, "{:?} {:?}", a.error, b.error);
        let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
        let announced: Vec<_> = records.iter().filter(|r| r.new_emails > 0).collect();
        assert_eq!(announced.len(), 1, "{records:?}");
        assert_eq!((announced[0].mailbox.as_str(), announced[0].new_emails), ("INBOX", 1));
        assert_eq!(rows(&state, "INBOX").values().filter(|r| r["messageId"] == json!("<e9@x>")).count(), 1);
    }

    #[tokio::test]
    async fn own_imports_are_not_arrivals() {
        let (_dir, state, _m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        let gen0 = state.sync_engine.change_gen();
        let raw = b"Message-ID: <mine@x>\r\nSubject: mine\r\n\r\nbody";
        let imported = state.jmap.import_raw(&account.imap_config, raw, "mb-inbox", &["$seen".to_string()], None).await.unwrap();
        let ImportResult::Created(imported) = imported else { panic!("expected a new email, got {imported:?}") };
        assert!(state.jmap.is_own(&account.imap_config, &imported.id));
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!((r.arrivals, r.new_emails), (0, 1), "written, not announced");
        assert!(rows(&state, "INBOX").values().any(|row| row["messageId"] == json!("<mine@x>")));
        let (_, records) = state.sync_engine.wait_changes(gen0, 0).await;
        assert!(records.iter().all(|r| r.new_emails == 0), "{records:?}");
    }

    #[tokio::test]
    async fn removing_label_drops_only_that_mailbox_row() {
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        sync(&state, &account, "Work").await;
        let (inbox_uid, work_uid) = (uid_of(&state, "INBOX", "e1"), uid_of(&state, "Work", "e1"));
        assert!(rows(&state, "Work").contains_key(&work_uid), "Work's first fill");
        m.mutate(|s| s.remove_from_mailbox("acc1", "e1", "mb-work"));
        sync(&state, &account, "INBOX").await;
        assert!(!rows(&state, "Work").contains_key(&work_uid), "the Work row is gone");
        assert_eq!(ledger(&state, "Work").get(&work_uid).map(String::as_str), Some("e1"), "its ledger row stays");
        assert!(rows(&state, "INBOX").contains_key(&inbox_uid), "INBOX keeps e1");
        m.mutate(|s| s.add_to_mailbox("acc1", "e1", "mb-work"));
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!(r.arrivals, 0, "a label added back is not a delivery");
        assert_eq!(rows(&state, "Work")[&work_uid]["messageId"], json!("<e1@x>"), "the same Work uid as before");
    }

    #[tokio::test]
    async fn keyword_change_patches_flags() {
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        let e1 = uid_of(&state, "INBOX", "e1");
        m.mutate(|s| s.set_keywords("acc1", "e1", &["$seen", "$flagged"]));
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!(r.updated_flags, 1);
        let flags = rows(&state, "INBOX")[&e1]["flags"].clone();
        assert!(flags.as_array().unwrap().contains(&json!("\\Flagged")), "{flags}");
        assert!(flags.as_array().unwrap().contains(&json!("\\Seen")), "{flags}");
    }

    #[tokio::test]
    async fn cannot_calculate_changes_rebuilds_without_touching_vault_files() {
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        let e1 = uid_of(&state, "INBOX", "e1");
        let file = vault_file(&state, "INBOX", e1);
        m.mutate(|s| {
            s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z"));
            s.faults.push(Fault::CannotCalculateChanges);
        });
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!(r.arrivals, 0, "a rebuild announces nothing");
        assert!(file.exists(), "the vault copy is untouched");
        assert_eq!(uid_of(&state, "INBOX", "e1"), e1, "e1 keeps its uid");
        let inbox = rows(&state, "INBOX");
        assert!(inbox.contains_key(&e1), "{inbox:?}");
        assert!(inbox.contains_key(&uid_of(&state, "INBOX", "e2")));
        assert!(inbox.contains_key(&uid_of(&state, "INBOX", "e9")), "the rebuild lists what came in");
    }

    #[tokio::test]
    async fn destroyed_email_leaves_vault_copy() {
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        sync(&state, &account, "Work").await;
        let (e1, work_e1) = (uid_of(&state, "INBOX", "e1"), uid_of(&state, "Work", "e1"));
        let file = vault_file(&state, "INBOX", e1);
        m.mutate(|s| s.destroy_email("acc1", "e1"));
        sync(&state, &account, "INBOX").await;
        assert!(!rows(&state, "INBOX").contains_key(&e1), "INBOX row gone");
        assert!(!rows(&state, "Work").contains_key(&work_e1), "Work row gone");
        assert!(file.exists(), "the vault copy stays");
        assert_eq!(ledger(&state, "INBOX").get(&e1).map(String::as_str), Some("e1"), "the ledger row stays");
    }

    // ── engine wiring ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn jmap_sync_registers_the_session_host_on_443() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test_with_probe(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            true,
            Arc::new(|| Box::pin(async { false })),
        );
        assert!(!state.net.note_failure("network is unreachable").await, "the gate is shut");
        let account = sync_account(json!({
            "id": "acct-1",
            "email": "alice@example.test",
            "authType": "password",
            "jmapSessionUrl": "https://jmap.example.test/jmap/session",
            "jmapAuth": "bearer",
            "password": "tok",
            "imapHost": "jmap.example.test",
        }));
        let r = state.sync_engine.sync_account(&account, "INBOX").await;
        assert!(r.offline, "{r:?}");
        assert_eq!(state.net.registered_hosts(), vec![("jmap.example.test".to_string(), 443)]);
    }

    #[tokio::test]
    async fn backfill_never_dials_imap_for_a_jmap_account() {
        let (_dir, state, m, _) = setup().await;
        let (trap, port) = imap_trap();
        let mut config = account_json(&m);
        config["imapPort"] = json!(port);
        let account = sync_account(config);
        // Bounded: without the guard the pool dials the trap and then waits
        // for a greeting that never comes.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), state.sync_engine.backfill_mailbox(&account, "INBOX")).await;
        assert!(trap.accept().is_err(), "no IMAP dial");
        assert!(m.requests().is_empty(), "and nothing over JMAP either");
    }

    /// `imap_check_mailbox_status` through the bridge.
    async fn status(state: &Arc<DaemonState>, m: &MockJmap) -> Value {
        let params = json!({"account": account_json(m), "mailbox": "INBOX"});
        crate::handlers::jmap_bridge::intercept(state, "imap_check_mailbox_status", &json!(1), &params)
            .await
            .expect("intercepted")
            .result
            .expect("a status")
    }

    #[tokio::test]
    async fn status_probe_reuses_the_mailbox_list_while_nothing_changed() {
        let (_dir, state, m, _) = setup().await;
        let first = status(&state, &m).await;
        let gets = m.count_calls("Mailbox/get");
        let second = status(&state, &m).await;
        assert_eq!(first, second);
        assert_eq!(m.count_calls("Mailbox/get"), gets, "no Mailbox/get while nothing changed");
        assert!(m.count_calls("Mailbox/changes") >= 1);
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let third = status(&state, &m).await;
        assert_eq!(third["exists"], json!(3), "a count that moved is fetched");
    }

    /// An arrival in a cached mailbox other than the requested one wakes the
    /// hoarder (Task 9c): one run applies the whole account's delta, and
    /// `handle_sync_now` sees only the requested mailbox's arrivals.
    #[tokio::test]
    async fn jmap_an_arrival_in_any_cached_mailbox_wakes_the_hoarder() {
        use futures::FutureExt;
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        sync(&state, &account, "Work").await;
        let woken = || state.hoarder_worker.notify.notified().now_or_never().is_some();
        let _ = woken();
        let quiet = sync(&state, &account, "INBOX").await;
        assert_eq!(quiet.arrivals, 0);
        assert!(!woken(), "no arrival, no wake");

        m.mutate(|s| s.add_email("acc1", "mb-work", email("e7", "seven", "2026-10-07T10:00:00Z")));
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!(r.arrivals, 0, "nothing arrived in INBOX");
        assert!(woken(), "the Work arrival wakes the hoarder");
    }

    /// Rows written in a cached mailbox other than the requested one wake
    /// Auto Tags (Task 9c): the requested mailbox's `new_emails`, all
    /// `handle_sync_now` and the push see, is 0.
    #[tokio::test]
    async fn jmap_rows_written_in_any_cached_mailbox_wake_auto_tags() {
        use futures::FutureExt;
        let (_dir, state, m, account) = setup().await;
        sync(&state, &account, "INBOX").await;
        sync(&state, &account, "Work").await;
        let woken = || state.auto_tag_worker.notify.notified().now_or_never().is_some();
        let _ = woken();
        let quiet = sync(&state, &account, "INBOX").await;
        assert_eq!(quiet.new_emails, 0);
        assert!(!woken(), "nothing written, no wake");

        m.mutate(|s| s.add_email("acc1", "mb-work", email("e7", "seven", "2026-10-07T10:00:00Z")));
        let r = sync(&state, &account, "INBOX").await;
        assert_eq!(r.new_emails, 0, "nothing written in INBOX");
        assert!(woken(), "the Work row wakes Auto Tags");
    }
}
