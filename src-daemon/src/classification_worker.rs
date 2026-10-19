//! Background classification worker and the cached-header readers it feeds on.

use crate::classification;
use mailvault_core::learning;
use crate::server::DaemonState;
use mailvault_core::custody::cache;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{info, warn};

/// Retrain from the current labels, then force-enqueue everything the user has
/// not overridden. Split out of the handler so a test can await it.
pub(crate) async fn reclassify_all(state: Arc<DaemonState>, account_id: String) {
    // 1. Retrain, then read every cached header — both read the header cache.
    // This is a spawned task, so doing it inline parked a tokio worker for
    // the whole read. One `spawn_blocking` covers both: labels and the model
    // live in the app dir, the cached headers in the vault's custody store.
    let emails = {
        let state = Arc::clone(&state);
        let account = account_id.clone();
        match tokio::task::spawn_blocking(move || {
            retrain_model(&state, &account);
            load_emails_all_mailboxes(&state, &account)
        })
        .await
        {
            Ok(v) => v,
            Err(e) => {
                warn!("[reclassify] cached-header read failed for {account_id}: {e}");
                return;
            }
        }
    };
    if emails.is_empty() {
        info!("[reclassify] No emails to reclassify for {}", account_id);
        return;
    }

    // Filter out UserOverride classifications — those stay
    let existing = classification::load_classifications(&state.app_dir, &account_id);
    let reclassify_emails: Vec<_> = emails
        .into_iter()
        .filter(|e| {
            let mid = e.message_id.as_deref().unwrap_or("");
            if mid.is_empty() { return false; }
            match existing.get(mid) {
                Some(c) if c.source == classification::ClassificationSource::UserOverride => false,
                _ => true,
            }
        })
        .collect();

    let count = state
        .classification
        .enqueue_force(&account_id, reclassify_emails, classification::QueueTier::New)
        .await;

    info!("[reclassify] Enqueued {} emails for reclassification ({})", count, account_id);
}

/// Retrain the Naive Bayes model from the user's overrides (bootstrap labels
/// when there are none). Rule results are not labels: one rule's output would
/// teach the model to repeat that rule for every message. Too little evidence
/// (see `classification::train_checked`) leaves the existing model as it is.
fn retrain_model(state: &Arc<DaemonState>, account_id: &str) {
    let app_dir = &state.app_dir;
    let classifications = classification::load_classifications(app_dir, account_id);
    let emails = load_emails_all_mailboxes(state, account_id);

    // Build labeled data from user overrides
    let mut labeled: Vec<(classification::EmailForClassification, String)> = Vec::new();

    // Map emails by message_id for lookup
    let email_map: HashMap<String, &classification::EmailForClassification> = emails
        .iter()
        .filter_map(|e| e.message_id.as_ref().map(|mid| (mid.clone(), e)))
        .collect();

    for (mid, cls) in &classifications {
        if cls.source != classification::ClassificationSource::UserOverride {
            continue;
        }
        if let Some(email) = email_map.get(mid) {
            labeled.push(((*email).clone(), cls.category.clone()));
        }
    }

    if labeled.is_empty() {
        // Not enough data to train — also add bootstrap labels
        for email in &emails {
            if let Some((cat, _)) = classification::bootstrap_label(email) {
                labeled.push((email.clone(), cat.to_string()));
            }
        }
    }

    let Some(model) = classification::train_checked(&labeled) else {
        info!("[retrain] Not enough labeled data ({}) across categories to train model for {}", labeled.len(), account_id);
        return;
    };
    info!(
        "[retrain] Trained NB model for {} with {} examples, {} vocab",
        account_id, model.training_count, model.vocab_size
    );

    if let Err(e) = classification::save_model(app_dir, account_id, &model) {
        warn!("[retrain] Failed to save model: {}", e);
    }
}

/// Load cached email headers and enqueue unclassified ones for the background worker.
pub(crate) async fn enqueue_for_classification(
    state: Arc<DaemonState>,
    account_id: &str,
    tier: classification::QueueTier,
) {
    // Same walk, same reason (see `reclassify_all`): never on a tokio worker.
    let emails = {
        let state = Arc::clone(&state);
        let account = account_id.to_string();
        match tokio::task::spawn_blocking(move || load_emails_all_mailboxes(&state, &account)).await {
            Ok(v) => v,
            Err(e) => {
                warn!("[classification] cached-header read failed for {account_id}: {e}");
                return;
            }
        }
    };
    if emails.is_empty() {
        info!("[classification] No emails to enqueue for {}", account_id);
        return;
    }

    let count = state
        .classification
        .enqueue(account_id, emails, tier)
        .await;

    info!(
        "[classification] Enqueued {} emails for {} (tier: {:?})",
        count, account_id, tier
    );
}

/// Every cached header this account has, across every mailbox, as
/// classification input. Read from `custody.db` — it was one directory
/// listing per mailbox plus a read per sidecar file (73k of them on a real
/// vault).
fn load_emails_all_mailboxes(
    state: &Arc<DaemonState>,
    account_id: &str,
) -> Vec<classification::EmailForClassification> {
    let read = crate::custody::with_conn(state, |conn| {
        let mut out = Vec::new();
        for (_, mailbox) in cache::mailboxes_with_headers(conn, Some(account_id))? {
            for header in cache::all_headers(conn, account_id, &mailbox)? {
                let mut email = email_from_header(&header);
                // Tag each email with its mailbox so the snapshot records the
                // correct folder.
                email.mailbox = mailbox.clone();
                out.push(email);
            }
        }
        Ok(out)
    });
    match read {
        Ok(emails) => emails,
        Err(e) => {
            warn!("[classification] cached-header read failed for {account_id}: {e}");
            Vec::new()
        }
    }
}

