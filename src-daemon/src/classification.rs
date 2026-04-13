use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use tokio::sync::{Mutex, Notify};
use tracing::{info, warn};

// ── Classification Data ────────────────────────────────────────────────────

/// Classification result for a single email.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailClassification {
    pub category: String,
    pub importance: String,
    pub action: String,
    pub confidence: f64,
    pub classified_at: String,
    pub model_used: String,
    #[serde(default)]
    pub source: ClassificationSource,
    /// Snapshot of email metadata at classification time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<EmailSnapshot>,
}

/// Frozen copy of email metadata stored alongside the classification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailSnapshot {
    pub uid: u64,
    pub subject: String,
    pub from: String,
    pub date: String,
    #[serde(default)]
    pub mailbox: String,
}

/// Where the classification came from.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub enum ClassificationSource {
    #[default]
    Llm,
    LocalRule,
    UserOverride,
}

/// Lightweight email representation for classification.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EmailForClassification {
    pub uid: u64,
    pub message_id: Option<String>,
    pub subject: String,
    pub from: String,
    pub date: String,
    #[serde(default)]
    pub body_preview: String,
    #[serde(default)]
    pub mailbox: String,
    #[serde(default)]
    pub to_count: usize,
    #[serde(default)]
    pub has_attachments: bool,
    #[serde(default)]
    pub size: Option<u32>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub list_unsubscribe: bool,
    #[serde(default)]
    pub list_id: Option<String>,
    #[serde(default)]
    pub precedence: Option<String>,
    #[serde(default)]
    pub reply_to_differs: bool,
}

// ── Classification Storage ─────────────────────────────────────────────────

fn classifications_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("classifications")
}

fn classifications_path(data_dir: &Path, account_id: &str) -> PathBuf {
    classifications_dir(data_dir).join(format!("{}.json", account_id))
}

/// Load all classifications for an account.
pub fn load_classifications(
    data_dir: &Path,
    account_id: &str,
) -> HashMap<String, EmailClassification> {
    let path = classifications_path(data_dir, account_id);
    if !path.exists() {
        return HashMap::new();
    }

    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(e) => {
            warn!("Failed to read classifications for {}: {}", account_id, e);
            HashMap::new()
        }
    }
}

/// Save classifications for an account (merges with existing).
pub fn save_classifications(
    data_dir: &Path,
    account_id: &str,
    new_entries: &HashMap<String, EmailClassification>,
) -> Result<(), String> {
    let dir = classifications_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let mut existing = load_classifications(data_dir, account_id);
    existing.extend(new_entries.clone());

    let json = serde_json::to_string_pretty(&existing)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    let path = classifications_path(data_dir, account_id);
    fs::write(&path, json).map_err(|e| format!("Failed to write: {}", e))?;

    info!(
        "Saved {} classifications for {} (total: {})",
        new_entries.len(),
        account_id,
        existing.len()
    );
    Ok(())
}

/// Save a single classification result (append to existing file).
pub fn save_single_classification(
    data_dir: &Path,
    account_id: &str,
    message_id: &str,
    classification: &EmailClassification,
) -> Result<(), String> {
    let dir = classifications_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let mut existing = load_classifications(data_dir, account_id);
    existing.insert(message_id.to_string(), classification.clone());

    let json = serde_json::to_string_pretty(&existing)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    let path = classifications_path(data_dir, account_id);
    fs::write(&path, json).map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

/// Build summary from pre-loaded classifications (avoids double read).
pub fn build_summary(classifications: &HashMap<String, EmailClassification>) -> ClassificationSummary {
    let mut by_category: HashMap<String, usize> = HashMap::new();
    let mut by_action: HashMap<String, usize> = HashMap::new();
    let mut by_importance: HashMap<String, usize> = HashMap::new();

    for c in classifications.values() {
        *by_category.entry(c.category.clone()).or_default() += 1;
        *by_action.entry(c.action.clone()).or_default() += 1;
        *by_importance.entry(c.importance.clone()).or_default() += 1;
    }

    ClassificationSummary {
        total: classifications.len(),
        by_category,
        by_action,
        by_importance,
    }
}

/// Get classification summary (counts by category).
pub fn get_summary(
    data_dir: &Path,
    account_id: &str,
) -> ClassificationSummary {
    let classifications = load_classifications(data_dir, account_id);
    build_summary(&classifications)
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassificationSummary {
    pub total: usize,
    pub by_category: HashMap<String, usize>,
    pub by_action: HashMap<String, usize>,
    pub by_importance: HashMap<String, usize>,
}

/// Update a single classification (user override).
pub fn override_classification(
    data_dir: &Path,
    account_id: &str,
    message_id: &str,
    category: Option<&str>,
    importance: Option<&str>,
    action: Option<&str>,
) -> Result<EmailClassification, String> {
    let mut all = load_classifications(data_dir, account_id);

    let entry = all.get(message_id).cloned().ok_or_else(|| {
        format!("No classification found for message {}", message_id)
    })?;

    let updated = EmailClassification {
        category: category.unwrap_or(&entry.category).to_string(),
        importance: importance.unwrap_or(&entry.importance).to_string(),
        action: action.unwrap_or(&entry.action).to_string(),
        confidence: 1.0, // User override = full confidence
        classified_at: chrono::Utc::now().to_rfc3339(),
        model_used: "user-override".to_string(),
        source: ClassificationSource::UserOverride,
        snapshot: entry.snapshot.clone(),
    };

    all.insert(message_id.to_string(), updated.clone());

    let dir = classifications_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let json = serde_json::to_string_pretty(&all)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    let path = classifications_path(data_dir, account_id);
    fs::write(&path, json).map_err(|e| format!("Failed to write: {}", e))?;

    Ok(updated)
}

// ── Classification Queue ──────────────────────────────────────────────────

/// Which tier a queued email belongs to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum QueueTier {
    /// Newly fetched emails — processed first, newest to oldest.
    New,
    /// Older unclassified backlog — processed after all New items drain.
    Backfill,
}

/// A single item in the classification queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueItem {
    pub account_id: String,
    pub message_id: String,
    pub tier: QueueTier,
    pub email: EmailForClassification,
}

