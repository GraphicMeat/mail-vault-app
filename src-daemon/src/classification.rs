use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn, error};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailForClassification {
    pub uid: u64,
    pub message_id: Option<String>,
    pub subject: String,
    pub from: String,
    pub date: String,
    #[serde(default)]
    pub body_preview: String,
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

/// Get classification summary (counts by category).
pub fn get_summary(
    data_dir: &Path,
    account_id: &str,
) -> ClassificationSummary {
    let classifications = load_classifications(data_dir, account_id);

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

#[derive(Debug, Clone, Serialize)]
pub struct ClassificationSummary {
    pub total: usize,
    pub by_category: HashMap<String, usize>,
    pub by_action: HashMap<String, usize>,
    pub by_importance: HashMap<String, usize>,
}

/// Get classifications filtered by category.
pub fn get_by_category(
    data_dir: &Path,
    account_id: &str,
    category: &str,
) -> Vec<(String, EmailClassification)> {
    load_classifications(data_dir, account_id)
        .into_iter()
        .filter(|(_, c)| c.category == category)
        .collect()
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

// ── Classification Pipeline State ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ClassificationProgress {
    pub account_id: String,
    pub status: PipelineStatus,
    pub classified: usize,
    pub total: usize,
    pub skipped_by_rules: usize,
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
}

impl ClassificationState {
    pub fn new() -> Self {
        Self {
            progress: Mutex::new(ClassificationProgress {
                account_id: String::new(),
                status: PipelineStatus::Idle,
                classified: 0,
                total: 0,
                skipped_by_rules: 0,
            }),
            cancel_flag: Mutex::new(false),
        }
    }
}

/// Run the classification pipeline for an account.
/// Loads emails, applies local rules, sends remaining to LLM, stores results.
///
/// `infer_fn` is the actual LLM inference function — injected so this module
/// doesn't depend on the Candle model directly (easier testing, swappable backend).
pub async fn run_pipeline<F, Fut>(
    data_dir: &Path,
    state: &ClassificationState,
    account_id: &str,
    emails: Vec<EmailForClassification>,
    learned_rules: &[LearnedRule],
    model_name: &str,
    infer_fn: F,
) -> Result<usize, String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let existing = load_classifications(data_dir, account_id);

    // Filter out already-classified emails
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

    // Reset state
    {
        let mut progress = state.progress.lock().await;
        *progress = ClassificationProgress {
            account_id: account_id.to_string(),
            status: PipelineStatus::Running,
            classified: 0,
            total: unclassified.len(),
            skipped_by_rules: 0,
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

    // Phase 1: Apply local rules
    let mut need_llm = Vec::new();
    for email in &unclassified {
        if let Some(rule_result) = apply_rules(&email, learned_rules) {
            if let Some(ref mid) = email.message_id {
                new_classifications.insert(mid.clone(), EmailClassification {
                    category: rule_result.category,
                    importance: rule_result.importance,
                    action: rule_result.action,
                    confidence: rule_result.confidence,
                    classified_at: chrono::Utc::now().to_rfc3339(),
                    model_used: "local-rule".to_string(),
                    source: ClassificationSource::LocalRule,
                });
                rule_matches += 1;
            }
        } else {
            need_llm.push(email.clone());
        }
    }

    {
        let mut progress = state.progress.lock().await;
        progress.skipped_by_rules = rule_matches;
        progress.classified = rule_matches;
    }

    info!(
        "{} emails matched local rules, {} need LLM classification",
        rule_matches,
        need_llm.len()
    );

    // Phase 2: Batch LLM classification
    let batch_size = 25;
    for chunk in need_llm.chunks(batch_size) {
        // Check cancel
        if *state.cancel_flag.lock().await {
            let mut progress = state.progress.lock().await;
            progress.status = PipelineStatus::Cancelled;
            // Save what we have so far
            if !new_classifications.is_empty() {
                let _ = save_classifications(data_dir, account_id, &new_classifications);
            }
            return Err("Classification cancelled".into());
        }

        let prompt = build_prompt(chunk);

        match infer_fn(prompt).await {
            Ok(response) => {
                match parse_response(&response, chunk) {
                    Ok(results) => {
                        for (mid, classification) in results {
                            new_classifications.insert(mid, EmailClassification {
                                classified_at: chrono::Utc::now().to_rfc3339(),
                                model_used: model_name.to_string(),
                                source: ClassificationSource::Llm,
                                ..classification
                            });
                        }
                    }
                    Err(e) => {
                        warn!("Failed to parse LLM response for batch: {}", e);
                        // Mark batch emails as "review" rather than failing entirely
                        for email in chunk {
                            if let Some(ref mid) = email.message_id {
                                new_classifications.insert(mid.clone(), EmailClassification {
                                    category: "notification".to_string(),
                                    importance: "medium".to_string(),
                                    action: "review".to_string(),
                                    confidence: 0.0,
                                    classified_at: chrono::Utc::now().to_rfc3339(),
                                    model_used: format!("{}-parse-failed", model_name),
                                    source: ClassificationSource::Llm,
                                });
                            }
                        }
                    }
                }
            }
            Err(e) => {
                error!("LLM inference failed: {}", e);
                let mut progress = state.progress.lock().await;
                progress.status = PipelineStatus::Failed(e.clone());
                // Save what we have so far
                if !new_classifications.is_empty() {
                    let _ = save_classifications(data_dir, account_id, &new_classifications);
                }
                return Err(e);
            }
        }

        // Update progress
        let mut progress = state.progress.lock().await;
        progress.classified = new_classifications.len();
    }

    // Save all results
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
}

struct RuleResult {
    category: String,
    importance: String,
    action: String,
    confidence: f64,
}

fn apply_rules(email: &EmailForClassification, rules: &[LearnedRule]) -> Option<RuleResult> {
    for rule in rules {
        let matches = match_pattern(&rule.pattern, email);
        if matches {
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
        let email_domain = email.from.split('@').nth(1).unwrap_or("");
        if !email_domain.eq_ignore_ascii_case(domain) {
            return false;
        }
    }
    if let Some(ref addr) = pattern.from_address {
        if !email.from.eq_ignore_ascii_case(addr) {
            return false;
        }
    }
    if let Some(ref substr) = pattern.subject_contains {
        if !email.subject.to_lowercase().contains(&substr.to_lowercase()) {
            return false;
        }
    }
    // At least one pattern field must be set
    pattern.from_domain.is_some() || pattern.from_address.is_some() || pattern.subject_contains.is_some()
}

// ── Prompt Building (Rust-side mirror of JS classificationPrompt.js) ───────

fn build_prompt(emails: &[EmailForClassification]) -> String {
    let email_list: String = emails
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let mut s = format!(
                "[{}] UID: {}\n    From: {}\n    Subject: {}\n    Date: {}\n",
                i + 1,
                e.uid,
                e.from,
                if e.subject.is_empty() { "(No subject)" } else { &e.subject },
                e.date
            );
            if !e.body_preview.is_empty() {
                let preview: String = e.body_preview.chars().take(300).collect();
                s.push_str(&format!("    Preview: {}\n", preview));
            }
            s
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"You are an email classification assistant. Classify each email into exactly one category, importance level, and suggested action.

Categories: newsletter, promotional, notification, transactional, personal, work, spam-likely
Importance: high, medium, low, irrelevant
Actions: keep, archive, delete-from-server, review

Classify these {} emails. Respond with ONLY a JSON array:

{}

Format: [{{"uid": <uid>, "category": "<cat>", "importance": "<imp>", "action": "<act>", "confidence": <0.0-1.0>}}]"#,
        emails.len(),
        email_list
    )
}

fn parse_response(
    response: &str,
    emails: &[EmailForClassification],
) -> Result<Vec<(String, EmailClassification)>, String> {
    // Strip markdown fences
    let mut cleaned = response.trim().to_string();
    if cleaned.starts_with("```") {
        cleaned = cleaned
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string();
    }

    let array_start = cleaned.find('[').ok_or("No JSON array found")?;
    let array_end = cleaned.rfind(']').ok_or("No closing bracket found")?;
    let json_str = &cleaned[array_start..=array_end];

    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(json_str).map_err(|e| format!("JSON parse error: {}", e))?;

    // Build UID → messageId lookup
    let uid_to_mid: HashMap<u64, String> = emails
        .iter()
        .filter_map(|e| e.message_id.as_ref().map(|mid| (e.uid, mid.clone())))
        .collect();

    let mut results = Vec::new();
    for item in parsed {
        let uid = item.get("uid").and_then(|v| v.as_u64()).unwrap_or(0);
        let mid = match uid_to_mid.get(&uid) {
            Some(m) => m.clone(),
            None => continue, // Skip unknown UIDs
        };

        results.push((
            mid,
            EmailClassification {
                category: item.get("category").and_then(|v| v.as_str()).unwrap_or("notification").to_string(),
                importance: item.get("importance").and_then(|v| v.as_str()).unwrap_or("medium").to_string(),
                action: item.get("action").and_then(|v| v.as_str()).unwrap_or("review").to_string(),
                confidence: item.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.5),
                classified_at: String::new(),
                model_used: String::new(),
                source: ClassificationSource::Llm,
            },
        ));
    }

    Ok(results)
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
            source: ClassificationSource::Llm,
        });
        save_classifications(&dir, "acc1", &batch1).unwrap();

        let mut batch2 = HashMap::new();
        batch2.insert("<b@test>".into(), EmailClassification {
            category: "work".into(), importance: "medium".into(),
            action: "archive".into(), confidence: 0.8,
            classified_at: "t2".into(), model_used: "m".into(),
            source: ClassificationSource::Llm,
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
                source: ClassificationSource::Llm,
            });
        }
        entries.insert("<work@test>".into(), EmailClassification {
            category: "work".into(), importance: "high".into(),
            action: "keep".into(), confidence: 0.95,
            classified_at: "t".into(), model_used: "m".into(),
            source: ClassificationSource::Llm,
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
            date: "2026-04-01".into(), body_preview: String::new(),
        };

        let rules = vec![LearnedRule {
            id: "r1".into(), rule_type: "sender-action".into(),
            pattern: RulePattern { from_domain: Some("example.com".into()), from_address: None, subject_contains: None },
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
            date: "2026-04-01".into(), body_preview: String::new(),
        };

        let rules = vec![LearnedRule {
            id: "r1".into(), rule_type: "sender-action".into(),
            pattern: RulePattern { from_domain: Some("example.com".into()), from_address: None, subject_contains: None },
            category: Some("newsletter".into()), importance: None,
            action: Some("delete-from-server".into()), confidence: 0.95,
        }];

        assert!(apply_rules(&email, &rules).is_none());
    }

    #[test]
    fn test_parse_llm_response() {
        let emails = vec![
            EmailForClassification {
                uid: 1, message_id: Some("<a@t>".into()),
                subject: "Sale".into(), from: "shop@store.com".into(),
                date: "2026-04-01".into(), body_preview: String::new(),
            },
            EmailForClassification {
                uid: 2, message_id: Some("<b@t>".into()),
                subject: "Meeting".into(), from: "boss@work.com".into(),
                date: "2026-04-02".into(), body_preview: String::new(),
            },
        ];

        let response = r#"```json
[
  {"uid": 1, "category": "promotional", "importance": "low", "action": "delete-from-server", "confidence": 0.92},
  {"uid": 2, "category": "work", "importance": "high", "action": "keep", "confidence": 0.98}
]
```"#;

        let results = parse_response(response, &emails).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "<a@t>");
        assert_eq!(results[0].1.category, "promotional");
        assert_eq!(results[1].0, "<b@t>");
        assert_eq!(results[1].1.action, "keep");
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
            source: ClassificationSource::Llm,
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
}