/// One cached header row → classification input.
fn email_from_header(val: &serde_json::Value) -> classification::EmailForClassification {
    let uid = val.get("uid").and_then(|v| v.as_u64()).unwrap_or(0);
    let message_id = val.get("messageId").and_then(|v| v.as_str()).map(String::from);
    let subject = val.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let date = val.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // from is an object { name, address }
    let from_addr = val.get("from").and_then(|f| f.get("address")).and_then(|v| v.as_str()).unwrap_or("");
    let from_name = val.get("from").and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("");
    let from = if from_name.is_empty() { from_addr.to_string() } else { format!("{} <{}>", from_name, from_addr) };

    // reply_to is an object { name, address } — check if it differs from from
    let reply_to_addr = val.get("replyTo").and_then(|r| r.get("address")).and_then(|v| v.as_str()).unwrap_or("");
    let reply_to_differs = !reply_to_addr.is_empty() && !reply_to_addr.eq_ignore_ascii_case(from_addr);

    let to_count = val.get("to").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let has_attachments = val.get("hasAttachments").and_then(|v| v.as_bool()).unwrap_or(false);
    let size = val.get("size").and_then(|v| v.as_u64()).map(|s| s as u32);
    let in_reply_to = val.get("inReplyTo").and_then(|v| v.as_str()).map(String::from);
    let list_unsubscribe_val = val.get("listUnsubscribe").and_then(|v| v.as_str()).unwrap_or("");
    let list_unsubscribe = !list_unsubscribe_val.is_empty();
    let list_id = val.get("listId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
    let precedence = val.get("precedence").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);

    classification::EmailForClassification {
        uid,
        message_id,
        subject,
        from,
        date,
        body_preview: String::new(),
        mailbox: String::new(),
        to_count,
        has_attachments,
        size,
        in_reply_to,
        list_unsubscribe,
        list_id,
        precedence,
        reply_to_differs,
    }
}

// ── Classification Worker ─────────────────────────────────────────────────

/// Start the background classification worker. Call once after DaemonState is created.
pub(crate) fn start_classification_worker(state: Arc<DaemonState>) {
    // Learned rules, models and classification results are app state, not mail.
    let load_rules = rules_loader(state.app_dir.clone());
    let state_clone = Arc::clone(&state);

    tokio::spawn(async move {
        run_classification_worker(state_clone, load_rules).await;
    });
}

/// The worker's view of an account's learned rules, read from
/// `<app_dir>/ai-feedback/<accountId>.json` (what `learning.*` writes). Only
/// that account's file: a rule learned on one account never sorts another's
/// mail. A rule that cannot be applied safely is skipped without a log line.
/// The worker calls it once per account per pass and keeps the parsed rules.
fn rules_loader(data_dir: std::path::PathBuf) -> Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync> {
    Arc::new(move |account_id: &str| {
        mailvault_core::learned_rules::parse_all(&learning::load_feedback(&data_dir, account_id).rules)
    })
}

/// Flush a classification batch once it reaches this many messages.
/// `classification.summary` and `.results` read the file, so the UI can lag the
/// worker by up to this many messages — acceptable next to rewriting the whole
/// account file (plus a rename) once per message.
// ponytail: a flat 50; make it adaptive only if a run ever looks laggy.
const FLUSH_BATCH: usize = 50;

/// Classified-but-not-yet-saved messages, per account.
type PendingBatches = HashMap<String, HashMap<String, classification::EmailClassification>>;

/// Write one account's pending classifications. A failed write keeps the batch
/// in memory for the next flush point — dropping it would lose every message it
/// carries for the life of the process.
async fn flush_account(
    state: &DaemonState,
    batches: &mut PendingBatches,
    account_id: &str,
) {
    let Some(batch) = batches.get(account_id).cloned() else { return };
    if batch.is_empty() {
        batches.remove(account_id);
        return;
    }
    // Only the batch is written. The worker once wrote back everything it had
    // ever seen, which put back every row `classification::forget_at` took
    // out for mail the server no longer has: Cleanup listed it forever.
    match classification::save_classifications(&state.app_dir, account_id, &batch) {
        Ok(()) => {
            batches.remove(account_id);
        }
        Err(e) => {
            warn!(
                "[queue-worker] Failed to save {} classifications for {}: {} — keeping them for the next flush",
                batch.len(),
                account_id,
                e
            );
            state.classification.progress.lock().await.status =
                classification::PipelineStatus::Failed(e);
        }
    }
}

async fn flush_all(
    state: &DaemonState,
    batches: &mut PendingBatches,
) {
    for account_id in batches.keys().cloned().collect::<Vec<_>>() {
        flush_account(state, batches, &account_id).await;
    }
}

