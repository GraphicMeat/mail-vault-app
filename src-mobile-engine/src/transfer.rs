//! `mobile.transfer.import`: the phone's half of "Set up the mobile app". The page collects the
//! QR frames the desktop shows (it reads only their headers, for progress); here core assembles
//! them, opens the sealed bundle with the user's password ([`decode_phone_bundle`], argon2: the
//! shell already runs every RPC on a blocking thread) and each account becomes a row and a secret
//! through [`accounts::insert_new`], like every other add. No sign-in test: the first sync says
//! whether an account works, through the usual banners (a refused OAuth grant parks it as
//! `needsAuth`, a refused password holds it). Every account of the code that is here afterwards,
//! new or already present, takes the desktop's list position and color; the phone's other
//! accounts follow them.
//!
//! The desktop's settings come along. Its global ones (theme, swipes, mark as read, ...) apply on
//! the first import that carries them only: `desktopSettingsAppliedAt` marks it, and a later
//! import leaves what the user has on the phone since. Each account's own (display name, hidden,
//! signature, aliases, notifications, offline window) apply to the accounts this import adds; one
//! already here keeps the phone's. Every value is checked key by key: one the phone does not take
//! (from a newer desktop, say) is left out, never a failed import. Notifications are never turned
//! on: that needs the system's permission, asked on the phone.
//!
//! Reply: `{ok: true, imported: [email], existing: [email], skipped: [{email, reason}],
//! settingsApplied: bool}` (`settingsApplied`: this import applied the desktop's global settings), or
//! `{ok: false, code}` with `PASSWORD_SHORT` (under 12 characters, nothing tried), `BAD_PASSWORD`
//! (wrong password or a modified code, indistinguishable) or `INVALID` (not a whole MailVault
//! code, or bad params). A skip `reason` is `invalid` (settings the phone cannot use),
//! `no-secret` or `internal` (the secret store refused it).
//!
//! Never logged or put in a reply or error: the password, a frame, the bundle or a secret.

use crate::accounts::{self, AccountRow, InsertError};
use crate::db::Engine;
use crate::rpc::RpcError;
use crate::secrets::Credential;
use crate::settings::{self as prefs, put_in};
use mailvault_core::transfer::phone::{
    decode_phone_bundle, hex_color, PhoneAccount, PhoneAuth, PhoneError, PhoneKind, PhoneSettings, MAX_FRAMES, MAX_FRAME_CHARS, MIN_PASSWORD_CHARS,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use zeroize::Zeroizing;

/// The camera reads every frame many times; the page sends each once, but a few repeats are fine.
const MAX_FRAME_TEXTS: usize = MAX_FRAMES * 4;

fn refused(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// The params, read by hand: serde's errors quote the offending value, which here is the password
/// or a piece of the sealed bundle. Every error names the field only.
fn read_params(params: &mut Value) -> Result<(Vec<String>, Zeroizing<String>), &'static str> {
    let obj = params.as_object_mut().ok_or("params must be an object")?;
    // Taken, not cloned: no second copy of the password stays in `params`.
    let password = match obj.get_mut("password") {
        Some(Value::String(s)) => Zeroizing::new(std::mem::take(s)),
        _ => return Err("password must be a string"),
    };
    let Some(Value::Array(items)) = obj.get("frames") else {
        return Err("frames must be a list of strings");
    };
    if items.len() > MAX_FRAME_TEXTS {
        return Err("too many frames");
    }
    let mut frames = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(s) if s.len() <= MAX_FRAME_CHARS => frames.push(s.clone()),
            _ => return Err("frames must be a list of strings"),
        }
    }
    Ok((frames, password))
}

