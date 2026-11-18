//! The user's mobile settings (plan Ruling 14): rows of the `settings` table, read by background
//! runs that have no page, and by the page through `mobile.settings.get` / `mobile.settings.set`.
//!
//! - `notifications`: `"on"` | `"off"` (default `"off"`, plan Ruling 10: opt-in). Turning it on
//!   takes the background run's baseline there and then (`background::seed_baselines`): each
//!   INBOX the list has synced gets its watermark at its newest uid, timed now, so mail that came
//!   while it was off is no flood and mail that comes after the switch is news, even before the
//!   first run. An INBOX never synced gets no row: its first run takes the baseline.
//! - `notificationPreview`: `true` | `false` (default `true`): a notification shows sender and
//!   subject, or only "New message" and the account.
//! - `language`: one of the nine app languages (`LANGUAGES`), or unset (`null`): the page then
//!   follows the system language. Picked on the tour's first step, read before the first paint.
//! - `onboardingComplete`: `true` once the first-run tour was finished or skipped (default
//!   `false`). An install that already has accounts is marked done without seeing it.
//! - `backgroundDownload`: `true` | `false` (default `true`): a background run downloads new mail
//!   (headers of every synced folder, bodies of recent INBOX mail) so it is there offline when the
//!   app opens, notifications on or off (`background.rs`). Off, a run dials only for what
//!   notifications, scheduled sends and follow-up reminders need.
//! - The preferences in [`PREFS`] (theme, palette, mark as read, delete, swipes, send delay, dates,
//!   remote images, and the ones only stored for now), through `mobile.prefs.get` /
//!   `mobile.prefs.set`: each with the default that is the phone's behaviour without it. A desktop
//!   import sets them once (`desktopSettingsAppliedAt`, the time the first import that carried the
//!   desktop's settings applied them; later imports leave them).

use crate::db::{Engine, EngineError};
use crate::rpc::{parse, RpcError};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) const NOTIFICATIONS: &str = "notifications";
pub(crate) const NOTIFICATION_PREVIEW: &str = "notificationPreview";
pub(crate) const LANGUAGE: &str = "language";
pub(crate) const ONBOARDING_COMPLETE: &str = "onboardingComplete";
pub(crate) const BACKGROUND_DOWNLOAD: &str = "backgroundDownload";
/// When (epoch ms) a desktop import first applied the desktop's global settings.
pub(crate) const DESKTOP_SETTINGS_APPLIED_AT: &str = "desktopSettingsAppliedAt";

/// How a preference is stored (always as text in `settings`) and what the page may set.
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Bool,
    OneOf(&'static [&'static str]),
    Int(i64, i64),
    /// A string of at most this many characters.
    Text(usize),
    /// A JSON list of at most this many bytes.
    List(usize),
    /// One of these numbers (desktop's `textScale`).
    Num(&'static [f64]),
}

/// What a swipe may do on the phone.
pub(crate) const SWIPES: &[&str] = &["toggleRead", "delete", "flag", "move", "none"];
/// Desktop's `TEXT_SCALES` (`src/utils/appFont.js`).
pub(crate) const TEXT_SCALES: &[f64] = &[0.9, 1.0, 1.1, 1.25, 1.5];
/// Desktop's bundled `APP_FONTS` ids (`src/utils/appFont.js`): every one ships with the app. A
/// downloaded Google font (`google:<Family>`) is not one: the phone fetches no fonts.
pub(crate) const APP_FONTS: &[&str] =
    &["system", "instrument-sans", "inter", "atkinson", "ibm-plex-sans", "source-sans", "jetbrains-mono", "fira-code", "ibm-plex-mono"];

