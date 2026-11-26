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
//! The desktop's tags come along too (`apply_tags`): every tag, and the assignments the code had
//! room for (the newest of each tag and account in turn, core `transfer::phone::tags`), on the
//! accounts of the code that are on the phone afterwards, keyed as desktop keys them (`tags.rs`).
//!
//! The desktop's custom fields, saved views and Auto Tag rules come too (`apply_fields`,
//! `apply_views`, `apply_auto_tags`), each as far as the phone can follow it.
//!
//! Reply: `{ok: true, imported: [email], existing: [email], skipped: [{email, reason}],
//! settingsApplied: bool, tags: null | {tags, assigned}, fields, views, autoTags}` (`settingsApplied`: this import applied
//! the desktop's global settings; `tags`: null when the code carried none), or
//! `{ok: false, code}` with `PASSWORD_SHORT` (under 12 characters, nothing tried), `BAD_PASSWORD`
//! (wrong password or a modified code, indistinguishable) or `INVALID` (not a whole MailVault
//! code, or bad params). A skip `reason` is `invalid` (settings the phone cannot use),
//! `no-secret` or `internal` (the secret store refused it).
//!
//! Never logged or put in a reply or error: the password, a frame, the bundle or a secret.

use mailvault_core::app_db::db::in_txn;
use crate::accounts::{self, AccountRow, InsertError};
use crate::db::Engine;
use crate::rpc::RpcError;
use crate::secrets::Credential;
use crate::settings::{self as prefs, put_in};
use mailvault_core::app_db::fields::{self as field_store, Field, GLOBAL};
use mailvault_core::app_db::tags::{self as tag_store, Target};
use mailvault_core::app_db::views::{self as view_store, View};
use mailvault_core::transfer::phone::{
    auto_tags as phone_auto_tags, decode_phone_bundle, hex_color, tags as phone_tags, PhoneAccount, PhoneAuth, PhoneAutoTags, PhoneError, PhoneFields, PhoneKind, PhoneSettings, PhoneTags,
    PhoneViews, MAX_FRAMES, MAX_FRAME_CHARS, MIN_PASSWORD_CHARS,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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
    if settings_applied {
        // The search index settings may have come with them.
        crate::search::wake(engine.shared());
    }
    let tags = bundle.tags.as_ref().map(|t| apply_tags(engine, &here, t));
    let (fields, field_ids) = match bundle.fields.as_ref().map(|f| apply_fields(engine, &here, f)) {
        Some((reply, ids)) => (Some(reply), ids),
        None => (None, HashMap::new()),
    };
    let views = bundle.views.as_ref().map(|v| apply_views(engine, &here, v, &field_ids));
    let auto_tags = bundle.auto_tags.as_ref().map(|a| apply_auto_tags(engine, a));
    Ok(json!({
        "ok": true, "imported": imported, "existing": existing, "skipped": skipped, "settingsApplied": settings_applied,
        "tags": tags, "fields": fields, "views": views, "autoTags": auto_tags,
    }))
}

