//! Custom fields on the phone: desktop's fields (core `app_db::fields`), kept in the phone's core
//! `app.db` beside the tags (`tags.rs` [`AppDb`]: its `fields` and `field_values` tables come with
//! core's schema). A value never reaches a server, as on desktop. This file is wiring only: the
//! store, the key rule and the ordering rules are core's.
//!
//! A field belongs to one account (`scope` is the phone's account id) or to every account (`*`).
//! Values are keyed by `(accountId, msg_key)`, the key the tags use ([`crate::tags::keys_of`]:
//! core `msg_key_or_remote`); callers name rows by `{accountId, folder, uid}`.
//!
//! # API (desktop's `fields.*`, under `mobile.`)
//!
//! - `mobile.fields.list {accountId}` -> `{fields: [{id, scope, name, kind, options, position}]}`:
//!   the shared fields first, then the account's own, each group in its order.
//! - `mobile.fields.save {field}` -> `{field}`: makes the field, or edits the one of that id
//!   (its values stay, its position stays). `scope` is `*` or an account on the phone; `kind` is
//!   one of core's [`fields::KINDS`]; a name and a choice label have at most [`MAX_NAME_CHARS`]
//!   characters; a choice color is `#rrggbb` or empty. A name the scope already has is `INVALID`.
//! - `mobile.fields.reorder {id, delta}` -> `{moved}`: one place up (-1) or down (+1) in its scope.
//! - `mobile.fields.delete {id}` -> `{droppedValues}`: the field and every value given to it.
//! - `mobile.fields.copy {fieldIds, accountId}` -> `{fields}`: those definitions copied into an
//!   account's own (the values stay where they were given; a name it has already is skipped).
//! - `mobile.fields.optionUsage {fieldId}` -> `{usage: {optionId: count}}`.
//! - `mobile.fields.values {items}` -> `{values: [{fieldId: value}]}`, one per item, in order
//!   (empty for a row the phone does not hold or with no value).
//! - `mobile.fields.set {item, fieldId, value}` -> `{}`: `value` null clears; a missing `value` is
//!   `INVALID` (as on desktop). A value must fit the field: a select's choice id, a multi-select's
//!   choice ids, `YYYY-MM-DD`, true/false, or text of at most [`MAX_TEXT_CHARS`] characters (blank
//!   clears). A row the phone does not hold, or a field the row's account cannot see, is `INVALID`.
//!
//! An account removed from the phone takes its values and its own fields ([`forget_account`]).
//! An import from the computer (`transfer.rs`) brings the desktop's fields and the values that fit.
//!
//! Threading: as `tags.rs`, on the RPC thread; `app.db`'s connection is held for one short
//! statement or transaction and never while `mobile.db` is read.

use crate::db::{Engine, Shared};
use crate::rpc::{parse, RpcError};
use crate::tags::{keys_of, Item};
use mailvault_core::app_db::fields::{self as store, Field, FieldOption, GLOBAL};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Longest field name and choice label (desktop's inputs take 80).
pub(crate) const MAX_NAME_CHARS: usize = 80;
/// Longest text value (desktop's input takes 500).
pub(crate) const MAX_TEXT_CHARS: usize = 500;
/// Most choices one field offers.
const MAX_OPTIONS: usize = 200;
/// Longest id (a field's, a choice's): desktop gives out UUIDs.
const MAX_ID_CHARS: usize = 100;
/// Most rows one call names.
const MAX_ITEMS: usize = 5000;

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn invalid(why: impl Into<String>) -> RpcError {
    RpcError::Invalid(why.into())
}

fn account_exists(shared: &Shared, account: &str) -> Result<bool, RpcError> {
    shared
        .read(|c| c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [account], |_| Ok(())).optional().map(|o| o.is_some()))
        .map_err(internal)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    account_id: String,
}

pub(crate) fn list(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ListParams = parse(params)?;
    let fields = engine.shared().app_db.with(|c| store::list(c, &p.account_id)).map_err(internal)?;
    Ok(json!({ "fields": fields }))
}

/// A short, non-blank id.
fn id_of(raw: &str, what: &str) -> Result<String, RpcError> {
    let id = raw.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(invalid(format!("{what} needs an id of at most {MAX_ID_CHARS} characters")));
    }
    Ok(id.to_string())
}

fn name_of(raw: &str, what: &str) -> Result<String, RpcError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(invalid(format!("{what} needs a name")));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid(format!("{what} has at most {MAX_NAME_CHARS} characters")));
    }
    Ok(name.to_string())
}

