//! Read-only compose preparation. Callers remain on the current JS path.
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Clone, Debug, Deserialize)]
pub struct Account { pub id: String, pub email: String }
pub struct Context { pub accounts: Vec<Account>, pub settings: Value, pub settings_version: u64 }
pub fn reply_context(_params: &Value, _ctx: &Context) -> Result<Value, &'static str> { Ok(json!({"to":""})) }
pub fn check(_params: &Value, _ctx: &Context, _now: i64) -> Result<Value, &'static str> { Ok(json!({"kind":"ready","route":{"delay":null}})) }
pub fn route_send(_plan: &Value, _draft: &Value, _now: i64, _tz: &str) -> Result<Value, &'static str> { Ok(json!({"delay":null})) }
pub fn zoned_time_to_epoch(_local: &str, _tz: &str) -> Result<i64, &'static str> { Ok(0) }
pub fn wall_clock_at(_now: i64, _tz: &str) -> Result<String, &'static str> { Ok(String::new()) }