pub(crate) fn import(engine: &Engine, mut params: Value) -> Result<Value, RpcError> {
    let (frames, password) = match read_params(&mut params) {
        Ok(p) => p,
        Err(m) => return Ok(refused("INVALID", m)),
    };
    // Core enforces the floor on sealing only; a short password never reaches argon2 here either.
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Ok(refused("PASSWORD_SHORT", "the password has fewer than 12 characters"));
    }
    let bundle = match decode_phone_bundle(&password, &frames) {
        Ok(b) => b,
        Err(PhoneError::Password) => return Ok(refused("PASSWORD_SHORT", "the password has fewer than 12 characters")),
        Err(PhoneError::BadPassword) => return Ok(refused("BAD_PASSWORD", "the password does not open this code")),
        // Core's text names the problem, never the data.
        Err(e @ (PhoneError::Invalid(_) | PhoneError::Frame(_))) => return Ok(refused("INVALID", &e.to_string())),
    };
    drop(password);

    let mut imported = Vec::new();
    let mut existing = Vec::new();
    let mut skipped = Vec::new();
    // The same address twice in one code: once one copy is here (imported or already present),
    // a later copy is "existing". A skipped copy does not count, so a later usable one still gets
    // in; a skipped address is named once.
    let mut here = HashSet::new();
    let mut named_skipped = HashSet::new();
    // Each bundle account now here (new or already present): its desktop position, account id
    // and color. By id: SQLite's NOCASE folds ASCII only, so an address with a non-ASCII capital
    // would not match its lowercase key.
    let mut placed: Vec<(u64, String, Option<String>)> = Vec::new();
    // The accounts this import added (their id), which take the desktop's own settings.
    let mut added: Vec<(String, &PhoneAccount)> = Vec::new();
    for (i, acct) in bundle.accounts.iter().enumerate() {
        let desktop = (acct.order.map_or(i as u64, u64::from), acct.color.as_deref().and_then(hex_color));
        let email = acct.email.trim().to_string();
        let key = email.to_lowercase();
        if here.contains(&key) {
            existing.push(email);
            continue;
        }
        let skip = |skipped: &mut Vec<Value>, named: &mut HashSet<String>, email: String, reason: &str| {
            if named.insert(email.to_lowercase()) {
                skipped.push(json!({ "email": email, "reason": reason }));
            }
        };
        let (row, cred) = match to_row(acct, &email) {
            Ok(r) => r,
            Err(reason) => {
                skip(&mut skipped, &mut named_skipped, email, reason);
                continue;
            }
        };
        if let Some(id) = account_with(engine, &email)? {
            here.insert(key.clone());
            placed.push((desktop.0, id, desktop.1));
            existing.push(email);
            continue;
        }
        match accounts::insert_new(engine, &row, &cred, |_, _| Ok(())) {
            Ok(id) => {
                here.insert(key.clone());
                added.push((id.clone(), acct));
                placed.push((desktop.0, id, desktop.1));
                imported.push(email);
            }
            Err(InsertError::Duplicate) => {
                here.insert(key.clone());
                if let Some(id) = account_with(engine, &email)? {
                    placed.push((desktop.0, id, desktop.1));
                }
                existing.push(email);
            }
            Err(InsertError::Secret(_)) => skip(&mut skipped, &mut named_skipped, email, "internal"),
            Err(InsertError::Db(e)) => return Err(RpcError::Internal(e)),
        }
    }
    // A skipped copy whose address a later copy brought in is not skipped after all.
    skipped.retain(|s| !s["email"].as_str().is_some_and(|e| here.contains(&e.to_lowercase())));
    if !placed.is_empty() {
        place(engine, placed)?;
    }
    let settings_applied = apply_settings(engine, &added, bundle.settings.as_ref())?;
    Ok(json!({ "ok": true, "imported": imported, "existing": existing, "skipped": skipped, "settingsApplied": settings_applied }))
}

/// One write: each added account's own settings, and the desktop's global ones when no import
/// applied them before. Answers whether the global ones were applied now.
fn apply_settings(engine: &Engine, added: &[(String, &PhoneAccount)], global: Option<&PhoneSettings>) -> Result<bool, RpcError> {
    engine
        .write(|c| {
            for (id, acct) in added {
                crate::account_settings::apply_import(c, id, acct.hidden, acct.settings.as_ref())?;
            }
            let Some(global) = global else { return Ok(false) };
            if prefs::get_in(c, prefs::DESKTOP_SETTINGS_APPLIED_AT)?.is_some() {
                return Ok(false);
            }
            apply_global(c, global)?;
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
            put_in(c, prefs::DESKTOP_SETTINGS_APPLIED_AT, &now.to_string())?;
            Ok(true)
        })
        .map_err(|e| RpcError::Internal(e.to_string()))
}

/// A desktop swipe as the phone has it: star is flag, archive the closest the phone has (move,
/// which asks where), snooze nothing.
pub(crate) fn phone_swipe(desktop: &str) -> &'static str {
    match desktop {
        "toggleRead" => "toggleRead",
        "delete" => "delete",
        "star" | "flag" => "flag",
        "archive" | "move" => "move",
        _ => "none",
    }
}