/// Persistent on-disk representation of the queue.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedQueue {
    items: Vec<QueueItem>,
}

fn queue_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("classification_queue")
}

fn queue_path(data_dir: &Path) -> PathBuf {
    queue_dir(data_dir).join("queue.json")
}

// ── Classification Pipeline State ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ClassificationProgress {
    pub account_id: String,
    pub status: PipelineStatus,
    pub classified: usize,
    pub total: usize,
    pub skipped_by_rules: usize,
    pub queue_depth: usize,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PipelineStatus {
    Idle,
    Running,
    Complete,
    Failed(String),
    Cancelled,
}

pub struct ClassificationState {
    pub progress: Mutex<ClassificationProgress>,
    pub cancel_flag: Mutex<bool>,
    /// The classification queue: [New-tier items] ++ [Backfill-tier items].
    pub queue: Mutex<VecDeque<QueueItem>>,
    /// Set of message_ids currently in the queue (for dedup).
    pub queued_ids: Mutex<HashSet<String>>,
    /// Notify the background worker that new items are available.
    pub notify: Notify,
    /// Data directory for queue persistence and classification storage.
    data_dir: PathBuf,
}

impl ClassificationState {
    pub fn new(data_dir: PathBuf) -> Self {
        // Try to load persisted queue
        let (queue, ids) = load_persisted_queue(&data_dir);
        let resumed = queue.len();
        let account_id = queue.front().map(|i| i.account_id.clone()).unwrap_or_default();
        let phase = if resumed > 0 {
            match queue.front().unwrap().tier {
                QueueTier::New => "new".to_string(),
                QueueTier::Backfill => "backfill".to_string(),
            }
        } else {
            "idle".to_string()
        };

        Self {
            progress: Mutex::new(ClassificationProgress {
                account_id,
                status: if resumed > 0 { PipelineStatus::Running } else { PipelineStatus::Idle },
                classified: 0,
                total: resumed,
                skipped_by_rules: 0,
                queue_depth: resumed,
                phase,
            }),
            cancel_flag: Mutex::new(false),
            queue: Mutex::new(queue),
            queued_ids: Mutex::new(ids),
            notify: Notify::new(),
            data_dir,
        }
    }

    /// Enqueue emails for classification, deduplicating against the queue and
    /// already-classified emails. New-tier items are inserted before any
    /// existing Backfill items. Within each tier, items are sorted newest-first.
    pub async fn enqueue(
        &self,
        account_id: &str,
        emails: Vec<EmailForClassification>,
        tier: QueueTier,
    ) -> usize {
        self.enqueue_inner(account_id, emails, tier, false).await
    }

    /// Force-enqueue emails for reclassification, bypassing the "already classified" check.
    /// Still deduplicates against items already in the queue.
    pub async fn enqueue_force(
        &self,
        account_id: &str,
        emails: Vec<EmailForClassification>,
        tier: QueueTier,
    ) -> usize {
        self.enqueue_inner(account_id, emails, tier, true).await
    }

    async fn enqueue_inner(
        &self,
        account_id: &str,
        emails: Vec<EmailForClassification>,
        tier: QueueTier,
        force: bool,
    ) -> usize {
        let existing = if force {
            HashMap::new() // skip classified check
        } else {
            load_classifications(&self.data_dir, account_id)
        };

        let mut queue = self.queue.lock().await;
        let mut ids = self.queued_ids.lock().await;

        // Filter: must have message_id, not already classified (unless force), not already queued
        let mut candidates: Vec<_> = emails
            .into_iter()
            .filter(|e| {
                let mid = e.message_id.as_deref().unwrap_or("");
                !mid.is_empty() && !existing.contains_key(mid) && !ids.contains(mid)
            })
            .collect();

        if candidates.is_empty() {
            return 0;
        }

        // Sort newest-first by date (descending)
        candidates.sort_by(|a, b| b.date.cmp(&a.date));

        let count = candidates.len();

        let new_items: Vec<QueueItem> = candidates
            .into_iter()
            .map(|e| {
                let mid = e.message_id.clone().unwrap_or_default();
                ids.insert(mid.clone());
                QueueItem {
                    account_id: account_id.to_string(),
                    message_id: mid,
                    tier,
                    email: e,
                }
            })
            .collect();

        match tier {
            QueueTier::New => {
                // Insert new-tier items before the first Backfill item
                let insert_pos = queue
                    .iter()
                    .position(|item| item.tier == QueueTier::Backfill)
                    .unwrap_or(queue.len());

                // Insert in order (newest first) at the found position
                for (i, item) in new_items.into_iter().enumerate() {
                    queue.insert(insert_pos + i, item);
                }
            }
            QueueTier::Backfill => {
                // Append backfill items at the end (already sorted newest-first)
                queue.extend(new_items);
            }
        }

        // Update progress
        {
            let mut progress = self.progress.lock().await;
            progress.queue_depth = queue.len();
            progress.total += count;
            if !queue.is_empty() {
                progress.phase = match queue.front().unwrap().tier {
                    QueueTier::New => "new".to_string(),
                    QueueTier::Backfill => "backfill".to_string(),
                };
            }
        }

        // Persist queue to disk
        self.persist_queue_locked(&queue);

        info!(
            "[queue] Enqueued {} {:?} emails for {} (queue depth: {})",
            count, tier, account_id, queue.len()
        );

        // Wake the worker
        self.notify.notify_one();

        count
    }