/// A field as the phone stores it: checked and trimmed (a color lands in a style attribute).
fn checked(shared: &Shared, field: Field) -> Result<Field, RpcError> {
    let id = id_of(&field.id, "a field")?;
    let name = name_of(&field.name, "a field")?;
    if !store::KINDS.contains(&field.kind.as_str()) {
        return Err(invalid(format!("unknown field kind: {}", field.kind)));
    }
    let scope = field.scope.trim().to_string();
    if scope != GLOBAL && !account_exists(shared, &scope)? {
        return Err(invalid("unknown account"));
    }
    if field.options.len() > MAX_OPTIONS {
        return Err(invalid(format!("a field offers at most {MAX_OPTIONS} choices")));
    }
    let mut options: Vec<FieldOption> = Vec::with_capacity(field.options.len());
    for o in field.options {
        let option = FieldOption {
            id: id_of(&o.id, "a choice")?,
            label: name_of(&o.label, "a choice")?,
            color: match o.color.trim() {
                "" => String::new(),
                c => mailvault_core::transfer::phone::hex_color(c).ok_or_else(|| invalid("color must be #rrggbb"))?,
            },
        };
        if options.iter().any(|known| known.id == option.id) {
            return Err(invalid("two choices share an id"));
        }
        options.push(option);
    }
    Ok(Field { id, scope, name, kind: field.kind, options, position: field.position })
}

