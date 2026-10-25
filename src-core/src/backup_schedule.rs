//! Pure backup scheduling policy. No worker or job starts in this module.
use serde_json::Value;
pub const NEVER: i64 = 9_007_199_254_740_991;
pub fn next_eligible(_state: &Value, _config: &Value, _now: i64, _zone: &str) -> Result<i64, &'static str> { Ok(0) }
pub fn validate_patch(_patch: &Value) -> Result<(), &'static str> { Ok(()) }
pub fn scheduled(_settings: &Value, _id: &str, _now: i64) -> bool { false }
pub fn automatic_due(_settings: &Value, _id: &str, _now: i64, _zone: &str, _loading: bool, _last_activity: i64, _paused: bool) -> Result<bool, &'static str> { Ok(false) }
pub fn mailbox_concurrency(_settings: &Value, _now: i64) -> usize { 1 }
pub fn retry_delay(_retries: usize, _manual_waiter: bool) -> Option<i64> { None }
pub fn limit_hold_until(_now: i64, _resume_after: Option<i64>) -> i64 { 0 }
pub fn download_cap_changed(_before: &Value, _after: &Value) -> bool { false }
pub fn snapshot_due(_settings: &Value, _id: &str, _now: i64, _success: bool) -> bool { false }