    /// Pop the next item from the queue.
    pub async fn pop_next(&self) -> Option<QueueItem> {
        let mut queue = self.queue.lock().await;
        let item = queue.pop_front()?;
        self.queued_ids.lock().await.remove(&item.message_id);

        // Update queue_depth and phase in progress
        {
            let mut progress = self.progress.lock().await;
            progress.queue_depth = queue.len();
            if let Some(front) = queue.front() {
                progress.phase = match front.tier {
                    QueueTier::New => "new".to_string(),
                    QueueTier::Backfill => "backfill".to_string(),
                };
            }
        }

        self.persist_queue_locked(&queue);
        Some(item)
    }

    /// Get current queue depth.
    pub async fn queue_depth(&self) -> usize {
        self.queue.lock().await.len()
    }

    pub fn persist_queue_locked(&self, queue: &VecDeque<QueueItem>) {
        let persisted = PersistedQueue {
            items: queue.iter().cloned().collect(),
        };
        let dir = queue_dir(&self.data_dir);
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = queue_path(&self.data_dir);
        if let Ok(json) = serde_json::to_string(&persisted) {
            let _ = fs::write(&path, json);
        }
    }
}

fn load_persisted_queue(data_dir: &Path) -> (VecDeque<QueueItem>, HashSet<String>) {
    let path = queue_path(data_dir);
    if !path.exists() {
        return (VecDeque::new(), HashSet::new());
    }
    match fs::read_to_string(&path) {
        Ok(json) => {
            if let Ok(persisted) = serde_json::from_str::<PersistedQueue>(&json) {
                let ids: HashSet<String> = persisted
                    .items
                    .iter()
                    .map(|item| item.message_id.clone())
                    .collect();
                let queue: VecDeque<QueueItem> = persisted.items.into();
                info!("[queue] Restored {} items from persisted queue", queue.len());
                return (queue, ids);
            }
            (VecDeque::new(), HashSet::new())
        }
        Err(_) => (VecDeque::new(), HashSet::new()),
    }
}

// ── Background Worker ─────────────────────────────────────────────────────

/// Classify a single email using learned rules, then Naive Bayes, then bootstrap, then default.
pub fn classify_single(
    email: &EmailForClassification,
    learned_rules: &[LearnedRule],
) -> EmailClassification {
    classify_single_with_model(email, learned_rules, None)
}

/// Classify with an optional Naive Bayes model.
pub fn classify_single_with_model(
    email: &EmailForClassification,
    learned_rules: &[LearnedRule],
    model: Option<&NaiveBayesModel>,
) -> EmailClassification {
    let snapshot = Some(EmailSnapshot {
        uid: email.uid,
        subject: email.subject.clone(),
        from: email.from.clone(),
        date: email.date.clone(),
        mailbox: if email.mailbox.is_empty() {
            "INBOX".to_string()
        } else {
            email.mailbox.clone()
        },
    });

    // 1. Learned rules (highest priority)
    if let Some(r) = apply_rules(email, learned_rules) {
        return EmailClassification {
            category: r.category,
            importance: r.importance,
            action: r.action,
            confidence: r.confidence,
            classified_at: chrono::Utc::now().to_rfc3339(),
            model_used: "local-rule".to_string(),
            source: ClassificationSource::LocalRule,
            snapshot,
        };
    }

    // 2. Naive Bayes model (if trained)
    if let Some(nb) = model {
        if nb.training_count > 0 {
            let tokens = tokenize(email);
            let (category, confidence) = nb.predict(&tokens);
            let action = default_action_for_category(&category).to_string();
            let importance = default_importance_for_category(&category).to_string();
            return EmailClassification {
                category,
                importance,
                action,
                confidence,
                classified_at: chrono::Utc::now().to_rfc3339(),
                model_used: "naive-bayes".to_string(),
                source: ClassificationSource::Llm,
                snapshot,
            };
        }
    }

    // 3. Bootstrap labeling (cold start)
    if let Some((category, confidence)) = bootstrap_label(email) {
        let action = default_action_for_category(category).to_string();
        let importance = default_importance_for_category(category).to_string();
        return EmailClassification {
            category: category.to_string(),
            importance,
            action,
            confidence,
            classified_at: chrono::Utc::now().to_rfc3339(),
            model_used: "bootstrap".to_string(),
            source: ClassificationSource::Llm,
            snapshot,
        };
    }

    // 4. Heuristic fallback
    let h = classify_by_heuristics(email);
    EmailClassification {
        category: h.category,
        importance: h.importance,
        action: h.action,
        confidence: h.confidence,
        classified_at: chrono::Utc::now().to_rfc3339(),
        model_used: "heuristic".to_string(),
        source: ClassificationSource::Llm,
        snapshot,
    }
}

// ── Legacy pipeline (kept for reference, no longer the primary path) ──────