/// The desktop's "after delete" as the phone has it: the unread variants are plain next/previous.
fn phone_after_delete(desktop: &str) -> &'static str {
    match desktop {
        "next" | "nextUnread" => "next",
        "previous" | "previousUnread" => "previous",
        _ => "none",
    }
}

/// The desktop's global settings into the phone's preference rows, each through its own check.
fn apply_global(c: &Connection, s: &PhoneSettings) -> rusqlite::Result<()> {
    let mut values: Vec<(&str, Value)> = Vec::new();
    let mut text = |key: &'static str, v: &Option<String>| {
        if let Some(v) = v {
            values.push((key, json!(v)));
        }
    };
    text("theme", &s.theme);
    text("palette", &s.palette);
    text("markAsReadMode", &s.mark_as_read_mode);
    text("dateFormat", &s.date_format);
    text("customDateFormat", &s.custom_date_format);
    text("timeFormat", &s.time_format);
    text("emailViewerTheme", &s.email_viewer_theme);
    text("threadMode", &s.thread_mode);
    text("threadSortOrder", &s.thread_sort_order);
    if let Some(v) = &s.after_delete_select {
        values.push(("afterDeleteSelect", json!(phone_after_delete(v))));
    }
    if let Some(v) = &s.swipe_left_action {
        values.push(("swipeLeftAction", json!(phone_swipe(v))));
    }
    if let Some(v) = &s.swipe_right_action {
        values.push(("swipeRightAction", json!(phone_swipe(v))));
    }
    for (key, v) in [("markAsReadDelay", s.mark_as_read_delay), ("sendDelay", s.send_delay)] {
        if let Some(v) = v {
            values.push((key, json!(v)));
        }
    }
    for (key, v) in [
        ("confirmBeforeDelete", s.confirm_before_delete),
        ("autoSaveDrafts", s.auto_save_drafts),
        ("attachmentReminder", s.attachment_reminder),
        ("defaultSignatureEnabled", s.default_signature_enabled),
        ("holdExternalContent", s.hold_external_content),
        ("linkSafetyEnabled", s.link_safety_enabled),
        ("linkSafetyClickConfirm", s.link_safety_click_confirm),
        ("trackerBlockingEnabled", s.tracker_blocking_enabled),
    ] {
        if let Some(v) = v {
            values.push((key, json!(v)));
        }
    }
    if let Some(list) = &s.important_senders {
        values.push(("importantSenders", json!(list.iter().map(|e| json!({ "match": e.matches, "throughQuietHours": e.through_quiet_hours })).collect::<Vec<_>>())));
    }
    if let Some(list) = &s.templates {
        values.push(("templates", json!(list.iter().map(|t| json!({ "name": t.name, "body": t.body })).collect::<Vec<_>>())));
    }
    for (key, v) in values {
        if let Some((kind, _)) = prefs::pref(key) {
            if let Some(stored) = prefs::encode(kind, &v) {
                put_in(c, key, &stored)?;
            }
        }
    }
    if let Some(l) = s.language.as_deref().filter(|l| prefs::LANGUAGES.contains(l)) {
        put_in(c, prefs::LANGUAGE, l)?;
    }
    if let Some(p) = s.notification_preview {
        put_in(c, prefs::NOTIFICATION_PREVIEW, if p { "true" } else { "false" })?;
    }
    Ok(())
}

/// The id of the account already here under `email` (matched as `email_taken` does), if any.
fn account_with(engine: &Engine, email: &str) -> Result<Option<String>, RpcError> {
    engine
        .read(|c| c.query_row("SELECT id FROM accounts WHERE email = ?1 COLLATE NOCASE", [email], |r| r.get(0)).optional())
        .map_err(|e| RpcError::Internal(e.to_string()))
}

/// The desktop's look on the phone: the bundle's accounts (by id) take the desktop's order and
/// colors (an account without a color keeps its own), every other account follows them in the
/// order it had. One write.
fn place(engine: &Engine, mut placed: Vec<(u64, String, Option<String>)>) -> Result<(), RpcError> {
    placed.sort_by_key(|p| p.0);
    engine
        .write(|c| {
            let mut st = c.prepare(&format!("SELECT id FROM accounts ORDER BY {}", accounts::LIST_ORDER))?;
            let rest = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            let mut pos = 0i64;
            for (_, id, color) in &placed {
                c.execute("UPDATE accounts SET sort_order = ?1, color = COALESCE(?2, color) WHERE id = ?3", rusqlite::params![pos, color, id])?;
                pos += 1;
            }
            let ours: HashSet<&str> = placed.iter().map(|p| p.1.as_str()).collect();
            for id in rest.iter().filter(|id| !ours.contains(id.as_str())) {
                c.execute("UPDATE accounts SET sort_order = ?1 WHERE id = ?2", rusqlite::params![pos, id])?;
                pos += 1;
            }
            Ok(())
        })
        .map_err(|e| RpcError::Internal(e.to_string()))
}