/// The phone's preferences: key, kind, and the default (as JSON) that is the phone's behaviour
/// without the setting. Shown and applied: theme .. emailViewerTheme, the conversation list
/// (threadMode, threadSortOrder: the page asks for `threads`, `threads.rs`), link safety,
/// `attachmentReminder` (compose asks before such a send) and `templates` (`[{name, body}]`,
/// compose inserts them), `quickActionsReader` (the viewer's bar). Stored for later waves: the rest.
pub(crate) const PREFS: &[(&str, Kind, &str)] = &[
    ("theme", Kind::OneOf(&["system", "light", "dark"]), "\"system\""),
    ("palette", Kind::OneOf(&["indigo", "graphite", "teal"]), "\"indigo\""),
    // Opening a message marks it read, as before.
    ("markAsReadMode", Kind::OneOf(&["auto", "delay", "manual"]), "\"auto\""),
    ("markAsReadDelay", Kind::Int(0, 60), "3"),
    // Delete has its undo toast; no question first.
    ("confirmBeforeDelete", Kind::Bool, "false"),
    // After a delete the viewer opens the message below.
    ("afterDeleteSelect", Kind::OneOf(&["next", "previous", "none"]), "\"next\""),
    // Swiping left shows the trailing action (delete), swiping right the leading one (read).
    ("swipeLeftAction", Kind::OneOf(SWIPES), "\"delete\""),
    ("swipeRightAction", Kind::OneOf(SWIPES), "\"toggleRead\""),
    // Seconds a sent message waits with Undo; 0 sends at once. Within the free schedule limit.
    ("sendDelay", Kind::Int(0, 300), "0"),
    ("defaultSignatureEnabled", Kind::Bool, "true"),
    // Remote images wait for "Load images".
    ("holdExternalContent", Kind::Bool, "true"),
    // Premium strips tracking pixels while it is on (body.rs).
    ("trackerBlockingEnabled", Kind::Bool, "true"),
    ("dateFormat", Kind::OneOf(&["auto", "MM/dd/yyyy", "dd/MM/yyyy", "yyyy-MM-dd", "dd MMM yyyy", "custom"]), "\"auto\""),
    ("customDateFormat", Kind::Text(64), "\"\""),
    ("timeFormat", Kind::OneOf(&["auto", "12h", "24h"]), "\"auto\""),
    // The message's own theme (Settings > Appearance); "system" follows the app's.
    ("emailViewerTheme", Kind::OneOf(&["system", "light", "dark"]), "\"system\""),
    // The list groups conversations unless flat (the page passes `threads`; `threads.rs`).
    ("threadMode", Kind::OneOf(&["grouped", "expandable", "flat"]), "\"expandable\""),
    ("threadSortOrder", Kind::OneOf(&["oldest-first", "newest-first"]), "\"oldest-first\""),
    // Mail view: the list, or chat (the folder by person, `chat.rs`; ChatView.jsx).
    ("viewStyle", Kind::OneOf(&["list", "chat"]), "\"list\""),
    // The home screen icon (the shell sets the OS alternate icon: `mobile_app_icon`).
    ("appIcon", Kind::OneOf(&["purple", "teal"]), "\"purple\""),
    ("autoSaveDrafts", Kind::Bool, "true"),
    ("attachmentReminder", Kind::Bool, "true"),
    // The body reply carries core's link scan (body.rs); the viewer marks flagged links and, with
    // click confirmation, asks before opening one.
    ("linkSafetyEnabled", Kind::Bool, "true"),
    ("linkSafetyClickConfirm", Kind::Bool, "true"),
    // Settings > Search index (search.rs, search_attach.rs): body words in the index, and the
    // text of downloaded attachments (Premium).
    ("searchIndexBodies", Kind::Bool, "true"),
    ("searchIndexAttachments", Kind::Bool, "true"),
    ("importantSenders", Kind::List(64 * 1024), "[]"),
    ("templates", Kind::List(512 * 1024), "[]"),
    // Appearance: the page's text size and font (applyLook), list rows (MessageRow.jsx), the
    // signature fold (mailFrame.js) and the viewer toolbar's labels (Viewer.jsx).
    ("textScale", Kind::Num(TEXT_SCALES), "1"),
    ("appFont", Kind::OneOf(APP_FONTS), "\"instrument-sans\""),
    ("listDensity", Kind::OneOf(&["comfortable", "compact"]), "\"comfortable\""),
    // The phone's rows always had one line of the message's text.
    ("listPreviewLines", Kind::Int(0, 3), "1"),
    // The phone showed every signature.
    ("signatureDisplay", Kind::OneOf(&["smart", "always-show", "always-hide", "collapsed"]), "\"always-show\""),
    // The phone's toolbar had icons only.
    ("actionButtonDisplay", Kind::OneOf(&["icon-only", "icon-label", "text-only"]), "\"icon-only\""),
    // Mail: list rows swipe (MessageRow.jsx), the launch and foreground sync (store.js, App.jsx),
    // attachments fetched as a message opens (AttachmentChip.jsx), and the row after a delete in
    // All Inboxes (prefs.js `afterDeletePick`).
    ("trackpadSwipeEnabled", Kind::Bool, "true"),
    ("refreshOnLaunch", Kind::Bool, "true"),
    // Desktop's automatic refresh, in minutes (0: never): the page syncs the open folder this often
    // while the app is in front (App.jsx). Background runs keep the system's own schedule.
    ("refreshInterval", Kind::Int(0, 1440), "0"),
    ("autoDownloadAttachments", Kind::Bool, "false"),
    ("afterDeleteSameAccount", Kind::Bool, "false"),
    // Notifications: the system's sound on a new-mail notification, and the app icon's badge
    // (background.rs `badge_count`; posted by the shell's background run).
    ("notificationSound", Kind::Bool, "true"),
    // The phone set no badge.
    ("badgeEnabled", Kind::Bool, "false"),
    ("badgeMode", Kind::OneOf(&["unread", "total"]), "\"unread\""),
    // The viewer's bar, in order (Settings > Appearance > Quick actions; the page keeps the
    // phone's actions only, at most four: src/mobile/quickActions.js). The rest are under More.
    ("quickActionsReader", Kind::List(1024), "[\"toggleRead\",\"flag\",\"move\",\"delete\"]"),
    // Settings > Logs: Standard masks addresses in the log file, Verbose keeps them (`logs.rs`).
    ("logVerbosity", Kind::OneOf(&["standard", "verbose"]), "\"standard\""),
    // Settings > AI (`ai.rs`): desktop's `aiSettings` with the phone's one provider, an
    // OpenAI-compatible endpoint. Off: no AI call is made, and quick replies stay deterministic.
    ("aiEnabled", Kind::Bool, "false"),
    ("aiEndpointUrl", Kind::Text(512), "\"\""),
    ("aiEndpointModel", Kind::Text(200), "\"\""),
    // An explicit AI action runs without its review once this endpoint was reviewed.
    ("aiSkipPreview", Kind::Bool, "false"),
];