/// Run the classification pipeline for an account.
/// Phase 1: user-learned rules. Phase 2: heuristic classifier for the rest.
/// No LLM needed — runs instantly on any machine.
pub async fn run_pipeline(
    data_dir: &Path,
    state: &ClassificationState,
    account_id: &str,
    emails: Vec<EmailForClassification>,
    learned_rules: &[LearnedRule],
) -> Result<usize, String> {
    let existing = load_classifications(data_dir, account_id);

    let unclassified: Vec<_> = emails
        .into_iter()
        .filter(|e| {
            let key = e.message_id.as_deref().unwrap_or("");
            !key.is_empty() && !existing.contains_key(key)
        })
        .collect();

    if unclassified.is_empty() {
        info!("All emails already classified for {}", account_id);
        return Ok(0);
    }

    {
        let mut progress = state.progress.lock().await;
        *progress = ClassificationProgress {
            account_id: account_id.to_string(),
            status: PipelineStatus::Running,
            classified: 0,
            total: unclassified.len(),
            skipped_by_rules: 0,
            queue_depth: 0,
            phase: "legacy".to_string(),
        };
        *state.cancel_flag.lock().await = false;
    }

    info!(
        "Starting classification of {} unclassified emails for {}",
        unclassified.len(),
        account_id
    );

    let mut new_classifications = HashMap::new();
    let mut rule_matches = 0;

    for email in &unclassified {
        if let Some(ref mid) = email.message_id {
            let result = classify_single(email, learned_rules);
            if result.source == ClassificationSource::LocalRule {
                rule_matches += 1;
            }
            new_classifications.insert(mid.clone(), result);
        }
    }

    {
        let mut progress = state.progress.lock().await;
        progress.skipped_by_rules = rule_matches;
        progress.classified = new_classifications.len();
    }

    info!(
        "{} matched learned rules, {} classified by heuristics",
        rule_matches,
        new_classifications.len() - rule_matches
    );

    if !new_classifications.is_empty() {
        save_classifications(data_dir, account_id, &new_classifications)?;
    }

    let total = new_classifications.len();
    {
        let mut progress = state.progress.lock().await;
        progress.status = PipelineStatus::Complete;
        progress.classified = total;
    }

    info!("Classification complete: {} emails classified for {}", total, account_id);
    Ok(total)
}

// ── Heuristic Classifier ──────────────────────────────────────────────────

/// Classify an email using sender patterns, subject keywords, and domain signals.
fn classify_by_heuristics(email: &EmailForClassification) -> RuleResult {
    let from_lower = email.from.to_lowercase();
    let subject_lower = email.subject.to_lowercase();
    let domain = from_lower.split('@').nth(1).unwrap_or("").split('>').next().unwrap_or("");

    // --- Newsletter signals ---
    if subject_lower.contains("newsletter")
        || subject_lower.contains("weekly digest")
        || subject_lower.contains("daily digest")
        || subject_lower.contains("unsubscribe")
        || domain.starts_with("news.")
        || domain.starts_with("newsletter.")
        || from_lower.contains("newsletter@")
        || from_lower.contains("digest@")
    {
        return RuleResult {
            category: "newsletter".into(),
            importance: "low".into(),
            action: "archive".into(),
            confidence: 0.85,
        };
    }

    // --- Promotional signals ---
    let promo_domains = [
        "marketing.", "promo.", "offers.", "deals.", "shop.", "store.",
        "email.shopify.com", "mail.beehiiv.com", "mailchimp.com",
        "sendgrid.net", "constantcontact.com", "hubspot.com",
        "klaviyo.com", "mailgun.org",
    ];
    let promo_keywords = [
        "sale", "discount", "% off", "limited time", "exclusive offer",
        "free shipping", "buy now", "don't miss", "special offer",
        "promo code", "coupon", "flash sale", "clearance",
    ];
    if promo_domains.iter().any(|d| domain.contains(d))
        || from_lower.contains("marketing@")
        || from_lower.contains("promo@")
        || from_lower.contains("offers@")
        || from_lower.contains("deals@")
        || promo_keywords.iter().any(|k| subject_lower.contains(k))
    {
        return RuleResult {
            category: "promotional".into(),
            importance: "low".into(),
            action: "archive".into(),
            confidence: 0.80,
        };
    }

    // --- Transactional signals ---
    let tx_domains = [
        "paypal.com", "stripe.com", "square.com", "venmo.com",
        "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com",
        "amazon.com", "apple.com", "google.com",
    ];
    let tx_keywords = [
        "receipt", "invoice", "payment", "order confirmation",
        "shipping confirmation", "delivery", "your order",
        "transaction", "billing", "subscription renew",
        "purchase", "refund",
    ];
    if tx_domains.iter().any(|d| domain.contains(d) || from_lower.contains(d))
        || from_lower.contains("receipt@")
        || from_lower.contains("billing@")
        || from_lower.contains("invoic")
        || from_lower.contains("payment@")
        || tx_keywords.iter().any(|k| subject_lower.contains(k))
    {
        return RuleResult {
            category: "transactional".into(),
            importance: "medium".into(),
            action: "keep".into(),
            confidence: 0.80,
        };
    }

    // --- Notification signals ---
    let notif_senders = [
        "noreply@", "no-reply@", "donotreply@", "do-not-reply@",
        "notifications@", "notify@", "alert@", "updates@",
        "info@", "support@", "team@", "hello@",
    ];
    let notif_keywords = [
        "notification", "alert", "reminder", "update",
        "verify your", "confirm your", "password reset",
        "security alert", "sign-in", "login", "two-factor",
        "has been", "was updated", "was created", "was deleted",
        "invitation", "invited you",
    ];
    if notif_senders.iter().any(|s| from_lower.contains(s))
        || notif_keywords.iter().any(|k| subject_lower.contains(k))
    {
        return RuleResult {
            category: "notification".into(),
            importance: "medium".into(),
            action: "archive".into(),
            confidence: 0.75,
        };
    }

    // --- Spam-likely signals ---
    let spam_keywords = [
        "congratulations", "you've won", "you have been selected",
        "claim your", "act now", "urgent", "wire transfer",
        "bitcoin", "crypto opportunity", "make money",
        "nigerian", "inheritance", "lottery",
    ];
    if spam_keywords.iter().any(|k| subject_lower.contains(k)) {
        return RuleResult {
            category: "spam-likely".into(),
            importance: "irrelevant".into(),
            action: "delete-from-server".into(),
            confidence: 0.70,
        };
    }

    // --- Default: personal/work ---
    // Emails that don't match any pattern are likely personal or work correspondence
    RuleResult {
        category: "personal".into(),
        importance: "medium".into(),
        action: "keep".into(),
        confidence: 0.50,
    }
}

