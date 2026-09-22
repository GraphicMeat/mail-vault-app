//! Background worker for Auto Tags — the standing behaviour that makes this
//! an AUTO tag rather than a one-off bulk action. Modeled on
//! `scheduled_send_worker.rs`'s shape (`Arc<DaemonState>` + a `Notify` + its
//! own task), but level-triggered rather than queue-driven: on every wake it
//! re-derives "what still needs a verdict" from durable state — the header
//! cache, each rule's `enabled_at`, and `auto_tag_decisions` — instead of
//! keeping a second persisted queue next to `classification_queue`.
//!
//! Woken by the same "new mail arrived" signals that already feed the
//! classification path, never by polling the vault: `handlers::handle_sync_now`
//! (a manual/periodic sync) and `idle_watch` (an IDLE wake-up sync) both call
//! `state.auto_tag_worker.wake()` the moment they see new mail.
//!
//! Calls straight back into `handlers::auto_tags::evaluate` — the same
//! function `.preview`/`.backfill` use — so the `allow_remote` privacy gate
//! lives in exactly one place no matter which of the three calls it.

use crate::handlers::auto_tags::{evaluate, load_candidates, now_secs, provider_from_rule, should_assign};
use crate::handlers::common::blocking;
use crate::server::DaemonState;
use mailvault_core::app_db::{self, auto_tags, tags::Target};
use mailvault_core::custody::cache;
use std::sync::Arc;
use tracing::warn;

/// A generous catch-up bound, not a cost control (the real cost control is
/// `enabled_at` + the prefilter + `auto_tag_decisions`): the only time this
/// matters is a rule that has been enabled for a long time on a daemon that
/// was off for a long time, and even then it only holds back memory use for
/// one sweep, not correctness.
// ponytail: a flat cap, not paged; revisit if a real account's catch-up ever
// needs more than this in one sweep.
const WORKER_SCAN_LIMIT: usize = 5_000;

#[derive(Clone)]
pub struct AutoTagWorkerState {
    pub notify: Arc<tokio::sync::Notify>,
}

impl Default for AutoTagWorkerState {
    fn default() -> Self {
        Self { notify: Arc::new(tokio::sync::Notify::new()) }
    }
}

impl AutoTagWorkerState {
    /// Called from wherever the daemon already learns new mail arrived
    /// (`handlers::handle_sync_now`, `idle_watch`) — never on its own timer.
    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

pub(crate) fn start(state: Arc<DaemonState>) {
    tokio::spawn(async move { run(state).await });
}

async fn run(state: Arc<DaemonState>) {
    tracing::info!("[auto-tag] worker started");
    loop {
        sweep(&state).await;
        // `Notify` keeps one permit when `wake()` fires with nobody waiting
        // yet, so a wake during `sweep` is never lost — it just runs another
        // sweep immediately instead of parking here first.
        state.auto_tag_worker.notify.notified().await;
    }
}

/// One pass: every enabled rule, over every account the header cache knows
/// about, evaluating only what that rule has not already decided on.
async fn sweep(state: &Arc<DaemonState>) {
    let app_dir = state.app_dir.clone();
    let rules = match blocking(move || app_db::with(&app_dir, |conn| auto_tags::list(conn))).await {
        Ok(Ok(rules)) => rules,
        Ok(Err(e)) => {
            warn!("[auto-tag] could not read rules: {e}");
            return;
        }
        Err(e) => {
            warn!("[auto-tag] rule read task failed: {e}");
            return;
        }
    };
    let enabled: Vec<_> = rules.into_iter().filter(|r| r.enabled && r.enabled_at.is_some()).collect();
    if enabled.is_empty() {
        return;
    }

    let state_for_accounts = Arc::clone(state);
    let accounts = blocking(move || {
        crate::custody::with_conn(&state_for_accounts, |conn| cache::mailboxes_with_headers(conn, None))
    })
    .await;
    let account_ids: Vec<String> = match accounts {
        Ok(Ok(rows)) => {
            let mut set = std::collections::BTreeSet::new();
            for (account_id, _mailbox) in rows {
                set.insert(account_id);
            }
            set.into_iter().collect()
        }
        Ok(Err(e)) => {
            warn!("[auto-tag] could not list cached accounts: {e}");
            return;
        }
        Err(e) => {
            warn!("[auto-tag] account listing task failed: {e}");
            return;
        }
    };
    if account_ids.is_empty() {
        return;
    }

    for rule in &enabled {
        for account_id in &account_ids {
            process_rule_account(state, rule, account_id).await;
        }
    }
}

/// Evaluate one rule against one account's cached headers, going forward
/// only from `rule.enabled_at` and skipping anything already decided.
async fn process_rule_account(state: &Arc<DaemonState>, rule: &auto_tags::Rule, account_id: &str) {
    let Some(enabled_at) = rule.enabled_at else { return };

    let state_clone = Arc::clone(state);
    let account = account_id.to_string();
    let candidates = blocking(move || load_candidates(&state_clone, &account, WORKER_SCAN_LIMIT)).await.unwrap_or_default();

    let now = now_secs();
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|c| c.candidate.date >= enabled_at && auto_tags::passes(&rule.constraints, &c.candidate, now))
        .collect();
    if candidates.is_empty() {
        return;
    }