pub(crate) fn pref(key: &str) -> Option<(Kind, &'static str)> {
    PREFS.iter().find(|p| p.0 == key).map(|p| (p.1, p.2))
}

/// `value` as stored for a preference of `kind`, or `None` when it is not one it takes.
pub(crate) fn encode(kind: Kind, value: &Value) -> Option<String> {
    match kind {
        Kind::Bool => value.as_bool().map(|b| b.to_string()),
        Kind::OneOf(allowed) => value.as_str().filter(|s| allowed.contains(s)).map(str::to_string),
        Kind::Int(lo, hi) => value.as_i64().filter(|n| (lo..=hi).contains(n)).map(|n| n.to_string()),
        Kind::Text(max) => value.as_str().filter(|s| s.chars().count() <= max && !s.contains(['\n', '\r'])).map(str::to_string),
        Kind::List(max) => value.is_array().then(|| value.to_string()).filter(|s| s.len() <= max),
        Kind::Num(allowed) => value.as_f64().filter(|n| allowed.contains(n)).map(|n| json!(n).to_string()),
    }
}

/// A stored preference as JSON; a missing or unreadable one is its default.
pub(crate) fn decode(kind: Kind, stored: Option<String>, default: &str) -> Value {
    let fallback = || serde_json::from_str(default).unwrap_or(Value::Null);
    let Some(s) = stored else { return fallback() };
    let v = match kind {
        Kind::Bool => match s.as_str() {
            "true" => Some(json!(true)),
            "false" => Some(json!(false)),
            _ => None,
        },
        Kind::OneOf(_) | Kind::Text(_) => Some(json!(s)),
        Kind::Int(..) => s.parse::<i64>().ok().map(|n| json!(n)),
        Kind::List(_) => serde_json::from_str::<Value>(&s).ok(),
        Kind::Num(_) => s.parse::<f64>().ok().map(|n| json!(n)),
    };
    v.filter(|v| encode(kind, v).is_some()).unwrap_or_else(fallback)
}

