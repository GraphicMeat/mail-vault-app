//! Auto Tags on the phone: desktop's natural-language rules that assign an existing tag (core
//! `app_db::auto_tags`), kept in the phone's core `app.db` beside the tags (`tags.rs`; its
//! `auto_tag_rules`, `auto_tag_decisions` and `auto_tag_backfills` tables come with core's schema,
//! so `mobile.db` needs no step). A rule never moves or deletes mail; it only assigns its tag
//! through the tags store.
//!
//! # Provider
//!
//! The phone's one provider is the OpenAI-compatible endpoint of Settings > AI (`ai.rs`: its URL
//! and model are preferences, its key is in the platform secret store and goes only to that URL).
//! There is no on-device model. A rule runs only when, in this order (core's evaluation
//! sequence, the daemon's too):
//! 1. an endpoint URL is set (`AI_NOT_CONFIGURED` otherwise). The global "Enable AI features"
//!    switch does not apply: as on desktop, a rule runs whether or not it is on;
//! 2. the rule allows a remote provider (core [`store::remote_gate`]: desktop counts every
//!    endpoint as remote here, loopback included), and the endpoint it was allowed for (its
//!    `provider`, `{type: "endpoint", url, model}`, written when the user confirmed the toggle)
//!    is the one configured now. A rule allowed for another URL waits until it is allowed again;
//! 3. the message's account may use that endpoint: mail of a Google account (Google OAuth, or
//!    Gmail's IMAP host), or of an account the engine cannot name, goes only to an endpoint on
//!    this device (core `provider_allowed_for_google_mail`: `localhost`, `127.0.0.0/8`, `::1`;
//!    a LAN address is not this device), through `ai::mail_allowed`, the AI actions' own rule.
//!
//! What is sent: desktop's request exactly (core [`store::verdict_prompt`], its system prompt and
//! token cap): the rule's instruction, and the message's sender, subject, mailbox and whether it
//! has an attachment. Never its body, never another header. A refused or failed evaluation is
//! never recorded: the message stays undecided and is judged once it can be.
//!
//! # The worker
//!
//! A thread at background priority (`mv-engine-autotag`), woken when a body is stored and when a
//! rule is saved, and every [`IDLE_WAIT`] regardless. One sweep: every enabled rule, every
//! account, over the messages of the account's offline window whose body the phone holds, dated
//! from when the rule was turned on (desktop's go-forward window; history is a Backfill's), that
//! pass the rule's prefilter and have no decision for the rule yet (`auto_tag_decisions`, which
//! is also what lets a relaunch resume without asking again). One message is one unit: a short
//! `app.db` read, the request with no lock held, a short write, then a pause. It stops on a
//! constrained network (Low Data Mode, data saver), skips an account whose daily download limit
//! paused background downloads (`usage.rs`), and backs a rule off (from [`RETRY_BASE`] doubling to
//! [`RETRY_MAX`]) after its endpoint fails.
//!
//! # API
//!
//! - `mobile.autoTags.list {}` -> `{rules}`, desktop's `Rule` shape.
//! - `mobile.autoTags.create {rule}` / `.update {id, rule}` -> `{rule, rules}`; `.delete {id}` ->
//!   `{rules}`. `rule` is desktop's `RuleDraft`.
//! - `mobile.autoTags.preview {ruleId | rule, accountId, limit?}` -> `{candidates: [{accountId,
//!   folder, mailbox, uid, messageId, subject, from, matched, confidence, refused}]}` over the
//!   newest `limit` (at most [`PREVIEW_LIMIT`]) held messages; writes nothing. Or `{ok: false,
//!   code}`: `AI_NOT_CONFIGURED`, `E_GOOGLE_MAIL_ON_DEVICE_ONLY`.
//! - `mobile.autoTags.backfill {ruleId, accountId, limit?}` -> `{batchId}`: queued on the worker,
//!   reported by `mobile.autoTags.progress` (`{batchId, ruleId, processed, total, matched,
//!   assigned?, done, code?}`). Or `{ok: false, code}`: the codes above, `NEEDS_REMOTE` (the rule
//!   may not use this endpoint, see 2.).
//! - `mobile.autoTags.undoBackfill {batchId}` -> `{unassigned, tagId}`: removes exactly what that
//!   batch newly assigned.
//! - `mobile.autoTags.status {}` -> `{configured, leavesDevice, googleSkipped, backfills}`.
//!
//! An assignment the engine makes is announced as `mobile.tags.assigned` (`{tagId, items}`), so a
//! row on screen shows its chip. Hide from Inbox (`inboxAction: "hide"`) is kept with the rule
//! and applies on desktop; the phone's list does not hide tagged mail. Nothing here is Premium,
//! as on desktop.