// ── Naive Bayes Classifier ────────────────────────────────────────────────

/// Naive Bayes model for email classification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NaiveBayesModel {
    /// word -> category -> log probability
    pub word_probs: HashMap<String, HashMap<String, f64>>,
    /// category -> log prior probability
    pub category_priors: HashMap<String, f64>,
    /// category -> total word count (for Laplace smoothing)
    pub category_word_counts: HashMap<String, usize>,
    pub vocab_size: usize,
    pub training_count: usize,
    pub trained_at: String,
    #[serde(default)]
    pub correction_count_at_last_train: usize,
}

fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("classification_models")
}

fn model_path(data_dir: &Path, account_id: &str) -> PathBuf {
    models_dir(data_dir).join(format!("{}.json", account_id))
}

pub fn load_model(data_dir: &Path, account_id: &str) -> Option<NaiveBayesModel> {
    let path = model_path(data_dir, account_id);
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

pub fn save_model(data_dir: &Path, account_id: &str, model: &NaiveBayesModel) -> Result<(), String> {
    let dir = models_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create models dir: {}", e))?;
    let json = serde_json::to_string(model).map_err(|e| format!("Failed to serialize model: {}", e))?;
    fs::write(model_path(data_dir, account_id), json)
        .map_err(|e| format!("Failed to write model: {}", e))
}

/// Tokenize an email into prefixed feature tokens for Naive Bayes.
pub fn tokenize(email: &EmailForClassification) -> Vec<String> {
    let mut tokens = Vec::new();

    // Subject tokens (doubled for weight)
    for word in normalize_and_split(&email.subject) {
        tokens.push(format!("subj:{}", word));
        tokens.push(format!("subj:{}", word)); // double weight
    }

    // From domain and local part
    let from_lower = email.from.to_lowercase();
    if let Some(domain) = from_lower.split('@').nth(1) {
        let domain = domain.trim_end_matches('>');
        tokens.push(format!("from_domain:{}", domain));
    }
    if let Some(local) = from_lower.split('@').next() {
        let local = local.trim_start_matches('<').trim();
        // Strip display name: take part after last space or <
        let local = if let Some(pos) = local.rfind('<') {
            &local[pos + 1..]
        } else if let Some(pos) = local.rfind(' ') {
            &local[pos + 1..]
        } else {
            local
        };
        if !local.is_empty() {
            tokens.push(format!("from_local:{}", local));
        }
    }

    // Body preview tokens
    for word in normalize_and_split(&email.body_preview) {
        tokens.push(format!("body:{}", word));
    }

    // Header-based boolean features
    if email.list_unsubscribe {
        tokens.push("header:list_unsubscribe".into());
    }
    if email.list_id.is_some() {
        tokens.push("header:list_id".into());
    }
    if email.in_reply_to.is_some() {
        tokens.push("header:in_reply_to".into());
    }
    if email.has_attachments {
        tokens.push("header:has_attachments".into());
    }
    if email.reply_to_differs {
        tokens.push("header:reply_to_differs".into());
    }
    if let Some(ref prec) = email.precedence {
        tokens.push(format!("header:precedence:{}", prec.to_lowercase()));
    }

    // Size buckets
    if let Some(size) = email.size {
        let bucket = match size {
            0..=5_000 => "tiny",
            5_001..=50_000 => "small",
            50_001..=500_000 => "medium",
            _ => "large",
        };
        tokens.push(format!("size:{}", bucket));
    }

    // Recipient count buckets
    let recip_bucket = match email.to_count {
        0..=1 => "single",
        2..=5 => "few",
        _ => "many",
    };
    tokens.push(format!("recipients:{}", recip_bucket));

    tokens
}

fn normalize_and_split(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3 && w.len() <= 30)
        .map(String::from)
        .collect()
}

/// Default action for a category.
fn default_action_for_category(category: &str) -> &'static str {
    match category {
        "newsletter" => "archive",
        "promotional" => "archive",
        "notification" => "archive",
        "transactional" => "keep",
        "personal" => "keep",
        "work" => "keep",
        "spam-likely" => "delete-from-server",
        _ => "review",
    }
}

/// Default importance for a category.
fn default_importance_for_category(category: &str) -> &'static str {
    match category {
        "newsletter" | "promotional" | "spam-likely" => "low",
        "personal" | "work" => "high",
        _ => "medium",
    }
}

impl NaiveBayesModel {
    /// Train a Naive Bayes model from labeled examples.
    pub fn train(labeled: &[(EmailForClassification, String)]) -> Self {
        let mut category_counts: HashMap<String, usize> = HashMap::new();
        let mut category_word_counts: HashMap<String, HashMap<String, usize>> = HashMap::new();
        let mut category_total_words: HashMap<String, usize> = HashMap::new();
        let mut vocab: HashSet<String> = HashSet::new();

        for (email, category) in labeled {
            *category_counts.entry(category.clone()).or_insert(0) += 1;
            let tokens = tokenize(email);
            let word_counts = category_word_counts
                .entry(category.clone())
                .or_insert_with(HashMap::new);
            for token in &tokens {
                *word_counts.entry(token.clone()).or_insert(0) += 1;
                vocab.insert(token.clone());
            }
            *category_total_words.entry(category.clone()).or_insert(0) += tokens.len();
        }

        let total = labeled.len() as f64;
        let vocab_size = vocab.len();

        // Compute log priors
        let category_priors: HashMap<String, f64> = category_counts
            .iter()
            .map(|(cat, &count)| (cat.clone(), (count as f64 / total).ln()))
            .collect();

        // Compute log word probabilities with Laplace smoothing
        let mut word_probs: HashMap<String, HashMap<String, f64>> = HashMap::new();
        for word in &vocab {
            let mut probs = HashMap::new();
            for (cat, word_counts) in &category_word_counts {
                let word_count = word_counts.get(word).copied().unwrap_or(0) as f64;
                let total_words = category_total_words[cat] as f64;
                let log_prob = ((word_count + 1.0) / (total_words + vocab_size as f64)).ln();
                probs.insert(cat.clone(), log_prob);
            }
            word_probs.insert(word.clone(), probs);
        }

        let cat_word_counts_simple: HashMap<String, usize> = category_total_words;

        NaiveBayesModel {
            word_probs,
            category_priors,
            category_word_counts: cat_word_counts_simple,
            vocab_size,
            training_count: labeled.len(),
            trained_at: chrono::Utc::now().to_rfc3339(),
            correction_count_at_last_train: 0,
        }
    }

