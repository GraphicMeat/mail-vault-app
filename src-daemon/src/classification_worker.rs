//! Background classification worker and the cached-header readers it feeds on.

use crate::classification;
use crate::learning;
use crate::server::DaemonState;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tracing::{info, warn};

/// Retrain from the current labels, then force-enqueue everything the user has
/// not overridden. Split out of the handler so a test can await it.
pub(crate) async fn reclassify_all(state: Arc<DaemonState>, account_id: String) {
    // 1. Retrain model with current labeled data. Labels and the model live in
    // the app dir; only the cached headers come from the (relocatable) vault.
    retrain_model(&state.data_dir, &state.app_dir, &account_id);

    // 2. Force-enqueue all emails (bypasses "already classified" check)
    let emails = load_emails_all_mailboxes(&state.data_dir, &account_id);
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

/// Retrain the Naive Bayes model using user overrides and local rules applied to cached emails.
fn retrain_model(mail_dir: &Path, app_dir: &Path, account_id: &str) {
    let classifications = classification::load_classifications(app_dir, account_id);
    let emails = load_emails_all_mailboxes(mail_dir, account_id);

    // Build labeled data from user overrides and local rules
    let mut labeled: Vec<(classification::EmailForClassification, String)> = Vec::new();

    // Map emails by message_id for lookup
    let email_map: HashMap<String, &classification::EmailForClassification> = emails
        .iter()
        .filter_map(|e| e.message_id.as_ref().map(|mid| (mid.clone(), e)))
        .collect();

    for (mid, cls) in &classifications {
        // Only use high-quality labels: user overrides and local rules
        if cls.source != classification::ClassificationSource::UserOverride
            && cls.source != classification::ClassificationSource::LocalRule
        {
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

    if labeled.len() < 5 {
        info!("[retrain] Not enough labeled data ({}) to train model for {}", labeled.len(), account_id);
        return;
    }

    let model = classification::NaiveBayesModel::train(&labeled);
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
    let emails = load_emails_all_mailboxes(&state.data_dir, account_id);
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

/// Discover all cached mailboxes for an account and load emails from each.
fn load_emails_all_mailboxes(
    data_dir: &Path,
    account_id: &str,
) -> Vec<classification::EmailForClassification> {
    let cache_dir = data_dir.join("email_cache");
    let prefix = format!(
        "{}_",
        account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
    );

    let entries = match std::fs::read_dir(&cache_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut all_emails = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) || !entry.path().is_dir() {
            continue;
        }
        // Extract mailbox name from dir name: {sanitized_account}_{sanitized_mailbox}
        let mailbox = &name[prefix.len()..];
        let mut emails = load_emails_for_classification(data_dir, account_id, mailbox);
        // Tag each email with its mailbox so the snapshot records the correct folder
        for email in &mut emails {
            email.mailbox = mailbox.to_string();
        }
        all_emails.append(&mut emails);
    }

    all_emails
}

/// Read cached email JSON files and convert to EmailForClassification.
fn load_emails_for_classification(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
) -> Vec<classification::EmailForClassification> {
    let cache_dir = data_dir
        .join("email_cache")
        .join(format!(
            "{}_{}",
            account_id.replace(|c: char| !c.is_alphanumeric(), "_"),
            mailbox.replace(|c: char| !c.is_alphanumeric(), "_"),
        ));

    let entries = match std::fs::read_dir(&cache_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut emails = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name == "_meta.json" {
            continue;
        }

        let json = match std::fs::read_to_string(entry.path()) {
            Ok(j) => j,
            Err(_) => continue,
        };

        let val: serde_json::Value = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(_) => continue,
        };

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

        emails.push(classification::EmailForClassification {
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
        });
    }

    emails
}

// ── Classification Worker ─────────────────────────────────────────────────

/// Start the background classification worker. Call once after DaemonState is created.
pub(crate) fn start_classification_worker(state: Arc<DaemonState>) {
    // Learned rules, models and classification results are app state, not mail.
    let data_dir = state.app_dir.clone();
    let state_clone = Arc::clone(&state);

    let load_rules: Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync> = {
        Arc::new(move |account_id: &str| {
            let feedback = learning::load_feedback(&data_dir, account_id);
            feedback
                .rules
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
    };

    tokio::spawn(async move {
        run_classification_worker(state_clone, load_rules).await;
    });
}

/// Flush a classification batch once it reaches this many messages.
/// `classification.summary` and `.results` read the file, so the UI can lag the
/// worker by up to this many messages — acceptable next to rewriting the whole
/// account file (plus a rename) once per message.
// ponytail: a flat 50; make it adaptive only if a run ever looks laggy.
const FLUSH_BATCH: usize = 50;

/// Classified-but-not-yet-saved messages, per account.
type PendingBatches = HashMap<String, HashMap<String, classification::EmailClassification>>;

/// What each account's classifications file held when we first read it, plus
/// everything we have flushed into it since.
type KnownClassifications = PendingBatches;

/// Write one account's pending classifications. A failed write keeps the batch
/// in memory for the next flush point — dropping it would lose every message it
/// carries for the life of the process.
async fn flush_account(
    state: &DaemonState,
    batches: &mut PendingBatches,
    known: &mut KnownClassifications,
    account_id: &str,
) {
    let Some(batch) = batches.get(account_id).cloned() else { return };
    if batch.is_empty() {
        batches.remove(account_id);
        return;
    }
    let cached = known.entry(account_id.to_string()).or_default();
    // Write what we know with the batch folded in, so a file that lost entries
    // behind our back gets them back — minus the overrides we read: the file
    // may hold a NEWER override for the same message, and re-emitting ours
    // would revert it. They stay in the cache so the pre-check still counts
    // them as classified. save_classifications refuses to put anything
    // automatic over a user override, which covers the other direction.
    let mut to_write: HashMap<String, classification::EmailClassification> = cached
        .iter()
        .filter(|(_, e)| e.source != classification::ClassificationSource::UserOverride)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    to_write.extend(batch.iter().map(|(k, v)| (k.clone(), v.clone())));
    match classification::save_classifications(&state.app_dir, account_id, &to_write) {
        Ok(()) => {
            batches.remove(account_id);
            cached.extend(batch);
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
    known: &mut KnownClassifications,
) {
    for account_id in batches.keys().cloned().collect::<Vec<_>>() {
        flush_account(state, batches, known, &account_id).await;
    }
}

/// Inline worker loop that processes the queue via DaemonState.
async fn run_classification_worker(
    state: Arc<DaemonState>,
    load_rules: Arc<dyn Fn(&str) -> Vec<classification::LearnedRule> + Send + Sync>,
) {
    info!("[queue-worker] Classification worker started");
    let mut batches: PendingBatches = HashMap::new();
    let mut known: KnownClassifications = HashMap::new();

    loop {
        // Wait for items
        if state.classification.queue_depth().await == 0 {
            flush_all(&state, &mut batches, &mut known).await;
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
                flush_all(&state, &mut batches, &mut known).await;
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
        // The pending batch counts — it is not on disk yet. The file is read
        // once per account and never invalidated: save_classifications refuses
        // to put an automatic entry over a user override, so the worst a stale
        // copy can cost is one redundant automatic classification that the
        // flush then declines to write.
        let existing = known
            .entry(item.account_id.clone())
            .or_insert_with(|| classification::load_classifications(&state.app_dir, &item.account_id));
        let pending = batches.get(&item.account_id);
        if existing.contains_key(&item.message_id)
            || pending.is_some_and(|b| b.contains_key(&item.message_id))
        {
            let mut progress = state.classification.progress.lock().await;
            progress.classified += 1;
            continue;
        }

        let rules = load_rules(&item.account_id);
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
            flush_account(&state, &mut batches, &mut known, &item.account_id).await;
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
    #[tokio::test]
    async fn a_failed_flush_keeps_its_messages_until_a_later_one_succeeds() {
        let mail_dir = scratch("flush-fail-mail");
        let app_dir = scratch("flush-fail-app");
        // A FILE where the classifications directory belongs: create_dir_all,
        // and so every save, fails.
        std::fs::write(app_dir.join("classifications"), b"not a directory").unwrap();

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

        // Give the directory back and hand the worker one more message.
        std::fs::remove_file(app_dir.join("classifications")).unwrap();
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

    /// The "already classified?" check used to re-read and re-parse the whole
    /// account file for every popped item. Proof that it now reads once: make
    /// the file unreadable after the worker has warmed its copy, then hand it a
    /// message it has already seen. A worker that re-reads sees an empty file
    /// and classifies the message again — from the new, differently-classified
    /// body — and its flush writes only what it just did.
    #[tokio::test]
    async fn the_worker_does_not_re_read_the_file_per_item() {
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

        // Corrupt the file. load_classifications answers "nothing classified"
        // for it (unwrap_or_default), so it also defeats the enqueue-side dedup
        // and <m1@t> reaches the worker a second time.
        std::fs::write(
            app_dir.join("classifications").join("acc1.json"),
            b"{not json",
        )
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
        assert_eq!(queued, 3, "the corrupt file hides all three from the enqueue check");

        let progress = wait_for(&state, |p| {
            p.classified == 6 && p.status == classification::PipelineStatus::Complete
        })
        .await;
        assert_eq!(progress.classified, 6);

        let saved = classification::load_classifications(&app_dir, "acc1");
        assert_eq!(
            saved["<m1@t>"].category, "personal",
            "the worker knew <m1@t> was classified without re-reading the file"
        );
        assert_eq!(
            saved.len(),
            5,
            "the flush writes what the worker knows, so the corrupt file loses nothing"
        );
        assert!(saved.contains_key("<m4@t>") && saved.contains_key("<m5@t>"));

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

    // ── Reclassify with a relocated vault ──────────────────────────────

    #[tokio::test]
    async fn reclassify_with_a_relocated_vault_keeps_overrides_and_saves_the_model_in_the_app_dir() {
        let mail_dir = scratch("reclassify-mail");
        let app_dir = scratch("reclassify-app");
        let state = DaemonState::for_test(mail_dir.clone(), app_dir.clone(), true);

        // Eight cached headers in the vault, every one of them a newsletter by
        // header cues so bootstrap labelling would also fire.
        let cache = mail_dir.join("email_cache").join("acc1_INBOX");
        std::fs::create_dir_all(&cache).unwrap();
        for uid in 1..=8u64 {
            let sidecar = json!({
                "uid": uid,
                "messageId": format!("<m{uid}@t>"),
                "subject": format!("Weekly digest {uid}"),
                "from": {"name": "List", "address": "news@list.test"},
                "date": format!("2026-08-0{uid}T00:00:00Z"),
                "to": [{"address": "me@t"}],
                "hasAttachments": false,
                "listUnsubscribe": "<mailto:u@list.test>",
                "listId": "<digest.list.test>",
            });
            std::fs::write(cache.join(format!("{uid}.json")), sidecar.to_string()).unwrap();
        }

        // Five user overrides in the APP dir — both the label source for the
        // retrain and the set that must survive the reclassify.
        let mut overrides = HashMap::new();
        for uid in 1..=5u64 {
            overrides.insert(
                format!("<m{uid}@t>"),
                classification::EmailClassification {
                    category: "work".into(),
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
            app_dir.join("classification_models").join("acc1.json").exists(),
            "the retrained model must land in the app dir, where the worker loads it"
        );
        assert!(
            !mail_dir.join("classification_models").exists(),
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