    let app_dir = state.app_dir.clone();
    let rule_id = rule.id.clone();
    let targets: Vec<Target> = candidates.iter().map(|c| c.msg_ref.target()).collect();
    let undecided = match blocking(move || app_db::with(&app_dir, |conn| auto_tags::undecided(conn, &rule_id, &targets))).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            warn!("[auto-tag] could not read decisions for rule {}: {e}", rule.id);
            return;
        }
        Err(e) => {
            warn!("[auto-tag] decision-read task failed for rule {}: {e}", rule.id);
            return;
        }
    };
    let undecided: std::collections::HashSet<(String, String)> =
        undecided.into_iter().map(|t| (t.account_id, t.msg_key)).collect();
    if undecided.is_empty() {
        return;
    }

    let provider = provider_from_rule(rule);
    for c in candidates {
        let target = c.msg_ref.target();
        if !undecided.contains(&(target.account_id.clone(), target.msg_key.clone())) {
            continue;
        }
        let verdict = evaluate(&provider, &state.inference, rule, &c.candidate).await;
        let matched = should_assign(&verdict, rule.min_confidence);

        let app_dir = state.app_dir.clone();
        let rule_id = rule.id.clone();
        let tag_id = rule.tag_id.clone();
        let write = blocking(move || {
            app_db::with(&app_dir, |conn| {
                if matched {
                    mailvault_core::app_db::tags::assign(conn, &tag_id, std::slice::from_ref(&target))?;
                }
                auto_tags::record_decision(conn, &rule_id, &target, matched)
            })
        })
        .await;
        if let Err(e) = write.unwrap_or_else(|e| Err(e.to_string())) {
            warn!("[auto-tag] could not record a decision for rule {}: {e}", rule.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-autotag-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    fn seed_header(s: &Arc<DaemonState>, account: &str, mailbox: &str, uid: u32, subject: &str, from: &str) {
        let header = json!({
            "uid": uid, "subject": subject, "from": {"address": from},
            "date": "2026-08-01T00:00:00Z", "hasAttachments": false,
        });
        crate::custody::with_conn(s, |conn| cache::save_headers(conn, account, mailbox, &json!({"emails": [header]}).to_string()))
            .unwrap();
    }

    async fn tag_count(s: &Arc<DaemonState>) -> i64 {
        let listed = crate::handlers::tags::route(s, "tags.list", &json!({}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("tags.list");
        listed[0]["count"].as_i64().unwrap()
    }

    async fn create_rule(s: &Arc<DaemonState>, tag_id: &str, allow_remote: bool, provider: serde_json::Value) -> auto_tags::Rule {
        let app_dir = s.app_dir.clone();
        let draft = auto_tags::RuleDraft {
            name: "Receipts".into(),
            instruction: "receipts and invoices".into(),
            constraints: auto_tags::Constraints::default(),
            tag_id: tag_id.to_string(),
            inbox_action: auto_tags::InboxAction::Keep,
            min_confidence: 0.5,
            allow_remote,
            provider,
            enabled: true,
        };
        blocking(move || app_db::with(&app_dir, |conn| auto_tags::create(conn, draft))).await.unwrap().unwrap()
    }

    /// Backdate a rule's `enabled_at` to the epoch, so a header cached with a
    /// fixed 2026-08-01 test date reads as "arrived after this rule turned
    /// on" no matter what day the suite actually runs.
    async fn backdate(s: &Arc<DaemonState>, rule_id: &str) {
        let app_dir = s.app_dir.clone();
        let rid = rule_id.to_string();
        blocking(move || {
            app_db::with(&app_dir, |conn| {
                conn.execute("UPDATE auto_tag_rules SET enabled_at = 0 WHERE id = ?1", [&rid]).map_err(|e| e.to_string())
            })
        })
        .await
        .unwrap()
        .unwrap();
    }

    async fn tag_named(s: &Arc<DaemonState>, name: &str) -> String {
        crate::handlers::tags::route(s, "tags.ensure", &json!({"name": name, "color": ""}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("ensure")["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn a_sweep_refuses_an_endpoint_provider_for_a_rule_without_allow_remote() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example");
        let tag = tag_named(&s, "Receipts").await;
        let provider = json!({"type": "endpoint", "url": "http://127.0.0.1:1", "model": "m"});
        let rule = create_rule(&s, &tag, false, provider).await;
        backdate(&s, &rule.id).await;

        sweep(&s).await;

        assert_eq!(tag_count(&s).await, 0, "a refused evaluation must never assign");
        // Proof the worker actually ran the rule through `evaluate` (and got
        // refused) rather than silently skipping it: a decision landed.
        let app_dir = s.app_dir.clone();
        let rule_id = rule.id.clone();
        let target = Target { account_id: "a".into(), msg_key: "u:INBOX:1".into() };
        let still_undecided = blocking(move || app_db::with(&app_dir, |conn| auto_tags::undecided(conn, &rule_id, &[target])))
            .await
            .unwrap()
            .unwrap();
        assert!(still_undecided.is_empty(), "the refusal itself must be recorded as a decision");
    }

    #[tokio::test]
    async fn a_sweep_skips_a_disabled_rule_entirely() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example");
        let tag = tag_named(&s, "Receipts").await;
        let app_dir = s.app_dir.clone();
        let draft = auto_tags::RuleDraft {
            name: "Receipts".into(),
            instruction: "receipts".into(),
            constraints: auto_tags::Constraints::default(),
            tag_id: tag,
            inbox_action: auto_tags::InboxAction::Keep,
            min_confidence: 0.5,
            allow_remote: false,
            provider: serde_json::Value::Null,
            enabled: false, // never turned on
        };
        blocking(move || app_db::with(&app_dir, |conn| auto_tags::create(conn, draft))).await.unwrap().unwrap();

        sweep(&s).await;
        assert_eq!(tag_count(&s).await, 0);
    }

    #[tokio::test]
    async fn a_sweep_never_looks_at_mail_older_than_when_the_rule_was_enabled() {
        let s = st();
        // Old mail, cached before the rule ever existed.
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example");
        let tag = tag_named(&s, "Receipts").await;
        let rule = create_rule(&s, &tag, false, serde_json::Value::Null).await;
        assert!(rule.enabled_at.is_some());

        // The cached header's date (2026-08-01) predates `enabled_at` (now),
        // so the constraint-independent age gate alone must keep it out —
        // proven by local_gguf's own instant, deterministic refusal never
        // even being asked: no decision is recorded for it at all.
        sweep(&s).await;

        let app_dir = s.app_dir.clone();
        let rule_id = rule.id.clone();
        let target = Target { account_id: "a".into(), msg_key: "u:INBOX:1".into() };
        let still_undecided = blocking(move || app_db::with(&app_dir, |conn| auto_tags::undecided(conn, &rule_id, &[target])))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still_undecided.len(), 1, "mail from before the rule was enabled is never even evaluated");
    }

    #[tokio::test]
    async fn a_sweep_never_asks_about_the_same_message_twice() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example");
        let tag = tag_named(&s, "Receipts").await;
        let rule = create_rule(&s, &tag, false, serde_json::Value::Null).await;
        backdate(&s, &rule.id).await;

        sweep(&s).await;
        sweep(&s).await; // a second wake with nothing new must not re-ask.

        // `LocalGguf` with no model loaded fails instantly and deterministically
        // (see `llm.rs`'s own tests), so this proves at most one decision was
        // ever written rather than the worker looping on the same message.
        let app_dir = s.app_dir.clone();
        let rule_id = rule.id.clone();
        let target = Target { account_id: "a".into(), msg_key: "u:INBOX:1".into() };
        let decided_count: i64 = blocking(move || {
            app_db::with(&app_dir, |conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM auto_tag_decisions WHERE rule_id = ?1 AND account_id = ?2 AND msg_key = ?3",
                    rusqlite::params![rule_id, target.account_id, target.msg_key],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(decided_count, 1, "one row, not one per sweep");
    }

    #[tokio::test]
    async fn auto_tag_worker_state_wake_delivers_to_a_waiter_parked_before_it_fires() {
        let state = AutoTagWorkerState::default();
        let notify = Arc::clone(&state.notify);
        let waiter = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(2), notify.notified()).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        state.wake();
        waiter.await.unwrap().expect("wake must reach an already-parked waiter");
    }
}