/// A bundle account as the row and secret every add path stores, or why the phone cannot use it.
/// The bundle speaks the engine's vocabulary already; this checks it, since a code is input.
fn to_row<'a>(a: &'a PhoneAccount, email: &str) -> Result<(AccountRow, Credential), &'static str> {
    let at = email.find('@');
    if at.is_none_or(|i| i == 0 || i + 1 >= email.len()) || email.chars().any(char::is_whitespace) {
        return Err("invalid");
    }
    let nonblank = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    // Borrowed, never copied: the one copy is the one the credential holds.
    let secret = |s: &'a Option<String>| s.as_deref().filter(|s| !s.is_empty());

    let cred = match a.auth {
        PhoneAuth::Password | PhoneAuth::Bearer => Credential::from_password(secret(&a.password).ok_or("no-secret")?),
        PhoneAuth::OAuth2 => {
            Credential { refresh: Some(secret(&a.refresh).ok_or("no-secret")?.to_string()), client_id: nonblank(&a.client_id), ..Credential::default() }
        }
    };
    let mut row = match a.kind {
        PhoneKind::Imap => {
            let host = nonblank(&a.imap_host).ok_or("invalid")?;
            let security = nonblank(&a.security).unwrap_or_else(|| "ssl".into());
            if !matches!(security.as_str(), "ssl" | "starttls" | "none") {
                return Err("invalid");
            }
            let mut row = AccountRow::password(email, &host, a.imap_port.filter(|p| *p > 0).unwrap_or(993), &security);
            // No SMTP server on the computer: none here either (sending then says so), never a guess.
            if let Some(smtp) = nonblank(&a.smtp_host) {
                let smtp_security = nonblank(&a.smtp_security).unwrap_or_else(|| "ssl".into());
                if !matches!(smtp_security.as_str(), "ssl" | "starttls") {
                    return Err("invalid");
                }
                let default_port = if smtp_security == "ssl" { 465 } else { 587 };
                row.smtp_host = Some(smtp);
                row.smtp_port = Some(a.smtp_port.filter(|p| *p > 0).unwrap_or(default_port));
                row.smtp_security = Some(smtp_security);
            }
            match a.auth {
                PhoneAuth::Password => {}
                PhoneAuth::OAuth2 => {
                    let provider = nonblank(&a.provider).ok_or("invalid")?;
                    if provider != "google" && provider != "microsoft" {
                        return Err("invalid");
                    }
                    row.auth = "oauth2".into();
                    row.provider = Some(provider);
                }
                PhoneAuth::Bearer => return Err("invalid"),
            }
            row
        }
        PhoneKind::Graph => {
            if a.auth != PhoneAuth::OAuth2 || nonblank(&a.provider).as_deref() != Some("microsoft") {
                return Err("invalid");
            }
            // Graph needs no host; the column is required, so it holds Outlook's IMAP, unused (as a
            // Microsoft sign-in stores it).
            let mut row = AccountRow::password(email, "outlook.office365.com", 993, "ssl");
            row.kind = "graph".into();
            row.auth = "oauth2".into();
            row.provider = Some("microsoft".into());
            row
        }
        PhoneKind::Jmap => {
            let auth = match a.auth {
                PhoneAuth::Password => "password",
                PhoneAuth::Bearer => "bearer",
                PhoneAuth::OAuth2 => return Err("invalid"),
            };
            // The add form's own check: https only, no user name or password in the URL.
            let url = crate::backend::jmap::session_url(&nonblank(&a.jmap_url).ok_or("invalid")?).map_err(|_| "invalid")?;
            let (host, port) = crate::backend::jmap::host_port(&url);
            let mut row = AccountRow::password(email, &host, port, "ssl");
            row.kind = "jmap".into();
            row.auth = auth.into();
            row.jmap_url = Some(url.to_string());
            row
        }
    };
    let name = a.display_name.trim();
    row.display_name = if name.is_empty() { email.to_string() } else { name.to_string() };
    Ok((row, cred))
}