/// A field from elsewhere (an import) as the phone would store it, leniently: the name cut to
/// [`MAX_NAME_CHARS`], a choice without an id or a label left out, a color that is not `#rrggbb`
/// dropped. `None` when it has no usable id, name or kind. The scope is the caller's.
pub(crate) fn sanitized(field: Field) -> Option<Field> {
    let id = field.id.trim();
    let name: String = field.name.trim().chars().take(MAX_NAME_CHARS).collect();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS || name.is_empty() || !store::KINDS.contains(&field.kind.as_str()) {
        return None;
    }
    let mut options: Vec<FieldOption> = Vec::new();
    for o in field.options.into_iter().take(MAX_OPTIONS) {
        let (oid, label) = (o.id.trim().to_string(), o.label.trim().chars().take(MAX_NAME_CHARS).collect::<String>());
        if oid.is_empty() || oid.chars().count() > MAX_ID_CHARS || label.is_empty() || options.iter().any(|k| k.id == oid) {
            continue;
        }
        options.push(FieldOption { id: oid, label, color: mailvault_core::transfer::phone::hex_color(&o.color).unwrap_or_default() });
    }
    Some(Field { id: id.to_string(), scope: field.scope, name, kind: field.kind, options, position: field.position })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveParams {
    field: Field,
}

pub(crate) fn save(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SaveParams = parse(params)?;
    let field = checked(engine.shared(), p.field)?;
    // Core refuses a name the scope already has (any case): the person's input, not a fault.
    let saved = engine.shared().app_db.with(|c| Ok(store::save(c, &field))).map_err(internal)?.map_err(RpcError::Invalid)?;
    Ok(json!({ "field": saved }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReorderParams {
    id: String,
    delta: i64,
}

pub(crate) fn reorder(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ReorderParams = parse(params)?;
    if p.delta != -1 && p.delta != 1 {
        return Err(invalid("delta is -1 or 1"));
    }
    let moved = engine.shared().app_db.with(|c| store::reorder(c, &p.id, p.delta)).map_err(internal)?;
    Ok(json!({ "moved": moved }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

pub(crate) fn delete(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: IdParams = parse(params)?;
    let dropped = engine.shared().app_db.with(|c| store::delete(c, &p.id)).map_err(internal)?;
    Ok(json!({ "droppedValues": dropped }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyParams {
    field_ids: Vec<String>,
    account_id: String,
}

pub(crate) fn copy(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: CopyParams = parse(params)?;
    if p.field_ids.len() > MAX_OPTIONS {
        return Err(invalid("too many fields"));
    }
    if !account_exists(engine.shared(), &p.account_id)? {
        return Err(invalid("unknown account"));
    }
    let copied = engine.shared().app_db.with(|c| store::copy_to_account(c, &p.field_ids, &p.account_id)).map_err(internal)?;
    Ok(json!({ "fields": copied }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageParams {
    field_id: String,
}

pub(crate) fn option_usage(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: UsageParams = parse(params)?;
    let usage = engine.shared().app_db.with(|c| store::option_usage(c, &p.field_id)).map_err(internal)?;
    Ok(json!({ "usage": usage }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValuesParams {
    items: Vec<Item>,
}

pub(crate) fn values(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ValuesParams = parse(params)?;
    if p.items.len() > MAX_ITEMS {
        return Err(invalid(format!("at most {MAX_ITEMS} items")));
    }
    let shared = engine.shared();
    let keys = keys_of(shared, &p.items)?;
    let mut per_account: HashMap<&str, Vec<String>> = HashMap::new();
    for t in keys.iter().flatten() {
        per_account.entry(t.account_id.as_str()).or_default().push(t.msg_key.clone());
    }
    let found = if per_account.is_empty() {
        HashMap::new()
    } else {
        shared
            .app_db
            .with(|c| {
                let mut out: HashMap<(String, String), HashMap<String, Value>> = HashMap::new();
                for (account, keys) in &per_account {
                    for (key, values) in store::values_for(c, account, keys)? {
                        out.insert((account.to_string(), key), values);
                    }
                }
                Ok(out)
            })
            .map_err(internal)?
    };
    let rows: Vec<Value> = keys
        .iter()
        .map(|t| {
            t.as_ref()
                .and_then(|t| found.get(&(t.account_id.clone(), t.msg_key.clone())))
                .map(|v| json!(v))
                .unwrap_or_else(|| Value::Object(Map::new()))
        })
        .collect();
    Ok(json!({ "values": rows }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    item: Item,
    field_id: String,
    /// Absent is refused; `null` clears (`Some(Value::Null)` once read through [`present`]).
    #[serde(default, deserialize_with = "present")]
    value: Option<Value>,
}

/// Tells a `value: null` (clear) from no `value` at all (refused).
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// `value` as the field stores it, `None` to clear; an answer that does not fit is `INVALID`.
pub(crate) fn value_for(field: &Field, value: &Value) -> Result<Option<Value>, String> {
    let known = |id: &str| field.options.iter().any(|o| o.id == id);
    match (field.kind.as_str(), value) {
        (_, Value::Null) => Ok(None),
        ("select", Value::String(s)) if s.is_empty() => Ok(None),
        ("select", Value::String(s)) if known(s) => Ok(Some(json!(s))),
        ("multi_select", Value::Array(list)) => {
            let mut ids: Vec<String> = Vec::new();
            for v in list {
                let id = v.as_str().filter(|id| known(id)).ok_or_else(|| "not a choice of this field".to_string())?;
                if !ids.iter().any(|known| known == id) {
                    ids.push(id.to_string());
                }
            }
            Ok((!ids.is_empty()).then(|| json!(ids)))
        }
        ("date", Value::String(s)) if s.is_empty() => Ok(None),
        ("date", Value::String(s)) if is_date(s) => Ok(Some(json!(s))),
        ("checkbox", Value::Bool(b)) => Ok(Some(json!(b))),
        ("text", Value::String(s)) => {
            let text = s.trim();
            if text.chars().count() > MAX_TEXT_CHARS {
                return Err(format!("a text value has at most {MAX_TEXT_CHARS} characters"));
            }
            Ok((!text.is_empty()).then(|| json!(text)))
        }
        _ => Err(format!("not a {} value", field.kind)),
    }
}

/// `YYYY-MM-DD` (what a date input gives and core compares as text).
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).filter(|d| d.bytes().all(|c| c.is_ascii_digit())).and_then(|d| d.parse::<u32>().ok());
    matches!((num(0..4), num(5..7), num(8..10)), (Some(_), Some(m), Some(d)) if (1..=12).contains(&m) && (1..=31).contains(&d))
}

pub(crate) fn set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SetParams = parse(params)?;
    let Some(raw) = p.value else {
        return Err(invalid("missing value (send null to clear)"));
    };
    let shared = engine.shared();
    let Some(target) = keys_of(shared, std::slice::from_ref(&p.item))?.pop().flatten() else {
        return Err(invalid("unknown message"));
    };
    let ok = shared
        .app_db
        .with(|c| {
            let Some(field) = store::get(c, &p.field_id)? else { return Ok(Err("unknown field".to_string())) };
            if field.scope != GLOBAL && field.scope != target.account_id {
                return Ok(Err("that field belongs to another account".to_string()));
            }
            let value = match value_for(&field, &raw) {
                Ok(v) => v,
                Err(why) => return Ok(Err(why)),
            };
            store::set_value(c, &target.account_id, &target.msg_key, &field.id, value.as_ref())?;
            Ok(Ok(()))
        })
        .map_err(internal)?;
    ok.map_err(RpcError::Invalid)?;
    Ok(json!({}))
}

/// Takes an account's values and own fields off (the account is leaving the phone). A failure is
/// logged: the account goes regardless.
pub(crate) fn forget_account(shared: &Shared, account_id: &str) {
    if let Err(e) = shared.app_db.with(|c| store::forget_account(c, account_id)) {
        shared.log(&format!("[fields] forgetting an account's fields: {e}"));
    }
}