/// The app languages (the catalogs in `src/i18n/locales`). Nothing else is ever stored.
pub(crate) const LANGUAGES: [&str; 9] = ["en", "es", "fr", "it", "de", "pt-BR", "ja", "ko", "zh-Hans"];

// Internal keys (`premium.rs`), not user settings: never a secret, never set from outside.
/// The cached Premium answer: `{entitled, source, expiresMs, checkedMs}`.
pub(crate) const PREMIUM_STATE: &str = "premium.state";
/// The latest wall-clock time the engine has seen (epoch ms), for the clock guard.
pub(crate) const PREMIUM_CLOCK_HIGH: &str = "premium.clockHigh";
/// Set while this install's web registration (`register=1`) has not had its answer.
pub(crate) const PREMIUM_WEB_REGISTER: &str = "premium.webRegister";

/// A key the engine keeps for itself (`premium.*`, and `ai.*`: the endpoint the user reviewed a
/// send to, the dismissed quick replies): [`Engine::set_setting`] refuses it.
pub(crate) fn is_internal(key: &str) -> bool {
    key.starts_with("premium.") || key.starts_with("ai.")
}

pub(crate) fn get_in(c: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<_, Option<String>>(0))
        .optional()
        .map(Option::flatten)
}

/// Block tracking pixels (`trackerBlockingEnabled`, on unless turned off): Premium strips them only
/// while it is on.
pub(crate) fn tracker_blocking_on(c: &Connection) -> rusqlite::Result<bool> {
    Ok(get_in(c, "trackerBlockingEnabled")?.as_deref() != Some("false"))
}

/// Link safety scanning (`linkSafetyEnabled`, on unless turned off): the body reply carries core's
/// link scan (`body.rs`).
pub(crate) fn link_safety_on(c: &Connection) -> rusqlite::Result<bool> {
    Ok(get_in(c, "linkSafetyEnabled")?.as_deref() != Some("false"))
}

