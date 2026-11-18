//! Tags on the phone: desktop's MailVault tags (core `app_db::tags`), kept in the phone's core
//! `app.db` (`<data_dir>/core/app.db`, beside Network Activity's store; its `tags` and
//! `tag_assignments` tables come with core's schema, so `mobile.db` needs no step). A tag never
//! reaches a server, as on desktop. This file is wiring only: the store, the key rule and the
//! search term are core's.
//!
//! # Identity
//!
//! An assignment is keyed by `(accountId, msg_key)`, never by the phone's `(folder, uid)`. The key
//! is core's [`msg_key_or_remote`]: the Message-ID (what desktop keys by, so an import from the
//! computer lands on the same messages), else for a Graph or JMAP message `r:<remote id>` (the
//! phone's uids there are its own and a resync can renumber them; the server's id survives a
//! resync, and for JMAP a move too; Graph gives a moved message a new id), else for IMAP desktop's
//! `u:<vault_dir_name(folder)>:<uid>` (the server's uid, so a desktop key for the same message
//! matches). The engine derives the key from its own `messages` row: callers name rows by
//! `{accountId, folder, uid}` and never see a key.
//!
//! # API (for the phone UI, saved views and auto-tags)
//!
//! - `mobile.tags.list {}` -> `{tags: [{id, name, color, position, count}]}`, display order;
//!   `count` is the messages carrying the tag.
//! - `mobile.tags.create {name, color?}` -> `{tag, tags}`: the tag of that name (case ignored),
//!   made when there is none. `color` is `#rrggbb` or empty (the neutral chip); a name is at most
//!   [`MAX_NAME_CHARS`] characters.
//! - `mobile.tags.update {id, name?, color?}` -> `{tags}`: rename and/or recolor. A name another
//!   tag has is `INVALID`.
//! - `mobile.tags.delete {id}` -> `{tags}`: the tag and every assignment of it.
//! - `mobile.tags.assign {tagId, items: [{accountId, folder, uid}]}` -> `{count}`: messages that
//!   now carry it (an unknown tag is `INVALID`; a row the phone does not hold is skipped).
//! - `mobile.tags.unassign {tagId, items}` -> `{count}`: assignments removed.
//! - `mobile.tags.forMessages {items}` -> `{tags: [[tagId]]}`: per requested row, in request
//!   order, the ids of its tags in display order (empty for an untagged or unknown row).
//! - Filtering: `mobile.search.local` reads desktop's `tag:Name` / `tag:"Two words"` terms
//!   ([`narrow`], [`tagged_rows`]); a query of tag terms alone lists every message carrying them.
//!
//! Rust callers (views, auto-tags): [`AppDb::with`] for the store, [`keys_of`] for row keys,
//! [`tagged_rows`] for the rows carrying a set of tags.
//!
//! An account removed from the phone takes its assignments with it ([`forget_account`]); the tags
//! stay. An import from the computer (`transfer.rs`) brings the desktop's tags and the newest
//! assignments the code had room for.
//!
//! Threading: every call runs on the RPC thread the shell gives it. `app.db` has its own
//! connection here (a mutex, held only for one short statement or transaction), apart from
//! `mobile.db`'s writer and readers, so a tag call never waits on a sync write and a list read
//! never waits on a tag call.

use crate::db::{Engine, Shared};
use crate::rpc::{parse, RpcError};
use mailvault_core::app_db::identity::msg_key_or_remote;
use mailvault_core::app_db::tags::{self as store, Target};
use mailvault_core::search_index::text::vault_dir_name;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

/// Longest tag name (desktop's field takes 80).
pub(crate) const MAX_NAME_CHARS: usize = 80;
/// Most rows one call names.
const MAX_ITEMS: usize = 5000;

