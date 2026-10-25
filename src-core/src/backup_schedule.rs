//! Pure backup scheduling policy. No worker or job starts in this module.
use serde_json::Value;
pub const NEVER: i64 = 9_007_199_254_740_991;
pub fn next_eligible(_state: &Value, _config: &Value, _now: i64, _zone: &str) -> Result<i64, &'static str> { Ok(0) }
pub fn validate_patch(_patch: &Value) -> Result<(), &'static str> { Ok(()) }
