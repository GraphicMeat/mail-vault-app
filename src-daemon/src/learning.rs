use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Complete feedback store for an account.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Feedback {
    pub rules: Vec<serde_json::Value>,
    pub corrections: Vec<serde_json::Value>,
    pub stats: FeedbackStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FeedbackStats {
    #[serde(default)]
    pub total_classified: usize,
    #[serde(default)]
    pub total_corrected: usize,
    #[serde(default)]
    pub accuracy_rate: f64,
}

fn feedback_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ai-feedback")
}

fn feedback_path(data_dir: &Path, account_id: &str) -> PathBuf {
    feedback_dir(data_dir).join(format!("{}.json", account_id))
}

/// Load feedback for an account.
pub fn load_feedback(data_dir: &Path, account_id: &str) -> Feedback {
    let path = feedback_path(data_dir, account_id);
    if !path.exists() {
        return Feedback::default();
    }

    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(e) => {
            warn!("Failed to read feedback for {}: {}", account_id, e);
            Feedback::default()
        }
    }
}

/// Save feedback for an account.
pub fn save_feedback(
    data_dir: &Path,
    account_id: &str,
    feedback: &Feedback,
) -> Result<(), String> {
    let dir = feedback_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let json = serde_json::to_string_pretty(feedback)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    let path = feedback_path(data_dir, account_id);
    fs::write(&path, json).map_err(|e| format!("Failed to write: {}", e))?;

    info!(
        "Saved feedback for {} ({} rules, {} corrections)",
        account_id,
        feedback.rules.len(),
        feedback.corrections.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_nonexistent_feedback() {
        let dir = std::env::temp_dir().join("mailvault-test-learning-load");
        let feedback = load_feedback(&dir, "nonexistent");
        assert!(feedback.rules.is_empty());
        assert!(feedback.corrections.is_empty());
    }

    #[test]
    fn test_save_and_load_feedback() {
        let dir = std::env::temp_dir().join("mailvault-test-learning-save");
        let _ = fs::remove_dir_all(&dir);

        let feedback = Feedback {
            rules: vec![serde_json::json!({"id": "r1", "pattern": {"fromDomain": "test.com"}})],
            corrections: vec![serde_json::json!({"messageId": "<m@t>", "correctedCategory": "work"})],
            stats: FeedbackStats { total_classified: 100, total_corrected: 5, accuracy_rate: 0.95 },
        };

        save_feedback(&dir, "acc1", &feedback).unwrap();

        let loaded = load_feedback(&dir, "acc1");
        assert_eq!(loaded.rules.len(), 1);
        assert_eq!(loaded.corrections.len(), 1);
        assert_eq!(loaded.stats.total_classified, 100);

        let _ = fs::remove_dir_all(&dir);
    }
}