/// The phone's core `app.db`, opened on first use.
pub(crate) struct AppDb {
    dir: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl AppDb {
    pub(crate) fn new(data_dir: &std::path::Path) -> AppDb {
        AppDb { dir: crate::net_activity::core_dir(data_dir), conn: Mutex::new(None) }
    }

    /// Runs `f` on the store's connection (opening it, and creating the file, the first time).
    pub(crate) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let mut slot = crate::db::lock(&self.conn);
        if slot.is_none() {
            *slot = Some(mailvault_core::app_db::db::open(&self.dir).map_err(|e| e.to_string())?);
        }
        f(slot.as_ref().expect("opened above"))
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    pub(crate) account_id: String,
    pub(crate) folder: String,
    pub(crate) uid: u32,
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn items(v: Value) -> Result<Vec<Item>, RpcError> {
    let items: Vec<Item> = serde_json::from_value(v).map_err(|e| RpcError::Invalid(format!("items: {e}")))?;
    if items.len() > MAX_ITEMS {
        return Err(RpcError::Invalid(format!("at most {MAX_ITEMS} items")));
    }
    Ok(items)
}

/// The key each item's message is stored under, in order (`None`: the phone holds no such row).
pub(crate) fn keys_of(shared: &Shared, items: &[Item]) -> Result<Vec<Option<Target>>, RpcError> {
    shared
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT m.message_id, r.remote_id FROM messages m
                 LEFT JOIN remote_ids r ON r.account_id = m.account_id AND r.folder = m.folder AND r.uid = m.uid
                 WHERE m.account_id = ?1 AND m.folder = ?2 AND m.uid = ?3",
            )?;
            items
                .iter()
                .map(|it| {
                    let found = st
                        .query_row((&it.account_id, &it.folder, it.uid as i64), |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
                        .optional()?;
                    Ok::<_, rusqlite::Error>(found.map(|(message_id, remote_id)| Target {
                        account_id: it.account_id.clone(),
                        msg_key: msg_key_or_remote(Some(&message_id), &vault_dir_name(&it.folder), it.uid, remote_id.as_deref()),
                    }))
                })
                .collect()
        })
        .map_err(internal)
}

fn listed(shared: &Shared) -> Result<Value, RpcError> {
    let tags = shared.app_db.with(store::list).map_err(internal)?;
    Ok(json!(tags))
}

pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    Ok(json!({ "tags": listed(engine.shared())? }))
}

/// A tag name as stored: trimmed, at most [`MAX_NAME_CHARS`].
fn name_of(raw: &str) -> Result<String, RpcError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(RpcError::Invalid("a tag needs a name".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(RpcError::Invalid(format!("a tag name has at most {MAX_NAME_CHARS} characters")));
    }
    Ok(name.to_string())
}