    /// Predict the category for a set of tokens. Returns (category, confidence).
    pub fn predict(&self, tokens: &[String]) -> (String, f64) {
        if self.category_priors.is_empty() {
            return ("personal".into(), 0.30);
        }

        let mut scores: Vec<(String, f64)> = Vec::new();

        for (cat, &prior) in &self.category_priors {
            let mut score = prior;
            let total_words = self.category_word_counts.get(cat).copied().unwrap_or(0) as f64;
            let default_log_prob = (1.0 / (total_words + self.vocab_size as f64)).ln();

            for token in tokens {
                let log_prob = self.word_probs
                    .get(token)
                    .and_then(|cats| cats.get(cat))
                    .copied()
                    .unwrap_or(default_log_prob);
                score += log_prob;
            }
            scores.push((cat.clone(), score));
        }

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let best = &scores[0];
        // Confidence via softmax of top two
        let confidence = if scores.len() >= 2 {
            let diff = (best.1 - scores[1].1).min(20.0); // cap to avoid overflow
            1.0 / (1.0 + (-diff).exp())
        } else {
            0.95
        };

        (best.0.clone(), confidence.min(0.99))
    }
}

/// Bootstrap labeling for cold start — high-confidence-only auto-labels
/// using structural header signals. Returns (category, confidence).
pub fn bootstrap_label(email: &EmailForClassification) -> Option<(&'static str, f64)> {
    // Newsletter: list_unsubscribe + list_id is a very strong signal
    if email.list_unsubscribe && email.list_id.is_some() {
        return Some(("newsletter", 0.85));
    }

    // Promotional: bulk precedence + list_unsubscribe (but no list_id)
    if let Some(ref prec) = email.precedence {
        if prec.eq_ignore_ascii_case("bulk") && email.list_unsubscribe {
            return Some(("promotional", 0.80));
        }
    }

    // Personal: has in_reply_to (it's a reply) and few recipients
    if email.in_reply_to.is_some() && email.to_count <= 3 {
        return Some(("personal", 0.75));
    }

    None
}

// ── Learned Rules ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedRule {
    pub id: String,
    pub rule_type: String, // "sender-action", "category-override"
    pub pattern: RulePattern,
    pub category: Option<String>,
    pub importance: Option<String>,
    pub action: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulePattern {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_contains: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub body_contains: Option<String>,
}

struct RuleResult {
    category: String,
    importance: String,
    action: String,
    confidence: f64,
}

/// Compute specificity score for rule ordering.
/// Higher = more specific = higher priority.
fn rule_specificity(pattern: &RulePattern) -> u8 {
    let mut score = 0u8;
    if pattern.from_address.is_some() { score += 4; }
    if pattern.from_domain.is_some() { score += 2; }
    if pattern.subject_contains.is_some() { score += 1; }
    if pattern.body_contains.is_some() { score += 1; }
    score
}

fn apply_rules(email: &EmailForClassification, rules: &[LearnedRule]) -> Option<RuleResult> {
    // Sort by specificity (most specific first) for deterministic matching
    let mut sorted: Vec<&LearnedRule> = rules.iter().collect();
    sorted.sort_by(|a, b| rule_specificity(&b.pattern).cmp(&rule_specificity(&a.pattern)));

    for rule in sorted {
        if match_pattern(&rule.pattern, email) {
            return Some(RuleResult {
                category: rule.category.clone().unwrap_or_else(|| "notification".into()),
                importance: rule.importance.clone().unwrap_or_else(|| "medium".into()),
                action: rule.action.clone().unwrap_or_else(|| "review".into()),
                confidence: rule.confidence,
            });
        }
    }
    None
}