pub(crate) fn put_in(c: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
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

    /// Background runs download new mail (`backgroundDownload`, on unless set to `false`). A read
    /// failure counts as off, like [`Engine::notifications_on`].
    pub fn background_download_on(&self) -> bool {
        match self.setting(BACKGROUND_DOWNLOAD) {
            Ok(v) => preview(v),
            Err(_) => false,
        }
    }

    /// A new-mail notification plays the system's sound (`notificationSound`, on unless set to
    /// `false`).
    pub fn notification_sound(&self) -> bool {
        preview(self.setting("notificationSound").ok().flatten())
    }

    /// The app icon's badge (`badgeEnabled`, `badgeMode`): the unread messages, or every message,
    /// in the inboxes of the accounts not hidden, as the phone has them (its own reads and deletes
    /// count at once). `None` while the badge is off: the shell then clears it.
    pub fn badge_count(&self) -> Result<Option<u64>, EngineError> {
        self.read(|c| {
            if get_in(c, "badgeEnabled")?.as_deref() != Some("true") {
                return Ok(None);
            }
            let unread_only = get_in(c, "badgeMode")?.as_deref() != Some("total");
            let hidden = crate::account_settings::HIDDEN_SQL.replace("{account}", "m.account_id");
            let sql = format!(
                "SELECT COUNT(*) FROM messages m WHERE m.folder = 'INBOX' COLLATE NOCASE AND COALESCE(m.local_deleted, 0) = 0 \
                 AND m.out_of_window_ms IS NULL AND (?1 = 0 OR COALESCE(m.local_seen, m.seen) = 0) AND NOT {hidden} \
                 AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id)"
            );
            let n: i64 = c.query_row(&sql, [unread_only as i64], |r| r.get(0))?;
            Ok(Some(n.max(0) as u64))
        })
    }

    fn settings_json(&self) -> Result<Value, EngineError> {
        let (n, p, l, o, d) = self.read(|c| {
            Ok((
                get_in(c, NOTIFICATIONS)?,
                get_in(c, NOTIFICATION_PREVIEW)?,
                get_in(c, LANGUAGE)?,
                get_in(c, ONBOARDING_COMPLETE)?,
                get_in(c, BACKGROUND_DOWNLOAD)?,
            ))
        })?;
        // A stored value that is not one of the nine reads as unset.
        let language = l.filter(|code| LANGUAGES.contains(&code.as_str()));
        Ok(json!({
            "notifications": if on(n) { "on" } else { "off" },
            "notificationPreview": preview(p),
            "language": language,
            "onboardingComplete": o.as_deref() == Some("true"),
            "backgroundDownload": preview(d),
        }))
    }

    fn prefs_json(&self) -> Result<Value, EngineError> {
        let stored = self.read(|c| {
            let mut out = Vec::with_capacity(PREFS.len());
            for (key, _, _) in PREFS {
                out.push(get_in(c, key)?);
            }
            Ok(out)
        })?;
        let mut out = serde_json::Map::new();
        for ((key, kind, default), v) in PREFS.iter().zip(stored) {
            out.insert((*key).to_string(), decode(*kind, v, default));
        }
        Ok(Value::Object(out))
    }
}

/// `mobile.settings.get {}` -> `{notifications: "on"|"off", notificationPreview: bool,
/// language: code|null, onboardingComplete: bool, backgroundDownload: bool}`.
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
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    onboarding_complete: Option<bool>,
    #[serde(default)]
    background_download: Option<bool>,
}

/// `mobile.settings.set {notifications?, notificationPreview?, language?, onboardingComplete?,
/// backgroundDownload?}` ->
/// the settings after the write.
/// Anything but the listed values is `INVALID` and changes nothing.
pub(crate) fn set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SetParams = parse(params)?;
    apply(engine, &p)?;
    get(engine, Value::Null)
}

/// `mobile.prefs.get {}` -> every preference of [`PREFS`] under its key, a missing one at its
/// default, plus `desktopSettingsAppliedAt` (epoch ms, or `null` before any import applied the
/// desktop's settings).
pub(crate) fn prefs_get(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let mut out = engine.prefs_json().map_err(|e| RpcError::Internal(e.to_string()))?;
    let at = engine.setting(DESKTOP_SETTINGS_APPLIED_AT).map_err(|e| RpcError::Internal(e.to_string()))?;
    out["desktopSettingsAppliedAt"] = json!(at.and_then(|v| v.parse::<i64>().ok()));
    Ok(out)
}

/// `mobile.prefs.set {<preference>: value, ...}` -> the preferences after the write. A key not in
/// [`PREFS`], or a value it does not take, is `INVALID` and changes nothing.
pub(crate) fn prefs_set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let params = if params.is_null() { json!({}) } else { params };
    let obj = params.as_object().ok_or_else(|| RpcError::Invalid("params must be an object".into()))?;
    let mut writes = Vec::with_capacity(obj.len());
    for (key, value) in obj {
        let (kind, _) = pref(key).ok_or_else(|| RpcError::Invalid(format!("{key} is not a preference")))?;
        let stored = encode(kind, value).ok_or_else(|| RpcError::Invalid(format!("{key} has a value it does not take")))?;
        writes.push((key.as_str(), stored));
    }
    engine
        .write(|c| {
            for (key, value) in &writes {
                put_in(c, key, value)?;
            }
            Ok(())
        })
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    if let Some((_, v)) = writes.iter().find(|(k, _)| *k == crate::logs::VERBOSITY) {
        engine.shared().logs.set_verbose(crate::logs::is_verbose(Some(v.as_str())));
    }
    if writes.iter().any(|(key, _)| key.starts_with("searchIndex")) {
        // The index worker compares the settings it holds against these, after its current unit.
        crate::search::wake(engine.shared());
    }
    prefs_get(engine, Value::Null)
}