/// `#rrggbb` (lowercased) or empty: a color lands in a style attribute.
fn color_of(raw: Option<&str>) -> Result<String, RpcError> {
    match raw.map(str::trim).filter(|c| !c.is_empty()) {
        None => Ok(String::new()),
        Some(c) => mailvault_core::transfer::phone::hex_color(c).ok_or_else(|| RpcError::Invalid("color must be #rrggbb".into())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateParams {
    name: String,
    #[serde(default)]
    color: Option<String>,
}

pub(crate) fn create(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: CreateParams = parse(params)?;
    let (name, color) = (name_of(&p.name)?, color_of(p.color.as_deref())?);
    let tag = engine.shared().app_db.with(|c| store::ensure(c, &name, &color)).map_err(internal)?;
    Ok(json!({ "tag": tag, "tags": listed(engine.shared())? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateParams {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

pub(crate) fn update(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: UpdateParams = parse(params)?;
    let name = p.name.as_deref().map(name_of).transpose()?;
    let color = p.color.as_deref().map(|c| color_of(Some(c))).transpose()?;
    let taken = engine
        .shared()
        .app_db
        .with(|c| {
            if let Some(name) = &name {
                let other: Option<String> = c
                    .query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE AND id != ?2", (name, &p.id), |r| r.get(0))
                    .optional()
                    .map_err(|e| e.to_string())?;
                if other.is_some() {
                    return Ok(true);
                }
                store::rename(c, &p.id, name)?;
            }
            if let Some(color) = &color {
                store::set_color(c, &p.id, color)?;
            }
            Ok(false)
        })
        .map_err(internal)?;
    if taken {
        return Err(RpcError::Invalid("another tag has that name".into()));
    }
    Ok(json!({ "tags": listed(engine.shared())? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

pub(crate) fn delete(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    engine.shared().app_db.with(|c| store::delete(c, &p.id)).map_err(internal)?;
    Ok(json!({ "tags": listed(engine.shared())? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignParams {
    tag_id: String,
    items: Value,
}

fn targets(engine: &Engine, items_json: Value) -> Result<Vec<Target>, RpcError> {
    Ok(keys_of(engine.shared(), &items(items_json)?)?.into_iter().flatten().collect())
}

pub(crate) fn assign(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: AssignParams = parse(params)?;
    let targets = targets(engine, p.items)?;
    let count = engine
        .shared()
        .app_db
        .with(|c| {
            let known = store::list(c)?.iter().any(|t| t.id == p.tag_id);
            if !known {
                return Ok(None);
            }
            store::assign(c, &p.tag_id, &targets).map(Some)
        })
        .map_err(internal)?
        .ok_or_else(|| RpcError::Invalid("unknown tag".into()))?;
    Ok(json!({ "count": count }))
}

pub(crate) fn unassign(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: AssignParams = parse(params)?;
    let targets = targets(engine, p.items)?;
    let count = engine.shared().app_db.with(|c| store::unassign(c, &p.tag_id, &targets)).map_err(internal)?;
    Ok(json!({ "count": count }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForParams {
    items: Value,
}

pub(crate) fn for_messages(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ForParams = parse(params)?;
    Ok(json!({ "tags": for_items(engine.shared(), &items(p.items)?)? }))
}

/// The tag ids each of `items` carries, in order (display order within a row; empty for an
/// untagged row or one the phone does not hold).
pub(crate) fn for_items(shared: &Shared, items: &[Item]) -> Result<Vec<Vec<String>>, RpcError> {
    let keys = keys_of(shared, items)?;
    let mut per_account: HashMap<&str, Vec<String>> = HashMap::new();
    for t in keys.iter().flatten() {
        per_account.entry(t.account_id.as_str()).or_default().push(t.msg_key.clone());
    }
    if per_account.is_empty() {
        return Ok(vec![Vec::new(); keys.len()]);
    }
    let found = shared
        .app_db
        .with(|c| {
            let mut out: HashMap<(String, String), Vec<String>> = HashMap::new();
            for (account, keys) in &per_account {
                for (key, ids) in store::for_messages(c, account, keys)? {
                    out.insert((account.to_string(), key), ids);
                }
            }
            Ok(out)
        })
        .map_err(internal)?;
    Ok(keys
        .iter()
        .map(|t| t.as_ref().and_then(|t| found.get(&(t.account_id.clone(), t.msg_key.clone())).cloned()).unwrap_or_default())
        .collect())
}

/// Takes an account's assignments off (the account is leaving the phone). A failure is logged:
/// the account goes regardless.
pub(crate) fn forget_account(shared: &Shared, account_id: &str) {
    if let Err(e) = shared.app_db.with(|c| store::forget_account(c, account_id)) {
        shared.log(&format!("[tags] forgetting an account's assignments: {e}"));
    }
}

/// A search query's tag terms: the rest of the query and the ids of the named tags, or `None`
/// when a named tag does not exist (such a search finds nothing, as on desktop).
pub(crate) fn narrow(shared: &Shared, query: &str) -> Result<(String, Option<Vec<String>>), RpcError> {
    let (rest, names) = store::lift_tag_terms(query);
    if names.is_empty() {
        return Ok((rest, Some(Vec::new())));
    }
    let ids = shared.app_db.with(|c| store::ids_by_names(c, &names)).map_err(internal)?;
    Ok((rest, ids.into_iter().collect::<Option<Vec<_>>>()))
}

/// One message row carrying a tag set: where it is and when it is dated.
pub(crate) struct Tagged {
    pub(crate) account_id: String,
    pub(crate) folder: String,
    pub(crate) uid: u32,
    pub(crate) date_ms: i64,
}

/// Every row (not deleted locally) of `accounts` (in `folder` only, when named) whose message
/// carries every one of `tag_ids`, newest first. A message in two folders is two rows, as in a
/// search. Reads the store once per account, then the account's rows once (keys are derived
/// here, not stored, so this is a scan of the account's rows; it runs on the RPC thread, on a
/// reader).
pub(crate) fn tagged_rows(shared: &Shared, accounts: &[String], folder: Option<&str>, tag_ids: &[String]) -> Result<Vec<Tagged>, RpcError> {
    let mut out = Vec::new();
    if tag_ids.is_empty() {
        return Ok(out);
    }
    for account in accounts {
        let keys: HashSet<String> = shared.app_db.with(|c| store::messages_with_every_tag(c, account, tag_ids)).map_err(internal)?.into_iter().collect();
        if keys.is_empty() {
            continue;
        }
        let rows = shared
            .read(|c| {
                let mut st = c.prepare_cached(
                    "SELECT m.folder, m.uid, m.message_id, r.remote_id, m.date_ms FROM messages m
                     LEFT JOIN remote_ids r ON r.account_id = m.account_id AND r.folder = m.folder AND r.uid = m.uid
                     WHERE m.account_id = ?1 AND (?2 IS NULL OR m.folder = ?2) AND COALESCE(m.local_deleted, 0) = 0",
                )?;
                let rows = st
                    .query_map((account, folder), |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, i64>(4)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map_err(internal)?;
        for (f, uid, message_id, remote_id, date_ms) in rows {
            let uid = uid as u32;
            if keys.contains(&msg_key_or_remote(Some(&message_id), &vault_dir_name(&f), uid, remote_id.as_deref())) {
                out.push(Tagged { account_id: account.clone(), folder: f, uid, date_ms });
            }
        }
    }
    out.sort_by(|a, b| b.date_ms.cmp(&a.date_ms).then(b.uid.cmp(&a.uid)));
    Ok(out)
}