/// Inline worker loop that processes the queue via DaemonState.
async fn run_classification_worker(
    state: Arc<DaemonState>,
    load_rules: Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync>,
) {
    info!("[queue-worker] Classification worker started");
    let mut batches: PendingBatches = HashMap::new();
    // Each account's rules, read once per pass (until the queue drains), not
    // once per message, and read again as soon as `learning.*` changes them.
    let mut rule_cache: HashMap<String, Arc<Vec<classification::LearnedRule>>> = HashMap::new();
    let mut rules_seen = state.classification.rules_generation.load(std::sync::atomic::Ordering::SeqCst);

    loop {
        // Wait for items
        if state.classification.queue_depth().await == 0 {
            rule_cache.clear();
            flush_all(&state, &mut batches).await;
            {
                let mut progress = state.classification.progress.lock().await;
                if progress.status == classification::PipelineStatus::Running && batches.is_empty() {
                    progress.status = classification::PipelineStatus::Complete;
                    progress.phase = "idle".to_string();
                }
            }
            state.classification.notify.notified().await;
        }

        // Check cancel flag
        {
            let mut cancel = state.classification.cancel_flag.lock().await;
            if *cancel {
                *cancel = false;
                flush_all(&state, &mut batches).await;
                // Clear the queue via a temporary lock scope
                let depth = {
                    let mut queue = state.classification.queue.lock().await;
                    state.classification.queued_ids.lock().await.clear();
                    queue.clear();
                    state.classification.persist_queue_locked(&queue);
                    0
                };
                let mut progress = state.classification.progress.lock().await;
                progress.status = classification::PipelineStatus::Cancelled;
                progress.queue_depth = depth;
                progress.phase = "idle".to_string();
                info!("[queue-worker] Classification cancelled, queue cleared");
                continue;
            }
        }

        let item = match state.classification.pop_next().await {
            Some(item) => item,
            None => continue,
        };

        // Mark as running
        {
            let mut progress = state.classification.progress.lock().await;
            progress.account_id = item.account_id.clone();
            progress.status = classification::PipelineStatus::Running;
        }

        // Check if already classified (race between enqueue and processing).
        // The pending batch counts — it is not on disk yet. The store is asked
        // per message (one primary-key lookup, cheaper than the model read
        // below): a copy kept in memory never learned of rows forgotten since,
        // so a moved message was never classified at its new place.
        let pending = batches.get(&item.account_id);
        if pending.is_some_and(|b| b.contains_key(&item.message_id))
            || classification::is_classified(&state.app_dir, &item.account_id, &item.message_id)
        {
            let mut progress = state.classification.progress.lock().await;
            progress.classified += 1;
            continue;
        }

        let generation = state.classification.rules_generation.load(std::sync::atomic::Ordering::SeqCst);
        if generation != rules_seen {
            rule_cache.clear();
            rules_seen = generation;
        }
        let rules = Arc::clone(
            rule_cache
                .entry(item.account_id.clone())
                .or_insert_with(|| Arc::new(load_rules(&item.account_id))),
        );
        let model = classification::load_model(&state.app_dir, &item.account_id);
        let result = classification::classify_single_with_model(&item.email, &rules, model.as_ref());
        let was_rule = result.source == classification::ClassificationSource::LocalRule;

        let batch = batches.entry(item.account_id.clone()).or_default();
        batch.insert(item.message_id.clone(), result);
        let full = batch.len() >= FLUSH_BATCH;

        {
            let mut progress = state.classification.progress.lock().await;
            progress.classified += 1;
            if was_rule {
                progress.skipped_by_rules += 1;
            }
        }

        if full {
            flush_account(&state, &mut batches, &item.account_id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-worker-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn header(uid: u64) -> classification::EmailForClassification {
        classification::EmailForClassification {
            uid,
            message_id: Some(format!("<m{uid}@t>")),
            subject: format!("Subject {uid}"),
            from: "someone@example.test".into(),
            date: format!("2026-08-{uid:02}T00:00:00Z"),
            ..Default::default()
        }
    }

    fn no_rules() -> Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync> {
        Arc::new(|_| Vec::new())
    }

    /// The Outlook uid ledger used to sit beside the header sidecars and was
    /// fed to the classifier as a fabricated uid-0 message (Task 2.3 review
    /// M7). The headers are rows in `custody.db` now, so nothing in that
    /// directory can be mistaken for one — and the reader takes only what the
    /// header cache holds.
    #[test]
    fn only_cached_headers_are_fed_to_the_classifier() {
        let dir = scratch("classifier-rows");
        let conn = mailvault_core::custody::db::open(&dir).unwrap();
        mailvault_core::custody::cache::save_headers(
            &conn,
            "acc1",
            "INBOX",
            &json!({"totalEmails": 1, "emails": [{
                "uid": 7, "subject": "real", "from": {"address": "a@b.test"},
                "date": "2026-08-01T00:00:00Z", "to": [], "hasAttachments": false,
            }]})
            .to_string(),
        )
        .unwrap();
        // The ledger still lives in the sidecar directory; it is not a message.
        let cache = dir.join("email_cache").join("acc1_INBOX");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("graph_id_map.json"), json!({"7": "g-1"}).to_string()).unwrap();

        let emails: Vec<_> = mailvault_core::custody::cache::all_headers(&conn, "acc1", "INBOX")
            .unwrap()
            .iter()
            .map(email_from_header)
            .collect();

        assert_eq!(emails.len(), 1, "only the cached header is a message");
        assert_eq!(emails[0].uid, 7);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Poll the worker's progress for up to 5 s, then hand back whatever it says.
    async fn wait_for(
        state: &DaemonState,
        ready: impl Fn(&classification::ClassificationProgress) -> bool,
    ) -> classification::ClassificationProgress {
        for _ in 0..500 {
            {
                let progress = state.classification.progress.lock().await;
                if ready(&progress) {
                    return progress.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        state.classification.progress.lock().await.clone()
    }

    // ── The worker loop ────────────────────────────────────────────────

    /// Characterization: what a plain run has to keep doing once the saves are
    /// batched — every queued message classified, on disk, and reported done.
    #[tokio::test]
    async fn the_worker_classifies_every_queued_message_and_reports_complete() {
        let mail_dir = scratch("batch-mail");
        let app_dir = scratch("batch-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);

        let queued = state
            .classification
            .enqueue("acc1", (1..=3u64).map(header).collect(), classification::QueueTier::New)
            .await;
        assert_eq!(queued, 3);

        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), no_rules()));

        let progress = wait_for(&state, |p| p.status == classification::PipelineStatus::Complete).await;
        assert_eq!(progress.status, classification::PipelineStatus::Complete);
        assert_eq!(progress.classified, 3);
        assert_eq!(
            classification::load_classifications(&app_dir, "acc1").len(),
            3,
            "every classified message has to reach the account's file"
        );

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// A save that fails must not eat the messages it was carrying. The worker
    /// used to drop the item it had just classified and move on, so a transient
    /// bad path lost every message for the life of the process.
    ///
    /// The failure is injected with a directory sitting where `app.db` needs
    /// to be, not a permission bit: `Connection::open` cannot create a file
    /// there on either platform, where a read-only mode bit is a unix
    /// concept Windows ACLs do not map onto the same way.
    #[tokio::test]
    async fn a_failed_flush_keeps_its_messages_until_a_later_one_succeeds() {
        let mail_dir = scratch("flush-fail-mail");
        let app_dir = scratch("flush-fail-app");
        // Set before the state is built, or the store would already be open
        // (`ClassificationState::new` loads the persisted queue on
        // construction; a failed open there is tolerated as "no queue").
        let db_path = app_dir.join("app.db");
        std::fs::create_dir_all(&db_path).unwrap();

        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), no_rules()));

        state
            .classification
            .enqueue("acc1", vec![header(1), header(2)], classification::QueueTier::New)
            .await;

        let progress = wait_for(&state, |p| p.classified >= 2).await;
        assert_eq!(
            progress.classified, 2,
            "both messages are classified even though the save cannot land"
        );
        let progress = wait_for(&state, |p| matches!(p.status, classification::PipelineStatus::Failed(_))).await;
        assert!(
            matches!(progress.status, classification::PipelineStatus::Failed(_)),
            "a save that failed has to be reported, got {:?}",
            progress.status
        );

        // Give the path back and hand the worker one more message.
        std::fs::remove_dir(&db_path).unwrap();
        state
            .classification
            .enqueue("acc1", vec![header(3)], classification::QueueTier::New)
            .await;

        let mut saved = classification::load_classifications(&app_dir, "acc1");
        for _ in 0..500 {
            if saved.len() >= 3 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            saved = classification::load_classifications(&app_dir, "acc1");
        }
        assert_eq!(
            saved.len(),
            3,
            "the two messages the failed save was carrying must be retried, not dropped"
        );

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// The "already classified?" check asks the store, not a copy the worker
    /// read once: rows are taken out when the server loses their mail, and a
    /// copy never hears of it. Empty the account after the worker has seen
    /// three messages, then hand it one of them again: nothing is stored, so
    /// it is classified again (from its new, differently-classified body),
    /// and the flush writes only what it just did.
    #[tokio::test]
    async fn the_worker_asks_the_store_whether_a_message_is_classified() {
        let mail_dir = scratch("cache-mail");
        let app_dir = scratch("cache-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), no_rules()));

        state
            .classification
            .enqueue("acc1", (1..=3u64).map(header).collect(), classification::QueueTier::New)
            .await;
        let progress = wait_for(&state, |p| {
            p.classified == 3 && p.status == classification::PipelineStatus::Complete
        })
        .await;
        assert_eq!(progress.classified, 3);
        let saved = classification::load_classifications(&app_dir, "acc1");
        assert_eq!(saved.len(), 3);
        assert_eq!(saved["<m1@t>"].category, "personal");

        // Drop the stored rows. `load_classifications` answers "nothing
        // classified" for the account, which defeats the enqueue-side dedup
        // and lets <m1@t> reach the worker a second time.
        mailvault_core::app_db::with(&app_dir, |c| {
            mailvault_core::app_db::classify::replace_account(c, "acc1", &[])
        })
        .unwrap();

        let promotional = classification::EmailForClassification {
            uid: 1,
            message_id: Some("<m1@t>".into()),
            subject: "50% off — Flash Sale ends tonight!".into(),
            from: "deals@shop.test".into(),
            date: "2026-08-01T00:00:00Z".into(),
            ..Default::default()
        };
        let queued = state
            .classification
            .enqueue(
                "acc1",
                vec![promotional, header(4), header(5)],
                classification::QueueTier::New,
            )
            .await;
        assert_eq!(queued, 3, "the emptied account hides all three from the enqueue check");

        let progress = wait_for(&state, |p| {
            p.classified == 6 && p.status == classification::PipelineStatus::Complete
        })
        .await;
        assert_eq!(progress.classified, 6);

        let saved = classification::load_classifications(&app_dir, "acc1");
        assert_ne!(saved["<m1@t>"].category, "personal", "<m1@t> was classified again from its new body");
        assert_eq!(
            classification::keys_for_test(&app_dir, "acc1"),
            vec!["<m1@t>".to_string(), "<m4@t>".to_string(), "<m5@t>".to_string()],
            "the flush writes only what it just classified: <m2@t> and <m3@t> stay gone"
        );

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// Cleanup listed a Newsletter group again after deleting it: the next
    /// flush wrote back every row the worker had ever seen, including the ones
    /// forgotten for mail the server no longer has.
    #[tokio::test]
    async fn a_row_forgotten_after_a_delete_is_not_written_back_by_the_next_flush() {
        let mail_dir = scratch("forgotten-mail");
        let app_dir = scratch("forgotten-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), no_rules()));

        state.classification.enqueue("acc1", (1..=3u64).map(header).collect(), classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 3 && p.status == classification::PipelineStatus::Complete).await;

        classification::forget_at(&app_dir, "acc1", "INBOX", &[1, 2]);
        state.classification.enqueue("acc1", vec![header(4)], classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 4 && p.status == classification::PipelineStatus::Complete).await;

        assert_eq!(classification::keys_for_test(&app_dir, "acc1"), vec!["<m3@t>".to_string(), "<m4@t>".to_string()]);

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// A message moved to another folder keeps its Message-ID. The worker
    /// still remembers classifying it in INBOX; that row is gone, so it is
    /// classified again where it is now.
    #[tokio::test]
    async fn a_moved_message_is_classified_again_at_its_new_place() {
        let mail_dir = scratch("moved-mail");
        let app_dir = scratch("moved-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), no_rules()));

        state.classification.enqueue("acc1", vec![header(1)], classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 1 && p.status == classification::PipelineStatus::Complete).await;

        classification::forget_at(&app_dir, "acc1", "INBOX", &[1]);
        let moved = classification::EmailForClassification { uid: 40, mailbox: "Archive".into(), ..header(1) };
        state.classification.enqueue("acc1", vec![moved], classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 2 && p.status == classification::PipelineStatus::Complete).await;

        let saved = classification::load_classifications(&app_dir, "acc1");
        let snap = saved["<m1@t>"].snapshot.as_ref().expect("classified again");
        assert_eq!((snap.uid, snap.mailbox.as_str()), (40, "Archive"));

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// The worker's cache holds a copy of an override it read from the file.
    /// The user then overrides the same message AGAIN. A flush that re-emits
    /// the cached (older) override would revert the newer one — the file's
    /// override guard cannot help, because the incoming entry is itself an
    /// override. Overrides must never be written back from memory.
    #[tokio::test]
    async fn a_newer_override_is_not_reverted_by_the_workers_stale_copy() {
        let mail_dir = scratch("stale-override-mail");
        let app_dir = scratch("stale-override-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);

        // An override already on disk before the worker ever touches acc1.
        let mut seed = HashMap::new();
        seed.insert(
            "<m1@t>".to_string(),
            classification::classify_single(&header(1), &[]),
        );
        classification::save_classifications(&app_dir, "acc1", &seed).unwrap();
        classification::override_classification(&app_dir, "acc1", "<m1@t>", Some("work"), None, None).unwrap();

        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), no_rules()));
        state
            .classification
            .enqueue("acc1", vec![header(2)], classification::QueueTier::New)
            .await;
        wait_for(&state, |p| p.classified == 1 && p.status == classification::PipelineStatus::Complete).await;

        // The user changes their mind while the worker holds the old override.
        classification::override_classification(&app_dir, "acc1", "<m1@t>", Some("finance"), None, None).unwrap();

        state
            .classification
            .enqueue("acc1", vec![header(3)], classification::QueueTier::New)
            .await;
        wait_for(&state, |p| p.classified == 2 && p.status == classification::PipelineStatus::Complete).await;

        let saved = classification::load_classifications(&app_dir, "acc1");
        assert_eq!(
            saved["<m1@t>"].category, "finance",
            "a flush must not write the worker's stale copy of an override over the newer one"
        );
        assert_eq!(saved.len(), 3);

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    // ── Learned rules ──────────────────────────────────────────────────

    /// Store a correction exactly as `learning.record_correction` does.
    fn correct(app_dir: &std::path::Path, account: &str, from: &str, subject: &str, category: &str, action: &str) -> serde_json::Value {
        let mut fb = learning::load_feedback(app_dir, account);
        let out = learning::record_correction(
            &mut fb,
            &json!({ "messageId": format!("<{subject}@x>"), "from": from, "subject": subject }),
            &json!({ "originalCategory": "personal", "correctedCategory": category, "correctedAction": action }),
            1_760_000_000_000,
        );
        learning::save_feedback(app_dir, account, &fb).unwrap();
        out
    }

    fn mail(uid: u64, from: &str, subject: &str) -> classification::EmailForClassification {
        classification::EmailForClassification {
            uid,
            message_id: Some(format!("<r{uid}@t>")),
            subject: subject.into(),
            from: from.into(),
            date: "2026-08-01T00:00:00Z".into(),
            ..Default::default()
        }
    }

    /// The bug: the classifier read rules as `{rule_type, pattern: {from_domain}}`
    /// while `learning.*` stores `{type, pattern: {fromDomain}}`, so every
    /// stored rule failed to parse and no correction ever changed a result.
    #[test]
    fn a_rule_learned_from_a_correction_reaches_the_classifier_and_wins() {
        let app_dir = scratch("learned-domain");
        let out = correct(&app_dir, "acc1", "Shop <news@shop.com>", "Weekly deals", "promotional", "archive");
        assert_eq!(out["ruleGenerated"], true);

        let rules = rules_loader(app_dir.clone())("acc1");
        assert_eq!(rules.len(), 1, "the stored rule must reach the classifier");

        let got = classification::classify_single(&mail(1, "Shop Team <offers@shop.com>", "Hello there"), &rules);
        assert_eq!(got.source, classification::ClassificationSource::LocalRule);
        assert_eq!(got.category, "promotional");
        assert_eq!(got.action, "archive");
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// The rule the Settings form builds, as JSON.stringify sends it (the
    /// `undefined` pattern fields are gone), saved through `learning.save_rule`.
    #[test]
    fn a_manual_rule_from_settings_reaches_the_classifier() {
        let app_dir = scratch("learned-manual");
        let mut fb = learning::Feedback::default();
        learning::save_rule(
            &mut fb,
            json!({
                "id": "r-1760000000000", "type": "sender-action",
                "pattern": { "fromAddress": "billing@acme.test", "subjectContains": "invoice" },
                "category": "invoices", "action": "review", "confidence": 0.95,
                "source": "manual", "createdAt": "2026-10-19T00:00:00.000Z",
            }),
        );
        learning::save_feedback(&app_dir, "acc1", &fb).unwrap();

        let rules = rules_loader(app_dir.clone())("acc1");
        let got = classification::classify_single(&mail(1, "Acme <billing@acme.test>", "Your Invoice for October"), &rules);
        assert_eq!((got.source, got.category.as_str()), (classification::ClassificationSource::LocalRule, "invoices"));
        let other = classification::classify_single(&mail(2, "Acme <billing@acme.test>", "Welcome"), &rules);
        assert_ne!(other.source, classification::ClassificationSource::LocalRule, "the subject word is required too");

        // Edited under Learned Rules: the form saves the whole rule back with
        // the new pattern (emptied fields dropped) and the merge replaces it.
        let mut fb = learning::load_feedback(&app_dir, "acc1");
        let mut edited = fb.rules[0].clone();
        edited["pattern"] = json!({ "fromDomain": "acme.test" });
        edited["category"] = json!("billing");
        learning::save_rule(&mut fb, edited);
        learning::save_feedback(&app_dir, "acc1", &fb).unwrap();
        let rules = rules_loader(app_dir.clone())("acc1");
        let got = classification::classify_single(&mail(3, "Acme Sales <sales@acme.test>", "Welcome"), &rules);
        assert_eq!((got.source, got.category.as_str()), (classification::ClassificationSource::LocalRule, "billing"));
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// Through the worker loop: a rule learned on acc1 sorts acc1's mail and
    /// leaves acc2's alone (each account's rules are its own file).
    #[tokio::test]
    async fn the_worker_applies_an_accounts_rules_to_that_account_only() {
        let mail_dir = scratch("learned-worker-mail");
        let app_dir = scratch("learned-worker-app");
        correct(&app_dir, "acc1", "news@shop.com", "Weekly deals", "promotional", "archive");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), rules_loader(app_dir.clone())));

        // Two Message-IDs: the queue's "already queued" set is keyed by
        // Message-ID alone, across accounts.
        state.classification.enqueue("acc1", vec![mail(1, "Shop <hello@shop.com>", "Hi")], classification::QueueTier::New).await;
        state.classification.enqueue("acc2", vec![mail(2, "Shop <hello@shop.com>", "Hi")], classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 2 && p.status == classification::PipelineStatus::Complete).await;

        let acc1 = classification::load_classifications(&app_dir, "acc1");
        assert_eq!(acc1["<r1@t>"].source, classification::ClassificationSource::LocalRule);
        assert_eq!(acc1["<r1@t>"].category, "promotional");
        let acc2 = classification::load_classifications(&app_dir, "acc2");
        assert_ne!(acc2["<r2@t>"].source, classification::ClassificationSource::LocalRule, "acc1's rule must not sort acc2's mail");

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// A rule that lands after a message was classified does not change that
    /// message on its own: only new mail, or a reclassify the user starts.
    #[tokio::test]
    async fn a_new_rule_does_not_reclassify_mail_already_sorted() {
        let mail_dir = scratch("learned-late-mail");
        let app_dir = scratch("learned-late-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), rules_loader(app_dir.clone())));

        state.classification.enqueue("acc1", vec![mail(1, "news@shop.com", "Hi")], classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 1 && p.status == classification::PipelineStatus::Complete).await;
        let before = classification::load_classifications(&app_dir, "acc1")["<r1@t>"].clone();
        assert_ne!(before.source, classification::ClassificationSource::LocalRule);

        correct(&app_dir, "acc1", "news@shop.com", "Weekly deals", "promotional", "archive");
        state
            .classification
            .enqueue("acc1", vec![mail(1, "news@shop.com", "Hi"), mail(2, "news@shop.com", "Hi again")], classification::QueueTier::New)
            .await;
        wait_for(&state, |p| p.classified >= 2 && p.status == classification::PipelineStatus::Complete).await;

        let after = classification::load_classifications(&app_dir, "acc1");
        assert_eq!(after["<r1@t>"].category, before.category, "already-sorted mail keeps its result");
        assert_eq!(after["<r1@t>"].source, before.source);
        assert_eq!(after["<r2@t>"].source, classification::ClassificationSource::LocalRule, "new mail follows the rule");
        assert_eq!(state.classification.queue_depth().await, 0, "learning a rule queues nothing by itself");

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// Settings' "add a category with a rule" saves the rule and then calls
    /// `classification.reclassify_all`, meant to reach mail sorted before it.
    /// It does not: `reclassify_all` force-queues the mail, but the worker
    /// skips every message `is_classified` already holds, so nothing already
    /// sorted changes. Kept as the reproducer; fixing it makes that Settings
    /// flow a real mass reclassify, the owner's call.
    #[tokio::test]
    #[ignore = "reclassify_all is a no-op for mail already classified (worker skips is_classified)"]
    async fn a_reclassify_after_a_rule_lands_re_sorts_mail_already_classified() {
        let mail_dir = scratch("learned-reclassify-mail");
        let app_dir = scratch("learned-reclassify-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        crate::custody::with_conn(&state, |c| {
            mailvault_core::custody::cache::save_headers(
                c,
                "acc1",
                "INBOX",
                &json!({"emails": [{
                    "uid": 1, "messageId": "<r1@t>", "subject": "Hi",
                    "from": {"name": "Shop", "address": "news@shop.com"},
                    "date": "2026-08-01T00:00:00Z", "to": [{"address": "me@t"}], "hasAttachments": false,
                }]})
                .to_string(),
            )
        })
        .unwrap();
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), rules_loader(app_dir.clone())));

        enqueue_for_classification(Arc::clone(&state), "acc1", classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 1 && p.status == classification::PipelineStatus::Complete).await;
        assert_ne!(classification::load_classifications(&app_dir, "acc1")["<r1@t>"].source, classification::ClassificationSource::LocalRule);

        correct(&app_dir, "acc1", "news@shop.com", "Weekly deals", "promotional", "archive");
        reclassify_all(Arc::clone(&state), "acc1".to_string()).await;
        wait_for(&state, |p| p.classified == 2 && p.status == classification::PipelineStatus::Complete).await;

        let after = &classification::load_classifications(&app_dir, "acc1")["<r1@t>"];
        assert_eq!((after.source.clone(), after.category.as_str()), (classification::ClassificationSource::LocalRule, "promotional"));

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// The worker reads and parses an account's rules once per pass, not once
    /// per message.
    #[tokio::test]
    async fn rules_are_loaded_once_per_account_per_pass() {
        let mail_dir = scratch("rules-once-mail");
        let app_dir = scratch("rules-once-app");
        correct(&app_dir, "acc1", "news@shop.com", "Weekly deals", "promotional", "archive");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let loads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let inner = rules_loader(app_dir.clone());
        let counting: Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync> = {
            let loads = Arc::clone(&loads);
            Arc::new(move |account: &str| {
                loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                inner(account)
            })
        };
        state
            .classification
            .enqueue("acc1", (1..=6u64).map(|uid| mail(uid, "news@shop.com", "Hi")).collect(), classification::QueueTier::New)
            .await;
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), counting));
        wait_for(&state, |p| p.classified == 6 && p.status == classification::PipelineStatus::Complete).await;

        assert_eq!(loads.load(std::sync::atomic::Ordering::SeqCst), 1, "one load for six messages of one account");
        let saved = classification::load_classifications(&app_dir, "acc1");
        assert!(saved.values().all(|c| c.source == classification::ClassificationSource::LocalRule), "every message still follows the rule");

        // A later pass reads the file again, so a rule learned in between applies.
        correct(&app_dir, "acc1", "a@other-shop.test", "Receipt", "transactional", "keep");
        state.classification.enqueue("acc1", vec![mail(7, "a@other-shop.test", "Hi")], classification::QueueTier::New).await;
        wait_for(&state, |p| p.classified == 7 && p.status == classification::PipelineStatus::Complete).await;
        assert_eq!(loads.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(classification::load_classifications(&app_dir, "acc1")["<r7@t>"].category, "transactional");

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// A loader that, the first time it is asked, runs one `learning.*` call
    /// as the app would, after reading the rules: the change lands while the
    /// pass is under way.
    fn loader_that_changes_rules_once(
        state: &Arc<DaemonState>,
        method: &'static str,
        params: serde_json::Value,
    ) -> Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync> {
        let inner = rules_loader(state.app_dir.clone());
        let state = Arc::clone(state);
        let first = std::sync::atomic::AtomicBool::new(true);
        Arc::new(move |account: &str| {
            let rules = inner(account);
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let resp = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current()
                        .block_on(crate::server::handle_request_for_test(&state, method, params.clone()))
                });
                assert!(resp.error.is_none(), "{method}: {:?}", resp.error.map(|e| e.message));
            }
            rules
        })
    }

    fn rule_sorted(app_dir: &std::path::Path) -> usize {
        classification::load_classifications(app_dir, "acc1")
            .values()
            .filter(|c| c.source == classification::ClassificationSource::LocalRule)
            .count()
    }

    /// A correction made while a long first pass runs applies to the rest of
    /// that pass: messages classified without it are never looked at again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_rule_saved_mid_pass_applies_to_the_rest_of_the_pass() {
        let mail_dir = scratch("mid-pass-save-mail");
        let app_dir = scratch("mid-pass-save-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        state
            .classification
            .enqueue("acc1", (1..=4u64).map(|uid| mail(uid, "news@shop.com", "Hi")).collect(), classification::QueueTier::New)
            .await;
        let loader = loader_that_changes_rules_once(
            &state,
            "learning.record_correction",
            json!({
                "accountId": "acc1",
                "email": { "messageId": "<c@x>", "from": "news@shop.com", "subject": "Weekly deals" },
                "correction": { "originalCategory": "personal", "correctedCategory": "promotional", "correctedAction": "archive" },
            }),
        );
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), loader));
        wait_for(&state, |p| p.classified == 4 && p.status == classification::PipelineStatus::Complete).await;

        assert_eq!(rule_sorted(&app_dir), 3, "only the message classified before the correction misses it");

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_rule_deleted_mid_pass_stops_applying_in_that_pass() {
        let mail_dir = scratch("mid-pass-delete-mail");
        let app_dir = scratch("mid-pass-delete-app");
        let out = correct(&app_dir, "acc1", "news@shop.com", "Weekly deals", "promotional", "archive");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        state
            .classification
            .enqueue("acc1", (1..=4u64).map(|uid| mail(uid, "news@shop.com", "Hi")).collect(), classification::QueueTier::New)
            .await;
        let loader = loader_that_changes_rules_once(
            &state,
            "learning.delete_rule",
            json!({ "accountId": "acc1", "ruleId": out["rule"]["id"] }),
        );
        let worker = tokio::spawn(run_classification_worker(Arc::clone(&state), loader));
        wait_for(&state, |p| p.classified == 4 && p.status == classification::PipelineStatus::Complete).await;

        assert_eq!(rule_sorted(&app_dir), 1, "only the message classified before the delete follows the rule");

        worker.abort();
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// Five results a single rule produced, no overrides: training on them
    /// made a one-category model that then called EVERY message that
    /// category at 0.95, ahead of bootstrap and heuristics.
    #[test]
    fn rule_results_never_train_a_one_category_model() {
        let mail_dir = scratch("poison-mail");
        let app_dir = scratch("poison-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);
        let emails: Vec<_> = (1..=5u64)
            .map(|uid| json!({
                "uid": uid, "messageId": format!("<m{uid}@t>"), "subject": format!("Deals {uid}"),
                "from": {"name": "Shop", "address": "news@shop.com"},
                "date": format!("2026-08-0{uid}T00:00:00Z"), "to": [{"address": "me@t"}], "hasAttachments": false,
            }))
            .collect();
        crate::custody::with_conn(&state, |c| {
            mailvault_core::custody::cache::save_headers(c, "acc1", "INBOX", &json!({"emails": emails}).to_string())
        })
        .unwrap();
        let mut results = HashMap::new();
        for uid in 1..=5u64 {
            let mut c = classification::classify_single(&header(uid), &[]);
            c.category = "promotional".into();
            c.source = classification::ClassificationSource::LocalRule;
            results.insert(format!("<m{uid}@t>"), c);
        }
        classification::save_classifications(&app_dir, "acc1", &results).unwrap();

        retrain_model(&state, "acc1");

        let model = classification::load_model(&app_dir, "acc1");
        assert!(
            model.as_ref().map_or(true, |m| m.category_priors.len() >= 2),
            "rule results must not become a one-category model: {:?}",
            model.map(|m| m.category_priors.keys().cloned().collect::<Vec<_>>())
        );

        // A model already saved stays as it is when there is too little to retrain on.
        let labeled: Vec<_> = (1..=6u64).map(|uid| (header(uid), if uid <= 3 { "work" } else { "personal" }.to_string())).collect();
        let kept = classification::train_checked(&labeled).expect("two categories of three train");
        classification::save_model(&app_dir, "acc1", &kept).unwrap();
        retrain_model(&state, "acc1");
        assert_eq!(classification::load_model(&app_dir, "acc1").map(|m| m.trained_at), Some(kept.trained_at));
        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }

    // ── Reclassify with a relocated vault ──────────────────────────────

    #[tokio::test]
    async fn reclassify_with_a_relocated_vault_keeps_overrides_and_saves_the_model_in_the_app_dir() {
        let mail_dir = scratch("reclassify-mail");
        let app_dir = scratch("reclassify-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);

        // Eight cached headers in the vault's store, every one of them a
        // newsletter by header cues so bootstrap labelling would also fire.
        let emails: Vec<_> = (1..=8u64)
            .map(|uid| {
                json!({
                    "uid": uid,
                    "messageId": format!("<m{uid}@t>"),
                    "subject": format!("Weekly digest {uid}"),
                    "from": {"name": "List", "address": "news@list.test"},
                    "date": format!("2026-08-0{uid}T00:00:00Z"),
                    "to": [{"address": "me@t"}],
                    "hasAttachments": false,
                    "listUnsubscribe": "<mailto:u@list.test>",
                    "listId": "<digest.list.test>",
                })
            })
            .collect();
        crate::custody::with_conn(&state, |c| {
            mailvault_core::custody::cache::save_headers(c, "acc1", "INBOX", &json!({"emails": emails}).to_string())
        })
        .unwrap();

        // Five user overrides in the APP dir: both the label source for the
        // retrain and the set that must survive the reclassify. Two
        // categories: a model of one is never trained.
        let mut overrides = HashMap::new();
        for uid in 1..=5u64 {
            overrides.insert(
                format!("<m{uid}@t>"),
                classification::EmailClassification {
                    category: if uid <= 3 { "work" } else { "personal" }.into(),
                    importance: "normal".into(),
                    action: "read".into(),
                    confidence: 1.0,
                    classified_at: "2026-08-10T00:00:00Z".into(),
                    model_used: "user-override".into(),
                    source: classification::ClassificationSource::UserOverride,
                    snapshot: None,
                },
            );
        }
        classification::save_classifications(&app_dir, "acc1", &overrides).unwrap();

        reclassify_all(Arc::clone(&state), "acc1".to_string()).await;

        assert!(
            classification::load_model(&app_dir, "acc1").is_some(),
            "the retrained model must land in the app store, where the worker loads it"
        );
        assert!(
            !mail_dir.join("app.db").exists(),
            "nothing about the model belongs in the relocatable vault"
        );
        assert_eq!(
            state.classification.queue_depth().await,
            3,
            "the five user overrides must not be re-queued"
        );

        let _ = std::fs::remove_dir_all(&mail_dir);
        let _ = std::fs::remove_dir_all(&app_dir);
    }
}