fn apply(engine: &Engine, p: &SetParams) -> Result<(), RpcError> {
    if let Some(n) = &p.notifications {
        if n != "on" && n != "off" {
            return Err(RpcError::Invalid("notifications is \"on\" or \"off\"".into()));
        }
    }
    if let Some(l) = &p.language {
        if !LANGUAGES.contains(&l.as_str()) {
            return Err(RpcError::Invalid("language is one of the app languages".into()));
        }
    }
    engine
        .write(|c| {
            if let Some(n) = &p.notifications {
                let was_on = on(get_in(c, NOTIFICATIONS)?);
                put_in(c, NOTIFICATIONS, n)?;
                if n == "on" && !was_on {
                    crate::background::seed_baselines(c)?;
                }
            }
            if let Some(v) = p.notification_preview {
                put_in(c, NOTIFICATION_PREVIEW, if v { "true" } else { "false" })?;
            }
            if let Some(l) = &p.language {
                put_in(c, LANGUAGE, l)?;
            }
            if let Some(v) = p.onboarding_complete {
                put_in(c, ONBOARDING_COMPLETE, if v { "true" } else { "false" })?;
            }
            if let Some(v) = p.background_download {
                put_in(c, BACKGROUND_DOWNLOAD, if v { "true" } else { "false" })?;
            }
            Ok(())
        })
        .map_err(|e| RpcError::Internal(e.to_string()))
}

/// [`Engine::set_setting`] of a user setting: the same checks and side effects as
/// `mobile.settings.set`. `None` for any other key (stored as given).
pub(crate) fn set_user_key(engine: &Engine, key: &str, value: &str) -> Option<Result<(), EngineError>> {
    let none = SetParams { notifications: None, notification_preview: None, language: None, onboarding_complete: None, background_download: None };
    let flag = |v: &str| match v {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    };
    let p = match key {
        NOTIFICATIONS => SetParams { notifications: Some(value.to_string()), ..none },
        NOTIFICATION_PREVIEW => match flag(value) {
            Some(v) => SetParams { notification_preview: Some(v), ..none },
            None => return Some(Err(EngineError::Db(format!("{NOTIFICATION_PREVIEW} is true or false")))),
        },
        LANGUAGE => SetParams { language: Some(value.to_string()), ..none },
        BACKGROUND_DOWNLOAD => match flag(value) {
            Some(v) => SetParams { background_download: Some(v), ..none },
            None => return Some(Err(EngineError::Db(format!("{BACKGROUND_DOWNLOAD} is true or false")))),
        },
        ONBOARDING_COMPLETE => match flag(value) {
            Some(v) => SetParams { onboarding_complete: Some(v), ..none },
            None => return Some(Err(EngineError::Db(format!("{ONBOARDING_COMPLETE} is true or false")))),
        },
        _ => {
            let (kind, _) = pref(key)?;
            // Stored as text: a flag or number arrives as its text, read here as JSON first.
            let v = serde_json::from_str::<Value>(value).ok().filter(|v| encode(kind, v).is_some()).unwrap_or_else(|| json!(value));
            return Some(match encode(kind, &v) {
                Some(stored) => engine.write(|c| put_in(c, key, &stored)),
                None => Err(EngineError::Db(format!("{key} has a value it does not take"))),
            });
        }
    };
    Some(apply(engine, &p).map_err(|e| EngineError::Db(e.to_string())))
}