use crate::ai::{self, Config, Fail};
use crate::db::{lock, Engine, Shared};
use crate::events::{AUTO_TAGS_PROGRESS, TAGS_ASSIGNED};
use crate::rpc::{parse, RpcError};
use mailvault_core::ai::endpoint_is_on_device;
use mailvault_core::app_db::auto_tags::{self as store, Candidate, Rule, RuleDraft, Verdict};
use mailvault_core::app_db::identity::msg_key_or_remote;
use mailvault_core::app_db::tags::{self as tag_store, Target};
use mailvault_core::search_index::text::vault_dir_name;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// Messages a preview or a backfill looks at, by default and at most (desktop's 200).
pub(crate) const PREVIEW_LIMIT: usize = 200;
/// The most messages one sweep reads per rule and account (desktop's worker bound).
const SCAN_LIMIT: usize = 5_000;
/// How long one verdict request may take.
const VERDICT_TIMEOUT: Duration = Duration::from_secs(30);
/// The first wait after a rule's endpoint failed; it doubles per failure up to [`RETRY_MAX`].
pub(crate) const RETRY_BASE: Duration = Duration::from_secs(30);
pub(crate) const RETRY_MAX: Duration = Duration::from_secs(3600);
/// The pause between two messages: other work goes first.
const UNIT_PAUSE: Duration = Duration::from_millis(50);
/// How long a wake waits for more (a download stores many bodies in a row).
const WAKE_SETTLE: Duration = Duration::from_secs(2);
/// A sweep runs at least this often.
const IDLE_WAIT: Duration = Duration::from_secs(10 * 60);
/// A backfill reports every this many messages, and on its last.
const PROGRESS_EVERY: usize = 10;
/// Why a rule waits for the user (see the module, 2.).
const NOT_THIS_ENDPOINT: &str = "this rule was not allowed to use the endpoint set now";

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn refused(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

// ── Worker state ────────────────────────────────────────────────────────────

/// One queued backfill.
#[derive(Clone)]
struct Job {
    batch_id: String,
    rule_id: String,
    account_id: String,
    limit: usize,
}

/// The auto-tag state in [`Shared`].
#[derive(Default)]
pub(crate) struct State {
    /// Bumped by [`wake`]; the worker sweeps when it moved.
    wakes: Mutex<u64>,
    jobs: Mutex<VecDeque<Job>>,
    /// The last progress of each rule's backfill (`mobile.autoTags.status`).
    backfills: Mutex<HashMap<String, Value>>,
    /// Per rule: failures in a row, and when it may ask again.
    backoff: Mutex<HashMap<String, (u32, Instant)>>,
}

/// Wakes the worker (it sweeps after [`WAKE_SETTLE`]).
pub(crate) fn wake(shared: &Shared) {
    let mut w = lock(&shared.auto_tags.wakes);
    *w = w.wrapping_add(1);
}

/// The wait after the `failures`-th failure in a row.
pub(crate) fn retry_wait(failures: u32) -> Duration {
    RETRY_BASE.saturating_mul(1u32 << failures.saturating_sub(1).min(16)).min(RETRY_MAX)
}

fn backing_off(shared: &Shared, rule_id: &str) -> bool {
    lock(&shared.auto_tags.backoff).get(rule_id).is_some_and(|(_, until)| Instant::now() < *until)
}

fn failed(shared: &Shared, rule_id: &str) -> Duration {
    let mut b = lock(&shared.auto_tags.backoff);
    let failures = b.get(rule_id).map_or(0, |(n, _)| *n) + 1;
    let wait = retry_wait(failures);
    b.insert(rule_id.to_string(), (failures, Instant::now() + wait));
    wait
}

fn answered(shared: &Shared, rule_id: &str) {
    lock(&shared.auto_tags.backoff).remove(rule_id);
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/// Why an evaluation has no verdict.
#[derive(Debug)]
pub(crate) enum NoVerdict {
    /// Refused before any request (a gate of the module's list): the string says which.
    Gate(String),
    /// The endpoint could not be reached, or did not answer with a completion.
    Endpoint,
    /// The model answered something that is not a verdict.
    Unreadable,
}

impl NoVerdict {
    /// What a preview row says (never the server's or the model's text).
    fn reason(&self) -> String {
        match self {
            NoVerdict::Gate(why) => why.clone(),
            NoVerdict::Endpoint => "AI_FAILED".into(),
            NoVerdict::Unreadable => "unparseable".into(),
        }
    }
}

/// The endpoint URL this rule was allowed to use, when its provider is an endpoint.
fn allowed_url(rule: &Rule) -> Option<&str> {
    (rule.provider.get("type").and_then(Value::as_str) == Some("endpoint")).then(|| rule.provider.get("url").and_then(Value::as_str)).flatten()
}

/// Gate 2 of the module: the rule may send to the endpoint configured now.
pub(crate) fn destination(rule: &Rule, cfg: &Config) -> Result<(), String> {
    store::remote_gate(rule, true)?;
    if allowed_url(rule).map(str::trim) != Some(cfg.url.as_str()) {
        return Err(NOT_THIS_ENDPOINT.into());
    }
    Ok(())
}

/// One message against one rule: core's sequence over the phone's endpoint. `cfg` is configured.
pub(crate) fn evaluate(shared: &Shared, cfg: &Config, account_id: &str, rule: &Rule, candidate: &Candidate) -> Result<Verdict, NoVerdict> {
    destination(rule, cfg).map_err(NoVerdict::Gate)?;
    if !ai::mail_allowed(shared, cfg, &[account_id]).unwrap_or(false) {
        return Err(NoVerdict::Gate(ai::GOOGLE_REFUSED.to_string()));
    }
    let prompt = store::verdict_prompt(&rule.instruction, candidate);
    let text = ai::generate(shared, cfg, &prompt, Some(store::VERDICT_SYSTEM_PROMPT), store::VERDICT_MAX_TOKENS, VERDICT_TIMEOUT, Some(account_id))
        .map_err(|_: Fail| NoVerdict::Endpoint)?;
    store::parse_verdict(&text).map_err(|_| NoVerdict::Unreadable)
}

// ── Candidates ──────────────────────────────────────────────────────────────

/// One held message as a rule sees it.
pub(crate) struct Held {
    pub(crate) folder: String,
    pub(crate) uid: u32,
    pub(crate) message_id: String,
    pub(crate) target: Target,
    pub(crate) candidate: Candidate,
    /// Whether the sync recorded the List-ID question (`listId` in `thread_json`).
    list_known: bool,
}

impl Held {
    /// The rule's prefilter. A rule asking about the list header passes no message whose header
    /// was not recorded: an unknown answer is not a match either way.
    fn passes(&self, rule: &Rule, now_secs: i64) -> bool {
        (rule.constraints.list_id_present.is_none() || self.list_known) && store::passes(&rule.constraints, &self.candidate, now_secs)
    }

    fn item(&self) -> Value {
        json!({ "accountId": self.target.account_id, "folder": self.folder, "uid": self.uid })
    }
}

/// `account`'s messages in its offline window whose body is held, dated `from_ms` or later,
/// newest first, at most `limit`.
pub(crate) fn held(shared: &Shared, account: &str, from_ms: i64, limit: usize) -> Result<Vec<Held>, RpcError> {
    let window = crate::offline::bounds(shared, account, crate::compose::now_ms()).fetch_from;
    let from = from_ms.max(window);
    shared
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT m.folder, m.uid, m.subject, m.from_name, m.from_address, m.date_ms, m.has_attachments, m.thread_json,
                        m.message_id, r.remote_id
                 FROM messages m
                 JOIN bodies b ON b.account_id = m.account_id AND b.folder = m.folder AND b.uid = m.uid
                 LEFT JOIN remote_ids r ON r.account_id = m.account_id AND r.folder = m.folder AND r.uid = m.uid
                 WHERE m.account_id = ?1 AND m.date_ms >= ?2 AND COALESCE(m.local_deleted, 0) = 0
                 ORDER BY m.date_ms DESC, m.uid DESC LIMIT ?3",
            )?;
            let rows = st
                .query_map((account, from, limit as i64), |r| {
                    let folder: String = r.get(0)?;
                    let uid = r.get::<_, i64>(1)? as u32;
                    let (name, address): (String, String) = (r.get(3)?, r.get(4)?);
                    let thread: Value = serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(Value::Null);
                    let message_id: String = r.get(8)?;
                    let remote_id: Option<String> = r.get(9)?;
                    let list_known = thread.get("listId").is_some();
                    let list_id = thread.get("listId").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string);
                    let from = if name.trim().is_empty() { address.clone() } else { format!("{} <{address}>", name.trim()) };
                    Ok(Held {
                        target: Target {
                            account_id: account.to_string(),
                            msg_key: msg_key_or_remote(Some(&message_id), &vault_dir_name(&folder), uid, remote_id.as_deref()),
                        },
                        candidate: Candidate {
                            from,
                            subject: r.get(2)?,
                            mailbox: folder.clone(),
                            has_attachments: r.get::<_, i64>(6)? != 0,
                            list_id,
                            date: r.get::<_, i64>(5)?.div_euclid(1000),
                        },
                        folder,
                        uid,
                        message_id,
                        list_known,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)
}

fn now_secs() -> i64 {
    crate::compose::now_ms().div_euclid(1000)
}

// ── The sweep ───────────────────────────────────────────────────────────────

/// How a sweep ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Swept {
    Done,
    /// The network is constrained: nothing more until it is not.
    Paused,
    Closing,
}

fn account_ids(shared: &Shared) -> Vec<String> {
    shared
        .read(|c| {
            let mut st = c.prepare("SELECT id FROM accounts ORDER BY created_ms, id")?;
            let rows = st.query_map([], |r| r.get(0))?.collect();
            rows
        })
        .unwrap_or_default()
}

/// One sweep (see the module). Returns how many messages it judged, and how it ended.
pub(crate) fn sweep(shared: &Shared) -> (usize, Swept) {
    let mut judged = 0;
    let Ok(cfg) = Config::read_shared(shared) else { return (0, Swept::Done) };
    if !cfg.configured() {
        return (0, Swept::Done);
    }
    let rules: Vec<Rule> = match shared.app_db.with(store::list) {
        Ok(rules) => rules.into_iter().filter(|r| r.enabled && r.enabled_at.is_some() && destination(r, &cfg).is_ok()).collect(),
        Err(e) => {
            shared.log(&format!("[auto-tag] could not read rules: {e}"));
            return (0, Swept::Done);
        }
    };
    if rules.is_empty() {
        return (0, Swept::Done);
    }
    let accounts = account_ids(shared);
    let mut skipped = HashSet::new();
    for rule in &rules {
        if backing_off(shared, &rule.id) {
            continue;
        }
        let from_ms = rule.enabled_at.unwrap_or(i64::MAX).saturating_mul(1000);
        'accounts: for account in &accounts {
            if shared.is_closing() {
                return (judged, Swept::Closing);
            }
            if !crate::offline::downloads_allowed(shared) {
                return (judged, Swept::Paused);
            }
            if crate::usage::background_capped(shared, account) {
                continue;
            }
            // A Google account's mail never goes to an endpoint off this device. Nothing is
            // recorded, so an endpoint on this phone picks it up later.
            if !ai::mail_allowed(shared, &cfg, &[account.as_str()]).unwrap_or(false) {
                skipped.insert(account.clone());
                continue;
            }
            let Ok(list) = held(shared, account, from_ms, SCAN_LIMIT) else { continue };
            let now = now_secs();
            let list: Vec<Held> = list.into_iter().filter(|h| h.passes(rule, now)).collect();
            if list.is_empty() {
                continue;
            }
            let targets: Vec<Target> = list.iter().map(|h| h.target.clone()).collect();
            let open: HashSet<String> = match shared.app_db.with(|c| store::undecided(c, &rule.id, &targets)) {
                Ok(v) => v.into_iter().map(|t| t.msg_key).collect(),
                Err(e) => {
                    shared.log(&format!("[auto-tag] could not read decisions for rule {}: {e}", rule.id));
                    continue;
                }
            };
            for h in list.iter().filter(|h| open.contains(&h.target.msg_key)) {
                if shared.is_closing() {
                    return (judged, Swept::Closing);
                }
                if !crate::offline::downloads_allowed(shared) {
                    return (judged, Swept::Paused);
                }
                match evaluate(shared, &cfg, account, rule, &h.candidate) {
                    Ok(verdict) => {
                        answered(shared, &rule.id);
                        judged += 1;
                        record(shared, rule, h, store::meets_threshold(verdict, rule.min_confidence));
                    }
                    Err(NoVerdict::Endpoint) => {
                        let wait = failed(shared, &rule.id);
                        shared.log(&format!("[auto-tag] the endpoint failed for rule {}; next try in {}s", rule.id, wait.as_secs()));
                        break 'accounts;
                    }
                    // Asked again on a later sweep, as on desktop.
                    Err(NoVerdict::Unreadable) | Err(NoVerdict::Gate(_)) => {}
                }
                std::thread::sleep(UNIT_PAUSE);
            }
        }
    }
    if !skipped.is_empty() {
        shared.log(&format!("[auto-tag] {} account(s) left out: {}", skipped.len(), ai::GOOGLE_REFUSED));
    }
    (judged, Swept::Done)
}

/// A verdict on record (and the tag, on a match), then the chip on screen.
fn record(shared: &Shared, rule: &Rule, h: &Held, matched: bool) {
    let written = shared.app_db.with(|c| {
        if matched {
            tag_store::assign(c, &rule.tag_id, std::slice::from_ref(&h.target))?;
        }
        store::record_decision(c, &rule.id, &h.target, matched)
    });
    match written {
        Err(e) => shared.log(&format!("[auto-tag] could not record a decision for rule {}: {e}", rule.id)),
        Ok(()) if matched => shared.emit(TAGS_ASSIGNED, json!({ "tagId": rule.tag_id, "items": [h.item()] })),
        Ok(()) => {}
    }
}

// ── Backfill ────────────────────────────────────────────────────────────────

fn progress(shared: &Shared, rule_id: &str, payload: Value) {
    lock(&shared.auto_tags.backfills).insert(rule_id.to_string(), payload.clone());
    shared.emit(AUTO_TAGS_PROGRESS, payload);
}

/// Runs one queued backfill to its end (an explicit action: it goes whatever the network).
fn run_backfill(shared: &Shared, job: &Job) {
    let base = |processed: usize, total: usize, matched: usize| {
        json!({ "batchId": job.batch_id, "ruleId": job.rule_id, "processed": processed, "total": total, "matched": matched, "done": false })
    };
    let end = |mut payload: Value, code: Option<&str>, assigned: usize| {
        payload["done"] = json!(true);
        payload["assigned"] = json!(assigned);
        if let Some(code) = code {
            payload["code"] = json!(code);
        }
        progress(shared, &job.rule_id, payload);
    };
    let rule = match shared.app_db.with(|c| store::get(c, &job.rule_id)) {
        Ok(Some(rule)) => rule,
        _ => return end(base(0, 0, 0), Some("INVALID"), 0),
    };
    let cfg = match Config::read_shared(shared) {
        Ok(cfg) if cfg.configured() => cfg,
        _ => return end(base(0, 0, 0), Some("AI_NOT_CONFIGURED"), 0),
    };
    let Ok(list) = held(shared, &job.account_id, 0, job.limit) else { return end(base(0, 0, 0), Some("INVALID"), 0) };
    let total = list.len();
    let now = now_secs();
    let (mut processed, mut matched) = (0, 0);
    let mut hits: Vec<&Held> = Vec::new();
    for h in &list {
        if shared.is_closing() {
            return;
        }
        processed += 1;
        if h.passes(&rule, now) {
            match evaluate(shared, &cfg, &job.account_id, &rule, &h.candidate) {
                Ok(v) if store::meets_threshold(v, rule.min_confidence) => {
                    matched += 1;
                    hits.push(h);
                }
                Ok(_) | Err(NoVerdict::Unreadable) => {}
                Err(NoVerdict::Gate(why)) => {
                    let code = if why == ai::GOOGLE_REFUSED { ai::GOOGLE_REFUSED } else { "NEEDS_REMOTE" };
                    return end(base(processed, total, matched), Some(code), 0);
                }
                Err(NoVerdict::Endpoint) => return end(base(processed, total, matched), Some("AI_FAILED"), 0),
            }
        }
        if processed % PROGRESS_EVERY == 0 && processed < total {
            progress(shared, &job.rule_id, base(processed, total, matched));
        }
    }
    let targets: Vec<Target> = hits.iter().map(|h| h.target.clone()).collect();
    let written = shared.app_db.with(|c| {
        // Only what this batch newly tagged is recorded, so its undo never strips a tag a
        // message already carried.
        let newly = store::exclude_already_tagged(c, &rule.tag_id, targets)?;
        tag_store::assign(c, &rule.tag_id, &newly)?;
        store::record_backfill(c, &job.batch_id, &rule.id, &rule.tag_id, &newly)?;
        Ok(newly)
    });
    match written {
        Ok(newly) => {
            let keys: HashSet<&str> = newly.iter().map(|t| t.msg_key.as_str()).collect();
            let items: Vec<Value> = hits.iter().filter(|h| keys.contains(h.target.msg_key.as_str())).map(|h| h.item()).collect();
            if !items.is_empty() {
                shared.emit(TAGS_ASSIGNED, json!({ "tagId": rule.tag_id, "items": items }));
            }
            end(base(processed, total, matched), None, newly.len());
        }
        Err(e) => {
            shared.log(&format!("[auto-tag] backfill of rule {} not written: {e}", rule.id));
            end(base(processed, total, matched), Some("INVALID"), 0);
        }
    }
}

/// Runs every queued backfill. How many ran.
pub(crate) fn run_jobs(shared: &Shared) -> usize {
    let mut ran = 0;
    loop {
        let Some(job) = lock(&shared.auto_tags.jobs).pop_front() else { return ran };
        if shared.is_closing() {
            return ran;
        }
        run_backfill(shared, &job);
        ran += 1;
    }
}

// ── The thread ──────────────────────────────────────────────────────────────

/// Sleeps up to `max`, a second at a time; `None` when the engine went away, else whether a
/// wake came.
fn wait(weak: &Weak<Shared>, seen: &mut u64, max: Duration) -> Option<bool> {
    let until = Instant::now() + max;
    loop {
        let shared = weak.upgrade().filter(|s| !s.is_closing())?;
        let now = *lock(&shared.auto_tags.wakes);
        if now != *seen {
            *seen = now;
            return Some(true);
        }
        drop(shared);
        if Instant::now() >= until {
            return Some(false);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// The worker's thread (see the module). It holds the engine weakly and ends with it. Unit tests
/// drive [`sweep`] and [`run_jobs`] themselves, so the thread does not start there.
pub(crate) fn start(shared: &Arc<Shared>) {
    if cfg!(test) {
        return;
    }
    let weak: Weak<Shared> = Arc::downgrade(shared);
    let spawned = std::thread::Builder::new().name("mv-engine-autotag".into()).spawn(move || {
        crate::sync::background_qos();
        let mut seen = 0u64;
        // The first sweep after launch: whatever arrived while the app was closed.
        let mut next = WAKE_SETTLE;
        loop {
            match wait(&weak, &mut seen, next) {
                None => return,
                Some(true) => {
                    // Let a run of wakes (a download storing bodies) settle into one sweep.
                    if wait(&weak, &mut seen, WAKE_SETTLE).is_none() {
                        return;
                    }
                }
                Some(false) => {}
            }
            let Some(shared) = weak.upgrade().filter(|s| !s.is_closing()) else { return };
            run_jobs(&shared);
            sweep(&shared);
            // A rule backing off is looked at again when its wait is over.
            let soonest = lock(&shared.auto_tags.backoff).values().map(|(_, until)| until.saturating_duration_since(Instant::now())).min();
            next = soonest.map_or(IDLE_WAIT, |d| d.clamp(Duration::from_secs(1), IDLE_WAIT));
        }
    });
    if let Err(e) = spawned {
        shared.log(&format!("[auto-tag] worker thread: {e}"));
    }
}

// ── RPCs ────────────────────────────────────────────────────────────────────

fn rules(shared: &Shared) -> Result<Value, RpcError> {
    Ok(json!(shared.app_db.with(store::list).map_err(internal)?))
}

/// `mobile.autoTags.list {}`; see the module.
pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    Ok(json!({ "rules": rules(engine.shared())? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateParams {
    rule: Value,
}

fn draft_of(v: Value) -> Result<RuleDraft, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::Invalid(format!("rule: {e}")))
}

/// `mobile.autoTags.create {rule}`; see the module.
pub(crate) fn create(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: CreateParams = parse(params)?;
    let draft = draft_of(p.rule)?;
    let shared = engine.shared();
    let rule = shared.app_db.with(|c| store::create(c, draft)).map_err(RpcError::Invalid)?;
    wake(shared);
    Ok(json!({ "rule": rule, "rules": rules(shared)? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateParams {
    id: String,
    rule: Value,
}

/// `mobile.autoTags.update {id, rule}`; see the module.
pub(crate) fn update(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: UpdateParams = parse(params)?;
    let draft = draft_of(p.rule)?;
    let shared = engine.shared();
    let rule = shared.app_db.with(|c| store::update(c, &p.id, draft)).map_err(RpcError::Invalid)?;
    // An edit is a fresh start for a rule that was backing off.
    answered(shared, &p.id);
    wake(shared);
    Ok(json!({ "rule": rule, "rules": rules(shared)? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

/// `mobile.autoTags.delete {id}`; see the module.
pub(crate) fn delete(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    let shared = engine.shared();
    shared.app_db.with(|c| store::delete(c, &p.id)).map_err(internal)?;
    lock(&shared.auto_tags.backfills).remove(&p.id);
    answered(shared, &p.id);
    Ok(json!({ "rules": rules(shared)? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewParams {
    #[serde(default)]
    rule_id: Option<String>,
    #[serde(default)]
    rule: Option<Value>,
    account_id: String,
    #[serde(default)]
    limit: Option<usize>,
}

/// The configuration, when a preview or backfill of `account`'s mail may ask at all: `Err` is the
/// code that stops it before anything is read.
fn ready(shared: &Shared, account: &str) -> Result<Result<Config, &'static str>, RpcError> {
    let cfg = Config::read_shared(shared)?;
    if !cfg.configured() {
        return Ok(Err("AI_NOT_CONFIGURED"));
    }
    if !ai::mail_allowed(shared, &cfg, &[account])? {
        return Ok(Err(ai::GOOGLE_REFUSED));
    }
    Ok(Ok(cfg))
}

/// `mobile.autoTags.preview`; see the module. Runs on the caller's RPC thread and writes nothing.
pub(crate) fn preview(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: PreviewParams = parse(params)?;
    let shared = engine.shared();
    let rule = match (&p.rule_id, p.rule) {
        (Some(id), _) => shared.app_db.with(|c| store::get(c, id)).map_err(internal)?.ok_or_else(|| RpcError::Invalid("no such auto-tag rule".into()))?,
        (None, Some(v)) => store::rule_from_draft(draft_of(v)?),
        (None, None) => return Err(RpcError::Invalid("preview takes ruleId or rule".into())),
    };
    let cfg = match ready(shared, &p.account_id)? {
        Ok(cfg) => cfg,
        Err(code) => return Ok(refused(code)),
    };
    let limit = p.limit.unwrap_or(PREVIEW_LIMIT).clamp(1, PREVIEW_LIMIT);
    let now = now_secs();
    let mut rows = Vec::new();
    for h in held(shared, &p.account_id, 0, limit)? {
        if !h.passes(&rule, now) {
            continue;
        }
        let verdict = evaluate(shared, &cfg, &p.account_id, &rule, &h.candidate);
        let matched = matches!(verdict, Ok(v) if store::meets_threshold(v, rule.min_confidence));
        let (confidence, why) = match &verdict {
            Ok(Verdict::Match(c)) => (Some(*c), None),
            Ok(Verdict::NoMatch) => (None, None),
            Err(no) => (None, Some(no.reason())),
        };
        rows.push(json!({
            "accountId": h.target.account_id, "folder": h.folder, "mailbox": h.folder, "uid": h.uid,
            "messageId": h.message_id, "subject": h.candidate.subject, "from": h.candidate.from,
            "matched": matched, "confidence": confidence, "refused": why,
        }));
    }
    Ok(json!({ "candidates": rows }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackfillParams {
    rule_id: String,
    account_id: String,
    #[serde(default)]
    limit: Option<usize>,
}

/// `mobile.autoTags.backfill`; see the module. Queues the job and answers at once.
pub(crate) fn backfill(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: BackfillParams = parse(params)?;
    let shared = engine.shared();
    let rule = shared.app_db.with(|c| store::get(c, &p.rule_id)).map_err(internal)?.ok_or_else(|| RpcError::Invalid("no such auto-tag rule".into()))?;
    let cfg = match ready(shared, &p.account_id)? {
        Ok(cfg) => cfg,
        Err(code) => return Ok(refused(code)),
    };
    if destination(&rule, &cfg).is_err() {
        return Ok(refused("NEEDS_REMOTE"));
    }
    let batch_id = mailvault_core::people::model::new_id();
    let job = Job { batch_id: batch_id.clone(), rule_id: rule.id.clone(), account_id: p.account_id, limit: p.limit.unwrap_or(PREVIEW_LIMIT).clamp(1, PREVIEW_LIMIT) };
    progress(shared, &rule.id, json!({ "batchId": batch_id, "ruleId": rule.id, "processed": 0, "total": 0, "matched": 0, "done": false }));
    lock(&shared.auto_tags.jobs).push_back(job);
    wake(shared);
    Ok(json!({ "batchId": batch_id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UndoParams {
    batch_id: String,
}

/// `mobile.autoTags.undoBackfill {batchId}`; see the module. An unknown or already undone batch
/// unassigns nothing.
pub(crate) fn undo_backfill(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: UndoParams = parse(params)?;
    let shared = engine.shared();
    let out = shared
        .app_db
        .with(|c| {
            let Some((rule_id, tag_id, targets)) = store::backfill_batch(c, &p.batch_id)? else { return Ok(None) };
            let unassigned = tag_store::unassign(c, &tag_id, &targets)?;
            store::delete_backfill_batch(c, &p.batch_id)?;
            Ok(Some((rule_id, tag_id, unassigned)))
        })
        .map_err(internal)?;
    let Some((rule_id, tag_id, unassigned)) = out else { return Ok(json!({ "unassigned": 0 })) };
    let mut backfills = lock(&shared.auto_tags.backfills);
    if backfills.get(&rule_id).and_then(|b| b["batchId"].as_str()) == Some(p.batch_id.as_str()) {
        backfills.remove(&rule_id);
    }
    Ok(json!({ "unassigned": unassigned, "tagId": tag_id }))
}

/// `mobile.autoTags.status {}`: `configured` (an endpoint URL is set), `leavesDevice` (it is not
/// on this device), `googleSkipped` (Google accounts the worker leaves out for that), and each
/// rule's last backfill progress.
pub(crate) fn status(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    let cfg = Config::read_shared(shared)?;
    let leaves = cfg.configured() && !endpoint_is_on_device(&cfg.url);
    let mut google = Vec::new();
    if leaves {
        for id in account_ids(shared) {
            if !ai::mail_allowed(shared, &cfg, &[id.as_str()])? {
                google.push(id);
            }
        }
    }
    let backfills: serde_json::Map<String, Value> = lock(&shared.auto_tags.backfills).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    Ok(json!({ "configured": cfg.configured(), "leavesDevice": leaves, "googleSkipped": google, "backfills": backfills }))
}

#[cfg(test)]
mod tests;