/// The desktop's tags (`tags.rs`): every tag (one already here by name, case ignored, is kept
/// as it is), and each assignment of an account of this code that is on the phone now (`here`:
/// lowercased addresses), by the desktop's key. A desktop uid key goes to IMAP accounts only.
/// Never fails the import: a store that cannot be written is logged and answers `null` counts.
/// Answers `{tags, assigned}`: tags in the code, assignments it applied (already there included).
fn apply_tags(engine: &Engine, here: &HashSet<String>, block: &PhoneTags) -> Value {
    let shared = engine.shared();
    let mut targets: Vec<(u32, Vec<Target>)> = Vec::new();
    for tagged in &block.assigned {
        if !here.contains(&tagged.email.trim().to_lowercase()) {
            continue;
        }
        let account = engine
            .read(|c| {
                c.query_row("SELECT id, kind FROM accounts WHERE email = ?1 COLLATE NOCASE", [tagged.email.trim()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .optional()
            })
            .ok()
            .flatten();
        let Some((id, kind)) = account else { continue };
        let kind = match kind.as_str() {
            "graph" => PhoneKind::Graph,
            "jmap" => PhoneKind::Jmap,
            _ => PhoneKind::Imap,
        };
        let keys = phone_tags::keys_for(kind, tagged);
        targets.push((tagged.tag, keys.into_iter().map(|msg_key| Target { account_id: id.clone(), msg_key }).collect()));
    }
    let applied = shared.app_db.with(|c| {
        let mut ids = Vec::with_capacity(block.list.len());
        for tag in &block.list {
            let name: String = tag.name.trim().chars().take(crate::tags::MAX_NAME_CHARS).collect();
            if name.is_empty() {
                ids.push(None);
                continue;
            }
            ids.push(Some(tag_store::ensure(c, &name, &hex_color(&tag.color).unwrap_or_default())?.id));
        }
        let mut assigned = 0;
        for (index, list) in &targets {
            if let Some(Some(tag_id)) = ids.get(*index as usize) {
                assigned += tag_store::assign(c, tag_id, list)?;
            }
        }
        Ok(json!({ "tags": ids.iter().flatten().count(), "assigned": assigned }))
    });
    applied.unwrap_or_else(|e| {
        shared.log(&format!("[transfer] tags not imported: {e}"));
        json!({ "tags": null, "assigned": null })
    })
}

/// The phone account (`id`, kind) of an address of this code that is on the phone now (`here`).
fn phone_account(engine: &Engine, here: &HashSet<String>, email: &str) -> Option<(String, PhoneKind)> {
    if !here.contains(&email.trim().to_lowercase()) {
        return None;
    }
    let (id, kind) = engine
        .read(|c| {
            c.query_row("SELECT id, kind FROM accounts WHERE email = ?1 COLLATE NOCASE", [email.trim()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()
        })
        .ok()
        .flatten()?;
    let kind = match kind.as_str() {
        "graph" => PhoneKind::Graph,
        "jmap" => PhoneKind::Jmap,
        _ => PhoneKind::Imap,
    };
    Some((id, kind))
}

/// The desktop's custom fields (`fields.rs`): every shared field and every field of an account of
/// this code that is on the phone now, under the desktop's id (a saved view names it); a field
/// the phone already has under that id is updated, one its scope already has by name is kept as
/// it is (the desktop's is mapped onto it). Then each value that fits its field, by the desktop's
/// key (a desktop uid key on IMAP accounts only). A field or value the phone would refuse is left
/// out. Never fails the import: a store that cannot be written is logged and answers `null`
/// counts. Answers `({fields, values}, desktop field id -> phone field id)`.
fn apply_fields(engine: &Engine, here: &HashSet<String>, block: &PhoneFields) -> (Value, HashMap<String, String>) {
    let shared = engine.shared();
    let mut wanted: Vec<Option<Field>> = Vec::with_capacity(block.list.len());
    let mut accounts: HashMap<String, Option<(String, PhoneKind)>> = HashMap::new();
    let mut account_of = |email: &str| accounts.entry(email.trim().to_lowercase()).or_insert_with(|| phone_account(engine, here, email)).clone();
    for f in &block.list {
        let scope = match &f.email {
            None => Some(GLOBAL.to_string()),
            Some(email) => account_of(email).map(|(id, _)| id),
        };
        let field = scope.and_then(|scope| {
            crate::fields::sanitized(Field { id: f.id.clone(), scope, name: f.name.clone(), kind: f.kind.clone(), options: f.options.clone(), position: 0 })
        });
        wanted.push(field);
    }
    let mut values: Vec<(usize, String, Vec<(String, Value)>)> = Vec::new();
    for group in &block.values {
        let Some((id, kind)) = account_of(&group.email) else { continue };
        let keyed = group
            .values
            .iter()
            .filter(|(k, _)| !k.trim().is_empty() && (kind == PhoneKind::Imap || !mailvault_core::app_db::identity::is_uid_fallback(k.trim())))
            .map(|(k, v)| (k.trim().to_string(), v.clone()))
            .collect();
        values.push((group.field as usize, id, keyed));
    }
    let mut mapped: HashMap<String, String> = HashMap::new();
    let applied = shared.app_db.with(|c| in_txn(c, || {
        // Index in the block -> the phone's field.
        let mut placed: Vec<Option<Field>> = Vec::with_capacity(wanted.len());
        for field in &wanted {
            let Some(field) = field else {
                placed.push(None);
                continue;
            };
            let same_name = field_store::list_all(c)?
                .into_iter()
                .find(|f| f.scope == field.scope && f.name.to_lowercase() == field.name.to_lowercase() && f.id != field.id);
            // The phone has a field of that name in that scope already: the desktop's maps onto it.
            // Else the desktop's is made, or updated when the phone has it by id.
            let kept = match same_name {
                Some(existing) => Some(existing),
                None => field_store::save(c, field).ok(),
            };
            if let Some(kept) = &kept {
                mapped.insert(field.id.clone(), kept.id.clone());
            }
            placed.push(kept);
        }
        let mut count = 0;
        for (index, account, list) in &values {
            let Some(Some(field)) = placed.get(*index) else { continue };
            if field.scope != GLOBAL && &field.scope != account {
                continue;
            }
            for (key, value) in list {
                if let Ok(Some(value)) = crate::fields::value_for(field, value) {
                    field_store::set_value(c, account, key, &field.id, Some(&value))?;
                    count += 1;
                }
            }
        }
        Ok(json!({ "fields": placed.iter().flatten().count(), "values": count }))
    }));
    let reply = applied.unwrap_or_else(|e| {
        shared.log(&format!("[transfer] fields not imported: {e}"));
        mapped.clear();
        json!({ "fields": null, "values": null })
    });
    (reply, mapped)
}

/// The desktop's saved views (`views.rs`), under the desktop's ids (one the phone has by id is
/// replaced): each whose accounts (by address) are all on the phone now from this code (`here`),
/// whose tags (by name) the phone has, and whose field conditions name a field the phone has
/// (`field_ids`: desktop id -> phone id, from [`apply_fields`]). Any other is left out whole:
/// dropping a condition would widen the view. A desktop whose starters were seeded makes the
/// phone's list the desktop's (the phone never seeds them after). No Premium cap: an import
/// brings every view. Never fails the import. Answers `{views}`: views applied.
fn apply_views(engine: &Engine, here: &HashSet<String>, block: &PhoneViews, field_ids: &HashMap<String, String>) -> Value {
    let shared = engine.shared();
    let mut accounts: HashMap<String, Option<String>> = HashMap::new();
    let mut wanted: Vec<(View, Vec<String>)> = Vec::new();
    'views: for v in &block.list {
        let mut ids = Vec::with_capacity(v.def.accounts.len());
        for email in &v.def.accounts {
            let id = accounts.entry(email.trim().to_lowercase()).or_insert_with(|| phone_account(engine, here, email).map(|(id, _)| id)).clone();
            match id {
                Some(id) => ids.push(id),
                None => continue 'views,
            }
        }
        let mut def = v.def.clone();
        def.accounts = ids;
        let view = View { id: v.id.clone(), name: v.name.clone(), icon: v.icon.clone(), position: 0, builtin: v.builtin.clone(), def };
        let Ok(view) = crate::views::checked(view) else { continue };
        wanted.push((view, v.def.tags.clone()));
    }
    let applied = shared.app_db.with(|c| in_txn(c, || {
        if block.seeded && !view_store::seeded(c) {
            view_store::mark_seeded(c)?;
        }
        let mut count = 0;
        'each: for (mut view, tag_names) in wanted {
            let Some(tag_ids) = tag_store::ids_by_names(c, &tag_names)?.into_iter().collect::<Option<Vec<_>>>() else { continue };
            view.def.tags = tag_ids;
            for filter in &mut view.def.fields {
                match field_ids.get(&filter.field_id) {
                    Some(id) => filter.field_id = id.clone(),
                    None if field_store::get(c, &filter.field_id)?.is_some() => {}
                    None => continue 'each,
                }
            }
            if view_store::save(c, &view).is_ok() {
                count += 1;
            }
        }
        Ok(json!({ "views": count }))
    }));
    applied.unwrap_or_else(|e| {
        shared.log(&format!("[transfer] views not imported: {e}"));
        json!({ "views": null })
    })
}

/// The desktop's Auto Tag rules (`auto_tags.rs`), under the desktop's ids (one the phone has by id
/// is updated): each whose tag (by name) the phone has. An enabled rule is turned on as of now on
/// a phone that did not have it, so it never reaches back over mail already here; the endpoint it
/// was allowed to use comes as its provider (the phone runs it only when that is the phone's
/// endpoint too), but never the permission to send mail there (`allowRemote` arrives off unless
/// the phone gave it for that endpoint already): nothing leaves the phone until its owner says so
/// on the phone. Never fails the import. Answers `{autoTags}`: rules applied.
pub(crate) fn apply_auto_tags(engine: &Engine, block: &PhoneAutoTags) -> Value {
    let shared = engine.shared();
    let applied = shared.app_db.with(|c| in_txn(c, || {
        let mut count = 0;
        for r in &block.list {
            let Some(Some(tag_id)) = tag_store::ids_by_names(c, std::slice::from_ref(&r.tag))?.into_iter().next() else { continue };
            let provider = phone_auto_tags::provider_of(r.endpoint.as_ref());
            // Sending mail to an endpoint is the phone owner's yes, given on the phone: a code
            // (anyone's QR) never grants it. A rule the phone has already keeps the phone's own
            // answer while it names the same endpoint; any other arrives with it off, the
            // endpoint kept as its provider so the phone's toggle confirms exactly that one.
            let allow_remote = r.allow_remote
                && mailvault_core::app_db::auto_tags::get(c, &r.id)?.is_some_and(|had| had.allow_remote && had.provider == provider);
            let draft = mailvault_core::app_db::auto_tags::RuleDraft {
                name: r.name.clone(),
                instruction: r.instruction.clone(),
                constraints: r.constraints.clone(),
                tag_id,
                inbox_action: r.inbox_action,
                min_confidence: r.min_confidence.clamp(0.0, 1.0),
                allow_remote,
                provider,
                enabled: r.enabled,
            };
            if mailvault_core::app_db::auto_tags::put(c, &r.id, draft).is_ok() {
                count += 1;
            }
        }
        Ok(json!({ "autoTags": count }))
    }));
    crate::auto_tags::wake(shared);
    applied.unwrap_or_else(|e| {
        shared.log(&format!("[transfer] auto-tag rules not imported: {e}"));
        json!({ "autoTags": null })
    })
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

/// The viewer bar the phone takes from the desktop's reader quick actions: each desktop action as
/// the phone has it (star is flag, the read pair its toggle, every delete delete), once, in the
/// desktop's order, at most the four the bar holds. The page's `fromDesktop` (quickActions.js)
/// maps the desktop presets the same way.
pub(crate) fn phone_reader_actions(desktop: &[String]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for a in desktop {
        let phone = match a.as_str() {
            "toggleRead" | "markRead" | "markUnread" => "toggleRead",
            "star" | "unstar" => "flag",
            "move" => "move",
            "delete" | "deleteServer" | "deleteEverywhere" => "delete",
            "spam" => "spam",
            "reply" => "reply",
            "replyAll" => "replyAll",
            "forward" => "forward",
            _ => continue,
        };
        if !out.contains(&phone) {
            out.push(phone);
        }
    }
    out.truncate(4);
    out
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
    // A Google font (`google:<Family>`) is no phone font: the check leaves it out.
    text("appFont", &s.app_font);
    text("listDensity", &s.list_density);
    text("signatureDisplay", &s.signature_display);
    text("actionButtonDisplay", &s.action_button_display);
    text("badgeMode", &s.badge_mode);
    text("viewStyle", &s.view_style);
    text("appIcon", &s.app_icon);
    if let Some(v) = s.text_scale {
        values.push(("textScale", json!(v)));
    }
    if let Some(v) = s.list_preview_lines {
        values.push(("listPreviewLines", json!(v)));
    }
    // The phone plays the system's sound or none: any desktop sound is a sound.
    if let Some(v) = &s.notification_sound {
        values.push(("notificationSound", json!(v != "none")));
    }
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
        ("holdExternalContent", s.hold_external_content),
        ("linkSafetyEnabled", s.link_safety_enabled),
        ("linkSafetyClickConfirm", s.link_safety_click_confirm),
        ("trackerBlockingEnabled", s.tracker_blocking_enabled),
        ("trackpadSwipeEnabled", s.trackpad_swipe_enabled),
        ("refreshOnLaunch", s.refresh_on_launch),
        ("autoDownloadAttachments", s.auto_download_attachments),
        ("afterDeleteSameAccount", s.after_delete_same_account),
        ("badgeEnabled", s.badge_enabled),
        ("searchIndexBodies", s.search_index_bodies),
        ("searchIndexAttachments", s.search_index_attachments),
    ] {
        if let Some(v) = v {
            values.push((key, json!(v)));
        }
    }
    if let Some(list) = &s.important_senders {
        values.push(("importantSenders", json!(list.iter().map(|e| json!({ "match": e.matches, "throughQuietHours": e.through_quiet_hours })).collect::<Vec<_>>())));
    }
    // A desktop bar of only actions the phone lacks leaves the phone's own bar, not an empty one.
    if let Some(bar) = s.quick_actions_reader.as_deref().map(phone_reader_actions).filter(|b| !b.is_empty()) {
        values.push(("quickActionsReader", json!(bar)));
    }
    // The row wheel and selection bar, as the desktop keeps them (the page normalizes).
    if let Some(q) = &s.quick_actions {
        values.push(("quickActions", q.clone()));
    }
    // AI on an endpoint; a loopback URL is the desktop's own computer, not the phone.
    if let Some(ai) = &s.ai_endpoint {
        let url = ai.endpoint_url.as_deref().map(str::trim).unwrap_or("");
        if !url.is_empty() && !mailvault_core::ai::endpoint_is_on_device(url) {
            values.push(("aiEndpointUrl", json!(url)));
            if let Some(m) = &ai.endpoint_model {
                values.push(("aiEndpointModel", json!(m.trim())));
            }
            for (key, v) in [("aiEnabled", ai.enabled), ("aiSkipPreview", ai.skip_preview)] {
                if let Some(v) = v {
                    values.push((key, json!(v)));
                }
            }
        }
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