fn match_pattern(pattern: &RulePattern, email: &EmailForClassification) -> bool {
    if let Some(ref domain) = pattern.from_domain {
        let email_domain = email.from.split('@').nth(1).unwrap_or("").split('>').next().unwrap_or("");
        if !email_domain.eq_ignore_ascii_case(domain) {
            return false;
        }
    }
    if let Some(ref addr) = pattern.from_address {
        // Extract just the address from "Name <addr>" format
        let email_addr = if let Some(start) = email.from.find('<') {
            email.from[start + 1..].trim_end_matches('>').trim()
        } else {
            email.from.trim()
        };
        if !email_addr.eq_ignore_ascii_case(addr) {
            return false;
        }
    }
    if let Some(ref substr) = pattern.subject_contains {
        if !email.subject.to_lowercase().contains(&substr.to_lowercase()) {
            return false;
        }
    }
    if let Some(ref substr) = pattern.body_contains {
        if !email.body_preview.to_lowercase().contains(&substr.to_lowercase()) {
            return false;
        }
    }
    // At least one pattern field must be set
    pattern.from_domain.is_some() || pattern.from_address.is_some()
        || pattern.subject_contains.is_some() || pattern.body_contains.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mailvault-test-classify-{}", name))
    }

    #[test]
    fn test_save_and_load_classifications() {
        let dir = test_dir("save-load");
        let _ = fs::remove_dir_all(&dir);

        let mut entries = HashMap::new();
        entries.insert(
            "<msg1@test.com>".to_string(),
            EmailClassification {
                category: "newsletter".into(),
                importance: "low".into(),
                action: "delete-from-server".into(),
                confidence: 0.95,
                classified_at: "2026-04-03".into(),
                model_used: "llama3.1-8b".into(),
                source: ClassificationSource::Llm,
                snapshot: None,
            },
        );

        save_classifications(&dir, "acc1", &entries).unwrap();

        let loaded = load_classifications(&dir, "acc1");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded["<msg1@test.com>"].category, "newsletter");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_merge_classifications() {
        let dir = test_dir("merge");
        let _ = fs::remove_dir_all(&dir);

        let mut batch1 = HashMap::new();
        batch1.insert("<a@test>".into(), EmailClassification {
            category: "personal".into(), importance: "high".into(),
            action: "keep".into(), confidence: 0.9,
            classified_at: "t1".into(), model_used: "m".into(),
            source: ClassificationSource::Llm, snapshot: None,
        });
        save_classifications(&dir, "acc1", &batch1).unwrap();

        let mut batch2 = HashMap::new();
        batch2.insert("<b@test>".into(), EmailClassification {
            category: "work".into(), importance: "medium".into(),
            action: "archive".into(), confidence: 0.8,
            classified_at: "t2".into(), model_used: "m".into(),
            source: ClassificationSource::Llm, snapshot: None,
        });
        save_classifications(&dir, "acc1", &batch2).unwrap();

        let all = load_classifications(&dir, "acc1");
        assert_eq!(all.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_summary() {
        let dir = test_dir("summary");
        let _ = fs::remove_dir_all(&dir);

        let mut entries = HashMap::new();
        for i in 0..5 {
            entries.insert(format!("<nl{}@test>", i), EmailClassification {
                category: "newsletter".into(), importance: "low".into(),
                action: "delete-from-server".into(), confidence: 0.9,
                classified_at: "t".into(), model_used: "m".into(),
                source: ClassificationSource::Llm, snapshot: None,
            });
        }
        entries.insert("<work@test>".into(), EmailClassification {
            category: "work".into(), importance: "high".into(),
            action: "keep".into(), confidence: 0.95,
            classified_at: "t".into(), model_used: "m".into(),
            source: ClassificationSource::Llm, snapshot: None,
        });
        save_classifications(&dir, "acc1", &entries).unwrap();

        let summary = get_summary(&dir, "acc1");
        assert_eq!(summary.total, 6);
        assert_eq!(summary.by_category["newsletter"], 5);
        assert_eq!(summary.by_category["work"], 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_rule_matching() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<m@test>".into()),
            subject: "Weekly newsletter".into(),
            from: "news@example.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };

        let rules = vec![LearnedRule {
            id: "r1".into(), rule_type: "sender-action".into(),
            pattern: RulePattern { from_domain: Some("example.com".into()), from_address: None, subject_contains: None, body_contains: None },
            category: Some("newsletter".into()), importance: Some("low".into()),
            action: Some("delete-from-server".into()), confidence: 0.95,
        }];

        let result = apply_rules(&email, &rules);
        assert!(result.is_some());
        assert_eq!(result.unwrap().category, "newsletter");
    }

    #[test]
    fn test_rule_no_match() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<m@test>".into()),
            subject: "Hello".into(), from: "alice@other.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };

        let rules = vec![LearnedRule {
            id: "r1".into(), rule_type: "sender-action".into(),
            pattern: RulePattern { from_domain: Some("example.com".into()), from_address: None, subject_contains: None, body_contains: None },
            category: Some("newsletter".into()), importance: None,
            action: Some("delete-from-server".into()), confidence: 0.95,
        }];

        assert!(apply_rules(&email, &rules).is_none());
    }

    #[test]
    fn test_heuristic_newsletter() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<n@t>".into()),
            subject: "Weekly Newsletter: Top Stories".into(),
            from: "newsletter@example.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };
        let result = classify_by_heuristics(&email);
        assert_eq!(result.category, "newsletter");
    }

    #[test]
    fn test_heuristic_promotional() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<p@t>".into()),
            subject: "50% off — Flash Sale ends tonight!".into(),
            from: "deals@shop.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };
        let result = classify_by_heuristics(&email);
        assert_eq!(result.category, "promotional");
    }

    #[test]
    fn test_heuristic_notification() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<n@t>".into()),
            subject: "Your password was reset".into(),
            from: "noreply@github.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };
        let result = classify_by_heuristics(&email);
        assert_eq!(result.category, "notification");
    }

    #[test]
    fn test_heuristic_transactional() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<r@t>".into()),
            subject: "Your receipt from Apple".into(),
            from: "no_reply@email.apple.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };
        let result = classify_by_heuristics(&email);
        assert_eq!(result.category, "transactional");
    }

    #[test]
    fn test_heuristic_personal() {
        let email = EmailForClassification {
            uid: 1, message_id: Some("<h@t>".into()),
            subject: "Dinner tonight?".into(),
            from: "alice@gmail.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        };
        let result = classify_by_heuristics(&email);
        assert_eq!(result.category, "personal");
    }

    #[test]
    fn test_override_classification() {
        let dir = test_dir("override");
        let _ = fs::remove_dir_all(&dir);

        let mut entries = HashMap::new();
        entries.insert("<msg@t>".into(), EmailClassification {
            category: "promotional".into(), importance: "low".into(),
            action: "delete-from-server".into(), confidence: 0.8,
            classified_at: "t".into(), model_used: "m".into(),
            source: ClassificationSource::Llm, snapshot: None,
        });
        save_classifications(&dir, "acc1", &entries).unwrap();

        let updated = override_classification(
            &dir, "acc1", "<msg@t>",
            Some("transactional"), None, Some("keep"),
        ).unwrap();

        assert_eq!(updated.category, "transactional");
        assert_eq!(updated.importance, "low"); // Unchanged
        assert_eq!(updated.action, "keep");
        assert_eq!(updated.source, ClassificationSource::UserOverride);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_queue_enqueue_dedup() {
        let dir = test_dir("queue-dedup");
        let _ = fs::remove_dir_all(&dir);

        let state = ClassificationState::new(dir.clone());

        let emails = vec![
            EmailForClassification {
                uid: 1, message_id: Some("<a@test>".into()),
                subject: "A".into(), from: "x@test.com".into(),
                date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
            EmailForClassification {
                uid: 2, message_id: Some("<b@test>".into()),
                subject: "B".into(), from: "x@test.com".into(),
                date: "2026-04-02".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
        ];

        let count = state.enqueue("acc1", emails.clone(), QueueTier::New).await;
        assert_eq!(count, 2);
        assert_eq!(state.queue_depth().await, 2);

        // Enqueue same emails again — should be deduplicated
        let count2 = state.enqueue("acc1", emails, QueueTier::New).await;
        assert_eq!(count2, 0);
        assert_eq!(state.queue_depth().await, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_queue_tier_ordering() {
        let dir = test_dir("queue-tier");
        let _ = fs::remove_dir_all(&dir);

        let state = ClassificationState::new(dir.clone());

        // Enqueue backfill first
        let backfill = vec![EmailForClassification {
            uid: 1, message_id: Some("<old@test>".into()),
            subject: "Old".into(), from: "x@test.com".into(),
            date: "2026-01-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        }];
        state.enqueue("acc1", backfill, QueueTier::Backfill).await;

        // Then enqueue new — should go before backfill
        let new = vec![EmailForClassification {
            uid: 2, message_id: Some("<new@test>".into()),
            subject: "New".into(), from: "x@test.com".into(),
            date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
            ..Default::default()
        }];
        state.enqueue("acc1", new, QueueTier::New).await;

        assert_eq!(state.queue_depth().await, 2);

        // Pop should return new-tier item first
        let first = state.pop_next().await.unwrap();
        assert_eq!(first.message_id, "<new@test>");
        assert_eq!(first.tier, QueueTier::New);

        let second = state.pop_next().await.unwrap();
        assert_eq!(second.message_id, "<old@test>");
        assert_eq!(second.tier, QueueTier::Backfill);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_queue_skips_already_classified() {
        let dir = test_dir("queue-skip-classified");
        let _ = fs::remove_dir_all(&dir);

        // Pre-classify one email
        let mut entries = HashMap::new();
        entries.insert("<already@test>".into(), EmailClassification {
            category: "personal".into(), importance: "medium".into(),
            action: "keep".into(), confidence: 0.9,
            classified_at: "t".into(), model_used: "m".into(),
            source: ClassificationSource::Llm, snapshot: None,
        });
        save_classifications(&dir, "acc1", &entries).unwrap();

        let state = ClassificationState::new(dir.clone());

        let emails = vec![
            EmailForClassification {
                uid: 1, message_id: Some("<already@test>".into()),
                subject: "Already done".into(), from: "x@test.com".into(),
                date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
            EmailForClassification {
                uid: 2, message_id: Some("<fresh@test>".into()),
                subject: "Fresh".into(), from: "x@test.com".into(),
                date: "2026-04-02".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
        ];

        let count = state.enqueue("acc1", emails, QueueTier::New).await;
        assert_eq!(count, 1); // Only the fresh one
        assert_eq!(state.queue_depth().await, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_queue_newest_first_within_tier() {
        let dir = test_dir("queue-sort");
        let _ = fs::remove_dir_all(&dir);

        let state = ClassificationState::new(dir.clone());

        let emails = vec![
            EmailForClassification {
                uid: 1, message_id: Some("<old@test>".into()),
                subject: "Old".into(), from: "x@test.com".into(),
                date: "2026-01-01".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
            EmailForClassification {
                uid: 2, message_id: Some("<mid@test>".into()),
                subject: "Mid".into(), from: "x@test.com".into(),
                date: "2026-03-01".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
            EmailForClassification {
                uid: 3, message_id: Some("<new@test>".into()),
                subject: "New".into(), from: "x@test.com".into(),
                date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            },
        ];

        state.enqueue("acc1", emails, QueueTier::New).await;

        let first = state.pop_next().await.unwrap();
        assert_eq!(first.message_id, "<new@test>");
        let second = state.pop_next().await.unwrap();
        assert_eq!(second.message_id, "<mid@test>");
        let third = state.pop_next().await.unwrap();
        assert_eq!(third.message_id, "<old@test>");

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_queue_persistence() {
        let dir = test_dir("queue-persist");
        let _ = fs::remove_dir_all(&dir);

        // Enqueue items
        {
            let state = ClassificationState::new(dir.clone());
            let emails = vec![EmailForClassification {
                uid: 1, message_id: Some("<persist@test>".into()),
                subject: "Persist".into(), from: "x@test.com".into(),
                date: "2026-04-01".into(), body_preview: String::new(), mailbox: String::new(),
                ..Default::default()
            }];
            state.enqueue("acc1", emails, QueueTier::New).await;
        }

        // Create new state — should restore from disk
        let state2 = ClassificationState::new(dir.clone());
        assert_eq!(state2.queue_depth().await, 1);

        let item = state2.pop_next().await.unwrap();
        assert_eq!(item.message_id, "<persist@test>");

        let _ = fs::remove_dir_all(&dir);
    }
}
