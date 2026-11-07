//! The user's mobile settings (plan Ruling 14): rows of the `settings` table, read by background
//! runs that have no page, and by the page through `mobile.settings.get` / `mobile.settings.set`.
//!
//! - `notifications`: `"on"` | `"off"` (default `"off"`, plan Ruling 10: opt-in). Turning it on
//!   empties `notify_state`, so the next background run takes a new baseline: mail that came while
//!   it was off is no flood.
//! - `notificationPreview`: `true` | `false` (default `true`): a notification shows sender and
//!   subject, or only "New message" and the account.

use crate::db::{Engine, EngineError};
use crate::rpc::{parse, RpcError};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) const NOTIFICATIONS: &str = "notifications";
pub(crate) const NOTIFICATION_PREVIEW: &str = "notificationPreview";

fn get_in(c: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<_, Option<String>>(0))
        .optional()
        .map(Option::flatten)
}

fn put_in(c: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )?;
    Ok(())
}

fn on(value: Option<String>) -> bool {
    value.as_deref() == Some("on")
}

fn preview(value: Option<String>) -> bool {
    value.as_deref() != Some("false")
}

impl Engine {
    /// `notifications` is `"on"`. A read failure counts as off: a background run then does nothing.
    pub fn notifications_on(&self) -> bool {
        on(self.setting(NOTIFICATIONS).ok().flatten())
    }

    /// Notifications show sender and subject (`notificationPreview`, on unless set to `false`).
    pub fn notification_preview(&self) -> bool {
        preview(self.setting(NOTIFICATION_PREVIEW).ok().flatten())
    }

    fn settings_json(&self) -> Result<Value, EngineError> {
        let (n, p) = self.read(|c| Ok((get_in(c, NOTIFICATIONS)?, get_in(c, NOTIFICATION_PREVIEW)?)))?;
        Ok(json!({ "notifications": if on(n) { "on" } else { "off" }, "notificationPreview": preview(p) }))
    }
}

/// `mobile.settings.get {}` -> `{notifications: "on"|"off", notificationPreview: bool}`.
pub(crate) fn get(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    engine.settings_json().map_err(|e| RpcError::Internal(e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    #[serde(default)]
    notifications: Option<String>,
    #[serde(default)]
    notification_preview: Option<bool>,
}

/// `mobile.settings.set {notifications?, notificationPreview?}` -> the settings after the write.
/// Anything but the listed values is `INVALID` and changes nothing.
pub(crate) fn set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SetParams = parse(params)?;
    if let Some(n) = &p.notifications {
        if n != "on" && n != "off" {
            return Err(RpcError::Invalid("notifications is \"on\" or \"off\"".into()));
        }
    }
    engine
        .write(|c| {
            if let Some(n) = &p.notifications {
                let was_on = on(get_in(c, NOTIFICATIONS)?);
                put_in(c, NOTIFICATIONS, n)?;
                if n == "on" && !was_on {
                    c.execute("DELETE FROM notify_state", [])?;
                }
            }
            if let Some(v) = p.notification_preview {
                put_in(c, NOTIFICATION_PREVIEW, if v { "true" } else { "false" })?;
            }
            Ok(())
        })
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    get(engine, Value::Null)
}
